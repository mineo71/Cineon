using System.Globalization;
using System.Text.RegularExpressions;
using Cineon.Core.Data;

namespace Cineon.Core.Import;

// Port of ImportAnalyzer in Cineon/Core/BrowserImport.swift.

/// <summary>
/// Decides which pages were films. History says nothing about that directly, so this weighs several
/// signals and leaves the final say to the review screen, where every result has a checkbox.
/// </summary>
public static partial class ImportAnalyzer
{
    private const int MaxTitles = 600;
    /// <summary>A series opened this recently is probably still being watched.</summary>
    private static readonly TimeSpan StillWatchingWindow = TimeSpan.FromDays(60);

    /// <summary>Sites that discuss or rate films, or that have nothing to do with them.</summary>
    private static readonly HashSet<string> ExcludedDomains =
    [
        "google.com", "google.com.ua", "googleusercontent.com", "youtube.com", "youtu.be", "github.com", "gitlab.com",
        "stackoverflow.com", "reddit.com", "facebook.com", "instagram.com", "x.com", "twitter.com", "tiktok.com",
        "linkedin.com", "apple.com", "icloud.com", "microsoft.com", "amazon.com", "wikipedia.org", "imdb.com",
        "letterboxd.com", "rottentomatoes.com", "themoviedb.org", "kinopoisk.ru", "metacritic.com", "duckduckgo.com",
        "bing.com", "yandex.ru", "yandex.ua", "chatgpt.com", "claude.ai", "openai.com", "anthropic.com", "figma.com",
        "notion.so", "vercel.com", "cloudflare.com", "supabase.com", "telegram.org", "whatsapp.com", "slack.com",
        "discord.com", "zoom.us", "medium.com", "pinterest.com", "spotify.com", "soundcloud.com", "twitch.tv", "vk.com",
        "ok.ru", "dou.ua", "npmjs.com", "gmail.com", "notebooklm.google", "behance.net", "dribbble.com", "linear.app",
        "iamidiotareyoutoo.com", "clerk.com", "convex.dev", "render.com", "temu.com", "aliexpress.com", "rozetka.com.ua", "prom.ua", "olx.ua", "ebay.com", "chess.com", "savefrom.net", "pollo.ai",
    ];

    private static readonly HashSet<string> GenericNames =
    [
        "home", "movies", "movie", "series", "films", "film", "shows", "tv", "watch", "search", "results", "login", "signin",
        "signup", "register", "error", "notfound", "404", "403", "главная", "головна", "новинки", "фильмы", "фільми",
        "сериалы", "серіали", "мультфильмы", "мультфільми", "каталог", "поиск", "пошук", "kino", "кино", "кіно", "online",
        "онлайн", "player", "video", "untitled", "newtab", "loading", "justamoment", "attentionrequired",
        "safetywarning", "warning", "anime", "аниме", "аніме", "fullvideo",
    ];

    private const RegexOptions Options = RegexOptions.CultureInvariant;

    /// <summary>
    /// Adult and music sites. Adult sites stay out however film-like their pages look, because a
    /// library may be seen by the whole family.
    /// </summary>
    [GeneratedRegex(@"(?i)(porn|xvideos|xhamster|xnxx|redtube|youporn|brazzers|onlyfans|chaturbate|mp3|muz|music|lyrics|song)", Options)]
    private static partial Regex ExcludedHostWords();

    /// <summary>Page names that are about the site rather than a film.</summary>
    [GeneratedRegex(@"(?i)^(лучшие|кращі|новинки|топ|best|top|popular|регистрац|реєстрац|registration|sign |log ?in|privacy error|доступ обмежено|access denied|не найдено|сериалы|серіали|фильмы|фільми|мультфильмы|мультфільми|аниме|аніме)|(homepage|website|сайт|онлайн|online)\s*$|\s,\s", Options)]
    private static partial Regex SitePageNames();

    [GeneratedRegex(@"(?i)(трейлер|тизер|trailer|teaser)", Options)]
    private static partial Regex NotWatchable();

    [GeneratedRegex(@"(?i)((?<!\p{L})скоро(?!\p{L})|coming soon|незабаром)", Options)]
    private static partial Regex ComingSoon();

    [GeneratedRegex(@"(?i)(watch\s.*(online|free)|full movie|free movie|online free|stream\s.*online|дивит(ися|ись)|смотреть|онлайн безкоштовно|онлайн бесплатно|у хорошій якості|в хорошій якості|в хорошем качестве)", Options)]
    private static partial Regex StrongTitle();

    [GeneratedRegex(@"(?i)/(watch|movie|movies|film|films|filmy|filmi|kino|serial|serials|serialy|series|tv|tvshows?|tv-shows?|shows?|episodes?|season|anime|cartoons?|multfilm|multfilmy|mult|multiki|online|dubbed|subbed|player|embed)(/|-|\.|$)", Options)]
    private static partial Regex FilmPath();

    [GeneratedRegex(@"(?i)(/(search|genre|genres|category|categories|tag|tags|page|top|best|new|novinki|popular|trending|year|years|country|countries|actor|actors|person|people|login|signin|signup|register|user|users|profile|account|news|blog|collections?|about|contact|faq|help|settings|xfsearch)(/|$))|([?&](q|s|query|search|keyword|story)=)", Options)]
    private static partial Regex ListingPath();

    [GeneratedRegex(@"(?i)(kino|film|movie|cinema|serial|flix|rezka|anime|aniwatch|mult|gidonline|megogo|sweet\.tv|netflix|disney|primevideo|hbo|takflix|kyivstar)", Options)]
    private static partial Regex FilmHostWord();

    private static int Length(string s) => new StringInfo(s).LengthInTextElements;

    /// <summary>3 or more means a film page on its own merits. 2 means only if the site is a film site.</summary>
    public static int Signal(Uri url, string title, ITitleRecognizer recognizer)
    {
        var path = SwiftUrl.Path(url);
        if (Length(path) <= 1 || ListingPath().IsMatch(path + "?" + (SwiftUrl.Query(url) ?? "")) || NotWatchable().IsMatch(title)) return 0;
        var score = 0;
        if (StrongTitle().IsMatch(title)) score += 3;
        // Random ids in addresses can look like S01E02, so an address only counts on a film path.
        var address = SwiftUrl.Decoded(url);
        if (recognizer.EpisodeRefIn(title) is not null || (FilmPath().IsMatch(path) && recognizer.EpisodeRefIn(address) is not null))
        {
            score += 3;
        }
        if (FilmPath().IsMatch(path)) score += 2;
        if (SwiftUrl.Host(url) is { } host && FilmHostWord().IsMatch(host)) score += 1;
        return score;
    }

    private static bool IsUsableName(string name)
    {
        var key = LibraryText.Normalize(name);
        if (Length(key) < 2 || Length(name) > 80 || GenericNames.Contains(key) || SitePageNames().IsMatch(name)) return false;
        return name.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length <= 12 && !name.Contains("http", StringComparison.Ordinal);
    }

    private sealed class Group
    {
        public required string Name;
        public string? AltName;
        public int? Year;
        public TitleKind Kind;
        public DateTimeOffset Latest;
        public int TotalVisits;
        public bool OnlySaved = true;
        public bool OnlyComingSoon = true;
        public readonly Dictionary<EpisodeRef, ImportVisit> ByRef = [];
    }

    public static ImportScan Analyze(IReadOnlyList<BrowsedPage> pages, string sourceLabel, ITitleRecognizer recognizer, DateTimeOffset? now = null)
    {
        var moment = now ?? DateTimeOffset.UtcNow;
        var excludedCache = new Dictionary<string, bool>();
        bool IsExcluded(string host)
        {
            if (excludedCache.TryGetValue(host, out var cached)) return cached;
            var result = ExcludedDomains.Contains(DomainName.Registrable(host)) || ExcludedHostWords().IsMatch(host);
            excludedCache[host] = result;
            return result;
        }
        string? HostOf(BrowsedPage page) => SwiftUrl.Host(page.Url)?.ToLowerInvariant();

        // First pass: score pages, and see which sites have clearly film pages on them.
        var scored = new List<(BrowsedPage Page, int Score)>();
        var strongPagesByDomain = new Dictionary<string, int>();
        foreach (var page in pages)
        {
            if (HostOf(page) is not { } host || IsExcluded(host)) continue;
            var score = Signal(page.Url, page.Title, recognizer);
            if (score < 2) continue;
            scored.Add((page, score));
            if (score >= 3)
            {
                var domain = DomainName.Registrable(host);
                strongPagesByDomain[domain] = strongPagesByDomain.GetValueOrDefault(domain) + 1;
            }
        }

        // Second pass: a page counts if its site is plainly about films, or has proved itself with
        // several clear film pages. One film-looking page on a shop or a game site proves nothing.
        var filmPagesByDomain = new Dictionary<string, int>();
        var sampleUrl = new Dictionary<string, Uri>();
        var latestByDomain = new Dictionary<string, DateTimeOffset>();
        var groups = new Dictionary<string, Group>();

        foreach (var (page, score) in scored)
        {
            if (HostOf(page) is not { } rawHost) continue;
            var domain = DomainName.Registrable(rawHost);
            var provenSite = strongPagesByDomain.GetValueOrDefault(domain) >= 3;
            if (!(provenSite || (score >= 3 && FilmHostWord().IsMatch(rawHost)))) continue;

            if (recognizer.Parse(page.Url.OriginalString, page.Title) is not { } parsed || parsed.Confidence < 0.5 ||
                !IsUsableName(parsed.Name) ||
                LibraryText.Normalize(parsed.Name) == LibraryText.Normalize(DomainName.DisplayName(rawHost)))
            {
                continue;
            }

            filmPagesByDomain[domain] = filmPagesByDomain.GetValueOrDefault(domain) + 1;
            if (page.LastVisit >= latestByDomain.GetValueOrDefault(domain, DateTimeOffset.MinValue))
            {
                latestByDomain[domain] = page.LastVisit;
                sampleUrl[domain] = page.Url;
            }

            var host = rawHost.StartsWith("www.", StringComparison.Ordinal) ? rawHost[4..] : rawHost;
            var visit = new ImportVisit { Ref = parsed.Ref, Url = page.Url, Host = host, Date = page.LastVisit };
            var key = LibraryText.Normalize(parsed.AltName ?? parsed.Name);

            if (!groups.TryGetValue(key, out var group))
            {
                group = new Group { Name = parsed.Name, AltName = parsed.AltName, Year = parsed.Year, Kind = parsed.KindHint, Latest = page.LastVisit };
                groups[key] = group;
            }
            group.TotalVisits += page.Visits;
            if (page.Origin == PageOrigin.History) group.OnlySaved = false;
            if (!ComingSoon().IsMatch(page.Title)) group.OnlyComingSoon = false;
            if (page.LastVisit > group.Latest)
            {
                group.Latest = page.LastVisit;
                group.Name = parsed.Name;
                group.AltName = parsed.AltName ?? group.AltName;
            }
            group.Year ??= parsed.Year;
            if (parsed.KindHint == TitleKind.Cartoon || (parsed.KindHint == TitleKind.Series && group.Kind != TitleKind.Cartoon) ||
                group.Kind == TitleKind.Unknown)
            {
                group.Kind = parsed.KindHint;
            }
            if (group.ByRef.TryGetValue(parsed.Ref, out var existing))
            {
                if (page.LastVisit > existing.Date) group.ByRef[parsed.Ref] = visit;
            }
            else
            {
                group.ByRef[parsed.Ref] = visit;
            }
        }

        var titles = groups.Select(pair =>
            {
                var (key, group) = (pair.Key, pair.Value);
                var visits = group.ByRef.Values.OrderByDescending(v => v.Date).ToList();
                // Opening a series' main page says little once there are real episodes to go on.
                if (visits.Any(v => v.Ref.IsEpisode)) visits.RemoveAll(v => !v.Ref.IsEpisode);
                var isSeries = group.Kind == TitleKind.Series || visits.Any(v => v.Ref.IsEpisode);
                TitleStatus status;
                if ((group.OnlySaved && group.TotalVisits <= 1) || group.OnlyComingSoon)
                {
                    // Saved but never really opened, or not out yet: something to watch later.
                    status = TitleStatus.Backlog;
                }
                else if (isSeries && moment - group.Latest < StillWatchingWindow)
                {
                    status = TitleStatus.Watching;
                }
                else
                {
                    status = TitleStatus.Watched;
                }
                return new ImportTitleCandidate
                {
                    Key = key, Name = group.Name, AltName = group.AltName, Year = group.Year,
                    Kind = isSeries && group.Kind != TitleKind.Cartoon ? TitleKind.Series : group.Kind,
                    Visits = visits, SuggestedStatus = status,
                };
            })
            .OrderByDescending(t => t.LastVisit)
            .Take(MaxTitles)
            .ToList();

        // Sites: anywhere with at least two film pages, plus saved film sites you visit by name.
        // Streaming sites live on many mirrors, so these count as one site at its newest address.
        var sites = new List<ImportSiteCandidate>();
        foreach (var domains in filmPagesByDomain.Keys.GroupBy(Brand))
        {
            var total = domains.Sum(d => filmPagesByDomain.GetValueOrDefault(d));
            if (total < 2) continue;
            // Swift's max(by:): the first of equals wins.
            string? newest = null;
            foreach (var domain in domains)
            {
                if (newest is null ||
                    latestByDomain.GetValueOrDefault(newest, DateTimeOffset.MinValue) < latestByDomain.GetValueOrDefault(domain, DateTimeOffset.MinValue))
                {
                    newest = domain;
                }
            }
            if (newest is null || !sampleUrl.TryGetValue(newest, out var sample) || SiteCandidate(sample, total) is not { } site) continue;
            sites.Add(site);
        }
        foreach (var page in pages)
        {
            if (page.Origin == PageOrigin.History) continue;
            if (HostOf(page) is not { } host || IsExcluded(host) || !FilmHostWord().IsMatch(host)) continue;
            var brand = Brand(DomainName.Registrable(host));
            if (sites.Any(s => Brand(DomainName.Registrable(s.Host)) == brand)) continue;
            if (SiteCandidate(page.Url, filmPagesByDomain.GetValueOrDefault(DomainName.Registrable(host))) is not { } site) continue;
            sites.Add(site);
        }
        sites = [.. sites.OrderByDescending(s => s.FilmPages)];

        var history = pages.Where(p => p.Origin == PageOrigin.History).ToList();
        return new ImportScan
        {
            SourceLabel = sourceLabel,
            Sites = [.. sites.Take(40)],
            Titles = titles,
            Pages = [.. history.OrderByDescending(p => p.LastVisit).Take(BrowserImporter.PageLimit)],
            TotalPages = history.Count,
        };
    }

    /// <summary>What mirrors of one site share: hdrezka.ag, rezka-ua.co and rezka-tv.org are all "rezka".</summary>
    public static string Brand(string domain)
    {
        var name = domain.Split('.', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? domain;
        name = name.Split('-', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? name;
        if (name.StartsWith("hd", StringComparison.Ordinal) && Length(name) > 4) name = name[2..];
        var letters = string.Concat(name.Where(c => !char.IsNumber(c)));
        return letters.Length == 0 ? name : letters;
    }

    private static ImportSiteCandidate? SiteCandidate(Uri url, int filmPages)
    {
        if (SwiftUrl.Host(url)?.ToLowerInvariant() is not { } rawHost) return null;
        var host = rawHost.StartsWith("www.", StringComparison.Ordinal) ? rawHost[4..] : rawHost;
        var scheme = url.Scheme == "http" ? "http" : "https";
        var hostText = rawHost.Contains(':') ? $"[{rawHost}]" : rawHost;
        var port = SwiftUrl.Port(url) is int p ? ":" + p.ToString(CultureInfo.InvariantCulture) : "";
        if (Urls.Parse($"{scheme}://{hostText}{port}/") is not { } home) return null;
        return new ImportSiteCandidate { Host = host, HomeUrl = home, FilmPages = filmPages };
    }
}
