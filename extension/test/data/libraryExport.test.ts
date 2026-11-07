// The library export both ways. The golden text below is what Swift's JSONEncoder wrote for the
// same payload on a Mac (pretty, sorted keys, ISO 8601 dates).

import {
  type Database,
  EpisodeRef,
  LibraryExport,
  LibraryStore,
  StoredDate,
  swiftPrettyJson,
  WatchSession,
} from "../../src/core/data";
import { swiftNumber } from "../../src/core/data/swiftJson";
import { freshDatabase } from "./helpers";

const D = 1793914535.142225;

const SWIFT_GOLDEN = String.raw`{
  "exportedAt" : "2026-11-05T21:35:35Z",
  "timeline" : [
    {
      "duration" : 900,
      "endedAt" : "2026-11-05T21:35:35Z",
      "episode" : 2,
      "finished" : false,
      "season" : 1,
      "site" : "x.example",
      "startedAt" : "2026-11-05T21:35:35Z",
      "stoppedAt" : 0.1,
      "title" : "B",
      "url" : "https:\/\/x.example\/a?b=1#c",
      "watchedSeconds" : 6.030518054962158
    }
  ],
  "titles" : [
    {
      "finishedAt" : "2026-11-05T21:35:35Z",
      "imdbID" : "tt1",
      "kind" : "film",
      "name" : "Dune: Part Two\/é \"q\" \u0001 ` + "\u007f  " + String.raw`",
      "rating" : 8,
      "status" : "watched",
      "year" : 2024
    },
    {
      "kind" : "unknown",
      "name" : "B",
      "rating" : 7.5,
      "status" : "none"
    }
  ]
}`;

const SWIFT_EMPTY = `{
  "exportedAt" : "2026-11-05T21:35:35Z",
  "timeline" : [

  ],
  "titles" : [

  ]
}`;

test("JSON is written as Swift's JSONEncoder writes it", () => {
  const payload = {
    exportedAt: StoredDate.iso8601(D),
    titles: [
      {
        name: "Dune: Part Two/é \"q\" \u0001 \u007f  ",
        year: 2024,
        kind: "film",
        status: "watched",
        imdbID: "tt1",
        rating: 8.0,
        finishedAt: StoredDate.iso8601(D),
      },
      { name: "B", year: undefined, kind: "unknown", status: "none", imdbID: undefined, rating: 7.5, finishedAt: undefined },
    ],
    timeline: [
      {
        title: "B",
        season: 1,
        episode: 2,
        site: "x.example",
        url: "https://x.example/a?b=1#c",
        startedAt: StoredDate.iso8601(D),
        endedAt: StoredDate.iso8601(D),
        watchedSeconds: 6.0305180549621582,
        stoppedAt: 0.1,
        duration: 900,
        finished: false,
      },
    ],
  };
  expect(swiftPrettyJson(payload)).toBe(SWIFT_GOLDEN);
  expect(swiftPrettyJson({ exportedAt: StoredDate.iso8601(D), titles: [], timeline: [] })).toBe(SWIFT_EMPTY);
  expect(swiftPrettyJson({ s: "a\nb\tc\bd\fe\rf\u001fg\\h" })).toBe(`{\n  "s" : "a\\nb\\tc\\bd\\fe\\rf\\u001fg\\\\h"\n}`);
});

test("numbers are written as Swift prints doubles", () => {
  const swift = "1e+21,1e-07,1.2345678901234568e+20,0.30000000000000004,1793914535.142225,5e-324,1e+16,1.2345678901234568e+16,1000000000000000,100,-0";
  const values = [1e21, 1e-7, 123456789012345680000, 0.1 + 0.2, 1793914535.142225, 5e-324, 1e16, 12345678901234568, 1e15, 100, -0];
  expect(values.map(swiftNumber).join(",")).toBe(swift);
  expect(swiftNumber(0.00001)).toBe("1e-05");
  expect(swiftNumber(0.0001)).toBe("0.0001");
});

describe("with a library", () => {
  let db: Database;
  let library: LibraryStore;

  beforeEach(async () => {
    db = await freshDatabase();
    library = await LibraryStore.open(db);
  });

  afterEach(() => db.close());

  async function fill(store: LibraryStore): Promise<void> {
    const dune = (await store.addTitle("Dune: Part Two", { year: 2024, kind: "film", imdbId: "tt15239678" }))!;
    await store.setStatus(dune.id, "watched");
    await store.setRating(dune.id, 17);
    await store.update({ ...store.titles.get(dune.id)!, finishedAt: D });
    const lost = (await store.addTitle("Lost", { year: 2004, kind: "series", status: "watching" }))!;
    await store.addTitle("Ёлки 2", { status: "backlog" });
    // Saved in the order they happened, as the tracker does: the store keeps the newest first.
    await store.saveSession(
      WatchSession.make({
        titleId: dune.id,
        host: "films.example",
        startedAt: D - 9000,
        endedAt: D - 100,
        watchedSeconds: 8000,
        endPosition: 9900,
        duration: 9960,
        finished: true,
      }),
    );
    await store.saveSession(
      WatchSession.make({
        titleId: lost.id,
        ref: EpisodeRef.make(1, 2),
        host: "site.example",
        url: "https://site.example/lost/s1e2",
        startedAt: D - 3000,
        endedAt: D - 400,
        watchedSeconds: 2500.5,
        startPosition: 100,
        endPosition: 2600.5,
        duration: 2700,
        finished: true,
      }),
    );
  }

  test("the export has the apps' fields, names in order and no nulls", async () => {
    await fill(library);
    const text = LibraryExport.make(library, D);
    expect(text.startsWith(`{\n  "exportedAt" : "2026-11-05T21:35:35Z",\n  "timeline" : [`)).toBe(true);
    expect(text).toContain(`"url" : "https:\\/\\/site.example\\/lost\\/s1e2"`);
    const payload = JSON.parse(text);
    expect(payload.titles.map((t: { name: string }) => t.name)).toEqual(["Dune: Part Two", "Lost", "Ёлки 2"]);
    expect(payload.titles[0]).toEqual({
      finishedAt: "2026-11-05T21:35:35Z",
      imdbID: "tt15239678",
      kind: "film",
      name: "Dune: Part Two",
      rating: 8.5,
      status: "watched",
      year: 2024,
    });
    expect(payload.titles[2]).toEqual({ kind: "unknown", name: "Ёлки 2", status: "backlog" });
    expect(payload.timeline).toHaveLength(2);
    expect(payload.timeline[0]).toEqual({
      duration: 2700,
      endedAt: StoredDate.iso8601(D - 400),
      episode: 2,
      finished: true,
      season: 1,
      site: "site.example",
      startedAt: StoredDate.iso8601(D - 3000),
      stoppedAt: 2600.5,
      title: "Lost",
      url: "https://site.example/lost/s1e2",
      watchedSeconds: 2500.5,
    });
    expect("url" in payload.timeline[1]).toBe(false);
  });

  test("an export imports into an empty library and exports the same again", async () => {
    await fill(library);
    const text = LibraryExport.make(library, D);

    const otherDb = await freshDatabase();
    const other = await LibraryStore.open(otherDb);
    const result = (await LibraryExport.importText(other, text))!;
    expect(result).toMatchObject({ titlesAdded: 3, titlesUpdated: 0, sessionsAdded: 2, sessionsSkipped: 0 });
    expect(result.titles).toHaveLength(3);
    expect(LibraryExport.make(other, D)).toBe(text);

    // What came in is usable: lists, ratings, the timeline and "recently watched".
    expect(other.watched.map((t) => t.name)).toEqual(["Dune: Part Two"]);
    expect(other.backlog.map((t) => t.name)).toEqual(["Ёлки 2"]);
    const dune = other.find("Dune: Part Two", null, 2024)!;
    expect(dune.ratingHalves).toBe(17);
    expect(dune.lastWatchedAt).toBe(Math.floor(D - 100));
    const lostSession = other.sessions.find((s) => s.ref.episode === 2)!;
    expect([lostSession.startPosition, lostSession.endPosition]).toEqual([100, 2600.5]);

    // Twice adds nothing.
    const again = (await LibraryExport.importText(other, text))!;
    expect(again).toMatchObject({ titlesAdded: 0, titlesUpdated: 0, sessionsAdded: 0, sessionsSkipped: 2 });
    expect(other.titles.size).toBe(3);
    expect(other.sessions).toHaveLength(2);
    otherDb.close();
  });

  test("importing fills in what's missing and keeps what's set", async () => {
    const heat = (await library.addTitle("Heat"))!;
    await library.setRating(heat.id, 6);
    const thing = (await library.addTitle("The Thing", { year: 1982 }))!;
    const text = JSON.stringify({
      exportedAt: "2026-11-05T21:35:35Z",
      titles: [
        { name: "Heat", year: 1995, kind: "film", status: "watched", imdbID: "tt0113277", rating: 9, finishedAt: "2026-01-01T00:00:00Z" },
        { name: "The Thing", year: 2011, kind: "film", status: "backlog" },
        { name: "", kind: "film", status: "none" },
        "nonsense",
      ],
      timeline: [
        { title: "Heat", season: 0, episode: 0, site: "x.example", startedAt: "2026-02-01T20:00:00Z", endedAt: "2026-02-01T22:00:00Z", watchedSeconds: 7000, stoppedAt: 7000, duration: 10000, finished: false },
        { title: "Unknown Film", season: 0, episode: 0, site: "y.example", startedAt: "2026-02-02T20:00:00Z", endedAt: "2026-02-02T21:00:00Z", watchedSeconds: 60, stoppedAt: 30, duration: 100, finished: false },
        { title: "Broken", startedAt: "not a date" },
      ],
    });
    const imported = LibraryExport.parse(text)!;
    expect(imported.skipped).toBe(3);
    const result = await LibraryExport.apply(library, imported);
    expect(result).toMatchObject({ titlesAdded: 2, titlesUpdated: 1, sessionsAdded: 2 });

    const updated = library.titles.get(heat.id)!;
    // The rating you gave stays; the rest was missing and is filled in.
    expect([updated.ratingHalves, updated.status, updated.year, updated.imdbId, updated.kind]).toEqual([6, "watched", 1995, "tt0113277", "film"]);
    expect(updated.finishedAt).toBe(StoredDate.parseIso8601("2026-01-01T00:00:00Z"));
    // A different year is a different film.
    expect(library.titles.get(thing.id)!.status).toBe("none");
    expect(library.find("The Thing", null, 2011)?.status).toBe("backlog");
    // A session for a title the file didn't list brings that title.
    const unknown = library.find("Unknown Film")!;
    expect(unknown.status).toBe("none");
    expect((await library.sessionsForTitle(unknown.id))[0]!.startPosition).toBe(0);
  });

  test("what isn't an export is refused", () => {
    expect(LibraryExport.parse("not json")).toBeNull();
    expect(LibraryExport.parse("[]")).toBeNull();
    expect(LibraryExport.parse(`{"theme":"dark"}`)).toBeNull();
    expect(LibraryExport.parse(`{"titles":[]}`)).toMatchObject({ titles: [], timeline: [], skipped: 0 });
  });
});
