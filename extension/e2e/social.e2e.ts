// e2e.py's alerts_tests, together_tests, cloud_tests, profile_tests and chrome_tests. Together and the
// cloud talk to the dev deployment (cineon.ts: TOGETHER), as e2e.py does; never production.
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { BASE, convex, minutes, skipSection, sleep, test, type Cineon } from "./test.ts";

const dumpLine = (text: string, key: string) =>
  text
    .split("\n")
    .find((l) => l.startsWith(key + "="))
    ?.slice(key.length + 1) ?? "";

test("[alerts] new episodes", async ({ cineon: c }) => {
  c.heading("New episodes");
  await c.freshProfile("Alerts");
  await c.run("addtitle", { name: "Slow Horses", year: 2022, kind: "series", status: "watching" });
  const row = await c.waitUntil(async () => (await c.rows("titles")).find((t) => t.kind === "series" && t.status === "watching"), 5);
  await c.check("a series being watched is in the library", row, (await c.rows("titles")).map((t) => [t.name, t.kind, t.status]));
  if (!row) return;
  await c.run("settings", { alerts: 1 });
  await c.run("fakeepisodes", { title: row.id, list: "3x5:2020-01-01,3x6:2020-01-02,3x7:2099-01-01" });
  const firstText = await c.run("checknew");
  const first = await c.fields("checknew");
  await c.check("the first look only remembers what's out", first.notified === "-" && firstText.includes("latest=S3 E6"), firstText);
  await c.run("fakeepisodes", { title: row.id, list: "3x5:2020-01-01,3x6:2020-01-02,3x7:2020-01-03,3x8:2099-01-01" });
  const laterText = await c.run("checknew");
  const later = await c.fields("checknew");
  await c.check("a new episode is announced", later.notified.includes("Season 3, episode 7 is out"), laterText);
  await c.check("and shows on Home", later.fresh === "1", laterText);
});

/** The profile's Together secret (the apps' together.json, kept in chrome.storage.local). */
async function profileSecret(c: Cineon): Promise<string | null> {
  const id = (await c.state()).profileid;
  const text = await c.storage(`together:${id}`);
  if (typeof text !== "string") return null;
  try {
    return (JSON.parse(text) as { secret?: string }).secret ?? null;
  } catch {
    return null;
  }
}

/** What the cloud holds for this secret: empty until the extension has registered it. */
async function cloudItems(secret: string): Promise<any[]> {
  try {
    return ((await convex("query", "library:all", { deviceSecret: secret })) as any[]) ?? [];
  } catch (error) {
    if (String(error).includes("UNKNOWN_DEVICE")) return [];
    throw error;
  }
}

async function friendParty(code: string) {
  const party = await convex("query", "parties:get", { code });
  if (!party) return null;
  const expected = party.position + (party.playing ? (Math.max(0, party.now - party.updatedAt) / 1000) * party.rate : 0);
  return { ...party, expected } as Record<string, any> & { expected: number };
}

test("[together] a friend's list, a challenge, hosting and following a party", async ({ cineon: c }) => {
  test.setTimeout(minutes(8));
  const dump = () => c.run("together", { dump: 1 }, 30_000);

  c.heading("Together: a friend's list, by code");
  await c.freshProfile("Together");
  const bo = randomBytes(32).toString("base64");
  await convex("mutation", "people:register", { deviceSecret: bo, name: "Bo" });
  const share = await convex("mutation", "shares:create", {
    deviceSecret: bo,
    label: "Bo's watched films",
    titles: [
      { name: "Arrival", year: 2016, kind: "film", imdbId: "tt2543164" },
      { name: "Severance", year: 2022, kind: "series" },
    ],
  });
  await c.run("together", { code: String(share.code).toLowerCase() }, 30_000);
  const shares = await c.waitUntil(async () => dumpLine(await dump(), "shares").includes("Arrival"), 15);
  await c.check("a friend's list opens from its code, typed any way", shares, await dump());
  await c.run("together", { addshared: 0 }, 30_000);
  const arrival = await c.waitUntil(async () => (await c.rows("titles")).find((t) => t.name === "Arrival"), 5);
  await c.check("a film from it goes to my backlog", arrival?.status === "backlog", arrival);

  c.heading("Together: a challenge");
  const challenge = await convex("mutation", "challenges:create", {
    deviceSecret: bo,
    title: { name: "Dune: Part Two", year: 2024, kind: "film" },
    totalEpisodes: 1,
  });
  await c.run("together", { code: challenge.code }, 30_000);
  const joined = await c.waitUntil(async () => dumpLine(await dump(), "challenge").includes("Together:"), 15);
  await c.check("I join it by code and show in the race", joined, await dump());
  const dune = (await c.rows("titles")).find((t) => t.name === "Dune: Part Two");
  await c.check("its film goes to my backlog so I can find it", dune?.status === "backlog", dune);

  await c.openPage("/watch/dune-part-two-2024");
  await c.startPlaying(300);
  await c.waitUntil(async () => (await c.rows("progress")).some((p) => p.position > 290), 20);
  await c.run("together", { refresh: 1 }, 30_000);
  const myFraction = async () => {
    const line = dumpLine(await dump(), "challenge");
    for (const part of (line.split("|").pop() ?? "").split(",")) {
      const [name, rest] = [part.slice(0, part.indexOf(":")), part.slice(part.indexOf(":") + 1)];
      if (name === "Together") return Number.parseFloat(rest.split(":")[0] ?? "0");
    }
    return 0;
  };
  const moved = await c.waitUntil(async () => (await myFraction()) > 0.01, 15);
  await c.check("what I watch moves my progress bar", moved, dumpLine(await dump(), "challenge"));
  await convex("mutation", "challenges:report", { deviceSecret: bo, code: challenge.code, fraction: 1, watchedEpisodes: 1, label: "Finished", finished: true });
  await c.run("together", { refresh: 1 }, 30_000);
  const won = await c.waitUntil(async () => dumpLine(await dump(), "challenge").includes("winner=Bo"), 15);
  await c.check("the first to finish wins", won, dumpLine(await dump(), "challenge"));

  c.heading("Together: hosting a watch party");
  await c.run("together", { party: "start" }, 30_000);
  const line = await c.waitUntil(async () => {
    const value = dumpLine(await dump(), "party");
    return value && value !== "-" ? value : null;
  }, 15);
  await c.check("a party starts from the film playing", line, await dump());
  if (line) {
    const code = line.split("|")[0]!;
    await convex("mutation", "parties:join", { deviceSecret: bo, code });
    const party = await friendParty(code);
    const mine = await c.playerTime();
    await c.check("a friend joins at my second", party && party.playing && Math.abs(party.expected - mine) < 6, `${party?.expected} vs ${mine}`);
    const members = await c.waitUntil(async () => dumpLine(await dump(), "party").includes("Bo"), 8);
    await c.check("I see who's in", members, dumpLine(await dump(), "party"));
    await c.mediaEval("document.querySelector('video').pause(); true");
    const paused = await c.waitUntil(async () => !(await friendParty(code))?.playing, 8);
    await c.check("pausing reaches the friend", paused);
    await c.mediaEval("document.querySelector('video').currentTime = 600; true");
    const jumped = await c.waitUntil(async () => Math.abs(((await friendParty(code))?.expected ?? 0) - 600) < 3, 8);
    await c.check("a jump reaches the friend", jumped, await friendParty(code));
    await convex("mutation", "parties:react", { deviceSecret: bo, code, emoji: "🍿" });
    const shown = await c.waitUntil(async () => {
      const s = await c.state();
      return s.banner.includes("Bo 🍿") || s.toast.includes("Bo 🍿");
    }, 8);
    await c.check("a friend's reaction shows on the film", shown, `${(await c.state()).banner} ${(await c.state()).toast}`);
    await convex("mutation", "parties:say", { deviceSecret: bo, code, text: "this scene!" });
    const heard = await c.waitUntil(async () => dumpLine(await dump(), "messages").includes("Bo:this scene!"), 10);
    await c.check("a friend's message reaches the party chat", heard, dumpLine(await dump(), "messages"));
    await c.run("together", { say: "right?" }, 30_000);
    const sent = await c.waitUntil(async () => ((await friendParty(code))?.messages ?? []).some((m: { text: string }) => m.text === "right?"), 10);
    await c.check("and mine reaches them", sent, (await friendParty(code))?.messages);
    const pets = dumpLine(await dump(), "pets");
    // Mine is a pet code ("p1-…"); Bo registered without one, so his shows as "-".
    const myPet = pets.includes(":") ? (pets.split(",")[0] ?? "").split(":").slice(1).join(":") : "";
    await c.check("people in the party carry their pets", myPet.startsWith("p1-") && pets.includes("Bo:-"), pets);
    await c.run("together", { party: "leave" }, 30_000);
    const ended = await c.waitUntil(async () => (await friendParty(code))?.ended, 8);
    await c.check("ending the party ends it for everyone", ended);
  }

  c.heading("Together: following a friend's party");
  const hosted = await convex("mutation", "parties:create", { deviceSecret: bo, pageUrl: BASE + "/film/dune-part-two", position: 420, playing: false, rate: 1 });
  await c.run("together", { code: hosted.code }, 30_000);
  const opened = await c.waitUntil(async () => (await c.state()).url.endsWith("/film/dune-part-two"), 10);
  await c.check("joining opens the host's page", opened, (await c.state()).url);
  const at = await c.waitUntil(async () => Math.abs((await c.playerTime()) - 420) < 3, 15);
  await c.check("and goes to the host's second", at, String(await c.playerTime()));
  await convex("mutation", "parties:update", { deviceSecret: bo, code: hosted.code, position: 700, playing: false, rate: 1 });
  const followed = await c.waitUntil(async () => Math.abs((await c.playerTime()) - 700) < 3, 10);
  await c.check("and follows the host's jumps", followed, String(await c.playerTime()));

  // Muted, because a page may only start sound after a click, and nobody clicks in a test.
  await c.mediaEval("var v=document.querySelector('video'); v.muted=true; window.__seeks=0; v.addEventListener('seeking', () => window.__seeks++); true");
  await convex("mutation", "parties:update", { deviceSecret: bo, code: hosted.code, position: 100, playing: true, rate: 1 });
  const drift = async () => {
    const party = await friendParty(hosted.code);
    return party ? Math.abs((await c.playerTime()) - party.expected) : 99;
  };
  const playing = await c.waitUntil(async () => (await c.mediaEval("String(!document.querySelector('video').paused)")) === "true" && (await drift()) < 2.5, 15);
  await c.check("plays along when the host plays", playing, `drift=${(await drift()).toFixed(1)}`);
  await c.mediaEval("window.__seeks=0; true");
  await sleep(14_000);
  const seeks = await c.mediaEval("String(window.__seeks)");
  const d = await drift();
  await c.check("and stays with the host without jumping back", seeks === "0" && d < 2.5, `seeks=${seeks} drift=${d.toFixed(1)}`);
  await sleep(10_000); // Well past the 30 s after which someone who stays quiet drops off the list.
  const names = ((await friendParty(hosted.code))?.members ?? []).map((m: { name: string }) => m.name);
  await c.check("the host still sees me after half a minute", names.includes("Together"), names);
  await convex("mutation", "parties:leave", { deviceSecret: bo, code: hosted.code });
  const over = await c.waitUntil(async () => dumpLine(await dump(), "party") === "-", 8);
  await c.check("when the host ends it, I'm out too", over, dumpLine(await dump(), "party"));
  await c.closeTab();
});

test("[cloud] ratings in the cloud", async ({ cineon: c }) => {
  test.setTimeout(minutes(5));
  c.heading("Ratings in the cloud");
  await c.freshProfile("Cloud");
  await c.run("addtitle", { name: "Heat", year: 1995, status: "watched" });
  const heat = await c.waitUntil(async () => (await c.rows("titles")).find((t) => t.name === "Heat"), 5);
  if (!heat) {
    await c.check("a film to rate", false);
    return;
  }
  await c.run("rate", { id: heat.id, halves: 15 });
  await c.check("a rating of 7.5 is saved", (await c.rows("titles")).find((t) => t.id === heat.id)?.rating === 15, await c.rows("titles"));
  const secret = await c.waitUntil(() => profileSecret(c), 10);
  const backed = secret
    ? await c.waitUntil(async () => (await cloudItems(secret)).some((i) => i.rating === 15 && String(i.key).startsWith("n:heat")), 20)
    : null;
  await c.check("and backed up to the cloud", backed, secret ? await cloudItems(secret) : "no secret in storage");
  await c.run("deletetitle", { id: heat.id });
  await sleep(1000);
  await c.run("addtitle", { name: "Heat", year: 1995, status: "none" });
  await c.run("cloud", { do: "sync" }, 30_000);
  const back = await c.waitUntil(async () => {
    const rows = (await c.rows("titles")).filter((t) => t.name === "Heat");
    return rows.length === 1 && rows[0]!.rating === 15 && rows[0]!.status === "watched";
  }, 10);
  await c.check("clearing and adding it again brings the stars back", back, (await c.rows("titles")).filter((t) => t.name === "Heat"));

  c.heading("Ratings in the cloud: another profile, with the recovery code");
  await c.freshProfile("Cloud copy");
  await c.run("addtitle", { name: "Heat", year: 1995, status: "none" });
  const adopted = secret ? (await c.fields("adopt", { code: secret }, 40_000)).adopted === "true" : false;
  const restored =
    adopted && (await c.waitUntil(async () => (await c.rows("titles")).filter((t) => t.name === "Heat").map((t) => t.rating).join() === "15", 10));
  await c.check("a recovery code restores the ratings elsewhere", restored, (await c.rows("titles")).filter((t) => t.name === "Heat"));
});

test("[profile] profile, pet and the Cineon page", async ({ cineon: c }) => {
  c.heading("Profile and pet");
  // e2e.py's profile has a whole run behind it by now; the demo library stands in for that here.
  await c.run("seed");
  const stats = await c.fields("stats");
  await c.check("the profile works out its numbers", stats.hours !== "-" && stats.pet.startsWith("p"), await c.run("stats"));
  for (const route of ["profile", "rate", "library", "home"]) {
    await c.run("route", { to: route });
    const page = await c.waitUntil(() => c.pageWith((u) => u.startsWith(`chrome-extension://${c.id}/app.html`)), 8);
    const shown = page ? await page.locator(`main.page.route-${route}`).waitFor({ timeout: 8_000 }).then(() => true, () => false) : false;
    await c.check(`the ${route} page opens`, shown, page?.url() ?? "no Cineon page");
  }
  // The share card is drawn in the page and handed to the browser as a download.
  const before = new Set(c.downloadedFiles());
  const app = await c.context.newPage();
  await app.goto(`chrome-extension://${c.id}/app.html#profile`);
  const clicked = await app
    .getByRole("button", { name: /share card/i })
    .click({ timeout: 10_000 })
    .then(() => "clicked", (e: unknown) => `no button: ${String(e).split("\n")[0]}`);
  const card = await c.waitUntil(() => c.downloadedFiles().find((f) => !before.has(f) && f.endsWith(".png")), 15);
  const size = card ? statSync(card).size : 0;
  await c.check("a share card can be saved as a picture", card && size > 20_000, `${clicked}; ${card ?? "nothing saved"} ${size}`);
  await app.close();
});

test("[chrome] the window's own buttons", async ({}, info) => {
  console.log("Window: the top bar and its buttons");
  const reason = "the Mac's traffic lights in Cineon's own window; the extension lives in the browser's window, which draws its own";
  await skipSection(info, [
    ["the window's buttons sit in the middle of the top bar", reason],
    ["and stay there after a resize", reason],
    ["and come back after full screen", reason],
    ["a click in the bar beside them reaches the app", reason],
  ]);
});
