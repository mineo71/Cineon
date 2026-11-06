using System.Text;
using Cineon.Core.Data;
using Cineon.Core.Import;
using Cineon.Core.Tests.Data;
using Microsoft.Data.Sqlite;

namespace Cineon.Core.Tests.Import;

/// <summary>Port of CineonTests/BrowserImportTests.swift, with the same expectations.</summary>
public sealed class BrowserImportTests : IDisposable
{
    private readonly TempFolder _root = new();

    public void Dispose() => _root.Dispose();

    private static ITitleRecognizer Parser => ParserRecognizer.Shared;

    // MARK: Fake browsers

    /// <summary>Chromium's time format: microseconds since 1601.</summary>
    private static long ChromiumTime(DateTimeOffset date) =>
        (long)((StoredDate.ToUnix(date) + 11_644_473_600) * 1_000_000);

    private static void MakeHistory(string folder, params (string Url, string Title, int Visits, DateTimeOffset Date)[] rows)
    {
        Directory.CreateDirectory(folder);
        using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder
               {
                   DataSource = Path.Combine(folder, "History"), Pooling = false,
               }.ToString()))
        {
            connection.Open();
            using var create = connection.CreateCommand();
            create.CommandText =
                "CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER DEFAULT 0)";
            create.ExecuteNonQuery();
            foreach (var (url, title, visits, date) in rows)
            {
                using var insert = connection.CreateCommand();
                insert.CommandText = "INSERT INTO urls(url,title,visit_count,typed_count,last_visit_time) VALUES($u,$t,$v,0,$d)";
                insert.Parameters.AddWithValue("$u", url);
                insert.Parameters.AddWithValue("$t", title);
                insert.Parameters.AddWithValue("$v", visits);
                insert.Parameters.AddWithValue("$d", ChromiumTime(date));
                insert.ExecuteNonQuery();
            }
        }
    }

    private static BrowsedPage Page(string url, string title, int visits = 2, DateTimeOffset? at = null, PageOrigin origin = PageOrigin.History) =>
        new() { Url = new Uri(url), Title = title, Visits = visits, LastVisit = at ?? DateTimeOffset.UtcNow, Origin = origin };

    private static ImportScan Analyze(params BrowsedPage[] pages) => ImportAnalyzer.Analyze(pages, "Test", Parser);

    private static void Write(string path, string text)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, text, new UTF8Encoding(false));
    }

    // MARK: Reading files

    [Fact]
    public void ChromiumDateConversion()
    {
        // 2024-01-01T00:00:00Z.
        var date = BrowserImporter.ChromiumDate(13_348_540_800_000_000);
        Assert.Equal(1_704_067_200, StoredDate.ToUnix(date), 0);
    }

    [Fact]
    public void DiscoverFindsProfilesWithDataAndSkipsEmptyOnes()
    {
        var chrome = Path.Combine(_root.Path, "Google", "Chrome");
        MakeHistory(Path.Combine(chrome, "Default"), ("https://a.example/x", "A", 1, DateTimeOffset.UtcNow));
        MakeHistory(Path.Combine(chrome, "Profile 1"));
        MakeHistory(Path.Combine(chrome, "Guest Profile"), ("https://b.example/x", "B", 1, DateTimeOffset.UtcNow));
        Write(Path.Combine(chrome, "Local State"), """{"profile":{"info_cache":{"Default":{"name":"Personal"}}}}""");

        var sources = BrowserImporter.Discover(_root.Path);
        var source = Assert.Single(sources);
        Assert.Equal("Chrome", source.Browser);
        Assert.Equal("Chrome, Personal", source.Label);
        Assert.Equal(1, source.HistoryCount);
    }

    [Fact]
    public void DiscoverReadsWindowsProfileFolders()
    {
        // %LOCALAPPDATA%\Microsoft\Edge\User Data\Default and %APPDATA%\Opera Software\Opera Stable.
        var local = Path.Combine(_root.Path, "Local");
        var roaming = Path.Combine(_root.Path, "Roaming");
        MakeHistory(Path.Combine(local, "Microsoft", "Edge", "User Data", "Default"), ("https://a.example/x", "A", 1, DateTimeOffset.UtcNow));
        MakeHistory(Path.Combine(local, "Microsoft", "Edge", "User Data", "Profile 2"), ("https://b.example/x", "B", 1, DateTimeOffset.UtcNow));
        Write(Path.Combine(local, "Microsoft", "Edge", "User Data", "Local State"), """{"profile":{"info_cache":{"Profile 2":{"name":"Work"}}}}""");
        MakeHistory(Path.Combine(roaming, "Opera Software", "Opera Stable"), ("https://c.example/x", "C", 1, DateTimeOffset.UtcNow));
        var arc = Path.Combine(local, "Packages", "TheBrowserCompany.Arc_ttt1ap7aakyb4", "LocalCache", "Local", "Arc");
        MakeHistory(Path.Combine(arc, "User Data", "Default"), ("https://d.example/x", "D", 1, DateTimeOffset.UtcNow));
        Write(Path.Combine(arc, "StorableSidebar.json"), """{"items":[{"data":{"tab":{"savedURL":"https://kino.example/","savedTitle":"Kino"}}}]}""");

        var sources = BrowserImporter.Discover(new ImportRoots(local, roaming));
        // In the Mac's browser order, each browser's profiles by folder name.
        Assert.Equal(["Arc", "Edge", "Edge, Work", "Opera"], sources.Select(s => s.Label));
        Assert.Equal(1, sources[0].PinnedCount);
        Assert.Equal(arc, sources[0].ArcDirectory);
    }

    [Fact]
    public void HistoryIsReadWhileTheBrowserHoldsItOpen()
    {
        var profile = Path.Combine(_root.Path, "Default");
        MakeHistory(profile, ("https://a.example/x", "A", 3, DateTimeOffset.UtcNow));
        // A browser keeps the file open for writing while it runs.
        using var held = new FileStream(Path.Combine(profile, "History"), FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite);
        var pages = BrowserImporter.ReadHistory(profile);
        Assert.Equal(3, Assert.Single(pages).Visits);
    }

    [Fact]
    public void ReadsNestedBookmarks()
    {
        var profile = Path.Combine(_root.Path, "profile");
        Write(Path.Combine(profile, "Bookmarks"), """
            {"roots":{"bookmark_bar":{"type":"folder","children":[
              {"type":"url","name":"One","url":"https://a.example/1","date_added":"13348569600000000"},
              {"type":"folder","name":"Films","children":[{"type":"url","name":"Two","url":"https://b.example/2"}]}
            ]},"other":{"type":"folder","children":[]}}}
            """);
        var pages = BrowserImporter.ReadBookmarks(profile);
        Assert.Equal(["One", "Two"], pages.Select(p => p.Title).ToHashSet());
        Assert.All(pages, p => Assert.Equal(PageOrigin.Bookmark, p.Origin));
    }

    [Fact]
    public void ReadsArcTabsWhereverTheyAre()
    {
        var arc = Path.Combine(_root.Path, "Arc");
        Write(Path.Combine(arc, "StorableSidebar.json"), """
            {"sidebar":{"containers":[{"items":["some-id",{"data":{"tab":{"savedURL":"https://kino.example/dune","savedTitle":"Dune"}}}]}]},
             "sidebarSyncState":{"items":[{"value":{"data":{"tab":{"savedURL":"https://kino.example/dune","savedTitle":"Dune"}}}}]}}
            """);
        Write(Path.Combine(arc, "StorableArchiveItems.json"),
            """{"items":[{"sidebarItem":{"data":{"tab":{"savedURL":"https://kino.example/old","savedTitle":"Old"}}}}]}""");
        var pages = BrowserImporter.ReadArcTabs(arc);
        // Duplicates in sync data are counted once.
        Assert.Equal(["Dune", "Old"], pages.Select(p => p.Title).Order().ToList());
    }

    [Fact]
    public void ScanReadsAWholeFakeArc()
    {
        MakeHistory(Path.Combine(_root.Path, "Arc", "User Data", "Default"),
            ("https://uakino.example/filmy/dune-2021.html", "Дюна (2021) дивитися онлайн українською", 5, DateTimeOffset.UtcNow),
            ("https://uakino.example/filmy/oppenheimer.html", "Оппенгеймер дивитися онлайн", 2, DateTimeOffset.UtcNow),
            ("https://news.example/article", "Some article", 1, DateTimeOffset.UtcNow));
        var sources = BrowserImporter.Discover(_root.Path);
        Assert.Equal("Arc", sources.FirstOrDefault()?.Browser);
        var scan = BrowserImporter.Scan(sources[0], Parser);
        Assert.Equal(["Дюна", "Оппенгеймер"], scan.Titles.Select(t => t.Name).ToHashSet());
        Assert.Equal(["uakino.example"], scan.Sites.Select(s => s.Host));
        Assert.Equal(3, scan.TotalPages);
    }

    [Fact]
    public void ImportRootOverrideStandsInForBothFolders()
    {
        var previous = Environment.GetEnvironmentVariable(ImportRoots.OverrideVariable);
        try
        {
            Environment.SetEnvironmentVariable(ImportRoots.OverrideVariable, _root.Path);
            Assert.Equal(new ImportRoots(_root.Path, _root.Path), ImportRoots.Default);
        }
        finally
        {
            Environment.SetEnvironmentVariable(ImportRoots.OverrideVariable, previous);
        }
    }

    // MARK: Spotting films

    [Fact]
    public void PageTitlesAreEnoughOnTheirOwn()
    {
        var scan = Analyze(Page("https://kinoplace.example/abc-123", "Watch Dune: Part Two (2024) Full Movie Online Free | Site"));
        Assert.Equal("Dune: Part Two", scan.Titles.FirstOrDefault()?.Name);
        Assert.Equal(2024, scan.Titles.FirstOrDefault()?.Year);
    }

    [Fact]
    public void OneFilmLikePageOnAnUnrelatedSiteIsIgnored()
    {
        var scan = Analyze(Page("https://anything.example/abc-123", "Watch Dune Full Movie Online Free | Site"));
        Assert.Empty(scan.Titles);
    }

    [Fact]
    public void AnUnfamiliarSiteCanProveItself()
    {
        var pages = new[] { "Alpha", "Beta", "Gamma" }.Select(n => Page($"https://anything.example/w/{n}", $"Watch {n} Full Movie Online Free")).ToArray();
        Assert.Equal(3, Analyze(pages).Titles.Count);
    }

    [Fact]
    public void AdultAndMusicSitesAreNeverImported()
    {
        var pages = new[] { "pornsite.example", "muzplace.example", "mp3place.example" }
            .SelectMany(host => new[] { "Alpha", "Beta", "Gamma" }.Select(n => Page($"https://{host}/watch/{n}", $"Watch {n} Full Movie Online Free")))
            .ToArray();
        var scan = Analyze(pages);
        Assert.Empty(scan.Titles);
        Assert.Empty(scan.Sites);
    }

    [Fact]
    public void TrailersAndSitePagesAreIgnored()
    {
        var scan = Analyze(
            Page("https://kino.example/film/a", "Alpha (трейлер) дивитися онлайн"),
            Page("https://kino.example/film/b", "Лучшие фильмы года смотреть онлайн"),
            Page("https://kino.example/best/fiction/2024", "Смотреть лучшие"),
            Page("https://kino.example/film/c", "Регистрация посетителя смотреть"));
        Assert.True(scan.Titles.Count == 0, string.Join(", ", scan.Titles.Select(t => t.Name)));
    }

    [Fact]
    public void DubsOfOneFilmBecomeOneTitle()
    {
        var scan = Analyze(
            Page("https://rezka.example/films/1-mayday.html#t:1", "Смотреть Мэйдэй в озвучке Дубляж онлайн"),
            Page("https://rezka.example/films/1-mayday.html#t:2", "Смотреть Мэйдэй в озвучке Оригинал (+субтитры) онлайн"));
        Assert.Equal(["Мэйдэй"], scan.Titles.Select(t => t.Name));
        Assert.Single(scan.Titles[0].Visits);
    }

    [Fact]
    public void NotYetReleasedGoesToTheBacklog()
    {
        var scan = Analyze(Page("https://rezka.example/films/2-odyssey.html", "Одиссея скоро смотреть онлайн"));
        Assert.Equal("Одиссея", scan.Titles.FirstOrDefault()?.Name);
        Assert.Equal(TitleStatus.Backlog, scan.Titles.FirstOrDefault()?.SuggestedStatus);
    }

    [Fact]
    public void MirrorsOfASiteBecomeOneAtItsNewestAddress()
    {
        var older = DateTimeOffset.UtcNow.AddDays(-100);
        var scan = Analyze(
            Page("https://hdrezka.example/films/a.html", "Alpha смотреть онлайн", at: older),
            Page("https://rezka-ua.example/films/b.html", "Beta смотреть онлайн", at: older),
            Page("https://rezka-tv.example/films/c.html", "Gamma смотреть онлайн"));
        Assert.Equal(["rezka-tv.example"], scan.Sites.Select(s => s.Host));
        Assert.Equal(3, scan.Sites.FirstOrDefault()?.FilmPages);
    }

    [Fact]
    public void BrandIgnoresMirrorDecoration()
    {
        Assert.Equal("rezka", ImportAnalyzer.Brand("hdrezka.ag"));
        Assert.Equal("rezka", ImportAnalyzer.Brand("rezka-ua.co"));
        Assert.Equal("kinogo", ImportAnalyzer.Brand("kinogo1.biz"));
        Assert.NotEqual(ImportAnalyzer.Brand("kinogo.is"), ImportAnalyzer.Brand("uakino.best"));
    }

    [Fact]
    public void EverydayPagesAreNotFilms()
    {
        var scan = Analyze(
            Page("https://news.example/2024/politics/story", "Elections: what happens next"),
            Page("https://shop.example/product/shoes", "Running shoes | Shop"),
            Page("https://docs.example/guide/start", "Getting started"));
        Assert.Empty(scan.Titles);
        Assert.Empty(scan.Sites);
    }

    [Fact]
    public void ExcludedSitesAreIgnored()
    {
        var scan = Analyze(
            Page("https://www.imdb.com/title/tt1160419/", "Watch Dune online free"),
            Page("https://www.youtube.com/watch?v=abc", "Watch Dune Full Movie Online Free"),
            Page("https://www.google.com/search?q=dune", "Watch Dune online"));
        Assert.Empty(scan.Titles);
    }

    [Fact]
    public void SearchAndListingPagesAreIgnored()
    {
        var scan = Analyze(
            Page("https://kino.example/search?q=dune", "Смотреть Dune онлайн"),
            Page("https://kino.example/genre/comedy/", "Смотреть комедии онлайн"),
            Page("https://kino.example/", "Смотреть фильмы онлайн"));
        Assert.Empty(scan.Titles);
    }

    [Fact]
    public void WeakPagesCountOnceTheSiteHasProvedItself()
    {
        var strong = new[] { "Alpha", "Beta", "Gamma" }.Select(n => Page($"https://plain.example/watch/{n}", $"{n} дивитися онлайн")).ToList();
        var weak = Page("https://plain.example/watch/plain-title", "Plain Title");
        Assert.True(Analyze(weak).Titles.Count == 0, "A /watch/ path alone proves nothing");
        Assert.Contains(Analyze([.. strong, weak]).Titles, t => t.Name == "Plain Title");
    }

    [Fact]
    public void EpisodesOfOneSeriesBecomeOneTitle()
    {
        var old = DateTimeOffset.UtcNow.AddHours(-1);
        var scan = Analyze(
            Page("https://serials.example/serial/severance/2-sezon/3-seriya", "Розрив 2 сезон 3 серія дивитися онлайн", at: old),
            Page("https://serials.example/serial/severance/2-sezon/4-seriya", "Розрив 2 сезон 4 серія дивитися онлайн"));
        var title = Assert.Single(scan.Titles);
        Assert.Equal(TitleKind.Series, title.Kind);
        Assert.Equal(2, title.Visits.Count);
        // The newest visit shows where you ended up.
        Assert.Equal(new EpisodeRef(2, 4), title.LatestRef);
        Assert.Equal(TitleStatus.Watching, title.SuggestedStatus);
    }

    [Fact]
    public void SeriesPageIsDroppedOnceEpisodesAreKnown()
    {
        var scan = Analyze(
            Page("https://serials.example/serial/severance", "Розрив дивитися онлайн"),
            Page("https://serials.example/serial/severance#t:1-s:2-e:4", "Розрив дивитися онлайн"));
        var title = Assert.Single(scan.Titles);
        Assert.Equal([new EpisodeRef(2, 4)], title.Visits.Select(v => v.Ref));
    }

    [Fact]
    public void SuggestedListsFollowWhatHappened()
    {
        var longAgo = DateTimeOffset.UtcNow.AddDays(-400);
        var scan = Analyze(
            Page("https://kino.example/film/a", "Arrival дивитися онлайн", at: longAgo),
            Page("https://kino.example/serial/b/1-sezon/1-seriya", "Old Series 1 сезон 1 серія дивитися онлайн", at: longAgo),
            Page("https://kino.example/film/c", "Past Lives дивитися онлайн", visits: 0, at: longAgo, origin: PageOrigin.Bookmark));
        TitleStatus? Status(string name) => scan.Titles.FirstOrDefault(t => t.Name == name)?.SuggestedStatus;
        Assert.Equal(TitleStatus.Watched, Status("Arrival"));
        // A series left a year ago isn't being watched now.
        Assert.Equal(TitleStatus.Watched, Status("Old Series"));
        // Saved but never opened means for later.
        Assert.Equal(TitleStatus.Backlog, Status("Past Lives"));
    }

    [Fact]
    public void SiteNeedsMoreThanOneFilmPage()
    {
        Assert.Empty(Analyze(Page("https://kinoa.example/film/x", "Alpha дивитися онлайн")).Sites);
        var two = Analyze(
            Page("https://www.kinob.example/film/x", "Alpha дивитися онлайн"),
            Page("https://www.kinob.example/film/y", "Beta дивитися онлайн"));
        Assert.Equal("kinob.example", two.Sites.FirstOrDefault()?.Host);
        Assert.Equal(2, two.Sites.FirstOrDefault()?.FilmPages);
        Assert.Equal("https://www.kinob.example/", two.Sites.FirstOrDefault()?.HomeUrl.OriginalString);
    }

    [Fact]
    public void PinnedFilmSiteIsSuggestedEvenWithoutFilmPages()
    {
        var scan = Analyze(Page("https://kinoplace.example/", "Kinoplace", visits: 0, origin: PageOrigin.Pinned));
        Assert.Equal(["kinoplace.example"], scan.Sites.Select(s => s.Host));
    }

    [Fact]
    public void PagesAreCappedNewestFirst()
    {
        var pages = Enumerable.Range(0, BrowserImporter.PageLimit + 5)
            .Select(index => Page($"https://x.example/p{index}", "P", at: StoredDate.FromUnix(index + 1_000_000)))
            .ToArray();
        var scan = Analyze(pages);
        Assert.Equal(BrowserImporter.PageLimit, scan.Pages.Count);
        Assert.Equal(BrowserImporter.PageLimit + 5, scan.TotalPages);
        Assert.Equal($"https://x.example/p{BrowserImporter.PageLimit + 4}", scan.Pages[0].Url.OriginalString);
    }

    // MARK: Saving

    private sealed class Library : IDisposable
    {
        private readonly TempFolder _folder = new();
        public Database Db { get; }
        public LibraryStore Store { get; }

        public Library()
        {
            Db = new Database(_folder.File("import.sqlite"));
            Store = new LibraryStore(Db);
        }

        public void Dispose()
        {
            Db.Dispose();
            _folder.Dispose();
        }
    }

    private static ImportSelection Selection(ImportScan scan) => new()
    {
        Sites = scan.Sites, Titles = [.. scan.Titles.Select(t => (t, t.SuggestedStatus))], Pages = scan.Pages,
    };

    [Fact]
    public void ImportFillsLibraryTimelineAndHistory()
    {
        using var library = new Library();
        var visited = DateTimeOffset.UtcNow.AddDays(-30);
        var scan = Analyze(
            Page("https://kino.example/film/dune", "Dune (2021) дивитися онлайн", at: visited),
            Page("https://kino.example/film/oppenheimer", "Oppenheimer дивитися онлайн", at: visited));
        var result = library.Store.ApplyImport(Selection(scan));

        Assert.Equal(2, result.Titles);
        Assert.Equal(1, result.Sites);
        Assert.Equal(2, result.Pages);
        var dune = library.Store.Titles.Values.First(t => t.Name == "Dune");
        Assert.Equal(TitleStatus.Watched, dune.Status);
        // Keeps the real date.
        Assert.Equal(StoredDate.ToUnix(visited), StoredDate.ToUnix(dune.FinishedAt ?? default), 1);
        Assert.Equal(2, library.Store.Sessions.Count);
        Assert.True(library.Store.Sessions[0].IsVisitOnly);
        Assert.Equal("kino.example", library.Store.LatestProgress(dune.Id)?.Host);
        // An import doesn't flood today's timeline.
        Assert.Empty(library.Store.Events);
        Assert.Equal(2, library.Db.RecentHistory().Count);
        Assert.Equal("Imported 1 site, 2 films and series, 2 pages.", result.Summary);
    }

    [Fact]
    public void ImportingTwiceAddsNothing()
    {
        using var library = new Library();
        var scan = Analyze(
            Page("https://kino.example/film/dune", "Dune дивитися онлайн"),
            Page("https://kino.example/film/up", "Up дивитися онлайн"));
        library.Store.ApplyImport(Selection(scan));
        var second = library.Store.ApplyImport(Selection(scan));
        Assert.Equal(0, second.Titles);
        Assert.Equal(0, second.Sites);
        Assert.Equal(0, second.Pages);
        Assert.Equal("Nothing new to import.", second.Summary);
        Assert.Equal(2, library.Store.Titles.Count);
        Assert.Equal(2, library.Store.Sessions.Count);
    }

    [Fact]
    public void RenamedTitleIsRecognisedByItsAddress()
    {
        using var library = new Library();
        var scan = Analyze(Page("https://kino.example/film/dune", "Дюна дивитися онлайн"));
        library.Store.ApplyImport(Selection(scan));
        // A catalogue lookup replaces the Ukrainian name with the English one.
        var title = library.Store.Titles.Values.First();
        library.Store.Update(title with { Name = "Dune", NormName = LibraryText.Normalize("Dune") });

        var second = library.Store.ApplyImport(Selection(scan));
        Assert.Equal(0, second.Titles);
        Assert.Single(library.Store.Titles);
        Assert.Single(library.Store.Sessions);
    }

    [Fact]
    public void ImportNeverOverwritesARealPosition()
    {
        using var library = new Library();
        var existing = library.Store.AddTitle("Dune", status: TitleStatus.Watching)!;
        library.Store.SaveProgress(new WatchProgress
        {
            TitleId = existing.Id, Ref = EpisodeRef.None, UrlKey = "real/key", Url = new Uri("https://real.example/d"), Host = "real.example",
            Position = 1234, Duration = 7000, Finished = false, UpdatedAt = DateTimeOffset.UtcNow,
        });
        var scan = Analyze(Page("https://kino.example/film/dune", "Dune дивитися онлайн"));
        library.Store.ApplyImport(Selection(scan));

        // Matches the title already there, and keeps its list.
        Assert.Single(library.Store.Titles);
        Assert.Equal(TitleStatus.Watching, library.Store.Titles[existing.Id].Status);
        Assert.Equal(1234, library.Store.LatestProgress(existing.Id)?.Position);
        Assert.Equal("real.example", library.Store.LatestProgress(existing.Id)?.Host);
    }

    [Fact]
    public void BacklogItemsStayOffTheTimeline()
    {
        using var library = new Library();
        var scan = Analyze(Page("https://kino.example/film/dune", "Dune дивитися онлайн", visits: 0, origin: PageOrigin.Bookmark));
        library.Store.ApplyImport(Selection(scan));
        Assert.Single(library.Store.Backlog);
        Assert.Empty(library.Store.Sessions);
    }
}
