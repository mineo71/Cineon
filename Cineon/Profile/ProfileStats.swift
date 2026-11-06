import Foundation

/// Everything the profile page says about someone's watching, worked out from their library.
/// Pure, so it can be tested and computed off the main thread.
nonisolated struct ProfileStats: Sendable, Equatable {
    struct TopTitle: Sendable, Equatable, Identifiable {
        var id: Int64
        var name: String
        var posterURL: URL?
        var hours: Double
        var sessions: Int
    }

    struct BingeDay: Sendable, Equatable {
        var day: Date
        var seconds: Double
        var sessions: Int
    }

    /// Time Cineon saw being watched.
    var trackedHours = 0.0
    /// Tracked time plus the runtimes of things finished before Cineon kept count.
    var estimatedHours = 0.0
    var thisYearHours = 0.0
    var filmsWatched = 0
    var seriesFinished = 0
    var episodesFinished = 0
    var inLibrary = 0
    var backlog = 0
    var watching = 0
    var rated = 0
    var averageRating: Double?
    /// How many titles have each whole rating, 1 to 10. Halves round up.
    var ratingCounts = [Int](repeating: 0, count: 10)
    /// Share of watching per genre, adding up to 1, biggest first.
    var genres: [GenreWeight] = []
    var decades: [(decade: Int, count: Int)] = []
    var topTitles: [TopTitle] = []
    var currentStreak = 0
    var longestStreak = 0
    var binge: BingeDay?
    /// Sessions by weekday (0 is Monday) and hour.
    var heatmap = [[Int]](repeating: [Int](repeating: 0, count: 24), count: 7)
    var sessions = 0
    var firstWatch: Date?
    var lastWatch: Date?
    var moments = 0
    var adsBlocked = 0
    var downloads = 0

    var favouriteGenre: String? { genres.first?.name }
    var favouriteDecade: Int? { decades.max { $0.count < $1.count }?.decade }
    var titlesFinished: Int { filmsWatched + seriesFinished + episodesFinished / 4 }

    var busiestWeekday: Int? {
        let totals = heatmap.map { $0.reduce(0, +) }
        guard let best = totals.max(), best > 0 else { return nil }
        return totals.firstIndex(of: best)
    }

    var busiestHour: Int? {
        let totals = (0..<24).map { hour in heatmap.reduce(0) { $0 + $1[hour] } }
        guard let best = totals.max(), best > 0 else { return nil }
        return totals.firstIndex(of: best)
    }

    func daysSinceLastWatch(now: Date = .now, calendar: Calendar = .current) -> Int? {
        guard let lastWatch else { return nil }
        return calendar.dateComponents([.day], from: calendar.startOfDay(for: lastWatch), to: calendar.startOfDay(for: now)).day
    }

    func petTraits(seed: String, now: Date = .now) -> PetTraits {
        PetTraits(
            genres: genres, hoursWatched: estimatedHours, titlesFinished: titlesFinished,
            daysSinceLastWatch: daysSinceLastWatch(now: now), seed: seed
        )
    }

    static func == (a: ProfileStats, b: ProfileStats) -> Bool {
        a.estimatedHours == b.estimatedHours && a.sessions == b.sessions && a.rated == b.rated
            && a.genres == b.genres && a.inLibrary == b.inLibrary && a.lastWatch == b.lastWatch
    }

    // MARK: Working it out

    static func compute(
        titles: [Title], sessions: [WatchSession], progress: [WatchProgress],
        moments: Int = 0, adsBlocked: Int = 0, downloads: Int = 0,
        now: Date = .now, calendar: Calendar = .current
    ) -> ProfileStats {
        var stats = ProfileStats()
        stats.moments = moments
        stats.adsBlocked = adsBlocked
        stats.downloads = downloads
        stats.inLibrary = titles.count
        stats.sessions = sessions.count

        let byID = Dictionary(uniqueKeysWithValues: titles.map { ($0.id, $0) })
        var secondsByTitle: [Int64: Double] = [:]
        var sessionsByTitle: [Int64: Int] = [:]
        let year = calendar.component(.year, from: now)
        var days: [Date: (seconds: Double, count: Int)] = [:]

        for session in sessions {
            secondsByTitle[session.titleID, default: 0] += session.watchedSeconds
            sessionsByTitle[session.titleID, default: 0] += 1
            stats.trackedHours += session.watchedSeconds / 3600
            if calendar.component(.year, from: session.startedAt) == year { stats.thisYearHours += session.watchedSeconds / 3600 }
            let day = calendar.startOfDay(for: session.startedAt)
            days[day, default: (0, 0)].seconds += session.watchedSeconds
            days[day, default: (0, 0)].count += 1
            // Monday first.
            let weekday = (calendar.component(.weekday, from: session.startedAt) + 5) % 7
            stats.heatmap[weekday][calendar.component(.hour, from: session.startedAt)] += 1
            stats.firstWatch = min(stats.firstWatch ?? session.startedAt, session.startedAt)
            stats.lastWatch = max(stats.lastWatch ?? session.endedAt, session.endedAt)
        }
        for title in titles {
            if let watched = title.lastWatchedAt { stats.lastWatch = max(stats.lastWatch ?? watched, watched) }
        }

        // Finished episodes, and runtimes for what was finished without Cineon timing it.
        var finishedEpisodes: [Int64: Int] = [:]
        for entry in progress where entry.finished && entry.ref.isEpisode {
            stats.episodesFinished += 1
            finishedEpisodes[entry.titleID, default: 0] += 1
        }
        stats.estimatedHours = stats.trackedHours
        for title in titles {
            switch title.status {
            case .watched:
                if title.kind == .series { stats.seriesFinished += 1 } else { stats.filmsWatched += 1 }
            case .backlog: stats.backlog += 1
            case .watching: stats.watching += 1
            case .none: break
            }
            let tracked = (secondsByTitle[title.id] ?? 0) / 3600
            guard tracked < 0.25 else { continue }
            if title.status == .watched, title.kind != .series {
                stats.estimatedHours += Double(title.runtimeMinutes ?? 110) / 60
            } else if let episodes = finishedEpisodes[title.id] {
                stats.estimatedHours += Double(episodes) * Double(title.runtimeMinutes ?? 45) / 60
            }
        }

        // Ratings.
        let ratings = titles.compactMap(\.rating)
        stats.rated = ratings.count
        if !ratings.isEmpty { stats.averageRating = ratings.reduce(0, +) / Double(ratings.count) }
        for rating in ratings { stats.ratingCounts[min(9, max(0, Int(rating.rounded(.up)) - 1))] += 1 }

        // Genres: what you watch, finish and rate highly counts most.
        var genreScore: [String: Double] = [:]
        for title in titles where !title.genres.isEmpty {
            var weight: Double
            switch title.status {
            case .watched: weight = 2
            case .watching: weight = 1.5
            case .backlog: weight = 0.35
            case .none: weight = sessionsByTitle[title.id] == nil ? 0.2 : 0.8
            }
            weight += min(6, (secondsByTitle[title.id] ?? 0) / 3600) * 0.4
            if let rating = title.rating { weight *= 0.6 + rating / 12.5 }
            let share = weight / Double(title.genres.count)
            for genre in title.genres { genreScore[Self.canonicalGenre(genre), default: 0] += share }
        }
        let total = genreScore.values.reduce(0, +)
        if total > 0 {
            stats.genres = genreScore.map { GenreWeight(name: $0.key, weight: $0.value / total) }
                .sorted { $0.weight == $1.weight ? $0.name < $1.name : $0.weight > $1.weight }
        }

        // Decades of what you've watched.
        var decades: [Int: Int] = [:]
        for title in titles where title.status == .watched || title.status == .watching || sessionsByTitle[title.id] != nil {
            if let year = title.year, year > 1880 { decades[year / 10 * 10, default: 0] += 1 }
        }
        stats.decades = decades.map { ($0.key, $0.value) }.sorted { $0.decade < $1.decade }

        // Top titles by time, then by visits.
        stats.topTitles = byID.values
            .filter { sessionsByTitle[$0.id] != nil }
            .map { TopTitle(id: $0.id, name: $0.name, posterURL: $0.posterURL, hours: (secondsByTitle[$0.id] ?? 0) / 3600, sessions: sessionsByTitle[$0.id] ?? 0) }
            .sorted { $0.hours == $1.hours ? $0.sessions > $1.sessions : $0.hours > $1.hours }
            .prefix(5).map { $0 }

        // Streaks of days with any watching.
        let sortedDays = days.keys.sorted()
        var run = 0
        var previous: Date?
        for day in sortedDays {
            if let previous, calendar.date(byAdding: .day, value: 1, to: previous) == day { run += 1 } else { run = 1 }
            stats.longestStreak = max(stats.longestStreak, run)
            previous = day
        }
        let today = calendar.startOfDay(for: now)
        if let last = sortedDays.last, let yesterday = calendar.date(byAdding: .day, value: -1, to: today), last >= yesterday {
            stats.currentStreak = run
        }

        // The biggest day: most time, or most sessions when nothing was timed.
        if let best = days.max(by: { ($0.value.seconds, $0.value.count) < ($1.value.seconds, $1.value.count) }) {
            stats.binge = BingeDay(day: best.key, seconds: best.value.seconds, sessions: best.value.count)
        }
        return stats
    }

    /// One name per genre, whatever the source called it.
    static func canonicalGenre(_ raw: String) -> String {
        let lower = raw.lowercased().trimmingCharacters(in: .whitespaces)
        switch lower {
        case "science fiction", "sci-fi", "scifi", "science-fiction": return "Sci-Fi"
        case "film-noir", "film noir": return "Film-Noir"
        case "tv movie": return "TV Movie"
        default: return raw.prefix(1).uppercased() + raw.dropFirst()
        }
    }
}
