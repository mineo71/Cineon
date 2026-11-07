// Writes what the C# side needs to record the apps' answers (see Program.cs):
//
//   node test/shields/apps-parity/input.mjs <dir>
//   dotnet run --project test/shields/apps-parity -- <dir> test/shields/fixtures/apps-parity.json
//
// <dir> gets the sampled lists, the requests and the hosts, made by corpus.ts.
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] ?? "apps-parity-input");

const raw = {
  name: "raw",
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (a) => ({ path: path.resolve(a.resolveDir, a.path.slice(0, -4)), namespace: "raw" }));
    b.onLoad({ filter: /.*/, namespace: "raw" }, async (a) => ({ contents: await readFile(a.path, "utf8"), loader: "text" }));
  },
};
const bundle = await build({ entryPoints: [path.join(here, "../corpus.ts")], bundle: true, format: "esm", platform: "node", write: false, plugins: [raw] });
const corpus = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

await mkdir(path.join(out, "sampled"), { recursive: true });
const sampled = corpus.sampledLists();
for (const { id, text } of sampled) await writeFile(path.join(out, "sampled", `${id}.txt`), text);
await writeFile(path.join(out, "requests.json"), JSON.stringify(corpus.corpus(sampled)));
await writeFile(path.join(out, "hosts.json"), JSON.stringify(corpus.cssHosts(corpus.bundledLists())));
console.log(`Wrote ${out}`);
