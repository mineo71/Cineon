import AppKit
import AVKit
import SwiftUI

/// Everything saved to this Mac, ready to watch without the site, its player or its ads.
struct DownloadsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        let downloads = app.session.downloads!
        VStack(alignment: .leading, spacing: 0) {
            header(downloads)
            if let job = app.session.seasons.job {
                SeasonJobCard(job: job)
                    .padding(.horizontal, 32)
                    .padding(.bottom, 16)
            }
            if downloads.items.isEmpty, app.session.seasons.job == nil {
                emptyState
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(downloads.items) { item in
                            DownloadRow(item: item)
                        }
                    }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 40)
                }
                .scrollIndicators(.never)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(palette.cardFill)
    }

    private func header(_ downloads: DownloadCenter) -> some View {
        let done = downloads.items.filter { $0.status == .done }
        let bytes = done.reduce(Int64(0)) { $0 + $1.bytes }
        return HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Downloads")
                    .font(Typeface.title(30))
                    .foregroundStyle(palette.ink)
                Text(done.isEmpty
                    ? "Saved to \(downloads.folder.path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))"
                    : "\(done.count) saved, \(ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)) in \(downloads.folder.path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))")
                    .font(Typeface.ui(12.5))
                    .foregroundStyle(palette.ink3)
            }
            Spacer()
            Button("Show in Finder") {
                try? FileManager.default.createDirectory(at: downloads.folder, withIntermediateDirectories: true)
                NSWorkspace.shared.open(downloads.folder)
            }
            .buttonStyle(OutlineButtonStyle())
        }
        .padding(.horizontal, 32)
        .padding(.top, 34)
        .padding(.bottom, 18)
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "arrow.down.circle")
                .font(.system(size: 40, weight: .thin))
                .foregroundStyle(palette.ink3)
            Text("Nothing downloaded yet")
                .font(Typeface.title(22))
                .foregroundStyle(palette.ink)
            Text("Start a film on any site, then press Download in the player's corner, or ⇧⌘S. Cineon saves the file the player streams, so it plays here without the site.")
                .font(Typeface.ui(13))
                .foregroundStyle(palette.ink2)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.bottom, 60)
    }
}

struct DownloadRow: View {
    let item: DownloadItem
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var isHovered = false

    private var downloads: DownloadCenter { app.session.downloads }
    private var title: Title? { item.titleID.flatMap { app.library.titles[$0] } }

    var body: some View {
        HStack(spacing: 16) {
            poster
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(item.name)
                        .font(Typeface.title(17))
                        .foregroundStyle(palette.ink)
                        .lineLimit(1)
                    if let badge = item.episodeBadge {
                        Text(badge)
                            .font(Typeface.time(11, .medium))
                            .foregroundStyle(palette.ink2)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(palette.raised2, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                    }
                }
                Text(detailLine)
                    .font(Typeface.ui(12))
                    .foregroundStyle(palette.ink3)
                    .lineLimit(1)
                status
            }
            Spacer(minLength: 12)
            actions
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(isHovered ? palette.raised : .clear)
        )
        .contentShape(Rectangle())
        .onHover { isHovered = $0 }
        .onTapGesture(count: 2) { if item.status == .done { app.playDownload(item) } }
        .contextMenu { menuItems }
        .animation(.easeOut(duration: 0.12), value: isHovered)
    }

    private var poster: some View {
        Color.clear
            .frame(width: 54, height: 81)
            .overlay {
                RemoteImage(url: title?.posterURL ?? item.posterURL ?? item.titleID.flatMap { app.library.bestFrameURL(titleID: $0) }, maxPixel: 200) {
                    PosterPlaceholder(name: item.name)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
    }

    private var detailLine: String {
        var parts = [DomainName.registrable(item.host)]
        if let quality = item.quality { parts.append(quality) }
        if item.kind == .hls { parts.append("stream") }
        if item.status == .done, item.bytes > 0 {
            parts.append(ByteCountFormatter.string(fromByteCount: item.bytes, countStyle: .file))
        }
        if item.duration > 0 { parts.append(Timecode.spoken(item.duration)) }
        if !item.subtitles.isEmpty { parts.append(item.subtitles.count == 1 ? "subtitles" : "\(item.subtitles.count) subtitles") }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder private var status: some View {
        switch item.status {
        case .queued, .downloading:
            let fraction = downloads.fraction(item)
            HStack(spacing: 10) {
                ProgressLine(fraction: fraction, height: 3)
                    .frame(maxWidth: 260)
                Text(progressText(fraction))
                    .font(Typeface.time(11.5))
                    .foregroundStyle(palette.ink2)
            }
            .padding(.top, 2)
        case .failed:
            Text(item.error ?? "Didn't finish")
                .font(Typeface.ui(12))
                .foregroundStyle(palette.ink2)
                .lineLimit(2)
        case .done:
            if item.position > 5, item.duration > 0 {
                HStack(spacing: 10) {
                    ProgressLine(fraction: item.watchedFraction, height: 2)
                        .frame(maxWidth: 160)
                    Text("\(Timecode.spoken(max(0, item.duration - item.position))) left")
                        .font(Typeface.ui(11.5))
                        .foregroundStyle(palette.ink3)
                }
                .padding(.top, 2)
            }
        }
    }

    private func progressText(_ fraction: Double) -> String {
        guard item.status == .downloading, fraction > 0 else { return "Starting…" }
        if item.totalBytes > 0 {
            let done = ByteCountFormatter.string(fromByteCount: item.bytes, countStyle: .file)
            let total = ByteCountFormatter.string(fromByteCount: item.totalBytes, countStyle: .file)
            return "\(Int(fraction * 100))%  \(done) of \(total)"
        }
        return "\(Int(fraction * 100))%"
    }

    @ViewBuilder private var actions: some View {
        HStack(spacing: 6) {
            switch item.status {
            case .done:
                Button {
                    app.playDownload(item)
                } label: {
                    Label(item.position > 5 ? "Resume at \(Timecode.string(item.position))" : "Play", systemImage: "play.fill")
                }
                .buttonStyle(SilverButtonStyle())
            case .failed:
                Button("Try again") { downloads.retry(item.id) }
                    .buttonStyle(OutlineButtonStyle())
            case .queued, .downloading:
                IconButton(symbol: "xmark", label: "Stop downloading") { downloads.cancel(item.id) }
            }
            Menu {
                menuItems
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(palette.ink2)
                    .frame(width: 26, height: 26)
                    .contentShape(Rectangle())
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .fixedSize()
            .accessibilityLabel("More")
        }
    }

    @ViewBuilder private var menuItems: some View {
        if item.status == .done {
            Button("Play") { app.playDownload(item) }
        }
        Button("Show in Finder") { downloads.showInFinder(item) }
        if let page = item.pageURL {
            Button("Open the Page") {
                app.browser.openTab(url: page, select: true)
                app.go(.web)
            }
        }
        if let title {
            Button("Details") { app.detailTitleID = title.id }
        }
        Divider()
        Button(item.status == .done ? "Move to Bin" : "Remove") { downloads.remove(item.id) }
    }
}

// MARK: Player

/// A downloaded film in the native player, filling the main card.
struct LocalPlayerView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var showsBar = true
    @State private var hideTask: Task<Void, Never>?

    var body: some View {
        if let playback = app.localPlayback {
            ZStack(alignment: .top) {
                Color.black
                PlayerSurface(playback: playback, style: app.settings.captionStyle)
                topBar(playback)
                    .opacity(showsBar ? 1 : 0)
                    .animation(.easeInOut(duration: 0.25), value: showsBar)
                if let upNext = app.upNext {
                    UpNextCard(upNext: upNext)
                        .padding(28)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                }
            }
            .animation(.spring(response: 0.4, dampingFraction: 0.85), value: app.upNext)
            .onDrop(of: [.fileURL], isTargeted: nil) { providers in
                // A subtitle file dropped on the film is added to it.
                guard let provider = providers.first else { return false }
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    guard let url, ["srt", "vtt"].contains(url.pathExtension.lowercased()) else { return }
                    Task { @MainActor in
                        if playback.addSubtitles(from: url) { app.toasts.show("Added \(url.lastPathComponent)") }
                    }
                }
                return true
            }
            .onContinuousHover { phase in
                if case .active = phase { wake() }
            }
            .onAppear(perform: wake)
        } else {
            Color.black.onAppear { app.go(.downloads) }
        }
    }

    private func wake() {
        showsBar = true
        hideTask?.cancel()
        hideTask = Task {
            try? await Task.sleep(for: .seconds(2.5))
            guard !Task.isCancelled else { return }
            showsBar = false
        }
    }

    private func topBar(_ playback: LocalPlayback) -> some View {
        HStack(spacing: 10) {
            Button {
                app.closePlayer()
            } label: {
                Label("Downloads", systemImage: "chevron.left")
                    .font(Typeface.ui(12.5, .medium))
            }
            .buttonStyle(HoverButtonStyle(padding: EdgeInsets(top: 5, leading: 8, bottom: 5, trailing: 10)))
            Text(playback.name)
                .font(Typeface.title(15))
                .lineLimit(1)
            if let badge = playback.badge {
                Text(badge).font(Typeface.time(11.5, .medium)).foregroundStyle(.white.opacity(0.62))
            }
            Spacer()
            if app.sleepTimer != nil {
                Label(Timecode.string(app.sleepTimerRemaining ?? 0), systemImage: "moon.fill")
                    .font(Typeface.time(11.5, .medium))
                    .foregroundStyle(.white.opacity(0.75))
            }
            Menu {
                ForEach(SleepTimerMode.choices, id: \.self) { mode in
                    Button(mode == .endOfItem ? "At the end of this" : mode.label) { app.startSleepTimer(mode) }
                }
                if app.sleepTimer != nil {
                    Divider()
                    Button("Turn off") { app.cancelSleepTimer() }
                }
            } label: {
                Image(systemName: app.sleepTimer == nil ? "moon.zzz" : "moon.zzz.fill")
                    .font(.system(size: 14))
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Sleep timer")
            AirPlayButton(player: playback.player)
                .frame(width: 26, height: 22)
                .help("AirPlay")
            Group {
                Menu {
                    Picker("Subtitles", selection: Binding(
                        get: { playback.selectedSubtitleID },
                        set: { playback.selectedSubtitleID = $0 }
                    )) {
                        Text("Off").tag(String?.none)
                        ForEach(playback.subtitleTracks) { track in
                            Text(track.label).tag(Optional(track.id))
                        }
                    }
                    .pickerStyle(.inline)
                    if playback.subtitleTracks.count > 1 {
                        Picker("Second line", selection: Binding(
                            get: { playback.secondSubtitleID },
                            set: { playback.secondSubtitleID = $0 }
                        )) {
                            Text("None").tag(String?.none)
                            ForEach(playback.subtitleTracks) { track in
                                Text(track.label).tag(Optional(track.id))
                            }
                        }
                        .pickerStyle(.inline)
                    }
                    Divider()
                    Button("Add Subtitles from File…") {
                        guard let url = SubtitleFilePicker.pick() else { return }
                        if !playback.addSubtitles(from: url) { app.toasts.show("That file has no subtitles Cineon can read") }
                    }
                } label: {
                    Image(systemName: playback.selectedSubtitleID == nil ? "captions.bubble" : "captions.bubble.fill")
                        .font(.system(size: 14))
                }
                .menuStyle(.button)
                .buttonStyle(.plain)
                .menuIndicator(.hidden)
                .fixedSize()
                .help("Subtitles")
            }
        }
        .foregroundStyle(.white)
        .environment(\.palette, .dark)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(
            LinearGradient(colors: [.black.opacity(0.6), .clear], startPoint: .top, endPoint: .bottom)
                .allowsHitTesting(false)
        )
    }
}

/// AVKit's player, with subtitle files drawn on its overlay so they follow it into fullscreen.
struct PlayerSurface: NSViewRepresentable {
    let playback: LocalPlayback
    let style: CaptionStyle

    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.player = playback.player
        view.controlsStyle = .floating
        view.allowsPictureInPicturePlayback = true
        view.showsFullScreenToggleButton = true
        view.videoGravity = .resizeAspect
        if let overlay = view.contentOverlayView {
            let host = NSHostingView(rootView: CaptionOverlay(playback: playback, style: style))
            host.frame = overlay.bounds
            host.autoresizingMask = [.width, .height]
            overlay.addSubview(host)
            context.coordinator.host = host
        }
        DispatchQueue.main.async { view.window?.makeFirstResponder(view) }
        return view
    }

    func updateNSView(_ view: AVPlayerView, context: Context) {
        if view.player !== playback.player { view.player = playback.player }
        context.coordinator.host?.rootView = CaptionOverlay(playback: playback, style: style)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var host: NSHostingView<CaptionOverlay>?
    }
}

struct CaptionOverlay: View {
    let playback: LocalPlayback
    let style: CaptionStyle

    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 6) {
                Spacer()
                if let second = playback.secondCaption {
                    let size = style.nativeSize * 0.82 * max(0.6, min(2.2, geometry.size.height / 720))
                    Text(second)
                        .font(.system(size: size, weight: .medium))
                        .foregroundStyle(Color(red: 1, green: 0.91, blue: 0.66))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 3)
                        .background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                        .padding(.horizontal, 40)
                        .padding(.bottom, playback.caption == nil ? geometry.size.height * 0.09 : 0)
                }
                if let caption = playback.caption {
                    // Scales with the picture, so fullscreen captions aren't tiny.
                    let size = style.nativeSize * max(0.6, min(2.2, geometry.size.height / 720))
                    Text(caption)
                        .font(.system(size: size, weight: .medium))
                        .foregroundStyle(.white)
                        .multilineTextAlignment(.center)
                        .shadow(color: .black.opacity(style == .site ? 0.9 : 0), radius: 2, y: 1)
                        .padding(.horizontal, style == .site ? 0 : 10)
                        .padding(.vertical, style == .site ? 0 : 4)
                        .background(style == .site ? .clear : .black.opacity(0.72), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                        .padding(.horizontal, 40)
                        .padding(.bottom, geometry.size.height * 0.09)
                }
            }
            .frame(maxWidth: .infinity)
        }
        .allowsHitTesting(false)
    }
}

/// A season being fetched: which episode the helper is on, and what's queued.
struct SeasonJobCard: View {
    let job: SeasonGrabber.Job
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 14) {
            if job.isFinished {
                Image(systemName: job.missed.isEmpty ? "checkmark.circle" : "exclamationmark.circle")
                    .font(.system(size: 18))
                    .foregroundStyle(palette.ink2)
            } else if job.isPaused {
                Image(systemName: "pause.circle")
                    .font(.system(size: 18))
                    .foregroundStyle(palette.ink2)
            } else {
                ProgressView().controlSize(.small)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(heading)
                    .font(Typeface.title(15))
                    .foregroundStyle(palette.ink)
                Text(detail)
                    .font(Typeface.ui(12))
                    .foregroundStyle(palette.ink3)
                    .lineLimit(2)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 5) {
                ProgressLine(fraction: job.episodes.isEmpty ? 0 : Double(job.handled) / Double(job.episodes.count), height: 3)
                    .frame(width: 140)
                Text("\(job.handled) of \(job.episodes.count)")
                    .font(Typeface.time(10.5))
                    .foregroundStyle(palette.ink3)
            }
            if job.isPaused {
                Button("Carry on") { app.session.seasons.resume() }
                    .buttonStyle(SilverButtonStyle())
            }
            Button(job.isFinished ? "Dismiss" : "Stop") {
                if job.isFinished { app.session.seasons.dismiss() } else { app.session.seasons.cancel() }
            }
            .buttonStyle(OutlineButtonStyle())
        }
        .padding(14)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var heading: String {
        if job.isFinished { return "\(job.label): \(job.queued.count) of \(job.episodes.count) queued" }
        if job.isPaused { return "\(job.label), paused" }
        return "Getting \(job.label)"
    }

    private var detail: String {
        if job.isPaused { return "Stopped when Cineon closed, with \(job.remaining.count) episodes to go. Carry on picks up where it left off." }
        if let current = job.current { return "Opening \(current.shortLabel) to find its file. Two download at a time, the rest wait their turn." }
        if !job.missed.isEmpty { return "Couldn't find the file for \(job.missed.map(\.shortLabel).joined(separator: ", ")). Open those episodes and download them by hand." }
        return "Each episode's link is fetched right before its turn, so none expire while waiting."
    }
}

/// The next downloaded episode, counting down in the corner of the player.
struct UpNextCard: View {
    let upNext: UpNext
    @Environment(AppModel.self) private var app

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.5)) { context in
            let left = max(0, Int(upNext.startsAt.timeIntervalSince(context.date).rounded(.up)))
            HStack(spacing: 14) {
                RemoteImage(url: upNext.item.posterURL, maxPixel: 160) { Color.white.opacity(0.1) }
                    .frame(width: 40, height: 60)
                    .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text("Up next")
                        .font(Typeface.ui(11.5))
                        .foregroundStyle(.white.opacity(0.6))
                    Text(upNext.item.episodeBadge ?? upNext.item.name)
                        .font(Typeface.title(16))
                        .foregroundStyle(.white)
                    Text("Starts in \(left) s")
                        .font(Typeface.time(11.5))
                        .foregroundStyle(.white.opacity(0.6))
                }
                VStack(spacing: 6) {
                    Button("Play now") { app.playUpNext() }
                        .buttonStyle(SilverButtonStyle())
                    Button("Not now") { app.cancelUpNext() }
                        .buttonStyle(HoverButtonStyle())
                        .foregroundStyle(.white.opacity(0.7))
                }
            }
            .padding(14)
            .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .environment(\.colorScheme, .dark)
            .environment(\.palette, .dark)
        }
    }
}
