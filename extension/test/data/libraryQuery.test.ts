// The library filter cases from windows/Cineon.Core.Tests/Data/ProfileAndRatingTests.cs.

import { LibraryQuery, LibraryText, RatingFilter, Title, type TitleKind, type TitleStatus } from "../../src/core/data";

function makeTitle(
  id: number,
  name: string,
  options: { status?: TitleStatus; kind?: TitleKind; year?: number | null; genres?: string[]; halves?: number | null; runtime?: number | null } = {},
): Title {
  const at = Date.now() / 1000;
  return Title.make({
    id,
    name,
    normName: LibraryText.normalize(name),
    year: options.year === undefined ? 2010 : options.year,
    kind: options.kind ?? "film",
    status: options.status ?? "watched",
    genres: options.genres ?? [],
    runtimeMinutes: options.runtime ?? null,
    ratingHalves: options.halves ?? null,
    addedAt: at,
    updatedAt: at,
    metadataChecked: true,
  });
}

test("filters and sorts", () => {
  const titles = [
    makeTitle(1, "Alien", { year: 1979, genres: ["Horror", "Sci-Fi"], halves: 18, runtime: 117 }),
    makeTitle(2, "Blade Runner", { year: 1982, genres: ["Science Fiction"], halves: 15, runtime: 117 }),
    makeTitle(3, "Clueless", { year: 1995, genres: ["Comedy"], halves: null, runtime: 97 }),
    makeTitle(4, "Dune", { status: "backlog", year: 2021, genres: ["Sci-Fi"], halves: null, runtime: 155 }),
    makeTitle(5, "Euphoria", { status: "watching", kind: "series", year: 2019, genres: ["Drama"], halves: 12 }),
  ];
  const ids = (query: Partial<LibraryQuery>, downloaded?: ReadonlySet<number>) =>
    LibraryQuery.apply(LibraryQuery.make(query), titles, downloaded).map((t) => t.id);

  // Science Fiction counts as Sci-Fi.
  expect(ids({ genres: ["Sci-Fi"] }).sort()).toEqual([1, 2, 4]);
  expect(ids({ rating: RatingFilter.atLeast(7), sort: "ratingHigh" })).toEqual([1, 2]);
  expect(ids({ rating: RatingFilter.unrated, list: "watched" })).toEqual([3]);
  expect(ids({ decade: 1980 })).toEqual([2]);
  expect(ids({ kind: "series" })).toEqual([5]);
  expect(ids({ onThisMac: true }, new Set([3]))).toEqual([3]);
  expect(ids({ onThisMac: true })).toEqual([]);
  // Lowest first, unrated last by name.
  expect(ids({ sort: "ratingLow" })).toEqual([5, 2, 1, 3, 4]);
  expect(ids({ rating: RatingFilter.below(7) })).toEqual([5]);
  expect(ids({ sort: "longest" })).toEqual([4, 1, 2, 3, 5]);
  expect(ids({ sort: "name" })).toEqual([1, 2, 3, 4, 5]);
  expect(ids({ sort: "newest" })).toEqual([4, 5, 3, 2, 1]);

  let query = LibraryQuery.make({ sort: "oldest" });
  expect(LibraryQuery.apply(query, titles)[0]!.id).toBe(1);
  query = { ...query, text: "blade" };
  expect(LibraryQuery.apply(query, titles).map((t) => t.id)).toEqual([2]);
  expect(LibraryQuery.hasFilters(query)).toBe(true);
});

test("recent puts the last watched first", () => {
  const a = { ...makeTitle(1, "A"), lastWatchedAt: 300 };
  const b = { ...makeTitle(2, "B"), finishedAt: 500 };
  const c = { ...makeTitle(3, "C"), addedAt: 400, lastWatchedAt: null };
  expect(LibraryQuery.apply(LibraryQuery.make(), [a, b, c]).map((t) => t.id)).toEqual([2, 3, 1]);
  const d = { ...makeTitle(4, "D"), addedAt: 10 };
  const e = { ...makeTitle(5, "E"), addedAt: 20 };
  expect(LibraryQuery.apply(LibraryQuery.make({ sort: "added" }), [d, e]).map((t) => t.id)).toEqual([5, 4]);
});

test("genres and decades in a library", () => {
  const titles = [
    makeTitle(1, "Alien", { year: 1979, genres: ["Horror", "Sci-Fi"] }),
    makeTitle(2, "Blade Runner", { year: 1982, genres: ["Science Fiction", "sci-fi"] }),
    makeTitle(3, "Clueless", { year: 1995, genres: ["comedy"] }),
    makeTitle(4, "Old", { year: 1880, genres: [] }),
  ];
  expect(LibraryQuery.genresIn(titles)).toEqual([
    { name: "Sci-Fi", count: 2 },
    { name: "Comedy", count: 1 },
    { name: "Horror", count: 1 },
  ]);
  expect(LibraryQuery.decadesIn(titles)).toEqual([1990, 1980, 1970]);
});

test("names sort like Finder", () => {
  const names = ["alien 10", "Alien 2", "Alien", "Ánimo", "Zebra", "apple"];
  expect([...names].sort(LibraryQuery.compareNames)).toEqual(["Alien", "Alien 2", "alien 10", "Ánimo", "apple", "Zebra"]);
  expect(LibraryQuery.compareNames("Dune", "dune")).not.toBe(0);
});

test("queries compare by value", () => {
  const a = LibraryQuery.make({ genres: ["Drama", "Horror"] });
  const b = LibraryQuery.make({ genres: ["Horror", "Drama"] });
  expect(LibraryQuery.equals(a, b)).toBe(true);
  expect(LibraryQuery.equals(a, { ...b, rating: RatingFilter.atLeast(5) })).toBe(false);
  expect(RatingFilter.equals(RatingFilter.atLeast(8), RatingFilter.atLeast(8))).toBe(true);
  expect(RatingFilter.equals(RatingFilter.atLeast(8), RatingFilter.below(8))).toBe(false);
  expect(LibraryQuery.hasFilters(LibraryQuery.make())).toBe(false);
  expect(RatingFilter.label(RatingFilter.atLeast(8))).toBe("8 and up");
  expect(RatingFilter.label(RatingFilter.below(5))).toBe("Under 5");
  expect(RatingFilter.choices).toHaveLength(7);
  // Plain data: survives JSON.
  expect(JSON.parse(JSON.stringify(a))).toEqual(a);
});
