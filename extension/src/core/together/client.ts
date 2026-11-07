// Port of Cineon/Core/TogetherClient.swift (the client, the error and ShareCode), by way of
// windows/Cineon.Core/Together/TogetherClient.cs. Talks to Convex's plain HTTP API over fetch.

import { characters } from "./text";

/** The `errorData.code` the server puts on errors it throws on purpose. */
export type TogetherErrorCode = "INVALID_ARGUMENT" | "UNKNOWN_DEVICE" | "NOT_FOUND" | "NOT_MEMBER" | "NOT_HOST" | "PARTY_ENDED";

export const TOGETHER_ERROR_CODES: readonly TogetherErrorCode[] = [
  "INVALID_ARGUMENT",
  "UNKNOWN_DEVICE",
  "NOT_FOUND",
  "NOT_MEMBER",
  "NOT_HOST",
  "PARTY_ENDED",
];

/** Unknown or missing codes are null. */
export function errorCodeFromRaw(raw: string | null | undefined): TogetherErrorCode | null {
  return (TOGETHER_ERROR_CODES as readonly string[]).includes(raw ?? "") ? (raw as TogetherErrorCode) : null;
}

export interface TogetherErrorOptions {
  code?: TogetherErrorCode | null;
  rawCode?: string | null;
  /** The request didn't get an answer: no network, a timeout, a refused connection. */
  isTransport?: boolean;
  cause?: unknown;
}

/**
 * Swift's `TogetherError`: a sentence meant for people, in `message`. Network failures and replies that
 * can't be read arrive as this too, so callers catch one type.
 */
export class TogetherError extends Error {
  override name = "TogetherError";
  /** The server's `errorData.code`, or null when it sent none (or the call never got there). */
  readonly code: TogetherErrorCode | null;
  /** The code exactly as sent, including ones this build doesn't know. */
  readonly rawCode: string | null;
  /** The request didn't get an answer: no network, a timeout, a refused connection. */
  readonly isTransport: boolean;

  constructor(message: string, options: TogetherErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = options.code ?? null;
    this.rawCode = options.rawCode ?? null;
    this.isTransport = options.isTransport ?? false;
  }
}

/** The fetch the client uses: the global one, or a stand-in in tests. */
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ text(): Promise<string> }>;

export interface TogetherClientOptions {
  /** Defaults to the global fetch, looked up on each call. */
  fetch?: Fetch;
  /** How long one call may take: TogetherClient.TIMEOUT_MS, shorter only in tests. */
  timeoutMs?: number;
}

export type ConvexArgs = Record<string, unknown>;

/** Talks to the Together server through Convex's plain HTTP API, so the extension needs no SDK. */
export class TogetherClient {
  /** The dev deployment: development builds and the end-to-end tests. */
  static readonly DEVELOPMENT_URL = "https://stoic-pelican-635.eu-west-1.convex.cloud";
  /** The production deployment: release builds, which is what people install. */
  static readonly PRODUCTION_URL = "https://admired-mouse-481.eu-west-1.convex.cloud";
  /** The Mac's `request.timeoutInterval`. */
  static readonly TIMEOUT_MS = 12_000;

  readonly baseUrl: string;
  private readonly fetchImpl: Fetch | undefined;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, options: TogetherClientOptions = {}) {
    this.baseUrl = baseUrl;
    this.fetchImpl = options.fetch;
    this.timeoutMs = options.timeoutMs ?? TogetherClient.TIMEOUT_MS;
  }

  /**
   * The server this build talks to: `override` when it's set (even to nothing, which turns Together
   * off, like the apps' CINEON_TOGETHER_URL), otherwise `buildUrl` (production unless the build says
   * otherwise). Null when that isn't an http(s) address.
   */
  static configured(
    override: string | null | undefined,
    buildUrl: string | null | undefined = TogetherClient.PRODUCTION_URL,
    options: TogetherClientOptions = {},
  ): TogetherClient | null {
    const raw = override ?? buildUrl ?? "";
    if (raw.length === 0) return null;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (!url.protocol.startsWith("http")) return null;
    return new TogetherClient(raw, options);
  }

  /** Runs a Convex query, such as `parties:get`, and decodes its value. */
  query<T>(path: string, args: ConvexArgs, decode: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
    return this.call("query", path, args, decode, signal);
  }

  /** Runs a Convex mutation, such as `parties:update`. Without a decoder the answer is ignored (Swift's `NullReply`). */
  mutation(path: string, args: ConvexArgs): Promise<void>;
  mutation<T>(path: string, args: ConvexArgs, decode: (value: unknown) => T, signal?: AbortSignal): Promise<T>;
  mutation<T>(path: string, args: ConvexArgs, decode?: (value: unknown) => T, signal?: AbortSignal): Promise<T | void> {
    return this.call("mutation", path, args, decode ?? (() => undefined), signal);
  }

  /** The value as sent, for anything without a decoder. */
  queryRaw(path: string, args: ConvexArgs, signal?: AbortSignal): Promise<unknown> {
    return this.call("query", path, args, (value) => value, signal);
  }

  /** Swift's appendingPathComponent: one slash between the base and `api/<kind>`. */
  endpoint(kind: string): string {
    return this.baseUrl.replace(/\/+$/, "") + "/api/" + kind;
  }

  private async call<T>(kind: string, path: string, args: ConvexArgs, decode: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
    const body = serializeArgs({ path, args, format: "json" });
    if (signal?.aborted) throw signal.reason;
    const fetchImpl = this.fetchImpl ?? (globalThis.fetch.bind(globalThis) as unknown as Fetch);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    let text: string;
    try {
      const response = await fetchImpl(this.endpoint(kind), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
      // Like the Mac, the status line doesn't matter: Convex says what happened in the body.
      text = await response.text();
    } catch (e) {
      if (signal?.aborted && !timedOut) throw signal.reason ?? e;
      if (timedOut) throw new TogetherError("The request timed out.", { isTransport: true, cause: e });
      throw new TogetherError(e instanceof Error ? e.message : String(e), { isTransport: true, cause: e });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    let reply: unknown;
    try {
      reply = JSON.parse(text);
    } catch (e) {
      throw new TogetherError("The Together server sent something unexpected", { cause: e });
    }
    if (typeof reply !== "object" || reply === null || Array.isArray(reply)) {
      throw new TogetherError("The Together server sent something unexpected");
    }
    const r = reply as Record<string, unknown>;
    if (r.status !== "success") throw errorFrom(r);
    const value = Object.prototype.hasOwnProperty.call(r, "value") ? r.value : null;
    try {
      return decode(value === undefined ? null : value);
    } catch (e) {
      if (e instanceof TogetherError) throw e;
      // Swift's DecodingError, as people would see it.
      throw new TogetherError("The data couldn't be read because it isn't in the correct format.", { cause: e });
    }
  }

  /** Convex wraps thrown errors in its own text. Keep the sentence meant for people. */
  static clean(message: string | null | undefined): string {
    if (message === null || message === undefined) return "The Together server didn't answer";
    const marker = "Uncaught Error: ";
    const at = message.indexOf(marker);
    if (at >= 0) {
      const rest = message.slice(at + marker.length);
      // Swift's split drops empty pieces, so a leading newline doesn't make the line empty.
      const line = rest.split("\n").find((piece) => piece.length > 0) ?? rest;
      const beforeStack = line.split("    at ")[0] ?? line;
      return beforeStack.replace(/^[ \t]+|[ \t]+$/g, "");
    }
    return message.split("\n").find((piece) => piece.length > 0) ?? message;
  }
}

function errorFrom(reply: Record<string, unknown>): TogetherError {
  // The server's own sentence for people, when it sent one.
  const data = reply.errorData;
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    if (typeof d.message === "string") {
      const raw = typeof d.code === "string" ? d.code : null;
      return new TogetherError(d.message, { code: errorCodeFromRaw(raw), rawCode: raw });
    }
  }
  const text = typeof reply.errorMessage === "string" ? reply.errorMessage : null;
  return new TogetherError(TogetherClient.clean(text));
}

/** Writes the arguments the Mac builds as `[String: Any]`. Numbers that JSON can't hold are refused. */
export function serializeArgs(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "number" && !Number.isFinite(item)) throw new TogetherError("Invalid number in the request");
    if (typeof item === "bigint") throw new TogetherError("Invalid number in the request");
    return item;
  });
}

/** Codes show as `K7Q-2MX`, and are typed however people like. */
export const ShareCode = {
  normalize(raw: string): string {
    return characters(raw.toUpperCase())
      .filter((c) => /^[\p{Alphabetic}\p{N}]/u.test(c))
      .join("");
  },

  display(code: string): string {
    const clean = characters(ShareCode.normalize(code));
    if (clean.length !== 6) return clean.join("");
    return clean.slice(0, 3).join("") + "-" + clean.slice(3).join("");
  },
};
