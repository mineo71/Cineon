import AVFoundation
import AVKit
import Foundation
import Observation
import VideoToolbox

/// Plays a downloaded file in the native player. Keeps its place, puts the session on the timeline
/// like any other, and hands real frames to ambient light.
@Observable
final class LocalPlayback {
    let downloadID: Int64
    let player: AVPlayer
    let name: String
    let badge: String?
    private(set) var position = 0.0
    private(set) var duration = 0.0
    private(set) var isPlaying = false
    private(set) var caption: String?
    /// A second line, in another language, shown above the first.
    private(set) var secondCaption: String?
    private(set) var subtitleTracks: [SubtitleTrack] = []
    var selectedSubtitleID: String? {
        didSet { updateCaption() }
    }
    var secondSubtitleID: String? {
        didSet { updateCaption() }
    }
    /// Reached the end of the file.
    private(set) var didEnd = false
    /// Called once when the film or episode plays to its end.
    @ObservationIgnored var onEnded: (() -> Void)?
    var downloadItem: DownloadItem { item }

    @ObservationIgnored private unowned let session: ProfileSession
    @ObservationIgnored private let item: DownloadItem
    @ObservationIgnored private let output: AVPlayerItemVideoOutput
    @ObservationIgnored private var timeObserver: Any?
    @ObservationIgnored private var rateObservation: NSKeyValueObservation?
    @ObservationIgnored private var lastSave = Date.distantPast
    @ObservationIgnored private var watchSession: WatchSession?
    @ObservationIgnored private var watchedSeconds = 0.0
    @ObservationIgnored private var lastTick: (time: Double, at: Date)?
    @ObservationIgnored private var startedTitle = false
    @ObservationIgnored private var endObserver: (any NSObjectProtocol)?
    @ObservationIgnored private var fadeTimer: Timer?
    @ObservationIgnored private var fadeVolume: Float?

    init?(download: DownloadItem, session: ProfileSession) {
        guard let url = download.fileURL, FileManager.default.fileExists(atPath: url.path) else { return nil }
        self.session = session
        item = download
        downloadID = download.id
        name = download.name
        badge = download.episodeBadge
        let playerItem = AVPlayerItem(url: url)
        // Small frames are all ambient light needs, and scaling here costs nothing.
        output = AVPlayerItemVideoOutput(pixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: 48,
            kCVPixelBufferHeightKey as String: 27,
        ])
        playerItem.add(output)
        player = AVPlayer(playerItem: playerItem)
        duration = download.duration
        applyCaptionStyle(session.settings.captionStyle)

        subtitleTracks = download.subtitles.compactMap(SubtitleTrack.load(path:))
        selectedSubtitleID = subtitleTracks.first?.id

        let start = download.position
        if start > 5, download.duration <= 0 || start < download.duration - 30 {
            player.seek(to: CMTime(seconds: start, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
            position = start
        }

        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self] time in
            MainActor.assumeIsolated { self?.tick(time.seconds) }
        }
        rateObservation = player.observe(\.timeControlStatus, options: [.new]) { [weak self] player, _ in
            MainActor.assumeIsolated { self?.isPlaying = player.timeControlStatus == .playing }
        }
        player.allowsExternalPlayback = true
        endObserver = NotificationCenter.default.addObserver(
            forName: AVPlayerItem.didPlayToEndTimeNotification, object: playerItem, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.reachedEnd() }
        }
        player.play()
    }

    private func reachedEnd() {
        guard !didEnd else { return }
        didEnd = true
        save(force: true)
        onEnded?()
    }

    // MARK: Commands

    func play() { player.play() }
    func pause() { player.pause() }

    func seek(to seconds: Double) {
        player.seek(to: CMTime(seconds: max(0, seconds), preferredTimescale: 600))
        if seconds < duration - 2 { didEnd = false }
    }

    /// Fades the sound out over this long, pauses, and puts the volume back for next time.
    func fadeOut(over seconds: Double) {
        cancelFade()
        let start = Date.now
        let span = max(0.5, seconds)
        let volume = player.volume
        fadeVolume = volume
        fadeTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                let left = 1 - Date.now.timeIntervalSince(start) / span
                if left <= 0 {
                    self.player.pause()
                    self.cancelFade()
                } else {
                    self.player.volume = volume * Float(left * left)
                }
            }
        }
    }

    func cancelFade() {
        fadeTimer?.invalidate()
        fadeTimer = nil
        if let fadeVolume { player.volume = fadeVolume }
        fadeVolume = nil
    }

    var isFading: Bool { fadeTimer != nil }

    /// Adds a subtitle file someone picked, keeps a copy next to the film, and shows it.
    func addSubtitles(from file: URL) -> Bool {
        guard let path = session.downloads.addSubtitles(file, to: downloadID), let track = SubtitleTrack.load(path: path) else { return false }
        subtitleTracks.append(track)
        if selectedSubtitleID == nil { selectedSubtitleID = track.id } else { secondSubtitleID = track.id }
        return true
    }

    func applyCaptionStyle(_ style: CaptionStyle) {
        guard let current = player.currentItem else { return }
        guard style != .site else {
            current.textStyleRules = nil
            return
        }
        let percent = style == .huge ? 175 : 135
        current.textStyleRules = AVTextStyleRule(textMarkupAttributes: [
            kCMTextMarkupAttribute_RelativeFontSize as String: percent,
            kCMTextMarkupAttribute_CharacterBackgroundColorARGB as String: [0.72, 0, 0, 0],
            kCMTextMarkupAttribute_ForegroundColorARGB as String: [1, 1, 1, 1],
        ]).map { [$0] }
    }

    func togglePlayback() {
        if player.timeControlStatus == .playing { player.pause() } else { player.play() }
    }

    func skip(by seconds: Double) {
        let target = max(0, position + seconds)
        player.seek(to: CMTime(seconds: target, preferredTimescale: 600))
    }

    /// Six colour zones from the frame on screen, for ambient light.
    func sampleZones() -> [RGB]? {
        let time = output.itemTime(forHostTime: CACurrentMediaTime())
        guard isPlaying, let buffer = output.copyPixelBuffer(forItemTime: time, itemTimeForDisplay: nil) else { return nil }
        var image: CGImage?
        VTCreateCGImageFromCVPixelBuffer(buffer, options: nil, imageOut: &image)
        return image.flatMap(ColorZones.sample)
    }

    func stop() {
        cancelFade()
        save(force: true)
        player.pause()
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
        if let timeObserver { player.removeTimeObserver(timeObserver) }
        timeObserver = nil
        rateObservation = nil
    }

    // MARK: Progress

    private func tick(_ seconds: Double) {
        guard seconds.isFinite else { return }
        position = seconds
        if let itemDuration = player.currentItem?.duration.seconds, itemDuration.isFinite, itemDuration > 0 {
            duration = itemDuration
        }
        if isPlaying, let last = lastTick {
            let step = seconds - last.time
            // Only time that actually played counts, not a jump.
            if step > 0, step < 2 { watchedSeconds += step }
        }
        lastTick = (seconds, .now)
        updateCaption()
        if Date.now.timeIntervalSince(lastSave) > 5 { save(force: false) }
    }

    private func updateCaption() {
        let track = subtitleTracks.first { $0.id == selectedSubtitleID }
        let text = track?.text(at: position)
        if text != caption { caption = text }
        let second = secondSubtitleID == selectedSubtitleID ? nil : subtitleTracks.first { $0.id == secondSubtitleID }
        let secondText = second?.text(at: position)
        if secondText != secondCaption { secondCaption = secondText }
    }

    private func save(force: Bool) {
        guard force || isPlaying else { return }
        lastSave = .now
        session.downloads.notePlayback(downloadID, position: position, duration: duration)
        guard let titleID = item.titleID, session.library.titles[titleID] != nil, let url = item.fileURL,
              duration > 0, watchedSeconds >= session.settings.minimumSecondsToTrack
        else { return }
        let library = session.library
        if !startedTitle {
            startedTitle = true
            library.recordWatchStart(titleID: titleID)
        }
        let finished = position / duration >= session.settings.finishThreshold
        library.saveProgress(WatchProgress(
            titleID: titleID, ref: item.ref, urlKey: URLKey.make(url), url: url, host: Self.host,
            position: position, duration: duration, finished: finished, updatedAt: .now
        ))
        var entry = watchSession ?? WatchSession(
            id: 0, titleID: titleID, ref: item.ref, episodeName: nil, url: url, host: Self.host,
            startedAt: Date.now.addingTimeInterval(-watchedSeconds), endedAt: .now, watchedSeconds: 0,
            startPosition: max(0, position - watchedSeconds), endPosition: position, duration: duration, finished: false
        )
        entry.endedAt = .now
        entry.watchedSeconds = watchedSeconds
        entry.endPosition = position
        entry.duration = duration
        entry.finished = entry.finished || finished
        watchSession = library.saveSession(entry)
        if finished, !item.ref.isEpisode, library.titles[titleID]?.status != .watched {
            library.setStatus(titleID, .watched)
        }
    }

    /// What the timeline shows as the site for films watched from a download.
    static let host = "This Mac"
}
