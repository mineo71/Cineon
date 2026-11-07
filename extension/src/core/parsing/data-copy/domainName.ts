// A copy of the data layer's DomainName (Swift's in Core/Models.swift, C#'s in Data/Models.cs), kept
// here until src/core/data lands; then this file should re-export that one.

import * as SwiftText from "../swiftText";

/** Second-level suffixes that behave like TLDs. Enough for sites people actually visit. */
const COMPOUND_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "me.uk", "com.ua", "org.ua", "net.ua", "in.ua", "kiev.ua", "lviv.ua",
  "co.jp", "or.jp", "ne.jp", "com.au", "net.au", "org.au", "com.br", "net.br", "co.nz", "co.in",
  "co.kr", "com.cn", "com.tw", "com.tr", "com.mx", "com.ar", "co.za", "com.ru", "org.ru", "net.ru",
  "com.pl", "net.pl", "org.pl", "com.de", "co.il", "com.sg", "com.hk", "pp.ua", "biz.ua", "at.ua",
]);

/** `player.vod.example.co.uk` becomes `example.co.uk`. */
function registrable(host: string): string {
  let h = SwiftText.lowercased(host);
  if (SwiftText.hasSuffix(h, ".")) h = SwiftText.dropLast(h);
  if (isIPAddress(h)) return h;
  const labels = SwiftText.split(h, ".");
  if (labels.length <= 2) return h;
  const lastTwo = labels.slice(-2).join(".");
  return COMPOUND_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

function isSameSite(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  return registrable(a) === registrable(b);
}

function isIPAddress(host: string): boolean {
  return SwiftText.contains(host, ":") || SwiftText.split(host, ".").every((label) => SwiftText.int(label) !== null);
}

/** `example.co.uk` becomes `Example`. Used for names and to spot the site in page titles. */
function displayName(host: string): string {
  const reg = registrable(host);
  const first = SwiftText.split(reg, ".")[0] ?? reg;
  return SwiftText.uppercased(SwiftText.first(first) ?? "") + SwiftText.dropFirst(first);
}

export const DomainName = Object.freeze({ registrable, isSameSite, isIPAddress, displayName });
