import { buildRulesets, type DnrRule } from "../../src/core/shields/dnrRules";
import { compileList } from "../../src/core/shields/filterConverter";
import { CosmeticIndex, cosmeticMap } from "../../src/core/shields/cosmetic";
import { DnrMatcher, dnrRequest } from "./dnrMatcher";
import type { RequestType } from "./corpus";

/** Lists named list0, list1... (or as given), converted to rulesets the way the build does. */
export function rulesetsOf(lists: (string | { id: string; text: string })[]): Map<string, DnrRule[]> {
  const sources = lists.map((l, i) => (typeof l === "string" ? { id: `list${i}`, text: l } : l));
  return buildRulesets(sources, { budget: Number.POSITIVE_INFINITY }).rules;
}

/** A DNR matcher over the given lists, all switched on, plus any dynamic rules. */
export function engine(lists: (string | { id: string; text: string })[], dynamic: DnrRule[] = []): DnrMatcher {
  const sets = [...rulesetsOf(lists)].map(([id, rules]) => ({ id, rules }));
  return new DnrMatcher([...sets, { id: "_dynamic", rules: dynamic }]);
}

export function blocks(m: DnrMatcher, url: string, page: string | null = null, type: RequestType = "Script", mainFrame = false): boolean {
  return m.blocks(dnrRequest(url, page, type, mainFrame));
}

/** Element hiding over the given lists. */
export function cosmetic(lists: (string | { id: string; text: string })[]): CosmeticIndex {
  return new CosmeticIndex(lists.map((l, i) => (typeof l === "string" ? { id: `list${i}`, text: l } : l)).map(({ id, text }) => ({ id, map: cosmeticMap(compileList(text)) })));
}

/** The one ruleset of a single list. */
export function rulesOf(text: string): DnrRule[] {
  return rulesetsOf([text]).get("list0")!;
}
