// Applies a profile's shield settings to declarativeNetRequest, as the apps' ProfileSession.applyRules
// applies them to WebKit: network blocking on or off, which lists are on, sites with shields off.
// The DNR API is passed in (`chromeDnr()` in the worker, a fake in tests), so this runs on Node.

import { ALLOW_ID_BASE, Priority, type DnrRule } from "./dnrRules";
import { DEFAULT_ENABLED_LISTS, RULESET_ORDER } from "./catalog";
import type { CosmeticIndex } from "./cosmetic";
import type { ShieldState } from "./shieldState";
import { normalizeHost } from "./siteDomain";

/** The parts of `chrome.declarativeNetRequest` Shields uses, with plain string types. */
export interface DnrApi {
  updateEnabledRulesets(options: { enableRulesetIds?: string[]; disableRulesetIds?: string[] }): Promise<void>;
  getEnabledRulesets(): Promise<string[]>;
  getAvailableStaticRuleCount?(): Promise<number>;
  getDynamicRules(): Promise<DnrRule[]>;
  updateDynamicRules(options: { addRules?: DnrRule[]; removeRuleIds?: number[] }): Promise<void>;
  getMatchedRules?(filter?: { tabId?: number; minTimeStamp?: number }): Promise<{ rulesMatchedInfo: MatchedRule[] }>;
  setExtensionActionOptions?(options: { displayActionCountAsBadgeText?: boolean }): Promise<void>;
  onRuleMatchedDebug?: DnrEvent<(info: MatchedRuleDebug) => void>;
}

export interface DnrEvent<T> {
  addListener(callback: T): void;
  removeListener(callback: T): void;
}

export interface MatchedRule {
  rule: { ruleId: number; rulesetId: string };
  tabId: number;
  timeStamp: number;
}

export interface MatchedRuleDebug {
  rule: { ruleId: number; rulesetId: string };
  request: { tabId: number; url: string; type: string; frameId?: number; initiator?: string };
}

/** `chrome.declarativeNetRequest` (or Firefox's `browser.declarativeNetRequest`) as a DnrApi. */
export function chromeDnr(api: unknown = (globalThis as { chrome?: { declarativeNetRequest?: unknown } }).chrome?.declarativeNetRequest): DnrApi {
  if (!api) throw new Error("declarativeNetRequest is not available");
  return api as DnrApi;
}

/** The profile settings Shields reads: the apps' `networkBlocking` and `enabledLists`. */
export interface ShieldSettings {
  networkBlocking: boolean;
  enabledLists: Iterable<string>;
}

/** Dynamic rule ids Shields owns. Other parts of the extension must stay out of this range. */
export const SHIELD_DYNAMIC_IDS = { first: 9_000_000, last: 9_000_999 } as const;
/** The one dynamic rule: allow everything on the sites where the person switched shields off. */
export const SITES_OFF_RULE_ID = 9_000_001;

/** A static ruleset's id, as opposed to "_dynamic" or "_session". */
export function isStaticRuleset(rulesetId: string): boolean {
  return !rulesetId.startsWith("_");
}

/** A match that blocked something: a block rule from one of the lists, not an exception. */
export function isBlockingMatch(rule: { ruleId: number; rulesetId: string }): boolean {
  return isStaticRuleset(rule.rulesetId) && rule.ruleId < ALLOW_ID_BASE;
}

/** Hosts DNR accepts in requestDomains: lowercase ASCII names and IPv4 addresses. */
function isRequestDomain(host: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host);
}

export interface ApplyResult {
  /** Rulesets on after applying, in value order. */
  enabled: string[];
  /** Rulesets that should be on but the browser refused, usually for lack of rule room. */
  refused: string[];
}

export class ShieldRules {
  private current: { networkBlocking: boolean; enabledLists: Set<string> } = {
    networkBlocking: true,
    enabledLists: new Set(DEFAULT_ENABLED_LISTS),
  };

  constructor(
    private readonly dnr: DnrApi,
    private readonly state: ShieldState,
    private readonly options: {
      /** Element-hiding maps, once loaded. Without them `cssFor` gives "". */
      cosmetic?: CosmeticIndex | null;
      /** Static ruleset ids in value order. Defaults to the bundled lists. */
      rulesets?: readonly string[];
    } = {},
  ) {}

  get settings(): { networkBlocking: boolean; enabledLists: string[] } {
    return { networkBlocking: this.current.networkBlocking, enabledLists: [...this.current.enabledLists] };
  }

  set cosmetic(index: CosmeticIndex | null) {
    this.options.cosmetic = index;
  }

  private get rulesets(): readonly string[] {
    return this.options.rulesets ?? RULESET_ORDER;
  }

  /** The rulesets a profile's settings switch on, in value order. */
  rulesetsFor(settings: ShieldSettings): string[] {
    if (!settings.networkBlocking) return [];
    const on = new Set(settings.enabledLists);
    return this.rulesets.filter((id) => on.has(id));
  }

  /**
   * Switches rulesets to match the settings, then brings the sites-off rule up to date. Call it on
   * every worker start too: an extension update puts the manifest's defaults back.
   */
  async apply(settings: ShieldSettings): Promise<ApplyResult> {
    this.current = { networkBlocking: settings.networkBlocking, enabledLists: new Set(settings.enabledLists) };
    const wanted = this.rulesetsFor(settings);
    const known = new Set(this.rulesets);
    const on = new Set((await this.dnr.getEnabledRulesets()).filter((id) => known.has(id)));
    const enable = wanted.filter((id) => !on.has(id));
    const disable = [...on].filter((id) => !wanted.includes(id));
    const refused: string[] = [];
    if (enable.length > 0 || disable.length > 0) {
      try {
        await this.dnr.updateEnabledRulesets({ enableRulesetIds: enable, disableRulesetIds: disable });
      } catch {
        // Over the limit: switch off what's unwanted, then add the rest one at a time, most
        // valuable first, so the browser's room goes to the lists that matter most.
        if (disable.length > 0) await this.dnr.updateEnabledRulesets({ disableRulesetIds: disable }).catch(() => undefined);
        for (const id of enable) {
          try {
            await this.dnr.updateEnabledRulesets({ enableRulesetIds: [id] });
          } catch {
            refused.push(id);
          }
        }
      }
    }
    await this.syncSites();
    return { enabled: wanted.filter((id) => !refused.includes(id)), refused };
  }

  /** The dynamic rule for sites with shields off, or null when there are none. */
  sitesOffRule(): DnrRule | null {
    const hosts = [...new Set(this.state.sitesWithShieldsOff.filter(isRequestDomain))].sort();
    if (hosts.length === 0) return null;
    return {
      id: SITES_OFF_RULE_ID,
      priority: Priority.siteOff,
      action: { type: "allowAllRequests" },
      // The page's own load: everything in that tab's page, frames included, is then allowed,
      // which is the apps' "skip Match when ShieldsOff(page host)".
      condition: { requestDomains: hosts, resourceTypes: ["main_frame"] },
    };
  }

  /** Writes the sites-off rule from ShieldState. Takes effect from each site's next page load. */
  async syncSites(): Promise<void> {
    const rule = this.sitesOffRule();
    await this.dnr.updateDynamicRules({ removeRuleIds: [SITES_OFF_RULE_ID], addRules: rule ? [rule] : [] });
  }

  /** The shield panel's "Turn shields off for this site". */
  async setShieldsOff(host: string, off: boolean): Promise<void> {
    await this.state.update(host, { shieldsOff: off });
    await this.syncSites();
  }

  /**
   * The element-hiding CSS for frames of a page at `topUrlOrHost` (the top-level page, whose host
   * decides, as in the apps). "" when network blocking is off, shields are off for the site, or
   * nothing applies. Inject it with `chrome.scripting.insertCSS({ origin: "USER" })`.
   */
  cssFor(topUrlOrHost: string): string {
    if (!this.current.networkBlocking || !this.options.cosmetic) return "";
    const host = normalizeHost(topUrlOrHost);
    if (host.length === 0 || this.state.shieldsOff(host)) return "";
    return this.options.cosmetic.cssFor(host, this.current.enabledLists);
  }
}

/**
 * Whether a pop-up may open: the Windows app's rule. `sameSite && realClick` is a person opening a
 * link of the same site in a new window, which is never a pop-under.
 */
export function popupAllowed(input: { popupShield: boolean; prefs: { shieldsOff: boolean; allowPopups: boolean }; sameSite: boolean; realClick: boolean }): boolean {
  return !input.popupShield || input.prefs.shieldsOff || input.prefs.allowPopups || (input.sameSite && input.realClick);
}

/** Whether the redirect shield is active on a site at all; the decision itself is the runtime's. */
export function redirectShieldActive(redirectShield: boolean, prefs: { shieldsOff: boolean; allowRedirects: boolean }): boolean {
  return redirectShield && !prefs.shieldsOff && !prefs.allowRedirects;
}
