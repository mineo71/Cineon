// Element hiding: the CSS the apps' ShieldEngine.CssFor(host) builds, from per-list maps made at
// build time (build/cosmetic/<id>.json). The background injects it into every frame of a page,
// keyed by the top-level page's host, as the apps do.

import type { RuleLayout } from "./filterConverter";
import { FILTER_CATALOG } from "./catalog";
import { isSameOrSubdomain, normalizeHost } from "./siteDomain";

/** One list's element-hiding rules, as written to build/cosmetic/<id>.json. */
export interface CosmeticMap {
  /** Generic rules, already a stylesheet: the same on every site. */
  generic: string;
  /** Generic rules with exceptions, and "~site##" rules: the selector and the sites it skips. */
  unless: [selector: string, domains: string[]][];
  /** Site rules' selectors (each up to 200 joined by commas)... */
  specific: string[];
  /** ...and which of them apply on each domain and its subdomains. */
  hosts: Record<string, number[]>;
  /** Sites the list leaves alone: "@@||site^$document", "$elemhide", "$generichide". */
  except: string[];
}

/** WebKit's content-blocker stylesheet rule. */
export function cssRule(selector: string): string {
  return `${selector}{display:none !important;}\n`;
}

/** Build time: the map for one laid-out list. */
export function cosmeticMap(layout: RuleLayout): CosmeticMap {
  const map: CosmeticMap = { generic: "", unless: [], specific: [], hosts: {}, except: [] };
  const hosts = new Map<string, number[]>();
  for (const rule of layout.cosmetic) {
    if (rule.ifDomains) {
      const index = map.specific.length;
      map.specific.push(rule.selector);
      for (const domain of rule.ifDomains) {
        let list = hosts.get(domain);
        if (!list) hosts.set(domain, (list = []));
        list.push(index);
      }
    } else if (rule.unlessDomains) {
      map.unless.push([rule.selector, rule.unlessDomains]);
    } else {
      map.generic += cssRule(rule.selector);
    }
  }
  map.hosts = Object.fromEntries(hosts);
  map.except = layout.exceptions.flatMap((f) => (f.wholeSite ? [f.wholeSite.domain] : []));
  return map;
}

interface LoadedList {
  id: string;
  generic: string;
  unless: [string, string[]][];
  specific: string[];
  hosts: Map<string, number[]>;
  except: Set<string>;
}

const cacheLimit = 256;

/** Runtime: every bundled list's map, ready to answer `cssFor(host)`. */
export class CosmeticIndex {
  private readonly lists: LoadedList[];
  private readonly cache = new Map<string, string>();

  /** Lists are kept in catalog order, which is the order the apps join their CSS in. */
  constructor(maps: { id: string; map: CosmeticMap }[]) {
    const rank = (id: string) => {
      const i = FILTER_CATALOG.findIndex((l) => l.id === id);
      return i < 0 ? FILTER_CATALOG.length : i;
    };
    this.lists = [...maps]
      .sort((a, b) => rank(a.id) - rank(b.id))
      .map(({ id, map }) => ({
        id,
        generic: map.generic,
        unless: map.unless,
        specific: map.specific,
        hosts: new Map(Object.entries(map.hosts)),
        except: new Set(map.except),
      }));
  }

  get ids(): string[] {
    return this.lists.map((l) => l.id);
  }

  /**
   * The element-hiding stylesheet for pages on `host` (a host, or a URL to take it from), from
   * the lists in `active` (all of them when left out). "" when nothing applies.
   */
  cssFor(host: string, active?: Iterable<string>): string {
    const key = normalizeHost(host);
    const on = active ? new Set(active) : null;
    const lists = on ? this.lists.filter((l) => on.has(l.id)) : this.lists;
    if (lists.length === 0) return "";
    const cacheKey = `${lists.map((l) => l.id).join(",")}|${key}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const css = lists.map((list) => this.listCss(list, key)).join("");
    if (this.cache.size >= cacheLimit) this.cache.clear();
    this.cache.set(cacheKey, css);
    return css;
  }

  private listCss(list: LoadedList, host: string): string {
    if (leftAlone(list, host)) return "";
    let css = list.generic;
    for (const [selector, domains] of list.unless) {
      if (!domains.some((d) => isSameOrSubdomain(host, d))) css += cssRule(selector);
    }
    if (host.length > 0) {
      const indexes: number[] = [];
      for (const start of suffixes(host)) {
        const found = list.hosts.get(host.slice(start));
        if (found) indexes.push(...found);
      }
      indexes.sort((a, b) => a - b);
      let previous = -1;
      for (const i of indexes) {
        if (i === previous) continue;
        previous = i;
        css += cssRule(list.specific[i]!);
      }
    }
    return css;
  }
}

/** Whether the list has a whole-site exception for this host or a parent domain of it. */
function leftAlone(list: LoadedList, host: string): boolean {
  if (list.except.size === 0 || host.length === 0) return false;
  for (let start = 0; start < host.length;) {
    if (list.except.has(host.slice(start))) return true;
    const dot = host.indexOf(".", start);
    if (dot < 0) break;
    start = dot + 1;
  }
  return false;
}

/** Start indexes of the host and each of its parent domains: a.b.c gives a.b.c, b.c, c. */
function suffixes(host: string): number[] {
  const starts = [0];
  for (let i = 0; i < host.length; i++) {
    if (host[i] === "." && i + 1 < host.length) starts.push(i + 1);
  }
  return starts;
}

/**
 * Loads the bundled maps. `read` gets a path inside the extension ("cosmetic/easylist.json") and
 * returns its JSON; in the service worker that's a fetch of chrome.runtime.getURL(path).
 */
export async function loadCosmeticIndex(ids: readonly string[], read: (path: string) => Promise<unknown>): Promise<CosmeticIndex> {
  const maps = await Promise.all(
    ids.map(async (id) => {
      try {
        return { id, map: (await read(`cosmetic/${id}.json`)) as CosmeticMap };
      } catch {
        return null;
      }
    }),
  );
  return new CosmeticIndex(maps.filter((m): m is { id: string; map: CosmeticMap } => m !== null));
}
