import AppKit
import Observation
import WebKit

/// Downloads a season, or every season of a series. A hidden tab opens each episode in turn,
/// waits for its player to ask for the file, and hands that to the download queue. Each link is
/// fetched just before its turn, because streaming sites' links expire while they wait. The job is
/// saved as it goes, so one that's still running when Cineon closes can carry on next time.
@Observable
final class SeasonGrabber {
    enum Scope: String, Codable {
        case season
        case series
    }

    struct Job: Equatable, Codable {
        var scope: Scope
        var titleID: Int64?
        var name: String
        var season: Int
        var episodes: [EpisodeRef]
        var queued: [EpisodeRef] = []
        var missed: [EpisodeRef] = []
        var current: EpisodeRef?
        var pageURL: URL
        var startRef: EpisodeRef
        var posterURL: URL?
        var usesPageList: Bool
        var isFinished = false
        /// Stopped when Cineon closed, and waiting to carry on.
        var isPaused = false

        var seasons: [Int] { Array(Set(episodes.map(\.season))).sorted() }

        var label: String {
            switch scope {
            case .season: return season > 0 ? "\(name), season \(season)" : name
            case .series:
                let seasons = seasons
                return seasons.count == 1 ? "\(name), season \(seasons[0])" : "\(name), all \(seasons.count) seasons"
            }
        }

        var handled: Int { queued.count + missed.count }
        /// What's left to look for, in order.
        var remaining: [EpisodeRef] { episodes.filter { !queued.contains($0) && !missed.contains($0) } }
    }

    /// A whole series, found and waiting for a yes, because it can be very big.
    struct Proposal: Equatable {
        var job: Job
        var bytesPerEpisode: Int64
        /// From episodes downloaded before, rather than a round guess.
        var isMeasured: Bool
        var freeBytes: Int64?

        var totalBytes: Int64 { bytesPerEpisode * Int64(job.episodes.count) }
        var fits: Bool { freeBytes.map { totalBytes < $0 } ?? true }

        var seasonCounts: [(season: Int, count: Int)] {
            Dictionary(grouping: job.episodes, by: \.season).map { ($0.key, $0.value.count) }.sorted { $0.season < $1.season }
        }
    }

    private(set) var job: Job?
    private(set) var proposal: Proposal?
    /// Finding a whole series' seasons and episodes, before asking.
    private(set) var isLooking = false

    @ObservationIgnored private unowned let session: ProfileSession
    @ObservationIgnored private var helper: BrowserTab?
    @ObservationIgnored private var window: NSWindow?
    @ObservationIgnored private var runner: Task<Void, Never>?
    @ObservationIgnored private var used: Set<URL> = []

    /// How long one episode's player gets to ask for its file.
    static let episodeTimeout: Double = 45
    /// A guess for an episode's size when nothing has been downloaded yet to go by.
    static let guessedBytesPerEpisode: Int64 = 1_000_000_000

    init(session: ProfileSession) {
        self.session = session
        restore()
    }

    var isRunning: Bool { job.map { !$0.isFinished && !$0.isPaused } ?? false }
    var isBusy: Bool { isRunning || isLooking }

    // MARK: Starting

    /// Starts from the series in this tab. `fromCurrent` leaves out the episodes before the one on screen.
    func start(from tab: BrowserTab, fromCurrent: Bool) {
        guard let prepared = prepare(tab) else { return }
        let (pageURL, ref, title, name) = prepared
        runner = Task { [weak self, weak tab] in
            guard let self else { return }
            let (episodes, onPage) = await self.episodeList(season: ref.season, title: title, tab: tab, pageURL: pageURL, current: ref)
            if Task.isCancelled { return }
            var list = fromCurrent ? episodes.filter { ($0.season, $0.episode) >= (ref.season, ref.episode) } : episodes
            // What's already on this Mac, or on its way, isn't fetched twice.
            let have = self.have(titleID: title?.id, name: name)
            list.removeAll { have.contains($0) }
            guard !episodes.isEmpty else {
                self.session.toasts.show("Cineon couldn't find this season's episodes")
                return
            }
            guard !list.isEmpty else {
                self.session.toasts.show("Every episode of this season is already on this Mac")
                return
            }
            self.launch(Job(
                scope: .season, titleID: title?.id, name: name, season: ref.season, episodes: list, pageURL: pageURL,
                startRef: ref, posterURL: title?.posterURL ?? tab?.parsed?.posterURL, usesPageList: onPage
            ))
        }
    }

    /// Finds every season of the series in this tab and asks before getting them.
    func startSeries(from tab: BrowserTab) {
        guard let prepared = prepare(tab) else { return }
        let (pageURL, ref, title, name) = prepared
        isLooking = true
        session.toasts.show("Looking for every episode of \(name)…")
        runner = Task { [weak self, weak tab] in
            guard let self else { return }
            defer { self.isLooking = false }
            let seasons = await self.seasonList(title: title, tab: tab, pageURL: pageURL, current: ref)
            var episodes: [EpisodeRef] = []
            var onPage = false
            for season in seasons {
                if Task.isCancelled { return }
                let (list, fromPage) = await self.episodeList(season: season, title: title, tab: tab, pageURL: pageURL, current: ref)
                episodes += list
                onPage = onPage || fromPage
            }
            if Task.isCancelled { return }
            let have = self.have(titleID: title?.id, name: name)
            let wanted = episodes.filter { !have.contains($0) }
            guard !episodes.isEmpty else {
                self.session.toasts.show("Cineon couldn't find the episodes of \(name)")
                return
            }
            guard !wanted.isEmpty else {
                self.session.toasts.show("Every episode of \(name) is already on this Mac")
                return
            }
            let job = Job(
                scope: .series, titleID: title?.id, name: name, season: ref.season, episodes: wanted, pageURL: pageURL,
                startRef: ref, posterURL: title?.posterURL ?? tab?.parsed?.posterURL, usesPageList: onPage
            )
            let (perEpisode, measured) = self.bytesPerEpisode()
            self.proposal = Proposal(
                job: job, bytesPerEpisode: perEpisode, isMeasured: measured,
                freeBytes: Self.freeSpace(at: self.session.downloads.folder)
            )
        }
    }

    /// Yes to the whole series.
    func confirm() {
        guard let proposal else { return }
        self.proposal = nil
        launch(proposal.job)
    }

    func decline() {
        proposal = nil
    }

    /// Carries on with a job that stopped when Cineon closed.
    func resume() {
        guard var paused = job, paused.isPaused, !isBusy else { return }
        let have = have(titleID: paused.titleID, name: paused.name)
        // Episodes queued last time whose download stopped with Cineon go round again, without
        // leaving their stopped copies behind in Downloads.
        for item in session.downloads.items where item.status == .failed && paused.episodes.contains(item.ref)
            && (paused.titleID != nil ? item.titleID == paused.titleID : item.name == paused.name)
        {
            session.downloads.remove(item.id)
        }
        paused.queued = paused.queued.filter { have.contains($0) }
        paused.missed = []
        paused.isPaused = false
        job = paused
        persist()
        session.toasts.show("Carrying on with \(paused.label): \(paused.remaining.count) to go")
        runner = Task { [weak self] in await self?.run() }
    }

    func cancel() {
        proposal = nil
        runner?.cancel()
        runner = nil
        finish(cancelled: true)
    }

    /// The profile is closing: stop now, and keep the job to carry on with next time.
    func suspend() {
        proposal = nil
        runner?.cancel()
        runner = nil
        tearDown()
        guard var current = job, !current.isFinished else { return }
        current.isPaused = true
        current.current = nil
        job = current
        persist()
    }

    func dismiss() {
        guard job?.isFinished == true else { return }
        job = nil
        persist()
    }

    private func prepare(_ tab: BrowserTab) -> (URL, EpisodeRef, Title?, String)? {
        guard !isBusy else {
            session.toasts.show(isLooking ? "Still looking for the episodes" : "Already getting \(job?.label ?? "a season")")
            return nil
        }
        guard let pageURL = tab.url, let ref = tab.track?.ref ?? tab.parsed?.ref, ref.isEpisode else {
            session.toasts.show("Open an episode of the series first")
            return nil
        }
        let title = session.downloads.libraryTitle(for: tab)
        return (pageURL, ref, title, title?.name ?? tab.parsed?.name ?? tab.displayTitle)
    }

    private func launch(_ new: Job) {
        job = new
        persist()
        session.toasts.show("Getting \(new.episodes.count) episode\(new.episodes.count == 1 ? "" : "s") of \(new.label)")
        runner = Task { [weak self] in await self?.run() }
    }

    /// Episodes of this title already on this Mac or on their way.
    private func have(titleID: Int64?, name: String) -> Set<EpisodeRef> {
        Set(session.downloads.items.filter { item in
            item.status != .failed && (titleID != nil ? item.titleID == titleID : item.name == name)
        }.map(\.ref))
    }

    /// How big an episode is likely to be: the average of the episodes downloaded before, or a gigabyte.
    private func bytesPerEpisode() -> (Int64, Bool) {
        let sizes = session.downloads.items.filter { $0.status == .done && $0.ref.isEpisode && $0.totalBytes > 0 }.map(\.totalBytes)
        guard !sizes.isEmpty else { return (Self.guessedBytesPerEpisode, false) }
        return (sizes.reduce(0, +) / Int64(sizes.count), true)
    }

    nonisolated static func freeSpace(at folder: URL) -> Int64? {
        var url = folder
        while !FileManager.default.fileExists(atPath: url.path), url.pathComponents.count > 1 {
            url.deleteLastPathComponent()
        }
        return (try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?.volumeAvailableCapacityForImportantUsage
    }

    // MARK: Finding the episodes

    /// Every season of the series: from the page's own list, the published episode list, or by
    /// trying the first episode of each season's address.
    private func seasonList(title: Title?, tab: BrowserTab?, pageURL: URL, current: EpisodeRef) async -> [Int] {
        var seasons: Set<Int> = [current.season]
        if let tab, let numbers = await tab.evaluateInPage("window.__cineon ? __cineon.seasonsOnPage() : []") as? [NSNumber] {
            seasons.formUnion(numbers.map(\.intValue).filter { $0 > 0 })
        }
        if seasons.count == 1, let title {
            let aired = await session.metadata.episodes(for: title).filter { $0.season > 0 && ($0.released ?? .distantPast) <= .now }
            seasons.formUnion(aired.map(\.season))
        }
        if seasons.count == 1 {
            for season in 1...30 where season != current.season {
                if Task.isCancelled { break }
                guard let url = EpisodeLinks.url(from: pageURL, current: current, target: EpisodeRef(season: season, episode: 1)) else { break }
                if case .alive = await SiteProbe.check(url) { seasons.insert(season) } else if season > current.season { break }
            }
        }
        return seasons.sorted()
    }

    /// The season's episodes: from the page's own list, the published list, or by trying addresses.
    private func episodeList(season: Int, title: Title?, tab: BrowserTab?, pageURL: URL, current: EpisodeRef) async -> ([EpisodeRef], Bool) {
        if let tab, let numbers = await tab.evaluateInPage("window.__cineon ? __cineon.episodesOnPage(\(season)) : []") as? [NSNumber],
           !numbers.isEmpty {
            return (numbers.map { EpisodeRef(season: season, episode: $0.intValue) }, true)
        }
        if let title {
            let aired = await session.metadata.episodes(for: title)
                .filter { $0.season == season && $0.episode > 0 && ($0.released ?? .distantPast) <= .now }
                .map { EpisodeRef(season: $0.season, episode: $0.episode) }
                .sorted { $0.episode < $1.episode }
            if !aired.isEmpty, EpisodeLinks.url(from: pageURL, current: current, target: aired[0]) != nil { return (aired, false) }
        }
        // Nothing published: walk the addresses until one is missing. In the season on screen the
        // walk goes at least as far as the episode playing.
        let floor = season == current.season ? current.episode : 0
        var found: [EpisodeRef] = []
        for number in 1...60 {
            if Task.isCancelled { break }
            let ref = EpisodeRef(season: season, episode: number)
            if ref == current { found.append(ref); continue }
            guard let url = EpisodeLinks.url(from: pageURL, current: current, target: ref) else { return ([], false) }
            if case .alive = await SiteProbe.check(url) { found.append(ref) } else if number > floor { break }
        }
        return (found, false)
    }

    // MARK: Running

    private func run() async {
        guard let job else { return }
        let tab = BrowserTab(browser: session.browser)
        tab.isHelper = true
        tab.makeHelperWebView()
        helper = tab
        if let view = tab.webView { host(view) }
        used = []
        tab.load(job.pageURL)
        _ = await waitForSource(in: tab, stale: [], timeout: 20)

        for ref in job.remaining {
            // Links expire, so each one is fetched only when there's room to start it.
            // Cancelled first, always: a closed profile mustn't be touched again.
            while true {
                if Task.isCancelled { return }
                if session.downloads.hasFreeSlot { break }
                try? await Task.sleep(for: .seconds(1.5))
            }
            self.job?.current = ref
            persist()
            let found = await resolve(ref, in: tab)
            if Task.isCancelled { return }
            if let source = found, let current = self.job {
                used.insert(source.url)
                let subtitles = tab.sources.filter { $0.kind == .subtitle && $0.isCurrent }.prefix(6).map(\.url)
                session.downloads.enqueue(
                    source: source, titleID: current.titleID, ref: ref, name: current.name,
                    pageURL: EpisodeLinks.url(from: current.pageURL, current: current.startRef, target: ref) ?? current.pageURL,
                    referer: tab.sourcesFrameURL ?? current.pageURL.absoluteString, duration: tab.media?.duration ?? 0,
                    posterURL: current.posterURL, webView: tab.webView, subtitles: Array(subtitles)
                )
                self.job?.queued.append(ref)
            } else {
                self.job?.missed.append(ref)
            }
            persist()
            tab.pausePlayback()
        }
        finish(cancelled: false)
    }

    /// Opens one episode in the helper tab and waits for the file its player asks for.
    private func resolve(_ ref: EpisodeRef, in tab: BrowserTab) async -> MediaSource? {
        guard let job else { return nil }
        // The page opened on this episode, so what it loaded is already it.
        if ref == job.startRef, let best = tab.bestSource, best.kind != .subtitle, !used.contains(best.url) {
            return best
        }
        let stale = Set(tab.sources.map(\.url)).union(used)
        if job.usesPageList,
           await tab.evaluateInPage("__cineon.openEpisode(\(ref.season),\(ref.episode),false)") as? Bool ?? false {
            if let found = await waitForSource(in: tab, stale: stale, timeout: Self.episodeTimeout) { return found }
            if Task.isCancelled { return nil }
            // The page's list didn't switch it, which can happen in another season: try its address.
        }
        guard let url = EpisodeLinks.url(from: job.pageURL, current: job.startRef, target: ref) else { return nil }
        let onlyFragment = tab.webView?.url.map { Self.withoutFragment($0) } == Self.withoutFragment(url)
        tab.load(url)
        if onlyFragment { tab.webView?.reload() }
        return await waitForSource(in: tab, stale: used, timeout: Self.episodeTimeout)
    }

    private func waitForSource(in tab: BrowserTab, stale: Set<URL>, timeout: Double) async -> MediaSource? {
        let deadline = Date.now.addingTimeInterval(timeout)
        var nudged = Date.distantPast
        while Date.now < deadline {
            if Task.isCancelled { return nil }
            if let best = tab.bestSource, best.kind != .subtitle, best.isCurrent, !stale.contains(best.url) { return best }
            // Many players only fetch their file once they play.
            if Date.now.timeIntervalSince(nudged) > 4 {
                nudged = .now
                _ = await tab.evaluateInPage("window.__cineon ? __cineon.playQuietly() : false")
            }
            try? await Task.sleep(for: .seconds(0.5))
        }
        return nil
    }

    private func finish(cancelled: Bool) {
        tearDown()
        guard var done = job, !done.isFinished else { return }
        done.isFinished = true
        done.isPaused = false
        done.current = nil
        job = done
        persist()
        if cancelled {
            session.toasts.show("Stopped getting \(done.label)")
        } else if done.missed.isEmpty {
            session.toasts.show("All \(done.queued.count) episodes of \(done.label) are downloading")
        } else {
            let missed = done.missed.map(\.shortLabel).joined(separator: ", ")
            session.toasts.show("Queued \(done.queued.count) of \(done.episodes.count). Couldn't find the file for \(missed)")
        }
    }

    private func tearDown() {
        helper?.tearDownWebView()
        helper = nil
        window?.orderOut(nil)
        window = nil
    }

    // MARK: Keeping the job

    private var jobFile: URL { AppPaths.profile(session.profile.id).appendingPathComponent("download-job.json") }

    /// Written after every step, so a job is never lost to Cineon closing. A finished one is forgotten.
    private func persist() {
        guard let job, !job.isFinished else {
            try? FileManager.default.removeItem(at: jobFile)
            return
        }
        if let data = try? JSONEncoder().encode(job) { try? data.write(to: jobFile, options: .atomic) }
    }

    private func restore() {
        guard let data = try? Data(contentsOf: jobFile), var saved = try? JSONDecoder().decode(Job.self, from: data), !saved.isFinished
        else { return }
        saved.isPaused = true
        saved.current = nil
        job = saved
        session.toasts.show(
            "Getting \(saved.label) stopped when Cineon closed",
            action: Toast.Action(title: "Carry on") { [weak self] in self?.resume() }
        )
    }

    // MARK: The helper's window

    /// The helper's player has to be in a window to load. This one is off screen and never shown.
    private func host(_ view: WKWebView) {
        let frame = NSRect(x: -30000, y: -30000, width: 960, height: 540)
        let window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.ignoresMouseEvents = true
        window.contentView = view
        // Not in the public API. Without it a window nobody can see counts as hidden, and players pause.
        WebKitEnvironment.setPrivate(view, "windowOcclusionDetectionEnabled", false)
        window.orderBack(nil)
        self.window = window
    }

    private static func withoutFragment(_ url: URL) -> String {
        var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        parts?.fragment = nil
        return parts?.string ?? url.absoluteString
    }
}
