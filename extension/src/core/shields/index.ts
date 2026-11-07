// Shields: filter lists as declarativeNetRequest rulesets, element hiding, per-site switches and
// counts. See notes/shields.md.

export { FILTER_CATALOG, DEFAULT_ENABLED_LISTS, RULESET_ORDER, type FilterListInfo } from "./catalog";
export { ShieldState, type ShieldStore, type SitePrefs, type ShieldCounts, type ShieldStateOptions } from "./shieldState";
export {
  ShieldRules, chromeDnr, popupAllowed, redirectShieldActive, isBlockingMatch, isStaticRuleset,
  SITES_OFF_RULE_ID, SHIELD_DYNAMIC_IDS,
  type DnrApi, type ShieldSettings, type ApplyResult, type MatchedRule, type MatchedRuleDebug,
} from "./shieldRules";
export { ShieldCounter, counterMode, POLL_MINUTES, type CounterMode, type CounterCheckpoint } from "./shieldCounter";
export { CosmeticIndex, loadCosmeticIndex, type CosmeticMap } from "./cosmetic";
export { ALLOW_ID_BASE, Priority, GUARANTEED_STATIC_RULES, type DnrRule, type RulesetMeta } from "./dnrRules";
export { registrable, normalizeHost } from "./siteDomain";
