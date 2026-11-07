// Port of Browser/Rescue.swift (SiteProbe, RescueSession, RescueEngine, RescueProbe), checked against
// windows/Cineon.App/Browser/Rescue.cs. Keeps a film going when the place it was playing stops
// working: first the site's other addresses, then the person's other sites, picking up from the same
// second.
//
// What changes in a browser extension:
// - SiteProbe is a `fetch` without cookies (the Mac's ephemeral URLSession).
// - A site's search results are read first with `fetch` and a small HTML link reader (the service
//   worker has no DOMParser); only when that finds nothing sure (results drawn by script) does a
//   hidden probe tab load the page, in one small unfocused window shared by all probes, where the
//   content script's `__cineonContent.links()` harvests the links (the Mac's windowless web view).
// - There's no rescue panel beside the page: a live page shows the search in media.js's banner over
//   the player (banner ids starting with "rescue-"); a page that failed to load shows the browser's
//   error page, where no content script runs, so the search goes to a notification instead.
// - Searches don't survive the service worker stopping; `settleRestoredRescue` marks such a search
//   finished when the worker wakes, keeping whatever options it had found.

import { DomainName, EpisodeRef, Site, Timecode, UrlKey } from "../core/data";
import { RescueMatcher, type RescueLink, type RescueMatch, SkipLearner, SwiftUrl } from "../core/parsing";
import { longLabel } from "./autopilot";
import type { BannerOptions } from "./browser";
import type { ProbeResult, SessionContext, SiteProber } from "./context";
import { detach, hostOf } from "./env";
import type { BrowserTabInfo, Platform } from "./platform";
import {
  type MediaEvent,
  type RescueOption,
  RescueReason,
  RescueState,
  type TabState,
} from "./tabState";

const SAFARI_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

// MARK: SiteProbe

/** Asks whether a page exists, without opening it (fetch, no cookies). */
export class FetchSiteProbe implements SiteProber {
  /** The whole request, headers included (URLSession's resource timeout on the Mac). */
  static readonly timeoutMs = 9000;

  constructor(
    private readonly fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
    private readonly timeoutMs = FetchSiteProbe.timeoutMs,
  ) {}

  async check(url: string, signal?: AbortSignal): Promise<ProbeResult> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, this.timeoutMs);
    try {
      if (signal?.aborted) return { kind: "dead" };
      const response = await this.fetchImpl(url, {
        credentials: "omit",
        redirect: "follow",
        cache: "no-store",
        signal: controller.signal,
        headers: { "User-Agent": SAFARI_AGENT },
      });
      // Only the answer matters, never the page itself.
      response.body?.cancel().catch(() => undefined);
      return FetchSiteProbe.judge(response.status, response.url || url, response.headers.get("server"));
    } catch {
      return { kind: "dead" };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  /** The Mac's reading of a status. */
  static judge(status: number, finalUrl: string, server: string | null): ProbeResult {
    if (status >= 200 && status < 400) return { kind: "alive", url: finalUrl };
    if (status === 404 || status === 410) return { kind: "missing" };
    if (status === 403 || status === 429 || status === 503) {
      // A bot check means someone's home. The browser can get past it, this request can't.
      return server?.toLowerCase().includes("cloudflare") ? { kind: "alive", url: finalUrl } : { kind: "dead" };
    }
    return { kind: "dead" };
  }
}

// MARK: Reading links out of HTML

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  if (!match) return null;
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? "");
}

/** The text a run of HTML shows: tags, scripts and styles out, entities decoded. */
function textOf(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]*>/g, " "),
  );
}

const CARD_OPEN = /<(article|li)\b[^>]*>|<([a-z][a-z0-9]*)\b[^>]*\sclass\s*=\s*(?:"[^"]*(?:card|item|movie|film)[^"]*"|'[^']*(?:card|item|movie|film)[^']*')[^>]*>/gi;

/**
 * Every link in a page with the words that describe it, as the Mac's harvest script reads them from
 * a live page: the link's text, title, aria-label and its image's alt and title; and the words of the
 * card around it (an article, a list item, or an element whose class says card, item, movie or film),
 * where sites keep the year. At most 500, http(s) only, each address once.
 */
export function extractLinks(html: string, baseUrl: string): RescueLink[] {
  const out: RescueLink[] = [];
  const seen = new Set<string>();
  // Where each card-like element opens, to find the one around a link.
  const cards: { at: number; end: number; tag: string }[] = [];
  CARD_OPEN.lastIndex = 0;
  for (let m = CARD_OPEN.exec(html); m; m = CARD_OPEN.exec(html)) {
    cards.push({ at: m.index, end: m.index + m[0].length, tag: (m[1] ?? m[2] ?? "").toLowerCase() });
  }
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  for (let m = anchor.exec(html); m && out.length < 500; m = anchor.exec(html)) {
    const tag = ` ${m[1]}`;
    const inner = m[2] ?? "";
    const rawHref = attribute(tag, "href");
    if (!rawHref) continue;
    let href: string;
    try {
      href = new URL(rawHref.trim(), baseUrl).href;
    } catch {
      continue;
    }
    if (!/^https?:/i.test(href) || seen.has(href)) continue;
    seen.add(href);
    const url = SwiftUrl.string(href);
    if (!url) continue;
    const image = /<img\b([^>]*)>/i.exec(inner);
    const imageTag = image ? ` ${image[1]}` : null;
    const words = [
      textOf(inner),
      attribute(tag, "title"),
      attribute(tag, "aria-label"),
      imageTag ? attribute(imageTag, "alt") : null,
      imageTag ? attribute(imageTag, "title") : null,
    ];
    const text = words
      .filter((w): w is string => w != null && w.trim().length > 0)
      .join("\n")
      .replace(/[ \t]+/g, " ")
      .trim()
      .slice(0, 300);
    out.push({ url, text, context: cardText(html, cards, m.index, m.index + m[0].length) });
  }
  return out;
}

/** The words of the nearest card-like element opened before the link, up to where it closes. */
function cardText(html: string, cards: readonly { at: number; end: number; tag: string }[], start: number, end: number): string {
  let card: { at: number; end: number; tag: string } | null = null;
  for (let i = cards.length - 1; i >= 0; i--) {
    const c = cards[i]!;
    if (c.at > start) continue;
    if (start - c.at > 4000) break;
    card = c;
    break;
  }
  if (!card) return "";
  // A closed card that ended before the link isn't around it.
  const closing = new RegExp(`</${card.tag}\\s*>`, "gi");
  closing.lastIndex = card.end;
  const closedAt = closing.exec(html);
  if (closedAt && closedAt.index < start) return "";
  const stop = closedAt ? closedAt.index : Math.min(html.length, end + 600);
  return textOf(html.slice(card.end, Math.min(stop, end + 2000)))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

// MARK: The engine

/** What was being watched, worked out from what the tab and the library know. */
export interface RescueContext {
  titleId: number | null;
  names: string[];
  year: number | null;
  ref: EpisodeRef;
  position: number | null;
  duration: number | null;
}

interface Search {
  readonly id: string;
  readonly controller: AbortController;
  readonly probes: Set<number>;
  countdown: (() => void) | null;
}

export interface RescueEngineOptions {
  /** For reading search results (the global fetch by default). */
  fetch?: typeof fetch;
}

/** A search the last worker left running can't carry on: what it found stays, finished. */
export function settleRestoredRescue(tab: TabState): boolean {
  const rescue = tab.rescue;
  if (!rescue || rescue.stage === "finished") return false;
  rescue.stage = "finished";
  rescue.countdown = null;
  return true;
}

export class RescueEngine {
  static readonly concurrentSites = 3;
  static readonly maxSites = 8;
  static readonly countdownSeconds = 5;

  private readonly searches = new Map<number, Search>();
  /** Pages where someone already said to leave it alone. */
  private readonly declined = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  /** The last banner or notification shown per tab, so an unchanged one isn't shown again. */
  private readonly shown = new Map<number, string>();
  private helperWindowId: number | null = null;
  private helperWindow: Promise<void> | null = null;
  private readonly probeTabs = new Set<number>();
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly ctx: SessionContext,
    private readonly platform: Platform,
    options: RescueEngineOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  private get settings() {
    return this.ctx.settings;
  }

  private get library() {
    return this.ctx.library;
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => undefined);
    return promise;
  }

  private run(work: Promise<unknown>): void {
    detach(this.track(work));
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const cancel = this.ctx.clock.schedule(ms, () => {
        signal?.removeEventListener("abort", stop);
        resolve();
      });
      const stop = () => {
        cancel();
        resolve();
      };
      signal?.addEventListener("abort", stop, { once: true });
    });
  }

  // MARK: What can go wrong

  pageFailed(tab: TabState, url: string | null): void {
    if (!this.settings.autoRescue) return;
    this.begin(tab, "pageFailed", url);
  }

  pageMissing(tab: TabState, url: string | null): void {
    if (!this.settings.autoRescue) return;
    this.begin(tab, "pageMissing", url);
  }

  /**
   * The video failed or stalled. The Mac starts a search beside the page, or, when the video fills
   * the screen and nothing can be drawn over it from outside, asks from inside the player. The
   * background can't tell whether the video is fullscreen and has no panel beside the page anyway,
   * so it always asks from inside the player: the banner's button starts the search
   * (EpisodeAutopilot routes `rescue`/`find` to `findElsewhere`).
   */
  videoTrouble(event: MediaEvent, tab: TabState): void {
    if (!this.settings.autoRescue || tab.rescue != null || this.ctx.browser.selected?.id !== tab.id) return;
    this.ctx.browser.showBanner(tab, {
      id: "rescue",
      text: event.type === "stalled" ? "This video is stuck." : "This video stopped.",
      actions: [{ id: "find", label: "Find another source", primary: true }],
      timeout: 20,
    });
  }

  /** It sorted itself out, so the offer is no longer needed. */
  videoRecovered(tab: TabState): void {
    if (tab.banner?.id === "rescue") this.ctx.browser.clearBanner(tab, "rescue");
    const rescue = tab.rescue;
    if (!rescue || (rescue.reason !== "videoStalled" && rescue.reason !== "videoFailed")) return;
    this.stop(tab);
  }

  /** "Not here. Find it somewhere else." */
  findElsewhere(tab: TabState): void {
    this.stop(tab);
    this.run(this.findElsewhereNow(tab));
  }

  /** `findElsewhere`, finishing once the search has started (or was refused). */
  async findElsewhereNow(tab: TabState): Promise<void> {
    const url = tab.url;
    const context = await this.context(tab, url);
    if (!context) {
      this.ctx.toasts.show("Play something first, so Cineon knows what to look for", { tab });
      return;
    }
    if (tab.rescue != null) return;
    this.start(context, "manual", tab, url);
  }

  /** Looks for a page that failed to load, when asked to (the failure page's button). */
  tryFailedPageSearch(tab: TabState, url: string | null): void {
    this.run(
      (async () => {
        const context = await this.context(tab, url);
        if (context && tab.rescue == null) this.start(context, "pageFailed", tab, url);
      })(),
    );
  }

  /**
   * Whether there's something to look for, from what's known without the database: the film being
   * tracked at this address, or what this page said it is. `canSearchAsync` also asks the database.
   */
  canSearch(tab: TabState, url: string | null): boolean {
    const key = url ? UrlKey.make(url) : null;
    if (tab.track && key === tab.track.urlKey && this.library.titles.has(tab.track.titleId)) return true;
    if (tab.linkedTitleId != null && this.library.titles.has(tab.linkedTitleId)) return true;
    return this.pageNames(tab, url) != null;
  }

  async canSearchAsync(tab: TabState, url: string | null): Promise<boolean> {
    return (await this.context(tab, url)) != null;
  }

  private begin(tab: TabState, reason: RescueReason, url: string | null): void {
    if (tab.rescue != null || !url || this.declined.has(UrlKey.make(url)) || this.searches.has(tab.id)) return;
    // Held until the context is known, so a second report can't start a second search.
    const search: Search = { id: crypto.randomUUID(), controller: new AbortController(), probes: new Set(), countdown: null };
    this.searches.set(tab.id, search);
    this.run(
      (async () => {
        const context = await this.context(tab, url);
        if (this.searches.get(tab.id) !== search) return;
        this.searches.delete(tab.id);
        if (!context || tab.rescue != null) return;
        this.start(context, reason, tab, url);
      })(),
    );
  }

  // MARK: What was being watched

  /** Names the page itself gave, when they were read from this address. */
  private pageNames(tab: TabState, url: string | null): string[] | null {
    const meta = tab.pageMeta;
    const parsed = tab.parsed;
    if (!meta || !parsed || !url || UrlKey.make(meta.url) !== UrlKey.make(url)) return null;
    return [parsed.name, parsed.altName].filter((n): n is string => n != null && n.length > 0);
  }

  /**
   * Worked out from records of this exact address, because a tab that failed to load still holds
   * what it knew about the page before.
   */
  async context(tab: TabState, url: string | null): Promise<RescueContext | null> {
    let titleId: number | null = null;
    let ref: EpisodeRef = EpisodeRef.none;
    let position: number | null = null;
    let duration: number | null = null;

    const track = tab.track;
    if (track && url != null && UrlKey.make(url) === track.urlKey) {
      titleId = track.titleId;
      ref = track.ref;
      position = tab.media?.position ?? null;
      duration = tab.media?.duration ?? null;
    } else if (url != null) {
      const key = UrlKey.make(url);
      const saved = await this.ctx.db.progress(key).catch(() => null);
      if (saved) {
        titleId = saved.titleId;
        ref = saved.ref;
        if (saved.duration > 0 && !saved.finished) {
          position = saved.position;
          duration = saved.duration;
        }
      } else {
        const past = await this.ctx.db.latestSession(url).catch(() => null);
        if (past) {
          titleId = past.titleId;
          ref = past.ref;
          if (past.duration > 0 && !past.finished) {
            position = past.endPosition;
            duration = past.duration;
          }
        } else {
          const link = await this.ctx.db.link(key).catch(() => null);
          if (link) {
            titleId = link.titleId;
            ref = link.ref;
          }
        }
      }
    }
    if (tab.pendingResume != null) position = tab.pendingResume;

    const names: string[] = [];
    let year: number | null = null;
    const title = titleId != null ? this.library.titles.get(titleId) : undefined;
    if (title) {
      names.push(title.name);
      year = title.year;
    }
    // What the page called itself is only about this page if it was read from this address.
    const fromPage = this.pageNames(tab, url);
    if (fromPage && tab.parsed) {
      for (const name of fromPage) if (!names.includes(name)) names.push(name);
      year = year ?? tab.parsed.year;
      if (!EpisodeRef.isEpisode(ref)) ref = tab.parsed.ref;
    }
    if (names.length === 0) return null;
    return { titleId, names, year, ref, position, duration };
  }

  // MARK: Looking

  private start(context: RescueContext, reason: RescueReason, tab: TabState, url: string | null): void {
    const host = hostOf(url);
    const search: Search = { id: crypto.randomUUID(), controller: new AbortController(), probes: new Set(), countdown: null };
    const rescue: RescueState = {
      id: search.id,
      reason,
      host: host ? DomainName.registrable(host) : "This site",
      titleId: context.titleId,
      name: context.names[0]!,
      names: context.names,
      year: context.year,
      ref: context.ref,
      position: context.position,
      duration: context.duration,
      stage: "mirrors",
      mirrorsTotal: 0,
      sitesTotal: 0,
      sitesDone: 0,
      options: [],
      countdown: null,
      isAbandoned: false,
      isStaying: false,
    };
    this.searches.set(tab.id, search);
    tab.rescue = rescue;
    this.present(tab);
    const signal = search.controller.signal;
    this.run(
      (async () => {
        try {
          if (RescueReason.triesMirrors(reason) && url && (await this.tryMirrors(url, rescue, tab, signal))) return;
          if (signal.aborted) return;
          await this.searchSites(rescue, tab, url, search);
        } finally {
          await this.closeProbes(search);
        }
      })(),
    );
  }

  private isCurrent(tab: TabState, rescue: RescueState): boolean {
    return !rescue.isAbandoned && tab.rescue?.id === rescue.id;
  }

  private async tryMirrors(url: string, rescue: RescueState, tab: TabState, signal: AbortSignal): Promise<boolean> {
    const hosts = await this.ctx.db.knownHosts().catch(() => [] as string[]);
    const siteHosts = this.library.sites.map((s) => s.host);
    const mirrors = RescueMatcher.mirrors(url, [...hosts, ...siteHosts]).slice(0, 8);
    rescue.mirrorsTotal = mirrors.length;
    this.present(tab);
    const failedKey = SkipLearner.siteKey(hostOf(url) ?? "");
    for (const mirror of mirrors) {
      if (signal.aborted) return false;
      const result = await this.ctx.probe.check(mirror, signal);
      if (signal.aborted || !this.isCurrent(tab, rescue)) return false;
      if (result.kind !== "alive") continue;
      // A dead domain that now redirects to a parking page isn't this site any more.
      if (SkipLearner.siteKey(hostOf(result.url) ?? "") !== failedKey) continue;
      await this.continueOnMirror(mirror, result.url, url, rescue, tab);
      return true;
    }
    return false;
  }

  private async continueOnMirror(mirror: string, final: string, url: string, rescue: RescueState, tab: TabState): Promise<void> {
    let target: string;
    if (hostOf(final) === hostOf(mirror)) {
      target = mirror;
    } else {
      // It redirected to its newest address. Keep the episode that's only in the fragment.
      try {
        const parts = new URL(final);
        parts.hash = new URL(mirror).hash;
        target = parts.href;
      } catch {
        target = final;
      }
    }
    const targetHost = hostOf(target) ?? "";
    const newHost = DomainName.registrable(targetHost);
    const site = this.library.siteForHost(hostOf(url));
    if (site) {
      let homeUrl = site.homeUrl;
      try {
        const home = new URL(target);
        homeUrl = `${home.protocol}//${home.host}/`;
      } catch {
        // Keep the old home page.
      }
      await this.library.updateSite({ ...site, host: (targetHost || newHost).replaceAll("www.", ""), homeUrl, searchTemplate: null });
    }
    this.finish(tab);
    tab.expectedResumeDuration = rescue.duration;
    await this.ctx.browser.loadToKeepWatching(tab, target, RescueState.resumePoint(rescue));
    this.ctx.toasts.show(`${rescue.host} is down. Continuing on ${newHost}.`, { tab });
  }

  /** The person's other sites, most recently used first, leaving out the one that failed. */
  candidateSites(excluding: string | null): Site[] {
    const failedHost = hostOf(excluding);
    const failed = failedHost ? SkipLearner.siteKey(failedHost) : null;
    return this.library.sites
      .filter((s) => SkipLearner.siteKey(s.host) !== failed)
      .map((s, i) => ({ s, i }))
      .sort((a, b) => (b.s.lastUsedAt ?? -Infinity) - (a.s.lastUsedAt ?? -Infinity) || a.i - b.i)
      .slice(0, RescueEngine.maxSites)
      .map(({ s }) => s);
  }

  private async searchSites(rescue: RescueState, tab: TabState, failedUrl: string | null, search: Search): Promise<void> {
    const signal = search.controller.signal;
    const sites = this.candidateSites(failedUrl);
    rescue.stage = "searching";
    rescue.sitesTotal = sites.length;
    this.present(tab);

    // A few at a time: each one may be a whole web page loading out of sight.
    for (let start = 0; start < sites.length; start += RescueEngine.concurrentSites) {
      if (signal.aborted) return;
      const batch = sites.slice(start, start + RescueEngine.concurrentSites);
      await Promise.all(
        batch.map(async (site) => {
          const option = await this.scan(site, rescue, search).catch(() => null);
          if (!this.isCurrent(tab, rescue)) return;
          rescue.sitesDone += 1;
          if (option) this.add(option, rescue, tab);
          else this.present(tab);
        }),
      );
    }
    if (signal.aborted || !this.isCurrent(tab, rescue)) return;
    rescue.stage = "finished";
    this.present(tab);
  }

  private async scan(original: Site, rescue: RescueState, search: Search): Promise<RescueOption | null> {
    const signal = search.controller.signal;
    let site = original;
    if (site.searchTemplate == null) {
      // Sites from an import haven't been visited here yet, so learn how they search now.
      const template = await this.withProbe(site.homeUrl, 10_000, search, (id) =>
        this.platform.page.call(id, 0, "__cineonMeta", "searchTemplate", []),
      );
      if (signal.aborted || rescue.isAbandoned || typeof template !== "string" || template.length === 0) return null;
      site = { ...site, searchTemplate: template };
      await this.library.updateSite(site);
    }

    for (const name of rescue.names.slice(0, 2)) {
      if (signal.aborted || rescue.isAbandoned) return null;
      const url = Site.searchUrl(site, name);
      if (!url) return null;
      let best = await this.fetchMatch(url, rescue, signal);
      if (!best || !RescueMatcher.isStrong(best)) {
        // Many sites draw their results with script: read them from a page that ran it.
        const probed = await this.probeMatch(url, rescue, search);
        if (probed && (!best || RescueMatcher.isStrong(probed) || probed.score > best.score)) best = probed;
      }
      if (best) {
        const firstLine = best.link.text.split(/[\n\r\v\f\u0085\u2028\u2029]/)[0]?.trim() ?? "";
        return {
          siteName: site.name,
          siteIcon: site.iconUrl,
          url: best.link.url,
          label: firstLine.length > 0 ? firstLine : rescue.name,
          isStrong: RescueMatcher.isStrong(best) && !RescueMatcher.isVideoSharing(best.link.url),
          score: best.score,
        };
      }
    }
    return null;
  }

  /** The search page as the server sends it, read without running its scripts. */
  private async fetchMatch(url: string, rescue: RescueState, signal: AbortSignal): Promise<RescueMatch | null> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const cancel = this.ctx.clock.schedule(12_000, abort);
    try {
      const response = await this.fetchImpl(url, { credentials: "include", redirect: "follow", signal: controller.signal });
      if (!response.ok) {
        response.body?.cancel().catch(() => undefined);
        return null;
      }
      const type = response.headers.get("content-type") ?? "";
      if (type && !/html|xml|text\/plain/i.test(type)) {
        response.body?.cancel().catch(() => undefined);
        return null;
      }
      const html = (await response.text()).slice(0, 3_000_000);
      const pageUrl = response.url || url;
      return RescueMatcher.best(extractLinks(html, pageUrl), rescue.names, rescue.year, SwiftUrl.string(pageUrl) ?? pageUrl);
    } catch {
      return null;
    } finally {
      cancel();
      signal.removeEventListener("abort", abort);
    }
  }

  /** The search page in a hidden probe tab, read up to three times as results fill in. */
  private async probeMatch(url: string, rescue: RescueState, search: Search): Promise<RescueMatch | null> {
    const signal = search.controller.signal;
    return this.withProbe(url, 12_000, search, async (id) => {
      let best: RescueMatch | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (signal.aborted || rescue.isAbandoned) return null;
        const links = RescueEngine.linksFrom(await this.platform.page.call(id, 0, "__cineonContent", "links", []));
        const current = (await this.platform.tabs.get(id))?.url ?? url;
        best = RescueMatcher.best(links, rescue.names, rescue.year, SwiftUrl.string(current) ?? current);
        if (best && RescueMatcher.isStrong(best)) break;
        if (attempt < 2) await this.sleep(1200, signal);
      }
      return best;
    });
  }

  /** What `__cineonContent.links()` returns: `[{href, text, context}]`. */
  static linksFrom(value: unknown): RescueLink[] {
    if (!Array.isArray(value)) return [];
    const links: RescueLink[] = [];
    for (const row of value as { href?: unknown; text?: unknown; context?: unknown }[]) {
      if (typeof row?.href !== "string") continue;
      const url = SwiftUrl.string(row.href);
      if (!url) continue;
      links.push({ url, text: typeof row.text === "string" ? row.text : "", context: typeof row.context === "string" ? row.context : "" });
    }
    return links;
  }

  // MARK: Probe tabs

  /** Opens a probe tab, waits for its page, runs `read`, and closes the tab again. */
  private async withProbe<T>(url: string, timeoutMs: number, search: Search, read: (tabId: number) => Promise<T>): Promise<T | null> {
    const signal = search.controller.signal;
    if (signal.aborted) return null;
    const id = await this.openProbe(url);
    if (id == null) return null;
    search.probes.add(id);
    try {
      if (signal.aborted) return null;
      await this.waitForLoad(id, timeoutMs, signal);
      if (signal.aborted) return null;
      return await read(id);
    } catch {
      return null;
    } finally {
      search.probes.delete(id);
      await this.closeProbe(id);
    }
  }

  private async openProbe(url: string): Promise<number | null> {
    let info: BrowserTabInfo | null = null;
    if (this.helperWindowId == null && this.helperWindow) await this.helperWindow;
    if (this.helperWindowId != null) {
      info = await this.platform.tabs.create({ url, active: false, windowId: this.helperWindowId }).catch(() => null);
      // The window went (closed by hand, or with its last probe): start a new one.
      if (!info) this.helperWindowId = null;
    }
    if (!info) {
      let made: BrowserTabInfo | null = null;
      const opening = (async () => {
        made = await this.platform.tabs.createHelperWindow(url).catch(() => null);
        this.helperWindowId = made?.windowId ?? null;
      })();
      this.helperWindow = opening;
      await opening;
      if (this.helperWindow === opening) this.helperWindow = null;
      info = made;
    }
    if (!info) return null;
    const tab = this.ctx.browser.registry.ensure(info.id, info);
    tab.isProbe = true;
    tab.url = url;
    this.probeTabs.add(info.id);
    detach(this.platform.tabs.update(info.id, { muted: true, autoDiscardable: false }));
    return info.id;
  }

  private async waitForLoad(id: number, timeoutMs: number, signal: AbortSignal): Promise<void> {
    const deadline = this.ctx.clock.now() + timeoutMs;
    // Give the navigation a moment to start before trusting "complete".
    await this.sleep(300, signal);
    while (!signal.aborted && this.ctx.clock.now() < deadline) {
      const info = await this.platform.tabs.get(id).catch(() => null);
      if (!info || info.status === "complete") return;
      await this.sleep(300, signal);
    }
  }

  private async closeProbe(id: number): Promise<void> {
    if (!this.probeTabs.delete(id)) return;
    this.ctx.browser.registry.remove(id);
    // Closing the window's last tab closes the window.
    if (this.probeTabs.size === 0) this.helperWindowId = null;
    await this.platform.tabs.remove(id).catch(() => undefined);
  }

  private async closeProbes(search: Search): Promise<void> {
    const ids = [...search.probes];
    search.probes.clear();
    await Promise.all(ids.map((id) => this.closeProbe(id)));
  }

  // MARK: Options

  private add(option: RescueOption, rescue: RescueState, tab: TabState): void {
    rescue.options.push(option);
    rescue.options = RescueEngine.sorted(rescue.options);
    // Opening by itself is only safe for a film. A series page still needs an episode chosen.
    if (
      option.isStrong &&
      RescueReason.opensBySelf(rescue.reason) &&
      !EpisodeRef.isEpisode(rescue.ref) &&
      rescue.countdown == null &&
      !rescue.isStaying
    ) {
      this.startCountdown(rescue, tab);
      return;
    }
    this.present(tab);
  }

  /** Strong matches first, then by score; equals keep the order they were found in. */
  static sorted(options: readonly RescueOption[]): RescueOption[] {
    return options
      .map((o, i) => ({ o, i }))
      .sort((a, b) => Number(b.o.isStrong) - Number(a.o.isStrong) || b.o.score - a.o.score || a.i - b.i)
      .map(({ o }) => o);
  }

  private startCountdown(rescue: RescueState, tab: TabState): void {
    const search = this.searches.get(tab.id);
    rescue.countdown = RescueEngine.countdownSeconds;
    this.present(tab);
    let left = RescueEngine.countdownSeconds;
    const step = () => {
      if (!this.isCurrent(tab, rescue)) return;
      left -= 1;
      rescue.countdown = left;
      this.ctx.browser.changed(tab);
      if (left > 0) {
        if (search) search.countdown = this.ctx.clock.schedule(1000, step);
        return;
      }
      if (search) search.countdown = null;
      const best = rescue.options[0];
      if (best) this.take(best, tab);
    };
    const cancel = this.ctx.clock.schedule(1000, step);
    if (search) search.countdown = cancel;
  }

  // MARK: Decisions

  take(option: RescueOption, tab: TabState): void {
    this.run(this.takeNow(option, tab));
  }

  async takeNow(option: RescueOption, tab: TabState): Promise<void> {
    const rescue = tab.rescue;
    if (!rescue) return;
    this.finish(tab);
    const resume = RescueState.resumePoint(rescue);
    if (EpisodeRef.isEpisode(rescue.ref)) {
      // The result is the series' page. Once the episode is chosen, its saved place applies.
      await this.ctx.browser.load(tab, option.url);
      const place = resume != null ? ` and Cineon jumps to ${Timecode.string(resume)}` : "";
      this.ctx.toasts.show(`Opened ${option.siteName}. Choose ${longLabel(rescue.ref).toLowerCase()}${place}.`, { tab });
      return;
    }
    // This page is this film, whatever the site calls it.
    if (rescue.titleId != null) await this.ctx.db.setLink(UrlKey.make(option.url), rescue.titleId, rescue.ref).catch(() => undefined);
    tab.expectedResumeDuration = rescue.duration;
    await this.ctx.browser.loadToKeepWatching(tab, option.url, resume);
    const place = resume != null ? ` at ${Timecode.string(resume)}` : "";
    this.ctx.toasts.show(`Continuing on ${option.siteName}${place}`, { tab });
  }

  /** "Leave it." Stops looking, and doesn't ask again about this page. */
  dismiss(tab: TabState): void {
    if (tab.url) this.declined.add(UrlKey.make(tab.url));
    this.stop(tab);
  }

  /** "Stay here": the countdown stops, and a better match turning up later doesn't start another. */
  stopCountdown(tab: TabState): void {
    const search = this.searches.get(tab.id);
    search?.countdown?.();
    if (search) search.countdown = null;
    if (tab.rescue) {
      tab.rescue.countdown = null;
      tab.rescue.isStaying = true;
    }
    this.present(tab);
  }

  /** Stops without judging: the tab has simply moved on. */
  stop(tab: TabState): void {
    this.finish(tab);
  }

  private finish(tab: TabState): void {
    const search = this.searches.get(tab.id);
    if (search) {
      search.controller.abort();
      search.countdown?.();
      search.countdown = null;
      this.searches.delete(tab.id);
      detach(this.closeProbes(search));
    }
    const rescue = tab.rescue;
    if (!rescue) return;
    rescue.isAbandoned = true;
    tab.rescue = null;
    this.clearPresentation(tab);
    this.ctx.browser.changed(tab);
  }

  /** A rescue banner's button (`rescue-*` banners). */
  handleBanner(banner: string, action: string, tab: TabState): void {
    if (!banner.startsWith("rescue-")) return;
    if (tab.banner?.id === banner) tab.banner = null;
    this.shown.delete(tab.id);
    const rescue = tab.rescue;
    if (!rescue) return;
    const open = /^open-(\d+)$/.exec(action);
    if (open) {
      const option = rescue.options[Number(open[1])];
      if (option) this.take(option, tab);
    } else if (action === "leave") {
      this.dismiss(tab);
    } else if (action === "stay") {
      this.stopCountdown(tab);
    }
  }

  /** A tab closed or the profile closed: stop everything for it. */
  forget(tabId: number): void {
    const search = this.searches.get(tabId);
    if (search) {
      search.controller.abort();
      search.countdown?.();
      this.searches.delete(tabId);
      detach(this.closeProbes(search));
    }
    this.shown.delete(tabId);
    this.ctx.notifier.clear(`rescue-${tabId}`);
  }

  /** Waits for running searches (tests and debug). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  // MARK: Showing it

  /** A live page shows the search over its player; the browser's error page can't, so a notification does. */
  private usesBanner(tab: TabState, rescue: RescueState): boolean {
    return rescue.reason !== "pageFailed" && tab.failure == null;
  }

  /** The banner (or notification) for where the search has got to. */
  describe(rescue: RescueState): { text: string; options: RescueOption[]; banner: BannerOptions } {
    const options = rescue.options.slice(0, 2);
    const leave = { id: "leave", label: "Leave it", primary: false };
    if (options.length === 0) {
      if (rescue.stage === "finished") {
        const text =
          rescue.sitesTotal === 0
            ? "None of your other sites can be searched yet"
            : `Couldn't find ${rescue.name} on your other sites`;
        return { text, options, banner: { id: "rescue-search", text, actions: [], timeout: 6 } };
      }
      const text =
        rescue.stage === "mirrors"
          ? `Trying ${rescue.host}'s other addresses…`
          : `Looking for ${rescue.name} on your other sites… ${rescue.sitesDone} of ${rescue.sitesTotal}`;
      return { text, options, banner: { id: "rescue-search", text, actions: [leave] } };
    }
    const best = options[0]!;
    const found = best.isStrong ? `Found ${best.label} on ${best.siteName}` : `${best.label} on ${best.siteName} might be it`;
    if (rescue.countdown != null) {
      const text = `${found}. Opening it in ${RescueEngine.countdownSeconds} seconds`;
      return {
        text,
        options,
        banner: {
          id: "rescue-search",
          text: found,
          actions: [
            { id: "open-0", label: `Open on ${best.siteName}`, primary: true },
            { id: "stay", label: "Stay here", primary: false },
          ],
          seconds: rescue.countdown,
          onExpire: "open-0",
        },
      };
    }
    const actions = options.map((o, i) => ({ id: `open-${i}`, label: `Open on ${o.siteName}`, primary: i === 0 }));
    return { text: found, options, banner: { id: "rescue-search", text: found, actions: [...actions, leave] } };
  }

  private present(tab: TabState): void {
    const rescue = tab.rescue;
    this.ctx.browser.changed(tab);
    if (!rescue || rescue.isAbandoned) return;
    const { text, options, banner } = this.describe(rescue);
    if (this.usesBanner(tab, rescue)) {
      // The countdown runs in the page, so only its start shows a new banner.
      const key = `banner|${JSON.stringify({ ...banner, seconds: banner.seconds != null ? "on" : null })}`;
      if (this.shown.get(tab.id) === key) return;
      this.shown.set(tab.id, key);
      this.ctx.browser.showBanner(tab, banner);
      return;
    }
    const key = `note|${text}|${options.map((o) => o.url).join(",")}|${rescue.countdown != null}`;
    if (this.shown.get(tab.id) === key) return;
    this.shown.set(tab.id, key);
    const title =
      rescue.reason === "pageFailed"
        ? `${rescue.host} isn't answering`
        : rescue.reason === "pageMissing"
          ? `${rescue.name} is gone from ${rescue.host}`
          : `Finding ${rescue.name} elsewhere`;
    const best = options[0];
    const buttons = best ? [`Open on ${best.siteName}`, "Leave it"] : rescue.stage === "finished" ? [] : ["Leave it"];
    this.ctx.notifier.show(`rescue-${tab.id}`, {
      title,
      message: text,
      buttons,
      onClick: (button) => {
        const current = this.ctx.browser.registry.get(tab.id);
        if (!current) return;
        if (button === null) {
          detach(this.ctx.browser.select(current));
        } else if (best && button === 0) {
          if (current.rescue?.id === rescue.id) this.take(best, current);
        } else {
          this.dismiss(current);
        }
      },
    });
  }

  private clearPresentation(tab: TabState): void {
    const shown = this.shown.get(tab.id);
    this.shown.delete(tab.id);
    if (shown?.startsWith("banner|") && tab.banner?.id === "rescue-search") this.ctx.browser.clearBanner(tab, "rescue-search");
    if (shown?.startsWith("note|")) this.ctx.notifier.clear(`rescue-${tab.id}`);
  }
}
