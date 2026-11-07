// A small declarativeNetRequest matcher with Chrome's semantics, for checking the generated rules:
// urlFilter's `||`, `|`, `^` and `*`; requestDomains, initiatorDomains, domainType, resource types;
// priorities, with allow and allowAllRequests winning ties; allowAllRequests on the page's own load
// covering everything in it. It reads only the JSON rules, never the filter lists.

import type { DnrResourceType, DnrRule } from "../../src/core/shields/dnrRules";
import { hostOf, isSameOrSubdomain, registrable } from "../../src/core/shields/siteDomain";

export interface DnrRequest {
  url: string;
  type: DnrResourceType;
  /** The origin of the document that made the request; null for a navigation typed or opened by the browser. */
  initiator: string | null;
  /** The top-level page's URL, whose load decides allowAllRequests. For a main_frame request, the URL itself. */
  topUrl: string;
}

interface Compiled {
  rulesetId: string;
  rule: DnrRule;
  regex: RegExp | null;
  /** The urlFilter's longest literal piece, lowercase: a quick no for most URLs. */
  literal: string;
}

function literalOf(filter: string | undefined): string {
  if (filter === undefined) return "";
  return filter.replace(/^\|\|?|\|$/g, "").split(/[*^]/).reduce((a, b) => (b.length > a.length ? b : a), "").toLowerCase();
}

/** Chrome's separator: anything but a letter, digit, `_`, `-`, `.` or `%`; or the end of the URL. */
const separator = "(?:[^A-Za-z0-9_\\-.%]|$)";

/** urlFilter to a regular expression, from the urlFilter syntax alone. */
export function urlFilterRegex(filter: string, caseSensitive: boolean): RegExp {
  let p = filter;
  let prefix = "";
  let suffix = "";
  if (p.startsWith("||")) {
    // The start of the host, or of any label in it.
    prefix = "^[A-Za-z][A-Za-z0-9+.\\-]*://(?:[^/?#@]*@)?(?:[^/?#:@]*\\.)?";
    p = p.slice(2);
  } else if (p.startsWith("|")) {
    prefix = "^";
    p = p.slice(1);
  }
  if (p.endsWith("|")) {
    suffix = "$";
    p = p.slice(0, -1);
  }
  let body = "";
  for (const c of p) {
    if (c === "*") body += ".*";
    else if (c === "^") body += separator;
    else body += c.replace(/[.?+()[\]{}|\\$^]/, "\\$&");
  }
  return new RegExp(prefix + body + suffix, caseSensitive ? "" : "i");
}

const networkScheme = /^(https?|wss?):\/\//i;

function hostIn(host: string, domains: string[] | undefined): boolean {
  return !!domains && domains.some((d) => isSameOrSubdomain(host, d));
}

export class DnrMatcher {
  private readonly rules: Compiled[] = [];

  constructor(rulesets: { id: string; rules: DnrRule[] }[]) {
    for (const set of rulesets) {
      for (const rule of set.rules) {
        const c = rule.condition;
        if (c.regexFilter !== undefined) throw new Error("regexFilter is not expected");
        this.rules.push({
          rulesetId: set.id,
          rule,
          regex: c.urlFilter === undefined ? null : urlFilterRegex(c.urlFilter, c.isUrlFilterCaseSensitive === true),
          literal: literalOf(c.urlFilter),
        });
      }
    }
  }

  private conditionMatches(r: Compiled, url: string, type: DnrResourceType, initiator: string | null, lower = url.toLowerCase()): boolean {
    if (!lower.includes(r.literal)) return false;
    const c = r.rule.condition;
    if (c.resourceTypes) {
      if (!c.resourceTypes.includes(type)) return false;
    } else if (c.excludedResourceTypes) {
      if (c.excludedResourceTypes.includes(type)) return false;
    } else if (type === "main_frame") {
      return false;
    }
    const host = hostOf(url.toLowerCase());
    if (c.requestDomains && !hostIn(host, c.requestDomains)) return false;
    const initiatorHost = initiator === null ? null : hostOf(initiator.toLowerCase());
    if (c.initiatorDomains && (initiatorHost === null || !hostIn(initiatorHost, c.initiatorDomains))) return false;
    if (c.excludedInitiatorDomains && initiatorHost !== null && hostIn(initiatorHost, c.excludedInitiatorDomains)) return false;
    if (c.domainType) {
      const third = initiatorHost !== null && registrable(initiatorHost) !== registrable(host);
      if (third !== (c.domainType === "thirdParty")) return false;
    }
    if (r.regex && !r.regex.test(url)) return false;
    return true;
  }

  /** The highest priority of the allowAllRequests rules matching the page's own load, or 0. */
  private pageAllowance(topUrl: string): number {
    let best = 0;
    for (const r of this.rules) {
      if (r.rule.action.type !== "allowAllRequests") continue;
      if (this.conditionMatches(r, topUrl, "main_frame", null)) best = Math.max(best, r.rule.priority);
    }
    return best;
  }

  /** The rule that decides, or null when none matches. */
  decide(request: DnrRequest): { action: "block" | "allow"; rule: Compiled | null } {
    if (!networkScheme.test(request.url)) return { action: "allow", rule: null };
    let allow = this.pageAllowance(request.topUrl);
    let allowRule: Compiled | null = null;
    let block = 0;
    let blockRule: Compiled | null = null;
    const lower = request.url.toLowerCase();
    for (const r of this.rules) {
      const type = r.rule.action.type;
      if (type === "allowAllRequests") continue; // Counted through the page's load above.
      if (!this.conditionMatches(r, request.url, request.type, request.initiator, lower)) continue;
      if (type === "allow" && r.rule.priority > allow) {
        allow = r.rule.priority;
        allowRule = r;
      } else if (type === "block" && r.rule.priority > block) {
        block = r.rule.priority;
        blockRule = r;
      }
    }
    if (block > 0 && block > allow) return { action: "block", rule: blockRule };
    return { action: "allow", rule: allowRule };
  }

  blocks(request: DnrRequest): boolean {
    return this.decide(request).action === "block";
  }
}

/** The apps' request description (WebView2 contexts) as a DNR request. */
export function dnrRequest(url: string, page: string | null, type: string, mainFrame: boolean): DnrRequest {
  const dnrType: DnrResourceType =
    type === "Document" ? (mainFrame ? "main_frame" : "sub_frame")
    : type === "Script" ? "script"
    : type === "Image" ? "image"
    : type === "XmlHttpRequest" || type === "Fetch" ? "xmlhttprequest"
    : type === "Stylesheet" ? "stylesheet"
    : type === "Media" ? "media"
    : type === "Font" ? "font"
    : type === "Websocket" ? "websocket"
    : type === "Ping" ? "ping"
    : "other";
  // The apps judge a request without a page against its own URL: the page is the URL itself.
  const top = mainFrame ? url : page ?? url;
  return { url, type: dnrType, initiator: mainFrame ? null : top, topUrl: top };
}
