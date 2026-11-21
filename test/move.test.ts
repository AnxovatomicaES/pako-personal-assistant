// Moving from a server to a computer (src/move.ts): the server's panel gives a file with the person's things and its settings that are not
// secrets; the computer's panel shows what would come in, writes nothing until confirmed, never takes a secret or another Pako's own state,
// keeps what it replaces, and starts again. The computer is the real app with a home in a temporary folder; nothing reaches the network.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import express from "express";
import { createApp, loadAppConfig, type LocalContext } from "../src/app.ts";
import { createControl } from "../src/control.ts";
import { DATA_KEYS } from "../src/data.ts";
import { createLocalChannel, createSettings, loadHome, localEnv } from "../src/local.ts";
import { sqliteKv } from "../src/sqlite-kv.ts";
import { MOVE_KEYS, mountMovePanel, readMoveFile } from "../src/move.ts";
import { eventually } from "./helpers/wait.ts";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const SECRETS = {
  whatsapp: `EAAG${"w".repeat(60)}`,
  admin: "admin-key-0123456789abcdef-xyz",
  zoho: `1000.${"z".repeat(40)}`,
  slackUser: "xoxp-1234567890-1234567890-abcdefghijklmnop",
  imapPassword: "app-password-hunter2-xyz",
};

/** A server's panel: its store holding every key Pako keeps, its settings with secrets among them. */
async function server() {
  const data = new Map<string, string>();
  for (const f of DATA_KEYS) data.set(f.prefix ? `${f.key}one` : f.key, JSON.stringify({ from: "server", key: f.key }));
  data.set("assistant-reminders", JSON.stringify([{ id: "r1", at: 1_900_000_000_000, text: "Llamar a Rohan" }]));
  data.set("owner-memory", JSON.stringify({ notes: [{ at: 1, text: `Le gusta el té; la clave es ${SECRETS.slackUser}` }], calls: [] }));
  data.set("owner-language", "es");
  data.set("zoho-refresh", SECRETS.zoho);
  data.set("telegram-owner", JSON.stringify({ id: 4242, name: "Theo" }));
  const env = {
    WHATSAPP_ACCESS_TOKEN: SECRETS.whatsapp, ADMIN_KEY: SECRETS.admin, SLACK_USER_TOKEN: SECRETS.slackUser, IMAP_PASSWORD: SECRETS.imapPassword,
    MORNING_BRIEF: "07:30", PERSONAL_TIMEZONE: "Europe/Madrid", ZOOM_USER: "owner@empresa.example", SLACK_QUIET_HOURS: "22:00-07:00",
    IMAP_HOST: "imap.example.com",
  };
  const app = express();
  mountMovePanel(app, {
    signedIn: (req) => req.get("cookie") === "ok=1", env, lang: () => "en", control: createControl(null), mode: "server",
    store: { get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v) },
    dir: join(mkdtempSync(join(tmpdir(), "pako-move-server-")), "none"),
    server: { ownerName: "Theo", timeZone: "Europe/Madrid" },
  });
  const s = createServer(app);
  const base = await listen(s);
  return { base, data, close: () => (s.close(), s.closeAllConnections()) };
}

/** A person's computer: a home in a temporary folder, the real app, signed in to its panel, a restart that is only counted. */
async function computer(o: { name?: string } = {}) {
  const home = loadHome({ PAKO_HOME: join(mkdtempSync(join(tmpdir(), "pako-move-")), "home") });
  // The computer's own time zone, pinned: localEnv reads it from the machine, and the server in these tests is in Madrid (CI runs in UTC).
  const env: Record<string, string | undefined> = { ...localEnv({}, home, 0), PAKO_HOME: home.dir, PERSONAL_TIMEZONE: "Europe/Madrid" };
  const kv = sqliteKv(home.dir);
  const channel = createLocalChannel({ kv });
  const settings = createSettings(home.dir, env);
  if (o.name) settings.setName(o.name);
  const local: LocalContext = {
    kv, channel, bridgeToken: home.bridgeToken, panelSecret: home.panelSecret, bridge: { status: () => ({ claude: "ok", running: true }) }, settings,
  };
  const app = createApp(loadAppConfig(env), env, local);
  let restarts = 0;
  app.locals.restart = () => ((restarts += 1), true);
  const s = createServer(app);
  const base = await listen(s);
  const login = await fetch((app.locals.panelLink as () => string)().replace(/^http:\/\/127\.0\.0\.1:\d+/, base), { redirect: "manual" });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const headers = { cookie, "x-pako": "1", "content-type": "application/json" };
  const post = (body: unknown, h: Record<string, string> = headers) => fetch(`${base}/panel/api/move/import`, { method: "POST", headers: h, body: JSON.stringify(body) });
  return { home, kv, settings, base, cookie, headers, post, restarts: () => restarts, close: () => (s.close(), s.closeAllConnections()) };
}

test("move, the server's side: one file with the person's things and the settings that are not secrets, behind the panel, with no secret in it", async () => {
  const s = await server();
  try {
    assert.equal((await fetch(`${s.base}/panel/api/move/export`, { headers: { "x-pako": "1" } })).status, 401, "signed in only");
    assert.equal((await fetch(`${s.base}/panel/api/move/export`, { headers: { cookie: "ok=1" } })).status, 401, "and the header");
    assert.deepEqual(await (await fetch(`${s.base}/panel/api/move`, { headers: { cookie: "ok=1" } })).json(), { mode: "server" });
    const r = await fetch(`${s.base}/panel/api/move/export`, { headers: { cookie: "ok=1", "x-pako": "1" } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-disposition") ?? "", /^attachment; filename="pako-move-\d{4}-\d{2}-\d{2}\.json"$/);
    const text = await r.text();
    const file = JSON.parse(text) as { format: string; from: string; server: { ownerName: string; settings: Record<string, string> }; store: Record<string, unknown> };
    assert.equal(file.format, "pako-export");
    assert.equal(file.from, "server");
    assert.equal(file.server.ownerName, "Theo");
    assert.deepEqual(file.server.settings, {
      PERSONAL_TIMEZONE: "Europe/Madrid", MORNING_BRIEF: "07:30", SLACK_QUIET_HOURS: "22:00-07:00", ZOOM_USER: "owner@empresa.example", IMAP_HOST: "imap.example.com",
    });
    for (const k of Object.keys(MOVE_KEYS)) assert.ok(file.store[k], `the file carries ${k}`);
    for (const [name, v] of Object.entries(SECRETS)) assert.ok(!text.includes(v), `the file carries ${name}`);
    assert.match(text, /la clave es \[secret: not exported\]/, "a secret inside a note is replaced too");
    // The import is a computer's: a server refuses it.
    const imp = await fetch(`${s.base}/panel/api/move/import`, { method: "POST", headers: { cookie: "ok=1", "x-pako": "1", "content-type": "application/json" }, body: "{}" });
    assert.equal(imp.status, 404);
  } finally {
    s.close();
  }
});

test("move, the computer's side: the plan first (nothing written), then the confirm writes, keeps what it replaced, sets the name and starts again", async () => {
  const s = await server();
  const c = await computer();
  try {
    const file = await (await fetch(`${s.base}/panel/api/move/export`, { headers: { cookie: "ok=1", "x-pako": "1" } })).json();
    // This computer already has a reminder of its own, and the same language.
    await c.kv.set("assistant-reminders", JSON.stringify([{ id: "mine", at: 1_900_000_000_000, text: "Del Mac" }]), 3600);
    await c.kv.set("owner-language", "es", 3600);
    assert.equal((await c.post({ file }, { cookie: c.cookie, "content-type": "application/json" })).status, 401, "no x-pako header");
    assert.deepEqual(await (await fetch(`${c.base}/panel/api/move`, { headers: { cookie: c.cookie } })).json(), { mode: "computer" });
    assert.equal((await fetch(`${c.base}/panel/api/move/export`, { headers: c.headers })).status, 404, "a computer's export is the Privacy card's");

    const snapshot = async () => Promise.all(Object.keys(MOVE_KEYS).map((k) => c.kv.get(k)));
    const before = await snapshot();
    const planned = (await (await c.post({ file })).json()) as {
      ok: boolean;
      plan: { items: { key: string; action: string }[]; skipped: { key: string; why: string }[]; name: string | null; settings: { set: string[]; byHand: { key: string }[] } };
    };
    assert.equal(planned.ok, true);
    const action = Object.fromEntries(planned.plan.items.map((i) => [i.key, i.action]));
    assert.equal(action["assistant-reminders"], "replace");
    assert.equal(action["owner-language"], "same");
    assert.equal(action["owner-memory"], "new");
    assert.deepEqual(planned.plan.items.map((i) => i.key).sort(), Object.keys(MOVE_KEYS).sort());
    const skipped = Object.fromEntries(planned.plan.skipped.map((x) => [x.key, x.why]));
    assert.match(skipped["zoho-refresh"]!, /secret/);
    for (const own of ["telegram-owner", "assistant-paused", "pako-store-id", "assistant-inbox", "assistant-last-channel"]) assert.ok(skipped[own], own);
    assert.equal(planned.plan.name, "Theo");
    assert.deepEqual(planned.plan.settings.set.sort(), ["IMAP_HOST", "SLACK_QUIET_HOURS", "ZOOM_USER"]);
    assert.deepEqual(planned.plan.settings.byHand.map((x) => x.key).sort(), ["MORNING_BRIEF"], "the time zone is the same here: nothing to copy");
    assert.deepEqual(await snapshot(), before, "the plan wrote nothing");
    assert.equal(c.restarts(), 0);

    const done = (await (await c.post({ file, confirm: true })).json()) as { ok: boolean; imported: number; backup: string; restarting: boolean; byHand: unknown[] };
    assert.equal(done.ok, true);
    assert.equal(done.imported, Object.keys(MOVE_KEYS).length - 1, "the one already the same is not written again");
    assert.equal(done.restarting, true);
    await eventually(() => c.restarts() >= 1, { then: 50 });
    assert.equal(c.restarts(), 1, "Pako starts again, so every part reads what came in");
    assert.deepEqual(JSON.parse((await c.kv.get("assistant-reminders"))!), [{ id: "r1", at: 1_900_000_000_000, text: "Llamar a Rohan" }]);
    assert.equal(await c.kv.get("owner-language"), "es", "a text is kept as text");
    assert.match((await c.kv.get("owner-memory"))!, /Le gusta el té/);
    assert.equal(await c.kv.get("zoho-refresh"), null);
    assert.equal(await c.kv.get("telegram-owner"), null, "a pairing never comes from a file");
    // What it replaced is kept, readable by this user only.
    const backup = join(c.home.dir, done.backup);
    assert.ok(existsSync(backup));
    assert.equal(statSync(backup).mode & 0o077, 0);
    assert.deepEqual(JSON.parse((JSON.parse(readFileSync(backup, "utf8")) as { store: Record<string, string> }).store["assistant-reminders"]!), [
      { id: "mine", at: 1_900_000_000_000, text: "Del Mac" },
    ]);
    assert.equal(c.settings.name(), "Theo");
    const stored = (JSON.parse(readFileSync(join(c.home.dir, "secrets.json"), "utf8")) as { settings: Record<string, string> }).settings;
    assert.deepEqual(stored, { IMAP_HOST: "imap.example.com", SLACK_QUIET_HOURS: "22:00-07:00", ZOOM_USER: "owner@empresa.example" });
    assert.equal(readdirSync(c.home.dir).filter((f) => f.startsWith("import-backup-")).length, 1);
    // Deleting everything (the Privacy card) deletes that copy too: it holds the person's things.
    const del = await fetch(`${c.base}/panel/api/delete-all`, { method: "POST", headers: c.headers, body: JSON.stringify({ confirm: "DELETE EVERYTHING" }) });
    assert.equal(del.status, 200);
    assert.ok(((await del.json()) as { removed: string[] }).removed.includes(done.backup));
    assert.equal(existsSync(backup), false);
  } finally {
    s.close();
    c.close();
  }
});

test("move, the computer's side: a name already given is kept, not replaced by the file's", async () => {
  const s = await server();
  const c = await computer({ name: "Ana" });
  try {
    const file = await (await fetch(`${s.base}/panel/api/move/export`, { headers: { cookie: "ok=1", "x-pako": "1" } })).json();
    const plan = ((await (await c.post({ file })).json()) as { plan: { name: string | null } }).plan;
    assert.equal(plan.name, null);
    await c.post({ file, confirm: true });
    assert.equal(c.settings.name(), "Ana");
  } finally {
    s.close();
    c.close();
  }
});

test("move: a file is checked, not trusted (not an export, another version, a wrong value, an unknown key, too big)", async () => {
  assert.equal(readMoveFile(null), "notExport");
  assert.equal(readMoveFile({ format: "something", version: 1, store: {} }), "notExport");
  assert.equal(readMoveFile({ format: "pako-export", version: 2, store: {} }), "version");
  assert.equal(readMoveFile({ format: "pako-export", version: 1, store: [] }), "notExport");
  const f = readMoveFile({
    format: "pako-export", version: 1,
    store: {
      "owner-language": { value: { not: "text" } },
      "assistant-reminders": { value: "a string where a list goes" },
      "assistant-lists": { value: { lists: [] } },
      "constructor": { value: {} },
      "assistant-paused": { value: true },
    },
    server: { ownerName: "Ana\u0007", settings: { MORNING_BRIEF: "08:00\nNODE_OPTIONS=--require x", ADMIN_KEY: "x".repeat(30), PERSONAL_TIMEZONE: "Europe/Madrid" } },
  });
  assert.ok(typeof f === "object");
  assert.deepEqual(f.entries.map((e) => e.key), ["assistant-lists"]);
  assert.deepEqual(Object.fromEntries(f.skipped.map((x) => [x.key, x.why])), {
    "owner-language": "badValue", "assistant-reminders": "badValue", "constructor": "own", "assistant-paused": "own",
  });
  assert.equal(f.ownerName, "", "a name with a control character is not taken");
  assert.deepEqual(f.settings, { PERSONAL_TIMEZONE: "Europe/Madrid" }, "a setting that is not on the list, or carries a new line, is not taken");

  const c = await computer();
  try {
    assert.equal((await c.post({ file: { format: "x" } })).status, 400);
    assert.match(((await (await c.post({ file: { format: "pako-export", version: 9, store: {} } })).json()) as { error: string }).error, /version/);
    const big = await fetch(`${c.base}/panel/api/move/import`, { method: "POST", headers: c.headers, body: `{"file":"${"x".repeat(9 * 1024 * 1024)}"}` });
    assert.equal(big.status, 413);
  } finally {
    c.close();
  }
});

test("move: the card is served and loaded by the page", async () => {
  const c = await computer();
  try {
    const js = await fetch(`${c.base}/panel/assets/move.js`, { headers: { cookie: c.cookie } });
    assert.equal(js.status, 200);
    assert.match(await js.text(), /\/panel\/api\/move\/import/);
    assert.match(readFileSync(new URL("../src/panel/index.html", import.meta.url), "utf8"), /\/panel\/assets\/move\.js/);
  } finally {
    c.close();
  }
});

test("move: the dated facts the owner told and the same-person answers come along, not left behind as the other Pako's", () => {
  const f = readMoveFile({
    format: "pako-export", version: 1,
    store: {
      "memory-facts": { value: { v: 1, facts: [{ id: "aaaaaaaaaa", subject: "Rohan", attribute: "oficina", value: "Londres", validFrom: 1 }] } },
      "people-identities": { value: { v: 1, persons: [], questions: [], no: [] } },
    },
  });
  assert.ok(typeof f === "object" && "entries" in f);
  assert.deepEqual(f.entries.map((e) => e.key).sort(), ["memory-facts", "people-identities"]);
  assert.deepEqual(f.skipped, []);
});
