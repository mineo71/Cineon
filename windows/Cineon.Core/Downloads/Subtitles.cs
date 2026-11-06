using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Cineon.Core.Data;

namespace Cineon.Core.Downloads;

// Port of Cineon/Downloads/Subtitles.swift.

public readonly record struct SubtitleCue(double Start, double End, string Text);

/// <summary>A subtitle file saved next to a download, WebVTT or SubRip.</summary>
public sealed partial record SubtitleTrack
{
    /// <summary>The file's path.</summary>
    public required string Id { get; init; }
    public required string Label { get; init; }
    public IReadOnlyList<SubtitleCue> Cues { get; init => field = ValueList<SubtitleCue>.Of(value); } = ValueList<SubtitleCue>.Empty;

    static SubtitleTrack()
    {
        // Windows-1251, for Cyrillic SubRip files that aren't UTF-8.
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
    }

    public static SubtitleTrack? Load(string path)
    {
        byte[] data;
        try
        {
            data = File.ReadAllBytes(path);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
        var cues = Parse(Decode(data));
        if (cues.Count == 0) return null;
        // "Film [1080p].en.vtt" is labelled by the part before the extension.
        var stem = Path.GetFileNameWithoutExtension(path);
        var dot = stem.LastIndexOf('.');
        var code = dot > 0 && dot < stem.Length - 1 ? stem[(dot + 1)..] : "";
        return new SubtitleTrack { Id = path, Label = DisplayName(code), Cues = cues };
    }

    /// <summary>UTF-8, or Windows-1251 when the bytes aren't valid UTF-8, like the Mac.</summary>
    internal static string Decode(byte[] data)
    {
        try
        {
            return new UTF8Encoding(false, true).GetString(data);
        }
        catch (DecoderFallbackException)
        {
        }
        try
        {
            return Encoding.GetEncoding(1251).GetString(data);
        }
        catch (Exception e) when (e is ArgumentException or NotSupportedException)
        {
            return "";
        }
    }

    public static List<SubtitleCue> Parse(string raw)
    {
        var text = raw.Replace("\r\n", "\n").Replace('\r', '\n');
        var cues = new List<SubtitleCue>();
        foreach (var block in text.Split("\n\n"))
        {
            var lines = block.Split('\n');
            var timing = Array.FindIndex(lines, l => l.Contains("-->", StringComparison.Ordinal));
            if (timing < 0) continue;
            var parts = lines[timing].Split("-->");
            if (parts.Length != 2 ||
                Time(parts[0]) is not double start ||
                Time(parts[1].Trim(' ', '\t').Split(' ')[0]) is not double end)
            {
                continue;
            }
            var body = string.Join("\n", lines.Skip(timing + 1).Select(Clean).Where(l => l.Length > 0));
            if (body.Length == 0 || end <= start) continue;
            cues.Add(new SubtitleCue(start, end, body));
        }
        return [.. cues.OrderBy(c => c.Start)];
    }

    /// <summary>What should be on screen at this moment, if anything.</summary>
    public string? Text(double time)
    {
        var low = 0;
        var high = Cues.Count - 1;
        int? found = null;
        // The last cue starting at or before now.
        while (low <= high)
        {
            var mid = (low + high) / 2;
            if (Cues[mid].Start <= time)
            {
                found = mid;
                low = mid + 1;
            }
            else
            {
                high = mid - 1;
            }
        }
        if (found is not int last) return null;
        // Cues can overlap. Show every one that covers now, oldest first.
        var lines = new List<string>();
        for (var index = last; index >= 0 && index >= last - 4; index--)
        {
            var cue = Cues[index];
            if (cue.Start <= time && time < cue.End) lines.Insert(0, cue.Text);
        }
        return lines.Count == 0 ? null : string.Join("\n", lines);
    }

    /// <summary><c>00:01:02.345</c>, <c>01:02.345</c> or SubRip's <c>00:01:02,345</c>.</summary>
    public static double? Time(string raw)
    {
        var parts = raw.Trim(' ', '\t').Replace(',', '.').Split(':', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length is < 2 or > 3) return null;
        var seconds = 0.0;
        foreach (var part in parts)
        {
            if (!double.TryParse(part, NumberStyles.AllowDecimalPoint | NumberStyles.AllowLeadingSign | NumberStyles.AllowExponent,
                    CultureInfo.InvariantCulture, out var value))
            {
                return null;
            }
            seconds = seconds * 60 + value;
        }
        return seconds;
    }

    [GeneratedRegex("<[^>]+>")]
    private static partial Regex Tag();

    [GeneratedRegex(@"\{\\[^}]*\}")]
    private static partial Regex Override();

    private static string Clean(string line) =>
        Override().Replace(Tag().Replace(line, ""), "")
            .Replace("&nbsp;", " ")
            .Replace("&amp;", "&")
            .Replace("&lt;", "<")
            .Replace("&gt;", ">")
            .Trim(' ', '\t');

    private static readonly Dictionary<string, string> Languages = new()
    {
        ["en"] = "en", ["eng"] = "en", ["english"] = "en",
        ["uk"] = "uk", ["ua"] = "uk", ["ukr"] = "uk", ["ukrainian"] = "uk", ["украинский"] = "uk", ["українська"] = "uk",
        ["ru"] = "ru", ["rus"] = "ru", ["russian"] = "ru", ["русский"] = "ru",
        ["de"] = "de", ["ger"] = "de", ["deu"] = "de", ["fr"] = "fr", ["fre"] = "fr", ["fra"] = "fr", ["es"] = "es", ["spa"] = "es",
        ["it"] = "it", ["ita"] = "it", ["pl"] = "pl", ["pol"] = "pl", ["pt"] = "pt", ["por"] = "pt", ["ja"] = "ja", ["jpn"] = "ja",
    };

    /// <summary>A short language code from a subtitle address, or a number when there's none.</summary>
    public static string LabelFor(Uri url, int index)
    {
        if (url.IsFile) return LabelForFile(url.LocalPath, index);
        var path = Import.SwiftUrl.Path(url);
        return LabelFromComponents(path.Split('/', StringSplitOptions.RemoveEmptyEntries), index);
    }

    /// <summary><see cref="LabelFor(Uri, int)"/> for a file on this PC, such as one someone picked.</summary>
    public static string LabelForFile(string path, int index) =>
        LabelFromComponents(path.Split(['/', '\\'], StringSplitOptions.RemoveEmptyEntries), index);

    private static string LabelFromComponents(string[] components, int index)
    {
        if (components.Length > 0)
        {
            // The last two components, without the file's extension.
            var last = components[^1];
            var dot = last.LastIndexOf('.');
            if (dot > 0) components[^1] = last[..dot];
        }
        var words = components.TakeLast(2)
            .SelectMany(component => SplitWords(component.ToLowerInvariant()))
            .Reverse();
        foreach (var word in words)
        {
            if (Languages.TryGetValue(word, out var code)) return code;
        }
        return "sub" + (index + 1).ToString(CultureInfo.InvariantCulture);
    }

    /// <summary>Splits on anything that isn't a letter, mark or digit, like <c>CharacterSet.alphanumerics.inverted</c>.</summary>
    private static IEnumerable<string> SplitWords(string text)
    {
        var word = new StringBuilder();
        foreach (var rune in text.EnumerateRunes())
        {
            var category = Rune.GetUnicodeCategory(rune);
            var isAlphanumeric = Rune.IsLetterOrDigit(rune) || Rune.IsNumber(rune) ||
                category is UnicodeCategory.NonSpacingMark or UnicodeCategory.SpacingCombiningMark or UnicodeCategory.EnclosingMark;
            if (isAlphanumeric)
            {
                word.Append(rune.ToString());
            }
            else
            {
                yield return word.ToString();
                word.Clear();
            }
        }
        yield return word.ToString();
    }

    /// <summary>"Subtitles 3" for a numbered track, otherwise the language's name: "English", "Ukrainian".</summary>
    public static string DisplayName(string code)
    {
        if (code.StartsWith("sub", StringComparison.Ordinal)) return "Subtitles " + code[3..];
        try
        {
            var culture = CultureInfo.GetCultureInfo(code);
            var name = culture.DisplayName;
            if (culture.Name.Length > 0 && name.Length > 0 && !string.Equals(name, code, StringComparison.OrdinalIgnoreCase))
            {
                return CultureInfo.CurrentCulture.TextInfo.ToTitleCase(name);
            }
        }
        catch (CultureNotFoundException)
        {
        }
        return code.ToUpperInvariant();
    }
}
