// `test` with a fresh browser per section: each test is one of e2e.py's sections, in its own
// throwaway browser profile, so a section that fails (or hangs) can't spoil the next one.
import { test as base, type TestInfo } from "@playwright/test";
import { Cineon } from "./cineon.ts";

export { expect } from "@playwright/test";
export { BASE, PORT, ROOT, Cineon, convex, fileSize, sleep } from "./cineon.ts";

export const test = base.extend<{ cineon: Cineon }>({
  cineon: async ({}, use, testInfo) => {
    const cineon = await Cineon.start(testInfo);
    cineon.section = testInfo.title.replace(/^\[([^\]]+)\].*$/, "$1");
    try {
      await use(cineon);
    } finally {
      await cineon.finish();
    }
  },
});

export const minutes = (n: number) => n * 60_000;

/** A section of e2e.py's that only has checks an extension can't do: recorded as skipped, no browser started. */
export async function skipSection(info: TestInfo, checks: readonly (readonly [string, string])[]): Promise<void> {
  const section = info.title.replace(/^\[([^\]]+)\].*$/, "$1");
  const results = checks.map(([name, reason]) => {
    console.log(`  SKIP  ${name}: ${reason}`);
    return { section, name, ok: null, detail: reason };
  });
  await info.attach("cineon-checks", { body: JSON.stringify(results), contentType: "application/json" });
}
