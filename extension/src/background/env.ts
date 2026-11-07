// What this build is, and small helpers every background module uses. `__TARGET__`, `__VERSION__`
// and `__DEV__` are defined by scripts/build.mjs; under Vitest they're missing, so each is read
// through `typeof`.

declare const __DEV__: boolean | undefined;

export type Target = "chrome" | "firefox";

export function buildTarget(): Target {
  return typeof __TARGET__ === "string" ? __TARGET__ : "chrome";
}

export function buildVersion(): string {
  return typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0";
}

/** Development builds (`node scripts/build.mjs --dev`) carry the debug hooks. */
export function isDevBuild(): boolean {
  return typeof __DEV__ === "boolean" ? __DEV__ : false;
}

/** The clock everything here reads, swappable in tests. Milliseconds since 1970. */
export interface Clock {
  now(): number;
  schedule(ms: number, fn: () => void): () => void;
  every(ms: number, fn: () => void): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  schedule(ms, fn) {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
  every(ms, fn) {
    const handle = setInterval(fn, ms);
    return () => clearInterval(handle);
  },
};

/** Waits on the given clock. */
export function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => clock.schedule(ms, resolve));
}

/** Swift's `url.host`: the host as the URL parser gives it, or null. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

/** The scheme without the colon, lower-cased, or "". */
export function schemeOf(url: string | null | undefined): string {
  if (!url) return "";
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  return match ? match[1]!.toLowerCase() : "";
}

/** A page the extension may script: http(s) only (not the browser's own pages, not the stores). */
export function isWebUrl(url: string | null | undefined): boolean {
  const scheme = schemeOf(url);
  return scheme === "http" || scheme === "https";
}

/** The address without its fragment. */
export function withoutFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

/** Runs a promise without waiting, reporting a failure instead of leaving it unhandled. */
export function detach(promise: Promise<unknown> | unknown): void {
  if (promise instanceof Promise) promise.catch((error) => console.warn("Cineon:", error));
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
