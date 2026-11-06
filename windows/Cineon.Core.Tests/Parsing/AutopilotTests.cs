using Cineon.Core.Data;
using Cineon.Core.Metadata;
using Cineon.Core.Parsing;

namespace Cineon.Core.Tests.Parsing;

// CineonTests/AutopilotTests.swift: EpisodeLinksTests, SkipLearnerTests and RescueMatcherTests, with the same
// expectations. FrameGradingTests belong to the frame collector (CoreGraphics, the app's side) and
// SkipRuleStorageTests to the data layer.

public class EpisodeLinksTests
{
    private static string? Next(string address, int season, int episode, (int, int)? to = null)
    {
        var current = new EpisodeRef(season, episode);
        var goal = to is { } t ? new EpisodeRef(t.Item1, t.Item2) : new EpisodeRef(season, episode + 1);
        return EpisodeLinks.Url(new Uri(address), current, goal)?.OriginalString;
    }

    [Fact]
    public void RewritesTheShapesSitesUse()
    {
        Assert.Equal("https://a.example/serial/rozryv/2-sezon/5-seriya", Next("https://a.example/serial/rozryv/2-sezon/4-seriya", 2, 4));
        Assert.Equal("https://a.example/show-s02e05.html", Next("https://a.example/show-s02e04.html", 2, 4));
        Assert.Equal("https://a.example/show/S2E10", Next("https://a.example/show/S2E9", 2, 9));
        Assert.Equal("https://a.example/show/2x10", Next("https://a.example/show/2x09", 2, 9));
        Assert.Equal("https://a.example/tv/the-bear/season-2/episode-8", Next("https://a.example/tv/the-bear/season-2/episode-7", 2, 7));
        Assert.Equal("https://a.example/tv/the-bear/season/2/episode/8", Next("https://a.example/tv/the-bear/season/2/episode/7", 2, 7));
        Assert.Equal("https://a.example/watch?season=2&episode=8", Next("https://a.example/watch?season=2&episode=7", 2, 7));
        Assert.Equal("https://a.example/watch?s=2&e=8", Next("https://a.example/watch?s=2&e=7", 2, 7));
    }

    [Fact]
    public void RewritesTheEpisodeInTheFragment()
    {
        Assert.Equal(
            "https://rezka.example/series/drama/1-mentalist-2008.html#t:238-s:3-e:6",
            Next("https://rezka.example/series/drama/1-mentalist-2008.html#t:238-s:3-e:5", 3, 5));
    }

    [Fact]
    public void MovesToTheNextSeason()
    {
        Assert.Equal("https://a.example/serial/x/3-sezon/1-seriya", Next("https://a.example/serial/x/2-sezon/10-seriya", 2, 10, (3, 1)));
        Assert.Equal("https://a.example/show-s03e01", Next("https://a.example/show-s02e10", 2, 10, (3, 1)));
    }

    [Fact]
    public void AnEpisodeOnlyAddressStaysInItsSeason()
    {
        Assert.Equal("https://a.example/show/episode-8", Next("https://a.example/show/episode-7", 2, 7));
        Assert.Null(Next("https://a.example/show/episode-7", 2, 7, (3, 1)));
    }

    [Fact]
    public void LeavesAddressesThatDoNotNameThisEpisode()
    {
        Assert.Null(Next("https://a.example/film/part-2-2021", 2, 4));
        Assert.Null(Next("https://a.example/serial/x/2-sezon/9-seriya", 2, 4));
        Assert.Null(Next("https://a.example/watch/abc123", 2, 4));
        Assert.Null(Next("https://s2e4.example/film", 1, 1));
    }

    [Fact]
    public void NextEpisodeFollowsThePublishedList()
    {
        EpisodeInfo[] list = [new(1, 1), new(1, 2), new(2, 1), new(2, 2, Released: DateTimeOffset.MaxValue)];
        Assert.Equal([new EpisodeRef(1, 2)], NextEpisode.Candidates(new EpisodeRef(1, 1), list));
        Assert.Equal([new EpisodeRef(2, 1)], NextEpisode.Candidates(new EpisodeRef(1, 2), list));
        Assert.Empty(NextEpisode.Candidates(new EpisodeRef(2, 1), list)); // Not out yet
        Assert.Empty(NextEpisode.Candidates(new EpisodeRef(2, 2), list)); // The last one
    }

    [Fact]
    public void WithoutAListNextEpisodeGuessesBoth()
    {
        Assert.Equal([new EpisodeRef(2, 5), new EpisodeRef(3, 1)], NextEpisode.Candidates(new EpisodeRef(2, 4), []));
    }
}

public class SkipLearnerTests
{
    [Fact]
    public void AnIntroIsAMediumJumpNearTheStart()
    {
        Assert.True(SkipLearner.IsIntro(62, 152, 2700));
        Assert.False(SkipLearner.IsIntro(62, 72, 2700)); // Ten seconds is just skipping ahead
        Assert.False(SkipLearner.IsIntro(62, 900, 2700)); // Too far to be an intro
        Assert.False(SkipLearner.IsIntro(1800, 1890, 2700)); // Too late to be an intro
    }

    [Fact]
    public void CreditsAreAShortStretchBeforeTheEnd()
    {
        Assert.True(SkipLearner.IsCredits(90, 2700));
        Assert.False(SkipLearner.IsCredits(5, 2700));
        Assert.False(SkipLearner.IsCredits(900, 2700)); // That's leaving early, not skipping credits
    }

    [Fact]
    public void RepeatedArrowPressesBecomeOneJump()
    {
        var start = DateTimeOffset.Now;
        var jump = new SkipLearner.Jump(60, 70, start);
        for (var step = 1; step < 9; step++)
        {
            jump = jump.Extended(jump.To + 1, jump.To + 11, start.AddSeconds(step))!.Value;
        }
        Assert.Equal(60, jump.From);
        Assert.True(jump.To > 150);
    }

    [Fact]
    public void APauseOrAJumpBackStartsOver()
    {
        var start = DateTimeOffset.Now;
        var jump = new SkipLearner.Jump(60, 70, start);
        Assert.Null(jump.Extended(70, 80, start.AddSeconds(20)));
        Assert.Null(jump.Extended(70, 40, start.AddSeconds(1)));
    }

    [Fact]
    public void MirrorsShareRules()
    {
        Assert.Equal(SkipLearner.SiteKey("hdrezka.ag"), SkipLearner.SiteKey("rezka-ua.co"));
        Assert.NotEqual(SkipLearner.SiteKey("hdrezka.ag"), SkipLearner.SiteKey("uakino.me"));
        Assert.Equal("127.0.0.1", SkipLearner.SiteKey("127.0.0.1"));
    }

    // BrowserImportTests.testBrandIgnoresMirrorDecoration, for ImportAnalyzer.brand, which lives here as SiteBrand.
    [Fact]
    public void BrandIgnoresMirrorDecoration()
    {
        Assert.Equal("rezka", SiteBrand.Of("hdrezka.ag"));
        Assert.Equal("rezka", SiteBrand.Of("rezka-ua.co"));
        Assert.Equal("kinogo", SiteBrand.Of("kinogo1.biz"));
        Assert.NotEqual(SiteBrand.Of("kinogo.is"), SiteBrand.Of("uakino.best"));
    }
}

public class RescueMatcherTests
{
    private static readonly Uri Page = new("https://site.example/search?q=dune");

    private static RescueLink Link(string path, string text, string context = "") =>
        new(new Uri("https://site.example" + path), text, context);

    private static RescueMatch? Best(RescueLink[] links, string name = "Dune: Part Two", int? year = 2024) =>
        RescueMatcher.Best(links, [name], year, Page);

    [Fact]
    public void PicksTheRightFilmOverItsNeighbours()
    {
        RescueLink[] links =
        [
            Link("/film/dune-1984", "Dune (1984)"),
            Link("/film/dune-2021", "Dune (2021)"),
            Link("/film/dune-part-two", "Dune: Part Two (2024)"),
            Link("/film/dune-prophecy", "Dune: Prophecy (2024)"),
        ];
        var match = Best(links);
        Assert.Equal("/film/dune-part-two", match?.Link.Url.AbsolutePath);
        Assert.True(match?.IsStrong);
    }

    [Fact]
    public void AWrongYearIsNeverOpened()
    {
        Assert.Null(Best([Link("/film/1", "Dune (1984)")], "Dune", 2021));
    }

    [Fact]
    public void ASequelNumberCountsAgainst()
    {
        Assert.False(Best([Link("/film/2", "Dune 2 (2021)")], "Dune", 2021)?.IsStrong ?? false);
    }

    [Fact]
    public void MissingYearStaysASuggestion()
    {
        var match = Best([Link("/film/x", "Dune: Part Two")]);
        Assert.NotNull(match);
        Assert.False(match.IsStrong);
    }

    [Fact]
    public void YearBesideTheLinkConfirms()
    {
        Assert.True(Best([Link("/film/x", "Dune: Part Two", "Dune: Part Two 2024 Sci-Fi")])?.IsStrong);
    }

    [Fact]
    public void TranslatedTitlesMatchEitherName()
    {
        Assert.True(Best([Link("/film/x", "Дюна: Частина друга / Dune: Part Two (2024)")])?.IsStrong);
        Assert.True(RescueMatcher.Best([Link("/film/x", "Дюна: Частина друга (2024)")], ["Dune: Part Two", "Дюна: Частина друга"], 2024, Page)?.IsStrong);
    }

    [Fact]
    public void PageFurnitureInLinkTextIsIgnored()
    {
        Assert.True(Best([Link("/film/x", "Смотреть Dune: Part Two онлайн бесплатно (2024)")])?.IsStrong);
        Assert.True(Best([Link("/film/x", "Watch Dune: Part Two Full Movie Online Free (2024)")])?.IsStrong);
    }

    [Fact]
    public void NamesCanContainFurnitureWords()
    {
        Assert.True(Best([Link("/f/1", "Vanishing Film (2020)")], "Vanishing Film", 2020)?.IsStrong);
        Assert.True(Best([Link("/f/2", "Watch The Lego Movie Online Free (2014)")], "The Lego Movie", 2014)?.IsStrong);
        Assert.Null(Best([Link("/f/3", "Scary Stories (2000)")], "Scary Movie", 2000)); // Part of a name isn't the name
    }

    [Fact]
    public void TrailersAndReviewsAreNotTheFilm()
    {
        Assert.Null(Best([Link("/v/1", "Dune: Part Two | Official Trailer (2024)")]));
        Assert.Null(Best([Link("/v/2", "Dune: Part Two review (2024)")]));
        Assert.Null(Best([Link("/v/3", "Дюна: Частина друга трейлер (2024)")], "Дюна: Частина друга"));
    }

    [Fact]
    public void AnAddressAloneOnlySuggests()
    {
        var match = Best([Link("/films/18432-dune-part-two.html", "")]);
        Assert.NotNull(match);
        Assert.False(match.IsStrong);
    }

    [Fact]
    public void IgnoresNavigationAndOtherSites()
    {
        var ad = new RescueLink(new Uri("https://ads.example/dune-part-two"), "Dune: Part Two (2024)", "");
        Assert.Null(Best([ad]));
        Assert.Null(Best([Link("/tag/dune-part-two", "Dune: Part Two (2024)")]));
        Assert.Null(Best([Link("/search?q=dune", "Dune: Part Two (2024)")]));
    }

    [Fact]
    public void APartOfTheNameIsNotAMatch()
    {
        Assert.Null(Best([Link("/film/x", "Dune (2024)")]));
    }

    [Fact]
    public void UploadSitesAreOnlySuggestions()
    {
        Assert.True(RescueMatcher.IsVideoSharing(new Uri("https://www.youtube.com/watch?v=1")));
        Assert.False(RescueMatcher.IsVideoSharing(new Uri("https://tubitv.com/movies/1")));
    }

    [Fact]
    public void FindsTheSamePageAtOtherAddresses()
    {
        var url = new Uri("https://hdrezka.ag/series/drama/1-mentalist-2008.html#t:238-s:3-e:5");
        var found = RescueMatcher.Mirrors(url, ["rezka-ua.co", "uakino.me", "hdrezka.ag", "rezka.fi", "rezka-ua.co"]);
        Assert.Equal(
            ["https://rezka-ua.co/series/drama/1-mentalist-2008.html#t:238-s:3-e:5", "https://rezka.fi/series/drama/1-mentalist-2008.html#t:238-s:3-e:5"],
            found.Select(u => u.OriginalString));
    }

    [Fact]
    public void CommonWordsDoNotMakeSitesMirrors()
    {
        Assert.Empty(RescueMatcher.Mirrors(new Uri("https://kino-online.example/film/1"), ["kino-hd.example", "kino.example"]));
    }
}
