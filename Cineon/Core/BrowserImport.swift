import Foundation

// Imports from browsers already on this Mac. It reads each browser's files directly, always from a
// private copy, so it works while that browser is open. Only pages and bookmarks are read:
// passwords and cookies are left alone.

nonisolated struct ImportSource: Identifiable, Hashable, Sendable {
    var id: String { profileDirectory.path }
    let browser: String
    let profileName: String
    let profileDirectory: URL
    /// Arc keeps pinned tabs in its own files, above the Chromium profile folders.
    let arcDirectory: URL?
    let historyCount: Int
    let bookmarkCount: Int
    let pinnedCount: Int

    var label: String { profileName.isEmpty ? browser : "\(browser), \(profileName)" }
}

nonisolated struct BrowsedPage: Hashable, Sendable {
    enum Origin: Hashable, Sendable { case history, bookmark, pinned }

    var url: URL
    var title: String
    var visits: Int
    var lastVisit: Date
    var origin: Origin
}

nonisolated struct ImportSiteCandidate: Identifiable, Hashable, Sendable {
    var id: String { host }
    let host: String
    let homeURL: URL
    let filmPages: Int
}

nonisolated struct ImportVisit: Hashable, Sendable {
    let ref: EpisodeRef
    let url: URL
    let host: String
    let date: Date
}

nonisolated struct ImportTitleCandidate: Identifiable, Hashable, Sendable {
    var id: String { key }
    let key: String
    let name: String
    let altName: String?
    let year: Int?
    let kind: TitleKind
    /// The latest page for each episode, newest first. A film has just one.
    let visits: [ImportVisit]
    let suggestedStatus: TitleStatus

    var lastVisit: Date { visits.first?.date ?? .distantPast }
    var host: String { visits.first?.host ?? "" }
    var latestRef: EpisodeRef { visits.first?.ref ?? .none }
}

nonisolated struct ImportScan: Sendable {
    let sourceLabel: String
    let sites: [ImportSiteCandidate]
    let titles: [ImportTitleCandidate]
    /// Pages to make searchable, newest first and capped.
    let pages: [BrowsedPage]
    let totalPages: Int
}

// MARK: Reading browser files

nonisolated enum BrowserImporter {
    /// Keeps searching history instant in the command bar.
    static let pageLimit = 25_000

    private static let browsers: [(name: String, path: String)] = [
        ("Arc", "Arc/User Data"),
        ("Chrome", "Google/Chrome"),
        ("Brave", "BraveSoftware/Brave-Browser"),
        ("Edge", "Microsoft Edge"),
        ("Vivaldi", "Vivaldi"),
        ("Dia", "Dia/User Data"),
        ("Opera", "com.operasoftware.Opera"),
        ("Yandex", "Yandex/YandexBrowser"),
        ("Chromium", "Chromium"),
    ]

    static var applicationSupport: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    }

    /// Finds every browser profile that actually has something in it.
    static func discover(root: URL = applicationSupport) -> [ImportSource] {
        let files = FileManager.default
        var found: [ImportSource] = []
        for browser in browsers {
            let browserRoot = root.appendingPathComponent(browser.path, isDirectory: true)
            guard files.fileExists(atPath: browserRoot.path) else { continue }
            let isArc = browser.name == "Arc"
            let arcDirectory = isArc ? root.appendingPathComponent("Arc", isDirectory: true) : nil
            let names = profileNames(in: browserRoot)

            var profiles = ((try? files.contentsOfDirectory(at: browserRoot, includingPropertiesForKeys: nil)) ?? [])
                .filter { files.fileExists(atPath: $0.appendingPathComponent("History").path) }
                .filter { !["Guest Profile", "System Profile"].contains($0.lastPathComponent) }
            if files.fileExists(atPath: browserRoot.appendingPathComponent("History").path) {
                profiles.append(browserRoot)
            }

            for profile in profiles.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
                let history = countHistory(in: profile)
                let bookmarks = readBookmarks(in: profile).count
                // Arc's sidebar is shared, so it's counted against its main profile only.
                let isMainArcProfile = isArc && profile.lastPathComponent == "Default"
                let pinned = isMainArcProfile ? readArcTabs(in: arcDirectory).count : 0
                guard history + bookmarks + pinned > 0 else { continue }
                let name = names[profile.lastPathComponent] ?? ""
                found.append(ImportSource(
                    browser: browser.name,
                    profileName: name,
                    profileDirectory: profile,
                    arcDirectory: isMainArcProfile ? arcDirectory : nil,
                    historyCount: history,
                    bookmarkCount: bookmarks,
                    pinnedCount: pinned
                ))
            }
        }
        return found
    }

    static func scan(_ source: ImportSource) -> ImportScan {
        var pages = readHistory(in: source.profileDirectory)
        let visitsByURL = Dictionary(pages.map { ($0.url, $0) }, uniquingKeysWith: { first, _ in first })

        // A bookmark or pinned tab you also visited keeps its real date and visit count.
        var saved = readBookmarks(in: source.profileDirectory)
        saved += readArcTabs(in: source.arcDirectory)
        var seen = Set<URL>()
        for var page in saved where seen.insert(page.url).inserted {
            if let visited = visitsByURL[page.url] {
                page.visits = visited.visits
                page.lastVisit = visited.lastVisit
            }
            pages.append(page)
        }
        return ImportAnalyzer.analyze(pages, sourceLabel: source.label)
    }

    // MARK: Profiles

    private static func profileNames(in browserRoot: URL) -> [String: String] {
        guard let data = try? Data(contentsOf: browserRoot.appendingPathComponent("Local State")),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let profile = root["profile"] as? [String: Any],
              let cache = profile["info_cache"] as? [String: [String: Any]]
        else { return [:] }
        return cache.compactMapValues { $0["name"] as? String }
    }

    // MARK: History

    /// Browsers hold their history file open. Cloning it on APFS is instant and safe.
    private static func withCopiedHistory<T>(in profile: URL, _ body: (SQLiteDB) throws -> T) -> T? {
        let files = FileManager.default
        let folder = files.temporaryDirectory.appendingPathComponent("CineonImport-\(UUID().uuidString)", isDirectory: true)
        defer { try? files.removeItem(at: folder) }
        do {
            try files.createDirectory(at: folder, withIntermediateDirectories: true)
            for name in ["History", "History-wal", "History-shm"] {
                let source = profile.appendingPathComponent(name)
                if files.fileExists(atPath: source.path) {
                    try files.copyItem(at: source, to: folder.appendingPathComponent(name))
                }
            }
            let db = try SQLiteDB(path: folder.appendingPathComponent("History").path)
            defer { db.close() }
            return try body(db)
        } catch {
            return nil
        }
    }

    private static func countHistory(in profile: URL) -> Int {
        withCopiedHistory(in: profile) { db in
            try db.query("SELECT count(*) FROM urls WHERE hidden=0") { $0.intValue(0) }.first ?? 0
        } ?? 0
    }

    static func readHistory(in profile: URL) -> [BrowsedPage] {
        withCopiedHistory(in: profile) { db in
            try db.query(
                "SELECT url,title,visit_count,last_visit_time FROM urls WHERE hidden=0 ORDER BY last_visit_time DESC LIMIT 200000"
            ) { row -> BrowsedPage? in
                guard let url = URL(string: row.text(0)), url.host != nil else { return nil }
                return BrowsedPage(
                    url: url, title: row.text(1), visits: row.intValue(2), lastVisit: chromiumDate(row.int(3)), origin: .history
                )
            }.compactMap { $0 }
        } ?? []
    }

    /// Chromium counts microseconds since 1601.
    static func chromiumDate(_ microseconds: Int64) -> Date {
        Date(timeIntervalSince1970: Double(microseconds) / 1_000_000 - 11_644_473_600)
    }

    // MARK: Bookmarks

    static func readBookmarks(in profile: URL) -> [BrowsedPage] {
        guard let data = try? Data(contentsOf: profile.appendingPathComponent("Bookmarks")),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let roots = root["roots"] as? [String: Any]
        else { return [] }
        var pages: [BrowsedPage] = []
        func walk(_ node: [String: Any]) {
            if node["type"] as? String == "url", let raw = node["url"] as? String, let url = URL(string: raw), url.host != nil {
                let added = (node["date_added"] as? String).flatMap(Int64.init).map(chromiumDate) ?? .distantPast
                pages.append(BrowsedPage(url: url, title: node["name"] as? String ?? "", visits: 0, lastVisit: added, origin: .bookmark))
            }
            for child in node["children"] as? [[String: Any]] ?? [] { walk(child) }
        }
        for case let node as [String: Any] in roots.values { walk(node) }
        return pages
    }

    // MARK: Arc

    /// Pinned and archived tabs. Arc changes these files often, so rather than relying on their
    /// exact layout, this looks for anything anywhere in them that holds a saved address.
    static func readArcTabs(in directory: URL?) -> [BrowsedPage] {
        guard let directory else { return [] }
        var pages: [BrowsedPage] = []
        var seen = Set<URL>()
        for name in ["StorableSidebar.json", "StorableArchiveItems.json"] {
            let file = directory.appendingPathComponent(name)
            guard let data = try? Data(contentsOf: file),
                  let root = try? JSONSerialization.jsonObject(with: data)
            else { continue }
            func walk(_ value: Any) {
                if let dict = value as? [String: Any] {
                    if let raw = dict["savedURL"] as? String, let url = URL(string: raw), url.host != nil, seen.insert(url).inserted {
                        pages.append(BrowsedPage(
                            url: url, title: dict["savedTitle"] as? String ?? "", visits: 0, lastVisit: .distantPast, origin: .pinned
                        ))
                    }
                    for child in dict.values { walk(child) }
                } else if let list = value as? [Any] {
                    for child in list { walk(child) }
                }
            }
            walk(root)
        }
        return pages
    }
}

// MARK: Finding films in a pile of pages

/// Decides which pages were films. History says nothing about that directly, so this weighs several
/// signals and leaves the final say to the review screen, where every result has a checkbox.
nonisolated enum ImportAnalyzer {
    private static let maxTitles = 600
    /// A series opened this recently is probably still being watched.
    private static let stillWatchingWindow: TimeInterval = 60 * 24 * 3600

    /// Sites that discuss or rate films, or that have nothing to do with them.
    private static let excludedDomains: Set<String> = [
        "google.com", "google.com.ua", "googleusercontent.com", "youtube.com", "youtu.be", "github.com", "gitlab.com",
        "stackoverflow.com", "reddit.com", "facebook.com", "instagram.com", "x.com", "twitter.com", "tiktok.com",
        "linkedin.com", "apple.com", "icloud.com", "microsoft.com", "amazon.com", "wikipedia.org", "imdb.com",
        "letterboxd.com", "rottentomatoes.com", "themoviedb.org", "kinopoisk.ru", "metacritic.com", "duckduckgo.com",
        "bing.com", "yandex.ru", "yandex.ua", "chatgpt.com", "claude.ai", "openai.com", "anthropic.com", "figma.com",
        "notion.so", "vercel.com", "cloudflare.com", "supabase.com", "telegram.org", "whatsapp.com", "slack.com",
        "discord.com", "zoom.us", "medium.com", "pinterest.com", "spotify.com", "soundcloud.com", "twitch.tv", "vk.com",
        "ok.ru", "dou.ua", "npmjs.com", "gmail.com", "notebooklm.google", "behance.net", "dribbble.com", "linear.app",
        "iamidiotareyoutoo.com", "clerk.com", "convex.dev", "render.com", "temu.com", "aliexpress.com", "rozetka.com.ua", "prom.ua", "olx.ua", "ebay.com", "chess.com", "savefrom.net", "pollo.ai",
    ]

    /// Adult and music sites. Adult sites stay out however film-like their pages look, because a
    /// library may be seen by the whole family.
    private static let excludedHostWords = #"(?i)(porn|xvideos|xhamster|xnxx|redtube|youporn|brazzers|onlyfans|chaturbate|mp3|muz|music|lyrics|song)"#

    private static let genericNames: Set<String> = [
        "home", "movies", "movie", "series", "films", "film", "shows", "tv", "watch", "search", "results", "login", "signin",
        "signup", "register", "error", "notfound", "404", "403", "главная", "головна", "новинки", "фильмы", "фільми",
        "сериалы", "серіали", "мультфильмы", "мультфільми", "каталог", "поиск", "пошук", "kino", "кино", "кіно", "online",
        "онлайн", "player", "video", "untitled", "newtab", "loading", "justamoment", "attentionrequired",
        "safetywarning", "warning", "anime", "аниме", "аніме", "fullvideo",
    ]

    /// Page names that are about the site rather than a film.
    private static let sitePageNames = #"(?i)^(лучшие|кращі|новинки|топ|best|top|popular|регистрац|реєстрац|registration|sign |log ?in|privacy error|доступ обмежено|access denied|не найдено|сериалы|серіали|фильмы|фільми|мультфильмы|мультфільми|аниме|аніме)|(homepage|website|сайт|онлайн|online)\s*$|\s,\s"#
    private static let notWatchable = #"(?i)(трейлер|тизер|trailer|teaser)"#
    private static let comingSoon = #"(?i)((?<!\p{L})скоро(?!\p{L})|coming soon|незабаром)"#

    private static let strongTitle = #"(?i)(watch\s.*(online|free)|full movie|free movie|online free|stream\s.*online|дивит(ися|ись)|смотреть|онлайн безкоштовно|онлайн бесплатно|у хорошій якості|в хорошій якості|в хорошем качестве)"#
    private static let filmPath = #"(?i)/(watch|movie|movies|film|films|filmy|filmi|kino|serial|serials|serialy|series|tv|tvshows?|tv-shows?|shows?|episodes?|season|anime|cartoons?|multfilm|multfilmy|mult|multiki|online|dubbed|subbed|player|embed)(/|-|\.|$)"#
    private static let listingPath = #"(?i)(/(search|genre|genres|category|categories|tag|tags|page|top|best|new|novinki|popular|trending|year|years|country|countries|actor|actors|person|people|login|signin|signup|register|user|users|profile|account|news|blog|collections?|about|contact|faq|help|settings|xfsearch)(/|$))|([?&](q|s|query|search|keyword|story)=)"#
    private static let filmHostWord = #"(?i)(kino|film|movie|cinema|serial|flix|rezka|anime|aniwatch|mult|gidonline|megogo|sweet\.tv|netflix|disney|primevideo|hbo|takflix|kyivstar)"#

    private static func matches(_ text: String, _ pattern: String) -> Bool {
        text.range(of: pattern, options: .regularExpression) != nil
    }

    /// 3 or more means a film page on its own merits. 2 means only if the site is a film site.
    static func signal(url: URL, title: String) -> Int {
        let path = url.path
        guard path.count > 1, !matches(path + "?" + (url.query ?? ""), listingPath), !matches(title, notWatchable) else { return 0 }
        var score = 0
        if matches(title, strongTitle) { score += 3 }
        // Random ids in addresses can look like S01E02, so an address only counts on a film path.
        let address = url.absoluteString.removingPercentEncoding ?? url.absoluteString
        if TitleParser.episodeRef(in: title) != nil || (matches(path, filmPath) && TitleParser.episodeRef(in: address) != nil) {
            score += 3
        }
        if matches(path, filmPath) { score += 2 }
        if let host = url.host, matches(host, filmHostWord) { score += 1 }
        return score
    }

    private static func isUsableName(_ name: String) -> Bool {
        let key = TitleParser.normalize(name)
        guard key.count >= 2, name.count <= 80, !genericNames.contains(key), !matches(name, sitePageNames) else { return false }
        return name.split(separator: " ").count <= 12 && !name.contains("http")
    }

    static func analyze(_ pages: [BrowsedPage], sourceLabel: String, now: Date = .now) -> ImportScan {
        var excludedCache: [String: Bool] = [:]
        func isExcluded(_ host: String) -> Bool {
            if let cached = excludedCache[host] { return cached }
            let result = excludedDomains.contains(DomainName.registrable(host)) || matches(host, excludedHostWords)
            excludedCache[host] = result
            return result
        }

        // First pass: score pages, and see which sites have clearly film pages on them.
        var scored: [(page: BrowsedPage, score: Int)] = []
        var strongPagesByDomain: [String: Int] = [:]
        for page in pages {
            guard let host = page.url.host?.lowercased(), !isExcluded(host) else { continue }
            let score = signal(url: page.url, title: page.title)
            guard score >= 2 else { continue }
            scored.append((page, score))
            if score >= 3 { strongPagesByDomain[DomainName.registrable(host), default: 0] += 1 }
        }

        // Second pass: a page counts if its site is plainly about films, or has proved itself with
        // several clear film pages. One film-looking page on a shop or a game site proves nothing.
        var filmPagesByDomain: [String: Int] = [:]
        var sampleURL: [String: URL] = [:]
        var latestByDomain: [String: Date] = [:]
        struct Group {
            var name: String
            var altName: String?
            var year: Int?
            var kind: TitleKind
            var latest: Date
            var totalVisits: Int
            var onlySaved: Bool
            var onlyComingSoon: Bool
            var byRef: [EpisodeRef: ImportVisit]
        }
        var groups: [String: Group] = [:]

        for (page, score) in scored {
            guard let rawHost = page.url.host?.lowercased() else { continue }
            let domain = DomainName.registrable(rawHost)
            let provenSite = strongPagesByDomain[domain, default: 0] >= 3
            guard provenSite || (score >= 3 && matches(rawHost, filmHostWord)) else { continue }

            var meta = PageMeta()
            meta.url = page.url.absoluteString
            meta.title = page.title
            guard let parsed = TitleParser.parse(meta), parsed.confidence >= 0.5, isUsableName(parsed.name),
                  TitleParser.normalize(parsed.name) != TitleParser.normalize(DomainName.displayName(rawHost))
            else { continue }

            filmPagesByDomain[domain, default: 0] += 1
            if page.lastVisit >= latestByDomain[domain, default: .distantPast] {
                latestByDomain[domain] = page.lastVisit
                sampleURL[domain] = page.url
            }

            let host = rawHost.hasPrefix("www.") ? String(rawHost.dropFirst(4)) : rawHost
            let visit = ImportVisit(ref: parsed.ref, url: page.url, host: host, date: page.lastVisit)
            let key = TitleParser.normalize(parsed.altName ?? parsed.name)

            var group = groups[key] ?? Group(
                name: parsed.name, altName: parsed.altName, year: parsed.year, kind: parsed.kindHint,
                latest: page.lastVisit, totalVisits: 0, onlySaved: true, onlyComingSoon: true, byRef: [:]
            )
            group.totalVisits += page.visits
            if page.origin == .history { group.onlySaved = false }
            if !matches(page.title, comingSoon) { group.onlyComingSoon = false }
            if page.lastVisit > group.latest {
                group.latest = page.lastVisit
                group.name = parsed.name
                group.altName = parsed.altName ?? group.altName
            }
            group.year = group.year ?? parsed.year
            if parsed.kindHint == .cartoon || (parsed.kindHint == .series && group.kind != .cartoon) || group.kind == .unknown {
                group.kind = parsed.kindHint
            }
            if let existing = group.byRef[parsed.ref] {
                if page.lastVisit > existing.date { group.byRef[parsed.ref] = visit }
            } else {
                group.byRef[parsed.ref] = visit
            }
            groups[key] = group
        }

        let titles = groups.map { key, group -> ImportTitleCandidate in
            var visits = group.byRef.values.sorted { $0.date > $1.date }
            // Opening a series' main page says little once there are real episodes to go on.
            if visits.contains(where: { $0.ref.isEpisode }) { visits.removeAll { !$0.ref.isEpisode } }
            let isSeries = group.kind == .series || visits.contains { $0.ref.isEpisode }
            let status: TitleStatus
            if (group.onlySaved && group.totalVisits <= 1) || group.onlyComingSoon {
                // Saved but never really opened, or not out yet: something to watch later.
                status = .backlog
            } else if isSeries && now.timeIntervalSince(group.latest) < stillWatchingWindow {
                status = .watching
            } else {
                status = .watched
            }
            return ImportTitleCandidate(
                key: key, name: group.name, altName: group.altName, year: group.year,
                kind: isSeries && group.kind != .cartoon ? .series : group.kind, visits: visits, suggestedStatus: status
            )
        }
        .sorted { $0.lastVisit > $1.lastVisit }
        .prefix(maxTitles)

        // Sites: anywhere with at least two film pages, plus saved film sites you visit by name.
        // Streaming sites live on many mirrors, so these count as one site at its newest address.
        var sites: [ImportSiteCandidate] = []
        let mirrors = Dictionary(grouping: filmPagesByDomain.keys, by: brand)
        for domains in mirrors.values {
            let total = domains.reduce(0) { $0 + filmPagesByDomain[$1, default: 0] }
            guard total >= 2,
                  let newest = domains.max(by: { latestByDomain[$0, default: .distantPast] < latestByDomain[$1, default: .distantPast] }),
                  let sample = sampleURL[newest], let site = siteCandidate(from: sample, filmPages: total)
            else { continue }
            sites.append(site)
        }
        for page in pages where page.origin != .history {
            guard let host = page.url.host?.lowercased(), !isExcluded(host), matches(host, filmHostWord),
                  !sites.contains(where: { brand(DomainName.registrable($0.host)) == brand(DomainName.registrable(host)) }),
                  let site = siteCandidate(from: page.url, filmPages: filmPagesByDomain[DomainName.registrable(host)] ?? 0)
            else { continue }
            sites.append(site)
        }
        sites.sort { $0.filmPages > $1.filmPages }

        let history = pages.filter { $0.origin == .history }
        return ImportScan(
            sourceLabel: sourceLabel,
            sites: Array(sites.prefix(40)),
            titles: Array(titles),
            pages: Array(history.sorted { $0.lastVisit > $1.lastVisit }.prefix(BrowserImporter.pageLimit)),
            totalPages: history.count
        )
    }

    /// What mirrors of one site share: hdrezka.ag, rezka-ua.co and rezka-tv.org are all "rezka".
    static func brand(_ domain: String) -> String {
        var name = domain.split(separator: ".").first.map(String.init) ?? domain
        name = name.split(separator: "-").first.map(String.init) ?? name
        if name.hasPrefix("hd"), name.count > 4 { name.removeFirst(2) }
        let letters = name.filter { !$0.isNumber }
        return letters.isEmpty ? name : letters
    }

    private static func siteCandidate(from url: URL, filmPages: Int) -> ImportSiteCandidate? {
        guard let rawHost = url.host?.lowercased() else { return nil }
        let host = rawHost.hasPrefix("www.") ? String(rawHost.dropFirst(4)) : rawHost
        var parts = URLComponents()
        parts.scheme = url.scheme == "http" ? "http" : "https"
        parts.host = rawHost
        parts.port = url.port
        parts.path = "/"
        guard let home = parts.url else { return nil }
        return ImportSiteCandidate(host: host, homeURL: home, filmPages: filmPages)
    }
}

// MARK: Saving

struct ImportSelection {
    var sites: [ImportSiteCandidate]
    var titles: [(candidate: ImportTitleCandidate, status: TitleStatus)]
    var pages: [BrowsedPage]
}

struct ImportResult {
    var sites = 0
    var titles = 0
    var pages = 0
    var newTitleIDs: [(id: Int64, altName: String?)] = []

    var summary: String {
        var parts: [String] = []
        if sites > 0 { parts.append("\(sites) \(sites == 1 ? "site" : "sites")") }
        if titles > 0 { parts.append("\(titles) \(titles == 1 ? "film or series" : "films and series")") }
        if pages > 0 { parts.append("\(pages.formatted()) pages") }
        return parts.isEmpty ? "Nothing new to import." : "Imported " + parts.joined(separator: ", ") + "."
    }
}

extension LibraryStore {
    /// Writes everything in one transaction. Importing the same browser twice adds nothing new,
    /// and never overwrites a real saved position with a page visit.
    func applyImport(_ selection: ImportSelection) -> ImportResult {
        var result = ImportResult()

        for candidate in selection.sites where site(forHost: candidate.host) == nil {
            if addSite(url: candidate.homeURL) != nil { result.sites += 1 }
        }

        try? db.sql.transaction {
            for (candidate, status) in selection.titles {
                var existing = find(name: candidate.name, altName: candidate.altName, year: candidate.year)
                if existing == nil {
                    // The catalogue may have renamed it since ("Дюна" is now "Dune"), so the page's
                    // address is the better way to recognise something imported before.
                    for visit in candidate.visits {
                        if let known = try db.progress(urlKey: URLKey.make(visit.url)), let title = titles[known.titleID] {
                            existing = title
                            break
                        }
                    }
                }
                let id: Int64
                if let existing {
                    id = existing.id
                } else {
                    let date = candidate.lastVisit == .distantPast ? Date.now : candidate.lastVisit
                    let title = Title(
                        id: 0, name: candidate.name, normName: TitleParser.normalize(candidate.name), year: candidate.year,
                        kind: candidate.kind, status: status, imdbID: nil, posterURL: nil, backdropURL: nil, overview: nil,
                        genres: [], runtimeMinutes: nil, ratingHalves: nil, notes: nil, addedAt: date, updatedAt: date,
                        finishedAt: status == .watched ? date : nil,
                        lastWatchedAt: status == .backlog ? nil : date,
                        metadataChecked: false
                    )
                    id = try db.insertTitle(title)
                    result.newTitleIDs.append((id, candidate.altName))
                    result.titles += 1
                }
                for visit in candidate.visits {
                    try record(visit, titleID: id, status: status)
                }
            }
            for page in selection.pages {
                if try db.importHistory(page) { result.pages += 1 }
            }
        }
        reload()
        return result
    }

    private func record(_ visit: ImportVisit, titleID: Int64, status: TitleStatus) throws {
        // A backlog entry was never watched, so it has no place on the timeline.
        // Nor does a tab with no known date, which would sort oddly.
        if status != .backlog, visit.date != .distantPast,
           !(try db.hasSession(titleID: titleID, ref: visit.ref, startedAt: visit.date)) {
            _ = try db.insertSession(WatchSession(
                id: 0, titleID: titleID, ref: visit.ref, episodeName: nil, url: visit.url, host: visit.host,
                startedAt: visit.date, endedAt: visit.date, watchedSeconds: 0, startPosition: 0, endPosition: 0,
                duration: 0, finished: false
            ))
        }
        if try db.progress(titleID: titleID, ref: visit.ref) == nil {
            try db.upsertProgress(WatchProgress(
                titleID: titleID, ref: visit.ref, urlKey: URLKey.make(visit.url), url: visit.url, host: visit.host,
                position: 0, duration: 0, finished: false, updatedAt: visit.date == .distantPast ? .now : visit.date
            ))
        }
    }
}

extension Database {
    /// Returns true if the page wasn't already there. Seeks on the time index, so it stays fast.
    func importHistory(_ page: BrowsedPage) throws -> Bool {
        let url = page.url.absoluteString
        let exists = try !sql.query(
            "SELECT 1 FROM history WHERE visited_at=? AND url=? LIMIT 1", [.date(page.lastVisit), .text(url)]
        ) { _ in true }.isEmpty
        if exists { return false }
        try sql.run(
            "INSERT INTO history(url,host,title,visited_at) VALUES(?,?,?,?)",
            [.text(url), .text(page.url.host ?? ""), .text(page.title), .date(page.lastVisit)]
        )
        return true
    }

    func hasSession(titleID: Int64, ref: EpisodeRef, startedAt: Date) throws -> Bool {
        try !sql.query(
            "SELECT 1 FROM sessions WHERE title_id=? AND season=? AND episode=? AND started_at=? LIMIT 1",
            [.int(titleID), .int(Int64(ref.season)), .int(Int64(ref.episode)), .date(startedAt)]
        ) { _ in true }.isEmpty
    }
}

extension WatchProgress {
    /// From an imported history: we know the page was opened, not how far you got.
    var isVisitOnly: Bool { duration == 0 }
}

extension WatchSession {
    var isVisitOnly: Bool { duration == 0 }
}
