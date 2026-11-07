// One person's open profile in a page: the Mac's ProfileSession, the parts a page needs. Opens the
// profile's IndexedDB database and LibraryStore, loads its settings and runs metadata lookups for
// what the page adds. Keeps in step with every other context over the BroadcastChannel: posts a
// `library` signal after its own writes and reloads on anyone else's.

import {
  AppSettings,
  Database,
  type KeyValueStorage,
  LibraryStore,
  type LibraryStoreKey,
  type Profile,
  ProfileStore,
  type Title,
  chromeStorage,
} from "../../core/data";
import { MetadataService } from "../../core/metadata";
import { PetTraits, PixelPet, ProfileStats } from "../../core/profile";
import { RELOAD_KEYS, type Signal, SignalChannel } from "../../shared/messages";

/** chrome.storage.local in the extension; localStorage when a page is opened on its own (development). */
export function pageStorage(): KeyValueStorage {
  const chromeApi = (globalThis as { chrome?: typeof chrome }).chrome;
  if (chromeApi?.storage?.local) return chromeStorage();
  return {
    async get(key) {
      const text = globalThis.localStorage?.getItem(`cineon:${key}`);
      return text == null ? undefined : JSON.parse(text);
    },
    async set(key, value) {
      globalThis.localStorage?.setItem(`cineon:${key}`, JSON.stringify(value));
    },
  };
}

/** Small key-value preferences of the UI itself (`@AppStorage`), per browser. */
export const UiDefaults = {
  get(key: string): string | null {
    try {
      return globalThis.localStorage?.getItem(`cineon.ui.${key}`) ?? null;
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      globalThis.localStorage?.setItem(`cineon.ui.${key}`, value);
    } catch {
      // Private windows may refuse; the default is fine.
    }
  },
};

export interface SessionOptions {
  storage?: KeyValueStorage;
  channel?: SignalChannel;
  /** IndexedDB factory, for tests. */
  factory?: IDBFactory;
  /** Run metadata lookups (off in tests). */
  metadata?: boolean;
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

export class Session {
  private listeners = new Set<() => void>();
  private reloadsInFlight = 0;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribers: (() => void)[] = [];
  private closed = false;
  /** Bumped on every change a view may show (library, settings, profiles). */
  version = 0;
  readonly metadata: MetadataService<Title>;
  private statsCache: { version: number; stats: ProfileStats; pet: PixelPet } | null = null;

  private constructor(
    readonly profiles: ProfileStore,
    public profile: Profile,
    readonly db: Database,
    readonly library: LibraryStore,
    public settings: AppSettings,
    readonly channel: SignalChannel,
    metadataEnabled: boolean,
  ) {
    this.metadata = new MetadataService<Title>({
      library: metadataLibrary(library),
      enabled: () => metadataEnabled && this.settings.fetchMetadata,
    });
    this.unsubscribers.push(
      library.changed.on((keys) => this.libraryChanged(keys)),
      profiles.changed.on(() => {
        const fresh = profiles.profiles.find((p) => p.id === this.profile.id);
        if (fresh) this.profile = fresh;
        this.bump();
      }),
      channel.on((signal) => this.heard(signal)),
    );
  }

  /** Opens `profileId`, or the last person who watched. */
  static async open(profileId: string | null = null, options: SessionOptions = {}): Promise<Session> {
    const storage = options.storage ?? pageStorage();
    const channel = options.channel ?? new SignalChannel();
    const profiles = await ProfileStore.open({
      storage,
      deleteProfileData: (id) => Database.delete(Database.nameFor(id), options.factory),
    });
    const profile = profiles.profiles.find((p) => p.id === profileId) ?? profiles.lastUsed;
    const db = await Database.open(Database.nameFor(profile.id), options.factory);
    const library = await LibraryStore.open(db);
    await library.seedDefaultSitesIfNeeded();
    const settings = await db.loadSettings();
    return new Session(profiles, profile, db, library, settings, channel, options.metadata ?? true);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private bump(): void {
    this.version++;
    for (const listener of [...this.listeners]) listener();
  }

  private libraryChanged(keys: readonly LibraryStoreKey[]): void {
    const isReload = keys.length === RELOAD_KEYS.length && keys.includes("revision") && keys.includes("sites");
    if (isReload && this.reloadsInFlight > 0) {
      this.reloadsInFlight--;
    } else if (!this.closed) {
      this.channel.post({ type: "library", profileId: this.profile.id, keys: [...keys] });
    }
    this.bump();
  }

  private heard(signal: Signal): void {
    if (this.closed) return;
    switch (signal.type) {
      case "library":
        if (signal.profileId === this.profile.id) this.scheduleReload();
        break;
      case "settings":
        if (signal.profileId === this.profile.id) void this.reloadSettings();
        break;
      case "profiles":
        void this.profiles.reload();
        break;
      default:
        break;
    }
  }

  /** Several signals in a row make one reload. */
  private scheduleReload(): void {
    if (this.reloadTimer) return;
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      this.reloadsInFlight++;
      void this.library.reload();
    }, 40);
  }

  private async reloadSettings(): Promise<void> {
    this.settings = await this.db.loadSettings();
    this.bump();
  }

  /** Changes settings, saves them, and tells everyone else. */
  async updateSettings(change: Partial<AppSettings>): Promise<void> {
    this.settings = AppSettings.make({ ...this.settings, ...change });
    this.bump();
    await this.db.saveSettings(this.settings);
    this.channel.post({ type: "settings", profileId: this.profile.id });
  }

  /** Profile list changes from this page: tell the others. */
  notifyProfiles(): void {
    this.channel.post({ type: "profiles" });
  }

  /** The library's pet and stats, worked out once per change (ProfileSession.stats / .pet). */
  statsAndPet(extras: { adsBlocked?: number; downloads?: number } = {}): { stats: ProfileStats; pet: PixelPet } {
    if (this.statsCache && this.statsCache.version === this.version) return this.statsCache;
    const stats = computeStats(this.library, extras);
    const pet = PixelPet.make(stats.petTraits(PetTraits.seedFor(this.profile.id)));
    this.statsCache = { version: this.version, stats, pet };
    return this.statsCache;
  }

  close(): void {
    this.closed = true;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    for (const off of this.unsubscribers) off();
    this.listeners.clear();
    this.db.close();
  }
}

/** ProfileStats over a library store. */
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
  const progress = library.progress.map((p) => ({
    titleId: p.titleId,
    isEpisode: p.ref.season > 0 || p.ref.episode > 0,
    finished: p.finished,
  }));
  let moments = 0;
  for (const list of library.momentsByTitle.values()) moments += list.length;
  return ProfileStats.compute(titles, sessions, progress, {
    moments,
    adsBlocked: extras.adsBlocked ?? 0,
    downloads: extras.downloads ?? 0,
  });
}
