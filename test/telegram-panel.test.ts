// Telegram connected from the panel (src/telegram-panel.ts), on a person's computer: the bot's token set in the panel (checked with Telegram,
// kept in ~/.pako/secrets.json, started at once), the phone paired with a QR code, and what Pako starts by itself sent to the phone with a copy
// in the panel's chat (src/whatsapp.ts). The real app on a stand-in for Telegram's Bot API on this computer (TELEGRAM_API_URL points at it),
// or the real door with a stand-in Telegram. Nothing here reaches the network.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import express from "express";
import { encode } from "uqr";
import { createApp, loadAppConfig, type LocalContext } from "../src/app.ts";
import { createControl } from "../src/control.ts";
import type { Kv } from "../src/kv.ts";
import { createLocalChannel, createSettings, loadHome, localEnv, LOCAL_OWNER_NUMBER, type ChatMessage } from "../src/local.ts";
import { createTelegram } from "../src/telegram.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";
import { loadWhatsappConfig, mountWhatsapp, type OwnerAsk, type TelegramDoor, type WhatsappConfig } from "../src/whatsapp.ts";

type Body = Record<string, any>;
type Env = Record<string, string | undefined>;

// Made-up tokens in the shape @BotFather gives: they open nothing. The number before the colon is the bot's own id.
const GOOD = `123456789:${"A".repeat(35)}`;
const OTHER = `987654321:${"B".repeat(35)}`;
const ENV_BOT = `555555555:${"C".repeat(35)}`;
const UNKNOWN = `111111111:${"D".repeat(35)}`;
const OWNER_TG = 7001;
const STRANGER_TG = 7002;

/** Waits for a condition, checking often; the long limit is for a machine running the whole suite at once. */
async function until(ok: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return ok();
}

function memKv(): Kv & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

/**
 * A stand-in for Telegram's Bot API, listening on this computer: the bots it knows by token, every call made to it, and updates to hand out.
 * getUpdates is a real long poll (held until an update comes, or about a second), as Telegram's is.
 */
async function botApi() {
  const bots: Record<string, { id: number; username: string }> = {
    [GOOD]: { id: 123456789, username: "pako_test_bot" },
    [OTHER]: { id: 987654321, username: "pako_other_bot" },
    [ENV_BOT]: { id: 555555555, username: "pako_env_bot" },
  };
  const calls: { token: string; method: string; params: Body }[] = [];
  const queues = new Map<string, Body[]>();
  const waiters = new Set<() => void>();
  /** Bots whose news go to a webhook (a server uses them), and bots another program keeps polling: getUpdates answers 409 to both. */
  const hooked = new Set<string>();
  const polledElsewhere = new Set<string>();
  /** Long polls being held now, by token. */
  const held = new Map<string, number>();
  let hookInfoDown = false;
  let blocked = false;
  let message = 100;
  let update = 1000;
  const send = (res: ServerResponse, status: number, doc: unknown): void => {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(doc));
  };
  const answer = async (req: IncomingMessage, res: ServerResponse, raw: string): Promise<void> => {
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "");
    const token = m?.[1] ?? "";
    const method = m?.[2] ?? "";
    const params = raw ? (JSON.parse(raw) as Body) : {};
    calls.push({ token, method, params });
    if (!m || !Object.hasOwn(bots, token)) return send(res, 401, { ok: false, error_code: 401, description: "Unauthorized" });
    if (method === "getMe") return send(res, 200, { ok: true, result: { id: bots[token]!.id, is_bot: true, first_name: "Pako", username: bots[token]!.username } });
    if (method === "sendMessage") {
      if (blocked) return send(res, 403, { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" });
      return send(res, 200, { ok: true, result: { message_id: ++message } });
    }
    if (method === "getWebhookInfo") {
      if (hookInfoDown) return send(res, 500, { ok: false, error_code: 500, description: "Internal Server Error" });
      return send(res, 200, { ok: true, result: { url: hooked.has(token) ? "https://pako.example.com/telegram/webhook" : "", pending_update_count: 0 } });
    }
    if (method === "getUpdates" && hooked.has(token)) {
      return send(res, 409, { ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first" });
    }
    if (method === "getUpdates" && polledElsewhere.has(token)) {
      return send(res, 409, { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running" });
    }
    if (method === "getUpdates") {
      const offset = Number(params.offset ?? 0);
      const pending = () => (queues.get(token) ?? []).filter((u) => u.update_id >= offset); // the ones before the offset are confirmed
      queues.set(token, pending());
      if (!pending().length && Number(params.timeout) > 0) {
        held.set(token, (held.get(token) ?? 0) + 1);
        await new Promise<void>((resolve) => {
          let ended = false;
          const done = (): void => {
            if (!ended) held.set(token, (held.get(token) ?? 1) - 1);
            ended = true;
            clearTimeout(timer);
            waiters.delete(done);
            resolve();
          };
          const timer = setTimeout(done, 1100);
          waiters.add(done);
          res.once("close", done);
        });
      }
      return send(res, 200, { ok: true, result: pending() });
    }
    return send(res, 200, { ok: true, result: true });
  };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += String(c)));
    req.on("end", () => void answer(req, res, raw));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    /** The bot's token is revoked: Telegram answers 401 to it from now on. */
    revoke: (token: string) => void delete bots[token],
    block: (on: boolean) => void (blocked = on),
    queue: (token: string, u: Body) => {
      queues.set(token, [...(queues.get(token) ?? []), { update_id: ++update, ...u }]);
      for (const w of [...waiters]) w();
    },
    /** A message from a person to the bot, in a one-to-one chat. */
    text: (from: number, text: string) => ({ message: { message_id: ++message, from: { id: from, is_bot: false, first_name: "Marta", username: "marta" }, chat: { id: from, type: "private" }, text } }),
    sent: (token = GOOD) => calls.filter((c) => c.method === "sendMessage" && c.token === token).map((c) => c.params),
    asked: (method: string, token: string) => calls.filter((c) => c.method === method && c.token === token).length,
    /** How many long polls of this bot are being held right now (a poller that was stopped closes its own). */
    holding: (token: string) => held.get(token) ?? 0,
    /** This bot's news go to a webhook from now on (or no longer). */
    hook: (token: string, on = true) => void (on ? hooked.add(token) : hooked.delete(token)),
    /** Another program polls this bot from now on (or no longer). */
    pollElsewhere: (token: string, on = true) => void (on ? polledElsewhere.add(token) : polledElsewhere.delete(token)),
    /** getWebhookInfo fails from now on (or works again). */
    hookInfo: (works: boolean) => void (hookInfoDown = !works),
    close: () => {
      for (const w of [...waiters]) w();
      server.close();
      server.closeAllConnections();
    },
  };
}
type BotApi = Awaited<ReturnType<typeof botApi>>;

/** Pako on a person's computer, as src/server.ts builds it, signed in to its panel. The home folder and the store can be shared (a restart). */
async function localPako(o: { api: string; dir?: string; kv?: Kv; env?: Env; savedToken?: string }) {
  const dir = o.dir ?? join(mkdtempSync(join(tmpdir(), "pako-tgpanel-")), "home");
  const home = loadHome({ PAKO_HOME: dir });
  const env: Env = { ...localEnv({}, home, 0), PAKO_HOME: home.dir, TELEGRAM_API_URL: o.api, ...o.env };
  const kv = o.kv ?? memKv();
  const settings = createSettings(home.dir, env);
  if (o.savedToken) assert.equal(settings.setTelegramToken!(o.savedToken), true);
  const local: LocalContext = {
    kv, channel: createLocalChannel({ kv }), bridgeToken: home.bridgeToken, panelSecret: home.panelSecret,
    bridge: { status: () => ({ claude: "ok", running: true }) }, settings,
  };
  const app = createApp(loadAppConfig(env), env, local);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch((app.locals.panelLink as () => string)().replace(/^http:\/\/127\.0\.0\.1:\d+/, base));
  assert.equal(login.status, 200);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const get = async (path: string, headers: Record<string, string> = { cookie }) => {
    const r = await fetch(`${base}${path}`, { headers });
    return { status: r.status, body: (await r.json()) as Body };
  };
  const post = async (path: string, body: unknown = {}, headers: Record<string, string> = { cookie, "x-pako": "1" }) => {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Body };
  };
  const bridge = { authorization: `Bearer ${home.bridgeToken}` };
  const telegram = app.locals.telegram as { start(): void; stop(): void };
  return {
    app, base, home, settings, kv, get, post, telegram,
    secrets: () => JSON.parse(readFileSync(join(home.dir, "secrets.json"), "utf8")) as Record<string, unknown>,
    /** The panel's chat, as the page reads it. */
    chat: async () => (await get("/panel/api/chat?since=0")).body.messages as ChatMessage[],
    /** The owner types in the panel's chat. */
    type: (text: string) => post("/panel/api/chat", { text }),
    /** What waits for the assistant (asking for it also sends the reminders that are due, as the bridge's polls do). */
    inbox: async () => ((await (await fetch(`${base}/assistant/inbox?wait=0`, { headers: bridge })).json()) as { messages: Body[] }).messages,
    reply: (body: Body) => fetch(`${base}/assistant/reply`, { method: "POST", headers: { ...bridge, "content-type": "application/json" }, body: JSON.stringify(body) }),
    overview: async () => (await get("/panel/api/overview")).body,
    close: () => {
      telegram.stop();
      server.close();
      server.closeAllConnections();
    },
  };
}
type LocalPako = Awaited<ReturnType<typeof localPako>>;

/** The token set in the panel, its QR's link opened on the phone (the stand-in hands Pako the /start), and the panel saying it is paired. */
async function pairPhone(p: LocalPako, tg: BotApi, token = GOOD): Promise<void> {
  const set = await p.post("/panel/api/telegram/token", { token });
  assert.equal(set.body.ok, true, JSON.stringify(set.body));
  const link = (await p.post("/panel/api/telegram/link")).body.link as string;
  const code = /\?start=([A-Za-z0-9_-]{24})$/.exec(link)?.[1];
  assert.ok(code, link);
  tg.queue(token, tg.text(OWNER_TG, `/start ${code}`));
  assert.ok(await until(async () => (await p.get("/panel/api/telegram")).body.state === "paired"), "paired");
}

test("token: a malformed token is refused without asking Telegram; one Telegram refuses says so; a good one is kept in secrets.json (mode 600) and the bot starts at once", async () => {
  const tg = await botApi();
  const p = await localPako({ api: tg.api });
  try {
    assert.deepEqual((await p.get("/panel/api/telegram")).body, { state: "no-token" });
    const before = p.secrets();
    const bad = await p.post("/panel/api/telegram/token", { token: "esto-no-es-un-token" });
    assert.deepEqual(bad, { status: 200, body: { ok: false, error: "That doesn't look like a bot token. Copy the whole one @BotFather gave you: digits, a colon, then letters." } });
    assert.equal(tg.calls.length, 0, "Telegram was not asked");
    const refused = await p.post("/panel/api/telegram/token", { token: UNKNOWN });
    assert.deepEqual(refused.body, { ok: false, error: "Telegram doesn't accept that token. Copy it again from @BotFather, or ask it for a new one with /token." });
    assert.equal(tg.asked("getMe", UNKNOWN), 1);
    assert.equal(p.secrets().telegramBotToken, undefined, "a refused token is not kept");
    assert.deepEqual((await p.get("/panel/api/telegram")).body, { state: "no-token" });

    const good = await p.post("/panel/api/telegram/token", { token: ` ${GOOD} ` });
    assert.deepEqual(good, { status: 200, body: { ok: true, bot: "pako_test_bot" } });
    // Kept beside the other secrets, readable only by this user; the others untouched; never in config.json.
    const path = join(p.home.dir, "secrets.json");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(p.secrets(), { ...before, telegramBotToken: GOOD });
    assert.ok(!existsSync(join(p.home.dir, "config.json")) || !readFileSync(join(p.home.dir, "config.json"), "utf8").includes(GOOD.split(":")[1]!), "not in config.json");
    // Started at once (no restart, and server.ts's start was never called here): it asks Telegram for its news.
    assert.ok(await until(() => tg.asked("getUpdates", GOOD) > 0), "long polling started");
    assert.deepEqual((await p.get("/panel/api/telegram")).body, { state: "unpaired", bot: "pako_test_bot" });
    const view = await p.overview();
    assert.deepEqual(view.integrations.find((i: Body) => i.key === "telegram"), { key: "telegram", name: "Telegram", on: false, detail: "Not connected: scan the QR code" });
    assert.ok(view.log.some((l: Body) => l.text === "Telegram bot set from the panel: @pako_test_bot"));
    assert.ok(!JSON.stringify(view).includes(GOOD.split(":")[1]!), "the token is shown nowhere");
  } finally {
    p.close();
    tg.close();
  }
});

test("token kept or not: a secrets file that cannot be written refuses the token and starts nothing; a secret made again at the next start keeps it", async () => {
  const tg = await botApi();
  const p = await localPako({ api: tg.api });
  const path = join(p.home.dir, "secrets.json");
  const kept = readFileSync(path, "utf8");
  try {
    // Not a file any more (a broken home folder): nothing can be read or written there.
    rmSync(path);
    mkdirSync(path);
    const set = await p.post("/panel/api/telegram/token", { token: GOOD });
    assert.deepEqual(set.body, { ok: false, error: "I couldn't save the token on this computer (~/.pako/secrets.json). Check there's free space and permission, then try again." });
    assert.deepEqual((await p.get("/panel/api/telegram")).body, { state: "no-token" }, "a bot that would stop answering at the next start is not started");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(tg.asked("getUpdates", GOOD), 0);
    rmSync(path, { recursive: true });
    writeFileSync(path, kept, { mode: 0o600 });
    assert.equal((await p.post("/panel/api/telegram/token", { token: GOOD })).body.ok, true);
  } finally {
    p.close();
    tg.close();
  }
  // One of the other secrets is damaged and made again at the next start: the bot token stays beside it.
  writeFileSync(path, JSON.stringify({ ...(JSON.parse(readFileSync(path, "utf8")) as object), bridgeToken: "short" }), { mode: 0o600 });
  const again = loadHome({ PAKO_HOME: p.home.dir });
  assert.notEqual(again.bridgeToken, "short");
  assert.equal((JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>).telegramBotToken, GOOD);
  assert.equal(createSettings(p.home.dir, {}).telegramToken!(), GOOD);
});

test("link and QR: a one-time t.me link and an SVG QR code of exactly that link; opening it on the phone pairs it; the panel's chat says which account", async () => {
  const tg = await botApi();
  const p = await localPako({ api: tg.api });
  try {
    assert.equal((await p.post("/panel/api/telegram/link")).status, 409, "no token yet: no link");
    await p.post("/panel/api/telegram/token", { token: GOOD });
    const { status, body } = await p.post("/panel/api/telegram/link");
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), ["link", "svg"]);
    assert.match(body.link, /^https:\/\/t\.me\/pako_test_bot\?start=[A-Za-z0-9_-]{24}$/);
    // A real SVG, and the QR code in it is the link's: its dark modules are exactly the ones uqr encodes for it.
    const svg = String(body.svg);
    const qr = encode(body.link, { ecc: "M", border: 2 });
    assert.ok(svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${qr.size * 10} ${qr.size * 10}">`) && svg.endsWith("</svg>"), svg.slice(0, 120));
    const drawn = new Set([...svg.matchAll(/M(\d+),(\d+)h10v10h-10z/g)].map((m) => `${Number(m[1]) / 10},${Number(m[2]) / 10}`));
    const dark = new Set(qr.data.flatMap((row, y) => row.flatMap((on, x) => (on ? [`${x},${y}`] : []))));
    assert.ok(dark.size > 100);
    assert.deepEqual(drawn, dark);

    const code = /start=(.+)$/.exec(body.link)![1]!;
    tg.queue(GOOD, tg.text(OWNER_TG, `/start ${code}`));
    assert.ok(await until(async () => (await p.get("/panel/api/telegram")).body.state === "paired"));
    assert.deepEqual((await p.get("/panel/api/telegram")).body, { state: "paired", bot: "pako_test_bot", account: "Marta (@marta)" });
    assert.ok(await until(() => tg.sent().some((m) => m.chat_id === OWNER_TG && m.text === "Done: we can talk on Telegram now too. Write to me here whenever you like, as in your other chat.")));
    assert.ok(await until(async () => (await p.chat()).some((m) => m.text === "Telegram connected: the account “Marta” (@marta, id 7001) now talks to me. If that wasn't you, type TELEGRAM OFF here.")));
    assert.ok((await p.chat()).every((m) => m.via === undefined), "the pairing notice belongs to the panel's own chat");
    // The same link again, from someone else: used up.
    tg.queue(GOOD, tg.text(STRANGER_TG, `/start ${code}`));
    assert.ok(await until(() => tg.sent().some((m) => m.chat_id === STRANGER_TG)));
    assert.equal(tg.sent().filter((m) => m.chat_id === STRANGER_TG).at(-1)!.text, "That link doesn't work or has expired. Ask for a new one: type TELEGRAM in your chat with Pako.");
    assert.equal((await p.get("/panel/api/telegram")).body.account, "Marta (@marta)");
    assert.equal((await p.overview()).integrations.find((i: Body) => i.key === "telegram").detail, "Connected");
  } finally {
    p.close();
    tg.close();
  }
});

test("routing: a due reminder goes to the paired phone and the panel's chat keeps a copy marked as sent to Telegram; answers still go where the owner wrote", async () => {
  const tg = await botApi();
  const kv = memKv();
  // A reminder already due, kept in the store from before (nothing sends it until the bridge's next look, below).
  await kv.set("assistant-reminders", JSON.stringify([{ id: "a1b2c3d4", at: Date.now() - 1000, text: "llamar a mamá", held: false, tries: 0 }]), 3600);
  const p = await localPako({ api: tg.api, kv });
  try {
    await pairPhone(p, tg);
    await p.inbox();
    assert.ok(await until(() => tg.sent().some((m) => m.text === "Reminder: llamar a mamá")), "on the phone");
    assert.equal(tg.sent().find((m) => m.text === "Reminder: llamar a mamá")!.chat_id, OWNER_TG);
    assert.ok(await until(async () => (await p.chat()).some((m) => m.text === "Reminder: llamar a mamá")));
    const copies = (await p.chat()).filter((m) => m.text === "Reminder: llamar a mamá");
    assert.equal(copies.length, 1, "one copy");
    assert.equal(copies[0]!.via, "telegram");
    assert.equal(copies[0]!.who, "pako");

    // Written in the panel: answered in the panel only.
    const onPhone = tg.sent().length;
    await p.type("¿qué tengo hoy?");
    assert.ok(await until(async () => (await p.inbox()).some((m) => m.text === "¿qué tengo hoy?")));
    const fromPanel = (await p.inbox()).find((m) => m.text === "¿qué tengo hoy?")!;
    assert.match(fromPanel.id, /^local-/);
    assert.equal((await p.reply({ key: fromPanel.id, text: "Hoy, dos reuniones." })).status, 200);
    assert.equal((await p.chat()).filter((m) => m.text === "Hoy, dos reuniones.").map((m) => m.via ?? "panel").join(), "panel");
    // A word sent with no key ("Un momento…") belongs to the owner's last message too: the panel, where they wrote.
    await p.reply({ text: "Un momento…" });
    assert.equal((await p.chat()).filter((m) => m.text === "Un momento…").map((m) => m.via ?? "panel").join(), "panel");
    assert.equal(tg.sent().length, onPhone, "nothing of that went to the phone");

    // Written on Telegram: answered on Telegram only, and the panel keeps no copy of it.
    tg.queue(GOOD, tg.text(OWNER_TG, "¿y mañana?"));
    assert.ok(await until(async () => (await p.inbox()).some((m) => m.text === "¿y mañana?")));
    const fromPhone = (await p.inbox()).find((m) => m.text === "¿y mañana?")!;
    assert.match(fromPhone.id, /^tg-7001-\d+$/);
    await p.reply({ key: fromPhone.id, text: "Mañana, libre." });
    await p.reply({ text: "Un momento más…" });
    assert.deepEqual(tg.sent().slice(onPhone).map((m) => m.text), ["Mañana, libre.", "Un momento más…"]);
    assert.ok(!(await p.chat()).some((m) => m.text === "Mañana, libre." || m.text === "Un momento más…"));

    // A notice (an email's summary) is started by Pako: the phone, and a copy in the panel. Paused (STOP) changes nothing here: STOP holds
    // calls and messages to other people, never what reaches the owner; and the panel's Telegram card still works.
    assert.equal((await p.post("/panel/api/pause", { on: true })).status, 200);
    await p.reply({ text: "📧 Correo de Ana: «la cena»", notice: true });
    assert.equal(tg.sent().at(-1)!.text, "📧 Correo de Ana: «la cena»");
    assert.equal((await p.chat()).filter((m) => m.text === "📧 Correo de Ana: «la cena»").map((m) => m.via).join(), "telegram");
    assert.match((await p.post("/panel/api/telegram/link")).body.link, /^https:\/\/t\.me\/pako_test_bot\?start=/);
    assert.equal((await p.get("/panel/api/telegram")).body.state, "paired");
  } finally {
    p.close();
    tg.close();
  }
});

test("off: the panel unpairs the phone and keeps the token; what Pako starts then stays in the panel's chat; the old link no longer pairs", async () => {
  const tg = await botApi();
  const kv = memKv();
  await kv.set("assistant-reminders", JSON.stringify([{ id: "a1b2c3d5", at: Date.now() - 1000, text: "regar las plantas", held: false, tries: 0 }]), 3600);
  const p = await localPako({ api: tg.api, kv });
  try {
    await pairPhone(p, tg);
    const link = (await p.post("/panel/api/telegram/link")).body.link as string;
    assert.deepEqual(await p.post("/panel/api/telegram/off"), { status: 200, body: { ok: true } });
    assert.deepEqual((await p.get("/panel/api/telegram")).body, { state: "unpaired", bot: "pako_test_bot" });
    assert.equal(p.secrets().telegramBotToken, GOOD, "the token stays");
    assert.ok((await p.overview()).log.some((l: Body) => l.text === "Telegram disconnected from the panel"));
    const onPhone = tg.sent().length;
    await p.inbox();
    assert.ok(await until(async () => (await p.chat()).some((m) => m.text === "Reminder: regar las plantas")));
    assert.equal((await p.chat()).find((m) => m.text === "Reminder: regar las plantas")!.via, undefined, "the panel's own message, not a copy");
    assert.equal(tg.sent().length, onPhone, "nothing to the phone");
    // A link shown before OFF is worth nothing now.
    tg.queue(GOOD, tg.text(OWNER_TG, `/start ${/start=(.+)$/.exec(link)![1]}`));
    assert.ok(await until(() => tg.sent().length > onPhone));
    assert.equal(tg.sent().at(-1)!.text, "That link doesn't work or has expired. Ask for a new one: type TELEGRAM in your chat with Pako.");
    assert.equal((await p.get("/panel/api/telegram")).body.state, "unpaired");
    assert.deepEqual(await p.post("/panel/api/telegram/off"), { status: 200, body: { ok: true } }, "again: nothing to undo");
  } finally {
    p.close();
    tg.close();
  }
});

test("restart: the token kept from the panel starts the bot at the next start, still paired; a token Telegram then refuses makes the panel ask for a new one", async () => {
  const tg = await botApi();
  const kv = memKv();
  const dir = join(mkdtempSync(join(tmpdir(), "pako-tgpanel-")), "home");
  const first = await localPako({ api: tg.api, dir, kv });
  try {
    await pairPhone(first, tg);
  } finally {
    first.close();
  }
  const second = await localPako({ api: tg.api, dir, kv });
  try {
    const polls = tg.asked("getUpdates", GOOD);
    assert.deepEqual((await second.get("/panel/api/telegram")).body, { state: "paired", bot: "pako_test_bot", account: "Marta (@marta)" });
    second.telegram.start(); // server.ts, once listening
    assert.ok(await until(() => tg.asked("getUpdates", GOOD) > polls), "polling again with the kept token");
    tg.revoke(GOOD);
    assert.ok(await until(async () => (await second.get("/panel/api/telegram")).body.state === "no-token"), "a refused token is as good as none");
    assert.deepEqual(await second.post("/panel/api/telegram/link"), { status: 409, body: { error: "Set your bot's token first." } });
    // A new bot set in the panel takes its place at once.
    assert.deepEqual((await second.post("/panel/api/telegram/token", { token: OTHER })).body, { ok: true, bot: "pako_other_bot" });
    assert.equal(second.secrets().telegramBotToken, OTHER);
    assert.ok(await until(() => tg.asked("getUpdates", OTHER) > 0));
  } finally {
    second.close();
    tg.close();
  }
});

test("another bot: the account paired with the first bot is not the owner of the second (that bot cannot write to it); back to the first, it is paired again", async () => {
  const tg = await botApi();
  const kv = memKv();
  await kv.set("assistant-reminders", JSON.stringify([{ id: "a1b2c3d6", at: Date.now() - 1000, text: "sacar la basura", held: false, tries: 0 }]), 3600);
  const p = await localPako({ api: tg.api, kv });
  try {
    await pairPhone(p, tg);
    assert.deepEqual((await p.post("/panel/api/telegram/token", { token: OTHER })).body, { ok: true, bot: "pako_other_bot" });
    assert.deepEqual((await p.get("/panel/api/telegram")).body, { state: "unpaired", bot: "pako_other_bot" });
    await p.inbox();
    assert.ok(await until(async () => (await p.chat()).some((m) => m.text === "Reminder: sacar la basura")));
    assert.equal(tg.sent(OTHER).length, 0, "the new bot writes to no one");
    // The old bot's poller stopped when the new one started: one bot polls at a time. Its request in flight was closed, and for longer
    // than two of the stand-in's long polls (1.1 s each) not one more is asked: a poller left running would ask twice in that time.
    assert.ok(await until(() => tg.holding(GOOD) === 0), "the first bot's long poll was let go");
    const oldPolls = tg.asked("getUpdates", GOOD);
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(tg.asked("getUpdates", GOOD), oldPolls, "the first bot's poller has stopped");
    assert.equal(tg.holding(GOOD), 0);
    assert.ok(tg.asked("getUpdates", OTHER) > 0, "and the new bot's runs");
    assert.deepEqual((await p.post("/panel/api/telegram/token", { token: GOOD })).body, { ok: true, bot: "pako_test_bot" });
    assert.deepEqual((await p.get("/panel/api/telegram")).body, { state: "paired", bot: "pako_test_bot", account: "Marta (@marta)" });
  } finally {
    p.close();
    tg.close();
  }
});

test("a bot a server already uses (a webhook): its token is refused in the panel, nothing is kept, and the bot in use stays; never deleteWebhook", async () => {
  const tg = await botApi();
  const p = await localPako({ api: tg.api });
  const english = await localPako({ api: tg.api });
  try {
    tg.hook(OTHER); // the bot of a hosted Pako: the one token its owner already has
    const refused = await p.post("/panel/api/telegram/token", { token: OTHER });
    assert.deepEqual(refused, {
      status: 200,
      body: {
        ok: false,
        error: "That bot is already used by a server or by another Pako, and its messages go there, not to this computer. Make a new one "
          + "for this computer: send /newbot to @BotFather and paste its token here.",
      },
    });
    assert.equal("telegramBotToken" in p.secrets(), false, "not kept: the next start has no dead bot");
    assert.deepEqual((await p.get("/panel/api/telegram")).body, { state: "no-token" });
    assert.equal(tg.asked("getUpdates", OTHER), 0, "never polled: another Pako's poll would be cut");
    assert.equal(
      (await english.post("/panel/api/telegram/token", { token: OTHER })).body.error,
      "That bot is already used by a server or by another Pako, and its messages go there, not to this computer. Make a new one for this computer: "
        + "send /newbot to @BotFather and paste its token here.",
    );
    // With a bot of its own in use, pasting the hosted one changes nothing.
    await pairPhone(p, tg);
    assert.equal((await p.post("/panel/api/telegram/token", { token: OTHER })).body.ok, false);
    assert.equal(p.secrets().telegramBotToken, GOOD);
    assert.deepEqual((await p.get("/panel/api/telegram")).body, { state: "paired", bot: "pako_test_bot", account: "Marta (@marta)" });
    // The hosted Pako is never cut off from Telegram: the webhook is only asked about.
    assert.equal(tg.calls.filter((c) => c.method === "deleteWebhook" || c.method === "setWebhook").length, 0);
    assert.ok(tg.asked("getWebhookInfo", OTHER) >= 3);
    // Telegram not saying whether there is a webhook does not block a good bot: taken, as before.
    tg.hook(OTHER, false);
    tg.hookInfo(false);
    assert.deepEqual((await p.post("/panel/api/telegram/token", { token: OTHER })).body, { ok: true, bot: "pako_other_bot" });
  } finally {
    p.close();
    english.close();
    tg.close();
  }
});

test("a kept bot that cannot be polled (a webhook set since, another Pako polling it): the card says why and asks for another bot, never a QR or 'connected'", async () => {
  const tg = await botApi();
  const kv = memKv();
  const dir = join(mkdtempSync(join(tmpdir(), "pako-tgpanel-")), "home");
  const why = "That bot is already used by a server or by another Pako, and its messages go there, not to this computer. Make a new one "
    + "for this computer: send /newbot to @BotFather and paste its token here.";
  const telegramLine = async (p: LocalPako) => ((await p.overview()).integrations as Body[]).find((i) => i.key === "telegram");
  // Paired while the bot was this computer's own; then the same token is given a webhook (pasted into a hosted Pako).
  const first = await localPako({ api: tg.api, dir, kv });
  try {
    await pairPhone(first, tg);
    assert.deepEqual(await telegramLine(first), { key: "telegram", name: "Telegram", on: true, detail: "Connected" });
  } finally {
    first.close();
  }
  tg.hook(GOOD);
  const second = await localPako({ api: tg.api, dir, kv });
  try {
    const before = tg.asked("getUpdates", GOOD);
    second.telegram.start(); // server.ts, once listening: the first getUpdates is answered 409
    assert.ok(await until(async () => (await second.get("/panel/api/telegram")).body.state === "no-token"), "the dead bot is not shown as connected");
    assert.deepEqual((await second.get("/panel/api/telegram")).body, { state: "no-token", why });
    assert.deepEqual(await second.post("/panel/api/telegram/link"), { status: 409, body: { error: why } });
    assert.deepEqual(await telegramLine(second), { key: "telegram", name: "Telegram", on: false, detail: "Not set up" });
    assert.equal(tg.asked("getUpdates", GOOD), before + 1, "one try, then it stops asking");
    // A bot of this computer's own, set in the panel, takes its place at once; the reason goes.
    assert.deepEqual((await second.post("/panel/api/telegram/token", { token: OTHER })).body, { ok: true, bot: "pako_other_bot" });
    assert.deepEqual((await second.get("/panel/api/telegram")).body, { state: "unpaired", bot: "pako_other_bot" });
    assert.equal((await second.post("/panel/api/telegram/link")).status, 200);
  } finally {
    second.close();
  }
  // The same for a bot the settings name (TELEGRAM_BOT_TOKEN): said, and marked as not the panel's to change.
  tg.hook(ENV_BOT);
  const third = await localPako({ api: tg.api, env: { TELEGRAM_BOT_TOKEN: ENV_BOT } });
  try {
    third.telegram.start();
    assert.ok(await until(async () => (await third.get("/panel/api/telegram")).body.state === "no-token"));
    assert.deepEqual((await third.get("/panel/api/telegram")).body, { state: "no-token", why, fixed: true });
  } finally {
    third.close();
    tg.close();
  }
});

test("the channel remembers why its poll ended by itself (a webhook at once, another poller after a few tries), and forgets it when polled again", async () => {
  const tg = await botApi();
  const channel = (token: string) =>
    createTelegram({ config: { token, ownerId: null, api: tg.api }, kv: null, ingest: async () => "ok", pollSeconds: 0, pauseMs: 1 });
  try {
    const hooked = channel(GOOD);
    assert.equal(hooked.pollStopped(), null, "never polled");
    assert.equal(await hooked.hasWebhook(), false);
    tg.hook(GOOD);
    assert.equal(await hooked.hasWebhook(), true);
    hooked.poll();
    assert.ok(await until(() => hooked.pollStopped() === "webhook"));
    assert.equal(tg.asked("getUpdates", GOOD), 1);
    // The webhook is taken away (the server was given another bot): polling again works, and the reason goes.
    tg.hook(GOOD, false);
    const again = hooked.poll();
    assert.equal(hooked.pollStopped(), null);
    assert.ok(await until(() => tg.asked("getUpdates", GOOD) > 2));
    again.stop();
    assert.equal(hooked.pollStopped(), null, "stopped on purpose is no reason");

    tg.pollElsewhere(OTHER);
    const twice = channel(OTHER);
    twice.poll();
    assert.ok(await until(() => twice.pollStopped() === "conflict"));
    assert.equal(tg.asked("getUpdates", OTHER), 6, "a few tries first: a restart a moment ago passes");
    tg.hookInfo(false);
    assert.equal(await twice.hasWebhook(), null, "no clear answer");
    assert.equal(await channel(UNKNOWN).hasWebhook(), null, "a token Telegram does not know");
  } finally {
    tg.close();
  }
});

test("TELEGRAM_BOT_TOKEN wins over the token kept from the panel: the panel cannot change it, and pairs that bot with its QR", async () => {
  const tg = await botApi();
  const p = await localPako({ api: tg.api, env: { TELEGRAM_BOT_TOKEN: ENV_BOT }, savedToken: GOOD });
  try {
    assert.deepEqual((await p.get("/panel/api/telegram")).body, { state: "unpaired", bot: "pako_env_bot", fixed: true }, "fixed: the card offers no other bot");
    assert.equal(tg.asked("getMe", GOOD), 0, "the kept token is not even tried");
    const set = await p.post("/panel/api/telegram/token", { token: OTHER });
    assert.deepEqual(set.body, { ok: false, error: "This Pako uses the bot in TELEGRAM_BOT_TOKEN, in its settings: to change it, change it there." });
    assert.equal(tg.asked("getMe", OTHER), 0);
    assert.equal(p.secrets().telegramBotToken, GOOD, "nothing changed");
    assert.match((await p.post("/panel/api/telegram/link")).body.link, /^https:\/\/t\.me\/pako_env_bot\?start=/);
    p.telegram.start();
    assert.ok(await until(() => tg.asked("getUpdates", ENV_BOT) > 0));
    assert.equal(tg.asked("getUpdates", GOOD), 0);
  } finally {
    p.close();
    tg.close();
  }
});

test("English: the panel's errors, the pairing on Telegram, the notice in the panel's chat and the panel's line are in English", async () => {
  const tg = await botApi();
  const p = await localPako({ api: tg.api });
  try {
    assert.equal((await p.post("/panel/api/telegram/token", { token: "nope" })).body.error, "That doesn't look like a bot token. Copy the whole one @BotFather gave you: digits, a colon, then letters.");
    assert.equal((await p.post("/panel/api/telegram/link")).body.error, "Set your bot's token first.");
    await pairPhone(p, tg);
    assert.ok(await until(() => tg.sent().some((m) => m.text === "Done: we can talk on Telegram now too. Write to me here whenever you like, as in your other chat.")));
    assert.ok(await until(async () => (await p.chat()).some((m) => m.text === "Telegram connected: the account “Marta” (@marta, id 7001) now talks to me. If that wasn't you, type TELEGRAM OFF here.")));
    assert.equal((await p.overview()).integrations.find((i: Body) => i.key === "telegram").detail, "Connected");
    tg.queue(GOOD, tg.text(STRANGER_TG, "hello?"));
    assert.ok(await until(() => tg.sent().some((m) => m.chat_id === STRANGER_TG && m.text === "This bot is a private assistant.")));
  } finally {
    p.close();
    tg.close();
  }
});

test("a newer link makes the earlier unused one worthless: only the code shown last pairs a phone", async () => {
  const tg = await botApi();
  const p = await localPako({ api: tg.api });
  try {
    assert.equal((await p.post("/panel/api/telegram/token", { token: GOOD })).body.ok, true);
    const codeOf = (link: string): string => /start=(.+)$/.exec(link)![1]!;
    const first = codeOf((await p.post("/panel/api/telegram/link")).body.link as string);
    const second = codeOf((await p.post("/panel/api/telegram/link")).body.link as string);
    assert.notEqual(first, second);
    // The first code (a screenshot of the earlier QR, in someone else's hands) opens nothing.
    tg.queue(GOOD, tg.text(STRANGER_TG, `/start ${first}`));
    assert.ok(await until(() => tg.sent().some((m) => m.chat_id === STRANGER_TG)));
    assert.equal(tg.sent().filter((m) => m.chat_id === STRANGER_TG).at(-1)!.text, "That link doesn't work or has expired. Ask for a new one: type TELEGRAM in your chat with Pako.");
    assert.equal((await p.get("/panel/api/telegram")).body.state, "unpaired");
    // The one shown last still pairs.
    tg.queue(GOOD, tg.text(OWNER_TG, `/start ${second}`));
    assert.ok(await until(async () => (await p.get("/panel/api/telegram")).body.state === "paired"));
  } finally {
    p.close();
    tg.close();
  }
});

test("TELEGRAM typed in the panel's chat with no bot yet: Pako says to connect it from the panel's Telegram card, in English; HELP lists it", async () => {
  const tg = await botApi();
  for (const [said, help] of [
    ["Telegram isn't connected yet. Connect it from the Telegram card in this panel: paste your bot's token and scan the QR code with your phone.",
      "• TELEGRAM: talk to me on Telegram too (TELEGRAM OFF disconnects it)"],
  ] as const) {
    const p = await localPako({ api: tg.api });
    try {
      assert.equal((await p.type("telegram")).status, 202);
      assert.ok(await until(async () => (await p.chat()).some((m) => m.who === "pako" && m.text === said)), JSON.stringify(await p.chat()));
      assert.deepEqual(await p.inbox(), [], "answered by the server: nothing waits for the assistant");
      await p.type("HELP");
      assert.ok(await until(async () => (await p.chat()).some((m) => m.who === "pako" && m.text.includes(help))));
      // With a bot, the word gives the link as always.
      assert.equal((await p.post("/panel/api/telegram/token", { token: GOOD })).body.ok, true);
      await p.type("TELEGRAM");
      assert.ok(await until(async () => (await p.chat()).some((m) => m.who === "pako" && /https:\/\/t\.me\/pako_test_bot\?start=/.test(m.text))));
    } finally {
      p.close();
    }
  }
  tg.close();
});

test("the panel's list of connections is in English", async () => {
  const tg = await botApi();
  const p = await localPako({ api: tg.api });
  try {
    const parts = async (): Promise<string[]> => ((await p.overview()).integrations as Body[]).map((i) => `${i.key}: ${i.name} / ${i.detail}`);
    assert.deepEqual(await parts(), [
      "whatsapp: Chat / In this panel",
      "mac: Brain / Claude on this computer",
      "phone: Phone / Not set up",
      "mail: Mail / Not set up",
      "calendar: Calendar / Not set up",
      "slack: Slack / Not set up",
      "zoom: Zoom / Off",
      "telegram: Telegram / Not set up",
    ]);
  } finally {
    p.close();
    tg.close();
  }
});

test("closed: every route needs the panel's session, a POST also the x-pako header; a server's panel answers 404 to all of them", async () => {
  const tg = await botApi();
  const p = await localPako({ api: tg.api });
  try {
    const routes = ["/panel/api/telegram/token", "/panel/api/telegram/link", "/panel/api/telegram/off"];
    assert.equal((await p.get("/panel/api/telegram", {})).status, 401);
    for (const r of routes) {
      assert.equal((await p.post(r, { token: GOOD }, { "x-pako": "1" })).status, 401, `${r} without the session`);
      assert.equal((await p.post(r, { token: GOOD }, { cookie: (await signedCookie(p)) })).status, 401, `${r} without the header`);
    }
    assert.equal(tg.calls.length, 0, "nothing reached Telegram");
    assert.equal(p.secrets().telegramBotToken, undefined);
  } finally {
    p.close();
  }
  // A server (WhatsApp set up, on Render): Telegram is a setting there; the panel's routes are not there at all.
  const env: Env = {
    WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value", WHATSAPP_PHONE_NUMBER_ID: "109876543210", WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
    WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789", ASSISTANT_BRIDGE_TOKEN: "b".repeat(48), RENDER: "true", RENDER_EXTERNAL_URL: "https://pako.example.com",
    PERSONAL_OWNER_NAME: "Marta", PERSONAL_OWNER_NUMBER: "+34600111222", PERSONAL_CALLER_TOKEN: "t".repeat(32), TELEGRAM_BOT_TOKEN: GOOD, TELEGRAM_API_URL: tg.api,
  };
  const app = createApp(loadAppConfig(env), env);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await fetch((app.locals.panelLink as () => string)().replace(/^https:\/\/pako\.example\.com/, base));
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    assert.equal((await fetch(`${base}/panel/api/overview`, { headers: { cookie } })).status, 200, "signed in to the server's panel");
    for (const headers of [{ cookie, "x-pako": "1" }, {}] as Record<string, string>[]) {
      assert.equal((await fetch(`${base}/panel/api/telegram`, { headers })).status, 404);
      for (const path of ["token", "link", "off"]) {
        const r = await fetch(`${base}/panel/api/telegram/${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ token: OTHER }) });
        assert.equal(r.status, 404, path);
      }
    }
    // As before: the server's Telegram is the one in TELEGRAM_BOT_TOKEN, with its webhook, and the panel's line says to write TELEGRAM.
    assert.equal(typeof (app.locals.telegram as { start?: unknown }).start, "function");
    assert.equal((await fetch(`${base}/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
    const view = (await (await fetch(`${base}/panel/api/overview`, { headers: { cookie } })).json()) as Body;
    assert.deepEqual(view.integrations.find((i: Body) => i.key === "telegram"), { key: "telegram", name: "Telegram", on: false, detail: "Type TELEGRAM in the chat" });
    assert.equal(tg.asked("getMe", OTHER), 0);
  } finally {
    server.close();
    server.closeAllConnections();
    tg.close();
  }
});

/** A fresh session cookie for the same panel (the rig's own, read back from a new sign-in link). */
async function signedCookie(p: LocalPako): Promise<string> {
  const login = await fetch((p.app.locals.panelLink as () => string)().replace(/^http:\/\/127\.0\.0\.1:\d+/, p.base));
  return (login.headers.get("set-cookie") ?? "").split(";")[0]!;
}

// ---------- the door itself, with a stand-in Telegram: what counts as started by Pako ----------

/** A stand-in Telegram channel for the door: what it was given, and whether it is paired or refusing. */
function fakeTelegram() {
  const got: Body[] = [];
  const state = { paired: true, refusing: false };
  const door: TelegramDoor = {
    paired: async () => state.paired,
    reachable: async () => state.paired,
    deliver: async (body) => {
      if (!state.paired || state.refusing) return false;
      got.push(body);
      return true;
    },
    pairLink: async () => null,
    unpair: async () => true,
    farewell: async () => undefined,
    media: async () => null,
  };
  const words = (b: Body): string => (b.type === "text" ? String(b.text.body) : String(b.interactive?.body?.text));
  return { door, got, state, said: () => got.map(words) };
}

const BRIDGE = "k".repeat(48);
/** The door as src/app.ts builds it in local mode: the panel's chat is its own chat, and Telegram beside it. */
async function localDoor() {
  const kv = memKv();
  const memory = loadMemory(kv);
  const channel = createLocalChannel({ kv });
  const tg = fakeTelegram();
  const config: WhatsappConfig = {
    accessToken: "local", phoneNumberId: "0", appSecret: "s".repeat(48), verifyToken: "s".repeat(48), bridgeToken: BRIDGE,
    ownerDigits: LOCAL_OWNER_NUMBER.replace(/\D/g, ""), ownerBsuid: "", graphVersion: "v23.0", templateName: "", templateLang: "en", friendMessages: false, reminderTemplate: "",
  };
  const app = express();
  const door = mountWhatsapp(app, {
    // A receipt waits for its reply up to 5 s: the replies here come right after their notes, but a loaded machine can take more than a
    // few ms between two requests, and the receipt would go first (no test here waits for the time to run out).
    config, memory, kv, ownerName: "Marta", timeZone: "Europe/Madrid", contacts: () => ["Ana"], local: channel, telegram: tg.door, receiptWaitMs: 5000,
    control: createControl(kv), tools: loadVoiceTools({ memory, actions: { contacts: () => ["Ana"], callContact: async () => ({ ok: true, text: "" }), lookupCall: async () => "" } }),
    fetch: (async () => { throw new Error("nothing goes to Meta in local mode"); }) as typeof fetch,
  });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: Body) =>
    fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${BRIDGE}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  let n = 0;
  return {
    door, tg, channel, post,
    /** The owner writes in the panel's chat, or on Telegram. */
    fromPanel: (text: string) => door.ingest({ from: door.ownerFrom, id: `local-${++n}`, type: "text", text: { body: text } }),
    fromPhone: (text: string) => door.ingest({ from: door.ownerFrom, id: `tg-7001-${++n}`, type: "text", text: { body: text } }, "telegram"),
    press: (id: string, channel: "base" | "telegram") =>
      door.ingest({ from: door.ownerFrom, id: channel === "base" ? `local-p${++n}` : `tg-cb-${++n}`, type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: "" } } }, channel),
    chat: () => channel.list(0),
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

test("the door, on a computer: a receipt that answers nothing and a connector's card go to the phone with a copy in the panel, buttons and all", async () => {
  const r = await localDoor();
  try {
    // An older bridge's notes, sent with no answer to go with: started by Pako.
    assert.equal((await r.post("/assistant/memory", { remember: ["la clave del wifi es pez espada"] })).status, 200);
    const card = r.tg.got.at(-1)!;
    assert.equal(card.type, "interactive");
    const undo = card.interactive.action.buttons[0].reply as { id: string; title: string };
    assert.match(undo.id, /^u1:[0-9a-f]{10}$/);
    const copy = (await r.chat()).at(-1)!;
    assert.deepEqual([copy.text, copy.via, copy.buttons], [card.interactive.body.text, "telegram", [{ id: undo.id, title: "Undo" }]]);

    // The same, with the answer it belongs to: where the owner wrote (the panel), and nothing to the phone.
    const before = r.tg.got.length;
    await r.fromPanel("apunta que el dentista es el martes");
    await r.post("/assistant/memory", { remember: ["el dentista es el martes"], key: "local-1" });
    await r.post("/assistant/reply", { key: "local-1", text: "Apuntado." });
    assert.equal(r.tg.got.length, before);
    const last = (await r.chat()).slice(-2);
    assert.deepEqual(last.map((m) => [m.text.split("\n")[0], m.via]), [["Apuntado.", undefined], [last[1]!.text.split("\n")[0], undefined]]);
    assert.match(last[1]!.buttons?.[0]?.id ?? "", /^u1:/);

    // A connector's card: on the phone, said to be there, and its copy works from the panel (once).
    const placed: string[] = [];
    const ask: OwnerAsk = { name: "Ana", card: "Claude pide llamar a Ana.\n¿Llamo?", place: async () => (placed.push("Ana"), { ok: true, text: "Call to Ana started." }), closed: () => undefined };
    assert.deepEqual(await r.door.askCall(ask), { ok: true, where: "on Telegram" });
    const k = r.tg.got.at(-1)!;
    const yes = k.interactive.action.buttons[0].reply.id as string;
    assert.match(yes, /^k1:[0-9a-f]{10}$/);
    const kCopy = (await r.chat()).at(-1)!;
    assert.deepEqual([kCopy.text, kCopy.via, kCopy.buttons?.map((b) => b.id)], ["Claude pide llamar a Ana.\n¿Llamo?", "telegram", [yes, yes.replace("k1", "k0")]]);
    await r.press(yes, "base");
    assert.deepEqual(placed, ["Ana"]);
    await r.press(yes, "telegram");
    assert.deepEqual(placed, ["Ana"], "the same card pressed on the phone after the panel places nothing");
    assert.equal(r.tg.said().at(-1), "That card has already been answered: nothing more to do.");
  } finally {
    r.close();
  }
});

test("the door, on a computer: Telegram refusing falls back to the panel once, unmarked; unpaired, the panel only; written on Telegram, a word with no key goes back there", async () => {
  const r = await localDoor();
  try {
    assert.equal(await r.door.notifyOwner("Aviso uno"), "sent");
    assert.deepEqual(r.tg.said(), ["Aviso uno"]);
    assert.deepEqual((await r.chat()).map((m) => [m.text, m.via]), [["Aviso uno", "telegram"]]);
    r.tg.state.refusing = true;
    assert.equal(await r.door.notifyOwner("Aviso dos"), "sent");
    assert.deepEqual((await r.chat()).filter((m) => m.text === "Aviso dos").map((m) => m.via ?? "panel"), ["panel"], "once, in the panel, unmarked");
    r.tg.state.refusing = false;
    r.tg.state.paired = false;
    assert.equal(await r.door.notifyOwner("Aviso tres"), "sent");
    assert.deepEqual((await r.chat()).filter((m) => m.text === "Aviso tres").map((m) => m.via ?? "panel"), ["panel"]);
    assert.deepEqual(r.tg.said(), ["Aviso uno"]);
    r.tg.state.paired = true;
    // The owner last wrote on Telegram: the bridge's words with no key go there, and the panel keeps no copy (they answer the owner).
    await r.fromPhone("¿sigues ahí?");
    await r.post("/assistant/reply", { text: "Un momento…" });
    assert.equal(r.tg.said().at(-1), "Un momento…");
    assert.ok(!(await r.chat()).some((m) => m.text === "Un momento…"));
    // A notice the bridge marks as one (an email) is started by Pako: the phone, and the copy.
    await r.post("/assistant/reply", { text: "📧 Correo de Luis", notice: true });
    assert.equal(r.tg.said().at(-1), "📧 Correo de Luis");
    assert.equal((await r.chat()).at(-1)!.via, "telegram");
  } finally {
    r.close();
  }
});

test("the door, on a server: what Pako starts still goes where the owner last wrote (WhatsApp while its 24 hours last, then Telegram), and nothing is copied", async () => {
  const sent: Body[] = [];
  const clock = { now: Date.parse("2026-11-14T12:00:00Z") };
  const kv = memKv();
  const memory = loadMemory(kv);
  const tg = fakeTelegram();
  const config = loadWhatsappConfig({
    WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value", WHATSAPP_PHONE_NUMBER_ID: "109876543210", WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
    WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789", ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
  }, "+34600111222").config!;
  const door = mountWhatsapp(express(), {
    config, memory, kv, ownerName: "Marta", timeZone: "Europe/Madrid", contacts: () => ["Ana"], telegram: tg.door, now: () => clock.now,
    tools: loadVoiceTools({ memory, actions: { contacts: () => ["Ana"], callContact: async () => ({ ok: true, text: "" }), lookupCall: async () => "" } }),
    fetch: (async (_u: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as Body);
      return new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }), { status: 200 });
    }) as typeof fetch,
  });
  await door.ingest({ from: config.ownerDigits, id: "wamid.1", type: "text", text: { body: "hola" } });
  assert.equal(await door.notifyOwner("Aviso"), "sent");
  assert.equal(sent.at(-1)?.text?.body, "Aviso", "WhatsApp, its window open");
  const ask: OwnerAsk = { name: "Ana", card: "¿Llamo a Ana?", place: async () => ({ ok: true, text: "" }), closed: () => undefined };
  assert.deepEqual(await door.askCall(ask), { ok: true, where: "on WhatsApp" });
  assert.deepEqual(tg.got, [], "Telegram had nothing while WhatsApp could take it");
  clock.now += 25 * 3600_000;
  assert.equal(await door.notifyOwner("Aviso tarde"), "sent");
  assert.deepEqual(tg.said(), ["Aviso tarde"], "Telegram once WhatsApp's 24 hours are over");
});

test("the card: another bot can be used once one is set (ready, code, expired, paired), unless a setting decides it; a bot that cannot be used shows why", async () => {
  const js = readFileSync(new URL("../src/panel/app.js", import.meta.url), "utf8");
  const { WORDS } = (await import(new URL("../src/panel/i18n.js", import.meta.url).href)) as { WORDS: Record<string, string> };
  assert.deepEqual([WORDS["tg.otherBot"], WORDS["tg.keepBot"]], ["Use another bot", "Keep this bot"]);
  // The steps (with the token form, which posts to /token and so replaces the bot) come back on request, whatever the state.
  assert.match(js, /if \(tg\.other && tg\.state !== "no-token"\) return "steps";/);
  assert.match(js, /const other = tg\.fixed \? null\n\s+: h\("button", \{ type: "button", class: "tg-other"[^\n]+t\("tg\.otherBot"\)\);/, "not offered when TELEGRAM_BOT_TOKEN decides");
  for (const view of ["ready", "expired", "paired"]) {
    const body = new RegExp(`if \\(view === "${view}"\\)[^\\n]*(?:\\n(?!  if \\(view|  return \\[\\];)[^\\n]*)*`).exec(js)?.[0] ?? "";
    assert.match(body, /, other\]\.filter\(Boolean\);/, `${view}: the way to another bot`);
  }
  assert.match(js, /t\("tg\.waiting"\)\)\)\),\n\s+other,\n\s+\]\.filter\(Boolean\);/, "code: the way to another bot");
  assert.match(js, /tg\.other \? button\("ghost", t\("tg\.keepBot"\)/, "and the way back");
  // What the server says about a bot it cannot use here: kept, shown above the steps, and the steps are on show without a press.
  assert.match(js, /tg\.why = tg\.state === "no-token" && typeof s\.why === "string" \? s\.why\.trim\(\)\.slice\(0, 400\) : "";/);
  assert.match(js, /tg\.fixed = s\.fixed === true;/);
  assert.match(js, /tg\.why && !tg\.other \? h\("p", \{ class: "tg-error", role: "alert" \}, tg\.why\) : null,/);
  assert.match(js, /return tg\.expanded \|\| tg\.why \? "steps" : "intro";/);
});
