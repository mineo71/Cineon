import { Database, UrlKey } from "../../src/core/data";
import { listenForUiRequests, type UiRequestType, UI_MESSAGE } from "../../src/shared/messages";
import { Runtime } from "../../src/background/runtime";
import { TABS_STORAGE_KEY } from "../../src/background/tabs";
import { uiHandlers } from "../../src/background/uiHandlers";
import { calls, fromPage, type Harness, makeHarness, media, openTab, play, settle } from "./fakes";

const FILM = "https://kino.example/watch/dune-2021";
const filmMeta = { url: FILM, title: "Dune (2021) watch online", ld: [] };

/** The pages' requests, answered by the real handlers through a fake runtime.onMessage. */
function uiClient(h: Harness, readFile: (path: string) => Promise<unknown> = async () => ({})) {
  let listener: ((message: unknown, sender: unknown, reply: (answer: unknown) => void) => boolean | undefined) | null = null;
  listenForUiRequests(uiHandlers(h.runtime, readFile), {
    onMessage: { addListener: (l: typeof listener) => (listener = l) } as never,
  });
  return async <K extends UiRequestType>(type: K, payload: Record<string, unknown> = {}): Promise<{ ok: boolean; value?: any; error?: string }> =>
    new Promise((resolve) => {
      const handled = listener!({ ...payload, kind: UI_MESSAGE, type }, {}, (answer) => resolve(answer as never));
      if (handled !== true) resolve({ ok: false, error: "unhandled" });
    });
}

describe("content messages", () => {
  test("only Cineon's own messages from tabs are taken", async () => {
    const h = await makeHarness();
    expect(h.runtime.handleContent({ kind: UI_MESSAGE, type: "ping" }, { tab: { id: 1 } })).toBeUndefined();
    expect(h.runtime.handleContent({ cineon: 1, h: "cineonMedia", b: {} }, {})).toBeUndefined();
    expect(h.runtime.handleContent("hello", { tab: { id: 1 } })).toBeUndefined();
  });

  test("hello tells a frame whether the overlay sweeper is on for its page", async () => {
    const h = await makeHarness();
    const sender = { tab: { id: 3, url: FILM }, frameId: 7, url: "https://player.example/embed" };
    expect(await h.runtime.handleContent({ cineon: "hello", top: false, url: sender.url }, sender)).toEqual({ noShield: false });
    await h.runtime.current!.shields.update("kino.example", { shieldsOff: true });
    expect(await h.runtime.handleContent({ cineon: "hello", top: false, url: sender.url }, sender)).toEqual({ noShield: true });
    await h.runtime.current!.updateSettings({ overlaySweeper: false });
    expect(await h.runtime.handleContent({ cineon: "hello", top: true, url: "https://a.example/" }, { tab: { id: 4, url: "https://a.example/" }, frameId: 0 })).toEqual({ noShield: true });
  });

  test("a page's report from a new document counts as that page committing", async () => {
    const h = await makeHarness({ minimumSecondsToTrack: 4 });
    await openTab(h, 1, FILM, { documentId: "old" });
    await fromPage(h, 1, "cineonMeta", filmMeta);
    await play(h, 1, 100, 8, 9000);
    const tab = h.runtime.current!.browser.tab(1)!;
    expect(tab.track).not.toBeNull();
    const next = "https://kino.example/watch/arrival-2016";
    await h.runtime.handleContent(
      { cineon: 1, h: "cineonMeta", b: { url: next, title: "Arrival (2016)", ld: [] }, frame: { url: next, top: true } },
      { tab: { id: 1, url: next }, frameId: 0, url: next, documentId: "new", documentLifecycle: "active" },
    );
    await settle();
    expect(tab.documentId).toBe("new");
    expect(tab.track).toBeNull();
    expect(tab.url).toBe(next);
    expect(tab.parsed?.name).toBe("Arrival");
  });

  test("messages from a page on its way out are ignored", async () => {
    const h = await makeHarness();
    await openTab(h, 1, FILM);
    const answer = await h.runtime.handleContent(
      { cineon: 1, h: "cineonMedia", b: media("play", 10, 9000), frame: { url: FILM, top: true } },
      { tab: { id: 1, url: FILM }, frameId: 0, url: FILM, documentLifecycle: "pending_deletion" },
    );
    expect(answer).toBeNull();
    expect(h.runtime.current!.browser.tab(1)!.media).toBeNull();
  });
});

describe("shields", () => {
  test("a pop-up from a film page to another site is closed, with an Open button", async () => {
    const h = await makeHarness();
    await openTab(h, 1, FILM, { media: { position: 10, duration: 9000, isPlaying: true, rate: 1 } });
    h.tabs.info(50, { url: "https://ads.example/win" });
    await h.runtime.createdNavigationTarget({ sourceTabId: 1, tabId: 50, url: "https://ads.example/win" });
    expect(h.tabs.removed).toContain(50);
    const tab = h.runtime.current!.browser.tab(1)!;
    expect(tab.blocked.popups).toBe(1);
    expect(tab.lastBannerForTests).toBe("toast|Blocked pop-up to ads.example|offer");
  });

  test("a link opened in a new tab on purpose, and same-site pop-ups, stay", async () => {
    const h = await makeHarness();
    await openTab(h, 1, FILM, { media: { position: 10, duration: 9000, isPlaying: true, rate: 1 } });
    await h.runtime.handleContent({ cineon: "gesture", link: { url: "https://imdb.example/title/1", newTab: true } }, { tab: { id: 1 } });
    await h.runtime.createdNavigationTarget({ sourceTabId: 1, tabId: 51, url: "https://imdb.example/title/1" });
    await h.runtime.createdNavigationTarget({ sourceTabId: 1, tabId: 52, url: "https://www.kino.example/other" });
    expect(h.tabs.removed).toEqual([]);
  });

  test("a film's page shields its first click even before the video plays", async () => {
    const h = await makeHarness();
    await openTab(h, 1, "http://127.0.0.1:8765/watch/dune-part-two-2024");
    await fromPage(h, 1, "cineonMeta", { url: "http://127.0.0.1:8765/watch/dune-part-two-2024", title: "Watch Dune: Part Two (2024) Full Movie Online Free HD | FlixDemo", ogType: "video.movie", ld: [] });
    await h.runtime.createdNavigationTarget({ sourceTabId: 1, tabId: 54, url: "http://ads.example.test/popunder" });
    expect(h.tabs.removed).toContain(54);
  });

  test("pages Cineon has no stake in keep their pop-ups (sign-in windows and the like)", async () => {
    const h = await makeHarness();
    await openTab(h, 1, "https://mail.example/inbox");
    await h.runtime.createdNavigationTarget({ sourceTabId: 1, tabId: 53, url: "https://accounts.example/login" });
    expect(h.tabs.removed).toEqual([]);
  });

  test("a script sending a film page to another site is sent back", async () => {
    const h = await makeHarness({ minimumSecondsToTrack: 4 });
    await openTab(h, 1, FILM, { documentId: "a" });
    await fromPage(h, 1, "cineonMeta", filmMeta);
    await play(h, 1, 100, 8, 9000);
    await h.runtime.navCommitted({ tabId: 1, frameId: 0, url: "https://ads.example/landing", documentId: "b", transitionType: "link", transitionQualifiers: ["client_redirect"] });
    // Back on the film's page (the browser's back navigation), then the toast.
    await h.runtime.navCommitted({ tabId: 1, frameId: 0, url: FILM, documentId: "a2", transitionType: "link", transitionQualifiers: ["forward_back"] });
    await h.clock.advance(1600);
    const tab = h.runtime.current!.browser.tab(1)!;
    expect(tab.blocked.redirects).toBe(1);
    expect(tab.lastBannerForTests).toBe("toast|Blocked redirect to ads.example|offer");
  });
});

describe("profiles", () => {
  test("a page's signal and request to switch person open one session for them", async () => {
    const h = await makeHarness({ minimumSecondsToTrack: 4 });
    const first = h.runtime.current!;
    await openTab(h, 1, FILM);
    await fromPage(h, 1, "cineonMeta", filmMeta);
    await play(h, 1, 100, 8, 9000);
    const guest = await first.profiles.add("Guest");
    await first.profiles.markUsed(guest.id);
    first.heard({ type: "profile", profileId: guest.id, origin: "page" });
    const request = h.runtime.switchProfile(guest.id);
    const during = h.runtime.ready();
    await request;
    const session = await during;
    expect(session.profile.id).toBe(guest.id);
    expect(h.runtime.current).toBe(session);
    expect(first.isClosed).toBe(true);
    // The first person's progress was saved on the way out, and the tab carries no one's track.
    const firstDb = await Database.open(Database.nameFor(first.profile.id));
    expect((await firstDb.progress(UrlKey.make(FILM)))?.position).toBe(108);
    firstDb.close();
    expect(h.runtime.registry.get(1)!.track).toBeNull();
    expect(session.library.titles.size).toBe(0);
  });
});

describe("tabs across worker restarts", () => {
  test("a new worker reads the tabs back, drops closed ones and keeps the track", async () => {
    const h = await makeHarness({ minimumSecondsToTrack: 4 });
    await openTab(h, 1, FILM);
    await openTab(h, 2, "https://kino.example/");
    await fromPage(h, 1, "cineonMeta", filmMeta);
    await play(h, 1, 100, 8, 9000);
    await h.runtime.registry.saveNow();
    const stored = (await h.sessionStore.get(TABS_STORAGE_KEY)) as { tabs: unknown[] };
    expect(stored.tabs).toHaveLength(2);

    h.tabs.infos.delete(2);
    const next = new Runtime({ ...h.runtime.deps });
    await next.ready();
    expect(next.registry.get(2)).toBeNull();
    const tab = next.registry.get(1)!;
    expect(tab.track?.urlKey).toBe(UrlKey.make(FILM));
    expect(tab.parsed?.name).toBe("Dune");
    // And carries on recording into the same session.
    const before = tab.track!.session.id;
    await play(h, 1, 108, 0, 9000);
    expect(next.registry.get(1)!.track?.session.id).toBe(before);
  });

  test("closing a tab saves where it was", async () => {
    const h = await makeHarness({ minimumSecondsToTrack: 4 });
    await openTab(h, 1, FILM);
    await fromPage(h, 1, "cineonMeta", filmMeta);
    await play(h, 1, 100, 8, 9000);
    await h.runtime.tabRemoved(1);
    await settle();
    expect((await h.runtime.current!.db.progress(UrlKey.make(FILM)))?.position).toBe(108);
    expect(h.runtime.registry.get(1)).toBeNull();
  });
});

describe("page requests", () => {
  test("ping, tab state and the active player", async () => {
    const h = await makeHarness({ minimumSecondsToTrack: 4 });
    const ask = uiClient(h);
    expect((await ask("ping")).value).toEqual({ version: "0.0.0", target: "chrome" });
    await openTab(h, 1, FILM);
    await fromPage(h, 1, "cineonMeta", filmMeta);
    await play(h, 1, 100, 8, 9000);
    const state = (await ask("tab.state", { tabId: 1 })).value.tab;
    expect(state).toMatchObject({ tabId: 1, url: FILM, host: "kino.example", media: { position: 108, duration: 9000, isPlaying: true } });
    expect(state.parsed.name).toBe("Dune");
    expect(state.linkedTitleId).toBeGreaterThan(0);
    expect((await ask("player.active")).value.tab.tabId).toBe(1);
    expect((await ask("tab.state", { tabId: 99 })).value).toEqual({ tab: null });
  });

  test("player commands reach media.js in the video's frame", async () => {
    const h = await makeHarness();
    await openTab(h, 1, FILM);
    await fromPage(h, 1, "cineonMedia", media("play", 10, 9000), 4, "https://player.example/embed");
    const ask = uiClient(h);
    expect((await ask("player.command", { tabId: 1, command: { kind: "seek", seconds: 61 } })).value).toEqual({ ok: true });
    expect(h.page.calls.filter((c) => c.method === "seek").map((c) => [c.frameId, ...c.args])).toEqual([[4, 61]]);
    await ask("player.command", { tabId: 1, command: { kind: "rate", rate: 1.5 } });
    expect(calls(h, 1, "rate")).toEqual([[1.5]]);
  });

  test("adding a tab's film to the backlog", async () => {
    const h = await makeHarness();
    const ask = uiClient(h);
    await openTab(h, 1, FILM);
    expect((await ask("library.addFromTab", { tabId: 1 })).value).toEqual({ kind: "needsName", query: "" });
    await fromPage(h, 1, "cineonMeta", filmMeta);
    const added = (await ask("library.addFromTab", { tabId: 1 })).value;
    expect(added).toMatchObject({ kind: "done", message: "Added Dune to backlog" });
    expect(h.runtime.current!.library.titles.get(added.titleId)?.status).toBe("backlog");
    expect((await ask("library.addFromTab", { tabId: 1 })).value.message).toBe("Dune is in backlog");
  });

  test("switching a site's shields saves them, tells every frame and reloads the tab", async () => {
    const h = await makeHarness();
    const ask = uiClient(h);
    await openTab(h, 1, FILM);
    const prefs = { host: "kino.example", shieldsOff: true, allowPopups: false, allowRedirects: false, trackingOff: false };
    expect((await ask("shields.setSite", { host: "kino.example", prefs, tabId: 1 })).value).toEqual({ ok: true });
    expect(h.runtime.current!.shields.prefsFor("www.kino.example").shieldsOff).toBe(true);
    await settle();
    expect(h.sent.some((s) => s.tabId === 1 && (s.message as { noShield?: boolean }).noShield === true)).toBe(true);
  });

  test("shields.state lists the catalogue with the build's counts", async () => {
    const h = await makeHarness();
    const ask = uiClient(h, async () => ({ lists: [{ id: "easylist", appRules: 54218 }] }));
    const value = (await ask("shields.state")).value;
    expect(value.catalog.map((l: { id: string }) => l.id)).toContain("easylist");
    expect(value.ruleCounts).toEqual({ easylist: 54218 });
  });

  test("downloads without a download center answer an empty state", async () => {
    const h = await makeHarness();
    const ask = uiClient(h);
    expect((await ask("downloads.state")).value).toEqual({ items: [], job: null, proposal: null, isBusy: false });
    const start = await ask("downloads.start", { tabId: 1 });
    expect(start.value).toEqual({ ok: false, message: "Open a film's page first, then download it from there" });
  });

  test("a library change from a page is reloaded; the background's own writes are announced", async () => {
    const h = await makeHarness();
    const session = h.runtime.current!;
    const other = await session.library.addTitle("Arrival", { year: 2016, kind: "film", status: "backlog" });
    expect(h.pages.of("library").length).toBeGreaterThan(0);
    const posted = h.pages.of("library").length;
    session.heard({ type: "library", profileId: session.profile.id, keys: ["titles"], origin: "page" });
    await h.clock.advance(100);
    await settle();
    // A reload isn't announced again.
    expect(h.pages.of("library").length).toBe(posted);
    expect(session.library.titles.has(other!.id)).toBe(true);
  });

  test("the player signal follows playback, at most once a second", async () => {
    const h = await makeHarness({ minimumSecondsToTrack: 4 });
    await openTab(h, 1, FILM);
    await fromPage(h, 1, "cineonMeta", filmMeta);
    await play(h, 1, 100, 6, 9000);
    const players = h.pages.of("player");
    expect(players.length).toBeGreaterThan(0);
    expect(players.at(-1)!.player?.media?.isPlaying).toBe(true);
    await fromPage(h, 1, "cineonMedia", media("pause", 107, 9000));
    await h.clock.advance(1500);
    expect(h.pages.of("player").at(-1)!.player?.media?.isPlaying).toBe(false);
  });
});
