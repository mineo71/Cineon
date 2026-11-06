using Cineon.Core.Data;
using Cineon.Core.Metadata;
using Cineon.Core.Tests.Data;

namespace Cineon.Core.Tests.Metadata;

/// <summary>The background enricher, against a real library and canned services.</summary>
public sealed class MetadataServiceTests : IDisposable
{
    private const string DuneSearchUrl = "https://v3.sg.media-imdb.com/suggestion/x/dune%3A%20part%20two.json";
    private const string DuneMovieUrl = "https://v3-cinemeta.strem.io/meta/movie/tt15239678.json";
    private const string DuneMeta = """
        {"meta":{"id":"tt15239678","type":"movie","name":"Dune: Part Two","description":"Paul Atreides unites with Chani.",
          "genres":["Action","Adventure","Drama"],"runtime":"166 min",
          "poster":"https://images.metahub.space/poster/medium/tt15239678/img",
          "background":"https://images.metahub.space/background/medium/tt15239678/img","releaseInfo":"2024"}}
        """;

    private readonly TempFolder _folder = new();
    private readonly Database _db;
    private readonly LibraryStore _library;
    private readonly Dictionary<string, string> _routes = [];
    private readonly FakeHttp _http;
    private bool _enabled = true;

    public MetadataServiceTests()
    {
        _db = new Database(_folder.File("cineon.sqlite"));
        _library = new LibraryStore(_db);
        _http = FakeHttp.Routes(_routes);
    }

    public void Dispose()
    {
        _db.Dispose();
        _folder.Dispose();
    }

    private MetadataService Service() =>
        new(_library, () => _enabled, new MetadataClient(_http), new PagePreview(_http)) { Pause = TimeSpan.Zero };

    [Fact]
    public async Task EnrichFillsInTheTitle()
    {
        _routes[DuneSearchUrl] = MetadataClientTests.DuneSearch;
        _routes[DuneMovieUrl] = DuneMeta;
        var id = _library.AddTitle("Dune: Part Two", 2024, TitleKind.Film)!.Id;
        var service = Service();

        service.Enrich(id);
        await service.Idle;

        var title = _library.Titles[id];
        Assert.True(title.MetadataChecked);
        Assert.Equal("tt15239678", title.ImdbId);
        Assert.Equal("Dune: Part Two", title.Name);
        Assert.Equal("duneparttwo", title.NormName);
        Assert.Equal(2024, title.Year);
        // The suggestion's poster wins over Cinemeta's.
        Assert.Equal("https://m.media-amazon.com/images/M/MV5BNTc0YmQxMjEt@._V1_QL75_UX500_.jpg", title.PosterUrl?.OriginalString);
        Assert.Equal("https://images.metahub.space/background/medium/tt15239678/img", title.BackdropUrl?.OriginalString);
        Assert.Equal("Paul Atreides unites with Chani.", title.Overview);
        Assert.Equal(["Action", "Adventure", "Drama"], title.Genres);
        Assert.Equal(166, title.RuntimeMinutes);
        Assert.Equal(TitleKind.Film, title.Kind);
        Assert.Equal([DuneSearchUrl, DuneMovieUrl], _http.Addresses);

        // Checked titles aren't looked up again.
        service.Enrich(id);
        await service.Idle;
        Assert.Equal(2, _http.Requests.Count);
    }

    [Fact]
    public async Task TheOtherNameIsTriedFirstAndAnimationMakesACartoon()
    {
        _routes["https://v3.sg.media-imdb.com/suggestion/x/dune.json"] = MetadataClientTests.DuneSearch;
        _routes["https://v3-cinemeta.strem.io/meta/movie/tt1160419.json"] = """{"meta":{"genres":["Animation"]}}""";
        var id = _library.AddTitle("Дюна", 2021, TitleKind.Unknown)!.Id;
        var service = Service();

        service.Enrich(id, altName: "Dune");
        await service.Idle;

        var title = _library.Titles[id];
        Assert.Equal("tt1160419", title.ImdbId);
        Assert.Equal("Dune", title.Name);
        Assert.Equal(TitleKind.Cartoon, title.Kind);
        Assert.Equal("https://v3.sg.media-imdb.com/suggestion/x/dune.json", _http.Addresses.First());
    }

    [Fact]
    public async Task WithoutAMatchThePageItWasWatchedOnIsAsked()
    {
        _routes["https://kino.example/film/1"] = """
            <head><meta property="og:image" content="/posters/1.jpg"><meta property="og:description" content="Опис фільму"></head>
            """;
        var id = _library.AddTitle("Невідомий фільм", 2020, TitleKind.Film)!.Id;
        _library.SaveProgress(new WatchProgress
        {
            TitleId = id, Ref = EpisodeRef.None, UrlKey = "kino.example/film/1", Url = new Uri("https://kino.example/film/1"),
            Host = "kino.example", Position = 60, Duration = 6000, UpdatedAt = DateTimeOffset.Now,
        });
        var service = Service();

        service.Enrich(id);
        await service.Idle;

        var title = _library.Titles[id];
        Assert.True(title.MetadataChecked);
        Assert.Null(title.ImdbId);
        Assert.Equal("https://kino.example/posters/1.jpg", title.PosterUrl?.AbsoluteUri);
        Assert.Equal("Опис фільму", title.Overview);
    }

    [Fact]
    public async Task TheSameFilmUnderAnotherNameIsMerged()
    {
        _routes[DuneSearchUrl] = MetadataClientTests.DuneSearch;
        var existing = _library.AddTitle("Дюна: Частина друга", 2024, TitleKind.Film, imdbId: "tt15239678")!.Id;
        var id = _library.AddTitle("Dune: Part Two", 2024, TitleKind.Film)!.Id;
        var service = Service();

        service.Enrich(id);
        await service.Idle;

        Assert.False(_library.Titles.ContainsKey(id));
        Assert.True(_library.Titles.ContainsKey(existing));
        Assert.Equal(existing, _library.CurrentId(id));
    }

    [Fact]
    public async Task NothingHappensWhenTurnedOff()
    {
        _enabled = false;
        var id = _library.AddTitle("Dune: Part Two", 2024, TitleKind.Film)!.Id;
        var service = Service();
        service.Enrich(id);
        await service.Idle;
        Assert.Empty(_http.Requests);
        Assert.False(_library.Titles[id].MetadataChecked);
    }

    [Fact]
    public async Task AChoiceByHandIsApplied()
    {
        _routes[DuneMovieUrl] = DuneMeta;
        var id = _library.AddTitle("Dune 2", null, TitleKind.Unknown)!.Id;
        var service = Service();

        await service.ApplyAsync(new MetadataHit("tt15239678", "Dune: Part Two", 2024, TitleKind.Film), id);

        var title = _library.Titles[id];
        Assert.Equal("Dune: Part Two", title.Name);
        Assert.Equal(2024, title.Year);
        Assert.Equal("https://images.metahub.space/poster/medium/tt15239678/img", title.PosterUrl?.OriginalString);
        Assert.True(title.MetadataChecked);
    }

    [Fact]
    public async Task EpisodesAreKeptUntilAskedForFresh()
    {
        _routes["https://v3-cinemeta.strem.io/meta/series/tt11280740.json"] = MetadataClientTests.SeveranceMeta;
        var series = _library.AddTitle("Severance", 2022, TitleKind.Series, imdbId: "tt11280740")!;
        var film = _library.AddTitle("Dune", 2021, TitleKind.Film, imdbId: "tt1160419")!;
        var service = Service();

        Assert.Equal(4, (await service.EpisodesAsync(series)).Count);
        Assert.Equal(4, (await service.EpisodesAsync(series)).Count);
        Assert.Single(_http.Requests);
        await service.EpisodesAsync(series, fresh: true);
        Assert.Equal(2, _http.Requests.Count);

        Assert.Empty(await service.EpisodesAsync(film));
        Assert.Equal(2, _http.Requests.Count);

        service.TestEpisodes[film.Id] = [new EpisodeInfo(1, 1)];
        Assert.Equal("1x1", Assert.Single(await service.EpisodesAsync(film)).Id);
    }
}
