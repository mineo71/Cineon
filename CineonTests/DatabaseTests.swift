import XCTest
@testable import Cineon

@MainActor
final class DatabaseTests: XCTestCase {
    private var db: Database!
    private var path: String!

    override func setUp() async throws {
        path = NSTemporaryDirectory() + "cineon-test-\(UUID().uuidString).sqlite"
        db = try Database(path: path)
    }

    override func tearDown() async throws {
        db = nil
        try? FileManager.default.removeItem(atPath: path)
    }

    private func makeTitle(_ name: String = "Dune") -> Title {
        Title(
            id: 0, name: name, normName: TitleParser.normalize(name), year: 2021, kind: .film, status: .backlog,
            imdbID: nil, posterURL: URL(string: "https://x.example/p.jpg"), backdropURL: nil, overview: nil,
            genres: ["Sci-Fi", "Drama"], runtimeMinutes: 155, ratingHalves: nil, notes: nil, addedAt: .now, updatedAt: .now,
            finishedAt: nil, lastWatchedAt: nil, metadataChecked: false
        )
    }

    func testTitleRoundTrip() throws {
        let id = try db.insertTitle(makeTitle())
        let loaded = try XCTUnwrap(db.allTitles().first { $0.id == id })
        XCTAssertEqual(loaded.name, "Dune")
        XCTAssertEqual(loaded.genres, ["Sci-Fi", "Drama"])
        XCTAssertEqual(loaded.status, .backlog)
    }

    func testProgressUpsertKeepsFinishedFlag() throws {
        let id = try db.insertTitle(makeTitle())
        var p = WatchProgress(
            titleID: id, ref: .none, urlKey: "site/x", url: nil, host: "site", position: 100, duration: 200,
            finished: true, updatedAt: .now
        )
        try db.upsertProgress(p)
        p.position = 10
        p.finished = false
        try db.upsertProgress(p)
        let loaded = try XCTUnwrap(db.progress(titleID: id, ref: .none))
        XCTAssertEqual(loaded.position, 10)
        XCTAssertTrue(loaded.finished)
        XCTAssertEqual(try db.progress(urlKey: "site/x")?.titleID, id)
    }

    func testDeletingTitleRemovesItsRecords() throws {
        let id = try db.insertTitle(makeTitle())
        _ = try db.insertSession(WatchSession(
            id: 0, titleID: id, ref: .none, episodeName: nil, url: nil, host: "site", startedAt: .now, endedAt: .now,
            watchedSeconds: 60, startPosition: 0, endPosition: 60, duration: 100, finished: false
        ))
        try db.deleteTitle(id)
        XCTAssertTrue(try db.sessions().isEmpty)
    }

    func testMergeMovesSessionsAndRemovesSource() throws {
        let a = try db.insertTitle(makeTitle("A"))
        let b = try db.insertTitle(makeTitle("B"))
        _ = try db.insertSession(WatchSession(
            id: 0, titleID: a, ref: .none, episodeName: nil, url: nil, host: "site", startedAt: .now, endedAt: .now,
            watchedSeconds: 60, startPosition: 0, endPosition: 60, duration: 100, finished: false
        ))
        try db.mergeTitle(from: a, into: b)
        XCTAssertEqual(try db.sessions(titleID: b).count, 1)
        XCTAssertNil(try db.allTitles().first { $0.id == a })
    }

    func testHistoryCollapsesRepeatVisits() throws {
        let url = URL(string: "https://site.example/x")!
        try db.addHistory(url: url, host: "site.example", title: "One")
        try db.addHistory(url: url, host: "site.example", title: "Two")
        let rows = try db.recentHistory()
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].title, "Two")
    }

    func testStatsAccumulate() throws {
        try db.addStats(ShieldStats(ads: 2, popups: 1), day: "2026-11-01")
        try db.addStats(ShieldStats(ads: 3), day: "2026-11-01")
        let total = try db.totalStats()
        XCTAssertEqual(total.ads, 5)
        XCTAssertEqual(total.total, 6)
    }

    func testSettingsSurviveUnknownFields() throws {
        var s = AppSettings()
        s.theme = .white
        db.saveSettings(s)
        XCTAssertEqual(db.loadSettings().theme, .white)
        let partial = Data(#"{"theme":"dark","somethingNew":true}"#.utf8)
        let decoded = try JSONDecoder().decode(AppSettings.self, from: partial)
        XCTAssertEqual(decoded.theme, .dark)
        XCTAssertTrue(decoded.autoResume)
    }

    func testTabsRoundTrip() throws {
        let id = UUID()
        try db.saveTabs([PersistedTab(
            id: id, url: URL(string: "https://x.example"), title: "X", faviconURL: nil, position: 0, isActive: true,
            state: Data([1, 2, 3]), isPinnedToSearch: false
        )])
        let loaded = try db.loadTabs()
        XCTAssertEqual(loaded.first?.id, id)
        XCTAssertEqual(loaded.first?.state, Data([1, 2, 3]))
    }
}
