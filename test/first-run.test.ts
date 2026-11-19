// A first start that never gets stuck (local mode: `npm install && npm start` with no keys). The preflight before `npm start`, `npm run panel` for a
// new sign-in link, the bridge telling the panel how Claude is doing (not signed in, out of its limit, failing to start, missing) and the chat's banner
// for each, a `claude` that only a shell alias reaches, the name question and the lock. The real scripts, the real app and the real server, with a
// stand-in `claude` and throwaway homes; nothing reaches the network.

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";
import { ClaudeError, createBridge, loadBridgeConfig, type BridgeConfig, type ClaudeResult } from "../assistant/bridge.ts";
import { createApp, loadAppConfig, type LocalContext } from "../src/app.ts";
import { isLoopback } from "../src/dashboard.ts";
import type { Kv } from "../src/kv.ts";
import { authFromStatus, createLocalChannel, hasAuthStatus, loadHome, localEnv, lockHolder, lockHome, processStart, superviseBridge, type ClaudeAuth } from "../src/local.ts";

const require = createRequire(import.meta.url);
const file = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const PREFLIGHT = file("bin/preflight.cjs");
const PANEL = file("bin/panel.cjs");
const ENTRY = file("src/server.ts");
const read = (p: string) => readFileSync(file(p), "utf8");
const tmp = () => mkdtempSync(join(tmpdir(), "pako-first-"));
const TOKEN = "t".repeat(48);

type Found = { problem: "node"; version: string } | { problem: "install"; missing: string[]; all: boolean };
const preflight = require(PREFLIGHT) as {
  nodeOk: (version: string) => boolean;
  check: (o: { version: string; dependencies?: Record<string, string>; has: (name: string) => boolean }) => Found | null;
  message: (found: Found) => string;
};
const panel = require(PANEL) as {
  readEnvFile: (path: string, names: string[]) => Record<string, string>;
  pakoHome: (env: Record<string, string | undefined>, cwd: string, userHome: string) => string;
  readLock: (home: string, upSeconds: number) => { pid: number; port: number; alive: boolean } | null;
};

/** Waits for a condition, checking often; the long limit is for a machine running the whole suite at once. */
async function until(ok: () => boolean | Promise<boolean>, ms = 30_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return ok();
}

function memoryKv(): Kv {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

/** Pako in local mode as src/server.ts builds it, in this process, on a port of its own (on the IPv6 loopback when asked). */
async function localRig(bridge: LocalContext["bridge"] = { status: () => ({ claude: "ok", running: true }) }, host = "127.0.0.1") {
  const home = loadHome({ PAKO_HOME: join(tmp(), "home"), PAKO_NAME: "Ana" });
  const env: Record<string, string | undefined> = { ...localEnv({}, home, 0), PAKO_HOME: home.dir };
  const kv = memoryKv();
  const channel = createLocalChannel({ kv });
  const local: LocalContext = { kv, channel, bridgeToken: home.bridgeToken, panelSecret: home.panelSecret, bridge };
  const server = createServer(createApp(loadAppConfig(env), env, local));
  await new Promise<void>((r, reject) => server.once("error", reject).listen(0, host, () => r()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  const bearer = (token = home.bridgeToken) => ({ authorization: `Bearer ${token}` });
  return {
    home,
    port,
    base,
    server,
    channel,
    notices: (after: number, headers: Record<string, string> = bearer()) => fetch(`${base}/panel/api/notices?after=${after}`, { headers }),
    /** The links name localhost and the configured port; the tests reach this server on its own port. */
    here: (link: string) => link.replace(/^http:\/\/127\.0\.0\.1:\d+/, base),
    askLink: (headers: Record<string, string> = bearer()) => fetch(`${base}/panel/api/link`, { method: "POST", headers }),
    health: (claude: unknown, token = home.bridgeToken) =>
      fetch(`${base}/assistant/health`, { method: "POST", headers: { ...bearer(token), "content-type": "application/json" }, body: JSON.stringify({ claude }) }),
    signIn: async (link: string): Promise<string> => {
      const r = await fetch(link.replace(/^http:\/\/127\.0\.0\.1:\d+/, base), { redirect: "manual" });
      assert.equal(r.status, 200);
      return (r.headers.get("set-cookie") ?? "").split(";")[0]!;
    },
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

/** One request to the server as if it came from another machine: the socket's own address is the one given (nothing is bound to the network). */
function requestFrom(server: Server, address: string, raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    const socket = new Duplex({
      read() {},
      write(chunk, _encoding, done) {
        out += String(chunk);
        done();
      },
      final(done) {
        done();
        resolve(out);
      },
    });
    Object.defineProperty(socket, "remoteAddress", { value: address });
    // Arrived on this server's own port, as a real connection does (local mode checks the Host header against it, src/guard-http.ts).
    Object.defineProperty(socket, "localPort", { value: (server.address() as AddressInfo).port });
    socket.on("error", reject);
    server.emit("connection", socket);
    // Not ended from this side: a client that hangs up first is not answered. The request says Connection: close, so the server ends it.
    socket.push(raw);
  });
}

// ---------- 1. the preflight before `npm start` ----------

test("preflight: an old Node.js is stopped with the one fix, in Spanish and English; 22.18 and newer go on (on the short 23 line, 23.6)", () => {
  for (const v of ["18.20.4", "20.11.1", "v22.6.0", "22.17.1", "23.5.0", "0.12.18", "garbage"]) assert.equal(preflight.nodeOk(v), false, v);
  for (const v of ["22.18.0", "v22.23.1", "23.6.0", "24.0.0", "26.1.0"]) assert.equal(preflight.nodeOk(v), true, v);
  const old = preflight.check({ version: "20.11.1", dependencies: { express: "5.3.0" }, has: () => true });
  assert.deepEqual(old, { problem: "node", version: "20.11.1" });
  const said = preflight.message(old!);
  assert.match(said, /Pako needs Node\.js 22\.18 or newer, and this is Node\.js 20\.11\.1/);
  for (const way of [/https:\/\/nodejs\.org/, /nvm install --lts/, /brew install node/, /npm install && npm start/]) assert.equal(said.match(new RegExp(way, "g"))?.length, 1, `${way}`);
  assert.doesNotMatch(said, /[áéíóúñ¿¡]|necesita/, "English only");
  assert.deepEqual(preflight.check({ version: "v18.0.0", dependencies: { express: "5" }, has: () => false }), { problem: "node", version: "18.0.0" }, "the Node.js first: npm install comes after it");
});

test("preflight: dependencies not installed mean npm install (named when only some are missing); only `dependencies` count, so Render's install starts", () => {
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  const missing = preflight.check({ version: "22.18.0", dependencies: pkg.dependencies, has: (n) => n !== "express" && n !== "zod" });
  assert.deepEqual(missing, { problem: "install", missing: ["express", "zod"], all: false }, "a git pull that brought a new one");
  const said = preflight.message(missing!);
  assert.match(said, /Pako's dependencies are not installed in this folder \(express, zod\): run npm install, then npm start\./);
  assert.match(preflight.message({ problem: "install", missing: ["a", "b", "c", "d", "e"], all: false }), /\(a, b, c, …\)/, "a long list is cut");
  const none = preflight.check({ version: "22.18.0", dependencies: pkg.dependencies, has: () => false });
  assert.equal(none?.problem === "install" && none.all, true);
  assert.match(preflight.message(none!), /^\n {2}Pako's dependencies are not installed in this folder: run npm install/, "the first time: no list of names, only what to do");
  // `npm ci --omit=dev` (render.yaml) installs `dependencies` and nothing else.
  assert.equal(preflight.check({ version: "22.18.0", dependencies: pkg.dependencies, has: (n) => Object.hasOwn(pkg.dependencies, n) }), null);
  assert.ok(Object.keys(pkg.devDependencies).length > 0 && Object.keys(pkg.devDependencies).every((n) => !Object.hasOwn(pkg.dependencies, n)));
});

test("preflight: `npm start` and `npm run dev` run it first; here it passes in silence; in a folder where npm install was not run it stops with code 1", () => {
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts.prestart, "node bin/preflight.cjs");
  assert.equal(pkg.scripts.predev, "node bin/preflight.cjs");
  assert.equal(pkg.scripts.panel, "node bin/panel.cjs");
  assert.match(pkg.scripts.start!, /src\/server\.ts$/);
  const yaml = read("render.yaml");
  assert.match(yaml, /buildCommand: npm ci --omit=dev\n\s+startCommand: npm start\n/, "Render runs the preflight too, with production dependencies only");

  const here = spawnSync(process.execPath, [PREFLIGHT], { encoding: "utf8" });
  assert.equal(here.status, 0, here.stderr);
  assert.equal(`${here.stdout}${here.stderr}`, "", "nothing printed when all is well");

  const bare = tmp();
  mkdirSync(join(bare, "bin"));
  copyFileSync(PREFLIGHT, join(bare, "bin", "preflight.cjs"));
  copyFileSync(file("package.json"), join(bare, "package.json"));
  const fresh = spawnSync(process.execPath, [join(bare, "bin", "preflight.cjs")], { encoding: "utf8" });
  assert.equal(fresh.status, 1);
  assert.match(fresh.stderr, /run npm install, then npm start/);
  assert.doesNotMatch(fresh.stderr, /at .*\.cjs:\d+/, "a sentence, not a stack trace");
});

/** A script's code with its comments, strings and regular expressions taken out: what the syntax check reads. */
function codeOnly(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    const before = out.trimEnd();
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      i = end < 0 ? src.length : end;
    } else if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
      out += " ";
    } else if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i += src[i] === "\\" ? 2 : 1);
      i++;
      out += '""';
    } else if (c === "/" && (before === "" || "(,=:[!&|?{};+-*%<>~^".includes(before.slice(-1)) || /\breturn$/.test(before))) {
      let inClass = false;
      for (i++; i < src.length && (inClass || src[i] !== "/"); i++) {
        if (src[i] === "\\") i++;
        else if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
      }
      for (i++; /[a-z]/i.test(src[i] ?? ""); i++);
      out += "/re/";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

test("preflight and npm run panel run on any Node.js: CommonJS, and no syntax or library call newer than ES2018", () => {
  assert.equal(codeOnly(`a = "x?.y" + /["']?.?/g.test(b) // c ?? d\n/* e?.f */ g`), 'a = "" + /re/.test(b) \n  g', "the check reads code only");
  const newer: [RegExp, string][] = [
    [/\?\./, "optional chaining (ES2020)"],
    [/\?\?/, "?? (ES2020)"],
    [/\bcatch\s*\{/, "catch with no binding (ES2019)"],
    [/\d_\d/, "numeric separators (ES2021)"],
    [/#[A-Za-z_$]/, "private fields (ES2022)"],
    [/\bstatic\s*\{/, "static blocks (ES2022)"],
    [/\bimport\b|\bexport\b/, "ES modules (a .cjs file stays CommonJS)"],
    [/\.(at|flat|flatMap|matchAll|replaceAll|hasOwn|fromEntries|allSettled|any)\(/, "a library call newer than ES2018"],
  ];
  for (const script of ["bin/preflight.cjs", "bin/panel.cjs"]) {
    const code = codeOnly(read(script));
    assert.match(code, /require\(""\)/, `${script} is read as code`);
    for (const [pattern, what] of newer) assert.doesNotMatch(code, pattern, `${script}: ${what}`);
  }
});

// ---------- 2. `npm run panel`: a new link without a restart ----------

test("the link route: only with the bridge token, compared in constant time; the link signs a browser in once; the used one points to npm run panel", async () => {
  const r = await localRig();
  try {
    assert.equal((await r.askLink({})).status, 401, "no token");
    assert.equal((await r.askLink({ authorization: `Bearer ${"f".repeat(48)}` })).status, 401, "a wrong token");
    assert.equal((await r.askLink({ authorization: `Bearer ${r.home.bridgeToken}0` })).status, 401, "a longer one");
    assert.equal((await r.askLink({ authorization: r.home.bridgeToken })).status, 401, "not as a bearer");
    const ok = await r.askLink();
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    const { link } = (await ok.json()) as { link: string };
    assert.match(link, /^http:\/\/127\.0\.0\.1:8787\/panel\/login\/[A-Za-z0-9_-]{32}$/, "the address the browser opens, on the configured port");
    const cookie = await r.signIn(link);
    assert.match(cookie, /^pako_panel_8787=\d+\./);
    assert.equal((await fetch(`${r.base}/panel/api/overview`, { headers: { cookie } })).status, 200, "signed in");
    const again = await fetch(r.here(link), { redirect: "manual" });
    assert.equal(again.status, 401, "once");
    const page = await again.text();
    assert.match(page, /run <code>npm run panel<\/code>: it opens the panel with a fresh link, no restart needed/);
    assert.doesNotMatch(page, /reinicia Pako|Para entrar|WhatsApp/);
  } finally {
    r.close();
  }
});

test("the link route is rate limited on refused tokens only: the app and npm run panel are never shut out; a guesser is, after thirty", async () => {
  const r = await localRig();
  try {
    for (let i = 0; i < 40; i++) assert.equal((await r.askLink()).status, 200, `link ${i}`);
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await r.askLink({ authorization: "Bearer nope" })).status);
    assert.deepEqual([...new Set(codes.slice(0, 30))], [401]);
    assert.equal(codes[30], 429);
  } finally {
    r.close();
  }
});

test("a web page cannot use up the link route: a request a browser marks (Origin, Sec-Fetch-Site) is refused before it is counted", async () => {
  const r = await localRig();
  try {
    for (let i = 0; i < 35; i++) {
      const marked: Record<string, string> = i % 2 ? { origin: "https://evil.example" } : { "sec-fetch-site": "cross-site" };
      assert.equal((await r.askLink({ authorization: "Bearer nope", ...marked })).status, 403);
    }
    assert.equal((await r.askLink()).status, 200, "the token's owner still gets a link");
  } finally {
    r.close();
  }
});

test("notices for the Mac app: only what Pako wrote by itself, after a time, with the bridge token; a secret is not quoted", async () => {
  const r = await localRig();
  try {
    await r.channel.push("you", "remind me in 2 minutes");
    await r.channel.deliver({ type: "text", text: { body: "Sure, at 10:02." } });
    await r.channel.deliver({ type: "text", text: { body: "Reminder: call mum" } }, { started: true });
    await r.channel.deliver({ type: "text", text: { body: "Your code is 482910" } }, { started: true, secret: true });
    await r.channel.deliver({ type: "interactive", interactive: { body: { text: "Confirm the call?" }, action: { buttons: [] } } }, { started: true });
    assert.equal((await r.notices(0, {})).status, 401, "no token");
    assert.equal((await r.notices(0, { authorization: "Bearer nope" })).status, 401);
    assert.equal((await r.notices(0, { authorization: `Bearer ${r.home.bridgeToken}`, origin: "https://evil.example" })).status, 403);
    const res = await r.notices(0);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = (await res.json()) as { now: number; notices: { n: number; at: number; text: string; secret?: boolean }[] };
    assert.ok(Math.abs(body.now - Date.now()) < 5000);
    assert.deepEqual(body.notices.map((n) => [n.text, n.secret ?? false]),
      [["Reminder: call mum", false], ["", true], ["Confirm the call?", false]], "not the owner's words, not an answer to them");
    const later = (await (await r.notices(body.notices[1]!.at)).json()) as { notices: unknown[] };
    assert.ok(later.notices.length <= 2, "only after the time asked");
    assert.equal(((await (await r.notices(Date.now() + 60_000)).json()) as { notices: unknown[] }).notices.length, 0);
  } finally {
    r.close();
  }
});

test("the bridge's report is rate limited on refused tokens only: a bridge that reports often is never shut out", async () => {
  const r = await localRig();
  try {
    for (let i = 0; i < 40; i++) assert.equal((await r.health(i % 2 ? "ok" : "login")).status, 200, `report ${i}`);
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await r.health("ok", "w".repeat(48))).status);
    assert.deepEqual([...new Set(codes.slice(0, 30))], [401]);
    assert.equal(codes[30], 429);
  } finally {
    r.close();
  }
});

test("the terminal's and the bridge's routes answer this computer only, whatever address the server listens on", async () => {
  for (const a of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1", "::FFFF:127.0.0.1"]) assert.equal(isLoopback(a), true, a);
  for (const a of ["10.0.0.2", "192.168.1.127", "::ffff:192.168.1.20", "fe80::1", "0.0.0.0", "", undefined, "127.0.0.1.example", "::ffff:127.0.0.1x"]) {
    assert.equal(isLoopback(a), false, String(a));
  }
  const r = await localRig();
  try {
    // The Host a program on this computer sends: any other name is refused before these routes (test/hardening.test.ts).
    const host = `127.0.0.1:${r.port}`;
    const link = `POST /panel/api/link HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer ${r.home.bridgeToken}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`;
    assert.match(await requestFrom(r.server, "192.168.1.20", link), /^HTTP\/1\.1 403 /, "the right token from another machine");
    assert.match(await requestFrom(r.server, "::ffff:10.0.0.7", link), /^HTTP\/1\.1 403 /);
    assert.match(await requestFrom(r.server, "127.0.0.1", link), /^HTTP\/1\.1 200 [\s\S]*\/panel\/login\//, "the same request from here");
    const body = '{"claude":"login"}';
    const health = `POST /assistant/health HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer ${r.home.bridgeToken}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`;
    assert.match(await requestFrom(r.server, "10.0.0.2", health), /^HTTP\/1\.1 403 /);
    assert.match(await requestFrom(r.server, "::1", health), /^HTTP\/1\.1 200 /);
  } finally {
    r.close();
  }
});

test("a hosted server has no link route (the link comes by WhatsApp: PANEL), and takes the bridge's report with its token only (the watchdog)", async () => {
  const env: Record<string, string | undefined> = {
    PERSONAL_CALLER_TOKEN: "p".repeat(32), PERSONAL_OWNER_NAME: "Ana", PERSONAL_OWNER_NUMBER: "+34600111222", WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
    WHATSAPP_PHONE_NUMBER_ID: "109876543210", WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef", WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789", ASSISTANT_BRIDGE_TOKEN: TOKEN,
  };
  const server = createServer(createApp(loadAppConfig(env), env));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    assert.equal((await fetch(`${base}/panel/api/link`, { method: "POST", headers })).status, 404);
    assert.equal((await fetch(`${base}/assistant/health`, { method: "POST", headers, body: '{"claude":"login"}' })).status, 200);
    const wrong = { ...headers, authorization: `Bearer ${"w".repeat(48)}` };
    assert.equal((await fetch(`${base}/assistant/health`, { method: "POST", headers: wrong, body: '{"claude":"login"}' })).status, 401);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

/**
 * Runs `npm run panel`'s script as a person would, from a folder of its own (so no .env of this repository is read). Not spawnSync: the server it
 * asks may be in this very process, and must be free to answer.
 */
function runPanel(env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const cwd = tmp();
  const child = spawn(process.execPath, [PANEL], { cwd, env: { PATH: process.env.PATH ?? "", HOME: cwd, PAKO_NO_OPEN: "1", ...env } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  return new Promise((resolve) => child.on("close", (status) => resolve({ status, stdout, stderr })));
}

test("npm run panel: finds the running Pako by its lock (whatever this terminal's PORT says), prints a link that signs in, and opens nothing when told", async () => {
  const r = await localRig();
  const release = lockHome(r.home.dir, r.port);
  try {
    const out = await runPanel({ PAKO_HOME: r.home.dir, PORT: "1" });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /Your Pako panel:\n\n {4}http:\/\/127\.0\.0\.1:8787\/panel\/login\/\S+\n\n {2}\(the link works once, for 10 minutes\)/);
    assert.doesNotMatch(out.stdout, /abriendo/, "PAKO_NO_OPEN=1: no browser");
    const link = /http:\/\/127\.0\.0\.1:\d+\/panel\/login\/\S+/.exec(out.stdout)![0];
    const cookie = await r.signIn(link);
    assert.equal((await fetch(`${r.base}/panel/api/overview`, { headers: { cookie } })).status, 200);
  } finally {
    release();
    r.close();
  }
});

// The bridge token goes to 127.0.0.1 only (security review F3): something on the IPv6 loopback, even a Pako told to listen there, is not asked
// (another account on this computer can listen on [::1] at the same port). Such a Pako's own start opens the panel by itself.
test("npm run panel never sends the token to the IPv6 loopback, even to a Pako that listens there only: it says Pako is starting", async (t) => {
  let r: Awaited<ReturnType<typeof localRig>>;
  try {
    r = await localRig(undefined, "::1");
  } catch {
    return t.skip("this computer has no IPv6 loopback");
  }
  const release = lockHome(r.home.dir, r.port);
  try {
    const out = await runPanel({ PAKO_HOME: r.home.dir });
    assert.equal(out.status, 1, out.stdout);
    assert.match(out.stderr, /Pako is starting/);
    assert.doesNotMatch(out.stdout, /\/panel\/login\//, "no link: the token was never sent");
  } finally {
    release();
    r.close();
  }
});

/** A process that has ended: its number is free (a lock with it is one a killed Pako left behind). */
async function deadPid(): Promise<number> {
  const gone = spawn(process.execPath, ["-e", ""]);
  await new Promise((r) => gone.once("exit", r));
  return gone.pid!;
}

test("npm run panel: never started, stopped, starting, an older Pako, another folder's: each says what to do, in English, with code 1", async () => {
  const never = await runPanel({ PAKO_HOME: join(tmp(), "nothing-here") });
  assert.equal(never.status, 1);
  assert.match(never.stderr, /Pako has not started with the folder .*nothing-here yet\. Start it with npm start/);

  // Something else listens where Pako was: with no live lock it is never asked, so the bridge token never reaches it.
  const heard: string[] = [];
  const decoy = createServer((req, res) => {
    heard.push(String(req.headers.authorization));
    res.writeHead(404).end("no");
  });
  await new Promise<void>((r) => decoy.listen(0, "127.0.0.1", () => r()));
  const decoyPort = (decoy.address() as AddressInfo).port;
  const up = Math.floor(uptime());
  const stopped = loadHome({ PAKO_HOME: join(tmp(), "home") });
  try {
    for (const lock of [null, `${await deadPid()}\n${decoyPort}\n${up}\n`, `${process.pid}\n${decoyPort}\n${up + 100_000}\n`]) {
      if (lock) writeFileSync(join(stopped.dir, ".lock"), lock);
      const down = await runPanel({ PAKO_HOME: stopped.dir, PORT: String(decoyPort) });
      assert.equal(down.status, 1);
      assert.match(down.stderr, /Pako is not running\. Start it with npm start in the Pako folder: it opens the panel by itself\./, String(lock));
      assert.doesNotMatch(down.stderr, /[áéíóúñ¿¡]|Arráncalo/, "English only");
    }
    assert.deepEqual(heard, [], "no lock, a killed Pako's, or one from before the computer restarted: nothing asked");

    // The lock of a live Pako on a port where something else answers: no link from it.
    writeFileSync(join(stopped.dir, ".lock"), `${process.pid}\n${decoyPort}\n${up}\n`);
    const elsewhere = await runPanel({ PAKO_HOME: stopped.dir });
    assert.match(elsewhere.stderr, new RegExp(`Whatever answers on port ${decoyPort} gives no links: it is not a Pako of this folder\\.`));
    assert.equal(heard.length, 1);
  } finally {
    decoy.close();
  }

  // A live Pako holds the lock but listens nowhere yet: it is starting, or waiting for the name in its terminal.
  const free = await new Promise<number>((resolve) => {
    const s = createNetServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
  writeFileSync(join(stopped.dir, ".lock"), `${process.pid}\n${free}\n${up}\n`);
  const starting = await runPanel({ PAKO_HOME: stopped.dir });
  assert.equal(starting.status, 1);
  assert.match(starting.stderr, new RegExp(`Pako is starting \\(process ${process.pid}\\) but does not answer on port ${free} yet\\.`));
  assert.match(starting.stderr, /Look at its terminal: if it asks what to call you, answer\. Then run npm run panel again\./);
  // A Pako from before this command wrote its process number only.
  writeFileSync(join(stopped.dir, ".lock"), String(process.pid));
  const older = await runPanel({ PAKO_HOME: stopped.dir });
  assert.match(older.stderr, /is from before npm run panel: restart it once/);

  const r = await localRig();
  try {
    const other = loadHome({ PAKO_HOME: join(tmp(), "other") });
    writeFileSync(join(other.dir, ".lock"), `${process.pid}\n${r.port}\n${up}\n`);
    const wrong = await runPanel({ PAKO_HOME: other.dir });
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /does not use the folder .*other: it was started with another one \(PAKO_HOME\)/);
  } finally {
    r.close();
  }
});

test("npm run panel finds the folder as npm start does (this terminal, then the home's .env, then the Pako folder's), and the running Pako by its lock", async () => {
  const user = tmp();
  const repo = tmp();
  const custom = join(user, "elsewhere");
  mkdirSync(join(user, ".pako"));
  writeFileSync(join(user, ".pako", ".env"), `# mine\nexport PAKO_HOME="${custom}" # a comment\nPORT=8790\n`);
  writeFileSync(join(repo, ".env"), "PAKO_HOME=/not/this\n");
  assert.equal(panel.pakoHome({}, repo, user), custom, "the home's .env first");
  assert.equal(panel.pakoHome({ PAKO_HOME: join(user, "x") }, repo, user), join(user, "x"), "this terminal wins");
  assert.equal(panel.pakoHome({}, repo, tmp()), "/not/this", "then the Pako folder's .env");
  const bare = tmp();
  assert.equal(panel.pakoHome({}, tmp(), bare), join(bare, ".pako"), "~/.pako when nothing says");
  assert.deepEqual(panel.readEnvFile(join(user, "missing.env"), ["PAKO_HOME"]), {});
  // Read as Node reads it for npm start (process.loadEnvFile): a quoted value is what is between the quotes, and an unquoted # starts a comment.
  const env = join(tmp(), ".env");
  writeFileSync(env, "A=/tmp/a#b\nB='/tmp/q' # c\nC=`x y`\nD=first\nD=not\n");
  assert.deepEqual(panel.readEnvFile(env, ["A", "B", "C", "D"]), { A: "/tmp/a", B: "/tmp/q", C: "x y", D: "not" }, "a name given twice: the last");

  assert.equal(panel.readLock(join(user, "nowhere"), 5000), null, "no lock");
  writeFileSync(join(user, ".lock"), `${await deadPid()}\n8790\n100\n`);
  assert.equal(panel.readLock(user, 5000)?.alive, false, "a lock left by a Pako that was killed");
  writeFileSync(join(user, ".lock"), `${process.pid}\n8790\n100\n`);
  assert.deepEqual(panel.readLock(user, 5000), { pid: process.pid, port: 8790, alive: true }, "a live one: its port is the one");
  assert.equal(panel.readLock(user, 99)?.alive, false, "written before the computer last restarted: that number is any program's now");
  writeFileSync(join(user, ".lock"), String(process.pid));
  assert.deepEqual(panel.readLock(user, 5000), { pid: process.pid, port: 0, alive: true }, "a lock from before npm run panel has no port");
  // The lock src/local.ts writes is the one this reads.
  const dir = tmp();
  const release = lockHome(dir, 8795);
  assert.deepEqual(panel.readLock(dir, uptime()), { pid: process.pid, port: 8795, alive: true });
  release();
});

// ---------- 3. how Claude is doing: the bridge says it, the chat shows it ----------

/** A stand-in for the bridge process: it runs until it is stopped or made to exit; `kills` counts the signals it was sent. */
function fakeChild(): ChildProcess & { kills: number } {
  const child = Object.assign(new EventEmitter(), { kills: 0 }) as unknown as ChildProcess & { kills: number };
  Object.assign(child, {
    kill: () => {
      child.kills++;
      setImmediate(() => child.emit("exit", null));
      return true;
    },
  });
  return child;
}

/** The supervisor with a stand-in bridge; `installed` says which commands answer `--version` (all, by default). A home folder of its own. */
function supervised(o: {
  installed?: boolean | ((bin: string) => boolean);
  clock?: { t: number };
  env?: Record<string, string>;
  home?: string;
  auth?: (bin: string) => Promise<ClaudeAuth | null>;
  fromPanel?: (k: string) => boolean;
} = {}) {
  const spawned: (ChildProcess & { kills: number })[] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const logs: string[] = [];
  const bridge = superviseBridge({
    env: o.env ?? {},
    log: (s) => logs.push(s),
    installed: async (bin) => (typeof o.installed === "function" ? o.installed(bin) : (o.installed ?? true)),
    spawn: ((_cmd: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      const c = fakeChild();
      spawned.push(c);
      envs.push(options.env);
      return c;
    }) as unknown as typeof spawn,
    home: o.home ?? tmp(),
    ...(o.clock ? { now: () => o.clock!.t } : {}),
    ...(o.auth ? { auth: o.auth } : {}),
    ...(o.fromPanel ? { fromPanel: o.fromPanel } : {}),
  });
  return { bridge, spawned, envs, logs };
}

test("the claude command found where Claude Code's own installers put it, when the PATH has none: the bridge is started with that one", async () => {
  // The older local install (~/.claude/local, reached through a shell alias that no program sees): `claude` works in the person's terminal.
  const home = tmp();
  const aliased = join(home, ".claude", "local", "claude");
  mkdirSync(join(home, ".claude", "local"), { recursive: true });
  writeFileSync(aliased, "#!/bin/sh\n", { mode: 0o755 });
  const s = supervised({ home, installed: (bin) => bin === aliased });
  try {
    assert.ok(await until(() => s.spawned.length === 1));
    assert.equal(s.envs[0]!.CLAUDE_BIN, aliased);
    assert.ok(s.logs.includes(`using ${aliased} (the PATH has no claude command)`), s.logs.join("\n"));
    assert.deepEqual(s.bridge.status(), { claude: "ok", running: true });
  } finally {
    s.bridge.stop();
  }
  // On the PATH it is used as it is; a CLAUDE_BIN that was set is the one, even if it does not answer (the banner then says it is missing).
  const onPath = supervised({ home, installed: () => true });
  const given = supervised({ home, env: { CLAUDE_BIN: " /opt/mine/claude " }, installed: (bin) => bin === aliased });
  try {
    assert.ok(await until(() => onPath.spawned.length === 1 && given.bridge.status().claude === "missing"));
    assert.equal(onPath.envs[0]!.CLAUDE_BIN, "claude");
    assert.equal(given.spawned.length, 0);
    assert.match(given.logs.join("\n"), /CLAUDE_BIN=\/opt\/mine\/claude does not answer `--version`: fix that path where it is set/);
  } finally {
    onPath.bridge.stop();
    given.bridge.stop();
  }
  const none = supervised({ installed: false });
  try {
    assert.ok(await until(() => none.bridge.status().claude === "missing"));
    assert.match(none.logs.join("\n"), /claude command was not found: install Claude Code .* If it is installed somewhere else, put its path in ~\/\.pako\/\.env as CLAUDE_BIN=/);
  } finally {
    none.bridge.stop();
  }
  const app = read("src/panel/app.js");
  // The chat's banner never sends the person to a terminal: one line and the connections page's one button (src/claude-connect.ts).
  assert.match(app, /missing: \(\) => \[\s*h\("b", \{\}, "Pako needs Claude to think\. "\),\s*claudeLink\("Connect your Claude account"\),/, "the chat's banner");
});

test("health: what the running bridge reports (not signed in, out of its limit, fine again) reaches the chat's status; only with its token", async () => {
  const s = supervised();
  assert.ok(await until(() => s.spawned.length === 1));
  const r = await localRig(s.bridge);
  try {
    const cookie = await r.signIn((await (await r.askLink()).json() as { link: string }).link);
    const status = async () => ((await (await fetch(`${r.base}/panel/api/chat?since=0`, { headers: { cookie } })).json()) as { status: Record<string, unknown> }).status;
    assert.deepEqual(await status(), { claude: "ok", running: true });
    assert.equal((await r.health("login")).status, 200);
    assert.deepEqual(await status(), { claude: "login", running: true });
    assert.equal((await r.health("limit")).status, 200);
    assert.equal((await status()).claude, "limit");
    assert.equal((await r.health("ok")).status, 200);
    assert.equal((await status()).claude, "ok");
    assert.equal((await r.health("login", "x".repeat(48))).status, 401, "a wrong token");
    assert.equal((await fetch(`${r.base}/assistant/health`, { method: "POST", body: '{"claude":"login"}', headers: { "content-type": "application/json" } })).status, 401);
    assert.equal((await r.health("asleep")).status, 400);
    assert.equal((await r.health(null)).status, 400);
    assert.equal((await status()).claude, "ok", "none of those changed it");
    // A report from a bridge that is gone means nothing: a new one says again.
    await r.health("login");
    s.spawned[0]!.emit("exit", 1);
    assert.deepEqual(await status(), { claude: "ok", running: false, failing: true });
    await r.health("limit");
    assert.equal((await status()).claude, "ok", "nothing runs to have said it");
  } finally {
    s.bridge.stop();
    r.close();
  }
});

test("health: a missing claude command is said before anything a bridge reported; the bridge failing to start is said until one stays up", async () => {
  const missing = supervised({ installed: false });
  assert.ok(await until(() => missing.bridge.status().claude === "missing"));
  missing.bridge.report("login");
  assert.deepEqual(missing.bridge.status(), { claude: "missing", running: false });
  assert.equal(missing.spawned.length, 0);
  missing.bridge.stop();

  const clock = { t: 1_000_000 };
  const s = supervised({ clock });
  assert.ok(await until(() => s.spawned.length === 1));
  clock.t += 2_000;
  s.spawned[0]!.emit("exit", 1); // a bad setting: it stops at once
  assert.deepEqual(s.bridge.status(), { claude: "ok", running: false, failing: true });
  assert.match(s.logs.at(-1)!, /stopped \(code 1\); starting again in 4 s/);
  s.bridge.stop();

  const lived = supervised({ clock });
  assert.ok(await until(() => lived.spawned.length === 1));
  clock.t += 3_600_000;
  lived.spawned[0]!.emit("exit", 0); // ran for an hour, then stopped: started again, not failing
  assert.deepEqual(lived.bridge.status(), { claude: "ok", running: false });
  lived.spawned[0]!.emit("error", new Error("again")); // a process says it twice: counted once
  assert.equal(lived.logs.filter((l) => /^stopped/.test(l)).length, 1);
  lived.bridge.stop();

  // Ctrl+C stops the bridge, and so does the exit right after: it is told once.
  const once = supervised();
  assert.ok(await until(() => once.spawned.length === 1));
  once.bridge.stop();
  once.bridge.stop();
  assert.equal(once.spawned[0]!.kills, 1);
});

test("the bridge with a wrong setting says which, in a sentence (no stack trace), and where to fix it; the chat's banner points to that terminal", async () => {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", file("assistant/run.ts")], {
    env: { PATH: process.env.PATH ?? "", ASSISTANT_SERVER_URL: "http://127.0.0.1:1", ASSISTANT_BRIDGE_TOKEN: TOKEN, ASSISTANT_TOOLS: "Bash" },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const code = await new Promise((r) => child.on("close", r));
  assert.equal(code, 1);
  assert.match(out, /ASSISTANT_TOOLS may only name WebSearch and WebFetch/);
  assert.match(out, /Fix that setting where it is set \(on a computer, ~\/\.pako\/\.env or \.\/\.env; on a server's brain, assistant\/\.env\) and start again\./);
  assert.doesNotMatch(out, /at loadBridgeConfig|bridge\.ts:\d+/);
  const app = read("src/panel/app.js");
  assert.match(app, /"The terminal where you typed ",\s*h\("code", \{\}, "npm start"\),\s*" says why/, "the failing banner sends the person there");
});

test("the chat's banner: each state the server gives has its own words, saying what to do; a missing command first; Pako itself gone is said too", () => {
  const app = read("src/panel/app.js");
  // The page's own function, as the browser runs it.
  const source = /function chatTrouble\(status\) \{[\s\S]*?\n\}/.exec(app)![0];
  const chatTrouble = new Function(`${source}\nreturn chatTrouble;`)() as (status: unknown) => string;
  assert.equal(chatTrouble({ claude: "ok", running: true }), "");
  assert.equal(chatTrouble({ claude: "starting", running: false }), "");
  assert.equal(chatTrouble(undefined), "", "an answer without a status");
  assert.equal(chatTrouble({ claude: "login", running: true }), "login");
  assert.equal(chatTrouble({ claude: "limit", running: true }), "limit");
  assert.equal(chatTrouble({ claude: "ok", running: false, failing: true }), "failing");
  assert.equal(chatTrouble({ claude: "missing", running: false, failing: true }), "missing", "nothing runs without the command");
  // What each banner says, with its tags taken out: the text the person reads.
  const words = (name: string): string => {
    const block = new RegExp(`\\n  ${name}: \\(\\) => \\[([\\s\\S]*?)\\n  \\],`).exec(app)?.[1] ?? "";
    const strings = [...block.replace(/\{[^}]*\}/g, "").matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);
    return strings.filter((s) => !/^(b|code|a)$/.test(s)).join(""); // the element names go, their attributes went with the braces
  };
  assert.equal(words("login"), "Claude needs you to sign in again. Connect your Claude account");
  assert.match(app, /const claudeLink = \(label\) => h\("a", \{ class: "banner-action", href: "\/panel\/settings#claude" \}, label\);/);
  assert.match(words("limit"), /^Claude has reached its usage limit for now: your message waits and will be answered by itself/);
  assert.equal(words("missing"), "Pako needs Claude to think. Connect your Claude account");
  assert.doesNotMatch(app.slice(app.indexOf("const BANNERS"), app.indexOf("limit: () =>")), /terminal|npm|CLAUDE_BIN/i, "Claude's banners never send the person to a terminal");
  assert.match(words("offline"), /^Pako isn't answering\. Did the terminal where you typed npm start close\? Start it again in the Pako folder/);
  for (const name of ["missing", "login", "limit", "failing", "offline"]) assert.match(app, new RegExp(`\\b${name}: "[^"]+"`), `${name} has a status line`);
  assert.match(app, /if \(!reached && \+\+chat\.misses >= 2\) renderChat\(showTrouble\("offline"\)\)/, "two polls with no answer at all");
});

/** A stand-in for the server's bridge routes, counting what the bridge sends. */
async function fakeServer() {
  const s = {
    inbox: [] as { id: string; at: number; text: string }[],
    acked: [] as string[],
    replies: [] as Record<string, unknown>[],
    health: [] as unknown[],
    healthStatus: 200,
    url: "",
    close: () => undefined as void,
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => (req.get("authorization") === `Bearer ${TOKEN}` ? next() : void res.status(401).send("no")));
  app.get("/assistant/inbox", (_req, res) => void res.json({ messages: s.inbox }));
  app.post("/assistant/ack", (req, res) => {
    for (const id of req.body.ids as string[]) {
      s.acked.push(id);
      s.inbox = s.inbox.filter((m) => m.id !== id);
    }
    res.json({ ok: true });
  });
  app.get("/assistant/context", (_req, res) => void res.json({ now: "domingo, 15 de noviembre de 2026, 13:00", ownerName: "Ana", contacts: [], memory: "" }));
  app.post("/assistant/reply", (req, res) => {
    const { key: _key, ...body } = req.body as Record<string, unknown>;
    s.replies.push(body);
    res.json({ ok: true });
  });
  app.post("/assistant/health", (req, res) => {
    // Only the reports about Claude (the day's numbers of a newer bridge, alone in their body, are another report).
    if (req.body?.claude !== undefined) s.health.push(req.body.claude);
    res.status(s.healthStatus).json({ ok: s.healthStatus === 200 });
  });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  s.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  s.close = () => {
    server.close();
    server.closeAllConnections();
  };
  return s;
}

function bridgeConfig(server: string, over: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    ...loadBridgeConfig({ ASSISTANT_SERVER_URL: server, ASSISTANT_BRIDGE_TOKEN: TOKEN, ASSISTANT_STATE_DIR: tmp() }),
    ...over,
  };
}

/** Claude as the tests want it: signed in, not signed in, or out of its limit, switched between rounds. */
function fakeClaude() {
  const c = { mode: "login" as "ok" | "login" | "limit" | "other", runs: 0 };
  const run = async (): Promise<ClaudeResult> => {
    c.runs++;
    if (c.mode === "login") throw new ClaudeError("Not logged in · Please run /login", "login");
    if (c.mode === "limit") throw new ClaudeError("Claude usage limit reached", "limit");
    if (c.mode === "other") throw new ClaudeError("Claude took longer than 180 s", "other");
    return { text: "Hola, Ana.", sessionId: "s1", costUsd: 0 };
  };
  return { c, run };
}

test("bridge: a lost login is reported once and said once (this computer, not 'the Mac'); after signing in the waiting message is answered and 'ok' is reported", async () => {
  const s = await fakeServer();
  const { c, run } = fakeClaude();
  try {
    const bridge = createBridge({ config: bridgeConfig(s.url, { loginRetryMs: 0 }), log: () => undefined, run });
    c.mode = "other"; // a timeout says nothing about the login or the limit
    s.inbox.push({ id: "local-0", at: 0, text: "primero" });
    assert.deepEqual(await bridge.tick(0), { seen: 1, done: 1 }, "told and let go, as before");
    assert.deepEqual(s.health, [], "and nothing reported");
    c.mode = "login";
    s.inbox.push({ id: "local-1", at: 1, text: "hola" });
    assert.deepEqual(await bridge.tick(0), { seen: 1, done: 0 }, "it waits");
    assert.deepEqual(s.health, ["login"]);
    assert.equal(s.replies.length, 2);
    const said = String(s.replies.at(-1)!.text);
    assert.match(said, /Claude needs you to sign in again\. In Pako's settings, press “Connect your Claude account”; your message will be answered then\./);
    assert.doesNotMatch(said, /Mac/);
    assert.deepEqual(await bridge.tick(0), { seen: 1, done: 0 }, "with no wait, tried again on the next round");
    assert.equal(c.runs, 3);
    assert.deepEqual(s.health, ["login"], "the same news is not sent again");
    assert.equal(s.replies.length, 2, "nor said again");
    c.mode = "ok"; // the person signs in
    assert.deepEqual(await bridge.tick(0), { seen: 1, done: 1 });
    assert.deepEqual(s.health, ["login", "ok"]);
    assert.deepEqual(s.replies.at(-1), { text: "Hola, Ana." });
    assert.deepEqual(s.acked, ["local-0", "local-1"]);
    c.mode = "limit";
    s.inbox.push({ id: "local-2", at: 2, text: "¿y ahora?" });
    await bridge.tick(0);
    assert.deepEqual(s.health, ["login", "ok", "limit"]);
    assert.match(String(s.replies.at(-1)!.text), /Claude's usage limit/);
  } finally {
    s.close();
  }
});

test("bridge: with the server on this computer a lost login is tried again after 20 s, elsewhere after 2 min (the clock moved by hand)", async (t) => {
  const at = (url: string) => loadBridgeConfig({ ASSISTANT_SERVER_URL: url, ASSISTANT_BRIDGE_TOKEN: TOKEN }).loginRetryMs;
  assert.equal(at("http://127.0.0.1:8787"), 20_000, "local mode (src/local.ts gives the bridge this address)");
  assert.equal(at("http://localhost:3000"), 20_000);
  assert.equal(at("https://pako.example.com"), 120_000, "a server elsewhere: the owner is away from this computer");
  const s = await fakeServer();
  const { c, run } = fakeClaude();
  // Only the clock the bridge reads is moved; the requests' own timers stay real.
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    // A config made before the setting existed (no loginRetryMs) waits two minutes, as before.
    for (const [wait, expected] of [[20_000, 20_000], [120_000, 120_000], [undefined, 120_000]] as const) {
      const bridge = createBridge({ config: { ...bridgeConfig(s.url), loginRetryMs: wait }, log: () => undefined, run });
      c.mode = "login";
      c.runs = 0;
      s.inbox = [{ id: `local-${expected}-${wait}`, at: 1, text: "hola" }];
      assert.deepEqual(await bridge.tick(0), { seen: 1, done: 0 });
      c.mode = "ok"; // the person signs in a moment later
      t.mock.timers.tick(expected - 1000);
      assert.deepEqual(await bridge.tick(0), { seen: 1, done: 0 }, `${(expected - 1000) / 1000} s later the message still waits`);
      assert.equal(c.runs, 1, "and Claude was not started again");
      t.mock.timers.tick(1000);
      assert.deepEqual(await bridge.tick(0), { seen: 1, done: 1 }, `${expected / 1000} s later: tried again, and answered`);
      assert.equal(c.runs, 2);
    }

    // Thirty quick tries (about ten minutes at 20 s): then no more often than every two minutes, since each try starts the claude program.
    const quick = createBridge({ config: bridgeConfig(s.url, { loginRetryMs: 0 }), log: () => undefined, run });
    c.mode = "login";
    c.runs = 0;
    s.inbox = [{ id: "local-9", at: 9, text: "hola" }];
    for (let i = 0; i < 31; i++) await quick.tick(0);
    assert.equal(c.runs, 31, "thirty-one tries in a row, with no wait between them");
    await quick.tick(0);
    assert.equal(c.runs, 31, "then it waits");
    const again = createBridge({ config: bridgeConfig(s.url, { loginRetryMs: 0 }), log: () => undefined, run });
    s.inbox = [{ id: "local-10", at: 10, text: "hola" }];
    for (let i = 0; i < 5; i++) await again.tick(0);
    c.mode = "ok";
    await again.tick(0);
    assert.deepEqual(s.acked.slice(-1), ["local-10"]);
    c.mode = "login";
    c.runs = 0;
    s.inbox = [{ id: "local-11", at: 11, text: "¿y ahora?" }];
    for (let i = 0; i < 30; i++) await again.tick(0);
    assert.equal(c.runs, 30, "a success starts the count again: thirty more quick tries");
  } finally {
    s.close();
  }
});

test("bridge: a server that does not take the report (an older one: 404) is not asked again until the state changes; one that refused it is asked on the next round", async () => {
  const s = await fakeServer();
  const { c, run } = fakeClaude();
  const logs: string[] = [];
  try {
    s.healthStatus = 404;
    const bridge = createBridge({ config: bridgeConfig(s.url, { loginRetryMs: 0 }), log: (l) => logs.push(l), run });
    s.inbox.push({ id: "local-1", at: 1, text: "hola" });
    await bridge.tick(0);
    await bridge.tick(0);
    await bridge.tick(0);
    assert.deepEqual(s.health, ["login"], "asked once");
    assert.equal(logs.filter((l) => /takes no health reports/.test(l)).length, 1, "and said once in the log");
    c.mode = "ok";
    await bridge.tick(0);
    assert.deepEqual(s.health, ["login", "ok"], "a change is offered again");
    assert.deepEqual(s.acked, ["local-1"], "the message itself was never held up by it");

    // A server that takes the report from its own computer only (403: this bridge runs on another one) is treated the same way.
    s.healthStatus = 403;
    const away = createBridge({ config: bridgeConfig(s.url, { loginRetryMs: 0 }), log: (l) => logs.push(l), run });
    c.mode = "login";
    s.inbox = [{ id: "local-3", at: 3, text: "hola" }];
    for (let i = 0; i < 3; i++) await away.tick(0);
    assert.deepEqual(s.health, ["login", "ok", "login"], "asked once more, by the new bridge, and then left alone");
    s.inbox = [];

    s.healthStatus = 503;
    c.mode = "limit";
    s.inbox.push({ id: "local-2", at: 2, text: "¿sigues?" });
    await bridge.tick(0);
    const refused = s.health.length;
    assert.equal(s.health.at(-1), "limit");
    s.healthStatus = 200;
    s.inbox = [];
    await bridge.tick(0);
    assert.equal(s.health.length, refused + 1, "asked again on the next round, and taken");
    await bridge.tick(0);
    assert.equal(s.health.length, refused + 1, "then left alone");
  } finally {
    s.close();
  }
});

// ---------- 4. the rest of a first start ----------

test("the lock: it holds the port for npm run panel; a live Pako's message says how to open its panel; a lock from before the computer started is taken over", async () => {
  const dir = tmp();
  const path = join(dir, ".lock");
  const release = lockHome(dir, 8790, 5000.7);
  const started = processStart(process.pid);
  assert.ok(started && Math.abs(started - (Date.now() / 1000 - process.uptime())) < 3, "this process's start, as the system keeps it");
  assert.equal(readFileSync(path, "utf8"), `${process.pid}\n8790\n5000\n\n${started}\n`,
    "the process, its port, how long the computer had been up, no service mark, and when the process started");
  assert.deepEqual(panel.readLock(dir, 5001), { pid: process.pid, port: 8790, alive: true });
  release();
  assert.equal(existsSync(path), false, "given back when Pako stops");
  const sleeper = spawn("sleep", ["30"]);
  try {
    // A live process holds it: from earlier in this same run of the computer (up 5000 s then, 6000 s now).
    writeFileSync(path, `${sleeper.pid}\n8787\n5000\n`);
    assert.throws(
      () => lockHome(dir, 8787, 6000),
      (e: Error) => /^Pako is already running for this folder \(process \d+\)\. Open its panel with: npm run panel\./.test(e.message) && e.message.includes(`delete ${path}`),
    );
    assert.throws(() => lockHome(dir, 8787, 5000), /already running/, "the same second is the same run");
    writeFileSync(path, String(sleeper.pid));
    assert.throws(() => lockHome(dir, 8787, 1), /already running/, "a lock from before this version, with no uptime: the process decides");
    // The same lock, but the computer has been up for less time than it had when the lock was written: it restarted since, and that number now
    // belongs to some other program.
    writeFileSync(path, `${sleeper.pid}\n8787\n5000\n`);
    const taken = lockHome(dir, 8787, 120);
    assert.equal(readFileSync(path, "utf8"), `${process.pid}\n8787\n120\n\n${started}\n`);
    taken();
    // A live process with the lock's number, but not the one that wrote it (it started at another time: the number came round again after
    // a crash): taken over, nobody is asked to delete a file. The same number started when the lock says: still held.
    const real = processStart(sleeper.pid!)!;
    writeFileSync(path, `${sleeper.pid}\n8787\n5000\n\n${real - 3600}\n`);
    assert.equal(lockHolder(dir, 6000), null, "a reused process number holds nothing");
    lockHome(dir, 8787, 6000)();
    writeFileSync(path, `${sleeper.pid}\n8787\n5000\n\n${real}\n`);
    assert.equal(lockHolder(dir, 6000)?.pid, sleeper.pid);
    assert.throws(() => lockHome(dir, 8787, 6000), /already running/);
  } finally {
    sleeper.kill();
  }
});

/** The real entry point started as a person starts it, with a `claude` that is installed but not signed in. */
function startPako(env: Record<string, string>) {
  const dir = tmp();
  const claude = join(dir, "claude");
  writeFileSync(claude, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.0.0 (Claude Code)"; exit 0; fi\ncat >/dev/null\necho "Not logged in · Please run /login" >&2\nexit 1\n', { mode: 0o755 });
  const home = join(dir, "home");
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY], {
    cwd: dir,
    // LC_ALL: a Spanish computer. Pako's own texts are English all the same (src/i18n.ts), and these tests read them.
    env: { PATH: process.env.PATH ?? "", HOME: dir, PAKO_HOME: home, PAKO_NAME: "Ana", PAKO_NO_OPEN: "1", CLAUDE_BIN: claude, LC_ALL: "es_ES.UTF-8", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return {
    dir,
    home,
    exited,
    out: () => out,
    shows: (re: RegExp) => until(() => re.test(out)),
    stop: async () => {
      child.kill("SIGINT");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000).unref())]);
      child.kill("SIGKILL");
      // Its bridge shares these pipes and takes a few seconds more to go: the test is not held for it.
      child.stdout!.destroy();
      child.stderr!.destroy();
    },
  };
}

test("first start, end to end: npm run panel signs a browser in; a claude that is not signed in shows in the chat; the clash messages point to npm run panel", async () => {
  const port = await new Promise<number>((resolve) => {
    const s = createNetServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
  const pako = startPako({ PORT: String(port) });
  try {
    assert.ok(await pako.shows(/Pako is running for you/), pako.out());
    assert.match(pako.out(), /\(that link works once, for 10 minutes: `npm run panel` in this folder gives a new one\. Ctrl\+C stops Pako\.\)/);
    assert.doesNotMatch(pako.out(), /opening your browser/, "PAKO_NO_OPEN=1: it does not say it opens one");
    const out = await runPanel({ PAKO_HOME: pako.home });
    assert.equal(out.status, 0, out.stderr);
    const link = /http:\/\/127\.0\.0\.1:\d+\/panel\/login\/\S+/.exec(out.stdout)![0].replace("localhost", "127.0.0.1");
    const login = await fetch(link, { redirect: "manual" });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const base = `http://127.0.0.1:${port}`;
    const sent = await fetch(`${base}/panel/api/chat`, { method: "POST", headers: { cookie, "x-pako": "1", "content-type": "application/json" }, body: JSON.stringify({ text: "hola" }) });
    assert.equal(sent.status, 202);
    let chat: { messages: { who: string; text: string }[]; status: { claude: string } } = { messages: [], status: { claude: "" } };
    const told = await until(async () => {
      chat = await (await fetch(`${base}/panel/api/chat?since=0`, { headers: { cookie } })).json() as typeof chat;
      return chat.status.claude === "login" && chat.messages.some((m) => /sign in again/.test(m.text));
    });
    assert.ok(told, `${JSON.stringify(chat)}\n${pako.out()}`);

    const second = startPako({ PORT: String(port), PAKO_HOME: pako.home });
    assert.equal(await second.exited, 1);
    assert.match(second.out(), /already running for this folder \(process \d+\)\. Open its panel with: npm run panel\./);
    const busy = startPako({ PORT: String(port) });
    assert.equal(await busy.exited, 1);
    assert.match(busy.out(), /Port \d+ is already in use\. If Pako is already running, open its panel instead with: npm run panel/);
  } finally {
    await pako.stop();
  }
  const after = await runPanel({ PAKO_HOME: pako.home, PORT: String(port) });
  assert.equal(after.status, 1, "stopped: the lock is gone and nothing answers");
  assert.match(after.stderr, /Pako is not running/);
});

test("claude auth status: only its exit code and authMethod are read, and anything else is no answer", () => {
  // https://code.claude.com/docs/en/cli-reference: JSON, exit 0 when signed in and 1 when not; authMethod none, claude.ai, oauth_token, api_key,
  // api_key_helper or third_party.
  assert.equal(authFromStatus(0, '{"loggedIn":true,"authMethod":"claude.ai","email":"a@example.com"}'), "plan");
  assert.equal(authFromStatus(0, '{"authMethod":"oauth_token"}\n'), "plan", "the long-lived token of claude setup-token is the plan too");
  assert.equal(authFromStatus(0, '{"authMethod":"api_key"}'), "key");
  assert.equal(authFromStatus(0, '{"authMethod":"api_key_helper"}'), "key");
  assert.equal(authFromStatus(0, '{"authMethod":"third_party"}'), "other");
  assert.equal(authFromStatus(1, '{"loggedIn":false,"authMethod":"none"}'), "none");
  assert.equal(authFromStatus(1, '{"loggedIn":false}'), "none");
  for (const [code, out] of [
    [0, '{"authMethod":"none"}'], // exit 0 with none: not something it says
    [0, '{"authMethod":"something-new"}'],
    [1, "error: unknown command 'auth'"], // an older Claude Code
    [1, '{"authMethod":"claude.ai"}'],
    [2, '{"authMethod":"claude.ai"}'],
    [null, ""],
    [0, "[]"],
    [0, "null"],
    [0, ""],
  ] as const) assert.equal(authFromStatus(code, out), null, `${code} ${out}`);
});

test("claude auth status is asked only of a Claude Code that has it (2.1.268 or newer)", () => {
  for (const v of ["2.1.268 (Claude Code)", "2.1.325 (Claude Code)\n", "2.2.0", "3.0.1"]) assert.equal(hasAuthStatus(v), true, v);
  for (const v of ["2.1.267 (Claude Code)", "2.0.99", "1.0.128 (Claude Code)", "", "Claude Code"]) assert.equal(hasAuthStatus(v), false, v);
});

test("sign-in: claude auth status says not signed in before any message fails, then the plan as soon as the person signs in (no restart)", async () => {
  let said: ClaudeAuth | null = "none";
  let asked = 0;
  const clock = { t: 1_000_000 };
  const s = supervised({ clock, auth: async () => (asked++, said) });
  try {
    assert.ok(await until(() => s.spawned.length === 1 && asked === 1));
    assert.deepEqual(s.bridge.status(), { claude: "login", running: true });
    // The bridge's own report (a message that failed) and the check agree; then the person signs in in Terminal.
    s.bridge.report("login");
    said = "plan";
    assert.deepEqual(await s.bridge.refresh(), { claude: "ok", running: true, auth: "plan" }, "the lost login is over");
    assert.equal(s.spawned.length, 1, "the same bridge: each run of claude -p reads the new login");
    // Asked at most once every three seconds, however often the app asks.
    const n = asked;
    await s.bridge.refresh();
    await s.bridge.refresh();
    assert.equal(asked, n);
    clock.t += 3_000;
    await s.bridge.refresh();
    assert.equal(asked, n + 1);
    // A login that fails later (expired) is said again, and a check that still finds a login does not hide it.
    s.bridge.report("login");
    clock.t += 3_000;
    assert.equal((await s.bridge.refresh()).claude, "login");
    // A Claude Code that cannot tell (no such command): what was known stays.
    said = null;
    s.bridge.report("ok");
    clock.t += 3_000;
    assert.deepEqual(await s.bridge.refresh(), { claude: "ok", running: true, auth: "plan" });
  } finally {
    s.bridge.stop();
  }
});

test("sign-in: an API key set for Claude is said with where it came from (never the key), and the missing command is asked nothing", async () => {
  const panel = supervised({ env: { ANTHROPIC_API_KEY: "sk-ant-made-up" }, fromPanel: (k) => k === "ANTHROPIC_API_KEY", auth: async () => "key" });
  const shell = supervised({ env: { ANTHROPIC_AUTH_TOKEN: " made-up " }, auth: async () => "plan" });
  const blank = supervised({ env: { ANTHROPIC_API_KEY: "  " }, auth: async () => "plan" });
  let asked = 0;
  const missing = supervised({ installed: false, auth: async () => (asked++, "plan") });
  try {
    assert.ok(await until(() => panel.bridge.status().auth === "key" && shell.bridge.status().auth === "plan" && blank.bridge.status().auth === "plan"));
    assert.deepEqual(panel.bridge.status(), { claude: "ok", running: true, auth: "key", key: "connections" });
    assert.deepEqual(shell.bridge.status(), { claude: "ok", running: true, auth: "plan", key: "environment" });
    assert.deepEqual(blank.bridge.status(), { claude: "ok", running: true, auth: "plan" });
    assert.ok(!JSON.stringify(panel.bridge.status()).includes("sk-ant"));
    assert.deepEqual(await missing.bridge.refresh(), { claude: "missing", running: false });
    assert.equal(asked, 0);
  } finally {
    for (const b of [panel, shell, blank, missing]) b.bridge.stop();
  }
});

test("sign-in: GET /panel/api/claude says the chat's status, looks again only with fresh=1, and only for the signed-in panel", async () => {
  let refreshed = 0;
  const r = await localRig({
    status: () => ({ claude: "login", running: true }),
    refresh: async () => (refreshed++, { claude: "ok", running: true, auth: "plan" }),
  });
  try {
    const cookie = await r.signIn((await (await r.askLink()).json() as { link: string }).link);
    const get = (q = "", headers: Record<string, string> = { cookie }) => fetch(`${r.base}/panel/api/claude${q}`, { headers });
    assert.deepEqual(await (await get()).json(), { status: { claude: "login", running: true } });
    assert.equal(refreshed, 0);
    assert.deepEqual(await (await get("?fresh=1")).json(), { status: { claude: "ok", running: true, auth: "plan" } });
    assert.equal(refreshed, 1);
    assert.equal((await get("", {})).status, 401, "no cookie, nothing");
    assert.equal((await fetch(`${r.base}/panel/api/claude`, { method: "POST", headers: { cookie } })).status, 404, "read only");
  } finally {
    r.close();
  }
});
