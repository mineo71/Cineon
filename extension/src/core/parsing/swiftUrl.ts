// An address read the way Foundation's `URL(string:)` reads it, with the properties the parsers use:
// `absoluteString`, `scheme`, `host`, `path` and `deletingPathExtension().lastPathComponent`. The
// browser's `URL` normalises paths, lower-cases hosts and adds slashes, which would change what the
// parsers see, so only its IDNA step is borrowed. Port of windows/Cineon.Core/Parsing/SwiftUrl.cs.

import * as UrlText from "./data-copy/urlText";

function isUnreservedOrSubDelim(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || "-._~!$&'()*+,;=".includes(c);
}

const userAllowed = (c: string): boolean => isUnreservedOrSubDelim(c) || c === ":";
const hostAllowed = (c: string): boolean => isUnreservedOrSubDelim(c) || c === "[" || c === "]" || c === ":";
const pathAllowed = (c: string): boolean => isUnreservedOrSubDelim(c) || c === ":" || c === "@" || c === "/";
const queryAllowed = (c: string): boolean => pathAllowed(c) || c === "?";

function isHex(c: string | undefined): boolean {
  return c !== undefined && /^[0-9a-fA-F]$/.test(c);
}

function fixPart(part: string, allowed: (c: string) => boolean): string {
  let valid = true;
  for (let i = 0; i < part.length && valid; i++) {
    const c = part[i]!;
    if (c === "%") valid = i + 2 < part.length && isHex(part[i + 1]) && isHex(part[i + 2]);
    else valid = allowed(c);
  }
  return valid ? part : UrlText.encode(part, (c) => c !== "%" && allowed(c));
}

/** Foundation turns a host written in another script into punycode, кіно.укр into xn--j1agd8g.xn--j1amh. */
function punycodeHost(text: string): string {
  const parts = UrlText.split(text);
  const authority = parts.authority;
  if (authority === null || /^[\x00-\x7f]*$/.test(authority)) return text;
  const at = authority.lastIndexOf("@");
  const userInfo = authority.slice(0, at + 1);
  const hostAndPort = authority.slice(at + 1);
  if (hostAndPort.startsWith("[")) return text;
  const colon = hostAndPort.indexOf(":");
  const host = colon < 0 ? hostAndPort : hostAndPort.slice(0, colon);
  const port = colon < 0 ? "" : hostAndPort.slice(colon);
  if (/^[\x00-\x7f]*$/.test(host)) return text;
  let ascii: string;
  try {
    ascii = new URL("http://" + host + "/").hostname;
  } catch {
    return text;
  }
  if (ascii.length === 0) return text;
  const start = text.indexOf("//") + 2;
  return text.slice(0, start) + userInfo + ascii + port + text.slice(start + authority.length);
}

export class SwiftUrl {
  /** The text as Foundation keeps it: characters that can't appear in an address percent-encoded, hosts in punycode. */
  readonly absoluteString: string;
  private readonly parts: UrlText.UrlParts;

  private constructor(absoluteString: string) {
    this.absoluteString = absoluteString;
    this.parts = UrlText.split(absoluteString);
  }

  get scheme(): string | null {
    return this.parts.scheme;
  }

  /** Null for text Foundation refuses: only the empty string, in practice. */
  static parse(text: string | null | undefined): SwiftUrl | null {
    if (!text) return null;
    return new SwiftUrl(SwiftUrl.fixUp(punycodeHost(text)));
  }

  /** An address that already came from `URL(string:)`, or text to read as one. */
  static from(url: string): SwiftUrl {
    return SwiftUrl.parse(url) ?? new SwiftUrl(url);
  }

  /**
   * `URL(string:)?.absoluteString`: null for nothing or empty text. Relative text stays relative, as
   * Foundation keeps it ("/p.jpg"); whoever loads it decides what that means.
   */
  static string(text: string | null | undefined): string | null {
    return SwiftUrl.parse(text)?.absoluteString ?? null;
  }

  /**
   * What `URL(string:)` does to text that isn't a valid address: each part (user, host, path, query,
   * fragment) that holds a character it can't have is percent-encoded whole, its "%" included, so
   * "a%20b c" becomes "a%2520b%20c"; a part that's valid stays as written.
   */
  static fixUp(text: string): string {
    const parts = UrlText.split(text);
    let out = "";
    if (parts.scheme !== null) out += parts.scheme + ":";
    if (parts.authority !== null) {
      const authority = parts.authority;
      out += "//";
      const at = authority.lastIndexOf("@");
      if (at >= 0) out += fixPart(authority.slice(0, at), userAllowed) + "@";
      out += fixPart(authority.slice(at + 1), hostAllowed);
    }
    out += fixPart(parts.path, pathAllowed);
    if (parts.query !== null) out += "?" + fixPart(parts.query, queryAllowed);
    if (parts.fragment !== null) out += "#" + fixPart(parts.fragment, queryAllowed);
    return out;
  }

  /** `URL.host`: percent-decoded, case kept, without user, port or IPv6 brackets. */
  get host(): string | null {
    const authority = this.parts.authority;
    if (!authority) return null;
    const hostAndPort = authority.slice(authority.lastIndexOf("@") + 1);
    let host: string;
    if (hostAndPort.startsWith("[")) {
      const close = hostAndPort.indexOf("]");
      host = close < 0 ? hostAndPort.slice(1) : hostAndPort.slice(1, close);
    } else {
      const colon = hostAndPort.indexOf(":");
      host = colon < 0 ? hostAndPort : hostAndPort.slice(0, colon);
    }
    return UrlText.decode(host);
  }

  /** `URL.path`: percent-decoded, trailing slashes removed (a lone "/" stays). Empty when the escapes aren't valid UTF-8. */
  get path(): string {
    const decoded = UrlText.decode(this.parts.path);
    if (decoded === null) return "";
    const trimmed = decoded.replace(/\/+$/, "");
    return trimmed.length === 0 && decoded.length > 0 ? "/" : trimmed;
  }

  /**
   * `deletingPathExtension().lastPathComponent`. The extension comes off the encoded name, so
   * "a.b%20c" loses ".b c"; the name is decoded afterwards, and is empty when that fails.
   */
  get lastPathComponentWithoutExtension(): string {
    const path = this.parts.path;
    const trimmed = path.replace(/\/+$/, "");
    if (trimmed.length === 0) return path.length > 0 ? "/" : "";
    let last = trimmed.slice(trimmed.lastIndexOf("/") + 1);
    const dot = last.lastIndexOf(".");
    if (dot > 0 && dot < last.length - 1 && /[^.]/.test(last.slice(0, dot))) last = last.slice(0, dot);
    return UrlText.decode(last) ?? "";
  }

  /** The query, as written (still percent-encoded). */
  get query(): string | null {
    return this.parts.query;
  }

  /** Text for `URLComponents` with another host: user, port, path, query and fragment kept as written. */
  withHost(host: string): string | null {
    const parts = this.parts;
    const authority = parts.authority;
    if (authority === null) return null;
    const at = authority.lastIndexOf("@");
    const hostAndPort = authority.slice(at + 1);
    let port: string;
    if (hostAndPort.startsWith("[")) {
      const close = hostAndPort.indexOf("]");
      port = close < 0 ? "" : hostAndPort.slice(close + 1);
    } else {
      const colon = hostAndPort.indexOf(":");
      port = colon < 0 ? "" : hostAndPort.slice(colon);
    }
    return (
      (parts.scheme === null ? "" : parts.scheme + ":") +
      "//" +
      authority.slice(0, at + 1) +
      UrlText.encode(host, UrlText.hostAllowed) +
      port +
      parts.path +
      (parts.query === null ? "" : "?" + parts.query) +
      (parts.fragment === null ? "" : "#" + parts.fragment)
    );
  }

  /**
   * `URL(string: reference, relativeTo: self)?.absoluteURL.absoluteString`: the reference fixed up
   * as Foundation would, then resolved by RFC 3986 section 5.2.
   */
  resolve(reference: string): string | null {
    const fixed = SwiftUrl.parse(reference);
    if (fixed === null) return null;
    const r = UrlText.split(fixed.absoluteString);
    // With a scheme the reference is absolute already, and Foundation keeps it as written.
    if (r.scheme !== null) return fixed.absoluteString;
    const base = this.parts;
    let scheme: string | null;
    let authority: string | null;
    let path: string;
    let query: string | null;
    {
      if (r.authority !== null) {
        authority = r.authority;
        path = removeDotSegments(r.path);
        query = r.query;
      } else {
        if (r.path === "") {
          path = base.path;
          query = r.query ?? base.query;
        } else {
          if (r.path.startsWith("/")) {
            path = removeDotSegments(r.path);
          } else {
            path = removeDotSegments(merge(base, r.path));
          }
          query = r.query;
        }
        authority = base.authority;
      }
      scheme = base.scheme;
    }
    return (
      (scheme === null ? "" : scheme + ":") +
      (authority === null ? "" : "//" + authority) +
      path +
      (query === null ? "" : "?" + query) +
      (r.fragment === null ? "" : "#" + r.fragment)
    );
  }
}

function merge(base: UrlText.UrlParts, path: string): string {
  if (base.authority !== null && base.path === "") return "/" + path;
  const slash = base.path.lastIndexOf("/");
  return slash < 0 ? path : base.path.slice(0, slash + 1) + path;
}

/** RFC 3986 section 5.2.4. */
function removeDotSegments(path: string): string {
  let input = path;
  const output: string[] = [];
  while (input.length > 0) {
    if (input.startsWith("../")) input = input.slice(3);
    else if (input.startsWith("./")) input = input.slice(2);
    else if (input.startsWith("/./")) input = input.slice(2);
    else if (input === "/.") input = "/";
    else if (input.startsWith("/../")) {
      input = input.slice(3);
      output.pop();
    } else if (input === "/..") {
      input = "/";
      output.pop();
    } else if (input === "." || input === "..") input = "";
    else {
      const next = input.indexOf("/", input.startsWith("/") ? 1 : 0);
      const segment = next < 0 ? input : input.slice(0, next);
      output.push(segment);
      input = input.slice(segment.length);
    }
  }
  return output.join("");
}
