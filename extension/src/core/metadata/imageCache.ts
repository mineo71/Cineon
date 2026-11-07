// Remote images as bytes, cached in memory and in the Cache Storage API ("cineon-images"), like the
// Mac's URLCache under ImageCache (400 MB on disk, 8 MB in memory), and decoded images at display
// size kept in memory (200 MB of pixels, like the Mac's NSCache). Port of Core/Images.swift by way of
// windows/Cineon.Core/Metadata/ImageCache.cs. Decoding is the page's job (createImageBitmap or an
// <img>), passed in to ImagePipeline.

import type { Fetch } from "./metadataClient";

const MB = 1024 * 1024;

/** A memory cache with a total cost, dropping the least recently used entries when it's over. */
export class CostCache<K, V> {
  private readonly entries = new Map<K, { value: V; cost: number }>();
  private total = 0;

  constructor(private readonly costLimit: number) {}

  get totalCost(): number {
    return this.total;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    // Most recently used last.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** `maxCostFraction`: entries costing more than this share of the limit aren't kept. */
  set(key: K, value: V, cost: number, maxCostFraction = 1): void {
    const old = this.entries.get(key);
    if (old !== undefined) {
      this.entries.delete(key);
      this.total -= old.cost;
    }
    if (cost > this.costLimit * maxCostFraction) return;
    this.entries.set(key, { value, cost });
    this.total += cost;
    for (const [oldest, entry] of this.entries) {
      if (this.total <= this.costLimit) break;
      this.entries.delete(oldest);
      this.total -= entry.cost;
    }
  }
}

export interface ImageCacheOptions {
  /** Where requests go. The global `fetch` when left out. */
  fetch?: Fetch;
  /** The Cache Storage to keep bytes in: the global `caches` when left out, null for memory only. */
  caches?: CacheStorage | null;
  /** "cineon-images". */
  cacheName?: string;
  /** 400 MB, as on the Mac. */
  diskCapacity?: number;
  /** 8 MB, as on the Mac. */
  memoryCapacity?: number;
  /** The whole request, in milliseconds. 15 seconds, as on the Mac. */
  timeoutMs?: number;
  /** The clock, for least-recently-used order. */
  now?: () => number;
}

/** Entries live under made-up addresses, named by the SHA-256 of the image's address, as on Windows. */
const ENTRY_ORIGIN = "https://cineon-images.invalid/";
const INDEX_URL = ENTRY_ORIGIN + "index.json";
const ENTRY_NAME = /^[0-9a-f]{64}$/;

interface IndexEntry {
  size: number;
  used: number;
}

const globalFetch: Fetch = (input, init) => fetch(input, init);

function sha256Hex(text: string): Promise<string> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then((digest) =>
    Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""),
  );
}

function noStore(response: Response): boolean {
  const control = response.headers.get("cache-control");
  return control !== null && control.split(",").some((part) => part.trim().toLowerCase() === "no-store");
}

/**
 * Remote images as bytes, from memory, Cache Storage or the network, in that order. A cached copy is
 * used however old it is, as with `.returnCacheDataElseLoad`. Kept on disk: 200 responses without
 * `no-store`, up to 5% of the capacity each; over capacity, the least recently used go until it's
 * back under 90%.
 */
export class ImageCache {
  static readonly defaultDiskCapacity = 400 * MB;
  static readonly defaultMemoryCapacity = 8 * MB;

  private static sharedCache: ImageCache | null = null;

  /** The extension's cache. */
  static get shared(): ImageCache {
    return (ImageCache.sharedCache ??= new ImageCache());
  }

  private readonly http: Fetch;
  private readonly storage: CacheStorage | null;
  private readonly cacheName: string;
  private readonly diskCapacity: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly memory: CostCache<string, Uint8Array>;
  private readonly running = new Map<string, Promise<Uint8Array | null>>();
  private index: Promise<Map<string, IndexEntry>> | null = null;
  private diskSizeValue = 0;
  /** Disk changes happen one at a time. */
  private diskQueue: Promise<unknown> = Promise.resolve();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ImageCacheOptions = {}) {
    this.http = options.fetch ?? globalFetch;
    this.storage = options.caches === undefined ? (globalThis.caches ?? null) : options.caches;
    this.cacheName = options.cacheName ?? "cineon-images";
    this.diskCapacity = options.diskCapacity ?? ImageCache.defaultDiskCapacity;
    this.memory = new CostCache(options.memoryCapacity ?? ImageCache.defaultMemoryCapacity);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.now = options.now ?? Date.now;
  }

  /** The memory key for an address: the address itself. */
  static key(url: string): string {
    return url;
  }

  /** The Cache Storage address an image's bytes are kept under. */
  static async entryUrl(url: string): Promise<string> {
    return ENTRY_ORIGIN + (await sha256Hex(ImageCache.key(url)));
  }

  /** The image's bytes if they're in memory right now. Never touches the disk or the network. */
  cached(url: string): Uint8Array | null {
    return this.memory.get(ImageCache.key(url)) ?? null;
  }

  /**
   * The image's bytes from memory, disk or the network, in that order. The same address asked for
   * twice at once is fetched once. Null when it can't be fetched, or isn't an absolute http(s)
   * address. Like the Mac, a response that isn't 200 still returns its body (it just isn't kept), and
   * decoding it is what fails.
   */
  data(url: string): Promise<Uint8Array | null> {
    const key = ImageCache.key(url);
    const hit = this.memory.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const running = this.running.get(key);
    if (running !== undefined) return running;
    const task = this.load(url, key).finally(() => this.running.delete(key));
    this.running.set(key, task);
    return task;
  }

  /** Bytes in Cache Storage, counting only this cache's own entries. */
  async diskSize(): Promise<number> {
    await this.loadIndex();
    await this.diskQueue;
    return this.diskSizeValue;
  }

  private async load(url: string, key: string): Promise<Uint8Array | null> {
    if (!/^https?:\/\//i.test(url)) return null;
    const data = (await this.readFromDisk(key)) ?? (await this.download(url, key));
    if (data !== null) this.memory.set(key, data, data.byteLength, 0.05);
    return data;
  }

  private async download(url: string, key: string): Promise<Uint8Array | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.http(url, { signal: controller.signal });
      const data = new Uint8Array(await response.arrayBuffer());
      if (response.status === 200 && !noStore(response) && data.byteLength <= this.diskCapacity / 20) {
        await this.writeToDisk(key, data, response.headers.get("content-type"));
      }
      return data;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // MARK: Disk

  private async open(): Promise<Cache | null> {
    if (this.storage === null) return null;
    try {
      return await this.storage.open(this.cacheName);
    } catch {
      return null;
    }
  }

  /** Reads what's stored once, so sizes and ages are known without listing it again. */
  private loadIndex(): Promise<Map<string, IndexEntry>> {
    return (this.index ??= (async () => {
      const index = new Map<string, IndexEntry>();
      this.diskSizeValue = 0;
      const cache = await this.open();
      if (cache === null) return index;
      try {
        let saved: Record<string, [number, number]> = {};
        const stored = await cache.match(INDEX_URL);
        if (stored) saved = (await stored.json()) as Record<string, [number, number]>;
        for (const request of await cache.keys()) {
          const name = request.url.startsWith(ENTRY_ORIGIN) ? request.url.slice(ENTRY_ORIGIN.length) : "";
          if (!ENTRY_NAME.test(name)) continue;
          let entry: IndexEntry | null = null;
          const known = saved[name];
          if (Array.isArray(known) && typeof known[0] === "number" && typeof known[1] === "number") {
            entry = { size: known[0], used: known[1] };
          } else {
            const response = await cache.match(request);
            const size = Number(response?.headers.get("x-cineon-size"));
            const used = Number(response?.headers.get("x-cineon-stored"));
            if (Number.isFinite(size)) entry = { size, used: Number.isFinite(used) ? used : 0 };
          }
          if (entry === null) continue;
          index.set(name, entry);
          this.diskSizeValue += entry.size;
        }
      } catch {
        // An unreadable cache is an empty one.
      }
      return index;
    })());
  }

  private async readFromDisk(key: string): Promise<Uint8Array | null> {
    const index = await this.loadIndex();
    const name = await sha256Hex(key);
    const entry = index.get(name);
    if (entry === undefined) return null;
    try {
      const cache = await this.open();
      const response = await cache?.match(ENTRY_ORIGIN + name);
      if (!response) throw new Error("Gone");
      const data = new Uint8Array(await response.arrayBuffer());
      entry.used = this.now();
      this.scheduleSave();
      return data;
    } catch {
      if (index.delete(name)) this.diskSizeValue -= entry.size;
      return null;
    }
  }

  private writeToDisk(key: string, data: Uint8Array<ArrayBuffer>, contentType: string | null): Promise<void> {
    const write = this.diskQueue.then(async () => {
      const index = await this.loadIndex();
      const cache = await this.open();
      if (cache === null) return;
      const name = await sha256Hex(key);
      const now = this.now();
      try {
        const headers: Record<string, string> = { "x-cineon-size": String(data.byteLength), "x-cineon-stored": String(now) };
        if (contentType) headers["content-type"] = contentType;
        await cache.put(ENTRY_ORIGIN + name, new Response(data, { headers }));
      } catch {
        return;
      }
      const old = index.get(name);
      if (old !== undefined) this.diskSizeValue -= old.size;
      index.set(name, { size: data.byteLength, used: now });
      this.diskSizeValue += data.byteLength;
      await this.trim(cache, index);
      await this.saveIndex(cache, index);
    });
    this.diskQueue = write.catch(() => {});
    return write.catch(() => {});
  }

  /** Over capacity, the least recently used entries go until it's back under 90%. */
  private async trim(cache: Cache, index: Map<string, IndexEntry>): Promise<void> {
    if (this.diskSizeValue <= this.diskCapacity) return;
    const oldestFirst = [...index.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [name, entry] of oldestFirst) {
      if (this.diskSizeValue <= (this.diskCapacity * 9) / 10) break;
      try {
        await cache.delete(ENTRY_ORIGIN + name);
      } catch {
        continue;
      }
      index.delete(name);
      this.diskSizeValue -= entry.size;
    }
  }

  private async saveIndex(cache: Cache, index: Map<string, IndexEntry>): Promise<void> {
    const saved: Record<string, [number, number]> = {};
    for (const [name, entry] of index) saved[name] = [entry.size, entry.used];
    try {
      await cache.put(INDEX_URL, new Response(JSON.stringify(saved), { headers: { "content-type": "application/json" } }));
    } catch {
      // The next save will try again; meanwhile entries fall back to when they were stored.
    }
  }

  /** Reads change only the order of use, so they're saved a little later, together. */
  private scheduleSave(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.diskQueue = this.diskQueue.then(async () => {
        const cache = await this.open();
        if (cache !== null) await this.saveIndex(cache, await this.loadIndex());
      }).catch(() => {});
    }, 2000);
  }
}

/**
 * Decoded images at display size, kept in memory (200 MB of pixels, like the Mac's NSCache) and
 * fetched once however many views ask at the same time. The page supplies the decoder; the Mac
 * downsamples so the longest side is at most `maxPixel`, applying the EXIF orientation.
 */
export class ImagePipeline<TImage> {
  static readonly defaultCostLimit = 200 * MB;

  private readonly memory: CostCache<string, TImage>;
  private readonly running = new Map<string, Promise<TImage | null>>();

  /**
   * @param source Where the bytes come from.
   * @param decode Bytes and the longest side wanted, in pixels, to an image. Null or a rejection when it can't.
   * @param cost What an image costs to keep: its width times height times 4.
   */
  constructor(
    private readonly source: ImageCache,
    private readonly decode: (data: Uint8Array, maxPixel: number) => Promise<TImage | null>,
    private readonly cost: (image: TImage) => number,
    costLimit = ImagePipeline.defaultCostLimit,
  ) {
    this.memory = new CostCache(costLimit);
  }

  /** "600|https://…", as on the Mac. */
  static key(url: string, maxPixel: number): string {
    return `${maxPixel}|${url}`;
  }

  /** The image if it's in memory, so a view can show it without a flash. */
  cached(url: string, maxPixel: number): TImage | null {
    return this.memory.get(ImagePipeline.key(url, maxPixel)) ?? null;
  }

  image(url: string, maxPixel: number): Promise<TImage | null> {
    const key = ImagePipeline.key(url, maxPixel);
    const hit = this.memory.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const running = this.running.get(key);
    if (running !== undefined) return running;
    const task = this.load(url, maxPixel, key).finally(() => this.running.delete(key));
    this.running.set(key, task);
    return task;
  }

  private async load(url: string, maxPixel: number, key: string): Promise<TImage | null> {
    const data = await this.source.data(url);
    if (data === null) return null;
    let image: TImage | null;
    try {
      image = await this.decode(data, maxPixel);
    } catch {
      return null;
    }
    if (image !== null) this.memory.set(key, image, this.cost(image));
    return image;
  }
}

/** A colour from 0 to 1 per channel, for ambient light from a poster or a frame. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export const Rgb = Object.freeze({
  black: Object.freeze({ r: 0, g: 0, b: 0 }) as Rgb,
  of(r: number, g: number, b: number): Rgb {
    return { r, g, b };
  },
  brightness(c: Rgb): number {
    return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  },
  /** Light from a screen is more saturated than the average pixel value suggests. */
  boosted(c: Rgb, saturation = 1.5): Rgb {
    const grey = Rgb.brightness(c);
    const mix = (v: number) => Math.min(1, Math.max(0, grey + (v - grey) * saturation));
    return { r: mix(c.r), g: mix(c.g), b: mix(c.b) };
  },
});
