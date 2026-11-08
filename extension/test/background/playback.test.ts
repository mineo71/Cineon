import { calls, fromPage, makeHarness, media, openTab, play } from "./fakes";

const FILM = "https://kino.example/watch/dune-2021";

describe("Playback", () => {
  test("the sleep timer fades the sound for its last 20 seconds, then the film pauses", async () => {
    const h = await makeHarness();
    await openTab(h, 1, FILM);
    await play(h, 1, 100, 2, 9000);
    const playback = h.runtime.current!.playback;
    playback.start({ kind: "minutes", minutes: 1 });
    expect(h.runtime.current!.browser.tab(1)!.lastBannerForTests).toBe("toast|Playback stops in 1 min|offer");
    await expect(h.sessionStore.get("cineon.sleepTimer")).resolves.toMatchObject({ mode: { kind: "minutes", minutes: 1 } });

    await h.clock.advance(41_000);
    expect(calls(h, 1, "fadeOut")).toHaveLength(1);
    expect(playback.sleepTimer?.isFading).toBe(true);

    // media.js pauses once the fade is done.
    await fromPage(h, 1, "cineonMedia", media("pause", 160, 9000, { sleep: true }));
    await h.clock.advance(1000);
    expect(playback.sleepTimer).toBeNull();
    expect(h.runtime.current!.browser.tab(1)!.lastBannerForTests).toBe("toast|Sleep timer paused the film. Good night|offer");
  });

  test("the timer remembers whether it faded, after it's done (a fast fade can't be missed)", async () => {
    const h = await makeHarness();
    await openTab(h, 1, FILM);
    await play(h, 1, 100, 2, 9000);
    const playback = h.runtime.current!.playback;
    playback.startSeconds(6);
    expect(playback.lastTimerFaded).toBe(false);
    await h.clock.advance(1000);
    expect(playback.sleepTimer?.isFading).toBe(true);
    await fromPage(h, 1, "cineonMedia", media("pause", 103, 9000, { sleep: true }));
    await h.clock.advance(1000);
    expect(playback.sleepTimer).toBeNull();
    expect(playback.lastTimerFaded).toBe(true);

    // With nothing playing there's nothing to fade: the timer just ends, and says it didn't fade.
    playback.startSeconds(6);
    expect(playback.lastTimerFaded).toBe(false);
    await h.clock.advance(7000);
    expect(playback.sleepTimer).toBeNull();
    expect(playback.lastTimerFaded).toBe(false);
  });

  test("“end of this” ends quietly when something else takes the episode's place", async () => {
    const h = await makeHarness();
    await openTab(h, 1, FILM);
    await play(h, 1, 100, 2, 9000);
    const playback = h.runtime.current!.playback;
    playback.start({ kind: "endOfItem" });
    expect(h.runtime.current!.browser.tab(1)!.autopilot.isHeldForSleep).toBe(true);
    await h.runtime.navCommitted({ tabId: 1, frameId: 0, url: "https://kino.example/watch/arrival", documentId: "x", transitionType: "link", transitionQualifiers: [] });
    await h.clock.advance(1000);
    expect(playback.sleepTimer).toBeNull();
  });

  test("the timer survives the worker stopping", async () => {
    const h = await makeHarness();
    await openTab(h, 1, FILM);
    await play(h, 1, 100, 2, 9000);
    h.runtime.current!.playback.start({ kind: "minutes", minutes: 30 });
    const { Runtime } = await import("../../src/background/runtime");
    const next = new Runtime({ ...h.runtime.deps });
    const session = await next.ready();
    expect(session.playback.sleepTimer?.mode).toEqual({ kind: "minutes", minutes: 30 });
    expect(session.playback.remaining()).toBeCloseTo(1800, 0);
  });

  test("the play/pause key with nothing playing carries on with the last thing watched", async () => {
    const h = await makeHarness({ minimumSecondsToTrack: 4 });
    await openTab(h, 1, FILM);
    await h.runtime.handleContent(
      { cineon: 1, h: "cineonMeta", b: { url: FILM, title: "Dune (2021)", ld: [] }, frame: { url: FILM, top: true } },
      { tab: { id: 1, url: FILM }, frameId: 0, url: FILM },
    );
    await play(h, 1, 600, 8, 9000);
    await fromPage(h, 1, "cineonMedia", media("pause", 608, 9000));
    await h.runtime.tabRemoved(1);
    await h.runtime.current!.playback.togglePlayback();
    expect(h.tabs.created.at(-1)?.url).toBe(FILM);
    const opened = h.runtime.registry.all().find((t) => t.url === FILM)!;
    expect(opened.pendingResume).toBe(608);
    expect(opened.autoplayKey).not.toBeNull();
  });
});
