// Fakes for the rescue and frame collector tests: a manual clock, the browser's tabs and page calls,
// a browser that records what it was asked to do, and a session context over a real (fake-indexeddb)
// database.

import { AppSettings, LibraryStore, MemoryFrameFiles } from "../../src/core/data";
import { MetadataService } from "../../src/core/metadata";
import { ShieldState } from "../../src/core/shields";
import type { BannerOptions } from "../../src/background/browser";
import type { Notifier, ProbeResult, SessionContext, SiteProber, ToastAction, Toasts } from "../../src/background/context";
import type { Clock } from "../../src/background/env";
import type { BrowserTabInfo, PageCalls, PageTarget, Platform, TabsApi } from "../../src/background/platform";
import { TabState } from "../../src/background/tabState";
import { TabRegistry } from "../../src/background/tabs";
import { freshDatabase } from "../data/helpers";

/** Lets pending promises and IndexedDB requests run. */
export async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

interface Timer {
  id: number;
  at: number;
  every: number | null;
  fn: () => void;
}

export class ManualClock implements Clock {
  private timers: Timer[] = [];
  private nextId = 1;

  constructor(public time = 1_800_000_000_000) {}

  now(): number {
    return this.time;
  }

  schedule(ms: number, fn: () => void): () => void {
    const timer = { id: this.nextId++, at: this.time + ms, every: null, fn };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t.id !== timer.id);
    };
  }

  every(ms: number, fn: () => void): () => void {
    const timer = { id: this.nextId++, at: this.time + ms, every: ms, fn };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t.id !== timer.id);
    };
  }

  /** Moves time on, running timers in order and letting their work settle in between. */
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      await settle();
      const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.time = Math.max(this.time, due.at);
      if (due.every != null) due.at += due.every;
      else this.timers = this.timers.filter((t) => t.id !== due.id);
      due.fn();
    }
    this.time = end;
    await settle();
  }

  get pending(): number {
    return this.timers.length;
  }
}

export class FakeTabs implements TabsApi {
  readonly infos = new Map<number, BrowserTabInfo>();
  readonly created: { url: string; windowId?: number; helper: boolean }[] = [];
  readonly removed: number[] = [];
  readonly updates: { tabId: number; change: Record<string, unknown> }[] = [];
  /** What captureVisibleTab returns. */
  shot: string | null = null;
  shots = 0;
  private nextId = 900;
  private nextWindow = 50;

  info(id: number, fields: Partial<BrowserTabInfo> = {}): BrowserTabInfo {
    const info: BrowserTabInfo = {
      id,
      windowId: 1,
      url: null,
      title: "",
      favIconUrl: null,
      active: false,
      status: "complete",
      discarded: false,
      audible: false,
      ...fields,
    };
    this.infos.set(id, info);
    return info;
  }

  async get(tabId: number) {
    return this.infos.get(tabId) ?? null;
  }
  async query() {
    return [...this.infos.values()];
  }
  async create(options: { url: string; active: boolean; windowId?: number }) {
    if (options.windowId != null && ![...this.infos.values()].some((i) => i.windowId === options.windowId)) return null;
    this.created.push({ url: options.url, windowId: options.windowId, helper: false });
    return this.info(this.nextId++, { url: options.url, windowId: options.windowId ?? 1, active: options.active });
  }
  async update(tabId: number, change: Record<string, unknown>) {
    this.updates.push({ tabId, change });
  }
  async reload() {}
  async remove(tabId: number) {
    this.removed.push(tabId);
    this.infos.delete(tabId);
  }
  async goBack() {}
  async discard() {}
  async focusWindow() {}
  async createHelperWindow(url: string) {
    this.created.push({ url, helper: true });
    return this.info(this.nextId++, { url, windowId: this.nextWindow++ });
  }
  async group() {}
  async captureVisibleTab() {
    this.shots += 1;
    return this.shot;
  }
}

export type PageHandler = (tabId: number, frameId: number, target: PageTarget, method: string, args: readonly unknown[]) => unknown;

export class FakePage implements PageCalls {
  readonly calls: { tabId: number; frameId: number; target: PageTarget; method: string; args: readonly unknown[] }[] = [];
  handler: PageHandler = () => null;

  async call(tabId: number, frameId: number, target: PageTarget, method: string, args: readonly unknown[]) {
    this.calls.push({ tabId, frameId, target, method, args });
    return (await this.handler(tabId, frameId, target, method, args)) ?? null;
  }
  async insertCss() {}
}

export class FakeBrowser {
  readonly banners: { tabId: number; options: BannerOptions }[] = [];
  readonly cleared: { tabId: number; id: string }[] = [];
  readonly commands: { tabId: number; method: string; args: unknown[] }[] = [];
  readonly loads: { tabId: number; url: string; resumingAt: number | null | undefined; keepWatching: boolean }[] = [];
  readonly ambient: { tabId: number; on: boolean }[] = [];
  readonly selects: number[] = [];
  changes = 0;
  selectedId: number | null = null;
  player: (tab: TabState, method: string, args: unknown[]) => unknown = () => null;
  page: (tab: TabState, method: string, args: unknown[]) => unknown = () => null;

  constructor(readonly registry: TabRegistry) {}

  get selected(): TabState | null {
    return this.registry.get(this.selectedId);
  }
  changed(): void {
    this.changes += 1;
  }
  showBanner(tab: TabState, options: BannerOptions): void {
    this.banners.push({ tabId: tab.id, options });
    tab.banner = { id: options.id, until: null };
  }
  clearBanner(tab: TabState, id: string): void {
    this.cleared.push({ tabId: tab.id, id });
    if (tab.banner?.id === id) tab.banner = null;
  }
  mediaCommand(tab: TabState, method: string, ...args: unknown[]): void {
    this.commands.push({ tabId: tab.id, method, args });
  }
  async evaluateInPlayer(tab: TabState, method: string, ...args: unknown[]): Promise<unknown> {
    return this.player(tab, method, args);
  }
  async evaluateInPage(tab: TabState, method: string, ...args: unknown[]): Promise<unknown> {
    return this.page(tab, method, args);
  }
  async load(tab: TabState, url: string, resumingAt?: number | null): Promise<void> {
    this.loads.push({ tabId: tab.id, url, resumingAt, keepWatching: false });
    tab.url = url;
  }
  async loadToKeepWatching(tab: TabState, url: string, resumingAt: number | null = null): Promise<void> {
    this.loads.push({ tabId: tab.id, url, resumingAt, keepWatching: true });
    tab.url = url;
  }
  setAmbient(tab: TabState, on: boolean): void {
    this.ambient.push({ tabId: tab.id, on });
  }
  async select(tab: TabState): Promise<void> {
    this.selects.push(tab.id);
  }
  lastBanner(tabId: number): BannerOptions | null {
    return [...this.banners].reverse().find((b) => b.tabId === tabId)?.options ?? null;
  }
}

export class FakeToasts implements Toasts {
  readonly shown: { text: string; action: ToastAction | null; tabId: number | null }[] = [];
  get current(): string | null {
    return this.shown.at(-1)?.text ?? null;
  }
  show(text: string, options: { action?: ToastAction | null; tab?: TabState | null } = {}): void {
    this.shown.push({ text, action: options.action ?? null, tabId: options.tab?.id ?? null });
  }
}

export class FakeNotifier implements Notifier {
  readonly shown = new Map<string, { title: string; message: string; buttons?: readonly string[]; onClick?: (button: number | null) => void }>();
  readonly cleared: string[] = [];
  show(id: string, options: { title: string; message: string; buttons?: readonly string[]; onClick?: (button: number | null) => void }): void {
    this.shown.set(id, options);
  }
  clear(id: string): void {
    this.cleared.push(id);
    this.shown.delete(id);
  }
}

export class FakeProbe implements SiteProber {
  readonly checked: string[] = [];
  answers = new Map<string, ProbeResult>();
  async check(url: string): Promise<ProbeResult> {
    this.checked.push(url);
    return this.answers.get(url) ?? { kind: "dead" };
  }
}

export interface Rig {
  ctx: SessionContext;
  clock: ManualClock;
  tabs: FakeTabs;
  page: FakePage;
  platform: Platform;
  browser: FakeBrowser;
  toasts: FakeToasts;
  notifier: FakeNotifier;
  probe: FakeProbe;
  library: LibraryStore;
  settings: { value: AppSettings };
  registry: TabRegistry;
}

/** A session context over a fresh database, with everything else faked. `rescue` and `frames` are set by the test. */
export async function makeRig(settings: Partial<AppSettings> = {}): Promise<Rig> {
  const clock = new ManualClock();
  const db = await freshDatabase();
  const library = await LibraryStore.open(db, new MemoryFrameFiles());
  const shields = await ShieldState.open({
    loadSitePrefs: () => [],
    saveSitePrefs: () => undefined,
    loadTotalStats: () => ({ ads: 0, popups: 0, redirects: 0, overlays: 0 }),
    addStats: () => undefined,
  });
  const registry = new TabRegistry(null, clock);
  const browser = new FakeBrowser(registry);
  const tabs = new FakeTabs();
  const page = new FakePage();
  const toasts = new FakeToasts();
  const notifier = new FakeNotifier();
  const probe = new FakeProbe();
  const holder = { value: AppSettings.make(settings) };
  const ctx = {
    clock,
    db,
    library,
    get settings() {
      return holder.value;
    },
    shields,
    metadata: new MetadataService({ library: { title: () => undefined, titles: () => [], update: () => undefined, merge: () => undefined, latestProgressUrl: () => null }, enabled: () => false }),
    toasts,
    probe,
    notifier,
    browser,
    tracker: null,
    autopilot: null,
    rescue: null,
    frames: null,
    downloads: null,
    playDownload: async () => undefined,
  } as unknown as SessionContext;
  return { ctx, clock, tabs, page, platform: { tabs, page }, browser, toasts, notifier, probe, library, settings: holder, registry };
}

/** A tab in the registry, selected and in front unless told otherwise. */
export function addTab(rig: Rig, id: number, fields: Partial<TabState> = {}): TabState {
  const tab = rig.registry.ensure(id);
  Object.assign(tab, { windowId: 1, active: true, ...fields });
  rig.tabs.info(id, { url: tab.url, windowId: tab.windowId, active: tab.active });
  return tab;
}
