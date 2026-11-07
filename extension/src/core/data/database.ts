// Port of Cineon/Core/Database.swift via windows/Cineon.Core/Data/Database.cs, on IndexedDB.
//
// One database per profile, `cineon-<PROFILE-UUID>`. Each SQLite table is an object store of the
// same name holding rows with the same column names and value types: dates are seconds since 1970,
// booleans 0/1, genres joined with "|", subtitles with "\n", absent values null. So a row here is a
// row there. Indexes carry the SQLite index names; a few more stand in for the scans SQLite does
// for foreign keys. Foreign keys, cascades, ON CONFLICT and OR IGNORE/REPLACE are done by hand,
// inside one transaction per call.

import { AppSettings } from "./appSettings";
import { StoredDate, type UnixTime } from "./dates";
import { get, getAll, iterate, iterateKeys, prefixRange, request, take, transact } from "./idb";
import {
  DownloadStatus,
  type DownloadItem,
  EpisodeRef,
  type EpisodeAlert,
  type FilmFrame,
  type HistoryEntry,
  type LibraryEvent,
  LibraryEventKind,
  MediaSourceKind,
  ShieldStats,
  type Site,
  SitePrefs,
  type SkipRule,
  SkipRuleKind,
  type Title,
  TitleKind,
  TitleStatus,
  type WatchProgress,
  type WatchSession,
} from "./models";

/** Mirrors the apps' `PRAGMA user_version`: these stores hold schema version 4. */
export const SCHEMA_VERSION = 4;

/** The object stores, named after the SQLite tables (plus `frame_files`, the Frames folder). */
export const Stores = {
  titles: "titles",
  progress: "progress",
  sessions: "sessions",
  events: "events",
  urlLinks: "url_links",
  ignored: "ignored",
  sites: "sites",
  history: "history",
  sitePrefs: "site_prefs",
  stats: "stats",
  settings: "settings",
  skipRules: "skip_rules",
  frames: "frames",
  downloads: "downloads",
  episodeAlerts: "episode_alerts",
  frameFiles: "frame_files",
} as const;

const S = Stores;

/** Every store that holds something keyed on a title, for deleting and merging titles. */
const TITLE_STORES = [
  S.titles,
  S.progress,
  S.sessions,
  S.events,
  S.urlLinks,
  S.skipRules,
  S.frames,
  S.downloads,
  S.episodeAlerts,
];

// MARK: Rows

type Bit = 0 | 1;

interface TitleRow {
  id?: number;
  name: string;
  norm_name: string;
  year: number | null;
  kind: string;
  status: string;
  imdb_id: string | null;
  poster_url: string | null;
  backdrop_url: string | null;
  overview: string | null;
  genres: string;
  runtime_min: number | null;
  rating: number | null;
  notes: string | null;
  added_at: number;
  updated_at: number;
  finished_at: number | null;
  last_watched_at: number | null;
  metadata_checked: Bit;
  rated_at: number | null;
  status_at: number | null;
}

interface ProgressRow {
  title_id: number;
  season: number;
  episode: number;
  url_key: string;
  url: string | null;
  host: string;
  position: number;
  duration: number;
  finished: Bit;
  updated_at: number;
}

interface SessionRow {
  id?: number;
  title_id: number;
  season: number;
  episode: number;
  episode_name: string | null;
  url: string | null;
  host: string;
  started_at: number;
  ended_at: number;
  watched_seconds: number;
  start_position: number;
  end_position: number;
  duration: number;
  finished: Bit;
}

interface EventRow {
  id?: number;
  kind: string;
  title_id: number;
  at: number;
}

interface LinkRow {
  url_key: string;
  title_id: number;
  season: number;
  episode: number;
}

interface IgnoredRow {
  url_key: string;
  at: number;
}

interface SiteRow {
  id?: number;
  name: string;
  host: string;
  home_url: string;
  search_template: string | null;
  icon_url: string | null;
  position: number;
  added_at: number;
  last_used_at: number | null;
}

interface HistoryRow {
  id?: number;
  url: string;
  host: string;
  title: string;
  visited_at: number;
}

interface SitePrefsRow {
  host: string;
  shields_off: Bit;
  allow_popups: Bit;
  allow_redirects: Bit;
  tracking_off: Bit;
}

interface StatsRow {
  day: string;
  ads: number;
  popups: number;
  redirects: number;
  overlays: number;
}

interface SettingsRow {
  key: string;
  /** The settings JSON. The apps keep it as a BLOB of UTF-8; text here, bytes accepted. */
  value: string | Uint8Array | ArrayBuffer;
}

interface SkipRuleRow {
  id?: number;
  title_id: number;
  site: string;
  kind: string;
  start: number;
  end: number;
  sightings: number;
  misses: number;
  updated_at: number;
}

interface FrameRow {
  id?: number;
  session_id: number | null;
  title_id: number;
  season: number;
  episode: number;
  position: number;
  url: string | null;
  file: string;
  is_moment: Bit;
  interest: number;
  at: number;
}

interface DownloadRow {
  id?: number;
  title_id: number | null;
  season: number;
  episode: number;
  name: string;
  source_url: string;
  page_url: string | null;
  referer: string | null;
  host: string;
  kind: string;
  quality: string | null;
  file: string | null;
  subtitles: string;
  bytes: number;
  total_bytes: number;
  status: string;
  error: string | null;
  position: number;
  duration: number;
  poster_url: string | null;
  created_at: number;
  finished_at: number | null;
  played_at: number | null;
}

interface EpisodeAlertRow {
  title_id: number;
  season: number;
  episode: number;
  checked_at: number;
  new_season: number | null;
  new_episode: number | null;
  new_count: number;
  new_at: number | null;
}

/** A saved frame image, the extension's stand-in for a file in the apps' Frames folder. */
export interface FrameFileRow {
  file: string;
  size: number;
  data: FrameData;
}

/** What a frame image is kept as. */
export type FrameData = Blob | ArrayBuffer | Uint8Array;

const bit = (b: boolean): Bit => (b ? 1 : 0);
const flag = (v: unknown): boolean => v === 1 || v === true;
const text = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const optText = (v: unknown): string | null => (typeof v === "string" ? v : null);
/** An address column: null when empty, like `URL(string:)` failing on "". */
const optUrl = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const optNum = (v: unknown): number | null => (typeof v === "number" ? v : null);
const without = <T extends { id?: number }>(row: T): T => {
  const copy = { ...row };
  delete copy.id;
  return copy;
};

// MARK: Mapping

function titleRow(t: Title): TitleRow {
  return {
    name: t.name,
    norm_name: t.normName,
    year: t.year,
    kind: t.kind,
    status: t.status,
    imdb_id: t.imdbId,
    poster_url: t.posterUrl,
    backdrop_url: t.backdropUrl,
    overview: t.overview,
    genres: t.genres.join("|"),
    runtime_min: t.runtimeMinutes,
    rating: t.ratingHalves,
    notes: t.notes,
    added_at: t.addedAt,
    updated_at: t.updatedAt,
    finished_at: t.finishedAt,
    last_watched_at: t.lastWatchedAt,
    metadata_checked: bit(t.metadataChecked),
    rated_at: t.ratedAt,
    status_at: t.statusAt,
  };
}

function mapTitle(r: TitleRow): Title {
  return {
    id: num(r.id),
    name: text(r.name),
    normName: text(r.norm_name),
    year: optNum(r.year),
    kind: TitleKind.fromRaw(r.kind) ?? "unknown",
    status: TitleStatus.fromRaw(r.status) ?? "none",
    imdbId: optText(r.imdb_id),
    posterUrl: optUrl(r.poster_url),
    backdropUrl: optUrl(r.backdrop_url),
    overview: optText(r.overview),
    genres: text(r.genres)
      .split("|")
      .filter((g) => g.length > 0),
    runtimeMinutes: optNum(r.runtime_min),
    ratingHalves: optNum(r.rating),
    notes: optText(r.notes),
    addedAt: num(r.added_at),
    updatedAt: num(r.updated_at),
    finishedAt: optNum(r.finished_at),
    lastWatchedAt: optNum(r.last_watched_at),
    metadataChecked: flag(r.metadata_checked),
    ratedAt: optNum(r.rated_at),
    statusAt: optNum(r.status_at),
  };
}

function progressRow(p: WatchProgress): ProgressRow {
  return {
    title_id: p.titleId,
    season: p.ref.season,
    episode: p.ref.episode,
    url_key: p.urlKey,
    url: p.url,
    host: p.host,
    position: p.position,
    duration: p.duration,
    finished: bit(p.finished),
    updated_at: p.updatedAt,
  };
}

function mapProgress(r: ProgressRow): WatchProgress {
  return {
    titleId: num(r.title_id),
    ref: EpisodeRef.make(num(r.season), num(r.episode)),
    urlKey: text(r.url_key),
    url: optUrl(r.url),
    host: text(r.host),
    position: num(r.position),
    duration: num(r.duration),
    finished: flag(r.finished),
    updatedAt: num(r.updated_at),
  };
}

function sessionRow(s: WatchSession): SessionRow {
  return {
    title_id: s.titleId,
    season: s.ref.season,
    episode: s.ref.episode,
    episode_name: s.episodeName,
    url: s.url,
    host: s.host,
    started_at: s.startedAt,
    ended_at: s.endedAt,
    watched_seconds: s.watchedSeconds,
    start_position: s.startPosition,
    end_position: s.endPosition,
    duration: s.duration,
    finished: bit(s.finished),
  };
}

function mapSession(r: SessionRow): WatchSession {
  return {
    id: num(r.id),
    titleId: num(r.title_id),
    ref: EpisodeRef.make(num(r.season), num(r.episode)),
    episodeName: optText(r.episode_name),
    url: optUrl(r.url),
    host: text(r.host),
    startedAt: num(r.started_at),
    endedAt: num(r.ended_at),
    watchedSeconds: num(r.watched_seconds),
    startPosition: num(r.start_position),
    endPosition: num(r.end_position),
    duration: num(r.duration),
    finished: flag(r.finished),
  };
}

function mapSkipRule(r: SkipRuleRow): SkipRule | null {
  const kind = SkipRuleKind.fromRaw(r.kind);
  if (kind == null) return null;
  return {
    id: num(r.id),
    titleId: num(r.title_id),
    site: text(r.site),
    kind,
    start: num(r.start),
    end: num(r.end),
    sightings: num(r.sightings),
    misses: num(r.misses),
    updatedAt: num(r.updated_at),
  };
}

function frameRow(f: FilmFrame): FrameRow {
  return {
    session_id: f.sessionId,
    title_id: f.titleId,
    season: f.ref.season,
    episode: f.ref.episode,
    position: f.position,
    url: f.url,
    file: f.file,
    is_moment: bit(f.isMoment),
    interest: f.interest,
    at: f.at,
  };
}

function mapFrame(r: FrameRow): FilmFrame {
  return {
    id: num(r.id),
    sessionId: optNum(r.session_id),
    titleId: num(r.title_id),
    ref: EpisodeRef.make(num(r.season), num(r.episode)),
    position: num(r.position),
    url: optUrl(r.url),
    file: text(r.file),
    isMoment: flag(r.is_moment),
    interest: num(r.interest),
    at: num(r.at),
  };
}

function downloadRow(d: DownloadItem): DownloadRow {
  return {
    title_id: d.titleId,
    season: d.ref.season,
    episode: d.ref.episode,
    name: d.name,
    source_url: d.sourceUrl,
    page_url: d.pageUrl,
    referer: d.referer,
    host: d.host,
    kind: d.kind,
    quality: d.quality,
    file: d.file,
    subtitles: d.subtitles.join("\n"),
    bytes: d.bytes,
    total_bytes: d.totalBytes,
    status: d.status,
    error: d.error,
    position: d.position,
    duration: d.duration,
    poster_url: d.posterUrl,
    created_at: d.createdAt,
    finished_at: d.finishedAt,
    played_at: d.playedAt,
  };
}

function mapDownload(r: DownloadRow): DownloadItem | null {
  const source = optUrl(r.source_url);
  if (source == null) return null;
  return {
    id: num(r.id),
    titleId: optNum(r.title_id),
    ref: EpisodeRef.make(num(r.season), num(r.episode)),
    name: text(r.name),
    sourceUrl: source,
    pageUrl: optUrl(r.page_url),
    referer: optText(r.referer),
    host: text(r.host),
    kind: MediaSourceKind.fromRaw(r.kind) ?? "file",
    quality: optText(r.quality),
    file: optText(r.file),
    subtitles: text(r.subtitles)
      .split("\n")
      .filter((s) => s.length > 0),
    bytes: num(r.bytes),
    totalBytes: num(r.total_bytes),
    status: DownloadStatus.fromRaw(r.status) ?? "failed",
    error: optText(r.error),
    position: num(r.position),
    duration: num(r.duration),
    posterUrl: optUrl(r.poster_url),
    createdAt: num(r.created_at),
    finishedAt: optNum(r.finished_at),
    playedAt: optNum(r.played_at),
  };
}

function siteRow(s: Site): SiteRow {
  return {
    name: s.name,
    host: s.host,
    home_url: s.homeUrl,
    search_template: s.searchTemplate,
    icon_url: s.iconUrl,
    position: s.position,
    added_at: s.addedAt,
    last_used_at: s.lastUsedAt,
  };
}

function mapSite(r: SiteRow): Site | null {
  const home = optUrl(r.home_url);
  if (home == null) return null;
  return {
    id: num(r.id),
    name: text(r.name),
    host: text(r.host),
    homeUrl: home,
    searchTemplate: optText(r.search_template),
    iconUrl: optUrl(r.icon_url),
    position: num(r.position),
    addedAt: num(r.added_at),
    lastUsedAt: optNum(r.last_used_at),
  };
}

function mapHistory(r: HistoryRow): HistoryEntry | null {
  const url = optUrl(r.url);
  if (url == null) return null;
  return { id: num(r.id), url, host: text(r.host), title: text(r.title), visitedAt: num(r.visited_at) };
}

function mapEpisodeAlert(r: EpisodeAlertRow): EpisodeAlert {
  return {
    titleId: num(r.title_id),
    latest: EpisodeRef.make(num(r.season), num(r.episode)),
    checkedAt: num(r.checked_at),
    newest: typeof r.new_season === "number" ? EpisodeRef.make(r.new_season, num(r.new_episode)) : null,
    newCount: num(r.new_count),
    newAt: optNum(r.new_at),
  };
}

/** SQLite's BINARY collation: compares code points (UTF-8 byte order), not UTF-16 units. */
function compareBinary(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return x.length - y.length < 0 ? -1 : x.length === y.length ? 0 : 1;
}

/** SQLite's LIKE with no ESCAPE: `%` any run, `_` any one character, ASCII letters in either case. */
function likeMatcher(pattern: string): (value: string) => boolean {
  let source = "";
  for (const ch of pattern) {
    if (ch === "%") source += "[\\s\\S]*";
    else if (ch === "_") source += "[\\s\\S]";
    else if (/[a-zA-Z]/.test(ch)) source += `[${ch.toLowerCase()}${ch.toUpperCase()}]`;
    else source += ch.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
  }
  const regex = new RegExp(`^${source}$`, "u");
  return (value) => regex.test(value);
}

function constraint(message: string): DOMException {
  return new DOMException(message, "ConstraintError");
}

/** A frame image's size in bytes. */
export function frameDataSize(data: FrameData): number {
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  if (data instanceof ArrayBuffer) return data.byteLength;
  return (data as Uint8Array).byteLength;
}

// MARK: Schema

function createSchema(db: IDBDatabase): void {
  const titles = db.createObjectStore(S.titles, { keyPath: "id", autoIncrement: true });
  titles.createIndex("titles_norm", "norm_name");
  // Rows with no IMDb ID aren't in the index, as SQLite's `WHERE imdb_id IS NOT NULL`.
  titles.createIndex("titles_imdb", "imdb_id", { unique: true });

  const progress = db.createObjectStore(S.progress, { keyPath: ["title_id", "season", "episode"] });
  progress.createIndex("progress_url", "url_key");
  progress.createIndex("progress_title", "title_id");

  const sessions = db.createObjectStore(S.sessions, { keyPath: "id", autoIncrement: true });
  sessions.createIndex("sessions_time", "started_at");
  sessions.createIndex("sessions_title", ["title_id", "started_at"]);
  sessions.createIndex("sessions_url", "url");

  const events = db.createObjectStore(S.events, { keyPath: "id", autoIncrement: true });
  events.createIndex("events_time", "at");
  events.createIndex("events_title", "title_id");

  const links = db.createObjectStore(S.urlLinks, { keyPath: "url_key" });
  links.createIndex("url_links_title", "title_id");

  db.createObjectStore(S.ignored, { keyPath: "url_key" });

  const sites = db.createObjectStore(S.sites, { keyPath: "id", autoIncrement: true });
  sites.createIndex("sites_host", "host", { unique: true });

  const history = db.createObjectStore(S.history, { keyPath: "id", autoIncrement: true });
  history.createIndex("history_time", "visited_at");
  history.createIndex("history_url", "url");

  db.createObjectStore(S.sitePrefs, { keyPath: "host" });
  db.createObjectStore(S.stats, { keyPath: "day" });
  db.createObjectStore(S.settings, { keyPath: "key" });

  const skips = db.createObjectStore(S.skipRules, { keyPath: "id", autoIncrement: true });
  skips.createIndex("skip_rules_key", ["title_id", "site", "kind"], { unique: true });
  skips.createIndex("skip_rules_title", "title_id");

  const frames = db.createObjectStore(S.frames, { keyPath: "id", autoIncrement: true });
  // Frames with no session aren't in this index, which is what ON DELETE SET NULL needs.
  frames.createIndex("frames_session", ["session_id", "position"]);
  frames.createIndex("frames_title", ["title_id", "at"]);

  const downloads = db.createObjectStore(S.downloads, { keyPath: "id", autoIncrement: true });
  downloads.createIndex("downloads_time", "created_at");
  downloads.createIndex("downloads_title", "title_id");

  db.createObjectStore(S.episodeAlerts, { keyPath: "title_id" });

  const files = db.createObjectStore(S.frameFiles, { keyPath: "file" });
  // Sizes without loading the images.
  files.createIndex("frame_files_size", "size");
}

// MARK: Database

/** One database per profile. Everything a person does in Cineon lives in it. */
export class Database {
  private constructor(
    /** The open IndexedDB connection. */
    readonly idb: IDBDatabase,
    readonly name: string,
  ) {
    // Another context deleting or upgrading this profile's database: let it.
    idb.onversionchange = () => idb.close();
  }

  /** `cineon-<UUID>`, the UUID in upper case as the apps write it. */
  static nameFor(profileId: string): string {
    return "cineon-" + profileId.toUpperCase();
  }

  /** Opens (creating when new) the database with this name. */
  static open(name: string, factory: IDBFactory = globalThis.indexedDB): Promise<Database> {
    return new Promise((resolve, reject) => {
      const r = factory.open(name, SCHEMA_VERSION);
      r.onupgradeneeded = (event) => {
        if (event.oldVersion < 1) createSchema(r.result);
      };
      r.onsuccess = () => resolve(new Database(r.result, name));
      r.onerror = () => reject(r.error);
      // "blocked" only means another connection hasn't closed yet; ours close on versionchange.
    });
  }

  /** The profile's own database. */
  static openProfile(profileId: string, factory?: IDBFactory): Promise<Database> {
    return Database.open(Database.nameFor(profileId), factory);
  }

  /** Removes a database and everything in it. */
  static delete(name: string, factory: IDBFactory = globalThis.indexedDB): Promise<void> {
    return new Promise((resolve, reject) => {
      const r = factory.deleteDatabase(name);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  }

  close(): void {
    this.idb.close();
  }

  private read<T>(stores: string | readonly string[], body: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    return transact(this.idb, stores, "readonly", body);
  }

  private write<T>(stores: string | readonly string[], body: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    return transact(this.idb, stores, "readwrite", body);
  }

  /** SQLite's `FOREIGN KEY ... REFERENCES titles(id)` check. */
  private static async requireTitle(tx: IDBTransaction, titleId: number): Promise<void> {
    const found = await request(tx.objectStore(S.titles).count(titleId));
    if (found === 0) throw constraint(`FOREIGN KEY constraint failed: no title ${titleId}`);
  }

  // MARK: Episode alerts

  episodeAlerts(): Promise<EpisodeAlert[]> {
    return this.read(S.episodeAlerts, async (tx) =>
      (await getAll<EpisodeAlertRow>(tx.objectStore(S.episodeAlerts))).map(mapEpisodeAlert),
    );
  }

  /** INSERT OR REPLACE. */
  saveEpisodeAlert(a: EpisodeAlert): Promise<void> {
    return this.write([S.titles, S.episodeAlerts], async (tx) => {
      await Database.requireTitle(tx, a.titleId);
      const row: EpisodeAlertRow = {
        title_id: a.titleId,
        season: a.latest.season,
        episode: a.latest.episode,
        checked_at: a.checkedAt,
        new_season: a.newest?.season ?? null,
        new_episode: a.newest?.episode ?? null,
        new_count: a.newCount,
        new_at: a.newAt,
      };
      await request(tx.objectStore(S.episodeAlerts).put(row));
    });
  }

  // MARK: Titles

  allTitles(): Promise<Title[]> {
    return this.read(S.titles, async (tx) => (await getAll<TitleRow>(tx.objectStore(S.titles))).map(mapTitle));
  }

  /** The new title's ID. Rejects with a ConstraintError when another title has the same IMDb ID. */
  insertTitle(t: Title): Promise<number> {
    return this.write(S.titles, async (tx) => Number(await request(tx.objectStore(S.titles).add(titleRow(t)))));
  }

  /** Every column but the ID. Nothing happens when there's no such title. */
  updateTitle(t: Title): Promise<void> {
    return this.write(S.titles, async (tx) => {
      const store = tx.objectStore(S.titles);
      if ((await request(store.count(t.id))) === 0) return;
      await request(store.put({ ...titleRow(t), id: t.id }));
    });
  }

  /** Removes the title and, as the foreign keys do, everything recorded about it. */
  deleteTitle(id: number): Promise<void> {
    return this.write(TITLE_STORES, (tx) => Database.deleteTitleIn(tx, id));
  }

  private static async deleteTitleIn(tx: IDBTransaction, id: number): Promise<void> {
    // ON DELETE CASCADE
    await iterate(tx.objectStore(S.frames).index("frames_title"), prefixRange(id), "next", (c) => {
      c.delete();
    });
    const sessions = tx.objectStore(S.sessions);
    const sessionIds = (await getAll<SessionRow>(sessions.index("sessions_title"), prefixRange(id))).map((r) => r.id!);
    for (const sessionId of sessionIds) sessions.delete(sessionId);
    await Database.detachFrames(tx, sessionIds);
    await iterate(tx.objectStore(S.progress).index("progress_title"), id, "next", (c) => {
      c.delete();
    });
    await iterate(tx.objectStore(S.events).index("events_title"), id, "next", (c) => {
      c.delete();
    });
    await iterate(tx.objectStore(S.urlLinks).index("url_links_title"), id, "next", (c) => {
      c.delete();
    });
    await iterate(tx.objectStore(S.skipRules).index("skip_rules_title"), id, "next", (c) => {
      c.delete();
    });
    tx.objectStore(S.episodeAlerts).delete(id);
    // ON DELETE SET NULL
    await iterate(tx.objectStore(S.downloads).index("downloads_title"), id, "next", (c) => {
      c.update({ ...(c.value as DownloadRow), title_id: null });
    });
    await request(tx.objectStore(S.titles).delete(id));
  }

  /** Frames of deleted sessions stay, with no session (ON DELETE SET NULL). */
  private static async detachFrames(tx: IDBTransaction, sessionIds: readonly number[]): Promise<void> {
    const index = tx.objectStore(S.frames).index("frames_session");
    for (const sessionId of sessionIds) {
      const rows = await getAll<FrameRow>(index, prefixRange(sessionId));
      for (const row of rows) tx.objectStore(S.frames).put({ ...row, session_id: null });
    }
  }

  /**
   * Moves all watch records from one title to another, used when a recognised title turns out to
   * be a duplicate of something already in the library. Progress and skip rules the target
   * already has for the same episode or site stay the target's (SQLite's UPDATE OR IGNORE); the
   * source's copies go with it.
   */
  mergeTitle(from: number, into: number): Promise<void> {
    return this.write(TITLE_STORES, async (tx) => {
      const moveAll = async <R extends { title_id: number | null }>(store: string, index: string, range: IDBKeyRange | number) => {
        const rows = await getAll<R>(tx.objectStore(store).index(index), range);
        for (const row of rows) tx.objectStore(store).put({ ...row, title_id: into });
      };
      await moveAll<SessionRow>(S.sessions, "sessions_title", prefixRange(from));
      await moveAll<EventRow>(S.events, "events_title", from);
      await moveAll<LinkRow>(S.urlLinks, "url_links_title", from);

      const progress = tx.objectStore(S.progress);
      for (const row of await getAll<ProgressRow>(progress.index("progress_title"), from)) {
        if ((await request(progress.count([into, row.season, row.episode]))) > 0) continue;
        progress.delete([from, row.season, row.episode]);
        progress.put({ ...row, title_id: into });
      }

      const skips = tx.objectStore(S.skipRules);
      for (const row of await getAll<SkipRuleRow>(skips.index("skip_rules_title"), from)) {
        if ((await request(skips.index("skip_rules_key").count([into, row.site, row.kind]))) > 0) continue;
        skips.put({ ...row, title_id: into });
      }

      await moveAll<FrameRow>(S.frames, "frames_title", prefixRange(from));
      await moveAll<DownloadRow>(S.downloads, "downloads_title", from);
      await Database.deleteTitleIn(tx, from);
    });
  }

  // MARK: Progress

  /** Latest first. */
  allProgress(): Promise<WatchProgress[]> {
    return this.read(S.progress, async (tx) =>
      (await getAll<ProgressRow>(tx.objectStore(S.progress)))
        .sort((a, b) => num(b.updated_at) - num(a.updated_at))
        .map(mapProgress),
    );
  }

  /** The latest progress saved for this page (`urlKey`), or for this title's episode. */
  progress(urlKey: string): Promise<WatchProgress | null>;
  progress(titleId: number, ref: EpisodeRef): Promise<WatchProgress | null>;
  progress(key: string | number, ref?: EpisodeRef): Promise<WatchProgress | null> {
    return this.read(S.progress, async (tx) => {
      const store = tx.objectStore(S.progress);
      if (typeof key === "number") {
        const r = ref ?? EpisodeRef.none;
        const row = await get<ProgressRow>(store, [key, r.season, r.episode]);
        return row ? mapProgress(row) : null;
      }
      let latest: ProgressRow | null = null;
      for (const row of await getAll<ProgressRow>(store.index("progress_url"), key)) {
        if (latest == null || num(row.updated_at) > num(latest.updated_at)) latest = row;
      }
      return latest ? mapProgress(latest) : null;
    });
  }

  /** Insert, or replace this title's episode; `finished` never goes back to false here. */
  upsertProgress(p: WatchProgress): Promise<void> {
    return this.write([S.titles, S.progress], async (tx) => {
      await Database.requireTitle(tx, p.titleId);
      const store = tx.objectStore(S.progress);
      const existing = await get<ProgressRow>(store, [p.titleId, p.ref.season, p.ref.episode]);
      const row = progressRow(p);
      if (existing && flag(existing.finished)) row.finished = 1;
      await request(store.put(row));
    });
  }

  clearProgress(titleId: number, ref: EpisodeRef): Promise<void> {
    return this.write(S.progress, async (tx) => {
      const store = tx.objectStore(S.progress);
      const existing = await get<ProgressRow>(store, [titleId, ref.season, ref.episode]);
      if (existing) await request(store.put({ ...existing, position: 0, finished: 0 }));
    });
  }

  // MARK: Sessions

  /** Latest first, started before `before` (any time when null). */
  sessions(limit = 300, before: UnixTime | null = null): Promise<WatchSession[]> {
    return this.read(S.sessions, async (tx) => {
      const range = IDBKeyRange.upperBound(before ?? StoredDate.distantFutureUnixSeconds, true);
      const rows = await take<SessionRow>(tx.objectStore(S.sessions).index("sessions_time"), range, "prev", limit);
      return rows.map(mapSession);
    });
  }

  /** Swift's `sessions(titleID:)`: one title's sessions, latest first. */
  sessionsForTitle(titleId: number): Promise<WatchSession[]> {
    return this.read(S.sessions, async (tx) => {
      const rows = await take<SessionRow>(
        tx.objectStore(S.sessions).index("sessions_title"),
        prefixRange(titleId),
        "prev",
        Number.MAX_SAFE_INTEGER,
      );
      return rows.map(mapSession);
    });
  }

  /**
   * The last session of this title's episode that ended at or after `after`; or, given an address,
   * the last time this exact page was watched (for addresses older than the saved progress).
   */
  latestSession(titleId: number, ref: EpisodeRef, after: UnixTime): Promise<WatchSession | null>;
  latestSession(url: string): Promise<WatchSession | null>;
  latestSession(key: number | string, ref?: EpisodeRef, after?: UnixTime): Promise<WatchSession | null> {
    return this.read(S.sessions, async (tx) => {
      const store = tx.objectStore(S.sessions);
      let rows: SessionRow[];
      if (typeof key === "number") {
        const r = ref ?? EpisodeRef.none;
        const since = after ?? 0;
        rows = (await getAll<SessionRow>(store.index("sessions_title"), prefixRange(key))).filter(
          (row) => row.season === r.season && row.episode === r.episode && num(row.ended_at) >= since,
        );
      } else {
        rows = await getAll<SessionRow>(store.index("sessions_url"), key);
      }
      let latest: SessionRow | null = null;
      for (const row of rows) if (latest == null || num(row.ended_at) > num(latest.ended_at)) latest = row;
      return latest ? mapSession(latest) : null;
    });
  }

  insertSession(s: WatchSession): Promise<number> {
    return this.write([S.titles, S.sessions], async (tx) => {
      await Database.requireTitle(tx, s.titleId);
      return Number(await request(tx.objectStore(S.sessions).add(sessionRow(s))));
    });
  }

  /** Updates what changes while watching: the end, time watched, position, duration, finished, address. */
  updateSession(s: WatchSession): Promise<void> {
    return this.write(S.sessions, async (tx) => {
      const store = tx.objectStore(S.sessions);
      const existing = await get<SessionRow>(store, s.id);
      if (!existing) return;
      await request(
        store.put({
          ...existing,
          ended_at: s.endedAt,
          watched_seconds: s.watchedSeconds,
          end_position: s.endPosition,
          duration: s.duration,
          finished: bit(s.finished),
          url: s.url,
          host: s.host,
        } satisfies SessionRow),
      );
    });
  }

  deleteSession(id: number): Promise<void> {
    return this.write([S.sessions, S.frames], async (tx) => {
      await request(tx.objectStore(S.sessions).delete(id));
      await Database.detachFrames(tx, [id]);
    });
  }

  /** Seconds watched per day (UTC days, as on the Mac), for the calendar on the timeline. `day` is its start. */
  secondsPerDay(since: UnixTime): Promise<{ day: UnixTime; seconds: number }[]> {
    return this.read(S.sessions, async (tx) => {
      const rows = await getAll<SessionRow>(tx.objectStore(S.sessions).index("sessions_time"), IDBKeyRange.lowerBound(since));
      const days = new Map<number, number>();
      for (const row of rows) {
        const d = Math.trunc(num(row.started_at) / 86400);
        days.set(d, (days.get(d) ?? 0) + num(row.watched_seconds));
      }
      return [...days.entries()].sort((a, b) => a[0] - b[0]).map(([d, seconds]) => ({ day: d * 86400, seconds }));
    });
  }

  totalSeconds(since: UnixTime): Promise<number> {
    return this.read(S.sessions, async (tx) => {
      const rows = await getAll<SessionRow>(tx.objectStore(S.sessions).index("sessions_time"), IDBKeyRange.lowerBound(since));
      return rows.reduce((sum, row) => sum + num(row.watched_seconds), 0);
    });
  }

  // MARK: Skip rules

  /** One title's rules, by site then kind; or only those for one site. */
  skipRules(titleId: number, site?: string): Promise<SkipRule[]> {
    return this.read(S.skipRules, async (tx) => {
      let rows = await getAll<SkipRuleRow>(tx.objectStore(S.skipRules).index("skip_rules_title"), titleId);
      if (site !== undefined) rows = rows.filter((r) => r.site === site);
      else rows.sort((a, b) => compareBinary(a.site, b.site) || compareBinary(a.kind, b.kind));
      return rows.map(mapSkipRule).filter((r): r is SkipRule => r != null);
    });
  }

  /** Insert, or update the rule this title already has for the site and kind (keeping its ID). */
  saveSkipRule(rule: SkipRule): Promise<void> {
    return this.write([S.titles, S.skipRules], async (tx) => {
      await Database.requireTitle(tx, rule.titleId);
      const store = tx.objectStore(S.skipRules);
      const existing = await get<SkipRuleRow>(store.index("skip_rules_key"), [rule.titleId, rule.site, rule.kind]);
      const row: SkipRuleRow = {
        title_id: rule.titleId,
        site: rule.site,
        kind: rule.kind,
        start: rule.start,
        end: rule.end,
        sightings: rule.sightings,
        misses: rule.misses,
        updated_at: rule.updatedAt,
      };
      await request(existing ? store.put({ ...row, id: existing.id }) : store.add(row));
    });
  }

  deleteSkipRule(id: number): Promise<void> {
    return this.write(S.skipRules, async (tx) => {
      await request(tx.objectStore(S.skipRules).delete(id));
    });
  }

  // MARK: Frames

  /** In order of position. */
  allFrames(): Promise<FilmFrame[]> {
    return this.read(S.frames, async (tx) =>
      (await getAll<FrameRow>(tx.objectStore(S.frames))).sort((a, b) => num(a.position) - num(b.position)).map(mapFrame),
    );
  }

  insertFrame(f: FilmFrame): Promise<number> {
    return this.write([S.titles, S.sessions, S.frames], async (tx) => {
      await Database.requireTitle(tx, f.titleId);
      if (f.sessionId != null && (await request(tx.objectStore(S.sessions).count(f.sessionId))) === 0) {
        throw constraint(`FOREIGN KEY constraint failed: no session ${f.sessionId}`);
      }
      return Number(await request(tx.objectStore(S.frames).add(frameRow(f))));
    });
  }

  deleteFrame(id: number): Promise<void> {
    return this.write(S.frames, async (tx) => {
      await request(tx.objectStore(S.frames).delete(id));
    });
  }

  deleteAllFrames(): Promise<void> {
    return this.write(S.frames, async (tx) => {
      await request(tx.objectStore(S.frames).clear());
    });
  }

  /** Every host this person has been to, latest first, for spotting another address of a site. */
  knownHosts(): Promise<string[]> {
    return this.read([S.history, S.sessions, S.progress], async (tx) => {
      const last = new Map<string, number>();
      const see = (host: unknown, at: unknown) => {
        if (typeof host !== "string" || host === "") return;
        const t = num(at);
        const seen = last.get(host);
        if (seen === undefined || t > seen) last.set(host, t);
      };
      for (const r of await getAll<HistoryRow>(tx.objectStore(S.history))) see(r.host, r.visited_at);
      for (const r of await getAll<SessionRow>(tx.objectStore(S.sessions))) see(r.host, r.ended_at);
      for (const r of await getAll<ProgressRow>(tx.objectStore(S.progress))) see(r.host, r.updated_at);
      return [...last.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 500)
        .map(([host]) => host);
    });
  }

  // MARK: Downloads

  /** Newest first. */
  allDownloads(): Promise<DownloadItem[]> {
    return this.read(S.downloads, async (tx) => {
      const rows = await take<DownloadRow>(
        tx.objectStore(S.downloads).index("downloads_time"),
        null,
        "prev",
        Number.MAX_SAFE_INTEGER,
      );
      return rows.map(mapDownload).filter((d): d is DownloadItem => d != null);
    });
  }

  insertDownload(d: DownloadItem): Promise<number> {
    return this.write([S.titles, S.downloads], async (tx) => {
      if (d.titleId != null) await Database.requireTitle(tx, d.titleId);
      return Number(await request(tx.objectStore(S.downloads).add(downloadRow(d))));
    });
  }

  /** Every column. Nothing happens when there's no such download. */
  updateDownload(d: DownloadItem): Promise<void> {
    return this.write([S.titles, S.downloads], async (tx) => {
      if (d.titleId != null) await Database.requireTitle(tx, d.titleId);
      const store = tx.objectStore(S.downloads);
      if ((await request(store.count(d.id))) === 0) return;
      await request(store.put({ ...downloadRow(d), id: d.id }));
    });
  }

  deleteDownload(id: number): Promise<void> {
    return this.write(S.downloads, async (tx) => {
      await request(tx.objectStore(S.downloads).delete(id));
    });
  }

  // MARK: Events

  addEvent(kind: LibraryEventKind, titleId: number, at: UnixTime = StoredDate.now()): Promise<void> {
    return this.write([S.titles, S.events], async (tx) => {
      await Database.requireTitle(tx, titleId);
      await request(tx.objectStore(S.events).add({ kind, title_id: titleId, at } satisfies EventRow));
    });
  }

  /** Latest first. */
  events(limit = 300): Promise<LibraryEvent[]> {
    return this.read(S.events, async (tx) => {
      const rows = await take<EventRow>(tx.objectStore(S.events).index("events_time"), null, "prev", limit);
      return rows.map((r) => ({
        id: num(r.id),
        kind: LibraryEventKind.fromRaw(r.kind) ?? "removed",
        titleId: num(r.title_id),
        at: num(r.at),
      }));
    });
  }

  // MARK: Links and ignores

  /** Which title and episode a page was linked to by hand. */
  link(urlKey: string): Promise<{ titleId: number; ref: EpisodeRef } | null> {
    return this.read(S.urlLinks, async (tx) => {
      const row = await get<LinkRow>(tx.objectStore(S.urlLinks), urlKey);
      return row ? { titleId: num(row.title_id), ref: EpisodeRef.make(num(row.season), num(row.episode)) } : null;
    });
  }

  /** INSERT OR REPLACE. */
  setLink(urlKey: string, titleId: number, ref: EpisodeRef): Promise<void> {
    return this.write([S.titles, S.urlLinks], async (tx) => {
      await Database.requireTitle(tx, titleId);
      const row: LinkRow = { url_key: urlKey, title_id: titleId, season: ref.season, episode: ref.episode };
      await request(tx.objectStore(S.urlLinks).put(row));
    });
  }

  isIgnored(urlKey: string): Promise<boolean> {
    return this.read(S.ignored, async (tx) => (await request(tx.objectStore(S.ignored).count(urlKey))) > 0);
  }

  ignore(urlKey: string): Promise<void> {
    return this.write(S.ignored, async (tx) => {
      await request(tx.objectStore(S.ignored).put({ url_key: urlKey, at: StoredDate.now() } satisfies IgnoredRow));
    });
  }

  // MARK: Sites

  /** In their order on Home. */
  allSites(): Promise<Site[]> {
    return this.read(S.sites, async (tx) =>
      (await getAll<SiteRow>(tx.objectStore(S.sites)))
        .sort((a, b) => num(a.position) - num(b.position) || num(a.id) - num(b.id))
        .map(mapSite)
        .filter((s): s is Site => s != null),
    );
  }

  /** The new site's ID. Rejects with a ConstraintError when a site with the same host exists. */
  insertSite(s: Site): Promise<number> {
    return this.write(S.sites, async (tx) => Number(await request(tx.objectStore(S.sites).add(siteRow(s)))));
  }

  /** Everything but when it was added. */
  updateSite(s: Site): Promise<void> {
    return this.write(S.sites, async (tx) => {
      const store = tx.objectStore(S.sites);
      const existing = await get<SiteRow>(store, s.id);
      if (!existing) return;
      await request(store.put({ ...siteRow(s), id: s.id, added_at: existing.added_at }));
    });
  }

  deleteSite(id: number): Promise<void> {
    return this.write(S.sites, async (tx) => {
      await request(tx.objectStore(S.sites).delete(id));
    });
  }

  // MARK: History

  addHistory(url: string, host: string, title: string): Promise<void> {
    return this.write(S.history, async (tx) => {
      const store = tx.objectStore(S.history);
      const now = StoredDate.now();
      // Collapse reloads and quick returns to the same page into one row.
      const recent = now - 1800;
      let existing: HistoryRow | null = null;
      for (const row of await getAll<HistoryRow>(store.index("history_url"), url)) {
        if (num(row.visited_at) >= recent && (existing == null || num(row.visited_at) > num(existing.visited_at))) {
          existing = row;
        }
      }
      if (existing) await request(store.put({ ...existing, title, visited_at: now }));
      else await request(store.add({ url, host, title, visited_at: now } satisfies HistoryRow));
    });
  }

  /** Names the latest visit to this page. */
  updateHistoryTitle(url: string, title: string): Promise<void> {
    return this.write(S.history, async (tx) => {
      const store = tx.objectStore(S.history);
      let latest: HistoryRow | null = null;
      for (const row of await getAll<HistoryRow>(store.index("history_url"), url)) {
        if (latest == null || num(row.visited_at) > num(latest.visited_at)) latest = row;
      }
      if (latest) await request(store.put({ ...latest, title }));
    });
  }

  /** Pages whose title or address contains the text (SQLite's LIKE), one per address, latest first. */
  searchHistory(query: string, limit = 8): Promise<HistoryEntry[]> {
    const matches = likeMatcher("%" + query.replaceAll("%", "") + "%");
    return this.read(S.history, async (tx) => {
      const latest = new Map<string, HistoryRow>();
      for (const row of await getAll<HistoryRow>(tx.objectStore(S.history))) {
        if (!matches(text(row.title)) && !matches(text(row.url))) continue;
        const seen = latest.get(row.url);
        if (seen === undefined || num(row.visited_at) > num(seen.visited_at)) latest.set(row.url, row);
      }
      return [...latest.values()]
        .sort((a, b) => num(b.visited_at) - num(a.visited_at))
        .slice(0, Math.max(0, limit))
        .map(mapHistory)
        .filter((h): h is HistoryEntry => h != null);
    });
  }

  /** Latest first. */
  recentHistory(limit = 300): Promise<HistoryEntry[]> {
    return this.read(S.history, async (tx) => {
      const rows = await take<HistoryRow>(tx.objectStore(S.history).index("history_time"), null, "prev", limit);
      return rows.map(mapHistory).filter((h): h is HistoryEntry => h != null);
    });
  }

  clearHistory(): Promise<void> {
    return this.write(S.history, async (tx) => {
      await request(tx.objectStore(S.history).clear());
    });
  }

  // MARK: Site preferences

  sitePrefs(): Promise<Map<string, SitePrefs>> {
    return this.read(S.sitePrefs, async (tx) => {
      const out = new Map<string, SitePrefs>();
      for (const r of await getAll<SitePrefsRow>(tx.objectStore(S.sitePrefs))) {
        out.set(
          r.host,
          SitePrefs.make(r.host, {
            shieldsOff: flag(r.shields_off),
            allowPopups: flag(r.allow_popups),
            allowRedirects: flag(r.allow_redirects),
            trackingOff: flag(r.tracking_off),
          }),
        );
      }
      return out;
    });
  }

  /** INSERT OR REPLACE. */
  saveSitePrefs(p: SitePrefs): Promise<void> {
    return this.write(S.sitePrefs, async (tx) => {
      const row: SitePrefsRow = {
        host: p.host,
        shields_off: bit(p.shieldsOff),
        allow_popups: bit(p.allowPopups),
        allow_redirects: bit(p.allowRedirects),
        tracking_off: bit(p.trackingOff),
      };
      await request(tx.objectStore(S.sitePrefs).put(row));
    });
  }

  // MARK: Shield statistics

  /** Adds to one day's counts. `day` is the Mac's "yyyy-MM-dd" text. */
  addStats(delta: Partial<ShieldStats>, day: string): Promise<void> {
    return this.write(S.stats, async (tx) => {
      const store = tx.objectStore(S.stats);
      const row = (await get<StatsRow>(store, day)) ?? { day, ads: 0, popups: 0, redirects: 0, overlays: 0 };
      await request(
        store.put({
          day,
          ads: num(row.ads) + (delta.ads ?? 0),
          popups: num(row.popups) + (delta.popups ?? 0),
          redirects: num(row.redirects) + (delta.redirects ?? 0),
          overlays: num(row.overlays) + (delta.overlays ?? 0),
        } satisfies StatsRow),
      );
    });
  }

  totalStats(): Promise<ShieldStats> {
    return this.read(S.stats, async (tx) => {
      const total = { ads: 0, popups: 0, redirects: 0, overlays: 0 };
      for (const r of await getAll<StatsRow>(tx.objectStore(S.stats))) {
        total.ads += num(r.ads);
        total.popups += num(r.popups);
        total.redirects += num(r.redirects);
        total.overlays += num(r.overlays);
      }
      return ShieldStats.make(total);
    });
  }

  // MARK: Settings

  /** The profile's settings; the defaults when there are none or they can't be read. */
  async loadSettings(): Promise<AppSettings> {
    try {
      const row = await this.read(S.settings, (tx) => get<SettingsRow>(tx.objectStore(S.settings), "app"));
      if (row?.value == null) return AppSettings.defaults();
      return AppSettings.decode(row.value) ?? AppSettings.defaults();
    } catch {
      return AppSettings.defaults();
    }
  }

  /** Errors are swallowed, as on the Mac. */
  async saveSettings(settings: AppSettings): Promise<void> {
    try {
      await this.write(S.settings, async (tx) => {
        await request(tx.objectStore(S.settings).put({ key: "app", value: AppSettings.encode(settings) } satisfies SettingsRow));
      });
    } catch {
      // As Swift's try?.
    }
  }

  // MARK: Frame files

  /** The image saved as `file`, or null. */
  readFrameFile(file: string): Promise<FrameData | null> {
    return this.read(S.frameFiles, async (tx) => (await get<FrameFileRow>(tx.objectStore(S.frameFiles), file))?.data ?? null);
  }

  writeFrameFile(file: string, data: FrameData): Promise<void> {
    return this.write(S.frameFiles, async (tx) => {
      await request(tx.objectStore(S.frameFiles).put({ file, size: frameDataSize(data), data } satisfies FrameFileRow));
    });
  }

  /** Removes the images whose names start with `prefix`, or exactly `file` when `exact`. */
  deleteFrameFiles(prefix: string, exact = false): Promise<void> {
    return this.write(S.frameFiles, async (tx) => {
      const store = tx.objectStore(S.frameFiles);
      if (exact) await request(store.delete(prefix));
      else if (prefix === "") await request(store.clear());
      else await request(store.delete(IDBKeyRange.bound(prefix, prefix + "￿")));
    });
  }

  /** Each saved image's size in bytes, by name. */
  frameFileSizes(): Promise<Map<string, number>> {
    return this.read(S.frameFiles, async (tx) => {
      const sizes = new Map<string, number>();
      await iterateKeys(tx.objectStore(S.frameFiles).index("frame_files_size"), (size, file) => {
        sizes.set(String(file), Number(size));
      });
      return sizes;
    });
  }
}
