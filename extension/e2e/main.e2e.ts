// e2e.py's main walk-through (`run_tests`), one test per part so each starts in its own browser.
// Check names are e2e.py's; where the extension does something else on purpose (notes/runtime.md,
// "Not 1:1"), the check says so in a comment or is skipped with the reason.
import { readFileSync } from "node:fs";
import path from "node:path";
import { BASE, Cineon, PORT, minutes, skipSection, sleep, test } from "./test.ts";
import { DIST } from "./cineon.ts";

const DUNE = "/watch/dune-part-two-2024";

test("[main] startup: the rule lists", async ({ cineon: c }) => {
  c.heading("Startup");
  const meta = JSON.parse(readFileSync(path.join(DIST, "rules/meta.json"), "utf8")) as {
    enabledRules: number;
    lists: { id: string; enabled: boolean; appRules: number }[];
  };
  const wanted = meta.lists.filter((l) => l.enabled).map((l) => l.id);
  // The Mac compiles its lists on first launch; here they're built in, and the browser enables them on install.
  const enabled = await c.waitUntil(async () => {
    const ids = await c.inWorker(() => chrome.declarativeNetRequest.getEnabledRulesets(), null);
    return wanted.length === 5 && wanted.every((id) => ids.includes(id)) ? ids : null;
  }, 60);
  await c.check("all five rule lists compile on first launch", enabled, `${wanted.join(",")} vs ${enabled}`);
  // As Settings counts them: the apps' rules in the enabled lists (folded into far fewer DNR rules).
  const snapshot = await c.ui<{ ruleCounts: Record<string, number> }>("shields.state");
  const count = Object.entries(snapshot?.ruleCounts ?? {})
    .filter(([id]) => wanted.includes(id))
    .reduce((sum, [, n]) => sum + n, 0);
  await c.check("over 100,000 blocking rules active", count > 100_000, String(count));
  // Not in e2e.py: the browser took every converted rule. What's left of the static-rule pool plus
  // what the lists use comes to a round pool size only if none was refused.
  const available = await c.inWorker(() => chrome.declarativeNetRequest.getAvailableStaticRuleCount(), null);
  await c.check("the browser accepts every converted rule", (available + meta.enabledRules) % 10_000 === 0, `${available} available + ${meta.enabledRules} used`);
});

test("[main] film page, tracking, resume and finishing", async ({ cineon: c }) => {
  test.setTimeout(minutes(6));
  c.heading("Film page: messy title, cross-origin player, ad traps");
  await c.openPage(DUNE);
  let s = await c.state();
  await c.check("title recognised without page furniture", s.parsed.startsWith("Dune: Part Two|2024"), s.parsed);
  await c.check("kind recognised as film", s.parsed.includes("|film|"), s.parsed);

  const adLoaded = await c.evaluate("document.getElementById('adimg').naturalWidth");
  await c.check("ad image on popads.net was blocked", adLoaded === "0", adLoaded);
  const hidden = await c.evaluate("getComputedStyle(document.getElementById('cosmetic')).display");
  await c.check("cosmetic rule hid the ad box", hidden === "none", hidden);
  const counted = await c.waitUntil(async () => !(await c.state()).blocked.includes("ads: 0"), 5);
  await c.check("blocked ads are counted", counted, (await c.state()).blocked);

  // First real click lands on the invisible layer over the page.
  await c.click(700, 300);
  await sleep(1000);
  const trapGone = await c.evaluate("document.getElementById('x8f3k') === null");
  await c.check("click trap removed by the sweeper", trapGone === "true", trapGone);
  const fired = await c.evaluate("String(window.__trapFired)");
  await c.check("trap's own click handler never ran", fired === "undefined", fired);

  // Real click on the page body, which tries to open a pop-up from a document handler.
  await c.click(500, 20);
  await sleep(1000);
  const popped = await c.waitUntil(async () => {
    const st = await c.state();
    return Cineon.webTabs(st).length === 1 && !st.blocked.includes("popups: 0") ? st : null;
  }, 5);
  s = await c.state();
  await c.check("pop-up was blocked, no new tab", popped, `${s.tablist} ${s.blocked}`);

  c.heading("Tracking playback");
  await c.startPlaying();
  const playing = await c.waitUntil(async () => (await c.state()).media.includes("playing=true"), 8);
  await c.check("video in cross-origin iframe detected and playing", playing, (await c.state()).media);
  const joined = async () => {
    const titles = new Map((await c.rows("titles")).map((t) => [t.id, t]));
    return (await c.rows("sessions")).map((x) => ({ ...x, title: titles.get(x.title_id) }) as Record<string, any>);
  };
  const rows = await c.waitUntil(async () => {
    const all = await joined();
    return all.length ? all : null;
  }, 20);
  await c.check("session recorded on the timeline", rows, rows);
  if (rows) {
    const first = rows[0]!;
    await c.check("session names the right film", String(first.title?.name).startsWith("Dune"), first.title);
    await c.check("title moved to watching", first.title?.status === "watching", first.title);
    await c.check("session records the site", first.host === "127.0.0.1", first);
  }

  await c.mediaEval("document.querySelector('video').currentTime = 300; true");
  await sleep(1000);
  await c.mediaEval("var v=document.querySelector('video'); v.play(); true");
  const saved = await c.waitUntil(async () => {
    const p = await c.rows("progress");
    return p.length && p[0]!.position > 295 ? p : null;
  }, 16);
  await c.check("position is saved while watching", saved, await c.rows("progress"));

  // Ambient light from the video's own frames (zones of 0–255 here; the Mac's are 0–1).
  const lit = await c.waitUntil(async () => {
    const a = (await c.state()).ambient;
    return a !== "-" && a.split(/[ ,]/).some((n) => Number(n) > 0) ? a : null;
  }, 10);
  s = await c.state();
  await c.check("ambient light is reading colour from the film", lit, `ambient=${s.ambient} media=${s.media} ambientOn=${s.ambientOn} url=${s.url}`);

  c.heading("Video whose frames can't be read");
  await c.openPage("/tainted");
  await sleep(800);
  await c.startPlaying();
  const tainted = await c.waitUntil(async () => (await c.state()).framesBlocked === "true", 8);
  await c.check("cross-origin video falls back without errors", tainted, (await c.state()).framesBlocked);
  await sleep(7000);
  console.log(`    fallback ambient: ${(await c.state()).ambient}`);
  await c.closeTab();

  c.heading("Resume across a reload of the page");
  const before = Math.max(0, ...(await c.rows("progress")).map((p) => p.position));
  await c.closeTab();
  await sleep(500);
  s = await c.state();
  await c.check("closing the tab leaves none open", Cineon.webTabs(s).length === 0, s.tablist);
  await c.openPage(DUNE);
  // The Mac reads the position as soon as the video reports; the seek may land a moment after that here.
  const resumed = await c.waitUntil(async () => {
    const position = await c.mediaPosition();
    return position > before - 15 ? position : null;
  }, 10);
  await c.check("video resumed at the saved place", resumed, `${await c.mediaPosition()} vs ${before}`);

  c.heading("Finishing a film");
  await c.startPlaying();
  await c.mediaEval("var v=document.querySelector('video'); v.muted=true; v.currentTime = v.duration * 0.95; v.play(); true");
  const watched = await c.waitUntil(async () => (await c.rows("titles")).find((t) => t.name.startsWith("Dune") && t.status === "watched"), 25);
  await c.check("film moves to watched at 92 percent", watched, (await c.rows("titles")).map((t) => `${t.name}:${t.status}`));
});

test("[main] Ukrainian series page", async ({ cineon: c }) => {
  c.heading("Ukrainian series page");
  await c.openPage("/serial/rozryv/2-sezon/4-seriya");
  const s = await c.state();
  await c.check("Ukrainian title cleaned", s.parsed.startsWith("Розрив|"), s.parsed);
  await c.check("season and episode read from Ukrainian", s.parsed.includes("S2E4"), s.parsed);
  await c.check("kind recognised as series", s.parsed.includes("|series|"), s.parsed);
  await c.startPlaying();
  const rows = await c.waitUntil(async () => (await c.rows("sessions")).find((r) => r.season === 2 && r.episode === 4), 20);
  await c.check("episode recorded on the timeline", rows, (await c.rows("sessions")).map((r) => [r.title_id, r.season, r.episode]));
  await c.mediaEval("document.querySelector('video').pause(); true");
});

test("[main] structured data page", async ({ cineon: c }) => {
  c.heading("Structured data page");
  await c.openPage("/tv/the-bear/episode");
  const s = await c.state();
  await c.check("JSON-LD series name wins over page title", s.parsed.startsWith("The Bear|"), s.parsed);
  await c.check("JSON-LD season and episode", s.parsed.includes("S2E7"), s.parsed);
});

const DEEP =
  "window.__deep=document.querySelector('shadow-outer').shadowRoot.querySelector('shadow-inner').shadowRoot.querySelector('video'); window.__deep.muted=true; window.__deep.play(); window.dispatchEvent(new Event('pointerdown')); 1";

test("[main] video inside nested web components", async ({ cineon: c }) => {
  c.heading("Video inside nested web components");
  await c.openPage("/shadow");
  await sleep(1000);
  await c.evaluate(DEEP);
  const seen = await c.waitUntil(async () => (await c.state()).media.includes("playing=true"), 12);
  await c.check("video two shadow roots deep is detected", seen, (await c.state()).media);
  await c.evaluate("window.__deep.pause(); 1");
});

test("[main] episode kept only in the address fragment", async ({ cineon: c }) => {
  c.heading("Episode kept only in the address fragment");
  await c.openPage("/series/drama/1-mentalist-2008.html#t:238-s:3-e:5");
  await sleep(1000);
  let s = await c.state();
  await c.check("dub removed from the name", s.parsed.startsWith("Менталист|"), s.parsed);
  await c.check("episode read from the fragment", s.parsed.includes("S3E5"), s.parsed);
  await c.startPlaying();
  const sessions = async (season: number, episode: number) => (await c.rows("sessions")).find((r) => r.season === season && r.episode === episode);
  const first = await c.waitUntil(() => sessions(3, 5), 15);
  await c.check("first episode recorded", first, (await c.rows("sessions")).map((r) => [r.season, r.episode]));
  await c.evaluate("location.hash='#t:238-s:3-e:6'; 1");
  const moved = await c.waitUntil(async () => (await c.state()).parsed.includes("S3E6"), 5);
  s = await c.state();
  await c.check("changing the fragment moves to the next episode", moved, s.parsed);
  await c.mediaEval("var v=document.querySelector('video'); v.currentTime=60; v.play(); true");
  const second = await c.waitUntil(() => sessions(3, 6), 15);
  await c.check("second episode gets its own timeline entry", second, (await c.rows("sessions")).map((r) => [r.season, r.episode]));
  await c.mediaEval("document.querySelector('video').pause(); true");
});

test("[main] short clip", async ({ cineon: c }) => {
  c.heading("Short clip");
  const before = await c.count("sessions");
  await c.openPage("/clip", { parsed: false });
  await c.startPlaying();
  await sleep(7000);
  const after = await c.count("sessions");
  await c.check("a 30-second clip is not tracked", before === after, `${before} to ${after}`);
});

test("[main] turning shields off for one site", async ({ cineon: c }) => {
  c.heading("Turning shields off for one site");
  await c.run("sitepref", { host: "127.0.0.1", shieldsOff: 1 });
  // The rule that lets the site through applies from the next load: a new tab is one.
  await c.openPage(DUNE);
  await sleep(1000);
  const s = await c.state();
  await c.check("no ads are blocked on a site with shields off", s.blocked.includes("ads: 0"), s.blocked);
  const shown = await c.evaluate("getComputedStyle(document.getElementById('cosmetic')).display");
  await c.check("cosmetic rules are off there too", shown !== "none", shown);
  await c.run("sitepref", { host: "127.0.0.1", shieldsOff: 0 });
  await sleep(300);
  await c.openPage(DUNE);
  const back = await c.waitUntil(async () => !(await c.state()).blocked.includes("ads: 0"), 5);
  await c.check("blocking returns when shields go back on", back, (await c.state()).blocked);
});

test("[main] sites that aren't about films", async ({ cineon: c }) => {
  c.heading("Sites that aren't about films");
  await c.run("sitepref", { host: "127.0.0.1", trackingOff: 1 });
  const before = await c.count("sessions");
  await c.openPage("/shadow");
  await sleep(1000);
  await c.evaluate(DEEP);
  await sleep(8000);
  await c.check("a site with tracking off adds nothing to the timeline", (await c.count("sessions")) === before, await c.rows("sessions"));
  await c.evaluate("window.__deep.pause(); 1");
  await c.run("sitepref", { host: "127.0.0.1", trackingOff: 0 });
});

test("[main] silent autoplay banner", async ({ cineon: c }) => {
  c.heading("Silent autoplay banner");
  const before = await c.count("sessions");
  await c.openPage("/hero", { parsed: false });
  await sleep(8000);
  const playing = await c.evaluate("!document.getElementById('v').paused");
  await c.check("the banner really is playing", playing === "true", playing);
  const after = await c.count("sessions");
  await c.check("a silent autoplay banner is not tracked", before === after, `${before} to ${after}`);
});

test("[main] hostile navigation", async ({ cineon: c }) => {
  c.heading("Hostile navigation");
  // The extension shields pop-ups and redirects only on pages Cineon has a stake in (the person's
  // sites, pages with a film): the browser around it also shows mail and banks, whose redirects must
  // work (notes/runtime.md). The Mac shields every page; here the fixture site is one of the person's.
  await c.run("addsite", { url: BASE + "/", name: "FlixDemo" });
  await c.openPage("/redirector", { parsed: false });
  // A redirect can't be cancelled in MV3: the page is sent back once it has left.
  const counted = await c.waitUntil(async () => !(await c.state()).blocked.includes("redirects: 0"), 8);
  const back = await c.waitUntil(async () => (await c.state()).url.endsWith("/redirector"), 8);
  await sleep(1500);
  const s = await c.state();
  await c.check("scripted redirect blocked", back && s.url.endsWith("/redirector"), s.url);
  await c.check("redirect counted", counted, s.blocked);
  c.skip("fake download blocked", "not ported: the browser's downloads are the person's, and nothing ties one to a tab (notes/runtime.md)");
});

test("[main] legitimate navigation still works", async ({ cineon: c }) => {
  c.heading("Legitimate navigation still works");
  await c.openPage("/same-site", { parsed: false });
  await c.click(20, 10);
  await sleep(200);
  await c.evaluate("document.getElementById('next').click(); 1");
  const moved = await c.waitUntil(async () => (await c.state()).url.endsWith("/same-site-2"), 5);
  await c.check("same-site link works with shields on", moved, (await c.state()).url);

  await c.openPage("/same-site", { parsed: false });
  // The Mac asks its tab; here the browser's own history is what the back button has.
  const length = await c.evaluate("history.length");
  await c.check("a new tab has nothing to go back to", length === "1", length);
  const before = Cineon.webTabs(await c.state()).length;
  const rect = await c.evaluate("(()=>{const r=document.getElementById('blank').getBoundingClientRect();return Math.round(r.x+r.width/2)+','+Math.round(r.y+r.height/2)})()");
  const [x, y] = rect.split(",").map(Number);
  await c.click(x!, y!);
  const opened = await c.waitUntil(async () => Cineon.webTabs(await c.state()).length === before + 1, 5);
  const s = await c.state();
  await c.check("real click on a same-site new-tab link opens a tab", opened, `${s.tablist} ${s.toast}`);
});

test("[main] search everywhere", async ({ cineon: c }) => {
  c.heading("Search everywhere");
  await c.run("addsite", { url: BASE + "/", name: "FlixDemo", search: BASE + "/search?q=%s" });
  await c.run("addsite", { url: `http://localhost:${PORT}/`, name: "LocalDemo" });
  await sleep(500);
  // The Mac's cineon://search link; here the request the Cineon page and command bar send.
  const answer = await c.ui<{ tabs: number }>("search.everywhere", { query: "dune part", titleId: null });
  const listed = await c.waitUntil(async () => {
    const list = (await c.state()).tablist;
    return list.includes("/search?q=dune") ? list : null;
  }, 5);
  await c.check("search opens on sites with search set up", listed, `${JSON.stringify(answer)} ${(await c.state()).tablist}`);
  const found = await c.waitUntil(async () => {
    const page = c.pageWith((u) => u.includes("/search?q=dune"));
    const text = page ? await page.locator("#result").textContent({ timeout: 2000 }) : "";
    return text?.includes("Results for dune part");
  }, 8);
  await c.check("site search page loaded with the query", found);
  c.skip("a clicked-through search result survives as a tab", "search results are ordinary browser tabs (grouped); Cineon never closes them");
  c.skip("untouched search results are cleaned up", "search results are ordinary browser tabs (grouped); Cineon never closes them");

  c.heading("Learning search from a page");
  await c.run("open", { url: `http://localhost:${PORT}/` });
  const learned = await c.waitUntil(async () => (await c.state()).sites.includes(`localhost|http://localhost:${PORT}/search?q=%s`), 8);
  await c.check("search address learned from the site's form", learned, (await c.state()).sites);
});

test("[main] hibernation", async ({ cineon: c }) => {
  c.heading("Hibernation");
  // e2e.py has many tabs open by now; this browser is new, so open one to put to sleep first.
  await c.openPage("/same-site-2", { parsed: false });
  await c.openPage("/same-site", { parsed: false });
  await c.run("hibernate");
  await sleep(500);
  let s = await c.state();
  await c.check("idle tabs release their web view", s.tablist.includes("[h]"), s.tablist);
  await c.run("selecttab", { i: 0 });
  await sleep(1500);
  const awake = await c.waitUntil(async () => {
    const st = await c.state();
    return st.url !== "-" && !Cineon.webTabs(st)[0]?.includes("[h]");
  }, 5);
  s = await c.state();
  await c.check("tab wakes up on selection", awake, s.tablist);
});

test("[main] profiles", async ({ cineon: c }) => {
  c.heading("Profiles");
  const first = (await c.state()).profile;
  // e2e.py's first profile has a library by now; give this one something to keep.
  await c.run("addtitle", { name: "Heat", year: 1995, kind: "film", status: "watched" });
  await c.openPage("/same-site", { parsed: false });
  const titlesBefore = await c.count("titles");
  await c.run("addprofile", { name: "Guest", switch: 1 });
  const switched = await c.waitUntil(async () => (await c.state()).profile === "Guest", 6);
  await c.check("switched to a new profile", switched, (await c.state()).profile);
  await sleep(1000);
  const databases = (await c.databases()).filter((d) => d.startsWith("cineon-"));
  await c.check("each profile has its own database", databases.length === 2, databases);
  const empty = await c.waitUntil(async () => (await c.count("titles")) === 0, 4);
  await c.check("new profile starts with an empty library", empty, `first had ${titlesBefore}`);
  c.skip("cookies don't leak between profiles", "Cineon's people share the browser profile's cookies; the browser's own profiles keep them apart");
  await c.run("switchprofile", { name: first });
  const back = await c.waitUntil(async () => (await c.state()).profile !== "Guest", 6);
  await c.check("switching back works", back);
  await sleep(1000);
  await c.check("first profile's library is intact", (await c.count("titles")) === titlesBefore, `${await c.count("titles")} vs ${titlesBefore}`);
});

const IMPORT_REASON =
  "the extension imports this browser's own history (chrome.history) from the Cineon page's Import sheet; there are no other browsers' files to read and no debug command for it";

test("[main] import from another browser", async ({}, info) => {
  console.log("Import from another browser");
  await skipSection(
    info,
    [
      "the fake Arc is found and read",
      "films are found in the history",
      "everyday pages are left out",
      "a series keeps the episode you ended on",
      "film sites are added to the grid",
      "visited pages are searchable",
      "imported films appear on the timeline",
      "importing twice adds nothing",
    ].map((name) => [name, IMPORT_REASON] as const),
  );
});

test("[memory] the app stays light", async ({}, info) => {
  console.log("Memory");
  await skipSection(info, [["app process stays light", "the extension lives in the browser's processes; there's no app process of its own to measure"]]);
});
