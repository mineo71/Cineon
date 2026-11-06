using System.Text.Json;
using System.Text.RegularExpressions;
using Cineon.Core.Data;

namespace Cineon.Core.Parsing;

/// <summary>What a page says about itself, gathered by <c>meta.js</c>.</summary>
public sealed record PageMeta
{
    public string Url { get; init; } = "";
    public string Title { get; init; } = "";
    public string? OgTitle { get; init; }
    public string? OgType { get; init; }
    public string? OgSite { get; init; }
    public string? OgImage { get; init; }
    public string? OgDescription { get; init; }
    public string? TwitterTitle { get; init; }
    public string? H1 { get; init; }
    public IReadOnlyList<LinkedData> Ld { get; init => field = ValueList<LinkedData>.Of(value); } = ValueList<LinkedData>.Empty;
    public string? Icon { get; init; }
    public string? Search { get; init; }

    public sealed record LinkedData
    {
        public string? Type { get; init; }
        public string? Name { get; init; }
        public string? Series { get; init; }
        public int? Season { get; init; }
        public int? Episode { get; init; }
        public int? Year { get; init; }
        public string? Image { get; init; }
        public string? Description { get; init; }
    }

    /// <summary>
    /// Reads what <c>meta.js</c> posts, as the Mac's <c>JSONDecoder</c> does: <c>url</c>, <c>title</c>
    /// and <c>ld</c> must be there, and a value of the wrong type fails the whole thing. Null on failure.
    /// </summary>
    public static PageMeta? FromJson(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            return FromJson(doc.RootElement);
        }
        catch (Exception e) when (e is JsonException or StrictJson.Mismatch)
        {
            return null;
        }
    }

    /// <inheritdoc cref="FromJson(string)"/>
    public static PageMeta? FromJson(JsonElement root)
    {
        try
        {
            var o = StrictJson.Object(root);
            return new PageMeta
            {
                Url = StrictJson.RequiredString(o, "url"),
                Title = StrictJson.RequiredString(o, "title"),
                OgTitle = StrictJson.String(o, "ogTitle"),
                OgType = StrictJson.String(o, "ogType"),
                OgSite = StrictJson.String(o, "ogSite"),
                OgImage = StrictJson.String(o, "ogImage"),
                OgDescription = StrictJson.String(o, "ogDescription"),
                TwitterTitle = StrictJson.String(o, "twitterTitle"),
                H1 = StrictJson.String(o, "h1"),
                Ld = StrictJson.RequiredArray(o, "ld").Select(item =>
                {
                    var l = StrictJson.Object(item);
                    return new LinkedData
                    {
                        Type = StrictJson.String(l, "type"),
                        Name = StrictJson.String(l, "name"),
                        Series = StrictJson.String(l, "series"),
                        Season = StrictJson.Int(l, "season"),
                        Episode = StrictJson.Int(l, "episode"),
                        Year = StrictJson.Int(l, "year"),
                        Image = StrictJson.String(l, "image"),
                        Description = StrictJson.String(l, "description"),
                    };
                }).ToList(),
                Icon = StrictJson.String(o, "icon"),
                Search = StrictJson.String(o, "search"),
            };
        }
        catch (StrictJson.Mismatch)
        {
            return null;
        }
    }
}

public sealed record ParsedTitle
{
    public string Name { get; init; } = "";
    /// <summary>A second name in another language, from titles like "Дюна / Dune".</summary>
    public string? AltName { get; init; }
    public int? Year { get; init; }
    public EpisodeRef Ref { get; init; } = EpisodeRef.None;
    public string? EpisodeName { get; init; }
    public TitleKind KindHint { get; init; } = TitleKind.Unknown;
    public Uri? PosterUrl { get; init; }
    public string? Overview { get; init; }
    /// <summary>0 to 1. Below 0.5 the interface asks whether the name is right.</summary>
    public double Confidence { get; init; }
}

/// <summary>
/// Turns messy streaming site titles into a clean film name. Handles English, Ukrainian and
/// Russian page furniture, because that is what these sites actually look like.
/// </summary>
public static class TitleParser
{
    public static ParsedTitle? Parse(PageMeta meta)
    {
        var url = SwiftUrl.Parse(meta.Url);
        var host = url?.Host ?? "";
        var siteTokens = SiteNames(host, meta.OgSite);

        ParsedTitle? result = null;

        if (BestLinkedData(meta.Ld) is { } ld)
        {
            var type = ld.Type is null ? null : SwiftText.Lowercased(ld.Type);
            var isEpisode = type is not null && SwiftText.Contains(type, "episode");
            var isSeries = type is not null && SwiftText.Contains(type, "series");
            if (CleanLinkedName(isEpisode ? ld.Series ?? ld.Name : ld.Name) is { } name)
            {
                var parsed = Clean(name, siteTokens) ?? new ParsedTitle { Name = name, Confidence = 0.9 };
                parsed = parsed with
                {
                    Confidence = 0.95,
                    Year = ld.Year ?? parsed.Year,
                    KindHint = isEpisode || isSeries ? TitleKind.Series : TitleKind.Film,
                };
                if (ld.Season is int season && ld.Episode is int episode)
                {
                    parsed = parsed with { Ref = new EpisodeRef(season, episode), KindHint = TitleKind.Series };
                }
                if (isEpisode && ld.Series is not null) parsed = parsed with { EpisodeName = ld.Name };
                parsed = parsed with { Overview = ld.Description, PosterUrl = SwiftUrl.MakeUri(ld.Image) };
                result = parsed;
            }
        }

        if (result is null)
        {
            (string? Text, double Confidence)[] candidates =
                [(meta.OgTitle, 0.8), (meta.H1, 0.7), (meta.TwitterTitle, 0.7), (meta.Title, 0.6)];
            foreach (var (text, confidence) in candidates)
            {
                if (text is null || Clean(text, siteTokens) is not { } parsed) continue;
                result = parsed with { Confidence = confidence };
                break;
            }
        }

        if (result is null && url is not null && ParseSlug(url) is { } fromSlug)
        {
            result = fromSlug with { Confidence = 0.35 };
        }

        if (result is not { } found) return null;
        var p = found;

        // Season and episode may live in any of these, even when the name came from elsewhere.
        if (!p.Ref.IsEpisode)
        {
            string?[] haystacks = [meta.OgTitle, meta.Title, meta.H1, UrlText.Decode(meta.Url) ?? meta.Url];
            foreach (var text in haystacks)
            {
                if (text is null) continue;
                if (EpisodeRefIn(text) is { } episodeRef)
                {
                    p = p with { Ref = episodeRef };
                    break;
                }
            }
        }
        if (p.Ref.IsEpisode) p = p with { KindHint = TitleKind.Series };
        if (p.KindHint == TitleKind.Unknown && meta.OgType is { } ogType)
        {
            var type = SwiftText.Lowercased(ogType);
            if (SwiftText.Contains(type, "movie")) p = p with { KindHint = TitleKind.Film };
            if (SwiftText.Contains(type, "tv_show") || SwiftText.Contains(type, "episode"))
            {
                p = p with { KindHint = TitleKind.Series };
            }
        }
        if (p.KindHint == TitleKind.Unknown) p = p with { KindHint = KindHint(meta.Title + " " + (meta.OgTitle ?? "")) };
        if (url is not null)
        {
            var path = SwiftText.Lowercased(url.Path);
            if (CartoonPath.IsMatch(path))
            {
                p = p with { KindHint = TitleKind.Cartoon };
            }
            else if (p.KindHint == TitleKind.Unknown)
            {
                if (SeriesPath.IsMatch(path)) p = p with { KindHint = TitleKind.Series };
                else if (FilmPath.IsMatch(path)) p = p with { KindHint = TitleKind.Film };
            }
        }
        if (p.PosterUrl is null) p = p with { PosterUrl = SwiftUrl.MakeUri(meta.OgImage) };
        if (p.Overview is null) p = p with { Overview = meta.OgDescription };
        return p;
    }

    private static readonly Regex CartoonPath = SwiftText.Icu(@"/(cartoons?|animation|anime|mult|multfilm|multfilmy|multiki)(/|$)");
    private static readonly Regex SeriesPath = SwiftText.Icu(@"/(series|serial|serials|serialy|tv|tv-?shows?)(/|$)");
    private static readonly Regex FilmPath = SwiftText.Icu(@"/(films?|filmy|filmi|movies?)(/|$)");

    // MARK: Cleaning

    /// <summary>Phrases that describe the page rather than the film. Longest first, applied whole-word.</summary>
    private static readonly string[] NoisePhrases =
    [
        "watch online free", "watch online for free", "watch free online", "watch full movie online",
        "watch full movie", "watch movie online", "watch series online", "watch tv show online",
        "full movie online", "full movie", "full episodes", "free online", "for free", "online free",
        "stream online", "streaming online", "with english subtitles", "with subtitles", "english subtitles",
        "english subbed", "english dubbed", "in hd", "hd online", "free hd", "official site", "tv show", "tv series",
        // Bare "movie" and "film" stay: they're part of names like The Lego Movie.
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

    private static readonly Regex NoiseRegex = SwiftText.Icu(
        @"(?<![\p{L}\p{N}])(?:"
        + string.Join("|", NoisePhrases.OrderByDescending(SwiftText.Count).Select(Regex.Escape))
        + @")(?![\p{L}\p{N}])",
        ignoreCase: true);

    private static readonly Regex[] EpisodePatterns =
    [
        SwiftText.Icu(@"\bS(\d{1,2})[ ._-]?E(\d{1,4})\b", true),
        SwiftText.Icu(@"\b(\d{1,2})x(\d{2,3})\b", true),
        SwiftText.Icu(@"season[ ._/-]*(\d{1,2})[ ,.:/_-]*(?:episode|ep)[ ._/-]*(\d{1,4})", true),
        SwiftText.Icu(@"(?:сезон|season)[ ._/-]*(\d{1,2})[ ,.:/_-]*(?:серія|серия|епізод|эпизод|episode)[ ._/-]*(\d{1,4})", true),
        SwiftText.Icu(@"(\d{1,2})[ -]*(?:сезон|season)[ ,.:/_-]*(\d{1,4})[ -]*(?:серія|серия|епізод|эпизод|episode)", true),
        SwiftText.Icu(@"/(?:tv|series|show|serial)/[^/]*?/?(?:\d+/)?(\d{1,2})/(\d{1,4})(?:/|$)", true),
        SwiftText.Icu(@"[?&]season=(\d{1,2}).*?[?&](?:episode|ep)=(\d{1,4})", true),
        SwiftText.Icu(@"[?&]s=(\d{1,2})&e=(\d{1,4})", true),
        // HDRezka and its mirrors keep the episode in the fragment: #t:238-s:2-e:3.
        SwiftText.Icu(@"[#-]s:(\d{1,2})-e:(\d{1,4})", true),
    ];

    /// <summary>Removes season and episode wording, once it has been read.</summary>
    private static readonly Regex[] EpisodeStrip =
    [
        SwiftText.Icu(@"\bS\d{1,2}[ ._-]?E\d{1,4}\b", true),
        SwiftText.Icu(@"\b\d{1,2}x\d{2,3}\b", true),
        SwiftText.Icu(@"\bseason[ ._-]*\d{1,2}(?:[ ,.:_-]*(?:episode|ep)[ ._-]*\d{1,4})?", true),
        SwiftText.Icu(@"\bepisode[ ._-]*\d{1,4}\b", true),
        SwiftText.Icu(@"\b\d{1,2}[ -]*(?:season|сезон)\b", true),
        SwiftText.Icu(@"\b\d{1,4}[ -]*(?:episode|серія|серия|епізод|эпизод)\b", true),
        SwiftText.Icu(@"(?:сезон)[ ._-]*\d{1,2}", true),
        SwiftText.Icu(@"(?:серія|серия|епізод|эпизод)[ ._-]*\d{1,4}", true),
    ];

    /// <summary>Everything from these onward describes the release, not the film: the dub, quality or format.</summary>
    private static readonly Regex[] TrailingFurniture = BuildTrailingFurniture();

    private static Regex[] BuildTrailingFurniture()
    {
        const string start = @"(?<![\p{L}\p{N}])";
        return
        [
            SwiftText.Icu(start + @"в\s+озвучк\p{L}*.*$", true),
            SwiftText.Icu(start + @"в\s+(\d+\s*)?(и\s+\d+\s*)?качеств\p{L}*.*$", true),
            SwiftText.Icu(start + @"у\s+(\d+\s*)?якості.*$", true),
            SwiftText.Icu(start + @"(скачать|скачати)(?![\p{L}]).*$", true),
            SwiftText.Icu(start + @"торрент(?![\p{L}]).*$", true),
            SwiftText.Icu(@"\[\s*(ТВ|TV)[^\]]*\]", true),
            SwiftText.Icu(@"\(\s*(трейлер|тизер|чб|trailer|teaser|режисс[её]рская версия|режисерська версія|18\+|\+?субтитры)[^)]*\)", true),
            SwiftText.Icu(@"(?i)\benglish\s+sub(/dub)?\b.*$", true),
            SwiftText.Icu(@"(?i)\bsub/dub\b.*$", true),
            SwiftText.Icu(@"(?i)\bon\s+[\w-]+\.\w{2,}\b.*$", true),
            SwiftText.Icu(start + @"скоро\s*$", true),
            SwiftText.Icu(@"(?i)\bcoming soon\s*$", true),
            // An opening bracket that never closes: "Мэйдэй (Mayday".
            SwiftText.Icu(@"\s*\([^)]*$", true),
        ];
    }

    private static readonly Regex YearRegex = SwiftText.Icu(@"[\(\[]?\b(19\d{2}|20[0-4]\d)\b[\)\]]?");

    /// <summary>" : " with spaces separates page sections. "Dune: Part Two" has no space before the colon.</summary>
    private static readonly string[] Separators = [" | ", " – ", " — ", " - ", " :: ", " : ", " • ", " · ", " » ", " « ", " ~ "];

    /// <summary>Reads a title string. Returns null if nothing film-like is left after cleaning.</summary>
    public static ParsedTitle? Clean(string raw, IReadOnlySet<string> siteTokens)
    {
        var text = SwiftText.TrimWhitespacesAndNewlines(SwiftText.Replace(raw, "\u00A0", " "));
        if (text.Length == 0) return null;

        var episodeRef = EpisodeRefIn(text) ?? EpisodeRef.None;
        var kind = KindHint(text);

        // Keep the first segment that still says something once the page furniture is gone.
        string? name = null;
        int? year = null;
        foreach (var segment in Split(text, Separators))
        {
            var (cleaned, foundYear) = CleanSegment(segment, siteTokens);
            year ??= foundYear;
            if (!IsMeaningful(cleaned)) continue;
            name ??= cleaned;
        }
        if (name is null) return null;

        // "Дюна / Dune" names the same film twice. Keep both, so lookups can use either.
        string? alt = null;
        var bilingual = SwiftText.Components(name, " / ").Select(part => SwiftText.Trim(part, SwiftText.IsWhitespace)).ToList();
        if (bilingual.Count >= 2 && bilingual.All(IsMeaningful))
        {
            name = bilingual[0];
            alt = bilingual[1];
        }

        return new ParsedTitle { Name = name, AltName = alt, Year = year, Ref = episodeRef, KindHint = kind, Confidence = 0.6 };
    }

    private static (string Text, int? Year) CleanSegment(string raw, IReadOnlySet<string> siteTokens)
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
                year = SwiftText.Int32(candidate);
                s = withoutYear;
            }
        }
        foreach (var regex in EpisodeStrip) s = regex.Replace(s, " ");
        foreach (var regex in TrailingFurniture) s = regex.Replace(s, " ");
        s = NoiseRegex.Replace(s, " ");
        // Removing noise can leave furniture at the very end: "Одиссея скоро смотреть онлайн".
        s = SwiftText.Trim(s, SwiftText.IsWhitespace);
        foreach (var regex in TrailingFurniture) s = regex.Replace(s, " ");
        s = Strip(s);
        if (siteTokens.Contains(Normalize(s))) return ("", year);
        return (s, year);
    }

    private static readonly Regex Spaces = SwiftText.Icu(@"\s+");
    private static readonly Regex EmptyBrackets = SwiftText.Icu(@"\(\s*\)|\[\s*\]");

    private static string Strip(string raw)
    {
        var s = Spaces.Replace(raw, " ");
        s = EmptyBrackets.Replace(s, " ");
        s = Spaces.Replace(s, " ");
        // Quotes left unbalanced by the cleaning above would look broken.
        if (SwiftText.CountOf(s, c => c == "«") != SwiftText.CountOf(s, c => c == "»"))
        {
            s = SwiftText.Replace(SwiftText.Replace(s, "«", ""), "»", "");
        }
        s = TrimQuotes(s);
        // A name wrapped whole in quotes doesn't need them. Quotes inside a name stay.
        if (SwiftText.First(s) == "«" && SwiftText.Last(s) == "»" && SwiftText.CountOf(s, c => c == "«") == 1)
        {
            s = SwiftText.DropLast(SwiftText.DropFirst(s));
        }
        return s;
    }

    private static readonly HashSet<string> Quotes = ["\"", "“", "”", "„", "'"];

    private static bool IsEdge(System.Text.Rune r) =>
        SwiftText.IsWhitespaceOrNewline(r) || (r.IsBmp && "-–—|:,.;·•~/\\".Contains((char)r.Value));

    /// <summary>
    /// Removes furniture from both ends, and quotes that wrap the whole name or have lost their
    /// partner. A quote closing a phrase inside the name stays: Charlie Chaplin's "The Rink".
    /// </summary>
    private static string TrimQuotes(string raw)
    {
        var s = SwiftText.Trim(raw, IsEdge);
        while (SwiftText.First(s) is { } first && SwiftText.Last(s) is { } last)
        {
            var count = SwiftText.CountOf(s, c => Quotes.Contains(c) && c != "'");
            if (Quotes.Contains(first) && Quotes.Contains(last) && SwiftText.Count(s) > 1 && SwiftText.CountOf(s, Quotes.Contains) == 2)
            {
                s = SwiftText.DropLast(SwiftText.DropFirst(s));
            }
            else if (last != "'" && Quotes.Contains(last) && count % 2 != 0)
            {
                s = SwiftText.DropLast(s);
            }
            else if (first != "'" && Quotes.Contains(first) && count % 2 != 0)
            {
                s = SwiftText.DropFirst(s);
            }
            else
            {
                break;
            }
            s = SwiftText.Trim(s, IsEdge);
        }
        return s;
    }

    private static List<string> Split(string s, string[] separators)
    {
        List<string> parts = [s];
        foreach (var separator in separators)
        {
            parts = [.. parts.SelectMany(part => SwiftText.Components(part, separator))];
        }
        return parts;
    }

    private static bool IsMeaningful(string s) =>
        SwiftText.Count(s) >= 2 && SwiftText.ContainsAny(s, r => SwiftText.IsLetter(r) || SwiftText.IsDecimalDigit(r));

    /// <summary>The season and episode named in a title or an address, if any. Swift's <c>episodeRef(in:)</c>.</summary>
    public static EpisodeRef? EpisodeRefIn(string text)
    {
        foreach (var regex in EpisodePatterns)
        {
            var m = regex.Match(text);
            if (!m.Success) continue;
            if (SwiftText.Int32(m.Groups[1].Value) is not int season || SwiftText.Int32(m.Groups[2].Value) is not int episode) continue;
            return new EpisodeRef(season, episode);
        }
        return null;
    }

    public static TitleKind KindHint(string text)
    {
        var t = SwiftText.Lowercased(text);
        if (CartoonWords.Any(word => SwiftText.Contains(t, word))) return TitleKind.Cartoon;
        if (SeriesWords.Any(word => SwiftText.Contains(t, word))) return TitleKind.Series;
        if (FilmWords.Any(word => SwiftText.Contains(t, word))) return TitleKind.Film;
        return TitleKind.Unknown;
    }

    private static readonly string[] CartoonWords = ["мультфильм", "мультфільм", "мультсериал", "мультсеріал", "cartoon", "аниме", "аніме", "anime"];
    private static readonly string[] SeriesWords = ["сериал", "серіал", "tv series", "tv show", "сезон", "season "];
    private static readonly string[] FilmWords = ["фильм", "фільм", "movie", "full film"];

    /// <summary>The library's matching key. Forwards to <see cref="LibraryText.Normalize"/>, the one copy.</summary>
    public static string Normalize(string s) => LibraryText.Normalize(s);

    // MARK: Helpers

    private static HashSet<string> SiteNames(string host, string? ogSite)
    {
        HashSet<string> names = [];
        if (host.Length > 0)
        {
            names.Add(Normalize(DomainName.Registrable(host)));
            names.Add(Normalize(DomainName.DisplayName(host)));
            names.Add(Normalize(host));
        }
        if (ogSite is not null) names.Add(Normalize(ogSite));
        return names;
    }

    private static PageMeta.LinkedData? BestLinkedData(IReadOnlyList<PageMeta.LinkedData> items)
    {
        static int Score(PageMeta.LinkedData item)
        {
            var t = item.Type is null ? "" : SwiftText.Lowercased(item.Type);
            if (SwiftText.Contains(t, "episode")) return 4;
            if (SwiftText.Contains(t, "movie")) return 3;
            if (SwiftText.Contains(t, "series")) return 2;
            if (SwiftText.Contains(t, "videoobject")) return 1;
            return 0;
        }
        PageMeta.LinkedData? best = null;
        var bestScore = 0;
        foreach (var item in items)
        {
            if (string.IsNullOrEmpty(item.Name)) continue;
            var score = Score(item);
            // The first of the best, like Swift's max(by:).
            if (score > bestScore)
            {
                best = item;
                bestScore = score;
            }
        }
        return best;
    }

    private static string? CleanLinkedName(string? name)
    {
        if (name is null) return null;
        var trimmed = SwiftText.TrimWhitespacesAndNewlines(name);
        return trimmed.Length == 0 ? null : trimmed;
    }

    private static readonly HashSet<string> GenericSegments =
    [
        "watch", "movie", "movies", "film", "films", "tv", "series", "show", "shows", "play", "player", "embed", "video",
        "videos", "season", "episode", "index.php", "ua", "ru", "en",
    ];

    private static readonly Regex FileExtension = SwiftText.Icu(@"\.(html?|php)$");
    private static readonly Regex LeadingId = SwiftText.Icu(@"^\d+[-_]");
    // Random ids at the end of a slug mix letters and digits ("dune-part-two-19xk2").
    private static readonly Regex TrailingId = SwiftText.Icu(@"[-_](?=[a-zA-Z0-9]*\d)(?=[a-zA-Z0-9]*[a-zA-Z])[a-zA-Z0-9]{4,}$");
    private static readonly Regex SlugPunctuation = SwiftText.Icu(@"[-_.+]+");

    private static ParsedTitle? ParseSlug(SwiftUrl url)
    {
        var path = UrlText.Decode(url.Path) ?? url.Path;
        var segments = SwiftText.Split(path, "/");
        var candidates = segments.Where(segment =>
            !GenericSegments.Contains(SwiftText.Lowercased(segment)) && SwiftText.ContainsAny(segment, SwiftText.IsLetter));
        string? slug = null;
        var longest = -1;
        foreach (var candidate in candidates)
        {
            var count = SwiftText.Count(candidate);
            if (count > longest)
            {
                slug = candidate;
                longest = count;
            }
        }
        if (slug is null) return null;
        // Drop a leading numeric id ("1234-dune-part-two") and a file extension.
        slug = FileExtension.Replace(slug, "");
        slug = LeadingId.Replace(slug, "");
        slug = TrailingId.Replace(slug, "");
        var spaced = SlugPunctuation.Replace(slug, " ");
        if (Clean(spaced, new HashSet<string>()) is not { } parsed) return null;
        var name = string.Join(" ", SwiftText.Split(parsed.Name, " ").Select(word =>
            SwiftText.Uppercased(SwiftText.First(word) ?? "") + SwiftText.DropFirst(word)));
        return parsed with { Name = name };
    }
}
