// Writing what the import review kept (BrowserImport.swift's applyImport and ImportResult).
import { describe, expect, it } from "vitest";
import { Database, LibraryStore, UrlKey } from "../../src/core/data";
import { type ImportScan, ImportAnalyzer, DISTANT_PAST } from "../../src/ui/lib/importAnalyzer";
import { applyImport, fileImportSummary, importHistory, importSummary } from "../../src/ui/lib/importApply";

const NOW = 1_760_000_000;
const DAY = 86_400;
let counter = 0;

async function freshLibrary(): Promise<LibraryStore> {
  const db = await Database.open(`cineon-ui-import-${++counter}-${Math.random().toString(36).slice(2)}`);
  return LibraryStore.open(db);
}

function scanOf(): ImportScan {
  return ImportAnalyzer.analyze(
    [
      { url: "https://kinogo.example/film/1234-dune-2021.html", title: "Dune (2021) watch online free", visits: 3, lastVisit: NOW - 200 * DAY, origin: "history" },
      { url: "https://kinogo.example/serial/555-severance/season-1-episode-3.html", title: "Severance season 1 episode 3 watch online", visits: 1, lastVisit: NOW - 10 * DAY, origin: "history" },
      { url: "https://kinogo.example/serial/555-severance/season-1-episode-4.html", title: "Severance S01E04 watch online", visits: 1, lastVisit: NOW - 5 * DAY, origin: "history" },
      { url: "https://other.example/news", title: "Some news", visits: 1, lastVisit: NOW - DAY, origin: "history" },
    ],
    "this browser's history",
    NOW,
  );
}

describe("applyImport", () => {
  it("adds the sites, titles with their visits, and the pages", async () => {
    const library = await freshLibrary();
    const scan = scanOf();
    const result = await applyImport(
      library,
      {
        sites: scan.sites,
        titles: scan.titles.map((candidate) => ({ candidate, status: candidate.suggestedStatus })),
        pages: scan.pages,
      },
      NOW,
    );
    expect(result.sites).toBe(1);
    expect(result.titles).toBe(2);
    expect(result.pages).toBe(4);
    expect(result.newTitleIds).toHaveLength(2);
    expect(importSummary(result)).toBe("Imported 1 site, 2 films and series, 4 pages.");

    expect(library.sites.map((s) => s.host)).toContain("kinogo.example");
    const dune = [...library.titles.values()].find((t) => t.name === "Dune")!;
    expect(dune.status).toBe("watched");
    expect(dune.year).toBe(2021);
    expect(dune.addedAt).toBe(NOW - 200 * DAY);
    expect(dune.finishedAt).toBe(NOW - 200 * DAY);
    expect(dune.lastWatchedAt).toBe(NOW - 200 * DAY);

    const severance = [...library.titles.values()].find((t) => t.name === "Severance")!;
    expect(severance.status).toBe("watching");
    expect(severance.kind).toBe("series");
    expect(severance.finishedAt).toBeNull();
    const progress = library.progressList(severance.id);
    expect(progress.map((p) => p.ref.episode).sort()).toEqual([3, 4]);
    expect(progress.every((p) => p.position === 0 && p.duration === 0)).toBe(true);
    const sessions = await library.db.sessionsForTitle(severance.id);
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.watchedSeconds === 0 && s.startedAt === s.endedAt)).toBe(true);

    const history = await library.db.searchHistory("severance", 10);
    expect(history).toHaveLength(2);
    expect(history[0]!.host).toBe("kinogo.example");
  });

  it("adds nothing new the second time", async () => {
    const library = await freshLibrary();
    const scan = scanOf();
    const selection = {
      sites: scan.sites,
      titles: scan.titles.map((candidate) => ({ candidate, status: candidate.suggestedStatus })),
      pages: scan.pages,
    };
    await applyImport(library, selection, NOW);
    const again = await applyImport(library, selection, NOW);
    expect(again).toEqual({ sites: 0, titles: 0, pages: 0, newTitleIds: [] });
    expect(importSummary(again)).toBe("Nothing new to import.");
    const severance = [...library.titles.values()].find((t) => t.name === "Severance")!;
    expect(await library.db.sessionsForTitle(severance.id)).toHaveLength(2);
  });

  it("keeps a real saved position and recognises a renamed title by its page", async () => {
    const library = await freshLibrary();
    const scan = scanOf();
    const dune = scan.titles.find((t) => t.name === "Dune")!;
    const existing = (await library.addTitle("Дюна", { year: 2021, kind: "film", status: "watching" }))!;
    const visit = dune.visits[0]!;
    await library.saveProgress({
      titleId: existing.id,
      ref: visit.ref,
      urlKey: UrlKey.make(visit.url),
      url: visit.url,
      host: visit.host,
      position: 1234,
      duration: 9000,
      finished: false,
      updatedAt: NOW,
    });
    const result = await applyImport(library, { sites: [], titles: [{ candidate: dune, status: "watched" }], pages: [] }, NOW);
    expect(result.titles).toBe(0);
    expect(library.titles.size).toBe(1);
    expect(library.latestProgress(existing.id)!.position).toBe(1234);
  });

  it("puts backlog choices on no timeline", async () => {
    const library = await freshLibrary();
    const scan = scanOf();
    const dune = scan.titles.find((t) => t.name === "Dune")!;
    await applyImport(library, { sites: [], titles: [{ candidate: dune, status: "backlog" }], pages: [] }, NOW);
    const title = [...library.titles.values()][0]!;
    expect(title.status).toBe("backlog");
    expect(title.lastWatchedAt).toBeNull();
    expect(await library.db.sessionsForTitle(title.id)).toHaveLength(0);
    expect(library.progressList(title.id)).toHaveLength(1);
  });
});

describe("importHistory", () => {
  it("skips pages already there at the same second", async () => {
    const library = await freshLibrary();
    const pages = [
      { url: "https://a.example/1", title: "One", visits: 1, lastVisit: NOW, origin: "history" as const },
      { url: "https://a.example/1", title: "One", visits: 1, lastVisit: NOW - 60, origin: "history" as const },
    ];
    expect(await importHistory(library.db, pages)).toBe(2);
    expect(await importHistory(library.db, [...pages, { ...pages[0]!, url: "https://a.example/2" }])).toBe(1);
    expect(DISTANT_PAST).toBeLessThan(0);
  });
});

describe("summaries", () => {
  it("say what came in", () => {
    expect(importSummary({ sites: 2, titles: 1, pages: 3210 }, "en-US")).toBe("Imported 2 sites, 1 film or series, 3,210 pages.");
    expect(fileImportSummary({ titlesAdded: 3, titlesUpdated: 1, sessionsAdded: 12, sessionsSkipped: 0, titles: [] })).toBe(
      "Imported 3 films and series, 1 updated, 12 viewings on the timeline.",
    );
    expect(fileImportSummary({ titlesAdded: 0, titlesUpdated: 0, sessionsAdded: 0, sessionsSkipped: 4, titles: [] })).toBe("Nothing new to import.");
  });
});
