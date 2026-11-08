// e2e.py's frame_tests. Frames are photographs of the tab (tabs.captureVisibleTab) cropped to the
// picture, kept in the profile database's `frame_files` store instead of a Frames folder.
import { minutes, sleep, test } from "./test.ts";

test("[frame] frames and moments", async ({ cineon: c }) => {
  test.setTimeout(minutes(8));
  const real = (p: { range: number } | null) => Boolean(p && p.range > 120);

  c.heading("Frames: video the page can read");
  await c.freshProfile("Frames");
  await c.openPage("/tv/the-bear/episode");
  await c.startPlaying(120);
  const first = await c.waitUntil(async () => {
    const rows = await c.rows("frames");
    return rows.length ? rows : null;
  }, 50);
  let s = await c.state();
  await c.check("a frame is saved while watching", first, `media=${s.media} track=${s.track} parsed=${s.parsed} frames=${s.frames}`);
  const files = await c.frameFiles();
  await c.check("the frame is a file on disk", files.length === 1, files);
  if (files.length) await c.check("and it's a real picture", real(await c.picture(files[0]!)), await c.picture(files[0]!));
  await c.run("moment");
  const moment = await c.waitUntil(async () => (await c.rows("frames")).find((f) => f.is_moment === 1), 6);
  await c.check("saving a moment keeps that frame", moment, (await c.state()).banner);
  await c.check("it says so over the player", (await c.state()).banner.startsWith("moment|Saved"), (await c.state()).banner);
  if (moment) await c.check("the moment is a real picture", real(await c.picture(moment.file)), await c.picture(moment.file));
  await c.mediaEval("document.querySelector('video').pause(); true");
  await c.closeTab();

  c.heading("Frames: video in another origin that can't be read");
  await c.openPage("/tainted");
  await c.startPlaying(200);
  const tainted = await c.waitUntil(async () => {
    const titles = new Map((await c.rows("titles")).map((t) => [t.id, t.name as string]));
    return (await c.rows("frames")).find((f) => titles.get(f.title_id)?.startsWith("Tainted"));
  }, 50);
  await c.check("the frame can still be saved", tainted, (await c.state()).media);
  if (tainted) {
    const picture = await c.picture(tainted.file);
    await c.check("and it's the picture, cropped to the video", real(picture), picture);
    const ratio = picture ? picture.width / Math.max(1, picture.height) : 0;
    await c.check("in the film's own proportions", ratio > 1.7 && ratio < 1.85, picture);
  }
  await c.mediaEval("document.querySelector('video').pause(); true");
  await c.closeTab();

  c.heading("Frames: cleaning up");
  const withMoment = (await c.rows("frames")).find((f) => f.is_moment === 1 && f.session_id != null);
  if (withMoment) {
    const sessionId = withMoment.session_id as number;
    await c.run("deletesession", { id: sessionId });
    await sleep(500);
    const left = (await c.rows("frames")).filter((f) => f.session_id === sessionId);
    await c.check("removing a session removes its frames", left.length === 0, left);
    const kept = (await c.rows("frames")).filter((f) => f.is_moment === 1);
    await c.check("but a moment you saved stays", kept.length && kept[0]!.session_id == null, kept);
    await c.check("and its file too", (await c.frameFiles()).includes(withMoment.file), await c.frameFiles());
  }

  await c.run("settings", { frames: 0 });
  await c.openPage("/tainted");
  const before = await c.count("frames");
  await c.startPlaying(300);
  await sleep(32_000);
  await c.check("with frames switched off, none are saved", (await c.count("frames")) === before, `${before} to ${await c.count("frames")}`);
  await c.mediaEval("document.querySelector('video').pause(); true");
  await c.closeTab();
});
