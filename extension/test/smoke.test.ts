import { installHandlers } from "../src/content/shim";

test("the shim gives the page scripts their handlers", () => {
  const sent: unknown[] = [];
  (globalThis as Record<string, unknown>).location = { href: "https://example.test/" };
  (globalThis as Record<string, unknown>).window = { top: null };
  installHandlers((m) => { sent.push(m); });
  const handlers = (globalThis as Record<string, any>).__cineonHandlers;
  handlers.cineonMedia.postMessage({ type: "play" });
  expect(sent).toHaveLength(1);
});
