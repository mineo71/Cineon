// Converts the apps' filter lists (../Cineon/Resources/Filters/*.txt) into what the extension ships:
//
//   build/rules/<id>.json      one declarativeNetRequest static ruleset per list
//   build/rules/index.json     the manifest's rule_resources, most valuable list first
//   build/rules/meta.json      counts per list: the apps' rules, DNR rules, what was trimmed
//   build/cosmetic/<id>.json   element-hiding CSS keyed by host, for ShieldRules.cssFor
//
//   node scripts/filters.mjs [--lists <dir>] [--out <dir>]
//
// The build runs this when build/rules/index.json is missing. The conversion itself is TypeScript
// (src/core/shields), bundled here with esbuild so the build and the tests use the same code.
import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : fallback;
};
const listsDir = option("--lists", path.resolve(root, "../Cineon/Resources/Filters"));
const outDir = option("--out", path.join(root, "build"));

async function loadConverter() {
  const bundle = await build({
    stdin: {
      contents: [
        'export { buildRulesets } from "./src/core/shields/dnrRules";',
        'export { compileList } from "./src/core/shields/filterConverter";',
        'export { cosmeticMap } from "./src/core/shields/cosmetic";',
        'export { FILTER_CATALOG } from "./src/core/shields/catalog";',
      ].join("\n"),
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    logLevel: "warning",
  });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
}

/** One rule per line: small, and still readable in a diff. */
const rulesJson = (rules) => `[\n${rules.map((r) => JSON.stringify(r)).join(",\n")}\n]\n`;

const started = Date.now();
const { buildRulesets, compileList, cosmeticMap, FILTER_CATALOG } = await loadConverter();
const sources = await Promise.all(
  FILTER_CATALOG.map(async (info) => ({ id: info.id, text: await readFile(path.join(listsDir, `${info.id}.txt`), "utf8") })),
);

const rulesets = buildRulesets(sources);
const rulesDir = path.join(outDir, "rules");
const cosmeticDir = path.join(outDir, "cosmetic");
await rm(rulesDir, { recursive: true, force: true });
await rm(cosmeticDir, { recursive: true, force: true });
await mkdir(rulesDir, { recursive: true });
await mkdir(cosmeticDir, { recursive: true });

for (const [id, rules] of rulesets.rules) await writeFile(path.join(rulesDir, `${id}.json`), rulesJson(rules));
for (const { id, text } of sources) await writeFile(path.join(cosmeticDir, `${id}.json`), JSON.stringify(cosmeticMap(compileList(text))));
await writeFile(path.join(rulesDir, "meta.json"), JSON.stringify(rulesets.meta, null, 2) + "\n");
// Last: the build takes its presence to mean everything else is there.
await writeFile(path.join(rulesDir, "index.json"), JSON.stringify(rulesets.index, null, 2) + "\n");

const pad = (v, n) => String(v).padStart(n);
console.log(`Filter lists -> ${path.relative(process.cwd(), rulesDir) || rulesDir}`);
console.log(`  ${"list".padEnd(18)}${pad("app rules", 10)}${pad("network", 9)}${pad("converted", 11)}${pad("DNR rules", 11)}${pad("trimmed", 9)}`);
for (const l of rulesets.meta.lists) {
  console.log(`  ${l.id.padEnd(18)}${pad(l.appRules, 10)}${pad(l.networkFilters, 9)}${pad(l.converted, 11)}${pad(l.emitted, 11)}${pad(l.trimmedRules, 9)}`);
}
console.log(`  ${rulesets.meta.enabledRules} DNR rules enabled by default (guaranteed: ${rulesets.meta.budget}), ${Date.now() - started} ms`);
