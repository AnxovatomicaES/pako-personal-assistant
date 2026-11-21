// Chasing what others owe the owner (src/followups/chase.ts): an overdue promise of someone else's gets a gentle and a firm reminder,
// after a grace of half a working day (never on a weekend or in the quiet hours), at most once every two working days, in the language that
// person writes in, held to its facts, in the same place it was promised; sent only on the owner's press, or copied where Pako cannot send.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { createBriefV2 } from "../src/brief-v2.ts";
import { createControl } from "../src/control.ts";
import { createFollowups, FOLLOWUPS_KEY, followupsProxy, type Loop } from "../src/followups.ts";
import { chaseAt, chaseRequest, workingAt } from "../src/followups/chase.ts";
import type { ChaseTone } from "../src/followups/types.ts";
import type { Kv } from "../src/kv.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";
import { loadWhatsappConfig, mountWhatsapp, type Inbound } from "../src/whatsapp.ts";

const MIN = 60_000;
const TZ = "Europe/London"; // GMT in November: London time is UTC
const at = (s: string): number => Date.parse(`${s}Z`);
const TUE10 = at("2026-11-17T10:00");
const QUIET = { start: 22 * 60, end: 7 * 60 };
type Body = Record<string, any>;

const slackLoop = (extra: Record<string, unknown> = {}) => ({
  id: "c000000001", kind: "other_promise", title: "Ana sends the Q3 numbers", detail: "She said she would send them on Tuesday at 10:00.", who: "Ana",
  where: { type: "slack_dm", label: "Ana (private)", channel: "D0ANA0001" }, whenSaid: at("2026-11-16T09:00"), dueAt: TUE10,
  check: { none: { reason: "slack" } }, status: "open", nextCheckAt: 0, nudges: 0, createdAt: at("2026-11-16T09:00"),
  sources: [{ kind: "slack", label: "Slack · Ana", at: at("2026-11-16T09:00"), ref: "1763283600.000100" }], ...extra,
});
const mailLoop = (extra: Record<string, unknown> = {}) => ({
  ...slackLoop(), id: "c000000002", where: { type: "mail", label: "email" },
  sources: [{ kind: "mail", label: "email", at: at("2026-11-16T09:00"), ref: "<m1@client.example>" }], ...extra,
});
const ownLoop = { ...slackLoop(), id: "c000000003", kind: "owner_promise", title: "Send Omar the contract", who: "Omar" };

const asLoop = (v: Record<string, unknown>): Loop => v as unknown as Loop;

function rig(o: { loops?: Record<string, unknown>[]; quiet?: { start: number; end: number } | null; mail?: { name: string; address: string; text: string } } = {}) {
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  m.set(FOLLOWUPS_KEY, JSON.stringify({ loops: o.loops ?? [slackLoop()] }));
  const clock = { now: TUE10 };
  const cards: { body: string; buttons: { id: string; title: string }[] }[] = [];
  const asked: { tone: ChaseTone; title: string; facts: { label: string; text: string }[]; request: string; loop: string }[] = [];
  const engine = createFollowups({
    config: { delayMs: 10 * MIN, maxPerDay: 6, batchMs: 3 * MIN, quiet: o.quiet === undefined ? QUIET : o.quiet }, drafts: true,
    kv, timeZone: TZ, now: () => clock.now, enqueue: async () => true, notify: async () => undefined,
    card: async (body, buttons) => (cards.push({ body, buttons }), true),
    slackHistory: async () => [
      { ts: "1763283000.000100", at: at("2026-11-16T08:50"), mine: false, who: "Ana", text: "Hola! Te mando los números del Q3 el martes a las 10, sin falta. Gracias por la paciencia." },
      { ts: "1763283100.000100", at: at("2026-11-16T08:52"), mine: true, who: "Alex", text: "Perfect, thanks" },
    ],
    mailOf: async () => ({ address: o.mail?.address ?? "ana@client.example", name: o.mail?.name ?? "Ana Ruiz", subject: "Q3 numbers", text: o.mail?.text ?? "Hi Alex, I will send you the Q3 numbers on Tuesday at 10:00. Best, Ana" }),
    chaseDraft: async (x) => (asked.push({ tone: x.tone, title: x.title, facts: x.facts, request: x.request, loop: x.loop.id }), true),
  });
  const stored = (id = "c000000001"): Loop => JSON.parse(m.get(FOLLOWUPS_KEY)!).loops.find((l: Loop) => l.id === id);
  return { engine, clock, cards, asked, m, kv, stored };
}

test("timing: half a working day after its time, never on a weekend or in the quiet hours, then two working days apart; none when off", () => {
  const l = asLoop(slackLoop());
  assert.equal(chaseAt(l, TZ, QUIET), at("2026-11-17T14:30"), "Tuesday 10:00 + 4.5 working hours");
  // Due Friday 16:00: two hours that day, the weekend skipped, the rest on Monday morning.
  assert.equal(chaseAt(asLoop(slackLoop({ dueAt: at("2026-11-20T16:00") })), TZ, QUIET), at("2026-11-23T11:30"));
  // Quiet hours over the morning: no working time in them.
  assert.equal(chaseAt(l, TZ, { start: 9 * 60, end: 12 * 60 }), at("2026-11-17T16:30"));
  // Due in the evening: the grace starts the next working morning.
  assert.equal(chaseAt(asLoop(slackLoop({ dueAt: at("2026-11-17T20:00") })), TZ, QUIET), at("2026-11-18T13:30"));
  // Asked on Tuesday 14:30: the next one two working days later (Thursday 14:30), whatever its time says.
  assert.equal(chaseAt(asLoop(slackLoop({ chase: { askedAt: at("2026-11-17T14:30") } })), TZ, QUIET), at("2026-11-19T14:30"));
  assert.equal(chaseAt(asLoop(slackLoop({ chase: { chasedAt: at("2026-11-20T15:00") } })), TZ, QUIET), at("2026-11-24T15:00"), "over a weekend");
  assert.equal(chaseAt(asLoop(slackLoop({ chase: { off: true } })), TZ, QUIET), null, "Not needed");
  assert.equal(chaseAt(asLoop(slackLoop({ status: "parked" })), TZ, QUIET), null, "parked");
  assert.equal(chaseAt(asLoop(slackLoop({ status: "done" })), TZ, QUIET), null, "closed");
  assert.equal(chaseAt(asLoop(ownLoop), TZ, QUIET), null, "the owner's own promise is not chased");
  assert.equal(chaseAt(asLoop(slackLoop({ dueAt: undefined })), TZ, QUIET), null, "no time: nothing is overdue");
  assert.equal(chaseAt(l, TZ, { start: 8 * 60, end: 19 * 60 }), null, "no working time at all: never");
});

test("Slack: both tones asked after the grace, in that person's language; the card is Pako's English, to copy, with the app's link", async () => {
  const r = rig();
  r.clock.now = at("2026-11-17T14:00");
  await r.engine.chaseTick();
  assert.equal(r.asked.length, 0, "still in the grace");
  r.clock.now = at("2026-11-17T14:30");
  assert.equal(await r.engine.chaseTick(), 1);
  assert.deepEqual(r.asked.map((a) => a.tone), ["gentle", "firm"]);
  assert.deepEqual(r.asked.map((a) => a.title), ["Gentle chase: Ana sends the Q3 numbers", "Firm chase: Ana sends the Q3 numbers"]);
  const [gentle, firm] = r.asked;
  assert.match(gentle!.request, /Write it in Spanish, the language Ana writes in there\./);
  assert.match(gentle!.request, /\(a message in Ana \(private\)\)/, "the same conversation");
  assert.match(gentle!.request, /Warm and light/);
  assert.match(firm!.request, /Polite but firm/);
  assert.match(gentle!.facts[0]!.text, /^They promised the owner: Ana sends the Q3 numbers · person: Ana · where it was said: Ana \(private\) · when it is for: , at 10:00 · what was said:/);
  assert.equal(gentle!.facts[1]!.label, "Ana's own words in that conversation");
  assert.match(gentle!.facts[1]!.text, /^Hola! Te mando/);
  assert.doesNotMatch(gentle!.facts[1]!.text, /Perfect, thanks/, "the owner's own words are not theirs");
  assert.ok(r.stored().chase?.askedAt, "the chase is recorded");
  // The gentle one alone: no card yet. Both: one card.
  await r.engine.chaseWritten({ loop: "c000000001", tone: "gentle", text: "Un mensaje en Ana (private):\nHola Ana, ¿cómo vas con los números del Q3?" });
  assert.equal(r.cards.length, 0);
  await r.engine.chaseWritten({ loop: "c000000001", tone: "firm", text: "Un mensaje en Ana (private):\nHola Ana, los números del Q3 eran para el martes a las 10. ¿Me los mandas?" });
  assert.equal(r.cards.length, 1);
  const card = r.cards[0]!;
  assert.match(card.body, /^⏳ Ana said they would do this: Ana sends the Q3 numbers, at 10:00\. Its time has passed and I don't see it yet\.\nA reminder for them, to copy into Slack:/);
  assert.match(card.body, /🙂 Gentle:\nHola Ana, ¿cómo vas con los números del Q3\?\n\n✋ Firm:\nHola Ana, los números del Q3 eran para el martes a las 10\. ¿Me los mandas\?/);
  assert.match(card.body, /Open Slack: https:\/\/slack\.com\/app_redirect\?channel=D0ANA0001$/);
  assert.doesNotMatch(card.body, /Un mensaje en/, "the «where it goes» line is not part of the message");
  assert.deepEqual(card.buttons, [
    { id: "ch1:c000000001", title: "Copy gentle" }, { id: "ch2:c000000001", title: "Copy firm" }, { id: "ch3:c000000001", title: "Not needed" },
  ]);
  // A second draft back for the same chase gives no second card; nor does a later round in the next two working days.
  await r.engine.chaseWritten({ loop: "c000000001", tone: "firm", text: "x\ny" });
  r.clock.now = at("2026-11-19T14:15");
  await r.engine.chaseTick();
  assert.equal(r.cards.length, 1);
  assert.equal(r.asked.length, 2, "once per two working days");
  // Copy: the draft alone (to copy), then where to send it; recorded as chased, so the loop waits again.
  const press = await r.engine.chasePressed("1", "c000000001");
  assert.equal(press.copy, "Hola Ana, ¿cómo vas con los números del Q3?");
  assert.equal(press.say, "☝️ Copy it and send it in Slack: https://slack.com/app_redirect?channel=D0ANA0001");
  assert.equal(press.send, undefined, "Slack is read-only to Pako: nothing is sent");
  assert.equal(r.stored().chase?.chasedAt, at("2026-11-19T14:15"));
  assert.equal((await r.engine.chasePressed("2", "c000000001")).say, "You already sent or copied a reminder for this one.");
  r.clock.now = at("2026-11-23T14:00");
  await r.engine.chaseTick();
  assert.equal(r.asked.length, 2, "two working days after it was chased: Monday 14:15 at the earliest");
  r.clock.now = at("2026-11-23T14:15");
  await r.engine.chaseTick();
  assert.equal(r.asked.length, 4, "and then it is chased again");
});

test("no chase on a weekend, in the quiet hours or over the day's budget", async () => {
  const r = rig({ loops: [slackLoop({ dueAt: at("2026-11-20T16:00") })] });
  r.clock.now = at("2026-11-21T12:00");
  await r.engine.chaseTick();
  r.clock.now = at("2026-11-23T11:15");
  await r.engine.chaseTick();
  assert.equal(r.asked.length, 0);
  r.clock.now = at("2026-11-23T11:30");
  await r.engine.chaseTick();
  assert.equal(r.asked.length, 2);
  const q = rig({ quiet: { start: 9 * 60, end: 12 * 60 } });
  q.clock.now = at("2026-11-18T10:00"); // due long since, but in the quiet hours
  await q.engine.chaseTick();
  assert.equal(q.asked.length, 0);
  q.clock.now = at("2026-11-18T12:00");
  await q.engine.chaseTick();
  assert.equal(q.asked.length, 2);
  const b = rig();
  b.m.set(FOLLOWUPS_KEY, JSON.stringify({ loops: [slackLoop()], budget: { day: "2026-11-18", n: 6 } }));
  b.clock.now = at("2026-11-18T10:00");
  await b.engine.chaseTick();
  assert.equal(b.asked.length, 0, "the day's reminders are spent");
});

test("Not needed stops it for good; a parked loop is never chased", async () => {
  const r = rig({ loops: [slackLoop(), slackLoop({ id: "c000000009", status: "parked", parkedAt: TUE10 })] });
  r.clock.now = at("2026-11-17T14:30");
  await r.engine.chaseTick();
  assert.deepEqual([...new Set(r.asked.map((a) => a.loop))], ["c000000001"]);
  await r.engine.chaseWritten({ loop: "c000000001", tone: "gentle", text: "x\nHola Ana" });
  await r.engine.chaseWritten({ loop: "c000000001", tone: "firm", text: "x\nHola Ana, ¿y los números?" });
  assert.equal((await r.engine.chasePressed("3", "c000000001")).say, "OK, no more reminders to chase “Ana sends the Q3 numbers”. It stays on your open list.");
  assert.equal(r.stored().status, "open", "Not needed does not close it");
  assert.equal(r.stored().chase?.off, true);
  for (const day of ["2026-11-20", "2026-11-24", "2026-11-27"]) {
    r.clock.now = at(`${day}T15:00`);
    await r.engine.chaseTick();
  }
  assert.equal(r.asked.length, 2, "never again");
  assert.equal((await r.engine.chasePressed("1", "c000000001")).say, "That reminder is no longer there. Type CHASE and a few words to write a new one.");
});

test("email: a reply to their email, Re: its subject, in their language; only the press sends, once; a mail someone else sent is copied", async () => {
  const r = rig({ loops: [mailLoop()] });
  r.clock.now = at("2026-11-17T14:30");
  await r.engine.chaseTick();
  assert.match(r.asked[0]!.request, /Write it in English, the language Ana writes in there\./);
  assert.match(r.asked[0]!.request, /\(a reply to their email “Q3 numbers”\)/);
  await r.engine.chaseWritten({ loop: "c000000002", tone: "gentle", text: "A reply to Ana's email:\nHi Ana, any news on the Q3 numbers?" });
  await r.engine.chaseWritten({ loop: "c000000002", tone: "firm", text: "" }); // the firm one could not be written: the gentle one alone
  const card = r.cards[0]!;
  assert.match(card.body, /A reminder for them, as a reply to their email “Q3 numbers” \(it goes only when you press Send\):/);
  assert.doesNotMatch(card.body, /Firm:/);
  assert.deepEqual(card.buttons.map((b) => b.title), ["Send gentle", "Not needed"]);
  assert.equal(r.stored("c000000002").chase?.chasedAt, undefined, "nothing went before the press");
  const press = await r.engine.chasePressed("1", "c000000002");
  assert.deepEqual(press.send, {
    label: "Ana Ruiz", target: "ana@client.example", subject: "Re: Q3 numbers", text: "Hi Ana, any news on the Q3 numbers?", key: `chase-c000000002-${at("2026-11-17T14:30")}`,
  });
  assert.equal(r.stored("c000000002").chase?.chasedAt, at("2026-11-17T14:30"));
  assert.equal((await r.engine.chasePressed("1", "c000000002")).send, undefined, "one chase, one send");
  // The email was from someone else on the thread: a reply would chase the wrong person, so it is copied instead.
  const other = rig({ loops: [mailLoop()], mail: { name: "Bob Lee", address: "bob@client.example", text: "Ana will send the numbers on Tuesday." } });
  other.clock.now = at("2026-11-17T14:30");
  await other.engine.chaseTick();
  await other.engine.chaseWritten({ loop: "c000000002", tone: "gentle", text: "x\nHi Ana" });
  await other.engine.chaseWritten({ loop: "c000000002", tone: "firm", text: "x\nHi Ana, the numbers?" });
  assert.deepEqual(other.cards[0]!.buttons.map((b) => b.title), ["Copy gentle", "Copy firm", "Not needed"]);
  assert.equal((await other.engine.chasePressed("2", "c000000002")).copy, "Hi Ana, the numbers?");
});

test("grounding: a chase's draft says no date or amount its facts lack, goes back to its loop, and is not told in the chat", async () => {
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  const queued: Inbound[] = [];
  const told: string[] = [];
  const back: { loop: string; tone: string; text: string }[] = [];
  const v2 = createBriefV2({
    config: { waitMs: 15 * 60_000 }, kv, timeZone: TZ, now: () => at("2026-11-17T14:30"), sources: {}, enqueue: async (x) => (queued.push(x), true),
    plain: async () => undefined, notify: async () => undefined, tell: async (t) => void told.push(t), chaseWritten: async (o) => void back.push(o),
  });
  const request = chaseRequest("gentle", { who: "Ana", where: "a message in Ana (private)", language: "en", theirs: true });
  const task = await v2.draftFor({
    title: "Gentle chase: Ana sends the Q3 numbers", request, chase: { loop: "c000000001", tone: "gentle" },
    facts: [{ label: "Slack · Ana", text: "They promised the owner: Ana sends the Q3 numbers · person: Ana · when it is for: , on Tue 17/11 at 10:00" }],
  });
  assert.equal(task?.status, "pending");
  const material = (queued[0] as any).brief.text as string;
  assert.match(material, /Write a short reminder I send to Ana/);
  assert.match(material, /Use only what the facts say/, "the rules every draft holds to");
  await v2.result(/^br:([0-9a-f]{10})$/.exec(queued[0]!.id)![1]!,
    "A message in Ana (private):\nHi Ana, just checking on the Q3 numbers you were sending on Tuesday. Could you send them by 25/11? The invoice is €4,500.");
  assert.equal(back.length, 1);
  assert.equal(back[0]!.loop, "c000000001");
  assert.equal(back[0]!.tone, "gentle");
  assert.match(back[0]!.text, /Q3 numbers you were sending on Tuesday/);
  assert.doesNotMatch(back[0]!.text, /25\/11/, "no invented date");
  assert.doesNotMatch(back[0]!.text, /4,500/, "no invented amount");
  assert.deepEqual(told, [], "the card shows it, not a chat message");
});

const ENV = {
  WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
};

test("door: Send on an email chase goes through the held send to that person; Copy gives the draft; CHASE asks for one; nothing without a press", async () => {
  const drafted = { askedAt: at("2026-11-17T14:30"), offeredAt: at("2026-11-17T14:31"), gentle: "Hi Ana, any news on the Q3 numbers?", firm: "Hi Ana, the Q3 numbers were due Tuesday at 10:00. Could you send them?" };
  const r = rig({ loops: [
    mailLoop({ chase: { ...drafted, to: "ana@client.example", toName: "Ana Ruiz", subject: "Q3 numbers" } }), slackLoop({ chase: drafted }), ownLoop,
  ] });
  r.clock.now = at("2026-11-17T15:00");
  const sent: Body[] = [];
  const meta = (async (_u: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Body);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out${sent.length}` }] }), { status: 200 });
  }) as typeof fetch;
  const mails: { to: string; subject: string; text: string }[] = [];
  const memory = loadMemory(r.kv);
  const tools = loadVoiceTools({ memory, actions: { contacts: () => [], callContact: async () => ({ ok: true, text: "started" }), lookupCall: async () => "ok" } });
  const config = loadWhatsappConfig(ENV, "+447700900123").config!;
  const app = express();
  mountWhatsapp(app, {
    config, tools, memory, kv: r.kv, control: createControl(r.kv, () => r.clock.now), ownerName: "Alex", timeZone: TZ, contacts: () => [], fetch: meta,
    now: () => r.clock.now, callCheckMs: 5, receiptWaitMs: 60_000, followups: followupsProxy(() => r.engine), sendEmail: async (x) => void mails.push(x),
    autonomy: { config: { mode: "direct", seconds: 10 }, delay: () => 0 },
  });
  const server: Server = createServer(app);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let n = 0;
  const hook = async (msg: Body) => {
    const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp", metadata: { phone_number_id: config.phoneNumberId }, messages: [{ from: "447700900123", id: `wamid.c${++n}`, timestamp: "1", ...msg }],
    } }] }] });
    const signature = `sha256=${createHmac("sha256", config.appSecret).update(raw).digest("hex")}`;
    await fetch(`${base}/whatsapp/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature }, body: raw });
  };
  const press = (id: string) => hook({ type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: "x" } } });
  const texts = () => sent.filter((b) => b.type === "text").map((b) => String(b.text.body));
  try {
    await hook({ type: "text", text: { body: "hi" } }); // WhatsApp's 24 hours are open
    assert.equal(mails.length, 0);
    await press("ch2:c000000001");
    assert.ok(texts().includes(drafted.firm), "the draft alone, to copy");
    assert.ok(texts().includes("☝️ Copy it and send it in Slack: https://slack.com/app_redirect?channel=D0ANA0001"));
    assert.equal(mails.length, 0, "a Slack chase is never sent by Pako");
    await press("ch1:c000000002");
    for (let i = 0; i < 100 && !mails.length; i++) await new Promise((ok) => setTimeout(ok, 10));
    assert.equal(mails.length, 1);
    assert.equal(mails[0]!.to, "ana@client.example");
    assert.equal(mails[0]!.subject, "Re: Q3 numbers");
    assert.match(mails[0]!.text, /Hi Ana, any news on the Q3 numbers\?$/);
    await press("ch2:c000000002");
    await new Promise((ok) => setTimeout(ok, 50));
    assert.equal(mails.length, 1, "one chase sends once");
    assert.equal(texts().at(-1), "You already sent or copied a reminder for this one.");
    // CHASE and a few words: someone else's promise is drafted now; the owner's own is not theirs to chase.
    await hook({ type: "text", text: { body: "chase q3 numbers" } });
    assert.match(texts().at(-1)!, /^Several things match those words\. Which one\?/);
    await hook({ type: "text", text: { body: "chase omar" } });
    assert.equal(texts().at(-1), "“Send Omar the contract” is yours to do, not theirs: type DRAFT for a message about it.");
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("CHASE writes one now for the one waiting-on loop its words name, whatever the clock says", async () => {
  const r = rig({ loops: [slackLoop({ dueAt: at("2026-11-17T18:00"), chase: { off: true } }), ownLoop] });
  r.clock.now = at("2026-11-17T09:00"); // before its time, and once said Not needed
  const said = await r.engine.chaseNow("ana numbers");
  assert.deepEqual(said, { ok: true, say: "✍️ Writing a gentle and a firm reminder for Ana about “Ana sends the Q3 numbers”. I'll show them here when they're ready." });
  assert.deepEqual(r.asked.map((a) => a.tone), ["gentle", "firm"]);
  assert.equal(r.stored().chase?.off, undefined, "asking again takes Not needed back");
  assert.deepEqual(await r.engine.chaseNow("dentist"), { ok: false, say: "I don't see something someone owes you with “dentist”." });
});

test("chase timing follows the owner's working day (WORK_HOURS, WORK_DAYS), not a fixed Monday to Friday", () => {
  const tz = "Asia/Jerusalem";
  const sunThu = { start: 8 * 60, end: 17 * 60, days: [0, 1, 2, 3, 4] };
  const at = (iso: string) => Date.parse(iso);
  // 2026-11-20 is a Friday, 2026-11-22 a Sunday (UTC+2 in Jerusalem).
  assert.equal(workingAt(at("2026-11-20T08:00:00Z"), tz, null), true, "the default week works Fridays");
  assert.equal(workingAt(at("2026-11-20T08:00:00Z"), tz, null, sunThu), false, "a Sunday-to-Thursday week does not");
  assert.equal(workingAt(at("2026-11-22T08:00:00Z"), tz, null, sunThu), true, "and works Sundays");
  assert.equal(workingAt(at("2026-11-22T05:30:00Z"), tz, null, sunThu), false, "07:30 is before its 08:00 start");
  assert.equal(workingAt(at("2026-11-22T06:30:00Z"), tz, null, sunThu), true, "08:30 is inside it");
  assert.equal(workingAt(at("2026-11-22T15:30:00Z"), tz, null, sunThu), false, "17:30 is after its 17:00 end");
});
