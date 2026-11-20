// Telegram as a second chat (src/telegram.ts) wired to the real WhatsApp door (src/whatsapp.ts) as src/app.ts wires them, with stand-ins for
// Meta's and Telegram's servers. Nothing here reaches the network.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { createApp, loadAppConfig } from "../src/app.ts";
import { createControl, type Control } from "../src/control.ts";
import type { Kv } from "../src/kv.ts";
import { createTelegram, loadTelegramConfig, telegramHtml } from "../src/telegram.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";
import { loadWhatsappConfig, mountWhatsapp, type OwnerAsk } from "../src/whatsapp.ts";

// A made-up token in the shape @BotFather gives: it opens nothing.
const TOKEN = `123456789:${"A".repeat(35)}`;
const OWNER = "+34600111222";
const OWNER_WA = "34600111222";
const OWNER_TG = 7001;
const STRANGER_TG = 7002;
const ENV = {
  WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
};
type Body = Record<string, any>;

/** A stand-in for Telegram's Bot API: what was asked of it, and answers it can be told to give. */
function fakeTelegram(o: { refuse?: (method: string, params: Body) => { status: number; error_code: number; description: string } | null } = {}) {
  const calls: { method: string; params: Body }[] = [];
  let updates: Body[] = [];
  const files = new Map<string, Buffer>();
  let message = 100;
  const json = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status });
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const file = /^https:\/\/tg\.test\/file\/bot[^/]+\/(.+)$/.exec(u);
    if (file) {
      const bytes = files.get(file[1]!);
      return bytes ? new Response(new Uint8Array(bytes), { status: 200 }) : new Response("no", { status: 404 });
    }
    const m = /^https:\/\/tg\.test\/bot([^/]+)\/(\w+)$/.exec(u);
    if (!m || m[1] !== TOKEN) return json({ ok: false, error_code: 401, description: "Unauthorized" }, 401);
    const method = m[2]!;
    const params = init?.body ? (JSON.parse(String(init.body)) as Body) : {};
    calls.push({ method, params });
    const refused = o.refuse?.(method, params) ?? null;
    if (refused) return json({ ok: false, error_code: refused.error_code, description: refused.description }, refused.status);
    switch (method) {
      case "getMe":
        return json({ ok: true, result: { id: 1, is_bot: true, username: "pako_test_bot" } });
      case "sendMessage":
        return json({ ok: true, result: { message_id: ++message } });
      case "getFile":
        return json({ ok: true, result: { file_id: params.file_id, file_path: "voice/file_1.oga", file_size: 12 } });
      case "getUpdates": {
        const offset = Number(params.offset ?? 0);
        updates = updates.filter((x) => x.update_id >= offset); // the ones before the offset are confirmed
        return json({ ok: true, result: updates });
      }
      default:
        return json({ ok: true, result: true });
    }
  }) as typeof fetch;
  return {
    f,
    calls,
    files,
    queue: (u: Body) => void updates.push(u),
    sent: () => calls.filter((c) => c.method === "sendMessage").map((c) => c.params),
    texts: () => calls.filter((c) => c.method === "sendMessage").map((c) => String(c.params.text)),
  };
}

/** A store in memory; `failSet` makes writes of matching keys fail (a blip in the real store). */
function fakeKv(failSet: (key: string, value: string) => boolean = () => false): Kv & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    m,
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => {
      if (failSet(k, v)) throw new Error("store down");
      m.set(k, v);
    },
  };
}

let n = 0;
type Refuse = (method: string, params: Body) => { status: number; error_code: number; description: string } | null;
async function rig(o: { ownerId?: number; control?: Control; refuse?: Refuse; failSet?: (key: string, value: string) => boolean } = {}) {
  const tg = fakeTelegram(o.refuse ? { refuse: o.refuse } : {});
  const waSent: Body[] = [];
  const waFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.body) waSent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }), { status: 200 });
  }) as typeof fetch;
  const clock = { now: Date.parse("2026-11-14T12:00:00Z") };
  const memory = loadMemory(null);
  const kv = fakeKv(o.failSet);
  const tools = loadVoiceTools({ memory, actions: { contacts: () => ["Ana"], callContact: async () => ({ ok: true, text: "started" }), lookupCall: async () => "ok" } });
  const doorRef: { ingest: ((m: Body, channel?: "base" | "telegram") => Promise<string>) | null; from: string; tell: ((t: string) => Promise<void>) | null } =
    { ingest: null, from: "", tell: null };
  const telegram = createTelegram({
    config: { token: TOKEN, ownerId: o.ownerId ?? null, api: "https://tg.test" },
    kv,
    ingest: (m) => doorRef.ingest!({ from: doorRef.from, ...m }, "telegram"),
    onPaired: (who) => void doorRef.tell?.(`Telegram connected: the account ${who} now talks to me. If that wasn't you, type TELEGRAM OFF here.`),
    fetch: tg.f,
    now: () => clock.now,
    pollSeconds: 0,
    pauseMs: 20,
  });
  const config = loadWhatsappConfig(ENV, OWNER).config!;
  const app = express();
  const door = mountWhatsapp(app, {
    config, tools, memory, kv, ownerName: "Marta", timeZone: "Europe/Madrid", contacts: () => ["Ana"], fetch: waFetch, now: () => clock.now, callCheckMs: 5, telegram,
    ...(o.control ? { control: o.control } : {}),
  });
  doorRef.ingest = door.ingest;
  doorRef.from = door.ownerFrom;
  doorRef.tell = door.tellBase;
  telegram.mountWebhook(app, "/telegram/webhook");
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const secret = createHmac("sha256", TOKEN).update("pako-telegram-webhook").digest("hex");
  const hookTg = (update: Body, header: string | null = secret) =>
    fetch(`${base}/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json", ...(header === null ? {} : { "x-telegram-bot-api-secret-token": header }) }, body: JSON.stringify(update) });
  const tgText = (text: string, from = OWNER_TG, extra: Body = {}) =>
    hookTg({ update_id: ++n, message: { message_id: ++n, from: { id: from, is_bot: false, first_name: "Marta", username: "marta" }, chat: { id: from, type: "private" }, text, ...extra } });
  const tgPress = (data: string, from = OWNER_TG) =>
    hookTg({ update_id: ++n, callback_query: { id: `cb${++n}`, from: { id: from }, data, message: { message_id: 55, chat: { id: from, type: "private" } } } });
  const waText = (body: string, id = `wamid.${++n}`) => {
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: config.phoneNumberId }, messages: [{ from: OWNER_WA, id, timestamp: "1", type: "text", text: { body } }] } }] }],
    });
    return fetch(`${base}/whatsapp/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", config.appSecret).update(raw).digest("hex")}` }, body: raw });
  };
  const reply = (body: Body) => fetch(`${base}/assistant/reply`, { method: "POST", headers: { authorization: `Bearer ${config.bridgeToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const waTexts = () => waSent.filter((b) => b.type === "text").map((b) => String(b.text.body));
  /** The one-time link Pako gives on WhatsApp, and the owner opening it on Telegram. */
  const pair = async (): Promise<void> => {
    await waText("TELEGRAM");
    const code = /https:\/\/t\.me\/pako_test_bot\?start=([A-Za-z0-9_-]{24})/.exec(waTexts().at(-1) ?? "")?.[1];
    assert.ok(code, waTexts().at(-1) ?? "no link");
    await tgText(`/start ${code}`);
  };
  return { tg, waSent, waTexts, clock, kv, door, telegram, base, hookTg, tgText, tgPress, waText, reply, pair, close: () => { server.close(); server.closeAllConnections(); } };
}

test("config: off with no token; a wrong token or owner id is named, never shown; an owner id needs a token", () => {
  assert.deepEqual(loadTelegramConfig({}), { config: null, problems: [] });
  assert.match(loadTelegramConfig({ TELEGRAM_OWNER_ID: "123" }).problems.join(), /TELEGRAM_OWNER_ID is set but TELEGRAM_BOT_TOKEN is not/);
  const bad = loadTelegramConfig({ TELEGRAM_BOT_TOKEN: "not-a-token-secret-value", TELEGRAM_OWNER_ID: "@marta" });
  assert.equal(bad.config, null);
  assert.match(bad.problems.join("\n"), /TELEGRAM_BOT_TOKEN must be/);
  assert.match(bad.problems.join("\n"), /TELEGRAM_OWNER_ID must be/);
  assert.ok(!bad.problems.join().includes("not-a-token-secret-value"), "the value is never printed");
  assert.deepEqual(loadTelegramConfig({ TELEGRAM_BOT_TOKEN: ` ${TOKEN} `, TELEGRAM_OWNER_ID: "42" }).config, { token: TOKEN, ownerId: 42, api: "https://api.telegram.org" });
  // A Bot API server of your own: https anywhere, plain http only on this computer (the token travels in every address).
  assert.equal(loadTelegramConfig({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_API_URL: "http://localhost:8081/" }).config?.api, "http://localhost:8081");
  assert.match(loadTelegramConfig({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_API_URL: "http://bots.example.com" }).problems.join(), /TELEGRAM_API_URL must be/);
});

test("telegramHtml: WhatsApp's marks become Telegram's tags; everything else is escaped, so nothing the assistant wrote is a tag", () => {
  assert.equal(telegramHtml("*Hoy* _quizá_ ~no~ `x` y a<b> & c"), "<b>Hoy</b> <i>quizá</i> <s>no</s> <code>x</code> y a&lt;b&gt; &amp; c");
  assert.equal(telegramHtml("*_dos_*"), "<b><i>dos</i></b>");
  assert.equal(telegramHtml("marta_garcia@gmail.com 3*4 <script>"), "marta_garcia@gmail.com 3*4 &lt;script&gt;");
});

test("pairing: TELEGRAM on WhatsApp gives a one-time link; the account that opens it is the owner, and the owner is told on WhatsApp too", async () => {
  const r = await rig();
  try {
    await r.waText("TELEGRAM");
    const said = r.waTexts().at(-1)!;
    assert.match(said, /^To talk to me on Telegram too, open this link .* \(it works once, for 10 minutes\):\nhttps:\/\/t\.me\/pako_test_bot\?start=[A-Za-z0-9_-]{24}$/);
    const code = /start=([A-Za-z0-9_-]{24})/.exec(said)![1]!;
    assert.equal(await r.telegram.paired(), false);
    await r.tgText(`/start ${code}`);
    assert.equal(await r.telegram.paired(), true);
    assert.equal(r.tg.texts().at(-1), "Done: we can talk on Telegram now too. Write to me here whenever you like, as in your other chat.");
    assert.equal(r.waTexts().at(-1), "Telegram connected: the account “Marta” (@marta, id 7001) now talks to me. If that wasn't you, type TELEGRAM OFF here.");
    // The same link again, from someone else: used up.
    await r.tgText(`/start ${code}`, STRANGER_TG);
    assert.equal(r.tg.sent().at(-1)!.chat_id, STRANGER_TG);
    assert.equal(r.tg.texts().at(-1), "That link doesn't work or has expired. Ask for a new one: type TELEGRAM in your chat with Pako.");
    assert.equal(await r.telegram.paired(), true, "still the first account");
    const sends = r.tg.sent().length;
    await r.tgText("hola", STRANGER_TG);
    assert.equal(r.tg.sent().length, sends, "a stranger is told once, then nothing");
    assert.deepEqual(await r.door.inbox.peek(), [], "nothing a stranger wrote reaches the assistant (TELEGRAM itself is answered by the server)");
  } finally {
    r.close();
  }
});

test("pairing: a link is good for 10 minutes; groups and other bots are never the owner; TELEGRAM OFF unpairs, from either chat", async () => {
  const r = await rig();
  try {
    await r.waText("TELEGRAM");
    const code = /start=([A-Za-z0-9_-]{24})/.exec(r.waTexts().at(-1)!)![1]!;
    r.clock.now += 10 * 60_000 + 1;
    await r.tgText(`/start ${code}`);
    assert.equal(await r.telegram.paired(), false, "expired");
    await r.pair();
    const sends = r.tg.sent().length;
    await r.tgText("hola", OWNER_TG, { chat: { id: -100, type: "group" } });
    await r.tgText("hola", OWNER_TG, { from: { id: OWNER_TG, is_bot: true } });
    assert.equal(r.tg.sent().length, sends);
    assert.equal((await r.door.inbox.peek()).length, 0, "neither reached the assistant");
    await r.tgText("TELEGRAM OFF");
    assert.equal(r.tg.texts().at(-1), "Telegram disconnected: I won't write to you there any more. To connect it again, type TELEGRAM.", "said on Telegram, before it goes");
    assert.equal(await r.telegram.paired(), false);
    await r.tgText("¿sigues ahí?");
    assert.equal(r.tg.texts().at(-1), "This bot is a private assistant.");
    assert.equal((await r.door.inbox.peek()).length, 0);
  } finally {
    r.close();
  }
});

test("TELEGRAM_OWNER_ID: that account is the owner from its first message; another account cannot take the bot, even with a link", async () => {
  const r = await rig({ ownerId: OWNER_TG });
  try {
    await r.waText("TELEGRAM");
    const code = /start=([A-Za-z0-9_-]{24})/.exec(r.waTexts().at(-1)!)![1]!;
    await r.tgText(`/start ${code}`, STRANGER_TG);
    assert.equal(r.tg.texts().at(-1), "This bot is a private assistant.");
    assert.equal(await r.telegram.paired(), false);
    await r.tgText("hola, soy yo");
    assert.equal(await r.telegram.paired(), true);
    assert.deepEqual((await r.door.inbox.peek()).map((m) => m.text), ["hola, soy yo"]);
  } finally {
    r.close();
  }
});

test("routing: Pako answers where the owner wrote; what it starts goes where they wrote last, and to Telegram when WhatsApp's 24 hours are over", async () => {
  const r = await rig();
  try {
    await r.pair();
    await r.tgText("¿qué tengo hoy?");
    const fromTg = (await r.door.inbox.peek()).at(-1)!;
    assert.match(fromTg.id, /^tg-7001-\d+$/);
    await r.waText("y mañana?");
    const fromWa = (await r.door.inbox.peek()).at(-1)!;
    const wa = r.waTexts().length;
    const tg = r.tg.texts().length;
    await r.reply({ key: fromTg.id, text: "Hoy, dos reuniones." });
    await r.reply({ key: fromWa.id, text: "Mañana, libre." });
    assert.deepEqual(r.tg.texts().slice(tg), ["Hoy, dos reuniones."], "the answer to the Telegram message, on Telegram");
    assert.deepEqual(r.waTexts().slice(wa), ["Mañana, libre."], "and the WhatsApp one on WhatsApp");
    // Started by Pako: the last chat was WhatsApp, its window is open.
    assert.equal(await r.door.notifyOwner("Aviso uno"), "sent");
    assert.equal(r.waTexts().at(-1), "Aviso uno");
    // WhatsApp's 24 hours run out: Telegram, with no template and nothing held.
    r.clock.now += 25 * 3600_000;
    assert.equal(await r.door.notifyOwner("Aviso dos"), "sent");
    assert.equal(r.tg.texts().at(-1), "Aviso dos");
    assert.equal(r.waTexts().at(-1), "Aviso uno");
    // The owner writes on Telegram: Telegram is now the last chat, and WhatsApp's window stays closed (with Telegram gone, a notice is held).
    await r.tgText("ok");
    await r.door.notifyOwner("Aviso tres");
    assert.equal(r.tg.texts().at(-1), "Aviso tres");
    await r.waText("TELEGRAM OFF"); // this opens WhatsApp's window again, so it is checked from a fresh rig below
    assert.match(r.waTexts().at(-1)!, /^Telegram disconnected/);
  } finally {
    r.close();
  }
});

test("routing: with Telegram not paired, everything stays as before (a closed WhatsApp window still holds the notice)", async () => {
  const r = await rig();
  try {
    await r.waText("hola");
    r.clock.now += 25 * 3600_000;
    assert.equal(await r.door.notifyOwner("Aviso"), "held");
    assert.equal(r.tg.sent().length, 0);
  } finally {
    r.close();
  }
});

test("commands and STOP work on Telegram, answered there; Telegram's own /stop and /panel spellings too", async () => {
  const control = createControl(null);
  const r = await rig({ control });
  try {
    await r.pair();
    await r.tgText("/stop");
    assert.notEqual(await control.paused(), null);
    assert.match(r.tg.texts().at(-1)!, /^⏸ Stopped\./);
    await r.tgText("RESUME");
    assert.equal(await control.paused(), null);
    assert.match(r.tg.texts().at(-1)!, /Running again/);
    await r.tgText("LOG");
    assert.match(r.tg.texts().at(-1)!, /^What I've done lately:/);
  } finally {
    r.close();
  }
});

test("cards: a connector card goes to Telegram with inline buttons; the owner's press places it once, stops the spinner and takes the buttons away", async () => {
  const r = await rig();
  try {
    await r.pair();
    await r.tgText("hola");
    const placed: string[] = [];
    const closed: string[] = [];
    const ask: OwnerAsk = {
      name: "Ana",
      card: "Claude is asking to call Ana (from the connector, not from this chat).\nThe message: “llego tarde”\n\nCall? If you didn't ask for this, press Cancel.",
      place: async () => {
        placed.push("Ana");
        return { ok: true, text: "Call to Ana started: call_id=call_abc123, status=registered." };
      },
      closed: (why) => void closed.push(why),
    };
    assert.deepEqual(await r.door.askCall(ask), { ok: true, where: "on Telegram" });
    const card = r.tg.sent().at(-1)!;
    assert.equal(card.chat_id, OWNER_TG);
    assert.equal(card.parse_mode, "HTML");
    assert.deepEqual(card.link_preview_options, { is_disabled: true });
    const [yes, no] = card.reply_markup.inline_keyboard[0] as { text: string; callback_data: string }[];
    assert.deepEqual([yes!.text, no!.text], ["Call", "Cancel"]);
    assert.match(yes!.callback_data, /^k1:[0-9a-f]{10}$/);
    await r.tgPress(yes!.callback_data, STRANGER_TG);
    assert.deepEqual(placed, [], "someone else's press does nothing");
    await r.tgPress(yes!.callback_data);
    assert.deepEqual(placed, ["Ana"]);
    assert.ok(r.tg.texts().includes("Done, I'm calling Ana now."));
    const before = r.tg.texts().length;
    assert.ok(r.tg.calls.filter((c) => c.method === "answerCallbackQuery").length >= 2, "every press's spinner stops, a stranger's too");
    const edit = r.tg.calls.find((c) => c.method === "editMessageReplyMarkup")!;
    assert.deepEqual(edit.params, { chat_id: OWNER_TG, message_id: 55, reply_markup: { inline_keyboard: [] } });
    await r.tgPress(yes!.callback_data);
    assert.deepEqual(placed, ["Ana"], "a second press places nothing");
    assert.ok(r.tg.texts().slice(before).includes("That card has already been answered: nothing more to do."));
    assert.deepEqual(closed, []);
    const after = r.tg.texts().filter((t) => !/llamada a Ana/.test(t)).length; // the call watcher may report the outcome meanwhile
    await r.tgPress("../../etc");
    assert.equal(r.tg.texts().filter((t) => !/llamada a Ana/.test(t)).length, after, "data that is not a card id is ignored");
  } finally {
    r.close();
  }
});

test("voice notes from Telegram reach the assistant's computer like WhatsApp's: a short id, and the file through Pako", async () => {
  const r = await rig();
  try {
    await r.pair();
    r.tg.files.set("voice/file_1.oga", Buffer.from("OggS-voice"));
    await r.tgText("", OWNER_TG, { text: undefined, voice: { file_id: "AwACAgQAAxkBAAIB".repeat(6), mime_type: "audio/ogg", duration: 3 } });
    const note = (await r.door.inbox.peek()).at(-1)!;
    assert.match(note.audio!.id, /^tg_[0-9a-f]{16}$/);
    assert.equal(note.audio!.mime, "audio/ogg");
    const get = (id: string) => fetch(`${r.base}/assistant/media/${id}`, { headers: { authorization: `Bearer ${"b".repeat(48)}` } });
    const res = await get(note.audio!.id);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "audio/ogg");
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), "OggS-voice");
    assert.equal(r.tg.calls.find((c) => c.method === "getFile")!.params.file_id, "AwACAgQAAxkBAAIB".repeat(6));
    assert.equal((await get("tg_0000000000000000")).status, 404, "only a note still waiting");
    assert.equal(note.forwarded, undefined, "the owner's own voice note");
    // A forwarded voice note is someone else's words: the inbox says so, and the bridge marks its turn.
    await r.tgText("", OWNER_TG, { text: undefined, voice: { file_id: "AwACAgQAAxkBAAIC".repeat(6), mime_type: "audio/ogg" }, forward_date: 1 });
    assert.equal((await r.door.inbox.peek()).at(-1)!.forwarded, true);
  } finally {
    r.close();
  }
});

test("webhook: without Telegram's secret header nothing is taken", async () => {
  const r = await rig();
  try {
    await r.pair();
    for (const header of [null, "wrong", "a".repeat(64)]) {
      const res = await r.hookTg({ update_id: 1, message: { message_id: 1, from: { id: OWNER_TG }, chat: { id: OWNER_TG, type: "private" }, text: "STOP" } }, header);
      assert.equal(res.status, 401);
    }
    assert.equal((await r.door.inbox.peek()).length, 0);
  } finally {
    r.close();
  }
});

test("delivery: Telegram refusing (the owner blocked the bot) sends the answer on the other chat; text Telegram cannot read as HTML goes plain", async () => {
  let blocked = false;
  let badHtml = false;
  const r = await rig({
    refuse: (method, params) => {
      if (method !== "sendMessage") return null;
      if (blocked) return { status: 403, error_code: 403, description: "Forbidden: bot was blocked by the user" };
      if (badHtml && params.parse_mode === "HTML") return { status: 400, error_code: 400, description: "Bad Request: can't parse entities" };
      return null;
    },
  });
  try {
    await r.pair();
    await r.tgText("¿hora?");
    const id = (await r.door.inbox.peek()).at(-1)!.id;
    badHtml = true;
    await r.reply({ key: id, text: "Son *las diez*." });
    const plain = r.tg.sent().at(-1)!;
    assert.deepEqual([plain.text, plain.parse_mode], ["Son *las diez*.", undefined]);
    badHtml = false;
    blocked = true;
    const wa = r.waTexts().length;
    await r.reply({ key: id, text: "Otra cosa." });
    assert.deepEqual(r.waTexts().slice(wa), ["Otra cosa."]);
  } finally {
    r.close();
  }
});

test("polling (a computer with no public address): updates are taken in order and confirmed; stop() ends it; a webhook elsewhere stops it", async () => {
  const tg = fakeTelegram();
  const got: string[] = [];
  const telegram = createTelegram({
    config: { token: TOKEN, ownerId: OWNER_TG, api: "https://tg.test" },
    kv: null,
    ingest: async (m) => {
      got.push(String((m.text as { body?: string } | undefined)?.body));
      return "queued";
    },
    fetch: tg.f,
    pollSeconds: 0,
  });
  for (const [i, text] of ["uno", "dos"].entries()) {
    tg.queue({ update_id: 500 + i, message: { message_id: i + 1, from: { id: OWNER_TG }, chat: { id: OWNER_TG, type: "private" }, text } });
  }
  const p = telegram.poll();
  for (let i = 0; i < 100 && got.length < 2; i++) await new Promise((res) => setTimeout(res, 10));
  p.stop();
  assert.deepEqual(got, ["uno", "dos"]);
  await new Promise((res) => setTimeout(res, 30));
  const polls = tg.calls.filter((c) => c.method === "getUpdates");
  assert.ok(polls.some((c) => c.params.offset === 502), "both confirmed");
  const after = polls.length;
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(tg.calls.filter((c) => c.method === "getUpdates").length, after, "stopped");

  const busy = fakeTelegram({ refuse: (m) => (m === "getUpdates" ? { status: 409, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active" } : null) });
  const other = createTelegram({ config: { token: TOKEN, ownerId: null, api: "https://tg.test" }, kv: null, ingest: async () => "x", fetch: busy.f, pollSeconds: 0 });
  other.poll();
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(busy.calls.filter((c) => c.method === "getUpdates").length, 1, "one try, then it stops (and never deletes the other webhook)");
  assert.equal(busy.calls.filter((c) => c.method === "deleteWebhook").length, 0);
});

test("the app: on a server with a public address the webhook route is there (and closed without the secret); the panel lists Telegram", async () => {
  const env = {
    ...ENV, RENDER: "true", RENDER_EXTERNAL_URL: "https://pako.example.com", PERSONAL_OWNER_NAME: "Marta", PERSONAL_OWNER_NUMBER: OWNER,
    PERSONAL_CALLER_TOKEN: "t".repeat(32), TELEGRAM_BOT_TOKEN: TOKEN,
  };
  const app = createApp(loadAppConfig(env), env);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${base}/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 401);
    const handle = app.locals.telegram as { start(): void; stop(): void } | undefined;
    assert.equal(typeof handle?.start, "function", "server.ts starts it once listening");
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

// ---------- after the review: OFF that holds, pairing that is safe when the store fails, notices that are not lost ----------

test("OFF holds with TELEGRAM_OWNER_ID: the pinned account does not come back by itself; a fresh link brings it back, and the owner is told", async () => {
  const r = await rig({ ownerId: OWNER_TG });
  try {
    await r.waText("hola");
    await r.tgText("primera vez");
    assert.equal(await r.telegram.paired(), true);
    assert.match(r.waTexts().at(-1)!, /^Telegram connected: the account “Marta” \(@marta, id 7001\)/, "even a pinned account is announced");
    await r.waText("TELEGRAM OFF");
    assert.match(r.waTexts().at(-1)!, /^Telegram disconnected/);
    const inbox = (await r.door.inbox.peek()).length;
    await r.tgText("¿sigo aquí?");
    await r.tgText("/start");
    assert.equal(await r.telegram.paired(), false, "not by a message, not by a bare /start");
    assert.equal((await r.door.inbox.peek()).length, inbox, "nothing it wrote reached the assistant");
    await r.pair();
    assert.equal(await r.telegram.paired(), true, "a fresh link from the owner brings it back");
  } finally {
    r.close();
  }
});

test("OFF cancels a pending link, says so when nothing was paired, and warns when the store did not take it", async () => {
  const r = await rig();
  try {
    await r.waText("TELEGRAM");
    const code = /start=([A-Za-z0-9_-]{24})/.exec(r.waTexts().at(-1)!)![1]!;
    await r.waText("TELEGRAM OFF");
    assert.equal(r.waTexts().at(-1), "Telegram wasn't connected; if there was a link to connect it, it no longer works.");
    await r.tgText(`/start ${code}`);
    assert.equal(await r.telegram.paired(), false, "the link no longer works");
  } finally {
    r.close();
  }
  const broken = await rig({ failSet: (k) => k === "telegram-off" });
  try {
    await broken.pair();
    await broken.waText("TELEGRAM OFF");
    assert.match(broken.waTexts().at(-1)!, /^Telegram disconnected: .*\n\(I couldn't save it: if the server restarts, that account could talk to me again/);
    assert.equal(await broken.telegram.paired(), false, "forgotten here at once anyway");
  } finally {
    broken.close();
  }
});

test("pairing: a store that does not take the account pairs nobody; a link the store failed to forget still works only once", async () => {
  const r = await rig({ failSet: (k, v) => k === "telegram-owner" && v !== "" });
  try {
    await r.waText("TELEGRAM");
    const code = /start=([A-Za-z0-9_-]{24})/.exec(r.waTexts().at(-1)!)![1]!;
    const wa = r.waTexts().length;
    await r.tgText(`/start ${code}`);
    assert.equal(r.tg.texts().at(-1), "I couldn't save the connection. Ask for a new link: type TELEGRAM in your chat with Pako.");
    assert.equal(await r.telegram.paired(), false);
    assert.equal(r.waTexts().length, wa, "no notice for a pairing that did not happen");
  } finally {
    r.close();
  }
  const sticky = await rig({ failSet: (k, v) => k === "telegram-pair" && v === "" });
  try {
    await sticky.waText("TELEGRAM");
    const code = /start=([A-Za-z0-9_-]{24})/.exec(sticky.waTexts().at(-1)!)![1]!;
    await sticky.tgText(`/start ${code}`);
    assert.equal(await sticky.telegram.paired(), true);
    await sticky.tgText(`/start ${code}`, STRANGER_TG);
    assert.equal(sticky.tg.texts().at(-1), "That link doesn't work or has expired. Ask for a new one: type TELEGRAM in your chat with Pako.");
    assert.equal(sticky.tg.sent().filter((m) => m.chat_id === STRANGER_TG && /Listo/.test(String(m.text))).length, 0);
  } finally {
    sticky.close();
  }
});

test("pairing: the account being replaced is told first; with WhatsApp's 24 hours over, the owner's notice waits for them instead of being lost", async () => {
  const r = await rig();
  try {
    await r.pair();
    r.clock.now += 25 * 3600_000; // WhatsApp's window is closed now
    await r.tgText("TELEGRAM"); // asked for on Telegram, which does not reopen WhatsApp's window
    const code = /start=([A-Za-z0-9_-]{24})/.exec(r.tg.texts().at(-1)!)![1]!;
    const wa = r.waTexts().length;
    await r.tgText(`/start ${code}`, STRANGER_TG);
    assert.ok(r.tg.sent().some((m) => m.chat_id === OWNER_TG && m.text === "Pako no longer talks to this account: another Telegram account has been connected."));
    assert.equal(r.waTexts().length, wa, "not sent where WhatsApp would drop it");
    assert.ok(!r.tg.texts().some((t) => /^Telegram conectado/.test(t)), "nor to the new account");
    await r.waText("¿qué ha pasado?");
    assert.match(r.waTexts().find((t, i) => i >= wa && /While we weren't talking/.test(t)) ?? "", /Telegram connected: the account “Marta” \(@marta, id 7002\)/, "given when the owner writes");
  } finally {
    r.close();
  }
});

test("routing: Telegram refusing with WhatsApp's 24 hours over is not a message sent: the notice is held, and Telegram is used again once the owner writes there", async () => {
  let blocked = true;
  const r = await rig({ refuse: (method) => (method === "sendMessage" && blocked ? { status: 403, error_code: 403, description: "Forbidden: bot was blocked by the user" } : null) });
  try {
    blocked = false;
    await r.pair();
    await r.tgText("hola");
    blocked = true;
    r.clock.now += 25 * 3600_000;
    const wa = r.waTexts().length;
    assert.equal(await r.door.notifyOwner("Aviso"), "held");
    assert.equal(r.waTexts().length, wa, "nothing sent where WhatsApp would drop it");
    assert.equal(await r.door.notifyOwner("Otro"), "held", "Telegram is not tried again until the owner writes there");
    blocked = false;
    await r.tgText("ya estoy");
    assert.ok(r.tg.texts().some((t) => /While we weren't talking, this came in:/.test(t) && /Aviso/.test(t)), "the held notices come with the next message");
    assert.equal(await r.door.notifyOwner("Tercero"), "sent");
    assert.equal(r.tg.texts().at(-1), "Tercero");
  } finally {
    r.close();
  }
});

test("routing: an answer keyed to a WhatsApp id ending in '=' goes back to WhatsApp; without Telegram set up, 'Telegram' is just words for the assistant", async () => {
  const r = await rig();
  try {
    await r.pair();
    await r.waText("primero por WhatsApp", "wamid.HBgLMzQ2MDAxMTEyMjIVAgASGBQzRUIwRjU1MjAwQTc=");
    await r.tgText("y luego por Telegram"); // the last chat is Telegram: only the key can send the answer back to WhatsApp
    const wa = r.waTexts().length;
    await r.reply({ key: "wamid.HBgLMzQ2MDAxMTEyMjIVAgASGBQzRUIwRjU1MjAwQTc=", text: "Respuesta." });
    assert.deepEqual(r.waTexts().slice(wa), ["Respuesta."]);
  } finally {
    r.close();
  }
  const memory = loadMemory(null);
  const app = express();
  const plain = mountWhatsapp(app, {
    config: loadWhatsappConfig(ENV, OWNER).config!, memory, kv: null, ownerName: "Marta", timeZone: "Europe/Madrid", contacts: () => [],
    tools: loadVoiceTools({ memory, actions: { contacts: () => [], callContact: async () => ({ ok: true, text: "" }), lookupCall: async () => "" } }),
    fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch,
  });
  await plain.ingest({ from: plain.ownerFrom, id: "local-1", type: "text", text: { body: "Telegram" } });
  assert.deepEqual((await plain.inbox.peek()).map((m) => m.text), ["Telegram"]);
});

test("setWebhook: Telegram is given the secret the webhook checks, only messages and presses, one at a time", async () => {
  const tg = fakeTelegram();
  const got: string[] = [];
  const telegram = createTelegram({ config: { token: TOKEN, ownerId: OWNER_TG, api: "https://tg.test" }, kv: null, ingest: async (m) => (got.push(String(m.id)), "ok"), fetch: tg.f });
  assert.equal(await telegram.setWebhook("https://pako.example.com/telegram/webhook"), true);
  const set = tg.calls.find((c) => c.method === "setWebhook")!.params;
  assert.deepEqual([set.url, set.allowed_updates, set.max_connections], ["https://pako.example.com/telegram/webhook", ["message", "callback_query"], 1]);
  assert.match(set.secret_token, /^[A-Za-z0-9_-]{1,256}$/);
  const app = express();
  telegram.mountWebhook(app, "/telegram/webhook");
  const server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/telegram/webhook`;
    const update = { update_id: 1, message: { message_id: 9, from: { id: OWNER_TG }, chat: { id: OWNER_TG, type: "private" }, text: "hola" } };
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": set.secret_token }, body: JSON.stringify(update) });
    assert.equal(res.status, 200);
    assert.deepEqual(got, ["tg-7001-9"]);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("telegramHtml: links are left exactly as they are (a one-time link with _x_ in it still works)", () => {
  // Marks a WhatsApp pair would take (after a / or a -, before a / or the end): outside a link they would become tags.
  const link = "https://pako.example.com/panel/login/_ab_/~cd~";
  assert.equal(telegramHtml(`Tu panel: ${link} *ya*`), `Tu panel: ${link} <b>ya</b>`);
  assert.equal(telegramHtml("t.me/pako_test_bot?start=-_Ab_"), "t.me/pako_test_bot?start=-_Ab_");
  assert.equal(telegramHtml("sin enlace: -_Ab_"), "sin enlace: -<i>Ab</i>", "the same marks outside a link are formatting");
  assert.equal(telegramHtml("https://x.example/?a=1&b=2"), "https://x.example/?a=1&amp;b=2", "escaped, which Telegram turns back into &");
});

test("sending: a 429 waits as Telegram asks and tries once more; no answer at all counts as sent (it may have arrived)", async () => {
  let throttled = 1;
  const tg = fakeTelegram({ refuse: (m) => (m === "sendMessage" && throttled-- > 0 ? { status: 429, error_code: 429, description: "Too Many Requests: retry after 1" } : null) });
  const kv = fakeKv();
  await kv.set("telegram-owner", JSON.stringify({ userId: OWNER_TG, chatId: OWNER_TG }), 60);
  const telegram = createTelegram({ config: { token: TOKEN, ownerId: null, api: "https://tg.test" }, kv, ingest: async () => "ok", fetch: tg.f });
  assert.equal(await telegram.deliver({ type: "text", text: { body: "hola" } }), true);
  assert.equal(tg.sent().length, 2, "the second try went through");
  const silent = createTelegram({
    config: { token: TOKEN, ownerId: null, api: "https://tg.test" }, kv, ingest: async () => "ok",
    fetch: (async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }) as typeof fetch,
  });
  assert.equal(await silent.deliver({ type: "text", text: { body: "hola" } }), true);
});

test("polling: stop() ends it; a webhook stops it at once; another poller is waited out; an update that keeps failing is let go after five tries", async () => {
  const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
  const quiet = fakeTelegram();
  const a = createTelegram({ config: { token: TOKEN, ownerId: OWNER_TG, api: "https://tg.test" }, kv: null, ingest: async () => "ok", fetch: quiet.f, pollSeconds: 0, pauseMs: 20 });
  const p = a.poll();
  await wait(100);
  p.stop();
  await wait(30);
  const n1 = quiet.calls.filter((c) => c.method === "getUpdates").length;
  assert.ok(n1 >= 2, "it was polling");
  await wait(100);
  assert.equal(quiet.calls.filter((c) => c.method === "getUpdates").length, n1, "and stopped");

  const hooked = fakeTelegram({ refuse: (m) => (m === "getUpdates" ? { status: 409, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active" } : null) });
  createTelegram({ config: { token: TOKEN, ownerId: null, api: "https://tg.test" }, kv: null, ingest: async () => "x", fetch: hooked.f, pollSeconds: 0, pauseMs: 5 }).poll();
  await wait(100);
  assert.equal(hooked.calls.filter((c) => c.method === "getUpdates").length, 1, "a webhook: one try only");

  const twice = fakeTelegram({ refuse: (m) => (m === "getUpdates" ? { status: 409, error_code: 409, description: "Conflict: terminated by other getUpdates request" } : null) });
  const b = createTelegram({ config: { token: TOKEN, ownerId: null, api: "https://tg.test" }, kv: null, ingest: async () => "x", fetch: twice.f, pollSeconds: 0, pauseMs: 2 });
  const pb = b.poll();
  await wait(300);
  pb.stop();
  assert.ok(twice.calls.filter((c) => c.method === "getUpdates").length > 1, "another poller: tried again after a pause");

  const flaky = fakeTelegram();
  let tries = 0;
  const good: string[] = [];
  flaky.queue({ update_id: 10, message: { message_id: 1, from: { id: OWNER_TG }, chat: { id: OWNER_TG, type: "private" }, text: "roto" } });
  flaky.queue({ update_id: 11, message: { message_id: 2, from: { id: OWNER_TG }, chat: { id: OWNER_TG, type: "private" }, text: "bien" } });
  const c = createTelegram({
    config: { token: TOKEN, ownerId: OWNER_TG, api: "https://tg.test" }, kv: null, fetch: flaky.f, pollSeconds: 0, pauseMs: 2,
    ingest: async (m) => {
      const text = String((m.text as { body?: string }).body);
      if (text === "roto") {
        tries++;
        throw new Error("the door could not take it");
      }
      good.push(text);
      return "ok";
    },
  });
  const pc = c.poll();
  for (let i = 0; i < 100 && !good.length; i++) await wait(10);
  pc.stop();
  assert.equal(tries, 5, "tried five times");
  assert.deepEqual(good, ["bien"], "then let go, and the next one taken");
});

test("webhook: an update the door could not take answers 500, so Telegram sends it again", async () => {
  const tg = fakeTelegram();
  const telegram = createTelegram({ config: { token: TOKEN, ownerId: OWNER_TG, api: "https://tg.test" }, kv: null, ingest: async () => { throw new Error("store down"); }, fetch: tg.f });
  const app = express();
  telegram.mountWebhook(app, "/telegram/webhook");
  const server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  try {
    const secret = createHmac("sha256", TOKEN).update("pako-telegram-webhook").digest("hex");
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/telegram/webhook`, {
      method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
      body: JSON.stringify({ update_id: 1, message: { message_id: 1, from: { id: OWNER_TG }, chat: { id: OWNER_TG, type: "private" }, text: "hola" } }),
    });
    assert.equal(res.status, 500);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

// ---------- chat and meeting bugs: regression tests ----------

test("telegram polling: updates taken just before stop() are confirmed, so the next start does not act on them again", async () => {
  const tg = fakeTelegram();
  const got: string[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  const make = () => createTelegram({
    config: { token: TOKEN, ownerId: OWNER_TG, api: "https://tg.test" }, kv: null, fetch: tg.f, pollSeconds: 0, pauseMs: 5,
    ingest: async (m) => {
      got.push(String((m.text as { body?: string } | undefined)?.body));
      await held; // the door is still busy with it when Pako is stopped (a restart, a new token from the panel)
      return "queued";
    },
  });
  tg.queue({ update_id: 700, message: { message_id: 1, from: { id: OWNER_TG }, chat: { id: OWNER_TG, type: "private" }, text: "remind me at 5" } });
  const first = make().poll();
  for (let i = 0; i < 100 && !got.length; i++) await new Promise((res) => setTimeout(res, 5));
  first.stop();
  release();
  await new Promise((res) => setTimeout(res, 30));
  const second = make().poll();
  await new Promise((res) => setTimeout(res, 60));
  second.stop();
  assert.deepEqual(got, ["remind me at 5"], "taken once, not again after the restart");
});
