// Port of windows/Cineon.Core.Tests/Data/LibraryStoreTests.cs.

import {
  Database,
  EpisodeRef,
  FilmFrame,
  LibraryStore,
  type LibraryStoreKey,
  MemoryFrameFiles,
  type Title,
  WatchProgress,
  WatchSession,
} from "../../src/core/data";
import { freshDatabase } from "./helpers";

let db: Database;
let library: LibraryStore;

beforeEach(async () => {
  db = await freshDatabase();
  library = await LibraryStore.open(db);
});

afterEach(() => db.close());

const now = () => Date.now() / 1000;

test("adding to the backlog is an event", async () => {
  const changes: (readonly LibraryStoreKey[])[] = [];
  library.changed.on((keys) => changes.push(keys));
  const dune = (await library.addTitle("Dune: Part Two", { year: 2024, kind: "film", status: "backlog", imdbId: "tt15239678" }))!;
  expect(dune).not.toBeNull();
  expect(dune.normName).toBe("duneparttwo");
  expect(library.events.map((e) => e.kind)).toEqual(["addedToBacklog"]);
  expect(library.backlog).toEqual([dune]);
  expect(changes.length).toBeGreaterThan(0);
  expect(changes.flat()).toContain("titles");

  // The same IMDb ID finds the title already there.
  expect((await library.addTitle("Dune 2", { imdbId: "tt15239678" }))?.id).toBe(dune.id);
  expect(library.titles.size).toBe(1);
});

test("status and rating are recorded and reported", async () => {
  const reported: Title[] = [];
  library.onPersonalChange = (t) => reported.push(t);
  const id = (await library.addTitle("Heat", { year: 1995 }))!.id;

  await library.setStatus(id, "watched");
  const watched = library.titles.get(id)!;
  expect(watched.status).toBe("watched");
  expect(watched.finishedAt).not.toBeNull();
  expect(watched.statusAt).not.toBeNull();
  expect(library.events[0]!.kind).toBe("markedWatched");

  await library.setRating(id, 99);
  expect(library.titles.get(id)!.ratingHalves).toBe(20);
  await library.setRating(id, 20);
  expect(reported).toHaveLength(2);
  await library.setRating(id, null);
  expect(library.titles.get(id)!.ratingHalves).toBeNull();

  const stored = (await db.allTitles())[0]!;
  expect([stored.status, stored.ratingHalves, reported.length]).toEqual(["watched", null, 3]);
  expect(library.count("watched")).toBe(1);
});

test("changes show in memory before the database has them", async () => {
  const id = (await library.addTitle("Heat"))!.id;
  const status = library.setStatus(id, "watching");
  const rating = library.setRating(id, 15);
  expect(library.titles.get(id)).toMatchObject({ status: "watching", ratingHalves: 15 });
  await Promise.all([status, rating]);
  expect((await db.allTitles())[0]).toMatchObject({ status: "watching", ratingHalves: 15 });
});

test("restoring from the cloud is quiet", async () => {
  let reported = 0;
  library.onPersonalChange = () => reported++;
  const id = (await library.addTitle("Heat", { year: 1995 }))!.id;
  const at = now() - 3 * 86400;
  await library.restore(id, { halves: 17, ratedAt: at, status: "watched", statusAt: at, finishedAt: null });
  const title = library.titles.get(id)!;
  expect([title.ratingHalves, title.status]).toEqual([17, "watched"]);
  expect(title.finishedAt).toBe(at);
  expect(reported).toBe(0);

  await library.restore(id, {});
  expect(library.titles.get(id)!.ratingHalves).toBe(17);
  await library.restore(id, { halves: null });
  expect(library.titles.get(id)!.ratingHalves).toBeNull();
  expect((await db.allTitles())[0]!.ratingHalves).toBeNull();
});

test("finds by name and year", async () => {
  const a = (await library.addTitle("The Thing", { year: 1982 }))!;
  const b = (await library.addTitle("The Thing", { year: 2011 }))!;
  expect(library.find("the thing", null, 2011)?.id).toBe(b.id);
  expect(library.find("The  Thing!", null, 1983)?.id).toBe(a.id);
  expect(library.find("The Thing", null, 1995)).toBeNull();
  expect(library.find("Нечто", "The Thing", 1982)?.id).toBe(a.id);
  expect(library.find("The Thing")).not.toBeNull();
  expect(library.search("thing").map((t) => t.id).sort((x, y) => x - y)).toEqual([a.id, b.id]);
  expect(library.search("!!")).toEqual([]);
});

test("progress and sessions", async () => {
  const id = (await library.addTitle("Lost", { year: 2004, kind: "series" }))!.id;
  await library.recordWatchStart(id);
  expect(library.titles.get(id)!.status).toBe("watching");

  const t = now();
  const progress = (episode: number, position: number) =>
    WatchProgress.make({
      titleId: id,
      ref: EpisodeRef.make(1, episode),
      urlKey: `site/${episode}`,
      host: "site",
      position,
      duration: 2600,
      updatedAt: t + episode,
    });
  await library.saveProgress(progress(1, 100));
  await library.saveProgress(progress(2, 200));
  await library.saveProgress(progress(1, 300));
  expect(library.progress.map((p) => p.ref.episode)).toEqual([1, 2]);
  expect(library.latestProgress(id)?.position).toBe(300);
  expect(library.progressList(id)).toHaveLength(2);
  const continuing = library.continueWatching;
  expect(continuing).toHaveLength(1);
  expect([continuing[0]!.title.id, continuing[0]!.progress.ref.episode]).toEqual([id, 1]);

  await library.clearProgress(id, EpisodeRef.make(1, 1));
  expect((await db.progress(id, EpisodeRef.make(1, 1)))?.position).toBe(0);

  const session = await library.saveSession(
    WatchSession.make({ titleId: id, ref: EpisodeRef.make(1, 1), host: "site", startedAt: t, endedAt: t, duration: 2600 }),
  );
  expect(session.id).not.toBe(0);
  await library.saveSession({ ...session, watchedSeconds: 600 });
  expect(library.sessions).toHaveLength(1);
  expect(library.sessions[0]!.watchedSeconds).toBe(600);
  expect(await library.sessionsForTitle(id)).toHaveLength(1);
  const revision = library.revision;
  await library.deleteSession(session.id);
  expect(library.sessions).toEqual([]);
  expect(library.revision).toBeGreaterThan(revision);
});

test("merged titles are followed", async () => {
  const a = (await library.addTitle("Dune Part Two"))!.id;
  const b = (await library.addTitle("Dune: Part Two", { year: 2024 }))!.id;
  await library.saveSession(WatchSession.make({ titleId: a, host: "site", startedAt: now(), endedAt: now() }));
  await library.merge(a, b);
  expect(library.currentId(a)).toBe(b);
  expect(library.sessions.map((s) => s.titleId)).toEqual([b]);
  await library.delete(b);
  expect(library.currentId(a)).toBeNull();
  expect(library.titles.size).toBe(0);
});

test("frames are indexed and pruned", async () => {
  const id = (await library.addTitle("Alien", { year: 1979 }))!.id;
  const session = await library.saveSession(WatchSession.make({ titleId: id, host: "site", startedAt: now(), endedAt: now() }));
  const t = now();
  for (let i = 0; i < 4; i++) {
    await library.addFrame(
      FilmFrame.make({
        sessionId: session.id,
        titleId: id,
        position: 40 - i * 10,
        file: `${id}/${i}.jpg`,
        isMoment: i === 3,
        interest: i === 1 ? 9 : 1,
        at: t + i,
      }),
      new Uint8Array(1000),
    );
  }
  expect(library.frames(session.id).map((f) => f.position)).toEqual([10, 20, 30, 40]);
  expect(library.moments(id)).toHaveLength(1);
  expect(library.bestFrame(id)?.file).toBe(`${id}/1.jpg`);
  expect(((await library.readFrame(library.bestFrame(id)!)) as Uint8Array).byteLength).toBe(1000);
  expect(await library.framesSize()).toBe(4000);

  // Over 2 kB: the oldest collected frames go until under 80% of it. The moment stays.
  await library.pruneFrames(2000);
  expect(await library.framesSize()).toBe(2000);
  expect(library.frames(session.id).map((f) => f.file.split("/")[1]).sort()).toEqual(["2.jpg", "3.jpg"]);

  await library.deleteSession(session.id);
  expect(library.moments(id)).toHaveLength(1);
  expect(library.frames(session.id)).toEqual([]);
  await library.deleteAllFrames();
  expect(await library.framesSize()).toBe(0);
  expect(library.moments(id)).toEqual([]);
});

test("deleting a title takes its frame files", async () => {
  const files = new MemoryFrameFiles();
  const store = await LibraryStore.open(db, files);
  const keep = (await store.addTitle("Keep"))!.id;
  const gone = (await store.addTitle("Gone"))!.id;
  await store.addFrame(FilmFrame.make({ titleId: keep, file: `${keep}/a.jpg`, at: 1 }), new Uint8Array(1));
  await store.addFrame(FilmFrame.make({ titleId: gone, file: `${gone}/a.jpg`, at: 1 }), new Uint8Array(1));
  await store.delete(gone);
  expect([...files.files.keys()]).toEqual([`${keep}/a.jpg`]);
  expect([...store.titles.keys()]).toEqual([keep]);
});

test("sites are seeded, added and moved", async () => {
  await library.seedDefaultSitesIfNeeded();
  expect(library.sites.map((s) => s.name)).toEqual(["YouTube", "Tubi", "Internet Archive", "Pluto TV"]);
  const youtube = library.sites[0]!;
  expect([youtube.host, youtube.iconUrl, youtube.searchTemplate]).toEqual([
    "youtube.com",
    "https://www.youtube.com/favicon.ico",
    "https://www.youtube.com/results?search_query=%s",
  ]);
  await library.seedDefaultSitesIfNeeded();
  expect(library.sites).toHaveLength(4);

  expect(await library.addSite("https://m.youtube.com/watch?v=1")).toBe(youtube);
  const demo = (await library.addSite("http://www.kino-demo.example:8765/films"))!;
  expect(demo).not.toBeNull();
  expect([demo.host, demo.name, demo.position, demo.iconUrl]).toEqual([
    "kino-demo.example",
    "Kino-demo",
    4,
    "http://www.kino-demo.example/favicon.ico",
  ]);
  expect(await library.addSite("about:blank")).toBeNull();
  expect(library.siteForHost("player.kino-demo.example")?.id).toBe(demo.id);

  await library.moveSite([4], 0);
  expect(library.sites.map((s) => s.name)).toEqual(["Kino-demo", "YouTube", "Tubi", "Internet Archive", "Pluto TV"]);
  await library.moveSite([0, 1], 5);
  expect(library.sites.map((s) => s.name)).toEqual(["Tubi", "Internet Archive", "Pluto TV", "Kino-demo", "YouTube"]);
  expect((await db.allSites()).map((s) => s.name)).toEqual(library.sites.map((s) => s.name));
  expect((await db.allSites()).map((s) => s.position)).toEqual([0, 1, 2, 3, 4]);

  await library.removeSite(demo.id);
  expect(await db.allSites()).toHaveLength(4);
});

test("a reopened store sees the same library", async () => {
  const id = (await library.addTitle("Heat", { status: "backlog" }))!.id;
  await library.setRating(id, 16);
  const again = await LibraryStore.open(db);
  expect(again.titles.get(id)).toEqual(library.titles.get(id));
  expect(again.events).toEqual(library.events);
});

test("collections are replaced, never changed in place", async () => {
  const before = library.titles;
  await library.addTitle("Heat");
  expect(library.titles).not.toBe(before);
  expect(before.size).toBe(0);
});
