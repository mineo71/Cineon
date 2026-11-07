// What the downloads need from the rest of the extension. Core has no tabs, toasts or pages, so the
// background (runtime) implements these. See notes/downloads.md for how.

import { type DownloadItem, type EpisodeRef, type MediaSource, type Title, type TitleKind } from "../data";

/** The extension around the download queue: toasts, playback, the download buttons, metadata. */
export interface DownloadHost {
  /** A toast, with a button when `actionTitle` is given. */
  showToast(message: string, actionTitle?: string, action?: () => void): void;
  /** Opens a finished download in the player (the Mac's `app.playDownload`). */
  playDownload(item: DownloadItem): void;
  /** Every tab that shows a download button updates it (`tab.refreshDownloadPill()`). */
  refreshDownloadPills(): void;
  /** Looks the title up in the catalogue (`session.metadata.enrich`). */
  enrichTitle(titleId: number, altName: string | null): void;
  /** How long a saved video runs, in seconds, or null when it can't be read. Optional. */
  mediaDuration?(item: DownloadItem): Promise<number | null>;
}

/** What the page in a tab says it is: the title parser's result (the Mac's `tab.parsed`). */
export interface PageTitle {
  readonly name: string;
  readonly altName?: string | null;
  readonly year?: number | null;
  readonly ref?: EpisodeRef;
  readonly kindHint?: TitleKind;
  readonly posterUrl?: string | null;
  readonly overview?: string | null;
}

/**
 * Methods of `window.__cineon` (media.js) the downloads call in a page: `seasonsOnPage()` →
 * number[], `episodesOnPage(season)` → number[], `openEpisode(season, episode, false)` → boolean,
 * `playQuietly()` → anything.
 */
export type PageMethod = "seasonsOnPage" | "episodesOnPage" | "openEpisode" | "playQuietly";

/** The browser tab a download starts from: the Mac's `BrowserTab` as the downloads see it. */
export interface DownloadTab {
  readonly url: string | null;
  /** The tab's title as shown. */
  readonly displayTitle: string;
  /** The library title the tab's page is linked to. */
  readonly linkedTitleId: number | null;
  /** The episode the watch tracker settled on (`tab.track?.ref`). */
  readonly trackRef: EpisodeRef | null;
  readonly parsed: PageTitle | null;
  /** Files the page's player asked for, from media.js's `sources` messages. */
  readonly sources: readonly MediaSource[];
  /** `MediaSource.best(sources, playingSource)`. */
  readonly bestSource: MediaSource | null;
  /** The address of the frame the files were found in: the Referer CDNs check. */
  readonly sourcesFrameUrl: string | null;
  /** How long the video in the player runs (`tab.media?.duration ?? 0`). */
  readonly mediaDuration: number;
  /**
   * Calls `window.__cineon[method](...args)` in the page's main frame, in the extension's isolated
   * world where media.js runs, and gives the result. Null when there's no page, no `__cineon`, or
   * it failed. (The apps evaluate a script string; MV3 can't, so the method is named instead.)
   */
  callPage(method: PageMethod, ...args: (number | boolean)[]): Promise<unknown>;
}

/** An episode as the catalogue lists it, for finding a season's episodes. */
export interface PublishedEpisode {
  readonly season: number;
  readonly episode: number;
  /** Seconds since 1970, or null when unknown (counts as already out). */
  readonly released: number | null;
}

/**
 * What SeasonGrabber needs from the browser and the catalogue (C#'s IEpisodeResolver).
 * - `makeHelperTab`: a hidden tab that opens episodes (see EpisodeHelperTab).
 * - `episodeUrl`: `EpisodeLinks.url(pageUrl, current, target)` from the parsing port.
 * - `isAlive`: `SiteProbe.check(url)` is alive.
 * - `publishedEpisodes`: the metadata port's episode list for the title, mapped.
 */
export interface EpisodeResolver {
  makeHelperTab(): Promise<EpisodeHelperTab>;
  /** The address of another episode of the series on the same site, or null when there's no way to tell. */
  episodeUrl(pageUrl: string, current: EpisodeRef, target: EpisodeRef): string | null;
  /** Whether the site answers this address with a page (not missing, not dead). */
  isAlive(url: string, signal: AbortSignal): Promise<boolean>;
  /** The series' episodes as the catalogue lists them, or none. */
  publishedEpisodes(title: Title, signal: AbortSignal): Promise<readonly PublishedEpisode[]>;
}

/**
 * A tab nobody looks at that opens episodes and reports the files their players ask for (the Mac's
 * helper BrowserTab in an off-screen window). Its `sources`/`bestSource` must update live as
 * media.js reports them for this tab. `close()` removes the tab; a closed tab ignores further calls.
 */
export interface EpisodeHelperTab extends DownloadTab {
  /** The address the tab is on now. */
  readonly currentUrl: string | null;
  load(url: string): void;
  reload(): void;
  pausePlayback(): void;
  close(): void;
}
