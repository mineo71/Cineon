using System.Buffers;
using System.Collections.Concurrent;
using System.Text;

namespace Cineon.Core.Shields;

/// <summary>
/// Matches requests and builds element-hiding stylesheets from a set of <see cref="FilterList"/>s,
/// with WebKit's content-blocker semantics, since that is what the Mac app gets:
/// <list type="bullet">
/// <item>Each list stands alone. An exception only cancels blocks from its own list, because
/// ignore-previous-rules only reaches rules above it in the same compiled list. A request is blocked
/// when any list blocks it and that same list has no exception for it.</item>
/// <item>"||host^", "|", "*" and "^" mean what the Mac's regular expressions say, quirks included:
/// "^" is one optional separator, so "||ads.com^" also matches "ads.com.evil.net".</item>
/// <item>Domain options and third-party are judged against the top-level page, as WebKit does.</item>
/// </list>
/// Immutable and thread-safe. Lookups go through an index of 8- and 4-character pieces of every
/// rule, so each request only checks the handful of rules that could match it.
/// </summary>
public sealed class ShieldEngine
{
    public static ShieldEngine Empty { get; } = new(new Core([]), 0);

    private const int MaxLists = 64;
    private const int CssCacheLimit = 256;

    private readonly Core _core;
    private readonly ulong _active;
    private readonly ConcurrentDictionary<string, string> _cssCache = new(StringComparer.Ordinal);

    private ShieldEngine(Core core, ulong active)
    {
        _core = core;
        _active = active;
    }

    /// <summary>Parses and indexes lists, in order. <c>name</c> is the list's catalog id.</summary>
    public static ShieldEngine Load(IEnumerable<(string name, string text)> lists) =>
        From(lists.Select(list => FilterList.Compile(list.name, list.text)));

    /// <summary>Indexes lists that are already parsed. All of them are switched on.</summary>
    public static ShieldEngine From(IEnumerable<FilterList> lists)
    {
        var all = lists.ToArray();
        if (all.Length > MaxLists) throw new ArgumentException($"At most {MaxLists} lists.", nameof(lists));
        if (all.Length == 0) return Empty;
        var core = new Core(all);
        return new ShieldEngine(core, all.Length == 64 ? ulong.MaxValue : (1UL << all.Length) - 1);
    }

    /// <summary>Every list this engine was built with, switched on or not.</summary>
    public IReadOnlyList<FilterList> Lists => _core.Lists;

    /// <summary>The ids of the lists in use, in order.</summary>
    public IReadOnlyList<string> ActiveLists =>
        [.. _core.Lists.Where((_, i) => (_active & (1UL << i)) != 0).Select(l => l.Id)];

    /// <summary>
    /// The same index with only these lists switched on, like the Mac's per-profile
    /// <c>applyRules</c>. Cheap: nothing is parsed or indexed again.
    /// </summary>
    public ShieldEngine WithLists(IEnumerable<string> ids)
    {
        var wanted = new HashSet<string>(ids, StringComparer.Ordinal);
        ulong mask = 0;
        for (int i = 0; i < _core.Lists.Length; i++)
        {
            if (wanted.Contains(_core.Lists[i].Id)) mask |= 1UL << i;
        }
        return mask == _active ? this : new ShieldEngine(_core, mask);
    }

    /// <summary>Rule counts of the lists in use, by id, as the Mac reports them.</summary>
    public IReadOnlyDictionary<string, int> RuleCounts =>
        _core.Lists.Where((_, i) => (_active & (1UL << i)) != 0).ToDictionary(l => l.Id, l => l.RuleCount);

    public int TotalRules => RuleCounts.Values.Sum();

    public bool IsEmpty => _active == 0;

    /// <summary>
    /// Whether to block a request.
    /// </summary>
    /// <param name="url">The request URL.</param>
    /// <param name="documentUrl">The top-level page's URL, which domain= and third-party are judged
    /// against. For a main-frame navigation pass the URL being opened, or null, which means the same.</param>
    /// <param name="type">What the request is for.</param>
    /// <param name="isMainFrame">True for the top-level document itself. "$subdocument" rules only
    /// apply to frames, so they never block a main-frame navigation.</param>
    public Decision Match(string url, string? documentUrl, ResourceType type, bool isMainFrame = false) =>
        Evaluate(url, documentUrl, type, isMainFrame, nameRule: false, out _) ? Decision.Block : Decision.Allow;

    /// <summary>Same as <see cref="Match"/>, also giving the rule that blocks, for tests and debugging.</summary>
    internal bool Evaluate(string url, string? documentUrl, ResourceType type, bool isMainFrame, bool nameRule, out string? rule)
    {
        rule = null;
        if (_active == 0 || url.Length == 0) return false;
        // WebKit never applies content blockers to data: URLs, which can also be megabytes long.
        if (url.StartsWith("data:", StringComparison.OrdinalIgnoreCase)) return false;

        char[]? rented = null;
        Span<char> lower = url.Length <= 1024 ? stackalloc char[url.Length] : (rented = ArrayPool<char>.Shared.Rent(url.Length));
        lower = lower[..url.Length];
        try
        {
            SiteDomain.AsciiLower(url, lower);
            var context = new RequestContext(url, lower, documentUrl, KitTypes.From(type), type == ResourceType.Document && !isMainFrame);

            ulong candidates = _active & ~_core.WholeSiteExceptions(context.DocumentHost);
            if (candidates == 0) return false;

            ulong blocked = _core.Blocks.Scan(ref context, candidates, stopWhenAll: true, out var blockRule);
            if (blocked == 0) return false;

            ulong excepted = _core.Exceptions.Scan(ref context, blocked, stopWhenAll: true, out _);
            ulong remaining = blocked & ~excepted;
            if (remaining == 0) return false;
            if (!nameRule) return true;
            if (blockRule is { } first && ((1UL << first.ListIndex) & remaining) != 0) rule = first.Rule.Describe();
            else rule = _core.Blocks.FirstRule(ref context, remaining);
            return true;
        }
        finally
        {
            if (rented is not null) ArrayPool<char>.Shared.Return(rented);
        }
    }

    /// <summary>
    /// The element-hiding stylesheet for pages on <paramref name="host"/> (a host, or a URL to take
    /// it from): what the Mac's css-display-none rules hide there. Empty when nothing applies.
    /// </summary>
    public string CssFor(string host)
    {
        if (_active == 0) return "";
        var key = NormalizeHost(host);
        if (_cssCache.TryGetValue(key, out var cached)) return cached;
        var css = _core.BuildCss(key, _active);
        if (_cssCache.Count >= CssCacheLimit) _cssCache.Clear();
        _cssCache[key] = css;
        return css;
    }

    private static string NormalizeHost(string host)
    {
        var lower = SiteDomain.AsciiLower(host.Trim());
        if (lower.Contains("://", StringComparison.Ordinal)) return SiteDomain.HostOf(lower).ToString();
        return lower.EndsWith('.') ? lower[..^1] : lower;
    }

    // MARK: Index

    /// <summary>Everything built from the lists, shared by every view of the engine.</summary>
    private sealed class Core
    {
        public FilterList[] Lists { get; }
        public RuleIndex Blocks { get; }
        public RuleIndex Exceptions { get; }
        private readonly Dictionary<string, ulong> _wholeSite = new(StringComparer.Ordinal);
        private readonly Dictionary<string, ulong>.AlternateLookup<ReadOnlySpan<char>> _wholeSiteLookup;
        private readonly Dictionary<string, List<(int List, int Rule)>> _cosmeticByDomain = new(StringComparer.Ordinal);
        private readonly Dictionary<string, List<(int List, int Rule)>>.AlternateLookup<ReadOnlySpan<char>> _cosmeticLookup;

        public Core(FilterList[] lists)
        {
            Lists = lists;
            Blocks = new RuleIndex(lists.SelectMany((l, i) => l.Blocks.Select(r => new IndexedRule(r, (byte)i))));
            Exceptions = new RuleIndex(lists.SelectMany((l, i) => l.Exceptions.Select(r => new IndexedRule(r, (byte)i))));
            for (int i = 0; i < lists.Length; i++)
            {
                foreach (var domain in lists[i].WholeSiteDomains)
                {
                    _wholeSite[domain] = _wholeSite.GetValueOrDefault(domain) | (1UL << i);
                }
                var rules = lists[i].IfDomainRules;
                for (int r = 0; r < rules.Length; r++)
                {
                    foreach (var domain in rules[r].IfDomains!)
                    {
                        if (!_cosmeticByDomain.TryGetValue(domain, out var entries))
                        {
                            entries = [];
                            _cosmeticByDomain[domain] = entries;
                        }
                        entries.Add((i, r));
                    }
                }
            }
            _wholeSiteLookup = _wholeSite.GetAlternateLookup<ReadOnlySpan<char>>();
            _cosmeticLookup = _cosmeticByDomain.GetAlternateLookup<ReadOnlySpan<char>>();
        }

        /// <summary>Lists with a whole-site exception for this page's site or a parent domain of it.</summary>
        public ulong WholeSiteExceptions(ReadOnlySpan<char> host)
        {
            if (_wholeSite.Count == 0 || host.IsEmpty) return 0;
            ulong mask = 0;
            for (int start = 0; start < host.Length;)
            {
                if (_wholeSiteLookup.TryGetValue(host[start..], out var lists)) mask |= lists;
                int dot = host[start..].IndexOf('.');
                if (dot < 0) break;
                start += dot + 1;
            }
            return mask;
        }

        public string BuildCss(string host, ulong active)
        {
            var css = new StringBuilder();
            ulong lists = active & ~WholeSiteExceptions(host);
            var specific = new List<(int List, int Rule)>();
            if (host.Length > 0)
            {
                foreach (var suffix in Suffixes(host))
                {
                    if (_cosmeticLookup.TryGetValue(host.AsSpan(suffix), out var entries)) specific.AddRange(entries);
                }
            }
            specific.Sort();
            for (int i = 0; i < Lists.Length; i++)
            {
                if ((lists & (1UL << i)) == 0) continue;
                var list = Lists[i];
                css.Append(list.UniversalCss);
                foreach (var rule in list.UnlessDomainRules)
                {
                    if (!MatchesAny(host, rule.UnlessDomains!)) FilterList.AppendCss(css, rule.Selector);
                }
                int previous = -1;
                foreach (var (listIndex, ruleIndex) in specific)
                {
                    if (listIndex != i || ruleIndex == previous) continue;
                    previous = ruleIndex;
                    FilterList.AppendCss(css, list.IfDomainRules[ruleIndex].Selector);
                }
            }
            return css.ToString();
        }

        /// <summary>Start indexes of the host and each of its parent domains: a.b.c gives a.b.c, b.c, c.</summary>
        private static List<int> Suffixes(ReadOnlySpan<char> host)
        {
            var starts = new List<int> { 0 };
            for (int i = 0; i < host.Length; i++)
            {
                if (host[i] == '.' && i + 1 < host.Length) starts.Add(i + 1);
            }
            return starts;
        }
    }

    internal static bool MatchesAny(ReadOnlySpan<char> host, string[] domains)
    {
        foreach (var domain in domains)
        {
            if (SiteDomain.IsSameOrSubdomain(host, domain)) return true;
        }
        return false;
    }

    internal readonly record struct IndexedRule(CompiledRule Rule, byte ListIndex);

    /// <summary>
    /// Rules keyed by one piece of their literal text: 8 characters when the rule has a run that
    /// long, otherwise 4. Each rule takes its rarest piece, so buckets stay small. A URL is checked by
    /// sliding over it once and looking each piece up.
    /// </summary>
    internal sealed class RuleIndex
    {
        private const ulong FourTag = 1UL << 62;
        private const int FilterBits = 20;

        private readonly Dictionary<ulong, int> _buckets = [];
        /// <summary>One bit per hashed key, so most pieces of a URL are turned away without a dictionary lookup.</summary>
        private readonly ulong[] _filter = new ulong[(1 << FilterBits) / 64];
        private readonly int[] _starts;
        private readonly IndexedRule[] _rules;
        private readonly IndexedRule[] _unindexed;

        public int Count { get; }
        public int UnindexedCount => _unindexed.Length;
        public int BucketCount => _buckets.Count;

        public RuleIndex(IEnumerable<IndexedRule> rules)
        {
            var all = rules.ToArray();
            Count = all.Length;
            var candidates = new ulong[all.Length][];
            var frequency = new Dictionary<ulong, int>();
            for (int i = 0; i < all.Length; i++)
            {
                candidates[i] = Pieces(SiteDomain.AsciiLower(all[i].Rule.Body)); // URLs are scanned lowercase.
                foreach (var key in candidates[i].Distinct())
                {
                    frequency[key] = frequency.GetValueOrDefault(key) + 1;
                }
            }

            foreach (var key in frequency.Keys.ToArray()) frequency[key] += Penalty(key);

            var chosen = new ulong[all.Length];
            var unindexed = new List<IndexedRule>();
            var sizes = new Dictionary<ulong, int>();
            for (int i = 0; i < all.Length; i++)
            {
                if (candidates[i].Length == 0)
                {
                    unindexed.Add(all[i]);
                    chosen[i] = 0;
                    continue;
                }
                ulong best = 0;
                int bestScore = int.MaxValue;
                foreach (var key in candidates[i])
                {
                    int score = frequency[key];
                    if (score < bestScore)
                    {
                        best = key;
                        bestScore = score;
                    }
                }
                chosen[i] = best;
                sizes[best] = sizes.GetValueOrDefault(best) + 1;
            }
            _unindexed = [.. unindexed];

            // Compact storage: one array of rules grouped by piece, and where each group starts.
            _starts = new int[sizes.Count + 1];
            int bucket = 0;
            int offset = 0;
            foreach (var (key, size) in sizes)
            {
                _buckets[key] = bucket;
                int slot = Slot(key);
                _filter[slot >> 6] |= 1UL << slot;
                _starts[bucket] = offset;
                offset += size;
                bucket++;
            }
            _starts[bucket] = offset;
            _rules = new IndexedRule[offset];
            var fill = (int[])_starts.Clone();
            for (int i = 0; i < all.Length; i++)
            {
                if (candidates[i].Length == 0) continue;
                _rules[fill[_buckets[chosen[i]]]++] = all[i];
            }
        }

        /// <summary>Pieces found in most URLs make poor keys, even when few rules have them.</summary>
        private static int Penalty(ulong key)
        {
            int length = (key & FourTag) != 0 ? 4 : 8;
            Span<char> text = stackalloc char[8];
            for (int i = 0; i < length; i++) text[i] = (char)((key >> (7 * i)) & 0x7F);
            foreach (var common in CommonPieces)
            {
                if (text[..length].Contains(common, StringComparison.Ordinal)) return 50_000;
            }
            return 0;
        }

        private static readonly string[] CommonPieces = ["http", "www.", ".com", "com/", "://", ".js", ".net", ".php", ".htm"];

        /// <summary>Every 8-character piece of the literal runs, or every 4-character one if no run is 8 long.</summary>
        private static ulong[] Pieces(string body)
        {
            var runs = body.Split(['*', '^'], StringSplitOptions.RemoveEmptyEntries);
            int width = runs.Any(r => r.Length >= 8) ? 8 : runs.Any(r => r.Length >= 4) ? 4 : 0;
            if (width == 0) return [];
            var keys = new List<ulong>();
            foreach (var run in runs)
            {
                for (int i = 0; i + width <= run.Length; i++)
                {
                    keys.Add(Key(run.AsSpan(i, width)));
                }
            }
            return [.. keys];
        }

        private static int Slot(ulong key) => (int)((key * 0x9E3779B97F4A7C15UL) >> (64 - FilterBits));

        private bool MightHave(ulong key)
        {
            int slot = Slot(key);
            return (_filter[slot >> 6] & (1UL << slot)) != 0;
        }

        private static ulong Key(ReadOnlySpan<char> piece)
        {
            ulong key = 0;
            for (int j = 0; j < piece.Length; j++) key |= (ulong)(piece[j] & 0x7F) << (7 * j);
            return piece.Length == 4 ? key | FourTag : key;
        }

        /// <summary>
        /// Checks every rule that could match, from lists in <paramref name="lists"/>, and returns
        /// the lists that had a match. Stops early once every list has one.
        /// </summary>
        public ulong Scan(ref RequestContext context, ulong lists, bool stopWhenAll, out IndexedRule? first)
        {
            first = null;
            ulong matched = 0;
            var url = context.Lower;
            ulong key8 = 0;
            ulong key4 = 0;
            int valid = 0;
            for (int i = 0; i < url.Length; i++)
            {
                char c = url[i];
                if (c >= 128)
                {
                    valid = 0;
                    key8 = key4 = 0;
                    continue;
                }
                valid++;
                key8 = (key8 >> 7) | ((ulong)c << 49);
                key4 = (key4 >> 7) | ((ulong)c << 21);
                if (valid >= 4 && MightHave(key4 | FourTag) && _buckets.TryGetValue(key4 | FourTag, out int bucket4))
                {
                    matched |= CheckBucket(ref context, bucket4, lists & ~matched, ref first);
                    if (stopWhenAll && (lists & ~matched) == 0) return matched;
                }
                if (valid >= 8 && MightHave(key8) && _buckets.TryGetValue(key8, out int bucket8))
                {
                    matched |= CheckBucket(ref context, bucket8, lists & ~matched, ref first);
                    if (stopWhenAll && (lists & ~matched) == 0) return matched;
                }
            }
            foreach (var rule in _unindexed)
            {
                ulong bit = 1UL << rule.ListIndex;
                if ((lists & ~matched & bit) == 0) continue;
                if (context.Matches(rule.Rule))
                {
                    matched |= bit;
                    first ??= rule;
                }
            }
            return matched;
        }

        private ulong CheckBucket(ref RequestContext context, int bucket, ulong lists, ref IndexedRule? first)
        {
            if (lists == 0) return 0;
            ulong matched = 0;
            for (int r = _starts[bucket]; r < _starts[bucket + 1]; r++)
            {
                var rule = _rules[r];
                ulong bit = 1UL << rule.ListIndex;
                if ((lists & ~matched & bit) == 0) continue;
                if (context.Matches(rule.Rule))
                {
                    matched |= bit;
                    first ??= rule;
                }
            }
            return matched;
        }

        /// <summary>The first matching rule from these lists. Only used to name the rule that blocked.</summary>
        public string? FirstRule(ref RequestContext context, ulong lists)
        {
            Scan(ref context, lists, stopWhenAll: true, out var first);
            return first?.Rule.Describe();
        }
    }

    /// <summary>One request, with what rules need worked out once and the rest lazily.</summary>
    internal ref struct RequestContext
    {
        public ReadOnlySpan<char> Original { get; }
        public ReadOnlySpan<char> Lower { get; }
        public ReadOnlySpan<char> DocumentHost { get; }
        private readonly UrlShape _shape;
        private readonly KitType _type;
        private readonly bool _childFrame;
        private readonly string? _documentLower;
        private sbyte _thirdParty;

        public RequestContext(string url, ReadOnlySpan<char> lower, string? documentUrl, KitType type, bool childFrame)
        {
            Original = url;
            Lower = lower;
            _shape = new UrlShape(lower);
            _type = type;
            _childFrame = childFrame;
            _documentLower = documentUrl is null ? null : SiteDomain.AsciiLower(documentUrl);
            DocumentHost = _documentLower is null ? SiteDomain.HostOf(lower) : SiteDomain.HostOf(_documentLower);
            _thirdParty = -1;
        }

        public bool Matches(CompiledRule rule)
        {
            if ((rule.Types & _type) == 0) return false;
            // load-context child-frame: only frames' own documents are known to be in a frame.
            if (rule.ChildFrameOnly && !_childFrame) return false;
            if (!rule.PatternMatches(rule.CaseSensitive ? Original : Lower, _shape)) return false;
            if (rule.ThirdParty >= 0 && (rule.ThirdParty == 1) != IsThirdParty()) return false;
            if (rule.IfDomains.Length > 0 && !MatchesAny(DocumentHost, rule.IfDomains)) return false;
            if (rule.UnlessDomains.Length > 0 && MatchesAny(DocumentHost, rule.UnlessDomains)) return false;
            return true;
        }

        /// <summary>WebKit's test: the request's host isn't the page's registrable domain or under it.</summary>
        private bool IsThirdParty()
        {
            if (_thirdParty < 0)
            {
                var site = SiteDomain.RegistrableSpan(DocumentHost);
                var host = SiteDomain.HostOf(Lower);
                _thirdParty = site.IsEmpty || !SiteDomain.IsSameOrSubdomain(host, site) ? (sbyte)1 : (sbyte)0;
            }
            return _thirdParty == 1;
        }
    }
}
