// Looks films up with no account and no API key: IMDb's public suggestions for search and Cinemeta
// for descriptions and episode lists, plus the page's own Open Graph tags as a fallback. Port of the
// client half of Core/Metadata.swift by way of windows/Cineon.Core/Metadata/MetadataClient.cs, over
// `fetch`.

import type { TitleKind } from "../parsing/data-copy/models";
import { normalize } from "../parsing/data-copy/libraryText";
import * as UrlText from "../parsing/data-copy/urlText";
import * as Json from "../parsing/strictJson";
import * as SwiftText from "../parsing/swiftText";
import { escapePattern, IcuRegex } from "../parsing/swiftText";
import { SwiftUrl } from "../parsing/swiftUrl";
import { episodeInfo, type EpisodeInfo, type MetadataDetail, type MetadataHit } from "./models";

/** `fetch`, or a fake of it in tests. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  /** Where requests go. The global `fetch` when left out. */
  fetch?: Fetch;
  /** The whole request, headers and body, in milliseconds. 8 seconds, as on the Mac. */
  timeoutMs?: number;
  /** Sent as `User-Agent` (Chrome drops it from `fetch`; Firefox sends it). Null sends none. */
  userAgent?: string | null;
}

const globalFetch: Fetch = (input, init) => fetch(input, init);

const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * The body of a 200 response as text, or null for anything else, including errors and timeouts.
 * With a limit, only that many bytes are read.
 */
export async function getText(
  http: Fetch,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
  limit?: number,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) return null;
    const response = await http(url, { headers, credentials: "omit", signal: controller.signal });
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      return null;
    }
    if (limit === undefined) return await response.text();
    return utf8.decode(await readLimited(response, limit));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function readLimited(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer()).subarray(0, limit);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const piece = value.subarray(0, limit - total);
      chunks.push(piece);
      total += piece.length;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function kindFromQid(qid: string | null): TitleKind | null {
  switch (qid) {
    case "movie":
    case "tvMovie":
    case "video":
    case "short":
    case "tvShort":
    case "tvSpecial":
      return "film";
    case "tvSeries":
    case "tvMiniSeries":
      return "series";
    default:
      return null;
  }
}

/**
 * Looks films up with no account and no API key: IMDb's public suggestions for search and Cinemeta
 * for descriptions and episode lists. Both are unofficial, so every failure here is treated as "no
 * poster" and never gets in the way of watching.
 */
export class MetadataClient {
  /** The Mac's, word for word, so the services answer the same way. */
  static readonly userAgent = "Mozilla/5.0 (Macintosh) Cineon/1.0";

  private static sharedClient: MetadataClient | null = null;

  /** The one the extension uses. */
  static get shared(): MetadataClient {
    return (MetadataClient.sharedClient ??= new MetadataClient());
  }

  private readonly http: Fetch;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;

  constructor(options: HttpOptions = {}) {
    this.http = options.fetch ?? globalFetch;
    this.timeoutMs = options.timeoutMs ?? 8000;
    const agent = options.userAgent === undefined ? MetadataClient.userAgent : options.userAgent;
    this.headers = agent === null ? {} : { "User-Agent": agent };
  }

  // MARK: Search

  /** IMDb's suggestions for a query: films and series only, with posters at 500 pixels. */
  async search(query: string, signal?: AbortSignal): Promise<MetadataHit[]> {
    const url = MetadataClient.searchUrl(query);
    if (url === null) return [];
    const body = await getText(this.http, url, this.headers, this.timeoutMs, signal);
    return body === null ? [] : MetadataClient.parseSearch(body);
  }

  /** The suggestion address for a query, or null when it's under two characters. */
  static searchUrl(query: string): string | null {
    const cleaned = SwiftText.trimWhitespacesAndNewlines(SwiftText.lowercased(query));
    if (SwiftText.count(cleaned) < 2) return null;
    let encoded = UrlText.encode(cleaned, UrlText.pathAllowed);
    // Foundation also encodes colons before the first slash when the set is .urlPathAllowed, so the
    // text can't be read as a scheme: "дюна: частина" has %3A.
    const slash = encoded.indexOf("/");
    const firstSegment = slash < 0 ? encoded : encoded.slice(0, slash);
    encoded = (firstSegment.replaceAll(":", "%3A") + encoded.slice(firstSegment.length)).replaceAll("/", "%2F");
    return SwiftUrl.string(`https://v3.sg.media-imdb.com/suggestion/x/${encoded}.json`);
  }

  /** Reads a suggestion response. Empty when it isn't shaped like one. */
  static parseSearch(json: string): MetadataHit[] {
    try {
      const root = Json.object(Json.parse(json));
      // Decode everything first: one malformed item fails the response, as with JSONDecoder.
      const items = Json.requiredArray(root, "d").map((element) => {
        const item = Json.object(element);
        const image = Json.optionalObject(item, "i");
        return {
          id: Json.requiredString(item, "id"),
          name: Json.string(item, "l"),
          qid: Json.string(item, "qid"),
          subtitle: Json.string(item, "s"),
          year: Json.int(item, "y"),
          rank: Json.int(item, "rank"),
          imageUrl: image === null ? null : Json.string(image, "imageUrl"),
        };
      });
      const hits: MetadataHit[] = [];
      for (const item of items) {
        if (!SwiftText.hasPrefix(item.id, "tt") || item.name === null) continue;
        const kind = kindFromQid(item.qid);
        if (kind === null) continue;
        hits.push({
          id: item.id,
          name: item.name,
          year: item.year,
          kind,
          posterUrl: MetadataClient.resizedPoster(item.imageUrl, 500),
          subtitle: item.subtitle,
          rank: item.rank,
        });
      }
      return hits;
    } catch (e) {
      if (e instanceof Json.Mismatch) return [];
      throw e;
    }
  }

  /** Amazon's image CDN resizes on request, which keeps posters small and fast. */
  static resizedPoster(raw: string | null | undefined, width: number): string | null {
    if (raw == null) return null;
    if (SwiftText.contains(raw, "._V1_")) {
      return SwiftUrl.string(SwiftText.replace(raw, "._V1_.", `._V1_QL75_UX${width}_.`));
    }
    return SwiftUrl.string(raw);
  }

  /** Picks the hit that really is this film. Returns null rather than guessing badly. */
  static bestMatch(
    hits: readonly MetadataHit[],
    name: string,
    year: number | null | undefined,
    kind: TitleKind,
  ): MetadataHit | null {
    const target = normalize(name);
    let isLatin = false;
    for (const ch of name) {
      const v = ch.codePointAt(0)!;
      if (v >= 65 && v <= 122) {
        isLatin = true;
        break;
      }
    }
    let top: MetadataHit | null = null;
    let topScore = 0;
    for (const hit of hits) {
      let score = 0;
      const norm = normalize(hit.name);
      if (norm === target) score += 100;
      else if (SwiftText.hasPrefix(norm, target) || SwiftText.hasPrefix(target, norm)) score += 35;
      if (year != null && hit.year != null) {
        if (year === hit.year) score += 40;
        else if (Math.abs(year - hit.year) <= 1) score += 15;
        else score -= 40;
      }
      if (kind === "series" && hit.kind === "series") score += 20;
      if (kind === "film" && hit.kind === "film") score += 20;
      if (kind === "series" && hit.kind === "film") score -= 15;
      if (kind === "film" && hit.kind === "series") score -= 15;
      if (hit.rank != null) score += Math.max(0, 15 - Math.trunc(hit.rank / 500));
      // The first of the best, like Swift's max(by:).
      if (top === null || score > topScore) {
        top = hit;
        topScore = score;
      }
    }
    if (top === null) return null;
    if (isLatin) return topScore >= 60 ? top : null;
    // Cyrillic and other scripts can't match IMDb's English names by spelling, so trust its
    // translated-title search, for titles popular enough to rank, unless the year contradicts it.
    return topScore >= 5 ? top : null;
  }

  // MARK: Detail

  /**
   * Cinemeta's description, genres, runtime, artwork and episode list. A title of unknown kind, or a
   * cartoon, is tried as a film and then as a series.
   */
  async detail(imdbId: string, kind: TitleKind, signal?: AbortSignal): Promise<MetadataDetail | null> {
    for (const url of MetadataClient.detailUrls(imdbId, kind)) {
      const body = await getText(this.http, url, this.headers, this.timeoutMs, signal);
      if (body === null) continue;
      const detail = MetadataClient.parseDetail(body);
      if (detail !== null) return detail;
    }
    return null;
  }

  /** The addresses `detail` tries, in order. */
  static detailUrls(imdbId: string, kind: TitleKind): string[] {
    const path = kind === "series" ? "series" : "movie";
    const attempts = kind === "unknown" || kind === "cartoon" ? [path, "series"] : [path];
    return attempts
      .map((type) => SwiftUrl.string(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`))
      .filter((url): url is string => url !== null);
  }

  /** Reads a Cinemeta response. Null when it isn't shaped like one or has no `meta`. */
  static parseDetail(json: string): MetadataDetail | null {
    try {
      const root = Json.object(Json.parse(json));
      const meta = Json.optionalObject(root, "meta");
      if (meta === null) return null;
      const description = Json.string(meta, "description");
      const genres = Json.stringArray(meta, "genres");
      const runtime = Json.string(meta, "runtime");
      const poster = Json.string(meta, "poster");
      const background = Json.string(meta, "background");
      const releaseInfo = Json.string(meta, "releaseInfo");
      const videos = (Json.array(meta, "videos") ?? []).map((element) => {
        const v = Json.object(element);
        return {
          name: Json.string(v, "name"),
          season: Json.int(v, "season"),
          number: Json.int(v, "number"),
          episode: Json.int(v, "episode"),
          overview: Json.string(v, "overview"),
          description: Json.string(v, "description"),
          thumbnail: Json.string(v, "thumbnail"),
          released: Json.string(v, "released"),
        };
      });

      const episodes: EpisodeInfo[] = [];
      for (const video of videos) {
        const episode = video.episode ?? video.number;
        if (video.season === null || episode === null) continue;
        episodes.push(
          episodeInfo(video.season, episode, {
            name: video.name,
            overview: video.overview ?? video.description,
            thumbnailUrl: SwiftUrl.string(video.thumbnail),
            released: video.released === null ? null : parseDate(video.released),
          }),
        );
      }
      return {
        overview: description,
        genres: genres ?? [],
        runtimeMinutes: runtime === null ? null : parseRuntime(runtime),
        posterUrl: SwiftUrl.string(poster),
        backdropUrl: SwiftUrl.string(background),
        year: releaseInfo === null ? null : SwiftText.int32(SwiftText.characters(releaseInfo).slice(0, 4).join("")),
        episodes: episodes.filter((e) => e.season > 0).sort((a, b) => a.season - b.season || a.episode - b.episode),
      };
    } catch (e) {
      if (e instanceof Json.Mismatch) return null;
      throw e;
    }
  }

  /**
   * ISO 8601 with fractional seconds, as `ISO8601DateFormatter` with `.withInternetDateTime` and
   * `.withFractionalSeconds` reads it: the fraction is required, and kept to the millisecond.
   * Milliseconds since 1970.
   */
  static parseDate(s: string): number | null {
    return parseDate(s);
  }
}

const INTERNET_DATE =
  /^[\t\n\v\f\r ]*([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})T([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2})\.([0-9]+)(Z|[+-][0-9]{2}(?::?[0-9]{2})?)$/;

function parseDate(s: string): number | null {
  const m = INTERNET_DATE.exec(s);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map((i) => parseInt(m[i]!, 10)) as [
    number, number, number, number, number, number,
  ];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 24 || minute > 59 || second > 59) return null;
  const milliseconds = parseInt((m[7]! + "00").slice(0, 3), 10);
  const zone = m[8]!;
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    offsetMinutes = parseInt(digits.slice(0, 2), 10) * 60 + (digits.length > 2 ? parseInt(digits.slice(2), 10) : 0);
    if (zone[0] === "-") offsetMinutes = -offsetMinutes;
    if (Math.abs(offsetMinutes) > 14 * 60) return null;
  }
  // Like Foundation, a day past the end of the month rolls into the next one.
  const start = new Date(0);
  start.setUTCFullYear(year, month - 1, 1);
  return (
    start.getTime() +
    (day - 1) * 86_400_000 +
    hour * 3_600_000 +
    minute * 60_000 +
    second * 1000 +
    milliseconds -
    offsetMinutes * 60_000
  );
}

/** "166 min" is 166. Only the number at the start counts, so "2h 46min" is 2, as on the Mac. */
function parseRuntime(s: string): number | null {
  let digits = "";
  for (const c of SwiftText.characters(s)) {
    if (!SwiftText.isNumber(c)) break;
    digits += c;
  }
  return SwiftText.int32(digits);
}

// MARK: Page preview

const metaPatterns = new Map<string, IcuRegex[]>();

function metaContent(html: string, property: string): string | null {
  let patterns = metaPatterns.get(property);
  if (!patterns) {
    const name = escapePattern(property);
    patterns = [
      `<meta[^>]+property=["']${name}["'][^>]*content=["']([^"']+)["']`,
      `<meta[^>]+content=["']([^"']+)["'][^>]*property=["']${name}["']`,
    ].map((p) => new IcuRegex(p, true));
    metaPatterns.set(property, patterns);
  }
  for (const pattern of patterns) {
    const m = pattern.match(html);
    if (m) return m[1]!;
  }
  return null;
}

function decodeEntities(text: string): string {
  return SwiftText.replace(SwiftText.replace(SwiftText.replace(text, "&amp;", "&"), "&quot;", '"'), "&#39;", "'");
}

export interface PreviewResult {
  poster: string | null;
  overview: string | null;
}

/**
 * The poster and description a page advertises about itself. The fallback for titles the catalogue
 * doesn't know, which on Ukrainian and Russian sites is quite a few.
 */
export class PagePreview {
  /** Safari's, as on the Mac, so sites serve the same page. */
  static readonly userAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

  private static sharedPreview: PagePreview | null = null;

  static get shared(): PagePreview {
    return (PagePreview.sharedPreview ??= new PagePreview());
  }

  private readonly http: Fetch;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;

  constructor(options: HttpOptions = {}) {
    this.http = options.fetch ?? globalFetch;
    this.timeoutMs = options.timeoutMs ?? 8000;
    const agent = options.userAgent === undefined ? PagePreview.userAgent : options.userAgent;
    this.headers = agent === null ? {} : { "User-Agent": agent };
  }

  async fetch(url: string, signal?: AbortSignal): Promise<PreviewResult> {
    // The tags are in the head. There's no need to read the whole page.
    const html = await getText(this.http, url, this.headers, this.timeoutMs, signal, 300_000);
    if (html === null) return { poster: null, overview: null };
    return PagePreview.parse(html, url);
  }

  static parse(html: string, base: string): PreviewResult {
    const image = metaContent(html, "og:image");
    let poster = image === null ? null : SwiftUrl.from(base).resolve(decodeEntities(image));
    if (poster !== null) {
      const path = SwiftText.lowercased(SwiftUrl.from(poster).path);
      if (SwiftText.contains(path, "logo") || SwiftText.hasSuffix(path, ".svg")) poster = null;
    }
    const description = metaContent(html, "og:description");
    return { poster, overview: description === null ? null : decodeEntities(description) };
  }
}
