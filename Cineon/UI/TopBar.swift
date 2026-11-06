import SwiftUI
import UniformTypeIdentifiers

/// The bar across the top. The window's own buttons and the logo on the left, the sections in one
/// capsule in the middle like a TV app's, and what's playing, the tools and you on the right.
struct TopBar: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var width: CGFloat = 1400

    static let height: CGFloat = 56
    /// Room for the window's buttons, which `TrafficLights` centres in the bar.
    static let windowButtonsWidth: CGFloat = 96

    private var onHero: Bool { app.route == .home }

    /// Narrow windows first lose the playing title, then tighten the sections, then show only their icons.
    private var sections: SectionTabs.Style { width >= 1200 ? .regular : width >= 1100 ? .compact : .icons }
    private var compactPill: Bool { width < 1360 }

    var body: some View {
        CentredBar(gap: 14) {
            HStack(spacing: 0) {
                Color.clear.frame(width: Self.windowButtonsWidth)
                Button { app.go(.home) } label: {
                    HStack(spacing: 8) {
                        LogoMark(size: 22)
                        Text("Cineon")
                            .font(Typeface.bold(17))
                            .foregroundStyle(palette.ink)
                    }
                    .shadow(color: onHero && palette.isDark ? .black.opacity(0.5) : .clear, radius: 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Home")
            }

            SectionTabs(style: sections, onHero: onHero)

            HStack(spacing: 10) {
                NowPlayingPill(compact: compactPill, onHero: onHero)
                HStack(spacing: 0) {
                    IconButton(symbol: "magnifyingglass", label: "Search films and sites (⌘K)") { app.openCommandBar() }
                    SitesButton()
                    RateButton()
                }
                .padding(.horizontal, 3)
                .frame(height: 34)
                .modifier(BarCapsule(onHero: onHero))
                AvatarButton(onHero: onHero)
            }
        }
        .padding(.trailing, 16)
        .frame(height: Self.height)
        .frame(maxWidth: .infinity)
        .background(alignment: .top) { background }
        .contentShape(Rectangle())
        .gesture(WindowDragGesture())
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }

    /// Over a film the bar is a shadow falling from the top. Elsewhere it's the room's black.
    @ViewBuilder private var background: some View {
        if onHero {
            // The page's own colour, so the bar's text keeps its contrast in either theme.
            LinearGradient(colors: [palette.canvas.opacity(0.78), palette.canvas.opacity(0.4), .clear], startPoint: .top, endPoint: .bottom)
                .frame(height: Self.height + 30)
                .allowsHitTesting(false)
        } else {
            palette.canvas
                .overlay(alignment: .bottom) {
                    if app.route != .web { Rectangle().fill(palette.line).frame(height: 0.5) }
                }
        }
    }
}

/// What the bar's capsules are made of: smoked glass over a film, a faint raise elsewhere.
struct BarCapsule: ViewModifier {
    var onHero: Bool
    @Environment(\.palette) private var palette

    func body(content: Content) -> some View {
        content
            .background {
                if onHero {
                    Capsule().fill(.ultraThinMaterial).overlay(Capsule().fill(palette.canvas.opacity(palette.isDark ? 0.35 : 0.3)))
                } else {
                    Capsule().fill(palette.raised)
                }
            }
            .clipShape(Capsule())
            .overlay(Capsule().strokeBorder(onHero && palette.isDark ? Color.white.opacity(0.14) : palette.line, lineWidth: 1))
    }
}

/// Three groups in a bar: one at each end, and one in the middle of the whole width. The middle
/// one only moves off centre when it would run into either end, and is offered what's left.
struct CentredBar: Layout {
    var gap: CGFloat = 12

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        let width = sizes.reduce(0) { $0 + $1.width } + gap * CGFloat(max(0, sizes.count - 1))
        return CGSize(width: proposal.width ?? width, height: proposal.height ?? (sizes.map(\.height).max() ?? 0))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count == 3 else { return }
        let lead = subviews[0].sizeThatFits(.unspecified)
        let trail = subviews[2].sizeThatFits(.unspecified)
        subviews[0].place(at: CGPoint(x: bounds.minX, y: bounds.midY), anchor: .leading, proposal: ProposedViewSize(width: lead.width, height: bounds.height))
        subviews[2].place(at: CGPoint(x: bounds.maxX, y: bounds.midY), anchor: .trailing, proposal: ProposedViewSize(width: trail.width, height: bounds.height))
        let minX = bounds.minX + lead.width + gap
        let maxX = bounds.maxX - trail.width - gap
        let room = max(0, maxX - minX)
        let width = min(subviews[1].sizeThatFits(ProposedViewSize(width: room, height: bounds.height)).width, room)
        let x = max(minX, min(bounds.midX - width / 2, maxX - width))
        subviews[1].place(at: CGPoint(x: x, y: bounds.midY), anchor: .leading, proposal: ProposedViewSize(width: width, height: bounds.height))
    }
}

/// The app's sections in one capsule, each with its icon. The one you're in is lit silver, and
/// the light slides across when you move.
struct SectionTabs: View {
    /// Names and icons; the same, closer together; icons alone, named on hover.
    enum Style { case regular, compact, icons }

    var style: Style
    var onHero: Bool
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @Namespace private var lit

    struct Item: Identifiable {
        var label: String
        var symbol: String
        var route: Route
        var also: [Route] = []
        var count: Int?
        var isLive = false
        var id: String { label }
    }

    private var items: [Item] {
        var list = [
            Item(label: "Home", symbol: "house", route: .home),
            Item(label: "Library", symbol: "film.stack", route: .library),
            Item(label: "Timeline", symbol: "clock", route: .timeline),
            Item(
                label: "Downloads", symbol: "arrow.down.circle", route: .downloads, also: [.player],
                count: app.session.downloads.activeCount > 0 ? app.session.downloads.activeCount : nil
            ),
            Item(label: "Together", symbol: "person.2", route: .together, isLive: app.session.together.party != nil),
        ]
        if !app.browser.listedTabs.isEmpty {
            list.append(Item(label: "Browse", symbol: "globe", route: .web, count: app.browser.listedTabs.count))
        }
        return list
    }

    private func isSelected(_ item: Item) -> Bool { app.route == item.route || item.also.contains(app.route) }

    private func open(_ item: Item) {
        if item.route == .web, app.browser.selected == nil, let first = app.browser.listedTabs.first {
            app.browser.select(first)
        }
        app.go(item.route)
    }

    var body: some View {
        HStack(spacing: 2) {
            ForEach(items) { item in
                SectionTab(item: item, isSelected: isSelected(item), style: style, lit: lit) { open(item) }
            }
        }
        // The bar picks a style that fits, so the names never need to be cut short.
        .fixedSize()
        .padding(4)
        .modifier(BarCapsule(onHero: onHero))
        .animation(.snappy(duration: 0.3), value: app.route)
    }
}

struct SectionTab: View {
    let item: SectionTabs.Item
    let isSelected: Bool
    let style: SectionTabs.Style
    let lit: Namespace.ID
    let action: () -> Void
    @Environment(\.palette) private var palette
    @State private var isHovered = false

    private var leading: CGFloat {
        switch style {
        case .regular: 13
        case .compact: 10
        case .icons: 11
        }
    }

    private var trailing: CGFloat {
        switch style {
        case .regular: item.count == nil ? 16 : 12
        case .compact: item.count == nil ? 12 : 9
        case .icons: item.count == nil ? 11 : 9
        }
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: style == .regular ? 7 : 5) {
                Image(systemName: item.symbol)
                    .symbolVariant(isSelected ? .fill : .none)
                    .font(.system(size: style == .regular ? 13 : 12.5, weight: .medium))
                    .frame(width: 17)
                if style != .icons {
                    Text(item.label)
                        .font(Typeface.title(style == .compact ? 13.5 : 14.5))
                }
                if item.isLive {
                    Circle().fill(palette.gold).frame(width: 6, height: 6)
                        .help("A watch party is on")
                }
                if let count = item.count {
                    Text("\(count)")
                        .font(Typeface.time(10.5, .semibold))
                        .padding(.horizontal, 5)
                        .frame(minWidth: 18, minHeight: 16)
                        .background(Capsule().fill(isSelected ? palette.onSilver.opacity(0.16) : palette.raised2))
                }
            }
            .foregroundStyle(isSelected ? palette.onSilver : (isHovered ? palette.ink : palette.ink2))
            .padding(.leading, leading)
            .padding(.trailing, trailing)
            .frame(height: 30)
            .background {
                if isSelected {
                    Capsule().fill(palette.silver).matchedGeometryEffect(id: "lit", in: lit)
                } else if isHovered {
                    Capsule().fill(palette.raised)
                }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .help(style == .icons ? item.label : "")
        .accessibilityLabel(item.label)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// What's playing, from any page: poster, name, episode, play/pause and a hairline of how far
/// you are. Its arrow opens every control. Narrow windows keep just the poster and the buttons.
struct NowPlayingPill: View {
    var compact: Bool
    var onHero: Bool
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var showsControls = false

    private static let height: CGFloat = 34

    var body: some View {
        if let player = app.activePlayer, player.duration > 0 {
            let title = player.titleID.flatMap { app.library.titles[$0] }
            let name = title?.name ?? name(player)
            HStack(spacing: 0) {
                Button {
                    switch player {
                    case .local: app.go(.player)
                    case .web(let tab):
                        app.browser.select(tab)
                        app.go(.web)
                    }
                } label: {
                    HStack(spacing: 9) {
                        thumbnail(title?.posterURL)
                        if !compact {
                            Text(name)
                                .font(Typeface.title(13.5))
                                .foregroundStyle(palette.ink)
                                .lineLimit(1)
                                .frame(maxWidth: 120, alignment: .leading)
                                .fixedSize(horizontal: true, vertical: false)
                            detail(player)
                        }
                    }
                    .padding(.leading, 4)
                    .padding(.trailing, compact ? 0 : 4)
                    .frame(height: Self.height)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(compact ? name : "Go to what's playing")

                IconButton(symbol: player.isPlaying ? "pause.fill" : "play.fill", label: player.isPlaying ? "Pause" : "Play", size: 10.5) {
                    player.toggle()
                }
                IconButton(symbol: "chevron.down", label: "Player controls", size: 8.5) { showsControls.toggle() }
                    .popover(isPresented: $showsControls, arrowEdge: .bottom) {
                        PlayerControlsPanel()
                            .environment(app)
                            .environment(\.palette, app.palette)
                    }
            }
            .padding(.trailing, 2)
            .frame(height: Self.height)
            .overlay(alignment: .bottom) { progress(player) }
            .modifier(BarCapsule(onHero: onHero))
            .transition(.scale(scale: 0.9).combined(with: .opacity))
        }
    }

    /// The poster, its left edge following the capsule's curve, or a film frame when there's none.
    private func thumbnail(_ url: URL?) -> some View {
        let shape = UnevenRoundedRectangle(topLeadingRadius: 13, bottomLeadingRadius: 13, bottomTrailingRadius: 4, topTrailingRadius: 4, style: .continuous)
        return RemoteImage(url: url, maxPixel: 80) {
            ZStack {
                palette.raised2
                Image(systemName: "film")
                    .font(.system(size: 8, weight: .medium))
                    .foregroundStyle(palette.ink3)
            }
        }
        .frame(width: 18, height: 26)
        .clipShape(shape)
    }

    /// The episode, the sleep timer, or how much is left.
    @ViewBuilder private func detail(_ player: ActivePlayer) -> some View {
        Group {
            if let timer = app.sleepTimerRemaining, app.sleepTimer != nil {
                Label(Timecode.string(timer), systemImage: "moon.fill")
                    .labelStyle(.titleAndIcon)
                    .help("Sleep timer")
            } else if let ref = player.ref {
                Text(ref.shortLabel)
            } else {
                Text("−" + Timecode.string(max(0, player.duration - player.position)))
                    .help("Time left")
            }
        }
        .font(Typeface.time(11.5))
        .foregroundStyle(palette.ink2)
        .lineLimit(1)
        .fixedSize()
    }

    private func progress(_ player: ActivePlayer) -> some View {
        let fraction = min(1, max(0, player.position / player.duration))
        return GeometryReader { geometry in
            Rectangle()
                .fill(palette.ink.opacity(0.8))
                .frame(width: geometry.size.width * fraction, height: 2)
                .frame(maxHeight: .infinity, alignment: .bottom)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func name(_ player: ActivePlayer) -> String {
        switch player {
        case .local(let playback): playback.name
        case .web(let tab): tab.parsed?.name ?? tab.displayTitle
        }
    }
}

/// The sites you watch on, as a grid, with the open tabs above them.
struct SitesButton: View {
    @Environment(AppModel.self) private var app
    @State private var isOpen = false

    var body: some View {
        IconButton(symbol: "square.grid.2x2", label: "Sites") { isOpen.toggle() }
            .popover(isPresented: $isOpen, arrowEdge: .bottom) {
                SitesPanel { isOpen = false }
                    .environment(app)
                    .environment(\.palette, app.palette)
            }
    }
}

struct SitesPanel: View {
    var close: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Where to watch")
                .font(Typeface.title(16))
                .foregroundStyle(palette.ink)
            SitesGrid()
                .simultaneousGesture(TapGesture().onEnded { close() })
            Button {
                close()
                app.openCommandBar()
            } label: {
                Label("Open an address", systemImage: "plus")
                    .font(Typeface.ui(12.5))
                    .foregroundStyle(palette.ink2)
            }
            .buttonStyle(HoverButtonStyle())
        }
        .padding(16)
        .frame(width: 300)
    }
}

/// Rating mode, with how many watched films still have no stars.
struct RateButton: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        let unrated = app.library.titles.values.filter { $0.status == .watched && $0.ratingHalves == nil }.count
        Button { app.go(.rate) } label: {
            Image(systemName: "star.leadinghalf.filled")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(app.route == .rate ? AnyShapeStyle(palette.gold) : AnyShapeStyle(palette.ink2))
                .frame(width: 16, height: 16)
        }
        .buttonStyle(HoverButtonStyle(cornerRadius: 7, padding: EdgeInsets(top: 5, leading: 5, bottom: 5, trailing: 5)))
        .accessibilityLabel(unrated > 0 ? "Rate your films, \(unrated) waiting" : "Rate your films")
        .help(unrated > 0 ? "Rate your films: \(unrated) watched without stars" : "Rate your films")
    }
}

/// Your pet, which is you. Click for your profile; the menu has the rest.
struct AvatarButton: View {
    var onHero = false
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        Menu {
            Button("Profile") { app.go(.profile) }
            Button("Who's watching…") { app.isProfilePickerVisible = true }
            Divider()
            Button(palette.isDark ? "Light theme" : "Dark theme") { app.toggleTheme() }
            Button("Settings…") { app.go(.settings) }
        } label: {
            PixelPetView(pet: app.session.pet, size: 28, animated: false)
                .frame(width: 34, height: 34)
                .background(Circle().fill(onHero ? AnyShapeStyle(.ultraThinMaterial) : AnyShapeStyle(palette.raised2)))
                .clipShape(Circle())
                .overlay(
                    Circle().strokeBorder(
                        app.route == .profile ? AnyShapeStyle(palette.gold) : AnyShapeStyle(onHero && palette.isDark ? Color.white.opacity(0.16) : palette.line),
                        lineWidth: 1
                    )
                )
        } primaryAction: {
            app.go(.profile)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("\(app.session.profile.name): profile")
    }
}

// MARK: Browser bar

/// Only when on a site: back and forward and the open tabs, the address in the middle under the
/// sections, then downloading.
struct BrowserBar: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var width: CGFloat = 1400

    static let height: CGFloat = 44

    private var tab: BrowserTab? { app.browser.selected }

    /// Back, forward, reload and the bar's padding on one side; download and new tab on the other.
    private static let sideControls: CGFloat = 116
    private var addressWidth: CGFloat { min(520, max(240, width - 2 * Self.sideControls - 2 * 160)) }
    /// The tabs get what's left beside the address, so the address stays centred under the sections.
    private var tabsWidth: CGFloat { max(0, width / 2 - addressWidth / 2 - Self.sideControls - 12) }

    var body: some View {
        CentredBar(gap: 12) {
            HStack(spacing: 2) {
                IconButton(symbol: "chevron.left", label: "Back (⌘[)", isEnabled: tab?.canGoBack == true) { tab?.goBack() }
                IconButton(symbol: "chevron.right", label: "Forward (⌘])", isEnabled: tab?.canGoForward == true) { tab?.goForward() }
                IconButton(
                    symbol: tab?.isLoading == true ? "xmark" : "arrow.clockwise",
                    label: tab?.isLoading == true ? "Stop" : "Reload (⌘R)",
                    isEnabled: tab != nil
                ) {
                    if tab?.isLoading == true { tab?.stop() } else { tab?.reload() }
                }
                TabStrip(showsNewTab: false)
                    .frame(maxWidth: tabsWidth, alignment: .leading)
                    .padding(.leading, 8)
            }
            AddressPill()
                .frame(width: addressWidth)
            HStack(spacing: 2) {
                if let tab { DownloadMenuButton(tab: tab) }
                IconButton(symbol: "plus", label: "New tab (⌘T)", size: 12) { app.openCommandBar() }
            }
        }
        .padding(.leading, 16)
        .padding(.trailing, 14)
        .frame(height: Self.height)
        .background(palette.canvas)
        .overlay(alignment: .top) { Rectangle().fill(palette.line).frame(height: 0.5) }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }
}

/// Download this, the rest of the season, or all of it.
struct DownloadMenuButton: View {
    let tab: BrowserTab
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        let isEpisode = (tab.track?.ref ?? tab.parsed?.ref)?.isEpisode == true
        let seasons = app.session.seasons!
        Menu {
            Button("Download this video") { app.session.downloads.download(from: tab) }
                .disabled(tab.bestSource == nil)
            if isEpisode {
                Divider()
                Button("Download the rest of this season") { seasons.start(from: tab, fromCurrent: true) }
                Button("Download the whole season") { seasons.start(from: tab, fromCurrent: false) }
                    .disabled(seasons.isBusy)
                Button("Download the whole series…") { seasons.startSeries(from: tab) }
                    .disabled(seasons.isBusy)
            }
            Divider()
            Button("Show downloads") { app.go(.downloads) }
        } label: {
            Image(systemName: seasons.isBusy ? "arrow.down.circle.dotted" : "arrow.down.circle")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(tab.bestSource == nil ? palette.ink3 : palette.ink2)
                .frame(width: 26, height: 26)
                .contentShape(Rectangle())
        } primaryAction: {
            app.session.downloads.download(from: tab)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .help(isEpisode ? "Download (hold for the whole season)" : "Download this video")
    }
}

/// Open tabs as chips. The one playing shows its equaliser.
struct TabStrip: View {
    var showsNewTab = true
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var dragging: UUID?

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 4) {
                ForEach(app.browser.listedTabs) { tab in
                    TabChip(tab: tab)
                        .onDrag {
                            dragging = tab.id
                            return NSItemProvider(object: tab.id.uuidString as NSString)
                        }
                        .onDrop(of: [UTType.text], delegate: TabDropDelegate(target: tab, dragging: $dragging, browser: app.browser))
                }
                if showsNewTab {
                    IconButton(symbol: "plus", label: "New tab (⌘T)", size: 11) { app.openCommandBar() }
                }
            }
        }
        .scrollIndicators(.never)
    }
}

struct TabChip: View {
    let tab: BrowserTab
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var isHovered = false

    private var isSelected: Bool { app.route == .web && app.browser.selectedID == tab.id && app.browser.search == nil }

    var body: some View {
        Button {
            app.browser.select(tab)
            app.go(.web)
        } label: {
            HStack(spacing: 7) {
                if tab.media?.isPlaying == true {
                    PlayingIndicator().frame(width: 14)
                } else {
                    SiteIcon(name: tab.displayTitle, url: tab.faviconURL, size: 13)
                        .opacity(tab.isHibernated ? 0.55 : 1)
                }
                Text(tab.parsed?.name ?? tab.displayTitle)
                    .font(Typeface.ui(12, isSelected ? .medium : .regular))
                    .foregroundStyle(isSelected ? palette.ink : palette.ink2)
                    .lineLimit(1)
                    .frame(maxWidth: 150, alignment: .leading)
                Button { app.browser.close(tab) } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(palette.ink3)
                        .frame(width: 14, height: 14)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .opacity(isHovered || isSelected ? 1 : 0)
                .accessibilityLabel("Close tab")
            }
            .padding(.leading, 9)
            .padding(.trailing, 5)
            .frame(height: 28)
            .background(isSelected ? palette.raised2 : (isHovered ? palette.raised : .clear), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .contextMenu {
            Button("Reload") { tab.reload() }
            Button("Close") { app.browser.close(tab) }
        }
        .help(tab.url?.absoluteString ?? "")
    }
}
