// Percent-encoding the way Foundation's URLComponents and CharacterSet.url*Allowed do it, so keys
// and addresses built here match the ones the apps stored. Port of windows/Cineon.Core/Data/UrlText.cs.

export type Allowed = (codePoint: number) => boolean;

function isAlphaNumeric(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39);
}

function allowing(extra: string): Allowed {
  const set = new Set(Array.from(extra, (c) => c.charCodeAt(0)));
  return (c) => isAlphaNumeric(c) || set.has(c);
}

/** `CharacterSet.urlQueryAllowed`. */
export const queryAllowed = allowing("-._~!$&'()*+,;=:@/?");
/** What `URLComponents.queryItems` leaves alone in a name or value: no `&` or `=`. */
export const queryItemAllowed = allowing("-._~!$'()*+,;:@/?");
/** `CharacterSet.urlPathAllowed`. */
export const pathAllowed = allowing("-._~!$&'()*+,;=:@/");
/** `CharacterSet.urlFragmentAllowed`. */
export const fragmentAllowed = allowing("-._~!$&'()*+,;=:@/?");
/** `CharacterSet.urlHostAllowed`. */
export const hostAllowed = allowing("-._~!$&'()*+,;=:[]");

const utf8 = new TextEncoder();

function hex(byte: number): string {
  return byte.toString(16).toUpperCase().padStart(2, "0");
}

function percent(ch: string): string {
  let out = "";
  for (const b of utf8.encode(ch)) out += "%" + hex(b);
  return out;
}

/** Percent-encodes, as UTF-8 with upper-case hex, everything `allowed` refuses. */
export function encode(text: string, allowed: Allowed): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    out += cp < 0x80 && allowed(cp) ? ch : percent(ch);
  }
  return out;
}

function isHex(c: string | undefined): boolean {
  return c !== undefined && /^[0-9a-fA-F]$/.test(c);
}

/** Removes percent-encoding. Null when the escapes aren't valid UTF-8, like Swift's `removingPercentEncoding`. */
export function decode(text: string): string | null {
  if (!text.includes("%")) return text;
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "%" && i + 2 < text.length && isHex(text[i + 1]) && isHex(text[i + 2])) {
      bytes.push(parseInt(text.substring(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    if (c === "%") return null;
    const code = text.charCodeAt(i);
    const end = code >= 0xd800 && code <= 0xdbff && i + 1 < text.length ? 2 : 1;
    for (const b of utf8.encode(text.substring(i, i + end))) bytes.push(b);
    i += end - 1;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

const KEPT_AS_WRITTEN = new Set(Array.from("-._~:/?[]@!$&'()*+,;=", (c) => c.charCodeAt(0)));

/**
 * What `URL(string:)` does to text that isn't a valid address yet: characters that can't appear
 * in one are percent-encoded, everything else is kept as written.
 */
export function encodeInvalid(text: string): string {
  let out = "";
  let seenFragment = false;
  let at = 0;
  for (const ch of text) {
    const index = at;
    at += ch.length;
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) {
      if (ch === "%") {
        out += isHex(text[index + 1]) && isHex(text[index + 2]) && index + 2 < text.length ? "%" : "%25";
        continue;
      }
      if (ch === "#") {
        out += seenFragment ? "%23" : "#";
        seenFragment = true;
        continue;
      }
      if (isAlphaNumeric(cp) || KEPT_AS_WRITTEN.has(cp)) {
        out += ch;
        continue;
      }
    }
    out += percent(ch);
  }
  return out;
}

/** The parts of an address, split as RFC 3986 appendix B does. */
export interface UrlParts {
  scheme: string | null;
  authority: string | null;
  path: string;
  query: string | null;
  fragment: string | null;
}

const RFC3986 = /^(([^:/?#]+):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?$/s;

export function split(text: string): UrlParts {
  const m = RFC3986.exec(text)!;
  return {
    scheme: m[1] !== undefined ? (m[2] ?? "") : null,
    authority: m[3] !== undefined ? (m[4] ?? "") : null,
    path: m[5] ?? "",
    query: m[6] !== undefined ? (m[7] ?? "") : null,
    fragment: m[8] !== undefined ? (m[9] ?? "") : null,
  };
}
