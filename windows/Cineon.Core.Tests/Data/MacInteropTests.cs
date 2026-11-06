using System.Diagnostics;
using System.Text.RegularExpressions;
using Cineon.Core.Data;

namespace Cineon.Core.Tests.Data;

/// <summary>
/// A profile database written by the Mac app in an end-to-end run against the local fixture site
/// (Fixtures/mac-profile.sqlite, test data only) has to open here unchanged, and a database made
/// here has to have the Mac's schema.
/// </summary>
public sealed class MacInteropTests : IDisposable
{
    private const string Fixture = "mac-profile.sqlite";

    private readonly TempFolder _folder = new();

    public void Dispose() => _folder.Dispose();

    private Database OpenMacCopy() => new(Fixtures.CopyTo(_folder, Fixture, "cineon.sqlite"));

    [Fact]
    public void OpensAMacDatabaseWithoutMigrating()
    {
        using var db = OpenMacCopy();
        Assert.Equal(4, db.Sql.UserVersion);
        Assert.Equal("wal", db.Sql.Query("PRAGMA journal_mode", r => r.Text(0)).Single());
        Assert.Equal(1, db.Sql.Query("PRAGMA foreign_keys", r => r.IntValue(0)).Single());
    }

    [Fact]
    public void ReadsTitles()
    {
        using var db = OpenMacCopy();
        var titles = db.AllTitles().ToDictionary(t => t.Id);
        Assert.Equal(4, titles.Count);

        var dune = titles[1];
        Assert.Equal("Dune: Part Two", dune.Name);
        Assert.Equal("duneparttwo", dune.NormName);
        Assert.Equal(LibraryText.Normalize(dune.Name), dune.NormName);
        Assert.Equal(2024, dune.Year);
        Assert.Equal(TitleKind.Film, dune.Kind);
        Assert.Equal(TitleStatus.Watched, dune.Status);
        Assert.Equal("tt15239678", dune.ImdbId);
        Assert.Equal(["Action", "Adventure", "Drama"], dune.Genres);
        Assert.Equal(167, dune.RuntimeMinutes);
        Assert.Null(dune.RatingHalves);
        Assert.True(dune.MetadataChecked);
        Assert.StartsWith("https://m.media-amazon.com/images/M/", dune.PosterUrl?.OriginalString);
        Assert.Equal(1793914535.142225, StoredDate.ToUnix(dune.AddedAt));
        Assert.Equal(1793914565.6829181, StoredDate.ToUnix(dune.StatusAt!.Value));
        Assert.Equal(1793914650.176656, StoredDate.ToUnix(dune.LastWatchedAt!.Value));
        var addedSecond = new DateTimeOffset(dune.AddedAt.UtcTicks - dune.AddedAt.UtcTicks % TimeSpan.TicksPerSecond, TimeSpan.Zero);
        Assert.Equal(new DateTimeOffset(2026, 11, 5, 21, 35, 35, TimeSpan.Zero), addedSecond);

        Assert.Equal((TitleKind.Unknown, TitleStatus.Watching, (string?)null), (titles[2].Kind, titles[2].Status, titles[2].ImdbId));
        Assert.Equal(TitleKind.Series, titles[3].Kind);
        Assert.Equal("The Mentalist", titles[4].Name);
        Assert.All(titles.Values, t => Assert.Equal(LibraryText.Normalize(t.Name), t.NormName));
    }

    [Fact]
    public void ReadsSessionsAndProgress()
    {
        using var db = OpenMacCopy();
        var sessions = db.Sessions();
        Assert.Equal(5, sessions.Count);
        Assert.Equal([5, 4, 3, 2, 1], sessions.Select(s => s.Id));
        var latest = sessions[0];
        Assert.Equal((4L, new EpisodeRef(3, 6)), (latest.TitleId, latest.Ref));
        Assert.Equal("http://127.0.0.1:8765/series/drama/1-mentalist-2008.html#t:238-s:3-e:6", latest.Url?.OriginalString);
        Assert.Equal(6.0305180549621582, latest.WatchedSeconds);
        Assert.Equal(900.0, latest.Duration);
        Assert.True(db.SessionsForTitle(1).Single().Finished);
        Assert.Equal(2, db.SessionsForTitle(4).Count);

        var progress = db.AllProgress();
        Assert.Equal(5, progress.Count);
        var mentalist = db.Progress("127.0.0.1:8765/series/drama/1-mentalist-2008.html#s:3-e:6");
        Assert.NotNull(mentalist);
        Assert.Equal((4L, new EpisodeRef(3, 6), 66.058495208018002), (mentalist.TitleId, mentalist.Ref, mentalist.Position));
        Assert.True(db.Progress(1, EpisodeRef.None)!.Finished);

        // Keys made here find the progress the Mac saved for each address.
        foreach (var p in progress)
        {
            Assert.NotNull(db.Progress(UrlKey.Make(p.Url!)));
        }
        Assert.Equal("127.0.0.1:8765/watch/dune-part-two-2024", UrlKey.Make(new Uri("http://127.0.0.1:8765/watch/dune-part-two-2024")));
    }

    [Fact]
    public void ReadsHistory()
    {
        using var db = OpenMacCopy();
        var history = db.RecentHistory();
        Assert.Equal(24, history.Count);
        Assert.Equal("http://127.0.0.1:8765/same-site", history[0].Url.OriginalString);
        Assert.Contains(history, h => h.Title == "Розрив 2 сезон 4 серія дивитися онлайн українською | UASerial");
        Assert.Contains(history, h => h.Url.OriginalString == "https://www.youtube.com/results?search_query=dune+part");
        var found = db.SearchHistory("mentalist");
        Assert.Equal(2, found.Count);
        Assert.Contains("127.0.0.1", db.KnownHosts());
    }

    [Fact]
    public void ReadsSitesAndTheirSearchAddresses()
    {
        using var db = OpenMacCopy();
        var sites = db.AllSites();
        Assert.Equal(["YouTube", "Tubi", "Internet Archive", "Pluto TV", "FlixDemo", "LocalDemo"], sites.Select(s => s.Name));
        Assert.Equal("youtube.com", sites[0].Host);
        Assert.Equal("https://www.youtube.com", sites[0].HomeUrl.OriginalString);

        // The Mac searched every site for "dune part"; the same addresses are made here.
        var visited = db.RecentHistory().Select(h => h.Url.OriginalString).ToHashSet();
        foreach (var site in sites.Take(5))
        {
            Assert.Contains(site.SearchUrl("dune part")!.OriginalString, visited);
        }
    }

    [Fact]
    public void ReadsEverythingElse()
    {
        using var db = OpenMacCopy();

        var ev = Assert.Single(db.Events());
        Assert.Equal((LibraryEventKind.MarkedWatched, 1L), (ev.Kind, ev.TitleId));

        var tabs = db.LoadTabs();
        Assert.Equal(22, tabs.Count);
        var active = Assert.Single(tabs, t => t.IsActive);
        Assert.Equal(Guid.Parse("B306B9E1-5A9F-45D2-9A51-E73A459E3499"), active.Id);
        Assert.Equal(693, active.State?.Length);
        Assert.Equal(Enumerable.Range(0, 22), tabs.Select(t => t.Position));

        var alert = Assert.Single(db.EpisodeAlerts());
        Assert.Equal((3L, new EpisodeRef(12, 24), (EpisodeRef?)null, 0), (alert.TitleId, alert.Latest, alert.Newest, alert.NewCount));

        var settings = db.LoadSettings();
        Assert.Equal(5, settings.MinimumSecondsToTrack);
        Assert.Equal(new AppSettings() with { MinimumSecondsToTrack = 5 }, settings);

        var prefs = db.SitePrefs()["127.0.0.1"];
        Assert.Equal(new SitePrefs("127.0.0.1"), prefs);
        Assert.Equal(new ShieldStats { Ads = 22, Popups = 1, Redirects = 1, Overlays = 1 }, db.TotalStats());

        Assert.Empty(db.AllDownloads());
        Assert.Empty(db.AllFrames());
        Assert.Empty(db.SkipRules(1));
    }

    [Fact]
    public void WritesAMacDatabaseTheMacsWay()
    {
        var path = Fixtures.CopyTo(_folder, Fixture, "cineon.sqlite");
        using (var db = new Database(path))
        {
            var library = new LibraryStore(db);
            library.SetRating(1, 15);
            library.SetStatus(2, TitleStatus.Watched);
            var heat = library.AddTitle("Heat", 1995, TitleKind.Film, TitleStatus.Backlog);
            Assert.NotNull(heat);
            db.SaveSettings(db.LoadSettings() with { Theme = AppTheme.White });
        }

        using var reopened = new Database(path);
        var titles = reopened.AllTitles().ToDictionary(t => t.Id);
        Assert.Equal(15, titles[1].RatingHalves);
        Assert.Equal(TitleStatus.Watched, titles[2].Status);
        Assert.Contains(titles.Values, t => t.Name == "Heat" && t.NormName == "heat");
        Assert.Equal(AppTheme.White, reopened.LoadSettings().Theme);
        Assert.Equal(5, reopened.LoadSettings().MinimumSecondsToTrack);

        // Every column keeps the storage class the Mac gives it.
        var types = reopened.Sql.Query(
            "SELECT DISTINCT typeof(added_at)||typeof(updated_at)||typeof(metadata_checked)||typeof(genres)||typeof(kind) FROM titles",
            r => r.Text(0));
        Assert.Equal(["realrealintegertexttext"], types);
    }

    [Fact]
    public void ANewDatabaseHasTheMacsSchema()
    {
        var macPath = Fixtures.CopyTo(_folder, Fixture, "mac.sqlite");
        var windowsPath = _folder.File("windows.sqlite");
        List<(string, string, string, string)> macSchema, windowsSchema;
        using (var mac = new SqliteDb(macPath))
        {
            macSchema = Schema(mac);
        }
        using (var created = new Database(windowsPath))
        {
            windowsSchema = Schema(created.Sql);
            Assert.Equal(4, created.Sql.UserVersion);
        }
        Assert.Equal(macSchema.Count, windowsSchema.Count);
        for (var i = 0; i < macSchema.Count; i++) Assert.Equal(macSchema[i], windowsSchema[i]);
        Assert.Equal(Normalized(macSchema), Normalized(windowsSchema));
    }

    [Fact]
    public void SqliteSchemaCommandPrintsTheSameForBoth()
    {
        Assert.SkipUnless(CanRun("sqlite3"), "The sqlite3 command isn't installed");
        var macPath = Fixtures.CopyTo(_folder, Fixture, "mac.sqlite");
        var windowsPath = _folder.File("windows.sqlite");
        new Database(windowsPath).Dispose();
        var mac = Run("sqlite3", macPath, ".schema");
        var windows = Run("sqlite3", windowsPath, ".schema");
        Assert.False(string.IsNullOrWhiteSpace(mac));
        Assert.Equal(NormalizeText(mac), NormalizeText(windows));
        Assert.Equal(mac.ReplaceLineEndings("\n"), windows.ReplaceLineEndings("\n"));
    }

    private static List<(string Type, string Name, string Table, string Sql)> Schema(SqliteDb db) =>
        db.Query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY rowid",
            r => (r.Text(0), r.Text(1), r.Text(2), r.Text(3).ReplaceLineEndings("\n")));

    private static string Normalized(IEnumerable<(string Type, string Name, string Table, string Sql)> schema) =>
        string.Join("\n", schema.Select(e => $"{e.Type} {e.Name} {e.Table} {NormalizeText(e.Sql)}"));

    private static string NormalizeText(string text) => Regex.Replace(text, @"\s+", " ").Trim();

    private static bool CanRun(string tool)
    {
        try
        {
            Run(tool, "-version");
            return true;
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return false;
        }
    }

    private static string Run(string tool, params string[] args)
    {
        var info = new ProcessStartInfo(tool) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        foreach (var arg in args) info.ArgumentList.Add(arg);
        using var process = Process.Start(info) ?? throw new InvalidOperationException($"{tool} didn't start");
        var output = process.StandardOutput.ReadToEnd();
        process.WaitForExit();
        if (process.ExitCode != 0) throw new InvalidOperationException($"{tool} failed: {process.StandardError.ReadToEnd()}");
        return output;
    }
}
