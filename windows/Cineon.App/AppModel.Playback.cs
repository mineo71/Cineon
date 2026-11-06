using Cineon.App.Browser;
using Cineon.App.Playback;
using Cineon.Core.Data;

namespace Cineon.App;

// Playing, the sleep timer, up next and staying awake. The "Playing", "Sleep timer", "Up next",
// "Staying awake" and "Downloads" parts of Cineon/App/AppModel.swift.
public sealed partial class AppModel
{
    /// The downloaded film playing in the native player.
    public LocalPlayback? LocalPlayback { get; private set; }

    /// Stops playback after a while, or at the end of what's on.
    public SleepTimerState? SleepTimer { get; private set; }

    /// The next downloaded episode, about to start in the native player.
    public UpNext? UpNext { get; private set; }

    public NowPlayingCenter NowPlaying { get; } = new();

    private readonly StayAwake _stayAwake = new();

    /// A downloaded episode watched to its end, binned once the player moves past it.
    private long? _watchedDownloadId;

    /// The tab that played last, so a paused film can still be resumed from a media key.
    private BrowserTab? _lastPlayedTab;

    // MARK: Playing

    /// The native player when it's open, otherwise the tab with the film.
    public ActivePlayer? ActivePlayer
    {
        get
        {
            if (LocalPlayback is { } local) return new ActivePlayer.Local(local);
            var tabs = Browser.Tabs;
            if (tabs.FirstOrDefault(t => t.Media?.IsPlaying == true) is { } playing) return new ActivePlayer.Web(playing);
            if (_lastPlayedTab is { Media: not null } last && tabs.Contains(last)) return new ActivePlayer.Web(last);
            if (Browser.PlayingTab is { Media: not null } tab) return new ActivePlayer.Web(tab);
            return null;
        }
    }

    public void TogglePlayback()
    {
        if (ActivePlayer is { } player)
        {
            player.Toggle();
        }
        else if (Library.ContinueWatching is [var first, ..])
        {
            Resume(first.Progress.Url ?? first.Title.PosterUrl ?? new Uri("file:///"), first.Progress.Position);
        }
    }

    /// The next episode: the next download in the native player, or the next one on the site.
    public void PlayNextEpisode()
    {
        switch (ActivePlayer)
        {
            case ActivePlayer.Local local:
                // TODO(after core merge): `Session.Downloads.NextEpisode(after: local.Playback.DownloadItem)`.
                DownloadItem? next = null;
                _ = local;
                if (next is null)
                {
                    Toasts.Show("The next episode isn't on this PC");
                    return;
                }
                PlayDownload(next);
                break;
            case ActivePlayer.Web web:
                Session.Autopilot.SkipToNext(web.Tab);
                break;
        }
    }

    // MARK: Sleep timer

    public void StartSleepTimer(SleepTimerMode mode)
    {
        if (SleepTimer?.IsFading == true) ActivePlayer?.CancelFade();
        var state = new SleepTimerState(mode);
        if (mode.Minutes is int minutes)
        {
            state = state with { Deadline = DateTimeOffset.Now.AddMinutes(minutes) };
        }
        else
        {
            if (ActivePlayer is not { } player)
            {
                Toasts.Show("Start something first, then set the timer for its end");
                return;
            }
            state = state with { Item = player.Identity };
            if (player is ActivePlayer.Web web) web.Tab.Autopilot.IsHeldForSleep = true;
        }
        SleepTimer = state;
        Notify();
        Toasts.Show(mode.IsEndOfItem ? "Playback stops at the end of this" : $"Playback stops in {mode.Label}");
    }

    /// For tests and the Jump List: a timer that runs out in this many seconds.
    public void StartSleepTimer(double seconds)
    {
        StartSleepTimer(SleepTimerMode.ForMinutes(Math.Max(1, (int)(seconds / 60))));
        if (SleepTimer is { } timer)
        {
            SleepTimer = timer with { Deadline = DateTimeOffset.Now.AddSeconds(seconds) };
            Notify();
        }
    }

    public void CancelSleepTimer()
    {
        if (SleepTimer is not { } timer) return;
        if (timer.IsFading) ActivePlayer?.CancelFade();
        ReleaseSleepHold();
        SleepTimer = null;
        Notify();
    }

    public double? SleepTimerRemaining => SleepTimer?.Remaining(ActivePlayer);

    private void ReleaseSleepHold()
    {
        foreach (var tab in Browser.Tabs) tab.Autopilot.IsHeldForSleep = false;
    }

    private void TickPlayback()
    {
        if (Browser.Tabs.FirstOrDefault(t => t.Media?.IsPlaying == true) is { } tab) _lastPlayedTab = tab;
        NowPlaying.Update(ActivePlayer, Library);
        TickSleepTimer();
        TickUpNext();
    }

    private void TickSleepTimer()
    {
        if (SleepTimer is not { } timer) return;
        var player = ActivePlayer;
        if (timer.Mode.IsEndOfItem)
        {
            // What was on ended, or something else took its place.
            if (player is null || player.Identity != timer.Item)
            {
                FinishSleepTimer(paused: false);
                return;
            }
            if (player is ActivePlayer.Web web) web.Tab.Autopilot.IsHeldForSleep = true;
        }
        if (timer.Remaining(player) is not double remaining) return;
        if (remaining <= SleepTimerState.FadeSeconds && !timer.IsFading && player is { IsPlaying: true })
        {
            player.FadeOut(Math.Max(1, remaining));
            SleepTimer = timer with { IsFading = true };
            Notify();
            return;
        }
        if (!timer.Mode.IsEndOfItem && remaining <= 0)
        {
            player?.Pause();
            FinishSleepTimer(paused: true);
        }
        else if (timer.IsFading && player?.IsPlaying == false)
        {
            FinishSleepTimer(paused: true);
        }
    }

    private void FinishSleepTimer(bool paused)
    {
        SleepTimer = null;
        ReleaseSleepHold();
        Notify();
        if (paused) Toasts.Show("Sleep timer paused the film. Good night");
    }

    // MARK: Up next

    private void LocalPlaybackEnded(LocalPlayback playback)
    {
        var item = playback.DownloadItem;
        if (item.Ref.IsEpisode) _watchedDownloadId = item.Id;
        if (SleepTimer?.Mode.IsEndOfItem == true)
        {
            FinishSleepTimer(paused: true);
            return;
        }
        // TODO(after core merge): `Session.Downloads.NextEpisode(after: item)`.
        DownloadItem? next = null;
        if (!Settings.PlayNextDownload || next is null) return;
        UpNext = new UpNext(next, DateTimeOffset.Now.AddSeconds(8));
        Notify();
    }

    private void TickUpNext()
    {
        if (UpNext is not { } upNext || DateTimeOffset.Now < upNext.StartsAt) return;
        PlayUpNext();
    }

    public void PlayUpNext()
    {
        if (UpNext is not { } upNext) return;
        UpNext = null;
        Notify();
        PlayDownload(upNext.Item);
    }

    public void CancelUpNext()
    {
        if (UpNext is null) return;
        UpNext = null;
        Notify();
    }

    /// Bins the episode just watched, if that's what this person wants.
    private void BinWatchedDownload(long? keep = null)
    {
        if (_watchedDownloadId is not long id || id == keep) return;
        _watchedDownloadId = null;
        if (Settings.BinWatchedDownloads)
        {
            // TODO(after core merge): Session.Downloads.BinWatched(id)
        }
    }

    // MARK: Staying awake

    /// The screen stays on while something plays. A page that stopped reporting, because its video
    /// is stuck buffering or gone, lets the PC sleep again after a few quiet seconds.
    private void TickStayAwake()
    {
        var now = DateTimeOffset.Now;
        var webPlaying = Browser.Tabs.Any(tab =>
            tab.Media?.IsPlaying == true && tab.LastPlaybackReport is { } last && (now - last).TotalSeconds < 15);
        _stayAwake.Hold(webPlaying || LocalPlayback?.IsPlaying == true);
    }

    // MARK: Native player

    public void PlayDownload(DownloadItem item)
    {
        DetailTitleId = null;
        if (item.Status != DownloadStatus.Done)
        {
            Go(Route.Downloads);
            return;
        }
        Browser.PlayingTab?.PausePlayback();
        LocalPlayback?.Stop();
        UpNext = null;
        BinWatchedDownload(keep: item.Id);
        // TODO(after core merge): use the current row, `Session.Downloads.Item(item.Id)`, as the Mac does.
        var fresh = item;
        if (LocalPlayback.Create(fresh, Session) is not { } playback)
        {
            var folder = Path.GetFileName(AppPaths.DownloadsFolder(Settings).TrimEnd('\\', '/'));
            Toasts.Show($"{item.FileBaseName} isn't in {folder} anymore");
            Notify();
            return;
        }
        var weak = new WeakReference<LocalPlayback>(playback);
        playback.OnEnded = () =>
        {
            if (weak.TryGetTarget(out var ended)) LocalPlaybackEnded(ended);
        };
        LocalPlayback = playback;
        Notify();
        Route = Route.Player;
    }

    public void ClosePlayer()
    {
        LocalPlayback?.Stop();
        LocalPlayback = null;
        UpNext = null;
        BinWatchedDownload();
        Notify();
        if (Route == Route.Player) Route = Route.Downloads;
    }
}
