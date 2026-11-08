// Fakes for the downloads: a web server, the browser's network (which applies the extension's
// declarativeNetRequest session rules, as Chrome does to the extension's own requests),
// chrome.downloads, OPFS and object URLs. Ported from Cineon.Core.Tests/Downloads/DownloadFakes.cs.

import {
  type Database,
  type DownloadItem,
  EpisodeRef,
  LibraryStore,
  MediaSource,
  type MediaSourceKind,
  MemoryStorage,
} from "../../src/core/data";
import {
  type BrowserDownloadDelta,
  type BrowserDownloadItem,
  type BrowserDownloadOptions,
  type BrowserDownloadQuery,
  type BrowserDownloads,
  type DnrApi,
  type DnrRule,
  DnrHeaderRules,
  DownloadCenter,
  type DownloadHost,
  type DownloadTab,
  type FetchLike,
  type ObjectUrls,
  type OpfsDirectory,
  type OpfsFile,
  type OpfsWritable,
  type PageMethod,
  type PageTitle,
  PartStore,
  StreamHost,
  type StreamWorker,
} from "../../src/core/downloads";
import { freshDatabase } from "../data/helpers";

export const EXTENSION_ORIGIN = "chrome-extension://cineontest";

// MARK: The web

export interface FakeRequest {
  readonly url: string;
  readonly path: string;
  /** Lower-case names, after the extension's rules. */
  readonly headers: Readonly<Record<string, string>>;
  /** Who asked: the extension's fetch, or the browser's download manager. */
  readonly from: "fetch" | "download";
}

export interface FakeResponse {
  status: number;
  headers?: Record<string, string>;
  body?: Uint8Array;
  /** The connection drops after this many bytes of the body. */
  breakAfter?: number;
}

type Handler = (request: FakeRequest) => FakeResponse | Promise<FakeResponse>;

/** Routes by path, logs every request (with the headers it really carried), honours Range. */
export class FakeServer {
  readonly requests: FakeRequest[] = [];
  private readonly routes = new Map<string, Handler>();

  route(path: string, handler: Handler): void {
    this.routes.set(path, handler);
  }

  bytes(path: string, data: Uint8Array, type = "application/octet-stream"): void {
    this.route(path, (r) => FakeServer.serve(r, data, type));
  }

  text(path: string, text: string, type = "application/vnd.apple.mpegurl"): void {
    this.bytes(path, new TextEncoder().encode(text), type);
  }

  status(path: string, status: number): void {
    this.route(path, () => ({ status }));
  }

  count(path: string): number {
    return this.requests.filter((r) => r.path === path).length;
  }

  last(path: string): FakeRequest {
    const found = this.requests.filter((r) => r.path === path).pop();
    if (found == null) throw new Error(`Nothing asked for ${path}`);
    return found;
  }

  async respond(request: FakeRequest): Promise<FakeResponse> {
    this.requests.push(request);
    const handler = this.routes.get(request.path);
    if (handler == null) return { status: 404 };
    return handler(request);
  }

  /** The whole body, or the range asked for as a 206. */
  static serve(request: FakeRequest, data: Uint8Array, type = "application/octet-stream", breakAfter?: number): FakeResponse {
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
    if (range != null) {
      const from = Number(range[1]);
      if (from >= data.length) return { status: 416, headers: { "content-range": `bytes */${data.length}` } };
      const to = Math.min(range[2] ? Number(range[2]) : data.length - 1, data.length - 1);
      return {
        status: 206,
        headers: { "content-range": `bytes ${from}-${to}/${data.length}`, "content-type": type, "content-length": String(to - from + 1) },
        body: data.slice(from, to + 1),
      };
    }
    return { status: 200, headers: { "content-length": String(data.length), "content-type": type }, body: data, breakAfter };
  }

  static random(length: number, seed: number): Uint8Array {
    const out = new Uint8Array(length);
    let x = seed * 2654435761 + 1;
    for (let i = 0; i < length; i++) {
      x = (Math.imul(x ^ (x >>> 15), 2246822507) + i) >>> 0;
      x ^= x >>> 13;
      out[i] = x & 0xff;
    }
    return out;
  }

  static async encrypt(data: Uint8Array, key: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
    const subtle = globalThis.crypto.subtle;
    const k = await subtle.importKey("raw", key as Uint8Array<ArrayBuffer>, { name: "AES-CBC" }, false, ["encrypt"]);
    return new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv: iv as Uint8Array<ArrayBuffer> }, k, data as Uint8Array<ArrayBuffer>));
  }
}

/** The extension's session rules, applied as Chrome applies them to requests from no tab. */
export class FakeDnr implements DnrApi {
  rules: DnrRule[] = [];

  async updateSessionRules(options: { addRules?: DnrRule[]; removeRuleIds?: number[] }): Promise<void> {
    const remove = new Set(options.removeRuleIds ?? []);
    const kept = this.rules.filter((r) => !remove.has(r.id));
    for (const rule of options.addRules ?? []) {
      if (kept.some((r) => r.id === rule.id)) throw new Error(`Rule with id ${rule.id} already exists`);
      kept.push(structuredClone(rule));
    }
    this.rules = kept;
  }

  async getSessionRules(): Promise<DnrRule[]> {
    return structuredClone(this.rules);
  }

  apply(url: string, headers: Record<string, string>, tabId: number): Record<string, string> {
    const out = { ...headers };
    const matching = this.rules.filter((r) => matches(r, url, tabId)).sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1));
    const done = new Set<string>();
    for (const rule of matching) {
      for (const op of rule.action.requestHeaders) {
        if (done.has(op.header)) continue;
        done.add(op.header);
        if (op.operation === "set") out[op.header] = op.value!;
        else delete out[op.header];
      }
    }
    return out;
  }
}

function matches(rule: DnrRule, url: string, tabId: number): boolean {
  const c = rule.condition;
  if (c.tabIds != null && !c.tabIds.includes(tabId)) return false;
  const parsed = new URL(url);
  parsed.hash = "";
  if (c.urlFilter != null) {
    const pattern = c.urlFilter.replace(/^\|/, "^").replace(/\|$/, "$");
    const regex = new RegExp(pattern.replace(/[.+?()[\]{}\\/]/g, "\\$&").replaceAll("*", ".*"));
    if (!regex.test(parsed.href)) return false;
  }
  if (c.requestDomains != null) {
    const host = parsed.hostname;
    if (!c.requestDomains.some((d) => host === d || host.endsWith("." + d))) return false;
  }
  return true;
}

/** The browser's network for the extension: its fetch, and what chrome.downloads asks for. */
export class FakeNetwork {
  constructor(
    readonly server: FakeServer,
    readonly dnr: FakeDnr,
  ) {}

  /** The extension's fetch (from the service worker or the offscreen document: no tab). */
  readonly fetch: FetchLike = async (input, init) => {
    const signal = init?.signal ?? undefined;
    const given = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    // Chrome sends the extension's origin and no page as the referrer.
    const headers = this.dnr.apply(input, { origin: EXTENSION_ORIGIN, ...given }, -1);
    const response = await abortable(this.server.respond({ url: input, path: pathOf(input), headers, from: "fetch" }), signal);
    const body = response.body ?? new Uint8Array();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (response.breakAfter != null) {
          controller.enqueue(body.slice(0, response.breakAfter));
          controller.error(new TypeError("network error"));
          return;
        }
        if (body.length > 0) controller.enqueue(body);
        controller.close();
      },
    });
    return new Response(response.status === 204 ? null : stream, { status: response.status, headers: response.headers });
  };

  /** A request from chrome.downloads (no tab, no Origin). */
  /**
   * Whether the extension's session rules reach what chrome.downloads asks for. In Chrome they don't:
   * no declarativeNetRequest rule, whatever its condition, touches a downloads-API request (checked in
   * Chrome for Testing 156, end-to-end), and the API refuses a Referer header of its own. True here
   * models a browser where they do; the center's tests of the browser-download path (Firefox's) use it.
   */
  rulesReachDownloads = true;

  download(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<FakeResponse> {
    const sent = this.rulesReachDownloads ? this.dnr.apply(url, headers, -1) : { ...headers };
    return abortable(this.server.respond({ url, path: pathOf(url), headers: sent, from: "download" }), signal);
  }
}

function pathOf(url: string): string {
  return new URL(url).pathname;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal == null) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

// MARK: Object URLs

export class FakeObjectUrls implements ObjectUrls {
  readonly blobs = new Map<string, Blob>();
  readonly revoked: string[] = [];
  private counter = 0;

  async create(blob: Blob): Promise<string> {
    const url = `blob:${EXTENSION_ORIGIN}/${++this.counter}`;
    this.blobs.set(url, blob);
    return url;
  }

  revoke(url: string): void {
    this.blobs.delete(url);
    this.revoked.push(url);
  }
}

// MARK: chrome.downloads

interface Entry {
  id: number;
  url: string;
  filename: string;
  state: "in_progress" | "interrupted" | "complete";
  paused: boolean;
  canResume: boolean;
  error?: string;
  bytesReceived: number;
  totalBytes: number;
  data: Uint8Array;
  controller: AbortController | null;
}

/**
 * chrome.downloads as Chrome behaves: a download runs on its own; pause keeps what arrived and
 * resume asks for the rest with Range (starting again if the site sends everything); HTTP errors and
 * dropped connections interrupt with Chrome's reasons; `uniquify` makes "Name (1).mp4". The disk is
 * a map of paths under /Downloads.
 */
export class FakeBrowserDownloads implements BrowserDownloads {
  static readonly root = "/Downloads";
  readonly disk = new Map<string, Uint8Array>();
  /** Files deleted with removeFile, in order (the apps' "Recycled"). */
  readonly removed: string[] = [];
  readonly shown: (number | "folder")[] = [];
  readonly started: BrowserDownloadOptions[] = [];
  private readonly entries = new Map<number, Entry>();
  private readonly listeners = new Set<(delta: BrowserDownloadDelta) => void>();
  private nextId = 1;
  chunkSize = 64 * 1024;
  /** The next blob download is interrupted with this reason (a full disk, say). */
  failNextBlob: string | null = null;

  constructor(
    private readonly network: FakeNetwork,
    private readonly objectUrls: FakeObjectUrls,
  ) {}

  readonly onChanged = {
    addListener: (listener: (delta: BrowserDownloadDelta) => void) => void this.listeners.add(listener),
    removeListener: (listener: (delta: BrowserDownloadDelta) => void) => void this.listeners.delete(listener),
  };

  async download(options: BrowserDownloadOptions): Promise<number> {
    this.started.push(options);
    const relative = options.filename ?? new URL(options.url).pathname.split("/").pop() ?? "download";
    if (relative.startsWith("/") || relative.split(/[/\\]/).includes("..")) throw new Error("Invalid filename");
    let path = `${FakeBrowserDownloads.root}/${relative}`;
    if (options.conflictAction !== "overwrite") {
      const dot = path.lastIndexOf(".");
      const stem = dot > path.lastIndexOf("/") ? path.slice(0, dot) : path;
      const ext = dot > path.lastIndexOf("/") ? path.slice(dot) : "";
      for (let n = 1; this.taken(path); n++) path = `${stem} (${n})${ext}`;
    }
    const entry: Entry = {
      id: this.nextId++,
      url: options.url,
      filename: path,
      state: "in_progress",
      paused: false,
      canResume: false,
      bytesReceived: 0,
      totalBytes: 0,
      data: new Uint8Array(),
      controller: null,
    };
    this.entries.set(entry.id, entry);
    void this.transfer(entry);
    return entry.id;
  }

  async search(query: BrowserDownloadQuery): Promise<BrowserDownloadItem[]> {
    const regex = query.filenameRegex != null ? new RegExp(query.filenameRegex) : null;
    return [...this.entries.values()]
      .map((e) => this.view(e))
      .filter(
        (b) =>
          (query.id == null || b.id === query.id) &&
          (query.filename == null || b.filename === query.filename) &&
          (regex == null || regex.test(b.filename)) &&
          (query.exists == null || b.exists === query.exists) &&
          (query.state == null || b.state === query.state),
      );
  }

  async pause(id: number): Promise<void> {
    const e = this.require(id);
    if (e.state !== "in_progress") throw new Error("Download must be in progress");
    if (e.paused) return;
    e.paused = true;
    e.canResume = true;
    e.controller?.abort();
    this.emit({ id, paused: { current: true, previous: false } });
  }

  async resume(id: number): Promise<void> {
    const e = this.require(id);
    if (!(e.paused || (e.state === "interrupted" && e.canResume))) throw new Error("Download can't be resumed");
    const previous = e.state;
    e.paused = false;
    e.state = "in_progress";
    e.error = undefined;
    this.emit({ id, paused: { current: false, previous: true }, state: { current: "in_progress", previous } });
    void this.transfer(e);
  }

  async cancel(id: number): Promise<void> {
    const e = this.entries.get(id);
    if (e == null || e.state === "complete") return;
    e.controller?.abort();
    e.state = "interrupted";
    e.error = "USER_CANCELED";
    e.canResume = false;
    e.paused = false;
    e.data = new Uint8Array();
    this.emit({ id, state: { current: "interrupted", previous: "in_progress" }, error: { current: "USER_CANCELED" } });
  }

  async erase(query: { id: number }): Promise<number[]> {
    return this.entries.delete(query.id) ? [query.id] : [];
  }

  async removeFile(id: number): Promise<void> {
    const e = this.require(id);
    if (e.state !== "complete" || !this.disk.has(e.filename)) throw new Error("Download file doesn't exist");
    this.disk.delete(e.filename);
    this.removed.push(e.filename);
  }

  show(id: number): void {
    this.shown.push(id);
  }

  showDefaultFolder(): void {
    this.shown.push("folder");
  }

  file(path: string): Uint8Array | undefined {
    return this.disk.get(path);
  }

  private taken(path: string): boolean {
    return this.disk.has(path) || [...this.entries.values()].some((e) => e.filename === path && e.state !== "complete");
  }

  private view(e: Entry): BrowserDownloadItem {
    const exists = e.state === "complete" && this.disk.has(e.filename);
    return {
      id: e.id,
      url: e.url,
      filename: e.filename,
      state: e.state,
      paused: e.paused,
      canResume: e.canResume,
      error: e.error,
      bytesReceived: e.bytesReceived,
      totalBytes: e.totalBytes,
      fileSize: e.state === "complete" ? e.bytesReceived : 0,
      exists,
    };
  }

  private require(id: number): Entry {
    const e = this.entries.get(id);
    if (e == null) throw new Error(`Invalid download id ${id}`);
    return e;
  }

  private emit(delta: BrowserDownloadDelta): void {
    queueMicrotask(() => {
      for (const listener of [...this.listeners]) listener(delta);
    });
  }

  private interrupt(e: Entry, reason: string, canResume: boolean): void {
    e.state = "interrupted";
    e.error = reason;
    e.canResume = canResume;
    this.emit({ id: e.id, state: { current: "interrupted", previous: "in_progress" }, error: { current: reason } });
  }

  private complete(e: Entry): void {
    e.state = "complete";
    e.canResume = false;
    this.disk.set(e.filename, e.data);
    this.emit({ id: e.id, state: { current: "complete", previous: "in_progress" } });
  }

  private async transfer(e: Entry): Promise<void> {
    const controller = new AbortController();
    e.controller = controller;
    await Promise.resolve();
    if (e.url.startsWith("blob:")) {
      const failure = this.failNextBlob;
      if (failure != null) {
        this.failNextBlob = null;
        return this.interrupt(e, failure, false);
      }
      const blob = this.objectUrls.blobs.get(e.url);
      if (blob == null) return this.interrupt(e, "NETWORK_FAILED", false);
      e.data = new Uint8Array(await blob.arrayBuffer());
      e.bytesReceived = e.totalBytes = e.data.length;
      return this.complete(e);
    }
    if (e.url.startsWith("data:")) {
      const comma = e.url.indexOf(",");
      e.data = Uint8Array.from(atob(e.url.slice(comma + 1)), (c) => c.charCodeAt(0));
      e.bytesReceived = e.totalBytes = e.data.length;
      return this.complete(e);
    }
    const from = e.bytesReceived;
    const headers: Record<string, string> = {};
    if (from > 0) headers.range = `bytes=${from}-`;
    let response: FakeResponse;
    try {
      response = await this.network.download(e.url, headers, controller.signal);
    } catch {
      if (controller.signal.aborted) return;
      return this.interrupt(e, "NETWORK_FAILED", true);
    }
    if (controller.signal.aborted) return;
    const status = response.status;
    if (status === 416 && from > 0 && response.headers?.["content-range"] === `bytes */${from}`) return this.complete(e);
    if (status >= 400) {
      const reason =
        status === 401 ? "SERVER_UNAUTHORIZED" : status === 403 ? "SERVER_FORBIDDEN" : status === 404 || status === 410 ? "SERVER_BAD_CONTENT" : "SERVER_FAILED";
      return this.interrupt(e, reason, false);
    }
    const contentRange = /^bytes (\d+)-\d+\/(\d+)$/.exec(response.headers?.["content-range"] ?? "");
    const append = status === 206 && contentRange != null && Number(contentRange[1]) === from;
    if (!append) {
      e.data = new Uint8Array();
      e.bytesReceived = 0;
    }
    const length = Number(response.headers?.["content-length"] ?? NaN);
    e.totalBytes = contentRange != null ? Number(contentRange[2]) : Number.isFinite(length) ? length : 0;
    const body = response.body ?? new Uint8Array();
    const limit = response.breakAfter ?? body.length;
    for (let at = 0; at < limit; at += this.chunkSize) {
      await new Promise((r) => setTimeout(r, 0));
      if (controller.signal.aborted) return;
      const chunk = body.slice(at, Math.min(limit, at + this.chunkSize));
      const joined = new Uint8Array(e.data.length + chunk.length);
      joined.set(e.data);
      joined.set(chunk, e.data.length);
      e.data = joined;
      e.bytesReceived = joined.length;
    }
    if (response.breakAfter != null) return this.interrupt(e, "NETWORK_FAILED", true);
    this.complete(e);
  }
}

// MARK: OPFS

type Node = { kind: "file"; data: Uint8Array } | { kind: "directory"; dir: FakeOpfsDirectory };

function notFound(name: string): DOMException {
  return new DOMException(`${name} not found`, "NotFoundError");
}

/** An in-memory OPFS directory: writes land on close(), like the real one. */
export class FakeOpfsDirectory implements OpfsDirectory {
  readonly children = new Map<string, Node>();

  constructor(readonly name: string) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectory> {
    const node = this.children.get(name);
    if (node?.kind === "directory") return node.dir;
    if (node != null) throw new DOMException("Not a directory", "TypeMismatchError");
    if (!options?.create) throw notFound(name);
    const dir = new FakeOpfsDirectory(name);
    this.children.set(name, { kind: "directory", dir });
    return dir;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFile> {
    const node = this.children.get(name);
    if (node?.kind === "directory") throw new DOMException("Not a file", "TypeMismatchError");
    if (node == null) {
      if (!options?.create) throw notFound(name);
      this.children.set(name, { kind: "file", data: new Uint8Array() });
    }
    return this.fileHandle(name);
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    const node = this.children.get(name);
    if (node == null) throw notFound(name);
    if (node.kind === "directory" && node.dir.children.size > 0 && !options?.recursive) {
      throw new DOMException("Not empty", "InvalidModificationError");
    }
    this.children.delete(name);
  }

  async *keys(): AsyncIterable<string> {
    for (const name of [...this.children.keys()]) yield name;
  }

  /** The directory at a path of names, or null. */
  at(...names: string[]): FakeOpfsDirectory | null {
    let dir: FakeOpfsDirectory = this;
    for (const name of names) {
      const node = dir.children.get(name);
      if (node?.kind !== "directory") return null;
      dir = node.dir;
    }
    return dir;
  }

  fileNames(): string[] {
    return [...this.children].filter(([, n]) => n.kind === "file").map(([name]) => name).sort();
  }

  private fileHandle(name: string): OpfsFile {
    const dir = this;
    return {
      async getFile() {
        const node = dir.children.get(name);
        if (node?.kind !== "file") throw notFound(name);
        return new File([node.data as Uint8Array<ArrayBuffer>], name);
      },
      async createWritable(options) {
        const node = dir.children.get(name);
        if (node?.kind !== "file") throw notFound(name);
        let parts: Uint8Array[] = options?.keepExistingData ? [node.data] : [];
        let open = true;
        const writable: OpfsWritable = {
          async write(data) {
            if (!open) throw new TypeError("closed");
            if (typeof data === "string") parts.push(new TextEncoder().encode(data));
            else if (data instanceof Uint8Array) parts.push(data.slice());
            else parts.push(new Uint8Array(await data.arrayBuffer()));
          },
          async close() {
            open = false;
            const total = parts.reduce((n, p) => n + p.length, 0);
            const out = new Uint8Array(total);
            let at = 0;
            for (const p of parts) {
              out.set(p, at);
              at += p.length;
            }
            const current = dir.children.get(name);
            if (current?.kind === "file") current.data = out;
          },
          async abort() {
            open = false;
            parts = [];
          },
        };
        return writable;
      },
    };
  }
}

// MARK: The extension around the center

export class FakeHost implements DownloadHost {
  readonly toasts: string[] = [];
  readonly actions: { message: string; title: string | undefined; action: (() => void) | undefined }[] = [];
  readonly played: DownloadItem[] = [];
  readonly enriched: { id: number; altName: string | null }[] = [];
  pillRefreshes = 0;
  duration: number | null = null;

  showToast(message: string, actionTitle?: string, action?: () => void): void {
    this.toasts.push(message);
    this.actions.push({ message, title: actionTitle, action });
  }

  playDownload(item: DownloadItem): void {
    this.played.push(item);
  }

  refreshDownloadPills(): void {
    this.pillRefreshes++;
  }

  enrichTitle(id: number, altName: string | null): void {
    this.enriched.push({ id, altName });
  }

  async mediaDuration(): Promise<number | null> {
    return this.duration;
  }
}

export class FakeTab implements DownloadTab {
  url: string | null = null;
  displayTitle = "Tab";
  linkedTitleId: number | null = null;
  trackRef: EpisodeRef | null = null;
  parsed: PageTitle | null = null;
  readonly sourceList: MediaSource[] = [];
  sourcesFrameUrl: string | null = null;
  mediaDuration = 0;
  page: (method: PageMethod, args: (number | boolean)[]) => unknown = () => null;
  readonly calls: string[] = [];

  constructor(fields: Partial<Omit<FakeTab, "sourceList" | "calls">> = {}) {
    Object.assign(this, fields);
  }

  get sources(): readonly MediaSource[] {
    return this.sourceList;
  }

  get bestSource(): MediaSource | null {
    return MediaSource.best(this.sourceList, null);
  }

  async callPage(method: PageMethod, ...args: (number | boolean)[]): Promise<unknown> {
    this.calls.push(`${method}(${args.join(",")})`);
    return this.page(method, args);
  }
}

// MARK: A profile with everything wired to fakes

export function source(url: string, kind: MediaSourceKind = "file"): MediaSource {
  return { url, kind, foundAt: 1, isCurrent: true };
}

export async function until(condition: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition never held");
    await new Promise((r) => setTimeout(r, 5));
  }
}

export class DownloadRig {
  readonly server = new FakeServer();
  readonly dnr = new FakeDnr();
  readonly network = new FakeNetwork(this.server, this.dnr);
  readonly objectUrls = new FakeObjectUrls();
  readonly browser = new FakeBrowserDownloads(this.network, this.objectUrls);
  readonly opfs = new FakeOpfsDirectory("");
  readonly host = new FakeHost();
  readonly storage = new MemoryStorage();
  readonly session = new MemoryStorage();
  readonly headers = new DnrHeaderRules(this.dnr, { storage: this.session });
  readonly streams = new StreamHost({
    parts: async () => PartStore.open({ getDirectory: async () => this.opfs } as unknown as StorageManager),
    fetch: this.network.fetch,
    objectUrls: this.objectUrls,
    subtle: globalThis.crypto.subtle,
    progressInterval: 0,
  });
  db!: Database;
  library!: LibraryStore;
  center!: DownloadCenter;
  private readonly centers: DownloadCenter[] = [];

  /** Chrome: its downloads never get the session rules, so the center fetches direct files itself. */
  chrome = false;

  static async make(options: { session?: boolean; chrome?: boolean } = {}): Promise<DownloadRig> {
    const rig = new DownloadRig();
    rig.chrome = options.chrome ?? false;
    rig.network.rulesReachDownloads = !rig.chrome;
    rig.db = await freshDatabase();
    rig.library = await LibraryStore.open(rig.db);
    rig.streams.hls.retryDelay = 1;
    rig.center = await rig.open(options);
    return rig;
  }

  /** A center over this profile, as the extension would make one. */
  async open(options: { session?: boolean; streams?: StreamWorker } = {}): Promise<DownloadCenter> {
    const center = await DownloadCenter.open({
      db: this.db,
      library: this.library,
      host: this.host,
      downloads: this.browser,
      headers: this.headers,
      streams: options.streams ?? this.streams,
      storage: this.storage,
      session: options.session ? this.session : undefined,
      fetch: this.network.fetch,
      objectUrls: this.objectUrls,
      fetchFiles: this.chrome,
    });
    center.pollInterval = 20;
    this.centers.push(center);
    return center;
  }

  enqueue(
    url: string,
    options: {
      name?: string;
      ref?: EpisodeRef;
      kind?: MediaSourceKind;
      referer?: string | null;
      subtitles?: string[];
      titleId?: number | null;
    } = {},
  ): Promise<DownloadItem> {
    return this.center
      .enqueue({
        source: source(url, options.kind ?? "file"),
        titleId: options.titleId ?? null,
        ref: options.ref ?? EpisodeRef.none,
        name: options.name ?? "Arrival",
        pageUrl: "https://site.test/film/arrival",
        referer: options.referer === undefined ? "https://site.test/film/arrival" : options.referer,
        duration: 0,
        posterUrl: null,
        subtitles: options.subtitles ?? [],
      })
      .then((item) => item!);
  }

  /** Where a finished download lands. */
  static path(name: string): string {
    return `${FakeBrowserDownloads.root}/${DownloadCenter.folderName}/${name}`;
  }

  async dispose(): Promise<void> {
    for (const center of this.centers) center.suspendAll();
    await this.streams.idle();
    for (const center of this.centers) await center.idle();
    this.db.close();
  }
}
