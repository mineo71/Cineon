// One browser tab as Cineon sees it: the Mac's BrowserTab (Browser/BrowserTab.swift), minus the web
// view, which belongs to the browser here. Everything is plain data, so the whole map survives the
// service worker stopping (it's written to chrome.storage.session and read back on wake).
// Dates are milliseconds since 1970 unless a field says otherwise; WatchSession inside a track keeps
// the data layer's seconds.

import {
  EpisodeRef,
  MediaSource,
  type MediaSourceKind,
  ShieldStats,
  type SkipRule,
  type TitleKind,
  type VoiceBoostState,
  type WatchSession,
} from "../core/data";
import type { PageMeta, ParsedTitle } from "../core/parsing";

/** One report from media.js (Swift's MediaEvent). */
export interface MediaEvent {
  readonly type: string;
  readonly position: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly muted: boolean;
  readonly rate: number;
  readonly width: number;
  readonly height: number;
  readonly isTopFrame: boolean;
  readonly frameUrl: string;
  readonly userActivated: boolean;
}

function num(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return fallback;
}

export const MediaEvent = {
  /** Swift's `MediaEvent(body)`: null without a `type`. */
  parse(body: unknown): MediaEvent | null {
    if (body == null || typeof body !== "object" || Array.isArray(body)) return null;
    const d = body as Record<string, unknown>;
    if (typeof d.type !== "string") return null;
    return {
      type: d.type,
      position: num(d.t, 0),
      duration: num(d.d, 0),
      paused: bool(d.paused, true),
      muted: bool(d.muted, false),
      rate: num(d.rate, 1),
      width: Math.trunc(num(d.w, 0)),
      height: Math.trunc(num(d.h, 0)),
      isTopFrame: bool(d.top, false),
      frameUrl: typeof d.frame === "string" ? d.frame : "",
      userActivated: bool(d.active, true),
    };
  },
};

/** What the interface shows about the video in a tab (Swift's MediaState). */
export interface MediaState {
  position: number;
  duration: number;
  isPlaying: boolean;
  rate: number;
}

export const MediaState = {
  fraction(m: MediaState): number {
    return m.duration > 0 ? Math.min(1, m.position / m.duration) : 0;
  },
};

/** The session being recorded in a tab (Swift's LiveTrack). `lastFlush` is milliseconds. */
export interface LiveTrack {
  titleId: number;
  ref: EpisodeRef;
  urlKey: string;
  session: WatchSession;
  lastFlush: number;
  startedWith: number;
  finishedAnnounced: boolean;
}

/** The episode after this one, and how to get there. */
export interface NextEpisodeTarget {
  ref: EpisodeRef;
  name: string | null;
  isOnPage: boolean;
  isNextInSeason: boolean;
  url: string | null;
}

/** A run of forward jumps (core/parsing's SkipJump, as plain data). `lastAt` is milliseconds. */
export interface JumpRun {
  from: number;
  to: number;
  lastAt: number;
}

/** What the autopilot knows about the video in one tab. Starts over on every page. */
export interface AutopilotState {
  rules: SkipRule[];
  jump: JumpRun | null;
  proposedIntro: { from: number; to: number } | null;
  didAskAboutIntro: boolean;
  lastSkip: { from: number; to: number } | null;
  target: NextEpisodeTarget | null;
  isResolving: boolean;
  isResolved: boolean;
  didOffer: boolean;
  isCountingDown: boolean;
  isDeclined: boolean;
  didMove: boolean;
  /** A sleep timer is waiting for this episode to end, so nothing should start after it. */
  isHeldForSleep: boolean;
}

export const AutopilotState = {
  make(): AutopilotState {
    return {
      rules: [],
      jump: null,
      proposedIntro: null,
      didAskAboutIntro: false,
      lastSkip: null,
      target: null,
      isResolving: false,
      isResolved: false,
      didOffer: false,
      isCountingDown: false,
      isDeclined: false,
      didMove: false,
      isHeldForSleep: false,
    };
  },
};

/** Where someone left an episode, to spot them skipping its credits. `at` is milliseconds. */
export interface EpisodeExit {
  titleId: number;
  ref: EpisodeRef;
  remaining: number;
  duration: number;
  at: number;
}

/** How far collecting frames has got for the video in one tab. `notBefore` is milliseconds. */
export interface FrameState {
  sessionId: number | null;
  count: number;
  lastPosition: number | null;
  blanks: number;
  isCapturing: boolean;
  notBefore: number;
}

export const FrameState = {
  make(): FrameState {
    return { sessionId: null, count: 0, lastPosition: null, blanks: 0, isCapturing: false, notBefore: 0 };
  },
};

export type RescueReason = "pageFailed" | "pageMissing" | "videoFailed" | "videoStalled" | "manual";
export type RescueStage = "mirrors" | "searching" | "finished";

export const RescueReason = {
  /** A dead page has nothing to lose, so the best match can open by itself. */
  opensBySelf(reason: RescueReason): boolean {
    return reason === "pageFailed" || reason === "pageMissing";
  },
  triesMirrors(reason: RescueReason): boolean {
    return RescueReason.opensBySelf(reason);
  },
};

export interface RescueOption {
  siteName: string;
  siteIcon: string | null;
  url: string;
  label: string;
  isStrong: boolean;
  score: number;
}

/** One search for a film that stopped working (Swift's RescueSession). */
export interface RescueState {
  id: string;
  reason: RescueReason;
  host: string;
  titleId: number | null;
  name: string;
  names: string[];
  year: number | null;
  ref: EpisodeRef;
  position: number | null;
  duration: number | null;
  stage: RescueStage;
  mirrorsTotal: number;
  sitesTotal: number;
  sitesDone: number;
  options: RescueOption[];
  countdown: number | null;
  isAbandoned: boolean;
  isStaying: boolean;
}

export const RescueState = {
  /** Where it would carry on from, if anywhere. */
  resumePoint(r: Pick<RescueState, "position">): number | null {
    return r.position != null && r.position >= 30 ? r.position : null;
  },
};

/** The page couldn't be shown (Swift's LoadFailure). */
export interface LoadFailure {
  host: string;
  message: string;
  url: string | null;
}

/** A player file the network saw (webRequest), kept for the frame that asked for it. */
export interface SniffedFile {
  url: string;
  kind: MediaSourceKind;
  /** Milliseconds since 1970. */
  at: number;
  frameId: number;
}

/** What media.js said a frame holds, kept so commands reach the frame with the video. */
export interface FrameRef {
  frameId: number;
  url: string;
}

export interface TabState {
  id: number;
  windowId: number;
  url: string | null;
  title: string;
  favIconUrl: string | null;
  /** Selected in its window. */
  active: boolean;
  /** Milliseconds since 1970: when it was last selected. */
  lastActiveAt: number;
  isLoading: boolean;
  failure: LoadFailure | null;
  /** The main frame's document (Chrome's documentId), to tell a new page from the old one's messages. */
  documentId: string | null;

  media: MediaState | null;
  parsed: ParsedTitle | null;
  pageMeta: PageMeta | null;
  linkedTitleId: number | null;
  blocked: ShieldStats;
  isTheaterOn: boolean;
  rescue: RescueState | null;
  sources: MediaSource[];
  sniffed: SniffedFile[];
  boostState: VoiceBoostState;
  /** The second line of subtitles: its label and address. */
  secondSubtitles: { id: string; label: string } | null;
  /** Discarded by the browser (the Mac's hibernated web view). */
  isHibernated: boolean;

  /** Opened from the sites grid, to notice when that site moves address. */
  originSiteId: number | null;
  /** A hidden tab Cineon drives (season downloads): no history, no tracking, no rescue, no buttons. */
  isHelper: boolean;
  /** A tab that reads a site's search results for rescue: nothing but links. */
  isProbe: boolean;
  /** A search-everywhere tab and the title it looks for. */
  searchTitleId: number | null;

  track: LiveTrack | null;
  playedSeconds: number;
  /** Milliseconds since 1970. */
  lastPlaybackReport: number | null;
  pendingResume: number | null;
  /** The frame holding the long video, where player commands go. */
  mediaFrame: FrameRef | null;
  expectedResumeDuration: number | null;
  /** The one address whose video should start by itself (URLKey). */
  autoplayKey: string | null;
  autopilot: AutopilotState;
  lastEpisodeExit: EpisodeExit | null;
  frameState: FrameState;
  sourcesFrame: FrameRef | null;
  playingSource: string | null;
  lastPill: string | null;
  captionsApplied: string | null;
  /** media.js can't read this video's pixels: ambient light and frames photograph the tab instead. */
  ambientFramesBlocked: boolean;
  /** The six ambient zones last sampled, `[r, g, b]` 0–255, left to right, top row first. */
  ambient: number[][] | null;
  lastHistoryKey: string | null;
  /** True while a navigation the person asked for is in flight (redirects included). */
  trustedNavigation: boolean;
  /** The server said this page doesn't exist, though it sent something to show. */
  missingPageUrl: string | null;
  /** The banner media.js shows now, and when it goes (ms), for the toast routing and debug. */
  banner: { id: string; until: number | null } | null;
  lastBannerForTests: string | null;
  /** A link the person opened in a new tab themselves (modifier or middle click), for the pop-up shield. */
  lastUserLink: { url: string; at: number } | null;
  /** When the person last clicked or pressed a key in this tab (ms), for the redirect shield. */
  lastGestureAt: number;
}

export const TabState = {
  make(id: number, fields: Partial<TabState> = {}): TabState {
    return {
      id,
      windowId: -1,
      url: null,
      title: "",
      favIconUrl: null,
      active: false,
      lastActiveAt: 0,
      isLoading: false,
      failure: null,
      documentId: null,
      media: null,
      parsed: null,
      pageMeta: null,
      linkedTitleId: null,
      blocked: ShieldStats.make(),
      isTheaterOn: false,
      rescue: null,
      sources: [],
      sniffed: [],
      boostState: "off",
      secondSubtitles: null,
      isHibernated: false,
      originSiteId: null,
      isHelper: false,
      isProbe: false,
      searchTitleId: null,
      track: null,
      playedSeconds: 0,
      lastPlaybackReport: null,
      pendingResume: null,
      mediaFrame: null,
      expectedResumeDuration: null,
      autoplayKey: null,
      autopilot: AutopilotState.make(),
      lastEpisodeExit: null,
      frameState: FrameState.make(),
      sourcesFrame: null,
      playingSource: null,
      lastPill: null,
      captionsApplied: null,
      ambientFramesBlocked: false,
      ambient: null,
      lastHistoryKey: null,
      trustedNavigation: false,
      missingPageUrl: null,
      banner: null,
      lastBannerForTests: null,
      lastUserLink: null,
      lastGestureAt: 0,
      ...fields,
    };
  },

  /** Swift's `displayTitle`. */
  displayTitle(tab: Pick<TabState, "title" | "url">, displayName: (host: string) => string): string {
    if (tab.title.length > 0) return tab.title;
    if (tab.url) {
      try {
        const host = new URL(tab.url).hostname;
        if (host) return displayName(host);
      } catch {
        // Not an address: fall through.
      }
    }
    return "New tab";
  },

  /** The file that is the film being shown, out of everything the player asked for. */
  bestSource(tab: Pick<TabState, "sources" | "playingSource">): MediaSource | null {
    return MediaSource.best(tab.sources, tab.playingSource);
  },

  /** The episode being tracked, else the parsed one; null for a film. */
  episodeRef(tab: Pick<TabState, "track" | "parsed">): EpisodeRef | null {
    const ref = tab.track?.ref ?? tab.parsed?.ref ?? null;
    return ref != null && EpisodeRef.isEpisode(ref) ? ref : null;
  },

  /** Everything that belongs to one page, forgotten when the page goes (BrowserTab.forgetSources and friends). */
  forgetSources(tab: TabState): void {
    tab.sources = [];
    tab.sniffed = [];
    tab.secondSubtitles = null;
    tab.boostState = "off";
    tab.sourcesFrame = null;
    tab.playingSource = null;
    tab.lastPill = null;
    tab.captionsApplied = null;
  },

  /**
   * Reads a stored copy back: fields added since it was written get their defaults, and anything
   * that was in flight when the worker stopped (a capture, a next-episode lookup) starts over.
   */
  revive(stored: unknown): TabState | null {
    if (stored == null || typeof stored !== "object") return null;
    const s = stored as Partial<TabState>;
    if (typeof s.id !== "number") return null;
    const tab = TabState.make(s.id, s);
    tab.autopilot = { ...AutopilotState.make(), ...(s.autopilot ?? {}), isResolving: false };
    tab.frameState = { ...FrameState.make(), ...(s.frameState ?? {}), isCapturing: false };
    tab.blocked = ShieldStats.make(s.blocked ?? {});
    return tab;
  },
};

/** What a page's kind hint and the parsed name become for the UI and Together. */
export interface ParsedCard {
  name: string;
  year: number | null;
  kind: TitleKind;
}
