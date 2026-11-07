// What TogetherModel needs from the extension around it (C#'s ITogetherHost and IPartyPlayer in
// TogetherHost.cs). On the Mac it reaches these through ProfileSession (toasts, the pasteboard, the
// app's route, settings, the pet, metadata) and BrowserModel/BrowserTab (tabs and the player). The
// runtime implements both: the host from the background's profile session, the player from
// chrome.tabs plus messages to the content scripts that run media.js.

import type { TitleCard } from "./types";
import type { TogetherTitle } from "./library";
import { numberText } from "./text";

/** Where the extension is showing, as far as Together cares: a web page, the Together page, or anything else. */
export type TogetherRoute = "other" | "web" | "together";

/** The settings TogetherModel reads (fields of core/data's AppSettings). */
export interface TogetherSettings {
  /** Show this profile's pixel pet to friends. */
  readonly sharePet: boolean;
  /** How far into a film or episode counts as finished (0.92 by default). */
  readonly finishThreshold: number;
}

/** The extension side of TogetherModel, apart from the player. */
export interface TogetherHost<T extends TogetherTitle = TogetherTitle> {
  /** The profile's current settings. Read each time. */
  readonly settings: TogetherSettings;
  /** This profile's pixel pet code (Swift's `session.pet.code`, core/profile's `PixelPet.code`). */
  readonly petCode: string;
  /** The page the user is looking at (Swift's `app.route`). */
  readonly route: TogetherRoute;
  /** Shows a page (Swift's `app.go(_:)`): the party's tab, or the Together page. */
  go(route: "web" | "together"): void;
  /** A short message (Swift's `session.toasts.show`): a toast on the Cineon page, or a notification. */
  showToast(text: string): void;
  /** Puts text on the clipboard, replacing what's there. */
  copyText(text: string): void;
  /**
   * A friend's film was just added: fill it in from the IMDb id the card carries. Swift's
   * `metadata.apply(hit: MetadataHit(id: card.imdbId, name:, year:, kind: titleKind, posterURL:), to: titleId)`.
   */
  applyMetadata(titleId: number, card: TitleCard): void;
  /** A friend's film without an IMDb id was just added: look it up (Swift's `metadata.enrich`). */
  enrichMetadata(titleId: number): void;
  /** How many episodes a series has, for a challenge: episodes in seasons above 0, or 0 when unknown. */
  episodeCount(title: T): Promise<number>;
}

/** A browser tab id (chrome.tabs). */
export type PartyTabId = number;

/** A tab's main video as last reported by media.js (Swift's `tab.media`). */
export interface PartyMedia {
  readonly position: number;
  readonly duration: number;
  readonly isPlaying: boolean;
  readonly rate: number;
}

/** A tab as it is now. */
export interface PartyTab {
  readonly id: PartyTabId;
  /** Its page, or null before one loads. */
  readonly url: string | null;
  /** Its main video as last reported, or null when it has none. */
  readonly media: PartyMedia | null;
  /** The library title the tab is playing, when it's known. */
  readonly linkedTitleId?: number | null;
  /**
   * The title read from the page (TitleParser's name, year and kind hint), used when there's no linked
   * title: `TitleCard.make(parsed.name, parsed.year, parsed.kindHint)`.
   */
  readonly parsed?: TitleCard | null;
}

/** What a member's player is told to do (media.js's `__cineon.play()`, `pause()`, `seek(n)`, `rate(n)`). */
export type PlayerCommand =
  | { readonly kind: "play" }
  | { readonly kind: "pause" }
  | { readonly kind: "seek"; readonly seconds: number }
  | { readonly kind: "rate"; readonly rate: number };

/** The command as the apps write it after `__cineon.`: `play()`, `pause()`, `seek(601)`, `rate(1.5)`. */
export function playerCommandText(command: PlayerCommand): string {
  switch (command.kind) {
    case "play":
      return "play()";
    case "pause":
      return "pause()";
    case "seek":
      return `seek(${numberText(command.seconds)})`;
    case "rate":
      return `rate(${numberText(command.rate)})`;
  }
}

/**
 * The browser tabs and their players, as a watch party drives them. Tabs are named by id, and every
 * call is about a tab that may have closed since: do nothing then. Anything here may answer with a
 * promise.
 */
export interface PartyPlayer {
  /** The selected tab in the current window, or null. A party starts from it. */
  selectedTab(): PartyTab | null | Promise<PartyTab | null>;
  /** The tab with this id as it is now, or null once it's closed. */
  tab(id: PartyTabId): PartyTab | null | Promise<PartyTab | null>;
  /** Opens a new tab at `url`, selecting it when asked, and returns its id. */
  openTab(url: string, select: boolean): PartyTabId | Promise<PartyTabId>;
  /** Loads `url` in the tab (Swift's `tab.load`). */
  load(tab: PartyTabId, url: string): void;
  /**
   * The player's own clock: media.js's `__cineon.state()` from the frame that holds the video (Swift's
   * `tab.evaluateInPlayer("window.__cineon ? __cineon.state() : null")`). The object as it came, or its
   * JSON text; null when there's no player. Only `t`, `paused` and `rate` are read.
   */
  playerState(tab: PartyTabId): Promise<unknown>;
  /** Runs the command in the video's frame, without waiting (Swift's `mediaCommand`). */
  playerCommand(tab: PartyTabId, command: PlayerCommand): void;
  /** Shows media.js's page banner (Swift's `tab.showBanner(id:text:timeout:)`), gone after `timeout` seconds. */
  showBanner(tab: PartyTabId, id: string, text: string, timeout: number): void;
}
