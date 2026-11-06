import SwiftUI

/// The one orchestrated moment: the logo's film strip unspools around the C. It's drawn over the
/// app rather than before it, so everything underneath is already ready and launch never waits.
struct SplashView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var sweep = 0.0
    @State private var glint = false

    var body: some View {
        ZStack {
            palette.canvas.ignoresSafeArea()
            LogoMark(size: 170)
                .mask {
                    // Starts at the top end of the C and wipes round to the bottom end.
                    AngularGradient(
                        stops: [
                            .init(color: .black, location: 0),
                            .init(color: .black, location: sweep),
                            .init(color: .clear, location: min(1, sweep + 0.04)),
                        ],
                        center: .center,
                        angle: .degrees(-38)
                    )
                }
                .overlay {
                    // A single strip of light runs along the metal as it lands.
                    LinearGradient(
                        colors: [.clear, (palette.isDark ? Color.white : Color.black).opacity(0.75), .clear],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                    .frame(width: 70)
                    .offset(x: glint ? 130 : -130)
                    .blendMode(.overlay)
                    .mask(LogoMark(size: 170, color: .white))
                }
        }
        .allowsHitTesting(false)
        .task { await play() }
    }

    private func play() async {
        guard app.settings.launchAnimation, !reduceMotion else {
            app.splashVisible = false
            return
        }
        withAnimation(.easeInOut(duration: 0.42)) { sweep = 1 }
        try? await Task.sleep(for: .milliseconds(240))
        withAnimation(.easeInOut(duration: 0.34)) { glint = true }
        try? await Task.sleep(for: .milliseconds(300))
        withAnimation(.easeOut(duration: 0.22)) { app.splashVisible = false }
    }
}

/// Profile change: the reels swap in the dark, the way a projectionist changes over.
struct ReelChange: View {
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var angle = 0.0

    var body: some View {
        ZStack {
            palette.canvas.ignoresSafeArea()
            LogoMark(size: 92)
                .rotationEffect(.degrees(angle))
                .onAppear {
                    guard !reduceMotion else { return }
                    withAnimation(.easeInOut(duration: 0.75)) { angle = 360 }
                }
        }
        .allowsHitTesting(true)
    }
}
