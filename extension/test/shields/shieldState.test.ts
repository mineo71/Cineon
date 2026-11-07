// A port of the apps' ShieldStateTests.

import { ShieldState, type ShieldCounts, type ShieldStore, type SitePrefs } from "../../src/core/shields/shieldState";

class MemoryStore implements ShieldStore {
  prefs = new Map<string, SitePrefs>();
  stats = new Map<string, ShieldCounts>();
  writes = 0;

  loadSitePrefs(): SitePrefs[] {
    return [...this.prefs.values()];
  }

  saveSitePrefs(prefs: SitePrefs): void {
    this.prefs.set(prefs.host, prefs);
  }

  loadTotalStats(): ShieldCounts {
    const t = { ads: 0, popups: 0, redirects: 0, overlays: 0 };
    for (const s of this.stats.values()) {
      t.ads += s.ads;
      t.popups += s.popups;
      t.redirects += s.redirects;
      t.overlays += s.overlays;
    }
    return t;
  }

  async addStats(day: string, d: ShieldCounts): Promise<void> {
    const s = this.stats.get(day) ?? { ads: 0, popups: 0, redirects: 0, overlays: 0 };
    this.stats.set(day, { ads: s.ads + d.ads, popups: s.popups + d.popups, redirects: s.redirects + d.redirects, overlays: s.overlays + d.overlays });
    this.writes++;
  }
}

test("prefs are kept per site", async () => {
  const store = new MemoryStore();
  const state = await ShieldState.open(store);
  expect(state.shieldsOff("player.vod.example.co.uk")).toBe(false);

  await state.update("player.vod.example.co.uk", { shieldsOff: true });
  expect(state.shieldsOff("www.example.co.uk")).toBe(true);
  expect(state.shieldsOff("EXAMPLE.CO.UK.")).toBe(true);
  expect(state.shieldsOff("example.com")).toBe(false);
  expect(store.prefs.get("example.co.uk")).toEqual({ host: "example.co.uk", shieldsOff: true, allowPopups: false, allowRedirects: false, trackingOff: false });

  await state.update("www.example.co.uk", { allowPopups: true });
  const prefs = state.prefsFor("example.co.uk");
  expect(prefs.host).toBe("example.co.uk");
  expect(prefs.shieldsOff).toBe(true);
  expect(prefs.allowPopups).toBe(true);

  await state.update(null, { trackingOff: true });
  expect(store.prefs.size).toBe(1);

  const reopened = await ShieldState.open(store);
  expect(reopened.allowPopups("cdn.example.co.uk")).toBe(true);
  expect(reopened.allPrefs).toHaveLength(1);
  expect(reopened.sitesWithShieldsOff).toEqual(["example.co.uk"]);
});

test("keys are registrable domains", () => {
  expect(ShieldState.key("a.b.example.com")).toBe("example.com");
  expect(ShieldState.key("www.example.com.ua")).toBe("example.com.ua");
  expect(ShieldState.key("192.168.0.1")).toBe("192.168.0.1");
  expect(ShieldState.key("localhost")).toBe("localhost");
  expect(ShieldState.key(null)).toBe("");
});

test("counts are saved together after a delay", async () => {
  vi.useFakeTimers();
  try {
    const store = new MemoryStore();
    store.stats.set("2026-11-01", { ads: 10, popups: 1, redirects: 2, overlays: 3 });
    const day = new Date(2026, 10, 6, 21, 30, 0);
    const state = await ShieldState.open(store, { flushDelayMs: 100, now: () => day });
    expect(state.total).toEqual({ ads: 10, popups: 1, redirects: 2, overlays: 3 });

    let changes = 0;
    state.onChange(() => changes++);
    state.record({ ads: 1 });
    state.record({ ads: 2, popups: 1 });
    state.record({ overlays: 1 });
    expect(state.total).toEqual({ ads: 13, popups: 2, redirects: 2, overlays: 4 });
    expect(changes).toBe(3);
    expect(store.writes).toBe(0);

    await vi.advanceTimersByTimeAsync(150);
    expect(store.writes).toBe(1);
    expect(store.stats.get("2026-11-06")).toEqual({ ads: 3, popups: 1, redirects: 0, overlays: 1 });

    state.record({ redirects: 1 });
    await state.flush();
    expect(store.stats.get("2026-11-06")).toEqual({ ads: 3, popups: 1, redirects: 1, overlays: 1 });
    await state.flush();
    expect(store.writes).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

test("store failures are ignored", async () => {
  const failing: ShieldStore = {
    loadSitePrefs: () => { throw new Error("io"); },
    saveSitePrefs: () => Promise.reject(new Error("io")),
    loadTotalStats: () => Promise.reject(new Error("io")),
    addStats: () => { throw new Error("io"); },
  };
  const state = await ShieldState.open(failing);
  expect(state.total).toEqual({ ads: 0, popups: 0, redirects: 0, overlays: 0 });
  await state.update("example.com", { shieldsOff: true });
  expect(state.shieldsOff("example.com")).toBe(true);
  state.record({ ads: 1 });
  await state.flush();
});
