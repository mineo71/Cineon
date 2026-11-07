// The background's side of the stream worker.
//
// Chrome: the service worker has no object URLs and is stopped when idle, so streams run in an
// offscreen document (reasons BLOBS and WORKERS) that outlives it. OffscreenStreamWorker opens the
// document when needed and talks to it over chrome.runtime messaging. Create it at the top level of
// the service worker, before any await, so its message listener is there when an event from the
// document wakes the worker; events that arrive before DownloadCenter.open sets the handler wait.
//
// Firefox: the background is an event page with a DOM, so it runs the StreamHost itself.

import { ObjectUrls, PartStore, StreamHost, type StreamEvent, type StreamHandler, type StreamJob, type StreamJobState, type StreamWorker } from "../core/downloads";
import {
  errorText,
  isStreamMessage,
  type MessageListener,
  type RuntimeMessaging,
  type StreamEventMessage,
  type StreamHostsMessage,
  type StreamMethod,
  type StreamReply,
} from "./protocol";

export const OFFSCREEN_PATH = "offscreen.html";
const JUSTIFICATION =
  "Saves streamed films: fetches their segments, joins them into one file in the extension's storage, and hands it to the browser's downloads.";

/** The part of `chrome` the document needs (offscreen and runtime.getContexts). */
export interface OffscreenApi {
  readonly runtime: { getURL(path: string): string; getContexts(filter: object): Promise<unknown[]> };
  readonly offscreen: { createDocument(parameters: object): Promise<void> };
}

let creating: Promise<void> | null = null;

/** Whether the offscreen document is open. */
export async function offscreenDocumentExists(api: OffscreenApi = globalThis.chrome as unknown as OffscreenApi): Promise<boolean> {
  const url = api.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await api.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
  return contexts.length > 0;
}

/** Opens the offscreen document unless it's open. Only one can exist; concurrent calls share one creation. */
export async function ensureOffscreenDocument(api: OffscreenApi = globalThis.chrome as unknown as OffscreenApi): Promise<void> {
  if (await offscreenDocumentExists(api)) return;
  creating ??= api.offscreen
    .createDocument({ url: OFFSCREEN_PATH, reasons: ["BLOBS", "WORKERS"], justification: JUSTIFICATION })
    .finally(() => {
      creating = null;
    });
  await creating;
}

export interface OffscreenStreamWorkerOptions {
  runtime?: RuntimeMessaging;
  /** Opens the document (ensureOffscreenDocument by default). */
  ensure?: () => Promise<void>;
  /** Whether it's open (offscreenDocumentExists by default). */
  exists?: () => Promise<boolean>;
}

/** StreamWorker over the offscreen document (Chrome). */
export class OffscreenStreamWorker implements StreamWorker {
  private handler: StreamHandler | null = null;
  private readonly waiting: StreamEvent[] = [];
  private readonly runtime: RuntimeMessaging;
  private readonly ensure: () => Promise<void>;
  private readonly exists: () => Promise<boolean>;

  private readonly listener: MessageListener = (message, _sender, sendResponse) => {
    if (isStreamMessage<StreamEventMessage>(message, "stream-event")) {
      if (this.handler != null) this.handler.event(message.event);
      else this.waiting.push(message.event);
      return;
    }
    if (isStreamMessage<StreamHostsMessage>(message, "stream-hosts")) {
      const handler = this.handler;
      (handler != null ? handler.hosts(message.key, [...message.urls]) : Promise.resolve()).then(
        () => sendResponse({ ok: true } satisfies StreamReply),
        (error) => sendResponse({ ok: false, error: errorText(error) } satisfies StreamReply),
      );
      return true;
    }
  };

  constructor(options: OffscreenStreamWorkerOptions = {}) {
    this.runtime = options.runtime ?? (globalThis.chrome.runtime as unknown as RuntimeMessaging);
    this.ensure = options.ensure ?? (() => ensureOffscreenDocument());
    this.exists = options.exists ?? (() => offscreenDocumentExists());
    this.runtime.onMessage.addListener(this.listener);
  }

  setHandler(handler: StreamHandler | null): void {
    this.handler = handler;
    if (handler != null) for (const event of this.waiting.splice(0)) handler.event(event);
  }

  async start(job: StreamJob): Promise<void> {
    await this.ensure();
    await this.call("start", job);
  }

  async stop(key: string): Promise<void> {
    if (await this.exists()) await this.call("stop", key);
  }

  async discard(key: string): Promise<void> {
    await this.ensure();
    await this.call("discard", key);
  }

  async release(key: string): Promise<void> {
    await this.ensure();
    await this.call("release", key);
  }

  async jobs(): Promise<StreamJobState[]> {
    if (!(await this.exists())) return [];
    return ((await this.call("jobs")) as StreamJobState[] | undefined) ?? [];
  }

  /** Stops listening (the profile closed). */
  dispose(): void {
    this.runtime.onMessage.removeListener(this.listener);
    this.handler = null;
  }

  private async call(method: StreamMethod, ...args: (StreamJob | string)[]): Promise<unknown> {
    const reply = (await this.runtime.sendMessage({ cineon: "stream-call", method, args })) as StreamReply | undefined;
    if (reply == null) throw new Error("The stream worker didn't answer");
    if (!reply.ok) throw new Error(reply.error);
    return reply.value;
  }
}

/** A StreamHost for a document (Firefox's background page, the offscreen document): OPFS, fetch, object URLs. */
export function documentStreamHost(): StreamHost {
  return new StreamHost({
    parts: () => PartStore.open(),
    fetch: (input, init) => globalThis.fetch(input, init),
    objectUrls: ObjectUrls.browser(),
  });
}

/** The stream worker for this build: the offscreen document in Chrome, the background page itself in Firefox. */
export function createStreamWorker(target: "chrome" | "firefox" = __TARGET__): StreamWorker {
  return target === "firefox" ? documentStreamHost() : new OffscreenStreamWorker();
}
