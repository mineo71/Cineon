import AppKit
import SwiftUI
import WebKit

struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let palette = app.palette
        ZStack {
            palette.canvas.ignoresSafeArea()
            AmbientLight().ignoresSafeArea()
            WorkspaceLayout()
                .ignoresSafeArea()
            Overlays()
        }
        // People with a mouse get permanent scrollbar tracks by default, which spoil the full-bleed pages.
        .scrollIndicators(.never)
        .environment(\.palette, palette)
        .preferredColorScheme(palette.isDark ? .dark : .light)
        .frame(minWidth: 860, minHeight: 540)
        .background(WindowConfigurator { app.window = $0 })
    }
}

/// Light from the film spilling onto the chrome, the way a TV lights the wall behind it.
struct AmbientLight: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        let ambient = app.ambient
        let z = ambient.zones
        // The outer ring carries the sampled colours. Centre stays dark, under the card.
        MeshGradient(
            width: 3,
            height: 3,
            points: [
                [0, 0], [0.5, 0], [1, 0],
                [0, 0.5], [0.5, 0.5], [1, 0.5],
                [0, 1], [0.5, 1], [1, 1],
            ],
            colors: [
                z[0].color, z[1].color, z[2].color,
                z[3].color, z[1].color.opacity(0.7), z[5].color,
                z[3].color, z[4].color, z[5].color,
            ]
        )
        .opacity(ambient.level * (palette.isDark ? 1 : 0.55))
        .blendMode(palette.isDark ? .normal : .multiply)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// The top bar over everything, and below it the page. Sites and the player sit in a framed
/// screen with the film's light spilling around it; Cineon's own pages run edge to edge.
struct WorkspaceLayout: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    /// On a site with the bars tucked away, they come back while the pointer is at the top.
    private var showsBars: Bool {
        guard !app.isCinema else { return false }
        if app.route == .web, app.settings.sidebarHidden { return app.isSidebarPeeking }
        return true
    }

    private var contentTop: CGFloat {
        if app.isCinema || app.route == .home { return 0 }
        if app.route == .web { return app.settings.sidebarHidden ? 0 : TopBar.height + BrowserBar.height }
        return TopBar.height
    }

    var body: some View {
        ZStack(alignment: .top) {
            MainCard()
                .padding(.top, contentTop)
                // macOS blurs the title bar over scrolling content beneath it, a web view's
                // included. Here the top bar is the title bar, so it must stay sharp.
                .scrollEdgeEffectHidden(true, for: .top)
            if app.route == .web, app.settings.sidebarHidden, !app.isCinema {
                Color.clear
                    .frame(height: 8)
                    .contentShape(Rectangle())
                    .onHover { inside in if inside { withAnimation(Motion.layout) { app.isSidebarPeeking = true } } }
            }
            if showsBars {
                VStack(spacing: 0) {
                    TopBar()
                    if app.route == .web {
                        BrowserBar()
                    }
                }
                .onHover { inside in
                    if !inside, app.settings.sidebarHidden { withAnimation(Motion.layout) { app.isSidebarPeeking = false } }
                }
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
    }
}

/// The rounded card to the right of the sidebar. Web views stay in place behind native pages,
/// so coming back to a film never reloads it.
struct MainCard: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    /// Sites and the player are a screen in a dark room. Everything else is the room.
    private var isScreen: Bool { app.route == .web || app.route == .player }

    private var padding: EdgeInsets {
        if app.isCinema { return EdgeInsets(top: 44, leading: 44, bottom: 44, trailing: 44) }
        return isScreen ? EdgeInsets(top: 10, leading: 12, bottom: 12, trailing: 12) : EdgeInsets()
    }

    private var radius: CGFloat { app.isCinema ? 16 : (isScreen ? 12 : 0) }

    var body: some View {
        ZStack {
            (isScreen ? palette.cardFill : Color.clear)
            webLayer
            nativeLayer
        }
        .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .strokeBorder(isScreen ? palette.line : .clear, lineWidth: palette.isDark ? 0.5 : 1)
                .allowsHitTesting(false)
        )
        .shadow(color: .black.opacity(isScreen && palette.isDark ? 0.5 : 0), radius: 18, y: 8)
        .padding(padding)
    }

    @ViewBuilder private var webLayer: some View {
        let isWeb = app.route == .web
        VStack(spacing: 0) {
            if let search = app.browser.search, isWeb {
                SearchDeckBar(search: search)
            }
            ZStack(alignment: .top) {
                WebHostView(tab: app.browser.selected, isVisible: isWeb)
                if isWeb, let tab = app.browser.selected {
                    LoadingSweep(tab: tab)
                    if let failure = tab.failure {
                        LoadFailureView(failure: failure, tab: tab)
                    } else if let rescue = tab.rescue {
                        RescuePanel(rescue: rescue, tab: tab)
                            .padding(14)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                            .transition(.move(edge: .top).combined(with: .opacity))
                    }
                    if tab.url == nil {
                        BlankTabView()
                    }
                    if app.isFindVisible {
                        FindBar(tab: tab)
                    }
                } else if isWeb {
                    BlankTabView()
                }
            }
        }
        .opacity(isWeb ? 1 : 0)
        .allowsHitTesting(isWeb)
    }

    @ViewBuilder private var nativeLayer: some View {
        switch app.route {
        case .web: EmptyView()
        case .home: HomeView().transition(.opacity)
        case .library: LibraryView().transition(.opacity)
        case .timeline: WatchTimelineView().transition(.opacity)
        case .settings: SettingsView().transition(.opacity)
        case .downloads: DownloadsView().transition(.opacity)
        case .player: LocalPlayerView().transition(.opacity)
        case .together: TogetherView().transition(.opacity)
        case .profile: ProfileView().transition(.opacity)
        case .rate: RateModeView().transition(.opacity)
        }
    }
}

// MARK: Web view host

struct WebHostView: NSViewRepresentable {
    let tab: BrowserTab?
    var isVisible: Bool

    func makeNSView(context: Context) -> WebContainerView { WebContainerView() }

    func updateNSView(_ view: WebContainerView, context: Context) {
        // Only create a web view once it's actually going to be seen.
        guard isVisible, let tab, tab.url != nil else {
            if !isVisible { return }
            view.show(nil)
            return
        }
        view.show(tab.ensureWebView())
    }
}

final class WebContainerView: NSView {
    private weak var current: WKWebView?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
    }

    required init?(coder: NSCoder) { fatalError("Not used") }

    func show(_ webView: WKWebView?) {
        guard webView !== current else { return }
        // A video in native fullscreen lives in its own window. Leave it there.
        if let current, current.fullscreenState != .notInFullscreen { return }
        current?.removeFromSuperview()
        current = webView
        guard let webView else { return }
        webView.frame = bounds
        webView.autoresizingMask = [.width, .height]
        addSubview(webView)
    }
}

// MARK: Web overlays

struct LoadingSweep: View {
    let tab: BrowserTab
    @Environment(\.palette) private var palette

    var body: some View {
        GeometryReader { geometry in
            Rectangle()
                .fill(palette.isDark ? Color.white : Color.black)
                .frame(width: geometry.size.width * max(0.04, tab.progress), height: 2)
                .opacity(tab.isLoading ? 0.85 : 0)
                .animation(.easeOut(duration: 0.25), value: tab.progress)
                .animation(.easeOut(duration: 0.3), value: tab.isLoading)
        }
        .frame(height: 2)
        .allowsHitTesting(false)
    }
}

struct BlankTabView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        ZStack {
            palette.cardFill
            VStack(spacing: 18) {
                LogoMark(size: 64, color: palette.ink3)
                Button("Search or enter an address") { app.openCommandBar() }
                    .buttonStyle(OutlineButtonStyle())
            }
        }
    }
}

struct LoadFailureView: View {
    let failure: LoadFailure
    let tab: BrowserTab
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        ZStack {
            palette.cardFill
            VStack(alignment: .leading, spacing: 14) {
                Text("\(failure.host) didn't load")
                    .font(Typeface.title(30))
                    .foregroundStyle(palette.ink)
                Text(failure.message)
                    .font(Typeface.ui(14))
                    .foregroundStyle(palette.ink2)
                    .frame(maxWidth: 440, alignment: .leading)
                if let rescue = tab.rescue {
                    RescueSearchBody(rescue: rescue, tab: tab)
                        .frame(maxWidth: 520)
                        .padding(.top, 6)
                } else {
                    HStack(spacing: 10) {
                        if app.session.rescue.canSearch(tab: tab, url: failure.url) {
                            Button("Find it on my other sites") {
                                app.session.rescue.tryFailedPageSearch(tab: tab, url: failure.url)
                            }
                            .buttonStyle(SilverButtonStyle())
                        }
                        Button("Try again") { tab.reload() }
                            .buttonStyle(OutlineButtonStyle())
                    }
                    .padding(.top, 6)
                }
            }
            .padding(40)
        }
    }
}

struct FindBar: View {
    let tab: BrowserTab
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var text = ""
    @State private var notFound = false
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 12))
                .foregroundStyle(palette.ink3)
            TextField("Find in page", text: $text)
                .textFieldStyle(.plain)
                .font(Typeface.ui(13))
                .frame(width: 180)
                .focused($focused)
                .onSubmit { find(backwards: false) }
            if notFound {
                Text("Not found")
                    .font(Typeface.ui(12))
                    .foregroundStyle(palette.ink3)
            }
            IconButton(symbol: "chevron.up", label: "Previous match", size: 11) { find(backwards: true) }
            IconButton(symbol: "chevron.down", label: "Next match", size: 11) { find(backwards: false) }
            IconButton(symbol: "xmark", label: "Close", size: 11) { app.isFindVisible = false }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .glassPanel(cornerRadius: 14)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .onAppear { focused = true }
        .onKeyDown { event in
            guard event.keyCode == KeyCode.escape else { return false }
            app.isFindVisible = false
            return true
        }
    }

    private func find(backwards: Bool) {
        guard !text.isEmpty, let webView = tab.webView else { return }
        let config = WKFindConfiguration()
        config.backwards = backwards
        config.wraps = true
        webView.find(text, configuration: config) { result in
            notFound = !result.matchFound
        }
    }
}

struct SearchDeckBar: View {
    let search: SearchSession
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 6) {
            Text(search.query)
                .font(Typeface.title(15))
                .foregroundStyle(palette.ink)
                .lineLimit(1)
                .padding(.trailing, 8)
            ScrollView(.horizontal) {
                HStack(spacing: 2) {
                    ForEach(search.results) { result in
                        Button {
                            search.select(result.id)
                        } label: {
                            HStack(spacing: 6) {
                                SiteIcon(name: result.site.name, url: result.site.iconURL, size: 14)
                                Text(result.site.name)
                                    .font(Typeface.ui(12, .medium))
                                    .foregroundStyle(search.selectedResultID == result.id ? palette.ink : palette.ink2)
                                    .lineLimit(1)
                            }
                        }
                        .buttonStyle(HoverButtonStyle(isSelected: search.selectedResultID == result.id))
                    }
                }
            }
            Spacer(minLength: 8)
            Button("Keep tab") {
                if let tab = search.selectedTab { app.browser.endSearch(keeping: tab) }
            }
            .buttonStyle(OutlineButtonStyle())
            IconButton(symbol: "xmark", label: "Close search") {
                app.browser.endSearch(keeping: nil)
                app.go(.home)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(palette.cardFill)
        .overlay(alignment: .bottom) {
            Rectangle().fill(palette.line).frame(height: 0.5)
        }
    }
}

// MARK: Top-level overlays

struct Overlays: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        ZStack {
            if let id = app.detailTitleID, let title = app.library.titles[id] {
                DimmedBackdrop { app.detailTitleID = nil }
                TitleDetailView(title: title)
                    .transition(.scale(scale: 0.96).combined(with: .opacity))
            }
            if let sheet = app.sheet {
                DimmedBackdrop { app.sheet = nil }
                SheetHost(sheet: sheet)
                    .transition(.scale(scale: 0.96).combined(with: .opacity))
            }
            if let proposal = app.session.seasons.proposal {
                DimmedBackdrop { app.session.seasons.decline() }
                SeriesDownloadSheet(proposal: proposal)
                    .transition(.scale(scale: 0.96).combined(with: .opacity))
            }
            if app.isCommandBarVisible {
                DimmedBackdrop(strength: 0.3) { app.closeCommandBar() }
                CommandBar()
                    .transition(.scale(scale: 0.97, anchor: .top).combined(with: .opacity))
            }
            ToastHost()
            if app.isProfilePickerVisible {
                ProfilePicker()
                    .transition(.opacity)
            }
            if app.isChangingReel {
                ReelChange()
                    .transition(.opacity)
            }
            if app.splashVisible {
                SplashView()
                    .transition(.opacity)
            }
        }
        .animation(Motion.pop, value: app.detailTitleID)
        .animation(Motion.pop, value: app.sheet)
        .animation(Motion.pop, value: app.session.seasons.proposal)
        .animation(Motion.quick, value: app.isProfilePickerVisible)
    }
}

struct DimmedBackdrop: View {
    var strength = 0.5
    let dismiss: () -> Void

    var body: some View {
        Color.black.opacity(strength)
            .ignoresSafeArea()
            .contentShape(Rectangle())
            .onTapGesture(perform: dismiss)
            .transition(.opacity)
    }
}

struct ToastHost: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        VStack {
            Spacer()
            if let toast = app.toasts.current {
                HStack(spacing: 14) {
                    Text(toast.message)
                        .font(Typeface.ui(13, .medium))
                        .foregroundStyle(palette.ink)
                        .lineLimit(2)
                    if let action = toast.action {
                        Button(action.title) {
                            action.run()
                            app.toasts.dismiss()
                        }
                        .buttonStyle(.plain)
                        .font(Typeface.ui(13, .semibold))
                        .foregroundStyle(palette.ink)
                        .underline()
                    }
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 11)
                .glassPanel(cornerRadius: 22)
                .padding(.bottom, 26)
                .id(toast.id)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
    }
}

// MARK: Window

struct WindowConfigurator: NSViewRepresentable {
    let configure: (NSWindow) -> Void

    func makeNSView(context: Context) -> ConfiguratorView {
        let view = ConfiguratorView()
        view.onWindow = configure
        return view
    }

    func updateNSView(_ view: ConfiguratorView, context: Context) {}

    final class ConfiguratorView: NSView {
        private static let autosaveName = "CineonMainWindow"
        var onWindow: ((NSWindow) -> Void)?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard let window else { return }
            window.titlebarAppearsTransparent = true
            window.titleVisibility = .hidden
            window.styleMask.insert(.fullSizeContentView)
            window.isMovableByWindowBackground = false
            window.tabbingMode = .disallowed
            window.backgroundColor = .clear
            window.collectionBehavior.insert(.fullScreenPrimary)
            // Remembers size and position between launches, and starts large on the first one. A test
            // run is the same app to macOS, so it keeps its own record and restores nothing, or it
            // would move the real window and could reopen it in full screen.
            let autosaveName = AppPaths.isScratch ? Self.autosaveName + "-Test" : Self.autosaveName
            if AppPaths.isScratch { window.isRestorable = false }
            if !window.setFrameUsingName(autosaveName) {
                let visible = window.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? .zero
                let size = NSSize(width: min(1360, visible.width - 40), height: min(860, visible.height - 40))
                window.setFrame(
                    NSRect(x: visible.midX - size.width / 2, y: visible.midY - size.height / 2, width: size.width, height: size.height),
                    display: true
                )
            }
            window.setFrameAutosaveName(autosaveName)
            onWindow?(window)
            watchWindowButtons(in: window)
        }

        override func viewWillMove(toWindow newWindow: NSWindow?) {
            super.viewWillMove(toWindow: newWindow)
            if newWindow == nil { stopWatching() }
        }

        private var observers: [NSObjectProtocol] = []

        /// AppKit puts the window's buttons back in the top 28 points whenever it lays out the
        /// title bar again: after a resize, leaving full screen, and when the window gains or loses
        /// focus. Each time, they go back to the middle of the top bar.
        private func watchWindowButtons(in window: NSWindow) {
            stopWatching()
            let center = NotificationCenter.default
            let names: [Notification.Name] = [
                NSWindow.didResizeNotification, NSWindow.didEndLiveResizeNotification, NSWindow.didExitFullScreenNotification,
                NSWindow.didDeminiaturizeNotification,
                NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification,
            ]
            for name in names {
                observers.append(center.addObserver(forName: name, object: window, queue: .main) { [weak window] _ in
                    MainActor.assumeIsolated { if let window { TrafficLights.place(in: window) } }
                })
            }
            // The button itself, and the title bar strip it sits in, moved by AppKit's own layout.
            let watched = [window.standardWindowButton(.closeButton), window.standardWindowButton(.closeButton)?.superview?.superview]
            for view in watched.compactMap({ $0 }) {
                view.postsFrameChangedNotifications = true
                observers.append(center.addObserver(forName: NSView.frameDidChangeNotification, object: view, queue: .main) { [weak window] _ in
                    MainActor.assumeIsolated { if let window { TrafficLights.place(in: window) } }
                })
            }
            TrafficLights.place(in: window)
            // Once more after the first layout pass, which happens after this.
            Task { @MainActor [weak window] in
                if let window { TrafficLights.place(in: window) }
            }
        }

        private func stopWatching() {
            observers.forEach(NotificationCenter.default.removeObserver)
            observers = []
        }
    }
}

/// The window's close, minimise and zoom buttons, in the middle of the top bar instead of the
/// top 28 points. Full screen keeps AppKit's own place for them.
enum TrafficLights {
    static let inset: CGFloat = 20

    static func place(in window: NSWindow) {
        // In full screen AppKit moves the title bar into a window of its own that slides down
        // from the top. That one is left exactly as AppKit made it.
        guard !window.styleMask.contains(.fullScreen),
              let close = window.standardWindowButton(.closeButton),
              let mini = window.standardWindowButton(.miniaturizeButton),
              let zoom = window.standardWindowButton(.zoomButton),
              let titlebar = close.superview,
              let container = titlebar.superview,
              let frameView = container.superview,
              frameView === window.contentView?.superview
        else { return }
        let height = TopBar.height
        let target = NSRect(x: 0, y: frameView.bounds.height - height, width: frameView.bounds.width, height: height)
        if container.frame != target { container.frame = target }
        if titlebar.frame != container.bounds { titlebar.frame = container.bounds }
        // Keep AppKit's own spacing between the three.
        let spacing = max(6, mini.frame.minX - close.frame.maxX)
        var x = inset
        for button in [close, mini, zoom] {
            let origin = NSPoint(x: x, y: ((height - button.frame.height) / 2).rounded())
            if button.frame.origin != origin { button.setFrameOrigin(origin) }
            x += button.frame.width + spacing
        }
    }

    /// Where the close button's centre is, from the window's top left. For the tests.
    static func report(in window: NSWindow) -> String {
        guard let close = window.standardWindowButton(.closeButton), !close.isHidden else { return "hidden" }
        let rect = close.convert(close.bounds, to: nil)
        if window.styleMask.contains(.fullScreen) { return "fullscreen" }
        return "\(Int(rect.midX.rounded())),\(Int((window.frame.height - rect.midY).rounded()))"
    }
}
