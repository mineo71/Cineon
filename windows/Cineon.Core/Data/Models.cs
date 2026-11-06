using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Cineon.Core.Data;

// Port of Cineon/Core/Models.swift. Swift structs are records (change them with `with`), Swift enums
// with raw values are C# enums with ToRaw()/FromRaw() that keep the Mac's strings. Addresses are
// `Uri`; use `OriginalString` for the exact text (what Swift calls `absoluteString`), never
// `ToString()`, which removes percent-encoding.

public enum TitleKind { Film, Series, Cartoon, Unknown }

public static class TitleKindExtensions
{
    extension(TitleKind kind)
    {
        public string ToRaw() => kind switch
        {
            TitleKind.Film => "film",
            TitleKind.Series => "series",
            TitleKind.Cartoon => "cartoon",
            _ => "unknown",
        };

        public string Label => kind switch
        {
            TitleKind.Film => "Film",
            TitleKind.Series => "Series",
            TitleKind.Cartoon => "Cartoon",
            _ => "Unsorted",
        };

        public static TitleKind? FromRaw(string? raw) => raw switch
        {
            "film" => TitleKind.Film,
            "series" => TitleKind.Series,
            "cartoon" => TitleKind.Cartoon,
            "unknown" => TitleKind.Unknown,
            _ => null,
        };

        public static IReadOnlyList<TitleKind> AllCases => [TitleKind.Film, TitleKind.Series, TitleKind.Cartoon, TitleKind.Unknown];
    }
}

public enum TitleStatus { None, Backlog, Watching, Watched }

public static class TitleStatusExtensions
{
    extension(TitleStatus status)
    {
        public string ToRaw() => status switch
        {
            TitleStatus.Backlog => "backlog",
            TitleStatus.Watching => "watching",
            TitleStatus.Watched => "watched",
            _ => "none",
        };

        public string Label => status switch
        {
            TitleStatus.Backlog => "Backlog",
            TitleStatus.Watching => "Watching",
            TitleStatus.Watched => "Watched",
            _ => "Not in a list",
        };

        public static TitleStatus? FromRaw(string? raw) => raw switch
        {
            "none" => TitleStatus.None,
            "backlog" => TitleStatus.Backlog,
            "watching" => TitleStatus.Watching,
            "watched" => TitleStatus.Watched,
            _ => null,
        };

        public static IReadOnlyList<TitleStatus> AllCases =>
            [TitleStatus.None, TitleStatus.Backlog, TitleStatus.Watching, TitleStatus.Watched];
    }
}

public sealed record Title
{
    public long Id { get; init; }
    public string Name { get; init; } = "";
    public string NormName { get; init; } = "";
    public int? Year { get; init; }
    public TitleKind Kind { get; init; } = TitleKind.Unknown;
    public TitleStatus Status { get; init; } = TitleStatus.None;
    public string? ImdbId { get; init; }
    public Uri? PosterUrl { get; init; }
    public Uri? BackdropUrl { get; init; }
    public string? Overview { get; init; }
    public IReadOnlyList<string> Genres { get; init => field = ValueList<string>.Of(value); } = ValueList<string>.Empty;
    public int? RuntimeMinutes { get; init; }
    /// <summary>Out of ten in half steps, kept doubled: 15 is 7.5. Null is not rated.</summary>
    public int? RatingHalves { get; init; }
    public string? Notes { get; init; }
    public DateTimeOffset AddedAt { get; init; }
    public DateTimeOffset UpdatedAt { get; init; }
    public DateTimeOffset? FinishedAt { get; init; }
    public DateTimeOffset? LastWatchedAt { get; init; }
    public bool MetadataChecked { get; init; }
    public DateTimeOffset? RatedAt { get; init; }
    public DateTimeOffset? StatusAt { get; init; }

    /// <summary>Out of ten, such as 7.5.</summary>
    public double? Rating => RatingHalves is int halves ? halves / 2.0 : null;
}

/// <summary>A series' newest aired episode as last checked, and what came out since.</summary>
public sealed record EpisodeAlert
{
    public long TitleId { get; init; }
    public EpisodeRef Latest { get; init; }
    public DateTimeOffset CheckedAt { get; init; }
    public EpisodeRef? Newest { get; init; }
    public int NewCount { get; init; }
    public DateTimeOffset? NewAt { get; init; }
}

/// <summary>Ratings out of ten, in half stars.</summary>
public static class Rating
{
    public const int MaxHalves = 20;

    /// <summary>"7.5", "8", "10".</summary>
    public static string Text(int halves) =>
        halves % 2 == 0
            ? (halves / 2).ToString(CultureInfo.InvariantCulture)
            : (halves / 2).ToString(CultureInfo.InvariantCulture) + ".5";

    public static int Clamp(int halves) => Math.Min(MaxHalves, Math.Max(1, halves));
}

public readonly record struct EpisodeRef(int Season, int Episode)
{
    /// <summary>Films are stored as season 0, episode 0.</summary>
    public static readonly EpisodeRef None = new(0, 0);

    public bool IsEpisode => Season > 0 || Episode > 0;
}

public sealed record WatchProgress
{
    public long TitleId { get; init; }
    public EpisodeRef Ref { get; init; }
    public string UrlKey { get; init; } = "";
    public Uri? Url { get; init; }
    public string Host { get; init; } = "";
    public double Position { get; init; }
    public double Duration { get; init; }
    public bool Finished { get; init; }
    public DateTimeOffset UpdatedAt { get; init; }

    public double Fraction => Duration > 0 ? Math.Min(1, Position / Duration) : 0;
    public double Remaining => Math.Max(0, Duration - Position);
}

public sealed record WatchSession
{
    public long Id { get; init; }
    public long TitleId { get; init; }
    public EpisodeRef Ref { get; init; }
    public string? EpisodeName { get; init; }
    public Uri? Url { get; init; }
    public string Host { get; init; } = "";
    public DateTimeOffset StartedAt { get; init; }
    public DateTimeOffset EndedAt { get; init; }
    public double WatchedSeconds { get; init; }
    public double StartPosition { get; init; }
    public double EndPosition { get; init; }
    public double Duration { get; init; }
    public bool Finished { get; init; }
}

/// <summary>Swift's <c>SkipRule.Kind</c>.</summary>
public enum SkipRuleKind { Intro, Credits }

public static class SkipRuleKindExtensions
{
    extension(SkipRuleKind kind)
    {
        public string ToRaw() => kind == SkipRuleKind.Intro ? "intro" : "credits";

        public static SkipRuleKind? FromRaw(string? raw) => raw switch
        {
            "intro" => SkipRuleKind.Intro,
            "credits" => SkipRuleKind.Credits,
            _ => null,
        };
    }
}

/// <summary>Something to jump over in every episode of a series, learned from watching you do it.</summary>
public sealed record SkipRule
{
    public long Id { get; init; }
    public long TitleId { get; init; }
    /// <summary>The site's brand, so that mirrors of one site share their rules.</summary>
    public string Site { get; init; } = "";
    public SkipRuleKind Kind { get; init; }
    /// <summary>Intro: where it starts. Credits: how many seconds before the end they begin.</summary>
    public double Start { get; init; }
    /// <summary>Intro: where it ends. Credits: unused.</summary>
    public double End { get; init; }
    /// <summary>How many times this was seen. Credits only roll on by themselves once two agree.</summary>
    public int Sightings { get; init; }
    /// <summary>How many times it was undone. Two, and the rule is dropped.</summary>
    public int Misses { get; init; }
    public DateTimeOffset UpdatedAt { get; init; }
}

/// <summary>One real frame from something you watched, saved as a small image on this PC.</summary>
public sealed record FilmFrame
{
    public long Id { get; init; }
    public long? SessionId { get; init; }
    public long TitleId { get; init; }
    public EpisodeRef Ref { get; init; }
    public double Position { get; init; }
    public Uri? Url { get; init; }
    /// <summary>Relative to the profile's Frames folder.</summary>
    public string File { get; init; } = "";
    /// <summary>Saved on purpose, rather than collected along the way.</summary>
    public bool IsMoment { get; init; }
    /// <summary>Higher for frames with more going on, so the best one can represent a session.</summary>
    public double Interest { get; init; }
    public DateTimeOffset At { get; init; }
}

/// <summary>Swift's <c>MediaSource.Kind</c>.</summary>
public enum MediaSourceKind { File, Hls, Subtitle }

public static class MediaSourceKindExtensions
{
    extension(MediaSourceKind kind)
    {
        public string ToRaw() => kind switch
        {
            MediaSourceKind.Hls => "hls",
            MediaSourceKind.Subtitle => "subtitle",
            _ => "file",
        };

        public static MediaSourceKind? FromRaw(string? raw) => raw switch
        {
            "file" => MediaSourceKind.File,
            "hls" => MediaSourceKind.Hls,
            "subtitle" => MediaSourceKind.Subtitle,
            _ => null,
        };
    }
}

/// <summary>A file a player asked for, as it would show in the Network tab.</summary>
public sealed partial record MediaSource
{
    public required Uri Url { get; init; }
    public MediaSourceKind Kind { get; init; }
    /// <summary>Milliseconds since 1970, when the page first asked for it.</summary>
    public double FoundAt { get; init; }
    /// <summary>Asked for since the video now in the player started loading.</summary>
    public bool IsCurrent { get; init; }

    /// <summary>"1080p" from addresses like <c>.../1080.mp4</c> or <c>..._720p.mp4</c>.</summary>
    public string? Quality => QualityIn(Url.OriginalString);

    /// <summary>Swift's <c>MediaSource.quality(in:)</c>.</summary>
    public static string? QualityIn(string text)
    {
        foreach (var regex in (Regex[])[SuffixQuality(), FileQuality()])
        {
            var match = regex.Match(text);
            if (match.Success) return match.Groups[1].Value + "p";
        }
        return null;
    }

    public int QualityRank =>
        Quality is { } q && int.TryParse(q[..^1], NumberStyles.None, CultureInfo.InvariantCulture, out var rank) ? rank : 0;

    /// <summary>
    /// Which of the files a player asked for is the film: the one it's playing if that's a plain
    /// file, otherwise the best quality among those it asked for since loading it, a whole file
    /// before a playlist.
    /// </summary>
    public static MediaSource? Best(IEnumerable<MediaSource> sources, string? playing)
    {
        var videos = sources.Where(s => s.Kind != MediaSourceKind.Subtitle).ToList();
        if (playing is not null &&
            videos.FirstOrDefault(s => s.Kind == MediaSourceKind.File && s.Url.OriginalString == playing) is { } exact)
        {
            return exact;
        }
        var current = videos.Where(s => s.IsCurrent).ToList();
        var pool = current.Count == 0 ? videos : current;
        // Swift's max(by:): the first of equals wins.
        MediaSource? best = null;
        foreach (var source in pool)
        {
            if (best is null || IsBefore(best, source)) best = source;
        }
        return best;
    }

    private static bool IsBefore(MediaSource a, MediaSource b)
    {
        if ((a.Kind == MediaSourceKind.File) != (b.Kind == MediaSourceKind.File)) return b.Kind == MediaSourceKind.File;
        if (a.QualityRank != b.QualityRank) return a.QualityRank < b.QualityRank;
        // Of two playlists, the first asked for is the master. Of two files, the latest.
        return a.Kind == MediaSourceKind.Hls ? a.FoundAt > b.FoundAt : a.FoundAt < b.FoundAt;
    }

    [GeneratedRegex(@"(\d{3,4})p(?:[^a-z0-9]|$)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex SuffixQuality();

    [GeneratedRegex(@"[/_-](240|360|480|720|1080|1440|2160)\.(?:mp4|m3u8)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex FileQuality();
}

/// <summary>What voice boost is doing in one player.</summary>
public enum VoiceBoostState { Off, On, Unsupported, Waiting }

public static class VoiceBoostStateExtensions
{
    extension(VoiceBoostState state)
    {
        public string ToRaw() => state switch
        {
            VoiceBoostState.On => "on",
            VoiceBoostState.Unsupported => "unsupported",
            VoiceBoostState.Waiting => "waiting",
            _ => "off",
        };

        public string? Note => state switch
        {
            VoiceBoostState.Unsupported => "This player won't let Cineon change its sound",
            VoiceBoostState.Waiting => "Click the video once to turn it on",
            _ => null,
        };

        public static VoiceBoostState? FromRaw(string? raw) => raw switch
        {
            "off" => VoiceBoostState.Off,
            "on" => VoiceBoostState.On,
            "unsupported" => VoiceBoostState.Unsupported,
            "waiting" => VoiceBoostState.Waiting,
            _ => null,
        };
    }
}

public enum DownloadStatus { Queued, Downloading, Failed, Done }

public static class DownloadStatusExtensions
{
    extension(DownloadStatus status)
    {
        public string ToRaw() => status switch
        {
            DownloadStatus.Downloading => "downloading",
            DownloadStatus.Failed => "failed",
            DownloadStatus.Done => "done",
            _ => "queued",
        };

        public bool IsActive => status is DownloadStatus.Queued or DownloadStatus.Downloading;

        public static DownloadStatus? FromRaw(string? raw) => raw switch
        {
            "queued" => DownloadStatus.Queued,
            "downloading" => DownloadStatus.Downloading,
            "failed" => DownloadStatus.Failed,
            "done" => DownloadStatus.Done,
            _ => null,
        };
    }
}

/// <summary>A film or episode saved to this PC.</summary>
public sealed record DownloadItem
{
    public long Id { get; init; }
    public long? TitleId { get; init; }
    public EpisodeRef Ref { get; init; }
    public string Name { get; init; } = "";
    public required Uri SourceUrl { get; init; }
    public Uri? PageUrl { get; init; }
    public string? Referer { get; init; }
    public string Host { get; init; } = "";
    public MediaSourceKind Kind { get; init; }
    public string? Quality { get; init; }
    /// <summary>Absolute path, once the file exists.</summary>
    public string? File { get; init; }
    public IReadOnlyList<string> Subtitles { get; init => field = ValueList<string>.Of(value); } = ValueList<string>.Empty;
    public long Bytes { get; init; }
    public long TotalBytes { get; init; }
    public DownloadStatus Status { get; init; }
    public string? Error { get; init; }
    public double Position { get; init; }
    public double Duration { get; init; }
    public Uri? PosterUrl { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset? FinishedAt { get; init; }
    public DateTimeOffset? PlayedAt { get; init; }

    /// <summary>Swift's <c>fileURL</c>: the file as a <c>file://</c> address.</summary>
    public Uri? FileUrl => File is null ? null : new Uri(Path.GetFullPath(File));
    public double Fraction => TotalBytes > 0 ? Math.Min(1, (double)Bytes / TotalBytes) : 0;
    public double WatchedFraction => Duration > 0 ? Math.Min(1, Position / Duration) : 0;

    public string? EpisodeBadge =>
        Ref.IsEpisode ? string.Create(CultureInfo.InvariantCulture, $"S{Ref.Season:00}E{Ref.Episode:00}") : null;

    private const string BannedInFileNames = "/\\:?%*|\"<>\n\r\t";

    /// <summary><c>Severance S01E02 [1080p]</c> or <c>Dune Part Two [1080p]</c>, safe for any file system.</summary>
    public string FileBaseName
    {
        get
        {
            var name = Name;
            if (EpisodeBadge is { } badge) name += " " + badge;
            if (Quality is not null) name += $" [{Quality}]";
            var replaced = new StringBuilder(name.Length);
            foreach (var c in name) replaced.Append(BannedInFileNames.Contains(c) ? ' ' : c);
            var cleaned = replaced.ToString().Replace("  ", " ").Trim();
            var result = cleaned.Length == 0 ? "Video" : cleaned;
            var info = new StringInfo(result);
            return info.LengthInTextElements > 120 ? info.SubstringByTextElements(0, 120) : result;
        }
    }
}

public enum CaptionStyle { Site, Large, Huge }

public static class CaptionStyleExtensions
{
    extension(CaptionStyle style)
    {
        public string ToRaw() => style switch
        {
            CaptionStyle.Large => "large",
            CaptionStyle.Huge => "huge",
            _ => "site",
        };

        public string Label => style switch
        {
            CaptionStyle.Large => "Large, on a dark band",
            CaptionStyle.Huge => "Very large, on a dark band",
            _ => "As the site sets them",
        };

        /// <summary>Applied to the browser's own text tracks. Players that draw their own captions keep theirs.</summary>
        public string? Css => style switch
        {
            CaptionStyle.Large => CaptionStyleExtensions.Band(135),
            CaptionStyle.Huge => CaptionStyleExtensions.Band(175),
            _ => null,
        };

        /// <summary>Points, for captions the native player draws.</summary>
        public double NativeSize => style switch
        {
            CaptionStyle.Large => 32,
            CaptionStyle.Huge => 42,
            _ => 26,
        };

        public static CaptionStyle? FromRaw(string? raw) => raw switch
        {
            "site" => CaptionStyle.Site,
            "large" => CaptionStyle.Large,
            "huge" => CaptionStyle.Huge,
            _ => null,
        };

        public static IReadOnlyList<CaptionStyle> AllCases => [CaptionStyle.Site, CaptionStyle.Large, CaptionStyle.Huge];
    }

    // The Mac names its system font here; on Windows that's Segoe UI Variable.
    private static string Band(int scale) =>
        $"font-size: {scale}% !important; line-height: 1.25 !important; color: #fff !important; "
        + "background: rgba(0,0,0,.72) !important; font-family: 'Segoe UI Variable Text', 'Segoe UI', sans-serif !important;";
}

public enum LibraryEventKind { AddedToBacklog, MarkedWatched, MarkedWatching, Removed }

public static class LibraryEventKindExtensions
{
    extension(LibraryEventKind kind)
    {
        public string ToRaw() => kind switch
        {
            LibraryEventKind.AddedToBacklog => "addedToBacklog",
            LibraryEventKind.MarkedWatched => "markedWatched",
            LibraryEventKind.MarkedWatching => "markedWatching",
            _ => "removed",
        };

        public string Label => kind switch
        {
            LibraryEventKind.AddedToBacklog => "Added to backlog",
            LibraryEventKind.MarkedWatched => "Marked as watched",
            LibraryEventKind.MarkedWatching => "Moved to watching",
            _ => "Removed from lists",
        };

        public static LibraryEventKind? FromRaw(string? raw) => raw switch
        {
            "addedToBacklog" => LibraryEventKind.AddedToBacklog,
            "markedWatched" => LibraryEventKind.MarkedWatched,
            "markedWatching" => LibraryEventKind.MarkedWatching,
            "removed" => LibraryEventKind.Removed,
            _ => null,
        };
    }
}

public sealed record LibraryEvent
{
    public long Id { get; init; }
    public LibraryEventKind Kind { get; init; }
    public long TitleId { get; init; }
    public DateTimeOffset At { get; init; }
}

public sealed record Site
{
    public long Id { get; init; }
    public string Name { get; init; } = "";
    public string Host { get; init; } = "";
    public required Uri HomeUrl { get; init; }
    public string? SearchTemplate { get; init; }
    public Uri? IconUrl { get; init; }
    public int Position { get; init; }
    public DateTimeOffset AddedAt { get; init; }
    public DateTimeOffset? LastUsedAt { get; init; }

    /// <summary>The template with <c>%s</c> replaced by the query, or null without a template.</summary>
    public Uri? SearchUrl(string query)
    {
        if (SearchTemplate is null) return null;
        var encoded = UrlText.Encode(query, UrlText.QueryAllowed).Replace("&", "%26").Replace("+", "%2B");
        return Urls.Parse(SearchTemplate.Replace("%s", encoded));
    }
}

public sealed record HistoryEntry
{
    public long Id { get; init; }
    public required Uri Url { get; init; }
    public string Host { get; init; } = "";
    public string Title { get; init; } = "";
    public DateTimeOffset VisitedAt { get; init; }
}

public sealed record PersistedTab
{
    public Guid Id { get; init; }
    public Uri? Url { get; init; }
    public string Title { get; init; } = "";
    public Uri? FaviconUrl { get; init; }
    public int Position { get; init; }
    public bool IsActive { get; init; }
    /// <summary>The browser's own saved state. The Mac keeps WebKit's here, which WebView2 can't read.</summary>
    public byte[]? State { get; init; }
    public bool IsPinnedToSearch { get; init; }
}

public sealed record SitePrefs(string Host)
{
    public bool ShieldsOff { get; init; }
    public bool AllowPopups { get; init; }
    public bool AllowRedirects { get; init; }
    /// <summary>For sites that aren't about films, like YouTube: nothing here goes on the timeline.</summary>
    public bool TrackingOff { get; init; }
}

public record struct ShieldStats
{
    public int Ads { get; set; }
    public int Popups { get; set; }
    public int Redirects { get; set; }
    public int Overlays { get; set; }

    public readonly int Total => Ads + Popups + Redirects + Overlays;
}

public enum AppTheme { Dark, White }

public static class AppThemeExtensions
{
    extension(AppTheme theme)
    {
        public string ToRaw() => theme == AppTheme.White ? "white" : "dark";

        public string Label => theme == AppTheme.Dark ? "Dark" : "White";

        public static AppTheme? FromRaw(string? raw) => raw switch
        {
            "dark" => AppTheme.Dark,
            "white" => AppTheme.White,
            _ => null,
        };

        public static IReadOnlyList<AppTheme> AllCases => [AppTheme.Dark, AppTheme.White];
    }
}

public enum SearchEngine { DuckDuckGo, Google, Brave, Kagi }

public static class SearchEngineExtensions
{
    extension(SearchEngine engine)
    {
        public string ToRaw() => engine switch
        {
            SearchEngine.Google => "google",
            SearchEngine.Brave => "brave",
            SearchEngine.Kagi => "kagi",
            _ => "duckDuckGo",
        };

        public string Label => engine switch
        {
            SearchEngine.Google => "Google",
            SearchEngine.Brave => "Brave Search",
            SearchEngine.Kagi => "Kagi",
            _ => "DuckDuckGo",
        };

        public Uri? Url(string query)
        {
            var (host, path) = engine switch
            {
                SearchEngine.Google => ("www.google.com", "/search"),
                SearchEngine.Brave => ("search.brave.com", "/search"),
                SearchEngine.Kagi => ("kagi.com", "/search"),
                _ => ("duckduckgo.com", "/"),
            };
            return Urls.Parse($"https://{host}{path}?q={UrlText.Encode(query, UrlText.QueryItemAllowed)}");
        }

        public static SearchEngine? FromRaw(string? raw) => raw switch
        {
            "duckDuckGo" => SearchEngine.DuckDuckGo,
            "google" => SearchEngine.Google,
            "brave" => SearchEngine.Brave,
            "kagi" => SearchEngine.Kagi,
            _ => null,
        };

        public static IReadOnlyList<SearchEngine> AllCases =>
            [SearchEngine.DuckDuckGo, SearchEngine.Google, SearchEngine.Brave, SearchEngine.Kagi];
    }
}

public static class Timecode
{
    /// <summary>1:02:03 or 42:10.</summary>
    public static string String(double seconds)
    {
        if (!double.IsFinite(seconds) || seconds < 0) return "0:00";
        var total = (long)seconds;
        var h = total / 3600;
        var m = total % 3600 / 60;
        var s = total % 60;
        return h > 0
            ? string.Create(CultureInfo.InvariantCulture, $"{h}:{m:00}:{s:00}")
            : string.Create(CultureInfo.InvariantCulture, $"{m}:{s:00}");
    }

    /// <summary>"1 h 12 min", "42 min" or "under a minute".</summary>
    public static string Spoken(double seconds)
    {
        if (!double.IsFinite(seconds) || seconds < 0) return "";
        var minutes = (long)Math.Round(seconds / 60, MidpointRounding.AwayFromZero);
        if (minutes < 1) return "under a minute";
        if (minutes < 60) return $"{minutes} min";
        var h = minutes / 60;
        var m = minutes % 60;
        return m == 0 ? $"{h} h" : $"{h} h {m} min";
    }
}

/// <summary>Swift's <c>URLKey</c>.</summary>
public static partial class UrlKey
{
    private static readonly string[] Tracking = ["utm_", "fbclid", "gclid", "ref", "ref_", "yclid", "mc_", "_ga"];

    /// <summary>A stable key for "this page", ignoring fragments and tracking parameters.</summary>
    public static string Make(Uri url)
    {
        var original = url.OriginalString;
        var parts = UrlText.Split(UrlText.EncodeInvalid(original));

        // Some sites switch episodes by changing only the fragment. It's part of the page's identity
        // there. The dub in it isn't: changing voice is still the same episode.
        string? fragment = null;
        if (parts.Fragment is not null)
        {
            var match = EpisodeFragment().Match(UrlText.Decode(parts.Fragment) ?? parts.Fragment);
            if (match.Success) fragment = UrlText.Encode(match.Value, UrlText.FragmentAllowed);
        }

        // No scheme, user or password; the host lower-cased and without www.
        string? authority = null;
        if (parts.Authority is not null)
        {
            var hostAndPort = parts.Authority;
            var at = hostAndPort.LastIndexOf('@');
            if (at >= 0) hostAndPort = hostAndPort[(at + 1)..];
            string host;
            string? port = null;
            if (hostAndPort.StartsWith('['))
            {
                var close = hostAndPort.IndexOf(']');
                if (close < 0) return original;
                host = hostAndPort[..(close + 1)];
                var rest = hostAndPort[(close + 1)..];
                if (rest.StartsWith(':')) port = rest[1..];
                else if (rest.Length > 0) return original;
            }
            else
            {
                var colon = hostAndPort.LastIndexOf(':');
                host = colon >= 0 ? hostAndPort[..colon] : hostAndPort;
                if (colon >= 0) port = hostAndPort[(colon + 1)..];
            }
            if (port is not null)
            {
                if (port.Length == 0) port = null;
                else if (!port.All(char.IsAsciiDigit)) return original;
                else port = port.TrimStart('0') is { Length: > 0 } digits ? digits : "0";
            }
            host = (UrlText.Decode(host) ?? host).ToLowerInvariant();
            if (host.StartsWith("www.", StringComparison.Ordinal)) host = host[4..];
            authority = UrlText.Encode(host, UrlText.HostAllowed) + (port is null ? "" : ":" + port);
        }

        string? query = null;
        if (parts.Query is not null)
        {
            var items = parts.Query.Length == 0
                ? []
                : parts.Query.Split('&').Select(item =>
                {
                    var eq = item.IndexOf('=');
                    return eq < 0
                        ? (Name: UrlText.Decode(item) ?? item, Value: (string?)null)
                        : (Name: UrlText.Decode(item[..eq]) ?? item[..eq], Value: UrlText.Decode(item[(eq + 1)..]) ?? item[(eq + 1)..]);
                }).ToList();
            var kept = items
                .Where(item => !Tracking.Any(prefix => item.Name.ToLowerInvariant().StartsWith(prefix, StringComparison.Ordinal)))
                .OrderBy(item => item.Name, StringComparer.Ordinal)
                .ToList();
            if (kept.Count > 0)
            {
                query = string.Join("&", kept.Select(item =>
                    UrlText.Encode(item.Name, UrlText.QueryItemAllowed)
                    + (item.Value is null ? "" : "=" + UrlText.Encode(item.Value, UrlText.QueryItemAllowed))));
            }
        }

        var path = parts.Path;
        if (path.EndsWith('/'))
        {
            var decoded = (UrlText.Decode(path) ?? path).TrimEnd('/');
            path = UrlText.Encode(decoded, UrlText.PathAllowed);
        }
        if (authority is null)
        {
            // With no scheme and no host, a colon in the first segment would read as a scheme.
            var slash = path.IndexOf('/');
            var first = slash < 0 ? path : path[..slash];
            if (first.Contains(':')) path = first.Replace(":", "%3A") + (slash < 0 ? "" : path[slash..]);
        }

        var key = (authority is null ? "" : "//" + authority) + path
            + (query is null ? "" : "?" + query) + (fragment is null ? "" : "#" + fragment);
        return key.StartsWith("//", StringComparison.Ordinal) ? key[2..] : key;
    }

    [GeneratedRegex(@"s:\d+-e:\d+")]
    private static partial Regex EpisodeFragment();
}

public static class DomainName
{
    /// <summary>Second-level suffixes that behave like TLDs. Enough for sites people actually visit.</summary>
    private static readonly HashSet<string> CompoundSuffixes =
    [
        "co.uk", "org.uk", "ac.uk", "me.uk", "com.ua", "org.ua", "net.ua", "in.ua", "kiev.ua", "lviv.ua",
        "co.jp", "or.jp", "ne.jp", "com.au", "net.au", "org.au", "com.br", "net.br", "co.nz", "co.in",
        "co.kr", "com.cn", "com.tw", "com.tr", "com.mx", "com.ar", "co.za", "com.ru", "org.ru", "net.ru",
        "com.pl", "net.pl", "org.pl", "com.de", "co.il", "com.sg", "com.hk", "pp.ua", "biz.ua", "at.ua",
    ];

    /// <summary><c>player.vod.example.co.uk</c> becomes <c>example.co.uk</c>.</summary>
    public static string Registrable(string host)
    {
        var h = host.ToLowerInvariant();
        if (h.EndsWith('.')) h = h[..^1];
        if (IsIPAddress(h)) return h;
        var labels = h.Split('.', StringSplitOptions.RemoveEmptyEntries);
        if (labels.Length <= 2) return h;
        var lastTwo = string.Join('.', labels[^2..]);
        return CompoundSuffixes.Contains(lastTwo) ? string.Join('.', labels[^3..]) : lastTwo;
    }

    public static bool IsSameSite(string? a, string? b) =>
        a is not null && b is not null && Registrable(a) == Registrable(b);

    public static bool IsIPAddress(string host) =>
        host.Contains(':') || host.Split('.', StringSplitOptions.RemoveEmptyEntries)
            .All(label => long.TryParse(label, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out _));

    /// <summary><c>example.co.uk</c> becomes <c>Example</c>. Used for names and to spot the site in page titles.</summary>
    public static string DisplayName(string host)
    {
        var registrable = Registrable(host);
        var first = registrable.Split('.', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? registrable;
        if (first.Length == 0) return first;
        var length = StringInfo.GetNextTextElementLength(first);
        return first[..length].ToUpperInvariant() + first[length..];
    }
}

/// <summary>Reading addresses the way <c>URL(string:)</c> does.</summary>
public static class Urls
{
    /// <summary>An absolute address from text, or null when there isn't one.</summary>
    public static Uri? Parse(string? text) =>
        !string.IsNullOrEmpty(text) && Uri.TryCreate(text, UriKind.Absolute, out var uri) ? uri : null;

    /// <summary>The exact text of an address, Swift's <c>absoluteString</c>.</summary>
    public static string Text(Uri url) => url.OriginalString;
}
