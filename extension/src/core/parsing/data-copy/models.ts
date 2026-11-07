// The two model types parsing shares with the data layer (Swift's Core/Models.swift), kept here
// until src/core/data lands; then this file should re-export those. Same raw values as the apps.

/** `TitleKind`'s raw values, as the Mac and Windows store them. */
export type TitleKind = "film" | "series" | "cartoon" | "unknown";

export const TITLE_KINDS: readonly TitleKind[] = ["film", "series", "cartoon", "unknown"];

/** A raw value from storage or the network, or null when it isn't one. */
export function titleKindFromRaw(raw: string | null | undefined): TitleKind | null {
  return raw === "film" || raw === "series" || raw === "cartoon" || raw === "unknown" ? raw : null;
}

/** A season and episode. Films are season 0, episode 0. */
export interface EpisodeRef {
  readonly season: number;
  readonly episode: number;
}

export const EpisodeRef = Object.freeze({
  /** Films are stored as season 0, episode 0. */
  none: Object.freeze({ season: 0, episode: 0 }) as EpisodeRef,
  of(season: number, episode: number): EpisodeRef {
    return { season, episode };
  },
  isEpisode(ref: EpisodeRef): boolean {
    return ref.season > 0 || ref.episode > 0;
  },
  equals(a: EpisodeRef | null | undefined, b: EpisodeRef | null | undefined): boolean {
    return a === b || (a != null && b != null && a.season === b.season && a.episode === b.episode);
  },
});
