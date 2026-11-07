// A real ProfileSession (real Browser, tracker, autopilot, rescue, library over fake-indexeddb) with
// every browser seam faked: tabs, page calls, the pages' channel, notifications, the clock.

import { AppSettings, MemoryStorage } from "../../src/core/data";
import type { SignalInput } from "../../src/shared/messages";
import { KeepAlive } from "../../src/background/keepAlive";
import { Runtime, type RuntimeDeps } from "../../src/background/runtime";
import type { PageHub } from "../../src/background/session";
import type { TabState } from "../../src/background/tabState";
import { FakeNotifier, FakePage, FakeProbe, FakeTabs, ManualClock, settle } from "./rescueFakes";

export { FakeNotifier, FakePage, FakeProbe, FakeTabs, ManualClock, settle };

export class FakePages implements PageHub {
  readonly signals: SignalInput[] = [];
  readonly opened: (string | null)[] = [];
  open = false;
  post(signal: SignalInput): void {
    this.signals.push(signal);
  }
  async hasOpenPage(): Promise<boolean> {
    return this.open;
  }
  async openCineon(route: string | null): Promise<void> {
    this.opened.push(route);
  }
  of<T extends SignalInput["type"]>(type: T): Extract<SignalInput, { type: T }>[] {
    return this.signals.filter((s) => s.type === type) as Extract<SignalInput, { type: T }>[];
  }
}

export interface Harness {
  runtime: Runtime;
  clock: ManualClock;
  tabs: FakeTabs;
  page: FakePage;
  pages: FakePages;
  notifier: FakeNotifier;
  probe: FakeProbe;
  local: MemoryStorage;
  sessionStore: MemoryStorage;
  sent: { tabId: number; message: unknown; frameId?: number }[];
}

/** A runtime whose session opens on first use, with `settings` saved into the new profile first. */
export async function makeHarness(settings: Partial<AppSettings> = {}): Promise<Harness> {
  const clock = new ManualClock();
  const tabs = new FakeTabs();
  const page = new FakePage();
  const pages = new FakePages();
  const notifier = new FakeNotifier();
  const probe = new FakeProbe();
  const local = new MemoryStorage();
  const sessionStore = new MemoryStorage();
  const sent: Harness["sent"] = [];
  const deps: RuntimeDeps = {
    target: "chrome",
    clock,
    platform: { tabs, page },
    pages,
    notifier,
    local,
    session: sessionStore,
    dnr: null,
    cosmetic: async () => null,
    counterMode: async () => "off",
    downloads: null,
    togetherClient: async () => null,
    probe,
    power: null,
    copyText: () => undefined,
    channel: null,
    keepAlive: new KeepAlive(clock, () => undefined),
    sendToTab: (tabId, message, frameId) => sent.push({ tabId, message, frameId }),
    metadata: false,
    systemNotifications: false,
  };
  const runtime = new Runtime(deps);
  const session = await runtime.ready();
  await session.updateSettings(AppSettings.make({ ...AppSettings.defaults(), learnSkips: true, ...settings }));
  pages.signals.length = 0;
  return { runtime, clock, tabs, page, pages, notifier, probe, local, sessionStore, sent };
}

/** A web tab the runtime knows, as if the browser had told it. */
export async function openTab(h: Harness, id: number, url: string, fields: Partial<TabState> = {}): Promise<TabState> {
  h.tabs.info(id, { url, active: fields.active ?? true, windowId: 1 });
  const tab = h.runtime.registry.ensure(id, { windowId: 1, active: fields.active ?? true });
  tab.url = url;
  Object.assign(tab, fields);
  h.runtime.registry.focusedWindowId = 1;
  return tab;
}

/** What media.js would post for its video. */
export function media(type: string, t: number, d: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, t, d, paused: type === "pause" || type === "ended", muted: false, rate: 1, w: 1920, h: 1080, cw: 960, ch: 540, top: true, frame: "", active: true, ...extra };
}

/** Sends a page-script message as the content script would. */
export async function fromPage(h: Harness, tabId: number, handler: string, body: unknown, frameId = 0, url = ""): Promise<unknown> {
  const tab = h.runtime.registry.get(tabId);
  const answer = h.runtime.handleContent(
    { cineon: 1, h: handler, b: body, frame: { url: url || tab?.url || "", top: frameId === 0 } },
    { tab: { id: tabId, url: tab?.url ?? undefined, windowId: 1 }, frameId, url: url || tab?.url || undefined },
  );
  const value = await answer;
  await h.runtime.current?.browser.idle(tabId);
  await settle();
  return value;
}

/** Plays the video for `seconds` of real time, a report every 2 s as media.js sends them. */
export async function play(h: Harness, tabId: number, from: number, seconds: number, duration: number, extra: Record<string, unknown> = {}): Promise<number> {
  let t = from;
  await fromPage(h, tabId, "cineonMedia", media("play", t, duration, extra));
  for (let elapsed = 0; elapsed < seconds; elapsed += 2) {
    await h.clock.advance(2000);
    t += 2;
    await fromPage(h, tabId, "cineonMedia", media("tick", t, duration, extra));
  }
  return t;
}

/** The banners media.js was asked to show in a tab. */
export function banners(h: Harness, tabId: number): { id: string; text: string; seconds?: number; onExpire?: string; actions: { id: string }[] }[] {
  return h.page.calls
    .filter((c) => c.tabId === tabId && c.target === "__cineon" && c.method === "banner")
    .map((c) => c.args[0] as { id: string; text: string; seconds?: number; onExpire?: string; actions: { id: string }[] });
}

/** Calls made to media.js in a tab, by method. */
export function calls(h: Harness, tabId: number, method: string): (readonly unknown[])[] {
  return h.page.calls.filter((c) => c.tabId === tabId && c.method === method).map((c) => c.args);
}
