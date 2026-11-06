using System.Net;
using Cineon.Core.Data;
using Cineon.Core.Metadata;

namespace Cineon.Core.Tests.Metadata;

/// <summary>Canned responses shaped like IMDb's suggestion endpoint and Cinemeta, read the way the Mac reads them.</summary>
public class MetadataClientTests
{
    internal const string DuneSearch = """
        {"d":[
          {"i":{"height":3000,"imageUrl":"https://m.media-amazon.com/images/M/MV5BNTc0YmQxMjEt@._V1_.jpg","width":2025},
           "id":"tt15239678","l":"Dune: Part Two","q":"feature","qid":"movie","rank":46,"s":"Timothée Chalamet, Zendaya","y":2024},
          {"i":{"height":2048,"imageUrl":"https://m.media-amazon.com/images/M/MV5BMDQ0NjgyN2Yt@._V1_.jpg","width":1382},
           "id":"tt1160419","l":"Dune","q":"feature","qid":"movie","rank":180,"s":"Timothée Chalamet, Rebecca Ferguson","y":2021},
          {"id":"tt10466872","l":"Dune: Prophecy","q":"TV series","qid":"tvSeries","rank":500,"s":"Emily Watson, Olivia Williams","y":2024,"yr":"2024-"},
          {"i":{"imageUrl":"https://m.media-amazon.com/images/M/nm.jpg"},"id":"nm3154303","l":"Timothée Chalamet","rank":120,"s":"Actor, Dune"},
          {"id":"tt31613341","l":"Dune: Awakening","q":"video game","qid":"videoGame","y":2025}
        ],"q":"dune","v":1}
        """;

    internal const string SeveranceMeta = """
        {"meta":{"id":"tt11280740","imdb_id":"tt11280740","type":"series","name":"Severance",
          "description":"Mark leads a team of office workers whose memories have been surgically divided.",
          "genres":["Drama","Mystery","Sci-Fi"],"runtime":"55 min",
          "poster":"https://images.metahub.space/poster/medium/tt11280740/img",
          "background":"https://images.metahub.space/background/medium/tt11280740/img","releaseInfo":"2022–",
          "videos":[
            {"id":"tt11280740:2:1","name":"Hello, Ms. Cobel","season":2,"number":1,"episode":1,
             "thumbnail":"https://episodes.metahub.space/tt11280740/2/1/w780.jpg","released":"2025-01-17T05:00:00.000Z"},
            {"id":"tt11280740:1:2","name":"Half Loop","season":1,"number":2,"episode":2,"overview":"Mark gets a promotion.",
             "released":"2022-02-18T05:00:00.000Z"},
            {"id":"tt11280740:1:1","name":"Good News About Hell","season":1,"number":1,"description":"Helly wakes up.",
             "released":"2022-02-18T05:00:00.000Z"},
            {"id":"tt11280740:0:1","name":"Behind the scenes","season":0,"episode":1,"released":"2022-03-01T05:00:00.000Z"},
            {"id":"tt11280740:2:2","name":"Goodbye, Mrs. Selvig","season":2,"episode":2,"released":"2025-01-24T05:00:00Z"}
          ]}}
        """;

    [Fact]
    public async Task SearchReadsTheSuggestions()
    {
        var http = FakeHttp.Routes(new() { ["https://v3.sg.media-imdb.com/suggestion/x/dune.json"] = DuneSearch });
        var hits = await new MetadataClient(http).SearchAsync("  Dune \n");

        Assert.Equal(["tt15239678", "tt1160419", "tt10466872"], hits.Select(h => h.Id));
        var first = hits[0];
        Assert.Equal(new MetadataHit("tt15239678", "Dune: Part Two", 2024, TitleKind.Film,
            new Uri("https://m.media-amazon.com/images/M/MV5BNTc0YmQxMjEt@._V1_QL75_UX500_.jpg"), "Timothée Chalamet, Zendaya", 46), first);
        Assert.Equal("https://m.media-amazon.com/images/M/MV5BNTc0YmQxMjEt@._V1_QL75_UX500_.jpg", first.PosterUrl!.OriginalString);
        Assert.Equal(TitleKind.Series, hits[2].Kind);
        Assert.Null(hits[2].PosterUrl);
        Assert.Equal(MetadataClient.UserAgent, string.Join(" ", Assert.Single(http.Requests).Headers.GetValues("User-Agent")));
    }

    [Fact]
    public async Task SearchEncodesTheQueryLikeTheMac()
    {
        var http = new FakeHttp(_ => FakeHttp.Json("""{"d":[]}"""));
        await new MetadataClient(http).SearchAsync("Дюна: Частина друга");
        await new MetadataClient(http).SearchAsync("AC/DC");
        Assert.Equal(
            [
                "https://v3.sg.media-imdb.com/suggestion/x/%D0%B4%D1%8E%D0%BD%D0%B0%3A%20%D1%87%D0%B0%D1%81%D1%82%D0%B8%D0%BD%D0%B0%20%D0%B4%D1%80%D1%83%D0%B3%D0%B0.json",
                "https://v3.sg.media-imdb.com/suggestion/x/ac%2Fdc.json",
            ],
            http.Addresses);
    }

    [Fact]
    public async Task ShortQueriesAndFailuresFindNothing()
    {
        var http = new FakeHttp(_ => FakeHttp.Json(DuneSearch, HttpStatusCode.InternalServerError));
        var client = new MetadataClient(http);
        Assert.Empty(await client.SearchAsync(" d "));
        Assert.Empty(http.Requests);
        Assert.Empty(await client.SearchAsync("dune"));
        Assert.Empty(await new MetadataClient(new FakeHttp(_ => throw new HttpRequestException("offline"))).SearchAsync("dune"));
        Assert.Empty(await new MetadataClient(new FakeHttp(_ => FakeHttp.Json("""{"d":[{"l":"no id"}]}"""))).SearchAsync("dune"));
    }

    [Fact]
    public async Task DetailReadsCinemeta()
    {
        var http = FakeHttp.Routes(new() { ["https://v3-cinemeta.strem.io/meta/series/tt11280740.json"] = SeveranceMeta });
        var detail = await new MetadataClient(http).DetailAsync("tt11280740", TitleKind.Series);

        Assert.NotNull(detail);
        Assert.Equal(["https://v3-cinemeta.strem.io/meta/series/tt11280740.json"], http.Addresses);
        Assert.Equal(["Drama", "Mystery", "Sci-Fi"], detail.Genres);
        Assert.Equal(55, detail.RuntimeMinutes);
        Assert.Equal(2022, detail.Year);
        Assert.Equal("https://images.metahub.space/background/medium/tt11280740/img", detail.BackdropUrl?.OriginalString);
        // Numbered seasons only, in order; an episode needs "episode" or "number".
        Assert.Equal(["1x1", "1x2", "2x1", "2x2"], detail.Episodes.Select(e => e.Id));
        var pilot = detail.Episodes[0];
        Assert.Equal("Good News About Hell", pilot.Name);
        Assert.Equal("Helly wakes up.", pilot.Overview);
        Assert.Equal(new DateTimeOffset(2022, 2, 18, 5, 0, 0, TimeSpan.Zero), pilot.Released);
        Assert.Equal("Mark gets a promotion.", detail.Episodes[1].Overview);
        Assert.Equal("https://episodes.metahub.space/tt11280740/2/1/w780.jpg", detail.Episodes[2].ThumbnailUrl?.OriginalString);
        // ISO8601DateFormatter with fractional seconds can't read a date without them.
        Assert.Null(detail.Episodes[3].Released);
    }

    [Fact]
    public async Task AnUnsortedTitleIsTriedAsAFilmThenASeries()
    {
        var http = FakeHttp.Routes(new()
        {
            ["https://v3-cinemeta.strem.io/meta/movie/tt11280740.json"] = """{"meta":null}""",
            ["https://v3-cinemeta.strem.io/meta/series/tt11280740.json"] = SeveranceMeta,
        });
        var detail = await new MetadataClient(http).DetailAsync("tt11280740", TitleKind.Unknown);
        Assert.Equal(4, detail?.Episodes.Count);
        Assert.Equal(
            ["https://v3-cinemeta.strem.io/meta/movie/tt11280740.json", "https://v3-cinemeta.strem.io/meta/series/tt11280740.json"],
            http.Addresses);

        var film = FakeHttp.Routes(new());
        Assert.Null(await new MetadataClient(film).DetailAsync("tt1160419", TitleKind.Film));
        Assert.Equal(["https://v3-cinemeta.strem.io/meta/movie/tt1160419.json"], film.Addresses);
    }

    [Fact]
    public void BestMatchTrustsSpellingForLatinNames()
    {
        var hits = MetadataClient.ParseSearch(System.Text.Encoding.UTF8.GetBytes(DuneSearch));
        Assert.Equal("tt15239678", MetadataClient.BestMatch(hits, "Dune: Part Two", 2024, TitleKind.Film)?.Id);
        Assert.Equal("tt1160419", MetadataClient.BestMatch(hits, "Dune", 2021, TitleKind.Film)?.Id);
        Assert.Equal("tt1160419", MetadataClient.BestMatch(hits, "Dune", 1984, TitleKind.Film)?.Id); // The exact name outweighs the year
        Assert.Equal("tt10466872", MetadataClient.BestMatch(hits, "Dune Prophecy", 2024, TitleKind.Series)?.Id);
        Assert.Null(MetadataClient.BestMatch(hits, "Arrival", null, TitleKind.Film));
        Assert.Null(MetadataClient.BestMatch([], "Dune", null, TitleKind.Film));
    }

    [Fact]
    public void BestMatchTrustsTheRankForOtherScripts()
    {
        var hits = MetadataClient.ParseSearch(System.Text.Encoding.UTF8.GetBytes(DuneSearch));
        Assert.Equal("tt15239678", MetadataClient.BestMatch(hits, "Дюна: Частина друга", 2024, TitleKind.Film)?.Id);
        Assert.Null(MetadataClient.BestMatch(hits, "Дюна", 1965, TitleKind.Series));
    }
}

/// <summary>BrowserImportTests' PagePreview cases, and fetching.</summary>
public class PagePreviewTests
{
    [Fact]
    public void PreviewReadsOpenGraphTags()
    {
        const string html = """
            <head><meta content="https://cdn.example/poster.jpg" property="og:image"><meta property="og:description" content="A film &amp; more"></head>
            """;
        var preview = PagePreview.Parse(html, new Uri("https://site.example/x"));
        Assert.Equal("https://cdn.example/poster.jpg", preview.Poster?.OriginalString);
        Assert.Equal("A film & more", preview.Overview);
    }

    [Fact]
    public void PreviewResolvesRelativeImagesAndIgnoresLogos()
    {
        var relative = PagePreview.Parse("""<meta property="og:image" content="/i/p.jpg">""", new Uri("https://site.example/film/x"));
        Assert.Equal("https://site.example/i/p.jpg", relative.Poster?.AbsoluteUri);
        var logo = PagePreview.Parse("""<meta property="og:image" content="/static/logo.png">""", new Uri("https://site.example/x"));
        Assert.Null(logo.Poster);
    }

    [Fact]
    public async Task FetchReadsTheHeadOfAPageAsSafari()
    {
        var page = "<html><head><meta property=\"og:image\" content=\"/p.jpg\"></head><body>" + new string('x', 400_000)
            + "<meta property=\"og:description\" content=\"Too far down\"></body></html>";
        var http = new FakeHttp(_ => FakeHttp.Json(page));
        var preview = await new PagePreview(http).FetchAsync(new Uri("https://site.example/film/1"));
        Assert.Equal("https://site.example/p.jpg", preview.Poster?.AbsoluteUri);
        Assert.Null(preview.Overview); // Only the first 300,000 bytes are read
        Assert.Equal(PagePreview.UserAgent, string.Join(" ", Assert.Single(http.Requests).Headers.GetValues("User-Agent")));

        var missing = await new PagePreview(new FakeHttp(_ => FakeHttp.Json(page, HttpStatusCode.NotFound))).FetchAsync(new Uri("https://site.example/x"));
        Assert.Equal((null, null), missing);
    }
}
