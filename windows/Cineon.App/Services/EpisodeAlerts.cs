using System.Globalization;
using Cineon.App.UI;
using Cineon.Core.Data;
using Microsoft.UI.Dispatching;
using Microsoft.Windows.AppNotifications;
using Microsoft.Windows.AppNotifications.Builder;

namespace Cineon.App.Services;

/// Notices when a series you're watching gets a new episode. The first check of a series only
/// remembers what's already out, so nobody gets a pile of notifications for old episodes.
/// Ported from Cineon/App/EpisodeAlerts.swift.
public sealed class EpisodeAlerts : Observable
{
    /// An episode from the episode list: aired once `Released` has passed.
    public readonly record struct AiredEpisode(int Season, int Episode, DateTimeOffset? Released);

    private readonly ProfileSession _session;
    private readonly Dictionary<long, EpisodeAlert> _alerts = [];
    private DispatcherQueueTimer? _timer;
    private CancellationTokenSource? _firstCheck;
    private bool _isStopped;

    /// How often the episode lists are looked at again.
    public static readonly TimeSpan Interval = TimeSpan.FromHours(6);

    public IReadOnlyDictionary<long, EpisodeAlert> Alerts => _alerts;

    public bool IsChecking { get; private set; }

#if DEBUG_COMMANDS
    public string? LastNotificationForTests { get; set; }
#endif

    public EpisodeAlerts(ProfileSession session)
    {
        _session = session;
        try
        {
            foreach (var alert in session.Db.EpisodeAlerts()) _alerts[alert.TitleId] = alert;
        }
        catch (Exception)
        {
            _alerts.Clear();
        }
    }

    public void Start()
    {
        if (DispatcherQueue.GetForCurrentThread() is { } queue)
        {
            _timer = queue.CreateTimer();
            _timer.Interval = TimeSpan.FromMinutes(30);
            _timer.Tick += (_, _) => CheckIfDue();
            _timer.Start();
        }
        var cts = _firstCheck = new CancellationTokenSource();
        _ = FirstCheckAsync(cts.Token);
    }

    private async Task FirstCheckAsync(CancellationToken token)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(60), token); }
        catch (TaskCanceledException) { return; }
        CheckIfDue();
    }

    public void Stop()
    {
        _isStopped = true;
        _timer?.Stop();
        _timer = null;
        _firstCheck?.Cancel();
    }

    /// The series to keep an eye on: the ones you're watching.
    public IReadOnlyList<Title> WatchedSeries =>
        [.. _session.Library.Titles.Values.Where(t => t.Status == TitleStatus.Watching && t.Kind is TitleKind.Series or TitleKind.Cartoon)];

    /// Series with episodes that came out since you last watched them, newest first.
    public IReadOnlyList<(Title Title, EpisodeAlert Alert)> Fresh
    {
        get
        {
            var now = DateTimeOffset.Now;
            var list = new List<(Title Title, EpisodeAlert Alert)>();
            foreach (var alert in _alerts.Values)
            {
                if (alert.NewAt is not { } newAt || alert.NewCount <= 0 || (now - newAt).TotalSeconds >= 21 * 86_400) continue;
                if (!_session.Library.Titles.TryGetValue(alert.TitleId, out var title) || title.Status == TitleStatus.Watched) continue;
                // Watching it since the news came in means you've seen it.
                if (title.LastWatchedAt is { } watched && watched > newAt) continue;
                list.Add((title, alert));
            }
            return [.. list.OrderByDescending(entry => entry.Alert.NewAt ?? DateTimeOffset.MinValue)];
        }
    }

    private void CheckIfDue()
    {
        if (_isStopped || !_session.Settings.NewEpisodeAlerts || IsChecking) return;
        var now = DateTimeOffset.Now;
        var due = WatchedSeries.Any(title => !_alerts.TryGetValue(title.Id, out var alert) || now - alert.CheckedAt > Interval);
        if (due) _ = CheckAsync(force: false);
    }

    /// Looks at every series you're watching. `force` checks even ones looked at recently.
    public async Task CheckAsync(bool force)
    {
        if (IsChecking) return;
        IsChecking = true;
        Notify();
        var news = new List<(Title Title, List<EpisodeRef> Added)>();
        try
        {
            foreach (var title in WatchedSeries)
            {
                if (_isStopped) return;
                if (!force && _alerts.TryGetValue(title.Id, out var recent) && DateTimeOffset.Now - recent.CheckedAt < Interval) continue;
                var episodes = await EpisodesAsync(title);
                var now = DateTimeOffset.Now;
                var aired = episodes
                    .Where(e => e.Season > 0 && e.Episode > 0 && (e.Released ?? DateTimeOffset.MinValue) <= now)
                    .Select(e => new EpisodeRef(e.Season, e.Episode))
                    .ToList();
                if (aired.Count == 0) continue;
                var latest = aired.MaxBy(Order);
                var isFirstLook = !_alerts.TryGetValue(title.Id, out var known);
                var alert = known ?? new EpisodeAlert { TitleId = title.Id, Latest = latest, CheckedAt = now, Newest = null, NewCount = 0, NewAt = null };
                var added = aired.Where(e => Order(e).CompareTo(Order(alert.Latest)) > 0).ToList();
                alert = alert with { CheckedAt = now };
                if (!isFirstLook && added.Count > 0)
                {
                    alert = alert with
                    {
                        Latest = latest,
                        Newest = latest,
                        NewCount = alert.NewCount + added.Count,
                        NewAt = now,
                    };
                    news.Add((title, [.. added.OrderBy(Order)]));
                }
                if (_isStopped) return;
                _alerts[title.Id] = alert;
                try { _session.Db.SaveEpisodeAlert(alert); }
                catch (Exception) { }
                Notify();
            }
        }
        finally
        {
            IsChecking = false;
            Notify();
        }
        foreach (var (title, added) in news) Announce(title, added);
    }

    private static (int, int) Order(EpisodeRef episode) => (episode.Season, episode.Episode);

    /// The series' episode list, fetched fresh.
    private Task<IReadOnlyList<AiredEpisode>> EpisodesAsync(Title title)
    {
        // TODO(after core merge): `(await _session.Metadata.EpisodesAsync(title, fresh: true))
        //     .Select(e => new AiredEpisode(e.Season, e.Episode, e.Released))`.
        _ = title;
        return Task.FromResult<IReadOnlyList<AiredEpisode>>([]);
    }

    /// Clears the news for a series, once you've seen it.
    public void Dismiss(long titleId)
    {
        if (!_alerts.TryGetValue(titleId, out var alert)) return;
        alert = alert with { NewCount = 0, NewAt = null };
        _alerts[titleId] = alert;
        try { _session.Db.SaveEpisodeAlert(alert); }
        catch (Exception) { }
        Notify();
    }

    // MARK: Notifications

    private void Announce(Title title, List<EpisodeRef> added)
    {
        var body = added.Count == 1
            ? $"{added[0].LongLabel} is out"
            : $"{added.Count} new episodes, up to {added[^1].LongLabel}";
#if DEBUG_COMMANDS
        LastNotificationForTests = $"{title.Name}|{body}";
#endif
        var app = _session.App;
        _session.Toasts.Show($"New on {title.Name}: {body.ToLowerInvariant()}", "Open", () => app?.OpenTitle(title.Id));
        // Test runs mustn't leave notifications or a registration behind for the real app.
        if (AppPaths.IsScratch) return;
        Notifications.Show(
            $"New episode of {title.Name}",
            body,
            title.Id,
            _session.Profile.Id,
            $"episode-{title.Id}-{added[^1].ShortLabel}");
    }
}

/// Windows notifications: registers Cineon with the notification platform, shows new-episode
/// notifications, and opens the series when one is clicked. The Mac's `NotificationRouter`.
public static class Notifications
{
    private static bool _registered;
    private static DispatcherQueue? _queue;

    public static bool IsRegistered => _registered;

    /// Registers on launch. Skipped in test runs on scratch data, like the Mac.
    public static void Install(DispatcherQueue queue)
    {
        _queue = queue;
        if (AppPaths.IsScratch || _registered) return;
        try
        {
            if (!AppNotificationManager.IsSupported()) return;
            var manager = AppNotificationManager.Default;
            // Must be in place before Register, or clicks while running are lost.
            manager.NotificationInvoked += (_, args) => Open(args);
            var icon = Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon-256.png");
            if (File.Exists(icon)) manager.Register("Cineon", new Uri(icon));
            else manager.Register();
            _registered = true;
        }
        catch (Exception error)
        {
            CrashLog.Write("notifications", error);
        }
    }

    /// Lets go of the registration as the app quits, so a later click starts Cineon again.
    public static void Uninstall()
    {
        if (!_registered) return;
        _registered = false;
        try { AppNotificationManager.Default.Unregister(); }
        catch (Exception) { }
    }

    public static void Show(string title, string body, long titleId, Guid profileId, string tag)
    {
        if (!_registered) return;
        try
        {
            var notification = new AppNotificationBuilder()
                .AddArgument("titleID", titleId.ToString(CultureInfo.InvariantCulture))
                .AddArgument("profile", Database.UuidString(profileId))
                .AddText(title)
                .AddText(body)
                .BuildNotification();
            // Windows keeps tags to 64 characters.
            notification.Tag = tag.Length > 64 ? tag[..64] : tag;
            AppNotificationManager.Default.Show(notification);
        }
        catch (Exception)
        {
            // The toast inside the window already said it.
        }
    }

    /// A click on a notification, while Cineon runs (NotificationInvoked, on a background thread)
    /// or as what launched it.
    public static void Open(AppNotificationActivatedEventArgs args)
    {
        if (!args.Arguments.TryGetValue("titleID", out var raw)
            || !long.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var id))
        {
            return;
        }
        void Run()
        {
            if (AppModel.Shared is not { } app) return;
            app.Window?.BringToFront();
            app.OpenTitle(id);
        }
        if (_queue is { } queue && !queue.HasThreadAccess) queue.TryEnqueue(Run);
        else Run();
    }
}
