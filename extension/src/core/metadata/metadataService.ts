// Fills in posters and details for titles in the background. Port of MetadataService in
// Core/Metadata.swift (C#'s MetadataService.cs), over a small library interface so it doesn't depend
// on how the data layer stores titles.

import type { TitleKind } from "../parsing/data-copy/models";
import { normalize } from "../parsing/data-copy/libraryText";
import { MetadataClient, PagePreview } from "./metadataClient";
import type { EpisodeInfo, MetadataHit } from "./models";

/** The fields of a library title that metadata reads and writes. The data layer's `Title` has them all. */
export interface MetadataTitle {
  readonly id: number;
  name: string;
  normName: string;
  year: number | null;
  kind: TitleKind;
  imdbId: string | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  overview: string | null;
  genres: readonly string[];
  runtimeMinutes: number | null;
  metadataChecked: boolean;
}

/**
 * What `MetadataService` needs from the library (the Mac's `LibraryStore`). Reads are synchronous,
 * as in the apps, which keep titles in memory; writes may return a promise, which is awaited.
 */
export interface MetadataLibrary<T extends MetadataTitle = MetadataTitle> {
  /** The title with this id as it is now, or undefined when it's gone (deleted or merged away). */
  title(id: number): T | undefined;
  /** Every title, to find one already matched to the same IMDb id. */
  titles(): Iterable<T>;
  /** Saves a changed title. */
  update(title: T): unknown;
  /** Folds one title into another: its progress, history and ratings move, and it goes. */
  merge(fromId: number, intoId: number): unknown;
  /** The address of the most recent progress saved for a title: `latestProgress(titleID)?.url`. */
  latestProgressUrl(titleId: number): string | null | undefined;
}

export interface MetadataServiceOptions<T extends MetadataTitle> {
  library: MetadataLibrary<T>;
  /** The "look up posters and details" setting. */
  enabled: () => boolean;
  /** `MetadataClient.shared` when left out. */
  client?: MetadataClient;
  /** `PagePreview.shared` when left out. */
  preview?: PagePreview;
  /** The pause between lookups, so importing hundreds of films doesn't hammer the services. 120 ms. */
  pauseMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Fills in posters and details for titles in the background. Lookups run one at a time, so that
 * importing hundreds of films doesn't hammer the services; what you're watching goes first.
 */
export class MetadataService<T extends MetadataTitle = MetadataTitle> {
  /** Episode lists set by the test commands, by title, which win over the real services. */
  readonly testEpisodes = new Map<number, EpisodeInfo[]>();

  private readonly library: MetadataLibrary<T>;
  private readonly enabled: () => boolean;
  private readonly client: MetadataClient;
  private readonly preview: PagePreview;
  private readonly pauseMs: number;
  private readonly inFlight = new Set<number>();
  private readonly queue: { id: number; altName: string | null }[] = [];
  private readonly episodeCache = new Map<string, EpisodeInfo[]>();
  private draining: Promise<void> | null = null;

  constructor(options: MetadataServiceOptions<T>) {
    this.library = options.library;
    this.enabled = options.enabled;
    this.client = options.client ?? MetadataClient.shared;
    this.preview = options.preview ?? PagePreview.shared;
    this.pauseMs = options.pauseMs ?? 120;
  }

  /** Settles when the queue is empty. For tests and for shutting down cleanly. */
  get idle(): Promise<void> {
    return this.draining ?? Promise.resolve();
  }

  /**
   * Looks up a title that was recognised from a page, unless it has been looked up already.
   * `altName` is the page's other name for it ("Dune" for "Дюна"), tried first.
   */
  enrich(titleId: number, altName: string | null = null, inBackground = false): void {
    if (!this.enabled() || this.inFlight.has(titleId) || this.library.title(titleId)?.metadataChecked !== false) return;
    this.inFlight.add(titleId);
    if (inBackground) this.queue.push({ id: titleId, altName });
    else this.queue.unshift({ id: titleId, altName });
    this.draining ??= this.drain();
  }

  private async drain(): Promise<void> {
    // Starts after the caller is done, like Swift's Task, so more can join the queue first.
    await Promise.resolve();
    try {
      for (let next = this.queue.shift(); next !== undefined; next = this.queue.shift()) {
        try {
          await this.lookUp(next.id, next.altName);
        } catch {
          // A failed lookup leaves the title as it was. The queue goes on.
        }
        this.inFlight.delete(next.id);
        await sleep(this.pauseMs);
      }
    } finally {
      this.draining = null;
    }
  }

  private async lookUp(titleId: number, altName: string | null): Promise<void> {
    const title = this.library.title(titleId);
    if (!title || title.metadataChecked) return;
    let match: MetadataHit | null = null;
    for (const query of [altName, title.name]) {
      if (query == null) continue;
      const hits = await this.client.search(query);
      const found = MetadataClient.bestMatch(hits, query, title.year, title.kind);
      if (found !== null) {
        match = found;
        break;
      }
    }
    await this.applyMatch(match, titleId);
    if (match === null) await this.fillFromPage(titleId);
  }

  /** Not in the catalogue, so ask the page it was watched on. */
  private async fillFromPage(titleId: number): Promise<void> {
    const title = this.library.title(titleId);
    if (!title || title.posterUrl !== null) return;
    const url = this.library.latestProgressUrl(titleId);
    if (!url) return;
    const preview = await this.preview.fetch(url);
    const fresh = this.library.title(titleId);
    if (!fresh || (preview.poster === null && preview.overview === null)) return;
    await this.library.update({
      ...fresh,
      posterUrl: preview.poster ?? fresh.posterUrl,
      overview: fresh.overview ?? preview.overview,
    });
  }

  /** Applies an explicit choice, when someone corrects a title by hand. Swift's `apply(hit:to:)`. */
  async apply(hit: MetadataHit, titleId: number): Promise<void> {
    const title = this.library.title(titleId);
    if (!title) return;
    await this.library.update({ ...title, metadataChecked: false });
    await Promise.resolve();
    await this.applyMatch(hit, titleId);
  }

  private async applyMatch(match: MetadataHit | null, titleId: number): Promise<void> {
    const title = this.library.title(titleId);
    if (!title) return;
    if (match === null) {
      await this.library.update({ ...title, metadataChecked: true });
      return;
    }

    // The same film may already be here under another name, say the Ukrainian one.
    for (const other of this.library.titles()) {
      if (other.imdbId === match.id && other.id !== titleId) {
        await this.library.merge(titleId, other.id);
        return;
      }
    }

    const detail = await this.client.detail(match.id, match.kind);
    const fresh = this.library.title(titleId);
    if (!fresh) return;
    const genres = detail?.genres ?? fresh.genres;
    await this.library.update({
      ...fresh,
      metadataChecked: true,
      imdbId: match.id,
      name: match.name,
      normName: normalize(match.name),
      year: match.year ?? fresh.year,
      posterUrl: match.posterUrl ?? detail?.posterUrl ?? fresh.posterUrl,
      backdropUrl: detail?.backdropUrl ?? fresh.backdropUrl,
      overview: detail?.overview ?? fresh.overview,
      genres,
      runtimeMinutes: detail?.runtimeMinutes ?? fresh.runtimeMinutes,
      kind: genres.includes("Animation") ? "cartoon" : match.kind,
    });
    if (detail !== null && detail.episodes.length > 0) this.episodeCache.set(match.id, detail.episodes);
  }

  /** A series' episodes. `fresh` skips the copy kept from earlier, to see episodes that came out since. */
  async episodes(title: Pick<MetadataTitle, "id" | "imdbId" | "kind">, fresh = false): Promise<EpisodeInfo[]> {
    const test = this.testEpisodes.get(title.id);
    if (test !== undefined) return test;
    const imdbId = title.imdbId;
    if (!this.enabled() || imdbId === null) return [];
    if (!fresh) {
      const cached = this.episodeCache.get(imdbId);
      if (cached !== undefined) return cached;
    }
    if (title.kind !== "series" && title.kind !== "cartoon") return [];
    const detail = await this.client.detail(imdbId, "series");
    const episodes = detail?.episodes ?? [];
    this.episodeCache.set(imdbId, episodes);
    return episodes;
  }
}
