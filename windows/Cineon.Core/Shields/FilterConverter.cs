using System.Globalization;
using System.Text;

namespace Cineon.Core.Shields;

/// <summary>
/// Reads Adblock Plus syntax filter lists exactly the way the Mac's FilterConverter.swift does.
///
/// On the Mac the result is WebKit content-blocker JSON that WebKit compiles. WebView2 has nothing
/// like that, so on Windows the same parsed rules feed <see cref="FilterList"/> and
/// <see cref="ShieldEngine"/>, which match requests themselves. <see cref="Convert"/> still emits
/// the Mac's JSON, byte for byte, so both apps can be checked against each other. The rules
/// supported and skipped are the same: procedural cosmetics, scriptlets, regular expressions,
/// csp=, redirect= and other options WebKit can't express are skipped.
/// </summary>
public static class FilterConverter
{
    public readonly record struct Output(string Json, int RuleCount, int Skipped);

    /// <summary>WebKit rejects lists over 150,000 rules, so the Mac caps them, and so does Windows.</summary>
    public const int MaxRules = 145_000;

    internal const int CosmeticBatch = 200;

    /// <summary>The Mac's <c>FilterConverter.convert</c>: content-blocker JSON plus counts.</summary>
    public static Output Convert(string text, int maxRules = MaxRules)
    {
        var layout = RuleLayout.From(Parse(text), maxRules);
        var json = new StringBuilder(layout.RuleCount * 96 + 2);
        json.Append('[');
        bool first = true;
        void Separate()
        {
            if (!first) json.Append(',');
            first = false;
        }
        foreach (var rule in layout.Cosmetic)
        {
            Separate();
            AppendCosmetic(json, rule);
        }
        foreach (var rule in layout.Blocks)
        {
            Separate();
            AppendNetwork(json, rule);
        }
        foreach (var rule in layout.Exceptions)
        {
            Separate();
            AppendNetwork(json, rule);
        }
        json.Append(']');
        return new Output(json.ToString(), layout.RuleCount, layout.Skipped);
    }

    // MARK: Parsing

    internal static ParsedList Parse(string text)
    {
        var list = new ParsedList();
        foreach (var range in Lines(text))
        {
            var line = TrimWhitespace(text.AsSpan(range));
            if (line.IsEmpty || line[0] == '!' || line[0] == '[') continue;
            var lineText = line.ToString();

            var cosmetic = ParseCosmetic(lineText, out var domains, out var selector);
            if (cosmetic != CosmeticKind.NotCosmetic)
            {
                switch (cosmetic)
                {
                    case CosmeticKind.Skip:
                        list.Skipped++;
                        break;
                    case CosmeticKind.Generic:
                        list.GenericSelectors.Add(selector!);
                        break;
                    case CosmeticKind.Only:
                        Group(list.DomainSelectors, string.Join(',', domains!)).Add(selector!);
                        break;
                    case CosmeticKind.Except:
                        Group(list.UnlessSelectors, string.Join(',', domains!)).Add(selector!);
                        break;
                    case CosmeticKind.Exception:
                        if (!list.GenericExceptions.TryGetValue(selector!, out var existing))
                        {
                            existing = [];
                            list.GenericExceptions[selector!] = existing;
                        }
                        existing.AddRange(domains!);
                        break;
                }
                continue;
            }

            var network = ParseNetwork(lineText);
            if (network is null)
            {
                list.Skipped++;
                continue;
            }
            if (network.IsException) list.Exceptions.Add(network);
            else list.Blocks.Add(network);
        }
        return list;
    }

    private static List<string> Group(OrderedDictionary<string, List<string>> groups, string key)
    {
        if (!groups.TryGetValue(key, out var selectors))
        {
            selectors = [];
            groups.Add(key, selectors);
        }
        return selectors;
    }

    /// <summary>Line breaks as Foundation's enumerateLines sees them.</summary>
    private static IEnumerable<Range> Lines(string text)
    {
        int start = 0;
        int i = 0;
        while (i < text.Length)
        {
            char c = text[i];
            if (c is '\n' or '\r' or '\u0085' or '\u2028' or '\u2029')
            {
                yield return new Range(start, i);
                if (c == '\r' && i + 1 < text.Length && text[i + 1] == '\n') i++;
                start = i + 1;
            }
            i++;
        }
        if (start < text.Length) yield return new Range(start, text.Length);
    }

    /// <summary>Swift's <c>.whitespaces</c>: tabs and Unicode space separators.</summary>
    private static bool IsWhitespace(char c) =>
        c == '\t' || char.GetUnicodeCategory(c) == UnicodeCategory.SpaceSeparator;

    private static ReadOnlySpan<char> TrimWhitespace(ReadOnlySpan<char> s)
    {
        int start = 0;
        int end = s.Length;
        while (start < end && IsWhitespace(s[start])) start++;
        while (end > start && IsWhitespace(s[end - 1])) end--;
        return s[start..end];
    }

    private static string TrimWhitespace(string s) => TrimWhitespace(s.AsSpan()).ToString();

    // MARK: Cosmetic filters

    internal enum CosmeticKind
    {
        NotCosmetic,
        Skip,
        Generic,
        Only,
        Except,
        Exception,
    }

    private static readonly string[] ProceduralMarkers =
    [
        ":-abp-", ":has-text", ":contains(", ":xpath", ":style(", ":upward", ":remove(", ":matches-",
        ":min-text-length", ":watch-attr", ":if(", ":if-not", ":nth-ancestor", ":others(", ":-ext-", ":remove-attr",
        ":remove-class", ":matches-path", ":matches-css", ":matches-attr", ":matches-prop",
    ];

    private static readonly string[] AdvancedMarkers = ["#?#", "#$#", "#%#", "#@?#", "#@$#", "##+js", "##^", "$$", "#@%#"];

    internal static CosmeticKind ParseCosmetic(string line, out List<string>? domains, out string? selector)
    {
        domains = null;
        selector = null;
        // Advanced syntaxes have no WebKit equivalent.
        foreach (var marker in AdvancedMarkers)
        {
            if (!line.Contains(marker, StringComparison.Ordinal)) continue;
            if (marker == "$$" && !line.Contains("##", StringComparison.Ordinal)) continue;
            return CosmeticKind.Skip;
        }
        int exception = line.IndexOf("#@#", StringComparison.Ordinal);
        if (exception >= 0)
        {
            var only = ParseCosmeticDomains(line[..exception], out _, out _);
            var exceptionSelector = line[(exception + 3)..];
            if (!IsUsableSelector(exceptionSelector) || only.Count == 0) return CosmeticKind.Skip;
            domains = only;
            selector = exceptionSelector;
            return CosmeticKind.Exception;
        }
        int hide = line.IndexOf("##", StringComparison.Ordinal);
        if (hide < 0) return CosmeticKind.NotCosmetic;

        var hideSelector = TrimWhitespace(line[(hide + 2)..]);
        if (!IsUsableSelector(hideSelector)) return CosmeticKind.Skip;
        selector = hideSelector;

        var prefix = line[..hide];
        if (prefix.Length == 0) return CosmeticKind.Generic;

        var onlyDomains = ParseCosmeticDomains(prefix, out var exceptDomains, out bool invalid);
        if (invalid) return CosmeticKind.Skip;
        if (onlyDomains.Count > 0)
        {
            domains = onlyDomains;
            return CosmeticKind.Only;
        }
        if (exceptDomains.Count > 0)
        {
            domains = exceptDomains;
            return CosmeticKind.Except;
        }
        return CosmeticKind.Skip;
    }

    private static List<string> ParseCosmeticDomains(string text, out List<string> except, out bool invalid)
    {
        var only = new List<string>();
        except = [];
        invalid = false;
        foreach (var part in text.Split(',', StringSplitOptions.RemoveEmptyEntries))
        {
            bool negated = part.StartsWith('~');
            var name = (negated ? part[1..] : part).ToLowerInvariant();
            if (!IsPlainDomain(name))
            {
                except = [];
                invalid = true;
                return [];
            }
            if (negated) except.Add(name);
            else only.Add(name);
        }
        return only;
    }

    private static bool IsUsableSelector(string selector)
    {
        if (selector.Length == 0) return false;
        foreach (char c in selector)
        {
            if (c < 32 || c >= 128) return false;
        }
        foreach (var marker in ProceduralMarkers)
        {
            if (selector.Contains(marker, StringComparison.Ordinal)) return false;
        }
        return true;
    }

    // MARK: Network filters

    internal static NetworkFilter? ParseNetwork(string raw)
    {
        var line = raw;
        bool isException = line.StartsWith("@@", StringComparison.Ordinal);
        if (isException) line = line[2..];

        // Regular expression rules rarely fit WebKit's subset, and they are few. Skip them.
        if (line.StartsWith('/') && (line.EndsWith('/') || line.Contains("/$", StringComparison.Ordinal))) return null;

        string[] options = [];
        int dollar = line.LastIndexOf('$');
        if (dollar >= 0 && dollar + 1 < line.Length && line.IndexOf('/', dollar + 1) < 0)
        {
            options = line[(dollar + 1)..].Split(',', StringSplitOptions.RemoveEmptyEntries);
            line = line[..dollar];
        }

        string? loadType = null;
        var ifDomains = new List<string>();
        var unlessDomains = new List<string>();
        var types = new List<string>();
        var excludedTypes = new HashSet<string>(StringComparer.Ordinal);
        bool caseSensitive = false;
        bool childFrameOnly = false;
        bool wholeSite = false;

        foreach (var option in options)
        {
            var lower = option.ToLowerInvariant();
            switch (lower)
            {
                case "third-party" or "3p": loadType = "third-party"; break;
                case "~third-party" or "first-party" or "1p" or "~3p": loadType = "first-party"; break;
                case "script": types.Add("script"); break;
                case "image": types.Add("image"); break;
                case "stylesheet" or "css": types.Add("style-sheet"); break;
                case "font": types.Add("font"); break;
                case "media": types.Add("media"); break;
                case "xmlhttprequest" or "xhr": types.Add("fetch"); break;
                case "websocket": types.Add("websocket"); break;
                case "other": types.Add("other"); break;
                case "ping": types.Add("ping"); break;
                case "subdocument" or "frame":
                    types.Add("document");
                    childFrameOnly = true;
                    break;
                case "~script": excludedTypes.Add("script"); break;
                case "~image": excludedTypes.Add("image"); break;
                case "~stylesheet": excludedTypes.Add("style-sheet"); break;
                case "~font": excludedTypes.Add("font"); break;
                case "~media": excludedTypes.Add("media"); break;
                case "~xmlhttprequest": excludedTypes.Add("fetch"); break;
                case "~subdocument": excludedTypes.Add("document"); break;
                case "match-case": caseSensitive = true; break;
                case "important" or "all" or "first-party-only": break;
                case "document" or "doc" or "elemhide" or "ehide" or "generichide" or "ghide":
                    if (!isException) return null;
                    wholeSite = true;
                    break;
                case "popup" or "popunder":
                    // Handled by the pop-up shield, which sees the real target before it opens.
                    return null;
                default:
                    if (lower.StartsWith("domain=", StringComparison.Ordinal) || lower.StartsWith("from=", StringComparison.Ordinal))
                    {
                        var domainList = option[(option.IndexOf('=') + 1)..];
                        foreach (var part in domainList.Split('|', StringSplitOptions.RemoveEmptyEntries))
                        {
                            bool negated = part.StartsWith('~');
                            var name = (negated ? part[1..] : part).ToLowerInvariant();
                            if (!IsPlainDomain(name)) return null;
                            if (negated) unlessDomains.Add(name);
                            else ifDomains.Add(name);
                        }
                    }
                    else
                    {
                        // csp=, redirect=, removeparam=, badfilter and so on have no equivalent.
                        return null;
                    }
                    break;
            }
        }

        // WebKit allows if-domain or unless-domain on a rule, never both.
        if (ifDomains.Count > 0 && unlessDomains.Count > 0) unlessDomains.Clear();

        if (excludedTypes.Count > 0)
        {
            types = KitTypes.AllNames.Where(t => !excludedTypes.Contains(t)).ToList();
        }

        // Whole-site exceptions: "@@||example.com^$document" turns everything off for that site.
        if (wholeSite)
        {
            var domain = HostAnchoredDomain(line);
            if (domain is null) return null;
            return new NetworkFilter
            {
                Text = raw,
                IsException = true,
                WholeSiteDomain = domain,
                Pattern = line,
            };
        }

        if (!(line.Length >= 4 || line.StartsWith("||", StringComparison.Ordinal))) return null;
        if (!TrySplitPattern(line, out var parts)) return null;

        return new NetworkFilter
        {
            Text = raw,
            IsException = isException,
            Pattern = line,
            Parts = parts,
            CaseSensitive = caseSensitive,
            Types = [.. types],
            LoadType = loadType,
            ChildFrameOnly = childFrameOnly,
            IfDomains = [.. ifDomains],
            UnlessDomains = [.. unlessDomains],
        };
    }

    /// <summary>"||example.com^" gives "example.com". Anything with a path is not a whole-site rule.</summary>
    private static string? HostAnchoredDomain(string pattern)
    {
        if (!pattern.StartsWith("||", StringComparison.Ordinal)) return null;
        var rest = pattern[2..];
        if (rest.EndsWith('^')) rest = rest[..^1];
        var lower = rest.ToLowerInvariant();
        return IsPlainDomain(lower) ? lower : null;
    }

    /// <summary>
    /// Splits an ABP pattern the way the Mac's <c>urlFilter(from:)</c> reads it: the anchors, then a
    /// body where <c>*</c> is any run of characters, <c>^</c> is one optional separator and
    /// everything else is literal. False for patterns the Mac rejects.
    /// </summary>
    internal static bool TrySplitPattern(string pattern, out PatternParts parts)
    {
        parts = default;
        foreach (char c in pattern)
        {
            if (c < 32 || c >= 128) return false;
        }
        var p = pattern.AsSpan();
        var anchor = Anchor.None;
        bool end = false;
        if (p.StartsWith("||"))
        {
            p = p[2..];
            anchor = Anchor.Host;
        }
        else if (p.StartsWith("|"))
        {
            p = p[1..];
            anchor = Anchor.Start;
        }
        if (p.EndsWith("|"))
        {
            p = p[..^1];
            end = true;
        }
        while (p.StartsWith("*")) p = p[1..];
        while (p.EndsWith("*")) p = p[..^1];
        if (p.IsEmpty) return false;

        // A pattern this short, with no anchor, would match half the web.
        int literalLength = 0;
        foreach (char c in p)
        {
            if (c != '*' && c != '^') literalLength++;
        }
        if (literalLength < 3) return false;

        parts = new PatternParts(anchor, p.ToString(), end);
        return true;
    }

    /// <summary>Translates an ABP pattern to the regular expression subset WebKit accepts.</summary>
    public static string? UrlFilter(string pattern)
    {
        if (!TrySplitPattern(pattern, out var parts)) return null;
        var out_ = new StringBuilder();
        out_.Append(parts.Anchor switch
        {
            Anchor.Host => "^[^:]+://+([^:/]+\\.)?",
            Anchor.Start => "^",
            _ => "",
        });
        bool previousWasWildcard = false;
        foreach (char c in parts.Body)
        {
            switch (c)
            {
                case '*':
                    if (!previousWasWildcard) out_.Append(".*");
                    previousWasWildcard = true;
                    continue;
                case '^':
                    out_.Append("[/:&?=]?");
                    break;
                case '.' or '?' or '+' or '(' or ')' or '[' or ']' or '{' or '}' or '|' or '\\' or '$':
                    out_.Append('\\').Append(c);
                    break;
                default:
                    out_.Append(c);
                    break;
            }
            previousWasWildcard = false;
        }
        if (parts.EndAnchor) out_.Append('$');
        return out_.ToString();
    }

    internal static bool IsPlainDomain(string s)
    {
        if (s.Length == 0 || !(s.Contains('.') || s.Length > 1)) return false;
        foreach (char c in s)
        {
            if (!(c is >= 'a' and <= 'z' or >= '0' and <= '9' or '-' or '.')) return false;
        }
        return !s.StartsWith('.') && !s.EndsWith('.');
    }

    // MARK: JSON

    private static void AppendCosmetic(StringBuilder json, CosmeticRule rule)
    {
        json.Append("{\"trigger\":{\"url-filter\":\".*\"");
        if (rule.IfDomains is { } only) json.Append(",\"if-domain\":").Append(DomainArray(only));
        if (rule.UnlessDomains is { } unless) json.Append(",\"unless-domain\":").Append(DomainArray(unless));
        json.Append("},\"action\":{\"type\":\"css-display-none\",\"selector\":").Append(JsonString(rule.Selector)).Append("}}");
    }

    private static void AppendNetwork(StringBuilder json, NetworkFilter rule)
    {
        if (rule.WholeSiteDomain is { } domain)
        {
            json.Append("{\"trigger\":{\"url-filter\":\".*\",\"if-domain\":").Append(DomainArray([domain]))
                .Append("},\"action\":{\"type\":\"ignore-previous-rules\"}}");
            return;
        }
        json.Append("{\"trigger\":{\"url-filter\":").Append(JsonString(UrlFilter(rule.Pattern)!));
        if (rule.CaseSensitive) json.Append(",\"url-filter-is-case-sensitive\":true");
        if (rule.Types.Length > 0) json.Append(",\"resource-type\":").Append(JsonArray(rule.Types));
        if (rule.LoadType is { } loadType) json.Append(",\"load-type\":[\"").Append(loadType).Append("\"]");
        if (rule.ChildFrameOnly) json.Append(",\"load-context\":[\"child-frame\"]");
        if (rule.IfDomains.Length > 0) json.Append(",\"if-domain\":").Append(DomainArray(rule.IfDomains));
        if (rule.UnlessDomains.Length > 0) json.Append(",\"unless-domain\":").Append(DomainArray(rule.UnlessDomains));
        json.Append("},\"action\":{\"type\":\"").Append(rule.IsException ? "ignore-previous-rules" : "block").Append("\"}}");
    }

    private static string DomainArray(IEnumerable<string> domains) => JsonArray(domains.Select(d => "*" + d));

    private static string JsonArray(IEnumerable<string> items) => "[" + string.Join(',', items.Select(JsonString)) + "]";

    internal static string JsonString(string s)
    {
        var out_ = new StringBuilder(s.Length + 2);
        out_.Append('"');
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': out_.Append("\\\""); break;
                case '\\': out_.Append("\\\\"); break;
                case '\n': out_.Append("\\n"); break;
                case '\r': out_.Append("\\r"); break;
                case '\t': out_.Append("\\t"); break;
                default:
                    if (c < 0x20) out_.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else out_.Append(c);
                    break;
            }
        }
        return out_.Append('"').ToString();
    }
}

internal enum Anchor : byte
{
    None,
    /// <summary><c>|</c>: the start of the URL.</summary>
    Start,
    /// <summary><c>||</c>: the start of the host or of any label in it.</summary>
    Host,
}

/// <summary>A pattern as the Mac reads it. See <see cref="FilterConverter.TrySplitPattern"/>.</summary>
internal readonly record struct PatternParts(Anchor Anchor, string Body, bool EndAnchor);

/// <summary>One network rule, with the same fields as the WebKit trigger the Mac emits.</summary>
internal sealed class NetworkFilter
{
    public required string Text { get; init; }
    public bool IsException { get; init; }
    /// <summary>Set for whole-site exceptions: everything on this site and its subdomains is allowed.</summary>
    public string? WholeSiteDomain { get; init; }
    public string Pattern { get; init; } = "";
    public PatternParts Parts { get; init; }
    public bool CaseSensitive { get; init; }
    /// <summary>WebKit resource types; empty means all.</summary>
    public string[] Types { get; init; } = [];
    /// <summary>"third-party", "first-party" or null for both.</summary>
    public string? LoadType { get; init; }
    public bool ChildFrameOnly { get; init; }
    public string[] IfDomains { get; init; } = [];
    public string[] UnlessDomains { get; init; } = [];
}

/// <summary>A css-display-none rule. The selector may be up to 200 selectors joined by commas.</summary>
internal sealed record CosmeticRule(string Selector, string[]? IfDomains, string[]? UnlessDomains);

/// <summary>A list as parsed, before it's laid out into rules.</summary>
internal sealed class ParsedList
{
    public List<string> GenericSelectors { get; } = [];
    public Dictionary<string, List<string>> GenericExceptions { get; } = new(StringComparer.Ordinal);
    /// <summary>Domains joined by "," to selectors.</summary>
    public OrderedDictionary<string, List<string>> DomainSelectors { get; } = new(StringComparer.Ordinal);
    public OrderedDictionary<string, List<string>> UnlessSelectors { get; } = new(StringComparer.Ordinal);
    public List<NetworkFilter> Blocks { get; } = [];
    public List<NetworkFilter> Exceptions { get; } = [];
    public int Skipped { get; set; }
}

/// <summary>
/// The Mac's rule array: cosmetic rules, then blocks, then exceptions last, capped at the maximum
/// the same way. Both the JSON and the Windows matcher are built from this, so their counts agree.
/// </summary>
internal sealed class RuleLayout
{
    public required List<CosmeticRule> Cosmetic { get; init; }
    public required List<NetworkFilter> Blocks { get; init; }
    public required List<NetworkFilter> Exceptions { get; init; }
    public int Skipped { get; init; }
    public int RuleCount => Cosmetic.Count + Blocks.Count + Exceptions.Count;

    public static RuleLayout From(ParsedList parsed, int maxRules)
    {
        var cosmetic = new List<CosmeticRule>();

        // Generic cosmetic rules first, batched: one combined stylesheet rule per 200 selectors.
        var plainGeneric = new List<string>();
        foreach (var selector in parsed.GenericSelectors)
        {
            if (parsed.GenericExceptions.TryGetValue(selector, out var domains) && domains.Count > 0)
                cosmetic.Add(new CosmeticRule(selector, null, [.. domains]));
            else
                plainGeneric.Add(selector);
        }
        foreach (var batch in plainGeneric.Chunk(FilterConverter.CosmeticBatch))
            cosmetic.Add(new CosmeticRule(string.Join(',', batch), null, null));

        foreach (var (joined, selectors) in parsed.DomainSelectors)
        {
            var domains = joined.Split(',', StringSplitOptions.RemoveEmptyEntries);
            foreach (var batch in selectors.Chunk(FilterConverter.CosmeticBatch))
                cosmetic.Add(new CosmeticRule(string.Join(',', batch), domains, null));
        }
        foreach (var (joined, selectors) in parsed.UnlessSelectors)
        {
            var domains = joined.Split(',', StringSplitOptions.RemoveEmptyEntries);
            foreach (var batch in selectors.Chunk(FilterConverter.CosmeticBatch))
                cosmetic.Add(new CosmeticRule(string.Join(',', batch), null, domains));
        }

        var blocks = parsed.Blocks;
        var exceptions = parsed.Exceptions;
        int skipped = parsed.Skipped;
        int total = cosmetic.Count + blocks.Count + exceptions.Count;
        if (total > maxRules)
        {
            // Keep exceptions: dropping them would break sites rather than just miss an ad.
            int keepFromStart = Math.Max(0, maxRules - exceptions.Count);
            skipped += total - maxRules;
            int keepCosmetic = Math.Min(cosmetic.Count, keepFromStart);
            int keepBlocks = Math.Min(blocks.Count, keepFromStart - keepCosmetic);
            cosmetic = cosmetic.GetRange(0, keepCosmetic);
            blocks = blocks.GetRange(0, keepBlocks);
            exceptions = exceptions.GetRange(0, Math.Min(exceptions.Count, maxRules));
        }
        return new RuleLayout { Cosmetic = cosmetic, Blocks = blocks, Exceptions = exceptions, Skipped = skipped };
    }
}
