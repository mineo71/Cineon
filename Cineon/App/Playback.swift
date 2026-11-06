import AppKit
import MediaPlayer

/// Whatever is playing: the native player when it's open, otherwise the tab with the video.
enum ActivePlayer {
    case local(LocalPlayback)
    case web(BrowserTab)

    var isPlaying: Bool {
        switch self {
        case .local(let playback): playback.isPlaying
        case .web(let tab): tab.media?.isPlaying == true
        }
    }

    var position: Double {
        switch self {
        case .local(let playback): playback.position
        case .web(let tab): tab.media?.position ?? 0
        }
    }

    var duration: Double {
        switch self {
        case .local(let playback): playback.duration
        case .web(let tab): tab.media?.duration ?? 0
        }
    }

    var rate: Double {
        switch self {
        case .local(let playback): Double(playback.player.rate == 0 ? 1 : playback.player.rate)
        case .web(let tab): tab.media?.rate ?? 1
        }
    }

    var titleID: Int64? {
        switch self {
        case .local(let playback): playback.downloadItem.titleID
        case .web(let tab): tab.track?.titleID ?? tab.linkedTitleID
        }
    }

    var ref: EpisodeRef? {
        switch self {
        case .local(let playback): return playback.downloadItem.ref.isEpisode ? playback.downloadItem.ref : nil
        case .web(let tab):
            let ref = tab.track?.ref ?? tab.parsed?.ref
            return ref?.isEpisode == true ? ref : nil
        }
    }

    /// A stable name for what's on, so a timer set for one episode knows when another starts.
    var identity: String {
        switch self {
        case .local(let playback): "local:\(playback.downloadID)"
        case .web(let tab): "web:\(tab.id):\(tab.track?.urlKey ?? tab.url?.absoluteString ?? "")"
        }
    }

    func toggle() {
        switch self {
        case .local(let playback): playback.togglePlayback()
        case .web(let tab): tab.togglePlayback()
        }
    }

    func play() {
        switch self {
        case .local(let playback): playback.play()
        case .web(let tab): tab.play()
        }
    }

    func pause() {
        switch self {
        case .local(let playback): playback.pause()
        case .web(let tab): tab.pausePlayback()
        }
    }

    func skip(by seconds: Double) {
        switch self {
        case .local(let playback): playback.skip(by: seconds)
        case .web(let tab): tab.skip(by: seconds)
        }
    }

    func seek(to seconds: Double) {
        switch self {
        case .local(let playback): playback.seek(to: seconds)
        case .web(let tab): tab.seek(to: seconds)
        }
    }

    func fadeOut(over seconds: Double) {
        switch self {
        case .local(let playback): playback.fadeOut(over: seconds)
        case .web(let tab): tab.fadeOut(over: seconds)
        }
    }

    func cancelFade() {
        switch self {
        case .local(let playback): playback.cancelFade()
        case .web(let tab): tab.cancelFade()
        }
    }
}

// MARK: Sleep timer

enum SleepTimerMode: Hashable {
    case minutes(Int)
    /// Stops when this film or episode ends, and nothing starts after it.
    case endOfItem

    var label: String {
        switch self {
        case .minutes(let minutes): minutes >= 60 && minutes % 60 == 0 ? "\(minutes / 60) h" : "\(minutes) min"
        case .endOfItem: "End of this"
        }
    }

    static let choices: [SleepTimerMode] = [.minutes(15), .minutes(30), .minutes(45), .minutes(60), .minutes(90), .endOfItem]
}

struct SleepTimerState: Equatable {
    var mode: SleepTimerMode
    var deadline: Date?
    /// What was playing when it was set, for "end of this".
    var item: String?
    var isFading = false

    /// Seconds of sound fading out before playback stops.
    static let fadeSeconds = 20.0

    func remaining(player: ActivePlayer?) -> Double? {
        switch mode {
        case .minutes: return deadline.map { $0.timeIntervalSinceNow }
        case .endOfItem:
            guard let player, player.duration > 0 else { return nil }
            return max(0, player.duration - player.position)
        }
    }
}

/// The native player's next episode, counting down before it starts.
struct UpNext: Equatable {
    var item: DownloadItem
    var startsAt: Date
}

// MARK: Now Playing and media keys

/// Puts what's playing in Control Center and answers the play/pause key, AirPods and headphones.
final class NowPlayingCenter {
    private weak var app: AppModel?
    private var artworkFor: URL?
    private var artwork: MPMediaItemArtwork?
    private var lastPublished: [String: String] = [:]
    #if DEBUG
    private(set) var handlers: [String: (Double) -> Void] = [:]
    #endif

    func install(app: AppModel) {
        self.app = app
        let center = MPRemoteCommandCenter.shared()
        register(center.togglePlayPauseCommand, "toggle") { app in app.togglePlayback() }
        register(center.playCommand, "play") { app in app.activePlayer?.play() }
        register(center.pauseCommand, "pause") { app in app.activePlayer?.pause() }
        register(center.nextTrackCommand, "next") { app in app.playNextEpisode() }
        center.skipForwardCommand.preferredIntervals = [10]
        center.skipBackwardCommand.preferredIntervals = [10]
        register(center.skipForwardCommand, "forward") { app in app.activePlayer?.skip(by: 10) }
        register(center.skipBackwardCommand, "back") { app in app.activePlayer?.skip(by: -10) }
        center.changePlaybackPositionCommand.isEnabled = true
        center.changePlaybackPositionCommand.addTarget { @Sendable [weak app] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            let time = event.positionTime
            Task { @MainActor in app?.activePlayer?.seek(to: time) }
            return .success
        }
        #if DEBUG
        handlers["seek"] = { [weak app] time in app?.activePlayer?.seek(to: time) }
        #endif
    }

    private func register(_ command: MPRemoteCommand, _ name: String, _ action: @escaping @MainActor @Sendable (AppModel) -> Void) {
        command.isEnabled = true
        command.addTarget { @Sendable [weak app = self.app] _ in
            Task { @MainActor in if let app { action(app) } }
            return .success
        }
        #if DEBUG
        handlers[name] = { [weak app = self.app] _ in if let app { action(app) } }
        #endif
    }

    /// Called about once a second with whatever is playing.
    func update(_ player: ActivePlayer?, library: LibraryStore) {
        let info = MPNowPlayingInfoCenter.default()
        guard let player, player.duration > 0 else {
            if !lastPublished.isEmpty {
                info.nowPlayingInfo = nil
                info.playbackState = .stopped
                lastPublished = [:]
            }
            return
        }
        let title = player.titleID.flatMap { library.titles[$0] }
        let name: String
        var detail: String?
        switch player {
        case .local(let playback):
            name = title?.name ?? playback.name
            detail = playback.badge.map { "\($0) · On this Mac" } ?? "On this Mac"
        case .web(let tab):
            name = title?.name ?? tab.parsed?.name ?? tab.displayTitle
            detail = [player.ref?.shortLabel, tab.url?.host.map(DomainName.displayName)].compactMap { $0 }.joined(separator: " · ")
        }
        var values: [String: Any] = [
            MPMediaItemPropertyTitle: name,
            MPMediaItemPropertyPlaybackDuration: player.duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: player.position,
            MPNowPlayingInfoPropertyPlaybackRate: player.isPlaying ? player.rate : 0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.video.rawValue,
        ]
        if let detail, !detail.isEmpty { values[MPMediaItemPropertyArtist] = detail }
        values[MPMediaItemPropertyAlbumTitle] = "Cineon"
        if let poster = title?.posterURL {
            if artworkFor != poster { loadArtwork(poster) }
            if let artwork { values[MPMediaItemPropertyArtwork] = artwork }
        }
        info.nowPlayingInfo = values
        info.playbackState = player.isPlaying ? .playing : .paused
        lastPublished = ["title": name, "detail": detail ?? "", "playing": player.isPlaying ? "1" : "0",
                         "position": String(Int(player.position)), "duration": String(Int(player.duration)),
                         "artwork": artwork == nil ? "0" : "1"]
    }

    var published: [String: String] { lastPublished }

    private func loadArtwork(_ url: URL) {
        artworkFor = url
        artwork = nil
        Task { [weak self] in
            guard let image = await ImagePipeline.shared.image(url, maxPixel: 600), self?.artworkFor == url else { return }
            let shared = SharedImage(image: image)
            self?.artwork = MPMediaItemArtwork(boundsSize: image.size) { @Sendable _ in shared.image }
        }
    }
}

/// Control Center asks for artwork from its own thread. The image never changes once made.
private nonisolated struct SharedImage: @unchecked Sendable {
    let image: NSImage
}
