import { runDebug, type DebugDeps } from "../../src/background/debug";
import { fromPage, makeHarness, media, openTab, play } from "./fakes";

const FILM = "https://kino.example/watch/dune-2021";

function debugFor(h: Awaited<ReturnType<typeof makeHarness>>) {
  const deps: DebugDeps = {
    runtime: h.runtime,
    evalInPage: async (_tab, _frame, js) => `evaluated ${js}`,
    openCineon: async () => undefined,
    removeTab: async (id) => void h.runtime.tabRemoved(id),
  };
  return (type: string, query: Record<string, string | number> = {}) => runDebug(deps, type, query);
}

function parse(text: string): Record<string, string> {
  return Object.fromEntries(text.split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

describe("debug hooks", () => {
  test("state has the Mac's keys for the tab in front", async () => {
    const h = await makeHarness({ minimumSecondsToTrack: 4 });
    const debug = debugFor(h);
    await openTab(h, 1, FILM);
    await fromPage(h, 1, "cineonMeta", { url: FILM, title: "Dune (2021) watch online", ld: [] });
    await fromPage(h, 1, "cineonMedia", {
      ...media("sources", 10, 9000),
      items: [{ url: "https://cdn.example/dune.1080.mp4", kind: "file", at: 1, current: true }],
      src: "https://cdn.example/dune.1080.mp4",
    });
    await play(h, 1, 100, 6, 9000);
    const state = parse(await debug("state"));
    for (const key of ["url", "parsed", "media", "track", "blocked", "banner", "rescue", "sources", "downloads", "autopilot", "best", "frames", "sites", "toast"]) {
      expect(state).toHaveProperty(key);
    }
    expect(state.url).toBe(FILM);
    expect(state.parsed).toMatch(/^Dune\|2021\|S0E0\|unknown\|/);
    expect(state.media).toBe("106/9000 playing=true");
    expect(Number(state.track)).toBeGreaterThan(0);
    expect(state.best).toBe("https://cdn.example/dune.1080.mp4");
    expect(state.blocked).toBe("ShieldStats(ads: 0, popups: 0, redirects: 0, overlays: 0)");
  });

  test("settings, titles, ratings and the sleep timer", async () => {
    const h = await makeHarness();
    const debug = debugFor(h);
    await debug("settings", { minimumSeconds: 3, voiceBoost: 1, captions: "large" });
    const settings = h.runtime.current!.settings;
    expect(settings.minimumSecondsToTrack).toBe(3);
    expect(settings.voiceBoost).toBe(true);
    expect(settings.captionStyle).toBe("large");
    expect(h.pages.of("settings")).toHaveLength(1);

    const added = parse(await debug("addtitle", { name: "Arrival", year: 2016, kind: "film", status: "backlog" }));
    const id = Number(added.id);
    expect(h.runtime.current!.library.titles.get(id)?.status).toBe("backlog");
    await debug("rate", { id, halves: 17 });
    expect(h.runtime.current!.library.titles.get(id)?.ratingHalves).toBe(17);

    await openTab(h, 1, FILM);
    await play(h, 1, 100, 2, 9000);
    await debug("sleep", { mode: "seconds", s: 90 });
    const sleep = parse(await debug("sleepstate"));
    expect(sleep.active).toBe("true");
    expect(Number(sleep.remaining)).toBeCloseTo(90, 0);
    await debug("sleep", { mode: "cancel" });
    expect(parse(await debug("sleepstate")).active).toBe("false");
  });

  test("banner actions go to the autopilot, and media calls to the player's frame", async () => {
    const h = await makeHarness();
    const debug = debugFor(h);
    await openTab(h, 1, FILM);
    await fromPage(h, 1, "cineonMedia", media("play", 10, 9000), 3, "https://player.example/");
    await debug("banner", { banner: "next", action: "no" });
    expect(h.runtime.current!.browser.tab(1)!.autopilot.isDeclined).toBe(true);
    h.page.handler = (_t, frame, _target, method) => (method === "volume" ? frame / 10 : null);
    expect(await debug("mediaeval", { method: "volume" })).toBe("0.3");
    expect(await debug("mediaeval", { js: "1 + 1" })).toBe("evaluated 1 + 1");
    expect(await debug("nope")).toBe("unknown /nope");
  });

  test("addsite and open", async () => {
    const h = await makeHarness();
    const debug = debugFor(h);
    await debug("addsite", { url: "http://127.0.0.1:8765/", name: "Fixture", search: "http://127.0.0.1:8765/search?q=%s" });
    const state = parse(await debug("state"));
    expect(state.sites).toContain("127.0.0.1|http://127.0.0.1:8765/search?q=%s");
    const opened = parse(await debug("open", { url: "http://127.0.0.1:8765/watch/x" }));
    expect(Number(opened.tab)).toBeGreaterThan(0);
    expect(h.tabs.created.at(-1)?.url).toBe("http://127.0.0.1:8765/watch/x");
  });
});
