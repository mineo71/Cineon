import { afterEach, describe, expect, it } from "vitest";
import { MemoryStorage } from "../../src/core/data";
import { type Signal, SignalChannel, setTransport } from "../../src/shared/messages";
import { AppModel, parseHash } from "../../src/ui/lib/app";
import { Session } from "../../src/ui/lib/session";

/** A channel whose posts are recorded, and which can be fed other contexts' signals. */
class RecordingChannel extends SignalChannel {
  readonly posted: { type: string; keys?: readonly string[] }[] = [];
  private readonly heard: ((s: Signal) => void)[] = [];
  constructor() {
    super(`test-${Math.random()}`);
  }
  override post(signal: Parameters<SignalChannel["post"]>[0]): void {
    this.posted.push(signal as { type: string; keys?: readonly string[] });
  }
  override on(listener: (signal: Signal) => void): () => void {
    this.heard.push(listener);
    return () => undefined;
  }
  deliver(signal: Signal): void {
    for (const listener of this.heard) listener(signal);
  }
}

const open: Session[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  setTransport(undefined);
});

async function session(storage = new MemoryStorage(), channel = new RecordingChannel()) {
  const s = await Session.open(null, { storage, channel, metadata: false });
  open.push(s);
  return { s, channel, storage };
}

describe("Session", () => {
  it("opens the first person, seeds the default sites and loads settings", async () => {
    const { s } = await session();
    expect(s.profiles.profiles).toHaveLength(1);
    expect(s.library.sites.length).toBeGreaterThan(0);
    expect(s.settings.theme).toBe("dark");
  });

  it("posts a library signal after its own writes, never after a reload", async () => {
    const { s, channel } = await session();
    channel.posted.length = 0;
    const title = await s.library.addTitle("Dune", { status: "backlog" });
    await s.library.setRating(title!.id, 16);
    const kinds = channel.posted.filter((p) => p.type === "library");
    expect(kinds.length).toBeGreaterThan(0);
    channel.posted.length = 0;
    // Someone else wrote: reload, and stay quiet about it.
    channel.deliver({ type: "library", profileId: s.profile.id, keys: ["titles"], origin: "other" });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(channel.posted.filter((p) => p.type === "library")).toHaveLength(0);
    expect(s.library.titles.get(title!.id)?.ratingHalves).toBe(16);
  });

  it("picks up another context's writes to the same profile", async () => {
    const storage = new MemoryStorage();
    const first = await session(storage);
    const second = await session(storage);
    expect(second.s.profile.id).toBe(first.s.profile.id);
    const added = await first.s.library.addTitle("Arrival", { status: "watched" });
    second.channel.deliver({ type: "library", profileId: first.s.profile.id, keys: ["titles"], origin: "first" });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(second.s.library.titles.get(added!.id)?.name).toBe("Arrival");
  });

  it("saves settings and tells the others", async () => {
    const { s, channel } = await session();
    let bumped = 0;
    s.subscribe(() => bumped++);
    await s.updateSettings({ theme: "white" });
    expect(s.settings.theme).toBe("white");
    expect(bumped).toBeGreaterThan(0);
    expect(channel.posted.some((p) => p.type === "settings")).toBe(true);
    expect((await s.db.loadSettings()).theme).toBe("white");
  });

  it("tells the background's cloud backup about stars and lists changed here, batched", async () => {
    const sent: unknown[] = [];
    setTransport({ sendMessage: async (message) => (sent.push(message), { ok: true, value: { ok: true } }) });
    const { s } = await session();
    const a = await s.library.addTitle("Heat", { status: "backlog" });
    const b = await s.library.addTitle("Ronin", { status: "backlog" });
    await s.library.setRating(a!.id, 18);
    await s.library.setStatus(b!.id, "watched");
    await new Promise((resolve) => setTimeout(resolve, 350));
    const notes = sent.filter((m) => (m as { type: string }).type === "cloud.noteChanges");
    expect(notes).toHaveLength(1);
    expect((notes[0] as { titleIds: number[] }).titleIds.sort()).toEqual([a!.id, b!.id].sort());
  });

  it("works out the pet from the library, once per change", async () => {
    const { s } = await session();
    const a = s.statsAndPet();
    expect(s.statsAndPet()).toBe(a);
    await s.library.addTitle("Heat", { status: "watched" });
    expect(s.statsAndPet()).not.toBe(a);
    expect(a.pet.name.length).toBeGreaterThan(0);
  });
});

describe("AppModel", () => {
  it("reads routes and overlays from the address", () => {
    expect(parseHash("#library?title=12").route).toBe("library");
    expect(parseHash("#library?title=12").params.get("title")).toBe("12");
    expect(parseHash("#panel").route).toBe("panel");
    expect(parseHash("#nope").route).toBeNull();
  });

  it("opens and dismisses overlays topmost first", async () => {
    const { s } = await session();
    const model = new AppModel(s);
    model.applyHash("#library?title=3&add=Dune");
    expect(model.state.route).toBe("library");
    expect(model.state.detailTitleId).toBe(3);
    expect(model.state.sheet).toEqual({ kind: "addTitle", query: "Dune" });
    model.openCommandBar("x");
    expect(model.dismissTop()).toBe(true);
    expect(model.state.commandBar).toBeNull();
    expect(model.dismissTop()).toBe(true);
    expect(model.state.sheet).toBeNull();
    expect(model.dismissTop()).toBe(true);
    expect(model.state.detailTitleId).toBeNull();
    expect(model.dismissTop()).toBe(false);
  });

  it("shows one toast at a time and doesn't restart the same one", async () => {
    const { s } = await session();
    const model = new AppModel(s);
    model.toast("Added Dune to backlog");
    const first = model.state.toast;
    model.toast("Added Dune to backlog");
    expect(model.state.toast).toBe(first);
    model.toast("Something else");
    expect(model.state.toast?.message).toBe("Something else");
    model.dismissToast();
    expect(model.state.toast).toBeNull();
  });

  it("switches people: a new session for the other profile, Home, overlays closed", async () => {
    const { s } = await session();
    const model = new AppModel(s);
    const other = await s.profiles.add("Sam");
    model.openTitle(1);
    await model.switchProfile(other.id);
    open.push(model.session);
    expect(model.session.profile.id).toBe(other.id);
    expect(model.state.route).toBe("home");
    expect(model.state.detailTitleId).toBeNull();
    expect(model.session.profiles.lastUsedId).toBe(other.id);
  });
});
