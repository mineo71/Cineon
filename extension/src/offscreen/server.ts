// The offscreen document's side: answers the service worker's calls with a StreamHost, and sends
// its events and header requests back.

import { type StreamHost } from "../core/downloads";
import {
  errorText,
  isStreamMessage,
  type MessageListener,
  type RuntimeMessaging,
  type StreamCall,
  type StreamReply,
} from "./protocol";

/** Serves `host` over runtime messaging. Returns a function that stops serving. */
export function serveStreams(host: StreamHost, runtime: RuntimeMessaging): () => void {
  host.setHandler({
    async hosts(key, urls) {
      const reply = (await runtime.sendMessage({ cineon: "stream-hosts", key, urls })) as StreamReply | undefined;
      if (reply == null || !reply.ok) throw new Error(reply?.ok === false ? reply.error : "No answer about the headers");
    },
    event(event) {
      // Nobody answers events; the promise rejects for that, which is fine.
      runtime.sendMessage({ cineon: "stream-event", event }).catch(() => {});
    },
  });
  const listener: MessageListener = (message, _sender, sendResponse) => {
    if (!isStreamMessage<StreamCall>(message, "stream-call")) return;
    call(host, message).then(
      (value) => sendResponse({ ok: true, value } satisfies StreamReply),
      (error) => sendResponse({ ok: false, error: errorText(error) } satisfies StreamReply),
    );
    return true;
  };
  runtime.onMessage.addListener(listener);
  return () => {
    runtime.onMessage.removeListener(listener);
    host.setHandler(null);
  };
}

async function call(host: StreamHost, message: StreamCall): Promise<unknown> {
  const [first] = message.args;
  switch (message.method) {
    case "start":
      if (typeof first !== "object" || first == null) throw new Error("start needs a job");
      return host.start(first);
    case "stop":
      return host.stop(String(first));
    case "discard":
      return host.discard(String(first));
    case "release":
      return host.release(String(first));
    case "jobs":
      return host.jobs();
    default:
      throw new Error(`Unknown stream call ${String(message.method)}`);
  }
}
