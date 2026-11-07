import { EpisodeRef, UrlKey, WatchProgress, WatchSession } from "../../src/core/data";
import { TitleParser } from "../../src/core/parsing";
import { FetchSiteProbe, RescueEngine, extractLinks, settleRestoredRescue } from "../../src/background/rescue";
import type { MediaEvent, RescueOption, TabState } from "../../src/background/tabState";
import { addTab, makeRig, type Rig, settle } from "./rescueFakes";

const FAILED = "https://flixdead.example/watch/dune-2021";

function html(links: string): Response {
  return new Response(`<!doctype html><html><body>${links}</body></html>`, { status: 200, headers: { "content-type": "text/html" } });
}

/** A fetch answering each address from a table, "Not found" for the rest. */
function fetchFrom(pages: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const page = Object.entries(pages).find(([prefix]) => url.startsWith(prefix));
    const response = page ? page[1]() : new Response("missing", { status: 404 });
    Object.defineProperty(response, "url", { value: url });
    return response;
  }) as typeof fetch;
}

async function engineWith(rig: Rig, fetchImpl: typeof fetch = fetchFrom({})): Promise<RescueEngine> {
  const engine = new RescueEngine(rig.ctx, rig.platform, { fetch: fetchImpl });
  (rig.ctx as { rescue: RescueEngine }).rescue = engine;
  return engine;
}

async function addDune(rig: Rig, year = 2021): Promise<number> {
  const title = await rig.library.addTitle("Dune", { year, kind: "film", status: "watching" });
  return title!.id;
}

async function addSearchSite(rig: Rig, home: string, name: string, lastUsedAt: number | null = null): Promise<void> {
  const site = await rig.library.addSite(home, name);
  await rig.library.updateSite({ ...site!, searchTemplate: `${home}search?q=%s`, lastUsedAt });
}

const event = (type: string): MediaEvent => ({
  type,
  position: 100,
  duration: 7000,
  paused: false,
  muted: false,
  rate: 1,
  width: 1920,
  height: 1080,
  isTopFrame: true,
  frameUrl: "",
  userActivated: true,
});

describe("reading links out of HTML", () => {
  it("resolves addresses, collects the words around each link, and keeps each address once", () => {
    const page = `
      <ul>
        <li class="result"><a href="/films/dune-2021.html" title="Watch">Dune &amp; more</a><span>2021 · Sci-Fi</span></li>
        <li><a href='https://other.example/x'><img alt="Dune poster" src="p.jpg"></a></li>
      </ul>
      <a href="/films/dune-2021.html">again</a>
      <a href="javascript:void(0)">nothing</a>
      <a href="mailto:x@y.z">mail</a>`;
    const links = extractLinks(page, "https://site.example/search?q=dune");
    expect(links.map((l) => l.url)).toEqual(["https://site.example/films/dune-2021.html", "https://other.example/x"]);
    expect(links[0]!.text).toBe("Dune & more\nWatch");
    expect(links[0]!.context).toContain("2021");
    expect(links[1]!.text).toBe("Dune poster");
  });

  it("doesn't take the words of a card that closed before the link", () => {
    const page = `<article><p>Arrival 2016</p></article><a href="/a/b">Dune</a>`;
    expect(extractLinks(page, "https://s.example/")[0]!.context).toBe("");
  });
});

describe("SiteProbe", () => {
  it("reads statuses the way the Mac does", () => {
    expect(FetchSiteProbe.judge(200, "https://a.example/x", null)).toEqual({ kind: "alive", url: "https://a.example/x" });
    expect(FetchSiteProbe.judge(301, "https://b.example/", null).kind).toBe("alive");
    expect(FetchSiteProbe.judge(404, "u", null)).toEqual({ kind: "missing" });
    expect(FetchSiteProbe.judge(410, "u", null)).toEqual({ kind: "missing" });
    expect(FetchSiteProbe.judge(503, "u", "nginx")).toEqual({ kind: "dead" });
    expect(FetchSiteProbe.judge(403, "u", "cloudflare").kind).toBe("alive");
    expect(FetchSiteProbe.judge(500, "u", null)).toEqual({ kind: "dead" });
  });

  it("follows redirects to the final address, and a network error is dead", async () => {
    const probe = new FetchSiteProbe(fetchFrom({ "https://a.example": () => new Response("", { status: 200 }) }));
    expect(await probe.check("https://a.example/page")).toEqual({ kind: "alive", url: "https://a.example/page" });
    const broken = new FetchSiteProbe((async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch);
    expect(await broken.check("https://a.example/page")).toEqual({ kind: "dead" });
  });
});

describe("what was being watched", () => {
  it("comes from the track, then saved progress, then a past session, then a link", async () => {
    const rig = await makeRig();
    const engine = await engineWith(rig);
    const id = await addDune(rig);
    const tab = addTab(rig, 1, { url: FAILED });

    expect(await engine.context(tab, FAILED)).toBeNull();

    await rig.ctx.db.setLink(UrlKey.make(FAILED), id, EpisodeRef.none);
    expect(await engine.context(tab, FAILED)).toMatchObject({ titleId: id, names: ["Dune"], year: 2021, position: null });

    await rig.library.saveSession(
      WatchSession.make({ titleId: id, url: FAILED, host: "flixdead.example", startedAt: 1, endedAt: 2, endPosition: 900, duration: 7000 }),
    );
    expect(await engine.context(tab, FAILED)).toMatchObject({ titleId: id, position: 900, duration: 7000 });

    await rig.library.saveProgress(
      WatchProgress.make({ titleId: id, urlKey: UrlKey.make(FAILED), url: FAILED, position: 1200, duration: 7000, updatedAt: 3 }),
    );
    expect(await engine.context(tab, FAILED)).toMatchObject({ position: 1200 });

    tab.media = { position: 1500, duration: 7100, isPlaying: true, rate: 1 };
    tab.track = { titleId: id, ref: EpisodeRef.none, urlKey: UrlKey.make(FAILED), session: WatchSession.make({ id: 1, titleId: id }), lastFlush: 0, startedWith: 0, finishedAnnounced: false };
    expect(await engine.context(tab, FAILED)).toMatchObject({ position: 1500, duration: 7100 });

    tab.pendingResume = 42;
    expect((await engine.context(tab, FAILED))?.position).toBe(42);
  });

  it("adds the page's own names only when they were read from this address", async () => {
    const rig = await makeRig();
    const engine = await engineWith(rig);
    const meta = { url: "https://kino.example/serial/s1e2", title: "Дюна / Dune (2021) — season 1 episode 2", ld: [] };
    const tab = addTab(rig, 1, { url: meta.url, pageMeta: meta, parsed: TitleParser.parse(meta) });
    const context = await engine.context(tab, meta.url);
    expect(context?.names.length).toBeGreaterThan(0);
    expect(context?.year).toBe(2021);
    expect(await engine.context(tab, "https://kino.example/other")).toBeNull();
  });
});

describe("the site's other addresses", () => {
  it("carries on at a mirror that answers as the same site, from the same second", async () => {
    const rig = await makeRig();
    const engine = await engineWith(rig);
    const id = await addDune(rig);
    const failed = "https://hdrezka.ag/films/123-dune.html#t:1";
    await rig.library.addSite("https://hdrezka.ag/", "Rezka");
    await rig.library.saveProgress(
      WatchProgress.make({ titleId: id, urlKey: UrlKey.make(failed), url: failed, host: "rezka-ua.co", position: 600, duration: 9000, updatedAt: 5 }),
    );
    // A parking page under another brand doesn't count; the real mirror does.
    rig.probe.answers.set("https://rezka-ua.co/films/123-dune.html#t:1", { kind: "alive", url: "https://rezka-ua.co/films/123-dune.html" });
    const tab = addTab(rig, 1, { url: failed, failure: { host: "hdrezka.ag", message: "x", url: failed } });

    engine.pageFailed(tab, failed);
    await engine.idle();

    expect(rig.browser.loads).toEqual([{ tabId: 1, url: "https://rezka-ua.co/films/123-dune.html#t:1", resumingAt: 600, keepWatching: true }]);
    expect(tab.expectedResumeDuration).toBe(9000);
    expect(tab.rescue).toBeNull();
    expect(rig.library.sites[0]).toMatchObject({ host: "rezka-ua.co", homeUrl: "https://rezka-ua.co/", searchTemplate: null });
    expect(rig.toasts.current).toBe("hdrezka.ag is down. Continuing on rezka-ua.co.");
  });

  it("skips a mirror that now redirects to some other site", async () => {
    const rig = await makeRig();
    const engine = await engineWith(rig);
    const id = await addDune(rig);
    const failed = "https://hdrezka.ag/films/123-dune.html";
    await rig.library.saveProgress(
      WatchProgress.make({ titleId: id, urlKey: UrlKey.make(failed), url: failed, host: "rezka-ua.co", position: 600, duration: 9000, updatedAt: 5 }),
    );
    rig.probe.answers.set("https://rezka-ua.co/films/123-dune.html", { kind: "alive", url: "https://parking.example/" });
    const tab = addTab(rig, 1, { url: failed, failure: { host: "hdrezka.ag", message: "x", url: failed } });
    engine.pageFailed(tab, failed);
    await engine.idle();
    expect(rig.browser.loads).toEqual([]);
    expect(tab.rescue?.stage).toBe("finished");
  });
});

describe("searching the other sites", () => {
  const strong = `<li><a href="/films/dune-2021.html">Dune (2021)</a></li>`;
  const weak = `<li><a href="/films/dune-part.html">Dune</a> <span>1984</span></li>`;

  it("sorts strong matches first, then counts down and opens a dead page's film by itself", async () => {
    const rig = await makeRig();
    const id = await addDune(rig);
    await addSearchSite(rig, "https://weak.example/", "Weak", 200);
    await addSearchSite(rig, "https://strong.example/", "Strong", 100);
    const engine = await engineWith(
      rig,
      fetchFrom({ "https://weak.example/search": () => html(weak), "https://strong.example/search": () => html(strong) }),
    );
    await rig.library.saveProgress(
      WatchProgress.make({ titleId: id, urlKey: UrlKey.make(FAILED), url: FAILED, position: 600, duration: 9000, updatedAt: 5 }),
    );
    // Results drawn by script find nothing more.
    rig.page.handler = (_tab, _frame, target, method) => (target === "__cineonContent" && method === "links" ? [] : null);
    const tab = addTab(rig, 1, { url: FAILED, failure: { host: "flixdead.example", message: "x", url: FAILED } });

    engine.pageFailed(tab, FAILED);
    await rig.clock.advance(3000);
    await engine.idle();

    const rescue = tab.rescue!;
    expect(rescue.stage).toBe("finished");
    expect(rescue.options.map((o) => [o.siteName, o.isStrong])).toEqual([
      ["Strong", true],
      ["Weak", false],
    ]);
    expect(rescue.countdown).not.toBeNull();
    // A failed page shows the browser's error page: the search is a notification.
    const note = rig.notifier.shown.get("rescue-1");
    expect(note?.title).toBe("flixdead.example isn't answering");
    expect(note?.buttons).toEqual(["Open on Strong", "Leave it"]);
    expect(rig.browser.banners).toEqual([]);

    await rig.clock.advance(6000);
    await engine.idle();
    expect(rig.browser.loads).toEqual([{ tabId: 1, url: "https://strong.example/films/dune-2021.html", resumingAt: 600, keepWatching: true }]);
    expect(await rig.ctx.db.link(UrlKey.make("https://strong.example/films/dune-2021.html"))).toEqual({ titleId: id, ref: EpisodeRef.none });
    expect(rig.toasts.current).toBe("Continuing on Strong at 10:00");
    expect(tab.rescue).toBeNull();
    expect(rig.notifier.cleared).toContain("rescue-1");
  });

  it("only offers when the person asked: no countdown, banners over the player", async () => {
    const rig = await makeRig();
    const id = await addDune(rig);
    await addSearchSite(rig, "https://strong.example/", "Strong");
    const engine = await engineWith(rig, fetchFrom({ "https://strong.example/search": () => html(strong) }));
    const url = "https://playing.example/watch/dune";
    const tab = addTab(rig, 1, { url });
    tab.media = { position: 20, duration: 9000, isPlaying: false, rate: 1 };
    tab.track = { titleId: id, ref: EpisodeRef.none, urlKey: UrlKey.make(url), session: WatchSession.make({ id: 1, titleId: id }), lastFlush: 0, startedWith: 0, finishedAnnounced: false };

    engine.findElsewhere(tab);
    await engine.idle();

    expect(tab.rescue?.reason).toBe("manual");
    expect(tab.rescue?.countdown).toBeNull();
    const banner = rig.browser.lastBanner(1)!;
    expect(banner.id).toBe("rescue-search");
    expect(banner.actions?.map((a) => a.id)).toEqual(["open-0", "leave"]);
    expect(banner.seconds).toBeUndefined();

    engine.handleBanner("rescue-search", "open-0", tab);
    await engine.idle();
    // Twenty seconds in isn't worth jumping to.
    expect(rig.browser.loads).toEqual([{ tabId: 1, url: "https://strong.example/films/dune-2021.html", resumingAt: null, keepWatching: true }]);
    expect(rig.toasts.current).toBe("Continuing on Strong");
  });

  it("opens the series page for an episode and says which one to choose", async () => {
    const rig = await makeRig();
    const engine = await engineWith(rig);
    const tab = addTab(rig, 1, { url: "https://a.example/x" });
    const option: RescueOption = { siteName: "Kino", siteIcon: null, url: "https://kino.example/series/dune", label: "Dune", isStrong: true, score: 1 };
    tab.rescue = {
      id: "r", reason: "manual", host: "a.example", titleId: null, name: "Dune", names: ["Dune"], year: null, ref: EpisodeRef.make(1, 2),
      position: 300, duration: 3000, stage: "finished", mirrorsTotal: 0, sitesTotal: 1, sitesDone: 1, options: [option], countdown: null,
      isAbandoned: false, isStaying: false,
    };
    engine.take(option, tab);
    await engine.idle();
    expect(rig.browser.loads).toEqual([{ tabId: 1, url: "https://kino.example/series/dune", resumingAt: undefined, keepWatching: false }]);
    expect(rig.toasts.current).toBe("Opened Kino. Choose season 1, episode 2 and Cineon jumps to 5:00.");
  });

  it("falls back to a hidden probe tab when the results are drawn by script, and closes it", async () => {
    const rig = await makeRig();
    await addDune(rig);
    await addSearchSite(rig, "https://spa.example/", "Spa");
    const engine = await engineWith(rig, fetchFrom({ "https://spa.example/search": () => html("<div id=app></div>") }));
    rig.page.handler = (tabId, _frame, target, method) =>
      target === "__cineonContent" && method === "links"
        ? [{ href: "https://spa.example/films/dune-2021", text: "Dune (2021)", context: "" }, { href: 7 }]
        : null;
    const url = "https://playing.example/watch/dune";
    const tab = addTab(rig, 1, { url });
    await rig.ctx.db.setLink(UrlKey.make(url), rig.library.find("Dune")!.id, EpisodeRef.none);

    engine.findElsewhere(tab);
    await rig.clock.advance(1000);
    await engine.idle();

    expect(rig.tabs.created).toEqual([{ url: "https://spa.example/search?q=Dune", helper: true }]);
    expect(rig.tabs.updates[0]).toEqual({ tabId: 900, change: { muted: true, autoDiscardable: false } });
    expect(rig.tabs.removed).toEqual([900]);
    expect(rig.registry.get(900)).toBeNull();
    expect(tab.rescue?.options[0]).toMatchObject({ siteName: "Spa", url: "https://spa.example/films/dune-2021", isStrong: true });
  });

  it("stays when told to, and a later strong match doesn't start counting again", async () => {
    const rig = await makeRig();
    const id = await addDune(rig);
    await addSearchSite(rig, "https://one.example/", "One", 300);
    await addSearchSite(rig, "https://two.example/", "Two", 200);
    await addSearchSite(rig, "https://three.example/", "Three", 100);
    await addSearchSite(rig, "https://four.example/", "Four", 50);
    const page = (host: string) => () => html(`<li><a href="https://${host}/films/dune-2021">Dune (2021)</a></li>`);
    const engine = await engineWith(
      rig,
      fetchFrom({ "https://one.example": page("one.example"), "https://four.example": page("four.example") }),
    );
    rig.page.handler = () => [];
    await rig.library.saveProgress(WatchProgress.make({ titleId: id, urlKey: UrlKey.make(FAILED), url: FAILED, updatedAt: 1 }));
    const tab = addTab(rig, 1, { url: FAILED });

    engine.pageMissing(tab, FAILED);
    // The first batch of three finds One and starts counting down.
    for (let i = 0; i < 20 && tab.rescue?.countdown == null; i++) await settle();
    await rig.clock.advance(400);
    expect(tab.rescue?.countdown).not.toBeNull();
    // A page that answered shows the search over the player.
    expect(rig.browser.lastBanner(1)?.onExpire).toBe("open-0");
    engine.handleBanner("rescue-search", "stay", tab);
    expect(tab.rescue?.isStaying).toBe(true);
    expect(tab.rescue?.countdown).toBeNull();

    await rig.clock.advance(20_000);
    await engine.idle();
    expect(tab.rescue?.options.length).toBe(2);
    expect(tab.rescue?.countdown).toBeNull();
    expect(rig.browser.loads).toEqual([]);
  });

  it("doesn't ask again about a page someone said to leave", async () => {
    const rig = await makeRig();
    const id = await addDune(rig);
    const engine = await engineWith(rig);
    await rig.library.saveProgress(WatchProgress.make({ titleId: id, urlKey: UrlKey.make(FAILED), url: FAILED, updatedAt: 1 }));
    const tab = addTab(rig, 1, { url: FAILED, failure: { host: "x", message: "x", url: FAILED } });
    engine.pageFailed(tab, FAILED);
    await engine.idle();
    expect(tab.rescue).not.toBeNull();
    rig.notifier.shown.get("rescue-1")?.onClick?.(0);
    expect(tab.rescue).toBeNull();
    engine.pageFailed(tab, FAILED);
    await engine.idle();
    expect(tab.rescue).toBeNull();
  });

  it("does nothing with automatic rescue off", async () => {
    const rig = await makeRig({ autoRescue: false });
    const id = await addDune(rig);
    const engine = await engineWith(rig);
    await rig.library.saveProgress(WatchProgress.make({ titleId: id, urlKey: UrlKey.make(FAILED), url: FAILED, updatedAt: 1 }));
    const tab = addTab(rig, 1, { url: FAILED });
    engine.pageFailed(tab, FAILED);
    engine.pageMissing(tab, FAILED);
    await engine.idle();
    expect(tab.rescue).toBeNull();
  });
});

describe("a video in trouble", () => {
  it("offers to look elsewhere from inside the player, only in the tab in front", async () => {
    const rig = await makeRig();
    const engine = await engineWith(rig);
    const back = addTab(rig, 2, { url: "https://a.example/v", active: false });
    const front = addTab(rig, 1, { url: "https://a.example/w" });
    rig.browser.selectedId = 1;

    engine.videoTrouble(event("stalled"), back);
    expect(rig.browser.banners).toEqual([]);

    engine.videoTrouble(event("stalled"), front);
    expect(rig.browser.lastBanner(1)).toEqual({
      id: "rescue",
      text: "This video is stuck.",
      actions: [{ id: "find", label: "Find another source", primary: true }],
      timeout: 20,
    });
    engine.videoTrouble(event("failed"), front);
    expect(rig.browser.lastBanner(1)?.text).toBe("This video stopped.");

    engine.videoRecovered(front);
    expect(rig.browser.cleared).toEqual([{ tabId: 1, id: "rescue" }]);
    // The plain "rescue" banner's button is the autopilot's to handle.
    engine.handleBanner("rescue", "find", front);
    expect(front.rescue).toBeNull();
  });

  it("is quiet with automatic rescue off or a search already running", async () => {
    const rig = await makeRig({ autoRescue: false });
    const engine = await engineWith(rig);
    const tab = addTab(rig, 1, { url: "https://a.example/w" });
    rig.browser.selectedId = 1;
    engine.videoTrouble(event("failed"), tab);
    expect(rig.browser.banners).toEqual([]);
  });
});

describe("after the worker stopped", () => {
  it("treats a search that was running as finished", () => {
    const tab = { rescue: { stage: "searching", countdown: 3 } } as unknown as TabState;
    expect(settleRestoredRescue(tab)).toBe(true);
    expect(tab.rescue).toMatchObject({ stage: "finished", countdown: null });
    expect(settleRestoredRescue(tab)).toBe(false);
  });

  it("sorts options strong first, then by score, keeping the order of equals", () => {
    const o = (siteName: string, isStrong: boolean, score: number): RescueOption => ({ siteName, siteIcon: null, url: siteName, label: "", isStrong, score });
    expect(RescueEngine.sorted([o("a", false, 0.95), o("b", true, 0.9), o("c", true, 0.99), o("d", true, 0.9)]).map((x) => x.siteName)).toEqual([
      "c",
      "b",
      "d",
      "a",
    ]);
  });
});
