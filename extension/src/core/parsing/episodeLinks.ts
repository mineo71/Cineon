// Next-episode addresses, the next episode itself, and intro and credits skips learned from what
// someone does while watching. Port of Core/EpisodeLinks.swift by way of
// windows/Cineon.Core/Parsing/EpisodeLinks.cs.

import type { EpisodeInfo } from "../metadata/models";
import { DomainName } from "./data-copy/domainName";
import { EpisodeRef } from "./data-copy/models";
import { SiteBrand } from "./rescueMatcher";
import * as SwiftText from "./swiftText";
import { IcuRegex } from "./swiftText";
import { SwiftUrl } from "./swiftUrl";

interface Pattern {
  regex: IcuRegex;
  hasSeason: boolean;
}

const WORDS = "(?:seriya|seriia|seria|serija|epizod|episode|ep)";
const SEASON_WORDS = "(?:sezona|sezonu|sezon|season)";

/**
 * Most specific first. The numbers have to match the episode that's playing, which is what stops a
 * film called "Part 2" or a site with "2" in its path from being rewritten.
 */
const PATTERNS: Pattern[] = (
  [
    // #t:238-s:3-e:5
    ["(?:^|[#-])s:(?<s>\\d+)-e:(?<e>\\d+)", true],
    // s02e04, s2-e4, s02.e04
    ["(?<![a-z0-9])s(?<s>\\d{1,2})[._-]?e(?<e>\\d{1,3})(?![0-9])", true],
    // 2x04
    ["(?<![a-z0-9])(?<s>\\d{1,2})x(?<e>\\d{1,3})(?![0-9])", true],
    // 2-sezon/4-seriya, 2-season-4-episode
    ["(?<![0-9])(?<s>\\d{1,2})[-_]?" + SEASON_WORDS + "[^/?#]*?[/_-]+(?<e>\\d{1,3})[-_]?" + WORDS + "(?![a-z])", true],
    // season-2/episode-4, season/2/episode/4, sezon-2-seriya-4, season=2&episode=4
    [SEASON_WORDS + "[-_/=]?(?<s>\\d{1,2})(?![0-9])[^/?#]*?[/_&-]+" + WORDS + "[-_/=]?(?<e>\\d{1,3})(?![0-9])", true],
    // ?s=2&e=4
    ["[?&]s=(?<s>\\d{1,2})&e=(?<e>\\d{1,3})(?![0-9])", true],
    // episode-4, seriya/4, ep=4
    ["(?<![a-z])" + WORDS + "[-_/=]?(?<e>\\d{1,3})(?![0-9])", false],
    // 4-seriya, 4-episode
    ["(?<![0-9])(?<e>\\d{1,3})[-_]?" + WORDS + "(?![a-z])", false],
  ] as const
).map(([source, hasSeason]) => ({ regex: new IcuRegex(source, true, true), hasSeason }));

function padded(n: number, width: number): string {
  return n < 0 ? "-" + String(-n).padStart(width - 1, "0") : String(n).padStart(width, "0");
}

/**
 * The address of `target`, from the address of `current`. Null when the address doesn't name this
 * episode, or names it in a way that can't reach the target. Foundation's `absoluteString`.
 */
function url(address: string, current: EpisodeRef, target: EpisodeRef): string | null {
  const text = SwiftUrl.from(address).absoluteString;
  for (const pattern of PATTERNS) {
    for (const match of pattern.regex.matches(text)) {
      const e = match.indices?.groups?.["e"];
      if (!e || SwiftText.int(text.slice(e[0], e[1])) !== current.episode) continue;
      const replacements: { range: [number, number]; number: number }[] = [{ range: e, number: target.episode }];

      if (pattern.hasSeason) {
        const s = match.indices?.groups?.["s"];
        if (!s || SwiftText.int(text.slice(s[0], s[1])) !== current.season) continue;
        replacements.push({ range: s, number: target.season });
      } else if (target.season !== current.season) {
        // An address with only an episode number can't change season.
        continue;
      }

      // One zero-padded number means they all are: s02e10 goes to s03e01, not s03e1.
      const isPadded = replacements.some((r) => text.slice(r.range[0], r.range[1]).startsWith("0"));
      let result = text;
      for (const { range, number } of [...replacements].sort((a, b) => b.range[0] - a.range[0])) {
        const width = range[1] - range[0];
        const digits = isPadded ? padded(number, width) : String(number);
        result = result.slice(0, range[0]) + digits + result.slice(range[1]);
      }
      return SwiftUrl.string(result);
    }
  }
  return null;
}

export const EpisodeLinks = Object.freeze({ url });

/** What `NextEpisode` reads from an episode list. */
export type EpisodeListing = Pick<EpisodeInfo, "season" | "episode" | "released">;

/**
 * What could come next. With a published episode list that's one answer, or none after the last
 * aired episode. Without one, either the next number or the start of the next season.
 * `now` is milliseconds since 1970, like `released`.
 */
function candidates(after: EpisodeRef, episodes: Iterable<EpisodeListing>, now: number = Date.now()): EpisodeRef[] {
  if (after.season === 0) return [EpisodeRef.of(0, after.episode + 1)];
  const numbered = [...episodes].filter((e) => e.season > 0);
  if (numbered.length === 0) return [EpisodeRef.of(after.season, after.episode + 1), EpisodeRef.of(after.season + 1, 1)];
  const next = numbered
    .sort((a, b) => a.season - b.season || a.episode - b.episode)
    .find((e) => e.season > after.season || (e.season === after.season && e.episode > after.episode));
  if (next === undefined) return [];
  if (next.released != null && next.released > now) return [];
  return [EpisodeRef.of(next.season, next.episode)];
}

export const NextEpisode = Object.freeze({ candidates });

/** The pause, in seconds, after which forward jumps no longer join one run. */
const MERGE_WINDOW = 4;

/** A run of forward jumps made close together, such as pressing the right arrow nine times. */
export class SkipJump {
  /**
   * @param from Where the run started, in seconds of the video.
   * @param to Where it has got to, in seconds of the video.
   * @param lastAt When the latest jump happened, in milliseconds since 1970.
   */
  constructor(
    readonly from: number,
    readonly to: number,
    readonly lastAt: number,
  ) {}

  /** Null when the new jump starts a new run. A jump backwards also ends the run. */
  extended(from: number, to: number, at: number): SkipJump | null {
    if (!((at - this.lastAt) / 1000 <= MERGE_WINDOW) || !(to > from) || !(Math.abs(from - this.to) <= 8)) return null;
    return new SkipJump(this.from, to, at);
  }
}

/** Is this jump shaped like skipping an intro? */
function isIntro(from: number, to: number, duration: number): boolean {
  const length = to - from;
  if (!(length >= 15) || !(length <= 240)) return false;
  return from <= Math.min(duration * 0.35, 900) && to < duration * 0.5;
}

/** Is leaving this far from the end shaped like skipping the credits? */
function isCredits(remaining: number, duration: number): boolean {
  return remaining >= 15 && remaining <= Math.min(duration * 0.2, 420);
}

/** Two sightings of credits describe the same thing. */
function agree(a: number, b: number): boolean {
  return Math.abs(a - b) <= 30;
}

/** Rules are shared between mirrors of a site, not between different sites, whose copies can be cut differently. */
function siteKey(host: string): string {
  const registrable = DomainName.registrable(host);
  return DomainName.isIPAddress(registrable) ? registrable : SiteBrand.of(registrable);
}

/** Reads intro and credits out of what someone does while watching. */
export const SkipLearner = Object.freeze({
  Jump: SkipJump,
  /** Seconds. */
  mergeWindow: MERGE_WINDOW,
  isIntro,
  isCredits,
  agree,
  siteKey,
});
