// The Chrome path for streams: the service worker's OffscreenStreamWorker and the offscreen
// document's StreamHost talking over chrome.runtime messaging (a fake bus here).

import { type StreamEvent } from "../../src/core/downloads";
import { ensureOffscreenDocument, type OffscreenApi, OffscreenStreamWorker } from "../../src/offscreen/client";
import { type MessageListener, type RuntimeMessaging } from "../../src/offscreen/protocol";
import { serveStreams } from "../../src/offscreen/server";
import { DownloadRig, FakeServer } from "./fakes";

/** chrome.runtime messaging between extension contexts: a message reaches every other context. */
class Bus {
  readonly contexts: Context[] = [];

  context(): Context {
    const context = new Context(this);
    this.contexts.push(context);
    return context;
  }
}

class Context implements RuntimeMessaging {
  private readonly listeners = new Set<MessageListener>();

  constructor(private readonly bus: Bus) {}

  readonly onMessage = {
    addListener: (listener: MessageListener) => void this.listeners.add(listener),
    removeListener: (listener: MessageListener) => void this.listeners.delete(listener),
  };

  sendMessage(message: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        let answered = false;
        let waiting = 0;
        for (const other of this.bus.contexts) {
          if (other === this) continue;
          for (const listener of other.listeners) {
            const keep = listener(structuredClone(message), {}, (response) => {
              if (answered) return;
              answered = true;
              resolve(structuredClone(response));
            });
            if (keep === true) waiting++;
          }
        }
        if (!answered && waiting === 0) reject(new Error("The message port closed before a response was received."));
      }, 0);
    });
  }
}

const segments = Array.from({ length: 4 }, (_, i) => FakeServer.random(700 + i, 40 + i));

test("streams run in the offscreen document and report to the service worker", async () => {
  const rig = await DownloadRig.make();
  try {
    const bus = new Bus();
    const worker = bus.context();
    const document = bus.context();
    // A page of the extension that listens too, and must not get in the way.
    bus.context().onMessage.addListener(() => undefined);

    rig.center.detach();
    serveStreams(rig.streams, document);
    let ensured = 0;
    const client = new OffscreenStreamWorker({
      runtime: worker,
      ensure: async () => void ensured++,
      exists: async () => true,
    });
    rig.center = await rig.open({ streams: client });

    rig.server.text(
      "/o/index.m3u8",
      "#EXTM3U\n#EXT-X-TARGETDURATION:4\n" + segments.map((_, i) => `#EXTINF:4,\nhttps://edge.othercdn.test/o/seg-${i}.ts\n`).join("") + "#EXT-X-ENDLIST\n",
    );
    segments.forEach((s, i) => rig.server.bytes(`/o/seg-${i}.ts`, s));
    const item = await rig.enqueue("https://cdn.test/o/index.m3u8", { kind: "hls" });
    await rig.center.idle();

    const done = rig.center.item(item.id)!;
    expect(done.status).toBe("done");
    expect(done.file).toBe(DownloadRig.path("Arrival.ts"));
    expect(rig.browser.file(done.file!)).toEqual(new Uint8Array(segments.flatMap((s) => [...s])));
    expect(ensured).toBeGreaterThan(0);
    // The segments are on another site than the playlist: the document asked the service worker
    // for the page's headers there before fetching them.
    expect(rig.server.last("/o/seg-3.ts").url).toBe("https://edge.othercdn.test/o/seg-3.ts");
    expect(rig.server.last("/o/seg-3.ts").headers.referer).toBe("https://site.test/film/arrival");
    expect(rig.server.last("/o/seg-3.ts").headers.origin).toBe("https://site.test");
    await rig.streams.idle();
    expect(await client.jobs()).toEqual([]);
  } finally {
    await rig.dispose();
  }
});

test("events that arrive before the center is ready wait for it", async () => {
  const bus = new Bus();
  const worker = bus.context();
  const document = bus.context();
  const client = new OffscreenStreamWorker({ runtime: worker, ensure: async () => {}, exists: async () => false });
  const event: StreamEvent = { type: "progress", key: "k", fraction: 0.5 };
  await document.sendMessage({ cineon: "stream-event", event }).catch(() => {});
  const seen: StreamEvent[] = [];
  client.setHandler({ hosts: async () => {}, event: (e) => seen.push(e) });
  expect(seen).toEqual([event]);
  // With no document open, nothing is asked of it.
  expect(await client.jobs()).toEqual([]);
  await client.stop("k");
});

test("a call the document doesn't know is refused", async () => {
  const rig = await DownloadRig.make();
  try {
    const bus = new Bus();
    const worker = bus.context();
    serveStreams(rig.streams, bus.context());
    expect(await worker.sendMessage({ cineon: "stream-call", method: "explode", args: [] })).toEqual({
      ok: false,
      error: "Unknown stream call explode",
    });
  } finally {
    await rig.dispose();
  }
});

test("the offscreen document is opened once, for blobs and workers", async () => {
  let open = false;
  const created: object[] = [];
  const api: OffscreenApi = {
    runtime: {
      getURL: (path) => `chrome-extension://cineontest/${path}`,
      getContexts: async () => (open ? [{}] : []),
    },
    offscreen: {
      createDocument: async (parameters) => {
        created.push(parameters);
        await new Promise((r) => setTimeout(r, 5));
        open = true;
      },
    },
  };
  await Promise.all([ensureOffscreenDocument(api), ensureOffscreenDocument(api), ensureOffscreenDocument(api)]);
  await ensureOffscreenDocument(api);
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ url: "offscreen.html", reasons: ["BLOBS", "WORKERS"] });
});
