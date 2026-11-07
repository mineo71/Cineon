// The DNR rules against the apps. The fixture holds the Windows port's own answers (its matcher is
// checked against the Mac's WebKit rules by its ShieldReferenceTests), recorded by apps-parity/.
//
// 1. The converter keeps exactly the apps' rules: same counts per list.
// 2. AppsMatcher (APPS semantics) gives the apps' answer for every request of the corpus, so it can
//    stand in for them.
// 3. The DNR rules, run by a DNR matcher, give the same answer as AppsMatcher with the deliberate
//    differences switched on (DNR semantics), for every request.
// 4. What each of those differences changes is counted, and the total stays small.
// 5. Element-hiding CSS per host is byte for byte the apps' CssFor(host).

import fixture from "./fixtures/apps-parity.json";
import { bundledLists, corpus, sampledLists, type Request } from "./corpus";
import { AppsMatcher, APPS, DNR, type Semantics } from "./appsMatcher";
import { DnrMatcher, dnrRequest } from "./dnrMatcher";
import { compileList } from "../../src/core/shields/filterConverter";
import { buildRulesets } from "../../src/core/shields/dnrRules";
import { CosmeticIndex, cosmeticMap } from "../../src/core/shields/cosmetic";
import { hostOf } from "../../src/core/shields/siteDomain";

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const sampled = sampledLists();
const requests = corpus(sampled);

function describe(r: Request): string {
  return `${r.url} on ${r.page ?? "itself"} as ${r.type}${r.mainFrame ? " (main frame)" : ""}`;
}

function answers(semantics: Semantics): string {
  const matcher = new AppsMatcher(sampled, semantics);
  return requests.map((r) => (matcher.blocksRequest(r) ? "1" : "0")).join("");
}

function differences(a: string, b: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

test("the corpus is the one the apps answered", async () => {
  expect(await sha256(JSON.stringify(requests))).toBe(fixture.requestsSha256);
  expect(fixture.decisions).toHaveLength(requests.length);
});

test("each list keeps exactly the apps' rules", () => {
  let total = 0;
  for (const { id, text } of bundledLists()) {
    const layout = compileList(text);
    const apps = fixture.lists[id as keyof typeof fixture.lists];
    const wholeSite = layout.exceptions.filter((f) => f.wholeSite).length;
    expect({
      ruleCount: layout.ruleCount,
      skipped: layout.skipped,
      blocks: layout.blocks.length,
      exceptions: layout.exceptions.length,
      cosmetic: layout.cosmetic.length,
    }, id).toEqual(apps);
    expect(wholeSite).toBeLessThanOrEqual(layout.exceptions.length);
    total += layout.ruleCount;
  }
  // The number the Windows notes give for the five lists.
  expect(total).toBe(116_157);
});

const appsAnswers = answers(APPS);

test("the reference matcher answers as the apps do", () => {
  const wrong = differences(appsAnswers, fixture.decisions);
  expect(wrong.slice(0, 5).map((i) => `${describe(requests[i]!)}: apps say ${fixture.decisions[i] === "1" ? "block" : "allow"}`)).toEqual([]);
  // The corpus exercises blocking.
  expect([...fixture.decisions].filter((c) => c === "1").length).toBeGreaterThan(requests.length / 10);
});

test("the DNR rules answer as the apps would with DNR's semantics", () => {
  const rulesets = buildRulesets(sampled, { budget: Number.POSITIVE_INFINITY });
  const dnr = new DnrMatcher([...rulesets.rules].map(([id, rules]) => ({ id, rules })));
  const expected = answers(DNR);
  const actual = requests.map((r) => (dnr.blocks(dnrRequest(r.url, r.page, r.type, r.mainFrame)) ? "1" : "0")).join("");
  const wrong = differences(actual, expected);
  expect(wrong.slice(0, 5).map((i) => `${describe(requests[i]!)}: expected ${expected[i] === "1" ? "block" : "allow"}`)).toEqual([]);
});

/**
 * A host a browser would really send: the corpus also writes "^" as "", "=", "&" or "-" right
 * after a host, giving hosts like "ads.com&" or "ads.com-" that only exist to probe the Mac's
 * optional separator.
 */
function wellFormed(url: string): boolean {
  const host = hostOf(url.toLowerCase());
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host) && host.split(".").every((l) => !l.startsWith("-") && !l.endsWith("-")) && !/\.(png|js)$/.test(host);
}

test("what each deliberate difference changes", () => {
  const knobs = Object.keys(DNR) as (keyof Semantics)[];
  const dnrAnswers = answers(DNR);
  const all = differences(dnrAnswers, appsAnswers);
  // Each switch on its own, asked only where the answers differ.
  const byKnob = new Map(knobs.map((knob) => {
    const matcher = new AppsMatcher(sampled, { ...APPS, [knob]: DNR[knob] } as Semantics);
    return [knob, new Set(all.filter((i) => (matcher.blocksRequest(requests[i]!) ? "1" : "0") !== appsAnswers[i]))];
  }));
  // Every difference comes from one of the switches; nothing else.
  for (const i of all) {
    if (!knobs.some((knob) => byKnob.get(knob)!.has(i))) expect.fail(`unexplained: ${describe(requests[i]!)}`);
  }

  const real = new Set(requests.map((r, i) => (wellFormed(r.url) ? i : -1)).filter((i) => i >= 0));
  const realDiff = all.filter((i) => real.has(i));
  const count = (knob: keyof Semantics, onlyReal: boolean) => [...byKnob.get(knob)!].filter((i) => !onlyReal || real.has(i)).length;
  console.info(
    `DNR vs apps: ${all.length} of ${requests.length} requests differ; ${realDiff.length} of the ${real.size} with real hosts.\n` +
      knobs.map((k) => `  ${k}: ${count(k, false)} (${count(k, true)} with real hosts)`).join("\n"),
  );

  // Most of the corpus's pages are sites the lists name, a fifth of them with $elemhide or
  // $generichide exceptions, where the apps drop the list's network rules too. Even so:
  expect(realDiff.length).toBeLessThan(real.size * 0.05);
  const others = realDiff.filter((i) => knobs.some((k) => k !== "wholeSite" && byKnob.get(k)!.has(i))).length;
  expect(others).toBeLessThan(real.size * 0.01);
}, 60_000);

test("element hiding is byte for byte the apps' CssFor", async () => {
  const index = new CosmeticIndex(bundledLists().map(({ id, text }) => ({ id, map: cosmeticMap(compileList(text)) })));
  const wrong: string[] = [];
  for (const [host, length, hash] of fixture.css as [string, number, string][]) {
    const css = index.cssFor(host);
    if (css.length !== length || (await sha256(css)).slice(0, 16) !== hash) wrong.push(`${host}: ${css.length} chars, the apps ${length}`);
  }
  expect(wrong.slice(0, 5)).toEqual([]);
  expect(fixture.css.length).toBeGreaterThan(500);
});
