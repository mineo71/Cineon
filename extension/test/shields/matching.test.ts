// A port of the apps' ShieldEngineTests, run on the DNR rules with a DNR matcher. Where DNR
// answers differently on purpose, the test says so in its name and checks DNR's answer.

import { bundledLists } from "./corpus";
import { blocks, cosmetic, engine, rulesetsOf } from "./helpers";
import { DnrMatcher, dnrRequest } from "./dnrMatcher";

// MARK: Patterns

test("host anchors match the host and its subdomains", () => {
  const e = engine(["||popads.net^"]);
  expect(blocks(e, "https://popads.net/pop.js")).toBe(true);
  expect(blocks(e, "https://c1.popads.net/pop.js")).toBe(true);
  expect(blocks(e, "http://POPADS.NET")).toBe(true);
  expect(blocks(e, "https://notpopads.net/pop.js")).toBe(false);
  expect(blocks(e, "https://example.com/?u=popads.net")).toBe(false);
  expect(blocks(e, "https://example.com/popads.net/x.js")).toBe(false);
});

test("not 1:1: the separator is a real one here, where the Mac's is optional", () => {
  // The Mac's "^" is "[/:&?=]?", so "||popads.net^" also takes popads.network; DNR's isn't optional.
  const e = engine(["||popads.net^"]);
  expect(blocks(e, "https://popads.network/x.js")).toBe(false);
  expect(blocks(e, "https://popads.net.evil.com/")).toBe(false);
  expect(blocks(e, "https://popads.net:8080/")).toBe(true);

  const middle = engine(["||example.com^ads/"]);
  expect(blocks(middle, "https://example.com/ads/1.js")).toBe(true);
  expect(blocks(middle, "https://example.comads/1.js")).toBe(false);
  expect(blocks(middle, "https://example.com/x/ads/1.js")).toBe(false);
});

test("plain and anchored patterns", () => {
  const e = engine(["/ad-banner.\n|https://track.\nswf|\n-ads-*.gif"]);
  expect(blocks(e, "https://cdn.site.com/img/ad-banner.png")).toBe(true);
  expect(blocks(e, "https://cdn.site.com/img/ad-banner")).toBe(false);
  expect(blocks(e, "https://track.example.org/p")).toBe(true);
  expect(blocks(e, "http://track.example.org/p")).toBe(false);
  expect(blocks(e, "https://example.com/player.swf")).toBe(true);
  expect(blocks(e, "https://example.com/player.swf?x=1")).toBe(false);
  expect(blocks(e, "https://x.com/the-ads-300x250.gif")).toBe(true);
  expect(blocks(e, "https://x.com/the-ads-300x250.png")).toBe(false);
});

test("matching ignores case unless asked", () => {
  const e = engine(["/AdServer/*\n/Banner.js$match-case"]);
  expect(blocks(e, "https://x.com/adserver/1")).toBe(true);
  expect(blocks(e, "https://x.com/Banner.js")).toBe(true);
  expect(blocks(e, "https://x.com/banner.js")).toBe(false);
});

test("data URLs are never blocked", () => {
  expect(blocks(engine(["image/png"]), "data:image/png;base64,AAAA", null, "Image")).toBe(false);
});

// MARK: Exceptions

test("exceptions cancel blocks", () => {
  const e = engine(["||ads.example.com^\n@@||ads.example.com/allowed/"]);
  expect(blocks(e, "https://ads.example.com/banner.js")).toBe(true);
  expect(blocks(e, "https://ads.example.com/allowed/banner.js")).toBe(false);
});

test("not 1:1: exceptions reach every list, where in the apps they only reach their own", () => {
  // WebKit's ignore-previous-rules stays inside one compiled list; DNR's allow covers the extension.
  expect(blocks(engine(["||tracker.com^", "@@||tracker.com^"]), "https://tracker.com/p.js")).toBe(false);
  expect(blocks(engine(["||tracker.com^\n@@||tracker.com^"]), "https://tracker.com/p.js")).toBe(false);
});

test("not 1:1: $important beats exceptions, where the apps ignore it", () => {
  const e = engine(["||ads.com^$important\n@@||ads.com/ok"]);
  expect(blocks(e, "https://ads.com/x")).toBe(true);
  expect(blocks(e, "https://ads.com/ok.js")).toBe(true);
  // So uBlock's important rules hold against another list's exceptions, as they do in the apps.
  expect(blocks(engine(["||ads.com^$important", "@@||ads.com^"]), "https://ads.com/x")).toBe(true);
});

test("whole-site exceptions allow everything on that site", () => {
  const lists = ["||ads.com^\n##.banner\n@@||trusted.org^$document"];
  const e = engine(lists);
  expect(blocks(e, "https://ads.com/x.js", "https://www.trusted.org/watch")).toBe(false);
  expect(blocks(e, "https://ads.com/x.js", "https://trusted.org/")).toBe(false);
  expect(blocks(e, "https://ads.com/x.js", "https://other.org/")).toBe(true);
  const css = cosmetic(lists);
  expect(css.cssFor("www.trusted.org")).toBe("");
  expect(css.cssFor("other.org")).toContain(".banner");
});

test("not 1:1: a list's whole-site exception allows every list's blocks there", () => {
  const e = engine(["||ads.com^", "@@||trusted.org^$document"]);
  expect(blocks(e, "https://ads.com/x.js", "https://trusted.org/")).toBe(false);
  // But element hiding is still per list, as in the apps.
  const css = cosmetic(["##.banner", "@@||trusted.org^$document"]);
  expect(css.cssFor("trusted.org")).toContain(".banner");
});

// MARK: Options

test("third-party compares registrable domains", () => {
  const e = engine(["||cdn.net^$third-party\n||own.example.co.uk^$~third-party"]);
  expect(blocks(e, "https://cdn.net/a.js", "https://site.com/")).toBe(true);
  expect(blocks(e, "https://cdn.net/a.js", "https://www.cdn.net/page")).toBe(false);
  expect(blocks(e, "https://own.example.co.uk/a.js", "https://www.example.co.uk/")).toBe(true);
  expect(blocks(e, "https://own.example.co.uk/a.js", "https://other.co.uk/")).toBe(false);
});

test("domain options look at the page that makes the request", () => {
  const e = engine(["||ads.net^$domain=site.com|other.org\n||pixel.io^$domain=~safe.com"]);
  expect(blocks(e, "https://ads.net/a.js", "https://site.com/film")).toBe(true);
  expect(blocks(e, "https://ads.net/a.js", "https://m.site.com/film")).toBe(true);
  expect(blocks(e, "https://ads.net/a.js", "https://notsite.com/film")).toBe(false);
  expect(blocks(e, "https://ads.net/a.js", "https://elsewhere.com/")).toBe(false);
  expect(blocks(e, "https://pixel.io/p", "https://elsewhere.com/")).toBe(true);
  expect(blocks(e, "https://pixel.io/p", "https://www.safe.com/")).toBe(false);
});

test("not 1:1: in a frame, domain options look at the frame, where the apps look at the top page", () => {
  const e = engine(["||ads.net^$domain=site.com"]);
  const fromPlayer = { url: "https://ads.net/a.js", type: "script" as const, initiator: "https://player.cdn.net", topUrl: "https://site.com/film" };
  expect(e.blocks(fromPlayer)).toBe(false);
  expect(e.blocks({ ...fromPlayer, initiator: "https://site.com" })).toBe(true);
});

test("resource types map from the request's context", () => {
  const e = engine(["||img.ads.com^$image\n||xhr.ads.com^$xmlhttprequest\n||css.ads.com^$stylesheet\n||ws.ads.com^$websocket\n||other.ads.com^$~script"]);
  expect(blocks(e, "https://img.ads.com/a.png", null, "Image")).toBe(true);
  expect(blocks(e, "https://img.ads.com/a.png", null, "Script")).toBe(false);
  expect(blocks(e, "https://xhr.ads.com/a", null, "XmlHttpRequest")).toBe(true);
  expect(blocks(e, "https://xhr.ads.com/a", null, "Fetch")).toBe(true);
  expect(blocks(e, "https://css.ads.com/a.css", null, "Stylesheet")).toBe(true);
  expect(blocks(e, "wss://ws.ads.com/socket", null, "Websocket")).toBe(true);
  expect(blocks(e, "https://other.ads.com/a", null, "Image")).toBe(true);
  expect(blocks(e, "https://other.ads.com/a", null, "Script")).toBe(false);
});

test("subdocument rules only block frames", () => {
  const e = engine(["||player-ads.com^$subdocument"]);
  expect(blocks(e, "https://player-ads.com/frame", "https://site.com/", "Document")).toBe(true);
  expect(blocks(e, "https://player-ads.com/frame", null, "Document", true)).toBe(false);
  expect(blocks(e, "https://player-ads.com/x.js", "https://site.com/", "Script")).toBe(false);
});

test("untyped host rules block main-frame navigations too", () => {
  expect(blocks(engine(["||popads.net^"]), "https://popads.net/", null, "Document", true)).toBe(true);
});

test("not 1:1: untyped path rules leave the page itself alone", () => {
  // WebKit applies every untyped rule to the top-level page; DNR leaves main_frame out unless
  // asked, and "/ads/" shouldn't stop someone opening an article about ads.
  const e = engine(["/ads/banner"]);
  expect(blocks(e, "https://news.example/ads/banner", null, "Document", true)).toBe(false);
  expect(blocks(e, "https://news.example/ads/banner", "https://news.example/", "Document")).toBe(true);
});

test("lists can be switched off", () => {
  const sets = rulesetsOf([{ id: "easylist", text: "||a-ads.com^" }, { id: "peterlowe", text: "||b-ads.com^" }]);
  const only = (ids: string[]) => new DnrMatcher(ids.map((id) => ({ id, rules: sets.get(id)! })));
  const all = only(["easylist", "peterlowe"]);
  expect(all.blocks(dnrRequest("https://a-ads.com/x", null, "Script", false))).toBe(true);
  expect(only(["peterlowe"]).blocks(dnrRequest("https://a-ads.com/x", null, "Script", false))).toBe(false);
  expect(only(["peterlowe"]).blocks(dnrRequest("https://b-ads.com/x", null, "Script", false))).toBe(true);
  expect(only([]).blocks(dnrRequest("https://b-ads.com/x", null, "Script", false))).toBe(false);
});

test("reports the rule that blocked", () => {
  const e = engine(["||ads.com^\n||ads.com/banner$image"]);
  const decision = e.decide(dnrRequest("https://ads.com/banner.png", null, "Image", false));
  expect(decision.action).toBe("block");
  expect(decision.rule!.rule.condition.requestDomains ?? decision.rule!.rule.condition.urlFilter).toBeTruthy();
});

// MARK: Cosmetic

test("CSS combines generic and site rules", () => {
  const e = cosmetic(["##.ad-a\n##.ad-b\nexample.com,other.org##.banner\n~example.com##.promo\n##.sponsor\nexample.com#@#.sponsor"]);
  const css = e.cssFor("www.example.com");
  expect(css).toContain(".ad-a,.ad-b{display:none !important;}");
  expect(css).toContain(".banner{display:none !important;}");
  expect(css).not.toContain(".promo");
  expect(css).not.toContain(".sponsor");

  const elsewhere = e.cssFor("news.site.net");
  expect(elsewhere).toContain(".promo{display:none !important;}");
  expect(elsewhere).toContain(".sponsor{display:none !important;}");
  expect(elsewhere).not.toContain(".banner");
});

test("CSS accepts a URL and ignores case", () => {
  const e = cosmetic(["example.com##.banner"]);
  expect(e.cssFor("https://WWW.Example.com/watch?v=1")).toContain(".banner");
  expect(e.cssFor("Example.com.")).toContain(".banner");
  expect(e.cssFor("example.org")).toBe("");
});

test("CSS comes from switched-on lists only", () => {
  const e = cosmetic([{ id: "a", text: "##.from-a" }, { id: "b", text: "##.from-b" }]);
  const css = e.cssFor("site.com", ["b"]);
  expect(css).not.toContain(".from-a");
  expect(css).toContain(".from-b");
  expect(e.cssFor("site.com", [])).toBe("");
});

// MARK: The bundled lists

test("the bundled lists block known ad servers", () => {
  const lists = bundledLists();
  const e = engine(lists);
  expect(blocks(e, "https://securepubads.g.doubleclick.net/tag/js/gpt.js", "https://www.imdb.com/")).toBe(true);
  expect(blocks(e, "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js", "https://example.com/")).toBe(true);
  expect(blocks(e, "https://c1.popads.net/pop.js", "https://streaming.example/")).toBe(true);
  expect(blocks(e, "https://www.google-analytics.com/analytics.js", "https://example.com/")).toBe(true);
  expect(blocks(e, "https://www.example.com/", null, "Document", true)).toBe(false);
  expect(blocks(e, "https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js", "https://player.example/")).toBe(false);
  expect(blocks(e, "https://www.youtube.com/watch?v=dQw4w9WgXcQ", null, "Document", true)).toBe(false);
  // A pop-under landing on an ad network is stopped, as in the apps.
  expect(blocks(e, "https://www.popads.net/", null, "Document", true)).toBe(true);
  expect(cosmetic(lists).cssFor("example.com")).toContain(".ad-overlay");
});
