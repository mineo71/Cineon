// End-to-end: Chromium with the unpacked development build (node scripts/build.mjs --dev) against
// the fake streaming site (../fixtures/server.js). See notes/e2e.md.
//
//   npx playwright test                              every section
//   CINEON_E2E_ONLY=autopilot,rescue npx playwright test   just those sections (as e2e.py)
//   CINEON_E2E_HEADLESS=1 …                          Chrome's new headless mode instead of a window
import { defineConfig } from "@playwright/test";

const port = Number(process.env.CINEON_E2E_PORT || 8765);
const only = (process.env.CINEON_E2E_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.e2e\.ts$/,
  globalSetup: "./e2e/setup.ts",
  // One browser at a time: the sections share the fixture site and the machine's media and focus.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 10 * 60_000,
  expect: { timeout: 10_000 },
  grep: only.length ? new RegExp(`\\[(${only.join("|")})\\]`) : undefined,
  outputDir: "test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }], ["./e2e/reporter.ts"]],
  webServer: {
    command: `node ../fixtures/server.js ${port}`,
    url: `http://127.0.0.1:${port}/same-site`,
    // The server remembers which hosts the rescue section killed, so a fresh one is started each run.
    reuseExistingServer: Boolean(process.env.CINEON_E2E_REUSE_SERVER),
    stdout: "ignore",
    stderr: "pipe",
    timeout: 20_000,
  },
});
