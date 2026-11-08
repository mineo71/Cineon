// Development builds only (`node scripts/build.mjs --dev` defines __DEV__; index.ts installs this
// behind `if (__DEV__)`, so release builds don't contain it): the Mac's App/DebugCommands.swift,
// the commands that mean something in a browser extension. End-to-end tests drive the extension
// with them:
//   - from an extension page: chrome.runtime.sendMessage({ kind: "cineon/debug", type: "state", ...query })
//     answered with { ok: true, value: "<text>" };
//   - from the service worker (Playwright's serviceWorker.evaluate): self.cineonDebug.run("state", query).
// The answer is the text the Mac writes to debug-output.txt: `key=value` lines, the same keys where
// they apply, `end=1` where the Mac ends with it.

import { CaptionStyle, EpisodeRef, type MediaSource, TitleKind, TitleStatus, UrlKey, WatchProgress, WatchSession } from "../core/data";
import { SeasonGrabber } from "../core/downloads";
import { episodeInfo } from "../core/metadata";
import { PartyState } from "../core/together";
import { shortLabel } from "./autopilot";
import { asDownloadTab } from "./downloadsBridge";
import { isWebUrl } from "./env";
import type { Runtime } from "./runtime";
import type { ProfileSession } from "./session";
import { RescueState, type TabState } from "./tabState";
import { partyTabId } from "./togetherBridge";

export const DEBUG_MESSAGE = "cineon/debug";

export type DebugQuery = Record<string, string | number | boolean | null | undefined>;

export interface DebugDeps {
  readonly runtime: Runtime;
  /** Runs a function in a frame's page world (MAIN) and gives what it returns; for `eval`/`mediaeval` with `js`. */
  readonly evalInPage: (tabId: number, frameId: number, js: string) => Promise<unknown>;
  /** Opens the Cineon page at a route. */
  readonly openCineon: (route: string | null) => Promise<void>;
  readonly removeTab: (tabId: number) => Promise<void>;
}

function q(query: DebugQuery, key: string): string | null {
  const value = query[key];
  return value == null ? null : String(value);
}

function num(query: DebugQuery, key: string): number | null {
  const value = q(query, key);
  if (value == null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function flag(query: DebugQuery, key: string): boolean | null {
  const value = q(query, key);
  return value == null ? null : value === "1" || value === "true";
}

function lines(...rows: string[]): string {
  return rows.join("\n");
}

function show(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** The Mac's `ShieldStats` description. */
function blockedText(tab: TabState | null): string {
  const b = tab?.blocked ?? { ads: 0, popups: 0, redirects: 0, overlays: 0 };
  return `ShieldStats(ads: ${b.ads}, popups: ${b.popups}, redirects: ${b.redirects}, overlays: ${b.overlays})`;
}

function sourceLine(s: MediaSource): string {
  return `source ${s.kind} current=${s.isCurrent} ${s.url}`;
}

function autopilotText(tab: TabState | null): string {
  if (!tab) return "-";
  const a = tab.autopilot;
  const rules = a.rules.map((r) => `${r.kind}:${r.start}-${r.end}:${r.sightings}/${r.misses}`).join(",");
  const target = a.target ? `${shortLabel(a.target.ref)}${a.target.isOnPage ? "@page" : ""}${a.target.url ? `@${a.target.url}` : ""}` : "-";
  return [
    `resolved=${a.isResolved}`,
    `target=${target}`,
    `offered=${a.didOffer}`,
    `countingDown=${a.isCountingDown}`,
    `declined=${a.isDeclined}`,
    `moved=${a.didMove}`,
    `heldForSleep=${a.isHeldForSleep}`,
    `rules=${rules || "-"}`,
  ].join("|");
}

/** The Mac's `/state`, the lines that apply to a browser extension, plus sources, downloads and autopilot. */
export function stateText(runtime: Runtime, session: ProfileSession): string {
  const browser = session.browser;
  const tab = browser.selected;
  const parsed = tab?.parsed;
  const rescue = tab?.rescue;
  let frames = 0;
  for (const list of session.library.framesBySession.values()) frames += list.length;
  const downloads = session.downloads;
  const best = tab ? browser.bestSource(tab) : null;
  return lines(
    `profile=${session.profile.name}`,
    `profileid=${session.profile.id}`,
    `url=${tab?.url ?? "-"}`,
    `title=${tab?.title ?? "-"}`,
    `parsed=${parsed ? `${parsed.name}|${parsed.year ?? 0}|S${parsed.ref.season}E${parsed.ref.episode}|${parsed.kindHint}|${parsed.confidence}` : "-"}`,
    `media=${tab?.media ? `${tab.media.position}/${tab.media.duration} playing=${tab.media.isPlaying}` : "-"}`,
    `track=${tab?.track?.titleId ?? -1}`,
    `linked=${tab?.linkedTitleId ?? -1}`,
    `blocked=${blockedText(tab)}`,
    `framesBlocked=${tab?.ambientFramesBlocked ?? false}`,
    `ambientOn=${session.settings.ambientLight}`,
    `ambient=${tab?.ambient ? tab.ambient.map((z) => z.join(",")).join(" ") : "-"}`,
    `tabs=${browser.tabs.length}`,
    `tablist=${browser.tabs.map((t) => `${t.url ?? "-"}[${t.isHibernated ? "h" : "a"}]`).join(",")}`,
    `helpers=${runtime.registry.all().filter((t) => t.isHelper || t.isProbe).length}`,
    `toast=${session.toasts.current ?? "-"}`,
    `banner=${tab?.lastBannerForTests ?? "-"}`,
    `rescue=${
      rescue
        ? `${rescue.reason}|${rescue.stage}|${rescue.options.map((o) => `${o.siteName}:${safePath(o.url)}:${o.isStrong}`).join(";")}|${rescue.countdown ?? -1}|resume=${RescueState.resumePoint(rescue) ?? -1}`
        : "-"
    }`,
    `failure=${tab?.failure?.host ?? "-"}`,
    `frames=${frames}`,
    `sites=${session.library.sites.map((s) => `${s.host}|${s.searchTemplate ?? "-"}`).join(",")}`,
    `theater=${tab?.isTheaterOn ?? false}`,
    `boost=${tab?.boostState ?? "-"}`,
    `best=${best?.url ?? "-"}`,
    `sourcesFrame=${tab?.sourcesFrame?.url ?? "-"}`,
    `sources=${(tab?.sources ?? []).map((s) => `${s.kind}:${s.isCurrent ? "current" : "old"}:${s.url}`).join(",") || "-"}`,
    `downloads=${downloads ? downloads.items.map((i) => `${i.id}:${i.status}:${i.kind}`).join(",") || "none" : "-"}`,
    `autopilot=${autopilotText(tab)}`,
    `sleep=${session.playback.sleepTimer ? `${session.playback.sleepTimer.mode.kind}|${session.playback.remaining() ?? -1}` : "-"}`,
    `awake=${runtime.deps.keepAlive.active.join(",") || "-"}`,
    `stayAwake=${session.playback.isHoldingAwake}`,
    `party=${session.together?.party?.code ?? "-"}`,
    `version=${runtime.deps.target}`,
  );
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** The selected web tab, or an error text. */
function needTab(session: ProfileSession): TabState | string {
  const tab = session.browser.selected;
  return tab && isWebUrl(tab.url) ? tab : "no web view";
}

export async function runDebug(deps: DebugDeps, type: string, query: DebugQuery = {}): Promise<string> {
  const runtime = deps.runtime;
  const name = type.replace(/^debug\//, "").replace(/^\//, "");
  if (name === "switchprofile" || name === "addprofile") return profileCommand(runtime, name, query);
  const session = await runtime.ready();
  const browser = session.browser;
  const library = session.library;

  switch (name) {
    case "state":
      return stateText(runtime, session);

    case "idle": {
      // Everything heard so far has been handled: reports, captures, searches, downloads.
      await browser.idle();
      await Promise.all([session.frames.idle(), session.rescue.idle(), session.metadata.idle, session.downloads?.idle(), session.seasons?.idle()]);
      await runtime.registry.saveNow();
      return "idle=1\nend=1";
    }

    case "open": {
      const url = q(query, "url");
      if (!url) return "no url";
      const tab = await browser.openTab(url, { select: flag(query, "select") ?? true });
      return `tab=${tab?.id ?? -1}\nend=1`;
    }

    case "addsite": {
      const url = q(query, "url");
      if (!url) return "no url";
      const site = await library.addSite(url, q(query, "name"));
      if (site) await library.updateSite({ ...site, searchTemplate: q(query, "search") });
      return `site=${site?.id ?? -1}\nend=1`;
    }

    case "eval": {
      const tab = needTab(session);
      if (typeof tab === "string") return tab;
      if (q(query, "world") === "cineon") {
        const method = q(query, "method") ?? "";
        const args = JSON.parse(q(query, "args") ?? "[]") as unknown[];
        return show(await browser.platform.page.call(tab.id, 0, (q(query, "target") as never) ?? "__cineon", method, args));
      }
      return show(await deps.evalInPage(tab.id, 0, q(query, "js") ?? ""));
    }

    case "mediaeval": {
      const tab = needTab(session);
      if (typeof tab === "string") return tab;
      const frameId = tab.mediaFrame?.frameId ?? 0;
      const js = q(query, "js");
      if (js != null) return show(await deps.evalInPage(tab.id, frameId, js));
      const args = JSON.parse(q(query, "args") ?? "[]") as unknown[];
      return show(await browser.evaluateInPlayer(tab, q(query, "method") ?? "state", ...args));
    }

    case "sitepref": {
      const host = q(query, "host");
      const change: { trackingOff?: boolean; shieldsOff?: boolean; allowPopups?: boolean; allowRedirects?: boolean } = {};
      for (const key of ["trackingOff", "shieldsOff", "allowPopups", "allowRedirects"] as const) {
        const value = flag(query, key);
        if (value != null) change[key] = value;
      }
      const prefs = { ...session.shields.prefsFor(host), ...change };
      await session.shieldsCtl.setSite(host ?? "", prefs);
      runtime.broadcastConfig();
      return "ok";
    }

    case "hibernate": {
      for (const tab of browser.tabs) {
        if (tab.active) continue;
        await session.tracker.tabNavigated(tab);
        tab.isHibernated = true;
        await browser.platform.tabs.discard(tab.id).catch(() => undefined);
      }
      return "ok";
    }

    case "selecttab": {
      const tabs = browser.tabs.filter((t) => t.windowId === (browser.selected?.windowId ?? t.windowId));
      const tab = tabs[num(query, "i") ?? 0];
      if (tab) await browser.select(tab);
      return "ok";
    }

    case "closetab": {
      const tab = browser.selected;
      if (tab) await deps.removeTab(tab.id);
      return "ok";
    }

    case "settings": {
      const change: Record<string, unknown> = {};
      const map: [string, string][] = [
        ["ambient", "ambientLight"],
        ["metadata", "fetchMetadata"],
        ["frames", "keepFrames"],
        ["downloadButton", "showDownloadButton"],
        ["voiceBoost", "voiceBoost"],
        ["binWatched", "binWatchedDownloads"],
        ["playNext", "playNextDownload"],
        ["alerts", "newEpisodeAlerts"],
        ["cloud", "cloudBackup"],
        ["sharePet", "sharePet"],
        ["autoNext", "autoNextEpisode"],
        ["learnSkips", "learnSkips"],
        ["autoRescue", "autoRescue"],
        ["autoResume", "autoResume"],
        ["pauseOthers", "pauseOtherTabs"],
        ["popupShield", "popupShield"],
        ["redirectShield", "redirectShield"],
        ["sweeper", "overlaySweeper"],
        ["blocking", "networkBlocking"],
        ["history", "saveBrowsingHistory"],
      ];
      for (const [key, setting] of map) {
        const value = flag(query, key);
        if (value != null) change[setting] = value;
      }
      const minimum = num(query, "minimumSeconds");
      if (minimum != null) change.minimumSecondsToTrack = minimum;
      const finish = num(query, "finishThreshold");
      if (finish != null) change.finishThreshold = finish;
      const hibernate = num(query, "hibernateMinutes");
      if (hibernate != null) change.hibernateMinutes = hibernate;
      const captions = CaptionStyle.fromRaw(q(query, "captions"));
      if (captions) change.captionStyle = captions;
      if (Object.keys(change).length > 0) await session.updateSettings(change);
      return "ok";
    }

    case "resume": {
      const url = q(query, "url");
      if (!url) return "no url";
      const tab = await browser.openTab(url, { select: true, resumeAt: num(query, "at") });
      if (tab) tab.expectedResumeDuration = num(query, "expected");
      return `tab=${tab?.id ?? -1}\nend=1`;
    }

    case "keepwatching": {
      const url = q(query, "url");
      if (!url) return "no url";
      const tab = await browser.open(url, { resumeAt: num(query, "at"), keepWatching: true });
      return `tab=${tab?.id ?? -1}\nend=1`;
    }

    case "banner": {
      const tab = browser.selected;
      if (tab) await session.autopilot.handleBanner({ banner: q(query, "banner") ?? "", action: q(query, "action") ?? "" }, tab);
      return "ok";
    }

    case "removesites":
      for (const site of [...library.sites]) await library.removeSite(site.id);
      return "ok";

    case "deletesession": {
      const id = num(query, "id");
      if (id != null) await library.deleteSession(id);
      return "ok";
    }

    case "deletetitle": {
      const id = num(query, "id");
      if (id != null) await library.delete(id);
      return "ok";
    }

    case "addtitle": {
      const titleName = q(query, "name");
      if (!titleName) return "no name";
      const added = await library.addTitle(titleName, {
        year: num(query, "year"),
        kind: TitleKind.fromRaw(q(query, "kind")) ?? "film",
        status: TitleStatus.fromRaw(q(query, "status")) ?? "watched",
      });
      return `id=${added?.id ?? -1}\nend=1`;
    }

    case "rate": {
      const id = num(query, "id");
      if (id != null) await library.setRating(id, num(query, "halves"));
      return "ok";
    }

    case "download": {
      const tab = browser.selected;
      if (tab && session.downloads) await session.downloads.download(asDownloadTab(browser, tab));
      return "ok";
    }

    case "downloads": {
      const downloads = session.downloads;
      if (!downloads) return "no download center\nend=1";
      const tab = browser.selected;
      const rows = downloads.items.map((item) =>
        [
          "download",
          `id=${item.id}`,
          `status=${item.status}`,
          `kind=${item.kind}`,
          `name=${item.name}`,
          `bytes=${item.bytes}`,
          `total=${item.totalBytes}`,
          `fraction=${downloads.fraction(item)}`,
          `file=${item.file ?? "-"}`,
          `subtitles=${item.subtitles.length}`,
          `error=${item.error ?? "-"}`,
          `source=${item.sourceUrl}`,
          `title=${item.titleId ?? -1}`,
        ].join("\t"),
      );
      const sniffed = (tab?.sniffed ?? []).map((s) => `sniffed ${s.kind} frame=${s.frameId} ${s.url}`);
      return lines(
        `best=${tab ? (browser.bestSource(tab)?.url ?? "-") : "-"}`,
        `folder=${downloads.folder}`,
        ...(tab?.sources ?? []).map(sourceLine),
        ...sniffed,
        ...rows,
        "end=1",
      );
    }

    case "playdownload": {
      const id = num(query, "id");
      const item = id != null ? session.downloads?.item(id) : null;
      if (!item) return "no such download";
      return `message=${(await session.playDownloadMessage(item)) ?? "-"}\nend=1`;
    }

    case "season": {
      const tab = browser.selected;
      if (!tab || !session.seasons) return "no tab";
      const from = q(query, "from");
      if (from === "series") await session.seasons.startSeries(asDownloadTab(browser, tab));
      else await session.seasons.start(asDownloadTab(browser, tab), from === "current");
      return "ok";
    }
    case "seasoncancel":
      session.seasons?.cancel();
      return "ok";
    case "seasonconfirm":
      session.seasons?.confirm();
      return "ok";
    case "seasonresume":
      await session.seasons?.resume();
      return "ok";
    case "seasonstate": {
      const seasons = session.seasons;
      const job = seasons?.job ?? null;
      const proposal = seasons?.proposal ?? null;
      const labels = (refs: readonly EpisodeRef[] | undefined) => (refs ? refs.map(SeasonGrabber.shortLabel).join(",") : "-");
      return lines(
        `running=${seasons?.isRunning ?? false}`,
        `finished=${job?.isFinished ?? false}`,
        `looking=${seasons?.isLooking ?? false}`,
        `paused=${job?.isPaused ?? false}`,
        `scope=${job?.scope ?? "-"}`,
        `label=${job ? job.name : "-"}`,
        `proposal=${proposal ? labels(proposal.job.episodes) : "-"}`,
        `proposalBytes=${proposal ? proposal.bytesPerEpisode * proposal.job.episodes.length : 0}`,
        `proposalFits=${proposal ? proposal.freeBytes == null || proposal.bytesPerEpisode * proposal.job.episodes.length < proposal.freeBytes : false}`,
        `episodes=${labels(job?.episodes)}`,
        `queued=${labels(job?.queued)}`,
        `missed=${labels(job?.missed)}`,
        `current=${job?.current ? SeasonGrabber.shortLabel(job.current) : "-"}`,
        `helper=${runtime.registry.all().find((t) => t.isHelper)?.url ?? "-"}`,
        "end=1",
      );
    }

    case "sleep": {
      const mode = q(query, "mode");
      if (mode === "end") session.playback.start({ kind: "endOfItem" });
      else if (mode === "cancel") session.playback.cancel();
      else if (mode === "seconds") session.playback.startSeconds(num(query, "s") ?? 30);
      else session.playback.start({ kind: "minutes", minutes: num(query, "m") ?? 30 });
      return "ok";
    }
    case "sleepstate": {
      const timer = session.playback.sleepTimer;
      return lines(
        `active=${timer != null}`,
        `mode=${timer ? (timer.mode.kind === "minutes" ? `minutes(${timer.mode.minutes})` : "endOfItem") : "-"}`,
        `fading=${timer?.isFading ?? false}`,
        // The latest timer's fade, after the timer is done too (not in the Mac's output).
        `faded=${session.playback.lastTimerFaded}`,
        `remaining=${session.playback.remaining() ?? -1}`,
        "end=1",
      );
    }

    case "nowplaying": {
      const tab = session.playback.activeTab();
      const title = tab?.track ? library.titles.get(tab.track.titleId) : undefined;
      return lines(
        `title=${title?.name ?? tab?.parsed?.name ?? tab?.title ?? "-"}`,
        `playing=${tab?.media?.isPlaying ? 1 : 0}`,
        `position=${Math.trunc(tab?.media?.position ?? 0)}`,
        `duration=${Math.trunc(tab?.media?.duration ?? 0)}`,
        `tab=${tab?.id ?? -1}`,
        "end=1",
      );
    }

    case "remote": {
      const tab = session.playback.activeTab();
      const cmd = q(query, "cmd");
      if (cmd === "toggle") await session.playback.togglePlayback();
      else if (!tab) return "nothing playing";
      else if (cmd === "play") browser.play(tab);
      else if (cmd === "pause") browser.pausePlayback(tab);
      else if (cmd === "next") await session.playback.playNextEpisode();
      else if (cmd === "forward") browser.skip(tab, 10);
      else if (cmd === "back") browser.skip(tab, -10);
      else if (cmd === "seek") browser.seek(tab, num(query, "to") ?? 0);
      return "ok";
    }

    case "voiceboost": {
      const tab = browser.selected;
      const level = tab ? await browser.evaluateInPlayer(tab, "boostLevel") : null;
      const volume = tab ? await browser.evaluateInPlayer(tab, "volume") : null;
      return lines(`state=${tab?.boostState ?? "-"}`, `level=${typeof level === "number" ? level : -2}`, `volume=${typeof volume === "number" ? volume : -2}`, "end=1");
    }

    case "subs2": {
      const tab = browser.selected;
      if (!tab) return "no tab";
      if (flag(query, "clear")) {
        browser.clearSecondSubtitles(tab);
        return "ok";
      }
      const index = num(query, "index");
      const choice = index != null ? browser.subtitleChoices(tab)[index] : undefined;
      if (choice) await browser.showSecondSubtitles(tab, choice.url);
      return "ok";
    }
    case "subs2state": {
      const tab = browser.selected;
      const text = tab ? await browser.evaluateInPlayer(tab, "secondSubtitleText") : null;
      const choices = tab ? browser.subtitleChoices(tab).map((c) => `${c.label}|${c.url}`).join(",") : "";
      return lines(`track=${tab?.secondSubtitles?.label ?? "-"}`, `text=${typeof text === "string" ? text : "-"}`, `choices=${choices}`, "end=1");
    }

    case "fakeepisodes": {
      const id = num(query, "title");
      if (id == null) return "no title";
      const list = (q(query, "list") ?? "")
        .split(",")
        .filter((e) => e.length > 0)
        .flatMap((entry) => {
          const [numbers, released] = entry.split(":");
          const [season, episode] = (numbers ?? "").split("x").map(Number);
          if (!Number.isInteger(season) || !Number.isInteger(episode)) return [];
          const date = released ? Date.parse(`${released}T00:00:00Z`) : NaN;
          return [episodeInfo(season!, episode!, { released: Number.isFinite(date) ? date : null })];
        });
      session.metadata.testEpisodes.set(id, list);
      return "ok";
    }

    case "checknew": {
      await session.alerts.check(true);
      const alerts = [...session.alerts.alerts.values()].map((a) => `alert ${a.titleId} latest=${shortLabel(a.latest)} new=${a.newCount}`);
      return lines(...alerts, `fresh=${session.alerts.fresh.length}`, `notified=${session.alerts.lastNotificationForTests ?? "-"}`, "end=1");
    }

    case "cloud": {
      const cloud = session.cloud;
      if (!cloud) return "no cloud\nend=1";
      if (q(query, "do") === "sync") await cloud.sync();
      return lines(
        `lastSync=${cloud.lastSync != null ? cloud.lastSync / 1000 : "-"}`,
        `error=${cloud.lastError ?? "-"}`,
        `count=${cloud.cloudCount}`,
        `key=${session.together?.recoveryCode ?? "-"}`,
        "end=1",
      );
    }

    case "adopt": {
      const code = q(query, "code");
      if (!code || !session.together) return "adopted=false\nend=1";
      const ok = await session.together.adopt(code);
      if (ok) await session.cloud?.sync();
      return `adopted=${ok}\nend=1`;
    }

    case "stats": {
      const { stats, pet } = session.statsAndPet();
      return lines(
        `hours=${stats.estimatedHours}`,
        `tracked=${stats.trackedHours}`,
        `films=${stats.filmsWatched}`,
        `episodes=${stats.episodesFinished}`,
        `rated=${stats.rated}`,
        `average=${stats.averageRating ?? -1}`,
        `genre=${stats.favouriteGenre ?? "-"}`,
        `genres=${stats.genres
          .slice(0, 4)
          .map((g) => `${g.name}:${g.weight.toFixed(2)}`)
          .join(",")}`,
        `streak=${stats.currentStreak}`,
        `longest=${stats.longestStreak}`,
        `sessions=${stats.sessions}`,
        `pet=${pet.code}`,
        `species=${pet.speciesLabel}`,
        "end=1",
      );
    }

    case "together":
      return togetherCommand(session, query);

    case "moment": {
      const tab = browser.selected;
      if (tab) await session.frames.saveMoment(tab);
      return "ok";
    }

    case "frames": {
      const rows: string[] = [];
      for (const [sessionId, list] of library.framesBySession) {
        rows.push(`session=${sessionId} frames=${list.length} moments=${list.filter((f) => f.isMoment).length}`);
      }
      let moments = 0;
      for (const list of library.momentsByTitle.values()) moments += list.length;
      return lines(...rows, `moments=${moments}`, `capturing=${browser.selected?.frameState.isCapturing ?? false}`, "end=1");
    }

    case "findelsewhere": {
      const tab = browser.selected;
      if (tab) session.rescue.findElsewhere(tab);
      return "ok";
    }

    case "rescuetake": {
      const tab = browser.selected;
      const first = tab?.rescue?.options[0];
      if (tab && first) session.rescue.take(first, tab);
      return first ? "ok" : "no option";
    }

    case "stallseconds": {
      const tab = browser.selected;
      if (tab) browser.mediaCommand(tab, "setStallSeconds", num(query, "s") ?? 30);
      return "ok";
    }

    case "cinema": {
      const tab = browser.selected;
      if (!tab) return "no tab";
      return `theater=${await browser.setTheater(tab, !tab.isTheaterOn)}`;
    }

    case "route": {
      await deps.openCineon(q(query, "to"));
      return "ok";
    }

    case "detail": {
      await deps.openCineon(`library?title=${num(query, "id") ?? ""}`);
      return "ok";
    }

    case "seed":
      await seedDemo(session);
      return "ok";

    case "tabs":
      return lines(
        ...runtime.registry.all().map(
          (t) =>
            `tab id=${t.id} window=${t.windowId} active=${t.active} helper=${t.isHelper} probe=${t.isProbe} url=${t.url ?? "-"} track=${t.track?.titleId ?? -1} media=${t.media ? `${t.media.position}/${t.media.duration}:${t.media.isPlaying}` : "-"}`,
        ),
        "end=1",
      );

    default:
      return `unknown /${name}`;
  }
}

async function profileCommand(runtime: Runtime, name: string, query: DebugQuery): Promise<string> {
  const session = await runtime.ready();
  if (name === "addprofile") {
    const profile = await session.profiles.add(q(query, "name") ?? "Guest");
    runtime.deps.pages.post({ type: "profiles" });
    if (flag(query, "switch")) {
      await session.profiles.markUsed(profile.id);
      await runtime.switchProfile(profile.id);
    }
    return `id=${profile.id}\nend=1`;
  }
  const profile = session.profiles.profiles.find((p) => p.name === q(query, "name"));
  if (!profile) return "no such profile";
  await session.profiles.markUsed(profile.id);
  await runtime.switchProfile(profile.id);
  return "ok";
}

async function togetherCommand(session: ProfileSession, query: DebugQuery): Promise<string> {
  session.startTogether();
  const together = session.together;
  if (!together) return "no together\nend=1";
  const code = q(query, "code");
  if (code) await together.enter(code);
  const party = q(query, "party");
  if (party === "start") await together.startParty();
  if (party === "leave") await together.leaveParty();
  const react = q(query, "react");
  if (react) await together.react(react);
  const say = q(query, "say");
  if (say) await together.say(say);
  const challenge = num(query, "challenge");
  const challengeTitle = challenge != null ? session.library.titles.get(challenge) : undefined;
  if (challengeTitle) await together.createChallenge(challengeTitle);
  if (flag(query, "sharewatched")) await together.shareWatched();
  const addShared = num(query, "addshared");
  const card = addShared != null ? together.openedShares[0]?.titles[addShared] : undefined;
  if (card) await together.addToBacklog(card);
  if (flag(query, "refresh")) await together.refreshChallenges();
  if (!flag(query, "dump")) return "ok";
  const p = together.party;
  const rows = [
    `person=${together.personId ?? "-"}`,
    `party=${p ? `${p.code}|host=${p.hostName}|playing=${p.playing}|position=${PartyState.expectedPosition(p)}|members=${p.members.map((m) => m.name).join(",")}` : "-"}`,
    `isHost=${together.isHost}`,
    `partyTab=${partyTabId(together) ?? -1}`,
    `shareCode=${together.lastShareCode ?? "-"}`,
    `shares=${together.openedShares.map((s) => `${s.code}:${s.titles.map((t) => t.name).join(";")}`).join(",")}`,
    `messages=${p ? p.messages.map((m) => `${m.name}:${m.text}`).join("|") : "-"}`,
    `pets=${p ? p.members.map((m) => `${m.name}:${m.pet ?? "-"}`).join(",") : "-"}`,
  ];
  for (const summary of together.challenges) {
    const state = together.details.get(summary.code);
    const members = state ? state.members.map((m) => `${m.name}:${m.fraction}:${m.label}`).join(",") : "-";
    rows.push(`challenge=${summary.code}|${summary.title.name}|total=${Math.trunc(summary.totalEpisodes)}|winner=${state?.winnerName ?? "-"}|${members}`);
  }
  rows.push("end=1");
  return lines(...rows);
}

/** Fills a throwaway profile with titles (the Mac's /seed), without asking the catalogue. */
async function seedDemo(session: ProfileSession): Promise<void> {
  const library = session.library;
  const now = session.clock.now() / 1000;
  const items: [string, number, "film" | "series" | "cartoon", "watching" | "watched" | "backlog", string][] = [
    ["Dune: Part Two", 2024, "film", "watching", "tt15239678"],
    ["Severance", 2022, "series", "watching", "tt11280740"],
    ["Spirited Away", 2001, "cartoon", "watching", "tt0245429"],
    ["Oppenheimer", 2023, "film", "watched", "tt15398776"],
    ["Blade Runner 2049", 2017, "film", "watched", "tt1856101"],
    ["The Bear", 2022, "series", "watched", "tt14452776"],
    ["Parasite", 2019, "film", "watched", "tt6751668"],
    ["Arrival", 2016, "film", "backlog", "tt2543164"],
    ["Past Lives", 2023, "film", "backlog", "tt13238346"],
    ["Andor", 2022, "series", "backlog", "tt9253284"],
  ];
  for (const [index, [name, year, kind, status, imdbId]] of items.entries()) {
    const title = await library.addTitle(name, { year, kind, status, imdbId });
    if (!title || status === "backlog") continue;
    const duration = kind === "series" ? 3100 : 8700;
    const ref = kind === "series" ? EpisodeRef.make(2, index + 1) : EpisodeRef.none;
    const host = ["flixhub.example", "kino.example", "uaserial.example"][index % 3]!;
    const url = `https://${host}/watch/${name.toLowerCase().replaceAll(" ", "-")}`;
    const position = status === "watched" ? duration : duration * [0.36, 0.62, 0.18][index % 3]!;
    const at = now - index * 40000 - 3000;
    await library.saveProgress(
      WatchProgress.make({ titleId: title.id, ref, urlKey: UrlKey.make(url), url, host, position, duration, finished: status === "watched", updatedAt: at }),
    );
    await library.saveSession(
      WatchSession.make({
        titleId: title.id,
        ref,
        url,
        host,
        startedAt: at - position,
        endedAt: at,
        watchedSeconds: position,
        startPosition: 0,
        endPosition: position,
        duration,
        finished: status === "watched",
      }),
    );
  }
}

/** Installs the hooks: a message listener for extension pages and `self.cineonDebug` for the worker. */
export function installDebug(deps: DebugDeps): void {
  (globalThis as unknown as { cineonDebug?: unknown }).cineonDebug = {
    run: (type: string, query: DebugQuery = {}) => runDebug(deps, type, query),
    runtime: deps.runtime,
  };
  chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
    const m = message as { kind?: unknown; type?: unknown } | null;
    if (!m || m.kind !== DEBUG_MESSAGE || typeof m.type !== "string") return undefined;
    // Only the extension's own pages, never a content script.
    if (sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(""))) return undefined;
    const { kind: _kind, type, ...query } = m as Record<string, unknown>;
    runDebug(deps, String(type), query as DebugQuery).then(
      (value) => reply({ ok: true, value }),
      (error: unknown) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  });
}
