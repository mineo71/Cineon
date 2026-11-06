import Foundation

/// A link found on a site's search results page.
nonisolated struct RescueLink: Hashable, Sendable {
    var url: URL
    /// The link's own words: its text, title and image description.
    var text: String
    /// Words around it, where cards keep the year.
    var context: String
}

nonisolated struct RescueMatch: Hashable, Sendable {
    var link: RescueLink
    var score: Double
    var yearConfirmed: Bool

    /// Sure enough to open without asking.
    var isStrong: Bool { score >= RescueMatcher.strongScore && yearConfirmed }
}

/// Decides which link on a results page is the film being looked for. Getting this wrong means
/// opening Dune (1984) instead of Dune (2021), so anything uncertain stays a suggestion.
nonisolated enum RescueMatcher {
    static let strongScore = 0.9
    static let possibleScore = 0.6

    /// Page furniture that says nothing about which film this is.
    private static let noise = Set([
        "watch", "online", "free", "full", "movie", "film", "hd", "4k", "1080p", "720p", "hdrip", "webrip", "bluray",
        "смотреть", "онлайн", "бесплатно", "фильм", "сериал", "дивитися", "дивитись", "фільм", "серіал",
        "безкоштовно", "українською", "на", "в", "качестве", "хорошем", "озвучке",
    ].flatMap(tokens))

    /// Something about the film, rather than the film.
    private static let notTheFilm = Set([
        "trailer", "teaser", "review", "reaction", "soundtrack", "ost", "interview", "featurette", "clip", "clips",
        "recap", "explained", "breakdown", "shorts", "behind", "making",
        "трейлер", "тизер", "обзор", "огляд", "рецензия", "рецензія", "интервью", "інтерв", "саундтрек",
    ].flatMap(tokens))

    private static let notFilmPaths = [
        "/search", "/tag/", "/tags/", "/genre/", "/genres/", "/actor/", "/actors/", "/person/", "/people/", "/country/",
        "/login", "/register", "/signup", "/account", "/user/", "/channel/", "/playlist",
    ]

    private static let yearPattern = try? NSRegularExpression(pattern: #"(?<![0-9])(19|20)[0-9]{2}(?![0-9])"#)
    private static let segmentPattern = try? NSRegularExpression(pattern: #"\n|/|\||\s[–—-]\s"#)

    static func tokens(_ text: String) -> [String] {
        text.folding(options: [.diacriticInsensitive, .caseInsensitive, .widthInsensitive], locale: nil)
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
    }

    static func years(in text: String) -> [Int] {
        guard let yearPattern else { return [] }
        return yearPattern.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { match in
            Range(match.range, in: text).flatMap { Int(text[$0]) }
        }
    }

    private static func isYear(_ token: String) -> Bool {
        token.count == 4 && Int(token).map { (1900..<2100).contains($0) } == true
    }

    /// How well one piece of text names the film, from 0 to 1, leaving the year aside.
    static func nameScore(_ text: String, name: String) -> Double {
        let needle = tokens(name).filter { !isYear($0) }
        guard !needle.isEmpty else { return 0 }
        let words = tokens(text).filter { !isYear($0) }
        guard words.count >= needle.count else { return 0 }

        // Furniture only counts once the name has been found, because a name can contain the
        // same words: "Scary Movie", "The Film".
        for start in 0...(words.count - needle.count) where Array(words[start..<(start + needle.count)]) == needle {
            var extras = words
            extras.removeSubrange(start..<(start + needle.count))
            extras.removeAll(where: noise.contains)
            // "Dune 2" is a different film from "Dune". "Dune extended cut" probably isn't.
            let numbers = extras.filter { Int($0) != nil }.count
            let others = extras.count - numbers
            return max(0.5, 1 - Double(others) * 0.05 - Double(numbers) * 0.35)
        }
        return 0
    }

    private static func segments(of text: String) -> [String] {
        guard let segmentPattern else { return [text] }
        let marked = segmentPattern.stringByReplacingMatches(
            in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "\u{1}"
        )
        return marked.split(separator: "\u{1}").map(String.init) + [text]
    }

    private static func slug(of url: URL) -> String {
        var last = url.deletingPathExtension().lastPathComponent
        // Leading catalogue numbers: /films/18432-dune.html
        while let first = last.first, first.isNumber { last.removeFirst() }
        return last
    }

    static func score(_ link: RescueLink, names: [String], year: Int?) -> RescueMatch {
        let words = Set(tokens(link.text))
        var best = 0.0
        if words.isDisjoint(with: notTheFilm) {
            for name in names {
                for segment in segments(of: link.text) {
                    best = max(best, nameScore(segment, name: name))
                }
                // The address is weaker evidence: enough to suggest, not to open by itself.
                best = max(best, nameScore(slug(of: link.url), name: name) * 0.85)
            }
        }

        var confirmed = year == nil
        if let year, best > 0 {
            let own = years(in: link.text)
            let nearby = years(in: link.context)
            if own.contains(where: { abs($0 - year) <= 1 }) {
                confirmed = true
            } else if !own.isEmpty {
                best *= 0.4
            } else if nearby.contains(where: { abs($0 - year) <= 1 }) {
                confirmed = true
            } else if !nearby.isEmpty {
                best *= 0.7
            }
        }
        return RescueMatch(link: link, score: best, yearConfirmed: confirmed)
    }

    /// The best link on a page, if any is good enough to show.
    static func best(links: [RescueLink], names: [String], year: Int?, pageURL: URL?) -> RescueMatch? {
        links
            .filter { isCandidate($0.url, pageURL: pageURL) }
            .map { score($0, names: names, year: year) }
            .filter { $0.score >= possibleScore }
            .max { ($0.isStrong ? 1 : 0, $0.score) < ($1.isStrong ? 1 : 0, $1.score) }
    }

    private static func isCandidate(_ url: URL, pageURL: URL?) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return false }
        if let pageURL {
            guard DomainName.isSameSite(url.host, pageURL.host), URLKey.make(url) != URLKey.make(pageURL) else { return false }
        }
        let path = url.path.lowercased()
        guard path.count > 1 else { return false }
        return !notFilmPaths.contains { path.contains($0) }
    }

    /// Anyone can upload anything there, so a name that matches is often not the film.
    /// Good to suggest, not to open without asking.
    static func isVideoSharing(_ url: URL) -> Bool {
        guard let host = url.host else { return false }
        return ["youtube.com", "youtu.be", "vimeo.com", "dailymotion.com", "rutube.ru", "ok.ru", "vk.com", "facebook.com", "tiktok.com"]
            .contains(DomainName.registrable(host))
    }

    // MARK: Mirrors

    /// Words too common to mean two addresses are the same site.
    private static let genericBrands: Set<String> = [
        "film", "films", "filmy", "kino", "movie", "movies", "online", "watch", "serial", "serials", "series", "tv", "hd",
        "video", "videos", "stream", "cinema", "anime",
    ]

    /// The same page at other addresses of this site, in the order given.
    static func mirrors(of url: URL, among hosts: [String]) -> [URL] {
        guard let host = url.host?.lowercased(), !DomainName.isIPAddress(host) else { return [] }
        let brand = ImportAnalyzer.brand(DomainName.registrable(host))
        guard brand.count >= 4, !genericBrands.contains(brand) else { return [] }

        var seen = Set([DomainName.registrable(host)])
        var out: [URL] = []
        for other in hosts {
            let candidate = other.lowercased()
            let registrable = DomainName.registrable(candidate)
            guard !DomainName.isIPAddress(candidate), ImportAnalyzer.brand(registrable) == brand,
                  seen.insert(registrable).inserted,
                  var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
            else { continue }
            parts.host = candidate
            if let mirror = parts.url { out.append(mirror) }
        }
        return out
    }
}
