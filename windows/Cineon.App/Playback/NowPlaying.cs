using System.Globalization;
using Cineon.App.UI;
using Cineon.Core.Data;
using Microsoft.UI.Dispatching;
using Windows.Media;
using Windows.Storage.Streams;

namespace Cineon.App.Playback;

/// Puts what's playing in the Windows media flyout and lock screen, and answers the play/pause key,
/// headphones and keyboards with media keys. The Mac's `NowPlayingCenter` (MPNowPlayingInfoCenter
/// and MPRemoteCommandCenter), here through the main window's SystemMediaTransportControls.
public sealed class NowPlayingCenter
{
    private AppModel? _app;
    private DispatcherQueue? _queue;
    private SystemMediaTransportControls? _controls;
    private Dictionary<string, string> _lastPublished = [];
    private (string Name, string Detail, Uri? Poster)? _shown;

#if DEBUG_COMMANDS
    /// The same commands the media keys run, for the test commands.
    public Dictionary<string, Action<double>> Handlers { get; } = [];
#endif

    /// Connects to the window's media controls. Call once, on the UI thread, after the window exists.
    public void Install(AppModel app, IntPtr window)
    {
        _app = app;
        _queue = DispatcherQueue.GetForCurrentThread();
        Register("toggle", a => a.TogglePlayback());
        Register("play", a => a.ActivePlayer?.Play());
        Register("pause", a => a.ActivePlayer?.Pause());
        Register("next", a => a.PlayNextEpisode());
        Register("forward", a => a.ActivePlayer?.Skip(10));
        Register("back", a => a.ActivePlayer?.Skip(-10));
#if DEBUG_COMMANDS
        Handlers["seek"] = time => app.ActivePlayer?.Seek(time);
#endif
        try
        {
            var controls = SystemMediaTransportControlsInterop.GetForWindow(window);
            controls.IsEnabled = true;
            controls.IsPlayEnabled = true;
            controls.IsPauseEnabled = true;
            controls.IsNextEnabled = true;
            controls.IsFastForwardEnabled = true;
            controls.IsRewindEnabled = true;
            controls.PlaybackStatus = MediaPlaybackStatus.Closed;
            // Both arrive on a background thread.
            controls.ButtonPressed += (_, e) => OnMain(app => Press(app, e.Button));
            controls.PlaybackPositionChangeRequested += (_, e) =>
            {
                var time = e.RequestedPlaybackPosition.TotalSeconds;
                OnMain(app => app.ActivePlayer?.Seek(time));
            };
            _controls = controls;
        }
        catch (Exception error)
        {
            CrashLog.Write("media controls", error);
        }
    }

    private void Register(string name, Action<AppModel> action)
    {
#if DEBUG_COMMANDS
        Handlers[name] = _ => { if (_app is { } app) action(app); };
#endif
    }

    private void OnMain(Action<AppModel> action)
    {
        _queue?.TryEnqueue(() => { if (_app is { } app) action(app); });
    }

    /// The play/pause key sends Play while nothing plays, which carries on with the last film like
    /// the Mac's toggle command does.
    private static void Press(AppModel app, SystemMediaTransportControlsButton button)
    {
        switch (button)
        {
            case SystemMediaTransportControlsButton.Play:
                if (app.ActivePlayer is { } player) player.Play();
                else app.TogglePlayback();
                break;
            case SystemMediaTransportControlsButton.Pause:
                app.ActivePlayer?.Pause();
                break;
            case SystemMediaTransportControlsButton.Next:
                app.PlayNextEpisode();
                break;
            case SystemMediaTransportControlsButton.FastForward:
                app.ActivePlayer?.Skip(10);
                break;
            case SystemMediaTransportControlsButton.Rewind:
                app.ActivePlayer?.Skip(-10);
                break;
        }
    }

    /// What was published last, for tests: title, detail, playing, position, duration, artwork.
    public IReadOnlyDictionary<string, string> Published => _lastPublished;

    /// Called about once a second with whatever is playing.
    public void Update(ActivePlayer? player, LibraryStore library)
    {
        if (player is null || player.Duration <= 0)
        {
            if (_lastPublished.Count > 0)
            {
                if (_controls is { } controls)
                {
                    controls.PlaybackStatus = MediaPlaybackStatus.Closed;
                    controls.DisplayUpdater.ClearAll();
                    controls.DisplayUpdater.Update();
                }
                _shown = null;
                _lastPublished = [];
            }
            return;
        }
        var title = player.TitleId is long id ? library.Titles.GetValueOrDefault(id) : null;
        string name;
        string detail;
        switch (player)
        {
            case ActivePlayer.Local local:
                name = title?.Name ?? local.Playback.Name;
                detail = local.Playback.Badge is { } badge ? $"{badge} · On this PC" : "On this PC";
                break;
            case ActivePlayer.Web web:
                name = title?.Name ?? web.Tab.Parsed?.Name ?? web.Tab.DisplayTitle;
                var host = web.Tab.Url is { Host.Length: > 0 } url ? DomainName.DisplayName(url.Host) : null;
                detail = string.Join(" · ", new[] { player.Ref?.ShortLabel, host }.OfType<string>());
                break;
            default:
                return;
        }
        var poster = title?.PosterUrl;
        if (_controls is { } smtc)
        {
            try
            {
                if (_shown != (name, detail, poster))
                {
                    var display = smtc.DisplayUpdater;
                    display.Type = MediaPlaybackType.Video;
                    display.VideoProperties.Title = name;
                    display.VideoProperties.Subtitle = detail;
                    display.Thumbnail = poster is { Scheme: "http" or "https" } ? RandomAccessStreamReference.CreateFromUri(poster) : null;
                    display.Update();
                    _shown = (name, detail, poster);
                }
                smtc.PlaybackStatus = player.IsPlaying ? MediaPlaybackStatus.Playing : MediaPlaybackStatus.Paused;
                smtc.PlaybackRate = player.IsPlaying ? player.Rate : 0;
                smtc.UpdateTimelineProperties(new SystemMediaTransportControlsTimelineProperties
                {
                    StartTime = TimeSpan.Zero,
                    MinSeekTime = TimeSpan.Zero,
                    EndTime = TimeSpan.FromSeconds(player.Duration),
                    MaxSeekTime = TimeSpan.FromSeconds(player.Duration),
                    Position = TimeSpan.FromSeconds(Math.Clamp(player.Position, 0, player.Duration)),
                });
            }
            catch (Exception)
            {
                // The media flyout is a nicety. Playback carries on without it.
            }
        }
        _lastPublished = new Dictionary<string, string>
        {
            ["title"] = name,
            ["detail"] = detail,
            ["playing"] = player.IsPlaying ? "1" : "0",
            ["position"] = ((long)player.Position).ToString(CultureInfo.InvariantCulture),
            ["duration"] = ((long)player.Duration).ToString(CultureInfo.InvariantCulture),
            ["artwork"] = poster is null ? "0" : "1",
        };
    }
}
