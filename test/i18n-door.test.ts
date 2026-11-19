// The door is English only (src/whatsapp.ts, src/undo.ts, src/codes.ts, src/store-guard.ts, src/control.ts, wired in src/app.ts): every
// fixed text it writes is English, whatever language the owner writes in: command answers, cards and their buttons, receipts and Undo,
// reminders, the notices kept for later, STOP and RESUME, the store guard's notices, the code's mark, HELP, the log and the notes on what
// happened. The commands are English words; HELP lists only what this server has on, and the bridge's context says Pako's texts are English.
// Claude's own answers are not here: they follow the language each message is written in (assistant/prompt.ts, and the live evals).

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import express from "express";
import { createApp, loadAppConfig, type LocalContext } from "../src/app.ts";
import type { Booking } from "../src/booking.ts";
import { CODE_MARK, codeMark, hideCodes, OLD_CODE_MARK } from "../src/codes.ts";
import { createControl, logText, PAUSED_TEXT, pausedText, type Control } from "../src/control.ts";
import type { Lang } from "../src/i18n.ts";
import type { Kv } from "../src/kv.ts";
import { createLocalChannel, loadHome, localEnv, type LocalSettings } from "../src/local.ts";
import { sqliteKv } from "../src/sqlite-kv.ts";
import { createStoreGuard, SENTINEL_KEY, watchStore, type StoreLost } from "../src/store-guard.ts";
import { nothingReverted, receiptText, undoneText, whenText, type Change } from "../src/undo.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";
import { callOutcome, loadWhatsappConfig, mountWhatsapp, type OwnerAsk, type TelegramDoor, type WhatsappDeps } from "../src/whatsapp.ts";

type Body = Record<string, any>;
const OWNER = "+34600111222";
const ENV = {
  WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
};
/** Saturday 14 November 2026, 13:00 in Madrid. */
const T0 = Date.parse("2026-11-14T12:00:00Z");
const HOUR = 3600_000;

/**
 * Words only Spanish has (whole words, any case) and the letters and marks English never uses: one of them in an English text is a Spanish
 * text left behind. The test data the fakes give is English, so anything found here came from the door.
 */
const SPANISH = new RegExp(
  "(?<!\\p{L})(?:llam\\p{L}*|cancelar|enviar|enviado|envío|deshacer|deshecho|hecho|recordatorios?|tarjetas?|mensajes?|ahora|mañana|hoy|está|estaba"
    + "|también|códigos?|codigos?|correos?|pausa|parado|marcha|enlace|pulsa|escribe|vale|notas?|quité|volví|apunté|conectado|desconectado|registro"
    + "|vacío|almacén|puedo|tu|tus|que|de|y|el|la|los|las|por|para|con|sin|es|una?|del|al|lo|se|te|mi|ya|aún|más|qué|hace|he|ha)(?!\\p{L})"
    + "|[¿¡«»ñáéíóú]",
  "iu",
);
const spanishIn = (texts: string[]): string[] => texts.filter((s) => SPANISH.test(s)).map((s) => `${SPANISH.exec(s)?.[0]} in: ${s}`);

function memKv(): Kv & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    m,
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => {
      m.set(k, v);
    },
  };
}

/** Telegram beside the door, paired but not reachable now: what Pako starts goes to the door's own chat. */
function fakeTelegram(): TelegramDoor {
  return {
    paired: async () => true,
    reachable: async () => false,
    deliver: async () => true,
    pairLink: async () => "https://t.me/pako_test_bot?start=abc123",
    unpair: async () => true,
    farewell: async () => undefined,
    media: async () => null,
  };
}

/** Only what the door asks of the table booking for its commands and cards (no search, no card waiting). */
const fakeBooking = (): Booking =>
  ({ take: () => null, cancel: () => undefined, list: async () => "🍽️ Bookings: none yet.", context: async () => [] }) as unknown as Booking;

let n = 0; // message ids are unique across rigs, so no message looks like one delivered again

interface RigOptions {
  /** The language function the door is given (always English now); absent, the door's own default (English too). */
  lang?: { now: Lang };
  /** Every optional feature on: mail, codes, calendar, Zoom, Slack, bookings, the panel, Telegram. */
  all?: boolean;
  /** The kill switch and the log (on unless false). */
  control?: boolean;
  contacts?: string[];
  env?: Record<string, string>;
}

/** The door with Meta faked, as src/app.ts builds it; its bridge routes served on a local port. */
async function rig(o: RigOptions = {}) {
  const sent: Body[] = [];
  const meta = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.body) sent.push(JSON.parse(String(init.body)) as Body);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out${sent.length}` }] }), { status: 200 });
  }) as typeof fetch;
  const clock = { now: T0 };
  const kv = memKv();
  const memory = loadMemory(kv);
  const control: Control | null = o.control === false ? null : createControl(kv, () => clock.now);
  const contacts = o.contacts ?? ["Ana"];
  const placed: string[] = [];
  const tools = loadVoiceTools({
    memory,
    actions: {
      contacts: () => contacts,
      callContact: async (a) => {
        placed.push(a.name);
        return { ok: true, text: `Call to ${a.name} started: call_id=call_abc123, status=registered.` };
      },
      lookupCall: async () => JSON.stringify({ call_id: "call_abc123", call_status: "ended", call_successful: true, duration_seconds: 41 }),
    },
    // As src/personal-caller.ts builds them: the same language as the door's own texts.
    ...(o.lang ? { lang: () => o.lang!.now } : {}),
  });
  const config = loadWhatsappConfig({ ...ENV, ...(o.env ?? {}) }, OWNER).config!;
  const days: number[] = [];
  const features: Partial<WhatsappDeps> = o.all
    ? {
        mail: { address: "pako@example.com", recent: async () => [], digest: async () => "📧 Last day: one email from the bank." },
        codes: { recent: async () => [{ at: clock.now - 30_000, from: "Google <no-reply@accounts.google.com>", codes: ["583014"] }] },
        calendar: {
          day: async (d: number) => {
            days.push(d);
            return d === 0 ? "Today: dentist at 10:00" : "Tomorrow: nothing on";
          },
          context: async () => [],
        },
        zoom: { upcoming: async () => ["Mon 16 Nov 10:00 Weekly sync"], summaries: async () => ["Fri 13 Nov Budget review: approved"], annotate: async () => true },
        slack: { search: async () => [], recent: async () => ["#general Ana: lunch at one?"] },
        booking: fakeBooking(),
        panelLink: () => "https://pako.example.com/panel/login?t=abc",
        telegram: fakeTelegram(),
      }
    : {};
  const app = express();
  const door = mountWhatsapp(app, {
    config, tools, memory, kv, ownerName: "Marta", timeZone: "Europe/Madrid", contacts: () => contacts,
    contactByName: (name) => (name.toLowerCase() === "ana" ? { name: "Ana", number: "+34 600 111 333" } : null),
    fetch: meta, now: () => clock.now, callCheckMs: 5, receiptWaitMs: 5,
    ...(control ? { control } : {}),
    ...(o.lang ? { lang: () => o.lang!.now } : {}),
    ...features,
  });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { authorization: `Bearer ${config.bridgeToken}` };
  /** The owner writes (on WhatsApp); what became of it, as the door says it for its log. */
  const say = (text: string): Promise<string> =>
    door.ingest({ from: door.ownerFrom, id: `wamid.i${++n}`, timestamp: "1", type: "text", text: { body: text } });
  const press = (id: string): Promise<string> =>
    door.ingest({ from: door.ownerFrom, id: `wamid.i${++n}`, timestamp: "1", type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: "" } } });
  const post = async (path: string, body: unknown): Promise<number> =>
    (await fetch(`${base}${path}`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) })).status;
  const context = async (): Promise<Body> => (await (await fetch(`${base}/assistant/context`, { headers: auth })).json()) as Body;
  /** What the bridge's poll answers (no wait). */
  const inbox = async (): Promise<Body> => (await (await fetch(`${base}/assistant/inbox`, { headers: auth })).json()) as Body;
  /** One line per thing the owner was shown: a text, a card with its buttons (their id's kind and title), a template's words. */
  const shown = (): string[] =>
    sent.map((b) => {
      if (b.type === "text") return String(b.text.body);
      if (b.type === "template") return String(b.template.components[0].parameters.at(-1).text);
      const buttons = (b.interactive.action.buttons as Body[]).map((x) => `${String(x.reply.id).slice(0, 3)}${x.reply.title}`);
      return `${b.interactive.body.text}\n[${buttons.join(" | ")}]`;
    });
  const last = (): string => shown().at(-1) ?? "";
  /** The ids of the buttons on the latest card. */
  const buttons = (): string[] => (sent.filter((b) => b.type === "interactive").at(-1)?.interactive.action.buttons as Body[] ?? []).map((x) => String(x.reply.id));
  /** Waits for a send started in the background (a call's outcome). */
  const until = async (re: RegExp): Promise<string> => {
    for (let i = 0; i < 400; i++) {
      const hit = shown().find((s) => re.test(s));
      if (hit) return hit;
      await sleep(5);
    }
    throw new Error(`nothing shown matches ${re}`);
  };
  return {
    sent, clock, kv, memory, control, door, days, placed, say, press, post, context, inbox, shown, last, buttons, until,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

/** A friend call the connector asks for (src/personal-caller.ts writes the card; here it is English test data). */
function ask(name = "Ana"): OwnerAsk {
  return {
    name,
    card: `Claude asks to call ${name} to say Marta is running late.\n\nCall?`,
    place: async () => ({ ok: true, text: `Call to ${name} started: call_id=call_k1, status=registered.` }),
    closed: () => undefined,
  };
}

test("English: every command answer, card, receipt, reminder, notice, STOP/RESUME, code and HELP the door writes is English", async () => {
  const r = await rig({ lang: { now: "en" }, all: true });
  try {
    // HELP first: what Pako does, then every command this server has on.
    assert.equal(await r.say("HELP"), "help shown");
    const help = r.last();
    assert.match(help, /^I'm Pako, your assistant\. .* I also call your contacts with a message, but only once you press Call/s);
    for (const word of ["STOP", "MAIL", "CODE", "CALENDAR", "ZOOM", "BOOKINGS", "SLACK", "PANEL", "TELEGRAM", "LOG", "UNDO", "HELP"]) {
      assert.match(help, new RegExp(`^• ${word}\\b`, "m"), word);
    }
    assert.ok(help.length < 1500, "well inside WhatsApp's 4096");

    // The commands, each answered by the server.
    assert.equal(await r.say("MAIL"), "mail digest shown");
    assert.equal(await r.say("CODE"), "codes shown");
    assert.equal(r.last(), "🔑 Code from Google <no-reply@accounts.google.com> (just now): 583014");
    assert.equal(await r.say("CALENDAR TODAY"), "agenda shown");
    assert.equal(await r.say("MEETINGS"), "zoom shown");
    assert.equal(r.last(), "🎥 Upcoming meetings:\n• Mon 16 Nov 10:00 Weekly sync\n\nLatest summaries:\n• Fri 13 Nov Budget review: approved");
    assert.equal(await r.say("SLACK"), "slack shown");
    assert.equal(r.last(), "💬 Slack, last 24 h (1):\n• #general Ana: lunch at one?");
    assert.equal(await r.say("PANEL"), "panel link sent");
    assert.match(r.last(), /^🖥️ Your Pako panel \(a one-time link for 10 minutes; after that the browser stays signed in for 30 days\):\nhttps:/);
    assert.equal(await r.say("TELEGRAM"), "telegram link sent");
    assert.match(r.last(), /^Telegram is already connected\. To connect another account, open this link .* press “Start”/s);
    assert.equal(await r.say("TELEGRAM OFF"), "telegram unpaired");
    assert.equal(r.last(), "Telegram disconnected: I won't write to you there any more. To connect it again, type TELEGRAM.");
    assert.equal(await r.say("UNDO"), "undo none");
    assert.equal(r.last(), "There's nothing recent to undo.");

    // STOP and RESUME, and a RESUME with nothing paused.
    assert.equal(await r.say("STOP"), "paused");
    assert.match(r.last(), /^⏸ Stopped\. I won't call or message anyone until you type RESUME\./);
    assert.equal(await r.say("RESUME"), "resumed");
    assert.equal(r.last(), "▶️ Running again.");
    assert.equal(await r.say("RESUME"), "resumed");
    assert.equal(r.last(), "I wasn't stopped: everything is working.");

    // A reminder from the assistant: its receipt, with Undo; Undo pressed; then one that comes due, a bad time, one far ahead.
    assert.equal(await r.post("/assistant/reply", { remind: [{ at: "2026-11-14 18:00", text: "buy milk" }] }), 200);
    assert.equal(r.last(), "⏰ Reminder: Sat 14 Nov, 18:00 · “buy milk”\n[u1:Undo]");
    assert.equal(await r.press(r.buttons()[0]!), "button pressed");
    assert.equal(r.last(), "↩️ Undone: removed the reminder “buy milk”.");
    await r.post("/assistant/reply", { remind: [{ at: "2026-11-14 13:05", text: "call the bank" }, { at: "tomorrow", text: "x y z" }] });
    assert.ok(r.shown().includes("I didn't understand the time “tomorrow” for the reminder."));
    await r.post("/assistant/reply", { unremind: ["dentist"] });
    assert.equal(r.shown().at(-1), "I didn't find any reminder with those words.");
    r.clock.now += 6 * 60_000;
    await r.door.runReminders();
    assert.equal(r.last(), "Reminder: call the bank\n[r1:Done | r2:+10 min | r3:Tomorrow]");
    await r.post("/assistant/reply", { remind: [{ at: "2026-11-16 09:00", text: "pay the rent" }] });
    assert.ok(r.shown().some((s) => /^Heads up: by then it will be more than 24 hours since your last message/.test(s)), "warned up front");

    // Notes: kept and forgotten, each with a receipt.
    await r.post("/assistant/memory", { remember: ["likes green tea"] });
    assert.equal(r.last(), "📝 Noted: “likes green tea”\n[u1:Undo]");
    await r.post("/assistant/memory", { forget: ["green tea"] });
    assert.equal(r.last(), "🗑️ Deleted the note “likes green tea”\n[u1:Undo]");

    // The assistant's call card, answered in words; a message prepared as a link (friend messages are off); an unknown name.
    await r.post("/assistant/reply", { call: { name: "Ana", message: "she is running late" } });
    assert.equal(r.last(), "I'll call Ana to tell them: she is running late. Shall I?\n[c1:Call | c0:Cancel]");
    assert.equal(await r.say("no"), "typed answer to a call");
    assert.equal(r.last(), "OK, I won't call.");
    await r.post("/assistant/reply", { send: { to: "Ana", text: "running late, see you at nine" } });
    assert.ok(r.shown().includes("I don't write to your friends from my number (WhatsApp's business terms don't allow it for personal use). Here it is for you to send:"));
    assert.match(r.last(), /^Message for Ana:\n“running late, see you at nine”\n\nOpen it and press send \(it goes from your WhatsApp, not mine\):\nhttps:\/\/wa\.me\//);
    await r.post("/assistant/reply", { message: { to: "Bob", text: "hi there" } });
    assert.match(r.last(), /^“Bob” isn't in your contacts/);

    // The connector's card: Cancel, a second press, an expired one, and Call pressed while paused from the panel.
    assert.deepEqual(await r.door.askCall(ask()), { ok: true, where: "on WhatsApp" });
    assert.equal(r.last(), "Claude asks to call Ana to say Marta is running late.\n\nCall?\n[k1:Call | k0:Cancel]");
    const [, cancel] = r.buttons();
    await r.press(cancel!);
    assert.equal(r.last(), "OK, I won't call.");
    await r.press(cancel!);
    assert.equal(r.last(), "That card has already been answered: nothing more to do.");
    await r.press("k1:0123456789");
    assert.equal(r.last(), "That has expired: I didn't call. If you still want to, ask Claude again.");
    await r.press("c1:0123456789");
    assert.equal(r.last(), "That has expired. Ask me again if you want me to do it.");
    await r.door.askCall(ask());
    const [call] = r.buttons();
    await r.control!.setPaused(true, r.clock.now);
    await r.press(call!);
    assert.equal(r.last(), "Pako is paused (STOP): no calls or messages go out until you type RESUME. I didn't call Ana.");
    await r.say("RESUME");
    // A card STOP annuls, pressed afterwards.
    await r.door.askCall(ask("Luis"));
    const [luis] = r.buttons();
    await r.say("STOP");
    await r.press(luis!);
    assert.equal(r.last(), "That card was cancelled when Pako was paused: I didn't call.");
    await r.say("RESUME");

    // Something that is not text, and the offline notice.
    await r.door.ingest({ from: r.door.ownerFrom, id: `wamid.i${++n}`, timestamp: "1", type: "sticker", sticker: { id: "st1" } });
    assert.equal(r.last(), "For now I only read text here.");
    r.clock.now += 2 * 60_000;
    // Not "what's on today?": that is the calendar view now (src/intents.ts), answered without Claude.
    assert.equal(await r.say("what's the weather like?"), "queued");
    assert.equal(r.last(), "My brain (Claude on your computer) is offline right now. I'll keep your message and answer when it's back.");

    // The log, in English, with its English dates (LOG shows the last 15 lines; all of them are in the log).
    assert.equal(await r.say("LOG"), "log shown");
    assert.match(r.last(), /^What I've done lately:\n14\/11, 13:\d\d · /);
    const log = (await r.control!.recent(100)).map((l) => l.text).join("\n");
    for (const line of ["Panel link sent", "Telegram link sent", "Telegram disconnected", "STOP: everything stopped", "RESUME: running again",
      "Code shown (email from Google", "Reminder for 2026-11-14 18:00: buy milk", "Undone: removed the reminder “buy milk”", "Sent: call the bank",
      "Note saved: likes green tea", "1 note(s) deleted (green tea)"]) assert.ok(log.includes(line), line);

    // Nothing the owner was shown, and nothing in the assistant's context, is Spanish.
    assert.deepEqual(spanishIn(r.shown()), []);
    const ctx = await r.context();
    assert.equal(ctx.uiLanguage, "en");
    assert.ok((ctx.events as string[]).length >= 5, "the notes on what happened are there");
    assert.deepEqual(spanishIn(ctx.events as string[]), []);
    assert.deepEqual(spanishIn((await r.control!.recent(100)).map((l) => l.text)), []);
  } finally {
    r.close();
  }
});

test("English texts: a message or a call for a friend goes under Pako's English words; a typed 'send it' sends, and never places a call", async (t) => {
  t.mock.method(console, "log", () => undefined); // the phone tools say each call they place
  const r = await rig({ lang: { now: "en" }, env: { WHATSAPP_FRIEND_MESSAGES: "1" } });
  try {
    await r.say("hello");
    // None of the six words the old guess looked for (the, you, and, is, are, to): it used to go out under a Spanish first line.
    await r.post("/assistant/reply", { send: { to: "Ana", text: "Dinner moved, 9pm tomorrow" } });
    assert.equal(r.last(), "I'll write to Ana from my number:\n“Message on behalf of Marta, sent by their AI assistant:\n\nDinner moved, 9pm tomorrow”\n\nSend it?\n[s1:Send | s0:Cancel]");
    assert.equal(await r.say("Send it."), "typed answer to a message");
    assert.equal(r.last(), "Sent to Ana. I'll tell you when it arrives.");
    // A Spanish message: Pako's first line is English; the owner's words under it stay as they wrote them.
    await r.post("/assistant/reply", { send: { to: "Ana", text: "que llego tarde, nos vemos a las nueve" } });
    assert.match(r.last(), /^I'll write to Ana from my number:\n“Message on behalf of Marta, sent by their AI assistant:\n\nque llego tarde, nos vemos a las nueve”/);
    assert.equal(await r.say("no"), "typed answer to a message");
    // The call card: in English, and "send it" is no answer to it (it goes to the assistant, and nobody is called).
    await r.post("/assistant/reply", { call: { name: "Ana", message: "Marta will be 10 minutes late" } });
    assert.equal(r.last(), "I'll call Ana to tell them: Marta will be 10 minutes late. Shall I?\n[c1:Call | c0:Cancel]");
    assert.equal(await r.say("send it"), "queued");
    assert.deepEqual(r.placed, []);
  } finally {
    r.close();
  }
});

test("English: messages from Pako's number, the notices kept while WhatsApp's 24 hours are over, held reminders and the template's preview", async () => {
  const r = await rig({ lang: { now: "en" }, env: { WHATSAPP_FRIEND_MESSAGES: "1", WHATSAPP_REMINDER_TEMPLATE: "pako_aviso" } });
  try {
    await r.say("hello");
    // A message from Pako's own number: its card, a typed cancel, then Send pressed while paused from the panel.
    await r.post("/assistant/reply", { send: { to: "Ana", text: "running late, see you at nine" } });
    assert.equal(
      r.last(),
      "I'll write to Ana from my number:\n“Message on behalf of Marta, sent by their AI assistant:\n\nrunning late, see you at nine”\n\nSend it?\n[s1:Send | s0:Cancel]",
    );
    assert.equal(await r.say("cancel"), "typed answer to a message");
    assert.equal(r.last(), "OK, I won't send it.");
    await r.post("/assistant/reply", { send: { to: "Ana", text: "see you at nine" } });
    await r.control!.setPaused(true, r.clock.now);
    await r.press(r.buttons()[0]!);
    assert.equal(r.last(), "I didn't send it: Pako is paused (STOP): no calls or messages go out until you type RESUME.");
    await r.say("RESUME");
    await r.post("/assistant/reply", { send: { to: "Ana", text: "see you at nine" } });
    await r.press(r.buttons()[0]!);
    assert.equal(r.last(), "Sent to Ana. I'll tell you when it arrives.");

    // A day later WhatsApp's window is closed: a reminder goes by the template; a long notice is kept and a preview pings, then a second one.
    await r.post("/assistant/reply", { remind: [{ at: "2026-11-15 14:00", text: "water the plants" }] });
    r.clock.now = T0 + 25 * HOUR;
    await r.door.runReminders();
    assert.equal(r.last(), "⏰ Reminder: water the plants");
    const long = (what: string) => `${what}: ${"news ".repeat(150)}`;
    await r.door.notifyOwner(long("first"), { urgent: true });
    await r.door.notifyOwner(long("second"), { urgent: true });
    assert.match(r.last(), /^second: news .*… \(and 1 more notice waiting\)$/);
    // The owner writes: what was kept comes first (then the offline notice: no bridge asks in this test).
    await r.say("hi");
    assert.match(r.shown().at(-2)!, /^While we weren't talking, this came in:\n\nfirst: news .*\n\nsecond: news/s);
    assert.deepEqual(spanishIn(r.shown()), []);
  } finally {
    r.close();
  }
  // Without a template a reminder due after the 24 hours waits, and is given when the owner next writes.
  const q = await rig({ lang: { now: "en" } });
  try {
    await q.say("hello");
    await q.post("/assistant/reply", { remind: [{ at: "2026-11-15 14:00", text: "water the plants" }] });
    q.clock.now = T0 + 25 * HOUR;
    await q.door.runReminders();
    await q.say("hi");
    assert.ok(q.shown().includes("While we weren't talking, this reminder came due (it was for 2026-11-15 14:00): water the plants\n[r1:Done | r2:+10 min | r3:Tomorrow]"));
    assert.deepEqual(spanishIn(q.shown()), []);
    assert.deepEqual(spanishIn((await q.context()).events as string[]), []);
  } finally {
    q.close();
  }
});

/** The same conversation for both rigs: commands, a receipt and its undo, a card, STOP and RESUME. */
async function conversation(r: Awaited<ReturnType<typeof rig>>): Promise<string[]> {
  for (const words of ["HELP", "MAIL", "CODE", "AGENDA", "MEETINGS", "BOOKINGS", "SLACK", "PANEL", "TELEGRAM", "TELEGRAM OFF", "UNDO"]) {
    await r.say(words);
  }
  await r.post("/assistant/reply", { remind: [{ at: "2026-11-14 18:00", text: "comprar leche" }] });
  await r.press(r.buttons()[0]!);
  await r.post("/assistant/memory", { remember: ["le gusta el té verde"] });
  await r.post("/assistant/reply", { call: { name: "Ana", message: "que llego tarde" } });
  await r.say("no");
  await r.door.askCall(ask());
  await r.press(r.buttons()[1]!);
  await r.say("STOP");
  await r.say("RESUME");
  await r.say("LOG");
  // The buttons' ids are random: their kind and title are what the owner sees.
  return r.shown();
}

test("a Spanish-writing owner gets Pako's UI in English: buttons, receipts, reminders, HELP, STOP, the log; their own words stay as written", async () => {
  const r = await rig({ all: true });
  try {
    // The owner writes in Spanish first: the language heard is theirs, for Claude's free-form summaries only.
    await r.say("¿Me puedes decir qué tiempo va a hacer mañana en Madrid, por favor?");
    await r.say("¿Y qué tal el fin de semana en Sevilla, por favor? Gracias de antemano.");
    const a = await conversation(r);
    assert.match(a[0]!, /^I'm Pako, your assistant\. /, "HELP");
    assert.ok(a.includes("🔑 Google code <no-reply@accounts.google.com> (just now): 583014") || a.some((x) => /^🔑 .*583014$/.test(x)), a.join(" | "));
    assert.ok(a.includes("⏰ Reminder: Sat 14 Nov, 18:00 · “comprar leche”\n[u1:Undo]"), a.join(" | "));
    assert.ok(a.includes("↩️ Undone: removed the reminder “comprar leche”."));
    assert.ok(a.includes("I'll call Ana to tell them: que llego tarde. Shall I?\n[c1:Call | c0:Cancel]"));
    assert.ok(a.includes("OK, I won't call."));
    assert.ok(a.some((x) => x.startsWith("⏸ Stopped. I won't call or message anyone until you type RESUME.")));
    assert.ok(a.includes("▶️ Running again."));
    assert.ok(a.includes("Telegram disconnected: I won't write to you there any more. To connect it again, type TELEGRAM."));
    assert.ok(a.includes("There's nothing recent to undo."));
    assert.match(a.at(-1)!, /^What I've done lately:\n/);
    // Nothing Pako wrote is Spanish; only the owner's own words ("comprar leche", "que llego tarde") are.
    const own = /comprar leche|que llego tarde/;
    assert.deepEqual(spanishIn(a.map((x) => x.replace(/“[^”]*”/g, "“…”")).filter((x) => !own.test(x))), []);
    const ctx = await r.context();
    assert.equal(ctx.uiLanguage, "en", "an older bridge, which writes Spanish when it is missing, is told English");
    assert.equal(ctx.language, "es", "the owner's own language: for what Claude writes freely");
    assert.equal((await r.inbox()).uiLanguage, "en");
    assert.ok((await r.control!.recent(50)).some((l) => l.text === "STOP: everything stopped"));
  } finally {
    r.close();
  }
});

test("the commands are English words; the old Spanish words are not commands any more (they reach Claude, which answers in Spanish)", async () => {
  const words: [string, string][] = [
    ["STOP", "paused"], ["PAUSE", "paused"], ["RESUME", "resumed"], ["MAIL", "mail digest shown"], ["Mail.", "mail digest shown"], ["INBOX", "mail digest shown"],
    ["AGENDA", "agenda shown"], ["CALENDAR", "agenda shown"], ["ZOOM", "zoom shown"], ["MEETINGS", "zoom shown"],
    ["BOOKINGS", "bookings shown"], ["my bookings", "bookings shown"], ["SLACK", "slack shown"], ["PANEL", "panel link sent"], ["TELEGRAM", "telegram link sent"],
    ["TELEGRAM OFF", "telegram unpaired"], ["telegram disconnect", "telegram unpaired"], ["LOG", "log shown"], ["UNDO", "undo none"],
    ["CODE", "codes shown"], ["HELP", "help shown"], ["Help!", "help shown"],
  ];
  const r = await rig({ all: true });
  try {
    for (const [said, outcome] of words) assert.equal(await r.say(said), outcome, said);
    // The day follows the words: today, tomorrow, or both.
    r.days.length = 0;
    for (const said of ["AGENDA TODAY", "CALENDAR TODAY", "calendar tomorrow", "AGENDA"]) await r.say(said);
    assert.deepEqual(r.days, [0, 0, 1, 0, 1]);
    // Not a command: a sentence with one of the words in it, a bare "tomorrow", "email" (an answer to "by WhatsApp or by email?").
    assert.equal(await r.say("help me with the rent"), "queued");
    assert.equal(await r.say("tomorrow"), "queued");
    for (const answer of ["Email", "email.", "E-mail", "EMAIL"]) assert.equal(await r.say(answer), "queued", answer);
    // The Spanish command words of before are ordinary messages now. STOP is the same word in both languages.
    for (const said of ["PAUSA", "REANUDA", "CORREO", "Bandeja", "CALENDARIO", "REUNIONES", "RESERVAS", "TELEGRAM DESCONECTAR", "REGISTRO", "DESHACER", "AYUDA", "AGENDA MAÑANA"]) {
      assert.equal(await r.say(said), "queued", said);
    }
  } finally {
    r.close();
  }
});

test("a card can be answered in English words: sure, ok, yeah place the call; don't, cancel or no do not; a Spanish yes is no answer", async (t) => {
  t.mock.method(console, "log", () => undefined); // the phone tools say each call they place
  for (const [answer, yes] of [["sure", true], ["yeah", true], ["OK", true], ["don't", false], ["Don’t.", false], ["go ahead", true], ["Do it.", true],
    ["of course", true], ["call her", true], ["Call", true], ["confirm", true], ["yup", true], ["don't call", false], ["Don't do it", false],
    ["cancel", false], ["no thanks", false], ["No, thank you!", false], ["nope", false], ["no", false]] as const) {
    const r = await rig();
    try {
      await r.post("/assistant/reply", { call: { name: "Ana", message: "she is running late" } });
      assert.equal(await r.say(answer), "typed answer to a call", answer);
      assert.deepEqual(r.placed, yes ? ["Ana"] : [], answer);
      if (yes) await r.until(/^The call to Ana ended \(41 s\) and the message was given\.$/);
      else assert.equal(r.last(), "OK, I won't call.");
    } finally {
      r.close();
    }
  }
  for (const answer of ["sí", "vale", "hazlo"]) {
    const r = await rig();
    try {
      await r.post("/assistant/reply", { call: { name: "Ana", message: "she is running late" } });
      assert.equal(await r.say(answer), "queued", `${answer}: for Claude, not a yes to the card (its buttons still work)`);
      assert.deepEqual(r.placed, []);
    } finally {
      r.close();
    }
  }
});

test("HELP lists only the commands whose feature is on, and calls only when there are contacts to call", async () => {
  /** The command each bullet of the answer names. */
  const listed = (help: string): string[] => help.split("\n").filter((l) => l.startsWith("• ")).map((l) => /^• ([^\s:]+)/.exec(l)![1]!);
  const bare = await rig({ contacts: [] });
  try {
    assert.equal(await bare.say("help"), "help shown");
    assert.deepEqual(listed(bare.last()), ["STOP", "NOTES", "REMINDERS", "LISTS", "TASKS", "PEOPLE", "ROUTINES", "WATCHES", "LOG", "UNDO", "HELP"]);
    assert.doesNotMatch(bare.last(), /call your contacts/);
    // An off feature has no command: its word is for the assistant.
    assert.equal(await bare.say("MAIL"), "queued");
    assert.equal(await bare.say("CODE"), "queued");
  } finally {
    bare.close();
  }
  const noControl = await rig({ control: false });
  try {
    await noControl.say("HELP");
    assert.deepEqual(listed(noControl.last()), ["NOTES", "REMINDERS", "LISTS", "TASKS", "PEOPLE", "ROUTINES", "WATCHES", "UNDO", "HELP"]);
    assert.match(noControl.last(), /I also call your contacts/);
    assert.equal(await noControl.say("STOP"), "queued", "no kill switch on this server: as before, the word is for the assistant");
  } finally {
    noControl.close();
  }
  const expected = ["STOP", "MAIL", "CODE", "CALENDAR", "ZOOM", "BOOKINGS", "SLACK", "PANEL", "TELEGRAM", "NOTES", "REMINDERS", "LISTS", "TASKS", "PEOPLE", "ROUTINES", "WATCHES", "LOG", "UNDO", "HELP"];
  const all = await rig({ all: true });
  try {
    await all.say("help");
    assert.deepEqual(listed(all.last()), expected);
    // Every command HELP names is one the server answers.
    for (const word of expected) assert.notEqual(await all.say(word), "queued", word);
  } finally {
    all.close();
  }
});

test("the owner's language, for Claude's free-form summaries only: the one heard from their messages, else English; never PAKO_LANGUAGE", async () => {
  const english = "Could you please tell me what the weather will be like in London tomorrow?";
  const spanish = "¿Me puedes decir qué tiempo va a hacer mañana en Madrid, por favor?";
  const r = await rig();
  try {
    assert.equal(await r.door.language(), "en");
    assert.equal((await r.context()).language, "en");
    await r.say(english);
    let ctx = await r.context();
    assert.deepEqual([ctx.language, ctx.chatLanguage], ["en", "en"]);
    await r.say(spanish);
    assert.equal((await r.context()).language, "en", "one Spanish message does not switch it");
    await r.say(spanish.replace("Madrid", "Sevilla"));
    ctx = await r.context();
    assert.deepEqual([ctx.language, ctx.chatLanguage, ctx.uiLanguage], ["es", "es", "en"], "heard: for Claude's words; Pako's own stay English");
  } finally {
    r.close();
  }
});

test("receipts, Undo's answers, the pause, the log and a call's outcome in English, with or without a language given", () => {
  const changes: Change[] = [
    { kind: "note-added", note: { at: T0, text: "likes green tea" } },
    { kind: "reminder-added", reminder: { id: "r1", at: Date.parse("2026-11-16T08:00:00Z"), text: "call the bank" } },
    { kind: "reminders-removed", reminders: [{ id: "r2", at: T0 + HOUR, text: "buy milk" }, { id: "r3", at: T0 + 2 * HOUR, text: "x".repeat(200) }] },
  ];
  assert.equal(
    receiptText(changes, "Europe/Madrid", "en"),
    `Here's what I changed:\n📝 Noted: “likes green tea”\n⏰ Reminder: Mon 16 Nov, 09:00 · “call the bank”\n🗑️ Removed the reminder “buy milk”\n`
      + `🗑️ Removed the reminder “${"x".repeat(79)}…”`,
  );
  const many: Change[] = Array.from({ length: 8 }, (_, i) => ({ kind: "note-added", note: { at: T0, text: `note ${i}` } }));
  assert.match(receiptText(many, "Europe/Madrid", "en"), /\n…and 2 more changes\.$/);
  assert.match(receiptText(many.slice(0, 7), "Europe/Madrid", "en"), /\n…and 1 more change\.$/);
  assert.equal(receiptText(changes.slice(0, 1), "Europe/Madrid"), "📝 Noted: “likes green tea”", "no language given: English too");
  assert.equal(whenText(T0, "Europe/Madrid", "en"), "Sat 14 Nov, 13:00");
  assert.equal(whenText(T0, "Europe/Madrid"), "Sat 14 Nov, 13:00");

  const back = {
    ...nothingReverted(),
    restoredReminders: [{ id: "r2", at: T0 + HOUR, text: "buy milk" }],
    restoredNotes: [{ at: T0, text: "likes green tea" }],
    pastReminders: [{ id: "r4", at: T0 - HOUR, text: "old one" }],
    fullNotes: [{ at: T0, text: "one too many" }],
  };
  const undone = undoneText(back, "Europe/Madrid", "en");
  assert.equal(
    undone.text,
    "↩️ Undone:\n• put back the reminder “buy milk” (Sat 14 Nov, 14:00)\n• put back the note “likes green tea”\n"
      + "The reminder “old one” did not come back: its time has passed.\nThe note “one too many” did not come back: there is no room for more notes.\n"
      + "Make room (ask me to delete something) and press Undo again to get it back.",
  );
  // What the Phase 0 review added to an undo's answer, in English too: a reminder that went off or was changed since, and one still pending.
  const gone = {
    ...nothingReverted(),
    sentReminders: [{ id: "r5", at: T0 - HOUR, text: "take the pill" }],
    changedReminders: [{ id: "r6", at: T0 + HOUR, text: "call mum" }],
    samePending: [{ id: "r7", at: T0 + 2 * HOUR, text: "call mum" }],
  };
  const goneEn = undoneText(gone, "Europe/Madrid", "en");
  assert.equal(
    goneEn.text,
    "↩️ Nothing to undo:\nThe reminder “take the pill” (Sat 14 Nov, 12:00) was no longer pending: it has already gone off.\n"
      + "The reminder “call mum” (Sat 14 Nov, 14:00) was no longer pending: it was changed or deleted since.\n"
      + "“call mum” (Sat 14 Nov, 15:00) is still pending: if you don't want it either, tell me and I'll remove it.",
  );
  assert.match(goneEn.summary, /^nothing to undo: the reminder “take the pill”/);
  assert.deepEqual(spanishIn([goneEn.text, goneEn.summary]), []);
  assert.equal(undoneText(nothingReverted(), "Europe/Madrid", "en").text, "↩️ Nothing to undo: it was already as before.");
  assert.equal(undoneText({ ...nothingReverted(), pastReminders: back.pastReminders }, "Europe/Madrid", "en").text.split("\n")[0], "↩️ I couldn't undo it:");
  assert.deepEqual(spanishIn([undone.text, undone.summary, receiptText(changes, "Europe/Madrid", "en")]), []);
  assert.equal(undoneText(nothingReverted(), "Europe/Madrid").text, "↩️ Nothing to undo: it was already as before.");

  assert.equal(pausedText("owner", "en"), "Pako is paused (STOP): no calls or messages go out until you type RESUME.");
  assert.equal(pausedText(null, "en"), pausedText("owner", "en"), "a pause with no reason known is worded as the owner's");
  assert.equal(pausedText("owner"), PAUSED_TEXT, "no language given: the same English refusal");
  assert.equal(logText([], "Europe/Madrid", "en"), "The log is empty so far.");
  assert.equal(logText([], "Europe/Madrid"), "The log is empty so far.");

  assert.equal(callOutcome("Ana", { call_status: "error" }, "en"), "The call to Ana never connected.");
  assert.equal(callOutcome("Ana", { call_status: "ended", disconnection_reason: "dial_no_answer" }, "en"), "Ana didn't answer.");
  assert.equal(callOutcome("Ana", { call_status: "ended", disconnection_reason: "voicemail_reached" }, "en"), "Ana's voicemail picked up.");
  assert.equal(
    callOutcome("Ana", { call_status: "ended", duration_seconds: 5, transcript: "User: connect the number in your Zadarma account" }, "en"),
    "The call to Ana was cut off after 5 s by a Zadarma recording, before their phone rang: the fault is the line's, not Ana's.",
  );
  assert.equal(callOutcome("Ana", { call_status: "ended", duration_seconds: 9 }, "en"), "The call to Ana ended (9 s), but there's no sign the message got through.");
  assert.equal(callOutcome("Ana", { call_status: "ended", disconnection_reason: "constructor" }, "en"), "The call to Ana ended, but there's no sign the message got through.");
  assert.equal(callOutcome("Ana", { call_status: "ended", disconnection_reason: "dial_busy" }), "Ana's phone was busy.");
});

test("the code's mark is English; hiding again changes nothing; the older Spanish mark kept emails carry is still a mark, never words around a code", () => {
  const mail = "Your verification code is 482910. Order 1234 ships today.";
  const en = hideCodes(mail);
  assert.deepEqual(en, { text: "Your verification code is [code hidden · type CODE]. Order 1234 ships today.", codes: ["482910"] });
  assert.equal(codeMark("en"), "[code hidden · type CODE]");
  assert.equal(CODE_MARK, codeMark());
  assert.deepEqual(hideCodes(en.text), { text: en.text, codes: [] }, "hidden again: nothing changes");
  // A summary kept before Pako was English only carries the Spanish mark: looked at again, it stays as it is.
  const old = `Tu código de verificación es ${OLD_CODE_MARK}. Pedido 1234.`;
  assert.deepEqual(hideCodes(old), { text: old, codes: [] });
  // "code" next to a mark is the mark's own word, not a code's name.
  for (const mark of [CODE_MARK, OLD_CODE_MARK]) {
    const text = `${mark} 2024 4410`;
    assert.deepEqual(hideCodes(text), { text, codes: [] });
  }
});

/** The store guard as src/app.ts wires it, with a notice catcher instead of the door. */
async function guarded(o: { store: (Kv & { m: Map<string, string> }) | null; lang?: Lang; local?: { firstRun: boolean; lost: StoreLost | null }; typed?: boolean }) {
  const store = watchStore(o.store);
  const control = createControl(store.kv, () => T0);
  if (o.typed !== undefined) await control.setPaused(o.typed, T0); // a STOP (true) or RESUME (false) the owner typed before the look
  const said: string[] = [];
  const guard = createStoreGuard({
    store, control, notify: async (text) => void said.push(text), parts: { mail: true, telegram: true, calendar: true },
    ...(o.local ? { local: o.local } : {}), ...(o.lang ? { lang: () => o.lang! } : {}), now: () => T0, retryMs: 3_600_000, everyMs: 3_600_000,
  });
  guard.start();
  await guard.check();
  return { guard, control, said, log: async () => (await control.recent(10)).map((l) => l.text) };
}

test("store guard in English: each notice and its log line, short enough for the notice template; the same with no language given", async () => {
  const keep = console.error;
  console.error = () => undefined;
  try {
    const notices: string[] = [];
    const none = await guarded({ store: null, lang: "en" });
    assert.match(none.said[0]!, /^⚠️ Pako has no store \(VOICE_RESULTS_URL is missing\): every restart forgets everything, a STOP too\. I started PAUSED/);
    assert.deepEqual(await none.log(), ["No store (VOICE_RESULTS_URL): everything stopped until RESUME"]);
    notices.push(...none.said);

    for (const lost of ["missing", "damaged"] as const) {
      const g = await guarded({ store: memKv(), lang: "en", local: { firstRun: false, lost } });
      assert.match(g.said[0]!, /your notes, your reminders, the earlier chat, the email state, the Telegram connection and calendar access may have been lost/);
      assert.deepEqual(await g.log(), ["Store (kv.db) lost or damaged: everything stopped until RESUME"]);
      notices.push(...g.said);
    }

    const empty = memKv();
    const start = await guarded({ store: empty, lang: "en" });
    assert.equal(
      start.said[0],
      "⚠️ Pako's store came back empty (it's the first start, or Render wiped it): your notes, your reminders, the email state, the Telegram connection "
        + "and calendar access may have been lost. I started PAUSED to be safe: I won't call or message anyone. Type RESUME to go on.\n"
        + "So it doesn't happen again: on Render, put the Key Value on a paid plan (with persistence), or run Pako on your computer.",
    );
    assert.deepEqual(await start.log(), ["The store came back empty: everything stopped until RESUME"]);
    notices.push(...start.said);
    // Wiped while running, with the pause this process knows: RESUME typed, then STOP typed.
    for (const stop of [false, true]) {
      await start.control.setPaused(stop, T0);
      empty.m.clear();
      await start.guard.check();
      notices.push(start.said.at(-1)!);
    }
    assert.match(notices.at(-2)!, /^⚠️ Pako's store was emptied while it was running\. Your notes, your reminders, .* may have been lost\.\n/);
    assert.match(notices.at(-1)!, /^⚠️ Pako's store was emptied while it was running\. Your STOP still holds, but your notes, .* may have been lost\.\n/);
    assert.ok((await start.log()).includes("The store was emptied while Pako was running: the pause stays as it was"));
    start.guard.stop();

    // A STOP typed before the look at start: "as you asked".
    const typed = await guarded({ store: memKv(), lang: "en", typed: true });
    assert.match(typed.said[0]!, /may have been lost\. Still paused, as you asked\.\n/);
    notices.push(...typed.said);

    assert.equal(notices.length, 7);
    assert.deepEqual(spanishIn(notices), []);
    for (const text of notices) assert.ok(text.replace(/\s+/g, " ").length <= 600, `fits the notice template: ${text}`);

    // No language given: the same English notice.
    const plain = await guarded({ store: null });
    assert.match(plain.said[0]!, /^⚠️ Pako has no store \(VOICE_RESULTS_URL is missing\)/);
    assert.deepEqual(await plain.log(), ["No store (VOICE_RESULTS_URL): everything stopped until RESUME"]);
    assert.ok(SENTINEL_KEY);
  } finally {
    console.error = keep;
  }
});

test("src/app.ts: the door and the store guard speak English on a computer, and PAKO_LANGUAGE=es changes nothing (it is ignored)", async () => {
  const home = loadHome({ PAKO_HOME: join(mkdtempSync(join(tmpdir(), "pako-i18n-door-")), "home"), PAKO_NAME: "Ana" });
  const env: Record<string, string | undefined> = { ...localEnv({}, home, 0), PAKO_HOME: home.dir, PAKO_LANGUAGE: "es" };
  const kv = sqliteKv(home.dir);
  const settings = {
    name: () => "Ana",
    setName: () => undefined,
    welcomed: () => true,
    setWelcomed: () => undefined,
  } as LocalSettings;
  const channel = createLocalChannel({ kv });
  const local: LocalContext = {
    kv, channel, bridgeToken: home.bridgeToken, panelSecret: home.panelSecret, bridge: { status: () => ({ claude: "ok", running: true }) },
    settings, storeStart: { firstRun: false, lost: "damaged" },
  };
  const keep = { log: console.log, error: console.error };
  console.log = () => undefined;
  console.error = () => undefined;
  const app = createApp(loadAppConfig(env), env, local);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const guard = app.locals.storeGuard as { start(): void; stop(): void; check(): Promise<void> };
  try {
    const context = async (): Promise<Body> =>
      (await (await fetch(`${base}/assistant/context`, { headers: { authorization: `Bearer ${home.bridgeToken}` } })).json()) as Body;
    assert.equal((await context()).uiLanguage, "en", "PAKO_LANGUAGE=es is ignored");
    // The file store started damaged: the guard's notice reaches the panel's chat, in English.
    guard.start();
    await guard.check();
    const notice = (await channel.list(0)).find((m) => m.text.startsWith("⚠️"))?.text ?? "";
    assert.match(notice, /^⚠️ The file where I keep your things was damaged: I moved it aside \(\.bad, in your Pako folder\)/);

    // Typed in the panel's chat, signed in like the browser.
    const login = await fetch((app.locals.panelLink as () => string)().replace(/^http:\/\/127\.0\.0\.1:\d+/, base), { redirect: "manual" });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const api = (path: string, body?: unknown) =>
      fetch(`${base}${path}`, { method: body ? "POST" : "GET", headers: { cookie, "x-pako": "1", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const answer = async (text: string, re: RegExp): Promise<string> => {
      assert.equal((await api("/panel/api/chat", { text })).status, 202);
      for (let i = 0; i < 400; i++) {
        const messages = ((await (await api("/panel/api/chat?since=0")).json()) as { messages: { text: string; who: string }[] }).messages;
        const hit = messages.filter((m) => m.who === "pako").map((m) => m.text).find((t) => re.test(t));
        if (hit) return hit;
        await sleep(10);
      }
      throw new Error(`no answer matching ${re}`);
    };
    await answer("HELP", /^I'm Pako, your assistant\./);
    await answer("RESUME", /^▶️ Running again\.\nIf any notes or reminders were lost, give them to me again\.$/);
  } finally {
    guard.stop();
    server.close();
    server.closeAllConnections();
    console.log = keep.log;
    console.error = keep.error;
  }
});
