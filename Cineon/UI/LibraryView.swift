import SwiftUI

struct LibraryView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var query = LibraryQuery()
    @State private var layout: Layout = .grid
    @AppStorage("library.sort") private var sortRaw = LibraryQuery.Sort.recent.rawValue

    enum Layout { case grid, checklist }

    private var downloaded: Set<Int64> {
        Set(app.session.downloads.items.compactMap { $0.status == .done ? $0.titleID : nil })
    }

    private var titles: [Title] {
        var current = query
        current.sort = LibraryQuery.Sort(rawValue: sortRaw) ?? .recent
        return current.apply(to: Array(app.library.titles.values.filter { $0.status != .none }), downloaded: downloaded)
    }

    private func count(_ list: LibraryQuery.List) -> Int {
        list == .all ? app.library.titles.values.filter { $0.status != .none }.count : app.library.titles.values.filter(list.matches).count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            content
        }
        .background(palette.cardFill)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            // A narrow window first shortens the buttons, then lets the lists scroll sideways.
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: 26) {
                    statusTabs
                    Spacer(minLength: 16)
                    actions(compact: false)
                }
                HStack(alignment: .firstTextBaseline, spacing: 20) {
                    statusTabs
                    Spacer(minLength: 12)
                    actions(compact: true)
                }
                HStack(alignment: .center, spacing: 12) {
                    ScrollView(.horizontal) {
                        HStack(alignment: .firstTextBaseline, spacing: 20) { statusTabs }
                    }
                    .scrollIndicators(.never)
                    actions(compact: true)
                }
            }

            // The filters and the search share a row while they fit, and take two when they don't.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 6) {
                    kindsAndFilters
                    Spacer(minLength: 8)
                    findAndSort
                }
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 6) { kindsAndFilters }
                    HStack(spacing: 6) {
                        findAndSort
                        Spacer(minLength: 0)
                    }
                }
            }
            Text(summary)
                .font(Typeface.ui(11.5))
                .foregroundStyle(palette.ink3)
        }
        .padding(.horizontal, 32)
        .padding(.top, 26)
        .padding(.bottom, 16)
    }

    @ViewBuilder private var statusTabs: some View {
        ForEach(LibraryQuery.List.allCases, id: \.self) { list in
            StatusTab(label: list.label, count: count(list), isSelected: query.list == list) {
                withAnimation(Motion.quick) {
                    query.list = list
                    layout = list == .backlog ? .checklist : .grid
                }
            }
        }
    }

    @ViewBuilder private func actions(compact: Bool) -> some View {
        Button { app.go(.rate) } label: {
            if compact {
                Image(systemName: "star.leadinghalf.filled")
            } else {
                Label("Rate films", systemImage: "star.leadinghalf.filled")
            }
        }
        .buttonStyle(OutlineButtonStyle())
        .help("Rate films")
        Button { app.sheet = .addTitle(query: nil) } label: {
            if compact {
                Image(systemName: "plus")
            } else {
                Label("Add a film", systemImage: "plus")
            }
        }
        .buttonStyle(SilverButtonStyle())
        .help("Add a film")
    }

    @ViewBuilder private var kindsAndFilters: some View {
        ForEach(LibraryQuery.Kind.allCases, id: \.self) { kind in
            Button(kind.label) { withAnimation(Motion.quick) { query.kind = kind } }
                .font(Typeface.ui(12.5, query.kind == kind ? .medium : .regular))
                .foregroundStyle(query.kind == kind ? palette.ink : palette.ink2)
                .buttonStyle(HoverButtonStyle(isSelected: query.kind == kind, padding: EdgeInsets(top: 4, leading: 10, bottom: 4, trailing: 10)))
        }
        Rectangle().fill(palette.line).frame(width: 0.5, height: 16).padding(.horizontal, 6)
        genreMenu
        FilterMenu(label: query.rating == .any ? "Rating" : query.rating.label, isActive: query.rating != .any) {
            ForEach(LibraryQuery.RatingFilter.choices, id: \.self) { choice in
                Toggle(choice.label, isOn: Binding(get: { query.rating == choice }, set: { if $0 { query.rating = choice } }))
            }
        }
        FilterMenu(label: query.decade.map { "\($0)s" } ?? "Decade", isActive: query.decade != nil) {
            Toggle("Any decade", isOn: Binding(get: { query.decade == nil }, set: { if $0 { query.decade = nil } }))
            Divider()
            ForEach(LibraryQuery.decades(in: Array(app.library.titles.values)), id: \.self) { decade in
                Toggle("\(String(decade))s", isOn: Binding(get: { query.decade == decade }, set: { query.decade = $0 ? decade : nil }))
            }
        }
        Button {
            withAnimation(Motion.quick) { query.onThisMac.toggle() }
        } label: {
            Label("On this Mac", systemImage: "arrow.down.circle")
                .lineLimit(1)
                .fixedSize()
                .font(Typeface.ui(12.5, query.onThisMac ? .medium : .regular))
                .foregroundStyle(query.onThisMac ? palette.ink : palette.ink2)
        }
        .buttonStyle(HoverButtonStyle(isSelected: query.onThisMac, padding: EdgeInsets(top: 4, leading: 9, bottom: 4, trailing: 10)))
        if query.hasFilters {
            Button("Clear") {
                withAnimation(Motion.quick) {
                    let keep = (query.list, query.kind)
                    query = LibraryQuery()
                    (query.list, query.kind) = keep
                }
            }
            .font(Typeface.ui(12))
            .foregroundStyle(palette.ink3)
            .buttonStyle(HoverButtonStyle(padding: EdgeInsets(top: 4, leading: 8, bottom: 4, trailing: 8)))
        }
    }

    @ViewBuilder private var findAndSort: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 11))
                .foregroundStyle(palette.ink3)
            TextField("Find in library", text: $query.text)
                .textFieldStyle(.plain)
                .font(Typeface.ui(12.5))
                .frame(width: 130)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(palette.raised, in: Capsule())
        FilterMenu(label: (LibraryQuery.Sort(rawValue: sortRaw) ?? .recent).label, symbol: "arrow.up.arrow.down", isActive: false) {
            ForEach(LibraryQuery.Sort.allCases, id: \.self) { sort in
                Toggle(sort.label, isOn: Binding(get: { sortRaw == sort.rawValue }, set: { if $0 { sortRaw = sort.rawValue } }))
            }
        }
        IconButton(
            symbol: layout == .grid ? "checklist" : "square.grid.2x2",
            label: layout == .grid ? "Show as checklist" : "Show as posters"
        ) {
            withAnimation(Motion.quick) { layout = layout == .grid ? .checklist : .grid }
        }
    }

    private var summary: String {
        let shown = titles
        let rated = shown.compactMap(\.rating)
        var text = "\(shown.count) \(shown.count == 1 ? "title" : "titles")"
        if !rated.isEmpty {
            text += ", \(rated.count) rated, averaging \(String(format: "%.1f", rated.reduce(0, +) / Double(rated.count)))"
        }
        return text
    }

    private var genreMenu: some View {
        let genres = LibraryQuery.genres(in: Array(app.library.titles.values.filter { $0.status != .none }))
        let label = query.genres.isEmpty ? "Genre" : (query.genres.count == 1 ? query.genres.first! : "\(query.genres.count) genres")
        return FilterMenu(label: label, isActive: !query.genres.isEmpty) {
            if !query.genres.isEmpty {
                Button("Any genre") { query.genres = [] }
                Divider()
            }
            ForEach(genres, id: \.name) { genre in
                Toggle("\(genre.name)  \(genre.count)", isOn: Binding(
                    get: { query.genres.contains(genre.name) },
                    set: { on in if on { query.genres.insert(genre.name) } else { query.genres.remove(genre.name) } }
                ))
            }
        }
    }

    @ViewBuilder private var content: some View {
        let shown = titles
        if shown.isEmpty {
            emptyState
        } else {
            ScrollView {
                if layout == .grid {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 138, maximum: 190), spacing: 18)], alignment: .leading, spacing: 24) {
                        ForEach(shown) { title in
                            AdaptivePosterCell(title: title)
                        }
                    }
                    .padding(.horizontal, 32)
                    .padding(.bottom, 40)
                } else {
                    LazyVStack(spacing: 0) {
                        ForEach(shown) { title in
                            ChecklistRow(title: title)
                        }
                    }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 40)
                }
            }
            .scrollIndicators(.never)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            LogoMark(size: 52, color: palette.ink3)
            Text(emptyText)
                .font(Typeface.ui(14))
                .foregroundStyle(palette.ink2)
                .multilineTextAlignment(.center)
            if query.hasFilters {
                Button("Clear filters") { query = LibraryQuery() }
                    .buttonStyle(OutlineButtonStyle())
                    .padding(.top, 4)
            } else if query.list == .backlog || query.list == .all {
                Button("Add a film") { app.sheet = .addTitle(query: nil) }
                    .buttonStyle(OutlineButtonStyle())
                    .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyText: String {
        if query.hasFilters { return "Nothing matches these filters." }
        return switch query.list {
        case .backlog: "Films you want to see go here. Press ⌘D on any film's page to add it."
        case .watching: "Start playing something, and it appears here on its own."
        case .watched: "Films you finish move here on their own."
        case .all: "Your library is empty. Add a film, or import your history in Settings."
        }
    }
}

/// A quiet menu button for one filter. Lit when it's narrowing the list.
struct FilterMenu<Content: View>: View {
    let label: String
    var symbol: String = "chevron.down"
    var isActive: Bool
    @ViewBuilder var content: Content
    @Environment(\.palette) private var palette

    var body: some View {
        Menu { content } label: {
            HStack(spacing: 5) {
                if symbol != "chevron.down" {
                    Image(systemName: symbol).font(.system(size: 10, weight: .medium))
                }
                Text(label).lineLimit(1)
                if symbol == "chevron.down" {
                    Image(systemName: symbol).font(.system(size: 8, weight: .semibold))
                }
            }
            .font(Typeface.ui(12.5, isActive ? .medium : .regular))
            .foregroundStyle(isActive ? palette.ink : palette.ink2)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(isActive ? palette.raised2 : .clear, in: Capsule())
            .overlay(Capsule().strokeBorder(isActive ? .clear : palette.line, lineWidth: 0.5))
            .contentShape(Capsule())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
    }
}

struct StatusTab: View {
    let label: String
    let count: Int
    let isSelected: Bool
    let action: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(label)
                    .font(Typeface.title(30))
                    .foregroundStyle(isSelected ? palette.ink : palette.ink3)
                    .lineLimit(1)
                    .fixedSize()
                Text("\(count)")
                    .font(Typeface.time(13))
                    .foregroundStyle(palette.ink3)
            }
            .fixedSize()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// A poster that fills whatever width the grid gives it.
struct AdaptivePosterCell: View {
    let title: Title
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var isHovered = false

    private var progress: WatchProgress? {
        title.status == .watching ? app.library.latestProgress(titleID: title.id) : nil
    }

    var body: some View {
        Button {
            app.detailTitleID = title.id
        } label: {
            VStack(alignment: .leading, spacing: 7) {
                PosterImage(title: title)
                    .overlay(alignment: .topLeading) {
                        if let halves = title.ratingHalves {
                            RatingBadge(halves: halves).padding(7)
                        }
                    }
                    .overlay(alignment: .bottom) {
                        if isHovered, title.status == .watched || title.status == .watching {
                            QuickRate(title: title)
                                .transition(.opacity)
                        }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .scaleEffect(isHovered ? 1.02 : 1)
                    .animation(.spring(response: 0.3, dampingFraction: 0.75), value: isHovered)
                if let progress, !progress.isVisitOnly {
                    ProgressLine(fraction: progress.fraction, height: 2)
                }
                Text(title.name)
                    .font(Typeface.ui(12.5, .medium))
                    .foregroundStyle(palette.ink)
                    .lineLimit(1)
                Text(title.year.map(String.init) ?? title.kind.label)
                    .font(Typeface.ui(11.5))
                    .foregroundStyle(palette.ink3)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .contextMenu { TitleMenu(title: title) }
        .accessibilityLabel(title.name)
    }
}

/// Backlog as a real checklist. Ticking a film marks it watched, and it moves across.
struct ChecklistRow: View {
    let title: Title
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var isHovered = false

    private var isDone: Bool { title.status == .watched }

    private var detail: String {
        var parts = [title.kind.label]
        if let year = title.year { parts.insert(String(year), at: 0) }
        if let runtime = title.runtimeMinutes { parts.append(Timecode.spoken(Double(runtime) * 60)) }
        return parts.joined(separator: ", ")
    }

    var body: some View {
        HStack(spacing: 14) {
            Button {
                withAnimation(Motion.layout) {
                    app.library.setStatus(title.id, isDone ? .backlog : .watched)
                }
                if !isDone { app.toasts.show("Marked \(title.name) as watched") }
            } label: {
                Image(systemName: isDone ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 19, weight: .light))
                    .foregroundStyle(isDone ? palette.ink : palette.ink3)
                    .contentTransition(.symbolEffect(.replace))
                    .frame(width: 26, height: 26)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isDone ? "Mark \(title.name) as not watched" : "Mark \(title.name) as watched")

            Button {
                app.detailTitleID = title.id
            } label: {
                HStack(spacing: 14) {
                    PosterImage(title: title, width: 34, cornerRadius: 3)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title.name)
                            .font(Typeface.title(16))
                            .foregroundStyle(palette.ink)
                            .lineLimit(1)
                        Text(detail)
                            .font(Typeface.ui(12))
                            .foregroundStyle(palette.ink3)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    if let halves = title.ratingHalves { RatingBadge(halves: halves) }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isHovered {
                Button("Find on my sites") {
                    app.browser.searchEverywhere(title.name, titleID: title.id)
                }
                .buttonStyle(OutlineButtonStyle())
                .transition(.opacity)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
        .background(isHovered ? palette.raised : .clear, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .onHover { hovering in
            withAnimation(.easeOut(duration: 0.12)) { isHovered = hovering }
        }
        .contextMenu { TitleMenu(title: title) }
    }
}

/// Stars across the bottom of a poster, to rate it without opening it.
struct QuickRate: View {
    let title: Title
    @Environment(AppModel.self) private var app

    var body: some View {
        StarRatingControl(halves: title.ratingHalves, size: 9.5, spacing: 1.5, showsValue: false) { value in
            app.library.setRating(title.id, halves: value)
        }
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity)
        .background(LinearGradient(colors: [.clear, .black.opacity(0.85)], startPoint: .top, endPoint: .bottom))
        .environment(\.palette, .dark)
    }
}
