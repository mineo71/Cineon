// Answers the pages' requests (shared/messages.ts, notes/ui.md's table), each the Mac's AppModel or
// session action it names.

import { type DownloadItem, TitleStatus } from "../core/data";
import type { DownloadCenter } from "../core/downloads";
import type { AddFromTabResult, PlayerCommand, TabSnapshot, UiHandlers } from "../shared/messages";
import { asDownloadTab } from "./downloadsBridge";
import { buildTarget, buildVersion, isWebUrl } from "./env";
import type { Runtime } from "./runtime";
import type { ProfileSession } from "./session";
import { shieldsSnapshot } from "./shieldsBridge";
import { downloadsSnapshot, tabSnapshot } from "./snapshots";
import type { TabState } from "./tabState";
import { partyTabId } from "./togetherBridge";

/** Reads one of the extension's own files (rules/meta.json). */
export type ReadFile = (path: string) => Promise<unknown>;

/** The tab's state, learning about it from the browser when Cineon hasn't seen it yet. */
async function tabFor(runtime: Runtime, tabId: number): Promise<TabState | null> {
  const known = runtime.registry.get(tabId);
  if (known) return known;
  const info = await runtime.platform.tabs.get(tabId);
  if (!info) return null;
  const tab = runtime.registry.ensure(tabId, { ...info, url: null });
  if (info.url) tab.url = info.url;
  return tab;
}

function snapshot(session: ProfileSession, tab: TabState | null): TabSnapshot | null {
  return tab ? tabSnapshot(tab, session.browser, session.shieldsCtl) : null;
}

/** AppModel.addCurrentPageToBacklog for one tab. */
export async function addFromTab(session: ProfileSession, tab: TabState): Promise<AddFromTabResult> {
  const library = session.library;
  const linked = tab.track?.titleId ?? tab.linkedTitleId;
  const title = linked != null ? library.titles.get(linked) : undefined;
  if (title) {
    if (title.status === "none" || title.status === "watched") await library.setStatus(title.id, "backlog");
    return { kind: "done", titleId: title.id, message: `Added ${title.name} to backlog` };
  }
  const parsed = tab.parsed;
  if (!parsed) return { kind: "needsName", query: tab.title };
  const existing = library.find(parsed.name, parsed.altName, parsed.year);
  if (existing) {
    if (existing.status === "none") await library.setStatus(existing.id, "backlog");
    const status = library.titles.get(existing.id)?.status;
    return {
      kind: "done",
      titleId: existing.id,
      message: `${existing.name} is in ${status ? TitleStatus.label(status).toLowerCase() : "your library"}`,
    };
  }
  const added = await library.addTitle(parsed.name, {
    year: parsed.year,
    kind: parsed.kindHint,
    status: "backlog",
    posterUrl: parsed.posterUrl,
    overview: parsed.overview,
  });
  if (!added) return { kind: "needsName", query: parsed.name };
  session.metadata.enrich(added.id, parsed.altName);
  return { kind: "done", titleId: added.id, message: `Added ${added.name} to backlog` };
}

function commandTab(session: ProfileSession, tab: TabState, command: PlayerCommand): Promise<unknown> | void {
  const browser = session.browser;
  switch (command.kind) {
    case "play":
      return browser.play(tab);
    case "pause":
      return browser.pausePlayback(tab);
    case "toggle":
      return browser.togglePlayback(tab);
    case "skip":
      return browser.skip(tab, command.seconds);
    case "seek":
      return browser.seek(tab, command.seconds);
    case "rate":
      return browser.setRate(tab, command.rate);
    case "pictureInPicture":
      return browser.togglePictureInPicture(tab);
    case "nextEpisode":
      return session.autopilot.skipToNext(tab);
    case "saveMoment":
      return session.frames.saveMoment(tab);
    case "findElsewhere":
      return session.rescue.findElsewhere(tab);
  }
}

function needDownloads(session: ProfileSession): DownloadCenter {
  if (!session.downloads) throw new Error("The download center isn't open");
  return session.downloads;
}

export function uiHandlers(runtime: Runtime, readFile: ReadFile): UiHandlers {
  const ready = () => runtime.ready();
  const together = async () => {
    const session = await ready();
    session.startTogether();
    const model = session.together;
    if (!model) throw new Error("Together isn't available");
    return { session, model };
  };
  const seasons = async () => {
    const session = await ready();
    if (!session.seasons) throw new Error("The download center isn't open");
    return session.seasons;
  };

  return {
    ping: () => ({ version: buildVersion(), target: buildTarget() }),

    // Tabs and players
    "tab.state": async ({ tabId }) => {
      const session = await ready();
      return { tab: snapshot(session, await tabFor(runtime, tabId)) };
    },
    "player.active": async () => {
      const session = await ready();
      return { tab: snapshot(session, session.playback.activeTab()) };
    },
    "player.command": async ({ tabId, command }) => {
      const session = await ready();
      const tab = await tabFor(runtime, tabId);
      if (!tab || !isWebUrl(tab.url)) return { ok: false };
      await commandTab(session, tab, command);
      return { ok: true };
    },
    "tabs.open": async ({ url, resumeAt, active }) => {
      const session = await ready();
      // AppModel.resume(url:at:): carry on in a tab already on that page, else a new one.
      const tab =
        resumeAt != null
          ? await session.browser.open(url, { resumeAt, keepWatching: true, active })
          : await session.browser.openTab(url, { select: active });
      return { tabId: tab?.id ?? -1 };
    },
    "tabs.focus": async ({ tabId }) => {
      const session = await ready();
      const tab = await tabFor(runtime, tabId);
      if (!tab) return { ok: false };
      await session.browser.select(tab);
      return { ok: true };
    },
    "search.everywhere": async ({ query, titleId }) => {
      const session = await ready();
      return { tabs: await session.browser.searchEverywhere(query, titleId) };
    },

    // Tracking
    "library.addFromTab": async ({ tabId }) => {
      const session = await ready();
      const tab = await tabFor(runtime, tabId);
      if (!tab) return { kind: "needsName", query: "" };
      return addFromTab(session, tab);
    },
    "tracker.relink": async ({ tabId, titleId, ref }) => {
      const session = await ready();
      const tab = await tabFor(runtime, tabId);
      if (!tab) return { ok: false };
      await session.tracker.relink(tab, titleId, ref);
      session.browser.changed(tab);
      return { ok: true };
    },
    "tracker.ignore": async ({ tabId }) => {
      const session = await ready();
      const tab = await tabFor(runtime, tabId);
      if (!tab) return { ok: false };
      await session.tracker.ignore(tab);
      session.browser.changed(tab);
      return { ok: true };
    },
    "tracker.stopSite": async ({ tabId }) => {
      const session = await ready();
      const tab = await tabFor(runtime, tabId);
      if (!tab) return { ok: false };
      await session.tracker.stopTrackingSite(tab);
      session.browser.changed(tab);
      return { ok: true };
    },

    // Shields
    "shields.state": () => shieldsSnapshot(readFile),
    "shields.setSite": async ({ host, prefs, tabId }) => {
      const session = await ready();
      const { shieldsChanged } = await session.shieldsCtl.setSite(host, prefs);
      runtime.broadcastConfig();
      session.publishPlayer(true);
      if (shieldsChanged && tabId != null) await runtime.platform.tabs.reload(tabId).catch(() => undefined);
      return { ok: true };
    },

    // Downloads
    "downloads.state": async () => {
      const session = await ready();
      return downloadsSnapshot(session.downloads, session.seasons);
    },
    "downloads.start": async ({ tabId }) => {
      const session = await ready();
      const tab = await tabFor(runtime, tabId);
      if (!tab || !isWebUrl(tab.url)) return { ok: false, message: "Open a film's page first, then download it from there" };
      const ok = await needDownloads(session).download(asDownloadTab(session.browser, tab));
      session.browser.refreshDownloadPill(tab);
      return { ok, message: null };
    },
    "downloads.season": async ({ tabId, fromCurrent }) => {
      const session = await ready();
      const tab = await tabFor(runtime, tabId);
      if (!tab) return { ok: false };
      await (await seasons()).start(asDownloadTab(session.browser, tab), fromCurrent);
      return { ok: true };
    },
    "downloads.series": async ({ tabId }) => {
      const session = await ready();
      const tab = await tabFor(runtime, tabId);
      if (!tab) return { ok: false };
      await (await seasons()).startSeries(asDownloadTab(session.browser, tab));
      return { ok: true };
    },
    "downloads.cancel": async ({ id }) => {
      needDownloads(await ready()).cancel(id);
      return { ok: true };
    },
    "downloads.retry": async ({ id }) => {
      needDownloads(await ready()).retry(id);
      return { ok: true };
    },
    "downloads.remove": async ({ id }) => {
      await needDownloads(await ready()).remove(id);
      return { ok: true };
    },
    "downloads.show": async ({ id }) => {
      const downloads = needDownloads(await ready());
      const item = downloads.item(id);
      if (!item) return { ok: false };
      await downloads.showInFolder(item);
      return { ok: true };
    },
    "downloads.play": async ({ id }) => {
      const session = await ready();
      const item: DownloadItem | null = needDownloads(session).item(id);
      if (!item) return { ok: false, message: "That download is gone" };
      const message = await session.playDownloadMessage(item);
      return { ok: message == null, message };
    },
    "seasons.confirm": async () => {
      (await seasons()).confirm();
      return { ok: true };
    },
    "seasons.decline": async () => {
      (await seasons()).decline();
      return { ok: true };
    },
    "seasons.resume": async () => {
      await (await seasons()).resume();
      return { ok: true };
    },
    "seasons.cancel": async () => {
      (await seasons()).cancel();
      return { ok: true };
    },
    "seasons.dismiss": async () => {
      (await seasons()).dismiss();
      return { ok: true };
    },

    // Together
    "together.state": async () => {
      const { session } = await together().catch(async () => ({ session: await ready() }));
      return session.togetherState();
    },
    "together.enter": async ({ code }) => {
      const { model } = await together();
      await model.enter(code);
      return { ok: true };
    },
    "together.startParty": async ({ tabId }) => {
      const { session, model } = await together();
      session.partyPlayer.chosenTabId = tabId;
      try {
        await model.startParty();
      } finally {
        session.partyPlayer.chosenTabId = null;
      }
      return { ok: model.party != null };
    },
    "together.leaveParty": async () => {
      const { model } = await together();
      await model.leaveParty();
      return { ok: true };
    },
    "together.goToParty": async () => {
      const { session, model } = await together();
      const tab = session.browser.tab(partyTabId(model));
      if (!tab) return { ok: false };
      await session.browser.select(tab);
      return { ok: true };
    },
    "together.say": async ({ text }) => {
      const { model } = await together();
      await model.say(text);
      return { ok: true };
    },
    "together.react": async ({ emoji }) => {
      const { model } = await together();
      await model.react(emoji);
      return { ok: true };
    },
    "together.shareWatched": async () => {
      const { model } = await together();
      await model.shareWatched();
      return { ok: true };
    },
    "together.share": async ({ titleId }) => {
      const { session, model } = await together();
      const title = session.library.titles.get(titleId);
      if (!title) return { ok: false };
      await model.share(title);
      return { ok: true };
    },
    "together.createChallenge": async ({ titleId }) => {
      const { session, model } = await together();
      const title = session.library.titles.get(titleId);
      if (!title) return { ok: false };
      await model.createChallenge(title);
      return { ok: true };
    },
    "together.leaveChallenge": async ({ code }) => {
      const { model } = await together();
      await model.leaveChallenge(code);
      return { ok: true };
    },
    "together.forgetShare": async ({ code }) => {
      const { model } = await together();
      model.forgetShare(code);
      return { ok: true };
    },
    "together.addToBacklog": async ({ card }) => {
      const { model } = await together();
      await model.addToBacklog(card);
      return { ok: true };
    },
    "together.refreshChallenges": async () => {
      const { model } = await together();
      await model.refreshChallenges();
      return { ok: true };
    },
    "together.adopt": async ({ recoveryCode }) => {
      const { session, model } = await together();
      const ok = await model.adopt(recoveryCode);
      if (ok) await session.cloud?.sync();
      return { ok };
    },

    // Cloud backup
    "cloud.noteChanges": async ({ titleIds }) => {
      const session = await ready();
      await session.library.reload();
      for (const id of titleIds) {
        const title = session.library.titles.get(id);
        if (title) session.cloud?.noteChange(title);
      }
      return { ok: true };
    },

    // Profiles
    "session.switchProfile": async ({ profileId }) => {
      await runtime.switchProfile(profileId);
      return { ok: true };
    },
  };
}
