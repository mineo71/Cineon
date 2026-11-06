using Cineon.Core.Data;

namespace Cineon.Core.Import;

/// <summary>
/// The parts of an address the way Foundation's <c>URL</c> gives them. <see cref="Uri"/> canonicalises
/// (lower-cases hosts, drops default ports, escapes), so these read the address's own text instead.
/// </summary>
internal static class SwiftUrl
{
    private static UrlText.Parts Parts(Uri url) => UrlText.Split(UrlText.EncodeInvalid(url.OriginalString));

    /// <summary><c>URL.host</c>: as written, without user, password, port or IPv6 brackets. Null when there's none.</summary>
    public static string? Host(Uri url)
    {
        var authority = Parts(url).Authority;
        if (authority is null) return null;
        var at = authority.LastIndexOf('@');
        if (at >= 0) authority = authority[(at + 1)..];
        string host;
        if (authority.StartsWith('['))
        {
            var close = authority.IndexOf(']');
            host = close < 0 ? authority[1..] : authority[1..close];
        }
        else
        {
            var colon = authority.LastIndexOf(':');
            host = colon >= 0 ? authority[..colon] : authority;
        }
        host = UrlText.Decode(host) ?? host;
        return host.Length == 0 ? null : host;
    }

    /// <summary><c>URL.port</c>: only when the address names one.</summary>
    public static int? Port(Uri url)
    {
        var authority = Parts(url).Authority;
        if (authority is null) return null;
        var at = authority.LastIndexOf('@');
        if (at >= 0) authority = authority[(at + 1)..];
        var close = authority.LastIndexOf(']');
        var colon = authority.LastIndexOf(':');
        if (colon < 0 || colon < close) return null;
        return int.TryParse(authority[(colon + 1)..], out var port) ? port : null;
    }

    /// <summary><c>URL.path</c>: percent-decoded, without a trailing slash unless it's the root.</summary>
    public static string Path(Uri url)
    {
        var raw = Parts(url).Path;
        var path = UrlText.Decode(raw) ?? raw;
        if (path.Length > 1 && path.EndsWith('/')) path = path.TrimEnd('/');
        return path.Length == 0 && raw.StartsWith('/') ? "/" : path;
    }

    /// <summary><c>URL.query</c>, still percent-encoded.</summary>
    public static string? Query(Uri url) => Parts(url).Query;

    /// <summary><c>URL.lastPathComponent</c>.</summary>
    public static string LastPathComponent(Uri url)
    {
        var path = Path(url);
        if (path == "/") return "/";
        var slash = path.LastIndexOf('/');
        return slash >= 0 ? path[(slash + 1)..] : path;
    }

    /// <summary><c>URL.pathExtension</c>: after the last dot of the last component, or "".</summary>
    public static string PathExtension(Uri url) => Extension(LastPathComponent(url));

    public static string Extension(string name)
    {
        var dot = name.LastIndexOf('.');
        return dot > 0 && dot < name.Length - 1 ? name[(dot + 1)..] : "";
    }

    /// <summary>The address with its percent-encoding removed, or as written when that fails.</summary>
    public static string Decoded(Uri url)
    {
        var text = UrlText.EncodeInvalid(url.OriginalString);
        return UrlText.Decode(text) ?? text;
    }
}
