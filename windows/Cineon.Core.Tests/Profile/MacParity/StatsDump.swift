// Dumps the Mac's ProfileStats for generated libraries in a few time zones, so the Windows port can be
// checked against it. StatsDump.cs builds the same text in C#; the expected hashes in
// ProfileStatsMacParityTests come from this program.
//
// Run on a Mac, from the repo root:
//   swiftc -O -swift-version 6 -default-isolation MainActor -parse-as-library Cineon/Core/Models.swift Cineon/Profile/ProfileStats.swift \
//     Cineon/Profile/PixelPet.swift windows/Cineon.Core.Tests/Profile/MacParity/StatsDump.swift -o /tmp/statsdump
//   /tmp/statsdump /tmp/statsdump-out

import Foundation

struct StatsMix {
    var state: UInt64
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }

    mutating func below(_ n: Int) -> Int { Int(next() % UInt64(n)) }
}

let statsGenres = [
    "Horror", "Sci-Fi", "Science Fiction", "sci-fi", "science-fiction", "Drama", " Drama", "drama", "Crime",
    "film noir", "Film-Noir", "TV Movie", "tv movie", "Comedy", "comedy", "Animation", "Documentary", "War",
]

func f6(_ v: Double) -> String { String(format: "%.6f", v) }

func library(_ rng: inout StatsMix) -> String {
    let base = 815_000_000.0
    let count = rng.below(41)
    var titles: [Title] = []
    for i in 0..<count {
        let id = Int64(i + 1)
        let yearRoll = rng.below(10)
        let year = rng.below(180) + 1850
        let series = rng.below(4) == 0
        let status = [TitleStatus.none, .backlog, .watching, .watched][rng.below(4)]
        let genreCount = rng.below(4)
        var genres: [String] = []
        for _ in 0..<genreCount { genres.append(statsGenres[rng.below(statsGenres.count)]) }
        let runtimeRoll = rng.below(5)
        let runtime = 20 + rng.below(180)
        let halvesRoll = rng.below(3)
        let halves = 1 + rng.below(20)
        let watchedRoll = rng.below(3)
        let watched = base + Double(rng.below(400 * 86400))
        titles.append(Title(
            id: id, name: "T\(id)", normName: "t\(id)", year: yearRoll == 0 ? nil : year, kind: series ? .series : .film,
            status: status, imdbID: nil, posterURL: nil, backdropURL: nil, overview: nil, genres: genres,
            runtimeMinutes: runtimeRoll == 0 ? nil : runtime, ratingHalves: halvesRoll == 0 ? nil : halves, notes: nil,
            addedAt: Date(timeIntervalSinceReferenceDate: base), updatedAt: Date(timeIntervalSinceReferenceDate: base),
            finishedAt: nil, lastWatchedAt: watchedRoll == 0 ? nil : Date(timeIntervalSinceReferenceDate: watched),
            metadataChecked: true
        ))
    }
    var sessions: [WatchSession] = []
    for _ in 0..<rng.below(81) {
        let titleID = Int64(1 + rng.below(count + 2))
        let start = base + Double(rng.below(400 * 86400))
        // The thousandths keep every title's and day's total unique: the Mac breaks ties by dictionary order.
        let seconds = Double(rng.below(4 * 3600)) + Double(sessions.count) * 0.001
        let extra = Double(rng.below(600))
        sessions.append(WatchSession(
            id: 0, titleID: titleID, ref: .none, episodeName: nil, url: nil, host: "x",
            startedAt: Date(timeIntervalSinceReferenceDate: start),
            endedAt: Date(timeIntervalSinceReferenceDate: start + seconds + extra), watchedSeconds: seconds,
            startPosition: 0, endPosition: seconds, duration: seconds, finished: true
        ))
    }
    var progress: [WatchProgress] = []
    for _ in 0..<rng.below(61) {
        let titleID = Int64(1 + rng.below(count + 2))
        let film = rng.below(3) == 0
        let season = rng.below(3)
        let episode = rng.below(10)
        let finished = rng.below(2) == 0
        progress.append(WatchProgress(
            titleID: titleID, ref: film ? .none : EpisodeRef(season: season, episode: episode), urlKey: "k", url: nil,
            host: "x", position: 0, duration: 0, finished: finished,
            updatedAt: Date(timeIntervalSinceReferenceDate: base)
        ))
    }
    let moments = rng.below(100), ads = rng.below(100), downloads = rng.below(100)
    let now = base + Double(400 * 86400 + rng.below(86400))
    return describe(titles: titles, sessions: sessions, progress: progress, moments: moments, ads: ads,
                    downloads: downloads, now: now)
}

var zoneName = "UTC"

func describe(titles: [Title], sessions: [WatchSession], progress: [WatchProgress], moments: Int, ads: Int,
              downloads: Int, now: Double) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: zoneName)!
    let date = Date(timeIntervalSinceReferenceDate: now)
    let s = ProfileStats.compute(titles: titles, sessions: sessions, progress: progress, moments: moments,
                                 adsBlocked: ads, downloads: downloads, now: date, calendar: calendar)
    var out = "hours \(f6(s.trackedHours)) \(f6(s.estimatedHours)) \(f6(s.thisYearHours))"
    out += " counts \(s.filmsWatched) \(s.seriesFinished) \(s.episodesFinished) \(s.inLibrary) \(s.backlog) \(s.watching)"
    out += " \(s.rated) \(s.averageRating.map(f6) ?? "-") \(s.ratingCounts.map(String.init).joined(separator: ","))"
    // Shares divide by a total the Mac sums in dictionary order, so the last bit varies from run to run;
    // the nudge keeps exact halves (55/128) away from the rounding midpoint.
    out += " | genres " + s.genres.map { "\($0.name):\(f6($0.weight + 1e-12))" }.joined(separator: ",")
    out += " | decades " + s.decades.map { "\($0.decade):\($0.count)" }.joined(separator: ",")
    out += " | top " + s.topTitles.map { "\($0.id):\(f6($0.hours)):\($0.sessions)" }.joined(separator: ",")
    out += " | streak \(s.currentStreak) \(s.longestStreak)"
    if let binge = s.binge {
        let parts = calendar.dateComponents([.year, .month, .day], from: binge.day)
        out += " binge \(parts.year!)-\(parts.month!)-\(parts.day!) \(f6(binge.seconds)) \(binge.sessions)"
    } else {
        out += " binge -"
    }
    out += " | heat " + s.heatmap.map { $0.map(String.init).joined(separator: ",") }.joined(separator: ";")
    out += " | \(s.sessions) \(s.firstWatch.map { "\(Int($0.timeIntervalSinceReferenceDate))" } ?? "-")"
    out += " \(s.lastWatch.map { "\(Int($0.timeIntervalSinceReferenceDate))" } ?? "-")"
    out += " \(s.moments) \(s.adsBlocked) \(s.downloads)"
    out += " | fav \(s.favouriteGenre ?? "-") \(s.favouriteDecade.map(String.init) ?? "-") \(s.titlesFinished)"
    out += " \(s.busiestWeekday.map(String.init) ?? "-") \(s.busiestHour.map(String.init) ?? "-")"
    out += " \(s.daysSinceLastWatch(now: date, calendar: calendar).map(String.init) ?? "-")"
    // petTraits(seed:now:) counts days in Calendar.current; pass the dump's calendar instead.
    let traits = PetTraits(genres: s.genres, hoursWatched: s.estimatedHours, titlesFinished: s.titlesFinished,
                           daysSinceLastWatch: s.daysSinceLastWatch(now: date, calendar: calendar), seed: "S")
    out += " pet \(PixelPet.make(from: traits).code)"
    return out + "\n"
}

@main
struct StatsDump {
    static func main() {
        let dir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "statsdump"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        for zone in ["UTC", "Europe/Berlin", "America/Los_Angeles", "Asia/Kolkata", "Pacific/Chatham"] {
            zoneName = zone
            var rng = StatsMix(state: 7)
            var text = ""
            for _ in 0..<300 { text += library(&rng) }
            let name = "stats-" + zone.replacingOccurrences(of: "/", with: "-")
            try? text.write(toFile: dir + "/" + name + ".txt", atomically: true, encoding: .utf8)
            print(name, String(PixelPet.stableHash(text), radix: 16))
        }
    }
}
