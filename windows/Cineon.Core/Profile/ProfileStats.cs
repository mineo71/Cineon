// Port of Cineon/Profile/ProfileStats.swift. It takes its own small input records (StatsTitle, StatsSession,
// StatsProgress) instead of the library models, so callers map Title, WatchSession and WatchProgress into
// them. Calendar work (years, days, weekdays, hours) happens in a time zone, the local one by default, like
// the Mac's Calendar.current.

namespace Cineon.Core.Profile;

/// <summary>A title's list, as Swift's <c>TitleStatus</c>.</summary>
public enum StatsStatus { None, Backlog, Watching, Watched }

/// <summary>What the stats need of a library title.</summary>
public sealed record StatsTitle
{
    public required long Id { get; init; }
    public required string Name { get; init; }
    public string? PosterUrl { get; init; }
    public int? Year { get; init; }
    /// <summary><c>title.kind == .series</c>.</summary>
    public bool IsSeries { get; init; }
    public StatsStatus Status { get; init; }
    public IReadOnlyList<string> Genres { get; init; } = [];
    public int? RuntimeMinutes { get; init; }
    /// <summary>Out of ten in half steps, kept doubled: 15 is 7.5. null is not rated.</summary>
    public int? RatingHalves { get; init; }
    public DateTimeOffset? LastWatchedAt { get; init; }

    /// <summary>Out of ten, such as 7.5.</summary>
    public double? Rating => RatingHalves is { } halves ? halves / 2.0 : null;
}

/// <summary>What the stats need of a watch session.</summary>
public sealed record StatsSession(long TitleId, DateTimeOffset StartedAt, DateTimeOffset EndedAt, double WatchedSeconds);

/// <summary>What the stats need of a progress entry: <c>ref.isEpisode</c> (season or episode above 0) and finished.</summary>
public sealed record StatsProgress(long TitleId, bool IsEpisode, bool Finished);

/// <summary>
/// Everything the profile page says about someone's watching, worked out from their library.
/// Pure, so it can be tested and computed off the UI thread.
/// </summary>
public sealed class ProfileStats : IEquatable<ProfileStats>
{
    public sealed record TopTitle(long Id, string Name, string? PosterUrl, double Hours, int Sessions);

    /// <summary>A local calendar day, with the time and number of sessions watched on it.</summary>
    public sealed record BingeDay(DateOnly Day, double Seconds, int Sessions);

    /// <summary>Time Cineon saw being watched.</summary>
    public double TrackedHours { get; private set; }
    /// <summary>Tracked time plus the runtimes of things finished before Cineon kept count.</summary>
    public double EstimatedHours { get; private set; }
    public double ThisYearHours { get; private set; }
    public int FilmsWatched { get; private set; }
    public int SeriesFinished { get; private set; }
    public int EpisodesFinished { get; private set; }
    public int InLibrary { get; private set; }
    public int Backlog { get; private set; }
    public int Watching { get; private set; }
    public int Rated { get; private set; }
    public double? AverageRating { get; private set; }
    /// <summary>How many titles have each whole rating, 1 to 10. Halves round up.</summary>
    public int[] RatingCounts { get; } = new int[10];
    /// <summary>Share of watching per genre, adding up to 1, biggest first.</summary>
    public IReadOnlyList<GenreWeight> Genres { get; private set; } = [];
    public IReadOnlyList<(int Decade, int Count)> Decades { get; private set; } = [];
    public IReadOnlyList<TopTitle> TopTitles { get; private set; } = [];
    public int CurrentStreak { get; private set; }
    public int LongestStreak { get; private set; }
    public BingeDay? Binge { get; private set; }
    /// <summary>Sessions by weekday (0 is Monday) and hour: 7 rows of 24.</summary>
    public int[][] Heatmap { get; } = Enumerable.Range(0, 7).Select(_ => new int[24]).ToArray();
    public int Sessions { get; private set; }
    public DateTimeOffset? FirstWatch { get; private set; }
    public DateTimeOffset? LastWatch { get; private set; }
    public int Moments { get; private set; }
    public int AdsBlocked { get; private set; }
    public int Downloads { get; private set; }

    public string? FavouriteGenre => Genres.Count > 0 ? Genres[0].Name : null;

    public int? FavouriteDecade
    {
        get
        {
            // Swift's max(by:) keeps the first of equal counts.
            (int Decade, int Count)? best = null;
            foreach (var entry in Decades)
            {
                if (best is null || best.Value.Count < entry.Count) best = entry;
            }
            return best?.Decade;
        }
    }

    public int TitlesFinished => FilmsWatched + SeriesFinished + EpisodesFinished / 4;

    public int? BusiestWeekday
    {
        get
        {
            var totals = Heatmap.Select(row => row.Sum()).ToArray();
            var best = totals.Max();
            return best > 0 ? Array.IndexOf(totals, best) : null;
        }
    }

    public int? BusiestHour
    {
        get
        {
            var totals = Enumerable.Range(0, 24).Select(hour => Heatmap.Sum(row => row[hour])).ToArray();
            var best = totals.Max();
            return best > 0 ? Array.IndexOf(totals, best) : null;
        }
    }

    /// <summary>
    /// Calendar days from the last watch to <paramref name="now"/> in <paramref name="timeZone"/> (the local one
    /// by default, like the Mac's <c>Calendar.current</c>), or null if nothing was watched.
    /// </summary>
    public int? DaysSinceLastWatch(DateTimeOffset? now = null, TimeZoneInfo? timeZone = null)
    {
        if (LastWatch is not { } lastWatch) return null;
        var zone = timeZone ?? TimeZoneInfo.Local;
        return LocalDay(now ?? DateTimeOffset.Now, zone).DayNumber - LocalDay(lastWatch, zone).DayNumber;
    }

    /// <summary>What the pet grows from. Days count in the local time zone unless told otherwise, as on the Mac.</summary>
    public PetTraits PetTraits(string seed, DateTimeOffset? now = null, TimeZoneInfo? timeZone = null) => new()
    {
        Genres = Genres,
        HoursWatched = EstimatedHours,
        TitlesFinished = TitlesFinished,
        DaysSinceLastWatch = DaysSinceLastWatch(now, timeZone),
        Seed = seed,
    };

    /// <summary>Equal enough to skip a redraw, as the Swift <c>==</c>: the same few fields.</summary>
    public bool Equals(ProfileStats? other) =>
        other is not null && EstimatedHours.Equals(other.EstimatedHours) && Sessions == other.Sessions
        && Rated == other.Rated && Genres.SequenceEqual(other.Genres) && InLibrary == other.InLibrary
        && LastWatch == other.LastWatch;

    public override bool Equals(object? obj) => Equals(obj as ProfileStats);

    public override int GetHashCode() => HashCode.Combine(EstimatedHours, Sessions, Rated, InLibrary, LastWatch);

    // MARK: Working it out

    public static ProfileStats Compute(
        IEnumerable<StatsTitle> titles, IEnumerable<StatsSession> sessions, IEnumerable<StatsProgress> progress,
        int moments = 0, int adsBlocked = 0, int downloads = 0, DateTimeOffset? now = null,
        TimeZoneInfo? timeZone = null)
    {
        var zone = timeZone ?? TimeZoneInfo.Local;
        var at = now ?? DateTimeOffset.Now;
        var titleList = titles.ToList();
        var sessionList = sessions.ToList();
        var stats = new ProfileStats
        {
            Moments = moments,
            AdsBlocked = adsBlocked,
            Downloads = downloads,
            InLibrary = titleList.Count,
            Sessions = sessionList.Count,
        };

        var byId = new Dictionary<long, StatsTitle>();
        foreach (var title in titleList) byId[title.Id] = title;
        var secondsByTitle = new Dictionary<long, double>();
        var sessionsByTitle = new Dictionary<long, int>();
        var year = Local(at, zone).Year;
        var days = new Dictionary<DateOnly, (double Seconds, int Count)>();

        foreach (var session in sessionList)
        {
            secondsByTitle[session.TitleId] = secondsByTitle.GetValueOrDefault(session.TitleId) + session.WatchedSeconds;
            sessionsByTitle[session.TitleId] = sessionsByTitle.GetValueOrDefault(session.TitleId) + 1;
            stats.TrackedHours += session.WatchedSeconds / 3600;
            var started = Local(session.StartedAt, zone);
            if (started.Year == year) stats.ThisYearHours += session.WatchedSeconds / 3600;
            var day = DateOnly.FromDateTime(started);
            var entry = days.GetValueOrDefault(day);
            days[day] = (entry.Seconds + session.WatchedSeconds, entry.Count + 1);
            // Monday first.
            var weekday = ((int)started.DayOfWeek + 6) % 7;
            stats.Heatmap[weekday][started.Hour] += 1;
            stats.FirstWatch = Min(stats.FirstWatch ?? session.StartedAt, session.StartedAt);
            stats.LastWatch = Max(stats.LastWatch ?? session.EndedAt, session.EndedAt);
        }
        foreach (var title in titleList)
        {
            if (title.LastWatchedAt is { } watched) stats.LastWatch = Max(stats.LastWatch ?? watched, watched);
        }

        // Finished episodes, and runtimes for what was finished without Cineon timing it.
        var finishedEpisodes = new Dictionary<long, int>();
        foreach (var entry in progress)
        {
            if (!entry.Finished || !entry.IsEpisode) continue;
            stats.EpisodesFinished += 1;
            finishedEpisodes[entry.TitleId] = finishedEpisodes.GetValueOrDefault(entry.TitleId) + 1;
        }
        stats.EstimatedHours = stats.TrackedHours;
        foreach (var title in titleList)
        {
            switch (title.Status)
            {
                case StatsStatus.Watched:
                    if (title.IsSeries) stats.SeriesFinished += 1;
                    else stats.FilmsWatched += 1;
                    break;
                case StatsStatus.Backlog:
                    stats.Backlog += 1;
                    break;
                case StatsStatus.Watching:
                    stats.Watching += 1;
                    break;
            }
            var tracked = secondsByTitle.GetValueOrDefault(title.Id) / 3600;
            if (!(tracked < 0.25)) continue;
            if (title.Status == StatsStatus.Watched && !title.IsSeries)
            {
                stats.EstimatedHours += (title.RuntimeMinutes ?? 110) / 60.0;
            }
            else if (finishedEpisodes.TryGetValue(title.Id, out var episodes))
            {
                stats.EstimatedHours += episodes * (double)(title.RuntimeMinutes ?? 45) / 60;
            }
        }

        // Ratings.
        var ratings = titleList.Where(t => t.Rating is not null).Select(t => t.Rating!.Value).ToList();
        stats.Rated = ratings.Count;
        if (ratings.Count > 0) stats.AverageRating = ratings.Aggregate(0.0, (sum, r) => sum + r) / ratings.Count;
        foreach (var rating in ratings)
        {
            stats.RatingCounts[Math.Min(9, Math.Max(0, (int)Math.Ceiling(rating) - 1))] += 1;
        }

        // Genres: what you watch, finish and rate highly counts most.
        var genreScore = new Dictionary<string, double>(StringComparer.Ordinal);
        foreach (var title in titleList)
        {
            if (title.Genres.Count == 0) continue;
            double weight = title.Status switch
            {
                StatsStatus.Watched => 2,
                StatsStatus.Watching => 1.5,
                StatsStatus.Backlog => 0.35,
                _ => sessionsByTitle.ContainsKey(title.Id) ? 0.8 : 0.2,
            };
            weight += Math.Min(6, secondsByTitle.GetValueOrDefault(title.Id) / 3600) * 0.4;
            if (title.Rating is { } rating) weight *= 0.6 + rating / 12.5;
            var share = weight / title.Genres.Count;
            foreach (var genre in title.Genres)
            {
                var key = CanonicalGenre(genre);
                genreScore[key] = genreScore.GetValueOrDefault(key) + share;
            }
        }
        var total = genreScore.Values.Aggregate(0.0, (sum, v) => sum + v);
        if (total > 0)
        {
            stats.Genres = genreScore
                .Select(p => new GenreWeight(p.Key, p.Value / total))
                .OrderByDescending(g => g.Weight)
                .ThenBy(g => g.Name, StringComparer.Ordinal)
                .ToList();
        }

        // Decades of what you've watched.
        var decades = new Dictionary<int, int>();
        foreach (var title in titleList)
        {
            if (!(title.Status is StatsStatus.Watched or StatsStatus.Watching || sessionsByTitle.ContainsKey(title.Id))) continue;
            if (title.Year is { } y && y > 1880) decades[y / 10 * 10] = decades.GetValueOrDefault(y / 10 * 10) + 1;
        }
        stats.Decades = decades.Select(p => (p.Key, p.Value)).OrderBy(d => d.Key).ToList();

        // Top titles by time, then by visits.
        stats.TopTitles = byId.Values
            .Where(t => sessionsByTitle.ContainsKey(t.Id))
            .Select(t => new TopTitle(t.Id, t.Name, t.PosterUrl, secondsByTitle.GetValueOrDefault(t.Id) / 3600,
                sessionsByTitle.GetValueOrDefault(t.Id)))
            .OrderByDescending(t => t.Hours)
            .ThenByDescending(t => t.Sessions)
            .Take(5)
            .ToList();

        // Streaks of days with any watching.
        var sortedDays = days.Keys.OrderBy(d => d).ToList();
        var run = 0;
        DateOnly? previous = null;
        foreach (var day in sortedDays)
        {
            run = previous is { } p && p.AddDays(1) == day ? run + 1 : 1;
            stats.LongestStreak = Math.Max(stats.LongestStreak, run);
            previous = day;
        }
        var today = LocalDay(at, zone);
        if (sortedDays.Count > 0 && sortedDays[^1] >= today.AddDays(-1)) stats.CurrentStreak = run;

        // The biggest day: most time, or most sessions when nothing was timed. Ties go to the earliest day
        // (on the Mac they go to whichever the dictionary happens to list first).
        foreach (var day in sortedDays)
        {
            var (seconds, count) = days[day];
            if (stats.Binge is null || (stats.Binge.Seconds, stats.Binge.Sessions).CompareTo((seconds, count)) < 0)
            {
                stats.Binge = new BingeDay(day, seconds, count);
            }
        }
        return stats;
    }

    /// <summary>One name per genre, whatever the source called it.</summary>
    public static string CanonicalGenre(string raw)
    {
        // Swift lower-cases İ (U+0130) to i + combining dot; .NET's invariant mapping is otherwise the same.
        var lower = raw.Replace("\u0130", "i\u0307").ToLowerInvariant().Trim(Whitespaces);
        switch (lower)
        {
            case "science fiction" or "sci-fi" or "scifi" or "science-fiction": return "Sci-Fi";
            case "film-noir" or "film noir": return "Film-Noir";
            case "tv movie": return "TV Movie";
        }
        if (raw.Length == 0) return raw;
        // raw.prefix(1).uppercased() + raw.dropFirst(): the first character (grapheme) upper-cased.
        var first = System.Globalization.StringInfo.GetNextTextElementLength(raw);
        return raw[..first].ToUpperInvariant() + raw[first..];
    }

    /// <summary>Foundation's <c>CharacterSet.whitespaces</c>: tab and space separators, plus U+200B.</summary>
    private static readonly char[] Whitespaces =
    [
        '\u0009', '\u0020', '\u00A0', '\u1680', '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005',
        '\u2006', '\u2007', '\u2008', '\u2009', '\u200A', '\u200B', '\u202F', '\u205F', '\u3000',
    ];

    private static DateTime Local(DateTimeOffset instant, TimeZoneInfo zone) => TimeZoneInfo.ConvertTime(instant, zone).DateTime;

    private static DateOnly LocalDay(DateTimeOffset instant, TimeZoneInfo zone) => DateOnly.FromDateTime(Local(instant, zone));

    private static DateTimeOffset Min(DateTimeOffset a, DateTimeOffset b) => b < a ? b : a;

    private static DateTimeOffset Max(DateTimeOffset a, DateTimeOffset b) => b > a ? b : a;
}
