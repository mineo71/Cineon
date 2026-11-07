// Builds the extension for Chrome/Edge and Firefox into dist/<target>.
//
//   node scripts/build.mjs             both targets
//   node scripts/build.mjs --watch     rebuild on change (Chrome only)
//   node scripts/build.mjs --package   also zip each target into packages/
//   node scripts/build.mjs --dev       a development build: __DEV__ is true (the debug/* hooks); --watch implies it
//
// The page scripts are the Mac app's own files (../Cineon/Resources/Scripts), bundled as they are
// except for one line: where they look up `window.webkit.messageHandlers`, they get the extension's
// shim instead (src/content/shim.ts), the same trick the Windows port uses for WebView2.
// `import media from "@page/media.js"` gives the source as a string; `import run from
// "@page-run/media.js"` gives it wrapped in a function, so a content script runs it without eval.
import { build, context } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile, readdir, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(root, "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const args = new Set(process.argv.slice(2));
const targets = args.has("--watch") ? ["chrome"] : ["chrome", "firefox"];
const dev = args.has("--dev") || args.has("--watch");

const MacHandlers = "window.webkit && window.webkit.messageHandlers";
const ExtensionHandlers = "globalThis.__cineonHandlers";

/** `import media from "@page/media.js"` gives the Mac's script as a string, ready to run. */
const pageScripts = {
  name: "page-scripts",
  setup(b) {
    b.onResolve({ filter: /^@page(-run)?\// }, (a) => {
      const run = a.path.startsWith("@page-run/");
      return {
        path: path.join(repo, "Cineon/Resources/Scripts", a.path.slice(run ? "@page-run/".length : "@page/".length)),
        namespace: run ? "page-run" : "page-script",
      };
    });
    b.onLoad({ filter: /.*/, namespace: "page-script" }, async (a) => {
      const source = (await readFile(a.path, "utf8")).replaceAll(MacHandlers, ExtensionHandlers);
      return { contents: `export default ${JSON.stringify(source)};`, loader: "js" };
    });
    b.onLoad({ filter: /.*/, namespace: "page-run" }, async (a) => {
      const source = (await readFile(a.path, "utf8")).replaceAll(MacHandlers, ExtensionHandlers);
      return { contents: `export default function run() {\n${source}\n}\n`, loader: "js" };
    });
  },
};

const entries = [
  { in: "src/background/index.ts", out: "background", format: "esm" },
  { in: "src/content/isolated.ts", out: "content", format: "iife" },
  { in: "src/content/main.ts", out: "content-main", format: "iife" },
  { in: "src/offscreen/index.ts", out: "offscreen", format: "esm" },
  { in: "src/ui/app.tsx", out: "app", format: "esm" },
  { in: "src/ui/popup.tsx", out: "popup", format: "esm" },
].filter((e) => existsSync(path.join(root, e.in)));

function manifest(target) {
  const firefox = target === "firefox";
  const m = {
    manifest_version: 3,
    name: "Cineon",
    short_name: "Cineon",
    version: pkg.version,
    description: "Remembers what you watch and where you stopped, plays the next episode, finds films on your other sites, blocks ads, saves films and lets you watch with friends.",
    icons: { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" },
    action: { default_title: "Cineon", default_popup: "popup.html", default_icon: { 16: "icons/icon-16.png", 32: "icons/icon-32.png" } },
    background: firefox ? { scripts: ["background.js"], type: "module" } : { service_worker: "background.js", type: "module" },
    permissions: [
      "storage", "unlimitedStorage", "tabs", "scripting", "webNavigation", "webRequest", "declarativeNetRequest",
      "declarativeNetRequestFeedback", "downloads", "downloads.open", "notifications", "alarms", "contextMenus", "history",
      "clipboardWrite",
      ...(firefox ? [] : ["offscreen", "power", "sidePanel"]),
    ],
    host_permissions: ["<all_urls>"],
    content_scripts: [
      { matches: ["<all_urls>"], js: ["content.js"], run_at: "document_start", all_frames: true, match_about_blank: true },
      { matches: ["<all_urls>"], js: ["content-main.js"], run_at: "document_start", all_frames: true, world: "MAIN" },
    ],
    declarative_net_request: { rule_resources: rulesets() },
    web_accessible_resources: [{ resources: ["fonts/*", "logo-mark.png"], matches: ["<all_urls>"] }],
    commands: {
      "play-pause": { suggested_key: { default: "Alt+Shift+P" }, description: "Play or pause" },
      "save-moment": { suggested_key: { default: "Alt+Shift+M" }, description: "Save this moment" },
      "download-video": { suggested_key: { default: "Alt+Shift+S" }, description: "Download this video" },
      "find-elsewhere": { suggested_key: { default: "Alt+Shift+E" }, description: "Find this on another site" },
    },
    minimum_chrome_version: "120",
  };
  if (firefox) {
    m.browser_specific_settings = { gecko: { id: "cineon@mineo71.github.io", strict_min_version: "128.0" } };
    m.sidebar_action = { default_title: "Cineon", default_panel: "app.html#panel", default_icon: "icons/icon-32.png" };
    delete m.minimum_chrome_version;
  } else {
    m.side_panel = { default_path: "app.html#panel" };
  }
  return m;
}

/** Static DNR rulesets made by scripts/filters.mjs, one per filter list. */
function rulesets() {
  const index = path.join(root, "build/rules/index.json");
  if (!existsSync(index)) return [];
  return JSON.parse(readFileSync(index, "utf8"));
}

async function html(out, title, script) {
  await writeFile(path.join(out, `${script}.html`), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="ui.css">
</head>
<body>
<div id="root"></div>
<script type="module" src="${script}.js"></script>
</body>
</html>
`);
}

async function buildTarget(target, watch) {
  const out = path.join(root, "dist", target);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  if (existsSync(path.join(root, "scripts/filters.mjs")) && !existsSync(path.join(root, "build/rules/index.json"))) {
    execFileSync(process.execPath, [path.join(root, "scripts/filters.mjs")], { stdio: "inherit" });
  }
  const options = {
    absWorkingDir: root,
    entryPoints: entries.map((e) => ({ in: e.in, out: e.out })),
    outdir: out,
    bundle: true,
    target: target === "firefox" ? ["firefox128"] : ["chrome120"],
    sourcemap: watch ? "inline" : false,
    minify: !watch,
    legalComments: "none",
    plugins: [pageScripts],
    define: { __TARGET__: JSON.stringify(target), __VERSION__: JSON.stringify(pkg.version), __DEV__: JSON.stringify(dev) },
    jsx: "automatic",
    jsxImportSource: "preact",
    loader: { ".css": "text" },
    logLevel: "warning",
  };
  // Content scripts are classic scripts; everything else is a module.
  const iife = entries.filter((e) => e.format === "iife");
  const esm = entries.filter((e) => e.format === "esm");
  const builds = [];
  if (iife.length) builds.push({ ...options, entryPoints: iife.map((e) => ({ in: e.in, out: e.out })), format: "iife" });
  if (esm.length) builds.push({ ...options, entryPoints: esm.map((e) => ({ in: e.in, out: e.out })), format: "esm", splitting: false });
  if (watch) {
    for (const b of builds) await (await context(b)).watch();
  } else {
    await Promise.all(builds.map((b) => build(b)));
  }

  await writeFile(path.join(out, "manifest.json"), JSON.stringify(manifest(target), null, 2));
  await cp(path.join(root, "assets/icons"), path.join(out, "icons"), { recursive: true });
  await cp(path.join(root, "assets/fonts"), path.join(out, "fonts"), { recursive: true });
  await cp(path.join(root, "assets/logo-mark.png"), path.join(out, "logo-mark.png"));
  if (existsSync(path.join(root, "src/ui/ui.css"))) await cp(path.join(root, "src/ui/ui.css"), path.join(out, "ui.css"));
  if (existsSync(path.join(root, "build/rules"))) await cp(path.join(root, "build/rules"), path.join(out, "rules"), { recursive: true });
  if (existsSync(path.join(root, "build/cosmetic"))) await cp(path.join(root, "build/cosmetic"), path.join(out, "cosmetic"), { recursive: true });
  if (entries.some((e) => e.out === "app")) await html(out, "Cineon", "app");
  if (entries.some((e) => e.out === "popup")) await html(out, "Cineon", "popup");
  if (entries.some((e) => e.out === "offscreen")) await html(out, "Cineon", "offscreen");

  if (args.has("--package")) {
    const packages = path.join(root, "packages");
    await mkdir(packages, { recursive: true });
    const zip = path.join(packages, `Cineon-extension-${pkg.version}-${target}.zip`);
    await rm(zip, { force: true });
    execFileSync("zip", ["-qr", zip, "."], { cwd: out });
    console.log(`Packed ${path.relative(root, zip)} (${((await stat(zip)).size / 1e6).toFixed(1)} MB)`);
  }
  const files = await readdir(out);
  console.log(`Built dist/${target}: ${files.length} files`);
}

for (const target of targets) await buildTarget(target, args.has("--watch"));
