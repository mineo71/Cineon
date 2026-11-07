// CineonTests/TitleParserTests.swift (via windows/Cineon.Core.Tests/Parsing/TitleParserTests.cs), with the
// same expectations. Timecode belongs to the data layer's tests; UrlKey and DomainName are checked here
// because parsing keeps copies of them until src/core/data lands.

import { DomainName } from "../../src/core/parsing/data-copy/domainName";
import { UrlKey } from "../../src/core/parsing/data-copy/urlKey";
import { PageMeta, TitleParser, type ParsedTitle } from "../../src/core/parsing";

function parse(title = "", options: { og?: string; url?: string; site?: string } = {}): ParsedTitle | null {
  return TitleParser.parse({
    title,
    ogTitle: options.og ?? null,
    url: options.url ?? "https://example.com/x",
    ogSite: options.site ?? null,
    ld: [],
  });
}

test("strips English page furniture", () => {
  const p = parse("Watch Dune: Part Two (2024) Full Movie Online Free HD | FlixHub", { url: "https://flixhub.to/watch/1", site: "FlixHub" });
  expect(p?.name).toBe("Dune: Part Two");
  expect(p?.year).toBe(2024);
});

test("movie inside a name is kept", () => {
  const p = parse("Watch The Lego Movie (2014) Online Free | FlixHub", { url: "https://flixhub.to/x", site: "FlixHub" });
  expect(p?.name).toBe("The Lego Movie");
  expect(p?.year).toBe(2014);
});

test("picks the first meaningful segment", () => {
  expect(parse("FlixHub - Oppenheimer - Watch free", { url: "https://flixhub.to/x", site: "FlixHub" })?.name).toBe("Oppenheimer");
});

test("reads a Ukrainian title", () => {
  const p = parse("Дюна: Частина друга (2024) дивитися онлайн безкоштовно українською", { url: "https://uakino.best/x" });
  expect(p?.name).toBe("Дюна: Частина друга");
  expect(p?.year).toBe(2024);
});

test("reads a Russian title and kind", () => {
  const p = parse("Смотреть мультфильм Головоломка 2 онлайн бесплатно в хорошем качестве", { url: "https://kino.example/x" });
  expect(p?.name).toBe("Головоломка 2");
  expect(p?.kindHint).toBe("cartoon");
});

test("a spaced colon separates sections", () => {
  const p = parse("Big Buck Bunny : Free Download, Borrow, and Streaming : Internet Archive", { url: "https://archive.org/details/x" });
  expect(p?.name).toBe("Big Buck Bunny");
});

test("a colon inside a title is kept", () => {
  expect(parse("Dune: Part Two", { url: "https://site.example/x" })?.name).toBe("Dune: Part Two");
});

test("video quality words are removed", () => {
  const p = parse("Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film - YouTube", { url: "https://www.youtube.com/watch?v=x" });
  expect(p?.name).toBe("Big Buck Bunny");
});

// These follow the page titles on HDRezka and its mirrors.
test("the dub in the title is not part of the name", () => {
  const p = parse("Смотреть Менталист в озвучке Оригинал (+субтитры) онлайн бесплатно в хорошем качестве", {
    url: "https://rezka.example/series/drama/1-mentalist.html",
  });
  expect(p?.name).toBe("Менталист");
  expect(p?.kindHint).toBe("series"); // The address says it's a series
});

test("different dubs give the same name", () => {
  const names = new Set(
    ["Пацаны в озвучке лостфильм (LostFilm)", "Пацаны в озвучке HDrezka Studio (18+)", "Пацаны в озвучке Дубляж"].map(
      (t) => parse(t, { url: "https://rezka.example/x" })?.name,
    ),
  );
  expect([...names]).toEqual(["Пацаны"]);
});

test("an anime season marker is removed", () => {
  expect(parse("Поднятие уровня в одиночку [ТВ-1] смотреть онлайн", { url: "https://rezka.example/x" })?.name).toBe(
    "Поднятие уровня в одиночку",
  );
});

test("quality and download words are removed", () => {
  expect(parse("Мэйдэй в 1080 качестве смотреть", { url: "https://k.example/x" })?.name).toBe("Мэйдэй");
  expect(parse("Сверхъестественное скачать торрент 1080", { url: "https://k.example/x" })?.name).toBe("Сверхъестественное");
  expect(parse("Мэйдэй (Mayday", { url: "https://k.example/x" })?.name).toBe("Мэйдэй");
});

test("coming soon and bracket notes are removed", () => {
  expect(parse("Одиссея скоро", { url: "https://rezka.example/x" })?.name).toBe("Одиссея");
  expect(parse("Паук-Нуар (ЧБ) в озвучке Дубляж", { url: "https://rezka.example/x" })?.name).toBe("Паук-Нуар");
});

test("a broken quote is cleaned up", () => {
  expect(parse("Создание «Рыцаря Семи Королевств» в озвучке Дубляж", { url: "https://rezka.example/x" })?.name).toBe(
    "Создание «Рыцаря Семи Королевств»",
  );
  expect(parse("Создание «Рыцаря", { url: "https://rezka.example/x" })?.name).toBe("Создание Рыцаря");
});

test("a sub/dub site suffix is removed", () => {
  expect(parse("One Piece English Sub/Dub on Aniwatch.to", { url: "https://aniwatch.example/x" })?.name).toBe("One Piece");
});

test("the episode in a Rezka fragment", () => {
  expect(TitleParser.episodeRefIn("https://rezka.example/series/drama/1-name-2020.html#t:238-s:2-e:3")).toEqual({ season: 2, episode: 3 });
});

test("a cartoon section in the address", () => {
  expect(parse("Головоломка смотреть онлайн", { url: "https://rezka.example/cartoons/comedy/1-name.html" })?.kindHint).toBe("cartoon");
});

test("the episode fragment is part of the page but the dub is not", () => {
  const a = UrlKey.make("https://rezka.example/series/1-name.html#t:238-s:2-e:3");
  const b = UrlKey.make("https://rezka.example/series/1-name.html#t:111-s:2-e:3");
  const c = UrlKey.make("https://rezka.example/series/1-name.html#t:238-s:2-e:4");
  expect(a).toBe("rezka.example/series/1-name.html#s:2-e:3");
  expect(b).toBe(a); // Another dub of the same episode
  expect(c).not.toBe(a); // Another episode
});

test("a bilingual title keeps both names", () => {
  const p = parse("Дюна / Dune (2021) смотреть онлайн", { url: "https://rezka.example/x" });
  expect(p?.name).toBe("Дюна");
  expect(p?.altName).toBe("Dune");
  expect(p?.year).toBe(2021);
});

test("the episode short form", () => {
  const p = parse("Severance S02E04 - Watch Online", { url: "https://site.example/x" });
  expect(p?.name).toBe("Severance");
  expect(p?.ref).toEqual({ season: 2, episode: 4 });
  expect(p?.kindHint).toBe("series");
});

test("the episode long form", () => {
  const p = parse("The Bear Season 3 Episode 7 | Stream", { url: "https://site.example/x" });
  expect(p?.name).toBe("The Bear");
  expect(p?.ref).toEqual({ season: 3, episode: 7 });
});

test("a Ukrainian episode", () => {
  const p = parse("Розрив 2 сезон 4 серія дивитися онлайн", { url: "https://site.example/x" });
  expect(p?.name).toBe("Розрив");
  expect(p?.ref).toEqual({ season: 2, episode: 4 });
});

test("an episode only in the address", () => {
  const p = parse("Severance | Watch", { url: "https://site.example/series/severance/season-2/episode-4" });
  expect(p?.name).toBe("Severance");
  expect(p?.ref).toEqual({ season: 2, episode: 4 });
});

test("an episode in a tv path", () => {
  expect(TitleParser.episodeRefIn("https://site.example/tv/95396/2/4")).toEqual({ season: 2, episode: 4 });
});

test("a year-only name is kept", () => {
  const p = parse("1917 - Watch Online", { url: "https://site.example/x" });
  expect(p?.name).toBe("1917");
  expect(p?.year).toBeNull();
});

test("linked data wins", () => {
  const p = TitleParser.parse({
    title: "Some junk | Site",
    url: "https://site.example/x",
    ld: [{ type: "TVEpisode", name: "Hello, Ms. Cobel", series: "Severance", season: 2, episode: 1, year: 2025 }],
  });
  expect(p?.name).toBe("Severance");
  expect(p?.episodeName).toBe("Hello, Ms. Cobel");
  expect(p?.ref).toEqual({ season: 2, episode: 1 });
  expect(p?.confidence).toBeCloseTo(0.95, 3);
});

test("falls back to the address slug with low confidence", () => {
  const p = parse("", { url: "https://site.example/watch/dune-part-two-19xk2" });
  expect(p?.name).toBe("Dune Part Two");
  expect(p?.confidence ?? 1).toBeLessThan(0.5);
});

test("only the site name gives no title", () => {
  expect(TitleParser.clean("FlixHub", new Set(["flixhub"]))).toBeNull();
});

test("normalize folds case and punctuation", () => {
  expect(TitleParser.normalize("Dune: Part Two!")).toBe("duneparttwo");
  expect(TitleParser.normalize("Amélie")).toBe("amelie");
});

test("the url key ignores tracking and fragments", () => {
  expect(UrlKey.make("https://www.Site.example/watch/1?utm_source=x&id=5#t=10")).toBe("site.example/watch/1?id=5");
  expect(UrlKey.make("http://site.example/watch/1/?id=5")).toBe("site.example/watch/1?id=5");
});

test("the registrable domain", () => {
  expect(DomainName.registrable("player.vod.example.com")).toBe("example.com");
  expect(DomainName.registrable("kino.example.com.ua")).toBe("example.com.ua");
  expect(DomainName.registrable("127.0.0.1")).toBe("127.0.0.1");
  expect(DomainName.isSameSite("a.example.com", "b.example.com")).toBe(true);
  expect(DomainName.isSameSite("example.com", "ads.net")).toBe(false);
});

test("quotes inside a name stay", () => {
  const none = new Set<string>();
  expect(TitleParser.clean('Charlie Chaplin\'s "The Rink"', none)?.name).toBe('Charlie Chaplin\'s "The Rink"');
  expect(TitleParser.clean('"Dune"', none)?.name).toBe("Dune");
  expect(TitleParser.clean('Dune"', none)?.name).toBe("Dune");
  expect(TitleParser.clean("Ocean's Eleven", none)?.name).toBe("Ocean's Eleven");
});

test("ligatures fold as ICU folds them, so the Mac's noise is noise here too", () => {
  expect(TitleParser.clean("ﬁlm online", new Set())).toBeNull();
  expect(TitleParser.clean("Dune ﬆreaming", new Set())?.name).toBe("Dune");
});

// MARK: Extension only: reading what meta.js posts.

test("PageMeta reads what the script posts", () => {
  const meta = PageMeta.fromJson(`
    {"url":"https://site.example/x","title":"Dune | Site","ogTitle":null,"ogType":"video.movie","ogSite":"Site",
     "ogImage":"https://site.example/p.jpg","ogDescription":null,"twitterTitle":null,"h1":"Dune",
     "ld":[{"type":"Movie","name":"Dune","series":null,"season":null,"episode":null,"year":2021,"image":null,"description":"Sand."}],
     "icon":"https://site.example/favicon.ico","search":null}`);
  expect(meta).not.toBeNull();
  expect(meta!.title).toBe("Dune | Site");
  expect(meta!.ld).toHaveLength(1);
  expect(meta!.ld[0]!.year).toBe(2021);
  expect(TitleParser.parse(meta!)?.name).toBe("Dune");
  // A message object, as runtime messaging delivers it, reads the same.
  expect(PageMeta.from(JSON.parse(JSON.stringify(meta)))).toEqual(meta);
});

test("PageMeta fails like JSONDecoder", () => {
  expect(PageMeta.fromJson('{"url":"https://site.example/x","title":"Dune"}')).toBeNull(); // ld is required
  expect(PageMeta.fromJson('{"url":"https://site.example/x","title":"Dune","ld":[{"season":"2"}]}')).toBeNull();
  expect(PageMeta.fromJson("not json")).toBeNull();
  expect(PageMeta.fromJson('{"url":"u","title":"t","ld":[{"season":2.0}]}')?.ld[0]!.season).toBe(2);
  expect(PageMeta.fromJson('{"url":"u","title":"t","ld":[{"season":2.5}]}')).toBeNull();
  expect(PageMeta.from(null)).toBeNull();
});
