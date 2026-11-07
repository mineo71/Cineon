// ShieldRules and ShieldCounter against a fake declarativeNetRequest.

import {
  ShieldRules, SITES_OFF_RULE_ID, popupAllowed, redirectShieldActive, type DnrApi, type MatchedRule, type MatchedRuleDebug,
} from "../../src/core/shields/shieldRules";
import { ShieldCounter, counterMode } from "../../src/core/shields/shieldCounter";
import { ShieldState, type ShieldStore } from "../../src/core/shields/shieldState";
import { ALLOW_ID_BASE, Priority, type DnrRule } from "../../src/core/shields/dnrRules";
import { RULESET_ORDER } from "../../src/core/shields/catalog";
import { DnrMatcher, dnrRequest } from "./dnrMatcher";
import { cosmetic, rulesetsOf } from "./helpers";

const memory = (): ShieldStore => {
  const prefs = new Map();
  return {
    loadSitePrefs: () => [...prefs.values()],
    saveSitePrefs: (p) => void prefs.set(p.host, p),
    loadTotalStats: () => ({ ads: 0, popups: 0, redirects: 0, overlays: 0 }),
    addStats: () => undefined,
  };
};

/** Enough of declarativeNetRequest: rulesets with sizes and a room limit, dynamic rules, matches. */
class FakeDnr implements DnrApi {
  enabled = new Set<string>();
  dynamic: DnrRule[] = [];
  calls: { enable?: string[]; disable?: string[] }[] = [];
  matched: MatchedRule[] = [];
  listeners: ((info: MatchedRuleDebug) => void)[] = [];
  badge: boolean | null = null;
  quotaLeft = Number.POSITIVE_INFINITY;

  constructor(private readonly sizes: Record<string, number> = {}, private readonly room = Number.POSITIVE_INFINITY) {}

  async updateEnabledRulesets(o: { enableRulesetIds?: string[]; disableRulesetIds?: string[] }): Promise<void> {
    this.calls.push({ enable: o.enableRulesetIds, disable: o.disableRulesetIds });
    const next = new Set(this.enabled);
    for (const id of o.disableRulesetIds ?? []) next.delete(id);
    for (const id of o.enableRulesetIds ?? []) next.add(id);
    const used = [...next].reduce((s, id) => s + (this.sizes[id] ?? 1), 0);
    if (used > this.room) throw new Error("The number of enabled static rules exceeds the limit.");
    this.enabled = next;
  }

  async getEnabledRulesets(): Promise<string[]> {
    return [...this.enabled];
  }

  async getDynamicRules(): Promise<DnrRule[]> {
    return this.dynamic;
  }

  async updateDynamicRules(o: { addRules?: DnrRule[]; removeRuleIds?: number[] }): Promise<void> {
    this.dynamic = this.dynamic.filter((r) => !(o.removeRuleIds ?? []).includes(r.id)).concat(o.addRules ?? []);
  }

  async getMatchedRules(filter?: { minTimeStamp?: number }): Promise<{ rulesMatchedInfo: MatchedRule[] }> {
    if (this.quotaLeft-- <= 0) throw new Error("quota");
    return { rulesMatchedInfo: this.matched.filter((m) => m.timeStamp >= (filter?.minTimeStamp ?? 0)) };
  }

  async setExtensionActionOptions(o: { displayActionCountAsBadgeText?: boolean }): Promise<void> {
    this.badge = o.displayActionCountAsBadgeText ?? null;
  }

  onRuleMatchedDebug = {
    addListener: (cb: (info: MatchedRuleDebug) => void) => void this.listeners.push(cb),
    removeListener: (cb: (info: MatchedRuleDebug) => void) => void (this.listeners = this.listeners.filter((l) => l !== cb)),
  };
}

const allLists = { networkBlocking: true, enabledLists: RULESET_ORDER };

test("applying settings switches rulesets, most valuable first", async () => {
  const dnr = new FakeDnr();
  const rules = new ShieldRules(dnr, await ShieldState.open(memory()));
  expect(await rules.apply(allLists)).toEqual({ enabled: [...RULESET_ORDER], refused: [] });
  expect(dnr.calls).toEqual([{ enable: [...RULESET_ORDER], disable: [] }]);

  // Only what changed is sent; rulesets the extension doesn't know about are left alone.
  dnr.enabled.add("someone-elses");
  await rules.apply({ networkBlocking: true, enabledLists: ["easylist", "ublock"] });
  expect(dnr.calls.at(-1)).toEqual({ enable: [], disable: ["cineon-streaming", "peterlowe", "easyprivacy"] });
  expect([...dnr.enabled].sort()).toEqual(["easylist", "someone-elses", "ublock"]);

  await rules.apply({ networkBlocking: false, enabledLists: RULESET_ORDER });
  expect([...dnr.enabled]).toEqual(["someone-elses"]);
  expect(rules.settings.networkBlocking).toBe(false);

  const before = dnr.calls.length;
  await rules.apply({ networkBlocking: false, enabledLists: [] });
  expect(dnr.calls.length).toBe(before);
});

test("when the browser has no room for every list, the most valuable get it", async () => {
  const sizes = { "cineon-streaming": 1, ublock: 761, peterlowe: 1, easylist: 3706, easyprivacy: 9106 };
  const dnr = new FakeDnr(sizes, 5000);
  const rules = new ShieldRules(dnr, await ShieldState.open(memory()));
  const result = await rules.apply(allLists);
  expect(result.refused).toEqual(["easyprivacy"]);
  expect(result.enabled).toEqual(["cineon-streaming", "ublock", "peterlowe", "easylist"]);
  expect([...dnr.enabled].sort()).toEqual(["cineon-streaming", "easylist", "peterlowe", "ublock"]);
});

test("shields off for a site allows everything on its pages, from the next load", async () => {
  const dnr = new FakeDnr();
  const state = await ShieldState.open(memory());
  const rules = new ShieldRules(dnr, state);
  await rules.apply(allLists);
  expect(dnr.dynamic).toEqual([]);

  await rules.setShieldsOff("www.filmhub.co.uk", true);
  expect(state.shieldsOff("player.filmhub.co.uk")).toBe(true);
  expect(dnr.dynamic).toEqual([{
    id: SITES_OFF_RULE_ID, priority: Priority.siteOff, action: { type: "allowAllRequests" },
    condition: { requestDomains: ["filmhub.co.uk"], resourceTypes: ["main_frame"] },
  }]);

  // With the real rules: blocked elsewhere, allowed on that site's pages, $important included.
  const statics = [...rulesetsOf(["||popads.net^\n||ads.com^$important"])].map(([id, r]) => ({ id, rules: r }));
  const m = new DnrMatcher([...statics, { id: "_dynamic", rules: dnr.dynamic }]);
  expect(m.blocks(dnrRequest("https://popads.net/x.js", "https://other.example/", "Script", false))).toBe(true);
  expect(m.blocks(dnrRequest("https://popads.net/x.js", "https://watch.filmhub.co.uk/film", "Script", false))).toBe(false);
  expect(m.blocks(dnrRequest("https://ads.com/x.js", "https://filmhub.co.uk/", "Script", false))).toBe(false);
  // A frame of that site inside another site's page is still under that page's shields.
  expect(m.blocks({ url: "https://popads.net/x.js", type: "script", initiator: "https://filmhub.co.uk", topUrl: "https://other.example/" })).toBe(true);

  await rules.setShieldsOff("filmhub.co.uk", false);
  expect(dnr.dynamic).toEqual([]);
});

test("site keys DNR can't take are left out of the rule", async () => {
  const dnr = new FakeDnr();
  const state = await ShieldState.open(memory());
  await state.update("[::1]", { shieldsOff: true });
  await state.update("10.0.0.2", { shieldsOff: true });
  const rules = new ShieldRules(dnr, state);
  expect(rules.sitesOffRule()!.condition.requestDomains).toEqual(["10.0.0.2"]);
});

test("element hiding follows the settings and the site's switch", async () => {
  const state = await ShieldState.open(memory());
  const index = cosmetic([{ id: "easylist", text: "##.ad-a\nexample.com##.banner" }, { id: "ublock", text: "##.from-ublock" }]);
  const rules = new ShieldRules(new FakeDnr(), state, { cosmetic: index });
  await rules.apply(allLists);
  expect(rules.cssFor("https://www.example.com/watch")).toBe(".ad-a{display:none !important;}\n.banner{display:none !important;}\n.from-ublock{display:none !important;}\n");

  await rules.apply({ networkBlocking: true, enabledLists: ["ublock"] });
  expect(rules.cssFor("example.com")).toBe(".from-ublock{display:none !important;}\n");

  await state.update("example.com", { shieldsOff: true });
  expect(rules.cssFor("www.example.com")).toBe("");
  expect(rules.cssFor("other.org")).toContain(".from-ublock");

  await rules.apply({ networkBlocking: false, enabledLists: ["ublock"] });
  expect(rules.cssFor("other.org")).toBe("");
  expect(new ShieldRules(new FakeDnr(), state).cssFor("other.org")).toBe("");
  expect(rules.cssFor("about:blank")).toBe("");
});

test("pop-ups and redirects follow the site's switches", () => {
  const prefs = { shieldsOff: false, allowPopups: false, allowRedirects: false };
  expect(popupAllowed({ popupShield: true, prefs, sameSite: false, realClick: true })).toBe(false);
  expect(popupAllowed({ popupShield: true, prefs, sameSite: true, realClick: true })).toBe(true);
  expect(popupAllowed({ popupShield: true, prefs, sameSite: true, realClick: false })).toBe(false);
  expect(popupAllowed({ popupShield: false, prefs, sameSite: false, realClick: false })).toBe(true);
  expect(popupAllowed({ popupShield: true, prefs: { ...prefs, allowPopups: true }, sameSite: false, realClick: false })).toBe(true);
  expect(popupAllowed({ popupShield: true, prefs: { ...prefs, shieldsOff: true }, sameSite: false, realClick: false })).toBe(true);
  expect(redirectShieldActive(true, prefs)).toBe(true);
  expect(redirectShieldActive(true, { ...prefs, allowRedirects: true })).toBe(false);
  expect(redirectShieldActive(true, { ...prefs, shieldsOff: true })).toBe(false);
  expect(redirectShieldActive(false, prefs)).toBe(false);
});

// MARK: Counting

const match = (tabId: number, ruleId: number, timeStamp: number, rulesetId = "easylist"): MatchedRule => ({ rule: { ruleId, rulesetId }, tabId, timeStamp });

/** A browser with only the basics, like Firefox without extensions.dnr.feedback. */
const bareDnr = (): DnrApi => ({
  updateEnabledRulesets: async () => undefined,
  getEnabledRulesets: async () => [],
  getDynamicRules: async () => [],
  updateDynamicRules: async () => undefined,
});

test("the counter's mode depends on how the extension is installed", () => {
  const dnr = new FakeDnr();
  expect(counterMode(dnr, "development")).toBe("debug");
  expect(counterMode(dnr, "normal")).toBe("matched");
  expect(counterMode(bareDnr(), "development")).toBe("off");
});

test("debug mode counts every block as it happens, and nothing else", async () => {
  const dnr = new FakeDnr();
  const state = await ShieldState.open(memory());
  const seen: string[] = [];
  const counter = new ShieldCounter(dnr, state, "debug", { onBlocked: (_, url) => seen.push(url ?? "") });
  counter.start();
  const fire = (ruleId: number, rulesetId: string, tabId = 7) =>
    dnr.listeners.forEach((l) => l({ rule: { ruleId, rulesetId }, request: { tabId, url: `https://ads.example/${ruleId}`, type: "script" } }));
  fire(3, "easylist");
  fire(ALLOW_ID_BASE + 2, "easylist");
  fire(SITES_OFF_RULE_ID, "_dynamic");
  fire(4, "ublock", 8);
  expect(counter.blockedOnTab(7)).toBe(1);
  expect(counter.blockedOnTab(8)).toBe(1);
  expect(state.total.ads).toBe(2);
  expect(seen).toEqual(["https://ads.example/3", "https://ads.example/4"]);
  counter.resetTab(7);
  expect(counter.blockedOnTab(7)).toBe(0);
  counter.stop();
  expect(dnr.listeners).toHaveLength(0);
  await state.flush();
});

test("matched mode counts each block once across polls", async () => {
  const dnr = new FakeDnr();
  const state = await ShieldState.open(memory());
  const counter = new ShieldCounter(dnr, state, "matched", { now: () => 1000 });
  dnr.matched = [match(1, 5, 1000), match(1, ALLOW_ID_BASE + 1, 1001), match(2, 6, 1500), match(2, 7, 1500), match(1, 5, 900)];
  expect(await counter.poll()).toBe(3);
  // The next poll asks again from 1500; the two seen at 1500 aren't counted twice.
  dnr.matched.push(match(2, 8, 1500), match(1, 9, 2000));
  expect(await counter.poll()).toBe(2);
  expect(await counter.poll()).toBe(0);
  expect(counter.blockedOnTab(1)).toBe(2);
  expect(counter.blockedOnTab(2)).toBe(3);
  expect(state.total.ads).toBe(5);

  dnr.quotaLeft = 0;
  dnr.matched.push(match(1, 10, 3000));
  expect(await counter.poll()).toBe(0);
  dnr.quotaLeft = 1;
  expect(await counter.poll()).toBe(1);

  // A new worker carries on from the old one's checkpoint, counting nothing twice.
  dnr.quotaLeft = Number.POSITIVE_INFINITY;
  dnr.matched.push(match(1, 11, 3000), match(1, 12, 4000));
  const next = new ShieldCounter(dnr, state, "matched", { checkpoint: JSON.parse(JSON.stringify(counter.checkpoint)), now: () => 9999 });
  expect(await next.poll()).toBe(2);
  expect(state.total.ads).toBe(8);
  await state.flush();
});

test("the badge count is the browser's", async () => {
  const dnr = new FakeDnr();
  const counter = new ShieldCounter(dnr, await ShieldState.open(memory()), "off");
  expect(await counter.showCountOnBadge(true)).toBe(true);
  expect(dnr.badge).toBe(true);
  expect(await counter.poll()).toBe(0);
  const bare = new ShieldCounter(bareDnr(), await ShieldState.open(memory()), "off");
  expect(await bare.showCountOnBadge(true)).toBe(false);
});
