// Turns the apps' parsed network rules into declarativeNetRequest rules.
//
// DNR's urlFilter speaks the filter syntax (`||`, `|`, `^`, `*`) itself, so patterns go across as
// they are and no rule needs a regexFilter (the apps skip regex filters, and so does this). Every
// "||domain^" rule with the same options is folded into one rule with a `requestDomains` list,
// which is how ~96,000 of the apps' rules fit in a few hundred DNR rules. See notes/shields.md for
// what can't be 1:1.

import { compileList, isPlainDomain, type KitType, type NetworkFilter, type RuleLayout } from "./filterConverter";
import { FILTER_CATALOG, RULESET_ORDER, DEFAULT_ENABLED_LISTS } from "./catalog";

/** The resource types Chrome and Firefox both know. webtransport and webbundle are Chrome only. */
export const DNR_TYPES = [
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket", "other",
] as const;
export type DnrResourceType = (typeof DNR_TYPES)[number];

export interface DnrCondition {
  urlFilter?: string;
  regexFilter?: string;
  isUrlFilterCaseSensitive?: boolean;
  requestDomains?: string[];
  initiatorDomains?: string[];
  excludedInitiatorDomains?: string[];
  resourceTypes?: DnrResourceType[];
  excludedResourceTypes?: DnrResourceType[];
  domainType?: "firstParty" | "thirdParty";
}

export interface DnrRule {
  id: number;
  priority: number;
  action: { type: "block" | "allow" | "allowAllRequests" };
  condition: DnrCondition;
}

/**
 * Priorities. DNR lets an allow rule beat a block of the same priority; `$important` blocks sit
 * above exceptions, as filter lists mean them to; a list's own whole-site exceptions sit above
 * that, as in the apps where they turn the list off for the site; the person's "shields off for
 * this site" beats everything.
 */
export const Priority = {
  block: 1,
  allow: 2,
  important: 3,
  listSiteException: 4,
  siteOff: 100,
} as const;

/** Rule ids at or above this are exceptions (allow, allowAllRequests): they never count as a blocked ad. */
export const ALLOW_ID_BASE = 1_000_000;

/** Chrome guarantees each extension this many enabled static rules; more only if the shared pool has room. */
export const GUARANTEED_STATIC_RULES = 30_000;

/** Chrome's cap on regexFilter rules per ruleset. None are emitted; checked anyway. */
export const MAX_REGEX_RULES = 1_000;

const kitToDnr: Record<KitType, DnrResourceType[]> = {
  document: ["main_frame", "sub_frame"],
  image: ["image"],
  "style-sheet": ["stylesheet"],
  script: ["script"],
  font: ["font"],
  media: ["media"],
  fetch: ["xmlhttprequest"],
  websocket: ["websocket"],
  // WebKit has no type for plug-in loads or CSP reports; they fall under these.
  other: ["other", "object"],
  ping: ["ping", "csp_report"],
};

/** "||ads.example.com^": a whole host and its subdomains, nothing else. These become requestDomains. */
export function domainOf(filter: NetworkFilter): string | null {
  if (filter.wholeSite || filter.caseSensitive) return null;
  const { anchor, body, end } = filter.parts;
  if (anchor !== "host" || end || !body.endsWith("^")) return null;
  const domain = body.slice(0, -1).toLowerCase();
  return isPlainDomain(domain) ? domain : null;
}

/**
 * Whether the rule also stops a top-level navigation. WebKit applies untyped rules to the page
 * itself; DNR leaves main_frame out unless asked. It's asked for host rules with no party or site
 * condition, which is what blocks a pop-under or redirect landing on an ad server. Path rules keep
 * DNR's default, as uBlock and Adblock Plus do: "/ads/" mustn't block an article called "ads".
 * `$third-party` and `domain=` rules never match the page itself in the apps (the page is its own
 * first party and its own domain), so they don't here either.
 */
function blocksMainFrame(filter: NetworkFilter): boolean {
  if (domainOf(filter) === null) return false;
  if (filter.loadType !== null || filter.ifDomains.length > 0 || filter.unlessDomains.length > 0) return false;
  return filter.types.length === 0 || filter.types.includes("document") && !filter.childFrameOnly;
}

function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

/** The condition for one filter, without the URL part. */
function baseCondition(filter: NetworkFilter): DnrCondition {
  const c: DnrCondition = {};
  const mainFrame = blocksMainFrame(filter);
  if (filter.excludedTypes.length > 0) {
    const excluded = unique(filter.excludedTypes.flatMap((t) => kitToDnr[t]));
    if (!mainFrame && !excluded.includes("main_frame")) excluded.unshift("main_frame");
    c.excludedResourceTypes = excluded;
  } else if (filter.types.length > 0) {
    // A positive "document" only comes from $subdocument: frames only.
    c.resourceTypes = unique(filter.types.flatMap((t) => (t === "document" ? ["sub_frame" as const] : kitToDnr[t])));
  } else if (mainFrame) {
    c.resourceTypes = [...DNR_TYPES];
  }
  if (filter.loadType) c.domainType = filter.loadType === "third-party" ? "thirdParty" : "firstParty";
  if (filter.ifDomains.length > 0) c.initiatorDomains = unique(filter.ifDomains);
  if (filter.unlessDomains.length > 0) c.excludedInitiatorDomains = unique(filter.unlessDomains);
  return c;
}

/** The pattern as DNR reads it: the apps' anchors and body, unchanged. */
export function dnrUrlFilter(filter: NetworkFilter): string {
  const { anchor, body, end } = filter.parts;
  return (anchor === "host" ? "||" : anchor === "start" ? "|" : "") + body + (end ? "|" : "");
}

function actionFor(filter: NetworkFilter): { type: "block" | "allow"; priority: number } {
  if (filter.isException) return { type: "allow", priority: Priority.allow };
  return { type: "block", priority: filter.important ? Priority.important : Priority.block };
}

/**
 * How a rule ranks when a list has to be cut to fit: lower is kept first. Exceptions are never
 * cut, as in the apps, because dropping one breaks a site rather than missing an ad.
 */
export const Tier = {
  DomainBlocks: 0,
  SiteExceptions: 1,
  DomainAllows: 2,
  Allows: 3,
  ImportantBlocks: 4,
  /** Host-anchored paths ("||cdn.ads.net/x.js") on every site. */
  HostBlocks: 5,
  /** Other patterns on every site. */
  GenericBlocks: 6,
  /** Rules for named sites only. */
  SiteBlocks: 7,
} as const;
export type Tier = (typeof Tier)[keyof typeof Tier];

export interface RankedRule {
  tier: Tier;
  /** How many of the list's filters this rule stands for. */
  filters: number;
  rule: Omit<DnrRule, "id">;
}

export interface ListConversion {
  id: string;
  /** What the apps count for the list (cosmetic + network), as Settings shows it. */
  appRules: number;
  /** Lines the apps skip as unsupported. */
  skipped: number;
  cosmeticRules: number;
  /** Network filters the apps keep (blocks, exceptions, whole-site exceptions). */
  networkFilters: number;
  /** Of those, how many have a DNR form. The rest are $elemhide/$generichide site exceptions, which only touch cosmetics here. */
  converted: number;
  /** Rules, most valuable first, before any trimming. */
  rules: RankedRule[];
}

/** Converts one laid-out list. Rules come back ranked; ids are given when rulesets are written. */
export function convertList(id: string, layout: RuleLayout): ListConversion {
  const ranked: RankedRule[] = [];
  const groups = new Map<string, { tier: Tier; condition: DnrCondition; action: ReturnType<typeof actionFor>; domains: string[] }>();
  const siteExceptions: string[] = [];
  let converted = 0;

  for (const filter of [...layout.blocks, ...layout.exceptions]) {
    if (filter.wholeSite) {
      // "$document": the list leaves the site alone. "$elemhide"/"$generichide" only switch off
      // element hiding, which cosmetic.ts does; the apps turn the whole list off there, which DNR
      // can't do for one list without doing it for all of them.
      if (filter.wholeSite.kind === "document") {
        siteExceptions.push(filter.wholeSite.domain);
        converted++;
      }
      continue;
    }
    converted++;
    const condition = baseCondition(filter);
    const action = actionFor(filter);
    const domain = domainOf(filter);
    if (domain !== null) {
      const key = JSON.stringify([action, condition]);
      let group = groups.get(key);
      if (!group) {
        group = { tier: filter.isException ? Tier.DomainAllows : Tier.DomainBlocks, condition, action, domains: [] };
        groups.set(key, group);
      }
      group.domains.push(domain);
      continue;
    }
    if (filter.caseSensitive) condition.isUrlFilterCaseSensitive = true;
    const tier = filter.isException ? Tier.Allows
      : filter.important ? Tier.ImportantBlocks
      : filter.ifDomains.length > 0 || filter.unlessDomains.length > 0 ? Tier.SiteBlocks
      : filter.parts.anchor === "host" ? Tier.HostBlocks
      : Tier.GenericBlocks;
    ranked.push({
      tier,
      filters: 1,
      rule: { priority: action.priority, action: { type: action.type }, condition: { urlFilter: dnrUrlFilter(filter), ...condition } },
    });
  }

  for (const group of groups.values()) {
    const domains = unique(group.domains).sort();
    ranked.push({
      tier: group.tier,
      filters: group.domains.length,
      rule: { priority: group.action.priority, action: { type: group.action.type }, condition: { requestDomains: domains, ...group.condition } },
    });
  }
  if (siteExceptions.length > 0) {
    ranked.push({
      tier: Tier.SiteExceptions,
      filters: siteExceptions.length,
      rule: {
        priority: Priority.listSiteException,
        action: { type: "allowAllRequests" },
        condition: { requestDomains: unique(siteExceptions).sort(), resourceTypes: ["main_frame"] },
      },
    });
  }

  // Stable: within a tier, bigger groups first, then the list's own order.
  const order = ranked.map((r, i) => ({ r, i }));
  order.sort((a, b) => a.r.tier - b.r.tier || b.r.filters - a.r.filters || a.i - b.i);
  return {
    id,
    appRules: layout.ruleCount,
    skipped: layout.skipped,
    cosmeticRules: layout.cosmetic.length,
    networkFilters: layout.blocks.length + layout.exceptions.length,
    converted,
    rules: order.map((o) => o.r),
  };
}

export function isException(rule: Pick<DnrRule, "action">): boolean {
  return rule.action.type !== "block";
}

export function isTrimmable(rule: RankedRule): boolean {
  return rule.tier !== Tier.SiteExceptions && rule.tier !== Tier.DomainAllows && rule.tier !== Tier.Allows;
}

// MARK: Rulesets

export interface RulesetMeta {
  id: string;
  name: string;
  enabled: boolean;
  path: string;
  appRules: number;
  skipped: number;
  cosmeticRules: number;
  networkFilters: number;
  converted: number;
  /** DNR rules written. */
  emitted: number;
  /** DNR rules left out to stay within the budget, and how many of the list's filters they stood for. */
  trimmedRules: number;
  trimmedFilters: number;
  regexRules: number;
  /** Rules by kind, for the notes and Settings. */
  blockRules: number;
  allowRules: number;
  /** Hosts folded into requestDomains rules. */
  groupedDomains: number;
}

export interface Rulesets {
  /** The manifest's rule_resources, most valuable first. */
  index: { id: string; enabled: boolean; path: string }[];
  rules: Map<string, DnrRule[]>;
  meta: { budget: number; enabledRules: number; lists: RulesetMeta[] };
}

/**
 * Converts every list and fits the enabled ones into `budget` rules: if they don't fit, the
 * least valuable rules of the least valuable lists go first (never exceptions). Lists that aren't
 * enabled by default are written in full and only count against the budget when switched on.
 */
export function buildRulesets(
  sources: { id: string; text: string }[],
  options: { budget?: number; enabled?: readonly string[] } = {},
): Rulesets {
  const budget = options.budget ?? GUARANTEED_STATIC_RULES;
  const enabled = new Set(options.enabled ?? DEFAULT_ENABLED_LISTS);
  const byId = new Map(sources.map((s) => [s.id, s.text]));
  const ids = [...RULESET_ORDER.filter((id) => byId.has(id)), ...sources.map((s) => s.id).filter((id) => !RULESET_ORDER.includes(id))];
  const conversions = ids.map((id) => convertList(id, compileList(byId.get(id)!)));

  // What each list keeps: cut from the back of the least valuable enabled list first.
  const kept = new Map(conversions.map((c) => [c.id, c.rules]));
  let over = conversions.filter((c) => enabled.has(c.id)).reduce((sum, c) => sum + c.rules.length, 0) - budget;
  for (const c of [...conversions].reverse()) {
    if (over <= 0) break;
    if (!enabled.has(c.id)) continue;
    const dropped = new Set<RankedRule>();
    for (let i = c.rules.length - 1; i >= 0 && over > 0; i--) {
      const rule = c.rules[i]!;
      if (!isTrimmable(rule)) continue;
      dropped.add(rule);
      over--;
    }
    kept.set(c.id, c.rules.filter((r) => !dropped.has(r)));
  }

  const filtersIn = (list: RankedRule[]) => list.reduce((s, r) => s + r.filters, 0);
  const rules = new Map<string, DnrRule[]>();
  const lists: RulesetMeta[] = [];
  for (const c of conversions) {
    const keep = kept.get(c.id)!;
    let nextBlock = 1;
    let nextAllow = ALLOW_ID_BASE + 1;
    const out: DnrRule[] = keep.map((r) => ({ id: isException(r.rule) ? nextAllow++ : nextBlock++, ...r.rule }));
    rules.set(c.id, out);
    lists.push({
      id: c.id,
      name: FILTER_CATALOG.find((l) => l.id === c.id)?.name ?? c.id,
      enabled: enabled.has(c.id),
      path: `rules/${c.id}.json`,
      appRules: c.appRules,
      skipped: c.skipped,
      cosmeticRules: c.cosmeticRules,
      networkFilters: c.networkFilters,
      converted: c.converted,
      emitted: out.length,
      trimmedRules: c.rules.length - keep.length,
      trimmedFilters: filtersIn(c.rules) - filtersIn(keep),
      regexRules: out.filter((r) => r.condition.regexFilter !== undefined).length,
      blockRules: out.filter((r) => !isException(r)).length,
      allowRules: out.filter((r) => isException(r)).length,
      groupedDomains: out.reduce((s, r) => s + (r.condition.requestDomains?.length ?? 0), 0),
    });
  }
  return {
    index: lists.map((l) => ({ id: l.id, enabled: l.enabled, path: l.path })),
    rules,
    meta: { budget, enabledRules: lists.filter((l) => l.enabled).reduce((s, l) => s + l.emitted, 0), lists },
  };
}
