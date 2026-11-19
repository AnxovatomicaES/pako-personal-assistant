// A proposal for Pako's app icon (not the icon in use: desktop/mac/icon/main.swift draws that one): Pako's figure as the panel draws it
// (src/panel/orb.js, held still in its idle pose, eyes open) on Apple's rounded square, rendered by headless Chrome to a 1024 px PNG.
// Usage: node desktop/mac/icon/proposal/make-icon.mjs [out.png]   (default: pako-figure-1024.png next to this script). Needs Google Chrome.
// Everything is made here: a page served from this computer (127.0.0.1, a free port), Three.js from node_modules, no network.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const out = process.argv[2] ?? join(here, "pako-figure-1024.png");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; width: 1024px; height: 1024px; background: transparent; overflow: hidden; }
.tile { position: absolute; left: 100px; top: 100px; width: 824px; height: 824px; border-radius: 185px; overflow: hidden;
  background: radial-gradient(70% 60% at 50% 42%, #1b2a6b 0%, #0d1236 55%, #060815 100%);
  box-shadow: inset 0 2px 0 rgba(255, 255, 255, 0.08), inset 0 -30px 80px rgba(0, 0, 0, 0.45); }
.aura { position: absolute; inset: 0; background: radial-gradient(38% 38% at 50% 50%, rgba(60, 130, 255, 0.55), rgba(91, 70, 255, 0.18) 60%, transparent 80%),
  radial-gradient(30% 22% at 30% 78%, rgba(41, 196, 255, 0.22), transparent 70%), radial-gradient(28% 20% at 76% 22%, rgba(140, 110, 255, 0.25), transparent 70%); }
canvas { position: absolute; left: 0; top: 0; width: 824px; height: 824px; }
</style></head><body><div class="tile"><div class="aura"></div><canvas id="c"></canvas></div>
<script type="module">
import { startOrb } from "./orb.js";
const fig = startOrb(document.getElementById("c"), { pose: "idle", orb: 0.56, calm: 0.3 });
requestAnimationFrame(() => requestAnimationFrame(() => { fig.render(); document.title = "ready"; }));
</script></body></html>`;

const FILES = {
  "/": [PAGE, "text/html"],
  "/orb.js": [join(root, "src/panel/orb.js"), "text/javascript"],
  "/pako-figure.js": [join(root, "src/panel/pako-figure.js"), "text/javascript"],
  "/three.module.js": [join(root, "node_modules/three/build/three.module.js"), "text/javascript"],
  "/three.core.js": [join(root, "node_modules/three/build/three.core.js"), "text/javascript"],
};
const server = createServer((req, res) => {
  const f = FILES[req.url ?? ""];
  if (!f) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": f[1] }).end(f[0] === PAGE ? PAGE : readFileSync(f[0]));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const dir = mkdtempSync(join(tmpdir(), "pako-icon-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--hide-scrollbars",
  "--ignore-gpu-blocklist", "--window-size=1024,1024", "about:blank"], { stdio: "ignore" });
try {
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
    await wait(100);
    try {
      port = Number(readFileSync(join(dir, "DevToolsActivePort"), "utf8").split("\n")[0]);
    } catch {
      /* not yet */
    }
  }
  const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const waiting = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (waiting.has(m.id)) waiting.get(m.id)(m.result ?? {}), waiting.delete(m.id);
  });
  const send = (method, params = {}) => new Promise((r) => (waiting.set(++id, r), ws.send(JSON.stringify({ id, method, params }))));
  await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 1024, deviceScaleFactor: 1, mobile: false });
  await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  await send("Page.navigate", { url });
  for (let i = 0; i < 100; i++) {
    await wait(200);
    const r = await send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
    if (r.result?.value === "ready") break;
  }
  await wait(300);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log(`wrote ${out}`);
  ws.close();
} finally {
  chrome.kill();
  server.close();
  await wait(300);
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}
