// Core and Labs kept apart in the code (src/labs.ts LAB_FILES): no core file under src/ imports a lab's file except with `import type`.
// A lab's code is loaded with import() only while the lab is on (src/lab-code.ts), so a static import from core would load it always.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LAB_FILES, LAB_IDS, labOfFile } from "../src/labs.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|mts)$/.test(name)) out.push(p);
  }
  return out;
}

/** The modules a file loads when it is loaded: every import and re-export, less those that bring in types only. */
function staticImports(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/^\s*(?:import|export)\s+(type\s+)?([^;=()"']*?)\s*from\s*["']([^"']+)["']/gm)) {
    if (m[1]) continue;
    const clause = m[2]!.trim();
    const named = /^\{([^}]*)\}$/.exec(clause);
    if (named && named[1]!.split(",").map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith("type "))) continue;
    out.push(m[3]!);
  }
  for (const m of code.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) out.push(m[1]!);
  return out;
}

test("the import reader: values count, types and import() do not", () => {
  const code = [
    'import { a, type B } from "./one.ts";',
    'import type { C } from "./two.ts";',
    'import { type D, type E } from "./three.ts";',
    'import * as ns from "./four.ts";',
    'import def from "./five.ts";',
    'export { f } from "./six.ts";',
    'export type { G } from "./seven.ts";',
    'import "./eight.ts";',
    "import {\n  h,\n  type I,\n} from \"./nine.ts\";",
    'const later = () => import("./ten.ts");',
  ].join("\n");
  assert.deepEqual(staticImports(code).sort(), ["./eight.ts", "./five.ts", "./four.ts", "./nine.ts", "./one.ts", "./six.ts"]);
});

test("every lab's files are there, and every lab has its list", () => {
  assert.deepEqual(Object.keys(LAB_FILES).sort(), [...LAB_IDS].sort());
  for (const id of LAB_IDS) {
    for (const f of LAB_FILES[id]) {
      assert.ok(existsSync(join(root, f)), `${id}: ${f} is not there`);
      assert.equal(labOfFile(f.endsWith("/") ? `${f}x.ts` : f), id, f);
    }
  }
  assert.equal(labOfFile("src/whatsapp.ts"), null, "the chat door of every channel is core");
  assert.equal(labOfFile("src/booking-other.ts"), null, "a file is matched whole, not by its start");
});

test("no core file imports a lab's file, except its types", () => {
  const found: string[] = [];
  for (const file of sources(join(root, "src"))) {
    const from = relative(root, file).split("\\").join("/");
    if (labOfFile(from)) continue;
    for (const spec of staticImports(readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      const to = posix.normalize(posix.join(posix.dirname(from), spec));
      const lab = labOfFile(to);
      if (lab) found.push(`${from} -> ${to} (${lab})`);
    }
  }
  assert.deepEqual(found, [], `load these with import() behind the lab's gate (src/lab-code.ts), or import their types only:\n${found.join("\n")}`);
});

// The same at run time: a computer's app built as src/server.ts builds it, with every module it loads written down (module.registerHooks).
const CHILD = `
import { registerHooks } from "node:module";
const seen = new Set();
registerHooks({ resolve(spec, ctx, next) { const r = next(spec, ctx); seen.add(r.url); return r; } });
const src = process.env.SRC_URL;
const { createApp, loadAppConfig } = await import(src + "app.ts");
const { labsFor } = await import(src + "app/base.ts");
const { loadLabCode } = await import(src + "lab-code.ts");
const { createLocalChannel, createSettings, loadHome, localEnv } = await import(src + "local.ts");
const { sqliteKv } = await import(src + "sqlite-kv.ts");
const home = loadHome({ PAKO_HOME: process.env.HOME_DIR, PAKO_NAME: "Ana" });
const env = { ...localEnv({}, home, 0), PAKO_HOME: home.dir, PAKO_LABS: process.env.LABS };
const kv = sqliteKv(home.dir);
const local = {
  kv, channel: createLocalChannel({ kv }), bridgeToken: home.bridgeToken, panelSecret: home.panelSecret,
  bridge: { status: () => ({ claude: "ok", running: true }) }, settings: createSettings(home.dir, env),
};
await loadLabCode(labsFor(env, local));
const app = createApp(loadAppConfig(env), env, local);
app.locals.whatsappComputer?.stop();
process.stdout.write("\\nLOADED " + JSON.stringify([...seen].filter((u) => u.startsWith(src)).map((u) => "src/" + u.slice(src.length))));
process.exit(0);
`;

async function loadedFiles(labs: string): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "pako-labs-boundary-"));
  const script = join(dir, "child.mjs");
  writeFileSync(script, CHILD);
  const out = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, ["--disable-warning=ExperimentalWarning", script], {
      env: { ...process.env, SRC_URL: pathToFileURL(join(root, "src")).href + "/", HOME_DIR: join(dir, "home"), LABS: labs },
      timeout: 60_000,
    }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)));
  });
  return JSON.parse(out.slice(out.lastIndexOf("\nLOADED ") + 8)) as string[];
}

test("at run time: with every lab off no lab file is loaded; with them on, theirs are", async () => {
  const off = await loadedFiles("off");
  assert.ok(off.includes("src/app.ts") && off.includes("src/personal-caller.ts"), "the reader saw the app being loaded");
  assert.deepEqual(off.filter((f) => labOfFile(f)), [], "a lab that is off is never loaded");
  const on = await loadedFiles("on");
  for (const f of ["src/booking.ts", "src/app/booking.ts", "src/voice-bridge.ts", "src/whatsapp-computer.ts", "src/tunnel.ts", "src/relay.ts"]) {
    assert.ok(on.includes(f), `${f} is loaded with its lab on`);
  }
});
