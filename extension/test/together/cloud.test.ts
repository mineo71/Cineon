// Port of windows/Cineon.Core.Tests/Together/CloudLibraryTests.cs.

import { CloudItem, CloudLibrary, type TitleKind, type TitleStatus } from "../../src/core/together";
import { TogetherRig, blockNetwork, defaultSettings, normalizeName, type TestPerson, type TestTitle } from "./rig";
import type { Call } from "./fakeConvex";

blockNetwork();

let rig: TogetherRig;
let ann: TestPerson;
let cloud: CloudLibrary<TestTitle>;
/** Thirty days before the rig's clock, in milliseconds. */
let t0: number;

const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  rig = new TogetherRig();
  ann = await rig.person("Ann");
  cloud = new CloudLibrary({ library: ann.library, together: ann.model, settings: () => ann.host.settings });
  t0 = rig.clock.now() - 30 * DAY;
});

afterEach(async () => {
  cloud.stop();
  await rig.dispose();
});

const server = () => rig.server;

interface Stored {
  status?: TitleStatus;
  statusAt?: number | null;
  halves?: number | null;
  ratedAt?: number | null;
  finishedAt?: number | null;
  kind?: TitleKind;
}

/** A title stored with exactly these values (times in milliseconds), as if rated and filed at those times. */
async function stored(person: TestPerson, name: string, year: number | null = null, imdb: string | null = null, values: Stored = {}): Promise<TestTitle> {
  const added = (await person.library.addTitle(name, { year, kind: values.kind ?? "film", imdbId: imdb }))!;
  const sec = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : ms / 1000);
  return person.library.put({
    ...added,
    status: values.status ?? "none",
    statusAt: sec(values.statusAt),
    ratingHalves: values.halves ?? null,
    ratedAt: sec(values.ratedAt),
    finishedAt: sec(values.finishedAt),
    addedAt: t0 / 1000,
    updatedAt: t0 / 1000,
  });
}

async function secret(): Promise<string> {
  return (await ann.model.authorized()).secret;
}

function putItems(calls: Call[]): any[] {
  return calls.flatMap((c) => c.args.items);
}

/** A title the way the library keeps it, for the key tests. */
function title(fields: Partial<TestTitle>): TestTitle {
  return {
    id: 1,
    name: "",
    normName: "",
    year: null,
    kind: "unknown",
    status: "none",
    imdbId: null,
    posterUrl: null,
    ratingHalves: null,
    addedAt: 0,
    updatedAt: 0,
    ratedAt: null,
    statusAt: null,
    finishedAt: null,
    ...fields,
  };
}

// MARK: Keys

test("the cloud knows films by IMDb id or by name and year", () => {
  const film = title({ name: "Heat", normName: "heat", year: 1995 });
  expect(CloudLibrary.keys(film)).toEqual(["n:heat|1995"]);
  expect(CloudLibrary.keys({ ...film, imdbId: "tt0113277" })).toEqual(["tt0113277", "n:heat|1995"]);
  expect(CloudLibrary.key(null, "x", null)).toBe("n:x|");
  // Only real IMDb ids count; long names are cut at 140 characters.
  expect(CloudLibrary.key("nm0000001", "x", 2001)).toBe("n:x|2001");
  expect(CloudLibrary.key(null, "a".repeat(300), null)).toBe("n:" + "a".repeat(140) + "|");
  expect(normalizeName("Heat")).toBe("heat");
});

// MARK: Sending

test("the first sync sends what only this library knows", async () => {
  const rated = t0 + DAY;
  const filed = t0 + 2 * DAY;
  await stored(ann, "Heat", 1995, "tt0113277", { status: "watched", statusAt: filed, halves: 17, ratedAt: rated, finishedAt: filed });
  await stored(ann, "Arrival", 2016, null, { status: "backlog", statusAt: filed });
  await stored(ann, "Imported", 2001, null, { status: "watching" });
  await stored(ann, "Unrated", 1999, null, { halves: null, ratedAt: rated });
  await stored(ann, "Nothing", 1980);

  await cloud.sync();
  expect(cloud.lastError).toBeNull();
  expect(cloud.lastSync).toBe(rig.clock.now());
  expect(cloud.cloudCount).toBe(0);
  expect(cloud.isSyncing).toBe(false);
  const all = server().callsTo("library:all");
  expect(all).toHaveLength(1);
  expect(all[0]!.args.t).toBe(rig.clock.now());

  const items = Object.fromEntries(putItems(server().callsTo("library:put")).map((i) => [i.name, i]));
  expect(Object.keys(items).sort()).toEqual(["Arrival", "Heat", "Imported", "Unrated"]);
  expect(JSON.stringify(items.Heat)).toBe(
    `{"key":"tt0113277","name":"Heat","kind":"film","status":"watched","statusAt":${filed},"year":1995,"finishedAt":${filed},"rating":17,"ratedAt":${rated}}`,
  );
  expect(JSON.stringify(items.Arrival)).toBe(`{"key":"n:arrival|2016","name":"Arrival","kind":"film","status":"backlog","statusAt":${filed},"year":2016}`);
  // Imported without a date: its update time stands in.
  expect(items.Imported.statusAt).toBe(t0);
  // A cleared rating travels as null with its time.
  expect(items.Unrated.rating).toBeNull();
  expect(items.Unrated.ratedAt).toBe(rated);

  const backed = server().libraryOf(await secret());
  expect(backed).toHaveLength(4);
  expect(backed.find((i) => i.key === "tt0113277")!.rating).toBe(17);

  // Everything matches now: nothing more to send.
  await cloud.sync();
  expect(server().callsTo("library:put")).toHaveLength(1);
  expect(cloud.cloudCount).toBe(4);
});

test("big libraries go in batches of 200", async () => {
  for (let i = 0; i < 450; i++) await ann.library.addTitle(`Film ${i}`, { year: 1950 + (i % 70), kind: "film", status: "backlog" });
  await cloud.sync();
  expect(server().callsTo("library:put").map((c) => c.args.items.length)).toEqual([200, 200, 50]);
  expect(server().libraryOf(await secret())).toHaveLength(450);
});

test("changes go out together a moment later", async () => {
  const heat = await stored(ann, "Heat", 1995, "tt0113277");
  const dune = await stored(ann, "Dune", 2021);
  cloud.start();
  expect(ann.library.onPersonalChange).not.toBeNull();

  await ann.library.setRating(heat.id, 16);
  await rig.advance(1);
  await ann.library.setStatus(dune.id, "backlog");
  const lastChange = rig.clock.now();
  await rig.advance(1);
  expect(server().callsTo("library:put")).toEqual([]);
  await rig.advance(0.6);
  const puts = server().callsTo("library:put");
  expect(puts).toHaveLength(1);
  expect(putItems(puts).map((i) => i.name).sort()).toEqual(["Dune", "Heat"]);
  // Sent a second and a half after the last change.
  expect(cloud.lastSync).toBe(lastChange + 1500);
  expect(server().callsTo("library:all")).toEqual([]);

  // Three seconds after starting, a full sync.
  await rig.advance(0.5);
  await rig.waitUntil(() => server().callsTo("library:all").length === 1, "the sync after starting");
});

test("failed sends wait for the next one", async () => {
  const heat = await stored(ann, "Heat", 1995, "tt0113277");
  const dune = await stored(ann, "Dune", 2021);
  // What start wires up, without its timers.
  ann.library.onPersonalChange = (t) => cloud.noteChange(t);
  ann.connection.offline = true;
  await ann.library.setRating(heat.id, 16);
  await rig.advance(2);
  expect(cloud.lastError).toBe("The network connection was lost.");

  ann.connection.offline = false;
  await ann.library.setRating(dune.id, 12);
  await rig.advance(2);
  expect(cloud.lastError).toBeNull();
  expect(putItems(server().callsTo("library:put")).map((i) => i.name).sort()).toEqual(["Dune", "Heat"]);
});

test("syncing every ten minutes", async () => {
  cloud.start();
  await rig.advance(3);
  await rig.waitUntil(() => server().callsTo("library:all").length === 1, "the first sync");
  await rig.advance(596);
  expect(server().callsTo("library:all")).toHaveLength(1);
  await rig.advance(1);
  await rig.waitUntil(() => server().callsTo("library:all").length === 2, "the ten-minute sync");
});

test("off means off", async () => {
  const heat = await stored(ann, "Heat", 1995, "tt0113277", { status: "watched", statusAt: t0 });
  ann.host.settings = { ...defaultSettings(), cloudBackup: false };
  cloud.start();
  await ann.library.setRating(heat.id, 16);
  await rig.advance(700);
  await cloud.sync();
  expect(server().calls).toEqual([]);

  // Stopped is stopped, whatever the settings say.
  ann.host.settings = defaultSettings();
  cloud.stop();
  await cloud.sync();
  cloud.noteChange(heat);
  await rig.advance(5);
  expect(server().calls).toEqual([]);
});

test("without a server there is no backup", async () => {
  const bob = await rig.person("Bob", false);
  const bobCloud = new CloudLibrary({ library: bob.library, together: bob.model, settings: () => bob.host.settings });
  await bobCloud.sync();
  expect(bobCloud.lastSync).toBeNull();
  expect(bobCloud.lastError).toBeNull();
});

// MARK: Merging

test("newer in the cloud wins here", async () => {
  const local = t0 + DAY;
  const heat = await stored(ann, "Heat", 1995, "tt0113277", { status: "backlog", statusAt: local, halves: 14, ratedAt: local });
  const later = local + 10_000;
  const finished = later - 2 * 60 * 60 * 1000;
  server().seedLibrary(await secret(), {
    key: "tt0113277",
    name: "Heat",
    year: 1995,
    rating: 20,
    ratedAt: later,
    status: "watched",
    statusAt: later,
    finishedAt: finished,
  });
  const personal: TestTitle[] = [];
  ann.library.onPersonalChange = (t) => personal.push(t);

  await cloud.sync();
  const now = ann.library.titles.get(heat.id)!;
  expect(now.ratingHalves).toBe(20);
  expect(now.ratedAt! * 1000).toBe(later);
  expect(now.status).toBe("watched");
  expect(now.statusAt! * 1000).toBe(later);
  expect(now.finishedAt! * 1000).toBe(finished);
  // Restored quietly: nothing echoed back.
  expect(personal).toEqual([]);
  expect(server().callsTo("library:put")).toEqual([]);
  expect(cloud.cloudCount).toBe(1);
});

test("newer here is sent and kept", async () => {
  const local = t0 + DAY;
  const heat = await stored(ann, "Heat", 1995, "tt0113277", { status: "watched", statusAt: local, halves: 18, ratedAt: local });
  const s = await secret();
  const earlier = local - 10_000;
  server().seedLibrary(s, { key: "tt0113277", name: "Heat", rating: 6, ratedAt: earlier, status: "backlog", statusAt: earlier });
  await cloud.sync();
  expect(ann.library.titles.get(heat.id)!.ratingHalves).toBe(18);
  expect(ann.library.titles.get(heat.id)!.status).toBe("watched");
  const kept = server().libraryOf(s);
  expect(kept).toHaveLength(1);
  expect([kept[0]!.rating, kept[0]!.status]).toEqual([18, "watched"]);
});

test("half a second either way is the same moment", async () => {
  const local = t0 + DAY;
  const heat = await stored(ann, "Heat", 1995, "tt0113277", { status: "backlog", statusAt: local, halves: 14, ratedAt: local });
  server().seedLibrary(await secret(), { key: "tt0113277", name: "Heat", rating: 20, ratedAt: local + 400, status: "watched", statusAt: local - 400 });
  await cloud.sync();
  expect(ann.library.titles.get(heat.id)!.ratingHalves).toBe(14);
  expect(ann.library.titles.get(heat.id)!.status).toBe("backlog");
  expect(server().callsTo("library:put")).toEqual([]);
});

test("a rating cleared elsewhere is cleared here", async () => {
  const local = t0 + DAY;
  const heat = await stored(ann, "Heat", 1995, "tt0113277", { status: "watched", statusAt: local, halves: 14, ratedAt: local });
  server().seedLibrary(await secret(), { key: "tt0113277", name: "Heat", rating: null, ratedAt: local + 60_000, status: "watched", statusAt: local });
  await cloud.sync();
  expect(ann.library.titles.get(heat.id)!.ratingHalves).toBeNull();
  expect(ann.library.titles.get(heat.id)!.ratedAt! * 1000).toBe(local + 60_000);
});

test("an undated title only takes a list when it has none", async () => {
  const loose = await stored(ann, "Loose", 2001);
  const filed = await stored(ann, "Filed", 2002, null, { status: "backlog" });
  const s = await secret();
  const at = t0 + 3 * DAY;
  server().seedLibrary(s, { key: "n:loose|2001", name: "Loose", status: "watching", statusAt: at });
  server().seedLibrary(s, { key: "n:filed|2002", name: "Filed", status: "watched", statusAt: at });
  await cloud.sync();
  expect(ann.library.titles.get(loose.id)!.status).toBe("watching");
  expect(ann.library.titles.get(loose.id)!.statusAt! * 1000).toBe(at);
  expect(ann.library.titles.get(filed.id)!.status).toBe("backlog");
  // And neither is sent: the cloud knows a list for both, and the undated one is no newer.
  expect(server().callsTo("library:put")).toEqual([]);
});

test("a name key from before the IMDb id still counts", async () => {
  const heat = await stored(ann, "Heat", 1995, "tt0113277");
  server().seedLibrary(await secret(), { key: "n:heat|1995", name: "Heat", rating: 18, ratedAt: t0 + DAY });
  await cloud.sync();
  expect(ann.library.titles.get(heat.id)!.ratingHalves).toBe(18);
});

test("of two cloud entries the newest counts", async () => {
  const heat = await stored(ann, "Heat", 1995, "tt0113277");
  const older = CloudItem.make("tt0113277", "Heat", { rating: 10, ratedAt: t0 + DAY });
  const newer = CloudItem.make("tt0113277", "Heat", { rating: 16, ratedAt: t0 + 2 * DAY });
  await cloud.merge([older, newer]);
  expect(ann.library.titles.get(heat.id)!.ratingHalves).toBe(16);
  await ann.library.restore(heat.id, { halves: null, ratedAt: null });
  await cloud.merge([newer, older]);
  expect(ann.library.titles.get(heat.id)!.ratingHalves).toBe(16);

  // The id entry and the name entry: the newer rating of the two.
  const byName = CloudItem.make("n:heat|1995", "Heat", { rating: 4, ratedAt: t0 + 3 * DAY });
  await cloud.merge([newer, byName]);
  expect(ann.library.titles.get(heat.id)!.ratingHalves).toBe(4);
});

test("a recovery code brings the library back", async () => {
  await stored(ann, "Heat", 1995, "tt0113277", { status: "watched", statusAt: t0 + DAY, halves: 17, ratedAt: t0 + DAY, finishedAt: t0 + DAY });
  await stored(ann, "Arrival", 2016, null, { status: "backlog", statusAt: t0 + DAY });
  await cloud.sync();

  // A fresh profile, its library imported again without ratings or lists.
  const bob = await rig.person("Bob");
  const heat = await stored(bob, "Heat", 1995, "tt0113277");
  const arrival = await stored(bob, "Arrival", 2016);
  const bobCloud = new CloudLibrary({ library: bob.library, together: bob.model, settings: () => bob.host.settings });
  expect(await bob.model.adopt(ann.model.recoveryCode)).toBe(true);
  await bobCloud.sync();
  expect(bobCloud.lastError).toBeNull();
  expect([bob.library.titles.get(heat.id)!.ratingHalves, bob.library.titles.get(heat.id)!.status]).toEqual([17, "watched"]);
  expect(bob.library.titles.get(arrival.id)!.status).toBe("backlog");
  expect(bobCloud.cloudCount).toBe(2);
});

test("errors are kept for the profile page", async () => {
  ann.connection.offline = true;
  await cloud.sync();
  expect(cloud.lastError).toBe("The network connection was lost.");
  expect(cloud.lastSync).toBeNull();
  ann.connection.offline = false;
  await cloud.sync();
  expect(cloud.lastError).toBeNull();
  expect(cloud.lastSync).not.toBeNull();
});

test("changes are announced by name", async () => {
  const names: string[] = [];
  cloud.subscribe((name) => names.push(name));
  await cloud.sync();
  expect(names).toEqual(["isSyncing", "lastSync", "isSyncing"]);
});
