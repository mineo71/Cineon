using Cineon.Core.Data;

namespace Cineon.Core.Downloads;

// What the downloads need from the app. Core has no WebView2 or UI types, so the app implements
// these over its WebView2 profile, tabs and toasts.

/// <summary>A cookie from the browser's store: what <c>CoreWebView2Cookie</c> carries that a request needs.</summary>
public sealed record BrowserCookie(string Name, string Value, string Domain, string Path, bool IsSecure);

/// <summary>
/// The page's side of a request. Downloads are fetched as the page's own player would: with the
/// profile's cookies (logins included) and its browser name, so a site sees the same visitor it served
/// the player to. The Referer comes from the download itself (the frame the player was in).
/// </summary>
public interface IRequestContext
{
    /// <summary>The browser name WebView2 sends, <c>navigator.userAgent</c>. Null while it isn't known.</summary>
    Task<string?> UserAgentAsync();

    /// <summary>
    /// The profile's cookies that a request to this address could carry: the app returns
    /// <c>CoreWebView2CookieManager.GetCookiesAsync(url.AbsoluteUri)</c>, or every cookie
    /// (<c>GetCookiesAsync(null)</c>). Core keeps only those the address would be sent, by domain,
    /// path and Secure, as the Mac does.
    /// </summary>
    Task<IReadOnlyList<BrowserCookie>> CookiesAsync(Uri url);
}

/// <summary>The app around the download queue: toasts, playback, the Recycle Bin, File Explorer.</summary>
public interface IDownloadHost
{
    /// <summary>A toast, with a button when <paramref name="actionTitle"/> is given.</summary>
    void ShowToast(string message, string? actionTitle = null, Action? action = null);

    /// <summary>Opens a finished download in the player (the Mac's <c>app.playDownload</c>).</summary>
    void PlayDownload(DownloadItem item);

    /// <summary>Every tab that shows a download button updates it (<c>tab.refreshDownloadPill()</c>).</summary>
    void RefreshDownloadPills();

    /// <summary>Looks the title up in the catalogue (<c>session.metadata.enrich</c>).</summary>
    void EnrichTitle(long titleId, string? altName);

    /// <summary>Moves files to the Recycle Bin, where they can still be put back from.</summary>
    void MoveToRecycleBin(IReadOnlyList<string> paths);

    /// <summary>Shows a file selected in File Explorer, or opens a folder when <paramref name="select"/> is false.</summary>
    void ShowInFileExplorer(string path, bool select);

    /// <summary>How long a saved video runs, in seconds, or null when it can't be read.</summary>
    Task<double?> MediaDurationAsync(string file);
}

/// <summary>What the page in a tab says it is: the title parser's result (the Mac's <c>tab.parsed</c>).</summary>
public sealed record PageTitle
{
    public required string Name { get; init; }
    public string? AltName { get; init; }
    public int? Year { get; init; }
    public EpisodeRef Ref { get; init; }
    public TitleKind KindHint { get; init; } = TitleKind.Unknown;
    public Uri? PosterUrl { get; init; }
    public string? Overview { get; init; }
}

/// <summary>
/// The browser tab a download starts from, which is the Mac's <c>BrowserTab</c> as the downloads see
/// it. The browser port implements it on its WebView2 tab.
/// </summary>
public interface IDownloadTab
{
    Uri? Url { get; }
    /// <summary>The tab's title as shown.</summary>
    string DisplayTitle { get; }
    /// <summary>The library title the tab's page is linked to.</summary>
    long? LinkedTitleId { get; }
    /// <summary>The episode the watch tracker settled on (<c>tab.track?.ref</c>).</summary>
    EpisodeRef? TrackRef { get; }
    PageTitle? Parsed { get; }
    /// <summary>Files the page's player asked for, from <c>media.js</c>'s <c>sources</c> messages.</summary>
    IReadOnlyList<MediaSource> Sources { get; }
    /// <summary><c>MediaSource.Best(Sources, playingSource)</c>.</summary>
    MediaSource? BestSource { get; }
    /// <summary>The address of the frame the files were found in: the Referer CDNs check.</summary>
    string? SourcesFrameUrl { get; }
    /// <summary>How long the video in the player runs (<c>tab.media?.duration ?? 0</c>).</summary>
    double MediaDuration { get; }

    /// <summary>
    /// Runs a script in the page's main frame and gives its result as JSON, as
    /// <c>CoreWebView2.ExecuteScriptAsync</c> does. Null when there's no page or the script failed.
    /// </summary>
    Task<string?> EvaluateInPageAsync(string script);
}
