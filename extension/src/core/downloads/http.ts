// Port of windows/Cineon.Core/Downloads/DownloadHttp.cs for fetch.
//
// The browser sends its own cookies and browser name with `credentials: "include"`; the Referer and
// Origin the site expects can't be set on fetch (forbidden headers), so a declarativeNetRequest rule
// adds them (see HeaderRules in browser.ts). What's left here: Accept, Range, the 60-second idle
// timeout, and turning failures into the apps' errors.

import {
  DownloadHttpError,
  DownloadNetworkError,
  DownloadStoppedError,
  DownloadTimeoutError,
} from "./errors";
import { type HlsByteRange } from "./hlsPlaylist";

/** `fetch`, or anything shaped like it (tests pass a fake). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class DownloadHttp {
  /** No data for this long fails a request, like the Mac's `timeoutIntervalForRequest`. */
  idleTimeout = 60_000;

  constructor(private readonly fetcher: FetchLike) {}

  /**
   * A whole response, or the range asked for. Throws DownloadHttpError for HTTP errors,
   * DownloadTimeoutError, DownloadNetworkError, or DownloadStoppedError when `signal` aborts.
   */
  async getBytes(url: string, range: HlsByteRange | null, signal?: AbortSignal): Promise<Uint8Array> {
    const headers: Record<string, string> = { Accept: "*/*" };
    if (range != null) headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
    const idle = new IdleTimer(this.idleTimeout, signal);
    try {
      let response: Response;
      try {
        response = await this.fetcher(url, {
          headers,
          credentials: "include",
          cache: "no-store",
          redirect: "follow",
          signal: idle.signal,
        });
      } catch (error) {
        throw idle.translate(error, "connect");
      }
      if (response.status >= 400) {
        await response.body?.cancel().catch(() => {});
        throw new DownloadHttpError(response.status);
      }
      let bytes: Uint8Array;
      try {
        bytes = await readAll(response, () => idle.touch());
      } catch (error) {
        throw idle.translate(error, "lost");
      }
      // A server that ignores Range sends the whole resource: cut the part that was asked for.
      if (range != null && response.status === 200 && bytes.length >= range.offset + range.length) {
        bytes = bytes.slice(range.offset, range.offset + range.length);
      }
      return bytes;
    } finally {
      idle.dispose();
    }
  }

  async getText(url: string, signal?: AbortSignal): Promise<string> {
    return new TextDecoder().decode(await this.getBytes(url, null, signal));
  }

  /**
   * The status a GET for the first byte gets, or null when nothing answered. Used once a browser
   * download failed with SERVER_FAILED, to word the error as the apps do.
   */
  async status(url: string): Promise<number | null> {
    const idle = new IdleTimer(this.idleTimeout);
    try {
      const response = await this.fetcher(url, {
        headers: { Accept: "*/*", Range: "bytes=0-0" },
        credentials: "include",
        cache: "no-store",
        signal: idle.signal,
      });
      await response.body?.cancel().catch(() => {});
      return response.status;
    } catch {
      return null;
    } finally {
      idle.dispose();
    }
  }
}

/** Reads a body, calling `chunk` as data arrives (so the idle timer starts over). */
async function readAll(response: Response, chunk: () => void): Promise<Uint8Array> {
  if (response.body == null) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunk();
    parts.push(value);
    total += value.length;
  }
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** An abort signal that fires when the caller's does, or when no data came for `timeout` ms. */
class IdleTimer {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timedOut = false;
  private readonly onAbort = () => this.controller.abort();

  constructor(
    private readonly timeout: number,
    private readonly outer?: AbortSignal,
  ) {
    if (outer?.aborted) this.controller.abort();
    else outer?.addEventListener("abort", this.onAbort, { once: true });
    this.touch();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  touch(): void {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.controller.abort();
    }, this.timeout);
  }

  translate(error: unknown, stage: "connect" | "lost"): Error {
    if (this.outer?.aborted) return new DownloadStoppedError();
    if (this.timedOut) return new DownloadTimeoutError();
    if (error instanceof DownloadHttpError) return error;
    return new DownloadNetworkError(stage);
  }

  dispose(): void {
    if (this.timer != null) clearTimeout(this.timer);
    this.outer?.removeEventListener("abort", this.onAbort);
  }
}
