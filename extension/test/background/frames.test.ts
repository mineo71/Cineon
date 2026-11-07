import { EpisodeRef, UrlKey, WatchSession } from "../../src/core/data";
import { FrameCollector, FrameImage, type ImageHandle, type ImageOps, type Rect, dataUrlBytes } from "../../src/background/frames";
import type { LiveTrack, MediaEvent, TabState } from "../../src/background/tabState";
import { addTab, makeRig, type Rig } from "./rescueFakes";

const URL_ = "https://flix.example/watch/dune";

/** Images named by their bytes' text: "scene" has something in it, "black" doesn't. */
class FakeImages implements ImageOps {
  readonly samples: { tag: string; rect: Rect | null; width: number; height: number }[] = [];
  readonly jpegs: { tag: string; rect: Rect | null; maxPixel: number; quality: number }[] = [];
  sizes: Record<string, [number, number]> = { scene: [1280, 720], black: [1280, 720], shot: [2560, 1440], darkshot: [2560, 1440] };

  async decode(source: Uint8Array | string): Promise<ImageHandle | null> {
    const bytes = typeof source === "string" ? dataUrlBytes(source) : source;
    if (!bytes) return null;
    const tag = new TextDecoder().decode(bytes);
    const size = this.sizes[tag];
    if (!size) return null;
    return { width: size[0], height: size[1], tag } as ImageHandle;
  }

  async sample(image: ImageHandle, rect: Rect | null, width: number, height: number): Promise<Uint8ClampedArray> {
    const tag = (image as unknown as { tag: string }).tag;
    this.samples.push({ tag, rect, width, height });
    const pixels = new Uint8ClampedArray(width * height * 4);
    if (tag === "scene" || tag === "shot") {
      for (let p = 0; p < width * height; p++) {
        pixels[p * 4] = p % 2 === 0 ? 220 : 30;
        pixels[p * 4 + 1] = p % 3 === 0 ? 180 : 40;
        pixels[p * 4 + 2] = 90;
        pixels[p * 4 + 3] = 255;
      }
    }
    return pixels;
  }

  async jpeg(image: ImageHandle, rect: Rect | null, maxPixel: number, quality: number): Promise<Uint8Array> {
    this.jpegs.push({ tag: (image as unknown as { tag: string }).tag, rect, maxPixel, quality });
    return new Uint8Array([0xff, 0xd8, 0xff]);
  }
}

const dataUrl = (tag: string) => `data:image/jpeg;base64,${btoa(tag)}`;

function tick(position: number, fields: Partial<MediaEvent> = {}): MediaEvent {
  return {
    type: "tick",
    position,
    duration: 7000,
    paused: false,
    muted: false,
    rate: 1,
    width: 1920,
    height: 1080,
    isTopFrame: true,
    frameUrl: URL_,
    userActivated: true,
    ...fields,
  };
}

interface Setup {
  rig: Rig;
  frames: FrameCollector;
  images: FakeImages;
  tab: TabState;
  track: LiveTrack;
  capture: Record<string, unknown> | null;
}

async function setup(settings = {}): Promise<Setup> {
  const rig = await makeRig(settings);
  const images = new FakeImages();
  let n = 0;
  const frames = new FrameCollector(rig.ctx, rig.platform, { images, uuid: () => `ID-${++n}` });
  (rig.ctx as { frames: FrameCollector }).frames = frames;
  const title = await rig.library.addTitle("Dune", { year: 2021, kind: "film", status: "watching" });
  const session = await rig.library.saveSession(
    WatchSession.make({ titleId: title!.id, url: URL_, host: "flix.example", startedAt: 1, endedAt: 2, watchedSeconds: 60, duration: 7000 }),
  );
  const track: LiveTrack = {
    titleId: title!.id,
    ref: EpisodeRef.none,
    urlKey: UrlKey.make(URL_),
    session,
    lastFlush: 0,
    startedWith: 0,
    finishedAnnounced: false,
  };
  const tab = addTab(rig, 1, { url: URL_, track, media: { position: 600, duration: 7000, isPlaying: true, rate: 1 } });
  rig.browser.selectedId = 1;
  const s: Setup = { rig, frames, images, tab, track, capture: { x: 0, y: 0, w: 1280, h: 720, t: 600, d: 7000, idle: 9000, settled: true, url: URL_, data: dataUrl("scene") } };
  rig.browser.player = (_tab, method) => (method === "capture" ? s.capture : null);
  return s;
}

describe("grading frames", () => {
  it("tells a scene from a black or flat screen", () => {
    const black = new Uint8ClampedArray(32 * 18 * 4);
    expect(FrameImage.isBlank(FrameImage.grade(black, 32, 18))).toBe(true);

    const grey = new Uint8ClampedArray(32 * 18 * 4).fill(128);
    const flat = FrameImage.grade(grey, 32, 18);
    expect(flat.brightness).toBeCloseTo(128 / 255, 5);
    expect(flat.contrast).toBeCloseTo(0, 10);
    expect(FrameImage.isBlank(flat)).toBe(true);

    const checker = new Uint8ClampedArray(32 * 18 * 4);
    for (let p = 0; p < 32 * 18; p++) checker.fill(p % 2 === 0 ? 255 : 0, p * 4, p * 4 + 3);
    const grade = FrameImage.grade(checker, 32, 18);
    expect(grade.brightness).toBeCloseTo(0.5, 5);
    expect(grade.contrast).toBeCloseTo(0.5, 5);
    expect(grade.colour).toBeCloseTo(0, 10);
    expect(FrameImage.isBlank(grade)).toBe(false);
    expect(FrameImage.interest(grade)).toBeCloseTo(0.5 * 2 + 0 + 0.5 * 0.3, 10);
  });

  it("measures colour as the spread between channels, and reads six zones", () => {
    const red = new Uint8ClampedArray(4 * 4).fill(0);
    for (let p = 0; p < 4; p++) red[p * 4] = 255;
    expect(FrameImage.grade(red, 2, 2).colour).toBeCloseTo(1, 10);
    const zones = new Uint8ClampedArray(6 * 4).map((_, i) => i);
    expect(FrameImage.zones(zones)).toEqual([[0, 1, 2], [4, 5, 6], [8, 9, 10], [12, 13, 14], [16, 17, 18], [20, 21, 22]]);
  });

  it("reads data URLs", () => {
    expect(new TextDecoder().decode(dataUrlBytes(dataUrl("scene"))!)).toBe("scene");
    expect(dataUrlBytes("data:text/plain,hi")).toBeNull();
    expect(dataUrlBytes("https://x.example/a.jpg")).toBeNull();
  });
});

describe("collecting frames", () => {
  it("keeps the player's own picture, spaced through the film", async () => {
    const { rig, frames, tab, track } = await setup();
    frames.tick(tick(600), tab, track);
    await frames.idle();
    const saved = rig.library.frames(track.session.id);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ position: 600, isMoment: false, file: `${track.titleId}/ID-1.jpg`, url: URL_ });
    expect(tab.frameState).toMatchObject({ count: 1, lastPosition: 600, isCapturing: false });
    // Same-origin video: no photograph needed.
    expect(rig.tabs.shots).toBe(0);

    // Too close to the last one: the spacing is max(90, 7000 / 14) = 500 s.
    frames.tick(tick(1000), tab, track);
    await frames.idle();
    expect(rig.library.frames(track.session.id)).toHaveLength(1);
    frames.tick(tick(1101), tab, track);
    await frames.idle();
    expect(rig.library.frames(track.session.id)).toHaveLength(2);
  });

  it("waits for the person to settle in, for a frame in front, and stops near the end or at 14", async () => {
    const { rig, frames, tab, track } = await setup();
    frames.tick(tick(600), tab, { ...track, session: { ...track.session, watchedSeconds: 10 } });
    frames.tick(tick(600, { type: "play" }), tab, track);
    frames.tick(tick(600, { paused: true }), tab, track);
    frames.tick(tick(6600), tab, track);
    rig.browser.selectedId = 2;
    frames.tick(tick(600), tab, track);
    rig.browser.selectedId = 1;
    tab.active = false;
    frames.tick(tick(600), tab, track);
    tab.active = true;
    tab.frameState = { ...tab.frameState, sessionId: track.session.id, count: 14 };
    frames.tick(tick(600), tab, track);
    await frames.idle();
    expect(rig.library.frames(track.session.id)).toHaveLength(0);
    expect(rig.browser.commands).toEqual([]);
  });

  it("does nothing with collecting switched off", async () => {
    const { rig, frames, tab, track } = await setup({ keepFrames: false });
    frames.tick(tick(600), tab, track);
    await frames.idle();
    expect(rig.library.frames(track.session.id)).toHaveLength(0);
  });

  it("photographs the tab, cropped to the picture inside its frame, when the video can't be read", async () => {
    const s = await setup();
    const { rig, frames, tab, track, images } = s;
    s.capture = { x: 100, y: 50, w: 640, h: 360, t: 900, d: 7000, idle: 9000, settled: true, url: "https://player.example/e/1" };
    tab.mediaFrame = { frameId: 3, url: "https://player.example/e/1" };
    rig.browser.page = (_tab, method, args) => (method === "frameRect" ? (expect(args).toEqual(["https://player.example/e/1", 640, 360]), { x: 10, y: 20 }) : null);
    rig.page.handler = (_t, _f, target, method) => (target === "__cineonContent" && method === "viewport" ? { width: 1280, height: 720, dpr: 2 } : null);
    rig.tabs.shot = dataUrl("shot");

    frames.tick(tick(900), tab, track);
    await frames.idle();

    const crop = { x: 220, y: 140, width: 1280, height: 720 };
    expect(images.samples.at(-1)).toEqual({ tag: "shot", rect: crop, width: 32, height: 18 });
    expect(images.jpegs).toEqual([{ tag: "shot", rect: crop, maxPixel: 480, quality: 0.72 }]);
    expect(rig.library.frames(track.session.id)[0]).toMatchObject({ position: 900 });
  });

  it("tries again later while the controls show, backs off from black, and waits after a failure", async () => {
    const s = await setup();
    const { rig, frames, tab, track } = s;
    rig.page.handler = (_t, _f, target, method) => (target === "__cineonContent" && method === "viewport" ? { width: 1280, height: 720 } : null);
    const start = rig.clock.now();

    s.capture = { x: 0, y: 0, w: 1280, h: 720, t: 600, d: 7000, idle: 300, settled: true };
    frames.tick(tick(600), tab, track);
    await frames.idle();
    expect(tab.frameState.notBefore).toBe(start + 4000);

    s.capture = { ...s.capture, settled: false };
    tab.frameState.notBefore = 0;
    frames.tick(tick(600), tab, track);
    await frames.idle();
    expect(tab.frameState.notBefore).toBe(start + 4000);

    s.capture = { x: 0, y: 0, w: 1280, h: 720, t: 600, d: 7000, idle: 9000, settled: true, data: dataUrl("black") };
    rig.tabs.shot = dataUrl("darkshot");
    tab.frameState.notBefore = 0;
    frames.tick(tick(600), tab, track);
    await frames.idle();
    expect(tab.frameState).toMatchObject({ blanks: 1, notBefore: start + 20_000 });
    tab.frameState.notBefore = 0;
    frames.tick(tick(600), tab, track);
    await frames.idle();
    expect(tab.frameState).toMatchObject({ blanks: 2, notBefore: start + 40_000 });

    s.capture = null;
    tab.frameState.notBefore = 0;
    frames.tick(tick(600), tab, track);
    await frames.idle();
    expect(tab.frameState.notBefore).toBe(start + 30_000);
    expect(rig.library.frames(track.session.id)).toHaveLength(0);
  });
});

describe("moments", () => {
  it("saves the frame on screen at full size and says so", async () => {
    const { rig, frames, tab, track } = await setup({ keepFrames: false });
    await frames.saveMoment(tab);
    const moment = rig.library.moments(track.titleId)[0]!;
    expect(moment).toMatchObject({ isMoment: true, position: 600 });
    expect(moment.interest).toBeGreaterThan(10);
    expect(rig.browser.commands).toEqual([{ tabId: 1, method: "flash", args: [] }]);
    expect(rig.browser.lastBanner(1)).toEqual({ id: "moment", text: "Saved this moment at 10:00", timeout: 3 });
  });

  it("asks for something playing first, and says when the picture is protected", async () => {
    const s = await setup();
    const { rig, frames, tab } = s;
    tab.media = null;
    await frames.saveMoment(tab);
    expect(rig.toasts.current).toBe("Play something first, then save the moment you like");

    tab.media = { position: 1, duration: 7000, isPlaying: true, rate: 1 };
    s.capture = null;
    const done = frames.saveMoment(tab);
    await rig.clock.advance(5000);
    await done;
    expect(rig.browser.lastBanner(1)?.text).toBe("Couldn't save this frame. Some sites protect their video from being captured.");
  });
});

describe("ambient light", () => {
  it("keeps zones media.js reports, and only well-formed ones", async () => {
    const { frames, tab } = await setup();
    frames.receiveAmbient(tab, [[1, 2, 3]]);
    expect(tab.ambient).toBeNull();
    const zones = [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12], [13, 14, 15], [16, 17, 300]];
    frames.receiveAmbient(tab, zones);
    expect(tab.ambient?.[5]).toEqual([16, 17, 255]);
  });

  it("samples the tab in front while it plays, photographing it when the video can't be read", async () => {
    const s = await setup();
    const { rig, frames, tab } = s;
    rig.page.handler = (_t, _f, target, method) => (target === "__cineonContent" && method === "viewport" ? { width: 1280, height: 720 } : null);
    rig.tabs.shot = dataUrl("shot");

    frames.ambientTick();
    expect(rig.browser.ambient).toEqual([{ tabId: 1, on: true }]);
    frames.ambientTick();
    expect(rig.browser.ambient).toHaveLength(1);

    tab.ambientFramesBlocked = true;
    frames.ambientTick();
    await frames.idle();
    expect(tab.ambient).toHaveLength(6);
    expect(s.images.samples.at(-1)).toMatchObject({ tag: "shot", width: 3, height: 2 });

    tab.media = { ...tab.media!, isPlaying: false };
    frames.ambientTick();
    expect(rig.browser.ambient.at(-1)).toEqual({ tabId: 1, on: false });
  });

  it("stays off when the setting is", async () => {
    const { rig, frames } = await setup({ ambientLight: false });
    frames.ambientTick();
    expect(rig.browser.ambient).toEqual([]);
  });
});
