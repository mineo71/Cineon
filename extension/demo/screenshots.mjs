// The README's screenshots (docs/media/*.jpg), taken from the demo page (demo/build.mjs, demo/serve.mjs) into
// ../docs/media. The clock is pinned like the video's, so "Today" and "Yesterday" read the same on
// every run.
//
//   node demo/build.mjs && node demo/serve.mjs &
//   node demo/screenshots.mjs
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../../docs/media");
const base = process.env.DEMO_URL ?? "http://localhost:4317/";
await mkdir(out, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" });
await context.clock.install({ time: new Date("2026-11-11T23:10:00") });
const page = await context.newPage();
page.on("pageerror", (error) => console.error("page error:", error.message));

/** Waits for every poster and still on screen, then a beat for fades. */
async function settle() {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(async () => {
    const images = [...document.images].filter((img) => {
      const box = img.getBoundingClientRect();
      return box.bottom > 0 && box.top < innerHeight;
    });
    await Promise.all(images.map((img) => (img.complete ? null : new Promise((done) => { img.onload = img.onerror = done; }))));
  });
  await page.waitForTimeout(900);
}

async function shot(name) {
  await settle();
  // JPEG at 2x: sharp on a Retina screen, a fraction of a PNG's size in the repo.
  await page.screenshot({ path: path.join(out, `${name}.jpg`), type: "jpeg", quality: 88 });
  console.log(`docs/media/${name}.jpg`);
}

async function go(route) {
  await page.evaluate((r) => { location.hash = r; }, route);
  await page.mouse.move(1430, 890);
  await page.evaluate(() => scrollTo(0, 0));
}

await page.goto(`${base}?reset#home`);
await page.getByRole("button", { name: "Resume at 30:23" }).waitFor();
await shot("home");

await go("library");
await shot("library");

await page.getByRole("button", { name: "Severance" }).first().click();
await shot("title");
await page.keyboard.press("Escape");

await page.keyboard.press("ControlOrMeta+K");
await page.locator(".command-field input").pressSequentially("spi", { delay: 40 });
await page.getByRole("option", { name: "Spirited Away Watched" }).waitFor();
await shot("search");
await page.keyboard.press("Escape");

await go("timeline");
await shot("timeline");

await go("profile");
await shot("profile");

await go("rate");
await shot("rate");

await browser.close();
