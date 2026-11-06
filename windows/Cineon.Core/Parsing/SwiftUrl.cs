using System.Globalization;
using System.Text;
using Cineon.Core.Data;

namespace Cineon.Core.Parsing;

/// <summary>
/// An address read the way Foundation's <c>URL(string:)</c> reads it, with the properties the parsers
/// use: <c>absoluteString</c>, <c>scheme</c>, <c>host</c>, <c>path</c> and
/// <c>deletingPathExtension().lastPathComponent</c>. <see cref="Uri"/> normalises paths and lower-cases
/// hosts, which would change what the parsers see.
/// </summary>
internal sealed class SwiftUrl
{
    private readonly UrlText.Parts _parts;

    private SwiftUrl(string absoluteString)
    {
        AbsoluteString = absoluteString;
        _parts = UrlText.Split(absoluteString);
    }

    /// <summary>The text as Foundation keeps it: characters that can't appear in an address percent-encoded, hosts in punycode.</summary>
    public string AbsoluteString { get; }

    public string? Scheme => _parts.Scheme;

    /// <summary>Null for text Foundation refuses: only the empty string, in practice.</summary>
    public static SwiftUrl? Parse(string? text)
    {
        if (string.IsNullOrEmpty(text)) return null;
        return new SwiftUrl(FixUp(PunycodeHost(text)));
    }

    private static bool IsUnreservedOrSubDelim(char c) =>
        c is >= 'a' and <= 'z' or >= 'A' and <= 'Z' or >= '0' and <= '9' || "-._~!$&'()*+,;=".Contains(c);

    private static bool UserAllowed(char c) => IsUnreservedOrSubDelim(c) || c == ':';
    private static bool HostAllowed(char c) => IsUnreservedOrSubDelim(c) || c is '[' or ']' or ':';
    private static bool PathAllowed(char c) => IsUnreservedOrSubDelim(c) || c is ':' or '@' or '/';
    private static bool QueryAllowed(char c) => PathAllowed(c) || c == '?';

    /// <summary>
    /// What <c>URL(string:)</c> does to text that isn't a valid address: each part (user, host, path,
    /// query, fragment) that holds a character it can't have is percent-encoded whole, its "%" included,
    /// so "a%20b c" becomes "a%2520b%20c"; a part that's valid stays as written.
    /// </summary>
    internal static string FixUp(string text)
    {
        var parts = UrlText.Split(text);
        var sb = new StringBuilder(text.Length + 16);
        if (parts.Scheme is not null) sb.Append(parts.Scheme).Append(':');
        if (parts.Authority is { } authority)
        {
            sb.Append("//");
            var at = authority.LastIndexOf('@');
            if (at >= 0) sb.Append(FixPart(authority[..at], UserAllowed)).Append('@');
            sb.Append(FixPart(authority[(at + 1)..], HostAllowed));
        }
        sb.Append(FixPart(parts.Path, PathAllowed));
        if (parts.Query is not null) sb.Append('?').Append(FixPart(parts.Query, QueryAllowed));
        if (parts.Fragment is not null) sb.Append('#').Append(FixPart(parts.Fragment, QueryAllowed));
        return sb.ToString();
    }

    private static string FixPart(string part, Func<char, bool> allowed)
    {
        var valid = true;
        for (var i = 0; i < part.Length && valid; i++)
        {
            var c = part[i];
            if (c == '%') valid = i + 2 < part.Length && char.IsAsciiHexDigit(part[i + 1]) && char.IsAsciiHexDigit(part[i + 2]);
            else valid = allowed(c);
        }
        return valid ? part : UrlText.Encode(part, c => c != '%' && allowed(c));
    }

    public static SwiftUrl From(Uri url) => Parse(url.OriginalString) ?? new SwiftUrl(url.OriginalString);

    /// <summary>
    /// An absolute <see cref="Uri"/> from text, as <c>URL(string:)</c> would make it. Null for relative
    /// text, which Foundation would keep as a relative URL (and .NET on a Mac would read as a file path).
    /// </summary>
    public static Uri? MakeUri(string? text) =>
        Parse(text) is { Scheme: not null } url ? Urls.Parse(url.AbsoluteString) : null;

    /// <summary><c>URL.host</c>: percent-decoded, case kept, without user, port or IPv6 brackets.</summary>
    public string? Host
    {
        get
        {
            if (_parts.Authority is not { Length: > 0 } authority) return null;
            var hostAndPort = authority[(authority.LastIndexOf('@') + 1)..];
            string host;
            if (hostAndPort.StartsWith('['))
            {
                var close = hostAndPort.IndexOf(']');
                host = close < 0 ? hostAndPort[1..] : hostAndPort[1..close];
            }
            else
            {
                var colon = hostAndPort.IndexOf(':');
                host = colon < 0 ? hostAndPort : hostAndPort[..colon];
            }
            return UrlText.Decode(host);
        }
    }

    /// <summary>
    /// <c>URL.path</c>: percent-decoded, trailing slashes removed (a lone "/" stays). Empty when the
    /// escapes aren't valid UTF-8.
    /// </summary>
    public string Path
    {
        get
        {
            var decoded = UrlText.Decode(_parts.Path);
            if (decoded is null) return "";
            var trimmed = decoded.TrimEnd('/');
            return trimmed.Length == 0 && decoded.Length > 0 ? "/" : trimmed;
        }
    }

    /// <summary>
    /// <c>deletingPathExtension().lastPathComponent</c>. The extension comes off the encoded name, so
    /// "a.b%20c" loses ".b c"; the name is decoded afterwards, and is empty when that fails.
    /// </summary>
    public string LastPathComponentWithoutExtension
    {
        get
        {
            var path = _parts.Path;
            var trimmed = path.TrimEnd('/');
            if (trimmed.Length == 0) return path.Length > 0 ? "/" : "";
            var last = trimmed[(trimmed.LastIndexOf('/') + 1)..];
            var dot = last.LastIndexOf('.');
            if (dot > 0 && dot < last.Length - 1 && last[..dot].Any(c => c != '.')) last = last[..dot];
            return UrlText.Decode(last) ?? "";
        }
    }

    /// <summary>Foundation turns a host written in another script into punycode, кіно.укр into xn--j1agd8g.xn--j1amh.</summary>
    private static string PunycodeHost(string text)
    {
        var parts = UrlText.Split(text);
        if (parts.Authority is not { } authority || authority.All(char.IsAscii)) return text;
        var at = authority.LastIndexOf('@');
        var userInfo = authority[..(at + 1)];
        var hostAndPort = authority[(at + 1)..];
        if (hostAndPort.StartsWith('[')) return text;
        var colon = hostAndPort.IndexOf(':');
        var host = colon < 0 ? hostAndPort : hostAndPort[..colon];
        var port = colon < 0 ? "" : hostAndPort[colon..];
        if (host.All(char.IsAscii)) return text;
        string ascii;
        try
        {
            ascii = new IdnMapping().GetAscii(host);
        }
        catch (ArgumentException)
        {
            return text;
        }
        var start = text.IndexOf("//", StringComparison.Ordinal) + 2;
        return text[..start] + userInfo + ascii + port + text[(start + authority.Length)..];
    }
}
