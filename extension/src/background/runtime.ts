// The background's heart: holds the open ProfileSession (opened on the first event after the worker
// wakes, from what IndexedDB and chrome.storage.session kept), and routes everything the browser and
// the content scripts say to it. index.ts registers the listeners at the top level, synchronously,
// and hands each event here.

import type { KeyValueStorage } from "../core/data";
import type { CounterCheckpoint } from "../core/shields";
import type { PageMessage } from "../content/shim";
import type { SignalChannel } from "../shared/messages";
import { type Clock, detach, hostOf, isWebUrl, type Target } from "./env";
import type { KeepAlive } from "./keepAlive";
import type { BrowserTabInfo, Platform } from "./platform";
import { settleRestoredRescue } from "./rescue";
import { ProfileSession, type SessionServices } from "./session";
import { MediaEvent, type TabState } from "./tabState";
import { TabRegistry } from "./tabs";

/** What a content script sends besides the page scripts' own messages (content/isolated.ts). */
export type ContentMessage =
  | PageMessage
  | { cineon: "hello"; top: boolean; url: string }
  | { cineon: "gesture"; link: { url: string; newTab: boolean } | null }
  /** The top frame stopped a script sending the page to `url` (content/redirectShield.ts). */
  | { cineon: "redirect"; url: string };

/** chrome.runtime.MessageSender, the parts used here (Chrome adds documentId and documentLifecycle). */
export interface ContentSender {
  tab?: { id?: number; url?: string; windowId?: number } | null;
  frameId?: number;
  url?: string;
  documentId?: string;
  documentLifecycle?: string;
}

export const COUNTER_CHECKPOINT_KEY = "cineon.counterCheckpoint";

export interface RuntimeDeps extends Omit<SessionServices, "registry" | "hold" | "configChanged" | "switchProfile" | "counterMode" | "counterCheckpoint"> {
  /** Which way blocked requests can be counted here (needs chrome.management, so it waits). */
  readonly counterMode: () => Promise<import("../core/shields").CounterMode>;
  readonly target: Target;
  readonly channel: SignalChannel | null;
  readonly keepAlive: KeepAlive;
  /** chrome.tabs.sendMessage to a tab's frames (all of them without a frame id). */
  readonly sendToTab: (tabId: number, message: unknown, frameId?: number) => void;
}

export class Runtime {
  readonly registry: TabRegistry;
  private session: ProfileSession | null = null;
  private opening: Promise<ProfileSession> | null = null;
  private readonly clock: Clock;

  constructor(readonly deps: RuntimeDeps) {
    this.clock = deps.clock;
    this.registry = new TabRegistry(deps.session, deps.clock);
    deps.channel?.on((signal) => this.session?.heard(signal));
  }

  get platform(): Platform {
    return this.deps.platform;
  }

  /** The open session, if one is open (no waiting). */
  get current(): ProfileSession | null {
    return this.session;
  }

  /** The session, opening it if needed. Every event that needs the library waits on this. */
  ready(): Promise<ProfileSession> {
    // A session being opened (or a switch to another person) wins over the one still open.
    if (this.opening) return this.opening;
    if (this.session && !this.session.isClosed) return Promise.resolve(this.session);
    const opening = this.open(null).finally(() => {
      if (this.opening === opening) this.opening = null;
    });
    this.opening = opening;
    return opening;
  }

  private async open(profileId: string | null): Promise<ProfileSession> {
    await this.registry.restore();
    const services: SessionServices = {
      ...this.deps,
      counterMode: await this.deps.counterMode().catch(() => "off" as const),
      counterCheckpoint: await Runtime.checkpoint(this.deps.session),
      registry: this.registry,
      hold: { hold: (r) => this.hold(r), release: (r) => this.release(r) },
      configChanged: () => this.broadcastConfig(),
      switchProfile: (id) => detach(this.switchProfile(id)),
    };
    const session = await ProfileSession.open(profileId, services);
    this.session = session;
    await this.reconcile(session);
    return session;
  }

  /** Tabs that closed or moved on while the worker slept. */
  private async reconcile(session: ProfileSession): Promise<void> {
    let open: BrowserTabInfo[];
    try {
      open = await this.platform.tabs.query();
    } catch {
      return;
    }
    for (const gone of this.registry.reconcile(open)) {
      await session.tracker.tabNavigated(gone).catch(() => undefined);
    }
    for (const info of open) {
      const tab = this.registry.get(info.id);
      if (!tab || !info.url || !tab.url || info.url === tab.url) continue;
      // It navigated while nobody was listening.
      session.browser.urlChanged(tab, info.url);
    }
    // A search that was running when the worker stopped has stopped too.
    for (const tab of this.registry.all()) {
      if (settleRestoredRescue(tab)) this.registry.touch(tab.id);
    }
  }

  /**
   * The person changed: close this session (saving everything), open theirs. Switches run one after
   * another (a page sends both the `profile` signal and the request), and `ready()` waits for them.
   */
  switchProfile(profileId: string): Promise<void> {
    const before = this.opening;
    const task = this.switching.then(async () => {
      const old = this.session ?? (before ? await before.catch(() => null) : null);
      if (old && old.profile.id === profileId && !old.isClosed) return old;
      this.session = null;
      if (old) await old.close();
      for (const tab of this.registry.all()) {
        tab.linkedTitleId = null;
        tab.track = null;
      }
      return this.open(profileId);
    });
    this.switching = task.catch(() => undefined);
    const opening = task.finally(() => {
      if (this.opening === opening) this.opening = null;
    });
    this.opening = opening;
    return opening.then(() => undefined);
  }

  private switching: Promise<unknown> = Promise.resolve();

  // MARK: Keeping the worker running

  private hold(reason: string): void {
    this.deps.keepAlive.hold(reason);
    if (this.deps.target === "firefox") this.askForPorts(true);
  }

  private release(reason: string): void {
    this.deps.keepAlive.release(reason);
    if (this.deps.target === "firefox" && this.deps.keepAlive.active.length === 0) this.askForPorts(false);
  }

  /** Firefox: the playing tab holds a port open while the background must stay. */
  private askForPorts(on: boolean): void {
    const tab = this.session?.playback.activeTab() ?? this.registry.selected();
    if (tab && isWebUrl(tab.url)) this.deps.sendToTab(tab.id, { cineon: "keepalive", on }, 0);
  }

  // MARK: Content scripts

  /** Every frame of every tab needs to hear when the overlay sweeper is switched. */
  broadcastConfig(): void {
    for (const tab of this.registry.listed()) {
      if (!isWebUrl(tab.url)) continue;
      detach(
        this.ready().then(async (session) => {
          const config = { ...(await this.configFor(tab.url)), ...session.browser.redirectShieldFor(tab) };
          tab.redirectShieldSent = config.redirectShield;
          this.deps.sendToTab(tab.id, { cineon: "config", ...config });
        }),
      );
    }
  }

  private async configFor(topUrl: string | null): Promise<{ noShield: boolean }> {
    const session = await this.ready();
    const prefs = session.shields.prefsFor(hostOf(topUrl));
    return { noShield: !session.settings.overlaySweeper || prefs.shieldsOff };
  }

  /**
   * A message from a content script. Returns the answer's promise, or undefined for messages that
   * aren't Cineon's content messages (UI requests, the offscreen document's).
   */
  handleContent(message: unknown, sender: ContentSender): Promise<unknown> | undefined {
    if (message == null || typeof message !== "object") return undefined;
    const m = message as { cineon?: unknown };
    const tabId = sender.tab?.id;
    if (tabId == null || tabId < 0) return undefined;
    if (m.cineon === 1) return this.pageMessage(message as PageMessage, sender, tabId);
    if (m.cineon === "hello") return this.hello(message as { top: boolean; url: string }, sender, tabId);
    if (m.cineon === "gesture") return this.gesture(message as { link: { url: string; newTab: boolean } | null }, tabId);
    if (m.cineon === "redirect") return this.redirectStopped(message as { url?: unknown }, sender, tabId);
    return undefined;
  }

  private async hello(message: { top: boolean; url: string }, sender: ContentSender, tabId: number): Promise<unknown> {
    const session = await this.ready();
    const topUrl = sender.tab?.url ?? (message.top ? message.url : null);
    const config = await this.configFor(topUrl);
    if (topUrl && isWebUrl(topUrl)) {
      const css = await session.shieldsCtl.cssFor(topUrl);
      if (css) detach(this.platform.page.insertCss(tabId, [sender.frameId ?? 0], css));
    }
    if (!message.top || (sender.frameId ?? 0) !== 0) return config;
    // The top frame also learns whether to stop scripts sending the page elsewhere. What the tab knows
    // counts only if it's about this document (hello can come before the browser says it committed).
    await this.registry.restore();
    const tab = this.registry.ensure(tabId);
    const known = sender.documentId != null && sender.documentId === tab.documentId;
    const shield = session.browser.redirectShieldFor({ ...tab, url: message.url }, known);
    tab.redirectShieldSent = known ? shield.redirectShield : null;
    return { ...config, ...shield };
  }

  /** The top frame stopped a script sending the page to another site (content/redirectShield.ts). */
  private async redirectStopped(message: { url?: unknown }, sender: ContentSender, tabId: number): Promise<unknown> {
    if ((sender.frameId ?? 0) !== 0 || typeof message.url !== "string") return null;
    if (sender.documentLifecycle && sender.documentLifecycle !== "active") return null;
    const session = await this.ready();
    const tab = this.registry.get(tabId);
    if (tab) session.browser.redirectStoppedInPage(tab, message.url);
    return null;
  }

  private async gesture(message: { link: { url: string; newTab: boolean } | null }, tabId: number): Promise<unknown> {
    await this.registry.restore();
    const tab = this.registry.ensure(tabId);
    tab.lastGestureAt = this.clock.now();
    if (message.link?.newTab) tab.lastUserLink = { url: message.link.url, at: this.clock.now() };
    return null;
  }

  private async pageMessage(message: PageMessage, sender: ContentSender, tabId: number): Promise<unknown> {
    // A page on its way out (the back/forward cache, a prerender) has nothing to say about this tab.
    if (sender.documentLifecycle && sender.documentLifecycle !== "active") return null;
    const session = await this.ready();
    const browser = session.browser;
    const tab = this.registry.ensure(tabId, sender.tab ? { windowId: sender.tab.windowId } : undefined);
    const frameId = sender.frameId ?? 0;
    // The new page spoke before the browser said it committed.
    if (frameId === 0 && sender.documentId && tab.documentId && sender.documentId !== tab.documentId && sender.url) {
      browser.didCommit(tab, sender.url, sender.documentId, null);
    } else if (frameId === 0 && sender.documentId && !tab.documentId) {
      tab.documentId = sender.documentId;
    }
    const frame = { frameId, url: message.frame?.url ?? sender.url ?? "" };
    switch (message.h) {
      case "cineonMedia":
        await browser.receiveMedia(tab, message.b, frame);
        return null;
      case "cineonMeta":
        if (frameId === 0) browser.receiveMeta(tab, message.b);
        return null;
      case "cineonShield":
        browser.receiveShield(tab, message.b);
        return null;
      case "cineonMediaReply": {
        const event = MediaEvent.parse(message.b);
        if (!event) return null;
        tab.mediaFrame = frame;
        if (tab.isHelper || tab.isProbe) return null;
        return await browser.replyToReadyVideo(tab, event);
      }
      default:
        return null;
    }
  }

  // MARK: Tabs

  async tabCreated(info: BrowserTabInfo): Promise<void> {
    await this.registry.restore();
    const tab = this.registry.ensure(info.id, { ...info, url: null });
    if (tab.url == null && info.url && isWebUrl(info.url)) tab.url = info.url;
    this.registry.touch(tab.id);
  }

  async tabUpdated(tabId: number, change: { url?: string; title?: string; status?: string; discarded?: boolean; favIconUrl?: string }, info: BrowserTabInfo): Promise<void> {
    await this.registry.restore();
    const existing = this.registry.get(tabId);
    // Pages Cineon doesn't care about don't open the library.
    if (!existing && !(change.url && isWebUrl(change.url))) {
      this.registry.ensure(tabId, { ...info, url: null });
      return;
    }
    const session = await this.ready();
    const tab = this.registry.ensure(tabId, { ...info, url: null });
    if (change.title) session.browser.titleChanged(tab, change.title);
    if (change.url) session.browser.urlChanged(tab, change.url);
    if (change.discarded === false && tab.isHibernated) tab.isHibernated = false;
    this.registry.touch(tabId);
  }

  async tabRemoved(tabId: number): Promise<void> {
    await this.registry.restore();
    const tab = this.registry.get(tabId);
    if (!tab) return;
    const session = this.session ?? (tab.track || tab.media ? await this.ready() : null);
    if (session) {
      session.rescue.forget(tabId);
      session.rescue.stop(tab);
      await session.tracker.tabNavigated(tab).catch(() => undefined);
      session.shieldsCtl.counter?.resetTab(tabId);
    }
    this.registry.remove(tabId);
  }

  async tabActivated(tabId: number, windowId: number): Promise<void> {
    await this.registry.restore();
    for (const tab of this.registry.all()) {
      if (tab.windowId === windowId && tab.id !== tabId) tab.active = false;
    }
    const tab = this.registry.ensure(tabId, { windowId, active: true });
    tab.active = true;
    tab.lastActiveAt = this.clock.now();
    this.registry.touch(tabId);
  }

  async tabReplaced(addedTabId: number, removedTabId: number): Promise<void> {
    await this.registry.restore();
    const old = this.registry.get(removedTabId);
    if (!old) return;
    this.registry.tabs.delete(removedTabId);
    old.id = addedTabId;
    this.registry.tabs.set(addedTabId, old);
    this.registry.touch(addedTabId);
  }

  async windowFocused(windowId: number): Promise<void> {
    await this.registry.restore();
    if (windowId >= 0) this.registry.focusedWindowId = windowId;
    this.registry.scheduleSave();
  }

  // MARK: Navigation

  private async webTab(tabId: number): Promise<{ session: ProfileSession; tab: TabState } | null> {
    if (tabId < 0) return null;
    const session = await this.ready();
    return { session, tab: this.registry.ensure(tabId) };
  }

  async navCommitted(details: { tabId: number; frameId: number; url: string; documentId?: string; transitionType?: string; transitionQualifiers?: string[] }): Promise<void> {
    if (details.frameId !== 0 || !isWebUrl(details.url)) return;
    const found = await this.webTab(details.tabId);
    if (!found) return;
    found.session.shieldsCtl.counter?.resetTab(details.tabId);
    found.session.browser.didCommit(
      found.tab,
      details.url,
      details.documentId ?? null,
      details.transitionType ? { type: details.transitionType, qualifiers: details.transitionQualifiers ?? [] } : null,
    );
  }

  async navUrlChanged(details: { tabId: number; frameId: number; url: string }): Promise<void> {
    if (details.frameId !== 0 || !isWebUrl(details.url)) return;
    const found = await this.webTab(details.tabId);
    found?.session.browser.urlChanged(found.tab, details.url);
  }

  async navCompleted(details: { tabId: number; frameId: number }): Promise<void> {
    if (details.frameId !== 0) return;
    await this.registry.restore();
    const tab = this.registry.get(details.tabId);
    if (!tab) return;
    const session = await this.ready();
    session.browser.didFinish(tab);
  }

  async navError(details: { tabId: number; frameId: number; url: string; error: string }): Promise<void> {
    if (details.frameId !== 0 || !isWebUrl(details.url)) return;
    const found = await this.webTab(details.tabId);
    if (!found || found.tab.isHelper || found.tab.isProbe) return;
    found.session.browser.didFail(found.tab, details.url, details.error);
  }

  /** A page opened a new tab or window (the Mac's createWebViewWith): the pop-up shield. */
  async createdNavigationTarget(details: { sourceTabId: number; tabId: number; url: string }): Promise<void> {
    await this.registry.restore();
    const opener = this.registry.get(details.sourceTabId);
    if (!opener) return;
    // Hidden tabs never open anything.
    if (opener.isHelper || opener.isProbe) {
      await this.platform.tabs.remove(details.tabId).catch(() => undefined);
      return;
    }
    const session = await this.ready();
    const target = isWebUrl(details.url) ? details.url : null;
    if (session.browser.popupAllowed(opener, target)) return;
    await this.platform.tabs.remove(details.tabId).catch(() => undefined);
    this.registry.remove(details.tabId);
    session.browser.blockPopup(opener, target);
  }

  /** webRequest.onResponseStarted: the main page's status, and player files the network saw. */
  async responseStarted(details: {
    tabId: number;
    frameId: number;
    url: string;
    type: string;
    statusCode: number;
    responseHeaders?: { name: string; value?: string }[];
  }): Promise<void> {
    if (details.tabId < 0) return;
    await this.registry.restore();
    if (details.type === "main_frame") {
      const tab = this.registry.ensure(details.tabId);
      const session = this.session ?? (await this.ready());
      session.browser.mainResponse(tab, details.url, details.statusCode, details.responseHeaders ?? []);
      return;
    }
    if (details.statusCode < 200 || details.statusCode >= 400) return;
    const tab = this.registry.get(details.tabId);
    if (!tab) return;
    const session = this.session ?? (await this.ready());
    const type = details.responseHeaders?.find((h) => h.name.toLowerCase() === "content-type")?.value ?? null;
    session.browser.noteResponse(tab, details.frameId, details.url, type);
  }

  // MARK: Alarms

  async alarm(name: string): Promise<void> {
    const session = await this.ready();
    switch (name) {
      case ALARMS.alerts:
        await session.alerts.checkIfDue();
        break;
      case ALARMS.cloud:
        session.syncCloud();
        break;
      case ALARMS.hibernate:
        await session.browser.hibernateIdleTabs();
        break;
      case ALARMS.shields: {
        const counter = session.shieldsCtl.counter;
        if (!counter) break;
        await counter.poll();
        await this.deps.session?.set(COUNTER_CHECKPOINT_KEY, counter.checkpoint).catch(() => undefined);
        break;
      }
      default:
        break;
    }
  }

  /** The checkpoint of the last worker's polling (shield counter). */
  static async checkpoint(storage: KeyValueStorage | null): Promise<CounterCheckpoint | null> {
    const value = (await storage?.get(COUNTER_CHECKPOINT_KEY).catch(() => null)) as CounterCheckpoint | null | undefined;
    return value && typeof value.since === "number" ? value : null;
  }
}

export const ALARMS = {
  alerts: "cineon-alerts",
  cloud: "cineon-cloud",
  hibernate: "cineon-hibernate",
  shields: "cineon-shields",
} as const;
