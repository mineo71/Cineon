// Counts blocked requests: per tab for the shield panel, and into ShieldState's totals (the apps'
// `tab.blocked.ads++` and `Record(ads: 1)`).
//
// DNR blocks inside the browser, so the extension has to ask what happened:
// - "debug": onRuleMatchedDebug fires for every match, with the URL. Exact and immediate, but
//   Chrome only offers it to unpacked extensions (Firefox only behind extensions.dnr.feedback).
// - "matched": getMatchedRules, polled. Works in store builds (needs declarativeNetRequestFeedback),
//   but Chrome allows 20 calls per 10 minutes and forgets matches of closed pages after 5
//   minutes, so the worker polls once a minute and totals lag by up to that.
// - "off": neither is available (Firefox without the pref). Nothing is counted.
// Separately, `showCountOnBadge` has the browser keep an exact per-tab count on the toolbar badge,
// at no cost; it can be read back with action.getBadgeText because the feedback permission is held.

import type { DnrApi, MatchedRule, MatchedRuleDebug } from "./shieldRules";
import { isBlockingMatch } from "./shieldRules";
import type { ShieldState } from "./shieldState";

export type CounterMode = "debug" | "matched" | "off";

/** How often to poll in "matched" mode: under the 5-minute memory and inside the call quota. */
export const POLL_MINUTES = 1;

/** Which mode this install can use. `installType` is `chrome.management.getSelf()`'s. */
export function counterMode(dnr: DnrApi, installType: string | undefined): CounterMode {
  if (installType === "development" && dnr.onRuleMatchedDebug) return "debug";
  if (dnr.getMatchedRules) return "matched";
  return "off";
}

/** Where "matched" polling got to. The worker keeps it in storage.session, as it can stop any time. */
export interface CounterCheckpoint {
  since: number;
  seen: string[];
}

export class ShieldCounter {
  private readonly perTab = new Map<number, number>();
  private since = 0;
  /** Matches at exactly `since` already counted, since the next poll asks from that time again. */
  private seenAtSince = new Set<string>();
  private debugListener: ((info: MatchedRuleDebug) => void) | null = null;

  constructor(
    private readonly dnr: DnrApi,
    private readonly state: ShieldState,
    private readonly mode: CounterMode,
    private readonly options: {
      now?: () => number;
      /** Where the last worker's polling got to; without it, counting starts from now. */
      checkpoint?: CounterCheckpoint | null;
      /** Called for every block seen, with the URL when the mode knows it. */
      onBlocked?: (tabId: number, url: string | null) => void;
    } = {},
  ) {
    this.since = options.checkpoint?.since ?? (options.now ?? Date.now)();
    this.seenAtSince = new Set(options.checkpoint?.seen ?? []);
  }

  get currentMode(): CounterMode {
    return this.mode;
  }

  /** Save after each poll; pass back as `checkpoint` when the worker starts again. */
  get checkpoint(): CounterCheckpoint {
    return { since: this.since, seen: [...this.seenAtSince] };
  }

  /** Starts listening in "debug" mode. In "matched" mode the worker calls `poll` from an alarm. */
  start(): void {
    if (this.mode !== "debug" || !this.dnr.onRuleMatchedDebug || this.debugListener) return;
    this.debugListener = (info) => {
      if (!isBlockingMatch(info.rule)) return;
      this.count(info.request.tabId, 1, info.request.url);
    };
    this.dnr.onRuleMatchedDebug.addListener(this.debugListener);
  }

  stop(): void {
    if (this.debugListener && this.dnr.onRuleMatchedDebug) this.dnr.onRuleMatchedDebug.removeListener(this.debugListener);
    this.debugListener = null;
  }

  /** Has the browser show each tab's blocked count on the toolbar badge, where it can. */
  async showCountOnBadge(on: boolean): Promise<boolean> {
    if (!this.dnr.setExtensionActionOptions) return false;
    try {
      await this.dnr.setExtensionActionOptions({ displayActionCountAsBadgeText: on });
      return true;
    } catch {
      return false;
    }
  }

  private count(tabId: number, n: number, url: string | null): void {
    if (tabId >= 0) this.perTab.set(tabId, (this.perTab.get(tabId) ?? 0) + n);
    this.state.record({ ads: n });
    if (this.options.onBlocked) for (let i = 0; i < n; i++) this.options.onBlocked(tabId, url);
  }

  /**
   * "matched" mode: asks for matches since the last poll and counts the blocks. Returns how many
   * were new. If the browser refuses (quota, or no permission on Firefox), counts nothing.
   */
  async poll(): Promise<number> {
    if (this.mode !== "matched" || !this.dnr.getMatchedRules) return 0;
    let matched: MatchedRule[];
    try {
      matched = (await this.dnr.getMatchedRules({ minTimeStamp: this.since })).rulesMatchedInfo;
    } catch {
      return 0;
    }
    let latest = this.since;
    for (const m of matched) latest = Math.max(latest, m.timeStamp);
    const seenNow = new Set<string>();
    const byTab = new Map<number, number>();
    let total = 0;
    for (const m of matched) {
      if (m.timeStamp < this.since || !isBlockingMatch(m.rule)) continue;
      const key = `${m.tabId}:${m.rule.rulesetId}:${m.rule.ruleId}:${m.timeStamp}`;
      if (m.timeStamp === this.since && this.seenAtSince.has(key)) continue;
      if (m.timeStamp === latest) seenNow.add(key);
      byTab.set(m.tabId, (byTab.get(m.tabId) ?? 0) + 1);
      total++;
    }
    if (latest !== this.since) this.seenAtSince = seenNow;
    else for (const key of seenNow) this.seenAtSince.add(key);
    this.since = latest;
    for (const [tabId, n] of byTab) this.count(tabId, n, null);
    return total;
  }

  /** Blocked on this tab since its page loaded, as far as this counter has seen. */
  blockedOnTab(tabId: number): number {
    return this.perTab.get(tabId) ?? 0;
  }

  /** A tab navigated to a new page, or closed: its count starts again, as in the apps. */
  resetTab(tabId: number): void {
    this.perTab.delete(tabId);
  }
}
