// The TypeScript side of windows/Cineon.Core.Tests/Parsing/MacParity/ParsingDump.swift (and .cs): the
// same line for every case in corpus.jsonl. Changing one means changing the others.

import { MetadataClient, PagePreview } from "../../src/core/metadata/metadataClient";
import type { MetadataHit } from "../../src/core/metadata/models";
import { titleKindFromRaw, type EpisodeRef, type TitleKind } from "../../src/core/parsing/data-copy/models";
import { EpisodeLinks, SkipLearner } from "../../src/core/parsing/episodeLinks";
import { RescueMatcher, SiteBrand, type RescueLink, type RescueMatch } from "../../src/core/parsing/rescueMatcher";
import { SwiftUrl } from "../../src/core/parsing/swiftUrl";
import { TitleParser, type LinkedData, type PageMeta, type ParsedTitle } from "../../src/core/parsing/titleParser";

type Json = Record<string, unknown>;

export function esc(s: string | null | undefined): string {
  if (s == null) return "nil";
  let out = '"';
  for (const ch of s) {
    const v = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (v < 0x20 || (v >= 0x7f && v <= 0x9f) || v === 0x2028 || v === 0x2029) out += `\\u{${v.toString(16)}}`;
    else out += ch;
  }
  return out + '"';
}

const num = (i: number | null | undefined): string => (i == null ? "nil" : String(i));
const dbl = (d: number): string => d.toFixed(6);
const ref = (r: EpisodeRef | null | undefined): string => (r == null ? "nil" : `${r.season}:${r.episode}`);
const url = (u: string | null | undefined): string => esc(u);
const bool = (b: boolean): string => (b ? "true" : "false");
const date = (ms: number | null | undefined): string => (ms == null ? "nil" : (ms / 1000).toFixed(3));

const str = (o: Json, key: string): string | null => (typeof o[key] === "string" ? (o[key] as string) : null);
const int = (o: Json, key: string): number | null => (typeof o[key] === "number" ? Math.trunc(o[key] as number) : null);
const strings = (o: Json, key: string): string[] => o[key] as string[];
const kind = (raw: string | null): TitleKind => titleKindFromRaw(raw)!;

function parsed(p: ParsedTitle | null): string {
  if (p === null) return "nil";
  return [
    esc(p.name), esc(p.altName), num(p.year), ref(p.ref), esc(p.episodeName), p.kindHint, url(p.posterUrl), esc(p.overview),
    dbl(p.confidence),
  ].join(" | ");
}

function match(m: RescueMatch | null): string {
  if (m === null) return "nil";
  return [url(m.link.url), dbl(m.score), bool(m.yearConfirmed), bool(RescueMatcher.isStrong(m))].join(" | ");
}

/** `RescueLink(url: URL(string: …)!, …)`. */
function link(o: Json): RescueLink {
  return { url: SwiftUrl.string(str(o, "url"))!, text: str(o, "text")!, context: str(o, "context")! };
}

export function line(o: Json): string {
  const t = str(o, "t");
  switch (t) {
    case "parse": {
      const meta: PageMeta = {
        url: str(o, "url") ?? "",
        title: str(o, "title") ?? "",
        ogSite: str(o, "site"),
        ogTitle: str(o, "og"),
        h1: str(o, "h1"),
        twitterTitle: str(o, "tw"),
        ogType: str(o, "ogType"),
        ogImage: str(o, "ogImage"),
        ogDescription: str(o, "ogDescription"),
        ld: ((o["ld"] as Json[] | undefined) ?? []).map(
          (l): LinkedData => ({
            type: str(l, "type"),
            name: str(l, "name"),
            series: str(l, "series"),
            season: int(l, "season"),
            episode: int(l, "episode"),
            year: int(l, "year"),
            image: str(l, "image"),
            description: str(l, "description"),
          }),
        ),
      };
      return parsed(TitleParser.parse(meta));
    }
    case "clean":
      return parsed(TitleParser.clean(str(o, "text")!, new Set(strings(o, "tokens"))));
    case "ref":
      return ref(TitleParser.episodeRefIn(str(o, "text")!));
    case "kind":
      return TitleParser.kindHint(str(o, "text")!);
    case "tokens": {
      const text = str(o, "text")!;
      return RescueMatcher.tokens(text).map(esc).join(" ") + " | " + RescueMatcher.years(text).map(String).join(" ");
    }
    case "score": {
      const m = RescueMatcher.score(link(o), strings(o, "names"), int(o, "year"));
      return [dbl(m.score), bool(m.yearConfirmed), bool(RescueMatcher.isStrong(m))].join(" | ");
    }
    case "best": {
      const links = (o["links"] as Json[]).map(link);
      return match(RescueMatcher.best(links, strings(o, "names"), int(o, "year"), SwiftUrl.string(str(o, "page"))));
    }
    case "brand": {
      const host = str(o, "host")!;
      return esc(SiteBrand.of(host)) + " | " + esc(SkipLearner.siteKey(host));
    }
    case "mirrors":
      return RescueMatcher.mirrors(SwiftUrl.string(str(o, "url"))!, strings(o, "hosts")).map(url).join(" ");
    case "links": {
      const current = o["current"] as number[];
      const target = o["target"] as number[];
      return url(
        EpisodeLinks.url(
          SwiftUrl.string(str(o, "url"))!,
          { season: current[0]!, episode: current[1]! },
          { season: target[0]!, episode: target[1]! },
        ),
      );
    }
    case "match": {
      const hits = (o["hits"] as Json[]).map(
        (h): MetadataHit => ({
          id: str(h, "id")!,
          name: str(h, "name")!,
          year: int(h, "year"),
          kind: kind(str(h, "kind")),
          posterUrl: null,
          subtitle: null,
          rank: int(h, "rank"),
        }),
      );
      return esc(MetadataClient.bestMatch(hits, str(o, "name")!, int(o, "year"), kind(str(o, "kind")))?.id);
    }
    case "poster":
      return url(MetadataClient.resizedPoster(str(o, "raw"), 500));
    case "searchurl":
      return url(MetadataClient.searchUrl(str(o, "query")!));
    case "search": {
      const hits = MetadataClient.parseSearch(str(o, "body")!);
      return (
        "[" +
        hits
          .map((h) => [esc(h.id), esc(h.name), num(h.year), h.kind, url(h.posterUrl), esc(h.subtitle), num(h.rank)].join(" | "))
          .join(" ; ") +
        "]"
      );
    }
    case "detail": {
      const detail = MetadataClient.parseDetail(str(o, "body")!);
      if (detail === null) return "nil";
      const episodes = detail.episodes.map((e) =>
        [String(e.season), String(e.episode), esc(e.name), esc(e.overview), url(e.thumbnailUrl), date(e.released)].join(" , "),
      );
      return [
        esc(detail.overview),
        detail.genres.map(esc).join(" "),
        num(detail.runtimeMinutes),
        url(detail.posterUrl),
        url(detail.backdropUrl),
        num(detail.year),
        "[" + episodes.join(" ; ") + "]",
      ].join(" | ");
    }
    case "date":
      return date(MetadataClient.parseDate(str(o, "text")!));
    case "url": {
      const u = SwiftUrl.parse(str(o, "text"));
      if (u === null) return "nil";
      return [esc(u.absoluteString), esc(u.scheme), esc(u.host), esc(u.path), esc(u.lastPathComponentWithoutExtension)].join(" | ");
    }
    case "preview": {
      const preview = PagePreview.parse(str(o, "html")!, SwiftUrl.string(str(o, "base"))!);
      return url(preview.poster) + " | " + esc(preview.overview);
    }
    default:
      throw new Error(`Unknown case ${t}`);
  }
}

/** Every case in the corpus, as "index type: output". */
export function run(corpus: string): string[] {
  return corpus
    .split("\n")
    .filter((raw) => raw.length > 0)
    .map((raw, index) => {
      const o = JSON.parse(raw) as Json;
      return `${index} ${str(o, "t")}: ${line(o)}`;
    });
}
