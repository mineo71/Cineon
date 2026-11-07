// Port of BrowserImport.swift's `LibraryStore.applyImport`, `ImportResult` and the database
// helpers (`importHistory`, `hasSession`): writes what the review screen kept. Importing the same
// history twice adds nothing new, and never overwrites a real saved position with a page visit.

import {
  type Database,
  type EpisodeRef,
  type ImportResult as FileImportResult,
  LibraryText,
  type LibraryStore,
  StoredDate,
  Stores,
  Title,
  type TitleStatus,
  UrlKey,
  type WatchSession,
  WatchProgress,
  WatchSession as WatchSessionModel,
} from "../../core/data";
import { type BrowsedPage, DISTANT_PAST, type ImportSiteCandidate, type ImportTitleCandidate, type ImportVisit, ImportTitleCandidate as Candidate } from "./importAnalyzer";

export interface ImportSelection {
  readonly sites: readonly ImportSiteCandidate[];
  readonly titles: readonly { readonly candidate: ImportTitleCandidate; readonly status: TitleStatus }[];
  readonly pages: readonly BrowsedPage[];
}

export interface ImportResult {
  sites: number;
  titles: number;
  pages: number;
  newTitleIds: { id: number; altName: string | null }[];
}

/** "Imported 2 sites, 14 films and series, 3,210 pages." or "Nothing new to import." */
export function importSummary(result: Pick<ImportResult, "sites" | "titles" | "pages">, locale?: string): string {
  const parts: string[] = [];
  if (result.sites > 0) parts.push(`${result.sites} ${result.sites === 1 ? "site" : "sites"}`);
  if (result.titles > 0) parts.push(`${result.titles} ${result.titles === 1 ? "film or series" : "films and series"}`);
  if (result.pages > 0) parts.push(`${new Intl.NumberFormat(locale).format(result.pages)} pages`);
  return parts.length === 0 ? "Nothing new to import." : "Imported " + parts.join(", ") + ".";
}

/** What reading a Cineon library file did, in the same voice. */
export function fileImportSummary(result: FileImportResult): string {
  const parts: string[] = [];
  if (result.titlesAdded > 0) parts.push(`${result.titlesAdded} ${result.titlesAdded === 1 ? "film or series" : "films and series"}`);
  if (result.titlesUpdated > 0) parts.push(`${result.titlesUpdated} updated`);
  if (result.sessionsAdded > 0) parts.push(`${result.sessionsAdded} ${result.sessionsAdded === 1 ? "viewing" : "viewings"} on the timeline`);
  return parts.length === 0 ? "Nothing new to import." : "Imported " + parts.join(", ") + ".";
}

function sameRef(a: EpisodeRef, b: EpisodeRef): boolean {
  return a.season === b.season && a.episode === b.episode;
}

/**
 * Writes the selection: sites first, then titles with their visits as sessions and progress, then
 * pages for the command bar. Reloads the library at the end, which tells the other contexts.
 */
export async function applyImport(library: LibraryStore, selection: ImportSelection, now: number = StoredDate.now()): Promise<ImportResult> {
  const result: ImportResult = { sites: 0, titles: 0, pages: 0, newTitleIds: [] };
  const db = library.db;

  for (const candidate of selection.sites) {
    if (library.siteForHost(candidate.host) != null) continue;
    if ((await library.addSite(candidate.homeUrl)) != null) result.sites++;
  }

  for (const { candidate, status } of selection.titles) {
    try {
      let existing: Title | null = library.find(candidate.name, candidate.altName, candidate.year);
      if (existing == null) {
        // The catalogue may have renamed it since ("Дюна" is now "Dune"), so the page's
        // address is the better way to recognise something imported before.
        for (const visit of candidate.visits) {
          const known = await db.progress(UrlKey.make(visit.url));
          const title = known ? library.titles.get(known.titleId) : undefined;
          if (title) {
            existing = title;
            break;
          }
        }
      }
      let id: number;
      if (existing) {
        id = existing.id;
      } else {
        const last = Candidate.lastVisit(candidate);
        const date = last === DISTANT_PAST ? now : last;
        id = await db.insertTitle(
          Title.make({
            name: candidate.name,
            normName: LibraryText.normalize(candidate.name),
            year: candidate.year,
            kind: candidate.kind,
            status,
            addedAt: date,
            updatedAt: date,
            finishedAt: status === "watched" ? date : null,
            lastWatchedAt: status === "backlog" ? null : date,
            metadataChecked: false,
          }),
        );
        result.newTitleIds.push({ id, altName: candidate.altName });
        result.titles++;
      }
      const sessions = await db.sessionsForTitle(id);
      for (const visit of candidate.visits) await record(db, visit, id, status, sessions, now);
    } catch (error) {
      // One title that can't be written doesn't stop the rest (the Mac's is one transaction).
      console.warn("Cineon import: skipped", candidate.name, error);
    }
  }

  result.pages = await importHistory(db, selection.pages);
  await library.reload();
  return result;
}

async function record(db: Database, visit: ImportVisit, titleId: number, status: TitleStatus, sessions: WatchSession[], now: number): Promise<void> {
  // A backlog entry was never watched, so it has no place on the timeline.
  // Nor does a tab with no known date, which would sort oddly.
  if (
    status !== "backlog" &&
    visit.date !== DISTANT_PAST &&
    !sessions.some((s) => sameRef(s.ref, visit.ref) && s.startedAt === visit.date)
  ) {
    const session = WatchSessionModel.make({
      titleId,
      ref: visit.ref,
      url: visit.url,
      host: visit.host,
      startedAt: visit.date,
      endedAt: visit.date,
    });
    const id = await db.insertSession(session);
    sessions.push({ ...session, id });
  }
  if ((await db.progress(titleId, visit.ref)) == null) {
    await db.upsertProgress(
      WatchProgress.make({
        titleId,
        ref: visit.ref,
        urlKey: UrlKey.make(visit.url),
        url: visit.url,
        host: visit.host,
        position: 0,
        duration: 0,
        finished: false,
        updatedAt: visit.date === DISTANT_PAST ? now : visit.date,
      }),
    );
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function requestDone<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * `Database.importHistory` for many pages: rows in the apps' shape (`url, host, title, visited_at`),
 * skipping any already there for the same address and second. Returns how many were added.
 */
export async function importHistory(db: Database, pages: readonly BrowsedPage[]): Promise<number> {
  if (pages.length === 0) return 0;
  const store = Stores.history;
  const existing = new Set<string>();
  {
    const tx = db.idb.transaction(store, "readonly");
    const rows = await requestDone(tx.objectStore(store).getAll() as IDBRequest<{ url: string; visited_at: number }[]>);
    for (const row of rows) existing.add(`${row.visited_at}|${row.url}`);
  }
  const fresh: { url: string; host: string; title: string; visited_at: number }[] = [];
  for (const page of pages) {
    const key = `${page.lastVisit}|${page.url}`;
    if (existing.has(key)) continue;
    existing.add(key);
    fresh.push({ url: page.url, host: hostOf(page.url), title: page.title, visited_at: page.lastVisit });
  }
  if (fresh.length === 0) return 0;
  await new Promise<void>((resolve, reject) => {
    const tx = db.idb.transaction(store, "readwrite");
    const objects = tx.objectStore(store);
    for (const row of fresh) objects.add(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return fresh.length;
}
