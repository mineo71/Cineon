// Builds the demo page into demo/site: the Chrome build's Cineon page, opened as an ordinary web page
// (it falls back to localStorage and works without the background), with demo/seed.ts in front of it
// to fill a profile with a made-up library.
//
//   node demo/build.mjs           uses dist/chrome, building it first when it's missing
//   node demo/build.mjs --build   rebuilds dist/chrome first
import { build } from "esbuild";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const dist = path.join(root, "dist/chrome");
const site = path.join(here, "site");

if (process.argv.includes("--build") || !existsSync(path.join(dist, "app.js"))) {
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: root, stdio: "inherit" });
}

await rm(site, { recursive: true, force: true });
await cp(dist, site, { recursive: true });

const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
await build({
  entryPoints: [path.join(here, "seed.ts")],
  outfile: path.join(site, "demo.js"),
  bundle: true,
  format: "esm",
  target: "chrome120",
  logLevel: "warning",
  define: { __TARGET__: '"chrome"', __VERSION__: JSON.stringify(pkg.version), __DEV__: "false" },
  jsx: "automatic",
  jsxImportSource: "preact",
  loader: { ".css": "text" },
});

const app = await readFile(path.join(site, "app.html"), "utf8");
await writeFile(path.join(site, "index.html"), app.replace('src="app.js"', 'src="demo.js"'));
console.log(`demo page in ${path.relative(process.cwd(), site)}; serve it with node demo/serve.mjs`);
