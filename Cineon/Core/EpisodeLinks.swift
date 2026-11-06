import Foundation

/// Finds the address of another episode by rewriting where this one is named in the current address.
nonisolated enum EpisodeLinks {
    private struct Pattern {
        let regex: NSRegularExpression
        let hasSeason: Bool
    }

    private static let words = "(?:seriya|seriia|seria|serija|epizod|episode|ep)"
    private static let seasonWords = "(?:sezona|sezonu|sezon|season)"

    /// Most specific first. The numbers have to match the episode that's playing, which is
    /// what stops a film called "Part 2" or a site with "2" in its path from being rewritten.
    private static let patterns: [Pattern] = [
        // #t:238-s:3-e:5
        (#"(?:^|[#-])s:(?<s>\d+)-e:(?<e>\d+)"#, true),
        // s02e04, s2-e4, s02.e04
        (#"(?<![a-z0-9])s(?<s>\d{1,2})[._-]?e(?<e>\d{1,3})(?![0-9])"#, true),
        // 2x04
        (#"(?<![a-z0-9])(?<s>\d{1,2})x(?<e>\d{1,3})(?![0-9])"#, true),
        // 2-sezon/4-seriya, 2-season-4-episode
        ("(?<![0-9])(?<s>\\d{1,2})[-_]?\(seasonWords)[^/?#]*?[/_-]+(?<e>\\d{1,3})[-_]?\(words)(?![a-z])", true),
        // season-2/episode-4, season/2/episode/4, sezon-2-seriya-4, season=2&episode=4
        ("\(seasonWords)[-_/=]?(?<s>\\d{1,2})(?![0-9])[^/?#]*?[/_&-]+\(words)[-_/=]?(?<e>\\d{1,3})(?![0-9])", true),
        // ?s=2&e=4
        (#"[?&]s=(?<s>\d{1,2})&e=(?<e>\d{1,3})(?![0-9])"#, true),
        // episode-4, seriya/4, ep=4
        ("(?<![a-z])\(words)[-_/=]?(?<e>\\d{1,3})(?![0-9])", false),
        // 4-seriya, 4-episode
        ("(?<![0-9])(?<e>\\d{1,3})[-_]?\(words)(?![a-z])", false),
    ].compactMap { source, hasSeason in
        (try? NSRegularExpression(pattern: source, options: [.caseInsensitive])).map { Pattern(regex: $0, hasSeason: hasSeason) }
    }

    /// nil when the address doesn't name this episode, or names it in a way that can't reach the target.
    static func url(from url: URL, current: EpisodeRef, target: EpisodeRef) -> URL? {
        let text = url.absoluteString
        let whole = NSRange(text.startIndex..., in: text)
        for pattern in patterns {
            for match in pattern.regex.matches(in: text, range: whole) {
                let episodeRange = match.range(withName: "e")
                guard let range = Range(episodeRange, in: text), Int(text[range]) == current.episode else { continue }
                var replacements = [(range, target.episode)]

                if pattern.hasSeason {
                    guard let seasonRange = Range(match.range(withName: "s"), in: text),
                          Int(text[seasonRange]) == current.season
                    else { continue }
                    replacements.append((seasonRange, target.season))
                } else if target.season != current.season {
                    // An address with only an episode number can't change season.
                    continue
                }

                // One zero-padded number means they all are: s02e10 goes to s03e01, not s03e1.
                let isPadded = replacements.contains { text[$0.0].hasPrefix("0") }
                var result = text
                for (range, number) in replacements.sorted(by: { $0.0.lowerBound > $1.0.lowerBound }) {
                    let width = text[range].count
                    result.replaceSubrange(range, with: isPadded ? String(format: "%0\(width)d", number) : String(number))
                }
                return URL(string: result)
            }
        }
        return nil
    }
}

nonisolated enum NextEpisode {
    /// What could come next. With a published episode list that's one answer, or none after the
    /// last aired episode. Without one, either the next number or the start of the next season.
    static func candidates(after ref: EpisodeRef, episodes: [EpisodeInfo], now: Date = .now) -> [EpisodeRef] {
        if ref.season == 0 { return [EpisodeRef(season: 0, episode: ref.episode + 1)] }
        let numbered = episodes.filter { $0.season > 0 }
        if numbered.isEmpty {
            return [EpisodeRef(season: ref.season, episode: ref.episode + 1), EpisodeRef(season: ref.season + 1, episode: 1)]
        }
        let next = numbered
            .sorted { ($0.season, $0.episode) < ($1.season, $1.episode) }
            .first { ($0.season, $0.episode) > (ref.season, ref.episode) }
        guard let next else { return [] }
        if let released = next.released, released > now { return [] }
        return [EpisodeRef(season: next.season, episode: next.episode)]
    }
}

/// Reads intro and credits out of what someone does while watching.
nonisolated enum SkipLearner {
    /// A run of forward jumps made close together, such as pressing the right arrow nine times.
    struct Jump: Equatable {
        var from: Double
        var to: Double
        var lastAt: Date

        /// nil when the new jump starts a new run. A jump backwards also ends the run.
        func extended(from nextFrom: Double, to nextTo: Double, at: Date) -> Jump? {
            guard at.timeIntervalSince(lastAt) <= mergeWindow, nextTo > nextFrom, abs(nextFrom - to) <= 8 else { return nil }
            return Jump(from: from, to: nextTo, lastAt: at)
        }
    }

    static let mergeWindow: TimeInterval = 4

    /// Is this jump shaped like skipping an intro?
    static func isIntro(from: Double, to: Double, duration: Double) -> Bool {
        let length = to - from
        guard length >= 15, length <= 240 else { return false }
        return from <= min(duration * 0.35, 900) && to < duration * 0.5
    }

    /// Is leaving this far from the end shaped like skipping the credits?
    static func isCredits(remaining: Double, duration: Double) -> Bool {
        remaining >= 15 && remaining <= min(duration * 0.2, 420)
    }

    /// Two sightings of credits describe the same thing.
    static func agree(_ a: Double, _ b: Double) -> Bool { abs(a - b) <= 30 }

    /// Rules are shared between mirrors of a site, not between different sites, whose copies
    /// can be cut differently.
    static func siteKey(_ host: String) -> String {
        let registrable = DomainName.registrable(host)
        return DomainName.isIPAddress(registrable) ? registrable : ImportAnalyzer.brand(registrable)
    }
}
