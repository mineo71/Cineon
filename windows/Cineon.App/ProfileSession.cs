using Cineon.App.Browser;
using Cineon.App.Services;
using Cineon.App.UI;
using Cineon.Core.Data;
using Cineon.Core.Downloads;
using Cineon.Core.Metadata;
using Cineon.Core.Profile;
using Cineon.Core.Shields;

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
    public TogetherModel Together { get; }
    public EpisodeAlerts Alerts { get; }

    /// Turns playback reports into the timeline. The Mac's ScriptRouter has no counterpart: each
    /// tab's ScriptBridge delivers its pages' messages to that tab.
    public WatchTracker Tracker { get; }
    /// Posters, descriptions and episode lists from the catalogue.
    public MetadataService Metadata { get; }
    public DownloadCenter Downloads { get; }
    /// Downloads a season, or a whole series, through a hidden tab.
    public SeasonGrabber Seasons { get; }
    /// Cookies and the browser's name for downloads, from this profile's WebView2.
    public RequestContext RequestContext { get; }
    // TODO(after core merge): `CloudLibrary Cloud`, created after the alerts as on the Mac.

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

        Metadata = new MetadataService(Library, () => _settings.FetchMetadata);
        Web = new WebEnvironment(profile.Id);
        Web.InstallScripts(_settings.OverlaySweeper);
        Tracker = new WatchTracker(this);
        Autopilot = new EpisodeAutopilot(this);
        Rescue = new RescueEngine(this);
        Frames = new FrameCollector(this);
        Browser = new BrowserModel(this);
        RequestContext = new RequestContext(this);
        var downloadHost = new DownloadHost(this);
        Downloads = new DownloadCenter(Db, Library, () => _settings, RequestContext, downloadHost);
        Together = new TogetherModel(this);
        Seasons = new SeasonGrabber(Downloads, downloadHost, new EpisodeResolver(this), AppPaths.Profile(profile.Id));
        Alerts = new EpisodeAlerts(this);

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
            if (value.ShowDownloadButton != old.ShowDownloadButton) Downloads.RefreshPills(force: true);
            if (value.VoiceBoost != old.VoiceBoost)
            {
                foreach (var tab in Browser.Tabs) tab.ApplyVoiceBoost();
            }
            if (value.SharePet != old.SharePet) Together.RefreshIdentity();
            if (value.CloudBackup != old.CloudBackup && value.CloudBackup)
            {
                // TODO(after core merge): Cloud.Start()
            }
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
        // TODO(after core merge): Cloud.Start()
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
        Seasons.Suspend();
        Alerts.Stop();
        // TODO(after core merge): Cloud.Stop()
        Together.Stop();
        // TODO(after core merge): Downloads.SuspendAll()
        Shields.Flush();
        Browser.Shutdown();
        RequestContext.Close();
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
