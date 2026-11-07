// What Together and the cloud backup read and change in the profile's library. These are the parts of
// core/data's LibraryStore they use, written as small interfaces so this folder doesn't depend on the
// data port: its LibraryStore and Title fit them as they are (TogetherModel and CloudLibrary are
// generic over the title type, so the store's own Title flows through). Dates are seconds since 1970,
// as in the data layer.

export type TitleKind = "film" | "series" | "cartoon" | "unknown";
export type TitleStatus = "none" | "backlog" | "watching" | "watched";

export const TITLE_KINDS: readonly TitleKind[] = ["film", "series", "cartoon", "unknown"];
export const TITLE_STATUSES: readonly TitleStatus[] = ["none", "backlog", "watching", "watched"];

export function titleKindFromRaw(raw: string | null | undefined): TitleKind | null {
  return (TITLE_KINDS as readonly string[]).includes(raw ?? "") ? (raw as TitleKind) : null;
}

export function titleStatusFromRaw(raw: string | null | undefined): TitleStatus | null {
  return (TITLE_STATUSES as readonly string[]).includes(raw ?? "") ? (raw as TitleStatus) : null;
}

/** The Mac's `TitleStatus.label`. */
export function titleStatusLabel(status: TitleStatus): string {
  switch (status) {
    case "backlog":
      return "Backlog";
    case "watching":
      return "Watching";
    case "watched":
      return "Watched";
    default:
      return "Not in a list";
  }
}

/** The fields of a library title that Together and the backup read. */
export interface TogetherTitle {
  readonly id: number;
  readonly name: string;
  /** LibraryText.normalize(name): the library's matching key. */
  readonly normName: string;
  readonly year: number | null;
  readonly kind: TitleKind;
  readonly status: TitleStatus;
  readonly imdbId: string | null;
  /** The poster's address as text, or null. */
  readonly posterUrl: string | null;
  /** Out of ten in half steps (15 is 7.5), or null when not rated. */
  readonly ratingHalves: number | null;
  /** Seconds since 1970. */
  readonly updatedAt: number;
  /** When the rating was last set or cleared, in seconds since 1970. */
  readonly ratedAt: number | null;
  /** When the title was last filed into a list, in seconds since 1970. Null for imported titles. */
  readonly statusAt: number | null;
  readonly finishedAt: number | null;
}

/** One place someone stopped in a title (core/data's WatchProgress). */
export interface TogetherProgress {
  readonly titleId: number;
  /** Season and episode; films are 0, 0. */
  readonly ref: { readonly season: number; readonly episode: number };
  readonly position: number;
  readonly duration: number;
  readonly finished: boolean;
  /** Seconds since 1970. */
  readonly updatedAt: number;
}

/** WatchProgress.fraction. */
export function progressFraction(p: TogetherProgress): number {
  return p.duration > 0 ? Math.min(1, p.position / p.duration) : 0;
}

/** EpisodeRef.isEpisode. */
export function isEpisode(p: TogetherProgress): boolean {
  return p.ref.season > 0 || p.ref.episode > 0;
}

/** What `addTitle` is given for a friend's film. */
export interface AddTitleOptions {
  year?: number | null;
  kind?: TitleKind;
  status?: TitleStatus;
  imdbId?: string | null;
  posterUrl?: string | null;
}

/** The library as TogetherModel uses it: lookups, the Watched list, progress, and adding to the backlog. */
export interface TogetherLibrary<T extends TogetherTitle = TogetherTitle> {
  readonly titles: ReadonlyMap<number, T>;
  /** Watched titles, most recently finished first. */
  readonly watched: readonly T[];
  /** A title already in the library with this name (or alternative name) and, when known, year. */
  find(name: string, altName?: string | null, year?: number | null): T | null | undefined;
  progressList(titleId: number): readonly TogetherProgress[];
  setStatus(id: number, status: TitleStatus): Promise<void> | void;
  /** Adds a title, or returns the one with the same IMDb id. Null when it couldn't be stored. */
  addTitle(name: string, options: AddTitleOptions): Promise<T | null> | T | null;
}

/**
 * What the cloud backup restores, without it being sent straight back (LibraryStore.restore). A key
 * that's left out leaves that value alone: `halves: null` clears the rating, a missing `halves` keeps it.
 */
export interface RestoreValues {
  halves?: number | null;
  ratedAt?: number | null;
  status?: TitleStatus | null;
  statusAt?: number | null;
  finishedAt?: number | null;
}

/** The library as CloudLibrary uses it. */
export interface CloudLibrarySource<T extends TogetherTitle = TogetherTitle> {
  readonly titles: ReadonlyMap<number, T>;
  restore(id: number, values: RestoreValues): Promise<void> | void;
  /** Called when someone rates or files a title themselves (not on restore). CloudLibrary.start sets it. */
  onPersonalChange: ((title: T) => void) | null;
}
