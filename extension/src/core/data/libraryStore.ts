// Port of Cineon/Core/LibraryStore.swift via windows/Cineon.Core/Data/LibraryStore.cs.
//
// The Mac's @Observable becomes a `changed` emitter that names what changed. Reads are synchronous,
// from memory; writes return promises. A write changes memory first, synchronously, so calls made
// one after another build on each other without waiting; the promise settles once the database
// has it, and `changed` fires then. Collections are replaced, never mutated, so a new identity
// means new contents. Database errors are swallowed, as Swift's `try?` does.

import { StoredDate, type UnixTime } from "./dates";
import { type Database } from "./database";
import { type FrameData, type FrameFiles, IdbFrameFiles } from "./frameFiles";
import { isDatabaseError } from "./idb";
import { LibraryText } from "./libraryText";
import {
  DomainName,
  EpisodeRef,
  type FilmFrame,
  type LibraryEvent,
  type LibraryEventKind,
  Rating,
  type Site,
  Title,
  type TitleKind,
  type TitleStatus,
  Urls,
  type WatchProgress,
  type WatchSession,
} from "./models";
import { Emitter } from "./emitter";

/** What a `changed` notification can name, the Mac's observed properties. */
export type LibraryStoreKey =
  | "titles"
  | "progress"
  | "sessions"
  | "events"
  | "sites"
  | "framesBySession"
  | "momentsByTitle"
  | "bestFrameByTitle"
  | "revision";

const FRAME_KEYS: readonly LibraryStoreKey[] = ["framesBySession", "momentsByTitle", "bestFrameByTitle"];

/** Options for `addTitle`, Swift's defaulted parameters. */
export interface NewTitle {
  year?: number | null;
  kind?: TitleKind;
  status?: TitleStatus;
  imdbId?: string | null;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  overview?: string | null;
}

/**
 * What the cloud backup remembers. Swift's `halves: Int??`: leave `halves` out to keep the rating,
 * pass null to clear it.
 */
export interface Restored {
  halves?: number | null;
  ratedAt?: UnixTime | null;
  status?: TitleStatus | null;
  statusAt?: UnixTime | null;
  finishedAt?: UnixTime | null;
}

async function attempt<T>(body: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await body();
  } catch (error) {
    if (isDatabaseError(error)) return fallback;
    throw error;
  }
}

function attemptVoid(body: () => Promise<unknown>): Promise<void> {
  return attempt(async () => {
    await body();
  }, undefined);
}

interface FrameIndex {
  framesBySession: Map<number, readonly FilmFrame[]>;
  momentsByTitle: Map<number, readonly FilmFrame[]>;
  bestFrameByTitle: Map<number, FilmFrame>;
}

function index(into: FrameIndex, frame: FilmFrame): void {
  if (frame.sessionId != null) {
    const frames = into.framesBySession.get(frame.sessionId) ?? [];
    into.framesBySession.set(frame.sessionId, [...frames, frame].sort((a, b) => a.position - b.position));
  }
  if (frame.isMoment) {
    const moments = into.momentsByTitle.get(frame.titleId) ?? [];
    into.momentsByTitle.set(frame.titleId, [...moments, frame].sort((a, b) => b.at - a.at));
  }
  const best = into.bestFrameByTitle.get(frame.titleId);
  if ((best?.interest ?? -1) < frame.interest) into.bestFrameByTitle.set(frame.titleId, frame);
}

/** `LibraryStore.find` over any titles: by name (or the other name) and, when known, the year give or take one. */
export function findTitle(
  titles: Iterable<Title>,
  name: string,
  altName?: string | null,
  year?: number | null,
): Title | null {
  const keys = [name, altName].filter((n): n is string => n != null).map(LibraryText.normalize);
  const matches = [...titles].filter((t) => keys.includes(t.normName));
  if (year != null) {
    const exact = matches.find((t) => t.year === year);
    if (exact) return exact;
    return matches.find((t) => t.year == null || Math.abs(t.year - year) <= 1) ?? null;
  }
  let latest: Title | null = null;
  for (const t of matches) if (latest == null || t.updatedAt > latest.updatedAt) latest = t;
  return latest;
}

function latestFirst<T>(items: Iterable<T>, date: (item: T) => number): T[] {
  return [...items].sort((a, b) => date(b) - date(a));
}

/** In-memory view of one profile's library, kept in step with the database. */
export class LibraryStore {
  private _titles: ReadonlyMap<number, Title> = new Map();
  private _progress: readonly WatchProgress[] = [];
  private _sessions: readonly WatchSession[] = [];
  private _events: readonly LibraryEvent[] = [];
  private _sites: readonly Site[] = [];
  private _frames: FrameIndex = { framesBySession: new Map(), momentsByTitle: new Map(), bestFrameByTitle: new Map() };
  private _revision = 0;
  private readonly mergedInto = new Map<number, number>();

  /** Called when someone rates or files a title themselves, for the cloud backup. */
  onPersonalChange: ((title: Title) => void) | null = null;

  /** Fires after anything in the store changed, naming what. */
  readonly changed = new Emitter<readonly LibraryStoreKey[]>();

  /** Frame images; the profile database's `frame_files` unless given another home. */
  readonly frameFiles: FrameFiles;

  /** An empty store; call `reload()` (or use `LibraryStore.open`) to load it. */
  constructor(
    readonly db: Database,
    frameFiles?: FrameFiles,
  ) {
    this.frameFiles = frameFiles ?? new IdbFrameFiles(db);
  }

  /** A store loaded from the database. */
  static async open(db: Database, frameFiles?: FrameFiles): Promise<LibraryStore> {
    const store = new LibraryStore(db, frameFiles);
    await store.reload();
    return store;
  }

  get titles(): ReadonlyMap<number, Title> {
    return this._titles;
  }

  /** Latest first. */
  get progress(): readonly WatchProgress[] {
    return this._progress;
  }

  /** The latest 600, newest first. */
  get sessions(): readonly WatchSession[] {
    return this._sessions;
  }

  /** The latest 300, newest first. */
  get events(): readonly LibraryEvent[] {
    return this._events;
  }

  get sites(): readonly Site[] {
    return this._sites;
  }

  /** Each session's frames, in order of position. */
  get framesBySession(): ReadonlyMap<number, readonly FilmFrame[]> {
    return this._frames.framesBySession;
  }

  /** Each title's moments, newest first. */
  get momentsByTitle(): ReadonlyMap<number, readonly FilmFrame[]> {
    return this._frames.momentsByTitle;
  }

  get bestFrameByTitle(): ReadonlyMap<number, FilmFrame> {
    return this._frames.bestFrameByTitle;
  }

  /** Bumped on every timeline change, so views can refresh their derived data. */
  get revision(): number {
    return this._revision;
  }

  private notify(keys: readonly LibraryStoreKey[]): void {
    this.changed.emit(keys);
  }

  private setTitle(title: Title): void {
    const titles = new Map(this._titles);
    titles.set(title.id, title);
    this._titles = titles;
  }

  async reload(): Promise<void> {
    const db = this.db;
    const [titles, progress, sessions, events, sites] = await Promise.all([
      attempt(() => db.allTitles(), []),
      attempt(() => db.allProgress(), []),
      attempt(() => db.sessions(600), []),
      attempt(() => db.events(300), []),
      attempt(() => db.allSites(), []),
    ]);
    const frames = await this.readFrames();
    this._titles = new Map(titles.map((t) => [t.id, t]));
    this._progress = progress;
    this._sessions = sessions;
    this._events = events;
    this._sites = sites;
    this._frames = frames;
    this._revision++;
    this.notify([
      "titles",
      "progress",
      "sessions",
      "events",
      "sites",
      "framesBySession",
      "momentsByTitle",
      "bestFrameByTitle",
      "revision",
    ]);
  }

  private async readFrames(): Promise<FrameIndex> {
    const frames: FrameIndex = { framesBySession: new Map(), momentsByTitle: new Map(), bestFrameByTitle: new Map() };
    for (const frame of await attempt(() => this.db.allFrames(), [])) index(frames, frame);
    return frames;
  }

  private async loadFrames(): Promise<void> {
    this._frames = await this.readFrames();
  }

  // MARK: Lists

  private list(status: TitleStatus): Title[] {
    return [...this._titles.values()].filter((t) => t.status === status);
  }

  get backlog(): Title[] {
    return latestFirst(this.list("backlog"), (t) => t.addedAt);
  }

  get watching(): Title[] {
    return latestFirst(this.list("watching"), (t) => t.lastWatchedAt ?? t.updatedAt);
  }

  get watched(): Title[] {
    return latestFirst(this.list("watched"), (t) => t.finishedAt ?? t.updatedAt);
  }

  count(status: TitleStatus): number {
    let n = 0;
    for (const t of this._titles.values()) if (t.status === status) n++;
    return n;
  }

  /** Latest place you stopped, per title in progress. */
  get continueWatching(): { title: Title; progress: WatchProgress }[] {
    const seen = new Set<number>();
    const out: { title: Title; progress: WatchProgress }[] = [];
    for (const p of this._progress) {
      if (seen.has(p.titleId)) continue;
      seen.add(p.titleId);
      const title = this._titles.get(p.titleId);
      if (!title || title.status !== "watching") continue;
      out.push({ title, progress: p });
    }
    return out;
  }

  latestProgress(titleId: number): WatchProgress | null {
    return this._progress.find((p) => p.titleId === titleId) ?? null;
  }

  progressList(titleId: number): WatchProgress[] {
    return this._progress.filter((p) => p.titleId === titleId);
  }

  /** Swift's `sessions(titleID:)`: all of one title's sessions, from the database, latest first. */
  sessionsForTitle(titleId: number): Promise<WatchSession[]> {
    return attempt(() => this.db.sessionsForTitle(titleId), []);
  }

  search(query: string, limit = 8): Title[] {
    const needle = LibraryText.normalize(query);
    if (needle.length === 0) return [];
    return [...this._titles.values()]
      .filter((t) => t.normName.includes(needle))
      .sort((a, b) => {
        const x = a.normName.startsWith(needle) ? 0 : 1;
        const y = b.normName.startsWith(needle) ? 0 : 1;
        return x !== y ? x - y : b.updatedAt - a.updatedAt;
      })
      .slice(0, limit);
  }

  // MARK: Titles

  /** Finds a title already in the library that matches, by name and, when known, year. */
  find(name: string, altName?: string | null, year?: number | null): Title | null {
    return findTitle(this._titles.values(), name, altName, year);
  }

  /** A new title, or the one already here with the same IMDb ID. Null when it can't be saved. */
  async addTitle(name: string, options: NewTitle = {}): Promise<Title | null> {
    const status = options.status ?? "none";
    const imdbId = options.imdbId ?? null;
    if (imdbId != null) {
      const existing = [...this._titles.values()].find((t) => t.imdbId === imdbId);
      if (existing) {
        if (status !== "none" && existing.status === "none") await this.setStatus(existing.id, status);
        return this._titles.get(existing.id) ?? null;
      }
    }
    const now = StoredDate.now();
    let title = Title.make({
      name,
      normName: LibraryText.normalize(name),
      year: options.year ?? null,
      kind: options.kind ?? "unknown",
      status,
      imdbId,
      posterUrl: options.posterUrl ?? null,
      backdropUrl: options.backdropUrl ?? null,
      overview: options.overview ?? null,
      addedAt: now,
      updatedAt: now,
    });
    const id = await attempt(() => this.db.insertTitle(title), null);
    if (id == null) return null;
    title = { ...title, id };
    this.setTitle(title);
    if (status === "backlog") {
      await attemptVoid(() => this.db.addEvent("addedToBacklog", id));
      await this.reloadEvents();
    }
    this.notify(["titles"]);
    return title;
  }

  /** Saves the title as given, stamped as updated now. */
  async update(title: Title): Promise<void> {
    const copy = { ...title, updatedAt: StoredDate.now() };
    this.setTitle(copy);
    await attemptVoid(() => this.db.updateTitle(copy));
    this.notify(["titles"]);
  }

  async setStatus(id: number, status: TitleStatus): Promise<void> {
    let title = this._titles.get(id);
    if (!title || title.status === status) return;
    const now = StoredDate.now();
    title = { ...title, status, updatedAt: now, statusAt: now };
    if (status === "watched") title = { ...title, finishedAt: now };
    this.setTitle(title);
    const saved = title;
    await attemptVoid(() => this.db.updateTitle(saved));
    this.onPersonalChange?.(title);
    const kinds: Record<TitleStatus, LibraryEventKind> = {
      backlog: "addedToBacklog",
      watched: "markedWatched",
      watching: "markedWatching",
      none: "removed",
    };
    await attemptVoid(() => this.db.addEvent(kinds[status], id));
    await this.reloadEvents();
    this.notify(["titles"]);
  }

  /** Out of ten in half steps (15 is 7.5), or null to clear it. */
  async setRating(id: number, halves: number | null): Promise<void> {
    let title = this._titles.get(id);
    if (!title) return;
    const value = halves == null ? null : Rating.clamp(halves);
    if (title.ratingHalves === value) return;
    const now = StoredDate.now();
    title = { ...title, ratingHalves: value, ratedAt: now, updatedAt: now };
    this.setTitle(title);
    const saved = title;
    await attemptVoid(() => this.db.updateTitle(saved));
    this.onPersonalChange?.(title);
    this.notify(["titles"]);
  }

  /** What the cloud backup remembers, applied without sending it straight back. */
  async restore(id: number, restored: Restored): Promise<void> {
    let title = this._titles.get(id);
    if (!title) return;
    let changed = false;
    if (restored.halves !== undefined && title.ratingHalves !== restored.halves) {
      title = {
        ...title,
        ratingHalves: restored.halves == null ? null : Rating.clamp(restored.halves),
        ratedAt: restored.ratedAt ?? null,
      };
      changed = true;
    }
    const status = restored.status;
    if (status != null && title.status !== status) {
      title = { ...title, status, statusAt: restored.statusAt ?? null };
      if (status === "watched" && title.finishedAt == null) {
        title = { ...title, finishedAt: restored.finishedAt ?? restored.statusAt ?? null };
      }
      changed = true;
    }
    if (!changed) return;
    this.setTitle(title);
    const saved = title;
    await attemptVoid(() => this.db.updateTitle(saved));
    this.notify(["titles"]);
  }

  /** Removes the title, its records and its frames. */
  async delete(id: number): Promise<void> {
    // The frames have to go first: the database forgets which files were this title's.
    await attemptVoid(() => this.frameFiles.removeTitle(id));
    await attemptVoid(() => this.db.deleteTitle(id));
    await this.reload();
  }

  /** A recognised title can turn out to be a film already in the library, under another name. */
  async merge(from: number, into: number): Promise<void> {
    if (from === into) return;
    await attemptVoid(() => this.db.mergeTitle(from, into));
    this.mergedInto.set(from, into);
    await this.reload();
  }

  /** Follows merges, so a session recording under an old ID keeps writing to the right title. */
  currentId(id: number): number | null {
    let current = id;
    const seen = new Set<number>();
    while (this.mergedInto.has(current) && !seen.has(current)) {
      seen.add(current);
      current = this.mergedInto.get(current)!;
    }
    return this._titles.has(current) ? current : null;
  }

  private async reloadEvents(): Promise<void> {
    this._events = await attempt(() => this.db.events(300), this._events);
    this._revision++;
    this.notify(["events", "revision"]);
  }

  // MARK: Watching

  async recordWatchStart(titleId: number): Promise<void> {
    let title = this._titles.get(titleId);
    if (!title) return;
    const now = StoredDate.now();
    title = { ...title, lastWatchedAt: now, updatedAt: now };
    if (title.status !== "watching") title = { ...title, status: "watching" };
    this.setTitle(title);
    const saved = title;
    await attemptVoid(() => this.db.updateTitle(saved));
    this.notify(["titles"]);
  }

  async saveProgress(p: WatchProgress): Promise<void> {
    this._progress = [p, ...this._progress.filter((x) => !(x.titleId === p.titleId && EpisodeRef.equals(x.ref, p.ref)))];
    let title = this._titles.get(p.titleId);
    if (title) {
      title = { ...title, lastWatchedAt: p.updatedAt };
      this.setTitle(title);
    }
    await attemptVoid(() => this.db.upsertProgress(p));
    if (title) {
      const saved = title;
      await attemptVoid(() => this.db.updateTitle(saved));
    }
    this.notify(["progress", "titles"]);
  }

  async clearProgress(titleId: number, ref: EpisodeRef): Promise<void> {
    await attemptVoid(() => this.db.clearProgress(titleId, ref));
    this._progress = await attempt(() => this.db.allProgress(), this._progress);
    this.notify(["progress"]);
  }

  /** Inserts a new session (ID 0) or updates one, and returns it with its ID. */
  async saveSession(s: WatchSession): Promise<WatchSession> {
    let copy = s;
    if (s.id === 0) {
      copy = { ...s, id: await attempt(() => this.db.insertSession(s), 0) };
    }
    const position = this._sessions.findIndex((x) => x.id === copy.id);
    this._sessions =
      position >= 0 ? this._sessions.map((x, i) => (i === position ? copy : x)) : [copy, ...this._sessions];
    this._revision++;
    if (s.id !== 0) await attemptVoid(() => this.db.updateSession(s));
    this.notify(["sessions", "revision"]);
    return copy;
  }

  async deleteSession(id: number): Promise<void> {
    // Frames go with their session. Moments someone chose to keep don't.
    for (const frame of this.frames(id).filter((f) => !f.isMoment)) await this.removeFrameFile(frame);
    await attemptVoid(() => this.db.deleteSession(id));
    this._sessions = this._sessions.filter((x) => x.id !== id);
    await this.loadFrames();
    this._revision++;
    this.notify(["sessions", ...FRAME_KEYS, "revision"]);
  }

  // MARK: Frames

  frames(sessionId: number): readonly FilmFrame[] {
    return this._frames.framesBySession.get(sessionId) ?? [];
  }

  moments(titleId: number): readonly FilmFrame[] {
    return this._frames.momentsByTitle.get(titleId) ?? [];
  }

  /** Swift's `bestFrameURL(titleID:)`, as the frame: read its image with `readFrame`. */
  bestFrame(titleId: number): FilmFrame | null {
    return this._frames.bestFrameByTitle.get(titleId) ?? null;
  }

  /** Swift's `frameURL`, as the image itself. */
  readFrame(frame: FilmFrame): Promise<FrameData | null> {
    return attempt(() => this.frameFiles.read(frame.file), null);
  }

  /** Records a frame whose image is already in `frameFiles` (or saves `data` there first). */
  async addFrame(frame: FilmFrame, data?: FrameData): Promise<FilmFrame | null> {
    if (data !== undefined) await attemptVoid(() => this.frameFiles.write(frame.file, data));
    const id = await attempt(() => this.db.insertFrame(frame), null);
    if (id == null) return null;
    const saved = { ...frame, id };
    const frames: FrameIndex = {
      framesBySession: new Map(this._frames.framesBySession),
      momentsByTitle: new Map(this._frames.momentsByTitle),
      bestFrameByTitle: new Map(this._frames.bestFrameByTitle),
    };
    index(frames, saved);
    this._frames = frames;
    this.notify(FRAME_KEYS);
    return saved;
  }

  private async removeFrameFile(frame: FilmFrame): Promise<void> {
    await attemptVoid(() => this.frameFiles.remove(frame.file));
    await attemptVoid(() => this.db.deleteFrame(frame.id));
  }

  async deleteFrame(frame: FilmFrame): Promise<void> {
    await this.removeFrameFile(frame);
    await this.loadFrames();
    this.notify(FRAME_KEYS);
  }

  async deleteAllFrames(): Promise<void> {
    await attemptVoid(() => this.frameFiles.removeAll());
    await attemptVoid(() => this.db.deleteAllFrames());
    await this.loadFrames();
    this.notify(FRAME_KEYS);
  }

  /** Bytes the frame images take. */
  async framesSize(): Promise<number> {
    const sizes = await attempt(() => this.frameFiles.sizes(), new Map<string, number>());
    let total = 0;
    for (const size of sizes.values()) total += size;
    return total;
  }

  /**
   * Keeps the frames from growing forever: past the limit, the oldest collected frames go, down
   * to 80% of it. Moments are never removed by this.
   */
  async pruneFrames(limit = 800 * 1024 * 1024): Promise<void> {
    const sizes = await attempt(() => this.frameFiles.sizes(), new Map<string, number>());
    let size = 0;
    for (const s of sizes.values()) size += s;
    if (size <= limit) return;
    const oldestFirst = (await attempt(() => this.db.allFrames(), []))
      .filter((f) => !f.isMoment)
      .sort((a, b) => a.at - b.at);
    const fileSize = (f: FilmFrame) => sizes.get(f.file) ?? 0;
    let over = oldestFirst.reduce((sum, f) => sum + fileSize(f), 0) - Math.trunc((limit * 8) / 10);
    let count = 0;
    for (const frame of oldestFirst) {
      if (over <= 0) break;
      over -= fileSize(frame);
      count++;
    }
    for (const frame of oldestFirst.slice(0, count)) await this.removeFrameFile(frame);
    await this.loadFrames();
    this.notify(FRAME_KEYS);
  }

  // MARK: Sites

  /** A site for this address, or the one already here for the same site. Null for addresses with no host. */
  async addSite(url: string, name?: string | null): Promise<Site | null> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const rawHost = parsed.hostname;
    if (!rawHost) return null;
    const host = rawHost.toLowerCase();
    const bare = host.startsWith("www.") ? host.slice(4) : host;
    const existing = this._sites.find((s) => DomainName.isSameSite(s.host, bare));
    if (existing) return existing;
    // Most sites keep an icon here. Good enough until the first visit finds a sharper one.
    const icon = Urls.parse(`${parsed.protocol.slice(0, -1) || "https"}://${rawHost}/favicon.ico`);
    const position = (this._sites.length === 0 ? -1 : Math.max(...this._sites.map((s) => s.position))) + 1;
    let site: Site = {
      id: 0,
      name: name ?? DomainName.displayName(bare),
      host: bare,
      homeUrl: url,
      searchTemplate: null,
      iconUrl: icon,
      position,
      addedAt: StoredDate.now(),
      lastUsedAt: null,
    };
    const id = await attempt(() => this.db.insertSite(site), null);
    if (id == null) return null;
    site = { ...site, id };
    this._sites = [...this._sites, site];
    this.notify(["sites"]);
    return site;
  }

  async updateSite(site: Site): Promise<void> {
    this._sites = this._sites.map((s) => (s.id === site.id ? site : s));
    await attemptVoid(() => this.db.updateSite(site));
    this.notify(["sites"]);
  }

  async removeSite(id: number): Promise<void> {
    this._sites = this._sites.filter((s) => s.id !== id);
    await attemptVoid(() => this.db.deleteSite(id));
    this.notify(["sites"]);
  }

  /**
   * Swift's `moveSite(from:to:)` with SwiftUI's move semantics: the sites at the `source` offsets
   * go before the site that was at `destination`.
   */
  async moveSite(source: Iterable<number>, destination: number): Promise<void> {
    const sites = [...this._sites];
    const offsets = [...new Set(source)].filter((i) => i >= 0 && i < sites.length).sort((a, b) => a - b);
    if (offsets.length > 0) {
      const moving = offsets.map((i) => sites[i]!);
      const insertAt = destination - offsets.filter((i) => i < destination).length;
      for (const i of [...offsets].reverse()) sites.splice(i, 1);
      sites.splice(Math.min(Math.max(insertAt, 0), sites.length), 0, ...moving);
    }
    this._sites = sites.map((s, position) => ({ ...s, position }));
    for (const site of this._sites) await attemptVoid(() => this.db.updateSite(site));
    this.notify(["sites"]);
  }

  /** Swift's `site(forHost:)`. */
  siteForHost(host: string | null | undefined): Site | null {
    if (host == null) return null;
    return this._sites.find((s) => DomainName.isSameSite(s.host, host)) ?? null;
  }

  // MARK: Sample data

  /** Seeds a useful first screen: free, legal sources that work with no account. */
  async seedDefaultSitesIfNeeded(): Promise<void> {
    if (this._sites.length > 0) return;
    const defaults: [string, string, string | null][] = [
      ["YouTube", "https://www.youtube.com", "https://www.youtube.com/results?search_query=%s"],
      ["Tubi", "https://tubitv.com", "https://tubitv.com/search/%s"],
      ["Internet Archive", "https://archive.org/details/movies", "https://archive.org/search?query=%s"],
      ["Pluto TV", "https://pluto.tv", "https://pluto.tv/search/details?query=%s"],
    ];
    for (const [name, url, template] of defaults) {
      const site = await this.addSite(url, name);
      if (site) await this.updateSite({ ...site, searchTemplate: template });
    }
  }
}
