// windows/Cineon.Core.Tests/Metadata/MetadataServiceTests.cs: the background enricher, against an in-memory
// library (the MetadataLibrary the data layer will provide) and canned services.

import {
  episodeInfo,
  metadataHit,
  MetadataClient,
  MetadataService,
  PagePreview,
  type MetadataLibrary,
  type MetadataTitle,
} from "../../src/core/metadata";
import { TitleParser, type TitleKind } from "../../src/core/parsing";
import { FakeFetch } from "./fakeFetch";
import { DUNE_SEARCH, SEVERANCE_META } from "./fixtures";

const DUNE_SEARCH_URL = "https://v3.sg.media-imdb.com/suggestion/x/dune%3A%20part%20two.json";
const DUNE_MOVIE_URL = "https://v3-cinemeta.strem.io/meta/movie/tt15239678.json";
const DUNE_META = `
{"meta":{"id":"tt15239678","type":"movie","name":"Dune: Part Two","description":"Paul Atreides unites with Chani.",
  "genres":["Action","Adventure","Drama"],"runtime":"166 min",
  "poster":"https://images.metahub.space/poster/medium/tt15239678/img",
  "background":"https://images.metahub.space/background/medium/tt15239678/img","releaseInfo":"2024"}}`;

/** A title as the data layer keeps it, with a field metadata doesn't know about. */
interface Title extends MetadataTitle {
  addedAt: number;
}

/** What the data layer's LibraryStore will be to MetadataService. Writes settle a moment later, as IndexedDB's do. */
class FakeLibrary implements MetadataLibrary<Title> {
  readonly map = new Map<number, Title>();
  readonly progress = new Map<number, string>();
  readonly merged = new Map<number, number>();
  private nextId = 1;

  addTitle(name: string, year: number | null, kind: TitleKind, imdbId: string | null = null): Title {
    const title: Title = {
      id: this.nextId++,
      name,
      normName: TitleParser.normalize(name),
      year,
      kind,
      imdbId,
      posterUrl: null,
      backdropUrl: null,
      overview: null,
      genres: [],
      runtimeMinutes: null,
      metadataChecked: false,
      addedAt: 1,
    };
    this.map.set(title.id, title);
    return title;
  }

  title(id: number): Title | undefined {
    return this.map.get(id);
  }

  titles(): Iterable<Title> {
    return this.map.values();
  }

  async update(title: Title): Promise<void> {
    this.map.set(title.id, title);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  async merge(fromId: number, intoId: number): Promise<void> {
    this.map.delete(fromId);
    this.merged.set(fromId, intoId);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  latestProgressUrl(titleId: number): string | null {
    return this.progress.get(titleId) ?? null;
  }

  currentId(id: number): number {
    let current = id;
    while (this.merged.has(current)) current = this.merged.get(current)!;
    return current;
  }
}

let library: FakeLibrary;
let routes: Record<string, string>;
let http: FakeFetch;
let enabled: boolean;

beforeEach(() => {
  library = new FakeLibrary();
  routes = {};
  http = new FakeFetch((url) => (Object.hasOwn(routes, url) ? FakeFetch.json(routes[url]!) : new Response("", { status: 404 })));
  enabled = true;
});

function service(): MetadataService<Title> {
  return new MetadataService({
    library,
    enabled: () => enabled,
    client: new MetadataClient({ fetch: http.fetch }),
    preview: new PagePreview({ fetch: http.fetch }),
    pauseMs: 0,
  });
}

test("enrich fills in the title", async () => {
  routes[DUNE_SEARCH_URL] = DUNE_SEARCH;
  routes[DUNE_MOVIE_URL] = DUNE_META;
  const id = library.addTitle("Dune: Part Two", 2024, "film").id;
  const metadata = service();

  metadata.enrich(id);
  await metadata.idle;

  const title = library.title(id)!;
  expect(title.metadataChecked).toBe(true);
  expect(title.imdbId).toBe("tt15239678");
  expect(title.name).toBe("Dune: Part Two");
  expect(title.normName).toBe("duneparttwo");
  expect(title.year).toBe(2024);
  // The suggestion's poster wins over Cinemeta's.
  expect(title.posterUrl).toBe("https://m.media-amazon.com/images/M/MV5BNTc0YmQxMjEt@._V1_QL75_UX500_.jpg");
  expect(title.backdropUrl).toBe("https://images.metahub.space/background/medium/tt15239678/img");
  expect(title.overview).toBe("Paul Atreides unites with Chani.");
  expect(title.genres).toEqual(["Action", "Adventure", "Drama"]);
  expect(title.runtimeMinutes).toBe(166);
  expect(title.kind).toBe("film");
  expect(title.addedAt).toBe(1); // What metadata doesn't know about is kept
  expect(http.addresses).toEqual([DUNE_SEARCH_URL, DUNE_MOVIE_URL]);

  // Checked titles aren't looked up again.
  metadata.enrich(id);
  await metadata.idle;
  expect(http.requests).toHaveLength(2);
});

test("the other name is tried first, and animation makes a cartoon", async () => {
  routes["https://v3.sg.media-imdb.com/suggestion/x/dune.json"] = DUNE_SEARCH;
  routes["https://v3-cinemeta.strem.io/meta/movie/tt1160419.json"] = '{"meta":{"genres":["Animation"]}}';
  const id = library.addTitle("Дюна", 2021, "unknown").id;
  const metadata = service();

  metadata.enrich(id, "Dune");
  await metadata.idle;

  const title = library.title(id)!;
  expect(title.imdbId).toBe("tt1160419");
  expect(title.name).toBe("Dune");
  expect(title.kind).toBe("cartoon");
  expect(http.addresses[0]).toBe("https://v3.sg.media-imdb.com/suggestion/x/dune.json");
});

test("without a match the page it was watched on is asked", async () => {
  routes["https://kino.example/film/1"] =
    '<head><meta property="og:image" content="/posters/1.jpg"><meta property="og:description" content="Опис фільму"></head>';
  const id = library.addTitle("Невідомий фільм", 2020, "film").id;
  library.progress.set(id, "https://kino.example/film/1");
  const metadata = service();

  metadata.enrich(id);
  await metadata.idle;

  const title = library.title(id)!;
  expect(title.metadataChecked).toBe(true);
  expect(title.imdbId).toBeNull();
  expect(title.posterUrl).toBe("https://kino.example/posters/1.jpg");
  expect(title.overview).toBe("Опис фільму");
});

test("the same film under another name is merged", async () => {
  routes[DUNE_SEARCH_URL] = DUNE_SEARCH;
  const existing = library.addTitle("Дюна: Частина друга", 2024, "film", "tt15239678").id;
  const id = library.addTitle("Dune: Part Two", 2024, "film").id;
  const metadata = service();

  metadata.enrich(id);
  await metadata.idle;

  expect(library.title(id)).toBeUndefined();
  expect(library.title(existing)).toBeDefined();
  expect(library.currentId(id)).toBe(existing);
});

test("nothing happens when turned off", async () => {
  enabled = false;
  const id = library.addTitle("Dune: Part Two", 2024, "film").id;
  const metadata = service();
  metadata.enrich(id);
  await metadata.idle;
  expect(http.requests).toHaveLength(0);
  expect(library.title(id)!.metadataChecked).toBe(false);
});

test("what's being watched is looked up first", async () => {
  routes["https://v3.sg.media-imdb.com/suggestion/x/a%20film.json"] = '{"d":[]}';
  const first = library.addTitle("A film", null, "film").id;
  const second = library.addTitle("B film", null, "film").id;
  const watching = library.addTitle("C film", null, "film").id;
  const metadata = service();

  metadata.enrich(first, null, true);
  metadata.enrich(second, null, true);
  metadata.enrich(watching);
  metadata.enrich(watching); // Already queued
  await metadata.idle;

  expect(http.addresses).toEqual([
    "https://v3.sg.media-imdb.com/suggestion/x/c%20film.json",
    "https://v3.sg.media-imdb.com/suggestion/x/a%20film.json",
    "https://v3.sg.media-imdb.com/suggestion/x/b%20film.json",
  ]);
  expect([first, second, watching].every((id) => library.title(id)!.metadataChecked)).toBe(true);
});

test("a choice by hand is applied", async () => {
  routes[DUNE_MOVIE_URL] = DUNE_META;
  const id = library.addTitle("Dune 2", null, "unknown").id;
  const metadata = service();

  await metadata.apply(metadataHit("tt15239678", "Dune: Part Two", 2024, "film"), id);

  const title = library.title(id)!;
  expect(title.name).toBe("Dune: Part Two");
  expect(title.year).toBe(2024);
  expect(title.posterUrl).toBe("https://images.metahub.space/poster/medium/tt15239678/img");
  expect(title.metadataChecked).toBe(true);
});

test("episodes are kept until asked for fresh", async () => {
  routes["https://v3-cinemeta.strem.io/meta/series/tt11280740.json"] = SEVERANCE_META;
  const series = library.addTitle("Severance", 2022, "series", "tt11280740");
  const film = library.addTitle("Dune", 2021, "film", "tt1160419");
  const metadata = service();

  expect(await metadata.episodes(series)).toHaveLength(4);
  expect(await metadata.episodes(series)).toHaveLength(4);
  expect(http.requests).toHaveLength(1);
  await metadata.episodes(series, true);
  expect(http.requests).toHaveLength(2);

  expect(await metadata.episodes(film)).toEqual([]);
  expect(http.requests).toHaveLength(2);

  metadata.testEpisodes.set(film.id, [episodeInfo(1, 1)]);
  const test = await metadata.episodes(film);
  expect(test).toHaveLength(1);
  expect(test[0]!.id).toBe("1x1");
});
