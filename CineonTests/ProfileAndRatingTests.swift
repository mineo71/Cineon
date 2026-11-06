import XCTest
@testable import Cineon

@MainActor
final class ProfileAndRatingTests: XCTestCase {
    private func title(
        _ id: Int64, _ name: String, status: TitleStatus = .watched, kind: TitleKind = .film, year: Int? = 2010,
        genres: [String] = [], halves: Int? = nil, runtime: Int? = nil, added: Date = .now
    ) -> Title {
        Title(
            id: id, name: name, normName: TitleParser.normalize(name), year: year, kind: kind, status: status,
            imdbID: nil, posterURL: nil, backdropURL: nil, overview: nil, genres: genres, runtimeMinutes: runtime,
            ratingHalves: halves, notes: nil, addedAt: added, updatedAt: added, finishedAt: nil, lastWatchedAt: nil,
            metadataChecked: true
        )
    }

    // MARK: Ratings

    func testRatingTextShowsHalves() {
        XCTAssertEqual(Rating.text(15), "7.5")
        XCTAssertEqual(Rating.text(16), "8")
        XCTAssertEqual(Rating.text(20), "10")
        XCTAssertEqual(Rating.text(1), "0.5")
        XCTAssertEqual(Rating.clamp(0), 1)
        XCTAssertEqual(Rating.clamp(99), 20)
    }

    func testStarsFillByHalves() {
        // 7.5: seven full stars, the eighth half, the rest empty.
        XCTAssertEqual(StarRow.fill(star: 7, halves: 15), 1)
        XCTAssertEqual(StarRow.fill(star: 8, halves: 15), 0.5)
        XCTAssertEqual(StarRow.fill(star: 9, halves: 15), 0)
        XCTAssertEqual(StarRow.fill(star: 10, halves: 20), 1)
    }

    func testClickingTheLeftHalfOfAStarGivesAHalf() {
        let width: CGFloat = 20
        XCTAssertEqual(StarRatingControl.halves(at: 2, starWidth: width), 1)
        XCTAssertEqual(StarRatingControl.halves(at: 12, starWidth: width), 2)
        XCTAssertEqual(StarRatingControl.halves(at: 7 * width + 5, starWidth: width), 15)
        XCTAssertEqual(StarRatingControl.halves(at: 500, starWidth: width), 20)
    }

    func testFiveStarRatingsBecomeTenWhenUpgrading() throws {
        let path = NSTemporaryDirectory() + "cineon-test-\(UUID().uuidString).sqlite"
        defer { try? FileManager.default.removeItem(atPath: path) }
        let older = try Database(path: path)
        // Back to how version 3 kept things: five stars, no dates, no alerts.
        try older.sql.exec("""
        DROP TABLE episode_alerts;
        CREATE TABLE t AS SELECT * FROM titles;
        """)
        var five = title(0, "Heat", halves: nil)
        five.ratingHalves = nil
        let id = try older.insertTitle(five)
        try older.sql.exec("UPDATE titles SET rating=4 WHERE id=\(id)")
        try older.sql.exec("""
        DROP TABLE t;
        ALTER TABLE titles DROP COLUMN rated_at;
        ALTER TABLE titles DROP COLUMN status_at;
        PRAGMA user_version=3
        """)
        older.sql.close()

        let upgraded = try Database(path: path)
        XCTAssertEqual(upgraded.sql.userVersion, 4)
        let loaded = try XCTUnwrap(upgraded.allTitles().first { $0.id == id })
        XCTAssertEqual(loaded.ratingHalves, 16, "4 of 5 stars is 8 of 10")
        XCTAssertNotNil(loaded.ratedAt)
        XCTAssertEqual(try upgraded.episodeAlerts().count, 0)
    }

    func testEpisodeAlertsRoundTrip() throws {
        let path = NSTemporaryDirectory() + "cineon-test-\(UUID().uuidString).sqlite"
        defer { try? FileManager.default.removeItem(atPath: path) }
        let db = try Database(path: path)
        let id = try db.insertTitle(title(0, "The Bear", status: .watching, kind: .series))
        let alert = EpisodeAlert(
            titleID: id, latest: EpisodeRef(season: 3, episode: 2), checkedAt: .now,
            newest: EpisodeRef(season: 3, episode: 2), newCount: 2, newAt: .now
        )
        try db.saveEpisodeAlert(alert)
        let loaded = try XCTUnwrap(db.episodeAlerts().first)
        XCTAssertEqual(loaded.latest, alert.latest)
        XCTAssertEqual(loaded.newest, alert.newest)
        XCTAssertEqual(loaded.newCount, 2)
    }

    // MARK: Library filters

    func testFiltersAndSorts() {
        let titles = [
            title(1, "Alien", year: 1979, genres: ["Horror", "Sci-Fi"], halves: 18, runtime: 117),
            title(2, "Blade Runner", year: 1982, genres: ["Science Fiction"], halves: 15, runtime: 117),
            title(3, "Clueless", year: 1995, genres: ["Comedy"], halves: nil, runtime: 97),
            title(4, "Dune", status: .backlog, year: 2021, genres: ["Sci-Fi"], halves: nil, runtime: 155),
            title(5, "Euphoria", status: .watching, kind: .series, year: 2019, genres: ["Drama"], halves: 12),
        ]
        var query = LibraryQuery()
        query.genres = ["Sci-Fi"]
        XCTAssertEqual(query.apply(to: titles).map(\.id).sorted(), [1, 2, 4], "Science Fiction counts as Sci-Fi")

        query = LibraryQuery()
        query.rating = .atLeast(7)
        query.sort = .ratingHigh
        XCTAssertEqual(query.apply(to: titles).map(\.id), [1, 2])

        query = LibraryQuery()
        query.rating = .unrated
        query.list = .watched
        XCTAssertEqual(query.apply(to: titles).map(\.id), [3])

        query = LibraryQuery()
        query.decade = 1980
        XCTAssertEqual(query.apply(to: titles).map(\.id), [2])

        query = LibraryQuery()
        query.kind = .series
        XCTAssertEqual(query.apply(to: titles).map(\.id), [5])

        query = LibraryQuery()
        query.onThisMac = true
        XCTAssertEqual(query.apply(to: titles, downloaded: [3]).map(\.id), [3])

        query = LibraryQuery()
        query.sort = .ratingLow
        XCTAssertEqual(query.apply(to: titles).map(\.id), [5, 2, 1, 3, 4], "lowest first, unrated last by name")

        query = LibraryQuery()
        query.sort = .oldest
        XCTAssertEqual(query.apply(to: titles).map(\.id).first, 1)
        query.text = "blade"
        XCTAssertEqual(query.apply(to: titles).map(\.id), [2])
        XCTAssertTrue(query.hasFilters)
    }

    // MARK: Profile

    func testProfileStatsFromALibrary() {
        let calendar = Calendar(identifier: .gregorian)
        let now = calendar.date(from: DateComponents(year: 2026, month: 11, day: 5, hour: 22))!
        let titles = [
            title(1, "Alien", genres: ["Horror", "Sci-Fi"], halves: 18, runtime: 117),
            title(2, "Heat", genres: ["Crime", "Drama"], halves: 16, runtime: 170),
            title(3, "Saw", genres: ["Horror"], halves: 10),
            title(4, "Lost", status: .watching, kind: .series, year: 2004, genres: ["Drama", "Mystery"]),
        ]
        func session(_ titleID: Int64, daysAgo: Int, hour: Int, seconds: Double) -> WatchSession {
            let day = calendar.date(byAdding: .day, value: -daysAgo, to: calendar.startOfDay(for: now))!
            let start = calendar.date(byAdding: .hour, value: hour, to: day)!
            return WatchSession(
                id: 0, titleID: titleID, ref: .none, episodeName: nil, url: nil, host: "x", startedAt: start,
                endedAt: start.addingTimeInterval(seconds), watchedSeconds: seconds, startPosition: 0, endPosition: seconds,
                duration: seconds, finished: true
            )
        }
        let sessions = [
            session(4, daysAgo: 0, hour: 21, seconds: 3600),
            session(4, daysAgo: 1, hour: 21, seconds: 1800),
            session(4, daysAgo: 2, hour: 20, seconds: 2700),
            session(1, daysAgo: 10, hour: 23, seconds: 7000),
        ]
        let progress = (1...6).map { episode in
            WatchProgress(
                titleID: 4, ref: EpisodeRef(season: 1, episode: episode), urlKey: "k\(episode)", url: nil, host: "x",
                position: 2500, duration: 2600, finished: true, updatedAt: now
            )
        }
        let stats = ProfileStats.compute(titles: titles, sessions: sessions, progress: progress, now: now, calendar: calendar)
        XCTAssertEqual(stats.filmsWatched, 3)
        XCTAssertEqual(stats.episodesFinished, 6)
        XCTAssertEqual(stats.rated, 3)
        XCTAssertEqual(stats.averageRating ?? 0, (9 + 8 + 5) / 3, accuracy: 0.001)
        XCTAssertEqual(stats.ratingCounts[8], 1, "a 9 lands in the ninth bucket")
        XCTAssertEqual(stats.currentStreak, 3)
        XCTAssertEqual(stats.longestStreak, 3)
        XCTAssertEqual(stats.trackedHours, (3600 + 1800 + 2700 + 7000) / 3600, accuracy: 0.001)
        // Heat and Saw were never timed, so their runtimes count, Saw with the usual length.
        XCTAssertEqual(stats.estimatedHours, stats.trackedHours + 170.0 / 60 + 110.0 / 60, accuracy: 0.001)
        XCTAssertEqual(stats.favouriteGenre, "Horror")
        XCTAssertEqual(stats.genres.map(\.weight).reduce(0, +), 1, accuracy: 0.0001)
        XCTAssertEqual(stats.busiestHour, 21)
        XCTAssertEqual(stats.topTitles.first?.id, 4, "Lost had the most time, over three evenings")
        XCTAssertEqual(stats.daysSinceLastWatch(now: now, calendar: calendar), 0)
        XCTAssertEqual(stats.petTraits(seed: "abc", now: now).titlesFinished, stats.titlesFinished)
    }

    func testEmptyLibraryHasCalmStats() {
        let stats = ProfileStats.compute(titles: [], sessions: [], progress: [])
        XCTAssertNil(stats.favouriteGenre)
        XCTAssertNil(stats.averageRating)
        XCTAssertNil(stats.busiestWeekday)
        XCTAssertNil(stats.daysSinceLastWatch())
        XCTAssertEqual(stats.currentStreak, 0)
    }

    // MARK: Cloud keys

    func testCloudKnowsFilmsByIMDbOrByNameAndYear() {
        var film = title(1, "Heat", year: 1995)
        XCTAssertEqual(CloudLibrary.keys(for: film), ["n:heat|1995"])
        film.imdbID = "tt0113277"
        XCTAssertEqual(CloudLibrary.keys(for: film), ["tt0113277", "n:heat|1995"])
        XCTAssertEqual(CloudLibrary.key(imdbID: nil, normName: "x", year: nil), "n:x|")
    }

    // MARK: Sleep timer

    func testSleepTimerCountsDown() {
        let timer = SleepTimerState(mode: .minutes(30), deadline: Date.now.addingTimeInterval(90))
        XCTAssertEqual(timer.remaining(player: nil) ?? 0, 90, accuracy: 1)
        XCTAssertNil(SleepTimerState(mode: .endOfItem).remaining(player: nil))
        XCTAssertEqual(SleepTimerMode.minutes(60).label, "1 h")
        XCTAssertEqual(SleepTimerMode.minutes(45).label, "45 min")
    }
}
