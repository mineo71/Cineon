// e2e.py's downloads_tests, season_tests and series_tests. Files go through chrome.downloads into the
// browser's downloads folder (this run's folder, set in the profile's preferences), under Cineon/.
import { statSync } from "node:fs";
import path from "node:path";
import { ROOT, fileSize, minutes, test, type Cineon } from "./test.ts";

const NO_PLAYER = "no player of Cineon's own: a download opens with the computer's player (chrome.downloads.open), so there's nothing to watch it in here";
const SERIES_PAGE = "/series/drama/2-two-seasons-2019.html#t:300-s:1-e:1";
const SERIES_EPISODES = "S1 E1,S1 E2,S2 E1,S2 E2,S2 E3";

async function waitDownload(c: Cineon, status: string, timeout: number) {
  return c.waitUntil(async () => {
    const items = await c.downloadsList();
    return items.length && items[0]!.status === status ? items : null;
  }, timeout, 1);
}

async function allDone(c: Cineon, count: number, timeout: number) {
  return c.waitUntil(async () => {
    const items = await c.downloadsList();
    return items.length >= count && items.every((i) => i.status === "done") ? items : null;
  }, timeout, 2);
}

const fileName = (source: string) => source.split("/").pop() ?? source;

test("[downloads] a file, its subtitles, and a stream", async ({ cineon: c }) => {
  test.setTimeout(minutes(8));
  c.heading("Downloads: a player that hides its file behind HLS requests");
  await c.freshProfile("Downloads");
  await c.openPage("/rezka/film/1-test-movie-2021.html");
  const listing = await c.waitUntil(async () => {
    const t = await c.run("downloads");
    return t.includes("/cdn/stream/1080.mp4") ? t : null;
  }, 15);
  await c.check("the player's :hls: requests collapse to whole files", listing && !listing.includes(":hls:"), listing ?? "");
  const best = (listing ?? "").split("\n").find((l) => l.startsWith("best=")) ?? "";
  await c.check("the best quality is picked", best.endsWith("/cdn/stream/1080.mp4"), best);
  await c.check("the subtitle track is found", Boolean(listing?.includes("source subtitle")), listing ?? "");
  const pill = await c.waitUntil(async () => (await c.evaluate("document.querySelector('cineon-download') ? 'yes' : 'no'")) === "yes", 5);
  await c.check("a download button sits on the player", pill);

  await c.run("download");
  const items = await waitDownload(c, "done", 60);
  await c.check("the file downloads with the page's cookie and address", items, await c.downloadsList());
  if (items) {
    const item = items[0]!;
    const file = item.file !== "-" ? item.file : null;
    const filmSize = statSync(path.join(ROOT, "fixtures/film.mp4")).size;
    await c.check("the whole file arrived", fileSize(file) === filmSize, `${file}: ${fileSize(file)} of ${filmSize}`);
    await c.check("it's named after the film and quality", /Test Movie|Тестовый/.test(item.name ?? ""), item.name);
    // The Mac's ~/Movies/Cineon; here the browser's downloads folder, Cineon/ inside it.
    await c.check("it's in the downloads folder", Boolean(file?.startsWith(path.join(c.downloadsDir, "Cineon"))), `${file} (folder ${c.downloadsDir})`);
    await c.check("its subtitles are saved too", item.subtitles === "1", item.subtitles);
    const label = await c.evaluate("(() => { const h = document.querySelector('cineon-download'); return h ? 'present' : 'gone' })()");
    await c.check("the button stays to say it's saved", label === "present", label);

    c.heading("Downloads: playing the copy on this Mac");
    for (const name of [
      "the native player starts",
      "the screen stays on in the native player too",
      "downloaded subtitles show in the player",
      "ambient light follows the downloaded film",
    ]) {
      c.skip(name, NO_PLAYER);
    }
    await c.check("the download is linked to a title in the library", item.title !== "-1", item.title);
    for (const name of ["leaving the player lets the Mac sleep", "its place is kept", "watching it goes on the timeline"]) c.skip(name, NO_PLAYER);
  }

  c.heading("Downloads: a film that only streams as a playlist");
  await c.openPage("/hls-film");
  await c.startPlaying();
  const text = await c.waitUntil(async () => {
    const t = await c.run("downloads");
    const line = t.split("\n").find((l) => l.startsWith("best=")) ?? "";
    return line.startsWith("best=http") ? t : null;
  }, 15);
  const playlist = (text ?? "").split("\n").find((l) => l.startsWith("best=")) ?? "";
  await c.check("the playlist is found", playlist.endsWith("/hls/index.m3u8"), playlist);
  await c.run("download");
  const stream = await c.waitUntil(async () => {
    const list = await c.downloadsList();
    return list.length && list[0]!.kind === "hls" && ["done", "failed"].includes(list[0]!.status) ? list : null;
  }, 180, 2);
  // The Mac keeps a stream as a .movpkg package; the extension joins it into one MPEG-TS (or MP4) file.
  const saved = stream?.[0];
  await c.check(
    "the stream saves as one file",
    saved && saved.status === "done" && /\.(ts|mp4)$/.test(saved.file ?? "") && fileSize(saved.file) > 1_000_000,
    stream ?? (await c.downloadsList()),
  );
  await c.mediaEval("document.querySelector('video').pause(); true");
  await c.closeTab();
});

test("[season] a whole season", async ({ cineon: c }) => {
  test.setTimeout(minutes(8));
  c.heading("Downloads: a whole season, then watching it");
  await c.freshProfile("Season");
  await c.openPage("/series/drama/1-mentalist-2008.html#t:238-s:3-e:5");
  await c.startPlaying(30);
  await c.waitUntil(async () => (await c.state()).track !== "-1", 15);
  await c.run("season", { from: "all" });
  const done = await c.waitUntil(async () => {
    const f = await c.fields("seasonstate");
    return f.finished === "true" ? f : null;
  }, 150, 2);
  await c.check("every episode on the page is found", done && done.episodes === "S3 E5,S3 E6,S3 E7", await c.run("seasonstate"));
  await c.check("and each one queued", done && done.queued === "S3 E5,S3 E6,S3 E7", await c.run("seasonstate"));
  const items = await allDone(c, 3, 120);
  await c.check("the three episodes download, two at a time", items, await c.downloadsList());
  if (!items) return;
  const sources = items.map((i) => fileName(i.source!)).sort();
  await c.check("each from its own file", JSON.stringify(sources) === JSON.stringify(["film.mp4", "film.mp4?e=6", "film.mp4?e=7"]), sources);
  for (const name of ["the next downloaded episode is offered at the end", "and plays", "the watched episode goes to the Bin"]) c.skip(name, NO_PLAYER);
  await c.closeTab();
});

test("[series] a whole series, and carrying on after the browser closes", async ({ cineon: c }) => {
  test.setTimeout(minutes(14));
  c.heading("Downloads: a whole series");
  await c.freshProfile("Series");
  await c.openPage(SERIES_PAGE);
  await c.startPlaying(30);
  await c.waitUntil(async () => (await c.state()).track !== "-1", 15);
  await c.run("season", { from: "series" });
  const asked = await c.waitUntil(async () => {
    const f = await c.fields("seasonstate");
    return f.proposal !== "-" ? f : null;
  }, 60, 1);
  await c.check("every season is found, the hidden one too", asked && asked.proposal === SERIES_EPISODES, await c.run("seasonstate"));
  await c.check(
    "and it asks first, with a size",
    asked && Number(asked.proposalBytes) > 0 && (await c.fields("seasonstate")).running === "false",
    await c.run("seasonstate"),
  );
  await c.run("seasonconfirm");
  const done = await c.waitUntil(async () => {
    const f = await c.fields("seasonstate");
    return f.finished === "true" ? f : null;
  }, 180, 2);
  await c.check("saying yes gets every episode of both seasons", done && done.queued === SERIES_EPISODES, await c.run("seasonstate"));
  const items = await allDone(c, 5, 120);
  const sources = (items ?? []).map((i) => fileName(i.source!)).sort();
  await c.check(
    "each from its own file",
    JSON.stringify(sources) === JSON.stringify(["film.mp4?s=1&e=1", "film.mp4?s=1&e=2", "film.mp4?s=2&e=1", "film.mp4?s=2&e=2", "film.mp4?s=2&e=3"]),
    sources,
  );
  await c.closeTab();

  // The Mac kills the app with -9 and opens it again; here the browser is killed and started again on
  // the same profile, which is what "Cineon closed" means for an extension.
  c.heading("Downloads: a whole series, carried on after the browser closes");
  await c.freshProfile("Series again");
  await c.openPage(SERIES_PAGE);
  await c.startPlaying(30);
  await c.waitUntil(async () => (await c.state()).track !== "-1", 15);
  await c.run("season", { from: "series" });
  await c.waitUntil(async () => (await c.fields("seasonstate")).proposal !== "-", 60, 1);
  await c.run("seasonconfirm");
  const started = await c.waitUntil(async () => !["-", ""].includes((await c.fields("seasonstate")).queued), 60, 0.5);
  await c.check("a series job starts", started, await c.run("seasonstate"));
  await c.restart();
  const after = await c.waitUntil(async () => {
    const f = await c.fields("seasonstate");
    return f.label !== "-" ? f : null;
  }, 20);
  await c.check("after a crash it's still there, paused", after && after.paused === "true" && after.finished === "false", await c.run("seasonstate"));
  await c.run("seasonresume");
  const resumed = await c.waitUntil(async () => {
    const f = await c.fields("seasonstate");
    return f.finished === "true" ? f : null;
  }, 180, 2);
  await c.check("carrying on gets the rest", resumed && resumed.queued === SERIES_EPISODES, await c.run("seasonstate"));
  const finished = await allDone(c, 5, 120);
  await c.check("with every episode downloaded once and nothing left stopped", finished && finished.length === 5, await c.downloadsList());
  await c.closeTab();
});
