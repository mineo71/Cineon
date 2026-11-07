// The TypeScript twin of windows/Cineon.Core.Tests/Profile/MacParity/StatsDump.cs (itself the twin of
// StatsDump.swift): the same generated libraries and the same text, line for line.

import {
  PixelPet, ProfileStats, type StatsProgress, type StatsSession, type StatsStatus, type StatsTitle,
} from "../../../src/core/profile";
import { SplitMix } from "./petDump";

const STATS_GENRES = [
  "Horror", "Sci-Fi", "Science Fiction", "sci-fi", "science-fiction", "Drama", " Drama", "drama", "Crime",
  "film noir", "Film-Noir", "TV Movie", "tv movie", "Comedy", "comedy", "Animation", "Documentary", "War",
];

export const ZONES = ["UTC", "Europe/Berlin", "America/Los_Angeles", "Asia/Kolkata", "Pacific/Chatham"];

const REFERENCE_MS = Date.UTC(2001, 0, 1);

/** `ReferenceDate.AddSeconds(s)`. */
function date(secondsSinceReference: number): Date {
  return new Date(REFERENCE_MS + secondsSinceReference * 1000);
}

/** C#'s "F6": exact decimal value, halves away from zero (as toFixed). */
function f6(v: number): string {
  return v.toFixed(6);
}

interface Library {
  titles: StatsTitle[];
  sessions: StatsSession[];
  progress: StatsProgress[];
  moments: number;
  ads: number;
  downloads: number;
  now: Date;
}

/** Draws one library. The generator never depends on the zone, so libraries are made once and reused. */
function library(rng: SplitMix): Library {
  const baseTime = 815_000_000.0;
  const count = rng.below(41);
  const titles: StatsTitle[] = [];
  for (let i = 0; i < count; i++) {
    const id = i + 1;
    const yearRoll = rng.below(10);
    const year = rng.below(180) + 1850;
    const series = rng.below(4) === 0;
    const status = (["none", "backlog", "watching", "watched"] as StatsStatus[])[rng.below(4)]!;
    const genreCount = rng.below(4);
    const genres: string[] = [];
    for (let g = 0; g < genreCount; g++) genres.push(STATS_GENRES[rng.below(STATS_GENRES.length)]!);
    const runtimeRoll = rng.below(5);
    const runtime = 20 + rng.below(180);
    const halvesRoll = rng.below(3);
    const halves = 1 + rng.below(20);
    const watchedRoll = rng.below(3);
    const watched = baseTime + rng.below(400 * 86400);
    titles.push({
      id, name: `T${id}`, year: yearRoll === 0 ? null : year, isSeries: series, status, genres,
      runtimeMinutes: runtimeRoll === 0 ? null : runtime, ratingHalves: halvesRoll === 0 ? null : halves,
      lastWatchedAt: watchedRoll === 0 ? null : date(watched),
    });
  }
  const sessions: StatsSession[] = [];
  const sessionCount = rng.below(81);
  for (let i = 0; i < sessionCount; i++) {
    const titleId = 1 + rng.below(count + 2);
    const start = baseTime + rng.below(400 * 86400);
    // The thousandths keep every title's and day's total unique: the Mac breaks ties by dictionary order.
    const seconds = rng.below(4 * 3600) + sessions.length * 0.001;
    const extra = rng.below(600);
    sessions.push({ titleId, startedAt: date(start), endedAt: date(start + seconds + extra), watchedSeconds: seconds });
  }
  const progress: StatsProgress[] = [];
  const progressCount = rng.below(61);
  for (let i = 0; i < progressCount; i++) {
    const titleId = 1 + rng.below(count + 2);
    const film = rng.below(3) === 0;
    const season = rng.below(3);
    const episode = rng.below(10);
    const finished = rng.below(2) === 0;
    progress.push({ titleId, isEpisode: !film && (season > 0 || episode > 0), finished });
  }
  const moments = rng.below(100), ads = rng.below(100), downloads = rng.below(100);
  const now = date(baseTime + 400 * 86400 + rng.below(86400));
  return { titles, sessions, progress, moments, ads, downloads, now };
}

function seconds(d: Date | null): string {
  return d ? String(Math.trunc((d.getTime() - REFERENCE_MS) / 1000)) : "-";
}

function describe(lib: Library, zone: string): string {
  const { now } = lib;
  const s = ProfileStats.compute(lib.titles, lib.sessions, lib.progress, {
    moments: lib.moments, adsBlocked: lib.ads, downloads: lib.downloads, now, timeZone: zone,
  });
  let out = `hours ${f6(s.trackedHours)} ${f6(s.estimatedHours)} ${f6(s.thisYearHours)}`;
  out += ` counts ${s.filmsWatched} ${s.seriesFinished} ${s.episodesFinished} ${s.inLibrary} ${s.backlog} ${s.watching}`;
  out += ` ${s.rated} ${s.averageRating !== null ? f6(s.averageRating) : "-"} ${s.ratingCounts.join(",")}`;
  // See StatsDump.swift: the Mac's total varies in the last bit, the nudge keeps halves off the midpoint.
  out += " | genres " + s.genres.map((g) => `${g.name}:${f6(g.weight + 1e-12)}`).join(",");
  out += " | decades " + s.decades.map((d) => `${d.decade}:${d.count}`).join(",");
  out += " | top " + s.topTitles.map((t) => `${t.id}:${f6(t.hours)}:${t.sessions}`).join(",");
  out += ` | streak ${s.currentStreak} ${s.longestStreak}`;
  out += s.binge
    ? ` binge ${s.binge.day.year}-${s.binge.day.month}-${s.binge.day.day} ${f6(s.binge.seconds)} ${s.binge.sessions}`
    : " binge -";
  out += " | heat " + s.heatmap.map((row) => row.join(",")).join(";");
  out += ` | ${s.sessions} ${seconds(s.firstWatch)} ${seconds(s.lastWatch)} ${s.moments} ${s.adsBlocked} ${s.downloads}`;
  out += ` | fav ${s.favouriteGenre ?? "-"} ${s.favouriteDecade ?? "-"} ${s.titlesFinished}`;
  out += ` ${s.busiestWeekday ?? "-"} ${s.busiestHour ?? "-"}`;
  out += ` ${s.daysSinceLastWatch(now, zone) ?? "-"}`;
  out += ` pet ${PixelPet.make(s.petTraits("S", now, zone)).code}\n`;
  return out;
}

let libraries: Library[] | undefined;

export function zone(zoneId: string): string {
  if (!libraries) {
    const rng = new SplitMix(7n);
    libraries = Array.from({ length: 300 }, () => library(rng));
  }
  return libraries.map((lib) => describe(lib, zoneId)).join("");
}
