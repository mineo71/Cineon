// What the command bar lists (CommandBar.swift's idleItems and searchItems, plus the extension's commands).
import { describe, expect, it } from "vitest";
import { LibraryText, Site, Title, type Title as TitleType, WatchProgress } from "../../src/core/data";
import { metadataHit } from "../../src/core/metadata";
import {
  type CommandInputs,
  type CommandLibrary,
  buildCommandItems,
  commandMatches,
  commands,
  listHeight,
  tabsForBar,
  wantsCatalogue,
} from "../../src/ui/lib/commandBar";

function title(id: number, name: string, fields: Partial<TitleType> = {}): TitleType {
  return Title.make({ id, name, normName: LibraryText.normalize(name), status: "backlog", posterUrl: `https://p.example/${id}.jpg`, ...fields });
}

const dune = title(1, "Dune", { imdbId: "tt1160419", status: "watching", year: 2021 });
const severance = title(2, "Severance", { status: "watching", kind: "series" });
const arrival = title(3, "Arrival", { status: "none" });
const sites = [
  Site.make({ id: 10, name: "Tubi", host: "tubitv.com", homeUrl: "https://tubitv.com", searchTemplate: "https://tubitv.com/search/%s" }),
  Site.make({ id: 11, name: "Kinogo", host: "kinogo.example", homeUrl: "https://kinogo.example" }),
  Site.make({ id: 12, name: "Pluto TV", host: "pluto.tv", homeUrl: "https://pluto.tv", searchTemplate: "https://pluto.tv/search/details?query=%s" }),
];

function fakeLibrary(): CommandLibrary {
  const titles = new Map([dune, severance, arrival].map((t) => [t.id, t]));
  return {
    titles,
    sites,
    continueWatching: [
      { title: dune, progress: WatchProgress.make({ titleId: 1, host: "www.kinogo.example", position: 2530, duration: 9000 }) },
      { title: severance, progress: WatchProgress.make({ titleId: 2, host: "www.kinogo.example", position: 0, duration: 0 }) },
    ],
    search(query: string, limit = 8) {
      const needle = LibraryText.normalize(query);
      return [...titles.values()].filter((t) => t.normName.includes(needle)).slice(0, limit);
    },
  };
}

function inputs(text: string, extra: Partial<CommandInputs> = {}): CommandInputs {
  return {
    text,
    library: fakeLibrary(),
    tabs: [{ id: 7, title: "Severance S1E4", url: "https://kinogo.example/s", favIconUrl: null }],
    history: [],
    hits: [],
    searchEngine: "duckDuckGo",
    theme: "dark",
    ...extra,
  };
}

describe("the command bar's items", () => {
  it("offers what to carry on with, open tabs and sites when empty", () => {
    const items = buildCommandItems(inputs("  "));
    expect(items.map((i) => i.id)).toEqual(["continue1", "continue2", "tab7", "site10", "site11", "site12"]);
    expect(items[0]!.secondary).toBe("Resume at 42:10");
    expect(items[1]!.secondary).toBe("Open on kinogo.example");
    expect(items[0]!.action).toEqual({ kind: "resume", titleId: 1 });
    expect(items[2]).toMatchObject({ symbol: "macwindow", primary: "Severance S1E4", secondary: "Switch to tab", action: { kind: "focusTab", tabId: 7 } });
  });

  it("lists searches in the Mac's order", () => {
    const items = buildCommandItems(
      inputs("dune", {
        hits: [
          metadataHit("tt1160419", "Dune", 2021, "film"),
          metadataHit("tt15239678", "Dune: Part Two", 2024, "film", { posterUrl: "https://p.example/d2.jpg" }),
          metadataHit("tt0087182", "Dune", 2000, "series"),
        ],
        history: [{ id: 5, url: "https://kinogo.example/film/dune", host: "kinogo.example", title: "", visitedAt: 0 }],
      }),
    );
    expect(items.map((i) => i.id)).toEqual(["everywhere", "title1", "hittt15239678", "hittt0087182", "history5", "web"]);
    expect(items[0]).toMatchObject({ primary: "Search “dune” on all my sites", secondary: "2 sites", action: { kind: "searchEverywhere", query: "dune" } });
    expect(items[1]).toMatchObject({ primary: "Dune", secondary: "Watching", action: { kind: "openTitle", titleId: 1 } });
    expect(items[2]!.secondary).toBe("Add to backlog, 2024");
    expect(items[3]!.secondary).toBe("Add to backlog, 2000, Series");
    expect(items[4]).toMatchObject({ primary: "https://kinogo.example/film/dune", secondary: "kinogo.example" });
    expect(items[5]).toMatchObject({ primary: "Search the web for “dune”", secondary: "DuckDuckGo", action: { kind: "openUrl", url: "https://duckduckgo.com/?q=dune" } });
  });

  it("goes straight to an address", () => {
    const items = buildCommandItems(inputs("site.to/film"));
    expect(items[0]).toMatchObject({ id: "url", primary: "Go to site.to", action: { kind: "openUrl", url: "https://site.to/film" } });
    expect(wantsCatalogue("site.to/film")).toBe(false);
    expect(wantsCatalogue("d")).toBe(false);
    expect(wantsCatalogue("du")).toBe(true);
  });

  it("finds sites by name or host, and titles in no list without a status", () => {
    const items = buildCommandItems(inputs("TV"));
    expect(items.filter((i) => i.id.startsWith("site")).map((i) => i.primary)).toEqual(["Tubi", "Pluto TV"]);
    const arrivalItem = buildCommandItems(inputs("arriv")).find((i) => i.id === "title3")!;
    expect(arrivalItem.secondary).toBeNull();
  });

  it("offers the import", () => {
    expect(buildCommandItems(inputs("imp")).some((i) => i.id === "import")).toBe(true);
    expect(buildCommandItems(inputs("history import")).some((i) => i.id === "import")).toBe(true);
    expect(buildCommandItems(inputs("dune")).some((i) => i.id === "import")).toBe(false);
  });

  it("runs Cineon's own commands", () => {
    const settings = buildCommandItems(inputs("sett")).find((i) => i.id === "go-settings")!;
    expect(settings).toMatchObject({ primary: "Settings", action: { kind: "go", route: "settings" } });
    expect(buildCommandItems(inputs("rate")).some((i) => i.id === "go-rate")).toBe(true);
    expect(buildCommandItems(inputs("theme")).find((i) => i.id === "theme")).toMatchObject({ primary: "Light theme", action: { kind: "toggleTheme" } });
    expect(buildCommandItems(inputs("theme", { theme: "white" })).find((i) => i.id === "theme")!.primary).toBe("Dark theme");
    expect(buildCommandItems(inputs("who")).some((i) => i.id === "profiles")).toBe(true);
    // A word has to start with the text: "e" matches nothing in the middle of a word.
    expect(commandMatches({ name: "Timeline", secondary: "Section" }, "line")).toBe(false);
    expect(commandMatches({ name: "Add a site…", secondary: null }, "site")).toBe(true);
    expect(commands("dark")).toHaveLength(12);
  });
});

describe("helpers", () => {
  it("sizes the list to its rows", () => {
    expect(listHeight(3)).toBe(3 * 39 + 14);
    expect(listHeight(30)).toBe(420);
  });

  it("offers web tabs, most recently used first, not this page", () => {
    const tabs = tabsForBar(
      [
        { id: 1, url: "https://a.example", title: "A", lastAccessed: 10 } as chrome.tabs.Tab,
        { id: 2, url: "chrome://extensions", title: "Extensions", lastAccessed: 30 } as chrome.tabs.Tab,
        { id: 3, url: "https://b.example", title: "B", lastAccessed: 20, favIconUrl: "https://b.example/f.ico" } as chrome.tabs.Tab,
        { id: 4, url: "https://self.example/app.html", title: "Cineon", lastAccessed: 40 } as chrome.tabs.Tab,
      ],
      "https://self.example/app.html",
    );
    expect(tabs).toEqual([
      { id: 3, title: "B", url: "https://b.example", favIconUrl: "https://b.example/f.ico" },
      { id: 1, title: "A", url: "https://a.example", favIconUrl: null },
    ]);
  });
});

describe("command matching", () => {
  it("doesn't show every section for text that only matches the word Section", async () => {
    const { commandMatches, commands } = await import("../../src/ui/lib/commandBar");
    const all = commands("dark");
    expect(all.filter((c) => commandMatches(c, "se")).map((c) => c.name)).toEqual(["Settings"]);
    expect(all.filter((c) => commandMatches(c, "theme")).map((c) => c.name)).toEqual(["Light theme"]);
  });
});
