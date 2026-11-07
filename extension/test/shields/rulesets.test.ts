// The bundled rulesets against the browsers' limits and rule format, and how lists are trimmed
// when they don't fit.

import { ALLOW_ID_BASE, DNR_TYPES, GUARANTEED_STATIC_RULES, MAX_REGEX_RULES, Tier, buildRulesets, convertList, type DnrRule } from "../../src/core/shields/dnrRules";
import { compileList } from "../../src/core/shields/filterConverter";
import { DEFAULT_ENABLED_LISTS, FILTER_CATALOG, RULESET_ORDER } from "../../src/core/shields/catalog";
import { bundledLists } from "./corpus";

const bundled = buildRulesets(bundledLists());

/** The checks Chrome makes when it indexes a static ruleset; a rule failing any is dropped. */
function problems(rule: DnrRule): string[] {
  const out: string[] = [];
  const c = rule.condition as Record<string, unknown>;
  const known = ["urlFilter", "regexFilter", "isUrlFilterCaseSensitive", "requestDomains", "initiatorDomains", "excludedInitiatorDomains", "resourceTypes", "excludedResourceTypes", "domainType"];
  for (const key of Object.keys(c)) if (!known.includes(key)) out.push(`unknown condition ${key}`);
  if (!Number.isInteger(rule.id) || rule.id < 1) out.push("id");
  if (!Number.isInteger(rule.priority) || rule.priority < 1) out.push("priority");
  if (!["block", "allow", "allowAllRequests"].includes(rule.action.type)) out.push("action");
  const f = rule.condition.urlFilter;
  if (f !== undefined) {
    if (f.length === 0) out.push("empty urlFilter");
    if (!/^[\x20-\x7e]+$/.test(f)) out.push("non-ASCII urlFilter");
    if (f.startsWith("||*")) out.push("urlFilter starts with ||*");
    if (f === "|" || f === "||") out.push("urlFilter is only an anchor");
  }
  if (f !== undefined && rule.condition.regexFilter !== undefined) out.push("urlFilter and regexFilter");
  for (const key of ["requestDomains", "initiatorDomains", "excludedInitiatorDomains"] as const) {
    const domains = rule.condition[key];
    if (domains === undefined) continue;
    if (domains.length === 0 && key !== "excludedInitiatorDomains") out.push(`empty ${key}`);
    for (const d of domains) if (!/^[a-z0-9.-]+$/.test(d)) out.push(`${key}: ${d} isn't lowercase ASCII`);
  }
  const types = rule.condition.resourceTypes;
  const excluded = rule.condition.excludedResourceTypes;
  if (types && excluded) out.push("resourceTypes and excludedResourceTypes");
  if (types && types.length === 0) out.push("empty resourceTypes");
  for (const t of [...(types ?? []), ...(excluded ?? [])]) if (!(DNR_TYPES as readonly string[]).includes(t)) out.push(`type ${t}`);
  if (rule.action.type === "allowAllRequests") {
    if (!types || types.some((t) => t !== "main_frame" && t !== "sub_frame")) out.push("allowAllRequests needs frame types");
  }
  const domainType = rule.condition.domainType;
  if (domainType !== undefined && domainType !== "firstParty" && domainType !== "thirdParty") out.push("domainType");
  return out;
}

test("every rule is one the browsers accept", () => {
  const bad: string[] = [];
  for (const [id, rules] of bundled.rules) {
    const ids = new Set<number>();
    for (const rule of rules) {
      for (const p of problems(rule)) bad.push(`${id} #${rule.id}: ${p}`);
      if (ids.has(rule.id)) bad.push(`${id}: duplicate id ${rule.id}`);
      ids.add(rule.id);
      // Exceptions have their own id range, so counters can tell them apart.
      if ((rule.action.type === "block") !== (rule.id < ALLOW_ID_BASE)) bad.push(`${id} #${rule.id}: id range`);
    }
  }
  expect(bad.slice(0, 10)).toEqual([]);
});

test("the default lists fit in the rules Chrome guarantees, with nothing trimmed", () => {
  const { meta } = bundled;
  expect(meta.lists.map((l) => l.id)).toEqual(RULESET_ORDER);
  expect(bundled.index).toEqual(RULESET_ORDER.map((id) => ({ id, enabled: true, path: `rules/${id}.json` })));
  expect(meta.enabledRules).toBeLessThanOrEqual(GUARANTEED_STATIC_RULES);
  for (const list of meta.lists) {
    expect(list.trimmedRules, list.id).toBe(0);
    expect(list.regexRules, list.id).toBe(0);
    expect(list.emitted, list.id).toBe(bundled.rules.get(list.id)!.length);
  }
  // Chrome: at most 50 enabled and 100 declared rulesets, 1000 regex rules each.
  expect(bundled.index.length).toBeLessThanOrEqual(50);
  expect(meta.lists.reduce((s, l) => s + l.regexRules, 0)).toBeLessThanOrEqual(MAX_REGEX_RULES);
  expect(DEFAULT_ENABLED_LISTS).toEqual(FILTER_CATALOG.map((l) => l.id));
  console.info(meta.lists.map((l) => `${l.id}: ${l.appRules} app rules, ${l.networkFilters} network, ${l.converted} converted, ${l.emitted} DNR rules (${l.blockRules} block, ${l.allowRules} allow), ${l.groupedDomains} hosts folded, ${l.trimmedRules} trimmed`).join("\n"));
});

test("every network filter is accounted for", () => {
  for (const { id, text } of bundledLists()) {
    const layout = compileList(text);
    const c = convertList(id, layout);
    const elemhide = layout.exceptions.filter((f) => f.wholeSite?.kind === "elemhide").length;
    expect(c.converted + elemhide, id).toBe(c.networkFilters);
    expect(c.rules.reduce((s, r) => s + r.filters, 0), id).toBe(c.converted);
  }
});

test("rules are written most valuable first", () => {
  for (const { id, text } of bundledLists()) {
    const tiers = convertList(id, compileList(text)).rules.map((r) => r.tier);
    expect(tiers, id).toEqual([...tiers].sort((a, b) => a - b));
  }
});

test("over the budget, the least valuable rules of the least valuable lists go first", () => {
  const full = convertList("easyprivacy", compileList(bundledLists().find((l) => l.id === "easyprivacy")!.text)).rules;
  const siteRules = full.filter((r) => r.tier === Tier.SiteBlocks).length;
  const budget = bundled.meta.enabledRules - Math.floor(siteRules / 2);
  const tight = buildRulesets(bundledLists(), { budget });
  expect(tight.meta.enabledRules).toBe(budget);
  const byId = new Map(tight.meta.lists.map((l) => [l.id, l]));
  // EasyPrivacy, last in value order, gives up rules; the others keep theirs.
  expect(byId.get("easyprivacy")!.trimmedRules).toBe(Math.floor(siteRules / 2));
  for (const id of ["cineon-streaming", "ublock", "peterlowe", "easylist"]) expect(byId.get(id)!.trimmedRules, id).toBe(0);
  // Exceptions and the folded host rules are never cut.
  // Lists repeat some lines, so count: the first copies are the ones kept.
  const kept = new Map<string, number>();
  for (const { id: _, ...rule } of tight.rules.get("easyprivacy")!) kept.set(JSON.stringify(rule), (kept.get(JSON.stringify(rule)) ?? 0) + 1);
  const isKept = full.map((r) => {
    const key = JSON.stringify(r.rule);
    const n = kept.get(key) ?? 0;
    if (n > 0) kept.set(key, n - 1);
    return n > 0;
  });
  full.forEach((r, i) => {
    if (r.tier === Tier.DomainBlocks || r.rule.action.type !== "block") expect(isKept[i]).toBe(true);
  });
  // What goes is the end of the ranking: site-specific rules before rules for every site.
  const trimmable = isKept.filter((_, i) => full[i]!.rule.action.type === "block");
  expect(trimmable).toEqual([...trimmable].sort((a, b) => Number(b) - Number(a)));
  expect(full.filter((r, i) => !isKept[i] && r.tier !== Tier.SiteBlocks).length).toBe(0);
  expect(byId.get("easyprivacy")!.trimmedFilters).toBe(byId.get("easyprivacy")!.trimmedRules);
});

test("a list that's off by default doesn't count against the budget", () => {
  const sets = buildRulesets(bundledLists(), { budget: 5_000, enabled: ["cineon-streaming", "ublock", "peterlowe"] });
  expect(sets.meta.lists.every((l) => l.trimmedRules === 0)).toBe(true);
  expect(sets.index.filter((r) => r.enabled).map((r) => r.id)).toEqual(["cineon-streaming", "ublock", "peterlowe"]);
});
