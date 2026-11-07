import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Envelope,
  SignalChannel,
  UI_MESSAGE,
  contextId,
  isUiRequest,
  listenForUiRequests,
  send,
  setTransport,
} from "../../src/shared/messages";

afterEach(() => setTransport(undefined));

/** A fake runtime: the background's listeners, called as chrome.runtime.onMessage would. */
function fakeRuntime() {
  const listeners: ((message: unknown, sender: chrome.runtime.MessageSender, reply: (a: unknown) => void) => boolean | undefined)[] = [];
  return {
    onMessage: { addListener: (l: (typeof listeners)[number]) => listeners.push(l) } as unknown as typeof chrome.runtime.onMessage,
    transport: {
      sendMessage: (message: unknown) =>
        new Promise<unknown>((resolve) => {
          let handled = false;
          for (const listener of listeners) {
            if (listener(message, {}, resolve) === true) handled = true;
          }
          // Chrome answers undefined when nobody keeps the channel open.
          if (!handled) resolve(undefined);
        }),
    },
  };
}

describe("send", () => {
  it("gives null when there is no background at all", async () => {
    setTransport(null);
    expect(await send("ping", {})).toBeNull();
  });

  it("gives null when the background isn't listening (Receiving end does not exist)", async () => {
    setTransport({ sendMessage: () => Promise.reject(new Error("Could not establish connection. Receiving end does not exist.")) });
    expect(await send("downloads.state", {})).toBeNull();
  });

  it("gives null after the timeout", async () => {
    vi.useFakeTimers();
    setTransport({ sendMessage: () => new Promise(() => undefined) });
    const answer = send("together.state", {}, { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1001);
    expect(await answer).toBeNull();
    vi.useRealTimers();
  });

  it("gives null for an error envelope", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setTransport({ sendMessage: async () => ({ ok: false, error: "boom" }) satisfies Envelope<unknown> });
    expect(await send("ping", {})).toBeNull();
    warn.mockRestore();
  });

  it("round-trips through listenForUiRequests, marked as a UI request", async () => {
    const runtime = fakeRuntime();
    const seen: unknown[] = [];
    listenForUiRequests(
      {
        ping: () => ({ version: "1.1.0", target: "chrome" }),
        "player.command": async (payload) => {
          seen.push(payload);
          return { ok: true };
        },
        "player.active": () => ({ tab: null }),
      },
      runtime,
    );
    setTransport(runtime.transport);
    expect(await send("ping", {})).toEqual({ version: "1.1.0", target: "chrome" });
    expect(await send("player.command", { tabId: 7, command: { kind: "skip", seconds: -10 } })).toEqual({ ok: true });
    expect(seen[0]).toMatchObject({ kind: UI_MESSAGE, type: "player.command", tabId: 7, command: { kind: "skip", seconds: -10 } });
    // A null answer is a real answer, wrapped so it isn't mistaken for silence.
    expect(await send("player.active", {})).toEqual({ tab: null });
    // No handler: no answer.
    expect(await send("downloads.state", {})).toBeNull();
  });

  it("turns a handler's error into an error envelope", async () => {
    const runtime = fakeRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    listenForUiRequests({ "tabs.focus": () => Promise.reject(new Error("No tab with id: 3")) }, runtime);
    const reply = await runtime.transport.sendMessage({ kind: UI_MESSAGE, type: "tabs.focus", tabId: 3 });
    expect(reply).toEqual({ ok: false, error: "No tab with id: 3" });
    warn.mockRestore();
  });

  it("leaves other extension messages to other listeners", () => {
    expect(isUiRequest({ kind: UI_MESSAGE, type: "ping" })).toBe(true);
    expect(isUiRequest({ type: "media", t: 3 })).toBe(false);
    expect(isUiRequest(null)).toBe(false);
  });
});

describe("SignalChannel", () => {
  it("delivers to other contexts and never back to the poster", async () => {
    const name = `test-${Math.random()}`;
    const a = new SignalChannel(name);
    const b = new SignalChannel(name);
    const heardByA: string[] = [];
    const heardByB: { type: string; origin: string }[] = [];
    a.on((s) => heardByA.push(s.type));
    b.on((s) => heardByB.push({ type: s.type, origin: s.origin }));
    // Both live in this one test context, so they share contextId: a real page and the worker
    // differ. Post with another origin by hand to check delivery, and with ours to check echoes.
    const raw = new BroadcastChannel(name);
    raw.postMessage({ type: "toast", text: "hi", origin: "someone-else" });
    a.post({ type: "settings", profileId: "P" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(heardByB).toEqual([{ type: "toast", origin: "someone-else" }]);
    expect(heardByA).toEqual(["toast"]);
    expect(contextId.length).toBeGreaterThan(8);
    a.close();
    b.close();
    raw.close();
  });
});
