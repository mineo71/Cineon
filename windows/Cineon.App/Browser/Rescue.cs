using System.Text.Json;
using Cineon.App.UI;
using Cineon.Core.Data;
using Cineon.Core.Parsing;
using Cineon.Core.Shields;
using Microsoft.Web.WebView2.Core;

namespace Cineon.App.Browser;

/// Asks whether a page exists, without opening it.
public static class SiteProbe
{
    public abstract record Result
    {
        /// Answers, and this is where it ended up after any redirects.
        public sealed record Alive(Uri Final) : Result;
        /// The site works, but this page isn't on it.
        public sealed record Missing : Result;
        public sealed record Dead : Result;
    }

    private static readonly HttpClient Http = new(new SocketsHttpHandler
    {
        AllowAutoRedirect = true,
        UseCookies = false,
        ConnectTimeout = TimeSpan.FromSeconds(7),
        AutomaticDecompression = System.Net.DecompressionMethods.All,
    })
    {
        Timeout = TimeSpan.FromSeconds(9),
    };

    public static async Task<Result> CheckAsync(Uri url, CancellationToken cancellation = default)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            // The Mac's word for word, so sites answer alike.
            request.Headers.TryAddWithoutValidation("User-Agent",
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15");
            using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation);
            var final = response.RequestMessage?.RequestUri ?? url;
            var status = (int)response.StatusCode;
            switch (status)
            {
                case >= 200 and < 400:
                    return new Result.Alive(final);
                case 404 or 410:
                    return new Result.Missing();
                case 403 or 429 or 503:
                    // A bot check means someone's home. The web view can get past it, this request can't.
                    var server = response.Headers.Server.ToString();
                    return server.Contains("cloudflare", StringComparison.OrdinalIgnoreCase) ? new Result.Alive(final) : new Result.Dead();
                default:
                    return new Result.Dead();
            }
        }
        catch (Exception)
        {
            return new Result.Dead();
        }
    }
}

/// One search looking for a film that stopped working, shown over the tab it happened in.
public sealed class RescueSession : Observable
{
    public enum ReasonKind { PageFailed, PageMissing, VideoFailed, VideoStalled, Manual }

    public enum StageKind { Mirrors, Searching, Finished }

    public sealed record Option(string SiteName, Uri? SiteIcon, Uri Url, string Label, bool IsStrong, double Score)
    {
        public string Id => Url.OriginalString;
    }

    public RescueSession(ReasonKind reason, string host, long? titleId, string name, IReadOnlyList<string> names, int? year,
        EpisodeRef episode, double? position, double? duration)
    {
        Reason = reason;
        Host = host;
        TitleId = titleId;
        Name = name;
        Names = names;
        Year = year;
        Ref = episode;
        Position = position;
        Duration = duration;
    }

    public Guid Id { get; } = Guid.NewGuid();
    public ReasonKind Reason { get; }
    public string Host { get; }
    public long? TitleId { get; }
    public string Name { get; }
    public IReadOnlyList<string> Names { get; }
    public int? Year { get; }
    public EpisodeRef Ref { get; }
    public double? Position { get; }
    public double? Duration { get; }

    private StageKind _stage = StageKind.Mirrors;
    public StageKind Stage { get => _stage; set => Set(ref _stage, value); }

    private int _mirrorsTotal;
    public int MirrorsTotal { get => _mirrorsTotal; set => Set(ref _mirrorsTotal, value); }

    private int _sitesTotal;
    public int SitesTotal { get => _sitesTotal; set => Set(ref _sitesTotal, value); }

    private int _sitesDone;
    public int SitesDone { get => _sitesDone; set => Set(ref _sitesDone, value); }

    private IReadOnlyList<Option> _options = [];
    public IReadOnlyList<Option> Options { get => _options; set { _options = value; Notify(); } }

    private int? _countdown;
    public int? Countdown { get => _countdown; set => Set(ref _countdown, value); }

    /// The tab moved on, so any page still being read for this search can stop.
    public bool IsAbandoned { get; set; }
    /// They said to stay, so a better match turning up later doesn't start counting again.
    public bool IsStaying { get; set; }

    /// Where it would carry on from, if anywhere.
    public double? ResumePoint => Position is { } position && position >= 30 ? position : null;

    /// The Mac's `/state` line: "reason|stage|site:path:strong;…|countdown".
    public string DebugText =>
        $"{Camel(Reason.ToString())}|{Camel(Stage.ToString())}|{string.Join(";", Options.Select(o => $"{o.SiteName}:{o.Url.AbsolutePath}:{(o.IsStrong ? "true" : "false")}"))}|{Countdown ?? -1}";

    private static string Camel(string name) => name.Length == 0 ? name : char.ToLowerInvariant(name[0]) + name[1..];
}

public static class RescueReasons
{
    extension(RescueSession.ReasonKind reason)
    {
        /// A dead page has nothing to lose, so the best match can open by itself.
        public bool OpensBySelf => reason is RescueSession.ReasonKind.PageFailed or RescueSession.ReasonKind.PageMissing;
        public bool TriesMirrors => reason.OpensBySelf;
    }
}

/// A web view nobody sees, for reading a site's search results. It belongs to no tab, so nothing
/// it does reaches the timeline, the history or the interface, and its pop-ups simply don't open.
internal sealed class RescueProbe
{
    private readonly HeadlessWebView _view;
    private readonly ScriptBridge _bridge;
    private TaskCompletionSource? _waiter;
    private string? _mainUri;

    private RescueProbe(HeadlessWebView view, ScriptBridge bridge)
    {
        _view = view;
        _bridge = bridge;
    }

    public static async Task<RescueProbe?> CreateAsync(ProfileSession session)
    {
        if (await HeadlessWebView.CreateAsync(session.Web) is not { } view) return null;
        var core = view.Core;
        var bridge = new ScriptBridge(core);
        var probe = new RescueProbe(view, bridge);
        core.NavigationStarting += Safe.On<CoreWebView2, CoreWebView2NavigationStartingEventArgs>("probe navigation", (_, e) =>
        {
            var scheme = Urls.Parse(e.Uri)?.Scheme.ToLowerInvariant();
            if (scheme is not ("http" or "https" or "about")) e.Cancel = true;
            else probe._mainUri = e.Uri;
        });
        core.NavigationCompleted += Safe.On<CoreWebView2, CoreWebView2NavigationCompletedEventArgs>("probe loaded", (_, _) => probe.Finish());
        core.NewWindowRequested += Safe.On<CoreWebView2, CoreWebView2NewWindowRequestedEventArgs>("probe pop-up", (_, e) => e.Handled = true);
        core.DownloadStarting += Safe.On<CoreWebView2, CoreWebView2DownloadStartingEventArgs>("probe download", (_, e) => e.Cancel = true);
        core.LaunchingExternalUriScheme += Safe.On<CoreWebView2, CoreWebView2LaunchingExternalUriSchemeEventArgs>("probe scheme", (_, e) => e.Cancel = true);
        // The same ad rules as a tab, which also makes these pages load sooner.
        core.WebResourceRequested += Safe.On<CoreWebView2, CoreWebView2WebResourceRequestedEventArgs>("probe shields", (c, e) =>
        {
            var rules = session.Web.Rules;
            if (rules.IsEmpty) return;
            var type = (ResourceType)(int)e.ResourceContext;
            var uri = e.Request.Uri;
            var isMainFrame = type == ResourceType.Document && uri == probe._mainUri;
            if (rules.Match(uri, isMainFrame ? null : c.Source, type, isMainFrame) == Decision.Block)
            {
                e.Response = c.Environment.CreateWebResourceResponse(null, 403, "Blocked", "");
            }
        });
        core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.All);
        try
        {
            await bridge.InstallAsync(overlaySweeper: false);
        }
        catch (Exception)
        {
            view.Close();
            return null;
        }
        return probe;
    }

    public void Close()
    {
        _view.Close();
        Finish();
    }

    /// Returns when the page has loaded, failed, or taken too long.
    public async Task LoadAsync(Uri url, double timeout)
    {
        Finish();
        var waiter = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        _waiter = waiter;
        try
        {
            _view.Core.Navigate(url.AbsoluteUri);
        }
        catch (Exception)
        {
            Finish();
            return;
        }
        await Task.WhenAny(waiter.Task, Task.Delay(TimeSpan.FromSeconds(timeout)));
        if (_waiter == waiter) Finish();
    }

    private void Finish()
    {
        _waiter?.TrySetResult();
        _waiter = null;
    }

    public async Task<string?> SearchTemplateAsync()
    {
        var result = await _bridge.RunAsync("window.__cineonMeta ? __cineonMeta.searchTemplate() : null");
        return Json.Parse(result) is { ValueKind: JsonValueKind.String } text ? text.GetString() : null;
    }

    public Uri? CurrentUrl => _view.IsClosed ? null : Urls.Parse(_view.Core.Source);

    public async Task<List<RescueLink>> LinksAsync()
    {
        if (Json.Parse(await _bridge.RunAsync(Harvest)) is not { ValueKind: JsonValueKind.Array } rows) return [];
        var links = new List<RescueLink>();
        foreach (var row in rows.EnumerateArray())
        {
            if (Urls.Parse(row.Text("href")) is not { } url) continue;
            links.Add(new RescueLink(url, row.Text("text") ?? "", row.Text("context") ?? ""));
        }
        return links;
    }

    /// Every link on the page with the words that describe it. Cards often keep the title and year
    /// beside the link rather than in it, so the words around it come too.
    private const string Harvest = """
        (() => {
          const out = [];
          const seen = new Set();
          let anchors = [...document.querySelectorAll('a[href]')];
          // Pages built from web components keep their results inside shadow roots.
          if (anchors.length < 30) {
            const walk = (root, depth) => {
              for (const el of root.querySelectorAll('*')) {
                if (!el.shadowRoot) continue;
                anchors.push(...el.shadowRoot.querySelectorAll('a[href]'));
                if (depth < 8) walk(el.shadowRoot, depth + 1);
              }
            };
            walk(document, 0);
          }
          for (const a of anchors) {
            if (out.length >= 500) break;
            const href = a.href;
            if (!/^https?:/.test(href) || seen.has(href)) continue;
            seen.add(href);
            const img = a.querySelector('img');
            const words = [a.textContent, a.title, a.getAttribute('aria-label'), img && img.alt, img && img.title];
            const card = a.closest('article, li, [class*="card" i], [class*="item" i], [class*="movie" i], [class*="film" i]');
            out.push({
              href,
              text: words.filter(Boolean).join('\n').replace(/[ \t]+/g, ' ').trim().slice(0, 300),
              context: card ? card.textContent.replace(/\s+/g, ' ').trim().slice(0, 240) : '',
            });
          }
          return out;
        })()
        """;
}

/// Keeps a film going when the place it was playing stops working: first the site's other
/// addresses, then the person's other sites, picking up from the same second.
public sealed class RescueEngine
{
    private const int ConcurrentSites = 3;
    private const int MaxSites = 8;

    private readonly ProfileSession _session;
    private readonly Dictionary<Guid, CancellationTokenSource> _searches = [];
    private readonly Dictionary<Guid, CancellationTokenSource> _countdowns = [];
    /// Pages where someone already said to leave it alone.
    private readonly HashSet<string> _declined = [];

    public RescueEngine(ProfileSession session)
    {
        _session = session;
    }

    private LibraryStore Library => _session.Library;

    // MARK: What can go wrong

    public void PageFailed(BrowserTab tab, Uri? url)
    {
        if (!_session.Settings.AutoRescue) return;
        Begin(tab, RescueSession.ReasonKind.PageFailed, url);
    }

    public void PageMissing(BrowserTab tab, Uri? url)
    {
        if (!_session.Settings.AutoRescue) return;
        Begin(tab, RescueSession.ReasonKind.PageMissing, url);
    }

    public void VideoTrouble(MediaEvent e, BrowserTab tab)
    {
        if (!_session.Settings.AutoRescue || tab.Rescue is not null || !ReferenceEquals(_session.Browser.Selected, tab)) return;
        // Nothing can be drawn over a fullscreen video from outside, so ask from inside the player.
        if (tab.IsFullscreen)
        {
            tab.ShowBanner(
                "rescue",
                e.Type == "stalled" ? "This video is stuck." : "This video stopped.",
                [("find", "Find another source", true)],
                timeout: 20);
            return;
        }
        Begin(tab, e.Type == "stalled" ? RescueSession.ReasonKind.VideoStalled : RescueSession.ReasonKind.VideoFailed, tab.Url);
    }

    /// It sorted itself out, so the offer is no longer needed.
    public void VideoRecovered(BrowserTab tab)
    {
        if (tab.Rescue is not { Reason: RescueSession.ReasonKind.VideoStalled or RescueSession.ReasonKind.VideoFailed }) return;
        Stop(tab);
    }

    /// "Not here. Find it somewhere else."
    public void FindElsewhere(BrowserTab tab)
    {
        Stop(tab);
        if (Context(tab, tab.Url) is not { } context)
        {
            _session.Toasts.Show("Play something first, so Cineon knows what to look for");
            return;
        }
        Run(context, RescueSession.ReasonKind.Manual, tab, tab.Url);
    }

    public void TryFailedPageSearch(BrowserTab tab, Uri? url)
    {
        if (Context(tab, url) is not { } context) return;
        Run(context, RescueSession.ReasonKind.PageFailed, tab, url);
    }

    public bool CanSearch(BrowserTab tab, Uri? url) => Context(tab, url) is not null;

    private void Begin(BrowserTab tab, RescueSession.ReasonKind reason, Uri? url)
    {
        if (tab.Rescue is not null || url is null || _declined.Contains(UrlKey.Make(url)) || Context(tab, url) is not { } context) return;
        Run(context, reason, tab, url);
    }

    // MARK: What was being watched

    private sealed record RescueContext(long? TitleId, List<string> Names, int? Year, EpisodeRef Ref, double? Position, double? Duration);

    /// Worked out from records of this exact address, because a tab that failed to load still
    /// holds what it knew about the page before.
    private RescueContext? Context(BrowserTab tab, Uri? url)
    {
        long? titleId = null;
        var episode = EpisodeRef.None;
        double? position = null;
        double? duration = null;
        var db = _session.Db;

        if (tab.Track is { } track && url is not null && UrlKey.Make(url) == track.UrlKey)
        {
            titleId = track.TitleId;
            episode = track.Ref;
            position = tab.Media?.Position;
            duration = tab.Media?.Duration;
        }
        else if (url is not null)
        {
            var key = UrlKey.Make(url);
            if (Try(() => db.Progress(key)) is { } saved)
            {
                titleId = saved.TitleId;
                episode = saved.Ref;
                if (saved.Duration > 0 && !saved.Finished)
                {
                    position = saved.Position;
                    duration = saved.Duration;
                }
            }
            else if (Try(() => db.LatestSession(url)) is { } past)
            {
                titleId = past.TitleId;
                episode = past.Ref;
                if (past.Duration > 0 && !past.Finished)
                {
                    position = past.EndPosition;
                    duration = past.Duration;
                }
            }
            else if (Try(() => db.Link(key)) is { } link)
            {
                titleId = link.TitleId;
                episode = link.Ref;
            }
        }
        if (tab.PendingResume is { } pending) position = pending;

        var names = new List<string>();
        int? year = null;
        if (titleId is long id && Library.Titles.TryGetValue(id, out var title))
        {
            names.Add(title.Name);
            year = title.Year;
        }
        // What the page called itself is only about this page if it was read from this address.
        if (tab.PageMeta is { } meta && Urls.Parse(meta.Url) is { } metaUrl && url is not null
            && UrlKey.Make(metaUrl) == UrlKey.Make(url) && tab.Parsed is { } parsed)
        {
            foreach (var name in new[] { parsed.Name, parsed.AltName }.OfType<string>())
            {
                if (!names.Contains(name)) names.Add(name);
            }
            year ??= parsed.Year;
            if (!episode.IsEpisode) episode = parsed.Ref;
        }
        if (names.Count == 0) return null;
        return new RescueContext(titleId, names, year, episode, position, duration);
    }

    // MARK: Looking

    private void Run(RescueContext context, RescueSession.ReasonKind reason, BrowserTab tab, Uri? url)
    {
        var rescue = new RescueSession(
            reason, url is not null && WatchTracker.Host(url) is { } host ? DomainName.Registrable(host) : "This site", context.TitleId,
            context.Names[0], context.Names, context.Year, context.Ref, context.Position, context.Duration);
        tab.Rescue = rescue;
        var cancellation = new CancellationTokenSource();
        _searches[tab.Id] = cancellation;
        var token = cancellation.Token;
        Safe.Fire("rescue", async () =>
        {
            if (reason.TriesMirrors && url is not null && await TryMirrorsAsync(url, rescue, tab, token)) return;
            if (token.IsCancellationRequested) return;
            await SearchSitesAsync(rescue, tab, url, token);
        });
    }

    private async Task<bool> TryMirrorsAsync(Uri url, RescueSession rescue, BrowserTab tab, CancellationToken token)
    {
        var hosts = Try(() => _session.Db.KnownHosts()) ?? [];
        var siteHosts = Library.Sites.Select(s => s.Host);
        var mirrors = RescueMatcher.Mirrors(url, hosts.Concat(siteHosts)).Take(8).ToList();
        rescue.MirrorsTotal = mirrors.Count;
        foreach (var mirror in mirrors)
        {
            if (token.IsCancellationRequested) return false;
            if (await SiteProbe.CheckAsync(mirror, token) is not SiteProbe.Result.Alive alive || token.IsCancellationRequested) continue;
            // A dead domain that now redirects to a parking page isn't this site any more.
            if (SkipLearner.SiteKey(alive.Final.Host) != SkipLearner.SiteKey(url.Host)) continue;
            ContinueOnMirror(mirror, alive.Final, url, rescue, tab);
            return true;
        }
        return false;
    }

    private void ContinueOnMirror(Uri mirror, Uri final, Uri url, RescueSession rescue, BrowserTab tab)
    {
        Uri target;
        if (final.Host == mirror.Host)
        {
            target = mirror;
        }
        else
        {
            // It redirected to its newest address. Keep the episode that's only in the fragment.
            target = new UriBuilder(final) { Fragment = mirror.Fragment.TrimStart('#') }.Uri;
        }
        var newHost = DomainName.Registrable(target.Host);
        if (Library.SiteForHost(WatchTracker.Host(url)) is { } site)
        {
            var home = new UriBuilder(target) { Path = "/", Query = "", Fragment = "" }.Uri;
            Library.UpdateSite(site with
            {
                Host = (target.Host.Length > 0 ? target.Host : newHost).Replace("www.", ""),
                HomeUrl = home,
                SearchTemplate = null,
            });
        }
        Finish(tab);
        tab.ExpectedResumeDuration = rescue.Duration;
        tab.LoadToKeepWatching(target, rescue.ResumePoint);
        _session.Toasts.Show($"{rescue.Host} is down. Continuing on {newHost}.");
    }

    private List<Site> CandidateSites(Uri? url)
    {
        var failed = url is not null && WatchTracker.Host(url) is { } host ? SkipLearner.SiteKey(host) : null;
        return [.. Library.Sites
            .Where(s => SkipLearner.SiteKey(s.Host) != failed)
            .OrderByDescending(s => s.LastUsedAt ?? DateTimeOffset.MinValue)
            .Take(MaxSites)];
    }

    private async Task SearchSitesAsync(RescueSession rescue, BrowserTab tab, Uri? failedUrl, CancellationToken token)
    {
        var sites = CandidateSites(failedUrl);
        rescue.Stage = RescueSession.StageKind.Searching;
        rescue.SitesTotal = sites.Count;

        // A few at a time: each one is a whole web page loading out of sight.
        for (var start = 0; start < sites.Count; start += ConcurrentSites)
        {
            if (token.IsCancellationRequested) return;
            var batch = sites.Skip(start).Take(ConcurrentSites).Select(async site =>
            {
                var option = await ScanAsync(site, rescue);
                if (!ReferenceEquals(tab.Rescue, rescue)) return;
                rescue.SitesDone++;
                if (option is not null) Add(option, rescue, tab);
            });
            await Task.WhenAll(batch);
        }
        if (token.IsCancellationRequested || !ReferenceEquals(tab.Rescue, rescue)) return;
        rescue.Stage = RescueSession.StageKind.Finished;
    }

    private async Task<RescueSession.Option?> ScanAsync(Site site, RescueSession rescue)
    {
        if (await RescueProbe.CreateAsync(_session) is not { } probe) return null;
        try
        {
            if (site.SearchTemplate is null)
            {
                // Sites from an import haven't been visited here yet, so learn how they search now.
                await probe.LoadAsync(site.HomeUrl, 10);
                if (rescue.IsAbandoned || await probe.SearchTemplateAsync() is not { } template) return null;
                site = site with { SearchTemplate = template };
                Library.UpdateSite(site);
            }

            foreach (var name in rescue.Names.Take(2))
            {
                if (rescue.IsAbandoned || site.SearchUrl(name) is not { } url) return null;
                await probe.LoadAsync(url, 12);
                // Many sites fill in their results a moment after the page loads.
                RescueMatch? best = null;
                for (var attempt = 0; attempt < 3; attempt++)
                {
                    if (rescue.IsAbandoned) return null;
                    var links = await probe.LinksAsync();
                    best = RescueMatcher.Best(links, rescue.Names, rescue.Year, probe.CurrentUrl);
                    if (best?.IsStrong == true) break;
                    if (attempt < 2) await Task.Delay(1200);
                }
                if (best is not null)
                {
                    var label = best.Link.Text.Split('\n', '\r').FirstOrDefault(line => line.Trim().Length > 0)?.Trim() ?? rescue.Name;
                    return new RescueSession.Option(
                        site.Name, site.IconUrl, best.Link.Url, label.Length == 0 ? rescue.Name : label,
                        best.IsStrong && !RescueMatcher.IsVideoSharing(best.Link.Url), best.Score);
                }
            }
            return null;
        }
        finally
        {
            probe.Close();
        }
    }

    private void Add(RescueSession.Option option, RescueSession rescue, BrowserTab tab)
    {
        rescue.Options = [.. rescue.Options.Append(option)
            .OrderByDescending(o => o.IsStrong ? 1 : 0)
            .ThenByDescending(o => o.Score)];
        // Opening by itself is only safe for a film. A series page still needs an episode chosen.
        if (option.IsStrong && rescue.Reason.OpensBySelf && !rescue.Ref.IsEpisode && rescue.Countdown is null && !rescue.IsStaying)
        {
            StartCountdown(rescue, tab);
        }
    }

    private void StartCountdown(RescueSession rescue, BrowserTab tab)
    {
        rescue.Countdown = 5;
        var cancellation = new CancellationTokenSource();
        _countdowns[tab.Id] = cancellation;
        var token = cancellation.Token;
        Safe.Fire("rescue countdown", async () =>
        {
            for (var left = 4; left >= 0; left--)
            {
                await Task.Delay(1000, token);
                if (token.IsCancellationRequested) return;
                rescue.Countdown = left;
            }
            if (rescue.Options.FirstOrDefault() is { } best) Take(best, tab);
        });
    }

    // MARK: Decisions

    public void Take(RescueSession.Option option, BrowserTab tab)
    {
        if (tab.Rescue is not { } rescue) return;
        Finish(tab);
        if (rescue.Ref.IsEpisode)
        {
            // The result is the series' page. Once the episode is chosen, its saved place applies.
            tab.Load(option.Url);
            var jump = rescue.ResumePoint is { } point ? $" and Cineon jumps to {Timecode.String(point)}" : "";
            _session.Toasts.Show($"Opened {option.SiteName}. Choose {rescue.Ref.LongLabel.ToLowerInvariant()}{jump}.");
            return;
        }
        // This page is this film, whatever the site calls it.
        if (rescue.TitleId is long titleId) Try(() => _session.Db.SetLink(UrlKey.Make(option.Url), titleId, rescue.Ref));
        tab.ExpectedResumeDuration = rescue.Duration;
        tab.LoadToKeepWatching(option.Url, rescue.ResumePoint);
        var place = rescue.ResumePoint is { } at ? $" at {Timecode.String(at)}" : "";
        _session.Toasts.Show($"Continuing on {option.SiteName}{place}");
    }

    /// "Leave it." Stops looking, and doesn't ask again about this page.
    public void Dismiss(BrowserTab tab)
    {
        if (tab.Url is { } url) _declined.Add(UrlKey.Make(url));
        Stop(tab);
    }

    public void StopCountdown(BrowserTab tab)
    {
        if (_countdowns.Remove(tab.Id, out var countdown)) countdown.Cancel();
        if (tab.Rescue is { } rescue)
        {
            rescue.Countdown = null;
            rescue.IsStaying = true;
        }
    }

    /// Stops without judging: the tab has simply moved on.
    public void Stop(BrowserTab tab) => Finish(tab);

    private void Finish(BrowserTab tab)
    {
        if (_searches.Remove(tab.Id, out var search)) search.Cancel();
        if (_countdowns.Remove(tab.Id, out var countdown)) countdown.Cancel();
        if (tab.Rescue is { } rescue) rescue.IsAbandoned = true;
        tab.Rescue = null;
    }

    private static T? Try<T>(Func<T> read)
    {
        try { return read(); }
        catch (Exception) { return default; }
    }

    private static void Try(Action write)
    {
        try { write(); }
        catch (Exception) { }
    }
}
