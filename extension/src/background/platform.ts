// The browser as the background's logic uses it: tabs, frames, the page scripts. Everything goes
// through these two interfaces, so the tracker, autopilot and rescue run on Node in tests against
// fakes, and `chromePlatform()` (chromeApi.ts) is the only place that touches chrome.tabs and
// chrome.scripting for them.

/** What chrome.tabs says about a tab, the parts Cineon reads. */
export interface BrowserTabInfo {
  id: number;
  windowId: number;
  url: string | null;
  title: string;
  favIconUrl: string | null;
  active: boolean;
  status: "loading" | "complete" | "unloaded" | null;
  discarded: boolean;
  audible: boolean;
}

export interface TabsApi {
  get(tabId: number): Promise<BrowserTabInfo | null>;
  query(): Promise<BrowserTabInfo[]>;
  /** A new tab; null when the browser refused. */
  create(options: { url: string; active: boolean; windowId?: number; openerTabId?: number; index?: number }): Promise<BrowserTabInfo | null>;
  update(tabId: number, change: { url?: string; active?: boolean; muted?: boolean; autoDiscardable?: boolean }): Promise<void>;
  reload(tabId: number): Promise<void>;
  remove(tabId: number): Promise<void>;
  goBack(tabId: number): Promise<void>;
  discard(tabId: number): Promise<void>;
  /** Brings the window to the front. */
  focusWindow(windowId: number): Promise<void>;
  /** A small unfocused window for a helper tab nobody looks at; its one tab's id. */
  createHelperWindow(url: string): Promise<BrowserTabInfo | null>;
  /** Groups tabs under a title (Chrome's tab groups); does nothing where there are none. */
  group(tabIds: number[], title: string): Promise<void>;
  /** The visible part of the window's selected tab, as a JPEG data URL; null when not allowed. */
  captureVisibleTab(windowId: number, quality: number): Promise<string | null>;
}

/**
 * Calls into the extension's own script world in a tab's frames (media.js's `window.__cineon`,
 * meta.js's `__cineonMeta`, and the content script's `__cineonContent`). MV3 can't evaluate script
 * strings, so a method is named and its arguments passed as data. Null when the frame is gone, the
 * object isn't there, or the call failed.
 */
export interface PageCalls {
  call(tabId: number, frameId: number, target: PageTarget, method: string, args: readonly unknown[]): Promise<unknown>;
  /** A user stylesheet in some frames (element hiding). */
  insertCss(tabId: number, frameIds: readonly number[], css: string): Promise<void>;
}

/** Which object in the frame: media.js's, meta.js's, or the content script's helpers. */
export type PageTarget = "__cineon" | "__cineonMeta" | "__cineonContent";

export interface Platform {
  readonly tabs: TabsApi;
  readonly page: PageCalls;
}
