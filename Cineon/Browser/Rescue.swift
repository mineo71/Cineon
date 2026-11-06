import AppKit
import Observation
import WebKit

/// Asks whether a page exists, without opening it.
nonisolated enum SiteProbe {
    enum Result: Sendable {
        /// Answers, and this is where it ended up after any redirects.
        case alive(URL)
        /// The site works, but this page isn't on it.
        case missing
        case dead
    }

    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 7
        config.timeoutIntervalForResource = 9
        config.urlCache = nil
        return URLSession(configuration: config)
    }()

    static func check(_ url: URL) async -> Result {
        var request = URLRequest(url: url)
        request.setValue(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
            forHTTPHeaderField: "User-Agent"
        )
        guard let (bytes, response) = try? await session.bytes(for: request), let http = response as? HTTPURLResponse else {
            return .dead
        }
        bytes.task.cancel()
        let final = http.url ?? url
        switch http.statusCode {
        case 200..<400:
            return .alive(final)
        case 404, 410:
            return .missing
        case 403, 429, 503:
            // A bot check means someone's home. The web view can get past it, this request can't.
            return http.value(forHTTPHeaderField: "Server")?.lowercased().contains("cloudflare") == true ? .alive(final) : .dead
        default:
            return .dead
        }
    }
}

/// One search looking for a film that stopped working, shown over the tab it happened in.
@Observable
final class RescueSession: Identifiable {
    enum Reason: Equatable {
        case pageFailed
        case pageMissing
        case videoFailed
        case videoStalled
        case manual

        /// A dead page has nothing to lose, so the best match can open by itself.
        var opensBySelf: Bool { self == .pageFailed || self == .pageMissing }
        var triesMirrors: Bool { opensBySelf }
    }

    enum Stage: Equatable {
        case mirrors, searching, finished
    }

    struct Option: Identifiable, Hashable {
        var id: String { url.absoluteString }
        var siteName: String
        var siteIcon: URL?
        var url: URL
        var label: String
        var isStrong: Bool
        var score: Double
    }

    let id = UUID()
    let reason: Reason
    let host: String
    let titleID: Int64?
    let name: String
    let names: [String]
    let year: Int?
    let ref: EpisodeRef
    let position: Double?
    let duration: Double?

    var stage = Stage.mirrors
    var mirrorsTotal = 0
    var sitesTotal = 0
    var sitesDone = 0
    var options: [Option] = []
    var countdown: Int?
    /// The tab moved on, so any page still being read for this search can stop.
    @ObservationIgnored var isAbandoned = false
    /// They said to stay, so a better match turning up later doesn't start counting again.
    @ObservationIgnored var isStaying = false

    init(
        reason: Reason, host: String, titleID: Int64?, name: String, names: [String], year: Int?, ref: EpisodeRef,
        position: Double?, duration: Double?
    ) {
        self.reason = reason
        self.host = host
        self.titleID = titleID
        self.name = name
        self.names = names
        self.year = year
        self.ref = ref
        self.position = position
        self.duration = duration
    }

    /// Where it would carry on from, if anywhere.
    var resumePoint: Double? {
        guard let position, position >= 30 else { return nil }
        return position
    }
}

/// A web view nobody sees, for reading a site's search results. It belongs to no tab, so nothing
/// it does reaches the timeline, the history or the interface, and with no window delegate its
/// pop-ups simply don't open.
private final class RescueProbe: NSObject, WKNavigationDelegate {
    private let webView: WKWebView
    private var waiter: CheckedContinuation<Void, Never>?

    init(webKit: WebKitEnvironment) {
        webView = webKit.makeWebView()
        webView.frame = NSRect(x: 0, y: 0, width: 1280, height: 800)
        super.init()
        webView.navigationDelegate = self
    }

    func close() {
        webView.navigationDelegate = nil
        webView.stopLoading()
        finish()
    }

    /// Returns when the page has loaded, failed, or taken too long.
    func load(_ url: URL, timeout: Double) async {
        await withCheckedContinuation { continuation in
            finish()
            waiter = continuation
            webView.load(URLRequest(url: url))
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
                self?.finish()
            }
        }
    }

    private func finish() {
        waiter?.resume()
        waiter = nil
    }

    func searchTemplate() async -> String? {
        await evaluate("window.__cineonMeta ? __cineonMeta.searchTemplate() : null") as? String
    }

    var currentURL: URL? { webView.url }

    func links() async -> [RescueLink] {
        guard let rows = await evaluate(Self.harvest) as? [[String: Any]] else { return [] }
        return rows.compactMap { row in
            guard let href = row["href"] as? String, let url = URL(string: href) else { return nil }
            return RescueLink(url: url, text: row["text"] as? String ?? "", context: row["context"] as? String ?? "")
        }
    }

    private func evaluate(_ script: String) async -> Any? {
        await webView.runScript(script)
    }

    /// Every link on the page with the words that describe it. Cards often keep the title and year
    /// beside the link rather than in it, so the words around it come too.
    private static let harvest = """
    (() => {
      const out = [];
      const seen = new Set();
      let anchors = [...document.querySelectorAll('a[href]')];
      // Pages built from web components keep their results inside shadow roots.
      if (anchors.length < 30) {
        const walk = (root, depth) => {
          for (const el of root.querySelectorAll('*')) {
            if (!el.shadowRoot) continue;
            anchors.push(...el.shadowRoot.querySelectorAll('a[href]'));
            if (depth < 8) walk(el.shadowRoot, depth + 1);
          }
        };
        walk(document, 0);
      }
      for (const a of anchors) {
        if (out.length >= 500) break;
        const href = a.href;
        if (!/^https?:/.test(href) || seen.has(href)) continue;
        seen.add(href);
        const img = a.querySelector('img');
        const words = [a.textContent, a.title, a.getAttribute('aria-label'), img && img.alt, img && img.title];
        const card = a.closest('article, li, [class*="card" i], [class*="item" i], [class*="movie" i], [class*="film" i]');
        out.push({
          href,
          text: words.filter(Boolean).join('\\n').replace(/[ \\t]+/g, ' ').trim().slice(0, 300),
          context: card ? card.textContent.replace(/\\s+/g, ' ').trim().slice(0, 240) : '',
        });
      }
      return out;
    })()
    """

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finish() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) { finish() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) { finish() }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
        let scheme = action.request.url?.scheme?.lowercased()
        let isWeb = scheme == "http" || scheme == "https" || scheme == "about"
        decisionHandler(isWeb && !action.shouldPerformDownload ? .allow : .cancel)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor response: WKNavigationResponse,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void
    ) {
        decisionHandler(response.canShowMIMEType ? .allow : .cancel)
    }
}

/// Keeps a film going when the place it was playing stops working: first the site's other
/// addresses, then the person's other sites, picking up from the same second.
final class RescueEngine {
    private unowned let session: ProfileSession
    private var searches: [UUID: Task<Void, Never>] = [:]
    private var countdowns: [UUID: Task<Void, Never>] = [:]
    /// Pages where someone already said to leave it alone.
    private var declined = Set<String>()

    private static let concurrentSites = 3
    private static let maxSites = 8

    init(session: ProfileSession) {
        self.session = session
    }

    private var library: LibraryStore { session.library }

    // MARK: What can go wrong

    func pageFailed(tab: BrowserTab, url: URL?) {
        guard session.settings.autoRescue else { return }
        begin(tab: tab, reason: .pageFailed, url: url)
    }

    func pageMissing(tab: BrowserTab, url: URL?) {
        guard session.settings.autoRescue else { return }
        begin(tab: tab, reason: .pageMissing, url: url)
    }

    func videoTrouble(_ event: MediaEvent, tab: BrowserTab) {
        guard session.settings.autoRescue, tab.rescue == nil, session.browser.selected === tab else { return }
        // Nothing can be drawn over a fullscreen video from outside, so ask from inside the player.
        if let webView = tab.webView, webView.fullscreenState != .notInFullscreen {
            tab.showBanner(
                id: "rescue",
                text: event.type == "stalled" ? "This video is stuck." : "This video stopped.",
                actions: [("find", "Find another source", true)],
                timeout: 20
            )
            return
        }
        begin(tab: tab, reason: event.type == "stalled" ? .videoStalled : .videoFailed, url: tab.url)
    }

    /// It sorted itself out, so the offer is no longer needed.
    func videoRecovered(tab: BrowserTab) {
        guard let rescue = tab.rescue, rescue.reason == .videoStalled || rescue.reason == .videoFailed else { return }
        stop(tab: tab)
    }

    /// "Not here. Find it somewhere else."
    func findElsewhere(tab: BrowserTab) {
        stop(tab: tab)
        guard let context = context(tab: tab, url: tab.url) else {
            session.toasts.show("Play something first, so Cineon knows what to look for")
            return
        }
        run(context: context, reason: .manual, tab: tab, url: tab.url)
    }

    func tryFailedPageSearch(tab: BrowserTab, url: URL?) {
        guard let context = context(tab: tab, url: url) else { return }
        run(context: context, reason: .pageFailed, tab: tab, url: url)
    }

    func canSearch(tab: BrowserTab, url: URL?) -> Bool {
        context(tab: tab, url: url) != nil
    }

    private func begin(tab: BrowserTab, reason: RescueSession.Reason, url: URL?) {
        guard tab.rescue == nil, let url, !declined.contains(URLKey.make(url)),
              let context = context(tab: tab, url: url)
        else { return }
        run(context: context, reason: reason, tab: tab, url: url)
    }

    // MARK: What was being watched

    private struct Context {
        var titleID: Int64?
        var names: [String]
        var year: Int?
        var ref: EpisodeRef
        var position: Double?
        var duration: Double?
    }

    /// Worked out from records of this exact address, because a tab that failed to load still
    /// holds what it knew about the page before.
    private func context(tab: BrowserTab, url: URL?) -> Context? {
        var titleID: Int64?
        var ref = EpisodeRef.none
        var position: Double?
        var duration: Double?

        if let track = tab.track, url.map(URLKey.make) == track.urlKey {
            titleID = track.titleID
            ref = track.ref
            position = tab.media?.position
            duration = tab.media?.duration
        } else if let url {
            let key = URLKey.make(url)
            if let saved = try? session.db.progress(urlKey: key) {
                titleID = saved.titleID
                ref = saved.ref
                if saved.duration > 0, !saved.finished {
                    position = saved.position
                    duration = saved.duration
                }
            } else if let past = try? session.db.latestSession(url: url) {
                titleID = past.titleID
                ref = past.ref
                if past.duration > 0, !past.finished {
                    position = past.endPosition
                    duration = past.duration
                }
            } else if let link = try? session.db.link(urlKey: key) {
                titleID = link.titleID
                ref = link.ref
            }
        }
        if let explicit = tab.pendingResume { position = explicit }

        var names: [String] = []
        var year: Int?
        if let titleID, let title = library.titles[titleID] {
            names.append(title.name)
            year = title.year
        }
        // What the page called itself is only about this page if it was read from this address.
        if let meta = tab.pageMeta, let metaURL = URL(string: meta.url), let url,
           URLKey.make(metaURL) == URLKey.make(url), let parsed = tab.parsed {
            for name in [parsed.name, parsed.altName].compactMap({ $0 }) where !names.contains(name) {
                names.append(name)
            }
            year = year ?? parsed.year
            if !ref.isEpisode { ref = parsed.ref }
        }
        guard !names.isEmpty else { return nil }
        return Context(titleID: titleID, names: names, year: year, ref: ref, position: position, duration: duration)
    }

    // MARK: Looking

    private func run(context: Context, reason: RescueSession.Reason, tab: BrowserTab, url: URL?) {
        let rescue = RescueSession(
            reason: reason, host: url?.host.map(DomainName.registrable) ?? "This site", titleID: context.titleID,
            name: context.names[0], names: context.names, year: context.year, ref: context.ref,
            position: context.position, duration: context.duration
        )
        tab.rescue = rescue
        searches[tab.id] = Task { [weak self, weak tab] in
            guard let self, let tab else { return }
            if reason.triesMirrors, let url, await self.tryMirrors(of: url, rescue: rescue, tab: tab) { return }
            guard !Task.isCancelled else { return }
            await self.searchSites(rescue: rescue, tab: tab, failedURL: url)
        }
    }

    private func tryMirrors(of url: URL, rescue: RescueSession, tab: BrowserTab) async -> Bool {
        let hosts = (try? session.db.knownHosts()) ?? []
        let siteHosts = library.sites.map(\.host)
        let mirrors = Array(RescueMatcher.mirrors(of: url, among: hosts + siteHosts).prefix(8))
        rescue.mirrorsTotal = mirrors.count
        for mirror in mirrors {
            guard !Task.isCancelled else { return false }
            guard case .alive(let final) = await SiteProbe.check(mirror), !Task.isCancelled else { continue }
            // A dead domain that now redirects to a parking page isn't this site any more.
            guard SkipLearner.siteKey(final.host ?? "") == SkipLearner.siteKey(url.host ?? "") else { continue }
            continueOnMirror(mirror, final: final, from: url, rescue: rescue, tab: tab)
            return true
        }
        return false
    }

    private func continueOnMirror(_ mirror: URL, final: URL, from url: URL, rescue: RescueSession, tab: BrowserTab) {
        let target: URL
        if final.host == mirror.host {
            target = mirror
        } else {
            // It redirected to its newest address. Keep the episode that's only in the fragment.
            var parts = URLComponents(url: final, resolvingAgainstBaseURL: false)
            parts?.fragment = mirror.fragment
            target = parts?.url ?? final
        }
        let newHost = DomainName.registrable(target.host ?? "")
        if var site = library.site(forHost: url.host) {
            site.host = (target.host ?? newHost).replacingOccurrences(of: "www.", with: "")
            if var home = URLComponents(url: target, resolvingAgainstBaseURL: false) {
                home.path = "/"
                home.query = nil
                home.fragment = nil
                site.homeURL = home.url ?? site.homeURL
            }
            site.searchTemplate = nil
            library.updateSite(site)
        }
        finish(tab: tab)
        tab.expectedResumeDuration = rescue.duration
        tab.loadToKeepWatching(target, resumingAt: rescue.resumePoint)
        session.toasts.show("\(rescue.host) is down. Continuing on \(newHost).")
    }

    private func candidateSites(excluding url: URL?) -> [Site] {
        let failed = url?.host.map(SkipLearner.siteKey)
        return library.sites
            .filter { SkipLearner.siteKey($0.host) != failed }
            .sorted { ($0.lastUsedAt ?? .distantPast) > ($1.lastUsedAt ?? .distantPast) }
            .prefix(Self.maxSites)
            .map { $0 }
    }

    private func searchSites(rescue: RescueSession, tab: BrowserTab, failedURL: URL?) async {
        let sites = candidateSites(excluding: failedURL)
        rescue.stage = .searching
        rescue.sitesTotal = sites.count

        // A few at a time: each one is a whole web page loading out of sight.
        for start in stride(from: 0, to: sites.count, by: Self.concurrentSites) {
            guard !Task.isCancelled else { return }
            let batch = sites[start..<min(start + Self.concurrentSites, sites.count)]
            let scans = batch.map { site in
                Task { [weak self, weak tab, weak rescue] in
                    guard let self, let rescue else { return }
                    let option = await self.scan(site: site, rescue: rescue)
                    guard let tab, tab.rescue === rescue else { return }
                    rescue.sitesDone += 1
                    if let option { self.add(option, to: rescue, tab: tab) }
                }
            }
            for scan in scans { await scan.value }
        }
        guard !Task.isCancelled, tab.rescue === rescue else { return }
        rescue.stage = .finished
    }

    private func scan(site: Site, rescue: RescueSession) async -> RescueSession.Option? {
        let probe = RescueProbe(webKit: session.webKit)
        defer { probe.close() }

        var site = site
        if site.searchTemplate == nil {
            // Sites from an import haven't been visited here yet, so learn how they search now.
            await probe.load(site.homeURL, timeout: 10)
            guard !rescue.isAbandoned, let template = await probe.searchTemplate() else { return nil }
            site.searchTemplate = template
            library.updateSite(site)
        }

        for name in rescue.names.prefix(2) {
            guard !rescue.isAbandoned, let url = site.searchURL(for: name) else { return nil }
            await probe.load(url, timeout: 12)
            // Many sites fill in their results a moment after the page loads.
            var best: RescueMatch?
            for attempt in 0..<3 {
                guard !rescue.isAbandoned else { return nil }
                let links = await probe.links()
                best = RescueMatcher.best(links: links, names: rescue.names, year: rescue.year, pageURL: probe.currentURL)
                if best?.isStrong == true { break }
                if attempt < 2 { try? await Task.sleep(for: .seconds(1.2)) }
            }
            if let best {
                let label = best.link.text
                    .split(whereSeparator: \.isNewline)
                    .first
                    .map { String($0).trimmingCharacters(in: .whitespaces) } ?? rescue.name
                return RescueSession.Option(
                    siteName: site.name, siteIcon: site.iconURL, url: best.link.url,
                    label: label.isEmpty ? rescue.name : label,
                    isStrong: best.isStrong && !RescueMatcher.isVideoSharing(best.link.url),
                    score: best.score
                )
            }
        }
        return nil
    }

    private func add(_ option: RescueSession.Option, to rescue: RescueSession, tab: BrowserTab) {
        rescue.options.append(option)
        rescue.options.sort { ($0.isStrong ? 1 : 0, $0.score) > ($1.isStrong ? 1 : 0, $1.score) }
        // Opening by itself is only safe for a film. A series page still needs an episode chosen.
        if option.isStrong, rescue.reason.opensBySelf, !rescue.ref.isEpisode, rescue.countdown == nil, !rescue.isStaying {
            startCountdown(rescue: rescue, tab: tab)
        }
    }

    private func startCountdown(rescue: RescueSession, tab: BrowserTab) {
        rescue.countdown = 5
        countdowns[tab.id] = Task { [weak self, weak tab, weak rescue] in
            for left in stride(from: 4, through: 0, by: -1) {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled, let rescue else { return }
                rescue.countdown = left
            }
            guard let self, let tab, let rescue, let best = rescue.options.first else { return }
            self.take(best, tab: tab)
        }
    }

    // MARK: Decisions

    func take(_ option: RescueSession.Option, tab: BrowserTab) {
        guard let rescue = tab.rescue else { return }
        finish(tab: tab)
        if rescue.ref.isEpisode {
            // The result is the series' page. Once the episode is chosen, its saved place applies.
            tab.load(option.url)
            let place = rescue.resumePoint.map { " and Cineon jumps to \(Timecode.string($0))" } ?? ""
            session.toasts.show("Opened \(option.siteName). Choose \(rescue.ref.longLabel.lowercased())\(place).")
            return
        }
        // This page is this film, whatever the site calls it.
        if let titleID = rescue.titleID {
            try? session.db.setLink(urlKey: URLKey.make(option.url), titleID: titleID, ref: rescue.ref)
        }
        tab.expectedResumeDuration = rescue.duration
        tab.loadToKeepWatching(option.url, resumingAt: rescue.resumePoint)
        let place = rescue.resumePoint.map { " at \(Timecode.string($0))" } ?? ""
        session.toasts.show("Continuing on \(option.siteName)\(place)")
    }

    /// "Leave it." Stops looking, and doesn't ask again about this page.
    func dismiss(tab: BrowserTab) {
        if let url = tab.url { declined.insert(URLKey.make(url)) }
        stop(tab: tab)
    }

    func stopCountdown(tab: BrowserTab) {
        countdowns[tab.id]?.cancel()
        countdowns[tab.id] = nil
        tab.rescue?.countdown = nil
        tab.rescue?.isStaying = true
    }

    /// Stops without judging: the tab has simply moved on.
    func stop(tab: BrowserTab) {
        finish(tab: tab)
    }

    private func finish(tab: BrowserTab) {
        searches[tab.id]?.cancel()
        searches[tab.id] = nil
        countdowns[tab.id]?.cancel()
        countdowns[tab.id] = nil
        tab.rescue?.isAbandoned = true
        tab.rescue = nil
    }
}
