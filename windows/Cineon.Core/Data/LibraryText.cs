using System.Globalization;
using System.Text;

namespace Cineon.Core.Data;

/// <summary>
/// The two text rules the library is keyed on. These are exact ports of the Mac's
/// <c>TitleParser.normalize</c> and <c>ProfileStats.canonicalGenre</c>, kept here because
/// <c>titles.norm_name</c> in the database depends on them. The Parsing and Profile ports should
/// forward to these rather than keep their own copies, so the keys never drift apart.
/// </summary>
public static class LibraryText
{
    /// <summary>
    /// A title's matching key: case, width and diacritics folded away, then only letters, marks and
    /// numbers kept. "Dune: Part Two" becomes "duneparttwo", "Ёлки 2" becomes "елки2".
    /// Matches Foundation's <c>folding([.diacriticInsensitive, .caseInsensitive, .widthInsensitive])</c>
    /// followed by a <c>CharacterSet.alphanumerics</c> filter.
    /// </summary>
    public static string Normalize(string s)
    {
        if (string.IsNullOrEmpty(s)) return "";

        // Width and case.
        var folded = new StringBuilder(s.Length);
        var index = 0;
        foreach (var rune in s.EnumerateRunes())
        {
            var value = rune.Value;
            var isFirst = index++ == 0;
            if (value == 0x3000)
            {
                folded.Append(' ');
                continue;
            }
            if (value is >= 0xFF01 and <= 0xFF5E)
            {
                AppendCaseFolded(folded, new Rune(value - 0xFEE0));
                continue;
            }
            if (value is >= 0xFF61 and <= 0xFFEE)
            {
                // Foundation leaves a half-width voicing mark alone after a letter.
                if (value is 0xFF9E or 0xFF9F && !isFirst)
                {
                    folded.Append(rune.ToString());
                    continue;
                }
                folded.Append(rune.ToString().Normalize(NormalizationForm.FormKC));
                continue;
            }
            AppendCaseFolded(folded, rune);
        }

        // Diacritics: decompose, drop the combining accents, put back together.
        var decomposed = folded.ToString().Normalize(NormalizationForm.FormD);
        var stripped = new StringBuilder(decomposed.Length);
        foreach (var rune in decomposed.EnumerateRunes())
        {
            if (!IsDiacritic(rune.Value)) stripped.Append(rune.ToString());
        }
        var composed = stripped.ToString().Normalize(NormalizationForm.FormC);

        var result = new StringBuilder(composed.Length);
        foreach (var rune in composed.EnumerateRunes())
        {
            if (IsAlphanumeric(rune)) result.Append(rune.ToString());
        }
        return result.ToString();
    }

    /// <summary>One name per genre, whatever the source called it.</summary>
    public static string CanonicalGenre(string raw)
    {
        var lower = raw.ToLowerInvariant().Trim(' ', '\t');
        switch (lower)
        {
            case "science fiction" or "sci-fi" or "scifi" or "science-fiction": return "Sci-Fi";
            case "film-noir" or "film noir": return "Film-Noir";
            case "tv movie": return "TV Movie";
        }
        if (raw.Length == 0) return raw;
        var first = StringInfo.GetNextTextElementLength(raw);
        return raw[..first].ToUpperInvariant() + raw[first..];
    }

    private static void AppendCaseFolded(StringBuilder sb, Rune rune)
    {
        var special = rune.Value switch
        {
            0x00DF or 0x1E9E => "ss",
            0xFB00 => "ff",
            0xFB01 => "fi",
            0xFB02 => "fl",
            0xFB03 => "ffi",
            0xFB04 => "ffl",
            0xFB05 or 0xFB06 => "st",
            0xFB13 => "մն",
            0xFB14 => "մե",
            0xFB15 => "մի",
            0xFB16 => "վն",
            0xFB17 => "մխ",
            0x0587 => "եւ",
            0x0149 => "ʼn",
            0x017F => "s",
            0x00B5 => "μ",
            0x03C2 => "σ",
            0x03D0 => "β",
            0x03D1 => "θ",
            0x03D5 => "φ",
            0x03D6 => "π",
            0x03F0 => "κ",
            0x03F1 => "ρ",
            0x03F5 => "ε",
            0x1E9B => "ṡ",
            0x1FBE => "ι",
            0x0130 => "i",
            _ => null,
        };
        if (special is not null) sb.Append(special);
        else sb.Append(Rune.ToLowerInvariant(rune).ToString());
    }

    /// <summary>The combining accents Foundation's diacritic folding removes.</summary>
    private static bool IsDiacritic(int value) =>
        value is >= 0x0300 and <= 0x036F
            or >= 0x1AB0 and <= 0x1AFF
            or >= 0x1DC0 and <= 0x1DFF
            or >= 0x20D0 and <= 0x20FF
            or >= 0xFE20 and <= 0xFE2F;

    /// <summary><c>CharacterSet.alphanumerics</c>: Unicode categories L*, M* and N*.</summary>
    private static bool IsAlphanumeric(Rune rune) => Rune.GetUnicodeCategory(rune) switch
    {
        UnicodeCategory.UppercaseLetter or UnicodeCategory.LowercaseLetter or UnicodeCategory.TitlecaseLetter
            or UnicodeCategory.ModifierLetter or UnicodeCategory.OtherLetter => true,
        UnicodeCategory.NonSpacingMark or UnicodeCategory.SpacingCombiningMark or UnicodeCategory.EnclosingMark => true,
        UnicodeCategory.DecimalDigitNumber or UnicodeCategory.LetterNumber or UnicodeCategory.OtherNumber => true,
        _ => false,
    };
}
