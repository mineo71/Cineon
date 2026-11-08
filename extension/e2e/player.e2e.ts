// e2e.py's awake_tests and tools_tests: staying awake while a film plays (chrome.power, seen through
// the state's `stayAwake`), voice boost, second subtitles, the browser's media controls, the sleep timer.
import { BASE, minutes, sleep, test } from "./test.ts";

test("[awake] staying awake while a film plays", async ({ cineon: c }) => {
  c.heading("Staying awake while a film plays");
  // The Mac asks macOS (pmset) which assertions the app holds; the extension's hold is chrome.power's
  // keep-awake, which the browser doesn't report, so this reads what Cineon asked for.
  const awake = async () => (await c.state()).stayAwake === "true";
  await c.freshProfile("Awake");
  await c.openPage("/tv/the-bear/episode");
  await c.check("nothing keeps the Mac awake before playing", !(await awake()), (await c.state()).stayAwake);
  await c.startPlaying(60);
  await c.check("the screen stays on while it plays", await c.waitUntil(awake, 10), (await c.state()).stayAwake);
  await c.mediaEval("document.querySelector('video').pause(); true");
  await c.check("pausing lets the Mac sleep again", await c.waitUntil(async () => !(await awake()), 8), (await c.state()).stayAwake);
  await c.startPlaying();
  const onAgain = await c.waitUntil(awake, 10);
  await c.closeTab();
  await c.check("closing the tab lets it sleep too", onAgain && (await c.waitUntil(async () => !(await awake()), 8)), (await c.state()).stayAwake);
});

test("[tools] voice boost, second subtitles, media keys, sleep timer", async ({ cineon: c }) => {
  test.setTimeout(minutes(6));
  c.heading("Player tools: voice boost, second subtitles, sleep timer, media keys");
  const boost = () => c.fields("voiceboost");
  await c.freshProfile("Tools");
  // Carrying on watching is the one way a page may start with sound, the way a click would.
  await c.run("keepwatching", { url: BASE + "/tv/the-bear/episode", at: 40 });
  await c.waitUntil(async () => (await c.state()).url.endsWith("/tv/the-bear/episode"), 10);
  const playing = await c.waitUntil(async () => (await c.state()).media.endsWith("playing=true"), 15);
  await c.check("a film to try them on plays with sound", playing, (await c.state()).media);
  await c.run("settings", { voiceBoost: 1 });
  const on = await c.waitUntil(async () => (await boost()).state === "on", 10);
  await c.check("voice boost turns on for a player whose sound the page can read", on, await c.run("voiceboost"));
  const loud = await c.waitUntil(async () => Number((await boost()).level) > 0.001, 8);
  await c.check("and the film still has sound through it", loud, await c.run("voiceboost"));
  await c.run("settings", { voiceBoost: 0 });
  const off = await c.waitUntil(async () => (await boost()).state === "off", 8);
  const still = await c.waitUntil(async () => Number((await boost()).level) > 0.001, 8);
  await c.check("turning it off keeps the sound", off && still, await c.run("voiceboost"));

  // The Mac opens a subtitle file from disk; an extension can't read the disk, so the second line
  // comes from a subtitle file the page's player loads (the extension's list of second subtitles).
  await c.evaluate("fetch('/subs/test-movie.en.vtt').then(r => r.text()); 1");
  const choices = await c.waitUntil(async () => {
    const list = (await c.fields("subs2state")).choices;
    return list && list !== "-" && list.length > 0 ? list : null;
  }, 10);
  if (choices) await c.run("subs2", { index: 0 });
  const second = await c.waitUntil(async () => (await c.fields("subs2state")).text === "Hello from subtitles", 10);
  await c.check("a subtitle file shows as a second line over the film", second, await c.run("subs2state"));
  await c.run("subs2", { clear: 1 });
  const cleared = await c.waitUntil(async () => {
    const t = (await c.fields("subs2state")).text;
    return t === "" || t === "-";
  }, 6);
  await c.check("and goes away again", cleared, await c.run("subs2state"));

  // Control Center on the Mac; the browser's media controls (Media Session) here.
  const shown = await c.waitUntil(async () => (await c.fields("nowplaying")).playing === "1", 8);
  await c.check("Control Center shows what's playing", shown && (await c.run("nowplaying")).includes("The Bear"), await c.run("nowplaying"));
  await c.run("remote", { cmd: "toggle" });
  const paused = await c.waitUntil(async () => (await c.state()).media.endsWith("playing=false") && (await c.fields("nowplaying")).playing === "0", 8);
  await c.check("the play/pause key pauses it", paused, (await c.run("nowplaying")) + (await c.state()).media);
  c.skip("Siri's play or pause plays it again", "no Siri or App Intents in a browser (the extension's Alt+Shift+P shortcut is the same toggle)");
  await c.run("remote", { cmd: "play" });
  await c.waitUntil(async () => (await c.fields("nowplaying")).playing === "1", 8);

  await c.run("sleep", { mode: "seconds", s: 6 });
  const fading = await c.waitUntil(async () => (await c.fields("sleepstate")).fading === "true", 6);
  await c.check("the sleep timer fades the sound out", fading, await c.run("sleepstate"));
  const stopped = await c.waitUntil(async () => (await c.state()).media.endsWith("playing=false"), 14);
  await c.check("and pauses the film", stopped, (await c.state()).media);
  const restored = await c.waitUntil(async () => Math.abs(Number((await boost()).volume) - 1) < 0.01, 6);
  await c.check("with the volume back for next time", restored, await c.run("voiceboost"));
  const done = await c.waitUntil(async () => (await c.fields("sleepstate")).active === "false", 4);
  await c.check("and the timer is done", done, await c.run("sleepstate"));

  await c.mediaEval("var v=document.querySelector('video'); v.currentTime = v.duration - 12; v.play(); true");
  await c.waitUntil(async () => (await c.state()).media.endsWith("playing=true"), 6);
  await c.run("sleep", { mode: "end" });
  const ends = await c.waitUntil(async () => (await c.state()).media.endsWith("playing=false"), 25);
  await c.check("'at the end of this' stops when it ends", ends, (await c.state()).media);
  await sleep(200);
  await c.closeTab();
});
