// Runs in every frame, in the extension's isolated world (the Mac's private script world). The page
// scripts are the Mac's own files, wrapped in functions at build time (scripts/build.mjs,
// `@page-run/*`), so nothing is evaluated from a string.
import runMedia from "@page-run/media.js";
import runMeta from "@page-run/meta.js";
import runTheater from "@page-run/theater.js";
import { type ContentRuntime, startIsolated } from "./bridge";

startIsolated({ media: runMedia, meta: runMeta, theater: runTheater }, chrome.runtime as unknown as ContentRuntime);
