import SwiftUI

struct SheetHost: View {
    let sheet: AppSheet
    @Environment(AppModel.self) private var app

    var body: some View {
        Group {
            switch sheet {
            case .addSite(let prefill): AddSiteSheet(prefill: prefill)
            case .editSite(let id):
                if let site = app.library.sites.first(where: { $0.id == id }) {
                    EditSiteSheet(site: site)
                }
            case .addTitle(let query): AddTitleSheet(initial: query)
            case .relink: RelinkSheet()
            case .importBrowser: ImportSheet()
            case .newChallenge: NewChallengeSheet()
            }
        }
        .onKeyDown { event in
            guard event.keyCode == KeyCode.escape else { return false }
            app.sheet = nil
            return true
        }
    }
}

private struct SheetFrame<Content: View>: View {
    let heading: String
    var width: CGFloat = 480
    @ViewBuilder let content: () -> Content
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(heading)
                    .font(Typeface.title(24))
                    .foregroundStyle(palette.ink)
                Spacer()
                IconButton(symbol: "xmark", label: "Close") { app.sheet = nil }
            }
            content()
        }
        .padding(24)
        .frame(width: width)
        .glassPanel(cornerRadius: 18)
    }
}

private struct FieldLabel: View {
    let text: String
    @Environment(\.palette) private var palette

    var body: some View {
        Text(text)
            .font(Typeface.ui(12, .medium))
            .foregroundStyle(palette.ink2)
    }
}

private struct InputField: View {
    let placeholder: String
    @Binding var text: String
    var onSubmit: () -> Void = {}
    @Environment(\.palette) private var palette

    var body: some View {
        TextField(placeholder, text: $text)
            .textFieldStyle(.plain)
            .font(Typeface.ui(14))
            .foregroundStyle(palette.ink)
            .padding(.horizontal, 12)
            .frame(height: 38)
            .background(palette.raised, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            .onSubmit(onSubmit)
    }
}

// MARK: Challenges

/// Picks the film or series to race friends through.
struct NewChallengeSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var query = ""
    @FocusState private var focused: Bool

    private var candidates: [Title] {
        let library = app.library
        let pool = library.watching + library.backlog
        let needle = TitleParser.normalize(query)
        return pool.filter { needle.isEmpty || $0.normName.contains(needle) }.prefix(40).map { $0 }
    }

    var body: some View {
        SheetFrame(heading: "Who finishes first?", width: 560) {
            Text("Choose something from Watching or your backlog. Everyone who joins races from where they are now.")
                .font(Typeface.ui(13))
                .foregroundStyle(palette.ink2)
            InputField(placeholder: "Filter", text: $query) {
                if let first = candidates.first { start(first) }
            }
            .focused($focused)
            ScrollView {
                LazyVStack(spacing: 2) {
                    ForEach(candidates) { title in
                        Button {
                            start(title)
                        } label: {
                            HStack(spacing: 12) {
                                PosterImage(title: title, width: 30, cornerRadius: 3)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(title.name)
                                        .font(Typeface.ui(13.5, .medium))
                                        .foregroundStyle(palette.ink)
                                    Text([title.kind.label, title.year.map(String.init)].compactMap { $0 }.joined(separator: ", "))
                                        .font(Typeface.ui(11.5))
                                        .foregroundStyle(palette.ink3)
                                }
                                Spacer()
                                Text(title.status.label)
                                    .font(Typeface.ui(11.5))
                                    .foregroundStyle(palette.ink3)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(HoverButtonStyle())
                    }
                    if candidates.isEmpty {
                        Text("Nothing here yet. Add something to your backlog first.")
                            .font(Typeface.ui(12.5))
                            .foregroundStyle(palette.ink3)
                            .padding(.vertical, 20)
                    }
                }
            }
            .frame(height: 320)
            .scrollIndicators(.never)
        }
        .onAppear { focused = true }
    }

    private func start(_ title: Title) {
        app.sheet = nil
        app.session.together.createChallenge(for: title)
    }
}

// MARK: Sites

struct AddSiteSheet: View {
    let prefill: String?
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var address = ""
    @State private var problem: String?
    @FocusState private var focused: Bool

    var body: some View {
        SheetFrame(heading: "Add a site") {
            VStack(alignment: .leading, spacing: 6) {
                FieldLabel(text: "Address")
                InputField(placeholder: "example.com", text: $address, onSubmit: add)
                    .focused($focused)
                if let problem {
                    Text(problem)
                        .font(Typeface.ui(12))
                        .foregroundStyle(palette.ink2)
                }
                Text("Cineon learns how the site searches the first time you open it.")
                    .font(Typeface.ui(12))
                    .foregroundStyle(palette.ink3)
                    .padding(.top, 2)
            }
            HStack {
                Spacer()
                Button("Add site", action: add)
                    .buttonStyle(SilverButtonStyle())
            }
        }
        .onAppear {
            address = prefill ?? ""
            focused = true
        }
    }

    private func add() {
        let text = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = CommandBar.directURL(from: text) else {
            problem = "That doesn't look like a web address. Try something like example.com."
            return
        }
        guard let site = app.library.addSite(url: url) else {
            problem = "Couldn't add that site."
            return
        }
        app.sheet = nil
        app.openSite(site)
    }
}

struct EditSiteSheet: View {
    let site: Site
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var name = ""
    @State private var address = ""
    @State private var searchTemplate = ""

    var body: some View {
        SheetFrame(heading: "Edit site") {
            VStack(alignment: .leading, spacing: 6) {
                FieldLabel(text: "Name")
                InputField(placeholder: "Name", text: $name, onSubmit: save)
            }
            VStack(alignment: .leading, spacing: 6) {
                FieldLabel(text: "Address")
                InputField(placeholder: "https://example.com", text: $address, onSubmit: save)
            }
            VStack(alignment: .leading, spacing: 6) {
                FieldLabel(text: "Search address")
                InputField(placeholder: "https://example.com/search?q=%s", text: $searchTemplate, onSubmit: save)
                Text("Use %s where the search words go. Leave it empty, and Cineon learns it from the site.")
                    .font(Typeface.ui(12))
                    .foregroundStyle(palette.ink3)
            }
            HStack {
                Button("Remove site") {
                    app.library.removeSite(site.id)
                    app.sheet = nil
                }
                .buttonStyle(OutlineButtonStyle())
                Spacer()
                Button("Save", action: save)
                    .buttonStyle(SilverButtonStyle())
            }
        }
        .onAppear {
            name = site.name
            address = site.homeURL.absoluteString
            searchTemplate = site.searchTemplate ?? ""
        }
    }

    private func save() {
        var updated = site
        updated.name = name.isEmpty ? site.name : name
        if let url = CommandBar.directURL(from: address.trimmingCharacters(in: .whitespaces)), let host = url.host {
            updated.homeURL = url
            updated.host = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
        }
        let template = searchTemplate.trimmingCharacters(in: .whitespacesAndNewlines)
        updated.searchTemplate = template.isEmpty ? nil : template
        app.library.updateSite(updated)
        app.sheet = nil
    }
}

// MARK: Titles

/// Search IMDb's catalogue and add, or just type a name and add it by hand.
struct AddTitleSheet: View {
    let initial: String?
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var query = ""
    @State private var hits: [MetadataHit] = []
    @State private var isSearching = false
    @FocusState private var focused: Bool

    private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        SheetFrame(heading: "Add to backlog", width: 620) {
            InputField(placeholder: "Film or series name", text: $query, onSubmit: addFirst)
                .focused($focused)

            MetadataResults(hits: hits, isSearching: isSearching, query: trimmed) { hit in
                app.addToBacklog(hit: hit)
                app.sheet = nil
            }

            HStack {
                Spacer()
                if !trimmed.isEmpty {
                    Button("Add “\(trimmed)” by name") { addManually() }
                        .buttonStyle(OutlineButtonStyle())
                }
            }
        }
        .onAppear {
            query = initial ?? ""
            focused = true
        }
        .task(id: trimmed) {
            hits = await debouncedSearch(trimmed, isSearching: { isSearching = $0 })
        }
    }

    private func addFirst() {
        if let hit = hits.first {
            app.addToBacklog(hit: hit)
            app.sheet = nil
        } else if !trimmed.isEmpty {
            addManually()
        }
    }

    private func addManually() {
        guard let title = app.library.addTitle(name: trimmed, status: .backlog) else { return }
        app.session.metadata.enrich(titleID: title.id)
        app.toasts.show("Added \(title.name) to backlog")
        app.sheet = nil
    }
}

/// "That's not what this page is showing." Corrects the recognised title.
struct RelinkSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var query = ""
    @State private var hits: [MetadataHit] = []
    @State private var isSearching = false
    @State private var season = ""
    @State private var episode = ""
    @FocusState private var focused: Bool

    private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var tab: BrowserTab? { app.browser.selected }

    private var ref: EpisodeRef {
        EpisodeRef(season: Int(season) ?? 0, episode: Int(episode) ?? 0)
    }

    private var libraryMatches: [Title] { app.library.search(trimmed, limit: 4) }

    var body: some View {
        SheetFrame(heading: "What's playing here?", width: 620) {
            InputField(placeholder: "Film or series name", text: $query)
                .focused($focused)

            HStack(spacing: 10) {
                FieldLabel(text: "For a series")
                InputField(placeholder: "Season", text: $season).frame(width: 84)
                InputField(placeholder: "Episode", text: $episode).frame(width: 84)
                Spacer()
            }

            if !libraryMatches.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    FieldLabel(text: "In your library")
                    ForEach(libraryMatches) { title in
                        Button {
                            link(to: title.id)
                        } label: {
                            HStack(spacing: 10) {
                                PosterImage(title: title, width: 22, cornerRadius: 2)
                                Text(title.name)
                                    .font(Typeface.ui(13))
                                    .foregroundStyle(palette.ink)
                                Spacer()
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(HoverButtonStyle())
                    }
                }
            }

            MetadataResults(hits: hits, isSearching: isSearching, query: trimmed) { hit in
                guard let title = app.library.addTitle(
                    name: hit.name, year: hit.year, kind: hit.kind, status: .watching, imdbID: hit.id, posterURL: hit.posterURL
                ) else { return }
                app.session.metadata.apply(hit: hit, to: title.id)
                link(to: title.id)
            }

            HStack {
                if let tab {
                    Button("This isn't a film") {
                        app.session.tracker.ignore(tab: tab)
                        app.sheet = nil
                    }
                    .buttonStyle(OutlineButtonStyle())
                }
                Spacer()
                if !trimmed.isEmpty {
                    Button("Use “\(trimmed)”") {
                        guard let title = app.library.addTitle(name: trimmed, status: .watching) else { return }
                        link(to: title.id)
                    }
                    .buttonStyle(OutlineButtonStyle())
                }
            }
        }
        .onAppear {
            query = tab?.parsed?.name ?? ""
            if let parsed = tab?.parsed, parsed.ref.isEpisode {
                season = String(parsed.ref.season)
                episode = String(parsed.ref.episode)
            }
            focused = true
        }
        .task(id: trimmed) {
            hits = await debouncedSearch(trimmed, isSearching: { isSearching = $0 })
        }
    }

    private func link(to id: Int64) {
        guard let tab else { return }
        app.session.tracker.relink(tab: tab, to: id, ref: ref)
        app.toasts.show("Now tracking \(app.library.titles[id]?.name ?? "this title")")
        app.sheet = nil
    }
}

@MainActor
private func debouncedSearch(_ text: String, isSearching: (Bool) -> Void) async -> [MetadataHit] {
    guard text.count >= 2 else { return [] }
    try? await Task.sleep(for: .milliseconds(220))
    guard !Task.isCancelled else { return [] }
    isSearching(true)
    let found = await MetadataClient.search(text)
    isSearching(false)
    return Task.isCancelled ? [] : found
}

private struct MetadataResults: View {
    let hits: [MetadataHit]
    let isSearching: Bool
    let query: String
    let pick: (MetadataHit) -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        if hits.isEmpty {
            if query.count >= 2, !isSearching {
                Text("No matches yet. You can still add it by name.")
                    .font(Typeface.ui(12.5))
                    .foregroundStyle(palette.ink3)
                    .frame(maxWidth: .infinity, minHeight: 60)
            }
        } else {
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 12) {
                    ForEach(hits) { hit in
                        Button { pick(hit) } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                RemoteImage(url: hit.posterURL, maxPixel: 300) {
                                    PosterPlaceholder(name: hit.name)
                                }
                                .frame(width: 94, height: 141)
                                .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
                                Text(hit.name)
                                    .font(Typeface.ui(11.5, .medium))
                                    .foregroundStyle(palette.ink)
                                    .lineLimit(2)
                                    .frame(width: 94, alignment: .leading)
                                Text(subtitle(hit))
                                    .font(Typeface.ui(11))
                                    .foregroundStyle(palette.ink3)
                                    .lineLimit(1)
                                    .frame(width: 94, alignment: .leading)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func subtitle(_ hit: MetadataHit) -> String {
        let year = hit.year.map(String.init) ?? ""
        return hit.kind == .series ? (year.isEmpty ? "Series" : "\(year), series") : year
    }
}

/// Asks before getting a whole series, which can run to tens of gigabytes: how many seasons and
/// episodes, about how big, and how much room there is.
struct SeriesDownloadSheet: View {
    let proposal: SeasonGrabber.Proposal
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    private var episodes: Int { proposal.job.episodes.count }

    private func size(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    private var countLine: String {
        let seasons = proposal.seasonCounts.count
        return "\(seasons) season\(seasons == 1 ? "" : "s"), \(episodes) episode\(episodes == 1 ? "" : "s") not on this Mac yet"
    }

    private var sizeLine: String {
        var text = "About \(size(proposal.totalBytes))"
        if !proposal.isMeasured { text += ", guessing a gigabyte an episode" }
        if let free = proposal.freeBytes { text += ". \(size(free)) free on this Mac" }
        return text
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top, spacing: 16) {
                RemoteImage(url: proposal.job.posterURL, maxPixel: 240) {
                    ZStack {
                        palette.raised2
                        Image(systemName: "film.stack").foregroundStyle(palette.ink3)
                    }
                }
                .frame(width: 64, height: 96)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                VStack(alignment: .leading, spacing: 6) {
                    Text("Download all of \(proposal.job.name)?")
                        .font(Typeface.title(22))
                        .foregroundStyle(palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(countLine)
                        .font(Typeface.ui(13))
                        .foregroundStyle(palette.ink2)
                    Text(sizeLine)
                        .font(Typeface.ui(13))
                        .foregroundStyle(palette.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                IconButton(symbol: "xmark", label: "Close") { app.session.seasons.decline() }
            }

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 92), spacing: 6)], alignment: .leading, spacing: 6) {
                ForEach(proposal.seasonCounts, id: \.season) { entry in
                    HStack(spacing: 6) {
                        Text("Season \(entry.season)")
                            .font(Typeface.ui(12, .medium))
                            .foregroundStyle(palette.ink)
                        Text("\(entry.count)")
                            .font(Typeface.time(11))
                            .foregroundStyle(palette.ink3)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(palette.raised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
            }

            if !proposal.fits {
                Label("That's more than the free space on this Mac. Downloads that don't fit will stop with an error.", systemImage: "exclamationmark.triangle")
                    .font(Typeface.ui(12.5, .medium))
                    .foregroundStyle(palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Text("Season by season, two at a time. Stop whenever you like in Downloads. If Cineon closes, it carries on from there next time.")
                .font(Typeface.ui(12))
                .foregroundStyle(palette.ink3)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 10) {
                Spacer()
                Button("Not now") { app.session.seasons.decline() }
                    .buttonStyle(OutlineButtonStyle())
                Button("Download \(episodes) episode\(episodes == 1 ? "" : "s")") { app.session.seasons.confirm() }
                    .buttonStyle(SilverButtonStyle())
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 500)
        .glassPanel(cornerRadius: 18)
        .onKeyDown { event in
            guard event.keyCode == KeyCode.escape else { return false }
            app.session.seasons.decline()
            return true
        }
    }
}
