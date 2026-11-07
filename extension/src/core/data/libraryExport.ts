// The apps' "Export library" JSON (Swift's LibraryExport in Cineon/UI/SettingsView.swift, the
// Windows LibraryExport in SettingsPage.cs), written byte for byte as the Mac writes it, and read
// back in. The apps only write it; reading it is the extension's, with the merge rules below.

import { StoredDate, type UnixTime } from "./dates";
import { isDatabaseError } from "./idb";
import { LibraryText } from "./libraryText";
import { findTitle, type LibraryStore } from "./libraryStore";
import { EpisodeRef, Rating, Title, TitleKind, TitleStatus, WatchSession } from "./models";
import { swiftPrettyJson } from "./swiftJson";

/** Swift's `LibraryExport.Payload.Item`. Absent optionals are left out of the JSON. */
export interface ExportItem {
  name: string;
  year?: number;
  kind: string;
  status: string;
  imdbID?: string;
  /** Out of ten, such as 7.5. */
  rating?: number;
  /** ISO 8601, whole seconds, UTC. */
  finishedAt?: string;
}

/** Swift's `LibraryExport.Payload.Session`. */
export interface ExportSession {
  title: string;
  season: number;
  episode: number;
  site: string;
  url?: string;
  startedAt: string;
  endedAt: string;
  watchedSeconds: number;
  /** Where it stopped: the session's end position. */
  stoppedAt: number;
  duration: number;
  finished: boolean;
}

/** Swift's `LibraryExport.Payload`. */
export interface ExportPayload {
  exportedAt: string;
  titles: ExportItem[];
  timeline: ExportSession[];
}

/** A title read from an export. */
export interface ImportedTitle {
  name: string;
  year: number | null;
  kind: TitleKind;
  status: TitleStatus;
  imdbId: string | null;
  rating: number | null;
  finishedAt: UnixTime | null;
}

/** A session read from an export. */
export interface ImportedSession {
  title: string;
  ref: EpisodeRef;
  site: string;
  url: string | null;
  startedAt: UnixTime;
  endedAt: UnixTime;
  watchedSeconds: number;
  stoppedAt: number;
  duration: number;
  finished: boolean;
}

export interface ImportedLibrary {
  exportedAt: UnixTime | null;
  titles: ImportedTitle[];
  timeline: ImportedSession[];
  /** Entries that couldn't be read and were left out. */
  skipped: number;
}

export interface ImportResult {
  titlesAdded: number;
  titlesUpdated: number;
  sessionsAdded: number;
  /** Sessions already in the library, or that couldn't be saved. */
  sessionsSkipped: number;
  /** Every title added or changed, as saved: hand them to the cloud backup if it should know. */
  titles: Title[];
}

/** Swift's `String <`: Unicode scalar order of the canonically composed text. */
function compareSwift(a: string, b: string): number {
  const x = Array.from(a.normalize("NFC"), (c) => c.codePointAt(0)!);
  const y = Array.from(b.normalize("NFC"), (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  }
  return x.length - y.length;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const string = (v: unknown): string | null => (typeof v === "string" ? v : null);
const date = (v: unknown): UnixTime | null => (typeof v === "string" ? StoredDate.parseIso8601(v) : null);

export const LibraryExport = {
  /** What the apps write, as an object. */
  payload(library: LibraryStore, now: UnixTime = StoredDate.now()): ExportPayload {
    const titles = [...library.titles.values()].sort((a, b) => compareSwift(a.name, b.name));
    return {
      exportedAt: StoredDate.iso8601(now),
      titles: titles.map((t) => {
        const item: ExportItem = { name: t.name, kind: t.kind, status: t.status };
        if (t.year != null) item.year = t.year;
        if (t.imdbId != null) item.imdbID = t.imdbId;
        const rating = Title.rating(t);
        if (rating != null) item.rating = rating;
        if (t.finishedAt != null) item.finishedAt = StoredDate.iso8601(t.finishedAt);
        return item;
      }),
      timeline: library.sessions.map((s) => {
        const session: ExportSession = {
          title: library.titles.get(s.titleId)?.name ?? "",
          season: s.ref.season,
          episode: s.ref.episode,
          site: s.host,
          startedAt: StoredDate.iso8601(s.startedAt),
          endedAt: StoredDate.iso8601(s.endedAt),
          watchedSeconds: s.watchedSeconds,
          stoppedAt: s.endPosition,
          duration: s.duration,
          finished: s.finished,
        };
        if (s.url != null) session.url = s.url;
        return session;
      }),
    };
  },

  /** The file's text, exactly as the Mac's JSONEncoder writes it. Save as "Cineon library.json". */
  make(library: LibraryStore, now?: UnixTime): string {
    return swiftPrettyJson(LibraryExport.payload(library, now));
  },

  /**
   * Reads an export. Forgiving where Swift's Decodable would refuse the whole file: entries that
   * can't be read are skipped and counted. Null when it isn't an export at all.
   */
  parse(text: string): ImportedLibrary | null {
    let root: unknown;
    try {
      root = JSON.parse(text);
    } catch {
      return null;
    }
    if (!isObject(root) || (!Array.isArray(root.titles) && !Array.isArray(root.timeline))) return null;
    let skipped = 0;
    const titles: ImportedTitle[] = [];
    for (const entry of Array.isArray(root.titles) ? root.titles : []) {
      const name = isObject(entry) ? string(entry.name) : null;
      if (!isObject(entry) || name == null || name.length === 0) {
        skipped++;
        continue;
      }
      const year = finite(entry.year);
      titles.push({
        name,
        year: year != null && Number.isInteger(year) ? year : null,
        kind: TitleKind.fromRaw(entry.kind) ?? "unknown",
        status: TitleStatus.fromRaw(entry.status) ?? "none",
        imdbId: string(entry.imdbID) || null,
        rating: finite(entry.rating),
        finishedAt: date(entry.finishedAt),
      });
    }
    const timeline: ImportedSession[] = [];
    for (const entry of Array.isArray(root.timeline) ? root.timeline : []) {
      const title = isObject(entry) ? string(entry.title) : null;
      const startedAt = isObject(entry) ? date(entry.startedAt) : null;
      if (!isObject(entry) || title == null || title.length === 0 || startedAt == null) {
        skipped++;
        continue;
      }
      timeline.push({
        title,
        ref: EpisodeRef.make(Math.trunc(finite(entry.season) ?? 0), Math.trunc(finite(entry.episode) ?? 0)),
        site: string(entry.site) ?? "",
        url: string(entry.url) || null,
        startedAt,
        endedAt: date(entry.endedAt) ?? startedAt,
        watchedSeconds: finite(entry.watchedSeconds) ?? 0,
        stoppedAt: finite(entry.stoppedAt) ?? 0,
        duration: finite(entry.duration) ?? 0,
        finished: entry.finished === true,
      });
    }
    return { exportedAt: date(root.exportedAt), titles, timeline, skipped };
  },

  /**
   * Merges an export into the library, never overwriting what's already here:
   * - A title is the one with the same IMDb ID, else the one `find` picks by name and year; when
   *   there's none it's added (with the export's list, rating and finish date, not yet looked up).
   * - On a title already here only what's missing is filled in: IMDb ID, year, kind, rating, list,
   *   finish date. A rating or list you already set stays.
   * - Sessions go to the title of that name (the first, when two share one), added when missing.
   *   A session already here for the same title and episode starting in the same second is skipped,
   *   so importing a file twice adds nothing. Where it started is taken as where it stopped less
   *   the time watched.
   * Then the store reloads.
   */
  async apply(library: LibraryStore, imported: ImportedLibrary): Promise<ImportResult> {
    const db = library.db;
    const now = StoredDate.now();
    const titles = new Map(library.titles);
    const touched = new Map<number, Title>();
    const result: ImportResult = { titlesAdded: 0, titlesUpdated: 0, sessionsAdded: 0, sessionsSkipped: 0, titles: [] };
    const byName = new Map<string, number>();

    const insert = async (title: Title): Promise<Title | null> => {
      try {
        const id = await db.insertTitle(title);
        const saved = { ...title, id };
        titles.set(id, saved);
        touched.set(id, saved);
        result.titlesAdded++;
        return saved;
      } catch (error) {
        if (isDatabaseError(error)) return null;
        throw error;
      }
    };

    const imdbTaken = (imdbId: string) => [...titles.values()].some((t) => t.imdbId === imdbId);

    for (const item of imported.titles) {
      let title =
        (item.imdbId != null ? [...titles.values()].find((t) => t.imdbId === item.imdbId) : undefined) ??
        findTitle(titles.values(), item.name, null, item.year);
      const halves = item.rating != null ? Rating.clamp(Math.round(item.rating * 2)) : null;
      if (title == null) {
        title = await insert(
          Title.make({
            name: item.name,
            normName: LibraryText.normalize(item.name),
            year: item.year,
            kind: item.kind,
            status: item.status,
            imdbId: item.imdbId,
            ratingHalves: halves,
            ratedAt: halves != null ? now : null,
            statusAt: item.status !== "none" ? now : null,
            finishedAt: item.finishedAt,
            addedAt: now,
            updatedAt: now,
          }),
        );
        if (title == null) continue;
      } else {
        let filled = title;
        if (filled.imdbId == null && item.imdbId != null && !imdbTaken(item.imdbId)) filled = { ...filled, imdbId: item.imdbId };
        if (filled.year == null && item.year != null) filled = { ...filled, year: item.year };
        if (filled.kind === "unknown" && item.kind !== "unknown") filled = { ...filled, kind: item.kind };
        if (filled.ratingHalves == null && halves != null) filled = { ...filled, ratingHalves: halves, ratedAt: now };
        if (filled.status === "none" && item.status !== "none") filled = { ...filled, status: item.status, statusAt: now };
        if (filled.finishedAt == null && item.finishedAt != null) filled = { ...filled, finishedAt: item.finishedAt };
        if (filled !== title) {
          filled = { ...filled, updatedAt: now };
          try {
            await db.updateTitle(filled);
            titles.set(filled.id, filled);
            if (!touched.has(filled.id)) result.titlesUpdated++;
            touched.set(filled.id, filled);
            title = filled;
          } catch (error) {
            if (!isDatabaseError(error)) throw error;
          }
        }
      }
      if (!byName.has(item.name)) byName.set(item.name, title.id);
    }

    const known = new Map<number, WatchSession[]>();
    const lastWatched = new Map<number, UnixTime>();
    for (const s of imported.timeline) {
      let id = byName.get(s.title) ?? findTitle(titles.values(), s.title)?.id ?? null;
      if (id == null) {
        const added = await insert(
          Title.make({ name: s.title, normName: LibraryText.normalize(s.title), addedAt: now, updatedAt: now }),
        );
        if (added == null) {
          result.sessionsSkipped++;
          continue;
        }
        id = added.id;
        byName.set(s.title, id);
      }
      let sessions = known.get(id);
      if (sessions === undefined) {
        sessions = await db.sessionsForTitle(id).catch(() => []);
        known.set(id, sessions);
      }
      const second = Math.floor(s.startedAt);
      if (sessions.some((x) => EpisodeRef.equals(x.ref, s.ref) && Math.floor(x.startedAt) === second)) {
        result.sessionsSkipped++;
        continue;
      }
      const session = WatchSession.make({
        titleId: id,
        ref: s.ref,
        url: s.url,
        host: s.site,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        watchedSeconds: s.watchedSeconds,
        startPosition: Math.max(0, s.stoppedAt - s.watchedSeconds),
        endPosition: s.stoppedAt,
        duration: s.duration,
        finished: s.finished,
      });
      try {
        const sessionId = await db.insertSession(session);
        sessions.push({ ...session, id: sessionId });
        result.sessionsAdded++;
        lastWatched.set(id, Math.max(lastWatched.get(id) ?? -Infinity, s.endedAt));
      } catch (error) {
        if (!isDatabaseError(error)) throw error;
        result.sessionsSkipped++;
      }
    }

    // So "Recently watched" puts what was watched last first.
    for (const [id, endedAt] of lastWatched) {
      const title = titles.get(id);
      if (title == null || (title.lastWatchedAt ?? -Infinity) >= endedAt) continue;
      const updated = { ...title, lastWatchedAt: endedAt };
      try {
        await db.updateTitle(updated);
        titles.set(id, updated);
        if (touched.has(id)) touched.set(id, updated);
      } catch (error) {
        if (!isDatabaseError(error)) throw error;
      }
    }

    await library.reload();
    result.titles = [...touched.values()];
    return result;
  },

  /** `parse` then `apply`. Null when the text isn't an export. */
  async importText(library: LibraryStore, text: string): Promise<ImportResult | null> {
    const imported = LibraryExport.parse(text);
    return imported == null ? null : LibraryExport.apply(library, imported);
  },
};
