// Port of windows/Cineon.Core/Downloads/SeasonGrabber.cs (Cineon/Downloads/SeasonGrabber.swift).
//
// Downloads a season, or every season of a series. A helper tab nobody looks at opens each episode
// in turn, waits for its player to ask for the file, and hands that to the download queue. Each link
// is fetched just before its turn, because streaming sites' links expire while they wait. The job is
// saved as it goes (`download-job.json`, in the Mac's shape, kept in chrome.storage), so one that's
// still running when the browser closes can carry on next time.

import { Emitter, EpisodeRef, type KeyValueStorage, type MediaSource, type Title, Urls } from "../data";
import { DownloadCenter } from "./downloadCenter";
import { sleep } from "./hlsDownloader";
import { DownloadText } from "./text";
import {
  type DownloadHost,
  type DownloadTab,
  type EpisodeHelperTab,
  type EpisodeResolver,
  type PublishedEpisode,
} from "./types";

export type SeasonScope = "season" | "series";

/** A season or series being fetched. Saved as `download-job.json`, in the Mac's shape. */
export interface SeasonJob {
  readonly scope: SeasonScope;
  readonly titleId: number | null;
  readonly name: string;
  readonly season: number;
  readonly episodes: readonly EpisodeRef[];
  readonly queued: readonly EpisodeRef[];
  readonly missed: readonly EpisodeRef[];
  readonly current: EpisodeRef | null;
  readonly pageUrl: string;
  readonly startRef: EpisodeRef;
  readonly posterUrl: string | null;
  readonly usesPageList: boolean;
  readonly isFinished: boolean;
  /** Stopped when the browser closed, and waiting to carry on. */
  readonly isPaused: boolean;
}

const has = (list: readonly EpisodeRef[], ref: EpisodeRef) => list.some((r) => EpisodeRef.equals(r, ref));

export const SeasonJob = {
  make(fields: Partial<SeasonJob> & Pick<SeasonJob, "scope" | "name" | "pageUrl" | "startRef">): SeasonJob {
    return {
      titleId: null,
      season: 0,
      episodes: [],
      queued: [],
      missed: [],
      current: null,
      posterUrl: null,
      usesPageList: false,
      isFinished: false,
      isPaused: false,
      ...fields,
    };
  },

  seasons(job: SeasonJob): number[] {
    return [...new Set(job.episodes.map((e) => e.season))].sort((a, b) => a - b);
  },

  label(job: SeasonJob): string {
    if (job.scope === "season") return job.season > 0 ? `${job.name}, season ${job.season}` : job.name;
    const seasons = SeasonJob.seasons(job);
    return seasons.length === 1 ? `${job.name}, season ${seasons[0]}` : `${job.name}, all ${seasons.length} seasons`;
  },

  handled(job: SeasonJob): number {
    return job.queued.length + job.missed.length;
  },

  /** What's left to look for, in order. */
  remaining(job: SeasonJob): EpisodeRef[] {
    return job.episodes.filter((e) => !has(job.queued, e) && !has(job.missed, e));
  },

  /** JSON as Swift's JSONEncoder writes the Codable struct (keys in order, nils left out, `/` plain). */
  encode(job: SeasonJob): string {
    const ref = (r: EpisodeRef) => ({ season: r.season, episode: r.episode });
    const out: Record<string, unknown> = { scope: job.scope };
    if (job.titleId != null) out.titleID = job.titleId;
    out.name = job.name;
    out.season = job.season;
    out.episodes = job.episodes.map(ref);
    out.queued = job.queued.map(ref);
    out.missed = job.missed.map(ref);
    if (job.current != null) out.current = ref(job.current);
    out.pageURL = job.pageUrl;
    out.startRef = ref(job.startRef);
    if (job.posterUrl != null) out.posterURL = job.posterUrl;
    out.usesPageList = job.usesPageList;
    out.isFinished = job.isFinished;
    out.isPaused = job.isPaused;
    return JSON.stringify(out);
  },

  /** A job written by any of the apps or this extension, or null if it isn't one. */
  decode(json: string | Uint8Array): SeasonJob | null {
    let root: unknown;
    try {
      root = JSON.parse(typeof json === "string" ? json : new TextDecoder().decode(json));
    } catch {
      return null;
    }
    if (root == null || typeof root !== "object" || Array.isArray(root)) return null;
    const o = root as Record<string, unknown>;
    const scope = o.scope === "season" || o.scope === "series" ? o.scope : null;
    const name = typeof o.name === "string" ? o.name : null;
    const season = int32(o.season);
    const episodes = refs(o.episodes);
    const pageUrl = Urls.parse(typeof o.pageURL === "string" ? o.pageURL : null);
    const startRef = readRef(o.startRef);
    const usesPageList = typeof o.usesPageList === "boolean" ? o.usesPageList : null;
    if (scope == null || name == null || season == null || episodes == null || pageUrl == null || startRef == null || usesPageList == null) {
      return null;
    }
    return {
      scope,
      titleId: typeof o.titleID === "number" && Number.isSafeInteger(o.titleID) ? o.titleID : null,
      name,
      season,
      episodes,
      queued: refs(o.queued) ?? [],
      missed: refs(o.missed) ?? [],
      current: readRef(o.current),
      pageUrl,
      startRef,
      posterUrl: Urls.parse(typeof o.posterURL === "string" ? o.posterURL : null),
      usesPageList,
      isFinished: typeof o.isFinished === "boolean" ? o.isFinished : false,
      isPaused: typeof o.isPaused === "boolean" ? o.isPaused : false,
    };
  },
};

function int32(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647 ? value : null;
}

function readRef(value: unknown): EpisodeRef | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const season = int32(o.season);
  const episode = int32(o.episode);
  return season != null && episode != null ? EpisodeRef.make(season, episode) : null;
}

function refs(value: unknown): EpisodeRef[] | null {
  if (!Array.isArray(value)) return null;
  const out: EpisodeRef[] = [];
  for (const item of value) {
    const ref = readRef(item);
    if (ref == null) return null;
    out.push(ref);
  }
  return out;
}

/** A whole series, found and waiting for a yes, because it can be very big. */
export interface SeasonProposal {
  readonly job: SeasonJob;
  readonly bytesPerEpisode: number;
  /** From episodes downloaded before, rather than a round guess. */
  readonly isMeasured: boolean;
  /**
   * The room the browser gives the extension (`navigator.storage.estimate()`: quota − usage), or
   * null. The downloads folder itself can't be measured from an extension; show
   * DownloadText.freeSpaceNote beside it.
   */
  readonly freeBytes: number | null;
}

export const SeasonProposal = {
  totalBytes(p: SeasonProposal): number {
    return p.bytesPerEpisode * p.job.episodes.length;
  },

  fits(p: SeasonProposal): boolean {
    return p.freeBytes == null || SeasonProposal.totalBytes(p) < p.freeBytes;
  },

  seasonCounts(p: SeasonProposal): { season: number; count: number }[] {
    const counts = new Map<number, number>();
    for (const e of p.job.episodes) counts.set(e.season, (counts.get(e.season) ?? 0) + 1);
    return [...counts].map(([season, count]) => ({ season, count })).sort((a, b) => a.season - b.season);
  },
};

export interface SeasonGrabberOptions {
  downloads: DownloadCenter;
  host: DownloadHost;
  resolver: EpisodeResolver;
  /** Per-profile storage (chrome.storage.local) for the job. */
  storage: KeyValueStorage;
  /** Where in `storage`; by default `<database name>/download-job.json`. Holds the JSON text, or null. */
  storageKey?: string;
  /** `navigator.storage.estimate` by default. */
  estimate?: () => Promise<{ quota?: number; usage?: number }>;
}

/** Downloads a season, or every season of a series, one episode at a time through a helper tab. */
export class SeasonGrabber {
  /** How long one episode's player gets to ask for its file, in seconds. */
  static readonly episodeTimeout = 45;
  /** A guess for an episode's size when nothing has been downloaded yet to go by. */
  static readonly guessedBytesPerEpisode = 1_000_000_000;
  static readonly jobFileName = "download-job.json";

  readonly changed = new Emitter<void>();

  // Waits in milliseconds, shortened by tests.
  pollInterval = 500;
  slotInterval = 1500;
  nudgeInterval = 4000;
  firstLoadTimeout = 20_000;
  episodeWait = SeasonGrabber.episodeTimeout * 1000;

  private _job: SeasonJob | null = null;
  private _proposal: SeasonProposal | null = null;
  private _isLooking = false;
  private helper: EpisodeHelperTab | null = null;
  private runner: AbortController | null = null;
  private used = new Set<string>();
  private readonly work = new Set<Promise<void>>();
  private persisting: Promise<unknown> = Promise.resolve();
  private readonly storageKey: string;

  private constructor(private readonly options: SeasonGrabberOptions) {
    this.storageKey = options.storageKey ?? `${options.downloads.databaseName}/${SeasonGrabber.jobFileName}`;
  }

  /** Reads a job left by a closed browser (or written by the Mac or Windows app) and offers to carry on. */
  static async open(options: SeasonGrabberOptions): Promise<SeasonGrabber> {
    const grabber = new SeasonGrabber(options);
    await grabber.restore();
    return grabber;
  }

  /** The Mac's `job`: the season or series being fetched, or the last one, until dismissed. */
  get job(): SeasonJob | null {
    return this._job;
  }

  /** The Mac's `proposal`. */
  get proposal(): SeasonProposal | null {
    return this._proposal;
  }

  /** Finding a whole series' seasons and episodes, before asking. */
  get isLooking(): boolean {
    return this._isLooking;
  }

  get isRunning(): boolean {
    return this._job != null && !this._job.isFinished && !this._job.isPaused;
  }

  get isBusy(): boolean {
    return this.isRunning || this._isLooking;
  }

  // MARK: Starting

  /** Starts from the series in this tab. `fromCurrent` leaves out the episodes before the one on screen. */
  start(tab: DownloadTab, fromCurrent: boolean): Promise<void> {
    if (!this.mayStart(tab)) return Promise.resolve();
    const runner = this.newRunner();
    return this.spawn(async () => {
      const prepared = await this.prepare(tab);
      if (prepared == null || runner.signal.aborted) return;
      const { pageUrl, current, title, name } = prepared;
      const { episodes, onPage } = await this.episodeList(current.season, title, tab, pageUrl, current, runner.signal);
      if (runner.signal.aborted) return;
      let list = fromCurrent ? episodes.filter((e) => DownloadCenter.compare(e, current) >= 0) : [...episodes];
      // What's already on this computer, or on its way, isn't fetched twice.
      const have = this.have(title?.id ?? null, name);
      list = list.filter((e) => !has(have, e));
      if (episodes.length === 0) {
        this.toast(DownloadText.noSeasonEpisodes);
        return;
      }
      if (list.length === 0) {
        this.toast(DownloadText.seasonAlreadyHere);
        return;
      }
      this.launch(
        SeasonJob.make({
          scope: "season",
          titleId: title?.id ?? null,
          name,
          season: current.season,
          episodes: list,
          pageUrl,
          startRef: current,
          posterUrl: title?.posterUrl ?? tab.parsed?.posterUrl ?? null,
          usesPageList: onPage,
        }),
      );
    });
  }

  /** Finds every season of the series in this tab and asks before getting them. */
  startSeries(tab: DownloadTab): Promise<void> {
    if (!this.mayStart(tab)) return Promise.resolve();
    this._isLooking = true;
    this.raiseChanged();
    const runner = this.newRunner();
    return this.spawn(async () => {
      try {
        const prepared = await this.prepare(tab);
        if (prepared == null || runner.signal.aborted) return;
        const { pageUrl, current, title, name } = prepared;
        this.toast(DownloadText.lookingForEvery(name));
        const seasons = await this.seasonList(title, tab, pageUrl, current, runner.signal);
        const episodes: EpisodeRef[] = [];
        let onPage = false;
        for (const season of seasons) {
          if (runner.signal.aborted) return;
          const found = await this.episodeList(season, title, tab, pageUrl, current, runner.signal);
          episodes.push(...found.episodes);
          onPage ||= found.onPage;
        }
        if (runner.signal.aborted) return;
        const have = this.have(title?.id ?? null, name);
        const wanted = episodes.filter((e) => !has(have, e));
        if (episodes.length === 0) {
          this.toast(DownloadText.noSeriesEpisodes(name));
          return;
        }
        if (wanted.length === 0) {
          this.toast(DownloadText.seriesAlreadyHere(name));
          return;
        }
        const job = SeasonJob.make({
          scope: "series",
          titleId: title?.id ?? null,
          name,
          season: current.season,
          episodes: wanted,
          pageUrl,
          startRef: current,
          posterUrl: title?.posterUrl ?? tab.parsed?.posterUrl ?? null,
          usesPageList: onPage,
        });
        const { bytes, measured } = this.bytesPerEpisode();
        this._proposal = { job, bytesPerEpisode: bytes, isMeasured: measured, freeBytes: await this.freeSpace() };
      } finally {
        this._isLooking = false;
        this.raiseChanged();
      }
    });
  }

  /** Yes to the whole series. */
  confirm(): void {
    const proposal = this._proposal;
    if (proposal == null) return;
    this._proposal = null;
    this.launch(proposal.job);
  }

  decline(): void {
    this._proposal = null;
    this.raiseChanged();
  }

  /** Carries on with a job that stopped when the browser closed. */
  resume(): Promise<void> {
    const paused = this._job;
    if (paused == null || !paused.isPaused || this.isBusy) return Promise.resolve();
    const have = this.have(paused.titleId, paused.name);
    // Episodes queued last time whose download stopped with the browser go round again, without
    // leaving their stopped copies behind in Downloads.
    for (const item of this.options.downloads.items) {
      if (
        item.status === "failed" &&
        has(paused.episodes, item.ref) &&
        (paused.titleId != null ? item.titleId === paused.titleId : item.name === paused.name)
      ) {
        void this.options.downloads.remove(item.id);
      }
    }
    const job: SeasonJob = { ...paused, queued: paused.queued.filter((e) => has(have, e)), missed: [], isPaused: false };
    this._job = job;
    this.persist();
    this.raiseChanged();
    this.toast(DownloadText.carryingOn(SeasonJob.label(job), SeasonJob.remaining(job).length));
    const runner = this.newRunner();
    return this.spawn(() => this.run(runner.signal));
  }

  cancel(): void {
    this._proposal = null;
    this.runner?.abort();
    this.runner = null;
    this.finish(true);
  }

  /** The profile is closing: stop now, and keep the job to carry on with next time. */
  suspend(): void {
    this._proposal = null;
    this.runner?.abort();
    this.runner = null;
    this.tearDown();
    const current = this._job;
    if (current == null || current.isFinished) return;
    this._job = { ...current, isPaused: true, current: null };
    this.persist();
    this.raiseChanged();
  }

  dismiss(): void {
    if (this._job?.isFinished !== true) return;
    this._job = null;
    this.persist();
    this.raiseChanged();
  }

  /** Waits until nothing is looking for episodes, running a job or saving it. For tests and for closing. */
  async idle(): Promise<void> {
    while (this.work.size > 0) await Promise.allSettled([...this.work]);
    await this.persisting;
  }

  /**
   * The room the browser gives the extension on this computer: `navigator.storage.estimate()`'s
   * quota − usage, or null. That's where streams wait before they're saved; the downloads folder
   * can't be measured from an extension.
   */
  static async freeSpace(estimate?: () => Promise<{ quota?: number; usage?: number }>): Promise<number | null> {
    const storage = (globalThis as { navigator?: { storage?: StorageManager } }).navigator?.storage;
    const read = estimate ?? (typeof storage?.estimate === "function" ? () => storage.estimate() : null);
    if (read == null) return null;
    try {
      const { quota, usage } = await read();
      if (quota == null || !Number.isFinite(quota)) return null;
      return Math.max(0, quota - (usage ?? 0));
    } catch {
      return null;
    }
  }

  /** "S1 E2", the Mac's `EpisodeRef.shortLabel`. */
  static shortLabel(ref: EpisodeRef): string {
    return `S${ref.season} E${ref.episode}`;
  }

  private freeSpace(): Promise<number | null> {
    return SeasonGrabber.freeSpace(this.options.estimate);
  }

  /** The checks the Mac makes before anything: one job at a time, and only from an episode. */
  private mayStart(tab: DownloadTab): boolean {
    if (this.isBusy) {
      this.toast(this._isLooking ? DownloadText.stillLooking : DownloadText.alreadyGetting(this._job ? SeasonJob.label(this._job) : "a season"));
      return false;
    }
    const current = tab.trackRef ?? tab.parsed?.ref ?? null;
    if (tab.url == null || current == null || !EpisodeRef.isEpisode(current)) {
      this.toast(DownloadText.openAnEpisode);
      return false;
    }
    return true;
  }

  private async prepare(tab: DownloadTab): Promise<{ pageUrl: string; current: EpisodeRef; title: Title | null; name: string } | null> {
    const current = tab.trackRef ?? tab.parsed?.ref ?? null;
    if (tab.url == null || current == null || !EpisodeRef.isEpisode(current)) return null;
    const title = await this.options.downloads.libraryTitle(tab);
    return { pageUrl: tab.url, current, title, name: title?.name ?? tab.parsed?.name ?? tab.displayTitle };
  }

  private launch(job: SeasonJob): void {
    this._job = job;
    this.persist();
    this.raiseChanged();
    this.toast(DownloadText.getting(job.episodes.length, SeasonJob.label(job)));
    const runner = this.newRunner();
    void this.spawn(() => this.run(runner.signal));
  }

  private newRunner(): AbortController {
    this.runner?.abort();
    this.runner = new AbortController();
    return this.runner;
  }

  /** Runs a step of the job, treating being stopped as the end of it. */
  private spawn(body: () => Promise<void>): Promise<void> {
    const task = body()
      .catch((error) => {
        if ((error as { name?: string })?.name !== "DownloadStoppedError") console.error(error);
      })
      .finally(() => this.work.delete(task));
    this.work.add(task);
    return task;
  }

  /** Episodes of this title already on this computer or on their way. */
  private have(titleId: number | null, name: string): EpisodeRef[] {
    return this.options.downloads.items
      .filter((i) => i.status !== "failed" && (titleId != null ? i.titleId === titleId : i.name === name))
      .map((i) => i.ref);
  }

  /** How big an episode is likely to be: the average of the episodes downloaded before, or a gigabyte. */
  private bytesPerEpisode(): { bytes: number; measured: boolean } {
    const sizes = this.options.downloads.items
      .filter((i) => i.status === "done" && EpisodeRef.isEpisode(i.ref) && i.totalBytes > 0)
      .map((i) => i.totalBytes);
    if (sizes.length === 0) return { bytes: SeasonGrabber.guessedBytesPerEpisode, measured: false };
    return { bytes: Math.trunc(sizes.reduce((a, b) => a + b, 0) / sizes.length), measured: true };
  }

  // MARK: Finding the episodes

  /** Every season of the series: from the page's own list, the published episode list, or by trying each season's first episode. */
  private async seasonList(title: Title | null, tab: DownloadTab, pageUrl: string, current: EpisodeRef, signal: AbortSignal): Promise<number[]> {
    const seasons = new Set<number>([current.season]);
    for (const n of SeasonGrabber.numbers(await tab.callPage("seasonsOnPage")) ?? []) if (n > 0) seasons.add(n);
    if (seasons.size === 1 && title != null) {
      const now = Date.now() / 1000;
      for (const e of await this.published(title, signal)) {
        if (e.season > 0 && (e.released ?? -Infinity) <= now) seasons.add(e.season);
      }
    }
    if (seasons.size === 1) {
      for (let season = 1; season <= 30; season++) {
        if (season === current.season) continue;
        if (signal.aborted) break;
        const url = this.options.resolver.episodeUrl(pageUrl, current, EpisodeRef.make(season, 1));
        if (url == null) break;
        if (await this.options.resolver.isAlive(url, signal)) seasons.add(season);
        else if (season > current.season) break;
      }
    }
    return [...seasons].sort((a, b) => a - b);
  }

  /** The season's episodes: from the page's own list, the published list, or by trying addresses. */
  private async episodeList(
    season: number,
    title: Title | null,
    tab: DownloadTab,
    pageUrl: string,
    current: EpisodeRef,
    signal: AbortSignal,
  ): Promise<{ episodes: EpisodeRef[]; onPage: boolean }> {
    const numbers = SeasonGrabber.numbers(await tab.callPage("episodesOnPage", season));
    if (numbers != null && numbers.length > 0) {
      return { episodes: numbers.map((n) => EpisodeRef.make(season, n)), onPage: true };
    }
    const { resolver } = this.options;
    if (title != null) {
      const now = Date.now() / 1000;
      const aired = (await this.published(title, signal))
        .filter((e) => e.season === season && e.episode > 0 && (e.released ?? -Infinity) <= now)
        .map((e) => EpisodeRef.make(e.season, e.episode))
        .sort((a, b) => a.episode - b.episode);
      if (aired.length > 0 && resolver.episodeUrl(pageUrl, current, aired[0]!) != null) return { episodes: aired, onPage: false };
    }
    // Nothing published: walk the addresses until one is missing. In the season on screen the walk
    // goes at least as far as the episode playing.
    const floor = season === current.season ? current.episode : 0;
    const found: EpisodeRef[] = [];
    for (let number = 1; number <= 60; number++) {
      if (signal.aborted) break;
      const episode = EpisodeRef.make(season, number);
      if (EpisodeRef.equals(episode, current)) {
        found.push(episode);
        continue;
      }
      const url = resolver.episodeUrl(pageUrl, current, episode);
      if (url == null) return { episodes: [], onPage: false };
      if (await resolver.isAlive(url, signal)) found.push(episode);
      else if (number > floor) break;
    }
    return { episodes: found, onPage: false };
  }

  private async published(title: Title, signal: AbortSignal): Promise<readonly PublishedEpisode[]> {
    try {
      return await this.options.resolver.publishedEpisodes(title, signal);
    } catch {
      return [];
    }
  }

  /** A page's answer as whole numbers, like Swift's `as? [NSNumber]`: null unless it's an array of numbers. */
  static numbers(value: unknown): number[] | null {
    if (!Array.isArray(value)) return null;
    const numbers: number[] = [];
    for (const item of value) {
      if (typeof item !== "number" || !Number.isFinite(item)) return null;
      numbers.push(Math.trunc(item));
    }
    return numbers;
  }

  // MARK: Running

  private async run(signal: AbortSignal): Promise<void> {
    const job = this._job;
    if (job == null) return;
    const tab = await this.options.resolver.makeHelperTab();
    if (signal.aborted) {
      tab.close();
      return;
    }
    this.helper = tab;
    this.used = new Set();
    tab.load(job.pageUrl);
    await this.waitForSource(tab, new Set(), this.firstLoadTimeout, signal);

    for (const episode of SeasonJob.remaining(job)) {
      // Links expire, so each one is fetched only when there's room to start it.
      // Stopped first, always: a closed profile mustn't be touched again.
      for (;;) {
        if (signal.aborted) return;
        if (this.options.downloads.hasFreeSlot) break;
        await sleep(this.slotInterval, signal).catch(() => {});
      }
      if (this._job != null) {
        this._job = { ...this._job, current: episode };
        this.persist();
        this.raiseChanged();
      }
      const found = await this.resolve(episode, tab, signal);
      if (signal.aborted) return;
      const running = this._job;
      if (found != null && running != null) {
        this.used.add(found.url);
        const subtitles = tab.sources
          .filter((s) => s.kind === "subtitle" && s.isCurrent)
          .slice(0, 6)
          .map((s) => s.url);
        await this.options.downloads.enqueue({
          source: found,
          titleId: running.titleId,
          ref: episode,
          name: running.name,
          pageUrl: this.options.resolver.episodeUrl(running.pageUrl, running.startRef, episode) ?? running.pageUrl,
          referer: tab.sourcesFrameUrl ?? running.pageUrl,
          duration: tab.mediaDuration,
          posterUrl: running.posterUrl,
          subtitles,
        });
        if (this._job != null) this._job = { ...this._job, queued: [...this._job.queued, episode] };
      } else if (running != null) {
        this._job = { ...running, missed: [...running.missed, episode] };
      }
      this.persist();
      this.raiseChanged();
      tab.pausePlayback();
    }
    this.finish(false);
  }

  /** Opens one episode in the helper tab and waits for the file its player asks for. */
  private async resolve(episode: EpisodeRef, tab: EpisodeHelperTab, signal: AbortSignal): Promise<MediaSource | null> {
    const job = this._job;
    if (job == null) return null;
    // The page opened on this episode, so what it loaded is already it.
    const best = tab.bestSource;
    if (EpisodeRef.equals(episode, job.startRef) && best != null && best.kind !== "subtitle" && !this.used.has(best.url)) {
      return best;
    }
    const stale = new Set([...tab.sources.map((s) => s.url), ...this.used]);
    if (job.usesPageList && (await tab.callPage("openEpisode", episode.season, episode.episode, false)) === true) {
      const found = await this.waitForSource(tab, stale, this.episodeWait, signal);
      if (found != null) return found;
      if (signal.aborted) return null;
      // The page's list didn't switch it, which can happen in another season: try its address.
    }
    const url = this.options.resolver.episodeUrl(job.pageUrl, job.startRef, episode);
    if (url == null) return null;
    const onlyFragment = tab.currentUrl != null && withoutFragment(tab.currentUrl) === withoutFragment(url);
    tab.load(url);
    if (onlyFragment) tab.reload();
    return this.waitForSource(tab, new Set(this.used), this.episodeWait, signal);
  }

  private async waitForSource(tab: EpisodeHelperTab, stale: ReadonlySet<string>, timeout: number, signal: AbortSignal): Promise<MediaSource | null> {
    const deadline = Date.now() + timeout;
    let nudged = -Infinity;
    while (Date.now() < deadline) {
      if (signal.aborted) return null;
      const best = tab.bestSource;
      if (best != null && best.kind !== "subtitle" && best.isCurrent && !stale.has(best.url)) return best;
      // Many players only fetch their file once they play.
      if (Date.now() - nudged > this.nudgeInterval) {
        nudged = Date.now();
        await tab.callPage("playQuietly");
      }
      try {
        await sleep(this.pollInterval, signal);
      } catch {
        return null;
      }
    }
    return null;
  }

  private finish(cancelled: boolean): void {
    this.tearDown();
    const job = this._job;
    if (job == null || job.isFinished) return;
    const done: SeasonJob = { ...job, isFinished: true, isPaused: false, current: null };
    this._job = done;
    this.persist();
    this.raiseChanged();
    const label = SeasonJob.label(done);
    if (cancelled) {
      this.toast(DownloadText.stoppedGetting(label));
    } else if (done.missed.length === 0) {
      this.toast(DownloadText.allDownloading(done.queued.length, label));
    } else {
      this.toast(DownloadText.someMissed(done.queued.length, done.episodes.length, done.missed.map(SeasonGrabber.shortLabel).join(", ")));
    }
  }

  private tearDown(): void {
    this.helper?.close();
    this.helper = null;
  }

  // MARK: Keeping the job

  /** Written after every step, so a job is never lost to the browser closing. A finished one is forgotten. */
  private persist(): void {
    const job = this._job;
    const value = job == null || job.isFinished ? null : SeasonJob.encode(job);
    this.persisting = this.persisting.then(() => this.options.storage.set(this.storageKey, value).catch(() => {}));
  }

  private async restore(): Promise<void> {
    const stored = await this.options.storage.get(this.storageKey).catch(() => null);
    if (typeof stored !== "string") return;
    const saved = SeasonJob.decode(stored);
    if (saved == null || saved.isFinished) return;
    const job: SeasonJob = { ...saved, isPaused: true, current: null };
    this._job = job;
    this.toast(DownloadText.jobStoppedWhenClosed(SeasonJob.label(job)), DownloadText.carryOn, () => {
      void this.resume();
    });
  }

  private toast(message: string, actionTitle?: string, action?: () => void): void {
    this.options.host.showToast(message, actionTitle, action);
  }

  private raiseChanged(): void {
    this.changed.emit();
  }
}

function withoutFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash < 0 ? url : url.slice(0, hash);
}
