// Port of windows/Cineon.Core.Tests/Together/TogetherModelTests.cs.

import { TitleCard, TogetherModel, simpleUrlKey, type TogetherProperty } from "../../src/core/together";
import { TogetherRig, blockNetwork, type TestPerson, type TestProgress, type FakeTab } from "./rig";

blockNetwork();

let rig: TogetherRig;

beforeEach(() => {
  rig = new TogetherRig();
});

afterEach(async () => {
  await rig.dispose();
});

const server = () => rig.server;

// MARK: Registration

test("registers once with the profile's name and pet", async () => {
  const ann = await rig.person("Ann");
  expect(ann.model.isAvailable).toBe(true);
  expect(ann.model.personId).toBeNull();

  await ann.model.enter("ABC-DEF");
  const registers = server().callsTo("people:register");
  expect(registers).toHaveLength(1);
  expect(registers[0]!.args.deviceSecret).toBe(ann.model.recoveryCode);
  expect(registers[0]!.args.name).toBe("Ann");
  expect(registers[0]!.args.pet).toBe("p1-Ab3_x9");
  expect(ann.host.toasts).toEqual(["Couldn't open that code: No party, list or challenge has that code"]);
  expect(ann.model.isWorking).toBe(false);

  const personId = ann.model.personId;
  expect(personId).not.toBeNull();
  expect(server().people[0]!.id).toBe(personId);
  const stored = JSON.parse(ann.identityStore.text!);
  expect(stored.personId).toBe(personId);
  expect(stored.pet).toBe("p1-Ab3_x9");

  // Known already: no second registration.
  await ann.model.enter("ABC-DEF");
  expect(server().callsTo("people:register")).toHaveLength(1);

  // A new pet goes to friends' screens.
  ann.host.petCode = "p2-Zz";
  await ann.model.refreshIdentity();
  expect(server().callsTo("people:register").at(-1)!.args.pet).toBe("p2-Zz");
  expect(server().people[0]!.pet).toBe("p2-Zz");

  // Not sharing the pet sends an empty code, which takes it off.
  ann.host.settings = { ...ann.host.settings, sharePet: false };
  await ann.model.refreshIdentity();
  expect(server().callsTo("people:register").at(-1)!.args.pet).toBe("");
  expect(server().people[0]!.pet).toBeNull();
  expect(ann.model.personId).toBe(personId);
  expect(server().callsTo("people:register")).toHaveLength(3);
});

test("refreshing an identity nobody has seen sends nothing", async () => {
  const ann = await rig.person("Ann");
  await ann.model.refreshIdentity();
  expect(server().calls).toEqual([]);
});

test("codes that are not six characters never reach the server", async () => {
  const ann = await rig.person("Ann");
  await ann.model.enter("K7Q-2M");
  await ann.model.enter("");
  expect(ann.host.toasts).toEqual(["Codes have six letters and digits, like K7Q-2MX", "Codes have six letters and digits, like K7Q-2MX"]);
  expect(server().calls).toEqual([]);
});

test("without a server Together says so", async () => {
  const ann = await rig.person("Ann", false);
  expect(ann.model.isAvailable).toBe(false);
  ann.model.start();
  await ann.model.enter("K7Q2MX");
  expect(ann.host.toasts).toEqual(["Couldn't open that code: Together isn't set up in this build"]);
  await expect(ann.model.authorized()).rejects.toHaveProperty("name", "TogetherError");
});

test("server errors become toasts", async () => {
  const ann = await rig.person("Ann");
  ann.connection.offline = true;
  await ann.model.enter("K7Q2MX");
  expect(ann.host.toasts).toEqual(["Couldn't open that code: The network connection was lost."]);
  expect(ann.model.isWorking).toBe(false);
});

test("starting over with a party code forgets the party", async () => {
  const ann = await rig.person("Ann");
  const identity = await ann.identity();
  identity.partyCode = "PARTY2";
  await identity.save(ann.identityStore);
  await ann.restart();
  await ann.model.whenSaved();
  expect((await ann.identity()).partyCode).toBeNull();
  expect(ann.model.party).toBeNull();
});

// MARK: Shared lists

test("a list shared by one opens for another", async () => {
  const ann = await rig.person("Ann");
  const bob = await rig.person("Bob");

  await ann.model.shareWatched();
  expect(ann.host.toasts).toEqual(["Nothing in Watched to share yet"]);
  expect(server().calls).toEqual([]);

  const heat = await ann.addTitle("Heat", 1995, "film", "watched", "tt0113277");
  await ann.library.setRating(heat.id, 17);
  await ann.addTitle("Arrival", 2016, "film", "watched");
  await ann.addTitle("Dune", 2021, "film", "backlog");

  server().nextCodes.push("K7QM2X");
  await ann.model.shareWatched();
  expect(ann.model.lastShareCode).toBe("K7QM2X");
  expect(ann.host.clipboard).toBe("K7Q-M2X");
  expect(ann.host.toasts.at(-1)).toBe("Code K7Q-M2X copied. Send it to a friend.");
  const creates = server().callsTo("shares:create");
  expect(creates).toHaveLength(1);
  expect(creates[0]!.args.label).toBe("Ann's watched films");
  expect(creates[0]!.args.titles).toHaveLength(2);

  await bob.model.enter("k7q m2x");
  expect(bob.host.toasts).toEqual([]);
  expect(bob.model.openedShares).toHaveLength(1);
  const share = bob.model.openedShares[0]!;
  expect(share.code).toBe("K7QM2X");
  expect(share.ownerName).toBe("Ann");
  expect(share.label).toBe("Ann's watched films");
  expect(share.titles.map((t) => t.name).sort()).toEqual(["Arrival", "Heat"]);
  const heatCard = share.titles.find((t) => t.name === "Heat")!;
  expect(heatCard.rating).toBe(17);
  expect(heatCard.status).toBe("watched");
  expect(bob.host.went).toEqual(["together"]);
  expect((await bob.identity()).openedShares).toEqual(["K7QM2X"]);

  // One title on its own.
  server().nextCodes.push("NEW456");
  await ann.model.share(ann.library.titles.get(heat.id)!);
  expect(server().callsTo("shares:create").at(-1)!.args.label).toBe("Heat");
  await bob.model.enter("NEW-456");
  expect(bob.model.openedShares.map((s) => s.code)).toEqual(["NEW456", "K7QM2X"]);
  expect((await bob.identity()).openedShares).toEqual(["NEW456", "K7QM2X"]);

  // Opened again after a restart, without going to the Together page.
  bob.host.went.length = 0;
  await bob.restart();
  bob.model.start();
  await rig.waitUntil(() => bob.model.openedShares.length === 2, "shares to load again");
  expect(bob.host.went).toEqual([]);

  bob.model.forgetShare("NEW456");
  expect(bob.model.openedShares.map((s) => s.code)).toEqual(["K7QM2X"]);
  expect((await bob.identity()).openedShares).toEqual(["K7QM2X"]);
});

test("a friend's film goes into the backlog once", async () => {
  const bob = await rig.person("Bob");
  const heat = TitleCard.make("Heat", 1995, "film", "tt0113277", "https://img.example/heat.jpg");
  expect(bob.model.hasInLibrary(heat)).toBe(false);

  await bob.model.addToBacklog(heat);
  const added = [...bob.library.titles.values()];
  expect(added).toHaveLength(1);
  const title = added[0]!;
  expect([title.name, title.year, title.kind, title.status, title.imdbId]).toEqual(["Heat", 1995, "film", "backlog", "tt0113277"]);
  expect(title.posterUrl).toBe("https://img.example/heat.jpg");
  expect(bob.host.applied).toEqual([[title.id, heat]]);
  expect(bob.host.toasts.at(-1)).toBe("Added Heat to backlog");
  expect(bob.model.hasInLibrary(heat)).toBe(true);

  await bob.model.addToBacklog({ ...heat, imdbId: null });
  expect(bob.host.toasts.at(-1)).toBe("Heat is already in your backlog");
  expect(bob.library.titles.size).toBe(1);

  // Without an IMDb id it's looked up instead.
  await bob.model.addToBacklog(TitleCard.make("Arrival", 2016, "film"));
  const arrival = [...bob.library.titles.values()].find((t) => t.name === "Arrival")!;
  expect(bob.host.enriched).toEqual([arrival.id]);

  // A title known but in no list is filed into the backlog.
  const dune = await bob.addTitle("Dune", 2021, "film", "none");
  expect(bob.model.hasInLibrary(TitleCard.make("Dune", 2021, "film"))).toBe(false);
  await bob.model.addToBacklog(TitleCard.make("Dune", 2021, "film"));
  expect(bob.library.titles.get(dune.id)!.status).toBe("backlog");
  expect(bob.host.toasts.at(-1)).toBe("Dune is already in your backlog");
});

// MARK: Watch party

async function startedParty(code = "PARTY2"): Promise<{ ann: TestPerson; bob: TestPerson; film: FakeTab }> {
  const ann = await rig.person("Ann");
  const bob = await rig.person("Bob");
  const film = ann.player.add("https://films.example/watch/heat?utm_source=feed");
  film.parsed = TitleCard.make("Heat", 1995, "film");
  film.position = 600;
  film.playing = true;
  server().nextCodes.push(code);
  await ann.model.startParty();
  expect(ann.model.party?.code).toBe(code);
  await bob.model.enter(code);
  expect(bob.model.party).not.toBeNull();
  return { ann, bob, film };
}

test("a party needs a film playing", async () => {
  const ann = await rig.person("Ann");
  await ann.model.startParty();
  const trailer = ann.player.add("https://films.example/trailer");
  trailer.duration = 120;
  await ann.model.startParty();
  trailer.hasVideo = false;
  await ann.model.startParty();
  expect(ann.host.toasts).toEqual(Array(3).fill("Start the film first, then invite people to it"));
  expect(server().calls).toEqual([]);
});

test("guests follow the host", async () => {
  const { ann, bob, film } = await startedParty();

  // The host's side.
  expect(ann.model.isHost).toBe(true);
  expect(ann.host.clipboard).toBe("PAR-TY2");
  expect(ann.host.toasts.at(-1)).toBe("Party PAR-TY2 started. The code is copied.");
  const creates = server().callsTo("parties:create");
  expect(creates).toHaveLength(1);
  expect(creates[0]!.args.pageUrl).toBe("https://films.example/watch/heat?utm_source=feed");
  expect(creates[0]!.args.position).toBe(600);
  expect(creates[0]!.args.playing).toBe(true);
  expect(JSON.stringify(creates[0]!.args.title)).toBe('{"name":"Heat","kind":"film","year":1995}');
  await ann.model.whenSaved();
  expect((await ann.identity()).partyCode).toBe("PARTY2");
  // parties:get carries a fresh `t` so the server doesn't answer from its cache.
  expect("t" in server().callsTo("parties:get").at(-1)!.args).toBe(true);

  // The guest's side: a tab on the host's page, and the web page shown.
  expect(bob.model.isHost).toBe(false);
  expect(bob.host.toasts.at(-1)).toBe("Joined Ann's party");
  expect(bob.player.opened).toEqual([{ url: "https://films.example/watch/heat?utm_source=feed", select: true }]);
  expect(bob.host.went).toEqual(["web"]);
  expect(bob.model.party!.members.map((m) => m.name)).toEqual(["Ann", "Bob"]);
  expect(bob.model.party!.hostPet).toBe("p1-Ab3_x9");
  expect((await bob.identity()).partyCode).toBe("PARTY2");
  const guestTab = bob.player.selectedFake!;
  guestTab.blocksAutoplay = true;

  // A second on: the guest jumps to the host's place and is asked to press play, once.
  await rig.advance(1);
  expect(bob.player.commands.some((c) => c.command === "play()")).toBe(true);
  expect(bob.player.commands.some((c) => c.command === "seek(601)")).toBe(true);
  expect(guestTab.position).toBeCloseTo(601, 3);
  expect(bob.player.banners).toEqual([]);
  await rig.advance(1);
  await rig.advance(1);
  expect(bob.player.banners).toEqual([{ tab: guestTab.id, id: "party", text: "Ann is playing. Press play to join in.", timeout: 6 }]);

  // They press play; from then on small drifts are left alone.
  guestTab.blocksAutoplay = false;
  guestTab.playing = true;
  const commands = bob.player.commands.length;
  await rig.advance(1);
  expect(bob.player.commands.length).toBe(commands);

  // The host pauses: the update goes out straight away and the guest pauses too.
  film.playing = false;
  await rig.advanceUntil(() => !guestTab.playing, "the guest to pause");
  const update = server().callsTo("parties:update").at(-1)!;
  expect(update.args.playing).toBe(false);
  expect("pageUrl" in update.args).toBe(false);

  // The host jumps ahead: the guest lands there too (within a correction's grace period).
  film.position = 1200;
  await rig.advanceUntil(() => Math.abs(guestTab.position - 1200) < 0.01, "the guest to jump");
  expect(bob.player.commands.some((c) => c.command === "seek(1200)")).toBe(true);

  // The host speeds up.
  film.rate = 1.5;
  await rig.advanceUntil(() => guestTab.rate === 1.5, "the guest's speed");
  expect(bob.player.commands.some((c) => c.command === "rate(1.5)")).toBe(true);

  // A tracking parameter isn't a new page; a new episode is.
  film.url = "https://films.example/watch/heat?utm_source=other";
  await rig.advance(5);
  expect(bob.player.loads).toEqual([]);
  film.url = "https://films.example/watch/heat-2";
  await rig.advanceUntil(() => bob.player.loads.length === 1, "the guest to load the new page");
  expect(bob.player.loads[0]!.url).toBe("https://films.example/watch/heat-2");
  expect(server().callsTo("parties:update").at(-1)!.args.pageUrl).toBe("https://films.example/watch/heat-2");

  expect(ann.host.toasts.filter((t) => t.startsWith("Couldn't"))).toEqual([]);
  expect(bob.host.toasts.filter((t) => t.startsWith("Couldn't"))).toEqual([]);
});

test("a guest who closed the party tab gets a new one", async () => {
  const { bob } = await startedParty();
  bob.player.tabs.clear();
  await rig.advance(1);
  expect(bob.player.opened.at(-1)).toEqual({ url: "https://films.example/watch/heat?utm_source=feed", select: false });
});

test("heartbeats keep guests on the list", async () => {
  const { ann, bob } = await startedParty();
  const bobId = bob.model.personId;
  const bobBeats = () => server().callsTo("parties:heartbeat").filter((c) => c.args.deviceSecret === bob.model.recoveryCode).length;
  await rig.advance(1);
  expect(bobBeats()).toBe(1);

  // Not every second: once more than five have gone by.
  for (let i = 0; i < 5; i++) await rig.advance(1);
  expect(bobBeats()).toBe(1);
  await rig.advance(1);
  expect(bobBeats()).toBe(2);

  // A dropped connection is a missed second, not the end of the party; after 30 s the host stops
  // seeing the guest.
  bob.connection.offline = true;
  await rig.advanceUntil(() => ann.model.party!.members.every((m) => m.personId !== bobId), "the guest to drop off", 1, 40);
  expect(bob.model.party).not.toBeNull();
  expect(bob.host.toasts).toEqual(["Joined Ann's party"]);

  // Back online: a heartbeat later they're there again.
  bob.connection.offline = false;
  await rig.advanceUntil(() => ann.model.party!.members.some((m) => m.personId === bobId), "the guest to come back", 1, 10);
});

test("heartbeat errors are quiet", async () => {
  const { bob } = await startedParty();
  // Left from somewhere else: the server answers NOT_MEMBER to the next heartbeat.
  await bob.client!.mutation("parties:leave", { deviceSecret: bob.model.recoveryCode, code: "PARTY2" });
  await rig.advance(1);
  await rig.advance(6);
  expect(bob.model.party).not.toBeNull();
  expect(bob.host.toasts).toEqual(["Joined Ann's party"]);
});

test("chat and reactions show once and never your own", async () => {
  const ann = await rig.person("Ann");
  const bob = await rig.person("Bob");
  const film = ann.player.add("https://films.example/watch/heat");
  film.position = 10;
  film.playing = true;
  server().nextCodes.push("PARTY2");
  await ann.model.startParty();
  await ann.model.say("Before you came");
  await rig.advance(1);
  await bob.model.enter("PARTY2");
  const guestTab = bob.player.selectedFake!;

  await ann.model.say("  hi there  ");
  expect(server().callsTo("parties:say").at(-1)!.args.text).toBe("hi there");
  await rig.advanceUntil(() => bob.player.banners.some((b) => b.id === "chat"), "the chat banner");
  expect(bob.player.banners.filter((b) => b.id === "chat")).toEqual([{ tab: guestTab.id, id: "chat", text: "Ann: hi there", timeout: 5 }]);
  expect(bob.model.party!.messages[0]!.text).toBe("Before you came");

  // On the Together page chat shows there, not as a toast.
  bob.host.route = "together";
  await ann.model.say("second");
  await rig.advanceUntil(() => bob.model.party!.messages.length === 3, "the second message");
  expect(bob.player.banners.filter((b) => b.id === "chat")).toHaveLength(1);
  expect(bob.host.toasts.some((t) => t.includes("second"))).toBe(false);

  // The host is elsewhere: a toast.
  await bob.model.say("hey");
  await bob.model.react("🎉");
  await rig.advanceUntil(() => ann.host.toasts.includes("Bob 🎉"), "the reaction toast", 1, 5);
  expect(ann.host.toasts).toContain("Bob: hey");
  // Never your own.
  expect(ann.host.toasts.some((t) => t.startsWith("Ann"))).toBe(false);
  await rig.advance(3);
  expect(bob.host.toasts.some((t) => t.startsWith("Bob"))).toBe(false);
  expect(bob.player.banners.some((b) => b.text.startsWith("Bob"))).toBe(false);
  // And each once.
  await rig.advance(5);
  expect(ann.host.toasts.filter((t) => t === "Bob 🎉")).toHaveLength(1);
  expect(ann.host.toasts.filter((t) => t === "Bob: hey")).toHaveLength(1);
});

test("chat is rate-limited as the server says", async () => {
  const { ann } = await startedParty();
  for (let i = 1; i <= 5; i++) await ann.model.say(`line ${i}`);
  await ann.model.say("one too many");
  expect(ann.host.toasts.at(-1)).toBe("Couldn't send that: Slow down. At most 5 messages every 5 seconds.");
  expect(server().callsTo("parties:say")).toHaveLength(6);

  // Blank lines are never sent; long ones are cut at 280 characters.
  await ann.model.say("   \n ");
  expect(server().callsTo("parties:say")).toHaveLength(6);

  await rig.advance(5.1);
  await ann.model.say("x".repeat(300));
  expect(server().callsTo("parties:say").at(-1)!.args.text).toHaveLength(280);
  expect(ann.host.toasts.at(-1)).toBe("Couldn't send that: Slow down. At most 5 messages every 5 seconds.");
  await rig.advanceUntil(() => ann.model.party!.messages.length === 6, "the host to see six messages", 1, 5);
});

test("when the host leaves the party is over", async () => {
  const { ann, bob } = await startedParty();
  await rig.advance(1);

  await ann.model.leaveParty();
  expect(ann.model.party).toBeNull();
  expect(ann.model.isHost).toBe(false);
  expect((await ann.identity()).partyCode).toBeNull();
  expect(server().parties[0]!.ended).toBe(true);

  await rig.advanceUntil(() => bob.model.party === null, "the guest to hear");
  expect(bob.host.toasts.at(-1)).toBe("The party is over");
  await bob.model.whenSaved();
  expect((await bob.identity()).partyCode).toBeNull();
  await rig.waitUntil(() => server().callsTo("parties:leave").length === 2, "both to leave");

  // No more polling once it's over.
  const polls = server().callsTo("parties:get").length;
  await rig.advance(5);
  expect(server().callsTo("parties:get").length).toBe(polls);
});

test("a guest leaving keeps the party going", async () => {
  const { ann, bob } = await startedParty();
  await bob.model.leaveParty();
  expect(bob.model.party).toBeNull();
  expect(server().parties[0]!.ended).toBe(false);
  await rig.advanceUntil(() => ann.model.party!.members.length === 1, "the host to see one member");
  expect(ann.model.party).not.toBeNull();
});

test("stopping the model leaves the party", async () => {
  const { ann } = await startedParty();
  ann.model.stop();
  await rig.waitUntil(() => server().parties[0]!.ended, "the party to end");
  expect(ann.model.party).toBeNull();
});

test("joining an ended party says so", async () => {
  const { ann } = await startedParty();
  await ann.model.leaveParty();
  const carol = await rig.person("Carol");
  await carol.model.enter("PARTY2");
  expect(carol.host.toasts).toEqual(["Couldn't open that code: This watch party has ended."]);
  expect(carol.model.party).toBeNull();
});

test("the player's state is read from media.js", () => {
  expect(TogetherModel.parsePlayerState('{"type":"tick","t":12.5,"paused":false,"rate":1.25}')).toEqual({ position: 12.5, playing: true, rate: 1.25 });
  expect(TogetherModel.parsePlayerState('{"t":3}')).toEqual({ position: 3, playing: false, rate: 1 });
  expect(TogetherModel.parsePlayerState({ t: 3, paused: 0 })).toEqual({ position: 3, playing: true, rate: 1 });
  expect(TogetherModel.parsePlayerState("null")).toBeNull();
  expect(TogetherModel.parsePlayerState(null)).toBeNull();
  expect(TogetherModel.parsePlayerState('{"paused":true}')).toBeNull();
  expect(TogetherModel.parsePlayerState("garbage")).toBeNull();
});

test("the stand-in page key ignores tracking and the scheme, not the page", () => {
  expect(simpleUrlKey("https://www.films.example/watch/heat?utm_source=feed&b=2&a=1#top")).toBe("films.example/watch/heat?a=1&b=2");
  expect(simpleUrlKey("http://films.example/watch/heat/")).toBe("films.example/watch/heat");
  expect(simpleUrlKey("https://films.example/watch#s:1-e:2")).toBe("films.example/watch#s:1-e:2");
  expect(simpleUrlKey("https://films.example/watch/heat-2")).not.toBe(simpleUrlKey("https://films.example/watch/heat"));
});

// MARK: Challenges

function progress(titleId: number, season: number, episode: number, position: number, duration: number, finished: boolean, at: number): TestProgress {
  return { titleId, ref: { season, episode }, position, duration, finished, updatedAt: at / 1000 };
}

test("first to finish", async () => {
  const ann = await rig.person("Ann");
  const bob = await rig.person("Bob");
  const severance = await ann.addTitle("Severance", 2022, "series", "watching", "tt11280740");
  ann.host.episodes = 3;
  ann.host.route = "together";

  server().nextCodes.push("RACE22");
  await ann.model.createChallenge(severance);
  expect(ann.host.clipboard).toBe("RAC-E22");
  expect(ann.host.toasts.at(-1)).toBe("Challenge RAC-E22 started. The code is copied.");
  expect(server().callsTo("challenges:create")[0]!.args.totalEpisodes).toBe(3);
  expect(ann.model.challenges.map((c) => c.code)).toEqual(["RACE22"]);
  expect(ann.model.details.has("RACE22")).toBe(true);
  const annReports = server().callsTo("challenges:report");
  expect(annReports).toHaveLength(1);
  expect(annReports[0]!.args.label).toBe("0 of 3 episodes");

  // Bob joins: the series lands in his backlog.
  await bob.model.enter("race-22");
  expect(bob.host.toasts.at(-1)).toBe("You're in: first to finish Severance");
  expect(bob.host.toasts).toContain("Added Severance to backlog");
  expect(bob.library.titles.size).toBe(1);
  const bobSeverance = [...bob.library.titles.values()][0]!;
  expect([bobSeverance.status, bobSeverance.imdbId, bobSeverance.kind]).toEqual(["backlog", "tt11280740", "series"]);
  expect(bob.host.went).toEqual(["together"]);
  expect(bob.model.details.get("RACE22")!.members.map((m) => m.name).sort()).toEqual(["Ann", "Bob"]);

  // One episode done and half of the next.
  const now = rig.clock.now();
  bob.library.saveProgress(progress(bobSeverance.id, 1, 1, 3000, 3000, true, now - 60 * 60_000));
  bob.library.saveProgress(progress(bobSeverance.id, 1, 2, 1500, 3000, false, now));
  const local = bob.model.localProgress(TitleCard.make("Severance", 2022, "series", "tt11280740"), 3);
  expect(local).toEqual({ fraction: 0.5, watched: 1, label: "1 of 3 episodes · on S1 E2", finished: false });
  await bob.model.refreshChallenges();
  const bobReport = server()
    .callsTo("challenges:report")
    .filter((c) => c.args.deviceSecret === bob.model.recoveryCode)
    .at(-1)!;
  expect(bobReport.args.fraction).toBe(0.5);
  expect(bobReport.args.watchedEpisodes).toBe(1);
  expect(bobReport.args.label).toBe("1 of 3 episodes · on S1 E2");
  expect(bobReport.args.finished).toBe(false);

  // Nothing new, nothing sent.
  const reports = server().callsTo("challenges:report").length;
  await bob.model.refreshChallenges();
  expect(server().callsTo("challenges:report").length).toBe(reports);

  await ann.model.refreshChallenges();
  expect(ann.model.challenges[0]!.leaderName).toBe("Bob");
  expect(ann.model.details.get("RACE22")!.members.map((m) => m.name)).toEqual(["Bob", "Ann"]);
  expect(ann.model.details.get("RACE22")!.winnerName).toBeNull();

  // Bob marks it watched: he wins, and both hear about it once.
  await bob.library.setStatus(bobSeverance.id, "watched");
  await bob.model.refreshChallenges();
  expect(bob.host.toasts.at(-1)).toBe("You finished Severance first!");
  await ann.model.refreshChallenges();
  expect(ann.host.toasts.at(-1)).toBe("Bob finished Severance first");
  expect(ann.model.details.get("RACE22")!.winnerName).toBe("Bob");
  expect(ann.model.details.get("RACE22")!.members[0]!.fraction).toBe(1);
  const toasts = ann.host.toasts.length;
  await ann.model.refreshChallenges();
  expect(ann.host.toasts.length).toBe(toasts);

  // A winner already there when Cineon opens isn't news.
  await ann.restart();
  await ann.model.refreshChallenges();
  expect(ann.host.toasts.length).toBe(toasts);

  await ann.model.leaveChallenge("RACE22");
  expect(ann.model.challenges).toEqual([]);
  expect(ann.model.details.has("RACE22")).toBe(false);
  await bob.model.refreshChallenges();
  expect(bob.model.challenges[0]!.memberCount).toBe(1);
});

test("challenges refresh often only while looked at", async () => {
  const ann = await rig.person("Ann");
  const film = await ann.addTitle("Heat", 1995, "film", "backlog");
  await ann.model.createChallenge(film);
  expect(server().callsTo("challenges:create")[0]!.args.totalEpisodes).toBe(1);

  await ann.restart();
  ann.model.start();
  await rig.waitUntil(() => ann.model.challenges.length === 1, "challenges at start");
  const mine = () => server().callsTo("challenges:mine").length;
  const before = mine();

  ann.host.route = "other";
  await rig.advance(5);
  expect(mine()).toBe(before);

  ann.host.route = "together";
  await rig.advance(5);
  await rig.waitUntil(() => mine() === before + 1, "a refresh while looking");

  // Elsewhere, once a minute.
  ann.host.route = "other";
  await rig.advance(60);
  expect(mine()).toBe(before + 1);
  await rig.advance(5);
  await rig.waitUntil(() => mine() === before + 2, "the minutely refresh");
});

test("progress on a film", async () => {
  const ann = await rig.person("Ann");
  const card = TitleCard.make("Heat", 1995, "film", "tt0113277");
  expect(ann.model.localProgress(card, 1)).toEqual({ fraction: 0, watched: 0, label: "Not started", finished: false });

  const heat = await ann.addTitle("Heat", 1995, "film", "watching", "tt0113277");
  expect(ann.model.localProgress(card, 1)).toEqual({ fraction: 0, watched: 0, label: "Not started", finished: false });

  ann.library.saveProgress(progress(heat.id, 0, 0, 2400, 6000, false, rig.clock.now()));
  expect(ann.model.localProgress(card, 1)).toEqual({ fraction: 0.4, watched: 0, label: "40% in", finished: false });

  // Past the finish threshold (92% by default) counts as finished.
  ann.library.saveProgress(progress(heat.id, 0, 0, 5600, 6000, false, rig.clock.now()));
  expect(ann.model.localProgress(card, 1)).toEqual({ fraction: 1, watched: 1, label: "Finished", finished: true });

  ann.host.settings = { ...ann.host.settings, finishThreshold: 0.99 };
  expect(ann.model.localProgress(card, 1).label).toBe("93% in");

  // Found by name and year when the card has no IMDb id.
  await ann.library.setStatus(heat.id, "watched");
  expect(ann.model.localProgress(TitleCard.make("heat", 1995), 1)).toEqual({ fraction: 1, watched: 1, label: "Finished", finished: true });
});

test("progress on a series without a known episode count", async () => {
  const ann = await rig.person("Ann");
  const show = await ann.addTitle("Dark", 2017, "series", "watching");
  const card = TitleCard.from(show);
  expect(ann.model.localProgress(card, 0)).toEqual({ fraction: 0, watched: 0, label: "0 of 1 episodes", finished: false });
  ann.library.saveProgress(progress(show.id, 2, 5, 3000, 3000, true, rig.clock.now()));
  // A total of 0 never counts as finished by episodes; 1 done of "1" caps at 99.9%.
  expect(ann.model.localProgress(card, 0)).toEqual({ fraction: 0.999, watched: 1, label: "1 of 1 episodes · on S2 E5", finished: false });
  expect(ann.model.localProgress(card, 1)).toEqual({ fraction: 1, watched: 1, label: "Finished", finished: true });
});

// MARK: Recovery code

test("a recovery code takes over an identity", async () => {
  const ann = await rig.person("Ann");
  const film = await ann.addTitle("Heat", 1995, "film", "backlog");
  await ann.model.createChallenge(film);
  const annId = ann.model.personId;
  const code = ann.model.recoveryCode;

  const bob = await rig.person("Bob");
  await bob.model.authorized();
  const bobSecret = bob.model.recoveryCode;

  expect(await bob.model.adopt("too-short")).toBe(false);
  expect(await bob.model.adopt(bobSecret)).toBe(false);
  expect(await bob.model.adopt("q8Hk2v_9-Zr1tYpQe3LmN0aBcDeFgHiJkLmNoPqRsTu=")).toBe(false);
  expect(bob.model.recoveryCode).toBe(bobSecret);

  expect(await bob.model.adopt(`  ${code}\n`)).toBe(true);
  expect(bob.model.recoveryCode).toBe(code);
  expect(bob.model.personId).toBe(annId);
  expect(bob.model.challenges).toHaveLength(1);
  const stored = await bob.identity();
  expect([stored.secret, stored.personId]).toEqual([code, annId]);
  // It registers under this profile's name.
  expect(server().callsTo("people:register").at(-1)!.args.name).toBe("Bob");
});

test("adopting while offline fails", async () => {
  const bob = await rig.person("Bob");
  bob.connection.offline = true;
  expect(await bob.model.adopt("q8Hk2v/9+Zr1tYpQe3LmN0aBcDeFgHiJkLmNoPqRsTu=")).toBe(false);
  expect(bob.model.personId).toBeNull();
});

test("changes are announced by name", async () => {
  const ann = await rig.person("Ann");
  const names: TogetherProperty[] = [];
  const unsubscribe = ann.model.subscribe((name) => names.push(name));
  await ann.model.enter("K7QM2X");
  expect(names).toContain("isWorking");
  expect(names).toContain("personId");
  const count = names.length;
  unsubscribe();
  await ann.model.enter("K7QM2X");
  expect(names.length).toBe(count);
});
