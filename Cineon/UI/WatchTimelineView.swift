import SwiftUI

/// Everything you've watched, as one long strip of film.
/// Row heights are multiples of the perforation pitch, so the holes line up from row to row.
struct WatchTimelineView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var showBrowsing = false
    @State private var query = ""

    private struct Day: Identifiable {
        let id: Date
        let entries: [Entry]
    }

    private enum Entry: Identifiable {
        case session(WatchSession)
        case event(LibraryEvent)
        case visit(HistoryEntry)

        var id: String {
            switch self {
            case .session(let s): "s\(s.id)"
            case .event(let e): "e\(e.id)"
            case .visit(let h): "h\(h.id)"
            }
        }

        var date: Date {
            switch self {
            case .session(let s): s.startedAt
            case .event(let e): e.at
            case .visit(let h): h.visitedAt
            }
        }
    }

    private var days: [Day] {
        let library = app.library
        var entries: [Entry] = []
        let needle = TitleParser.normalize(query)

        func matches(_ id: Int64) -> Bool {
            needle.isEmpty || (library.titles[id]?.normName.contains(needle) ?? false)
        }

        entries += library.sessions.filter { matches($0.titleID) }.map(Entry.session)
        entries += library.events.filter { $0.kind != .markedWatching && matches($0.titleID) }.map(Entry.event)
        if showBrowsing {
            let visits = (try? app.session.db.recentHistory(limit: 300)) ?? []
            entries += visits
                .filter { needle.isEmpty || TitleParser.normalize($0.title + $0.host).contains(needle) }
                .map(Entry.visit)
        }

        let calendar = Calendar.current
        let grouped = Dictionary(grouping: entries) { calendar.startOfDay(for: $0.date) }
        return grouped.keys.sorted(by: >).map { day in
            Day(id: day, entries: grouped[day, default: []].sorted { $0.date > $1.date })
        }
    }

    private func total(since: Date) -> Double {
        app.library.sessions.filter { $0.startedAt >= since }.reduce(0) { $0 + $1.watchedSeconds }
    }

    var body: some View {
        let shown = days
        VStack(alignment: .leading, spacing: 0) {
            header
            if shown.isEmpty {
                empty
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(shown) { day in
                            TimelineDayHeader(date: day.id)
                            ForEach(day.entries) { entry in
                                switch entry {
                                case .session(let session):
                                    TimelineSessionRow(session: session)
                                case .event(let event):
                                    TimelineNoteRow(
                                        time: event.at,
                                        text: event.kind.label,
                                        name: app.library.titles[event.titleID]?.name ?? ""
                                    )
                                case .visit(let visit):
                                    TimelineNoteRow(
                                        time: visit.visitedAt,
                                        text: visit.host,
                                        name: visit.title.isEmpty ? visit.url.path : visit.title
                                    )
                                }
                            }
                        }
                        // The strip runs off the end of the roll.
                        FilmStripBody()
                            .frame(width: stripWidth, height: filmPitch * 6)
                            .padding(.leading, stripLeading)
                            .mask(LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom))
                    }
                }
                .scrollIndicators(.never)
            }
        }
        .background(palette.cardFill)
    }

    private var header: some View {
        let calendar = Calendar.current
        let week = calendar.date(from: calendar.dateComponents([.yearForWeekOfYear, .weekOfYear], from: .now)) ?? .now
        let month = calendar.date(from: calendar.dateComponents([.year, .month], from: .now)) ?? .now
        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("Timeline")
                    .font(Typeface.title(30))
                    .foregroundStyle(palette.ink)
                Spacer()
                Toggle("Show pages I browsed", isOn: $showBrowsing)
                    .toggleStyle(.switch)
                    .controlSize(.mini)
                    .font(Typeface.ui(12))
                    .foregroundStyle(palette.ink2)
                    .tint(palette.isDark ? Color(white: 0.75) : .black)
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 11))
                        .foregroundStyle(palette.ink3)
                    TextField("Filter", text: $query)
                        .textFieldStyle(.plain)
                        .font(Typeface.ui(12.5))
                        .frame(width: 120)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(palette.raised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            if total(since: month) > 0 || total(since: week) > 0 {
                HStack(spacing: 22) {
                    stat("This week", total(since: week))
                    stat("This month", total(since: month))
                }
            }
        }
        .padding(.horizontal, 32)
        .padding(.top, 34)
        .padding(.bottom, 20)
    }

    private func stat(_ label: String, _ seconds: Double) -> some View {
        HStack(spacing: 6) {
            Text(label)
                .foregroundStyle(palette.ink3)
            Text(seconds > 0 ? Timecode.spoken(seconds) : "None")
                .foregroundStyle(palette.ink)
        }
        .font(Typeface.ui(13))
    }

    private var empty: some View {
        VStack(spacing: 12) {
            LogoMark(size: 52, color: palette.ink3)
            Text("Play something on any site, and it's recorded here: what, where, and how far you got.")
                .font(Typeface.ui(14))
                .foregroundStyle(palette.ink2)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 380)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Wide enough for a 16:9 frame between the perforations.
private let stripWidth: CGFloat = 190
private let stripLeading: CGFloat = 32
private let frameWidth: CGFloat = 156
private let frameHeight: CGFloat = filmPitch * 6 - 8

/// A day heading sits beside a clear stretch of film, like the gap between shots.
struct TimelineDayHeader: View {
    let date: Date
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 22) {
            FilmStripBody()
                .frame(width: stripWidth, height: filmPitch * 4)
            Text(DateText.day(date))
                .font(Typeface.title(20))
                .foregroundStyle(palette.ink)
                .padding(.top, 14)
            Spacer(minLength: 0)
        }
        .padding(.leading, stripLeading)
    }
}

struct TimelineSessionRow: View {
    let session: WatchSession
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var isHovered = false

    private var title: Title? { app.library.titles[session.titleID] }

    /// A still from the episode itself when there is one, else the backdrop, else the poster.
    private var still: URL? {
        if session.ref.isEpisode, let imdb = title?.imdbID {
            return URL(string: "https://episodes.metahub.space/\(imdb)/\(session.ref.season)/\(session.ref.episode)/w780.jpg")
        }
        return title?.backdropURL ?? title?.posterURL
    }

    private var fraction: Double {
        session.duration > 0 ? min(1, session.endPosition / session.duration) : 0
    }

    private var canResume: Bool { session.url != nil && !session.finished && !session.isVisitOnly }

    /// The more you watched, the more film: one picture per stretch, up to three, with
    /// the frames between them a hover away.
    private var reels: [[FilmFrame]] {
        let frames = app.library.frames(sessionID: session.id)
        guard !frames.isEmpty else { return [] }
        let wanted = min(3, frames.count, Int(session.watchedSeconds / 1500) + 1)
        let size = Double(frames.count) / Double(wanted)
        return (0..<wanted).map { Array(frames[Int(Double($0) * size)..<Int(Double($0 + 1) * size)]) }
    }

    var body: some View {
        let reels = reels
        HStack(alignment: reels.count > 1 ? .top : .center, spacing: 22) {
            if reels.isEmpty {
                frame
            } else {
                VStack(spacing: 0) {
                    ForEach(reels.indices, id: \.self) { index in
                        FrameReel(frames: reels[index], duration: session.duration, fallbackURL: session.url, isMono: session.finished && !isHovered)
                    }
                }
            }
            details
                .padding(.top, reels.count > 1 ? 12 : 0)
            Spacer(minLength: 12)
            if isHovered {
                actions
                    .padding(.top, reels.count > 1 ? 12 : 0)
                    .transition(.opacity)
            }
        }
        .padding(.leading, stripLeading)
        .padding(.trailing, 28)
        .contentShape(Rectangle())
        .onHover { hovering in
            withAnimation(.easeOut(duration: 0.12)) { isHovered = hovering }
        }
        .onTapGesture {
            if let id = title?.id { app.detailTitleID = id }
        }
        .contextMenu {
            if let title { TitleMenu(title: title) }
            Divider()
            Button("Remove from timeline") { app.library.deleteSession(session.id) }
        }
    }

    private var frame: some View {
        ZStack {
            FilmStripBody()
            RemoteImage(url: still, maxPixel: 320) {
                // An unexposed frame.
                Color(white: 0.17)
            }
            .frame(width: frameWidth, height: frameHeight)
            .clipped()
            .clipShape(RoundedRectangle(cornerRadius: 3, style: .continuous))
            .saturation(session.finished && !isHovered ? 0 : 1)
            .animation(.easeInOut(duration: 0.3), value: isHovered)
        }
        .frame(width: stripWidth, height: filmPitch * 6)
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title?.name ?? "Removed title")
                .font(Typeface.title(18))
                .foregroundStyle(palette.ink)
                .lineLimit(1)
            if !subtitle.isEmpty {
                Text(subtitle)
                    .font(Typeface.ui(12.5))
                    .foregroundStyle(palette.ink2)
                    .lineLimit(1)
            }
            Text(whereLine)
                .font(Typeface.time(12))
                .foregroundStyle(palette.ink3)
                .lineLimit(1)
            if session.duration > 0 {
                ProgressLine(fraction: fraction, height: 2)
                    .frame(width: 180)
                    .padding(.top, 4)
            }
        }
    }

    private var subtitle: String {
        var parts: [String] = []
        if session.ref.isEpisode {
            parts.append(session.episodeName.map { "\(session.ref.shortLabel), \($0)" } ?? session.ref.longLabel)
        }
        if session.isVisitOnly {
            // Nothing to add: the line below says when it was opened.
        } else if session.finished {
            parts.append("Finished")
        } else if session.duration > 0 {
            parts.append("Stopped at \(Timecode.string(session.endPosition)) of \(Timecode.string(session.duration))")
        }
        return parts.joined(separator: ". ")
    }

    private var whereLine: String {
        let times = session.isVisitOnly
            ? "Opened at \(DateText.time(session.startedAt))"
            : "\(DateText.time(session.startedAt)) to \(DateText.time(session.endedAt))"
        return "\(times) on \(DomainName.registrable(session.host))"
    }

    @ViewBuilder private var actions: some View {
        if canResume, let url = session.url {
            Button {
                app.resume(url: url, at: session.endPosition)
            } label: {
                Label("Resume at \(Timecode.string(session.endPosition))", systemImage: "play.fill")
            }
            .buttonStyle(SilverButtonStyle())
        } else if let url = session.url {
            Button("Open page") { app.browser.open(url: url) }
                .buttonStyle(OutlineButtonStyle())
        }
    }
}

/// One frame in the film strip. Moving across it flips through the frames around it, and
/// clicking carries on from the second that frame shows.
struct FrameReel: View {
    let frames: [FilmFrame]
    let duration: Double
    let fallbackURL: URL?
    let isMono: Bool
    @Environment(AppModel.self) private var app
    @State private var scrubIndex: Int?
    @State private var isPrimed = false

    /// The most interesting frame, leaving out the end where possible: a screen full of
    /// credits scores well, and tells you nothing. A moment someone saved always wins.
    private var hero: FilmFrame {
        let story = frames.filter { $0.isMoment || duration <= 0 || $0.position < duration * 0.85 }
        return (story.isEmpty ? frames : story).max { $0.interest < $1.interest } ?? frames[0]
    }

    private var shown: FilmFrame { scrubIndex.map { frames[min($0, frames.count - 1)] } ?? hero }

    var body: some View {
        ZStack {
            FilmStripBody()
            RemoteImage(url: app.library.frameURL(shown), maxPixel: 480) {
                Color(white: 0.17)
            }
            .frame(width: frameWidth, height: frameHeight)
            .clipped()
            .clipShape(RoundedRectangle(cornerRadius: 3, style: .continuous))
            .saturation(isMono ? 0 : 1)
            .animation(.easeInOut(duration: 0.3), value: isMono)
            .overlay(alignment: .bottomLeading) {
                if scrubIndex != nil {
                    Text(Timecode.string(shown.position))
                        .font(Typeface.time(10.5))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(.black.opacity(0.62), in: RoundedRectangle(cornerRadius: 3, style: .continuous))
                        .padding(4)
                }
            }
            .frame(width: frameWidth, height: frameHeight)
            .contentShape(Rectangle())
            .onContinuousHover { phase in
                switch phase {
                case .active(let location):
                    guard frames.count > 1 else { return }
                    isPrimed = true
                    let fraction = min(0.999, max(0, location.x / frameWidth))
                    scrubIndex = Int(fraction * Double(frames.count))
                case .ended:
                    scrubIndex = nil
                }
            }
            .task(id: isPrimed) {
                // Loaded the moment the pointer arrives, so scrubbing never shows an empty frame,
                // and not before, so a long timeline stays light.
                guard isPrimed else { return }
                for frame in frames {
                    _ = await ImagePipeline.shared.image(app.library.frameURL(frame), maxPixel: 480)
                }
            }
            .onTapGesture {
                let frame = shown
                if let url = frame.url ?? fallbackURL { app.resume(url: url, at: frame.position) }
            }
            .help("Carry on from \(Timecode.string(shown.position))")
            .accessibilityElement()
            .accessibilityLabel("Frame at \(Timecode.string(shown.position))")
            .accessibilityAddTraits(.isButton)
        }
        .frame(width: stripWidth, height: filmPitch * 6)
    }
}

/// Smaller moments: added to backlog, marked as watched, a page visited.
struct TimelineNoteRow: View {
    let time: Date
    let text: String
    let name: String
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 22) {
            FilmStripBody()
                .frame(width: stripWidth, height: filmPitch * 2)
            HStack(spacing: 6) {
                Text(DateText.time(time))
                    .font(Typeface.time(12))
                    .foregroundStyle(palette.ink3)
                Text(text + ":")
                    .font(Typeface.ui(12.5))
                    .foregroundStyle(palette.ink3)
                Text(name)
                    .font(Typeface.ui(12.5, .medium))
                    .foregroundStyle(palette.ink2)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.leading, stripLeading)
        .padding(.trailing, 28)
    }
}
