// What pages are told (shared/messages.ts snapshots), made from the background's state.

import { DomainName, DownloadItem, SitePrefs } from "../core/data";
import type { DownloadCenter, SeasonGrabber } from "../core/downloads";
import { SeasonJob, SeasonProposal } from "../core/downloads";
import type { CloudLibrary, TogetherModel } from "../core/together";
import type { Title } from "../core/data";
import type {
  DownloadsSnapshot,
  SeasonJobSnapshot,
  SeriesProposalSnapshot,
  TabSnapshot,
  TogetherSnapshot,
} from "../shared/messages";
import type { Browser } from "./browser";
import type { SessionShields } from "./shieldsBridge";
import { hostOf } from "./env";
import { TabState } from "./tabState";

export function tabSnapshot(tab: TabState, browser: Browser, shields: SessionShields | null): TabSnapshot {
  const host = hostOf(tab.url);
  const prefs = shields?.state.prefsFor(host) ?? null;
  const parsed = tab.parsed;
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url,
    host,
    title: TabState.displayTitle(tab, DomainName.displayName),
    favIconUrl: tab.favIconUrl,
    parsed: parsed
      ? { name: parsed.name, altName: parsed.altName, year: parsed.year, ref: parsed.ref, kindHint: parsed.kindHint, posterUrl: parsed.posterUrl }
      : null,
    linkedTitleId: tab.track?.titleId ?? tab.linkedTitleId,
    ref: TabState.episodeRef(tab),
    media: tab.media ? { ...tab.media } : null,
    canDownload: TabState.bestSource(tab) != null,
    hasNextEpisode: browser.hasNextEpisode(tab),
    blocked: { ...tab.blocked },
    sitePrefs: prefs ? SitePrefs.make(prefs.host, prefs) : SitePrefs.make(host ?? ""),
    voiceBoost: tab.boostState,
  };
}

function jobSnapshot(job: SeasonJob): SeasonJobSnapshot {
  return {
    name: job.name,
    label: SeasonJob.label(job),
    posterUrl: job.posterUrl,
    episodes: job.episodes,
    handled: SeasonJob.handled(job),
    queued: job.queued,
    missed: job.missed,
    remaining: SeasonJob.remaining(job),
    current: job.current,
    isFinished: job.isFinished,
    isPaused: job.isPaused,
  };
}

function proposalSnapshot(proposal: SeasonProposal): SeriesProposalSnapshot {
  return {
    name: proposal.job.name,
    posterUrl: proposal.job.posterUrl,
    episodes: proposal.job.episodes.length,
    seasonCounts: SeasonProposal.seasonCounts(proposal),
    totalBytes: SeasonProposal.totalBytes(proposal),
    isMeasured: proposal.isMeasured,
    freeBytes: proposal.freeBytes,
    fits: SeasonProposal.fits(proposal),
  };
}

export function downloadsSnapshot(downloads: DownloadCenter | null, seasons: SeasonGrabber | null): DownloadsSnapshot {
  const items = (downloads?.items ?? []).map((item) => {
    if (!downloads || item.status !== "downloading" || item.totalBytes <= 0) return item;
    const live = Math.round(downloads.fraction(item) * item.totalBytes);
    return live > item.bytes ? { ...item, bytes: live } : item;
  });
  return {
    items,
    job: seasons?.job ? jobSnapshot(seasons.job) : null,
    proposal: seasons?.proposal ? proposalSnapshot(seasons.proposal) : null,
    isBusy: seasons?.isBusy ?? false,
  };
}

export function togetherSnapshot(
  model: TogetherModel<Title> | null,
  cloud: CloudLibrary<Title> | null,
  partyTabId: number | null,
  fallbackName: string,
): TogetherSnapshot {
  const details: Record<string, import("../core/together").ChallengeState> = {};
  for (const [code, state] of model?.details ?? []) details[code] = state;
  return {
    isAvailable: model?.isAvailable ?? false,
    isWorking: model?.isWorking ?? false,
    personId: model?.personId ?? null,
    myName: model?.myName ?? fallbackName,
    party: model?.party ?? null,
    isHost: model?.isHost ?? false,
    partyTabId,
    challenges: model?.challenges ?? [],
    details,
    openedShares: model?.openedShares ?? [],
    lastShareCode: model?.lastShareCode ?? null,
    recoveryCode: model?.recoveryCode ?? "",
    cloud: {
      lastSync: cloud?.lastSync ?? null,
      isSyncing: cloud?.isSyncing ?? false,
      lastError: cloud?.lastError ?? null,
      cloudCount: cloud?.cloudCount ?? 0,
    },
  };
}

/** The download's live fraction, for debug output. */
export function downloadFraction(downloads: DownloadCenter, item: DownloadItem): number {
  return downloads.fraction(item);
}
