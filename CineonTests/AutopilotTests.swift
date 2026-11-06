import XCTest
@testable import Cineon

final class EpisodeLinksTests: XCTestCase {
    private func next(_ address: String, _ season: Int, _ episode: Int, to target: (Int, Int)? = nil) -> String? {
        let current = EpisodeRef(season: season, episode: episode)
        let goal = target.map { EpisodeRef(season: $0.0, episode: $0.1) } ?? EpisodeRef(season: season, episode: episode + 1)
        return EpisodeLinks.url(from: URL(string: address)!, current: current, target: goal)?.absoluteString
    }

    func testRewritesTheShapesSitesUse() {
        XCTAssertEqual(next("https://a.example/serial/rozryv/2-sezon/4-seriya", 2, 4), "https://a.example/serial/rozryv/2-sezon/5-seriya")
        XCTAssertEqual(next("https://a.example/show-s02e04.html", 2, 4), "https://a.example/show-s02e05.html")
        XCTAssertEqual(next("https://a.example/show/S2E9", 2, 9), "https://a.example/show/S2E10")
        XCTAssertEqual(next("https://a.example/show/2x09", 2, 9), "https://a.example/show/2x10")
        XCTAssertEqual(next("https://a.example/tv/the-bear/season-2/episode-7", 2, 7), "https://a.example/tv/the-bear/season-2/episode-8")
        XCTAssertEqual(next("https://a.example/tv/the-bear/season/2/episode/7", 2, 7), "https://a.example/tv/the-bear/season/2/episode/8")
        XCTAssertEqual(next("https://a.example/watch?season=2&episode=7", 2, 7), "https://a.example/watch?season=2&episode=8")
        XCTAssertEqual(next("https://a.example/watch?s=2&e=7", 2, 7), "https://a.example/watch?s=2&e=8")
    }

    func testRewritesTheEpisodeInTheFragment() {
        XCTAssertEqual(
            next("https://rezka.example/series/drama/1-mentalist-2008.html#t:238-s:3-e:5", 3, 5),
            "https://rezka.example/series/drama/1-mentalist-2008.html#t:238-s:3-e:6"
        )
    }

    func testMovesToTheNextSeason() {
        XCTAssertEqual(
            next("https://a.example/serial/x/2-sezon/10-seriya", 2, 10, to: (3, 1)),
            "https://a.example/serial/x/3-sezon/1-seriya"
        )
        XCTAssertEqual(next("https://a.example/show-s02e10", 2, 10, to: (3, 1)), "https://a.example/show-s03e01")
    }

    func testAnEpisodeOnlyAddressStaysInItsSeason() {
        XCTAssertEqual(next("https://a.example/show/episode-7", 2, 7), "https://a.example/show/episode-8")
        XCTAssertNil(next("https://a.example/show/episode-7", 2, 7, to: (3, 1)))
    }

    func testLeavesAddressesThatDoNotNameThisEpisode() {
        XCTAssertNil(next("https://a.example/film/part-2-2021", 2, 4))
        XCTAssertNil(next("https://a.example/serial/x/2-sezon/9-seriya", 2, 4))
        XCTAssertNil(next("https://a.example/watch/abc123", 2, 4))
        XCTAssertNil(next("https://s2e4.example/film", 1, 1))
    }

    func testNextEpisodeFollowsThePublishedList() {
        let list = [
            EpisodeInfo(season: 1, episode: 1), EpisodeInfo(season: 1, episode: 2),
            EpisodeInfo(season: 2, episode: 1), EpisodeInfo(season: 2, episode: 2, released: .distantFuture),
        ]
        XCTAssertEqual(NextEpisode.candidates(after: EpisodeRef(season: 1, episode: 1), episodes: list), [EpisodeRef(season: 1, episode: 2)])
        XCTAssertEqual(NextEpisode.candidates(after: EpisodeRef(season: 1, episode: 2), episodes: list), [EpisodeRef(season: 2, episode: 1)])
        XCTAssertEqual(NextEpisode.candidates(after: EpisodeRef(season: 2, episode: 1), episodes: list), [], "Not out yet")
        XCTAssertEqual(NextEpisode.candidates(after: EpisodeRef(season: 2, episode: 2), episodes: list), [], "The last one")
    }

    func testWithoutAListNextEpisodeGuessesBoth() {
        XCTAssertEqual(
            NextEpisode.candidates(after: EpisodeRef(season: 2, episode: 4), episodes: []),
            [EpisodeRef(season: 2, episode: 5), EpisodeRef(season: 3, episode: 1)]
        )
    }
}

final class SkipLearnerTests: XCTestCase {
    func testAnIntroIsAMediumJumpNearTheStart() {
        XCTAssertTrue(SkipLearner.isIntro(from: 62, to: 152, duration: 2700))
        XCTAssertFalse(SkipLearner.isIntro(from: 62, to: 72, duration: 2700), "Ten seconds is just skipping ahead")
        XCTAssertFalse(SkipLearner.isIntro(from: 62, to: 900, duration: 2700), "Too far to be an intro")
        XCTAssertFalse(SkipLearner.isIntro(from: 1800, to: 1890, duration: 2700), "Too late to be an intro")
    }

    func testCreditsAreAShortStretchBeforeTheEnd() {
        XCTAssertTrue(SkipLearner.isCredits(remaining: 90, duration: 2700))
        XCTAssertFalse(SkipLearner.isCredits(remaining: 5, duration: 2700))
        XCTAssertFalse(SkipLearner.isCredits(remaining: 900, duration: 2700), "That's leaving early, not skipping credits")
    }

    func testRepeatedArrowPressesBecomeOneJump() {
        let start = Date.now
        var jump = SkipLearner.Jump(from: 60, to: 70, lastAt: start)
        for step in 1..<9 {
            let next = jump.extended(from: jump.to + 1, to: jump.to + 11, at: start.addingTimeInterval(Double(step)))
            jump = next!
        }
        XCTAssertEqual(jump.from, 60)
        XCTAssertGreaterThan(jump.to, 150)
    }

    func testAPauseOrAJumpBackStartsOver() {
        let start = Date.now
        let jump = SkipLearner.Jump(from: 60, to: 70, lastAt: start)
        XCTAssertNil(jump.extended(from: 70, to: 80, at: start.addingTimeInterval(20)))
        XCTAssertNil(jump.extended(from: 70, to: 40, at: start.addingTimeInterval(1)))
    }

    func testMirrorsShareRules() {
        XCTAssertEqual(SkipLearner.siteKey("hdrezka.ag"), SkipLearner.siteKey("rezka-ua.co"))
        XCTAssertNotEqual(SkipLearner.siteKey("hdrezka.ag"), SkipLearner.siteKey("uakino.me"))
        XCTAssertEqual(SkipLearner.siteKey("127.0.0.1"), "127.0.0.1")
    }
}

final class RescueMatcherTests: XCTestCase {
    private let page = URL(string: "https://site.example/search?q=dune")!

    private func link(_ path: String, _ text: String, context: String = "") -> RescueLink {
        RescueLink(url: URL(string: "https://site.example\(path)")!, text: text, context: context)
    }

    private func best(_ links: [RescueLink], name: String = "Dune: Part Two", year: Int? = 2024) -> RescueMatch? {
        RescueMatcher.best(links: links, names: [name], year: year, pageURL: page)
    }

    func testPicksTheRightFilmOverItsNeighbours() {
        let links = [
            link("/film/dune-1984", "Dune (1984)"),
            link("/film/dune-2021", "Dune (2021)"),
            link("/film/dune-part-two", "Dune: Part Two (2024)"),
            link("/film/dune-prophecy", "Dune: Prophecy (2024)"),
        ]
        let match = best(links)
        XCTAssertEqual(match?.link.url.path, "/film/dune-part-two")
        XCTAssertEqual(match?.isStrong, true)
    }

    func testAWrongYearIsNeverOpened() {
        XCTAssertNil(best([link("/film/1", "Dune (1984)")], name: "Dune", year: 2021))
    }

    func testASequelNumberCountsAgainst() {
        XCTAssertEqual(best([link("/film/2", "Dune 2 (2021)")], name: "Dune", year: 2021)?.isStrong ?? false, false)
    }

    func testMissingYearStaysASuggestion() {
        let match = best([link("/film/x", "Dune: Part Two")])
        XCTAssertNotNil(match)
        XCTAssertEqual(match?.isStrong, false)
    }

    func testYearBesideTheLinkConfirms() {
        XCTAssertEqual(best([link("/film/x", "Dune: Part Two", context: "Dune: Part Two 2024 Sci-Fi")])?.isStrong, true)
    }

    func testTranslatedTitlesMatchEitherName() {
        XCTAssertEqual(best([link("/film/x", "Дюна: Частина друга / Dune: Part Two (2024)")])?.isStrong, true)
        XCTAssertEqual(
            RescueMatcher.best(links: [link("/film/x", "Дюна: Частина друга (2024)")], names: ["Dune: Part Two", "Дюна: Частина друга"], year: 2024, pageURL: page)?.isStrong,
            true
        )
    }

    func testPageFurnitureInLinkTextIsIgnored() {
        XCTAssertEqual(best([link("/film/x", "Смотреть Dune: Part Two онлайн бесплатно (2024)")])?.isStrong, true)
        XCTAssertEqual(best([link("/film/x", "Watch Dune: Part Two Full Movie Online Free (2024)")])?.isStrong, true)
    }

    func testNamesCanContainFurnitureWords() {
        XCTAssertEqual(best([link("/f/1", "Vanishing Film (2020)")], name: "Vanishing Film", year: 2020)?.isStrong, true)
        XCTAssertEqual(best([link("/f/2", "Watch The Lego Movie Online Free (2014)")], name: "The Lego Movie", year: 2014)?.isStrong, true)
        XCTAssertNil(best([link("/f/3", "Scary Stories (2000)")], name: "Scary Movie", year: 2000), "Part of a name isn't the name")
    }

    func testTrailersAndReviewsAreNotTheFilm() {
        XCTAssertNil(best([link("/v/1", "Dune: Part Two | Official Trailer (2024)")]))
        XCTAssertNil(best([link("/v/2", "Dune: Part Two review (2024)")]))
        XCTAssertNil(best([link("/v/3", "Дюна: Частина друга трейлер (2024)")], name: "Дюна: Частина друга"))
    }

    func testAnAddressAloneOnlySuggests() {
        let match = best([link("/films/18432-dune-part-two.html", "")])
        XCTAssertNotNil(match)
        XCTAssertEqual(match?.isStrong, false)
    }

    func testIgnoresNavigationAndOtherSites() {
        let ad = RescueLink(url: URL(string: "https://ads.example/dune-part-two")!, text: "Dune: Part Two (2024)", context: "")
        XCTAssertNil(best([ad]))
        XCTAssertNil(best([link("/tag/dune-part-two", "Dune: Part Two (2024)")]))
        XCTAssertNil(best([link("/search?q=dune", "Dune: Part Two (2024)")]))
    }

    func testAPartOfTheNameIsNotAMatch() {
        XCTAssertNil(best([link("/film/x", "Dune (2024)")]))
    }

    func testUploadSitesAreOnlySuggestions() {
        XCTAssertTrue(RescueMatcher.isVideoSharing(URL(string: "https://www.youtube.com/watch?v=1")!))
        XCTAssertFalse(RescueMatcher.isVideoSharing(URL(string: "https://tubitv.com/movies/1")!))
    }

    func testFindsTheSamePageAtOtherAddresses() {
        let url = URL(string: "https://hdrezka.ag/series/drama/1-mentalist-2008.html#t:238-s:3-e:5")!
        let found = RescueMatcher.mirrors(of: url, among: ["rezka-ua.co", "uakino.me", "hdrezka.ag", "rezka.fi", "rezka-ua.co"])
        XCTAssertEqual(found.map(\.absoluteString), [
            "https://rezka-ua.co/series/drama/1-mentalist-2008.html#t:238-s:3-e:5",
            "https://rezka.fi/series/drama/1-mentalist-2008.html#t:238-s:3-e:5",
        ])
    }

    func testCommonWordsDoNotMakeSitesMirrors() {
        let url = URL(string: "https://kino-online.example/film/1")!
        XCTAssertEqual(RescueMatcher.mirrors(of: url, among: ["kino-hd.example", "kino.example"]), [])
    }
}

final class FrameGradingTests: XCTestCase {
    private func image(_ fill: (CGContext) -> Void) -> CGImage {
        let context = CGContext(
            data: nil, width: 64, height: 36, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        )!
        fill(context)
        return context.makeImage()!
    }

    private func solid(_ grey: CGFloat) -> CGImage {
        image { context in
            context.setFillColor(gray: grey, alpha: 1)
            context.fill(CGRect(x: 0, y: 0, width: 64, height: 36))
        }
    }

    private var scene: CGImage {
        image { context in
            context.setFillColor(red: 0.8, green: 0.3, blue: 0.1, alpha: 1)
            context.fill(CGRect(x: 0, y: 0, width: 32, height: 36))
            context.setFillColor(red: 0.05, green: 0.1, blue: 0.3, alpha: 1)
            context.fill(CGRect(x: 32, y: 0, width: 32, height: 36))
        }
    }

    func testABlackScreenIsBlank() {
        XCTAssertEqual(FrameImage.grade(solid(0))?.isBlank, true)
    }

    func testAFlatColourIsBlank() {
        XCTAssertEqual(FrameImage.grade(solid(0.5))?.isBlank, true, "A fade or a title card has nothing to show")
    }

    func testAPictureIsNot() {
        XCTAssertEqual(FrameImage.grade(scene)?.isBlank, false)
    }

    func testAPictureScoresHigherThanAlmostNothing() throws {
        let dim = image { context in
            context.setFillColor(gray: 0.1, alpha: 1)
            context.fill(CGRect(x: 0, y: 0, width: 64, height: 36))
            context.setFillColor(gray: 0.16, alpha: 1)
            context.fill(CGRect(x: 0, y: 0, width: 32, height: 36))
        }
        XCTAssertGreaterThan(try XCTUnwrap(FrameImage.grade(scene)).interest, try XCTUnwrap(FrameImage.grade(dim)).interest)
    }

    func testEncodingFitsTheSizeAsked() throws {
        let data = try XCTUnwrap(FrameImage.jpeg(scene, maxPixel: 32, quality: 0.7))
        let decoded = try XCTUnwrap(FrameImage.image(fromJPEG: data))
        XCTAssertEqual(decoded.width, 32)
        XCTAssertEqual(decoded.height, 18)
    }
}

@MainActor
final class SkipRuleStorageTests: XCTestCase {
    private func makeDB() throws -> Database {
        try Database(path: NSTemporaryDirectory() + "cineon-test-\(UUID().uuidString).sqlite")
    }

    private func title(_ db: Database, _ name: String) throws -> Int64 {
        try db.insertTitle(Title(
            id: 0, name: name, normName: TitleParser.normalize(name), year: nil, kind: .series, status: .watching,
            imdbID: nil, posterURL: nil, backdropURL: nil, overview: nil, genres: [], runtimeMinutes: nil, ratingHalves: nil,
            notes: nil, addedAt: .now, updatedAt: .now, finishedAt: nil, lastWatchedAt: nil, metadataChecked: false
        ))
    }

    func testSavingAgainUpdatesTheSameRule() throws {
        let db = try makeDB()
        let id = try title(db, "The Bear")
        var rule = SkipRule(id: 0, titleID: id, site: "rezka", kind: .intro, start: 60, end: 150, sightings: 1, misses: 0, updatedAt: .now)
        try db.saveSkipRule(rule)
        rule.end = 155
        rule.sightings = 2
        try db.saveSkipRule(rule)
        let rules = try db.skipRules(titleID: id, site: "rezka")
        XCTAssertEqual(rules.count, 1)
        XCTAssertEqual(rules[0].end, 155)
        XCTAssertEqual(rules[0].sightings, 2)
        XCTAssertEqual(try db.skipRules(titleID: id, site: "uakino").count, 0)
    }

    func testRulesAndFramesFollowAMergedTitle() throws {
        let db = try makeDB()
        let a = try title(db, "A")
        let b = try title(db, "B")
        try db.saveSkipRule(SkipRule(id: 0, titleID: a, site: "rezka", kind: .intro, start: 60, end: 150, sightings: 1, misses: 0, updatedAt: .now))
        _ = try db.insertFrame(FilmFrame(id: 0, sessionID: nil, titleID: a, ref: .none, position: 10, url: nil, file: "x.jpg", isMoment: true, interest: 1, at: .now))
        try db.mergeTitle(from: a, into: b)
        XCTAssertEqual(try db.skipRules(titleID: b).count, 1)
        XCTAssertEqual(try db.allFrames().first?.titleID, b)
    }

    func testMomentsOutliveTheirSession() throws {
        let db = try makeDB()
        let id = try title(db, "A")
        let session = try db.insertSession(WatchSession(
            id: 0, titleID: id, ref: .none, episodeName: nil, url: nil, host: "x", startedAt: .now, endedAt: .now,
            watchedSeconds: 10, startPosition: 0, endPosition: 10, duration: 100, finished: false
        ))
        _ = try db.insertFrame(FilmFrame(id: 0, sessionID: session, titleID: id, ref: .none, position: 10, url: nil, file: "x.jpg", isMoment: true, interest: 1, at: .now))
        try db.deleteSession(session)
        let frames = try db.allFrames()
        XCTAssertEqual(frames.count, 1)
        XCTAssertNil(frames[0].sessionID)
    }

    func testAnOlderDatabaseUpgradesAndKeepsItsLibrary() throws {
        let path = NSTemporaryDirectory() + "cineon-test-\(UUID().uuidString).sqlite"
        let older = try Database(path: path)
        _ = try title(older, "Kept")
        // Back to how a database from before these features looks.
        try older.sql.exec("""
        DROP TABLE downloads; DROP TABLE frames; DROP TABLE skip_rules; DROP TABLE episode_alerts;
        ALTER TABLE titles DROP COLUMN rated_at; ALTER TABLE titles DROP COLUMN status_at;
        PRAGMA user_version=1
        """)
        older.sql.close()

        let upgraded = try Database(path: path)
        XCTAssertEqual(upgraded.sql.userVersion, 4)
        XCTAssertEqual(try upgraded.allFrames().count, 0)
        XCTAssertEqual(try upgraded.allTitles().map(\.name), ["Kept"])
        _ = try upgraded.insertFrame(FilmFrame(id: 0, sessionID: nil, titleID: upgraded.allTitles()[0].id, ref: .none, position: 1, url: nil, file: "a.jpg", isMoment: false, interest: 0, at: .now))
        XCTAssertEqual(try upgraded.allFrames().count, 1)
    }
}
