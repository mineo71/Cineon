using Cineon.App.UI;
using Cineon.Core.Data;
using Cineon.Core.Downloads;
using Cineon.Core.Shields;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;

namespace Cineon.App.Browser;

// The tab's WebView2: making it, wiring its events, navigation and the shields. The Mac's
// "Lifecycle", "Navigation commands", WKNavigationDelegate and WKUIDelegate parts.
public sealed partial class BrowserTab
{
    /// The XAML control, for tabs on screen.
    private WebView2? _control;
    /// The parked controller, for helper tabs.
    private HeadlessWebView? _headless;
    /// Ready to use: events wired, scripts installed.
    private CoreWebView2? _core;
    private ScriptBridge? _bridge;
    /// Bumped whenever the web view goes away, so late callbacks from the old one are ignored.
    private int _generation;
    /// Where to go once the web view is ready.
    private Uri? _pendingNavigation;
    private string? _zoomScriptId;
    /// The main frame's address as last committed, and the one being navigated to.
    private string? _documentUrl;
    private string? _pendingMainUrl;
    /// A download took this navigation over, so its failure isn't a failure.
    private bool _downloadTookOver;
    /// `_pendingMainUrl` without its fragment, which requests and responses never carry.
    private string? _pendingMainRequest;
    /// Bumped with every zoom change, so a slower earlier one doesn't win.
    private int _zoomSequence;
    /// The main-frame navigation in flight, so a cancelled or replaced one's end is ignored.
    private ulong? _navigationId;
    /// The host of `_documentUrl`, worked out once per page rather than per request.
    private (string? Url, string? Host) _documentHost;

    /// The control on screen, for the window to place. Null while hibernated and for helpers.
    public WebView2? Control => _control;

    /// The ready WebView2, for capture and debugging. Null until it's ready.
    public CoreWebView2? Core => _core;

    public bool HasWebView => _control is not null || _headless is not null || _isMakingHelper;

    /// A helper's parked web view is on its way, so a second one mustn't be started.
    private bool _isMakingHelper;

    // MARK: Lifecycle

    /// Creates the web view on first need, which is why opening with many tabs stays instant.
    public void EnsureWebView()
    {
        if (HasWebView) return;
        if (IsHelper)
        {
            MakeHelperWebView();
            return;
        }
        if (Session.Web.IsTornDown) return;
        var control = MakeControl();
        var generation = _generation;
        Safe.Fire("web view", () => InitializeAsync(control, generation, null, null));
    }

    private WebView2 MakeControl()
    {
        var control = new WebView2 { DefaultBackgroundColor = Theme.P.CardFill };
        _control = control;
        IsHibernated = false;
        Browser.Views.Add(this, control);
        // A brand new web view loads the tab's address by itself, once it's ready.
        _pendingNavigation ??= Url;
        if (Url is not null) _trustedNavigation = true;
        RestoreState = null;
        return control;
    }

    private async Task InitializeAsync(WebView2 control, int generation, CoreWebView2NewWindowRequestedEventArgs? popup,
        Windows.Foundation.Deferral? deferral, Action? adopted = null)
    {
        var isAdopted = false;
        try
        {
            var environment = await Session.Web.EnvironmentAsync();
            if (generation != _generation) return;
            await control.EnsureCoreWebView2Async(environment);
            if (generation != _generation || control.CoreWebView2 is not { } core) return;
            await AttachAsync(core, generation);
            if (generation != _generation) return;
            if (popup is not null)
            {
                popup.NewWindow = core;
                isAdopted = true;
            }
            else
            {
                NavigatePending();
            }
        }
        catch (Exception error)
        {
            CrashLog.Write("web view", error);
            if (generation == _generation)
            {
                // Let a later Load or Reload try again with a new web view.
                TearDownWebView();
                IsHibernated = true;
                Failure = new LoadFailure(Url is { } url ? WatchTracker.Host(url) ?? "This site" : "This site",
                    "Cineon couldn't start its web view. Check that the Microsoft Edge WebView2 Runtime is installed.", Url);
            }
        }
        finally
        {
            // A pop-up that didn't get its tab must not open in a window of WebView2's own.
            if (popup is not null && !isAdopted) popup.Handled = true;
            deferral?.Complete();
            if (isAdopted) Safe.Run("pop-up adopted", () => adopted?.Invoke());
        }
    }

    /// For helper tabs, which never sit in the window: never throttled, so their players load.
    public void MakeHelperWebView()
    {
        if (HasWebView || Session.Web.IsTornDown) return;
        IsHibernated = false;
        var generation = _generation;
        _pendingNavigation ??= Url;
        _isMakingHelper = true;
        Safe.Fire("helper web view", async () =>
        {
            HeadlessWebView? headless;
            try
            {
                headless = await HeadlessWebView.CreateAsync(Session.Web);
            }
            finally
            {
                if (generation == _generation) _isMakingHelper = false;
            }
            if (headless is null) return;
            if (generation != _generation)
            {
                headless.Close();
                return;
            }
            _headless = headless;
            await AttachAsync(headless.Core, generation);
            if (generation != _generation) return;
            NavigatePending();
        });
    }

    /// Opens as the new window a page asked for, so `window.opener` still works. `adopted` runs
    /// once the page has its new window.
    internal void AdoptPopup(CoreWebView2NewWindowRequestedEventArgs args, Action? adopted = null)
    {
        var deferral = args.GetDeferral();
        var control = MakeControl();
        _pendingNavigation = null;
        var generation = _generation;
        Safe.Fire("pop-up web view", () => InitializeAsync(control, generation, args, deferral, adopted));
    }

    private async Task AttachAsync(CoreWebView2 core, int generation)
    {
        WebEnvironment.Configure(core);
        var bridge = new ScriptBridge(core);
        bridge.Received += message => { if (generation == _generation) Receive(message); };

        core.NavigationStarting += On<CoreWebView2NavigationStartingEventArgs>(generation, "navigation starting", NavigationStarting);
        core.SourceChanged += On<CoreWebView2SourceChangedEventArgs>(generation, "address", (c, _) => { _documentUrl = c.Source; UrlChanged(c.Source); });
        core.ContentLoading += On<CoreWebView2ContentLoadingEventArgs>(generation, "commit", ContentLoading);
        core.DOMContentLoaded += On<CoreWebView2DOMContentLoadedEventArgs>(generation, "document ready", (_, _) => { if (IsLoading) Progress = Math.Max(Progress, 0.8); });
        core.NavigationCompleted += On<CoreWebView2NavigationCompletedEventArgs>(generation, "navigation completed", NavigationCompleted);
        core.DocumentTitleChanged += On<object>(generation, "title", (c, _) => TitleChanged(c.DocumentTitle));
        core.HistoryChanged += On<object>(generation, "history", (c, _) => { CanGoBack = c.CanGoBack; CanGoForward = c.CanGoForward; });
        core.NewWindowRequested += On<CoreWebView2NewWindowRequestedEventArgs>(generation, "new window", NewWindowRequested);
        core.WebResourceRequested += On<CoreWebView2WebResourceRequestedEventArgs>(generation, "shields", ResourceRequested);
        core.WebResourceResponseReceived += On<CoreWebView2WebResourceResponseReceivedEventArgs>(generation, "response", ResponseReceived);
        core.DownloadStarting += On<CoreWebView2DownloadStartingEventArgs>(generation, "download", DownloadStarting);
        core.ScriptDialogOpening += On<CoreWebView2ScriptDialogOpeningEventArgs>(generation, "dialog", ScriptDialogOpening);
        core.PermissionRequested += On<CoreWebView2PermissionRequestedEventArgs>(generation, "permission", PermissionRequested);
        core.LaunchingExternalUriScheme += On<CoreWebView2LaunchingExternalUriSchemeEventArgs>(generation, "external scheme", (_, e) => e.Cancel = true);
        core.ProcessFailed += On<CoreWebView2ProcessFailedEventArgs>(generation, "process failed", ProcessFailed);
        core.WindowCloseRequested += On<object>(generation, "window close", (_, _) => { if (!IsHelper) Browser.Close(this); });
        core.ContainsFullScreenElementChanged += On<object>(generation, "fullscreen", (c, _) => FullscreenChanged(c.ContainsFullScreenElement));
        core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.All);

        Action scriptsChanged = () => Safe.Fire("page scripts", () => InstallScriptsAsync(bridge, generation));
        Session.Web.ScriptsChanged += scriptsChanged;
        _detach = () => Session.Web.ScriptsChanged -= scriptsChanged;

        await InstallScriptsAsync(bridge, generation);
        if (generation != _generation) return;
        if (_zoom != 1)
        {
            var id = await core.AddScriptToExecuteOnDocumentCreatedAsync(PageExtras.Zoom(_zoom));
            if (generation != _generation) return;
            _zoomScriptId = id;
        }
        _bridge = bridge;
        _core = core;
        CanGoBack = core.CanGoBack;
        CanGoForward = core.CanGoForward;
        Notify();
    }

    private Action? _detach;

    private async Task InstallScriptsAsync(ScriptBridge bridge, int generation)
    {
        if (generation != _generation) return;
        await bridge.InstallAsync(Session.Web.OverlaySweeper, WebEnvironment.ExtraScripts());
    }

    /// A WebView2 event handler that's ignored once its web view is gone, and logged if it throws.
    private Windows.Foundation.TypedEventHandler<CoreWebView2, TArgs> On<TArgs>(int generation, string where, Action<CoreWebView2, TArgs> body) =>
        Safe.On<CoreWebView2, TArgs>(where, (core, args) =>
        {
            if (generation == _generation) body(core, args);
        });

    private void NavigatePending()
    {
        if (_core is not { } core || _pendingNavigation is not { } target) return;
        _pendingNavigation = null;
        Navigate(core, target);
    }

    private void Navigate(CoreWebView2 core, Uri target)
    {
        try
        {
            core.Navigate(target.IsAbsoluteUri ? target.AbsoluteUri : target.OriginalString);
        }
        catch (ArgumentException)
        {
            Failure = new LoadFailure(WatchTracker.Host(target) ?? "This site", "That address can't be opened.", target);
        }
    }

    /// Frees the web view's memory but keeps its place. Waking it loads the address again.
    public void Hibernate()
    {
        if (!HasWebView || Media?.IsPlaying == true || IsFullscreen) return;
        Session.Tracker.TabNavigated(this);
        TearDownWebView();
        IsHibernated = true;
    }

    public void TearDownWebView()
    {
        if (!HasWebView && _core is null) return;
        _generation++;
        _detach?.Invoke();
        _detach = null;
        if (_core is { } core)
        {
            try
            {
                core.Stop();
                _ = core.ExecuteScriptAsync("document.querySelectorAll('video,audio').forEach((m) => { try { m.pause(); } catch (_) {} })");
            }
            catch (Exception)
            {
                // The browser process may already be gone.
            }
        }
        if (IsFullscreen) FullscreenChanged(false);
        _core = null;
        _bridge = null;
        _zoomScriptId = null;
        if (_control is { } control)
        {
            _control = null;
            Browser.Views.Remove(control);
            try { control.Close(); }
            catch (Exception) { }
        }
        _headless?.Close();
        _headless = null;
        _isMakingHelper = false;
        MediaFrame = null;
        _hasMediaFrame = false;
        _mediaFrameUrl = null;
        _documentUrl = null;
        _pendingMainUrl = null;
        _pendingMainRequest = null;
        _navigationId = null;
        _findTerm = null;
        _zoomSequence++;
        _sniffed.Clear();
        ForgetSources();
        IsLoading = false;
        Notify();
    }

    // MARK: Navigation commands

    public void Load(Uri target)
    {
        Session.Rescue.Stop(this);
        Url = target;
        Failure = null;
        _trustedNavigation = true;
        _pendingNavigation = target;
        if (_core is not null) NavigatePending();
        else EnsureWebView();
        if (Session.Library.SiteForHost(WatchTracker.Host(target)) is { } site) NoteSiteUsed(site);
    }

    /// Resume playback at a specific place, used by "resume" buttons everywhere.
    public void Load(Uri target, double? resumingAt)
    {
        PendingResume = resumingAt;
        Load(target);
    }

    /// Carries on watching at a new address: the video there may start by itself, with sound.
    public void LoadToKeepWatching(Uri target, double? resumingAt = null)
    {
        _autoplayKey = UrlKey.Make(target);
        Load(target, resumingAt);
    }

    private bool WantsAutoplay(string? target)
    {
        if (_autoplayKey is null || Urls.Parse(target) is not { } url) return false;
        return UrlKey.Make(url) == _autoplayKey;
    }

    public void GoBack()
    {
        _trustedNavigation = true;
        Try(() => _core?.GoBack());
    }

    public void GoForward()
    {
        _trustedNavigation = true;
        Try(() => _core?.GoForward());
    }

    public void Reload()
    {
        Failure = null;
        _trustedNavigation = true;
        if (_core is { } core && Urls.Parse(core.Source) is { Scheme: not "about" })
        {
            Try(core.Reload);
        }
        else if (Url is { } url)
        {
            _pendingNavigation = url;
            if (_core is not null) NavigatePending();
            else EnsureWebView();
        }
    }

    public void Stop() => Try(() => _core?.Stop());

    public void Zoom(double delta) => SetZoom(Math.Min(3, Math.Max(0.5, _zoom + delta)));

    public void ResetZoom() => SetZoom(1);

    private void SetZoom(double factor)
    {
        if (Math.Abs(factor - _zoom) < 0.001 || _core is not { } core) return;
        _zoom = Math.Round(factor, 2);
        var generation = _generation;
        var sequence = ++_zoomSequence;
        var zoom = _zoom;
        Safe.Fire("zoom", async () =>
        {
            if (_zoomScriptId is { } old) core.RemoveScriptToExecuteOnDocumentCreated(old);
            _zoomScriptId = null;
            var script = PageExtras.Zoom(zoom);
            if (zoom != 1)
            {
                var id = await core.AddScriptToExecuteOnDocumentCreatedAsync(script);
                // A later change, or a new web view, has taken over.
                if (generation != _generation || sequence != _zoomSequence)
                {
                    if (generation == _generation) core.RemoveScriptToExecuteOnDocumentCreated(id);
                    return;
                }
                _zoomScriptId = id;
            }
            await core.ExecuteScriptAsync(script);
        });
        Notify();
    }

    // MARK: Navigation policy

    private void NavigationStarting(CoreWebView2 core, CoreWebView2NavigationStartingEventArgs args)
    {
        var raw = args.Uri;
        if (!Allows(core, args, Urls.Parse(raw)))
        {
            args.Cancel = true;
            return;
        }
        _pendingMainUrl = raw;
        _pendingMainRequest = WithoutFragment(raw);
        _navigationId = args.NavigationId;
        _missingPageUrl = null;
        _downloadTookOver = false;
        Failure = null;
        IsLoading = true;
        Progress = 0.1;
    }

    /// The Mac's `policy(for:in:)`: other apps' links never open silently, and a page can't send
    /// you somewhere you didn't ask to go.
    private bool Allows(CoreWebView2 core, CoreWebView2NavigationStartingEventArgs args, Uri? target)
    {
        if (target is null) return true;

        // magnet:, ms-windows-store: and friends can launch other apps. Never allow that silently.
        var scheme = target.Scheme.ToLowerInvariant();
        if (scheme is not ("http" or "https" or "about" or "blob" or "data" or "file"))
        {
            BlockRedirect(target);
            return false;
        }

        var settings = Session.Settings;
        var currentHost = CommittedHost;
        var targetHost = WatchTracker.Host(target);
        var prefs = Session.Shields.PrefsFor(currentHost);

        if (args.NavigationKind is CoreWebView2NavigationKind.BackOrForward or CoreWebView2NavigationKind.Reload)
        {
            _trustedNavigation = true;
            return true;
        }

        // A link or form someone pressed, or a form a page submits by itself (always allowed on the Mac).
        if (!args.IsRedirected && (args.IsUserInitiated || _lastLink is { Form: true }) && RecentLink(target) is { } link)
        {
            // A link inside a frame trying to replace the whole page is a classic hijack.
            if (!link.Top && !link.Form && settings.RedirectShield && !prefs.ShieldsOff && !prefs.AllowRedirects
                && !DomainName.IsSameSite(currentHost, targetHost))
            {
                BlockRedirect(target);
                return false;
            }
            _trustedNavigation = true;
            return true;
        }

        // WebKit's `.other`: scripts, and redirects.
        if (!settings.RedirectShield || prefs.ShieldsOff || prefs.AllowRedirects) return true;
        // No committed page yet, or part of a chain the person started: a normal redirect.
        if (currentHost is null || _trustedNavigation) return true;
        if (DomainName.IsSameSite(currentHost, targetHost)) return true;
        if (scheme is "about" or "blob" or "data") return true;
        BlockRedirect(target);
        return false;
    }

    /// The link or form someone pressed for this navigation, within the last few seconds.
    private (string Href, bool Top, bool Form, DateTimeOffset At)? RecentLink(Uri target)
    {
        if (_lastLink is not { } link || (DateTimeOffset.Now - link.At).TotalSeconds > 5) return null;
        _lastLink = null;
        if (link.Form) return link;
        static string Bare(string url) => url.Split('#')[0];
        var targetText = target.IsAbsoluteUri ? target.AbsoluteUri : target.OriginalString;
        var linked = Urls.Parse(link.Href);
        var linkedText = linked is { IsAbsoluteUri: true } ? linked.AbsoluteUri : link.Href;
        return Bare(linkedText) == Bare(targetText) || Bare(link.Href) == Bare(target.OriginalString) ? link : null;
    }

    private void ContentLoading(CoreWebView2 core, CoreWebView2ContentLoadingEventArgs args)
    {
        Progress = Math.Max(Progress, 0.5);
        if (args.IsErrorPage) return;
        _findTerm = null;
        _trustedNavigation = false;
        Session.Rescue.Stop(this);
        if (!WantsAutoplay(core.Source)) _autoplayKey = null;
        Blocked = new ShieldStats();
        IsTheaterOn = false;
        ForgetSources();
        _sniffed.Clear();
        // Reloads don't change the address, so save progress here as well.
        Session.Tracker.TabNavigated(this);
        _documentUrl = core.Source;
        if (Urls.Parse(core.Source) is { } committed) NoticeSiteMove(committed);
    }

    private void NavigationCompleted(CoreWebView2 core, CoreWebView2NavigationCompletedEventArgs args)
    {
        // One the policy cancelled, or one another navigation replaced.
        if (_navigationId is { } current && args.NavigationId != current) return;
        _navigationId = null;
        _trustedNavigation = false;
        IsLoading = false;
        Progress = 1;
        CanGoBack = core.CanGoBack;
        CanGoForward = core.CanGoForward;
        // An HTTP error page is still a page the server sent, which WebKit counts as a finished load.
        if (args.IsSuccess || args.HttpStatusCode > 0)
        {
            Browser.ScheduleSave();
            if (_missingPageUrl is { } gone)
            {
                _missingPageUrl = null;
                if (!IsHelper) Session.Rescue.PageMissing(this, gone);
            }
            return;
        }
        Report(args.WebErrorStatus);
    }

    private void Report(CoreWebView2WebErrorStatus status)
    {
        // Cancelled means something replaced this load; a download may also have taken it over.
        if (status == CoreWebView2WebErrorStatus.OperationCanceled || _downloadTookOver)
        {
            _downloadTookOver = false;
            return;
        }
        if (IsHelper) return;
        var failing = Urls.Parse(_pendingMainUrl) ?? Url;
        Failure = new LoadFailure((failing is null ? null : WatchTracker.Host(failing)) ?? "This site", Explain(status), failing);
        // Offline, every site looks dead. Going looking would only make things worse.
        if (status != CoreWebView2WebErrorStatus.Disconnected) Session.Rescue.PageFailed(this, failing);
    }

    private static string Explain(CoreWebView2WebErrorStatus status) => status switch
    {
        CoreWebView2WebErrorStatus.HostNameNotResolved => "This address no longer exists. The site may have moved to a new one.",
        CoreWebView2WebErrorStatus.Disconnected => "Your PC is offline. Check the connection, then try again.",
        CoreWebView2WebErrorStatus.Timeout => "The site took too long to answer.",
        CoreWebView2WebErrorStatus.CannotConnect or CoreWebView2WebErrorStatus.ConnectionAborted
            or CoreWebView2WebErrorStatus.ConnectionReset or CoreWebView2WebErrorStatus.ServerUnreachable =>
            "The site refused the connection. It may be down.",
        CoreWebView2WebErrorStatus.CertificateCommonNameIsIncorrect or CoreWebView2WebErrorStatus.CertificateExpired
            or CoreWebView2WebErrorStatus.ClientCertificateContainsErrors or CoreWebView2WebErrorStatus.CertificateRevoked
            or CoreWebView2WebErrorStatus.CertificateIsInvalid => "The site's security certificate isn't valid.",
        CoreWebView2WebErrorStatus.RedirectFailed => "The site kept redirecting and never arrived anywhere.",
        _ => "The page couldn't be loaded.",
    };

    /// Statuses that mean the film isn't here, leaving out those a bot check also uses.
    private static bool IsGone(int status, CoreWebView2HttpResponseHeaders headers)
    {
        try
        {
            if (headers.Contains("cf-mitigated")) return false;
        }
        catch (Exception)
        {
        }
        return status is 404 or 410 or 451 or 500 or 502 or 503 or 504 or 520 or 521 or 522 or 523 or 524 or 525 or 526;
    }

    private void ProcessFailed(CoreWebView2 core, CoreWebView2ProcessFailedEventArgs args)
    {
        // Crashed or killed by the system. Recover quietly if it's the tab being looked at.
        var isSelected = Browser.SelectedId == Id;
        if (args.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
        {
            Session.Web.BrowserProcessFailed();
            TearDownWebView();
            IsHibernated = true;
            if (isSelected) EnsureWebView();
            return;
        }
        if (args.ProcessFailedKind is CoreWebView2ProcessFailedKind.RenderProcessExited or CoreWebView2ProcessFailedKind.RenderProcessUnresponsive
            && isSelected)
        {
            Try(core.Reload);
        }
    }

    private void FullscreenChanged(bool on)
    {
        if (IsFullscreen == on) return;
        IsFullscreen = on;
        if (!IsHelper) Browser.FullscreenChanged(this, on);
    }

    // MARK: Windows and dialogs

    private void NewWindowRequested(CoreWebView2 core, CoreWebView2NewWindowRequestedEventArgs args)
    {
        if (IsHelper)
        {
            args.Handled = true;
            return;
        }
        var target = Urls.Parse(args.Uri);
        var fromHost = CommittedHost;
        var prefs = Session.Shields.PrefsFor(fromHost);
        var realClick = args.IsUserInitiated;
        var sameSite = DomainName.IsSameSite(target is null ? null : WatchTracker.Host(target), fromHost);
        var allowed = !Session.Settings.PopupShield || prefs.ShieldsOff || prefs.AllowPopups || (sameSite && realClick);
        if (!allowed)
        {
            args.Handled = true;
            BlockPopup(target);
            return;
        }
        Browser.AdoptPopup(args, target, this);
    }

    /// A site never gets to interrupt the film with a modal dialog: alerts are dismissed, confirms
    /// answered no, prompts left empty. Leaving a page is always allowed, as WebKit allows it.
    private static void ScriptDialogOpening(CoreWebView2 core, CoreWebView2ScriptDialogOpeningEventArgs args)
    {
        if (args.Kind == CoreWebView2ScriptDialogKind.Beforeunload) args.Accept();
    }

    private void PermissionRequested(CoreWebView2 core, CoreWebView2PermissionRequestedEventArgs args)
    {
        switch (args.PermissionKind)
        {
            case CoreWebView2PermissionKind.Camera or CoreWebView2PermissionKind.Microphone or CoreWebView2PermissionKind.Notifications:
                args.State = CoreWebView2PermissionState.Deny;
                break;
            case CoreWebView2PermissionKind.Autoplay:
                // For the episode someone asked to carry on with, and for helpers that only play
                // to make the player ask for its file.
                if (IsHelper || WantsAutoplay(args.Uri) || WantsAutoplay(core.Source)) args.State = CoreWebView2PermissionState.Allow;
                break;
        }
    }

    // MARK: Requests

    /// The ad and tracker rules, for every request the tab makes, frames and workers included.
    private void ResourceRequested(CoreWebView2 core, CoreWebView2WebResourceRequestedEventArgs args)
    {
        var rules = Session.Web.Rules;
        if (rules.IsEmpty) return;
        var uri = args.Request.Uri;
        var type = (ResourceType)(int)args.ResourceContext;
        var isMainFrame = type == ResourceType.Document && uri == _pendingMainRequest;
        var document = isMainFrame ? uri : _documentUrl ?? _pendingMainUrl;
        if (_documentHost.Url != document) _documentHost = (document, Urls.Parse(document) is { } page ? WatchTracker.Host(page) : null);
        if (Session.Shields.ShieldsOff(_documentHost.Host)) return;
        if (rules.Match(uri, isMainFrame ? null : document, type, isMainFrame) != Decision.Block) return;
        args.Response = core.Environment.CreateWebResourceResponse(null, 403, "Blocked", "");
        Blocked = Blocked with { Ads = Blocked.Ads + 1 };
        Session.Shields.Record(ads: 1);
    }

    /// The main page's status, for noticing a film that's gone, and the player's files as the
    /// network saw them, for frames whose scripts can't say.
    private void ResponseReceived(CoreWebView2 core, CoreWebView2WebResourceResponseReceivedEventArgs args)
    {
        var uri = args.Request.Uri;
        var response = args.Response;
        if (uri == _pendingMainRequest) _missingPageUrl = IsGone(response.StatusCode, response.Headers) ? Urls.Parse(_pendingMainUrl) : null;
        if (response.StatusCode is < 200 or >= 400) return;
        Sniff(uri, response.Headers, args.Request.Headers);
    }

    private void DownloadStarting(CoreWebView2 core, CoreWebView2DownloadStartingEventArgs args)
    {
        _downloadTookOver = true;
        if (IsHelper)
        {
            args.Cancel = true;
            return;
        }
        var suggested = Path.GetFileName(args.ResultFilePath);
        // Streaming sites love fake "download player" files.
        if (Session.Settings.DownloadShield)
        {
            args.Cancel = true;
            Session.Toasts.Show($"Blocked a download of {(string.IsNullOrEmpty(suggested) ? "a file" : suggested)}");
            return;
        }
        var folder = UserDownloads.Folder;
        var name = string.IsNullOrEmpty(suggested) ? "Download" : suggested;
        string target;
        try
        {
            Directory.CreateDirectory(folder);
            target = DownloadCenter.Unique(Path.Combine(folder, name));
        }
        catch (Exception)
        {
            return;
        }
        args.ResultFilePath = target;
        args.Handled = true;
        Session.Toasts.Show($"Downloading {Path.GetFileName(target)} to Downloads");
    }
}

public sealed partial class BrowserTab
{
    private static string WithoutFragment(string url)
    {
        var hash = url.IndexOf('#');
        return hash < 0 ? url : url[..hash];
    }
}

/// The person's own Downloads folder, where a site's own downloads go, as on the Mac.
internal static class UserDownloads
{
    private static readonly Guid FolderId = new("374DE290-123F-4565-9164-39C4925E467B");

    public static string Folder
    {
        get
        {
            try
            {
                var id = FolderId;
                if (SHGetKnownFolderPath(ref id, 0, IntPtr.Zero, out var path) == 0 && path != IntPtr.Zero)
                {
                    var text = System.Runtime.InteropServices.Marshal.PtrToStringUni(path);
                    System.Runtime.InteropServices.Marshal.FreeCoTaskMem(path);
                    if (!string.IsNullOrEmpty(text)) return text;
                }
            }
            catch (Exception)
            {
            }
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
        }
    }

    [System.Runtime.InteropServices.DllImport("shell32.dll")]
    private static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);
}
