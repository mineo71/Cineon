// Direct files in Chrome. Chrome's downloads never carry the page's Referer or Origin: no
// declarativeNetRequest rule, whatever its condition, reaches a downloads-API request, and the API
// refuses a Referer header of its own (both checked end-to-end in Chrome for Testing 156). A site that
// checks the Referer (HDRezka's CDN does) then refuses the download. So in Chrome the center fetches a
// direct file itself, where the rules do apply, the way it fetches a stream, and hands the browser the
// joined file.

import { EpisodeRef } from "../../src/core/data";
import { DownloadHttp, PartFolder, PartStore } from "../../src/core/downloads";
import { DownloadRig, FakeServer, until, type FakeRequest } from "./fakes";

let rig: DownloadRig;
beforeEach(async () => {
  rig = await DownloadRig.make({ chrome: true });
  rig.streams.hls.fileChunk = 64 * 1024;
});
afterEach(() => rig.dispose());

const PAGE = "https://site.test/film/arrival";
/** A CDN that answers only the page's own requests. */
const guarded = (data: Uint8Array, type = "video/mp4") => (request: FakeRequest) =>
  request.headers.referer === PAGE ? FakeServer.serve(request, data, type) : { status: 403 };

test("a file the site guards with the page's Referer is fetched with it, and saved whole under its name", async () => {
  const film = FakeServer.random(300_000, 1);
  rig.server.route("/a/1080.mp4", guarded(film));
  const types: string[] = [];
  const create = rig.objectUrls.create.bind(rig.objectUrls);
  rig.objectUrls.create = async (blob: Blob) => {
    types.push(blob.type);
    return create(blob);
  };

  const item = await rig.enqueue("https://media.cdn.test/a/1080.mp4", { name: "Severance", ref: EpisodeRef.make(1, 2) });
  await rig.center.idle();
  await rig.streams.idle();
  await rig.center.idle();

  const saved = rig.center.item(item.id)!;
  expect(saved.status).toBe("done");
  expect(saved.file).toBe(DownloadRig.path("Severance S01E02 [1080p].mp4"));
  expect(rig.browser.file(saved.file!)).toEqual(film);
  expect(saved.totalBytes).toBe(film.length);
  // Every request went from the extension, with the page's headers; none from the browser's downloads.
  const asked = rig.server.requests.filter((r) => r.path === "/a/1080.mp4");
  expect(asked.length).toBeGreaterThan(1);
  expect(asked.every((r) => r.from === "fetch" && r.headers.referer === PAGE && r.headers.origin === "https://site.test")).toBe(true);
  // Typed, so the browser keeps the .mp4 (an untyped blob is text to Chrome).
  expect(types).toEqual(["video/mp4"]);
  expect(rig.browser.started[0]).toMatchObject({ filename: "Cineon/Severance S01E02 [1080p].mp4", saveAs: false });
  // The rules, the parts and the object URL went with the download.
  await until(() => [...(rig.opfs.at(PartStore.folderName)?.children.keys() ?? [])].length === 0);
  expect(rig.objectUrls.blobs.size).toBe(0);
  expect(rig.dnr.rules).toEqual([]);
});

test("a server that answers ranges is fetched in parts", async () => {
  const film = FakeServer.random(200_000, 2);
  rig.server.route("/b.webm", guarded(film, "video/webm"));
  const item = await rig.enqueue("https://cdn.test/b.webm");
  await rig.center.idle();
  await rig.streams.idle();
  await rig.center.idle();
  const saved = rig.center.item(item.id)!;
  expect(saved.file).toBe(DownloadRig.path("Arrival.webm"));
  expect(rig.browser.file(saved.file!)).toEqual(film);
  const ranges = rig.server.requests.filter((r) => r.path === "/b.webm").map((r) => r.headers.range);
  // The first byte to learn the size, then 64 KiB parts.
  expect(ranges).toEqual(["bytes=0-0", "bytes=0-65535", "bytes=65536-131071", "bytes=131072-196607", "bytes=196608-199999"]);
});

test("a server that ignores Range is fetched once, whole", async () => {
  const film = FakeServer.random(150_000, 3);
  rig.server.route("/plain.mp4", (request) =>
    request.headers.referer === PAGE ? { status: 200, headers: { "content-length": String(film.length) }, body: film } : { status: 403 },
  );
  const item = await rig.enqueue("https://cdn.test/plain.mp4");
  await rig.center.idle();
  await rig.streams.idle();
  await rig.center.idle();
  expect(rig.browser.file(rig.center.item(item.id)!.file!)).toEqual(film);
  // The size probe, then the file.
  expect(rig.server.count("/plain.mp4")).toBe(2);
});

test("a refusal even with the page's headers says so, as the apps word it", async () => {
  rig.server.status("/gone.mp4", 403);
  const item = await rig.enqueue("https://cdn.test/gone.mp4");
  await rig.center.idle();
  await rig.streams.idle();
  await rig.center.idle();
  const failed = rig.center.item(item.id)!;
  expect(failed.status).toBe("failed");
  expect(failed.error).toBe("The site refused. The link may have expired: open the page and download again.");
});

test("a whole file goes to disk as it arrives, never all in memory", async () => {
  // The second chunk is only asked for once something reads the first; by then the first must be on
  // disk. A reader that gathered the whole response first would show no writes at that point.
  const written: number[] = [];
  const writesBeforeSecond: number[] = [];
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++;
        if (pulls === 1) controller.enqueue(new Uint8Array(1000).fill(1));
        else if (pulls === 2) {
          writesBeforeSecond.push(written.length);
          controller.enqueue(new Uint8Array(500).fill(2));
        } else controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const http = new DownloadHttp(async () => new Response(body, { status: 200 }));
  const file = {
    async createWritable() {
      return {
        async write(data: Uint8Array) {
          written.push(data.length);
        },
        async close() {},
        async abort() {},
      };
    },
  };
  const folder = new PartFolder("x.hls", { getFileHandle: async () => file } as unknown as ConstructorParameters<typeof PartFolder>[1]);

  const size = await folder.fill("output.part", (write) => http.getInto("https://cdn.test/plain.mp4", write));

  expect(size).toBe(1500);
  expect(written).toEqual([1000, 500]);
  expect(writesBeforeSecond).toEqual([1]);
});
