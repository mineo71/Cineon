using Cineon.Core.Data;

namespace Cineon.Core.Tests.Data;

// Port of the store-related parts of CineonTests/ProfileAndRatingTests.swift: ratings, the
// five-to-ten-star migration, episode alerts and library filters. The star controls, profile
// stats, cloud keys and sleep timer belong to other ports.
public sealed class ProfileAndRatingTests
{
    private static Title MakeTitle(
        long id, string name, TitleStatus status = TitleStatus.Watched, TitleKind kind = TitleKind.Film, int? year = 2010,
        string[]? genres = null, int? halves = null, int? runtime = null, DateTimeOffset? added = null)
    {
        var at = added ?? DateTimeOffset.UtcNow;
        return new Title
        {
            Id = id, Name = name, NormName = LibraryText.Normalize(name), Year = year, Kind = kind, Status = status,
            ImdbId = null, PosterUrl = null, BackdropUrl = null, Overview = null, Genres = genres ?? [], RuntimeMinutes = runtime,
            RatingHalves = halves, Notes = null, AddedAt = at, UpdatedAt = at, FinishedAt = null, LastWatchedAt = null,
            MetadataChecked = true,
        };
    }

    // MARK: Ratings

    [Fact]
    public void RatingTextShowsHalves()
    {
        Assert.Equal("7.5", Rating.Text(15));
        Assert.Equal("8", Rating.Text(16));
        Assert.Equal("10", Rating.Text(20));
        Assert.Equal("0.5", Rating.Text(1));
        Assert.Equal(1, Rating.Clamp(0));
        Assert.Equal(20, Rating.Clamp(99));
    }

    [Fact]
    public void FiveStarRatingsBecomeTenWhenUpgrading()
    {
        using var folder = new TempFolder();
        var path = folder.File("cineon-test.sqlite");
        long id;
        using (var older = new Database(path))
        {
            // Back to how version 3 kept things: five stars, no dates, no alerts.
            older.Sql.Exec("""
                DROP TABLE episode_alerts;
                CREATE TABLE t AS SELECT * FROM titles;
                """);
            id = older.InsertTitle(MakeTitle(0, "Heat", halves: null));
            older.Sql.Exec($"UPDATE titles SET rating=4 WHERE id={id}");
            older.Sql.Exec("""
                DROP TABLE t;
                ALTER TABLE titles DROP COLUMN rated_at;
                ALTER TABLE titles DROP COLUMN status_at;
                PRAGMA user_version=3
                """);
            older.Sql.Close();
        }

        using var upgraded = new Database(path);
        Assert.Equal(4, upgraded.Sql.UserVersion);
        var loaded = upgraded.AllTitles().First(t => t.Id == id);
        Assert.Equal(16, loaded.RatingHalves); // 4 of 5 stars is 8 of 10
        Assert.NotNull(loaded.RatedAt);
        Assert.Empty(upgraded.EpisodeAlerts());
    }

    [Fact]
    public void EpisodeAlertsRoundTrip()
    {
        using var folder = new TempFolder();
        using var db = new Database(folder.File("cineon-test.sqlite"));
        var id = db.InsertTitle(MakeTitle(0, "The Bear", status: TitleStatus.Watching, kind: TitleKind.Series));
        var alert = new EpisodeAlert
        {
            TitleId = id, Latest = new EpisodeRef(3, 2), CheckedAt = DateTimeOffset.UtcNow,
            Newest = new EpisodeRef(3, 2), NewCount = 2, NewAt = DateTimeOffset.UtcNow,
        };
        db.SaveEpisodeAlert(alert);
        var loaded = db.EpisodeAlerts().First();
        Assert.Equal(alert.Latest, loaded.Latest);
        Assert.Equal(alert.Newest, loaded.Newest);
        Assert.Equal(2, loaded.NewCount);

        db.SaveEpisodeAlert(alert with { Newest = null, NewCount = 0, NewAt = null });
        var cleared = Assert.Single(db.EpisodeAlerts());
        Assert.Null(cleared.Newest);
        Assert.Null(cleared.NewAt);
    }

    // MARK: Library filters

    [Fact]
    public void FiltersAndSorts()
    {
        Title[] titles =
        [
            MakeTitle(1, "Alien", year: 1979, genres: ["Horror", "Sci-Fi"], halves: 18, runtime: 117),
            MakeTitle(2, "Blade Runner", year: 1982, genres: ["Science Fiction"], halves: 15, runtime: 117),
            MakeTitle(3, "Clueless", year: 1995, genres: ["Comedy"], halves: null, runtime: 97),
            MakeTitle(4, "Dune", status: TitleStatus.Backlog, year: 2021, genres: ["Sci-Fi"], halves: null, runtime: 155),
            MakeTitle(5, "Euphoria", status: TitleStatus.Watching, kind: TitleKind.Series, year: 2019, genres: ["Drama"], halves: 12),
        ];
        long[] Ids(LibraryQuery query, IReadOnlySet<long>? downloaded = null) => [.. query.Apply(titles, downloaded).Select(t => t.Id)];

        // Science Fiction counts as Sci-Fi.
        Assert.Equal([1, 2, 4], Ids(new LibraryQuery { Genres = new HashSet<string> { "Sci-Fi" } }).Order());

        Assert.Equal([1, 2], Ids(new LibraryQuery { Rating = RatingFilter.AtLeast(7), Sort = LibrarySort.RatingHigh }));

        Assert.Equal([3], Ids(new LibraryQuery { Rating = RatingFilter.Unrated, List = LibraryList.Watched }));

        Assert.Equal([2], Ids(new LibraryQuery { Decade = 1980 }));

        Assert.Equal([5], Ids(new LibraryQuery { Kind = LibraryKind.Series }));

        Assert.Equal([3], Ids(new LibraryQuery { OnThisMac = true }, new HashSet<long> { 3 }));

        // Lowest first, unrated last by name.
        Assert.Equal([5, 2, 1, 3, 4], Ids(new LibraryQuery { Sort = LibrarySort.RatingLow }));

        var query = new LibraryQuery { Sort = LibrarySort.Oldest };
        Assert.Equal(1, Ids(query).First());
        query = query with { Text = "blade" };
        Assert.Equal([2], Ids(query));
        Assert.True(query.HasFilters);
    }

    [Fact]
    public void GenresAndDecadesInALibrary()
    {
        Title[] titles =
        [
            MakeTitle(1, "Alien", year: 1979, genres: ["Horror", "Sci-Fi"]),
            MakeTitle(2, "Blade Runner", year: 1982, genres: ["Science Fiction", "sci-fi"]),
            MakeTitle(3, "Clueless", year: 1995, genres: ["comedy"]),
            MakeTitle(4, "Old", year: 1880, genres: []),
        ];
        Assert.Equal([("Sci-Fi", 2), ("Comedy", 1), ("Horror", 1)], LibraryQuery.GenresIn(titles));
        Assert.Equal([1990, 1980, 1970], LibraryQuery.DecadesIn(titles));
    }

    [Fact]
    public void NamesSortLikeFinder()
    {
        string[] names = ["alien 10", "Alien 2", "Alien", "Ánimo", "Zebra", "apple"];
        var sorted = names.Order(Comparer<string>.Create(LibraryQuery.CompareNames)).ToArray();
        Assert.Equal(["Alien", "Alien 2", "alien 10", "Ánimo", "apple", "Zebra"], sorted);
        Assert.NotEqual(0, LibraryQuery.CompareNames("Dune", "dune"));
    }

    [Fact]
    public void QueriesCompareByValue()
    {
        var a = new LibraryQuery { Genres = new HashSet<string> { "Drama", "Horror" } };
        var b = new LibraryQuery { Genres = new HashSet<string> { "Horror", "Drama" } };
        Assert.Equal(a, b);
        Assert.Equal(a.GetHashCode(), b.GetHashCode());
        Assert.False(new LibraryQuery().HasFilters);
        Assert.Equal("8 and up", RatingFilter.AtLeast(8).Label);
        Assert.Equal("Under 5", RatingFilter.Below(5).Label);
        Assert.Equal(7, RatingFilter.Choices.Count);
    }
}
