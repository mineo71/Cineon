// What the Settings page says, worked out from settings, stats and the browser: pure, tested in
// test/ui/settings.test.ts.

import type { ImportResult, ShieldStats } from "../../core/data";
import type { CloudSnapshot } from "../../shared/messages";
import { DateText, fileSize, grouped } from "./format";

/** The Mac's percent labels: `Int(value * 100)`. */
export function percentText(value: number): string {
  return `${Math.trunc(Math.round(value * 1000) / 10)}%`;
}

/** "20 min", or "Never" at 0. */
export function idleTabsText(minutes: number): string {
  return minutes === 0 ? "Never" : `${Math.trunc(minutes)} min`;
}

/** "Blocked so far: 1,204 ads and trackers, 31 pop-ups, 4 redirects, 9 click traps." */
export function blockedSummary(stats: ShieldStats, locale?: string): string {
  return `Blocked so far: ${grouped(stats.ads, locale)} ads and trackers, ${grouped(stats.popups, locale)} pop-ups, ${grouped(stats.redirects, locale)} redirects, ${grouped(stats.overlays, locale)} click traps.`;
}

/** A filter list's note: its summary, and how many rules it compiled to once known. */
export function listDetail(summary: string, rules: number | undefined, locale?: string): string {
  return rules == null ? summary : `${summary}. ${grouped(rules, locale)} rules.`;
}

/** "Delete frames (412 MB)". */
export function framesButtonLabel(bytes: number): string {
  return bytes > 0 ? `Delete frames (${fileSize(bytes)})` : "Delete frames";
}

/** A recovery code long enough to try (the Mac's 32 characters). */
export function canRestore(code: string): boolean {
  return code.length >= 32;
}

/** What importing a library file did, for a toast. */
export function importResultText(result: ImportResult | null): string {
  if (result == null) return "That file isn't a Cineon library export";
  const parts: string[] = [];
  if (result.titlesAdded > 0) parts.push(`${result.titlesAdded} ${result.titlesAdded === 1 ? "title" : "titles"} added`);
  if (result.titlesUpdated > 0) parts.push(`${result.titlesUpdated} updated`);
  if (result.sessionsAdded > 0) parts.push(`${result.sessionsAdded} ${result.sessionsAdded === 1 ? "session" : "sessions"} on the timeline`);
  return parts.length === 0 ? "Nothing new in that file" : `Imported: ${parts.join(", ")}`;
}

/** One line of the shortcuts list. */
export interface ShortcutRow {
  readonly label: string;
  readonly keys: string;
}

/** The manifest's commands and their suggested keys, for when the browser can't say. */
export const DEFAULT_COMMANDS: readonly { name: string; description: string; key: string }[] = [
  { name: "play-pause", description: "Play or pause", key: "P" },
  { name: "save-moment", description: "Save this moment", key: "M" },
  { name: "download-video", description: "Download this video", key: "S" },
  { name: "find-elsewhere", description: "Find this on another site", key: "E" },
];

/** Alt+Shift+key as the browser writes it: "⌥⇧P" on a Mac. */
export function defaultCommandKeys(key: string, mac: boolean): string {
  return mac ? `⌥⇧${key}` : `Alt+Shift+${key}`;
}

/**
 * The extension's commands with the keys they have now (`chrome.commands.getAll()`), in the
 * manifest's order; a command with no key says so. Without an answer, the manifest's defaults.
 */
export function commandRows(
  commands: readonly { name?: string; description?: string; shortcut?: string }[] | null,
  mac: boolean,
): ShortcutRow[] {
  if (commands == null) {
    return DEFAULT_COMMANDS.map((c) => ({ label: c.description, keys: defaultCommandKeys(c.key, mac) }));
  }
  const order = new Map(DEFAULT_COMMANDS.map((c, i) => [c.name, i]));
  return commands
    .filter((c) => c.name != null && !c.name.startsWith("_execute") && (c.description ?? "").length > 0)
    .sort((a, b) => (order.get(a.name!) ?? 99) - (order.get(b.name!) ?? 99))
    .map((c) => ({ label: c.description!, keys: c.shortcut && c.shortcut.length > 0 ? c.shortcut : "Not set" }));
}

/** ProfileSession.latestPosterURL: what this person is watching, else what they watched or want to. */
export function latestPosterUrl(library: {
  readonly continueWatching: readonly { readonly title: { readonly posterUrl: string | null } }[];
  readonly watched: readonly { readonly posterUrl: string | null }[];
  readonly backlog: readonly { readonly posterUrl: string | null }[];
}): string | null {
  return library.continueWatching[0]?.title.posterUrl ?? library.watched[0]?.posterUrl ?? library.backlog[0]?.posterUrl ?? null;
}

/** The Cineon page's own keys. `search` is ⌘K or Ctrl+K. */
export function pageShortcutRows(search: string): ShortcutRow[] {
  return [
    { label: "Search films and sites", keys: search },
    { label: "Close the card, sheet or menu on top", keys: "Esc" },
    { label: "Rate mode: rate one to ten stars", keys: "1 to 0" },
    { label: "Rate mode: half a star more or less", keys: "← →" },
    { label: "Rate mode: skip", keys: "Return or Space" },
  ];
}
