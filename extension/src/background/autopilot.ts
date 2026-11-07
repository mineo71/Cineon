// Port of Browser/EpisodeAutopilot.swift (with windows/Cineon.App/Browser/EpisodeAutopilot.cs):
// skips what you skip and moves on to the next episode. Everything here is a guess from watching
// someone's habits, so every action can be undone or turned down right where it happens, in a
// banner over the player (media.js).

import { EpisodeRef, SkipRule, Timecode } from "../core/data";
import { EpisodeLinks, NextEpisode, SkipJump, SkipLearner } from "../core/parsing";
import type { SessionContext } from "./context";
import { detach, hostOf, withoutFragment } from "./env";
import { AutopilotState, type LiveTrack, type MediaEvent, type NextEpisodeTarget, type TabState } from "./tabState";

/** "S1 E2", as the Mac's `EpisodeRef.shortLabel`. */
export function shortLabel(ref: EpisodeRef): string {
  return `S${ref.season} E${ref.episode}`;
}

/** "Season 1, episode 2", as the Mac's `EpisodeRef.longLabel`. */
export function longLabel(ref: EpisodeRef): string {
  return `Season ${ref.season}, episode ${ref.episode}`;
}

/** What media.js reads in `setSkips` and a ready video's reply. */
export interface SkipSpan {
  kind: string;
  from: number;
  to: number;
}

export class EpisodeAutopilot {
  constructor(private readonly ctx: SessionContext) {}

  private get settings() {
    return this.ctx.settings;
  }

  private get library() {
    return this.ctx.library;
  }

  private now(): number {
    return this.ctx.clock.now();
  }

  // MARK: Rules

  private async loadRules(titleId: number, tab: TabState): Promise<void> {
    const host = hostOf(tab.url);
    if (!host) return;
    tab.autopilot.rules = await this.ctx.db.skipRules(titleId, SkipLearner.siteKey(host)).catch(() => []);
  }

  private introSkips(tab: TabState): SkipSpan[] {
    if (!this.settings.learnSkips) return [];
    return tab.autopilot.rules.filter((r) => r.kind === "intro").map((r) => ({ kind: r.kind, from: r.start, to: r.end }));
  }

  private pushSkips(tab: TabState): void {
    this.ctx.browser.mediaCommand(tab, "setSkips", this.introSkips(tab));
  }

  /**
   * Asked as soon as a video's length is known, which can be before tracking begins, so that an
   * intro in the first seconds is still caught.
   */
  async skips(_event: MediaEvent, tab: TabState): Promise<SkipSpan[] | null> {
    const parsed = tab.parsed;
    if (!parsed || !EpisodeRef.isEpisode(parsed.ref)) return null;
    const title = this.library.find(parsed.name, parsed.altName, parsed.year);
    if (!title) return null;
    await this.loadRules(title.id, tab);
    const skips = this.introSkips(tab);
    return skips.length === 0 ? null : skips;
  }

  // MARK: Following playback

  async trackBegan(tab: TabState, track: LiveTrack): Promise<void> {
    const exit = tab.lastEpisodeExit;
    if (
      this.settings.learnSkips &&
      exit &&
      exit.titleId === track.titleId &&
      !EpisodeRef.equals(exit.ref, track.ref) &&
      (this.now() - exit.at) / 1000 < 180
    ) {
      await this.noteCredits(exit.remaining, exit.duration, track.titleId, tab);
    }
    tab.lastEpisodeExit = null;
    await this.loadRules(track.titleId, tab);
    this.pushSkips(tab);
  }

  async tick(event: MediaEvent, tab: TabState, track: LiveTrack): Promise<void> {
    await this.settleJump(tab, track);
    const state = tab.autopilot;
    if (!EpisodeRef.isEpisode(track.ref) || !this.settings.autoNextEpisode || state.isDeclined || state.didMove) return;

    const ended = event.type === "ended";
    // Pausing during the countdown means they're not ready to move on. A video that reaches its end
    // also reports a pause, which is why it has to be away from the end to count.
    if (event.type === "pause" && state.isCountingDown && event.duration - event.position > 1) {
      state.isCountingDown = false;
      this.ctx.browser.clearBanner(tab, "next");
      return;
    }
    if (event.paused && !ended) return;
    const remaining = event.duration - event.position;
    const credits = state.rules.find((r) => r.kind === "credits") ?? null;
    const reachedCredits = credits != null && remaining <= credits.start;
    const nearEnd = event.position / event.duration >= this.settings.finishThreshold;
    if (!ended && !reachedCredits && !nearEnd) return;

    // Moving on by itself takes more certainty than offering to: the episode is really over, or two
    // earlier episodes agreed on where the credits start.
    const isSure = ended || (reachedCredits && (credits?.sightings ?? 0) >= 2);
    this.offerNext(tab, track, isSure);
  }

  /** Called before a page's records are saved and cleared. */
  willLeave(tab: TabState): void {
    const track = tab.track;
    const media = tab.media;
    if (track && EpisodeRef.isEpisode(track.ref) && media && !tab.autopilot.didMove) {
      tab.lastEpisodeExit = {
        titleId: track.titleId,
        ref: track.ref,
        remaining: media.duration - media.position,
        duration: media.duration,
        at: this.now(),
      };
    }
    tab.autopilot = AutopilotState.make();
  }

  // MARK: Learning intros

  handleJump(body: unknown, tab: TabState): void {
    if (!this.settings.learnSkips) return;
    const d = body as { from?: unknown; to?: unknown } | null;
    if (!d || typeof d.from !== "number" || typeof d.to !== "number") return;
    const { from, to } = d;
    const now = this.now();
    const current = tab.autopilot.jump;
    const extended = current ? new SkipJump(current.from, current.to, current.lastAt).extended(from, to, now) : null;
    if (extended) {
      tab.autopilot.jump = { from: extended.from, to: extended.to, lastAt: extended.lastAt };
    } else {
      tab.autopilot.jump = to > from ? { from, to, lastAt: now } : null;
    }
  }

  /** Waits for the jumping to stop before deciding what it was. */
  private async settleJump(tab: TabState, track: LiveTrack): Promise<void> {
    const jump = tab.autopilot.jump;
    if (!jump || (this.now() - jump.lastAt) / 1000 <= SkipLearner.mergeWindow) return;
    tab.autopilot.jump = null;
    const duration = tab.media?.duration;
    const title = this.library.titles.get(track.titleId);
    if (!EpisodeRef.isEpisode(track.ref) || duration == null || !SkipLearner.isIntro(jump.from, jump.to, duration) || !title) return;

    const known = tab.autopilot.rules.find((r) => r.kind === "intro");
    if (known && Math.abs(known.start - jump.from) <= 20 && Math.abs(known.end - jump.to) <= 20) {
      const updated: SkipRule = { ...known, sightings: known.sightings + 1, updatedAt: this.now() / 1000 };
      tab.autopilot.rules = tab.autopilot.rules.map((r) => (r.id === known.id ? updated : r));
      await this.ctx.db.saveSkipRule(updated).catch(() => undefined);
      return;
    }
    if (tab.autopilot.didAskAboutIntro) return;
    tab.autopilot.didAskAboutIntro = true;
    tab.autopilot.proposedIntro = { from: jump.from, to: jump.to };
    this.ctx.browser.showBanner(tab, {
      id: "intro",
      text: `Skip ${Timecode.string(jump.from)} to ${Timecode.string(jump.to)} in every episode of ${title.name}?`,
      actions: [
        { id: "always", label: "Always skip", primary: true },
        { id: "no", label: "No", primary: false },
      ],
      timeout: 12,
    });
  }

  private async saveIntro(from: number, to: number, tab: TabState): Promise<void> {
    const track = tab.track;
    const host = hostOf(tab.url);
    if (!track || !host) return;
    const rule = SkipRule.make({
      titleId: track.titleId,
      site: SkipLearner.siteKey(host),
      kind: "intro",
      start: from,
      end: to,
      sightings: 1,
      misses: 0,
      updatedAt: this.now() / 1000,
    });
    await this.ctx.db.saveSkipRule(rule).catch(() => undefined);
    await this.loadRules(track.titleId, tab);
    this.pushSkips(tab);
    this.ctx.browser.showBanner(tab, { id: "saved", text: "Cineon will skip this from now on", timeout: 3 });
  }

  /** Each episode you leave early with the same time left adds confidence about the credits. */
  private async noteCredits(remaining: number, duration: number, titleId: number, tab: TabState): Promise<void> {
    const host = hostOf(tab.url);
    if (!SkipLearner.isCredits(remaining, duration) || !host) return;
    const site = SkipLearner.siteKey(host);
    const existing = (await this.ctx.db.skipRules(titleId, site).catch(() => [] as SkipRule[])).find((r) => r.kind === "credits");
    let rule =
      existing ??
      SkipRule.make({ titleId, site, kind: "credits", start: remaining, end: 0, sightings: 0, misses: 0, updatedAt: this.now() / 1000 });
    if (SkipLearner.agree(rule.start, remaining)) {
      // Never earlier than the shortest time seen, so an ending isn't cut off.
      rule = { ...rule, sightings: rule.sightings + 1, start: Math.min(rule.start, remaining) };
    } else {
      rule = { ...rule, sightings: 1, start: remaining };
    }
    rule = { ...rule, updatedAt: this.now() / 1000 };
    await this.ctx.db.saveSkipRule(rule).catch(() => undefined);
  }

  // MARK: What the player reports

  handleSkipped(body: unknown, tab: TabState): void {
    const d = body as { from?: unknown; to?: unknown } | null;
    if (!d || typeof d.from !== "number" || typeof d.to !== "number") return;
    tab.autopilot.lastSkip = { from: d.from, to: d.to };
    this.ctx.browser.showBanner(tab, {
      id: "skipped",
      text: "Skipped intro",
      actions: [{ id: "undo", label: "Undo", primary: false }],
      timeout: 6,
    });
  }

  /** A banner's button was pressed, or its countdown ran out (`{banner, action}`). */
  async handleBanner(body: unknown, tab: TabState): Promise<void> {
    const d = body as { banner?: unknown; action?: unknown } | null;
    if (!d || typeof d.banner !== "string" || typeof d.action !== "string") return;
    const banner = d.banner;
    const action = d.action;
    if (tab.banner?.id === banner) tab.banner = null;
    if (banner === "intro" && action === "always") {
      const proposed = tab.autopilot.proposedIntro;
      if (proposed) await this.saveIntro(proposed.from, proposed.to, tab);
    } else if (banner === "skipped" && action === "undo") {
      await this.undoSkip(tab);
    } else if (banner === "next" && action === "play") {
      await this.playNext(tab, true);
    } else if (banner === "next" && action === "auto") {
      await this.playNext(tab, false);
    } else if (banner === "next" && action === "no") {
      tab.autopilot.isDeclined = true;
      tab.autopilot.isCountingDown = false;
    } else if (banner === "rescue" && action === "find") {
      this.ctx.browser.mediaCommand(tab, "exitFullscreen");
      this.ctx.rescue.findElsewhere(tab);
    } else {
      this.ctx.rescue.handleBanner(banner, action, tab);
      this.ctx.browser.handleToastBanner(banner, action, tab);
    }
  }

  private async undoSkip(tab: TabState): Promise<void> {
    const last = tab.autopilot.lastSkip;
    if (!last) return;
    this.ctx.browser.seek(tab, last.from);
    const rule = tab.autopilot.rules.find((r) => r.kind === "intro");
    if (!rule) return;
    const misses = rule.misses + 1;
    if (misses >= 2) {
      await this.ctx.db.deleteSkipRule(rule.id).catch(() => undefined);
      tab.autopilot.rules = tab.autopilot.rules.filter((r) => r.id !== rule.id);
      this.pushSkips(tab);
      this.ctx.browser.showBanner(tab, { id: "saved", text: "Cineon won't skip this any more", timeout: 3 });
    } else {
      const updated = { ...rule, misses, updatedAt: this.now() / 1000 };
      tab.autopilot.rules = tab.autopilot.rules.map((r) => (r.id === rule.id ? updated : r));
      await this.ctx.db.saveSkipRule(updated).catch(() => undefined);
    }
  }

  // MARK: Next episode

  private offerNext(tab: TabState, track: LiveTrack, countdown: boolean): void {
    const state = tab.autopilot;
    if (state.isHeldForSleep) return;
    if (state.isCountingDown || (!countdown && state.didOffer)) return;
    if (!state.isResolved) {
      if (state.isResolving) return;
      state.isResolving = true;
      detach(
        (async () => {
          const target = await this.findNext(tab, track);
          // The person may have moved on while this was being worked out.
          if (tab.track?.urlKey !== track.urlKey && tab.media == null) return;
          const now = tab.autopilot;
          now.target = target;
          now.isResolved = true;
          now.isResolving = false;
          this.ctx.browser.changed(tab);
          if (!now.isDeclined && !now.didMove) this.offerNext(tab, track, countdown);
        })(),
      );
      return;
    }
    const target = state.target;
    if (!target) return;
    state.didOffer = true;
    state.isCountingDown = countdown;
    const name = target.name ? `, ${target.name}` : "";
    this.ctx.browser.showBanner(tab, {
      id: "next",
      text: `Next: ${shortLabel(target.ref)}${name}`,
      actions: [
        { id: "play", label: "Play now", primary: true },
        { id: "no", label: "Not now", primary: false },
      ],
      seconds: countdown ? 10 : null,
      onExpire: countdown ? "auto" : null,
      timeout: countdown ? null : 14,
    });
  }

  async findNext(tab: TabState, track: LiveTrack): Promise<NextEpisodeTarget | null> {
    const title = this.library.titles.get(track.titleId);
    const episodes = title ? await this.ctx.metadata.episodes(title).catch(() => []) : [];
    for (const ref of NextEpisode.candidates(track.ref, episodes, this.now())) {
      const isNextInSeason = ref.season === track.ref.season && ref.episode === track.ref.episode + 1;
      const name = episodes.find((e) => e.season === ref.season && e.episode === ref.episode)?.name ?? null;
      const onPage = (await this.ctx.browser.evaluateInPage(tab, "hasEpisode", ref.season, ref.episode, isNextInSeason)) === true;
      const address = tab.url ? EpisodeLinks.url(tab.url, track.ref, ref) : null;
      if (onPage) return { ref, name, isOnPage: true, isNextInSeason, url: address };
      if (!address) continue;
      const probe = await this.ctx.probe.check(address);
      if (probe.kind === "alive") return { ref, name, isOnPage: false, isNextInSeason, url: address };
    }
    return null;
  }

  /** The next episode now, from a key, the toolbar or a page. */
  async skipToNext(tab: TabState): Promise<void> {
    const track = tab.track;
    if (!track) {
      this.ctx.toasts.show("Cineon doesn't know which episode this is", { tab });
      return;
    }
    if (tab.autopilot.isResolved) {
      if (tab.autopilot.target == null) this.ctx.toasts.show("This looks like the last episode", { tab });
      await this.playNext(tab, true);
      return;
    }
    const target = await this.findNext(tab, track);
    tab.autopilot.target = target;
    tab.autopilot.isResolved = true;
    if (target == null) this.ctx.toasts.show("This looks like the last episode", { tab });
    await this.playNext(tab, true);
  }

  async playNext(tab: TabState, byHand: boolean): Promise<void> {
    if (!byHand && tab.autopilot.isHeldForSleep) return;
    // A countdown that outlived a "no" (a background tab's banner, say) never moves the tab.
    if (!byHand && tab.autopilot.isDeclined) return;
    const target = tab.autopilot.target;
    if (!target) return;
    tab.autopilot.didMove = true;
    const track = tab.track;
    const media = tab.media;
    if (byHand && this.settings.learnSkips && track && media) {
      await this.noteCredits(media.duration - media.position, media.duration, track.titleId, tab);
    }
    if (target.isOnPage) {
      const opened = await this.ctx.browser.evaluateInPage(tab, "openEpisode", target.ref.season, target.ref.episode, target.isNextInSeason);
      if (opened === true) return;
    }
    if (!target.url) return;
    // Changing only the fragment doesn't reload a page, and these sites read it on load.
    const onlyFragmentChanges = tab.url != null && withoutFragment(tab.url) === withoutFragment(target.url);
    await this.ctx.browser.loadToKeepWatching(tab, target.url, null);
    if (onlyFragmentChanges) await this.ctx.browser.reload(tab);
  }
}
