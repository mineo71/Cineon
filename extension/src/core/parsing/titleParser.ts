// Turns messy streaming site titles into a clean film name. Handles English, Ukrainian and Russian
// page furniture, because that is what these sites actually look like. Port of Core/TitleParser.swift
// by way of windows/Cineon.Core/Parsing/TitleParser.cs.

import { DomainName } from "./data-copy/domainName";
import { normalize as libraryNormalize } from "./data-copy/libraryText";
import { EpisodeRef, type TitleKind } from "./data-copy/models";
import * as UrlText from "./data-copy/urlText";
import * as Json from "./strictJson";
import * as SwiftText from "./swiftText";
import { escapePattern, IcuRegex } from "./swiftText";
import { SwiftUrl } from "./swiftUrl";

/** Linked data (schema.org) that `meta.js` found on the page. */
export interface LinkedData {
  type?: string | null;
  name?: string | null;
  series?: string | null;
  season?: number | null;
  episode?: number | null;
  year?: number | null;
  image?: string | null;
  description?: string | null;
}

/** What a page says about itself, gathered by `meta.js`. */
export interface PageMeta {
  url: string;
  title: string;
  ogTitle?: string | null;
  ogType?: string | null;
  ogSite?: string | null;
  ogImage?: string | null;
  ogDescription?: string | null;
  twitterTitle?: string | null;
  h1?: string | null;
  ld: LinkedData[];
  icon?: string | null;
  search?: string | null;
}

function pageMetaFrom(value: unknown): PageMeta | null {
  try {
    const o = Json.object(value);
    return {
      url: Json.requiredString(o, "url"),
      title: Json.requiredString(o, "title"),
      ogTitle: Json.string(o, "ogTitle"),
      ogType: Json.string(o, "ogType"),
      ogSite: Json.string(o, "ogSite"),
      ogImage: Json.string(o, "ogImage"),
      ogDescription: Json.string(o, "ogDescription"),
      twitterTitle: Json.string(o, "twitterTitle"),
      h1: Json.string(o, "h1"),
      ld: Json.requiredArray(o, "ld").map((item) => {
        const l = Json.object(item);
        return {
          type: Json.string(l, "type"),
          name: Json.string(l, "name"),
          series: Json.string(l, "series"),
          season: Json.int(l, "season"),
          episode: Json.int(l, "episode"),
          year: Json.int(l, "year"),
          image: Json.string(l, "image"),
          description: Json.string(l, "description"),
        };
      }),
      icon: Json.string(o, "icon"),
      search: Json.string(o, "search"),
    };
  } catch (e) {
    if (e instanceof Json.Mismatch) return null;
    throw e;
  }
}

export const PageMeta = Object.freeze({
  /**
   * Reads what `meta.js` posts, as the Mac's `JSONDecoder` does: `url`, `title` and `ld` must be
   * there, and a value of the wrong type fails the whole thing. Null on failure.
   */
  from: pageMetaFrom,
  /** `from` for JSON text. */
  fromJson(json: string): PageMeta | null {
    try {
      return pageMetaFrom(Json.parse(json));
    } catch (e) {
      if (e instanceof Json.Mismatch) return null;
      throw e;
    }
  },
});

export interface ParsedTitle {
  name: string;
  /** A second name in another language, from titles like "Дюна / Dune". */
  altName: string | null;
  year: number | null;
  ref: EpisodeRef;
  episodeName: string | null;
  kindHint: TitleKind;
  /** Foundation's `absoluteString`; relative when the page named a relative image, as on the Mac. */
  posterUrl: string | null;
  overview: string | null;
  /** 0 to 1. Below 0.5 the interface asks whether the name is right. */
  confidence: number;
}

function parsedTitle(name: string, confidence: number): ParsedTitle {
  return {
    name,
    altName: null,
    year: null,
    ref: EpisodeRef.none,
    episodeName: null,
    kindHint: "unknown",
    posterUrl: null,
    overview: null,
    confidence,
  };
}

// MARK: Parse

function parse(meta: PageMeta): ParsedTitle | null {
  const url = SwiftUrl.parse(meta.url);
  const host = url?.host ?? "";
  const siteTokens = siteNames(host, meta.ogSite ?? null);

  let result: ParsedTitle | null = null;

  const ld = bestLinkedData(meta.ld);
  if (ld) {
    const type = ld.type == null ? null : SwiftText.lowercased(ld.type);
    const isEpisode = type !== null && SwiftText.contains(type, "episode");
    const isSeries = type !== null && SwiftText.contains(type, "series");
    const name = cleanLinkedName(isEpisode ? (ld.series ?? ld.name) : ld.name);
    if (name !== null) {
      let parsed: ParsedTitle = clean(name, siteTokens) ?? parsedTitle(name, 0.9);
      parsed = {
        ...parsed,
        confidence: 0.95,
        year: ld.year ?? parsed.year,
        kindHint: isEpisode || isSeries ? "series" : "film",
      };
      if (ld.season != null && ld.episode != null) {
        parsed = { ...parsed, ref: EpisodeRef.of(ld.season, ld.episode), kindHint: "series" };
      }
      if (isEpisode && ld.series != null) parsed = { ...parsed, episodeName: ld.name ?? null };
      parsed = { ...parsed, overview: ld.description ?? null, posterUrl: SwiftUrl.string(ld.image) };
      result = parsed;
    }
  }

  if (result === null) {
    const candidates: [string | null | undefined, number][] = [
      [meta.ogTitle, 0.8],
      [meta.h1, 0.7],
      [meta.twitterTitle, 0.7],
      [meta.title, 0.6],
    ];
    for (const [text, confidence] of candidates) {
      if (text == null) continue;
      const parsed = clean(text, siteTokens);
      if (parsed === null) continue;
      result = { ...parsed, confidence };
      break;
    }
  }

  if (result === null && url !== null) {
    const fromSlug = parseSlug(url);
    if (fromSlug !== null) result = { ...fromSlug, confidence: 0.35 };
  }

  if (result === null) return null;
  let p = result;

  // Season and episode may live in any of these, even when the name came from elsewhere.
  if (!EpisodeRef.isEpisode(p.ref)) {
    const haystacks = [meta.ogTitle, meta.title, meta.h1, UrlText.decode(meta.url) ?? meta.url];
    for (const text of haystacks) {
      if (text == null) continue;
      const ref = episodeRefIn(text);
      if (ref !== null) {
        p = { ...p, ref };
        break;
      }
    }
  }
  if (EpisodeRef.isEpisode(p.ref)) p = { ...p, kindHint: "series" };
  if (p.kindHint === "unknown" && meta.ogType != null) {
    const type = SwiftText.lowercased(meta.ogType);
    if (SwiftText.contains(type, "movie")) p = { ...p, kindHint: "film" };
    if (SwiftText.contains(type, "tv_show") || SwiftText.contains(type, "episode")) p = { ...p, kindHint: "series" };
  }
  if (p.kindHint === "unknown") p = { ...p, kindHint: kindHint(meta.title + " " + (meta.ogTitle ?? "")) };
  if (url !== null) {
    const path = SwiftText.lowercased(url.path);
    if (CARTOON_PATH.test(path)) {
      p = { ...p, kindHint: "cartoon" };
    } else if (p.kindHint === "unknown") {
      if (SERIES_PATH.test(path)) p = { ...p, kindHint: "series" };
      else if (FILM_PATH.test(path)) p = { ...p, kindHint: "film" };
    }
  }
  if (p.posterUrl === null) p = { ...p, posterUrl: SwiftUrl.string(meta.ogImage) };
  if (p.overview === null) p = { ...p, overview: meta.ogDescription ?? null };
  return p;
}

const CARTOON_PATH = new IcuRegex("/(cartoons?|animation|anime|mult|multfilm|multfilmy|multiki)(/|$)");
const SERIES_PATH = new IcuRegex("/(series|serial|serials|serialy|tv|tv-?shows?)(/|$)");
const FILM_PATH = new IcuRegex("/(films?|filmy|filmi|movies?)(/|$)");

// MARK: Cleaning

/** Phrases that describe the page rather than the film. Longest first, applied whole-word. */
const NOISE_PHRASES = [
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

const NOISE_REGEX = new IcuRegex(
  "(?<![\\p{L}\\p{N}])(?:" +
    NOISE_PHRASES.map((phrase, index) => ({ phrase, index, count: SwiftText.count(phrase) }))
      .sort((a, b) => b.count - a.count || a.index - b.index)
      .map((item) => escapePattern(item.phrase))
      .join("|") +
    ")(?![\\p{L}\\p{N}])",
  true,
);

const EPISODE_PATTERNS = [
  "\\bS(\\d{1,2})[ ._-]?E(\\d{1,4})\\b",
  "\\b(\\d{1,2})x(\\d{2,3})\\b",
  "season[ ._/-]*(\\d{1,2})[ ,.:/_-]*(?:episode|ep)[ ._/-]*(\\d{1,4})",
  "(?:сезон|season)[ ._/-]*(\\d{1,2})[ ,.:/_-]*(?:серія|серия|епізод|эпизод|episode)[ ._/-]*(\\d{1,4})",
  "(\\d{1,2})[ -]*(?:сезон|season)[ ,.:/_-]*(\\d{1,4})[ -]*(?:серія|серия|епізод|эпизод|episode)",
  "/(?:tv|series|show|serial)/[^/]*?/?(?:\\d+/)?(\\d{1,2})/(\\d{1,4})(?:/|$)",
  "[?&]season=(\\d{1,2}).*?[?&](?:episode|ep)=(\\d{1,4})",
  "[?&]s=(\\d{1,2})&e=(\\d{1,4})",
  // HDRezka and its mirrors keep the episode in the fragment: #t:238-s:2-e:3.
  "[#-]s:(\\d{1,2})-e:(\\d{1,4})",
].map((p) => new IcuRegex(p, true));

/** Removes season and episode wording, once it has been read. */
const EPISODE_STRIP = [
  "\\bS\\d{1,2}[ ._-]?E\\d{1,4}\\b",
  "\\b\\d{1,2}x\\d{2,3}\\b",
  "\\bseason[ ._-]*\\d{1,2}(?:[ ,.:_-]*(?:episode|ep)[ ._-]*\\d{1,4})?",
  "\\bepisode[ ._-]*\\d{1,4}\\b",
  "\\b\\d{1,2}[ -]*(?:season|сезон)\\b",
  "\\b\\d{1,4}[ -]*(?:episode|серія|серия|епізод|эпизод)\\b",
  "(?:сезон)[ ._-]*\\d{1,2}",
  "(?:серія|серия|епізод|эпизод)[ ._-]*\\d{1,4}",
].map((p) => new IcuRegex(p, true));

const START = "(?<![\\p{L}\\p{N}])";

/** Everything from these onward describes the release, not the film: the dub, quality or format. */
const TRAILING_FURNITURE = [
  START + "в\\s+озвучк\\p{L}*.*$",
  START + "в\\s+(\\d+\\s*)?(и\\s+\\d+\\s*)?качеств\\p{L}*.*$",
  START + "у\\s+(\\d+\\s*)?якості.*$",
  START + "(скачать|скачати)(?![\\p{L}]).*$",
  START + "торрент(?![\\p{L}]).*$",
  "\\[\\s*(ТВ|TV)[^\\]]*\\]",
  "\\(\\s*(трейлер|тизер|чб|trailer|teaser|режисс[её]рская версия|режисерська версія|18\\+|\\+?субтитры)[^)]*\\)",
  "(?i)\\benglish\\s+sub(/dub)?\\b.*$",
  "(?i)\\bsub/dub\\b.*$",
  "(?i)\\bon\\s+[\\w-]+\\.\\w{2,}\\b.*$",
  START + "скоро\\s*$",
  "(?i)\\bcoming soon\\s*$",
  // An opening bracket that never closes: "Мэйдэй (Mayday".
  "\\s*\\([^)]*$",
].map((p) => new IcuRegex(p, true));

const YEAR_REGEX = new IcuRegex("[\\(\\[]?\\b(19\\d{2}|20[0-4]\\d)\\b[\\)\\]]?");

/** " : " with spaces separates page sections. "Dune: Part Two" has no space before the colon. */
const SEPARATORS = [" | ", " – ", " — ", " - ", " :: ", " : ", " • ", " · ", " » ", " « ", " ~ "];

/** Reads a title string. Returns null if nothing film-like is left after cleaning. */
function clean(raw: string, siteTokens: ReadonlySet<string>): ParsedTitle | null {
  const text = SwiftText.trimWhitespacesAndNewlines(SwiftText.replace(raw, " ", " "));
  if (text.length === 0) return null;

  const ref = episodeRefIn(text) ?? EpisodeRef.none;
  const kind = kindHint(text);

  // Keep the first segment that still says something once the page furniture is gone.
  let name: string | null = null;
  let year: number | null = null;
  for (const segment of splitBy(text, SEPARATORS)) {
    const [cleaned, foundYear] = cleanSegment(segment, siteTokens);
    year ??= foundYear;
    if (!isMeaningful(cleaned)) continue;
    name ??= cleaned;
  }
  if (name === null) return null;

  // "Дюна / Dune" names the same film twice. Keep both, so lookups can use either.
  let alt: string | null = null;
  const bilingual = SwiftText.components(name, " / ").map((part) => SwiftText.trim(part, SwiftText.isWhitespace));
  if (bilingual.length >= 2 && bilingual.every(isMeaningful)) {
    name = bilingual[0]!;
    alt = bilingual[1]!;
  }

  return { ...parsedTitle(name, 0.6), altName: alt, year, ref, kindHint: kind };
}

function cleanSegment(raw: string, siteTokens: ReadonlySet<string>): [string, number | null] {
  let s = raw;
  let year: number | null = null;
  const m = YEAR_REGEX.match(s);
  if (m) {
    const candidate = m[1]!;
    // A name like "1917" or "2012" is the whole title, so leave it alone.
    const withoutYear = YEAR_REGEX.replace(s, " ");
    if (isMeaningful(strip(withoutYear))) {
      year = SwiftText.int32(candidate);
      s = withoutYear;
    }
  }
  for (const regex of EPISODE_STRIP) s = regex.replace(s, " ");
  for (const regex of TRAILING_FURNITURE) s = regex.replace(s, " ");
  s = NOISE_REGEX.replace(s, " ");
  // Removing noise can leave furniture at the very end: "Одиссея скоро смотреть онлайн".
  s = SwiftText.trim(s, SwiftText.isWhitespace);
  for (const regex of TRAILING_FURNITURE) s = regex.replace(s, " ");
  s = strip(s);
  if (siteTokens.has(normalize(s))) return ["", year];
  return [s, year];
}

const SPACES = new IcuRegex("\\s+");
const EMPTY_BRACKETS = new IcuRegex("\\(\\s*\\)|\\[\\s*\\]");

function strip(raw: string): string {
  let s = SPACES.replace(raw, " ");
  s = EMPTY_BRACKETS.replace(s, " ");
  s = SPACES.replace(s, " ");
  // Quotes left unbalanced by the cleaning above would look broken.
  if (SwiftText.countOf(s, (c) => c === "«") !== SwiftText.countOf(s, (c) => c === "»")) {
    s = SwiftText.replace(SwiftText.replace(s, "«", ""), "»", "");
  }
  s = trimQuotes(s);
  // A name wrapped whole in quotes doesn't need them. Quotes inside a name stay.
  if (SwiftText.first(s) === "«" && SwiftText.last(s) === "»" && SwiftText.countOf(s, (c) => c === "«") === 1) {
    s = SwiftText.dropLast(SwiftText.dropFirst(s));
  }
  return s;
}

const QUOTES = new Set(['"', "“", "”", "„", "'"]);
const EDGE_PUNCTUATION = "-–—|:,.;·•~/\\";

function isEdge(cp: number): boolean {
  return SwiftText.isWhitespaceOrNewline(cp) || (cp <= 0xffff && EDGE_PUNCTUATION.includes(String.fromCharCode(cp)));
}

/**
 * Removes furniture from both ends, and quotes that wrap the whole name or have lost their partner.
 * A quote closing a phrase inside the name stays: Charlie Chaplin's "The Rink".
 */
function trimQuotes(raw: string): string {
  let s = SwiftText.trim(raw, isEdge);
  for (;;) {
    const f = SwiftText.first(s);
    const l = SwiftText.last(s);
    if (f === null || l === null) break;
    const count = SwiftText.countOf(s, (c) => QUOTES.has(c) && c !== "'");
    if (QUOTES.has(f) && QUOTES.has(l) && SwiftText.count(s) > 1 && SwiftText.countOf(s, (c) => QUOTES.has(c)) === 2) {
      s = SwiftText.dropLast(SwiftText.dropFirst(s));
    } else if (l !== "'" && QUOTES.has(l) && count % 2 !== 0) {
      s = SwiftText.dropLast(s);
    } else if (f !== "'" && QUOTES.has(f) && count % 2 !== 0) {
      s = SwiftText.dropFirst(s);
    } else {
      break;
    }
    s = SwiftText.trim(s, isEdge);
  }
  return s;
}

function splitBy(s: string, separators: readonly string[]): string[] {
  let parts = [s];
  for (const separator of separators) {
    parts = parts.flatMap((part) => SwiftText.components(part, separator));
  }
  return parts;
}

function isMeaningful(s: string): boolean {
  return SwiftText.count(s) >= 2 && SwiftText.containsAny(s, (cp) => SwiftText.isLetter(cp) || SwiftText.isDecimalDigit(cp));
}

/** The season and episode named in a title or an address, if any. Swift's `episodeRef(in:)`. */
function episodeRefIn(text: string): EpisodeRef | null {
  for (const regex of EPISODE_PATTERNS) {
    const m = regex.match(text);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    const season = SwiftText.int(m[1]);
    const episode = SwiftText.int(m[2]);
    if (season === null || episode === null) continue;
    return EpisodeRef.of(season, episode);
  }
  return null;
}

const CARTOON_WORDS = ["мультфильм", "мультфільм", "мультсериал", "мультсеріал", "cartoon", "аниме", "аніме", "anime"];
const SERIES_WORDS = ["сериал", "серіал", "tv series", "tv show", "сезон", "season "];
const FILM_WORDS = ["фильм", "фільм", "movie", "full film"];

function kindHint(text: string): TitleKind {
  const t = SwiftText.lowercased(text);
  if (CARTOON_WORDS.some((word) => SwiftText.contains(t, word))) return "cartoon";
  if (SERIES_WORDS.some((word) => SwiftText.contains(t, word))) return "series";
  if (FILM_WORDS.some((word) => SwiftText.contains(t, word))) return "film";
  return "unknown";
}

/** The library's matching key. Forwards to the data layer's `LibraryText.normalize`, the one copy. */
function normalize(s: string): string {
  return libraryNormalize(s);
}

// MARK: Helpers

function siteNames(host: string, ogSite: string | null): Set<string> {
  const names = new Set<string>();
  if (host.length > 0) {
    names.add(normalize(DomainName.registrable(host)));
    names.add(normalize(DomainName.displayName(host)));
    names.add(normalize(host));
  }
  if (ogSite !== null) names.add(normalize(ogSite));
  return names;
}

function linkedDataScore(item: LinkedData): number {
  const t = item.type == null ? "" : SwiftText.lowercased(item.type);
  if (SwiftText.contains(t, "episode")) return 4;
  if (SwiftText.contains(t, "movie")) return 3;
  if (SwiftText.contains(t, "series")) return 2;
  if (SwiftText.contains(t, "videoobject")) return 1;
  return 0;
}

function bestLinkedData(items: readonly LinkedData[]): LinkedData | null {
  let best: LinkedData | null = null;
  let bestScore = 0;
  for (const item of items) {
    if (!item.name) continue;
    const score = linkedDataScore(item);
    // The first of the best, like Swift's max(by:).
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

function cleanLinkedName(name: string | null | undefined): string | null {
  if (name == null) return null;
  const trimmed = SwiftText.trimWhitespacesAndNewlines(name);
  return trimmed.length === 0 ? null : trimmed;
}

const GENERIC_SEGMENTS = new Set([
  "watch", "movie", "movies", "film", "films", "tv", "series", "show", "shows", "play", "player", "embed", "video",
  "videos", "season", "episode", "index.php", "ua", "ru", "en",
]);

const FILE_EXTENSION = new IcuRegex("\\.(html?|php)$");
const LEADING_ID = new IcuRegex("^\\d+[-_]");
// Random ids at the end of a slug mix letters and digits ("dune-part-two-19xk2").
const TRAILING_ID = new IcuRegex("[-_](?=[a-zA-Z0-9]*\\d)(?=[a-zA-Z0-9]*[a-zA-Z])[a-zA-Z0-9]{4,}$");
const SLUG_PUNCTUATION = new IcuRegex("[-_.+]+");

function parseSlug(url: SwiftUrl): ParsedTitle | null {
  const path = UrlText.decode(url.path) ?? url.path;
  let slug: string | null = null;
  let longest = -1;
  for (const segment of SwiftText.split(path, "/")) {
    if (GENERIC_SEGMENTS.has(SwiftText.lowercased(segment)) || !SwiftText.containsAny(segment, SwiftText.isLetter)) continue;
    const n = SwiftText.count(segment);
    if (n > longest) {
      slug = segment;
      longest = n;
    }
  }
  if (slug === null) return null;
  // Drop a leading numeric id ("1234-dune-part-two") and a file extension.
  slug = FILE_EXTENSION.replace(slug, "");
  slug = LEADING_ID.replace(slug, "");
  slug = TRAILING_ID.replace(slug, "");
  const spaced = SLUG_PUNCTUATION.replace(slug, " ");
  const parsed = clean(spaced, new Set());
  if (parsed === null) return null;
  const name = SwiftText.split(parsed.name, " ")
    .map((word) => SwiftText.uppercased(SwiftText.first(word) ?? "") + SwiftText.dropFirst(word))
    .join(" ");
  return { ...parsed, name };
}

export const TitleParser = Object.freeze({ parse, clean, episodeRefIn, kindHint, normalize });
