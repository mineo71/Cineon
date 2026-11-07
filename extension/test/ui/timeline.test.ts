import { describe, expect, it } from "vitest";
import { EpisodeRef, FilmFrame, LibraryText, Title, WatchSession } from "../../src/core/data";
import type { HistoryEntry, LibraryEvent } from "../../src/core/data";
import {
  canResume,
  heroFrame,
  reels,
  scrubIndex,
  sessionFraction,
  sessionStill,
  sessionSubtitle,
  startOfDay,
  startOfMonth,
  startOfWeek,
  statText,
  timelineDays,
  visitName,
  watchedSince,
} from "../../src/ui/lib/timeline";

const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime() / 1000;

function title(id: number, name: string, extra: Partial<Title> = {}): Title {
  return Title.make({ id, name, normName: LibraryText.normalize(name), ...extra });
}

function session(id: number, titleId: number, startedAt: number, extra: Partial<WatchSession> = {}): WatchSession {
  return WatchSession.make({ id, titleId, startedAt, endedAt: startedAt + 3600, host: "www.site.to", duration: 3600, ...extra });
}

function frame(id: number, position: number, interest: number, isMoment = false): FilmFrame {
  return FilmFrame.make({ id, position, interest, isMoment, file: `1/${id}.jpg` });
}

describe("timelineDays", () => {
  const titles = new Map([
    [1, title(1, "Dune")],
    [2, title(2, "Severance")],
  ]);
  const sessions = [session(10, 1, at(2026, 11, 6, 21)), session(11, 2, at(2026, 11, 6, 23)), session(12, 2, at(2026, 11, 4, 20))];
  const events: LibraryEvent[] = [
    { id: 1, kind: "addedToBacklog", titleId: 1, at: at(2026, 11, 4, 22) },
    { id: 2, kind: "markedWatching", titleId: 2, at: at(2026, 11, 4, 21) },
  ];
  const visits: HistoryEntry[] = [{ id: 7, url: "https://news.example/a", host: "news.example", title: "Weather", visitedAt: at(2026, 11, 5, 9) }];

  it("groups by local day, newest first, and leaves out moves to watching", () => {
    const days = timelineDays(sessions, events, null, titles, "");
    expect(days.map((d) => d.id)).toEqual([startOfDay(at(2026, 11, 6)), startOfDay(at(2026, 11, 4))]);
    expect(days[0]!.entries.map((e) => e.id)).toEqual(["s11", "s10"]);
    expect(days[1]!.entries.map((e) => e.id)).toEqual(["e1", "s12"]);
  });

  it("adds pages browsed when asked", () => {
    const days = timelineDays(sessions, events, visits, titles, "");
    expect(days.map((d) => d.entries.length)).toEqual([2, 1, 2]);
    expect(days[1]!.entries[0]!.kind).toBe("visit");
  });

  it("filters by the title's normalised name, and visits by title and host", () => {
    expect(timelineDays(sessions, events, visits, titles, "SEVER").flatMap((d) => d.entries.map((e) => e.id))).toEqual(["s11", "s12"]);
    expect(timelineDays(sessions, events, visits, titles, "weather").flatMap((d) => d.entries.map((e) => e.id))).toEqual(["h7"]);
    expect(timelineDays(sessions, events, visits, titles, "news.example").flatMap((d) => d.entries.map((e) => e.id))).toEqual(["h7"]);
  });
});

describe("week and month totals", () => {
  it("starts the week on the locale's first day", () => {
    const thursday = new Date(2026, 10, 5, 15);
    expect(startOfWeek(thursday, 1)).toBe(at(2026, 11, 2, 0));
    expect(startOfWeek(thursday, 7)).toBe(at(2026, 11, 1, 0));
    const monday = new Date(2026, 10, 2, 8);
    expect(startOfWeek(monday, 1)).toBe(at(2026, 11, 2, 0));
    expect(startOfMonth(thursday)).toBe(at(2026, 11, 1, 0));
  });

  it("adds up watched seconds since a date", () => {
    const list = [
      session(1, 1, at(2026, 11, 3), { watchedSeconds: 600 }),
      session(2, 1, at(2026, 10, 30), { watchedSeconds: 1200 }),
    ];
    expect(watchedSince(list, at(2026, 11, 2, 0))).toBe(600);
    expect(watchedSince(list, at(2026, 10, 1, 0))).toBe(1800);
    expect(statText(0)).toBe("None");
    expect(statText(3720)).toBe("1 h 2 min");
  });
});

describe("frames", () => {
  const frames = [frame(1, 100, 5), frame(2, 700, 9), frame(3, 1400, 2), frame(4, 2000, 3), frame(5, 3300, 20), frame(6, 3400, 1)];

  it("gives one reel per 25 minutes watched, up to three", () => {
    expect(reels([], 9000)).toEqual([]);
    expect(reels(frames, 600).map((r) => r.map((f) => f.id))).toEqual([[1, 2, 3, 4, 5, 6]]);
    expect(reels(frames, 1600).map((r) => r.map((f) => f.id))).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(reels(frames, 9000).map((r) => r.map((f) => f.id))).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    expect(reels(frames.slice(0, 2), 9000)).toHaveLength(2);
  });

  it("picks the most interesting frame before the credits, a saved moment always counting", () => {
    expect(heroFrame(frames, 3600)!.id).toBe(2);
    expect(heroFrame([...frames, frame(7, 3500, 50, true)], 3600)!.id).toBe(7);
    expect(heroFrame(frames, 0)!.id).toBe(5);
    expect(heroFrame([frame(1, 3500, 4)], 3600)!.id).toBe(1);
    // The first of equals, as Swift's max(by:).
    expect(heroFrame([frame(1, 10, 3), frame(2, 20, 3)], 3600)!.id).toBe(1);
    expect(heroFrame([], 3600)).toBeNull();
  });

  it("scrubs across the frame", () => {
    expect(scrubIndex(0, 156, 6)).toBe(0);
    expect(scrubIndex(78, 156, 6)).toBe(3);
    expect(scrubIndex(156, 156, 6)).toBe(5);
    expect(scrubIndex(-20, 156, 6)).toBe(0);
  });
});

describe("session rows", () => {
  it("say where it stopped", () => {
    expect(sessionSubtitle(session(1, 1, 0, { endPosition: 723, duration: 2890 }))).toBe("Stopped at 12:03 of 48:10");
    expect(sessionSubtitle(session(1, 1, 0, { finished: true }))).toBe("Finished");
    expect(sessionSubtitle(session(1, 1, 0, { duration: 0 }))).toBe("");
    expect(sessionSubtitle(session(1, 1, 0, { ref: EpisodeRef.make(1, 2), episodeName: "Half Loop", finished: true }))).toBe(
      "S1 E2, Half Loop. Finished",
    );
    expect(sessionSubtitle(session(1, 1, 0, { ref: EpisodeRef.make(2, 5), duration: 0 }))).toBe("Season 2, episode 5");
  });

  it("find a still", () => {
    const t = title(1, "Severance", { imdbId: "tt11280740", backdropUrl: "https://img/b.jpg", posterUrl: "https://img/p.jpg" });
    expect(sessionStill(session(1, 1, 0, { ref: EpisodeRef.make(1, 2) }), t)).toBe("https://episodes.metahub.space/tt11280740/1/2/w780.jpg");
    expect(sessionStill(session(1, 1, 0), t)).toBe("https://img/b.jpg");
    expect(sessionStill(session(1, 1, 0), { ...t, backdropUrl: null })).toBe("https://img/p.jpg");
    expect(sessionStill(session(1, 1, 0), null)).toBeNull();
  });

  it("know when they can carry on", () => {
    expect(canResume(session(1, 1, 0, { url: "https://site.to/a" }))).toBe(true);
    expect(canResume(session(1, 1, 0, { url: "https://site.to/a", finished: true }))).toBe(false);
    expect(canResume(session(1, 1, 0, { url: "https://site.to/a", duration: 0 }))).toBe(false);
    expect(canResume(session(1, 1, 0))).toBe(false);
    expect(sessionFraction(session(1, 1, 0, { endPosition: 1800 }))).toBe(0.5);
    expect(sessionFraction(session(1, 1, 0, { endPosition: 9000 }))).toBe(1);
  });

  it("name visits by title, else by path", () => {
    expect(visitName({ id: 1, url: "https://a.b/c/d?x=1", host: "a.b", title: "", visitedAt: 0 })).toBe("/c/d");
    expect(visitName({ id: 1, url: "https://a.b/c", host: "a.b", title: "Hello", visitedAt: 0 })).toBe("Hello");
  });
});
