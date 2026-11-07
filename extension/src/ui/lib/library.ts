// What Home, Library and Rate mode show, worked out from the library: pure functions, tested in
// test/ui/library.test.ts.

import {
  DomainName,
  type EpisodeAlert,
  EpisodeRef,
  LibraryList,
  LibraryQuery,
  Rating,
  Timecode,
  type Title,
  TitleKind,
  type WatchProgress,
} from "../../core/data";
import { DateText, RefText, isVisitOnly, oneDecimal } from "./format";

// MARK: Home

/** HomeHero.detailLine: "Season 1, episode 2. 42 min left on site.to". */
export function heroDetailLine(progress: WatchProgress, now: Date = new Date()): string {
  const parts: string[] = [];
  if (EpisodeRef.isEpisode(progress.ref)) parts.push(RefText.long(progress.ref));
  const site = DomainName.registrable(progress.host);
  if (isVisitOnly(progress)) {
    parts.push(`Last opened on ${site} ${DateText.relative(progress.updatedAt, now)}`);
  } else {
    parts.push(`${Timecode.spoken(Math.max(0, progress.duration - progress.position))} left on ${site}`);
  }
  return parts.join(". ");
}

/** The hero's and title card's main button: "Resume at 42:10" or "Open on site.to". */
export function resumeLabel(progress: WatchProgress): string {
  return isVisitOnly(progress)
    ? `Open on ${DomainName.registrable(progress.host)}`
    : `Resume at ${Timecode.string(progress.position)}`;
}

/** EpisodeAlerts.fresh: series with episodes out in the last three weeks you haven't watched since. */
export function freshAlerts(
  alerts: Iterable<EpisodeAlert>,
  titles: ReadonlyMap<number, Title>,
  now: number = Date.now() / 1000,
): { title: Title; alert: EpisodeAlert }[] {
  const out: { title: Title; alert: EpisodeAlert }[] = [];
  for (const alert of alerts) {
    if (alert.newAt == null || alert.newCount <= 0 || now - alert.newAt >= 21 * 86_400) continue;
    const title = titles.get(alert.titleId);
    if (!title || title.status === "watched") continue;
    if (title.lastWatchedAt != null && title.lastWatchedAt > alert.newAt) continue;
    out.push({ title, alert });
  }
  return out.sort((a, b) => (b.alert.newAt ?? 0) - (a.alert.newAt ?? 0));
}

/** The note on a fresh series' poster: "S2 E3" or "3 new". */
export function alertBadge(alert: EpisodeAlert): string {
  if (alert.newCount === 1) return alert.newest ? RefText.short(alert.newest) : "New";
  return `${alert.newCount} new`;
}

/** PosterCell.subtitle: the episode in progress, else the year, else the kind. */
export function posterSubtitle(title: Title, progress: WatchProgress | null): string {
  if (progress && EpisodeRef.isEpisode(progress.ref)) return RefText.short(progress.ref);
  if (title.year != null) return String(title.year);
  return TitleKind.label(title.kind);
}

// MARK: Library

/** The status tab's count: everything in a list, or that list's titles. */
export function listCount(titles: Iterable<Title>, list: LibraryList): number {
  let n = 0;
  for (const title of titles) {
    if (list === "all" ? title.status !== "none" : LibraryList.matches(list, title)) n++;
  }
  return n;
}

/** "12 titles, 5 rated, averaging 7.4". */
export function librarySummary(shown: readonly Title[]): string {
  const rated = shown.map((t) => Title_rating(t)).filter((r): r is number => r != null);
  let text = `${shown.length} ${shown.length === 1 ? "title" : "titles"}`;
  if (rated.length > 0) {
    text += `, ${rated.length} rated, averaging ${oneDecimal(rated.reduce((a, b) => a + b, 0) / rated.length)}`;
  }
  return text;
}

function Title_rating(title: Title): number | null {
  return title.ratingHalves == null ? null : title.ratingHalves / 2;
}

/** The empty library's sentence. */
export function libraryEmptyText(query: LibraryQuery): string {
  if (LibraryQuery.hasFilters(query)) return "Nothing matches these filters.";
  switch (query.list) {
    case "backlog":
      return "Films you want to see go here. On any film's page, click Cineon in the toolbar, then Add to backlog.";
    case "watching":
      return "Start playing something, and it appears here on its own.";
    case "watched":
      return "Films you finish move here on their own.";
    default:
      return "Your library is empty. Add a film, or import your history in Settings.";
  }
}

/** The genre filter's label: "Genre", "Drama" or "3 genres". */
export function genreLabel(genres: readonly string[]): string {
  if (genres.length === 0) return "Genre";
  return genres.length === 1 ? genres[0]! : `${genres.length} genres`;
}

/** ChecklistRow.detail: "1999, Film, 2 h 16 min". */
export function checklistDetail(title: Title): string {
  const parts = [TitleKind.label(title.kind)];
  if (title.year != null) parts.unshift(String(title.year));
  if (title.runtimeMinutes != null) parts.push(Timecode.spoken(title.runtimeMinutes * 60));
  return parts.join(", ");
}

/** TitleDetailView.factsLine: "1999, Film, 2 h 16 min, Action, Sci-Fi, Thriller". */
export function factsLine(title: Title): string {
  const parts: string[] = [];
  if (title.year != null) parts.push(String(title.year));
  parts.push(TitleKind.label(title.kind));
  if (title.runtimeMinutes != null) parts.push(Timecode.spoken(title.runtimeMinutes * 60));
  parts.push(...title.genres.slice(0, 3));
  return parts.join(", ");
}

// MARK: The poster grid

export interface GridLayout {
  columns: number;
  itemWidth: number;
  rowHeight: number;
  rows: number;
  /** Total height of the rows and the gaps between them. */
  height: number;
}

/** Space under a poster: progress (2 + 7), name (17), gap (7), subtitle (15). */
export const CELL_TEXT_HEIGHT = 7 + 2 + 7 + 17 + 15;

/**
 * SwiftUI's `GridItem(.adaptive(minimum: 138, maximum: 190), spacing: 18)`: as many columns of at
 * least 138 as fit, sharing what's left, up to 190 each. Rows 24 apart.
 */
export function gridLayout(width: number, count: number, minimum = 138, maximum = 190, spacing = 18, rowSpacing = 24): GridLayout {
  const usable = Math.max(minimum, width);
  const columns = Math.max(1, Math.floor((usable + spacing) / (minimum + spacing)));
  const itemWidth = Math.min(maximum, (usable - spacing * (columns - 1)) / columns);
  const rowHeight = Math.round(itemWidth * 1.5 + CELL_TEXT_HEIGHT);
  const rows = Math.ceil(count / columns);
  return { columns, itemWidth, rowHeight, rows, height: rows === 0 ? 0 : rows * rowHeight + (rows - 1) * rowSpacing };
}

/** The rows to build for a scroll position, with a few above and below (LazyVGrid). */
export function visibleRows(layout: GridLayout, scrollTop: number, viewport: number, rowSpacing = 24, overscan = 2): { first: number; last: number } {
  const pitch = layout.rowHeight + rowSpacing;
  if (layout.rows === 0) return { first: 0, last: -1 };
  const first = Math.max(0, Math.floor(scrollTop / pitch) - overscan);
  const last = Math.min(layout.rows - 1, Math.ceil((scrollTop + viewport) / pitch) + overscan);
  return { first, last };
}

// MARK: Rate mode

/** Rate mode's queue: watched (and series being watched), unrated first unless asked, most recent first. */
export function rateQueue(titles: Iterable<Title>, includeRated: boolean): number[] {
  return [...titles]
    .filter((t) => (t.status === "watched" || (t.status === "watching" && t.kind === "series")) && (includeRated || t.ratingHalves == null))
    .sort((a, b) => (b.finishedAt ?? b.lastWatchedAt ?? b.addedAt) - (a.finishedAt ?? a.lastWatchedAt ?? a.addedAt))
    .map((t) => t.id);
}

export type RateAction =
  /** Rate and move on after 0.38 s. */
  | { kind: "rate"; halves: number }
  | { kind: "next" }
  | { kind: "nudge"; step: number }
  | { kind: "clear" }
  | { kind: "exit" };

/** Rate mode's keys: 1 to 0 rate, arrows add or take half a star, Delete clears, Return/Space skip, Esc leaves. */
export function rateKey(event: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }): RateAction | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const { key } = event;
  if (/^[0-9]$/.test(key)) {
    const digit = Number(key);
    return { kind: "rate", halves: (digit === 0 ? 10 : digit) * 2 };
  }
  switch (key) {
    case "Enter":
    case " ":
      return { kind: "next" };
    case "ArrowLeft":
      return { kind: "nudge", step: -1 };
    case "ArrowRight":
      return { kind: "nudge", step: 1 };
    case "Backspace":
    case "Delete":
      return { kind: "clear" };
    case "Escape":
      return { kind: "exit" };
    default:
      return null;
  }
}

/** RateModeView.nudge: from the rating, or 5 stars when there's none. */
export function nudged(halves: number | null, step: number): number {
  return Rating.clamp((halves ?? 10) + step);
}

/** Rate mode's line under the name: "1999   Film   Action, Sci-Fi". */
export function rateDetail(title: Title): string {
  const parts: string[] = [];
  if (title.year != null) parts.push(String(title.year));
  parts.push(TitleKind.label(title.kind));
  if (title.genres.length > 0) parts.push(title.genres.slice(0, 3).join(", "));
  return parts.join("   ");
}

/** "You rated 3 films just now…" or "Everything you've watched has its stars." */
export function rateFinishedText(rated: number): string {
  return rated > 0
    ? `You rated ${rated} ${rated === 1 ? "film" : "films"} just now. They're saved, in the cloud too.`
    : "Everything you've watched has its stars.";
}

/** Watched titles without stars (the top bar's Rate button). */
export function unratedCount(titles: Iterable<Title>): number {
  let n = 0;
  for (const t of titles) if (t.status === "watched" && t.ratingHalves == null) n++;
  return n;
}
