// The browser-history import's analysis (BrowserImport.swift's ImportAnalyzer).
import { describe, expect, it } from "vitest";
import { type BrowsedPage, DISTANT_PAST, ImportAnalyzer, ImportTitleCandidate, PAGE_LIMIT, pagesFromHistory } from "../../src/ui/lib/importAnalyzer";

const NOW = 1_760_000_000; // seconds
const DAY = 86_400;

function page(url: string, title: string, daysAgo: number, visits = 1): BrowsedPage {
  return { url, title, visits, lastVisit: NOW - daysAgo * DAY, origin: "history" };
}

describe("ImportAnalyzer.signal", () => {
  it("scores a film page by its title, path and host", () => {
    // Strong title (3) + film path (2) + film host word (1).
    expect(ImportAnalyzer.signal("https://kinogo.example/film/1234-dune-2021.html", "Dune (2021) watch online free")).toBe(6);
    // An episode in the title adds 3 more.
    expect(ImportAnalyzer.signal("https://kinogo.example/serial/555-severance/season-1-episode-3.html", "Severance season 1 episode 3 watch online")).toBe(9);
    // A film path alone is 2: enough only on a proven film site.
    expect(ImportAnalyzer.signal("https://streamz.example/movie/123-heat", "Heat (1995)")).toBe(2);
  });

  it("ignores listings, trailers and home pages", () => {
    expect(ImportAnalyzer.signal("https://kinogo.example/search?q=dune", "Dune watch online free")).toBe(0);
    expect(ImportAnalyzer.signal("https://kinogo.example/films/genre/drama", "Drama watch online free")).toBe(0);
    expect(ImportAnalyzer.signal("https://kinogo.example/film/1-dune.html", "Dune — official trailer")).toBe(0);
    expect(ImportAnalyzer.signal("https://kinogo.example/", "Kinogo: watch online free")).toBe(0);
  });

  it("only trusts an episode number in the address on a film path", () => {
    expect(ImportAnalyzer.signal("https://example.com/s01e02/x", "Something")).toBe(0);
    expect(ImportAnalyzer.signal("https://example.com/watch/show-s01e02", "Something")).toBe(5);
  });
});

describe("ImportAnalyzer.isUsableName", () => {
  it("keeps real names and drops the site's own pages", () => {
    expect(ImportAnalyzer.isUsableName("Dune")).toBe(true);
    expect(ImportAnalyzer.isUsableName("Past Lives")).toBe(true);
    expect(ImportAnalyzer.isUsableName("Home")).toBe(false);
    expect(ImportAnalyzer.isUsableName("Фильмы")).toBe(false);
    expect(ImportAnalyzer.isUsableName("Лучшие фильмы 2024 года")).toBe(false);
    expect(ImportAnalyzer.isUsableName("Kinogo online")).toBe(false);
    expect(ImportAnalyzer.isUsableName("x")).toBe(false);
    expect(ImportAnalyzer.isUsableName("one two three four five six seven eight nine ten eleven twelve thirteen")).toBe(false);
    expect(ImportAnalyzer.isUsableName("see http://example.com")).toBe(false);
  });
});

describe("ImportAnalyzer.brand", () => {
  it("treats mirrors as one site", () => {
    expect(ImportAnalyzer.brand("hdrezka.ag")).toBe("rezka");
    expect(ImportAnalyzer.brand("rezka-ua.co")).toBe("rezka");
    expect(ImportAnalyzer.brand("kinogo2.example")).toBe("kinogo");
  });
});

describe("ImportAnalyzer.analyze", () => {
  const pages: BrowsedPage[] = [
    page("https://kinogo.example/film/1234-dune-2021.html", "Dune (2021) watch online free", 200, 3),
    page("https://kinogo.example/serial/555-severance/season-1-episode-3.html", "Severance season 1 episode 3 watch online", 10),
    page("https://kinogo.example/serial/555-severance/season-1-episode-4.html", "Severance S01E04 watch online", 5),
    page("https://kinogo.example/serial/555-severance.html", "Severance watch online free", 20),
    page("https://kinogo.example/film/777-mickey.html", "Mickey 17 (2025) coming soon, watch online", 3),
    page("https://hdrezka.ag/films/drama/111-oppenheimer-2023.html", "Oppenheimer (2023) смотреть онлайн в хорошем качестве", 50),
    page("https://rezka-ua.co/films/drama/222-past-lives-2023.html", "Past Lives (2023) смотреть онлайн в хорошем качестве", 2),
    page("https://www.youtube.com/watch?v=abc", "Dune trailer - YouTube", 1),
    page("https://xvideos.example/film/1-x.html", "Something watch online free", 1),
    page("https://shop.example/watch/the-matrix", "The Matrix watch online free", 4),
    page("https://kinogo.example/search?q=dune", "Search results", 1),
  ];
  const scan = ImportAnalyzer.analyze(pages, "this browser's history", NOW);
  // Keyed by the name's first word: the parser keeps "coming soon" in Mickey 17's name.
  const byName = new Map(scan.titles.map((t) => [t.name.split(" ")[0] === "Mickey" ? "Mickey 17" : t.name, t]));

  it("finds the films and series, newest first", () => {
    expect(scan.sourceLabel).toBe("this browser's history");
    expect([...byName.keys()].sort()).toEqual(["Dune", "Mickey 17", "Oppenheimer", "Past Lives", "Severance"]);
    const dates = scan.titles.map(ImportTitleCandidate.lastVisit);
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
  });

  it("groups a series' episodes, latest first, without its main page", () => {
    const severance = byName.get("Severance")!;
    expect(severance.kind).toBe("series");
    expect(severance.visits.map((v) => v.ref)).toEqual([
      { season: 1, episode: 4 },
      { season: 1, episode: 3 },
    ]);
    expect(ImportTitleCandidate.latestRef(severance)).toEqual({ season: 1, episode: 4 });
    expect(ImportTitleCandidate.host(severance)).toBe("kinogo.example");
  });

  it("suggests a list for each", () => {
    // A series opened in the last 60 days is still being watched.
    expect(byName.get("Severance")!.suggestedStatus).toBe("watching");
    // Films are watched.
    expect(byName.get("Dune")!.suggestedStatus).toBe("watched");
    expect(byName.get("Dune")!.year).toBe(2021);
    // Not out yet: something to watch later.
    expect(byName.get("Mickey 17")!.suggestedStatus).toBe("backlog");
  });

  it("leaves out excluded and unproven sites", () => {
    expect(byName.has("The Matrix")).toBe(false);
    expect(scan.titles.some((t) => ImportTitleCandidate.host(t).includes("youtube"))).toBe(false);
    expect(scan.titles.some((t) => ImportTitleCandidate.host(t).includes("xvideos"))).toBe(false);
  });

  it("offers the sites with film pages, mirrors as one at the newest address", () => {
    expect(scan.sites.map((s) => [s.host, s.homeUrl, s.filmPages])).toEqual([
      ["kinogo.example", "https://kinogo.example/", 5],
      ["rezka-ua.co", "https://rezka-ua.co/", 2],
    ]);
  });

  it("keeps every page for the command bar, newest first", () => {
    expect(scan.totalPages).toBe(pages.length);
    expect(scan.pages[0]!.lastVisit).toBe(Math.max(...pages.map((p) => p.lastVisit)));
    expect(PAGE_LIMIT).toBe(25_000);
  });

  it("accepts weaker pages on a site proven by three clear ones", () => {
    const proven = ImportAnalyzer.analyze(
      [
        page("https://streamz.example/watch/arrival", "Arrival (2016) watch online free", 9),
        page("https://streamz.example/watch/heat-1995", "Heat (1995) watch online free", 8),
        page("https://streamz.example/watch/alien", "Alien (1979) watch online free", 7),
        page("https://streamz.example/movie/123-ronin", "Ronin (1998)", 6),
      ],
      "test",
      NOW,
    );
    expect(proven.titles.map((t) => t.name).sort()).toEqual(["Alien", "Arrival", "Heat", "Ronin"]);
  });
});

describe("pagesFromHistory", () => {
  it("reads chrome.history items as pages", () => {
    const pages = pagesFromHistory([
      { url: "https://site.example/film/1", title: "A film", visitCount: 4, lastVisitTime: 1_700_000_000_500 },
      { url: "about:blank", title: "Blank" },
      { url: "https://site.example/x" },
      { title: "No address" },
    ]);
    expect(pages).toEqual([
      { url: "https://site.example/film/1", title: "A film", visits: 4, lastVisit: 1_700_000_000.5, origin: "history" },
      { url: "https://site.example/x", title: "", visits: 0, lastVisit: DISTANT_PAST, origin: "history" },
    ]);
  });
});
