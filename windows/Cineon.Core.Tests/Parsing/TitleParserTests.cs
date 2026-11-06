using Cineon.Core.Data;
using Cineon.Core.Parsing;

namespace Cineon.Core.Tests.Parsing;

/// <summary>CineonTests/TitleParserTests.swift, with the same expectations.</summary>
public class TitleParserTests
{
    private static ParsedTitle? Parse(string title = "", string? og = null, string url = "https://example.com/x", string? site = null) =>
        TitleParser.Parse(new PageMeta { Title = title, OgTitle = og, Url = url, OgSite = site });

    [Fact]
    public void StripsEnglishPageFurniture()
    {
        var p = Parse("Watch Dune: Part Two (2024) Full Movie Online Free HD | FlixHub", url: "https://flixhub.to/watch/1", site: "FlixHub");
        Assert.Equal("Dune: Part Two", p?.Name);
        Assert.Equal(2024, p?.Year);
    }

    [Fact]
    public void MovieInsideANameIsKept()
    {
        var p = Parse("Watch The Lego Movie (2014) Online Free | FlixHub", url: "https://flixhub.to/x", site: "FlixHub");
        Assert.Equal("The Lego Movie", p?.Name);
        Assert.Equal(2014, p?.Year);
    }

    [Fact]
    public void PicksFirstMeaningfulSegment()
    {
        var p = Parse("FlixHub - Oppenheimer - Watch free", url: "https://flixhub.to/x", site: "FlixHub");
        Assert.Equal("Oppenheimer", p?.Name);
    }

    [Fact]
    public void ReadsUkrainianTitle()
    {
        var p = Parse("Дюна: Частина друга (2024) дивитися онлайн безкоштовно українською", url: "https://uakino.best/x");
        Assert.Equal("Дюна: Частина друга", p?.Name);
        Assert.Equal(2024, p?.Year);
    }

    [Fact]
    public void ReadsRussianTitleAndKind()
    {
        var p = Parse("Смотреть мультфильм Головоломка 2 онлайн бесплатно в хорошем качестве", url: "https://kino.example/x");
        Assert.Equal("Головоломка 2", p?.Name);
        Assert.Equal(TitleKind.Cartoon, p?.KindHint);
    }

    [Fact]
    public void SpacedColonSeparatesSections()
    {
        var p = Parse("Big Buck Bunny : Free Download, Borrow, and Streaming : Internet Archive", url: "https://archive.org/details/x");
        Assert.Equal("Big Buck Bunny", p?.Name);
    }

    [Fact]
    public void ColonInsideTitleIsKept()
    {
        Assert.Equal("Dune: Part Two", Parse("Dune: Part Two", url: "https://site.example/x")?.Name);
    }

    [Fact]
    public void VideoQualityWordsAreRemoved()
    {
        var p = Parse("Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film - YouTube", url: "https://www.youtube.com/watch?v=x");
        Assert.Equal("Big Buck Bunny", p?.Name);
    }

    // These follow the page titles on HDRezka and its mirrors.
    [Fact]
    public void DubInTheTitleIsNotPartOfTheName()
    {
        var p = Parse("Смотреть Менталист в озвучке Оригинал (+субтитры) онлайн бесплатно в хорошем качестве",
            url: "https://rezka.example/series/drama/1-mentalist.html");
        Assert.Equal("Менталист", p?.Name);
        Assert.Equal(TitleKind.Series, p?.KindHint); // The address says it's a series
    }

    [Fact]
    public void DifferentDubsGiveTheSameName()
    {
        var names = new[] { "Пацаны в озвучке лостфильм (LostFilm)", "Пацаны в озвучке HDrezka Studio (18+)", "Пацаны в озвучке Дубляж" }
            .Select(t => Parse(t, url: "https://rezka.example/x")?.Name)
            .ToHashSet();
        Assert.Equal(["Пацаны"], names);
    }

    [Fact]
    public void AnimeSeasonMarkerIsRemoved()
    {
        Assert.Equal("Поднятие уровня в одиночку", Parse("Поднятие уровня в одиночку [ТВ-1] смотреть онлайн", url: "https://rezka.example/x")?.Name);
    }

    [Fact]
    public void QualityAndDownloadWordsAreRemoved()
    {
        Assert.Equal("Мэйдэй", Parse("Мэйдэй в 1080 качестве смотреть", url: "https://k.example/x")?.Name);
        Assert.Equal("Сверхъестественное", Parse("Сверхъестественное скачать торрент 1080", url: "https://k.example/x")?.Name);
        Assert.Equal("Мэйдэй", Parse("Мэйдэй (Mayday", url: "https://k.example/x")?.Name);
    }

    [Fact]
    public void ComingSoonAndBracketNotesAreRemoved()
    {
        Assert.Equal("Одиссея", Parse("Одиссея скоро", url: "https://rezka.example/x")?.Name);
        Assert.Equal("Паук-Нуар", Parse("Паук-Нуар (ЧБ) в озвучке Дубляж", url: "https://rezka.example/x")?.Name);
    }

    [Fact]
    public void BrokenQuoteIsCleanedUp()
    {
        Assert.Equal("Создание «Рыцаря Семи Королевств»", Parse("Создание «Рыцаря Семи Королевств» в озвучке Дубляж", url: "https://rezka.example/x")?.Name);
        Assert.Equal("Создание Рыцаря", Parse("Создание «Рыцаря", url: "https://rezka.example/x")?.Name);
    }

    [Fact]
    public void SubDubSiteSuffixIsRemoved()
    {
        Assert.Equal("One Piece", Parse("One Piece English Sub/Dub on Aniwatch.to", url: "https://aniwatch.example/x")?.Name);
    }

    [Fact]
    public void EpisodeInRezkaFragment()
    {
        Assert.Equal(new EpisodeRef(2, 3), TitleParser.EpisodeRefIn("https://rezka.example/series/drama/1-name-2020.html#t:238-s:2-e:3"));
    }

    [Fact]
    public void CartoonSectionInAddress()
    {
        Assert.Equal(TitleKind.Cartoon, Parse("Головоломка смотреть онлайн", url: "https://rezka.example/cartoons/comedy/1-name.html")?.KindHint);
    }

    [Fact]
    public void EpisodeFragmentIsPartOfThePageButDubIsNot()
    {
        var a = UrlKey.Make(new Uri("https://rezka.example/series/1-name.html#t:238-s:2-e:3"));
        var b = UrlKey.Make(new Uri("https://rezka.example/series/1-name.html#t:111-s:2-e:3"));
        var c = UrlKey.Make(new Uri("https://rezka.example/series/1-name.html#t:238-s:2-e:4"));
        Assert.Equal("rezka.example/series/1-name.html#s:2-e:3", a);
        Assert.Equal(a, b); // Another dub of the same episode
        Assert.NotEqual(a, c); // Another episode
    }

    [Fact]
    public void BilingualTitleKeepsBothNames()
    {
        var p = Parse("Дюна / Dune (2021) смотреть онлайн", url: "https://rezka.example/x");
        Assert.Equal("Дюна", p?.Name);
        Assert.Equal("Dune", p?.AltName);
        Assert.Equal(2021, p?.Year);
    }

    [Fact]
    public void EpisodeShortForm()
    {
        var p = Parse("Severance S02E04 - Watch Online", url: "https://site.example/x");
        Assert.Equal("Severance", p?.Name);
        Assert.Equal(new EpisodeRef(2, 4), p?.Ref);
        Assert.Equal(TitleKind.Series, p?.KindHint);
    }

    [Fact]
    public void EpisodeLongForm()
    {
        var p = Parse("The Bear Season 3 Episode 7 | Stream", url: "https://site.example/x");
        Assert.Equal("The Bear", p?.Name);
        Assert.Equal(new EpisodeRef(3, 7), p?.Ref);
    }

    [Fact]
    public void UkrainianEpisode()
    {
        var p = Parse("Розрив 2 сезон 4 серія дивитися онлайн", url: "https://site.example/x");
        Assert.Equal("Розрив", p?.Name);
        Assert.Equal(new EpisodeRef(2, 4), p?.Ref);
    }

    [Fact]
    public void EpisodeOnlyInUrl()
    {
        var p = Parse("Severance | Watch", url: "https://site.example/series/severance/season-2/episode-4");
        Assert.Equal("Severance", p?.Name);
        Assert.Equal(new EpisodeRef(2, 4), p?.Ref);
    }

    [Fact]
    public void EpisodeInTvPath()
    {
        Assert.Equal(new EpisodeRef(2, 4), TitleParser.EpisodeRefIn("https://site.example/tv/95396/2/4"));
    }

    [Fact]
    public void YearOnlyNameIsKept()
    {
        var p = Parse("1917 - Watch Online", url: "https://site.example/x");
        Assert.Equal("1917", p?.Name);
        Assert.Null(p?.Year);
    }

    [Fact]
    public void LinkedDataWins()
    {
        var meta = new PageMeta
        {
            Title = "Some junk | Site",
            Url = "https://site.example/x",
            Ld = [new PageMeta.LinkedData { Type = "TVEpisode", Name = "Hello, Ms. Cobel", Series = "Severance", Season = 2, Episode = 1, Year = 2025 }],
        };
        var p = TitleParser.Parse(meta);
        Assert.Equal("Severance", p?.Name);
        Assert.Equal("Hello, Ms. Cobel", p?.EpisodeName);
        Assert.Equal(new EpisodeRef(2, 1), p?.Ref);
        Assert.Equal(0.95, p?.Confidence ?? 0, 0.001);
    }

    [Fact]
    public void FallsBackToUrlSlugWithLowConfidence()
    {
        var p = Parse("", url: "https://site.example/watch/dune-part-two-19xk2");
        Assert.Equal("Dune Part Two", p?.Name);
        Assert.True((p?.Confidence ?? 1) < 0.5);
    }

    [Fact]
    public void OnlySiteNameGivesNoTitle()
    {
        Assert.Null(TitleParser.Clean("FlixHub", new HashSet<string> { "flixhub" }));
    }

    [Fact]
    public void NormalizeFoldsCaseAndPunctuation()
    {
        Assert.Equal("dunepart two".Replace(" ", ""), TitleParser.Normalize("Dune: Part Two!"));
        Assert.Equal("amelie", TitleParser.Normalize("Amélie"));
    }

    [Fact]
    public void UrlKeyIgnoresTrackingAndFragments()
    {
        Assert.Equal("site.example/watch/1?id=5", UrlKey.Make(new Uri("https://www.Site.example/watch/1?utm_source=x&id=5#t=10")));
        Assert.Equal("site.example/watch/1?id=5", UrlKey.Make(new Uri("http://site.example/watch/1/?id=5")));
    }

    [Fact]
    public void RegistrableDomain()
    {
        Assert.Equal("example.com", DomainName.Registrable("player.vod.example.com"));
        Assert.Equal("example.com.ua", DomainName.Registrable("kino.example.com.ua"));
        Assert.Equal("127.0.0.1", DomainName.Registrable("127.0.0.1"));
        Assert.True(DomainName.IsSameSite("a.example.com", "b.example.com"));
        Assert.False(DomainName.IsSameSite("example.com", "ads.net"));
    }

    [Fact]
    public void TimecodeReads()
    {
        Assert.Equal("42:10", Timecode.String(2530));
        Assert.Equal("1:02:03", Timecode.String(3723));
        Assert.Equal("1 h 12 min", Timecode.Spoken(4320));
    }

    [Fact]
    public void QuotesInsideANameStay()
    {
        Assert.Equal("Charlie Chaplin's \"The Rink\"", TitleParser.Clean("Charlie Chaplin's \"The Rink\"", new HashSet<string>())?.Name);
        Assert.Equal("Dune", TitleParser.Clean("\"Dune\"", new HashSet<string>())?.Name);
        Assert.Equal("Dune", TitleParser.Clean("Dune\"", new HashSet<string>())?.Name);
        Assert.Equal("Ocean's Eleven", TitleParser.Clean("Ocean's Eleven", new HashSet<string>())?.Name);
    }

    // MARK: Windows only: reading what meta.js posts.

    [Fact]
    public void PageMetaReadsWhatTheScriptPosts()
    {
        var meta = PageMeta.FromJson("""
            {"url":"https://site.example/x","title":"Dune | Site","ogTitle":null,"ogType":"video.movie","ogSite":"Site",
             "ogImage":"https://site.example/p.jpg","ogDescription":null,"twitterTitle":null,"h1":"Dune",
             "ld":[{"type":"Movie","name":"Dune","series":null,"season":null,"episode":null,"year":2021,"image":null,"description":"Sand."}],
             "icon":"https://site.example/favicon.ico","search":null}
            """);
        Assert.NotNull(meta);
        Assert.Equal("Dune | Site", meta.Title);
        Assert.Equal(2021, Assert.Single(meta.Ld).Year);
        Assert.Equal("Dune", TitleParser.Parse(meta)?.Name);
    }

    [Fact]
    public void PageMetaFailsLikeJsonDecoder()
    {
        Assert.Null(PageMeta.FromJson("""{"url":"https://site.example/x","title":"Dune"}""")); // ld is required
        Assert.Null(PageMeta.FromJson("""{"url":"https://site.example/x","title":"Dune","ld":[{"season":"2"}]}"""));
        Assert.Null(PageMeta.FromJson("not json"));
        Assert.Equal(2, PageMeta.FromJson("""{"url":"u","title":"t","ld":[{"season":2.0}]}""")?.Ld[0].Season);
    }
}
