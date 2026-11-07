// What the extension's pages (the Cineon page, the side panel, the toolbar popup) ask of the
// background, and what the background tells them. See notes/ui.md for every message.
//
// Two channels:
// - Requests: `chrome.runtime.sendMessage({ kind: UI_MESSAGE, type, ...payload })`, answered with an
//   `Envelope` (`{ ok: true, value }` or `{ ok: false, error }`). `send()` turns "no background",
//   "no handler", a timeout or an error into `null`, so every page copes with a missing answer.
// - Signals: `BroadcastChannel("cineon")`, one-way news any context can post and every other one
//   hears (the poster doesn't hear its own). Pages and the service worker share the extension's
//   IndexedDB, but each `LibraryStore` keeps its own memory: whoever writes posts a `library`
//   signal, and everyone else calls `reload()`.
//
// Everything here is plain data (survives structured cloning and JSON): optionals are `null`,
// dates follow the type they come from (core/data: seconds since 1970; Together: milliseconds).

import type {
  DownloadItem,
  EpisodeRef,
  ShieldStats,
  SitePrefs,
  TitleKind,
  VoiceBoostState,
} from "../core/data";
import type { ChallengeState, ChallengeSummary, PartyState, ShareInfo, TitleCard } from "../core/together";

/** Marks a request as one of these, so the background can tell them from content scripts' messages. */
export const UI_MESSAGE = "cineon/ui";
/** The BroadcastChannel every context joins. */
export const CHANNEL_NAME = "cineon";

// MARK: Snapshots

/** What media.js last said about the video in a tab. */
export interface MediaSnapshot {
  /** Seconds. */
  readonly position: number;
  /** Seconds; 0 until known. */
  readonly duration: number;
  readonly isPlaying: boolean;
  readonly rate: number;
}

/** What the title parser made of a page (core/parsing's ParsedTitle, the parts pages show). */
export interface ParsedSnapshot {
  readonly name: string;
  readonly altName: string | null;
  readonly year: number | null;
  readonly ref: EpisodeRef;
  readonly kindHint: TitleKind;
  readonly posterUrl: string | null;
}

/** One browser tab as Cineon sees it: the Mac's BrowserTab, the parts pages show. */
export interface TabSnapshot {
  readonly tabId: number;
  readonly windowId: number;
  readonly url: string | null;
  /** The URL's host, as written (with `www.`). */
  readonly host: string | null;
  /** The page's title. */
  readonly title: string;
  readonly favIconUrl: string | null;
  readonly parsed: ParsedSnapshot | null;
  /** The library title the tracker links this page to (`tab.linkedTitleID`). */
  readonly linkedTitleId: number | null;
  /** The episode being tracked, else the parsed one; null for a film. */
  readonly ref: EpisodeRef | null;
  /** Null until media.js reports a video. */
  readonly media: MediaSnapshot | null;
  /** A video file or stream was seen (`tab.bestSource != nil`): Download can work. */
  readonly canDownload: boolean;
  /** The next episode's page is known: Next episode can work. */
  readonly hasNextEpisode: boolean;
  /** Blocked on this page since it loaded (`tab.blocked`). */
  readonly blocked: ShieldStats;
  /** This host's shield and tracking preferences. */
  readonly sitePrefs: SitePrefs;
  readonly voiceBoost: VoiceBoostState;
}

/** Commands for the player in a tab (media.js's `__cineon.*`). */
export type PlayerCommand =
  | { readonly kind: "play" }
  | { readonly kind: "pause" }
  | { readonly kind: "toggle" }
  /** Relative jump, such as -10 or +10 seconds. */
  | { readonly kind: "skip"; readonly seconds: number }
  /** Absolute position in seconds. */
  | { readonly kind: "seek"; readonly seconds: number }
  | { readonly kind: "rate"; readonly rate: number }
  /** AppModel.playNextEpisode: the next episode's page, in the same tab. */
  | { readonly kind: "nextEpisode" }
  | { readonly kind: "pictureInPicture" }
  /** FrameCollector.saveMoment. */
  | { readonly kind: "saveMoment" }
  /** RescueController.findElsewhere. */
  | { readonly kind: "findElsewhere" };

/** A season being fetched (SeasonGrabber.Job). */
export interface SeasonJobSnapshot {
  /** The series' name. */
  readonly name: string;
  /** "Season 2" or "Severance, season 2": what the card calls the job. */
  readonly label: string;
  readonly posterUrl: string | null;
  readonly episodes: readonly EpisodeRef[];
  /** Episodes queued or given up on so far. */
  readonly handled: number;
  readonly queued: readonly EpisodeRef[];
  readonly missed: readonly EpisodeRef[];
  readonly remaining: readonly EpisodeRef[];
  /** The episode whose page is open to find its file. */
  readonly current: EpisodeRef | null;
  readonly isFinished: boolean;
  /** Stopped when the browser closed; Carry on resumes it. */
  readonly isPaused: boolean;
}

/** Asking before a whole series (SeasonGrabber.Proposal). */
export interface SeriesProposalSnapshot {
  readonly name: string;
  readonly posterUrl: string | null;
  /** Episodes not downloaded yet. */
  readonly episodes: number;
  readonly seasonCounts: readonly { readonly season: number; readonly count: number }[];
  readonly totalBytes: number;
  /** False when the size is a guess (a gigabyte an episode). */
  readonly isMeasured: boolean;
  /** Free space (navigator.storage / chrome.system), when known. */
  readonly freeBytes: number | null;
  readonly fits: boolean;
}

/** The download center (DownloadCenter + SeasonGrabber). */
export interface DownloadsSnapshot {
  /** Newest first, with live byte counts. */
  readonly items: readonly DownloadItem[];
  readonly job: SeasonJobSnapshot | null;
  readonly proposal: SeriesProposalSnapshot | null;
  /** A season or series job is running: Download the whole season/series are disabled. */
  readonly isBusy: boolean;
}

/** Ratings in the cloud (CloudLibrary). */
export interface CloudSnapshot {
  /** Milliseconds since 1970. */
  readonly lastSync: number | null;
  readonly isSyncing: boolean;
  readonly lastError: string | null;
  readonly cloudCount: number;
}

/** Together (core/together's TogetherModel state) as pages show it. */
export interface TogetherSnapshot {
  readonly isAvailable: boolean;
  readonly isWorking: boolean;
  readonly personId: string | null;
  readonly myName: string;
  readonly party: PartyState | null;
  readonly isHost: boolean;
  /** The tab the party plays in, when it's in this browser. */
  readonly partyTabId: number | null;
  readonly challenges: readonly ChallengeSummary[];
  /** By challenge code. */
  readonly details: Readonly<Record<string, ChallengeState>>;
  readonly openedShares: readonly ShareInfo[];
  readonly lastShareCode: string | null;
  readonly recoveryCode: string;
  readonly cloud: CloudSnapshot;
}

/** One filter list (FilterEngine.catalog). */
export interface FilterListInfo {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
}

/** Shields' lists (FilterEngine): which exist and how many rules each compiled to. */
export interface ShieldsSnapshot {
  readonly catalog: readonly FilterListInfo[];
  /** By list id, once known. */
  readonly ruleCounts: Readonly<Record<string, number>>;
  /** Milliseconds since 1970, or null for the lists built into the extension. */
  readonly lastUpdated: number | null;
  /** "Preparing EasyList…" or "Couldn't compile …", else null. */
  readonly status: string | null;
}

/** What adding the page in a tab to the backlog did (AppModel.addCurrentPageToBacklog). */
export type AddFromTabResult =
  /** Added, or already there: show `message` as a toast. */
  | { readonly kind: "done"; readonly titleId: number; readonly message: string }
  /** Nothing recognised: open the Add sheet with this text. */
  | { readonly kind: "needsName"; readonly query: string };

// MARK: Requests

/** Every request a page can make, with its payload and its answer. */
export interface UiRequests {
  /** Is the background there? */
  ping: { payload: {}; result: { version: string; target: "chrome" | "firefox" } };

  // Tabs and players
  /** One tab, for the popup (its own tab) and the relink sheet. */
  "tab.state": { payload: { tabId: number }; result: { tab: TabSnapshot | null } };
  /** What's playing: the tab whose video plays, else the one that played last; null when nothing has a video. */
  "player.active": { payload: {}; result: { tab: TabSnapshot | null } };
  "player.command": { payload: { tabId: number; command: PlayerCommand }; result: { ok: boolean } };
  /** Opens an address in a new tab and, when `resumeAt` is set, jumps there once the video loads (AppModel.resume(url:at:)). */
  "tabs.open": { payload: { url: string; resumeAt: number | null; active: boolean }; result: { tabId: number } };
  /** Brings a tab and its window to the front. */
  "tabs.focus": { payload: { tabId: number }; result: { ok: boolean } };
  /** BrowserModel.searchEverywhere: the query on every site that can search, grouped. */
  "search.everywhere": { payload: { query: string; titleId: number | null }; result: { tabs: number } };

  // Tracking
  "library.addFromTab": { payload: { tabId: number }; result: AddFromTabResult };
  /** WatchTracker.relink: this tab is that title (and episode). */
  "tracker.relink": { payload: { tabId: number; titleId: number; ref: EpisodeRef }; result: { ok: boolean } };
  /** WatchTracker.ignore: this page isn't a film. */
  "tracker.ignore": { payload: { tabId: number }; result: { ok: boolean } };
  /** WatchTracker.stopTrackingSite. */
  "tracker.stopSite": { payload: { tabId: number }; result: { ok: boolean } };

  // Shields
  "shields.state": { payload: {}; result: ShieldsSnapshot };
  /** Saves a host's preferences (DB `site_prefs`), updates the dynamic rules, reloads `tabId` when shields went on or off. */
  "shields.setSite": { payload: { host: string; prefs: SitePrefs; tabId: number | null }; result: { ok: boolean } };

  // Downloads
  "downloads.state": { payload: {}; result: DownloadsSnapshot };
  /** DownloadCenter.download(from: tab). */
  "downloads.start": { payload: { tabId: number }; result: { ok: boolean; message: string | null } };
  /** SeasonGrabber.start(from:fromCurrent:). */
  "downloads.season": { payload: { tabId: number; fromCurrent: boolean }; result: { ok: boolean } };
  /** SeasonGrabber.startSeries(from:): answers with a proposal, also posted as a `downloads` signal. */
  "downloads.series": { payload: { tabId: number }; result: { ok: boolean } };
  "downloads.cancel": { payload: { id: number }; result: { ok: boolean } };
  "downloads.retry": { payload: { id: number }; result: { ok: boolean } };
  /** Removes the row; a finished file goes too (chrome.downloads.removeFile). */
  "downloads.remove": { payload: { id: number }; result: { ok: boolean } };
  /** chrome.downloads.show: the file in Finder / File Explorer. */
  "downloads.show": { payload: { id: number }; result: { ok: boolean } };
  /** Plays a finished download (chrome.downloads.open, or the extension's player). */
  "downloads.play": { payload: { id: number }; result: { ok: boolean; message: string | null } };
  "seasons.confirm": { payload: {}; result: { ok: boolean } };
  "seasons.decline": { payload: {}; result: { ok: boolean } };
  "seasons.resume": { payload: {}; result: { ok: boolean } };
  "seasons.cancel": { payload: {}; result: { ok: boolean } };
  "seasons.dismiss": { payload: {}; result: { ok: boolean } };

  // Together (the model lives in the background so a party outlives the page)
  "together.state": { payload: {}; result: TogetherSnapshot };
  "together.enter": { payload: { code: string }; result: { ok: boolean } };
  "together.startParty": { payload: { tabId: number | null }; result: { ok: boolean } };
  "together.leaveParty": { payload: {}; result: { ok: boolean } };
  /** Focuses the party's tab (TogetherHost.go("web")). */
  "together.goToParty": { payload: {}; result: { ok: boolean } };
  "together.say": { payload: { text: string }; result: { ok: boolean } };
  "together.react": { payload: { emoji: string }; result: { ok: boolean } };
  "together.shareWatched": { payload: {}; result: { ok: boolean } };
  "together.share": { payload: { titleId: number }; result: { ok: boolean } };
  "together.createChallenge": { payload: { titleId: number }; result: { ok: boolean } };
  "together.leaveChallenge": { payload: { code: string }; result: { ok: boolean } };
  "together.forgetShare": { payload: { code: string }; result: { ok: boolean } };
  "together.addToBacklog": { payload: { card: TitleCard }; result: { ok: boolean } };
  "together.refreshChallenges": { payload: {}; result: { ok: boolean } };
  /** TogetherModel.adopt, then CloudLibrary.sync when it worked. */
  "together.adopt": { payload: { recoveryCode: string }; result: { ok: boolean } };

  // Profiles
  /** The page switched person (ProfileStore.lastUsedId is already the new one): close the old session, open this one. */
  "session.switchProfile": { payload: { profileId: string }; result: { ok: boolean } };
}

export type UiRequestType = keyof UiRequests;
export type UiPayload<K extends UiRequestType> = UiRequests[K]["payload"];
export type UiResult<K extends UiRequestType> = UiRequests[K]["result"];
/** What goes over `chrome.runtime.sendMessage`. */
export type UiRequest<K extends UiRequestType = UiRequestType> = { kind: typeof UI_MESSAGE; type: K } & UiPayload<K>;
/** What the background answers. */
export type Envelope<T> = { ok: true; value: T } | { ok: false; error: string };

export function isUiRequest(value: unknown): value is UiRequest {
  return typeof value === "object" && value != null && (value as { kind?: unknown }).kind === UI_MESSAGE;
}

/** The runtime pages talk through; swappable for tests. */
export interface MessageTransport {
  sendMessage(message: unknown): Promise<unknown>;
}

function defaultTransport(): MessageTransport | null {
  const runtime = (globalThis as { chrome?: typeof chrome }).chrome?.runtime;
  if (!runtime?.sendMessage || !runtime.id) return null;
  return { sendMessage: (message) => runtime.sendMessage(message) };
}

let transport: MessageTransport | null | undefined;

/** For tests: replaces how requests are sent (`null` means no background at all). */
export function setTransport(next: MessageTransport | null | undefined): void {
  transport = next;
}

/**
 * Asks the background. `null` means no answer (no background yet, no handler, a timeout or an
 * error), which every caller handles: the UI falls back or says so.
 */
export async function send<K extends UiRequestType>(
  type: K,
  payload: UiPayload<K>,
  options: { timeoutMs?: number } = {},
): Promise<UiResult<K> | null> {
  const t = transport === undefined ? defaultTransport() : transport;
  if (!t) return null;
  const message = { ...payload, kind: UI_MESSAGE, type } as UiRequest<K>;
  const timeoutMs = options.timeoutMs ?? 4000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      t.sendMessage(message),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
    if (answer == null || typeof answer !== "object" || !("ok" in answer)) return null;
    const envelope = answer as Envelope<UiResult<K>>;
    if (!envelope.ok) {
      console.warn(`Cineon background: ${type} failed: ${envelope.error}`);
      return null;
    }
    return envelope.value;
  } catch {
    // "Could not establish connection. Receiving end does not exist." and friends.
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The background's side: one function per request type. Missing ones answer nothing. */
export type UiHandlers = {
  [K in UiRequestType]?: (payload: UiPayload<K>, sender: chrome.runtime.MessageSender) => UiResult<K> | Promise<UiResult<K>>;
};

/**
 * For the background: answers UI requests with `handlers`. Returns the listener so it can be
 * removed. Other messages (content scripts') are left for other listeners.
 */
export function listenForUiRequests(
  handlers: UiHandlers,
  runtime: Pick<typeof chrome.runtime, "onMessage"> = chrome.runtime,
): (message: unknown, sender: chrome.runtime.MessageSender, reply: (answer: unknown) => void) => boolean | undefined {
  const listener = (message: unknown, sender: chrome.runtime.MessageSender, reply: (answer: unknown) => void) => {
    if (!isUiRequest(message)) return undefined;
    const handler = handlers[message.type] as
      | ((payload: unknown, sender: chrome.runtime.MessageSender) => unknown)
      | undefined;
    if (!handler) return undefined;
    Promise.resolve()
      .then(() => handler(message, sender))
      .then(
        (value) => reply({ ok: true, value } satisfies Envelope<unknown>),
        (error: unknown) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
    return true;
  };
  runtime.onMessage.addListener(listener);
  return listener;
}

// MARK: Signals

/** Library store keys, as core/data's LibraryStoreKey. */
export type LibraryKeys = readonly string[];

/** News over the BroadcastChannel. `origin` is the poster's `contextId`, so it can ignore echoes. */
export type Signal =
  /** A context wrote to this profile's library (after its own writes, never after a reload). */
  | { readonly type: "library"; readonly profileId: string; readonly keys: LibraryKeys; readonly origin: string }
  /** A context saved this profile's settings. */
  | { readonly type: "settings"; readonly profileId: string; readonly origin: string }
  /** The list of people changed (added, renamed, deleted, ask-on-launch). */
  | { readonly type: "profiles"; readonly origin: string }
  /** The person watching changed: every context opens this profile. */
  | { readonly type: "profile"; readonly profileId: string; readonly origin: string }
  /** A host's shield preferences changed (written to the DB already). */
  | { readonly type: "sitePrefs"; readonly profileId: string; readonly host: string; readonly origin: string }
  /** Background → pages: the download center changed (throttled to a few a second). */
  | { readonly type: "downloads"; readonly state: DownloadsSnapshot; readonly origin: string }
  /** Background → pages: what's playing changed (at most once a second while playing). */
  | { readonly type: "player"; readonly player: TabSnapshot | null; readonly origin: string }
  /** Background → pages: Together changed. */
  | { readonly type: "together"; readonly state: TogetherSnapshot; readonly origin: string }
  /** Background → pages: a toast for whichever Cineon page is in front (TogetherHost.showToast and friends). */
  | { readonly type: "toast"; readonly text: string; readonly origin: string }
  /** Background → the Cineon page: go to a section ("together", "downloads", …). */
  | { readonly type: "navigate"; readonly route: string; readonly origin: string };

type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type SignalInput = Without<Signal, "origin">;

/** This context's id, sent with every signal it posts. */
export const contextId: string =
  typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `ctx-${Math.random().toString(36).slice(2)}`;

/** Joins the channel. `post` stamps the origin; `on` hears everyone else's signals. */
export class SignalChannel {
  private readonly channel: BroadcastChannel | null;
  private readonly listeners = new Set<(signal: Signal) => void>();

  constructor(name = CHANNEL_NAME) {
    this.channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(name) : null;
    this.channel?.addEventListener("message", (event: MessageEvent) => {
      const signal = event.data as Signal | null;
      if (!signal || typeof signal !== "object" || typeof signal.type !== "string") return;
      if (signal.origin === contextId) return;
      for (const listener of [...this.listeners]) {
        try {
          listener(signal);
        } catch (error) {
          console.error(error);
        }
      }
    });
  }

  post(signal: SignalInput): void {
    try {
      this.channel?.postMessage({ ...signal, origin: contextId });
    } catch (error) {
      console.warn("Cineon: couldn't post a signal", error);
    }
  }

  on(listener: (signal: Signal) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.listeners.clear();
    this.channel?.close();
  }
}

/** Keys a reload notifies with: all of them, so a reload is told apart from a write. */
export const RELOAD_KEYS = [
  "titles",
  "progress",
  "sessions",
  "events",
  "sites",
  "framesBySession",
  "momentsByTitle",
  "bestFrameByTitle",
  "revision",
] as const;
