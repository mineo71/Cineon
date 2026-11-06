import SwiftUI
import UniformTypeIdentifiers



struct AddressPill: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var showShield = false

    private var tab: BrowserTab? { app.route == .web ? app.browser.selected : nil }

    private var host: String? {
        guard let host = tab?.url?.host else { return nil }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    /// The rest of the address, quieter than the site's name.
    private var path: String {
        guard let url = tab?.url, url.path != "/" else { return "" }
        return url.path + (url.query.map { "?\($0)" } ?? "")
    }

    var body: some View {
        HStack(spacing: 0) {
            if let tab {
                ShieldButton(tab: tab, isPresented: $showShield)
                    .padding(.leading, 3)
            }
            Button {
                app.openCommandBar(seed: tab?.url?.absoluteString ?? "")
            } label: {
                HStack(spacing: 0) {
                    if let host {
                        Text(host)
                            .foregroundStyle(palette.ink)
                            .fixedSize()
                        Text(path)
                            .foregroundStyle(palette.ink3)
                            .truncationMode(.tail)
                    } else {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 11))
                            .foregroundStyle(palette.ink3)
                            .padding(.trailing, 8)
                        Text("Search or enter address")
                            .foregroundStyle(palette.ink3)
                    }
                    Spacer(minLength: 0)
                }
                .font(Typeface.ui(12.5))
                .lineLimit(1)
                .frame(height: 30)
                .padding(.leading, tab == nil ? 12 : 4)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(tab?.url?.absoluteString ?? "Search or enter address (⌘L)")

            if tab != nil {
                IconButton(symbol: "plus", label: "Add to backlog (⌘D)", size: 11) {
                    app.addCurrentPageToBacklog()
                }
                .padding(.trailing, 2)
            }
        }
        .background(palette.raised, in: Capsule())
        .overlay(Capsule().strokeBorder(palette.line, lineWidth: 1))
    }
}

struct ShieldButton: View {
    let tab: BrowserTab
    @Binding var isPresented: Bool
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    private var isOff: Bool { app.session.shields.prefs(for: tab.url?.host).shieldsOff }

    var body: some View {
        Button {
            isPresented.toggle()
        } label: {
            HStack(spacing: 3) {
                Image(systemName: isOff ? "shield.slash" : "shield.lefthalf.filled")
                    .font(.system(size: 11, weight: .medium))
                if tab.blocked.total > 0, !isOff {
                    Text("\(tab.blocked.total)")
                        .font(Typeface.time(10.5, .medium))
                        .contentTransition(.numericText())
                }
            }
            .foregroundStyle(palette.ink2)
        }
        .buttonStyle(HoverButtonStyle(cornerRadius: 7, padding: EdgeInsets(top: 5, leading: 5, bottom: 5, trailing: 5)))
        .help("Shields")
        .accessibilityLabel("Shields, \(tab.blocked.total) blocked")
        .popover(isPresented: $isPresented, arrowEdge: .bottom) {
            ShieldPopover(tab: tab)
                .environment(\.palette, app.palette)
        }
    }
}

struct ShieldPopover: View {
    let tab: BrowserTab
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    private var host: String? { tab.url?.host }

    private func binding(_ keyPath: WritableKeyPath<SitePrefs, Bool>) -> Binding<Bool> {
        Binding(
            get: { app.session.shields.prefs(for: host)[keyPath: keyPath] },
            set: { value in
                app.session.shields.update(host: host) { $0[keyPath: keyPath] = value }
                if keyPath == \.shieldsOff { tab.reload() }
            }
        )
    }

    private func row(_ label: String, _ count: Int) -> some View {
        HStack {
            Text(label)
                .font(Typeface.ui(12.5))
                .foregroundStyle(palette.ink2)
            Spacer()
            Text("\(count)")
                .font(Typeface.time(12.5, .medium))
                .foregroundStyle(palette.ink)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(host.map(DomainName.registrable) ?? "This page")
                .font(Typeface.title(16))
                .foregroundStyle(palette.ink)
                .lineLimit(1)
            VStack(spacing: 6) {
                row("Ads and trackers", tab.blocked.ads)
                row("Pop-ups", tab.blocked.popups)
                row("Redirects", tab.blocked.redirects)
                row("Click traps", tab.blocked.overlays)
            }
            Divider()
            Toggle("Turn shields off for this site", isOn: binding(\.shieldsOff))
                .font(Typeface.ui(12.5))
            Toggle("Allow pop-ups", isOn: binding(\.allowPopups))
                .font(Typeface.ui(12.5))
            Toggle("Allow redirects", isOn: binding(\.allowRedirects))
                .font(Typeface.ui(12.5))
            Toggle("Don't track films on this site", isOn: binding(\.trackingOff))
                .font(Typeface.ui(12.5))
        }
        .toggleStyle(.switch)
        .controlSize(.mini)
        .tint(palette.isDark ? Color(white: 0.75) : .black)
        .padding(14)
        .frame(width: 260)
    }
}



struct SitesGrid: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 6), count: 4)

    var body: some View {
        LazyVGrid(columns: columns, spacing: 6) {
            ForEach(app.library.sites) { site in
                SiteTile(site: site)
            }
            Button {
                app.sheet = .addSite(prefill: nil)
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(palette.ink3)
                    .frame(maxWidth: .infinity)
                    .frame(height: 40)
                    .contentShape(Rectangle())
            }
            .buttonStyle(HoverButtonStyle(cornerRadius: 9, padding: EdgeInsets()))
            .help("Add a site")
            .accessibilityLabel("Add a site")
        }
    }
}

struct SiteTile: View {
    let site: Site
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    private var isCurrent: Bool {
        app.route == .web && DomainName.isSameSite(app.browser.selected?.url?.host, site.host)
    }

    var body: some View {
        Button {
            app.openSite(site)
        } label: {
            SiteIcon(name: site.name, url: site.iconURL, size: 20)
                .frame(maxWidth: .infinity)
                .frame(height: 40)
                .background(
                    palette.raised,
                    in: RoundedRectangle(cornerRadius: 9, style: .continuous)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .strokeBorder(isCurrent ? palette.ink2 : .clear, lineWidth: 1)
                )
        }
        .buttonStyle(HoverButtonStyle(cornerRadius: 9, padding: EdgeInsets()))
        .help(site.name)
        .accessibilityLabel(site.name)
        .contextMenu {
            Button("Open in new tab") { app.browser.openTab(url: site.homeURL, siteID: site.id) }
            Button("Edit…") { app.sheet = .editSite(site.id) }
            Divider()
            Button("Remove") { app.library.removeSite(site.id) }
        }
    }
}


struct TabDropDelegate: DropDelegate {
    let target: BrowserTab
    @Binding var dragging: UUID?
    let browser: BrowserModel

    func dropEntered(info: DropInfo) {
        guard let dragging, dragging != target.id else { return }
        let listed = browser.listedTabs
        guard let from = listed.firstIndex(where: { $0.id == dragging }),
              let to = listed.firstIndex(where: { $0.id == target.id })
        else { return }
        withAnimation(Motion.quick) {
            browser.move(from: IndexSet(integer: from), to: to > from ? to + 1 : to)
        }
    }

    func dropUpdated(info: DropInfo) -> DropProposal? { DropProposal(operation: .move) }

    func performDrop(info: DropInfo) -> Bool {
        dragging = nil
        return true
    }
}


/// Small equaliser bars, shown on the tab whose film is running.
struct PlayingIndicator: View {
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.18)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(alignment: .bottom, spacing: 1.5) {
                ForEach(0..<3, id: \.self) { index in
                    Capsule()
                        .fill(palette.ink)
                        .frame(width: 2, height: reduceMotion ? 7 : 4 + 7 * abs(sin(t * 2.3 + Double(index) * 1.4)))
                }
            }
            .frame(height: 12)
            .animation(.linear(duration: 0.18), value: context.date)
        }
        .accessibilityLabel("Playing")
    }
}

/// What's running right now, with the controls you want without hunting through a site's player.


