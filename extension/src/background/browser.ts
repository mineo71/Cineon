// The Mac's BrowserModel and BrowserTab (Browser/BrowserModel.swift, BrowserTab.swift), for tabs the
// browser owns: what Cineon does with a tab (load, play, banners, captions, voice boost, the download
// button), what it hears from the page scripts (media.js, meta.js, shield.js) and from the browser's
// navigation events. State lives in TabState; the browser is driven through Platform.

import {
  CaptionStyle,
  DomainName,
  EpisodeRef,
  MediaSource,
  MediaSourceKind,
  ShieldStats,
  Site,
  UrlKey,
  VoiceBoostState,
} from "../core/data";
import { MediaUrls, SubtitleTrack } from "../core/downloads";
import { PageMeta, TitleParser } from "../core/parsing";
import { asDownloadTab } from "./downloadsBridge";
import type { SessionContext, ToastAction } from "./context";
import { detach, hostOf, isWebUrl, schemeOf } from "./env";
import type { Platform } from "./platform";
import { type FrameRef, MediaEvent, TabState } from "./tabState";
import type { TabRegistry } from "./tabs";
import { WatchTracker } from "./tracker";

export interface BannerAction {
  id: string;
  label: string;
  primary: boolean;
}

/** What media.js's `banner(options)` reads. */
export interface BannerOptions {
  id: string;
  text: string;
  actions?: BannerAction[];
  seconds?: number | null;
  onExpire?: string | null;
  timeout?: number | null;
}

/** Statuses that mean the film isn't here, leaving out those a bot check also uses. */
const GONE_STATUSES = new Set([404, 410, 451, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526]);

/** Error codes (net::ERR_…) that mean something replaced the load, not that it failed. */
const IGNORED_ERRORS = /ERR_ABORTED|NS_BINDING_ABORTED|ERR_BLOCKED_BY_CLIENT|ERR_BLOCKED_BY_RESPONSE/;

export class Browser {
  private readonly queues = new Map<number, Promise<void>>();
  private readonly toastActions = new Map<number, ToastAction>();

  constructor(
    private readonly ctx: SessionContext,
    readonly registry: TabRegistry,
    readonly platform: Platform,
  ) {}

  private get settings() {
    return this.ctx.settings;
  }

  private now(): number {
    return this.ctx.clock.now();
  }

  /** Something about a tab changed: signals and saving. */
  changed(tab: TabState): void {
    this.registry.touch(tab.id);
  }

  // MARK: Tabs (BrowserModel)

  get selected(): TabState | null {
    return this.registry.selected();
  }

  get tabs(): TabState[] {
    return this.registry.listed();
  }

  get playingTab(): TabState | null {
    return this.registry.playingTab();
  }

  tab(id: number | null | undefined): TabState | null {
    return this.registry.get(id);
  }

  /** A new tab, as BrowserModel.openTab. Null when the browser refused. */
  async openTab(
    url: string,
    options: { select?: boolean; resumeAt?: number | null; siteId?: number | null; keepWatching?: boolean; windowId?: number; openerTabId?: number } = {},
  ): Promise<TabState | null> {
    const select = options.select ?? true;
    const info = await this.platform.tabs.create({
      url,
      active: select,
      windowId: options.windowId,
      openerTabId: options.openerTabId,
    });
    if (!info) return null;
    const tab = this.registry.ensure(info.id, { ...info, url: null });
    tab.url = url;
    tab.originSiteId = options.siteId ?? this.ctx.library.siteForHost(hostOf(url))?.id ?? null;
    tab.pendingResume = options.resumeAt ?? null;
    tab.trustedNavigation = true;
    tab.lastHistoryKey = null;
    if (options.keepWatching) tab.autoplayKey = UrlKey.make(url);
    if (select && info.windowId != null) detach(this.platform.tabs.focusWindow(info.windowId));
    void this.noteSiteUsed(url);
    this.changed(tab);
    return tab;
  }

  /** Opens an address in a tab already showing that page, if there is one (BrowserModel.open). */
  async open(url: string, options: { resumeAt?: number | null; keepWatching?: boolean; active?: boolean } = {}): Promise<TabState | null> {
    const key = UrlKey.make(url);
    const existing = this.tabs.find((t) => t.url != null && UrlKey.make(t.url) === key);
    if (existing) {
      if (options.active ?? true) await this.select(existing);
      if (existing.media) {
        if (options.resumeAt != null) this.seek(existing, options.resumeAt);
        if (options.keepWatching) this.play(existing);
      } else {
        // Nothing is playing there yet, or the tab has just woken up. Jump once it's ready.
        existing.pendingResume = options.resumeAt ?? null;
      }
      this.changed(existing);
      return existing;
    }
    return this.openTab(url, { select: options.active ?? true, resumeAt: options.resumeAt, keepWatching: options.keepWatching });
  }

  async select(tab: TabState): Promise<void> {
    tab.lastActiveAt = this.now();
    await this.platform.tabs.update(tab.id, { active: true });
    if (tab.windowId >= 0) await this.platform.tabs.focusWindow(tab.windowId);
  }

  /** Only one film at a time. Starting a video pauses any other tab that was playing. */
  pauseOthers(tab: TabState): void {
    for (const other of this.registry.all()) {
      if (other.id !== tab.id && other.media?.isPlaying === true) this.pausePlayback(other);
    }
  }

  /** What a site's own page teaches: how it searches, and its icon. */
  async learnFromPage(meta: PageMeta, tab: TabState): Promise<void> {
    const site = this.ctx.library.siteForHost(hostOf(tab.url));
    if (!site) return;
    let updated = site;
    if (site.searchTemplate == null && meta.search) updated = { ...updated, searchTemplate: meta.search };
    if (meta.icon && site.iconUrl !== meta.icon) updated = { ...updated, iconUrl: meta.icon };
    if (updated !== site) await this.ctx.library.updateSite(updated);
  }

  /** BrowserModel.searchEverywhere: the query on every site that can search, grouped. */
  async searchEverywhere(query: string, titleId: number | null): Promise<number> {
    const sites = this.ctx.library.sites.filter((s) => s.searchTemplate != null);
    if (sites.length === 0) {
      this.ctx.toasts.show("None of your sites has search set up. Add one in Settings.");
      return 0;
    }
    const opened: TabState[] = [];
    for (const site of sites) {
      const url = Site.searchUrl(site, query);
      if (!url) continue;
      const tab = await this.openTab(url, { select: opened.length === 0, siteId: site.id });
      if (!tab) continue;
      tab.searchTitleId = titleId;
      opened.push(tab);
    }
    if (opened.length > 1) await this.platform.tabs.group(opened.map((t) => t.id), query);
    return opened.length;
  }

  /** Frees the memory of tabs left alone for a while (the Mac's hibernation is the browser's discard). */
  async hibernateIdleTabs(): Promise<void> {
    const limit = this.settings.hibernateMinutes * 60_000;
    if (!(limit > 0)) return;
    const cutoff = this.now() - limit;
    for (const tab of this.registry.listed()) {
      if (tab.active || tab.isHibernated || tab.lastActiveAt >= cutoff || tab.media?.isPlaying) continue;
      // Only pages Cineon has a stake in: the person's sites and pages that had a film.
      if (tab.track == null && tab.media == null && !this.ctx.library.siteForHost(hostOf(tab.url))) continue;
      await this.ctx.tracker.tabNavigated(tab);
      tab.isHibernated = true;
      await this.platform.tabs.discard(tab.id).catch(() => undefined);
      this.changed(tab);
    }
  }

  // MARK: Navigation commands (BrowserTab)

  /** Loads an address in the tab. The page being left is saved first. */
  async load(tab: TabState, url: string, resumingAt?: number | null): Promise<void> {
    this.ctx.rescue.stop(tab);
    await this.ctx.tracker.tabNavigated(tab);
    if (resumingAt !== undefined) tab.pendingResume = resumingAt;
    tab.url = url;
    tab.failure = null;
    tab.trustedNavigation = true;
    this.changed(tab);
    void this.noteSiteUsed(url);
    await this.platform.tabs.update(tab.id, { url }).catch(() => undefined);
  }

  /** Carries on watching at a new address: the video there may start by itself, with sound. */
  loadToKeepWatching(tab: TabState, url: string, resumingAt: number | null = null): Promise<void> {
    tab.autoplayKey = UrlKey.make(url);
    return this.load(tab, url, resumingAt);
  }

  wantsAutoplay(tab: TabState, url: string | null): boolean {
    return tab.autoplayKey != null && url != null && UrlKey.make(url) === tab.autoplayKey;
  }

  async reload(tab: TabState): Promise<void> {
    tab.failure = null;
    tab.trustedNavigation = true;
    await this.platform.tabs.reload(tab.id).catch(() => undefined);
  }

  private async noteSiteUsed(url: string): Promise<void> {
    const site = this.ctx.library.siteForHost(hostOf(url));
    if (site) await this.ctx.library.updateSite({ ...site, lastUsedAt: this.now() / 1000 });
  }

  // MARK: Page scripts

  private mediaFrameId(tab: TabState): number {
    return tab.mediaFrame?.frameId ?? 0;
  }

  /** `window.__cineon.<method>(...args)` in the frame holding the video, without waiting. */
  mediaCommand(tab: TabState, method: string, ...args: unknown[]): void {
    if (!isWebUrl(tab.url) && tab.url != null) return;
    detach(this.platform.page.call(tab.id, this.mediaFrameId(tab), "__cineon", method, args));
  }

  /** The same, waiting for what it returns. */
  evaluateInPlayer(tab: TabState, method: string, ...args: unknown[]): Promise<unknown> {
    return this.platform.page.call(tab.id, this.mediaFrameId(tab), "__cineon", method, args);
  }

  /** In the top frame, which is where a page's episode list lives. */
  evaluateInPage(tab: TabState, method: string, ...args: unknown[]): Promise<unknown> {
    return this.platform.page.call(tab.id, 0, "__cineon", method, args);
  }

  /** A small card over the player, which unlike a toast can still be seen in fullscreen. */
  showBanner(tab: TabState, options: BannerOptions): void {
    const seconds = options.seconds ?? null;
    const timeout = options.timeout ?? null;
    tab.lastBannerForTests = `${options.id}|${options.text}|${seconds == null ? "offer" : "countdown"}`;
    const lasts = seconds ?? timeout;
    tab.banner = { id: options.id, until: lasts == null ? null : this.now() + lasts * 1000 };
    const payload: Record<string, unknown> = { id: options.id, text: options.text, actions: options.actions ?? [] };
    if (seconds != null) payload.seconds = seconds;
    if (options.onExpire != null) payload.onExpire = options.onExpire;
    if (timeout != null) payload.timeout = timeout;
    this.mediaCommand(tab, "banner", payload);
    this.changed(tab);
  }

  clearBanner(tab: TabState, id: string): void {
    if (tab.banner?.id === id) tab.banner = null;
    this.mediaCommand(tab, "clearBanner", id);
  }

  /** Is a banner other than a passing toast on screen (the next episode, an intro, a rescue)? */
  hasImportantBanner(tab: TabState): boolean {
    const banner = tab.banner;
    if (!banner || banner.id === "toast" || banner.id === "saved" || banner.id === "moment") return false;
    return banner.until == null || banner.until > this.now();
  }

  /** A toast shown over the player; its button comes back as the banner `toast`'s `action`. */
  showToastBanner(tab: TabState, text: string, action: ToastAction | null): void {
    if (action) this.toastActions.set(tab.id, action);
    else this.toastActions.delete(tab.id);
    this.showBanner(tab, {
      id: "toast",
      text,
      actions: action ? [{ id: "action", label: action.title, primary: false }] : [],
      timeout: action ? 6 : 3,
    });
  }

  handleToastBanner(banner: string, action: string, tab: TabState): void {
    if (banner !== "toast" || action !== "action") return;
    const run = this.toastActions.get(tab.id);
    this.toastActions.delete(tab.id);
    run?.run();
  }

  pausePlayback(tab: TabState): void {
    this.mediaCommand(tab, "pause");
  }

  play(tab: TabState): void {
    this.mediaCommand(tab, "play");
  }

  togglePlayback(tab: TabState): void {
    this.mediaCommand(tab, "toggle");
  }

  seek(tab: TabState, seconds: number): void {
    this.mediaCommand(tab, "seek", seconds);
  }

  skip(tab: TabState, seconds: number): void {
    this.mediaCommand(tab, "skip", seconds);
  }

  setRate(tab: TabState, rate: number): void {
    this.mediaCommand(tab, "rate", rate);
  }

  togglePictureInPicture(tab: TabState): void {
    this.mediaCommand(tab, "pip");
  }

  /** Fades the sound out over this long, then pauses and puts the volume back. */
  fadeOut(tab: TabState, seconds: number): void {
    this.mediaCommand(tab, "fadeOut", Math.max(0.5, seconds));
  }

  cancelFade(tab: TabState): void {
    this.mediaCommand(tab, "cancelFade");
  }

  setAmbient(tab: TabState, on: boolean): void {
    if (on) {
      if (!tab.ambientFramesBlocked) this.mediaCommand(tab, "ambient", true);
    } else {
      this.mediaCommand(tab, "ambient", false);
    }
  }

  /** Cinema mode inside the page: theater.js isolates the player from the page around it. */
  async setTheater(tab: TabState, on: boolean): Promise<boolean> {
    const result = await this.platform.page.call(tab.id, 0, "__cineonContent", "theater", [on]);
    tab.isTheaterOn = on && result !== false;
    this.changed(tab);
    return tab.isTheaterOn;
  }

  /** A long video just became ready. Everything it should know before it starts. */
  async replyToReadyVideo(tab: TabState, event: MediaEvent): Promise<Record<string, unknown> | null> {
    const reply: Record<string, unknown> = {};
    const position = await this.ctx.tracker.resumePosition(event, tab);
    if (position != null) reply.seekTo = position;
    const skips = await this.ctx.autopilot.skips(event, tab);
    if (skips) reply.skips = skips;
    if (this.wantsAutoplay(tab, tab.url) && event.duration >= WatchTracker.minimumDuration) {
      tab.autoplayKey = null;
      reply.play = true;
    }
    this.changed(tab);
    return Object.keys(reply).length === 0 ? null : reply;
  }

  // MARK: Downloads

  bestSource(tab: TabState): MediaSource | null {
    return TabState.bestSource(tab);
  }

  private receiveSources(tab: TabState, body: Record<string, unknown>, frame: FrameRef): void {
    const list = body.items;
    if (!Array.isArray(list)) return;
    const found: MediaSource[] = [];
    for (const entry of list as Record<string, unknown>[]) {
      const url = typeof entry?.url === "string" ? entry.url : null;
      const kind = MediaSourceKind.fromRaw(entry?.kind);
      if (!url || !kind) continue;
      found.push({
        url,
        kind,
        foundAt: typeof entry.at === "number" ? entry.at : 0,
        isCurrent: typeof entry.current === "boolean" ? entry.current : true,
      });
    }
    if (found.length === 0) return;
    found.push(...this.sniffedFor(tab, frame.frameId, found));
    tab.sources = found;
    tab.sourcesFrame = { frameId: frame.frameId, url: typeof body.frame === "string" ? body.frame : frame.url };
    const newSource = typeof body.src === "string" ? body.src : null;
    // Another episode started in the same page: its subtitles aren't these.
    if (tab.playingSource != null && newSource != null && tab.playingSource !== newSource && tab.secondSubtitles) {
      this.clearSecondSubtitles(tab);
    }
    tab.playingSource = newSource;
    this.changed(tab);
    if (tab.isHelper) return;
    this.refreshDownloadPill(tab);
  }

  /** A player file the network saw (webRequest.onResponseStarted), kept for its frame. */
  noteResponse(tab: TabState, frameId: number, url: string, contentType: string | null): void {
    if (!/^https?:/i.test(url)) return;
    const progressive = MediaUrls.progressive(url);
    let kind = MediaUrls.kindOf(progressive);
    if (kind == null && contentType && /mpegurl/i.test(contentType)) kind = "hls";
    if (kind == null) return;
    tab.sniffed = tab.sniffed.filter((s) => s.url !== progressive);
    tab.sniffed.push({ url: progressive, kind, at: this.now(), frameId });
    if (tab.sniffed.length > 60) tab.sniffed.shift();
    this.registry.scheduleSave();
  }

  /** Files the network saw for the frame media.js reported from, which its list doesn't have. */
  private sniffedFor(tab: TabState, frameId: number, reported: readonly MediaSource[]): MediaSource[] {
    if (tab.sniffed.length === 0) return [];
    const known = new Set(reported.map((s) => s.url));
    const currentTimes = reported.filter((s) => s.isCurrent).map((s) => s.foundAt);
    const current = currentTimes.length > 0 ? Math.min(...currentTimes) : null;
    return tab.sniffed
      .filter((s) => s.frameId === frameId && !known.has(s.url))
      .map((s) => ({ url: s.url, kind: s.kind, foundAt: s.at, isCurrent: current != null && s.at >= current - 10_000 }));
  }

  private receiveDownloadClick(tab: TabState, body: Record<string, unknown>): void {
    const downloads = this.ctx.downloads;
    if (!downloads) return;
    const action = typeof body.action === "string" ? body.action : null;
    const best = this.bestSource(tab);
    const failed = best ? downloads.items.find((i) => i.sourceUrl === MediaUrls.progressive(best.url) && i.status === "failed") : undefined;
    if (action === "retry" && failed) {
      downloads.retry(failed.id);
    } else if (action === "open") {
      const done = downloads.existing(asDownloadTab(this, tab));
      if (done) detach(this.ctx.playDownload(done));
    } else {
      detach(downloads.download(asDownloadTab(this, tab)));
    }
    this.refreshDownloadPill(tab);
  }

  /** Shows the download button in the player's frame, saying what it would do now. */
  refreshDownloadPill(tab: TabState, force = false): void {
    if (tab.isHelper || tab.isProbe) return;
    const downloads = this.ctx.downloads;
    const best = this.bestSource(tab);
    let options: Record<string, unknown> | null = null;
    if (downloads && this.settings.showDownloadButton && best) {
      const progressive = MediaUrls.progressive(best.url);
      const existing = downloads.existing(asDownloadTab(this, tab)) ?? downloads.items.find((i) => i.sourceUrl === progressive) ?? null;
      const quality = MediaSource.quality(best);
      switch (existing?.status) {
        case "downloading":
        case "queued": {
          const fraction = downloads.fraction(existing);
          options = {
            label: fraction > 0 ? `Downloading ${Math.trunc(fraction * 100)}%` : "Starting download…",
            progress: fraction,
            busy: true,
            hint: "Saving to your browser's downloads folder",
          };
          break;
        }
        case "done":
          options = { label: "Saved", progress: 0, action: "open", hint: "Play the copy on this computer" };
          break;
        case "failed":
          options = { label: "Download again", progress: 0, action: "retry", hint: existing.error ?? "" };
          break;
        default:
          options = { label: `Download${quality ? ` · ${quality}` : ""}`, progress: 0, hint: "Save this video to this computer" };
      }
    }
    const json = JSON.stringify(options);
    if (!force && json === tab.lastPill) return;
    tab.lastPill = json;
    const frameId = tab.sourcesFrame?.frameId ?? this.mediaFrameId(tab);
    detach(this.platform.page.call(tab.id, frameId, "__cineon", "downloadPill", [options]));
  }

  refreshAllPills(force = false): void {
    for (const tab of this.registry.listed()) {
      if (force) tab.lastPill = null;
      if (tab.sources.length > 0 || force) this.refreshDownloadPill(tab, force);
    }
  }

  /** Caption style for the browser's own text tracks, in the frame that holds the film. */
  applyCaptions(tab: TabState, force = false): void {
    const frame = tab.mediaFrame;
    if (!frame) return;
    const style = this.settings.captionStyle;
    const key = `${frame.url}|${style}`;
    if (!force && key === tab.captionsApplied) return;
    // A frame that never had a style doesn't need clearing.
    if (tab.captionsApplied == null && style === "site") return;
    tab.captionsApplied = key;
    this.mediaCommand(tab, "captions", CaptionStyle.css(style));
  }

  applyVoiceBoost(tab: TabState): void {
    if (!tab.mediaFrame) return;
    const on = this.settings.voiceBoost;
    if (!on && tab.boostState === "off") return;
    this.mediaCommand(tab, "voiceBoost", on);
  }

  /** Subtitle files the player fetched, which can be shown as a second line. */
  subtitleChoices(tab: TabState): { url: string; label: string }[] {
    return tab.sources
      .filter((s) => s.kind === "subtitle")
      .map((s, index) => ({ url: s.url, label: SubtitleTrack.labelFor(s.url, index) }));
  }

  /** Fetches a subtitle file the way the player did and shows it above the picture. */
  async showSecondSubtitles(tab: TabState, url: string): Promise<boolean> {
    const downloads = this.ctx.downloads;
    const data = downloads ? await downloads.fetch(url, tab.sourcesFrame?.url ?? tab.url) : null;
    const text = data ? SubtitleTrack.decode(data) : null;
    if (!text) {
      this.ctx.toasts.show("Couldn't load those subtitles", { tab });
      return false;
    }
    const cues = SubtitleTrack.parse(text);
    if (cues.length === 0) {
      this.ctx.toasts.show("That file has no subtitles Cineon can read", { tab });
      return false;
    }
    const index = Math.max(0, tab.sources.findIndex((s) => s.url === url));
    tab.secondSubtitles = { id: url, label: SubtitleTrack.labelFor(url, index) };
    this.mediaCommand(tab, "secondSubtitles", cues.map((c) => ({ s: c.start, e: c.end, t: c.text })));
    this.changed(tab);
    return true;
  }

  clearSecondSubtitles(tab: TabState): void {
    tab.secondSubtitles = null;
    this.mediaCommand(tab, "secondSubtitles", null);
  }

  // MARK: Messages from page scripts

  /** Runs a tab's reports one after another, so the tracker sees them in order. */
  private enqueue(tab: TabState, work: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(tab.id) ?? Promise.resolve();
    const next = previous.then(work).catch((error) => console.warn("Cineon: a playback report failed", error));
    this.queues.set(tab.id, next);
    void next.then(() => {
      if (this.queues.get(tab.id) === next) this.queues.delete(tab.id);
    });
    return next;
  }

  /** Waits until every report heard so far for the tab has been handled (tests and debug). */
  async idle(tabId?: number): Promise<void> {
    if (tabId != null) {
      await this.queues.get(tabId);
      return;
    }
    await Promise.all([...this.queues.values()]);
  }

  receiveMedia(tab: TabState, body: unknown, frame: FrameRef): Promise<void> {
    const event = MediaEvent.parse(body);
    if (!event) return Promise.resolve();
    const dict = body as Record<string, unknown>;
    switch (event.type) {
      case "ambient":
        this.ctx.frames.receiveAmbient(tab, dict.zones);
        return Promise.resolve();
      case "ambientUnavailable":
        tab.ambientFramesBlocked = true;
        this.changed(tab);
        return Promise.resolve();
      case "jump":
        this.ctx.autopilot.handleJump(body, tab);
        return Promise.resolve();
      case "skipped":
        this.ctx.autopilot.handleSkipped(body, tab);
        return Promise.resolve();
      case "banner":
        return this.enqueue(tab, () => this.ctx.autopilot.handleBanner(body, tab));
      case "sources":
        this.receiveSources(tab, dict, frame);
        return Promise.resolve();
      case "download":
        this.receiveDownloadClick(tab, dict);
        return Promise.resolve();
      case "boost": {
        tab.boostState = VoiceBoostState.fromRaw(dict.state) ?? "off";
        this.changed(tab);
        return Promise.resolve();
      }
      case "failed":
      case "stalled":
        if (tab.isHelper || tab.isProbe) return Promise.resolve();
        this.ctx.rescue.videoTrouble(event, tab);
        return Promise.resolve();
      case "recovered":
        this.ctx.rescue.videoRecovered(tab);
        return Promise.resolve();
      default:
        break;
    }
    if (event.duration >= WatchTracker.minimumDuration) {
      const isNewFrame = tab.mediaFrame == null || tab.mediaFrame.frameId !== frame.frameId || tab.mediaFrame.url !== frame.url;
      tab.mediaFrame = frame;
      if (!tab.isHelper && !tab.isProbe) {
        this.applyCaptions(tab);
        if (event.type === "play" || isNewFrame) this.applyVoiceBoost(tab);
      }
    }
    if (tab.isHelper || tab.isProbe) return Promise.resolve();
    // Sleep-timer pauses arrive as a pause with `sleep: true`; they count like any pause.
    return this.enqueue(tab, async () => {
      await this.ctx.tracker.handle(event, tab);
      this.changed(tab);
    });
  }

  receiveMeta(tab: TabState, body: unknown): void {
    const meta = PageMeta.from(body);
    if (!meta) return;
    tab.pageMeta = meta;
    tab.parsed = TitleParser.parse(meta);
    this.changed(tab);
    if (tab.isHelper || tab.isProbe) return;
    if (meta.icon) tab.favIconUrl = meta.icon;
    detach(this.learnFromPage(meta, tab));
  }

  receiveShield(tab: TabState, body: unknown): void {
    if ((body as { type?: unknown } | null)?.type !== "overlay") return;
    tab.blocked = { ...tab.blocked, overlays: tab.blocked.overlays + 1 };
    this.ctx.shields.record({ overlays: 1 });
    this.changed(tab);
  }

  // MARK: Navigation (the browser's events)

  /** The tab's address changed: a new page, or a single-page site moving on (BrowserTab.urlChanged). */
  urlChanged(tab: TabState, value: string): void {
    if (schemeOf(value) === "about") return;
    const changed = value !== tab.url;
    const key = UrlKey.make(value);
    if (key === tab.lastHistoryKey) {
      tab.url = value;
      return;
    }
    tab.lastHistoryKey = key;
    if (tab.isHelper || tab.isProbe) {
      tab.url = value;
      return;
    }
    if (changed) {
      // A failed load also moves the address back, which mustn't end the search it started.
      if (tab.rescue && !tab.rescue.reason.startsWith("page")) this.ctx.rescue.stop(tab);
      // The page being left is saved with its own address.
      detach(this.ctx.tracker.tabNavigated(tab));
      tab.parsed = null;
      tab.pageMeta = null;
      tab.isTheaterOn = false;
      // Single-page sites change address without a new document: read the page again.
      this.ctx.clock.schedule(800, () => detach(this.platform.page.call(tab.id, 0, "__cineonMeta", "extract", [])));
    }
    tab.url = value;
    detach(this.noteHistory(tab, value));
    this.changed(tab);
  }

  /** The person's browsing, for the timeline: only on their sites and pages that had a film. */
  private async noteHistory(tab: TabState, url: string): Promise<void> {
    if (!this.settings.saveBrowsingHistory || !isWebUrl(url)) return;
    const host = hostOf(url) ?? "";
    if (!this.ctx.library.siteForHost(host) && tab.track == null) return;
    await this.ctx.db.addHistory(url, host, tab.title).catch(() => undefined);
  }

  titleChanged(tab: TabState, title: string): void {
    if (title.length === 0 || title === tab.title) return;
    tab.title = title;
    this.changed(tab);
    if (tab.isHelper || tab.isProbe || !tab.url || !this.settings.saveBrowsingHistory) return;
    detach(this.ctx.db.updateHistoryTitle(tab.url, title).catch(() => undefined));
  }

  /** A new document in the tab's main frame (WKNavigationDelegate didCommit). */
  didCommit(tab: TabState, url: string, documentId: string | null, transition: { type: string; qualifiers: readonly string[] } | null): void {
    if (documentId != null && documentId === tab.documentId) return;
    const wasTrusted = tab.trustedNavigation;
    const previousUrl = tab.url;
    tab.documentId = documentId;
    tab.trustedNavigation = false;
    tab.failure = null;
    if (!(tab.rescue && RescueReasonOpensBySelf(tab.rescue.reason) && tab.rescue.stage !== "finished")) this.ctx.rescue.stop(tab);
    if (!this.wantsAutoplay(tab, url)) tab.autoplayKey = null;
    tab.blocked = ShieldStats.make();
    tab.isTheaterOn = false;
    tab.mediaFrame = null;
    tab.banner = null;
    TabState.forgetSources(tab);
    // Reloads don't change the address, so save progress here as well.
    detach(this.ctx.tracker.tabNavigated(tab));
    this.noticeSiteMove(tab, url);
    this.urlChanged(tab, url);
    if (!wasTrusted && transition) this.checkRedirect(tab, previousUrl, url, transition);
    this.changed(tab);
  }

  /** The page finished loading (didFinish): a page the server said is gone starts a rescue. */
  didFinish(tab: TabState): void {
    tab.isLoading = false;
    const gone = tab.missingPageUrl;
    if (gone) {
      tab.missingPageUrl = null;
      this.ctx.rescue.pageMissing(tab, gone);
    }
    this.changed(tab);
  }

  /** The main frame's response: remembers a status that means the film isn't here. */
  mainResponse(tab: TabState, url: string, status: number, headers: readonly { name: string; value?: string }[]): void {
    const botCheck = headers.some((h) => h.name.toLowerCase() === "cf-mitigated");
    tab.missingPageUrl = !botCheck && GONE_STATUSES.has(status) ? url : null;
  }

  /** The page couldn't load at all (didFailProvisionalNavigation). */
  didFail(tab: TabState, url: string, error: string): void {
    tab.trustedNavigation = false;
    if (IGNORED_ERRORS.test(error)) return;
    const host = hostOf(url) ?? "This site";
    tab.failure = { host, message: Browser.explain(error), url };
    tab.url = url;
    this.changed(tab);
    // Offline, every site looks dead. Going looking would only make things worse.
    if (!/INTERNET_DISCONNECTED|OFFLINE/i.test(error)) this.ctx.rescue.pageFailed(tab, url);
  }

  static explain(error: string): string {
    if (/NAME_NOT_RESOLVED|DNS|UNKNOWN_HOST|NS_ERROR_UNKNOWN_HOST/i.test(error)) {
      return "This address no longer exists. The site may have moved to a new one.";
    }
    if (/INTERNET_DISCONNECTED|OFFLINE/i.test(error)) return "This computer is offline. Check the connection, then try again.";
    if (/TIMED_OUT|NET_TIMEOUT/i.test(error)) return "The site took too long to answer.";
    if (/CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_FAILED|NET_RESET|CONNECTION_REFUSED/i.test(error)) {
      return "The site refused the connection. It may be down.";
    }
    if (/CERT|SSL|SEC_ERROR|SSL_ERROR/i.test(error)) return "The site's security certificate isn't valid.";
    return "The page couldn't be loaded.";
  }

  /** Streaming sites change address all the time. When a site redirects to its new one, follow it. */
  private noticeSiteMove(tab: TabState, committed: string): void {
    const id = tab.originSiteId;
    const host = hostOf(committed)?.toLowerCase();
    if (id == null || !host) return;
    const site = this.ctx.library.sites.find((s) => s.id === id);
    if (!site) return;
    tab.originSiteId = null;
    const bare = host.startsWith("www.") ? host.slice(4) : host;
    if (DomainName.isSameSite(site.host, bare)) return;
    let home = committed;
    try {
      const parsed = new URL(committed);
      home = `${parsed.protocol}//${parsed.host}/`;
    } catch {
      // Keep the address as it came.
    }
    detach(this.ctx.library.updateSite({ ...site, host: bare, homeUrl: home, searchTemplate: null }));
    this.ctx.toasts.show(`${site.name} moved from ${site.host} to ${bare}. Address updated.`, { tab });
  }

  // MARK: Shields

  /** Pages where the pop-up and redirect shields apply: the person's sites and pages with a film. */
  isShielded(tab: TabState): boolean {
    return tab.media != null || tab.track != null || this.ctx.library.siteForHost(hostOf(tab.url)) != null;
  }

  /**
   * The redirect shield, after the fact: a script sent the page to another site without the person
   * asking (WebKit's `.other` navigation). The browser has already committed it, so the tab goes back.
   */
  private checkRedirect(tab: TabState, from: string | null, to: string, transition: { type: string; qualifiers: readonly string[] }): void {
    if (!transition.qualifiers.includes("client_redirect") || transition.qualifiers.includes("forward_back")) return;
    const fromHost = hostOf(from);
    const toHost = hostOf(to);
    if (!fromHost || DomainName.isSameSite(fromHost, toHost)) return;
    const scheme = schemeOf(to);
    if (scheme === "about" || scheme === "blob" || scheme === "data") return;
    const prefs = this.ctx.shields.prefsFor(fromHost);
    if (!this.settings.redirectShield || prefs.shieldsOff || prefs.allowRedirects) return;
    // A gesture in the page just now is the person's own doing.
    if (this.now() - tab.lastGestureAt < 1000) return;
    const wasShielded = tab.track != null || this.ctx.library.siteForHost(fromHost) != null;
    if (!wasShielded) return;
    this.blockRedirect(tab, fromHost, to, true);
  }

  blockRedirect(tab: TabState, fromHost: string | null, target: string, goBack: boolean): void {
    tab.blocked = { ...tab.blocked, redirects: tab.blocked.redirects + 1 };
    this.ctx.shields.record({ redirects: 1 });
    if (goBack) detach(this.platform.tabs.goBack(tab.id));
    const host = hostOf(target) ?? "another site";
    this.ctx.toasts.show(`Blocked redirect to ${host}`, {
      tab,
      action: {
        title: "Allow",
        run: () => {
          detach(this.ctx.shields.update(fromHost, { allowRedirects: true }));
          detach(this.load(tab, target));
        },
      },
    });
    this.changed(tab);
  }

  blockPopup(tab: TabState, target: string | null): void {
    tab.blocked = { ...tab.blocked, popups: tab.blocked.popups + 1 };
    this.ctx.shields.record({ popups: 1 });
    const host = hostOf(target) ?? "an unknown page";
    const fromHost = hostOf(tab.url);
    this.ctx.toasts.show(`Blocked pop-up to ${host}`, {
      tab,
      action: target
        ? {
            title: "Open",
            run: () => {
              detach(this.ctx.shields.update(fromHost, { allowPopups: true }));
              detach(this.openTab(target, { select: true, openerTabId: tab.id }));
            },
          }
        : null,
    });
    this.changed(tab);
  }

  /** Whether a new tab a page opened may stay (the Mac's createWebViewWith policy). */
  popupAllowed(opener: TabState, target: string | null): boolean {
    if (!this.settings.popupShield || !this.isShielded(opener)) return true;
    const prefs = this.ctx.shields.prefsFor(hostOf(opener.url));
    if (prefs.shieldsOff || prefs.allowPopups) return true;
    // The person opened this link in a new tab themselves.
    const link = opener.lastUserLink;
    if (link && target && link.url === target && this.now() - link.at < 3000) return true;
    // A real click (the browser lets nothing else open a tab) on the same site.
    return DomainName.isSameSite(hostOf(target), hostOf(opener.url));
  }

  /** Tabs where an episode is being tracked, for "next episode" in pages. */
  hasNextEpisode(tab: TabState): boolean {
    if (tab.autopilot.isResolved) return tab.autopilot.target != null;
    const ref = tab.track?.ref ?? tab.parsed?.ref ?? null;
    return ref != null && EpisodeRef.isEpisode(ref);
  }
}

function RescueReasonOpensBySelf(reason: string): boolean {
  return reason === "pageFailed" || reason === "pageMissing";
}
