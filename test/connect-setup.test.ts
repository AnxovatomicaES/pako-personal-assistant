// Slack and Zoom connected from the panel (src/connect-setup.ts), against a fake Slack and a fake Zoom on this computer (plain HTTP):
// - the browser goes to the fake Allow page and comes back to Pako's callback;
// - Pako exchanges the code with the PKCE verifier and no secret, and keeps the tokens in the panel's store (a temporary folder);
// - the account shows "Connected as";
// - a Cancel, a wrong or reused state, a callback that is not from this computer, a rotating Slack token and a missing scope are each
//   refused plainly.
// Nothing of the owner's is touched, and nothing goes to the real Slack or Zoom.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, get as httpGet, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import express from "express";
import { mountConnectSetup, pkcePair, redirectUri, slackCreateUrl, slackManifest, zoomManifest, type ConnectSetupDeps } from "../src/connect-setup.ts";
import { builtInClients, SLACK_CLIENT_ID, SLACK_RELAY_REDIRECT, type BuiltInDefaults } from "../src/connect-clients.ts";
import { mountConnectionsPanel } from "../src/connections-panel.ts";
import { readStored, writeStored } from "../src/connections.ts";
import { SLACK_USER_SCOPES } from "../src/slack.ts";
import { ZOOM_USER_SCOPES } from "../src/zoom.ts";
import { auth, PANEL } from "./helpers/connect-rig.ts";
import { runInNewContext } from "node:vm";

/** The forwarding function of the site's Slack page (site/connect/slack/callback.html), run as the page runs it. */
const SLACK_PAGE = readFileSync(join(import.meta.dirname, "../site/connect/slack/callback.html"), "utf8");
const relayTarget: (search: string) => string | null = (() => {
  const js = /<script>([\s\S]*?)<\/script>/.exec(SLACK_PAGE)![1]!;
  const ctx: Record<string, unknown> = { URLSearchParams };
  runInNewContext(js, ctx);
  return ctx.pakoTarget as (search: string) => string | null;
})();

/** A port nothing listens on yet, for the project's Slack loopback in a test. */
async function freePort(): Promise<number> {
  const s = createServer().listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

const SLACK_CLIENT = "1234567890.9876543210";
const ZOOM_CLIENT = "AbCdEfGhIjKlMn_0123";
const XOXP = `xoxp-${"7".repeat(12)}-${"8".repeat(12)}-abcdefghijklmnop`;
const ZOOM_REFRESH = "eyJhbGciOiJIUzUxMiJ9.refresh-one.signature";

const s256 = (v: string) => createHash("sha256").update(v).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const form = (req: IncomingMessage): Promise<URLSearchParams> =>
  new Promise((r) => {
    let b = "";
    req.on("data", (c: Buffer) => (b += c.toString("utf8")));
    req.on("end", () => r(new URLSearchParams(b)));
  });
const listen = async (s: Server, host = "127.0.0.1"): Promise<number> => {
  await new Promise<void>((r) => s.listen(0, host, () => r()));
  return (s.address() as AddressInfo).port;
};

/**
 * A fake Slack and Zoom, as their documentation describes them:
 * - the Allow page sends the browser back with a code and the state, or with error=access_denied when told to refuse;
 * - the token endpoints check the code, the redirect and the PKCE verifier against the challenge, and that no secret was sent.
 */
async function fakeVendors(o: { refuse?: boolean; slackToken?: Record<string, unknown>; zoomScope?: string; slowMs?: number } = {}) {
  const seen = { slackExchange: null as URLSearchParams | null, zoomExchange: null as URLSearchParams | null, zoomAuthHeader: "", slackAuthorize: null as URLSearchParams | null };
  const codes = new Map<string, { challenge: string; redirect: string; client: string }>();
  const relay = { port: 0 };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const json = (v: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
    if (url.pathname === "/relay") {
      const to = relayTarget(url.search);
      if (!to) return void res.writeHead(400).end();
      return void res.writeHead(302, { location: to.replace(":53682/", `:${relay.port}/`) }).end();
    }
    if (url.pathname === "/slack/authorize" || url.pathname === "/zoom/authorize") {
      const q = url.searchParams;
      if (url.pathname === "/slack/authorize") seen.slackAuthorize = q;
      const back = new URL(q.get("redirect_uri")!);
      back.searchParams.set("state", q.get("state")!);
      if (o.refuse) back.searchParams.set("error", "access_denied");
      else {
        const code = `code-${codes.size + 1}`;
        codes.set(code, { challenge: q.get("code_challenge")!, redirect: q.get("redirect_uri")!, client: q.get("client_id")! });
        back.searchParams.set("code", code);
      }
      return void res.writeHead(302, { location: back.href }).end();
    }
    const check = (b: URLSearchParams): string | null => {
      const c = codes.get(b.get("code") ?? "");
      if (!c) return "invalid_code";
      if (b.get("redirect_uri") !== c.redirect) return "bad_redirect_uri";
      if (b.get("client_id") !== c.client) return "invalid_client_id";
      if (b.has("client_secret")) return "secret_not_allowed_with_pkce";
      if (s256(b.get("code_verifier") ?? "") !== c.challenge) return "invalid_code_verifier";
      codes.delete(b.get("code")!);
      return null;
    };
    if (url.pathname === "/slack/api/oauth.v2.access") {
      const b = await form(req);
      seen.slackExchange = b;
      if (o.slowMs) await new Promise((r) => setTimeout(r, o.slowMs));
      const bad = check(b);
      if (bad) return json({ ok: false, error: bad });
      return json({
        ok: true, app_id: "A1", team: { id: "T1", name: "Acme" },
        authed_user: { id: "U1", scope: SLACK_USER_SCOPES.join(","), access_token: XOXP, token_type: "user", ...(o.slackToken ?? {}) },
      });
    }
    if (url.pathname === "/slack/api/auth.test") return json({ ok: req.headers.authorization === `Bearer ${XOXP}`, user: "ana", user_id: "U1", team: "Acme" });
    if (url.pathname === "/slack/api/users.info") return json({ ok: true, user: { real_name: "Ana Ruiz", profile: { real_name: "Ana Ruiz" } } });
    if (url.pathname === "/zoom/token") {
      seen.zoomAuthHeader = String(req.headers.authorization ?? "");
      const b = await form(req);
      seen.zoomExchange = b;
      if (b.get("grant_type") !== "authorization_code") return json({ error: "unsupported_grant_type" }, 400);
      const bad = check(b);
      if (bad) return json({ error: "invalid_grant", reason: bad }, 400);
      return json({ access_token: "zoom-access-1", token_type: "bearer", refresh_token: ZOOM_REFRESH, expires_in: 3599, scope: o.zoomScope ?? ZOOM_USER_SCOPES.join(" ") });
    }
    if (url.pathname === "/zoom/v2/users/me") {
      if (req.headers.authorization !== "Bearer zoom-access-1") return json({ code: 124, message: "Invalid access token." }, 401);
      return json({ id: "z1", first_name: "Ana", last_name: "Ruiz", email: "ana@acme.example" });
    }
    json({ error: "not_found" }, 404);
  });
  const port = await listen(server);
  const b = `http://127.0.0.1:${port}`;
  return {
    seen,
    urls: { slackAuthorize: `${b}/slack/authorize`, slackApi: `${b}/slack/api`, zoomAuthorize: `${b}/zoom/authorize`, zoomToken: `${b}/zoom/token`, zoomApi: `${b}/zoom/v2` },
    /** The site's Slack page (site/connect/slack/callback.html), served here; `relay.port` is the loopback port it passes the code to. */
    relayUrl: `${b}/relay`,
    relay,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/**
 * Pako's side: the panel's real save (src/connections-panel.ts, into a temporary folder's secrets.json, never ~/.pako) and the connect routes,
 * on 127.0.0.1 or on another address of this computer.
 */
async function pako(urls: ConnectSetupDeps["urls"], o: { host?: string; readers?: Partial<ConnectSetupDeps> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pako-connect-"));
  const restarts: number[] = [];
  const app = express();
  const saver = mountConnectionsPanel(app, {
    signedIn: auth.signedIn, env: { PAKO_HOME: dir, PAKO_SECRET_STORE: "file" }, lang: () => "en", dir, fromStore: () => new Set<string>(),
    restart: () => void restarts.push(Date.now()),
  });
  mountConnectSetup(app, { ...auth, lang: () => "en", saver, urls, downloads: dir, ...(o.readers ?? {}) });
  const server = createServer(app);
  const port = await listen(server, o.host ?? "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;
  const call = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${base}${path}`, init);
    const text = await r.text();
    let body: Record<string, any> | string = text;
    try {
      body = JSON.parse(text) as Record<string, any>;
    } catch {
      /* a page */
    }
    return { status: r.status, body: body as Record<string, any> };
  };
  return {
    dir, port, base, restarts,
    get: (path: string) => call(path, { headers: { cookie: "ok=1" } }),
    post: (path: string, body: unknown) => call(path, { method: "POST", headers: { ...PANEL, "content-type": "application/json" }, body: JSON.stringify(body) }),
    close: () => new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    }),
  };
}

/** A GET with a Host header of our choosing (fetch never lets a caller set it). The status. */
const rawGet = (address: string, port: number, path: string, host: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const r = httpGet({ host: address, port, path, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    r.on("error", reject);
  });

/** What the person's browser does after Connect: open the Allow page, which sends it back to Pako; the page Pako shows. */
async function browse(authorizeUrl: string): Promise<{ status: number; text: string; url: string }> {
  const allow = await fetch(authorizeUrl, { redirect: "manual" });
  const back = allow.headers.get("location")!;
  const r = await fetch(back);
  return { status: r.status, text: await r.text(), url: back };
}

test("Slack's Create link carries a PKCE app with user scopes only, this computer's localhost redirect and no Socket Mode", () => {
  const redirect = redirectUri("slack", 8787);
  assert.equal(redirect, "http://localhost:8787/connect/slack/callback");
  const url = new URL(slackCreateUrl(redirect));
  assert.equal(url.origin + url.pathname, "https://api.slack.com/apps");
  assert.equal(url.searchParams.get("new_app"), "1");
  assert.deepEqual(JSON.parse(url.searchParams.get("manifest_json")!), slackManifest(redirect));
  const m = JSON.parse(url.searchParams.get("manifest_json")!) as Record<string, any>;
  assert.equal(m.oauth_config.pkce_enabled, true);
  assert.deepEqual(m.oauth_config.redirect_urls, [redirect]);
  assert.deepEqual(m.oauth_config.scopes.user, SLACK_USER_SCOPES);
  assert.ok(!m.oauth_config.scopes.bot, "no bot: a desktop redirect may not ask for one, and nothing writes");
  assert.equal(m.settings.socket_mode_enabled, false, "no app-level token to copy");
  assert.equal(m.settings.token_rotation_enabled, false, "a token that does not expire");
});

test("Zoom's manifest: a user-level General app with PKCE, the 127.0.0.1 redirect and the read scopes", () => {
  const redirect = redirectUri("zoom", 8787);
  assert.equal(redirect, "http://127.0.0.1:8787/connect/zoom/callback", "Zoom refuses localhost and takes 127.0.0.1 at any port");
  const m = zoomManifest(redirect) as Record<string, any>;
  assert.equal(m.oauth_information.usage, "USER_OPERATION");
  assert.equal(m.oauth_information.development_redirect_uri, redirect);
  assert.deepEqual(m.oauth_information.oauth_allow_list, [redirect]);
  assert.deepEqual(m.oauth_information.scopes.map((s: { scope: string }) => s.scope), ZOOM_USER_SCOPES);
  assert.ok(ZOOM_USER_SCOPES.every((s) => !s.endsWith(":admin")), "the person's own data, not the account's");
  assert.equal(m.oauth_information.enable_private_pkce_client, true);
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, s256(verifier));
});

test("Slack: Connect, Allow, and Pako keeps the user token by itself; the card says who and where", async () => {
  const v = await fakeVendors();
  const p = await pako(v.urls);
  try {
    const setup = await p.get("/panel/api/slack/setup");
    assert.equal(setup.body.redirectUri, `http://localhost:${p.port}/connect/slack/callback`, "the port Pako answers on");
    assert.equal((await p.get("/panel/api/slack/account")).body.state, "off");
    const wrong = await p.post("/panel/api/slack/connect", { clientId: "xoxp-not-an-id" });
    assert.equal(wrong.status, 400);
    assert.match(String(wrong.body.error), /Client ID/);
    const started = await p.post("/panel/api/slack/connect", { clientId: SLACK_CLIENT });
    assert.equal(started.body.ok, true);
    const a = new URL(started.body.authorizeUrl);
    assert.equal(a.searchParams.get("code_challenge_method"), "S256");
    assert.equal(a.searchParams.get("user_scope"), SLACK_USER_SCOPES.join(","));
    assert.equal(a.searchParams.get("scope"), "", "no bot scopes");
    assert.equal((await p.get("/panel/api/slack/account")).body.state, "waiting");

    const page = await browse(started.body.authorizeUrl);
    assert.equal(page.status, 200);
    assert.match(page.text, /Connected as Ana Ruiz in Acme/);
    assert.equal(v.seen.slackExchange?.has("client_secret"), false, "no secret anywhere");
    assert.ok(v.seen.slackExchange?.get("code_verifier"), "the verifier, which only Pako had");
    assert.deepEqual(readStored(p.dir), { SLACK_USER_TOKEN: XOXP, SLACK_CLIENT_ID: SLACK_CLIENT }, "kept in the panel's store");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(p.restarts.length, 1, "Pako restarts so Slack reads the token");
    assert.deepEqual((await p.get("/panel/api/slack/account")).body, { state: "connected", account: { user: "Ana Ruiz", team: "Acme" } });

    // The same link again (a reload, or someone replaying it): the state worked once.
    const again = await fetch(page.url);
    assert.equal(again.status, 400);
    assert.match(await again.text(), /expired or was already used/);
  } finally {
    await p.close();
    await v.close();
  }
});

test("after the restart, the account comes from the running Slack and Zoom readers", async () => {
  const v = await fakeVendors();
  const p = await pako(v.urls, {
    readers: { slackAccount: async () => ({ user: "Ana Ruiz", team: "Acme" }), zoomAccount: () => null },
  });
  try {
    assert.deepEqual((await p.get("/panel/api/slack/account")).body, { state: "connected", account: { user: "Ana Ruiz", team: "Acme" } });
    assert.deepEqual((await p.get("/panel/api/zoom/account")).body, { state: "off" });
    const down = await pako(v.urls, { readers: { slackAccount: async () => null } });
    assert.deepEqual((await down.get("/panel/api/slack/account")).body, { state: "unreachable" });
    await down.close();
  } finally {
    await p.close();
    await v.close();
  }
});

test("a Cancel on Slack's page keeps nothing and says so; the card shows it", async () => {
  const v = await fakeVendors({ refuse: true });
  const p = await pako(v.urls);
  try {
    const started = await p.post("/panel/api/slack/connect", { clientId: SLACK_CLIENT });
    const page = await browse(started.body.authorizeUrl);
    assert.match(page.text, /pressed Cancel/);
    assert.deepEqual(readStored(p.dir), {});
    const acc = await p.get("/panel/api/slack/account");
    assert.equal(acc.body.state, "failed");
    assert.match(acc.body.error, /Cancel/);
    assert.equal(p.restarts.length, 0);
  } finally {
    await p.close();
    await v.close();
  }
});

test("the state is checked: a made-up one, another service's and a reused one are refused, and nothing is exchanged", async () => {
  const v = await fakeVendors();
  const p = await pako(v.urls);
  try {
    const forged = await fetch(`${p.base}/connect/slack/callback?code=code-1&state=made-up`);
    assert.equal(forged.status, 400);
    const z = await p.post("/panel/api/zoom/connect", { clientId: ZOOM_CLIENT });
    const zoomState = new URL(z.body.authorizeUrl).searchParams.get("state")!;
    assert.equal((await fetch(`${p.base}/connect/slack/callback?code=code-1&state=${zoomState}`)).status, 400, "Zoom's state at Slack's door");
    assert.equal(v.seen.slackExchange, null, "nothing was sent to Slack");
    assert.deepEqual(readStored(p.dir), {});
  } finally {
    await p.close();
    await v.close();
  }
});

test("the callback answers only on this computer: another Host name, or another address of this computer, is refused", async () => {
  const v = await fakeVendors();
  const p = await pako(v.urls, { host: "0.0.0.0" });
  try {
    const started = await p.post("/panel/api/slack/connect", { clientId: SLACK_CLIENT });
    const state = new URL(started.body.authorizeUrl).searchParams.get("state")!;
    // DNS rebinding: a site's own name pointed at this computer.
    assert.equal(await rawGet("127.0.0.1", p.port, `/connect/slack/callback?code=x&state=${state}`, `evil.example:${p.port}`), 403);
    // The network: this computer's own non-loopback address, when it has one.
    const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    if (lan) {
      const status = await rawGet(lan, p.port, `/connect/slack/callback?code=x&state=${state}`, `127.0.0.1:${p.port}`);
      assert.equal(status, 403, "only from this computer's loopback");
    }
    assert.equal(v.seen.slackExchange, null);
    // The real flow still works after those refusals: the state was not used up by them.
    const page = await browse(started.body.authorizeUrl);
    assert.match(page.text, /Connected as Ana Ruiz/);
  } finally {
    await p.close();
    await v.close();
  }
});

test("Slack: a token that rotates, or an app missing a scope, is refused with what to do", async () => {
  for (const [token, said] of [
    [{ refresh_token: "xoxe-1-abc", expires_in: 43200 }, /token rotation on/],
    [{ scope: "im:history,users:read" }, /missing some permissions .*search:read/],
  ] as const) {
    const v = await fakeVendors({ slackToken: token });
    const p = await pako(v.urls);
    try {
      const started = await p.post("/panel/api/slack/connect", { clientId: SLACK_CLIENT });
      const page = await browse(started.body.authorizeUrl);
      assert.match(page.text, said);
      assert.deepEqual(readStored(p.dir), {});
    } finally {
      await p.close();
      await v.close();
    }
  }
});

test("Zoom: the manifest file, Connect, Allow, and Pako keeps the refresh token; no secret, no Authorization header", async () => {
  const v = await fakeVendors();
  const p = await pako(v.urls);
  try {
    const setup = await p.get("/panel/api/zoom/setup");
    assert.equal(setup.body.redirectUri, `http://127.0.0.1:${p.port}/connect/zoom/callback`);
    const file = await fetch(`${p.base}${setup.body.manifestUrl}`, { headers: { cookie: "ok=1" } });
    assert.match(String(file.headers.get("content-disposition")), /attachment; filename="pako-zoom-app.json"/);
    assert.equal(((await file.json()) as Record<string, any>).oauth_information.development_redirect_uri, setup.body.redirectUri);
    assert.equal((await fetch(`${p.base}${setup.body.manifestUrl}`)).status, 401, "the panel's own");
    // "Save the app file": the same manifest, written into the Downloads folder (a temporary one here).
    const savedFile = await p.post("/panel/api/zoom/manifest", {});
    assert.equal(savedFile.body.ok, true);
    assert.equal(JSON.parse(readFileSync(join(p.dir, "pako-zoom-app.json"), "utf8")).oauth_information.usage, "USER_OPERATION");
    assert.equal((await p.post("/panel/api/zoom/connect", { clientId: "a b" })).status, 400);

    const started = await p.post("/panel/api/zoom/connect", { clientId: ZOOM_CLIENT });
    const a = new URL(started.body.authorizeUrl);
    assert.equal(a.searchParams.get("response_type"), "code");
    assert.equal(a.searchParams.get("code_challenge_method"), "S256");
    const page = await browse(started.body.authorizeUrl);
    assert.match(page.text, /Connected as Ana Ruiz \(ana@acme\.example\)/);
    assert.equal(v.seen.zoomAuthHeader, "", "a public client sends no Authorization header");
    assert.equal(v.seen.zoomExchange?.get("client_id"), ZOOM_CLIENT);
    assert.deepEqual(readStored(p.dir), { ZOOM_CLIENT_ID: ZOOM_CLIENT, ZOOM_REFRESH_TOKEN: ZOOM_REFRESH, ZOOM_USER: "ana@acme.example" });
    assert.deepEqual((await p.get("/panel/api/zoom/account")).body, { state: "connected", account: { user: "Ana Ruiz", email: "ana@acme.example" } });
  } finally {
    await p.close();
    await v.close();
  }
});

test("Zoom: an app missing a summary scope is refused before anything is kept", async () => {
  const v = await fakeVendors({ zoomScope: "meeting:read:list_meetings user:read:user" });
  const p = await pako(v.urls);
  try {
    const started = await p.post("/panel/api/zoom/connect", { clientId: ZOOM_CLIENT });
    const page = await browse(started.body.authorizeUrl);
    assert.match(page.text, /meeting:read:summary/);
    assert.deepEqual(readStored(p.dir), {});
    assert.equal((await p.get("/panel/api/zoom/account")).body.state, "failed");
  } finally {
    await p.close();
    await v.close();
  }
});

test("on a server the connect routes answer 404, the callbacks included", async () => {
  const app = express();
  mountConnectSetup(app, null);
  const server = createServer(app);
  const port = await listen(server);
  try {
    for (const path of ["/panel/api/slack/setup", "/panel/api/zoom/setup", "/panel/api/zoom/manifest", "/connect/slack/callback", "/connect/zoom/callback"]) {
      assert.equal((await fetch(`http://127.0.0.1:${port}${path}`)).status, 404, path);
    }
  } finally {
    server.close();
  }
});

// ---------- the project's own apps: one button ----------

const NONE: BuiltInDefaults = { slack: "", zoom: "", microsoft: "", google: "", googleSecret: "", gmail: false };
const BUILT_IN: BuiltInDefaults = { ...NONE, slack: "1111111111.2222222222", zoom: "BuiltInZoom_0123" };

test("the built-in clients: empty by default, a well-formed one counts, an environment value wins", () => {
  assert.deepEqual(builtInClients({}, NONE), { slack: null, zoom: null, microsoft: null, google: null, gmail: false });
  assert.deepEqual(builtInClients({}), { slack: SLACK_CLIENT_ID, zoom: null, microsoft: null, google: null, gmail: false }, "the project's Slack app");
  assert.match(SLACK_CLIENT_ID, /^\d{5,20}\.\d{5,20}$/);
  assert.match(SLACK_RELAY_REDIRECT, /^https:\/\//, "Slack installs an app in other workspaces only with https redirects");
  const c = builtInClients({ PAKO_SLACK_CLIENT_ID: "3333333333.4444444444" }, BUILT_IN);
  assert.equal(c.slack, "3333333333.4444444444", "the environment wins over the built-in one");
  assert.equal(c.zoom, "BuiltInZoom_0123");
  assert.equal(builtInClients({ PAKO_SLACK_CLIENT_ID: "not an id" }, NONE).slack, null);
  const g = builtInClients({ PAKO_GOOGLE_CLIENT_ID: "123-abcdefghij.apps.googleusercontent.com", PAKO_GOOGLE_CLIENT_SECRET: "GOCSPX-x" }, NONE);
  assert.deepEqual(g.google, { id: "123-abcdefghij.apps.googleusercontent.com", secret: "GOCSPX-x" });
  assert.equal(g.gmail, false, "Gmail's restricted scope is off until Google allows it");
});

test("Slack with the project's app: one Connect, Allow, done; back through the https page to the fixed loopback port; no Client ID typed", async () => {
  const v = await fakeVendors();
  v.relay.port = await freePort();
  const p = await pako(v.urls, { readers: { defaults: BUILT_IN, env: {}, slackPort: v.relay.port, slackRelay: v.relayUrl } });
  try {
    assert.deepEqual((await p.get("/panel/api/connect/clients")).body, { slack: true, zoom: true, microsoft: false, google: false, gmail: false });
    assert.equal((await p.get("/panel/api/slack/setup")).body.builtIn, true);
    const started = await p.post("/panel/api/slack/connect", {});
    assert.equal(started.body.ok, true);
    const a = new URL(started.body.authorizeUrl);
    assert.equal(a.searchParams.get("client_id"), BUILT_IN.slack);
    assert.equal(a.searchParams.get("redirect_uri"), v.relayUrl, "the project's app returns to its https page, which Slack requires");
    const page = await browse(started.body.authorizeUrl);
    assert.match(page.text, /Connected as Ana Ruiz in Acme/);
    assert.deepEqual(readStored(p.dir), { SLACK_USER_TOKEN: XOXP, SLACK_CLIENT_ID: BUILT_IN.slack });
    // The person's own app still works beside it (Advanced): a typed Client ID returns to this Pako's own port.
    const own = await p.post("/panel/api/slack/connect", { clientId: SLACK_CLIENT });
    assert.equal(new URL(new URL(own.body.authorizeUrl).searchParams.get("redirect_uri")!).port, String(p.port));
  } finally {
    await p.close();
    await v.close();
  }
});

test("Zoom with the project's app: one Connect, Allow, done", async () => {
  const v = await fakeVendors();
  const p = await pako(v.urls, { readers: { defaults: BUILT_IN, env: {} } });
  try {
    assert.equal((await p.get("/panel/api/zoom/setup")).body.builtIn, true);
    const started = await p.post("/panel/api/zoom/connect", {});
    assert.equal(new URL(started.body.authorizeUrl).searchParams.get("client_id"), BUILT_IN.zoom);
    assert.match((await browse(started.body.authorizeUrl)).text, /Connected as Ana Ruiz \(ana@acme\.example\)/);
    assert.equal(readStored(p.dir)!.ZOOM_CLIENT_ID, BUILT_IN.zoom);
  } finally {
    await p.close();
    await v.close();
  }
});

test("without a built-in app the own-app way is the one offered, and Connect with no Client ID says so", async () => {
  const v = await fakeVendors();
  const p = await pako(v.urls, { readers: { defaults: NONE, env: {} } });
  try {
    assert.deepEqual((await p.get("/panel/api/connect/clients")).body, { slack: false, zoom: false, microsoft: false, google: false, gmail: false });
    assert.equal((await p.get("/panel/api/slack/setup")).body.builtIn, false);
    const r = await p.post("/panel/api/slack/connect", {});
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Advanced: use your own app/);
    const env = await pako(v.urls, { readers: { defaults: NONE, env: { PAKO_ZOOM_CLIENT_ID: "FromTheEnv_0123" } } });
    assert.equal((await env.get("/panel/api/connect/clients")).body.zoom, true, "an environment value makes it one button");
    await env.close();
  } finally {
    await p.close();
    await v.close();
  }
});

test("Slack connected again with the same token (Slack gives the same one back): connected, not \"couldn't keep the sign-in\"", async () => {
  const v = await fakeVendors();
  const p = await pako(v.urls);
  try {
    assert.ok(writeStored(p.dir, { SLACK_USER_TOKEN: XOXP, SLACK_CLIENT_ID: SLACK_CLIENT }), "connected before, with this app");
    const started = await p.post("/panel/api/slack/connect", { clientId: SLACK_CLIENT });
    const page = await browse(started.body.authorizeUrl);
    assert.doesNotMatch(page.text, /couldn't keep/);
    assert.match(page.text, /Connected as Ana Ruiz in Acme/);
    assert.deepEqual((await p.get("/panel/api/slack/account")).body, { state: "connected", account: { user: "Ana Ruiz", team: "Acme" } });
    assert.deepEqual(readStored(p.dir), { SLACK_USER_TOKEN: XOXP, SLACK_CLIENT_ID: SLACK_CLIENT });
  } finally {
    await p.close();
    await v.close();
  }
});

test("while the code is being exchanged the card is still waiting, not the old account the running reader still has", async () => {
  // Connecting again over a working connection (another workspace, a missing scope added): the reader still says the old account.
  const v = await fakeVendors({ slowMs: 400, slackToken: { scope: "im:history" } });
  const p = await pako(v.urls, { readers: { slackAccount: async () => ({ user: "Old Name", team: "Old Co" }) } });
  try {
    const started = await p.post("/panel/api/slack/connect", { clientId: SLACK_CLIENT });
    const allow = await fetch(started.body.authorizeUrl, { redirect: "manual" });
    const back = fetch(allow.headers.get("location")!).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 150));
    const mid = await p.get("/panel/api/slack/account");
    assert.match(await back, /missing some permissions/);
    assert.deepEqual(mid.body, { state: "waiting" }, "mid-exchange: still waiting");
    const after = await p.get("/panel/api/slack/account");
    assert.equal(after.body.state, "failed", "and then how it went");
  } finally {
    await p.close();
    await v.close();
  }
});

test("the Slack loopback listener closes once the browser came back, instead of holding its port for a quarter of an hour", async () => {
  const v = await fakeVendors();
  v.relay.port = await freePort();
  const p = await pako(v.urls, { readers: { defaults: BUILT_IN, env: {}, slackPort: v.relay.port, slackRelay: v.relayUrl } });
  try {
    const started = await p.post("/panel/api/slack/connect", {});
    const back = new URL(`http://localhost:${v.relay.port}/connect/slack/callback`);
    const page = await browse(started.body.authorizeUrl);
    assert.match(page.text, /Connected as/);
    await new Promise((r) => setTimeout(r, 100));
    const after = await fetch(`http://127.0.0.1:${back.port}${back.pathname}`).then((r) => r.status, (e: Error) => (e.cause as { code?: string })?.code ?? e.message);
    assert.equal(after, "ECONNREFUSED", "nothing listens on the port any more");
    // And the next Connect opens it again.
    const again = await p.post("/panel/api/slack/connect", {});
    assert.equal(again.body.ok, true);
    assert.equal((await fetch(`http://127.0.0.1:${v.relay.port}/elsewhere`)).status, 404, "listening again");
  } finally {
    await p.close();
    await v.close();
  }
});

test("the site's Slack page passes only a real sign-in on, and only to Pako on this computer", () => {
  const to = (search: string) => {
    const t = relayTarget(search);
    if (!t) return null;
    const u = new URL(t);
    return { at: `${u.origin}${u.pathname}`, q: Object.fromEntries(u.searchParams) };
  };
  const at = "http://localhost:53682/connect/slack/callback";
  assert.deepEqual(to("?code=abc.123-x&state=St4te_~"), { at, q: { code: "abc.123-x", state: "St4te_~" } });
  assert.deepEqual(to("?error=access_denied&state=s1"), { at, q: { state: "s1", error: "access_denied" } });
  assert.deepEqual(to("?code=abc&state=s1&next=https://evil.example"), { at, q: { code: "abc", state: "s1" } }, "anything else is dropped");
  for (const bad of ["", "?code=abc", "?state=s1", "?code=%3Cscript%3E&state=s1", `?code=${"a".repeat(600)}&state=s1`]) {
    assert.equal(relayTarget(bad), null, bad);
  }
  assert.match(SLACK_PAGE, /content="no-referrer"/, "the code is not sent on as a referrer");
  assert.doesNotMatch(SLACK_PAGE, /fetch\(|XMLHttpRequest|localStorage|sessionStorage|<script src/, "the page keeps and sends nothing");
});
