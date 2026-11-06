using Cineon.App.UI;
using Cineon.Core.Data;
using Cineon.Core.Downloads;
using Microsoft.UI.Dispatching;
using Windows.Graphics.Imaging;
using Windows.Media.Editing;
using Windows.Media.Playback;
using Windows.Storage;

namespace Cineon.App.Playback;

/// Plays a downloaded file in the native player. Keeps its place, puts the session on the timeline
/// like any other, and hands real frames to ambient light. Ported from
/// Cineon/Downloads/LocalPlayback.swift, on a MediaPlayer instead of an AVPlayer.
///
/// Lives on the UI thread. The MediaPlayer raises its events on other threads; each is queued back
/// here. Its own media session is off (`CommandManager.IsEnabled = false`), so NowPlayingCenter
/// stays the one that answers the media keys and the flyout, whatever plays.
public sealed class LocalPlayback : Observable
{
    /// What the timeline shows as the site for films watched from a download. The Mac says "This Mac".
    public const string Host = "This PC";

    public long DownloadId { get; }
    public MediaPlayer Player { get; }
    public string Name { get; }
    public string? Badge { get; }
    public double Position { get; private set; }
    public double Duration { get; private set; }
    public bool IsPlaying { get; private set; }

    /// The line on screen from the chosen subtitles.
    public string? Caption { get; private set; }

    /// A second line, in another language, shown above the first.
    public string? SecondCaption { get; private set; }

    /// How the native player's captions are drawn (`Settings.CaptionStyle`).
    public CaptionStyle CaptionStyle { get; private set; }

    /// Raised when `Caption`, `SecondCaption` or `CaptionStyle` change: up to four times a second,
    /// so only the caption overlay listens. `Changed` covers everything else.
    public event Action? CaptionChanged;

    public IReadOnlyList<SubtitleTrack> SubtitleTracks => _tracks;

    public string? SelectedSubtitleId
    {
        get => _selectedSubtitleId;
        set
        {
            if (_selectedSubtitleId == value) return;
            _selectedSubtitleId = value;
            UpdateCaption();
            Notify();
        }
    }

    public string? SecondSubtitleId
    {
        get => _secondSubtitleId;
        set
        {
            if (_secondSubtitleId == value) return;
            _secondSubtitleId = value;
            UpdateCaption();
            Notify();
        }
    }

    /// Reached the end of the file.
    public bool DidEnd { get; private set; }

    /// Called once when the film or episode plays to its end.
    public Action? OnEnded { get; set; }

    public DownloadItem DownloadItem => _item;

    /// The player's speed. A paused MediaPlayer keeps its rate, where the Mac's AVPlayer reads 0.
    public double Rate => Player.PlaybackSession.PlaybackRate is > 0 and var rate ? rate : 1;

    public bool IsFading => _fadeTimer is not null;

    private readonly ProfileSession _session;
    private readonly DownloadItem _item;
    private readonly string _file;
    private readonly DispatcherQueue _queue;
    private readonly DispatcherQueueTimer _ticker;
    private readonly List<SubtitleTrack> _tracks;
    private string? _selectedSubtitleId;
    private string? _secondSubtitleId;
    private DateTimeOffset _lastSave = DateTimeOffset.MinValue;
    private WatchSession? _watchSession;
    private double _watchedSeconds;
    private double? _lastTick;
    private bool _startedTitle;
    private DispatcherQueueTimer? _fadeTimer;
    private double? _fadeVolume;
    private bool _isStopped;
    private bool _isShown;

    // Frames for ambient light, read beside the player (see SampleZones).
    private MediaComposition? _frames;
    private bool _isSampling;
    private int _sampleFailures;
    private IReadOnlyList<AmbientModel.Rgb>? _zones;

    private LocalPlayback(DownloadItem download, ProfileSession session, string file, DispatcherQueue queue)
    {
        _session = session;
        _item = download;
        _file = file;
        _queue = queue;
        DownloadId = download.Id;
        Name = download.Name;
        Badge = download.EpisodeBadge;
        Duration = download.Duration;

        _tracks = [.. download.Subtitles.Select(SubtitleTrack.Load).OfType<SubtitleTrack>()];
        _selectedSubtitleId = _tracks.FirstOrDefault()?.Id;
        CaptionStyle = session.Settings.CaptionStyle;

        // Carries on where it stopped, unless that was the very end.
        var start = download.Position;
        var resumes = start > 5 && (download.Duration <= 0 || start < download.Duration - 30);
        if (resumes) Position = start;

        var source = Windows.Media.Core.MediaSource.CreateFromUri(new Uri(Path.GetFullPath(file)));
        var item = resumes ? new MediaPlaybackItem(source, TimeSpan.FromSeconds(start)) : new MediaPlaybackItem(source);
        Player = new MediaPlayer
        {
            AutoPlay = false,
            AudioCategory = MediaPlayerAudioCategory.Movie,
        };
        // The app's NowPlayingCenter owns the media keys and the Windows media flyout.
        Player.CommandManager.IsEnabled = false;
        Player.Source = item;

        Player.MediaEnded += OnMediaEnded;
        Player.MediaFailed += OnMediaFailed;
        Player.PlaybackSession.PlaybackStateChanged += OnPlaybackStateChanged;

        _ticker = queue.CreateTimer();
        _ticker.Interval = TimeSpan.FromSeconds(0.25);
        _ticker.Tick += (_, _) => Tick();
        _ticker.Start();

        Player.Play();
    }

    /// Null when the file is gone, like the Mac's failable init.
    public static LocalPlayback? Create(DownloadItem download, ProfileSession session)
    {
        if (download.File is not { } file || !File.Exists(file)) return null;
        if (DispatcherQueue.GetForCurrentThread() is not { } queue) return null;
        return new LocalPlayback(download, session, file, queue);
    }

    // MARK: MediaPlayer events (other threads)

    private void OnMediaEnded(MediaPlayer sender, object args) => _queue.TryEnqueue(ReachedEnd);

    private void OnMediaFailed(MediaPlayer sender, MediaPlayerFailedEventArgs args)
    {
        var message = args.ErrorMessage;
        _queue.TryEnqueue(() =>
        {
            if (_isStopped) return;
            // AVPlayerView shows a crossed-out play symbol; MediaPlayerElement shows nothing.
            _session.Toasts.Show(string.IsNullOrWhiteSpace(message) ? $"Couldn't play {_item.FileBaseName}" : $"Couldn't play {_item.FileBaseName}: {message}");
        });
    }

    private void OnPlaybackStateChanged(MediaPlaybackSession sender, object args)
    {
        var playing = sender.PlaybackState == MediaPlaybackState.Playing;
        _queue.TryEnqueue(() =>
        {
            if (_isStopped || IsPlaying == playing) return;
            IsPlaying = playing;
            Notify();
        });
    }

    private void ReachedEnd()
    {
        if (DidEnd || _isStopped) return;
        DidEnd = true;
        Tick();
        Save(force: true);
        Notify();
        OnEnded?.Invoke();
    }

    // MARK: Commands

    public void Play()
    {
        if (!_isStopped) Player.Play();
    }

    public void Pause()
    {
        if (!_isStopped) Player.Pause();
    }

    public void TogglePlayback()
    {
        if (_isStopped) return;
        if (Player.PlaybackSession.PlaybackState == MediaPlaybackState.Playing) Player.Pause();
        else Player.Play();
    }

    public void Seek(double seconds)
    {
        if (_isStopped) return;
        Player.PlaybackSession.Position = TimeSpan.FromSeconds(Math.Max(0, seconds));
        if (seconds < Duration - 2) DidEnd = false;
    }

    public void Skip(double seconds)
    {
        if (_isStopped) return;
        var target = Math.Max(0, Position + seconds);
        Player.PlaybackSession.Position = TimeSpan.FromSeconds(target);
        Position = target;
        if (target < Duration - 2) DidEnd = false;
    }

    /// Fades the sound out over this long, pauses, and puts the volume back for next time.
    public void FadeOut(double seconds)
    {
        CancelFade();
        if (_isStopped) return;
        var start = DateTimeOffset.Now;
        var span = Math.Max(0.5, seconds);
        var volume = Player.Volume;
        _fadeVolume = volume;
        var timer = _queue.CreateTimer();
        timer.Interval = TimeSpan.FromSeconds(0.1);
        timer.Tick += (_, _) =>
        {
            if (_fadeTimer != timer) return;
            var left = 1 - (DateTimeOffset.Now - start).TotalSeconds / span;
            if (left <= 0)
            {
                Player.Pause();
                CancelFade();
            }
            else
            {
                Player.Volume = volume * left * left;
            }
        };
        _fadeTimer = timer;
        timer.Start();
    }

    public void CancelFade()
    {
        _fadeTimer?.Stop();
        _fadeTimer = null;
        if (_fadeVolume is { } volume && !_isStopped) Player.Volume = volume;
        _fadeVolume = null;
    }

    /// Adds a subtitle file someone picked or dropped, keeps a copy next to the film, and shows it.
    public bool AddSubtitles(string file)
    {
        if (_session.Downloads.AddSubtitles(file, DownloadId) is not { } path || SubtitleTrack.Load(path) is not { } track) return false;
        _tracks.Add(track);
        if (_selectedSubtitleId is null) _selectedSubtitleId = track.Id;
        else _secondSubtitleId = track.Id;
        UpdateCaption();
        Notify();
        return true;
    }

    /// The Mac styles the file's own text tracks here too. MediaPlayerElement draws those with the
    /// Windows caption settings, so this sets how the subtitle files are drawn.
    public void ApplyCaptionStyle(CaptionStyle style)
    {
        if (CaptionStyle == style) return;
        CaptionStyle = style;
        CaptionChanged?.Invoke();
    }

    /// Six colour zones from the frame on screen, for ambient light. Null while paused, or until a
    /// first frame has been read.
    ///
    /// AVPlayerItemVideoOutput hands the Mac small copies of the frames on screen. A MediaPlayer can
    /// only give frames up by not drawing them itself, so here a MediaComposition over the same file
    /// reads a 48 x 27 thumbnail at the playing position, at most one at a time, each time ambient
    /// light asks (every 1.5 s). The answer is the latest one read.
    public IReadOnlyList<AmbientModel.Rgb>? SampleZones()
    {
        if (!IsPlaying || _isStopped) return null;
        if (!_isSampling && _sampleFailures < 3) _ = SampleFrameAsync(Position);
        return _zones;
    }

    private async Task SampleFrameAsync(double at)
    {
        _isSampling = true;
        try
        {
            if (_frames is null)
            {
                var file = await StorageFile.GetFileFromPathAsync(Path.GetFullPath(_file));
                var clip = await MediaClip.CreateFromFileAsync(file);
                _frames = new MediaComposition();
                _frames.Clips.Add(clip);
            }
            using var image = await _frames.GetThumbnailAsync(TimeSpan.FromSeconds(Math.Max(0, at)), 48, 27, VideoFramePrecision.NearestKeyFrame);
            var decoder = await BitmapDecoder.CreateAsync(image);
            var transform = new BitmapTransform { ScaledWidth = 3, ScaledHeight = 2, InterpolationMode = BitmapInterpolationMode.Fant };
            var data = await decoder.GetPixelDataAsync(
                BitmapPixelFormat.Rgba8, BitmapAlphaMode.Premultiplied, transform,
                ExifOrientationMode.IgnoreExifOrientation, ColorManagementMode.ColorManageToSRgb);
            var pixels = data.DetachPixelData();
            if (pixels.Length < 24 || _isStopped) return;
            // Left to right, top row first, as the Mac's ColorZones.sample reads them.
            _zones = [.. Enumerable.Range(0, 6).Select(i => new AmbientModel.Rgb(pixels[i * 4] / 255.0, pixels[i * 4 + 1] / 255.0, pixels[i * 4 + 2] / 255.0))];
            _sampleFailures = 0;
        }
        catch (Exception)
        {
            // A format MediaComposition can't open: ambient light falls back to dimming.
            _sampleFailures++;
        }
        finally
        {
            _isSampling = false;
        }
    }

    /// Saves the place and ends the timeline session. The player can't be used after this.
    public void Stop()
    {
        if (_isStopped) return;
        CancelFade();
        Tick();
        Save(force: true);
        _isStopped = true;
        _ticker.Stop();
        Player.MediaEnded -= OnMediaEnded;
        Player.MediaFailed -= OnMediaFailed;
        Player.PlaybackSession.PlaybackStateChanged -= OnPlaybackStateChanged;
        Player.Pause();
        // Lets go of the file, so a watched episode can go to the Recycle Bin right away.
        Player.Source = null;
        _frames = null;
        if (IsPlaying)
        {
            IsPlaying = false;
            Notify();
        }
        if (!_isShown) Player.Dispose();
    }

    /// The view tells the playback when its MediaPlayerElement shows the player, so the player is
    /// only disposed once nothing draws it.
    internal void SetShown(bool shown)
    {
        if (_isShown == shown) return;
        _isShown = shown;
        if (!shown && _isStopped) Player.Dispose();
    }

    // MARK: Progress

    private void Tick()
    {
        if (_isStopped) return;
        var session = Player.PlaybackSession;
        var seconds = session.Position.TotalSeconds;
        if (!double.IsFinite(seconds)) return;
        // Before the file opens, the session reads 0 even when it starts further in.
        if (session.PlaybackState is MediaPlaybackState.None or MediaPlaybackState.Opening && seconds == 0) return;
        Position = seconds;
        var natural = session.NaturalDuration.TotalSeconds;
        if (double.IsFinite(natural) && natural > 0) Duration = natural;
        if (IsPlaying && _lastTick is { } last)
        {
            var step = seconds - last;
            // Only time that actually played counts, not a jump.
            if (step > 0 && step < 2) _watchedSeconds += step;
        }
        _lastTick = seconds;
        UpdateCaption();
        if ((DateTimeOffset.Now - _lastSave).TotalSeconds > 5) Save(force: false);
    }

    private void UpdateCaption()
    {
        var track = _tracks.FirstOrDefault(t => t.Id == _selectedSubtitleId);
        var text = track?.Text(Position);
        var second = _secondSubtitleId == _selectedSubtitleId ? null : _tracks.FirstOrDefault(t => t.Id == _secondSubtitleId);
        var secondText = second?.Text(Position);
        if (text == Caption && secondText == SecondCaption) return;
        Caption = text;
        SecondCaption = secondText;
        CaptionChanged?.Invoke();
    }

    private void Save(bool force)
    {
        if (!force && !IsPlaying) return;
        var now = DateTimeOffset.Now;
        _lastSave = now;
        try
        {
            _session.Downloads.NotePlayback(DownloadId, Position, Duration);
        }
        catch (Exception error)
        {
            CrashLog.Write("player", error);
        }
        var library = _session.Library;
        var settings = _session.Settings;
        if (_item.TitleId is not long titleId || !library.Titles.ContainsKey(titleId) || _item.FileUrl is not { } url
            || Duration <= 0 || _watchedSeconds < settings.MinimumSecondsToTrack)
        {
            return;
        }
        if (!_startedTitle)
        {
            _startedTitle = true;
            library.RecordWatchStart(titleId);
        }
        var finished = Position / Duration >= settings.FinishThreshold;
        library.SaveProgress(new WatchProgress
        {
            TitleId = titleId,
            Ref = _item.Ref,
            UrlKey = UrlKey.Make(url),
            Url = url,
            Host = Host,
            Position = Position,
            Duration = Duration,
            Finished = finished,
            UpdatedAt = now,
        });
        var entry = _watchSession ?? new WatchSession
        {
            Id = 0,
            TitleId = titleId,
            Ref = _item.Ref,
            EpisodeName = null,
            Url = url,
            Host = Host,
            StartedAt = now.AddSeconds(-_watchedSeconds),
            EndedAt = now,
            WatchedSeconds = 0,
            StartPosition = Math.Max(0, Position - _watchedSeconds),
            EndPosition = Position,
            Duration = Duration,
            Finished = false,
        };
        entry = entry with
        {
            EndedAt = now,
            WatchedSeconds = _watchedSeconds,
            EndPosition = Position,
            Duration = Duration,
            Finished = entry.Finished || finished,
        };
        _watchSession = library.SaveSession(entry);
        if (finished && !_item.Ref.IsEpisode && library.Titles.GetValueOrDefault(titleId)?.Status != TitleStatus.Watched)
        {
            library.SetStatus(titleId, TitleStatus.Watched);
        }
    }
}
