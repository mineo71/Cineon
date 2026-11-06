using Cineon.Core.Profile;

namespace Cineon.Core.Tests.Profile;

/// <summary>The profile tests from CineonTests/ProfileAndRatingTests.swift, plus a few for the Windows inputs.</summary>
public class ProfileStatsTests
{
    /// <summary>Somewhere not UTC, so local days and hours are really local.</summary>
    private static readonly TimeZoneInfo Zone =
        TimeZoneInfo.CreateCustomTimeZone("Cineon/Test", TimeSpan.FromHours(2), "Test", "Test");

    private static DateTimeOffset LocalTime(int year, int month, int day, int hour) =>
        new(year, month, day, hour, 0, 0, TimeSpan.FromHours(2));

    private static StatsTitle Title(
        long id, string name, StatsStatus status = StatsStatus.Watched, bool series = false, int? year = 2010,
        string[]? genres = null, int? halves = null, int? runtime = null) => new()
    {
        Id = id, Name = name, Status = status, IsSeries = series, Year = year, Genres = genres ?? [],
        RatingHalves = halves, RuntimeMinutes = runtime,
    };

    [Fact]
    public void ProfileStatsFromALibrary()
    {
        var now = LocalTime(2026, 11, 5, 22);
        StatsTitle[] titles =
        [
            Title(1, "Alien", genres: ["Horror", "Sci-Fi"], halves: 18, runtime: 117),
            Title(2, "Heat", genres: ["Crime", "Drama"], halves: 16, runtime: 170),
            Title(3, "Saw", genres: ["Horror"], halves: 10),
            Title(4, "Lost", status: StatsStatus.Watching, series: true, year: 2004, genres: ["Drama", "Mystery"]),
        ];
        StatsSession Session(long titleId, int daysAgo, int hour, double seconds)
        {
            var start = LocalTime(2026, 11, 5, 0).AddDays(-daysAgo).AddHours(hour);
            return new StatsSession(titleId, start, start.AddSeconds(seconds), seconds);
        }
        StatsSession[] sessions =
        [
            Session(4, daysAgo: 0, hour: 21, seconds: 3600),
            Session(4, daysAgo: 1, hour: 21, seconds: 1800),
            Session(4, daysAgo: 2, hour: 20, seconds: 2700),
            Session(1, daysAgo: 10, hour: 23, seconds: 7000),
        ];
        var progress = Enumerable.Range(1, 6).Select(_ => new StatsProgress(4, IsEpisode: true, Finished: true));
        var stats = ProfileStats.Compute(titles, sessions, progress, now: now, timeZone: Zone);
        Assert.Equal(3, stats.FilmsWatched);
        Assert.Equal(6, stats.EpisodesFinished);
        Assert.Equal(3, stats.Rated);
        Assert.Equal((9 + 8 + 5) / 3.0, stats.AverageRating ?? 0, 0.001);
        Assert.Equal(1, stats.RatingCounts[8]); // a 9 lands in the ninth bucket
        Assert.Equal(3, stats.CurrentStreak);
        Assert.Equal(3, stats.LongestStreak);
        Assert.Equal((3600 + 1800 + 2700 + 7000) / 3600.0, stats.TrackedHours, 0.001);
        // Heat and Saw were never timed, so their runtimes count, Saw with the usual length.
        Assert.Equal(stats.TrackedHours + 170.0 / 60 + 110.0 / 60, stats.EstimatedHours, 0.001);
        Assert.Equal("Horror", stats.FavouriteGenre);
        Assert.Equal(1, stats.Genres.Sum(g => g.Weight), 0.0001);
        Assert.Equal(21, stats.BusiestHour);
        Assert.Equal(4, stats.TopTitles.First().Id); // Lost had the most time, over three evenings
        Assert.Equal(0, stats.DaysSinceLastWatch(now, Zone));
        Assert.Equal(stats.TitlesFinished, stats.PetTraits("abc", now, Zone).TitlesFinished);
    }

    [Fact]
    public void EmptyLibraryHasCalmStats()
    {
        var stats = ProfileStats.Compute([], [], []);
        Assert.Null(stats.FavouriteGenre);
        Assert.Null(stats.AverageRating);
        Assert.Null(stats.BusiestWeekday);
        Assert.Null(stats.DaysSinceLastWatch());
        Assert.Equal(0, stats.CurrentStreak);
    }

    // MARK: Windows additions

    [Fact]
    public void DaysWeekdaysAndHoursAreLocal()
    {
        // 23:30 UTC on Sunday 1 November is 01:30 on Monday 2 November two hours east.
        var start = new DateTimeOffset(2026, 11, 1, 23, 30, 0, TimeSpan.Zero);
        var stats = ProfileStats.Compute(
            [Title(1, "Heat")], [new StatsSession(1, start, start.AddHours(2), 7200)], [],
            now: new DateTimeOffset(2026, 11, 3, 12, 0, 0, TimeSpan.Zero), timeZone: Zone);
        Assert.Equal(0, stats.BusiestWeekday); // Monday
        Assert.Equal(1, stats.BusiestHour);
        Assert.Equal(new DateOnly(2026, 11, 2), stats.Binge?.Day);
        Assert.Equal(1, stats.CurrentStreak); // yesterday, locally
        Assert.Equal(1, stats.DaysSinceLastWatch(new DateTimeOffset(2026, 11, 3, 12, 0, 0, TimeSpan.Zero), Zone));
    }

    [Fact]
    public void GenresMergeUnderOneName()
    {
        Assert.Equal("Sci-Fi", ProfileStats.CanonicalGenre("Science Fiction"));
        Assert.Equal("Sci-Fi", ProfileStats.CanonicalGenre(" sci-fi "));
        Assert.Equal("Film-Noir", ProfileStats.CanonicalGenre("Film Noir"));
        Assert.Equal("TV Movie", ProfileStats.CanonicalGenre("tv movie"));
        Assert.Equal("Drama", ProfileStats.CanonicalGenre("drama"));
        Assert.Equal(" drama", ProfileStats.CanonicalGenre(" drama")); // Swift keeps the raw text here too
        Assert.Equal("", ProfileStats.CanonicalGenre(""));
        var stats = ProfileStats.Compute(
            [Title(1, "Alien", genres: ["Science Fiction"]), Title(2, "Dune", genres: ["Sci-Fi"]), Title(3, "Heat", genres: ["Crime"])],
            [], []);
        Assert.Equal("Sci-Fi", stats.FavouriteGenre);
        Assert.Equal(2, stats.Genres.Count);
        Assert.Equal(2010, stats.FavouriteDecade);
    }

    [Fact]
    public void PetGrowsFromTheStats()
    {
        var now = LocalTime(2026, 11, 5, 22);
        var stats = ProfileStats.Compute(
            [Title(1, "Alien", genres: ["Horror"]), Title(2, "Heat", genres: ["Crime"], status: StatsStatus.Backlog)],
            [new StatsSession(1, now.AddHours(-3), now.AddHours(-1), 7200)], [], now: now, timeZone: Zone);
        var pet = PixelPet.Make(stats.PetTraits(PetTraits.SeedFor(Guid.Parse("8e1f3c1a-7a43-4c1b-9c0b-2b7d1d6c9a11")), now, Zone));
        Assert.Equal(PetSpecies.Ghost, pet.Species);
        Assert.Equal(PetAccessory.Fedora, pet.Accessory);
        Assert.Equal(PetMood.Happy, pet.Mood);
    }
}
