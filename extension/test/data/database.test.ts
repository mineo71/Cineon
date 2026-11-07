// Port of windows/Cineon.Core.Tests/Data/DatabaseTests.cs (the parts that aren't about SQLite
// itself) and the episode alerts from ProfileAndRatingTests.cs, plus what IndexedDB has to do by
// hand: foreign keys, cascades, unique keys and OR IGNORE merges.

import {
  Database,
  DownloadItem,
  EpisodeAlert,
  EpisodeRef,
  FilmFrame,
  SitePrefs,
  Site,
  SkipRule,
  Stores,
  WatchProgress,
  WatchSession,
} from "../../src/core/data";
import { request, transact } from "../../src/core/data/idb";
import { freshDatabase, makeTitle } from "./helpers";

let db: Database;

beforeEach(async () => {
  db = await freshDatabase();
});

afterEach(() => db.close());

const now = () => Date.now() / 1000;

function makeSession(titleId: number, fields: Partial<WatchSession> = {}): WatchSession {
  return WatchSession.make({
    titleId,
    host: "site",
    startedAt: now(),
    endedAt: now(),
    watchedSeconds: 60,
    endPosition: 60,
    duration: 100,
    ...fields,
  });
}

async function rawRows(store: string): Promise<Record<string, unknown>[]> {
  return transact(db.idb, store, "readonly", (tx) => request(tx.objectStore(store).getAll()));
}

test("a profile's database is named by its upper-case UUID", () => {
  expect(Database.nameFor("190b6f43-16f2-4ee1-8e5c-7ddf3d54ab0d")).toBe("cineon-190B6F43-16F2-4EE1-8E5C-7DDF3D54AB0D");
});

test("title round trip", async () => {
  const id = await db.insertTitle(makeTitle());
  expect(id).toBeGreaterThan(0);
  const loaded = (await db.allTitles()).find((t) => t.id === id)!;
  expect(loaded.name).toBe("Dune");
  expect(loaded.genres).toEqual(["Sci-Fi", "Drama"]);
  expect(loaded.status).toBe("backlog");
  expect(loaded).toEqual({ ...makeTitle(), id, addedAt: loaded.addedAt, updatedAt: loaded.updatedAt });
});

test("rows are the apps' SQLite rows", async () => {
  await db.insertTitle(makeTitle("Dune", { metadataChecked: true }));
  const [row] = await rawRows(Stores.titles);
  expect(row).toMatchObject({
    name: "Dune",
    norm_name: "dune",
    kind: "film",
    status: "backlog",
    genres: "Sci-Fi|Drama",
    runtime_min: 155,
    rating: null,
    metadata_checked: 1,
    imdb_id: null,
  });
  expect(typeof row!.added_at).toBe("number");
});

test("Mac-written dates survive a rewrite", async () => {
  const id = await db.insertTitle(makeTitle());
  for (const value of [1793914535.142225, 1793914565.6829181, 1793914650.176656, 1793914554.5707591, 0.5, 978307200]) {
    const title = (await db.allTitles())[0]!;
    await db.updateTitle({ ...title, id, addedAt: value });
    await db.updateTitle((await db.allTitles())[0]!);
    expect((await db.allTitles())[0]!.addedAt).toBe(value);
  }
});

test("IMDb IDs are unique, missing ones aren't", async () => {
  await db.insertTitle(makeTitle("A", { imdbId: "tt1" }));
  await db.insertTitle(makeTitle("B"));
  await db.insertTitle(makeTitle("C"));
  await expect(db.insertTitle(makeTitle("D", { imdbId: "tt1" }))).rejects.toMatchObject({ name: "ConstraintError" });
  expect((await db.allTitles()).map((t) => t.name)).toEqual(["A", "B", "C"]);
});

test("updating a title that isn't there does nothing", async () => {
  await db.updateTitle(makeTitle("Ghost", { id: 42 }));
  expect(await db.allTitles()).toEqual([]);
});

test("progress upsert keeps the finished flag", async () => {
  const id = await db.insertTitle(makeTitle());
  const p = WatchProgress.make({
    titleId: id,
    urlKey: "site/x",
    host: "site",
    position: 100,
    duration: 200,
    finished: true,
    updatedAt: now(),
  });
  await db.upsertProgress(p);
  await db.upsertProgress({ ...p, position: 10, finished: false });
  const loaded = (await db.progress(id, EpisodeRef.none))!;
  expect(loaded.position).toBe(10);
  expect(loaded.finished).toBe(true);
  expect((await db.progress("site/x"))?.titleId).toBe(id);
  expect(await db.progress("site/none")).toBeNull();
});

test("deleting a title removes its records", async () => {
  const id = await db.insertTitle(makeTitle());
  const other = await db.insertTitle(makeTitle("Other"));
  const sessionId = await db.insertSession(makeSession(id));
  await db.upsertProgress(WatchProgress.make({ titleId: id, urlKey: "k", updatedAt: now() }));
  await db.addEvent("markedWatching", id);
  await db.setLink("site/x", id, EpisodeRef.none);
  await db.saveSkipRule(SkipRule.make({ titleId: id, site: "site", kind: "intro", updatedAt: now() }));
  await db.insertFrame(FilmFrame.make({ titleId: id, sessionId, file: `${id}/a.jpg`, at: now() }));
  await db.saveEpisodeAlert(EpisodeAlert.make({ titleId: id, latest: EpisodeRef.make(1, 1), checkedAt: now() }));
  const downloadId = await db.insertDownload(DownloadItem.make({ titleId: id, sourceUrl: "https://cdn.example/a.mp4" }));
  await db.insertSession(makeSession(other));

  await db.deleteTitle(id);

  expect((await db.sessions()).map((s) => s.titleId)).toEqual([other]);
  expect(await db.allProgress()).toEqual([]);
  expect(await db.events()).toEqual([]);
  expect(await db.link("site/x")).toBeNull();
  expect(await db.skipRules(id)).toEqual([]);
  expect(await db.allFrames()).toEqual([]);
  expect(await db.episodeAlerts()).toEqual([]);
  // Downloads stay, no longer anyone's (ON DELETE SET NULL).
  const download = (await db.allDownloads())[0]!;
  expect([download.id, download.titleId]).toEqual([downloadId, null]);
});

test("records need their title, as the foreign keys require", async () => {
  const missing = 999;
  await expect(db.insertSession(makeSession(missing))).rejects.toMatchObject({ name: "ConstraintError" });
  await expect(db.upsertProgress(WatchProgress.make({ titleId: missing }))).rejects.toMatchObject({ name: "ConstraintError" });
  await expect(db.addEvent("removed", missing)).rejects.toMatchObject({ name: "ConstraintError" });
  await expect(db.setLink("k", missing, EpisodeRef.none)).rejects.toMatchObject({ name: "ConstraintError" });
  const id = await db.insertTitle(makeTitle());
  await expect(db.insertFrame(FilmFrame.make({ titleId: id, sessionId: 5 }))).rejects.toMatchObject({ name: "ConstraintError" });
  await expect(
    db.insertDownload(DownloadItem.make({ titleId: missing, sourceUrl: "https://cdn.example/a.mp4" })),
  ).rejects.toMatchObject({ name: "ConstraintError" });
  expect(await db.sessions()).toEqual([]);
});

test("merge moves sessions and removes the source", async () => {
  const a = await db.insertTitle(makeTitle("A"));
  const b = await db.insertTitle(makeTitle("B"));
  await db.insertSession(makeSession(a));
  await db.mergeTitle(a, b);
  expect(await db.sessionsForTitle(b)).toHaveLength(1);
  expect((await db.allTitles()).some((t) => t.id === a)).toBe(false);
});

test("merge keeps what the target already has, like UPDATE OR IGNORE", async () => {
  const a = await db.insertTitle(makeTitle("A"));
  const b = await db.insertTitle(makeTitle("B"));
  const ep1 = EpisodeRef.make(1, 1);
  const ep2 = EpisodeRef.make(1, 2);
  await db.upsertProgress(WatchProgress.make({ titleId: a, ref: ep1, urlKey: "a1", position: 1, updatedAt: 1 }));
  await db.upsertProgress(WatchProgress.make({ titleId: a, ref: ep2, urlKey: "a2", position: 2, updatedAt: 2 }));
  await db.upsertProgress(WatchProgress.make({ titleId: b, ref: ep1, urlKey: "b1", position: 3, updatedAt: 3 }));
  await db.saveSkipRule(SkipRule.make({ titleId: a, site: "s", kind: "intro", start: 1, updatedAt: 1 }));
  await db.saveSkipRule(SkipRule.make({ titleId: a, site: "s", kind: "credits", start: 2, updatedAt: 1 }));
  await db.saveSkipRule(SkipRule.make({ titleId: b, site: "s", kind: "intro", start: 3, updatedAt: 1 }));
  await db.addEvent("markedWatching", a);
  await db.setLink("page", a, ep2);
  const frameId = await db.insertFrame(FilmFrame.make({ titleId: a, file: "x.jpg", at: 1 }));
  await db.insertDownload(DownloadItem.make({ titleId: a, sourceUrl: "https://cdn.example/a.mp4" }));
  await db.saveEpisodeAlert(EpisodeAlert.make({ titleId: a, latest: ep2, checkedAt: 1 }));

  await db.mergeTitle(a, b);

  const progress = await db.allProgress();
  expect(progress.map((p) => [p.titleId, p.ref.episode, p.urlKey]).sort()).toEqual([
    [b, 1, "b1"],
    [b, 2, "a2"],
  ]);
  const rules = await db.skipRules(b);
  expect(rules.map((r) => [r.kind, r.start])).toEqual([
    ["credits", 2],
    ["intro", 3],
  ]);
  expect(await db.skipRules(a)).toEqual([]);
  expect((await db.events()).map((e) => e.titleId)).toEqual([b]);
  expect(await db.link("page")).toEqual({ titleId: b, ref: ep2 });
  expect((await db.allFrames()).map((f) => [f.id, f.titleId])).toEqual([[frameId, b]]);
  expect((await db.allDownloads()).map((d) => d.titleId)).toEqual([b]);
  expect(await db.episodeAlerts()).toEqual([]);
});

test("history collapses repeat visits", async () => {
  const url = "https://site.example/x";
  await db.addHistory(url, "site.example", "One");
  await db.addHistory(url, "site.example", "Two");
  const rows = await db.recentHistory();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.title).toBe("Two");
});

test("history search is SQLite's LIKE, one row per address", async () => {
  await db.addHistory("https://site.example/films/dune", "site.example", "Dune");
  await db.addHistory("https://site.example/films/alien", "site.example", "ALIEN");
  await db.addHistory("https://other.example/watch?v=1", "other.example", "Ёлки");
  expect((await db.searchHistory("alien")).map((h) => h.title)).toEqual(["ALIEN"]);
  expect((await db.searchHistory("films")).map((h) => h.title).sort()).toEqual(["ALIEN", "Dune"]);
  // `_` is any one character; `%` is dropped from the query.
  expect((await db.searchHistory("d_ne")).map((h) => h.title)).toEqual(["Dune"]);
  expect((await db.searchHistory("du%ne")).map((h) => h.title)).toEqual(["Dune"]);
  // Only ASCII letters ignore case, as in SQLite.
  expect(await db.searchHistory("ёлки")).toEqual([]);
  expect(await db.searchHistory("films", 1)).toHaveLength(1);
});

test("stats accumulate", async () => {
  await db.addStats({ ads: 2, popups: 1 }, "2026-11-01");
  await db.addStats({ ads: 3 }, "2026-11-01");
  await db.addStats({ overlays: 4 }, "2026-11-02");
  const total = await db.totalStats();
  expect(total.ads).toBe(5);
  expect(total.ads + total.popups + total.redirects + total.overlays).toBe(10);
});

test("episode alerts round trip", async () => {
  const id = await db.insertTitle(makeTitle("The Bear", { status: "watching", kind: "series" }));
  const alert = EpisodeAlert.make({
    titleId: id,
    latest: EpisodeRef.make(3, 2),
    checkedAt: now(),
    newest: EpisodeRef.make(3, 2),
    newCount: 2,
    newAt: now(),
  });
  await db.saveEpisodeAlert(alert);
  const loaded = (await db.episodeAlerts())[0]!;
  expect(loaded).toEqual(alert);

  await db.saveEpisodeAlert({ ...alert, newest: null, newCount: 0, newAt: null });
  const cleared = await db.episodeAlerts();
  expect(cleared).toHaveLength(1);
  expect(cleared[0]!.newest).toBeNull();
  expect(cleared[0]!.newAt).toBeNull();
});

// Beyond the Mac's tests: the rest of the stores, so every query here has run at least once.
test("everything else round trips", async () => {
  const titleId = await db.insertTitle(makeTitle("Dune", { kind: "series" }));
  const episode = EpisodeRef.make(1, 2);

  const session = makeSession(titleId, { ref: episode, url: "https://site.example/s1e2" });
  const sessionId = await db.insertSession(session);
  await db.updateSession({ ...session, id: sessionId, watchedSeconds: 90, finished: true });
  const forTitle = await db.sessionsForTitle(titleId);
  expect(forTitle).toHaveLength(1);
  expect(forTitle[0]!.finished).toBe(true);
  expect((await db.latestSession(titleId, episode, now() - 60))?.id).toBe(sessionId);
  expect(await db.latestSession(titleId, EpisodeRef.make(1, 3), now() - 60)).toBeNull();
  expect((await db.latestSession("https://site.example/s1e2"))?.id).toBe(sessionId);
  expect(await db.totalSeconds(now() - 86400)).toBe(90);
  const perDay = await db.secondsPerDay(now() - 86400);
  expect(perDay).toHaveLength(1);
  expect(perDay[0]!.seconds).toBe(90);
  expect(perDay[0]!.day % 86400).toBe(0);

  await db.saveSkipRule(SkipRule.make({ titleId, site: "site", kind: "intro", start: 10, end: 70, sightings: 1, updatedAt: now() }));
  await db.saveSkipRule(SkipRule.make({ titleId, site: "site", kind: "intro", start: 12, end: 72, sightings: 2, updatedAt: now() }));
  const rules = await db.skipRules(titleId, "site");
  expect(rules).toHaveLength(1);
  expect([rules[0]!.start, rules[0]!.sightings]).toEqual([12, 2]);
  await db.deleteSkipRule(rules[0]!.id);
  expect(await db.skipRules(titleId)).toEqual([]);

  const frameId = await db.insertFrame(
    FilmFrame.make({ sessionId, titleId, ref: episode, position: 30, file: "1/a.jpg", isMoment: true, interest: 0.5, at: now() }),
  );
  const frames = await db.allFrames();
  expect(frames).toHaveLength(1);
  expect([frames[0]!.id, frames[0]!.sessionId, frames[0]!.file, frames[0]!.isMoment]).toEqual([frameId, sessionId, "1/a.jpg", true]);
  await db.deleteSession(sessionId);
  expect((await db.allFrames())[0]!.sessionId).toBeNull();
  await db.deleteAllFrames();
  expect(await db.allFrames()).toEqual([]);

  const download = DownloadItem.make({
    titleId,
    ref: episode,
    name: "Show",
    sourceUrl: "https://cdn.example/a.m3u8",
    host: "cdn.example",
    kind: "hls",
    quality: "720p",
    subtitles: ["/tmp/a.vtt", "/tmp/b.vtt"],
    status: "queued",
    createdAt: now(),
  });
  const downloadId = await db.insertDownload(download);
  await db.updateDownload({ ...download, id: downloadId, status: "done", bytes: 10, totalBytes: 10 });
  const downloads = await db.allDownloads();
  expect(downloads).toEqual([{ ...download, id: downloadId, status: "done", bytes: 10, totalBytes: 10 }]);
  await db.deleteDownload(downloadId);
  expect(await db.allDownloads()).toEqual([]);

  await db.addEvent("markedWatching", titleId);
  const events = await db.events();
  expect(events.map((e) => e.kind)).toEqual(["markedWatching"]);

  await db.setLink("site/x", titleId, episode);
  expect(await db.link("site/x")).toEqual({ titleId, ref: episode });
  expect(await db.link("site/y")).toBeNull();
  expect(await db.isIgnored("site/z")).toBe(false);
  await db.ignore("site/z");
  expect(await db.isIgnored("site/z")).toBe(true);

  const siteId = await db.insertSite(Site.make({ name: "Site", host: "site.example", homeUrl: "https://site.example", addedAt: now() }));
  const sites = await db.allSites();
  expect(sites).toHaveLength(1);
  expect(sites[0]!.homeUrl).toBe("https://site.example");
  await expect(
    db.insertSite(Site.make({ name: "Again", host: "site.example", homeUrl: "https://site.example/x" })),
  ).rejects.toMatchObject({ name: "ConstraintError" });
  await db.updateSite({ ...sites[0]!, searchTemplate: "https://site.example/?q=%s", addedAt: 1 });
  expect((await db.allSites())[0]!.searchTemplate).toBe("https://site.example/?q=%s");
  expect((await db.allSites())[0]!.addedAt).toBe(sites[0]!.addedAt);
  await db.deleteSite(siteId);
  expect(await db.allSites()).toEqual([]);

  await db.addHistory("https://site.example/films/dune", "site.example", "Dune");
  await db.updateHistoryTitle("https://site.example/films/dune", "Dune (2021)");
  const found = await db.searchHistory("dune");
  expect(found.map((h) => h.title)).toEqual(["Dune (2021)"]);
  expect(await db.knownHosts()).toContain("site.example");
  await db.clearHistory();
  expect(await db.recentHistory()).toEqual([]);

  await db.saveSitePrefs(SitePrefs.make("site.example", { allowPopups: true }));
  expect((await db.sitePrefs()).get("site.example")?.allowPopups).toBe(true);

  await db.clearProgress(titleId, episode);
});

test("sessions page back in time, latest first", async () => {
  const id = await db.insertTitle(makeTitle());
  for (let i = 1; i <= 5; i++) await db.insertSession(makeSession(id, { startedAt: i * 100, endedAt: i * 100 + 50 }));
  expect((await db.sessions(2)).map((s) => s.startedAt)).toEqual([500, 400]);
  expect((await db.sessions(10, 300)).map((s) => s.startedAt)).toEqual([200, 100]);
  expect((await db.sessionsForTitle(id)).map((s) => s.startedAt)).toEqual([500, 400, 300, 200, 100]);
});

test("known hosts are latest first", async () => {
  const id = await db.insertTitle(makeTitle());
  await db.insertSession(makeSession(id, { host: "old.example", endedAt: 10 }));
  await db.upsertProgress(WatchProgress.make({ titleId: id, host: "new.example", updatedAt: 30 }));
  await db.insertSession(makeSession(id, { host: "", endedAt: 40 }));
  await db.insertSession(makeSession(id, { host: "mid.example", endedAt: 20 }));
  expect(await db.knownHosts()).toEqual(["new.example", "mid.example", "old.example"]);
});

test("frame files are kept and sized without reading them", async () => {
  await db.writeFrameFile("1/a.jpg", new Uint8Array(10));
  await db.writeFrameFile("1/b.jpg", new Uint8Array(20).buffer);
  await db.writeFrameFile("12/c.jpg", new Uint8Array(30));
  expect(await db.frameFileSizes()).toEqual(
    new Map([
      ["1/a.jpg", 10],
      ["1/b.jpg", 20],
      ["12/c.jpg", 30],
    ]),
  );
  expect(((await db.readFrameFile("1/a.jpg")) as Uint8Array).byteLength).toBe(10);
  await db.deleteFrameFiles("1/");
  expect([...(await db.frameFileSizes()).keys()]).toEqual(["12/c.jpg"]);
  await db.deleteFrameFiles("12/c.jpg", true);
  expect(await db.readFrameFile("12/c.jpg")).toBeNull();
});

test("a failed transaction leaves nothing behind", async () => {
  const id = await db.insertTitle(makeTitle());
  await expect(
    transact(db.idb, [Stores.titles, Stores.events], "readwrite", async (tx) => {
      await request(tx.objectStore(Stores.events).add({ kind: "removed", title_id: id, at: 1 }));
      throw new Error("stop");
    }),
  ).rejects.toThrow("stop");
  expect(await db.events()).toEqual([]);
});

test("profile databases are separate and can be deleted", async () => {
  const id = "8415E693-96B8-40B2-9390-CDB1317C6598";
  const first = await Database.openProfile(id);
  await first.insertTitle(makeTitle("Mine"));
  first.close();
  const again = await Database.openProfile(id.toLowerCase());
  expect((await again.allTitles()).map((t) => t.name)).toEqual(["Mine"]);
  // Deleting closes this connection (versionchange) rather than waiting on it.
  await Database.delete(Database.nameFor(id));
  const fresh = await Database.openProfile(id);
  expect(await fresh.allTitles()).toEqual([]);
  fresh.close();
});
