import AppKit
import Observation
import SwiftUI
import WebKit

enum Route: Hashable {
    case home, library, timeline, web, settings, downloads, player, together, profile, rate
}

enum AppSheet: Identifiable, Equatable {
    case addSite(prefill: String?)
    case editSite(Int64)
    case addTitle(query: String?)
    case relink
    case importBrowser
    case newChallenge

    var id: String {
        switch self {
        case .addSite: "addSite"
        case .editSite(let id): "editSite\(id)"
        case .addTitle: "addTitle"
        case .relink: "relink"
        case .importBrowser: "importBrowser"
        case .newChallenge: "newChallenge"
        }
    }
}

/// The whole app's state: who's watching, what's on screen, and the commands that change it.
@Observable
final class AppModel {
    let profiles = ProfileStore()
    let filters = FilterEngine()
    let toasts = ToastCenter()
    let ambient = AmbientModel()

    private(set) var session: ProfileSession
    var route: Route = .home {
        didSet {
            if route != .web { isFindVisible = false }
            if oldValue == .player, route != .player { closePlayer() }
        }
    }
    /// The downloaded film playing in the native player.
    private(set) var localPlayback: LocalPlayback?
    /// Stops playback after a while, or at the end of what's on.
    private(set) var sleepTimer: SleepTimerState?
    /// The next downloaded episode, about to start in the native player.
    private(set) var upNext: UpNext?
    @ObservationIgnored let nowPlaying = NowPlayingCenter()
    /// For Siri and Shortcuts, which run outside any view.
    @ObservationIgnored static weak var shared: AppModel?
    var isCommandBarVisible = false
    var commandBarSeed = ""
    var detailTitleID: Int64?
    var sheet: AppSheet?
    var isProfilePickerVisible = false
    var isFindVisible = false
    var isCinema = false
    var isSidebarPeeking = false
    var isChangingReel = false
    var splashVisible = true
    @ObservationIgnored weak var window: NSWindow?

    private var ambientTimer: Timer?
    private var playbackTimer: Timer?
    /// A downloaded episode watched to its end, binned once the player moves past it.
    private var watchedDownloadID: Int64?
    /// The tab that played last, so a paused film can still be resumed from a media key.
    @ObservationIgnored private weak var lastPlayedTab: BrowserTab?
    private var cinemaKeyMonitor: Any?
    private var snapshotCounter = 0
    private var isSamplingWindow = false
    private var windowCaptureFails = 0

    init() {
        do {
            session = try ProfileSession(profile: profiles.lastUsed, filters: filters, toasts: toasts)
        } catch {
            fatalError("Can't open the Cineon database: \(error)")
        }
        session.app = self
        isProfilePickerVisible = profiles.askOnLaunch && profiles.profiles.count > 1
        filters.onChange = { [weak self] in self?.session.applyRules() }
        session.start()
        Task { [weak self] in
            await self?.filters.prepare()
            self?.session.applyRules()
            await self?.filters.updateIfDue()
        }
        ambientTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.tickAmbient()
                self?.tickStayAwake()
            }
        }
        playbackTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tickPlayback() }
        }
        Self.shared = self
        nowPlaying.install(app: self)
        NotificationRouter.shared.install(app: self)
    }

    // MARK: Playing

    /// The native player when it's open, otherwise the tab with the film.
    var activePlayer: ActivePlayer? {
        if let localPlayback { return .local(localPlayback) }
        if let tab = browser.tabs.first(where: { $0.media?.isPlaying == true }) { return .web(tab) }
        if let tab = lastPlayedTab, tab.media != nil, browser.tabs.contains(where: { $0 === tab }) { return .web(tab) }
        if let tab = browser.playingTab, tab.media != nil { return .web(tab) }
        return nil
    }

    func togglePlayback() {
        if let player = activePlayer {
            player.toggle()
        } else if let first = library.continueWatching.first {
            resume(url: first.progress.url ?? first.title.posterURL ?? URL(fileURLWithPath: "/"), at: first.progress.position)
        }
    }

    func openTitle(_ id: Int64) {
        guard library.titles[id] != nil else { return }
        if route == .player { route = .downloads }
        detailTitleID = id
    }

    /// The next episode: the next download in the native player, or the next one on the site.
    func playNextEpisode() {
        switch activePlayer {
        case .local(let playback):
            guard let next = session.downloads.nextEpisode(after: playback.downloadItem) else {
                toasts.show("The next episode isn't on this Mac")
                return
            }
            playDownload(next)
        case .web(let tab):
            session.autopilot.skipToNext(tab: tab)
        case nil:
            break
        }
    }

    /// Carries on with whatever was watched last, or a title named by Siri.
    func continueWatching(titleID: Int64? = nil) {
        let entries = library.continueWatching
        let entry = titleID.flatMap { id in entries.first { $0.title.id == id } } ?? (titleID == nil ? entries.first : nil)
        if let entry, let url = entry.progress.url {
            resume(url: url, at: entry.progress.position)
        } else if let titleID {
            openTitle(titleID)
        } else {
            toasts.show("Nothing to carry on with yet")
        }
    }

    // MARK: Sleep timer

    func startSleepTimer(_ mode: SleepTimerMode) {
        if sleepTimer?.isFading == true { activePlayer?.cancelFade() }
        var state = SleepTimerState(mode: mode)
        switch mode {
        case .minutes(let minutes): state.deadline = Date.now.addingTimeInterval(Double(minutes) * 60)
        case .endOfItem:
            guard let player = activePlayer else {
                toasts.show("Start something first, then set the timer for its end")
                return
            }
            state.item = player.identity
            if case .web(let tab) = player { tab.autopilot.isHeldForSleep = true }
        }
        sleepTimer = state
        toasts.show(mode == .endOfItem ? "Playback stops at the end of this" : "Playback stops in \(mode.label)")
    }

    /// For tests and Siri: a timer that runs out in this many seconds.
    func startSleepTimer(seconds: Double) {
        startSleepTimer(.minutes(max(1, Int(seconds / 60))))
        sleepTimer?.deadline = Date.now.addingTimeInterval(seconds)
    }

    func cancelSleepTimer() {
        guard let timer = sleepTimer else { return }
        if timer.isFading { activePlayer?.cancelFade() }
        releaseSleepHold()
        sleepTimer = nil
    }

    var sleepTimerRemaining: Double? { sleepTimer?.remaining(player: activePlayer) }

    private func releaseSleepHold() {
        for tab in browser.tabs { tab.autopilot.isHeldForSleep = false }
    }

    private func tickPlayback() {
        if let tab = browser.tabs.first(where: { $0.media?.isPlaying == true }) { lastPlayedTab = tab }
        nowPlaying.update(activePlayer, library: library)
        tickSleepTimer()
        tickUpNext()
    }

    private func tickSleepTimer() {
        guard var timer = sleepTimer else { return }
        let player = activePlayer
        if timer.mode == .endOfItem {
            // What was on ended, or something else took its place.
            guard let player, player.identity == timer.item else {
                finishSleepTimer(paused: false)
                return
            }
            if case .web(let tab) = player { tab.autopilot.isHeldForSleep = true }
        }
        guard let remaining = timer.remaining(player: player) else { return }
        if remaining <= SleepTimerState.fadeSeconds, !timer.isFading, let player, player.isPlaying {
            player.fadeOut(over: max(1, remaining))
            timer.isFading = true
            sleepTimer = timer
            return
        }
        if timer.mode != .endOfItem, remaining <= 0 {
            player?.pause()
            finishSleepTimer(paused: true)
        } else if timer.isFading, player?.isPlaying == false {
            finishSleepTimer(paused: true)
        }
    }

    private func finishSleepTimer(paused: Bool) {
        sleepTimer = nil
        releaseSleepHold()
        if paused { toasts.show("Sleep timer paused the film. Good night") }
    }

    // MARK: Up next

    private func localPlaybackEnded(_ playback: LocalPlayback) {
        let item = playback.downloadItem
        if item.ref.isEpisode { watchedDownloadID = item.id }
        if sleepTimer?.mode == .endOfItem {
            finishSleepTimer(paused: true)
            return
        }
        guard settings.playNextDownload, let next = session.downloads.nextEpisode(after: item) else { return }
        upNext = UpNext(item: next, startsAt: Date.now.addingTimeInterval(8))
    }

    private func tickUpNext() {
        guard let upNext, Date.now >= upNext.startsAt else { return }
        playUpNext()
    }

    func playUpNext() {
        guard let upNext else { return }
        self.upNext = nil
        playDownload(upNext.item)
    }

    func cancelUpNext() { upNext = nil }

    /// Bins the episode just watched, if that's what this person wants.
    private func binWatchedDownload(except keep: Int64? = nil) {
        guard let id = watchedDownloadID, id != keep else { return }
        watchedDownloadID = nil
        if settings.binWatchedDownloads { session.downloads.binWatched(id) }
    }

    // MARK: Staying awake

    private let stayAwake = StayAwake()

    /// The screen stays on while something plays. A page that stopped reporting, because its video
    /// is stuck buffering or gone, lets the Mac sleep again after a few quiet seconds.
    private func tickStayAwake() {
        let now = Date.now
        let webPlaying = browser.tabs.contains { tab in
            guard tab.media?.isPlaying == true, let last = tab.lastPlaybackReport else { return false }
            return now.timeIntervalSince(last) < 15
        }
        stayAwake.hold(webPlaying || localPlayback?.isPlaying == true)
    }

    var settings: AppSettings {
        get { session.settings }
        set { session.settings = newValue }
    }

    var palette: Palette { session.settings.theme == .dark ? .dark : .white }
    var browser: BrowserModel { session.browser }
    var library: LibraryStore { session.library }

    // MARK: Profiles

    /// Swaps everything over behind the reel change transition, as a projectionist would.
    func switchProfile(to profile: Profile) {
        isProfilePickerVisible = false
        guard profile.id != session.profile.id else { return }
        withAnimation(.easeIn(duration: 0.22)) { isChangingReel = true }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.26) { [self] in
            profiles.setPoster(session.profile.id, url: session.latestPosterURL)
            session.close()
            ambient.clear()
            detailTitleID = nil
            sheet = nil
            route = .home
            do {
                let next = try ProfileSession(profile: profile, filters: filters, toasts: toasts)
                next.app = self
                session = next
                profiles.markUsed(profile.id)
                next.start()
            } catch {
                toasts.show("Couldn't open \(profile.name)'s profile: \(error.localizedDescription)")
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.32) {
                withAnimation(.easeOut(duration: 0.3)) { self.isChangingReel = false }
            }
        }
    }

    func prepareToQuit() {
        profiles.setPoster(session.profile.id, url: session.latestPosterURL)
        session.close()
    }

    // MARK: Navigation

    func go(_ destination: Route) {
        browser.endSearch(keeping: nil)
        withAnimation(Motion.quick) { route = destination }
        if destination == .web { browser.selected?.ensureWebView() }
    }

    func openCommandBar(seed: String = "") {
        commandBarSeed = seed
        withAnimation(Motion.pop) { isCommandBarVisible = true }
    }

    func closeCommandBar() {
        withAnimation(Motion.quick) { isCommandBarVisible = false }
    }

    func toggleSidebar() {
        withAnimation(Motion.layout) { session.settings.sidebarHidden.toggle() }
    }

    func toggleTheme() {
        withAnimation(.easeInOut(duration: 0.35)) {
            session.settings.theme = session.settings.theme == .dark ? .white : .dark
        }
    }

    // MARK: Watching

    /// Takes you to where you stopped, on the site you stopped on.
    func resume(_ title: Title) {
        detailTitleID = nil
        if let progress = library.latestProgress(titleID: title.id), let url = progress.url {
            resume(url: url, at: progress.position)
        } else {
            browser.searchEverywhere(title.name, titleID: title.id)
        }
    }

    func resume(url: URL, at position: Double?) {
        detailTitleID = nil
        // Stopped watching a download: carry on with the copy on this Mac.
        if url.isFileURL {
            if let download = session.downloads.item(forFile: url) {
                playDownload(download)
            } else {
                toasts.show("That file isn't on this Mac anymore")
            }
            return
        }
        browser.open(url: url, resumeAt: position, keepWatching: true)
        route = .web
    }

    // MARK: Downloads

    /// Saves the video playing in the current tab to this Mac.
    func downloadCurrentVideo() {
        guard let tab = browser.selected, route == .web, tab.webView != nil else {
            toasts.show("Open a film's page first, then download it from there")
            return
        }
        session.downloads.download(from: tab)
    }

    func playDownload(_ item: DownloadItem) {
        detailTitleID = nil
        guard item.status == .done else {
            go(.downloads)
            return
        }
        browser.playingTab?.pausePlayback()
        localPlayback?.stop()
        upNext = nil
        binWatchedDownload(except: item.id)
        guard let fresh = session.downloads.item(item.id),
              let playback = LocalPlayback(download: fresh, session: session) else {
            toasts.show("\(item.fileBaseName) isn't in \(session.downloads.folder.lastPathComponent) anymore")
            return
        }
        playback.onEnded = { [weak self, weak playback] in
            guard let self, let playback else { return }
            self.localPlaybackEnded(playback)
        }
        localPlayback = playback
        withAnimation(Motion.quick) { route = .player }
    }

    func closePlayer() {
        localPlayback?.stop()
        localPlayback = nil
        upNext = nil
        binWatchedDownload()
        if route == .player { withAnimation(Motion.quick) { route = .downloads } }
    }

    func openSite(_ site: Site) {
        browser.endSearch(keeping: nil)
        let existing = browser.listedTabs.first { DomainName.isSameSite($0.url?.host, site.host) }
        if let existing {
            browser.select(existing)
        } else {
            browser.openTab(url: site.homeURL, select: true, siteID: site.id)
        }
    }

    /// Adds whatever the current page is showing to the backlog.
    func addCurrentPageToBacklog() {
        guard let tab = browser.selected, route == .web else {
            sheet = .addTitle(query: nil)
            return
        }
        if let id = tab.linkedTitleID, let title = library.titles[id] {
            if title.status == .none || title.status == .watched {
                library.setStatus(id, .backlog)
            }
            toasts.show("Added \(title.name) to backlog")
            return
        }
        guard let parsed = tab.parsed else {
            sheet = .addTitle(query: tab.title)
            return
        }
        if let existing = library.find(name: parsed.name, altName: parsed.altName, year: parsed.year) {
            if existing.status == .none { library.setStatus(existing.id, .backlog) }
            toasts.show("\(existing.name) is in \(library.titles[existing.id]?.status.label.lowercased() ?? "your library")")
            return
        }
        guard let title = library.addTitle(
            name: parsed.name, year: parsed.year, kind: parsed.kindHint, status: .backlog,
            posterURL: parsed.posterURL, overview: parsed.overview
        ) else { return }
        session.metadata.enrich(titleID: title.id, altName: parsed.altName)
        toasts.show(
            "Added \(title.name) to backlog",
            action: Toast.Action(title: "Undo") { [weak self] in self?.library.delete(title.id) }
        )
    }

    func addToBacklog(hit: MetadataHit) {
        guard let title = library.addTitle(
            name: hit.name, year: hit.year, kind: hit.kind, status: .backlog, imdbID: hit.id, posterURL: hit.posterURL
        ) else { return }
        // Fills in the description and backdrop.
        session.metadata.apply(hit: hit, to: title.id)
        toasts.show("Added \(hit.name) to backlog")
    }

    /// Saves the frame on screen from whatever is playing.
    func saveMoment() {
        guard let tab = browser.selected?.media != nil ? browser.selected : browser.playingTab else {
            toasts.show("Play something first, then save the moment you like")
            return
        }
        session.frames.saveMoment(tab: tab)
    }

    /// Looks for what's in this tab on the person's other sites.
    func findElsewhere() {
        guard let tab = browser.selected else { return }
        route = .web
        session.rescue.findElsewhere(tab: tab)
    }

    // MARK: Cinema mode

    func toggleCinema() {
        isCinema ? exitCinema() : enterCinema()
    }

    private func enterCinema() {
        guard let tab = browser.selected, route == .web else { return }
        withAnimation(Motion.layout) { isCinema = true }
        tab.setTheater(true)
        setWindowButtons(hidden: true)
        cinemaKeyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.keyCode == 53 else { return event }
            self?.exitCinema()
            return nil
        }
        toasts.show("Press Esc to leave Cinema mode")
    }

    func exitCinema() {
        guard isCinema else { return }
        withAnimation(Motion.layout) { isCinema = false }
        browser.selected?.setTheater(false)
        setWindowButtons(hidden: false)
        if let cinemaKeyMonitor { NSEvent.removeMonitor(cinemaKeyMonitor) }
        cinemaKeyMonitor = nil
    }

    private func setWindowButtons(hidden: Bool) {
        for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            window?.standardWindowButton(button)?.isHidden = hidden
        }
    }

    // MARK: Ambient light

    /// Light follows the film on screen, reads from the video when the browser allows it, from a
    /// small snapshot when it doesn't, and from the poster as a last resort.
    private func tickAmbient() {
        // Runs whenever the window can be seen, including while you work in another app beside it.
        let isVisible = window?.occlusionState.contains(.visible) ?? NSApp.isActive
        guard session.settings.ambientLight, isVisible else {
            browser.selected?.setAmbient(false)
            if session.settings.ambientLight == false { ambient.clear() }
            return
        }

        if route == .player, let playback = localPlayback {
            guard playback.isPlaying, let zones = playback.sampleZones() else {
                if !playback.isPlaying { ambient.dim() }
                return
            }
            ambient.setActive(strength: cinemaStrength)
            ambient.update(fromLive: zones)
            return
        }

        guard route == .web, let tab = browser.selected, tab.media?.isPlaying == true else {
            browser.selected?.setAmbient(false)
            if route == .web || route == .settings { ambient.dim() } else { showHeroLight() }
            return
        }

        ambient.setActive(strength: cinemaStrength)
        tab.setAmbient(true)

        guard tab.ambientFramesBlocked else { return }
        // The page won't let the video be read. Photograph the window instead, which sees it.
        if windowCaptureFails < 3 {
            sampleWindow(of: tab)
            return
        }
        snapshotCounter += 1
        if snapshotCounter % 2 == 0, !ambient.snapshotsAreBlack { sampleSnapshot(of: tab) }
        if ambient.snapshotsAreBlack, let id = tab.linkedTitleID, let title = library.titles[id],
           let url = title.backdropURL ?? title.posterURL {
            ambient.setFromImage(url)
        }
    }

    /// Cinema mode leaves a dark frame around the film, where the light gets to be brighter.
    private var cinemaStrength: Double {
        let base = session.settings.ambientStrength
        return isCinema ? min(1, base * 1.45 + 0.1) : base
    }

    private func sampleWindow(of tab: BrowserTab) {
        guard !isSamplingWindow, let webView = tab.webView else { return }
        isSamplingWindow = true
        Task {
            defer { isSamplingWindow = false }
            let rect = await session.frames.pictureRect(tab: tab) ?? webView.bounds
            guard let image = await WindowCapture.image(of: webView, rect: rect, maxPixel: 48),
                  let zones = ColorZones.sample(image)
            else {
                windowCaptureFails += 1
                return
            }
            windowCaptureFails = 0
            ambient.update(fromLive: zones)
        }
    }

    private func sampleSnapshot(of tab: BrowserTab) {
        guard let webView = tab.webView else { return }
        let config = WKSnapshotConfiguration()
        config.snapshotWidth = 48
        webView.takeSnapshot(with: config) { [weak self] image, _ in
            guard let self, let image,
                  let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
                  let zones = ColorZones.sample(cg)
            else { return }
            self.ambient.update(fromSnapshot: zones)
        }
    }

    /// Off screen pages show faint light from the title being featured on Home.
    private func showHeroLight() {
        if route == .home, let first = library.continueWatching.first,
           let url = first.title.backdropURL ?? first.title.posterURL {
            ambient.setActive(strength: session.settings.ambientStrength * 0.55)
            ambient.setFromImage(url)
        } else {
            ambient.dim()
        }
    }
}

// MARK: Motion

enum Motion {
    static let quick = Animation.spring(response: 0.26, dampingFraction: 0.9)
    static let pop = Animation.spring(response: 0.3, dampingFraction: 0.82)
    static let layout = Animation.spring(response: 0.42, dampingFraction: 0.88)
}

// MARK: Ambient model

@Observable
final class AmbientModel {
    private(set) var zones: [RGB] = Array(repeating: .black, count: 6)
    private(set) var level = 0.0
    private var imageURL: URL?
    private var blackSnapshots = 0

    var snapshotsAreBlack: Bool { blackSnapshots >= 3 }

    func setActive(strength: Double) {
        guard level != strength else { return }
        withAnimation(.easeInOut(duration: 1.2)) { level = strength }
    }

    func dim() {
        guard level != 0 else { return }
        imageURL = nil
        withAnimation(.easeInOut(duration: 1.2)) { level = 0 }
    }

    func clear() {
        imageURL = nil
        blackSnapshots = 0
        level = 0
        zones = Array(repeating: .black, count: 6)
    }

    func update(fromFrames raw: [[NSNumber]]) {
        let parsed = raw.compactMap { c -> RGB? in
            guard c.count == 3 else { return nil }
            return RGB(r: c[0].doubleValue / 255, g: c[1].doubleValue / 255, b: c[2].doubleValue / 255)
        }
        guard parsed.count == 6 else { return }
        imageURL = nil
        apply(parsed)
    }

    /// Frames read straight from the video, where a dark scene is just a dark scene.
    func update(fromLive sampled: [RGB]) {
        guard sampled.count == 6 else { return }
        blackSnapshots = 0
        imageURL = nil
        apply(sampled)
    }

    func update(fromSnapshot sampled: [RGB]) {
        guard sampled.count == 6 else { return }
        if sampled.allSatisfy({ $0.brightness < 0.015 }) {
            // Hardware video often isn't captured in snapshots. After three black ones, stop asking.
            blackSnapshots += 1
            return
        }
        blackSnapshots = 0
        imageURL = nil
        apply(sampled)
    }

    func setFromImage(_ url: URL) {
        guard imageURL != url else { return }
        imageURL = url
        Task {
            guard let sampled = await ImagePipeline.shared.zones(of: url), imageURL == url else { return }
            apply(sampled)
        }
    }

    private func apply(_ sampled: [RGB]) {
        let boosted = sampled.map { $0.boosted() }
        guard boosted != zones else { return }
        withAnimation(.easeInOut(duration: 1.4)) { zones = boosted }
    }
}

// MARK: Toasts

struct Toast: Identifiable, Equatable {
    struct Action {
        var title: String
        var run: () -> Void
    }

    let id = UUID()
    var message: String
    var action: Action?

    static func == (lhs: Toast, rhs: Toast) -> Bool { lhs.id == rhs.id }
}

@Observable
final class ToastCenter {
    private(set) var current: Toast?
    private var dismissTask: Task<Void, Never>?

    func show(_ message: String, action: Toast.Action? = nil) {
        // A burst of blocked pop-ups shouldn't restart the same message over and over.
        if current?.message == message, current?.action == nil { return }
        withAnimation(Motion.pop) { current = Toast(message: message, action: action) }
        dismissTask?.cancel()
        let delay = action == nil ? 3.0 : 6.0
        dismissTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.dismiss()
        }
    }

    func dismiss() {
        withAnimation(Motion.quick) { current = nil }
    }
}
