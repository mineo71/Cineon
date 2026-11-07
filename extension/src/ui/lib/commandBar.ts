// What the command bar lists (CommandBar.swift's idleItems / searchItems), as plain data: an item
// says what to show and names its action; the view runs it. Tested in test/ui/commandBar.test.ts.

import {
  type AppTheme,
  DomainName,
  type HistoryEntry,
  SearchEngine,
  type Site,
  Timecode,
  type Title,
  TitleStatus,
  type WatchProgress,
} from "../../core/data";
import type { MetadataHit } from "../../core/metadata";
import type { Route } from "./app";
import { directUrl, hostOf, isVisitOnly } from "./format";

export type CommandAction =
  | { readonly kind: "resume"; readonly titleId: number }
  | { readonly kind: "focusTab"; readonly tabId: number }
  | { readonly kind: "openSite"; readonly siteId: number }
  | { readonly kind: "openUrl"; readonly url: string }
  | { readonly kind: "searchEverywhere"; readonly query: string }
  | { readonly kind: "openTitle"; readonly titleId: number }
  | { readonly kind: "addHit"; readonly hit: MetadataHit }
  | { readonly kind: "import" }
  | { readonly kind: "go"; readonly route: Route }
  | { readonly kind: "toggleTheme" }
  | { readonly kind: "profilePicker" }
  | { readonly kind: "addTitle" }
  | { readonly kind: "addSite" };

export interface CommandItem {
  readonly id: string;
  /** An icon name (components/Icon); null for posters, which are taller. */
  readonly symbol: string | null;
  readonly imageUrl: string | null;
  readonly primary: string;
  readonly secondary: string | null;
  readonly action: CommandAction;
}

/** An open browser tab, the parts the bar shows. */
export interface CommandTab {
  readonly id: number;
  readonly title: string;
  readonly url: string;
  readonly favIconUrl: string | null;
}

/** The parts of the library the bar reads (a LibraryStore fits). */
export interface CommandLibrary {
  readonly titles: ReadonlyMap<number, Title>;
  readonly sites: readonly Site[];
  readonly continueWatching: readonly { title: Title; progress: WatchProgress }[];
  search(query: string, limit?: number): Title[];
}

export interface CommandInputs {
  readonly text: string;
  readonly library: CommandLibrary;
  readonly tabs: readonly CommandTab[];
  /** Pages from the browsing history matching the text (`db.searchHistory(text, 5)`). */
  readonly history: readonly HistoryEntry[];
  /** Catalogue hits for the text. */
  readonly hits: readonly MetadataHit[];
  readonly searchEngine: SearchEngine;
  readonly theme: AppTheme;
}

/** The text the bar searches for: trimmed. */
export function trimmedQuery(text: string): string {
  return text.trim();
}

/** Whether the catalogue is worth asking (CommandBar.searchMetadata's guard, minus the setting). */
export function wantsCatalogue(text: string): boolean {
  const trimmed = trimmedQuery(text);
  return [...trimmed].length >= 2 && directUrl(trimmed) == null;
}

export function buildCommandItems(inputs: CommandInputs): CommandItem[] {
  const text = trimmedQuery(inputs.text);
  return text.length === 0 ? idleItems(inputs) : searchItems(text, inputs);
}

function idleItems(inputs: CommandInputs): CommandItem[] {
  const out: CommandItem[] = [];
  for (const { title, progress } of inputs.library.continueWatching.slice(0, 3)) {
    out.push({
      id: `continue${title.id}`,
      symbol: null,
      imageUrl: title.posterUrl,
      primary: title.name,
      secondary: isVisitOnly(progress)
        ? `Open on ${DomainName.registrable(progress.host)}`
        : `Resume at ${Timecode.string(progress.position)}`,
      action: { kind: "resume", titleId: title.id },
    });
  }
  for (const tab of inputs.tabs.slice(0, 4)) {
    out.push({
      id: `tab${tab.id}`,
      symbol: "macwindow",
      imageUrl: tab.favIconUrl,
      primary: tab.title || tab.url,
      secondary: "Switch to tab",
      action: { kind: "focusTab", tabId: tab.id },
    });
  }
  for (const site of inputs.library.sites.slice(0, 4)) {
    out.push(siteItem(site));
  }
  return out;
}

function siteItem(site: Site): CommandItem {
  return {
    id: `site${site.id}`,
    symbol: "globe",
    imageUrl: site.iconUrl,
    primary: site.name,
    secondary: site.host,
    action: { kind: "openSite", siteId: site.id },
  };
}

/** `localizedCaseInsensitiveContains`. */
function containsIgnoringCase(haystack: string, needle: string): boolean {
  return haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

interface Command {
  readonly id: string;
  readonly name: string;
  readonly symbol: string;
  readonly secondary: string | null;
  readonly action: CommandAction;
}

/** The extension's own commands: Cineon's sections and the Mac's menu items. */
export function commands(theme: AppTheme): Command[] {
  const section = (route: Route, name: string, symbol: string): Command => ({
    id: `go-${route}`,
    name,
    symbol,
    secondary: "Section",
    action: { kind: "go", route },
  });
  return [
    section("home", "Home", "house"),
    section("library", "Library", "film.stack"),
    section("timeline", "Timeline", "clock"),
    section("downloads", "Downloads", "arrow.down.circle"),
    section("together", "Together", "person.2"),
    section("profile", "Profile", "person.crop.circle"),
    section("rate", "Rate films", "star.leadinghalf.filled"),
    section("settings", "Settings", "gearshape"),
    {
      id: "theme",
      name: theme === "dark" ? "Light theme" : "Dark theme",
      symbol: theme === "dark" ? "sun.max" : "moon.fill",
      secondary: "Switch theme",
      action: { kind: "toggleTheme" },
    },
    { id: "profiles", name: "Who's watching…", symbol: "person.2", secondary: null, action: { kind: "profilePicker" } },
    { id: "add-title", name: "Add a film…", symbol: "plus", secondary: null, action: { kind: "addTitle" } },
    { id: "add-site", name: "Add a site…", symbol: "globe", secondary: null, action: { kind: "addSite" } },
  ];
}

/** A command matches when its name, or one of its words, starts with the text (or the hint does). */
export function commandMatches(command: Pick<Command, "name" | "secondary">, text: string): boolean {
  const needle = text.toLocaleLowerCase();
  // "Section" describes every section; it's no reason to show them all for "se".
  const extra = command.secondary === "Section" ? "" : command.secondary ?? "";
  const words = [command.name, extra]
    .join(" ")
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter((w) => w.length > 0);
  return command.name.toLocaleLowerCase().startsWith(needle) || words.some((w) => w.startsWith(needle));
}

function searchItems(text: string, inputs: CommandInputs): CommandItem[] {
  const out: CommandItem[] = [];
  const { library } = inputs;

  const url = directUrl(text);
  if (url) {
    out.push({ id: "url", symbol: "arrow.up.forward", imageUrl: null, primary: `Go to ${hostOf(url) ?? text}`, secondary: null, action: { kind: "openUrl", url } });
  }

  const searchable = library.sites.filter((s) => s.searchTemplate != null).length;
  out.push({
    id: "everywhere",
    symbol: "square.stack.3d.up",
    imageUrl: null,
    primary: `Search “${text}” on all my sites`,
    secondary: `${searchable} sites`,
    action: { kind: "searchEverywhere", query: text },
  });

  for (const title of library.search(text, 5)) {
    out.push({
      id: `title${title.id}`,
      symbol: null,
      imageUrl: title.posterUrl,
      primary: title.name,
      secondary: title.status === "none" ? null : TitleStatus.label(title.status),
      action: { kind: "openTitle", titleId: title.id },
    });
  }

  for (const site of library.sites) {
    if (containsIgnoringCase(site.name, text) || containsIgnoringCase(site.host, text)) out.push(siteItem(site));
  }

  const known = new Set<string>();
  for (const title of library.titles.values()) if (title.imdbId) known.add(title.imdbId);
  for (const hit of inputs.hits.slice(0, 5)) {
    if (known.has(hit.id)) continue;
    const subtitle = ["Add to backlog", hit.year != null ? String(hit.year) : null, hit.kind === "series" ? "Series" : null]
      .filter((p): p is string => p != null)
      .join(", ");
    out.push({
      id: `hit${hit.id}`,
      symbol: null,
      imageUrl: hit.posterUrl,
      primary: hit.name,
      secondary: subtitle,
      action: { kind: "addHit", hit },
    });
  }

  for (const entry of inputs.history.slice(0, 5)) {
    out.push({
      id: `history${entry.id}`,
      symbol: "clock",
      imageUrl: null,
      primary: entry.title.length === 0 ? entry.url : entry.title,
      secondary: entry.host,
      action: { kind: "openUrl", url: entry.url },
    });
  }

  const lower = text.toLowerCase();
  if ("import".startsWith(lower) || lower.includes("import")) {
    out.push({
      id: "import",
      symbol: "square.and.arrow.down",
      imageUrl: null,
      primary: "Import from this browser's history",
      secondary: "Or a Cineon library file",
      action: { kind: "import" },
    });
  }

  for (const command of commands(inputs.theme)) {
    if (!commandMatches(command, text)) continue;
    out.push({ id: command.id, symbol: command.symbol, imageUrl: null, primary: command.name, secondary: command.secondary, action: command.action });
  }

  const web = SearchEngine.url(inputs.searchEngine, text);
  if (web) {
    out.push({
      id: "web",
      symbol: "magnifyingglass",
      imageUrl: null,
      primary: `Search the web for “${text}”`,
      secondary: SearchEngine.label(inputs.searchEngine),
      action: { kind: "openUrl", url: web },
    });
  }
  return out;
}

/** The list's height: sized to its rows, at most 420 (a scroll view takes all it's offered). */
export function listHeight(count: number): number {
  return Math.min(420, count * 39 + 14);
}

/** Open tabs worth offering: web pages, most recently used first, not this one. */
export function tabsForBar(tabs: readonly chrome.tabs.Tab[], selfUrl: string | null): CommandTab[] {
  return tabs
    .filter((t) => t.id != null && t.url != null && /^https?:/i.test(t.url) && t.url !== selfUrl)
    .sort((a, b) => ((b as { lastAccessed?: number }).lastAccessed ?? 0) - ((a as { lastAccessed?: number }).lastAccessed ?? 0))
    .map((t) => ({ id: t.id!, title: t.title ?? "", url: t.url!, favIconUrl: t.favIconUrl ?? null }));
}
