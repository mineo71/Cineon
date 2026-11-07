// What every piece of one person's session sees: the Mac's `unowned let session: ProfileSession`.
// ProfileSession (session.ts) implements it; tests build it from fakes.

import type { AppSettings, Database, DownloadItem, LibraryStore, Title } from "../core/data";
import type { DownloadCenter } from "../core/downloads";
import type { MetadataService } from "../core/metadata";
import type { ShieldState } from "../core/shields";
import type { Clock } from "./env";
import type { TabState } from "./tabState";

export interface ToastAction {
  readonly title: string;
  readonly run: () => void;
}

/**
 * The Mac's ToastCenter. A toast about a tab shows over its player (media.js's banner, which unlike
 * anything outside the page can still be seen in fullscreen); others go to the Cineon page or the
 * side panel, or become a notification when neither is open.
 */
export interface Toasts {
  /** `pageOnly`: never a notification (the caller sends its own). */
  show(text: string, options?: { action?: ToastAction | null; tab?: TabState | null; pageOnly?: boolean }): void;
  /** The last toast shown, for the debug state. */
  readonly current: string | null;
}

/** SiteProbe.check: does this page answer, and where did it end up? */
export type ProbeResult = { kind: "alive"; url: string } | { kind: "missing" } | { kind: "dead" };

/**
 * The browser's notifications (chrome.notifications), for news that can't wait for a page: a page
 * that failed to load (no content script runs on the browser's error page), new episodes, toasts
 * when no Cineon page is open. `onClick` gets the button's index, or null for the notification itself.
 */
export interface Notifier {
  show(id: string, options: { title: string; message: string; buttons?: readonly string[]; onClick?: (button: number | null) => void }): void;
  clear(id: string): void;
}

export interface SiteProber {
  check(url: string, signal?: AbortSignal): Promise<ProbeResult>;
}

/** Forward references, so the pieces can be built in the Mac's order and still reach each other. */
export interface SessionContext {
  readonly clock: Clock;
  readonly db: Database;
  readonly library: LibraryStore;
  readonly settings: AppSettings;
  readonly shields: ShieldState;
  readonly metadata: MetadataService<Title>;
  readonly toasts: Toasts;
  readonly probe: SiteProber;
  readonly notifier: Notifier;
  readonly browser: import("./browser").Browser;
  readonly tracker: import("./tracker").WatchTracker;
  readonly autopilot: import("./autopilot").EpisodeAutopilot;
  readonly rescue: import("./rescue").RescueEngine;
  readonly frames: import("./frames").FrameCollector;
  /** Null until the download center has opened (it needs the browser's downloads). */
  readonly downloads: DownloadCenter | null;
  /** Opens a finished download (DownloadHost.playDownload). */
  playDownload(item: DownloadItem): Promise<void>;
}
