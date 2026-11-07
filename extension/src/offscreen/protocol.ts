// Messages between the service worker's OffscreenStreamWorker and the offscreen document's
// StreamHost, over chrome.runtime messaging. Every message carries `cineon: "stream-…"`; other
// extension pages receive them too and must ignore them (and never answer them).

import { type StreamEvent, type StreamJob } from "../core/downloads";

export type StreamMethod = "start" | "stop" | "discard" | "release" | "jobs";

/** Service worker → offscreen document. Answered with a StreamReply. */
export interface StreamCall {
  readonly cineon: "stream-call";
  readonly method: StreamMethod;
  readonly args: readonly (StreamJob | string)[];
}

/** Offscreen document → service worker, no answer. */
export interface StreamEventMessage {
  readonly cineon: "stream-event";
  readonly event: StreamEvent;
}

/** Offscreen document → service worker: set up the page's headers for these addresses. Answered with a StreamReply. */
export interface StreamHostsMessage {
  readonly cineon: "stream-hosts";
  readonly key: string;
  readonly urls: readonly string[];
}

export type StreamReply = { readonly ok: true; readonly value?: unknown } | { readonly ok: false; readonly error: string };

/** The part of `chrome.runtime` messaging used here. */
export interface RuntimeMessaging {
  sendMessage(message: unknown): Promise<unknown>;
  readonly onMessage: {
    addListener(listener: MessageListener): void;
    removeListener(listener: MessageListener): void;
  };
}

export type MessageListener = (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => boolean | void;

export function isStreamMessage<T extends { cineon: string }>(message: unknown, kind: T["cineon"]): message is T {
  return typeof message === "object" && message != null && (message as { cineon?: unknown }).cineon === kind;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
