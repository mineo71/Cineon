// What the background knows and pages show: what's playing, the download center, Together, the
// shields' lists. Each `Live` asks once when the first view subscribes, then follows the
// background's signals and asks again every so often while anyone's looking, in case a signal
// was missed (a sleeping service worker posts nothing). `answered` tells "no background" apart
// from "nothing to show".

import type { Database } from "../../core/data";
import {
  type DownloadsSnapshot,
  type ShieldsSnapshot,
  type Signal,
  type SignalChannel,
  type TabSnapshot,
  type TogetherSnapshot,
  send,
} from "../../shared/messages";

export class Live<T> {
  value: T | null = null;
  /** The background answered at least once. */
  answered = false;
  /** Asked at least once (answered or not). */
  settled = false;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private offSignal: (() => void) | null = null;
  private asking = false;

  constructor(
    private readonly ask: () => Promise<T | null>,
    private readonly channel: SignalChannel | null,
    private readonly fromSignal: ((signal: Signal) => T | undefined) | null,
    private readonly intervalMs: number,
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private start(): void {
    void this.refresh();
    if (this.channel && this.fromSignal) {
      const fromSignal = this.fromSignal;
      this.offSignal = this.channel.on((signal) => {
        const value = fromSignal(signal);
        if (value === undefined) return;
        this.set(value, true);
      });
    }
    if (this.intervalMs > 0) this.timer = setInterval(() => void this.refresh(), this.intervalMs);
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.offSignal?.();
    this.offSignal = null;
  }

  private set(value: T | null, answered: boolean): void {
    this.value = value;
    this.answered = this.answered || answered;
    this.settled = true;
    this.emit();
  }

  /** Asks now. */
  async refresh(): Promise<void> {
    if (this.asking) return;
    this.asking = true;
    try {
      const value = await this.ask();
      this.set(value, value !== null);
    } finally {
      this.asking = false;
    }
  }

  /** Replaces the value until the next answer (an optimistic change). */
  patch(value: T): void {
    this.set(value, this.answered);
  }
}

/** Whether the page is in front; background polls slow down when it isn't. */
function visible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

export interface LiveSet {
  /** `tab` is null when nothing has a video. */
  player: Live<{ tab: TabSnapshot | null }>;
  downloads: Live<DownloadsSnapshot>;
  together: Live<TogetherSnapshot>;
  shields: Live<ShieldsSnapshot>;
}

/** Downloads straight from the database, when the background doesn't answer. */
export async function downloadsFromDatabase(db: Database): Promise<DownloadsSnapshot> {
  let items = await db.allDownloads().catch(() => []);
  items = [...items].sort((a, b) => b.createdAt - a.createdAt);
  return { items, job: null, proposal: null, isBusy: false };
}

export function makeLive(channel: SignalChannel, db: () => Database): LiveSet {
  return {
    player: new Live(
      async () => (visible() ? send("player.active", {}, { timeoutMs: 1500 }) : null),
      channel,
      (s) => (s.type === "player" ? { tab: s.player } : undefined),
      1000,
    ),
    downloads: new Live(
      async () => (await send("downloads.state", {}, { timeoutMs: 2000 })) ?? downloadsFromDatabase(db()),
      channel,
      (s) => (s.type === "downloads" ? s.state : undefined),
      2000,
    ),
    together: new Live(
      () => send("together.state", {}, { timeoutMs: 2500 }),
      channel,
      (s) => (s.type === "together" ? s.state : undefined),
      3000,
    ),
    shields: new Live(() => send("shields.state", {}, { timeoutMs: 2500 }), null, null, 0),
  };
}

/** Rows the Mac's FilterEngine.catalog lists, for when the background has nothing to say. */
export const FILTER_CATALOG = [
  { id: "easylist", name: "EasyList", summary: "The main list of ads" },
  { id: "easyprivacy", name: "EasyPrivacy", summary: "Trackers and analytics" },
  { id: "ublock", name: "uBlock filters", summary: "Extra rules from the uBlock Origin project" },
  { id: "peterlowe", name: "Peter Lowe's list", summary: "Ad and tracking servers" },
  { id: "cineon-streaming", name: "Cineon streaming", summary: "Pop-under networks used by streaming sites" },
] as const;
