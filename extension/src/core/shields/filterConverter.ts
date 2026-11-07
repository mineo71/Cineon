// Reads Adblock Plus syntax filter lists exactly the way the apps' FilterConverter does
// (Cineon/Shields/FilterConverter.swift, windows/Cineon.Core/Shields/FilterConverter.cs): the same
// lines are supported and the same are skipped (procedural cosmetics, scriptlets, regular
// expressions, csp=, redirect=, popup and every other option WebKit can't express).
//
// The apps hand the parsed rules to WebKit (or their own matcher on Windows). Here they become
// declarativeNetRequest rules (dnrRules.ts) and per-host cosmetic maps (cosmetic.ts).
// No browser APIs: this runs at build time (scripts/filters.mjs) and in tests on Node.

/** WebKit rejects lists over 150,000 rules, so the apps cap them. Kept so counts agree with theirs. */
export const MAX_RULES = 145_000;

/** Generic selectors are joined into one stylesheet rule per 200, as on the Mac. */
export const COSMETIC_BATCH = 200;

/** WebKit content-blocker resource types: what the apps' rules carry. */
export type KitType = "document" | "image" | "style-sheet" | "script" | "font" | "media" | "fetch" | "websocket" | "other" | "ping";

/** The list FilterConverter.swift uses when a rule excludes types. */
export const KIT_TYPES: readonly KitType[] = ["document", "image", "style-sheet", "script", "font", "media", "fetch", "websocket", "other", "ping"];

export type Anchor = "none" | "start" | "host";

/** A pattern as the Mac reads it: the anchors, then a body where `*` is any run and `^` a separator. */
export interface PatternParts {
  anchor: Anchor;
  body: string;
  end: boolean;
}

/** One network rule, with the same fields as the WebKit trigger the Mac emits, plus `important`. */
export interface NetworkFilter {
  text: string;
  isException: boolean;
  /**
   * Whole-site exceptions ("@@||site^$document", also $elemhide and $generichide, which the apps treat
   * the same way): the list leaves this site, and its subdomains, alone.
   */
  wholeSite: { domain: string; kind: "document" | "elemhide" } | null;
  pattern: string;
  parts: PatternParts;
  caseSensitive: boolean;
  /** WebKit resource types; empty means all. Already the full list minus exclusions when `excludedTypes` is set. */
  types: KitType[];
  /** The types the rule excluded ("~script"), which DNR can say directly. */
  excludedTypes: KitType[];
  loadType: "third-party" | "first-party" | null;
  /** $subdocument: only frames. */
  childFrameOnly: boolean;
  ifDomains: string[];
  unlessDomains: string[];
  /** $important. The apps ignore it; DNR gives it a higher priority than exceptions. */
  important: boolean;
}

/** A css-display-none rule. The selector may be up to 200 selectors joined by commas. */
export interface CosmeticRule {
  selector: string;
  ifDomains: string[] | null;
  unlessDomains: string[] | null;
}

/** A list as parsed, before it's laid out into rules. */
export interface ParsedList {
  genericSelectors: string[];
  genericExceptions: Map<string, string[]>;
  /** Domains joined by "," to selectors, in first-seen order. */
  domainSelectors: Map<string, string[]>;
  unlessSelectors: Map<string, string[]>;
  blocks: NetworkFilter[];
  exceptions: NetworkFilter[];
  skipped: number;
}

/** The Mac's rule array: cosmetic rules, then blocks, then exceptions, capped the same way. */
export interface RuleLayout {
  cosmetic: CosmeticRule[];
  blocks: NetworkFilter[];
  exceptions: NetworkFilter[];
  skipped: number;
  /** What the apps count and show in Settings for this list. */
  ruleCount: number;
}

// MARK: Parsing

export function parseList(text: string): ParsedList {
  const list: ParsedList = {
    genericSelectors: [],
    genericExceptions: new Map(),
    domainSelectors: new Map(),
    unlessSelectors: new Map(),
    blocks: [],
    exceptions: [],
    skipped: 0,
  };
  for (const raw of lines(text)) {
    const line = trimWhitespace(raw);
    if (line.length === 0 || line[0] === "!" || line[0] === "[") continue;

    const cosmetic = parseCosmetic(line);
    if (cosmetic.kind !== "not-cosmetic") {
      switch (cosmetic.kind) {
        case "skip":
          list.skipped++;
          break;
        case "generic":
          list.genericSelectors.push(cosmetic.selector);
          break;
        case "only":
          group(list.domainSelectors, cosmetic.domains.join(",")).push(cosmetic.selector);
          break;
        case "except":
          group(list.unlessSelectors, cosmetic.domains.join(",")).push(cosmetic.selector);
          break;
        case "exception":
          group(list.genericExceptions, cosmetic.selector).push(...cosmetic.domains);
          break;
      }
      continue;
    }

    const network = parseNetwork(line);
    if (!network) {
      list.skipped++;
      continue;
    }
    if (network.isException) list.exceptions.push(network);
    else list.blocks.push(network);
  }
  return list;
}

function group(groups: Map<string, string[]>, key: string): string[] {
  let values = groups.get(key);
  if (!values) {
    values = [];
    groups.set(key, values);
  }
  return values;
}

/** Line breaks as Foundation's enumerateLines sees them. */
function* lines(text: string): Generator<string> {
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\n" || c === "\r" || c === "\u0085" || c === " " || c === " ") {
      yield text.slice(start, i);
      if (c === "\r" && text[i + 1] === "\n") i++;
      start = i + 1;
    }
    i++;
  }
  if (start < text.length) yield text.slice(start);
}

/** Swift's `.whitespaces`: tabs and Unicode space separators. */
const edgeWhitespace = /^[\t\p{Zs}]+|[\t\p{Zs}]+$/gu;

function trimWhitespace(s: string): string {
  return s.replace(edgeWhitespace, "");
}

// MARK: Cosmetic filters

type Cosmetic =
  | { kind: "not-cosmetic" }
  | { kind: "skip" }
  | { kind: "generic"; selector: string }
  | { kind: "only" | "except" | "exception"; domains: string[]; selector: string };

const proceduralMarkers = [
  ":-abp-", ":has-text", ":contains(", ":xpath", ":style(", ":upward", ":remove(", ":matches-",
  ":min-text-length", ":watch-attr", ":if(", ":if-not", ":nth-ancestor", ":others(", ":-ext-", ":remove-attr",
  ":remove-class", ":matches-path", ":matches-css", ":matches-attr", ":matches-prop",
];

const advancedMarkers = ["#?#", "#$#", "#%#", "#@?#", "#@$#", "##+js", "##^", "$$", "#@%#"];

export function parseCosmetic(line: string): Cosmetic {
  // Advanced syntaxes have no WebKit equivalent.
  for (const marker of advancedMarkers) {
    if (!line.includes(marker)) continue;
    if (marker === "$$" && !line.includes("##")) continue;
    return { kind: "skip" };
  }
  const exception = line.indexOf("#@#");
  if (exception >= 0) {
    const only = parseCosmeticDomains(line.slice(0, exception)).only;
    const selector = line.slice(exception + 3);
    if (!isUsableSelector(selector) || only.length === 0) return { kind: "skip" };
    return { kind: "exception", domains: only, selector };
  }
  const hide = line.indexOf("##");
  if (hide < 0) return { kind: "not-cosmetic" };

  const selector = trimWhitespace(line.slice(hide + 2));
  if (!isUsableSelector(selector)) return { kind: "skip" };

  const prefix = line.slice(0, hide);
  if (prefix.length === 0) return { kind: "generic", selector };

  const parsed = parseCosmeticDomains(prefix);
  if (parsed.invalid) return { kind: "skip" };
  if (parsed.only.length > 0) return { kind: "only", domains: parsed.only, selector };
  if (parsed.except.length > 0) return { kind: "except", domains: parsed.except, selector };
  return { kind: "skip" };
}

function parseCosmeticDomains(text: string): { only: string[]; except: string[]; invalid: boolean } {
  const only: string[] = [];
  const except: string[] = [];
  for (const part of text.split(",")) {
    if (part.length === 0) continue;
    const negated = part.startsWith("~");
    const name = (negated ? part.slice(1) : part).toLowerCase();
    if (!isPlainDomain(name)) return { only: [], except: [], invalid: true };
    if (negated) except.push(name);
    else only.push(name);
  }
  return { only, except, invalid: false };
}

function isPrintableAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c >= 128) return false;
  }
  return true;
}

function isUsableSelector(selector: string): boolean {
  if (selector.length === 0 || !isPrintableAscii(selector)) return false;
  return !proceduralMarkers.some((marker) => selector.includes(marker));
}

// MARK: Network filters

export function parseNetwork(raw: string): NetworkFilter | null {
  let line = raw;
  const isException = line.startsWith("@@");
  if (isException) line = line.slice(2);

  // Regular expression rules rarely fit WebKit's subset, and they are few. Skip them.
  if (line.startsWith("/") && (line.endsWith("/") || line.includes("/$"))) return null;

  let options: string[] = [];
  const dollar = line.lastIndexOf("$");
  if (dollar >= 0 && dollar + 1 < line.length && line.indexOf("/", dollar + 1) < 0) {
    options = line.slice(dollar + 1).split(",").filter((o) => o.length > 0);
    line = line.slice(0, dollar);
  }

  let loadType: NetworkFilter["loadType"] = null;
  const ifDomains: string[] = [];
  let unlessDomains: string[] = [];
  let types: KitType[] = [];
  const excludedTypes = new Set<KitType>();
  let caseSensitive = false;
  let childFrameOnly = false;
  let wholeSite: "document" | "elemhide" | null = null;
  let important = false;

  for (const option of options) {
    const lower = option.toLowerCase();
    switch (lower) {
      case "third-party": case "3p": loadType = "third-party"; break;
      case "~third-party": case "first-party": case "1p": case "~3p": loadType = "first-party"; break;
      case "script": types.push("script"); break;
      case "image": types.push("image"); break;
      case "stylesheet": case "css": types.push("style-sheet"); break;
      case "font": types.push("font"); break;
      case "media": types.push("media"); break;
      case "xmlhttprequest": case "xhr": types.push("fetch"); break;
      case "websocket": types.push("websocket"); break;
      case "other": types.push("other"); break;
      case "ping": types.push("ping"); break;
      case "subdocument": case "frame":
        types.push("document");
        childFrameOnly = true;
        break;
      case "~script": excludedTypes.add("script"); break;
      case "~image": excludedTypes.add("image"); break;
      case "~stylesheet": excludedTypes.add("style-sheet"); break;
      case "~font": excludedTypes.add("font"); break;
      case "~media": excludedTypes.add("media"); break;
      case "~xmlhttprequest": excludedTypes.add("fetch"); break;
      case "~subdocument": excludedTypes.add("document"); break;
      case "match-case": caseSensitive = true; break;
      case "important": important = true; break;
      case "all": case "first-party-only": break;
      case "document": case "doc":
        if (!isException) return null;
        wholeSite = "document";
        break;
      case "elemhide": case "ehide": case "generichide": case "ghide":
        if (!isException) return null;
        wholeSite ??= "elemhide";
        break;
      case "popup": case "popunder":
        // Handled by the pop-up shield, which sees the real target before it opens.
        return null;
      default:
        if (lower.startsWith("domain=") || lower.startsWith("from=")) {
          const domainList = option.slice(option.indexOf("=") + 1);
          for (const part of domainList.split("|")) {
            if (part.length === 0) continue;
            const negated = part.startsWith("~");
            const name = (negated ? part.slice(1) : part).toLowerCase();
            if (!isPlainDomain(name)) return null;
            if (negated) unlessDomains.push(name);
            else ifDomains.push(name);
          }
        } else {
          // csp=, redirect=, removeparam=, badfilter and so on have no equivalent.
          return null;
        }
    }
  }

  // WebKit allows if-domain or unless-domain on a rule, never both.
  if (ifDomains.length > 0 && unlessDomains.length > 0) unlessDomains = [];

  if (excludedTypes.size > 0) types = KIT_TYPES.filter((t) => !excludedTypes.has(t));

  const base = { text: raw, caseSensitive, types, excludedTypes: [...excludedTypes], loadType, childFrameOnly, ifDomains, unlessDomains, important };

  // Whole-site exceptions: "@@||example.com^$document" turns everything off for that site.
  if (wholeSite) {
    const domain = hostAnchoredDomain(line);
    if (domain === null) return null;
    return { ...base, isException: true, wholeSite: { domain, kind: wholeSite }, pattern: line, parts: { anchor: "host", body: domain, end: false } };
  }

  if (!(line.length >= 4 || line.startsWith("||"))) return null;
  const parts = splitPattern(line);
  if (!parts) return null;
  return { ...base, isException, wholeSite: null, pattern: line, parts };
}

/** "||example.com^" gives "example.com". Anything with a path is not a whole-site rule. */
function hostAnchoredDomain(pattern: string): string | null {
  if (!pattern.startsWith("||")) return null;
  let rest = pattern.slice(2);
  if (rest.endsWith("^")) rest = rest.slice(0, -1);
  const lower = rest.toLowerCase();
  return isPlainDomain(lower) ? lower : null;
}

/**
 * Splits an ABP pattern the way the Mac's `urlFilter(from:)` reads it: the anchors, then the body
 * with leading and trailing `*` dropped. Null for patterns the Mac rejects: non-ASCII, empty, or
 * fewer than three literal characters.
 */
export function splitPattern(pattern: string): PatternParts | null {
  if (!isPrintableAscii(pattern)) return null;
  let p = pattern;
  let anchor: Anchor = "none";
  let end = false;
  if (p.startsWith("||")) {
    p = p.slice(2);
    anchor = "host";
  } else if (p.startsWith("|")) {
    p = p.slice(1);
    anchor = "start";
  }
  if (p.endsWith("|")) {
    p = p.slice(0, -1);
    end = true;
  }
  let from = 0;
  let to = p.length;
  while (from < to && p[from] === "*") from++;
  while (to > from && p[to - 1] === "*") to--;
  p = p.slice(from, to);
  if (p.length === 0) return null;

  // A pattern this short, with no anchor, would match half the web.
  let literal = 0;
  for (const c of p) if (c !== "*" && c !== "^") literal++;
  if (literal < 3) return null;
  return { anchor, body: p, end };
}

/** The Mac's translation of a pattern to WebKit's regular expression subset. */
export function webkitUrlFilter(pattern: string): string | null {
  const parts = splitPattern(pattern);
  if (!parts) return null;
  let out = parts.anchor === "host" ? "^[^:]+://+([^:/]+\\.)?" : parts.anchor === "start" ? "^" : "";
  let previousWasWildcard = false;
  for (const c of parts.body) {
    if (c === "*") {
      if (!previousWasWildcard) out += ".*";
      previousWasWildcard = true;
      continue;
    }
    if (c === "^") out += "[/:&?=]?";
    else if (".?+()[]{}|\\$".includes(c)) out += "\\" + c;
    else out += c;
    previousWasWildcard = false;
  }
  if (parts.end) out += "$";
  return out;
}

export function isPlainDomain(s: string): boolean {
  if (s.length === 0 || !(s.includes(".") || s.length > 1)) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 46;
    if (!ok) return false;
  }
  return !s.startsWith(".") && !s.endsWith(".");
}

// MARK: Layout

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The apps' RuleLayout.From: cosmetic rules, then blocks, then exceptions, capped at `maxRules`. */
export function layoutList(parsed: ParsedList, maxRules = MAX_RULES): RuleLayout {
  let cosmetic: CosmeticRule[] = [];

  // Generic cosmetic rules first, batched: one combined stylesheet rule per 200 selectors.
  const plainGeneric: string[] = [];
  for (const selector of parsed.genericSelectors) {
    const domains = parsed.genericExceptions.get(selector);
    if (domains && domains.length > 0) cosmetic.push({ selector, ifDomains: null, unlessDomains: [...domains] });
    else plainGeneric.push(selector);
  }
  for (const batch of chunk(plainGeneric, COSMETIC_BATCH)) cosmetic.push({ selector: batch.join(","), ifDomains: null, unlessDomains: null });

  for (const [joined, selectors] of parsed.domainSelectors) {
    const domains = joined.split(",").filter((d) => d.length > 0);
    for (const batch of chunk(selectors, COSMETIC_BATCH)) cosmetic.push({ selector: batch.join(","), ifDomains: domains, unlessDomains: null });
  }
  for (const [joined, selectors] of parsed.unlessSelectors) {
    const domains = joined.split(",").filter((d) => d.length > 0);
    for (const batch of chunk(selectors, COSMETIC_BATCH)) cosmetic.push({ selector: batch.join(","), ifDomains: null, unlessDomains: domains });
  }

  let blocks = parsed.blocks;
  let exceptions = parsed.exceptions;
  let skipped = parsed.skipped;
  const total = cosmetic.length + blocks.length + exceptions.length;
  if (total > maxRules) {
    // Keep exceptions: dropping them would break sites rather than just miss an ad.
    const keepFromStart = Math.max(0, maxRules - exceptions.length);
    skipped += total - maxRules;
    const keepCosmetic = Math.min(cosmetic.length, keepFromStart);
    const keepBlocks = Math.min(blocks.length, keepFromStart - keepCosmetic);
    cosmetic = cosmetic.slice(0, keepCosmetic);
    blocks = blocks.slice(0, keepBlocks);
    exceptions = exceptions.slice(0, Math.min(exceptions.length, maxRules));
  }
  return { cosmetic, blocks, exceptions, skipped, ruleCount: cosmetic.length + blocks.length + exceptions.length };
}

/** Parse and lay out, as the apps' `FilterList.Compile` does. */
export function compileList(text: string, maxRules = MAX_RULES): RuleLayout {
  return layoutList(parseList(text), maxRules);
}
