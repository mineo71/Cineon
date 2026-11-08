// e2e.py's rescue_tests: a dead address, a dead site, a page taken down, a failing or hanging video,
// a different video at the address, and the places rescue must keep out of.
import { BASE, PORT, minutes, sleep, test } from "./test.ts";

/** Tells the fixture site to kill a host or a page, as e2e.py's `fetch("/kill?…")`. */
async function kill(query: string): Promise<void> {
  await fetch(`${BASE}/kill?${query}`);
}

test("[rescue] finding the film again", async ({ cineon: c }) => {
  test.setTimeout(minutes(10));
  const progress = async () => (await c.rows("progress")).map((p) => p.position as number);

  c.heading("Rescue: another address of the same site");
  await c.freshProfile("Rescue");
  await c.run("addsite", { url: BASE + "/", name: "OtherDemo", search: BASE + "/search?q=%s" });
  await sleep(300);
  const alive = `http://flix-alive.localhost:${PORT}/watch/dune-part-two-2024`;
  const dying = `http://flix-dying.localhost:${PORT}/watch/dune-part-two-2024`;
  await c.run("open", { url: alive });
  await c.waitUntil(async () => {
    const s = await c.state();
    return s.url.includes("flix-alive") && s.parsed !== "-";
  }, 10);
  // The Mac keeps every page in its history, so opening the other address is enough for it to be
  // known. The extension only remembers hosts where something was watched (or the person's sites),
  // so the film plays there for a moment first.
  await c.startPlaying();
  await c.waitUntil(async () => (await c.rows("sessions")).some((x) => String(x.host).startsWith("flix-alive")), 20);
  await c.mediaEval("document.querySelector('video').pause(); true");
  await c.closeTab();
  await c.run("open", { url: dying });
  await c.waitUntil(async () => {
    const s = await c.state();
    return s.url.includes("flix-dying") && s.parsed !== "-";
  }, 10);
  await c.startPlaying();
  await c.waitUntil(async () => (await c.count("sessions")) > 0, 20);
  await c.mediaEval("var v=document.querySelector('video'); v.currentTime=300; v.play(); true");
  await c.waitUntil(async () => (await progress())[0]! > 295, 16);
  let saved = (await progress())[0] ?? 0;
  await c.closeTab();

  await kill("host=flix-dying");
  await c.run("resume", { url: dying, at: saved });
  const moved = await c.waitUntil(async () => (await c.state()).url.includes("flix-alive"), 15);
  let s = await c.state();
  await c.check("a dead address moves to another address of the site", moved, `${s.url} ${s.failure} ${s.rescue}`);
  await c.check("it says what happened", (await c.state()).toast.includes("Continuing on"), (await c.state()).toast);
  let resumed = await c.waitUntil(async () => (await c.mediaPosition()) > saved - 5, 12);
  await c.check("it carries on from the same second", resumed, `${(await c.state()).media} vs ${saved}`);
  await c.closeTab();

  c.heading("Rescue: another site altogether");
  const gone = `http://gone.localhost:${PORT}/watch/dune-part-two-2024`;
  await c.run("open", { url: gone });
  await c.waitUntil(async () => {
    const st = await c.state();
    return st.url.includes("gone.localhost") && st.parsed !== "-";
  }, 10);
  await c.startPlaying();
  await sleep(7000);
  await c.mediaEval("var v=document.querySelector('video'); v.currentTime=420; v.play(); true");
  await c.waitUntil(async () => (await progress())[0]! > 415, 16);
  saved = (await progress())[0] ?? 0;
  const titlesBefore = await c.count("titles");
  await c.closeTab();

  await kill("host=gone");
  await c.run("resume", { url: gone, at: saved });
  const found = await c.waitUntil(async () => (await c.state()).rescue.includes("dune-part-two:true"), 20);
  s = await c.state();
  await c.check("the same film is found on another site", found, `${s.rescue} ${s.failure}`);
  const options = s.rescue.split("|")[2] ?? "";
  await c.check("Dune (1984) isn't what it picked", !(options.split(";")[0] ?? "").includes("dune-1984"), s.rescue);
  await c.check("the trailer isn't offered", !s.rescue.includes("trailer"), s.rescue);
  await c.check("a link to another site isn't offered", !s.rescue.includes("ads.example"), s.rescue);
  await c.check("a certain match counts down before opening", Number(s.rescue.split("|")[3]) >= 0, s.rescue);
  const opened = await c.waitUntil(async () => (await c.state()).url.endsWith("/film/dune-part-two"), 10);
  await c.check("then it opens by itself", opened, (await c.state()).url);
  resumed = await c.waitUntil(async () => (await c.mediaPosition()) > saved - 5, 12);
  await c.check("and carries on from the same second there", resumed, `${(await c.state()).media} vs ${saved}`);
  await sleep(7000);
  await c.check("it's still the same film in the library", (await c.count("titles")) === titlesBefore, (await c.rows("titles")).map((t) => t.name));
  await c.mediaEval("document.querySelector('video').pause(); true");
  await c.closeTab();

  c.heading("Rescue: a page that was taken down");
  const pagePath = "/film/vanishing-film-2020";
  await c.openPage(pagePath);
  await c.startPlaying();
  await c.waitUntil(async () => {
    const titles = new Map((await c.rows("titles")).map((t) => [t.id, t.name as string]));
    return (await c.rows("sessions")).some((x) => titles.get(x.title_id)?.startsWith("Vanishing"));
  }, 20);
  await c.mediaEval("var v=document.querySelector('video'); v.currentTime=100; v.pause(); true");
  await sleep(1500);
  await c.closeTab();
  await kill(`path=${pagePath}`);
  // Searches its own site too, which has moved it: the only other sites are local here.
  await c.run("addsite", { url: `http://localhost:${PORT}/`, name: "LocalDemo", search: `http://localhost:${PORT}/search?q=%s` });
  await sleep(300);
  await c.run("resume", { url: BASE + pagePath, at: 100 });
  const looking = await c.waitUntil(async () => (await c.state()).rescue.includes("pageMissing"), 10);
  s = await c.state();
  await c.check("a 404 on a film you were watching starts looking", looking, `${s.rescue} ${s.url}`);
  const elsewhere = await c.waitUntil(async () => {
    const st = await c.state();
    return st.rescue.includes("vanishing-film-elsewhere:true") || st.url.includes("vanishing-film-elsewhere");
  }, 15);
  await c.check("and finds it elsewhere", elsewhere, (await c.state()).rescue);
  await c.closeTab();

  c.heading("Rescue: where it should stay out of the way");
  await c.run("open", { url: `http://nothing.localhost:${PORT}/same-site` });
  await c.waitUntil(async () => (await c.state()).url.includes("nothing.localhost"), 8);
  await kill("host=nothing");
  await c.closeTab();
  await c.run("resume", { url: `http://nothing.localhost:${PORT}/same-site` });
  await c.waitUntil(async () => (await c.state()).failure !== "-", 8);
  await sleep(1000);
  s = await c.state();
  await c.check("a page that's nothing to do with a film just fails", s.rescue === "-" && s.failure !== "-", `${s.rescue} ${s.failure}`);
  // The browser's error page is selected now, with nothing of Cineon's in it: close it by its tab.
  await c.run("closetab");
  await sleep(300);

  await c.openPage("/film/dune-1984");
  await c.run("findelsewhere");
  const asked = await c.waitUntil(async () => (await c.state()).rescue.includes("manual"), 5);
  await c.check("asking by hand looks for what the page is about", asked, (await c.state()).rescue);
  await c.waitUntil(async () => (await c.state()).rescue.includes("|finished|"), 15);
  await sleep(6000);
  await c.check("and never opens anything by itself", (await c.state()).url.endsWith("/film/dune-1984"), (await c.state()).url);
  await c.closeTab();

  c.heading("Rescue: the video stops, the page doesn't");
  await c.openPage("/film/dune-part-two");
  await c.startPlaying();
  await c.waitUntil(async () => (await c.state()).media.includes("playing=true"), 8);
  await sleep(2000);
  await c.mediaEval("var v=document.querySelector('video'); v.src='/missing.mp4'; v.load(); true");
  // The Mac starts the search beside the page (or asks inside the player in fullscreen). The
  // extension can't tell fullscreen from outside and has no panel beside the page, so it always
  // asks inside the player, and its button starts the search (notes/runtime.md).
  const offered = await c.waitBanner("rescue|This video stopped", 12);
  if (offered) await c.run("banner", { banner: "rescue", action: "find" });
  const stopped = offered && (await c.waitUntil(async () => (await c.state()).rescue !== "-", 8));
  await c.check("a video that errors starts looking elsewhere", stopped, `${(await c.state()).banner} ${(await c.state()).rescue}`);
  await c.closeTab();

  await c.openPage("/stall-film");
  await c.startPlaying();
  await c.waitUntil(async () => (await c.state()).media.includes("playing=true"), 8);
  await c.run("stallseconds", { s: 3 });
  await c.mediaEval("var v=document.querySelector('video'); v.currentTime=800; v.play(); true");
  // Noticed: the player's offer to find another source (the Mac's `videoStalled` search, as above).
  const stuck = await c.waitUntil(async () => {
    const st = await c.state();
    return st.banner.startsWith("rescue|This video is stuck") || st.rescue.includes("videoStalled");
  }, 25);
  s = await c.state();
  await c.check("a video that hangs is noticed", stuck, `${s.banner} ${s.rescue} ${s.media}`);
  await c.closeTab();

  c.heading("Rescue: landing on a different video");
  await c.run("resume", { url: BASE + "/film/dune-part-two", at: 500, expected: 5000 });
  await sleep(2000);
  await c.startPlaying();
  const warned = await c.waitUntil(async () => (await c.state()).toast.includes("length is different"), 8);
  await c.check("a very different length doesn't jump anywhere", warned, (await c.state()).toast);
  await c.check("it stays at the start", (await c.mediaPosition()) < 100, (await c.state()).media);
  await c.mediaEval("document.querySelector('video').pause(); true");
  await c.closeTab();
});
