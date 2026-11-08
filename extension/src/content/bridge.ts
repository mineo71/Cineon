// The isolated world's side of every frame (the Mac's private script world): runs media.js in every
// frame and meta.js in the top one, gives them their message handlers, relays shield.js's reports
// from the page's world, applies what the background says (the overlay sweeper switch), tells it
// about links the person opens in a new tab (the pop-up shield's "real click"), keeps a port open
// when the background must stay awake (Firefox), and offers `window.__cineonContent`.

import { contentHelpers } from "./helpers";
import { installRedirectShield } from "./redirectShield";
import { installIsolatedRelay } from "./shieldRelay";
import { installHandlers, type PageMessage } from "./shim";

export interface ContentRuntime {
  sendMessage(message: unknown): Promise<unknown>;
  readonly onMessage: {
    addListener(listener: (message: unknown, sender: unknown, reply: (answer: unknown) => void) => boolean | void): void;
  };
  connect(info: { name: string }): { postMessage(message: unknown): void; disconnect(): void };
}

export interface PageScriptRunners {
  media: () => void;
  meta: () => void;
  theater: () => void;
}

export const KEEPALIVE_PORT = "cineon-keepalive";

/** Sends to the background; a reloaded extension leaves an orphaned script whose calls throw. */
function safeSend(runtime: ContentRuntime, message: unknown): Promise<unknown> {
  try {
    return runtime.sendMessage(message).catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

function setNoShield(doc: Document, on: boolean): void {
  const apply = () => doc.documentElement?.toggleAttribute("data-cineon-noshield", on);
  if (doc.documentElement) apply();
  else doc.addEventListener("DOMContentLoaded", apply, { once: true });
}

export function startIsolated(scripts: PageScriptRunners, runtime: ContentRuntime, win: Window = window): void {
  const scope = win as unknown as { __cineonContentStarted?: boolean; __cineonContent?: unknown };
  if (scope.__cineonContentStarted) return;
  scope.__cineonContentStarted = true;
  const doc = win.document;
  const isTop = win.top === win;

  installHandlers((message, wantsReply) => {
    const sent = safeSend(runtime, message);
    return wantsReply ? sent : undefined;
  });

  installIsolatedRelay(doc, (body) => {
    const message: PageMessage = { cineon: 1, h: "cineonShield", b: body, frame: { url: win.location.href, top: isTop } };
    void safeSend(runtime, message);
  });

  // The redirect shield (top frame): the page's site while the background says its redirects are
  // shielded. Set by hello's answer, a config push, or the background's call once the page turns
  // out to be a film.
  let redirectSite: string | null = null;
  const setRedirectShield = (on: unknown, site: unknown) => {
    if (isTop && typeof on === "boolean") redirectSite = on && typeof site === "string" && site.length > 0 ? site : null;
  };
  if (isTop) installRedirectShield(win, () => redirectSite, (url) => void safeSend(runtime, { cineon: "redirect", url }));

  scope.__cineonContent = {
    ...contentHelpers(scripts.theater, win),
    redirectShield(on: boolean, site: string): boolean {
      setRedirectShield(on, site);
      return redirectSite != null;
    },
  };

  // What the background wants this frame to know, and its element-hiding CSS (inserted by it).
  void safeSend(runtime, { cineon: "hello", top: isTop, url: win.location.href }).then((config) => {
    const c = config as { noShield?: unknown; redirectShield?: unknown; site?: unknown } | null;
    if (c && typeof c.noShield === "boolean") setNoShield(doc, c.noShield);
    if (c) setRedirectShield(c.redirectShield, c.site);
  });

  let port: { postMessage(message: unknown): void; disconnect(): void } | null = null;
  let pinger: ReturnType<typeof setInterval> | null = null;
  try {
    runtime.onMessage.addListener((message) => {
      const m = message as { cineon?: unknown; noShield?: unknown; on?: unknown; redirectShield?: unknown; site?: unknown } | null;
      if (!m || typeof m !== "object") return;
      if (m.cineon === "config" && typeof m.noShield === "boolean") setNoShield(doc, m.noShield);
      if (m.cineon === "config") setRedirectShield(m.redirectShield, m.site);
      if (m.cineon === "keepalive" && isTop) {
        if (m.on === true && !port) {
          try {
            port = runtime.connect({ name: KEEPALIVE_PORT });
            pinger = setInterval(() => port?.postMessage({ ping: Date.now() }), 20_000);
          } catch {
            port = null;
          }
        } else if (m.on === false && port) {
          if (pinger) clearInterval(pinger);
          pinger = null;
          port.disconnect();
          port = null;
        }
      }
    });
  } catch {
    // An orphaned script can't listen any more.
  }

  // A link opened in a new tab on purpose (a modifier or the middle button) isn't a pop-up.
  const noteLink = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    const newTab = event.button === 1 || event.metaKey || event.ctrlKey || event.shiftKey;
    if (!newTab) return;
    const target = event.target as Element | null;
    const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!anchor?.href) return;
    void safeSend(runtime, { cineon: "gesture", link: { url: anchor.href, newTab: true } });
  };
  win.addEventListener("click", noteLink, { capture: true, passive: true });
  win.addEventListener("auxclick", noteLink, { capture: true, passive: true });

  scripts.media();
  if (isTop) scripts.meta();
}
