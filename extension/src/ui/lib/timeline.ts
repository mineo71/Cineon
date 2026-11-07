// What the Timeline shows (WatchTimelineView.swift), worked out from the library: days of sessions,
// list changes and, when asked, pages browsed. Pure, tested in test/ui/timeline.test.ts.

import {
  DomainName,
  EpisodeRef,
  type FilmFrame,
  type HistoryEntry,
  type LibraryEvent,
  LibraryText,
  Timecode,
  type Title,
  type WatchSession,
} from "../../core/data";
import { DateText, RefText, isVisitOnly } from "./format";

export type TimelineEntry =
  | { readonly kind: "session"; readonly id: string; readonly date: number; readonly session: WatchSession }
  | { readonly kind: "event"; readonly id: string; readonly date: number; readonly event: LibraryEvent }
  | { readonly kind: "visit"; readonly id: string; readonly date: number; readonly visit: HistoryEntry };

export interface TimelineDay {
  /** The local day's start, in seconds since 1970. */
  readonly id: number;
  readonly entries: readonly TimelineEntry[];
}

/** Local midnight before `seconds`, in seconds. */
export function startOfDay(seconds: number): number {
  const date = new Date(seconds * 1000);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 1000;
}

/**
 * The days to show, newest first, each newest first: sessions, list changes (not "moved to
 * watching") and visits, filtered by the title's normalised name (or the page's title and host).
 */
export function timelineDays(
  sessions: readonly WatchSession[],
  events: readonly LibraryEvent[],
  visits: readonly HistoryEntry[] | null,
  titles: ReadonlyMap<number, Title>,
  query: string,
): TimelineDay[] {
  const needle = LibraryText.normalize(query);
  const matches = (id: number) => needle.length === 0 || (titles.get(id)?.normName.includes(needle) ?? false);
  const entries: TimelineEntry[] = [];
  for (const session of sessions) {
    if (matches(session.titleId)) entries.push({ kind: "session", id: `s${session.id}`, date: session.startedAt, session });
  }
  for (const event of events) {
    if (event.kind !== "markedWatching" && matches(event.titleId)) entries.push({ kind: "event", id: `e${event.id}`, date: event.at, event });
  }
  for (const visit of visits ?? []) {
    if (needle.length === 0 || LibraryText.normalize(visit.title + visit.host).includes(needle)) {
      entries.push({ kind: "visit", id: `h${visit.id}`, date: visit.visitedAt, visit });
    }
  }
  const grouped = new Map<number, TimelineEntry[]>();
  for (const entry of entries) {
    const day = startOfDay(entry.date);
    const list = grouped.get(day);
    if (list) list.push(entry);
    else grouped.set(day, [entry]);
  }
  return [...grouped.keys()]
    .sort((a, b) => b - a)
    .map((day) => ({ id: day, entries: grouped.get(day)!.sort((a, b) => b.date - a.date) }));
}

/** The first day of this week (Calendar.current: the locale's first weekday), in seconds. */
export function startOfWeek(now: Date, firstDay = localeFirstDay()): number {
  // firstDay: 1 is Monday … 7 is Sunday (Intl.Locale's weekInfo); getDay: 0 is Sunday.
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekday = today.getDay() === 0 ? 7 : today.getDay();
  const back = (weekday - firstDay + 7) % 7;
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() - back).getTime() / 1000;
}

export function startOfMonth(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000;
}

/** The browser locale's first day of the week (1 Monday … 7 Sunday), Monday when unknown. */
export function localeFirstDay(locale?: string): number {
  try {
    const tag = locale ?? (typeof navigator === "undefined" ? "en-GB" : navigator.language);
    const info = new Intl.Locale(tag) as Intl.Locale & {
      weekInfo?: { firstDay: number };
      getWeekInfo?: () => { firstDay: number };
    };
    const week = info.getWeekInfo?.() ?? info.weekInfo;
    return week?.firstDay ?? 1;
  } catch {
    return 1;
  }
}

/** Seconds watched in sessions started since `since`. */
export function watchedSince(sessions: readonly WatchSession[], since: number): number {
  let total = 0;
  for (const s of sessions) if (s.startedAt >= since) total += s.watchedSeconds;
  return total;
}

/** "This week" / "This month" values: spoken time or "None". */
export function statText(seconds: number): string {
  return seconds > 0 ? Timecode.spoken(seconds) : "None";
}

/**
 * The more you watched, the more film: one picture per 25 minutes, up to three, with the frames
 * between them a hover away (TimelineSessionRow.reels).
 */
export function reels(frames: readonly FilmFrame[], watchedSeconds: number): FilmFrame[][] {
  if (frames.length === 0) return [];
  const wanted = Math.min(3, frames.length, Math.trunc(watchedSeconds / 1500) + 1);
  const size = frames.length / wanted;
  return Array.from({ length: wanted }, (_, i) => frames.slice(Math.trunc(i * size), Math.trunc((i + 1) * size)));
}

/**
 * FrameReel.hero: the most interesting frame, leaving out the end where possible (a screen full
 * of credits scores well and tells you nothing). A moment someone saved always counts. The first
 * of equals wins, as Swift's max(by:).
 */
export function heroFrame(frames: readonly FilmFrame[], duration: number): FilmFrame | null {
  if (frames.length === 0) return null;
  const story = frames.filter((f) => f.isMoment || duration <= 0 || f.position < duration * 0.85);
  const pool = story.length === 0 ? frames : story;
  let best = pool[0]!;
  for (const frame of pool) if (best.interest < frame.interest) best = frame;
  return best;
}

/** Which frame the pointer is over: `x` across a `width` wide frame. */
export function scrubIndex(x: number, width: number, count: number): number {
  const fraction = Math.min(0.999, Math.max(0, x / width));
  return Math.trunc(fraction * count);
}

/** A still from the episode itself when there is one, else the backdrop, else the poster. */
export function sessionStill(session: WatchSession, title: Title | null | undefined): string | null {
  if (EpisodeRef.isEpisode(session.ref) && title?.imdbId) {
    return `https://episodes.metahub.space/${title.imdbId}/${session.ref.season}/${session.ref.episode}/w780.jpg`;
  }
  return title?.backdropUrl ?? title?.posterUrl ?? null;
}

/** "S1 E2, Pilot. Stopped at 12:03 of 48:10". */
export function sessionSubtitle(session: WatchSession): string {
  const parts: string[] = [];
  if (EpisodeRef.isEpisode(session.ref)) {
    parts.push(session.episodeName != null ? `${RefText.short(session.ref)}, ${session.episodeName}` : RefText.long(session.ref));
  }
  if (isVisitOnly(session)) {
    // Nothing to add: the line below says when it was opened.
  } else if (session.finished) {
    parts.push("Finished");
  } else if (session.duration > 0) {
    parts.push(`Stopped at ${Timecode.string(session.endPosition)} of ${Timecode.string(session.duration)}`);
  }
  return parts.join(". ");
}

/** "21:02 to 22:40 on site.to", or "Opened at 21:02 on site.to". */
export function sessionWhere(session: WatchSession, locale?: string): string {
  const times = isVisitOnly(session)
    ? `Opened at ${DateText.time(session.startedAt, locale)}`
    : `${DateText.time(session.startedAt, locale)} to ${DateText.time(session.endedAt, locale)}`;
  return `${times} on ${DomainName.registrable(session.host)}`;
}

/** How far the session got. */
export function sessionFraction(session: WatchSession): number {
  return session.duration > 0 ? Math.min(1, session.endPosition / session.duration) : 0;
}

/** A session can carry on: it has a page, isn't finished and wasn't just a visit. */
export function canResume(session: WatchSession): boolean {
  return session.url != null && !session.finished && !isVisitOnly(session);
}

/** A visit's name: its title, else its address's path. */
export function visitName(visit: HistoryEntry): string {
  if (visit.title.length > 0) return visit.title;
  try {
    return new URL(visit.url).pathname;
  } catch {
    return visit.url;
  }
}
