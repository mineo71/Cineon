using Cineon.Core.Data;
using Cineon.Core.Downloads;
using Cineon.Core.Parsing;

namespace Cineon.App.Browser;

/// What a download's requests carry from the browser: its name and the profile's cookies, so the
/// site sees the same visitor it served the player to. Calls arrive on the UI thread.
public sealed class RequestContext : IRequestContext
{
    private readonly ProfileSession _session;
    private string? _userAgent;
    /// A parked web view for when no tab has one, kept until the profile closes.
    private HeadlessWebView? _service;
    private Task<HeadlessWebView?>? _starting;

    public RequestContext(ProfileSession session)
    {
        _session = session;
    }

    public async Task<string?> UserAgentAsync()
    {
        if (_userAgent is not null) return _userAgent;
        try
        {
            var core = _session.Browser.Tabs.Select(t => t.Core).FirstOrDefault(c => c is not null) ?? (await ServiceAsync())?.Core;
            _userAgent = core?.Settings.UserAgent;
        }
        catch (Exception error)
        {
            CrashLog.Write("user agent", error);
        }
        return _userAgent;
    }

    public async Task<IReadOnlyList<BrowserCookie>> CookiesAsync(Uri url)
    {
        try
        {
            var core = _session.Browser.Tabs.Select(t => t.Core).FirstOrDefault(c => c is not null) ?? (await ServiceAsync())?.Core;
            if (core is null) return [];
            var cookies = await core.CookieManager.GetCookiesAsync(url.AbsoluteUri);
            return [.. cookies.Select(c => new BrowserCookie(c.Name, c.Value, c.Domain, c.Path, c.IsSecure))];
        }
        catch (Exception error)
        {
            CrashLog.Write("cookies", error);
            return [];
        }
    }

    private Task<HeadlessWebView?> ServiceAsync()
    {
        if (_service is { IsClosed: false } ready) return Task.FromResult<HeadlessWebView?>(ready);
        return _starting ??= StartAsync();
    }

    private async Task<HeadlessWebView?> StartAsync()
    {
        try
        {
            _service = await HeadlessWebView.CreateAsync(_session.Web);
            return _service;
        }
        finally
        {
            _starting = null;
        }
    }

    public void Close()
    {
        _service?.Close();
        _service = null;
    }
}

/// How the season grabber finds other episodes: a hidden tab to open them in, their addresses,
/// whether a page exists, and what the catalogue says was published.
public sealed class EpisodeResolver : IEpisodeResolver
{
    private readonly ProfileSession _session;

    public EpisodeResolver(ProfileSession session)
    {
        _session = session;
    }

    public IEpisodeHelperTab MakeHelperTab() => new HelperTab(_session);

    public Uri? EpisodeUrl(Uri pageUrl, EpisodeRef current, EpisodeRef target) => EpisodeLinks.Url(pageUrl, current, target);

    public async Task<bool> IsAliveAsync(Uri url, CancellationToken ct) => await SiteProbe.CheckAsync(url, ct) is SiteProbe.Result.Alive;

    public async Task<IReadOnlyList<PublishedEpisode>> PublishedEpisodesAsync(Title title, CancellationToken ct)
    {
        try
        {
            var episodes = await _session.Metadata.EpisodesAsync(title);
            return [.. episodes.Select(e => new PublishedEpisode(e.Season, e.Episode, e.Released))];
        }
        catch (Exception)
        {
            return [];
        }
    }
}

/// The season grabber's hidden tab: a tab of its own kind that only finds files. It lives in a
/// parked web view, never in the tab strip, and is torn down when disposed.
public sealed class HelperTab : IEpisodeHelperTab
{
    private readonly BrowserTab _tab;
    private bool _isDisposed;

    public HelperTab(ProfileSession session)
    {
        _tab = new BrowserTab(session.Browser) { IsHelper = true };
    }

    /// The tab inside, for debugging.
    public BrowserTab Tab => _tab;

    public Uri? Url => _tab.Url;
    public string DisplayTitle => _tab.DisplayTitle;
    public long? LinkedTitleId => _tab.LinkedTitleId;
    public EpisodeRef? TrackRef => _tab.Track?.Ref;
    public PageTitle? Parsed => ((IDownloadTab)_tab).Parsed;
    public IReadOnlyList<MediaSource> Sources => _tab.Sources;
    public MediaSource? BestSource => _tab.BestSource;
    public string? SourcesFrameUrl => _tab.SourcesFrameUrl;
    public double MediaDuration => _tab.Media?.Duration ?? 0;
    public Uri? CurrentUrl => Urls.Parse(_tab.Core?.Source) is { Scheme: "http" or "https" } current ? current : _tab.Url;

    public Task<string?> EvaluateInPageAsync(string script) =>
        _isDisposed ? Task.FromResult<string?>(null) : _tab.EvaluateInPageAsync(script);

    public void Load(Uri url)
    {
        if (!_isDisposed) _tab.Load(url);
    }

    public void Reload()
    {
        if (!_isDisposed) _tab.Reload();
    }

    public void PausePlayback()
    {
        if (!_isDisposed) _tab.PausePlayback();
    }

    public void Dispose()
    {
        if (_isDisposed) return;
        _isDisposed = true;
        _tab.TearDownWebView();
    }
}
