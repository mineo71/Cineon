// Host helpers, ported from windows/Cineon.Core/Shields/SiteDomain.cs. `registrable` is the same
// algorithm as the Mac's DomainName.registrable, so ShieldState keys agree with the apps' data.

const compoundSuffixes = new Set([
  "co.uk", "org.uk", "ac.uk", "me.uk", "com.ua", "org.ua", "net.ua", "in.ua", "kiev.ua", "lviv.ua",
  "co.jp", "or.jp", "ne.jp", "com.au", "net.au", "org.au", "com.br", "net.br", "co.nz", "co.in",
  "co.kr", "com.cn", "com.tw", "com.tr", "com.mx", "com.ar", "co.za", "com.ru", "org.ru", "net.ru",
  "com.pl", "net.pl", "org.pl", "com.de", "co.il", "com.sg", "com.hk", "pp.ua", "biz.ua", "at.ua",
]);

/** `player.vod.example.co.uk` becomes `example.co.uk`. */
export function registrable(host: string): string {
  let h = host.toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  return registrableLower(h);
}

/** Same as `registrable` for a host that is already lowercase. */
export function registrableLower(host: string): string {
  let h = host;
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (isIPAddress(h)) return h;
  if (h.startsWith(".") || h.includes("..")) return registrableByLabels(h);
  const last = h.lastIndexOf(".");
  if (last < 0) return h;
  const second = h.lastIndexOf(".", last - 1);
  if (second < 0) return h;
  const lastTwo = h.slice(second + 1);
  if (!compoundSuffixes.has(lastTwo)) return lastTwo;
  const third = second === 0 ? -1 : h.lastIndexOf(".", second - 1);
  return third < 0 ? h : h.slice(third + 1);
}

/** The Mac's exact steps for hosts with empty labels, where Swift's split skips them. */
function registrableByLabels(h: string): string {
  const labels = h.split(".").filter((l) => l.length > 0);
  if (labels.length <= 2) return h;
  const lastTwo = labels.slice(-2).join(".");
  return compoundSuffixes.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

const int64Min = -(2n ** 63n);
const int64Max = 2n ** 63n - 1n;

/** The Mac's test: a colon, or every dot-separated part a (64-bit, optionally signed) number. */
export function isIPAddress(host: string): boolean {
  if (host.includes(":")) return true;
  for (const part of host.split(".")) {
    if (part.length === 0) continue; // Swift's split drops empty parts.
    if (!/^[+-]?[0-9]+$/.test(part)) return false;
    const value = BigInt(part);
    if (value < int64Min || value > int64Max) return false;
  }
  return true;
}

/** WebKit's `*domain`: the domain itself or any subdomain of it. */
export function isSameOrSubdomain(host: string, domain: string): boolean {
  if (!host.endsWith(domain)) return false;
  return host.length === domain.length || host[host.length - domain.length - 1] === ".";
}

/**
 * The host of a URL, lowercased by the caller: what sits between "://" and the path, without
 * credentials or port. Empty when there is none, as for data: or about: URLs.
 */
export function hostOf(url: string): string {
  const colon = url.indexOf(":");
  if (colon <= 0) return "";
  let start = colon + 1;
  if (url.length < start + 2 || url[start] !== "/" || url[start + 1] !== "/") return "";
  start += 2;
  let rest = url.slice(start);
  const end = rest.search(/[/?#]/);
  if (end >= 0) rest = rest.slice(0, end);
  const at = rest.lastIndexOf("@");
  if (at >= 0) rest = rest.slice(at + 1);
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    return close > 0 ? rest.slice(0, close + 1) : rest;
  }
  const port = rest.indexOf(":");
  if (port >= 0) rest = rest.slice(0, port);
  if (rest.endsWith(".")) rest = rest.slice(0, -1);
  return rest;
}

/** Lowercases ASCII letters only, which is how WebKit compares URLs to filters. */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/** A host, or a URL to take it from, as CssFor and the site keys want it: lowercase, no trailing dot. */
export function normalizeHost(hostOrUrl: string): string {
  const lower = asciiLower(hostOrUrl.trim());
  if (lower.includes("://")) return hostOf(lower);
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}
