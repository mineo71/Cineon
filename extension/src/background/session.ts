// Port of App/ProfileSession.swift: everything that belongs to the person watching, in the service
// worker. Opened on the first event after the worker wakes (the library comes back from IndexedDB,
// the tabs from chrome.storage.session), closed when the person changes. Keeps in step with the
// pages over the BroadcastChannel: posts `library` after its own writes and reloads on theirs.

import {
  AppSettings,
  Database,
  type DownloadItem,
  type KeyValueStorage,
  LibraryStore,
  type LibraryStoreKey,
  type Profile,
  ProfileStore,
  type Title,
} from "../core/data";
import {
  type BrowserDownloads,
  DownloadCenter,
  type HeaderRules,
  type ObjectUrls,
  SeasonGrabber,
  type StreamWorker,
} from "../core/downloads";
import { MetadataService } from "../core/metadata";
import { PetTraits, PixelPet, ProfileStats } from "../core/profile";
import type { CosmeticIndex, CounterCheckpoint, CounterMode, DnrApi, ShieldState } from "../core/shields";
import { CloudLibrary, type TogetherClient, TogetherModel } from "../core/together";
import { UrlKey } from "../core/data";
import { RELOAD_KEYS, type Signal, type SignalInput } from "../shared/messages";
import { EpisodeAlerts } from "./alerts";
import { EpisodeAutopilot } from "./autopilot";
import { Browser } from "./browser";
import type { Notifier, SessionContext, SiteProber, ToastAction, Toasts } from "./context";
import { TabEpisodeResolver } from "./downloadsBridge";
import { type Clock, detach, isWebUrl } from "./env";
import { FrameCollector } from "./frames";
import type { Platform } from "./platform";
import { Playback, type PowerApi } from "./playback";
import { FetchSiteProbe, RescueEngine } from "./rescue";
import { SessionShields } from "./shieldsBridge";
import { downloadsSnapshot, tabSnapshot, togetherSnapshot } from "./snapshots";
import type { TabState } from "./tabState";
import type { TabRegistry } from "./tabs";
import { BackgroundTogetherHost, partyTabId, storageIdentityStore, TabPartyPlayer } from "./togetherBridge";
import { WatchTracker } from "./tracker";

/** The Cineon pages, as the background reaches them. */
export interface PageHub {
  /** A signal on the BroadcastChannel. */
  post(signal: SignalInput): void;
  /** Is a Cineon page, the side panel or the popup open? */
  hasOpenPage(): Promise<boolean>;
  /** Opens (or focuses) the Cineon page at a route such as `together` or `library?title=12`. */
  openCineon(route: string | null): Promise<void>;
}

export interface DownloadServices {
  readonly browser: BrowserDownloads;
  readonly headers: HeaderRules;
  readonly streams: StreamWorker;
  readonly objectUrls?: ObjectUrls;
  /** Fetch direct files as streams are (Chrome: its downloads can't carry the page's Referer). See DownloadCenterOptions. */
  readonly fetchFiles?: boolean;
  /** chrome.downloads.open; false when the browser refused. */
  open(downloadId: number): Promise<boolean>;
  /** chrome.downloads.show. */
  show(downloadId: number): Promise<boolean>;
}

/** Keeps the worker running for a named reason (keepAlive.ts). */
export interface WorkerHold {
  hold(reason: string): void;
  release(reason: string): void;
}

export interface SessionServices {
  readonly clock: Clock;
  readonly registry: TabRegistry;
  readonly platform: Platform;
  readonly pages: PageHub;
  readonly notifier: Notifier;
  /** chrome.storage.local. */
  readonly local: KeyValueStorage;
  /** chrome.storage.session (null in tests). */
  readonly session: KeyValueStorage | null;
  readonly dnr: DnrApi | null;
  readonly cosmetic: () => Promise<CosmeticIndex | null>;
  readonly counterMode: CounterMode;
  readonly counterCheckpoint: CounterCheckpoint | null;
  readonly downloads: DownloadServices | null;
  readonly togetherClient: () => Promise<TogetherClient | null>;
  readonly probe?: SiteProber;
  readonly power: PowerApi | null;
  readonly copyText: (text: string) => void;
  readonly hold: WorkerHold;
  /** Every frame's content script needs telling (the overlay sweeper switch). */
  readonly configChanged: () => void;
  /** A page asked to switch person over the channel. */
  readonly switchProfile: (profileId: string) => void;
  readonly factory?: IDBFactory;
  /** Run catalogue lookups (off in tests). */
  readonly metadata?: boolean;
  /** Show system notifications for new episodes. */
  readonly systemNotifications?: boolean;
}

/** The library as core/metadata's MetadataService reads and writes it. */
function metadataLibrary(library: LibraryStore) {
  return {
    title: (id: number) => library.titles.get(id),
    titles: () => library.titles.values(),
    update: (title: Title) => library.update(title),
    merge: (from: number, into: number) => library.merge(from, into),
    latestProgressUrl: (id: number) => library.latestProgress(id)?.url ?? null,
  };
}

/** ProfileStats over a library store (the same mapping as the pages', so the pet is the same). */
export function computeStats(library: LibraryStore, extras: { adsBlocked?: number; downloads?: number } = {}): ProfileStats {
  const titles = [...library.titles.values()].map((t) => ({
    id: t.id,
    name: t.name,
    posterUrl: t.posterUrl,
    year: t.year,
    isSeries: t.kind === "series",
    status: t.status,
    genres: t.genres,
    runtimeMinutes: t.runtimeMinutes,
    ratingHalves: t.ratingHalves,
    lastWatchedAt: t.lastWatchedAt == null ? null : new Date(t.lastWatchedAt * 1000),
  }));
  const sessions = library.sessions.map((s) => ({
    titleId: s.titleId,
    startedAt: new Date(s.startedAt * 1000),
    endedAt: new Date(s.endedAt * 1000),
    watchedSeconds: s.watchedSeconds,
  }));
  const progress = library.progress.map((p) => ({ titleId: p.titleId, isEpisode: p.ref.season > 0 || p.ref.episode > 0, finished: p.finished }));
  let moments = 0;
  for (const list of library.momentsByTitle.values()) moments += list.length;
  return ProfileStats.compute(titles, sessions, progress, { moments, adsBlocked: extras.adsBlocked ?? 0, downloads: extras.downloads ?? 0 });
}

/** The Mac's ToastCenter, routed: over the tab's player, else to the pages, else a notification. */
class ToastCenter implements Toasts {
  current: string | null = null;
  private counter = 0;

  constructor(
    private readonly session: ProfileSession,
    private readonly services: SessionServices,
  ) {}

  show(text: string, options: { action?: ToastAction | null; tab?: TabState | null; pageOnly?: boolean } = {}): void {
    this.current = text;
    const tab = options.tab ?? null;
    const action = options.action ?? null;
    const browser = this.session.browser;
    if (tab && isWebUrl(tab.url) && !tab.failure && !tab.isHelper && !tab.isProbe && !browser.hasImportantBanner(tab)) {
      browser.showToastBanner(tab, text, action);
      return;
    }
    this.services.pages.post({ type: "toast", text });
    if (options.pageOnly) return;
    const id = `toast-${++this.counter}`;
    void this.services.pages.hasOpenPage().then((open) => {
      if (open) return;
      this.services.notifier.show(id, {
        title: "Cineon",
        message: text,
        buttons: action ? [action.title] : [],
        onClick: (button) => {
          if (button === 0) action?.run();
        },
      });
    });
  }
}

const STARTED_KEY = "cineon.started";
const CLOUD_SYNC_KEY = "cineon.cloudSyncedAt";
/** The Together model's background work stops this long after the last page asked about it. */
const TOGETHER_IDLE_MS = 2 * 60_000;

export class ProfileSession implements SessionContext {
  readonly clock: Clock;
  readonly toasts: Toasts;
  readonly metadata: MetadataService<Title>;
  readonly probe: SiteProber;
  readonly notifier: Notifier;
  readonly browser: Browser;
  readonly tracker: WatchTracker;
  readonly autopilot: EpisodeAutopilot;
  readonly rescue: RescueEngine;
  readonly frames: FrameCollector;
  readonly playback: Playback;
  readonly alerts: EpisodeAlerts;
  readonly resolver: TabEpisodeResolver;
  readonly partyPlayer: TabPartyPlayer;
  downloads: DownloadCenter | null = null;
  seasons: SeasonGrabber | null = null;
  together: TogetherModel<Title> | null = null;
  cloud: CloudLibrary<Title> | null = null;
  private _settings: AppSettings;
  private closed = false;
  private reloadsInFlight = 0;
  private reloadTimer: (() => void) | null = null;
  private readonly unsubscribers: (() => void)[] = [];
  private statsCache: { key: string; stats: ProfileStats; pet: PixelPet } | null = null;
  private togetherStarted = false;
  private togetherIdle: (() => void) | null = null;
  private downloadsTimer: (() => void) | null = null;
  private posterTimer: (() => void) | null = null;

  private constructor(
    readonly profiles: ProfileStore,
    readonly profile: Profile,
    readonly db: Database,
    readonly library: LibraryStore,
    settings: AppSettings,
    readonly shieldsCtl: SessionShields,
    private readonly services: SessionServices,
  ) {
    this._settings = settings;
    this.clock = services.clock;
    this.notifier = services.notifier;
    this.probe = services.probe ?? new FetchSiteProbe();
    this.toasts = new ToastCenter(this, services);
    this.metadata = new MetadataService<Title>({
      library: metadataLibrary(library),
      enabled: () => (services.metadata ?? true) && this._settings.fetchMetadata,
    });
    // The Mac's order: tracker, autopilot, rescue, frames, then the browser around them.
    this.browser = new Browser(this, services.registry, services.platform);
    this.tracker = new WatchTracker(this);
    this.autopilot = new EpisodeAutopilot(this);
    this.rescue = new RescueEngine(this, services.platform);
    this.frames = new FrameCollector(this, services.platform);
    this.playback = new Playback({
      ctx: this,
      storage: services.session,
      power: services.power,
      publish: () => this.publishPlayer(),
      keepAwake: (on) => (on ? services.hold.hold("playback") : services.hold.release("playback")),
      ambient: () => this.frames.ambientTick(),
    });
    this.alerts = new EpisodeAlerts({
      ctx: this,
      openTitle: (id) => void services.pages.openCineon(`library?title=${id}`),
      systemNotifications: services.systemNotifications ?? true,
    });
    this.resolver = new TabEpisodeResolver(this, services.platform);
    this.partyPlayer = new TabPartyPlayer(this);
  }

  get settings(): AppSettings {
    return this._settings;
  }

  get shields(): ShieldState {
    return this.shieldsCtl.state;
  }

  /** Opens `profileId`, or the last person who watched, and starts it. */
  static async open(profileId: string | null, services: SessionServices): Promise<ProfileSession> {
    const profiles = await ProfileStore.open({
      storage: services.local,
      deleteProfileData: (id) => Database.delete(Database.nameFor(id), services.factory),
    });
    const profile = profiles.profiles.find((p) => p.id === profileId) ?? profiles.lastUsed;
    const db = await Database.open(Database.nameFor(profile.id), services.factory);
    const library = await LibraryStore.open(db);
    await library.seedDefaultSitesIfNeeded();
    const settings = await db.loadSettings();
    let session: ProfileSession | null = null;
    const shields = await SessionShields.open(db, {
      dnr: services.dnr,
      cosmetic: services.cosmetic,
      counterMode: services.counterMode,
      checkpoint: services.counterCheckpoint,
      onBlocked: (tabId) => session?.noteBlocked(tabId),
    });
    session = new ProfileSession(profiles, profile, db, library, settings, shields, services);
    await session.start();
    return session;
  }

  // MARK: Starting and closing

  private async start(): Promise<void> {
    const services = this.services;
    this.unsubscribers.push(this.library.changed.on((keys) => this.libraryChanged(keys)));
    this.unsubscribers.push(this.services.registry.changed.on((id) => this.tabChanged(id)));

    await this.shieldsCtl.apply(this._settings);
    this.shieldsCtl.start();
    await this.playback.restore();
    await this.alerts.load();

    // Downloads, then seasons, as the Mac builds them.
    if (services.downloads) {
      try {
        this.downloads = await DownloadCenter.open({
          db: this.db,
          library: this.library,
          host: this.downloadHost(),
          downloads: services.downloads.browser,
          headers: services.downloads.headers,
          streams: services.downloads.streams,
          storage: services.local,
          session: services.session ?? undefined,
          objectUrls: services.downloads.objectUrls,
          fetchFiles: services.downloads.fetchFiles,
        });
        this.seasons = await SeasonGrabber.open({ downloads: this.downloads, host: this.downloadHost(), resolver: this.resolver, storage: services.local });
        this.unsubscribers.push(this.downloads.changed.on(() => this.downloadsChanged()));
        this.unsubscribers.push(this.seasons.changed.on(() => this.downloadsChanged()));
        this.downloadsChanged();
      } catch (error) {
        console.warn("Cineon: the download center couldn't open", error);
      }
    }

    // Together, then the cloud backup (ProfileSession.swift's order).
    try {
      this.together = await TogetherModel.create<Title>({
        profile: { name: this.profile.name },
        library: this.library,
        host: new BackgroundTogetherHost({
          ctx: this,
          petCode: () => this.statsAndPet().pet.code,
          openPage: (route) => void services.pages.openCineon(route),
          copyText: services.copyText,
          model: () => this.together,
        }),
        player: this.partyPlayer,
        client: await services.togetherClient(),
        identityStore: storageIdentityStore(services.local, this.profile.id),
        clock: this.clock,
        urlKey: (url) => UrlKey.make(url),
      });
      this.unsubscribers.push(this.together.subscribe((property) => this.togetherChanged(property)));
      this.cloud = new CloudLibrary<Title>({ library: this.library, together: this.together, settings: () => this._settings, clock: this.clock });
      this.unsubscribers.push(this.cloud.subscribe((property) => this.cloudChanged(property)));
    } catch (error) {
      console.warn("Cineon: Together couldn't start", error);
    }

    const firstStart = await this.firstStartInBrowserSession();
    if (firstStart) {
      // Once per browser session, not on every wake: titles added offline get their posters, frames
      // past the budget go, and Together looks at its shares and challenges.
      this.retryMissingMetadata();
      detach(this.library.pruneFrames());
      this.startTogether();
    }
    await this.startCloud();
  }

  /** True the first time this profile opens since the browser started. */
  private async firstStartInBrowserSession(): Promise<boolean> {
    const store = this.services.session;
    if (!store) return true;
    const started = ((await store.get(STARTED_KEY).catch(() => null)) as string[] | null) ?? [];
    if (started.includes(this.profile.id)) return false;
    await store.set(STARTED_KEY, [...started, this.profile.id]).catch(() => undefined);
    return true;
  }

  /** The backup syncs 3 s after starting; a worker waking every few minutes mustn't sync each time. */
  private async startCloud(): Promise<void> {
    const cloud = this.cloud;
    if (!cloud) return;
    const last = (await this.services.session?.get(`${CLOUD_SYNC_KEY}:${this.profile.id}`).catch(() => null)) as number | null | undefined;
    if (last == null || this.clock.now() - last > 10 * 60_000) {
      cloud.start();
    } else {
      // What start() does apart from its timers: personal changes still reach the cloud.
      this.library.onPersonalChange = (title) => cloud.noteChange(title);
    }
  }

  /** The 10-minute alarm. */
  syncCloud(): void {
    if (this.cloud && this._settings.cloudBackup) this.cloud.syncNow();
  }

  /** Together's challenge loop and shares run while a page looks at them, or a party is on. */
  startTogether(): void {
    const model = this.together;
    if (!model) return;
    if (!this.togetherStarted) {
      this.togetherStarted = true;
      model.start();
    }
    this.togetherIdle?.();
    this.togetherIdle = this.clock.schedule(TOGETHER_IDLE_MS, () => {
      this.togetherIdle = null;
      if (!this.together || this.together.party) return;
      this.togetherStarted = false;
      this.together.stop();
    });
  }

  private retryMissingMetadata(): void {
    if (!this._settings.fetchMetadata) return;
    for (const title of this.library.titles.values()) {
      if (!title.metadataChecked && title.imdbId == null) this.metadata.enrich(title.id, null, true);
    }
  }

  /** The person changes or the extension goes: save, stop, and let go of the database. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.seasons?.suspend();
    this.alerts.stop();
    this.cloud?.stop();
    this.together?.stop();
    this.downloads?.suspendAll();
    this.downloads?.detach();
    this.playback.stop();
    this.shieldsCtl.stop();
    for (const tab of this.browser.registry.all()) {
      this.rescue.stop(tab);
      this.rescue.forget(tab.id);
      await this.tracker.tabNavigated(tab).catch(() => undefined);
    }
    await this.profiles.setPoster(this.profile.id, this.latestPosterUrl).catch(() => undefined);
    this.togetherIdle?.();
    this.playerTimer?.();
    this.reloadTimer?.();
    this.downloadsTimer?.();
    this.posterTimer?.();
    for (const off of this.unsubscribers) off();
    this.library.onPersonalChange = null;
    this.db.close();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // MARK: Signals

  private libraryChanged(keys: readonly LibraryStoreKey[]): void {
    const isReload = keys.length === RELOAD_KEYS.length && keys.includes("revision") && keys.includes("sites");
    if (isReload && this.reloadsInFlight > 0) {
      this.reloadsInFlight--;
    } else if (!this.closed) {
      this.services.pages.post({ type: "library", profileId: this.profile.id, keys: [...keys] });
    }
    this.statsCache = null;
    if (!this.posterTimer && !this.closed) {
      this.posterTimer = this.clock.schedule(5000, () => {
        this.posterTimer = null;
        if (!this.closed) detach(this.profiles.setPoster(this.profile.id, this.latestPosterUrl));
      });
    }
  }

  /** What another context posted. */
  heard(signal: Signal): void {
    if (this.closed) return;
    switch (signal.type) {
      case "library":
        if (signal.profileId === this.profile.id) this.scheduleReload();
        break;
      case "settings":
        if (signal.profileId === this.profile.id) detach(this.reloadSettings());
        break;
      case "profiles":
        detach(this.profiles.reload());
        break;
      case "profile":
        if (signal.profileId !== this.profile.id) this.services.switchProfile(signal.profileId);
        break;
      case "sitePrefs":
        if (signal.profileId === this.profile.id) detach(this.shieldsCtl.reload(this.db));
        break;
      default:
        break;
    }
  }

  /** Several signals in a row make one reload. */
  private scheduleReload(): void {
    if (this.reloadTimer) return;
    this.reloadTimer = this.clock.schedule(40, () => {
      this.reloadTimer = null;
      this.reloadsInFlight++;
      detach(this.library.reload());
    });
  }

  private async reloadSettings(): Promise<void> {
    const next = await this.db.loadSettings();
    this.applySettings(next);
  }

  /** Changes settings from the background (debug, menus), saves them and tells the pages. */
  async updateSettings(change: Partial<AppSettings>): Promise<void> {
    const next = AppSettings.make({ ...this._settings, ...change });
    this.applySettings(next);
    await this.db.saveSettings(next);
    this.services.pages.post({ type: "settings", profileId: this.profile.id });
  }

  /** ProfileSession.settings didSet: what each change sets in motion. */
  private applySettings(next: AppSettings): void {
    const old = this._settings;
    if (AppSettings.equals(old, next)) return;
    this._settings = next;
    if (old.overlaySweeper !== next.overlaySweeper) this.services.configChanged();
    if (old.networkBlocking !== next.networkBlocking || !sameSet(old.enabledLists, next.enabledLists)) {
      detach(this.shieldsCtl.apply(next));
    }
    if (old.showDownloadButton !== next.showDownloadButton) this.browser.refreshAllPills(true);
    if (old.voiceBoost !== next.voiceBoost) for (const tab of this.browser.tabs) this.browser.applyVoiceBoost(tab);
    if (old.sharePet !== next.sharePet) detach(this.together?.refreshIdentity());
    if (old.cloudBackup !== next.cloudBackup && next.cloudBackup) this.cloud?.start();
    if (old.captionStyle !== next.captionStyle) for (const tab of this.browser.tabs) this.browser.applyCaptions(tab, true);
    if (old.ambientLight !== next.ambientLight && !next.ambientLight) {
      for (const tab of this.browser.tabs) this.browser.setAmbient(tab, false);
    }
    if (!old.newEpisodeAlerts && next.newEpisodeAlerts) detach(this.alerts.checkIfDue());
  }

  private lastPlayer = "";
  private lastPlayerAt = 0;
  private playerTimer: (() => void) | null = null;

  /** The `player` signal: at most once a second, only when something changed, never losing the last change. */
  publishPlayer(force = false): void {
    if (this.closed) return;
    const tab = this.playback.activeTab();
    const snapshot = tab ? tabSnapshot(tab, this.browser, this.shieldsCtl) : null;
    const text = JSON.stringify(snapshot);
    if (!force && text === this.lastPlayer) return;
    const wait = 1000 - (this.clock.now() - this.lastPlayerAt);
    if (!force && wait > 0) {
      this.playerTimer ??= this.clock.schedule(wait, () => {
        this.playerTimer = null;
        this.publishPlayer();
      });
      return;
    }
    this.playerTimer?.();
    this.playerTimer = null;
    this.lastPlayer = text;
    this.lastPlayerAt = this.clock.now();
    this.services.pages.post({ type: "player", player: snapshot });
  }

  private tabChanged(_id: number): void {
    this.playback.updateTicking();
    this.publishPlayer();
  }

  /** A few times a second at most. */
  private downloadsChanged(): void {
    const active = (this.downloads?.activeCount ?? 0) > 0 || (this.seasons?.isBusy ?? false);
    if (active) this.services.hold.hold("downloads");
    else this.services.hold.release("downloads");
    if (this.downloadsTimer) return;
    this.downloadsTimer = this.clock.schedule(250, () => {
      this.downloadsTimer = null;
      if (this.closed) return;
      this.services.pages.post({ type: "downloads", state: downloadsSnapshot(this.downloads, this.seasons) });
    });
  }

  private togetherChanged(property: string): void {
    if (property === "party") {
      if (this.together?.party) this.services.hold.hold("party");
      else this.services.hold.release("party");
    }
    this.publishTogether();
  }

  private cloudChanged(property: string): void {
    if (property === "lastSync" && this.cloud?.lastSync != null) {
      detach(this.services.session?.set(`${CLOUD_SYNC_KEY}:${this.profile.id}`, this.cloud.lastSync));
    }
    this.publishTogether();
  }

  publishTogether(): void {
    if (this.closed) return;
    this.services.pages.post({ type: "together", state: this.togetherState() });
  }

  togetherState() {
    return togetherSnapshot(this.together, this.cloud, partyTabId(this.together), this.profile.name);
  }

  // MARK: The download center's host

  private downloadHost() {
    return {
      showToast: (message: string, actionTitle?: string, action?: () => void) =>
        this.toasts.show(message, { action: actionTitle && action ? { title: actionTitle, run: action } : null }),
      playDownload: (item: DownloadItem) => void this.playDownload(item),
      refreshDownloadPills: () => this.browser.refreshAllPills(),
      enrichTitle: (titleId: number, altName: string | null) => this.metadata.enrich(titleId, altName),
    };
  }

  /**
   * Plays a finished download. There's no player of Cineon's own in the extension: the browser
   * opens the file with the computer's player (chrome.downloads.open), else shows it in its folder.
   */
  async playDownload(item: DownloadItem): Promise<void> {
    await this.playDownloadMessage(item);
  }

  async playDownloadMessage(item: DownloadItem): Promise<string | null> {
    const downloads = this.downloads;
    const services = this.services.downloads;
    if (!downloads || !services) return "Downloads aren't available here";
    if (item.status !== "done") {
      void this.services.pages.openCineon("downloads");
      return null;
    }
    const id = downloads.browserDownloadId(item.id);
    if (id == null) return `${item.name} isn't in your downloads anymore`;
    if (await services.open(id)) return null;
    if (await services.show(id)) return "The browser didn't open it, so here it is in your downloads folder";
    return `${item.name} isn't in your downloads anymore`;
  }

  // MARK: Profile

  /** The numbers on the profile page and the pet, worked out again when the library changes. */
  statsAndPet(): { stats: ProfileStats; pet: PixelPet } {
    const key = `${this.library.revision}|${this.library.titles.size}|${this.downloads?.items.length ?? 0}`;
    if (this.statsCache && this.statsCache.key === key) return this.statsCache;
    const stats = computeStats(this.library, {
      adsBlocked: this.shields.total.ads,
      downloads: (this.downloads?.items ?? []).filter((i) => i.status === "done").length,
    });
    const pet = PixelPet.make(stats.petTraits(PetTraits.seedFor(this.profile.id)));
    this.statsCache = { key, stats, pet };
    return this.statsCache;
  }

  /** The poster to show on this person's avatar. */
  get latestPosterUrl(): string | null {
    return (
      this.library.continueWatching[0]?.title.posterUrl ?? this.library.watched[0]?.posterUrl ?? this.library.backlog[0]?.posterUrl ?? null
    );
  }

  /** A request was blocked in a tab (the shield counter). */
  noteBlocked(tabId: number): void {
    const tab = this.browser.tab(tabId);
    if (!tab) return;
    tab.blocked = { ...tab.blocked, ads: tab.blocked.ads + 1 };
    this.browser.registry.scheduleSave();
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}
