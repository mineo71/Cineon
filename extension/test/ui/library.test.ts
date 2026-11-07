import { describe, expect, it } from "vitest";
import { EpisodeAlert, LibraryQuery, RatingFilter, Title, WatchProgress } from "../../src/core/data";
import {
  alertBadge,
  checklistDetail,
  factsLine,
  freshAlerts,
  genreLabel,
  gridLayout,
  heroDetailLine,
  libraryEmptyText,
  librarySummary,
  listCount,
  nudged,
  posterSubtitle,
  rateDetail,
  rateFinishedText,
  rateKey,
  rateQueue,
  resumeLabel,
  unratedCount,
  visibleRows,
} from "../../src/ui/lib/library";
import { initialSeason, placesFor, skipText } from "../../src/ui/screens/TitleDetail";
import { SkipRule } from "../../src/core/data";
import { episodeInfo } from "../../src/core/metadata";

const t = (fields: Partial<Title>) => Title.make({ name: "X", normName: "x", ...fields });

describe("Home", () => {
  it("describes where you stopped", () => {
    const p = WatchProgress.make({ host: "www.watch.site.to", position: 600, duration: 3000, ref: { season: 1, episode: 2 } });
    expect(heroDetailLine(p)).toBe("Season 1, episode 2. 40 min left on site.to");
    expect(resumeLabel(p)).toBe("Resume at 10:00");
    const visit = WatchProgress.make({ host: "site.to", updatedAt: Date.now() / 1000 - 7200 });
    expect(heroDetailLine(visit)).toBe("Last opened on site.to 2 hours ago");
    expect(resumeLabel(visit)).toBe("Open on site.to");
  });

  it("keeps fresh episode alerts from the last three weeks you haven't watched since", () => {
    const now = 1_800_000_000;
    const titles = new Map([
      [1, t({ id: 1, status: "watching", lastWatchedAt: now - 10 * 86_400 })],
      [2, t({ id: 2, status: "watching", lastWatchedAt: now - 3600 })],
      [3, t({ id: 3, status: "watched" })],
      [4, t({ id: 4, status: "backlog" })],
    ]);
    const alerts = [
      EpisodeAlert.make({ titleId: 1, newCount: 1, newAt: now - 2 * 86_400, newest: { season: 2, episode: 3 } }),
      EpisodeAlert.make({ titleId: 2, newCount: 2, newAt: now - 86_400 }),
      EpisodeAlert.make({ titleId: 3, newCount: 1, newAt: now - 86_400 }),
      EpisodeAlert.make({ titleId: 4, newCount: 3, newAt: now - 22 * 86_400 }),
      EpisodeAlert.make({ titleId: 4, newCount: 3, newAt: now - 86_400 }),
    ];
    const fresh = freshAlerts(alerts, titles, now);
    expect(fresh.map((f) => f.title.id)).toEqual([4, 1]);
    expect(alertBadge(fresh[1]!.alert)).toBe("S2 E3");
    expect(alertBadge(fresh[0]!.alert)).toBe("3 new");
    expect(alertBadge(EpisodeAlert.make({ newCount: 1 }))).toBe("New");
  });

  it("subtitles posters with the episode, the year or the kind", () => {
    expect(posterSubtitle(t({ year: 1999 }), WatchProgress.make({ ref: { season: 3, episode: 1 } }))).toBe("S3 E1");
    expect(posterSubtitle(t({ year: 1999 }), null)).toBe("1999");
    expect(posterSubtitle(t({ kind: "series" }), null)).toBe("Series");
  });
});

describe("Library", () => {
  const titles = [
    t({ id: 1, status: "backlog" }),
    t({ id: 2, status: "watching", ratingHalves: 15 }),
    t({ id: 3, status: "watched", ratingHalves: 16 }),
    t({ id: 4, status: "watched" }),
    t({ id: 5, status: "none" }),
  ];

  it("counts each list, everything leaving out titles in no list", () => {
    expect(listCount(titles, "all")).toBe(4);
    expect(listCount(titles, "backlog")).toBe(1);
    expect(listCount(titles, "watched")).toBe(2);
  });

  it("sums up what's shown", () => {
    expect(librarySummary([titles[0]!])).toBe("1 title");
    expect(librarySummary(titles.slice(0, 4))).toBe("4 titles, 2 rated, averaging 7.8");
  });

  it("says why it's empty", () => {
    expect(libraryEmptyText(LibraryQuery.make({ text: "zz" }))).toBe("Nothing matches these filters.");
    expect(libraryEmptyText(LibraryQuery.make({ list: "watching" }))).toBe("Start playing something, and it appears here on its own.");
    expect(libraryEmptyText(LibraryQuery.make({ rating: RatingFilter.unrated }))).toBe("Nothing matches these filters.");
  });

  it("labels the genre filter", () => {
    expect(genreLabel([])).toBe("Genre");
    expect(genreLabel(["Drama"])).toBe("Drama");
    expect(genreLabel(["Drama", "Comedy", "War"])).toBe("3 genres");
  });

  it("writes rows' details", () => {
    const film = t({ year: 1999, kind: "film", runtimeMinutes: 136, genres: ["Action", "Sci-Fi", "Thriller", "Drama"] });
    expect(checklistDetail(film)).toBe("1999, Film, 2 h 16 min");
    expect(factsLine(film)).toBe("1999, Film, 2 h 16 min, Action, Sci-Fi, Thriller");
    expect(rateDetail(film)).toBe("1999   Film   Action, Sci-Fi, Thriller");
  });
});

describe("the poster grid", () => {
  it("fits as many 138 pt columns as it can, up to 190 each", () => {
    const wide = gridLayout(1000, 40);
    expect(wide.columns).toBe(6);
    expect(wide.itemWidth).toBeCloseTo((1000 - 18 * 5) / 6);
    expect(wide.rows).toBe(7);
    const narrow = gridLayout(100, 3);
    expect(narrow.columns).toBe(1);
    expect(narrow.itemWidth).toBe(138);
    // Never wider than 190: the columns leave room instead.
    const few = gridLayout(400, 2, 138, 190);
    expect(few.columns).toBe(2);
    expect(few.itemWidth).toBe(190);
  });

  it("builds only the rows near the screen", () => {
    const layout = gridLayout(1000, 600);
    const pitch = layout.rowHeight + 24;
    const top = visibleRows(layout, 0, 800);
    expect(top.first).toBe(0);
    expect(top.last).toBeLessThan(10);
    const middle = visibleRows(layout, pitch * 50, 800);
    expect(middle.first).toBe(48);
    expect(middle.last).toBeLessThanOrEqual(56);
    expect(visibleRows(gridLayout(1000, 0), 0, 800)).toEqual({ first: 0, last: -1 });
  });
});

describe("rate mode", () => {
  it("queues watched films and series in progress, unrated first unless asked, latest first", () => {
    const titles = [
      t({ id: 1, status: "watched", finishedAt: 100 }),
      t({ id: 2, status: "watched", finishedAt: 300, ratingHalves: 12 }),
      t({ id: 3, status: "watching", kind: "series", lastWatchedAt: 200 }),
      t({ id: 4, status: "watching", kind: "film", lastWatchedAt: 400 }),
      t({ id: 5, status: "backlog" }),
    ];
    expect(rateQueue(titles, false)).toEqual([3, 1]);
    expect(rateQueue(titles, true)).toEqual([2, 3, 1]);
    expect(unratedCount(titles)).toBe(1);
  });

  it("reads keys 1 to 0, arrows, delete, return, space and escape", () => {
    expect(rateKey({ key: "1" })).toEqual({ kind: "rate", halves: 2 });
    expect(rateKey({ key: "7" })).toEqual({ kind: "rate", halves: 14 });
    expect(rateKey({ key: "0" })).toEqual({ kind: "rate", halves: 20 });
    expect(rateKey({ key: "ArrowLeft" })).toEqual({ kind: "nudge", step: -1 });
    expect(rateKey({ key: "ArrowRight" })).toEqual({ kind: "nudge", step: 1 });
    expect(rateKey({ key: "Backspace" })).toEqual({ kind: "clear" });
    expect(rateKey({ key: "Delete" })).toEqual({ kind: "clear" });
    expect(rateKey({ key: "Enter" })).toEqual({ kind: "next" });
    expect(rateKey({ key: " " })).toEqual({ kind: "next" });
    expect(rateKey({ key: "Escape" })).toEqual({ kind: "exit" });
    expect(rateKey({ key: "a" })).toBeNull();
    expect(rateKey({ key: "5", metaKey: true })).toBeNull();
  });

  it("nudges from five stars when there's no rating, within 0.5 to 10", () => {
    expect(nudged(null, 1)).toBe(11);
    expect(nudged(1, -1)).toBe(1);
    expect(nudged(20, 1)).toBe(20);
  });

  it("thanks you", () => {
    expect(rateFinishedText(1)).toBe("You rated 1 film just now. They're saved, in the cloud too.");
    expect(rateFinishedText(0)).toBe("Everything you've watched has its stars.");
  });
});

describe("the title card", () => {
  it("lists each site once, latest first, leaving out places with no address", () => {
    const list = [
      WatchProgress.make({ host: "a.to", url: "https://a.to/2", updatedAt: 3 }),
      WatchProgress.make({ host: "b.to", url: null, updatedAt: 2 }),
      WatchProgress.make({ host: "a.to", url: "https://a.to/1", updatedAt: 1 }),
    ];
    expect(placesFor(list).map((p) => p.url)).toEqual(["https://a.to/2"]);
  });

  it("opens on the season you're in", () => {
    const episodes = [episodeInfo(2, 1), episodeInfo(1, 1), episodeInfo(3, 1)];
    expect(initialSeason(episodes, null)).toBe(1);
    expect(initialSeason(episodes, WatchProgress.make({ ref: { season: 3, episode: 2 } }))).toBe(3);
  });

  it("describes skips", () => {
    expect(skipText(SkipRule.make({ kind: "intro", start: 40, end: 112 }))).toBe("Intro, 0:40 to 1:52");
    expect(skipText(SkipRule.make({ kind: "credits", start: 120 }))).toBe("Credits, last 2 min");
  });
});
