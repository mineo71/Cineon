// Runs every case in corpus.jsonl through the Mac's parsing code and prints one line per case, so the
// Windows port can be checked against it. ParsingDump.cs prints the same lines in C#; the expected
// output in expected.txt comes from this program, and ParsingMacParityTests compares the two.
//
// Run on a Mac, from the repo root (the client part of Metadata.swift is copied with its private
// response types and helpers opened up, and ImportAnalyzer.brand comes from BrowserImport.swift):
//   S=/tmp/parsingdump; mkdir -p $S
//   sed -n '1,/^\/\/\/ Fills in posters/p' Cineon/Core/Metadata.swift | sed '$d' \
//     | sed 's/private struct /struct /; s/private static func /static func /' > $S/MetadataClient.swift
//   sed -n '/static func brand(_ domain: String)/,/^    }/p' Cineon/Core/BrowserImport.swift \
//     | sed '1s/^/nonisolated enum ImportAnalyzer {\n/; $s/$/\n}/' > $S/Brand.swift
//   swiftc -O -swift-version 6 -default-isolation MainActor -parse-as-library Cineon/Core/Models.swift \
//     Cineon/Core/TitleParser.swift Cineon/Core/RescueMatcher.swift Cineon/Core/EpisodeLinks.swift \
//     $S/MetadataClient.swift $S/Brand.swift windows/Cineon.Core.Tests/Parsing/MacParity/ParsingDump.swift -o $S/dump
//   $S/dump windows/Cineon.Core.Tests/Parsing/MacParity/corpus.jsonl > windows/Cineon.Core.Tests/Parsing/MacParity/expected.txt

import Foundation

func esc(_ s: String?) -> String {
    guard let s else { return "nil" }
    var out = "\""
    for u in s.unicodeScalars {
        switch u {
        case "\\": out += "\\\\"
        case "\"": out += "\\\""
        default:
            if u.value < 0x20 || (0x7f...0x9f).contains(u.value) || u.value == 0x2028 || u.value == 0x2029 {
                out += "\\u{\(String(u.value, radix: 16))}"
            } else {
                out.unicodeScalars.append(u)
            }
        }
    }
    return out + "\""
}

func num(_ i: Int?) -> String { i.map(String.init) ?? "nil" }
func dbl(_ d: Double) -> String { String(format: "%.6f", d) }
func ref(_ r: EpisodeRef?) -> String { r.map { "\($0.season):\($0.episode)" } ?? "nil" }
func url(_ u: URL?) -> String { esc(u?.absoluteString) }
func date(_ d: Date?) -> String { d.map { String(format: "%.3f", $0.timeIntervalSince1970) } ?? "nil" }

func str(_ o: [String: Any], _ key: String) -> String? { o[key] as? String }
func int(_ o: [String: Any], _ key: String) -> Int? { (o[key] as? NSNumber)?.intValue }

func parsed(_ p: ParsedTitle?) -> String {
    guard let p else { return "nil" }
    return [esc(p.name), esc(p.altName), num(p.year), ref(p.ref), esc(p.episodeName), p.kindHint.rawValue, url(p.posterURL),
            esc(p.overview), dbl(p.confidence)].joined(separator: " | ")
}

func match(_ m: RescueMatch?) -> String {
    guard let m else { return "nil" }
    return [url(m.link.url), dbl(m.score), String(m.yearConfirmed), String(m.isStrong)].joined(separator: " | ")
}

func line(_ o: [String: Any]) -> String {
    let t = o["t"] as! String
    switch t {
    case "parse":
        var meta = PageMeta()
        meta.url = str(o, "url") ?? ""
        meta.title = str(o, "title") ?? ""
        meta.ogSite = str(o, "site")
        meta.ogTitle = str(o, "og")
        meta.h1 = str(o, "h1")
        meta.twitterTitle = str(o, "tw")
        meta.ogType = str(o, "ogType")
        meta.ogImage = str(o, "ogImage")
        meta.ogDescription = str(o, "ogDescription")
        meta.ld = (o["ld"] as? [[String: Any]] ?? []).map {
            PageMeta.LinkedData(type: str($0, "type"), name: str($0, "name"), series: str($0, "series"), season: int($0, "season"),
                                episode: int($0, "episode"), year: int($0, "year"), image: str($0, "image"), description: str($0, "description"))
        }
        return parsed(TitleParser.parse(meta))
    case "clean":
        return parsed(TitleParser.clean(str(o, "text")!, siteTokens: Set(o["tokens"] as! [String])))
    case "ref":
        return ref(TitleParser.episodeRef(in: str(o, "text")!))
    case "kind":
        return TitleParser.kindHint(in: str(o, "text")!).rawValue
    case "tokens":
        let text = str(o, "text")!
        return RescueMatcher.tokens(text).map(esc).joined(separator: " ") + " | " + RescueMatcher.years(in: text).map(String.init).joined(separator: " ")
    case "score":
        let link = RescueLink(url: URL(string: str(o, "url")!)!, text: str(o, "text")!, context: str(o, "context")!)
        let m = RescueMatcher.score(link, names: o["names"] as! [String], year: int(o, "year"))
        return [dbl(m.score), String(m.yearConfirmed), String(m.isStrong)].joined(separator: " | ")
    case "best":
        let links = (o["links"] as! [[String: Any]]).map {
            RescueLink(url: URL(string: str($0, "url")!)!, text: str($0, "text")!, context: str($0, "context")!)
        }
        return match(RescueMatcher.best(links: links, names: o["names"] as! [String], year: int(o, "year"), pageURL: str(o, "page").flatMap(URL.init(string:))))
    case "brand":
        let host = str(o, "host")!
        return esc(ImportAnalyzer.brand(host)) + " | " + esc(SkipLearner.siteKey(host))
    case "mirrors":
        return RescueMatcher.mirrors(of: URL(string: str(o, "url")!)!, among: o["hosts"] as! [String]).map(url).joined(separator: " ")
    case "links":
        let current = o["current"] as! [Int]
        let target = o["target"] as! [Int]
        return url(EpisodeLinks.url(from: URL(string: str(o, "url")!)!, current: EpisodeRef(season: current[0], episode: current[1]),
                                    target: EpisodeRef(season: target[0], episode: target[1])))
    case "match":
        let hits = (o["hits"] as! [[String: Any]]).map {
            MetadataHit(id: str($0, "id")!, name: str($0, "name")!, year: int($0, "year"), kind: TitleKind(rawValue: str($0, "kind")!)!, rank: int($0, "rank"))
        }
        let best = MetadataClient.bestMatch(hits, name: str(o, "name")!, year: int(o, "year"), kind: TitleKind(rawValue: str(o, "kind")!)!)
        return esc(best?.id)
    case "poster":
        return url(MetadataClient.resizedPoster(str(o, "raw"), width: 500))
    case "searchurl":
        // The first lines of MetadataClient.search, which builds the address before going to the network.
        let cleaned = str(o, "query")!.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        guard cleaned.count >= 2,
              let encoded = cleaned.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)?.replacingOccurrences(of: "/", with: "%2F"),
              let address = URL(string: "https://v3.sg.media-imdb.com/suggestion/x/\(encoded).json")
        else { return "nil" }
        return url(address)
    case "search":
        // MetadataClient.search after the response arrives.
        guard let decoded = try? JSONDecoder().decode(MetadataClient.IMDbResponse.self, from: Data(str(o, "body")!.utf8)) else { return "[]" }
        let hits: [MetadataHit] = decoded.d.compactMap { item in
            guard item.id.hasPrefix("tt"), let name = item.l else { return nil }
            guard let kind = MetadataClient.kind(from: item.qid) else { return nil }
            return MetadataHit(id: item.id, name: name, year: item.y, kind: kind,
                               posterURL: item.i.flatMap { MetadataClient.resizedPoster($0.imageUrl, width: 500) }, subtitle: item.s, rank: item.rank)
        }
        return "[" + hits.map { [esc($0.id), esc($0.name), num($0.year), $0.kind.rawValue, url($0.posterURL), esc($0.subtitle), num($0.rank)].joined(separator: " | ") }
            .joined(separator: " ; ") + "]"
    case "detail":
        // MetadataClient.detail after the response arrives.
        guard let decoded = try? JSONDecoder().decode(MetadataClient.CinemetaResponse.self, from: Data(str(o, "body")!.utf8)),
              let meta = decoded.meta
        else { return "nil" }
        let detail = MetadataDetail(
            overview: meta.description,
            genres: meta.genres ?? [],
            runtimeMinutes: meta.runtime.flatMap(MetadataClient.parseRuntime),
            posterURL: meta.poster.flatMap(URL.init(string:)),
            backdropURL: meta.background.flatMap(URL.init(string:)),
            year: meta.releaseInfo.flatMap { Int($0.prefix(4)) },
            episodes: (meta.videos ?? []).compactMap(MetadataClient.makeEpisode)
                .filter { $0.season > 0 }
                .sorted { ($0.season, $0.episode) < ($1.season, $1.episode) }
        )
        let episodes = detail.episodes.map {
            [String($0.season), String($0.episode), esc($0.name), esc($0.overview), url($0.thumbnailURL), date($0.released)].joined(separator: " , ")
        }
        return [esc(detail.overview), detail.genres.map(esc).joined(separator: " "), num(detail.runtimeMinutes), url(detail.posterURL),
                url(detail.backdropURL), num(detail.year), "[" + episodes.joined(separator: " ; ") + "]"].joined(separator: " | ")
    case "date":
        return date(MetadataClient.parseDate(str(o, "text")!))
    case "url":
        // How Foundation reads an address, which everything above leans on.
        guard let u = URL(string: str(o, "text")!) else { return "nil" }
        return [esc(u.absoluteString), esc(u.scheme), esc(u.host), esc(u.path), esc(u.deletingPathExtension().lastPathComponent)]
            .joined(separator: " | ")
    case "preview":
        let preview = PagePreview.parse(str(o, "html")!, base: URL(string: str(o, "base")!)!)
        return url(preview.poster) + " | " + esc(preview.overview)
    default:
        fatalError("Unknown case \(t)")
    }
}

@main struct ParsingDump {
    static func main() throws {
        let path = CommandLine.arguments[1]
        let text = try String(contentsOfFile: path, encoding: .utf8)
        for (index, raw) in text.split(separator: "\n", omittingEmptySubsequences: true).enumerated() {
            let o = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as! [String: Any]
            print("\(index) \(o["t"] as! String): \(line(o))")
        }
    }
}
