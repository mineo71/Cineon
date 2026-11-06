using System.Text.Json;
using System.Text.RegularExpressions;
using Cineon.Core.Shields;

namespace Cineon.Core.Tests.Shields;

/// <summary>
/// Checks the fast matcher against a slow one that reads the Mac's content-blocker JSON the way
/// WebKit does: every rule's regular expression tried in order, ignore-previous-rules cancelling what
/// came before it in the same list. Lists are thinned out so the slow side finishes quickly.
/// </summary>
public class ShieldReferenceTests(ITestOutputHelper output)
{
    private static readonly ResourceType[] Types =
    [
        ResourceType.Script, ResourceType.Image, ResourceType.Document, ResourceType.XmlHttpRequest, ResourceType.Fetch,
        ResourceType.Stylesheet, ResourceType.Media, ResourceType.Font, ResourceType.Websocket, ResourceType.Ping, ResourceType.Other,
    ];

    [Fact]
    public void MatcherAgreesWithTheMacRules()
    {
        var lists = SampledLists();
        var engine = ShieldEngine.Load(lists);
        var reference = lists.Select(l => ReferenceList.From(l.Text)).ToArray();

        var random = new Random(7);
        var filters = lists.SelectMany(l => FilterConverter.Parse(l.Text) is var p ? p.Blocks.Concat(p.Exceptions) : []).ToArray();
        var pages = Pages(filters);
        int blocked = 0;
        int checkedCount = 0;
        foreach (var url in Urls(filters, random))
        {
            var page = pages[random.Next(pages.Length)];
            var type = Types[random.Next(Types.Length)];
            bool mainFrame = type == ResourceType.Document && random.Next(4) == 0;
            if (mainFrame) page = null;
            var expected = reference.Any(r => r.Blocks(url, page, type, mainFrame));
            var actual = engine.Match(url, page, type, mainFrame) == Decision.Block;
            Assert.True(expected == actual, $"{url} on {page ?? "itself"} as {type}{(mainFrame ? " (main frame)" : "")}: expected {(expected ? "block" : "allow")}");
            if (actual) blocked++;
            checkedCount++;
        }
        output.WriteLine($"{checkedCount} requests checked, {blocked} blocked");
        Assert.True(blocked > checkedCount / 10, "the sample should exercise blocking");
    }

    [Fact]
    public void CssAgreesWithTheMacRules()
    {
        var lists = SampledLists();
        var engine = ShieldEngine.Load(lists);
        var reference = lists.Select(l => ReferenceList.From(l.Text)).ToArray();
        var hosts = lists
            .SelectMany(l => FilterConverter.Parse(l.Text) is var p ? p.DomainSelectors.Keys.Concat(p.UnlessSelectors.Keys).Concat(p.GenericExceptions.Values.SelectMany(d => d)) : [])
            .SelectMany(joined => joined.Split(','))
            .Distinct()
            .Order(StringComparer.Ordinal)
            .Where((_, i) => i % 7 == 0)
            .SelectMany(d => new[] { d, "www." + d })
            .Concat(["example.com", "news.site.net"])
            .ToArray();
        Assert.True(hosts.Length > 50);
        foreach (var host in hosts)
        {
            var expected = reference.SelectMany(r => r.Selectors(host)).Order(StringComparer.Ordinal).ToArray();
            var css = engine.CssFor(host);
            var actual = css.Split("{display:none !important;}\n", StringSplitOptions.RemoveEmptyEntries).Order(StringComparer.Ordinal).ToArray();
            Assert.Equal(expected, actual);
        }
    }

    /// <summary>Every list, with only some lines of the big ones, so the slow matcher stays quick.</summary>
    private static (string Name, string Text)[] SampledLists() =>
    [
        .. FilterEngine.Catalog.Select(info =>
        {
            var text = BundledLists.Text(info.Id);
            int every = info.Id switch
            {
                "easylist" or "easyprivacy" => 23,
                "ublock" => 3,
                "peterlowe" => 4,
                _ => 1,
            };
            var lines = text.Split('\n').Where((line, i) => i % every == 0 || line.StartsWith("@@", StringComparison.Ordinal) && i % 2 == 0);
            return (info.Id, string.Join('\n', lines));
        }),
    ];

    private static string?[] Pages(NetworkFilter[] filters)
    {
        var domains = filters.SelectMany(f => f.IfDomains.Concat(f.UnlessDomains)).Distinct().Order(StringComparer.Ordinal).Take(200);
        var whole = filters.Select(f => f.WholeSiteDomain).OfType<string>().Take(50);
        return
        [
            null, "https://www.example.com/watch", "https://news.site.net/a", "https://cdn.net/", "https://sub.example.co.uk/x",
            .. domains.Select(d => $"https://www.{d}/page"),
            .. whole.Select(d => $"https://{d}/"),
        ];
    }

    /// <summary>URLs made from the rules themselves, so many match, plus near misses and ordinary pages.</summary>
    private static IEnumerable<string> Urls(NetworkFilter[] filters, Random random)
    {
        string[] plain =
        [
            "https://www.example.com/", "https://www.youtube.com/watch?v=abc", "https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js",
            "https://player.example.org/embed/12345?autoplay=1", "http://example.com:8080/ads/banner.gif", "wss://socket.example.net/live",
            "https://user@host.example.com/path", "data:text/plain,ads", "about:blank", "blob:https://example.com/123",
        ];
        foreach (var url in plain) yield return url;
        string[] separators = ["/", "", "?", "=", ":", "&", "-"];
        string[] tails = ["", "/x.js", "?a=1&b=2", ".png", "/"];
        foreach (var filter in filters.Where(f => f.WholeSiteDomain is null).Where((_, i) => i % 3 == 0))
        {
            var parts = filter.Parts;
            var body = string.Concat(parts.Body.Select(c => c switch
            {
                '*' => random.Next(3) == 0 ? "" : "zq9/",
                '^' => separators[random.Next(separators.Length)],
                _ => c.ToString(),
            }));
            var prefix = parts.Anchor switch
            {
                Anchor.Host => random.Next(2) == 0 ? "https://" : "http://media.",
                Anchor.Start => "",
                _ => "https://site.example/p/",
            };
            var tail = parts.EndAnchor ? "" : tails[random.Next(tails.Length)];
            var url = prefix + body + tail;
            if (random.Next(3) == 0) url = url.ToUpperInvariant();
            yield return url;
            if (body.Length > 6)
            {
                int cut = random.Next(1, body.Length - 1);
                yield return prefix + body.Remove(cut, 1) + tail;
            }
        }
    }

    /// <summary>One list as WebKit would run it from the Mac's JSON.</summary>
    private sealed class ReferenceList
    {
        private readonly List<Rule> _rules = [];

        private sealed record Rule(
            Regex Filter, string[]? Types, string? LoadType, bool ChildFrame, string[]? IfDomains, string[]? UnlessDomains,
            string Action, string? Selector);

        public static ReferenceList From(string text)
        {
            var list = new ReferenceList();
            using var json = JsonDocument.Parse(FilterConverter.Convert(text).Json);
            foreach (var rule in json.RootElement.EnumerateArray())
            {
                var trigger = rule.GetProperty("trigger");
                var action = rule.GetProperty("action");
                bool caseSensitive = trigger.TryGetProperty("url-filter-is-case-sensitive", out var cs) && cs.GetBoolean();
                var options = RegexOptions.CultureInvariant | (caseSensitive ? RegexOptions.None : RegexOptions.IgnoreCase);
                list._rules.Add(new Rule(
                    new Regex(trigger.GetProperty("url-filter").GetString()!, options),
                    Strings(trigger, "resource-type"),
                    Strings(trigger, "load-type")?[0],
                    Strings(trigger, "load-context") is not null,
                    Strings(trigger, "if-domain")?.Select(d => d.TrimStart('*')).ToArray(),
                    Strings(trigger, "unless-domain")?.Select(d => d.TrimStart('*')).ToArray(),
                    action.GetProperty("type").GetString()!,
                    action.TryGetProperty("selector", out var selector) ? selector.GetString() : null));
            }
            return list;
        }

        private static string[]? Strings(JsonElement element, string name) =>
            element.TryGetProperty(name, out var value) ? [.. value.EnumerateArray().Select(v => v.GetString()!)] : null;

        public bool Blocks(string url, string? page, ResourceType type, bool mainFrame)
        {
            if (url.StartsWith("data:", StringComparison.OrdinalIgnoreCase)) return false;
            var documentHost = Host(page ?? url);
            var kind = WebKitType(type);
            bool childFrame = type == ResourceType.Document && !mainFrame;
            bool blocked = false;
            foreach (var rule in _rules)
            {
                if (rule.Action == "css-display-none") continue;
                if (rule.Types is not null && !rule.Types.Contains(kind)) continue;
                if (rule.ChildFrame && !childFrame) continue;
                if (rule.IfDomains is not null && !rule.IfDomains.Any(d => IsUnder(documentHost, d))) continue;
                if (rule.UnlessDomains is not null && rule.UnlessDomains.Any(d => IsUnder(documentHost, d))) continue;
                if (rule.LoadType is not null)
                {
                    var site = SiteDomain.Registrable(documentHost);
                    bool thirdParty = site.Length == 0 || !IsUnder(Host(url), site);
                    if (thirdParty != (rule.LoadType == "third-party")) continue;
                }
                if (!rule.Filter.IsMatch(url)) continue;
                blocked = rule.Action == "block";
            }
            return blocked;
        }

        public IEnumerable<string> Selectors(string host)
        {
            bool excepted = _rules.Any(r => r.Action == "ignore-previous-rules" && r.Filter.ToString() == ".*" && r.IfDomains!.Any(d => IsUnder(host, d)));
            if (excepted) return [];
            return _rules
                .Where(r => r.Selector is not null)
                .Where(r => r.IfDomains is null || r.IfDomains.Any(d => IsUnder(host, d)))
                .Where(r => r.UnlessDomains is null || !r.UnlessDomains.Any(d => IsUnder(host, d)))
                .Select(r => r.Selector!);
        }

        private static string Host(string url)
        {
            var match = Regex.Match(url.ToLowerInvariant(), @"^[a-z][a-z0-9+.-]*://(?:[^/?#@]*@)?([^/?#:]*)");
            return match.Success ? match.Groups[1].Value.TrimEnd('.') : "";
        }

        private static bool IsUnder(string host, string domain) => host == domain || host.EndsWith("." + domain, StringComparison.Ordinal);

        private static string WebKitType(ResourceType type) => type switch
        {
            ResourceType.Document => "document",
            ResourceType.Image => "image",
            ResourceType.Stylesheet => "style-sheet",
            ResourceType.Script => "script",
            ResourceType.Font => "font",
            ResourceType.Media or ResourceType.TextTrack => "media",
            ResourceType.XmlHttpRequest or ResourceType.Fetch or ResourceType.EventSource => "fetch",
            ResourceType.Websocket => "websocket",
            ResourceType.Ping or ResourceType.CspViolationReport => "ping",
            _ => "other",
        };
    }
}
