// Keeps the worker running while something needs it: a watch party's one-second loop, a download
// in progress, a playing film's one-second tick, a rescue search. Chrome stops an idle service
// worker after about 30 seconds without extension events, and an extension API call counts as one
// (Chrome 110+), so a call every 20 seconds keeps it going. Firefox's event page counts open ports
// and their messages instead, so the tab in question is also asked to hold a port and ping
// through it (content script: `cineon-keepalive`). Everything stops the moment no reason is left.

import type { Clock } from "./env";

export const KEEPALIVE_PORT = "cineon-keepalive";
const PING_MS = 20_000;

export class KeepAlive {
  private readonly reasons = new Set<string>();
  private stopTimer: (() => void) | null = null;

  constructor(
    private readonly clock: Clock,
    /** A cheap extension API call (chrome.runtime.getPlatformInfo). */
    private readonly ping: () => void,
  ) {}

  get active(): readonly string[] {
    return [...this.reasons];
  }

  hold(reason: string): void {
    if (this.reasons.has(reason)) return;
    this.reasons.add(reason);
    if (!this.stopTimer) {
      this.ping();
      this.stopTimer = this.clock.every(PING_MS, () => this.ping());
    }
  }

  release(reason: string): void {
    if (!this.reasons.delete(reason)) return;
    if (this.reasons.size === 0 && this.stopTimer) {
      this.stopTimer();
      this.stopTimer = null;
    }
  }
}
