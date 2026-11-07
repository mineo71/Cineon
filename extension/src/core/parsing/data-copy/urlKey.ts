// A copy of the data layer's UrlKey (Swift's URLKey; C#'s in Data/Models.cs), kept here until
// src/core/data lands; then this file should re-export that one. RescueMatcher only uses it to tell
// a results page from a link back to itself.

import { IcuRegex } from "../swiftText";
import * as UrlText from "./urlText";

const TRACKING = ["utm_", "fbclid", "gclid", "ref", "ref_", "yclid", "mc_", "_ga"];
const EPISODE_FRAGMENT = new IcuRegex("s:\\d+-e:\\d+");

/** A stable key for "this page", ignoring fragments and tracking parameters. */
function make(url: string): string {
  const original = url;
  const parts = UrlText.split(UrlText.encodeInvalid(original));

  // Some sites switch episodes by changing only the fragment. It's part of the page's identity
  // there. The dub in it isn't: changing voice is still the same episode.
  let fragment: string | null = null;
  if (parts.fragment !== null) {
    const match = EPISODE_FRAGMENT.match(UrlText.decode(parts.fragment) ?? parts.fragment);
    if (match) fragment = UrlText.encode(match[0], UrlText.fragmentAllowed);
  }

  // No scheme, user or password; the host lower-cased and without www.
  let authority: string | null = null;
  if (parts.authority !== null) {
    let hostAndPort = parts.authority;
    const at = hostAndPort.lastIndexOf("@");
    if (at >= 0) hostAndPort = hostAndPort.slice(at + 1);
    let host: string;
    let port: string | null = null;
    if (hostAndPort.startsWith("[")) {
      const close = hostAndPort.indexOf("]");
      if (close < 0) return original;
      host = hostAndPort.slice(0, close + 1);
      const rest = hostAndPort.slice(close + 1);
      if (rest.startsWith(":")) port = rest.slice(1);
      else if (rest.length > 0) return original;
    } else {
      const colon = hostAndPort.lastIndexOf(":");
      host = colon >= 0 ? hostAndPort.slice(0, colon) : hostAndPort;
      if (colon >= 0) port = hostAndPort.slice(colon + 1);
    }
    if (port !== null) {
      if (port.length === 0) port = null;
      else if (!/^[0-9]+$/.test(port)) return original;
      else port = port.replace(/^0+/, "") || "0";
    }
    host = (UrlText.decode(host) ?? host).toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    authority = UrlText.encode(host, UrlText.hostAllowed) + (port === null ? "" : ":" + port);
  }

  let query: string | null = null;
  if (parts.query !== null) {
    const items =
      parts.query.length === 0
        ? []
        : parts.query.split("&").map((item) => {
            const eq = item.indexOf("=");
            if (eq < 0) return { name: UrlText.decode(item) ?? item, value: null as string | null };
            const name = item.slice(0, eq);
            const value = item.slice(eq + 1);
            return { name: UrlText.decode(name) ?? name, value: UrlText.decode(value) ?? value };
          });
    const kept = items
      .filter((item) => !TRACKING.some((prefix) => item.name.toLowerCase().startsWith(prefix)))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (kept.length > 0) {
      query = kept
        .map(
          (item) =>
            UrlText.encode(item.name, UrlText.queryItemAllowed) +
            (item.value === null ? "" : "=" + UrlText.encode(item.value, UrlText.queryItemAllowed)),
        )
        .join("&");
    }
  }

  let path = parts.path;
  if (path.endsWith("/")) {
    const decoded = (UrlText.decode(path) ?? path).replace(/\/+$/, "");
    path = UrlText.encode(decoded, UrlText.pathAllowed);
  }
  if (authority === null) {
    // With no scheme and no host, a colon in the first segment would read as a scheme.
    const slash = path.indexOf("/");
    const firstSegment = slash < 0 ? path : path.slice(0, slash);
    if (firstSegment.includes(":")) path = firstSegment.replaceAll(":", "%3A") + (slash < 0 ? "" : path.slice(slash));
  }

  const key =
    (authority === null ? "" : "//" + authority) +
    path +
    (query === null ? "" : "?" + query) +
    (fragment === null ? "" : "#" + fragment);
  return key.startsWith("//") ? key.slice(2) : key;
}

export const UrlKey = Object.freeze({ make });
