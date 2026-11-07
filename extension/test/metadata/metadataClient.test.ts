// windows/Cineon.Core.Tests/Metadata/MetadataClientTests.cs: canned responses shaped like IMDb's suggestion
// endpoint and Cinemeta, read the way the Mac reads them, over a fake fetch.

import { MetadataClient, PagePreview } from "../../src/core/metadata";
import { FakeFetch } from "./fakeFetch";
import { DUNE_SEARCH, SEVERANCE_META } from "./fixtures";

describe("MetadataClient", () => {
  test("search reads the suggestions", async () => {
    const http = FakeFetch.routes({ "https://v3.sg.media-imdb.com/suggestion/x/dune.json": DUNE_SEARCH });
    const hits = await new MetadataClient({ fetch: http.fetch }).search("  Dune \n");

    expect(hits.map((h) => h.id)).toEqual(["tt15239678", "tt1160419", "tt10466872"]);
    expect(hits[0]).toEqual({
      id: "tt15239678",
      name: "Dune: Part Two",
      year: 2024,
      kind: "film",
      posterUrl: "https://m.media-amazon.com/images/M/MV5BNTc0YmQxMjEt@._V1_QL75_UX500_.jpg",
      subtitle: "Timothée Chalamet, Zendaya",
      rank: 46,
    });
    expect(hits[2]!.kind).toBe("series");
    expect(hits[2]!.posterUrl).toBeNull();
    expect(http.requests).toHaveLength(1);
    expect(http.header(0, "User-Agent")).toBe(MetadataClient.userAgent);
    expect(http.requests[0]!.init?.credentials).toBe("omit");
  });

  test("search encodes the query like the Mac", async () => {
    const http = new FakeFetch(() => FakeFetch.json('{"d":[]}'));
    await new MetadataClient({ fetch: http.fetch }).search("Дюна: Частина друга");
    await new MetadataClient({ fetch: http.fetch }).search("AC/DC");
    expect(http.addresses).toEqual([
      "https://v3.sg.media-imdb.com/suggestion/x/%D0%B4%D1%8E%D0%BD%D0%B0%3A%20%D1%87%D0%B0%D1%81%D1%82%D0%B8%D0%BD%D0%B0%20%D0%B4%D1%80%D1%83%D0%B3%D0%B0.json",
      "https://v3.sg.media-imdb.com/suggestion/x/ac%2Fdc.json",
    ]);
  });

  test("short queries and failures find nothing", async () => {
    const http = new FakeFetch(() => FakeFetch.json(DUNE_SEARCH, 500));
    const client = new MetadataClient({ fetch: http.fetch });
    expect(await client.search(" d ")).toEqual([]);
    expect(http.requests).toHaveLength(0);
    expect(await client.search("dune")).toEqual([]);
    const offline = new FakeFetch(() => {
      throw new TypeError("offline");
    });
    expect(await new MetadataClient({ fetch: offline.fetch }).search("dune")).toEqual([]);
    const noId = new FakeFetch(() => FakeFetch.json('{"d":[{"l":"no id"}]}'));
    expect(await new MetadataClient({ fetch: noId.fetch }).search("dune")).toEqual([]);
  });

  test("a slow service times out as nothing", async () => {
    const never = new FakeFetch(
      (_, init) =>
        new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))),
    );
    expect(await new MetadataClient({ fetch: never.fetch, timeoutMs: 20 }).search("dune")).toEqual([]);
  });

  test("detail reads Cinemeta", async () => {
    const http = FakeFetch.routes({ "https://v3-cinemeta.strem.io/meta/series/tt11280740.json": SEVERANCE_META });
    const detail = await new MetadataClient({ fetch: http.fetch }).detail("tt11280740", "series");

    expect(detail).not.toBeNull();
    expect(http.addresses).toEqual(["https://v3-cinemeta.strem.io/meta/series/tt11280740.json"]);
    expect(detail!.genres).toEqual(["Drama", "Mystery", "Sci-Fi"]);
    expect(detail!.runtimeMinutes).toBe(55);
    expect(detail!.year).toBe(2022);
    expect(detail!.backdropUrl).toBe("https://images.metahub.space/background/medium/tt11280740/img");
    // Numbered seasons only, in order; an episode needs "episode" or "number".
    expect(detail!.episodes.map((e) => e.id)).toEqual(["1x1", "1x2", "2x1", "2x2"]);
    const pilot = detail!.episodes[0]!;
    expect(pilot.name).toBe("Good News About Hell");
    expect(pilot.overview).toBe("Helly wakes up.");
    expect(pilot.released).toBe(Date.UTC(2022, 1, 18, 5, 0, 0));
    expect(detail!.episodes[1]!.overview).toBe("Mark gets a promotion.");
    expect(detail!.episodes[2]!.thumbnailUrl).toBe("https://episodes.metahub.space/tt11280740/2/1/w780.jpg");
    // ISO8601DateFormatter with fractional seconds can't read a date without them.
    expect(detail!.episodes[3]!.released).toBeNull();
  });

  test("an unsorted title is tried as a film, then as a series", async () => {
    const http = FakeFetch.routes({
      "https://v3-cinemeta.strem.io/meta/movie/tt11280740.json": '{"meta":null}',
      "https://v3-cinemeta.strem.io/meta/series/tt11280740.json": SEVERANCE_META,
    });
    const detail = await new MetadataClient({ fetch: http.fetch }).detail("tt11280740", "unknown");
    expect(detail?.episodes).toHaveLength(4);
    expect(http.addresses).toEqual([
      "https://v3-cinemeta.strem.io/meta/movie/tt11280740.json",
      "https://v3-cinemeta.strem.io/meta/series/tt11280740.json",
    ]);

    const film = FakeFetch.routes({});
    expect(await new MetadataClient({ fetch: film.fetch }).detail("tt1160419", "film")).toBeNull();
    expect(film.addresses).toEqual(["https://v3-cinemeta.strem.io/meta/movie/tt1160419.json"]);
  });

  test("the best match trusts spelling for Latin names", () => {
    const hits = MetadataClient.parseSearch(DUNE_SEARCH);
    expect(MetadataClient.bestMatch(hits, "Dune: Part Two", 2024, "film")?.id).toBe("tt15239678");
    expect(MetadataClient.bestMatch(hits, "Dune", 2021, "film")?.id).toBe("tt1160419");
    expect(MetadataClient.bestMatch(hits, "Dune", 1984, "film")?.id).toBe("tt1160419"); // The exact name outweighs the year
    expect(MetadataClient.bestMatch(hits, "Dune Prophecy", 2024, "series")?.id).toBe("tt10466872");
    expect(MetadataClient.bestMatch(hits, "Arrival", null, "film")).toBeNull();
    expect(MetadataClient.bestMatch([], "Dune", null, "film")).toBeNull();
  });

  test("the best match trusts the rank for other scripts", () => {
    const hits = MetadataClient.parseSearch(DUNE_SEARCH);
    expect(MetadataClient.bestMatch(hits, "Дюна: Частина друга", 2024, "film")?.id).toBe("tt15239678");
    expect(MetadataClient.bestMatch(hits, "Дюна", 1965, "series")).toBeNull();
  });
});

// BrowserImportTests' PagePreview cases, and fetching.
describe("PagePreview", () => {
  test("reads Open Graph tags", () => {
    const html =
      '<head><meta content="https://cdn.example/poster.jpg" property="og:image"><meta property="og:description" content="A film &amp; more"></head>';
    const preview = PagePreview.parse(html, "https://site.example/x");
    expect(preview.poster).toBe("https://cdn.example/poster.jpg");
    expect(preview.overview).toBe("A film & more");
  });

  test("resolves relative images and ignores logos", () => {
    expect(PagePreview.parse('<meta property="og:image" content="/i/p.jpg">', "https://site.example/film/x").poster).toBe(
      "https://site.example/i/p.jpg",
    );
    expect(PagePreview.parse('<meta property="og:image" content="/static/logo.png">', "https://site.example/x").poster).toBeNull();
  });

  test("fetch reads the head of a page as Safari", async () => {
    const page =
      '<html><head><meta property="og:image" content="/p.jpg"></head><body>' +
      "x".repeat(400_000) +
      '<meta property="og:description" content="Too far down"></body></html>';
    const http = new FakeFetch(() => FakeFetch.json(page));
    const preview = await new PagePreview({ fetch: http.fetch }).fetch("https://site.example/film/1");
    expect(preview.poster).toBe("https://site.example/p.jpg");
    expect(preview.overview).toBeNull(); // Only the first 300,000 bytes are read
    expect(http.requests).toHaveLength(1);
    expect(http.header(0, "User-Agent")).toBe(PagePreview.userAgent);

    const missing = new FakeFetch(() => FakeFetch.json(page, 404));
    expect(await new PagePreview({ fetch: missing.fetch }).fetch("https://site.example/x")).toEqual({ poster: null, overview: null });
  });
});
