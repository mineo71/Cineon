// Port of Cineon/Core/Models.swift via windows/Cineon.Core/Data/Models.cs.
//
// Swift structs become readonly interfaces (change them with spread: `{ ...title, name }`), each with
// a same-named value holding `make(partial)` and the computed properties as functions. Swift enums
// with raw values become unions of the very same strings. Addresses are plain strings, kept exactly
// as written (Swift's `absoluteString`). Dates are seconds since 1970 (see dates.ts). Optionals are
// `| null`, never `undefined`, so a record means the same after JSON.

import { type UnixTime } from "./dates";
import { graphemeClusters, firstGrapheme } from "./libraryText";
import * as UrlText from "./urlText";

/** `{ allCases, fromRaw }` for a raw-string enum. */
function rawEnum<T extends string>(cases: readonly T[]) {
  return {
    allCases: cases,
    /** The case for this raw value, or null (raw values are case-sensitive, like Swift's). */
    fromRaw(raw: unknown): T | null {
      return typeof raw === "string" && (cases as readonly string[]).includes(raw) ? (raw as T) : null;
    },
  };
}

// MARK: Titles

export type TitleKind = "film" | "series" | "cartoon" | "unknown";
export const TitleKind = {
  ...rawEnum<TitleKind>(["film", "series", "cartoon", "unknown"]),
  label(kind: TitleKind): string {
    return { film: "Film", series: "Series", cartoon: "Cartoon", unknown: "Unsorted" }[kind];
  },
};

export type TitleStatus = "none" | "backlog" | "watching" | "watched";
export const TitleStatus = {
  ...rawEnum<TitleStatus>(["none", "backlog", "watching", "watched"]),
  label(status: TitleStatus): string {
    return { none: "Not in a list", backlog: "Backlog", watching: "Watching", watched: "Watched" }[status];
  },
};

export interface Title {
  readonly id: number;
  readonly name: string;
  readonly normName: string;
  readonly year: number | null;
  readonly kind: TitleKind;
  readonly status: TitleStatus;
  readonly imdbId: string | null;
  readonly posterUrl: string | null;
  readonly backdropUrl: string | null;
  readonly overview: string | null;
  readonly genres: readonly string[];
  readonly runtimeMinutes: number | null;
  /** Out of ten in half steps, kept doubled: 15 is 7.5. Null is not rated. */
  readonly ratingHalves: number | null;
  readonly notes: string | null;
  readonly addedAt: UnixTime;
  readonly updatedAt: UnixTime;
  readonly finishedAt: UnixTime | null;
  readonly lastWatchedAt: UnixTime | null;
  readonly metadataChecked: boolean;
  readonly ratedAt: UnixTime | null;
  readonly statusAt: UnixTime | null;
}

export const Title = {
  make(fields: Partial<Title> = {}): Title {
    return {
      id: 0,
      name: "",
      normName: "",
      year: null,
      kind: "unknown",
      status: "none",
      imdbId: null,
      posterUrl: null,
      backdropUrl: null,
      overview: null,
      genres: [],
      runtimeMinutes: null,
      ratingHalves: null,
      notes: null,
      addedAt: 0,
      updatedAt: 0,
      finishedAt: null,
      lastWatchedAt: null,
      metadataChecked: false,
      ratedAt: null,
      statusAt: null,
      ...fields,
    };
  },

  /** Out of ten, such as 7.5. */
  rating(title: Pick<Title, "ratingHalves">): number | null {
    return title.ratingHalves == null ? null : title.ratingHalves / 2;
  },
};

/** Ratings out of ten, in half stars. */
export const Rating = {
  maxHalves: 20,

  /** "7.5", "8", "10". */
  text(halves: number): string {
    const whole = Math.trunc(halves / 2);
    return halves % 2 === 0 ? String(whole) : `${whole}.5`;
  },

  clamp(halves: number): number {
    return Math.min(Rating.maxHalves, Math.max(1, halves));
  },
};

export interface EpisodeRef {
  readonly season: number;
  readonly episode: number;
}

export const EpisodeRef = {
  /** Films are stored as season 0, episode 0. */
  none: Object.freeze({ season: 0, episode: 0 }) as EpisodeRef,

  make(season: number, episode: number): EpisodeRef {
    return { season, episode };
  },

  isEpisode(ref: EpisodeRef): boolean {
    return ref.season > 0 || ref.episode > 0;
  },

  equals(a: EpisodeRef | null | undefined, b: EpisodeRef | null | undefined): boolean {
    if (a == null || b == null) return a == b;
    return a.season === b.season && a.episode === b.episode;
  },
};

/** A series' newest aired episode as last checked, and what came out since. */
export interface EpisodeAlert {
  readonly titleId: number;
  readonly latest: EpisodeRef;
  readonly checkedAt: UnixTime;
  readonly newest: EpisodeRef | null;
  readonly newCount: number;
  readonly newAt: UnixTime | null;
}

export const EpisodeAlert = {
  make(fields: Partial<EpisodeAlert> = {}): EpisodeAlert {
    return { titleId: 0, latest: EpisodeRef.none, checkedAt: 0, newest: null, newCount: 0, newAt: null, ...fields };
  },
};

// MARK: Watching

export interface WatchProgress {
  readonly titleId: number;
  readonly ref: EpisodeRef;
  readonly urlKey: string;
  readonly url: string | null;
  readonly host: string;
  readonly position: number;
  readonly duration: number;
  readonly finished: boolean;
  readonly updatedAt: UnixTime;
}

export const WatchProgress = {
  make(fields: Partial<WatchProgress> = {}): WatchProgress {
    return {
      titleId: 0,
      ref: EpisodeRef.none,
      urlKey: "",
      url: null,
      host: "",
      position: 0,
      duration: 0,
      finished: false,
      updatedAt: 0,
      ...fields,
    };
  },

  fraction(p: WatchProgress): number {
    return p.duration > 0 ? Math.min(1, p.position / p.duration) : 0;
  },

  remaining(p: WatchProgress): number {
    return Math.max(0, p.duration - p.position);
  },
};

export interface WatchSession {
  /** 0 until saved. */
  readonly id: number;
  readonly titleId: number;
  readonly ref: EpisodeRef;
  readonly episodeName: string | null;
  readonly url: string | null;
  readonly host: string;
  readonly startedAt: UnixTime;
  readonly endedAt: UnixTime;
  readonly watchedSeconds: number;
  readonly startPosition: number;
  readonly endPosition: number;
  readonly duration: number;
  readonly finished: boolean;
}

export const WatchSession = {
  make(fields: Partial<WatchSession> = {}): WatchSession {
    return {
      id: 0,
      titleId: 0,
      ref: EpisodeRef.none,
      episodeName: null,
      url: null,
      host: "",
      startedAt: 0,
      endedAt: 0,
      watchedSeconds: 0,
      startPosition: 0,
      endPosition: 0,
      duration: 0,
      finished: false,
      ...fields,
    };
  },
};

/** Swift's `SkipRule.Kind`. */
export type SkipRuleKind = "intro" | "credits";
export const SkipRuleKind = rawEnum<SkipRuleKind>(["intro", "credits"]);

/** Something to jump over in every episode of a series, learned from watching you do it. */
export interface SkipRule {
  readonly id: number;
  readonly titleId: number;
  /** The site's brand, so that mirrors of one site share their rules. */
  readonly site: string;
  readonly kind: SkipRuleKind;
  /** Intro: where it starts. Credits: how many seconds before the end they begin. */
  readonly start: number;
  /** Intro: where it ends. Credits: unused. */
  readonly end: number;
  /** How many times this was seen. Credits only roll on by themselves once two agree. */
  readonly sightings: number;
  /** How many times it was undone. Two, and the rule is dropped. */
  readonly misses: number;
  readonly updatedAt: UnixTime;
}

export const SkipRule = {
  make(fields: Partial<SkipRule> = {}): SkipRule {
    return {
      id: 0,
      titleId: 0,
      site: "",
      kind: "intro",
      start: 0,
      end: 0,
      sightings: 0,
      misses: 0,
      updatedAt: 0,
      ...fields,
    };
  },
};

/** One real frame from something you watched, saved as a small image in this profile. */
export interface FilmFrame {
  readonly id: number;
  readonly sessionId: number | null;
  readonly titleId: number;
  readonly ref: EpisodeRef;
  readonly position: number;
  readonly url: string | null;
  /** The image's key in the profile's frame files, `<titleId>/<name>.jpg` like the apps' Frames folder. */
  readonly file: string;
  /** Saved on purpose, rather than collected along the way. */
  readonly isMoment: boolean;
  /** Higher for frames with more going on, so the best one can represent a session. */
  readonly interest: number;
  readonly at: UnixTime;
}

export const FilmFrame = {
  make(fields: Partial<FilmFrame> = {}): FilmFrame {
    return {
      id: 0,
      sessionId: null,
      titleId: 0,
      ref: EpisodeRef.none,
      position: 0,
      url: null,
      file: "",
      isMoment: false,
      interest: 0,
      at: 0,
      ...fields,
    };
  },
};

// MARK: Media and downloads

/** Swift's `MediaSource.Kind`. */
export type MediaSourceKind = "file" | "hls" | "subtitle";
export const MediaSourceKind = rawEnum<MediaSourceKind>(["file", "hls", "subtitle"]);

/** A file a player asked for, as it would show in the Network tab. */
export interface MediaSource {
  readonly url: string;
  readonly kind: MediaSourceKind;
  /** Milliseconds since 1970, when the page first asked for it. */
  readonly foundAt: number;
  /** Asked for since the video now in the player started loading. */
  readonly isCurrent: boolean;
}

const SUFFIX_QUALITY = /(\d{3,4})p(?:[^a-z0-9]|$)/i;
const FILE_QUALITY = /[/_-](240|360|480|720|1080|1440|2160)\.(?:mp4|m3u8)/i;

export const MediaSource = {
  /** Swift's `MediaSource.quality(in:)`: "1080p" from addresses like `.../1080.mp4` or `..._720p.mp4`. */
  qualityIn(text: string): string | null {
    for (const regex of [SUFFIX_QUALITY, FILE_QUALITY]) {
      const match = regex.exec(text);
      if (match) return match[1] + "p";
    }
    return null;
  },

  quality(source: MediaSource): string | null {
    return MediaSource.qualityIn(source.url);
  },

  qualityRank(source: MediaSource): number {
    const q = MediaSource.quality(source);
    if (q == null) return 0;
    const digits = q.slice(0, -1);
    return /^\d+$/.test(digits) ? parseInt(digits, 10) : 0;
  },

  /**
   * Which of the files a player asked for is the film: the one it's playing if that's a plain
   * file, otherwise the best quality among those it asked for since loading it, a whole file
   * before a playlist.
   */
  best(sources: Iterable<MediaSource>, playing: string | null): MediaSource | null {
    const videos = Array.from(sources).filter((s) => s.kind !== "subtitle");
    if (playing != null) {
      const exact = videos.find((s) => s.kind === "file" && s.url === playing);
      if (exact) return exact;
    }
    const current = videos.filter((s) => s.isCurrent);
    const pool = current.length === 0 ? videos : current;
    // Swift's max(by:): the first of equals wins.
    let best: MediaSource | null = null;
    for (const source of pool) {
      if (best == null || isBefore(best, source)) best = source;
    }
    return best;
  },
};

function isBefore(a: MediaSource, b: MediaSource): boolean {
  if ((a.kind === "file") !== (b.kind === "file")) return b.kind === "file";
  const ra = MediaSource.qualityRank(a);
  const rb = MediaSource.qualityRank(b);
  if (ra !== rb) return ra < rb;
  // Of two playlists, the first asked for is the master. Of two files, the latest.
  return a.kind === "hls" ? a.foundAt > b.foundAt : a.foundAt < b.foundAt;
}

/** What voice boost is doing in one player. */
export type VoiceBoostState = "off" | "on" | "unsupported" | "waiting";
export const VoiceBoostState = {
  ...rawEnum<VoiceBoostState>(["off", "on", "unsupported", "waiting"]),
  note(state: VoiceBoostState): string | null {
    if (state === "unsupported") return "This player won't let Cineon change its sound";
    if (state === "waiting") return "Click the video once to turn it on";
    return null;
  },
};

export type DownloadStatus = "queued" | "downloading" | "failed" | "done";
export const DownloadStatus = {
  ...rawEnum<DownloadStatus>(["queued", "downloading", "failed", "done"]),
  isActive(status: DownloadStatus): boolean {
    return status === "queued" || status === "downloading";
  },
};

/** A film or episode saved to this computer. */
export interface DownloadItem {
  readonly id: number;
  readonly titleId: number | null;
  readonly ref: EpisodeRef;
  readonly name: string;
  readonly sourceUrl: string;
  readonly pageUrl: string | null;
  readonly referer: string | null;
  readonly host: string;
  readonly kind: MediaSourceKind;
  readonly quality: string | null;
  /** Where the file is, once it exists (the browser's path for it). */
  readonly file: string | null;
  readonly subtitles: readonly string[];
  readonly bytes: number;
  readonly totalBytes: number;
  readonly status: DownloadStatus;
  readonly error: string | null;
  readonly position: number;
  readonly duration: number;
  readonly posterUrl: string | null;
  readonly createdAt: UnixTime;
  readonly finishedAt: UnixTime | null;
  readonly playedAt: UnixTime | null;
}

const BANNED_IN_FILE_NAMES = new Set(Array.from("/\\:?%*|\"<>\n\r\t"));

export const DownloadItem = {
  make(fields: Partial<DownloadItem> & Pick<DownloadItem, "sourceUrl">): DownloadItem {
    return {
      id: 0,
      titleId: null,
      ref: EpisodeRef.none,
      name: "",
      pageUrl: null,
      referer: null,
      host: "",
      kind: "file",
      quality: null,
      file: null,
      subtitles: [],
      bytes: 0,
      totalBytes: 0,
      status: "queued",
      error: null,
      position: 0,
      duration: 0,
      posterUrl: null,
      createdAt: 0,
      finishedAt: null,
      playedAt: null,
      ...fields,
    };
  },

  fraction(d: DownloadItem): number {
    return d.totalBytes > 0 ? Math.min(1, d.bytes / d.totalBytes) : 0;
  },

  watchedFraction(d: DownloadItem): number {
    return d.duration > 0 ? Math.min(1, d.position / d.duration) : 0;
  },

  /** `S01E02`, or null for a film. */
  episodeBadge(d: DownloadItem): string | null {
    if (!EpisodeRef.isEpisode(d.ref)) return null;
    const two = (n: number) => String(n).padStart(2, "0");
    return `S${two(d.ref.season)}E${two(d.ref.episode)}`;
  },

  /** `Severance S01E02 [1080p]` or `Dune Part Two [1080p]`, safe for any file system. */
  fileBaseName(d: DownloadItem): string {
    let name = d.name;
    const badge = DownloadItem.episodeBadge(d);
    if (badge != null) name += " " + badge;
    if (d.quality != null) name += ` [${d.quality}]`;
    let replaced = "";
    for (const c of name) replaced += BANNED_IN_FILE_NAMES.has(c) ? " " : c;
    const cleaned = replaced.replaceAll("  ", " ").trim();
    const result = cleaned.length === 0 ? "Video" : cleaned;
    const characters = graphemeClusters(result);
    return characters.length > 120 ? characters.slice(0, 120).join("") : result;
  },
};

export type CaptionStyle = "site" | "large" | "huge";

// The Mac names its system font here, Windows Segoe UI; the browser's own UI font stands in.
function band(scale: number): string {
  return (
    `font-size: ${scale}% !important; line-height: 1.25 !important; color: #fff !important; ` +
    "background: rgba(0,0,0,.72) !important; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif !important;"
  );
}

export const CaptionStyle = {
  ...rawEnum<CaptionStyle>(["site", "large", "huge"]),
  label(style: CaptionStyle): string {
    return { site: "As the site sets them", large: "Large, on a dark band", huge: "Very large, on a dark band" }[style];
  },
  /** Applied to the browser's own text tracks. Players that draw their own captions keep theirs. */
  css(style: CaptionStyle): string | null {
    return style === "large" ? band(135) : style === "huge" ? band(175) : null;
  },
  /** Points, for captions a native player draws. */
  nativeSize(style: CaptionStyle): number {
    return style === "large" ? 32 : style === "huge" ? 42 : 26;
  },
};

// MARK: Library events, sites, history

export type LibraryEventKind = "addedToBacklog" | "markedWatched" | "markedWatching" | "removed";
export const LibraryEventKind = {
  ...rawEnum<LibraryEventKind>(["addedToBacklog", "markedWatched", "markedWatching", "removed"]),
  label(kind: LibraryEventKind): string {
    return {
      addedToBacklog: "Added to backlog",
      markedWatched: "Marked as watched",
      markedWatching: "Moved to watching",
      removed: "Removed from lists",
    }[kind];
  },
};

export interface LibraryEvent {
  readonly id: number;
  readonly kind: LibraryEventKind;
  readonly titleId: number;
  readonly at: UnixTime;
}

export interface Site {
  readonly id: number;
  readonly name: string;
  readonly host: string;
  readonly homeUrl: string;
  readonly searchTemplate: string | null;
  readonly iconUrl: string | null;
  readonly position: number;
  readonly addedAt: UnixTime;
  readonly lastUsedAt: UnixTime | null;
}

export const Site = {
  make(fields: Partial<Site> & Pick<Site, "homeUrl">): Site {
    return {
      id: 0,
      name: "",
      host: "",
      searchTemplate: null,
      iconUrl: null,
      position: 0,
      addedAt: 0,
      lastUsedAt: null,
      ...fields,
    };
  },

  /** The template with `%s` replaced by the query, or null without a template. Swift's `searchURL(for:)`. */
  searchUrl(site: Pick<Site, "searchTemplate">, query: string): string | null {
    if (site.searchTemplate == null) return null;
    const encoded = UrlText.encode(query, UrlText.queryAllowed).replaceAll("&", "%26").replaceAll("+", "%2B");
    return Urls.parse(site.searchTemplate.replaceAll("%s", encoded));
  },
};

export interface HistoryEntry {
  readonly id: number;
  readonly url: string;
  readonly host: string;
  readonly title: string;
  readonly visitedAt: UnixTime;
}

export interface SitePrefs {
  readonly host: string;
  readonly shieldsOff: boolean;
  readonly allowPopups: boolean;
  readonly allowRedirects: boolean;
  /** For sites that aren't about films, like YouTube: nothing here goes on the timeline. */
  readonly trackingOff: boolean;
}

export const SitePrefs = {
  make(host: string, fields: Partial<Omit<SitePrefs, "host">> = {}): SitePrefs {
    return { host, shieldsOff: false, allowPopups: false, allowRedirects: false, trackingOff: false, ...fields };
  },
};

export interface ShieldStats {
  readonly ads: number;
  readonly popups: number;
  readonly redirects: number;
  readonly overlays: number;
}

export const ShieldStats = {
  make(fields: Partial<ShieldStats> = {}): ShieldStats {
    return { ads: 0, popups: 0, redirects: 0, overlays: 0, ...fields };
  },
  total(s: ShieldStats): number {
    return s.ads + s.popups + s.redirects + s.overlays;
  },
};

// MARK: Appearance and search

export type AppTheme = "dark" | "white";
export const AppTheme = {
  ...rawEnum<AppTheme>(["dark", "white"]),
  label(theme: AppTheme): string {
    return theme === "dark" ? "Dark" : "White";
  },
};

export type SearchEngine = "duckDuckGo" | "google" | "brave" | "kagi";
export const SearchEngine = {
  ...rawEnum<SearchEngine>(["duckDuckGo", "google", "brave", "kagi"]),
  label(engine: SearchEngine): string {
    return { duckDuckGo: "DuckDuckGo", google: "Google", brave: "Brave Search", kagi: "Kagi" }[engine];
  },
  url(engine: SearchEngine, query: string): string | null {
    const [host, path] = {
      duckDuckGo: ["duckduckgo.com", "/"],
      google: ["www.google.com", "/search"],
      brave: ["search.brave.com", "/search"],
      kagi: ["kagi.com", "/search"],
    }[engine];
    return Urls.parse(`https://${host}${path}?q=${UrlText.encode(query, UrlText.queryItemAllowed)}`);
  },
};

// MARK: Helpers

export const Timecode = {
  /** 1:02:03 or 42:10. */
  string(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const total = Math.trunc(seconds);
    const h = Math.trunc(total / 3600);
    const m = Math.trunc((total % 3600) / 60);
    const s = total % 60;
    const two = (n: number) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
  },

  /** "1 h 12 min", "42 min" or "under a minute". */
  spoken(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "";
    const minutes = Math.round(seconds / 60);
    if (minutes < 1) return "under a minute";
    if (minutes < 60) return `${minutes} min`;
    const h = Math.trunc(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? `${h} h` : `${h} h ${m} min`;
  },
};

const TRACKING = ["utm_", "fbclid", "gclid", "ref", "ref_", "yclid", "mc_", "_ga"];
const EPISODE_FRAGMENT = /s:\d+-e:\d+/;

function compareOrdinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Swift's `URLKey`. */
export const UrlKey = {
  /** A stable key for "this page", ignoring fragments and tracking parameters. `url` is the exact text. */
  make(url: string): string {
    const original = url;
    const parts = UrlText.split(UrlText.encodeInvalid(original));

    // Some sites switch episodes by changing only the fragment. It's part of the page's identity
    // there. The dub in it isn't: changing voice is still the same episode.
    let fragment: string | null = null;
    if (parts.fragment != null) {
      const match = EPISODE_FRAGMENT.exec(UrlText.decode(parts.fragment) ?? parts.fragment);
      if (match) fragment = UrlText.encode(match[0], UrlText.fragmentAllowed);
    }

    // No scheme, user or password; the host lower-cased and without www.
    let authority: string | null = null;
    if (parts.authority != null) {
      let hostAndPort = parts.authority;
      const at = hostAndPort.lastIndexOf("@");
      if (at >= 0) hostAndPort = hostAndPort.slice(at + 1);
      let host: string;
      let port: string | null = null;
      if (hostAndPort.startsWith("[")) {
        const close = hostAndPort.indexOf("]");
        if (close < 0) return original;
        host = hostAndPort.slice(0, close + 1);
        const rest = hostAndPort.slice(close + 1);
        if (rest.startsWith(":")) port = rest.slice(1);
        else if (rest.length > 0) return original;
      } else {
        const colon = hostAndPort.lastIndexOf(":");
        host = colon >= 0 ? hostAndPort.slice(0, colon) : hostAndPort;
        if (colon >= 0) port = hostAndPort.slice(colon + 1);
      }
      if (port != null) {
        if (port.length === 0) port = null;
        else if (!/^[0-9]+$/.test(port)) return original;
        else port = port.replace(/^0+/, "") || "0";
      }
      host = (UrlText.decode(host) ?? host).toLowerCase();
      if (host.startsWith("www.")) host = host.slice(4);
      authority = UrlText.encode(host, UrlText.hostAllowed) + (port == null ? "" : ":" + port);
    }

    let query: string | null = null;
    if (parts.query != null) {
      const items =
        parts.query.length === 0
          ? []
          : parts.query.split("&").map((item) => {
              const eq = item.indexOf("=");
              if (eq < 0) return { name: UrlText.decode(item) ?? item, value: null as string | null };
              const name = item.slice(0, eq);
              const value = item.slice(eq + 1);
              return { name: UrlText.decode(name) ?? name, value: UrlText.decode(value) ?? value };
            });
      const kept = items
        .filter((item) => !TRACKING.some((prefix) => item.name.toLowerCase().startsWith(prefix)))
        .sort((a, b) => compareOrdinal(a.name, b.name));
      if (kept.length > 0) {
        query = kept
          .map(
            (item) =>
              UrlText.encode(item.name, UrlText.queryItemAllowed) +
              (item.value == null ? "" : "=" + UrlText.encode(item.value, UrlText.queryItemAllowed)),
          )
          .join("&");
      }
    }

    let path = parts.path;
    if (path.endsWith("/")) {
      const decoded = (UrlText.decode(path) ?? path).replace(/\/+$/, "");
      path = UrlText.encode(decoded, UrlText.pathAllowed);
    }
    if (authority == null) {
      // With no scheme and no host, a colon in the first segment would read as a scheme.
      const slash = path.indexOf("/");
      const first = slash < 0 ? path : path.slice(0, slash);
      if (first.includes(":")) path = first.replaceAll(":", "%3A") + (slash < 0 ? "" : path.slice(slash));
    }

    const key =
      (authority == null ? "" : "//" + authority) +
      path +
      (query == null ? "" : "?" + query) +
      (fragment == null ? "" : "#" + fragment);
    return key.startsWith("//") ? key.slice(2) : key;
  },
};

/** Second-level suffixes that behave like TLDs. Enough for sites people actually visit. */
const COMPOUND_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "me.uk", "com.ua", "org.ua", "net.ua", "in.ua", "kiev.ua", "lviv.ua",
  "co.jp", "or.jp", "ne.jp", "com.au", "net.au", "org.au", "com.br", "net.br", "co.nz", "co.in",
  "co.kr", "com.cn", "com.tw", "com.tr", "com.mx", "com.ar", "co.za", "com.ru", "org.ru", "net.ru",
  "com.pl", "net.pl", "org.pl", "com.de", "co.il", "com.sg", "com.hk", "pp.ua", "biz.ua", "at.ua",
]);

export const DomainName = {
  /** `player.vod.example.co.uk` becomes `example.co.uk`. */
  registrable(host: string): string {
    let h = host.toLowerCase();
    if (h.endsWith(".")) h = h.slice(0, -1);
    if (DomainName.isIPAddress(h)) return h;
    const labels = h.split(".").filter((l) => l.length > 0);
    if (labels.length <= 2) return h;
    const lastTwo = labels.slice(-2).join(".");
    return COMPOUND_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
  },

  isSameSite(a: string | null | undefined, b: string | null | undefined): boolean {
    return a != null && b != null && DomainName.registrable(a) === DomainName.registrable(b);
  },

  isIPAddress(host: string): boolean {
    return (
      host.includes(":") ||
      host
        .split(".")
        .filter((l) => l.length > 0)
        .every((label) => /^[+-]?[0-9]+$/.test(label))
    );
  },

  /** `example.co.uk` becomes `Example`. Used for names and to spot the site in page titles. */
  displayName(host: string): string {
    const registrable = DomainName.registrable(host);
    const first = registrable.split(".").find((l) => l.length > 0) ?? registrable;
    if (first.length === 0) return first;
    const head = firstGrapheme(first);
    return head.toUpperCase() + first.slice(head.length);
  },
};

/** Reading addresses the way `URL(string:)` does. */
export const Urls = {
  /** The exact text when it's an absolute address, otherwise null. */
  parse(text: string | null | undefined): string | null {
    if (!text) return null;
    try {
      new URL(text);
      return text;
    } catch {
      return null;
    }
  },
};
