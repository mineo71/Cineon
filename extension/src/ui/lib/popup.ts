// What the toolbar popup and the side panel show, worked out from the background's answers.
// Pure, tested in test/ui/popup.test.ts.

import { DomainName, EpisodeRef, ShieldStats, SitePrefs, Timecode, type WatchProgress } from "../../core/data";
import type { AddFromTabResult, MediaSnapshot, TabSnapshot } from "../../shared/messages";
import { RefText, isVisitOnly } from "./format";

/** The parts of a browser tab the popup reads before the background answers. */
export interface BrowserTabInfo {
  readonly id: number | null;
  readonly windowId: number | null;
  readonly url: string | null;
  readonly title: string;
}

const RESTRICTED_SCHEMES = ["chrome:", "chrome-extension:", "chrome-search:", "chrome-untrusted:", "edge:", "about:", "moz-extension:", "view-source:", "devtools:", "resource:", "data:", "javascript:", "file:"];

/** Store pages extensions may not touch. */
const RESTRICTED_PAGES: readonly [string, string][] = [
  ["chromewebstore.google.com", "/"],
  ["chrome.google.com", "/webstore"],
  ["microsoftedge.microsoft.com", "/addons"],
  ["addons.mozilla.org", "/"],
];

/** Pages the browser keeps Cineon out of: its own pages, stores, local files, or no address at all. */
export function isRestrictedUrl(url: string | null | undefined): boolean {
  if (!url) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (RESTRICTED_SCHEMES.includes(parsed.protocol)) return true;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
  return RESTRICTED_PAGES.some(([host, path]) => parsed.hostname === host && parsed.pathname.startsWith(path));
}

export type PopupView =
  /** The browser's own page, a store, or no tab: nothing Cineon can do here. */
  | { readonly kind: "restricted" }
  /** Asked, not answered yet. */
  | { readonly kind: "loading"; readonly host: string | null; readonly title: string }
  /** The background didn't answer: what the browser says about the tab, and fallbacks. */
  | { readonly kind: "offline"; readonly host: string | null; readonly title: string }
  /** The background's view of the tab. */
  | { readonly kind: "page"; readonly tab: TabSnapshot };

/**
 * What the popup shows. `answer` is undefined until asked, null when the background didn't answer
 * (or knows nothing of the tab).
 */
export function popupView(tab: BrowserTabInfo | null, answer: { tab: TabSnapshot | null } | null | undefined): PopupView {
  if (!tab || tab.id == null || isRestrictedUrl(tab.url)) return { kind: "restricted" };
  const host = hostName(tab.url);
  if (answer === undefined) return { kind: "loading", host, title: tab.title };
  if (answer === null || answer.tab === null) return { kind: "offline", host, title: tab.title };
  return { kind: "page", tab: answer.tab };
}

function hostName(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** "12:03 / 45:00". */
export function timeLine(media: MediaSnapshot): string {
  return `${Timecode.string(media.position)} / ${Timecode.string(media.duration)}`;
}

/** How far through, 0 to 1. */
export function mediaFraction(media: MediaSnapshot | null | undefined): number {
  if (!media || media.duration <= 0) return 0;
  return Math.min(1, Math.max(0, media.position / media.duration));
}

/** The key shield preferences are kept under: the registrable domain (ShieldState.key). */
export function prefsKey(host: string | null | undefined): string {
  return DomainName.registrable(host ?? "");
}

/** The site's preferences with shields switched on or off. */
export function withShields(prefs: SitePrefs | null, host: string, on: boolean): SitePrefs {
  const base = prefs ?? SitePrefs.make(prefsKey(host));
  return { ...base, host: base.host || prefsKey(host), shieldsOff: !on };
}

/** The shields line: "Nothing blocked on this page yet", "12 blocked on this page", or that they're off. */
export function shieldsLine(blocked: ShieldStats | null, shieldsOn: boolean): string {
  if (!shieldsOn) return "Shields are off on this site";
  const total = blocked ? ShieldStats.total(blocked) : 0;
  if (total === 0) return "Nothing blocked on this page yet";
  return `${total} blocked on this page`;
}

/** The breakdown under it, as the Mac's shield popover lists it. Empty parts are left out. */
export function shieldsBreakdown(blocked: ShieldStats | null): string {
  if (!blocked) return "";
  const parts: string[] = [];
  if (blocked.ads > 0) parts.push(`${blocked.ads} ${blocked.ads === 1 ? "ad or tracker" : "ads and trackers"}`);
  if (blocked.popups > 0) parts.push(`${blocked.popups} ${blocked.popups === 1 ? "pop-up" : "pop-ups"}`);
  if (blocked.redirects > 0) parts.push(`${blocked.redirects} ${blocked.redirects === 1 ? "redirect" : "redirects"}`);
  if (blocked.overlays > 0) parts.push(`${blocked.overlays} ${blocked.overlays === 1 ? "click trap" : "click traps"}`);
  return parts.join(", ");
}

export type AddOutcome =
  /** Show this sentence. */
  | { readonly kind: "message"; readonly text: string }
  /** Open the Cineon page at this hash (the Add sheet). */
  | { readonly kind: "open"; readonly hash: string };

/** What "Add to backlog" leads to: the background's message, or the Add sheet with what's known. */
export function addOutcome(answer: AddFromTabResult | null, tabTitle: string): AddOutcome {
  if (answer?.kind === "done") return { kind: "message", text: answer.message };
  const query = answer?.kind === "needsName" ? answer.query : tabTitle.trim();
  return { kind: "open", hash: `#library?add=${encodeURIComponent(query)}` };
}

/** `#library?title=12`. */
export function titleHash(titleId: number): string {
  return `#library?title=${titleId}`;
}

/** `#library?relink=34`: the Cineon page opens "What's playing here?" for that tab. */
export function relinkHash(tabId: number): string {
  return `#library?relink=${tabId}`;
}

/** Continue watching rows: the episode, "42 min left", or where it was opened. */
export function continueDetail(progress: WatchProgress): string {
  if (EpisodeRef.isEpisode(progress.ref)) return RefText.short(progress.ref);
  if (isVisitOnly(progress)) return `Opened on ${DomainName.registrable(progress.host)}`;
  return `${Timecode.spoken(Math.max(0, progress.duration - progress.position))} left`;
}

/** The quick-rating card's count: "3 waiting", "1 waiting". */
export function waitingText(remaining: number): string {
  return `${remaining} waiting`;
}
