// Answering in each person's language: the guess from the owner's own words (src/language.ts), the door that keeps it and gives it in the
// context (src/whatsapp.ts), PAKO_LANGUAGE, the bridge's runs that answer no message of the owner's (assistant/bridge.ts) and the prompts.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { mock, test } from "node:test";
import express from "express";
import { createApp, loadAppConfig, type LocalContext } from "../src/app.ts";
import { createControl } from "../src/control.ts";
import type { Kv } from "../src/kv.ts";
import { detectLanguage, readLanguage } from "../src/language.ts";
import { createLocalChannel, loadHome, localEnv } from "../src/local.ts";
import { sqliteKv } from "../src/sqlite-kv.ts";
import { createTelegram } from "../src/telegram.ts";
import { ownerPrompt } from "../src/voice-prompt.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";
import { loadWhatsappConfig, mountWhatsapp } from "../src/whatsapp.ts";
import { createBridge, languageLine, parseEmailVerdict, type BridgeConfig, type runClaude } from "../assistant/bridge.ts";
import { EMAIL_PROMPT, MEETING_PROMPT, SYSTEM_PROMPT } from "../assistant/prompt.ts";

// ---------- the guess ----------

test("detectLanguage: a few everyday messages per language are told apart", () => {
  const table: Record<string, string[]> = {
    es: ["Recuérdame mañana a las 9 llamar a Ana", "¿Qué tiempo hace mañana en Madrid?", "No me apetece salir hoy, estoy muy cansado", "Vale, gracias, hasta luego"],
    en: ["Can you call me tomorrow at nine?", "Remind me to pay the electricity bill on Monday", "What's the weather like in London this weekend?"],
    ca: ["Demà tinc una reunió amb el client a les deu", "Hola, com estàs?", "Avui no puc, dema et truco", "Pots trucar a la Marta i dir-li que arribo tard?"],
    fr: ["Tu peux m'appeler demain à neuf heures ?", "Je suis à la maison, c'est très calme", "Je ne sais pas si je peux venir demain"],
    de: ["Kannst du mich morgen um neun anrufen?", "Ich bin heute zu Hause und habe keine Zeit", "Vielen Dank, das ist perfekt"],
    it: ["Domani ho una riunione con il cliente alle dieci", "Ho bisogno di parlare con te", "Puoi chiamare Marco e dirgli che arrivo tardi?"],
    pt: ["Você pode me ligar amanhã de manhã?", "Eu não sei o que fazer", "Estou chegando, espera um pouco"],
    nl: ["Kun je me morgen om negen uur bellen?", "Ik ben er niet vandaag, maar morgen wel", "Wat staat er deze week in mijn agenda?"],
  };
  for (const [code, sentences] of Object.entries(table)) for (const s of sentences) assert.equal(detectLanguage(s), code, s);
});

test("detectLanguage: one word, a number, an emoji, a short or mixed message says nothing; Spanish with a few English words is Spanish", () => {
  for (const unclear of ["ok", "Vale", "Gracias!", "👍", "123", "9:00", "Sí, mañana", "jajaja", "ok gracias 👍", "Thank you", "que tal estas", "", "   "]) {
    assert.equal(detectLanguage(unclear), null, JSON.stringify(unclear));
  }
  assert.equal(detectLanguage("I'm going to la playa con mis amigos"), null, "half and half");
  assert.equal(detectLanguage("Oye, can you check el email?"), null);
  assert.equal(detectLanguage("¿Me lo traduces?\nI will be late for the meeting tomorrow, sorry about that."), null, "a line clearly in another language makes a mix");
  // Without the opening ¿ (as phones type it), and with a short line of the owner's that has only a word or two the detector knows.
  for (const pasted of [
    "Me lo traduces?\nI will be late for the meeting tomorrow, sorry about that.",
    "Tradúceme esto: I will be late for the meeting tomorrow, sorry about that.",
    "Qué le contesto?\nHi Linus, can we move our call to Friday? Something came up on my side.",
    "Corrige mi inglés: I have went to the office yesterday and it was closed",
    "Mira lo que me ha mandado mi jefe:\nCan you make sure the numbers are in the deck before the meeting?",
    "Y esto?\nCan you make sure the numbers are in the deck before the meeting?",
  ]) assert.equal(detectLanguage(pasted), null, pasted);
  assert.equal(detectLanguage("Apúntame al webinar 'How to win the market in the next year'"), null, "words in single quotes are someone else's too");
  assert.equal(detectLanguage("I don't think it's ready, let's wait until Monday"), "en", "an apostrophe inside a word is not a quote");
  assert.equal(readLanguage("gracias").lean, "es", "too short to be clear, but it leans");
  assert.equal(readLanguage("ok 👍").lean, null);
  assert.equal(detectLanguage("Tengo un meeting con el team a las cinco, ¿me haces un recap del call de ayer?"), "es");
  assert.equal(detectLanguage("Tengo que mandar el report antes del Friday"), "es");
  assert.equal(detectLanguage("I'm meeting Begoña at the café"), "en", "a Spanish name in an English sentence");
});

test("detectLanguage: quoted words, links, addresses and @names are someone else's; a huge message is read quickly", () => {
  assert.equal(detectLanguage('Ana me ha escrito "see you tomorrow at the office", ¿qué le digo?'), "es");
  assert.equal(detectLanguage("Ana dice: «I can't make it tonight». ¿Le dices que no pasa nada?"), "es");
  assert.equal(detectLanguage("Mira este link https://www.example.com/the-day-in-review-of-the-week y dime qué opinas"), "es");
  assert.equal(detectLanguage("https://www.example.com/the-best-of-the-year"), null);
  assert.equal(detectLanguage("@ana #viernes ok?"), null);
  const started = Date.now();
  for (const huge of ["a".repeat(200_000), "x@".repeat(100_000), "l'".repeat(100_000), `${"the ".repeat(50_000)}`]) detectLanguage(huge);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});

// ---------- the door ----------

const OWNER = "+34600111222";
const OWNER_WA = "34600111222";
const ENV = {
  WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
};
const ENGLISH = "Can you remind me tomorrow at nine to call the bank?";
const ENGLISH_TOO = "And what's the weather like in London this weekend?";
const SPANISH = "Recuérdame mañana a las nueve llamar al banco, por favor";
const SPANISH_TOO = "No me apetece salir hoy, estoy muy cansado";

/** A store in memory that counts its writes, can fail some of them, and can hold a read back (with what it held when asked) until it is let go. */
function fakeKv(o: { failSet?: (key: string) => boolean; failGet?: (key: string) => boolean; holdGet?: (key: string) => Promise<void> | null } = {}) {
  const m = new Map<string, string>();
  const sets: { key: string; value: string }[] = [];
  const kv: Kv = {
    get: async (k) => {
      const v = m.get(k) ?? null;
      await o.holdGet?.(k);
      if (o.failGet?.(k)) throw new Error("store down");
      return v;
    },
    set: async (k, v) => {
      sets.push({ key: k, value: v });
      if (o.failSet?.(k)) throw new Error("store down");
      m.set(k, v);
    },
  };
  return { kv, m, langWrites: () => sets.filter((s) => s.key === "owner-language").map((s) => s.value) };
}

let n = 0;
async function door(o: { kv?: Kv | null; control?: boolean } = {}) {
  const memory = loadMemory(null);
  const tools = loadVoiceTools({ memory, actions: { contacts: () => ["Ana"], callContact: async () => ({ ok: true, text: "started" }), lookupCall: async () => "ok" } });
  const sent: Record<string, any>[] = [];
  const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.body) sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }), { status: 200 });
  }) as typeof fetch;
  const config = loadWhatsappConfig(ENV, OWNER).config!;
  const app = express();
  const kv = o.kv === undefined ? null : o.kv;
  const wa = mountWhatsapp(app, {
    config, tools, memory, kv, ownerName: "Marta", timeZone: "Europe/Madrid", contacts: () => ["Ana"], fetch: fake,
    ...(o.control ? { control: createControl(kv) } : {}),
  });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const text = (body: string, extra: Record<string, unknown> = {}) => ({ from: OWNER_WA, id: `wamid.lang${++n}`, timestamp: "1", type: "text", text: { body }, ...extra });
  const hook = (msgs: Record<string, unknown>[]) => {
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: config.phoneNumberId }, messages: msgs } }] }],
    });
    const signature = `sha256=${createHmac("sha256", config.appSecret).update(raw).digest("hex")}`;
    return fetch(`${base}/whatsapp/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature }, body: raw });
  };
  const context = async () => {
    const r = await fetch(`${base}/assistant/context`, { headers: { authorization: `Bearer ${config.bridgeToken}` } });
    assert.equal(r.status, 200, "the context always answers");
    return (await r.json()) as { language: string; paused: boolean };
  };
  const queued = async () => (await wa.inbox.peek()).map((m) => m.text);
  return { wa, hook, text, context, queued, sent, close: () => { server.close(); server.closeAllConnections(); } };
}

test("door: the owner's language is heard from their own clear messages, given in the context and by the door, and kept in the store only when it changes", async () => {
  const store = fakeKv();
  const r = await door({ kv: store.kv });
  try {
    assert.equal((await r.context()).language, "en", "English before anything is heard");
    assert.equal(await r.wa.language(), "en");
    assert.equal((await r.hook([r.text(SPANISH)])).status, 200);
    assert.deepEqual(await r.queued(), [SPANISH], "the message itself goes on to the assistant as always");
    assert.equal((await r.context()).language, "en", "heard once: not the owner's language yet (it may be a text they pasted)");
    await r.hook([r.text(SPANISH_TOO)]);
    assert.equal((await r.context()).language, "es", "a second clear message says it again");
    assert.equal(await r.wa.language(), "es");
    assert.equal(store.m.get("owner-language"), "es");
    for (const unclear of ["ok", "👍", "9:30"]) await r.hook([r.text(unclear)]);
    await r.hook([r.text("Gracias, y dime qué tiempo hará el viernes en la sierra")]);
    assert.equal((await r.context()).language, "es", "a short message says nothing; another Spanish one changes nothing");
    assert.deepEqual(store.langWrites(), ["es"], "one write while the language stays the same");
    await r.hook([r.text(ENGLISH, { context: { forwarded: true } }), r.text(ENGLISH, { context: { frequently_forwarded: true } })]);
    await r.hook([r.text(ENGLISH_TOO, { context: { forwarded: true } })]);
    assert.equal((await r.context()).language, "es", "a forwarded message is someone else's words");
    await r.hook([r.text(ENGLISH)]);
    await r.hook([r.text(ENGLISH_TOO)]);
    assert.equal((await r.context()).language, "en");
    assert.deepEqual(store.langWrites(), ["es", "en"]);
    await r.hook([r.text("Demà tinc una reunió amb el client a les deu")]);
    await r.hook([r.text("Avui no puc, dema et truco")]);
    assert.deepEqual(r.sent, [], "hearing a language sends the owner nothing: the server's own texts stay as they are for now");
  } finally {
    r.close();
  }
  const again = await door({ kv: store.kv }); // a restart of the server
  try {
    assert.equal((await again.context()).language, "ca", "read from the store after a restart, before the owner writes again");
    await again.hook([again.text("Pots trucar a la Marta i dir-li que arribo tard?")]);
    assert.deepEqual(store.langWrites(), ["es", "en", "ca"], "the same language after a restart is not written again");
  } finally {
    again.close();
  }
});

test("door: Meta delivering a message twice, a pause, Telegram and a voice note: the language is heard once from what the owner typed, wherever they typed it", async () => {
  const store = fakeKv();
  const r = await door({ kv: store.kv, control: true });
  try {
    const twice = r.text(SPANISH);
    await r.hook([twice]);
    await r.hook([twice]);
    assert.deepEqual([store.langWrites(), (await r.context()).language], [[], "en"], "Meta delivering it again is not a second message");
    await r.hook([r.text(SPANISH_TOO)]);
    assert.deepEqual(store.langWrites(), ["es"]);
    await r.hook([r.text("STOP")]);
    assert.equal((await r.context()).paused, true);
    await r.hook([r.text(ENGLISH)]);
    await r.hook([r.text(ENGLISH_TOO)]);
    const ctx = await r.context();
    assert.deepEqual([ctx.paused, ctx.language], [true, "en"], "a pause stops calls and sends, not listening");
    await r.wa.ingest({ from: r.wa.ownerFrom, id: "tg-7001-11", type: "text", text: { body: "Je ne sais pas si je peux venir demain" } }, "telegram");
    await r.wa.ingest({ from: r.wa.ownerFrom, id: "tg-7001-12", type: "text", text: { body: "Je suis à la maison, c'est très calme" } }, "telegram");
    assert.equal((await r.context()).language, "fr", "a message on Telegram counts like one on WhatsApp");
    await r.hook([{ from: OWNER_WA, id: `wamid.lang${++n}`, timestamp: "1", type: "audio", audio: { id: "media123", mime_type: "audio/ogg" } }]);
    assert.equal((await r.context()).language, "fr", "a voice note has no words here: it changes nothing");
  } finally {
    r.close();
  }
});

test("door: an English text pasted with a short line of the owner's is not them switching: it takes two clear messages, and one that leans to the language kept in between starts again", async () => {
  const store = fakeKv();
  const r = await door({ kv: store.kv });
  try {
    await r.hook([r.text(SPANISH)]);
    await r.hook([r.text(SPANISH_TOO)]);
    await r.hook([r.text("Apunta: the wifi password is on the fridge")]);
    await r.hook([r.text("gracias")]); // too short to be clear, but theirs, and Spanish
    await r.hook([r.text("Responde a John: thanks for the update, I will have a look at it tomorrow")]);
    await r.hook([r.text("Me lo traduces?\nI will be late for the meeting tomorrow, sorry about that.")]);
    assert.equal((await r.context()).language, "es", "the email and meeting summaries stay in Spanish");
    assert.deepEqual(store.langWrites(), ["es"]);
    await r.hook([r.text(ENGLISH)]);
    assert.equal((await r.context()).language, "en", "two clear messages in a row: the owner writes in English now");
  } finally {
    r.close();
  }
});

test("door: a message forwarded on Telegram is someone else's words, as on WhatsApp: it does not change the owner's language", async () => {
  const store = fakeKv();
  const r = await door({ kv: store.kv });
  const sent: Record<string, any>[] = [];
  const tg = createTelegram({
    config: { token: `123456789:${"A".repeat(35)}`, ownerId: 7001, api: "https://tg.test" },
    kv: store.kv,
    ingest: (m) => r.wa.ingest({ from: r.wa.ownerFrom, ...m }, "telegram"),
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.body) sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }) as typeof fetch,
  });
  let id = 0;
  const update = (text: string, forwarded: boolean) => ({
    update_id: ++id,
    message: {
      message_id: ++id, from: { id: 7001, is_bot: false, first_name: "Marta" }, chat: { id: 7001, type: "private" }, text,
      ...(forwarded ? { forward_origin: { type: "user", date: 1, sender_user: { id: 99, is_bot: false, first_name: "Ana" } } } : {}),
    },
  });
  try {
    await r.hook([r.text(SPANISH)]);
    await r.hook([r.text(SPANISH_TOO)]);
    for (const text of [ENGLISH, ENGLISH_TOO, "Thanks, and tell me what the weather will be like on Friday"]) await tg.handle(update(text, true));
    assert.equal((await r.context()).language, "es", "forwarded: not the owner's words");
    assert.deepEqual(store.langWrites(), ["es"]);
    assert.equal((await r.wa.inbox.peek()).length, 5, "the forwarded messages still reach the assistant");
    for (const text of [ENGLISH, ENGLISH_TOO]) await tg.handle(update(text, false));
    assert.equal((await r.context()).language, "en", "typed by the owner on Telegram: theirs");
  } finally {
    r.close();
  }
});

test("door: a store that fails, is slow or is empty never stops a message or the context; a language it could not keep is kept by the next clear message", async () => {
  // Writes of the language fail: the message is queued all the same, and the next clear one tries again.
  let down = true;
  const writes = fakeKv({ failSet: (k) => down && k === "owner-language" });
  const errors: string[] = [];
  const keep = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  const r = await door({ kv: writes.kv });
  try {
    assert.equal((await r.hook([r.text(ENGLISH)])).status, 200);
    assert.equal((await r.hook([r.text(ENGLISH_TOO)])).status, 200);
    assert.deepEqual(await r.queued(), [ENGLISH, ENGLISH_TOO]);
    assert.equal((await r.context()).language, "en", "known here even if the store did not take it");
    assert.ok(errors.some((e) => /could not keep the owner's language: store down/.test(e)));
    down = false;
    await r.hook([r.text("Thanks, and tell me what the weather will be like on Friday")]);
    assert.equal(writes.m.get("owner-language"), "en", "tried again by the next clear message");
  } finally {
    console.error = keep;
    r.close();
  }

  // Reads fail: English until the store answers, then what it holds.
  let readsDown = true;
  const reads = fakeKv({ failGet: (k) => readsDown && k === "owner-language" });
  reads.m.set("owner-language", "it");
  const g = await door({ kv: reads.kv });
  try {
    assert.equal((await g.context()).language, "en");
    readsDown = false;
    assert.equal((await g.context()).language, "it", "read again once the store answers");
  } finally {
    g.close();
  }

  // A slow read, asked before the owner wrote: what they say meanwhile is newer than the old value the read comes back with.
  let release: () => void = () => undefined;
  const held = new Promise<void>((res) => (release = res));
  const slow = fakeKv({ holdGet: (k) => (k === "owner-language" ? held : null) });
  slow.m.set("owner-language", "de");
  const s = await door({ kv: slow.kv });
  try {
    await s.hook([s.text(ENGLISH)]);
    await s.hook([s.text(ENGLISH_TOO)]);
    release();
    assert.equal((await s.context()).language, "en");
    assert.equal(slow.m.get("owner-language"), "en");
    await s.hook([s.text("Thanks, and tell me what the weather will be like on Friday")]);
    assert.deepEqual(slow.langWrites(), ["en"], "the old value that came back does not make the same language look new");
  } finally {
    s.close();
  }

  // No store at all (a test, or a server without one): heard in memory only.
  const none = await door({ kv: null });
  try {
    await none.hook([none.text(ENGLISH)]);
    await none.hook([none.text(ENGLISH_TOO)]);
    assert.equal((await none.context()).language, "en");
  } finally {
    none.close();
  }
});

test("app: PAKO_LANGUAGE is accepted and ignored: the log says so once, and the context gives the language heard (English before any)", async () => {
  const env = { PERSONAL_CALLER_TOKEN: "t".repeat(32), PERSONAL_OWNER_NAME: "Ana", PERSONAL_OWNER_NUMBER: OWNER, ...ENV };
  const contextOf = async (extra: Record<string, string>) => {
    const all = { ...env, ...extra };
    const server = createServer(createApp(loadAppConfig(all), all));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      return ((await (await fetch(`${base}/assistant/context`, { headers: { authorization: `Bearer ${ENV.ASSISTANT_BRIDGE_TOKEN}` } })).json()) as { language: string }).language;
    } finally {
      server.close();
      server.closeAllConnections();
    }
  };
  const errors: string[] = [];
  const logs = { error: console.error, warn: console.warn, log: console.log };
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  console.warn = (...a: unknown[]) => void errors.push(a.join(" "));
  console.log = () => undefined;
  try {
    assert.equal(await contextOf({ PAKO_LANGUAGE: "es" }), "en", "not the owner's language any more");
    assert.equal(await contextOf({ PAKO_LANGUAGE: "pt" }), "en");
    assert.equal(errors.filter((e) => /\[language\].*PAKO_LANGUAGE is ignored/.test(e)).length, 2, "once per start: " + errors.join(" | "));
    errors.length = 0;
    await contextOf({});
    assert.equal(errors.some((e) => /PAKO_LANGUAGE/.test(e)), false, "nothing said when it is not set");
  } finally {
    console.error = logs.error;
    console.warn = logs.warn;
    console.log = logs.log;
  }
});

test("local mode: what the owner types in the panel's chat is heard like a WhatsApp message", async () => {
  const home = loadHome({ PAKO_HOME: join(mkdtempSync(join(tmpdir(), "pako-lang-")), "home"), PAKO_NAME: "Ana" });
  const env: Record<string, string | undefined> = { ...localEnv({}, home, 0), PAKO_HOME: home.dir };
  const kv = sqliteKv(home.dir);
  const local: LocalContext = { kv, channel: createLocalChannel({ kv }), bridgeToken: home.bridgeToken, panelSecret: home.panelSecret, bridge: { status: () => ({ claude: "ok", running: true }) } };
  const app = createApp(loadAppConfig(env), env, local);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const link = (app.locals.panelLink as () => string)().replace(/^http:\/\/127\.0\.0\.1:\d+/, base);
    const cookie = ((await fetch(link, { redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0]!;
    for (const text of ["Je ne sais pas si je peux venir demain", "Je suis à la maison, c'est très calme"]) {
      const sent = await fetch(`${base}/panel/api/chat`, { method: "POST", headers: { "content-type": "application/json", cookie, "x-pako": "1" }, body: JSON.stringify({ text }) });
      assert.equal(sent.status, 202);
      await sleep(25); // one after the other, as typed
    }
    const bridge = (path: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${home.bridgeToken}` } });
    let language = "";
    for (let i = 0; i < 40 && language !== "fr"; i++) {
      await sleep(25);
      language = ((await (await bridge("/assistant/context")).json()) as { language: string }).language;
    }
    assert.equal(language, "fr");
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

// ---------- the bridge ----------

const TOKEN = "t".repeat(48);

/** A stand-in for the server's bridge routes, and a bridge whose Claude runs are recorded and answered by `answer`. */
async function bridgeRig(answer: (prompt: string, systemPrompt: string | undefined) => string) {
  const h = {
    inbox: [] as Record<string, unknown>[],
    context: { now: "sábado 14 de noviembre de 2026, 12:00", ownerName: "Marta", contacts: ["Ana"], memory: "", paused: false, language: "en" } as Record<string, unknown> | null,
    contextReads: 0,
    replies: [] as Record<string, unknown>[],
    summaries: [] as Record<string, unknown>[],
    runs: [] as { prompt: string; systemPrompt: string | undefined; tools: string[]; resume: boolean }[],
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => (req.get("authorization") === `Bearer ${TOKEN}` ? next() : void res.status(401).send("no")));
  app.get("/assistant/inbox", (_req, res) => void res.json({ messages: h.inbox }));
  app.post("/assistant/ack", (req, res) => {
    const ids = req.body.ids as string[];
    h.inbox = h.inbox.filter((m) => !ids.includes(String(m.id)));
    res.json({ ok: true });
  });
  app.get("/assistant/context", (_req, res) => {
    h.contextReads++;
    return h.context ? void res.json(h.context) : void res.status(500).send("down");
  });
  app.post("/assistant/reply", (req, res) => {
    h.replies.push(req.body);
    res.json({ ok: true });
  });
  app.post("/assistant/mail-summary", (req, res) => {
    h.summaries.push(req.body);
    res.json({ ok: true });
  });
  for (const path of ["/assistant/meeting-summary", "/assistant/memory"]) app.post(path, (_req, res) => void res.json({ ok: true }));
  app.get("/assistant/slack/search", (_req, res) => void res.json({ results: ["14/11 20:00 #proyecto · Ana: the report goes out on Monday"] }));
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const config: BridgeConfig = {
    server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: TOKEN, claudeBin: "claude", model: "", stateDir: mkdtempSync(join(tmpdir(), "asst-lang-")),
    tools: ["WebSearch"], runTimeoutMs: 20_000, rotateAfter: 30, noticeMs: 60_000, whisperModel: "", whisperBin: "whisper-cli", ffmpegBin: "ffmpeg", whisperLang: "auto",
  };
  const run = (async (prompt, c, sessionId) => {
    h.runs.push({ prompt, systemPrompt: c.systemPrompt, tools: c.tools, resume: !!sessionId });
    return { text: answer(prompt, c.systemPrompt), sessionId: "s-1", costUsd: 0 };
  }) as typeof runClaude;
  const bridge = createBridge({ config, run, log: () => undefined, replyWaitsMs: [0, 0, 0, 0, 0] });
  const at = Date.parse("2026-11-14T20:00:00Z");
  // Each email its own words: the same email twice within minutes would be answered once (assistant/budget.ts coalescing).
  const email = (id: string) => ({ id, at, text: "", email: { from: "Bank <alerts@bank.example>", subject: "Your code", text: `Your one-time code is 482913 (${id}).`, attachments: [] } });
  const meeting = (id: string) => ({ id, at: 1, text: "", meeting: { topic: "Launch", when: "14/11 10:00", transcript: "Ana: we launch on Monday" } });
  return { h, bridge, email, meeting, close: () => { server.close(); server.closeAllConnections(); } };
}

test("bridge: the owner's language goes into the email, meeting and Slack runs, read from the context their message brought or once for several emails", async () => {
  const r = await bridgeRig((prompt) => (prompt.includes("[Slack results") ? "Ana said the report goes out on Monday." : prompt.includes("<<<") ? "NEEDS_YOU\nYour bank sent you a sign-in code." : "<slack>report</slack>"));
  try {
    r.h.inbox.push(r.email("mail:<1@x>"), r.email("mail:<2@x>"), r.email("mail:<3@x>"));
    for (let i = 0; i < 3; i++) await r.bridge.tick(0);
    assert.equal(r.h.runs.length, 3);
    for (const run of r.h.runs) {
      assert.match(run.prompt, /^Owner's language: English \(en\)\nReceived: 2026-11-14\n\n<<<CORREO-[0-9a-f]{8}\n/, "the first line, above the email's fence");
      assert.equal(run.systemPrompt, EMAIL_PROMPT.replaceAll("CORREO", /<<<(CORREO-[0-9a-f]{8})/.exec(run.prompt)![1]!));
    }
    assert.equal(r.h.contextReads, 1, "three emails, one read of the context");

    r.h.inbox.push(r.meeting("zoom:abc=="));
    await r.bridge.tick(0);
    assert.match(r.h.runs.at(-1)!.prompt, /^Owner's language: English \(en\)\n\n<<<REUNION-[0-9a-f]{8}\nMeeting: Launch\n/);
    assert.equal(r.h.contextReads, 1, "still the same read");

    // The owner asks about Slack in English: the context of their message carries the language to the Slack run (no read of its own).
    r.h.context = { ...r.h.context!, language: "ca" };
    r.h.inbox.push({ id: "wamid.s1", at: 2, text: "What did Ana say about the report on Slack?" }, r.email("mail:<4@x>"));
    await r.bridge.tick(0);
    const slack = r.h.runs.find((x) => x.prompt.includes("[Slack results"))!;
    assert.match(slack.prompt, /^\[Owner's language: Catalan \(ca\)\]\n\n\[What they asked you: What did Ana say about the report on Slack\?\]/);
    assert.match(slack.prompt, /Now answer their question from what is here, in the language they asked it in \(if that does not show, in the one on the first line\)\.$/);
    assert.match(r.h.runs.at(-1)!.prompt, /^Owner's language: Catalan \(ca\)\n/, "the email after it uses the language that message brought");
    assert.equal(r.h.contextReads, 2, "the owner's message read the context; the email after it did not");
    assert.deepEqual(r.h.replies.find((x) => !x.notice), { text: "Ana said the report goes out on Monday.", key: "wamid.s1" });
  } finally {
    r.close();
  }
});

test("bridge: an older server (no language) or a context that is down leaves the runs with no language line (the prompts then say English), and no email waits for it", async () => {
  const r = await bridgeRig((prompt) => (prompt.includes("[Slack results") ? "Ana dijo que el informe sale el lunes." : prompt.includes("<<<") ? "IMPORTANT\nUn aviso del banco." : "<slack>informe</slack>"));
  try {
    const { language: _gone, ...older } = r.h.context!;
    r.h.context = older;
    r.h.inbox.push({ id: "wamid.o1", at: 1, text: "¿Qué dijo Ana del informe en Slack?" });
    await r.bridge.tick(0);
    assert.match(r.h.runs.at(-1)!.prompt, /^\[What they asked you: /, "no language line");
    assert.match(r.h.runs.at(-1)!.prompt, /in the language they asked it in\.$/);
    r.h.inbox.push(r.meeting("zoom:old=="));
    await r.bridge.tick(0);
    assert.match(r.h.runs.at(-1)!.prompt, /^\n<<<REUNION-/, "the meeting run as before");

    const fresh = await bridgeRig(() => "IMPORTANT\nUn aviso del banco.");
    try {
      fresh.h.context = null;
      fresh.h.inbox.push(fresh.email("mail:<5@x>"), fresh.email("mail:<6@x>"));
      await fresh.bridge.tick(0);
      await fresh.bridge.tick(0);
      assert.equal(fresh.h.runs.length, 2, "both emails were summarized");
      assert.match(fresh.h.runs[0]!.prompt, /^Received: 2026-11-14\n\n<<<CORREO-/, "without the line: the prompt's default, English");
      assert.equal(fresh.h.contextReads, 1, "a context that is down is not asked again for every email");
      assert.deepEqual(fresh.h.inbox, [], "and they were let go as done");
    } finally {
      fresh.close();
    }
  } finally {
    r.close();
  }
});

test("bridge: the language read for emails is read again after half an hour (the owner may have switched), and a minute after a read that failed", async () => {
  const r = await bridgeRig(() => "IMPORTANT\nUn aviso.");
  const mail = async (id: string): Promise<string> => {
    r.h.inbox.push(r.email(id));
    await r.bridge.tick(0);
    return r.h.runs.at(-1)!.prompt;
  };
  try {
    mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-15T10:00:00Z") });
    await mail("mail:<a@x>");
    r.h.context = { ...r.h.context!, language: "fr" };
    mock.timers.tick(29 * 60_000);
    assert.match(await mail("mail:<b@x>"), /^Owner's language: English \(en\)\n/, "within half an hour, the read it had");
    mock.timers.tick(2 * 60_000);
    assert.match(await mail("mail:<c@x>"), /^Owner's language: French \(fr\)\n/);
    assert.equal(r.h.contextReads, 2);

    // Half an hour later the context is down: the language it knew serves, and the context is asked again a minute later, not for every email.
    const ok = r.h.context;
    r.h.context = null;
    mock.timers.tick(31 * 60_000);
    assert.match(await mail("mail:<d@x>"), /^Owner's language: French \(fr\)\n/);
    assert.match(await mail("mail:<e@x>"), /^Owner's language: French \(fr\)\n/);
    assert.equal(r.h.contextReads, 3);
    r.h.context = { ...ok!, language: "de" };
    mock.timers.tick(61_000);
    assert.match(await mail("mail:<f@x>"), /^Owner's language: German \(de\)\n/);
    assert.equal(r.h.contextReads, 4);
  } finally {
    r.close();
    mock.timers.reset();
  }
});

test("bridge: a Spanish owner's summaries are asked in Spanish by the language line (the prompt itself is English); a scam verdict reaches the server as a flag", async () => {
  const r = await bridgeRig((prompt) => (prompt.includes("<<<") ? "SUSPICIOUS\nWHY: A fake fine with a payment link\nOjo: parece un intento de estafa: piden pagar una multa por un enlace." : "ok"));
  try {
    r.h.context = { ...r.h.context!, language: "es" };
    r.h.inbox.push(r.email("mail:<s1@x>"), r.meeting("zoom:es=="));
    await r.bridge.tick(0);
    await r.bridge.tick(0);
    const [mail, meeting] = r.h.runs;
    assert.match(mail!.prompt, /^Owner's language: Spanish \(es\)\n/);
    assert.match(meeting!.prompt, /^Owner's language: Spanish \(es\)\n/);
    for (const run of [mail!, meeting!]) assert.doesNotMatch(run.systemPrompt ?? "", /[áéíóúñ¿¡]/, "the prompt itself is English; the line says the language");
    const told = r.h.replies.find((x) => x.notice)!;
    assert.match(String(told.text), /\nOjo: parece un intento de estafa: piden pagar una multa por un enlace\.$/, "the verdict line is not in what the owner reads");
    assert.deepEqual(r.h.summaries, [{
      id: "mail:<s1@x>", notify: true, summary: "Ojo: parece un intento de estafa: piden pagar una multa por un enlace.", scam: true,
      verdict: { category: "suspicious", why: "A fake fine with a payment link", security: false },
    }]);
  } finally {
    r.close();
  }
  // The old verdict words still read (a bridge prompt from before): mapped to their categories.
  const pick = (raw: string) => {
    const v = parseEmailVerdict(raw);
    return { notify: v.notify, summary: v.summary, scam: v.scam, category: v.verdict?.category };
  };
  assert.deepEqual(pick("SUSPICIOUS\nCareful: this looks like a scam attempt."), { notify: true, summary: "Careful: this looks like a scam attempt.", scam: true, category: "suspicious" });
  assert.deepEqual(pick("AVISAR ESTAFA\nCareful: this looks like a scam attempt."), { notify: true, summary: "Careful: this looks like a scam attempt.", scam: true, category: "suspicious" });
  assert.deepEqual(pick("**AVISAR: ESTAFA**\nOjo: parece un intento de estafa."), { notify: true, summary: "Ojo: parece un intento de estafa.", scam: true, category: "suspicious" });
  assert.deepEqual(pick("AVISAR\nEstafa en tu cuenta: el banco avisa de un cargo que no hiciste."), { notify: true, summary: "Estafa en tu cuenta: el banco avisa de un cargo que no hiciste.", scam: false, category: "needs_you" });
  assert.deepEqual(pick("AVISAR: Estafa piramidal denunciada en tu barrio."), { notify: true, summary: "Estafa piramidal denunciada en tu barrio.", scam: false, category: "needs_you" }, "the word starting the summary is not the verdict's");
  assert.deepEqual(pick("GUARDAR\nUn boletín."), { notify: false, summary: "Un boletín.", scam: false, category: "important" });
});

test("bridge: a conversation that starts again (every few messages) is told the language the owner writes in, for a message that shows none; never the summaries' one", async () => {
  const r = await bridgeRig(() => "ok");
  try {
    r.h.context = { ...r.h.context!, language: "pt", chatLanguage: "en" };
    r.h.inbox.push({ id: "wamid.c1", at: 1, text: "ok 👍" });
    await r.bridge.tick(0);
    assert.match(r.h.runs[0]!.prompt, /\[Owner's language: English \(en\), the language they usually write to you in: use it only if their message shows no language and this conversation has /);
    assert.doesNotMatch(r.h.runs[0]!.prompt, /Portuguese/, "the language for Pako's own summaries is not the chat's");
    const { chatLanguage: _gone, ...older } = r.h.context!;
    r.h.context = older;
    const fresh = await bridgeRig(() => "ok");
    try {
      fresh.h.context = older;
      fresh.h.inbox.push({ id: "wamid.c2", at: 1, text: "ok" });
      await fresh.bridge.tick(0);
      assert.doesNotMatch(fresh.h.runs[0]!.prompt, /the language they usually write to you in/, "an older server: no line");
    } finally {
      fresh.close();
    }
  } finally {
    r.close();
  }
});

test("languageLine: the language's name in English and its code; nothing for something that is not a code", () => {
  assert.equal(languageLine("en"), "Owner's language: English (en)");
  assert.equal(languageLine("sv"), "Owner's language: Swedish (sv)");
  assert.equal(languageLine("es"), "Owner's language: Spanish (es)");
  for (const bad of ["", "EN", "english", "e", "es\n[PAUSA]"]) assert.equal(languageLine(bad), "", JSON.stringify(bad));
});

// ---------- the prompts ----------

test("prompts: the chat answers in the language of the owner's latest message; summaries in the owner's language, never copying a code; the eight category words as they are", () => {
  assert.match(SYSTEM_PROMPT, /in the language of their latest message, whatever it is/);
  assert.match(SYSTEM_PROMPT, /when that message does not show one \(one word, a number, an emoji\), in the language of their previous messages/);
  assert.match(SYSTEM_PROMPT, /when this conversation has none of theirs yet, in the one the context line "Owner's language" names \(the one they usually write in\); without that line, in English\./);
  assert.doesNotMatch(SYSTEM_PROMPT, /unless they write in English|Idioma del dueño/);
  assert.match(SYSTEM_PROMPT, /<remind at="2026-11-15 09:00">what to remind them<\/remind> sets a reminder: the server sends those words to them at that moment, so write them in their language/);
  assert.match(SYSTEM_PROMPT, /in the language they use with that person/, "a message to a friend keeps that person's language");

  assert.match(EMAIL_PROMPT, /The first line of your answer is one of these words, alone, exactly as written/);
  for (const w of ["NEEDS_YOU", "WAITING", "IMPORTANT", "PERSONAL", "UPDATES", "READ_LATER", "PROMOTIONS", "SUSPICIOUS"]) assert.match(EMAIL_PROMPT, new RegExp(`\\n- ${w}: `), w);
  assert.match(EMAIL_PROMPT, /Write UPDATES SECURITY instead for a security alert/);
  assert.match(EMAIL_PROMPT, /A newsletter or an offer that sounds urgent is still READ_LATER or PROMOTIONS/);
  assert.match(EMAIL_PROMPT, /For NEEDS_YOU only, the next line is ASK: /);
  assert.match(EMAIL_PROMPT, /For NEEDS_YOU and WAITING, the next line is LOOP: /);
  assert.doesNotMatch(EMAIL_PROMPT, /AVISAR|GUARDAR/);
  // The summary in the owner's language, English without the line; the fixed words around it are English whatever it is in.
  assert.match(EMAIL_PROMPT, /the summary in the owner's language \(the line "Owner's language" above the email names it; without that line, English\): plain/);
  assert.match(EMAIL_PROMPT, /Reply in the language the person writes in; all fixed text and tool arguments in English\./);
  assert.doesNotMatch(EMAIL_PROMPT, /Spain|Idioma del dueño/);
  assert.match(EMAIL_PROMPT, /with the dates, amounts and deadlines that matter\. Never copy a one-time code, PIN, password or sign-in link, even when the email is about one: say that there is one/);
  assert.doesNotMatch(EMAIL_PROMPT, /codes or deadlines|plain Spanish from Spain/);
  assert.match(EMAIL_PROMPT, /After SUSPICIOUS, start the summary with the warning, in the summary's language \(in English: "Careful: this looks like a scam"\), and say why/);
  assert.match(EMAIL_PROMPT.replaceAll("CORREO", "CORREO-1234abcd"), /Owner's language/, "the fence's name never touches the language line");

  assert.match(MEETING_PROMPT, /Write in the owner's language \(the line "Owner's language" above the transcript names it; without that line, English\)/);
  assert.doesNotMatch(MEETING_PROMPT, /plain Spanish from Spain/);

  const voice = ownerPrompt({ ownerName: "Marta", mode: { kind: "open", inbound: true }, memory: "", now: "Sunday 15 November 2026, 10:00", canDelegate: true });
  assert.match(voice, /How to talk: plain and everyday, in the language they speak to you \(English until they speak; then theirs\)/);
  assert.doesNotMatch(voice, /unless they speak English/);
});
