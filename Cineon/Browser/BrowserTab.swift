import AppKit
import Observation
import WebKit

struct LoadFailure: Equatable {
    var host: String
    var message: String
    var url: URL?
}

/// One tab. Owns its web view, which it can release when idle and bring back later.
@Observable
final class BrowserTab: NSObject, Identifiable {
    let id: UUID
    @ObservationIgnored unowned let browser: BrowserModel

    var url: URL?
    var title = ""
    var faviconURL: URL?
    var isLoading = false
    var progress = 0.0
    var canGoBack = false
    var canGoForward = false
    var failure: LoadFailure?
    var media: MediaState?
    var parsed: ParsedTitle?
    var linkedTitleID: Int64?
    var blocked = ShieldStats()
    var isTheaterOn = false
    var rescue: RescueSession?
    /// Files the player asked for, as the Network tab would list them.
    private(set) var sources: [MediaSource] = []
    /// What voice boost is doing in this tab's player.
    private(set) var boostState: VoiceBoostState = .off
    /// The second line of subtitles Cineon draws over the player, if one is chosen.
    private(set) var secondSubtitles: SubtitleTrack?
    private(set) var isHibernated = true

    /// Set when the tab was opened from the sites grid, to notice when that site moves address.
    @ObservationIgnored var originSiteID: Int64?
    /// Belongs to a search-everywhere session rather than the tab list.
    var searchGroup: UUID?
    /// A hidden tab Cineon drives by itself, such as the one fetching a season's episode files.
    /// It finds files and nothing else: no history, no tracking, no rescue, no buttons.
    @ObservationIgnored var isHelper = false

    @ObservationIgnored private(set) var webView: WKWebView?
    @ObservationIgnored var restoreState: Data?
    @ObservationIgnored var lastActiveAt = Date.now
    @ObservationIgnored var pageMeta: PageMeta?

    // Watch tracking, driven by WatchTracker.
    @ObservationIgnored var track: LiveTrack?
    @ObservationIgnored var playedSeconds = 0.0
    @ObservationIgnored var lastPlaybackReport: Date?
    @ObservationIgnored var pendingResume: Double?
    @ObservationIgnored var mediaFrame: WKFrameInfo?
    /// How long the video being resumed was, to notice landing on a different cut or a different film.
    @ObservationIgnored var expectedResumeDuration: Double?
    /// The one address whose video should start by itself, because someone asked to carry on
    /// watching. It's tied to the address so that it can't carry over to whatever opens next.
    @ObservationIgnored private var autoplayKey: String?
    @ObservationIgnored var autopilot = AutopilotState()
    @ObservationIgnored var lastEpisodeExit: EpisodeExit?
    @ObservationIgnored var frameState = FrameState()
    /// The frame holding the video whose files were found, and its address for the Referer.
    @ObservationIgnored private(set) var sourcesFrame: WKFrameInfo?
    @ObservationIgnored private(set) var sourcesFrameURL: String?
    @ObservationIgnored private var playingSource: String?
    /// Called whenever the player's files change, for whoever waits on them.
    @ObservationIgnored var onSources: (() -> Void)?
    @ObservationIgnored private var lastPill: String?
    @ObservationIgnored private var captionsApplied: String?
    #if DEBUG
    @ObservationIgnored var lastBannerForTests: String?
    #endif

    @ObservationIgnored private var observations: [NSKeyValueObservation] = []
    @ObservationIgnored private var lastHistoryKey: String?
    /// True while a navigation the person asked for is still in flight, redirects included.
    @ObservationIgnored private var trustedNavigation = false
    /// The server said this page doesn't exist, though it did send something to show.
    @ObservationIgnored private var missingPageURL: URL?
    /// Falls back to window snapshots once reading video frames turns out to be blocked.
    @ObservationIgnored private(set) var ambientFramesBlocked = false

    private var session: ProfileSession { browser.session }

    init(id: UUID = UUID(), browser: BrowserModel, url: URL? = nil, title: String = "", favicon: URL? = nil, state: Data? = nil) {
        self.id = id
        self.browser = browser
        self.url = url
        self.title = title
        self.faviconURL = favicon
        self.restoreState = state
    }

    var displayTitle: String {
        if !title.isEmpty { return title }
        if let host = url?.host { return DomainName.displayName(host) }
        return "New tab"
    }

    // MARK: Lifecycle

    /// Creates the web view on first need, which is why opening with many tabs stays instant.
    @discardableResult
    func ensureWebView(configuration: WKWebViewConfiguration? = nil) -> WKWebView {
        if let webView { return webView }
        let view = configuration == nil ? browser.dequeueWebView() : session.webKit.makeWebView(configuration: configuration)
        attach(view)
        if let state = restoreState {
            view.interactionState = state
            restoreState = nil
            trustedNavigation = true
        } else if configuration == nil, let url {
            trustedNavigation = true
            view.load(URLRequest(url: url))
        }
        return view
    }

    private func attach(_ view: WKWebView) {
        webView = view
        isHibernated = false
        view.navigationDelegate = self
        view.uiDelegate = self
        browser.register(view, for: self)

        observations = [
            view.observe(\.title, options: [.new]) { [weak self] view, _ in
                MainActor.assumeIsolated { self?.titleChanged(view.title) }
            },
            view.observe(\.url, options: [.new]) { [weak self] view, _ in
                MainActor.assumeIsolated { self?.urlChanged(view.url) }
            },
            view.observe(\.isLoading, options: [.new]) { [weak self] view, _ in
                MainActor.assumeIsolated { self?.isLoading = view.isLoading }
            },
            view.observe(\.estimatedProgress, options: [.new]) { [weak self] view, _ in
                MainActor.assumeIsolated { self?.progress = view.estimatedProgress }
            },
            view.observe(\.canGoBack, options: [.new]) { [weak self] view, _ in
                MainActor.assumeIsolated { self?.canGoBack = view.canGoBack }
            },
            view.observe(\.canGoForward, options: [.new]) { [weak self] view, _ in
                MainActor.assumeIsolated { self?.canGoForward = view.canGoForward }
            },
        ]
    }

    /// Frees the web view's memory but keeps its place. Waking it restores history and scroll.
    func hibernate() {
        guard let view = webView, media?.isPlaying != true, view.fullscreenState == .notInFullscreen else { return }
        session.tracker.tabNavigated(self)
        restoreState = view.interactionState as? Data
        tearDownWebView()
        isHibernated = true
    }

    func tearDownWebView() {
        observations.removeAll()
        guard let view = webView else { return }
        browser.unregister(view)
        view.navigationDelegate = nil
        view.uiDelegate = nil
        view.stopLoading()
        view.pauseAllMediaPlayback(completionHandler: nil)
        view.removeFromSuperview()
        webView = nil
        mediaFrame = nil
        forgetSources()
    }

    /// For helper tabs, which never sit in the window: never throttled, so their players load.
    func makeHelperWebView() {
        let configuration = session.webKit.makeConfiguration()
        configuration.preferences.inactiveSchedulingPolicy = .none
        configuration.mediaTypesRequiringUserActionForPlayback = []
        ensureWebView(configuration: configuration)
    }

    // MARK: Navigation commands

    func load(_ target: URL) {
        session.rescue.stop(tab: self)
        url = target
        failure = nil
        trustedNavigation = true
        // A brand new web view loads `url` by itself. Only one that already exists, or one
        // restoring a saved history, needs telling, or the page would load twice.
        let needsExplicitLoad = webView != nil || restoreState != nil
        ensureWebView()
        if needsExplicitLoad { webView?.load(URLRequest(url: target)) }
        session.library.site(forHost: target.host).map { noteSiteUsed($0) }
    }

    /// Resume playback at a specific place, used by "resume" buttons everywhere.
    func load(_ target: URL, resumingAt position: Double?) {
        pendingResume = position
        load(target)
    }

    /// Carries on watching at a new address: the video there may start by itself, with sound.
    func loadToKeepWatching(_ target: URL, resumingAt position: Double? = nil) {
        autoplayKey = URLKey.make(target)
        load(target, resumingAt: position)
    }

    private func wantsAutoplay(at target: URL?) -> Bool {
        guard let autoplayKey, let target else { return false }
        return URLKey.make(target) == autoplayKey
    }

    func goBack() { markTrusted(); webView?.goBack() }
    func goForward() { markTrusted(); webView?.goForward() }

    func reload() {
        failure = nil
        markTrusted()
        if let webView, webView.url != nil {
            webView.reload()
        } else if let url {
            ensureWebView()
            webView?.load(URLRequest(url: url))
        }
    }

    func stop() { webView?.stopLoading() }
    private func markTrusted() { trustedNavigation = true }

    func zoom(by delta: CGFloat) {
        guard let webView else { return }
        webView.pageZoom = min(3, max(0.5, webView.pageZoom + delta))
    }

    func resetZoom() { webView?.pageZoom = 1 }

    // MARK: Playback commands

    private func mediaCommand(_ script: String) {
        guard let webView else { return }
        let js = "window.__cineon && __cineon.\(script);"
        if let frame = mediaFrame {
            webView.evaluateJavaScript(js, in: frame, in: WebKitEnvironment.world) { _ in }
        } else {
            webView.evaluateJavaScript(js, in: nil, in: WebKitEnvironment.world) { _ in }
        }
    }

    /// Runs a command in the frame holding the video.
    func playerCommand(_ script: String) { mediaCommand(script) }

    func evaluateInPlayer(_ script: String) async -> Any? {
        await evaluate(script, in: mediaFrame)
    }

    /// Runs in the top frame, which is where a page's episode list lives.
    func evaluateInPage(_ script: String) async -> Any? {
        await evaluate(script, in: nil)
    }

    private func evaluate(_ script: String, in frame: WKFrameInfo?) async -> Any? {
        await webView?.runScript(script, in: frame)
    }

    /// A small card over the player, which unlike a toast can still be seen in fullscreen.
    func showBanner(
        id: String,
        text: String,
        actions: [(id: String, label: String, primary: Bool)] = [],
        seconds: Double? = nil,
        onExpire: String? = nil,
        timeout: Double? = nil
    ) {
        var options: [String: Any] = [
            "id": id,
            "text": text,
            "actions": actions.map { ["id": $0.id, "label": $0.label, "primary": $0.primary] as [String: Any] },
        ]
        if let seconds { options["seconds"] = seconds }
        if let onExpire { options["onExpire"] = onExpire }
        if let timeout { options["timeout"] = timeout }
        #if DEBUG
        lastBannerForTests = "\(id)|\(text)|\(seconds == nil ? "offer" : "countdown")"
        #endif
        guard let data = try? JSONSerialization.data(withJSONObject: options),
              let json = String(data: data, encoding: .utf8)
        else { return }
        mediaCommand("banner(\(json))")
    }

    func pausePlayback() { mediaCommand("pause()") }
    func play() { mediaCommand("play()") }
    /// Fades the sound out over this long, then pauses and puts the volume back.
    func fadeOut(over seconds: Double) { mediaCommand("fadeOut(\(max(0.5, seconds)))") }
    func cancelFade() { mediaCommand("cancelFade()") }
    func togglePlayback() { mediaCommand("toggle()") }
    func seek(to seconds: Double) { mediaCommand("seek(\(seconds))") }
    func skip(by seconds: Double) { mediaCommand("skip(\(seconds))") }
    func setRate(_ rate: Double) { mediaCommand("rate(\(rate))") }
    func togglePictureInPicture() { mediaCommand("pip()") }

    func setAmbient(_ on: Bool) {
        if on {
            if !ambientFramesBlocked { mediaCommand("ambient(true)") }
        } else {
            mediaCommand("ambient(false)")
        }
    }

    func setTheater(_ on: Bool) {
        guard let webView else { return }
        let run = on ? "window.__cineonTheater.enable()" : "window.__cineonTheater && window.__cineonTheater.clear()"
        let script = on ? PageScripts.theater + "\n" + run : run
        webView.evaluateJavaScript(script, in: nil, in: .page) { _ in }
        isTheaterOn = on
    }

    /// A long video just became ready. Everything it should know before it starts.
    func replyToReadyVideo(_ event: MediaEvent) -> [String: Any]? {
        var reply: [String: Any] = [:]
        if let position = session.tracker.resumePosition(for: event, tab: self) { reply["seekTo"] = position }
        if let skips = session.autopilot.skips(for: event, tab: self) { reply["skips"] = skips }
        if wantsAutoplay(at: url), event.duration >= WatchTracker.minimumDuration {
            autoplayKey = nil
            reply["play"] = true
        }
        return reply.isEmpty ? nil : reply
    }

    // MARK: Downloads

    /// The file that is the film being shown, out of everything the player asked for.
    var bestSource: MediaSource? { MediaSource.best(of: sources, playing: playingSource) }

    private func receiveSources(_ body: Any, frame: WKFrameInfo) {
        guard let dict = body as? [String: Any], let list = dict["items"] as? [[String: Any]] else { return }
        let found = list.compactMap { entry -> MediaSource? in
            guard let raw = entry["url"] as? String, let url = URL(string: raw),
                  let kind = (entry["kind"] as? String).flatMap(MediaSource.Kind.init(rawValue:))
            else { return nil }
            return MediaSource(
                url: url, kind: kind, foundAt: (entry["at"] as? NSNumber)?.doubleValue ?? 0,
                isCurrent: (entry["current"] as? NSNumber)?.boolValue ?? true
            )
        }
        guard !found.isEmpty else { return }
        sources = found
        sourcesFrame = frame
        sourcesFrameURL = dict["frame"] as? String
        let newSource = dict["src"] as? String
        // Another episode started in the same page: its subtitles aren't these.
        if let playingSource, let newSource, playingSource != newSource, secondSubtitles != nil { clearSecondSubtitles() }
        playingSource = newSource
        onSources?()
        if isHelper { return }
        refreshDownloadPill()
    }

    private func receiveDownloadClick(_ body: Any) {
        let action = (body as? [String: Any])?["action"] as? String
        let downloads: DownloadCenter = session.downloads
        if action == "retry", let existing = downloads.items.first(where: { $0.sourceURL == bestSource?.url && $0.status == .failed }) {
            downloads.retry(existing.id)
        } else {
            downloads.download(from: self)
        }
        refreshDownloadPill()
    }

    /// Shows the download button in the player's frame, saying what it would do now.
    func refreshDownloadPill() {
        guard let webView else { return }
        var options: [String: Any]?
        if session.settings.showDownloadButton, let best = bestSource {
            let downloads: DownloadCenter = session.downloads
            let existing = downloads.existing(for: self)
                ?? downloads.items.first { $0.sourceURL == best.url }
            let quality = best.quality.map { " · \($0)" } ?? ""
            switch existing?.status {
            case .downloading?, .queued?:
                let fraction = existing.map(downloads.fraction) ?? 0
                options = [
                    "label": fraction > 0 ? "Downloading \(Int(fraction * 100))%" : "Starting download…",
                    "progress": fraction, "busy": true, "hint": "Saving to your Mac",
                ]
            case .done?:
                options = ["label": "Saved", "progress": 0, "action": "open", "hint": "Play the copy on your Mac"]
            case .failed?:
                options = ["label": "Download again", "progress": 0, "action": "retry", "hint": existing?.error ?? ""]
            case nil:
                options = ["label": "Download\(quality)", "progress": 0, "hint": "Save this video to your Mac"]
            }
        }
        let json = options.flatMap { try? JSONSerialization.data(withJSONObject: $0) }.flatMap { String(data: $0, encoding: .utf8) } ?? "null"
        guard json != lastPill else { return }
        lastPill = json
        webView.evaluateJavaScript("window.__cineon && __cineon.downloadPill(\(json));", in: sourcesFrame, in: WebKitEnvironment.world) { _ in }
    }

    /// Caption style for the browser's own text tracks, in the frame that holds the film.
    func applyCaptions(force: Bool = false) {
        guard let webView, let frame = mediaFrame else { return }
        let style = session.settings.captionStyle
        let key = "\(frame.request.url?.absoluteString ?? "")|\(style.rawValue)"
        guard force || key != captionsApplied else { return }
        // A frame that never had a style doesn't need clearing.
        if captionsApplied == nil, style == .site { return }
        captionsApplied = key
        let css = style.css.flatMap { try? JSONSerialization.data(withJSONObject: [$0]) }
            .flatMap { String(data: $0, encoding: .utf8) }.map { String($0.dropFirst().dropLast()) } ?? "null"
        webView.evaluateJavaScript("window.__cineon && __cineon.captions(\(css));", in: frame, in: WebKitEnvironment.world) { _ in }
    }

    // MARK: Voice boost

    func applyVoiceBoost() {
        guard webView != nil, mediaFrame != nil else { return }
        let on = session.settings.voiceBoost
        if !on, boostState == .off { return }
        mediaCommand("voiceBoost(\(on))")
    }

    // MARK: Second subtitles

    /// Subtitle files the player fetched, which can be shown as a second line.
    var subtitleChoices: [(url: URL, label: String)] {
        sources.filter { $0.kind == .subtitle }.enumerated().map { index, source in
            (source.url, SubtitleTrack.label(for: source.url, index: index))
        }
    }

    /// Fetches a subtitle file the way the player did and shows it above the picture.
    func showSecondSubtitles(from url: URL) async -> Bool {
        guard let data = await session.downloads.fetch(url, referer: sourcesFrameURL ?? self.url?.absoluteString, webView: webView),
              let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .windowsCP1251)
        else {
            session.toasts.show("Couldn't load those subtitles")
            return false
        }
        let cues = SubtitleTrack.parse(text)
        guard !cues.isEmpty else {
            session.toasts.show("That file has no subtitles Cineon can read")
            return false
        }
        let index = sources.firstIndex { $0.url == url } ?? 0
        showSecondSubtitles(SubtitleTrack(id: url.absoluteString, label: SubtitleTrack.label(for: url, index: index), cues: cues))
        return true
    }

    func showSecondSubtitles(_ track: SubtitleTrack) {
        secondSubtitles = track
        let cues = track.cues.map { ["s": $0.start, "e": $0.end, "t": $0.text] as [String: Any] }
        guard let data = try? JSONSerialization.data(withJSONObject: cues), let json = String(data: data, encoding: .utf8) else { return }
        mediaCommand("secondSubtitles(\(json))")
    }

    func clearSecondSubtitles() {
        secondSubtitles = nil
        mediaCommand("secondSubtitles(null)")
    }

    private func forgetSources() {
        sources = []
        secondSubtitles = nil
        boostState = .off
        sourcesFrame = nil
        sourcesFrameURL = nil
        playingSource = nil
        lastPill = nil
        captionsApplied = nil
    }

    // MARK: Messages from page scripts

    func receiveMedia(_ body: Any, frame: WKFrameInfo) {
        guard let event = MediaEvent(body) else { return }
        switch event.type {
        case "ambient":
            guard let dict = body as? [String: Any], let zones = dict["zones"] as? [[NSNumber]],
                  browser.selected === self
            else { return }
            session.app?.ambient.update(fromFrames: zones)
        case "ambientUnavailable":
            ambientFramesBlocked = true
        case "jump":
            session.autopilot.handleJump(body, tab: self)
        case "skipped":
            session.autopilot.handleSkipped(body, tab: self)
        case "banner":
            session.autopilot.handleBanner(body, tab: self)
        case "sources":
            receiveSources(body, frame: frame)
        case "download":
            receiveDownloadClick(body)
        case "boost":
            let raw = (body as? [String: Any])?["state"] as? String
            boostState = raw.flatMap(VoiceBoostState.init(rawValue:)) ?? .off
        case "failed", "stalled":
            guard !isHelper else { return }
            session.rescue.videoTrouble(event, tab: self)
        case "recovered":
            session.rescue.videoRecovered(tab: self)
        default:
            if event.duration >= WatchTracker.minimumDuration {
                let isNewFrame = mediaFrame?.request.url != frame.request.url || mediaFrame == nil
                mediaFrame = frame
                if isHelper { return }
                applyCaptions()
                if event.type == "play" || isNewFrame { applyVoiceBoost() }
            }
            if isHelper { return }
            session.tracker.handle(event, tab: self)
        }
    }

    func receiveMeta(_ body: Any) {
        guard let data = try? JSONSerialization.data(withJSONObject: body),
              let meta = try? JSONDecoder().decode(PageMeta.self, from: data)
        else { return }
        pageMeta = meta
        parsed = TitleParser.parse(meta)
        if isHelper { return }
        if let icon = meta.icon.flatMap(URL.init(string:)) { faviconURL = icon }
        browser.learnFromPage(meta, tab: self)
    }

    func receiveShield(_ body: Any) {
        guard let dict = body as? [String: Any], dict["type"] as? String == "overlay" else { return }
        blocked.overlays += 1
        session.shields.record(ShieldStats(overlays: 1))
    }

    // MARK: Observed changes

    private func titleChanged(_ value: String?) {
        guard let value, !value.isEmpty else { return }
        title = value
        if isHelper { return }
        if let url, session.settings.saveBrowsingHistory {
            try? session.db.updateHistoryTitle(url: url, title: value)
        }
        browser.scheduleSave()
    }

    private func urlChanged(_ value: URL?) {
        guard let value, value.scheme != "about" else { return }
        let changed = value != url
        url = value
        let key = URLKey.make(value)
        guard key != lastHistoryKey else { return }
        lastHistoryKey = key

        // Single-page sites change address without a real navigation.
        if isHelper { return }
        if changed {
            // A failed load also moves the address back, which mustn't end the search it started.
            if rescue?.reason.opensBySelf == false { session.rescue.stop(tab: self) }
            session.tracker.tabNavigated(self)
            parsed = nil
            pageMeta = nil
            if isTheaterOn { isTheaterOn = false }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
                self?.webView?.evaluateJavaScript("window.__cineonMeta && __cineonMeta.extract();", in: nil, in: WebKitEnvironment.world) { _ in }
            }
        }
        if session.settings.saveBrowsingHistory {
            try? session.db.addHistory(url: value, host: value.host ?? "", title: title)
        }
        browser.scheduleSave()
    }

    private func noteSiteUsed(_ site: Site) {
        var updated = site
        updated.lastUsedAt = .now
        session.library.updateSite(updated)
    }

    /// Streaming sites change address all the time. When a site redirects to its new one, follow it.
    private func noticeSiteMove(committed: URL) {
        guard let id = originSiteID, let host = committed.host?.lowercased(),
              var site = session.library.sites.first(where: { $0.id == id })
        else { return }
        originSiteID = nil
        let bare = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
        guard !DomainName.isSameSite(site.host, bare) else { return }
        let oldName = site.host
        site.host = bare
        if var parts = URLComponents(url: committed, resolvingAgainstBaseURL: false) {
            parts.path = "/"
            parts.query = nil
            parts.fragment = nil
            site.homeURL = parts.url ?? committed
        }
        if site.searchTemplate != nil { site.searchTemplate = nil }
        session.library.updateSite(site)
        session.toasts.show("\(site.name) moved from \(oldName) to \(bare). Address updated.")
    }

    // MARK: Shield helpers

    private func prefs(for host: String?) -> SitePrefs {
        session.shields.prefs(for: host)
    }

    private func blockRedirect(to target: URL) {
        blocked.redirects += 1
        session.shields.record(ShieldStats(redirects: 1))
        let host = target.host ?? "another site"
        let fromHost = webView?.url?.host
        session.toasts.show(
            "Blocked redirect to \(host)",
            action: Toast.Action(title: "Allow") { [weak self] in
                guard let self else { return }
                self.session.shields.update(host: fromHost) { $0.allowRedirects = true }
                self.load(target)
            }
        )
    }

    private func blockPopup(to target: URL?) {
        blocked.popups += 1
        session.shields.record(ShieldStats(popups: 1))
        let host = target?.host ?? "an unknown page"
        let fromHost = webView?.url?.host
        session.toasts.show(
            "Blocked pop-up to \(host)",
            action: target.map { target in
                Toast.Action(title: "Open") { [weak self] in
                    guard let self else { return }
                    self.session.shields.update(host: fromHost) { $0.allowPopups = true }
                    self.browser.openTab(url: target, select: true)
                }
            }
        )
    }
}

// MARK: Navigation

extension BrowserTab: WKNavigationDelegate {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor action: WKNavigationAction,
        preferences: WKWebpagePreferences,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
    ) {
        if action.targetFrame?.isMainFrame == true {
            if session.shields.prefs(for: action.request.url?.host).shieldsOff {
                WebKitEnvironment.disableContentBlockers(in: preferences)
            }
            if wantsAutoplay(at: action.request.url) { WebKitEnvironment.allowAutoplay(in: preferences) }
        }
        decisionHandler(policy(for: action, in: webView), preferences)
    }

    private func policy(for action: WKNavigationAction, in webView: WKWebView) -> WKNavigationActionPolicy {
        guard let target = action.request.url else { return .cancel }
        let isMainFrame = action.targetFrame?.isMainFrame == true

        // magnet:, itms-apps: and friends can launch other apps. Never allow that silently.
        let scheme = target.scheme?.lowercased() ?? ""
        let webSchemes: Set<String> = ["http", "https", "about", "blob", "data", "file"]
        if !webSchemes.contains(scheme) {
            if isMainFrame { blockRedirect(to: target) }
            return .cancel
        }

        if action.shouldPerformDownload { return session.settings.downloadShield ? .cancel : .download }
        guard isMainFrame else { return .allow }

        let settings = session.settings
        let currentHost = webView.url?.host
        let targetHost = target.host
        let pagePrefs = prefs(for: currentHost)

        switch action.navigationType {
        case .backForward, .reload, .formSubmitted, .formResubmitted:
            trustedNavigation = true
            return .allow
        case .linkActivated:
            // A link inside a frame trying to replace the whole page is a classic hijack.
            if !action.sourceFrame.isMainFrame, settings.redirectShield, !pagePrefs.shieldsOff, !pagePrefs.allowRedirects,
               !DomainName.isSameSite(currentHost, targetHost) {
                blockRedirect(to: target)
                return .cancel
            }
            trustedNavigation = true
            return .allow
        case .other:
            fallthrough
        @unknown default:
            guard settings.redirectShield, !pagePrefs.shieldsOff, !pagePrefs.allowRedirects else { return .allow }
            // No committed page yet, or part of a chain the person started: a normal redirect.
            guard currentHost != nil, !trustedNavigation else { return .allow }
            if DomainName.isSameSite(currentHost, targetHost) { return .allow }
            if scheme == "about" || scheme == "blob" || scheme == "data" { return .allow }
            blockRedirect(to: target)
            return .cancel
        }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor response: WKNavigationResponse,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void
    ) {
        if response.isForMainFrame { missingPageURL = Self.isGone(response.response) ? response.response.url : nil }
        guard !response.canShowMIMEType else {
            decisionHandler(.allow)
            return
        }
        // Streaming sites love fake "download player" files.
        if session.settings.downloadShield, response.isForMainFrame {
            let name = response.response.suggestedFilename ?? "a file"
            session.toasts.show("Blocked a download of \(name)")
            decisionHandler(.cancel)
        } else if response.isForMainFrame {
            decisionHandler(.download)
        } else {
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = browser
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = browser
    }

    /// Statuses that mean the film isn't here, leaving out those a bot check also uses.
    private static func isGone(_ response: URLResponse) -> Bool {
        guard let http = response as? HTTPURLResponse else { return false }
        if http.value(forHTTPHeaderField: "cf-mitigated") != nil { return false }
        return [404, 410, 451, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526].contains(http.statusCode)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        failure = nil
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        trustedNavigation = false
        session.rescue.stop(tab: self)
        if !wantsAutoplay(at: webView.url) { autoplayKey = nil }
        blocked = ShieldStats()
        isTheaterOn = false
        forgetSources()
        // Reloads don't change the address, so save progress here as well.
        session.tracker.tabNavigated(self)
        if let committed = webView.url { noticeSiteMove(committed: committed) }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        browser.scheduleSave()
        if let gone = missingPageURL {
            missingPageURL = nil
            session.rescue.pageMissing(tab: self, url: gone)
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        trustedNavigation = false
        report(error, webView: webView)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
        trustedNavigation = false
        report(error, webView: webView)
    }

    private func report(_ error: any Error, webView: WKWebView) {
        let ns = error as NSError
        // Cancelled means something replaced this load, and 102 means WebKit handed it elsewhere.
        if ns.code == NSURLErrorCancelled || ns.code == 102 || ns.code == 204 { return }
        let failing = (ns.userInfo[NSURLErrorFailingURLErrorKey] as? URL) ?? url
        failure = LoadFailure(
            host: failing?.host ?? "This site",
            message: Self.explain(ns),
            url: failing
        )
        // Offline, every site looks dead. Going looking would only make things worse.
        if ns.code != NSURLErrorNotConnectedToInternet {
            session.rescue.pageFailed(tab: self, url: failing)
        }
    }

    private static func explain(_ error: NSError) -> String {
        switch error.code {
        case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed:
            "This address no longer exists. The site may have moved to a new one."
        case NSURLErrorNotConnectedToInternet:
            "Your Mac is offline. Check the connection, then try again."
        case NSURLErrorTimedOut:
            "The site took too long to answer."
        case NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost:
            "The site refused the connection. It may be down."
        case NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateUntrusted, NSURLErrorServerCertificateHasBadDate,
             NSURLErrorServerCertificateHasUnknownRoot, NSURLErrorServerCertificateNotYetValid:
            "The site's security certificate isn't valid."
        default:
            error.localizedDescription
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // Crashed or killed by the system. Recover quietly if it's the tab being looked at.
        if browser.selectedID == id { webView.reload() }
    }

    /// Not in the public API. Reports each blocked request, for the counter in the shield button.
    /// If WebKit ever stops calling this, only the counter is affected, never the blocking.
    @objc(_webView:contentRuleListWithIdentifier:performedAction:forURL:)
    func webView(_ webView: WKWebView, contentRuleListWithIdentifier identifier: String, performedAction action: AnyObject, forURL url: URL) {
        guard let object = action as? NSObject,
              object.responds(to: NSSelectorFromString("blockedLoad")),
              (object.value(forKey: "blockedLoad") as? NSNumber)?.boolValue == true
        else { return }
        blocked.ads += 1
        session.shields.record(ShieldStats(ads: 1))
    }
}

// MARK: Windows and dialogs

extension BrowserTab: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for action: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        let target = action.request.url
        let fromHost = webView.url?.host
        let pagePrefs = prefs(for: fromHost)
        let realClick = action.navigationType == .linkActivated && action.buttonNumber != 0
        let sameSite = DomainName.isSameSite(target?.host, fromHost)

        let allowed = !session.settings.popupShield || pagePrefs.shieldsOff || pagePrefs.allowPopups || (sameSite && realClick)
        guard allowed else {
            blockPopup(to: target)
            return nil
        }
        return browser.adoptPopup(configuration: configuration, target: target, opener: self)
    }

    // A site never gets to interrupt the film with a modal dialog.
    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor @Sendable () -> Void
    ) {
        completionHandler()
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor @Sendable (Bool) -> Void
    ) {
        completionHandler(false)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor @Sendable (String?) -> Void
    ) {
        completionHandler(nil)
    }

    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void
    ) {
        decisionHandler(.deny)
    }

    func webViewDidClose(_ webView: WKWebView) {
        browser.close(self)
    }
}
