// Port of Cineon/App/TogetherModel.swift, by way of windows/Cineon.Core/Together/TogetherModel.cs.
// The Mac's @Observable becomes read-only properties plus a change emitter (`subscribe`). What the Mac
// reaches through ProfileSession and the browser comes through TogetherHost and PartyPlayer, the
// library through TogetherLibrary, and the identity file through an IdentityStore. Timers run on an
// injectable Clock.
//
// The Mac's fire-and-forget actions (enter, share, startParty, say, ...) return a promise here that
// settles when the work is done. It never rejects: failures become toasts, as on the Mac.

import { TogetherClient, TogetherError, ShareCode, type ConvexArgs } from "./client";
import { TogetherIdentity, type IdentityStore } from "./identity";
import { systemClock, delay, Emitter, type Clock } from "./clock";
import {
  ChallengeState,
  ChallengeSummary,
  CodeKind,
  CodeReply,
  PartyMessage,
  PartyState,
  Registered,
  ShareInfo,
  TitleCard,
} from "./types";
import type { PartyPlayer, PartyTab, PartyTabId, PlayerCommand, TogetherHost } from "./host";
import {
  isEpisode,
  progressFraction,
  titleStatusLabel,
  type TogetherLibrary,
  type TogetherProgress,
  type TogetherTitle,
} from "./library";
import { detach, errorMessage, numberText, parseUrl, swiftPrefix, swiftTrim } from "./text";

/** How far someone has got with a challenge's title, from their own library. */
export interface ChallengeProgress {
  fraction: number;
  watched: number;
  label: string;
  finished: boolean;
}

/** media.js's `state()` as the model reads it. */
export interface PlayerState {
  position: number;
  playing: boolean;
  rate: number;
}

/** The properties that change; `subscribe` listeners hear which one. */
export type TogetherProperty =
  | "party"
  | "isHost"
  | "challenges"
  | "details"
  | "openedShares"
  | "lastShareCode"
  | "isWorking"
  | "personId";

/** Whose Together this is. `name` is read each time, so a renamed profile goes out under its new name. */
export interface TogetherProfile {
  readonly name: string;
}

export interface TogetherModelOptions<T extends TogetherTitle = TogetherTitle> {
  profile: TogetherProfile;
  /** The profile's library (backlog additions, challenge progress). */
  library: TogetherLibrary<T>;
  /** Toasts, clipboard, navigation, settings, the pet, metadata. */
  host: TogetherHost<T>;
  /** Tabs and their players, for watch parties. */
  player: PartyPlayer;
  /** The server, or null when this build has none (`isAvailable` is false). */
  client: TogetherClient | null;
  /** Where the identity (together.json) is kept. */
  identityStore: IdentityStore;
  /** The clock and timers. Defaults to the system's. */
  clock?: Clock;
  /**
   * The "same page" key for addresses (core/data's `UrlKey.make`), so a guest's tab isn't reloaded for
   * a tracking parameter. Defaults to a small stand-in that drops the scheme, `www.`, the fragment and
   * tracking parameters.
   */
  urlKey?: (url: string) => string;
}

interface LastSent {
  position: number;
  playing: boolean;
  rate: number;
  at: number;
}

/**
 * Watching with friends: share codes for lists, watch parties that follow the host, and races to the
 * end of a series. Nothing goes to the server until someone starts or joins something.
 */
export class TogetherModel<T extends TogetherTitle = TogetherTitle> {
  /** WatchTracker.minimumDuration: shorter videos are ads and previews, not films. */
  static readonly MINIMUM_DURATION = 240;

  readonly clock: Clock;
  private readonly profile: TogetherProfile;
  private readonly library: TogetherLibrary<T>;
  private readonly host: TogetherHost<T>;
  private readonly player: PartyPlayer;
  private readonly client: TogetherClient | null;
  private readonly store: IdentityStore;
  private readonly urlKey: (url: string) => string;
  private readonly identity: TogetherIdentity;
  private readonly emitter = new Emitter<TogetherProperty>();
  private saving: Promise<void> = Promise.resolve();

  private _party: PartyState | null = null;
  private _isHost = false;
  private _challenges: readonly ChallengeSummary[] = [];
  private _details: ReadonlyMap<string, ChallengeState> = new Map();
  private _openedShares: readonly ShareInfo[] = [];
  private _lastShareCode: string | null = null;
  private _isWorking = false;
  private _personId: string | null;

  private stopPartyLoop: (() => void) | null = null;
  private stopChallengeLoop: (() => void) | null = null;
  private partyTabId: PartyTabId | null = null;
  private lastSent: LastSent | null = null;
  private lastCorrection = -Infinity;
  private lastPoll = -Infinity;
  private lastHeartbeat = -Infinity;
  private isTicking = false;
  private readonly seenReactions = new Set<string>();
  private readonly seenMessages = new Set<string>();
  /** Milliseconds since 1970 when this person got into the party. */
  private joinedAt = 0;
  private readonly reported = new Map<string, string>();
  private readonly knownWinners = new Map<string, string | null>();
  private lastChallengeRefresh = -Infinity;
  private askedToPressPlay = false;

  /** Loads (or makes) the profile's identity, then builds the model. */
  static async create<T extends TogetherTitle>(options: TogetherModelOptions<T>): Promise<TogetherModel<T>> {
    const identity = await TogetherIdentity.load(options.identityStore, options.profile.name);
    return new TogetherModel(options, identity);
  }

  private constructor(options: TogetherModelOptions<T>, identity: TogetherIdentity) {
    this.profile = options.profile;
    this.library = options.library;
    this.host = options.host;
    this.player = options.player;
    this.client = options.client;
    this.store = options.identityStore;
    this.clock = options.clock ?? systemClock;
    this.urlKey = options.urlKey ?? simpleUrlKey;
    this.identity = identity;
    this._personId = identity.personId;
    // A party doesn't survive a restart: the film and everyone's place in it have moved on.
    if (identity.partyCode !== null) {
      identity.partyCode = null;
      this.save();
    }
  }

  // MARK: State

  /** Adds a listener that hears which property changed. Returns a function that removes it. */
  subscribe(listener: (property: TogetherProperty) => void): () => void {
    return this.emitter.subscribe(listener);
  }

  /** The party this person is in, as last heard from the server. */
  get party(): PartyState | null {
    return this._party;
  }
  get isHost(): boolean {
    return this._isHost;
  }
  /** The challenges this person is in, newest first. */
  get challenges(): readonly ChallengeSummary[] {
    return this._challenges;
  }
  /** Each challenge's members and winner, by code. A new map each time it changes. */
  get details(): ReadonlyMap<string, ChallengeState> {
    return this._details;
  }
  /** Friends' lists opened here, most recent first. A new array each time it changes. */
  get openedShares(): readonly ShareInfo[] {
    return this._openedShares;
  }
  get lastShareCode(): string | null {
    return this._lastShareCode;
  }
  /** Something started with a button is still going (opening a code, sharing, starting a party). */
  get isWorking(): boolean {
    return this._isWorking;
  }
  /** This profile's id on the server, once registered. */
  get personId(): string | null {
    return this._personId;
  }
  get isAvailable(): boolean {
    return this.client !== null;
  }
  get myName(): string {
    return this.profile.name;
  }
  /** Lets this profile be found again from another one, or after starting over. */
  get recoveryCode(): string {
    return this.identity.secret;
  }

  /** Resolves once every identity write asked for so far has finished. */
  whenSaved(): Promise<void> {
    return this.saving;
  }

  private now(): number {
    return this.clock.now();
  }

  private save(): void {
    const write = this.identity.save(this.store);
    this.saving = this.saving.then(() => write);
  }

  private notify(property: TogetherProperty): void {
    this.emitter.emit(property);
  }

  private setParty(value: PartyState | null): void {
    if (this._party === value) return;
    this._party = value;
    this.notify("party");
  }
  private setIsHost(value: boolean): void {
    if (this._isHost === value) return;
    this._isHost = value;
    this.notify("isHost");
  }
  private setChallenges(value: readonly ChallengeSummary[]): void {
    if (this._challenges === value) return;
    this._challenges = value;
    this.notify("challenges");
  }
  private setLastShareCode(value: string | null): void {
    if (this._lastShareCode === value) return;
    this._lastShareCode = value;
    this.notify("lastShareCode");
  }
  private setIsWorking(value: boolean): void {
    if (this._isWorking === value) return;
    this._isWorking = value;
    this.notify("isWorking");
  }
  private setPersonId(value: string | null): void {
    if (this._personId === value) return;
    this._personId = value;
    this.notify("personId");
  }
  private setDetail(code: string, state: ChallengeState): void {
    const next = new Map(this._details);
    next.set(code, state);
    this._details = next;
    this.notify("details");
  }
  private setOpenedShares(value: readonly ShareInfo[]): void {
    this._openedShares = value;
    this.notify("openedShares");
  }

  // MARK: Starting and stopping

  start(): void {
    if (!this.client) return;
    this.stopChallengeLoop?.();
    this.stopChallengeLoop = this.clock.every(5000, () => this.challengeTick());
    if (this.identity.personId === null) return;
    detach(this.startWork());
  }

  private async startWork(): Promise<void> {
    await this.refreshChallenges();
    for (const code of [...this.identity.openedShares]) await this.loadShare(code, false);
  }

  stop(): void {
    this.stopChallengeLoop?.();
    this.stopChallengeLoop = null;
    if (this._party !== null) detach(this.leavePartyNow());
  }

  // MARK: Identity

  private async register(): Promise<TogetherClient> {
    const client = this.client;
    if (!client) throw new TogetherError("Together isn't set up in this build");
    const pet = this.host.settings.sharePet ? this.host.petCode : null;
    if (this.identity.personId === null || this.identity.name !== this.myName || this.identity.pet !== pet) {
      const args: ConvexArgs = {
        deviceSecret: this.identity.secret,
        name: this.myName,
        // An empty code takes the pet off, where leaving it out would keep the old one.
        pet: pet ?? "",
      };
      const reply = await client.mutation("people:register", args, Registered.fromJson);
      this.identity.personId = reply.personId;
      this.identity.name = this.myName;
      this.identity.pet = pet;
      this.setPersonId(reply.personId);
      this.save();
    }
    return client;
  }

  /** The server and this profile's secret, registering first if needed. For the cloud backup. Throws TogetherError. */
  async authorized(): Promise<{ client: TogetherClient; secret: string }> {
    const client = await this.register();
    return { client, secret: this.identity.secret };
  }

  /** Takes over the identity a recovery code belongs to: its ratings, lists and challenges. */
  async adopt(recoveryCode: string): Promise<boolean> {
    const code = swiftTrim(recoveryCode);
    if (code.length < 32 || code === this.identity.secret || !TogetherIdentity.isStrictBase64(code)) return false;
    this.identity.secret = code;
    this.identity.personId = null;
    this.identity.pet = null;
    this.save();
    this.setPersonId(null);
    try {
      await this.register();
    } catch {
      return false;
    }
    await this.refreshChallenges();
    return true;
  }

  /** Sends a changed pet or name to friends' screens. */
  async refreshIdentity(): Promise<void> {
    if (this.identity.personId === null) return;
    try {
      await this.register();
    } catch (e) {
      if (!(e instanceof TogetherError)) throw e;
    }
  }

  private async perform(action: string, work: () => Promise<void>): Promise<void> {
    this.setIsWorking(true);
    try {
      await work();
    } catch (e) {
      this.host.showToast(`Couldn't ${action}: ${errorMessage(e)}`);
    } finally {
      this.setIsWorking(false);
    }
  }

  private async quietly(client: TogetherClient, path: string, args: ConvexArgs): Promise<void> {
    try {
      await client.mutation(path, args);
    } catch (e) {
      if (!(e instanceof TogetherError)) throw e;
    }
  }

  // MARK: Codes

  /** Opens whatever a friend's code points to: a list, a party or a challenge. */
  async enter(code: string): Promise<void> {
    const clean = ShareCode.normalize(code);
    if (clean.length !== 6) {
      this.host.showToast("Codes have six letters and digits, like K7Q-2MX");
      return;
    }
    await this.perform("open that code", async () => {
      const client = await this.register();
      const found = await client.query("codes:resolve", { code: clean }, CodeKind.fromJsonOrNull);
      if (!found) throw new TogetherError("No party, list or challenge has that code");
      switch (found.kind) {
        case "share":
          await this.loadShare(clean, true);
          break;
        case "party":
          await this.joinParty(clean);
          break;
        case "challenge":
          await this.joinChallenge(clean);
          break;
        default:
          throw new TogetherError("Cineon doesn't know that kind of code yet");
      }
    });
  }

  private copy(code: string): void {
    this.host.copyText(ShareCode.display(code));
  }

  // MARK: Sharing lists

  async shareWatched(): Promise<void> {
    const titles = this.library.watched.slice(0, 500).map((t) => TitleCard.from(t));
    if (titles.length === 0) {
      this.host.showToast("Nothing in Watched to share yet");
      return;
    }
    await this.shareList(`${this.myName}'s watched films`, titles);
  }

  async share(title: T): Promise<void> {
    await this.shareList(title.name, [TitleCard.from(title)]);
  }

  private shareList(label: string, titles: TitleCard[]): Promise<void> {
    return this.perform("share", async () => {
      const client = await this.register();
      const reply = await client.mutation(
        "shares:create",
        { deviceSecret: this.identity.secret, label, titles: titles.map((t) => TitleCard.toJson(t)) },
        CodeReply.fromJson,
      );
      this.setLastShareCode(reply.code);
      this.copy(reply.code);
      this.host.showToast(`Code ${ShareCode.display(reply.code)} copied. Send it to a friend.`);
    });
  }

  private async loadShare(code: string, remember: boolean): Promise<void> {
    const client = this.client;
    if (!client) return;
    let share: ShareInfo | null;
    try {
      share = await client.query("shares:get", { code }, ShareInfo.fromJsonOrNull);
    } catch (e) {
      if (!(e instanceof TogetherError)) throw e;
      share = null;
    }
    if (!share) {
      if (remember) this.host.showToast("That list is gone");
      return;
    }
    const found = share;
    this.setOpenedShares([found, ...this._openedShares.filter((s) => s.code !== found.code)]);
    if (remember) {
      const codes = [found.code, ...this.identity.openedShares.filter((c) => c !== found.code)];
      this.identity.openedShares = codes.slice(0, 20);
      this.save();
      this.host.go("together");
    }
  }

  forgetShare(code: string): void {
    this.identity.openedShares = this.identity.openedShares.filter((c) => c !== code);
    this.save();
    this.setOpenedShares(this._openedShares.filter((s) => s.code !== code));
  }

  private findCard(card: TitleCard): T | null {
    const id = card.imdbId;
    if (id !== null) {
      for (const title of this.library.titles.values()) {
        if (title.imdbId === id) return title;
      }
    }
    return this.library.find(card.name, null, card.year) ?? null;
  }

  /** Adds a friend's film to the backlog, filling in its poster and details. */
  async addToBacklog(card: TitleCard): Promise<void> {
    const existing = this.findCard(card);
    if (existing) {
      if (existing.status === "none") await this.library.setStatus(existing.id, "backlog");
      const now = this.library.titles.get(existing.id);
      const list = now ? titleStatusLabel(now.status).toLowerCase() : "library";
      this.host.showToast(`${existing.name} is already in your ${list}`);
      return;
    }
    const added = await this.library.addTitle(card.name, {
      year: card.year,
      kind: TitleCard.titleKind(card),
      status: "backlog",
      imdbId: card.imdbId,
      posterUrl: TitleCard.posterUri(card),
    });
    if (!added) return;
    if (card.imdbId !== null) this.host.applyMetadata(added.id, card);
    else this.host.enrichMetadata(added.id);
    this.host.showToast(`Added ${card.name} to backlog`);
  }

  hasInLibrary(card: TitleCard): boolean {
    const id = card.imdbId;
    if (id !== null) {
      for (const title of this.library.titles.values()) {
        if (title.imdbId === id && title.status !== "none") return true;
      }
    }
    const title = this.library.find(card.name, null, card.year);
    return !!title && title.status !== "none";
  }

  // MARK: Watch party

  /** Starts a party from the film playing in the selected tab. */
  async startParty(): Promise<void> {
    const tab = await this.player.selectedTab();
    const url = tab?.url ?? null;
    const media = tab?.media ?? null;
    if (!tab || url === null || media === null || media.duration < TogetherModel.MINIMUM_DURATION) {
      this.host.showToast("Start the film first, then invite people to it");
      return;
    }
    const linked = tab.linkedTitleId != null ? this.library.titles.get(tab.linkedTitleId) : undefined;
    const card = linked ? TitleCard.from(linked) : tab.parsed ?? null;
    await this.perform("start the party", async () => {
      const client = await this.register();
      const args: ConvexArgs = {
        deviceSecret: this.identity.secret,
        pageUrl: url,
        position: media.position,
        playing: media.isPlaying,
        rate: media.rate,
      };
      if (card) args.title = TitleCard.toJson(card);
      const reply = await client.mutation("parties:create", args, CodeReply.fromJson);
      this.partyTabId = tab.id;
      this.setIsHost(true);
      this.lastSent = { position: media.position, playing: media.isPlaying, rate: media.rate, at: this.now() };
      this.identity.partyCode = reply.code;
      this.save();
      this.setParty(await client.query("parties:get", this.partyQuery(reply.code), PartyState.fromJsonOrNull));
      this.joinedAt = this._party?.now ?? this.now();
      this.copy(reply.code);
      this.host.showToast(`Party ${ShareCode.display(reply.code)} started. The code is copied.`);
      this.startPartyLoop();
    });
  }

  private async joinParty(code: string): Promise<void> {
    const client = await this.register();
    if (this._party !== null) detach(this.leavePartyNow());
    const state = await client.mutation("parties:join", { deviceSecret: this.identity.secret, code }, PartyState.fromJson);
    this.setParty(state);
    this.joinedAt = state.now;
    this.setIsHost(state.hostId === this.identity.personId);
    this.identity.partyCode = code;
    this.save();
    this.askedToPressPlay = false;
    const url = parseUrl(state.pageUrl);
    if (url !== null) {
      this.partyTabId = await this.player.openTab(url, true);
      this.host.go("web");
    }
    this.host.showToast(`Joined ${state.hostName}'s party`);
    this.startPartyLoop();
  }

  /** Leaves the party; when the host leaves, it ends for everyone. */
  async leaveParty(): Promise<void> {
    await this.leavePartyNow();
  }

  /** Forgets the party straight away; the returned promise is the server hearing about it. */
  private leavePartyNow(): Promise<void> {
    const code = this._party?.code ?? this.identity.partyCode;
    if (code === null) return Promise.resolve();
    this.stopPartyLoop?.();
    this.stopPartyLoop = null;
    this.setParty(null);
    this.setIsHost(false);
    this.partyTabId = null;
    this.lastSent = null;
    this.identity.partyCode = null;
    this.save();
    if (!this.client) return Promise.resolve();
    return this.quietly(this.client, "parties:leave", { deviceSecret: this.identity.secret, code });
  }

  /** A line of chat to everyone in the party. */
  async say(text: string): Promise<void> {
    const clean = swiftTrim(text);
    const client = this.client;
    const code = this._party?.code;
    if (!client || code === undefined || clean.length === 0) return;
    try {
      await client.mutation("parties:say", { deviceSecret: this.identity.secret, code, text: swiftPrefix(clean, 280) });
      this.lastPoll = -Infinity;
    } catch (e) {
      this.host.showToast(`Couldn't send that: ${errorMessage(e)}`);
    }
  }

  async react(emoji: string): Promise<void> {
    const client = this.client;
    const code = this._party?.code;
    if (!client || code === undefined) return;
    await this.quietly(client, "parties:react", { deviceSecret: this.identity.secret, code, emoji });
  }

  copyPartyCode(): void {
    const code = this._party?.code;
    if (code === undefined) return;
    this.copy(code);
    this.host.showToast(`Code ${ShareCode.display(code)} copied`);
  }

  /** A fresh `t` each time, or the server answers from its cache with a stale clock. */
  private partyQuery(code: string): ConvexArgs {
    return { code, t: this.now() };
  }

  private async partyTab(): Promise<PartyTab | null> {
    return this.partyTabId === null ? null : await this.player.tab(this.partyTabId);
  }

  private startPartyLoop(): void {
    this.stopPartyLoop?.();
    this.stopPartyLoop = this.clock.every(1000, () => detach(this.partyTick()));
  }

  /** One second of a party: the host reports, members follow, everyone stays on the list. Run by the party loop. */
  async partyTick(): Promise<void> {
    const client = this.client;
    const code = this._party?.code;
    if (this.isTicking || !client || code === undefined) return;
    this.isTicking = true;
    try {
      if (this._isHost) await this.sendHostState(client, code);
      // Members follow every second. The host only needs to see who's there and reactions.
      if (!this._isHost || this.now() - this.lastPoll > 2500) {
        this.lastPoll = this.now();
        // A dropped connection is just a missed second. Only the server saying so ends the party.
        let fetched: PartyState | null;
        try {
          fetched = await client.query("parties:get", this.partyQuery(code), PartyState.fromJsonOrNull);
        } catch (e) {
          if (e instanceof TogetherError) return;
          throw e;
        }
        if (!fetched || fetched.ended) {
          if (!this._isHost) this.host.showToast("The party is over");
          detach(this.leavePartyNow());
          return;
        }
        this.setParty(fetched);
        await this.showNewReactions(fetched);
        await this.showNewMessages(fetched);
        if (!this._isHost) await this.follow(fetched);
      }
      // Members only ever read, so without this they'd drop off everyone's list after 30 s.
      if (this.now() - this.lastHeartbeat > 5000) {
        this.lastHeartbeat = this.now();
        await this.quietly(client, "parties:heartbeat", { deviceSecret: this.identity.secret, code });
      }
    } finally {
      this.isTicking = false;
    }
  }

  /** The player's own clock, which is fresher than the reports it sends every few seconds. */
  private async playerState(tab: PartyTabId): Promise<PlayerState | null> {
    return TogetherModel.parsePlayerState(await this.player.playerState(tab));
  }

  /** Reads media.js's `state()`: `t` (seconds), `paused`, `rate`. Takes the object or its JSON text. */
  static parsePlayerState(value: unknown): PlayerState | null {
    let state = value;
    if (typeof value === "string") {
      if (value.length === 0) return null;
      try {
        state = JSON.parse(value);
      } catch {
        return null;
      }
    }
    if (typeof state !== "object" || state === null || Array.isArray(state)) return null;
    const s = state as Record<string, unknown>;
    if (typeof s.t !== "number") return null;
    const p = s.paused;
    const paused = p === false ? false : typeof p === "number" ? p !== 0 : true;
    const rate = typeof s.rate === "number" ? s.rate : 1;
    return { position: s.t, playing: !paused, rate };
  }

  private async sendHostState(client: TogetherClient, code: string): Promise<void> {
    const tabId = this.partyTabId;
    if (tabId === null || !(await this.player.tab(tabId))) return;
    const current = await this.playerState(tabId);
    if (!current) return;
    const at = this.now();
    const last = this.lastSent;
    const expected = last ? (last.playing ? last.position + ((at - last.at) / 1000) * last.rate : last.position) : -100;
    const changed = last?.playing !== current.playing || last?.rate !== current.rate || Math.abs(expected - current.position) > 1.5;
    const due = (at - (last?.at ?? -Infinity)) / 1000 > 4;
    if (!changed && !due) return;
    this.lastSent = { ...current, at };
    const args: ConvexArgs = {
      deviceSecret: this.identity.secret,
      code,
      position: current.position,
      playing: current.playing,
      rate: current.rate,
    };
    const url = (await this.player.tab(tabId))?.url ?? null;
    if (url !== null && url !== this._party?.pageUrl) args.pageUrl = url;
    await this.quietly(client, "parties:update", args);
  }

  private command(tab: PartyTabId, command: PlayerCommand): void {
    this.player.playerCommand(tab, command);
  }

  /** Keeps a member's player with the host's: same page, same second, playing or paused. */
  private async follow(state: PartyState): Promise<void> {
    const tab = await this.partyTab();
    if (!tab) {
      const url = parseUrl(state.pageUrl);
      if (url !== null) this.partyTabId = await this.player.openTab(url, false);
      return;
    }
    const target = parseUrl(state.pageUrl);
    if (target !== null && tab.url !== null && this.urlKey(target) !== this.urlKey(tab.url)) {
      this.player.load(tab.id, target);
      return;
    }
    const mine = await this.playerState(tab.id);
    if (!mine) return;
    if (Math.abs(mine.rate - state.rate) > 0.01) this.command(tab.id, { kind: "rate", rate: state.rate });
    if (state.playing !== mine.playing) {
      if (state.playing) {
        this.command(tab.id, { kind: "play" });
        // A page may only start sound after a click. Ask once.
        if (!this.askedToPressPlay) {
          this.askedToPressPlay = true;
          detach(this.askToPressPlay(tab.id, state.hostName));
        }
      } else {
        this.command(tab.id, { kind: "pause" });
      }
    }
    // Don't chase small drifts, and give a jump time to land before judging it.
    const position = PartyState.expectedPosition(state);
    if (Math.abs(mine.position - position) > 2.5 && this.now() - this.lastCorrection > 3000) {
      this.lastCorrection = this.now();
      this.command(tab.id, { kind: "seek", seconds: position });
    }
  }

  private async askToPressPlay(tabId: PartyTabId, hostName: string): Promise<void> {
    await delay(this.clock, 1500);
    if (this._party?.playing !== true) return;
    const tab = await this.player.tab(tabId);
    if (!tab || tab.media?.isPlaying === true) return;
    this.player.showBanner(tabId, "party", `${hostName} is playing. Press play to join in.`, 6);
  }

  private async showNewMessages(state: PartyState): Promise<void> {
    for (const message of state.messages) {
      const id = PartyMessage.id(message);
      if (this.seenMessages.has(id)) continue;
      this.seenMessages.add(id);
      // Messages from before joining are history, not news.
      if (message.personId === this._personId || message.at < this.joinedAt) continue;
      const text = `${message.name}: ${message.text}`;
      const tab = await this.partyTab();
      if (tab && this.host.route === "web") this.player.showBanner(tab.id, "chat", text, 5);
      else if (this.host.route !== "together") this.host.showToast(text);
    }
  }

  private async showNewReactions(state: PartyState): Promise<void> {
    for (const reaction of state.reactions) {
      const key = `${reaction.name}|${reaction.emoji}|${numberText(reaction.at)}`;
      if (this.seenReactions.has(key)) continue;
      this.seenReactions.add(key);
      if (reaction.name === this.myName) continue;
      const text = `${reaction.name} ${reaction.emoji}`;
      const tab = await this.partyTab();
      if (tab && this.host.route === "web") this.player.showBanner(tab.id, "reaction", text, 3);
      else this.host.showToast(text);
    }
  }

  // MARK: Challenges

  /** "First to finish": everyone who joins shows with how far they've got. */
  async createChallenge(title: T): Promise<void> {
    await this.perform("start the challenge", async () => {
      const client = await this.register();
      let total = 1;
      if (title.kind === "series" || title.kind === "cartoon") total = Math.max(1, await this.host.episodeCount(title));
      const reply = await client.mutation(
        "challenges:create",
        { deviceSecret: this.identity.secret, title: TitleCard.toJson(TitleCard.from(title)), totalEpisodes: total },
        CodeReply.fromJson,
      );
      this.copy(reply.code);
      this.host.showToast(`Challenge ${ShareCode.display(reply.code)} started. The code is copied.`);
      this.reported.delete(reply.code);
      await this.refreshChallenges();
      this.host.go("together");
    });
  }

  private async joinChallenge(code: string): Promise<void> {
    const client = await this.register();
    const state = await client.mutation("challenges:join", { deviceSecret: this.identity.secret, code }, ChallengeState.fromJson);
    this.setDetail(code, state);
    if (!this.hasInLibrary(state.title)) await this.addToBacklog(state.title);
    this.host.showToast(`You're in: first to finish ${state.title.name}`);
    await this.refreshChallenges();
    this.host.go("together");
  }

  async leaveChallenge(code: string): Promise<void> {
    await this.perform("leave the challenge", async () => {
      const client = await this.register();
      await client.mutation("challenges:leave", { deviceSecret: this.identity.secret, code });
      this.setChallenges(this._challenges.filter((c) => c.code !== code));
      if (this._details.has(code)) {
        const next = new Map(this._details);
        next.delete(code);
        this._details = next;
        this.notify("details");
      }
    });
  }

  copyChallengeCode(code: string): void {
    this.copy(code);
    this.host.showToast(`Code ${ShareCode.display(code)} copied`);
  }

  /** Every 5 s once started. */
  private challengeTick(): void {
    if (this.identity.personId === null) return;
    // Every few seconds while you're looking, once a minute otherwise.
    const looking = this.host.route === "together";
    if (!looking && this.now() - this.lastChallengeRefresh <= 60_000) return;
    detach(this.refreshChallenges());
  }

  async refreshChallenges(): Promise<void> {
    const client = this.client;
    if (!client || this.identity.personId === null) return;
    this.lastChallengeRefresh = this.now();
    let mine: ChallengeSummary[];
    try {
      mine = await client.query("challenges:mine", { deviceSecret: this.identity.secret }, ChallengeSummary.listFromJson);
    } catch (e) {
      if (e instanceof TogetherError) return;
      throw e;
    }
    this.setChallenges(mine);
    for (const summary of mine) {
      await this.report(summary, client);
      let state: ChallengeState | null;
      try {
        state = await client.query("challenges:get", { code: summary.code }, ChallengeState.fromJsonOrNull);
      } catch (e) {
        if (e instanceof TogetherError) continue;
        throw e;
      }
      if (!state) continue;
      this.setDetail(summary.code, state);
      this.announceWinner(state);
    }
  }

  private announceWinner(state: ChallengeState): void {
    const known = this.knownWinners.has(state.code);
    const previous = this.knownWinners.get(state.code) ?? null;
    this.knownWinners.set(state.code, state.winnerName);
    // Only news counts: a winner already there when Cineon opened isn't announced again.
    if (!known || previous !== null || state.winnerName === null) return;
    if (state.winnerId === this.identity.personId) this.host.showToast(`You finished ${state.title.name} first!`);
    else this.host.showToast(`${state.winnerName} finished ${state.title.name} first`);
  }

  private async report(summary: ChallengeSummary, client: TogetherClient): Promise<void> {
    const progress = this.localProgress(summary.title, Math.trunc(summary.totalEpisodes));
    const signature = `${Math.trunc(progress.fraction * 1000)}|${progress.watched}|${progress.finished}`;
    if (this.reported.get(summary.code) === signature) return;
    try {
      await client.mutation("challenges:report", {
        deviceSecret: this.identity.secret,
        code: summary.code,
        fraction: progress.fraction,
        watchedEpisodes: progress.watched,
        label: progress.label,
        finished: progress.finished,
      });
      this.reported.set(summary.code, signature);
    } catch (e) {
      if (!(e instanceof TogetherError)) throw e;
    }
  }

  /** How far this person has got with a title, from their own library. */
  localProgress(card: TitleCard, total: number): ChallengeProgress {
    const title = this.findCard(card);
    if (!title) return { fraction: 0, watched: 0, label: "Not started", finished: false };
    const threshold = this.host.settings.finishThreshold;
    const rows = this.library.progressList(title.id);
    const kind = TitleCard.titleKind(card);

    if (kind === "series" || kind === "cartoon" || rows.some(isEpisode)) {
      const episodes = rows.filter(isEpisode);
      const isDone = (p: TogetherProgress) => p.finished || progressFraction(p) >= threshold;
      const done = episodes.filter(isDone).length;
      const count = Math.max(1, total);
      const newestPartial = latest(episodes.filter((p) => !isDone(p)));
      const partial = newestPartial ? progressFraction(newestPartial) : 0;
      const finished = (total > 0 && done >= total) || title.status === "watched";
      const fraction = finished ? 1 : Math.min(0.999, (done + partial) / count);
      const at = latest(episodes)?.ref;
      let label = `${done} of ${count} episodes`;
      if (finished) label = "Finished";
      else if (at) label += ` · on S${at.season} E${at.episode}`;
      return { fraction, watched: done, label, finished };
    }

    const newest = latest(rows);
    const isFinished =
      title.status === "watched" || newest?.finished === true || (newest ? progressFraction(newest) : 0) >= threshold;
    const part = isFinished ? 1 : newest ? progressFraction(newest) : 0;
    const text = isFinished ? "Finished" : part > 0 ? `${Math.trunc(part * 100)}% in` : "Not started";
    return { fraction: part, watched: isFinished ? 1 : 0, label: text, finished: isFinished };
  }
}

/** The newest by `updatedAt`; the first of equals, like Swift's `max(by:)`. */
function latest(rows: readonly TogetherProgress[]): TogetherProgress | undefined {
  let best: TogetherProgress | undefined;
  for (const row of rows) if (!best || row.updatedAt > best.updatedAt) best = row;
  return best;
}

const TRACKING = ["utm_", "fbclid", "gclid", "ref", "ref_", "yclid", "mc_", "_ga"];

/**
 * A stand-in for core/data's `UrlKey.make` when none is given: host without `www.` and lower-cased, the
 * path, and the query without tracking parameters, sorted. Fragments are dropped except an episode
 * marker (`s:1-e:2`).
 */
export function simpleUrlKey(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "") + (url.port ? ":" + url.port : "");
  const items = [...url.searchParams.entries()]
    .filter(([name]) => !TRACKING.some((prefix) => name.toLowerCase().startsWith(prefix)))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = items.length ? "?" + items.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&") : "";
  let hash = url.hash;
  try {
    hash = decodeURIComponent(hash);
  } catch {
    // Kept as written.
  }
  const fragment = /s:\d+-e:\d+/.exec(hash)?.[0];
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname === "/" ? "" : url.pathname;
  return host + path + query + (fragment ? "#" + fragment : "");
}
