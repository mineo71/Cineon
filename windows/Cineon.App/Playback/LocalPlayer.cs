using Cineon.App.UI;
using Cineon.Core.Data;

namespace Cineon.App.Playback;

/// Plays a downloaded file in the native player. A stand-in from Cineon/Downloads/LocalPlayback.swift
/// with only what AppModel uses; the player port owns this file and builds it on a MediaPlayer
/// (set `CommandManager.IsEnabled = false` on it, so NowPlayingCenter stays the one media session).
public sealed class LocalPlayback : Observable
{
    private readonly ProfileSession _session;

    private LocalPlayback(DownloadItem download, ProfileSession session)
    {
        _session = session;
        DownloadItem = download;
        DownloadId = download.Id;
        Name = download.Name;
        Badge = download.EpisodeBadge;
        Duration = download.Duration;
        Position = download.Position;
    }

    /// Null when the file is gone, like the Mac's failable init.
    // TODO(port-player): init?(download: DownloadItem, session: ProfileSession)
    public static LocalPlayback? Create(DownloadItem download, ProfileSession session) =>
        download.File is { } file && File.Exists(file) ? new LocalPlayback(download, session) : null;

    // TODO(port-player): let downloadID: Int64
    public long DownloadId { get; }

    // TODO(port-player): var downloadItem: DownloadItem
    public DownloadItem DownloadItem { get; }

    // TODO(port-player): let name: String
    public string Name { get; }

    // TODO(port-player): let badge: String?
    public string? Badge { get; }

    // TODO(port-player): private(set) var position = 0.0
    public double Position { get; private set; }

    // TODO(port-player): private(set) var duration = 0.0
    public double Duration { get; private set; }

    // TODO(port-player): private(set) var isPlaying = false
    public bool IsPlaying { get; private set; }

    /// The player's speed, 1 while paused. The Mac's `player.rate == 0 ? 1 : player.rate`.
    // TODO(port-player): MediaPlayer.PlaybackSession.PlaybackRate
    public double Rate => 1;

    /// Called once when the film or episode plays to its end.
    // TODO(port-player): var onEnded: (() -> Void)?
    public Action? OnEnded { get; set; }

    // TODO(port-player): func play()
    public void Play() { }

    // TODO(port-player): func pause()
    public void Pause() { }

    // TODO(port-player): func togglePlayback()
    public void TogglePlayback() { }

    // TODO(port-player): func seek(to seconds: Double)
    public void Seek(double seconds) { }

    // TODO(port-player): func skip(by seconds: Double)
    public void Skip(double seconds) { }

    /// Fades the sound out over this long, then pauses and puts the volume back.
    // TODO(port-player): func fadeOut(over seconds: Double)
    public void FadeOut(double seconds) { }

    // TODO(port-player): func cancelFade()
    public void CancelFade() { }

    // TODO(port-player): func stop()  (saves the place and ends the timeline session)
    public void Stop() { }

    // TODO(port-player): func applyCaptionStyle(_ style: CaptionStyle)
    public void ApplyCaptionStyle(CaptionStyle style) { }

    /// Six colour zones from the frame on screen, for ambient light.
    // TODO(port-player): func sampleZones() -> [RGB]?
    public IReadOnlyList<AmbientModel.Rgb>? SampleZones() => null;
}
