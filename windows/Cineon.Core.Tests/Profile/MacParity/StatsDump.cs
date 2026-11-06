using System.Globalization;
using System.Text;
using Cineon.Core.Profile;

namespace Cineon.Core.Tests.Profile.MacParity;

/// <summary>
/// The C# twin of StatsDump.swift: the same generated libraries and the same text, line for line. Any change
/// here must be made there too (and the expected hashes in ProfileStatsMacParityTests regenerated on a Mac).
/// </summary>
internal static class StatsDump
{
    private sealed class StatsMix(ulong state)
    {
        private ulong state = state;

        public ulong Next()
        {
            unchecked
            {
                state += 0x9E37_79B9_7F4A_7C15;
                var z = state;
                z = (z ^ (z >> 30)) * 0xBF58_476D_1CE4_E5B9;
                z = (z ^ (z >> 27)) * 0x94D0_49BB_1331_11EB;
                return z ^ (z >> 31);
            }
        }

        public int Below(int n) => (int)(Next() % (ulong)n);
    }

    private static readonly string[] StatsGenres =
    [
        "Horror", "Sci-Fi", "Science Fiction", "sci-fi", "science-fiction", "Drama", " Drama", "drama", "Crime",
        "film noir", "Film-Noir", "TV Movie", "tv movie", "Comedy", "comedy", "Animation", "Documentary", "War",
    ];

    public static readonly string[] Zones = ["UTC", "Europe/Berlin", "America/Los_Angeles", "Asia/Kolkata", "Pacific/Chatham"];

    private static readonly DateTimeOffset ReferenceDate = new(2001, 1, 1, 0, 0, 0, TimeSpan.Zero);

    private static DateTimeOffset Date(double secondsSinceReference) => ReferenceDate.AddSeconds(secondsSinceReference);

    private static string F6(double v) => v.ToString("F6", CultureInfo.InvariantCulture);

    private static string I(int v) => v.ToString(CultureInfo.InvariantCulture);

    private static string Library(StatsMix rng, TimeZoneInfo zone)
    {
        const double baseTime = 815_000_000.0;
        var count = rng.Below(41);
        var titles = new List<StatsTitle>();
        for (var i = 0; i < count; i++)
        {
            long id = i + 1;
            var yearRoll = rng.Below(10);
            var year = rng.Below(180) + 1850;
            var series = rng.Below(4) == 0;
            var status = new[] { StatsStatus.None, StatsStatus.Backlog, StatsStatus.Watching, StatsStatus.Watched }[rng.Below(4)];
            var genreCount = rng.Below(4);
            var genres = new List<string>();
            for (var g = 0; g < genreCount; g++) genres.Add(StatsGenres[rng.Below(StatsGenres.Length)]);
            var runtimeRoll = rng.Below(5);
            var runtime = 20 + rng.Below(180);
            var halvesRoll = rng.Below(3);
            var halves = 1 + rng.Below(20);
            var watchedRoll = rng.Below(3);
            var watched = baseTime + rng.Below(400 * 86400);
            titles.Add(new StatsTitle
            {
                Id = id, Name = $"T{id}", Year = yearRoll == 0 ? null : year, IsSeries = series, Status = status,
                Genres = genres, RuntimeMinutes = runtimeRoll == 0 ? null : runtime,
                RatingHalves = halvesRoll == 0 ? null : halves, LastWatchedAt = watchedRoll == 0 ? null : Date(watched),
            });
        }
        var sessions = new List<StatsSession>();
        var sessionCount = rng.Below(81);
        for (var i = 0; i < sessionCount; i++)
        {
            long titleId = 1 + rng.Below(count + 2);
            var start = baseTime + rng.Below(400 * 86400);
            // The thousandths keep every title's and day's total unique: the Mac breaks ties by dictionary order.
            var seconds = rng.Below(4 * 3600) + sessions.Count * 0.001;
            double extra = rng.Below(600);
            sessions.Add(new StatsSession(titleId, Date(start), Date(start + seconds + extra), seconds));
        }
        var progress = new List<StatsProgress>();
        var progressCount = rng.Below(61);
        for (var i = 0; i < progressCount; i++)
        {
            long titleId = 1 + rng.Below(count + 2);
            var film = rng.Below(3) == 0;
            var season = rng.Below(3);
            var episode = rng.Below(10);
            var finished = rng.Below(2) == 0;
            progress.Add(new StatsProgress(titleId, IsEpisode: !film && (season > 0 || episode > 0), Finished: finished));
        }
        int moments = rng.Below(100), ads = rng.Below(100), downloads = rng.Below(100);
        var now = Date(baseTime + 400 * 86400 + rng.Below(86400));
        var s = ProfileStats.Compute(titles, sessions, progress, moments, ads, downloads, now, zone);

        var out_ = new StringBuilder();
        out_.Append($"hours {F6(s.TrackedHours)} {F6(s.EstimatedHours)} {F6(s.ThisYearHours)}");
        out_.Append($" counts {I(s.FilmsWatched)} {I(s.SeriesFinished)} {I(s.EpisodesFinished)} {I(s.InLibrary)} {I(s.Backlog)} {I(s.Watching)}");
        out_.Append($" {I(s.Rated)} {(s.AverageRating is { } avg ? F6(avg) : "-")} {string.Join(',', s.RatingCounts.Select(I))}");
        // See StatsDump.swift: the Mac's total varies in the last bit, the nudge keeps halves off the midpoint.
        out_.Append(" | genres " + string.Join(',', s.Genres.Select(g => $"{g.Name}:{F6(g.Weight + 1e-12)}")));
        out_.Append(" | decades " + string.Join(',', s.Decades.Select(d => $"{I(d.Decade)}:{I(d.Count)}")));
        out_.Append(" | top " + string.Join(',', s.TopTitles.Select(t => $"{t.Id.ToString(CultureInfo.InvariantCulture)}:{F6(t.Hours)}:{I(t.Sessions)}")));
        out_.Append($" | streak {I(s.CurrentStreak)} {I(s.LongestStreak)}");
        out_.Append(s.Binge is { } binge
            ? $" binge {I(binge.Day.Year)}-{I(binge.Day.Month)}-{I(binge.Day.Day)} {F6(binge.Seconds)} {I(binge.Sessions)}"
            : " binge -");
        out_.Append(" | heat " + string.Join(';', s.Heatmap.Select(row => string.Join(',', row.Select(I)))));
        string Seconds(DateTimeOffset? d) => d is { } v ? ((long)(v - ReferenceDate).TotalSeconds).ToString(CultureInfo.InvariantCulture) : "-";
        out_.Append($" | {I(s.Sessions)} {Seconds(s.FirstWatch)} {Seconds(s.LastWatch)} {I(s.Moments)} {I(s.AdsBlocked)} {I(s.Downloads)}");
        out_.Append($" | fav {s.FavouriteGenre ?? "-"} {(s.FavouriteDecade is { } fd ? I(fd) : "-")} {I(s.TitlesFinished)}");
        out_.Append($" {(s.BusiestWeekday is { } wd ? I(wd) : "-")} {(s.BusiestHour is { } bh ? I(bh) : "-")}");
        out_.Append($" {(s.DaysSinceLastWatch(now, zone) is { } days ? I(days) : "-")}");
        out_.Append($" pet {PixelPet.Make(s.PetTraits("S", now, zone)).Code}\n");
        return out_.ToString();
    }

    public static string Zone(string zoneId)
    {
        var zone = TimeZoneInfo.FindSystemTimeZoneById(zoneId);
        var rng = new StatsMix(7);
        var text = new StringBuilder();
        for (var i = 0; i < 300; i++) text.Append(Library(rng, zone));
        return text.ToString();
    }
}
