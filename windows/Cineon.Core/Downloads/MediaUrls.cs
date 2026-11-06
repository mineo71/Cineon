using System.Text.RegularExpressions;
using Cineon.Core.Data;

namespace Cineon.Core.Downloads;

/// <summary>
/// How <c>media.js</c> reads the files a player asks for, for code that sees those requests from C#
/// (a WebView2 <c>WebResourceRequested</c> or <c>WebResourceResponseReceived</c> observer). The
/// shared script does the same in the page, so both agree.
/// </summary>
public static partial class MediaUrls
{
    /// <summary>
    /// HDRezka's player asks for <c>file.mp4:hls:seg-1-v1-a1.ts</c>. Cutting <c>:hls:…</c> leaves the
    /// whole film, <c>file.mp4</c>, with any query kept.
    /// </summary>
    public static string Progressive(string url)
    {
        var match = HlsSuffix().Match(url);
        if (!match.Success) return url;
        var at = match.Index;
        var rest = url[(at + 4)..];
        var query = rest.IndexOfAny(['?', '#']);
        return url[..(at + 4)] + (query == -1 ? "" : rest[query..]);
    }

    /// <summary><see cref="Progressive(string)"/> on an address.</summary>
    public static Uri Progressive(Uri url)
    {
        var text = Progressive(url.OriginalString);
        return text == url.OriginalString ? url : Urls.Parse(text) ?? url;
    }

    /// <summary>What kind of file an address is, or null for anything that isn't a film, playlist or subtitles.</summary>
    public static MediaSourceKind? KindOf(string url)
    {
        if (Subtitle().IsMatch(url)) return MediaSourceKind.Subtitle;
        if (Playlist().IsMatch(url)) return MediaSourceKind.Hls;
        if (Video().IsMatch(url) && !Segment().IsMatch(url)) return MediaSourceKind.File;
        return null;
    }

    [GeneratedRegex(@"\.mp4:hls:", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex HlsSuffix();

    [GeneratedRegex(@"(?:^|[\/_.-])(?:seg|segment|chunk|frag|fragment|part)[-_]?\d+\.(?:mp4|m4s)(?=[?#]|$)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Segment();

    [GeneratedRegex(@"\.(?:vtt|srt)(?=[?#]|$)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Subtitle();

    [GeneratedRegex(@"\.m3u8(?=[?#]|$)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Playlist();

    [GeneratedRegex(@"\.(?:mp4|m4v|webm|mov)(?=[?#]|$)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Video();
}
