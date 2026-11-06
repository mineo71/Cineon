using System.Diagnostics;
using Cineon.Core.Shields;

namespace Cineon.Core.Tests.Shields;

/// <summary>
/// Match runs inside WebView2's WebResourceRequested for every request, so it has to be quick. Loads
/// every bundled list and times 10,000 lookups of the kind a streaming page makes.
/// </summary>
public class ShieldBenchmarkTests(ITestOutputHelper output)
{
    private const int Lookups = 10_000;

    [Fact]
    public void LookupsWithAllBundledListsAreFast()
    {
        var load = Stopwatch.StartNew();
        var engine = ShieldEngine.Load(FilterEngine.Catalog.Select(info => (info.Id, BundledLists.Text(info.Id))));
        load.Stop();

        var requests = Requests(new Random(42)).Take(Lookups).ToArray();
        // One pass first, so the timed one runs fully optimised code, as a long-running app would.
        foreach (var (url, page, type) in requests) engine.Match(url, page, type);

        int blocked = 0;
        var timer = Stopwatch.StartNew();
        foreach (var (url, page, type) in requests)
        {
            if (engine.Match(url, page, type) == Decision.Block) blocked++;
        }
        timer.Stop();

        double perLookup = timer.Elapsed.TotalMicroseconds / requests.Length;
        output.WriteLine($"{engine.TotalRules} rules loaded and indexed in {load.ElapsedMilliseconds} ms");
        output.WriteLine($"{requests.Length} lookups in {timer.Elapsed.TotalMilliseconds:F1} ms: {perLookup:F2} µs each, {blocked} blocked");

        var css = Stopwatch.StartNew();
        int length = engine.CssFor("www.example.com").Length;
        css.Stop();
        output.WriteLine($"CssFor built {length / 1024} KB of CSS in {css.Elapsed.TotalMilliseconds:F1} ms");

        Assert.True(blocked > Lookups / 20, "the sample should include ads");
        // Typically a few microseconds. The bound is loose so slow CI machines don't fail it.
        Assert.True(perLookup < 50, $"{perLookup:F2} µs per lookup");
    }

    private static readonly string[] Sites =
    [
        "www.imdb.com", "www.youtube.com", "streaming.example.to", "filmix.example.ua", "news.bbc.co.uk",
        "www.reddit.com", "player.vimeo.com", "github.com", "en.wikipedia.org", "rezka.example.ag",
    ];

    private static readonly string[] Ordinary =
    [
        "https://{site}/", "https://{site}/watch?v={id}", "https://static.{site}/assets/app.{id}.js",
        "https://{site}/api/v2/titles/{id}?lang=en&include=seasons,episodes", "https://img.{site}/posters/w342/{id}.jpg",
        "https://fonts.gstatic.com/s/inter/v12/{id}.woff2", "https://cdn.jsdelivr.net/npm/hls.js@1.5.{n}/dist/hls.min.js",
        "https://{site}/hls/{id}/seg-{n}-v1-a1.ts", "https://{site}/hls/{id}/index.m3u8?token={id}&expires={n}",
        "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js", "https://{site}/static/css/main.{id}.css",
        "https://ajax.googleapis.com/ajax/libs/jquery/3.7.{n}/jquery.min.js",
    ];

    private static readonly string[] Ads =
    [
        "https://securepubads.g.doubleclick.net/tag/js/gpt.js", "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-{n}",
        "https://www.google-analytics.com/g/collect?v=2&tid=G-{id}&cid={n}", "https://c1.popads.net/pop.js",
        "https://a.exosrv.com/ad-provider.js", "https://www.googletagmanager.com/gtm.js?id=GTM-{id}",
        "https://connect.facebook.net/en_US/fbevents.js", "https://{site}/ads/banner_728x90_{n}.gif",
        "https://bat.bing.com/action/0?ti={n}&Ver=2", "https://s.yimg.com/wi/ytc.js",
    ];

    private static readonly ResourceType[] Types =
        [ResourceType.Script, ResourceType.Image, ResourceType.XmlHttpRequest, ResourceType.Stylesheet, ResourceType.Media, ResourceType.Font];

    private static IEnumerable<(string Url, string Page, ResourceType Type)> Requests(Random random)
    {
        while (true)
        {
            var site = Sites[random.Next(Sites.Length)];
            var templates = random.Next(4) == 0 ? Ads : Ordinary;
            var url = templates[random.Next(templates.Length)]
                .Replace("{site}", site)
                .Replace("{id}", random.Next().ToString("x8"))
                .Replace("{n}", random.Next(1000).ToString());
            yield return (url, $"https://{site}/watch/{random.Next(100000)}", Types[random.Next(Types.Length)]);
        }
    }
}
