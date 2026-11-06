import XCTest
@testable import Cineon

@MainActor
final class DownloadTests: XCTestCase {

    private func source(_ url: String, _ kind: MediaSource.Kind = .file, at: Double = 0, current: Bool = true) -> MediaSource {
        MediaSource(url: URL(string: url)!, kind: kind, foundAt: at, isCurrent: current)
    }

    // MARK: Picking the film's file

    func testPlainFileBeingPlayedWins() {
        let sources = [source("https://cdn.test/a/1080.mp4", at: 1), source("https://cdn.test/a/480.mp4", at: 2)]
        let best = MediaSource.best(of: sources, playing: "https://cdn.test/a/480.mp4")
        XCTAssertEqual(best?.url.absoluteString, "https://cdn.test/a/480.mp4")
    }

    func testHighestQualityWhenPlayingFromAMediaSource() {
        let sources = [source("https://cdn.test/a/480.mp4", at: 1), source("https://cdn.test/a/1080.mp4", at: 2), source("https://cdn.test/a/720.mp4", at: 3)]
        XCTAssertEqual(MediaSource.best(of: sources, playing: "blob:https://site.test/x")?.quality, "1080p")
    }

    func testFilesFromTheVideoBeforeThisOneAreIgnored() {
        let sources = [source("https://cdn.test/ep1/1080.mp4", current: false), source("https://cdn.test/ep2/720.mp4", at: 5)]
        XCTAssertEqual(MediaSource.best(of: sources, playing: nil)?.url.path, "/ep2/720.mp4")
    }

    func testWholeFileBeatsPlaylist() {
        let sources = [source("https://cdn.test/master.m3u8", .hls, at: 1), source("https://cdn.test/film.mp4", at: 2)]
        XCTAssertEqual(MediaSource.best(of: sources, playing: nil)?.kind, .file)
    }

    func testFirstPlaylistIsTheMaster() {
        let sources = [source("https://cdn.test/master.m3u8", .hls, at: 1), source("https://cdn.test/v1/index.m3u8", .hls, at: 2)]
        XCTAssertEqual(MediaSource.best(of: sources, playing: nil)?.url.path, "/master.m3u8")
    }

    func testSubtitlesAreNeverTheFilm() {
        XCTAssertNil(MediaSource.best(of: [source("https://cdn.test/en.vtt", .subtitle)], playing: nil))
    }

    func testQualityFromAddresses() {
        XCTAssertEqual(MediaSource.quality(in: "https://x.test/film_720p.mp4"), "720p")
        XCTAssertEqual(MediaSource.quality(in: "https://x.test/stream/1080.mp4"), "1080p")
        XCTAssertNil(MediaSource.quality(in: "https://x.test/stream/abc.mp4"))
    }

    // MARK: File names

    func testFileNameForAnEpisode() {
        let item = makeItem(name: "Severance", ref: EpisodeRef(season: 1, episode: 2), quality: "1080p")
        XCTAssertEqual(item.fileBaseName, "Severance S01E02 [1080p]")
    }

    func testFileNameDropsCharactersFinderRefuses() {
        let item = makeItem(name: "Mission: Impossible / Dead Reckoning", ref: .none, quality: nil)
        XCTAssertFalse(item.fileBaseName.contains("/"))
        XCTAssertFalse(item.fileBaseName.contains(":"))
        XCTAssertTrue(item.fileBaseName.hasPrefix("Mission"))
    }

    private func makeItem(name: String, ref: EpisodeRef, quality: String?) -> DownloadItem {
        DownloadItem(
            id: 1, titleID: nil, ref: ref, name: name, sourceURL: URL(string: "https://x.test/a.mp4")!, pageURL: nil,
            referer: nil, host: "x.test", kind: .file, quality: quality, file: nil, subtitles: [], bytes: 0, totalBytes: 0,
            status: .queued, error: nil, position: 0, duration: 0, posterURL: nil, createdAt: .now, finishedAt: nil, playedAt: nil
        )
    }

    // MARK: Subtitles

    func testParsesWebVTT() {
        let vtt = """
        WEBVTT

        1
        00:00:01.500 --> 00:00:04.000 align:center
        <i>Hello</i> there

        00:01:05.000 --> 00:01:07.250
        Second line
        and more
        """
        let cues = SubtitleTrack.parse(vtt)
        XCTAssertEqual(cues.count, 2)
        XCTAssertEqual(cues[0].start, 1.5, accuracy: 0.001)
        XCTAssertEqual(cues[0].text, "Hello there")
        XCTAssertEqual(cues[1].end, 67.25, accuracy: 0.001)
        XCTAssertEqual(cues[1].text, "Second line\nand more")
    }

    func testParsesSubRipWithWindowsLineEnds() {
        let srt = "1\r\n00:00:02,000 --> 00:00:03,000\r\nПривіт\r\n\r\n2\r\n00:00:05,000 --> 00:00:06,000\r\nDruhyi\r\n"
        let cues = SubtitleTrack.parse(srt)
        XCTAssertEqual(cues.count, 2)
        XCTAssertEqual(cues[0].text, "Привіт")
        XCTAssertEqual(cues[1].start, 5, accuracy: 0.001)
    }

    func testFindsTheCueOnScreen() {
        let track = SubtitleTrack(id: "x", label: "English", cues: [
            SubtitleCue(start: 1, end: 3, text: "one"),
            SubtitleCue(start: 5, end: 8, text: "two"),
            SubtitleCue(start: 6, end: 7, text: "overlap"),
        ])
        XCTAssertNil(track.text(at: 0.5))
        XCTAssertEqual(track.text(at: 2), "one")
        XCTAssertNil(track.text(at: 4))
        XCTAssertEqual(track.text(at: 6.5), "two\noverlap")
        XCTAssertEqual(track.text(at: 7.5), "two")
    }

    func testLanguageFromSubtitleAddress() {
        XCTAssertEqual(SubtitleTrack.label(for: URL(string: "https://x.test/subs/film_eng.vtt")!, index: 0), "en")
        XCTAssertEqual(SubtitleTrack.label(for: URL(string: "https://x.test/subs/ukr/1.vtt")!, index: 0), "uk")
        XCTAssertEqual(SubtitleTrack.label(for: URL(string: "https://x.test/s/1234.vtt")!, index: 2), "sub3")
    }

    // MARK: Storage

    func testDatabaseFromBeforeDownloadsUpgrades() throws {
        let path = NSTemporaryDirectory() + "cineon-test-\(UUID().uuidString).sqlite"
        let older = try Database(path: path)
        try older.sql.exec("""
        DROP TABLE downloads;
        DROP TABLE episode_alerts;
        ALTER TABLE titles DROP COLUMN rated_at;
        ALTER TABLE titles DROP COLUMN status_at;
        PRAGMA user_version=2
        """)
        older.sql.close()

        let upgraded = try Database(path: path)
        XCTAssertEqual(upgraded.sql.userVersion, 4)
        var item = makeItem(name: "Arrival", ref: .none, quality: "720p")
        item.subtitles = ["/tmp/a.en.vtt", "/tmp/a.uk.vtt"]
        item.id = try upgraded.insertDownload(item)
        item.status = .done
        item.position = 42
        try upgraded.updateDownload(item)
        let loaded = try upgraded.allDownloads()
        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded[0].status, .done)
        XCTAssertEqual(loaded[0].position, 42)
        XCTAssertEqual(loaded[0].subtitles, item.subtitles)
        XCTAssertEqual(loaded[0].quality, "720p")
    }

    // MARK: Codes

    func testCodesAreTypedAnyWay() {
        XCTAssertEqual(ShareCode.normalize(" k7q-2mx "), "K7Q2MX")
        XCTAssertEqual(ShareCode.display("k7q2mx"), "K7Q-2MX")
    }

    func testPartyPositionMovesOnWhilePlaying() {
        let state = PartyState(
            code: "ABCDEF", ended: false, hostId: "h", hostName: "Host", title: nil, pageUrl: "", playing: true,
            position: 100, rate: 1.5, updatedAt: 1_000, now: 5_000, members: [], reactions: []
        )
        XCTAssertEqual(state.expectedPosition, 106, accuracy: 0.001)
        var paused = state
        paused.playing = false
        XCTAssertEqual(paused.expectedPosition, 100, accuracy: 0.001)
    }
}
