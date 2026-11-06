namespace Cineon.Core.Shields;

/// <summary>
/// Host helpers for the matcher. <see cref="Registrable"/> is the same algorithm as the Mac's
/// <c>DomainName.registrable</c>, so ShieldState keys and the third-party check agree with the data
/// layer. Kept internal so Shields defines nothing the data layer also defines.
/// </summary>
internal static class SiteDomain
{
    private static readonly HashSet<string> CompoundSuffixes =
    [
        "co.uk", "org.uk", "ac.uk", "me.uk", "com.ua", "org.ua", "net.ua", "in.ua", "kiev.ua", "lviv.ua",
        "co.jp", "or.jp", "ne.jp", "com.au", "net.au", "org.au", "com.br", "net.br", "co.nz", "co.in",
        "co.kr", "com.cn", "com.tw", "com.tr", "com.mx", "com.ar", "co.za", "com.ru", "org.ru", "net.ru",
        "com.pl", "net.pl", "org.pl", "com.de", "co.il", "com.sg", "com.hk", "pp.ua", "biz.ua", "at.ua",
    ];

    private static readonly HashSet<string>.AlternateLookup<ReadOnlySpan<char>> CompoundLookup =
        CompoundSuffixes.GetAlternateLookup<ReadOnlySpan<char>>();

    /// <summary><c>player.vod.example.co.uk</c> becomes <c>example.co.uk</c>.</summary>
    internal static string Registrable(string host)
    {
        var h = host.ToLowerInvariant();
        if (h.EndsWith('.')) h = h[..^1];
        return RegistrableSpan(h).ToString();
    }

    /// <summary>Same as <see cref="Registrable"/> for a host that is already lowercase.</summary>
    internal static ReadOnlySpan<char> RegistrableSpan(ReadOnlySpan<char> h)
    {
        if (h.EndsWith('.')) h = h[..^1];
        if (IsIPAddress(h)) return h;
        if (h.StartsWith('.') || h.Contains("..", StringComparison.Ordinal)) return RegistrableByLabels(h);
        int last = h.LastIndexOf('.');
        if (last < 0) return h;
        int second = h[..last].LastIndexOf('.');
        if (second < 0) return h;
        var lastTwo = h[(second + 1)..];
        if (!CompoundLookup.Contains(lastTwo)) return lastTwo;
        int third = h[..second].LastIndexOf('.');
        return third < 0 ? h : h[(third + 1)..];
    }

    /// <summary>The Mac's exact steps, for hosts with empty labels, where Swift's split skips them.</summary>
    private static string RegistrableByLabels(ReadOnlySpan<char> h)
    {
        var labels = h.ToString().Split('.', StringSplitOptions.RemoveEmptyEntries);
        if (labels.Length <= 2) return h.ToString();
        var lastTwo = string.Join('.', labels[^2..]);
        return CompoundSuffixes.Contains(lastTwo) ? string.Join('.', labels[^3..]) : lastTwo;
    }

    /// <summary>The Mac's test: a colon, or every dot-separated part a number.</summary>
    internal static bool IsIPAddress(ReadOnlySpan<char> host)
    {
        if (host.Contains(':')) return true;
        foreach (var range in host.Split('.'))
        {
            var part = host[range];
            if (part.IsEmpty) continue; // Swift's split drops empty parts.
            // Swift's Int is 64-bit and takes a leading sign.
            if (!long.TryParse(part, System.Globalization.NumberStyles.AllowLeadingSign, System.Globalization.CultureInfo.InvariantCulture, out _))
                return false;
        }
        return true;
    }

    /// <summary>WebKit's <c>*domain</c>: the domain itself or any subdomain of it.</summary>
    internal static bool IsSameOrSubdomain(ReadOnlySpan<char> host, ReadOnlySpan<char> domain)
    {
        if (!host.EndsWith(domain, StringComparison.Ordinal)) return false;
        return host.Length == domain.Length || host[host.Length - domain.Length - 1] == '.';
    }

    /// <summary>
    /// The host of a URL, lowercased by the caller: what sits between "://" and the path, without
    /// credentials or port. Empty when there is none, as for data: or about: URLs.
    /// </summary>
    internal static ReadOnlySpan<char> HostOf(ReadOnlySpan<char> url)
    {
        int colon = url.IndexOf(':');
        if (colon <= 0) return default;
        int start = colon + 1;
        if (url.Length < start + 2 || url[start] != '/' || url[start + 1] != '/')
            return default;
        start += 2;
        var rest = url[start..];
        int end = rest.IndexOfAny('/', '?', '#');
        if (end >= 0) rest = rest[..end];
        int at = rest.LastIndexOf('@');
        if (at >= 0) rest = rest[(at + 1)..];
        if (rest.StartsWith('['))
        {
            int close = rest.IndexOf(']');
            return close > 0 ? rest[..(close + 1)] : rest;
        }
        int port = rest.IndexOf(':');
        if (port >= 0) rest = rest[..port];
        if (rest.EndsWith('.')) rest = rest[..^1];
        return rest;
    }

    /// <summary>Lowercases ASCII letters only, which is how WebKit compares URLs to filters.</summary>
    internal static void AsciiLower(ReadOnlySpan<char> source, Span<char> destination)
    {
        for (int i = 0; i < source.Length; i++)
        {
            char c = source[i];
            destination[i] = c is >= 'A' and <= 'Z' ? (char)(c | 0x20) : c;
        }
    }

    internal static string AsciiLower(string s)
    {
        foreach (char c in s)
        {
            if (c is >= 'A' and <= 'Z')
            {
                return string.Create(s.Length, s, static (span, value) => AsciiLower(value, span));
            }
        }
        return s;
    }
}
