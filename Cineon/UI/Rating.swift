import SwiftUI

// Ratings out of ten, in half stars. The one colour Cineon allows itself besides the films' own:
// the gold of an award statuette.

extension Palette {
    var gold: LinearGradient {
        isDark
            ? LinearGradient(colors: [Color(red: 1, green: 0.86, blue: 0.5), Color(red: 0.93, green: 0.66, blue: 0.22)], startPoint: .top, endPoint: .bottom)
            : LinearGradient(colors: [Color(red: 0.93, green: 0.69, blue: 0.2), Color(red: 0.74, green: 0.5, blue: 0.08)], startPoint: .top, endPoint: .bottom)
    }

    var goldInk: Color { isDark ? Color(red: 1, green: 0.8, blue: 0.4) : Color(red: 0.7, green: 0.47, blue: 0.06) }
}

/// One star, filled from the left by `fill` (0, 0.5 or 1).
struct RatingStar: View {
    var fill: Double
    var size: CGFloat
    var emptyOpacity: Double = 1
    @Environment(\.palette) private var palette

    var body: some View {
        ZStack(alignment: .leading) {
            Image(systemName: "star.fill")
                .font(.system(size: size))
                .foregroundStyle(palette.raised2.opacity(emptyOpacity))
            if fill > 0 {
                Image(systemName: "star.fill")
                    .font(.system(size: size))
                    .foregroundStyle(palette.gold)
                    .mask(alignment: .leading) {
                        Rectangle().frame(width: size * 1.1 * fill)
                    }
                    .shadow(color: palette.goldInk.opacity(palette.isDark ? 0.45 : 0), radius: size * 0.25)
            }
        }
        .frame(width: size * 1.1, height: size * 1.1, alignment: .leading)
    }
}

/// Ten stars, read only.
struct StarRow: View {
    var halves: Int?
    var size: CGFloat = 11
    var spacing: CGFloat = 1.5

    var body: some View {
        HStack(spacing: spacing) {
            ForEach(1...10, id: \.self) { star in
                RatingStar(fill: Self.fill(star: star, halves: halves ?? 0), size: size)
            }
        }
        .accessibilityElement()
        .accessibilityLabel(halves.map { "Rated \(Rating.text($0)) out of 10" } ?? "Not rated")
    }

    static func fill(star: Int, halves: Int) -> Double {
        let full = halves / 2
        if star <= full { return 1 }
        if star == full + 1, halves % 2 == 1 { return 0.5 }
        return 0
    }
}

/// Ten stars to rate with. Hovering shows what a click would give, down to half a star; clicking
/// the rating it already has clears it. Arrow keys move by half a star when it has focus.
struct StarRatingControl: View {
    var halves: Int?
    var size: CGFloat = 17
    var spacing: CGFloat = 3
    var showsValue = true
    var onChange: (Int?) -> Void
    @Environment(\.palette) private var palette
    @State private var hover: Int?
    @FocusState private var isFocused: Bool

    private var shown: Int { hover ?? halves ?? 0 }
    private var starWidth: CGFloat { size * 1.1 + spacing }

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: spacing) {
                ForEach(1...10, id: \.self) { star in
                    RatingStar(fill: StarRow.fill(star: star, halves: shown), size: size, emptyOpacity: hover == nil ? 1 : 0.8)
                        .scaleEffect(hover != nil && (shown + 1) / 2 == star ? 1.18 : 1)
                        .animation(.spring(response: 0.22, dampingFraction: 0.6), value: shown)
                }
            }
            .contentShape(Rectangle())
            .onContinuousHover { phase in
                switch phase {
                case .active(let point): hover = Self.halves(at: point.x, starWidth: starWidth)
                case .ended: hover = nil
                }
            }
            .gesture(SpatialTapGesture().onEnded { value in
                let picked = Self.halves(at: value.location.x, starWidth: starWidth)
                onChange(picked == halves ? nil : picked)
            })
            if showsValue {
                Text(shown > 0 ? Rating.text(shown) : "–")
                    .font(Typeface.bold(size * 0.95))
                    .foregroundStyle(shown > 0 ? AnyShapeStyle(palette.gold) : AnyShapeStyle(palette.ink3))
                    .frame(minWidth: size * 1.9, alignment: .leading)
                    .contentTransition(.numericText())
                    .animation(.snappy(duration: 0.18), value: shown)
            }
        }
        .focusable()
        .focused($isFocused)
        .focusEffectDisabled()
        .onKeyPress(.leftArrow) { onChange(max(1, (halves ?? 1) - 1)); return .handled }
        .onKeyPress(.rightArrow) { onChange(min(Rating.maxHalves, (halves ?? 0) + 1)); return .handled }
        .onKeyPress(.delete) { onChange(nil); return .handled }
        .accessibilityElement()
        .accessibilityLabel("Rating")
        .accessibilityValue(halves.map { "\(Rating.text($0)) out of 10" } ?? "Not rated")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: onChange(min(Rating.maxHalves, (halves ?? 0) + 1))
            case .decrement: onChange(max(1, (halves ?? 1) - 1))
            @unknown default: break
            }
        }
    }

    /// Left half of a star is a half, right half the whole star.
    static func halves(at x: CGFloat, starWidth: CGFloat) -> Int {
        Rating.clamp(Int((x / starWidth * 2).rounded(.up)))
    }
}

/// A small gold badge with the rating, for poster corners and rows.
struct RatingBadge: View {
    var halves: Int
    var compact = false
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: compact ? 2.5 : 3.5) {
            Image(systemName: "star.fill")
                .font(.system(size: compact ? 8 : 9.5, weight: .semibold))
                .foregroundStyle(palette.gold)
            Text(Rating.text(halves))
                .font(Typeface.time(compact ? 10 : 11.5, .bold))
                .foregroundStyle(.white)
        }
        .padding(.horizontal, compact ? 5 : 7)
        .padding(.vertical, compact ? 2 : 3)
        .background(.black.opacity(0.62), in: Capsule())
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(.white.opacity(0.14), lineWidth: 0.5))
        .environment(\.colorScheme, .dark)
        .accessibilityLabel("Rated \(Rating.text(halves)) out of 10")
    }
}

/// The rating control for a title in the library, saving as it changes.
struct StarRating: View {
    let title: Title
    var size: CGFloat = 15
    @Environment(AppModel.self) private var app

    var body: some View {
        StarRatingControl(halves: title.ratingHalves, size: size) { value in
            app.library.setRating(title.id, halves: value)
        }
    }
}
