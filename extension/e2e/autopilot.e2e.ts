// e2e.py's autopilot_tests: learning intro skips, the next episode, learned credits, the "no" guard.
import { minutes, sleep, test } from "./test.ts";

test("[autopilot] learned skips, the next episode and the credits", async ({ cineon: c }) => {
  test.setTimeout(minutes(10));
  const rules = async (kind: string) => (await c.rows("skip_rules")).filter((r) => r.kind === kind);
  const sessionsOf = async (episode: number, season?: number) =>
    (await c.rows("sessions")).filter((r) => r.episode === episode && (season == null || r.season === season)).length;

  c.heading("Learning what you skip");
  await c.freshProfile("Autopilot");
  await c.openPage("/serial/rozryv/2-sezon/1-seriya");
  await c.startPlaying();
  await c.waitUntil(async () => (await c.count("sessions")) > 0, 20);
  // Holding the right arrow: many small jumps, which together are one skip.
  const start = await c.mediaPosition();
  for (let i = 0; i < 4; i++) {
    await c.mediaEval("window.dispatchEvent(new Event('pointerdown')); var v=document.querySelector('video'); v.currentTime=v.currentTime+25; true");
    await sleep(400);
  }
  const asked = await c.waitBanner("intro|");
  await c.check("several small jumps are offered as one intro to skip", asked, (await c.state()).banner);
  await c.check("the offer names the series", (await c.state()).banner.includes("Розрив"), (await c.state()).banner);

  // A real click on the card's button. It must not reach the player underneath.
  let point = await c.bannerButton("Always skip");
  if (!point) {
    // e2e.py's way: the card's right edge, less the "No" button.
    const rect = await c.mediaEval("(()=>{const r=document.querySelector('cineon-banner').getBoundingClientRect();return Math.round(r.right)+','+Math.round(r.top+r.height/2)})()");
    const [x, y] = rect.split(",").map(Number);
    point = { x: x! - 75, y: y! };
  }
  await c.click(point.x, point.y);
  const saved = (await c.waitUntil(async () => {
    const list = await rules("intro");
    return list.length ? list : null;
  }, 5))?.[0];
  await c.check("clicking Always skip saves the rule", saved, (await c.state()).banner);
  if (saved) {
    await c.check("the rule covers the whole jump", saved.end - saved.start > 80, saved);
    await c.check("the rule starts where the jumping started", Math.abs(saved.start - start) < 8, `${JSON.stringify(saved)} from ${start}`);
  }
  await c.check("the click didn't pause the film", (await c.state()).media.includes("playing=true"), (await c.state()).media);

  c.heading("Skipping it in the next episode");
  await c.openPage("/serial/rozryv/2-sezon/2-seriya");
  await c.startPlaying(saved ? Math.max(0, saved.start - 2) : 0);
  const jumped = await c.waitUntil(async () => (saved ? (await c.mediaPosition()) >= saved.end - 1 : false), 12);
  await c.check("the intro is skipped by itself", jumped, (await c.state()).media);
  await c.check("it says so, with a way back", (await c.state()).banner.startsWith("skipped|"), (await c.state()).banner);
  await c.waitUntil(async () => (await sessionsOf(2)) > 0, 15);
  await c.run("banner", { banner: "skipped", action: "undo" });
  const undone = await c.waitUntil(async () => (saved ? (await c.mediaPosition()) < saved.end - 20 : false), 4);
  await c.check("Undo goes back to the start of the intro", undone, (await c.state()).media);
  await sleep(3000);
  await c.check("an undone skip doesn't run again in this episode", saved ? (await c.mediaPosition()) < saved.end - 20 : false, (await c.state()).media);
  const misses = await rules("intro");
  await c.check("the undo is remembered against the rule", misses.length && misses[0]!.misses === 1, misses);

  c.heading("Next episode");
  await c.mediaEval("var v=document.querySelector('video'); v.currentTime=v.duration-60; v.play(); true");
  const offered = await c.waitBanner("next|Next: S2 E3|offer", 12);
  await c.check("near the end, the next episode is offered without taking over", offered, (await c.state()).banner);
  await c.run("banner", { banner: "next", action: "play" });
  const moved = await c.waitUntil(async () => (await c.state()).url.endsWith("/3-seriya"), 8);
  await c.check("Play now opens the next episode's address", moved, (await c.state()).url);
  let credits = await c.waitUntil(async () => {
    const list = await rules("credits");
    return list.length ? list : null;
  }, 3);
  await c.check("leaving with a minute to go is learned as the credits", credits && credits[0]!.start > 50 && credits[0]!.start < 70, credits);
  const playing = await c.waitUntil(async () => (await c.state()).media.includes("playing=true"), 10);
  await c.check("the next episode starts by itself", playing, (await c.state()).media);
  // The new page may still be loading its player, so ask until there's a video to answer.
  const sound =
    (await c.waitUntil(async () => {
      const value = await c.mediaEval("document.querySelector('video').muted");
      return value === "true" || value === "false" ? value : null;
    }, 5)) ?? "no answer";
  await c.check("and with its sound on", sound === "false", sound);

  await c.waitUntil(async () => (await sessionsOf(3)) > 0, 15);
  await c.mediaEval("var v=document.querySelector('video'); v.currentTime=v.duration-62; v.play(); true");
  await c.waitBanner("next|Next: S2 E4", 12);
  await c.run("banner", { banner: "next", action: "play" });
  await c.waitUntil(async () => (await c.state()).url.endsWith("/4-seriya"), 8);
  credits = await c.waitUntil(async () => {
    const list = await rules("credits");
    return list.length && list[0]!.sightings >= 2 ? list : null;
  }, 3);
  await c.check("the second time, the two sightings agree", credits, await rules("credits"));

  await c.waitUntil(async () => (await c.state()).media.includes("playing=true"), 10);
  await c.waitUntil(async () => (await sessionsOf(4)) > 0, 15);
  await c.mediaEval("var v=document.querySelector('video'); v.currentTime=v.duration-40; v.play(); true");
  const counting = await c.waitBanner("next|Next: S2 E5|countdown", 12);
  await c.check("once learned, the credits start a countdown", counting, (await c.state()).banner);
  const showing = await c.mediaEval("document.querySelector('cineon-banner') !== null");
  await c.mediaEval("document.querySelector('video').pause(); true");
  await sleep(2500);
  const gone = await c.mediaEval("document.querySelector('cineon-banner') === null");
  await c.check("pausing cancels the countdown", showing === "true" && gone === "true", `${showing} ${gone}`);
  await c.mediaEval("document.querySelector('video').play(); true");
  await c.waitBanner("next|Next: S2 E5|countdown", 8);
  await c.run("banner", { banner: "next", action: "no" });
  await sleep(500);
  await c.mediaEval("var v=document.querySelector('video'); v.currentTime=v.duration-2; v.play(); true");
  await sleep(5000);
  await c.check("saying no means it stays put, even at the end", (await c.state()).url.endsWith("/4-seriya"), (await c.state()).url);

  c.heading("Next episode rolling on at the end");
  await c.openPage("/serial/rozryv/2-sezon/5-seriya");
  await c.startPlaying();
  // This page's own tracking, not just any episode 5 in the database.
  const tracked = await c.waitUntil(async () => !["-1", "-", ""].includes((await c.state()).track) && (await sessionsOf(5)) > 0, 20);
  if (!tracked) {
    const s = await c.state();
    console.log(`    (episode 5 isn't being tracked: track=${s.track} media=${s.media} url=${s.url} tabs=${s.tabs})`);
  }
  // The film is at the credits here, and the rule was learned above.
  await c.mediaEval("var v=document.querySelector('video'); v.currentTime=v.duration-2; v.play(); true");
  const ended = await c.waitBanner("next|Next: S2 E6|countdown", 10);
  await c.check("when an episode ends, the countdown starts", ended, (await c.state()).banner);
  const rolled = await c.waitUntil(async () => (await c.state()).url.endsWith("/6-seriya"), 14);
  await c.check("and it rolls on when the countdown ends", rolled, (await c.state()).url);

  c.heading("The last episode");
  await c.waitUntil(async () => (await sessionsOf(6)) > 0, 20);
  await c.mediaEval("var v=document.querySelector('video'); v.currentTime=v.duration-2; v.play(); true");
  await sleep(6000);
  await c.check("nothing is offered when there's no next episode", !(await c.state()).banner.startsWith("next|Next: S2 E7"), (await c.state()).banner);

  c.heading("Episodes listed on the page");
  await c.run("open", { url: "http://127.0.0.1:8765/series/drama/1-mentalist-2008.html#t:238-s:3-e:5" });
  await c.waitUntil(async () => (await c.state()).parsed !== "-", 8);
  await c.startPlaying();
  await c.waitUntil(async () => (await sessionsOf(5, 3)) > 0, 15);
  await c.mediaEval("var v=document.querySelector('video'); v.currentTime=v.duration-30; v.play(); true");
  await c.waitBanner("next|Next: S3 E6", 12);
  await c.run("banner", { banner: "next", action: "play" });
  const switched = await c.waitUntil(async () => (await c.state()).parsed.includes("S3E6"), 8);
  await c.check("the page's own episode list is used", switched, (await c.state()).parsed);
  const swapped = await c.mediaEval("document.querySelector('video').src");
  await c.check("the page swapped its video without reloading", swapped.includes("e=6"), swapped);
  await c.mediaEval("document.querySelector('video').pause(); true");
});
