using System.Globalization;
using System.Text;
using System.Text.Json;
using Cineon.Core.Data;
using Cineon.Core.Metadata;
using Cineon.Core.Parsing;

namespace Cineon.Core.Tests.Parsing.MacParity;

/// <summary>
/// The C# side of ParsingDump.swift: the same line for every case in corpus.jsonl. Changing one means
/// changing the other.
/// </summary>
internal static class ParsingDump
{
    public static string Esc(string? s)
    {
        if (s is null) return "nil";
        var sb = new StringBuilder("\"");
        foreach (var rune in s.EnumerateRunes())
        {
            var v = rune.Value;
            if (v == '\\') sb.Append(@"\\");
            else if (v == '"') sb.Append("\\\"");
            else if (v < 0x20 || v is >= 0x7f and <= 0x9f || v is 0x2028 or 0x2029) sb.Append("\\u{").Append(v.ToString("x", CultureInfo.InvariantCulture)).Append('}');
            else sb.Append(rune.ToString());
        }
        return sb.Append('"').ToString();
    }

    private static string Num(int? i) => i?.ToString(CultureInfo.InvariantCulture) ?? "nil";
    private static string Dbl(double d) => d.ToString("F6", CultureInfo.InvariantCulture);
    private static string Ref(EpisodeRef? r) => r is { } x ? $"{x.Season}:{x.Episode}" : "nil";
    private static string Url(Uri? u) => Esc(u?.OriginalString);
    private static string Bool(bool b) => b ? "true" : "false";
    private static string Date(DateTimeOffset? d) => d is { } x ? (x.ToUnixTimeMilliseconds() / 1000.0).ToString("F3", CultureInfo.InvariantCulture) : "nil";
    private static string Kind(TitleKind k) => k.ToRaw();

    private static string? Str(JsonElement o, string key) =>
        o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static int? Int(JsonElement o, string key) =>
        o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : null;

    private static List<string> Strings(JsonElement o, string key) => [.. o.GetProperty(key).EnumerateArray().Select(e => e.GetString()!)];

    private static string Parsed(ParsedTitle? p) => p is null
        ? "nil"
        : string.Join(" | ", Esc(p.Name), Esc(p.AltName), Num(p.Year), Ref(p.Ref), Esc(p.EpisodeName), Kind(p.KindHint), Url(p.PosterUrl),
            Esc(p.Overview), Dbl(p.Confidence));

    private static string Match(RescueMatch? m) => m is null
        ? "nil"
        : string.Join(" | ", Url(m.Link.Url), Dbl(m.Score), Bool(m.YearConfirmed), Bool(m.IsStrong));

    private static RescueLink Link(JsonElement o) => new(new Uri(Str(o, "url")!), Str(o, "text")!, Str(o, "context")!);

    public static string Line(JsonElement o)
    {
        var t = Str(o, "t");
        switch (t)
        {
            case "parse":
            {
                var meta = new PageMeta
                {
                    Url = Str(o, "url") ?? "",
                    Title = Str(o, "title") ?? "",
                    OgSite = Str(o, "site"),
                    OgTitle = Str(o, "og"),
                    H1 = Str(o, "h1"),
                    TwitterTitle = Str(o, "tw"),
                    OgType = Str(o, "ogType"),
                    OgImage = Str(o, "ogImage"),
                    OgDescription = Str(o, "ogDescription"),
                    Ld = o.TryGetProperty("ld", out var ld)
                        ? [.. ld.EnumerateArray().Select(l => new PageMeta.LinkedData
                        {
                            Type = Str(l, "type"), Name = Str(l, "name"), Series = Str(l, "series"), Season = Int(l, "season"),
                            Episode = Int(l, "episode"), Year = Int(l, "year"), Image = Str(l, "image"), Description = Str(l, "description"),
                        })]
                        : [],
                };
                return Parsed(TitleParser.Parse(meta));
            }
            case "clean":
                return Parsed(TitleParser.Clean(Str(o, "text")!, Strings(o, "tokens").ToHashSet()));
            case "ref":
                return Ref(TitleParser.EpisodeRefIn(Str(o, "text")!));
            case "kind":
                return Kind(TitleParser.KindHint(Str(o, "text")!));
            case "tokens":
            {
                var text = Str(o, "text")!;
                return string.Join(" ", RescueMatcher.Tokens(text).Select(Esc)) + " | "
                    + string.Join(" ", RescueMatcher.Years(text).Select(y => y.ToString(CultureInfo.InvariantCulture)));
            }
            case "score":
            {
                var m = RescueMatcher.Score(Link(o), Strings(o, "names"), Int(o, "year"));
                return string.Join(" | ", Dbl(m.Score), Bool(m.YearConfirmed), Bool(m.IsStrong));
            }
            case "best":
            {
                var links = o.GetProperty("links").EnumerateArray().Select(Link).ToList();
                return Match(RescueMatcher.Best(links, Strings(o, "names"), Int(o, "year"), Str(o, "page") is { } page ? new Uri(page) : null));
            }
            case "brand":
            {
                var host = Str(o, "host")!;
                return Esc(SiteBrand.Of(host)) + " | " + Esc(SkipLearner.SiteKey(host));
            }
            case "mirrors":
                return string.Join(" ", RescueMatcher.Mirrors(new Uri(Str(o, "url")!), Strings(o, "hosts")).Select(Url));
            case "links":
            {
                var current = o.GetProperty("current").EnumerateArray().Select(e => e.GetInt32()).ToArray();
                var target = o.GetProperty("target").EnumerateArray().Select(e => e.GetInt32()).ToArray();
                return Url(EpisodeLinks.Url(new Uri(Str(o, "url")!), new EpisodeRef(current[0], current[1]), new EpisodeRef(target[0], target[1])));
            }
            case "match":
            {
                var hits = o.GetProperty("hits").EnumerateArray()
                    .Select(h => new MetadataHit(Str(h, "id")!, Str(h, "name")!, Int(h, "year"), TitleKind.FromRaw(Str(h, "kind"))!.Value, Rank: Int(h, "rank")))
                    .ToList();
                return Esc(MetadataClient.BestMatch(hits, Str(o, "name")!, Int(o, "year"), TitleKind.FromRaw(Str(o, "kind"))!.Value)?.Id);
            }
            case "poster":
                return Url(MetadataClient.ResizedPoster(Str(o, "raw"), 500));
            case "searchurl":
                return Url(MetadataClient.SearchUrl(Str(o, "query")!));
            case "search":
            {
                var hits = MetadataClient.ParseSearch(Encoding.UTF8.GetBytes(Str(o, "body")!));
                return "[" + string.Join(" ; ", hits.Select(h =>
                    string.Join(" | ", Esc(h.Id), Esc(h.Name), Num(h.Year), Kind(h.Kind), Url(h.PosterUrl), Esc(h.Subtitle), Num(h.Rank)))) + "]";
            }
            case "detail":
            {
                if (MetadataClient.ParseDetail(Encoding.UTF8.GetBytes(Str(o, "body")!)) is not { } detail) return "nil";
                var episodes = detail.Episodes.Select(e => string.Join(" , ",
                    e.Season.ToString(CultureInfo.InvariantCulture), e.Episode.ToString(CultureInfo.InvariantCulture), Esc(e.Name),
                    Esc(e.Overview), Url(e.ThumbnailUrl), Date(e.Released)));
                return string.Join(" | ", Esc(detail.Overview), string.Join(" ", detail.Genres.Select(Esc)), Num(detail.RuntimeMinutes),
                    Url(detail.PosterUrl), Url(detail.BackdropUrl), Num(detail.Year), "[" + string.Join(" ; ", episodes) + "]");
            }
            case "date":
                return Date(MetadataClient.ParseDate(Str(o, "text")!));
            case "url":
            {
                if (SwiftUrl.Parse(Str(o, "text")) is not { } u) return "nil";
                return string.Join(" | ", Esc(u.AbsoluteString), Esc(u.Scheme), Esc(u.Host), Esc(u.Path), Esc(u.LastPathComponentWithoutExtension));
            }
            case "preview":
            {
                var (poster, overview) = PagePreview.Parse(Str(o, "html")!, new Uri(Str(o, "base")!));
                return Url(poster) + " | " + Esc(overview);
            }
            default:
                throw new InvalidOperationException($"Unknown case {t}");
        }
    }

    /// <summary>Every case in the corpus, as "index type: output".</summary>
    public static List<string> Run(string corpusPath)
    {
        var lines = new List<string>();
        var index = 0;
        foreach (var raw in File.ReadLines(corpusPath))
        {
            if (raw.Length == 0) continue;
            using var doc = JsonDocument.Parse(raw);
            lines.Add($"{index} {Str(doc.RootElement, "t")}: {Line(doc.RootElement)}");
            index++;
        }
        return lines;
    }
}
