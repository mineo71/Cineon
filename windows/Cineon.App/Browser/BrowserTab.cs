using System.Text;
using System.Text.Json;
using Cineon.App.UI;
using Cineon.Core.Data;
using Cineon.Core.Downloads;
using Cineon.Core.Parsing;
using Cineon.Core.Shields;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;
using Windows.Storage.Streams;
using Windows.System;

namespace Cineon.App.Browser;

public sealed record LoadFailure(string Host, string Message, Uri? Url);

/// A change something can watch without rebuilding for everything else a model does.
public sealed class Signal : IChangeNotifier
{
    public event Action? Changed;
    public void Raise() => Changed?.Invoke();
}

/// One tab. Owns its WebView2, which it can release when idle and bring back later. Ported from
/// Cineon/Browser/BrowserTab.swift. Lives on the UI thread, like everything WebView2 touches.
public sealed partial class BrowserTab : Observable, IDownloadTab
{
    public BrowserTab(BrowserModel browser, Uri? url = null, Guid? id = null, string title = "", Uri? favicon = null, byte[]? state = null)
    {
        Browser = browser;
        _url = url;
        Id = id ?? Guid.NewGuid();
        _title = title;
        _faviconUrl = favicon;
        RestoreState = state;
    }

    public BrowserModel Browser { get; }
    public Guid Id { get; }
    private ProfileSession Session => Browser.Session;

    // MARK: State the interface shows

    private Uri? _url;
    public Uri? Url { get => _url; set => Set(ref _url, value); }

    private string _title;
    public string Title { get => _title; set => Set(ref _title, value); }

    private Uri? _faviconUrl;
    public Uri? FaviconUrl { get => _faviconUrl; set => Set(ref _faviconUrl, value); }

    private bool _isLoading;
    public bool IsLoading
    {
        get => _isLoading;
        private set
        {
            if (Set(ref _isLoading, value)) ProgressSignal.Raise();
        }
    }

    /// How far the page has got, 0 to 1. WebView2 reports stages rather than a fraction, so this
    /// steps through them: started, committed, document ready, finished.
    private double _progress;
    public double Progress
    {
        get => _progress;
        private set
        {
            if (_progress == value) return;
            _progress = value;
            ProgressSignal.Raise();
        }
    }

    /// Raised when `Progress` moves, which happens too often to rebuild anything else for.
    public Signal ProgressSignal { get; } = new();

    private bool _canGoBack;
    public bool CanGoBack { get => _canGoBack; private set => Set(ref _canGoBack, value); }

    private bool _canGoForward;
    public bool CanGoForward { get => _canGoForward; private set => Set(ref _canGoForward, value); }

    private LoadFailure? _failure;
    public LoadFailure? Failure { get => _failure; set => Set(ref _failure, value); }

    /// What the video is doing, from its last report. Changes with every tick, so it raises
    /// `Ticks` and only raises `Changed` when it starts, stops or goes away.
    private MediaState? _media;
    public MediaState? Media
    {
        get => _media;
        set
        {
            if (_media == value) return;
            var old = _media;
            _media = value;
            Ticks.Raise();
            if (old is null != value is null || old?.IsPlaying != value?.IsPlaying) Notify();
        }
    }

    /// Raised with every playback report.
    public Signal Ticks { get; } = new();

    private ParsedTitle? _parsed;
    /// What the title parser made of the page.
    public ParsedTitle? Parsed { get => _parsed; set => Set(ref _parsed, value); }

    private long? _linkedTitleId;
    public long? LinkedTitleId { get => _linkedTitleId; set => Set(ref _linkedTitleId, value); }

    private ShieldStats _blocked;
    /// What the shields stopped on this page. Counted per request, so it raises `BlockedSignal`
    /// rather than `Changed`.
    public ShieldStats Blocked
    {
        get => _blocked;
        private set
        {
            if (_blocked == value) return;
            _blocked = value;
            BlockedSignal.Raise();
        }
    }

    public Signal BlockedSignal { get; } = new();

    private bool _isTheaterOn;
    public bool IsTheaterOn { get => _isTheaterOn; set => Set(ref _isTheaterOn, value); }

    private RescueSession? _rescue;
    public RescueSession? Rescue { get => _rescue; set => Set(ref _rescue, value); }

    private IReadOnlyList<MediaSource> _sources = [];
    /// Files the player asked for, as the Network tab would list them.
    public IReadOnlyList<MediaSource> Sources { get => _sources; private set => Set(ref _sources, value); }

    private VoiceBoostState _boostState = VoiceBoostState.Off;
    public VoiceBoostState BoostState { get => _boostState; private set => Set(ref _boostState, value); }

    private SubtitleTrack? _secondSubtitles;
    /// The second line of subtitles Cineon draws over the player, if one is chosen.
    public SubtitleTrack? SecondSubtitles { get => _secondSubtitles; private set => Set(ref _secondSubtitles, value); }

    private bool _isHibernated = true;
    public bool IsHibernated { get => _isHibernated; private set => Set(ref _isHibernated, value); }

    private Guid? _searchGroup;
    /// Belongs to a search-everywhere session rather than the tab list.
    public Guid? SearchGroup { get => _searchGroup; set => Set(ref _searchGroup, value); }

    private bool _isFullscreen;
    /// A video in the page went fullscreen. The Mac's `webView.fullscreenState`: there the video
    /// gets a window of its own; here the window goes fullscreen with only the page in it.
    public bool IsFullscreen { get => _isFullscreen; private set => Set(ref _isFullscreen, value); }

    private double _zoom = 1;
    public double ZoomFactor => _zoom;

    // MARK: State nobody watches

    /// Set when the tab was opened from the sites grid, to notice when that site moves address.
    public long? OriginSiteId { get; set; }
    /// A hidden tab Cineon drives by itself, such as the one fetching a season's episode files.
    /// It finds files and nothing else: no history, no tracking, no rescue, no buttons.
    public bool IsHelper { get; init; }
    /// The Mac's saved WebKit state, kept so a profile copied back to a Mac still restores it.
    /// WebView2 can't read it: a tab wakes at its address instead.
    public byte[]? RestoreState { get; set; }
    public DateTimeOffset LastActiveAt { get; set; } = DateTimeOffset.Now;
    public PageMeta? PageMeta { get; set; }

    // Watch tracking, driven by WatchTracker.
    public LiveTrack? Track { get; set; }
    public double PlayedSeconds { get; set; }
    public DateTimeOffset? LastPlaybackReport { get; set; }
    public double? PendingResume { get; set; }
    /// The frame holding the video, or null for the main frame.
    public CoreWebView2Frame? MediaFrame { get; private set; }
    /// Whether the video is in a frame of its own, the Mac's `mediaFrame?.isMainFrame == false`.
    public bool IsMediaInSubframe => MediaFrame is not null;
    /// How long the video being resumed was, to notice landing on a different cut or a different film.
    public double? ExpectedResumeDuration { get; set; }
    /// The one address whose video should start by itself, because someone asked to carry on
    /// watching. It's tied to the address so that it can't carry over to whatever opens next.
    private string? _autoplayKey;
    public AutopilotState Autopilot { get; set; } = new();
    public EpisodeExit? LastEpisodeExit { get; set; }
    public FrameState FrameState { get; set; } = new();
    /// The frame holding the video whose files were found, and its address for the Referer.
    private CoreWebView2Frame? _sourcesFrame;
    public string? SourcesFrameUrl { get; private set; }
    private string? _playingSource;
    /// Called whenever the player's files change, for whoever waits on them.
    public Action? OnSources { get; set; }
    private string? _lastPill;
    private string? _captionsApplied;
    /// The last banner shown over the player, for the tests: "id|text|offer" or "…|countdown".
    public string? LastBannerForTests { get; private set; }

    private string? _lastHistoryKey;
    /// True while a navigation the person asked for is still in flight, redirects included.
    private bool _trustedNavigation;
    /// The server said this page doesn't exist, though it did send something to show.
    private Uri? _missingPageUrl;
    /// Falls back to window captures once reading video frames turns out to be blocked.
    public bool AmbientFramesBlocked { get; private set; }

    public string DisplayTitle
    {
        get
        {
            if (Title.Length > 0) return Title;
            if (Url is { } url && WatchTracker.Host(url) is { } host) return DomainName.DisplayName(host);
            return "New tab";
        }
    }

    // MARK: Messages from page scripts

    private void Receive(ScriptMessage message)
    {
        switch (message.Handler)
        {
            case "cineonMedia":
                ReceiveMedia(message.Body, message.Frame);
                break;
            case "cineonMeta":
                ReceiveMeta(message.Body);
                break;
            case "cineonMediaReply":
                if (MediaEvent.From(message.Body) is not { } ready)
                {
                    message.Reply(null);
                    return;
                }
                SetMediaFrame(message.Frame, ready.FrameUrl);
                message.Reply(ReplyToReadyVideo(ready));
                break;
            case "cineonShield":
                ReceiveShield(message.Body);
                break;
            case "cineonKey":
                ReceiveKey(message.Body);
                break;
            case "cineonLink":
                ReceiveLink(message.Body);
                break;
            case "cineonCss":
                message.Reply(CssFor(message.Body.Text("top")));
                break;
        }
    }

    public void ReceiveMedia(JsonElement body, CoreWebView2Frame? frame)
    {
        if (MediaEvent.From(body) is not { } e) return;
        switch (e.Type)
        {
            case "ambient":
                if (!ReferenceEquals(Browser.Selected, this) || body.Get("zones") is not { ValueKind: JsonValueKind.Array } raw) return;
                var zones = new List<IReadOnlyList<double>>();
                foreach (var zone in raw.EnumerateArray())
                {
                    if (zone.ValueKind != JsonValueKind.Array) return;
                    zones.Add([.. zone.EnumerateArray().Select(c => c.ValueKind == JsonValueKind.Number ? c.GetDouble() : 0)]);
                }
                Session.App?.Ambient.UpdateFromFrames(zones);
                break;
            case "ambientUnavailable":
                AmbientFramesBlocked = true;
                break;
            case "jump":
                Session.Autopilot.HandleJump(body, this);
                break;
            case "skipped":
                Session.Autopilot.HandleSkipped(body, this);
                break;
            case "banner":
                Session.Autopilot.HandleBanner(body, this);
                break;
            case "sources":
                ReceiveSources(body, frame);
                break;
            case "download":
                ReceiveDownloadClick(body);
                break;
            case "boost":
                BoostState = VoiceBoostStateExtensions.FromRaw(body.Text("state")) ?? VoiceBoostState.Off;
                break;
            case "failed" or "stalled":
                if (IsHelper) return;
                Session.Rescue.VideoTrouble(e, this);
                break;
            case "recovered":
                Session.Rescue.VideoRecovered(this);
                break;
            default:
                if (e.Duration >= WatchTracker.MinimumDuration)
                {
                    var isNewFrame = !_hasMediaFrame || _mediaFrameUrl != e.FrameUrl;
                    SetMediaFrame(frame, e.FrameUrl);
                    if (IsHelper) return;
                    ApplyCaptions();
                    if (e.Type == "play" || isNewFrame) ApplyVoiceBoost();
                }
                if (IsHelper) return;
                Session.Tracker.Handle(e, this);
                break;
        }
    }

    private bool _hasMediaFrame;
    private string? _mediaFrameUrl;

    private void SetMediaFrame(CoreWebView2Frame? frame, string frameUrl)
    {
        MediaFrame = frame;
        _mediaFrameUrl = frameUrl;
        _hasMediaFrame = true;
    }

    public void ReceiveMeta(JsonElement body)
    {
        if (PageMeta.FromJson(body) is not { } meta) return;
        PageMeta = meta;
        Parsed = TitleParser.Parse(meta);
        if (IsHelper) return;
        if (Urls.Parse(meta.Icon) is { } icon) FaviconUrl = icon;
        Browser.LearnFromPage(meta, this);
    }

    public void ReceiveShield(JsonElement body)
    {
        if (body.Text("type") != "overlay") return;
        Blocked = Blocked with { Overlays = Blocked.Overlays + 1 };
        Session.Shields.Record(overlays: 1);
    }

    /// A shortcut pressed while the page had focus, which WinUI never sees.
    private void ReceiveKey(JsonElement body)
    {
        if (IsHelper || Session.App is not { } app || body.Number("k") is not { } code) return;
        var control = body.Bool("c") == true;
        var shift = body.Bool("s") == true;
        var alt = body.Bool("a") == true;
        if ((int)code == 121 && !control && !shift && !alt)
        {
            app.Window?.ShowMenu();
            return;
        }
        Shortcuts.Handle(app, (VirtualKey)(int)code, control, shift, alt);
    }

    /// A link someone pressed, for the redirect shield (WebKit's `.linkActivated`).
    private (string Href, bool Top, bool Form, DateTimeOffset At)? _lastLink;

    private void ReceiveLink(JsonElement body)
    {
        _lastLink = (body.Text("href") ?? "", body.Bool("top") ?? true, body.Bool("form") ?? false, DateTimeOffset.Now);
    }

    /// The ad rules' hiding CSS for the page a frame is in, unless shields are off there.
    private string? CssFor(string? topUrl)
    {
        var host = Urls.Parse(topUrl) is { } top ? WatchTracker.Host(top) : null;
        if (host is null || Session.Shields.ShieldsOff(host)) return null;
        var css = Session.Web.Rules.CssFor(host);
        return css.Length == 0 ? null : css;
    }

    // MARK: Observed changes

    private void TitleChanged(string? value)
    {
        if (string.IsNullOrEmpty(value)) return;
        // WebView2 names an untitled page after its address, where WebKit leaves it empty.
        if (_core is { } core && value == core.Source) return;
        Title = value;
        if (IsHelper) return;
        if (Url is { } url && Session.Settings.SaveBrowsingHistory) Try(() => Session.Db.UpdateHistoryTitle(url, value));
        Browser.ScheduleSave();
    }

    private void UrlChanged(string? source)
    {
        if (Urls.Parse(source) is not { } value || value.Scheme.Equals("about", StringComparison.OrdinalIgnoreCase)) return;
        var changed = value.OriginalString != Url?.OriginalString;
        Url = value;
        var key = UrlKey.Make(value);
        if (key == _lastHistoryKey) return;
        _lastHistoryKey = key;

        // Single-page sites change address without a real navigation.
        if (IsHelper) return;
        if (changed)
        {
            // A failed load also moves the address back, which mustn't end the search it started.
            if (Rescue is { Reason.OpensBySelf: false }) Session.Rescue.Stop(this);
            Session.Tracker.TabNavigated(this);
            Parsed = null;
            PageMeta = null;
            if (IsTheaterOn) IsTheaterOn = false;
            var generation = _generation;
            After(0.8, () =>
            {
                if (generation == _generation) Run("window.__cineonMeta && __cineonMeta.extract();", null);
            });
        }
        if (Session.Settings.SaveBrowsingHistory) Try(() => Session.Db.AddHistory(value, WatchTracker.Host(value) ?? "", Title));
        Browser.ScheduleSave();
    }

    private void NoteSiteUsed(Site site) => Session.Library.UpdateSite(site with { LastUsedAt = DateTimeOffset.Now });

    /// Streaming sites change address all the time. When a site redirects to its new one, follow it.
    private void NoticeSiteMove(Uri committed)
    {
        if (OriginSiteId is not long id || WatchTracker.Host(committed)?.ToLowerInvariant() is not { } host) return;
        if (Session.Library.Sites.FirstOrDefault(s => s.Id == id) is not { } site) return;
        OriginSiteId = null;
        var bare = host.StartsWith("www.", StringComparison.Ordinal) ? host[4..] : host;
        if (DomainName.IsSameSite(site.Host, bare)) return;
        var oldName = site.Host;
        var home = new UriBuilder(committed) { Path = "/", Query = "", Fragment = "" }.Uri;
        site = site with { Host = bare, HomeUrl = home, SearchTemplate = null };
        Session.Library.UpdateSite(site);
        Session.Toasts.Show($"{site.Name} moved from {oldName} to {bare}. Address updated.");
    }

    // MARK: Shield helpers

    private string? CommittedHost => _core is { } core && Urls.Parse(core.Source) is { } source ? WatchTracker.Host(source) : null;

    private void BlockRedirect(Uri? target)
    {
        Blocked = Blocked with { Redirects = Blocked.Redirects + 1 };
        Session.Shields.Record(redirects: 1);
        if (IsHelper) return;
        var host = (target is null ? null : WatchTracker.Host(target)) ?? "another site";
        var fromHost = CommittedHost;
        Session.Toasts.Show($"Blocked redirect to {host}", "Allow", () =>
        {
            Session.Shields.Update(fromHost, allowRedirects: true);
            if (target is not null) Load(target);
        });
    }

    private void BlockPopup(Uri? target)
    {
        Blocked = Blocked with { Popups = Blocked.Popups + 1 };
        Session.Shields.Record(popups: 1);
        if (IsHelper) return;
        var host = (target is null ? null : WatchTracker.Host(target)) ?? "an unknown page";
        var fromHost = CommittedHost;
        if (target is null)
        {
            Session.Toasts.Show($"Blocked pop-up to {host}");
            return;
        }
        Session.Toasts.Show($"Blocked pop-up to {host}", "Open", () =>
        {
            Session.Shields.Update(fromHost, allowPopups: true);
            Browser.OpenTab(target, select: true);
        });
    }

    // MARK: Debug

    /// What the end-to-end tests read about this tab, like the Mac's `/state`.
    public IReadOnlyDictionary<string, string> DebugState()
    {
        var p = Parsed;
        return new Dictionary<string, string>
        {
            ["url"] = Url?.OriginalString ?? "-",
            ["title"] = Title,
            ["parsed"] = p is null ? "-" : $"{p.Name}|{p.Year ?? 0}|S{p.Ref.Season}E{p.Ref.Episode}|{p.KindHint.ToRaw()}|{Json.Num(p.Confidence)}",
            ["media"] = Media is { } m ? $"{Json.Num(m.Position)}/{Json.Num(m.Duration)} playing={m.IsPlaying}" : "-",
            ["track"] = (Track?.TitleId ?? -1).ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["blocked"] = $"ads={Blocked.Ads} popups={Blocked.Popups} redirects={Blocked.Redirects} overlays={Blocked.Overlays}",
            ["framesBlocked"] = AmbientFramesBlocked ? "true" : "false",
            ["fullscreen"] = IsFullscreen ? "1" : "0",
            ["hasSuperview"] = _control is { Parent: not null } ? "true" : "false",
            ["hibernated"] = IsHibernated ? "true" : "false",
            ["ready"] = _core is not null ? "true" : "false",
            ["banner"] = LastBannerForTests ?? "-",
            ["failure"] = Failure?.Host ?? "-",
            ["theater"] = IsTheaterOn ? "true" : "false",
            ["canGoBack"] = CanGoBack ? "true" : "false",
            ["zoom"] = Json.Num(_zoom),
            ["boost"] = BoostState.ToRaw(),
            ["best"] = BestSource?.Url.OriginalString ?? "-",
            ["sourcesFrame"] = SourcesFrameUrl ?? "-",
            ["rescue"] = Rescue?.DebugText ?? "-",
        };
    }

    /// Every file found, one per line: "source kind current=… url", and those only the network saw.
    public IReadOnlyList<string> DebugSources() =>
    [
        .. Sources.Select(s => $"source {s.Kind.ToRaw()} current={s.IsCurrent} {s.Url.OriginalString}"),
        .. _sniffed.Select(s => $"sniffed {s.Kind.ToRaw()} referer={s.Referer ?? "-"} {s.Url}"),
    ];

    /// Runs a script in the frame with the video (the Mac's debug `/eval`).
    public Task<string?> EvaluateForDebugAsync(string script) => EvaluateInPlayerAsync(script);

    // MARK: Helpers

    private static void Try(Action body)
    {
        try { body(); }
        catch (Exception) { }
    }

    /// Runs `body` on the UI thread after a delay.
    private static void After(double seconds, Action body) =>
        Safe.Fire("tab timer", async () =>
        {
            await Task.Delay(TimeSpan.FromSeconds(seconds));
            body();
        });

    private static string Utf8OrCyrillic(byte[] data)
    {
        try
        {
            return new UTF8Encoding(false, true).GetString(data);
        }
        catch (DecoderFallbackException)
        {
            Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
            return Encoding.GetEncoding(1251).GetString(data);
        }
    }

    internal static async Task<byte[]?> ReadAllAsync(IRandomAccessStream stream)
    {
        stream.Seek(0);
        var size = (uint)stream.Size;
        if (size == 0) return null;
        var reader = new DataReader(stream.GetInputStreamAt(0));
        await reader.LoadAsync(size);
        var bytes = new byte[size];
        reader.ReadBytes(bytes);
        return bytes;
    }
}
