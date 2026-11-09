// Serves demo/site at http://localhost:4317 (PORT to change it). Run demo/build.mjs first.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const site = path.join(path.dirname(fileURLToPath(import.meta.url)), "site");
const port = Number(process.env.PORT ?? 4317);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const file = path.join(site, path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, ""));
  const target = url.pathname === "/" ? path.join(site, "index.html") : file;
  if (!target.startsWith(site)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, { "content-type": types[path.extname(target)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`Cineon demo at http://localhost:${port}/`));
