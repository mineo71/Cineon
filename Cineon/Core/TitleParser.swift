import Foundation

/// What a page says about itself, gathered by `meta.js`.
nonisolated struct PageMeta: Codable, Hashable, Sendable {
    var url: String = ""
    var title: String = ""
    var ogTitle: String?
    var ogType: String?
    var ogSite: String?
    var ogImage: String?
    var ogDescription: String?
    var twitterTitle: String?
    var h1: String?
    var ld: [LinkedData] = []
    var icon: String?
    var search: String?

    nonisolated struct LinkedData: Codable, Hashable, Sendable {
        var type: String?
        var name: String?
        var series: String?
        var season: Int?
        var episode: Int?
        var year: Int?
        var image: String?
        var description: String?
    }
}

nonisolated struct ParsedTitle: Hashable, Sendable {
    var name: String
    /// A second name in another language, from titles like "Дюна / Dune".
    var altName: String?
    var year: Int?
    var ref: EpisodeRef = .none
    var episodeName: String?
    var kindHint: TitleKind = .unknown
    var posterURL: URL?
    var overview: String?
    /// 0 to 1. Below 0.5 the interface asks whether the name is right.
    var confidence: Double
}

/// Turns messy streaming site titles into a clean film name. Handles English, Ukrainian and
/// Russian page furniture, because that is what these sites actually look like.
nonisolated enum TitleParser {

    static func parse(_ meta: PageMeta) -> ParsedTitle? {
        let url = URL(string: meta.url)
        let host = url?.host ?? ""
        let siteTokens = siteNames(host: host, ogSite: meta.ogSite)

        var result: ParsedTitle?

        if let ld = bestLinkedData(meta.ld) {
            let isEpisode = ld.type?.lowercased().contains("episode") == true
            let isSeries = ld.type?.lowercased().contains("series") == true
            if let name = cleanLinkedName(isEpisode ? (ld.series ?? ld.name) : ld.name) {
                var parsed = clean(name, siteTokens: siteTokens) ?? ParsedTitle(name: name, confidence: 0.9)
                parsed.confidence = 0.95
                parsed.year = ld.year ?? parsed.year
                parsed.kindHint = isEpisode || isSeries ? .series : .film
                if let season = ld.season, let episode = ld.episode {
                    parsed.ref = EpisodeRef(season: season, episode: episode)
                    parsed.kindHint = .series
                }
                if isEpisode, ld.series != nil { parsed.episodeName = ld.name }
                parsed.overview = ld.description
                parsed.posterURL = ld.image.flatMap(URL.init(string:))
                result = parsed
            }
        }

        if result == nil {
            let candidates: [(String?, Double)] = [
                (meta.ogTitle, 0.8), (meta.h1, 0.7), (meta.twitterTitle, 0.7), (meta.title, 0.6),
            ]
            for (text, confidence) in candidates {
                guard let text, var parsed = clean(text, siteTokens: siteTokens) else { continue }
                parsed.confidence = confidence
                result = parsed
                break
            }
        }

        if result == nil, let url, var fromSlug = parseSlug(url) {
            fromSlug.confidence = 0.35
            result = fromSlug
        }

        guard var parsed = result else { return nil }

        // Season and episode may live in any of these, even when the name came from elsewhere.
        if !parsed.ref.isEpisode {
            let haystacks = [meta.ogTitle, meta.title, meta.h1, meta.url.removingPercentEncoding ?? meta.url]
            for text in haystacks.compactMap({ $0 }) {
                if let ref = episodeRef(in: text) {
                    parsed.ref = ref
                    break
                }
            }
        }
        if parsed.ref.isEpisode { parsed.kindHint = .series }
        if parsed.kindHint == .unknown, let type = meta.ogType?.lowercased() {
            if type.contains("movie") { parsed.kindHint = .film }
            if type.contains("tv_show") || type.contains("episode") { parsed.kindHint = .series }
        }
        if parsed.kindHint == .unknown { parsed.kindHint = kindHint(in: meta.title + " " + (meta.ogTitle ?? "")) }
        if let path = url?.path.lowercased() {
            if path.range(of: #"/(cartoons?|animation|anime|mult|multfilm|multfilmy|multiki)(/|$)"#, options: .regularExpression) != nil {
                parsed.kindHint = .cartoon
            } else if parsed.kindHint == .unknown {
                if path.range(of: #"/(series|serial|serials|serialy|tv|tv-?shows?)(/|$)"#, options: .regularExpression) != nil {
                    parsed.kindHint = .series
                } else if path.range(of: #"/(films?|filmy|filmi|movies?)(/|$)"#, options: .regularExpression) != nil {
                    parsed.kindHint = .film
                }
            }
        }
        if parsed.posterURL == nil { parsed.posterURL = meta.ogImage.flatMap(URL.init(string:)) }
        if parsed.overview == nil { parsed.overview = meta.ogDescription }
        return parsed
    }

    // MARK: Cleaning

    /// Phrases that describe the page rather than the film. Longest first, applied whole-word.
    private static let noisePhrases: [String] = [
        "watch online free", "watch online for free", "watch free online", "watch full movie online",
        "watch full movie", "watch movie online", "watch series online", "watch tv show online",
        "full movie online", "full movie", "full episodes", "free online", "for free", "online free",
        "stream online", "streaming online", "with english subtitles", "with subtitles", "english subtitles",
        "english subbed", "english dubbed", "in hd", "hd online", "free hd", "official site", "tv show", "tv series",
        // Bare "movie" and "film" stay: they're part of names like The Lego Movie.
        "movie online", "film online", "movie free", "film free",
        "watch", "streaming", "stream", "online", "free", "subbed", "dubbed",
        "1080p", "720p", "480p", "2160p", "4k", "uhd", "fullhd", "full hd", "hdrip", "bdrip", "webrip", "web-dl", "hd",
        "60fps", "30fps", "hdr", "free download", "download",
        "дивитись онлайн безкоштовно", "дивитися онлайн безкоштовно", "дивитись онлайн", "дивитися онлайн",
        "дивитись безкоштовно", "дивитися безкоштовно", "дивитись", "дивитися", "онлайн безкоштовно",
        "у хорошій якості", "в хорошій якості", "в гарній якості", "у гарній якості", "у високій якості",
        "українською мовою", "українською", "безкоштовно", "без реєстрації", "всі серії", "усі серії", "всі сезони",
        "смотреть онлайн бесплатно", "смотреть бесплатно", "смотреть онлайн", "смотреть", "онлайн бесплатно",
        "в хорошем качестве", "в высоком качестве", "на русском языке", "на русском", "бесплатно",
        "без регистрации", "все серии", "все сезоны", "онлайн", "фильм", "фільм", "сериал", "серіал",
        "мультфильм", "мультфільм", "мультсериал", "мультсеріал", "аниме", "аніме", "кино", "кіно",
    ]

    private static let noiseRegex: NSRegularExpression = {
        let sorted = noisePhrases.sorted { $0.count > $1.count }.map(NSRegularExpression.escapedPattern(for:))
        let pattern = "(?<![\\p{L}\\p{N}])(?:" + sorted.joined(separator: "|") + ")(?![\\p{L}\\p{N}])"
        return try! NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
    }()

    private static let episodePatterns: [(NSRegularExpression, season: Int, episode: Int)] = {
        func re(_ p: String) -> NSRegularExpression { try! NSRegularExpression(pattern: p, options: [.caseInsensitive]) }
        return [
            (re(#"\bS(\d{1,2})[ ._-]?E(\d{1,4})\b"#), 1, 2),
            (re(#"\b(\d{1,2})x(\d{2,3})\b"#), 1, 2),
            (re(#"season[ ._/-]*(\d{1,2})[ ,.:/_-]*(?:episode|ep)[ ._/-]*(\d{1,4})"#), 1, 2),
            (re(#"(?:сезон|season)[ ._/-]*(\d{1,2})[ ,.:/_-]*(?:серія|серия|епізод|эпизод|episode)[ ._/-]*(\d{1,4})"#), 1, 2),
            (re(#"(\d{1,2})[ -]*(?:сезон|season)[ ,.:/_-]*(\d{1,4})[ -]*(?:серія|серия|епізод|эпизод|episode)"#), 1, 2),
            (re(#"/(?:tv|series|show|serial)/[^/]*?/?(?:\d+/)?(\d{1,2})/(\d{1,4})(?:/|$)"#), 1, 2),
            (re(#"[?&]season=(\d{1,2}).*?[?&](?:episode|ep)=(\d{1,4})"#), 1, 2),
            (re(#"[?&]s=(\d{1,2})&e=(\d{1,4})"#), 1, 2),
            // HDRezka and its mirrors keep the episode in the fragment: #t:238-s:2-e:3.
            (re(#"[#-]s:(\d{1,2})-e:(\d{1,4})"#), 1, 2),
        ]
    }()

    /// Removes season and episode wording, once it has been read.
    private static let episodeStrip: [NSRegularExpression] = {
        func re(_ p: String) -> NSRegularExpression { try! NSRegularExpression(pattern: p, options: [.caseInsensitive]) }
        return [
            re(#"\bS\d{1,2}[ ._-]?E\d{1,4}\b"#),
            re(#"\b\d{1,2}x\d{2,3}\b"#),
            re(#"\bseason[ ._-]*\d{1,2}(?:[ ,.:_-]*(?:episode|ep)[ ._-]*\d{1,4})?"#),
            re(#"\bepisode[ ._-]*\d{1,4}\b"#),
            re(#"\b\d{1,2}[ -]*(?:season|сезон)\b"#),
            re(#"\b\d{1,4}[ -]*(?:episode|серія|серия|епізод|эпизод)\b"#),
            re(#"(?:сезон)[ ._-]*\d{1,2}"#),
            re(#"(?:серія|серия|епізод|эпизод)[ ._-]*\d{1,4}"#),
        ]
    }()

    /// Everything from these onward describes the release, not the film: the dub, quality or format.
    private static let trailingFurniture: [NSRegularExpression] = {
        func re(_ p: String) -> NSRegularExpression { try! NSRegularExpression(pattern: p, options: [.caseInsensitive]) }
        let start = #"(?<![\p{L}\p{N}])"#
        return [
            re(start + #"в\s+озвучк\p{L}*.*$"#),
            re(start + #"в\s+(\d+\s*)?(и\s+\d+\s*)?качеств\p{L}*.*$"#),
            re(start + #"у\s+(\d+\s*)?якості.*$"#),
            re(start + #"(скачать|скачати)(?![\p{L}]).*$"#),
            re(start + #"торрент(?![\p{L}]).*$"#),
            re(#"\[\s*(ТВ|TV)[^\]]*\]"#),
            re(#"\(\s*(трейлер|тизер|чб|trailer|teaser|режисс[её]рская версия|режисерська версія|18\+|\+?субтитры)[^)]*\)"#),
            re(#"(?i)\benglish\s+sub(/dub)?\b.*$"#),
            re(#"(?i)\bsub/dub\b.*$"#),
            re(#"(?i)\bon\s+[\w-]+\.\w{2,}\b.*$"#),
            re(start + #"скоро\s*$"#),
            re(#"(?i)\bcoming soon\s*$"#),
            // An opening bracket that never closes: "Мэйдэй (Mayday".
            re(#"\s*\([^)]*$"#),
        ]
    }()

    private static let yearRegex = try! NSRegularExpression(pattern: #"[\(\[]?\b(19\d{2}|20[0-4]\d)\b[\)\]]?"#)
    /// " : " with spaces separates page sections. "Dune: Part Two" has no space before the colon.
    private static let separators = [" | ", " – ", " — ", " - ", " :: ", " : ", " • ", " · ", " » ", " « ", " ~ "]

    /// Reads a title string. Returns nil if nothing film-like is left after cleaning.
    static func clean(_ raw: String, siteTokens: Set<String>) -> ParsedTitle? {
        let text = raw
            .replacingOccurrences(of: "\u{00A0}", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }

        let ref = episodeRef(in: text) ?? .none
        let kind = kindHint(in: text)

        // Keep the first segment that still says something once the page furniture is gone.
        var name: String?
        var year: Int?
        var fallbackSegments: [String] = []
        for segment in split(text, by: separators) {
            let (cleaned, foundYear) = cleanSegment(segment, siteTokens: siteTokens)
            if year == nil { year = foundYear }
            guard isMeaningful(cleaned) else { continue }
            if name == nil { name = cleaned } else { fallbackSegments.append(cleaned) }
        }
        guard var resolved = name else { return nil }

        // "Дюна / Dune" names the same film twice. Keep both, so lookups can use either.
        var alt: String?
        let bilingual = resolved.components(separatedBy: " / ").map { $0.trimmingCharacters(in: .whitespaces) }
        if bilingual.count >= 2, bilingual.allSatisfy(isMeaningful) {
            resolved = bilingual[0]
            alt = bilingual[1]
        }

        return ParsedTitle(name: resolved, altName: alt, year: year, ref: ref, kindHint: kind, confidence: 0.6)
    }

    private static func cleanSegment(_ raw: String, siteTokens: Set<String>) -> (String, Int?) {
        var s = raw
        var year: Int?
        let full = NSRange(s.startIndex..., in: s)
        if let m = yearRegex.firstMatch(in: s, range: full), let r = Range(m.range(at: 1), in: s) {
            let candidate = String(s[r])
            // A name like "1917" or "2012" is the whole title, so leave it alone.
            let withoutYear = yearRegex.stringByReplacingMatches(in: s, range: full, withTemplate: " ")
            if isMeaningful(strip(withoutYear)) {
                year = Int(candidate)
                s = withoutYear
            }
        }
        for regex in episodeStrip {
            s = regex.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: " ")
        }
        for regex in trailingFurniture {
            s = regex.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: " ")
        }
        s = noiseRegex.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: " ")
        // Removing noise can leave furniture at the very end: "Одиссея скоро смотреть онлайн".
        s = s.trimmingCharacters(in: .whitespaces)
        for regex in trailingFurniture {
            s = regex.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: " ")
        }
        s = strip(s)
        if siteTokens.contains(normalize(s)) { return ("", year) }
        return (s, year)
    }

    private static func strip(_ raw: String) -> String {
        var s = raw.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        s = s.replacingOccurrences(of: #"\(\s*\)|\[\s*\]"#, with: " ", options: .regularExpression)
        s = s.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        // Quotes left unbalanced by the cleaning above would look broken.
        if s.filter({ $0 == "«" }).count != s.filter({ $0 == "»" }).count {
            s = s.replacingOccurrences(of: "«", with: "").replacingOccurrences(of: "»", with: "")
        }
        s = trimQuotes(s)
        // A name wrapped whole in quotes doesn't need them. Quotes inside a name stay.
        if s.hasPrefix("«"), s.hasSuffix("»"), s.filter({ $0 == "«" }).count == 1 {
            s = String(s.dropFirst().dropLast())
        }
        return s
    }

    /// Removes furniture from both ends, and quotes that wrap the whole name or have lost their
    /// partner. A quote closing a phrase inside the name stays: Charlie Chaplin's "The Rink".
    private static func trimQuotes(_ raw: String) -> String {
        let edges = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "-–—|:,.;·•~/\\"))
        let quotes: Set<Character> = ["\"", "“", "”", "„", "'"]
        var s = raw.trimmingCharacters(in: edges)
        while let first = s.first, let last = s.last {
            let count = s.filter { quotes.contains($0) && $0 != "'" }.count
            if quotes.contains(first), quotes.contains(last), s.count > 1, s.filter(quotes.contains).count == 2 {
                s = String(s.dropFirst().dropLast())
            } else if last != "'", quotes.contains(last), !count.isMultiple(of: 2) {
                s = String(s.dropLast())
            } else if first != "'", quotes.contains(first), !count.isMultiple(of: 2) {
                s = String(s.dropFirst())
            } else {
                break
            }
            s = s.trimmingCharacters(in: edges)
        }
        return s
    }

    private static func split(_ s: String, by separators: [String]) -> [String] {
        var parts = [s]
        for separator in separators {
            parts = parts.flatMap { $0.components(separatedBy: separator) }
        }
        return parts
    }

    private static func isMeaningful(_ s: String) -> Bool {
        s.count >= 2 && s.rangeOfCharacter(from: .letters.union(.decimalDigits)) != nil
    }

    static func episodeRef(in text: String) -> EpisodeRef? {
        let range = NSRange(text.startIndex..., in: text)
        for (regex, seasonGroup, episodeGroup) in episodePatterns {
            guard let m = regex.firstMatch(in: text, range: range),
                  let sr = Range(m.range(at: seasonGroup), in: text),
                  let er = Range(m.range(at: episodeGroup), in: text),
                  let season = Int(text[sr]), let episode = Int(text[er])
            else { continue }
            return EpisodeRef(season: season, episode: episode)
        }
        return nil
    }

    static func kindHint(in text: String) -> TitleKind {
        let t = text.lowercased()
        if ["мультфильм", "мультфільм", "мультсериал", "мультсеріал", "cartoon", "аниме", "аніме", "anime"]
            .contains(where: t.contains) { return .cartoon }
        if ["сериал", "серіал", "tv series", "tv show", "сезон", "season "].contains(where: t.contains) { return .series }
        if ["фильм", "фільм", "movie", "full film"].contains(where: t.contains) { return .film }
        return .unknown
    }

    static func normalize(_ s: String) -> String {
        let folded = s.folding(options: [.diacriticInsensitive, .caseInsensitive, .widthInsensitive], locale: nil)
        return String(folded.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }.map(Character.init))
    }

    // MARK: Helpers

    private static func siteNames(host: String, ogSite: String?) -> Set<String> {
        var names: Set<String> = []
        if !host.isEmpty {
            names.insert(normalize(DomainName.registrable(host)))
            names.insert(normalize(DomainName.displayName(host)))
            names.insert(normalize(host))
        }
        if let ogSite { names.insert(normalize(ogSite)) }
        return names
    }

    private static func bestLinkedData(_ items: [PageMeta.LinkedData]) -> PageMeta.LinkedData? {
        func score(_ item: PageMeta.LinkedData) -> Int {
            switch item.type?.lowercased() ?? "" {
            case let t where t.contains("episode"): 4
            case let t where t.contains("movie"): 3
            case let t where t.contains("series"): 2
            case let t where t.contains("videoobject"): 1
            default: 0
            }
        }
        return items.filter { $0.name?.isEmpty == false && score($0) > 0 }.max { score($0) < score($1) }
    }

    private static func cleanLinkedName(_ name: String?) -> String? {
        guard let name = name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { return nil }
        return name
    }

    private static func parseSlug(_ url: URL) -> ParsedTitle? {
        let path = url.path.removingPercentEncoding ?? url.path
        let segments = path.split(separator: "/").map(String.init)
        let generic: Set<String> = ["watch", "movie", "movies", "film", "films", "tv", "series", "show", "shows", "play", "player", "embed", "video", "videos", "season", "episode", "index.php", "ua", "ru", "en"]
        let candidates = segments.filter { segment in
            !generic.contains(segment.lowercased()) && segment.rangeOfCharacter(from: .letters) != nil
        }
        guard var slug = candidates.max(by: { $0.count < $1.count }) else { return nil }
        // Drop a leading numeric id ("1234-dune-part-two") and a file extension.
        slug = slug.replacingOccurrences(of: #"\.(html?|php)$"#, with: "", options: .regularExpression)
        slug = slug.replacingOccurrences(of: #"^\d+[-_]"#, with: "", options: .regularExpression)
        // Random ids at the end of a slug mix letters and digits ("dune-part-two-19xk2").
        slug = slug.replacingOccurrences(
            of: #"[-_](?=[a-zA-Z0-9]*\d)(?=[a-zA-Z0-9]*[a-zA-Z])[a-zA-Z0-9]{4,}$"#,
            with: "",
            options: .regularExpression
        )
        let spaced = slug.replacingOccurrences(of: #"[-_.+]+"#, with: " ", options: .regularExpression)
        guard var parsed = clean(spaced, siteTokens: []) else { return nil }
        parsed.name = parsed.name.split(separator: " ").map { word in
            word.prefix(1).uppercased() + word.dropFirst()
        }.joined(separator: " ")
        return parsed
    }
}
