// The offscreen document (Chrome only; offscreen.html, built by scripts/build.mjs). It saves streams
// for the service worker: segments fetched with the browser's cookies, written to OPFS, joined, and
// handed back as an object URL that chrome.downloads saves. It stays open across service worker
// restarts, so a stream keeps going while the worker sleeps.

import { documentStreamHost } from "./client";
import { type RuntimeMessaging } from "./protocol";
import { serveStreams } from "./server";

serveStreams(documentStreamHost(), chrome.runtime as unknown as RuntimeMessaging);
