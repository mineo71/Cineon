// Shields for one profile (core/shields wired to the browser): the per-site preferences and totals
// over the profile's database, the static rulesets and the sites-off rule, the blocked-request
// counter, and element hiding for each frame.

import type { Database } from "../core/data";
import {
  type CosmeticIndex,
  type CounterCheckpoint,
  type CounterMode,
  type DnrApi,
  FILTER_CATALOG,
  ShieldCounter,
  ShieldRules,
  ShieldState,
  type ShieldStore,
  type SitePrefs,
} from "../core/shields";
import type { ShieldsSnapshot } from "../shared/messages";

/** ShieldState's store over the profile's `site_prefs` and `stats` tables. */
export function databaseShieldStore(db: Database): ShieldStore {
  return {
    async loadSitePrefs() {
      return [...(await db.sitePrefs()).values()].map((p) => ({ ...p }));
    },
    saveSitePrefs: (prefs) => db.saveSitePrefs(prefs),
    async loadTotalStats() {
      const t = await db.totalStats();
      return { ads: t.ads, popups: t.popups, redirects: t.redirects, overlays: t.overlays };
    },
    addStats: (day, delta) => db.addStats(delta, day),
  };
}

export interface ShieldsOptions {
  readonly dnr: DnrApi | null;
  readonly cosmetic: () => Promise<CosmeticIndex | null>;
  readonly counterMode: CounterMode;
  readonly checkpoint: CounterCheckpoint | null;
  /** A request was blocked in a tab. */
  readonly onBlocked: (tabId: number) => void;
}

export class SessionShields {
  rules: ShieldRules | null = null;
  counter: ShieldCounter | null = null;
  private cosmetic: CosmeticIndex | null = null;
  private cosmeticLoaded = false;
  private started = false;

  private constructor(
    public state: ShieldState,
    private readonly options: ShieldsOptions,
  ) {
    this.build();
  }

  private build(): void {
    const { dnr } = this.options;
    const checkpoint = this.counter?.checkpoint ?? this.options.checkpoint;
    this.rules = dnr ? new ShieldRules(dnr, this.state, { cosmetic: this.cosmetic }) : null;
    this.counter =
      dnr && this.options.counterMode !== "off"
        ? new ShieldCounter(dnr, this.state, this.options.counterMode, {
            checkpoint,
            onBlocked: (tabId) => this.options.onBlocked(tabId),
          })
        : null;
  }

  static async open(db: Database, options: ShieldsOptions): Promise<SessionShields> {
    return new SessionShields(await ShieldState.open(databaseShieldStore(db)), options);
  }

  /** The rulesets this person's settings switch on, and the sites they switched shields off for. */
  async apply(settings: { networkBlocking: boolean; enabledLists: readonly string[] }): Promise<void> {
    if (!this.rules) return;
    try {
      await this.rules.apply({ networkBlocking: settings.networkBlocking, enabledLists: [...settings.enabledLists] });
    } catch (error) {
      console.warn("Cineon: couldn't switch the filter lists", error);
    }
  }

  start(): void {
    this.started = true;
    this.counter?.start();
    void this.counter?.showCountOnBadge(true);
  }

  stop(): void {
    this.started = false;
    this.counter?.stop();
    void this.state.flush();
  }

  /** Element hiding for frames of the page at `topUrl` (loads the maps on first need). */
  async cssFor(topUrl: string): Promise<string> {
    if (!this.rules) return "";
    if (!this.cosmeticLoaded) {
      this.cosmeticLoaded = true;
      this.cosmetic = await this.options.cosmetic();
      this.rules.cosmetic = this.cosmetic;
    }
    return this.rules.cssFor(topUrl);
  }

  /** Saves a site's preferences (the popup and shield panel), keeping the sites-off rule in step. */
  async setSite(host: string, prefs: Omit<SitePrefs, "host">): Promise<{ shieldsChanged: boolean }> {
    const before = this.state.prefsFor(host);
    await this.state.update(host, {
      shieldsOff: prefs.shieldsOff,
      allowPopups: prefs.allowPopups,
      allowRedirects: prefs.allowRedirects,
      trackingOff: prefs.trackingOff,
    });
    const shieldsChanged = before.shieldsOff !== prefs.shieldsOff;
    if (shieldsChanged && this.rules) await this.rules.syncSites().catch(() => undefined);
    return { shieldsChanged };
  }

  /** A page wrote `site_prefs` itself: read them again and bring the rules up to date. */
  async reload(db: Database): Promise<void> {
    await this.state.flush();
    const settings = this.rules?.settings ?? null;
    this.counter?.stop();
    this.state = await ShieldState.open(databaseShieldStore(db));
    this.build();
    if (this.started) this.counter?.start();
    if (settings) await this.apply(settings);
  }
}

/** The catalogue and the rule counts the build wrote (rules/meta.json). */
export async function shieldsSnapshot(read: (path: string) => Promise<unknown>): Promise<ShieldsSnapshot> {
  const ruleCounts: Record<string, number> = {};
  try {
    const meta = (await read("rules/meta.json")) as { lists?: { id: string; emitted?: number; appRules?: number }[] };
    for (const list of meta.lists ?? []) ruleCounts[list.id] = list.appRules ?? list.emitted ?? 0;
  } catch {
    // No meta in this build: the lists without counts.
  }
  return {
    catalog: FILTER_CATALOG.map((l) => ({ id: l.id, name: l.name, summary: l.summary })),
    ruleCounts,
    lastUpdated: null,
    status: null,
  };
}
