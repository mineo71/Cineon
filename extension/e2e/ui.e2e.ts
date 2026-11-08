// The Cineon page (app.html), the side panel (app.html#panel) and the toolbar popup (popup.html):
// every route opens and draws in both themes, with a screenshot of each for the report. Not in
// e2e.py (the Mac's screens have their own checks there: "the {route} page opens", in profile.e2e.ts).
import type { Page } from "@playwright/test";
import { minutes, sleep, test } from "./test.ts";

const ROUTES = ["home", "library", "timeline", "downloads", "together", "profile", "rate", "settings"];
/** The profile's theme setting and how the screenshots are named. */
const THEMES: [string, string][] = [
  ["dark", "dark"],
  ["white", "light"],
];

async function shoot(page: Page, info: import("@playwright/test").TestInfo, name: string): Promise<void> {
  const file = info.outputPath(`screens/${name}.png`);
  await page.screenshot({ path: file, timeout: 10_000 });
  await info.attach(`${name}.png`, { path: file, contentType: "image/png" });
}

test("[ui] the Cineon page, side panel and popup draw in both themes", async ({ cineon: c }) => {
  test.setTimeout(minutes(8));
  c.heading("The Cineon page in both themes");
  await c.run("seed");
  const errors: string[] = [];
  const app = await c.context.newPage();
  app.on("pageerror", (e) => errors.push(`${app.url()}: ${e.message}`));

  for (const [theme, label] of THEMES) {
    await c.updateSettings({ theme });
    for (const route of ROUTES) {
      // A fresh load each time, so every screen also boots on its own.
      await app.goto("about:blank");
      await app.goto(`chrome-extension://${c.id}/app.html#${route}`);
      const shown = await app
        .locator(`main.page.route-${route}`)
        .waitFor({ state: "attached", timeout: 15_000 })
        .then(() => true, () => false);
      const bar = await app.locator('nav[aria-label="Sections"]').isVisible().catch(() => false);
      const themed = await app.evaluate(() => document.documentElement.dataset.theme).catch(() => "?");
      await sleep(700);
      await shoot(app, c.info, `app-${route}-${label}`);
      await c.check(`the ${route} screen draws (${label})`, shown && bar && themed === theme, `route=${shown} bar=${bar} theme=${themed}`);
    }
    // The layout is chosen when the page loads, so this is a fresh load too, not a hash change.
    await app.goto("about:blank");
    await app.goto(`chrome-extension://${c.id}/app.html#panel`);
    const panel = await app.locator(".side-panel").waitFor({ timeout: 15_000 }).then(() => true, () => false);
    await sleep(500);
    await shoot(app, c.info, `panel-${label}`);
    await c.check(`the side panel draws (${label})`, panel, app.url());
  }
  await c.check("no errors on the Cineon page", errors.length === 0, errors.slice(0, 5).join(" | "));
  await app.close();

  c.heading("The toolbar popup");
  for (const [theme, label] of THEMES) {
    await c.updateSettings({ theme });
    // On its own tab the popup is on one of the browser's own pages: only "Open Cineon".
    const own = await c.context.newPage();
    await own.setViewportSize({ width: 360, height: 560 });
    await own.goto(`chrome-extension://${c.id}/popup.html`);
    const note = await own
      .locator(".pop-note")
      .first()
      .textContent({ timeout: 10_000 })
      .catch(() => "");
    await shoot(own, c.info, `popup-restricted-${label}`);
    await c.check(`the popup on a browser page only offers to open Cineon (${label})`, /belongs to the browser/.test(note ?? ""), note);
    await own.close();
  }

  // On a film's tab. A real popup belongs to the toolbar, which Playwright can't open, so the popup
  // page is opened in a tab and told which tab is "active" (chrome.tabs.query is the only way it asks).
  const opened = await c.fields("open", { url: "http://127.0.0.1:8765/watch/dune-part-two-2024" });
  const tabId = Number(opened.tab);
  await c.waitUntil(async () => (await c.state()).parsed.startsWith("Dune"), 15);
  for (const [theme, label] of THEMES) {
    await c.updateSettings({ theme });
    const popup = await c.context.newPage();
    await popup.setViewportSize({ width: 360, height: 600 });
    await popup.addInitScript((id: number) => {
      const tabs = chrome.tabs;
      const query = tabs.query.bind(tabs);
      (tabs as { query: unknown }).query = (info: chrome.tabs.QueryInfo, ...rest: unknown[]) =>
        info && info.active && info.currentWindow ? tabs.get(id).then((t) => [t]) : (query as (...a: unknown[]) => unknown)(info, ...rest);
    }, tabId);
    await popup.goto(`chrome-extension://${c.id}/popup.html`);
    const name = await popup
      .locator(".pop-film .pop-name")
      .textContent({ timeout: 15_000 })
      .catch(() => "");
    const shields = await popup
      .locator(".pop-shields-label")
      .textContent({ timeout: 5_000 })
      .catch(() => "");
    await sleep(500);
    await shoot(popup, c.info, `popup-film-${label}`);
    await c.check(`the popup shows the film on this tab and its shields (${label})`, /Dune/.test(name ?? "") && /Shields on/.test(shields ?? ""), `${name} | ${shields}`);
    await popup.close();
  }
});
