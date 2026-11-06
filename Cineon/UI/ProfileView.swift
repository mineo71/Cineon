import AppKit
import SwiftUI

/// Who you are as a watcher: your pet, what you watch, how you watch it.
struct ProfileView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        let stats = app.session.stats
        let pet = app.session.pet
        ScrollView {
            VStack(alignment: .leading, spacing: 44) {
                ProfileHero(stats: stats, pet: pet)
                StatTiles(stats: stats)
                HStack(alignment: .top, spacing: 40) {
                    GenreBars(genres: stats.genres)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    VStack(alignment: .leading, spacing: 36) {
                        RatingHistogram(counts: stats.ratingCounts, average: stats.averageRating)
                        DecadeBars(decades: stats.decades)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                WatchingHeatmap(stats: stats)
                if !stats.topTitles.isEmpty { TopTitles(titles: stats.topTitles) }
                ExtrasRow(stats: stats)
            }
            .padding(.horizontal, 44)
            .padding(.top, 34)
            .padding(.bottom, 60)
            .frame(maxWidth: 1180, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .scrollIndicators(.never)
        .background(palette.cardFill)
    }
}

// MARK: Hero

/// Your pet in a spotlight, and who you are next to it.
struct ProfileHero: View {
    let stats: ProfileStats
    let pet: PixelPet
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(alignment: .center, spacing: 40) {
            ZStack {
                RadialGradient(colors: [palette.ink.opacity(palette.isDark ? 0.16 : 0.08), .clear], center: .center, startRadius: 4, endRadius: 130)
                Ellipse()
                    .fill(palette.ink.opacity(0.1))
                    .frame(width: 120, height: 16)
                    .blur(radius: 6)
                    .offset(y: 84)
                PixelPetView(pet: pet, size: 168)
            }
            .frame(width: 240, height: 230)
            .accessibilityElement()
            .accessibilityLabel("\(pet.name), your pet: a \(pet.stageLabel.lowercased()) \(pet.speciesLabel.lowercased()), feeling \(pet.moodLabel.lowercased())")

            VStack(alignment: .leading, spacing: 10) {
                Text(app.session.profile.name)
                    .font(Typeface.title(44))
                    .foregroundStyle(palette.ink)
                HStack(spacing: 8) {
                    Text(pet.name)
                        .font(Typeface.bold(17))
                        .foregroundStyle(palette.ink)
                    Text("\(pet.stageLabel) \(pet.speciesLabel.lowercased()), level \(pet.level)")
                        .font(Typeface.ui(14))
                        .foregroundStyle(palette.ink2)
                    MoodTag(text: pet.moodLabel)
                }
                Text(pet.blurb)
                    .font(Typeface.ui(14))
                    .foregroundStyle(palette.ink2)
                    .frame(maxWidth: 460, alignment: .leading)
                if let genre = stats.favouriteGenre {
                    Text("Raised on \(genre.lowercased())\(stats.genres.count > 1 ? " and \(stats.genres[1].name.lowercased())" : ""). Watch more and \(pet.name) grows up.")
                        .font(Typeface.ui(12.5))
                        .foregroundStyle(palette.ink3)
                }
                HStack(spacing: 10) {
                    Button {
                        ShareCard.export(stats: stats, pet: pet, name: app.session.profile.name)
                    } label: {
                        Label("Save a share card", systemImage: "square.and.arrow.up")
                    }
                    .buttonStyle(SilverButtonStyle())
                    Button { app.go(.rate) } label: {
                        Label("Rate films", systemImage: "star.leadinghalf.filled")
                    }
                    .buttonStyle(OutlineButtonStyle())
                }
                .padding(.top, 8)
            }
            Spacer(minLength: 0)
        }
    }
}

struct MoodTag: View {
    let text: String
    @Environment(\.palette) private var palette

    var body: some View {
        Text(text)
            .font(Typeface.ui(11, .medium))
            .foregroundStyle(palette.ink2)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .overlay(Capsule().strokeBorder(palette.line, lineWidth: 1))
    }
}

// MARK: Numbers

struct StatTiles: View {
    let stats: ProfileStats
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            tile(
                value: Self.hours(stats.estimatedHours),
                label: "hours watched",
                note: stats.estimatedHours > stats.trackedHours + 1
                    ? (stats.trackedHours < 1 ? "worked out from the runtimes of what you finished" : "\(Self.hours(stats.trackedHours)) timed by Cineon, the rest from runtimes")
                    : nil
            )
            divider
            tile(value: "\(stats.filmsWatched)", label: stats.filmsWatched == 1 ? "film" : "films", note: stats.seriesFinished > 0 ? "and \(stats.seriesFinished) series finished" : nil)
            divider
            tile(value: "\(stats.episodesFinished)", label: stats.episodesFinished == 1 ? "episode" : "episodes", note: nil)
            divider
            tile(value: "\(stats.currentStreak)", label: stats.currentStreak == 1 ? "day in a row" : "days in a row", note: "longest \(stats.longestStreak)")
            divider
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "star.fill")
                        .font(.system(size: 20))
                        .foregroundStyle(palette.gold)
                    Text(stats.averageRating.map { String(format: "%.1f", $0) } ?? "–")
                        .font(Typeface.bold(34))
                        .foregroundStyle(palette.ink)
                }
                Text("average of \(stats.rated) rated")
                    .font(Typeface.ui(12))
                    .foregroundStyle(palette.ink3)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 18)
        .overlay(alignment: .top) { Rectangle().fill(palette.line).frame(height: 0.5) }
        .overlay(alignment: .bottom) { Rectangle().fill(palette.line).frame(height: 0.5) }
    }

    private var divider: some View {
        Rectangle().fill(palette.line).frame(width: 0.5, height: 46).padding(.horizontal, 18)
    }

    private func tile(value: String, label: String, note: String?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(value)
                .font(Typeface.bold(34))
                .foregroundStyle(palette.ink)
                .contentTransition(.numericText())
            Text(label)
                .font(Typeface.ui(12))
                .foregroundStyle(palette.ink2)
            if let note {
                Text(note)
                    .font(Typeface.ui(10.5))
                    .foregroundStyle(palette.ink3)
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    static func hours(_ value: Double) -> String {
        value >= 100 ? String(Int(value.rounded())) : String(format: "%.0f", value.rounded())
    }
}

// MARK: Charts

struct SectionTitle: View {
    let text: String
    var detail: String?
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(text)
                .font(Typeface.title(22))
                .foregroundStyle(palette.ink)
            if let detail {
                Text(detail)
                    .font(Typeface.ui(12.5))
                    .foregroundStyle(palette.ink3)
            }
        }
    }
}

/// Share of your watching by genre. One series, so the title names it and no legend is needed.
struct GenreBars: View {
    let genres: [GenreWeight]
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            SectionTitle(text: "Your taste", detail: genres.first.map { "mostly \($0.name.lowercased())" })
            if genres.isEmpty {
                Text("Genres appear once Cineon has found your films' details.")
                    .font(Typeface.ui(12.5))
                    .foregroundStyle(palette.ink3)
            }
            let top = Array(genres.prefix(9))
            let most = top.first?.weight ?? 1
            VStack(alignment: .leading, spacing: 9) {
                ForEach(top, id: \.name) { genre in
                    HStack(spacing: 12) {
                        Text(genre.name)
                            .font(Typeface.ui(12.5))
                            .foregroundStyle(palette.ink2)
                            .frame(width: 92, alignment: .leading)
                        GeometryReader { geometry in
                            UnevenRoundedRectangle(cornerRadii: .init(topLeading: 0, bottomLeading: 0, bottomTrailing: 4, topTrailing: 4))
                                .fill(genre.name == top.first?.name ? AnyShapeStyle(palette.silver) : AnyShapeStyle(palette.ink.opacity(0.32)))
                                .frame(width: max(3, geometry.size.width * genre.weight / most))
                        }
                        .frame(height: 10)
                        Text("\(Int((genre.weight * 100).rounded()))%")
                            .font(Typeface.time(11.5))
                            .foregroundStyle(palette.ink3)
                            .frame(width: 34, alignment: .trailing)
                    }
                    .help("\(genre.name): \(Int((genre.weight * 100).rounded()))% of your watching")
                }
            }
        }
    }
}

/// How your ratings spread from 1 to 10, in gold since these are your stars.
struct RatingHistogram: View {
    let counts: [Int]
    let average: Double?
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionTitle(text: "Your stars", detail: counts.reduce(0, +) == 0 ? "nothing rated yet" : "\(counts.reduce(0, +)) rated")
            let most = max(1, counts.max() ?? 1)
            HStack(alignment: .bottom, spacing: 2) {
                ForEach(0..<10, id: \.self) { index in
                    VStack(spacing: 5) {
                        Spacer(minLength: 0)
                        UnevenRoundedRectangle(cornerRadii: .init(topLeading: 4, bottomLeading: 0, bottomTrailing: 0, topTrailing: 4))
                            .fill(counts[index] > 0 ? AnyShapeStyle(palette.gold) : AnyShapeStyle(palette.raised2))
                            .frame(height: counts[index] > 0 ? max(4, 86 * Double(counts[index]) / Double(most)) : 2)
                        Text("\(index + 1)")
                            .font(Typeface.time(10.5))
                            .foregroundStyle(palette.ink3)
                    }
                    .frame(maxWidth: .infinity)
                    .help("\(counts[index]) rated \(index + 1)")
                }
            }
            .frame(height: 110)
        }
    }
}

struct DecadeBars: View {
    let decades: [(decade: Int, count: Int)]
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            let favourite = decades.max { $0.count < $1.count }
            SectionTitle(text: "Decades", detail: favourite.map { "the \(String($0.decade))s most" })
            let shown = Array(decades.suffix(9))
            let most = max(1, shown.map(\.count).max() ?? 1)
            HStack(alignment: .bottom, spacing: 2) {
                ForEach(shown, id: \.decade) { item in
                    VStack(spacing: 5) {
                        Spacer(minLength: 0)
                        UnevenRoundedRectangle(cornerRadii: .init(topLeading: 4, bottomLeading: 0, bottomTrailing: 0, topTrailing: 4))
                            .fill(item.decade == favourite?.decade ? AnyShapeStyle(palette.silver) : AnyShapeStyle(palette.ink.opacity(0.3)))
                            .frame(height: max(3, 64 * Double(item.count) / Double(most)))
                        Text(String(item.decade))
                            .font(Typeface.time(10.5))
                            .foregroundStyle(palette.ink3)
                    }
                    .frame(maxWidth: .infinity)
                    .help("\(item.count) from the \(String(item.decade))s")
                }
            }
            .frame(height: 86)
        }
    }
}

/// When you watch: weekdays down, hours across, brighter for more sessions.
struct WatchingHeatmap: View {
    let stats: ProfileStats
    @Environment(\.palette) private var palette

    private static let days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

    private var detail: String? {
        guard let day = stats.busiestWeekday, let hour = stats.busiestHour else { return nil }
        let names = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"]
        return "mostly \(names[day]), around \(Self.hourLabel(hour))"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionTitle(text: "When you watch", detail: detail)
            let most = max(1, stats.heatmap.flatMap { $0 }.max() ?? 1)
            VStack(alignment: .leading, spacing: 2) {
                ForEach(0..<7, id: \.self) { day in
                    HStack(spacing: 2) {
                        Text(Self.days[day])
                            .font(Typeface.ui(11))
                            .foregroundStyle(palette.ink3)
                            .frame(width: 34, alignment: .leading)
                        ForEach(0..<24, id: \.self) { hour in
                            let count = stats.heatmap[day][hour]
                            RoundedRectangle(cornerRadius: 3, style: .continuous)
                                .fill(count == 0 ? palette.raised : palette.ink.opacity(0.14 + 0.78 * sqrt(Double(count) / Double(most))))
                                .frame(height: 18)
                                .frame(maxWidth: .infinity)
                                .help("\(Self.days[day]) \(Self.hourLabel(hour)): \(count) \(count == 1 ? "session" : "sessions")")
                        }
                    }
                }
                HStack(spacing: 2) {
                    Spacer().frame(width: 34)
                    ForEach(0..<24, id: \.self) { hour in
                        Text(hour % 6 == 0 ? Self.hourLabel(hour) : "")
                            .font(Typeface.time(9.5))
                            .foregroundStyle(palette.ink3)
                            .fixedSize()
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(.top, 4)
            }
            if let binge = stats.binge {
                Text(bingeText(binge))
                    .font(Typeface.ui(12.5))
                    .foregroundStyle(palette.ink2)
                    .padding(.top, 4)
            }
        }
    }

    private func bingeText(_ binge: ProfileStats.BingeDay) -> String {
        let day = binge.day.formatted(.dateTime.day().month(.wide).year())
        if binge.seconds > 1800 { return "Your biggest day: \(Timecode.spoken(binge.seconds)) on \(day)." }
        return "Your biggest day: \(binge.sessions) things opened on \(day)."
    }

    static func hourLabel(_ hour: Int) -> String {
        String(format: "%02d:00", hour)
    }
}

struct TopTitles: View {
    let titles: [ProfileStats.TopTitle]
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionTitle(text: "Most watched")
            HStack(alignment: .top, spacing: 18) {
                ForEach(titles) { item in
                    Button { app.openTitle(item.id) } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            if let title = app.library.titles[item.id] {
                                PosterImage(title: title, width: 120, keepsColour: true)
                            }
                            Text(item.name)
                                .font(Typeface.ui(12.5, .medium))
                                .foregroundStyle(palette.ink)
                                .lineLimit(1)
                            Text(item.hours >= 0.5 ? "\(Timecode.spoken(item.hours * 3600))" : "\(item.sessions) \(item.sessions == 1 ? "visit" : "visits")")
                                .font(Typeface.ui(11.5))
                                .foregroundStyle(palette.ink3)
                        }
                        .frame(width: 120, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

struct ExtrasRow: View {
    let stats: ProfileStats
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 28) {
            extra("camera.viewfinder", "\(stats.moments)", stats.moments == 1 ? "moment saved" : "moments saved")
            extra("shield.lefthalf.filled", stats.adsBlocked.formatted(), "ads kept off your films")
            extra("arrow.down.circle", "\(stats.downloads)", "on this Mac")
            extra("square.stack", "\(stats.backlog)", "in your backlog")
            Spacer()
            CloudStatus()
        }
        .padding(.top, 6)
    }

    private func extra(_ symbol: String, _ value: String, _ label: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: symbol)
                .font(.system(size: 13))
                .foregroundStyle(palette.ink3)
            Text(value)
                .font(Typeface.time(13, .semibold))
                .foregroundStyle(palette.ink)
            Text(label)
                .font(Typeface.ui(12.5))
                .foregroundStyle(palette.ink2)
        }
    }
}

/// Whether ratings and lists are safe in the cloud.
struct CloudStatus: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        let cloud = app.session.cloud!
        Group {
            if !app.settings.cloudBackup {
                Label("Cloud backup is off", systemImage: "icloud.slash")
            } else if let error = cloud.lastError {
                Label("Backup waiting: \(error)", systemImage: "exclamationmark.icloud")
                    .lineLimit(1)
            } else if let last = cloud.lastSync {
                Label("Ratings backed up \(last.formatted(.relative(presentation: .named)))", systemImage: "checkmark.icloud")
            } else {
                Label("Backing up your ratings…", systemImage: "icloud")
            }
        }
        .font(Typeface.ui(11.5))
        .foregroundStyle(palette.ink3)
        .help("Ratings and lists are kept in the cloud, so they come back if you clear the library or move to another Mac.")
    }
}

// MARK: Share card

/// A picture of your profile to post or send: pet, top numbers and taste.
struct ShareCardView: View {
    let stats: ProfileStats
    let pet: PixelPet
    let name: String
    private let palette = Palette.dark

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack(spacing: 8) {
                LogoMark(size: 20, color: .white)
                Text("Cineon").font(Typeface.bold(17)).foregroundStyle(.white)
                Spacer()
                Text(Date.now.formatted(.dateTime.month(.wide).year()))
                    .font(Typeface.ui(13))
                    .foregroundStyle(.white.opacity(0.5))
            }
            HStack(alignment: .center, spacing: 26) {
                PixelPetView(pet: pet, size: 150, animated: false)
                VStack(alignment: .leading, spacing: 6) {
                    Text(name).font(Typeface.title(40)).foregroundStyle(.white)
                    Text("\(pet.name), \(pet.stageLabel.lowercased()) \(pet.speciesLabel.lowercased())")
                        .font(Typeface.ui(15))
                        .foregroundStyle(.white.opacity(0.7))
                    if let genre = stats.favouriteGenre {
                        Text("Mostly \(genre.lowercased())")
                            .font(Typeface.ui(15))
                            .foregroundStyle(.white.opacity(0.7))
                    }
                }
            }
            HStack(spacing: 34) {
                number(StatTiles.hours(stats.estimatedHours), "hours")
                number("\(stats.filmsWatched)", "films")
                number("\(stats.episodesFinished)", "episodes")
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 5) {
                        Image(systemName: "star.fill").font(.system(size: 18)).foregroundStyle(palette.gold)
                        Text(stats.averageRating.map { String(format: "%.1f", $0) } ?? "–").font(Typeface.bold(30)).foregroundStyle(.white)
                    }
                    Text("average").font(Typeface.ui(12)).foregroundStyle(.white.opacity(0.55))
                }
            }
            GenreBars(genres: Array(stats.genres.prefix(5)))
        }
        .padding(36)
        .frame(width: 720)
        .background(
            LinearGradient(colors: [Color(white: 0.1), .black], startPoint: .top, endPoint: .bottom)
        )
        .environment(\.palette, palette)
    }

    private func number(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value).font(Typeface.bold(30)).foregroundStyle(.white)
            Text(label).font(Typeface.ui(12)).foregroundStyle(.white.opacity(0.55))
        }
    }
}

enum ShareCard {
    /// Renders the card and asks where to save it.
    static func export(stats: ProfileStats, pet: PixelPet, name: String) {
        let renderer = ImageRenderer(content: ShareCardView(stats: stats, pet: pet, name: name))
        renderer.scale = 2
        guard let image = renderer.nsImage, let tiff = image.tiffRepresentation,
              let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:])
        else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "\(name) on Cineon.png"
        panel.allowedContentTypes = [.png]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        try? png.write(to: url)
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    #if DEBUG
    /// For tests: writes the card without asking.
    static func write(stats: ProfileStats, pet: PixelPet, name: String, to url: URL) -> Bool {
        let renderer = ImageRenderer(content: ShareCardView(stats: stats, pet: pet, name: name))
        renderer.scale = 2
        guard let image = renderer.nsImage, let tiff = image.tiffRepresentation,
              let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:])
        else { return false }
        return (try? png.write(to: url)) != nil
    }
    #endif
}
