// Hardening before publishing. On a computer (local mode, src/guard-http.ts) Pako answers only its own names, so DNS rebinding gets 421, and
// nothing another website's page sends, so no page can press its buttons, type in its chat, ask for a sign-in link or use up the rate limits
// that the bridge and `npm run panel` share with it; a server on the internet is untouched. Also: ~/.pako stays private, the admin key is
// compared by hash, and an Anthropic API key in ~/.pako/.env or the shell reaches `claude` (Pako works with a key and no Claude login).

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { connect, createServer as createNetServer, type AddressInfo } from "node:net";
import { hostname, networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "express";
import { ClaudeError, runClaude } from "../assistant/bridge.ts";
import { adminRequest, createApp, loadAppConfig, type LocalContext } from "../src/app.ts";
import { hostOf, localGuard } from "../src/guard-http.ts";
import type { Kv } from "../src/kv.ts";
import { createLocalChannel, loadHome, localEnv, superviseBridge } from "../src/local.ts";

const ENTRY = fileURLToPath(new URL("../src/server.ts", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "pako-hard-"));
const posix = process.platform !== "win32";
/** A made-up key in no real key's format: it opens nothing, and only the stand-in `claude` below accepts it. */
const KEY = "test-key-0123456789abcdef";
const EVIL = "https://evil.example";

type Answer = { status: number; headers: IncomingHttpHeaders; text: string };

/** One request with its headers exactly as given (fetch would not let a test forge Host, Origin or the Sec-Fetch-* headers). */
function call(port: number, path: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: o.method ?? "GET", headers: o.headers ?? {}, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(o.body);
  });
}

/** A request with no Host header at all (HTTP/1.0 allows it): its status line. */
function withoutHost(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    const socket = connect({ host: "127.0.0.1", port }, () => socket.write("GET /health HTTP/1.0\r\n\r\n"));
    socket.setEncoding("utf8");
    socket.on("data", (c: string) => (out += c));
    socket.on("end", () => resolve(out.split("\r\n")[0] ?? ""));
    socket.on("error", reject);
  });
}

function memoryKv(): Kv {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return (server.address() as AddressInfo).port;
};

/** Pako in local mode as src/server.ts builds it, in this process, signed in once; `env` adds settings (PAKO_HOST). */
async function localRig(env: Record<string, string> = {}) {
  const home = loadHome({ PAKO_HOME: join(tmp(), "home"), PAKO_NAME: "Ana" });
  const all: Record<string, string | undefined> = { ...localEnv({}, home, 0), PAKO_HOME: home.dir, ...env };
  const kv = memoryKv();
  const channel = createLocalChannel({ kv });
  const local: LocalContext = { kv, channel, bridgeToken: home.bridgeToken, panelSecret: home.panelSecret, bridge: { status: () => ({ claude: "ok", running: true }) } };
  const app = createApp(loadAppConfig(all), all, local);
  const server = createServer(app);
  const port = await listen(server);
  const self = `http://127.0.0.1:${port}`;
  const login = async (): Promise<string> => new URL((app.locals.panelLink as () => string)()).pathname;
  const signIn = await call(port, await login());
  assert.equal(signIn.status, 200);
  const cookie = String(signIn.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
  /** The headers the panel's own page sends with a button press: its cookie, the custom header, and the browser's word that it is this page. */
  const panel = { cookie, "x-pako": "1", "content-type": "application/json", origin: self, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" };
  const bearer = { authorization: `Bearer ${home.bridgeToken}` };
  return {
    port,
    self,
    home,
    channel,
    cookie,
    panel,
    bearer,
    login,
    /** The pause as the panel shows it (null: running). */
    paused: async () => (JSON.parse((await call(port, "/panel/api/overview", { headers: { cookie } })).text) as { paused: number | null }).paused,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

// ---------- 1. the names: DNS rebinding ----------

test("hostOf: a plain name or address and a port, nothing else", () => {
  assert.deepEqual(hostOf("127.0.0.1:8787"), { name: "127.0.0.1", port: 8787 });
  assert.deepEqual(hostOf("LocalHost:8787"), { name: "localhost", port: 8787 });
  assert.deepEqual(hostOf("[::1]:8787"), { name: "[::1]", port: 8787 });
  assert.deepEqual(hostOf("localhost"), { name: "localhost", port: 80 }, "no port is the browser's way of saying 80");
  for (const bad of ["", undefined, "127.0.0.1:8787@evil.example", "evil.example/x", "a b", "x:0", "x:65536", "x:", "[::1", "[fe80::1%25en0]:80", "::1"]) {
    assert.equal(hostOf(bad), null, String(bad));
  }
});

test("local mode: a name that is not this computer's (DNS rebinding) is refused with 421 before any route; its own names are accepted", async () => {
  const r = await localRig();
  try {
    for (const host of [
      `evil.example:${r.port}`, // a rebound name, on the right port
      "evil.example",
      `127.0.0.1.evil.example:${r.port}`,
      `localhost.evil.example:${r.port}`,
      `127.0.0.1:${r.port}@evil.example`,
      `0.0.0.0:${r.port}`, // only with PAKO_HOST=0.0.0.0
      `[::2]:${r.port}`,
    ]) {
      const a = await call(r.port, "/health", { headers: { host } });
      assert.equal(a.status, 421, host);
      assert.equal(a.headers["cache-control"], "no-store");
      assert.match(a.text, /^Pako only answers at its own address on this computer\. To open the panel, run npm run panel/, host);
    }
    assert.match(await withoutHost(r.port), /^HTTP\/1\.1 421 /, "no Host at all");
    // The token does not help: nothing reaches the routes under another name.
    const evil = `evil.example:${r.port}`;
    assert.equal((await call(r.port, "/panel/api/link", { method: "POST", headers: { ...r.bearer, host: evil } })).status, 421);
    assert.equal((await call(r.port, "/assistant/inbox", { headers: { ...r.bearer, host: evil } })).status, 421);
    assert.equal((await call(r.port, "/panel/api/overview", { headers: { cookie: r.cookie, host: evil } })).status, 421);
    assert.equal((await call(r.port, await r.login(), { headers: { host: evil } })).status, 421, "a sign-in link opened under another name");

    for (const host of [`127.0.0.1:${r.port}`, `localhost:${r.port}`, `LOCALHOST:${r.port}`, `[::1]:${r.port}`]) {
      assert.equal((await call(r.port, "/health", { headers: { host } })).status, 200, host);
    }
    // The port is not part of the name: a forwarded port (ssh -L 9000:127.0.0.1:8787, a container's published port) arrives with its own,
    // and a browser cannot forge it. Another website is still refused under it, by its origin.
    for (const host of [`localhost:${r.port + 1}`, "127.0.0.1", "localhost:9000"]) {
      assert.equal((await call(r.port, "/health", { headers: { host } })).status, 200, host);
    }
    const forwarded = { ...r.panel, host: "localhost:9000", origin: "http://localhost:9000" };
    assert.equal((await call(r.port, "/panel/api/pause", { method: "POST", headers: forwarded, body: '{"on":false}' })).status, 200, "the panel through a forwarded port");
    const other = { ...r.panel, host: "localhost:9000", origin: EVIL, "sec-fetch-site": "cross-site" };
    assert.equal((await call(r.port, "/panel/api/pause", { method: "POST", headers: other, body: '{"on":true}' })).status, 403, "another site, through it");
    assert.equal((await call(r.port, "/panel/api/overview", { headers: { cookie: r.cookie, host: `localhost:${r.port}` } })).status, 200);
  } finally {
    r.close();
  }
  // The address PAKO_HOST tells Pako to listen on is one of its names too (an IPv6 one as a browser writes it, in brackets).
  const lan = await localRig({ PAKO_HOST: "192.168.1.50" });
  const six = await localRig({ PAKO_HOST: "fd00::5" });
  try {
    assert.equal((await call(lan.port, "/health", { headers: { host: `192.168.1.50:${lan.port}` } })).status, 200);
    assert.equal((await call(lan.port, "/health", { headers: { host: `127.0.0.1:${lan.port}` } })).status, 200, "the loopback names still work");
    const refused = await call(lan.port, "/health", { headers: { host: `192.168.1.51:${lan.port}` } });
    assert.equal(refused.status, 421);
    assert.equal(refused.text, "Pako only answers at its own address on this computer. To open the panel, run npm run panel in the Pako folder.");
    assert.equal((await call(six.port, "/health", { headers: { host: `[fd00::5]:${six.port}` } })).status, 200);
    assert.equal((await call(six.port, "/health", { headers: { host: `192.168.1.50:${six.port}` } })).status, 421);
  } finally {
    lan.close();
    six.close();
  }
});

test("PAKO_HOST=0.0.0.0 (or ::): the panel answers by this computer's network addresses and its name, and still by nothing else", async () => {
  /** The guard alone, on a computer with these addresses and names; the status it gives a Host header (200: let through). */
  const guardOf = (host: string | undefined, network: string[] = ["192.168.1.50", "fe80::1c2b:3aff:fe4d:5e6f%en0", "fd00::5", "mybox", "mybox.local"]) => {
    const guard = localGuard({ ...(host === undefined ? {} : { host }), network: () => network });
    return (name: string): number => {
      let status = 0;
      const res = { status: (s: number) => ((status = s), res), set: () => res, type: () => res, send: () => res } as unknown as Response;
      const req = { headers: { host: name }, socket: {}, method: "GET", path: "/health", get: () => undefined } as unknown as Request;
      guard(req, res, () => (status = 200));
      return status;
    };
  };
  for (const wildcard of ["0.0.0.0", "::", "[::]"]) {
    const run = guardOf(wildcard);
    for (const name of ["192.168.1.50:8787", "mybox.local:8787", "MyBox:8787", "[fd00::5]:8787", "[fe80::1c2b:3aff:fe4d:5e6f]:8787", "192.168.1.50:9000",
      "localhost:8787", "127.0.0.1:8787"]) {
      assert.equal(run(name), 200, `${wildcard}: ${name}`);
    }
    for (const name of ["evil.example:8787", "192.168.1.51:8787", "mybox.evil.example:8787", "notmybox.local:8787", "[fd00::6]:8787"]) {
      assert.equal(run(name), 421, `${wildcard}: ${name}`);
    }
  }
  assert.equal(guardOf("0.0.0.0")("0.0.0.0:8787"), 200, "the address it was given, as before");
  // Only when told to listen everywhere: on its own address, or on one given address, the network's names are not Pako's.
  for (const host of [undefined, "127.0.0.1", "192.168.1.50"]) {
    assert.equal(guardOf(host)("mybox.local:8787"), 421, String(host));
    assert.equal(guardOf(host)("[fd00::5]:8787"), 421, String(host));
  }
  assert.equal(guardOf("192.168.1.50")("192.168.1.50:8787"), 200);
  // The addresses are asked when needed: a computer that joins another network is reached by its new address, with no restart.
  const addresses = ["192.168.1.50"];
  const moving = guardOf("0.0.0.0", addresses);
  assert.equal(moving("10.0.0.7:8787"), 421);
  addresses.push("10.0.0.7");
  assert.equal(moving("10.0.0.7:8787"), 200);

  // Through the whole app, with this computer's real name and addresses (src/guard-http.ts reads them from the system).
  const r = await localRig({ PAKO_HOST: "0.0.0.0" });
  try {
    // A host name a Host header cannot carry (an underscore, say) is no name a browser could use either: left out.
    const mine = [hostname().toLowerCase(), ...Object.values(networkInterfaces()).flatMap((l) => (l ?? []).filter((i) => i.family === "IPv4").map((i) => i.address))]
      .filter((name) => /^[a-z0-9.-]+$/.test(name));
    for (const name of mine) assert.equal((await call(r.port, "/health", { headers: { host: `${name}:${r.port}` } })).status, 200, name);
    assert.equal((await call(r.port, "/panel/api/overview", { headers: { cookie: r.cookie, host: `${mine[0]}:${r.port}` } })).status, 200, "the panel, by the computer's name");
    for (const name of ["evil.example", "192.0.2.77"]) assert.equal((await call(r.port, "/health", { headers: { host: `${name}:${r.port}` } })).status, 421, name);
    // A rebound name is still nothing, and another website's page still cannot press STOP by the computer's address.
    const cross = { ...r.panel, host: `${mine[0]}:${r.port}`, origin: EVIL, "sec-fetch-site": "cross-site" };
    assert.equal((await call(r.port, "/panel/api/pause", { method: "POST", headers: cross, body: '{"on":true}' })).status, 403);
  } finally {
    r.close();
  }
});

// ---------- 2. requests another website's page makes ----------

test("local mode: another website's page can neither press STOP nor type in the chat; the panel itself, programs and a link from elsewhere can", async () => {
  const r = await localRig();
  try {
    const pause = (headers: Record<string, string>, on = true) => call(r.port, "/panel/api/pause", { method: "POST", headers, body: JSON.stringify({ on }) });
    const refusals: [string, Record<string, string>][] = [
      ["another site's Origin", { ...r.panel, origin: EVIL, "sec-fetch-site": "cross-site" }],
      ["an Origin with no Fetch Metadata (an older browser)", { cookie: r.cookie, "x-pako": "1", origin: EVIL }],
      ["Origin null (a sandboxed frame, a page that sends no referrer)", { cookie: r.cookie, "x-pako": "1", origin: "null" }],
      ["another program on this computer", { cookie: r.cookie, "x-pako": "1", origin: `http://127.0.0.1:${r.port + 1}` }],
      ["the same port under another name", { cookie: r.cookie, "x-pako": "1", origin: `http://localhost:${r.port}` }],
      ["https, not this page", { cookie: r.cookie, "x-pako": "1", origin: `https://127.0.0.1:${r.port}` }],
      ["only a Referer from another site", { cookie: r.cookie, "x-pako": "1", referer: `${EVIL}/page` }],
      ["only the browser's word: cross-site", { cookie: r.cookie, "x-pako": "1", "sec-fetch-site": "cross-site" }],
      ["only the browser's word: same-site (another port)", { cookie: r.cookie, "x-pako": "1", "sec-fetch-site": "same-site" }],
      ["a form sent from another site (a navigation that changes something)", { cookie: r.cookie, origin: EVIL, "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }],
    ];
    for (const [why, headers] of refusals) {
      const a = await pause(headers);
      assert.equal(a.status, 403, why);
      assert.equal(a.text, "Pako does not take requests from other websites.", why);
    }
    assert.equal(await r.paused(), null, "nothing was paused");
    const before = (await r.channel.list(0)).length;
    const typed = await call(r.port, "/panel/api/chat", { method: "POST", headers: { ...r.panel, origin: EVIL, "sec-fetch-site": "cross-site" }, body: JSON.stringify({ text: "STOP" }) });
    assert.equal(typed.status, 403);
    const pressed = await call(r.port, "/panel/api/chat/press", { method: "POST", headers: { ...r.panel, origin: EVIL }, body: JSON.stringify({ id: "c1:abcdef0123" }) });
    assert.equal(pressed.status, 403);
    const preflight = await call(r.port, "/panel/api/chat", { method: "OPTIONS", headers: { origin: EVIL, "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" } });
    assert.equal(preflight.status, 403, "a preflight from another site");
    assert.equal((await r.channel.list(0)).length, before, "nothing was typed");

    // The panel's own page: its Origin and the browser's same-origin. A program (curl) sends neither; an older browser may send only a Referer.
    assert.equal((await pause(r.panel)).status, 200);
    assert.notEqual(await r.paused(), null);
    assert.equal((await pause({ cookie: r.cookie, "x-pako": "1", "content-type": "application/json" }, false)).status, 200, "no Origin at all");
    assert.equal(await r.paused(), null);
    assert.equal((await pause({ cookie: r.cookie, "x-pako": "1", "content-type": "application/json", referer: `${r.self}/panel` })).status, 200, "a Referer of this page");
    assert.equal((await pause({ ...r.panel, origin: `http://localhost:${r.port}`, host: `localhost:${r.port}` }, false)).status, 200, "this page under localhost");
    // The routes' own checks are still there behind the guard: the custom header, and the cookie.
    const { "x-pako": _, ...noHeader } = r.panel;
    assert.equal((await pause(noHeader)).status, 401, "the custom header is still needed");
    const { cookie: __, ...noCookie } = r.panel;
    assert.equal((await pause(noCookie)).status, 401, "and the cookie");
    assert.equal((await call(r.port, "/panel/api/chat", { method: "POST", headers: r.panel, body: JSON.stringify({ text: "hola" }) })).status, 202);

    // Opening a page from a link on another site (a sign-in link tapped in Telegram's web app) still works: it changes nothing, and the
    // SameSite=Strict cookie is not sent with it. The same link loaded by that site as an image or in a frame is refused.
    const opened = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
    const link = await call(r.port, await r.login(), { headers: opened });
    assert.equal(link.status, 200);
    assert.match(String(link.headers["set-cookie"]?.[0] ?? ""), /^pako_panel_\d+=\d+\./);
    assert.equal((await call(r.port, "/panel", { headers: opened })).status, 200);
    assert.equal((await call(r.port, "/", { headers: opened })).status, 302);
    assert.equal((await call(r.port, await r.login(), { headers: { ...opened, "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" } })).status, 403);
    assert.equal((await call(r.port, await r.login(), { headers: { ...opened, "sec-fetch-dest": "iframe" } })).status, 403);
    // Not a program's route, though: one opened again and again from another site would count towards its rate limit (in any case of letters,
    // as Express matches them). Any other page opens.
    for (const path of ["/assistant/inbox", "/ASSISTANT/Inbox", `/personal/${"x".repeat(32)}`, "/personal-voice/result", "/admin/log", "/panel/api/overview", "/Panel/Assets/app.css"]) {
      assert.equal((await call(r.port, path, { headers: opened })).status, 403, path);
    }
    assert.equal((await call(r.port, "/health", { headers: opened })).status, 200);
    assert.equal((await call(r.port, "/panel/api/overview", { headers: { cookie: r.cookie, "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" } })).status, 403);
    assert.equal((await call(r.port, "/panel/api/overview", { headers: { cookie: r.cookie, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" } })).status, 200);
    // An older browser (no Sec-Fetch-*): another site's script reading carries that site's Origin and is refused; a link from another site
    // carries only a Referer, and opens.
    assert.equal((await call(r.port, "/panel/api/overview", { headers: { cookie: r.cookie, origin: EVIL } })).status, 403);
    assert.equal((await call(r.port, await r.login(), { headers: { referer: `${EVIL}/chat` } })).status, 200);
    // Another site's page may not even load the panel's files into itself.
    const css = await call(r.port, "/panel/assets/app.css", { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "style" } });
    assert.equal(css.status, 403);
    const own = await call(r.port, "/panel/assets/app.css", { headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "style" } });
    assert.equal(own.status, 200);
    assert.equal(own.headers["cross-origin-resource-policy"], "same-origin");
    assert.equal(own.headers["cross-origin-opener-policy"], "same-origin");
  } finally {
    r.close();
  }
});

test("local mode: no website can use up the rate limits that the bridge, `npm run panel` and the sign-in links share with it on 127.0.0.1", async () => {
  const r = await localRig();
  try {
    const page = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" };
    const form = { origin: EVIL, "content-type": "text/plain" };
    for (let i = 0; i < 40; i++) {
      assert.equal((await call(r.port, "/assistant/inbox", { headers: page })).status, 403);
      assert.equal((await call(r.port, "/panel/api/link", { method: "POST", headers: form, body: "x" })).status, 403);
      assert.equal((await call(r.port, "/assistant/health", { method: "POST", headers: form, body: "x" })).status, 403);
    }
    for (let i = 0; i < 301; i++) assert.equal((await call(r.port, `/panel/login/made-up-${i}`, { headers: page })).status, 403);
    assert.equal((await call(r.port, "/assistant/inbox", { headers: r.bearer })).status, 200, "the bridge still gets its messages");
    assert.equal((await call(r.port, "/panel/api/link", { method: "POST", headers: r.bearer })).status, 200, "npm run panel still gets a link");
    const report = await call(r.port, "/assistant/health", { method: "POST", headers: { ...r.bearer, "content-type": "application/json" }, body: '{"claude":"ok"}' });
    assert.equal(report.status, 200, "the bridge's report still arrives");
    assert.equal((await call(r.port, await r.login())).status, 200, "a sign-in link still works");
    // What the guard saves them from: the same refused requests from a program (no browser headers) still count, as before.
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await call(r.port, "/assistant/inbox")).status);
    assert.equal(codes[30], 429);
  } finally {
    r.close();
  }
});

// ---------- 3. a server on the internet ----------

test("hosted mode is untouched: any Host, and the browser's headers are left to the routes (the panel's cookie and custom header)", async () => {
  const env: Record<string, string | undefined> = {
    PERSONAL_CALLER_TOKEN: "t".repeat(32),
    PERSONAL_OWNER_NAME: "Ana",
    PERSONAL_OWNER_NUMBER: "+34600111222",
    WHATSAPP_ACCESS_TOKEN: "EAAB_made_up_value",
    WHATSAPP_PHONE_NUMBER_ID: "109876543210",
    WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
    WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
    ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
    PUBLIC_URL: "https://pako.example.com",
  };
  const server = createServer(createApp(loadAppConfig(env), env));
  const port = await listen(server);
  try {
    for (const host of ["pako.example.com", "evil.example", "127.0.0.1", `127.0.0.1:${port}`]) {
      assert.equal((await call(port, "/health", { headers: { host } })).status, 200, host);
    }
    assert.equal((await call(port, "/health", { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" } })).status, 200);
    const pressed = await call(port, "/panel/api/pause", { method: "POST", headers: { origin: EVIL, "x-pako": "1", "content-type": "application/json" }, body: "{}" });
    assert.equal(pressed.status, 401, "the route's own answer (sign in), not the computer's guard");
    assert.equal((await call(port, "/assistant/inbox", { headers: { host: "evil.example", authorization: `Bearer ${"b".repeat(48)}` } })).status, 200);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

// ---------- 4. the secrets on disk, the admin key ----------

test("~/.pako stays private: a folder made by hand before the first start, its .env and a copied secrets file lose group and other access", { skip: !posix }, () => {
  const dir = join(tmp(), "home");
  mkdirSync(dir);
  chmodSync(dir, 0o755);
  writeFileSync(join(dir, ".env"), `ANTHROPIC_API_KEY=${KEY}\n`);
  chmodSync(join(dir, ".env"), 0o644);
  writeFileSync(join(dir, "secrets.json"), JSON.stringify({ bridgeToken: "b".repeat(48), callerToken: "c".repeat(48), panelSecret: "p".repeat(48) }));
  chmodSync(join(dir, "secrets.json"), 0o644);
  const home = loadHome({ PAKO_HOME: dir });
  assert.equal(home.bridgeToken, "b".repeat(48), "the copied secrets are kept, only their mode changes");
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "secrets.json")).mode & 0o777, 0o600);
  // A PAKO_HOME that names the home folder itself (a mistake) does not lock the person's whole home folder.
  const fakeHome = tmp();
  chmodSync(fakeHome, 0o755);
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    loadHome({ PAKO_HOME: fakeHome });
    assert.equal(statSync(fakeHome).mode & 0o777, 0o755);
    assert.equal(statSync(join(fakeHome, "secrets.json")).mode & 0o777, 0o600);
  } finally {
    process.env.HOME = realHome;
  }
});

test("the admin key: right in each of its three forms; a wrong one is refused whatever its length (compared by hash, in constant time)", () => {
  const key = "k".repeat(30);
  const req = (headers: Record<string, string>) => ({ headers, get: (name: string) => headers[name.toLowerCase()] }) as unknown as Request;
  assert.equal(adminRequest(req({ authorization: `Bearer ${key}` }), key), true);
  assert.equal(adminRequest(req({ authorization: `Basic ${Buffer.from(`admin:${key}`).toString("base64")}` }), key), true);
  assert.equal(adminRequest(req({ "x-admin-key": key }), key), true);
  for (const wrong of [`${key}x`, key.slice(1), "", "k".repeat(29) + "j", `${key}${key}`]) {
    assert.equal(adminRequest(req({ authorization: `Bearer ${wrong}` }), key), false, wrong);
    assert.equal(adminRequest(req({ "x-admin-key": wrong }), key), false, wrong);
  }
  assert.equal(adminRequest(req({ authorization: `Bearer ${key}` }), ""), false, "no admin key set: the routes are closed");
  assert.equal(adminRequest(req({}), key), false);
});

// ---------- 5. Claude with an API key and no Claude login ----------

/** A stand-in `claude`: it answers only with the made-up key in its environment, and otherwise says what a claude with no login says. */
function keyOnlyClaude(): string {
  const bin = join(tmp(), "claude");
  const answer = JSON.stringify({ type: "result", result: "Hola: contesto con tu clave de API.", session_id: "s-key", is_error: false, total_cost_usd: 0 });
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "2.0.0 (Claude Code)"; exit 0; fi',
      "cat >/dev/null",
      `if [ "$ANTHROPIC_API_KEY" = "${KEY}" ]; then printf '%s' '${answer}'; exit 0; fi`,
      'echo "Not logged in · Please run /login" >&2',
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return bin;
}

test("API key, first step: the bridge Pako starts gets ANTHROPIC_API_KEY (and Claude's own settings) from the shell, never the other keys", async () => {
  const envs: NodeJS.ProcessEnv[] = [];
  const bridge = superviseBridge({
    env: {
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_BASE_URL: "https://proxy.example",
      CLAUDE_CODE_OAUTH_TOKEN: "made-up-oauth-value",
      AGENTMAIL_API_KEY: "am_made_up",
      TELEGRAM_BOT_TOKEN: "123:made-up",
      SLACK_USER_TOKEN: "xoxp-made-up",
      GOOGLE_PLACES_API_KEY: "made-up",
      PERSONAL_CALLER_TOKEN: "c".repeat(48),
      ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
    },
    log: () => undefined,
    installed: async () => true,
    home: tmp(),
    spawn: ((_cmd: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      envs.push(options.env);
      const child = new EventEmitter() as unknown as ChildProcess;
      Object.assign(child, { kill: () => (setImmediate(() => child.emit("exit", null)), true) });
      return child;
    }) as unknown as typeof spawn,
  });
  try {
    for (let i = 0; i < 200 && !envs.length; i++) await new Promise((r) => setTimeout(r, 10));
    const env = envs[0]!;
    assert.equal(env.ANTHROPIC_API_KEY, KEY);
    assert.equal(env.ANTHROPIC_BASE_URL, "https://proxy.example");
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "made-up-oauth-value", "the long-lived token of `claude setup-token` too");
    assert.equal(env.ASSISTANT_BRIDGE_TOKEN, "b".repeat(48), "its own setting, to reach the server");
    for (const k of ["AGENTMAIL_API_KEY", "TELEGRAM_BOT_TOKEN", "SLACK_USER_TOKEN", "GOOGLE_PLACES_API_KEY", "PERSONAL_CALLER_TOKEN"]) assert.equal(env[k], undefined, k);
  } finally {
    bridge.stop();
  }
});

test("API key, second step: the bridge runs claude with the key it was given, and without one a claude with no login is a login problem", async () => {
  const bin = keyOnlyClaude();
  const before = process.env.ANTHROPIC_API_KEY;
  const c = { claudeBin: bin, tools: [], model: "", runTimeoutMs: 20_000 };
  try {
    process.env.ANTHROPIC_API_KEY = KEY;
    assert.equal((await runClaude("hola", c)).text, "Hola: contesto con tu clave de API.");
    delete process.env.ANTHROPIC_API_KEY;
    const err = await runClaude("hola", c).catch((e: unknown) => e);
    assert.ok(err instanceof ClaudeError);
    assert.equal(err.kind, "login");
  } finally {
    if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = before;
  }
});

test("API key, what can go wrong: a refused key is a sign-in problem; an account out of credits waits like a limit (the message is kept)", { skip: !posix }, async () => {
  const saying = (result: string): string => {
    const bin = join(tmp(), "claude");
    const doc = JSON.stringify({ type: "result", subtype: "success", is_error: true, result, session_id: "s-err" });
    writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${doc}'\nexit 1\n`, { mode: 0o755 });
    return bin;
  };
  const kind = async (result: string) => {
    const err = await runClaude("hola", { claudeBin: saying(result), tools: [], model: "", runTimeoutMs: 20_000 }).catch((e: unknown) => e);
    assert.ok(err instanceof ClaudeError, result);
    return err.kind;
  };
  assert.equal(await kind("Invalid API key · Please run /login"), "login");
  assert.equal(await kind("Credit balance is too low"), "limit");
  assert.equal(await kind("Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."), "limit");
});

test("API key, end to end: a key only in ~/.pako/.env, no Claude login on this computer, and the chat is answered", { skip: !posix }, async () => {
  const port = await new Promise<number>((resolve) => {
    const s = createNetServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
  const dir = tmp();
  const home = join(dir, "home");
  mkdirSync(home);
  writeFileSync(join(home, ".env"), `# made up for this test\nANTHROPIC_API_KEY=${KEY}\n`, { mode: 0o644 });
  // An empty home folder: no Claude login of any kind, and nothing else from the shell running the tests.
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", HOME: dir, PAKO_HOME: home, PAKO_NAME: "Ana", PAKO_NO_OPEN: "1", CLAUDE_BIN: keyOnlyClaude(), PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  // A long limit: on a machine running the whole suite at once, starting Pako and its bridge can take a while.
  const until = async (ok: () => boolean | Promise<boolean>, ms = 60_000): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await ok()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return ok();
  };
  try {
    assert.ok(await until(() => /Pako is running for you/.test(out)), out);
    const path = new URL(/http:\/\/127\.0\.0\.1:\d+\/panel\/login\/\S+/.exec(out)![0]).pathname;
    const login = await call(port, path);
    assert.equal(login.status, 200);
    const cookie = String(login.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
    const sent = await call(port, "/panel/api/chat", { method: "POST", headers: { cookie, "x-pako": "1", "content-type": "application/json" }, body: JSON.stringify({ text: "hola" }) });
    assert.equal(sent.status, 202);
    let chat = { messages: [] as { who: string; text: string }[], status: { claude: "" } };
    const answered = await until(async () => {
      chat = JSON.parse((await call(port, "/panel/api/chat?since=0", { headers: { cookie } })).text) as typeof chat;
      return chat.messages.some((m) => m.who === "pako" && m.text === "Hola: contesto con tu clave de API.");
    });
    assert.ok(answered, `${JSON.stringify(chat)}\n${out}`);
    assert.equal(chat.status.claude, "ok");
    assert.equal(statSync(join(home, ".env")).mode & 0o777, 0o600, "the .env with the key was made private at the start");
    assert.doesNotMatch(out, new RegExp(KEY), "the key is never printed");
  } finally {
    child.kill("SIGINT");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000).unref())]);
    child.kill("SIGKILL");
    // Its bridge shares these pipes and takes a moment more to go: the test is not held for it.
    child.stdout!.destroy();
    child.stderr!.destroy();
  }
});
