// Port of App/EpisodeAlerts.swift: notices when a series you're watching gets a new episode. The
// first check of a series only remembers what's already out, so nobody gets a pile of notifications
// for old episodes. The Mac's 30-minute timer is a chrome.alarms alarm here (the worker sleeps);
// each check still skips series looked at in the last six hours.

import { EpisodeAlert, EpisodeRef, type Title } from "../core/data";
import type { SessionContext } from "./context";
import { longLabel, shortLabel } from "./autopilot";

/** How often the episode lists are looked at again, in seconds. */
export const ALERT_INTERVAL = 6 * 60 * 60;

function compareRefs(a: EpisodeRef, b: EpisodeRef): number {
  return a.season - b.season || a.episode - b.episode;
}

export interface AlertsDeps {
  readonly ctx: SessionContext;
  /** Opens the title card in the Cineon page. */
  readonly openTitle: (titleId: number) => void;
  /** Whether to also tell the system (not in test runs). */
  readonly systemNotifications: boolean;
}

export class EpisodeAlerts {
  alerts = new Map<number, EpisodeAlert>();
  isChecking = false;
  lastNotificationForTests: string | null = null;
  private isStopped = false;

  constructor(private readonly deps: AlertsDeps) {}

  private get ctx(): SessionContext {
    return this.deps.ctx;
  }

  private nowSeconds(): number {
    return this.ctx.clock.now() / 1000;
  }

  async load(): Promise<void> {
    const rows = await this.ctx.db.episodeAlerts().catch(() => [] as EpisodeAlert[]);
    this.alerts = new Map(rows.map((a) => [a.titleId, a]));
  }

  stop(): void {
    this.isStopped = true;
  }

  /** The series to keep an eye on: the ones you're watching. */
  get watchedSeries(): Title[] {
    return [...this.ctx.library.titles.values()].filter((t) => t.status === "watching" && (t.kind === "series" || t.kind === "cartoon"));
  }

  /** Series with episodes that came out since you last watched them, newest first. */
  get fresh(): { title: Title; alert: EpisodeAlert }[] {
    const now = this.nowSeconds();
    const out: { title: Title; alert: EpisodeAlert }[] = [];
    for (const alert of this.alerts.values()) {
      const title = this.ctx.library.titles.get(alert.titleId);
      if (alert.newAt == null || alert.newCount <= 0 || now - alert.newAt >= 21 * 86_400 || !title || title.status === "watched") continue;
      // Watching it since the news came in means you've seen it.
      if (title.lastWatchedAt != null && title.lastWatchedAt > alert.newAt) continue;
      out.push({ title, alert });
    }
    return out.sort((a, b) => (b.alert.newAt ?? 0) - (a.alert.newAt ?? 0));
  }

  /** The alarm went off: check the series that are due, if any. */
  async checkIfDue(): Promise<void> {
    if (this.isStopped || !this.ctx.settings.newEpisodeAlerts || this.isChecking) return;
    const now = this.nowSeconds();
    const due = this.watchedSeries.some((title) => {
      const alert = this.alerts.get(title.id);
      return !alert || now - alert.checkedAt > ALERT_INTERVAL;
    });
    if (due) await this.check(false);
  }

  /** Looks at every series you're watching. `force` checks even ones looked at recently. */
  async check(force: boolean): Promise<void> {
    if (this.isChecking) return;
    this.isChecking = true;
    try {
      const news: { title: Title; added: EpisodeRef[] }[] = [];
      for (const title of this.watchedSeries) {
        if (this.isStopped) return;
        const known = this.alerts.get(title.id);
        if (!force && known && this.nowSeconds() - known.checkedAt < ALERT_INTERVAL) continue;
        const episodes = await this.ctx.metadata.episodes(title, true).catch(() => []);
        const nowMs = this.ctx.clock.now();
        const aired = episodes
          .filter((e) => e.season > 0 && e.episode > 0 && (e.released ?? -Infinity) <= nowMs)
          .map((e) => EpisodeRef.make(e.season, e.episode));
        if (aired.length === 0) continue;
        const latest = aired.reduce((a, b) => (compareRefs(a, b) >= 0 ? a : b));
        const isFirstLook = known == null;
        let alert = known ?? EpisodeAlert.make({ titleId: title.id, latest, checkedAt: this.nowSeconds() });
        const added = aired.filter((r) => compareRefs(r, alert.latest) > 0);
        alert = { ...alert, checkedAt: this.nowSeconds() };
        if (!isFirstLook && added.length > 0) {
          alert = { ...alert, latest, newest: latest, newCount: alert.newCount + added.length, newAt: this.nowSeconds() };
          news.push({ title, added: added.sort(compareRefs) });
        }
        if (this.isStopped) return;
        this.alerts.set(title.id, alert);
        await this.ctx.db.saveEpisodeAlert(alert).catch(() => undefined);
      }
      for (const { title, added } of news) this.notify(title, added);
    } finally {
      this.isChecking = false;
    }
  }

  /** Clears the news for a series, once you've seen it. */
  async dismiss(titleId: number): Promise<void> {
    const alert = this.alerts.get(titleId);
    if (!alert) return;
    const cleared = { ...alert, newCount: 0, newAt: null };
    this.alerts.set(titleId, cleared);
    await this.ctx.db.saveEpisodeAlert(cleared).catch(() => undefined);
  }

  private notify(title: Title, added: EpisodeRef[]): void {
    const last = added[added.length - 1];
    const body =
      added.length === 1 && last ? `${longLabel(last)} is out` : `${added.length} new episodes, up to ${last ? longLabel(last) : ""}`;
    this.lastNotificationForTests = `${title.name}|${body}`;
    this.ctx.toasts.show(`New on ${title.name}: ${body.toLowerCase()}`, {
      action: { title: "Open", run: () => this.deps.openTitle(title.id) },
      pageOnly: this.deps.systemNotifications,
    });
    if (!this.deps.systemNotifications) return;
    this.ctx.notifier.show(`episode-${title.id}-${last ? shortLabel(last) : ""}`, {
      title: `New episode of ${title.name}`,
      message: body,
      onClick: () => this.deps.openTitle(title.id),
    });
  }
}
