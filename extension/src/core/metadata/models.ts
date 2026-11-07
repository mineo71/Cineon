// What the catalogue lookups return. Port of the records in Core/Metadata.swift (C#'s
// MetadataModels.cs). Addresses are Foundation's `absoluteString`; dates are milliseconds since 1970,
// so these survive extension messaging, which may send JSON.

import type { TitleKind } from "../parsing/data-copy/models";

/** One search result: an IMDb ID and what the suggestion said about it. */
export interface MetadataHit {
  id: string;
  name: string;
  year: number | null;
  kind: TitleKind;
  posterUrl: string | null;
  subtitle: string | null;
  rank: number | null;
}

export function metadataHit(
  id: string,
  name: string,
  year: number | null,
  kind: TitleKind,
  extra: Partial<Pick<MetadataHit, "posterUrl" | "subtitle" | "rank">> = {},
): MetadataHit {
  return { id, name, year, kind, posterUrl: extra.posterUrl ?? null, subtitle: extra.subtitle ?? null, rank: extra.rank ?? null };
}

export interface EpisodeInfo {
  /** "2x4", as on the Mac. */
  readonly id: string;
  season: number;
  episode: number;
  name: string | null;
  overview: string | null;
  thumbnailUrl: string | null;
  /** Milliseconds since 1970. */
  released: number | null;
}

/** An episode, with its id filled in. */
export function episodeInfo(
  season: number,
  episode: number,
  extra: Partial<Pick<EpisodeInfo, "name" | "overview" | "thumbnailUrl" | "released">> = {},
): EpisodeInfo {
  return {
    id: `${season}x${episode}`,
    season,
    episode,
    name: extra.name ?? null,
    overview: extra.overview ?? null,
    thumbnailUrl: extra.thumbnailUrl ?? null,
    released: extra.released ?? null,
  };
}

export interface MetadataDetail {
  overview: string | null;
  genres: string[];
  runtimeMinutes: number | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  year: number | null;
  /** Numbered seasons only, in order. */
  episodes: EpisodeInfo[];
}
