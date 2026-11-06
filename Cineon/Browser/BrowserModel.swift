import AppKit
import Observation
import WebKit

/// All the tabs in a profile.
@Observable
final class BrowserModel: NSObject {
    @ObservationIgnored unowned let session: ProfileSession

    private(set) var tabs: [BrowserTab] = []
    var selectedID: UUID?
    private(set) var recentlyClosed: [(url: URL, title: String)] = []

    /// A running search across all sites.
    var search: SearchSession?

    @ObservationIgnored private var byWebView: [ObjectIdentifier: BrowserTab] = [:]
    @ObservationIgnored private var saveTask: Task<Void, Never>?
    @ObservationIgnored private var hibernateTimer: Timer?
    /// One web view kept warm, so the next tab paints without waiting for a new web process.
    @ObservationIgnored private var warmWebView: WKWebView?

    init(session: ProfileSession) {
        self.session = session
        super.init()
    }

    var selected: BrowserTab? {
        if let search, let tab = search.selectedTab { return tab }
        return tabs.first { $0.id == selectedID }
    }

    /// Tabs shown in the sidebar. Search results stay out until they're kept.
    var listedTabs: [BrowserTab] { tabs.filter { $0.searchGroup == nil } }

    var playingTab: BrowserTab? {
        tabs.first { $0.media?.isPlaying == true } ?? tabs.first { $0.track != nil }
    }

    func tab(for webView: WKWebView) -> BrowserTab? { byWebView[ObjectIdentifier(webView)] }
    func register(_ webView: WKWebView, for tab: BrowserTab) { byWebView[ObjectIdentifier(webView)] = tab }
    func unregister(_ webView: WKWebView) { byWebView[ObjectIdentifier(webView)] = nil }

    // MARK: Startup

    func start() {
        restore()
        hibernateTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.hibernateIdleTabs() }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
            self?.warmUp()
        }
    }

    private func restore() {
        guard let saved = try? session.db.loadTabs() else { return }
        tabs = saved.map {
            BrowserTab(id: $0.id, browser: self, url: $0.url, title: $0.title, favicon: $0.faviconURL, state: $0.state)
        }
        selectedID = saved.first(where: \.isActive)?.id ?? tabs.first?.id
    }

    func warmUp() {
        guard warmWebView == nil else { return }
        let view = session.webKit.makeWebView()
        // Running a script starts the web process without navigating, so no blank page lands in
        // the tab's history for Back to return to.
        view.evaluateJavaScript("1", in: nil, in: WebKitEnvironment.world) { _ in }
        warmWebView = view
    }

    func dequeueWebView() -> WKWebView {
        defer {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.warmUp() }
        }
        if let warm = warmWebView {
            warmWebView = nil
            return warm
        }
        return session.webKit.makeWebView()
    }

    func shutdown() {
        hibernateTimer?.invalidate()
        saveNow()
        for tab in tabs {
            session.rescue.stop(tab: tab)
            session.tracker.tabNavigated(tab)
            tab.tearDownWebView()
        }
        warmWebView = nil
    }

    // MARK: Tabs

    @discardableResult
    func openTab(url: URL?, select: Bool = true, resumeAt: Double? = nil, siteID: Int64? = nil, keepWatching: Bool = false) -> BrowserTab {
        let tab = BrowserTab(browser: self, url: url)
        tab.originSiteID = siteID
        tab.pendingResume = resumeAt
        if let selected = tabs.firstIndex(where: { $0.id == selectedID }) {
            tabs.insert(tab, at: selected + 1)
        } else {
            tabs.append(tab)
        }
        if select {
            endSearch(keeping: nil)
            selectedID = tab.id
            session.app?.route = .web
        }
        if let url {
            if keepWatching {
                tab.loadToKeepWatching(url, resumingAt: resumeAt)
            } else {
                tab.load(url, resumingAt: resumeAt)
            }
        }
        scheduleSave()
        return tab
    }

    /// Opens an address in a tab already showing that page, if there is one.
    func open(url: URL, resumeAt: Double? = nil, siteID: Int64? = nil, keepWatching: Bool = false) {
        let key = URLKey.make(url)
        if let existing = listedTabs.first(where: { $0.url.map(URLKey.make) == key }) {
            select(existing)
            if existing.media != nil {
                if let resumeAt { existing.seek(to: resumeAt) }
                if keepWatching { existing.playerCommand("play()") }
            } else {
                // Nothing is playing there yet, or the tab has just woken up. Jump once it's ready.
                existing.pendingResume = resumeAt
            }
            return
        }
        openTab(url: url, select: true, resumeAt: resumeAt, siteID: siteID, keepWatching: keepWatching)
    }

    func select(_ tab: BrowserTab) {
        endSearch(keeping: nil)
        selectedID = tab.id
        tab.lastActiveAt = .now
        session.app?.route = .web
        tab.ensureWebView()
        scheduleSave()
    }

    func close(_ tab: BrowserTab) {
        session.rescue.stop(tab: tab)
        session.tracker.tabNavigated(tab)
        if let url = tab.url {
            recentlyClosed.append((url, tab.displayTitle))
            if recentlyClosed.count > 20 { recentlyClosed.removeFirst() }
        }
        let listed = listedTabs
        let index = listed.firstIndex { $0.id == tab.id }
        tab.tearDownWebView()
        tabs.removeAll { $0.id == tab.id }

        if selectedID == tab.id {
            let remaining = listedTabs
            if let index, !remaining.isEmpty {
                let next = remaining[min(index, remaining.count - 1)]
                selectedID = next.id
                next.ensureWebView()
            } else {
                selectedID = nil
                session.app?.route = .home
            }
        }
        scheduleSave()
    }

    func reopenClosed() {
        guard let last = recentlyClosed.popLast() else { return }
        openTab(url: last.url)
    }

    func move(from source: IndexSet, to destination: Int) {
        var listed = listedTabs
        listed.move(fromOffsets: source, toOffset: destination)
        tabs = listed + tabs.filter { $0.searchGroup != nil }
        scheduleSave()
    }

    func selectTab(atIndex index: Int) {
        let listed = listedTabs
        guard listed.indices.contains(index) else { return }
        select(listed[index])
    }

    func selectAdjacent(_ delta: Int) {
        let listed = listedTabs
        guard !listed.isEmpty else { return }
        let current = listed.firstIndex { $0.id == selectedID } ?? 0
        select(listed[(current + delta + listed.count) % listed.count])
    }

    func adoptPopup(configuration: WKWebViewConfiguration, target: URL?, opener: BrowserTab) -> WKWebView {
        let tab = BrowserTab(browser: self, url: target)
        if let index = tabs.firstIndex(where: { $0.id == opener.id }) {
            tabs.insert(tab, at: index + 1)
        } else {
            tabs.append(tab)
        }
        let view = tab.ensureWebView(configuration: configuration)
        endSearch(keeping: nil)
        selectedID = tab.id
        session.app?.route = .web
        return view
    }

    /// Only one film at a time. Starting a video pauses any other tab that was playing.
    func pauseOthers(than tab: BrowserTab) {
        for other in tabs where other !== tab && other.media?.isPlaying == true {
            other.pausePlayback()
        }
    }

    private func hibernateIdleTabs() {
        let limit = session.settings.hibernateMinutes * 60
        guard limit > 0 else { return }
        let cutoff = Date.now.addingTimeInterval(-limit)
        for tab in tabs where !tab.isHibernated && tab.id != selectedID && tab.lastActiveAt < cutoff {
            tab.hibernate()
        }
    }

    // MARK: Learning from pages

    func learnFromPage(_ meta: PageMeta, tab: BrowserTab) {
        guard let host = tab.url?.host, var site = session.library.site(forHost: host) else { return }
        var changed = false
        if site.searchTemplate == nil, let template = meta.search {
            site.searchTemplate = template
            changed = true
        }
        if let icon = meta.icon.flatMap(URL.init(string:)), site.iconURL != icon {
            site.iconURL = icon
            changed = true
        }
        if changed { session.library.updateSite(site) }
    }

    // MARK: Search everywhere

    func searchEverywhere(_ query: String, titleID: Int64? = nil) {
        endSearch(keeping: nil)
        let sites = session.library.sites.filter { $0.searchTemplate != nil }
        guard !sites.isEmpty else {
            session.toasts.show("None of your sites has search set up. Add one in Settings.")
            return
        }
        let group = UUID()
        var results: [SearchSession.Result] = []
        for site in sites {
            guard let url = site.searchURL(for: query) else { continue }
            let tab = BrowserTab(browser: self, url: url)
            tab.searchGroup = group
            tabs.append(tab)
            results.append(SearchSession.Result(site: site, tab: tab, url: url))
        }
        guard !results.isEmpty else { return }
        let new = SearchSession(id: group, query: query, results: results)
        search = new
        session.app?.route = .web
        new.select(results[0].id)

        // Load the next few in the background, so flipping between sites is instant.
        for result in results.dropFirst().prefix(3) { result.tab.load(result.url) }
    }

    /// Closes the search. A result you clicked through, or are watching, stays as a normal tab:
    /// moving on from a search should never lose the film you found with it.
    func endSearch(keeping kept: BrowserTab?) {
        guard let current = search else { return }
        var keptSelected: BrowserTab?
        for result in current.results {
            let tab = result.tab
            let clickedThrough = !tab.isHibernated && tab.url.map(URLKey.make) != URLKey.make(result.url)
            if tab === kept || clickedThrough || tab.track != nil {
                tab.searchGroup = nil
                if tab === kept || tab === current.selectedTab { keptSelected = tab }
            } else {
                session.tracker.tabNavigated(tab)
                tab.tearDownWebView()
                tabs.removeAll { $0.id == tab.id }
            }
        }
        if let keptSelected { selectedID = keptSelected.id }
        search = nil
        scheduleSave()
    }

    // MARK: Saving

    func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1.5))
            guard !Task.isCancelled else { return }
            self?.saveNow()
        }
    }

    func saveNow() {
        let snapshot = listedTabs.enumerated().map { index, tab in
            PersistedTab(
                id: tab.id,
                url: tab.url,
                title: tab.title,
                faviconURL: tab.faviconURL,
                position: index,
                isActive: tab.id == selectedID,
                state: (tab.webView?.interactionState as? Data) ?? tab.restoreState,
                isPinnedToSearch: false
            )
        }
        try? session.db.saveTabs(snapshot)
    }
}

// MARK: Downloads

extension BrowserModel: WKDownloadDelegate {
    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping @MainActor @Sendable (URL?) -> Void
    ) {
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        var target = folder.appendingPathComponent(suggestedFilename)
        var counter = 1
        while FileManager.default.fileExists(atPath: target.path) {
            let base = (suggestedFilename as NSString).deletingPathExtension
            let ext = (suggestedFilename as NSString).pathExtension
            target = folder.appendingPathComponent("\(base) \(counter)" + (ext.isEmpty ? "" : ".\(ext)"))
            counter += 1
        }
        session.toasts.show("Downloading \(target.lastPathComponent) to Downloads")
        completionHandler(target)
    }
}

/// One query running across every site with search set up.
@Observable
final class SearchSession {
    struct Result: Identifiable {
        var id: Int64 { site.id }
        let site: Site
        let tab: BrowserTab
        let url: URL
    }

    let id: UUID
    let query: String
    let results: [Result]
    private(set) var selectedResultID: Int64?

    init(id: UUID, query: String, results: [Result]) {
        self.id = id
        self.query = query
        self.results = results
        selectedResultID = results.first?.id
    }

    var selectedTab: BrowserTab? {
        results.first { $0.id == selectedResultID }?.tab
    }

    func select(_ id: Int64) {
        selectedResultID = id
        guard let result = results.first(where: { $0.id == id }) else { return }
        if result.tab.isHibernated { result.tab.load(result.url) }
    }
}
