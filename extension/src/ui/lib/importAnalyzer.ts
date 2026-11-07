// Port of BrowserImport.swift's ImportAnalyzer and the import's records: decides which pages in a
// pile of history were films. History says nothing about that directly, so this weighs several
// signals and leaves the final say to the review screen, where every result has a checkbox.
//
// The extension reads `chrome.history` (url, title, visitCount, lastVisitTime in ms); every page's
// origin is "history". Dates here are seconds since 1970, like the data layer's.

import { DomainName, type EpisodeRef, LibraryText, type TitleKind, type TitleStatus } from "../../core/data";
import { SiteBrand, SwiftUrl, TitleParser } from "../../core/parsing";

/** Foundation's `Date.distantPast` (0001-01-01), for pages with no known date. */
export const DISTANT_PAST = -62_135_769_600;

/** Keeps searching history instant in the command bar. */
export const PAGE_LIMIT = 25_000;

export type PageOrigin = "history" | "bookmark" | "pinned";

/** One page from a browser (BrowsedPage). */
export interface BrowsedPage {
  readonly url: string;
  readonly title: string;
  readonly visits: number;
  /** Seconds since 1970; `DISTANT_PAST` when unknown. */
  readonly lastVisit: number;
  readonly origin: PageOrigin;
}

export interface ImportSiteCandidate {
  /** The host, without `www.`. */
  readonly id: string;
  readonly host: string;
  readonly homeUrl: string;
  readonly filmPages: number;
}

export interface ImportVisit {
  readonly ref: EpisodeRef;
  readonly url: string;
  readonly host: string;
  /** Seconds since 1970. */
  readonly date: number;
}

export interface ImportTitleCandidate {
  /** The normalised name. */
  readonly id: string;
  readonly name: string;
  readonly altName: string | null;
  readonly year: number | null;
  readonly kind: TitleKind;
  /** The latest page for each episode, newest first. A film has just one. */
  readonly visits: readonly ImportVisit[];
  readonly suggestedStatus: TitleStatus;
}

export const ImportTitleCandidate = {
  lastVisit(c: ImportTitleCandidate): number {
    return c.visits[0]?.date ?? DISTANT_PAST;
  },
  host(c: ImportTitleCandidate): string {
    return c.visits[0]?.host ?? "";
  },
  latestRef(c: ImportTitleCandidate): EpisodeRef {
    return c.visits[0]?.ref ?? { season: 0, episode: 0 };
  },
};

export interface ImportScan {
  readonly sourceLabel: string;
  readonly sites: readonly ImportSiteCandidate[];
  readonly titles: readonly ImportTitleCandidate[];
  /** Pages to make searchable, newest first and capped. */
  readonly pages: readonly BrowsedPage[];
  readonly totalPages: number;
}

/** `chrome.history.HistoryItem`, the parts read. */
export interface HistoryItemLike {
  url?: string;
  title?: string;
  visitCount?: number;
  /** Milliseconds since 1970. */
  lastVisitTime?: number;
}

/** History items as pages: only addresses with a host, as on the Mac. */
export function pagesFromHistory(items: readonly HistoryItemLike[]): BrowsedPage[] {
  const pages: BrowsedPage[] = [];
  for (const item of items) {
    if (!item.url) continue;
    const url = SwiftUrl.parse(item.url);
    if (!url?.host) continue;
    pages.push({
      url: url.absoluteString,
      title: item.title ?? "",
      visits: item.visitCount ?? 0,
      lastVisit: item.lastVisitTime != null && item.lastVisitTime > 0 ? item.lastVisitTime / 1000 : DISTANT_PAST,
      origin: "history",
    });
  }
  return pages;
}

const MAX_TITLES = 600;
/** A series opened this recently is probably still being watched. */
const STILL_WATCHING_WINDOW = 60 * 24 * 3600;

/** Sites that discuss or rate films, or that have nothing to do with them. */
const EXCLUDED_DOMAINS = new Set([
  "google.com", "google.com.ua", "googleusercontent.com", "youtube.com", "youtu.be", "github.com", "gitlab.com",
  "stackoverflow.com", "reddit.com", "facebook.com", "instagram.com", "x.com", "twitter.com", "tiktok.com",
  "linkedin.com", "apple.com", "icloud.com", "microsoft.com", "amazon.com", "wikipedia.org", "imdb.com",
  "letterboxd.com", "rottentomatoes.com", "themoviedb.org", "kinopoisk.ru", "metacritic.com", "duckduckgo.com",
  "bing.com", "yandex.ru", "yandex.ua", "chatgpt.com", "claude.ai", "openai.com", "anthropic.com", "figma.com",
  "notion.so", "vercel.com", "cloudflare.com", "supabase.com", "telegram.org", "whatsapp.com", "slack.com",
  "discord.com", "zoom.us", "medium.com", "pinterest.com", "spotify.com", "soundcloud.com", "twitch.tv", "vk.com",
  "ok.ru", "dou.ua", "npmjs.com", "gmail.com", "notebooklm.google", "behance.net", "dribbble.com", "linear.app",
  "iamidiotareyoutoo.com", "clerk.com", "convex.dev", "render.com", "temu.com", "aliexpress.com", "rozetka.com.ua", "prom.ua", "olx.ua", "ebay.com", "chess.com", "savefrom.net", "pollo.ai",
]);

/**
 * Adult and music sites. Adult sites stay out however film-like their pages look, because a
 * library may be seen by the whole family.
 */
const EXCLUDED_HOST_WORDS = /(porn|xvideos|xhamster|xnxx|redtube|youporn|brazzers|onlyfans|chaturbate|mp3|muz|music|lyrics|song)/iu;

const GENERIC_NAMES = new Set([
  "home", "movies", "movie", "series", "films", "film", "shows", "tv", "watch", "search", "results", "login", "signin",
  "signup", "register", "error", "notfound", "404", "403", "главная", "головна", "новинки", "фильмы", "фільми",
  "сериалы", "серіали", "мультфильмы", "мультфільми", "каталог", "поиск", "пошук", "kino", "кино", "кіно", "online",
  "онлайн", "player", "video", "untitled", "newtab", "loading", "justamoment", "attentionrequired",
  "safetywarning", "warning", "anime", "аниме", "аніме", "fullvideo",
]);

/** Page names that are about the site rather than a film. */
const SITE_PAGE_NAMES =
  /^(лучшие|кращі|новинки|топ|best|top|popular|регистрац|реєстрац|registration|sign |log ?in|privacy error|доступ обмежено|access denied|не найдено|сериалы|серіали|фильмы|фільми|мультфильмы|мультфільми|аниме|аніме)|(homepage|website|сайт|онлайн|online)\s*$|\s,\s/iu;
const NOT_WATCHABLE = /(трейлер|тизер|trailer|teaser)/iu;
const COMING_SOON = /((?<!\p{L})скоро(?!\p{L})|coming soon|незабаром)/iu;

const STRONG_TITLE =
  /(watch\s.*(online|free)|full movie|free movie|online free|stream\s.*online|дивит(ися|ись)|смотреть|онлайн безкоштовно|онлайн бесплатно|у хорошій якості|в хорошій якості|в хорошем качестве)/iu;
const FILM_PATH =
  /\/(watch|movie|movies|film|films|filmy|filmi|kino|serial|serials|serialy|series|tv|tvshows?|tv-shows?|shows?|episodes?|season|anime|cartoons?|multfilm|multfilmy|mult|multiki|online|dubbed|subbed|player|embed)(\/|-|\.|$)/iu;
const LISTING_PATH =
  /(\/(search|genre|genres|category|categories|tag|tags|page|top|best|new|novinki|popular|trending|year|years|country|countries|actor|actors|person|people|login|signin|signup|register|user|users|profile|account|news|blog|collections?|about|contact|faq|help|settings|xfsearch)(\/|$))|([?&](q|s|query|search|keyword|story)=)/iu;
const FILM_HOST_WORD = /(kino|film|movie|cinema|serial|flix|rezka|anime|aniwatch|mult|gidonline|megogo|sweet\.tv|netflix|disney|primevideo|hbo|takflix|kyivstar)/iu;

const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** Swift's `String.count`: grapheme clusters. */
function characterCount(text: string): number {
  if (!segmenter) return [...text].length;
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

function decodedOrSelf(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function refKey(ref: EpisodeRef): string {
  return `${ref.season}x${ref.episode}`;
}

function isEpisode(ref: EpisodeRef): boolean {
  return ref.season > 0 || ref.episode > 0;
}

export const ImportAnalyzer = {
  /** 3 or more means a film page on its own merits. 2 means only if the site is a film site. */
  signal(urlText: string, title: string): number {
    const url = SwiftUrl.parse(urlText);
    if (!url) return 0;
    const path = url.path;
    if (characterCount(path) <= 1 || LISTING_PATH.test(path + "?" + (url.query ?? "")) || NOT_WATCHABLE.test(title)) return 0;
    let score = 0;
    if (STRONG_TITLE.test(title)) score += 3;
    // Random ids in addresses can look like S01E02, so an address only counts on a film path.
    const address = decodedOrSelf(url.absoluteString);
    if (TitleParser.episodeRefIn(title) != null || (FILM_PATH.test(path) && TitleParser.episodeRefIn(address) != null)) {
      score += 3;
    }
    if (FILM_PATH.test(path)) score += 2;
    const host = url.host;
    if (host != null && FILM_HOST_WORD.test(host)) score += 1;
    return score;
  },

  isUsableName(name: string): boolean {
    const key = LibraryText.normalize(name);
    if (characterCount(key) < 2 || characterCount(name) > 80 || GENERIC_NAMES.has(key) || SITE_PAGE_NAMES.test(name)) return false;
    return name.split(" ").filter((part) => part.length > 0).length <= 12 && !name.includes("http");
  },

  /** What mirrors of one site share: hdrezka.ag, rezka-ua.co and rezka-tv.org are all "rezka". */
  brand(domain: string): string {
    return SiteBrand.of(domain);
  },

  siteCandidate(urlText: string, filmPages: number): ImportSiteCandidate | null {
    let url: URL;
    try {
      url = new URL(urlText);
    } catch {
      return null;
    }
    const rawHost = SwiftUrl.parse(urlText)?.host?.toLowerCase() ?? url.hostname.toLowerCase();
    if (!rawHost) return null;
    const host = rawHost.startsWith("www.") ? rawHost.slice(4) : rawHost;
    const scheme = url.protocol === "http:" ? "http" : "https";
    const homeUrl = `${scheme}://${url.hostname}${url.port ? `:${url.port}` : ""}/`;
    return { id: host, host, homeUrl, filmPages };
  },

  analyze(pages: readonly BrowsedPage[], sourceLabel: string, now: number = Date.now() / 1000): ImportScan {
    const excludedCache = new Map<string, boolean>();
    const isExcluded = (host: string): boolean => {
      const cached = excludedCache.get(host);
      if (cached !== undefined) return cached;
      const result = EXCLUDED_DOMAINS.has(DomainName.registrable(host)) || EXCLUDED_HOST_WORDS.test(host);
      excludedCache.set(host, result);
      return result;
    };
    const hostOf = (page: BrowsedPage) => SwiftUrl.parse(page.url)?.host?.toLowerCase() ?? null;

    // First pass: score pages, and see which sites have clearly film pages on them.
    const scored: { page: BrowsedPage; score: number }[] = [];
    const strongPagesByDomain = new Map<string, number>();
    for (const page of pages) {
      const host = hostOf(page);
      if (host == null || isExcluded(host)) continue;
      const score = ImportAnalyzer.signal(page.url, page.title);
      if (score < 2) continue;
      scored.push({ page, score });
      if (score >= 3) {
        const domain = DomainName.registrable(host);
        strongPagesByDomain.set(domain, (strongPagesByDomain.get(domain) ?? 0) + 1);
      }
    }

    // Second pass: a page counts if its site is plainly about films, or has proved itself with
    // several clear film pages. One film-looking page on a shop or a game site proves nothing.
    const filmPagesByDomain = new Map<string, number>();
    const sampleUrl = new Map<string, string>();
    const latestByDomain = new Map<string, number>();
    interface Group {
      name: string;
      altName: string | null;
      year: number | null;
      kind: TitleKind;
      latest: number;
      totalVisits: number;
      onlySaved: boolean;
      onlyComingSoon: boolean;
      byRef: Map<string, ImportVisit>;
    }
    const groups = new Map<string, Group>();

    for (const { page, score } of scored) {
      const rawHost = hostOf(page);
      if (rawHost == null) continue;
      const domain = DomainName.registrable(rawHost);
      const provenSite = (strongPagesByDomain.get(domain) ?? 0) >= 3;
      if (!(provenSite || (score >= 3 && FILM_HOST_WORD.test(rawHost)))) continue;

      const parsed = TitleParser.parse({ url: page.url, title: page.title, ld: [] });
      if (
        parsed == null ||
        parsed.confidence < 0.5 ||
        !ImportAnalyzer.isUsableName(parsed.name) ||
        LibraryText.normalize(parsed.name) === LibraryText.normalize(DomainName.displayName(rawHost))
      ) {
        continue;
      }

      filmPagesByDomain.set(domain, (filmPagesByDomain.get(domain) ?? 0) + 1);
      if (page.lastVisit >= (latestByDomain.get(domain) ?? DISTANT_PAST)) {
        latestByDomain.set(domain, page.lastVisit);
        sampleUrl.set(domain, page.url);
      }

      const host = rawHost.startsWith("www.") ? rawHost.slice(4) : rawHost;
      const visit: ImportVisit = { ref: parsed.ref, url: page.url, host, date: page.lastVisit };
      const key = LibraryText.normalize(parsed.altName ?? parsed.name);

      const group: Group = groups.get(key) ?? {
        name: parsed.name,
        altName: parsed.altName,
        year: parsed.year,
        kind: parsed.kindHint,
        latest: page.lastVisit,
        totalVisits: 0,
        onlySaved: true,
        onlyComingSoon: true,
        byRef: new Map(),
      };
      group.totalVisits += page.visits;
      if (page.origin === "history") group.onlySaved = false;
      if (!COMING_SOON.test(page.title)) group.onlyComingSoon = false;
      if (page.lastVisit > group.latest) {
        group.latest = page.lastVisit;
        group.name = parsed.name;
        group.altName = parsed.altName ?? group.altName;
      }
      group.year = group.year ?? parsed.year;
      if (parsed.kindHint === "cartoon" || (parsed.kindHint === "series" && group.kind !== "cartoon") || group.kind === "unknown") {
        group.kind = parsed.kindHint;
      }
      const existing = group.byRef.get(refKey(parsed.ref));
      if (!existing || page.lastVisit > existing.date) group.byRef.set(refKey(parsed.ref), visit);
      groups.set(key, group);
    }

    const titles = [...groups.entries()]
      .map(([key, group]): ImportTitleCandidate => {
        let visits = [...group.byRef.values()].sort((a, b) => b.date - a.date);
        // Opening a series' main page says little once there are real episodes to go on.
        if (visits.some((v) => isEpisode(v.ref))) visits = visits.filter((v) => isEpisode(v.ref));
        const isSeries = group.kind === "series" || visits.some((v) => isEpisode(v.ref));
        let status: TitleStatus;
        if ((group.onlySaved && group.totalVisits <= 1) || group.onlyComingSoon) {
          // Saved but never really opened, or not out yet: something to watch later.
          status = "backlog";
        } else if (isSeries && now - group.latest < STILL_WATCHING_WINDOW) {
          status = "watching";
        } else {
          status = "watched";
        }
        return {
          id: key,
          name: group.name,
          altName: group.altName,
          year: group.year,
          kind: isSeries && group.kind !== "cartoon" ? "series" : group.kind,
          visits,
          suggestedStatus: status,
        };
      })
      .sort((a, b) => ImportTitleCandidate.lastVisit(b) - ImportTitleCandidate.lastVisit(a))
      .slice(0, MAX_TITLES);

    // Sites: anywhere with at least two film pages, plus saved film sites you visit by name.
    // Streaming sites live on many mirrors, so these count as one site at its newest address.
    const sites: ImportSiteCandidate[] = [];
    const mirrors = new Map<string, string[]>();
    for (const domain of filmPagesByDomain.keys()) {
      const brand = ImportAnalyzer.brand(domain);
      mirrors.set(brand, [...(mirrors.get(brand) ?? []), domain]);
    }
    for (const domains of mirrors.values()) {
      const total = domains.reduce((sum, d) => sum + (filmPagesByDomain.get(d) ?? 0), 0);
      if (total < 2) continue;
      let newest: string | null = null;
      for (const d of domains) {
        if (newest == null || (latestByDomain.get(d) ?? DISTANT_PAST) > (latestByDomain.get(newest) ?? DISTANT_PAST)) newest = d;
      }
      const sample = newest != null ? sampleUrl.get(newest) : undefined;
      const site = sample != null ? ImportAnalyzer.siteCandidate(sample, total) : null;
      if (site) sites.push(site);
    }
    for (const page of pages) {
      if (page.origin === "history") continue;
      const host = hostOf(page);
      if (host == null || isExcluded(host) || !FILM_HOST_WORD.test(host)) continue;
      const brand = ImportAnalyzer.brand(DomainName.registrable(host));
      if (sites.some((s) => ImportAnalyzer.brand(DomainName.registrable(s.host)) === brand)) continue;
      const site = ImportAnalyzer.siteCandidate(page.url, filmPagesByDomain.get(DomainName.registrable(host)) ?? 0);
      if (site) sites.push(site);
    }
    sites.sort((a, b) => b.filmPages - a.filmPages);

    const history = pages.filter((p) => p.origin === "history");
    return {
      sourceLabel,
      sites: sites.slice(0, 40),
      titles,
      pages: [...history].sort((a, b) => b.lastVisit - a.lastVisit).slice(0, PAGE_LIMIT),
      totalPages: history.length,
    };
  },
};
