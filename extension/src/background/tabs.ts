// Every tab Cineon knows about, kept across service worker restarts. The browser owns the tabs;
// this is what Cineon remembers about each one (TabState). The whole map is written to
// chrome.storage.session shortly after any change and read back when the worker wakes, then checked
// against the tabs that still exist.

import type { KeyValueStorage } from "../core/data";
import { Emitter } from "../core/data";
import type { Clock } from "./env";
import type { BrowserTabInfo } from "./platform";
import { TabState } from "./tabState";

export const TABS_STORAGE_KEY = "cineon.tabs";
const SAVE_DELAY_MS = 400;

interface StoredTabs {
  tabs: unknown[];
  focusedWindowId: number | null;
  lastPlayedTabId: number | null;
}

export class TabRegistry {
  readonly tabs = new Map<number, TabState>();
  /** Fires with a tab's id whenever something about it changed (for signals and saving). */
  readonly changed = new Emitter<number>();
  focusedWindowId: number | null = null;
  /** The tab that played last (AppModel.lastPlayedTab). */
  lastPlayedTabId: number | null = null;
  private saveTimer: (() => void) | null = null;
  private restored: Promise<void> | null = null;

  constructor(
    private readonly storage: KeyValueStorage | null,
    private readonly clock: Clock,
  ) {}

  /** Reads back what the last worker knew. Safe to call more than once. */
  restore(): Promise<void> {
    this.restored ??= (async () => {
      if (!this.storage) return;
      try {
        const stored = (await this.storage.get(TABS_STORAGE_KEY)) as StoredTabs | undefined;
        if (!stored || !Array.isArray(stored.tabs)) return;
        for (const raw of stored.tabs) {
          const tab = TabState.revive(raw);
          if (tab && !this.tabs.has(tab.id)) this.tabs.set(tab.id, tab);
        }
        this.focusedWindowId ??= stored.focusedWindowId ?? null;
        this.lastPlayedTabId ??= stored.lastPlayedTabId ?? null;
      } catch (error) {
        console.warn("Cineon: couldn't read the tabs back", error);
      }
    })();
    return this.restored;
  }

  get(id: number | null | undefined): TabState | null {
    return id == null ? null : (this.tabs.get(id) ?? null);
  }

  /** The tab's state, made on first sight. */
  ensure(id: number, info?: Partial<BrowserTabInfo>): TabState {
    let tab = this.tabs.get(id);
    if (!tab) {
      tab = TabState.make(id);
      this.tabs.set(id, tab);
    }
    if (info) this.apply(tab, info);
    return tab;
  }

  /** What chrome.tabs says, copied in (the address only when it's set: a loading tab has none yet). */
  apply(tab: TabState, info: Partial<BrowserTabInfo>): void {
    if (info.windowId != null) tab.windowId = info.windowId;
    if (info.title != null && info.title.length > 0) tab.title = info.title;
    if (info.favIconUrl !== undefined && info.favIconUrl !== null) tab.favIconUrl = info.favIconUrl;
    if (info.active != null) {
      if (info.active && !tab.active) tab.lastActiveAt = this.clock.now();
      tab.active = info.active;
    }
    if (info.status != null) tab.isLoading = info.status === "loading";
    if (info.discarded != null) tab.isHibernated = info.discarded;
    if (tab.url == null && info.url) tab.url = info.url;
  }

  remove(id: number): TabState | null {
    const tab = this.tabs.get(id) ?? null;
    this.tabs.delete(id);
    if (this.lastPlayedTabId === id) this.lastPlayedTabId = null;
    this.touch(id);
    return tab;
  }

  all(): TabState[] {
    return [...this.tabs.values()];
  }

  /** Tabs the person browses (not the hidden helper and probe tabs). */
  listed(): TabState[] {
    return this.all().filter((t) => !t.isHelper && !t.isProbe);
  }

  /** The tab in front: selected in the focused window, else any selected one. */
  selected(): TabState | null {
    const listed = this.listed().filter((t) => t.active);
    return listed.find((t) => t.windowId === this.focusedWindowId) ?? listed[0] ?? null;
  }

  /** BrowserModel.playingTab: the tab whose video plays, else one being tracked. */
  playingTab(): TabState | null {
    const listed = this.listed();
    return listed.find((t) => t.media?.isPlaying === true) ?? listed.find((t) => t.track != null) ?? null;
  }

  /** Something about this tab changed: tell listeners and save soon. */
  touch(id: number): void {
    this.changed.emit(id);
    this.scheduleSave();
  }

  scheduleSave(): void {
    if (!this.storage || this.saveTimer) return;
    this.saveTimer = this.clock.schedule(SAVE_DELAY_MS, () => {
      this.saveTimer = null;
      void this.saveNow();
    });
  }

  async saveNow(): Promise<void> {
    if (!this.storage) return;
    this.saveTimer?.();
    this.saveTimer = null;
    const stored: StoredTabs = {
      tabs: this.all(),
      focusedWindowId: this.focusedWindowId,
      lastPlayedTabId: this.lastPlayedTabId,
    };
    try {
      await this.storage.set(TABS_STORAGE_KEY, JSON.parse(JSON.stringify(stored)));
    } catch (error) {
      console.warn("Cineon: couldn't save the tabs", error);
    }
  }

  /** Drops tabs that closed while the worker slept. Returns the ones that are gone. */
  reconcile(open: readonly BrowserTabInfo[]): TabState[] {
    const ids = new Set(open.map((t) => t.id));
    const gone: TabState[] = [];
    for (const tab of this.all()) {
      if (!ids.has(tab.id)) {
        gone.push(tab);
        this.tabs.delete(tab.id);
      }
    }
    for (const info of open) {
      const tab = this.tabs.get(info.id);
      if (tab) this.apply(tab, info);
    }
    if (gone.length > 0) this.scheduleSave();
    return gone;
  }
}
