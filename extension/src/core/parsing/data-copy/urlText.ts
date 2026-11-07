// A copy of the data layer's UrlText (windows/Cineon.Core/Data/UrlText.cs), kept here until
// src/core/data lands; then this file should re-export that one. Percent-encoding the way
// Foundation's URLComponents and CharacterSet.url*Allowed do it.

function isAlphaNumeric(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9");
}

/** `CharacterSet.urlQueryAllowed`. */
export const queryAllowed = (c: string): boolean => isAlphaNumeric(c) || "-._~!$&'()*+,;=:@/?".includes(c);

/** What `URLComponents.queryItems` leaves alone in a name or value: no `&` or `=`. */
export const queryItemAllowed = (c: string): boolean => isAlphaNumeric(c) || "-._~!$'()*+,;:@/?".includes(c);

/** `CharacterSet.urlPathAllowed`. */
export const pathAllowed = (c: string): boolean => isAlphaNumeric(c) || "-._~!$&'()*+,;=:@/".includes(c);

/** `CharacterSet.urlFragmentAllowed`. */
export const fragmentAllowed = (c: string): boolean => isAlphaNumeric(c) || "-._~!$&'()*+,;=:@/?".includes(c);

/** `CharacterSet.urlHostAllowed`. */
export const hostAllowed = (c: string): boolean => isAlphaNumeric(c) || "-._~!$&'()*+,;=:[]".includes(c);

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function hex2(byte: number): string {
  return "%" + byte.toString(16).toUpperCase().padStart(2, "0");
}

/** Percent-encodes, as UTF-8 with upper-case hex, everything `allowed` refuses. Lone surrogates become U+FFFD. */
export function encode(text: string, allowed: (c: string) => boolean): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80 && allowed(ch)) {
      out += ch;
      continue;
    }
    for (const byte of encoder.encode(ch)) out += hex2(byte);
  }
  return out;
}

function isHex(c: string | undefined): boolean {
  return c !== undefined && ((c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F"));
}

/** Removes percent-encoding. Null when the escapes aren't valid UTF-8, like Swift's `removingPercentEncoding`. */
export function decode(text: string): string | null {
  if (!text.includes("%")) return text;
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "%" && i + 2 < text.length && isHex(text[i + 1]) && isHex(text[i + 2])) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    if (c === "%") return null;
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    for (const byte of encoder.encode(ch)) bytes.push(byte);
    i += ch.length - 1;
  }
  try {
    return strictDecoder.decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

/**
 * What `URL(string:)` does to text that isn't a valid address yet: characters that can't appear in
 * one are percent-encoded, everything else is kept as written.
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
        out += index + 2 < text.length && isHex(text[index + 1]) && isHex(text[index + 2]) ? "%" : "%25";
        continue;
      }
      if (ch === "#") {
        out += seenFragment ? "%23" : "#";
        seenFragment = true;
        continue;
      }
      if (isAlphaNumeric(ch) || "-._~:/?[]@!$&'()*+,;=".includes(ch)) {
        out += ch;
        continue;
      }
    }
    for (const byte of encoder.encode(ch)) out += hex2(byte);
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
    scheme: m[1] !== undefined ? m[2]! : null,
    authority: m[3] !== undefined ? m[4]! : null,
    path: m[5] ?? "",
    query: m[6] !== undefined ? m[7]! : null,
    fragment: m[8] !== undefined ? m[9]! : null,
  };
}
