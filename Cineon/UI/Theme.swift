import SwiftUI

/// Black and silver, or white and graphite. The chrome never takes a hue of its own, so the only
/// colour on screen comes from the films.
struct Palette: Equatable {
    var isDark: Bool
    var canvas: Color
    var ink: Color
    var ink2: Color
    var ink3: Color
    var raised: Color
    var raised2: Color
    var line: Color
    var silverTop: Color
    var silverBottom: Color
    /// Text on a silver fill.
    var onSilver: Color
    /// The film strip stays dark in both themes, the way real film does on a light table.
    var stripBody: Color
    var stripHole: Color
    var cardFill: Color

    static let dark = Palette(
        isDark: true,
        canvas: .black,
        ink: .white,
        ink2: .white.opacity(0.62),
        ink3: .white.opacity(0.38),
        raised: .white.opacity(0.07),
        raised2: .white.opacity(0.13),
        line: .white.opacity(0.11),
        silverTop: Color(white: 0.96),
        silverBottom: Color(white: 0.62),
        onSilver: .black,
        stripBody: Color(white: 0.11),
        stripHole: .black,
        cardFill: Color(white: 0.055)
    )

    static let white = Palette(
        isDark: false,
        canvas: .white,
        ink: .black,
        ink2: .black.opacity(0.62),
        ink3: .black.opacity(0.42),
        raised: .black.opacity(0.045),
        raised2: .black.opacity(0.09),
        line: .black.opacity(0.11),
        silverTop: Color(white: 0.26),
        silverBottom: .black,
        onSilver: .white,
        stripBody: .black,
        stripHole: .white,
        cardFill: .white
    )

    var silver: LinearGradient {
        LinearGradient(colors: [silverTop, silverBottom], startPoint: .top, endPoint: .bottom)
    }
}

extension EnvironmentValues {
    @Entry var palette = Palette.dark
}

/// Futura for anything that names a film: it's what film titles have been set in from Kubrick to
/// Wes Anderson. SF for the interface around it.
enum Typeface {
    static func title(_ size: CGFloat) -> Font { .custom("Futura-Medium", size: size) }
    static func bold(_ size: CGFloat) -> Font { .custom("Futura-Bold", size: size) }
    static func condensed(_ size: CGFloat) -> Font { .custom("Futura-CondensedExtraBold", size: size) }
    static func ui(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font { .system(size: size, weight: weight) }
    static func time(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight).monospacedDigit()
    }
}

// MARK: Logo

struct LogoMark: View {
    var size: CGFloat = 28
    var color: Color?
    @Environment(\.palette) private var palette

    var body: some View {
        Image("LogoMark")
            .renderingMode(.template)
            .resizable()
            .interpolation(.high)
            .aspectRatio(contentMode: .fit)
            .frame(width: size, height: size)
            .foregroundStyle(color ?? palette.ink)
            .accessibilityLabel("Cineon")
    }
}

// MARK: Buttons

struct HoverButtonStyle: ButtonStyle {
    var cornerRadius: CGFloat = 8
    var isSelected = false
    var padding: EdgeInsets = EdgeInsets(top: 6, leading: 8, bottom: 6, trailing: 8)
    @Environment(\.palette) private var palette
    @State private var isHovered = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(padding)
            .background(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(fill(pressed: configuration.isPressed))
            )
            .contentShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .scaleEffect(configuration.isPressed ? 0.975 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
            .animation(.easeOut(duration: 0.12), value: isHovered)
            .onHover { isHovered = $0 }
    }

    private func fill(pressed: Bool) -> Color {
        if isSelected || pressed { return palette.raised2 }
        return isHovered ? palette.raised : .clear
    }
}

/// The one strong button on any screen, finished like the film strip in the logo.
struct SilverButtonStyle: ButtonStyle {
    var large = false
    @Environment(\.palette) private var palette
    @Environment(\.isEnabled) private var isEnabled
    @State private var isHovered = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Typeface.ui(large ? 15 : 13, .semibold))
            .foregroundStyle(palette.onSilver)
            .padding(.horizontal, large ? 22 : 14)
            .padding(.vertical, large ? 11 : 7)
            .background(Capsule().fill(palette.silver))
            .brightness(isHovered && isEnabled ? (palette.isDark ? 0.06 : 0.14) : 0)
            .opacity(isEnabled ? 1 : 0.38)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .contentShape(Capsule())
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
            .animation(.easeOut(duration: 0.15), value: isHovered)
            .onHover { isHovered = $0 }
    }
}

struct OutlineButtonStyle: ButtonStyle {
    var large = false
    @Environment(\.palette) private var palette
    @Environment(\.isEnabled) private var isEnabled
    @State private var isHovered = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Typeface.ui(large ? 15 : 13, .medium))
            .foregroundStyle(palette.ink)
            .padding(.horizontal, large ? 20 : 13)
            .padding(.vertical, large ? 10 : 6)
            .background(Capsule().fill(isHovered || configuration.isPressed ? palette.raised : .clear))
            .overlay(Capsule().strokeBorder(palette.line, lineWidth: 1))
            .opacity(isEnabled ? 1 : 0.38)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .contentShape(Capsule())
            .animation(.easeOut(duration: 0.12), value: isHovered)
            .onHover { isHovered = $0 }
    }
}

struct IconButton: View {
    let symbol: String
    let label: String
    var size: CGFloat = 13
    var isEnabled = true
    let action: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: size, weight: .medium))
                .foregroundStyle(isEnabled ? palette.ink2 : palette.ink3.opacity(0.6))
                .frame(width: 16, height: 16)
        }
        .buttonStyle(HoverButtonStyle(cornerRadius: 7, padding: EdgeInsets(top: 5, leading: 5, bottom: 5, trailing: 5)))
        .disabled(!isEnabled)
        .help(label)
        .accessibilityLabel(label)
    }
}

// MARK: Film strip

/// Perforation pitch. Everything on the timeline is a multiple of this so holes line up across rows.
let filmPitch: CGFloat = 16

/// A length of vertical film: body and perforations down both edges.
struct FilmStripBody: View {
    @Environment(\.palette) private var palette

    var body: some View {
        Canvas { context, size in
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(palette.stripBody))
            let holeWidth: CGFloat = 7
            let holeHeight: CGFloat = 9
            let inset: CGFloat = 4
            var y: CGFloat = (filmPitch - holeHeight) / 2
            while y < size.height {
                let left = CGRect(x: inset, y: y, width: holeWidth, height: holeHeight)
                let right = CGRect(x: size.width - inset - holeWidth, y: y, width: holeWidth, height: holeHeight)
                context.fill(Path(roundedRect: left, cornerRadius: 1.8), with: .color(palette.stripHole))
                context.fill(Path(roundedRect: right, cornerRadius: 1.8), with: .color(palette.stripHole))
                y += filmPitch
            }
        }
        .accessibilityHidden(true)
    }
}

/// A thin progress line. Silver, like everything else that isn't a film.
struct ProgressLine: View {
    var fraction: Double
    var height: CGFloat = 3
    @Environment(\.palette) private var palette

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(palette.raised2)
                Capsule()
                    .fill(palette.ink)
                    .frame(width: max(height, geometry.size.width * min(1, max(0, fraction))))
            }
        }
        .frame(height: height)
        .accessibilityValue("\(Int(fraction * 100)) percent")
    }
}

// MARK: Posters

/// Watched films fade to black and white, like a memory. Hovering brings their colour back.
struct PosterImage: View {
    let title: Title
    var width: CGFloat?
    var cornerRadius: CGFloat = 6
    /// Watched films are shown in black and white, except where colour is the point.
    var keepsColour = false
    @Environment(\.palette) private var palette
    @Environment(AppModel.self) private var app
    @State private var isHovered = false

    private var isMono: Bool { title.status == .watched && !isHovered && !keepsColour }

    var body: some View {
        // The 2:3 shape comes first, and the image is cropped to it. Sizing from the image instead
        // would let posters with unusual proportions push out of their column.
        Color.clear
            .aspectRatio(2.0 / 3.0, contentMode: .fit)
            .frame(width: width)
            .overlay {
                // With no poster anywhere, a frame you actually saw beats a blank card.
                RemoteImage(url: title.posterURL ?? app.library.bestFrameURL(titleID: title.id), maxPixel: 600) {
                    PosterPlaceholder(name: title.name)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .saturation(isMono ? 0 : 1)
        .animation(.easeInOut(duration: 0.35), value: isMono)
        .onHover { isHovered = $0 }
    }
}

/// With no poster to show, the name becomes the poster: a title card.
struct PosterPlaceholder: View {
    let name: String
    @Environment(\.palette) private var palette

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            palette.raised
            Text(name)
                .font(Typeface.title(15))
                .foregroundStyle(palette.ink2)
                .lineLimit(5)
                .minimumScaleFactor(0.7)
                .padding(10)
        }
    }
}

struct SiteIcon: View {
    let name: String
    let url: URL?
    var size: CGFloat = 20
    @Environment(\.palette) private var palette

    var body: some View {
        RemoteImage(url: url, maxPixel: 96, contentMode: .fit) {
            Text(String(name.prefix(1)).uppercased())
                .font(Typeface.bold(size * 0.62))
                .foregroundStyle(palette.ink2)
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
    }
}

// MARK: Overlay surface

struct GlassPanel: ViewModifier {
    var cornerRadius: CGFloat = 20
    @Environment(\.palette) private var palette

    func body(content: Content) -> some View {
        content
            .background(palette.cardFill.opacity(0.72), in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .glassEffect(.regular, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(palette.line, lineWidth: 1)
            )
            .shadow(color: .black.opacity(palette.isDark ? 0.55 : 0.2), radius: 40, y: 18)
    }
}

extension View {
    func glassPanel(cornerRadius: CGFloat = 20) -> some View {
        modifier(GlassPanel(cornerRadius: cornerRadius))
    }
}

// MARK: Key handling

/// Reads the keyboard at the window level. Needed for arrow keys while a text field is focused,
/// and for Esc while a web view has focus.
struct KeyMonitor: ViewModifier {
    let handler: (NSEvent) -> Bool
    @State private var monitor: Any?

    func body(content: Content) -> some View {
        content
            .onAppear {
                monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
                    handler(event) ? nil : event
                }
            }
            .onDisappear {
                if let monitor { NSEvent.removeMonitor(monitor) }
                monitor = nil
            }
    }
}

extension View {
    func onKeyDown(_ handler: @escaping (NSEvent) -> Bool) -> some View {
        modifier(KeyMonitor(handler: handler))
    }
}

enum KeyCode {
    static let escape: UInt16 = 53
    static let enter: UInt16 = 36
    static let padEnter: UInt16 = 76
    static let up: UInt16 = 126
    static let down: UInt16 = 125
    static let tab: UInt16 = 48
}

// MARK: Dates

enum DateText {
    static func day(_ date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate(calendar.isDate(date, equalTo: .now, toGranularity: .year) ? "EEEEdMMMM" : "EEEEdMMMMyyyy")
        return f.string(from: date)
    }

    static func time(_ date: Date) -> String {
        let f = DateFormatter()
        f.timeStyle = .short
        f.dateStyle = .none
        return f.string(from: date)
    }

    static func relative(_ date: Date) -> String {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .full
        return f.localizedString(for: date, relativeTo: .now)
    }
}

extension EpisodeRef {
    var longLabel: String { "Season \(season), episode \(episode)" }
    var shortLabel: String { "S\(season) E\(episode)" }
}
