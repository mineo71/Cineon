// The apps' matcher, written plainly from the parsed filters: every rule tried, each list on its
// own, as the Windows ShieldEngine and the Mac's WebKit rules do. Its `Semantics` switches turn on,
// one by one, the differences the DNR conversion makes on purpose, so the tests can show that with
// all of them on it agrees with the DNR rules exactly, and count what each one changes.

import { KIT_TYPES, parseList, webkitUrlFilter, type KitType, type NetworkFilter } from "../../src/core/shields/filterConverter";
import { domainOf } from "../../src/core/shields/dnrRules";
import { asciiLower, hostOf, isSameOrSubdomain, registrableLower } from "../../src/core/shields/siteDomain";
import type { Request } from "./corpus";

export interface Semantics {
  /** `^`: the Mac's optional one of /:&?= ("mac"), or a separator character or the end ("dnr"). */
  separator: "mac" | "dnr";
  /**
   * `||`: the Mac's "^[^:]+://+([^:/]+\.)?" ("mac"), or the start of any label of the host, with
   * "||host^" rules comparing the URL's host itself, as requestDomains does ("dnr").
   */
  hostAnchor: "mac" | "dnr";
  /** An exception cancels blocks from its own list ("list"), or from every list ("all"). */
  exceptions: "list" | "all";
  /** $important is ignored ("ignored"), or beats exceptions ("wins"). */
  important: "ignored" | "wins";
  /** Whole-site exceptions: any kind turns its own list off ("list"), or only $document, every list ("document-all"). */
  wholeSite: "list" | "document-all";
  /** Untyped rules also stop top-level navigations: all of them ("all") or "||host^" rules only ("host"). */
  mainFrame: "all" | "host";
  /** "$script,subdocument": frames only ("frames"), or scripts and frames ("union"). */
  subdocument: "frames" | "union";
  /** Which URLs rules apply to: anything but data: ("any"), or http(s) and ws(s) ("network"). */
  schemes: "any" | "network";
}

export const APPS: Semantics = {
  separator: "mac", hostAnchor: "mac", exceptions: "list", important: "ignored", wholeSite: "list", mainFrame: "all", subdocument: "frames", schemes: "any",
};

export const DNR: Semantics = {
  separator: "dnr", hostAnchor: "dnr", exceptions: "all", important: "wins", wholeSite: "document-all", mainFrame: "host", subdocument: "union", schemes: "network",
};

interface Rule {
  filter: NetworkFilter;
  regex: RegExp;
  list: number;
  /** The longest literal piece of the pattern, lowercase: a URL without it can't match. */
  literal: string;
}

export function longestLiteral(body: string): string {
  return body.split(/[*^]/).reduce((a, b) => (b.length > a.length ? b : a), "").toLowerCase();
}

const dnrSeparator = "(?:[^A-Za-z0-9_\\-.%]|$)";

function regexFor(filter: NetworkFilter, s: Semantics): RegExp {
  const flags = filter.caseSensitive ? "" : "i";
  if (s.separator === "mac" && s.hostAnchor === "mac") return new RegExp(webkitUrlFilter(filter.pattern)!, flags);
  const { anchor, body, end } = filter.parts;
  let out = anchor === "host"
    ? s.hostAnchor === "mac" ? "^[^:]+://+([^:/]+\\.)?" : "^[A-Za-z][A-Za-z0-9+.\\-]*://(?:[^/?#@]*@)?(?:[^/?#:@]*\\.)?"
    : anchor === "start" ? "^" : "";
  for (const c of body) {
    if (c === "*") out += ".*";
    else if (c === "^") out += s.separator === "mac" ? "[/:&?=]?" : dnrSeparator;
    else out += ".?+()[]{}|\\$".includes(c) ? "\\" + c : c;
  }
  if (end) out += "$";
  return new RegExp(out, flags);
}

function kitType(type: Request["type"]): KitType {
  switch (type) {
    case "Document": return "document";
    case "Stylesheet": return "style-sheet";
    case "Image": return "image";
    case "Media": return "media";
    case "Font": return "font";
    case "Script": return "script";
    case "XmlHttpRequest": case "Fetch": return "fetch";
    case "Websocket": return "websocket";
    case "Ping": return "ping";
    default: return "other";
  }
}

export class AppsMatcher {
  private readonly blocks: Rule[] = [];
  private readonly exceptions: Rule[] = [];
  private readonly wholeSite: { domain: string; kind: "document" | "elemhide"; list: number }[] = [];

  constructor(lists: { id: string; text: string }[], private readonly s: Semantics = APPS) {
    lists.forEach(({ text }, list) => {
      const parsed = parseList(text);
      for (const filter of [...parsed.blocks, ...parsed.exceptions]) {
        if (filter.wholeSite) {
          this.wholeSite.push({ ...filter.wholeSite, list });
          continue;
        }
        (filter.isException ? this.exceptions : this.blocks).push({ filter, regex: regexFor(filter, s), list, literal: longestLiteral(filter.parts.body) });
      }
    });
  }

  private matches(rule: Rule, r: Request, url: string, lower: string, docHost: string): boolean {
    if (!lower.includes(rule.literal)) return false;
    const f = rule.filter;
    const kit = kitType(r.type);
    const page = r.type === "Document" && r.mainFrame;
    const childFrame = r.type === "Document" && !r.mainFrame;
    const types = f.types.length > 0 ? f.types : KIT_TYPES;
    if (!types.includes(kit)) return false;
    if (this.s.subdocument === "frames") {
      if (f.childFrameOnly && !childFrame) return false;
    }
    if (page) {
      if (this.s.mainFrame === "host") {
        const plainHost = domainOf(f) !== null && f.loadType === null && f.ifDomains.length === 0 && f.unlessDomains.length === 0;
        if (!plainHost) return false;
      }
      if (f.childFrameOnly) return false;
    }
    const domain = this.s.hostAnchor === "dnr" ? domainOf(f) : null;
    if (domain !== null) {
      if (!isSameOrSubdomain(hostOf(asciiLower(url)), domain)) return false;
    } else if (!rule.regex.test(url)) {
      return false;
    }
    if (f.loadType) {
      const site = registrableLower(docHost);
      const third = site.length === 0 || !isSameOrSubdomain(hostOf(asciiLower(url)), site);
      if (third !== (f.loadType === "third-party")) return false;
    }
    if (f.ifDomains.length > 0 && !f.ifDomains.some((d) => isSameOrSubdomain(docHost, d))) return false;
    if (f.unlessDomains.length > 0 && f.unlessDomains.some((d) => isSameOrSubdomain(docHost, d))) return false;
    return true;
  }

  blocksRequest(r: Request): boolean {
    const url = r.url;
    if (/^data:/i.test(url)) return false;
    if (this.s.schemes === "network" && !/^(https?|wss?):\/\//i.test(url)) return false;
    const docHost = hostOf(asciiLower(r.page ?? url));
    const lower = url.toLowerCase();

    const off = new Set<number>();
    for (const w of this.wholeSite) {
      if (!isSameOrSubdomain(docHost, w.domain)) continue;
      if (this.s.wholeSite === "list") off.add(w.list);
      else if (w.kind === "document") return false;
    }
    const blocked = new Set<number>();
    let important = false;
    for (const rule of this.blocks) {
      if (off.has(rule.list) || !this.matches(rule, r, url, lower, docHost)) continue;
      blocked.add(rule.list);
      if (rule.filter.important) important = true;
    }
    if (blocked.size === 0) return false;
    if (this.s.important === "wins" && important) return true;
    const excepted = new Set<number>();
    for (const rule of this.exceptions) {
      if (off.has(rule.list) || !this.matches(rule, r, url, lower, docHost)) continue;
      excepted.add(rule.list);
    }
    if (this.s.exceptions === "all") return excepted.size === 0;
    return [...blocked].some((list) => !excepted.has(list));
  }
}
