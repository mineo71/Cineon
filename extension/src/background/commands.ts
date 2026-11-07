// The keyboard shortcuts (manifest `commands`, the Mac's menu shortcuts that matter in a browser)
// and the context menu (Watch ▸ on the page: find elsewhere, download, save the moment, next
// episode, add to backlog, voice boost, the sleep timer).

import { asDownloadTab } from "./downloadsBridge";
import { detach, isWebUrl } from "./env";
import { SleepTimerMode } from "./playback";
import type { Runtime } from "./runtime";
import type { ProfileSession } from "./session";
import type { TabState } from "./tabState";
import { addFromTab } from "./uiHandlers";

export const MENU = {
  find: "cineon-find",
  download: "cineon-download",
  moment: "cineon-moment",
  next: "cineon-next",
  backlog: "cineon-backlog",
  boost: "cineon-boost",
  sleep: "cineon-sleep",
  sleepCancel: "cineon-sleep-cancel",
  open: "cineon-open",
} as const;

/** The context menu, made once when the extension is installed or updated (menus persist). */
export function createMenus(menus: typeof chrome.contextMenus, voiceBoost: boolean): void {
  const contexts = ["page", "video", "frame", "link"] as [chrome.contextMenus.ContextType, ...chrome.contextMenus.ContextType[]];
  const add = (properties: chrome.contextMenus.CreateProperties) => {
    try {
      menus.create(properties, () => void chrome.runtime.lastError);
    } catch {
      // Already there.
    }
  };
  menus.removeAll(() => {
    add({ id: MENU.find, title: "Find this on another site", contexts });
    add({ id: MENU.download, title: "Download this video", contexts });
    add({ id: MENU.moment, title: "Save this moment", contexts });
    add({ id: MENU.next, title: "Next episode", contexts });
    add({ id: MENU.backlog, title: "Add to backlog", contexts });
    add({ id: MENU.boost, title: "Voice boost", type: "checkbox", checked: voiceBoost, contexts });
    add({ id: MENU.sleep, title: "Sleep timer", contexts });
    for (const [index, mode] of SleepTimerMode.choices.entries()) {
      add({ id: `${MENU.sleep}-${index}`, parentId: MENU.sleep, title: SleepTimerMode.label(mode), contexts });
    }
    add({ id: MENU.sleepCancel, parentId: MENU.sleep, title: "Turn off", contexts });
    add({ id: MENU.open, title: "Open Cineon", contexts: ["action"] });
  });
}

/** The tab a command is about: the one it came from, else the one playing, else the one in front. */
function pickTab(session: ProfileSession, tabId: number | null | undefined): TabState | null {
  const tab = session.browser.tab(tabId);
  if (tab && isWebUrl(tab.url)) return tab;
  return session.playback.activeTab() ?? session.browser.selected;
}

/** A keyboard shortcut (chrome.commands.onCommand). */
export async function runCommand(runtime: Runtime, command: string, tabId: number | null | undefined): Promise<void> {
  const session = await runtime.ready();
  switch (command) {
    case "play-pause":
      await session.playback.togglePlayback();
      break;
    case "save-moment": {
      // The tab in front if it has a video, else the one playing (AppModel.saveMoment).
      const selected = session.browser.tab(tabId) ?? session.browser.selected;
      const tab = selected?.media ? selected : session.browser.playingTab;
      if (!tab) {
        session.toasts.show("Play something first, then save the moment you like");
        return;
      }
      await session.frames.saveMoment(tab);
      break;
    }
    case "download-video": {
      const tab = session.browser.tab(tabId) ?? session.browser.selected;
      if (!tab || !isWebUrl(tab.url) || !session.downloads) {
        session.toasts.show("Open a film's page first, then download it from there");
        return;
      }
      await session.downloads.download(asDownloadTab(session.browser, tab));
      session.browser.refreshDownloadPill(tab);
      break;
    }
    case "find-elsewhere": {
      const tab = session.browser.tab(tabId) ?? session.browser.selected;
      if (tab) session.rescue.findElsewhere(tab);
      break;
    }
    case "next-episode":
      await session.playback.playNextEpisode();
      break;
    default:
      break;
  }
}

/** A context menu item (chrome.contextMenus.onClicked). */
export async function runMenu(runtime: Runtime, itemId: string, tabId: number | null | undefined, checked: boolean | undefined): Promise<void> {
  const session = await runtime.ready();
  const tab = pickTab(session, tabId);
  switch (itemId) {
    case MENU.find:
      if (tab) session.rescue.findElsewhere(tab);
      return;
    case MENU.download:
      return runCommand(runtime, "download-video", tabId);
    case MENU.moment:
      return runCommand(runtime, "save-moment", tabId);
    case MENU.next:
      if (tab) await session.autopilot.skipToNext(tab);
      return;
    case MENU.backlog: {
      if (!tab) return;
      const result = await addFromTab(session, tab);
      if (result.kind === "done") session.toasts.show(result.message, { tab });
      else session.toasts.show("Cineon couldn't tell what this is. Add it in Cineon.", { tab });
      return;
    }
    case MENU.boost:
      await session.updateSettings({ voiceBoost: checked ?? !session.settings.voiceBoost });
      return;
    case MENU.sleepCancel:
      session.playback.cancel();
      return;
    case MENU.open:
      return;
    default:
      break;
  }
  if (itemId.startsWith(`${MENU.sleep}-`)) {
    const mode = SleepTimerMode.choices[Number(itemId.slice(MENU.sleep.length + 1))];
    if (mode) session.playback.start(mode);
  }
}
