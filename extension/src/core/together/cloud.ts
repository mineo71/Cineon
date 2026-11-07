// Port of Cineon/App/CloudLibrary.swift, by way of windows/Cineon.Core/Together/CloudLibrary.cs. Same
// keys, same payload for library:put, same merge rules (last write wins, with half a second of slack)
// and batches of 200.

import type { TogetherClient } from "./client";
import { systemClock, Emitter, type Clock } from "./clock";
import { CloudItem } from "./types";
import * as J from "./json";
import {
  titleStatusFromRaw,
  type CloudLibrarySource,
  type RestoreValues,
  type TitleStatus,
  type TogetherTitle,
} from "./library";
import { detach, errorMessage, roundHalfAway, swiftPrefix } from "./text";

/** The setting CloudLibrary reads (a field of core/data's AppSettings). */
export interface CloudSettings {
  readonly cloudBackup: boolean;
}

/** Who the backup belongs to on the server: TogetherModel. */
export interface CloudAuthority {
  readonly isAvailable: boolean;
  /** The server and this profile's secret, registering first if needed. Throws TogetherError. */
  authorized(): Promise<{ client: TogetherClient; secret: string }>;
  /** The model's clock, used when none is given. */
  readonly clock?: Clock;
}

export interface CloudLibraryOptions<T extends TogetherTitle = TogetherTitle> {
  /** The profile's library. `start` takes its `onPersonalChange`. */
  library: CloudLibrarySource<T>;
  /** For the server and this profile's secret. */
  together: CloudAuthority;
  /** The profile's current settings (`cloudBackup` switches all of this). */
  settings: () => CloudSettings;
  /** Defaults to the together model's clock, then the system's. */
  clock?: Clock;
}

export type CloudProperty = "lastSync" | "isSyncing" | "lastError" | "cloudCount";

/** Seconds since 1970 (the data layer's dates) to the server's milliseconds, unrounded. */
function milliseconds(seconds: number): number {
  return seconds * 1000;
}

/**
 * Keeps ratings and lists in the cloud, so they come back after a library is cleared, imported again
 * or opened on another computer. Only the small things travel: a film's name, year and IMDb id, its
 * rating and its list. Watch history stays here.
 */
export class CloudLibrary<T extends TogetherTitle = TogetherTitle> {
  /** The most items `library:put` takes in one call. */
  static readonly BATCH_SIZE = 200;

  private readonly library: CloudLibrarySource<T>;
  private readonly together: CloudAuthority;
  private readonly settings: () => CloudSettings;
  private readonly clock: Clock;
  private readonly emitter = new Emitter<CloudProperty>();

  private _lastSync: number | null = null;
  private _isSyncing = false;
  private _lastError: string | null = null;
  private _cloudCount = 0;

  private readonly pending = new Set<number>();
  private cancelFlush: (() => void) | null = null;
  private stopTimer: (() => void) | null = null;
  private cancelStart: (() => void) | null = null;
  /** The profile closed. Nothing may touch it after this. */
  private isStopped = false;

  constructor(options: CloudLibraryOptions<T>) {
    this.library = options.library;
    this.together = options.together;
    this.settings = options.settings;
    this.clock = options.clock ?? options.together.clock ?? systemClock;
  }

  /** Adds a listener that hears which property changed. Returns a function that removes it. */
  subscribe(listener: (property: CloudProperty) => void): () => void {
    return this.emitter.subscribe(listener);
  }

  /** When the last sync or send finished, in milliseconds since 1970. */
  get lastSync(): number | null {
    return this._lastSync;
  }
  get isSyncing(): boolean {
    return this._isSyncing;
  }
  get lastError(): string | null {
    return this._lastError;
  }
  /** How many titles the cloud held at the last sync. */
  get cloudCount(): number {
    return this._cloudCount;
  }

  private set(property: "lastSync", value: number | null): void;
  private set(property: "isSyncing", value: boolean): void;
  private set(property: "lastError", value: string | null): void;
  private set(property: "cloudCount", value: number): void;
  private set(property: CloudProperty, value: unknown): void {
    const fields = this as unknown as Record<string, unknown>;
    if (fields[`_${property}`] === value) return;
    fields[`_${property}`] = value;
    this.emitter.emit(property);
  }

  private get isOn(): boolean {
    return !this.isStopped && this.settings().cloudBackup && this.together.isAvailable;
  }

  start(): void {
    this.library.onPersonalChange = (title) => this.noteChange(title);
    if (!this.isOn) return;
    this.stopTimer?.();
    this.stopTimer = this.clock.every(10 * 60 * 1000, () => this.syncNow());
    // A moment after launch, so starting up stays quick.
    this.cancelStart?.();
    this.cancelStart = this.clock.schedule(3000, () => detach(this.sync()));
  }

  stop(): void {
    this.isStopped = true;
    this.stopTimer?.();
    this.stopTimer = null;
    this.cancelFlush?.();
    this.cancelStart?.();
  }

  syncNow(): void {
    detach(this.sync());
  }

  /** Something was rated or filed. Sent a couple of seconds later, together with anything else. */
  noteChange(title: T): void {
    if (!this.isOn) return;
    this.pending.add(title.id);
    this.cancelFlush?.();
    this.cancelFlush = this.clock.schedule(1500, () => detach(this.flush()));
  }

  // MARK: Keys

  /** How a film is known in the cloud: its IMDb id when there is one, otherwise its name and year. */
  static key(imdbId: string | null, normName: string, year: number | null): string {
    if (imdbId !== null && imdbId.startsWith("tt")) return imdbId;
    return `n:${swiftPrefix(normName, 140)}|${year !== null ? String(year) : ""}`;
  }

  static keys(title: TogetherTitle): string[] {
    const keys = [CloudLibrary.key(null, title.normName, title.year)];
    if (title.imdbId !== null && title.imdbId.startsWith("tt")) keys.unshift(title.imdbId);
    return keys;
  }

  /** One title as `library:put` takes it. */
  static item(title: TogetherTitle): Record<string, unknown> {
    const item: Record<string, unknown> = {
      key: CloudLibrary.key(title.imdbId, title.normName, title.year),
      name: swiftPrefix(title.name, 200),
      kind: title.kind,
      status: title.status,
      statusAt: CloudLibrary.ms(title.statusAt ?? title.updatedAt),
    };
    if (title.year !== null) item.year = title.year;
    if (title.finishedAt !== null) item.finishedAt = CloudLibrary.ms(title.finishedAt);
    if (title.ratedAt !== null) {
      // A cleared rating goes as null with its time, so other devices clear it too.
      item.rating = title.ratingHalves;
      item.ratedAt = CloudLibrary.ms(title.ratedAt);
    }
    return item;
  }

  /** Seconds since 1970 to milliseconds, rounded half away from zero like Swift's `rounded()`. */
  static ms(seconds: number): number {
    return roundHalfAway(seconds * 1000);
  }

  // MARK: Sending

  /** Sends what changed since the last send. Run 1.5 s after the last change. */
  async flush(): Promise<void> {
    if (this.isStopped) return;
    const ids = [...this.pending];
    this.pending.clear();
    const titles = ids.map((id) => this.library.titles.get(id)).filter((t): t is T => t !== undefined);
    if (titles.length === 0) return;
    try {
      await this.put(titles);
      this.set("lastSync", this.clock.now());
      this.set("lastError", null);
    } catch (e) {
      for (const id of ids) this.pending.add(id);
      this.set("lastError", errorMessage(e));
    }
  }

  private async put(titles: readonly T[]): Promise<void> {
    const { client, secret } = await this.together.authorized();
    for (let start = 0; start < titles.length; start += CloudLibrary.BATCH_SIZE) {
      const batch = titles.slice(start, start + CloudLibrary.BATCH_SIZE).map((t) => CloudLibrary.item(t));
      await client.mutation("library:put", { deviceSecret: secret, items: batch }, savedFromJson);
    }
  }

  // MARK: Syncing

  /** Takes what the cloud knows that this library doesn't, and sends what only this library knows. */
  async sync(): Promise<void> {
    if (!this.isOn || this._isSyncing) return;
    this.set("isSyncing", true);
    try {
      const { client, secret } = await this.together.authorized();
      const remote = await client.query(
        "library:all",
        { deviceSecret: secret, t: roundHalfAway(this.clock.now()) },
        (value) => J.arrayOf(value, CloudItem.fromJson),
      );
      this.set("cloudCount", remote.length);
      if (this.isStopped) return;
      const outgoing = await this.merge(remote);
      if (outgoing.length > 0) await this.put(outgoing);
      this.set("lastSync", this.clock.now());
      this.set("lastError", null);
    } catch (e) {
      this.set("lastError", errorMessage(e));
    } finally {
      this.set("isSyncing", false);
    }
  }

  /** Applies newer cloud values here and returns the titles whose values here are newer. */
  async merge(remote: readonly CloudItem[]): Promise<T[]> {
    const byKey = new Map<string, CloudItem>();
    for (const item of remote) {
      const known = byKey.get(item.key);
      if (known && CloudItem.newest(known) >= CloudItem.newest(item)) continue;
      byKey.set(item.key, item);
    }
    const outgoing: T[] = [];
    for (const title of [...this.library.titles.values()]) {
      // An IMDb id found after the first backup leaves the old name-only entry behind. Both count.
      const matches = CloudLibrary.keys(title)
        .map((k) => byKey.get(k))
        .filter((m): m is CloudItem => m !== undefined);
      const rated = maxBy(matches.filter((m) => m.ratedAt !== null), (m) => m.ratedAt ?? 0);
      const filed = maxBy(matches.filter((m) => m.statusAt !== null), (m) => m.statusAt ?? 0);

      // Swift's `halves: Int??`: whether to touch the rating, and what to set it to.
      let restoreRating = false;
      let halves: number | null = null;
      let ratedAt: number | null = null;
      const localRated = title.ratedAt !== null ? milliseconds(title.ratedAt) : 0;
      if (rated && rated.ratedAt !== null && rated.ratedAt > localRated + 500) {
        restoreRating = true;
        halves = rated.rating !== null ? Math.trunc(rated.rating) : null;
        ratedAt = rated.ratedAt / 1000;
      }

      let status: TitleStatus | null = null;
      let statusAt: number | null = null;
      const remoteStatus = filed ? titleStatusFromRaw(filed.status) : null;
      if (filed && filed.statusAt !== null && remoteStatus !== null && remoteStatus !== title.status) {
        const at = filed.statusAt;
        // A title imported without a date only takes the cloud's list when it isn't in one here.
        const localAt = title.statusAt !== null ? milliseconds(title.statusAt) : null;
        if (localAt !== null && at > localAt + 500) status = remoteStatus;
        else if (localAt === null && title.status === "none") status = remoteStatus;
        statusAt = status !== null ? at / 1000 : null;
      }

      if (restoreRating || status !== null) {
        const values: RestoreValues = {};
        if (restoreRating) {
          values.halves = halves;
          values.ratedAt = ratedAt;
        }
        if (status !== null) {
          values.status = status;
          values.statusAt = statusAt;
        }
        if (filed?.finishedAt != null) values.finishedAt = filed.finishedAt / 1000;
        await this.library.restore(title.id, values);
      }

      const cloudRatedAt = rated?.ratedAt ?? 0;
      const cloudStatusAt = filed?.statusAt ?? 0;
      const localStatusAt = milliseconds(title.statusAt ?? title.updatedAt);
      const ratingIsNewer = title.ratedAt !== null && !restoreRating && localRated > cloudRatedAt + 500;
      const statusIsNewer =
        status === null && title.status !== "none" && (!filed || (title.statusAt !== null && localStatusAt > cloudStatusAt + 500));
      const current = this.library.titles.get(title.id);
      if ((ratingIsNewer || statusIsNewer) && current) outgoing.push(current);
    }
    return outgoing;
  }
}

function savedFromJson(value: unknown): number | null {
  return J.optionalNumber(J.requireObject(value), "saved");
}

/** The first of the largest, like Swift's `max(by:)` and C#'s MaxBy. */
function maxBy<V>(items: readonly V[], key: (item: V) => number): V | undefined {
  let best: V | undefined;
  let bestKey = -Infinity;
  for (const item of items) {
    const k = key(item);
    if (best === undefined || k > bestKey) {
      best = item;
      bestKey = k;
    }
  }
  return best;
}
