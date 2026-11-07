// What the Profile page says (ProfileView.swift), as text and chart sizes. Pure, tested in
// test/ui/profile.test.ts.

import { Timecode } from "../../core/data";
import type { BingeDay, DecadeCount, GenreWeight, ProfileStats, TopTitle } from "../../core/profile";
import type { CloudSnapshot } from "../../shared/messages";
import { DateText } from "./format";

/** StatTiles.hours: whole hours. */
export function hours(value: number): string {
  return String(Math.round(value));
}

/** The note under "hours watched", when some of it was worked out from runtimes. */
export function hoursNote(stats: Pick<ProfileStats, "estimatedHours" | "trackedHours">): string | null {
  if (!(stats.estimatedHours > stats.trackedHours + 1)) return null;
  return stats.trackedHours < 1
    ? "worked out from the runtimes of what you finished"
    : `${hours(stats.trackedHours)} timed by Cineon, the rest from runtimes`;
}

export interface Tile {
  value: string;
  label: string;
  note: string | null;
}

/** The first four tiles: hours, films, episodes, streak. */
export function statTiles(stats: ProfileStats): Tile[] {
  return [
    { value: hours(stats.estimatedHours), label: "hours watched", note: hoursNote(stats) },
    {
      value: String(stats.filmsWatched),
      label: stats.filmsWatched === 1 ? "film" : "films",
      note: stats.seriesFinished > 0 ? `and ${stats.seriesFinished} series finished` : null,
    },
    { value: String(stats.episodesFinished), label: stats.episodesFinished === 1 ? "episode" : "episodes", note: null },
    {
      value: String(stats.currentStreak),
      label: stats.currentStreak === 1 ? "day in a row" : "days in a row",
      note: `longest ${stats.longestStreak}`,
    },
  ];
}

/** "7.4", or "–" with nothing rated. */
export function averageText(average: number | null): string {
  return average == null ? "–" : average.toFixed(1);
}

/** "Stage species, level N". */
export function petLine(pet: { stageLabel: string; speciesLabel: string; level: number }): string {
  return `${pet.stageLabel} ${pet.speciesLabel.toLowerCase()}, level ${pet.level}`;
}

/** "Raised on drama and comedy. Watch more and Pip grows up." */
export function raisedOn(genres: readonly GenreWeight[], petName: string): string | null {
  const first = genres[0];
  if (!first) return null;
  const second = genres.length > 1 ? ` and ${genres[1]!.name.toLowerCase()}` : "";
  return `Raised on ${first.name.toLowerCase()}${second}. Watch more and ${petName} grows up.`;
}

// MARK: Charts

export function genreDetail(genres: readonly GenreWeight[]): string | null {
  return genres[0] ? `mostly ${genres[0].name.toLowerCase()}` : null;
}

/** Whole percent of your watching. */
export function genrePercent(weight: number): number {
  return Math.round(weight * 100);
}

/** A genre bar's share of the widest. */
export function genreBarFraction(weight: number, most: number): number {
  return most > 0 ? weight / most : 0;
}

export function starsDetail(counts: readonly number[]): string {
  const total = counts.reduce((a, b) => a + b, 0);
  return total === 0 ? "nothing rated yet" : `${total} rated`;
}

/** The histogram bar's height: at least 4 when there's any, a 2 pt stub when there's none. */
export function histogramHeight(count: number, most: number): number {
  return count > 0 ? Math.max(4, (86 * count) / most) : 2;
}

/** The decade with the most titles, the first of equals (Swift's max(by:)). */
export function favouriteDecade(decades: readonly DecadeCount[]): DecadeCount | null {
  let best: DecadeCount | null = null;
  for (const entry of decades) if (best === null || best.count < entry.count) best = entry;
  return best;
}

export function decadeDetail(decades: readonly DecadeCount[]): string | null {
  const favourite = favouriteDecade(decades);
  return favourite ? `the ${favourite.decade}s most` : null;
}

export function decadeHeight(count: number, most: number): number {
  return Math.max(3, (64 * count) / most);
}

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const WEEKDAYS_PLURAL = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"] as const;

/** "21:00". */
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/** "mostly Fridays, around 21:00". */
export function heatmapDetail(weekday: number | null, hour: number | null): string | null {
  if (weekday == null || hour == null) return null;
  return `mostly ${WEEKDAYS_PLURAL[weekday]}, around ${hourLabel(hour)}`;
}

/** A heatmap cell's ink opacity: 0 for none, then brighter for more, on a square-root scale. */
export function heatOpacity(count: number, most: number): number {
  return count === 0 ? 0 : 0.14 + 0.78 * Math.sqrt(count / most);
}

export function heatHelp(day: number, hour: number, count: number): string {
  return `${WEEKDAYS[day]} ${hourLabel(hour)}: ${count} ${count === 1 ? "session" : "sessions"}`;
}

/** "Your biggest day: 6 h 12 min on 3 March 2026." */
export function bingeText(binge: BingeDay, locale?: string): string {
  const date = new Date(binge.day.year, binge.day.month - 1, binge.day.day);
  const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" }).format(date);
  if (binge.seconds > 1800) return `Your biggest day: ${Timecode.spoken(binge.seconds)} on ${day}.`;
  return `Your biggest day: ${binge.sessions} things opened on ${day}.`;
}

/** Under a top title's poster: time watched, or visits when it was mostly opened. */
export function topTitleLine(item: TopTitle): string {
  if (item.hours >= 0.5) return Timecode.spoken(item.hours * 3600);
  return `${item.sessions} ${item.sessions === 1 ? "visit" : "visits"}`;
}

// MARK: Cloud

export interface CloudStatusText {
  icon: string;
  text: string;
}

/** CloudStatus: off, waiting, backed up, or busy; or that the background isn't there. */
export function cloudStatus(cloudBackup: boolean, cloud: CloudSnapshot | null, answered: boolean, now: Date = new Date()): CloudStatusText {
  if (!cloudBackup) return { icon: "icloud.slash", text: "Cloud backup is off" };
  if (!cloud) return { icon: "icloud", text: answered ? "Backing up your ratings…" : "Backup runs in Cineon's background" };
  if (cloud.lastError) return { icon: "exclamationmark.icloud", text: `Backup waiting: ${cloud.lastError}` };
  if (cloud.lastSync != null) return { icon: "checkmark.icloud", text: `Ratings backed up ${DateText.relativeNamed(cloud.lastSync / 1000, now)}` };
  return { icon: "icloud", text: "Backing up your ratings…" };
}
