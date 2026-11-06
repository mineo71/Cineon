using System.Text.Json;
using Cineon.App.UI;
using Velopack;
using Velopack.Sources;

namespace Cineon.App.Services;

/// In-app updates through Velopack, from the same GitHub releases the Mac reads with Sparkle.
/// Same behaviour as the Mac's `Updater`: a daily check, "Check for Updates…", and an option to
/// install quietly the next time Cineon quits.
///
/// It only runs in an installed copy. Debug builds and test runs on scratch data leave it off,
/// unless `CINEON_UPDATE_FEED` points them at a local test feed (a folder or URL with Velopack's files).
public sealed class Updater : Observable
{
    public static Updater Shared { get; } = new();

    public const string Repository = "https://github.com/mineo71/Cineon";
    private static readonly string? TestFeed = Environment.GetEnvironmentVariable("CINEON_UPDATE_FEED");
    private static readonly TimeSpan Interval = TimeSpan.FromDays(1);

    private readonly UpdateManager _manager;
    private Settings _settings;
    private UpdateInfo? _ready;
    private bool _busy;

    /// What the last check did, for tests: "found 1.0.1", "none", "downloaded 1.0.1", "ready 1.0.1" or an error.
    public string LastEvent { get; private set; } = "-";

    /// A newer version the person hasn't decided about yet. The window shows it.
    public UpdateInfo? Offer { get; private set; }

    private Updater()
    {
        IUpdateSource source = TestFeed is { } feed
            ? new SimpleWebSource(feed)
            : new GithubSource(Repository, accessToken: null, prerelease: false);
        _manager = new UpdateManager(source);
        _settings = Settings.Load();
    }

    public string Version
    {
        get
        {
            var version = _manager.CurrentVersion?.ToString()
                ?? typeof(Updater).Assembly.GetName().Version?.ToString(3) ?? "?";
            return version;
        }
    }

    public bool IsRunning
    {
        get
        {
            if (TestFeed is not null) return true;
#if DEBUG
            return false;
#else
            return _manager.IsInstalled && !Core.Data.AppPaths.IsScratch;
#endif
        }
    }

    public bool CanCheck => IsRunning && !_busy;

    public bool ChecksAutomatically
    {
        get => _settings.ChecksAutomatically;
        set { _settings = _settings with { ChecksAutomatically = value }; _settings.Save(); Notify(); }
    }

    public bool InstallsAutomatically
    {
        get => _settings.InstallsAutomatically;
        set { _settings = _settings with { InstallsAutomatically = value }; _settings.Save(); Notify(); }
    }

    /// Starts the daily check. Called once after launch.
    public void Start()
    {
        if (!IsRunning) return;
        _ = Loop();
    }

    private async Task Loop()
    {
        while (true)
        {
            var due = _settings.LastCheck + Interval - DateTimeOffset.Now;
            if (due > TimeSpan.Zero) await Task.Delay(due < TimeSpan.FromHours(1) ? due : TimeSpan.FromHours(1));
            else if (ChecksAutomatically) await CheckAsync(userInitiated: false);
            else await Task.Delay(TimeSpan.FromHours(1));
        }
    }

    /// Checks now and shows the result, including "you're up to date".
    public void CheckForUpdates() => _ = CheckAsync(userInitiated: true);

    /// Checks quietly, the way the daily check does. Used by tests.
    public void CheckInBackground() => _ = CheckAsync(userInitiated: false);

    public event Action<string>? Said;

    private async Task CheckAsync(bool userInitiated)
    {
        if (!IsRunning || _busy) return;
        _busy = true;
        Notify();
        try
        {
            var info = await _manager.CheckForUpdatesAsync();
            _settings = _settings with { LastCheck = DateTimeOffset.Now };
            _settings.Save();
            if (info is null)
            {
                LastEvent = "none";
                if (userInitiated) Said?.Invoke($"Cineon {Version} is the newest version.");
                return;
            }
            var version = info.TargetFullRelease.Version.ToString();
            LastEvent = $"found {version}";
            if (!userInitiated && _settings.Skipped == version) return;
            if (InstallsAutomatically && !userInitiated)
            {
                await _manager.DownloadUpdatesAsync(info);
                _ready = info;
                LastEvent = $"ready {version}";
                return;
            }
            Offer = info;
        }
        catch (Exception error)
        {
            LastEvent = $"error: {error.Message}";
            if (userInitiated) Said?.Invoke("Couldn't check for updates. Try again later.");
        }
        finally
        {
            _busy = false;
            Notify();
        }
    }

    /// The person chose to install the offered version now.
    public async Task InstallOfferAsync()
    {
        if (Offer is not { } info) return;
        Offer = null;
        Notify();
        try
        {
            await _manager.DownloadUpdatesAsync(info);
            LastEvent = $"downloaded {info.TargetFullRelease.Version}";
            if (Core.Data.AppPaths.IsScratch)
            {
                // A test copy installs on quit and stays closed: relaunching would drop CINEON_DATA_DIR.
                _ready = info;
                return;
            }
            App.Model.PrepareToQuit();
            _manager.ApplyUpdatesAndRestart(info);
        }
        catch (Exception error)
        {
            LastEvent = $"error: {error.Message}";
            Said?.Invoke("The update couldn't be installed. Try again later.");
        }
    }

    public void RemindLater()
    {
        Offer = null;
        Notify();
    }

    public void SkipOffer()
    {
        if (Offer is { } info) { _settings = _settings with { Skipped = info.TargetFullRelease.Version.ToString() }; _settings.Save(); }
        Offer = null;
        Notify();
    }

    /// Called as the app quits: puts a quietly downloaded update in place once Cineon has exited.
    public void ApplyOnQuit()
    {
        if (_ready is not { } info) return;
        try { _manager.WaitExitThenApplyUpdates(info.TargetFullRelease, silent: true, restart: false); }
        catch (Exception error) { LastEvent = $"error: {error.Message}"; }
    }

    private sealed record Settings(bool ChecksAutomatically = true, bool InstallsAutomatically = false, DateTimeOffset LastCheck = default, string? Skipped = null)
    {
        private static string FilePath => Path.Combine(Core.Data.AppPaths.Root, "updates.json");

        public static Settings Load()
        {
            try { return JsonSerializer.Deserialize<Settings>(File.ReadAllText(FilePath)) ?? new(); }
            catch { return new(); }
        }

        public void Save()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
                File.WriteAllText(FilePath, JsonSerializer.Serialize(this));
            }
            catch
            {
                // Settings for updates aren't worth failing over.
            }
        }
    }
}
