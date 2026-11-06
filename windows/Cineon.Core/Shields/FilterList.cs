using System.Text;

namespace Cineon.Core.Shields;

/// <summary>
/// One filter list, parsed and ready to match: the Windows counterpart of a compiled
/// <c>WKContentRuleList</c>. Immutable, so it can be shared between threads and engines.
/// </summary>
public sealed class FilterList
{
    /// <summary>The catalog id, such as "easylist".</summary>
    public string Id { get; }

    /// <summary>How many rules the Mac compiles for this list: what Settings shows.</summary>
    public int RuleCount { get; }

    /// <summary>Lines that were skipped because there's no equivalent.</summary>
    public int Skipped { get; }

    public int BlockCount => Blocks.Length;
    public int ExceptionCount => Exceptions.Length + WholeSiteDomains.Length;
    public int CosmeticCount { get; }

    internal CompiledRule[] Blocks { get; }
    internal CompiledRule[] Exceptions { get; }
    /// <summary>Whole-site exceptions ("@@||site^$document" and friends): sites this list leaves alone.</summary>
    internal string[] WholeSiteDomains { get; }

    /// <summary>Generic css-display-none rules, already written out as a stylesheet.</summary>
    internal string UniversalCss { get; }
    internal CosmeticRule[] IfDomainRules { get; }
    internal CosmeticRule[] UnlessDomainRules { get; }

    private FilterList(string id, RuleLayout layout)
    {
        Id = id;
        RuleCount = layout.RuleCount;
        Skipped = layout.Skipped;
        CosmeticCount = layout.Cosmetic.Count;

        Blocks = [.. layout.Blocks.Select(CompiledRule.From)];
        Exceptions = [.. layout.Exceptions.Where(r => r.WholeSiteDomain is null).Select(CompiledRule.From)];
        WholeSiteDomains = [.. layout.Exceptions.Select(r => r.WholeSiteDomain).OfType<string>()];

        var universal = new StringBuilder();
        var ifRules = new List<CosmeticRule>();
        var unlessRules = new List<CosmeticRule>();
        foreach (var rule in layout.Cosmetic)
        {
            if (rule.IfDomains is not null) ifRules.Add(rule);
            else if (rule.UnlessDomains is not null) unlessRules.Add(rule);
            else AppendCss(universal, rule.Selector);
        }
        UniversalCss = universal.ToString();
        IfDomainRules = [.. ifRules];
        UnlessDomainRules = [.. unlessRules];
    }

    /// <summary>Parses a list's text, with the same rules and limits as the Mac.</summary>
    public static FilterList Compile(string id, string text, int maxRules = FilterConverter.MaxRules) =>
        new(id, RuleLayout.From(FilterConverter.Parse(text), maxRules));

    /// <summary>WebKit's content-blocker stylesheet rule.</summary>
    internal static void AppendCss(StringBuilder css, string selector) =>
        css.Append(selector).Append("{display:none !important;}\n");
}

/// <summary>A network rule prepared for fast matching.</summary>
internal sealed class CompiledRule
{
    public Anchor Anchor { get; init; }
    public bool End { get; init; }
    /// <summary>The pattern body, lowercase unless the rule is case-sensitive. '*' is any run, '^' an optional separator.</summary>
    public required string Body { get; init; }
    /// <summary>For unanchored rules: how much of the body is literal text at its start, found with a fast search.</summary>
    public int LeadLength { get; init; }
    public bool CaseSensitive { get; init; }
    public KitType Types { get; init; }
    /// <summary>1 for third-party only, 0 for first-party only, -1 for both.</summary>
    public sbyte ThirdParty { get; init; }
    public bool ChildFrameOnly { get; init; }
    public string[] IfDomains { get; init; } = [];
    public string[] UnlessDomains { get; init; } = [];

    /// <summary>
    /// The rule's pattern in filter syntax, for debugging. The original line isn't kept, to save
    /// memory, so this is the pattern as matched: lowercase, without options.
    /// </summary>
    public string Describe() =>
        (Anchor switch { Anchor.Host => "||", Anchor.Start => "|", _ => "" }) + Body + (End ? "|" : "");

    public static CompiledRule From(NetworkFilter filter)
    {
        var parts = filter.Parts;
        var body = Normalize(parts.Body, parts.Anchor, parts.EndAnchor);
        if (!filter.CaseSensitive) body = SiteDomain.AsciiLower(body);
        var types = KitType.None;
        foreach (var name in filter.Types) types |= KitTypes.FromName(name);
        if (filter.Types.Length == 0) types = KitType.All;
        int lead = 0;
        if (parts.Anchor == Anchor.None)
        {
            int stop = body.AsSpan().IndexOfAny('*', '^');
            lead = stop < 0 ? body.Length : stop;
        }
        return new CompiledRule
        {
            Anchor = parts.Anchor,
            End = parts.EndAnchor,
            Body = body,
            LeadLength = lead,
            CaseSensitive = filter.CaseSensitive,
            Types = types,
            ThirdParty = filter.LoadType switch
            {
                "third-party" => 1,
                "first-party" => 0,
                _ => -1,
            },
            ChildFrameOnly = filter.ChildFrameOnly,
            IfDomains = filter.IfDomains,
            UnlessDomains = filter.UnlessDomains,
        };
    }

    /// <summary>
    /// Rewrites the body into a shorter form that matches exactly the same URLs as the Mac's regular
    /// expression: repeated '*' collapse, a '^' next to a '*' adds nothing, and an optional '^' or a
    /// '*' at an unanchored end can't change whether the pattern is found.
    /// </summary>
    internal static string Normalize(string body, Anchor anchor, bool end)
    {
        var sb = new StringBuilder(body.Length);
        foreach (char c in body)
        {
            if (c == '*')
            {
                while (sb.Length > 0 && sb[^1] == '^') sb.Length--;
                if (sb.Length > 0 && sb[^1] == '*') continue;
            }
            else if (c == '^' && sb.Length > 0 && sb[^1] == '*')
            {
                continue;
            }
            sb.Append(c);
        }
        var s = sb.ToString().AsSpan();
        if (anchor == Anchor.None) s = s.TrimStart("*^");
        if (!end) s = s.TrimEnd("*^");
        return s.ToString();
    }

    /// <summary>Whether the URL pattern matches. <paramref name="url"/> is lowercase unless the rule is case-sensitive.</summary>
    public bool PatternMatches(ReadOnlySpan<char> url, in UrlShape shape)
    {
        var body = Body.AsSpan();
        switch (Anchor)
        {
            case Anchor.Start:
                return Glob(body, url, End);
            case Anchor.Host:
                if (shape.SlashEnd < 0) return false;
                // Right after "scheme:/", "scheme://" and so on: the host itself.
                for (int k = shape.Colon + 2; k <= shape.SlashEnd; k++)
                {
                    if (Glob(body, url[k..], End)) return true;
                }
                // After any dot in the host: one of its parent domains.
                for (int d = shape.SlashEnd + 1; d < shape.AuthorityEnd; d++)
                {
                    if (url[d] == '.' && Glob(body, url[(d + 1)..], End)) return true;
                }
                return false;
            default:
                var lead = body[..LeadLength];
                var rest = body[lead.Length..];
                int from = 0;
                while (from <= url.Length - lead.Length)
                {
                    int found = url[from..].IndexOf(lead, StringComparison.Ordinal);
                    if (found < 0) return false;
                    int at = from + found;
                    if (Glob(rest, url[(at + lead.Length)..], End)) return true;
                    if (rest.IsEmpty && !End) return true;
                    from = at + 1;
                }
                return false;
        }
    }

    internal static bool IsSeparator(char c) => c is '/' or ':' or '&' or '?' or '=';

    /// <summary>
    /// Whether <paramref name="p"/> matches the start of <paramref name="s"/>, or all of it when
    /// <paramref name="end"/> is set. '*' is ".*" and '^' is "[/:&amp;?=]?", as in the Mac's regex.
    /// </summary>
    internal static bool Glob(ReadOnlySpan<char> p, ReadOnlySpan<char> s, bool end)
    {
        while (true)
        {
            if (p.IsEmpty) return !end || s.IsEmpty;
            char c = p[0];
            if (c == '*')
            {
                p = p[1..];
                while (!p.IsEmpty && p[0] == '*') p = p[1..];
                if (p.IsEmpty) return true;
                if (p[0] == '^')
                {
                    for (int k = 0; k <= s.Length; k++)
                    {
                        if (Glob(p, s[k..], end)) return true;
                    }
                    return false;
                }
                int run = LiteralRun(p);
                var literal = p[..run];
                var rest = p[run..];
                int from = 0;
                while (true)
                {
                    int found = s[from..].IndexOf(literal, StringComparison.Ordinal);
                    if (found < 0) return false;
                    int at = from + found;
                    if (Glob(rest, s[(at + run)..], end)) return true;
                    from = at + 1;
                }
            }
            if (c == '^')
            {
                p = p[1..];
                if (!s.IsEmpty && IsSeparator(s[0]) && Glob(p, s[1..], end)) return true;
                continue;
            }
            int n = LiteralRun(p);
            if (s.Length < n || !s[..n].SequenceEqual(p[..n])) return false;
            p = p[n..];
            s = s[n..];
        }
    }

    private static int LiteralRun(ReadOnlySpan<char> p)
    {
        int stop = p.IndexOfAny('*', '^');
        return stop < 0 ? p.Length : stop;
    }
}

/// <summary>Where the parts of a URL are, for host-anchored rules. See the Mac's "^[^:]+://+([^:/]+\.)?".</summary>
internal readonly struct UrlShape
{
    /// <summary>Index of the first ':'.</summary>
    public int Colon { get; }
    /// <summary>Index just past the slashes after the colon, or -1 when the URL has no "scheme:/".</summary>
    public int SlashEnd { get; }
    /// <summary>Index of the first ':' or '/' after the slashes, or the length.</summary>
    public int AuthorityEnd { get; }

    public UrlShape(ReadOnlySpan<char> url)
    {
        Colon = url.IndexOf(':');
        SlashEnd = -1;
        AuthorityEnd = url.Length;
        if (Colon < 1 || Colon + 1 >= url.Length || url[Colon + 1] != '/') return;
        int i = Colon + 1;
        while (i < url.Length && url[i] == '/') i++;
        SlashEnd = i;
        int stop = url[i..].IndexOfAny(':', '/');
        AuthorityEnd = stop < 0 ? url.Length : i + stop;
    }
}
