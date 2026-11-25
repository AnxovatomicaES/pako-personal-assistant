// Your data on a person's computer (src/data.ts, src/data-panel.ts, src/panel/privacy.js): every key the modules keep is listed (read from
// the sources, so a new key fails here until it is described), the privacy facts in English, the export with every kind and no secret,
// deleting everything with its confirmation, the panel's protection, and a server refusing. Nothing here reaches the network.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import express from "express";
import { createApp, loadAppConfig, type LocalContext } from "../src/app.ts";
import type { Control } from "../src/control.ts";
import { CONFIRM, confirmed, DATA_KEYS, factFor, privacy, span } from "../src/data.ts";
import { mountDataPanel } from "../src/data-panel.ts";
import { createLocalChannel, loadHome, localEnv, sessionGeneration } from "../src/local.ts";
import { sqliteKv } from "../src/sqlite-kv.ts";

const root = new URL("../", import.meta.url);
const read = (p: string): string => readFileSync(new URL(p, root), "utf8");
const sources = (dir: string): string[] =>
  readdirSync(new URL(dir, root)).flatMap((f) => {
    const path = `${dir}${f}`;
    if (statSync(new URL(path, root)).isDirectory()) return sources(`${path}/`);
    return f.endsWith(".ts") ? [path] : [];
  });

/**
 * Every key a module writes to the store, read from its `kv.set(...)` calls: a literal, a constant of the same file, or a function of the same
 * file that makes a family of keys (`telegram-file:${id}`, its prefix). A key this cannot read fails the test: say what it is.
 */
function keysInTheCode(): { keys: Set<string>; unread: string[] } {
  const keys = new Set<string>();
  const unread: string[] = [];
  // The store guard's pass-through (watchStore) and the watchdog's (reportingKv) write whatever key they are given.
  const passThrough = new Set(["src/store-guard.ts key", "src/watchdog.ts key"]);
  for (const file of sources("src/")) {
    const src = read(file);
    for (const m of src.matchAll(/\bkv[!?]?\.set\(\s*([^,]+?)\s*,/g)) {
      const arg = m[1]!;
      if (passThrough.has(`${file} ${arg}`)) continue;
      const literal = /^["`]([a-z][a-z0-9-]*:?)["`]$/.exec(arg);
      // `d.stateKey ?? STATE_KEY` (src/imap.ts): the constant is the key, the other is the second mailbox's (named below).
      const name = /^(?:[\w.]+ \?\? )?([A-Za-z_][A-Za-z0-9_]*)(\(.*\))?$/.exec(arg);
      let key: string | undefined = literal?.[1];
      if (!key && name) {
        const def = new RegExp(`(?:^|\\n)\\s*(?:export )?const ${name[1]}\\s*=\\s*(?:\\([^)]*\\)(?::\\s*\\w+)?\\s*=>\\s*)?["\`]([a-z][a-z0-9-]*:?)`).exec(src);
        key = def?.[1];
      }
      if (key) keys.add(key);
      else unread.push(`${file}: kv.set(${arg}, ...)`);
    }
  }
  return { keys, unread };
}

test("every key the modules keep in the store is in DATA_KEYS, and every one listed is still kept by a module", () => {
  const { keys, unread } = keysInTheCode();
  assert.deepEqual(unread, [], "a kv.set whose key this test cannot read: add the key to DATA_KEYS (src/data.ts) and teach this test to read it");
  assert.ok(keys.size > 25, `the scan found the keys (${keys.size})`);
  const listed = new Set(DATA_KEYS.map((f) => f.key));
  assert.deepEqual([...keys].filter((k) => !listed.has(k)).sort(), [], "a key the code keeps that DATA_KEYS (src/data.ts) does not describe");
  // brief.ts only reads calendar-state (its old place), which calendar.ts writes; the store guard's two keys go through the pass-through.
  // The second mailbox's reader keeps its place under its own key, given by src/app/mail.ts (`assistant-${part}`).
  const written = new Set([...keys, "pako-store-id", "pako-store-era", "assistant-imap2"]);
  assert.deepEqual([...listed].filter((k) => !written.has(k)).sort(), [], "DATA_KEYS lists a key no module writes any more");
  // The store guard's list of keys a Pako in use keeps is part of it too.
  const signs = /const SIGNS = \[([\s\S]*?)\];/.exec(read("src/store-guard.ts"))![1]!;
  for (const m of signs.matchAll(/"([a-z-]+)"/g)) assert.ok(listed.has(m[1]!), m[1]!);
  // docs/privacy.md names each one.
  const doc = read("docs/privacy.md");
  for (const f of DATA_KEYS) assert.ok(doc.includes(`\`${f.prefix ? `${f.key}<` : f.key}`), `docs/privacy.md: ${f.key}`);
});

test("how long, how to confirm: spans in English, and the one phrase", () => {
  assert.equal(span(30 * 60, "en"), "30 minutes");
  assert.equal(span(10 * 60, "en"), "10 minutes");
  assert.equal(span(2 * 86400, "en"), "2 days");
  assert.equal(span(86400, "en"), "1 day");
  assert.equal(span(365 * 86400, "en"), "1 year");
  assert.equal(span(5 * 365 * 86400, "en"), "5 years");
  assert.equal(span(400 * 86400, "en"), "400 days");
  for (const ok of ["DELETE EVERYTHING", "  delete   everything ", "Delete Everything"]) assert.equal(confirmed(ok), true, ok);
  // The Spanish phrase is gone: the panel only ever shows the English one.
  for (const no of ["", "BORRAR TODO", "Borrar todo", "DELETE", "DELETE EVERYTHING NOW", "yes", undefined, null, 1, ["DELETE EVERYTHING"], { confirm: "DELETE EVERYTHING" }]) {
    assert.equal(confirmed(no), false, String(no));
  }
  assert.equal(CONFIRM, "DELETE EVERYTHING");
  assert.equal(factFor("telegram-file:abc")?.key, "telegram-file:");
  assert.equal(factFor("voice-result:lk_1")?.key, "voice-result:");
  assert.equal(factFor("something-else"), undefined);
});

test("the privacy facts: every key with what it holds and how long, the files, what leaves to whom (on only when connected), in English", () => {
  const dir = mkdtempSync(join(tmpdir(), "pako-privacy-"));
  for (const lang of ["en"] as const) {
    const p = privacy({ dir, env: { PAKO_HOME: dir }, lang });
    assert.equal(p.keys.length, DATA_KEYS.length);
    for (const k of p.keys) assert.ok(k.what && k.kept && !/[{}]/.test(k.what + k.kept), `${lang} ${k.key}`);
    for (const s of p.sends) assert.ok(s.what && s.detail && !/[{}]/.test(s.what), `${lang} ${s.name}`);
    assert.ok(p.files.some((f) => f.name === "kv.db") && p.files.some((f) => f.name === "secrets.json"));
    assert.ok(p.files.some((f) => f.name === join(dir, "logs")), "the background Pako's logs");
    if (process.platform === "darwin") assert.ok(p.files.some((f) => f.name.endsWith("LaunchAgents/local.pako.plist")), "autostart: a file");
    assert.ok(p.never.length >= 4 && p.how.length === 2);
    assert.equal(p.confirm, CONFIRM);
    assert.deepEqual(p.phrases, ["DELETE EVERYTHING"]);
    assert.doesNotMatch(JSON.stringify(p), /[áéíóúñ¿¡]/, "no Spanish");
    const on = p.sends.filter((s) => s.on).map((s) => s.name);
    assert.deepEqual(on, ["Anthropic (Claude)"], "nothing connected: only Claude, which is the brain");
    assert.equal(p.sends[0]!.detail, "claude");
  }
  const env = { TELEGRAM_BOT_TOKEN: "1:x", ANTHROPIC_API_KEY: "sk-ant-x", CALENDAR_ICS_URL: "https://calendar.example.com/private/abc.ics", SLACK_USER_TOKEN: "xoxp-1" };
  const p = privacy({ dir, env, lang: "en" });
  const by = Object.fromEntries(p.sends.map((s) => [s.name, s]));
  assert.equal(by["Telegram"]!.on, true);
  assert.equal(by["Slack"]!.on, true);
  assert.equal(by["Zoom"]!.on, false);
  assert.equal(by["Anthropic (Claude)"]!.detail, "ANTHROPIC_API_KEY", "names the setting, never its value");
  assert.equal(by["ICS"]!.detail, "calendar.example.com", "the host only: the rest of the link is its secret");
  assert.doesNotMatch(JSON.stringify(p), /private\/abc|sk-ant-x|xoxp-1/);
  assert.equal(by["IMAP"]!.on, false);
  // The owner's own mail server (src/imap.ts): its host is named, its password never.
  const imap = privacy({ dir, env: { IMAP_HOST: "imap.example.com", IMAP_USER: "ana@example.com", IMAP_PASSWORD: "hunter22" }, lang: "en" });
  const box = imap.sends.find((s) => s.name === "IMAP")!;
  assert.equal(box.on, true);
  assert.equal(box.detail, "imap.example.com");
  assert.doesNotMatch(JSON.stringify(imap), /hunter22/);
});

// ---------- the routes in the real app ----------

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A person's computer: a home in a temporary folder, the real app, signed in to its panel. */
async function computer(again?: string) {
  const home = loadHome({ PAKO_HOME: again ?? join(mkdtempSync(join(tmpdir(), "pako-data-")), "home"), PAKO_NAME: "Ana" });
  const env: Record<string, string | undefined> = { ...localEnv({}, home, 0), PAKO_HOME: home.dir };
  const kv = sqliteKv(home.dir);
  const channel = createLocalChannel({ kv });
  const local: LocalContext = {
    kv, channel, bridgeToken: home.bridgeToken, panelSecret: home.panelSecret, bridge: { status: () => ({ claude: "ok", running: true }) },
    sessionGeneration: sessionGeneration(home.dir), // as src/server.ts wires it
  };
  const app = createApp(loadAppConfig(env), env, local);
  const server = createServer(app);
  const base = await listen(server);
  const login = await fetch((app.locals.panelLink as () => string)().replace(/^http:\/\/127\.0\.0\.1:\d+/, base), { redirect: "manual" });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const headers = { cookie, "x-pako": "1", "content-type": "application/json" };
  const del = (body: unknown, h: Record<string, string> = headers) => fetch(`${base}/panel/api/delete-all`, { method: "POST", headers: h, body: JSON.stringify(body) });
  return { home, env, kv, channel, app, base, cookie, headers, del, close: () => (server.close(), server.closeAllConnections()) };
}

/** Something under every key Pako keeps (a family twice), with secrets where they can be: in a note, in a connection, in the store. */
async function fill(c: Awaited<ReturnType<typeof computer>>) {
  const secrets = {
    telegram: `123456:${"T".repeat(35)}`,
    mailKey: `am_${"m".repeat(30)}SECRET`,
    zoho: `1000.${"z".repeat(40)}`,
    pair: "PAIRCODE-7f3a9c",
    code: "482910",
    apiKey: `sk-ant-api03-${"k".repeat(40)}`,
  };
  const path = join(c.home.dir, "secrets.json");
  const saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...saved, telegramBotToken: secrets.telegram, settings: { AGENTMAIL_API_KEY: secrets.mailKey, AGENTMAIL_INBOX: "pako@agentmail.to" } }));
  writeFileSync(join(c.home.dir, "config.json"), JSON.stringify({ lang: "en", name: "Ana", welcomed: true }));
  c.env.ANTHROPIC_API_KEY = secrets.apiKey;
  const value: Record<string, unknown> = {
    "pako-local-chat": [{ n: 1, at: 1, who: "you", text: "hello Pako" }],
    "owner-memory": { notes: [{ at: 1, text: "Likes tea" }, { at: 2, text: `My key is ${secrets.apiKey}, keep it` }], calls: [] },
    "assistant-reminders": [{ at: 2, text: "Call mum" }],
    "assistant-lists": { lists: [{ name: "shopping", items: [{ text: "milk" }] }] },
    "assistant-mail": { recent: [{ id: "m1", subject: "Invoice", summary: "Your invoice is ready" }], seen: ["m1"] },
    "assistant-mail-codes": [{ id: "m2", at: 3, from: "bank@example.com", subject: "Your code", codes: [secrets.code] }],
    "assistant-log": [{ at: 4, kind: "nota", text: "Note saved" }],
    "zoho-refresh": secrets.zoho,
    "telegram-pair": JSON.stringify({ code: secrets.pair }),
    "telegram-owner": { id: 42, name: "Ana" },
  };
  for (const f of DATA_KEYS) {
    const keys = f.prefix ? [`${f.key}one`, `${f.key}two`] : [f.key];
    for (const k of keys) await c.kv.set(k, typeof value[k] === "string" ? (value[k] as string) : JSON.stringify(value[k] ?? { some: k }), 3600);
  }
  // The other things in the folder that hold the person's things.
  writeFileSync(join(c.home.dir, "kv.db.bad"), "damaged");
  // An older damaged store a later damage displaced (src/sqlite-kv.ts), and a journal kept with its file.
  writeFileSync(join(c.home.dir, "kv.db.bad.2026-01-02T03-04-05-678Z"), "older damaged");
  writeFileSync(join(c.home.dir, "kv.db.bad-journal"), "journal");
  mkdirSync(join(c.home.dir, "maitre", "shots"), { recursive: true });
  writeFileSync(join(c.home.dir, "maitre", "shots", "confirm.png"), "png");
  mkdirSync(join(c.home.dir, "browser", "Default"), { recursive: true });
  writeFileSync(join(c.home.dir, "browser", "Default", "Cookies"), "sign-ins");
  writeFileSync(join(c.home.dir, "kv.json.migrated"), "{}");
  const state = join(c.home.dir, "assistant");
  mkdirSync(join(state, "voice-abc"), { recursive: true });
  writeFileSync(join(state, "state.json"), JSON.stringify({ sessionId: "s1", count: 3 }));
  writeFileSync(join(state, "voice-abc", "in.ogg"), "audio");
  // The bridge's copy of the last turn for Pako's read tools (assistant/bridge/core.ts): the message, the notes, reminders and calendar.
  writeFileSync(join(state, "tool-data.json"), JSON.stringify({ turn: "remind me to call mum", notes: ["Likes tea"], reminders: ["Call mum"] }));
  writeFileSync(join(state, "outside-seen.json"), JSON.stringify(["a1b2c3"]));
  writeFileSync(join(state, "handled-unacked.json"), JSON.stringify({ "m-1": 1 }));
  return secrets;
}

test("export: every kind decoded, the settings and the connections by name, and no secret anywhere (Pako's, a connection's, in the store)", async () => {
  const c = await computer();
  try {
    const secrets = await fill(c);
    // The protection: signed in, and the header another site cannot send.
    assert.equal((await fetch(`${c.base}/panel/api/export`, { headers: { "x-pako": "1" } })).status, 401);
    assert.equal((await fetch(`${c.base}/panel/api/export`, { headers: { cookie: c.cookie } })).status, 401, "no x-pako header");
    const r = await fetch(`${c.base}/panel/api/export`, { headers: c.headers });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-disposition") ?? "", /^attachment; filename="pako-export-\d{4}-\d{2}-\d{2}\.json"$/);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const text = await r.text();
    const out = JSON.parse(text) as { format: string; settings: Record<string, unknown>; connections: Record<string, unknown>; store: Record<string, { what: string; value: unknown }> };
    assert.equal(out.format, "pako-export");
    for (const f of DATA_KEYS) {
      for (const k of f.prefix ? [`${f.key}one`, `${f.key}two`] : [f.key]) assert.ok(out.store[k]?.what, `the export has ${k}, said what it is`);
    }
    // Decoded, not as strings of JSON.
    assert.deepEqual(out.store["pako-local-chat"]!.value, [{ n: 1, at: 1, who: "you", text: "hello Pako" }]);
    assert.equal((out.store["owner-memory"]!.value as { notes: { text: string }[] }).notes[0]!.text, "Likes tea");
    assert.deepEqual(out.store["assistant-reminders"]!.value, [{ at: 2, text: "Call mum" }]);
    assert.ok((out.store["assistant-lists"]!.value as { lists: unknown[] }).lists.length);
    assert.equal((out.store["assistant-mail"]!.value as { recent: { summary: string }[] }).recent[0]!.summary, "Your invoice is ready");
    assert.deepEqual(out.store["assistant-log"]!.value, [{ at: 4, kind: "nota", text: "Note saved" }]);
    assert.equal((out.store["assistant-mail-codes"]!.value as { from: string }[])[0]!.from, "bank@example.com", "the codes' email, without the codes");
    assert.deepEqual(out.settings, { lang: "en", name: "Ana", welcomed: true });
    assert.deepEqual(out.connections, { setInThePanel: ["AGENTMAIL_API_KEY", "AGENTMAIL_INBOX"], setOutside: ["ANTHROPIC_API_KEY"], telegramBotSetInThePanel: true });
    // No secret, wherever it was.
    for (const [name, v] of Object.entries({ ...secrets, bridge: c.home.bridgeToken, caller: c.home.callerToken, panel: c.home.panelSecret })) {
      assert.ok(!text.includes(v), `the export carries ${name}`);
    }
    assert.match(JSON.stringify(out.store["owner-memory"]!.value), /My key is \[secret: not exported\], keep it/, "a secret in a note is replaced");
    assert.equal(out.store["zoho-refresh"]!.value, "[secret: not exported]");
    assert.equal(out.store["telegram-pair"]!.value, "[secret: not exported]");
    assert.deepEqual((out.store["assistant-mail-codes"]!.value as { codes: string[] }[])[0]!.codes, ["[hidden]"]);
  } finally {
    c.close();
  }
});

test("delete everything: the confirmation, then every key, the chat, Telegram, the choices and the connections gone, one log line, the rest said", async () => {
  const c = await computer();
  try {
    await fill(c);
    await c.channel.push("you", "hello Pako");
    // Not signed in, no header, no phrase, the wrong phrase: nothing happens.
    assert.equal((await c.del({ confirm: "DELETE EVERYTHING" }, { "content-type": "application/json", "x-pako": "1" })).status, 401);
    assert.equal((await c.del({ confirm: "DELETE EVERYTHING" }, { cookie: c.cookie, "content-type": "application/json" })).status, 401, "no x-pako header");
    for (const body of [{}, { confirm: "" }, { confirm: "yes" }, { confirm: "BORRAR TODO" }, { confirm: "DELETE" }, { confirm: ["DELETE EVERYTHING"] }]) {
      const r = await c.del(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(((await r.json()) as { error: string }).error, /DELETE EVERYTHING/, "says what to type");
    }
    assert.equal((await c.del("DELETE EVERYTHING")).status, 400, "the phrase alone, not in an object");
    assert.ok(c.kv.entries().length > DATA_KEYS.length, "nothing was deleted yet");

    // The background Pako's logs (src/autostart.ts): emptied in place, the old ones removed.
    mkdirSync(join(c.home.dir, "logs"), { recursive: true });
    writeFileSync(join(c.home.dir, "logs", "pako.log"), "[telegram] from you: hello Pako\n");
    writeFileSync(join(c.home.dir, "logs", "pako.log.old"), "older\n");

    let restarts = 0;
    c.app.locals.restart = () => void restarts++;
    const r = await c.del({ confirm: "delete everything" });
    assert.equal(r.status, 200);
    const out = (await r.json()) as { ok: boolean; restarting: boolean; stored: boolean; removed: string[]; kept: string[] };
    assert.equal(out.ok, true);
    assert.equal(out.restarting, true);
    assert.equal(out.stored, true);
    // Every key gone; the store keeps one line in the log, on disk too.
    assert.deepEqual(c.kv.entries().map((e) => e.key), ["assistant-log"]);
    const log = JSON.parse(c.kv.entries()[0]!.value) as { kind: string; text: string }[];
    assert.equal(log.length, 1);
    assert.match(log[0]!.text, /^Everything deleted from the panel/, "the line");
    assert.deepEqual(sqliteKv(c.home.dir).entries().map((e) => e.key), ["assistant-log"], "on disk too: another opening of the file reads the same");
    // The modules' copies in memory cannot bring anything back before Pako starts again.
    await c.kv.set("owner-memory", "{}", 60);
    assert.equal(await c.kv.get("owner-memory"), null);
    assert.deepEqual(await c.channel.list(0), [], "the chat window starts empty");
    // secrets.json: only what the server needs to run; config.json: no choice left; the other files gone.
    const secrets = JSON.parse(readFileSync(join(c.home.dir, "secrets.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(secrets).sort(), ["bridgeToken", "callerToken", "panelSecret"]);
    assert.equal(secrets.bridgeToken, c.home.bridgeToken, "the browser stays signed in");
    assert.equal((statSync(join(c.home.dir, "secrets.json")).mode & 0o777).toString(8), "600");
    const config = JSON.parse(readFileSync(join(c.home.dir, "config.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(config, {}, "no name, no welcome, no language: the next start shows the welcome");
    assert.equal(existsSync(join(c.home.dir, "kv.db.bad")), false);
    assert.equal(existsSync(join(c.home.dir, "kv.db.bad.2026-01-02T03-04-05-678Z")), false, "an older damaged store holds the person's things too");
    assert.equal(existsSync(join(c.home.dir, "kv.db.bad-journal")), false);
    assert.equal(existsSync(join(c.home.dir, "maitre")), false, "the booking screenshots");
    assert.equal(existsSync(join(c.home.dir, "browser")), false, "the booking browser's sign-ins");
    assert.equal(existsSync(join(c.home.dir, "kv.json.migrated")), false, "an older store kept after the update is the person's things too");
    assert.equal(existsSync(join(c.home.dir, "assistant", "state.json")), false, "the conversation with Claude starts afresh");
    assert.equal(existsSync(join(c.home.dir, "assistant", "voice-abc")), false);
    assert.equal(existsSync(join(c.home.dir, "assistant", "tool-data.json")), false, "the last turn's notes, reminders and calendar");
    assert.equal(existsSync(join(c.home.dir, "assistant", "outside-seen.json")), false);
    assert.equal(existsSync(join(c.home.dir, "assistant", "handled-unacked.json")), false);
    assert.equal(existsSync(join(c.home.dir, "kv.db.made")), true, "the mark stays: an empty store is not a lost one");
    assert.ok(out.removed.includes("kv.db") && out.removed.includes("config.json"));
    // What stays is said: the secrets to run, .env, Claude Code's history.
    assert.equal(readFileSync(join(c.home.dir, "logs", "pako.log"), "utf8"), "");
    assert.equal(existsSync(join(c.home.dir, "logs", "pako.log.old")), false);
    assert.ok(out.removed.includes("logs/pako.log"));
    // Autostart is a file and stays as the person set it (said only when this computer has it on).
    assert.equal(out.kept.filter((k) => !/^Autostart stays/.test(k)).length, 4);
    assert.match(out.kept.join(" "), /secrets\.json/);
    assert.match(out.kept.join(" "), /\.env/);
    assert.match(out.kept.join(" "), /\.claude\/projects\/-.*-home-assistant: /);
    // Paused first, until Pako starts again.
    const overview = (await (await fetch(`${c.base}/panel/api/overview`, { headers: c.headers })).json()) as { paused: number | null };
    assert.notEqual(overview.paused, null);
    // Started again once the answer had gone.
    await new Promise((res) => setTimeout(res, 400));
    assert.equal(restarts, 1);
    // Pressed again: nothing left to do.
    assert.equal((await c.del({ confirm: "DELETE EVERYTHING" })).status, 409);
  } finally {
    c.close();
  }
});

test("delete everything where Pako cannot start again by itself: done all the same, and the answer says to start it again", async () => {
  const c = await computer();
  try {
    await fill(c);
    const r = await c.del({ confirm: "DELETE EVERYTHING" });
    assert.equal(r.status, 200);
    const out = (await r.json()) as { restarting: boolean; kept: string[] };
    assert.equal(out.restarting, false);
    assert.match(out.kept.at(-1)!, /start it again/);
    assert.deepEqual(c.kv.entries().map((e) => e.key), ["assistant-log"]);
  } finally {
    c.close();
  }
});

// The folder is made read-only (chmod 555) to stand for a read-only volume. Root writes there all the same, so as root nothing would fail.
const asRoot = process.getuid?.() === 0 ? "run as root, which writes to a read-only folder all the same: the failed write cannot happen" : false;

test("delete everything when the emptied store cannot be written: the old file is removed, or else nothing restarts onto it", { skip: asRoot }, async () => {
  const c = await computer();
  const path = join(c.home.dir, "kv.db");
  try {
    await fill(c);
    assert.ok(c.kv.entries().some((e) => e.key === "owner-memory"), "written at once, nothing pending");
    // Nothing can be written in the folder, and nothing removed (a read-only volume): no restart, which would read everything back.
    let restarts = 0;
    c.app.locals.restart = () => void restarts++;
    chmodSync(c.home.dir, 0o555);
    let r = await c.del({ confirm: "DELETE EVERYTHING" });
    chmodSync(c.home.dir, 0o700);
    assert.equal(r.status, 500);
    assert.match(((await r.json()) as { error: string }).error, /I couldn't delete your data from ~\/\.pako\/kv\.db.*press again/);
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(restarts, 0, "not started again onto the old file");
    assert.equal(await c.kv.get("owner-memory"), null, "and nothing comes back meanwhile");
    // A full disk: the emptied store cannot be written (here its journal's name is taken by a folder), but the old file can be removed.
    mkdirSync(`${path}-journal`);
    r = await c.del({ confirm: "DELETE EVERYTHING" });
    assert.equal(r.status, 200, "another press does it");
    assert.equal(((await r.json()) as { restarting: boolean }).restarting, true);
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(restarts, 1);
    assert.equal(existsSync(path), false, "the old file is gone");
    assert.equal(existsSync(`${path}.made`), false, "the next start is a first run, not a lost store");
    const next = sqliteKv(c.home.dir);
    assert.equal(next.lost, null);
    assert.deepEqual(next.entries(), [], "the next start reads nothing back");
  } finally {
    chmodSync(c.home.dir, 0o700);
    c.close();
  }
});

test("export: the chat's copy of CÓDIGO's answer never carries the codes (marked secret, or an older one found by its lines)", async () => {
  const c = await computer();
  try {
    const code = "731905";
    // Through the door, as the owner asks for it in the panel's chat.
    await c.channel.deliver({ type: "text", text: { body: `🔑 Code from bank@example.com (just now): ${code}` } }, { secret: true });
    const chat = JSON.parse((await c.kv.get("pako-local-chat"))!) as { secret?: boolean }[];
    assert.equal(chat.at(-1)!.secret, true, "kept marked");
    // One kept before this version, unmarked, with a line of its own around it.
    chat.push({ n: 9, at: 9, who: "pako", text: `Here:\n🔑 Código de shop@example.com (hace 3 min): 55 22 81, ${code}\nThat's all` } as never);
    await c.kv.set("pako-local-chat", JSON.stringify(chat), 3600);
    const text = await (await fetch(`${c.base}/panel/api/export`, { headers: c.headers })).text();
    assert.ok(!text.includes(code) && !text.includes("55 22 81"), text);
    const out = JSON.parse(text) as { store: Record<string, { value: { text: string }[] }> };
    const msgs = out.store["pako-local-chat"]!.value;
    assert.equal(msgs.at(-2)!.text, "[hidden]");
    assert.equal(msgs.at(-1)!.text, "Here:\n🔑 Código de shop@example.com (hace 3 min): [hidden]\nThat's all", "an older Spanish line is still found");
    // The window still shows it to the owner.
    assert.ok((await c.channel.list(0)).some((m) => m.text.includes(code)));
  } finally {
    c.close();
  }
});

test("the privacy facts and the card: behind the panel's session, served, and loaded by the page", async () => {
  const c = await computer();
  try {
    assert.equal((await fetch(`${c.base}/panel/api/privacy`)).status, 401);
    const r = await fetch(`${c.base}/panel/api/privacy`, { headers: { cookie: c.cookie } });
    assert.equal(r.status, 200);
    const p = (await r.json()) as { folder: string; keys: unknown[] };
    assert.equal(p.folder, c.home.dir);
    assert.equal(p.keys.length, DATA_KEYS.length);
    const js = await fetch(`${c.base}/panel/assets/privacy.js`, { headers: { cookie: c.cookie } });
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    // In Settings, Privacy & your data; the dashboard shows content only.
    assert.match(read("src/panel/settings.html"), /<script type="module" src="\/panel\/assets\/privacy\.js"><\/script>/);
    assert.doesNotMatch(read("src/panel/index.html"), /privacy\.js/);
    // The card puts what it is sent on the page as text, and sends the header on the export and the delete.
    const card = read("src/panel/privacy.js");
    assert.doesNotMatch(card, /innerHTML|insertAdjacentHTML|outerHTML/);
    assert.equal((card.match(/"x-pako": "1"/g) ?? []).length, 2);
    // Its words: one English table.
    const words = [...(/\nconst WORDS = \{([\s\S]*?)\n\};/.exec(card)![1]!.matchAll(/^ {2}(\w+):/gm))].map((m) => m[1]);
    assert.ok(words.length > 15);
    assert.doesNotMatch(card, /\n  es: \{|[áéíóúñ¿¡]/);
  } finally {
    c.close();
  }
});

test("a server (hosted mode) refuses: every data route answers 404, signed in or not", async () => {
  const app = express();
  mountDataPanel(app, null);
  const server = createServer(app);
  const base = await listen(server);
  try {
    const headers = { cookie: "any=1", "x-pako": "1", "content-type": "application/json" };
    assert.equal((await fetch(`${base}/panel/api/privacy`, { headers })).status, 404);
    assert.equal((await fetch(`${base}/panel/api/export`, { headers })).status, 404);
    assert.equal((await fetch(`${base}/panel/api/delete-all`, { method: "POST", headers, body: JSON.stringify({ confirm: "DELETE EVERYTHING" }) })).status, 404);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("a store that cannot be emptied (not the file store) is not half deleted: refused before anything changes", async () => {
  const app = express();
  const data = new Map<string, string>([["owner-memory", "{}"]]);
  let paused = false;
  mountDataPanel(app, {
    signedIn: (req) => req.get("cookie") === "ok=1",
    env: {},
    dir: mkdtempSync(join(tmpdir(), "pako-data-plain-")),
    lang: () => "en",
    control: { setPaused: async () => ((paused = true), true), log: () => undefined } as unknown as Control,
    store: { get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v) },
  });
  const server = createServer(app);
  const base = await listen(server);
  try {
    const headers = { cookie: "ok=1", "x-pako": "1", "content-type": "application/json" };
    const r = await fetch(`${base}/panel/api/delete-all`, { method: "POST", headers, body: JSON.stringify({ confirm: "DELETE EVERYTHING" }) });
    assert.equal(r.status, 500);
    assert.equal(paused, false);
    assert.equal(data.get("owner-memory"), "{}");
    // Its export reads the fixed keys one by one.
    const ex = (await (await fetch(`${base}/panel/api/export`, { headers })).json()) as { store: Record<string, unknown> };
    assert.deepEqual(Object.keys(ex.store), ["owner-memory"]);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});


// The export's last line of defence: every secret value this computer holds is searched for and replaced. The owner's WhatsApp set up in
// the panel (secrets.json whatsappComputer: Meta's app secret, access token, webhook token) is one of them.
test("export: the WhatsApp settings saved from the panel are among the secrets the export never carries", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { exportData } = await import("../src/data.ts");
  const dir = mkdtempSync(join(tmpdir(), "pako-export-wa-"));
  try {
    const wa = { appSecret: "a".repeat(32), accessToken: `EAAG${"t".repeat(60)}`, verifyToken: "v".repeat(32), appId: "1234567890", ownerNumber: "447700900123" };
    writeFileSync(join(dir, "secrets.json"), JSON.stringify({ whatsappComputer: wa }), { mode: 0o600 });
    const said = `Here: ${wa.accessToken} and ${wa.appSecret} and ${wa.verifyToken}`;
    const store = { get: async (k: string) => (k === "assistant-log" ? JSON.stringify([{ at: 1, kind: "note", text: said }]) : null), set: async () => undefined };
    const text = JSON.stringify(await exportData({ store, dir, env: {}, lang: "en" }));
    for (const k of ["appSecret", "accessToken", "verifyToken"] as const) assert.ok(!text.includes(wa[k]), `the export carries WhatsApp's ${k}`);
    assert.match(text, /Here: \[secret: not exported\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The same search must not mask ordinary words: a setting whose name looks like a secret's but whose value is a plain word, or a bare address,
// is no secret, and replacing it would rewrite the person's own notes and chat wherever those words appear.
test("export: PAKO_SECRET_STORE's word and a bare address are not masked wherever they appear; an address that carries a secret still is", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { exportData } = await import("../src/data.ts");
  const dir = mkdtempSync(join(tmpdir(), "pako-export-plain-"));
  try {
    const env = {
      PAKO_SECRET_STORE: "keychain",
      ASSISTANT_SERVER_URL: "http://127.0.0.1:8819",
      PUBLIC_URL: "https://pako.example.com",
      LIVEKIT_URL: "wss://pako-abc123.livekit.example",
      CALENDAR_ICS_URL: "https://calendar.example.com/ical/private-9f8e7d6c5b4a/basic.ics",
      VOICE_RESULTS_URL: "rediss://:hunter2hunter2@kv.example.com:6379",
      NODE_TEST_CONTEXT: "1",
    };
    const said = `my keychain is slow. Brief: http://127.0.0.1:8819/brief and https://pako.example.com/panel and wss://pako-abc123.livekit.example/room. `
      + `Calendar ${env.CALENDAR_ICS_URL} and ${env.VOICE_RESULTS_URL}`;
    const store = { get: async (k: string) => (k === "assistant-log" ? JSON.stringify([{ at: 1, kind: "note", text: said }]) : null), set: async () => undefined };
    const text = (JSON.parse(JSON.stringify(await exportData({ store, dir, env, lang: "en" }))) as { store: Record<string, { value: { text: string }[] }> }).store["assistant-log"]!.value[0]!.text;
    assert.match(text, /^my keychain is slow\. Brief: http:\/\/127\.0\.0\.1:8819\/brief and https:\/\/pako\.example\.com\/panel and wss:\/\/pako-abc123\.livekit\.example\/room\. /, "plain words and bare addresses stay");
    assert.ok(!text.includes("private-9f8e7d6c5b4a"), "an ICS link's private part is hidden");
    assert.ok(!text.includes("hunter2hunter2"), "a store's password is hidden");
    assert.match(text, /Calendar \[secret: not exported\] and \[secret: not exported\]$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Delete everything keeps Sign out everywhere: a session it ended stays ended when Pako starts again on the emptied store", async () => {
  const c = await computer();
  let again: Awaited<ReturnType<typeof computer>> | null = null;
  try {
    const link = (app: express.Express) => (app.locals.panelLink as () => string)();
    const stolen = ((await fetch(link(c.app).replace(/^http:\/\/127\.0\.0\.1:\d+/, c.base), { redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0]!;
    const status = (base: string, cookie: string) => fetch(`${base}/panel/api/overview`, { headers: { cookie } }).then((x) => x.status);
    assert.equal(await status(c.base, stolen), 200);
    assert.equal((await fetch(`${c.base}/panel/api/sessions/end`, { method: "POST", headers: { cookie: stolen, "x-pako": "1" } })).status, 200);
    assert.equal(await status(c.base, stolen), 401);
    const owner = ((await fetch(link(c.app).replace(/^http:\/\/127\.0\.0\.1:\d+/, c.base), { redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0]!;

    c.app.locals.restart = () => undefined;
    assert.equal((await c.del({ confirm: "DELETE EVERYTHING" }, { cookie: owner, "x-pako": "1", "content-type": "application/json" })).status, 200);
    assert.deepEqual(c.kv.entries().map((e) => e.key), ["assistant-log"], "the store is empty: the generation in it is gone");
    const secrets = JSON.parse(readFileSync(join(c.home.dir, "secrets.json"), "utf8")) as Record<string, unknown>;
    assert.equal(secrets.panelSessions, 1, "kept with the run secrets");
    assert.equal(secrets.bridgeToken, c.home.bridgeToken);

    // Pako starts again on the same folder: the same run secrets, an empty store.
    again = await computer(c.home.dir);
    assert.equal(await status(again.base, stolen), 401, "the session ended before deleting stays ended");
    assert.equal(await status(again.base, owner), 200, "the owner's own session goes on");
  } finally {
    again?.close();
    c.close();
  }
});
