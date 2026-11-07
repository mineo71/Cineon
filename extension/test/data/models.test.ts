// Port of windows/Cineon.Core.Tests/Data/ModelsTests.cs (the parts that aren't settings) and the
// rating text from ProfileAndRatingTests.cs. Expected values come from running the Swift code on a
// Mac, so they pin the Mac's behaviour rather than what seems sensible.

import {
  AppTheme,
  CaptionStyle,
  DomainName,
  DownloadItem,
  DownloadStatus,
  EpisodeRef,
  LibraryEventKind,
  LibraryText,
  MediaSource,
  type MediaSourceKind,
  MediaSourceKind as MediaSourceKinds,
  Rating,
  SearchEngine,
  Site,
  SkipRuleKind,
  StoredDate,
  Timecode,
  Title,
  TitleKind,
  TitleStatus,
  UrlKey,
  VoiceBoostState,
  WatchProgress,
} from "../../src/core/data";
import { LibraryKind, LibraryList, LibrarySort } from "../../src/core/data";

describe("UrlKey", () => {
  test.each([
    ["https://www.Site.example/watch/1?utm_source=x&id=5#t=10", "site.example/watch/1?id=5"],
    ["http://site.example/watch/1/?id=5", "site.example/watch/1?id=5"],
    ["https://rezka.example/series/1-name.html#t:238-s:2-e:3", "rezka.example/series/1-name.html#s:2-e:3"],
    ["https://rezka.example/series/1-name.html#t:111-s:2-e:3", "rezka.example/series/1-name.html#s:2-e:3"],
    ["https://x.example/%D1%84%D0%B8%D0%BB%D1%8C%D0%BC/", "x.example/%D1%84%D0%B8%D0%BB%D1%8C%D0%BC"],
    ["https://x.example/%D1%84%D0%B8%D0%BB%D1%8C%D0%BC", "x.example/%D1%84%D0%B8%D0%BB%D1%8C%D0%BC"],
    ["https://x.example/a%2Fb/", "x.example/a/b"],
    ["https://x.example/a?q=a%26b&z=1+2&b", "x.example/a?b&q=a%26b&z=1+2"],
    ["https://x.example/a?", "x.example/a"],
    ["https://x.example/a?b=&a=1", "x.example/a?a=1&b="],
    ["https://user:pw@x.example:8080/a//", "x.example:8080/a"],
    ["https://x.example/", "x.example"],
    ["https://x.example", "x.example"],
    ["https://x.example/a?q=%20x%2B", "x.example/a?q=%20x+"],
    ["https://x.example/a?q=a%3Db", "x.example/a?q=a%3Db"],
    ["https://x.example/a?Ref=1&REF_x=2&id=3", "x.example/a?id=3"],
    ["https://x.example/a?q=%E2%9C%93&r=it's", "x.example/a?q=%E2%9C%93&r=it's"],
    ["https://x.example/a#S:1-E:2", "x.example/a"],
    ["https://x.example/a?z=1&a=2&a=1", "x.example/a?a=2&a=1&z=1"],
    ["https://x.example/a?q=a/b?c", "x.example/a?q=a/b?c"],
    ["https://x.example/a b", "x.example/a%20b"],
    [
      "http://127.0.0.1:8765/series/drama/1-mentalist-2008.html#t:238-s:3-e:6",
      "127.0.0.1:8765/series/drama/1-mentalist-2008.html#s:3-e:6",
    ],
    ["https://XN--80AK6AA92E.com/путь/", "xn--80ak6aa92e.com/%D0%BF%D1%83%D1%82%D1%8C"],
    ["https://x.example/a?q=%25", "x.example/a?q=%25"],
    ["https://x.example/a?q=a;b", "x.example/a?q=a;b"],
    ["https://x.example/a?q=[1]", "x.example/a?q=%5B1%5D"],
    ["https://x.example/a?q=a@b:c!$'()*,", "x.example/a?q=a@b:c!$'()*,"],
    ["blob:https://site.test/x", "https%3A//site.test/x"],
    ["about:blank", "blank"],
  ])("%s", (url, key) => {
    expect(UrlKey.make(url)).toBe(key);
  });

  test("keeps episodes apart", () => {
    const a = UrlKey.make("https://rezka.example/series/1-name.html#t:238-s:2-e:3");
    const c = UrlKey.make("https://rezka.example/series/1-name.html#t:238-s:2-e:4");
    expect(a).not.toBe(c);
  });
});

describe("title keys", () => {
  test.each([
    ["Dune: Part Two", "duneparttwo"],
    ["Straße", "strasse"],
    ["Ёлки 2", "елки2"],
    ["Café Ｆｕｌｌ", "cafefull"],
    ["Ørsted", "ørsted"],
    ["ﬁlm", "film"],
    ["千と千尋の神隠し", "千と千尋の神隠し"],
    ["Ǆungla", "ǆungla"],
    ["Й", "и"],
    ["İstanbul", "istanbul"],
    ["Ⅻ", "ⅻ"],
    ["x²", "x²"],
    ["Łódź", "łodz"],
    ["Æon", "æon"],
    ["á", "a"],
    ["١٢٣", "١٢٣"],
    ["🎬Film", "film"],
    ["Ω", "ω"],
    ["ガンダム", "ガンダム"],
    ["ｶﾞﾝﾀﾞﾑ", "カﾞンタﾞム"],
    ["한국", "한국"],
    ["हिन्दी", "हिन्दी"],
    ["ς", "σ"],
    ["µ", "μ"],
    ["ſ", "s"],
    ["ﬆ", "st"],
    ["ŉ", "ʼn"],
    ["ǰ", "j"],
    ["ΐ", "ι"],
    ["ẞ", "ss"],
    ["ϐ", "β"],
    ["Ａ１", "a1"],
    ["　x", "x"],
    ["Ꭰ", "ꭰ"],
    ["ﬓ", "մն"],
    ["ᾈ", "α"],
    ["Ç", "c"],
    ["Þ", "þ"],
    ["ﬃ", "ffi"],
    ["الْعَرَبِيَّة", "الْعَرَبِيَّة"],
    ["עִבְרִית", "עִבְרִית"],
    ["Việt Nam", "vietnam"],
    ["½", "½"],
    ["℃", ""],
    ["™", ""],
    ["Å", "a"],
    ["＄", ""],
    ["ⓐ", ""],
    // Beyond the Windows cases, checked against Foundation on a Mac.
    ["ΟΔΥΣΣΕΥΣ", "οδυσσευσ"],
    ["ΣΑΣ", "σασ"],
    ["ﾊﾟ", "ハﾟ"],
    ["ﾟ", "゚"],
    ["ｧ", "ァ"],
    ["ǅ", "ǆ"],
    ["ᾼ", "α"],
    ["ẛ", "s"],
    ["ẞx", "ssx"],
    ["", ""],
  ])("%s", (text, key) => {
    expect(LibraryText.normalize(text)).toBe(key);
  });

  test("genres get one name", () => {
    expect(LibraryText.canonicalGenre("Science Fiction")).toBe("Sci-Fi");
    expect(LibraryText.canonicalGenre(" sci-fi ")).toBe("Sci-Fi");
    expect(LibraryText.canonicalGenre("film noir")).toBe("Film-Noir");
    expect(LibraryText.canonicalGenre("TV Movie")).toBe("TV Movie");
    expect(LibraryText.canonicalGenre("comedy")).toBe("Comedy");
    expect(LibraryText.canonicalGenre("")).toBe("");
  });
});

describe("domains, time, ratings", () => {
  test("registrable domain", () => {
    expect(DomainName.registrable("player.vod.example.com")).toBe("example.com");
    expect(DomainName.registrable("kino.example.com.ua")).toBe("example.com.ua");
    expect(DomainName.registrable("127.0.0.1")).toBe("127.0.0.1");
    expect(DomainName.registrable("Player.Example.CO.UK.")).toBe("example.co.uk");
    expect(DomainName.isSameSite("a.example.com", "b.example.com")).toBe(true);
    expect(DomainName.isSameSite("example.com", "ads.net")).toBe(false);
    expect(DomainName.isSameSite(null, "ads.net")).toBe(false);
    expect(DomainName.displayName("www.example.co.uk")).toBe("Example");
    expect(DomainName.isIPAddress("::1")).toBe(true);
  });

  test("timecode reads like the Mac", () => {
    expect(Timecode.string(2530)).toBe("42:10");
    expect(Timecode.string(3723)).toBe("1:02:03");
    expect(Timecode.string(NaN)).toBe("0:00");
    expect(Timecode.spoken(4320)).toBe("1 h 12 min");
    expect(Timecode.spoken(90)).toBe("2 min");
    expect(Timecode.spoken(3600)).toBe("1 h");
    expect(Timecode.spoken(20)).toBe("under a minute");
  });

  test("rating text shows halves", () => {
    expect(Rating.text(15)).toBe("7.5");
    expect(Rating.text(16)).toBe("8");
    expect(Rating.text(20)).toBe("10");
    expect(Rating.text(1)).toBe("0.5");
    expect(Rating.clamp(0)).toBe(1);
    expect(Rating.clamp(99)).toBe(20);
  });

  test("progress and title math", () => {
    expect(Title.rating({ ratingHalves: 15 })).toBe(7.5);
    expect(Title.rating(Title.make())).toBeNull();
    const p = WatchProgress.make({ position: 150, duration: 100 });
    expect(WatchProgress.fraction(p)).toBe(1);
    expect(WatchProgress.remaining(p)).toBe(0);
    expect(EpisodeRef.isEpisode(EpisodeRef.none)).toBe(false);
    expect(EpisodeRef.isEpisode(EpisodeRef.make(0, 3))).toBe(true);
    expect(EpisodeRef.equals(EpisodeRef.make(1, 2), { season: 1, episode: 2 })).toBe(true);
  });

  test("stored dates use the Mac's epochs", () => {
    expect(StoredDate.fromReference(0)).toBe(978307200);
    expect(StoredDate.toReference(StoredDate.fromReference(100))).toBe(100);
    expect(StoredDate.iso8601(1793914535.9999)).toBe("2026-11-05T21:35:35Z");
    expect(StoredDate.iso8601(-0.5)).toBe("1969-12-31T23:59:59Z");
    expect(StoredDate.parseIso8601("2026-11-05T21:35:35Z")).toBe(1793914535);
    expect(StoredDate.parseIso8601("2026-11-05T23:35:35+02:00")).toBe(1793914535);
    expect(StoredDate.parseIso8601("2026-11-05T21:35:35.123Z")).toBeCloseTo(1793914535.123, 6);
    expect(StoredDate.parseIso8601("yesterday")).toBeNull();
  });
});

describe("media sources and downloads", () => {
  const source = (url: string, kind: MediaSourceKind = "file", at = 0, current = true): MediaSource => ({
    url,
    kind,
    foundAt: at,
    isCurrent: current,
  });

  test("the plain file being played wins", () => {
    const sources = [source("https://cdn.test/a/1080.mp4", "file", 1), source("https://cdn.test/a/480.mp4", "file", 2)];
    expect(MediaSource.best(sources, "https://cdn.test/a/480.mp4")?.url).toBe("https://cdn.test/a/480.mp4");
  });

  test("highest quality when playing from a media source", () => {
    const sources = [
      source("https://cdn.test/a/480.mp4", "file", 1),
      source("https://cdn.test/a/1080.mp4", "file", 2),
      source("https://cdn.test/a/720.mp4", "file", 3),
    ];
    expect(MediaSource.quality(MediaSource.best(sources, "blob:https://site.test/x")!)).toBe("1080p");
  });

  test("files from the video before this one are ignored", () => {
    const sources = [source("https://cdn.test/ep1/1080.mp4", "file", 0, false), source("https://cdn.test/ep2/720.mp4", "file", 5)];
    expect(MediaSource.best(sources, null)?.url).toBe("https://cdn.test/ep2/720.mp4");
  });

  test("a whole file beats a playlist", () => {
    const sources = [source("https://cdn.test/master.m3u8", "hls", 1), source("https://cdn.test/film.mp4", "file", 2)];
    expect(MediaSource.best(sources, null)?.kind).toBe("file");
  });

  test("the first playlist is the master", () => {
    const sources = [source("https://cdn.test/master.m3u8", "hls", 1), source("https://cdn.test/v1/index.m3u8", "hls", 2)];
    expect(MediaSource.best(sources, null)?.url).toBe("https://cdn.test/master.m3u8");
  });

  test("subtitles are never the film", () => {
    expect(MediaSource.best([source("https://cdn.test/en.vtt", "subtitle")], null)).toBeNull();
  });

  test("quality from addresses", () => {
    expect(MediaSource.qualityIn("https://x.test/film_720p.mp4")).toBe("720p");
    expect(MediaSource.qualityIn("https://x.test/stream/1080.mp4")).toBe("1080p");
    expect(MediaSource.qualityIn("https://x.test/stream/2160P/x")).toBe("2160p");
    expect(MediaSource.qualityIn("https://x.test/stream/abc.mp4")).toBeNull();
    expect(MediaSource.qualityIn("https://x.test/1080pa.mp4")).toBeNull();
    expect(MediaSource.qualityRank(source("https://x.test/stream/1080.mp4"))).toBe(1080);
  });

  const download = (name: string, ref: EpisodeRef, quality: string | null) =>
    DownloadItem.make({ id: 1, ref, name, sourceUrl: "https://x.test/a.mp4", host: "x.test", quality, createdAt: 1 });

  test("file name for an episode", () => {
    expect(DownloadItem.fileBaseName(download("Severance", EpisodeRef.make(1, 2), "1080p"))).toBe("Severance S01E02 [1080p]");
  });

  test("file names drop characters file systems refuse", () => {
    const name = DownloadItem.fileBaseName(download("Mission: Impossible / Dead Reckoning", EpisodeRef.none, null));
    expect(name).not.toContain("/");
    expect(name).not.toContain(":");
    expect(name.startsWith("Mission")).toBe(true);
    expect(DownloadItem.fileBaseName(download("Mission: Impossible / Dead Reckoning   x", EpisodeRef.none, null))).toBe(
      "Mission Impossible  Dead Reckoning  x",
    );
    expect(DownloadItem.fileBaseName(download("::", EpisodeRef.none, null))).toBe("Video");
    expect(DownloadItem.fileBaseName(download("a".repeat(300), EpisodeRef.none, null))).toHaveLength(120);
  });

  test("download fractions", () => {
    const item = { ...download("x", EpisodeRef.none, null), bytes: 50, totalBytes: 200, position: 30, duration: 60 };
    expect(DownloadItem.fraction(item)).toBe(0.25);
    expect(DownloadItem.watchedFraction(item)).toBe(0.5);
    expect(DownloadItem.episodeBadge(item)).toBeNull();
    expect(DownloadStatus.isActive("downloading")).toBe(true);
    expect(DownloadStatus.isActive("failed")).toBe(false);
  });
});

describe("search addresses", () => {
  test.each([
    ["dune part", "https://duckduckgo.com/?q=dune%20part"],
    ["a&b+c", "https://duckduckgo.com/?q=a%26b+c"],
    ["Фільм 2", "https://duckduckgo.com/?q=%D0%A4%D1%96%D0%BB%D1%8C%D0%BC%202"],
    ["100%", "https://duckduckgo.com/?q=100%25"],
    ["a#b", "https://duckduckgo.com/?q=a%23b"],
    ["a=b;c/d?", "https://duckduckgo.com/?q=a%3Db;c/d?"],
  ])("search engine: %s", (query, url) => {
    expect(SearchEngine.url("duckDuckGo", query)).toBe(url);
  });

  test("each search engine has its address", () => {
    expect(SearchEngine.url("google", "x")).toBe("https://www.google.com/search?q=x");
    expect(SearchEngine.url("brave", "x")).toBe("https://search.brave.com/search?q=x");
    expect(SearchEngine.url("kagi", "x")).toBe("https://kagi.com/search?q=x");
  });

  test.each([
    ["dune part", "https://s.example/?q=dune%20part"],
    ["a&b+c", "https://s.example/?q=a%26b%2Bc"],
    ["Фільм 2", "https://s.example/?q=%D0%A4%D1%96%D0%BB%D1%8C%D0%BC%202"],
    ["100%", "https://s.example/?q=100%25"],
    ["a#b", "https://s.example/?q=a%23b"],
    ["a/b?c=d", "https://s.example/?q=a/b?c=d"],
  ])("site: %s", (query, url) => {
    const site = Site.make({ homeUrl: "https://s.example", searchTemplate: "https://s.example/?q=%s" });
    expect(Site.searchUrl(site, query)).toBe(url);
    expect(Site.searchUrl({ ...site, searchTemplate: null }, query)).toBeNull();
  });
});

test("raw values round trip and match the apps", () => {
  const enums = [
    TitleKind,
    TitleStatus,
    SkipRuleKind,
    MediaSourceKinds,
    VoiceBoostState,
    DownloadStatus,
    CaptionStyle,
    LibraryEventKind,
    AppTheme,
    SearchEngine,
    LibraryList,
    LibraryKind,
    LibrarySort,
  ];
  for (const e of enums) for (const v of e.allCases) expect(e.fromRaw(v)).toBe(v);
  expect([...TitleKind.allCases, ...TitleStatus.allCases, ...LibraryEventKind.allCases]).toEqual([
    "film",
    "series",
    "cartoon",
    "unknown",
    "none",
    "backlog",
    "watching",
    "watched",
    "addedToBacklog",
    "markedWatched",
    "markedWatching",
    "removed",
  ]);
  expect(SearchEngine.allCases[0]).toBe("duckDuckGo");
  expect(MediaSourceKinds.allCases).toEqual(["file", "hls", "subtitle"]);
  expect(CaptionStyle.allCases).toEqual(["site", "large", "huge"]);
  expect(AppTheme.allCases).toEqual(["dark", "white"]);
  expect(LibrarySort.allCases).toContain("ratingHigh");
  expect(TitleKind.fromRaw("Film")).toBeNull();
  expect(TitleKind.label("unknown")).toBe("Unsorted");
  expect(TitleStatus.label("none")).toBe("Not in a list");
  expect(VoiceBoostState.note("waiting")).toBe("Click the video once to turn it on");
  expect(CaptionStyle.css("site")).toBeNull();
  expect(CaptionStyle.css("large")!.startsWith("font-size: 135% !important;")).toBe(true);
  expect(CaptionStyle.nativeSize("huge")).toBe(42);
});
