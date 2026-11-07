// Decides which link on a results page is the film being looked for. Getting this wrong means opening
// Dune (1984) instead of Dune (2021), so anything uncertain stays a suggestion. Port of
// Core/RescueMatcher.swift by way of windows/Cineon.Core/Parsing/RescueMatcher.cs.

import { DomainName } from "./data-copy/domainName";
import { normalize } from "./data-copy/libraryText";
import { UrlKey } from "./data-copy/urlKey";
import * as SwiftText from "./swiftText";
import { IcuRegex } from "./swiftText";
import { SwiftUrl } from "./swiftUrl";

/** A link found on a site's search results page. */
export interface RescueLink {
  /** Where it goes: Foundation's `absoluteString` (pass any address through `SwiftUrl.string` first). */
  url: string;
  /** The link's own words: its text, title and image description. */
  text: string;
  /** Words around it, where cards keep the year. */
  context: string;
}

export interface RescueMatch {
  link: RescueLink;
  score: number;
  yearConfirmed: boolean;
}

const STRONG_SCORE = 0.9;
const POSSIBLE_SCORE = 0.6;

/** Sure enough to open without asking. */
function isStrong(match: RescueMatch): boolean {
  return match.score >= STRONG_SCORE && match.yearConfirmed;
}

/**
 * The words of a text, folded like `LibraryText.normalize`: Foundation's case, width and diacritic
 * folding, split wherever a character isn't a letter, mark or number.
 */
function tokens(text: string): string[] {
  const out: string[] = [];
  let run = "";
  let atStart = true;
  const flush = () => {
    if (run.length === 0) return;
    // Foundation's folding keeps accents that open the text, with no letter to belong to.
    const kept = atStart ? leadingAccents(run) : "";
    const token = kept + normalize(run.slice(kept.length));
    if (token.length > 0) out.push(token);
    run = "";
  };
  for (const ch of text) {
    if (SwiftText.isAlphanumeric(ch.codePointAt(0)!)) {
      run += ch;
      continue;
    }
    flush();
    atStart = false;
  }
  flush();
  return out;
}

/** The combining accents at the start of a text, which diacritic folding removes everywhere else. */
function leadingAccents(word: string): string {
  let length = 0;
  for (const ch of word) {
    const v = ch.codePointAt(0)!;
    const accent =
      (v >= 0x0300 && v <= 0x036f) ||
      (v >= 0x1ab0 && v <= 0x1aff) ||
      (v >= 0x1dc0 && v <= 0x1dff) ||
      (v >= 0x20d0 && v <= 0x20ff) ||
      (v >= 0xfe20 && v <= 0xfe2f);
    if (!accent) break;
    length += ch.length;
  }
  return word.slice(0, length);
}

/** Page furniture that says nothing about which film this is. */
const NOISE = new Set(
  [
    "watch", "online", "free", "full", "movie", "film", "hd", "4k", "1080p", "720p", "hdrip", "webrip", "bluray",
    "смотреть", "онлайн", "бесплатно", "фильм", "сериал", "дивитися", "дивитись", "фільм", "серіал",
    "безкоштовно", "українською", "на", "в", "качестве", "хорошем", "озвучке",
  ].flatMap(tokens),
);

/** Something about the film, rather than the film. */
const NOT_THE_FILM = new Set(
  [
    "trailer", "teaser", "review", "reaction", "soundtrack", "ost", "interview", "featurette", "clip", "clips",
    "recap", "explained", "breakdown", "shorts", "behind", "making",
    "трейлер", "тизер", "обзор", "огляд", "рецензия", "рецензія", "интервью", "інтерв", "саундтрек",
  ].flatMap(tokens),
);

const NOT_FILM_PATHS = [
  "/search", "/tag/", "/tags/", "/genre/", "/genres/", "/actor/", "/actors/", "/person/", "/people/", "/country/",
  "/login", "/register", "/signup", "/account", "/user/", "/channel/", "/playlist",
];

const YEAR_PATTERN = new IcuRegex("(?<![0-9])(19|20)[0-9]{2}(?![0-9])");
const SEGMENT_PATTERN = new IcuRegex("\\n|/|\\||\\s[–—-]\\s");

function years(text: string): number[] {
  const out: number[] = [];
  for (const m of YEAR_PATTERN.matches(text)) {
    const value = SwiftText.int32(m[0]);
    if (value !== null) out.push(value);
  }
  return out;
}

function isYear(token: string): boolean {
  if (SwiftText.count(token) !== 4) return false;
  const value = SwiftText.int(token);
  return value !== null && value >= 1900 && value < 2100;
}

/** How well one piece of text names the film, from 0 to 1, leaving the year aside. */
function nameScore(text: string, name: string): number {
  const needle = tokens(name).filter((t) => !isYear(t));
  if (needle.length === 0) return 0;
  const words = tokens(text).filter((t) => !isYear(t));
  if (words.length < needle.length) return 0;

  // Furniture only counts once the name has been found, because a name can contain the same
  // words: "Scary Movie", "The Film".
  for (let start = 0; start <= words.length - needle.length; start++) {
    if (!needle.every((word, i) => words[start + i] === word)) continue;
    const extras = [...words.slice(0, start), ...words.slice(start + needle.length)].filter((t) => !NOISE.has(t));
    // "Dune 2" is a different film from "Dune". "Dune extended cut" probably isn't.
    const numbers = extras.filter((t) => SwiftText.int(t) !== null).length;
    const others = extras.length - numbers;
    return Math.max(0.5, 1 - others * 0.05 - numbers * 0.35);
  }
  return 0;
}

function segments(text: string): string[] {
  const marked = SEGMENT_PATTERN.replace(text, "\u0001");
  return [...SwiftText.split(marked, "\u0001"), text];
}

/** The last part of the address, without its extension or a leading catalogue number: /films/18432-dune.html. */
function slug(url: string): string {
  let last = SwiftUrl.from(url).lastPathComponentWithoutExtension;
  for (;;) {
    const f = SwiftText.first(last);
    if (f === null || !SwiftText.isNumber(f)) break;
    last = SwiftText.dropFirst(last);
  }
  return last;
}

function score(link: RescueLink, names: readonly string[], year: number | null | undefined): RescueMatch {
  const words = new Set(tokens(link.text));
  let best = 0;
  if (![...words].some((w) => NOT_THE_FILM.has(w))) {
    for (const name of names) {
      for (const segment of segments(link.text)) {
        best = Math.max(best, nameScore(segment, name));
      }
      // The address is weaker evidence: enough to suggest, not to open by itself.
      best = Math.max(best, nameScore(slug(link.url), name) * 0.85);
    }
  }

  let confirmed = year == null;
  if (year != null && best > 0) {
    const own = years(link.text);
    const nearby = years(link.context);
    if (own.some((y) => Math.abs(y - year) <= 1)) {
      confirmed = true;
    } else if (own.length > 0) {
      best *= 0.4;
    } else if (nearby.some((y) => Math.abs(y - year) <= 1)) {
      confirmed = true;
    } else if (nearby.length > 0) {
      best *= 0.7;
    }
  }
  return { link, score: best, yearConfirmed: confirmed };
}

/** The best link on a page, if any is good enough to show. */
function best(
  links: Iterable<RescueLink>,
  names: readonly string[],
  year: number | null | undefined,
  pageUrl: string | null | undefined,
): RescueMatch | null {
  let top: RescueMatch | null = null;
  for (const link of links) {
    if (!isCandidate(link.url, pageUrl ?? null)) continue;
    const match = score(link, names, year);
    if (match.score < POSSIBLE_SCORE) continue;
    // The first of the best, like Swift's max(by:).
    if (top === null) {
      top = match;
      continue;
    }
    const a = isStrong(match) ? 1 : 0;
    const b = isStrong(top) ? 1 : 0;
    if (a > b || (a === b && match.score > top.score)) top = match;
  }
  return top;
}

function isCandidate(url: string, pageUrl: string | null): boolean {
  const address = SwiftUrl.from(url);
  const scheme = address.scheme === null ? null : SwiftText.lowercased(address.scheme);
  if (scheme !== "http" && scheme !== "https") return false;
  if (pageUrl !== null) {
    const page = SwiftUrl.from(pageUrl);
    if (!DomainName.isSameSite(address.host, page.host) || UrlKey.make(address.absoluteString) === UrlKey.make(page.absoluteString)) {
      return false;
    }
  }
  const path = SwiftText.lowercased(address.path);
  if (SwiftText.count(path) <= 1) return false;
  return !NOT_FILM_PATHS.some((p) => SwiftText.contains(path, p));
}

const VIDEO_SHARING_SITES = new Set([
  "youtube.com", "youtu.be", "vimeo.com", "dailymotion.com", "rutube.ru", "ok.ru", "vk.com", "facebook.com", "tiktok.com",
]);

/**
 * Anyone can upload anything there, so a name that matches is often not the film. Good to suggest,
 * not to open without asking.
 */
function isVideoSharing(url: string): boolean {
  const host = SwiftUrl.from(url).host;
  return host !== null && VIDEO_SHARING_SITES.has(DomainName.registrable(host));
}

// MARK: Mirrors

/** Words too common to mean two addresses are the same site. */
const GENERIC_BRANDS = new Set([
  "film", "films", "filmy", "kino", "movie", "movies", "online", "watch", "serial", "serials", "series", "tv", "hd",
  "video", "videos", "stream", "cinema", "anime",
]);

/** The same page at other addresses of this site, in the order given. */
function mirrors(url: string, hosts: Iterable<string>): string[] {
  const address = SwiftUrl.from(url);
  const rawHost = address.host;
  if (rawHost === null) return [];
  const host = SwiftText.lowercased(rawHost);
  if (DomainName.isIPAddress(host)) return [];
  const brand = SiteBrand.of(DomainName.registrable(host));
  if (SwiftText.count(brand) < 4 || GENERIC_BRANDS.has(brand)) return [];

  const seen = new Set([DomainName.registrable(host)]);
  const found: string[] = [];
  for (const other of hosts) {
    const candidate = SwiftText.lowercased(other);
    const registrable = DomainName.registrable(candidate);
    if (DomainName.isIPAddress(candidate) || SiteBrand.of(registrable) !== brand || seen.has(registrable)) continue;
    seen.add(registrable);
    const mirror = address.withHost(candidate);
    if (mirror !== null) found.push(mirror);
  }
  return found;
}

export const RescueMatcher = Object.freeze({
  strongScore: STRONG_SCORE,
  possibleScore: POSSIBLE_SCORE,
  isStrong,
  tokens,
  years,
  nameScore,
  score,
  best,
  isVideoSharing,
  mirrors,
});

/**
 * What mirrors of one site share: hdrezka.ag, rezka-ua.co and rezka-tv.org are all "rezka". The
 * Mac's `ImportAnalyzer.brand`; the browser import port should call this rather than keep a copy.
 */
export const SiteBrand = Object.freeze({
  of(domain: string): string {
    let name = SwiftText.split(domain, ".")[0] ?? domain;
    name = SwiftText.split(name, "-")[0] ?? name;
    let chars = SwiftText.characters(name);
    if (chars.length > 4 && chars[0] === "h" && chars[1] === "d") {
      chars = chars.slice(2);
      name = chars.join("");
    }
    const letters = chars.filter((c) => !SwiftText.isNumber(c)).join("");
    return letters.length === 0 ? name : letters;
  },
});
