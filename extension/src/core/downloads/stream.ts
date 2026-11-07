// Streams are saved where a document is: Chrome's service worker has no object URLs and stops when
// idle, so there the StreamHost below runs in an offscreen document (src/offscreen) and the center
// talks to it through OffscreenStreamWorker; Firefox's background is an event page with a DOM, so
// the center uses a StreamHost directly. Either way the center sees a StreamWorker.

import { DownloadErrors, DownloadFailedError } from "./errors";
import { DownloadHttp, type FetchLike } from "./http";
import { HlsDownloader } from "./hlsDownloader";
import { type ObjectUrls } from "./browser";
import { type PartStore } from "./partStore";

/** One stream to save. `key` names its OPFS folder (`<key>.hls`) and its rules; it stays the same across retries. */
export interface StreamJob {
  readonly key: string;
  readonly url: string;
}

export type StreamEvent =
  | { readonly type: "progress"; readonly key: string; readonly fraction: number }
  /** The joined file is ready at `url` (an object URL) for chrome.downloads; parts stay until `release`. */
  | {
      readonly type: "done";
      readonly key: string;
      readonly url: string;
      readonly extension: "ts" | "mp4";
      readonly duration: number;
      readonly size: number;
    }
  | { readonly type: "failed"; readonly key: string; readonly message: string; readonly stopped: boolean };

export interface StreamJobState {
  readonly key: string;
  readonly state: "running" | "done" | "failed";
  readonly fraction: number;
  /** The `done` event, while the file waits to be handed off. */
  readonly done: Extract<StreamEvent, { type: "done" }> | null;
  readonly message: string | null;
}

/** The center's side of the worker. */
export interface StreamHandler {
  /** Set up the page's Referer and Origin for these addresses; resolves once they're in place. */
  hosts(key: string, urls: string[]): Promise<void>;
  event(event: StreamEvent): void;
}

export interface StreamWorker {
  setHandler(handler: StreamHandler | null): void;
  /** Starts (or carries on with) a stream. A job that's already running is left alone; one that's done reports `done` again. */
  start(job: StreamJob): Promise<void>;
  /** Stops it; its parts stay for a retry. Resolves once it has stopped. */
  stop(key: string): Promise<void>;
  /** Stops it and deletes its parts (the download was removed). */
  discard(key: string): Promise<void>;
  /** The browser has the file: forget the object URL and delete the parts. */
  release(key: string): Promise<void>;
  /** Jobs this worker knows since it started (it outlives a service worker restart, not a browser restart). */
  jobs(): Promise<StreamJobState[]>;
}

export interface StreamHostOptions {
  /** OPFS `cineon-partial`, or a function that opens it when first needed. */
  parts: PartStore | (() => Promise<PartStore>);
  fetch: FetchLike;
  objectUrls: ObjectUrls;
  subtle?: SubtleCrypto;
  /** Milliseconds between progress events, so the center isn't flooded. */
  progressInterval?: number;
}

interface Job {
  key: string;
  url: string;
  state: "running" | "done" | "failed";
  fraction: number;
  controller: AbortController;
  task: Promise<void>;
  done: Extract<StreamEvent, { type: "done" }> | null;
  message: string | null;
}

/** Runs streams with HlsDownloader into OPFS and hands back object URLs of the joined files. */
export class StreamHost implements StreamWorker {
  readonly http: DownloadHttp;
  readonly hls: HlsDownloader;
  progressInterval: number;
  private handler: StreamHandler | null = null;
  private readonly running = new Map<string, Job>();
  private store: Promise<PartStore> | null = null;

  constructor(private readonly options: StreamHostOptions) {
    this.http = new DownloadHttp(options.fetch);
    this.hls = new HlsDownloader(this.http, options.subtle);
    this.progressInterval = options.progressInterval ?? 200;
  }

  static folderName(key: string): string {
    return `${key}.hls`;
  }

  setHandler(handler: StreamHandler | null): void {
    this.handler = handler;
  }

  async start(request: StreamJob): Promise<void> {
    const existing = this.running.get(request.key);
    if (existing?.state === "running") return;
    if (existing?.state === "done" && existing.done != null && existing.url === request.url) {
      this.emit(existing.done);
      return;
    }
    if (existing?.done != null) this.options.objectUrls.revoke(existing.done.url);
    const job: Job = {
      key: request.key,
      url: request.url,
      state: "running",
      fraction: 0,
      controller: new AbortController(),
      task: Promise.resolve(),
      done: null,
      message: null,
    };
    this.running.set(job.key, job);
    job.task = this.run(job);
  }

  async stop(key: string): Promise<void> {
    const job = this.running.get(key);
    if (job == null) return;
    job.controller.abort();
    await job.task;
  }

  async discard(key: string): Promise<void> {
    await this.stop(key);
    const job = this.running.get(key);
    if (job?.done != null) this.options.objectUrls.revoke(job.done.url);
    this.running.delete(key);
    await (await this.parts()).remove(StreamHost.folderName(key));
  }

  release(key: string): Promise<void> {
    return this.discard(key);
  }

  async jobs(): Promise<StreamJobState[]> {
    return [...this.running.values()].map((j) => ({
      key: j.key,
      state: j.state,
      fraction: j.fraction,
      done: j.done,
      message: j.message,
    }));
  }

  /** Waits for every running job to end. For tests. */
  async idle(): Promise<void> {
    await Promise.all([...this.running.values()].map((j) => j.task));
  }

  private parts(): Promise<PartStore> {
    this.store ??= typeof this.options.parts === "function" ? this.options.parts() : Promise.resolve(this.options.parts);
    return this.store;
  }

  private async run(job: Job): Promise<void> {
    let lastReport = -Infinity;
    try {
      const folder = await (await this.parts()).folder(StreamHost.folderName(job.key), true);
      if (folder == null) throw new DownloadFailedError(DownloadErrors.couldNotSave("the browser's storage isn't available."));
      const outcome = await this.hls.download(job.url, folder, {
        signal: job.controller.signal,
        prepare: async (urls) => {
          try {
            await this.handler?.hosts(job.key, urls);
          } catch {
            // Without the page's headers some sites still answer; the requests will say if not.
          }
        },
        progress: (fraction) => {
          job.fraction = fraction;
          const now = Date.now();
          if (fraction < 1 && now - lastReport < this.progressInterval) return;
          lastReport = now;
          this.emit({ type: "progress", key: job.key, fraction });
        },
      });
      const file = await folder.file(outcome.file);
      if (file == null) throw new DownloadFailedError(DownloadErrors.couldNotSave("the joined file went missing."));
      if (job.controller.signal.aborted) throw new DOMException("Stopped", "AbortError");
      const url = await this.options.objectUrls.create(file);
      const done = {
        type: "done" as const,
        key: job.key,
        url,
        extension: outcome.extension,
        duration: outcome.duration,
        size: outcome.size,
      };
      job.state = "done";
      job.fraction = 1;
      job.done = done;
      this.emit(done);
    } catch (error) {
      const stopped = job.controller.signal.aborted;
      job.state = "failed";
      job.message = stopped ? DownloadErrors.stopped : DownloadErrors.describe(error);
      this.emit({ type: "failed", key: job.key, message: job.message, stopped });
    }
  }

  private emit(event: StreamEvent): void {
    try {
      this.handler?.event(event);
    } catch (error) {
      console.error(error);
    }
  }
}
