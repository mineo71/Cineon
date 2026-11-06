using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Cineon.Core.Parsing;

/// <summary>
/// The pieces of Swift's string model the parsers depend on: characters are grapheme clusters,
/// <c>CharacterSet</c> works on scalars, and <c>NSRegularExpression</c> is ICU. Kept in one place so
/// the parsers read like the Swift they came from.
/// </summary>
internal static class SwiftText
{
    // MARK: Characters (grapheme clusters)

    /// <summary>Swift's <c>String.count</c>: grapheme clusters, not UTF-16 units.</summary>
    public static int Count(string s)
    {
        var count = 0;
        for (var i = 0; i < s.Length; i += StringInfo.GetNextTextElementLength(s, i)) count++;
        return count;
    }

    /// <summary>The characters of a string, in order.</summary>
    public static List<string> Characters(string s)
    {
        var list = new List<string>();
        for (var i = 0; i < s.Length;)
        {
            var length = StringInfo.GetNextTextElementLength(s, i);
            list.Add(s.Substring(i, length));
            i += length;
        }
        return list;
    }

    public static string? First(string s) => s.Length == 0 ? null : s[..StringInfo.GetNextTextElementLength(s, 0)];

    public static string? Last(string s)
    {
        if (s.Length == 0) return null;
        var start = 0;
        for (var i = 0; i < s.Length; i += StringInfo.GetNextTextElementLength(s, i)) start = i;
        return s[start..];
    }

    public static string DropFirst(string s) => s.Length == 0 ? s : s[StringInfo.GetNextTextElementLength(s, 0)..];

    public static string DropLast(string s)
    {
        var last = Last(s);
        return last is null ? s : s[..^last.Length];
    }

    /// <summary>How many characters equal <paramref name="character"/>.</summary>
    public static int CountOf(string s, Func<string, bool> predicate) => Characters(s).Count(predicate);

    /// <summary>
    /// Swift's <c>split(separator:)</c> with a one-character separator: on whole characters, without
    /// empty pieces. A space followed by a combining accent is a different character, so it doesn't split.
    /// </summary>
    public static List<string> Split(string s, string separator)
    {
        var parts = new List<string>();
        var current = new StringBuilder();
        foreach (var character in Characters(s))
        {
            if (character == separator)
            {
                if (current.Length > 0) parts.Add(current.ToString());
                current.Clear();
            }
            else
            {
                current.Append(character);
            }
        }
        if (current.Length > 0) parts.Add(current.ToString());
        return parts;
    }

    // MARK: Searching by character

    // Swift's contains, hasPrefix, hasSuffix, components(separatedBy:) and replacingOccurrences(of:with:)
    // compare whole characters, by canonical equivalence: "сериал́" doesn't contain "сериал", a
    // separator whose last space carries an accent doesn't split, and "й" contains "й".

    private readonly record struct Character(string Text, string Key);

    private static Character[] Keyed(string s)
    {
        var list = new List<Character>();
        for (var i = 0; i < s.Length;)
        {
            var length = StringInfo.GetNextTextElementLength(s, i);
            var text = s.Substring(i, length);
            list.Add(new Character(text, text.IsNormalized(NormalizationForm.FormC) ? text : text.Normalize(NormalizationForm.FormC)));
            i += length;
        }
        return [.. list];
    }

    private static bool MatchesAt(Character[] text, int at, Character[] pattern)
    {
        if (at + pattern.Length > text.Length) return false;
        for (var j = 0; j < pattern.Length; j++)
        {
            if (text[at + j].Key != pattern[j].Key) return false;
        }
        return true;
    }

    /// <summary>Text where every UTF-16 unit is a whole character: nothing that combines, and no CR (CR LF is one character).</summary>
    private static bool IsPlain(string s)
    {
        foreach (var c in s)
        {
            if (c >= 0x300 || c == '\r') return false;
        }
        return true;
    }

    public static bool Contains(string text, string pattern)
    {
        if (IsPlain(text) && IsPlain(pattern)) return text.Contains(pattern, StringComparison.Ordinal);
        var t = Keyed(text);
        var p = Keyed(pattern);
        if (p.Length == 0) return true;
        for (var i = 0; i + p.Length <= t.Length; i++)
        {
            if (MatchesAt(t, i, p)) return true;
        }
        return false;
    }

    public static bool HasPrefix(string text, string prefix)
    {
        if (IsPlain(text) && IsPlain(prefix)) return text.StartsWith(prefix, StringComparison.Ordinal);
        return MatchesAt(Keyed(text), 0, Keyed(prefix));
    }

    public static bool HasSuffix(string text, string suffix)
    {
        if (IsPlain(text) && IsPlain(suffix)) return text.EndsWith(suffix, StringComparison.Ordinal);
        var t = Keyed(text);
        var p = Keyed(suffix);
        return p.Length <= t.Length && MatchesAt(t, t.Length - p.Length, p);
    }

    /// <summary><c>components(separatedBy:)</c>: empty pieces kept.</summary>
    public static List<string> Components(string text, string separator)
    {
        if (IsPlain(text) && IsPlain(separator)) return [.. text.Split(separator)];
        var t = Keyed(text);
        var p = Keyed(separator);
        var parts = new List<string>();
        var current = new StringBuilder();
        for (var i = 0; i < t.Length;)
        {
            if (p.Length > 0 && MatchesAt(t, i, p))
            {
                parts.Add(current.ToString());
                current.Clear();
                i += p.Length;
            }
            else
            {
                current.Append(t[i].Text);
                i++;
            }
        }
        parts.Add(current.ToString());
        return parts;
    }

    /// <summary><c>replacingOccurrences(of:with:)</c>.</summary>
    public static string Replace(string text, string old, string replacement) =>
        IsPlain(text) && IsPlain(old) ? text.Replace(old, replacement, StringComparison.Ordinal) : string.Join(replacement, Components(text, old));

    /// <summary><c>Character.isNumber</c>: any numeric type, which includes CJK numerals like 一 and 百.</summary>
    public static bool IsNumber(string character)
    {
        if (character.Length == 0) return false;
        var rune = Rune.GetRuneAt(character, 0);
        return Rune.GetUnicodeCategory(rune) is UnicodeCategory.DecimalDigitNumber or UnicodeCategory.LetterNumber
                   or UnicodeCategory.OtherNumber
               || HanNumerals.Contains(rune.Value);
    }

    /// <summary>Ideographs that Unicode gives a numeric value, which Swift counts as numbers. From Swift itself.</summary>
    private static readonly HashSet<int> HanNumerals =
    [
        0x3405, 0x3483, 0x382a, 0x3b4d, 0x4e00, 0x4e03, 0x4e07, 0x4e09, 0x4e24, 0x4e5d, 0x4e8c, 0x4e94, 0x4e96,
        0x4eac, 0x4ebf, 0x4ec0, 0x4edf, 0x4ee8, 0x4f0d, 0x4f70, 0x4fe9, 0x5006, 0x5104, 0x5146, 0x5169, 0x516b,
        0x516d, 0x5341, 0x5343, 0x5344, 0x5345, 0x534c, 0x53c1, 0x53c2, 0x53c3, 0x53c4, 0x56db, 0x58f1, 0x58f9,
        0x5e7a, 0x5efe, 0x5eff, 0x5f0c, 0x5f0d, 0x5f0e, 0x5f10, 0x62d0, 0x62fe, 0x634c, 0x67d2, 0x6d1e, 0x6f06,
        0x7396, 0x767e, 0x7695, 0x79ed, 0x8086, 0x842c, 0x8cae, 0x8cb3, 0x8d30, 0x920e, 0x94a9, 0x9621, 0x9646,
        0x964c, 0x9678, 0x96f6, 0xf96b, 0xf973, 0xf978, 0xf9b2, 0xf9d1, 0xf9d3, 0xf9fd, 0x12038, 0x12039,
        0x12079, 0x12226, 0x1222b, 0x1230b, 0x1230d, 0x12399, 0x20001, 0x20064, 0x200e2, 0x20121, 0x2092a,
        0x20983, 0x2098c, 0x2099c, 0x20aea, 0x20afd, 0x20b19, 0x22390, 0x22998, 0x23b1b, 0x2626d, 0x2f890,
    ];

    // MARK: Case

    /// <summary>Swift's <c>lowercased()</c>: full mappings, so İ becomes i and a combining dot.</summary>
    public static string Lowercased(string s) =>
        s.Contains('İ') ? s.Replace("İ", "i̇").ToLowerInvariant() : s.ToLowerInvariant();

    /// <summary>Swift's <c>uppercased()</c>: full mappings, so ß becomes SS and ﬁ becomes FI.</summary>
    public static string Uppercased(string s)
    {
        var sb = new StringBuilder(s.Length);
        foreach (var rune in s.EnumerateRunes())
        {
            if (FullUppercase.TryGetValue(rune.Value, out var mapped)) sb.Append(mapped);
            else sb.Append(Rune.ToUpperInvariant(rune).ToString());
        }
        return sb.ToString();
    }

    /// <summary>The scalars whose upper case is more than one scalar. From Swift itself.</summary>
    private static readonly Dictionary<int, string> FullUppercase = BuildFullUppercase(
        "df 53 53|149 2bc 4e|1f0 4a 30c|390 399 308 301|3b0 3a5 308 301|587 535 552|1e96 48 331|1e97 54 308|" +
        "1e98 57 30a|1e99 59 30a|1e9a 41 2be|1f50 3a5 313|1f52 3a5 313 300|1f54 3a5 313 301|1f56 3a5 313 342|" +
        "1f80 1f08 399|1f81 1f09 399|1f82 1f0a 399|1f83 1f0b 399|1f84 1f0c 399|1f85 1f0d 399|1f86 1f0e 399|" +
        "1f87 1f0f 399|1f88 1f08 399|1f89 1f09 399|1f8a 1f0a 399|1f8b 1f0b 399|1f8c 1f0c 399|1f8d 1f0d 399|" +
        "1f8e 1f0e 399|1f8f 1f0f 399|1f90 1f28 399|1f91 1f29 399|1f92 1f2a 399|1f93 1f2b 399|1f94 1f2c 399|" +
        "1f95 1f2d 399|1f96 1f2e 399|1f97 1f2f 399|1f98 1f28 399|1f99 1f29 399|1f9a 1f2a 399|1f9b 1f2b 399|" +
        "1f9c 1f2c 399|1f9d 1f2d 399|1f9e 1f2e 399|1f9f 1f2f 399|1fa0 1f68 399|1fa1 1f69 399|1fa2 1f6a 399|" +
        "1fa3 1f6b 399|1fa4 1f6c 399|1fa5 1f6d 399|1fa6 1f6e 399|1fa7 1f6f 399|1fa8 1f68 399|1fa9 1f69 399|" +
        "1faa 1f6a 399|1fab 1f6b 399|1fac 1f6c 399|1fad 1f6d 399|1fae 1f6e 399|1faf 1f6f 399|1fb2 1fba 399|" +
        "1fb3 391 399|1fb4 386 399|1fb6 391 342|1fb7 391 342 399|1fbc 391 399|1fc2 1fca 399|1fc3 397 399|" +
        "1fc4 389 399|1fc6 397 342|1fc7 397 342 399|1fcc 397 399|1fd2 399 308 300|1fd3 399 308 301|" +
        "1fd6 399 342|1fd7 399 308 342|1fe2 3a5 308 300|1fe3 3a5 308 301|1fe4 3a1 313|1fe6 3a5 342|" +
        "1fe7 3a5 308 342|1ff2 1ffa 399|1ff3 3a9 399|1ff4 38f 399|1ff6 3a9 342|1ff7 3a9 342 399|1ffc 3a9 399|" +
        "fb00 46 46|fb01 46 49|fb02 46 4c|fb03 46 46 49|fb04 46 46 4c|fb05 53 54|fb06 53 54|fb13 544 546|" +
        "fb14 544 535|fb15 544 53b|fb16 54e 546|fb17 544 53d");

    private static Dictionary<int, string> BuildFullUppercase(string table)
    {
        var map = new Dictionary<int, string>();
        foreach (var entry in table.Split('|'))
        {
            var values = entry.Split(' ').Select(hex => int.Parse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture)).ToArray();
            map[values[0]] = string.Concat(values.Skip(1).Select(char.ConvertFromUtf32));
        }
        return map;
    }

    // MARK: CharacterSet (scalars)

    /// <summary>
    /// <c>CharacterSet.whitespacesAndNewlines</c>: Z*, U+0009 to U+000D and U+0085, and, as in
    /// CoreFoundation, the zero-width space U+200B.
    /// </summary>
    public static bool IsWhitespaceOrNewline(Rune r) =>
        r.Value is >= 0x09 and <= 0x0D or 0x85 or 0x200B || Rune.GetUnicodeCategory(r) is UnicodeCategory.SpaceSeparator
            or UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator;

    /// <summary><c>CharacterSet.whitespaces</c>: Zs, tab and U+200B.</summary>
    public static bool IsWhitespace(Rune r) => r.Value is 0x09 or 0x200B || Rune.GetUnicodeCategory(r) == UnicodeCategory.SpaceSeparator;

    /// <summary><c>CharacterSet.letters</c>: L* and M*, less the scripts newer than Foundation's tables.</summary>
    public static bool IsLetter(Rune r) => Rune.GetUnicodeCategory(r) is UnicodeCategory.UppercaseLetter
        or UnicodeCategory.LowercaseLetter or UnicodeCategory.TitlecaseLetter or UnicodeCategory.ModifierLetter
        or UnicodeCategory.OtherLetter or UnicodeCategory.NonSpacingMark or UnicodeCategory.SpacingCombiningMark
        or UnicodeCategory.EnclosingMark
        && r.Value is not (>= 0x105C0 and <= 0x105F3 or >= 0x17000 and <= 0x187FF or >= 0x18D00 and <= 0x18D1E);

    /// <summary><c>CharacterSet.decimalDigits</c>: Nd.</summary>
    public static bool IsDecimalDigit(Rune r) => Rune.GetUnicodeCategory(r) == UnicodeCategory.DecimalDigitNumber;

    /// <summary><c>CharacterSet.alphanumerics</c>: L*, M* and N*.</summary>
    public static bool IsAlphanumeric(Rune r) => IsLetter(r) || Rune.GetUnicodeCategory(r) is UnicodeCategory.DecimalDigitNumber
        or UnicodeCategory.LetterNumber or UnicodeCategory.OtherNumber;

    /// <summary><c>rangeOfCharacter(from:) != nil</c>.</summary>
    public static bool ContainsAny(string s, Func<Rune, bool> set)
    {
        foreach (var rune in s.EnumerateRunes())
        {
            if (set(rune)) return true;
        }
        return false;
    }

    /// <summary><c>trimmingCharacters(in:)</c>, which works scalar by scalar.</summary>
    public static string Trim(string s, Func<Rune, bool> set)
    {
        var start = 0;
        while (start < s.Length)
        {
            var rune = Rune.GetRuneAt(s, start);
            if (!set(rune)) break;
            start += rune.Utf16SequenceLength;
        }
        var end = s.Length;
        while (end > start)
        {
            var index = char.IsLowSurrogate(s[end - 1]) && end - 2 >= start && char.IsHighSurrogate(s[end - 2]) ? end - 2 : end - 1;
            var rune = Rune.GetRuneAt(s, index);
            if (!set(rune)) break;
            end = index;
        }
        return s[start..end];
    }

    public static string TrimWhitespacesAndNewlines(string s) => Trim(s, IsWhitespaceOrNewline);

    /// <summary>Swift's <c>Int(_:)</c> for text: optional sign, ASCII digits only, 64-bit.</summary>
    public static long? Int(string s) =>
        s.Length > 0 && s.All(c => char.IsAsciiDigit(c) || c is '+' or '-')
        && long.TryParse(s, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var value)
            ? value
            : null;

    /// <summary><see cref="Int"/> narrowed to an <c>int</c>, for values that are small in practice.</summary>
    public static int? Int32(string s) => Int(s) is long value && value is >= int.MinValue and <= int.MaxValue ? (int)value : null;

    // MARK: Regular expressions

    /// <summary>
    /// Turns an ICU pattern, as <c>NSRegularExpression</c> reads it, into a .NET one that matches the
    /// same text: ICU's <c>\w</c> knows combining marks and letter numbers, its <c>\b</c> looks past
    /// combining marks, its <c>.</c> stops at every line break, and its <c>$</c> allows any line break
    /// before the end.
    /// </summary>
    public static Regex Icu(string pattern, bool ignoreCase = false)
    {
        // ICU's \w: Alphabetic, marks, decimal digits, connector punctuation, ZWNJ and ZWJ.
        const string word = @"\p{L}\p{M}\p{Nd}\p{Nl}\p{Pc}Ⓐ-ⓩ‌‍";
        // What ICU's \b steps over: Grapheme_Extend and format characters.
        const string extend = @"\p{Mn}\p{Me}\p{Cf}‌ﾞﾟ";
        const string dot = @"[^\n\v\f\r\u0085  ]";
        const string dollar = @"(?:\z|(?=[\v\f\r\u0085  ]\z)|(?<!\r)(?=\n\z)|(?=\r\n\z))";
        const string before = "[" + word + "-[" + extend + "]][" + extend + "]*";
        const string boundary = "(?:(?![" + extend + "])(?:(?<=" + before + ")(?![" + word + "])|(?<!" + before + ")(?=[" + word + "])))";

        var sb = new StringBuilder(pattern.Length * 2);
        var inClass = false;
        for (var i = 0; i < pattern.Length; i++)
        {
            var c = pattern[i];
            if (c == '\\' && i + 1 < pattern.Length)
            {
                var next = pattern[i + 1];
                i++;
                switch (next)
                {
                    case 'w':
                        sb.Append(inClass ? word : "[" + word + "]");
                        break;
                    case 'b' when !inClass:
                        sb.Append(boundary);
                        break;
                    default:
                        sb.Append('\\').Append(next);
                        break;
                }
                continue;
            }
            if (inClass)
            {
                if (c == ']') inClass = false;
                sb.Append(c);
                continue;
            }
            switch (c)
            {
                case '[':
                    inClass = true;
                    sb.Append(c);
                    // A ] straight after [ or [^ is a literal.
                    if (i + 1 < pattern.Length && pattern[i + 1] == '^')
                    {
                        sb.Append('^');
                        i++;
                    }
                    if (i + 1 < pattern.Length && pattern[i + 1] == ']')
                    {
                        sb.Append(@"\]");
                        i++;
                    }
                    break;
                case '.':
                    sb.Append(dot);
                    break;
                case '$':
                    sb.Append(dollar);
                    break;
                default:
                    sb.Append(c);
                    break;
            }
        }
        var options = RegexOptions.CultureInvariant;
        if (ignoreCase) options |= RegexOptions.IgnoreCase;
        return new Regex(sb.ToString(), options);
    }
}
