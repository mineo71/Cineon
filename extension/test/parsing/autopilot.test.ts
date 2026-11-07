// CineonTests/AutopilotTests.swift (via windows/Cineon.Core.Tests/Parsing/AutopilotTests.cs): EpisodeLinksTests,
// SkipLearnerTests and RescueMatcherTests, with the same expectations. FrameGradingTests belong to the frame
// collector and SkipRuleStorageTests to the data layer.

import { episodeInfo } from "../../src/core/metadata/models";
import {
  EpisodeLinks,
  NextEpisode,
  RescueMatcher,
  SiteBrand,
  SkipLearner,
  SwiftUrl,
  type RescueLink,
  type RescueMatch,
} from "../../src/core/parsing";

describe("EpisodeLinks", () => {
  function next(address: string, season: number, episode: number, to?: [number, number]): string | null {
    const target = to ? { season: to[0], episode: to[1] } : { season, episode: episode + 1 };
    return EpisodeLinks.url(address, { season, episode }, target);
  }

  test("rewrites the shapes sites use", () => {
    expect(next("https://a.example/serial/rozryv/2-sezon/4-seriya", 2, 4)).toBe("https://a.example/serial/rozryv/2-sezon/5-seriya");
    expect(next("https://a.example/show-s02e04.html", 2, 4)).toBe("https://a.example/show-s02e05.html");
    expect(next("https://a.example/show/S2E9", 2, 9)).toBe("https://a.example/show/S2E10");
    expect(next("https://a.example/show/2x09", 2, 9)).toBe("https://a.example/show/2x10");
    expect(next("https://a.example/tv/the-bear/season-2/episode-7", 2, 7)).toBe("https://a.example/tv/the-bear/season-2/episode-8");
    expect(next("https://a.example/tv/the-bear/season/2/episode/7", 2, 7)).toBe("https://a.example/tv/the-bear/season/2/episode/8");
    expect(next("https://a.example/watch?season=2&episode=7", 2, 7)).toBe("https://a.example/watch?season=2&episode=8");
    expect(next("https://a.example/watch?s=2&e=7", 2, 7)).toBe("https://a.example/watch?s=2&e=8");
  });

  test("rewrites the episode in the fragment", () => {
    expect(next("https://rezka.example/series/drama/1-mentalist-2008.html#t:238-s:3-e:5", 3, 5)).toBe(
      "https://rezka.example/series/drama/1-mentalist-2008.html#t:238-s:3-e:6",
    );
  });

  test("moves to the next season", () => {
    expect(next("https://a.example/serial/x/2-sezon/10-seriya", 2, 10, [3, 1])).toBe("https://a.example/serial/x/3-sezon/1-seriya");
    expect(next("https://a.example/show-s02e10", 2, 10, [3, 1])).toBe("https://a.example/show-s03e01");
  });

  test("an episode-only address stays in its season", () => {
    expect(next("https://a.example/show/episode-7", 2, 7)).toBe("https://a.example/show/episode-8");
    expect(next("https://a.example/show/episode-7", 2, 7, [3, 1])).toBeNull();
  });

  test("leaves addresses that do not name this episode", () => {
    expect(next("https://a.example/film/part-2-2021", 2, 4)).toBeNull();
    expect(next("https://a.example/serial/x/2-sezon/9-seriya", 2, 4)).toBeNull();
    expect(next("https://a.example/watch/abc123", 2, 4)).toBeNull();
    expect(next("https://s2e4.example/film", 1, 1)).toBeNull();
  });

  test("the next episode follows the published list", () => {
    const list = [episodeInfo(1, 1), episodeInfo(1, 2), episodeInfo(2, 1), episodeInfo(2, 2, { released: 8.64e15 })];
    expect(NextEpisode.candidates({ season: 1, episode: 1 }, list)).toEqual([{ season: 1, episode: 2 }]);
    expect(NextEpisode.candidates({ season: 1, episode: 2 }, list)).toEqual([{ season: 2, episode: 1 }]);
    expect(NextEpisode.candidates({ season: 2, episode: 1 }, list)).toEqual([]); // Not out yet
    expect(NextEpisode.candidates({ season: 2, episode: 2 }, list)).toEqual([]); // The last one
  });

  test("without a list the next episode guesses both", () => {
    expect(NextEpisode.candidates({ season: 2, episode: 4 }, [])).toEqual([
      { season: 2, episode: 5 },
      { season: 3, episode: 1 },
    ]);
  });
});

describe("SkipLearner", () => {
  test("an intro is a medium jump near the start", () => {
    expect(SkipLearner.isIntro(62, 152, 2700)).toBe(true);
    expect(SkipLearner.isIntro(62, 72, 2700)).toBe(false); // Ten seconds is just skipping ahead
    expect(SkipLearner.isIntro(62, 900, 2700)).toBe(false); // Too far to be an intro
    expect(SkipLearner.isIntro(1800, 1890, 2700)).toBe(false); // Too late to be an intro
  });

  test("credits are a short stretch before the end", () => {
    expect(SkipLearner.isCredits(90, 2700)).toBe(true);
    expect(SkipLearner.isCredits(5, 2700)).toBe(false);
    expect(SkipLearner.isCredits(900, 2700)).toBe(false); // That's leaving early, not skipping credits
  });

  test("repeated arrow presses become one jump", () => {
    const start = Date.now();
    let jump = new SkipLearner.Jump(60, 70, start);
    for (let step = 1; step < 9; step++) {
      jump = jump.extended(jump.to + 1, jump.to + 11, start + step * 1000)!;
    }
    expect(jump.from).toBe(60);
    expect(jump.to).toBeGreaterThan(150);
  });

  test("a pause or a jump back starts over", () => {
    const start = Date.now();
    const jump = new SkipLearner.Jump(60, 70, start);
    expect(jump.extended(70, 80, start + 20_000)).toBeNull();
    expect(jump.extended(70, 40, start + 1000)).toBeNull();
    expect(SkipLearner.agree(100, 125)).toBe(true);
    expect(SkipLearner.agree(100, 135)).toBe(false);
  });

  test("mirrors share rules", () => {
    expect(SkipLearner.siteKey("rezka-ua.co")).toBe(SkipLearner.siteKey("hdrezka.ag"));
    expect(SkipLearner.siteKey("uakino.me")).not.toBe(SkipLearner.siteKey("hdrezka.ag"));
    expect(SkipLearner.siteKey("127.0.0.1")).toBe("127.0.0.1");
  });

  // BrowserImportTests.testBrandIgnoresMirrorDecoration, for ImportAnalyzer.brand, which lives here as SiteBrand.
  test("the brand ignores mirror decoration", () => {
    expect(SiteBrand.of("hdrezka.ag")).toBe("rezka");
    expect(SiteBrand.of("rezka-ua.co")).toBe("rezka");
    expect(SiteBrand.of("kinogo1.biz")).toBe("kinogo");
    expect(SiteBrand.of("kinogo.is")).not.toBe(SiteBrand.of("uakino.best"));
  });
});

describe("RescueMatcher", () => {
  const page = "https://site.example/search?q=dune";
  const link = (path: string, text: string, context = ""): RescueLink => ({ url: "https://site.example" + path, text, context });
  const best = (links: RescueLink[], name = "Dune: Part Two", year: number | null = 2024): RescueMatch | null =>
    RescueMatcher.best(links, [name], year, page);
  const strong = (m: RescueMatch | null): boolean => m !== null && RescueMatcher.isStrong(m);

  test("picks the right film over its neighbours", () => {
    const match = best([
      link("/film/dune-1984", "Dune (1984)"),
      link("/film/dune-2021", "Dune (2021)"),
      link("/film/dune-part-two", "Dune: Part Two (2024)"),
      link("/film/dune-prophecy", "Dune: Prophecy (2024)"),
    ]);
    expect(match && SwiftUrl.from(match.link.url).path).toBe("/film/dune-part-two");
    expect(strong(match)).toBe(true);
  });

  test("a wrong year is never opened", () => {
    expect(best([link("/film/1", "Dune (1984)")], "Dune", 2021)).toBeNull();
  });

  test("a sequel number counts against", () => {
    expect(strong(best([link("/film/2", "Dune 2 (2021)")], "Dune", 2021))).toBe(false);
  });

  test("a missing year stays a suggestion", () => {
    const match = best([link("/film/x", "Dune: Part Two")]);
    expect(match).not.toBeNull();
    expect(strong(match)).toBe(false);
  });

  test("a year beside the link confirms", () => {
    expect(strong(best([link("/film/x", "Dune: Part Two", "Dune: Part Two 2024 Sci-Fi")]))).toBe(true);
  });

  test("translated titles match either name", () => {
    expect(strong(best([link("/film/x", "Дюна: Частина друга / Dune: Part Two (2024)")]))).toBe(true);
    expect(
      strong(RescueMatcher.best([link("/film/x", "Дюна: Частина друга (2024)")], ["Dune: Part Two", "Дюна: Частина друга"], 2024, page)),
    ).toBe(true);
  });

  test("page furniture in link text is ignored", () => {
    expect(strong(best([link("/film/x", "Смотреть Dune: Part Two онлайн бесплатно (2024)")]))).toBe(true);
    expect(strong(best([link("/film/x", "Watch Dune: Part Two Full Movie Online Free (2024)")]))).toBe(true);
  });

  test("names can contain furniture words", () => {
    expect(strong(best([link("/f/1", "Vanishing Film (2020)")], "Vanishing Film", 2020))).toBe(true);
    expect(strong(best([link("/f/2", "Watch The Lego Movie Online Free (2014)")], "The Lego Movie", 2014))).toBe(true);
    expect(best([link("/f/3", "Scary Stories (2000)")], "Scary Movie", 2000)).toBeNull(); // Part of a name isn't the name
  });

  test("trailers and reviews are not the film", () => {
    expect(best([link("/v/1", "Dune: Part Two | Official Trailer (2024)")])).toBeNull();
    expect(best([link("/v/2", "Dune: Part Two review (2024)")])).toBeNull();
    expect(best([link("/v/3", "Дюна: Частина друга трейлер (2024)")], "Дюна: Частина друга")).toBeNull();
  });

  test("an address alone only suggests", () => {
    const match = best([link("/films/18432-dune-part-two.html", "")]);
    expect(match).not.toBeNull();
    expect(strong(match)).toBe(false);
  });

  test("ignores navigation and other sites", () => {
    expect(best([{ url: "https://ads.example/dune-part-two", text: "Dune: Part Two (2024)", context: "" }])).toBeNull();
    expect(best([link("/tag/dune-part-two", "Dune: Part Two (2024)")])).toBeNull();
    expect(best([link("/search?q=dune", "Dune: Part Two (2024)")])).toBeNull();
  });

  test("a part of the name is not a match", () => {
    expect(best([link("/film/x", "Dune (2024)")])).toBeNull();
  });

  test("upload sites are only suggestions", () => {
    expect(RescueMatcher.isVideoSharing("https://www.youtube.com/watch?v=1")).toBe(true);
    expect(RescueMatcher.isVideoSharing("https://tubitv.com/movies/1")).toBe(false);
  });

  test("finds the same page at other addresses", () => {
    const found = RescueMatcher.mirrors("https://hdrezka.ag/series/drama/1-mentalist-2008.html#t:238-s:3-e:5", [
      "rezka-ua.co",
      "uakino.me",
      "hdrezka.ag",
      "rezka.fi",
      "rezka-ua.co",
    ]);
    expect(found).toEqual([
      "https://rezka-ua.co/series/drama/1-mentalist-2008.html#t:238-s:3-e:5",
      "https://rezka.fi/series/drama/1-mentalist-2008.html#t:238-s:3-e:5",
    ]);
  });

  test("common words do not make sites mirrors", () => {
    expect(RescueMatcher.mirrors("https://kino-online.example/film/1", ["kino-hd.example", "kino.example"])).toEqual([]);
  });
});
