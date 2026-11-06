using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Cineon.Core.Data;
using Cineon.Core.Parsing;

namespace Cineon.Core.Metadata;

/// <summary>
/// Looks films up with no account and no API key: IMDb's public suggestions for search and
/// Cinemeta for descriptions and episode lists. Both are unofficial, so every failure here is
/// treated as "no poster" and never gets in the way of watching.
/// </summary>
public sealed class MetadataClient
{
    /// <summary>The Mac's, word for word, so the services answer the same way.</summary>
    public const string UserAgent = "Mozilla/5.0 (Macintosh) Cineon/1.0";

    private static readonly Lazy<MetadataClient> SharedClient = new(() => new MetadataClient());

    /// <summary>The one the app uses.</summary>
    public static MetadataClient Shared => SharedClient.Value;

    private readonly HttpClient _http;

    /// <param name="handler">Where requests go; tests pass a fake. Null for the network.</param>
    public MetadataClient(HttpMessageHandler? handler = null)
    {
        _http = handler is null
            ? new HttpClient(new SocketsHttpHandler { UseCookies = false })
            : new HttpClient(handler, disposeHandler: false);
        _http.Timeout = TimeSpan.FromSeconds(8);
        _http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", UserAgent);
    }

    // MARK: Search

    /// <summary>IMDb's suggestions for a query: films and series only, with posters at 500 pixels.</summary>
    public async Task<IReadOnlyList<MetadataHit>> SearchAsync(string query, CancellationToken cancellationToken = default)
    {
        if (SearchUrl(query) is not { } url) return [];
        var data = await GetAsync(_http, url, cancellationToken).ConfigureAwait(false);
        return data is null ? [] : ParseSearch(data);
    }

    /// <summary>The suggestion address for a query, or null when it's under two characters.</summary>
    public static Uri? SearchUrl(string query)
    {
        var cleaned = SwiftText.TrimWhitespacesAndNewlines(SwiftText.Lowercased(query));
        if (SwiftText.Count(cleaned) < 2) return null;
        var encoded = UrlText.Encode(cleaned, UrlText.PathAllowed);
        // Foundation also encodes colons before the first slash when the set is .urlPathAllowed, so the
        // text can't be read as a scheme: "дюна: частина" has %3A.
        var slash = encoded.IndexOf('/');
        var firstSegment = slash < 0 ? encoded : encoded[..slash];
        encoded = (firstSegment.Replace(":", "%3A") + encoded[firstSegment.Length..]).Replace("/", "%2F");
        return Urls.Parse($"https://v3.sg.media-imdb.com/suggestion/x/{encoded}.json");
    }

    /// <summary>Reads a suggestion response. Empty when it isn't shaped like one.</summary>
    public static IReadOnlyList<MetadataHit> ParseSearch(ReadOnlySpan<byte> json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json.ToArray());
            var root = StrictJson.Object(doc.RootElement);
            var hits = new List<MetadataHit>();
            // Decode everything first: one malformed item fails the response, as with JSONDecoder.
            var items = StrictJson.RequiredArray(root, "d").Select(element =>
            {
                var item = StrictJson.Object(element);
                var image = StrictJson.OptionalObject(item, "i");
                return (
                    Id: StrictJson.RequiredString(item, "id"),
                    Name: StrictJson.String(item, "l"),
                    Qid: StrictJson.String(item, "qid"),
                    Subtitle: StrictJson.String(item, "s"),
                    Year: StrictJson.Int(item, "y"),
                    Rank: StrictJson.Int(item, "rank"),
                    ImageUrl: image is { } i ? StrictJson.String(i, "imageUrl") : null);
            }).ToList();
            foreach (var item in items)
            {
                if (!SwiftText.HasPrefix(item.Id, "tt") || item.Name is null) continue;
                if (Kind(item.Qid) is not { } kind) continue;
                hits.Add(new MetadataHit(item.Id, item.Name, item.Year, kind, ResizedPoster(item.ImageUrl, 500), item.Subtitle, item.Rank));
            }
            return hits;
        }
        catch (Exception e) when (e is JsonException or StrictJson.Mismatch)
        {
            return [];
        }
    }

    private static TitleKind? Kind(string? qid) => qid switch
    {
        "movie" or "tvMovie" or "video" or "short" or "tvShort" or "tvSpecial" => TitleKind.Film,
        "tvSeries" or "tvMiniSeries" => TitleKind.Series,
        _ => null,
    };

    /// <summary>Amazon's image CDN resizes on request, which keeps posters small and fast.</summary>
    public static Uri? ResizedPoster(string? raw, int width)
    {
        if (raw is null) return null;
        if (SwiftText.Contains(raw, "._V1_"))
        {
            return SwiftUrl.MakeUri(SwiftText.Replace(raw, "._V1_.", $"._V1_QL75_UX{width.ToString(CultureInfo.InvariantCulture)}_."));
        }
        return SwiftUrl.MakeUri(raw);
    }

    /// <summary>Picks the hit that really is this film. Returns null rather than guessing badly.</summary>
    public static MetadataHit? BestMatch(IReadOnlyList<MetadataHit> hits, string name, int? year, TitleKind kind)
    {
        var target = LibraryText.Normalize(name);
        var isLatin = name.EnumerateRunes().Any(r => r.Value is >= 65 and <= 122);
        MetadataHit? top = null;
        var topScore = 0;
        foreach (var hit in hits)
        {
            var score = 0;
            var norm = LibraryText.Normalize(hit.Name);
            if (norm == target) score += 100;
            else if (SwiftText.HasPrefix(norm, target) || SwiftText.HasPrefix(target, norm)) score += 35;
            if (year is int y && hit.Year is int hitYear)
            {
                if (y == hitYear) score += 40;
                else if (Math.Abs(y - hitYear) <= 1) score += 15;
                else score -= 40;
            }
            if (kind == TitleKind.Series && hit.Kind == TitleKind.Series) score += 20;
            if (kind == TitleKind.Film && hit.Kind == TitleKind.Film) score += 20;
            if (kind == TitleKind.Series && hit.Kind == TitleKind.Film) score -= 15;
            if (kind == TitleKind.Film && hit.Kind == TitleKind.Series) score -= 15;
            if (hit.Rank is int rank) score += Math.Max(0, 15 - rank / 500);
            // The first of the best, like Swift's max(by:).
            if (top is null || score > topScore)
            {
                top = hit;
                topScore = score;
            }
        }
        if (top is null) return null;
        if (isLatin) return topScore >= 60 ? top : null;
        // Cyrillic and other scripts can't match IMDb's English names by spelling, so trust its
        // translated-title search, for titles popular enough to rank, unless the year contradicts it.
        return topScore >= 5 ? top : null;
    }

    // MARK: Detail

    /// <summary>
    /// Cinemeta's description, genres, runtime, artwork and episode list. A film of unknown kind, or a
    /// cartoon, is tried as a film and then as a series.
    /// </summary>
    public async Task<MetadataDetail?> DetailAsync(string imdbId, TitleKind kind, CancellationToken cancellationToken = default)
    {
        foreach (var url in DetailUrls(imdbId, kind))
        {
            var data = await GetAsync(_http, url, cancellationToken).ConfigureAwait(false);
            if (data is not null && ParseDetail(data) is { } detail) return detail;
        }
        return null;
    }

    /// <summary>The addresses <see cref="DetailAsync"/> tries, in order.</summary>
    public static IReadOnlyList<Uri> DetailUrls(string imdbId, TitleKind kind)
    {
        var path = kind == TitleKind.Series ? "series" : "movie";
        string[] attempts = kind is TitleKind.Unknown or TitleKind.Cartoon ? [path, "series"] : [path];
        return [.. attempts.Select(type => SwiftUrl.MakeUri($"https://v3-cinemeta.strem.io/meta/{type}/{imdbId}.json")).OfType<Uri>()];
    }

    /// <summary>Reads a Cinemeta response. Null when it isn't shaped like one or has no <c>meta</c>.</summary>
    public static MetadataDetail? ParseDetail(ReadOnlySpan<byte> json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json.ToArray());
            var root = StrictJson.Object(doc.RootElement);
            if (StrictJson.OptionalObject(root, "meta") is not { } meta) return null;
            var description = StrictJson.String(meta, "description");
            var genres = StrictJson.StringArray(meta, "genres");
            var runtime = StrictJson.String(meta, "runtime");
            var poster = StrictJson.String(meta, "poster");
            var background = StrictJson.String(meta, "background");
            var releaseInfo = StrictJson.String(meta, "releaseInfo");
            var videos = StrictJson.Array(meta, "videos")?.Select(element =>
            {
                var v = StrictJson.Object(element);
                return (
                    Name: StrictJson.String(v, "name"),
                    Season: StrictJson.Int(v, "season"),
                    Number: StrictJson.Int(v, "number"),
                    Episode: StrictJson.Int(v, "episode"),
                    Overview: StrictJson.String(v, "overview"),
                    Description: StrictJson.String(v, "description"),
                    Thumbnail: StrictJson.String(v, "thumbnail"),
                    Released: StrictJson.String(v, "released"));
            }).ToList() ?? [];

            var episodes = new List<EpisodeInfo>();
            foreach (var video in videos)
            {
                if (video.Season is not int season || (video.Episode ?? video.Number) is not int episode) continue;
                episodes.Add(new EpisodeInfo(
                    season, episode, video.Name, video.Overview ?? video.Description,
                    SwiftUrl.MakeUri(video.Thumbnail), video.Released is { } released ? ParseDate(released) : null));
            }
            return new MetadataDetail
            {
                Overview = description,
                Genres = genres ?? [],
                RuntimeMinutes = runtime is null ? null : ParseRuntime(runtime),
                PosterUrl = SwiftUrl.MakeUri(poster),
                BackdropUrl = SwiftUrl.MakeUri(background),
                Year = releaseInfo is null ? null : SwiftText.Int32(string.Concat(SwiftText.Characters(releaseInfo).Take(4))),
                Episodes = [.. episodes.Where(e => e.Season > 0).OrderBy(e => e.Season).ThenBy(e => e.Episode)],
            };
        }
        catch (Exception e) when (e is JsonException or StrictJson.Mismatch)
        {
            return null;
        }
    }

    private static readonly Regex InternetDate = new(
        @"^[\t\n\v\f\r ]*(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{1,2}):(\d{1,2})\.(\d+)(Z|[+-]\d{2}(?::?\d{2})?)$",
        RegexOptions.CultureInvariant);

    /// <summary>
    /// ISO 8601 with fractional seconds, as <c>ISO8601DateFormatter</c> with <c>.withInternetDateTime</c>
    /// and <c>.withFractionalSeconds</c> reads it: the fraction is required, and kept to the millisecond.
    /// </summary>
    internal static DateTimeOffset? ParseDate(string s)
    {
        var m = InternetDate.Match(s);
        if (!m.Success) return null;
        int Part(int group) => int.Parse(m.Groups[group].Value, CultureInfo.InvariantCulture);
        var (year, month, day, hour, minute, second) = (Part(1), Part(2), Part(3), Part(4), Part(5), Part(6));
        if (year < 1 || month is < 1 or > 12 || day is < 1 or > 31 || hour > 24 || minute > 59 || second > 59) return null;
        var fraction = m.Groups[7].Value;
        var milliseconds = int.Parse((fraction + "00")[..3], CultureInfo.InvariantCulture);
        var zone = m.Groups[8].Value;
        var offset = TimeSpan.Zero;
        if (zone != "Z")
        {
            var digits = zone[1..].Replace(":", "");
            offset = new TimeSpan(int.Parse(digits[..2], CultureInfo.InvariantCulture),
                digits.Length > 2 ? int.Parse(digits[2..], CultureInfo.InvariantCulture) : 0, 0);
            if (zone[0] == '-') offset = -offset;
        }
        // Like Foundation, a day past the end of the month rolls into the next one.
        var local = new DateTime(year, month, 1, 0, 0, 0, DateTimeKind.Unspecified)
            .AddDays(day - 1).AddHours(hour).AddMinutes(minute).AddSeconds(second).AddMilliseconds(milliseconds);
        return new DateTimeOffset(local, offset).ToUniversalTime();
    }

    /// <summary>"166 min" is 166. Only the number at the start counts, so "2h 46min" is 2, as on the Mac.</summary>
    private static int? ParseRuntime(string s) =>
        SwiftText.Int32(string.Concat(SwiftText.Characters(s).TakeWhile(SwiftText.IsNumber)));

    // MARK: Network

    /// <summary>The body of a 200 response, or null for anything else, including errors and timeouts.</summary>
    internal static async Task<byte[]?> GetAsync(HttpClient http, Uri url, CancellationToken cancellationToken, int? limit = null)
    {
        try
        {
            using var response = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
            if ((int)response.StatusCode != 200) return null;
            if (limit is not int max) return await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false);
            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            var buffer = new byte[max];
            var read = 0;
            while (read < max)
            {
                var n = await stream.ReadAsync(buffer.AsMemory(read, max - read), cancellationToken).ConfigureAwait(false);
                if (n == 0) break;
                read += n;
            }
            return buffer[..read];
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException or IOException or InvalidOperationException)
        {
            return null;
        }
    }
}

/// <summary>
/// The poster and description a page advertises about itself. The fallback for titles the catalogue
/// doesn't know, which on Ukrainian and Russian sites is quite a few.
/// </summary>
public sealed class PagePreview
{
    /// <summary>Safari's, as on the Mac, so sites serve the same page.</summary>
    public const string UserAgent =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

    private static readonly Lazy<PagePreview> SharedPreview = new(() => new PagePreview());

    public static PagePreview Shared => SharedPreview.Value;

    private readonly HttpClient _http;

    /// <param name="handler">Where requests go; tests pass a fake. Null for the network.</param>
    public PagePreview(HttpMessageHandler? handler = null)
    {
        _http = handler is null
            ? new HttpClient(new SocketsHttpHandler { UseCookies = false })
            : new HttpClient(handler, disposeHandler: false);
        _http.Timeout = TimeSpan.FromSeconds(8);
        _http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", UserAgent);
    }

    public async Task<(Uri? Poster, string? Overview)> FetchAsync(Uri url, CancellationToken cancellationToken = default)
    {
        // The tags are in the head. There's no need to read the whole page.
        var data = await MetadataClient.GetAsync(_http, url, cancellationToken, limit: 300_000).ConfigureAwait(false);
        if (data is null) return (null, null);
        return Parse(Encoding.UTF8.GetString(data), url);
    }

    public static (Uri? Poster, string? Overview) Parse(string html, Uri baseUrl)
    {
        var image = MetaContent(html, "og:image");
        Uri? poster = null;
        if (image is not null && Urls.Parse(SwiftUrl.From(baseUrl).AbsoluteString) is { } baseAddress)
        {
            var relative = SwiftUrl.FixUp(Decode(image));
            // Relative text has to be read as relative: on its own, .NET on a Mac takes /a.jpg for a file path.
            if (UrlText.Split(relative).Scheme is not null) poster = Urls.Parse(relative);
            else if (Uri.TryCreate(relative, UriKind.Relative, out var reference) && Uri.TryCreate(baseAddress, reference, out var resolved))
            {
                poster = resolved;
            }
        }
        if (poster is not null)
        {
            var path = SwiftText.Lowercased(SwiftUrl.From(poster).Path);
            if (SwiftText.Contains(path, "logo") || SwiftText.HasSuffix(path, ".svg")) poster = null;
        }
        var description = MetaContent(html, "og:description");
        return (poster, description is null ? null : Decode(description));
    }

    private static string? MetaContent(string html, string property)
    {
        var name = Regex.Escape(property);
        string[] patterns =
        [
            $"""<meta[^>]+property=["']{name}["'][^>]*content=["']([^"']+)["']""",
            $"""<meta[^>]+content=["']([^"']+)["'][^>]*property=["']{name}["']""",
        ];
        foreach (var pattern in patterns)
        {
            var m = SwiftText.Icu(pattern, ignoreCase: true).Match(html);
            if (m.Success) return m.Groups[1].Value;
        }
        return null;
    }

    private static string Decode(string text) =>
        SwiftText.Replace(SwiftText.Replace(SwiftText.Replace(text, "&amp;", "&"), "&quot;", "\""), "&#39;", "'");
}
