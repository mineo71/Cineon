using System.Text;
using System.Text.RegularExpressions;
using Cineon.Core.Data;

namespace Cineon.Core.Parsing;

/// <summary>A link found on a site's search results page.</summary>
/// <param name="Url">Where it goes.</param>
/// <param name="Text">The link's own words: its text, title and image description.</param>
/// <param name="Context">Words around it, where cards keep the year.</param>
public sealed record RescueLink(Uri Url, string Text, string Context);

public sealed record RescueMatch(RescueLink Link, double Score, bool YearConfirmed)
{
    /// <summary>Sure enough to open without asking.</summary>
    public bool IsStrong => Score >= RescueMatcher.StrongScore && YearConfirmed;
}

/// <summary>
/// Decides which link on a results page is the film being looked for. Getting this wrong means
/// opening Dune (1984) instead of Dune (2021), so anything uncertain stays a suggestion.
/// </summary>
public static class RescueMatcher
{
    public const double StrongScore = 0.9;
    public const double PossibleScore = 0.6;

    /// <summary>Page furniture that says nothing about which film this is.</summary>
    private static readonly HashSet<string> Noise = [.. new[]
    {
        "watch", "online", "free", "full", "movie", "film", "hd", "4k", "1080p", "720p", "hdrip", "webrip", "bluray",
        "смотреть", "онлайн", "бесплатно", "фильм", "сериал", "дивитися", "дивитись", "фільм", "серіал",
        "безкоштовно", "українською", "на", "в", "качестве", "хорошем", "озвучке",
    }.SelectMany(Tokens)];

    /// <summary>Something about the film, rather than the film.</summary>
    private static readonly HashSet<string> NotTheFilm = [.. new[]
    {
        "trailer", "teaser", "review", "reaction", "soundtrack", "ost", "interview", "featurette", "clip", "clips",
        "recap", "explained", "breakdown", "shorts", "behind", "making",
        "трейлер", "тизер", "обзор", "огляд", "рецензия", "рецензія", "интервью", "інтерв", "саундтрек",
    }.SelectMany(Tokens)];

    private static readonly string[] NotFilmPaths =
    [
        "/search", "/tag/", "/tags/", "/genre/", "/genres/", "/actor/", "/actors/", "/person/", "/people/", "/country/",
        "/login", "/register", "/signup", "/account", "/user/", "/channel/", "/playlist",
    ];

    private static readonly Regex YearPattern = SwiftText.Icu(@"(?<![0-9])(19|20)[0-9]{2}(?![0-9])");
    private static readonly Regex SegmentPattern = SwiftText.Icu(@"\n|/|\||\s[–—-]\s");

    /// <summary>
    /// The words of a text, folded like <see cref="LibraryText.Normalize"/>: Foundation's case, width and
    /// diacritic folding, split wherever a character isn't a letter, mark or number.
    /// </summary>
    public static IReadOnlyList<string> Tokens(string text)
    {
        var tokens = new List<string>();
        var run = new StringBuilder();
        var atStart = true;
        void Flush()
        {
            if (run.Length == 0) return;
            var word = run.ToString();
            // Foundation's folding keeps accents that open the text, with no letter to belong to.
            var kept = atStart ? LeadingAccents(word) : "";
            var token = kept + LibraryText.Normalize(word[kept.Length..]);
            if (token.Length > 0) tokens.Add(token);
            run.Clear();
        }
        foreach (var rune in text.EnumerateRunes())
        {
            if (SwiftText.IsAlphanumeric(rune))
            {
                run.Append(rune.ToString());
                continue;
            }
            Flush();
            atStart = false;
        }
        Flush();
        return tokens;
    }

    /// <summary>The combining accents at the start of a text, which diacritic folding removes everywhere else.</summary>
    private static string LeadingAccents(string word)
    {
        var length = 0;
        foreach (var rune in word.EnumerateRunes())
        {
            if (rune.Value is not (>= 0x0300 and <= 0x036F or >= 0x1AB0 and <= 0x1AFF or >= 0x1DC0 and <= 0x1DFF
                or >= 0x20D0 and <= 0x20FF or >= 0xFE20 and <= 0xFE2F)) break;
            length += rune.Utf16SequenceLength;
        }
        return word[..length];
    }

    public static IReadOnlyList<int> Years(string text) =>
        [.. YearPattern.Matches(text).Select(m => SwiftText.Int32(m.Value)).OfType<int>()];

    private static bool IsYear(string token) =>
        SwiftText.Count(token) == 4 && SwiftText.Int(token) is long value && value is >= 1900 and < 2100;

    /// <summary>How well one piece of text names the film, from 0 to 1, leaving the year aside.</summary>
    public static double NameScore(string text, string name)
    {
        var needle = Tokens(name).Where(t => !IsYear(t)).ToList();
        if (needle.Count == 0) return 0;
        var words = Tokens(text).Where(t => !IsYear(t)).ToList();
        if (words.Count < needle.Count) return 0;

        // Furniture only counts once the name has been found, because a name can contain the
        // same words: "Scary Movie", "The Film".
        for (var start = 0; start <= words.Count - needle.Count; start++)
        {
            if (!words.Skip(start).Take(needle.Count).SequenceEqual(needle)) continue;
            var extras = new List<string>(words);
            extras.RemoveRange(start, needle.Count);
            extras.RemoveAll(Noise.Contains);
            // "Dune 2" is a different film from "Dune". "Dune extended cut" probably isn't.
            var numbers = extras.Count(t => SwiftText.Int(t) is not null);
            var others = extras.Count - numbers;
            return Math.Max(0.5, 1 - others * 0.05 - numbers * 0.35);
        }
        return 0;
    }

    private static List<string> Segments(string text)
    {
        var marked = SegmentPattern.Replace(text, "\u0001");
        var parts = SwiftText.Split(marked, "\u0001");
        parts.Add(text);
        return parts;
    }

    /// <summary>The last part of the address, without its extension or a leading catalogue number: /films/18432-dune.html.</summary>
    private static string Slug(Uri url)
    {
        var last = SwiftUrl.From(url).LastPathComponentWithoutExtension;
        while (SwiftText.First(last) is { } first && SwiftText.IsNumber(first)) last = SwiftText.DropFirst(last);
        return last;
    }

    public static RescueMatch Score(RescueLink link, IReadOnlyList<string> names, int? year)
    {
        var words = Tokens(link.Text).ToHashSet();
        var best = 0.0;
        if (!words.Overlaps(NotTheFilm))
        {
            foreach (var name in names)
            {
                foreach (var segment in Segments(link.Text))
                {
                    best = Math.Max(best, NameScore(segment, name));
                }
                // The address is weaker evidence: enough to suggest, not to open by itself.
                best = Math.Max(best, NameScore(Slug(link.Url), name) * 0.85);
            }
        }

        var confirmed = year is null;
        if (year is int wanted && best > 0)
        {
            var own = Years(link.Text);
            var nearby = Years(link.Context);
            if (own.Any(y => Math.Abs(y - wanted) <= 1))
            {
                confirmed = true;
            }
            else if (own.Count > 0)
            {
                best *= 0.4;
            }
            else if (nearby.Any(y => Math.Abs(y - wanted) <= 1))
            {
                confirmed = true;
            }
            else if (nearby.Count > 0)
            {
                best *= 0.7;
            }
        }
        return new RescueMatch(link, best, confirmed);
    }

    /// <summary>The best link on a page, if any is good enough to show.</summary>
    public static RescueMatch? Best(IEnumerable<RescueLink> links, IReadOnlyList<string> names, int? year, Uri? pageUrl)
    {
        RescueMatch? best = null;
        foreach (var link in links)
        {
            if (!IsCandidate(link.Url, pageUrl)) continue;
            var match = Score(link, names, year);
            if (match.Score < PossibleScore) continue;
            // The first of the best, like Swift's max(by:).
            if (best is null || (match.IsStrong ? 1 : 0, match.Score).CompareTo((best.IsStrong ? 1 : 0, best.Score)) > 0)
            {
                best = match;
            }
        }
        return best;
    }

    private static bool IsCandidate(Uri url, Uri? pageUrl)
    {
        var address = SwiftUrl.From(url);
        if (address.Scheme is not { } scheme || SwiftText.Lowercased(scheme) is not ("http" or "https")) return false;
        if (pageUrl is not null)
        {
            if (!DomainName.IsSameSite(address.Host, SwiftUrl.From(pageUrl).Host) || UrlKey.Make(url) == UrlKey.Make(pageUrl)) return false;
        }
        var path = SwiftText.Lowercased(address.Path);
        if (SwiftText.Count(path) <= 1) return false;
        return !NotFilmPaths.Any(p => SwiftText.Contains(path, p));
    }

    private static readonly HashSet<string> VideoSharingSites =
        ["youtube.com", "youtu.be", "vimeo.com", "dailymotion.com", "rutube.ru", "ok.ru", "vk.com", "facebook.com", "tiktok.com"];

    /// <summary>
    /// Anyone can upload anything there, so a name that matches is often not the film.
    /// Good to suggest, not to open without asking.
    /// </summary>
    public static bool IsVideoSharing(Uri url) =>
        SwiftUrl.From(url).Host is { } host && VideoSharingSites.Contains(DomainName.Registrable(host));

    // MARK: Mirrors

    /// <summary>Words too common to mean two addresses are the same site.</summary>
    private static readonly HashSet<string> GenericBrands =
    [
        "film", "films", "filmy", "kino", "movie", "movies", "online", "watch", "serial", "serials", "series", "tv", "hd",
        "video", "videos", "stream", "cinema", "anime",
    ];

    /// <summary>The same page at other addresses of this site, in the order given.</summary>
    public static IReadOnlyList<Uri> Mirrors(Uri url, IEnumerable<string> hosts)
    {
        var address = SwiftUrl.From(url);
        if (address.Host is not { } rawHost) return [];
        var host = SwiftText.Lowercased(rawHost);
        if (DomainName.IsIPAddress(host)) return [];
        var brand = SiteBrand.Of(DomainName.Registrable(host));
        if (SwiftText.Count(brand) < 4 || GenericBrands.Contains(brand)) return [];

        HashSet<string> seen = [DomainName.Registrable(host)];
        var found = new List<Uri>();
        foreach (var other in hosts)
        {
            var candidate = SwiftText.Lowercased(other);
            var registrable = DomainName.Registrable(candidate);
            if (DomainName.IsIPAddress(candidate) || SiteBrand.Of(registrable) != brand || !seen.Add(registrable)) continue;
            if (WithHost(address.AbsoluteString, candidate) is { } mirror) found.Add(mirror);
        }
        return found;
    }

    /// <summary><c>URLComponents</c> with another host: user, port, path, query and fragment kept as written.</summary>
    private static Uri? WithHost(string absoluteString, string host)
    {
        var parts = UrlText.Split(absoluteString);
        if (parts.Authority is not { } authority) return null;
        var at = authority.LastIndexOf('@');
        var hostAndPort = authority[(at + 1)..];
        string port;
        if (hostAndPort.StartsWith('['))
        {
            var close = hostAndPort.IndexOf(']');
            port = close < 0 ? "" : hostAndPort[(close + 1)..];
        }
        else
        {
            var colon = hostAndPort.IndexOf(':');
            port = colon < 0 ? "" : hostAndPort[colon..];
        }
        var rebuilt = (parts.Scheme is null ? "" : parts.Scheme + ":") + "//" + authority[..(at + 1)]
            + UrlText.Encode(host, UrlText.HostAllowed) + port + parts.Path
            + (parts.Query is null ? "" : "?" + parts.Query) + (parts.Fragment is null ? "" : "#" + parts.Fragment);
        return Urls.Parse(rebuilt);
    }
}

/// <summary>
/// What mirrors of one site share: hdrezka.ag, rezka-ua.co and rezka-tv.org are all "rezka". The
/// Mac's <c>ImportAnalyzer.brand</c>; the browser import port should call this rather than keep a copy.
/// </summary>
public static class SiteBrand
{
    public static string Of(string domain)
    {
        var name = SwiftText.Split(domain, ".").FirstOrDefault() ?? domain;
        name = SwiftText.Split(name, "-").FirstOrDefault() ?? name;
        var characters = SwiftText.Characters(name);
        if (characters.Count > 4 && characters[0] == "h" && characters[1] == "d")
        {
            characters.RemoveRange(0, 2);
            name = string.Concat(characters);
        }
        var letters = string.Concat(characters.Where(c => !SwiftText.IsNumber(c)));
        return letters.Length == 0 ? name : letters;
    }
}
