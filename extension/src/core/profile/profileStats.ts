// Port of Cineon/Profile/ProfileStats.swift by way of windows/Cineon.Core/Profile/ProfileStats.cs. It takes
// its own small input records (StatsTitle, StatsSession, StatsProgress) instead of the library models, so
// callers map titles, watch sessions and progress into them. Calendar work (years, days, weekdays, hours)
// happens in a time zone (an IANA name), the system one by default, like the Mac's Calendar.current.

import type { GenreWeight, PetTraits } from "./pixelPet";

/** A title's list, as Swift's `TitleStatus`. */
export type StatsStatus = "none" | "backlog" | "watching" | "watched";

/** What the stats need of a library title. */
export interface StatsTitle {
  readonly id: number;
  readonly name: string;
  readonly posterUrl?: string | null;
  readonly year?: number | null;
  /** `title.kind == .series`. */
  readonly isSeries?: boolean;
  /** Default "none". */
  readonly status?: StatsStatus;
  readonly genres?: readonly string[];
  readonly runtimeMinutes?: number | null;
  /** Out of ten in half steps, kept doubled: 15 is 7.5. null is not rated. */
  readonly ratingHalves?: number | null;
  readonly lastWatchedAt?: Date | null;
}

/** What the stats need of a watch session. */
export interface StatsSession {
  readonly titleId: number;
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly watchedSeconds: number;
}

/** What the stats need of a progress entry: `ref.isEpisode` (season or episode above 0) and finished. */
export interface StatsProgress {
  readonly titleId: number;
  readonly isEpisode: boolean;
  readonly finished: boolean;
}

/** A calendar day in the stats' time zone. */
export interface CalendarDay {
  readonly year: number;
  /** 1...12. */
  readonly month: number;
  /** 1...31. */
  readonly day: number;
}

export interface TopTitle {
  readonly id: number;
  readonly name: string;
  readonly posterUrl: string | null;
  readonly hours: number;
  readonly sessions: number;
}

/** A local calendar day, with the time and number of sessions watched on it. */
export interface BingeDay {
  readonly day: CalendarDay;
  readonly seconds: number;
  readonly sessions: number;
}

export interface DecadeCount {
  readonly decade: number;
  readonly count: number;
}

export interface StatsComputeOptions {
  moments?: number;
  adsBlocked?: number;
  downloads?: number;
  /** Default now. */
  now?: Date;
  /** IANA name ("Europe/Berlin", "Etc/GMT-2"); default the system's zone. */
  timeZone?: string;
}

// MARK: Calendar

interface LocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  /** Days since 1970-01-01 of the local date. */
  dayNumber: number;
  /** 0 is Monday. */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? "";
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric",
    });
    formatters.set(key, f);
  }
  return f;
}

function local(instant: Date, timeZone: string | undefined): LocalTime {
  let year = 0, month = 1, day = 1, hour = 0;
  for (const part of formatter(timeZone).formatToParts(instant)) {
    switch (part.type) {
      case "year": year = Number(part.value); break;
      case "month": month = Number(part.value); break;
      case "day": day = Number(part.value); break;
      case "hour": hour = Number(part.value) % 24; break;
    }
  }
  const dayNumber = Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
  // 1970-01-01 was a Thursday (3 counting from Monday).
  const weekday = (((dayNumber + 3) % 7) + 7) % 7;
  return { year, month, day, hour, dayNumber, weekday };
}

function dayFromNumber(dayNumber: number): CalendarDay {
  const date = new Date(dayNumber * 86_400_000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** Foundation's `CharacterSet.whitespaces`: tab and space separators, plus U+200B. */
const WHITESPACES = new Set(
  "\u0009              ​  　",
);

/** Lower-cases one code point at a time, as Swift does (U+0130 becomes i + combining dot). */
function lowercased(text: string): string {
  let out = "";
  for (const ch of text) out += ch === "İ" ? "i̇" : ch.toLowerCase();
  return out;
}

let graphemes: Intl.Segmenter | undefined;

/**
 * Everything the profile page says about someone's watching, worked out from their library.
 * Pure, so it can be tested and computed off the UI thread.
 */
export class ProfileStats {
  /** Time Cineon saw being watched. */
  trackedHours = 0;
  /** Tracked time plus the runtimes of things finished before Cineon kept count. */
  estimatedHours = 0;
  thisYearHours = 0;
  filmsWatched = 0;
  seriesFinished = 0;
  episodesFinished = 0;
  inLibrary = 0;
  backlog = 0;
  watching = 0;
  rated = 0;
  averageRating: number | null = null;
  /** How many titles have each whole rating, 1 to 10. Halves round up. */
  readonly ratingCounts: number[] = new Array<number>(10).fill(0);
  /** Share of watching per genre, adding up to 1, biggest first. */
  genres: GenreWeight[] = [];
  decades: DecadeCount[] = [];
  topTitles: TopTitle[] = [];
  currentStreak = 0;
  longestStreak = 0;
  binge: BingeDay | null = null;
  /** Sessions by weekday (0 is Monday) and hour: 7 rows of 24. */
  readonly heatmap: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  sessions = 0;
  firstWatch: Date | null = null;
  lastWatch: Date | null = null;
  moments = 0;
  adsBlocked = 0;
  downloads = 0;

  get favouriteGenre(): string | null {
    return this.genres[0]?.name ?? null;
  }

  get favouriteDecade(): number | null {
    // Swift's max(by:) keeps the first of equal counts.
    let best: DecadeCount | null = null;
    for (const entry of this.decades) if (best === null || best.count < entry.count) best = entry;
    return best?.decade ?? null;
  }

  get titlesFinished(): number {
    return this.filmsWatched + this.seriesFinished + Math.trunc(this.episodesFinished / 4);
  }

  get busiestWeekday(): number | null {
    const totals = this.heatmap.map((row) => row.reduce((a, b) => a + b, 0));
    const best = Math.max(...totals);
    return best > 0 ? totals.indexOf(best) : null;
  }

  get busiestHour(): number | null {
    const totals = Array.from({ length: 24 }, (_, hour) => this.heatmap.reduce((sum, row) => sum + row[hour]!, 0));
    const best = Math.max(...totals);
    return best > 0 ? totals.indexOf(best) : null;
  }

  /**
   * Calendar days from the last watch to `now` in `timeZone` (the system one by default, like the Mac's
   * `Calendar.current`), or null if nothing was watched.
   */
  daysSinceLastWatch(now: Date = new Date(), timeZone?: string): number | null {
    if (!this.lastWatch) return null;
    return local(now, timeZone).dayNumber - local(this.lastWatch, timeZone).dayNumber;
  }

  /** What the pet grows from. Days count in the system time zone unless told otherwise, as on the Mac. */
  petTraits(seed: string, now?: Date, timeZone?: string): PetTraits {
    return {
      genres: this.genres,
      hoursWatched: this.estimatedHours,
      titlesFinished: this.titlesFinished,
      daysSinceLastWatch: this.daysSinceLastWatch(now, timeZone),
      seed,
    };
  }

  /** Equal enough to skip a redraw, as the Swift `==`: the same few fields. */
  equals(other: ProfileStats | null | undefined): boolean {
    return !!other && this.estimatedHours === other.estimatedHours && this.sessions === other.sessions
      && this.rated === other.rated && this.inLibrary === other.inLibrary
      && this.genres.length === other.genres.length
      && this.genres.every((g, i) => g.name === other.genres[i]!.name && g.weight === other.genres[i]!.weight)
      && (this.lastWatch?.getTime() ?? null) === (other.lastWatch?.getTime() ?? null);
  }

  // MARK: Working it out

  static compute(
    titles: Iterable<StatsTitle>, sessions: Iterable<StatsSession>, progress: Iterable<StatsProgress>,
    options: StatsComputeOptions = {},
  ): ProfileStats {
    const zone = options.timeZone;
    const at = options.now ?? new Date();
    const titleList = [...titles];
    const sessionList = [...sessions];
    const stats = new ProfileStats();
    stats.moments = options.moments ?? 0;
    stats.adsBlocked = options.adsBlocked ?? 0;
    stats.downloads = options.downloads ?? 0;
    stats.inLibrary = titleList.length;
    stats.sessions = sessionList.length;

    const byId = new Map<number, StatsTitle>();
    for (const title of titleList) byId.set(title.id, title);
    const secondsByTitle = new Map<number, number>();
    const sessionsByTitle = new Map<number, number>();
    const year = local(at, zone).year;
    const days = new Map<number, { seconds: number; count: number }>();

    for (const session of sessionList) {
      secondsByTitle.set(session.titleId, (secondsByTitle.get(session.titleId) ?? 0) + session.watchedSeconds);
      sessionsByTitle.set(session.titleId, (sessionsByTitle.get(session.titleId) ?? 0) + 1);
      stats.trackedHours += session.watchedSeconds / 3600;
      const started = local(session.startedAt, zone);
      if (started.year === year) stats.thisYearHours += session.watchedSeconds / 3600;
      const entry = days.get(started.dayNumber) ?? { seconds: 0, count: 0 };
      days.set(started.dayNumber, { seconds: entry.seconds + session.watchedSeconds, count: entry.count + 1 });
      stats.heatmap[started.weekday]![started.hour]! += 1;
      stats.firstWatch = earlier(stats.firstWatch ?? session.startedAt, session.startedAt);
      stats.lastWatch = later(stats.lastWatch ?? session.endedAt, session.endedAt);
    }
    for (const title of titleList) {
      if (title.lastWatchedAt) stats.lastWatch = later(stats.lastWatch ?? title.lastWatchedAt, title.lastWatchedAt);
    }

    // Finished episodes, and runtimes for what was finished without Cineon timing it.
    const finishedEpisodes = new Map<number, number>();
    for (const entry of progress) {
      if (!entry.finished || !entry.isEpisode) continue;
      stats.episodesFinished += 1;
      finishedEpisodes.set(entry.titleId, (finishedEpisodes.get(entry.titleId) ?? 0) + 1);
    }
    stats.estimatedHours = stats.trackedHours;
    for (const title of titleList) {
      const status = title.status ?? "none";
      switch (status) {
        case "watched":
          if (title.isSeries) stats.seriesFinished += 1;
          else stats.filmsWatched += 1;
          break;
        case "backlog":
          stats.backlog += 1;
          break;
        case "watching":
          stats.watching += 1;
          break;
      }
      const tracked = (secondsByTitle.get(title.id) ?? 0) / 3600;
      if (!(tracked < 0.25)) continue;
      const episodes = finishedEpisodes.get(title.id);
      if (status === "watched" && !title.isSeries) {
        stats.estimatedHours += (title.runtimeMinutes ?? 110) / 60.0;
      } else if (episodes !== undefined) {
        stats.estimatedHours += episodes * (title.runtimeMinutes ?? 45) / 60;
      }
    }

    // Ratings.
    const ratings = titleList.map(rating).filter((r): r is number => r !== null);
    stats.rated = ratings.length;
    if (ratings.length > 0) stats.averageRating = ratings.reduce((sum, r) => sum + r, 0.0) / ratings.length;
    for (const r of ratings) stats.ratingCounts[Math.min(9, Math.max(0, Math.ceil(r) - 1))]! += 1;

    // Genres: what you watch, finish and rate highly counts most.
    const genreScore = new Map<string, number>();
    for (const title of titleList) {
      const genres = title.genres ?? [];
      if (genres.length === 0) continue;
      let weight: number;
      switch (title.status ?? "none") {
        case "watched": weight = 2; break;
        case "watching": weight = 1.5; break;
        case "backlog": weight = 0.35; break;
        default: weight = sessionsByTitle.has(title.id) ? 0.8 : 0.2;
      }
      weight += Math.min(6, (secondsByTitle.get(title.id) ?? 0) / 3600) * 0.4;
      const r = rating(title);
      if (r !== null) weight *= 0.6 + r / 12.5;
      const share = weight / genres.length;
      for (const genre of genres) {
        const key = ProfileStats.canonicalGenre(genre);
        genreScore.set(key, (genreScore.get(key) ?? 0) + share);
      }
    }
    let total = 0.0;
    for (const v of genreScore.values()) total += v;
    if (total > 0) {
      stats.genres = [...genreScore].map(([name, score]) => ({ name, weight: score / total }))
        .sort((a, b) => (a.weight > b.weight ? -1 : a.weight < b.weight ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }

    // Decades of what you've watched.
    const decades = new Map<number, number>();
    for (const title of titleList) {
      const status = title.status ?? "none";
      if (!(status === "watched" || status === "watching" || sessionsByTitle.has(title.id))) continue;
      const y = title.year;
      if (y != null && y > 1880) {
        const decade = Math.trunc(y / 10) * 10;
        decades.set(decade, (decades.get(decade) ?? 0) + 1);
      }
    }
    stats.decades = [...decades].map(([decade, count]) => ({ decade, count })).sort((a, b) => a.decade - b.decade);

    // Top titles by time, then by visits.
    stats.topTitles = [...byId.values()]
      .filter((t) => sessionsByTitle.has(t.id))
      .map((t) => ({
        id: t.id, name: t.name, posterUrl: t.posterUrl ?? null, hours: (secondsByTitle.get(t.id) ?? 0) / 3600,
        sessions: sessionsByTitle.get(t.id) ?? 0,
      }))
      .sort((a, b) => (a.hours > b.hours ? -1 : a.hours < b.hours ? 1 : b.sessions - a.sessions))
      .slice(0, 5);

    // Streaks of days with any watching.
    const sortedDays = [...days.keys()].sort((a, b) => a - b);
    let run = 0;
    let previous: number | null = null;
    for (const day of sortedDays) {
      run = previous !== null && previous + 1 === day ? run + 1 : 1;
      stats.longestStreak = Math.max(stats.longestStreak, run);
      previous = day;
    }
    const today = local(at, zone).dayNumber;
    if (sortedDays.length > 0 && sortedDays[sortedDays.length - 1]! >= today - 1) stats.currentStreak = run;

    // The biggest day: most time, or most sessions when nothing was timed. Ties go to the earliest day
    // (on the Mac they go to whichever the dictionary happens to list first).
    let best: { day: number; seconds: number; count: number } | null = null;
    for (const day of sortedDays) {
      const { seconds, count } = days.get(day)!;
      if (best === null || best.seconds < seconds || (best.seconds === seconds && best.count < count)) {
        best = { day, seconds, count };
      }
    }
    if (best) stats.binge = { day: dayFromNumber(best.day), seconds: best.seconds, sessions: best.count };
    return stats;
  }

  /** One name per genre, whatever the source called it. */
  static canonicalGenre(raw: string): string {
    const lower = trim(lowercased(raw), WHITESPACES);
    switch (lower) {
      case "science fiction": case "sci-fi": case "scifi": case "science-fiction": return "Sci-Fi";
      case "film-noir": case "film noir": return "Film-Noir";
      case "tv movie": return "TV Movie";
    }
    if (raw.length === 0) return raw;
    // raw.prefix(1).uppercased() + raw.dropFirst(): the first character (grapheme) upper-cased.
    graphemes ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const first = graphemes.segment(raw)[Symbol.iterator]().next().value?.segment ?? raw.slice(0, 1);
    return first.toUpperCase() + raw.slice(first.length);
  }
}

function rating(title: StatsTitle): number | null {
  return title.ratingHalves != null ? title.ratingHalves / 2.0 : null;
}

function trim(text: string, set: ReadonlySet<string>): string {
  let start = 0, end = text.length;
  while (start < end && set.has(text[start]!)) start++;
  while (end > start && set.has(text[end - 1]!)) end--;
  return text.slice(start, end);
}

function earlier(a: Date, b: Date): Date {
  return b.getTime() < a.getTime() ? b : a;
}

function later(a: Date, b: Date): Date {
  return b.getTime() > a.getTime() ? b : a;
}
