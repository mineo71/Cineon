// Agreement with the Mac's TitleParser, RescueMatcher, EpisodeLinks, SkipLearner, ImportAnalyzer.brand and
// the MetadataClient/PagePreview parsing: every case in the Windows port's MacParity/corpus.jsonl (page titles
// in English, Ukrainian and Russian, addresses, link texts, IMDb and Cinemeta responses, dates, HTML heads)
// gives the same line as ParsingDump.swift printed into MacParity/expected.txt when compiled with the Mac
// sources. Unlike the Windows port, nothing is skipped or replaced: ligatures and ß fold as ICU folds them,
// and relative addresses stay relative, as Foundation keeps them.
//
// Set CINEON_PARSING_DUMP to a file path to get this side's output for a diff, and CINEON_PARSING_CORPUS and
// CINEON_PARSING_EXPECTED to check a bigger run (make_corpus.py <seed> <scale> <out>, then the Swift dump).

import { readFileSync, writeFileSync } from "node:fs";
import { run } from "./parsingDump";

const here = new URL("../../../windows/Cineon.Core.Tests/Parsing/MacParity/", import.meta.url);
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

test("parsing matches the Mac, case for case", () => {
  const corpusText = readFileSync(env["CINEON_PARSING_CORPUS"] || new URL("corpus.jsonl", here), "utf8");
  const expected = readFileSync(env["CINEON_PARSING_EXPECTED"] || new URL("expected.txt", here), "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  const corpus = corpusText.split("\n").filter((l) => l.length > 0);
  const actual = run(corpusText);
  if (env["CINEON_PARSING_DUMP"]) writeFileSync(env["CINEON_PARSING_DUMP"], actual.join("\n") + "\n");

  expect(actual.length).toBe(expected.length);
  expect(actual.length).toBe(corpus.length);
  const differences: string[] = [];
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== actual[i]) differences.push(`case: ${corpus[i]}\nmac: ${expected[i]}\next: ${actual[i]}`);
  }
  expect(differences.length, `${differences.length} of ${expected.length} differ:\n` + differences.slice(0, 40).join("\n")).toBe(0);
}, 120_000);
