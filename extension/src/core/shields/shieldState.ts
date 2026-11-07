// One profile's shield preferences per site and its running totals of what was blocked, ported
// from windows/Cineon.Core/Shields/ShieldState.cs (Cineon/Shields/ShieldState.swift). Sites are
// keyed by registrable domain, so a choice made on one subdomain holds across the site. Totals
// reach the store at most every five seconds.

import { registrable } from "./siteDomain";

export interface SitePrefs {
  host: string;
  /** All shields are off on this site: the per-site switch in the shield panel. */
  shieldsOff: boolean;
  allowPopups: boolean;
  allowRedirects: boolean;
  /** For sites that aren't about films, like YouTube: nothing here goes on the timeline. */
  trackingOff: boolean;
}

export interface ShieldCounts {
  ads: number;
  popups: number;
  redirects: number;
  overlays: number;
}

/**
 * Where ShieldState keeps its data: the profile's `site_prefs` and `stats` tables. Plain values,
 * so Shields doesn't depend on the data layer. Methods may throw or reject; ShieldState ignores
 * failures, as the apps do.
 */
export interface ShieldStore {
  /** Every row of site_prefs. */
  loadSitePrefs(): SitePrefs[] | Promise<SitePrefs[]>;
  /** Insert or replace one row of site_prefs. */
  saveSitePrefs(prefs: SitePrefs): void | Promise<void>;
  /** The sums of the stats table's columns. */
  loadTotalStats(): ShieldCounts | Promise<ShieldCounts>;
  /** Adds to the stats row for `day` ("yyyy-MM-dd", local time), creating it if needed. */
  addStats(day: string, delta: ShieldCounts): void | Promise<void>;
}

export interface ShieldStateOptions {
  /** How long new counts wait before being written. Five seconds, as in the apps. */
  flushDelayMs?: number;
  /** The local clock, which decides the day counts are filed under. */
  now?: () => Date;
}

type Prefs = Omit<SitePrefs, "host">;

const noPrefs: Prefs = { shieldsOff: false, allowPopups: false, allowRedirects: false, trackingOff: false };
const zero = (): ShieldCounts => ({ ads: 0, popups: 0, redirects: 0, overlays: 0 });

function day(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export class ShieldState {
  private readonly prefsByHost = new Map<string, Prefs>();
  private totals = zero();
  private pending = zero();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly flushDelayMs: number;
  private readonly now: () => Date;

  private constructor(private readonly store: ShieldStore, options: ShieldStateOptions) {
    this.flushDelayMs = options.flushDelayMs ?? 5000;
    this.now = options.now ?? (() => new Date());
  }

  /** Loads preferences and totals. A store that fails to load gives empty ones. */
  static async open(store: ShieldStore, options: ShieldStateOptions = {}): Promise<ShieldState> {
    const state = new ShieldState(store, options);
    try {
      for (const row of await store.loadSitePrefs()) {
        state.prefsByHost.set(row.host, {
          shieldsOff: row.shieldsOff, allowPopups: row.allowPopups, allowRedirects: row.allowRedirects, trackingOff: row.trackingOff,
        });
      }
    } catch {
      state.prefsByHost.clear();
    }
    try {
      const t = await store.loadTotalStats();
      state.totals = { ads: t.ads, popups: t.popups, redirects: t.redirects, overlays: t.overlays };
    } catch {
      state.totals = zero();
    }
    return state;
  }

  /** The key preferences are stored under: the registrable domain. */
  static key(host: string | null | undefined): string {
    return registrable(host ?? "");
  }

  /** Called when preferences or totals change. Returns a function that stops it. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  /** Preferences for a site, or the defaults (everything off) for one never changed. */
  prefsFor(host: string | null | undefined): SitePrefs {
    const key = ShieldState.key(host);
    return { host: key, ...(this.prefsByHost.get(key) ?? noPrefs) };
  }

  /** Every site with saved preferences. */
  get allPrefs(): SitePrefs[] {
    return [...this.prefsByHost].map(([host, prefs]) => ({ host, ...prefs }));
  }

  /** Sites where the person switched shields off: what ShieldRules turns into an allow rule. */
  get sitesWithShieldsOff(): string[] {
    return [...this.prefsByHost].filter(([, p]) => p.shieldsOff).map(([host]) => host);
  }

  shieldsOff(host: string | null | undefined): boolean {
    return this.prefsFor(host).shieldsOff;
  }

  allowPopups(host: string | null | undefined): boolean {
    return this.prefsFor(host).allowPopups;
  }

  allowRedirects(host: string | null | undefined): boolean {
    return this.prefsFor(host).allowRedirects;
  }

  trackingOff(host: string | null | undefined): boolean {
    return this.prefsFor(host).trackingOff;
  }

  /** Changes the given preferences for a site and saves them. Does nothing without a host. */
  async update(host: string | null | undefined, change: Partial<Prefs>): Promise<void> {
    if (host === null || host === undefined) return;
    const key = ShieldState.key(host);
    const old = this.prefsByHost.get(key) ?? noPrefs;
    const prefs: Prefs = {
      shieldsOff: change.shieldsOff ?? old.shieldsOff,
      allowPopups: change.allowPopups ?? old.allowPopups,
      allowRedirects: change.allowRedirects ?? old.allowRedirects,
      trackingOff: change.trackingOff ?? old.trackingOff,
    };
    this.prefsByHost.set(key, prefs);
    try {
      await this.store.saveSitePrefs({ host: key, ...prefs });
    } catch {
      // Kept in memory; the apps ignore a failed save the same way.
    }
    this.changed();
  }

  /** Everything blocked so far, across all days. */
  get total(): ShieldCounts {
    return { ...this.totals };
  }

  /** Counts newly blocked things. They reach the store within the flush delay. */
  record(delta: Partial<ShieldCounts>): void {
    const d = { ads: delta.ads ?? 0, popups: delta.popups ?? 0, redirects: delta.redirects ?? 0, overlays: delta.overlays ?? 0 };
    for (const k of ["ads", "popups", "redirects", "overlays"] as const) {
      this.totals[k] += d[k];
      this.pending[k] += d[k];
    }
    if (this.flushTimer === null) this.flushTimer = setTimeout(() => void this.flush(), this.flushDelayMs);
    this.changed();
  }

  /** Writes pending counts now. Call it when the worker is about to stop, so nothing is lost. */
  async flush(): Promise<void> {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const p = this.pending;
    if (p.ads + p.popups + p.redirects + p.overlays <= 0) return;
    this.pending = zero();
    try {
      await this.store.addStats(day(this.now()), p);
    } catch {
      // Lost, as in the apps.
    }
  }
}
