using Cineon.Core.Shields;

namespace Cineon.Core.Tests.Shields;

public class ShieldEngineTests
{
    private static ShieldEngine Engine(params string[] lists) =>
        ShieldEngine.Load(lists.Select((text, i) => ($"list{i}", text)));

    private static bool Blocks(ShieldEngine engine, string url, string? page = null, ResourceType type = ResourceType.Script, bool mainFrame = false) =>
        engine.Match(url, page, type, mainFrame) == Decision.Block;

    // MARK: Patterns

    [Fact]
    public void HostAnchorsMatchTheHostAndItsSubdomains()
    {
        var e = Engine("||popads.net^");
        Assert.True(Blocks(e, "https://popads.net/pop.js"));
        Assert.True(Blocks(e, "https://c1.popads.net/pop.js"));
        Assert.True(Blocks(e, "http://POPADS.NET"));
        Assert.False(Blocks(e, "https://notpopads.net/pop.js"));
        Assert.False(Blocks(e, "https://example.com/?u=popads.net"));
        Assert.False(Blocks(e, "https://example.com/popads.net/x.js"));
    }

    [Fact]
    public void SeparatorIsOptionalAsInTheMacRegex()
    {
        // "^" becomes "[/:&?=]?" on the Mac, so a trailing one doesn't end the host.
        var e = Engine("||popads.net^");
        Assert.True(Blocks(e, "https://popads.network/x.js"));
        Assert.True(Blocks(e, "https://popads.net.evil.com/"));
        Assert.True(Blocks(e, "https://popads.net:8080/"));

        var middle = Engine("||example.com^ads/");
        Assert.True(Blocks(middle, "https://example.com/ads/1.js"));
        Assert.True(Blocks(middle, "https://example.comads/1.js"));
        Assert.False(Blocks(middle, "https://example.com/x/ads/1.js"));
    }

    [Fact]
    public void PlainAndAnchoredPatterns()
    {
        var e = Engine("/ad-banner.\n|https://track.\nswf|\n-ads-*.gif");
        Assert.True(Blocks(e, "https://cdn.site.com/img/ad-banner.png"));
        Assert.False(Blocks(e, "https://cdn.site.com/img/ad-banner"));
        Assert.True(Blocks(e, "https://track.example.org/p"));
        Assert.False(Blocks(e, "http://track.example.org/p"));
        Assert.True(Blocks(e, "https://example.com/player.swf"));
        Assert.False(Blocks(e, "https://example.com/player.swf?x=1"));
        Assert.True(Blocks(e, "https://x.com/the-ads-300x250.gif"));
        Assert.False(Blocks(e, "https://x.com/the-ads-300x250.png"));
    }

    [Fact]
    public void MatchingIgnoresCaseUnlessAsked()
    {
        // "/AdServer/" alone would be read as a regular expression and skipped, as on the Mac.
        var e = Engine("/AdServer/*\n/Banner.js$match-case");
        Assert.True(Blocks(e, "https://x.com/adserver/1"));
        Assert.True(Blocks(e, "https://x.com/Banner.js"));
        Assert.False(Blocks(e, "https://x.com/banner.js"));
    }

    [Fact]
    public void DataUrlsAreNeverBlocked() =>
        Assert.False(Blocks(Engine("image/png"), "data:image/png;base64,AAAA", type: ResourceType.Image));

    // MARK: Exceptions

    [Fact]
    public void ExceptionsCancelBlocks()
    {
        var e = Engine("||ads.example.com^\n@@||ads.example.com/allowed/");
        Assert.True(Blocks(e, "https://ads.example.com/banner.js"));
        Assert.False(Blocks(e, "https://ads.example.com/allowed/banner.js"));
    }

    [Fact]
    public void ExceptionsOnlyReachTheirOwnList()
    {
        // ignore-previous-rules only cancels rules in its own compiled list.
        var e = Engine("||tracker.com^", "@@||tracker.com^");
        Assert.True(Blocks(e, "https://tracker.com/p.js"));
        var same = Engine("||tracker.com^\n@@||tracker.com^");
        Assert.False(Blocks(same, "https://tracker.com/p.js"));
    }

    [Fact]
    public void ImportantIsJustABlock()
    {
        // The Mac ignores $important, so an exception still wins.
        var e = Engine("||ads.com^$important\n@@||ads.com/ok");
        Assert.True(Blocks(e, "https://ads.com/x"));
        Assert.False(Blocks(e, "https://ads.com/ok.js"));
    }

    [Fact]
    public void WholeSiteExceptionsAllowEverythingOnThatSite()
    {
        var e = Engine("||ads.com^\n##.banner\n@@||trusted.org^$document");
        Assert.False(Blocks(e, "https://ads.com/x.js", "https://www.trusted.org/watch"));
        Assert.False(Blocks(e, "https://ads.com/x.js", "https://trusted.org/"));
        Assert.True(Blocks(e, "https://ads.com/x.js", "https://other.org/"));
        Assert.Equal("", e.CssFor("www.trusted.org"));
        Assert.Contains(".banner", e.CssFor("other.org"));
    }

    // MARK: Options

    [Fact]
    public void ThirdPartyComparesRegistrableDomains()
    {
        var e = Engine("||cdn.net^$third-party\n||own.example.co.uk^$~third-party");
        Assert.True(Blocks(e, "https://cdn.net/a.js", "https://site.com/"));
        Assert.False(Blocks(e, "https://cdn.net/a.js", "https://www.cdn.net/page"));
        Assert.True(Blocks(e, "https://own.example.co.uk/a.js", "https://www.example.co.uk/"));
        Assert.False(Blocks(e, "https://own.example.co.uk/a.js", "https://other.co.uk/"));
    }

    [Fact]
    public void DomainOptionsLookAtTheTopLevelPage()
    {
        var e = Engine("||ads.net^$domain=site.com|other.org\n||pixel.io^$domain=~safe.com");
        Assert.True(Blocks(e, "https://ads.net/a.js", "https://site.com/film"));
        Assert.True(Blocks(e, "https://ads.net/a.js", "https://m.site.com/film"));
        Assert.False(Blocks(e, "https://ads.net/a.js", "https://notsite.com/film"));
        Assert.False(Blocks(e, "https://ads.net/a.js", "https://elsewhere.com/"));
        Assert.True(Blocks(e, "https://pixel.io/p", "https://elsewhere.com/"));
        Assert.False(Blocks(e, "https://pixel.io/p", "https://www.safe.com/"));
    }

    [Fact]
    public void ResourceTypesMapFromWebView2Contexts()
    {
        var e = Engine("||img.ads.com^$image\n||xhr.ads.com^$xmlhttprequest\n||css.ads.com^$stylesheet\n||ws.ads.com^$websocket\n||other.ads.com^$~script");
        Assert.True(Blocks(e, "https://img.ads.com/a.png", type: ResourceType.Image));
        Assert.False(Blocks(e, "https://img.ads.com/a.png", type: ResourceType.Script));
        Assert.True(Blocks(e, "https://xhr.ads.com/a", type: ResourceType.XmlHttpRequest));
        Assert.True(Blocks(e, "https://xhr.ads.com/a", type: ResourceType.Fetch));
        Assert.True(Blocks(e, "https://css.ads.com/a.css", type: ResourceType.Stylesheet));
        Assert.True(Blocks(e, "wss://ws.ads.com/socket", type: ResourceType.Websocket));
        Assert.True(Blocks(e, "https://other.ads.com/a", type: ResourceType.Image));
        Assert.False(Blocks(e, "https://other.ads.com/a", type: ResourceType.Script));
    }

    [Fact]
    public void SubdocumentRulesOnlyBlockFrames()
    {
        var e = Engine("||player-ads.com^$subdocument");
        Assert.True(Blocks(e, "https://player-ads.com/frame", "https://site.com/", ResourceType.Document));
        Assert.False(Blocks(e, "https://player-ads.com/frame", null, ResourceType.Document, mainFrame: true));
        Assert.False(Blocks(e, "https://player-ads.com/x.js", "https://site.com/", ResourceType.Script));
    }

    [Fact]
    public void RulesWithoutTypesBlockMainFrameNavigationsToo()
    {
        // WebKit applies untyped rules to the top-level document as well.
        var e = Engine("||popads.net^");
        Assert.True(Blocks(e, "https://popads.net/", null, ResourceType.Document, mainFrame: true));
    }

    [Fact]
    public void ListsCanBeSwitchedOff()
    {
        var e = ShieldEngine.Load([("easylist", "||a-ads.com^"), ("peterlowe", "||b-ads.com^")]);
        Assert.True(Blocks(e, "https://a-ads.com/x"));
        var only = e.WithLists(["peterlowe"]);
        Assert.False(Blocks(only, "https://a-ads.com/x"));
        Assert.True(Blocks(only, "https://b-ads.com/x"));
        Assert.Equal(["peterlowe"], only.ActiveLists);
        Assert.Equal(1, only.TotalRules);
        Assert.False(Blocks(e.WithLists([]), "https://b-ads.com/x"));
        Assert.True(ShieldEngine.Empty.IsEmpty);
    }

    [Fact]
    public void ReportsTheRuleThatBlocked()
    {
        var e = Engine("||ads.com^\n||ads.com/banner$image");
        Assert.True(e.Evaluate("https://ads.com/banner.png", null, ResourceType.Image, false, nameRule: true, out var rule));
        Assert.NotNull(rule);
        Assert.StartsWith("||ads.com", rule);
    }

    // MARK: Cosmetic

    [Fact]
    public void CssCombinesGenericAndSiteRules()
    {
        var e = Engine("##.ad-a\n##.ad-b\nexample.com,other.org##.banner\n~example.com##.promo\n##.sponsor\nexample.com#@#.sponsor");
        var css = e.CssFor("www.example.com");
        Assert.Contains(".ad-a,.ad-b{display:none !important;}", css);
        Assert.Contains(".banner{display:none !important;}", css);
        Assert.DoesNotContain(".promo", css);
        Assert.DoesNotContain(".sponsor", css);

        var elsewhere = e.CssFor("news.site.net");
        Assert.Contains(".promo{display:none !important;}", elsewhere);
        Assert.Contains(".sponsor{display:none !important;}", elsewhere);
        Assert.DoesNotContain(".banner", elsewhere);
    }

    [Fact]
    public void CssAcceptsAUrlAndIgnoresCase()
    {
        var e = Engine("example.com##.banner");
        Assert.Contains(".banner", e.CssFor("https://WWW.Example.com/watch?v=1"));
        Assert.Contains(".banner", e.CssFor("Example.com."));
        Assert.Equal("", e.CssFor("example.org"));
    }

    [Fact]
    public void CssComesFromSwitchedOnListsOnly()
    {
        var e = ShieldEngine.Load([("a", "##.from-a"), ("b", "##.from-b")]);
        var css = e.WithLists(["b"]).CssFor("site.com");
        Assert.DoesNotContain(".from-a", css);
        Assert.Contains(".from-b", css);
    }

    // MARK: The bundled lists

    [Fact]
    public void BundledListsBlockKnownAdServers()
    {
        var e = BundledLists.Engine;
        Assert.True(Blocks(e, "https://securepubads.g.doubleclick.net/tag/js/gpt.js", "https://www.imdb.com/"));
        Assert.True(Blocks(e, "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js", "https://example.com/"));
        Assert.True(Blocks(e, "https://c1.popads.net/pop.js", "https://streaming.example/"));
        Assert.True(Blocks(e, "https://www.google-analytics.com/analytics.js", "https://example.com/"));
        Assert.False(Blocks(e, "https://www.example.com/", null, ResourceType.Document, mainFrame: true));
        Assert.False(Blocks(e, "https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js", "https://player.example/"));
        Assert.False(Blocks(e, "https://www.youtube.com/watch?v=dQw4w9WgXcQ", null, ResourceType.Document, mainFrame: true));
        Assert.Equal(e.Lists.Sum(l => l.RuleCount), e.TotalRules);
        Assert.Contains(".ad-overlay", e.CssFor("example.com"));
    }
}

/// <summary>The bundled lists, parsed once for all the tests that need them.</summary>
internal static class BundledLists
{
    private static readonly Lazy<ShieldEngine> Lazy = new(() =>
        ShieldEngine.Load(FilterEngine.Catalog.Select(info => (info.Id, Text(info.Id)))));

    public static ShieldEngine Engine => Lazy.Value;

    public static string Text(string id) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Filters", $"{id}.txt"));
}
