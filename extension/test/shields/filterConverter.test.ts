// A port of the apps' FilterConverterTests: the same lines are kept and skipped, and here they
// become DNR rules instead of WebKit JSON.

import { compileList, parseList, splitPattern, webkitUrlFilter, KIT_TYPES } from "../../src/core/shields/filterConverter";
import { ALLOW_ID_BASE, DNR_TYPES, Priority } from "../../src/core/shields/dnrRules";
import { cosmeticMap } from "../../src/core/shields/cosmetic";
import { rulesOf } from "./helpers";

const map = (text: string) => cosmeticMap(compileList(text));

test("host-anchored blocks become requestDomains, and stop the page itself too", () => {
  const r = rulesOf("||popads.net^");
  expect(r).toEqual([
    { id: 1, priority: Priority.block, action: { type: "block" }, condition: { requestDomains: ["popads.net"], resourceTypes: [...DNR_TYPES] } },
  ]);
});

test("options map to DNR conditions", () => {
  const [r] = rulesOf("||ads.example.com^$script,third-party,domain=site.com|other.org");
  expect(r!.condition).toEqual({
    requestDomains: ["ads.example.com"],
    resourceTypes: ["script"],
    domainType: "thirdParty",
    initiatorDomains: ["site.com", "other.org"],
  });
});

test("exceptions outrank blocks and have their own ids", () => {
  const r = rulesOf("@@||good.com^\n||bad.com^");
  expect(r.map((x) => [x.id, x.action.type, x.priority])).toEqual([
    [1, "block", Priority.block],
    [ALLOW_ID_BASE + 1, "allow", Priority.allow],
  ]);
  expect(Priority.allow).toBeGreaterThan(Priority.block);
});

test("generic cosmetic rules are batched", () => {
  expect(rulesOf("##.ad-a\n##.ad-b")).toEqual([]);
  expect(map("##.ad-a\n##.ad-b").generic).toBe(".ad-a,.ad-b{display:none !important;}\n");
});

test("site cosmetic rules are keyed by host", () => {
  const m = map("example.com,other.org##.banner");
  expect(m.specific).toEqual([".banner"]);
  expect(m.hosts).toEqual({ "example.com": [0], "other.org": [0] });
});

test("a cosmetic exception makes the rule skip that site", () => {
  const m = map("##.promo\nexample.com#@#.promo");
  expect(m.generic).toBe("");
  expect(m.unless).toEqual([[".promo", ["example.com"]]]);
});

test("whole-site exceptions become allowAllRequests on the page's load", () => {
  const r = rulesOf("@@||example.com^$document");
  expect(r).toEqual([
    {
      id: ALLOW_ID_BASE + 1, priority: Priority.listSiteException, action: { type: "allowAllRequests" },
      condition: { requestDomains: ["example.com"], resourceTypes: ["main_frame"] },
    },
  ]);
  expect(map("@@||example.com^$document").except).toEqual(["example.com"]);
});

test("unsupported rules are skipped", () => {
  const text = [
    "! comment",
    "[Adblock Plus 2.0]",
    "example.com##+js(noop)",
    "example.com#?#.a:has-text(ad)",
    "||a.com^$csp=script-src 'none'",
    "||b.com^$redirect=noop.js",
    "/banner[0-9]+/",
    "||c.com^$popup",
    "||кино.рф^",
  ].join("\n");
  expect(rulesOf(text)).toEqual([]);
  expect(compileList(text).skipped).toBe(7);
});

test("both domain kinds never appear together", () => {
  const [r] = rulesOf("||x.example.net^$domain=a.com|~b.com");
  expect(r!.condition.initiatorDomains).toEqual(["a.com"]);
  expect(r!.condition.excludedInitiatorDomains).toBeUndefined();
});

test("special characters: the Mac escapes them, DNR takes the pattern as it is", () => {
  expect(webkitUrlFilter("/ads.js?v=1")).toBe("/ads\\.js\\?v=1");
  expect(webkitUrlFilter("|https://x.com/a*b|")).toBe("^https://x\\.com/a.*b$");
  expect(rulesOf("/ads.js?v=1")[0]!.condition.urlFilter).toBe("/ads.js?v=1");
  expect(rulesOf("|https://x.com/a*b|")[0]!.condition.urlFilter).toBe("|https://x.com/a*b|");
});

test("too short a pattern is rejected", () => {
  expect(splitPattern("*^")).toBeNull();
  expect(webkitUrlFilter("*^")).toBeNull();
});

test("options keep the apps' meaning", () => {
  const [r] = rulesOf("||cdn.example.com/x.js$match-case,subdocument,~third-party,domain=~a.com");
  expect(r!.condition).toEqual({
    urlFilter: "||cdn.example.com/x.js",
    isUrlFilterCaseSensitive: true,
    resourceTypes: ["sub_frame"],
    domainType: "firstParty",
    excludedInitiatorDomains: ["a.com"],
  });
});

test("excluded types replace the list", () => {
  const parsed = parseList("||example.com/ad$script,~image").blocks[0]!;
  expect(parsed.types).toEqual(KIT_TYPES.filter((t) => t !== "image"));
  const [r] = rulesOf("||example.com/ad$script,~image");
  expect(r!.condition.resourceTypes).toBeUndefined();
  // A path rule leaves the page itself alone, as DNR does by default.
  expect(r!.condition.excludedResourceTypes).toEqual(["main_frame", "image"]);
  // A host rule with excluded types still stops the page, as in the apps.
  expect(rulesOf("||example.com^$~image")[0]!.condition.excludedResourceTypes).toEqual(["image"]);
});

test("element-hiding exceptions turn the list's element hiding off for the site", () => {
  for (const option of ["elemhide", "generichide", "ghide", "ehide"]) {
    const parsed = parseList(`@@||example.com^$${option}`).exceptions[0]!;
    expect(parsed.wholeSite).toEqual({ domain: "example.com", kind: "elemhide" });
    // Network blocking stays on there: DNR can't switch one list off for a site.
    expect(rulesOf(`@@||example.com^$${option}`)).toEqual([]);
    expect(map(`@@||example.com^$${option}`).except).toEqual(["example.com"]);
  }
  expect(parseList("@@||example.com^$doc").exceptions[0]!.wholeSite).toEqual({ domain: "example.com", kind: "document" });
  expect(rulesOf("||example.com^$document")).toEqual([]);
  expect(rulesOf("@@||example.com/path^$document")).toEqual([]);
});

test("batches hold two hundred selectors", () => {
  const text = Array.from({ length: 450 }, (_, i) => `##.ad-${i}`).join("\n");
  const layout = compileList(text);
  expect(layout.cosmetic).toHaveLength(3);
  expect(layout.cosmetic[0]!.selector.split(",")).toHaveLength(200);
  expect(layout.cosmetic[2]!.selector.split(",")).toHaveLength(50);
});

test("over the limit, blocks go before exceptions", () => {
  const layout = compileList("||a1.com^\n||a2.com^\n||a3.com^\n@@||b1.com^\n@@||b2.com^", 3);
  expect(layout.ruleCount).toBe(3);
  expect(layout.skipped).toBe(2);
  expect(layout.blocks).toHaveLength(1);
  expect(layout.exceptions).toHaveLength(2);
});

test("regexes and paths in slashes", () => {
  expect(rulesOf("/ads/")).toEqual([]);
  expect(rulesOf("/ads/$script")).toEqual([]);
  expect(rulesOf("/ads/banner.gif")).toHaveLength(1);
});

// Beyond the apps' tests: how rules are folded and ranked.

test("host rules with the same options share one rule", () => {
  const r = rulesOf("||b.com^\n||a.com^\n||c.com^$third-party\n||d.com^$third-party\n||e.com^$image");
  expect(r.map((x) => x.condition.requestDomains)).toEqual([["a.com", "b.com"], ["c.com", "d.com"], ["e.com"]]);
  // Third-party and typed rules don't stop the page itself, as in the apps.
  expect(r[1]!.condition.resourceTypes).toBeUndefined();
  expect(r[2]!.condition.resourceTypes).toEqual(["image"]);
});

test("only exact host rules are folded", () => {
  const r = rulesOf("||ads.example\n||ads.com^|\n||ADS.ORG^\n||ads.net^$match-case\n||ads.*^");
  expect(r.map((x) => x.condition.requestDomains ?? x.condition.urlFilter)).toEqual([["ads.org"], "||ads.example", "||ads.com^|", "||ads.net^", "||ads.*^"]);
});

test("$important blocks outrank exceptions", () => {
  const r = rulesOf("||ads.com^$important\n||ads.net/x.js$important\n@@||ads.com/ok");
  expect(r.filter((x) => x.action.type === "block").map((x) => x.priority)).toEqual([Priority.important, Priority.important]);
  expect(Priority.important).toBeGreaterThan(Priority.allow);
});

test("each kind of type maps to DNR's", () => {
  const types = (option: string) => rulesOf(`/advert.js$${option}`)[0]!.condition.resourceTypes;
  expect(types("script")).toEqual(["script"]);
  expect(types("image")).toEqual(["image"]);
  expect(types("stylesheet")).toEqual(["stylesheet"]);
  expect(types("font")).toEqual(["font"]);
  expect(types("media")).toEqual(["media"]);
  expect(types("xhr")).toEqual(["xmlhttprequest"]);
  expect(types("websocket")).toEqual(["websocket"]);
  expect(types("other")).toEqual(["other", "object"]);
  expect(types("ping")).toEqual(["ping", "csp_report"]);
  expect(types("frame")).toEqual(["sub_frame"]);
  // "$script,subdocument": scripts and frames, as filter lists mean it.
  expect(types("script,subdocument")).toEqual(["script", "sub_frame"]);
});
