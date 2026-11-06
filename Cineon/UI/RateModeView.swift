import SwiftUI

/// Rates everything you've watched, one poster at a time, as fast as you can press keys.
/// Unrated films come first, most recently watched first. Every rating saves as it's given.
struct RateModeView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var queue: [Int64] = []
    @State private var index = 0
    @State private var includeRated = false
    @State private var rated = 0
    @State private var advance: Task<Void, Never>?
    @FocusState private var focused: Bool

    private var current: Title? {
        queue.indices.contains(index) ? app.library.titles[queue[index]] : nil
    }

    var body: some View {
        ZStack {
            if let title = current {
                card(title)
                    .id(title.id)
                    .transition(.asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity), removal: .move(edge: .leading).combined(with: .opacity)))
            } else {
                finished
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background {
            // Behind, not beside: a poster filling the page mustn't push the card around.
            if let title = current { backdrop(title) }
        }
        .background(palette.canvas)
        .clipped()
        .focusable()
        .focused($focused)
        .focusEffectDisabled()
        .onAppear {
            buildQueue()
            focused = true
        }
        .onKeyPress(.escape) { app.go(.library); return .handled }
        .onKeyPress(.return) { next(); return .handled }
        .onKeyPress(.space) { next(); return .handled }
        .onKeyPress(.leftArrow) { nudge(-1); return .handled }
        .onKeyPress(.rightArrow) { nudge(1); return .handled }
        .onKeyPress(.delete) { set(nil, andMove: false); return .handled }
        .onKeyPress(characters: .decimalDigits) { press in
            guard let digit = Int(press.characters) else { return .ignored }
            set((digit == 0 ? 10 : digit) * 2, andMove: true)
            return .handled
        }
    }

    // MARK: Queue

    private func buildQueue() {
        let candidates = app.library.titles.values.filter { title in
            (title.status == .watched || (title.status == .watching && title.kind == .series)) && (includeRated || title.ratingHalves == nil)
        }
        queue = candidates
            .sorted { ($0.finishedAt ?? $0.lastWatchedAt ?? $0.addedAt) > ($1.finishedAt ?? $1.lastWatchedAt ?? $1.addedAt) }
            .map(\.id)
        index = 0
        rated = 0
    }

    private func set(_ halves: Int?, andMove: Bool) {
        guard let title = current else { return }
        app.library.setRating(title.id, halves: halves)
        if halves != nil { rated += 1 }
        guard andMove else { return }
        advance?.cancel()
        advance = Task {
            try? await Task.sleep(for: .milliseconds(380))
            guard !Task.isCancelled else { return }
            next()
        }
    }

    private func nudge(_ step: Int) {
        guard let title = current else { return }
        let value = Rating.clamp((title.ratingHalves ?? 10) + step)
        app.library.setRating(title.id, halves: value)
    }

    private func next() {
        advance?.cancel()
        withAnimation(.spring(response: 0.42, dampingFraction: 0.86)) { index += 1 }
    }

    private func previous() {
        advance?.cancel()
        guard index > 0 else { return }
        withAnimation(.spring(response: 0.42, dampingFraction: 0.86)) { index -= 1 }
    }

    // MARK: Pieces

    private func backdrop(_ title: Title) -> some View {
        RemoteImage(url: title.backdropURL ?? title.posterURL, maxPixel: 900) { palette.canvas }
            .aspectRatio(contentMode: .fill)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .blur(radius: 60)
            .saturation(1.3)
            .opacity(0.42)
            .overlay(LinearGradient(colors: [palette.canvas.opacity(0.2), palette.canvas.opacity(0.92)], startPoint: .top, endPoint: .bottom))
            .clipped()
            .ignoresSafeArea()
            .animation(.easeInOut(duration: 0.5), value: title.id)
            .accessibilityHidden(true)
    }

    private func card(_ title: Title) -> some View {
        VStack(spacing: 0) {
            header
            Spacer(minLength: 20)
            HStack(alignment: .center, spacing: 46) {
                PosterImage(title: title, width: 230, cornerRadius: 10, keepsColour: true)
                    .shadow(color: .black.opacity(0.55), radius: 30, y: 16)
                VStack(alignment: .leading, spacing: 14) {
                    Text(title.name)
                        .font(Typeface.title(42))
                        .foregroundStyle(palette.ink)
                        .lineLimit(3)
                        .minimumScaleFactor(0.6)
                    Text(detail(title))
                        .font(Typeface.ui(14))
                        .foregroundStyle(palette.ink2)
                    StarRatingControl(halves: title.ratingHalves, size: 30, spacing: 5) { value in
                        set(value, andMove: value != nil)
                    }
                    .padding(.top, 18)
                    Text("Click a star, or press 1 to 0. Arrows add or take away half a star.")
                        .font(Typeface.ui(12))
                        .foregroundStyle(palette.ink3)
                    HStack(spacing: 10) {
                        Button("Skip") { next() }
                            .buttonStyle(OutlineButtonStyle())
                            .keyboardShortcut(.space, modifiers: [])
                        if index > 0 {
                            Button("Back") { previous() }
                                .buttonStyle(HoverButtonStyle())
                                .foregroundStyle(palette.ink2)
                        }
                        if title.ratingHalves != nil {
                            Button("Next") { next() }
                                .buttonStyle(SilverButtonStyle())
                        }
                    }
                    .padding(.top, 8)
                }
                .frame(maxWidth: 560, alignment: .leading)
            }
            .padding(.horizontal, 60)
            Spacer(minLength: 20)
            upcoming
        }
        .padding(.vertical, 30)
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("Rate your films")
                .font(Typeface.title(22))
                .foregroundStyle(palette.ink)
            Text("\(min(index + 1, queue.count)) of \(queue.count)")
                .font(Typeface.time(13))
                .foregroundStyle(palette.ink3)
                .padding(.leading, 6)
            Spacer()
            Toggle("Include rated ones", isOn: $includeRated)
                .toggleStyle(.switch)
                .controlSize(.mini)
                .font(Typeface.ui(12))
                .foregroundStyle(palette.ink2)
                .onChange(of: includeRated) { buildQueue() }
            Button("Done") { app.go(.library) }
                .buttonStyle(OutlineButtonStyle())
                .padding(.leading, 12)
        }
        .padding(.horizontal, 40)
        .overlay(alignment: .bottom) {
            GeometryReader { geometry in
                Capsule().fill(palette.raised2)
                    .overlay(alignment: .leading) {
                        Capsule().fill(palette.gold)
                            .frame(width: geometry.size.width * (queue.isEmpty ? 0 : Double(index) / Double(queue.count)))
                    }
            }
            .frame(height: 2)
            .padding(.horizontal, 40)
            .offset(y: 14)
        }
    }

    /// The next few posters, so the end is always in sight.
    private var upcoming: some View {
        HStack(spacing: 10) {
            ForEach(Array(queue.dropFirst(index + 1).prefix(8)), id: \.self) { id in
                if let title = app.library.titles[id] {
                    PosterImage(title: title, width: 46, cornerRadius: 4)
                        .opacity(0.55)
                }
            }
        }
        .frame(height: 70)
    }

    private var finished: some View {
        VStack(spacing: 16) {
            PixelPetView(pet: app.session.pet, size: 120)
            Text(queue.isEmpty ? "Nothing left to rate" : "That's all of them")
                .font(Typeface.title(30))
                .foregroundStyle(palette.ink)
            Text(rated > 0 ? "You rated \(rated) \(rated == 1 ? "film" : "films") just now. They're saved, in the cloud too." : "Everything you've watched has its stars.")
                .font(Typeface.ui(14))
                .foregroundStyle(palette.ink2)
            HStack(spacing: 10) {
                Button("Go over rated ones") {
                    includeRated = true
                    buildQueue()
                }
                .buttonStyle(OutlineButtonStyle())
                Button("See your library") { app.go(.library) }
                    .buttonStyle(SilverButtonStyle())
            }
            .padding(.top, 6)
        }
    }

    private func detail(_ title: Title) -> String {
        var parts: [String] = []
        if let year = title.year { parts.append(String(year)) }
        parts.append(title.kind.label)
        if !title.genres.isEmpty { parts.append(title.genres.prefix(3).joined(separator: ", ")) }
        return parts.joined(separator: "   ")
    }
}
