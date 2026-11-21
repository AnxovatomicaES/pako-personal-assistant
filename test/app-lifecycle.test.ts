// createApp in demo mode, as src/server.ts runs it: built, listening, its services started (src/app/services.ts), the panel served, then
// stopped. Run in a process of its own, which must end by itself once the server is closed and the services stopped: no timer, socket
// or other handle left that keeps it alive.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const src = (f: string) => JSON.stringify(new URL(`../src/${f}`, import.meta.url).href);

/** The child: Pako's demo week on a throwaway home, on a free port of this computer, with no network beyond it. */
const CHILD = `
import { createServer } from "node:http";
import { join } from "node:path";
import { createApp, loadAppConfig } from ${src("app.ts")};
import { appServices } from ${src("app/services.ts")};
import { createLocalChannel, createSettings, loadHome, localEnv } from ${src("local.ts")};
import { demoDir, demoEnv, demoStart, seedDemo } from ${src("demo.ts")};
import { sqliteKv } from ${src("sqlite-kv.ts")};

const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => (String(url).startsWith("http://127.0.0.1:") ? realFetch(url, init) : Promise.reject(new Error("no network")));
const real = loadHome({ PAKO_HOME: join(process.env.ROOT, "home"), PAKO_SECRET_STORE: "file" });
demoStart(real.dir);
const home = { ...real, dir: demoDir(real.dir), name: "Alex" };
const outer = { PERSONAL_TIMEZONE: "Europe/Madrid" };
demoEnv(outer);
const env = { ...localEnv(outer, home, 0), PAKO_HOME: home.dir };
const kv = sqliteKv(home.dir);
await seedDemo(kv, { now: Date.now(), timeZone: "Europe/Madrid", name: "Alex" });
const local = {
  kv, channel: createLocalChannel({ kv }), bridgeToken: real.bridgeToken, panelSecret: real.panelSecret,
  bridge: { status: () => ({ claude: "login", running: false }) }, settings: createSettings(home.dir, env), demo: { on: true, home: real.dir },
};
const app = createApp(loadAppConfig(env), env, local);
const services = appServices(app);
const server = createServer(app);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
await services.lifecycle.start();
const base = "http://127.0.0.1:" + server.address().port;
const health = await realFetch(base + "/health");
const login = await realFetch(services.panelLink().replace(/^http:\\/\\/127\\.0\\.0\\.1:\\d+/, base), { redirect: "manual" });
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
const panel = await realFetch(base + "/panel", { headers: { cookie } });
const phone = await (await realFetch(base + "/panel/api/phone", { headers: { cookie } })).json();
console.log("STARTED " + JSON.stringify({ order: services.lifecycle.order(), health: health.status, panel: panel.status, phone }));
await services.lifecycle.stop();
await services.lifecycle.stop();
await new Promise((r) => { server.close(r); server.closeAllConnections(); });
// What still keeps this process alive (Node lists only what does: an unref'd timer is not there), once the closed sockets are gone.
await new Promise((r) => setTimeout(r, 500));
await new Promise((r) => setImmediate(r));
console.log("STOPPED " + JSON.stringify(process.getActiveResourcesInfo()));
`;

test("demo mode: createApp starts its services, serves the panel, stops, and its process then ends by itself (no open handles)", async () => {
  const root = mkdtempSync(join(tmpdir(), "pako-lifecycle-"));
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", CHILD], {
    env: { PATH: process.env.PATH ?? "", HOME: root, ROOT: root, TZ: "Europe/Madrid", PAKO_NO_OPEN: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const ended = await new Promise<{ code: number | null; killed: boolean }>((resolve) => {
    // Long enough for a loaded machine to start Node and build the app; a process kept alive by a handle never ends on its own.
    const limit = setTimeout(() => (child.kill("SIGKILL"), resolve({ code: null, killed: true })), 40_000);
    child.on("exit", (code) => (clearTimeout(limit), resolve({ code, killed: false })));
  });
  assert.equal(ended.killed, false, `the process did not end by itself after the stop: something is still open\n${out}`);
  assert.equal(ended.code, 0, out);
  const started = /STARTED (\{.*\})/.exec(out);
  assert.ok(started, out);
  const s = JSON.parse(started[1]!) as { order: string[]; health: number; panel: number; phone: { on: boolean; addresses: string[] } };
  assert.deepEqual(s.order, ["storeGuard", "telegram", "watchdog", "mobile"], "a computer in the demo: no Slack socket, no WhatsApp of its own");
  assert.deepEqual([s.phone.on, s.phone.addresses], [false, []], "the phone's server: off by default, nothing listens on the home network");
  assert.equal(s.health, 200);
  assert.equal(s.panel, 200);
  const left = /STOPPED (\[.*\])/.exec(out);
  assert.ok(left, out);
  assert.deepEqual((JSON.parse(left[1]!) as string[]).filter((r) => r !== "PipeWrap"), [], "nothing left open after the stop but stdout and stderr");
});
