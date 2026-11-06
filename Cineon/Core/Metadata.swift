import Foundation

nonisolated struct MetadataHit: Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var year: Int?
    var kind: TitleKind
    var posterURL: URL?
    var subtitle: String?
    var rank: Int?
}

nonisolated struct EpisodeInfo: Hashable, Sendable, Identifiable {
    var id: String { "\(season)x\(episode)" }
    var season: Int
    var episode: Int
    var name: String?
    var overview: String?
    var thumbnailURL: URL?
    var released: Date?

    init(season: Int, episode: Int, name: String? = nil, overview: String? = nil, thumbnailURL: URL? = nil, released: Date? = nil) {
        self.season = season
        self.episode = episode
        self.name = name
        self.overview = overview
        self.thumbnailURL = thumbnailURL
        self.released = released
    }
}

nonisolated struct MetadataDetail: Sendable {
    var overview: String?
    var genres: [String]
    var runtimeMinutes: Int?
    var posterURL: URL?
    var backdropURL: URL?
    var year: Int?
    var episodes: [EpisodeInfo]
}

/// Looks films up with no account and no API key: IMDb's public suggestions for search and
/// Cinemeta for descriptions and episode lists. Both are unofficial, so every failure here is
/// treated as "no poster" and never gets in the way of watching.
nonisolated enum MetadataClient {
    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 8
        config.httpAdditionalHeaders = ["User-Agent": "Mozilla/5.0 (Macintosh) Cineon/1.0"]
        return URLSession(configuration: config)
    }()

    static func search(_ query: String) async -> [MetadataHit] {
        let cleaned = query
            .lowercased()
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard cleaned.count >= 2,
              let encoded = cleaned.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)?
                .replacingOccurrences(of: "/", with: "%2F"),
              let url = URL(string: "https://v3.sg.media-imdb.com/suggestion/x/\(encoded).json")
        else { return [] }
        guard let (data, response) = try? await session.data(from: url),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let decoded = try? JSONDecoder().decode(IMDbResponse.self, from: data)
        else { return [] }
        return decoded.d.compactMap { item in
            guard item.id.hasPrefix("tt"), let name = item.l else { return nil }
            guard let kind = kind(from: item.qid) else { return nil }
            return MetadataHit(
                id: item.id,
                name: name,
                year: item.y,
                kind: kind,
                posterURL: item.i.flatMap { resizedPoster($0.imageUrl, width: 500) },
                subtitle: item.s,
                rank: item.rank
            )
        }
    }

    static func detail(imdbID: String, kind: TitleKind) async -> MetadataDetail? {
        let path = kind == .series ? "series" : "movie"
        let attempts = kind == .unknown || kind == .cartoon ? [path, "series"] : [path]
        for type in attempts {
            guard let url = URL(string: "https://v3-cinemeta.strem.io/meta/\(type)/\(imdbID).json"),
                  let (data, response) = try? await session.data(from: url),
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  let decoded = try? JSONDecoder().decode(CinemetaResponse.self, from: data),
                  let meta = decoded.meta
            else { continue }
            return MetadataDetail(
                overview: meta.description,
                genres: meta.genres ?? [],
                runtimeMinutes: meta.runtime.flatMap(parseRuntime),
                posterURL: meta.poster.flatMap(URL.init(string:)),
                backdropURL: meta.background.flatMap(URL.init(string:)),
                year: meta.releaseInfo.flatMap { Int($0.prefix(4)) },
                episodes: (meta.videos ?? []).compactMap(makeEpisode)
                    .filter { $0.season > 0 }
                    .sorted { ($0.season, $0.episode) < ($1.season, $1.episode) }
            )
        }
        return nil
    }

    private static func makeEpisode(_ video: CinemetaResponse.Video) -> EpisodeInfo? {
        guard let season = video.season, let episode = video.episode ?? video.number else { return nil }
        return EpisodeInfo(
            season: season,
            episode: episode,
            name: video.name,
            overview: video.overview ?? video.description,
            thumbnailURL: video.thumbnail.flatMap(URL.init(string:)),
            released: video.released.flatMap(parseDate)
        )
    }

    private static func parseDate(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s)
    }

    private static func parseRuntime(_ s: String) -> Int? {
        let digits = s.prefix { $0.isNumber }
        return Int(digits)
    }

    private static func kind(from qid: String?) -> TitleKind? {
        switch qid {
        case "movie", "tvMovie", "video", "short", "tvShort", "tvSpecial": .film
        case "tvSeries", "tvMiniSeries": .series
        default: nil
        }
    }

    /// Amazon's image CDN resizes on request, which keeps posters small and fast.
    static func resizedPoster(_ raw: String?, width: Int) -> URL? {
        guard let raw else { return nil }
        if raw.contains("._V1_") {
            let resized = raw.replacingOccurrences(of: "._V1_.", with: "._V1_QL75_UX\(width)_.")
            return URL(string: resized)
        }
        return URL(string: raw)
    }

    /// Picks the hit that really is this film. Returns nil rather than guessing badly.
    static func bestMatch(_ hits: [MetadataHit], name: String, year: Int?, kind: TitleKind) -> MetadataHit? {
        let target = TitleParser.normalize(name)
        let isLatin = name.unicodeScalars.contains { ($0.value >= 65 && $0.value <= 122) }
        let scored: [(MetadataHit, Int)] = hits.map { hit in
            var score = 0
            let norm = TitleParser.normalize(hit.name)
            if norm == target { score += 100 } else if norm.hasPrefix(target) || target.hasPrefix(norm) { score += 35 }
            if let year, let hitYear = hit.year {
                if year == hitYear { score += 40 } else if abs(year - hitYear) <= 1 { score += 15 } else { score -= 40 }
            }
            if kind == .series, hit.kind == .series { score += 20 }
            if kind == .film, hit.kind == .film { score += 20 }
            if kind == .series, hit.kind == .film { score -= 15 }
            if kind == .film, hit.kind == .series { score -= 15 }
            if let rank = hit.rank { score += max(0, 15 - rank / 500) }
            return (hit, score)
        }
        guard let top = scored.max(by: { $0.1 < $1.1 }) else { return nil }
        if isLatin { return top.1 >= 60 ? top.0 : nil }
        // Cyrillic and other scripts can't match IMDb's English names by spelling, so trust its
        // translated-title search, for titles popular enough to rank, unless the year contradicts it.
        return top.1 >= 5 ? top.0 : nil
    }

    private struct IMDbResponse: Decodable {
        var d: [Item]
        struct Item: Decodable {
            var id: String
            var l: String?
            var qid: String?
            var s: String?
            var y: Int?
            var rank: Int?
            var i: Image?
        }
        struct Image: Decodable { var imageUrl: String? }
    }

    private struct CinemetaResponse: Decodable {
        var meta: Meta?
        struct Meta: Decodable {
            var description: String?
            var genres: [String]?
            var runtime: String?
            var poster: String?
            var background: String?
            var releaseInfo: String?
            var videos: [Video]?
        }
        struct Video: Decodable {
            var name: String?
            var season: Int?
            var number: Int?
            var episode: Int?
            var overview: String?
            var description: String?
            var thumbnail: String?
            var released: String?
        }
    }
}

/// The poster and description a page advertises about itself. The fallback for titles the catalogue
/// doesn't know, which on Ukrainian and Russian sites is quite a few.
nonisolated enum PagePreview {
    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 8
        config.httpAdditionalHeaders = [
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"
        ]
        return URLSession(configuration: config)
    }()

    static func fetch(_ url: URL) async -> (poster: URL?, overview: String?) {
        guard let (data, response) = try? await session.data(from: url),
              (response as? HTTPURLResponse)?.statusCode == 200
        else { return (nil, nil) }
        // The tags are in the head. There's no need to read the whole page.
        return parse(String(decoding: data.prefix(300_000), as: UTF8.self), base: url)
    }

    static func parse(_ html: String, base: URL) -> (poster: URL?, overview: String?) {
        let image = metaContent(in: html, property: "og:image")
        var poster = image.flatMap { URL(string: decode($0), relativeTo: base)?.absoluteURL }
        if let path = poster?.path.lowercased(), path.contains("logo") || path.hasSuffix(".svg") { poster = nil }
        return (poster, metaContent(in: html, property: "og:description").map(decode))
    }

    private static func metaContent(in html: String, property: String) -> String? {
        let name = NSRegularExpression.escapedPattern(for: property)
        let patterns = [
            #"<meta[^>]+property=["']\#(name)["'][^>]*content=["']([^"']+)["']"#,
            #"<meta[^>]+content=["']([^"']+)["'][^>]*property=["']\#(name)["']"#,
        ]
        for pattern in patterns {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
                  let match = regex.firstMatch(in: html, range: NSRange(html.startIndex..., in: html)),
                  let range = Range(match.range(at: 1), in: html)
            else { continue }
            return String(html[range])
        }
        return nil
    }

    private static func decode(_ text: String) -> String {
        text.replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
    }
}

/// Fills in posters and details for titles in the background.
final class MetadataService {
    private unowned let library: LibraryStore
    private let enabled: () -> Bool
    private var inFlight = Set<Int64>()
    private var queue: [(id: Int64, altName: String?)] = []
    private var isDraining = false
    private var episodeCache: [String: [EpisodeInfo]] = [:]

    init(library: LibraryStore, enabled: @escaping () -> Bool) {
        self.library = library
        self.enabled = enabled
    }

    /// Looks up a title that was recognised from a page. Lookups run one at a time, so that
    /// importing hundreds of films doesn't hammer the services. What you're watching goes first.
    func enrich(titleID: Int64, altName: String? = nil, inBackground: Bool = false) {
        guard enabled(), !inFlight.contains(titleID), library.titles[titleID]?.metadataChecked == false else { return }
        inFlight.insert(titleID)
        if inBackground {
            queue.append((titleID, altName))
        } else {
            queue.insert((titleID, altName), at: 0)
        }
        drainQueue()
    }

    private func drainQueue() {
        guard !isDraining else { return }
        isDraining = true
        Task {
            while !queue.isEmpty {
                let (id, altName) = queue.removeFirst()
                await lookUp(titleID: id, altName: altName)
                inFlight.remove(id)
                try? await Task.sleep(for: .milliseconds(120))
            }
            isDraining = false
        }
    }

    private func lookUp(titleID: Int64, altName: String?) async {
        guard let title = library.titles[titleID], !title.metadataChecked else { return }
        let queries = [altName, title.name].compactMap { $0 }
        var match: MetadataHit?
        for query in queries {
            let hits = await MetadataClient.search(query)
            if let found = MetadataClient.bestMatch(hits, name: query, year: title.year, kind: title.kind) {
                match = found
                break
            }
        }
        await apply(match, to: titleID)
        if match == nil { await fillFromPage(titleID: titleID) }
    }

    /// Not in the catalogue, so ask the page it was watched on.
    private func fillFromPage(titleID: Int64) async {
        guard let title = library.titles[titleID], title.posterURL == nil,
              let url = library.latestProgress(titleID: titleID)?.url
        else { return }
        let preview = await PagePreview.fetch(url)
        guard var fresh = library.titles[titleID], preview.poster != nil || preview.overview != nil else { return }
        fresh.posterURL = preview.poster ?? fresh.posterURL
        fresh.overview = fresh.overview ?? preview.overview
        library.update(fresh)
    }

    /// Applies an explicit choice, when someone corrects a title by hand.
    func apply(hit: MetadataHit, to titleID: Int64) {
        guard var title = library.titles[titleID] else { return }
        title.metadataChecked = false
        library.update(title)
        Task { await apply(hit, to: titleID) }
    }

    private func apply(_ match: MetadataHit?, to titleID: Int64) async {
        guard var title = library.titles[titleID] else { return }
        title.metadataChecked = true
        guard let match else {
            library.update(title)
            return
        }

        // The same film may already be here under another name, say the Ukrainian one.
        if let other = library.titles.values.first(where: { $0.imdbID == match.id && $0.id != titleID }) {
            library.merge(from: titleID, into: other.id)
            return
        }

        let detail = await MetadataClient.detail(imdbID: match.id, kind: match.kind)
        guard var fresh = library.titles[titleID] else { return }
        fresh.metadataChecked = true
        fresh.imdbID = match.id
        fresh.name = match.name
        fresh.normName = TitleParser.normalize(match.name)
        fresh.year = match.year ?? fresh.year
        fresh.posterURL = match.posterURL ?? detail?.posterURL ?? fresh.posterURL
        fresh.backdropURL = detail?.backdropURL ?? fresh.backdropURL
        fresh.overview = detail?.overview ?? fresh.overview
        fresh.genres = detail?.genres ?? fresh.genres
        fresh.runtimeMinutes = detail?.runtimeMinutes ?? fresh.runtimeMinutes
        fresh.kind = fresh.genres.contains("Animation") ? .cartoon : match.kind
        library.update(fresh)
        if let episodes = detail?.episodes, !episodes.isEmpty { episodeCache[match.id] = episodes }
    }

    /// Episode lists set by the test commands, by title, which win over the real services.
    var testEpisodes: [Int64: [EpisodeInfo]] = [:]

    /// `fresh` skips the copy kept from earlier, to see episodes that came out since.
    func episodes(for title: Title, fresh: Bool = false) async -> [EpisodeInfo] {
        if let test = testEpisodes[title.id] { return test }
        guard enabled(), let imdbID = title.imdbID else { return [] }
        if !fresh, let cached = episodeCache[imdbID] { return cached }
        guard title.kind == .series || title.kind == .cartoon else { return [] }
        let detail = await MetadataClient.detail(imdbID: imdbID, kind: .series)
        let episodes = detail?.episodes ?? []
        episodeCache[imdbID] = episodes
        return episodes
    }
}
