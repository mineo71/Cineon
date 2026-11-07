// Requests to check the DNR rules against the apps' matcher, made the way the Windows port's
// ShieldReferenceTests makes them: URLs built from the rules themselves (so many match), near
// misses with one character cut out, and ordinary pages. Seeded, so the C# side
// (apps-parity/Program.cs) sees exactly the same requests.

import easylist from "../../../Cineon/Resources/Filters/easylist.txt?raw";
import easyprivacy from "../../../Cineon/Resources/Filters/easyprivacy.txt?raw";
import ublock from "../../../Cineon/Resources/Filters/ublock.txt?raw";
import peterlowe from "../../../Cineon/Resources/Filters/peterlowe.txt?raw";
import streaming from "../../../Cineon/Resources/Filters/cineon-streaming.txt?raw";
import { parseList, type NetworkFilter } from "../../src/core/shields/filterConverter";
import { FILTER_CATALOG } from "../../src/core/shields/catalog";

const texts: Record<string, string> = { easylist, easyprivacy, ublock, peterlowe, "cineon-streaming": streaming };

/** A bundled list's text, as the apps ship it. */
export function listText(id: string): string {
  const text = texts[id];
  if (text === undefined) throw new Error(`No list ${id}`);
  return text;
}

/** Every bundled list, in catalog order. */
export function bundledLists(): { id: string; text: string }[] {
  return FILTER_CATALOG.map((info) => ({ id: info.id, text: listText(info.id) }));
}

/** WebView2's resource contexts, the names the apps' matcher takes. */
export type RequestType =
  | "Script" | "Image" | "Document" | "XmlHttpRequest" | "Fetch" | "Stylesheet" | "Media" | "Font" | "Websocket" | "Ping" | "Other";

export const REQUEST_TYPES: RequestType[] = [
  "Script", "Image", "Document", "XmlHttpRequest", "Fetch", "Stylesheet", "Media", "Font", "Websocket", "Ping", "Other",
];

export interface Request {
  url: string;
  /** The top-level page; null for a main-frame navigation, which is its own page. */
  page: string | null;
  type: RequestType;
  mainFrame: boolean;
}

/** Every list, with only some lines of the big ones, so the slow reference matcher stays quick. */
export function sampledLists(): { id: string; text: string }[] {
  return FILTER_CATALOG.map((info) => {
    const every = info.id === "easylist" || info.id === "easyprivacy" ? 23 : info.id === "ublock" ? 3 : info.id === "peterlowe" ? 4 : 1;
    const lines = listText(info.id).split("\n").filter((line, i) => i % every === 0 || (line.startsWith("@@") && i % 2 === 0));
    return { id: info.id, text: lines.join("\n") };
  });
}

/** mulberry32: small, seeded, the same everywhere. */
export function random(seed: number): (n: number) => number {
  let a = seed >>> 0;
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return Math.floor(r * n);
  };
}

const ordinal = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function pages(filters: NetworkFilter[]): (string | null)[] {
  const domains = [...new Set(filters.flatMap((f) => [...f.ifDomains, ...f.unlessDomains]))].sort(ordinal).slice(0, 200);
  const whole = filters.flatMap((f) => (f.wholeSite ? [f.wholeSite.domain] : [])).slice(0, 50);
  return [
    null, "https://www.example.com/watch", "https://news.site.net/a", "https://cdn.net/", "https://sub.example.co.uk/x",
    ...domains.map((d) => `https://www.${d}/page`),
    ...whole.map((d) => `https://${d}/`),
  ];
}

const plain = [
  "https://www.example.com/", "https://www.youtube.com/watch?v=abc", "https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js",
  "https://player.example.org/embed/12345?autoplay=1", "http://example.com:8080/ads/banner.gif", "wss://socket.example.net/live",
  "https://user@host.example.com/path", "data:text/plain,ads", "about:blank", "blob:https://example.com/123",
];

function* urls(filters: NetworkFilter[], rand: (n: number) => number): Generator<string> {
  yield* plain;
  const separators = ["/", "", "?", "=", ":", "&", "-"];
  const tails = ["", "/x.js", "?a=1&b=2", ".png", "/"];
  const usable = filters.filter((f) => !f.wholeSite).filter((_, i) => i % 3 === 0);
  for (const filter of usable) {
    const { anchor, body: pattern, end } = filter.parts;
    let body = "";
    for (const c of pattern) {
      body += c === "*" ? (rand(3) === 0 ? "" : "zq9/") : c === "^" ? separators[rand(separators.length)]! : c;
    }
    const prefix = anchor === "host" ? (rand(2) === 0 ? "https://" : "http://media.") : anchor === "start" ? "" : "https://site.example/p/";
    const tail = end ? "" : tails[rand(tails.length)]!;
    let url = prefix + body + tail;
    if (rand(3) === 0) url = url.toUpperCase();
    yield url;
    if (body.length > 6) {
      const cut = 1 + rand(body.length - 2);
      yield prefix + body.slice(0, cut) + body.slice(cut + 1) + tail;
    }
  }
}

/** The requests for a set of lists. */
export function corpus(lists: { id: string; text: string }[], seed = 7): Request[] {
  const rand = random(seed);
  const filters = lists.flatMap((l) => {
    const p = parseList(l.text);
    return [...p.blocks, ...p.exceptions];
  });
  const pageList = pages(filters);
  const out: Request[] = [];
  for (const url of urls(filters, rand)) {
    let page: string | null = pageList[rand(pageList.length)] ?? null;
    const type = REQUEST_TYPES[rand(REQUEST_TYPES.length)]!;
    const mainFrame = type === "Document" && rand(4) === 0;
    if (mainFrame) page = null;
    out.push({ url, page, type, mainFrame });
  }
  return out;
}

/** Hosts to compare element-hiding CSS on: every 41st domain the lists name, with "www.", and a few odd ones. */
export function cssHosts(lists: { id: string; text: string }[]): string[] {
  const named = new Set<string>();
  const whole: string[] = [];
  for (const { text } of lists) {
    const p = parseList(text);
    for (const key of [...p.domainSelectors.keys(), ...p.unlessSelectors.keys()]) for (const d of key.split(",")) if (d) named.add(d);
    for (const domains of p.genericExceptions.values()) for (const d of domains) named.add(d);
    for (const f of p.exceptions) if (f.wholeSite) whole.push(f.wholeSite.domain);
  }
  const sampled = [...named].sort(ordinal).filter((_, i) => i % 41 === 0);
  return [
    ...sampled.flatMap((d) => [d, `www.${d}`]),
    ...whole.filter((_, i) => i % 9 === 0).flatMap((d) => [d, `m.${d}`]),
    "example.com", "news.site.net", "", "https://WWW.Example.com/watch?v=1", "Example.com.", "www.youtube.com", "localhost",
  ];
}
