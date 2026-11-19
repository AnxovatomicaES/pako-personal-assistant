// Calendar writes through the Mac app (src/calendar-writes.ts, src/door/calendar-cards.ts): a card first that says where the change came
// from, the owner's yes queues it under the card's id (the idempotency key), the Mac makes it once, the receipt has Undo that puts it back.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { pendingText, toolDataOf } from "../assistant/tools.ts";
import { findLocalEvent, pushOf } from "../src/calendar-local.ts";
import { createCalendarWrites, undoOf, type CalendarWrite } from "../src/calendar-writes.ts";
import { createControl } from "../src/control.ts";
import type { Kv } from "../src/kv.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";
import { loadWhatsappConfig, mountWhatsapp } from "../src/whatsapp.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-11-16T09:00:00Z"); // Mon 09:00 London
type Body = Record<string, any>;
function memKv() {
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  return { kv, m };
}

test("the queue: a write is queued once by its id, fetched once, sent again if unanswered, failed if never fetched; results told once", async () => {
  const clock = { now: T0 };
  const told: CalendarWrite[] = [];
  const q = createCalendarWrites({ kv: memKv().kv, now: () => clock.now, onResult: async (w) => void told.push(structuredClone(w)) });
  assert.equal(await q.enqueue({ id: "aaaaaaaaaa", op: "move", eventId: "E1", at: T0 + 60 * MIN, start: T0 + 120 * MIN, end: T0 + 150 * MIN, title: "Dentist" }), true);
  assert.equal(await q.enqueue({ id: "aaaaaaaaaa", op: "move", title: "Dentist" }), false, "the same press twice: once");
  assert.deepEqual((await q.exchange([])).map((w) => w.id), ["aaaaaaaaaa"]);
  assert.deepEqual(await q.exchange([]), [], "sent: not again at once");
  clock.now += 3 * MIN;
  assert.deepEqual((await q.exchange([])).map((w) => w.id), ["aaaaaaaaaa"], "unanswered for two minutes: sent again");
  await q.exchange([{ id: "aaaaaaaaaa", ok: true, eventId: "E1", before: { start: T0 + 60 * MIN, end: T0 + 90 * MIN } }]);
  await q.exchange([{ id: "aaaaaaaaaa", ok: true }]);
  assert.equal(told.length, 1, "a result is told once");
  assert.equal(told[0]!.status, "done");
  await q.enqueue({ id: "bbbbbbbbbb", op: "create", start: T0, end: T0 + MIN, title: "Call" });
  clock.now += 31 * MIN;
  await q.exchange([]);
  assert.equal(told.at(-1)!.status, "failed");
  assert.match(told.at(-1)!.error!, /did not pick it up/);
});

test("undo: a move goes back, a new event goes, a deleted one comes back", () => {
  const base = { status: "done" as const, queuedAt: T0, title: "Dentist" };
  const moved: CalendarWrite = { ...base, id: "m", op: "move", eventId: "E1", start: T0 + 2 * 60 * MIN, end: T0 + 150 * MIN, result: { eventId: "E1", before: { start: T0 + 60 * MIN, end: T0 + 90 * MIN } } };
  assert.deepEqual(undoOf(moved, "u1"), { id: "u1", op: "move", eventId: "E1", at: T0 + 120 * MIN, start: T0 + 60 * MIN, end: T0 + 90 * MIN, title: "Dentist", undoOf: "m" });
  assert.equal(undoOf({ ...base, id: "c", op: "create", start: T0, end: T0 + MIN, result: { eventId: "N1" } }, "u2")!.op, "delete");
  const gone = undoOf({ ...base, id: "d", op: "delete", result: { before: { start: T0, end: T0 + 30 * MIN, title: "Dentist", calendarId: "C1" } } }, "u3")!;
  assert.deepEqual([gone.op, gone.start, gone.calendarId], ["create", T0, "C1"]);
  assert.equal(undoOf({ ...moved, status: "failed" }, "u4"), null);
});

test("the push says the app writes; the event a change means is found by title and start, its occurrence by its key", () => {
  const k = pushOf({ writes: true, calendars: ["C1"], events: [{ id: "E1", calendarId: "C1", title: "Dentist (Dr Lee)", start: T0 + 60 * MIN, end: T0 + 90 * MIN }] }, { now: T0, timeZone: "Europe/London" })!;
  assert.equal(k.writes, true);
  assert.deepEqual(findLocalEvent(k, "dentist", T0 + 60 * MIN), { eventId: "E1", at: T0 + 60 * MIN, start: T0 + 60 * MIN, end: T0 + 90 * MIN, title: "Dentist (Dr Lee)", calendarId: "C1" });
  assert.equal(findLocalEvent(k, "dentist", T0 + 61 * MIN + 30_000), null, "another time: not that one");
  assert.equal(pushOf({ calendars: ["C1"], events: [] }, { now: T0, timeZone: "Europe/London" })!.writes, undefined, "an older app does not");
});

test("the tool tells the model what happens: a card when the Mac writes, the change to make by hand otherwise", () => {
  assert.match(pendingText("propose_calendar_change", "h", toolDataOf("t", { calendarWrites: 1 })), /card to confirm/);
  assert.match(pendingText("propose_calendar_change", "h", toolDataOf("t", {})), /make in their calendar app/);
});

const ENV = {
  WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
};

test("door: move «Dentist» → a card saying it was the owner's words; yes queues it once; the Mac's result gives a receipt; Undo moves it back", async () => {
  const sent: Body[] = [];
  const meta = (async (_u: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Body);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out${sent.length}` }] }), { status: 200 });
  }) as typeof fetch;
  const { kv } = memKv();
  const ref: { result: ((w: CalendarWrite) => Promise<void>) | null } = { result: null };
  const writes = createCalendarWrites({ kv, now: () => T0, onResult: (w) => (ref.result ? ref.result(w) : Promise.resolve()) });
  const event = { eventId: "E1", at: T0 + 60 * MIN, start: T0 + 60 * MIN, end: T0 + 90 * MIN, title: "Dentist", calendarId: "C1" };
  const memory = loadMemory(kv);
  const tools = loadVoiceTools({ memory, actions: { contacts: () => [], callContact: async () => ({ ok: true, text: "started" }), lookupCall: async () => "ok" } });
  const config = loadWhatsappConfig(ENV, "+447700900123").config!;
  const app = express();
  const door = mountWhatsapp(app, {
    config, tools, memory, kv, control: createControl(kv, () => T0), ownerName: "Alex", timeZone: "Europe/London", contacts: () => [], fetch: meta,
    now: () => T0, callCheckMs: 5, receiptWaitMs: 60_000,
    calendarWrites: { canWrite: async () => true, find: async (title, start) => (start === event.start && /dentist/i.test(title) ? event : null), enqueue: writes.enqueue, get: writes.get },
  });
  ref.result = (w) => door.calendarResult(w);
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { authorization: `Bearer ${config.bridgeToken}` };
  const post = (body: unknown) => fetch(`${base}/assistant/reply`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
  let n = 0;
  const hook = async (msg: Body) => {
    const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp", metadata: { phone_number_id: config.phoneNumberId }, messages: [{ from: "447700900123", id: `wamid.k${++n}`, timestamp: String(T0 / 1000), ...msg }],
    } }] }] });
    const signature = `sha256=${createHmac("sha256", config.appSecret).update(raw).digest("hex")}`;
    await fetch(`${base}/whatsapp/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature }, body: raw });
  };
  const cards = () => sent.filter((b) => b.type === "interactive");
  const press = (b: Body, i = 0) => hook({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: String(b.interactive.action.buttons[i].reply.id), title: "x" } } });
  const texts = () => sent.map((b) => (b.type === "text" ? b.text.body : b.interactive.body.text) as string);
  try {
    await hook({ type: "text", text: { body: "move the dentist to 12:00" } });
    assert.equal((await (await fetch(`${base}/assistant/context`, { headers: auth })).json() as Body).calendarWrites, 1, "the bridge is told the Mac writes");
    await post({ text: "I'll ask you to confirm.", calendar: [{ op: "move", title: "Dentist", start: "2026-11-16 10:00", newStart: "2026-11-16 12:00" }], key: "wamid.k1" });
    const card = cards().at(-1)!;
    assert.match(card.interactive.body.text, /^📅 Move “Dentist” from Mon 16 Nov, 10:00 to Mon 16 Nov, 12:00 on your Mac's calendar\?\nAsked: in your own words\.$/);
    assert.deepEqual(await writes.exchange([]), [], "nothing queued before the yes");
    await press(card);
    await press(card);
    const queued = await writes.exchange([]);
    assert.equal(queued.length, 1, "pressed twice: one write");
    assert.deepEqual([queued[0]!.op, queued[0]!.eventId, queued[0]!.start, queued[0]!.end], ["move", "E1", T0 + 180 * MIN, T0 + 210 * MIN]);
    await writes.exchange([{ id: queued[0]!.id, ok: true, eventId: "E1", before: { start: T0 + 60 * MIN, end: T0 + 90 * MIN } }]);
    const receipt = cards().at(-1)!;
    assert.match(receipt.interactive.body.text, /📅 Moved “Dentist” to Mon 16 Nov, 12:00/);
    await press(receipt);
    assert.match(texts().at(-1)!, /asked your Mac to put “Dentist” back as it was/);
    const back = await writes.exchange([]);
    assert.deepEqual([back[0]!.op, back[0]!.start, back[0]!.end], ["move", T0 + 60 * MIN, T0 + 90 * MIN]);
    // Someone else's text in the turn: the card says so.
    await post({ text: "Done.", outside: ["email"], calendar: [{ op: "cancel", title: "Dentist", start: "2026-11-16 10:00" }], key: "wamid.k9" });
    assert.match(cards().at(-1)!.interactive.body.text, /Delete “Dentist”.*\nAsked while I was reading an email/s);
    await post({ text: "?", calendar: [{ op: "cancel", title: "Gym", start: "2026-11-16 18:00" }], key: "wamid.k10" });
    assert.match(texts().at(-1)!, /I don't see “Gym” at Mon 16 Nov, 18:00 on your Mac's calendars/);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
