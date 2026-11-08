// Port of windows/Cineon.Core/Downloads/DownloadCenter.cs (Cineon/Downloads/DownloadCenter.swift).
//
// Saves films and episodes to this computer, from the files their players stream. What people do by
// digging the link out of the Network tab, done with one click.
//
// Whole files go through the browser's own downloads (chrome.downloads), which send the browser's
// cookies and name; the page's Referer and Origin are added by a declarativeNetRequest rule for as
// long as the download needs them. Stopping pauses the browser's download and Try again resumes it
// (the browser asks for the rest with a Range request). Streams go through a StreamWorker (an
// offscreen document in Chrome, the background page in Firefox) that writes the segments to OPFS,
// joins them, and hands the file to chrome.downloads. Everything lands in `Cineon/` inside the
// browser's downloads folder, under the apps' names.
//
// Like the Mac's main-actor class, reading is synchronous from memory; changes to memory are
// synchronous too and reach the database in the background. `changed` fires after any change.

import {
  type Database,
  DownloadItem,
  DownloadStatus,
  Emitter,
  EpisodeRef,
  type KeyValueStorage,
  type LibraryStore,
  MediaSource,
  StoredDate,
  type Title,
} from "../data";
import {
  type BrowserDownloadDelta,
  type BrowserDownloadItem,
  type BrowserDownloads,
  type HeaderRules,
  hostOf,
  ObjectUrls,
  pageHeaders,
} from "./browser";
import { DownloadErrors } from "./errors";
import { sleep } from "./hlsDownloader";
import { DownloadHttp, type FetchLike } from "./http";
import { MediaUrls } from "./mediaUrls";
import { type StreamEvent, type StreamJob, type StreamWorker } from "./stream";
import { SubtitleTrack } from "./subtitles";
import { DownloadText } from "./text";
import { type DownloadHost, type DownloadTab } from "./types";

/** What `enqueue` needs: the Swift/C# parameters as one object. */
export interface NewDownload {
  readonly source: MediaSource;
  readonly titleId: number | null;
  readonly ref: EpisodeRef;
  readonly name: string;
  readonly pageUrl: string | null;
  /** The frame the player was in: the Referer the site checks. */
  readonly referer: string | null;
  readonly duration: number;
  readonly posterUrl: string | null;
  /** Subtitle addresses to save beside the film (at most six are taken from a tab). */
  readonly subtitles: readonly string[];
}

/** A file someone picked to add as subtitles (`<input type=file>` gives a File). */
export interface PickedFile {
  readonly name: string;
  readonly data: Blob | Uint8Array;
}

export interface DownloadCenterOptions {
  db: Database;
  library: LibraryStore;
  host: DownloadHost;
  downloads: BrowserDownloads;
  headers: HeaderRules;
  streams: StreamWorker;
  /** Per-profile storage (chrome.storage.local): which browser download holds each item. */
  storage: KeyValueStorage;
  /** Where in `storage`; by default `<database name>/downloads.json`. */
  storageKey?: string;
  /**
   * chrome.storage.session, which lasts until the browser closes. With it a service worker that
   * restarts picks up downloads still running; without it everything active counts as stopped when
   * Cineon closed, as in the apps.
   */
  session?: KeyValueStorage;
  /** For subtitles and `fetch` (the browser's own fetch by default). */
  fetch?: FetchLike;
  /** How bytes become an address chrome.downloads can save (ObjectUrls.browser() by default). */
  objectUrls?: ObjectUrls;
  /**
   * Fetch direct files through the stream worker, as streams are, and hand the browser the joined file.
   * Chrome: no declarativeNetRequest rule reaches a chrome.downloads request and the API refuses a
   * Referer, so its own download of a file can't carry the page's Referer and Origin, and sites that
   * check them refuse it. Off: chrome.downloads fetches the file (with the header rules, where the
   * browser applies them to its downloads).
   */
  fetchFiles?: boolean;
}

interface Run {
  readonly kind: "file" | "stream";
  readonly key: string;
  browserId: number | null;
  /** The name reserved in `Cineon/` until the browser has the file. */
  target: string | null;
  /** A stream whose joined file the browser is saving. */
  handoff: boolean;
  stopped: boolean;
  /** A stream's length from its playlist. */
  duration: number;
}

/** The download queue: two at a time, oldest first, with progress, stop, retry and deletion. */
export class DownloadCenter {
  /** Downloads at the same time. More only splits the same connection and makes links expire before their turn. */
  static readonly maxRunning = 2;
  /** The folder inside the browser's downloads folder. */
  static readonly folderName = "Cineon";

  readonly changed = new Emitter<void>();
  /** How often running browser downloads are asked for their progress (chrome.downloads has no progress event). */
  pollInterval = 1000;

  private _items: readonly DownloadItem[] = [];
  private _progress = new Map<number, number>();
  private readonly runs = new Map<number, Run>();
  private readonly pending = new Map<number, readonly string[]>();
  private readonly starting = new Set<number>();
  private readonly lastWrite = new Map<number, number>();
  private links = new Map<number, number>();
  private readonly reserved = new Set<string>();
  private readonly watchers = new Map<number, (item: BrowserDownloadItem | null) => void>();
  private readonly tasks = new Set<Promise<unknown>>();
  private writes: Promise<unknown> = Promise.resolve();
  private lastPillRefresh = -Infinity;
  private suspended = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly partialKey: string;
  private readonly linksKey: string;
  private readonly http: DownloadHttp;
  private readonly fetcher: FetchLike;
  private readonly objectUrls: ObjectUrls;
  private readonly onBrowserChange = (delta: BrowserDownloadDelta) => {
    this.track(this.check(delta.id));
  };

  private constructor(private readonly options: DownloadCenterOptions) {
    this.partialKey = fnv32(options.db.name);
    this.linksKey = options.storageKey ?? `${options.db.name}/downloads.json`;
    this.fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.http = new DownloadHttp(this.fetcher);
    this.objectUrls = options.objectUrls ?? ObjectUrls.browser();
  }

  /** Loads the downloads, and settles what was running when the extension last stopped. */
  static async open(options: DownloadCenterOptions): Promise<DownloadCenter> {
    const center = new DownloadCenter(options);
    await center.load();
    return center;
  }

  private async load(): Promise<void> {
    const { db, storage, session, streams, downloads, headers } = this.options;
    try {
      this._items = await db.allDownloads();
    } catch {
      this._items = [];
    }
    const stored = await storage.get(this.linksKey).catch(() => null);
    if (stored != null && typeof stored === "object") {
      for (const [id, browserId] of Object.entries(stored as Record<string, unknown>)) {
        if (typeof browserId === "number") this.links.set(Number(id), browserId);
      }
    }
    const sessionKey = `${db.name}/downloads-alive`;
    const sameSession = session != null && (await session.get(sessionKey).catch(() => null)) === true;
    await session?.set(sessionKey, true).catch(() => {});

    streams.setHandler({
      hosts: (key, urls) => this.streamHosts(key, urls),
      event: (event) => this.streamEvent(event),
    });
    downloads.onChanged.addListener(this.onBrowserChange);

    const jobs = sameSession ? await streams.jobs().catch(() => []) : [];
    const keep: string[] = [];
    for (const item of this._items) {
      if (!DownloadStatus.isActive(item.status)) continue;
      // The service worker restarted: what waited still waits, what ran may still run.
      if (sameSession && item.status === "queued") continue;
      if (sameSession && (await this.reattach(item, jobs))) {
        keep.push(this.runs.get(item.id)!.key);
        continue;
      }
      // Whatever was running when Cineon last closed stopped with it.
      this.save({ ...item, status: "failed", error: DownloadErrors.stoppedWhenClosed });
    }
    await headers.retainOnly(keep, this.partialKey).catch(() => {});
    this.pump();
  }

  /** Takes back a download still running in the browser or the stream worker. */
  private async reattach(item: DownloadItem, jobs: readonly { key: string; state: string; fraction: number }[]): Promise<boolean> {
    const browserId = this.links.get(item.id) ?? null;
    const browser = browserId != null ? await this.browserItem(browserId) : null;
    if (this.streamed(item)) {
      const key = this.streamKey(item.id);
      const job = jobs.find((j) => j.key === key);
      const handingOff = browser != null && browser.state !== "interrupted";
      if (job == null && !handingOff) return false;
      const run: Run = { kind: "stream", key, browserId: handingOff ? browserId : null, target: null, handoff: handingOff, stopped: false, duration: 0 };
      this.runs.set(item.id, run);
      if (handingOff) {
        this.startPolling();
        this.track(this.check(browserId!));
      } else {
        this._progress.set(item.id, job!.fraction);
        // A job that ended while nobody listened says so again.
        if (job!.state !== "running") this.track(this.options.streams.start(this.streamJob(item)).catch(() => {}));
      }
      return true;
    }
    if (browser == null || browser.state === "interrupted" || (browser.state === "in_progress" && browser.paused)) return false;
    this.runs.set(item.id, { kind: "file", key: this.fileKey(item.id), browserId, target: null, handoff: false, stopped: false, duration: 0 });
    this.startPolling();
    this.track(this.check(browserId!));
    return true;
  }

  // MARK: Reading

  /** Newest first. A new array whenever anything changes. */
  get items(): readonly DownloadItem[] {
    return this._items;
  }

  /** Live progress, 0 to 1, for downloads whose size isn't known in bytes. */
  get progress(): ReadonlyMap<number, number> {
    return this._progress;
  }

  get activeCount(): number {
    return this._items.filter((i) => DownloadStatus.isActive(i.status)).length;
  }

  get runningCount(): number {
    return this._items.filter((i) => i.status === "downloading").length + this.starting.size;
  }

  get hasFreeSlot(): boolean {
    return this.runningCount < DownloadCenter.maxRunning;
  }

  /** The profile database's name (`cineon-<UUID>`), which keys this profile's stored state. */
  get databaseName(): string {
    return this.options.db.name;
  }

  /** `Cineon`, the folder inside the browser's downloads folder. */
  get folder(): string {
    return DownloadCenter.folderName;
  }

  item(id: number): DownloadItem | null {
    return this._items.find((i) => i.id === id) ?? null;
  }

  fraction(item: DownloadItem): number {
    if (item.status === "done") return 1;
    return this._progress.get(item.id) ?? DownloadItem.fraction(item);
  }

  /** The browser's download that holds (or is saving) this item, for `chrome.downloads.open/show`. */
  browserDownloadId(id: number): number | null {
    return this.links.get(id) ?? null;
  }

  /** The download that already holds what this tab is showing, if there is one. */
  existing(tab: DownloadTab): DownloadItem | null {
    const best = tab.bestSource;
    if (best != null) {
      const wanted = MediaUrls.progressive(best.url);
      const match = this._items.find((i) => i.sourceUrl === wanted && i.status !== "failed");
      if (match) return match;
    }
    const titleId = tab.linkedTitleId;
    if (titleId == null) return null;
    const ref = tab.trackRef ?? tab.parsed?.ref ?? EpisodeRef.none;
    return this._items.find((i) => i.titleId === titleId && EpisodeRef.equals(i.ref, ref) && i.status !== "failed") ?? null;
  }

  /** The download for a file someone stopped watching on this computer. */
  itemForFile(path: string): DownloadItem | null {
    return this._items.find((i) => i.file === path) ?? null;
  }

  // MARK: Starting

  /** Downloads what the tab is playing. Resolves to false when there's nothing to download. */
  async download(tab: DownloadTab): Promise<boolean> {
    const existing = this.existing(tab);
    if (existing != null) {
      if (existing.status === "done") this.options.host.playDownload(existing);
      else this.toast(DownloadText.alreadyDownloading(existing.name));
      return true;
    }
    const source = tab.bestSource;
    if (source == null) {
      this.toast(DownloadText.playFirst);
      return false;
    }
    const title = await this.libraryTitle(tab);
    const ref = tab.trackRef ?? tab.parsed?.ref ?? EpisodeRef.none;
    const name = title?.name ?? tab.parsed?.name ?? tab.displayTitle;
    const subtitles = tab.sources
      .filter((s) => s.kind === "subtitle" && s.isCurrent)
      .slice(0, 6)
      .map((s) => s.url);
    const item = await this.enqueue({
      source,
      titleId: title?.id ?? null,
      ref,
      name,
      pageUrl: tab.url,
      referer: tab.sourcesFrameUrl ?? tab.url,
      duration: tab.mediaDuration,
      posterUrl: title?.posterUrl ?? tab.parsed?.posterUrl ?? null,
      subtitles,
    });
    if (item == null) return false;
    const isWaiting = this.item(item.id)?.status === "queued" && !this.starting.has(item.id);
    const fileName = DownloadItem.fileBaseName(item);
    this.toast(isWaiting ? DownloadText.queued(fileName) : DownloadText.downloading(fileName));
    return true;
  }

  /** Adds a download to the queue. It starts as soon as fewer than two are running. */
  async enqueue(download: NewDownload): Promise<DownloadItem | null> {
    const sourceUrl = MediaUrls.progressive(download.source.url);
    let item = DownloadItem.make({
      titleId: download.titleId,
      ref: download.ref,
      name: download.name,
      sourceUrl,
      pageUrl: download.pageUrl,
      referer: download.referer,
      host: hostOf(download.pageUrl) ?? hostOf(sourceUrl) ?? "",
      kind: download.source.kind === "hls" ? "hls" : "file",
      quality: MediaSource.qualityIn(sourceUrl),
      status: "queued",
      duration: download.duration,
      posterUrl: download.posterUrl,
      createdAt: StoredDate.now(),
    });
    try {
      item = { ...item, id: await this.options.db.insertDownload(item) };
    } catch {
      return null;
    }
    this._items = [item, ...this._items];
    this.pending.set(item.id, download.subtitles);
    this.pump();
    this.refreshPills(true);
    this.raiseChanged();
    return item;
  }

  /** Starts queued downloads, oldest first, while there's room. */
  private pump(): void {
    if (this.suspended) return;
    const starts: [number, readonly string[]][] = [];
    for (let index = this._items.length - 1; index >= 0; index--) {
      const item = this._items[index]!;
      if (item.status !== "queued" || this.runs.has(item.id) || this.starting.has(item.id)) continue;
      if (this._items.filter((i) => i.status === "downloading").length + this.starting.size >= DownloadCenter.maxRunning) break;
      this.starting.add(item.id);
      starts.push([item.id, this.pending.get(item.id) ?? []]);
      this.pending.delete(item.id);
    }
    for (const [id, subtitles] of starts) {
      this.track(
        this.begin(id, subtitles).finally(() => {
          this.starting.delete(id);
          // One that didn't start after all leaves its slot to the next.
          this.pump();
        }),
      );
    }
  }

  /** Downloads any file the way the page's player would, with its address. Null on any failure. */
  async fetch(url: string, referer: string | null): Promise<Uint8Array | null> {
    return this.fetchAsPage(url, referer, `fetch-${this.partialKey}-${++fetchCounter}`);
  }

  /** Adds a subtitle file someone picked to a download, saved next to it. Resolves to its path. */
  async addSubtitles(file: PickedFile, id: number): Promise<string | null> {
    const item = this.item(id);
    if (item == null) return null;
    const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(await file.data.arrayBuffer());
    const dot = file.name.lastIndexOf(".");
    const ext = dot > 0 && file.name.slice(dot + 1).toLowerCase() === "srt" ? "srt" : "vtt";
    const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
    const label = SubtitleTrack.labelForFile(file.name, item.subtitles.length);
    const name = label.length === 0 || label.startsWith("Track") ? stem : label.toLowerCase();
    const path = await this.saveBytes(data, `${DownloadItem.fileBaseName(item)}.${name}.${ext}`, mimeOf(ext));
    if (path == null) return null;
    const current = this.item(id);
    if (current == null) return null;
    this.save({ ...current, subtitles: [...current.subtitles, path] });
    this.raiseChanged();
    return path;
  }

  /** The downloaded episode after this one, if it's on this computer. */
  nextEpisode(item: DownloadItem): DownloadItem | null {
    if (item.titleId == null || !EpisodeRef.isEpisode(item.ref)) return null;
    let next: DownloadItem | null = null;
    for (const i of this._items) {
      if (i.titleId !== item.titleId || i.status !== "done" || !EpisodeRef.isEpisode(i.ref) || i.file == null) continue;
      if (DownloadCenter.compare(i.ref, item.ref) <= 0) continue;
      if (next == null || DownloadCenter.compare(i.ref, next.ref) < 0) next = i;
    }
    return next;
  }

  static compare(a: EpisodeRef, b: EpisodeRef): number {
    return a.season !== b.season ? a.season - b.season : a.episode - b.episode;
  }

  /**
   * A watched episode is deleted (the Mac moves it to the Bin; the browser can only delete). The
   * item leaves the list at once; the promise settles once the files are gone.
   */
  binWatched(id: number): Promise<void> {
    const item = this.item(id);
    if (item == null || !EpisodeRef.isEpisode(item.ref) || item.status !== "done") return Promise.resolve();
    const removed = this.remove(id);
    this.toast(DownloadText.deletedWatched(DownloadItem.fileBaseName(item)));
    return removed;
  }

  /**
   * The library's entry for what the tab shows, added if it isn't there yet, so the copy on this
   * computer has a poster, and watching it lands on the timeline.
   */
  async libraryTitle(tab: DownloadTab): Promise<Title | null> {
    const library = this.options.library;
    if (tab.linkedTitleId != null) {
      const linked = library.titles.get(tab.linkedTitleId);
      if (linked) return linked;
    }
    const parsed = tab.parsed;
    if (parsed == null) return null;
    const found = library.find(parsed.name, parsed.altName ?? null, parsed.year ?? null);
    if (found) return found;
    const added = await library.addTitle(parsed.name, {
      year: parsed.year ?? null,
      kind: parsed.kindHint ?? "unknown",
      status: "none",
      posterUrl: parsed.posterUrl ?? null,
      overview: parsed.overview ?? null,
    });
    if (added == null) return null;
    this.options.host.enrichTitle(added.id, parsed.altName ?? null);
    return added;
  }

  /** Puts a stopped or failed download back in the queue. A file carries on from where it stopped. */
  retry(id: number): void {
    const item = this.item(id);
    if (item == null || DownloadStatus.isActive(item.status)) return;
    this.save({ ...item, status: "queued", error: null });
    this.pump();
    this.raiseChanged();
  }

  /** Stops a download. What it saved so far is kept, so `retry` carries on from there. */
  cancel(id: number): void {
    const run = this.runs.get(id);
    if (run == null) {
      // Still waiting for its turn.
      const item = this.item(id);
      if (item?.status === "queued") {
        this.pending.delete(id);
        this.save({ ...item, status: "failed", error: DownloadErrors.stopped });
        this.refreshPills(true);
        this.raiseChanged();
      }
      return;
    }
    run.stopped = true;
    const { downloads, streams } = this.options;
    if (run.kind === "stream" && !run.handoff) {
      this.track(streams.stop(run.key).catch(() => {}));
    } else if (run.browserId != null) {
      const browserId = run.browserId;
      if (run.handoff) {
        // The joined file stays in OPFS; Try again hands it over again.
        this.forgetLink(id);
        this.track(downloads.cancel(browserId).then(() => downloads.erase({ id: browserId })).catch(() => {}));
      } else {
        this.track(downloads.pause(browserId).catch(() => {}));
      }
    }
    this.failRun(id, DownloadErrors.stopped);
  }

  /**
   * Deletes the film and its subtitles (there's no Bin to move them to) and forgets the download.
   * The item leaves the list at once; the promise settles once the files are gone.
   */
  remove(id: number): Promise<void> {
    const item = this.item(id);
    if (item == null) return Promise.resolve();
    const browserId = this.links.get(id) ?? this.runs.get(id)?.browserId ?? null;
    this.cancel(id);
    const current = this.item(id) ?? item;
    this._items = this._items.filter((i) => i.id !== id);
    this.deleteProgress(id);
    this.pending.delete(id);
    this.forgetLink(id);
    const work = (async () => {
      await this.deleteFiles(current, browserId);
      if (this.streamed(item)) await this.options.streams.discard(this.streamKey(id)).catch(() => {});
      await this.options.headers.remove(this.fileKey(id)).catch(() => {});
      await this.options.headers.remove(this.streamKey(id)).catch(() => {});
      await this.writes;
      await this.options.db.deleteDownload(id).catch(() => {});
    })();
    this.track(work);
    this.refreshPills(true);
    this.raiseChanged();
    return work;
  }

  /** Shows the file in the browser's way (its folder, selected), or the downloads folder. */
  async showInFolder(item: DownloadItem): Promise<void> {
    const browserId = this.links.get(item.id);
    const browser = browserId != null ? await this.browserItem(browserId) : null;
    if (browser != null && browser.state === "complete" && browser.exists) this.options.downloads.show(browser.id);
    else this.options.downloads.showDefaultFolder();
  }

  /** Remembers where playback stopped, and for how long the file runs. */
  notePlayback(id: number, position: number, duration: number): void {
    const item = this.item(id);
    if (item == null) return;
    this.save({ ...item, position, duration: duration > 0 ? duration : item.duration, playedAt: StoredDate.now() });
    this.raiseChanged();
  }

  /** Stops everything when the profile closes. Nothing starts again on this center. */
  suspendAll(): void {
    this.suspended = true;
    for (const id of [...this.runs.keys()]) this.cancel(id);
    this.detach();
  }

  /**
   * Stops listening to the browser and the stream worker and starts nothing more, but leaves every
   * download running: what a stopped service worker amounts to. A center opened next with
   * `session` takes them over.
   */
  detach(): void {
    this.suspended = true;
    this.options.downloads.onChanged.removeListener(this.onBrowserChange);
    this.options.streams.setHandler(null);
    for (const [browserId, resolve] of this.watchers) {
      this.watchers.delete(browserId);
      resolve(null);
    }
    this.stopPolling();
  }

  /** Waits until nothing is starting, running or being written. For tests and for closing. */
  async idle(): Promise<void> {
    let waits = 0;
    for (;;) {
      if (this.tasks.size > 0) {
        await Promise.allSettled([...this.tasks]);
        continue;
      }
      const busy =
        !this.suspended &&
        (this.starting.size > 0 || this._items.some((i) => i.status === "queued" || i.status === "downloading"));
      if (!busy || ++waits > 1500) break;
      await sleep(10);
    }
    await this.writes;
  }

  // MARK: Running

  private async begin(id: number, subtitles: readonly string[]): Promise<void> {
    const current = this.item(id);
    if (this.suspended || current?.status !== "queued") return;
    const item: DownloadItem = { ...current, status: "downloading" };
    this.save(item);
    const run: Run = {
      kind: this.streamed(item) ? "stream" : "file",
      key: this.streamed(item) ? this.streamKey(id) : this.fileKey(id),
      browserId: null,
      target: null,
      handoff: false,
      stopped: false,
      duration: 0,
    };
    this.runs.set(id, run);
    // Counted as running from now on. The Mac counts it twice until its subtitles are saved, which
    // can hold the next download back until this one ends.
    this.starting.delete(id);
    this.raiseChanged();
    this.track(run.kind === "stream" ? this.runStream(item, run) : this.runFile(item, run));
    if (subtitles.length > 0) await this.saveSubtitles(subtitles, id);
  }

  private async runFile(item: DownloadItem, run: Run): Promise<void> {
    const { downloads, headers } = this.options;
    try {
      await headers.add(run.key, { urls: [item.sourceUrl], sites: [item.sourceUrl].flatMap(siteOf) }, pageHeaders(item.referer, item.sourceUrl));
      if (run.stopped) return;
      const known = this.links.get(item.id);
      if (known != null) {
        const browser = await this.browserItem(known);
        if (run.stopped) return;
        if (browser?.state === "complete" && browser.exists) {
          run.browserId = known;
          this.finished(item.id, browser);
          return;
        }
        if (browser != null && browser.canResume && (browser.state === "interrupted" || browser.paused)) {
          // Carries on from where it stopped: the browser asks for the rest with a Range request.
          run.browserId = known;
          await downloads.resume(known);
          this.startPolling();
          this.track(this.check(known));
          return;
        }
        if (browser != null) await this.discardBrowserDownload(known);
        this.forgetLink(item.id);
      }
      const name = await this.uniqueName(`${DownloadItem.fileBaseName(item)}.${DownloadCenter.extension(null, item.sourceUrl)}`);
      run.target = name;
      if (run.stopped) {
        this.reserved.delete(name.toLowerCase());
        return;
      }
      const browserId = await downloads.download({
        url: item.sourceUrl,
        filename: `${DownloadCenter.folderName}/${name}`,
        conflictAction: "uniquify",
        saveAs: false,
      });
      run.browserId = browserId;
      this.setLink(item.id, browserId);
      if (run.stopped) {
        await downloads.pause(browserId).catch(() => {});
        return;
      }
      this.startPolling();
      this.track(this.check(browserId));
    } catch (error) {
      if (this.runs.get(item.id) === run) this.failRun(item.id, DownloadErrors.describe(error));
    }
  }

  private async runStream(item: DownloadItem, run: Run): Promise<void> {
    const { headers, streams } = this.options;
    try {
      await headers.add(run.key, { urls: [item.sourceUrl], sites: [item.sourceUrl].flatMap(siteOf) }, pageHeaders(item.referer, item.sourceUrl));
      if (run.stopped) return;
      // A hand-off that finished while nobody was listening.
      const known = this.links.get(item.id);
      if (known != null) {
        const browser = await this.browserItem(known);
        if (run.stopped) return;
        if (browser?.state === "complete" && browser.exists) {
          run.browserId = known;
          run.handoff = true;
          this.finished(item.id, browser);
          return;
        }
        if (browser != null) await this.discardBrowserDownload(known);
        this.forgetLink(item.id);
      }
      await streams.start(this.streamJob(item));
    } catch (error) {
      if (this.runs.get(item.id) === run) this.failRun(item.id, DownloadErrors.describe(error));
    }
  }

  /** The stream worker asks for the page's headers on more hosts. */
  private async streamHosts(key: string, urls: readonly string[]): Promise<void> {
    const entry = this.runForKey(key);
    if (entry == null) return;
    const item = this.item(entry[0]);
    if (item == null) return;
    await this.options.headers.add(key, { sites: urls.flatMap(siteOf) }, pageHeaders(item.referer, item.sourceUrl));
  }

  private streamEvent(event: StreamEvent): void {
    const entry = this.runForKey(event.key);
    if (entry == null) return;
    const [id, run] = entry;
    switch (event.type) {
      case "progress":
        if (!run.handoff) this.loaded(id, event.fraction);
        break;
      case "failed":
        if (!run.handoff) this.failRun(id, event.stopped ? DownloadErrors.stopped : event.message);
        break;
      case "done":
        this.track(this.handOff(id, run, event));
        break;
    }
  }

  /** The stream is one file in OPFS: the browser saves it into Cineon/. */
  private async handOff(id: number, run: Run, done: Extract<StreamEvent, { type: "done" }>): Promise<void> {
    if (run.handoff) return;
    run.handoff = true;
    run.duration = done.duration;
    this.loaded(id, 1);
    try {
      const item = this.item(id);
      if (item == null) return;
      const name = await this.uniqueName(`${DownloadItem.fileBaseName(item)}.${done.extension}`);
      run.target = name;
      if (this.runs.get(id) !== run) {
        this.reserved.delete(name.toLowerCase());
        return;
      }
      const browserId = await this.options.downloads.download({
        url: done.url,
        filename: `${DownloadCenter.folderName}/${name}`,
        conflictAction: "uniquify",
        saveAs: false,
      });
      run.browserId = browserId;
      this.setLink(id, browserId);
      if (this.runs.get(id) !== run) {
        await this.discardBrowserDownload(browserId);
        this.forgetLink(id);
        return;
      }
      this.startPolling();
      this.track(this.check(browserId));
    } catch (error) {
      if (this.runs.get(id) === run) this.failRun(id, DownloadErrors.couldNotSave(DownloadErrors.describe(error)));
    }
  }

  /** What the browser says about one of its downloads, acted on. */
  private async check(browserId: number): Promise<void> {
    const watcher = this.watchers.get(browserId);
    const entry = [...this.runs].find(([, r]) => r.browserId === browserId);
    if (watcher == null && entry == null) return;
    const browser = await this.browserItem(browserId);
    if (watcher != null && this.watchers.get(browserId) === watcher && (browser == null || browser.state !== "in_progress")) {
      this.watchers.delete(browserId);
      watcher(browser);
      this.stopPollingIfIdle();
    }
    if (entry == null) return;
    const [id, run] = entry;
    if (this.runs.get(id) !== run || run.browserId !== browserId) return;
    if (browser == null) {
      // Taken out of the browser's list while it ran.
      this.forgetLink(id);
      this.failRun(id, DownloadErrors.stopped);
      return;
    }
    switch (browser.state) {
      case "complete":
        this.finished(id, browser);
        return;
      case "interrupted": {
        const message = run.handoff
          ? DownloadErrors.interruption(browser.error)
          : await this.interruption(this.item(id), browser);
        if (this.runs.get(id) !== run) return;
        if (run.handoff || browser.error === "USER_CANCELED" || !browser.canResume) {
          // Nothing to carry on from: Try again starts a new download, so this one leaves the list.
          this.forgetLink(id);
          this.track(this.options.downloads.erase({ id: browserId }).catch(() => {}));
        }
        this.failRun(id, message);
        return;
      }
      default:
        if (browser.paused) {
          // Paused from the browser's own list.
          this.failRun(id, DownloadErrors.stopped);
        } else if (!run.handoff) {
          this.wrote(id, browser.bytesReceived, browser.totalBytes);
        }
    }
  }

  /** The browser's reason, or the site's own status when the browser only says it failed. */
  private async interruption(item: DownloadItem | null, browser: BrowserDownloadItem): Promise<string> {
    if (browser.error === "SERVER_FAILED" && item != null) {
      const status = await this.http.status(item.sourceUrl);
      if (status != null && status >= 400) return DownloadErrors.explain(status);
    }
    return DownloadErrors.interruption(browser.error);
  }

  /** Saves the subtitles the page's player asked for beside the film. */
  private async saveSubtitles(urls: readonly string[], id: number): Promise<void> {
    const saved: string[] = [];
    for (let index = 0; index < urls.length; index++) {
      const url = urls[index]!;
      const data = await this.fetchAsPage(url, this.item(id)?.referer ?? null, `subs-${this.partialKey}-${id}`);
      const item = this.item(id);
      if (data == null || data.length === 0 || item == null) continue;
      const ext = pathExtension(url).toLowerCase() === "srt" ? "srt" : "vtt";
      const label = SubtitleTrack.labelFor(url, index);
      const path = await this.saveBytes(data, `${DownloadItem.fileBaseName(item)}.${label}.${ext}`, mimeOf(ext));
      if (path != null) saved.push(path);
    }
    if (saved.length === 0) return;
    const item = this.item(id);
    if (item == null) return;
    this.save({ ...item, subtitles: [...item.subtitles, ...saved] });
    this.raiseChanged();
  }

  /** GET with the page's Referer and Origin (a rule only while it runs). Null on any failure. */
  private async fetchAsPage(url: string, referer: string | null, key: string): Promise<Uint8Array | null> {
    const { headers } = this.options;
    try {
      await headers.add(key, { urls: [url], sites: siteOf(url) }, pageHeaders(referer, url));
      const data = await this.http.getBytes(url, null);
      return data.length === 0 ? null : data;
    } catch {
      return null;
    } finally {
      await headers.remove(key).catch(() => {});
    }
  }

  /** Saves bytes into Cineon/ through the browser. Resolves to the file's path, or null. */
  private async saveBytes(data: Uint8Array, desired: string, mime: string): Promise<string | null> {
    const name = await this.uniqueName(desired);
    let url: string | null = null;
    try {
      url = await this.objectUrls.create(new Blob([data as Uint8Array<ArrayBuffer>], { type: mime }));
      const browserId = await this.options.downloads.download({
        url,
        filename: `${DownloadCenter.folderName}/${name}`,
        conflictAction: "uniquify",
        saveAs: false,
      });
      const browser = await this.waitForBrowser(browserId);
      return browser?.state === "complete" ? browser.filename : null;
    } catch {
      return null;
    } finally {
      this.reserved.delete(name.toLowerCase());
      if (url != null) this.objectUrls.revoke(url);
    }
  }

  // MARK: Transfer events

  private wrote(id: number, bytes: number, total: number): void {
    const current = this.item(id);
    if (current == null) return;
    const item = { ...current, bytes, totalBytes: total > 0 ? total : current.totalBytes };
    if (item.totalBytes > 0) this.setProgress(id, bytes / item.totalBytes);
    // Keep the row current without writing the database many times a second.
    const now = Date.now();
    if (now - (this.lastWrite.get(id) ?? -Infinity) > 3000) {
      this.lastWrite.set(id, now);
      this.save(item);
    } else {
      this.replace(item);
    }
    this.refreshPills();
    this.raiseChanged();
  }

  private loaded(id: number, fraction: number): void {
    if (this.item(id) == null) return;
    this.setProgress(id, fraction);
    this.refreshPills();
    this.raiseChanged();
  }

  private finished(id: number, browser: BrowserDownloadItem): void {
    const run = this.runs.get(id);
    const current = this.item(id);
    if (run == null || current == null) return;
    this.runs.delete(id);
    this.deleteProgress(id);
    if (run.target != null) this.reserved.delete(run.target.toLowerCase());
    const size = browser.fileSize > 0 ? browser.fileSize : browser.bytesReceived;
    const item: DownloadItem = {
      ...current,
      file: browser.filename,
      status: "done",
      error: null,
      finishedAt: StoredDate.now(),
      bytes: size > 0 ? size : current.bytes,
      totalBytes: size > 0 ? size : current.totalBytes,
      duration: run.duration > 0 ? run.duration : current.duration,
    };
    this.save(item);
    this.track(this.options.headers.remove(run.key).catch(() => {}));
    if (run.kind === "stream") this.track(this.options.streams.release(run.key).catch(() => {}));
    this.stopPollingIfIdle();
    this.refreshPills(true);
    this.pump();
    this.raiseChanged();
    this.toast(DownloadText.saved(DownloadItem.fileBaseName(item)), DownloadText.play, () => {
      const saved = this.item(id);
      if (saved != null) this.options.host.playDownload(saved);
    });
    this.track(this.readDuration(id));
  }

  /** The run ended without a file: stopped or failed. Its parts stay for `retry`. */
  private failRun(id: number, message: string): void {
    const run = this.runs.get(id);
    this.runs.delete(id);
    this.deleteProgress(id);
    if (run != null) {
      this.track(this.options.headers.remove(run.key).catch(() => {}));
      if (run.target != null) this.reserved.delete(run.target.toLowerCase());
    }
    this.stopPollingIfIdle();
    const item = this.item(id);
    if (item != null) this.save({ ...item, status: "failed", error: message });
    this.refreshPills(true);
    this.pump();
    this.raiseChanged();
  }

  private async readDuration(id: number): Promise<void> {
    const item = this.item(id);
    if (item?.file == null || this.options.host.mediaDuration == null) return;
    let seconds: number | null;
    try {
      seconds = await this.options.host.mediaDuration(item);
    } catch {
      return;
    }
    if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return;
    const current = this.item(id);
    if (current == null) return;
    this.save({ ...current, duration: seconds });
    this.raiseChanged();
  }

  // MARK: The browser's downloads

  private async browserItem(browserId: number): Promise<BrowserDownloadItem | null> {
    try {
      return (await this.options.downloads.search({ id: browserId }))[0] ?? null;
    } catch {
      return null;
    }
  }

  private waitForBrowser(browserId: number): Promise<BrowserDownloadItem | null> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.watchers.delete(browserId)) resolve(null);
      }, 120_000);
      this.watchers.set(browserId, (item) => {
        clearTimeout(timeout);
        resolve(item);
      });
      this.startPolling();
      this.track(this.check(browserId));
    });
  }

  /** Cancels a browser download (deleting its partial file) and takes it off the browser's list. */
  private async discardBrowserDownload(browserId: number): Promise<void> {
    const { downloads } = this.options;
    await downloads.cancel(browserId).catch(() => {});
    await downloads.erase({ id: browserId }).catch(() => {});
  }

  /** Deletes the film and its subtitles, or the browser's partial file of an unfinished one. */
  private async deleteFiles(item: DownloadItem, browserId: number | null): Promise<void> {
    const { downloads } = this.options;
    if (item.status !== "done" && browserId != null) await this.discardBrowserDownload(browserId);
    for (const path of [item.file, ...item.subtitles]) {
      if (path == null || path.length === 0) continue;
      const found = await downloads.search({ filename: path }).catch(() => [] as BrowserDownloadItem[]);
      const saved = found.find((b) => b.state === "complete" && b.exists);
      if (saved == null) continue;
      await downloads.removeFile(saved.id).catch(() => {});
      await downloads.erase({ id: saved.id }).catch(() => {});
    }
  }

  /**
   * A name in Cineon/ that nothing has yet: the apps' "Arrival 2.mkv" rather than the browser's
   * "Arrival (1).mkv". The browser can only say what it downloaded itself, so `uniquify` stays on
   * for files it doesn't know about. The name is reserved until the browser has the file.
   */
  private async uniqueName(desired: string): Promise<string> {
    const { stem } = splitName(desired);
    const taken = new Set<string>();
    try {
      const pattern = `[/\\\\]${escapeRegex(DownloadCenter.folderName)}[/\\\\]${escapeRegex(stem)}`;
      for (const b of await this.options.downloads.search({ filenameRegex: pattern })) {
        const holdsName = b.exists || b.state === "in_progress" || (b.state === "interrupted" && b.canResume);
        if (b.filename.length > 0 && holdsName) taken.add(baseName(b.filename).toLowerCase());
      }
    } catch {
      // Unknown: the browser's uniquify still keeps files apart.
    }
    const name = DownloadCenter.unique(desired, (n) => taken.has(n.toLowerCase()) || this.reserved.has(n.toLowerCase()));
    this.reserved.add(name.toLowerCase());
    return name;
  }

  private startPolling(): void {
    if (this.pollTimer != null || this.suspended) return;
    this.pollTimer = setInterval(() => {
      for (const run of this.runs.values()) if (run.browserId != null) this.track(this.check(run.browserId));
      for (const browserId of this.watchers.keys()) this.track(this.check(browserId));
    }, this.pollInterval);
  }

  private stopPollingIfIdle(): void {
    if (this.watchers.size > 0) return;
    for (const run of this.runs.values()) if (run.browserId != null) return;
    this.stopPolling();
  }

  private stopPolling(): void {
    if (this.pollTimer != null) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  // MARK: Helpers

  private fileKey(id: number): string {
    return `file-${this.partialKey}-${id}`;
  }

  /** Saved through the stream worker: every stream, and in Chrome every direct file (`fetchFiles`). */
  private streamed(item: DownloadItem): boolean {
    return item.kind === "hls" || this.options.fetchFiles === true;
  }

  private streamJob(item: DownloadItem): StreamJob {
    const key = this.streamKey(item.id);
    return item.kind === "hls"
      ? { key, url: item.sourceUrl }
      : { key, url: item.sourceUrl, kind: "file", extension: DownloadCenter.extension(null, item.sourceUrl) };
  }

  /** Also the stream's OPFS folder: `cineon-partial/<key>.hls`. */
  private streamKey(id: number): string {
    return `${this.partialKey}-${id}`;
  }

  private runForKey(key: string): [number, Run] | null {
    for (const entry of this.runs) if (entry[1].key === key) return entry;
    return null;
  }

  private setLink(id: number, browserId: number): void {
    this.links.set(id, browserId);
    this.saveLinks();
  }

  private forgetLink(id: number): void {
    if (this.links.delete(id)) this.saveLinks();
  }

  private saveLinks(): void {
    const snapshot = Object.fromEntries(this.links);
    this.writes = this.writes.then(() => this.options.storage.set(this.linksKey, snapshot).catch(() => {}));
  }

  private save(item: DownloadItem): void {
    this.replace(item);
    this.writes = this.writes.then(() => this.options.db.updateDownload(item).catch(() => {}));
  }

  private replace(item: DownloadItem): void {
    const index = this._items.findIndex((i) => i.id === item.id);
    if (index < 0) return;
    const next = [...this._items];
    next[index] = item;
    this._items = next;
  }

  private setProgress(id: number, fraction: number): void {
    this._progress = new Map(this._progress).set(id, fraction);
  }

  private deleteProgress(id: number): void {
    if (!this._progress.has(id)) return;
    const next = new Map(this._progress);
    next.delete(id);
    this._progress = next;
  }

  private track(task: Promise<unknown>): void {
    const tracked = task.catch((error) => console.error(error)).finally(() => this.tasks.delete(tracked));
    this.tasks.add(tracked);
  }

  /**
   * Updates the download button on every page that shows one. At most once a second while a
   * download runs, so it doesn't flood the page.
   */
  refreshPills(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastPillRefresh <= 1000) return;
    this.lastPillRefresh = now;
    this.options.host.refreshDownloadPills();
  }

  private toast(message: string, actionTitle?: string, action?: () => void): void {
    this.options.host.showToast(message, actionTitle, action);
  }

  private raiseChanged(): void {
    this.changed.emit();
  }

  /** The same name with " 2", " 3"… added until it's free. "Name.en.vtt" keeps both extensions. */
  static unique(name: string, taken: (name: string) => boolean): string {
    const { stem, ext } = splitName(name);
    let target = name;
    for (let counter = 2; taken(target); counter++) target = `${stem} ${counter}${ext}`;
    return target;
  }

  /** The site's name for the file, then the address, then mp4. */
  static extension(suggested: string | null, source: string): string {
    for (const candidate of [suggested == null ? null : splitName(suggested).ext.slice(1), pathExtension(source)]) {
      const ext = candidate?.toLowerCase();
      if (ext != null && KNOWN_EXTENSIONS.has(ext)) return ext;
    }
    return "mp4";
  }
}

const KNOWN_EXTENSIONS = new Set(["mp4", "m4v", "mov", "webm", "mkv"]);
let fetchCounter = 0;

/** `Name.en.vtt` → stem `Name.en`, ext `.vtt` (Path.GetFileNameWithoutExtension / GetExtension). */
function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? { stem: name, ext: "" } : { stem: name.slice(0, dot), ext: name.slice(dot) };
}

function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0 ? path : path.slice(cut + 1);
}

/** The extension of an address's last path component, without the dot ("" when none). */
function pathExtension(url: string): string {
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    path = url.split(/[?#]/)[0] ?? "";
  }
  const last = baseName(path);
  const dot = last.lastIndexOf(".");
  return dot <= 0 ? "" : last.slice(dot + 1);
}

/** The registrable domain of an address's host, for a header rule. */
function siteOf(url: string): string[] {
  const host = hostOf(url);
  return host == null ? [] : [host];
}

function escapeRegex(text: string): string {
  return text.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
}

function mimeOf(ext: string): string {
  return ext === "srt" ? "application/x-subrip" : "text/vtt";
}

/** FNV-1a, 32 bits, as eight hex digits: a short key per profile database for partial names. */
function fnv32(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
