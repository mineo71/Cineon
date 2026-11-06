using Cineon.Core.Data;

namespace Cineon.Core.Tests.Data;

public sealed class LibraryStoreTests : IDisposable
{
    private readonly TempFolder _folder = new();
    private readonly Database _db;
    private readonly LibraryStore _library;

    public LibraryStoreTests()
    {
        _db = new Database(_folder.File("cineon.sqlite"));
        _library = new LibraryStore(_db);
    }

    public void Dispose()
    {
        _db.Dispose();
        _folder.Dispose();
    }

    [Fact]
    public void AddingToTheBacklogIsAnEvent()
    {
        var changes = 0;
        _library.Changed += (_, _) => changes++;
        var dune = _library.AddTitle("Dune: Part Two", 2024, TitleKind.Film, TitleStatus.Backlog, imdbId: "tt15239678");
        Assert.NotNull(dune);
        Assert.Equal("duneparttwo", dune.NormName);
        Assert.Equal(LibraryEventKind.AddedToBacklog, Assert.Single(_library.Events).Kind);
        Assert.Equal([dune], _library.Backlog);
        Assert.True(changes > 0);

        // The same IMDb ID finds the title already there.
        Assert.Equal(dune.Id, _library.AddTitle("Dune 2", imdbId: "tt15239678")?.Id);
        Assert.Single(_library.Titles);
    }

    [Fact]
    public void StatusAndRatingAreRecordedAndReported()
    {
        var reported = new List<Title>();
        _library.OnPersonalChange = reported.Add;
        var id = _library.AddTitle("Heat", 1995)!.Id;

        _library.SetStatus(id, TitleStatus.Watched);
        var watched = _library.Titles[id];
        Assert.Equal(TitleStatus.Watched, watched.Status);
        Assert.NotNull(watched.FinishedAt);
        Assert.NotNull(watched.StatusAt);
        Assert.Equal(LibraryEventKind.MarkedWatched, _library.Events[0].Kind);

        _library.SetRating(id, 99);
        Assert.Equal(20, _library.Titles[id].RatingHalves);
        _library.SetRating(id, 20);
        Assert.Equal(2, reported.Count);
        _library.SetRating(id, null);
        Assert.Null(_library.Titles[id].RatingHalves);

        var stored = _db.AllTitles().Single();
        Assert.Equal((TitleStatus.Watched, (int?)null, 3), (stored.Status, stored.RatingHalves, reported.Count));
        Assert.Equal(1, _library.Count(TitleStatus.Watched));
    }

    [Fact]
    public void RestoringFromTheCloudIsQuiet()
    {
        var reported = 0;
        _library.OnPersonalChange = _ => reported++;
        var id = _library.AddTitle("Heat", 1995)!.Id;
        var at = DateTimeOffset.UtcNow.AddDays(-3);
        _library.Restore(id, restoreRating: true, halves: 17, ratedAt: at, status: TitleStatus.Watched, statusAt: at, finishedAt: null);
        var title = _library.Titles[id];
        Assert.Equal((17, TitleStatus.Watched), (title.RatingHalves, title.Status));
        Assert.Equal(at, title.FinishedAt);
        Assert.Equal(0, reported);

        _library.Restore(id, restoreRating: false, halves: null, ratedAt: null, status: null, statusAt: null, finishedAt: null);
        Assert.Equal(17, _library.Titles[id].RatingHalves);
        _library.Restore(id, restoreRating: true, halves: null, ratedAt: null, status: null, statusAt: null, finishedAt: null);
        Assert.Null(_library.Titles[id].RatingHalves);
    }

    [Fact]
    public void FindsByNameAndYear()
    {
        var a = _library.AddTitle("The Thing", 1982)!;
        var b = _library.AddTitle("The Thing", 2011)!;
        Assert.Equal(b.Id, _library.Find("the thing", year: 2011)?.Id);
        Assert.Equal(a.Id, _library.Find("The  Thing!", year: 1983)?.Id);
        Assert.Null(_library.Find("The Thing", year: 1995));
        Assert.Equal(a.Id, _library.Find("Нечто", altName: "The Thing", year: 1982)?.Id);
        Assert.NotNull(_library.Find("The Thing"));
        Assert.Equal([a.Id, b.Id], _library.Search("thing").Select(t => t.Id).Order());
        Assert.Empty(_library.Search("!!"));
    }

    [Fact]
    public void ProgressAndSessions()
    {
        var id = _library.AddTitle("Lost", 2004, TitleKind.Series)!.Id;
        _library.RecordWatchStart(id);
        Assert.Equal(TitleStatus.Watching, _library.Titles[id].Status);

        var now = DateTimeOffset.UtcNow;
        WatchProgress Progress(int episode, double position) => new()
        {
            TitleId = id, Ref = new EpisodeRef(1, episode), UrlKey = $"site/{episode}", Host = "site", Position = position,
            Duration = 2600, UpdatedAt = now.AddSeconds(episode),
        };
        _library.SaveProgress(Progress(1, 100));
        _library.SaveProgress(Progress(2, 200));
        _library.SaveProgress(Progress(1, 300));
        Assert.Equal([1, 2], _library.Progress.Select(p => p.Ref.Episode));
        Assert.Equal(300, _library.LatestProgress(id)?.Position);
        Assert.Equal(2, _library.ProgressList(id).Count);
        var continuing = Assert.Single(_library.ContinueWatching);
        Assert.Equal((id, 1), (continuing.Title.Id, continuing.Progress.Ref.Episode));

        _library.ClearProgress(id, new EpisodeRef(1, 1));
        Assert.Equal(0, _db.Progress(id, new EpisodeRef(1, 1))?.Position);

        var session = _library.SaveSession(new WatchSession
        {
            TitleId = id, Ref = new EpisodeRef(1, 1), Host = "site", StartedAt = now, EndedAt = now, Duration = 2600,
        });
        Assert.NotEqual(0, session.Id);
        _library.SaveSession(session with { WatchedSeconds = 600 });
        Assert.Equal(600, Assert.Single(_library.Sessions).WatchedSeconds);
        Assert.Single(_library.SessionsForTitle(id));
        var revision = _library.Revision;
        _library.DeleteSession(session.Id);
        Assert.Empty(_library.Sessions);
        Assert.True(_library.Revision > revision);
    }

    [Fact]
    public void MergedTitlesAreFollowed()
    {
        var a = _library.AddTitle("Dune Part Two")!.Id;
        var b = _library.AddTitle("Dune: Part Two", 2024)!.Id;
        _library.SaveSession(new WatchSession { TitleId = a, Host = "site", StartedAt = DateTimeOffset.UtcNow, EndedAt = DateTimeOffset.UtcNow });
        _library.Merge(a, b);
        Assert.Equal(b, _library.CurrentId(a));
        Assert.Equal(b, Assert.Single(_library.Sessions).TitleId);
        _library.Delete(b);
        Assert.Null(_library.CurrentId(a));
        Assert.Empty(_library.Titles);
    }

    [Fact]
    public async Task FramesAreIndexedAndPruned()
    {
        var id = _library.AddTitle("Alien", 1979)!.Id;
        var session = _library.SaveSession(new WatchSession { TitleId = id, Host = "site", StartedAt = DateTimeOffset.UtcNow, EndedAt = DateTimeOffset.UtcNow });
        var now = DateTimeOffset.UtcNow;
        for (var i = 0; i < 4; i++)
        {
            var file = $"{id}/{i}.jpg";
            Directory.CreateDirectory(Path.Combine(_db.FramesDirectory, id.ToString()));
            File.WriteAllBytes(Path.Combine(_db.FramesDirectory, file), new byte[1000]);
            _library.AddFrame(new FilmFrame
            {
                SessionId = session.Id, TitleId = id, Position = 40 - i * 10, File = file, IsMoment = i == 3, Interest = i == 1 ? 9 : 1,
                At = now.AddSeconds(i),
            });
        }
        Assert.Equal([10.0, 20, 30, 40], _library.Frames(session.Id).Select(f => f.Position));
        Assert.Single(_library.Moments(id));
        Assert.Equal(Path.Combine(_db.FramesDirectory, $"{id}/1.jpg"), _library.BestFramePath(id));
        Assert.Equal(4000, await _library.FramesSizeAsync());

        // Over 2 kB: the oldest collected frames go until under 80% of it. The moment stays.
        await _library.PruneFramesAsync(limit: 2000);
        Assert.Equal(2000, await _library.FramesSizeAsync());
        Assert.Equal(["2.jpg", "3.jpg"], _library.Frames(session.Id).Select(f => Path.GetFileName(f.File)).Order());

        _library.DeleteSession(session.Id);
        Assert.Single(_library.Moments(id));
        Assert.Empty(_library.Frames(session.Id));
        _library.DeleteAllFrames();
        Assert.False(Directory.Exists(_db.FramesDirectory));
        Assert.Empty(_library.Moments(id));
    }

    [Fact]
    public void SitesAreSeededAddedAndMoved()
    {
        _library.SeedDefaultSitesIfNeeded();
        Assert.Equal(["YouTube", "Tubi", "Internet Archive", "Pluto TV"], _library.Sites.Select(s => s.Name));
        var youtube = _library.Sites[0];
        Assert.Equal(("youtube.com", "https://www.youtube.com/favicon.ico", "https://www.youtube.com/results?search_query=%s"),
            (youtube.Host, youtube.IconUrl?.OriginalString, youtube.SearchTemplate));
        _library.SeedDefaultSitesIfNeeded();
        Assert.Equal(4, _library.Sites.Count);

        Assert.Same(youtube, _library.AddSite(new Uri("https://m.youtube.com/watch?v=1")));
        var demo = _library.AddSite(new Uri("http://www.kino-demo.example:8765/films"));
        Assert.NotNull(demo);
        Assert.Equal(("kino-demo.example", "Kino-demo", 4, "http://www.kino-demo.example/favicon.ico"),
            (demo.Host, demo.Name, demo.Position, demo.IconUrl?.OriginalString));
        Assert.Null(_library.AddSite(new Uri("about:blank")));
        Assert.Equal(demo.Id, _library.SiteForHost("player.kino-demo.example")?.Id);

        _library.MoveSite([4], 0);
        Assert.Equal(["Kino-demo", "YouTube", "Tubi", "Internet Archive", "Pluto TV"], _library.Sites.Select(s => s.Name));
        _library.MoveSite([0, 1], 5);
        Assert.Equal(["Tubi", "Internet Archive", "Pluto TV", "Kino-demo", "YouTube"], _library.Sites.Select(s => s.Name));
        Assert.Equal(_library.Sites.Select(s => s.Name), _db.AllSites().Select(s => s.Name));
        Assert.Equal([0, 1, 2, 3, 4], _db.AllSites().Select(s => s.Position));

        _library.RemoveSite(demo.Id);
        Assert.Equal(4, _db.AllSites().Count);
    }
}
