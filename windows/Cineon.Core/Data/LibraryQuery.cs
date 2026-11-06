using System.Globalization;

namespace Cineon.Core.Data;

// Port of Cineon/Core/LibraryQuery.swift. Swift's nested LibraryQuery.List, .Kind, .RatingFilter and
// .Sort are LibraryList, LibraryKind, RatingFilter and LibrarySort here, because C# can't nest a
// type under the same name as the property that holds it.

/// <summary>Swift's <c>LibraryQuery.List</c>.</summary>
public enum LibraryList { All, Backlog, Watching, Watched }

public static class LibraryListExtensions
{
    extension(LibraryList list)
    {
        public string ToRaw() => list switch
        {
            LibraryList.Backlog => "backlog",
            LibraryList.Watching => "watching",
            LibraryList.Watched => "watched",
            _ => "all",
        };

        public string Label => list switch
        {
            LibraryList.Backlog => "Backlog",
            LibraryList.Watching => "Watching",
            LibraryList.Watched => "Watched",
            _ => "Everything",
        };

        public bool Matches(Title title) => list switch
        {
            LibraryList.Backlog => title.Status == TitleStatus.Backlog,
            LibraryList.Watching => title.Status == TitleStatus.Watching,
            LibraryList.Watched => title.Status == TitleStatus.Watched,
            _ => true,
        };

        public static LibraryList? FromRaw(string? raw) => raw switch
        {
            "all" => LibraryList.All,
            "backlog" => LibraryList.Backlog,
            "watching" => LibraryList.Watching,
            "watched" => LibraryList.Watched,
            _ => null,
        };

        public static IReadOnlyList<LibraryList> AllCases =>
            [LibraryList.All, LibraryList.Backlog, LibraryList.Watching, LibraryList.Watched];
    }
}

/// <summary>Swift's <c>LibraryQuery.Kind</c>.</summary>
public enum LibraryKind { Any, Films, Series, Cartoons }

public static class LibraryKindExtensions
{
    extension(LibraryKind kind)
    {
        public string ToRaw() => kind switch
        {
            LibraryKind.Films => "films",
            LibraryKind.Series => "series",
            LibraryKind.Cartoons => "cartoons",
            _ => "any",
        };

        public string Label => kind switch
        {
            LibraryKind.Films => "Films",
            LibraryKind.Series => "Series",
            LibraryKind.Cartoons => "Cartoons",
            _ => "All",
        };

        public bool Matches(Title title) => kind switch
        {
            LibraryKind.Films => title.Kind is TitleKind.Film or TitleKind.Unknown,
            LibraryKind.Series => title.Kind == TitleKind.Series,
            LibraryKind.Cartoons => title.Kind == TitleKind.Cartoon,
            _ => true,
        };

        public static LibraryKind? FromRaw(string? raw) => raw switch
        {
            "any" => LibraryKind.Any,
            "films" => LibraryKind.Films,
            "series" => LibraryKind.Series,
            "cartoons" => LibraryKind.Cartoons,
            _ => null,
        };

        public static IReadOnlyList<LibraryKind> AllCases =>
            [LibraryKind.Any, LibraryKind.Films, LibraryKind.Series, LibraryKind.Cartoons];
    }
}

public enum RatingFilterKind { Any, Unrated, AtLeast, Below }

/// <summary>Swift's <c>LibraryQuery.RatingFilter</c>: any, unrated, at least or below a number of stars out of ten.</summary>
public readonly record struct RatingFilter
{
    public RatingFilterKind Kind { get; }
    /// <summary>Stars out of ten, for <see cref="RatingFilterKind.AtLeast"/> and <see cref="RatingFilterKind.Below"/>.</summary>
    public int Stars { get; }

    private RatingFilter(RatingFilterKind kind, int stars)
    {
        Kind = kind;
        Stars = stars;
    }

    public static RatingFilter Any => default;
    public static RatingFilter Unrated => new(RatingFilterKind.Unrated, 0);
    /// <summary>At least this many stars out of ten.</summary>
    public static RatingFilter AtLeast(int stars) => new(RatingFilterKind.AtLeast, stars);
    public static RatingFilter Below(int stars) => new(RatingFilterKind.Below, stars);

    public string Label => Kind switch
    {
        RatingFilterKind.Unrated => "Not rated yet",
        RatingFilterKind.AtLeast => $"{Stars} and up",
        RatingFilterKind.Below => $"Under {Stars}",
        _ => "Any rating",
    };

    public static IReadOnlyList<RatingFilter> Choices { get; } =
        [Any, Unrated, AtLeast(9), AtLeast(8), AtLeast(7), AtLeast(5), Below(5)];

    public bool Matches(Title title) => Kind switch
    {
        RatingFilterKind.Unrated => title.RatingHalves is null,
        RatingFilterKind.AtLeast => (title.Rating ?? -1) >= Stars,
        RatingFilterKind.Below => title.Rating is double rating && rating < Stars,
        _ => true,
    };
}

/// <summary>Swift's <c>LibraryQuery.Sort</c>.</summary>
public enum LibrarySort { Recent, Added, RatingHigh, RatingLow, Name, Newest, Oldest, Longest }

public static class LibrarySortExtensions
{
    extension(LibrarySort sort)
    {
        public string ToRaw() => sort switch
        {
            LibrarySort.Added => "added",
            LibrarySort.RatingHigh => "ratingHigh",
            LibrarySort.RatingLow => "ratingLow",
            LibrarySort.Name => "name",
            LibrarySort.Newest => "newest",
            LibrarySort.Oldest => "oldest",
            LibrarySort.Longest => "longest",
            _ => "recent",
        };

        public string Label => sort switch
        {
            LibrarySort.Added => "Recently added",
            LibrarySort.RatingHigh => "Highest rated",
            LibrarySort.RatingLow => "Lowest rated",
            LibrarySort.Name => "Name",
            LibrarySort.Newest => "Newest first",
            LibrarySort.Oldest => "Oldest first",
            LibrarySort.Longest => "Longest first",
            _ => "Recently watched",
        };

        public static LibrarySort? FromRaw(string? raw) => raw switch
        {
            "recent" => LibrarySort.Recent,
            "added" => LibrarySort.Added,
            "ratingHigh" => LibrarySort.RatingHigh,
            "ratingLow" => LibrarySort.RatingLow,
            "name" => LibrarySort.Name,
            "newest" => LibrarySort.Newest,
            "oldest" => LibrarySort.Oldest,
            "longest" => LibrarySort.Longest,
            _ => null,
        };

        public static IReadOnlyList<LibrarySort> AllCases =>
        [
            LibrarySort.Recent, LibrarySort.Added, LibrarySort.RatingHigh, LibrarySort.RatingLow,
            LibrarySort.Name, LibrarySort.Newest, LibrarySort.Oldest, LibrarySort.Longest,
        ];
    }
}

/// <summary>How the library is filtered and sorted. Pure, so the rules can be tested.</summary>
public sealed record LibraryQuery
{
    public LibraryList List { get; init; } = LibraryList.All;
    public LibraryKind Kind { get; init; } = LibraryKind.Any;
    public IReadOnlySet<string> Genres { get; init => field = ValueSet<string>.Of(value); } = ValueSet<string>.Empty;
    public RatingFilter Rating { get; init; } = RatingFilter.Any;
    /// <summary>The first year of a decade, such as 1990.</summary>
    public int? Decade { get; init; }
    /// <summary>Only what's downloaded to this PC (the Mac's name kept).</summary>
    public bool OnThisMac { get; init; }
    public string Text { get; init; } = "";
    public LibrarySort Sort { get; init; } = LibrarySort.Recent;

    /// <summary>Anything narrowing the list beyond which list and kind it is.</summary>
    public bool HasFilters => Genres.Count > 0 || Rating != RatingFilter.Any || Decade is not null || OnThisMac || Text.Length > 0;

    public IReadOnlyList<Title> Apply(IEnumerable<Title> titles, IReadOnlySet<long>? downloaded = null)
    {
        var needle = LibraryText.Normalize(Text);
        var kept = titles.Where(title =>
        {
            if (!List.Matches(title) || !Kind.Matches(title) || !Rating.Matches(title)) return false;
            if (needle.Length > 0 && !title.NormName.Contains(needle, StringComparison.Ordinal)) return false;
            if (Genres.Count > 0)
            {
                var own = title.Genres.Select(LibraryText.CanonicalGenre).ToHashSet();
                if (!own.Overlaps(Genres)) return false;
            }
            if (Decade is int decade)
            {
                if (title.Year is not int year || year < decade || year >= decade + 10) return false;
            }
            if (OnThisMac && (downloaded is null || !downloaded.Contains(title.Id))) return false;
            return true;
        });
        return [.. kept.OrderBy(t => t, Comparer<Title>.Create(Compare))];
    }

    private int Compare(Title a, Title b) => IsOrderedBefore(a, b) ? -1 : IsOrderedBefore(b, a) ? 1 : 0;

    private bool IsOrderedBefore(Title a, Title b)
    {
        bool ByName() => CompareNames(a.Name, b.Name) < 0;
        switch (Sort)
        {
            case LibrarySort.Recent:
            {
                var x = a.LastWatchedAt ?? a.FinishedAt ?? a.AddedAt;
                var y = b.LastWatchedAt ?? b.FinishedAt ?? b.AddedAt;
                return x == y ? ByName() : x > y;
            }
            case LibrarySort.Added:
                return a.AddedAt == b.AddedAt ? ByName() : a.AddedAt > b.AddedAt;
            case LibrarySort.RatingHigh or LibrarySort.RatingLow:
                // Unrated always last, whichever way.
                return (a.RatingHalves, b.RatingHalves) switch
                {
                    (int x, int y) => x == y ? ByName() : Sort == LibrarySort.RatingHigh ? x > y : x < y,
                    (not null, null) => true,
                    (null, not null) => false,
                    _ => ByName(),
                };
            case LibrarySort.Name:
                return ByName();
            case LibrarySort.Newest or LibrarySort.Oldest:
                return (a.Year, b.Year) switch
                {
                    (int x, int y) => x == y ? ByName() : Sort == LibrarySort.Newest ? x > y : x < y,
                    (not null, null) => true,
                    (null, not null) => false,
                    _ => ByName(),
                };
            default:
            {
                var x = a.RuntimeMinutes ?? -1;
                var y = b.RuntimeMinutes ?? -1;
                return x == y ? ByName() : x > y;
            }
        }
    }

    /// <summary>
    /// Finder's order, Swift's <c>localizedStandardCompare</c>: case-insensitive, numbers by value
    /// ("Alien 2" before "Alien 10"), and never equal for different text.
    /// </summary>
    public static int CompareNames(string a, string b)
    {
        int result;
        try
        {
            result = string.Compare(a, b, CultureInfo.CurrentCulture,
                CompareOptions.IgnoreCase | CompareOptions.IgnoreWidth | CompareOptions.NumericOrdering);
        }
        catch (ArgumentException)
        {
            result = string.Compare(a, b, CultureInfo.CurrentCulture, CompareOptions.IgnoreCase | CompareOptions.IgnoreWidth);
        }
        return result != 0 ? result : string.CompareOrdinal(a, b);
    }

    /// <summary>Swift's <c>genres(in:)</c>: the genres present in these titles, most common first.</summary>
    public static IReadOnlyList<(string Name, int Count)> GenresIn(IEnumerable<Title> titles)
    {
        var counts = new Dictionary<string, int>();
        foreach (var title in titles)
        {
            foreach (var genre in title.Genres.Select(LibraryText.CanonicalGenre).ToHashSet())
            {
                counts[genre] = counts.GetValueOrDefault(genre) + 1;
            }
        }
        return [.. counts
            .Select(pair => (Name: pair.Key, Count: pair.Value))
            .OrderByDescending(g => g.Count)
            .ThenBy(g => g.Name, StringComparer.Ordinal)];
    }

    /// <summary>Swift's <c>decades(in:)</c>: the decades present, newest first.</summary>
    public static IReadOnlyList<int> DecadesIn(IEnumerable<Title> titles) =>
        [.. titles
            .Where(t => t.Year is not null)
            .Select(t => t.Year!.Value / 10 * 10)
            .Where(d => d > 1880)
            .Distinct()
            .OrderDescending()];
}
