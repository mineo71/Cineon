import XCTest
@testable import Cineon

@MainActor
final class SeriesDownloadTests: XCTestCase {
    private func job(_ scope: SeasonGrabber.Scope, _ episodes: [(Int, Int)]) -> SeasonGrabber.Job {
        SeasonGrabber.Job(
            scope: scope, titleID: 7, name: "The Sopranos", season: 1,
            episodes: episodes.map { EpisodeRef(season: $0.0, episode: $0.1) },
            pageURL: URL(string: "https://example.test/series/sopranos.html#t:1-s:1-e:1")!,
            startRef: EpisodeRef(season: 1, episode: 1), posterURL: nil, usesPageList: true
        )
    }

    func testLabelsSayHowMuchIsComing() {
        XCTAssertEqual(job(.season, [(1, 1), (1, 2)]).label, "The Sopranos, season 1")
        XCTAssertEqual(job(.series, [(1, 1), (2, 1), (3, 1)]).label, "The Sopranos, all 3 seasons")
        // A series that turns out to have one season says which.
        XCTAssertEqual(job(.series, [(4, 1), (4, 2)]).label, "The Sopranos, season 4")
    }

    func testRemainingSkipsWhatsBeenHandledInOrder() {
        var series = job(.series, [(1, 1), (1, 2), (2, 1), (2, 2)])
        series.queued = [EpisodeRef(season: 1, episode: 1)]
        series.missed = [EpisodeRef(season: 2, episode: 1)]
        XCTAssertEqual(series.remaining, [EpisodeRef(season: 1, episode: 2), EpisodeRef(season: 2, episode: 2)])
        XCTAssertEqual(series.handled, 2)
        XCTAssertEqual(series.seasons, [1, 2])
    }

    func testAJobSurvivesBeingSavedAndRead() throws {
        var series = job(.series, [(1, 1), (2, 3)])
        series.queued = [EpisodeRef(season: 1, episode: 1)]
        series.current = EpisodeRef(season: 2, episode: 3)
        let read = try JSONDecoder().decode(SeasonGrabber.Job.self, from: JSONEncoder().encode(series))
        XCTAssertEqual(read, series)
    }

    func testTheProposalAddsUpAndChecksTheRoom() {
        let series = job(.series, [(1, 1), (1, 2), (2, 1)])
        var proposal = SeasonGrabber.Proposal(job: series, bytesPerEpisode: 2_000, isMeasured: true, freeBytes: 10_000)
        XCTAssertEqual(proposal.totalBytes, 6_000)
        XCTAssertTrue(proposal.fits)
        XCTAssertEqual(proposal.seasonCounts.map(\.season), [1, 2])
        XCTAssertEqual(proposal.seasonCounts.map(\.count), [2, 1])
        proposal.freeBytes = 5_000
        XCTAssertFalse(proposal.fits)
        proposal.freeBytes = nil
        XCTAssertTrue(proposal.fits, "Unknown free space doesn't block anything")
    }

    func testFreeSpaceIsFoundForAFolderThatDoesntExistYet() {
        let missing = FileManager.default.temporaryDirectory.appendingPathComponent("cineon-\(UUID().uuidString)/Movies/Cineon")
        XCTAssertNotNil(SeasonGrabber.freeSpace(at: missing))
    }
}
