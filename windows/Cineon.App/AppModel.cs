using Cineon.App.Browser;
using Cineon.App.Playback;
using Cineon.App.UI;
using Cineon.Core.Data;
using Cineon.Core.Shields;
using Microsoft.UI.Dispatching;

namespace Cineon.App;

/// Same cases as the Mac's `Route`.
public enum Route { Home, Library, Timeline, Web, Settings, Downloads, Player, Together, Profile, Rate }

/// Same cases as the Mac's `AppSheet`. Records, so two sheets compare by value like the Mac's `Equatable`.
public abstract record AppSheet
{
    public sealed record AddSite(string? Prefill) : AppSheet;
    public sealed record EditSite(long SiteId) : AppSheet;
    public sealed record AddTitle(string? Query) : AppSheet;
    public sealed record Relink : AppSheet;
    public sealed record ImportBrowser : AppSheet;
    public sealed record NewChallenge : AppSheet;

    /// The Mac's `id`, such as "addSite" or "editSite12".
    public string Id => this switch
    {
        AddSite => "addSite",
        EditSite edit => $"editSite{edit.SiteId}",
        AddTitle => "addTitle",
        Relink => "relink",
        ImportBrowser => "importBrowser",
        NewChallenge => "newChallenge",
        _ => "",
    };
}

/// The whole app's state: who's watching, what's on screen, and the commands that change it.
/// Lives on the UI thread. Ported from Cineon/App/AppModel.swift; the playing and ambient-light
/// halves are in AppModel.Playback.cs and AppModel.Ambient.cs.
public sealed partial class AppModel : Observable
{
    public ProfileStore Profiles { get; }
    public FilterEngine Filters { get; }
    public ToastCenter Toasts { get; } = new();
    public AmbientModel Ambient { get; } = new();

    /// For the Jump List, notifications and second launches, which run outside any view.
    public static AppModel? Shared { get; private set; }

    private ProfileSession _session;
    public ProfileSession Session
    {
        get => _session;
        private set
        {
            if (ReferenceEquals(_session, value)) return;
            _session.Changed -= SessionChanged;
            _session = value;
            _session.Changed += SessionChanged;
            Notify();
        }
    }

    /// The main window, once it's up. The Mac's `weak var window: NSWindow?`.
    public MainWindow? Window { get; set; }

    private readonly DispatcherQueueTimer? _ambientTimer;
    private readonly DispatcherQueueTimer? _playbackTimer;
    private bool _hasQuit;

    public AppModel()
    {
        Profiles = new ProfileStore();
        Filters = new FilterEngine(Path.Combine(AppPaths.Root, "Filters"));
        // Like the Mac, there's no Cineon without its database: a failure here ends in crash.log.
        _session = new ProfileSession(Profiles.LastUsed, Filters, Toasts);
        _session.App = this;
        _session.Changed += SessionChanged;
        _isProfilePickerVisible = Profiles.AskOnLaunch && Profiles.Profiles.Count > 1;
        Filters.Changed += () => Session.ApplyRules();
        ApplyTheme();
        _session.Start();
        _ = PrepareFiltersAsync();

        if (DispatcherQueue.GetForCurrentThread() is { } queue)
        {
            _ambientTimer = queue.CreateTimer();
            _ambientTimer.Interval = TimeSpan.FromSeconds(1.5);
            _ambientTimer.Tick += (_, _) =>
            {
                TickAmbient();
                TickStayAwake();
            };
            _ambientTimer.Start();
            _playbackTimer = queue.CreateTimer();
            _playbackTimer.Interval = TimeSpan.FromSeconds(1);
            _playbackTimer.Tick += (_, _) => TickPlayback();
            _playbackTimer.Start();
        }
        Shared = this;
    }

    private async Task PrepareFiltersAsync()
    {
        try
        {
            await Filters.PrepareAsync();
            Session.ApplyRules();
            await Filters.UpdateIfDueAsync();
        }
        catch (Exception error)
        {
            CrashLog.Write("filters", error);
        }
    }

    /// Hooks up what needs the window: media keys and the Now Playing flyout.
    public void AttachWindow(MainWindow window, IntPtr handle)
    {
        Window = window;
        NowPlaying.Install(this, handle);
    }

    private void SessionChanged()
    {
        ApplyTheme();
        Notify();
    }

    // MARK: State

    private Route _route = Route.Home;
    public Route Route
    {
        get => _route;
        set
        {
            if (_route == value) return;
            var old = _route;
            PreviousRoute = old;
            _route = value;
            if (value != Route.Web) _isFindVisible = false;
            Notify();
            if (old == Route.Player && value != Route.Player) ClosePlayer();
        }
    }

    public Route PreviousRoute { get; private set; } = Route.Home;

    private bool _isCommandBarVisible;
    public bool IsCommandBarVisible { get => _isCommandBarVisible; set => Set(ref _isCommandBarVisible, value); }
    public string CommandBarSeed { get; set; } = "";

    private long? _detailTitleId;
    public long? DetailTitleId { get => _detailTitleId; set => Set(ref _detailTitleId, value); }

    private AppSheet? _sheet;
    public AppSheet? Sheet { get => _sheet; set => Set(ref _sheet, value); }

    private bool _isProfilePickerVisible;
    public bool IsProfilePickerVisible { get => _isProfilePickerVisible; set => Set(ref _isProfilePickerVisible, value); }

    private bool _isFindVisible;
    public bool IsFindVisible { get => _isFindVisible; set => Set(ref _isFindVisible, value); }

    private bool _isCinema;
    public bool IsCinema { get => _isCinema; set => Set(ref _isCinema, value); }

    /// On a site with the bars tucked away, they come back while the pointer is at the top.
    private bool _isSidebarPeeking;
    public bool IsSidebarPeeking { get => _isSidebarPeeking; set => Set(ref _isSidebarPeeking, value); }

    /// The reel change between profiles is on screen.
    private bool _isChangingReel;
    public bool IsChangingReel { get => _isChangingReel; private set => Set(ref _isChangingReel, value); }

    private bool _splashVisible = true;
    public bool SplashVisible { get => _splashVisible; set => Set(ref _splashVisible, value); }

    /// This profile's settings. Setting them saves them and applies what changed (see ProfileSession).
    public AppSettings Settings
    {
        get => Session.Settings;
        set => Session.Settings = value;
    }

    public bool IsDark
    {
        get => Settings.Theme == AppTheme.Dark;
        set => Settings = Settings with { Theme = value ? AppTheme.Dark : AppTheme.White };
    }

    public Palette Palette => IsDark ? Palette.Dark : Palette.White;

    /// Puts the profile's theme on screen. Views rebuild through `Theme.Changed`.
    public void ApplyTheme() => Theme.Set(IsDark);

    public BrowserModel Browser => Session.Browser;
    public LibraryStore Library => Session.Library;

    /// Whether any site tabs are open, which shows the Browse section.
    public bool HasTabs => Browser.ListedTabs.Count > 0;

    // MARK: Profiles

    /// Swaps everything over behind the reel change transition, as a projectionist would.
    public void SwitchProfile(Profile profile)
    {
        IsProfilePickerVisible = false;
        if (profile.Id == Session.Profile.Id) return;
        _ = SwitchProfileAsync(profile);
    }

    private async Task SwitchProfileAsync(Profile profile)
    {
        IsChangingReel = true;
        await Task.Delay(260);
        Profiles.SetPoster(Session.Profile.Id, Session.LatestPosterUrl);
        // The player saves its place in this profile's database, so it stops before that closes.
        ClosePlayer();
        Session.Close();
        Ambient.Clear();
        DetailTitleId = null;
        Sheet = null;
        Route = Route.Home;
        try
        {
            var next = new ProfileSession(profile, Filters, Toasts) { App = this };
            Session = next;
            Profiles.MarkUsed(profile.Id);
            next.Start();
            ApplyTheme();
        }
        catch (Exception error)
        {
            Toasts.Show($"Couldn't open {profile.Name}'s profile: {error.Message}");
        }
        await Task.Delay(320);
        IsChangingReel = false;
    }

    /// Saves what needs saving before the app closes. Safe to call more than once.
    public void PrepareToQuit()
    {
        if (_hasQuit) return;
        _hasQuit = true;
        _ambientTimer?.Stop();
        _playbackTimer?.Stop();
        _stayAwake.Hold(false);
        try
        {
            Profiles.SetPoster(Session.Profile.Id, Session.LatestPosterUrl);
            LocalPlayback?.Stop();
            Session.Close();
        }
        catch (Exception error)
        {
            CrashLog.Write("quit", error);
        }
        Services.Updater.Shared.ApplyOnQuit();
    }

    // MARK: Navigation

    public void Go(Route destination)
    {
        Browser.EndSearch(keeping: null);
        Route = destination;
        if (destination == Route.Web) Browser.Selected?.EnsureWebView();
    }

    public void OpenCommandBar(string seed = "")
    {
        CommandBarSeed = seed;
        IsCommandBarVisible = true;
    }

    public void CloseCommandBar() => IsCommandBarVisible = false;

    public void ToggleSidebar() => Settings = Settings with { SidebarHidden = !Settings.SidebarHidden };

    public void ToggleTheme() => IsDark = !IsDark;

    public void OpenTitle(long id)
    {
        if (!Library.Titles.ContainsKey(id)) return;
        if (Route == Route.Player) Route = Route.Downloads;
        DetailTitleId = id;
    }

    /// Esc: closes whatever is on top. The Mac's views each watch for it themselves; here the window
    /// asks this once, so it works the same whichever view has focus.
    public bool HandleEscape()
    {
        if (IsCommandBarVisible) { CloseCommandBar(); return true; }
        if (IsProfilePickerVisible) { IsProfilePickerVisible = false; return true; }
        if (Sheet is not null) { Sheet = null; return true; }
        if (DetailTitleId is not null) { DetailTitleId = null; return true; }
        if (IsCinema) { ExitCinema(); return true; }
        if (IsFindVisible) { IsFindVisible = false; return true; }
        return false;
    }

    // MARK: Watching

    /// Takes you to where you stopped, on the site you stopped on.
    public void Resume(Title title)
    {
        DetailTitleId = null;
        if (Library.LatestProgress(title.Id) is { Url: { } url } progress)
        {
            Resume(url, progress.Position);
        }
        else
        {
            Browser.SearchEverywhere(title.Name, titleId: title.Id);
        }
    }

    public void Resume(Uri url, double? position)
    {
        DetailTitleId = null;
        // Stopped watching a download: carry on with the copy on this PC.
        if (url.IsFile)
        {
            if (Session.Downloads.ItemForFile(url.LocalPath) is { } download) PlayDownload(download);
            else Toasts.Show("That file isn't on this PC anymore");
            return;
        }
        Browser.Open(url, resumeAt: position, keepWatching: true);
        Route = Route.Web;
    }

    /// Carries on with whatever was watched last, or a title named by the Jump List.
    public void ContinueWatching(long? titleId = null)
    {
        var entries = Library.ContinueWatching;
        (Title Title, WatchProgress Progress)? entry = null;
        if (titleId is long id)
        {
            foreach (var candidate in entries)
            {
                if (candidate.Title.Id == id) { entry = candidate; break; }
            }
        }
        else if (entries.Count > 0)
        {
            entry = entries[0];
        }
        if (entry is { Progress.Url: { } url } found)
        {
            Resume(url, found.Progress.Position);
        }
        else if (titleId is long wanted)
        {
            OpenTitle(wanted);
        }
        else
        {
            Toasts.Show("Nothing to carry on with yet");
        }
    }

    public void OpenSite(Site site)
    {
        Browser.EndSearch(keeping: null);
        var existing = Browser.ListedTabs.FirstOrDefault(tab => DomainName.IsSameSite(tab.Url?.Host, site.Host));
        if (existing is not null)
        {
            Browser.Select(existing);
        }
        else
        {
            Browser.OpenTab(site.HomeUrl, select: true, siteId: site.Id);
        }
    }

    /// Adds whatever the current page is showing to the backlog.
    public void AddCurrentPageToBacklog()
    {
        if (Browser.Selected is not { } tab || Route != Route.Web)
        {
            Sheet = new AppSheet.AddTitle(null);
            return;
        }
        if (tab.LinkedTitleId is long id && Library.Titles.TryGetValue(id, out var linked))
        {
            if (linked.Status is TitleStatus.None or TitleStatus.Watched) Library.SetStatus(id, TitleStatus.Backlog);
            Toasts.Show($"Added {linked.Name} to backlog");
            return;
        }
        // TODO(after core merge): the page TitleParser recognised, as the Mac does:
        //   if (tab.Parsed is not { } parsed) { Sheet = new AppSheet.AddTitle(tab.Title); return; }
        //   if (Library.Find(parsed.Name, parsed.AltName, parsed.Year) is { } existing)
        //   {
        //       if (existing.Status == TitleStatus.None) Library.SetStatus(existing.Id, TitleStatus.Backlog);
        //       var status = Library.Titles.GetValueOrDefault(existing.Id)?.Status.Label.ToLowerInvariant() ?? "your library";
        //       Toasts.Show($"{existing.Name} is in {status}");
        //       return;
        //   }
        //   if (Library.AddTitle(parsed.Name, parsed.Year, parsed.KindHint, TitleStatus.Backlog,
        //           posterUrl: parsed.PosterUrl, overview: parsed.Overview) is not { } title) return;
        //   Session.Metadata.Enrich(title.Id, altName: parsed.AltName);
        //   Toasts.Show($"Added {title.Name} to backlog", "Undo", () => Library.Delete(title.Id));
        Sheet = new AppSheet.AddTitle(tab.Title);
    }

    /// Adds a title the catalogue found (the add-title sheet, the command bar).
    public void AddToBacklog(Cineon.Core.Metadata.MetadataHit hit)
    {
        if (Library.AddTitle(hit.Name, hit.Year, hit.Kind, TitleStatus.Backlog, imdbId: hit.Id, posterUrl: hit.PosterUrl) is not { } title) return;
        // Fills in the description and backdrop.
        _ = Session.Metadata.ApplyAsync(hit, title.Id);
        Toasts.Show($"Added {hit.Name} to backlog");
    }

    /// Saves the frame on screen from whatever is playing.
    public void SaveMoment()
    {
        var tab = Browser.Selected?.Media is not null ? Browser.Selected : Browser.PlayingTab;
        if (tab is null)
        {
            Toasts.Show("Play something first, then save the moment you like");
            return;
        }
        Session.Frames.SaveMoment(tab);
    }

    /// Looks for what's in this tab on the person's other sites.
    public void FindElsewhere()
    {
        if (Browser.Selected is not { } tab) return;
        Route = Route.Web;
        Session.Rescue.FindElsewhere(tab);
    }

    // MARK: Downloads

    /// Saves the video playing in the current tab to this PC.
    public void DownloadCurrentVideo()
    {
        if (Browser.Selected is not { HasWebView: true } tab || Route != Route.Web)
        {
            Toasts.Show("Open a film's page first, then download it from there");
            return;
        }
        // TODO(after core merge): Session.Downloads.Download(from: tab)
        _ = tab;
    }

    /// The Watch menu's "Download the Rest of This Season".
    public void DownloadRestOfSeason()
    {
        if (Browser.Selected is not { } tab) return;
        // TODO(after core merge): Session.Seasons.Start(from: tab, fromCurrent: true)
        _ = tab;
    }

    /// The Watch menu's "Download the Whole Series…".
    public void DownloadWholeSeries()
    {
        if (Browser.Selected is not { } tab) return;
        // TODO(after core merge): Session.Seasons.StartSeries(from: tab)
        _ = tab;
    }

    // MARK: Cinema mode

    public void ToggleCinema()
    {
        if (IsCinema) ExitCinema();
        else EnterCinema();
    }

    private void EnterCinema()
    {
        if (Browser.Selected is not { } tab || Route != Route.Web) return;
        IsCinema = true;
        tab.SetTheater(true);
        Window?.SetCaptionButtonsHidden(true);
        Toasts.Show("Press Esc to leave Cinema mode");
    }

    public void ExitCinema()
    {
        if (!IsCinema) return;
        IsCinema = false;
        Browser.Selected?.SetTheater(false);
        Window?.SetCaptionButtonsHidden(false);
    }
}

/// Short messages at the bottom of the window, sometimes with one action.
public sealed class ToastCenter : Observable
{
    public sealed record Toast(string Message, string? ActionTitle = null, Action? Run = null)
    {
        public Guid Id { get; } = Guid.NewGuid();
    }

    public Toast? Current { get; private set; }
    private CancellationTokenSource? _dismiss;

    public void Show(string message, string? actionTitle = null, Action? run = null)
    {
        // A burst of blocked pop-ups shouldn't restart the same message over and over.
        if (Current?.Message == message && Current.Run is null && run is null) return;
        Current = new Toast(message, actionTitle, run);
        Notify();
        _dismiss?.Cancel();
        var cts = _dismiss = new CancellationTokenSource();
        var delay = run is null ? 3.0 : 6.0;
        _ = DismissLater(delay, cts.Token);
    }

    private async Task DismissLater(double seconds, CancellationToken token)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(seconds), token); }
        catch (TaskCanceledException) { return; }
        Dismiss();
    }

    public void Dismiss()
    {
        if (Current is null) return;
        Current = null;
        Notify();
    }
}
