// The browser APIs the downloads use, as small interfaces so the logic runs on Node with fakes,
// and their real implementations over chrome.* (Chrome, Edge and Firefox's `chrome` alias).

import { DomainName, type KeyValueStorage } from "../data";

// MARK: chrome.downloads

export type BrowserDownloadState = "in_progress" | "interrupted" | "complete";

/** What `chrome.downloads.search` gives for one download (the fields used here). */
export interface BrowserDownloadItem {
  readonly id: number;
  readonly url: string;
  readonly finalUrl?: string;
  /** Absolute path, decided once the response starts; "" before. */
  readonly filename: string;
  readonly state: BrowserDownloadState;
  readonly paused: boolean;
  readonly canResume: boolean;
  /** `InterruptReason` when interrupted. */
  readonly error?: string;
  readonly bytesReceived: number;
  /** 0 when unknown. */
  readonly totalBytes: number;
  /** 0 when unknown. */
  readonly fileSize: number;
  readonly exists: boolean;
  readonly mime?: string;
}

export interface BrowserDownloadQuery {
  id?: number;
  /** Exact absolute path. */
  filename?: string;
  /** RE2 in Chrome, JS RegExp in Firefox; keep to the common subset. */
  filenameRegex?: string;
  exists?: boolean;
  state?: BrowserDownloadState;
  limit?: number;
}

export interface BrowserDownloadDelta {
  readonly id: number;
  readonly state?: { readonly current?: string; readonly previous?: string };
  readonly paused?: { readonly current?: boolean; readonly previous?: boolean };
  readonly error?: { readonly current?: string; readonly previous?: string };
  readonly filename?: { readonly current?: string; readonly previous?: string };
}

export interface BrowserDownloadOptions {
  url: string;
  /** Relative to the browser's downloads folder: `Cineon/Arrival.mp4`. */
  filename?: string;
  conflictAction?: "uniquify" | "overwrite" | "prompt";
  saveAs?: boolean;
}

/** The part of `chrome.downloads` the center uses, promise-style. */
export interface BrowserDownloads {
  download(options: BrowserDownloadOptions): Promise<number>;
  search(query: BrowserDownloadQuery): Promise<BrowserDownloadItem[]>;
  pause(id: number): Promise<void>;
  resume(id: number): Promise<void>;
  cancel(id: number): Promise<void>;
  /** Forgets the entry in the browser's list (the file stays). */
  erase(query: { id: number }): Promise<number[]>;
  /** Deletes a finished download's file for good. There is no Bin. */
  removeFile(id: number): Promise<void>;
  show(id: number): void;
  showDefaultFolder(): void;
  open?(id: number): Promise<void> | void;
  readonly onChanged: {
    addListener(listener: (delta: BrowserDownloadDelta) => void): void;
    removeListener(listener: (delta: BrowserDownloadDelta) => void): void;
  };
}

/**
 * `chrome.downloads` as BrowserDownloads. Call it at the top level of the service worker, before any
 * await: it registers its `onChanged` listener at once, so a download that finishes while the worker
 * sleeps wakes it, and holds the changes until the center (opened after awaits) listens.
 */
export function chromeDownloads(api: typeof chrome.downloads = globalThis.chrome.downloads): BrowserDownloads {
  const a = api as unknown as Record<string, (...args: unknown[]) => unknown>;
  const listeners = new Set<(delta: BrowserDownloadDelta) => void>();
  const held: BrowserDownloadDelta[] = [];
  (api.onChanged as unknown as BrowserDownloads["onChanged"]).addListener((delta) => {
    if (listeners.size === 0) {
      held.push(delta);
      if (held.length > 500) held.shift();
      return;
    }
    for (const listener of [...listeners]) listener(delta);
  });
  return {
    download: (options) => a.download!(options) as Promise<number>,
    search: (query) => a.search!(query) as Promise<BrowserDownloadItem[]>,
    pause: (id) => a.pause!(id) as Promise<void>,
    resume: (id) => a.resume!(id) as Promise<void>,
    cancel: (id) => a.cancel!(id) as Promise<void>,
    erase: (query) => a.erase!(query) as Promise<number[]>,
    removeFile: (id) => a.removeFile!(id) as Promise<void>,
    show: (id) => {
      a.show!(id);
    },
    showDefaultFolder: () => {
      a.showDefaultFolder!();
    },
    open: (id) => a.open!(id) as Promise<void> | void,
    onChanged: {
      addListener(listener) {
        listeners.add(listener);
        for (const delta of held.splice(0)) listener(delta);
      },
      removeListener(listener) {
        listeners.delete(listener);
      },
    },
  };
}

// MARK: Referer and Origin

/** What a site saw with the player's own requests. Null removes the header. */
export interface PageHeaders {
  readonly referer: string | null;
  readonly origin: string | null;
}

/** Which of the extension's own requests get the page's headers. */
export interface HeaderTarget {
  /** Exact addresses (the fragment is ignored). */
  readonly urls?: readonly string[];
  /** Registrable domains (`cdn.example.com` → `example.com`); their subdomains match too. */
  readonly sites?: readonly string[];
}

/**
 * Referer and Origin are forbidden headers for fetch and chrome.downloads, so the page's are set on
 * the extension's own requests by declarativeNetRequest session rules, only while a download needs
 * them. Each `key` (one download, one subtitle fetch) owns its rules.
 */
export interface HeaderRules {
  /** Adds to what `key` covers. The latest `headers` win. */
  add(key: string, target: HeaderTarget, headers: PageHeaders): Promise<void>;
  remove(key: string): Promise<void>;
  /**
   * For a fresh start: removes every rule but those of `keys`. With `scope`, only keys containing it
   * are considered (one profile's), and everything else is left alone.
   */
  retainOnly(keys: readonly string[], scope?: string): Promise<void>;
}

/** The part of a declarativeNetRequest rule used here (structurally `chrome.declarativeNetRequest.Rule`). */
export interface DnrRule {
  id: number;
  priority?: number;
  action: {
    type: "modifyHeaders";
    requestHeaders: { header: string; operation: "set" | "remove"; value?: string }[];
  };
  condition: {
    urlFilter?: string;
    requestDomains?: string[];
    tabIds?: number[];
  };
}

/** The part of `chrome.declarativeNetRequest` used here. */
export interface DnrApi {
  updateSessionRules(options: { addRules?: DnrRule[]; removeRuleIds?: number[] }): Promise<void>;
  getSessionRules(): Promise<{ id: number }[]>;
}

interface RuleEntry {
  ids: number[];
  urls: string[];
  sites: string[];
  headers: PageHeaders;
}

/** Requests that come from no tab: the service worker, the offscreen document, chrome.downloads. */
const TAB_ID_NONE = -1;

/**
 * HeaderRules over declarativeNetRequest session rules. Rule IDs come from a range of their own
 * (`firstId`, `size`; default 1,000,000–1,009,999): no other part of the extension may use session
 * rules in it. With `storage` (chrome.storage.session) the key → rules map survives the service
 * worker stopping; session rules themselves last until the browser closes.
 *
 * Each key gets one rule per exact address (priority 2) and one for all its sites (priority 1), all
 * limited to tab-less requests, so the player's own requests in tabs are never touched.
 */
export class DnrHeaderRules implements HeaderRules {
  static readonly defaultFirstId = 1_000_000;
  static readonly defaultSize = 10_000;
  static readonly storageKey = "cineon.downloadHeaderRules";

  private entries: Map<string, RuleEntry> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly firstId: number;
  private readonly size: number;

  constructor(
    private readonly dnr: DnrApi = globalThis.chrome.declarativeNetRequest as unknown as DnrApi,
    private readonly options: { storage?: KeyValueStorage; storageKey?: string; firstId?: number; size?: number } = {},
  ) {
    this.firstId = options.firstId ?? DnrHeaderRules.defaultFirstId;
    this.size = options.size ?? DnrHeaderRules.defaultSize;
  }

  add(key: string, target: HeaderTarget, headers: PageHeaders): Promise<void> {
    return this.serial(async (entries) => {
      const old = entries.get(key);
      const urls = union(old?.urls ?? [], (target.urls ?? []).map(urlFilterText).filter((u): u is string => u != null));
      const sites = union(old?.sites ?? [], (target.sites ?? []).map((s) => DomainName.registrable(s)).filter((s) => s.length > 0));
      const unchanged =
        old != null && old.urls.length === urls.length && old.sites.length === sites.length && sameHeaders(old.headers, headers);
      if (unchanged) return;
      const used = new Set((await this.dnr.getSessionRules()).map((r) => r.id));
      for (const id of old?.ids ?? []) used.delete(id);
      const count = urls.length + (sites.length > 0 ? 1 : 0);
      const ids: number[] = [];
      for (let id = this.firstId; id < this.firstId + this.size && ids.length < count; id++) {
        if (!used.has(id)) ids.push(id);
      }
      if (ids.length < count) throw new Error("No room for more download header rules");
      const requestHeaders = headerOps(headers);
      const rules: DnrRule[] = urls.map((url, i) => ({
        id: ids[i]!,
        priority: 2,
        action: { type: "modifyHeaders", requestHeaders },
        condition: { urlFilter: `|${url}|`, tabIds: [TAB_ID_NONE] },
      }));
      if (sites.length > 0) {
        rules.push({
          id: ids[urls.length]!,
          priority: 1,
          action: { type: "modifyHeaders", requestHeaders },
          condition: { requestDomains: sites, tabIds: [TAB_ID_NONE] },
        });
      }
      await this.dnr.updateSessionRules({ removeRuleIds: old?.ids ?? [], addRules: rules });
      entries.set(key, { ids, urls, sites, headers });
      return true;
    });
  }

  remove(key: string): Promise<void> {
    return this.serial(async (entries) => {
      const old = entries.get(key);
      if (old == null) return;
      await this.dnr.updateSessionRules({ removeRuleIds: old.ids });
      entries.delete(key);
      return true;
    });
  }

  retainOnly(keys: readonly string[], scope?: string): Promise<void> {
    return this.serial(async (entries) => {
      const gone = [...entries.keys()].filter((key) => !keys.includes(key) && (scope == null || key.includes(scope)));
      let remove: number[];
      if (scope != null) {
        remove = gone.flatMap((key) => entries.get(key)!.ids);
      } else {
        const keep = new Set<number>();
        for (const key of keys) for (const id of entries.get(key)?.ids ?? []) keep.add(id);
        remove = (await this.dnr.getSessionRules())
          .map((r) => r.id)
          .filter((id) => id >= this.firstId && id < this.firstId + this.size && !keep.has(id));
      }
      if (remove.length > 0) await this.dnr.updateSessionRules({ removeRuleIds: remove });
      for (const key of gone) entries.delete(key);
      return true;
    });
  }

  /** One change at a time: rule IDs are picked from what's in use. Saves the map after a change. */
  private serial(body: (entries: Map<string, RuleEntry>) => Promise<boolean | void>): Promise<void> {
    const run = this.queue.then(async () => {
      const entries = await this.load();
      if ((await body(entries)) === true) await this.save(entries);
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private async load(): Promise<Map<string, RuleEntry>> {
    if (this.entries != null) return this.entries;
    const entries = new Map<string, RuleEntry>();
    const stored = await this.options.storage?.get(this.options.storageKey ?? DnrHeaderRules.storageKey).catch(() => null);
    if (stored != null && typeof stored === "object") {
      for (const [key, value] of Object.entries(stored as Record<string, RuleEntry>)) {
        if (Array.isArray(value?.ids)) entries.set(key, value);
      }
    }
    this.entries = entries;
    return entries;
  }

  private async save(entries: Map<string, RuleEntry>): Promise<void> {
    await this.options.storage?.set(this.options.storageKey ?? DnrHeaderRules.storageKey, Object.fromEntries(entries)).catch(() => {});
  }
}

/** The `Referer` and `Origin` a request from the page's player carried, as the apps send them. */
export function pageHeaders(referer: string | null, sourceUrl: string): PageHeaders {
  if (referer == null || referer.length === 0) return { referer: null, origin: null };
  let origin: string | null = null;
  try {
    const page = new URL(referer);
    const source = hostOf(sourceUrl);
    if (page.hostname.length > 0 && !DomainName.isSameSite(page.hostname, source)) {
      origin = `${page.protocol}//${page.host}`;
    }
  } catch {
    // Not an address: the Referer goes as it is, without an Origin.
  }
  return { referer, origin };
}

/** The host of an address (lower-cased, IDN as punycode), or null. */
export function hostOf(url: string | null | undefined): string | null {
  if (url == null) return null;
  try {
    const host = new URL(url).hostname;
    return host.length > 0 ? host.replace(/^\[|\]$/g, "") : null;
  } catch {
    return null;
  }
}

function headerOps(headers: PageHeaders): DnrRule["action"]["requestHeaders"] {
  return [
    headers.referer != null
      ? { header: "referer", operation: "set", value: headers.referer }
      : { header: "referer", operation: "remove" },
    headers.origin != null
      ? { header: "origin", operation: "set", value: headers.origin }
      : { header: "origin", operation: "remove" },
  ];
}

/** The address as a urlFilter matches it: canonical, ASCII, no fragment, no `|` inside. */
function urlFilterText(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href.replaceAll("|", "*");
  } catch {
    return null;
  }
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

function sameHeaders(a: PageHeaders, b: PageHeaders): boolean {
  return a.referer === b.referer && a.origin === b.origin;
}

// MARK: Object URLs

/** Addresses chrome.downloads can save bytes from. */
export interface ObjectUrls {
  create(blob: Blob): Promise<string>;
  revoke(url: string): void;
}

export const ObjectUrls = {
  /**
   * `URL.createObjectURL` where there is one (a document: Firefox's background page, the offscreen
   * document), else a `data:` URL (Chrome's service worker has no object URLs; fine for subtitles,
   * not for films). Firefox refuses `data:` URLs in downloads.download.
   */
  browser(): ObjectUrls {
    if (typeof URL.createObjectURL === "function") {
      return {
        create: async (blob) => URL.createObjectURL(blob),
        revoke: (url) => URL.revokeObjectURL(url),
      };
    }
    return ObjectUrls.data();
  },

  data(): ObjectUrls {
    return {
      async create(blob) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
      },
      revoke() {},
    };
  },
};
