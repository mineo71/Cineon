import SwiftUI

/// Brings in what's already in Arc, Chrome and friends. Nothing is written until you've reviewed
/// the list and pressed Import.
struct ImportSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var stage: Stage = .looking
    @State private var chosenSites: Set<String> = []
    @State private var chosenTitles: Set<String> = []
    @State private var statuses: [String: TitleStatus] = [:]
    @State private var includePages = true

    private enum Stage {
        case looking
        case choose([ImportSource])
        case scanning(ImportSource)
        case review(ImportScan)
        case importing
        case done(String)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(heading)
                    .font(Typeface.title(24))
                    .foregroundStyle(palette.ink)
                    .lineLimit(1)
                Spacer()
                IconButton(symbol: "xmark", label: "Close") { app.sheet = nil }
            }
            content
        }
        .padding(24)
        .frame(width: 680)
        // Checkboxes in the chrome's silver, not the system's accent colour.
        .tint(palette.isDark ? Color(white: 0.82) : .black)
        .glassPanel(cornerRadius: 18)
        .task { await lookForBrowsers() }
    }

    private var heading: String {
        switch stage {
        case .review(let scan): "Found in \(scan.sourceLabel)"
        case .done: "Import finished"
        default: "Import from another browser"
        }
    }

    @ViewBuilder private var content: some View {
        switch stage {
        case .looking:
            progress("Looking for browsers on this Mac")
        case .choose(let sources):
            chooseView(sources)
        case .scanning(let source):
            progress("Looking for films in \(source.label)")
        case .review(let scan):
            reviewView(scan)
        case .importing:
            progress("Importing")
        case .done(let message):
            doneView(message)
        }
    }

    private func progress(_ text: String) -> some View {
        HStack(spacing: 12) {
            ProgressView().controlSize(.small)
            Text(text)
                .font(Typeface.ui(14))
                .foregroundStyle(palette.ink2)
        }
        .frame(maxWidth: .infinity, minHeight: 110)
    }

    // MARK: Choosing a browser

    private func chooseView(_ sources: [ImportSource]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if sources.isEmpty {
                Text("No browsers with anything to import were found. Cineon can read Arc, Chrome, Brave, Edge, Vivaldi, Dia, Opera and Yandex.")
                    .font(Typeface.ui(14))
                    .foregroundStyle(palette.ink2)
            } else {
                Text("Cineon finds the sites and films in there. You choose what to keep on the next step, and nothing changes in the other browser.")
                    .font(Typeface.ui(13))
                    .foregroundStyle(palette.ink2)
                VStack(spacing: 1) {
                    ForEach(sources) { source in
                        Button {
                            Task { await scan(source) }
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "globe")
                                    .font(.system(size: 16))
                                    .foregroundStyle(palette.ink2)
                                    .frame(width: 22)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(source.label)
                                        .font(Typeface.ui(14, .medium))
                                        .foregroundStyle(palette.ink)
                                    Text(describe(source))
                                        .font(Typeface.ui(12))
                                        .foregroundStyle(palette.ink3)
                                }
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(palette.ink3)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(HoverButtonStyle(padding: EdgeInsets(top: 9, leading: 8, bottom: 9, trailing: 10)))
                    }
                }
            }
            Text("Passwords and cookies are never read.")
                .font(Typeface.ui(12))
                .foregroundStyle(palette.ink3)
        }
    }

    private func describe(_ source: ImportSource) -> String {
        var parts: [String] = []
        if source.historyCount > 0 { parts.append("\(source.historyCount.formatted()) pages") }
        if source.bookmarkCount > 0 { parts.append("\(source.bookmarkCount.formatted()) bookmarks") }
        if source.pinnedCount > 0 { parts.append("\(source.pinnedCount.formatted()) saved tabs") }
        return parts.joined(separator: ", ")
    }

    // MARK: Reviewing

    private func reviewView(_ scan: ImportScan) -> some View {
        let newSites = scan.sites.filter { app.library.site(forHost: $0.host) == nil }
        return VStack(alignment: .leading, spacing: 14) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if !newSites.isEmpty { sitesSection(newSites) }
                    if !scan.titles.isEmpty { titlesSection(scan.titles) }
                    if newSites.isEmpty && scan.titles.isEmpty {
                        Text("No film sites or films turned up here, but your history can still be made searchable.")
                            .font(Typeface.ui(13))
                            .foregroundStyle(palette.ink2)
                    }
                }
            }
            .frame(maxHeight: 400)

            if scan.totalPages > 0 {
                Toggle(isOn: $includePages) {
                    Text(pagesLabel(scan))
                        .font(Typeface.ui(13))
                        .foregroundStyle(palette.ink)
                }
                .toggleStyle(.checkbox)
            }

            HStack {
                Button("Back") { Task { await lookForBrowsers() } }
                    .buttonStyle(OutlineButtonStyle())
                Spacer()
                Button("Import") { Task { await runImport(scan) } }
                    .buttonStyle(SilverButtonStyle())
            }
        }
    }

    private func pagesLabel(_ scan: ImportScan) -> String {
        if scan.totalPages > scan.pages.count {
            return "Make the latest \(scan.pages.count.formatted()) of \(scan.totalPages.formatted()) visited pages searchable with ⌘T"
        }
        return "Make \(scan.pages.count.formatted()) visited pages searchable with ⌘T"
    }

    private func sectionHeader(_ text: String, count: Int, selectAll: @escaping () -> Void, selectNone: @escaping () -> Void) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(text)
                .font(Typeface.title(17))
                .foregroundStyle(palette.ink)
            Text("\(count)")
                .font(Typeface.time(12))
                .foregroundStyle(palette.ink3)
            Spacer()
            Button("All", action: selectAll)
                .buttonStyle(.plain)
                .font(Typeface.ui(12))
                .foregroundStyle(palette.ink2)
            Button("None", action: selectNone)
                .buttonStyle(.plain)
                .font(Typeface.ui(12))
                .foregroundStyle(palette.ink2)
        }
    }

    private func sitesSection(_ sites: [ImportSiteCandidate]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionHeader(
                "Sites you watch on", count: sites.count,
                selectAll: { chosenSites = Set(sites.map(\.id)) },
                selectNone: { chosenSites = [] }
            )
            ForEach(sites) { site in
                Toggle(isOn: membership(of: site.id, in: $chosenSites)) {
                    HStack(spacing: 8) {
                        Text(site.host)
                            .font(Typeface.ui(13))
                            .foregroundStyle(palette.ink)
                        Spacer()
                        if site.filmPages > 0 {
                            Text(site.filmPages == 1 ? "1 film page" : "\(site.filmPages.formatted()) film pages")
                                .font(Typeface.ui(12))
                                .foregroundStyle(palette.ink3)
                        }
                    }
                }
                .toggleStyle(.checkbox)
            }
        }
    }

    private func titlesSection(_ titles: [ImportTitleCandidate]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionHeader(
                "Films and series", count: titles.count,
                selectAll: { chosenTitles = Set(titles.map(\.id)) },
                selectNone: { chosenTitles = [] }
            )
            LazyVStack(alignment: .leading, spacing: 2) {
                ForEach(titles) { title in
                    titleRow(title)
                }
            }
        }
    }

    private func titleRow(_ title: ImportTitleCandidate) -> some View {
        HStack(spacing: 8) {
            Toggle(isOn: membership(of: title.id, in: $chosenTitles)) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(title.name)
                        .font(Typeface.title(14))
                        .foregroundStyle(palette.ink)
                        .lineLimit(1)
                    Text(detail(title))
                        .font(Typeface.ui(11.5))
                        .foregroundStyle(palette.ink3)
                        .lineLimit(1)
                }
            }
            .toggleStyle(.checkbox)
            Spacer(minLength: 8)
            Picker("List", selection: statusBinding(title)) {
                Text("Watched").tag(TitleStatus.watched)
                Text("Watching").tag(TitleStatus.watching)
                Text("Backlog").tag(TitleStatus.backlog)
            }
            .labelsHidden()
            .controlSize(.small)
            .fixedSize()
            .disabled(!chosenTitles.contains(title.id))
        }
        .padding(.vertical, 3)
    }

    private func detail(_ title: ImportTitleCandidate) -> String {
        var parts: [String] = []
        if title.latestRef.isEpisode { parts.append(title.latestRef.shortLabel) }
        if let year = title.year { parts.append(String(year)) }
        parts.append("on \(title.host)")
        if title.lastVisit > .distantPast { parts.append(DateText.relative(title.lastVisit)) }
        return parts.joined(separator: ", ")
    }

    private func membership(of id: String, in set: Binding<Set<String>>) -> Binding<Bool> {
        Binding(
            get: { set.wrappedValue.contains(id) },
            set: { isOn in
                if isOn { set.wrappedValue.insert(id) } else { set.wrappedValue.remove(id) }
            }
        )
    }

    private func statusBinding(_ title: ImportTitleCandidate) -> Binding<TitleStatus> {
        Binding(
            get: { statuses[title.id] ?? title.suggestedStatus },
            set: { statuses[title.id] = $0 }
        )
    }

    private func doneView(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(message)
                .font(Typeface.ui(14))
                .foregroundStyle(palette.ink2)
            Text("Posters and details are filling in. Anything can be moved or removed from your library later.")
                .font(Typeface.ui(12.5))
                .foregroundStyle(palette.ink3)
            HStack {
                Spacer()
                Button("Open library") {
                    app.sheet = nil
                    app.go(.library)
                }
                .buttonStyle(SilverButtonStyle())
            }
        }
    }

    // MARK: Actions

    private func lookForBrowsers() async {
        stage = .looking
        let sources = await Task.detached(priority: .userInitiated) {
            BrowserImporter.discover(root: DebugImportRoot.url ?? BrowserImporter.applicationSupport)
        }.value
        stage = .choose(sources)
    }

    private func scan(_ source: ImportSource) async {
        stage = .scanning(source)
        let result = await Task.detached(priority: .userInitiated) { BrowserImporter.scan(source) }.value
        chosenSites = Set(result.sites.map(\.id))
        chosenTitles = Set(result.titles.map(\.id))
        statuses = [:]
        includePages = true
        stage = .review(result)
    }

    private func runImport(_ scan: ImportScan) async {
        stage = .importing
        // Lets the progress view draw before the write, which takes a moment on a large history.
        try? await Task.sleep(for: .milliseconds(30))
        let selection = ImportSelection(
            sites: scan.sites.filter { chosenSites.contains($0.id) },
            titles: scan.titles.filter { chosenTitles.contains($0.id) }.map {
                ($0, statuses[$0.id] ?? $0.suggestedStatus)
            },
            pages: includePages && app.settings.saveBrowsingHistory ? scan.pages : []
        )
        let result = app.library.applyImport(selection)
        for title in result.newTitleIDs {
            app.session.metadata.enrich(titleID: title.id, altName: title.altName, inBackground: true)
        }
        stage = .done(result.summary)
    }
}

/// Lets tests point the importer at a fake set of browsers.
nonisolated enum DebugImportRoot {
    static var url: URL? {
        ProcessInfo.processInfo.environment["CINEON_IMPORT_ROOT"].map { URL(fileURLWithPath: $0, isDirectory: true) }
    }
}
