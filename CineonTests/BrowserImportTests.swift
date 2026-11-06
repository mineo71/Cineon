import SQLite3
import XCTest
@testable import Cineon

@MainActor
final class BrowserImportTests: XCTestCase {
    private var root: URL!

    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("import-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: root)
    }

    // MARK: Fake browsers

    /// Chromium's time format: microseconds since 1601.
    private func chromiumTime(_ date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 + 11_644_473_600) * 1_000_000)
    }

    private func makeHistory(at folder: URL, _ rows: [(String, String, Int, Date)]) throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(folder.appendingPathComponent("History").path, &db), SQLITE_OK)
        defer { sqlite3_close(db) }
        sqlite3_exec(db, "CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER DEFAULT 0)", nil, nil, nil)
        for (url, title, visits, date) in rows {
            let safeTitle = title.replacingOccurrences(of: "'", with: "''")
            sqlite3_exec(db, "INSERT INTO urls(url,title,visit_count,typed_count,last_visit_time) VALUES('\(url)','\(safeTitle)',\(visits),0,\(chromiumTime(date)))", nil, nil, nil)
        }
    }

    private func page(_ url: String, _ title: String, visits: Int = 2, at date: Date = .now, origin: BrowsedPage.Origin = .history) -> BrowsedPage {
        BrowsedPage(url: URL(string: url)!, title: title, visits: visits, lastVisit: date, origin: origin)
    }

    private func analyze(_ pages: [BrowsedPage]) -> ImportScan {
        ImportAnalyzer.analyze(pages, sourceLabel: "Test")
    }

    // MARK: Reading files

    func testChromiumDateConversion() {
        // 2024-01-01T00:00:00Z.
        let date = BrowserImporter.chromiumDate(13_348_540_800_000_000)
        XCTAssertEqual(date.timeIntervalSince1970, 1_704_067_200, accuracy: 1)
    }

    func testDiscoverFindsProfilesWithDataAndSkipsEmptyOnes() throws {
        let chrome = root.appendingPathComponent("Google/Chrome")
        try makeHistory(at: chrome.appendingPathComponent("Default"), [("https://a.example/x", "A", 1, .now)])
        try makeHistory(at: chrome.appendingPathComponent("Profile 1"), [])
        try makeHistory(at: chrome.appendingPathComponent("Guest Profile"), [("https://b.example/x", "B", 1, .now)])
        let state = #"{"profile":{"info_cache":{"Default":{"name":"Personal"}}}}"#
        try state.write(to: chrome.appendingPathComponent("Local State"), atomically: true, encoding: .utf8)

        let sources = BrowserImporter.discover(root: root)
        XCTAssertEqual(sources.count, 1)
        XCTAssertEqual(sources[0].browser, "Chrome")
        XCTAssertEqual(sources[0].label, "Chrome, Personal")
        XCTAssertEqual(sources[0].historyCount, 1)
    }

    func testReadsNestedBookmarks() throws {
        let profile = root.appendingPathComponent("profile")
        try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true)
        let json = #"""
        {"roots":{"bookmark_bar":{"type":"folder","children":[
          {"type":"url","name":"One","url":"https://a.example/1","date_added":"13348569600000000"},
          {"type":"folder","name":"Films","children":[{"type":"url","name":"Two","url":"https://b.example/2"}]}
        ]},"other":{"type":"folder","children":[]}}}
        """#
        try json.write(to: profile.appendingPathComponent("Bookmarks"), atomically: true, encoding: .utf8)
        let pages = BrowserImporter.readBookmarks(in: profile)
        XCTAssertEqual(Set(pages.map(\.title)), ["One", "Two"])
        XCTAssertTrue(pages.allSatisfy { $0.origin == .bookmark })
    }

    func testReadsArcTabsWhereverTheyAre() throws {
        let arc = root.appendingPathComponent("Arc")
        try FileManager.default.createDirectory(at: arc, withIntermediateDirectories: true)
        let sidebar = #"""
        {"sidebar":{"containers":[{"items":["some-id",{"data":{"tab":{"savedURL":"https://kino.example/dune","savedTitle":"Dune"}}}]}]},
         "sidebarSyncState":{"items":[{"value":{"data":{"tab":{"savedURL":"https://kino.example/dune","savedTitle":"Dune"}}}}]}}
        """#
        let archive = #"{"items":[{"sidebarItem":{"data":{"tab":{"savedURL":"https://kino.example/old","savedTitle":"Old"}}}}]}"#
        try sidebar.write(to: arc.appendingPathComponent("StorableSidebar.json"), atomically: true, encoding: .utf8)
        try archive.write(to: arc.appendingPathComponent("StorableArchiveItems.json"), atomically: true, encoding: .utf8)
        let pages = BrowserImporter.readArcTabs(in: arc)
        XCTAssertEqual(pages.map(\.title).sorted(), ["Dune", "Old"], "Duplicates in sync data are counted once")
    }

    func testScanReadsAWholeFakeArc() throws {
        let userData = root.appendingPathComponent("Arc/User Data/Default")
        try makeHistory(at: userData, [
            ("https://uakino.example/filmy/dune-2021.html", "Дюна (2021) дивитися онлайн українською", 5, .now),
            ("https://uakino.example/filmy/oppenheimer.html", "Оппенгеймер дивитися онлайн", 2, .now),
            ("https://news.example/article", "Some article", 1, .now),
        ])
        let sources = BrowserImporter.discover(root: root)
        XCTAssertEqual(sources.first?.browser, "Arc")
        let scan = BrowserImporter.scan(try XCTUnwrap(sources.first))
        XCTAssertEqual(Set(scan.titles.map(\.name)), ["Дюна", "Оппенгеймер"])
        XCTAssertEqual(scan.sites.map(\.host), ["uakino.example"])
        XCTAssertEqual(scan.totalPages, 3)
    }

    // MARK: Spotting films

    func testPageTitlesAreEnoughOnTheirOwn() {
        let scan = analyze([page("https://kinoplace.example/abc-123", "Watch Dune: Part Two (2024) Full Movie Online Free | Site")])
        XCTAssertEqual(scan.titles.first?.name, "Dune: Part Two")
        XCTAssertEqual(scan.titles.first?.year, 2024)
    }

    func testOneFilmLikePageOnAnUnrelatedSiteIsIgnored() {
        let scan = analyze([page("https://anything.example/abc-123", "Watch Dune Full Movie Online Free | Site")])
        XCTAssertTrue(scan.titles.isEmpty)
    }

    func testAnUnfamiliarSiteCanProveItself() {
        let pages = ["Alpha", "Beta", "Gamma"].map { page("https://anything.example/w/\($0)", "Watch \($0) Full Movie Online Free") }
        XCTAssertEqual(analyze(pages).titles.count, 3)
    }

    func testAdultAndMusicSitesAreNeverImported() {
        let names = ["pornsite.example", "muzplace.example", "mp3place.example"]
        let pages = names.flatMap { host in
            ["Alpha", "Beta", "Gamma"].map { page("https://\(host)/watch/\($0)", "Watch \($0) Full Movie Online Free") }
        }
        let scan = analyze(pages)
        XCTAssertTrue(scan.titles.isEmpty)
        XCTAssertTrue(scan.sites.isEmpty)
    }

    func testTrailersAndSitePagesAreIgnored() {
        let scan = analyze([
            page("https://kino.example/film/a", "Alpha (трейлер) дивитися онлайн"),
            page("https://kino.example/film/b", "Лучшие фильмы года смотреть онлайн"),
            page("https://kino.example/best/fiction/2024", "Смотреть лучшие"),
            page("https://kino.example/film/c", "Регистрация посетителя смотреть"),
        ])
        XCTAssertTrue(scan.titles.isEmpty, "\(scan.titles.map(\.name))")
    }

    func testDubsOfOneFilmBecomeOneTitle() {
        let scan = analyze([
            page("https://rezka.example/films/1-mayday.html#t:1", "Смотреть Мэйдэй в озвучке Дубляж онлайн"),
            page("https://rezka.example/films/1-mayday.html#t:2", "Смотреть Мэйдэй в озвучке Оригинал (+субтитры) онлайн"),
        ])
        XCTAssertEqual(scan.titles.map(\.name), ["Мэйдэй"])
        XCTAssertEqual(scan.titles.first?.visits.count, 1)
    }

    func testNotYetReleasedGoesToTheBacklog() {
        let scan = analyze([page("https://rezka.example/films/2-odyssey.html", "Одиссея скоро смотреть онлайн")])
        XCTAssertEqual(scan.titles.first?.name, "Одиссея")
        XCTAssertEqual(scan.titles.first?.suggestedStatus, .backlog)
    }

    func testMirrorsOfASiteBecomeOneAtItsNewestAddress() {
        let older = Date.now.addingTimeInterval(-86400 * 100)
        let scan = analyze([
            page("https://hdrezka.example/films/a.html", "Alpha смотреть онлайн", at: older),
            page("https://rezka-ua.example/films/b.html", "Beta смотреть онлайн", at: older),
            page("https://rezka-tv.example/films/c.html", "Gamma смотреть онлайн"),
        ])
        XCTAssertEqual(scan.sites.map(\.host), ["rezka-tv.example"])
        XCTAssertEqual(scan.sites.first?.filmPages, 3)
    }

    func testBrandIgnoresMirrorDecoration() {
        XCTAssertEqual(ImportAnalyzer.brand("hdrezka.ag"), "rezka")
        XCTAssertEqual(ImportAnalyzer.brand("rezka-ua.co"), "rezka")
        XCTAssertEqual(ImportAnalyzer.brand("kinogo1.biz"), "kinogo")
        XCTAssertNotEqual(ImportAnalyzer.brand("kinogo.is"), ImportAnalyzer.brand("uakino.best"))
    }

    func testEverydayPagesAreNotFilms() {
        let scan = analyze([
            page("https://news.example/2024/politics/story", "Elections: what happens next"),
            page("https://shop.example/product/shoes", "Running shoes | Shop"),
            page("https://docs.example/guide/start", "Getting started"),
        ])
        XCTAssertTrue(scan.titles.isEmpty)
        XCTAssertTrue(scan.sites.isEmpty)
    }

    func testExcludedSitesAreIgnored() {
        let scan = analyze([
            page("https://www.imdb.com/title/tt1160419/", "Watch Dune online free"),
            page("https://www.youtube.com/watch?v=abc", "Watch Dune Full Movie Online Free"),
            page("https://www.google.com/search?q=dune", "Watch Dune online"),
        ])
        XCTAssertTrue(scan.titles.isEmpty)
    }

    func testSearchAndListingPagesAreIgnored() {
        let scan = analyze([
            page("https://kino.example/search?q=dune", "Смотреть Dune онлайн"),
            page("https://kino.example/genre/comedy/", "Смотреть комедии онлайн"),
            page("https://kino.example/", "Смотреть фильмы онлайн"),
        ])
        XCTAssertTrue(scan.titles.isEmpty)
    }

    func testWeakPagesCountOnceTheSiteHasProvedItself() {
        let strong = ["Alpha", "Beta", "Gamma"].map { page("https://plain.example/watch/\($0)", "\($0) дивитися онлайн") }
        let weak = page("https://plain.example/watch/plain-title", "Plain Title")
        XCTAssertTrue(analyze([weak]).titles.isEmpty, "A /watch/ path alone proves nothing")
        XCTAssertTrue(analyze(strong + [weak]).titles.contains { $0.name == "Plain Title" })
    }

    func testEpisodesOfOneSeriesBecomeOneTitle() {
        let old = Date.now.addingTimeInterval(-3600)
        let scan = analyze([
            page("https://serials.example/serial/severance/2-sezon/3-seriya", "Розрив 2 сезон 3 серія дивитися онлайн", at: old),
            page("https://serials.example/serial/severance/2-sezon/4-seriya", "Розрив 2 сезон 4 серія дивитися онлайн"),
        ])
        XCTAssertEqual(scan.titles.count, 1)
        let title = try? XCTUnwrap(scan.titles.first)
        XCTAssertEqual(title?.kind, .series)
        XCTAssertEqual(title?.visits.count, 2)
        XCTAssertEqual(title?.latestRef, EpisodeRef(season: 2, episode: 4), "The newest visit shows where you ended up")
        XCTAssertEqual(title?.suggestedStatus, .watching)
    }

    func testSeriesPageIsDroppedOnceEpisodesAreKnown() {
        let scan = analyze([
            page("https://serials.example/serial/severance", "Розрив дивитися онлайн"),
            page("https://serials.example/serial/severance#t:1-s:2-e:4", "Розрив дивитися онлайн"),
        ])
        XCTAssertEqual(scan.titles.count, 1)
        XCTAssertEqual(scan.titles.first?.visits.map(\.ref), [EpisodeRef(season: 2, episode: 4)])
    }

    func testPreviewReadsOpenGraphTags() {
        let html = #"""
        <head><meta content="https://cdn.example/poster.jpg" property="og:image"><meta property="og:description" content="A film &amp; more"></head>
        """#
        let preview = PagePreview.parse(html, base: URL(string: "https://site.example/x")!)
        XCTAssertEqual(preview.poster?.absoluteString, "https://cdn.example/poster.jpg")
        XCTAssertEqual(preview.overview, "A film & more")
    }

    func testPreviewResolvesRelativeImagesAndIgnoresLogos() {
        let relative = PagePreview.parse(#"<meta property="og:image" content="/i/p.jpg">"#, base: URL(string: "https://site.example/film/x")!)
        XCTAssertEqual(relative.poster?.absoluteString, "https://site.example/i/p.jpg")
        let logo = PagePreview.parse(#"<meta property="og:image" content="/static/logo.png">"#, base: URL(string: "https://site.example/x")!)
        XCTAssertNil(logo.poster)
    }

    func testSuggestedListsFollowWhatHappened() {
        let longAgo = Date.now.addingTimeInterval(-400 * 24 * 3600)
        let scan = analyze([
            page("https://kino.example/film/a", "Arrival дивитися онлайн", at: longAgo),
            page("https://kino.example/serial/b/1-sezon/1-seriya", "Old Series 1 сезон 1 серія дивитися онлайн", at: longAgo),
            page("https://kino.example/film/c", "Past Lives дивитися онлайн", visits: 0, at: longAgo, origin: .bookmark),
        ])
        func status(_ name: String) -> TitleStatus? { scan.titles.first { $0.name == name }?.suggestedStatus }
        XCTAssertEqual(status("Arrival"), .watched)
        XCTAssertEqual(status("Old Series"), .watched, "A series left a year ago isn't being watched now")
        XCTAssertEqual(status("Past Lives"), .backlog, "Saved but never opened means for later")
    }

    func testSiteNeedsMoreThanOneFilmPage() {
        XCTAssertTrue(analyze([page("https://kinoa.example/film/x", "Alpha дивитися онлайн")]).sites.isEmpty)
        let two = analyze([
            page("https://www.kinob.example/film/x", "Alpha дивитися онлайн"),
            page("https://www.kinob.example/film/y", "Beta дивитися онлайн"),
        ])
        XCTAssertEqual(two.sites.first?.host, "kinob.example")
        XCTAssertEqual(two.sites.first?.filmPages, 2)
        XCTAssertEqual(two.sites.first?.homeURL.absoluteString, "https://www.kinob.example/")
    }

    func testPinnedFilmSiteIsSuggestedEvenWithoutFilmPages() {
        let scan = analyze([page("https://kinoplace.example/", "Kinoplace", visits: 0, origin: .pinned)])
        XCTAssertEqual(scan.sites.map(\.host), ["kinoplace.example"])
    }

    func testPagesAreCappedNewestFirst() {
        let pages = (0..<(BrowserImporter.pageLimit + 5)).map { index in
            page("https://x.example/p\(index)", "P", at: Date(timeIntervalSince1970: Double(index) + 1_000_000))
        }
        let scan = analyze(pages)
        XCTAssertEqual(scan.pages.count, BrowserImporter.pageLimit)
        XCTAssertEqual(scan.totalPages, BrowserImporter.pageLimit + 5)
        XCTAssertEqual(scan.pages.first?.url.absoluteString, "https://x.example/p\(BrowserImporter.pageLimit + 4)")
    }

    // MARK: Saving

    private func makeLibrary() throws -> LibraryStore {
        let path = NSTemporaryDirectory() + "import-\(UUID().uuidString).sqlite"
        addTeardownBlock { try? FileManager.default.removeItem(atPath: path) }
        return LibraryStore(db: try Database(path: path))
    }

    private func selection(from scan: ImportScan) -> ImportSelection {
        ImportSelection(sites: scan.sites, titles: scan.titles.map { ($0, $0.suggestedStatus) }, pages: scan.pages)
    }

    func testImportFillsLibraryTimelineAndHistory() throws {
        let library = try makeLibrary()
        let visited = Date.now.addingTimeInterval(-86400 * 30)
        let scan = analyze([
            page("https://kino.example/film/dune", "Dune (2021) дивитися онлайн", at: visited),
            page("https://kino.example/film/oppenheimer", "Oppenheimer дивитися онлайн", at: visited),
        ])
        let result = library.applyImport(selection(from: scan))

        XCTAssertEqual(result.titles, 2)
        XCTAssertEqual(result.sites, 1)
        XCTAssertEqual(result.pages, 2)
        let dune = try XCTUnwrap(library.titles.values.first { $0.name == "Dune" })
        XCTAssertEqual(dune.status, .watched)
        XCTAssertEqual(dune.finishedAt?.timeIntervalSince1970 ?? 0, visited.timeIntervalSince1970, accuracy: 1, "Keeps the real date")
        XCTAssertEqual(library.sessions.count, 2)
        XCTAssertTrue(library.sessions[0].isVisitOnly)
        XCTAssertEqual(library.latestProgress(titleID: dune.id)?.host, "kino.example")
        XCTAssertTrue(library.events.isEmpty, "An import doesn't flood today's timeline")
        XCTAssertEqual(try library.db.recentHistory().count, 2)
    }

    func testImportingTwiceAddsNothing() throws {
        let library = try makeLibrary()
        let scan = analyze([
            page("https://kino.example/film/dune", "Dune дивитися онлайн"),
            page("https://kino.example/film/up", "Up дивитися онлайн"),
        ])
        _ = library.applyImport(selection(from: scan))
        let second = library.applyImport(selection(from: scan))
        XCTAssertEqual(second.titles, 0)
        XCTAssertEqual(second.sites, 0)
        XCTAssertEqual(second.pages, 0)
        XCTAssertEqual(library.titles.count, 2)
        XCTAssertEqual(library.sessions.count, 2)
    }

    func testRenamedTitleIsRecognisedByItsAddress() throws {
        let library = try makeLibrary()
        let scan = analyze([page("https://kino.example/film/dune", "Дюна дивитися онлайн")])
        _ = library.applyImport(selection(from: scan))
        // A catalogue lookup replaces the Ukrainian name with the English one.
        var title = try XCTUnwrap(library.titles.values.first)
        title.name = "Dune"
        title.normName = TitleParser.normalize("Dune")
        library.update(title)

        let second = library.applyImport(selection(from: scan))
        XCTAssertEqual(second.titles, 0)
        XCTAssertEqual(library.titles.count, 1)
        XCTAssertEqual(library.sessions.count, 1)
    }

    func testImportNeverOverwritesARealPosition() throws {
        let library = try makeLibrary()
        let existing = try XCTUnwrap(library.addTitle(name: "Dune", status: .watching))
        library.saveProgress(WatchProgress(
            titleID: existing.id, ref: .none, urlKey: "real/key", url: URL(string: "https://real.example/d"), host: "real.example",
            position: 1234, duration: 7000, finished: false, updatedAt: .now
        ))
        let scan = analyze([page("https://kino.example/film/dune", "Dune дивитися онлайн")])
        _ = library.applyImport(selection(from: scan))

        XCTAssertEqual(library.titles.count, 1, "Matches the title already there")
        XCTAssertEqual(library.titles[existing.id]?.status, .watching, "Keeps its list")
        XCTAssertEqual(library.latestProgress(titleID: existing.id)?.position, 1234)
        XCTAssertEqual(library.latestProgress(titleID: existing.id)?.host, "real.example")
    }

    func testBacklogItemsStayOffTheTimeline() throws {
        let library = try makeLibrary()
        let scan = analyze([page("https://kino.example/film/dune", "Dune дивитися онлайн", visits: 0, origin: .bookmark)])
        _ = library.applyImport(selection(from: scan))
        XCTAssertEqual(library.backlog.count, 1)
        XCTAssertTrue(library.sessions.isEmpty)
    }
}
