import XCTest
@testable import Cineon

@MainActor
final class TitleParserTests: XCTestCase {

    private func parse(title: String = "", og: String? = nil, url: String = "https://example.com/x", site: String? = nil) -> ParsedTitle? {
        var meta = PageMeta()
        meta.title = title
        meta.ogTitle = og
        meta.url = url
        meta.ogSite = site
        return TitleParser.parse(meta)
    }

    func testStripsEnglishPageFurniture() {
        let p = parse(title: "Watch Dune: Part Two (2024) Full Movie Online Free HD | FlixHub", url: "https://flixhub.to/watch/1", site: "FlixHub")
        XCTAssertEqual(p?.name, "Dune: Part Two")
        XCTAssertEqual(p?.year, 2024)
    }

    func testMovieInsideANameIsKept() {
        let p = parse(title: "Watch The Lego Movie (2014) Online Free | FlixHub", url: "https://flixhub.to/x", site: "FlixHub")
        XCTAssertEqual(p?.name, "The Lego Movie")
        XCTAssertEqual(p?.year, 2014)
    }

    func testPicksFirstMeaningfulSegment() {
        let p = parse(title: "FlixHub - Oppenheimer - Watch free", url: "https://flixhub.to/x", site: "FlixHub")
        XCTAssertEqual(p?.name, "Oppenheimer")
    }

    func testReadsUkrainianTitle() {
        let p = parse(title: "Дюна: Частина друга (2024) дивитися онлайн безкоштовно українською", url: "https://uakino.best/x")
        XCTAssertEqual(p?.name, "Дюна: Частина друга")
        XCTAssertEqual(p?.year, 2024)
    }

    func testReadsRussianTitleAndKind() {
        let p = parse(title: "Смотреть мультфильм Головоломка 2 онлайн бесплатно в хорошем качестве", url: "https://kino.example/x")
        XCTAssertEqual(p?.name, "Головоломка 2")
        XCTAssertEqual(p?.kindHint, .cartoon)
    }

    func testSpacedColonSeparatesSections() {
        let p = parse(title: "Big Buck Bunny : Free Download, Borrow, and Streaming : Internet Archive", url: "https://archive.org/details/x")
        XCTAssertEqual(p?.name, "Big Buck Bunny")
    }

    func testColonInsideTitleIsKept() {
        let p = parse(title: "Dune: Part Two", url: "https://site.example/x")
        XCTAssertEqual(p?.name, "Dune: Part Two")
    }

    func testVideoQualityWordsAreRemoved() {
        let p = parse(title: "Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film - YouTube", url: "https://www.youtube.com/watch?v=x")
        XCTAssertEqual(p?.name, "Big Buck Bunny")
    }

    // These follow the page titles on HDRezka and its mirrors.
    func testDubInTheTitleIsNotPartOfTheName() {
        let p = parse(title: "Смотреть Менталист в озвучке Оригинал (+субтитры) онлайн бесплатно в хорошем качестве", url: "https://rezka.example/series/drama/1-mentalist.html")
        XCTAssertEqual(p?.name, "Менталист")
        XCTAssertEqual(p?.kindHint, .series, "The address says it's a series")
    }

    func testDifferentDubsGiveTheSameName() {
        let names = [
            "Пацаны в озвучке лостфильм (LostFilm)", "Пацаны в озвучке HDrezka Studio (18+)", "Пацаны в озвучке Дубляж",
        ].map { parse(title: $0, url: "https://rezka.example/x")?.name }
        XCTAssertEqual(Set(names), ["Пацаны"])
    }

    func testAnimeSeasonMarkerIsRemoved() {
        XCTAssertEqual(parse(title: "Поднятие уровня в одиночку [ТВ-1] смотреть онлайн", url: "https://rezka.example/x")?.name, "Поднятие уровня в одиночку")
    }

    func testQualityAndDownloadWordsAreRemoved() {
        XCTAssertEqual(parse(title: "Мэйдэй в 1080 качестве смотреть", url: "https://k.example/x")?.name, "Мэйдэй")
        XCTAssertEqual(parse(title: "Сверхъестественное скачать торрент 1080", url: "https://k.example/x")?.name, "Сверхъестественное")
        XCTAssertEqual(parse(title: "Мэйдэй (Mayday", url: "https://k.example/x")?.name, "Мэйдэй")
    }

    func testComingSoonAndBracketNotesAreRemoved() {
        XCTAssertEqual(parse(title: "Одиссея скоро", url: "https://rezka.example/x")?.name, "Одиссея")
        XCTAssertEqual(parse(title: "Паук-Нуар (ЧБ) в озвучке Дубляж", url: "https://rezka.example/x")?.name, "Паук-Нуар")
    }

    func testBrokenQuoteIsCleanedUp() {
        XCTAssertEqual(parse(title: "Создание «Рыцаря Семи Королевств» в озвучке Дубляж", url: "https://rezka.example/x")?.name, "Создание «Рыцаря Семи Королевств»")
        XCTAssertEqual(parse(title: "Создание «Рыцаря", url: "https://rezka.example/x")?.name, "Создание Рыцаря")
    }

    func testSubDubSiteSuffixIsRemoved() {
        XCTAssertEqual(parse(title: "One Piece English Sub/Dub on Aniwatch.to", url: "https://aniwatch.example/x")?.name, "One Piece")
    }

    func testEpisodeInRezkaFragment() {
        XCTAssertEqual(
            TitleParser.episodeRef(in: "https://rezka.example/series/drama/1-name-2020.html#t:238-s:2-e:3"),
            EpisodeRef(season: 2, episode: 3)
        )
    }

    func testCartoonSectionInAddress() {
        XCTAssertEqual(parse(title: "Головоломка смотреть онлайн", url: "https://rezka.example/cartoons/comedy/1-name.html")?.kindHint, .cartoon)
    }

    func testEpisodeFragmentIsPartOfThePageButDubIsNot() {
        let a = URLKey.make(URL(string: "https://rezka.example/series/1-name.html#t:238-s:2-e:3")!)
        let b = URLKey.make(URL(string: "https://rezka.example/series/1-name.html#t:111-s:2-e:3")!)
        let c = URLKey.make(URL(string: "https://rezka.example/series/1-name.html#t:238-s:2-e:4")!)
        XCTAssertEqual(a, "rezka.example/series/1-name.html#s:2-e:3")
        XCTAssertEqual(a, b, "Another dub of the same episode")
        XCTAssertNotEqual(a, c, "Another episode")
    }

    func testBilingualTitleKeepsBothNames() {
        let p = parse(title: "Дюна / Dune (2021) смотреть онлайн", url: "https://rezka.example/x")
        XCTAssertEqual(p?.name, "Дюна")
        XCTAssertEqual(p?.altName, "Dune")
        XCTAssertEqual(p?.year, 2021)
    }

    func testEpisodeShortForm() {
        let p = parse(title: "Severance S02E04 - Watch Online", url: "https://site.example/x")
        XCTAssertEqual(p?.name, "Severance")
        XCTAssertEqual(p?.ref, EpisodeRef(season: 2, episode: 4))
        XCTAssertEqual(p?.kindHint, .series)
    }

    func testEpisodeLongForm() {
        let p = parse(title: "The Bear Season 3 Episode 7 | Stream", url: "https://site.example/x")
        XCTAssertEqual(p?.name, "The Bear")
        XCTAssertEqual(p?.ref, EpisodeRef(season: 3, episode: 7))
    }

    func testUkrainianEpisode() {
        let p = parse(title: "Розрив 2 сезон 4 серія дивитися онлайн", url: "https://site.example/x")
        XCTAssertEqual(p?.name, "Розрив")
        XCTAssertEqual(p?.ref, EpisodeRef(season: 2, episode: 4))
    }

    func testEpisodeOnlyInURL() {
        let p = parse(title: "Severance | Watch", url: "https://site.example/series/severance/season-2/episode-4")
        XCTAssertEqual(p?.name, "Severance")
        XCTAssertEqual(p?.ref, EpisodeRef(season: 2, episode: 4))
    }

    func testEpisodeInTVPath() {
        XCTAssertEqual(TitleParser.episodeRef(in: "https://site.example/tv/95396/2/4"), EpisodeRef(season: 2, episode: 4))
    }

    func testYearOnlyNameIsKept() {
        let p = parse(title: "1917 - Watch Online", url: "https://site.example/x")
        XCTAssertEqual(p?.name, "1917")
        XCTAssertNil(p?.year)
    }

    func testLinkedDataWins() {
        var meta = PageMeta()
        meta.title = "Some junk | Site"
        meta.url = "https://site.example/x"
        meta.ld = [.init(type: "TVEpisode", name: "Hello, Ms. Cobel", series: "Severance", season: 2, episode: 1, year: 2025)]
        let p = TitleParser.parse(meta)
        XCTAssertEqual(p?.name, "Severance")
        XCTAssertEqual(p?.episodeName, "Hello, Ms. Cobel")
        XCTAssertEqual(p?.ref, EpisodeRef(season: 2, episode: 1))
        XCTAssertEqual(p?.confidence ?? 0, 0.95, accuracy: 0.001)
    }

    func testFallsBackToURLSlugWithLowConfidence() {
        let p = parse(title: "", url: "https://site.example/watch/dune-part-two-19xk2")
        XCTAssertEqual(p?.name, "Dune Part Two")
        XCTAssertLessThan(p?.confidence ?? 1, 0.5)
    }

    func testOnlySiteNameGivesNoTitle() {
        XCTAssertNil(TitleParser.clean("FlixHub", siteTokens: ["flixhub"]))
    }

    func testNormalizeFoldsCaseAndPunctuation() {
        XCTAssertEqual(TitleParser.normalize("Dune: Part Two!"), "dunepart two".replacingOccurrences(of: " ", with: ""))
        XCTAssertEqual(TitleParser.normalize("Amélie"), "amelie")
    }

    func testURLKeyIgnoresTrackingAndFragments() {
        let a = URLKey.make(URL(string: "https://www.Site.example/watch/1?utm_source=x&id=5#t=10")!)
        let b = URLKey.make(URL(string: "http://site.example/watch/1/?id=5")!)
        XCTAssertEqual(a, "site.example/watch/1?id=5")
        XCTAssertEqual(b, "site.example/watch/1?id=5")
    }

    func testRegistrableDomain() {
        XCTAssertEqual(DomainName.registrable("player.vod.example.com"), "example.com")
        XCTAssertEqual(DomainName.registrable("kino.example.com.ua"), "example.com.ua")
        XCTAssertEqual(DomainName.registrable("127.0.0.1"), "127.0.0.1")
        XCTAssertTrue(DomainName.isSameSite("a.example.com", "b.example.com"))
        XCTAssertFalse(DomainName.isSameSite("example.com", "ads.net"))
    }

    func testTimecode() {
        XCTAssertEqual(Timecode.string(2530), "42:10")
        XCTAssertEqual(Timecode.string(3723), "1:02:03")
        XCTAssertEqual(Timecode.spoken(4320), "1 h 12 min")
    }

    func testQuotesInsideANameStay() {
        XCTAssertEqual(TitleParser.clean("Charlie Chaplin's \"The Rink\"", siteTokens: [])?.name, "Charlie Chaplin's \"The Rink\"")
        XCTAssertEqual(TitleParser.clean("\"Dune\"", siteTokens: [])?.name, "Dune")
        XCTAssertEqual(TitleParser.clean("Dune\"", siteTokens: [])?.name, "Dune")
        XCTAssertEqual(TitleParser.clean("Ocean's Eleven", siteTokens: [])?.name, "Ocean's Eleven")
    }
}
