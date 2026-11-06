import SwiftUI

struct HomeView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        let library = app.library
        let resuming = library.continueWatching
        ScrollView {
            VStack(alignment: .leading, spacing: 34) {
                if let first = resuming.first {
                    HomeHero(title: first.title, progress: first.progress)
                } else {
                    WelcomeHero()
                }
                VStack(alignment: .leading, spacing: 34) {
                    let fresh = app.session.alerts.fresh
                    if !fresh.isEmpty {
                        PosterShelf(name: "New episodes", titles: fresh.map(\.title), badges: Dictionary(uniqueKeysWithValues: fresh.map {
                            ($0.title.id, $0.alert.newCount == 1 ? ($0.alert.newest?.shortLabel ?? "New") : "\($0.alert.newCount) new")
                        }))
                    }
                    if resuming.count > 1 {
                        PosterShelf(name: "Continue watching", titles: resuming.dropFirst().map(\.title), showProgress: true)
                    }
                    if !library.backlog.isEmpty {
                        PosterShelf(name: "Backlog", titles: Array(library.backlog.prefix(14)), destination: .library)
                    }
                    if !library.watched.isEmpty {
                        PosterShelf(name: "Watched", titles: Array(library.watched.prefix(14)), destination: .library)
                    }
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 40)
            }
        }
        .scrollIndicators(.never)
        .background(palette.cardFill)
    }
}

/// The film you were in the middle of, set like an opening title.
struct HomeHero: View {
    let title: Title
    let progress: WatchProgress
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    private var detailLine: String {
        var parts: [String] = []
        if progress.ref.isEpisode { parts.append(progress.ref.longLabel) }
        if progress.isVisitOnly {
            parts.append("Last opened on \(DomainName.registrable(progress.host)) \(DateText.relative(progress.updatedAt))")
        } else {
            parts.append("\(Timecode.spoken(progress.remaining)) left on \(DomainName.registrable(progress.host))")
        }
        return parts.joined(separator: ". ")
    }

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            RemoteImage(url: title.backdropURL ?? app.library.bestFrameURL(titleID: title.id) ?? title.posterURL, maxPixel: 1800) {
                palette.raised
            }
            .frame(height: 440)
            .frame(maxWidth: .infinity)
            .clipped()
            .overlay {
                LinearGradient(
                    stops: [
                        .init(color: palette.cardFill.opacity(0), location: 0.3),
                        .init(color: palette.cardFill.opacity(0.75), location: 0.72),
                        .init(color: palette.cardFill, location: 1),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            }

            VStack(alignment: .leading, spacing: 10) {
                Text(title.name)
                    .font(Typeface.title(52))
                    .foregroundStyle(palette.ink)
                    .lineLimit(2)
                    .minimumScaleFactor(0.6)
                Text(detailLine)
                    .font(Typeface.ui(14))
                    .foregroundStyle(palette.ink2)
                if !progress.isVisitOnly {
                    ProgressLine(fraction: progress.fraction, height: 3)
                        .frame(width: 280)
                        .padding(.vertical, 4)
                }
                HStack(spacing: 10) {
                    Button {
                        app.resume(title)
                    } label: {
                        Label(
                            progress.isVisitOnly ? "Open on \(DomainName.registrable(progress.host))" : "Resume at \(Timecode.string(progress.position))",
                            systemImage: "play.fill"
                        )
                    }
                    .buttonStyle(SilverButtonStyle(large: true))
                    Button("Details") { app.detailTitleID = title.id }
                        .buttonStyle(OutlineButtonStyle(large: true))
                }
                .padding(.top, 4)
            }
            .padding(.horizontal, 32)
            .padding(.bottom, 8)
        }
    }
}

/// First run, or nothing in progress: go straight to choosing something.
struct WelcomeHero: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 22) {
            LogoMark(size: 96)
            Text("What are we watching?")
                .font(Typeface.title(38))
                .foregroundStyle(palette.ink)
            Button {
                app.openCommandBar()
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 14))
                    Text("Search your sites, or add a film to the backlog")
                        .font(Typeface.ui(14))
                    Spacer()
                    Text("⌘T")
                        .font(Typeface.ui(12))
                        .foregroundStyle(palette.ink3)
                }
                .foregroundStyle(palette.ink2)
                .padding(.horizontal, 16)
                .frame(width: 460, height: 44)
                .background(palette.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            SitesRow()
                .padding(.top, 10)

            if app.library.titles.isEmpty {
                Button("Import from Arc, Chrome or another browser") { app.sheet = .importBrowser }
                    .buttonStyle(OutlineButtonStyle())
                    .padding(.top, 6)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 90)
        .padding(.bottom, 10)
    }
}

struct SitesRow: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 14) {
            ForEach(app.library.sites.prefix(6)) { site in
                Button {
                    app.openSite(site)
                } label: {
                    VStack(spacing: 7) {
                        SiteIcon(name: site.name, url: site.iconURL, size: 28)
                            .frame(width: 54, height: 54)
                            .background(palette.raised, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                        Text(site.name)
                            .font(Typeface.ui(11.5))
                            .foregroundStyle(palette.ink2)
                            .lineLimit(1)
                    }
                    .frame(width: 78)
                }
                .buttonStyle(HoverButtonStyle(cornerRadius: 12, padding: EdgeInsets(top: 8, leading: 4, bottom: 6, trailing: 4)))
            }
            Button {
                app.sheet = .addSite(prefill: nil)
            } label: {
                VStack(spacing: 7) {
                    Image(systemName: "plus")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(palette.ink2)
                        .frame(width: 54, height: 54)
                        .overlay(
                            RoundedRectangle(cornerRadius: 13, style: .continuous)
                                .strokeBorder(palette.line, lineWidth: 1)
                        )
                    Text("Add site")
                        .font(Typeface.ui(11.5))
                        .foregroundStyle(palette.ink2)
                }
                .frame(width: 78)
            }
            .buttonStyle(HoverButtonStyle(cornerRadius: 12, padding: EdgeInsets(top: 8, leading: 4, bottom: 6, trailing: 4)))
        }
    }
}

struct PosterShelf: View {
    let name: String
    let titles: [Title]
    var showProgress = false
    var destination: Route?
    /// A note on a poster, such as which new episode is out.
    var badges: [Int64: String] = [:]
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text(name)
                    .font(Typeface.title(21))
                    .foregroundStyle(palette.ink)
                Spacer()
                if let destination {
                    Button("Show all") { app.go(destination) }
                        .buttonStyle(.plain)
                        .font(Typeface.ui(12.5))
                        .foregroundStyle(palette.ink2)
                }
            }
            ScrollView(.horizontal) {
                LazyHStack(alignment: .top, spacing: 14) {
                    ForEach(titles) { title in
                        PosterCell(title: title, width: 138, showProgress: showProgress, badge: badges[title.id])
                    }
                }
            }
            .scrollClipDisabled()
        }
    }
}

struct PosterCell: View {
    let title: Title
    var width: CGFloat = 150
    var showProgress = false
    var badge: String?
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var isHovered = false

    private var progress: WatchProgress? {
        showProgress || title.status == .watching ? app.library.latestProgress(titleID: title.id) : nil
    }

    var body: some View {
        Button {
            app.detailTitleID = title.id
        } label: {
            VStack(alignment: .leading, spacing: 7) {
                PosterImage(title: title, width: width, keepsColour: badge != nil)
                    .overlay(alignment: .topLeading) {
                        if let halves = title.ratingHalves { RatingBadge(halves: halves).padding(7) }
                    }
                    .overlay(alignment: .bottomLeading) {
                        if let badge {
                            Text(badge)
                                .font(Typeface.ui(11, .semibold))
                                .foregroundStyle(palette.onSilver)
                                .padding(.horizontal, 7)
                                .padding(.vertical, 3)
                                .background(Capsule().fill(palette.silver))
                                .padding(7)
                        }
                    }
                    .scaleEffect(isHovered ? 1.025 : 1)
                    .animation(.spring(response: 0.3, dampingFraction: 0.75), value: isHovered)
                if let progress, !progress.isVisitOnly {
                    ProgressLine(fraction: progress.fraction, height: 2)
                        .frame(width: width)
                }
                Text(title.name)
                    .font(Typeface.ui(12.5, .medium))
                    .foregroundStyle(palette.ink)
                    .lineLimit(1)
                    .frame(width: width, alignment: .leading)
                Text(subtitle)
                    .font(Typeface.ui(11.5))
                    .foregroundStyle(palette.ink3)
                    .lineLimit(1)
                    .frame(width: width, alignment: .leading)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .contextMenu { TitleMenu(title: title) }
        .accessibilityLabel(title.name)
    }

    private var subtitle: String {
        if let progress, progress.ref.isEpisode { return progress.ref.shortLabel }
        if let year = title.year { return String(year) }
        return title.kind.label
    }
}

/// The same set of actions wherever a title appears.
struct TitleMenu: View {
    let title: Title
    @Environment(AppModel.self) private var app

    var body: some View {
        if app.library.latestProgress(titleID: title.id)?.url != nil {
            Button("Resume") { app.resume(title) }
        }
        Button("Find on my sites") { app.browser.searchEverywhere(title.name, titleID: title.id) }
        Divider()
        Button("Move to backlog") { app.library.setStatus(title.id, .backlog) }
            .disabled(title.status == .backlog)
        Button("Move to watching") { app.library.setStatus(title.id, .watching) }
            .disabled(title.status == .watching)
        Button("Mark as watched") { app.library.setStatus(title.id, .watched) }
            .disabled(title.status == .watched)
        Divider()
        Button("Remove from library") { app.library.delete(title.id) }
    }
}
