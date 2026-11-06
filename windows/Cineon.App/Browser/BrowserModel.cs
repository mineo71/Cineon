using Cineon.App.UI;
using Cineon.Core.Data;
using Cineon.Core.Parsing;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;

namespace Cineon.App.Browser;

/// All the tabs in a profile. Ported from Cineon/Browser/BrowserModel.swift. Lives on the UI thread.
public sealed class BrowserModel : Observable
{
    private readonly List<BrowserTab> _tabs = [];
    private readonly List<(Uri Url, string Title)> _recentlyClosed = [];
    private readonly Dictionary<BrowserTab, Action> _tabWatchers = [];
    private DispatcherQueueTimer? _hibernateTimer;
    private CancellationTokenSource? _save;
    private bool _isShutDown;

    public BrowserModel(ProfileSession session)
    {
        Session = session;
        Views = new WebViewHost(this);
    }

    public ProfileSession Session { get; }

    /// Where the tabs' web views live in the window. The workspace puts it in the framed screen.
    public WebViewHost Views { get; }

    public IReadOnlyList<BrowserTab> Tabs => _tabs;

    private Guid? _selectedId;
    public Guid? SelectedId
    {
        get => _selectedId;
        set
        {
            if (_selectedId == value) return;
            _selectedId = value;
            Views.ShowSelected();
            Notify();
        }
    }

    public IReadOnlyList<(Uri Url, string Title)> RecentlyClosed => _recentlyClosed;

    /// A running search across all sites.
    public SearchSession? Search { get; private set; }

    public BrowserTab? Selected => Search?.SelectedTab ?? _tabs.FirstOrDefault(t => t.Id == SelectedId);

    /// Tabs shown in the bar. Search results stay out until they're kept.
    public IReadOnlyList<BrowserTab> ListedTabs => [.. _tabs.Where(t => t.SearchGroup is null)];

    public BrowserTab? PlayingTab => _tabs.FirstOrDefault(t => t.Media?.IsPlaying == true) ?? _tabs.FirstOrDefault(t => t.Track is not null);

    /// Raised when anything a tab shows changes: its title, icon, loading, whether it plays.
    public event Action? TabChanged;

    /// The page in the selected tab has a video in fullscreen.
    public bool IsPageFullscreen => Selected?.IsFullscreen == true;

    // MARK: Startup

    public void Start()
    {
        Restore();
        if (DispatcherQueue.GetForCurrentThread() is { } queue)
        {
            _hibernateTimer = queue.CreateTimer();
            _hibernateTimer.Interval = TimeSpan.FromSeconds(60);
            _hibernateTimer.Tick += (_, _) => Safe.Run("hibernate", HibernateIdleTabs);
            _hibernateTimer.Start();
        }
        Safe.Fire("warm-up", async () =>
        {
            await Task.Delay(1200);
            if (!_isShutDown) Session.Web.WarmUp();
        });
    }

    private void Restore()
    {
        List<PersistedTab> saved;
        try { saved = Session.Db.LoadTabs(); }
        catch (Exception) { return; }
        foreach (var row in saved)
        {
            var tab = new BrowserTab(this, row.Url, row.Id, row.Title, row.FaviconUrl, row.State);
            Watch(tab);
            _tabs.Add(tab);
        }
        _selectedId = saved.FirstOrDefault(t => t.IsActive)?.Id ?? _tabs.FirstOrDefault()?.Id;
        Notify();
    }

    public void Shutdown()
    {
        if (_isShutDown) return;
        _hibernateTimer?.Stop();
        SaveNow();
        _isShutDown = true;
        _save?.Cancel();
        foreach (var tab in _tabs.ToList())
        {
            Safe.Run("tab shutdown", () =>
            {
                Session.Rescue.Stop(tab);
                Session.Tracker.TabNavigated(tab);
                tab.TearDownWebView();
            });
        }
    }

    // MARK: Tabs

    public BrowserTab OpenTab(Uri? url, bool select = true, double? resumeAt = null, long? siteId = null, bool keepWatching = false)
    {
        var tab = new BrowserTab(this, url) { OriginSiteId = siteId, PendingResume = resumeAt };
        Insert(tab, after: _tabs.FirstOrDefault(t => t.Id == SelectedId));
        if (select)
        {
            EndSearch(null);
            SelectedId = tab.Id;
            GoTo(Cineon.App.Route.Web);
        }
        if (url is not null)
        {
            if (keepWatching) tab.LoadToKeepWatching(url, resumeAt);
            else tab.Load(url, resumeAt);
        }
        ScheduleSave();
        return tab;
    }

    /// Opens an address in a tab already showing that page, if there is one.
    public void Open(Uri url, double? resumeAt = null, long? siteId = null, bool keepWatching = false)
    {
        var key = UrlKey.Make(url);
        if (ListedTabs.FirstOrDefault(t => t.Url is { } address && UrlKey.Make(address) == key) is { } existing)
        {
            Select(existing);
            if (existing.Media is not null)
            {
                if (resumeAt is { } position) existing.Seek(position);
                if (keepWatching) existing.PlayerCommand("play()");
            }
            else
            {
                // Nothing is playing there yet, or the tab has just woken up. Jump once it's ready.
                existing.PendingResume = resumeAt;
            }
            return;
        }
        OpenTab(url, select: true, resumeAt: resumeAt, siteId: siteId, keepWatching: keepWatching);
    }

    public void Select(BrowserTab tab)
    {
        EndSearch(null);
        SelectedId = tab.Id;
        tab.LastActiveAt = DateTimeOffset.Now;
        GoTo(Cineon.App.Route.Web);
        tab.EnsureWebView();
        ScheduleSave();
    }

    public void Close(BrowserTab tab)
    {
        Session.Rescue.Stop(tab);
        Session.Tracker.TabNavigated(tab);
        if (tab.Url is { } url)
        {
            _recentlyClosed.Add((url, tab.DisplayTitle));
            if (_recentlyClosed.Count > 20) _recentlyClosed.RemoveAt(0);
        }
        var listed = ListedTabs;
        var index = listed.ToList().FindIndex(t => t.Id == tab.Id);
        tab.TearDownWebView();
        _tabs.RemoveAll(t => t.Id == tab.Id);
        Unwatch(tab);

        if (SelectedId == tab.Id)
        {
            var remaining = ListedTabs;
            if (index >= 0 && remaining.Count > 0)
            {
                var next = remaining[Math.Min(index, remaining.Count - 1)];
                SelectedId = next.Id;
                next.EnsureWebView();
            }
            else
            {
                SelectedId = null;
                GoTo(Cineon.App.Route.Home);
            }
        }
        Notify();
        ScheduleSave();
    }

    public void ReopenClosed()
    {
        if (_recentlyClosed.Count == 0) return;
        var last = _recentlyClosed[^1];
        _recentlyClosed.RemoveAt(_recentlyClosed.Count - 1);
        OpenTab(last.Url);
    }

    /// Drags a tab in the strip from one place to another.
    public void Move(int from, int to)
    {
        var listed = ListedTabs.ToList();
        if (from < 0 || from >= listed.Count) return;
        var tab = listed[from];
        listed.RemoveAt(from);
        listed.Insert(Math.Clamp(to > from ? to - 1 : to, 0, listed.Count), tab);
        var others = _tabs.Where(t => t.SearchGroup is not null).ToList();
        _tabs.Clear();
        _tabs.AddRange(listed);
        _tabs.AddRange(others);
        Notify();
        ScheduleSave();
    }

    public void SelectTab(int index)
    {
        var listed = ListedTabs;
        if (index < 0 || index >= listed.Count) return;
        Select(listed[index]);
    }

    public void SelectAdjacent(int delta)
    {
        var listed = ListedTabs;
        if (listed.Count == 0) return;
        var current = Math.Max(0, listed.ToList().FindIndex(t => t.Id == SelectedId));
        Select(listed[((current + delta) % listed.Count + listed.Count) % listed.Count]);
    }

    /// A page asked for a new window and the pop-up shield let it: it becomes a tab beside its opener.
    internal void AdoptPopup(CoreWebView2NewWindowRequestedEventArgs args, Uri? target, BrowserTab opener)
    {
        var tab = new BrowserTab(this, target);
        Insert(tab, after: opener);
        EndSearch(null);
        SelectedId = tab.Id;
        GoTo(Cineon.App.Route.Web);
        tab.AdoptPopup(args);
        ScheduleSave();
    }

    /// Only one film at a time. Starting a video pauses any other tab that was playing.
    public void PauseOthers(BrowserTab tab)
    {
        foreach (var other in _tabs)
        {
            if (!ReferenceEquals(other, tab) && other.Media?.IsPlaying == true) other.PausePlayback();
        }
    }

    private void HibernateIdleTabs()
    {
        var limit = Session.Settings.HibernateMinutes * 60;
        if (limit <= 0) return;
        var cutoff = DateTimeOffset.Now.AddSeconds(-limit);
        foreach (var tab in _tabs)
        {
            if (!tab.IsHibernated && tab.Id != SelectedId && tab.LastActiveAt < cutoff) tab.Hibernate();
        }
    }

    /// The page's video went fullscreen, or came back. The window follows, the way the Mac gives
    /// the video a window of its own.
    internal void FullscreenChanged(BrowserTab tab, bool on)
    {
        if (on && !ReferenceEquals(Selected, tab)) return;
        if (Session.App?.Window is { } window)
        {
            Safe.Run("fullscreen", () => window.AppWindow.SetPresenter(on ? AppWindowPresenterKind.FullScreen : AppWindowPresenterKind.Overlapped));
        }
        Notify();
        Session.App?.BrowserLayoutChanged();
    }

    private void Insert(BrowserTab tab, BrowserTab? after)
    {
        var index = after is null ? -1 : _tabs.IndexOf(after);
        if (index >= 0) _tabs.Insert(index + 1, tab);
        else _tabs.Add(tab);
        Watch(tab);
        Notify();
    }

    private void Watch(BrowserTab tab)
    {
        void Handler() => TabChanged?.Invoke();
        tab.Changed += Handler;
        _tabWatchers[tab] = Handler;
    }

    private void Unwatch(BrowserTab tab)
    {
        if (_tabWatchers.Remove(tab, out var handler)) tab.Changed -= handler;
    }

    private void GoTo(Cineon.App.Route route)
    {
        if (Session.App is { } app) app.Route = route;
    }

    // MARK: Learning from pages

    public void LearnFromPage(PageMeta meta, BrowserTab tab)
    {
        if (tab.Url is not { } url || Session.Library.SiteForHost(WatchTracker.Host(url)) is not { } site) return;
        var changed = false;
        if (site.SearchTemplate is null && meta.Search is { } template)
        {
            site = site with { SearchTemplate = template };
            changed = true;
        }
        if (Urls.Parse(meta.Icon) is { } icon && site.IconUrl?.OriginalString != icon.OriginalString)
        {
            site = site with { IconUrl = icon };
            changed = true;
        }
        if (changed) Session.Library.UpdateSite(site);
    }

    // MARK: Search everywhere

    public void SearchEverywhere(string query, long? titleId = null)
    {
        EndSearch(null);
        var sites = Session.Library.Sites.Where(s => s.SearchTemplate is not null).ToList();
        if (sites.Count == 0)
        {
            Session.Toasts.Show("None of your sites has search set up. Add one in Settings.");
            return;
        }
        var group = Guid.NewGuid();
        var results = new List<SearchSession.Result>();
        foreach (var site in sites)
        {
            if (site.SearchUrl(query) is not { } url) continue;
            var tab = new BrowserTab(this, url) { SearchGroup = group };
            _tabs.Add(tab);
            Watch(tab);
            results.Add(new SearchSession.Result(site, tab, url));
        }
        if (results.Count == 0) return;
        var search = new SearchSession(this, group, query, results);
        Search = search;
        GoTo(Cineon.App.Route.Web);
        search.Select(results[0].Id);
        Notify();

        // Load the next few in the background, so flipping between sites is instant.
        foreach (var result in results.Skip(1).Take(3)) result.Tab.Load(result.Url);
    }

    /// Closes the search. A result you clicked through, or are watching, stays as a normal tab:
    /// moving on from a search should never lose the film you found with it.
    public void EndSearch(BrowserTab? keeping)
    {
        if (Search is not { } current) return;
        BrowserTab? keptSelected = null;
        foreach (var result in current.Results)
        {
            var tab = result.Tab;
            var clickedThrough = !tab.IsHibernated && (tab.Url is null || UrlKey.Make(tab.Url) != UrlKey.Make(result.Url));
            if (ReferenceEquals(tab, keeping) || clickedThrough || tab.Track is not null)
            {
                tab.SearchGroup = null;
                if (ReferenceEquals(tab, keeping) || ReferenceEquals(tab, current.SelectedTab)) keptSelected = tab;
            }
            else
            {
                Session.Tracker.TabNavigated(tab);
                tab.TearDownWebView();
                _tabs.RemoveAll(t => t.Id == tab.Id);
                Unwatch(tab);
            }
        }
        Search = null;
        if (keptSelected is not null) _selectedId = keptSelected.Id;
        Views.ShowSelected();
        Notify();
        ScheduleSave();
    }

    internal void SearchSelectionChanged()
    {
        Views.ShowSelected();
        Notify();
    }

    // MARK: Saving

    public void ScheduleSave()
    {
        if (_isShutDown) return;
        _save?.Cancel();
        var cancellation = _save = new CancellationTokenSource();
        Safe.Fire("save tabs", async () =>
        {
            await Task.Delay(1500, cancellation.Token);
            if (!_isShutDown) SaveNow();
        });
    }

    public void SaveNow()
    {
        if (_isShutDown) return;
        var snapshot = ListedTabs.Select((tab, index) => new PersistedTab
        {
            Id = tab.Id,
            Url = tab.Url,
            Title = tab.Title,
            FaviconUrl = tab.FaviconUrl,
            Position = index,
            IsActive = tab.Id == SelectedId,
            // WebView2 has no state to save. A Mac's, if this tab hasn't woken here, is kept for it.
            State = tab.RestoreState,
            IsPinnedToSearch = false,
        }).ToList();
        try { Session.Db.SaveTabs(snapshot); }
        catch (Exception error) { CrashLog.Write("save tabs", error); }
    }

    // MARK: Debug

    /// What the end-to-end tests read, like the Mac's `/state`: the selected tab's lines plus the
    /// tab list and search.
    public IReadOnlyDictionary<string, string> DebugState()
    {
        var state = new Dictionary<string, string>(Selected?.DebugState() ?? new Dictionary<string, string>())
        {
            ["tabs"] = _tabs.Count.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["tablist"] = string.Join(",", _tabs.Select(t => $"{t.Url?.OriginalString ?? "-"}[{(t.IsHibernated ? "h" : "a")}]")),
            ["search"] = Search is { } search ? string.Join(",", search.Results.Select(r => r.Url.OriginalString)) : "-",
            ["selected"] = SelectedId is { } id ? Database.UuidString(id) : "-",
            ["pageFullscreen"] = IsPageFullscreen ? "true" : "false",
        };
        return state;
    }
}

/// One query running across every site with search set up.
public sealed class SearchSession : Observable
{
    public sealed record Result(Site Site, BrowserTab Tab, Uri Url)
    {
        public long Id => Site.Id;
    }

    private readonly BrowserModel _browser;

    public SearchSession(BrowserModel browser, Guid id, string query, IReadOnlyList<Result> results)
    {
        _browser = browser;
        Id = id;
        Query = query;
        Results = results;
        SelectedResultId = results.FirstOrDefault()?.Id;
    }

    public Guid Id { get; }
    public string Query { get; }
    public IReadOnlyList<Result> Results { get; }
    public long? SelectedResultId { get; private set; }

    public BrowserTab? SelectedTab => Results.FirstOrDefault(r => r.Id == SelectedResultId)?.Tab;

    public void Select(long id)
    {
        SelectedResultId = id;
        if (Results.FirstOrDefault(r => r.Id == id) is { } result && result.Tab.IsHibernated && !result.Tab.HasWebView)
        {
            result.Tab.Load(result.Url);
        }
        Notify();
        _browser.SearchSelectionChanged();
    }
}

/// Holds the tabs' web views in the window. Every live tab's WebView2 stays here from when it's
/// made until it's torn down, and only the selected one is shown: moving a WebView2 between
/// parents isn't something to rely on, and a hidden one keeps playing like a background tab.
public sealed class WebViewHost : Grid
{
    private readonly BrowserModel _browser;
    private readonly Dictionary<WebView2, BrowserTab> _owners = [];

    public WebViewHost(BrowserModel browser)
    {
        _browser = browser;
    }

    public void Add(BrowserTab tab, WebView2 control)
    {
        _owners[control] = tab;
        control.Visibility = Visibility.Collapsed;
        Children.Add(control);
        ShowSelected();
    }

    public void Remove(WebView2 control)
    {
        _owners.Remove(control);
        Children.Remove(control);
    }

    /// Shows the selected tab's web view, and only when it has somewhere to be.
    public void ShowSelected()
    {
        var selected = _browser.Selected;
        foreach (var (control, tab) in _owners)
        {
            var show = ReferenceEquals(tab, selected) && tab.Url is not null;
            var visibility = show ? Visibility.Visible : Visibility.Collapsed;
            if (control.Visibility != visibility) control.Visibility = visibility;
        }
    }
}
