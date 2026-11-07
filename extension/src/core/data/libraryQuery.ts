// Port of Cineon/Core/LibraryQuery.swift via windows/Cineon.Core/Data/LibraryQuery.cs. Swift's
// nested LibraryQuery.List, .Kind, .RatingFilter and .Sort are LibraryList, LibraryKind,
// RatingFilter and LibrarySort here, with the Mac's raw strings. A query is a plain object, so it
// can be kept in settings or sent between pages as is.

import { LibraryText } from "./libraryText";
import { Title } from "./models";

/** Swift's `LibraryQuery.List`. */
export type LibraryList = "all" | "backlog" | "watching" | "watched";
const LISTS: readonly LibraryList[] = ["all", "backlog", "watching", "watched"];
export const LibraryList = {
  allCases: LISTS,
  fromRaw(raw: unknown): LibraryList | null {
    return LISTS.includes(raw as LibraryList) ? (raw as LibraryList) : null;
  },
  label(list: LibraryList): string {
    return { all: "Everything", backlog: "Backlog", watching: "Watching", watched: "Watched" }[list];
  },
  matches(list: LibraryList, title: Title): boolean {
    return list === "all" || title.status === list;
  },
};

/** Swift's `LibraryQuery.Kind`. */
export type LibraryKind = "any" | "films" | "series" | "cartoons";
const KINDS: readonly LibraryKind[] = ["any", "films", "series", "cartoons"];
export const LibraryKind = {
  allCases: KINDS,
  fromRaw(raw: unknown): LibraryKind | null {
    return KINDS.includes(raw as LibraryKind) ? (raw as LibraryKind) : null;
  },
  label(kind: LibraryKind): string {
    return { any: "All", films: "Films", series: "Series", cartoons: "Cartoons" }[kind];
  },
  matches(kind: LibraryKind, title: Title): boolean {
    switch (kind) {
      case "films":
        return title.kind === "film" || title.kind === "unknown";
      case "series":
        return title.kind === "series";
      case "cartoons":
        return title.kind === "cartoon";
      default:
        return true;
    }
  },
};

/** Swift's `LibraryQuery.RatingFilter`: any, unrated, at least or below a number of stars out of ten. */
export type RatingFilter =
  | { readonly kind: "any" }
  | { readonly kind: "unrated" }
  | { readonly kind: "atLeast"; readonly stars: number }
  | { readonly kind: "below"; readonly stars: number };

export const RatingFilter = {
  any: Object.freeze({ kind: "any" }) as RatingFilter,
  unrated: Object.freeze({ kind: "unrated" }) as RatingFilter,
  /** At least this many stars out of ten. */
  atLeast(stars: number): RatingFilter {
    return { kind: "atLeast", stars };
  },
  below(stars: number): RatingFilter {
    return { kind: "below", stars };
  },

  label(filter: RatingFilter): string {
    switch (filter.kind) {
      case "unrated":
        return "Not rated yet";
      case "atLeast":
        return `${filter.stars} and up`;
      case "below":
        return `Under ${filter.stars}`;
      default:
        return "Any rating";
    }
  },

  get choices(): readonly RatingFilter[] {
    return [
      RatingFilter.any,
      RatingFilter.unrated,
      RatingFilter.atLeast(9),
      RatingFilter.atLeast(8),
      RatingFilter.atLeast(7),
      RatingFilter.atLeast(5),
      RatingFilter.below(5),
    ];
  },

  matches(filter: RatingFilter, title: Title): boolean {
    const rating = Title.rating(title);
    switch (filter.kind) {
      case "unrated":
        return title.ratingHalves == null;
      case "atLeast":
        return (rating ?? -1) >= filter.stars;
      case "below":
        return rating != null && rating < filter.stars;
      default:
        return true;
    }
  },

  equals(a: RatingFilter, b: RatingFilter): boolean {
    if (a.kind !== b.kind) return false;
    return !("stars" in a) || a.stars === (b as { stars: number }).stars;
  },
};

/** Swift's `LibraryQuery.Sort`. */
export type LibrarySort = "recent" | "added" | "ratingHigh" | "ratingLow" | "name" | "newest" | "oldest" | "longest";
const SORTS: readonly LibrarySort[] = ["recent", "added", "ratingHigh", "ratingLow", "name", "newest", "oldest", "longest"];
export const LibrarySort = {
  allCases: SORTS,
  fromRaw(raw: unknown): LibrarySort | null {
    return SORTS.includes(raw as LibrarySort) ? (raw as LibrarySort) : null;
  },
  label(sort: LibrarySort): string {
    return {
      recent: "Recently watched",
      added: "Recently added",
      ratingHigh: "Highest rated",
      ratingLow: "Lowest rated",
      name: "Name",
      newest: "Newest first",
      oldest: "Oldest first",
      longest: "Longest first",
    }[sort];
  },
};

/** How the library is filtered and sorted. Pure, so the rules can be tested. */
export interface LibraryQuery {
  readonly list: LibraryList;
  readonly kind: LibraryKind;
  /** A set of canonical genre names (order doesn't matter). */
  readonly genres: readonly string[];
  readonly rating: RatingFilter;
  /** The first year of a decade, such as 1990. */
  readonly decade: number | null;
  /** Only what's downloaded to this computer (the Mac's name kept). */
  readonly onThisMac: boolean;
  readonly text: string;
  readonly sort: LibrarySort;
}

const names = new Intl.Collator(undefined, { numeric: true, sensitivity: "accent", ignorePunctuation: false });

/** Both present, one present, or neither: the shared shape of the rating and year sorts. */
function compareOptional(
  x: number | null,
  y: number | null,
  higherFirst: boolean,
  byName: () => boolean,
): boolean {
  if (x != null && y != null) return x === y ? byName() : higherFirst ? x > y : x < y;
  if (x != null) return true;
  if (y != null) return false;
  return byName();
}

function isOrderedBefore(sort: LibrarySort, a: Title, b: Title): boolean {
  const byName = () => LibraryQuery.compareNames(a.name, b.name) < 0;
  switch (sort) {
    case "recent": {
      const x = a.lastWatchedAt ?? a.finishedAt ?? a.addedAt;
      const y = b.lastWatchedAt ?? b.finishedAt ?? b.addedAt;
      return x === y ? byName() : x > y;
    }
    case "added":
      return a.addedAt === b.addedAt ? byName() : a.addedAt > b.addedAt;
    case "ratingHigh":
    case "ratingLow":
      // Unrated always last, whichever way.
      return compareOptional(a.ratingHalves, b.ratingHalves, sort === "ratingHigh", byName);
    case "name":
      return byName();
    case "newest":
    case "oldest":
      return compareOptional(a.year, b.year, sort === "newest", byName);
    default: {
      const x = a.runtimeMinutes ?? -1;
      const y = b.runtimeMinutes ?? -1;
      return x === y ? byName() : x > y;
    }
  }
}

export const LibraryQuery = {
  make(fields: Partial<LibraryQuery> = {}): LibraryQuery {
    return {
      list: "all",
      kind: "any",
      genres: [],
      rating: RatingFilter.any,
      decade: null,
      onThisMac: false,
      text: "",
      sort: "recent",
      ...fields,
    };
  },

  /** Anything narrowing the list beyond which list and kind it is. */
  hasFilters(q: LibraryQuery): boolean {
    return q.genres.length > 0 || q.rating.kind !== "any" || q.decade != null || q.onThisMac || q.text.length > 0;
  },

  /** The titles this query keeps, in its order. `downloaded` holds the IDs of titles on this computer. */
  apply(q: LibraryQuery, titles: Iterable<Title>, downloaded?: ReadonlySet<number> | null): Title[] {
    const needle = LibraryText.normalize(q.text);
    const wanted = new Set(q.genres);
    const kept = [...titles].filter((title) => {
      if (!LibraryList.matches(q.list, title) || !LibraryKind.matches(q.kind, title) || !RatingFilter.matches(q.rating, title)) {
        return false;
      }
      if (needle.length > 0 && !title.normName.includes(needle)) return false;
      if (wanted.size > 0 && !title.genres.some((g) => wanted.has(LibraryText.canonicalGenre(g)))) return false;
      if (q.decade != null) {
        if (title.year == null || title.year < q.decade || title.year >= q.decade + 10) return false;
      }
      if (q.onThisMac && (downloaded == null || !downloaded.has(title.id))) return false;
      return true;
    });
    return kept.sort((a, b) => (isOrderedBefore(q.sort, a, b) ? -1 : isOrderedBefore(q.sort, b, a) ? 1 : 0));
  },

  /**
   * Finder's order, Swift's `localizedStandardCompare`: case-insensitive, numbers by value
   * ("Alien 2" before "Alien 10"), and never equal for different text.
   */
  compareNames(a: string, b: string): number {
    const result = names.compare(a, b);
    if (result !== 0) return result < 0 ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  },

  /** Swift's `genres(in:)`: the genres present in these titles, most common first. */
  genresIn(titles: Iterable<Title>): { name: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const title of titles) {
      for (const genre of new Set(title.genres.map(LibraryText.canonicalGenre))) {
        counts.set(genre, (counts.get(genre) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((x, y) => y.count - x.count || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  },

  /** Swift's `decades(in:)`: the decades present, newest first. */
  decadesIn(titles: Iterable<Title>): number[] {
    const decades = new Set<number>();
    for (const t of titles) {
      if (t.year == null) continue;
      const decade = Math.trunc(t.year / 10) * 10;
      if (decade > 1880) decades.add(decade);
    }
    return [...decades].sort((a, b) => b - a);
  },

  /** Value equality, with `genres` compared as a set. */
  equals(a: LibraryQuery, b: LibraryQuery): boolean {
    const x = new Set(a.genres);
    const y = new Set(b.genres);
    return (
      a.list === b.list &&
      a.kind === b.kind &&
      x.size === y.size &&
      [...x].every((g) => y.has(g)) &&
      RatingFilter.equals(a.rating, b.rating) &&
      a.decade === b.decade &&
      a.onThisMac === b.onThisMac &&
      a.text === b.text &&
      a.sort === b.sort
    );
  },
};
