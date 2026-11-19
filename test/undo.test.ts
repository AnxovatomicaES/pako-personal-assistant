// The receipts with Undo (src/undo.ts, wired in src/whatsapp.ts): what the assistant changes by itself in the owner's notes and reminders is
// told from the server, with one button that puts exactly that back (or UNDO, typed). On WhatsApp, Telegram and the panel's chat; with the
// bridge's new way of sending notes (with the answer's key) and the old one; through a restart, and with a store that fails.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import express from "express";
import { createBridge, type BridgeConfig } from "../assistant/bridge.ts";
import { createApp, loadAppConfig, type LocalContext } from "../src/app.ts";
import { createControl, type Control } from "../src/control.ts";
import type { Kv } from "../src/kv.ts";
import { createLocalChannel, loadHome, localEnv } from "../src/local.ts";
import { sqliteKv } from "../src/sqlite-kv.ts";
import { createTelegram, type TelegramChannel } from "../src/telegram.ts";
import { createUndoJournal, receiptText, undoneText, nothingReverted, type Change } from "../src/undo.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";
import { loadWhatsappConfig, mountWhatsapp } from "../src/whatsapp.ts";

const OWNER = "+34600111222";
const OWNER_WA = "34600111222";
const OWNER_TG = 7001;
const TOKEN = `123456789:${"A".repeat(35)}`; // made up, in @BotFather's shape: it opens nothing
const ENV = {
  WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
};
/** Saturday 14 November 2026, 13:00 in Madrid. */
const T0 = Date.parse("2026-11-14T12:00:00Z");
const DAY = 24 * 3600_000;
type Body = Record<string, any>;

/** A store in a map; `failGet` / `failSet` make the calls for some keys fail, as a store that does not answer. */
function memKv(o: { failGet?: (key: string) => boolean; failSet?: (key: string) => boolean } = {}): Kv & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    m,
    get: async (k) => {
      if (o.failGet?.(k)) throw new Error("store down");
      return m.get(k) ?? null;
    },
    set: async (k, v) => {
      if (o.failSet?.(k)) throw new Error("store down");
      m.set(k, v);
    },
  };
}

/** Polls until `get` gives something (a timer or a request handled after the answer), for at most a few seconds. */
async function until<T>(get: () => T | null | undefined | false | Promise<T | null | undefined | false>, what = "it"): Promise<T> {
  const end = Date.now() + 10_000;
  for (;;) {
    const v = await get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`waited too long for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A stand-in for Telegram's Bot API: what was asked of it, answered as Telegram would. */
function fakeTelegram() {
  const calls: { method: string; params: Body }[] = [];
  let message = 100;
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = /\/bot[^/]+\/(\w+)$/.exec(String(url))?.[1] ?? "";
    calls.push({ method, params: init?.body ? (JSON.parse(String(init.body)) as Body) : {} });
    const result = method === "getMe" ? { id: 1, is_bot: true, username: "pako_test_bot" } : method === "sendMessage" ? { message_id: ++message } : true;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  }) as typeof fetch;
  return { f, calls, sent: () => calls.filter((c) => c.method === "sendMessage").map((c) => c.params) };
}

let n = 0; // message ids are unique across rigs, so a restart does not look like a repeated delivery

/** The WhatsApp door as src/app.ts builds it, with Meta faked; optionally Telegram beside it. The store is shared when given (a restart). */
async function rig(o: { kv?: Kv; clock?: { now: number }; receiptWaitMs?: number; control?: Control; telegram?: boolean } = {}) {
  const sent: { body: Body; at: number }[] = [];
  const meta = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push({ body: JSON.parse(String(init?.body)) as Body, at: Date.now() });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out${sent.length}` }] }), { status: 200 });
  }) as typeof fetch;
  const clock = o.clock ?? { now: T0 };
  const kv = o.kv ?? memKv();
  const memory = loadMemory(kv);
  const control = o.control ?? createControl(kv, () => clock.now);
  const tools = loadVoiceTools({ memory, actions: { contacts: () => ["Ana"], callContact: async () => ({ ok: true, text: "started" }), lookupCall: async () => "ok" } });
  const config = loadWhatsappConfig(ENV, OWNER).config!;
  const tg = fakeTelegram();
  const doorRef: { ingest: ((m: Body, channel?: "base" | "telegram") => Promise<string>) | null } = { ingest: null };
  const telegram: TelegramChannel | null = o.telegram
    ? createTelegram({ config: { token: TOKEN, ownerId: OWNER_TG, api: "https://tg.test" }, kv, ingest: (m) => doorRef.ingest!({ from: OWNER_WA, ...m }, "telegram"), fetch: tg.f, now: () => clock.now })
    : null;
  const app = express();
  const door = mountWhatsapp(app, {
    config, tools, memory, kv, control, ownerName: "Marta", timeZone: "Europe/Madrid", contacts: () => ["Ana"], fetch: meta, now: () => clock.now,
    callCheckMs: 5, receiptWaitMs: o.receiptWaitMs ?? 60_000, ...(telegram ? { telegram } : {}),
  });
  doorRef.ingest = door.ingest;
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const hook = async (msgs: Body[]): Promise<void> => {
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: config.phoneNumberId }, messages: msgs } }] }],
    });
    const signature = `sha256=${createHmac("sha256", config.appSecret).update(raw).digest("hex")}`;
    const res = await fetch(`${base}/whatsapp/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature }, body: raw });
    assert.equal(res.status, 200);
  };
  const text = (body: string) => ({ from: OWNER_WA, id: `wamid.u${++n}`, timestamp: "1", type: "text", text: { body } });
  const press = (buttonId: string) => ({ from: OWNER_WA, id: `wamid.u${++n}`, timestamp: "1", type: "interactive", interactive: { type: "button_reply", button_reply: { id: buttonId, title: "Undo" } } });
  const auth = { authorization: `Bearer ${config.bridgeToken}` };
  const post = async (path: string, body: unknown): Promise<Body> => {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, ...((await res.json()) as Body) };
  };
  const context = async () => (await (await fetch(`${base}/assistant/context`, { headers: auth })).json()) as { memory: string; reminders: string[]; events: string[] };
  const texts = () => sent.filter((s) => s.body.type === "text").map((s) => s.body.text.body as string);
  /** What reached the owner on WhatsApp, in order: a text's words, a card's body. */
  const said = () => sent.map((s) => (s.body.type === "text" ? (s.body.text.body as string) : (s.body.interactive?.body?.text as string)));
  const receipts = () =>
    sent
      .filter((s) => s.body.type === "interactive" && /^u1:/.test(String(s.body.interactive.action.buttons[0].reply.id)))
      .map((s) => ({ text: s.body.interactive.body.text as string, buttons: s.body.interactive.action.buttons.map((b: Body) => b.reply) as { id: string; title: string }[], at: s.at }));
  /** The owner writes on WhatsApp; the id the assistant's bridge answers it with. */
  const ask = async (words: string): Promise<string> => {
    await hook([text(words)]);
    return (await door.inbox.peek()).at(-1)!.id;
  };
  return { base, sent, clock, kv, memory, control, door, tg, telegram, hook, text, press, post, context, texts, said, receipts, ask, close: () => { server.close(); server.closeAllConnections(); } };
}

test("the bridge and the door together: notes go with their message's id and their receipt follows the answer; notes the bridge could only send on its next round get theirs then; an old bridge still gets one", async () => {
  let notesDown = false;
  const r = await rig({ kv: memKv({ failSet: (k) => notesDown && k === "owner-memory" }) });
  let answer = "";
  const config: BridgeConfig = {
    server: r.base, token: ENV.ASSISTANT_BRIDGE_TOKEN, claudeBin: "claude", model: "", stateDir: mkdtempSync(join(tmpdir(), "pako-undo-bridge-")), tools: [],
    runTimeoutMs: 10_000, rotateAfter: 30, noticeMs: 60_000, whisperModel: "", whisperBin: "whisper-cli", ffmpegBin: "ffmpeg", whisperLang: "auto",
  };
  const bridgeWith = (f: typeof fetch = fetch) =>
    createBridge({ config, run: async () => ({ text: answer, sessionId: "s1", costUsd: 0 }), fetch: f, log: () => undefined, replyWaitsMs: [0, 0, 0, 0, 0] });
  const bridge = bridgeWith();
  try {
    answer = "Apuntado. <remember>Le gusta el té verde</remember>";
    await r.hook([r.text("apunta que me gusta el té verde")]);
    assert.deepEqual(await bridge.tick(0), { seen: 1, done: 1 });
    assert.deepEqual(r.said(), ["Apuntado.", "📝 Noted: “Le gusta el té verde”"]);

    notesDown = true; // the store does not take the next note: the bridge keeps it, and its answer goes on
    answer = "Hecho. <remember>Vive en Gràcia</remember>";
    await r.hook([r.text("apunta que vivo en Gràcia")]);
    await bridge.tick(0);
    assert.equal(r.said().at(-1), "Hecho.");
    notesDown = false;
    await bridge.tick(0);
    assert.equal(r.said().at(-1), "📝 Noted: “Vive en Gràcia”", "given on the next round, at once: its reply went already");

    // A bridge from before this change sends its notes with no key.
    const old = bridgeWith((async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/assistant/memory") && init?.body) {
        const { key: _key, ...body } = JSON.parse(String(init.body)) as Body;
        return fetch(url, { ...init, body: JSON.stringify(body) });
      }
      return fetch(url, init);
    }) as typeof fetch);
    answer = "Apuntado. <remember>Su color es el verde</remember>";
    await r.hook([r.text("apunta que mi color es el verde")]);
    await old.tick(0);
    assert.deepEqual(r.said().slice(-2), ["📝 Noted: “Su color es el verde”", "Apuntado."], "its receipt goes at once, before the answer");
    assert.deepEqual((await r.memory.read()).notes.map((x) => x.text), ["Le gusta el té verde", "Vive en Gràcia", "Su color es el verde"]);
  } finally {
    r.close();
  }
});

test("remember: the receipt says what the server kept, after the reply's text, with one Undo button; pressing it takes the note away and says so", async () => {
  const r = await rig();
  try {
    const id = await r.ask("apunta que me gusta el té verde");
    await r.post("/assistant/memory", { remember: ["Le gusta el té verde"], forget: [], key: id });
    assert.deepEqual(r.receipts(), [], "it waits for the answer's reply");
    await r.post("/assistant/reply", { text: "Apuntado.", key: id });
    assert.deepEqual(r.said(), ["Apuntado.", "📝 Noted: “Le gusta el té verde”"], "the reply's text first, then the receipt");
    const [receipt] = r.receipts();
    assert.deepEqual(receipt!.buttons.map((b) => b.title), ["Undo"], "one button, nothing to cancel");
    assert.match(receipt!.buttons[0]!.id, /^u1:[0-9a-f]{10}$/, "the shape every chat's buttons take");

    await r.hook([r.text("STOP")]); // a pause stops calls and messages to others, not the owner's own notes
    await r.hook([r.press(receipt!.buttons[0]!.id)]);
    assert.deepEqual((await r.memory.read()).notes, []);
    assert.equal(r.texts().at(-1), "↩️ Undone: removed the note “Le gusta el té verde”.");
    assert.match((await r.context()).events.join("\n"), /The owner undid: removed the note “Le gusta el té verde”/, "the assistant is told");
    assert.ok((await r.control.recent(20)).some((l) => l.kind === "undo" && /removed the note “Le gusta el té verde”/.test(l.text)), "and the log");
    assert.deepEqual((await r.door.inbox.peek()).map((m) => m.text), ["apunta que me gusta el té verde"], "the press is not queued for the assistant");
  } finally {
    r.close();
  }
});

test("forget: the receipt names each note deleted; Undo puts them back in their places, with their own dates", async () => {
  const r = await rig();
  try {
    await r.memory.addNote("Ana Pérez vive en Gràcia", Date.parse("2026-10-01T10:00:00Z"));
    await r.memory.addNote("Le gusta el café solo", Date.parse("2026-10-02T10:00:00Z"));
    await r.memory.addNote("Cumpleaños de Ana Pérez: 3 de mayo", Date.parse("2026-10-03T10:00:00Z"));
    const before = (await r.memory.read()).notes;
    const id = await r.ask("olvida lo de Ana");
    const forgot = await r.post("/assistant/memory", { forget: ["ana pérez"], key: id });
    assert.deepEqual(forgot, { status: 200, remembered: 0, forgotten: 2 }, "the answer an old bridge reads is the same");
    await r.post("/assistant/reply", { text: "Olvidado.", key: id });
    const [receipt] = r.receipts();
    assert.equal(receipt!.text, "Here's what I changed:\n🗑️ Deleted the note “Ana Pérez vive en Gràcia”\n🗑️ Deleted the note “Cumpleaños de Ana Pérez: 3 de mayo”");
    assert.deepEqual((await r.memory.read()).notes.map((x) => x.text), ["Le gusta el café solo"]);
    await r.hook([r.press(receipt!.buttons[0]!.id)]);
    assert.deepEqual((await r.memory.read()).notes, before);
    assert.equal(r.texts().at(-1), "↩️ Undone:\n• put back the note “Ana Pérez vive en Gràcia”\n• put back the note “Cumpleaños de Ana Pérez: 3 de mayo”");
  } finally {
    r.close();
  }
});

test("a note that pushes the oldest out (60 at most): the receipt says so, and Undo brings the oldest back to its place", async () => {
  const r = await rig();
  try {
    for (let i = 0; i < 60; i++) await r.memory.addNote(`nota ${i}`, Date.parse("2026-10-01T10:00:00Z") + i * 60_000);
    const before = (await r.memory.read()).notes;
    const id = await r.ask("apunta una más");
    await r.post("/assistant/memory", { remember: ["Una nota más"], key: id });
    await r.post("/assistant/reply", { text: "Apuntado.", key: id });
    assert.equal(r.receipts()[0]!.text, "Here's what I changed:\n🗑️ Deleted the note “nota 0”\n📝 Noted: “Una nota más”");
    await r.hook([r.press(r.receipts()[0]!.buttons[0]!.id)]);
    assert.deepEqual((await r.memory.read()).notes, before, "the new one left first, so the old one had its room back");
    assert.equal(r.texts().at(-1), "↩️ Undone:\n• put back the note “nota 0”\n• removed the note “Una nota más”");
  } finally {
    r.close();
  }
});

test("two presses at the same moment (two phones): one undo, and the other is told it was undone already", async () => {
  const r = await rig();
  try {
    const id = await r.ask("recuérdame regar a las 20");
    await r.post("/assistant/reply", { text: "Vale.", remind: [{ at: "2026-11-14 20:00", text: "Regar las plantas" }], key: id });
    const button = r.receipts()[0]!.buttons[0]!.id;
    await Promise.all([r.hook([r.press(button)]), r.hook([r.press(button)])]);
    const answers = r.texts().slice(-2).sort();
    assert.deepEqual(answers, ["That was already undone.", "↩️ Undone: removed the reminder “Regar las plantas”."]);
    assert.deepEqual((await r.context()).reminders, []);
  } finally {
    r.close();
  }
});

test("remind: the receipt gives the day and hour the server understood; Undo removes that reminder, and it never fires", async () => {
  const r = await rig();
  try {
    const id = await r.ask("recuérdame el dentista el domingo a las 9");
    await r.post("/assistant/reply", { text: "Te lo recuerdo el domingo a las 9.", remind: [{ at: "2026-11-15 09:00", text: "Dentista" }], key: id });
    assert.deepEqual(r.said(), ["Te lo recuerdo el domingo a las 9.", "⏰ Reminder: Sun 15 Nov, 09:00 · “Dentista”"]);
    assert.deepEqual((await r.context()).reminders, ["2026-11-15 09:00 Dentista"]);
    await r.hook([r.press(r.receipts()[0]!.buttons[0]!.id)]);
    assert.deepEqual((await r.context()).reminders, []);
    assert.equal(r.texts().at(-1), "↩️ Undone: removed the reminder “Dentista”.");
    r.clock.now = Date.parse("2026-11-15T08:00:30Z");
    await r.door.runReminders();
    assert.ok(!r.said().some((t) => t.startsWith("Recordatorio:")), "nothing fires");
  } finally {
    r.close();
  }
});

test("unremind: Undo brings the reminders back as they were; one whose time has passed meanwhile is reported, not brought back late", async () => {
  const r = await rig();
  try {
    const first = await r.ask("recuérdame llamar al banco a las 13:30 y a Ana el domingo");
    const remind = [{ at: "2026-11-14 13:30", text: "Llamar al banco" }, { at: "2026-11-15 09:00", text: "Llamar a Ana" }];
    await r.post("/assistant/reply", { text: "Hecho.", remind, key: first });
    const second = await r.ask("borra las llamadas");
    await r.post("/assistant/reply", { text: "Borradas.", unremind: ["llamar"], key: second });
    const receipt = r.receipts().at(-1)!;
    assert.equal(receipt.text, "Here's what I changed:\n🗑️ Removed the reminder “Llamar al banco”\n🗑️ Removed the reminder “Llamar a Ana”");
    assert.deepEqual((await r.context()).reminders, []);
    r.clock.now = Date.parse("2026-11-14T12:45:00Z"); // 13:45 in Madrid: the bank's time has gone by
    await r.hook([r.press(receipt.buttons[0]!.id)]);
    assert.deepEqual((await r.context()).reminders, ["2026-11-15 09:00 Llamar a Ana"]);
    assert.equal(r.texts().at(-1), "↩️ Undone: put back the reminder “Llamar a Ana” (Sun 15 Nov, 09:00).\nThe reminder “Llamar al banco” did not come back: its time has passed.");
    const told = (await r.context()).events.find((e) => e.includes("undid"));
    assert.match(told ?? "", / The owner undid: put back the reminder “Llamar a Ana” \(Sun 15 Nov, 09:00\); the reminder “Llamar al banco” did not come back: its time has passed\.$/);
    r.clock.now = Date.parse("2026-11-15T08:00:30Z");
    await r.door.runReminders();
    assert.ok(r.said().includes("Reminder: Llamar a Ana"), "the one that came back fires on time");
  } finally {
    r.close();
  }
});

test("one answer, one receipt: its notes and its reminders (a moved one too) go together after its text; the same reply sent again makes no second one", async () => {
  const r = await rig();
  try {
    const id0 = await r.ask("el dentista el domingo a las 9");
    await r.post("/assistant/reply", { text: "Vale.", remind: [{ at: "2026-11-15 09:00", text: "Dentista" }], key: id0 });
    const id = await r.ask("mejor a las 11, y apunta que es la doctora Pérez");
    await r.post("/assistant/memory", { remember: ["Su dentista es la doctora Pérez"], forget: [], key: id });
    const reply = { text: "Cambiado a las 11.", remind: [{ at: "2026-11-15 11:00", text: "Dentista" }], unremind: ["dentista"], key: id };
    await r.post("/assistant/reply", reply);
    assert.deepEqual(r.said().slice(-2), [
      "Cambiado a las 11.",
      "Here's what I changed:\n📝 Noted: “Su dentista es la doctora Pérez”\n🗑️ Removed the reminder “Dentista”\n⏰ Reminder: Sun 15 Nov, 11:00 · “Dentista”",
    ]);
    assert.equal(r.receipts().length, 2, "one for each answer");
    assert.equal((await r.post("/assistant/reply", reply)).repeated, true, "the bridge did not hear back and sends it again");
    assert.equal(r.receipts().length, 2, "no second receipt");
    assert.deepEqual((await r.context()).reminders, ["2026-11-15 11:00 Dentista"]);
    await r.hook([r.press(r.receipts()[1]!.buttons[0]!.id)]);
    assert.deepEqual((await r.context()).reminders, ["2026-11-15 09:00 Dentista"], "the move is undone: the old time is back, the new one gone");
    assert.deepEqual((await r.memory.read()).notes, []);
    assert.equal(r.texts().at(-1), [
      "↩️ Undone:",
      "• removed the reminder “Dentista”",
      "• put back the reminder “Dentista” (Sun 15 Nov, 09:00)",
      "• removed the note “Su dentista es la doctora Pérez”",
    ].join("\n"));
  } finally {
    r.close();
  }
});

test("an old bridge (notes with no key): the receipt goes at once, by itself, before the reply; the reply makes none of its own", async () => {
  const r = await rig();
  try {
    const id = await r.ask("apunta que me gusta el té");
    assert.deepEqual(await r.post("/assistant/memory", { remember: ["Le gusta el té"], forget: [] }), { status: 200, remembered: 1, forgotten: 0 });
    assert.equal(r.receipts().length, 1, "at once");
    await r.post("/assistant/reply", { text: "Apuntado.", key: id });
    assert.deepEqual(r.said(), ["📝 Noted: “Le gusta el té”", "Apuntado."]);
    assert.equal(r.receipts().length, 1);
    await r.post("/assistant/memory", { remember: ["le gusta el TÉ"] });
    assert.equal(r.receipts().length, 1, "a note that was there already changed nothing: no receipt");
  } finally {
    r.close();
  }
});

test("notes whose reply never comes (an answer that was only a tag) get their receipt after a while; notes sent after their reply get it at once", async () => {
  const r = await rig({ receiptWaitMs: 150 });
  try {
    const id = await r.ask("apunta esto");
    const posted = Date.now();
    await r.post("/assistant/memory", { remember: ["Una nota sin respuesta"], key: id });
    const receipt = await until(() => r.receipts()[0], "the receipt");
    assert.ok(receipt.at - posted >= 140, `it waited for a reply first (${receipt.at - posted} ms)`);
    assert.equal(receipt.text, "📝 Noted: “Una nota sin respuesta”");
    await r.post("/assistant/reply", { text: "Ya está.", key: id }); // late: the receipt went already
    assert.equal(r.receipts().length, 1);

    // The bridge keeps notes the server could not take and sends them on its next round, after their reply went.
    const late = await r.ask("y apunta esto otro");
    await r.post("/assistant/reply", { text: "Apuntado.", key: late });
    await r.post("/assistant/memory", { remember: ["La nota que llegó tarde"], key: late });
    assert.equal(r.receipts().length, 2, "nothing to wait for");
    assert.equal(r.receipts()[1]!.text, "📝 Noted: “La nota que llegó tarde”");
  } finally {
    r.close();
  }
});

test("a second press says it was undone already; a press Meta delivers twice is handled once; an unknown or week-old receipt cannot be undone", async () => {
  const r = await rig();
  try {
    const id = await r.ask("apunta que el portal es el 4B");
    await r.post("/assistant/memory", { remember: ["El portal es el 4B"], key: id });
    await r.post("/assistant/reply", { text: "Apuntado.", key: id });
    const button = r.receipts()[0]!.buttons[0]!.id;
    const once = r.press(button);
    await r.hook([once]);
    await r.hook([once]); // Meta delivers at least once
    assert.equal(r.texts().filter((t) => t.startsWith("↩️")).length, 1);
    await r.hook([r.press(button)]);
    assert.equal(r.texts().at(-1), "That was already undone.");
    await r.hook([r.press("u1:0123456789")]);
    assert.equal(r.texts().at(-1), "That can't be undone any more.");

    const old = await r.ask("apunta que la llave está con Ana");
    await r.post("/assistant/memory", { remember: ["La llave está con Ana"], key: old });
    await r.post("/assistant/reply", { text: "Apuntado.", key: old });
    r.clock.now += 7 * DAY + 60_000;
    await r.hook([r.press(r.receipts()[1]!.buttons[0]!.id)]);
    assert.equal(r.texts().at(-1), "That can't be undone any more.");
    assert.deepEqual((await r.memory.read()).notes.map((x) => x.text), ["La llave está con Ana"], "and it stays");
  } finally {
    r.close();
  }
});

test("UNDO typed: the latest change of the last day; typed again (or after its button), it says so and never undoes an older one; never queued for the assistant", async () => {
  const r = await rig();
  try {
    const a = await r.ask("apunta uno");
    await r.post("/assistant/memory", { remember: ["Nota uno"], key: a });
    await r.post("/assistant/reply", { text: "Apuntado.", key: a });
    r.clock.now += DAY + 60_000; // more than a day later
    const b = await r.ask("apunta dos");
    await r.post("/assistant/memory", { remember: ["Nota dos"], key: b });
    await r.post("/assistant/reply", { text: "Apuntado.", key: b });
    const c = await r.ask("apunta tres");
    await r.post("/assistant/memory", { remember: ["Nota tres"], key: c });
    await r.post("/assistant/reply", { text: "Apuntado.", key: c });
    const queued = (await r.door.inbox.peek()).length;

    await r.hook([r.text("Undo")]);
    assert.equal(r.texts().at(-1), "↩️ Undone: removed the note “Nota tres”.");
    await r.hook([r.text("UNDO!")]);
    assert.equal(r.texts().at(-1), "That was already undone.", "a second one (a retry, a double send) undoes nothing else");
    assert.equal((await r.door.inbox.peek()).length, queued, "the server answered both itself");
    assert.deepEqual((await r.memory.read()).notes.map((x) => x.text), ["Nota uno", "Nota dos"]);
    await r.hook([r.press(r.receipts()[1]!.buttons[0]!.id)]);
    assert.equal(r.texts().at(-1), "↩️ Undone: removed the note “Nota dos”.", "an older change has its own button");
    await r.hook([r.press(r.receipts()[0]!.buttons[0]!.id)]);
    assert.equal(r.texts().at(-1), "↩️ Undone: removed the note “Nota uno”.", "its button still works for a week");
    await r.hook([r.press(r.receipts()[2]!.buttons[0]!.id)]);
    assert.equal(r.texts().at(-1), "That was already undone.", "the typed undo counts for its button too");
    r.clock.now += DAY + 60_000;
    await r.hook([r.text("UNDO")]);
    assert.equal(r.texts().at(-1), "There's nothing recent to undo.", "a day later");
  } finally {
    r.close();
  }
});

test("Undo pressed, then UNDO typed while the first answer is on its way: the second says it was undone, and the change before stays", async () => {
  const r = await rig();
  try {
    const a = await r.ask("recuérdame la reunión con Ana a las 20");
    await r.post("/assistant/reply", { text: "Vale.", remind: [{ at: "2026-11-14 20:00", text: "Reunión con Ana" }], key: a });
    const b = await r.ask("apunta que el portal es el 4B");
    await r.post("/assistant/memory", { remember: ["El portal es el 4B"], key: b });
    await r.post("/assistant/reply", { text: "Apuntado.", key: b });
    await r.hook([r.press(r.receipts()[1]!.buttons[0]!.id)]);
    assert.equal(r.texts().at(-1), "↩️ Undone: removed the note “El portal es el 4B”.");
    await r.hook([r.text("undo")]);
    assert.equal(r.texts().at(-1), "That was already undone.");
    assert.deepEqual((await r.context()).reminders, ["2026-11-14 20:00 Reunión con Ana"], "the reminder from before is still there");
  } finally {
    r.close();
  }
});

test("a restart: a receipt from before is undone by the new server (the journal is in the store), and an UNDO Meta delivers again after it does not undo a second change", async () => {
  const kv = memKv();
  const clock = { now: T0 };
  const a = await rig({ kv, clock });
  let button = "";
  let deshacer: Body = {};
  try {
    for (const words of ["Nota vieja", "Nota nueva", "Nota última"]) {
      const id = await a.ask(`apunta ${words}`);
      await a.post("/assistant/memory", { remember: [words], key: id });
      await a.post("/assistant/reply", { text: "Apuntado.", key: id });
    }
    button = a.receipts()[0]!.buttons[0]!.id;
    deshacer = a.text("UNDO");
    await a.hook([deshacer]);
    assert.equal(a.texts().at(-1), "↩️ Undone: removed the note “Nota última”.");
  } finally {
    a.close();
  }
  const b = await rig({ kv, clock }); // the same store, a new process
  try {
    await b.hook([b.press(button)]);
    assert.equal(b.texts().at(-1), "↩️ Undone: removed the note “Nota vieja”.");
    await b.hook([deshacer]); // the UNDO from before the restart, delivered again
    assert.equal(b.texts().at(-1), "That was already undone.");
    assert.deepEqual((await b.memory.read()).notes.map((x) => x.text), ["Nota nueva"], "the middle one was not undone by the repeat");
  } finally {
    b.close();
  }
});

test("outside WhatsApp's 24 hours the receipt is not sent to be dropped: it waits, and comes with the owner's next message as a card with its button; UNDO works on it", async () => {
  const r = await rig();
  try {
    await r.post("/assistant/memory", { remember: ["Una nota a deshora"] }); // nobody wrote in the last day
    assert.equal(r.sent.length, 0, "nothing sent: Meta would take it and drop it");
    await r.hook([r.text("hola")]);
    const [held] = r.receipts();
    assert.equal(held!.text, "While we weren't talking:\n📝 Noted: “Una nota a deshora”");
    assert.deepEqual(held!.buttons.map((b) => b.title), ["Undo"]);
    await r.hook([r.text("undo")]);
    assert.equal(r.texts().at(-1), "↩️ Undone: removed the note “Una nota a deshora”.");
  } finally {
    r.close();
  }
});

test("a receipt kept for days (the computer was off, then the owner was quiet): it comes as a card whose button undoes it, and UNDO counts its day from then", async () => {
  const r = await rig();
  try {
    const id = await r.ask("apunta que la clave del portal es 4B"); // Friday evening
    r.clock.now += 30 * 3600_000; // the computer answers on Sunday: WhatsApp's 24 hours are over
    await r.post("/assistant/memory", { remember: ["La clave del portal es 4B"], key: id });
    await r.post("/assistant/reply", { text: "Apuntado.", key: id });
    assert.equal(r.receipts().length, 0, "kept, not sent to be dropped");
    r.clock.now += 25 * 3600_000; // more than a day after the change
    await r.hook([r.text("hola")]);
    assert.equal(r.receipts().at(-1)!.text, "While we weren't talking:\n📝 Noted: “La clave del portal es 4B”");
    await r.hook([r.text("undo")]);
    assert.equal(r.texts().at(-1), "↩️ Undone: removed the note “La clave del portal es 4B”.", "a day from when the owner got it");
    assert.deepEqual((await r.memory.read()).notes, []);

    // One that reached the owner and was let be for more than a day is no longer what UNDO reaches.
    const late = await r.ask("apunta que el gato se llama Lío");
    r.clock.now += 30 * 3600_000;
    await r.post("/assistant/memory", { remember: ["El gato se llama Lío"], key: late });
    await r.post("/assistant/reply", { text: "Apuntado.", key: late });
    await r.hook([r.text("hola")]);
    const button = r.receipts().at(-1)!.buttons[0]!.id;
    r.clock.now += 25 * 3600_000;
    await r.hook([r.text("undo")]);
    assert.equal(r.texts().at(-1), "There's nothing recent to undo.");
    await r.hook([r.press(button)]);
    assert.equal(r.texts().at(-1), "↩️ Undone: removed the note “El gato se llama Lío”.", "its button still works");
  } finally {
    r.close();
  }
});

test("a store that fails: an unreadable journal still gives a working button in this process; an undo the store cannot answer says so and works when pressed again", async () => {
  let journalDown = true;
  let notesDown = false;
  const kv = memKv({ failGet: (k) => (journalDown && k === "assistant-undo") || (notesDown && k === "owner-memory") });
  kv.m.set("assistant-undo", "[{\"id\":\"not hex\"}, 5]");
  const clock = { now: T0 };
  const a = await rig({ kv, clock });
  try {
    const id = await a.ask("apunta que aparca en la plaza 12");
    await a.post("/assistant/memory", { remember: ["Aparca en la plaza 12"], key: id });
    await a.post("/assistant/reply", { text: "Apuntado.", key: id });
    const button = a.receipts()[0]!.buttons[0]!.id;
    await a.hook([a.press(button)]);
    assert.equal(a.texts().at(-1), "↩️ Undone: removed the note “Aparca en la plaza 12”.");
    journalDown = false;
    const id2 = await a.ask("apunta que el wifi es pako1234");
    await a.post("/assistant/memory", { remember: ["El wifi es pako1234"], key: id2 });
    await a.post("/assistant/reply", { text: "Apuntado.", key: id2 });
    const kept = JSON.parse(kv.m.get("assistant-undo")!) as { id: string; undoneAt?: number }[];
    assert.deepEqual(kept.map((e) => [e.id, !!e.undoneAt]), [[button.slice(3), true], [a.receipts()[1]!.buttons[0]!.id.slice(3), false]], "garbage dropped, the entry kept meanwhile joined");
  } finally {
    a.close();
  }
  const b = await rig({ kv, clock }); // after a restart nothing is in memory: the store must answer
  try {
    const button = JSON.parse(kv.m.get("assistant-undo")!).at(-1).id as string;
    journalDown = true;
    await b.hook([b.press(`u1:${button}`)]);
    assert.equal(b.texts().at(-1), "I couldn't undo it right now. Try again in a while.");
    journalDown = false;
    notesDown = true;
    await b.hook([b.press(`u1:${button}`)]);
    assert.equal(b.texts().at(-1), "I couldn't undo it right now. Try again in a while.", "the notes could not be read");
    notesDown = false;
    await b.hook([b.press(`u1:${button}`)]);
    assert.equal(b.texts().at(-1), "↩️ Undone: removed the note “El wifi es pako1234”.", "not counted as undone until it worked");
  } finally {
    b.close();
  }
});

test("Telegram: the answer to a Telegram message carries its receipt there, as one inline button; the press undoes it and is answered there", async () => {
  const r = await rig({ telegram: true });
  try {
    await r.telegram!.handle({ update_id: ++n, message: { message_id: ++n, from: { id: OWNER_TG, is_bot: false, first_name: "Marta" }, chat: { id: OWNER_TG, type: "private" }, text: "apunta que el gato se llama Lío" } });
    const id = (await r.door.inbox.peek()).at(-1)!.id;
    assert.match(id, /^tg-7001-/);
    await r.post("/assistant/memory", { remember: ["El gato se llama Lío"], key: id });
    await r.post("/assistant/reply", { text: "Apuntado.", key: id });
    const [answer, receipt] = r.tg.sent().slice(-2);
    assert.equal(answer!.text, "Apuntado.");
    assert.equal(receipt!.text, "📝 Noted: “El gato se llama Lío”");
    const keyboard = receipt!.reply_markup.inline_keyboard as { text: string; callback_data: string }[][];
    assert.equal(keyboard.length, 1);
    assert.equal(keyboard[0]!.length, 1, "one button");
    const button = keyboard[0]![0];
    assert.equal(button!.text, "Undo");
    assert.match(button!.callback_data, /^u1:[0-9a-f]{10}$/);
    assert.equal(r.sent.length, 0, "nothing on WhatsApp");
    await r.telegram!.handle({ update_id: ++n, callback_query: { id: `cb${++n}`, from: { id: OWNER_TG }, data: button!.callback_data, message: { message_id: 55, chat: { id: OWNER_TG, type: "private" } } } });
    assert.deepEqual((await r.memory.read()).notes, []);
    assert.equal(r.tg.sent().at(-1)!.text, "↩️ Undone: removed the note “El gato se llama Lío”.");
  } finally {
    r.close();
  }
});

test("the panel's chat (local mode): the receipt is a message with one Undo button, and pressing it there undoes the note", async () => {
  const home = loadHome({ PAKO_HOME: join(mkdtempSync(join(tmpdir(), "pako-undo-")), "home"), PAKO_NAME: "Ana" });
  const env: Record<string, string | undefined> = { ...localEnv({}, home, 0), PAKO_HOME: home.dir };
  const kv = sqliteKv(home.dir);
  const local: LocalContext = { kv, channel: createLocalChannel({ kv }), bridgeToken: home.bridgeToken, panelSecret: home.panelSecret, bridge: { status: () => ({ claude: "ok", running: true }) } };
  const app = createApp(loadAppConfig(env), env, local);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch((app.locals.panelLink as () => string)().replace(/^http:\/\/127\.0\.0\.1:\d+/, base), { redirect: "manual" });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const panel = (path: string, body?: unknown) =>
      fetch(`${base}${path}`, { method: body ? "POST" : "GET", headers: { cookie, "x-pako": "1", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const bridge = (path: string, body?: unknown) =>
      fetch(`${base}${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${home.bridgeToken}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    type Chat = { messages: { who: string; text: string; buttons?: { id: string; title: string }[] }[] };
    const chat = async (): Promise<Chat["messages"]> => ((await (await panel("/panel/api/chat?since=0")).json()) as Chat).messages;

    assert.equal((await panel("/panel/api/chat", { text: "apunta que riego las plantas los domingos" })).status, 202);
    const msg = await until(async () => ((await (await bridge("/assistant/inbox")).json()) as { messages: { id: string }[] }).messages[0], "the message");
    await bridge("/assistant/memory", { remember: ["Riega las plantas los domingos"], key: msg.id });
    await bridge("/assistant/reply", { text: "Apuntado.", key: msg.id });
    const shown = (await chat()).slice(-2);
    assert.deepEqual(shown.map((m) => m.text), ["Apuntado.", "📝 Noted: “Riega las plantas los domingos”"]);
    const buttons = shown[1]!.buttons!;
    assert.deepEqual(buttons.map((b) => b.title), ["Undo"]);
    assert.equal((await panel("/panel/api/chat/press", { id: buttons[0]!.id })).status, 202);
    const done = await until(async () => (await chat()).find((m) => m.text.startsWith("↩️")), "the answer");
    assert.equal(done.text, "↩️ Undone: removed the note “Riega las plantas los domingos”.");
    const ctx = (await (await bridge("/assistant/context")).json()) as { memory: string };
    assert.doesNotMatch(ctx.memory, /plantas/);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("a restart between an answer's notes and its reply: the change was kept at once, the new server gives its card with the reply, and UNDO undoes it (not an older change)", async () => {
  for (const noted of [true, false]) {
    const kv = memKv();
    const clock = { now: T0 };
    const a = await rig({ kv, clock });
    let key = "";
    try {
      await a.memory.addNote("El portal es el 4B", T0 - DAY);
      const r0 = await a.ask("recuérdame regar a las 20");
      await a.post("/assistant/reply", { text: "Vale.", remind: [{ at: "2026-11-14 20:00", text: "Regar las plantas" }], key: r0 });
      key = await a.ask("olvida lo del portal");
      await a.post("/assistant/memory", { forget: ["portal"], key });
      assert.deepEqual((await a.memory.read()).notes, []);
    } finally {
      a.close(); // Render restarts (or deploys) the service before the bridge's reply comes
    }
    const b = await rig({ kv, clock });
    try {
      await b.post("/assistant/reply", { text: "Olvidado.", key, ...(noted ? { noted: true } : {}) });
      // A newer bridge says the answer had notes: their card comes with the reply. An older one does not: the card is lost, not the change.
      assert.deepEqual(b.said(), noted ? ["Olvidado.", "🗑️ Deleted the note “El portal es el 4B”"] : ["Olvidado."]);
      await b.hook([b.text("undo")]);
      assert.equal(b.texts().at(-1), "↩️ Undone: put back the note “El portal es el 4B”.");
      assert.deepEqual((await b.context()).reminders, ["2026-11-14 20:00 Regar las plantas"], "the reminder set before stays");
    } finally {
      b.close();
    }
  }
});

test("an undo that finds no room for the notes it would bring back keeps them: its answer carries the same button, which brings them back once there is room", async () => {
  const r = await rig();
  try {
    for (let i = 0; i < 60; i++) await r.memory.addNote(`nota ${i}`, Date.parse("2026-10-01T10:00:00Z") + i * 60_000);
    const id = await r.ask("olvida lo de la nota 5");
    await r.post("/assistant/memory", { forget: ["nota 5"], key: id }); // nota 5 and nota 50 to 59
    await r.post("/assistant/reply", { text: "Olvidadas.", key: id });
    const button = r.receipts().at(-1)!.buttons[0]!.id;
    for (let i = 0; i < 11; i++) await r.memory.addNote(`otra ${i}`, T0 + i); // later notes fill the 60 again
    await r.hook([r.press(button)]);
    const answer = r.receipts().at(-1)!;
    assert.match(answer.text, /^↩️ I couldn't undo it:\nThe note “nota 5” did not come back: there is no room for more notes\./);
    assert.match(answer.text, /\nMake room \(ask me to delete something\) and press Undo again to get it back\.$/);
    assert.equal(answer.buttons[0]!.id, button, "the same button: the same entry, kept open");
    await r.hook([r.press(button)]);
    assert.match(r.receipts().at(-1)!.text, /^↩️ I couldn't undo it:/, "still no room: said again, kept again (not “ya estaba deshecho”)");
    await r.memory.forgetNotes("otra"); // the owner makes room
    await r.hook([r.press(button)]);
    assert.match(r.texts().at(-1)!, /^↩️ Undone:\n• put back the note “nota 5”\n/);
    assert.equal((await r.memory.read()).notes.filter((x) => /^nota 5/.test(x.text)).length, 11, "all eleven are back");
    await r.hook([r.press(button)]);
    assert.equal(r.texts().at(-1), "That was already undone.");
  } finally {
    r.close();
  }
});

test("Undo on a reminder moved since says it is not pending any more and names the moved one; once the move is undone, the same button removes it; one that has gone off is said too", async () => {
  const r = await rig();
  try {
    const first = await r.ask("el dentista el domingo a las 9");
    await r.post("/assistant/reply", { text: "Vale.", remind: [{ at: "2026-11-15 09:00", text: "Dentista" }], key: first });
    const moved = await r.ask("mejor a las 11");
    await r.post("/assistant/reply", { text: "Cambiado.", remind: [{ at: "2026-11-15 11:00", text: "Dentista" }], unremind: ["dentista"], key: moved });
    const [r1, r2] = r.receipts();
    await r.hook([r.press(r1!.buttons[0]!.id)]);
    assert.equal(r.texts().at(-1), [
      "↩️ Nothing to undo:",
      "The reminder “Dentista” (Sun 15 Nov, 09:00) was no longer pending: it was changed or deleted since.",
      "“Dentista” (Sun 15 Nov, 11:00) is still pending: if you don't want it either, tell me and I'll remove it.",
    ].join("\n"));
    assert.match((await r.context()).events.join("\n"), /The owner undid: nothing to undo: the reminder “Dentista” .* “Dentista” \(Sun 15 Nov, 11:00\) is still pending/);
    await r.hook([r.press(r2!.buttons[0]!.id)]);
    assert.deepEqual((await r.context()).reminders, ["2026-11-15 09:00 Dentista"], "the move undone: the 9:00 one is back");
    await r.hook([r.press(r1!.buttons[0]!.id)]);
    assert.equal(r.texts().at(-1), "↩️ Undone: removed the reminder “Dentista”.", "an undo that found nothing to do was not used up");
    assert.deepEqual((await r.context()).reminders, []);

    const water = await r.ask("recuérdame regar a las 13:30");
    await r.post("/assistant/reply", { text: "Vale.", remind: [{ at: "2026-11-14 13:30", text: "Regar" }], key: water });
    r.clock.now = Date.parse("2026-11-14T12:31:00Z"); // 13:31 in Madrid
    await r.door.runReminders();
    assert.equal(r.said().at(-1), "Reminder: Regar");
    await r.hook([r.press(r.receipts().at(-1)!.buttons[0]!.id)]);
    assert.equal(r.texts().at(-1), "↩️ Nothing to undo:\nThe reminder “Regar” (Sat 14 Nov, 13:30) was no longer pending: it has already gone off.");
  } finally {
    r.close();
  }
});

test("receipt and answer texts stay short: long notes are cut, a long list ends in how many more; the button fits WhatsApp's 20 characters", () => {
  const long = "una nota muy larga ".repeat(20).trim();
  const at = Date.parse("2026-09-04T22:05:00Z");
  const changes: Change[] = [
    { kind: "notes-forgotten", notes: Array.from({ length: 40 }, (_, i) => ({ at: i, text: `${i} ${long}` })) },
    { kind: "reminder-added", reminder: { id: "r1", at, text: long } },
  ];
  const body = receiptText(changes, "Europe/Madrid");
  assert.ok(body.length < 900, `${body.length} characters`);
  const lines = body.split("\n");
  assert.equal(lines[0], "Here's what I changed:");
  assert.equal(lines.length, 8, "the header, six changes and how many more");
  assert.equal(lines.at(-1), "…and 35 more changes.");
  assert.ok(lines[1]!.endsWith("…”") && lines[1]!.length < 110, "a long note is cut");
  assert.ok(receiptText([changes[1]!], "Europe/Madrid").startsWith("⏰ Reminder: Sat 5 Sept, 00:05 "), "a time after midnight is the next day, in Madrid");
  const back = { ...nothingReverted(), restoredNotes: changes[0]!.kind === "notes-forgotten" ? changes[0]!.notes : [] };
  const { text, summary } = undoneText(back, "Europe/Madrid");
  assert.ok(text.length < 1500 && text.split("\n").length === 9, "eight lines at most under the header");
  assert.match(text, /…and 33 more$/);
  assert.ok(summary.length <= 600);
  assert.equal(undoneText(nothingReverted(), "Europe/Madrid").text, "↩️ Nothing to undo: it was already as before.");
  assert.ok("Undo".length <= 20);
});

test("the journal keeps 30 entries for a week; ids are 10 hex characters; an entry is undone once, and a failing revert leaves it to try again", async () => {
  const kv = memKv();
  let t = T0;
  const j = createUndoJournal(kv, () => t);
  const note = (text: string): Change[] => [{ kind: "note-added", note: { at: t, text } }];
  const first = await j.record(note("primera"));
  assert.match(first.id, /^[0-9a-f]{10}$/);
  for (let i = 0; i < 31; i++) await j.record(note(`nota ${i}`));
  const stored = JSON.parse(kv.m.get("assistant-undo")!) as { id: string }[];
  assert.equal(stored.length, 30, "the last 30");
  assert.ok(!stored.some((e) => e.id === first.id));
  const did = (result: string) => async () => ({ result, left: [] as Change[], changed: true });
  assert.deepEqual(await j.undo({ id: first.id }, "p1", did("x")), { status: "gone" });
  const last = stored.at(-1)!.id;
  await assert.rejects(j.undo({ id: last }, "p2", async () => { throw new Error("store down"); }), /store down/);
  const done = await j.undo({ id: last }, "p3", did("hecho"));
  assert.equal(done.status, "done");
  assert.deepEqual(await j.undo({ id: last }, "p4", did("otra vez")), { status: "already" });
  // An undo that found nothing to do stays open: a later press tries again (what it named may have come back since).
  const idle = await j.record(note("nada"));
  assert.equal((await j.undo({ id: idle.id }, "p6", async () => ({ result: "", left: [], changed: false }))).status, "done");
  assert.equal((await j.undo({ id: idle.id }, "p7", did("ahora sí"))).status, "done");
  assert.deepEqual(await j.undo({ id: idle.id }, "p8", did("x")), { status: "already" });
  t += 8 * DAY;
  assert.deepEqual(await j.undo({ within: DAY }, "p5", did("x")), { status: "none" });
  await j.record(note("después"));
  assert.equal((JSON.parse(kv.m.get("assistant-undo")!) as unknown[]).length, 1, "a week later only the new one is kept");
});

test("memory: addNote says what it kept and what the limit pushed out; forgetNotes gives back what it deleted; removeNote and restoreNotes are exact", async () => {
  const m = loadMemory(null);
  const first = await m.addNote("Le gusta el té", 1000);
  assert.deepEqual([first.added, first.dropped], [{ at: 1000, text: "Le gusta el té" }, []]);
  assert.equal((await m.addNote("  le gusta el TÉ ", 2000)).added, null, "the same note twice is not kept again");
  for (let i = 0; i < 59; i++) await m.addNote(`nota ${i}`, 3000 + i);
  const over = await m.addNote("la sesenta y uno", 9000);
  assert.deepEqual(over.dropped, [{ at: 1000, text: "Le gusta el té" }], "the oldest went to make room");
  assert.equal(over.notes.length, 60);
  assert.deepEqual(await m.restoreNotes([{ at: 1000, text: "Le gusta el té" }]), { restored: [], full: [{ at: 1000, text: "Le gusta el té" }] }, "no room");
  assert.equal(await m.removeNote({ at: 9001, text: "la sesenta y uno" }), false, "the same words with another date are another note");
  assert.equal(await m.removeNote({ at: 9000, text: "la sesenta y uno" }), true);
  assert.equal(await m.removeNote({ at: 9000, text: "la sesenta y uno" }), false, "once");
  const back = await m.restoreNotes([{ at: 1000, text: "Le gusta el té" }, { at: 3000, text: "nota 0" }]);
  assert.deepEqual(back, { restored: [{ at: 1000, text: "Le gusta el té" }], full: [] }, "one that is there already is left alone");
  assert.deepEqual((await m.read()).notes[0], { at: 1000, text: "Le gusta el té" }, "back in its place, oldest first");
  assert.equal((await m.forgetNotes("nota 1")).length, 11, "nota 1 and nota 10 to 19");
  assert.equal(await m.forgetNote("nota 2"), 11, "forgetNote still counts them");
  assert.deepEqual(await m.forgetNotes("  "), []);
});
