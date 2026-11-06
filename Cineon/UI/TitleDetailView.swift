import AppKit
import SwiftUI

struct TitleDetailView: View {
    let title: Title
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var episodes: [EpisodeInfo] = []
    @State private var selectedSeason = 1
    @State private var skipRules: [SkipRule] = []

    private var sessions: [WatchSession] { app.library.sessions(titleID: title.id) }
    private var progressList: [WatchProgress] { app.library.progressList(titleID: title.id) }
    private var latest: WatchProgress? { progressList.first }

    /// Each site you've watched this on, latest first.
    private var places: [WatchProgress] {
        var seen = Set<String>()
        return progressList.filter { seen.insert($0.host).inserted && $0.url != nil }
    }

    private var seasons: [Int] { Array(Set(episodes.map(\.season))).sorted() }
    private var moments: [FilmFrame] { app.library.moments(titleID: title.id) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                hero
                VStack(alignment: .leading, spacing: 26) {
                    if let overview = title.overview, !overview.isEmpty {
                        Text(overview)
                            .font(Typeface.ui(14))
                            .lineSpacing(3)
                            .foregroundStyle(palette.ink2)
                            .frame(maxWidth: 620, alignment: .leading)
                    }
                    if !moments.isEmpty { momentsSection }
                    if !places.isEmpty { whereSection }
                    if !episodes.isEmpty { episodesSection }
                    if !sessions.isEmpty { historySection }
                    if !skipRules.isEmpty { skipsSection }
                    footer
                }
                .padding(.horizontal, 30)
                .padding(.top, 18)
                .padding(.bottom, 26)
            }
        }
        .scrollIndicators(.never)
        .frame(maxWidth: 840, maxHeight: 700)
        .background(palette.cardFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(alignment: .topTrailing) {
            IconButton(symbol: "xmark", label: "Close") { app.detailTitleID = nil }
                .background(.ultraThinMaterial, in: Circle())
                .padding(14)
        }
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(palette.line, lineWidth: 1)
                .allowsHitTesting(false)
        )
        .shadow(color: .black.opacity(0.5), radius: 50, y: 20)
        .padding(30)
        .onKeyDown { event in
            guard event.keyCode == KeyCode.escape else { return false }
            app.detailTitleID = nil
            return true
        }
        .task(id: title.id) {
            skipRules = (try? app.session.db.skipRules(titleID: title.id)) ?? []
        }
        .task(id: title.imdbID) {
            let found = await app.session.metadata.episodes(for: title)
            episodes = found
            if let latestSeason = latest?.ref.season, latestSeason > 0 {
                selectedSeason = latestSeason
            } else if let first = seasons.first {
                selectedSeason = first
            }
        }
    }

    private var hero: some View {
        ZStack(alignment: .bottomLeading) {
            RemoteImage(url: title.backdropURL ?? app.library.bestFrameURL(titleID: title.id), maxPixel: 1400) {
                palette.raised
            }
            .frame(height: 280)
            .frame(maxWidth: .infinity)
            .clipped()
            .saturation(title.status == .watched ? 0 : 1)
            .overlay {
                LinearGradient(
                    stops: [
                        .init(color: palette.cardFill.opacity(0), location: 0.25),
                        .init(color: palette.cardFill, location: 1),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            }

            HStack(alignment: .bottom, spacing: 20) {
                PosterImage(title: title, width: 118)
                VStack(alignment: .leading, spacing: 8) {
                    Text(title.name)
                        .font(Typeface.title(34))
                        .foregroundStyle(palette.ink)
                        .lineLimit(2)
                        .minimumScaleFactor(0.7)
                    Text(factsLine)
                        .font(Typeface.ui(12.5))
                        .foregroundStyle(palette.ink2)
                        .lineLimit(1)
                    actionRow
                }
            }
            .padding(.horizontal, 30)
        }
    }

    private var factsLine: String {
        var parts: [String] = []
        if let year = title.year { parts.append(String(year)) }
        parts.append(title.kind.label)
        if let runtime = title.runtimeMinutes { parts.append(Timecode.spoken(Double(runtime) * 60)) }
        parts.append(contentsOf: title.genres.prefix(3))
        return parts.joined(separator: ", ")
    }

    private var actionRow: some View {
        HStack(spacing: 8) {
            if let latest, latest.url != nil, !latest.finished {
                Button {
                    app.resume(title)
                } label: {
                    Label(
                        latest.isVisitOnly ? "Open on \(DomainName.registrable(latest.host))" : "Resume at \(Timecode.string(latest.position))",
                        systemImage: "play.fill"
                    )
                }
                .buttonStyle(SilverButtonStyle())
            } else {
                Button {
                    app.detailTitleID = nil
                    app.browser.searchEverywhere(title.name, titleID: title.id)
                } label: {
                    Label("Find on my sites", systemImage: "magnifyingglass")
                }
                .buttonStyle(SilverButtonStyle())
            }
            if let copy = app.session.downloads.items.first(where: { $0.titleID == title.id && $0.status == .done }) {
                Button {
                    app.playDownload(copy)
                } label: {
                    Label(copy.episodeBadge.map { "Play \($0) on this Mac" } ?? "Play the copy on this Mac", systemImage: "arrow.down.circle")
                }
                .buttonStyle(OutlineButtonStyle())
            }
            StatusPicker(title: title)
            if app.session.together.isAvailable {
                Menu {
                    Button("Challenge friends to finish it") {
                        app.detailTitleID = nil
                        app.session.together.createChallenge(for: title)
                    }
                    Button("Share it as a code") { app.session.together.share(title: title) }
                } label: {
                    Image(systemName: "person.2")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(palette.ink2)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .menuStyle(.button)
                .buttonStyle(.plain)
                .menuIndicator(.hidden)
                .fixedSize()
                .help("Together")
            }
        }
        .padding(.top, 4)
    }

    private var momentsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Moments")
                .font(Typeface.title(17))
                .foregroundStyle(palette.ink)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 172), spacing: 8)], spacing: 8) {
                ForEach(moments) { moment in
                    MomentCell(moment: moment)
                }
            }
        }
    }

    private var skipsSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("What Cineon skips")
                .font(Typeface.title(17))
                .foregroundStyle(palette.ink)
            ForEach(skipRules) { rule in
                HStack(spacing: 10) {
                    Text(rule.kind == .intro
                         ? "Intro, \(Timecode.string(rule.start)) to \(Timecode.string(rule.end))"
                         : "Credits, last \(Timecode.spoken(rule.start))")
                        .foregroundStyle(palette.ink2)
                    Text(rule.site)
                        .foregroundStyle(palette.ink3)
                    Spacer()
                    Button("Forget") {
                        try? app.session.db.deleteSkipRule(rule.id)
                        skipRules.removeAll { $0.id == rule.id }
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(palette.ink2)
                }
                .font(Typeface.ui(12.5))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
            }
        }
    }

    private var whereSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Where you watched it")
                .font(Typeface.title(17))
                .foregroundStyle(palette.ink)
            ForEach(places, id: \.host) { place in
                Button {
                    if let url = place.url { app.resume(url: url, at: place.position) }
                } label: {
                    HStack(spacing: 10) {
                        SiteIcon(name: place.host, url: app.library.site(forHost: place.host)?.iconURL, size: 18)
                        Text(DomainName.registrable(place.host))
                            .font(Typeface.ui(13, .medium))
                            .foregroundStyle(palette.ink)
                        if place.ref.isEpisode {
                            Text(place.ref.shortLabel)
                                .font(Typeface.ui(12))
                                .foregroundStyle(palette.ink2)
                        }
                        Spacer()
                        Text(place.isVisitOnly ? "Opened" : (place.finished ? "Finished" : "Stopped at \(Timecode.string(place.position))"))
                            .font(Typeface.time(12))
                            .foregroundStyle(palette.ink2)
                        Text(DateText.relative(place.updatedAt))
                            .font(Typeface.ui(12))
                            .foregroundStyle(palette.ink3)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(HoverButtonStyle())
            }
        }
    }

    private var episodesSection: some View {
        let inSeason = episodes.filter { $0.season == selectedSeason }
        let doneSet = Dictionary(
            progressList.map { ($0.ref, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 14) {
                Text("Episodes")
                    .font(Typeface.title(17))
                    .foregroundStyle(palette.ink)
                ScrollView(.horizontal) {
                    HStack(spacing: 2) {
                        ForEach(seasons, id: \.self) { season in
                            Button("Season \(season)") { selectedSeason = season }
                                .font(Typeface.ui(12, selectedSeason == season ? .medium : .regular))
                                .foregroundStyle(selectedSeason == season ? palette.ink : palette.ink2)
                                .buttonStyle(HoverButtonStyle(isSelected: selectedSeason == season, padding: EdgeInsets(top: 3, leading: 8, bottom: 3, trailing: 8)))
                        }
                    }
                }
            }
            LazyVStack(spacing: 1) {
                ForEach(inSeason) { episode in
                    EpisodeRow(
                        episode: episode,
                        progress: doneSet[EpisodeRef(season: episode.season, episode: episode.episode)],
                        title: title
                    )
                }
            }
        }
    }

    private var historySection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("History")
                .font(Typeface.title(17))
                .foregroundStyle(palette.ink)
            ForEach(sessions.prefix(12)) { session in
                HStack(spacing: 10) {
                    Text(DateText.day(session.startedAt))
                        .foregroundStyle(palette.ink2)
                    if session.ref.isEpisode {
                        Text(session.ref.shortLabel)
                            .foregroundStyle(palette.ink2)
                    }
                    Text(session.isVisitOnly ? "Opened" : Timecode.spoken(session.watchedSeconds))
                        .foregroundStyle(palette.ink3)
                    Spacer()
                    Text(DomainName.registrable(session.host))
                        .foregroundStyle(palette.ink3)
                }
                .font(Typeface.time(12.5))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 10) {
            StarRating(title: title)
            Spacer()
            Button("Remove from library", role: .destructive) {
                app.detailTitleID = nil
                app.library.delete(title.id)
            }
            .buttonStyle(.plain)
            .font(Typeface.ui(12.5))
            .foregroundStyle(palette.ink3)
        }
    }
}

/// A saved frame. Click to carry on from it.
struct MomentCell: View {
    let moment: FilmFrame
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var isHovered = false

    var body: some View {
        Color.clear
            .aspectRatio(16.0 / 9.0, contentMode: .fit)
            .overlay {
                RemoteImage(url: app.library.frameURL(moment), maxPixel: 900) { palette.raised }
            }
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(alignment: .bottomLeading) {
                if isHovered {
                    Text(moment.ref.isEpisode
                         ? "\(moment.ref.shortLabel), \(Timecode.string(moment.position))"
                         : Timecode.string(moment.position))
                        .font(Typeface.time(11))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(.black.opacity(0.62), in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                        .padding(6)
                        .transition(.opacity)
                }
            }
            .contentShape(Rectangle())
            .onHover { hovering in withAnimation(.easeOut(duration: 0.12)) { isHovered = hovering } }
            .onTapGesture {
                if let url = moment.url { app.resume(url: url, at: moment.position) }
            }
            .contextMenu {
                if let url = moment.url {
                    Button("Carry on from here") { app.resume(url: url, at: moment.position) }
                }
                Button("Copy image") {
                    guard let image = NSImage(contentsOf: app.library.frameURL(moment)) else { return }
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.writeObjects([image])
                }
                Button("Show in Finder") {
                    NSWorkspace.shared.activateFileViewerSelecting([app.library.frameURL(moment)])
                }
                Divider()
                Button("Delete moment", role: .destructive) { app.library.deleteFrame(moment) }
            }
    }
}

struct EpisodeRow: View {
    let episode: EpisodeInfo
    let progress: WatchProgress?
    let title: Title
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        Button {
            if let url = progress?.url {
                app.resume(url: url, at: progress?.position)
            } else {
                app.detailTitleID = nil
                app.browser.searchEverywhere("\(title.name) season \(episode.season) episode \(episode.episode)", titleID: title.id)
            }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: progress?.finished == true ? "checkmark.circle.fill" : (progress != nil ? "circle.lefthalf.filled" : "circle"))
                    .font(.system(size: 13))
                    .foregroundStyle(progress != nil ? palette.ink : palette.ink3)
                    .frame(width: 18)
                Text("\(episode.episode)")
                    .font(Typeface.time(12.5))
                    .foregroundStyle(palette.ink3)
                    .frame(width: 22, alignment: .trailing)
                Text(episode.name ?? "Episode \(episode.episode)")
                    .font(Typeface.ui(13))
                    .foregroundStyle(palette.ink)
                    .lineLimit(1)
                Spacer()
                if let progress, !progress.finished, !progress.isVisitOnly {
                    Text(Timecode.string(progress.position))
                        .font(Typeface.time(12))
                        .foregroundStyle(palette.ink2)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(HoverButtonStyle())
    }
}

struct StatusPicker: View {
    let title: Title
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        Menu {
            ForEach([TitleStatus.backlog, .watching, .watched], id: \.self) { status in
                Button {
                    app.library.setStatus(title.id, status)
                } label: {
                    if title.status == status {
                        Label(status.label, systemImage: "checkmark")
                    } else {
                        Text(status.label)
                    }
                }
            }
        } label: {
            HStack(spacing: 5) {
                Text(title.status == .none ? "Add to a list" : title.status.label)
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
            }
            .font(Typeface.ui(13, .medium))
            .foregroundStyle(palette.ink)
            .padding(.horizontal, 13)
            .padding(.vertical, 6)
            .overlay(Capsule().strokeBorder(palette.line, lineWidth: 1))
            .contentShape(Capsule())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
    }
}

