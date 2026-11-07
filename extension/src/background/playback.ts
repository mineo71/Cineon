// Port of App/Playback.swift's ActivePlayer and sleep timer, AppModel's playback tick and
// App/StayAwake.swift. There's no native player in the extension, so the active player is always a
// tab. The tick runs once a second while something plays or a sleep timer is set; the timer itself
// is kept in chrome.storage.session so a worker that stopped picks it up again.

import { EpisodeRef, type KeyValueStorage } from "../core/data";
import type { SessionContext } from "./context";
import { detach } from "./env";
import type { TabState } from "./tabState";

export type SleepTimerMode = { kind: "minutes"; minutes: number } | { kind: "endOfItem" };

export const SleepTimerMode = {
  label(mode: SleepTimerMode): string {
    if (mode.kind === "endOfItem") return "End of this";
    const m = mode.minutes;
    return m >= 60 && m % 60 === 0 ? `${m / 60} h` : `${m} min`;
  },
  choices: [
    { kind: "minutes", minutes: 15 },
    { kind: "minutes", minutes: 30 },
    { kind: "minutes", minutes: 45 },
    { kind: "minutes", minutes: 60 },
    { kind: "minutes", minutes: 90 },
    { kind: "endOfItem" },
  ] as readonly SleepTimerMode[],
};

export interface SleepTimerState {
  mode: SleepTimerMode;
  /** Milliseconds since 1970. */
  deadline: number | null;
  /** What was playing when it was set, for "end of this". */
  item: string | null;
  isFading: boolean;
}

/** Seconds of sound fading out before playback stops. */
export const FADE_SECONDS = 20;

const SLEEP_KEY = "cineon.sleepTimer";

/** chrome.power, where the browser has it (Chrome; not Firefox). */
export interface PowerApi {
  requestKeepAwake(level: "display" | "system"): void;
  releaseKeepAwake(): void;
}

export interface PlaybackDeps {
  readonly ctx: SessionContext;
  readonly storage: KeyValueStorage | null;
  readonly power: PowerApi | null;
  /** Posts the `player` signal (the caller throttles it). */
  readonly publish: () => void;
  /** Keeps the worker running while something needs the 1-second tick. */
  readonly keepAwake: (on: boolean) => void;
  /** Every 1.5 s while the tick runs (ambient light, AppModel's ambient timer). */
  readonly ambient?: () => void;
}

export class Playback {
  sleepTimer: SleepTimerState | null = null;
  private stopTick: (() => void) | null = null;
  private holding = false;
  private lastAmbient = 0;

  constructor(private readonly deps: PlaybackDeps) {}

  private get ctx(): SessionContext {
    return this.deps.ctx;
  }

  private now(): number {
    return this.ctx.clock.now();
  }

  async restore(): Promise<void> {
    const stored = (await this.deps.storage?.get(SLEEP_KEY).catch(() => null)) as SleepTimerState | null | undefined;
    if (stored && typeof stored === "object" && stored.mode) this.sleepTimer = stored;
    this.updateTicking();
  }

  private save(): void {
    detach(this.deps.storage?.set(SLEEP_KEY, this.sleepTimer));
  }

  // MARK: The active player

  /** The tab whose video plays, else the one that played last, else one being tracked with a video. */
  activeTab(): TabState | null {
    const browser = this.ctx.browser;
    const playing = browser.tabs.find((t) => t.media?.isPlaying === true);
    if (playing) return playing;
    const last = browser.tab(browser.registry.lastPlayedTabId);
    if (last && last.media) return last;
    const tracked = browser.playingTab;
    return tracked && tracked.media ? tracked : null;
  }

  /** A stable name for what's on, so a timer set for one episode knows when another starts. */
  identity(tab: TabState): string {
    return `web:${tab.id}:${tab.track?.urlKey ?? tab.url ?? ""}`;
  }

  /** The play/pause key: the active player, or carry on with the last thing watched. */
  async togglePlayback(): Promise<void> {
    const tab = this.activeTab();
    if (tab) {
      this.ctx.browser.togglePlayback(tab);
      return;
    }
    const first = this.ctx.library.continueWatching[0];
    if (first?.progress.url) {
      await this.ctx.browser.open(first.progress.url, { resumeAt: first.progress.position, keepWatching: true });
    } else {
      this.ctx.toasts.show("Nothing to carry on with yet");
    }
  }

  // MARK: Sleep timer

  start(mode: SleepTimerMode): void {
    const player = this.activeTab();
    if (this.sleepTimer?.isFading && player) this.ctx.browser.cancelFade(player);
    const state: SleepTimerState = { mode, deadline: null, item: null, isFading: false };
    if (mode.kind === "minutes") {
      state.deadline = this.now() + mode.minutes * 60_000;
    } else {
      if (!player) {
        this.ctx.toasts.show("Start something first, then set the timer for its end");
        return;
      }
      state.item = this.identity(player);
      player.autopilot.isHeldForSleep = true;
    }
    this.sleepTimer = state;
    this.save();
    this.updateTicking();
    this.ctx.toasts.show(mode.kind === "endOfItem" ? "Playback stops at the end of this" : `Playback stops in ${SleepTimerMode.label(mode)}`, {
      tab: player,
    });
  }

  /** For tests: a timer that runs out in this many seconds. */
  startSeconds(seconds: number): void {
    this.start({ kind: "minutes", minutes: Math.max(1, Math.trunc(seconds / 60)) });
    if (this.sleepTimer) {
      this.sleepTimer.deadline = this.now() + seconds * 1000;
      this.save();
    }
  }

  cancel(): void {
    const timer = this.sleepTimer;
    if (!timer) return;
    const player = this.activeTab();
    if (timer.isFading && player) this.ctx.browser.cancelFade(player);
    this.releaseSleepHold();
    this.sleepTimer = null;
    this.save();
    this.updateTicking();
  }

  /** Seconds left, or null. */
  remaining(): number | null {
    const timer = this.sleepTimer;
    if (!timer) return null;
    if (timer.mode.kind === "minutes") return timer.deadline == null ? null : (timer.deadline - this.now()) / 1000;
    const player = this.activeTab();
    if (!player?.media || player.media.duration <= 0) return null;
    return Math.max(0, player.media.duration - player.media.position);
  }

  private releaseSleepHold(): void {
    for (const tab of this.ctx.browser.registry.all()) tab.autopilot.isHeldForSleep = false;
  }

  // MARK: The tick

  /** Something started or stopped playing, or a timer changed: run the tick only while it matters. */
  updateTicking(): void {
    const needed = this.sleepTimer != null || this.ctx.browser.tabs.some((t) => t.media?.isPlaying === true);
    if (needed && !this.stopTick) {
      this.stopTick = this.ctx.clock.every(1000, () => this.tick());
      this.deps.keepAwake(true);
    } else if (!needed && this.stopTick) {
      this.stopTick();
      this.stopTick = null;
      this.deps.keepAwake(false);
      this.tick();
    }
  }

  stop(): void {
    this.stopTick?.();
    this.stopTick = null;
    this.deps.keepAwake(false);
    this.hold(false);
  }

  tick(): void {
    const browser = this.ctx.browser;
    const playing = browser.tabs.find((t) => t.media?.isPlaying === true);
    if (playing && browser.registry.lastPlayedTabId !== playing.id) {
      browser.registry.lastPlayedTabId = playing.id;
      browser.registry.scheduleSave();
    }
    this.tickSleepTimer();
    this.tickStayAwake();
    const now = this.now();
    if (this.deps.ambient && now - this.lastAmbient >= 1500) {
      this.lastAmbient = now;
      this.deps.ambient();
    }
    this.deps.publish();
  }

  private tickSleepTimer(): void {
    const timer = this.sleepTimer;
    if (!timer) return;
    const player = this.activeTab();
    if (timer.mode.kind === "endOfItem") {
      // What was on ended, or something else took its place.
      if (!player || this.identity(player) !== timer.item) {
        this.finish(false);
        return;
      }
      player.autopilot.isHeldForSleep = true;
    }
    const remaining = this.remaining();
    if (remaining == null) return;
    if (remaining <= FADE_SECONDS && !timer.isFading && player?.media?.isPlaying) {
      this.ctx.browser.fadeOut(player, Math.max(1, remaining));
      timer.isFading = true;
      this.save();
      return;
    }
    if (timer.mode.kind !== "endOfItem" && remaining <= 0) {
      if (player) this.ctx.browser.pausePlayback(player);
      this.finish(true);
    } else if (timer.isFading && player?.media?.isPlaying === false) {
      this.finish(true);
    }
  }

  private finish(paused: boolean): void {
    this.sleepTimer = null;
    this.save();
    this.releaseSleepHold();
    this.updateTicking();
    if (paused) this.ctx.toasts.show("Sleep timer paused the film. Good night", { tab: this.activeTab() });
  }

  /**
   * The screen stays on while something plays. A page that stopped reporting, because its video is
   * stuck buffering or gone, lets the computer sleep again after a few quiet seconds.
   */
  private tickStayAwake(): void {
    const now = this.now();
    const webPlaying = this.ctx.browser.tabs.some(
      (t) => t.media?.isPlaying === true && t.lastPlaybackReport != null && now - t.lastPlaybackReport < 15_000,
    );
    this.hold(webPlaying);
  }

  get isHoldingAwake(): boolean {
    return this.holding;
  }

  private hold(on: boolean): void {
    if (on === this.holding) return;
    this.holding = on;
    const power = this.deps.power;
    if (!power) return;
    try {
      if (on) power.requestKeepAwake("display");
      else power.releaseKeepAwake();
    } catch {
      // Not available here.
    }
  }

  /** The next episode in the active tab. */
  async playNextEpisode(): Promise<void> {
    const tab = this.activeTab();
    if (tab) await this.ctx.autopilot.skipToNext(tab);
  }

  /** What the "now playing" pill shows: the episode, if any. */
  ref(tab: TabState): EpisodeRef | null {
    const ref = tab.track?.ref ?? tab.parsed?.ref ?? null;
    return ref && EpisodeRef.isEpisode(ref) ? ref : null;
  }
}
