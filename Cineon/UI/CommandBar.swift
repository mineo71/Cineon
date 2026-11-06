import SwiftUI

/// ⌘T. Type a film, a site or an address. The first thing you reach for in Cineon.
struct CommandBar: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var query = ""
    @State private var selection = 0
    @State private var hits: [MetadataHit] = []
    @FocusState private var isFocused: Bool

    private struct Item: Identifiable {
        let id: String
        let symbol: String?
        let imageURL: URL?
        let primary: String
        let secondary: String?
        let run: () -> Void
    }

    private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var items: [Item] {
        let text = trimmed
        return text.isEmpty ? idleItems : searchItems(for: text)
    }

    private var idleItems: [Item] {
        var out: [Item] = []
        for entry in app.library.continueWatching.prefix(3) {
            let (title, progress) = entry
            out.append(Item(
                id: "continue\(title.id)",
                symbol: nil,
                imageURL: title.posterURL,
                primary: title.name,
                secondary: progress.isVisitOnly ? "Open on \(DomainName.registrable(progress.host))" : "Resume at \(Timecode.string(progress.position))",
                run: { app.resume(title) }
            ))
        }
        for tab in app.browser.listedTabs.prefix(4) {
            out.append(Item(id: "tab\(tab.id)", symbol: "macwindow", imageURL: tab.faviconURL, primary: tab.displayTitle, secondary: "Switch to tab") {
                app.browser.select(tab)
            })
        }
        for site in app.library.sites.prefix(4) {
            out.append(Item(id: "site\(site.id)", symbol: "globe", imageURL: site.iconURL, primary: site.name, secondary: site.host) {
                app.openSite(site)
            })
        }
        return out
    }

    private func searchItems(for text: String) -> [Item] {
        var out: [Item] = []

        if let url = Self.directURL(from: text) {
            out.append(Item(id: "url", symbol: "arrow.up.forward", imageURL: nil, primary: "Go to \(url.host ?? text)", secondary: nil) {
                openInTab(url)
            })
        }

        out.append(Item(id: "everywhere", symbol: "square.stack.3d.up", imageURL: nil, primary: "Search “\(text)” on all my sites", secondary: "\(app.library.sites.filter { $0.searchTemplate != nil }.count) sites") {
            app.browser.searchEverywhere(text)
        })

        for title in app.library.search(text, limit: 5) {
            out.append(Item(id: "title\(title.id)", symbol: nil, imageURL: title.posterURL, primary: title.name, secondary: title.status == .none ? nil : title.status.label) {
                app.detailTitleID = title.id
            })
        }

        for site in app.library.sites where site.name.localizedCaseInsensitiveContains(text) || site.host.localizedCaseInsensitiveContains(text) {
            out.append(Item(id: "site\(site.id)", symbol: "globe", imageURL: site.iconURL, primary: site.name, secondary: site.host) {
                app.openSite(site)
            })
        }

        let known = Set(app.library.titles.values.compactMap(\.imdbID))
        for hit in hits.prefix(5) where !known.contains(hit.id) {
            let year = hit.year.map(String.init)
            let subtitle = ["Add to backlog", year, hit.kind == .series ? "Series" : nil].compactMap { $0 }.joined(separator: ", ")
            out.append(Item(id: "hit\(hit.id)", symbol: nil, imageURL: hit.posterURL, primary: hit.name, secondary: subtitle) {
                app.addToBacklog(hit: hit)
            })
        }

        for entry in (try? app.session.db.searchHistory(text, limit: 5)) ?? [] {
            out.append(Item(id: "history\(entry.id)", symbol: "clock", imageURL: nil, primary: entry.title.isEmpty ? entry.url.absoluteString : entry.title, secondary: entry.host) {
                openInTab(entry.url)
            })
        }

        if "import".hasPrefix(text.lowercased()) || text.lowercased().contains("import") {
            out.append(Item(id: "import", symbol: "square.and.arrow.down", imageURL: nil, primary: "Import from another browser", secondary: "Arc, Chrome and others") {
                app.sheet = .importBrowser
            })
        }

        if let web = app.settings.searchEngine.url(for: text) {
            out.append(Item(id: "web", symbol: "magnifyingglass", imageURL: nil, primary: "Search the web for “\(text)”", secondary: app.settings.searchEngine.label) {
                openInTab(web)
            })
        }
        return out
    }

    private func openInTab(_ url: URL) {
        app.browser.endSearch(keeping: nil)
        app.browser.openTab(url: url)
    }

    /// Recognises addresses typed without a scheme, like "site.to/film".
    static func directURL(from text: String) -> URL? {
        if text.contains(" ") { return nil }
        if text.hasPrefix("http://") || text.hasPrefix("https://") { return URL(string: text) }
        if text.hasPrefix("localhost") || text.hasPrefix("127.0.0.1") { return URL(string: "http://\(text)") }
        let hostPart = text.split(separator: "/").first.map(String.init) ?? text
        let labels = hostPart.split(separator: ".")
        guard labels.count >= 2, let last = labels.last, last.count >= 2, last.allSatisfy(\.isLetter) else { return nil }
        return URL(string: "https://\(text)")
    }

    var body: some View {
        let shown = items
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 16))
                    .foregroundStyle(palette.ink3)
                TextField("Search your sites, your library or the web", text: $query)
                    .textFieldStyle(.plain)
                    .font(Typeface.ui(18))
                    .foregroundStyle(palette.ink)
                    .focused($isFocused)
                    .onSubmit { run(shown) }
            }
            .padding(.horizontal, 18)
            .frame(height: 56)

            if !shown.isEmpty {
                Rectangle().fill(palette.line).frame(height: 0.5)
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(spacing: 1) {
                            ForEach(Array(shown.enumerated()), id: \.element.id) { index, item in
                                row(item, isSelected: index == min(selection, shown.count - 1))
                                    .id(item.id)
                                    .onTapGesture {
                                        selection = index
                                        run(shown)
                                    }
                            }
                        }
                        .padding(7)
                    }
                    .scrollIndicators(.never)
                    // A scroll view takes all the height it's offered, so size it to its rows.
                    .frame(height: min(420, CGFloat(shown.count) * 39 + 14))
                    .onChange(of: selection) {
                        let index = min(selection, shown.count - 1)
                        if shown.indices.contains(index) { proxy.scrollTo(shown[index].id) }
                    }
                }
            }
        }
        .frame(width: 640)
        .animation(Motion.quick, value: shown.count)
        .glassPanel(cornerRadius: 18)
        .frame(maxHeight: .infinity, alignment: .top)
        .padding(.top, 88)
        .onAppear {
            query = app.commandBarSeed
            isFocused = true
        }
        .onChange(of: query) { selection = 0 }
        .task(id: trimmed) { await searchMetadata() }
        .onKeyDown { event in
            switch event.keyCode {
            case KeyCode.escape:
                app.closeCommandBar()
                return true
            case KeyCode.down:
                selection = min(selection + 1, shown.count - 1)
                return true
            case KeyCode.up:
                selection = max(selection - 1, 0)
                return true
            default:
                return false
            }
        }
    }

    private func row(_ item: Item, isSelected: Bool) -> some View {
        HStack(spacing: 12) {
            Group {
                if let url = item.imageURL {
                    RemoteImage(url: url, maxPixel: 120) {
                        Image(systemName: item.symbol ?? "film")
                            .font(.system(size: 13))
                            .foregroundStyle(palette.ink2)
                    }
                    .frame(width: 24, height: item.symbol == nil ? 34 : 24)
                    .clipShape(RoundedRectangle(cornerRadius: 3, style: .continuous))
                } else {
                    Image(systemName: item.symbol ?? "film")
                        .font(.system(size: 13))
                        .foregroundStyle(palette.ink2)
                }
            }
            .frame(width: 24)

            Text(item.primary)
                .font(Typeface.ui(14, isSelected ? .medium : .regular))
                .foregroundStyle(palette.ink)
                .lineLimit(1)
            Spacer(minLength: 8)
            if let secondary = item.secondary {
                Text(secondary)
                    .font(Typeface.ui(12))
                    .foregroundStyle(palette.ink3)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 11)
        .frame(minHeight: 38)
        .background(isSelected ? palette.raised2 : .clear, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .contentShape(Rectangle())
    }

    private func run(_ shown: [Item]) {
        let index = min(selection, shown.count - 1)
        guard shown.indices.contains(index) else { return }
        app.closeCommandBar()
        shown[index].run()
    }

    private func searchMetadata() async {
        let text = trimmed
        guard app.settings.fetchMetadata, text.count >= 2, Self.directURL(from: text) == nil else {
            hits = []
            return
        }
        // Wait for a pause in typing, so each keystroke doesn't become a network request.
        try? await Task.sleep(for: .milliseconds(220))
        guard !Task.isCancelled else { return }
        let found = await MetadataClient.search(text)
        guard !Task.isCancelled else { return }
        hits = found
    }
}
