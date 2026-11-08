// Prints e2e.py's ending: "N of M passed", then what failed and what was skipped and why. Each test
// attaches its checks as `cineon-checks`; a section that stopped on an error counts as one failure
// ("section '…' finished without an error"), as in e2e_windows.py.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FullConfig, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

interface Check {
  section: string;
  name: string;
  ok: boolean | null;
  detail: string;
}

export default class CheckReporter implements Reporter {
  private readonly checks: Check[] = [];
  private outputDir = "test-results";

  onBegin(config: FullConfig): void {
    this.outputDir = config.projects[0]?.outputDir ?? path.join(config.rootDir, "test-results");
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const section = test.title.replace(/^\[([^\]]+)\].*$/, "$1");
    const attachment = result.attachments.find((a) => a.name === "cineon-checks");
    let checks: Check[] = [];
    if (attachment?.body) {
      try {
        checks = JSON.parse(attachment.body.toString("utf8")) as Check[];
      } catch {
        checks = [];
      }
    }
    this.checks.push(...checks);
    // Failed checks are soft assertions whose message starts "check failed:"; anything else stopped the section.
    const crashed = result.errors.filter((e) => !(e.message ?? "").includes("check failed: "));
    if ((result.status === "failed" || result.status === "timedOut") && (crashed.length > 0 || result.status === "timedOut")) {
      const detail = result.status === "timedOut" ? `timed out after ${Math.round(result.duration / 1000)} s` : (crashed[0]?.message ?? "").split("\n")[0]!;
      this.checks.push({ section, name: `section '${test.title}' finished without an error`, ok: false, detail });
    }
  }

  onEnd(): void {
    const run = this.checks.filter((c) => c.ok !== null);
    const failed = run.filter((c) => c.ok === false);
    const skipped = this.checks.filter((c) => c.ok === null);
    const lines: string[] = [];
    lines.push("");
    lines.push(`${run.length - failed.length} of ${run.length} passed (${skipped.length} skipped)`);
    if (failed.length) {
      lines.push("Failed:");
      for (const c of failed) lines.push(`  [${c.section}] ${c.name}${c.detail ? `   [${c.detail.slice(0, 300)}]` : ""}`);
    }
    if (skipped.length) {
      lines.push("Skipped:");
      for (const c of skipped) lines.push(`  [${c.section}] ${c.name}: ${c.detail}`);
    }
    const summary = lines.join("\n");
    console.log(summary);
    try {
      mkdirSync(this.outputDir, { recursive: true });
      writeFileSync(path.join(this.outputDir, "e2e-summary.txt"), summary.trimStart() + "\n");
      writeFileSync(path.join(this.outputDir, "e2e-checks.json"), JSON.stringify(this.checks, null, 1));
    } catch {
      // The console has it.
    }
    const step = process.env.GITHUB_STEP_SUMMARY;
    if (step) {
      const md = [
        `### Extension end-to-end: ${run.length - failed.length} of ${run.length} passed, ${skipped.length} skipped`,
        "",
        ...(failed.length ? ["**Failed**", "", ...failed.map((c) => `- [${c.section}] ${c.name}${c.detail ? ` — \`${c.detail.slice(0, 200).replace(/`/g, "'")}\`` : ""}`), ""] : []),
        "<details><summary>Skipped</summary>",
        "",
        ...skipped.map((c) => `- [${c.section}] ${c.name}: ${c.detail}`),
        "",
        "</details>",
        "",
      ].join("\n");
      try {
        appendFileSync(step, md);
      } catch {
        // Not on GitHub.
      }
    }
  }

  printsToStdio(): boolean {
    return true;
  }
}
