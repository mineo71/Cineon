import { describe, expect, it } from "vitest";
import { ShieldStats, Title } from "../../src/core/data";
import {
  blockedSummary,
  canRestore,
  commandRows,
  defaultCommandKeys,
  framesButtonLabel,
  idleTabsText,
  importResultText,
  latestPosterUrl,
  listDetail,
  pageShortcutRows,
  percentText,
} from "../../src/ui/lib/settings";

describe("Settings page", () => {
  it("writes the sliders' values as the Mac does", () => {
    expect(percentText(0.92)).toBe("92%");
    expect(percentText(0.55)).toBe("55%");
    expect(percentText(0.7)).toBe("70%");
    expect(percentText(1)).toBe("100%");
    expect(idleTabsText(0)).toBe("Never");
    expect(idleTabsText(20)).toBe("20 min");
  });

  it("totals what shields blocked", () => {
    expect(blockedSummary(ShieldStats.make({ ads: 1204, popups: 31, redirects: 4, overlays: 9 }), "en-US")).toBe(
      "Blocked so far: 1,204 ads and trackers, 31 pop-ups, 4 redirects, 9 click traps.",
    );
    expect(listDetail("The main list of ads", undefined)).toBe("The main list of ads");
    expect(listDetail("The main list of ads", 52310, "en-US")).toBe("The main list of ads. 52,310 rules.");
  });

  it("names the frames button with their size", () => {
    expect(framesButtonLabel(0)).toBe("Delete frames");
    expect(framesButtonLabel(412_000_000)).toBe("Delete frames (412 MB)");
  });

  it("only restores codes long enough to be one", () => {
    expect(canRestore("x".repeat(31))).toBe(false);
    expect(canRestore("x".repeat(44))).toBe(true);
  });

  it("reports a library import", () => {
    expect(importResultText(null)).toBe("That file isn't a Cineon library export");
    const empty = { titlesAdded: 0, titlesUpdated: 0, sessionsAdded: 0, sessionsSkipped: 3, titles: [] };
    expect(importResultText(empty)).toBe("Nothing new in that file");
    expect(importResultText({ ...empty, titlesAdded: 1, titlesUpdated: 2, sessionsAdded: 14 })).toBe(
      "Imported: 1 title added, 2 updated, 14 sessions on the timeline",
    );
  });

  it("lists the extension's commands with their keys, in the manifest's order", () => {
    expect(commandRows(null, false)).toEqual([
      { label: "Play or pause", keys: "Alt+Shift+P" },
      { label: "Save this moment", keys: "Alt+Shift+M" },
      { label: "Download this video", keys: "Alt+Shift+S" },
      { label: "Find this on another site", keys: "Alt+Shift+E" },
    ]);
    expect(defaultCommandKeys("P", true)).toBe("⌥⇧P");
    const fromBrowser = [
      { name: "_execute_action", description: "", shortcut: "" },
      { name: "find-elsewhere", description: "Find this on another site", shortcut: "" },
      { name: "play-pause", description: "Play or pause", shortcut: "⌥⇧P" },
    ];
    expect(commandRows(fromBrowser, true)).toEqual([
      { label: "Play or pause", keys: "⌥⇧P" },
      { label: "Find this on another site", keys: "Not set" },
    ]);
    expect(pageShortcutRows("Ctrl+K")[0]).toEqual({ label: "Search films and sites", keys: "Ctrl+K" });
  });

  it("picks the profile's latest poster as the Mac does", () => {
    const poster = (url: string | null) => Title.make({ posterUrl: url });
    expect(latestPosterUrl({ continueWatching: [{ title: poster("a") }], watched: [poster("b")], backlog: [poster("c")] })).toBe("a");
    expect(latestPosterUrl({ continueWatching: [], watched: [poster("b")], backlog: [poster("c")] })).toBe("b");
    expect(latestPosterUrl({ continueWatching: [], watched: [], backlog: [poster("c")] })).toBe("c");
    expect(latestPosterUrl({ continueWatching: [], watched: [], backlog: [] })).toBeNull();
  });
});
