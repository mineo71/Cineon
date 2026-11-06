using Cineon.App.Browser;
using Cineon.App.Services;
using Cineon.App.UI;
using Cineon.Core.Data;
using Cineon.Core.Profile;
using Cineon.Core.Shields;
using Cineon.Core.Together;

namespace Cineon.App;

/// Everything that belongs to the person currently watching: their database, library, settings,
/// shields, tabs and the services working for them. Ported from Cineon/App/ProfileSession.swift.
/// Lives on the UI thread.
public sealed class ProfileSession : Observable
{
    public Profile Profile { get; }
    public Database Db { get; }
    public ToastCenter Toasts { get; }

    /// Set right after init. The Mac's `weak var app: AppModel?`.
    public AppModel? App { get; set; }

    private readonly FilterEngine _filters;
    private AppSettings _settings;
    private bool _isClosed;

    public LibraryStore Library { get; }
    public ShieldState Shields { get; }

    /// The Mac's `webKit`: the WebView2 environment, page scripts and rules this person's tabs share.
    public WebEnvironment Web { get; }
    public EpisodeAutopilot Autopilot { get; }
    public RescueEngine Rescue { get; }
    public FrameCollector Frames { get; }
    public BrowserModel Browser { get; }
    /// Watch parties, challenges and shared lists (Core's TogetherModel; the app side is TogetherHost.cs).
    public TogetherModel Together { get; }
    public EpisodeAlerts Alerts { get; }
    /// Ratings and lists kept on the server too.
    public CloudLibrary Cloud { get; }

    // TODO(port-browser): `WatchTracker Tracker` (Mac: tracker = WatchTracker(session: self)). The Mac's
    // ScriptRouter has no counterpart: each tab's ScriptBridge delivers its pages' messages to that tab.
    // TODO(after core merge): `MetadataService Metadata` (MetadataService(library) { settings.fetchMetadata }),
    // `DownloadCenter Downloads` and `SeasonGrabber Seasons`, created here in the Mac's order (metadata
    // before the browser; downloads before together, seasons after it).

#if DEBUG
    private const string TogetherServer = TogetherClient.DevelopmentUrl;
#else
    private const string TogetherServer = TogetherClient.ProductionUrl;
#endif

    /// The ad and tracker rules this person has switched on, as last applied.
    public ShieldEngine Rules { get; private set; } = ShieldEngine.Empty;

    public ProfileSession(Profile profile, FilterEngine filters, ToastCenter toasts)
    {
        Profile = profile;
        _filters = filters;
        Toasts = toasts;
        var path = Path.Combine(AppPaths.Profile(profile.Id), "cineon.sqlite");
        Db = new Database(path);
        _settings = Db.LoadSettings();
        Library = new LibraryStore(Db);
        Shields = new ShieldState(new DatabaseShieldStore(Db));

        Web = new WebEnvironment(profile.Id);
        Web.InstallScripts(_settings.OverlaySweeper);
        Autopilot = new EpisodeAutopilot(this);
        Rescue = new RescueEngine(this);
        Frames = new FrameCollector(this);
        Browser = new BrowserModel(this);
        // Built on the UI thread: its state changes and events come back here.
        Together = new TogetherModel(profile, Library, new TogetherHost(this), new PartyPlayer(this),
            TogetherClient.Configured(TogetherServer), SynchronizationContext.Current);
        Alerts = new EpisodeAlerts(this);
        Cloud = new CloudLibrary(Library, Together, () => Settings);

        Library.SeedDefaultSitesIfNeeded();
    }

    /// This person's settings. Setting them saves them and applies whatever changed.
    public AppSettings Settings
    {
        get => _settings;
        set
        {
            if (value == _settings) return;
            var old = _settings;
            _settings = value;
            Db.SaveSettings(value);
            if (value.OverlaySweeper != old.OverlaySweeper) Web.InstallScripts(value.OverlaySweeper);
            if (value.NetworkBlocking != old.NetworkBlocking || !value.EnabledLists.SetEquals(old.EnabledLists)) ApplyRules();
            if (value.ShowDownloadButton != old.ShowDownloadButton)
            {
                // TODO(after core merge): Downloads.RefreshPills(force: true)
            }
            if (value.VoiceBoost != old.VoiceBoost)
            {
                foreach (var tab in Browser.Tabs) tab.ApplyVoiceBoost();
            }
            if (value.SharePet != old.SharePet) _ = Together.RefreshIdentity();
            if (value.CloudBackup != old.CloudBackup && value.CloudBackup) Cloud.Start();
            if (value.CaptionStyle != old.CaptionStyle)
            {
                foreach (var tab in Browser.Tabs) tab.ApplyCaptions(force: true);
                App?.LocalPlayback?.ApplyCaptionStyle(value.CaptionStyle);
            }
            Notify();
        }
    }

    public void Start()
    {
        ApplyRules();
        Browser.Start();
        RetryMissingMetadata();
        _ = PruneFramesAsync();
        Together.Start();
        Alerts.Start();
        Cloud.Start();
    }

    private async Task PruneFramesAsync()
    {
        try { await Library.PruneFramesAsync(); }
        catch (Exception) { }
    }

    /// Applies the rule lists this person has switched on.
    public void ApplyRules()
    {
        if (_isClosed) return;
        Rules = _filters.RulesFor(Settings.NetworkBlocking, Settings.EnabledLists);
        Web.ApplyRules(Rules);
    }

    /// Titles added while offline get their posters on the next launch.
    private void RetryMissingMetadata()
    {
        if (!Settings.FetchMetadata) return;
        foreach (var title in Library.Titles.Values)
        {
            if (title.MetadataChecked || title.ImdbId is not null) continue;
            // TODO(after core merge): Metadata.Enrich(title.Id, inBackground: true)
        }
    }

    public void Close()
    {
        if (_isClosed) return;
        _isClosed = true;
        // Kept, to carry on with next time.
        // TODO(after core merge): Seasons.Suspend()
        Alerts.Stop();
        Cloud.Stop();
        Together.Stop();
        // TODO(after core merge): Downloads.SuspendAll()
        Shields.Flush();
        Browser.Shutdown();
        Web.Teardown();
        Db.Dispose();
    }

    // MARK: Profile

    private (string Key, ProfileStats Stats)? _statsCache;

    /// The numbers on the profile page, worked out again when the library changes.
    public ProfileStats Stats
    {
        get
        {
            var titles = Library.Titles.Values;
            var ratingSum = titles.Sum(t => (t.RatingHalves ?? 0) + (t.Status == TitleStatus.Watched ? 1000 : 0));
            // TODO(after core merge): Downloads.Items, as the Mac counts them, instead of reading the table.
            var downloads = Try(() => Db.AllDownloads(), []);
            var key = $"{Library.Revision}|{Library.Titles.Count}|{ratingSum}|{downloads.Count}";
            if (_statsCache is { } cache && cache.Key == key) return cache.Stats;
            var sessions = Try<IReadOnlyList<WatchSession>>(() => Db.Sessions(limit: 100_000), Library.Sessions);
            var computed = ProfileStats.Compute(
                titles.Select(StatsTitleFor),
                sessions.Select(s => new StatsSession(s.TitleId, s.StartedAt, s.EndedAt, s.WatchedSeconds)),
                Library.Progress.Select(p => new StatsProgress(p.TitleId, p.Ref.IsEpisode, p.Finished)),
                moments: Library.MomentsByTitle.Values.Sum(list => list.Count),
                adsBlocked: Try(() => Db.TotalStats().Ads, 0),
                downloads: downloads.Count(d => d.Status == DownloadStatus.Done));
            _statsCache = (key, computed);
            return computed;
        }
    }

    /// This person's pixel pet, grown from what they watch.
    public PixelPet Pet => PixelPet.Make(Stats.PetTraits(PetTraits.SeedFor(Profile.Id)));

    private static StatsTitle StatsTitleFor(Title title) => new()
    {
        Id = title.Id,
        Name = title.Name,
        PosterUrl = title.PosterUrl?.OriginalString,
        Year = title.Year,
        IsSeries = title.Kind == TitleKind.Series,
        Status = title.Status switch
        {
            TitleStatus.Backlog => StatsStatus.Backlog,
            TitleStatus.Watching => StatsStatus.Watching,
            TitleStatus.Watched => StatsStatus.Watched,
            _ => StatsStatus.None,
        },
        Genres = title.Genres,
        RuntimeMinutes = title.RuntimeMinutes,
        RatingHalves = title.RatingHalves,
        LastWatchedAt = title.LastWatchedAt,
    };

    private static T Try<T>(Func<T> read, T fallback)
    {
        try { return read(); }
        catch (Exception) { return fallback; }
    }

    // MARK: Actions

    /// The poster to show on this person's avatar.
    public Uri? LatestPosterUrl =>
        Library.ContinueWatching.FirstOrDefault().Title?.PosterUrl
        ?? Library.Watched.FirstOrDefault()?.PosterUrl
        ?? Library.Backlog.FirstOrDefault()?.PosterUrl;
}
