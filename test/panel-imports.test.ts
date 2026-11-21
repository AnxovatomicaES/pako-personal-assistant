// Every relative import of a panel page is a file the server serves (src/dashboard.ts PAGES): one missing is a module that never loads,
// and every card that imports it is blank, with no error a test would see. And the shared helpers (src/panel/dom.js) are the only copies.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const dir = new URL("../src/panel/", import.meta.url);
// PAGES (Pako's own files) and the vendor files served next to them ("three.module.js": { file: … }).
const served = new Set([...readFileSync(new URL("../src/dashboard.ts", import.meta.url), "utf8")
  .matchAll(/PAGES\["([^"]+)"\]|"([a-z0-9.-]+\.(?:js|css))": "text\/|"([a-z0-9.-]+\.(?:js|css|woff2))": \{ file:/g)].map((m) => m[1] ?? m[2] ?? m[3]));
const phone = new Set([...readFileSync(new URL("../src/mobile.ts", import.meta.url), "utf8").matchAll(/"([a-z0-9.-]+\.js)": "text\/javascript"/g)].map((m) => m[1]));

test("panel: every relative import is served", () => {
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".js"))) {
    const text = readFileSync(new URL(f, dir), "utf8");
    const list = phone.has(f) && !served.has(f) ? phone : served;
    for (const m of text.matchAll(/^import [^;]*? from "\.\/([^"]+)";/gm)) assert.ok(list.has(m[1]!), `${f} imports ./${m[1]}, which is not served`);
  }
});

test("panel: h() is defined once, in dom.js (the phone page keeps its own small one)", () => {
  const copies = readdirSync(dir).filter((x) => x.endsWith(".js") && /^function h\(tag/m.test(readFileSync(new URL(x, dir), "utf8")));
  assert.deepEqual(copies, ["m.js"]);
});

test("panel: one demo switch (demo.js switchDemo), used by the dashboard too, and it tells the Mac app", () => {
  const app = readFileSync(new URL("app.js", dir), "utf8");
  const demo = readFileSync(new URL("demo.js", dir), "utf8");
  assert.match(app, /import \{ switchDemo \} from "\.\/demo\.js";/);
  assert.doesNotMatch(app, /\/panel\/api\/demo\/\$\{kind\}/, "app.js no longer posts the switch itself");
  assert.match(demo, /export async function switchDemo\(kind, say\)[\s\S]*?postMessage\(\{ demo: kind === "start" \}\)/);
});
