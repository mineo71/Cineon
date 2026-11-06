using System.Text;
using Cineon.Core.Data;

namespace Cineon.Core.Tests.Data;

// Port of CineonTests/DatabaseTests.swift.
public sealed class DatabaseTests : IDisposable
{
    private readonly TempFolder _folder = new();
    private readonly Database _db;

    public DatabaseTests() => _db = new Database(_folder.File("cineon-test.sqlite"));

    public void Dispose()
    {
        _db.Dispose();
        _folder.Dispose();
    }

    private static Title MakeTitle(string name = "Dune") => new()
    {
        Id = 0, Name = name, NormName = LibraryText.Normalize(name), Year = 2021, Kind = TitleKind.Film, Status = TitleStatus.Backlog,
        ImdbId = null, PosterUrl = new Uri("https://x.example/p.jpg"), BackdropUrl = null, Overview = null,
        Genres = ["Sci-Fi", "Drama"], RuntimeMinutes = 155, RatingHalves = null, Notes = null,
        AddedAt = DateTimeOffset.UtcNow, UpdatedAt = DateTimeOffset.UtcNow, FinishedAt = null, LastWatchedAt = null, MetadataChecked = false,
    };

    private static WatchSession MakeSession(long titleId) => new()
    {
        Id = 0, TitleId = titleId, Ref = EpisodeRef.None, EpisodeName = null, Url = null, Host = "site",
        StartedAt = DateTimeOffset.UtcNow, EndedAt = DateTimeOffset.UtcNow, WatchedSeconds = 60, StartPosition = 0, EndPosition = 60,
        Duration = 100, Finished = false,
    };

    [Fact]
    public void TitleRoundTrip()
    {
        var id = _db.InsertTitle(MakeTitle());
        var loaded = _db.AllTitles().First(t => t.Id == id);
        Assert.Equal("Dune", loaded.Name);
        Assert.Equal(["Sci-Fi", "Drama"], loaded.Genres);
        Assert.Equal(TitleStatus.Backlog, loaded.Status);
    }

    [Fact]
    public void ProgressUpsertKeepsFinishedFlag()
    {
        var id = _db.InsertTitle(MakeTitle());
        var p = new WatchProgress
        {
            TitleId = id, Ref = EpisodeRef.None, UrlKey = "site/x", Url = null, Host = "site", Position = 100, Duration = 200,
            Finished = true, UpdatedAt = DateTimeOffset.UtcNow,
        };
        _db.UpsertProgress(p);
        _db.UpsertProgress(p with { Position = 10, Finished = false });
        var loaded = _db.Progress(id, EpisodeRef.None);
        Assert.NotNull(loaded);
        Assert.Equal(10, loaded.Position);
        Assert.True(loaded.Finished);
        Assert.Equal(id, _db.Progress("site/x")?.TitleId);
    }

    [Fact]
    public void DeletingTitleRemovesItsRecords()
    {
        var id = _db.InsertTitle(MakeTitle());
        _db.InsertSession(MakeSession(id));
        _db.DeleteTitle(id);
        Assert.Empty(_db.Sessions());
    }

    [Fact]
    public void MergeMovesSessionsAndRemovesSource()
    {
        var a = _db.InsertTitle(MakeTitle("A"));
        var b = _db.InsertTitle(MakeTitle("B"));
        _db.InsertSession(MakeSession(a));
        _db.MergeTitle(a, b);
        Assert.Single(_db.SessionsForTitle(b));
        Assert.DoesNotContain(_db.AllTitles(), t => t.Id == a);
    }

    [Fact]
    public void HistoryCollapsesRepeatVisits()
    {
        var url = new Uri("https://site.example/x");
        _db.AddHistory(url, "site.example", "One");
        _db.AddHistory(url, "site.example", "Two");
        var rows = _db.RecentHistory();
        Assert.Single(rows);
        Assert.Equal("Two", rows[0].Title);
    }

    [Fact]
    public void StatsAccumulate()
    {
        _db.AddStats(new ShieldStats { Ads = 2, Popups = 1 }, "2026-11-01");
        _db.AddStats(new ShieldStats { Ads = 3 }, "2026-11-01");
        var total = _db.TotalStats();
        Assert.Equal(5, total.Ads);
        Assert.Equal(6, total.Total);
    }

    [Fact]
    public void SettingsSurviveUnknownFields()
    {
        _db.SaveSettings(new AppSettings() with { Theme = AppTheme.White });
        Assert.Equal(AppTheme.White, _db.LoadSettings().Theme);
        var partial = Encoding.UTF8.GetBytes("""{"theme":"dark","somethingNew":true}""");
        var decoded = AppSettings.Decode(partial);
        Assert.NotNull(decoded);
        Assert.Equal(AppTheme.Dark, decoded.Theme);
        Assert.True(decoded.AutoResume);
    }

    [Fact]
    public void TabsRoundTrip()
    {
        var id = Guid.NewGuid();
        _db.SaveTabs([new PersistedTab
        {
            Id = id, Url = new Uri("https://x.example"), Title = "X", FaviconUrl = null, Position = 0, IsActive = true,
            State = [1, 2, 3], IsPinnedToSearch = false,
        }]);
        var loaded = _db.LoadTabs();
        Assert.Equal(id, loaded.First().Id);
        Assert.Equal([1, 2, 3], loaded.First().State);
    }

    // Beyond the Mac's tests: the rest of the tables, so every query here has run at least once.

    [Fact]
    public void EverythingElseRoundTrips()
    {
        var titleId = _db.InsertTitle(MakeTitle() with { Kind = TitleKind.Series });
        var episode = new EpisodeRef(1, 2);

        var session = MakeSession(titleId) with { Ref = episode, Url = new Uri("https://site.example/s1e2") };
        var sessionId = _db.InsertSession(session);
        _db.UpdateSession(session with { Id = sessionId, WatchedSeconds = 90, Finished = true });
        Assert.True(_db.SessionsForTitle(titleId).Single().Finished);
        Assert.Equal(sessionId, _db.LatestSession(titleId, episode, DateTimeOffset.UtcNow.AddMinutes(-1))?.Id);
        Assert.Equal(sessionId, _db.LatestSession(new Uri("https://site.example/s1e2"))?.Id);
        Assert.Equal(90, _db.TotalSeconds(DateTimeOffset.UtcNow.AddDays(-1)));
        var perDay = _db.SecondsPerDay(DateTimeOffset.UtcNow.AddDays(-1));
        Assert.Equal(90, Assert.Single(perDay).Seconds);
        Assert.Equal(TimeSpan.Zero, perDay[0].Day.TimeOfDay);

        _db.SaveSkipRule(new SkipRule
        {
            TitleId = titleId, Site = "site", Kind = SkipRuleKind.Intro, Start = 10, End = 70, Sightings = 1, UpdatedAt = DateTimeOffset.UtcNow,
        });
        _db.SaveSkipRule(new SkipRule
        {
            TitleId = titleId, Site = "site", Kind = SkipRuleKind.Intro, Start = 12, End = 72, Sightings = 2, UpdatedAt = DateTimeOffset.UtcNow,
        });
        var rule = Assert.Single(_db.SkipRules(titleId, "site"));
        Assert.Equal((12.0, 2), (rule.Start, rule.Sightings));
        _db.DeleteSkipRule(rule.Id);
        Assert.Empty(_db.SkipRules(titleId));

        var frameId = _db.InsertFrame(new FilmFrame
        {
            SessionId = sessionId, TitleId = titleId, Ref = episode, Position = 30, File = "1/a.jpg", IsMoment = true, Interest = 0.5,
            At = DateTimeOffset.UtcNow,
        });
        var frame = Assert.Single(_db.AllFrames());
        Assert.Equal((frameId, (long?)sessionId, "1/a.jpg", true), (frame.Id, frame.SessionId, frame.File, frame.IsMoment));
        _db.DeleteSession(sessionId);
        Assert.Null(Assert.Single(_db.AllFrames()).SessionId);
        _db.DeleteAllFrames();
        Assert.Empty(_db.AllFrames());

        var download = new DownloadItem
        {
            TitleId = titleId, Ref = episode, Name = "Show", SourceUrl = new Uri("https://cdn.example/a.m3u8"), Host = "cdn.example",
            Kind = MediaSourceKind.Hls, Quality = "720p", Subtitles = ["/tmp/a.vtt", "/tmp/b.vtt"], Status = DownloadStatus.Queued,
            CreatedAt = DateTimeOffset.UtcNow,
        };
        var downloadId = _db.InsertDownload(download);
        _db.UpdateDownload(download with { Id = downloadId, Status = DownloadStatus.Done, Bytes = 10, TotalBytes = 10 });
        var loaded = Assert.Single(_db.AllDownloads());
        Assert.Equal(download with { Id = downloadId, Status = DownloadStatus.Done, Bytes = 10, TotalBytes = 10, CreatedAt = loaded.CreatedAt }, loaded);
        _db.DeleteDownload(downloadId);
        Assert.Empty(_db.AllDownloads());

        _db.AddEvent(LibraryEventKind.MarkedWatching, titleId);
        Assert.Equal(LibraryEventKind.MarkedWatching, Assert.Single(_db.Events()).Kind);

        _db.SetLink("site/x", titleId, episode);
        Assert.Equal((titleId, episode), _db.Link("site/x"));
        Assert.Null(_db.Link("site/y"));
        Assert.False(_db.IsIgnored("site/z"));
        _db.Ignore("site/z");
        Assert.True(_db.IsIgnored("site/z"));

        var siteId = _db.InsertSite(new Site { Name = "Site", Host = "site.example", HomeUrl = new Uri("https://site.example"), AddedAt = DateTimeOffset.UtcNow });
        var site = Assert.Single(_db.AllSites());
        Assert.Equal("https://site.example", site.HomeUrl.OriginalString);
        _db.UpdateSite(site with { SearchTemplate = "https://site.example/?q=%s" });
        Assert.Equal("https://site.example/?q=%s", _db.AllSites()[0].SearchTemplate);
        _db.DeleteSite(siteId);
        Assert.Empty(_db.AllSites());

        _db.AddHistory(new Uri("https://site.example/films/dune"), "site.example", "Dune");
        _db.UpdateHistoryTitle(new Uri("https://site.example/films/dune"), "Dune (2021)");
        Assert.Equal("Dune (2021)", Assert.Single(_db.SearchHistory("dune")).Title);
        Assert.Contains("site.example", _db.KnownHosts());
        _db.ClearHistory();
        Assert.Empty(_db.RecentHistory());

        _db.SaveSitePrefs(new SitePrefs("site.example") { AllowPopups = true });
        Assert.True(_db.SitePrefs()["site.example"].AllowPopups);

        _db.ClearProgress(titleId, episode);
    }

    [Fact]
    public void ValuesAreStoredWithTheMacsTypes()
    {
        var id = _db.InsertTitle(MakeTitle());
        _db.SaveSettings(new AppSettings());
        var types = _db.Sql.Query(
            "SELECT typeof(added_at),typeof(metadata_checked),typeof(genres),typeof(year),typeof(rating) FROM titles WHERE id=?",
            [id], r => (r.Text(0), r.Text(1), r.Text(2), r.Text(3), r.Text(4))).Single();
        Assert.Equal(("real", "integer", "text", "integer", "null"), types);
        Assert.Equal("blob", _db.Sql.Query("SELECT typeof(value) FROM settings WHERE key='app'", r => r.Text(0)).Single());
    }

    [Fact]
    public void MacWrittenDatesSurviveARewrite()
    {
        // Values as the Mac wrote them: reading and writing back must not move them by a bit.
        double[] seconds = [1793914535.142225, 1793914565.6829181, 1793914650.176656, 1793914554.5707591, 0.5, 978307200];
        var id = _db.InsertTitle(MakeTitle());
        foreach (var value in seconds)
        {
            _db.Sql.Run("UPDATE titles SET added_at=? WHERE id=?", value, id);
            var title = _db.AllTitles().Single(t => t.Id == id);
            _db.UpdateTitle(title);
            Assert.Equal(value, _db.Sql.Query("SELECT added_at FROM titles WHERE id=?", [id], r => r.Real(0)).Single());
        }

        // A date made here comes back within a microsecond (a double holds no finer at this size).
        var at = DateTimeOffset.FromUnixTimeMilliseconds(1_793_914_535_142).AddTicks(2_501);
        _db.UpdateTitle(MakeTitle() with { Id = id, AddedAt = at });
        var back = _db.AllTitles().Single(t => t.Id == id).AddedAt;
        Assert.True(Math.Abs((back - at).Ticks) <= 3, $"{back:O} vs {at:O}");
    }

    [Fact]
    public void PlaceholdersInsideQuotesStay()
    {
        Assert.Equal("SELECT '?' , $p1, \"a?\", $p2", SqliteDb.NumberPlaceholders("SELECT '?' , ?, \"a?\", ?", out var count));
        Assert.Equal(2, count);
    }

    [Fact]
    public void ErrorsNameTheStatement()
    {
        var error = Assert.Throws<SqlError>(() => _db.Sql.Run("INSERT INTO nowhere VALUES(?)", 1));
        Assert.Contains("in: INSERT INTO nowhere", error.Message);
    }

    [Fact]
    public void FailedTransactionsRollBack()
    {
        Assert.Throws<SqlError>(() => _db.Sql.Transaction(() =>
        {
            _db.InsertTitle(MakeTitle("Kept?"));
            _db.Sql.Run("INSERT INTO nowhere VALUES(1)");
        }));
        Assert.Empty(_db.AllTitles());
    }
}
