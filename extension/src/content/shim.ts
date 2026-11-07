// The page scripts were written for WebKit and post through `window.webkit.messageHandlers.<name>`.
// The build points that lookup at `globalThis.__cineonHandlers`, defined here: each handler sends
// `{ cineon: 1, h: name, b: body }` to the background, and `cineonMediaReply` returns the
// background's answer as a Promise, like WebKit's reply handlers.

export type HandlerName = "cineonMedia" | "cineonMeta" | "cineonMediaReply" | "cineonShield";

export interface PageMessage {
  cineon: 1;
  h: HandlerName;
  b: unknown;
  frame: { url: string; top: boolean };
}

type Send = (message: PageMessage, wantsReply: boolean) => Promise<unknown> | void;

export function installHandlers(send: Send): void {
  const scope = globalThis as unknown as { __cineonHandlers?: unknown };
  if (scope.__cineonHandlers) return;
  const frame = { url: location.href, top: window.top === window };
  const make = (h: HandlerName, withReply: boolean) => ({
    postMessage(b: unknown) {
      const message: PageMessage = { cineon: 1, h, b, frame: { ...frame, url: location.href } };
      return withReply ? send(message, true) : void send(message, false);
    },
  });
  scope.__cineonHandlers = {
    cineonMedia: make("cineonMedia", false),
    cineonMeta: make("cineonMeta", false),
    cineonMediaReply: make("cineonMediaReply", true),
    cineonShield: make("cineonShield", false),
  };
}
