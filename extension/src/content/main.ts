// Runs in the page's own world, like the Mac's shield.js: it has to see the page's clicks before the
// page does. Its one message handler, `cineonShield`, goes through the relay to the isolated world
// (shieldRelay.ts), which alone may talk to the background.
import runShield from "@page-run/shield.js";
import { installMainRelay } from "./shieldRelay";

const scope = globalThis as unknown as { __cineonHandlers?: unknown };
if (!scope.__cineonHandlers) {
  const report = installMainRelay();
  // shield.js looks this up once, when it starts. The page can see it, as it could see
  // window.webkit.messageHandlers on the Mac; all it can do with it is add to a counter.
  scope.__cineonHandlers = { cineonShield: { postMessage: report } };
  runShield();
}
