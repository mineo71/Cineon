// Before any browser starts: the development build and the fixture media must be there.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DIST, ROOT } from "./cineon.ts";

export default function setup(): void {
  const background = path.join(DIST, "background.js");
  if (!existsSync(background)) throw new Error("Build first: node scripts/build.mjs --dev");
  if (!readFileSync(background, "utf8").includes("cineonDebug")) {
    throw new Error("dist/chrome is a release build. The end-to-end test needs the debug hooks: node scripts/build.mjs --dev");
  }
  for (const name of ["film.mp4", "short.mp4", "hls/index.m3u8"]) {
    if (!existsSync(path.join(ROOT, "fixtures", name))) {
      throw new Error(`Make the fixtures first: fixtures/${name} is missing (make fixtures/film.mp4 fixtures/hls/index.m3u8, needs ffmpeg)`);
    }
  }
}
