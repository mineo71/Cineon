// The real browser behind Platform, Notifier and PageHub: chrome.tabs, chrome.windows,
// chrome.scripting, chrome.notifications, chrome.runtime. Firefox exposes the same `chrome`
// namespace (with promises), so one implementation serves both; where they differ it says so.

import type { Notifier } from "./context";
import { detach, isWebUrl, type Target } from "./env";
import type { BrowserTabInfo, PageCalls, PageTarget, Platform, TabsApi } from "./platform";
import type { PageHub } from "./session";
import type { SignalChannel, SignalInput } from "../shared/messages";

export function tabInfo(tab: chrome.tabs.Tab): BrowserTabInfo {
  return {
    id: tab.id ?? -1,
    windowId: tab.windowId ?? -1,
    url: tab.url ?? tab.pendingUrl ?? null,
    title: tab.title ?? "",
    favIconUrl: tab.favIconUrl ?? null,
    active: tab.active ?? false,
    status: (tab.status as BrowserTabInfo["status"]) ?? null,
    discarded: tab.discarded ?? false,
    audible: tab.audible ?? false,
  };
}

/** The one small unfocused window that hidden helper tabs live in, when a background tab won't do. */
let helperWindowId: number | null = null;

function chromeTabs(): TabsApi {
  return {
    async get(tabId) {
      try {
        return tabInfo(await chrome.tabs.get(tabId));
      } catch {
        return null;
      }
    },
    async query() {
      return (await chrome.tabs.query({})).filter((t) => t.id != null).map(tabInfo);
    },
    async create(options) {
      try {
        const tab = await chrome.tabs.create({
          url: options.url,
          active: options.active,
          windowId: options.windowId,
          openerTabId: options.openerTabId,
          index: options.index,
        });
        return tab.id == null ? null : tabInfo(tab);
      } catch {
        return null;
      }
    },
    async update(tabId, change) {
      const props: chrome.tabs.UpdateProperties = {};
      if (change.url !== undefined) props.url = change.url;
      if (change.active !== undefined) props.active = change.active;
      if (change.muted !== undefined) props.muted = change.muted;
      // Firefox doesn't know autoDiscardable before 127.
      if (change.autoDiscardable !== undefined) (props as Record<string, unknown>).autoDiscardable = change.autoDiscardable;
      try {
        await chrome.tabs.update(tabId, props);
      } catch (error) {
        if (change.autoDiscardable !== undefined && Object.keys(props).length > 1) {
          delete (props as Record<string, unknown>).autoDiscardable;
          await chrome.tabs.update(tabId, props).catch(() => undefined);
          return;
        }
        throw error;
      }
    },
    async reload(tabId) {
      await chrome.tabs.reload(tabId);
    },
    async remove(tabId) {
      await chrome.tabs.remove(tabId).catch(() => undefined);
      if (helperWindowId != null) {
        const left = await chrome.tabs.query({ windowId: helperWindowId }).catch(() => []);
        if (left.length === 0) helperWindowId = null;
      }
    },
    async goBack(tabId) {
      await chrome.tabs.goBack(tabId).catch(() => undefined);
    },
    async discard(tabId) {
      await chrome.tabs.discard(tabId);
    },
    async focusWindow(windowId) {
      await chrome.windows.update(windowId, { focused: true }).catch(() => undefined);
    },
    async createHelperWindow(url) {
      try {
        if (helperWindowId != null) {
          const tab = await chrome.tabs.create({ url, active: false, windowId: helperWindowId });
          return tabInfo(tab);
        }
        const window = await chrome.windows.create({ url, focused: false, width: 480, height: 270, type: "popup" });
        helperWindowId = window?.id ?? null;
        const tab = window?.tabs?.[0];
        return tab ? tabInfo(tab) : null;
      } catch {
        helperWindowId = null;
        return null;
      }
    },
    async group(tabIds, title) {
      const tabs = chrome.tabs as typeof chrome.tabs & { group?: (o: { tabIds: number[] }) => Promise<number> };
      const groups = (chrome as unknown as { tabGroups?: { update(id: number, p: { title: string }): Promise<unknown> } }).tabGroups;
      if (!tabs.group || !groups || tabIds.length === 0) return;
      try {
        const id = await tabs.group({ tabIds });
        await groups.update(id, { title });
      } catch {
        // No groups here (Firefox before tab groups, or a pinned tab among them).
      }
    },
    async captureVisibleTab(windowId, quality) {
      try {
        return await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality });
      } catch {
        return null;
      }
    },
  };
}

/** How long a page call may take; capture() on a big frame is the slowest. */
const PAGE_CALL_TIMEOUT_MS = 8000;

/** `window[target][method](...args)` in the extension's isolated world of one frame. */
function chromePage(): PageCalls & { run(tabId: number, frameId: number, target: PageTarget, method: string, args: readonly unknown[]): Promise<unknown> } {
  return {
    async call(tabId, frameId, target: PageTarget, method, args) {
      // A frame that never commits (a page stuck loading) never answers: give up after a while.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), PAGE_CALL_TIMEOUT_MS);
      });
      try {
        return await Promise.race([this.run(tabId, frameId, target, method, args), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    async run(tabId: number, frameId: number, target: PageTarget, method: string, args: readonly unknown[]): Promise<unknown> {
      try {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [frameId] },
          // Now, not at document_idle: a page still loading (a stream that never finishes) would hold the call.
          injectImmediately: true,
          world: "ISOLATED" as chrome.scripting.ExecutionWorld,
          func: (t: string, m: string, a: unknown[]) => {
            const object = (window as unknown as Record<string, Record<string, unknown> | undefined>)[t];
            const fn = object?.[m];
            return typeof fn === "function" ? (fn as (...x: unknown[]) => unknown).apply(object, a) : null;
          },
          args: [target, method, [...args]],
        });
        return result?.result ?? null;
      } catch {
        return null;
      }
    },
    async insertCss(tabId, frameIds, css) {
      if (!css) return;
      try {
        await chrome.scripting.insertCSS({ target: { tabId, frameIds: [...frameIds] }, css, origin: "USER" });
      } catch {
        // The frame went away, or it's a page the extension can't touch.
      }
    },
  };
}

export function chromePlatform(): Platform {
  return { tabs: chromeTabs(), page: chromePage() };
}

/** chrome.notifications, with clicks routed back to whoever showed each one. */
export class ChromeNotifier implements Notifier {
  private readonly handlers = new Map<string, (button: number | null) => void>();
  private readonly icon: string;

  constructor() {
    this.icon = chrome.runtime.getURL("icons/icon-128.png");
  }

  show(id: string, options: { title: string; message: string; buttons?: readonly string[]; onClick?: (button: number | null) => void }): void {
    if (options.onClick) this.handlers.set(id, options.onClick);
    const base = {
      type: "basic" as chrome.notifications.TemplateType,
      iconUrl: this.icon,
      title: options.title,
      message: options.message,
    };
    // Firefox has no notification buttons: a click on the notification is the first button's.
    const withButtons =
      options.buttons && options.buttons.length > 0 && !isFirefox()
        ? { ...base, buttons: options.buttons.slice(0, 2).map((title) => ({ title })) }
        : base;
    const create = chrome.notifications.create as unknown as (id: string, options: object) => Promise<unknown>;
    detach(Promise.resolve(create(id, withButtons)).catch(() => create(id, base)));
  }

  clear(id: string): void {
    this.handlers.delete(id);
    detach(Promise.resolve(chrome.notifications.clear(id)).catch(() => undefined));
  }

  /** From chrome.notifications.onClicked / onButtonClicked. */
  clicked(id: string, button: number | null): boolean {
    const handler = this.handlers.get(id);
    if (!handler) return false;
    this.handlers.delete(id);
    handler(isFirefox() && button == null ? 0 : button);
    detach(Promise.resolve(chrome.notifications.clear(id)).catch(() => undefined));
    return true;
  }
}

function isFirefox(): boolean {
  return typeof (globalThis as { browser?: unknown }).browser !== "undefined" && navigator.userAgent.includes("Firefox");
}

/** The pages: signals on the channel, and opening the Cineon page. */
export class ChromePageHub implements PageHub {
  constructor(
    private readonly channel: SignalChannel | null,
    private readonly target: Target,
  ) {}

  post(signal: SignalInput): void {
    this.channel?.post(signal);
  }

  async hasOpenPage(): Promise<boolean> {
    const runtime = chrome.runtime as typeof chrome.runtime & { getContexts?: (f: object) => Promise<unknown[]> };
    try {
      if (runtime.getContexts) {
        const contexts = await runtime.getContexts({ contextTypes: ["TAB", "SIDE_PANEL", "POPUP"] });
        return contexts.length > 0;
      }
      const views = (chrome.extension as unknown as { getViews?: () => unknown[] } | undefined)?.getViews?.() ?? [];
      // The event page itself is one of the views in Firefox.
      return views.length > (this.target === "firefox" ? 1 : 0);
    } catch {
      return false;
    }
  }

  async openCineon(route: string | null): Promise<void> {
    const base = chrome.runtime.getURL("app.html");
    const url = route ? `${base}#${route}` : base;
    const existing = (await chrome.tabs.query({ url: `${base}*` }).catch(() => [])).find((t) => !t.url?.includes("#panel"));
    if (existing?.id != null) {
      if (route) this.channel?.post({ type: "navigate", route });
      await chrome.tabs.update(existing.id, { active: true }).catch(() => undefined);
      if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true }).catch(() => undefined);
      return;
    }
    await chrome.tabs.create({ url }).catch(() => undefined);
  }
}

/**
 * Puts text on the clipboard. A service worker has no clipboard, so the active web page writes it
 * (it works when that page has focus); Firefox's event page can write it itself.
 */
export function clipboardWriter(target: Target): (text: string) => void {
  return (text) => {
    if (target === "firefox" && typeof navigator !== "undefined" && navigator.clipboard) {
      detach(navigator.clipboard.writeText(text).catch(() => undefined));
      return;
    }
    detach(
      (async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab?.id == null || !isWebUrl(tab.url)) return;
        await chrome.scripting
          .executeScript({
            target: { tabId: tab.id },
            func: (value: string) => {
              navigator.clipboard?.writeText(value).catch(() => {
                const area = document.createElement("textarea");
                area.value = value;
                area.style.position = "fixed";
                area.style.opacity = "0";
                document.documentElement.appendChild(area);
                area.select();
                document.execCommand("copy");
                area.remove();
              });
            },
            args: [text],
          })
          .catch(() => undefined);
      })(),
    );
  };
}
