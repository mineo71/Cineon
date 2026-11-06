import AppKit
import AVKit
import SwiftUI
import UniformTypeIdentifiers

/// Everything you can do to what's playing, wherever it plays: the site's player or this Mac's.
struct PlayerControlsPanel: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let player = app.activePlayer {
                header(player)
                Divider().opacity(0.5)
                SleepTimerRow()
                if case .web(let tab) = player {
                    VoiceBoostRow(tab: tab)
                    SecondSubtitlesRow(tab: tab)
                    SpeedRow(rate: player.rate) { tab.setRate($0) }
                    Divider().opacity(0.5)
                    webActions(tab)
                } else if case .local(let playback) = player {
                    SpeedRow(rate: Double(playback.player.defaultRate == 0 ? 1 : playback.player.defaultRate)) { rate in
                        playback.player.defaultRate = Float(rate)
                        if playback.isPlaying { playback.player.rate = Float(rate) }
                    }
                }
            } else {
                Text("Nothing is playing")
                    .font(Typeface.ui(12.5))
                    .foregroundStyle(palette.ink3)
            }
        }
        .padding(16)
        .frame(width: 320)
    }

    private func header(_ player: ActivePlayer) -> some View {
        let title = player.titleID.flatMap { app.library.titles[$0] }
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 11) {
                RemoteImage(url: title?.posterURL, maxPixel: 160) { palette.raised2 }
                    .frame(width: 40, height: 60)
                    .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
                VStack(alignment: .leading, spacing: 4) {
                    Text(title?.name ?? "Now playing")
                        .font(Typeface.title(16))
                        .foregroundStyle(palette.ink)
                        .lineLimit(2)
                    if let ref = player.ref {
                        Text(ref.longLabel)
                            .font(Typeface.ui(11.5))
                            .foregroundStyle(palette.ink3)
                    }
                    if let title {
                        StarRating(title: title, size: 11)
                    }
                }
            }
            ProgressLine(fraction: player.duration > 0 ? player.position / player.duration : 0, height: 2)
            HStack(spacing: 0) {
                Text(Timecode.string(player.position))
                    .font(Typeface.time(10.5))
                    .foregroundStyle(palette.ink2)
                Text(" / " + Timecode.string(player.duration))
                    .font(Typeface.time(10.5))
                    .foregroundStyle(palette.ink3)
                Spacer(minLength: 0)
                IconButton(symbol: "gobackward.10", label: "Back 10 seconds", size: 11) { player.skip(by: -10) }
                IconButton(symbol: player.isPlaying ? "pause.fill" : "play.fill", label: player.isPlaying ? "Pause" : "Play", size: 12) {
                    player.toggle()
                }
                IconButton(symbol: "goforward.10", label: "Forward 10 seconds", size: 11) { player.skip(by: 10) }
                if player.ref != nil {
                    IconButton(symbol: "forward.end.fill", label: "Next episode", size: 10) { app.playNextEpisode() }
                }
            }
        }
    }

    @ViewBuilder private func webActions(_ tab: BrowserTab) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            ActionRow(symbol: "pip.enter", label: "Picture in Picture") { tab.togglePictureInPicture() }
            ActionRow(symbol: "rectangle.inset.filled", label: "Cinema mode") { app.browser.select(tab); app.toggleCinema() }
            ActionRow(symbol: "camera.viewfinder", label: "Save this moment") { app.session.frames.saveMoment(tab: tab) }
            ActionRow(symbol: "arrow.triangle.branch", label: "Find on another site") {
                app.browser.select(tab)
                app.session.rescue.findElsewhere(tab: tab)
            }
            Menu {
                Button("Fix title…") { app.browser.select(tab); app.sheet = .relink }
                Button("This isn't a film") { app.session.tracker.ignore(tab: tab) }
                Button("Don't track this site") {
                    app.session.tracker.stopTrackingSite(tab: tab)
                    app.toasts.show("\(DomainName.registrable(tab.url?.host ?? "This site")) won't appear on your timeline")
                }
            } label: {
                Label("Tracking", systemImage: "ellipsis.circle")
                    .font(Typeface.ui(12.5))
                    .foregroundStyle(palette.ink2)
            }
            .menuStyle(.button)
            .buttonStyle(HoverButtonStyle())
            .menuIndicator(.hidden)
            .fixedSize()
        }
    }
}

struct ActionRow: View {
    let symbol: String
    let label: String
    let action: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: action) {
            Label(label, systemImage: symbol)
                .font(Typeface.ui(12.5))
                .foregroundStyle(palette.ink2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(HoverButtonStyle())
    }
}

/// A row with a name on the left and its control on the right.
struct ControlRow<Control: View>: View {
    let symbol: String
    let label: String
    var note: String?
    @ViewBuilder var control: Control
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 12))
                .foregroundStyle(palette.ink3)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(Typeface.ui(12.5, .medium))
                    .foregroundStyle(palette.ink)
                if let note {
                    Text(note)
                        .font(Typeface.ui(11))
                        .foregroundStyle(palette.ink3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            control
        }
    }
}

struct SleepTimerRow: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        ControlRow(
            symbol: "moon.zzz",
            label: "Sleep timer",
            note: app.sleepTimer.map { timer in
                timer.mode == .endOfItem ? "Stops when this ends" : "Stops in \(Timecode.string(app.sleepTimerRemaining ?? 0))"
            }
        ) {
            Menu {
                ForEach(SleepTimerMode.choices, id: \.self) { mode in
                    Button(mode == .endOfItem ? "At the end of this" : mode.label) { app.startSleepTimer(mode) }
                }
                if app.sleepTimer != nil {
                    Divider()
                    Button("Turn off") { app.cancelSleepTimer() }
                }
            } label: {
                Text(app.sleepTimer?.mode.label ?? "Off")
                    .font(Typeface.ui(12, .medium))
                    .foregroundStyle(app.sleepTimer == nil ? palette.ink2 : palette.ink)
            }
            .menuStyle(.button)
            .fixedSize()
        }
    }
}

struct VoiceBoostRow: View {
    let tab: BrowserTab
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var app = app
        ControlRow(
            symbol: "waveform.and.person.filled",
            label: "Voice boost",
            note: app.settings.voiceBoost ? (tab.boostState.note ?? "Dialogue up, explosions down") : "Clearer dialogue at night"
        ) {
            Toggle("", isOn: $app.settings.voiceBoost)
                .toggleStyle(.switch)
                .controlSize(.mini)
                .labelsHidden()
        }
    }
}

struct SecondSubtitlesRow: View {
    let tab: BrowserTab
    @Environment(\.palette) private var palette

    var body: some View {
        ControlRow(
            symbol: "captions.bubble",
            label: "Second subtitles",
            note: tab.secondSubtitles == nil ? "A second language above the picture" : "Showing above the picture"
        ) {
            Menu {
                Button("Off") { tab.clearSecondSubtitles() }
                if !tab.subtitleChoices.isEmpty {
                    Section("From this player") {
                        ForEach(tab.subtitleChoices, id: \.url) { choice in
                            Button(choice.label) { Task { _ = await tab.showSecondSubtitles(from: choice.url) } }
                        }
                    }
                }
                Divider()
                Button("From a file…") {
                    guard let url = SubtitleFilePicker.pick(), let track = SubtitleTrack.load(path: url.path) else { return }
                    tab.showSecondSubtitles(track)
                }
            } label: {
                Text(tab.secondSubtitles?.label ?? "Off")
                    .font(Typeface.ui(12, .medium))
                    .foregroundStyle(tab.secondSubtitles == nil ? palette.ink2 : palette.ink)
                    .lineLimit(1)
                    .frame(maxWidth: 90)
            }
            .menuStyle(.button)
            .fixedSize()
        }
    }
}

struct SpeedRow: View {
    let rate: Double
    let set: (Double) -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        ControlRow(symbol: "gauge.with.dots.needle.50percent", label: "Speed") {
            Picker("", selection: Binding(get: { rate }, set: { value in set(value) })) {
                ForEach([0.75, 1, 1.25, 1.5, 2], id: \.self) { value in
                    Text(value == 1 ? "1×" : "\(value, specifier: "%g")×").tag(value)
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .fixedSize()
        }
    }
}

enum SubtitleFilePicker {
    static func pick() -> URL? {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [UTType(filenameExtension: "srt"), UTType(filenameExtension: "vtt")].compactMap { $0 }
        panel.allowsMultipleSelection = false
        panel.message = "Choose a subtitle file (.srt or .vtt)"
        return panel.runModal() == .OK ? panel.url : nil
    }
}

/// AirPlay to a TV or speakers, from the native player.
struct AirPlayButton: NSViewRepresentable {
    let player: AVPlayer

    func makeNSView(context: Context) -> AVRoutePickerView {
        let view = AVRoutePickerView()
        view.player = player
        view.isRoutePickerButtonBordered = false
        view.setRoutePickerButtonColor(.white, for: .normal)
        view.setRoutePickerButtonColor(.white, for: .active)
        return view
    }

    func updateNSView(_ view: AVRoutePickerView, context: Context) {
        if view.player !== player { view.player = player }
    }
}
