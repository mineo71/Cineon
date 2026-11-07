// The test rig for Together (port of windows/Cineon.Core.Tests/Together/TogetherRig.cs): a manual
// clock, fakes for the host, the player and the library, and people who share one fake server.

import {
  TogetherClient,
  TogetherIdentity,
  TogetherModel,
  memoryIdentityStore,
  playerCommandText,
  type AddTitleOptions,
  type Clock,
  type Fetch,
  type PartyPlayer,
  type PartyTab,
  type PartyTabId,
  type PlayerCommand,
  type RestoreValues,
  type TitleCard,
  type TitleKind,
  type TitleStatus,
  type TogetherHost,
  type TogetherProgress,
  type TogetherRoute,
  type TogetherTitle,
} from "../../src/core/together";
import { FakeConvex } from "./fakeConvex";

/** Lets everything already started, and what that starts in turn, run. */
export async function settle(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** No test may reach a real server: the global fetch is replaced with one that fails loudly. */
export function blockNetwork(): void {
  beforeAll(() => {
    vi.stubGlobal("fetch", (url: string) => {
      throw new Error(`A test tried to reach ${url}`);
    });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });
}

interface Timer {
  id: number;
  due: number;
  period: number | null;
  fn: () => void;
}

/** A clock that moves only when told, and fires its timers as it passes them. */
export class ManualClock implements Clock {
  private current: number;
  private timers: Timer[] = [];
  private nextId = 0;

  constructor(start: number) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  schedule(ms: number, fn: () => void): () => void {
    return this.add(ms, null, fn);
  }

  every(ms: number, fn: () => void): () => void {
    return this.add(ms, ms, fn);
  }

  private add(ms: number, period: number | null, fn: () => void): () => void {
    const timer: Timer = { id: ++this.nextId, due: this.current + ms, period, fn };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  }

  /**
   * Moves the clock on, firing every timer that comes due on the way, in order, and letting what each
   * one starts finish before moving on (as if the time really passed).
   */
  async advance(seconds: number): Promise<void> {
    const target = this.current + Math.round(seconds * 1000);
    for (;;) {
      let next: Timer | undefined;
      for (const t of this.timers) {
        if (t.due <= target && (!next || t.due < next.due || (t.due === next.due && t.id < next.id))) next = t;
      }
      if (!next) {
        this.current = target;
        break;
      }
      this.current = next.due;
      if (next.period !== null && next.period > 0) next.due += next.period;
      else this.timers = this.timers.filter((t) => t !== next);
      next.fn();
      await settle();
    }
    await settle();
  }
}

export type TestTitle = { -readonly [K in keyof TogetherTitle]: TogetherTitle[K] } & { addedAt: number };

export interface TestProgress {
  titleId: number;
  ref: { season: number; episode: number };
  position: number;
  duration: number;
  finished: boolean;
  updatedAt: number;
}

/** LibraryText.normalize, near enough for these tests. */
export function normalizeName(name: string): string {
  return name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** The library as core/data's LibraryStore keeps it: in memory, with writes that answer with a promise. */
export class FakeLibrary {
  readonly titles = new Map<number, TestTitle>();
  private progress: TestProgress[] = [];
  private nextId = 0;
  onPersonalChange: ((title: TestTitle) => void) | null = null;

  constructor(private readonly clock: Clock) {}

  /** Seconds since 1970, like the data layer. */
  private now(): number {
    return this.clock.now() / 1000;
  }

  get watched(): TestTitle[] {
    return [...this.titles.values()]
      .filter((t) => t.status === "watched")
      .sort((a, b) => (b.finishedAt ?? b.updatedAt) - (a.finishedAt ?? a.updatedAt));
  }

  find(name: string, altName?: string | null, year?: number | null): TestTitle | null {
    const keys = [name, altName].filter((k): k is string => typeof k === "string").map(normalizeName);
    const matches = [...this.titles.values()].filter((t) => keys.includes(t.normName));
    if (year !== null && year !== undefined) {
      return matches.find((t) => t.year === year) ?? matches.find((t) => t.year === null || Math.abs(t.year - year) <= 1) ?? null;
    }
    let best: TestTitle | null = null;
    for (const t of matches) if (!best || t.updatedAt > best.updatedAt) best = t;
    return best;
  }

  progressList(titleId: number): TogetherProgress[] {
    return this.progress.filter((p) => p.titleId === titleId);
  }

  saveProgress(p: TestProgress): void {
    this.progress = this.progress.filter((x) => !(x.titleId === p.titleId && x.ref.season === p.ref.season && x.ref.episode === p.ref.episode));
    this.progress.push(p);
    this.progress.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async addTitle(name: string, options: AddTitleOptions): Promise<TestTitle | null> {
    const status = options.status ?? "none";
    if (options.imdbId) {
      const existing = [...this.titles.values()].find((t) => t.imdbId === options.imdbId);
      if (existing) {
        if (status !== "none" && existing.status === "none") await this.setStatus(existing.id, status);
        return this.titles.get(existing.id) ?? null;
      }
    }
    const now = this.now();
    const title: TestTitle = {
      id: ++this.nextId,
      name,
      normName: normalizeName(name),
      year: options.year ?? null,
      kind: options.kind ?? "unknown",
      status,
      imdbId: options.imdbId ?? null,
      posterUrl: options.posterUrl ?? null,
      ratingHalves: null,
      addedAt: now,
      updatedAt: now,
      ratedAt: null,
      statusAt: null,
      finishedAt: null,
    };
    this.titles.set(title.id, title);
    return title;
  }

  /** Stores a title with exactly these values (the C# tests' Db.UpdateTitle plus Reload). */
  put(title: TestTitle): TestTitle {
    this.titles.set(title.id, title);
    return title;
  }

  async setStatus(id: number, status: TitleStatus): Promise<void> {
    const title = this.titles.get(id);
    if (!title || title.status === status) return;
    const now = this.now();
    const next: TestTitle = { ...title, status, updatedAt: now, statusAt: now };
    if (status === "watched") next.finishedAt = now;
    this.titles.set(id, next);
    this.onPersonalChange?.(next);
  }

  async setRating(id: number, halves: number | null): Promise<void> {
    const title = this.titles.get(id);
    if (!title) return;
    const value = halves === null ? null : Math.min(20, Math.max(1, halves));
    if (title.ratingHalves === value) return;
    const now = this.now();
    const next: TestTitle = { ...title, ratingHalves: value, ratedAt: now, updatedAt: now };
    this.titles.set(id, next);
    this.onPersonalChange?.(next);
  }

  async restore(id: number, values: RestoreValues): Promise<void> {
    let title = this.titles.get(id);
    if (!title) return;
    let changed = false;
    if ("halves" in values && title.ratingHalves !== (values.halves ?? null)) {
      const halves = values.halves ?? null;
      title = { ...title, ratingHalves: halves === null ? null : Math.min(20, Math.max(1, halves)), ratedAt: values.ratedAt ?? null };
      changed = true;
    }
    if (values.status != null && title.status !== values.status) {
      title = { ...title, status: values.status, statusAt: values.statusAt ?? null };
      if (values.status === "watched" && title.finishedAt === null) title = { ...title, finishedAt: values.finishedAt ?? values.statusAt ?? null };
      changed = true;
    }
    if (changed) this.titles.set(id, title);
  }
}

export interface Settings {
  sharePet: boolean;
  finishThreshold: number;
  cloudBackup: boolean;
}

export const defaultSettings = (): Settings => ({ sharePet: true, finishThreshold: 0.92, cloudBackup: true });

export class FakeHost implements TogetherHost<TestTitle> {
  settings: Settings = defaultSettings();
  petCode = "p1-Ab3_x9";
  route: TogetherRoute = "other";
  readonly went: TogetherRoute[] = [];
  readonly toasts: string[] = [];
  clipboard: string | null = null;
  readonly applied: [number, TitleCard][] = [];
  readonly enriched: number[] = [];
  episodes = 3;

  go(route: "web" | "together"): void {
    this.went.push(route);
    this.route = route;
  }
  showToast(text: string): void {
    this.toasts.push(text);
  }
  copyText(text: string): void {
    this.clipboard = text;
  }
  applyMetadata(titleId: number, card: TitleCard): void {
    this.applied.push([titleId, card]);
  }
  enrichMetadata(titleId: number): void {
    this.enriched.push(titleId);
  }
  async episodeCount(): Promise<number> {
    return this.episodes;
  }
}

let nextTabId = 100;

/** A tab with a pretend video that plays on the clock and does what media.js would do with each command. */
export class FakeTab {
  readonly id: PartyTabId = ++nextTabId;
  url: string | null;
  hasVideo = true;
  duration = 5400;
  /** Like a page that won't start sound before a click. */
  blocksAutoplay = false;
  linkedTitleId: number | null = null;
  parsed: TitleCard | null = null;
  private _position = 0;
  private _playing = false;
  private _rate = 1;
  private anchor: number;

  constructor(
    private readonly clock: Clock,
    url: string,
  ) {
    this.url = url;
    this.anchor = clock.now();
  }

  get position(): number {
    return this._playing ? this._position + ((this.clock.now() - this.anchor) / 1000) * this._rate : this._position;
  }
  set position(value: number) {
    this.reanchor(value);
  }
  get playing(): boolean {
    return this._playing;
  }
  set playing(value: boolean) {
    this.reanchor(this.position);
    this._playing = value;
  }
  get rate(): number {
    return this._rate;
  }
  set rate(value: number) {
    this.reanchor(this.position);
    this._rate = value;
  }

  private reanchor(position: number): void {
    this._position = position;
    this.anchor = this.clock.now();
  }
}

export class FakePlayer implements PartyPlayer {
  readonly tabs = new Map<PartyTabId, FakeTab>();
  selected: PartyTabId | null = null;
  readonly commands: { tab: PartyTabId; command: string }[] = [];
  readonly banners: { tab: PartyTabId; id: string; text: string; timeout: number }[] = [];
  readonly loads: { tab: PartyTabId; url: string }[] = [];
  readonly opened: { url: string; select: boolean }[] = [];

  constructor(private readonly clock: Clock) {}

  add(url: string, select = true): FakeTab {
    const tab = new FakeTab(this.clock, url);
    this.tabs.set(tab.id, tab);
    if (select) this.selected = tab.id;
    return tab;
  }

  get selectedFake(): FakeTab | null {
    return this.selected === null ? null : (this.tabs.get(this.selected) ?? null);
  }

  private snapshot(t: FakeTab): PartyTab {
    return {
      id: t.id,
      url: t.url,
      media: t.hasVideo ? { position: t.position, duration: t.duration, isPlaying: t.playing, rate: t.rate } : null,
      linkedTitleId: t.linkedTitleId,
      parsed: t.parsed,
    };
  }

  selectedTab(): PartyTab | null {
    const t = this.selectedFake;
    return t ? this.snapshot(t) : null;
  }

  async tab(id: PartyTabId): Promise<PartyTab | null> {
    const t = this.tabs.get(id);
    return t ? this.snapshot(t) : null;
  }

  async openTab(url: string, select: boolean): Promise<PartyTabId> {
    this.opened.push({ url, select });
    const tab = new FakeTab(this.clock, url);
    this.tabs.set(tab.id, tab);
    if (select) this.selected = tab.id;
    return tab.id;
  }

  load(tab: PartyTabId, url: string): void {
    this.loads.push({ tab, url });
    const t = this.tabs.get(tab);
    if (t) t.url = url;
  }

  async playerState(tab: PartyTabId): Promise<unknown> {
    const t = this.tabs.get(tab);
    if (!t || !t.hasVideo) return null;
    return { type: "tick", t: t.position, d: t.duration, paused: !t.playing, muted: false, rate: t.rate };
  }

  playerCommand(tab: PartyTabId, command: PlayerCommand): void {
    this.commands.push({ tab, command: playerCommandText(command) });
    const t = this.tabs.get(tab);
    if (!t) return;
    if (command.kind === "play" && !t.blocksAutoplay) t.playing = true;
    else if (command.kind === "pause") t.playing = false;
    else if (command.kind === "seek") t.position = command.seconds;
    else if (command.kind === "rate") t.rate = command.rate;
  }

  showBanner(tab: PartyTabId, id: string, text: string, timeout: number): void {
    this.banners.push({ tab, id, text, timeout });
  }
}

/** One person's connection to the shared fake server, which can drop. */
export class Connection {
  offline = false;
  constructor(private readonly server: FakeConvex) {}

  readonly fetch: Fetch = (url, init) => {
    if (this.offline) return Promise.reject(new TypeError("The network connection was lost."));
    return this.server.fetch(url, init);
  };
}

/** A person with a profile, a library, the extension around them and a TogetherModel on the shared server. */
export class TestPerson {
  readonly profile: { name: string };
  readonly library: FakeLibrary;
  readonly host = new FakeHost();
  readonly player: FakePlayer;
  readonly connection: Connection;
  readonly client: TogetherClient | null;
  readonly identityStore = memoryIdentityStore();
  model!: TogetherModel<TestTitle>;

  private constructor(
    readonly rig: TogetherRig,
    name: string,
    withServer: boolean,
  ) {
    this.profile = { name };
    this.library = new FakeLibrary(rig.clock);
    this.player = new FakePlayer(rig.clock);
    this.connection = new Connection(rig.server);
    this.client = withServer ? new TogetherClient("https://fake-deployment.convex.cloud", { fetch: this.connection.fetch }) : null;
  }

  static async create(rig: TogetherRig, name: string, withServer: boolean): Promise<TestPerson> {
    const person = new TestPerson(rig, name, withServer);
    person.model = await person.makeModel();
    return person;
  }

  private makeModel(): Promise<TogetherModel<TestTitle>> {
    return TogetherModel.create({
      profile: this.profile,
      library: this.library,
      host: this.host,
      player: this.player,
      client: this.client,
      identityStore: this.identityStore,
      clock: this.rig.clock,
    });
  }

  /** The stored identity, as the next start would read it. */
  identity(): Promise<TogetherIdentity> {
    return TogetherIdentity.load(this.identityStore, "x");
  }

  /** The model as it would be after closing the browser and opening it again. */
  async restart(): Promise<TogetherModel<TestTitle>> {
    this.model.stop();
    await settle();
    this.model = await this.makeModel();
    return this.model;
  }

  addTitle(name: string, year: number | null, kind: TitleKind, status: TitleStatus, imdb: string | null = null): Promise<TestTitle> {
    return this.library.addTitle(name, { year, kind, status, imdbId: imdb }).then((t) => t!);
  }
}

export class TogetherRig {
  readonly clock = new ManualClock(Date.UTC(2026, 10, 6, 20, 0, 0));
  readonly server = new FakeConvex(this.clock);
  private readonly people: TestPerson[] = [];

  async person(name: string, withServer = true): Promise<TestPerson> {
    const person = await TestPerson.create(this, name, withServer);
    this.people.push(person);
    return person;
  }

  /** Moves the clock (and the server's) on, letting whatever the timers start finish. */
  advance(seconds: number): Promise<void> {
    return this.clock.advance(seconds);
  }

  /** Moves on a step at a time until `condition` holds. */
  async advanceUntil(condition: () => boolean, what: string, step = 1, steps = 20): Promise<void> {
    for (let i = 0; i < steps; i++) {
      if (condition()) return;
      await this.advance(step);
    }
    if (!condition()) throw new Error("Never happened: " + what);
  }

  /** Waits (in real time) until `condition` holds. */
  async waitUntil(condition: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for " + what);
      await settle(1);
    }
  }

  async dispose(): Promise<void> {
    for (const person of this.people) person.model.stop();
    await settle();
  }
}
