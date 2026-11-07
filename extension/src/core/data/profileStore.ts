// Port of Cineon/App/ProfileStore.swift via windows/Cineon.Core/Data/ProfileStore.cs. The list of
// people is kept in extension storage (chrome.storage.local, or anything with get/set) under
// "profiles.json", in the shape of the apps' profiles.json:
// {"profiles":[{"id":"UUID","name":"…","createdAt":<seconds since 2001>,"lastPosterURL":"…"}],
//  "lastUsedID":"UUID","askOnLaunch":false}, absent optionals left out.

import { Database } from "./database";
import { StoredDate, type UnixTime } from "./dates";
import { Emitter } from "./emitter";

export interface Profile {
  /** A UUID in upper case, as the apps write it. */
  readonly id: string;
  readonly name: string;
  readonly createdAt: UnixTime;
  /** The last poster this person watched. Their avatar on the picker, so it's always current. */
  readonly lastPosterUrl: string | null;
}

/** Where the list is kept. chrome.storage.local fits, so does `MemoryStorage`. */
export interface KeyValueStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

/** Storage in memory, for tests. */
export class MemoryStorage implements KeyValueStorage {
  readonly values = new Map<string, unknown>();

  async get(key: string): Promise<unknown> {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
}

/** An extension storage area (chrome.storage.local by default) as `KeyValueStorage`. */
export function chromeStorage(area?: chrome.storage.StorageArea): KeyValueStorage {
  const storage = () => area ?? globalThis.chrome.storage.local;
  return {
    async get(key) {
      const items = await storage().get(key);
      return (items as Record<string, unknown>)[key];
    },
    async set(key, value) {
      await storage().set({ [key]: value });
    },
  };
}

/** What profiles.json holds. */
export interface StoredProfiles {
  profiles: Profile[];
  lastUsedId: string | null;
  askOnLaunch: boolean;
}

export type ProfileStoreKey = "profiles" | "lastUsedId" | "askOnLaunch";

export interface ProfileStoreOptions {
  storage: KeyValueStorage;
  /** The first person's name when there's no list yet. The Mac uses the account's first name. */
  defaultName?: string;
  /** Removes everything a person did; their database by default. */
  deleteProfileData?: (id: string) => Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value.toUpperCase() : null;
}

function newUuid(): string {
  return globalThis.crypto.randomUUID().toUpperCase();
}

/** Mac-written createdAt values (seconds since 2001), so writing back never moves them by a bit. */
const originalCreatedAt = new WeakMap<Profile, number>();

function capitalised(name: string): string {
  if (name.length === 0) return name;
  const first = String.fromCodePoint(name.codePointAt(0)!);
  return first.toUpperCase() + name.slice(first.length);
}

/** The list of people using this browser. Everything else about a profile lives in its own database. */
export class ProfileStore {
  /** The storage key, after the apps' file. */
  static readonly storageKey = "profiles.json";

  private _profiles: readonly Profile[] = [];
  private _lastUsedId: string | null = null;
  private _askOnLaunch = false;

  /** Fires after anything in the store changed, naming what. */
  readonly changed = new Emitter<readonly ProfileStoreKey[]>();

  private constructor(private readonly options: ProfileStoreOptions) {}

  /** Reads the list, or starts one with a single person when there's none (or it can't be read). */
  static async open(options: ProfileStoreOptions): Promise<ProfileStore> {
    const store = new ProfileStore(options);
    await store.load();
    return store;
  }

  get profiles(): readonly Profile[] {
    return this._profiles;
  }

  get lastUsedId(): string | null {
    return this._lastUsedId;
  }

  get askOnLaunch(): boolean {
    return this._askOnLaunch;
  }

  get lastUsed(): Profile {
    return this._profiles.find((p) => p.id === this._lastUsedId) ?? this._profiles[0]!;
  }

  /** The person's IndexedDB database name. */
  databaseName(id: string): string {
    return Database.nameFor(id);
  }

  /** Reads the list again, for when another page changed it. */
  async reload(): Promise<void> {
    await this.load();
    this.changed.emit(["profiles", "lastUsedId", "askOnLaunch"]);
  }

  private async load(): Promise<void> {
    let stored: StoredProfiles | null = null;
    try {
      stored = ProfileStore.decode(await this.options.storage.get(ProfileStore.storageKey));
    } catch {
      stored = null;
    }
    if (stored && stored.profiles.length > 0) {
      this._profiles = stored.profiles;
      this._lastUsedId = stored.lastUsedId;
      this._askOnLaunch = stored.askOnLaunch;
      return;
    }
    const accountName = (this.options.defaultName ?? "").split(" ").find((part) => part.length > 0) ?? "Me";
    const first: Profile = { id: newUuid(), name: capitalised(accountName), createdAt: StoredDate.now(), lastPosterUrl: null };
    this._profiles = [first];
    this._lastUsedId = first.id;
    this._askOnLaunch = false;
    await this.save();
  }

  async setAskOnLaunch(value: boolean): Promise<void> {
    this._askOnLaunch = value;
    await this.save();
    this.changed.emit(["askOnLaunch"]);
  }

  async markUsed(id: string): Promise<void> {
    this._lastUsedId = id.toUpperCase();
    await this.save();
    this.changed.emit(["lastUsedId"]);
  }

  async add(name: string): Promise<Profile> {
    const profile: Profile = { id: newUuid(), name, createdAt: StoredDate.now(), lastPosterUrl: null };
    this._profiles = [...this._profiles, profile];
    // More than one person now, so ask who's watching next time.
    if (this._profiles.length === 2) this._askOnLaunch = true;
    await this.save();
    this.changed.emit(["profiles", "askOnLaunch"]);
    return profile;
  }

  async rename(id: string, name: string): Promise<void> {
    if (!this.replace(id, (p) => ({ ...p, name }))) return;
    await this.save();
    this.changed.emit(["profiles"]);
  }

  async setPoster(id: string, url: string | null): Promise<void> {
    const current = this._profiles.find((p) => p.id === id.toUpperCase());
    if (!current || current.lastPosterUrl === url) return;
    this.replace(id, (p) => ({ ...p, lastPosterUrl: url }));
    await this.save();
    this.changed.emit(["profiles"]);
  }

  /** Removes the person and everything they did. Never the last one. */
  async delete(id: string): Promise<void> {
    if (this._profiles.length <= 1) return;
    const key = id.toUpperCase();
    this._profiles = this._profiles.filter((p) => p.id !== key);
    if (this._lastUsedId === key) this._lastUsedId = this._profiles[0]?.id ?? null;
    try {
      await (this.options.deleteProfileData ?? ((who: string) => Database.delete(Database.nameFor(who))))(key);
    } catch {
      // As the apps: the person is gone from the list even if their data couldn't be removed.
    }
    await this.save();
    this.changed.emit(["profiles", "lastUsedId"]);
  }

  private replace(id: string, change: (p: Profile) => Profile): boolean {
    const key = id.toUpperCase();
    const position = this._profiles.findIndex((p) => p.id === key);
    if (position < 0) return false;
    const old = this._profiles[position]!;
    const updated = change(old);
    const original = originalCreatedAt.get(old);
    if (original !== undefined && updated.createdAt === old.createdAt) originalCreatedAt.set(updated, original);
    this._profiles = this._profiles.map((p, i) => (i === position ? updated : p));
    return true;
  }

  private async save(): Promise<void> {
    try {
      await this.options.storage.set(
        ProfileStore.storageKey,
        ProfileStore.encode(this._profiles, this._lastUsedId, this._askOnLaunch),
      );
    } catch {
      // As Swift's try?.
    }
  }

  // MARK: profiles.json

  /** The object to store, with the apps' keys in the apps' order. */
  static encode(profiles: readonly Profile[], lastUsedId: string | null, askOnLaunch: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = {
      profiles: profiles.map((p) => {
        const original = originalCreatedAt.get(p);
        const entry: Record<string, unknown> = {
          id: p.id.toUpperCase(),
          name: p.name,
          createdAt:
            original !== undefined && StoredDate.fromReference(original) === p.createdAt
              ? original
              : StoredDate.toReference(p.createdAt),
        };
        if (p.lastPosterUrl != null) entry.lastPosterURL = p.lastPosterUrl;
        return entry;
      }),
    };
    if (lastUsedId != null) out.lastUsedID = lastUsedId.toUpperCase();
    out.askOnLaunch = askOnLaunch;
    return out;
  }

  /** profiles.json's text. */
  static encodeJson(profiles: readonly Profile[], lastUsedId: string | null, askOnLaunch: boolean): string {
    return JSON.stringify(ProfileStore.encode(profiles, lastUsedId, askOnLaunch));
  }

  /**
   * Strict, like Swift's synthesised `Decodable`: `profiles` and `askOnLaunch` are required, and one
   * bad profile fails the whole list. Takes the stored object or profiles.json's text.
   */
  static decode(value: unknown): StoredProfiles | null {
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        return null;
      }
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const root = value as Record<string, unknown>;
    if (!Array.isArray(root.profiles)) return null;
    if (typeof root.askOnLaunch !== "boolean") return null;
    let lastUsedId: string | null = null;
    if (root.lastUsedID != null) {
      lastUsedId = uuid(root.lastUsedID);
      if (lastUsedId == null) return null;
    }
    const profiles: Profile[] = [];
    for (const item of root.profiles as unknown[]) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
      const entry = item as Record<string, unknown>;
      const id = uuid(entry.id);
      if (id == null) return null;
      if (typeof entry.name !== "string") return null;
      if (typeof entry.createdAt !== "number" || !Number.isFinite(entry.createdAt)) return null;
      let poster: string | null = null;
      if (entry.lastPosterURL != null) {
        if (typeof entry.lastPosterURL !== "string" || entry.lastPosterURL.length === 0) return null;
        poster = entry.lastPosterURL;
      }
      const profile: Profile = {
        id,
        name: entry.name,
        createdAt: StoredDate.fromReference(entry.createdAt),
        lastPosterUrl: poster,
      };
      originalCreatedAt.set(profile, entry.createdAt);
      profiles.push(profile);
    }
    return { profiles, lastUsedId, askOnLaunch: root.askOnLaunch };
  }
}
