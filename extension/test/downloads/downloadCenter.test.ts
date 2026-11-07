// Port of Cineon.Core.Tests/Downloads/DownloadCenterTests.cs: the queue, whole-file downloads and
// their records, against a fake chrome.downloads and a fake web, plus the extension's own parts:
// header rules, picking up after a service worker restart, deleting instead of the Bin.

import { DownloadItem, EpisodeRef } from "../../src/core/data";
import {
  chromeDownloads,
  DnrHeaderRules,
  DownloadCenter,
  DownloadErrors,
  MediaUrls,
  pageHeaders,
} from "../../src/core/downloads";
import { DownloadRig, FakeDnr, FakeServer, FakeTab, source, until } from "./fakes";
import { MemoryStorage } from "../../src/core/data";

let rig: DownloadRig;
beforeEach(async () => {
  rig = await DownloadRig.make();
});
afterEach(() => rig.dispose());

const server = () => rig.server;
const center = () => rig.center;

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

test("saves a file with the page's headers and records it", async () => {
  const film = FakeServer.random(300_000, 1);
  server().bytes("/a/1080.mp4", film, "video/mp4");

  const item = await rig.enqueue("https://media.cdn.test/a/1080.mp4", { name: "Severance", ref: EpisodeRef.make(1, 2) });
  await center().idle();

  const saved = center().item(item.id)!;
  expect(saved.status).toBe("done");
  expect(saved.file).toBe(DownloadRig.path("Severance S01E02 [1080p].mp4"));
  expect(rig.browser.file(saved.file!)).toEqual(film);
  expect(saved.totalBytes).toBe(film.length);
  expect(center().fraction(saved)).toBe(1);
  const [stored] = await rig.db.allDownloads();
  expect([stored!.status, stored!.file, stored!.totalBytes, stored!.quality]).toEqual(["done", saved.file, film.length, "1080p"]);

  // The browser's download carried the page's Referer and Origin (cookies and its name are the browser's own).
  const request = server().last("/a/1080.mp4");
  expect(request.from).toBe("download");
  expect(request.headers.referer).toBe("https://site.test/film/arrival");
  expect(request.headers.origin).toBe("https://site.test");
  expect(rig.browser.started[0]).toMatchObject({ filename: "Cineon/Severance S01E02 [1080p].mp4", conflictAction: "uniquify", saveAs: false });
  expect(rig.host.toasts).toContain("Saved Severance S01E02 [1080p]");
  // The rule lasted only as long as the download.
  expect(rig.dnr.rules).toEqual([]);
});

test("no Origin for the same site, and the Play action plays it", async () => {
  server().bytes("/f.mp4", new Uint8Array([1, 2, 3]));
  const item = await rig.enqueue("https://cdn.site.test/f.mp4");
  await center().idle();
  expect(server().last("/f.mp4").headers.origin).toBeUndefined();
  const saved = rig.host.actions.find((a) => a.message.startsWith("Saved"))!;
  expect(saved.title).toBe("Play");
  saved.action!();
  expect(rig.host.played.map((i) => i.id)).toEqual([item.id]);
});

test("two run at a time and the rest wait their turn", async () => {
  const gates = { "/1.mp4": gate(), "/2.mp4": gate(), "/3.mp4": gate() };
  for (const [path, g] of Object.entries(gates)) {
    server().route(path, async (request) => {
      await g.promise;
      return FakeServer.serve(request, new Uint8Array([1, 2, 3]));
    });
  }
  const first = await rig.enqueue("https://cdn.test/1.mp4", { name: "One" });
  const second = await rig.enqueue("https://cdn.test/2.mp4", { name: "Two" });
  const third = await rig.enqueue("https://cdn.test/3.mp4", { name: "Three" });

  await until(() => server().count("/1.mp4") === 1 && server().count("/2.mp4") === 1);
  expect(center().runningCount).toBe(2);
  expect(center().hasFreeSlot).toBe(false);
  expect(center().activeCount).toBe(3);
  expect(center().item(third.id)!.status).toBe("queued");
  expect(server().count("/3.mp4")).toBe(0);

  gates["/1.mp4"].open();
  await until(() => server().count("/3.mp4") === 1);
  gates["/2.mp4"].open();
  gates["/3.mp4"].open();
  await center().idle();
  for (const i of [first, second, third]) expect(center().item(i.id)!.status).toBe("done");
  // Newest first, like the Mac's list.
  expect(center().items.map((i) => i.id)).toEqual([third.id, second.id, first.id]);
});

test("a dropped file carries on with a Range request", async () => {
  const film = FakeServer.random(500_000, 2);
  let broken = true;
  server().route("/film.mp4", (request) =>
    broken && request.headers.range == null ? FakeServer.serve(request, film, "video/mp4", 200_000) : FakeServer.serve(request, film, "video/mp4"),
  );
  const item = await rig.enqueue("https://cdn.test/film.mp4");
  await center().idle();

  const failed = center().item(item.id)!;
  expect(failed.status).toBe("failed");
  expect(failed.error).toBe("The network connection was lost.");
  const [partial] = await rig.browser.search({ id: center().browserDownloadId(item.id)! });
  expect(partial!.bytesReceived).toBe(200_000);
  expect(partial!.canResume).toBe(true);

  broken = false;
  center().retry(item.id);
  await center().idle();

  const done = center().item(item.id)!;
  expect(done.status).toBe("done");
  expect(rig.browser.file(done.file!)).toEqual(film);
  expect(server().last("/film.mp4").headers.range).toBe("bytes=200000-");
  // The resumed request had the page's headers again.
  expect(server().last("/film.mp4").headers.referer).toBe("https://site.test/film/arrival");
});

test("a site that ignores Range starts again from the top", async () => {
  const film = FakeServer.random(50_000, 3);
  let broken = true;
  server().route("/plain.mp4", () =>
    broken ? { status: 200, headers: { "content-length": "50000" }, body: film, breakAfter: 20_000 } : { status: 200, body: film },
  );
  const item = await rig.enqueue("https://cdn.test/plain.mp4");
  await center().idle();
  broken = false;
  center().retry(item.id);
  await center().idle();
  expect(server().last("/plain.mp4").headers.range).toBe("bytes=20000-");
  expect(rig.browser.file(center().item(item.id)!.file!)).toEqual(film);
});

test("stopping keeps what was saved for later", async () => {
  const release = gate();
  server().route("/slow.mp4", async (request) => {
    await release.promise;
    return FakeServer.serve(request, new Uint8Array([1, 2, 3]));
  });
  const item = await rig.enqueue("https://cdn.test/slow.mp4");
  await until(() => server().count("/slow.mp4") === 1);
  center().cancel(item.id);
  await center().idle();
  const stopped = center().item(item.id)!;
  expect(stopped.status).toBe("failed");
  expect(stopped.error).toBe("Stopped");
  // Paused in the browser, ready to carry on.
  const [paused] = await rig.browser.search({ id: center().browserDownloadId(item.id)! });
  expect(paused!.paused).toBe(true);
  release.open();

  center().retry(item.id);
  await center().idle();
  expect(center().item(item.id)!.status).toBe("done");
  expect(rig.browser.started).toHaveLength(1);
});

test("stopping a queued download needs no network", async () => {
  const busy = gate();
  server().route("/busy.mp4", async (request) => {
    await busy.promise;
    return FakeServer.serve(request, new Uint8Array([1]));
  });
  await rig.enqueue("https://cdn.test/busy.mp4", { name: "A" });
  await rig.enqueue("https://cdn.test/busy.mp4", { name: "B" });
  const waiting = await rig.enqueue("https://cdn.test/never.mp4", { name: "C" });
  center().cancel(waiting.id);
  expect(center().item(waiting.id)!.status).toBe("failed");
  expect(center().item(waiting.id)!.error).toBe("Stopped");
  busy.open();
  await center().idle();
  expect(server().count("/never.mp4")).toBe(0);
});

test.each([
  [403, "The site refused. The link may have expired: open the page and download again."],
  [401, "The site refused. The link may have expired: open the page and download again."],
  [404, "The file is gone from the site."],
  [410, "The file is gone from the site."],
  [503, "The site answered with an error (503)."],
])("refusals say what happened: %i", async (status, message) => {
  server().status("/x.mp4", status);
  const item = await rig.enqueue("https://cdn.test/x.mp4");
  await center().idle();
  expect(center().item(item.id)!.status).toBe("failed");
  expect(center().item(item.id)!.error).toBe(message);
  expect((await rig.db.allDownloads())[0]!.error).toBe(message);
});

test("the browser's interruptions are worded as the apps word failures", () => {
  expect(DownloadErrors.interruption("SERVER_FORBIDDEN")).toBe(DownloadErrors.explain(403));
  expect(DownloadErrors.interruption("NETWORK_TIMEOUT")).toBe("The request timed out.");
  expect(DownloadErrors.interruption("NETWORK_SERVER_DOWN")).toBe("Could not connect to the server.");
  expect(DownloadErrors.interruption("SERVER_UNREACHABLE")).toBe("A server with the specified hostname could not be found.");
  expect(DownloadErrors.interruption("USER_SHUTDOWN")).toBe("Stopped when Cineon closed");
  expect(DownloadErrors.interruption("FILE_NO_SPACE")).toBe("Couldn't save into Cineon: there isn't enough room on the disk.");
  expect(DownloadErrors.interruption("FILE_FAILED")).toBe("Couldn't save into Cineon: the file couldn't be written.");
  expect(DownloadErrors.interruption("SERVER_FAILED")).toBe("The site answered with an error.");
});

test("HDRezka's segments are traced back to the whole file", async () => {
  server().bytes("/cdn/stream/1080.mp4", new Uint8Array([9, 9, 9]));
  expect(MediaUrls.progressive("https://x.test/cdn/stream/1080.mp4:hls:seg-1-v1-a1.ts?t=1")).toBe("https://x.test/cdn/stream/1080.mp4?t=1");
  expect(MediaUrls.kindOf(MediaUrls.progressive("https://x.test/cdn/stream/1080.mp4:hls:seg-1-v1-a1.ts"))).toBe("file");
  expect(MediaUrls.kindOf("https://x.test/v/seg-12.m4s")).toBeNull();
  expect(MediaUrls.kindOf("https://x.test/master.m3u8?x=1")).toBe("hls");
  expect(MediaUrls.kindOf("https://x.test/subs/en.vtt#t")).toBe("subtitle");

  const item = await rig.enqueue("https://x.test/cdn/stream/1080.mp4:hls:seg-1-v1-a1.ts", { name: "Mayday" });
  expect(item.sourceUrl).toBe("https://x.test/cdn/stream/1080.mp4");
  await center().idle();
  expect(center().item(item.id)!.file).toBe(DownloadRig.path("Mayday [1080p].mp4"));
});

test("subtitles are saved beside the film", async () => {
  server().bytes("/f.mp4", new Uint8Array([1, 2]));
  server().text("/subs/film_eng.vtt", "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n", "text/vtt");
  server().text("/s/1234.srt", "1\n00:00:01,000 --> 00:00:02,000\nHi\n", "text/plain");
  server().status("/s/missing.vtt", 404);
  const item = await rig.enqueue("https://cdn.test/f.mp4", {
    subtitles: ["https://cdn.test/subs/film_eng.vtt", "https://cdn.test/s/1234.srt", "https://cdn.test/s/missing.vtt"],
  });
  await center().idle();
  const saved = center().item(item.id)!;
  expect(saved.subtitles).toEqual([DownloadRig.path("Arrival.en.vtt"), DownloadRig.path("Arrival.sub2.srt")]);
  for (const path of saved.subtitles) expect(rig.browser.file(path)).toBeDefined();
  expect(new TextDecoder().decode(rig.browser.file(saved.subtitles[0]!))).toContain("WEBVTT");
  expect((await rig.db.allDownloads())[0]!.subtitles).toEqual(saved.subtitles);
  // Fetched as the page would, and the temporary addresses let go of.
  expect(server().last("/subs/film_eng.vtt").headers.referer).toBe("https://site.test/film/arrival");
  expect(rig.objectUrls.blobs.size).toBe(0);
  expect(rig.dnr.rules).toEqual([]);
});

test("the same name gets a number, and the extension comes from the address", async () => {
  server().bytes("/a/film.webm", new Uint8Array([1]));
  server().bytes("/b.mkv", new Uint8Array([2]));
  const first = await rig.enqueue("https://cdn.test/a/film.webm");
  await center().idle();
  const second = await rig.enqueue("https://cdn.test/b.mkv");
  const third = await rig.enqueue("https://cdn.test/b.mkv");
  await center().idle();
  expect(center().item(first.id)!.file).toBe(DownloadRig.path("Arrival.webm"));
  expect([center().item(second.id)!.file, center().item(third.id)!.file].sort()).toEqual(
    [DownloadRig.path("Arrival.mkv"), DownloadRig.path("Arrival 2.mkv")].sort(),
  );
  expect(DownloadCenter.unique("Name.en.vtt", (n) => n === "Name.en.vtt")).toBe("Name.en 2.vtt");
  expect(DownloadCenter.unique("Name.mp4", (n) => n === "Name.mp4" || n === "Name 2.mp4")).toBe("Name 3.mp4");
  expect(DownloadCenter.extension("film.webm", "https://x.test/a")).toBe("webm");
  expect(DownloadCenter.extension(null, "https://x.test/a.MOV?x=1")).toBe("mov");
  expect(DownloadCenter.extension(null, "https://x.test/a.ts")).toBe("mp4");
});

test("what was running when Cineon closed is marked stopped", async () => {
  const item = DownloadItem.make({ sourceUrl: "https://cdn.test/a.mp4", name: "Arrival", status: "downloading", createdAt: Date.now() / 1000 });
  const id = await rig.db.insertDownload(item);
  await rig.db.insertDownload({ ...item, status: "done" });
  const reopened = await rig.open();
  expect(reopened.item(id)!.error).toBe("Stopped when Cineon closed");
  await reopened.idle();
  expect((await rig.db.allDownloads()).find((d) => d.id === id)!.status).toBe("failed");
  expect(reopened.activeCount).toBe(0);
});

test("a service worker that restarts picks up what's still running and what waits", async () => {
  await rig.dispose();
  rig = await DownloadRig.make({ session: true });
  const g = { "/1.mp4": gate(), "/2.mp4": gate() };
  for (const [path, x] of Object.entries(g)) {
    server().route(path, async (request) => {
      await x.promise;
      return FakeServer.serve(request, new Uint8Array([7, 7]));
    });
  }
  server().bytes("/3.mp4", new Uint8Array([3]));
  const one = await rig.enqueue("https://cdn.test/1.mp4", { name: "One" });
  const two = await rig.enqueue("https://cdn.test/2.mp4", { name: "Two" });
  const three = await rig.enqueue("https://cdn.test/3.mp4", { name: "Three" });
  await until(() => server().count("/1.mp4") === 1 && server().count("/2.mp4") === 1);

  // The service worker stops; the browser's downloads carry on.
  center().detach();
  const restarted = await rig.open({ session: true });
  expect(restarted.item(one.id)!.status).toBe("downloading");
  expect(restarted.item(three.id)!.status).toBe("queued");
  // Its rule is still there for the next request (a redirect, a resume).
  expect(rig.dnr.rules.length).toBeGreaterThan(0);

  g["/1.mp4"].open();
  g["/2.mp4"].open();
  await restarted.idle();
  for (const i of [one, two, three]) expect(restarted.item(i.id)!.status).toBe("done");
});

test("removing deletes the files and forgets the download", async () => {
  server().bytes("/f.mp4", new Uint8Array([1, 2]));
  server().text("/en.vtt", "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n");
  const item = await rig.enqueue("https://cdn.test/f.mp4", { subtitles: ["https://cdn.test/en.vtt"] });
  await center().idle();
  const saved = center().item(item.id)!;
  const removed = center().remove(item.id);
  expect(center().item(item.id)).toBeNull();
  await removed;
  expect(rig.browser.removed).toEqual([saved.file!, ...saved.subtitles]);
  expect(rig.browser.file(saved.file!)).toBeUndefined();
  expect(await rig.db.allDownloads()).toEqual([]);
  // Gone from the browser's list too.
  expect(await rig.browser.search({})).toEqual([]);
});

test("removing a failed download clears its partial file", async () => {
  const film = FakeServer.random(10_000, 4);
  server().route("/f.mp4", (request) => FakeServer.serve(request, film, "video/mp4", 4_000));
  const item = await rig.enqueue("https://cdn.test/f.mp4");
  await center().idle();
  const browserId = center().browserDownloadId(item.id)!;
  expect((await rig.browser.search({ id: browserId }))[0]!.bytesReceived).toBe(4_000);
  await center().remove(item.id);
  expect(await rig.browser.search({ id: browserId })).toEqual([]);
});

test("episodes follow on, and watched ones are deleted", async () => {
  server().bytes("/e.mp4", new Uint8Array([1]));
  const title = (await rig.library.addTitle("Severance", { kind: "series" }))!;
  const e2 = await rig.enqueue("https://cdn.test/e.mp4", { name: "Severance", ref: EpisodeRef.make(1, 2), titleId: title.id });
  const e1 = await rig.enqueue("https://cdn.test/e.mp4", { name: "Severance", ref: EpisodeRef.make(1, 1), titleId: title.id });
  const e5 = await rig.enqueue("https://cdn.test/e.mp4", { name: "Severance", ref: EpisodeRef.make(2, 1), titleId: title.id });
  await center().idle();

  expect(center().nextEpisode(center().item(e1.id)!)?.id).toBe(e2.id);
  expect(center().nextEpisode(center().item(e2.id)!)?.id).toBe(e5.id);
  expect(center().nextEpisode(center().item(e5.id)!)).toBeNull();
  const file = center().item(e1.id)!.file!;
  expect(center().itemForFile(file)?.id).toBe(e1.id);

  center().notePlayback(e1.id, 42, 3000);
  await center().idle();
  expect((await rig.db.allDownloads()).find((d) => d.id === e1.id)!.position).toBe(42);
  await center().binWatched(e1.id);
  expect(center().item(e1.id)).toBeNull();
  expect(rig.host.toasts).toContain("Deleted Severance S01E01, since you've watched it");
  expect(rig.browser.file(file)).toBeUndefined();
});

test("downloading from a tab adds the title and knows what it has", async () => {
  server().bytes("/v/720.mp4", new Uint8Array([5, 5]));
  const tab = new FakeTab({
    url: "https://site.test/film/dune",
    displayTitle: "Dune",
    parsed: { name: "Dune", altName: "Дюна", year: 2021, kindHint: "film" },
    sourcesFrameUrl: "https://player.test/embed/1",
  });
  expect(await center().download(tab)).toBe(false);
  expect(rig.host.toasts).toContain("Play the video for a moment first, so Cineon can see its file");

  tab.sourceList.push(source("https://cdn.test/v/720.mp4"));
  tab.sourceList.push(source("https://cdn.test/v/en.vtt", "subtitle"));
  expect(await center().download(tab)).toBe(true);
  const [title] = [...rig.library.titles.values()];
  expect(title!.name).toBe("Dune");
  expect(rig.host.enriched).toEqual([{ id: title!.id, altName: "Дюна" }]);
  expect(rig.host.toasts).toContain("Downloading Dune [720p]");
  await center().idle();

  const [item] = center().items;
  expect(item!.titleId).toBe(title!.id);
  expect(item!.referer).toBe("https://player.test/embed/1");
  expect(item!.host).toBe("site.test");
  expect(center().existing(tab)?.id).toBe(item!.id);
  // The player frame is on another site than the CDN: it's the Origin too.
  expect(server().last("/v/720.mp4").headers.origin).toBe("https://player.test");

  // Asking again plays what's already here.
  expect(await center().download(tab)).toBe(true);
  expect(rig.host.played.map((i) => i.id)).toEqual([item!.id]);
});

test("a third download from a tab says it's queued", async () => {
  const busy = gate();
  server().route("/busy.mp4", async (request) => {
    await busy.promise;
    return FakeServer.serve(request, new Uint8Array([1]));
  });
  await rig.enqueue("https://cdn.test/busy.mp4", { name: "A" });
  await rig.enqueue("https://cdn.test/busy.mp4", { name: "B" });
  const tab = new FakeTab({ url: "https://site.test/film/dune", parsed: { name: "Dune" } });
  tab.sourceList.push(source("https://cdn.test/v/1080.mp4"));
  await center().download(tab);
  expect(rig.host.toasts).toContain("Queued Dune [1080p], after the ones running now");
  busy.open();
});

test("any file can be fetched as the page would", async () => {
  server().text("/s.vtt", "WEBVTT");
  const data = await center().fetch("https://cdn.test/s.vtt", "https://site.test/p");
  expect(new TextDecoder().decode(data!)).toBe("WEBVTT");
  expect(server().last("/s.vtt").headers.referer).toBe("https://site.test/p");
  expect(server().last("/s.vtt").headers.origin).toBe("https://site.test");
  expect(await center().fetch("https://cdn.test/none.vtt", null)).toBeNull();
  // With no page, no Referer, and not the extension's own Origin either.
  expect(server().last("/none.vtt").headers.referer).toBeUndefined();
  expect(server().last("/none.vtt").headers.origin).toBeUndefined();
  expect(rig.dnr.rules).toEqual([]);
});

test("a picked subtitle file is saved next to the film", async () => {
  server().bytes("/f.mp4", new Uint8Array([1]));
  const item = await rig.enqueue("https://cdn.test/f.mp4");
  await center().idle();
  const path = await center().addSubtitles(
    { name: "Arrival.ukr.srt", data: new TextEncoder().encode("1\n00:00:01,000 --> 00:00:02,000\nПривіт\n") },
    item.id,
  );
  expect(path).toBe(DownloadRig.path("Arrival.uk.srt"));
  expect(center().item(item.id)!.subtitles).toEqual([path]);
});

test("the duration is read once the file is saved", async () => {
  rig.host.duration = 5400;
  server().bytes("/f.mp4", new Uint8Array([1]));
  const item = await rig.enqueue("https://cdn.test/f.mp4");
  await center().idle();
  expect(center().item(item.id)!.duration).toBe(5400);
});

test("show in folder points the browser at the file, or the downloads folder", async () => {
  server().bytes("/f.mp4", new Uint8Array([1]));
  const item = await rig.enqueue("https://cdn.test/f.mp4");
  await center().idle();
  await center().showInFolder(center().item(item.id)!);
  expect(rig.browser.shown).toEqual([center().browserDownloadId(item.id)]);
  await center().showInFolder(DownloadItem.make({ sourceUrl: "https://x.test/a.mp4", id: 999 }));
  expect(rig.browser.shown[1]).toBe("folder");
});

test("a download cancelled in the browser's own list is stopped, and Try again starts afresh", async () => {
  const slow = gate();
  server().route("/c.mp4", async (request) => {
    await slow.promise;
    return FakeServer.serve(request, new Uint8Array([4, 4]));
  });
  const item = await rig.enqueue("https://cdn.test/c.mp4");
  await until(() => server().count("/c.mp4") === 1);
  await rig.browser.cancel(center().browserDownloadId(item.id)!);
  await until(() => center().item(item.id)!.status === "failed");
  expect(center().item(item.id)!.error).toBe("Stopped");
  slow.open();
  center().retry(item.id);
  await center().idle();
  expect(center().item(item.id)!.status).toBe("done");
  expect(rig.browser.started).toHaveLength(2);
});

test("chrome.downloads changes that come before the center listens are held for it", async () => {
  let fire!: (delta: { id: number }) => void;
  const calls: unknown[] = [];
  const api = {
    onChanged: { addListener: (l: (delta: { id: number }) => void) => (fire = l), removeListener: () => {} },
    search: async (query: unknown) => (calls.push(query), []),
  } as unknown as typeof chrome.downloads;
  const downloads = chromeDownloads(api);
  // The download finished while the service worker slept; this woke it.
  fire({ id: 4 });
  const seen: number[] = [];
  downloads.onChanged.addListener((d) => seen.push(d.id));
  fire({ id: 5 });
  expect(seen).toEqual([4, 5]);
  await downloads.search({ id: 4 });
  expect(calls).toEqual([{ id: 4 }]);
});

describe("the page's headers", () => {
  test("Referer always, Origin only for another site, like the apps", () => {
    expect(pageHeaders("https://site.test/film", "https://cdn.test/a.mp4")).toEqual({ referer: "https://site.test/film", origin: "https://site.test" });
    expect(pageHeaders("https://site.test:8443/film", "https://cdn.test/a.mp4").origin).toBe("https://site.test:8443");
    expect(pageHeaders("https://www.site.test/film", "https://cdn.site.test/a.mp4")).toEqual({ referer: "https://www.site.test/film", origin: null });
    expect(pageHeaders(null, "https://cdn.test/a.mp4")).toEqual({ referer: null, origin: null });
  });

  test("rules touch only the extension's own requests, and go when asked", async () => {
    const dnr = new FakeDnr();
    const session = new MemoryStorage();
    const rules = new DnrHeaderRules(dnr, { storage: session });
    await rules.add("a", { urls: ["https://cdn.test/a.mp4#t=1"], sites: ["media.cdn.test"] }, { referer: "https://site.test/", origin: "https://site.test" });
    expect(dnr.rules.map((r) => r.condition)).toEqual([
      { urlFilter: "|https://cdn.test/a.mp4|", tabIds: [-1] },
      { requestDomains: ["cdn.test"], tabIds: [-1] },
    ]);
    expect(dnr.rules.every((r) => r.id >= DnrHeaderRules.defaultFirstId)).toBe(true);
    // A tab's own requests keep their headers.
    expect(dnr.apply("https://cdn.test/a.mp4", { referer: "https://tab.test/" }, 5)).toEqual({ referer: "https://tab.test/" });
    expect(dnr.apply("https://x.cdn.test/seg.ts", {}, -1)).toEqual({ referer: "https://site.test/", origin: "https://site.test" });

    // Adding sites keeps what's there; another key gets other IDs.
    await rules.add("a", { sites: ["edge.test"] }, { referer: "https://site.test/", origin: "https://site.test" });
    await rules.add("b", { sites: ["other.test"] }, { referer: null, origin: null });
    expect(dnr.rules.find((r) => r.condition.requestDomains?.includes("edge.test"))!.condition.requestDomains).toEqual(["cdn.test", "edge.test"]);
    expect(new Set(dnr.rules.map((r) => r.id)).size).toBe(dnr.rules.length);
    expect(dnr.apply("https://other.test/x", { origin: "chrome-extension://x", referer: "chrome-extension://x/" }, -1)).toEqual({});

    // After a restart the map comes back from session storage.
    const again = new DnrHeaderRules(dnr, { storage: session });
    await again.remove("a");
    expect(dnr.rules.map((r) => r.condition.requestDomains)).toEqual([["other.test"]]);
    await dnr.updateSessionRules({ addRules: [{ id: 5, action: { type: "modifyHeaders", requestHeaders: [] }, condition: {} }] });
    await again.retainOnly([]);
    // Only rules in its own range go.
    expect(dnr.rules.map((r) => r.id)).toEqual([5]);

    // A profile's fresh start leaves another profile's rules alone.
    const page = { referer: "https://site.test/", origin: null };
    await again.add("file-aaaa-1", { sites: ["a.test"] }, page);
    await again.add("file-bbbb-1", { sites: ["b.test"] }, page);
    await again.retainOnly([], "aaaa");
    expect(dnr.rules.flatMap((r) => r.condition.requestDomains ?? [])).toEqual(["b.test"]);
  });
});
