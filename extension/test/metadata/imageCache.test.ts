// windows/Cineon.Core.Tests/Metadata/ImageCacheTests.cs, over an in-memory Cache Storage (Node has none).

import { CostCache, ImageCache, ImagePipeline, Rgb } from "../../src/core/metadata";
import { FakeFetch } from "./fakeFetch";

const POSTER = "https://m.media-amazon.com/images/M/poster._V1_QL75_UX500_.jpg";

const image = (size: number, fill = 7) => new Uint8Array(size).fill(fill);

function urlOf(request: RequestInfo | URL): string {
  return typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
}

/** The parts of the Cache API that ImageCache uses, kept in a Map. */
class FakeCache {
  readonly store = new Map<string, { body: ArrayBuffer; headers: [string, string][]; status: number }>();

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const entry = this.store.get(urlOf(request));
    return entry ? new Response(entry.body.slice(0), { headers: entry.headers, status: entry.status }) : undefined;
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.store.set(urlOf(request), { body: await response.arrayBuffer(), headers: [...response.headers], status: response.status });
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    return this.store.delete(urlOf(request));
  }

  async keys(): Promise<Request[]> {
    return [...this.store.keys()].map((url) => new Request(url));
  }
}

class FakeCacheStorage {
  readonly caches = new Map<string, FakeCache>();

  async open(name: string): Promise<FakeCache> {
    let cache = this.caches.get(name);
    if (!cache) this.caches.set(name, (cache = new FakeCache()));
    return cache;
  }

  get asCacheStorage(): CacheStorage {
    return this as unknown as CacheStorage;
  }
}

let storage: FakeCacheStorage;

beforeEach(() => {
  storage = new FakeCacheStorage();
});

const offline = () =>
  new FakeFetch(() => {
    throw new TypeError("offline");
  });

test("one fetch serves everyone and is kept in Cache Storage", async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const http = new FakeFetch(async () => {
    await released;
    return FakeFetch.bytes(image(100));
  });
  const cache = new ImageCache({ fetch: http.fetch, caches: storage.asCacheStorage });

  const first = cache.data(POSTER);
  const second = cache.data(POSTER);
  release();
  expect(await first).toEqual(image(100));
  expect(await second).toEqual(image(100));
  expect(http.requests).toHaveLength(1);

  expect(cache.cached(POSTER)).toEqual(image(100));
  const stored = (await storage.open("cineon-images")).store;
  expect(stored.has(await ImageCache.entryUrl(POSTER))).toBe(true);
  expect(await cache.diskSize()).toBe(100);

  // A new cache over the same storage, as after a restart, reads it from there.
  const later = new ImageCache({ fetch: offline().fetch, caches: storage.asCacheStorage });
  expect(later.cached(POSTER)).toBeNull();
  expect(await later.data(POSTER)).toEqual(image(100));
  expect(await later.diskSize()).toBe(100);
});

test("only good responses are kept", async () => {
  const notFound = new FakeFetch(() => FakeFetch.bytes(image(10), 404));
  // Like the Mac, the body still comes back; decoding it is what fails.
  expect(await new ImageCache({ fetch: notFound.fetch, caches: storage.asCacheStorage }).data(POSTER)).toEqual(image(10));
  expect(await new ImageCache({ caches: storage.asCacheStorage }).diskSize()).toBe(0);

  const noStore = new FakeFetch(() => FakeFetch.bytes(image(10), 200, { "cache-control": "private, no-store" }));
  await new ImageCache({ fetch: noStore.fetch, caches: storage.asCacheStorage }).data(POSTER);
  expect(await new ImageCache({ caches: storage.asCacheStorage }).diskSize()).toBe(0);

  const tooBig = new FakeFetch(() => FakeFetch.bytes(image(2000)));
  await new ImageCache({ fetch: tooBig.fetch, caches: storage.asCacheStorage, diskCapacity: 20_000 }).data(POSTER);
  expect(await new ImageCache({ caches: storage.asCacheStorage }).diskSize()).toBe(0); // Over 5% of the capacity

  expect(await new ImageCache({ fetch: offline().fetch, caches: storage.asCacheStorage }).data(POSTER)).toBeNull();
});

test("only absolute web addresses are fetched", async () => {
  const http = new FakeFetch(() => FakeFetch.bytes(image(10)));
  const cache = new ImageCache({ fetch: http.fetch, caches: null });
  expect(await cache.data("/rel.jpg")).toBeNull(); // Foundation keeps a page's relative poster; it can't load
  expect(await cache.data("chrome-extension://x/a.png")).toBeNull();
  expect(http.requests).toHaveLength(0);
  expect(await cache.data(POSTER)).toEqual(image(10)); // Memory only
  expect(await cache.diskSize()).toBe(0);
});

test("the least recently used go when Cache Storage is full", async () => {
  let clock = 0;
  const http = new FakeFetch((url) => FakeFetch.bytes(image(400, new URL(url).pathname.length)));
  const options = { fetch: http.fetch, caches: storage.asCacheStorage, diskCapacity: 20_000, memoryCapacity: 1, now: () => ++clock };
  const cache = new ImageCache(options);
  const stored = (await storage.open("cineon-images")).store;
  stored.set("https://example.com/not-ours", { body: new ArrayBuffer(5000), headers: [], status: 200 }); // Left alone

  const urls = Array.from({ length: 55 }, (_, i) => `https://img.example/${i}.jpg`);
  for (const url of urls.slice(0, 10)) await cache.data(url);
  await cache.data(urls[0]!); // Used again, so it stays
  for (const url of urls.slice(10)) await cache.data(url);

  expect(await cache.diskSize()).toBeLessThanOrEqual(20_000);
  expect(stored.has(await ImageCache.entryUrl(urls[0]!))).toBe(true);
  expect(stored.has(await ImageCache.entryUrl(urls[1]!))).toBe(false);
  expect(stored.has(await ImageCache.entryUrl(urls[54]!))).toBe(true);
  expect(stored.has("https://example.com/not-ours")).toBe(true);

  // The order of use survives a restart.
  const later = new ImageCache({ ...options, fetch: offline().fetch });
  expect(await later.diskSize()).toBe(await cache.diskSize());
  expect(await later.data(urls[0]!)).toEqual(image(400, "/0.jpg".length));
});

test("the pipeline decodes once per size", async () => {
  const http = new FakeFetch(() => FakeFetch.bytes(image(64)));
  let decodes = 0;
  const pipeline = new ImagePipeline<string>(
    new ImageCache({ fetch: http.fetch, caches: storage.asCacheStorage }),
    async (data, maxPixel) => {
      decodes++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return `${data.length}@${maxPixel}`;
    },
    () => 4,
  );

  expect(pipeline.cached(POSTER, 600)).toBeNull();
  const results = await Promise.all([pipeline.image(POSTER, 600), pipeline.image(POSTER, 600)]);
  expect(results).toEqual(["64@600", "64@600"]);
  expect(decodes).toBe(1);
  expect(pipeline.cached(POSTER, 600)).toBe("64@600");
  expect(ImagePipeline.key(POSTER, 600)).toBe("600|" + POSTER);

  expect(await pipeline.image(POSTER, 256)).toBe("64@256");
  expect(decodes).toBe(2);
  expect(http.requests).toHaveLength(1); // The bytes were fetched once
});

test("what can't be decoded is not kept", async () => {
  const pipeline = new ImagePipeline<string>(
    new ImageCache({ fetch: new FakeFetch(() => FakeFetch.bytes(image(8))).fetch, caches: null }),
    () => Promise.reject(new Error("not an image")),
    () => 1,
  );
  expect(await pipeline.image(POSTER, 600)).toBeNull();
  expect(pipeline.cached(POSTER, 600)).toBeNull();
});

test("memory keeps the most recently used within its limit", () => {
  const cache = new CostCache<string, string>(10);
  cache.set("a", "A", 4);
  cache.set("b", "B", 4);
  expect(cache.get("a")).toBe("A");
  cache.set("c", "C", 4);
  expect(cache.get("b")).toBeUndefined();
  expect(cache.get("a")).toBe("A");
  expect(cache.totalCost).toBe(8);
  cache.set("huge", "H", 11);
  expect(cache.get("huge")).toBeUndefined();
});

test("ambient colours are boosted", () => {
  expect(Rgb.brightness(Rgb.black)).toBe(0);
  expect(Rgb.brightness(Rgb.of(1, 1, 1))).toBeCloseTo(1, 6);
  const colour = Rgb.of(0.8, 0.3, 0.1);
  const grey = Rgb.brightness(colour);
  const boosted = Rgb.boosted(colour);
  expect(boosted.r).toBeCloseTo(Math.min(1, grey + (0.8 - grey) * 1.5), 9);
  expect(boosted.b).toBeCloseTo(Math.max(0, grey + (0.1 - grey) * 1.5), 9);
  expect(Rgb.boosted(Rgb.of(0.5, 0.5, 0.5))).toEqual(Rgb.of(0.5, 0.5, 0.5));
});
