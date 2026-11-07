// The service worker (Chrome, Edge) or event page (Firefox): tracker, autopilot, rescue, shields,
// downloads, Together, alerts. Either can be stopped after ~30 s without events, so everything here
// is registered at the top level, synchronously, before any await: an event that wakes the worker
// finds its listener. State comes back from IndexedDB (the library) and chrome.storage.session (the
// tabs, the sleep timer, the shield counter's checkpoint, the download header rules) when the first
// event arrives (Runtime.ready). See notes/runtime.md.

import { chromeStorage } from "../core/data";
import { chromeDownloads, DnrHeaderRules, ObjectUrls } from "../core/downloads";
import { chromeDnr, counterMode, FILTER_CATALOG, loadCosmeticIndex, POLL_MINUTES, type CosmeticIndex } from "../core/shields";
import { TogetherClient } from "../core/together";
import { createStreamWorker } from "../offscreen/client";
import { listenForUiRequests, SignalChannel } from "../shared/messages";
import { ChromeNotifier, ChromePageHub, chromePlatform, clipboardWriter, tabInfo } from "./chromeApi";
import { createMenus, MENU, runCommand, runMenu } from "./commands";
import { installDebug } from "./debug";
import { buildTarget, detach, isDevBuild, systemClock } from "./env";
import { KEEPALIVE_PORT, KeepAlive } from "./keepAlive";
import { ALARMS, Runtime } from "./runtime";
import { uiHandlers } from "./uiHandlers";

declare const __DEV__: boolean;

const target = buildTarget();
const clock = systemClock;
const local = chromeStorage(chrome.storage.local);
const sessionStore = chrome.storage.session ? chromeStorage(chrome.storage.session) : null;
const channel = typeof BroadcastChannel === "function" ? new SignalChannel() : null;
const platform = chromePlatform();
const notifier = new ChromeNotifier();
const pages = new ChromePageHub(channel, target);
const dnr = chromeDnr();
const readFile = (path: string) => fetch(chrome.runtime.getURL(path)).then((r) => r.json() as Promise<unknown>);

// Downloads: these listen at once (onChanged deltas, the offscreen document's events), before the
// download center opens (notes/downloads.md).
const browserDownloads = chromeDownloads();
const streams = createStreamWorker(target);
const headers = new DnrHeaderRules(undefined, sessionStore ? { storage: sessionStore } : {});

let cosmetic: Promise<CosmeticIndex | null> | null = null;
const keepAlive = new KeepAlive(clock, () => {
  detach(Promise.resolve(chrome.runtime.getPlatformInfo()).catch(() => undefined));
});

const runtime = new Runtime({
  target,
  clock,
  platform,
  pages,
  notifier,
  local,
  session: sessionStore,
  dnr,
  cosmetic: () =>
    (cosmetic ??= loadCosmeticIndex(
      FILTER_CATALOG.map((l) => l.id),
      readFile,
    ).catch(() => null)),
  counterMode: async () => counterMode(dnr, (await chrome.management.getSelf()).installType),
  downloads: {
    browser: browserDownloads,
    headers,
    streams,
    // Chrome's worker has no object URLs; subtitles go through data: URLs (streams use the offscreen document's).
    objectUrls: target === "chrome" ? ObjectUrls.data() : ObjectUrls.browser(),
    async open(id) {
      try {
        await Promise.resolve(chrome.downloads.open(id) as unknown);
        return !chrome.runtime.lastError;
      } catch {
        return false;
      }
    },
    async show(id) {
      try {
        await Promise.resolve(chrome.downloads.show(id) as unknown);
        return true;
      } catch {
        return false;
      }
    },
  },
  togetherClient: async () => {
    // Development builds talk to the dev deployment; a URL in storage overrides both (e2e).
    const override = await local.get("cineon.togetherUrl").catch(() => undefined);
    return TogetherClient.configured(
      typeof override === "string" ? override : null,
      isDevBuild() ? TogetherClient.DEVELOPMENT_URL : TogetherClient.PRODUCTION_URL,
    );
  },
  power: (chrome as unknown as { power?: { requestKeepAwake(level: string): void; releaseKeepAwake(): void } }).power ?? null,
  copyText: clipboardWriter(target),
  channel,
  keepAlive,
  sendToTab: (tabId, message, frameId) => {
    const options = frameId != null ? { frameId } : undefined;
    detach(Promise.resolve(chrome.tabs.sendMessage(tabId, message, options as chrome.tabs.MessageSendOptions)).catch(() => undefined));
  },
  systemNotifications: true,
});

// MARK: Messages

listenForUiRequests(uiHandlers(runtime, readFile));

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const answer = runtime.handleContent(message, sender as never);
  if (!answer) return undefined;
  answer.then(
    (value) => reply(value ?? null),
    (error) => {
      console.warn("Cineon: a page message failed", error);
      reply(null);
    },
  );
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== KEEPALIVE_PORT) return;
  // The messages themselves are the point: each one is an event that keeps the background going.
  port.onMessage.addListener(() => undefined);
});

// MARK: Tabs and windows

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id != null) detach(runtime.tabCreated(tabInfo(tab)));
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => detach(runtime.tabUpdated(tabId, change, tabInfo(tab))));
chrome.tabs.onRemoved.addListener((tabId) => detach(runtime.tabRemoved(tabId)));
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => detach(runtime.tabActivated(tabId, windowId)));
chrome.tabs.onReplaced.addListener((added, removed) => detach(runtime.tabReplaced(added, removed)));
chrome.windows.onFocusChanged.addListener((windowId) => detach(runtime.windowFocused(windowId)));

// MARK: Navigation

chrome.webNavigation.onCommitted.addListener((d) => detach(runtime.navCommitted(d as never)));
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => detach(runtime.navUrlChanged(d)));
chrome.webNavigation.onReferenceFragmentUpdated.addListener((d) => detach(runtime.navUrlChanged(d)));
chrome.webNavigation.onCompleted.addListener((d) => detach(runtime.navCompleted(d)));
chrome.webNavigation.onErrorOccurred.addListener((d) => detach(runtime.navError(d)));
chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => detach(runtime.createdNavigationTarget(d)));

// The main page's status (a page that's gone starts a rescue) and the player's files as the network
// saw them, for frames whose scripts can't say. Observe only: nothing is blocked or changed here.
const MEDIA_URLS = ["m3u8", "mp4", "m4v", "webm", "mov", "vtt", "srt"].map((ext) => `*://*/*.${ext}*`);
chrome.webRequest.onResponseStarted.addListener(
  (d) => detach(runtime.responseStarted(d as never)),
  { urls: ["<all_urls>"], types: ["main_frame"] },
  ["responseHeaders"],
);
chrome.webRequest.onResponseStarted.addListener(
  (d) => detach(runtime.responseStarted(d as never)),
  { urls: MEDIA_URLS, types: ["xmlhttprequest", "media", "other", "sub_frame"] },
  ["responseHeaders"],
);

// MARK: Alarms, keys, menus, notifications

async function ensureAlarms(): Promise<void> {
  const wanted: [string, chrome.alarms.AlarmCreateInfo][] = [
    [ALARMS.alerts, { delayInMinutes: 1, periodInMinutes: 6 * 60 }],
    [ALARMS.cloud, { periodInMinutes: 10 }],
    [ALARMS.hibernate, { periodInMinutes: 5 }],
  ];
  const mode = counterMode(dnr, (await chrome.management.getSelf().catch(() => null))?.installType);
  if (mode === "matched") wanted.push([ALARMS.shields, { periodInMinutes: POLL_MINUTES }]);
  for (const [name, info] of wanted) {
    const existing = await chrome.alarms.get(name).catch(() => undefined);
    if (!existing) await chrome.alarms.create(name, info);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => detach(runtime.alarm(alarm.name)));

chrome.commands.onCommand.addListener((command, tab) => detach(runCommand(runtime, command, tab?.id)));

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId);
  if (id === MENU.open) {
    detach(pages.openCineon(null));
    return;
  }
  detach(runMenu(runtime, id, tab?.id, info.checked));
});

/** A notification from before the worker stopped: its handler is gone, so read its id. */
function notificationFallback(id: string): void {
  const episode = /^episode-(\d+)-/.exec(id);
  if (episode) {
    detach(pages.openCineon(`library?title=${episode[1]}`));
    return;
  }
  const rescue = /^rescue-(\d+)$/.exec(id);
  if (rescue) {
    detach(chrome.tabs.update(Number(rescue[1]), { active: true }).catch(() => undefined));
    return;
  }
  detach(pages.openCineon(null));
}

chrome.notifications.onClicked.addListener((id) => {
  if (!notifier.clicked(id, null)) notificationFallback(id);
});
chrome.notifications.onButtonClicked?.addListener((id, button) => {
  if (!notifier.clicked(id, button)) notificationFallback(id);
});

chrome.runtime.onInstalled.addListener(() => {
  detach(ensureAlarms());
  detach(runtime.ready().then((session) => createMenus(chrome.contextMenus, session.settings.voiceBoost)));
});
chrome.runtime.onStartup.addListener(() => {
  detach(ensureAlarms());
  // The browser just started: tabs from the last run are new tabs now, and rulesets need applying.
  detach(runtime.ready());
});

// Every wake: alarms are cheap to check.
detach(ensureAlarms());

if (__DEV__) {
  installDebug({
    runtime,
    evalInPage: async (tabId, frameId, js) => {
      try {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [frameId] },
          injectImmediately: true,
          world: "MAIN" as chrome.scripting.ExecutionWorld,
          // Development builds only: the e2e test's own expressions, in the page's world.
          func: (code: string) => (0, eval)(code),
          args: [js],
        });
        return result?.result ?? null;
      } catch (error) {
        return `error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    openCineon: (route) => pages.openCineon(route),
    removeTab: (tabId) => chrome.tabs.remove(tabId),
  });
}
