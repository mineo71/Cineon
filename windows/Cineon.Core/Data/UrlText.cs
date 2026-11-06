using System.Text;
using System.Text.RegularExpressions;

namespace Cineon.Core.Data;

/// <summary>
/// Percent-encoding the way Foundation's <c>URLComponents</c> and <c>CharacterSet.url*Allowed</c> do
/// it, so keys and addresses built here match the ones the Mac app stored.
/// </summary>
internal static partial class UrlText
{
    private static bool IsAlphaNumeric(char c) => c is >= 'a' and <= 'z' or >= 'A' and <= 'Z' or >= '0' and <= '9';

    /// <summary><c>CharacterSet.urlQueryAllowed</c>.</summary>
    public static bool QueryAllowed(char c) => IsAlphaNumeric(c) || "-._~!$&'()*+,;=:@/?".Contains(c);

    /// <summary>What <c>URLComponents.queryItems</c> leaves alone in a name or value: no <c>&amp;</c> or <c>=</c>.</summary>
    public static bool QueryItemAllowed(char c) => IsAlphaNumeric(c) || "-._~!$'()*+,;:@/?".Contains(c);

    /// <summary><c>CharacterSet.urlPathAllowed</c>.</summary>
    public static bool PathAllowed(char c) => IsAlphaNumeric(c) || "-._~!$&'()*+,;=:@/".Contains(c);

    /// <summary><c>CharacterSet.urlFragmentAllowed</c>.</summary>
    public static bool FragmentAllowed(char c) => IsAlphaNumeric(c) || "-._~!$&'()*+,;=:@/?".Contains(c);

    /// <summary><c>CharacterSet.urlHostAllowed</c>.</summary>
    public static bool HostAllowed(char c) => IsAlphaNumeric(c) || "-._~!$&'()*+,;=:[]".Contains(c);

    /// <summary>Percent-encodes, as UTF-8 with upper-case hex, everything <paramref name="allowed"/> refuses.</summary>
    public static string Encode(string text, Func<char, bool> allowed)
    {
        var sb = new StringBuilder(text.Length);
        Span<byte> bytes = stackalloc byte[4];
        foreach (var rune in text.EnumerateRunes())
        {
            if (rune.IsAscii && allowed((char)rune.Value))
            {
                sb.Append((char)rune.Value);
                continue;
            }
            var count = rune.EncodeToUtf8(bytes);
            for (var i = 0; i < count; i++) sb.Append('%').Append(bytes[i].ToString("X2"));
        }
        return sb.ToString();
    }

    /// <summary>Removes percent-encoding. Null when the escapes aren't valid UTF-8, like Swift's <c>removingPercentEncoding</c>.</summary>
    public static string? Decode(string text)
    {
        if (!text.Contains('%')) return text;
        var bytes = new List<byte>(text.Length);
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (c == '%' && i + 2 < text.Length && IsHex(text[i + 1]) && IsHex(text[i + 2]))
            {
                bytes.Add(Convert.ToByte(text.Substring(i + 1, 2), 16));
                i += 2;
                continue;
            }
            if (c == '%') return null;
            var end = char.IsHighSurrogate(c) && i + 1 < text.Length ? 2 : 1;
            bytes.AddRange(Encoding.UTF8.GetBytes(text.Substring(i, end)));
            i += end - 1;
        }
        try
        {
            return new UTF8Encoding(false, true).GetString(bytes.ToArray());
        }
        catch (DecoderFallbackException)
        {
            return null;
        }
    }

    private static bool IsHex(char c) => c is >= '0' and <= '9' or >= 'a' and <= 'f' or >= 'A' and <= 'F';

    /// <summary>
    /// What <c>URL(string:)</c> does to text that isn't a valid address yet: characters that can't
    /// appear in one are percent-encoded, everything else is kept as written.
    /// </summary>
    public static string EncodeInvalid(string text)
    {
        var sb = new StringBuilder(text.Length);
        Span<byte> bytes = stackalloc byte[4];
        var seenFragment = false;
        var i = 0;
        foreach (var rune in text.EnumerateRunes())
        {
            var at = i;
            i += rune.Utf16SequenceLength;
            if (rune.IsAscii)
            {
                var c = (char)rune.Value;
                if (c == '%')
                {
                    if (at + 2 < text.Length && IsHex(text[at + 1]) && IsHex(text[at + 2])) sb.Append('%');
                    else sb.Append("%25");
                    continue;
                }
                if (c == '#')
                {
                    sb.Append(seenFragment ? "%23" : "#");
                    seenFragment = true;
                    continue;
                }
                if (IsAlphaNumeric(c) || "-._~:/?[]@!$&'()*+,;=".Contains(c))
                {
                    sb.Append(c);
                    continue;
                }
            }
            var count = rune.EncodeToUtf8(bytes);
            for (var b = 0; b < count; b++) sb.Append('%').Append(bytes[b].ToString("X2"));
        }
        return sb.ToString();
    }

    /// <summary>The parts of an address, split as RFC 3986 appendix B does.</summary>
    public readonly record struct Parts(string? Scheme, string? Authority, string Path, string? Query, string? Fragment);

    public static Parts Split(string text)
    {
        var m = Rfc3986().Match(text);
        return new Parts(
            m.Groups[1].Success ? m.Groups[2].Value : null,
            m.Groups[3].Success ? m.Groups[4].Value : null,
            m.Groups[5].Value,
            m.Groups[6].Success ? m.Groups[7].Value : null,
            m.Groups[8].Success ? m.Groups[9].Value : null);
    }

    [GeneratedRegex(@"^(([^:/?#]+):)?(//([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?$", RegexOptions.Singleline)]
    private static partial Regex Rfc3986();
}
