// Port of Cineon.Core.Tests/Downloads/HlsTests.cs: streams saved as one file, playlists, quality,
// AES-128, byte ranges, carrying on after a failure, plus what's new here: the OPFS parts surviving
// a browser restart and a hand-off to chrome.downloads that failed.

import { DownloadErrors, HlsDownloader, HlsMaster, HlsPlaylist, HlsVariant, StreamHost } from "../../src/core/downloads";
import { DownloadRig, type FakeOpfsDirectory, FakeServer, until } from "./fakes";
import { PartStore } from "../../src/core/downloads";

const segments = Array.from({ length: 6 }, (_, i) => FakeServer.random(1_000 + i * 37, 100 + i));
const joined = concat(segments);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function mediaPlaylist(extra = "", sequence = 0): string {
  return (
    "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n" +
    `#EXT-X-MEDIA-SEQUENCE:${sequence}\n` +
    extra +
    segments.map((_, i) => `#EXTINF:5.5,\n1080.mp4:hls:seg-${i}.ts\n`).join("") +
    "#EXT-X-ENDLIST\n"
  );
}

describe("HLS playlists", () => {
  test("the Mac's quality is picked", () => {
    const master = HlsPlaylist.parseMaster(
      `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480
480/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
https://other.test/1080/index.m3u8?token=a,b
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
720/index.m3u8`,
      "https://cdn.test/hls/master.m3u8",
    );
    expect(master.variants).toHaveLength(3);
    const best = HlsMaster.best(master)!;
    expect(best.url).toBe("https://other.test/1080/index.m3u8?token=a,b");
    expect(HlsVariant.height(best)).toBe(1080);
    expect(best.codecs).toBe("avc1.640028,mp4a.40.2");
    expect(master.variants[0]!.url).toBe("https://cdn.test/hls/480/index.m3u8");
  });

  test("qualities with their own sound come first", () => {
    const master = HlsPlaylist.parseMaster(
      `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=6000000,AUDIO="aud"
1080.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000
720.m3u8`,
      "https://cdn.test/m.m3u8",
    );
    expect(HlsMaster.best(master)!.url).toBe("https://cdn.test/720.m3u8");
  });

  test("playlist lines become addresses", () => {
    const base = "https://cdn.test/a/b/index.m3u8?t=1";
    expect(HlsPlaylist.resolve(base, "1080.mp4:hls:seg-1.ts")).toBe("https://cdn.test/a/b/1080.mp4:hls:seg-1.ts");
    expect(HlsPlaylist.resolve(base, "/x/seg.ts")).toBe("https://cdn.test/x/seg.ts");
    expect(HlsPlaylist.resolve(base, "../seg.ts")).toBe("https://cdn.test/a/seg.ts");
    expect(HlsPlaylist.resolve(base, "//edge.test/s.ts")).toBe("https://edge.test/s.ts");
    expect(HlsPlaylist.resolve(base, "http://edge.test/s.ts?a=1")).toBe("http://edge.test/s.ts?a=1");
    const attributes = HlsPlaylist.attributes('METHOD=AES-128,URI="https://k.test/key?id=1,2",IV=0x0000000000000000000000000000000A');
    expect(attributes.URI).toBe("https://k.test/key?id=1,2");
    expect(attributes.IV).toBe("0x0000000000000000000000000000000A");
  });

  test("media playlists keep keys, sequence numbers, ranges and maps", () => {
    const playlist = HlsPlaylist.parseMedia(
      `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-MAP:URI="init.mp4",BYTERANGE="300@0"
#EXT-X-KEY:METHOD=AES-128,URI="k",IV=0x0A
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:4.5,title
#EXT-X-BYTERANGE:100@300
a.m4s
#EXTINF:5,
#EXT-X-BYTERANGE:50
a.m4s
#EXT-X-ENDLIST`,
      "https://cdn.test/v/index.m3u8",
    );
    expect(playlist.targetDuration).toBe(6);
    expect(playlist.endList).toBe(true);
    const [first, second] = playlist.segments;
    expect(first!.sequence).toBe(7);
    expect(second!.sequence).toBe(8);
    expect(first!.duration).toBe(4.5);
    // The DRM key beside the plain one doesn't replace it.
    expect(first!.key!.method).toBe("AES-128");
    expect(first!.key!.url).toBe("https://cdn.test/v/k");
    expect(first!.key!.iv![15]).toBe(10);
    expect(first!.range).toEqual({ length: 100, offset: 300 });
    expect(second!.range).toEqual({ length: 50, offset: 400 });
    expect(first!.map).toEqual({ url: "https://cdn.test/v/init.mp4", range: { length: 300, offset: 0 }, key: null });
    expect(HlsDownloader.sequenceIv(258)).toEqual(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]));
  });
});

describe("HLS downloads", () => {
  let rig: DownloadRig;
  beforeEach(async () => {
    rig = await DownloadRig.make();
  });
  afterEach(() => rig.dispose());

  const server = () => rig.server;
  const center = () => rig.center;

  function serveMaster(): void {
    server().text(
      "/hls/master.m3u8",
      `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480
480/index.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,URI="iframes.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
720/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,AUDIO="aud"
1080/index.m3u8`,
    );
  }

  function serveSegments(folder: string, body?: (i: number) => Uint8Array): void {
    segments.forEach((segment, i) => server().bytes(`/hls/${folder}/1080.mp4:hls:seg-${i}.ts`, body?.(i) ?? segment, "video/mp2t"));
  }

  /** The stream's OPFS folder, `cineon-partial/<key>.hls`. */
  function partFolder(): FakeOpfsDirectory | null {
    const partial = rig.opfs.at(PartStore.folderName);
    const name = partial == null ? undefined : [...partial.children.keys()].find((n) => n.endsWith(".hls"));
    return name == null ? null : partial!.at(name);
  }

  test("a stream is saved as one .ts file", async () => {
    serveMaster();
    server().text("/hls/720/index.m3u8", mediaPlaylist());
    serveSegments("720");
    const item = await rig.enqueue("https://cdn.test/hls/master.m3u8", { kind: "hls" });
    expect(item.kind).toBe("hls");
    await center().idle();

    const saved = center().item(item.id)!;
    expect(saved.status).toBe("done");
    expect(saved.file).toBe(DownloadRig.path("Arrival.ts"));
    expect(rig.browser.file(saved.file!)).toEqual(joined);
    expect(saved.duration).toBeCloseTo(33, 3);
    expect(saved.totalBytes).toBe(joined.length);
    expect((await rig.db.allDownloads())[0]!.kind).toBe("hls");
    // Nothing asked for the other qualities.
    expect(server().count("/hls/480/index.m3u8") + server().count("/hls/1080/index.m3u8")).toBe(0);
    // Every request carried the page's Referer, and its Origin (another site than the CDN).
    for (const r of server().requests) {
      expect(r.headers.referer).toBe("https://site.test/film/arrival");
      expect(r.headers.origin).toBe("https://site.test");
    }
    // The parts are gone, the object URL let go of, and the header rules removed.
    await rig.streams.idle();
    await until(() => partFolder() == null);
    expect(rig.objectUrls.blobs.size).toBe(0);
    expect(rig.dnr.rules).toEqual([]);
  });

  test("AES-128 segments are decrypted", async () => {
    const key = FakeServer.random(16, 7);
    const iv = FakeServer.random(16, 8);
    server().bytes("/keys/k1", key);
    // The first two carry their IV; the rest use their sequence number, from 10.
    const playlist =
      "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:10\n" +
      `#EXT-X-KEY:METHOD=AES-128,URI="/keys/k1?t=abc",IV=0x${hex(iv)}\n` +
      "#EXTINF:5,\n1080.mp4:hls:seg-0.ts\n#EXTINF:5,\n1080.mp4:hls:seg-1.ts\n" +
      '#EXT-X-KEY:METHOD=AES-128,URI="/keys/k1?t=abc"\n' +
      [2, 3, 4].map((i) => `#EXTINF:5,\n1080.mp4:hls:seg-${i}.ts\n`).join("") +
      "#EXT-X-KEY:METHOD=NONE\n#EXTINF:5,\n1080.mp4:hls:seg-5.ts\n#EXT-X-ENDLIST\n";
    server().text("/hls/enc/index.m3u8", playlist);
    const encrypted = await Promise.all(
      segments.map((s, i) =>
        i < 2 ? FakeServer.encrypt(s, key, iv) : i < 5 ? FakeServer.encrypt(s, key, HlsDownloader.sequenceIv(10 + i)) : Promise.resolve(s),
      ),
    );
    serveSegments("enc", (i) => encrypted[i]!);
    const item = await rig.enqueue("https://cdn.test/hls/enc/index.m3u8", { kind: "hls" });
    await center().idle();

    const saved = center().item(item.id)!;
    expect(saved.status).toBe("done");
    expect(rig.browser.file(saved.file!)).toEqual(joined);
    // The key is fetched once, with the page's headers.
    expect(server().count("/keys/k1")).toBe(1);
    expect(server().last("/keys/k1").headers.referer).toBe("https://site.test/film/arrival");
  });

  test("a failed stream carries on where it stopped", async () => {
    server().text("/hls/720/index.m3u8", mediaPlaylist());
    serveSegments("720");
    let failing = true;
    server().route("/hls/720/1080.mp4:hls:seg-3.ts", async (request) => {
      await new Promise((r) => setTimeout(r, 20));
      return failing ? { status: 500 } : FakeServer.serve(request, segments[3]!);
    });
    const item = await rig.enqueue("https://cdn.test/hls/720/index.m3u8", { kind: "hls" });
    await center().idle();

    const failed = center().item(item.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("The site answered with an error (500).");
    expect(server().count("/hls/720/1080.mp4:hls:seg-3.ts")).toBe(rig.streams.hls.attempts);
    const before = segments.map((_, i) => server().count(`/hls/720/1080.mp4:hls:seg-${i}.ts`));

    failing = false;
    center().retry(item.id);
    await center().idle();

    const done = center().item(item.id)!;
    expect(done.status).toBe("done");
    expect(rig.browser.file(done.file!)).toEqual(joined);
    // Only the segment that failed is fetched again.
    segments.forEach((_, i) => expect(server().count(`/hls/720/1080.mp4:hls:seg-${i}.ts`) - before[i]!).toBe(i === 3 ? 1 : 0));
  });

  test("stopping a stream keeps its segments", async () => {
    server().text("/hls/720/index.m3u8", mediaPlaylist());
    serveSegments("720");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server().route("/hls/720/1080.mp4:hls:seg-5.ts", async (request) => {
      await gate;
      return FakeServer.serve(request, segments[5]!);
    });
    const item = await rig.enqueue("https://cdn.test/hls/720/index.m3u8", { kind: "hls" });
    await until(() => server().count("/hls/720/1080.mp4:hls:seg-5.ts") > 0);
    await new Promise((r) => setTimeout(r, 50));
    center().cancel(item.id);
    await center().idle();
    await rig.streams.idle();
    expect(center().item(item.id)!.error).toBe("Stopped");
    expect(partFolder()!.fileNames().filter((n) => n.startsWith("seg-")).length).toBeGreaterThanOrEqual(4);

    release();
    center().retry(item.id);
    await center().idle();
    expect(rig.browser.file(center().item(item.id)!.file!)).toEqual(joined);
    expect(server().count("/hls/720/1080.mp4:hls:seg-0.ts")).toBe(1);
  });

  test("fragmented MP4 becomes an .mp4", async () => {
    const init = FakeServer.random(300, 50);
    server().bytes("/f/init.mp4", init);
    server().text(
      "/f/index.m3u8",
      '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nseg-1.m4s\n#EXTINF:6,\nseg-2.m4s\n#EXT-X-ENDLIST\n',
    );
    server().bytes("/f/seg-1.m4s", segments[0]!);
    server().bytes("/f/seg-2.m4s", segments[1]!);
    const item = await rig.enqueue("https://cdn.test/f/index.m3u8", { kind: "hls" });
    await center().idle();
    const saved = center().item(item.id)!;
    expect(saved.file).toBe(DownloadRig.path("Arrival.mp4"));
    expect(rig.browser.file(saved.file!)).toEqual(concat([init, segments[0]!, segments[1]!]));
  });

  test("byte ranges are cut from one file", async () => {
    server().bytes("/r/all.ts", joined, "video/mp2t");
    const lines = ["#EXTM3U", "#EXT-X-TARGETDURATION:6", "#EXT-X-VERSION:4"];
    let offset = 0;
    for (const segment of segments) {
      lines.push("#EXTINF:5,");
      // The first names its offset; the rest follow on.
      lines.push(offset === 0 ? `#EXT-X-BYTERANGE:${segment.length}@0` : `#EXT-X-BYTERANGE:${segment.length}`);
      lines.push("all.ts");
      offset += segment.length;
    }
    lines.push("#EXT-X-ENDLIST");
    server().text("/r/index.m3u8", lines.join("\n"));
    const item = await rig.enqueue("https://cdn.test/r/index.m3u8", { kind: "hls" });
    await center().idle();
    expect(rig.browser.file(center().item(item.id)!.file!)).toEqual(joined);
    expect(server().count("/r/all.ts")).toBe(segments.length);
  });

  test.each([
    ['#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key",KEYFORMAT="com.apple.streamingkeydelivery"\n'],
    ['#EXT-X-KEY:METHOD=SAMPLE-AES,URI="/k"\n'],
  ])("protected streams say so: %s", async (key) => {
    server().text("/p/index.m3u8", mediaPlaylist(key));
    const item = await rig.enqueue("https://cdn.test/p/index.m3u8", { kind: "hls" });
    await center().idle();
    expect(center().item(item.id)!.error).toBe(DownloadErrors.protected);
  });

  test("sound kept apart is explained", async () => {
    server().text(
      "/s/master.m3u8",
      `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=6000000,AUDIO="aud"
1080.m3u8`,
    );
    const item = await rig.enqueue("https://cdn.test/s/master.m3u8", { kind: "hls" });
    await center().idle();
    expect(center().item(item.id)!.error).toBe(DownloadErrors.separateAudio);
  });

  test("an expired stream is a refusal", async () => {
    server().status("/gone/index.m3u8", 403);
    const item = await rig.enqueue("https://cdn.test/gone/index.m3u8", { kind: "hls" });
    await center().idle();
    expect(center().item(item.id)!.error).toBe("The site refused. The link may have expired: open the page and download again.");
  });

  test("progress follows the segments", async () => {
    server().text("/hls/720/index.m3u8", mediaPlaylist());
    serveSegments("720");
    const fractions: number[] = [];
    center().changed.on(() => fractions.push(...center().progress.values()));
    await rig.enqueue("https://cdn.test/hls/720/index.m3u8", { kind: "hls" });
    await center().idle();
    expect(fractions.some((f) => f > 0 && f < 1)).toBe(true);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
  });

  test("after the browser restarts, a stream carries on from its parts in OPFS", async () => {
    server().text("/hls/720/index.m3u8", mediaPlaylist());
    serveSegments("720");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server().route("/hls/720/1080.mp4:hls:seg-5.ts", async (request) => {
      await gate;
      return FakeServer.serve(request, segments[5]!);
    });
    const item = await rig.enqueue("https://cdn.test/hls/720/index.m3u8", { kind: "hls" });
    await until(() => (partFolder()?.fileNames().filter((n) => n.startsWith("seg-")).length ?? 0) === 5);

    // The browser closes: the service worker and the offscreen document go, OPFS stays.
    center().detach();
    rig.streams.setHandler(null);
    await rig.streams.stop([...(await rig.streams.jobs())][0]!.key);
    const worker = new StreamHost({
      parts: () => PartStore.open({ getDirectory: async () => rig.opfs } as unknown as StorageManager),
      fetch: rig.network.fetch,
      objectUrls: rig.objectUrls,
      progressInterval: 0,
    });
    const reopened = await rig.open({ streams: worker });
    expect(reopened.item(item.id)!.error).toBe("Stopped when Cineon closed");

    release();
    reopened.retry(item.id);
    await reopened.idle();
    const done = reopened.item(item.id)!;
    expect(done.status).toBe("done");
    expect(rig.browser.file(done.file!)).toEqual(joined);
    segments.forEach((_, i) => expect(server().count(`/hls/720/1080.mp4:hls:seg-${i}.ts`)).toBe(i === 5 ? 2 : 1));
  });

  test("a joined stream the browser couldn't save is handed over again without the network", async () => {
    server().text("/hls/720/index.m3u8", mediaPlaylist());
    serveSegments("720");
    rig.browser.failNextBlob = "FILE_NO_SPACE";
    const item = await rig.enqueue("https://cdn.test/hls/720/index.m3u8", { kind: "hls" });
    await center().idle();
    expect(center().item(item.id)!.error).toBe("Couldn't save into Cineon: there isn't enough room on the disk.");
    // Joined and kept: the segments are gone, the whole file stays for the next try.
    expect(partFolder()!.fileNames()).toEqual(["output.json", "output.part", "segments.txt"]);
    const asked = server().requests.length;

    center().retry(item.id);
    await center().idle();
    const done = center().item(item.id)!;
    expect(done.status).toBe("done");
    expect(done.file).toBe(DownloadRig.path("Arrival.ts"));
    expect(rig.browser.file(done.file!)).toEqual(joined);
    expect(server().requests.length).toBe(asked);
  });
});
