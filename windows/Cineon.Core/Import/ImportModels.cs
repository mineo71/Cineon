using System.Globalization;
using Cineon.Core.Data;

namespace Cineon.Core.Import;

// Port of the types at the top of Cineon/Core/BrowserImport.swift.

/// <summary>One browser profile on this PC that has something worth importing.</summary>
public sealed record ImportSource
{
    /// <summary>"Chrome", "Edge", "Arc"…</summary>
    public required string Browser { get; init; }
    /// <summary>The name the browser shows for the profile, or "" when it has none.</summary>
    public string ProfileName { get; init; } = "";
    /// <summary>The Chromium profile folder: the one holding <c>History</c> and <c>Bookmarks</c>.</summary>
    public required string ProfileDirectory { get; init; }
    /// <summary>Arc keeps pinned tabs in its own files, above the Chromium profile folders.</summary>
    public string? ArcDirectory { get; init; }
    public int HistoryCount { get; init; }
    public int BookmarkCount { get; init; }
    public int PinnedCount { get; init; }

    public string Id => ProfileDirectory;
    public string Label => ProfileName.Length == 0 ? Browser : $"{Browser}, {ProfileName}";
}

/// <summary>Swift's <c>BrowsedPage.Origin</c>.</summary>
public enum PageOrigin { History, Bookmark, Pinned }

/// <summary>A page from a browser: a history entry, a bookmark or a pinned tab.</summary>
public sealed record BrowsedPage
{
    public required Uri Url { get; init; }
    public string Title { get; init; } = "";
    public int Visits { get; init; }
    /// <summary><see cref="DateTimeOffset.MinValue"/> (Swift's <c>distantPast</c>) when unknown.</summary>
    public DateTimeOffset LastVisit { get; init; }
    public PageOrigin Origin { get; init; }
}

/// <summary>A film site the import suggests adding.</summary>
public sealed record ImportSiteCandidate
{
    public required string Host { get; init; }
    public required Uri HomeUrl { get; init; }
    public int FilmPages { get; init; }

    public string Id => Host;
}

/// <summary>The latest page seen for one episode of a title (or the film itself).</summary>
public sealed record ImportVisit
{
    public EpisodeRef Ref { get; init; }
    public required Uri Url { get; init; }
    public string Host { get; init; } = "";
    public DateTimeOffset Date { get; init; }
}

/// <summary>A film or series found in the pages, with the list it would go to.</summary>
public sealed record ImportTitleCandidate
{
    public required string Key { get; init; }
    public required string Name { get; init; }
    public string? AltName { get; init; }
    public int? Year { get; init; }
    public TitleKind Kind { get; init; }
    /// <summary>The latest page for each episode, newest first. A film has just one.</summary>
    public IReadOnlyList<ImportVisit> Visits { get; init => field = ValueList<ImportVisit>.Of(value); } = ValueList<ImportVisit>.Empty;
    public TitleStatus SuggestedStatus { get; init; }

    public string Id => Key;
    public DateTimeOffset LastVisit => Visits.Count > 0 ? Visits[0].Date : DateTimeOffset.MinValue;
    public string Host => Visits.Count > 0 ? Visits[0].Host : "";
    public EpisodeRef LatestRef => Visits.Count > 0 ? Visits[0].Ref : EpisodeRef.None;
}

/// <summary>What one browser profile holds, sorted into sites, titles and searchable pages.</summary>
public sealed record ImportScan
{
    public required string SourceLabel { get; init; }
    public IReadOnlyList<ImportSiteCandidate> Sites { get; init; } = [];
    public IReadOnlyList<ImportTitleCandidate> Titles { get; init; } = [];
    /// <summary>Pages to make searchable, newest first and capped at <see cref="BrowserImporter.PageLimit"/>.</summary>
    public IReadOnlyList<BrowsedPage> Pages { get; init; } = [];
    public int TotalPages { get; init; }
}

/// <summary>What the person ticked on the review screen.</summary>
public sealed record ImportSelection
{
    public IReadOnlyList<ImportSiteCandidate> Sites { get; init; } = [];
    public IReadOnlyList<(ImportTitleCandidate Candidate, TitleStatus Status)> Titles { get; init; } = [];
    public IReadOnlyList<BrowsedPage> Pages { get; init; } = [];
}

public sealed class ImportResult
{
    public int Sites { get; set; }
    public int Titles { get; set; }
    public int Pages { get; set; }
    /// <summary>Titles the import added, for the catalogue lookup that follows.</summary>
    public List<(long Id, string? AltName)> NewTitleIds { get; } = [];

    public string Summary
    {
        get
        {
            var parts = new List<string>();
            if (Sites > 0) parts.Add($"{Sites} {(Sites == 1 ? "site" : "sites")}");
            if (Titles > 0) parts.Add($"{Titles} {(Titles == 1 ? "film or series" : "films and series")}");
            if (Pages > 0) parts.Add($"{Pages.ToString("N0", CultureInfo.CurrentCulture)} pages");
            return parts.Count == 0 ? "Nothing new to import." : "Imported " + string.Join(", ", parts) + ".";
        }
    }
}

// MARK: Title recognition

/// <summary>
/// What the title parser makes of a page: the Mac's <c>ParsedTitle</c>, cut to what the import uses.
/// </summary>
public sealed record RecognizedTitle
{
    public required string Name { get; init; }
    /// <summary>A second name in another language, from titles like "Дюна / Dune".</summary>
    public string? AltName { get; init; }
    public int? Year { get; init; }
    public EpisodeRef Ref { get; init; }
    public TitleKind KindHint { get; init; } = TitleKind.Unknown;
    /// <summary>0 to 1. Below 0.5 the page isn't trusted.</summary>
    public double Confidence { get; init; }
}

/// <summary>
/// The title recognition the import relies on, which on the Mac is <c>TitleParser</c>. The app
/// implements it over <c>Cineon.Core.Parsing.TitleParser</c>:
/// <c>Parse</c> is <c>TitleParser.Parse(new PageMeta { Url = url, Title = title })</c> and
/// <c>EpisodeRefIn</c> is <c>TitleParser.EpisodeRef(text)</c>.
/// </summary>
public interface ITitleRecognizer
{
    /// <summary>Reads a page's address and title. Null when nothing film-like is left after cleaning.</summary>
    RecognizedTitle? Parse(string url, string title);

    /// <summary>A season and episode written anywhere in the text: "S01E02", "2 сезон 3 серія", "#t:1-s:2-e:4".</summary>
    EpisodeRef? EpisodeRefIn(string text);
}

public static class ImportRecordExtensions
{
    extension(WatchProgress progress)
    {
        /// <summary>From an imported history: we know the page was opened, not how far you got.</summary>
        public bool IsVisitOnly => progress.Duration == 0;
    }

    extension(WatchSession session)
    {
        public bool IsVisitOnly => session.Duration == 0;
    }
}
