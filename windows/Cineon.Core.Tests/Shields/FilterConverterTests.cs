using System.Text.Json;
using System.Text.RegularExpressions;
using Cineon.Core.Shields;

namespace Cineon.Core.Tests.Shields;

/// <summary>A port of CineonTests/FilterConverterTests.swift: the same lines give the same WebKit JSON.</summary>
public class FilterConverterTests(ITestOutputHelper output)
{
    private static List<JsonElement> Rules(string text)
    {
        var converted = FilterConverter.Convert(text);
        return [.. JsonDocument.Parse(converted.Json).RootElement.EnumerateArray()];
    }

    private static JsonElement Trigger(JsonElement rule) => rule.GetProperty("trigger");

    private static JsonElement Action(JsonElement rule) => rule.GetProperty("action");

    private static string? Text(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) ? value.GetString() : null;

    private static string[] Strings(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) ? [.. value.EnumerateArray().Select(v => v.GetString()!)] : [];

    private static bool Has(JsonElement element, string name) => element.TryGetProperty(name, out _);

    [Fact]
    public void HostAnchoredBlock()
    {
        var r = Rules("||popads.net^");
        Assert.Single(r);
        Assert.Equal("block", Text(Action(r[0]), "type"));
        Assert.Equal(@"^[^:]+://+([^:/]+\.)?popads\.net[/:&?=]?", Text(Trigger(r[0]), "url-filter"));
    }

    [Fact]
    public void Options()
    {
        var r = Rules("||ads.example.com^$script,third-party,domain=site.com|other.org");
        var t = Trigger(r[0]);
        Assert.Equal(["script"], Strings(t, "resource-type"));
        Assert.Equal(["third-party"], Strings(t, "load-type"));
        Assert.Equal(["*site.com", "*other.org"], Strings(t, "if-domain"));
    }

    [Fact]
    public void ExceptionsComeLast()
    {
        var r = Rules("@@||good.com^\n||bad.com^");
        Assert.Equal("block", Text(Action(r[0]), "type"));
        Assert.Equal("ignore-previous-rules", Text(Action(r[1]), "type"));
    }

    [Fact]
    public void CosmeticGenericAreBatched()
    {
        var r = Rules("##.ad-a\n##.ad-b");
        Assert.Single(r);
        Assert.Equal(".ad-a,.ad-b", Text(Action(r[0]), "selector"));
    }

    [Fact]
    public void CosmeticDomainSpecific()
    {
        var r = Rules("example.com,other.org##.banner");
        Assert.Equal(["*example.com", "*other.org"], Strings(Trigger(r[0]), "if-domain"));
    }

    [Fact]
    public void CosmeticExceptionBecomesUnlessDomain()
    {
        var r = Rules("##.promo\nexample.com#@#.promo");
        Assert.Single(r);
        Assert.Equal(["*example.com"], Strings(Trigger(r[0]), "unless-domain"));
    }

    [Fact]
    public void WholeSiteException()
    {
        var r = Rules("@@||example.com^$document");
        Assert.Equal(["*example.com"], Strings(Trigger(r[0]), "if-domain"));
        Assert.Equal("ignore-previous-rules", Text(Action(r[0]), "type"));
    }

    [Fact]
    public void UnsupportedRulesAreSkipped()
    {
        var text = """
            ! comment
            [Adblock Plus 2.0]
            example.com##+js(noop)
            example.com#?#.a:has-text(ad)
            ||a.com^$csp=script-src 'none'
            ||b.com^$redirect=noop.js
            /banner[0-9]+/
            ||c.com^$popup
            ||кино.рф^
            """;
        Assert.Empty(Rules(text));
        Assert.Equal(7, FilterConverter.Convert(text).Skipped);
    }

    [Fact]
    public void BothDomainKindsNeverAppearTogether()
    {
        var r = Rules("||x.example.net^$domain=a.com|~b.com");
        Assert.True(Has(Trigger(r[0]), "if-domain"));
        Assert.False(Has(Trigger(r[0]), "unless-domain"));
    }

    [Fact]
    public void SpecialCharactersAreEscaped()
    {
        Assert.Equal(@"/ads\.js\?v=1", FilterConverter.UrlFilter("/ads.js?v=1"));
        Assert.Equal(@"^https://x\.com/a.*b$", FilterConverter.UrlFilter("|https://x.com/a*b|"));
    }

    [Fact]
    public void TooShortPatternRejected() => Assert.Null(FilterConverter.UrlFilter("*^"));

    /// <summary>
    /// The Mac's proof is that WebKit compiles the output for every list the app ships. WebKit isn't
    /// here, so check the JSON parses, every url-filter is a valid regular expression, and the counts
    /// are in range.
    /// </summary>
    [Fact]
    public void BundledListsConvert()
    {
        foreach (var info in FilterEngine.Catalog)
        {
            var text = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Filters", $"{info.Id}.txt"));
            var converted = FilterConverter.Convert(text);
            Assert.True(converted.RuleCount > 10, info.Id);
            Assert.True(converted.RuleCount < 150_000, info.Id);
            using var json = JsonDocument.Parse(converted.Json);
            Assert.Equal(converted.RuleCount, json.RootElement.GetArrayLength());
            foreach (var rule in json.RootElement.EnumerateArray())
            {
                var filter = Text(Trigger(rule), "url-filter")!;
                _ = new Regex(filter, RegexOptions.CultureInvariant);
                Assert.All(filter, c => Assert.True(c is >= ' ' and < (char)128));
            }
            Assert.Equal(converted.RuleCount, FilterList.Compile(info.Id, text).RuleCount);
            output.WriteLine($"list {info.Id}: {converted.RuleCount} rules, {converted.Skipped} skipped");
        }
    }

    // Beyond the Mac tests: details of the format that the matcher relies on.

    [Fact]
    public void OptionsKeepTheMacOrderAndNames()
    {
        var r = Rules("||cdn.example.com/x.js$match-case,subdocument,~third-party,domain=~a.com");
        var t = Trigger(r[0]);
        Assert.True(t.GetProperty("url-filter-is-case-sensitive").GetBoolean());
        Assert.Equal(["document"], Strings(t, "resource-type"));
        Assert.Equal(["first-party"], Strings(t, "load-type"));
        Assert.Equal(["child-frame"], Strings(t, "load-context"));
        Assert.Equal(["*a.com"], Strings(t, "unless-domain"));
    }

    [Fact]
    public void ExcludedTypesReplaceTheList()
    {
        var r = Rules("||example.com/ad$script,~image");
        Assert.Equal(
            ["document", "style-sheet", "script", "font", "media", "fetch", "websocket", "other", "ping"],
            Strings(Trigger(r[0]), "resource-type"));
    }

    [Fact]
    public void ElementHidingExceptionsBecomeWholeSiteExceptions()
    {
        foreach (var option in new[] { "elemhide", "generichide", "doc" })
        {
            var r = Rules($"@@||example.com^${option}");
            Assert.Equal("ignore-previous-rules", Text(Action(r[0]), "type"));
            Assert.Equal(".*", Text(Trigger(r[0]), "url-filter"));
        }
        Assert.Empty(Rules("||example.com^$document"));
        Assert.Empty(Rules("@@||example.com/path^$document"));
    }

    [Fact]
    public void BatchesHoldTwoHundredSelectors()
    {
        var text = string.Join('\n', Enumerable.Range(0, 450).Select(i => $"##.ad-{i}"));
        var r = Rules(text);
        Assert.Equal(3, r.Count);
        Assert.Equal(200, Text(Action(r[0]), "selector")!.Split(',').Length);
        Assert.Equal(50, Text(Action(r[2]), "selector")!.Split(',').Length);
    }

    [Fact]
    public void OverTheLimitBlocksGoBeforeExceptions()
    {
        var text = "||a1.com^\n||a2.com^\n||a3.com^\n@@||b1.com^\n@@||b2.com^";
        var converted = FilterConverter.Convert(text, maxRules: 3);
        Assert.Equal(3, converted.RuleCount);
        Assert.Equal(2, converted.Skipped);
        var list = FilterList.Compile("t", text, maxRules: 3);
        Assert.Equal(1, list.BlockCount);
        Assert.Equal(2, list.ExceptionCount);
    }

    [Fact]
    public void RegexesAndPathsInSlashesAreSkipped()
    {
        Assert.Empty(Rules("/ads/"));
        Assert.Empty(Rules("/ads/$script"));
        Assert.Single(Rules("/ads/banner.gif"));
    }
}
