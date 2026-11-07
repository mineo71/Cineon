import { banners, calls, fromPage, type Harness, makeHarness, media, openTab, play, settle } from "./fakes";

const E2 = "https://kino.example/serial/severance-s01e02.html";
const E3 = "https://kino.example/serial/severance-s01e03.html";
const meta = (url: string, n: number) => ({ url, title: `Severance season 1 episode ${n}`, ld: [] });
const D = 3000;

async function watching(h: Harness, tabId = 1, url = E2, n = 2, from = 600): Promise<number> {
  await openTab(h, tabId, url);
  await fromPage(h, tabId, "cineonMeta", meta(url, n));
  return play(h, tabId, from, 6, D);
}

function navigatedTo(h: Harness, tabId: number): string[] {
  return h.tabs.updates.filter((u) => u.tabId === tabId && typeof u.change.url === "string").map((u) => u.change.url as string);
}

describe("EpisodeAutopilot", () => {
  test("near the end it offers the next episode, and Play now goes there with sound", async () => {
    const h = await makeHarness({ minimumSecondsToTrack: 4 });
    h.probe.answers.set(E3, { kind: "alive", url: E3 });
    await watching(h);
    const tab = h.runtime.current!.browser.tab(1)!;
    expect(tab.track?.ref).toEqual({ season: 1, episode: 2 });

    await fromPage(h, 1, "cineonMedia", media("tick", 2800, D));
    await settle(20);
    const offer = banners(h, 1).find((b) => b.id === "next")!;
    expect(offer.text).toBe("Next: S1 E3");
    expect(offer.seconds).toBeUndefined();
    expect(tab.autopilot.target?.url).toBe(E3);

    await fromPage(h, 1, "cineonMedia", { type: "banner", banner: "next", action: "play" });
    expect(navigatedTo(h, 1)).toEqual([E3]);
    expect(tab.autoplayKey).not.toBeNull();
  });

  test("at the very end it counts down; a no stops it, even when the countdown runs out afterwards", async () => {
    const h = await makeHarness({ minimumSecondsToTrack: 4 });
    h.probe.answers.set(E3, { kind: "alive", url: E3 });
    await watching(h);
    await fromPage(h, 1, "cineonMedia", media("ended", D, D));
    await settle(20);
    const countdown = banners(h, 1).find((b) => b.id === "next")!;
    expect(countdown.seconds).toBe(10);
    expect(countdown.onExpire).toBe("auto");

    await fromPage(h, 1, "cineonMedia", { type: "banner", banner: "next", action: "no" });
    // A banner left counting (in a background tab, say) still expires.
    await fromPage(h, 1, "cineonMedia", { type: "banner", banner: "next", action: "auto" });
    expect(navigatedTo(h, 1)).toEqual([]);
    const tab = h.runtime.current!.browser.tab(1)!;
    expect(tab.autopilot.isDeclined).toBe(true);
    expect(tab.autopilot.didMove).toBe(false);
  });

  test("a countdown that runs out moves on by itself when nobody said no", async () => {
    const h = await makeHarness({ minimumSecondsToTrack: 4 });
    h.probe.answers.set(E3, { kind: "alive", url: E3 });
    await watching(h);
    await fromPage(h, 1, "cineonMedia", media("ended", D, D));
    await settle(20);
    await fromPage(h, 1, "cineonMedia", { type: "banner", banner: "next", action: "auto" });
    expect(navigatedTo(h, 1)).toEqual([E3]);
  });

  test("a sleep timer for the end of this holds the next episode back", async () => {
    const h = await makeHarness({ minimumSecondsToTrack: 4 });
    h.probe.answers.set(E3, { kind: "alive", url: E3 });
    await watching(h);
    h.runtime.current!.playback.start({ kind: "endOfItem" });
    await fromPage(h, 1, "cineonMedia", media("ended", D, D));
    await settle(20);
    expect(banners(h, 1).some((b) => b.id === "next")).toBe(false);
    await fromPage(h, 1, "cineonMedia", { type: "banner", banner: "next", action: "auto" });
    expect(navigatedTo(h, 1)).toEqual([]);
  });

  test("an episode on the page's own list is opened there instead of loading an address", async () => {
    const h = await makeHarness({ minimumSecondsToTrack: 4 });
    h.page.handler = (_tab, frame, _target, method) => {
      if (method === "hasEpisode" && frame === 0) return true;
      if (method === "openEpisode") return true;
      return null;
    };
    await watching(h);
    const tab = h.runtime.current!.browser.tab(1)!;
    await h.runtime.current!.autopilot.skipToNext(tab);
    expect(calls(h, 1, "openEpisode")).toEqual([[1, 3, true]]);
    expect(navigatedTo(h, 1)).toEqual([]);
  });

  test("learns an intro from the jumps over it, and skips it once allowed", async () => {
    const h = await makeHarness({ minimumSecondsToTrack: 4 });
    await watching(h, 1, E2, 2, 20);
    const tab = h.runtime.current!.browser.tab(1)!;
    await fromPage(h, 1, "cineonMedia", { ...media("jump", 40, D), from: 30, to: 40 });
    await h.clock.advance(1000);
    await fromPage(h, 1, "cineonMedia", { ...media("jump", 90, D), from: 40, to: 90 });
    await h.clock.advance(5000);
    await fromPage(h, 1, "cineonMedia", media("tick", 95, D));
    const ask = banners(h, 1).find((b) => b.id === "intro")!;
    expect(ask.text).toBe("Skip 0:30 to 1:30 in every episode of Severance?");
    expect(ask.actions.map((a) => a.id)).toEqual(["always", "no"]);

    await fromPage(h, 1, "cineonMedia", { type: "banner", banner: "intro", action: "always" });
    expect(calls(h, 1, "setSkips").at(-1)).toEqual([[{ kind: "intro", from: 30, to: 90 }]]);
    expect(tab.lastBannerForTests).toBe("saved|Cineon will skip this from now on|offer");

    // The next episode, in another tab, gets the skip before it starts.
    await openTab(h, 2, E3);
    await fromPage(h, 2, "cineonMeta", meta(E3, 3));
    const reply = (await fromPage(h, 2, "cineonMediaReply", media("meta", 0, D))) as { skips?: unknown[] };
    expect(reply?.skips).toEqual([{ kind: "intro", from: 30, to: 90 }]);
  });

  test("undoing a skip twice forgets the intro", async () => {
    const h = await makeHarness({ minimumSecondsToTrack: 4 });
    await watching(h, 1, E2, 2, 20);
    const session = h.runtime.current!;
    const tab = session.browser.tab(1)!;
    tab.autopilot.proposedIntro = { from: 30, to: 90 };
    await fromPage(h, 1, "cineonMedia", { type: "banner", banner: "intro", action: "always" });
    expect(tab.autopilot.rules).toHaveLength(1);

    for (let i = 0; i < 2; i++) {
      await fromPage(h, 1, "cineonMedia", { ...media("skipped", 90, D), kind: "intro", from: 30, to: 90 });
      await fromPage(h, 1, "cineonMedia", { type: "banner", banner: "skipped", action: "undo" });
    }
    expect(calls(h, 1, "seek")).toEqual([[30], [30]]);
    expect(tab.autopilot.rules).toHaveLength(0);
    expect(await session.db.skipRules(tab.track!.titleId)).toHaveLength(0);
    expect(tab.lastBannerForTests).toBe("saved|Cineon won't skip this any more|offer");
  });

  test("leaving an episode early for the next one teaches where the credits start", async () => {
    const h = await makeHarness({ minimumSecondsToTrack: 4 });
    await watching(h, 1, E2, 2, 2700);
    const session = h.runtime.current!;
    const tab = session.browser.tab(1)!;
    const titleId = tab.track!.titleId;
    // The person moves on with 290 s left.
    await session.browser.load(tab, E3);
    await h.runtime.navCommitted({ tabId: 1, frameId: 0, url: E3, documentId: "e3", transitionType: "link", transitionQualifiers: [] });
    await fromPage(h, 1, "cineonMeta", meta(E3, 3));
    await play(h, 1, 0, 6, D);
    const rules = await session.db.skipRules(titleId);
    expect(rules.find((r) => r.kind === "credits")?.sightings).toBe(1);
  });
});
