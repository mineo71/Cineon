import { UrlKey } from "../../src/core/data";
import { banners, calls, fromPage, makeHarness, media, openTab, play, settle } from "./fakes";

const FILM = "https://kino.example/watch/dune-2021";
const filmMeta = (url = FILM) => ({ url, title: "Dune (2021) watch online", ld: [] });

describe("WatchTracker", () => {
  test("starts tracking after the minimum time played, and saves the session and position", async () => {
    const h = await makeHarness();
    await openTab(h, 1, FILM);
    await fromPage(h, 1, "cineonMeta", filmMeta());
    expect(await fromPage(h, 1, "cineonMediaReply", media("meta", 0, 9000))).toBeNull();

    await play(h, 1, 100, 10, 9000);
    const session = h.runtime.current!;
    expect(session.browser.tab(1)!.track).toBeNull();

    await play(h, 1, 110, 10, 9000);
    const tab = session.browser.tab(1)!;
    expect(tab.track).not.toBeNull();
    const title = session.library.titles.get(tab.track!.titleId)!;
    expect(title.name).toBe("Dune");
    expect(title.year).toBe(2021);
    expect(title.status).toBe("watching");

    await h.clock.advance(1000);
    await fromPage(h, 1, "cineonMedia", media("pause", 140, 9000));
    const progress = await session.db.progress(UrlKey.make(FILM));
    expect(progress?.position).toBe(140);
    expect(progress?.url).toBe(FILM);
    const sessions = await session.db.sessionsForTitle(title.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.watchedSeconds).toBeGreaterThanOrEqual(20);
    // Pages hear about the background's own writes.
    expect(h.pages.of("library").length).toBeGreaterThan(0);
  });

  test("a film page goes into the history once it's watched, so its host stays known after the film moves on", async () => {
    // Rescue finds a dead site's other addresses among the hosts the profile has seen (Database.knownHosts).
    // Watching the same film on a second address within the merge window carries on the first session and
    // takes its host, so the first address is remembered only if the page itself went into the history.
    const h = await makeHarness();
    const other = "https://kino-two.example/watch/dune-2021";
    await openTab(h, 1, FILM);
    await fromPage(h, 1, "cineonMeta", filmMeta());
    await play(h, 1, 100, 24, 9000);
    const session = h.runtime.current!;
    expect(session.browser.tab(1)!.track).not.toBeNull();
    await fromPage(h, 1, "cineonMedia", media("pause", 124, 9000));

    await openTab(h, 2, other, { active: true });
    session.browser.tab(1)!.active = false;
    await fromPage(h, 2, "cineonMeta", filmMeta(other));
    await play(h, 2, 124, 24, 9000);
    expect(session.browser.tab(2)!.track).not.toBeNull();
    await fromPage(h, 2, "cineonMedia", media("pause", 148, 9000));
    await settle();

    expect((await session.db.recentHistory()).map((e) => e.url)).toEqual(expect.arrayContaining([FILM, other]));
    expect(await session.db.knownHosts()).toEqual(expect.arrayContaining(["kino.example", "kino-two.example"]));
  });

  test("resumes where the film was left, with a Start over button in the player's banner", async () => {
    const h = await makeHarness();
    await openTab(h, 1, FILM);
    await fromPage(h, 1, "cineonMeta", filmMeta());
    await play(h, 1, 600, 24, 9000);
    await fromPage(h, 1, "cineonMedia", media("pause", 624, 9000));

    await openTab(h, 2, FILM);
    const reply = (await fromPage(h, 2, "cineonMediaReply", media("meta", 0, 9000))) as { seekTo?: number };
    expect(reply?.seekTo).toBe(624);
    const shown = banners(h, 2).at(-1)!;
    expect(shown.text).toBe("Resumed at 10:24");
    expect(shown.actions.map((a) => a.id)).toEqual(["action"]);
    // Start over seeks back to the beginning.
    await fromPage(h, 2, "cineonMedia", { type: "banner", banner: "toast", action: "action" });
    expect(calls(h, 2, "seek").at(-1)).toEqual([0]);
  });

  test("an explicit resume of a different cut stays at the start and offers the jump", async () => {
    const h = await makeHarness();
    const tab = await openTab(h, 1, FILM, { pendingResume: 1200, expectedResumeDuration: 5000 });
    const reply = await fromPage(h, 1, "cineonMediaReply", media("meta", 0, 9000));
    expect(reply).toBeNull();
    expect(tab.lastBannerForTests).toBe("toast|This video's length is different, so Cineon stayed at the start|offer");
  });

  test("finishing a film moves it to Watched", async () => {
    const h = await makeHarness({ minimumSecondsToTrack: 4 });
    await openTab(h, 1, FILM);
    await fromPage(h, 1, "cineonMeta", filmMeta());
    await play(h, 1, 8000, 6, 9000);
    const session = h.runtime.current!;
    const tab = session.browser.tab(1)!;
    await fromPage(h, 1, "cineonMedia", media("tick", 8400, 9000));
    expect(tab.track?.finishedAnnounced).toBe(true);
    expect(session.library.titles.get(tab.track!.titleId)!.status).toBe("watched");
    expect(tab.lastBannerForTests).toContain("Finished Dune. Moved to Watched.");
  });

  test("silent video nobody touched is a banner, not a film", async () => {
    const h = await makeHarness();
    await openTab(h, 1, FILM);
    await fromPage(h, 1, "cineonMedia", media("play", 10, 9000, { muted: true, active: false }));
    expect(h.runtime.current!.browser.tab(1)!.media).toBeNull();
  });

  test("starting a video pauses the other tab that was playing", async () => {
    const h = await makeHarness();
    await openTab(h, 1, FILM);
    await fromPage(h, 1, "cineonMedia", media("play", 10, 9000));
    await openTab(h, 2, "https://other.example/film/arrival");
    await fromPage(h, 2, "cineonMedia", media("play", 10, 7000));
    expect(calls(h, 1, "pause")).toHaveLength(1);
    expect(calls(h, 2, "pause")).toHaveLength(0);
  });

  test("leaving the page saves it under its own address and clears the track", async () => {
    const h = await makeHarness({ minimumSecondsToTrack: 4 });
    await openTab(h, 1, FILM);
    await fromPage(h, 1, "cineonMeta", filmMeta());
    await play(h, 1, 300, 8, 9000);
    const session = h.runtime.current!;
    const tab = session.browser.tab(1)!;
    expect(tab.track).not.toBeNull();
    await h.runtime.navCommitted({ tabId: 1, frameId: 0, url: "https://kino.example/", documentId: "doc-2", transitionType: "link", transitionQualifiers: [] });
    await settle();
    expect(tab.track).toBeNull();
    expect(tab.media).toBeNull();
    const progress = await session.db.progress(UrlKey.make(FILM));
    expect(progress?.url).toBe(FILM);
    expect(progress?.position).toBe(308);
  });

  test("this isn't a film: the title made for it goes, and the page is never tracked again", async () => {
    const h = await makeHarness({ minimumSecondsToTrack: 4 });
    await openTab(h, 1, FILM);
    await fromPage(h, 1, "cineonMeta", filmMeta());
    await play(h, 1, 300, 8, 9000);
    const session = h.runtime.current!;
    const tab = session.browser.tab(1)!;
    const titleId = tab.track!.titleId;
    await session.tracker.ignore(tab);
    expect(session.library.titles.has(titleId)).toBe(false);
    expect(await session.db.isIgnored(UrlKey.make(FILM))).toBe(true);
    await play(h, 1, 310, 8, 9000);
    expect(tab.track).toBeNull();
  });

  test("a site switched to Don't track is never tracked", async () => {
    const h = await makeHarness({ minimumSecondsToTrack: 4 });
    const session = h.runtime.current!;
    await session.shields.update("kino.example", { trackingOff: true });
    await openTab(h, 1, FILM);
    await fromPage(h, 1, "cineonMeta", filmMeta());
    await play(h, 1, 300, 10, 9000);
    expect(session.browser.tab(1)!.track).toBeNull();
    expect(session.library.titles.size).toBe(0);
  });

  test("relinking a page moves its records to the chosen title", async () => {
    const h = await makeHarness({ minimumSecondsToTrack: 4 });
    const session = h.runtime.current!;
    const right = (await session.library.addTitle("Dune: Part One", { year: 2021, kind: "film", status: "backlog" }))!;
    await openTab(h, 1, FILM);
    await fromPage(h, 1, "cineonMeta", filmMeta());
    await play(h, 1, 300, 8, 9000);
    const tab = session.browser.tab(1)!;
    const wrong = tab.track!.titleId;
    await session.tracker.relink(tab, right.id, { season: 0, episode: 0 });
    expect(session.library.titles.has(wrong)).toBe(false);
    expect(tab.linkedTitleId).toBe(right.id);
    expect((await session.db.link(UrlKey.make(FILM)))?.titleId).toBe(right.id);
  });
});
