// Port of windows/Cineon.Core.Tests/Profile/ProfileStatsTests.cs: the profile tests from
// CineonTests/ProfileAndRatingTests.swift, plus the Windows ones for the stats' own inputs.

import {
  PixelPet, PetTraits, ProfileStats, type StatsSession, type StatsStatus, type StatsTitle,
} from "../../src/core/profile";

/** Somewhere not UTC, so local days and hours are really local (Etc/GMT-2 is UTC+2). */
const ZONE = "Etc/GMT-2";

function localTime(year: number, month: number, day: number, hour: number): Date {
  return new Date(Date.UTC(year, month - 1, day, hour - 2));
}

const addSeconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000);
const addHours = (d: Date, h: number) => addSeconds(d, h * 3600);
const addDays = (d: Date, days: number) => addHours(d, days * 24);

function title(
  id: number, name: string,
  { status = "watched" as StatsStatus, series = false, year = 2010 as number | null, genres = [] as string[],
    halves = null as number | null, runtime = null as number | null } = {},
): StatsTitle {
  return { id, name, status, isSeries: series, year, genres, ratingHalves: halves, runtimeMinutes: runtime };
}

test("profile stats from a library", () => {
  const now = localTime(2026, 11, 5, 22);
  const titles = [
    title(1, "Alien", { genres: ["Horror", "Sci-Fi"], halves: 18, runtime: 117 }),
    title(2, "Heat", { genres: ["Crime", "Drama"], halves: 16, runtime: 170 }),
    title(3, "Saw", { genres: ["Horror"], halves: 10 }),
    title(4, "Lost", { status: "watching", series: true, year: 2004, genres: ["Drama", "Mystery"] }),
  ];
  const session = (titleId: number, daysAgo: number, hour: number, seconds: number): StatsSession => {
    const start = addHours(addDays(localTime(2026, 11, 5, 0), -daysAgo), hour);
    return { titleId, startedAt: start, endedAt: addSeconds(start, seconds), watchedSeconds: seconds };
  };
  const sessions = [session(4, 0, 21, 3600), session(4, 1, 21, 1800), session(4, 2, 20, 2700), session(1, 10, 23, 7000)];
  const progress = Array.from({ length: 6 }, () => ({ titleId: 4, isEpisode: true, finished: true }));
  const stats = ProfileStats.compute(titles, sessions, progress, { now, timeZone: ZONE });
  expect(stats.filmsWatched).toBe(3);
  expect(stats.episodesFinished).toBe(6);
  expect(stats.rated).toBe(3);
  expect(stats.averageRating ?? 0).toBeCloseTo((9 + 8 + 5) / 3.0, 3);
  expect(stats.ratingCounts[8]).toBe(1); // a 9 lands in the ninth bucket
  expect(stats.currentStreak).toBe(3);
  expect(stats.longestStreak).toBe(3);
  expect(stats.trackedHours).toBeCloseTo((3600 + 1800 + 2700 + 7000) / 3600.0, 3);
  // Heat and Saw were never timed, so their runtimes count, Saw with the usual length.
  expect(stats.estimatedHours).toBeCloseTo(stats.trackedHours + 170.0 / 60 + 110.0 / 60, 3);
  expect(stats.favouriteGenre).toBe("Horror");
  expect(stats.genres.reduce((sum, g) => sum + g.weight, 0)).toBeCloseTo(1, 4);
  expect(stats.busiestHour).toBe(21);
  expect(stats.topTitles[0]!.id).toBe(4); // Lost had the most time, over three evenings
  expect(stats.daysSinceLastWatch(now, ZONE)).toBe(0);
  expect(stats.petTraits("abc", now, ZONE).titlesFinished).toBe(stats.titlesFinished);
});

test("an empty library has calm stats", () => {
  const stats = ProfileStats.compute([], [], []);
  expect(stats.favouriteGenre).toBeNull();
  expect(stats.averageRating).toBeNull();
  expect(stats.busiestWeekday).toBeNull();
  expect(stats.daysSinceLastWatch()).toBeNull();
  expect(stats.currentStreak).toBe(0);
});

// MARK: Windows additions

test("days, weekdays and hours are local", () => {
  // 23:30 UTC on Sunday 1 November is 01:30 on Monday 2 November two hours east.
  const start = new Date(Date.UTC(2026, 10, 1, 23, 30));
  const now = new Date(Date.UTC(2026, 10, 3, 12));
  const stats = ProfileStats.compute(
    [title(1, "Heat")], [{ titleId: 1, startedAt: start, endedAt: addHours(start, 2), watchedSeconds: 7200 }], [],
    { now, timeZone: ZONE });
  expect(stats.busiestWeekday).toBe(0); // Monday
  expect(stats.busiestHour).toBe(1);
  expect(stats.binge?.day).toEqual({ year: 2026, month: 11, day: 2 });
  expect(stats.currentStreak).toBe(1); // yesterday, locally
  expect(stats.daysSinceLastWatch(now, ZONE)).toBe(1);
});

test("genres merge under one name", () => {
  expect(ProfileStats.canonicalGenre("Science Fiction")).toBe("Sci-Fi");
  expect(ProfileStats.canonicalGenre(" sci-fi ")).toBe("Sci-Fi");
  expect(ProfileStats.canonicalGenre("Film Noir")).toBe("Film-Noir");
  expect(ProfileStats.canonicalGenre("tv movie")).toBe("TV Movie");
  expect(ProfileStats.canonicalGenre("drama")).toBe("Drama");
  expect(ProfileStats.canonicalGenre(" drama")).toBe(" drama"); // Swift keeps the raw text here too
  expect(ProfileStats.canonicalGenre("")).toBe("");
  const stats = ProfileStats.compute(
    [title(1, "Alien", { genres: ["Science Fiction"] }), title(2, "Dune", { genres: ["Sci-Fi"] }),
      title(3, "Heat", { genres: ["Crime"] })],
    [], []);
  expect(stats.favouriteGenre).toBe("Sci-Fi");
  expect(stats.genres.length).toBe(2);
  expect(stats.favouriteDecade).toBe(2010);
});

test("the pet grows from the stats", () => {
  const now = localTime(2026, 11, 5, 22);
  const stats = ProfileStats.compute(
    [title(1, "Alien", { genres: ["Horror"] }), title(2, "Heat", { genres: ["Crime"], status: "backlog" })],
    [{ titleId: 1, startedAt: addHours(now, -3), endedAt: addHours(now, -1), watchedSeconds: 7200 }], [],
    { now, timeZone: ZONE });
  const pet = PixelPet.make(stats.petTraits(PetTraits.seedFor("8e1f3c1a-7a43-4c1b-9c0b-2b7d1d6c9a11"), now, ZONE));
  expect(pet.species).toBe("ghost");
  expect(pet.accessory).toBe("fedora");
  expect(pet.mood).toBe("happy");
});

// MARK: Extension additions

test("the first character is upper-cased as Swift does", () => {
  // Swift's uppercased() uses the full mapping (C#'s invariant one keeps ß).
  expect(ProfileStats.canonicalGenre("ßport")).toBe("SSport");
  // A whole grapheme: e + combining acute stays together.
  expect(ProfileStats.canonicalGenre("épique")).toBe("Épique");
});

test("stats equality looks at the same few fields as the Mac", () => {
  const a = ProfileStats.compute([title(1, "Heat", { genres: ["Crime"] })], [], []);
  const b = ProfileStats.compute([title(1, "Heat", { genres: ["Crime"] })], [], []);
  const c = ProfileStats.compute([title(1, "Heat", { genres: ["Drama"] })], [], []);
  expect(a.equals(b)).toBe(true);
  expect(a.equals(c)).toBe(false);
});
