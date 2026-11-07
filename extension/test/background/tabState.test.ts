import { KeepAlive } from "../../src/background/keepAlive";
import { MediaEvent, TabState } from "../../src/background/tabState";
import { TabRegistry } from "../../src/background/tabs";
import { MemoryStorage } from "../../src/core/data";
import { ManualClock } from "./fakes";

describe("MediaEvent", () => {
  test("reads media.js's reports as Swift's MediaEvent does", () => {
    expect(MediaEvent.parse({ type: "tick", t: 12.5, d: 3000, paused: false, muted: true, rate: 1.5, w: 1920, h: 1080, top: false, frame: "https://p/", active: false })).toEqual({
      type: "tick",
      position: 12.5,
      duration: 3000,
      paused: false,
      muted: true,
      rate: 1.5,
      width: 1920,
      height: 1080,
      isTopFrame: false,
      frameUrl: "https://p/",
      userActivated: false,
    });
    // Missing values take Swift's defaults: paused, unmuted, rate 1, the person acted.
    expect(MediaEvent.parse({ type: "meta" })).toMatchObject({ position: 0, duration: 0, paused: true, muted: false, rate: 1, userActivated: true });
    expect(MediaEvent.parse({ t: 1 })).toBeNull();
    expect(MediaEvent.parse(null)).toBeNull();
  });
});

describe("TabState", () => {
  test("a stored copy comes back with defaults for new fields, and work in flight starts over", () => {
    const stored = JSON.parse(
      JSON.stringify({ id: 7, url: "https://a.example/", autopilot: { isResolving: true, didOffer: true }, frameState: { isCapturing: true, count: 3 } }),
    );
    const tab = TabState.revive(stored)!;
    expect(tab.id).toBe(7);
    expect(tab.url).toBe("https://a.example/");
    expect(tab.autopilot.isResolving).toBe(false);
    expect(tab.autopilot.didOffer).toBe(true);
    expect(tab.autopilot.rules).toEqual([]);
    expect(tab.frameState).toMatchObject({ isCapturing: false, count: 3 });
    expect(tab.blocked).toEqual({ ads: 0, popups: 0, redirects: 0, overlays: 0 });
    expect(TabState.revive({ url: "x" })).toBeNull();
  });

  test("the best source and the episode", () => {
    const tab = TabState.make(1, {
      sources: [
        { url: "https://c/720.mp4", kind: "file", foundAt: 1, isCurrent: true },
        { url: "https://c/1080.mp4", kind: "file", foundAt: 2, isCurrent: true },
        { url: "https://c/a.vtt", kind: "subtitle", foundAt: 3, isCurrent: true },
      ],
    });
    expect(TabState.bestSource(tab)?.url).toBe("https://c/1080.mp4");
    expect(TabState.episodeRef(tab)).toBeNull();
    tab.parsed = { name: "S", altName: null, year: null, ref: { season: 1, episode: 2 }, episodeName: null, kindHint: "series", posterUrl: null, overview: null, confidence: 1 };
    expect(TabState.episodeRef(tab)).toEqual({ season: 1, episode: 2 });
  });
});

describe("TabRegistry", () => {
  test("the selected tab is the focused window's, and saving waits a moment", async () => {
    const clock = new ManualClock();
    const storage = new MemoryStorage();
    const registry = new TabRegistry(storage, clock);
    registry.ensure(1, { windowId: 1, active: true });
    registry.ensure(2, { windowId: 2, active: true });
    registry.focusedWindowId = 2;
    expect(registry.selected()?.id).toBe(2);
    registry.ensure(3, { windowId: 2 }).isHelper = true;
    expect(registry.listed().map((t) => t.id)).toEqual([1, 2]);
    registry.touch(1);
    expect(await storage.get("cineon.tabs")).toBeUndefined();
    await clock.advance(500);
    expect(((await storage.get("cineon.tabs")) as { tabs: unknown[] }).tabs).toHaveLength(3);
  });
});

describe("KeepAlive", () => {
  test("pings while any reason holds, and stops when the last one goes", async () => {
    const clock = new ManualClock();
    let pings = 0;
    const keep = new KeepAlive(clock, () => pings++);
    keep.hold("party");
    keep.hold("downloads");
    await clock.advance(45_000);
    expect(pings).toBe(3);
    keep.release("party");
    await clock.advance(20_000);
    expect(pings).toBe(4);
    keep.release("downloads");
    await clock.advance(60_000);
    expect(pings).toBe(4);
    expect(keep.active).toEqual([]);
  });
});
