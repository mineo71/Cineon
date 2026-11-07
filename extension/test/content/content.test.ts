// @vitest-environment jsdom
import { type ContentRuntime, startIsolated } from "../../src/content/bridge";
import { contentHelpers, harvestLinks } from "../../src/content/helpers";
import { installIsolatedRelay, installMainRelay } from "../../src/content/shieldRelay";

function fakeRuntime(answer: (message: unknown) => unknown = () => null) {
  const sent: unknown[] = [];
  const listeners: ((message: unknown, sender: unknown, reply: (a: unknown) => void) => boolean | void)[] = [];
  const ports: { name: string; messages: unknown[]; disconnected: boolean }[] = [];
  const runtime: ContentRuntime = {
    async sendMessage(message) {
      sent.push(message);
      return answer(message);
    },
    onMessage: { addListener: (l) => listeners.push(l) },
    connect: ({ name }) => {
      const port = { name, messages: [] as unknown[], disconnected: false };
      ports.push(port);
      return { postMessage: (m: unknown) => port.messages.push(m), disconnect: () => (port.disconnected = true) };
    },
  };
  return { runtime, sent, ports, deliver: (message: unknown) => listeners.forEach((l) => l(message, {}, () => undefined)) };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the shield relay", () => {
  test("agrees on a secret whichever world starts first, and passes reports on", () => {
    for (const mainFirst of [true, false]) {
      const doc = document.implementation.createHTMLDocument("t");
      const heard: unknown[] = [];
      let report: (body: unknown) => void;
      if (mainFirst) {
        report = installMainRelay(doc, () => "0123456789abcdef-nonce");
        installIsolatedRelay(doc, (b) => heard.push(b));
      } else {
        installIsolatedRelay(doc, (b) => heard.push(b));
        report = installMainRelay(doc, () => "0123456789abcdef-nonce");
      }
      report({ type: "overlay" });
      expect(heard).toEqual([{ type: "overlay" }]);
    }
  });

  test("a page asking later doesn't learn the secret", () => {
    const doc = document.implementation.createHTMLDocument("t");
    const heard: unknown[] = [];
    installMainRelay(doc, () => "0123456789abcdef-nonce");
    installIsolatedRelay(doc, (b) => heard.push(b));
    const leaked: unknown[] = [];
    doc.addEventListener("cineon-shield-hello", (e) => leaked.push((e as CustomEvent).detail));
    doc.dispatchEvent(new CustomEvent("cineon-shield-ask"));
    expect(leaked).toEqual([]);
    // A forged report under a guessed name goes nowhere.
    doc.dispatchEvent(new CustomEvent("cineon-shield-guess", { detail: JSON.stringify({ type: "overlay" }) }));
    expect(heard).toEqual([]);
  });
});

describe("the isolated world", () => {
  beforeEach(() => {
    delete (window as unknown as Record<string, unknown>).__cineonContentStarted;
    delete (globalThis as unknown as Record<string, unknown>).__cineonHandlers;
    document.documentElement.removeAttribute("data-cineon-noshield");
  });

  test("runs media.js everywhere and meta.js in the top frame, and says hello", async () => {
    const ran: string[] = [];
    const { runtime, sent } = fakeRuntime((m) => ((m as { cineon?: string }).cineon === "hello" ? { noShield: true } : null));
    startIsolated({ media: () => ran.push("media"), meta: () => ran.push("meta"), theater: () => ran.push("theater") }, runtime);
    expect(ran).toEqual(["media", "meta"]);
    expect(sent[0]).toEqual({ cineon: "hello", top: true, url: window.location.href });
    await tick();
    expect(document.documentElement.hasAttribute("data-cineon-noshield")).toBe(true);
  });

  test("gives the page scripts handlers that reach the background, with replies", async () => {
    const { runtime, sent } = fakeRuntime((m) => ((m as { h?: string }).h === "cineonMediaReply" ? { seekTo: 42 } : null));
    startIsolated({ media: () => undefined, meta: () => undefined, theater: () => undefined }, runtime);
    const handlers = (globalThis as unknown as { __cineonHandlers: Record<string, { postMessage(b: unknown): unknown }> }).__cineonHandlers;
    expect(handlers.cineonMedia!.postMessage({ type: "play" })).toBeUndefined();
    await expect(handlers.cineonMediaReply!.postMessage({ type: "meta" })).resolves.toEqual({ seekTo: 42 });
    expect(sent).toContainEqual(expect.objectContaining({ cineon: 1, h: "cineonMedia", b: { type: "play" } }));
  });

  test("follows the background's config and holds a port while asked to", async () => {
    vi.useFakeTimers();
    try {
      const { runtime, deliver, ports } = fakeRuntime();
      startIsolated({ media: () => undefined, meta: () => undefined, theater: () => undefined }, runtime);
      deliver({ cineon: "config", noShield: true });
      expect(document.documentElement.hasAttribute("data-cineon-noshield")).toBe(true);
      deliver({ cineon: "config", noShield: false });
      expect(document.documentElement.hasAttribute("data-cineon-noshield")).toBe(false);
      deliver({ cineon: "keepalive", on: true });
      vi.advanceTimersByTime(45_000);
      expect(ports[0]?.messages).toHaveLength(2);
      deliver({ cineon: "keepalive", on: false });
      expect(ports[0]?.disconnected).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a click a page script makes up isn't taken for the person opening a link", () => {
    const { runtime, sent } = fakeRuntime();
    startIsolated({ media: () => undefined, meta: () => undefined, theater: () => undefined }, runtime);
    const link = document.createElement("a");
    link.href = "https://ads.example/win";
    document.body.appendChild(link);
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    expect(sent.some((m) => (m as { cineon?: string }).cineon === "gesture")).toBe(false);
    link.remove();
  });
});

describe("page helpers", () => {
  test("harvests links with the words around them, as the Mac's probe does", () => {
    document.body.innerHTML = `
      <ul><li class="item"><a href="/film/dune"><img alt="Dune poster">Dune</a><span>2021 · Sci-fi</span></li></ul>
      <a href="https://kino.example/film/dune">again</a>
      <a href="javascript:void 0">nothing</a>`;
    const links = harvestLinks(document);
    expect(links).toEqual([
      { href: "http://localhost:3000/film/dune", text: "Dune\nDune poster", context: "Dune2021 · Sci-fi" },
      { href: "https://kino.example/film/dune", text: "again", context: "" },
    ]);
  });

  test("theater mode loads theater.js once, and the viewport is in CSS pixels", () => {
    let runs = 0;
    const scope = window as unknown as { __cineonTheater?: { enable(): boolean; clear(): void } };
    delete scope.__cineonTheater;
    const helpers = contentHelpers(() => {
      runs++;
      scope.__cineonTheater = { enable: () => true, clear: () => undefined };
    });
    expect(helpers.theater(true)).toBe(true);
    expect(helpers.theater(true)).toBe(true);
    expect(helpers.theater(false)).toBe(false);
    expect(runs).toBe(1);
    expect(helpers.viewport()).toEqual({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 });
  });
});
