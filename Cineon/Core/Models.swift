import Foundation

nonisolated enum TitleKind: String, Codable, CaseIterable, Sendable {
    case film, series, cartoon, unknown

    var label: String {
        switch self {
        case .film: "Film"
        case .series: "Series"
        case .cartoon: "Cartoon"
        case .unknown: "Unsorted"
        }
    }
}

nonisolated enum TitleStatus: String, Codable, CaseIterable, Sendable {
    case none, backlog, watching, watched

    var label: String {
        switch self {
        case .none: "Not in a list"
        case .backlog: "Backlog"
        case .watching: "Watching"
        case .watched: "Watched"
        }
    }
}

nonisolated struct Title: Identifiable, Hashable, Sendable {
    var id: Int64
    var name: String
    var normName: String
    var year: Int?
    var kind: TitleKind
    var status: TitleStatus
    var imdbID: String?
    var posterURL: URL?
    var backdropURL: URL?
    var overview: String?
    var genres: [String]
    var runtimeMinutes: Int?
    /// Out of ten in half steps, kept doubled: 15 is 7.5. nil is not rated.
    var ratingHalves: Int?
    var notes: String?
    var addedAt: Date
    var updatedAt: Date
    var finishedAt: Date?
    var lastWatchedAt: Date?
    var metadataChecked: Bool
    var ratedAt: Date? = nil
    var statusAt: Date? = nil

    /// Out of ten, such as 7.5.
    var rating: Double? { ratingHalves.map { Double($0) / 2 } }
}

/// A series' newest aired episode as last checked, and what came out since.
nonisolated struct EpisodeAlert: Hashable, Sendable {
    var titleID: Int64
    var latest: EpisodeRef
    var checkedAt: Date
    var newest: EpisodeRef?
    var newCount: Int
    var newAt: Date?
}

/// Ratings out of ten, in half stars.
nonisolated enum Rating {
    static let maxHalves = 20

    /// "7.5", "8", "10".
    static func text(_ halves: Int) -> String {
        halves % 2 == 0 ? "\(halves / 2)" : "\(halves / 2).5"
    }

    static func clamp(_ halves: Int) -> Int { min(maxHalves, max(1, halves)) }
}

nonisolated struct EpisodeRef: Hashable, Codable, Sendable {
    var season: Int
    var episode: Int

    /// Films are stored as season 0, episode 0.
    static let none = EpisodeRef(season: 0, episode: 0)
    var isEpisode: Bool { season > 0 || episode > 0 }
}

nonisolated struct WatchProgress: Hashable, Sendable {
    var titleID: Int64
    var ref: EpisodeRef
    var urlKey: String
    var url: URL?
    var host: String
    var position: Double
    var duration: Double
    var finished: Bool
    var updatedAt: Date

    var fraction: Double { duration > 0 ? min(1, position / duration) : 0 }
    var remaining: Double { max(0, duration - position) }
}

nonisolated struct WatchSession: Identifiable, Hashable, Sendable {
    var id: Int64
    var titleID: Int64
    var ref: EpisodeRef
    var episodeName: String?
    var url: URL?
    var host: String
    var startedAt: Date
    var endedAt: Date
    var watchedSeconds: Double
    var startPosition: Double
    var endPosition: Double
    var duration: Double
    var finished: Bool
}

/// Something to jump over in every episode of a series, learned from watching you do it.
nonisolated struct SkipRule: Identifiable, Hashable, Sendable {
    enum Kind: String, Sendable { case intro, credits }

    var id: Int64
    var titleID: Int64
    /// The site's brand, so that mirrors of one site share their rules.
    var site: String
    var kind: Kind
    /// Intro: where it starts. Credits: how many seconds before the end they begin.
    var start: Double
    /// Intro: where it ends. Credits: unused.
    var end: Double
    /// How many times this was seen. Credits only roll on by themselves once two agree.
    var sightings: Int
    /// How many times it was undone. Two, and the rule is dropped.
    var misses: Int
    var updatedAt: Date
}

/// One real frame from something you watched, saved as a small image on this Mac.
nonisolated struct FilmFrame: Identifiable, Hashable, Sendable {
    var id: Int64
    var sessionID: Int64?
    var titleID: Int64
    var ref: EpisodeRef
    var position: Double
    var url: URL?
    /// Relative to the profile's Frames folder.
    var file: String
    /// Saved on purpose, rather than collected along the way.
    var isMoment: Bool
    /// Higher for frames with more going on, so the best one can represent a session.
    var interest: Double
    var at: Date
}

/// A file a player asked for, as it would show in the Network tab.
nonisolated struct MediaSource: Hashable, Sendable {
    enum Kind: String, Sendable { case file, hls, subtitle }

    var url: URL
    var kind: Kind
    /// Milliseconds since 1970, when the page first asked for it.
    var foundAt: Double
    /// Asked for since the video now in the player started loading.
    var isCurrent: Bool

    /// "1080p" from addresses like `.../1080.mp4` or `..._720p.mp4`.
    var quality: String? { Self.quality(in: url.absoluteString) }

    static func quality(in text: String) -> String? {
        let patterns = [#"(\d{3,4})p(?:[^a-z0-9]|$)"#, #"[/_-](240|360|480|720|1080|1440|2160)\.(?:mp4|m3u8)"#]
        for pattern in patterns {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive),
                  let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
                  let range = Range(match.range(at: 1), in: text)
            else { continue }
            return "\(text[range])p"
        }
        return nil
    }

    var qualityRank: Int { quality.flatMap { Int($0.dropLast()) } ?? 0 }

    /// Which of the files a player asked for is the film: the one it's playing if that's a plain
    /// file, otherwise the best quality among those it asked for since loading it, a whole file
    /// before a playlist.
    static func best(of sources: [MediaSource], playing: String?) -> MediaSource? {
        let videos = sources.filter { $0.kind != .subtitle }
        if let playing, let exact = videos.first(where: { $0.kind == .file && $0.url.absoluteString == playing }) {
            return exact
        }
        let current = videos.filter(\.isCurrent)
        let pool = current.isEmpty ? videos : current
        return pool.max { a, b in
            if (a.kind == .file) != (b.kind == .file) { return b.kind == .file }
            if a.qualityRank != b.qualityRank { return a.qualityRank < b.qualityRank }
            // Of two playlists, the first asked for is the master. Of two files, the latest.
            return a.kind == .hls ? a.foundAt > b.foundAt : a.foundAt < b.foundAt
        }
    }
}

/// What voice boost is doing in one player.
nonisolated enum VoiceBoostState: String, Sendable {
    case off, on, unsupported, waiting

    var note: String? {
        switch self {
        case .off, .on: nil
        case .unsupported: "This player won't let Cineon change its sound"
        case .waiting: "Click the video once to turn it on"
        }
    }
}

nonisolated enum DownloadStatus: String, Sendable {
    case queued, downloading, failed, done

    var isActive: Bool { self == .queued || self == .downloading }
}

/// A film or episode saved to this Mac.
nonisolated struct DownloadItem: Identifiable, Hashable, Sendable {
    var id: Int64
    var titleID: Int64?
    var ref: EpisodeRef
    var name: String
    var sourceURL: URL
    var pageURL: URL?
    var referer: String?
    var host: String
    var kind: MediaSource.Kind
    var quality: String?
    /// Absolute path, once the file exists.
    var file: String?
    var subtitles: [String]
    var bytes: Int64
    var totalBytes: Int64
    var status: DownloadStatus
    var error: String?
    var position: Double
    var duration: Double
    var posterURL: URL?
    var createdAt: Date
    var finishedAt: Date?
    var playedAt: Date?

    var fileURL: URL? { file.map { URL(fileURLWithPath: $0) } }
    var fraction: Double { totalBytes > 0 ? min(1, Double(bytes) / Double(totalBytes)) : 0 }
    var watchedFraction: Double { duration > 0 ? min(1, position / duration) : 0 }

    var episodeBadge: String? {
        guard ref.isEpisode else { return nil }
        return String(format: "S%02dE%02d", ref.season, ref.episode)
    }

    /// `Severance S01E02 [1080p]` or `Dune Part Two [1080p]`, safe for any file system.
    var fileBaseName: String {
        var base = name
        if let badge = episodeBadge { base += " \(badge)" }
        if let quality { base += " [\(quality)]" }
        let banned = CharacterSet(charactersIn: "/\\:?%*|\"<>\n\r\t")
        let cleaned = base.components(separatedBy: banned).joined(separator: " ")
            .replacingOccurrences(of: "  ", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return String((cleaned.isEmpty ? "Video" : cleaned).prefix(120))
    }
}

nonisolated enum CaptionStyle: String, Codable, CaseIterable, Sendable {
    case site, large, huge

    var label: String {
        switch self {
        case .site: "As the site sets them"
        case .large: "Large, on a dark band"
        case .huge: "Very large, on a dark band"
        }
    }

    /// Applied to the browser's own text tracks. Players that draw their own captions keep theirs.
    var css: String? {
        switch self {
        case .site: nil
        case .large: Self.band(scale: 135)
        case .huge: Self.band(scale: 175)
        }
    }

    /// Points, for captions the native player draws.
    var nativeSize: Double {
        switch self {
        case .site: 26
        case .large: 32
        case .huge: 42
        }
    }

    private static func band(scale: Int) -> String {
        "font-size: \(scale)% !important; line-height: 1.25 !important; color: #fff !important; "
            + "background: rgba(0,0,0,.72) !important; font-family: -apple-system, 'SF Pro Text', sans-serif !important;"
    }
}

nonisolated enum LibraryEventKind: String, Sendable {
    case addedToBacklog, markedWatched, markedWatching, removed

    var label: String {
        switch self {
        case .addedToBacklog: "Added to backlog"
        case .markedWatched: "Marked as watched"
        case .markedWatching: "Moved to watching"
        case .removed: "Removed from lists"
        }
    }
}

nonisolated struct LibraryEvent: Identifiable, Hashable, Sendable {
    var id: Int64
    var kind: LibraryEventKind
    var titleID: Int64
    var at: Date
}

nonisolated struct Site: Identifiable, Hashable, Sendable {
    var id: Int64
    var name: String
    var host: String
    var homeURL: URL
    var searchTemplate: String?
    var iconURL: URL?
    var position: Int
    var addedAt: Date
    var lastUsedAt: Date?

    func searchURL(for query: String) -> URL? {
        guard let searchTemplate,
              let encoded = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)?
                .replacingOccurrences(of: "&", with: "%26")
                .replacingOccurrences(of: "+", with: "%2B")
        else { return nil }
        return URL(string: searchTemplate.replacingOccurrences(of: "%s", with: encoded))
    }
}

nonisolated struct HistoryEntry: Identifiable, Hashable, Sendable {
    var id: Int64
    var url: URL
    var host: String
    var title: String
    var visitedAt: Date
}

nonisolated struct PersistedTab: Sendable {
    var id: UUID
    var url: URL?
    var title: String
    var faviconURL: URL?
    var position: Int
    var isActive: Bool
    var state: Data?
    var isPinnedToSearch: Bool
}

nonisolated struct SitePrefs: Hashable, Sendable {
    var host: String
    var shieldsOff = false
    var allowPopups = false
    var allowRedirects = false
    /// For sites that aren't about films, like YouTube: nothing here goes on the timeline.
    var trackingOff = false
}

nonisolated struct ShieldStats: Hashable, Sendable {
    var ads = 0
    var popups = 0
    var redirects = 0
    var overlays = 0

    var total: Int { ads + popups + redirects + overlays }
}

nonisolated enum AppTheme: String, Codable, CaseIterable, Sendable {
    case dark, white

    var label: String { self == .dark ? "Dark" : "White" }
}

/// Stored per profile, so each family member keeps their own preferences.
nonisolated struct AppSettings: Codable, Hashable, Sendable {
    var theme: AppTheme = .dark
    var ambientLight = true
    var ambientStrength = 0.55
    var launchAnimation = true
    var sidebarWidth = 252.0
    var sidebarHidden = false

    var autoResume = true
    var finishThreshold = 0.92
    var minimumSecondsToTrack = 15.0
    var hibernateMinutes = 20.0
    var pauseOtherTabs = true
    var autoRescue = true
    var learnSkips = true
    var autoNextEpisode = true
    var keepFrames = true

    var networkBlocking = true
    var popupShield = true
    var redirectShield = true
    var overlaySweeper = true
    var downloadShield = true
    var enabledLists: Set<String> = ["easylist", "easyprivacy", "ublock", "peterlowe", "cineon-streaming"]

    var fetchMetadata = true
    var saveBrowsingHistory = true
    var searchEngine = SearchEngine.duckDuckGo

    var showDownloadButton = true
    /// Empty means the default, a Cineon folder in Movies.
    var downloadsFolder = ""
    var captionStyle = CaptionStyle.site

    /// Dialogue louder, explosions softer, in players whose sound the page may process.
    var voiceBoost = false
    /// Downloaded episodes go to the Bin once watched to the end.
    var binWatchedDownloads = true
    /// The native player moves on to the next downloaded episode.
    var playNextDownload = true
    /// A notification when a series you're watching gets a new episode.
    var newEpisodeAlerts = true
    /// Your pixel pet is your avatar in parties and challenges.
    var sharePet = true
    /// Ratings and lists are kept in the cloud too, so they survive starting over.
    var cloudBackup = true

    init() {}

    init(from decoder: any Decoder) throws {
        // Every field falls back to its default, so adding a setting never loses the others.
        self.init()
        let c = try decoder.container(keyedBy: CodingKeys.self)
        theme = (try? c.decode(AppTheme.self, forKey: .theme)) ?? theme
        ambientLight = (try? c.decode(Bool.self, forKey: .ambientLight)) ?? ambientLight
        ambientStrength = (try? c.decode(Double.self, forKey: .ambientStrength)) ?? ambientStrength
        launchAnimation = (try? c.decode(Bool.self, forKey: .launchAnimation)) ?? launchAnimation
        sidebarWidth = (try? c.decode(Double.self, forKey: .sidebarWidth)) ?? sidebarWidth
        sidebarHidden = (try? c.decode(Bool.self, forKey: .sidebarHidden)) ?? sidebarHidden
        autoResume = (try? c.decode(Bool.self, forKey: .autoResume)) ?? autoResume
        finishThreshold = (try? c.decode(Double.self, forKey: .finishThreshold)) ?? finishThreshold
        minimumSecondsToTrack = (try? c.decode(Double.self, forKey: .minimumSecondsToTrack)) ?? minimumSecondsToTrack
        hibernateMinutes = (try? c.decode(Double.self, forKey: .hibernateMinutes)) ?? hibernateMinutes
        pauseOtherTabs = (try? c.decode(Bool.self, forKey: .pauseOtherTabs)) ?? pauseOtherTabs
        autoRescue = (try? c.decode(Bool.self, forKey: .autoRescue)) ?? autoRescue
        learnSkips = (try? c.decode(Bool.self, forKey: .learnSkips)) ?? learnSkips
        autoNextEpisode = (try? c.decode(Bool.self, forKey: .autoNextEpisode)) ?? autoNextEpisode
        keepFrames = (try? c.decode(Bool.self, forKey: .keepFrames)) ?? keepFrames
        networkBlocking = (try? c.decode(Bool.self, forKey: .networkBlocking)) ?? networkBlocking
        popupShield = (try? c.decode(Bool.self, forKey: .popupShield)) ?? popupShield
        redirectShield = (try? c.decode(Bool.self, forKey: .redirectShield)) ?? redirectShield
        overlaySweeper = (try? c.decode(Bool.self, forKey: .overlaySweeper)) ?? overlaySweeper
        downloadShield = (try? c.decode(Bool.self, forKey: .downloadShield)) ?? downloadShield
        enabledLists = (try? c.decode(Set<String>.self, forKey: .enabledLists)) ?? enabledLists
        fetchMetadata = (try? c.decode(Bool.self, forKey: .fetchMetadata)) ?? fetchMetadata
        saveBrowsingHistory = (try? c.decode(Bool.self, forKey: .saveBrowsingHistory)) ?? saveBrowsingHistory
        searchEngine = (try? c.decode(SearchEngine.self, forKey: .searchEngine)) ?? searchEngine
        showDownloadButton = (try? c.decode(Bool.self, forKey: .showDownloadButton)) ?? showDownloadButton
        downloadsFolder = (try? c.decode(String.self, forKey: .downloadsFolder)) ?? downloadsFolder
        captionStyle = (try? c.decode(CaptionStyle.self, forKey: .captionStyle)) ?? captionStyle
        voiceBoost = (try? c.decode(Bool.self, forKey: .voiceBoost)) ?? voiceBoost
        binWatchedDownloads = (try? c.decode(Bool.self, forKey: .binWatchedDownloads)) ?? binWatchedDownloads
        playNextDownload = (try? c.decode(Bool.self, forKey: .playNextDownload)) ?? playNextDownload
        newEpisodeAlerts = (try? c.decode(Bool.self, forKey: .newEpisodeAlerts)) ?? newEpisodeAlerts
        sharePet = (try? c.decode(Bool.self, forKey: .sharePet)) ?? sharePet
        cloudBackup = (try? c.decode(Bool.self, forKey: .cloudBackup)) ?? cloudBackup
    }
}

nonisolated enum SearchEngine: String, Codable, CaseIterable, Sendable {
    case duckDuckGo, google, brave, kagi

    var label: String {
        switch self {
        case .duckDuckGo: "DuckDuckGo"
        case .google: "Google"
        case .brave: "Brave Search"
        case .kagi: "Kagi"
        }
    }

    func url(for query: String) -> URL? {
        var parts = URLComponents()
        parts.scheme = "https"
        parts.queryItems = [URLQueryItem(name: "q", value: query)]
        switch self {
        case .duckDuckGo:
            parts.host = "duckduckgo.com"
            parts.path = "/"
        case .google:
            parts.host = "www.google.com"
            parts.path = "/search"
        case .brave:
            parts.host = "search.brave.com"
            parts.path = "/search"
        case .kagi:
            parts.host = "kagi.com"
            parts.path = "/search"
        }
        return parts.url
    }
}

nonisolated enum Timecode {
    /// 1:02:03 or 42:10.
    static func string(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let total = Int(seconds)
        let h = total / 3600
        let m = (total % 3600) / 60
        let s = total % 60
        if h > 0 { return String(format: "%d:%02d:%02d", h, m, s) }
        return String(format: "%d:%02d", m, s)
    }

    /// "1 h 12 min", "42 min" or "under a minute".
    static func spoken(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "" }
        let minutes = Int((seconds / 60).rounded())
        if minutes < 1 { return "under a minute" }
        if minutes < 60 { return "\(minutes) min" }
        let h = minutes / 60
        let m = minutes % 60
        return m == 0 ? "\(h) h" : "\(h) h \(m) min"
    }
}

nonisolated enum URLKey {
    private static let tracking = ["utm_", "fbclid", "gclid", "ref", "ref_", "yclid", "mc_", "_ga"]

    /// A stable key for "this page", ignoring fragments and tracking parameters.
    static func make(_ url: URL) -> String {
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return url.absoluteString
        }
        // Some sites switch episodes by changing only the fragment. It's part of the page's identity
        // there. The dub in it isn't: changing voice is still the same episode.
        let episodeFragment = parts.fragment.flatMap { fragment -> String? in
            guard let range = fragment.range(of: #"s:\d+-e:\d+"#, options: .regularExpression) else { return nil }
            return String(fragment[range])
        }
        parts.fragment = episodeFragment
        parts.scheme = nil
        parts.user = nil
        parts.password = nil
        if let host = parts.host?.lowercased() {
            parts.host = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
        }
        if let items = parts.queryItems {
            let kept = items
                .filter { item in !tracking.contains { item.name.lowercased().hasPrefix($0) } }
                .sorted { $0.name < $1.name }
            parts.queryItems = kept.isEmpty ? nil : kept
        }
        while parts.path.hasSuffix("/") { parts.path.removeLast() }
        var key = parts.string ?? url.absoluteString
        if key.hasPrefix("//") { key.removeFirst(2) }
        return key
    }
}

nonisolated enum DomainName {
    /// Second-level suffixes that behave like TLDs. Enough for sites people actually visit.
    private static let compoundSuffixes: Set<String> = [
        "co.uk", "org.uk", "ac.uk", "me.uk", "com.ua", "org.ua", "net.ua", "in.ua", "kiev.ua", "lviv.ua",
        "co.jp", "or.jp", "ne.jp", "com.au", "net.au", "org.au", "com.br", "net.br", "co.nz", "co.in",
        "co.kr", "com.cn", "com.tw", "com.tr", "com.mx", "com.ar", "co.za", "com.ru", "org.ru", "net.ru",
        "com.pl", "net.pl", "org.pl", "com.de", "co.il", "com.sg", "com.hk", "pp.ua", "biz.ua", "at.ua",
    ]

    /// `player.vod.example.co.uk` becomes `example.co.uk`.
    static func registrable(_ host: String) -> String {
        var h = host.lowercased()
        if h.hasSuffix(".") { h.removeLast() }
        if isIPAddress(h) { return h }
        let labels = h.split(separator: ".").map(String.init)
        guard labels.count > 2 else { return h }
        let lastTwo = labels.suffix(2).joined(separator: ".")
        if compoundSuffixes.contains(lastTwo) { return labels.suffix(3).joined(separator: ".") }
        return lastTwo
    }

    static func isSameSite(_ a: String?, _ b: String?) -> Bool {
        guard let a, let b else { return false }
        return registrable(a) == registrable(b)
    }

    static func isIPAddress(_ host: String) -> Bool {
        host.contains(":") || host.split(separator: ".").allSatisfy { Int($0) != nil }
    }

    /// `example.co.uk` becomes `Example`. Used for names and to spot the site in page titles.
    static func displayName(_ host: String) -> String {
        let reg = registrable(host)
        let first = reg.split(separator: ".").first.map(String.init) ?? reg
        return first.prefix(1).uppercased() + first.dropFirst()
    }
}
