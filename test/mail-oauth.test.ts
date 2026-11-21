// Mail from Microsoft and Google by signing in with the provider (src/mail-oauth.ts), against a fake Microsoft and a fake Google on this
// computer:
// - the code is exchanged with the PKCE verifier (and Google's installed-app secret only when one is set);
// - the address comes from the ID token;
// - one read-only IMAP login is tried with the new access token (a stub);
// - the mailbox and the refresh token go to the panel's store (a temporary folder).
// Then the token source: a refresh, one at a time, a replaced refresh token kept, a revoked one said as "sign in again". The state, the
// loopback-only callback and a missing client are each refused plainly. Nothing goes to the real Microsoft or Google.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, get as httpGet, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import express from "express";
import { mountConnectionsPanel } from "../src/connections-panel.ts";
import { readStored } from "../src/connections.ts";
import { failKind, type ImapClient, type ImapConfig } from "../src/imap.ts";
import { createTokenSource, mailClients, mountMailOAuth, SignInAgain, type ProviderUrls } from "../src/mail-oauth.ts";
import { auth, PANEL } from "./helpers/connect-rig.ts";
import { eventually } from "./helpers/wait.ts";

const MS_ID = "11111111-2222-3333-4444-555555555555";
const G_ID = "1234567890-abcdefghij.apps.googleusercontent.com";
const G_SECRET = "GOCSPX-installed-app-secret";

const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");
const form = (req: IncomingMessage): Promise<URLSearchParams> =>
  new Promise((r) => {
    let b = "";
    req.on("data", (c: Buffer) => (b += c.toString("utf8")));
    req.on("end", () => r(new URLSearchParams(b)));
  });
const listen = async (s: Server): Promise<number> => {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return (s.address() as AddressInfo).port;
};
const jwt = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

/** A fake Microsoft and Google: the Allow page, and the token endpoint checking the code, redirect, verifier and secret, and refreshing. */
async function fakeProviders(o: { refuse?: boolean; revoked?: boolean } = {}) {
  const seen = { exchanges: [] as URLSearchParams[], refreshes: [] as URLSearchParams[], authorize: [] as URLSearchParams[] };
  const codes = new Map<string, { challenge: string; redirect: string; client: string; provider: string }>();
  let refreshN = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const json = (v: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
    const provider = url.pathname.split("/")[1]!;
    if (url.pathname.endsWith("/authorize")) {
      const q = url.searchParams;
      seen.authorize.push(q);
      const back = new URL(q.get("redirect_uri")!);
      back.searchParams.set("state", q.get("state")!);
      if (o.refuse) back.searchParams.set("error", "access_denied");
      else {
        const code = `M.C${codes.size + 1}_BAY.code`;
        codes.set(code, { challenge: q.get("code_challenge")!, redirect: q.get("redirect_uri")!, client: q.get("client_id")!, provider });
        back.searchParams.set("code", code);
      }
      return void res.writeHead(302, { location: back.href }).end();
    }
    if (url.pathname.endsWith("/token")) {
      const b = await form(req);
      if (b.get("grant_type") === "refresh_token") {
        seen.refreshes.push(b);
        if (o.revoked) return json({ error: "invalid_grant", error_description: "AADSTS70008: expired" }, 400);
        refreshN++;
        await new Promise((r) => setTimeout(r, 20));
        return json({ access_token: `access-r${refreshN}`, expires_in: 3600, ...(provider === "microsoft" ? { refresh_token: `refresh-r${refreshN}-rotated` } : {}) });
      }
      seen.exchanges.push(b);
      const c = codes.get(b.get("code") ?? "");
      if (!c || c.provider !== provider) return json({ error: "invalid_grant" }, 400);
      if (b.get("redirect_uri") !== c.redirect || b.get("client_id") !== c.client) return json({ error: "invalid_request" }, 400);
      if (s256(b.get("code_verifier") ?? "") !== c.challenge) return json({ error: "invalid_grant", error_description: "PKCE" }, 400);
      if (provider === "microsoft" && b.has("client_secret")) return json({ error: "invalid_request", error_description: "public client" }, 400);
      codes.delete(b.get("code")!);
      const email = provider === "microsoft" ? "ana@outlook.example" : "ana@gmail.example";
      return json({
        access_token: `access-${provider}`, refresh_token: `refresh-${provider}-0123456789`, expires_in: 3599, token_type: "Bearer",
        id_token: jwt(provider === "microsoft" ? { preferred_username: email, tid: "9188040d" } : { email, email_verified: true }),
      });
    }
    if (url.pathname === "/calendar/users/me/calendarList") {
      return req.headers.authorization === "Bearer access-google" ? json({ items: [{ id: "primary", summary: "Ana", primary: true }] }) : json({ error: { message: "no" } }, 401);
    }
    json({ error: "not_found" }, 404);
  });
  const port = await listen(server);
  const b = `http://127.0.0.1:${port}`;
  const urls: ProviderUrls = {
    microsoft: { authorize: `${b}/microsoft/authorize`, token: `${b}/microsoft/token` },
    google: { authorize: `${b}/google/authorize`, token: `${b}/google/token` },
  };
  return { seen, urls, calendarApi: `${b}/calendar`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** A stub IMAP client: the login it was given, accepted or refused. */
function stubImap(refuse = false) {
  const logins: ImapConfig[] = [];
  const connect = (c: ImapConfig): ImapClient => {
    logins.push(c);
    return {
      connect: async () => {
        if (refuse) throw Object.assign(new Error("no"), { authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" });
      },
      mailboxOpen: async () => ({ uidValidity: 1 }), search: async () => [], fetchOne: async () => false, logout: async () => {}, close: () => {},
      on: () => undefined,
    };
  };
  return { logins, connect };
}

async function pako(env: Record<string, string>, urls: ProviderUrls, connect: ReturnType<typeof stubImap>["connect"], calendarApi?: string) {
  const dir = mkdtempSync(join(tmpdir(), "pako-mailoauth-"));
  const restarts: number[] = [];
  const app = express();
  const saver = mountConnectionsPanel(app, {
    signedIn: auth.signedIn, env: { PAKO_HOME: dir, ...env }, lang: () => "en", dir, fromStore: () => new Set<string>(),
    restart: () => void restarts.push(Date.now()),
  });
  mountMailOAuth(app, { ...auth, env, saver, urls, connect, ...(calendarApi ? { calendarApi } : {}) });
  const server = createServer(app);
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const call = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${base}${path}`, init);
    const t = await r.text();
    let body: Record<string, any> | string = t;
    try {
      body = JSON.parse(t) as Record<string, any>;
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

async function browse(authorizeUrl: string): Promise<{ status: number; text: string; url: string }> {
  const allow = await fetch(authorizeUrl, { redirect: "manual" });
  const back = allow.headers.get("location")!;
  const r = await fetch(back);
  return { status: r.status, text: await r.text(), url: back };
}

const ENV = { PAKO_MS_CLIENT_ID: MS_ID, PAKO_GOOGLE_CLIENT_ID: G_ID, PAKO_GOOGLE_CLIENT_SECRET: G_SECRET, PAKO_GOOGLE_GMAIL: "on" };

test("the clients: only a real-looking ID counts, and none is set by default (the project registers its own)", () => {
  assert.deepEqual(mailClients({}), { microsoft: null, google: null });
  assert.deepEqual(mailClients(ENV), { microsoft: { id: MS_ID }, google: { id: G_ID, secret: G_SECRET } });
  assert.equal(mailClients({ ...ENV, PAKO_GOOGLE_GMAIL: "" }).google, null, "Gmail's restricted scope only once Google allows it: the app password then");
  assert.deepEqual(mailClients({ PAKO_MS_CLIENT_ID: "not-a-guid", PAKO_GOOGLE_CLIENT_ID: "x" }), { microsoft: null, google: null });
});

test("Microsoft: sign in, the code exchanged with PKCE and no secret, one XOAUTH2 login, the mailbox kept; the card says connected", async () => {
  const v = await fakeProviders();
  const imap = stubImap();
  const p = await pako(ENV, v.urls, imap.connect);
  try {
    assert.deepEqual((await p.get("/panel/api/mail/oauth")).body, { microsoft: true, google: true });
    const started = await p.post("/panel/api/mail/oauth/start", { provider: "microsoft", address: "Ana@Outlook.example" });
    const a = new URL(started.body.authorizeUrl);
    assert.equal(a.searchParams.get("code_challenge_method"), "S256");
    // One Allow consents to the mailbox and the calendar (for the calendar writes); the code is then exchanged for the mailbox's token.
    assert.equal(a.searchParams.get("scope"),
      "https://outlook.office.com/IMAP.AccessAsUser.All https://graph.microsoft.com/Calendars.ReadWrite offline_access openid email");
    assert.equal(a.searchParams.get("redirect_uri"), `http://127.0.0.1:${p.port}/connect/microsoft/callback`);
    assert.equal(a.searchParams.get("login_hint"), "ana@outlook.example");
    assert.equal((await p.get("/panel/api/mail/oauth/account")).body.state, "waiting");
    const page = await browse(started.body.authorizeUrl);
    assert.match(page.text, /Connected: Pako now reads ana@outlook\.example/);
    assert.equal(v.seen.exchanges[0]!.has("client_secret"), false);
    assert.equal(v.seen.exchanges[0]!.get("scope"), "https://outlook.office.com/IMAP.AccessAsUser.All offline_access openid email");
    assert.deepEqual(imap.logins.map((l) => [l.host, l.user, l.accessToken, l.password]), [["outlook.office365.com", "ana@outlook.example", "access-microsoft", ""]]);
    assert.deepEqual(readStored(p.dir), {
      IMAP_HOST: "outlook.office365.com", IMAP_USER: "ana@outlook.example", IMAP_OAUTH: "microsoft", IMAP_REFRESH_TOKEN: "refresh-microsoft-0123456789",
    });
    assert.deepEqual((await p.get("/panel/api/mail/oauth/account")).body, { state: "connected", account: { user: "ana@outlook.example", provider: "microsoft" } });
    await eventually(() => p.restarts.length >= 1, { then: 50 });
    assert.equal(p.restarts.length, 1);
    assert.equal((await fetch(page.url)).status, 400, "the state worked once");
  } finally {
    await p.close();
    await v.close();
  }
});

test("Google: offline access at a consent screen, the installed app's secret sent, the address from the ID token", async () => {
  const v = await fakeProviders();
  const imap = stubImap();
  const p = await pako(ENV, v.urls, imap.connect);
  try {
    const started = await p.post("/panel/api/mail/oauth/start", { provider: "google" });
    const a = new URL(started.body.authorizeUrl);
    assert.equal(a.searchParams.get("access_type"), "offline");
    assert.equal(a.searchParams.get("prompt"), "consent");
    assert.equal(a.searchParams.get("scope"), "https://mail.google.com/ openid email");
    const page = await browse(started.body.authorizeUrl);
    assert.match(page.text, /ana@gmail\.example/);
    assert.equal(v.seen.exchanges[0]!.get("client_secret"), G_SECRET);
    assert.equal(readStored(p.dir)!.IMAP_HOST, "imap.gmail.com");
    assert.equal(readStored(p.dir)!.IMAP_OAUTH, "google");
  } finally {
    await p.close();
    await v.close();
  }
});

test("refused plainly: no client registered, a Cancel, a forged or reused state, another provider's state, the mailbox refusing IMAP", async () => {
  const v = await fakeProviders();
  const none = await pako({}, v.urls, stubImap().connect);
  try {
    const r = await none.post("/panel/api/mail/oauth/start", { provider: "microsoft" });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /isn't set up in this Pako yet/);
    assert.deepEqual((await none.get("/panel/api/mail/oauth")).body, { microsoft: false, google: false });
  } finally {
    await none.close();
  }
  const imap = stubImap();
  const p = await pako(ENV, v.urls, imap.connect);
  try {
    assert.equal((await fetch(`${p.base}/connect/microsoft/callback?code=x&state=forged`)).status, 400);
    const g = await p.post("/panel/api/mail/oauth/start", { provider: "google" });
    const gState = new URL(g.body.authorizeUrl).searchParams.get("state")!;
    assert.equal((await fetch(`${p.base}/connect/microsoft/callback?code=x&state=${gState}`)).status, 400, "Google's state at Microsoft's door");
    assert.equal(v.seen.exchanges.length, 0);
    assert.deepEqual(readStored(p.dir), {});
  } finally {
    await p.close();
  }
  const refusing = await fakeProviders({ refuse: true });
  const c = await pako(ENV, refusing.urls, stubImap().connect);
  try {
    const started = await c.post("/panel/api/mail/oauth/start", { provider: "microsoft" });
    assert.match((await browse(started.body.authorizeUrl)).text, /didn't allow it/);
    assert.equal((await c.get("/panel/api/mail/oauth/account")).body.state, "failed");
  } finally {
    await c.close();
    await refusing.close();
  }
  const noImap = await pako(ENV, v.urls, stubImap(true).connect);
  try {
    const started = await noImap.post("/panel/api/mail/oauth/start", { provider: "microsoft" });
    assert.match((await browse(started.body.authorizeUrl)).text, /refused to open the mailbox .*admin may have turned IMAP off/);
    assert.deepEqual(readStored(noImap.dir), {}, "nothing kept when the mailbox cannot be read");
  } finally {
    await noImap.close();
    await v.close();
  }
});

test("the callback answers only on this computer's own name", async () => {
  const v = await fakeProviders();
  const p = await pako(ENV, v.urls, stubImap().connect);
  try {
    const started = await p.post("/panel/api/mail/oauth/start", { provider: "microsoft" });
    const state = new URL(started.body.authorizeUrl).searchParams.get("state")!;
    const status = await new Promise<number>((resolve, reject) => {
      httpGet({ host: "127.0.0.1", port: p.port, path: `/connect/microsoft/callback?code=x&state=${state}`, headers: { host: `evil.example:${p.port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on("error", reject);
    });
    assert.equal(status, 403);
    assert.match((await browse(started.body.authorizeUrl)).text, /Connected/, "the real way back still works");
  } finally {
    await p.close();
    await v.close();
  }
});

test("the token source: one refresh at a time, Microsoft's replaced refresh token kept, a revoked one is 'sign in again'", async () => {
  const v = await fakeProviders();
  let clock = 1_800_000_000_000;
  const kept: string[] = [];
  const src = createTokenSource({ provider: "microsoft", clientId: MS_ID, refreshToken: "refresh-microsoft-0123456789", keep: (t) => void kept.push(t), urls: v.urls, now: () => clock });
  const [a, b] = await Promise.all([src.access(), src.access()]);
  assert.equal(a, "access-r1");
  assert.equal(b, "access-r1");
  assert.equal(v.seen.refreshes.length, 1);
  assert.equal(v.seen.refreshes[0]!.get("refresh_token"), "refresh-microsoft-0123456789");
  assert.equal(v.seen.refreshes[0]!.has("client_secret"), false);
  assert.deepEqual(kept, ["refresh-r1-rotated"]);
  clock += 3600_000;
  await src.access();
  assert.equal(v.seen.refreshes[1]!.get("refresh_token"), "refresh-r1-rotated", "the replaced token is the one used next");
  await v.close();

  const gone = await fakeProviders({ revoked: true });
  const dead = createTokenSource({ provider: "google", clientId: G_ID, refreshToken: "refresh-google-0123456789", urls: gone.urls });
  await assert.rejects(dead.access(), (err: unknown) => err instanceof SignInAgain && failKind(err) === "signIn");
  await gone.close();
});

test("Google Calendar: one button, the calendar scope, a look at the calendar list, the sign-in kept for the calendar", async () => {
  const v = await fakeProviders();
  // No Gmail allowed: the Google button is the calendar's, and mail by Google sign-in is not offered.
  const p = await pako({ PAKO_GOOGLE_CLIENT_ID: G_ID, PAKO_GOOGLE_CLIENT_SECRET: G_SECRET }, v.urls, stubImap().connect, v.calendarApi);
  try {
    assert.deepEqual((await p.get("/panel/api/mail/oauth")).body, { microsoft: false, google: false });
    const started = await p.post("/panel/api/google/connect", {});
    const a = new URL(started.body.authorizeUrl);
    assert.equal(a.searchParams.get("scope"), "https://www.googleapis.com/auth/calendar.events openid email");
    assert.equal(a.searchParams.get("redirect_uri"), `http://127.0.0.1:${p.port}/connect/google/callback`);
    assert.equal((await p.get("/panel/api/google/account")).body.state, "waiting");
    assert.equal((await p.get("/panel/api/mail/oauth/account")).body.state, "off", "the mail's sign-in is another one");
    const page = await browse(started.body.authorizeUrl);
    assert.match(page.text, /Pako now reads the calendar of ana@gmail\.example/);
    assert.deepEqual(readStored(p.dir), { GOOGLE_REFRESH_TOKEN: "refresh-google-0123456789", GOOGLE_ACCOUNT: "ana@gmail.example" });
    assert.deepEqual((await p.get("/panel/api/google/account")).body, { state: "connected", account: { user: "ana@gmail.example", provider: "google" } });
  } finally {
    await p.close();
  }
  const none = await pako({}, v.urls, stubImap().connect, v.calendarApi);
  try {
    const r = await none.post("/panel/api/google/connect", {});
    assert.equal(r.status, 409);
    assert.match(r.body.error, /private link instead/);
  } finally {
    await none.close();
    await v.close();
  }
});
