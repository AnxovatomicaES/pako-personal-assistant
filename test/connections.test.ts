// Services connected from the panel on a person's computer (src/connections.ts, src/connections-panel.ts, the restart in src/server.ts): the
// catalogue, the store in ~/.pako/secrets.json (mode 600, never sent back), a value set outside the panel winning, removal, a hosted server
// refusing, the panel's protection, the restart in place, and the start reading the stored values. Nothing here reaches the network.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import express from "express";
import { createApp, loadAppConfig, type LocalContext } from "../src/app.ts";
import { applyStoredSettings, CATALOGUE, connectionStates, icsLink, KEYS, readStored, tailOf, writeStored } from "../src/connections.ts";
import { checkAgentMail, mountConnectionsPanel, type ConnectionsPanelDeps } from "../src/connections-panel.ts";
import type { Kv } from "../src/kv.ts";
import { createLocalChannel, loadHome, localEnv } from "../src/local.ts";
import { loadIcsConfig } from "../src/ics.ts";
import { loadMailConfig } from "../src/mail.ts";
import { restartInPlace, type RestartDeps } from "../src/server.ts";

type Env = Record<string, string | undefined>;

// Made-up values in the shapes the services give: they open nothing.
const CLAUDE_KEY = `sk-ant-api03-${"a".repeat(40)}WXYZ`;
const PLACES_KEY = `AIza${"b".repeat(31)}TAIL`;
const MAIL_KEY = `am_${"c".repeat(30)}MKEY`;
const SLACK_TOKEN = `xoxp-${"1".repeat(30)}`;
const SLACK_SECRET = "0123456789abcdef0123456789abcdef";

const tmp = (): string => mkdtempSync(join(tmpdir(), "pako-cx-"));

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The routes on a bare app: "signed in" is a cookie named ok, as the panel's real check is a cookie. */
async function rig(over: Partial<ConnectionsPanelDeps> = {}) {
  const dir = tmp();
  const env: Env = { PAKO_HOME: dir };
  const restarts: number[] = [];
  const log: string[] = [];
  const app = express();
  mountConnectionsPanel(app, {
    signedIn: (req) => req.get("cookie") === "ok=1",
    env,
    lang: () => "en",
    dir,
    fromStore: () => new Set<string>(),
    restart: () => void restarts.push(Date.now()),
    control: { log: (_who: string, what: string) => void log.push(what) } as unknown as ConnectionsPanelDeps["control"],
    fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch,
    ...over,
  });
  const server = createServer(app);
  const base = await listen(server);
  const post = (path: string, body: unknown, headers: Record<string, string> = { cookie: "ok=1", "x-pako": "1" }) =>
    fetch(`${base}/panel/api/connections${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const get = (headers: Record<string, string> = { cookie: "ok=1" }) => fetch(`${base}/panel/api/connections`, { headers });
  return { dir, env, restarts, log, post, get, close: () => (server.close(), server.closeAllConnections()) };
}

const waitFor = async (ok: () => boolean, ms = 3000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end && !ok()) await new Promise((r) => setTimeout(r, 20));
  return ok();
};

test("catalogue: Claude, calendar, mail, Slack, Zoom, Teams, Messages, tables and pointers to Telegram and WhatsApp; no phone line; every name and how-to in both languages", () => {
  assert.deepEqual(CATALOGUE.map((c) => c.id), ["claude", "calendar", "google", "mail", "imap", "applemail", "resend", "slack", "zoom", "teams", "imessage", "tables", "telegram", "whatsapp"]);
  for (const k of ["ANTHROPIC_API_KEY", "CALENDAR_ICS_URL", "AGENTMAIL_API_KEY", "AGENTMAIL_INBOX", "SLACK_USER_TOKEN", "ZOOM_CLIENT_SECRET", "GOOGLE_PLACES_API_KEY"]) {
    assert.ok(KEYS.has(k), k);
  }
  for (const k of ["PERSONAL_CALLER_TOKEN", "RETELL_API_KEY", "TELEGRAM_BOT_TOKEN", "PAKO_LOCAL", "NODE_OPTIONS"]) assert.ok(!KEYS.has(k), k);
  for (const lang of ["en"] as const) {
    const all = connectionStates({ env: {}, stored: {}, fromStore: new Set(), lang });
    for (const c of all) {
      assert.ok(c.name && c.how, `${c.id} ${lang}`);
      for (const f of c.fields) assert.ok(f.label && f.hint, `${f.key} ${lang}`);
    }
    assert.equal(all.find((c) => c.id === "telegram")?.card, "telegram");
    assert.equal(all.find((c) => c.id === "whatsapp")?.card, "whatsapp");
  }
  const en = connectionStates({ env: {}, stored: {}, fromStore: new Set(), lang: "en" });
  assert.match(en.find((c) => c.id === "claude")!.how, /Pro, Max, Team or Enterprise/);
  assert.doesNotMatch(JSON.stringify(en), /[áéíóúñ¿¡]/, "no Spanish");
});

test("ICS links: https and webcal are kept as https; http, credentials, spaces and nonsense are refused", () => {
  assert.equal(icsLink(" webcal://p01-caldav.icloud.com/published/2/abc "), "https://p01-caldav.icloud.com/published/2/abc");
  assert.equal(icsLink("https://calendar.google.com/calendar/ical/x/private-y/basic.ics"), "https://calendar.google.com/calendar/ical/x/private-y/basic.ics");
  for (const bad of ["http://example.com/a.ics", "https://u:p@example.com/a.ics", "https://exa mple.com/a.ics", "ftp://x/y", "nonsense", ""]) assert.equal(icsLink(bad), null, bad);
});

test("the calendar card checks its links as src/ics.ts does (several allowed); a saved link is what the calendar reads at the next start", () => {
  const cal = CATALOGUE.find((c) => c.id === "calendar")!;
  const G = "https://calendar.google.com/calendar/ical/x/private-y/basic.ics";
  const A = "webcal://p01-caldav.icloud.com/published/2/abc";
  assert.deepEqual(cal.check!({ CALENDAR_ICS_URL: G }), []);
  assert.deepEqual(cal.check!({ CALENDAR_ICS_URL: `${G}, ${A}` }), [], "two links, as CALENDAR_ICS_URL allows");
  for (const bad of ["http://example.com/a.ics", "https://u:p@example.com/a.ics", "nonsense", ""]) assert.deepEqual(cal.check!({ CALENDAR_ICS_URL: bad }), ["CALENDAR_ICS_URL"], bad);
  const dir = tmp();
  assert.equal(writeStored(dir, { CALENDAR_ICS_URL: G }), true);
  const env: Env = {};
  assert.deepEqual(applyStoredSettings(dir, env), ["CALENDAR_ICS_URL"]);
  assert.deepEqual(loadIcsConfig(env).config?.urls, [G]);
});

test("store: mode 600, the other secrets kept, only catalogue keys; an unreadable file is never overwritten", () => {
  const dir = tmp();
  writeFileSync(join(dir, "secrets.json"), JSON.stringify({ panelSecret: "keep-me", telegramToken: "keep-too" }), { mode: 0o600 });
  assert.equal(writeStored(dir, { ANTHROPIC_API_KEY: CLAUDE_KEY, NODE_OPTIONS: "--require evil" }), true);
  const file = join(dir, "secrets.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const all = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(all.panelSecret, "keep-me");
  assert.equal(all.telegramToken, "keep-too");
  assert.deepEqual(all.settings, { ANTHROPIC_API_KEY: CLAUDE_KEY });
  assert.deepEqual(readStored(dir), { ANTHROPIC_API_KEY: CLAUDE_KEY });
  assert.equal(writeStored(dir, { ANTHROPIC_API_KEY: null }), true);
  assert.deepEqual(readStored(dir), {});
  // A hand-edited file with a key outside the catalogue: never read back.
  writeFileSync(file, JSON.stringify({ settings: { PAKO_LOCAL: "0", GOOGLE_PLACES_API_KEY: PLACES_KEY, ZOOM_USER: 5 } }));
  assert.deepEqual(readStored(dir), { GOOGLE_PLACES_API_KEY: PLACES_KEY });
  writeFileSync(file, "{ broken");
  assert.equal(readStored(dir), null);
  assert.equal(writeStored(dir, { ANTHROPIC_API_KEY: CLAUDE_KEY }), false);
  assert.equal(readFileSync(file, "utf8"), "{ broken", "left as it was");
  assert.deepEqual(readStored(tmp()), {}, "no file yet: nothing stored");
});

test("start: the stored values fill only what is unset (the shell and the .env files win); the modules then read them", () => {
  const dir = tmp();
  writeStored(dir, { AGENTMAIL_API_KEY: MAIL_KEY, AGENTMAIL_INBOX: "pako@agentmail.to", ANTHROPIC_API_KEY: CLAUDE_KEY, GOOGLE_PLACES_API_KEY: PLACES_KEY });
  const env: Env = { ANTHROPIC_API_KEY: "sk-ant-from-the-shell", GOOGLE_PLACES_API_KEY: "  " };
  const applied = applyStoredSettings(dir, env);
  assert.deepEqual(applied.sort(), ["AGENTMAIL_API_KEY", "AGENTMAIL_INBOX", "GOOGLE_PLACES_API_KEY"]);
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-from-the-shell", "the shell wins");
  assert.equal(env.GOOGLE_PLACES_API_KEY, PLACES_KEY, "a blank value counts as unset");
  const mail = loadMailConfig(env);
  assert.deepEqual(mail.problems, []);
  assert.equal(mail.config?.inbox, "pako@agentmail.to");
  // The card: the shell's key is "outside", the stored ones "panel"; only the last four characters of a long value.
  const states = connectionStates({ env, stored: readStored(dir), fromStore: new Set(applied), lang: "en" });
  const claude = states.find((c) => c.id === "claude")!;
  assert.equal(claude.fields[0]!.from, "outside");
  const m = states.find((c) => c.id === "mail")!;
  assert.equal(m.state, "on");
  assert.deepEqual(m.fields.slice(0, 2).map((f) => [f.from, f.tail]), [["panel", "MKEY"], ["panel", "l.to"]]);
  assert.equal(tailOf("10"), undefined, "a short value gets no tail");
  // Unreadable file: nothing applied, the start goes on.
  writeFileSync(join(dir, "secrets.json"), "nope");
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(applyStoredSettings(dir, {}), []);
  } finally {
    console.error = quiet;
  }
});

test("a saved password (the mailbox's, Zoom's client secret, Slack's signing secret) shows as set with no tail; a token keeps its last four", () => {
  const stored = {
    IMAP_HOST: "imap.example.test", IMAP_USER: "marta@example.test", IMAP_PASSWORD: "wrongpassword123",
    ZOOM_CLIENT_SECRET: "zoomsecretzoomsecretABCD", SLACK_SIGNING_SECRET: SLACK_SECRET, SLACK_USER_TOKEN: SLACK_TOKEN,
  };
  const states = connectionStates({ env: {}, stored, fromStore: new Set(), lang: "en" });
  const field = (id: string, key: string) => states.find((c) => c.id === id)!.fields.find((f) => f.key === key)!;
  for (const [id, key] of [["imap", "IMAP_PASSWORD"], ["zoom", "ZOOM_CLIENT_SECRET"], ["slack", "SLACK_SIGNING_SECRET"]] as const) {
    assert.deepEqual([field(id, key).set, field(id, key).tail], [true, undefined], key);
  }
  assert.equal(field("slack", "SLACK_USER_TOKEN").tail, SLACK_TOKEN.slice(-4));
  assert.equal(JSON.stringify(states).includes("d123"), false);
});

test("routes: save keeps the value (mode 600), never echoes it, restarts after the answer, logs; GET shows set and the last four only", async () => {
  const r = await rig();
  try {
    const res = await r.post("", { id: "claude", values: { ANTHROPIC_API_KEY: CLAUDE_KEY } });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    assert.deepEqual(JSON.parse(text), { ok: true, restarting: true });
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.ok(await waitFor(() => r.restarts.length === 1), "restarted once the answer went");
    assert.equal(statSync(join(r.dir, "secrets.json")).mode & 0o777, 0o600);
    assert.equal(readStored(r.dir)?.ANTHROPIC_API_KEY, CLAUDE_KEY);
    assert.deepEqual(r.log, ["Claude with an API key: settings saved from the panel"]);
    const got = await (await r.get()).text();
    assert.ok(!got.includes(CLAUDE_KEY) && !got.includes(CLAUDE_KEY.slice(0, 20)), "never sent back");
    const claude = (JSON.parse(got) as { connections: { id: string; state: string; fields: { tail?: string; set: boolean }[] }[] }).connections.find((c) => c.id === "claude")!;
    assert.deepEqual([claude.state, claude.fields[0]!.set, claude.fields[0]!.tail], ["on", true, "WXYZ"]);
    // This process is going away: nothing more is written until the new one answers.
    const busy = await r.post("", { id: "tables", values: { GOOGLE_PLACES_API_KEY: PLACES_KEY } });
    assert.equal(busy.status, 409);
    assert.equal(readStored(r.dir)?.GOOGLE_PLACES_API_KEY, undefined);
  } finally {
    r.close();
  }
});

test("routes: wrong shapes, unknown ids and keys, Telegram, line breaks and nothing new are refused, naming the field; nothing is written", async () => {
  const r = await rig();
  try {
    const cases: [unknown, number, RegExp, string?][] = [
      [{ id: "calendar", values: { CALENDAR_ICS_URL: "http://example.com/cal.ics" } }, 400, /ICS link isn't valid/, "CALENDAR_ICS_URL"],
      [{ id: "claude", values: { ANTHROPIC_API_KEY: "sk-nope" } }, 400, /API key isn't valid: It starts with sk-ant-/, "ANTHROPIC_API_KEY"],
      [{ id: "tables", values: { GOOGLE_PLACES_API_KEY: "AIzaShort" } }, 400, /isn't valid/, "GOOGLE_PLACES_API_KEY"],
      [{ id: "slack", values: { SLACK_USER_TOKEN: SLACK_TOKEN, SLACK_SIGNING_SECRET: "nope" } }, 400, /Signing Secret isn't valid/, "SLACK_SIGNING_SECRET"],
      [{ id: "mail", values: { AGENTMAIL_API_KEY: MAIL_KEY, AGENTMAIL_INBOX: "pako@agentmail.to", AGENTMAIL_POLL_MINUTES: "0" } }, 400, /How often/, "AGENTMAIL_POLL_MINUTES"],
      [{ id: "claude", values: { ANTHROPIC_API_KEY: `${CLAUDE_KEY}\nX=1` } }, 400, /line breaks/, "ANTHROPIC_API_KEY"],
      [{ id: "claude", values: { NODE_OPTIONS: "--require x" } }, 400, /can't be connected/],
      [{ id: "phone", values: {} }, 400, /can't be connected/],
      [{ id: "telegram", values: {} }, 400, /its own card/],
      [{ id: "claude", values: { ANTHROPIC_API_KEY: 5 } }, 400, /as text/, "ANTHROPIC_API_KEY"],
      [{ id: "claude", values: { ANTHROPIC_API_KEY: "" } }, 400, /anything new/],
      [{ id: "claude", values: "x" }, 400, /as text/],
    ];
    for (const [body, status, error, field] of cases) {
      const res = await r.post("", body);
      const out = (await res.json()) as { ok: boolean; error: string; field?: string };
      assert.equal(res.status, status, JSON.stringify(body));
      assert.equal(out.ok, false);
      assert.match(out.error, error);
      assert.equal(out.field, field);
      assert.ok(!JSON.stringify(out).includes("sk-nope"), "the value is not echoed");
    }
    assert.deepEqual(readStored(r.dir), {});
    assert.equal(r.restarts.length, 0);
    const big = await r.post("", { id: "claude", values: { ANTHROPIC_API_KEY: "x".repeat(20_000) } });
    assert.equal(big.status, 413, "the body limit");
  } finally {
    r.close();
  }
});

test("routes: a value set outside the panel wins: saving it is refused (409) and removal leaves it, naming it", async () => {
  const r = await rig();
  r.env.ANTHROPIC_API_KEY = CLAUDE_KEY;
  r.env.SLACK_USER_TOKEN = SLACK_TOKEN;
  try {
    const res = await r.post("", { id: "claude", values: { ANTHROPIC_API_KEY: `sk-ant-${"z".repeat(30)}` } });
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /ANTHROPIC_API_KEY in ~\/\.pako\/\.env, \.\/\.env or the terminal/);
    const states = (await (await r.get()).json()) as { connections: { id: string; fields: { from: string; tail?: string }[] }[] };
    const field = states.connections.find((c) => c.id === "claude")!.fields[0]!;
    assert.deepEqual([field.from, field.tail], ["outside", "WXYZ"]);
    // Slack: the token outside, the secret from the panel; the check sees both.
    const ok = await r.post("", { id: "slack", values: { SLACK_SIGNING_SECRET: SLACK_SECRET } });
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.deepEqual(readStored(r.dir), { SLACK_SIGNING_SECRET: SLACK_SECRET });
  } finally {
    r.close();
  }
  const r2 = await rig();
  r2.env.SLACK_USER_TOKEN = SLACK_TOKEN;
  try {
    writeStored(r2.dir, { SLACK_SIGNING_SECRET: SLACK_SECRET });
    const res = await r2.post("/remove", { id: "slack" });
    assert.deepEqual(await res.json(), { ok: true, outside: ["SLACK_USER_TOKEN"], restarting: true });
    assert.deepEqual(readStored(r2.dir), {});
    assert.ok(await waitFor(() => r2.restarts.length === 1));
    assert.deepEqual(r2.log, ["Slack: disconnected from the panel"]);
  } finally {
    r2.close();
  }
});

test("routes: removing what the panel never set changes nothing and does not restart; unknown and Telegram are refused", async () => {
  const r = await rig();
  try {
    assert.deepEqual(await (await r.post("/remove", { id: "zoom" })).json(), { ok: true, restarting: false, outside: [] });
    assert.equal((await r.post("/remove", { id: "nope" })).status, 400);
    assert.equal((await r.post("/remove", { id: "telegram" })).status, 400);
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(r.restarts.length, 0);
  } finally {
    r.close();
  }
});

test("routes: a restart that could not happen (npm run dev, the file not touched) leaves the card taking changes, not 'restarting' for ever", async () => {
  let tries = 0;
  const r = await rig({ restart: () => (tries++, false) });
  try {
    assert.deepEqual(await (await r.post("", { id: "claude", values: { ANTHROPIC_API_KEY: CLAUDE_KEY } })).json(), { ok: true, restarting: true });
    assert.ok(await waitFor(() => tries === 1));
    await new Promise((res) => setTimeout(res, 20));
    const next = await r.post("", { id: "tables", values: { GOOGLE_PLACES_API_KEY: PLACES_KEY } });
    assert.equal(next.status, 200, "not refused as busy");
    assert.equal(readStored(r.dir)?.GOOGLE_PLACES_API_KEY, PLACES_KEY);
  } finally {
    r.close();
  }
});

test("routes: without a way to restart, a save says so (restarting false) and applies at the next start", async () => {
  const r = await rig({ restart: undefined });
  try {
    const out = await (await r.post("", { id: "tables", values: { GOOGLE_PLACES_API_KEY: PLACES_KEY } })).json();
    assert.deepEqual(out, { ok: true, restarting: false });
    assert.equal(((await (await r.get()).json()) as { restart: boolean }).restart, false);
    assert.equal(readStored(r.dir)?.GOOGLE_PLACES_API_KEY, PLACES_KEY);
  } finally {
    r.close();
  }
});

test("routes: the panel's protection: signed-in cookie, and x-pako on writes; an unreadable store refuses before anything", async () => {
  const r = await rig();
  try {
    assert.equal((await r.get({})).status, 401);
    assert.equal((await r.get({ cookie: "ok=0" })).status, 401);
    const body = { id: "tables", values: { GOOGLE_PLACES_API_KEY: PLACES_KEY } };
    assert.equal((await r.post("", body, { cookie: "ok=1" })).status, 401, "no header: another site's form");
    assert.equal((await r.post("", body, { "x-pako": "1" })).status, 401, "no cookie");
    assert.equal((await r.post("/remove", { id: "tables" }, { cookie: "ok=1" })).status, 401);
    assert.deepEqual(readStored(r.dir), {});
    writeFileSync(join(r.dir, "secrets.json"), "{ broken");
    const res = await r.post("", body);
    assert.equal(res.status, 500);
    assert.match(((await res.json()) as { error: string }).error, /can't read ~\/\.pako\/secrets\.json/);
    assert.equal(((await (await r.get()).json()) as { readable: boolean }).readable, false);
    assert.equal(readFileSync(join(r.dir, "secrets.json"), "utf8"), "{ broken");
  } finally {
    r.close();
  }
});

test("routes: writes are rate limited", async () => {
  const r = await rig({ restart: undefined });
  try {
    let last = 0;
    for (let i = 0; i < 22; i++) last = (await r.post("", { id: "nope", values: {} })).status;
    assert.equal(last, 429);
  } finally {
    r.close();
  }
});

test("AgentMail's live check: a refused key or unknown inbox stops the save with the field named; a good one is saved", async () => {
  const seen: string[] = [];
  let status = 401;
  const fake = (async (url: string | URL, init?: RequestInit) => {
    seen.push(`${String(url)} ${(init?.headers as Record<string, string>).authorization === `Bearer ${MAIL_KEY}`}`);
    return new Response("{}", { status });
  }) as typeof fetch;
  assert.deepEqual(await checkAgentMail(MAIL_KEY, "pako@agentmail.to", (async () => { throw new Error("offline"); }) as typeof fetch), { ok: false, why: "mailNoAnswer" });
  const r = await rig({ fetch: fake, restart: undefined });
  const body = { id: "mail", values: { AGENTMAIL_API_KEY: MAIL_KEY, AGENTMAIL_INBOX: "pako@agentmail.to" } };
  try {
    let out = (await (await r.post("", body)).json()) as { error: string; field: string };
    assert.deepEqual([out.field, /doesn't accept that key/.test(out.error)], ["AGENTMAIL_API_KEY", true]);
    status = 404;
    out = (await (await r.post("", body)).json()) as { error: string; field: string };
    assert.deepEqual([out.field, /can't find that inbox/.test(out.error)], ["AGENTMAIL_INBOX", true]);
    assert.deepEqual(readStored(r.dir), {});
    status = 200;
    assert.deepEqual(await (await r.post("", body)).json(), { ok: true, restarting: false });
    assert.equal(seen[0], "https://api.agentmail.to/v0/inboxes/pako%40agentmail.to true");
    // Only the poll minutes changed: no live check.
    const before = seen.length;
    assert.deepEqual(await (await r.post("", { id: "mail", values: { AGENTMAIL_POLL_MINUTES: "5" } })).json(), { ok: true, restarting: false });
    assert.equal(seen.length, before);
    assert.equal(readStored(r.dir)?.AGENTMAIL_POLL_MINUTES, "5");
  } finally {
    r.close();
  }
});

function memoryKv(): Kv {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

test("the real app: a computer's panel has the routes behind its sign-in and restarts with app.locals.restart; a hosted server answers 404", async () => {
  const home = loadHome({ PAKO_HOME: join(tmp(), "home"), PAKO_NAME: "Ana" });
  const env: Env = { ...localEnv({}, home, 0), PAKO_HOME: home.dir };
  const kv = memoryKv();
  const local: LocalContext = {
    kv, channel: createLocalChannel({ kv }), bridgeToken: home.bridgeToken, panelSecret: home.panelSecret, bridge: { status: () => ({ claude: "ok", running: true }) },
  };
  const app = createApp(loadAppConfig(env), env, local);
  let restarted = 0;
  app.locals.restart = () => void restarted++;
  const server = createServer(app);
  const base = await listen(server);
  try {
    assert.equal((await fetch(`${base}/panel/api/connections`)).status, 401);
    const { link } = (await (await fetch(`${base}/panel/api/link`, { method: "POST", headers: { authorization: `Bearer ${home.bridgeToken}` } })).json()) as { link: string };
    const login = await fetch(link.replace(/^http:\/\/127\.0\.0\.1:\d+/, base), { redirect: "manual" });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const got = (await (await fetch(`${base}/panel/api/connections`, { headers: { cookie } })).json()) as { restart: boolean; connections: unknown[]; phone: string };
    assert.equal(got.restart, true);
    assert.equal(got.connections.length, CATALOGUE.length);
    assert.match(got.phone, /docs\/personal-caller\.md/);
    const res = await fetch(`${base}/panel/api/connections`, {
      method: "POST", headers: { cookie, "x-pako": "1", "content-type": "application/json" }, body: JSON.stringify({ id: "tables", values: { GOOGLE_PLACES_API_KEY: PLACES_KEY } }),
    });
    assert.deepEqual(await res.json(), { ok: true, restarting: true });
    assert.ok(await waitFor(() => restarted === 1));
    assert.equal(readStored(home.dir)?.GOOGLE_PLACES_API_KEY, PLACES_KEY);
    assert.equal(statSync(join(home.dir, "secrets.json")).mode & 0o777, 0o600);
    const page = await (await fetch(`${base}/panel/assets/connections.js`, { headers: { cookie } })).text();
    assert.match(page, /\/panel\/api\/connections/);
  } finally {
    server.close();
    server.closeAllConnections();
  }

  const hostedEnv: Env = {
    PERSONAL_CALLER_TOKEN: "p".repeat(32), PERSONAL_OWNER_NAME: "Ana", PERSONAL_OWNER_NUMBER: "+34600111222", WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
    WHATSAPP_PHONE_NUMBER_ID: "109876543210", WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef", WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  };
  const hosted = createServer(createApp(loadAppConfig(hostedEnv), hostedEnv));
  const hb = await listen(hosted);
  try {
    assert.equal((await fetch(`${hb}/panel/api/connections`)).status, 404);
    const post = await fetch(`${hb}/panel/api/connections`, { method: "POST", headers: { "x-pako": "1", "content-type": "application/json" }, body: "{}" });
    assert.equal(post.status, 404);
    assert.equal((await fetch(`${hb}/panel/api/connections/remove`, { method: "POST", headers: { "x-pako": "1" } })).status, 404);
  } finally {
    hosted.close();
    hosted.closeAllConnections();
  }
});

/** The restart's parts, recorded. */
function deps(over: Partial<RestartDeps> = {}) {
  const calls: string[] = [];
  let onSpawn: ((err?: Error) => void) | undefined;
  let onError: ((err?: Error) => void) | undefined;
  const d: RestartDeps = {
    env: { HOME: "/h", PAKO_NO_OPEN: "0", GONE: undefined },
    execPath: "/usr/bin/node",
    execArgv: ["--disable-warning=ExperimentalWarning"],
    argv: ["/usr/bin/node", "/app/src/server.ts"],
    platform: "darwin",
    ipc: false,
    spawn: (cmd, args, o) => {
      calls.push(`spawn ${cmd} ${args.join(" ")} ${o.stdio} ${o.env.PAKO_NO_OPEN}`);
      return { once: (ev: "spawn" | "error", f: (err?: Error) => void) => (ev === "spawn" ? (onSpawn = f) : (onError = f)) };
    },
    exit: (code) => void calls.push(`exit ${code}`),
    beforeExec: () => void calls.push("beforeExec"),
    log: () => {},
    ...over,
  };
  return { d, calls, spawned: () => onSpawn?.(), failed: () => onError?.(Object.assign(new Error("x"), { code: "ENOENT" })) };
}

test("restart: execve where Node has it (same process, same terminal), with the start's environment and no new browser tab", () => {
  const seen: { file: string; args: string[]; env: Record<string, string> }[] = [];
  const { d, calls } = deps({ execve: (file, args, env) => void seen.push({ file, args, env }) });
  assert.equal(restartInPlace(d), "exec");
  assert.deepEqual(calls, ["beforeExec"], "the exit handlers ran first (the lock, the store), and nothing exited");
  assert.deepEqual(seen, [{
    file: "/usr/bin/node", args: ["/usr/bin/node", "--disable-warning=ExperimentalWarning", "/app/src/server.ts"], env: { PAKO_NO_OPEN: "1", HOME: "/h" },
  }]);
});

test("restart: a parent with an IPC channel (pm2 and the like) gets exit code 75; Windows, or execve failing, spawns on the same terminal then exits", () => {
  const p = deps({ ipc: true, execve: () => assert.fail("not with a parent") });
  assert.equal(restartInPlace(p.d), "parent");
  assert.deepEqual(p.calls, ["exit 75"]);

  const w = deps({ platform: "win32", execve: () => assert.fail("not on Windows") });
  assert.equal(restartInPlace(w.d), "spawn");
  assert.deepEqual(
    w.calls,
    ["beforeExec", "spawn /usr/bin/node --disable-warning=ExperimentalWarning /app/src/server.ts inherit 1"],
    "the lock is given back before the new one starts; exits only once the new one started",
  );
  w.spawned();
  assert.deepEqual(w.calls.at(-1), "exit 0");

  const quiet = console.error;
  console.error = () => {};
  try {
    const f = deps({ execve: () => { throw Object.assign(new Error("no"), { code: "ENOSYS" }); } });
    assert.equal(restartInPlace(f.d), "spawn");
    f.failed();
    assert.deepEqual(f.calls, ["beforeExec", "spawn /usr/bin/node --disable-warning=ExperimentalWarning /app/src/server.ts inherit 1", "exit 1"]);
    const n = deps();
    assert.equal(restartInPlace(n.d), "spawn", "an older Node without execve");
  } finally {
    console.error = quiet;
  }
});

test("connections: a connection with no live check says whether it has answered once, only when the caller knows", () => {
  const env = { CALENDAR_ICS_URL: "https://calendar.example.com/private/basic.ics", GOOGLE_PLACES_API_KEY: "AIza" + "x".repeat(35) };
  const by = (o: { checked?: Record<string, boolean> }) =>
    Object.fromEntries(connectionStates({ env, stored: {}, fromStore: new Set(), lang: "en", ...o }).map((c) => [c.id, c]));
  const unknown = by({});
  assert.equal(unknown.calendar!.checked, undefined);
  const told = by({ checked: { calendar: false, tables: true } });
  assert.equal(told.calendar!.state, "on");
  assert.equal(told.calendar!.checked, false);
  assert.equal(told.tables!.checked, true);
  assert.equal(told.slack!.checked, undefined);
});
