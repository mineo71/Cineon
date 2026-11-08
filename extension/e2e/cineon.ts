// The end-to-end harness: a real Chromium with the unpacked development build (dist/chrome, built with
// `--dev`), driven through the extension's own debug hooks (notes/runtime.md) the way fixtures/e2e.py
// drives the Mac app through `cineon://debug/...` links.
//
// The browser is started by hand and Playwright connects to it over CDP (chromium.connectOverCDP)
// instead of chromium.launchPersistentContext: a persistent context makes Playwright take over every
// download (saved under a random name in its own folder), while a browser it only connects to keeps the
// browser's own downloads, so chrome.downloads names and places files exactly as for a person. It also
// leaves pages at the window's real size (no viewport emulation) and lets a test kill the browser and
// start it again on the same profile, the way e2e.py kills and restarts the app.
import { chromium, expect, type Browser, type BrowserContext, type Page, type TestInfo, type Worker } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const EXTENSION = path.join(ROOT, "extension");
export const DIST = path.join(EXTENSION, "dist/chrome");
export const PORT = Number(process.env.CINEON_E2E_PORT || 8765);
export const BASE = `http://127.0.0.1:${PORT}`;
/** Stretches every wait (CI machines are slower than a Mac on a desk). */
export const SLOW = Number(process.env.CINEON_E2E_SLOW || (process.env.CI ? 1.5 : 1));
/** The Together/cloud server: the dev deployment, as e2e.py. Never production. */
export const DEV_TOGETHER = "https://stoic-pelican-635.eu-west-1.convex.cloud";
export const TOGETHER = (process.env.CINEON_TOGETHER_URL || DEV_TOGETHER).replace(/\/+$/, "");
const PRODUCTION_DEPLOYMENT = "admired-mouse-481";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type State = Record<string, string>;
export interface CheckResult {
  section: string;
  name: string;
  /** null: skipped, with the reason in `detail`. */
  ok: boolean | null;
  detail: string;
}

/** `key=value` lines, the Mac's debug-output format. Missing keys read as "-". */
export function parseFields(text: string): State {
  const out: State = {};
  for (const line of (text || "").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
  }
  return new Proxy(out, { get: (target, key) => (typeof key === "string" ? (target[key] ?? "-") : undefined) });
}

/** One `download\t…` row of `/downloads`, as e2e.py's `fields`. */
export function tabFields(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of line.split("\t")) {
    const at = part.indexOf("=");
    if (at > 0) out[part.slice(0, at)] = part.slice(at + 1);
  }
  return out;
}

function text(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function targetClosed(error: unknown): boolean {
  return /closed|detached|destroyed|Target page, context or browser/i.test(String((error as Error)?.message ?? error));
}

/** Chrome's id for an unpacked extension: the first 128 bits of SHA-256 of its folder, as letters a–p. */
export function extensionId(folder: string): string {
  const hex = createHash("sha256").update(folder).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

/** Calls the Together server the way a friend's Cineon would (e2e.py's `convex`). */
export async function convex(kind: "query" | "mutation", fn: string, args: Record<string, unknown>): Promise<any> {
  if (TOGETHER.includes(PRODUCTION_DEPLOYMENT)) throw new Error("The end-to-end test never talks to the production deployment");
  const response = await fetch(`${TOGETHER}/api/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: fn, args, format: "json" }),
    signal: AbortSignal.timeout(15_000),
  });
  const reply = (await response.json()) as { status?: string; value?: unknown; errorMessage?: string };
  if (reply.status !== "success") throw new Error(reply.errorMessage ?? `${fn}: ${response.status}`);
  return reply.value;
}

/** Runs in the service worker: keeps its console and uncaught errors for the failure report. */
function installLogCapture(): void {
  const g = self as unknown as { __cineonE2eLog?: string[] };
  if (g.__cineonE2eLog) return;
  const log: string[] = (g.__cineonE2eLog = []);
  const push = (line: string) => {
    log.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
    if (log.length > 800) log.splice(0, log.length - 800);
  };
  const show = (a: unknown) => {
    if (a instanceof Error) return a.stack ?? a.message;
    if (typeof a === "string") return a;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  };
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      try {
        push(`${level}: ${args.map(show).join(" ")}`);
      } catch {
        // Logging must never break the worker.
      }
      original(...args);
    };
  }
  self.addEventListener("error", (e) => push(`uncaught: ${(e as ErrorEvent).message}`));
  self.addEventListener("unhandledrejection", (e) => push(`unhandled rejection: ${show((e as PromiseRejectionEvent).reason)}`));
}

interface Box {
  x: number;
  y: number;
}

interface DomNode {
  nodeType: number;
  nodeName: string;
  nodeValue?: string;
  backendNodeId: number;
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
}

/** A browser with Cineon in it, and e2e.py's helpers over the debug hooks. */
export class Cineon {
  readonly results: CheckResult[] = [];
  section = "";
  browser!: Browser;
  context!: BrowserContext;
  readonly id: string;
  readonly dataDir: string;
  readonly profileDir: string;
  readonly downloadsDir: string;
  private child: ChildProcess | null = null;
  private live: Worker | null = null;
  private helperPage: Page | null = null;
  private readonly consoleLines: string[] = [];
  private launches = 0;
  private evidenceTaken = 0;
  private readonly folder = realpathSync(DIST);

  private constructor(readonly info: TestInfo) {
    this.id = extensionId(this.folder);
    this.dataDir = mkdtempSync(path.join(os.tmpdir(), "cineon-e2e-"));
    this.profileDir = path.join(this.dataDir, "profile");
    this.downloadsDir = path.join(this.dataDir, "Downloads");
    mkdirSync(path.join(this.profileDir, "Default"), { recursive: true });
    mkdirSync(this.downloadsDir, { recursive: true });
    // The browser's own download settings: straight into this folder, no questions.
    writeFileSync(
      path.join(this.profileDir, "Default/Preferences"),
      JSON.stringify({
        download: { default_directory: this.downloadsDir, prompt_for_download: false, directory_upgrade: true },
        savefile: { default_directory: this.downloadsDir },
        browser: { has_seen_welcome_page: true },
        extensions: { ui: { developer_mode: true } },
      }),
    );
  }

  /** Starts the browser, finds the worker, and sets what every e2e.py run starts with. */
  static async start(info: TestInfo): Promise<Cineon> {
    const cineon = new Cineon(info);
    try {
      await cineon.launch();
      // A dev build already uses the dev deployment; saying so here makes "never production" explicit.
      await cineon.inWorker((url) => chrome.storage.local.set({ "cineon.togetherUrl": url }), TOGETHER);
      await cineon.waitUntil(async () => (await cineon.state()).profile !== "-", 20);
      // Metadata off: names stay as the pages give them and nothing asks the real catalogue.
      // CINEON_E2E_METADATA=1 keeps it on, as e2e.py's first profile has it.
      await cineon.run("settings", { minimumSeconds: 5, ...(process.env.CINEON_E2E_METADATA ? {} : { metadata: 0 }) });
    } catch (error) {
      // Nothing may be left running when the section can't even start.
      await cineon.finish().catch(() => undefined);
      throw error;
    }
    return cineon;
  }

  // MARK: The browser

  private chromeArgs(): string[] {
    const headless = process.env.CINEON_E2E_HEADLESS === "1";
    return [
      `--user-data-dir=${this.profileDir}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-default-apps",
      "--disable-component-extensions-with-background-pages",
      "--disable-search-engine-choice-screen",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
      "--password-store=basic",
      "--use-mock-keychain",
      // A window covered by another one (a busy desk) mustn't count as hidden: frames and ambient need it shown.
      "--disable-backgrounding-occluded-windows",
      // The Mac's web views may play with sound by themselves; a person in a browser has clicked play.
      // CINEON_E2E_REAL_AUTOPLAY=1 keeps Chrome's own rule, to see what a person who never clicked would get.
      ...(process.env.CINEON_E2E_REAL_AUTOPLAY ? [] : ["--autoplay-policy=no-user-gesture-required"]),
      // Branded Chrome 137+ ignores --load-extension without this; Chromium and Chrome for Testing don't need it.
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
      `--disable-extensions-except=${this.folder}`,
      `--load-extension=${this.folder}`,
      "--window-position=0,0",
      "--window-size=1400,940",
      ...(headless ? ["--headless=new"] : []),
      // What Playwright does by default: Ubuntu 24.04 runners refuse Chrome's sandbox (AppArmor and
      // user namespaces). `--test-type` keeps the "unsupported flag" bar from taking page height.
      ...(process.platform === "linux" && process.env.CI && !process.env.CINEON_E2E_SANDBOX ? ["--no-sandbox", "--test-type"] : []),
      "about:blank",
    ];
  }

  private async launch(): Promise<void> {
    this.launches += 1;
    const executable = process.env.CINEON_E2E_CHROME || chromium.executablePath();
    const portFile = path.join(this.profileDir, "DevToolsActivePort");
    rmSync(portFile, { force: true });
    const log = createWriteStream(this.info.outputPath(`chrome-${this.launches}.log`));
    const child = spawn(executable, this.chromeArgs(), { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    this.child = child;
    let exited: string | null = null;
    child.once("exit", (code, signal) => {
      exited = `exited with ${signal ?? code}`;
    });

    let port = "";
    for (let i = 0; i < 300 && !port && !exited; i++) {
      if (existsSync(portFile)) port = readFileSync(portFile, "utf8").split("\n")[0]?.trim() ?? "";
      if (!port) await sleep(100);
    }
    if (!port) throw new Error(`Chromium didn't open its debugging port (${exited ?? "timed out"}); see chrome-${this.launches}.log`);
    this.port = port;
    await this.connect();
    await this.worker();
  }

  private port = "";

  /** Playwright's connection to the browser (made again if it loses sight of the worker). */
  private async connect(): Promise<void> {
    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.port}`, { timeout: 30_000 });
    // Playwright takes over downloads even on a browser it only connects to (random names in its
    // own folder). Give them back to the browser, so they land as a person's would.
    const cdp = await this.browser.newBrowserCDPSession();
    await cdp.send("Browser.setDownloadBehavior", { behavior: "default" }).finally(() => cdp.detach().catch(() => undefined));
    this.context = this.browser.contexts()[0]!;
    this.context.setDefaultTimeout(15_000);
    for (const page of this.context.pages()) this.watchPage(page);
    this.context.on("page", (page) => this.watchPage(page));
    this.live = null;
    this.helperPage = null;
  }

  /** Kills the browser the hard way, as a crash would, and starts it again on the same profile (e2e.py's restart_app). */
  async restart(): Promise<void> {
    this.kill("SIGKILL");
    await this.waitForExit(10_000);
    await this.browser.close().catch(() => undefined);
    await this.launch();
    await this.waitUntil(async () => (await this.state()).profile !== "-", 20);
  }

  private kill(signal: NodeJS.Signals): void {
    const pid = this.child?.pid;
    if (!pid || this.child?.exitCode != null || this.child?.signalCode != null) return;
    try {
      if (process.platform !== "win32") process.kill(-pid, signal);
      else this.child?.kill(signal);
    } catch {
      this.child?.kill(signal);
    }
  }

  private async waitForExit(ms: number): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode != null || child.signalCode != null) return;
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(ms)]);
  }

  /** Attaches what the test found, then closes the browser and removes its data. */
  async finish(): Promise<void> {
    try {
      const final = await withTimeout(this.run("state"), 10_000, "the final state").catch((e) => `no state: ${e}`);
      await this.info.attach("final-state.txt", { body: final, contentType: "text/plain" });
      if (this.info.status !== this.info.expectedStatus || this.results.some((r) => r.ok === false)) {
        await this.attachLogs("logs.txt");
      }
    } catch {
      // The report must still get the checks.
    }
    await this.info.attach("cineon-checks", { body: JSON.stringify(this.results), contentType: "application/json" });
    await this.browser?.close().catch(() => undefined);
    this.kill("SIGTERM");
    await this.waitForExit(5_000);
    this.kill("SIGKILL");
    if (!process.env.CINEON_E2E_KEEP) rmSync(this.dataDir, { recursive: true, force: true, maxRetries: 3 });
    else console.log(`    data kept in ${this.dataDir}`);
  }

  private watchPage(page: Page): void {
    const where = () => {
      const url = page.url();
      return url.length > 90 ? url.slice(0, 90) + "…" : url;
    };
    page.on("console", (m) => this.note(`[${where()}] ${m.type()}: ${m.text()}`));
    page.on("pageerror", (e) => this.note(`[${where()}] pageerror: ${e.message}`));
  }

  private note(line: string): void {
    this.consoleLines.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
    if (this.consoleLines.length > 600) this.consoleLines.splice(0, this.consoleLines.length - 600);
  }

  // MARK: The service worker

  /** The extension's service worker, found again if it was stopped or the browser restarted. */
  async worker(): Promise<Worker> {
    if (this.live) return this.live;
    const url = `chrome-extension://${this.id}/background.js`;
    const find = async (): Promise<Worker | null> => {
      const workers = this.context.serviceWorkers();
      const exact = workers.find((w) => w.url() === url);
      if (exact) return exact;
      // A folder reached through a symlink may give another id; look for Cineon by name.
      for (const w of workers.filter((w) => w.url().endsWith("/background.js"))) {
        const name = await w.evaluate(() => chrome.runtime.getManifest().name).catch(() => null);
        if (name === "Cineon") return w;
      }
      return null;
    };
    let worker = await find();
    for (let i = 0; !worker && i < 4; i++) {
      await this.context.waitForEvent("serviceworker", { timeout: 8_000 }).catch(() => null);
      worker = await find();
      // Still nothing: an extension page wakes a worker that has stopped.
      if (!worker && i === 1) {
        this.note("no service worker: opening an extension page to wake it");
        await this.openBackgroundTab(`chrome-extension://${this.id}/popup.html`).catch(() => undefined);
      }
      // Running but not handed to Playwright: a new connection attaches to it afresh.
      if (!worker && i === 2 && this.child?.exitCode == null && this.child?.signalCode == null) {
        this.note(`no service worker (${await this.workerTargets().catch(() => "?")}): connecting again`);
        await this.connect().catch(() => undefined);
        worker = await find();
      }
    }
    if (!worker) {
      const alive = this.child?.exitCode == null && this.child?.signalCode == null;
      const targets = await this.workerTargets().catch((e) => `no target list: ${e}`);
      throw new Error(`Cineon's service worker didn't start (${url}); browser ${alive ? "running" : "gone"}; workers the browser lists: ${targets}`);
    }
    const ready = await this.poll(async () => (await worker!.evaluate(() => typeof (self as any).cineonDebug).catch(() => "")) === "object", 20_000);
    if (!ready) throw new Error("self.cineonDebug is missing: build the development version (node scripts/build.mjs --dev)");
    await worker.evaluate(installLogCapture).catch(() => undefined);
    worker.on("close", () => {
      this.note(`the service worker closed (${worker!.url()})`);
      if (this.live === worker) this.live = null;
    });
    this.live = worker;
    return worker;
  }

  /** The browser's own list of service workers, for a failure's detail. */
  private async workerTargets(): Promise<string> {
    const cdp = await this.browser.newBrowserCDPSession();
    try {
      const { targetInfos } = (await cdp.send("Target.getTargets")) as { targetInfos: { type: string; url: string; attached: boolean }[] };
      return (
        targetInfos
          .filter((t) => t.type === "service_worker")
          .map((t) => `${t.url} (attached=${t.attached})`)
          .join(", ") || "none"
      );
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  }

  /** Runs a function in the service worker (with the session at hand through `self.cineonDebug.runtime`). */
  async inWorker<R, A>(fn: (arg: A) => R | Promise<R>, arg: A, timeoutMs = 60_000): Promise<R> {
    for (let attempt = 0; ; attempt++) {
      const worker = await this.worker();
      try {
        return await withTimeout(worker.evaluate(fn as any, arg) as Promise<R>, timeoutMs, "a call into the service worker");
      } catch (error) {
        if (attempt === 0 && targetClosed(error)) {
          this.live = null;
          continue;
        }
        throw error;
      }
    }
  }

  /** One debug command (notes/runtime.md), answered with the Mac's debug-output text. */
  run(type: string, query: Record<string, string | number | boolean> = {}, timeoutMs = 60_000): Promise<string> {
    const q = Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)]));
    return this.inWorker(([t, args]) => (self as any).cineonDebug.run(t, args) as Promise<string>, [type, q] as const, timeoutMs);
  }

  async state(): Promise<State> {
    return parseFields(await this.run("state"));
  }

  async fields(type: string, query: Record<string, string | number | boolean> = {}, timeoutMs?: number): Promise<State> {
    return parseFields(await this.run(type, query, timeoutMs));
  }

  /** Every row of one of the profile database's stores, with the SQLite column names (e2e.py's `query`). */
  rows<T = Record<string, any>>(store: string): Promise<T[]> {
    return this.inWorker(async (name) => {
      const session = await (self as any).cineonDebug.runtime.ready();
      const db: IDBDatabase = session.db.idb;
      return await new Promise<any[]>((resolve, reject) => {
        const request = db.transaction(name, "readonly").objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }, store);
  }

  async count(store: string, where: (row: Record<string, any>) => boolean = () => true): Promise<number> {
    return (await this.rows(store)).filter(where).length;
  }

  /** The saved frame images' names (the Mac's Frames folder). */
  frameFiles(): Promise<string[]> {
    return this.inWorker(async () => {
      const session = await (self as any).cineonDebug.runtime.ready();
      const db: IDBDatabase = session.db.idb;
      return await new Promise<string[]>((resolve, reject) => {
        const request = db.transaction("frame_files", "readonly").objectStore("frame_files").getAllKeys();
        request.onsuccess = () => resolve((request.result as IDBValidKey[]).map(String));
        request.onerror = () => reject(request.error);
      });
    }, null);
  }

  /** A saved frame's size and how colourful it is: e2e.py's `is_real_picture` (8×4, max − min of the bytes). */
  picture(file: string): Promise<{ width: number; height: number; range: number } | null> {
    return this.inWorker(async (name) => {
      const session = await (self as any).cineonDebug.runtime.ready();
      const data = await session.db.readFrameFile(name);
      if (!data) return null;
      const bitmap = await createImageBitmap(data instanceof Blob ? data : new Blob([data]));
      const canvas = new OffscreenCanvas(8, 4);
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0, 8, 4);
      const pixels = context.getImageData(0, 0, 8, 4).data;
      let low = 255;
      let high = 0;
      pixels.forEach((value, i) => {
        if (i % 4 === 3) return;
        low = Math.min(low, value);
        high = Math.max(high, value);
      });
      return { width: bitmap.width, height: bitmap.height, range: high - low };
    }, file);
  }

  /** IndexedDB databases the extension has (one per profile, `cineon-<UUID>`). */
  databases(): Promise<string[]> {
    return this.inWorker(async () => (await indexedDB.databases()).map((d) => d.name ?? ""), null);
  }

  storage(key: string): Promise<unknown> {
    return this.inWorker(async (k) => (await chrome.storage.local.get(k))[k], key);
  }

  // MARK: Pages

  /** The page world of the selected tab's top frame (e2e.py's `evaluate`). Booleans read "true"/"false". */
  async evaluate(js: string): Promise<string> {
    return (await this.run("eval", { js })).trim();
  }

  /** The same in the frame holding the video (e2e.py's `media_eval`). */
  async mediaEval(js: string): Promise<string> {
    return (await this.run("mediaeval", { js })).trim();
  }

  async openPage(where: string, options: { parsed?: boolean } = {}): Promise<void> {
    const url = where.startsWith("http") ? where : BASE + where;
    await this.run("open", { url });
    const parsed = options.parsed ?? true;
    await this.waitUntil(async () => {
      const s = await this.state();
      return s.url.endsWith(where) && (!parsed || s.parsed !== "-") && s.title !== "-";
    }, 10);
    await sleep(800);
  }

  /** e2e.py's `start_playing`, asked again until the video's frame answers (the page may still be loading its player). */
  async startPlaying(position?: number, options: { muted?: boolean } = {}): Promise<boolean> {
    await sleep(800);
    const seek = position != null ? `v.currentTime=${position};` : "";
    const muted = (options.muted ?? true) ? "v.muted=true; " : "";
    const js = `window.dispatchEvent(new Event('pointerdown')); var v=document.querySelector('video'); ${muted}${seek} v.play(); true`;
    return Boolean(await this.waitUntil(async () => (await this.mediaEval(js)) === "true", 10));
  }

  async mediaPosition(): Promise<number> {
    const media = (await this.state()).media;
    return media !== "-" ? Number.parseFloat(media.split("/")[0]!) : -1;
  }

  /** The current time of the video itself (e2e.py's `player_time`). */
  async playerTime(): Promise<number> {
    const value = Number.parseFloat(await this.mediaEval("String(document.querySelector('video').currentTime)"));
    return Number.isFinite(value) ? value : -1;
  }

  async waitBanner(prefix: string, timeout = 15): Promise<boolean> {
    return Boolean(await this.waitUntil(async () => (await this.state()).banner.startsWith(prefix), timeout));
  }

  /** Web pages among the browser's tabs (the keeper tab and extension pages aren't the person's). */
  static webTabs(s: State): string[] {
    return s.tablist === "-" ? [] : s.tablist.split(",").filter((t) => t.startsWith("http"));
  }

  /** The Playwright page showing the selected tab. */
  async selectedPage(): Promise<Page | null> {
    const url = (await this.state()).url;
    if (url === "-") return null;
    const pages = [...this.context.pages()].reverse();
    return pages.find((p) => p.url() === url) ?? pages.find((p) => p.url().split("#")[0] === url.split("#")[0]) ?? null;
  }

  pageWith(match: (url: string) => boolean): Page | null {
    return [...this.context.pages()].reverse().find((p) => match(p.url())) ?? null;
  }

  /** A real (trusted) click in the selected tab, at a point in its page (e2e.py's `click`). */
  async click(x: number, y: number): Promise<void> {
    const page = await this.selectedPage();
    if (!page) throw new Error("no page for the selected tab");
    await page.mouse.click(Number(x), Number(y));
    await sleep(450);
  }

  /** Closes the selected tab, if it's a web page (never the browser's last, blank tab). */
  async closeTab(): Promise<void> {
    const s = await this.state().catch(() => null);
    if (s && s.url.startsWith("http")) await this.run("closetab");
    await sleep(500);
  }

  /** Where a button of media.js's banner is. The banner's shadow root is closed, so this asks DevTools. */
  async bannerButton(label: string): Promise<Box | null> {
    const page = await this.selectedPage();
    if (!page) return null;
    const cdp = await this.context.newCDPSession(page);
    try {
      const { root } = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: DomNode };
      const textOf = (node: DomNode): string =>
        node.nodeType === 3 ? (node.nodeValue ?? "") : [...(node.children ?? []), ...(node.shadowRoots ?? [])].map(textOf).join("");
      let found: DomNode | null = null;
      const walk = (node: DomNode) => {
        if (found) return;
        if (node.nodeName === "BUTTON" && textOf(node).trim() === label) {
          found = node;
          return;
        }
        for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) walk(child);
      };
      walk(root);
      if (!found) return null;
      const { model } = (await cdp.send("DOM.getBoxModel", { backendNodeId: (found as DomNode).backendNodeId })) as { model: { border: number[] } };
      const q = model.border;
      return { x: Math.round((q[0]! + q[4]!) / 2), y: Math.round((q[1]! + q[5]!) / 2) };
    } catch {
      return null;
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  }

  /** A tab in the background, not selected (an extension page there wakes the worker or sends requests). */
  async openBackgroundTab(url: string): Promise<Page> {
    const cdp = await this.browser.newBrowserCDPSession();
    try {
      await cdp.send("Target.createTarget", { url, background: true });
    } finally {
      await cdp.detach().catch(() => undefined);
    }
    const page = await this.poll(async () => this.pageWith((u) => u === url), 15_000);
    if (!page) throw new Error(`no page for ${url}`);
    return page;
  }

  /** A request of the pages' contract (src/shared/messages.ts), sent from an extension page as the UI does. */
  async ui<T = any>(type: string, payload: Record<string, unknown> = {}): Promise<T | null> {
    if (!this.helperPage || this.helperPage.isClosed()) {
      this.helperPage = await this.openBackgroundTab(`chrome-extension://${this.id}/popup.html?e2e`);
      await this.helperPage.waitForLoadState("domcontentloaded");
    }
    const answer = (await this.helperPage.evaluate(
      ([t, p]) => chrome.runtime.sendMessage({ kind: "cineon/ui", type: t, ...p }),
      [type, payload] as const,
    )) as { ok?: boolean; value?: T } | null;
    return answer?.ok ? (answer.value ?? null) : null;
  }

  /** The profile's settings, as the Cineon page saves them (theme isn't one of the debug settings). */
  updateSettings(change: Record<string, unknown>): Promise<void> {
    return this.inWorker(async (c) => {
      const session = await (self as any).cineonDebug.runtime.ready();
      await session.updateSettings(c);
    }, change);
  }

  // MARK: e2e.py's helpers

  /** A clean library with only local sites, so nothing here searches the real internet. */
  async freshProfile(name: string): Promise<void> {
    await this.run("addprofile", { name, switch: 1 });
    await this.waitUntil(async () => (await this.state()).profile === name, 6);
    await sleep(1000);
    await this.run("removesites");
    await this.run("settings", { minimumSeconds: 5, metadata: 0 });
    await sleep(300);
  }

  async downloadsList(): Promise<Record<string, string>[]> {
    return (await this.run("downloads"))
      .split("\n")
      .filter((l) => l.startsWith("download\t"))
      .map(tabFields);
  }

  async waitUntil<T>(predicate: () => T | Promise<T>, timeoutSeconds = 15, everySeconds = 0.3): Promise<T | null> {
    const deadline = Date.now() + timeoutSeconds * 1000 * SLOW;
    for (;;) {
      let value: T | null = null;
      try {
        value = await predicate();
      } catch {
        value = null;
      }
      if (value) return value;
      if (Date.now() >= deadline) return null;
      await sleep(everySeconds * 1000);
    }
  }

  private async poll<T>(predicate: () => T | Promise<T>, ms: number): Promise<T | null> {
    const deadline = Date.now() + ms;
    for (;;) {
      let value: T | null = null;
      try {
        value = await predicate();
      } catch {
        value = null;
      }
      if (value || Date.now() >= deadline) return value || null;
      await sleep(200);
    }
  }

  // MARK: Checks

  heading(title: string): void {
    console.log(title);
  }

  /** e2e.py's `check`: recorded, printed, a soft failure in the report with the state dump and a screenshot. */
  async check(name: string, ok: unknown, detail: unknown = ""): Promise<boolean> {
    const passed = Boolean(ok);
    const why = text(detail);
    this.results.push({ section: this.section, name, ok: passed, detail: passed ? "" : why.slice(0, 2000) });
    console.log(`  ${passed ? "PASS" : "FAIL"}  ${name}${!passed && why ? `   [${why.slice(0, 400)}]` : ""}`);
    expect.soft(passed, `check failed: ${name}${why ? `   [${why.slice(0, 300)}]` : ""}`).toBe(true);
    if (!passed) await this.evidence(name);
    return passed;
  }

  /** A check of e2e.py's that doesn't apply to an extension, with the reason printed. */
  skip(name: string, reason: string): void {
    this.results.push({ section: this.section, name, ok: null, detail: reason });
    console.log(`  SKIP  ${name}: ${reason}`);
  }

  /** The state dump on every failure, and a screenshot and the logs for the first few. */
  private async evidence(name: string): Promise<void> {
    const slug = name.replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
    try {
      const dump = await withTimeout(Promise.all([this.run("state"), this.run("tabs")]), 15_000, "the state dump");
      await this.info.attach(`state-${slug}.txt`, { body: dump.join("\n\n"), contentType: "text/plain" });
    } catch (error) {
      await this.info.attach(`state-${slug}.txt`, { body: `no state: ${error}`, contentType: "text/plain" }).catch(() => undefined);
    }
    if (this.evidenceTaken >= 8) return;
    this.evidenceTaken += 1;
    try {
      const page = await this.selectedPage();
      if (page) await this.info.attach(`screen-${slug}.png`, { body: await page.screenshot({ timeout: 5_000 }), contentType: "image/png" });
    } catch {
      // A page in a background tab may not draw; the state says enough.
    }
    await this.attachLogs(`console-${slug}.txt`).catch(() => undefined);
  }

  private async attachLogs(name: string): Promise<void> {
    const worker = await this.inWorker(() => ((self as any).__cineonE2eLog as string[] | undefined) ?? [], null, 10_000).catch(() => [] as string[]);
    const body = ["Service worker:", ...worker.slice(-300), "", "Pages:", ...this.consoleLines.slice(-300)].join("\n");
    await this.info.attach(name, { body, contentType: "text/plain" });
  }

  // MARK: Files

  /** Files the browser saved into its downloads folder, recursively. */
  downloadedFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else out.push(full);
      }
    };
    if (existsSync(this.downloadsDir)) walk(this.downloadsDir);
    return out;
  }
}

export function fileSize(file: string | null | undefined): number {
  try {
    return file ? statSync(file).size : -1;
  } catch {
    return -1;
  }
}
