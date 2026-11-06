using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Cineon.Core.Data;
using Cineon.Core.Import;

namespace Cineon.Core.Tests.Import;

/// <summary>
/// The part of Cineon/Core/TitleParser.swift the import uses (a page's address and title, no meta tags),
/// ported here so the import tests can keep the Mac's expectations while the Parsing port is
/// separate. The app plugs the real <c>Cineon.Core.Parsing.TitleParser</c> into <see cref="ITitleRecognizer"/>.
/// </summary>
internal sealed class TestTitleParser : ITitleRecognizer
{
    public static readonly TestTitleParser Shared = new();

    private const RegexOptions Ci = RegexOptions.IgnoreCase | RegexOptions.CultureInvariant;

    public RecognizedTitle? Parse(string url, string title)
    {
        var address = Urls.Parse(url);
        var host = address is null ? "" : address.Host;
        var siteTokens = SiteNames(host);

        Parsed? result = null;
        if (Clean(title, siteTokens) is { } fromTitle) result = fromTitle with { Confidence = 0.6 };
        if (result is null && address is not null && ParseSlug(address) is { } fromSlug) result = fromSlug with { Confidence = 0.35 };
        if (result is not { } parsed) return null;

        // Season and episode may live in any of these, even when the name came from elsewhere.
        if (!parsed.Ref.IsEpisode)
        {
            foreach (var text in new[] { title, Decode(url) })
            {
                if (EpisodeRefIn(text) is { } found)
                {
                    parsed = parsed with { Ref = found };
                    break;
                }
            }
        }
        if (parsed.Ref.IsEpisode) parsed = parsed with { Kind = TitleKind.Series };
        if (parsed.Kind == TitleKind.Unknown) parsed = parsed with { Kind = KindHint(title + " ") };
        if (address is not null)
        {
            var path = Path(address).ToLowerInvariant();
            if (Regex.IsMatch(path, "/(cartoons?|animation|anime|mult|multfilm|multfilmy|multiki)(/|$)"))
            {
                parsed = parsed with { Kind = TitleKind.Cartoon };
            }
            else if (parsed.Kind == TitleKind.Unknown)
            {
                if (Regex.IsMatch(path, "/(series|serial|serials|serialy|tv|tv-?shows?)(/|$)")) parsed = parsed with { Kind = TitleKind.Series };
                else if (Regex.IsMatch(path, "/(films?|filmy|filmi|movies?)(/|$)")) parsed = parsed with { Kind = TitleKind.Film };
            }
        }
        return new RecognizedTitle
        {
            Name = parsed.Name, AltName = parsed.AltName, Year = parsed.Year, Ref = parsed.Ref, KindHint = parsed.Kind,
            Confidence = parsed.Confidence,
        };
    }

    private sealed record Parsed(string Name, string? AltName, int? Year, EpisodeRef Ref, TitleKind Kind, double Confidence);

    private static string Decode(string url)
    {
        try
        {
            return Uri.UnescapeDataString(url);
        }
        catch (UriFormatException)
        {
            return url;
        }
    }

    private static string Path(Uri url)
    {
        var path = Decode(url.AbsolutePath);
        return path.Length > 1 ? path.TrimEnd('/') : path;
    }

    // MARK: Cleaning

    private static readonly string[] NoisePhrases =
    [
        "watch online free", "watch online for free", "watch free online", "watch full movie online",
        "watch full movie", "watch movie online", "watch series online", "watch tv show online",
        "full movie online", "full movie", "full episodes", "free online", "for free", "online free",
        "stream online", "streaming online", "with english subtitles", "with subtitles", "english subtitles",
        "english subbed", "english dubbed", "in hd", "hd online", "free hd", "official site", "tv show", "tv series",
        "movie online", "film online", "movie free", "film free",
        "watch", "streaming", "stream", "online", "free", "subbed", "dubbed",
        "1080p", "720p", "480p", "2160p", "4k", "uhd", "fullhd", "full hd", "hdrip", "bdrip", "webrip", "web-dl", "hd",
        "60fps", "30fps", "hdr", "free download", "download",
        "дивитись онлайн безкоштовно", "дивитися онлайн безкоштовно", "дивитись онлайн", "дивитися онлайн",
        "дивитись безкоштовно", "дивитися безкоштовно", "дивитись", "дивитися", "онлайн безкоштовно",
        "у хорошій якості", "в хорошій якості", "в гарній якості", "у гарній якості", "у високій якості",
        "українською мовою", "українською", "безкоштовно", "без реєстрації", "всі серії", "усі серії", "всі сезони",
        "смотреть онлайн бесплатно", "смотреть бесплатно", "смотреть онлайн", "смотреть", "онлайн бесплатно",
        "в хорошем качестве", "в высоком качестве", "на русском языке", "на русском", "бесплатно",
        "без регистрации", "все серии", "все сезоны", "онлайн", "фильм", "фільм", "сериал", "серіал",
        "мультфильм", "мультфільм", "мультсериал", "мультсеріал", "аниме", "аніме", "кино", "кіно",
    ];

    private static readonly Regex Noise = new(
        @"(?<![\p{L}\p{N}])(?:" + string.Join("|", NoisePhrases.OrderByDescending(p => p.Length).Select(Regex.Escape)) + @")(?![\p{L}\p{N}])",
        Ci);

    private static readonly (Regex Regex, int Season, int Episode)[] EpisodePatterns =
    [
        (new Regex(@"\bS(\d{1,2})[ ._-]?E(\d{1,4})\b", Ci), 1, 2),
        (new Regex(@"\b(\d{1,2})x(\d{2,3})\b", Ci), 1, 2),
        (new Regex(@"season[ ._/-]*(\d{1,2})[ ,.:/_-]*(?:episode|ep)[ ._/-]*(\d{1,4})", Ci), 1, 2),
        (new Regex(@"(?:сезон|season)[ ._/-]*(\d{1,2})[ ,.:/_-]*(?:серія|серия|епізод|эпизод|episode)[ ._/-]*(\d{1,4})", Ci), 1, 2),
        (new Regex(@"(\d{1,2})[ -]*(?:сезон|season)[ ,.:/_-]*(\d{1,4})[ -]*(?:серія|серия|епізод|эпизод|episode)", Ci), 1, 2),
        (new Regex(@"/(?:tv|series|show|serial)/[^/]*?/?(?:\d+/)?(\d{1,2})/(\d{1,4})(?:/|$)", Ci), 1, 2),
        (new Regex(@"[?&]season=(\d{1,2}).*?[?&](?:episode|ep)=(\d{1,4})", Ci), 1, 2),
        (new Regex(@"[?&]s=(\d{1,2})&e=(\d{1,4})", Ci), 1, 2),
        (new Regex(@"[#-]s:(\d{1,2})-e:(\d{1,4})", Ci), 1, 2),
    ];

    private static readonly Regex[] EpisodeStrip =
    [
        new(@"\bS\d{1,2}[ ._-]?E\d{1,4}\b", Ci),
        new(@"\b\d{1,2}x\d{2,3}\b", Ci),
        new(@"\bseason[ ._-]*\d{1,2}(?:[ ,.:_-]*(?:episode|ep)[ ._-]*\d{1,4})?", Ci),
        new(@"\bepisode[ ._-]*\d{1,4}\b", Ci),
        new(@"\b\d{1,2}[ -]*(?:season|сезон)\b", Ci),
        new(@"\b\d{1,4}[ -]*(?:episode|серія|серия|епізод|эпизод)\b", Ci),
        new(@"(?:сезон)[ ._-]*\d{1,2}", Ci),
        new(@"(?:серія|серия|епізод|эпизод)[ ._-]*\d{1,4}", Ci),
    ];

    private static readonly Regex[] TrailingFurniture = MakeFurniture();

    private static Regex[] MakeFurniture()
    {
        const string start = @"(?<![\p{L}\p{N}])";
        return
        [
            new(start + @"в\s+озвучк\p{L}*.*$", Ci),
            new(start + @"в\s+(\d+\s*)?(и\s+\d+\s*)?качеств\p{L}*.*$", Ci),
            new(start + @"у\s+(\d+\s*)?якості.*$", Ci),
            new(start + @"(скачать|скачати)(?![\p{L}]).*$", Ci),
            new(start + @"торрент(?![\p{L}]).*$", Ci),
            new(@"\[\s*(ТВ|TV)[^\]]*\]", Ci),
            new(@"\(\s*(трейлер|тизер|чб|trailer|teaser|режисс[её]рская версия|режисерська версія|18\+|\+?субтитры)[^)]*\)", Ci),
            new(@"(?i)\benglish\s+sub(/dub)?\b.*$", Ci),
            new(@"(?i)\bsub/dub\b.*$", Ci),
            new(@"(?i)\bon\s+[\w-]+\.\w{2,}\b.*$", Ci),
            new(start + @"скоро\s*$", Ci),
            new(@"(?i)\bcoming soon\s*$", Ci),
            new(@"\s*\([^)]*$", Ci),
        ];
    }

    private static readonly Regex YearRegex = new(@"[\(\[]?\b(19\d{2}|20[0-4]\d)\b[\)\]]?", RegexOptions.CultureInvariant);
    private static readonly string[] Separators = [" | ", " – ", " — ", " - ", " :: ", " : ", " • ", " · ", " » ", " « ", " ~ "];

    private static Parsed? Clean(string raw, HashSet<string> siteTokens)
    {
        var text = raw.Replace(' ', ' ').Trim();
        if (text.Length == 0) return null;

        var episode = EpisodeRefStatic(text) ?? EpisodeRef.None;
        var kind = KindHint(text);

        string? name = null;
        int? year = null;
        foreach (var segment in Split(text))
        {
            var (cleaned, foundYear) = CleanSegment(segment, siteTokens);
            year ??= foundYear;
            if (!IsMeaningful(cleaned)) continue;
            name ??= cleaned;
        }
        if (name is null) return null;

        // "Дюна / Dune" names the same film twice. Keep both, so lookups can use either.
        string? alt = null;
        var bilingual = name.Split(" / ").Select(p => p.Trim(' ', '\t')).ToArray();
        if (bilingual.Length >= 2 && bilingual.All(IsMeaningful))
        {
            name = bilingual[0];
            alt = bilingual[1];
        }
        return new Parsed(name, alt, year, episode, kind, 0.6);
    }

    private static (string, int?) CleanSegment(string raw, HashSet<string> siteTokens)
    {
        var s = raw;
        int? year = null;
        var m = YearRegex.Match(s);
        if (m.Success)
        {
            var candidate = m.Groups[1].Value;
            // A name like "1917" or "2012" is the whole title, so leave it alone.
            var withoutYear = YearRegex.Replace(s, " ");
            if (IsMeaningful(Strip(withoutYear)))
            {
                year = int.Parse(candidate, CultureInfo.InvariantCulture);
                s = withoutYear;
            }
        }
        foreach (var regex in EpisodeStrip) s = regex.Replace(s, " ");
        foreach (var regex in TrailingFurniture) s = regex.Replace(s, " ");
        s = Noise.Replace(s, " ");
        // Removing noise can leave furniture at the very end: "Одиссея скоро смотреть онлайн".
        s = s.Trim(' ', '\t');
        foreach (var regex in TrailingFurniture) s = regex.Replace(s, " ");
        s = Strip(s);
        if (siteTokens.Contains(LibraryText.Normalize(s))) return ("", year);
        return (s, year);
    }

    private static string Strip(string raw)
    {
        var s = Regex.Replace(raw, @"\s+", " ");
        s = Regex.Replace(s, @"\(\s*\)|\[\s*\]", " ");
        s = Regex.Replace(s, @"\s+", " ");
        // Quotes left unbalanced by the cleaning above would look broken.
        if (s.Count(c => c == '«') != s.Count(c => c == '»')) s = s.Replace("«", "").Replace("»", "");
        s = TrimQuotes(s);
        // A name wrapped whole in quotes doesn't need them. Quotes inside a name stay.
        if (s.StartsWith('«') && s.EndsWith('»') && s.Count(c => c == '«') == 1) s = s[1..^1];
        return s;
    }

    private static readonly HashSet<char> Quotes = ['"', '“', '”', '„', '\''];

    private static string TrimEdges(string s)
    {
        static bool IsEdge(char c) => char.IsWhiteSpace(c) || "-–—|:,.;·•~/\\".Contains(c);
        var start = 0;
        var end = s.Length;
        while (start < end && IsEdge(s[start])) start++;
        while (end > start && IsEdge(s[end - 1])) end--;
        return s[start..end];
    }

    private static string TrimQuotes(string raw)
    {
        var s = TrimEdges(raw);
        while (s.Length > 0)
        {
            var first = s[0];
            var last = s[^1];
            var count = s.Count(c => Quotes.Contains(c) && c != '\'');
            if (Quotes.Contains(first) && Quotes.Contains(last) && s.Length > 1 && s.Count(Quotes.Contains) == 2)
            {
                s = s[1..^1];
            }
            else if (last != '\'' && Quotes.Contains(last) && count % 2 != 0)
            {
                s = s[..^1];
            }
            else if (first != '\'' && Quotes.Contains(first) && count % 2 != 0)
            {
                s = s[1..];
            }
            else
            {
                break;
            }
            s = TrimEdges(s);
        }
        return s;
    }

    private static List<string> Split(string s)
    {
        var parts = new List<string> { s };
        foreach (var separator in Separators) parts = [.. parts.SelectMany(p => p.Split(separator))];
        return parts;
    }

    private static bool IsMeaningful(string s) => new StringInfo(s).LengthInTextElements >= 2 && s.Any(char.IsLetterOrDigit);

    public EpisodeRef? EpisodeRefIn(string text) => EpisodeRefStatic(text);

    private static EpisodeRef? EpisodeRefStatic(string text)
    {
        foreach (var (regex, seasonGroup, episodeGroup) in EpisodePatterns)
        {
            var m = regex.Match(text);
            if (!m.Success) continue;
            if (int.TryParse(m.Groups[seasonGroup].Value, CultureInfo.InvariantCulture, out var season) &&
                int.TryParse(m.Groups[episodeGroup].Value, CultureInfo.InvariantCulture, out var episode))
            {
                return new EpisodeRef(season, episode);
            }
        }
        return null;
    }

    private static TitleKind KindHint(string text)
    {
        var t = text.ToLowerInvariant();
        if (new[] { "мультфильм", "мультфільм", "мультсериал", "мультсеріал", "cartoon", "аниме", "аніме", "anime" }.Any(t.Contains)) return TitleKind.Cartoon;
        if (new[] { "сериал", "серіал", "tv series", "tv show", "сезон", "season " }.Any(t.Contains)) return TitleKind.Series;
        if (new[] { "фильм", "фільм", "movie", "full film" }.Any(t.Contains)) return TitleKind.Film;
        return TitleKind.Unknown;
    }

    private static HashSet<string> SiteNames(string host)
    {
        var names = new HashSet<string>();
        if (host.Length > 0)
        {
            names.Add(LibraryText.Normalize(DomainName.Registrable(host)));
            names.Add(LibraryText.Normalize(DomainName.DisplayName(host)));
            names.Add(LibraryText.Normalize(host));
        }
        return names;
    }

    private static readonly HashSet<string> GenericSegments =
    [
        "watch", "movie", "movies", "film", "films", "tv", "series", "show", "shows", "play", "player", "embed", "video", "videos",
        "season", "episode", "index.php", "ua", "ru", "en",
    ];

    private static Parsed? ParseSlug(Uri url)
    {
        var path = Decode(url.AbsolutePath);
        var candidates = path.Split('/', StringSplitOptions.RemoveEmptyEntries)
            .Where(segment => !GenericSegments.Contains(segment.ToLowerInvariant()) && segment.Any(char.IsLetter))
            .ToList();
        if (candidates.Count == 0) return null;
        var slug = candidates.Aggregate((best, next) => next.Length > best.Length ? next : best);
        // Drop a leading numeric id ("1234-dune-part-two") and a file extension.
        slug = Regex.Replace(slug, @"\.(html?|php)$", "");
        slug = Regex.Replace(slug, @"^\d+[-_]", "");
        // Random ids at the end of a slug mix letters and digits ("dune-part-two-19xk2").
        slug = Regex.Replace(slug, @"[-_](?=[a-zA-Z0-9]*\d)(?=[a-zA-Z0-9]*[a-zA-Z])[a-zA-Z0-9]{4,}$", "");
        var spaced = Regex.Replace(slug, @"[-_.+]+", " ");
        if (Clean(spaced, []) is not { } parsed) return null;
        var words = parsed.Name.Split(' ').Select(word => word.Length == 0 ? word : word[..1].ToUpperInvariant() + word[1..]);
        return parsed with { Name = string.Join(" ", words) };
    }
}
