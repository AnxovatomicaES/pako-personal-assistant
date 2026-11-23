// Gentle mode's check-ins and weekly reset (src/gentle-checkins.ts, src/gentle-reset.ts): opt-in check-ins with their rules (quiet hours, a meeting, a restart,
// no storm after a sleep, three "Not yet" at most, the shared cap), the weekly reset (what it picks, its buttons, Park the rest, the month-old
// parked ones let go), and the brief that leads with the week's focus. Nothing here reaches the network.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { parseReply } from "../assistant/bridge.ts";
import { applyToolCalls, checkArgs } from "../assistant/tools.ts";
import { SYSTEM_PROMPT } from "../assistant/prompt.ts";
import { chatText, gatherFacts, type BriefDoc } from "../src/brief-v2.ts";
import { createBrief } from "../src/brief.ts";
import type { CalEvent } from "../src/calendar.ts";
import { createControl } from "../src/control.ts";
import { createFollowups, FOLLOWUPS_KEY, followupsProxy, type Loop } from "../src/followups.ts";
import { choicesOf, GENTLE_DEFAULTS, loadGentleConfig, shameIn, type GentleConfig } from "../src/gentle.ts";
import {
  busyUntil, CHECKIN_WORDS, checkinItemsOf, checkinTime, createCheckIns, quietEnd, thingOf, type CheckInsDeps,
} from "../src/gentle-checkins.ts";
import { createWeeklyReset, pickSlipping, resetMoment, RESET_WORDS, type WeeklyResetDeps } from "../src/gentle-reset.ts";
import { createJobs } from "../src/jobs.ts";
import type { Kv } from "../src/kv.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";
import { loadWhatsappConfig, mountWhatsapp } from "../src/whatsapp.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TZ = "Europe/London";
/** Monday 2026-11-23 09:00 in London (GMT). */
const MON9 = Date.parse("2026-11-23T09:00:00Z");
const at = (iso: string): number => Date.parse(iso);
type Body = Record<string, any>;

function memKv() {
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  return { kv, m };
}

const ON: GentleConfig = { ...GENTLE_DEFAULTS, on: true };
const QUIET = { start: 23 * 60, end: 8 * 60 };

/** Check-ins on a store, their cards kept; `jobs` when a test wants the durable slots. */
function ciRig(o: Partial<CheckInsDeps> & { clock?: { now: number }; store?: ReturnType<typeof memKv>; gentle?: GentleConfig } = {}) {
  const clock = o.clock ?? { now: MON9 };
  const store = o.store ?? memKv();
  const cards: { body: string; buttons: { id: string; title: string }[] }[] = [];
  const ci = createCheckIns({
    kv: store.kv, timeZone: TZ, now: () => clock.now, settings: async () => o.gentle ?? ON, standardMax: 6, quiet: QUIET,
    card: async (body, buttons) => (cards.push({ body, buttons }), true),
    ...o,
  });
  return { clock, store, cards, ci };
}

// ---------- check-ins ----------

test("check-in: “at” and “in” read in the owner's zone; a time passed or more than a week ahead is refused; at most two per answer", () => {
  assert.equal(checkinTime({ at: "2026-11-23 15:00" }, MON9, TZ), at("2026-11-23T15:00:00Z"));
  assert.equal(checkinTime({ at: "2026-07-01 15:00" }, MON9, TZ), at("2026-07-01T14:00:00Z"), "summer time");
  assert.equal(checkinTime({ inMin: 20 }, MON9, TZ), MON9 + 20 * MIN);
  assert.equal(checkinTime({ at: "3pm" }, MON9, TZ), null);
  assert.equal(thingOf("start the Bluefin proposal"), "the Bluefin proposal");
  assert.equal(thingOf("getting going on the deck"), "the deck");
  assert.equal(thingOf("Startup pitch"), "Startup pitch");
  assert.deepEqual(checkinItemsOf([{ text: "the deck", in: 20 }, { text: "", at: "2026-11-23 15:00" }, { text: "x", in: 5 }]),
    [{ thing: "the deck", inMin: 20 }, { thing: "", at: "2026-11-23 15:00" }]);
  assert.deepEqual(checkinItemsOf([{ text: "x", at: "tomorrow" }, { text: "y", in: 0 }]), []);
});

test("check-in: set from the chat, asked at its time “Started on …?” with Yes, Not yet and Park; Yes closes it", async () => {
  const r = ciRig();
  assert.equal((await r.ci.fromChat({ at: "2026-11-23 08:00", thing: "the deck" })).ok, false, "passed");
  assert.match((await r.ci.fromChat({ at: "2026-12-10 10:00", thing: "x" })).say, /next 7 days/);
  const set = await r.ci.fromChat({ at: "2026-11-23 10:30", thing: "the deck" });
  assert.equal(set.ok, true);
  assert.match(set.say, /check on you at 10:30 \(“the deck”\)/);
  assert.deepEqual(await r.ci.sweep(), []);
  r.clock.now = at("2026-11-23T10:30:10Z");
  const asked = await r.ci.sweep();
  assert.equal(asked.length, 1);
  assert.equal(r.cards[0]!.body, "🌱 Started on “the deck”?");
  assert.deepEqual(r.cards[0]!.buttons.map((b) => b.title), ["Yes", "Not yet", "Park"]);
  assert.match(r.cards[0]!.buttons[0]!.id, /^ci1:[0-9a-f]{10}$/);
  await r.ci.sweep();
  assert.equal(r.cards.length, 1, "asked once");
  assert.equal(await r.ci.pressed("1", asked[0]!), "Good. I'll leave you to it.");
  assert.equal(await r.ci.pressed("2", asked[0]!), "Already answered.");
  assert.equal(await r.ci.pressed("1", "0000000000"), "That check-in is no longer waiting.");
  // Nothing named: a plain "started?".
  await r.ci.fromChat({ inMin: 20, thing: "" });
  r.clock.now += 21 * MIN;
  await r.ci.sweep();
  assert.equal(r.cards.at(-1)!.body, "🌱 Checking in, as you asked: started?");
});

test("check-in: Not yet looks in 15 minutes later, three times at most; the next Not yet stops it and the brief carries it", async () => {
  const r = ciRig();
  const { id } = await r.ci.add({ when: MON9 + 30 * MIN, thing: "the deck" });
  r.clock.now = MON9 + 30 * MIN;
  await r.ci.sweep();
  for (let i = 1; i <= 3; i++) {
    const said = await r.ci.pressed("2", id!);
    assert.match(said, /^OK\. I'll look in at \d\d:\d\d\.$/, said);
    r.clock.now += 14 * MIN;
    await r.ci.sweep();
    assert.equal(r.cards.length, i, "not before its 15 minutes");
    r.clock.now += MIN + 5000;
    await r.ci.sweep();
    assert.equal(r.cards.length, i + 1);
  }
  assert.notEqual(r.cards[1]!.body, r.cards[2]!.body, "the wording changes");
  assert.match(await r.ci.pressed("2", id!), /no more check-ins for “the deck”\. It'll be in your brief/);
  r.clock.now += HOUR;
  await r.ci.sweep();
  assert.equal(r.cards.length, 4, "stopped");
  assert.match((await r.ci.briefLine())!, /Check-ins kept for here: “the deck”/);
});

test("check-in: quiet hours — moved to their end when within two hours, else kept for the brief", async () => {
  const r = ciRig();
  r.clock.now = at("2026-11-23T06:00:00Z");
  await r.ci.add({ when: at("2026-11-23T07:00:00Z"), thing: "stretch" });
  await r.ci.add({ when: at("2026-11-23T05:30:00Z") + DAY, thing: "the early train" });
  r.clock.now = at("2026-11-23T07:00:00Z");
  await r.ci.sweep();
  assert.equal(r.cards.length, 0, "07:00 is in the quiet hours");
  assert.equal((await r.ci.list())[0]!.at, at("2026-11-23T08:00:00Z"));
  r.clock.now = at("2026-11-23T08:00:05Z");
  await r.ci.sweep();
  assert.equal(r.cards.length, 1);
  assert.match(r.cards[0]!.body, /stretch/);
  r.clock.now = at("2026-11-24T05:30:00Z");
  await r.ci.sweep();
  assert.equal(r.cards.length, 1, "05:30: the quiet hours end 2.5 hours later");
  assert.equal((await r.ci.list()).find((c) => c.thing === "the early train")!.state, "brief");
  assert.equal(quietEnd(QUIET, at("2026-11-23T23:30:00Z"), TZ), at("2026-11-24T08:00:00Z"));
});

test("check-in: never during a meeting — moved to just after it (back-to-back too); a long one sends it to the brief", async () => {
  const ev = (start: string, end: string, o: Partial<CalEvent> = {}): CalEvent =>
    ({ id: start, title: "Board", start: at(start), end: at(end), allDay: false, calendar: "Work", ...o });
  const events = [ev("2026-11-23T10:00:00Z", "2026-11-23T11:00:00Z"), ev("2026-11-23T11:00:00Z", "2026-11-23T11:30:00Z"),
    ev("2026-11-23T10:15:00Z", "2026-11-23T17:00:00Z", { allDay: true }), ev("2026-11-23T10:00:00Z", "2026-11-23T16:00:00Z", { response: "declined" })];
  assert.equal(busyUntil(events, at("2026-11-23T10:30:00Z")), at("2026-11-23T11:30:00Z"));
  assert.equal(busyUntil(events, at("2026-11-23T12:00:00Z")), null);
  const r = ciRig({ events: async () => events });
  await r.ci.add({ when: at("2026-11-23T10:30:00Z"), thing: "the deck" });
  r.clock.now = at("2026-11-23T10:30:00Z");
  await r.ci.sweep();
  assert.equal(r.cards.length, 0);
  r.clock.now = at("2026-11-23T11:31:00Z");
  await r.ci.sweep();
  assert.equal(r.cards.length, 1, "just after the meeting");
  const long = ciRig({ events: async () => [ev("2026-11-23T10:00:00Z", "2026-11-23T14:00:00Z")] });
  await long.ci.add({ when: at("2026-11-23T10:30:00Z"), thing: "the deck" });
  long.clock.now = at("2026-11-23T10:30:00Z");
  await long.ci.sweep();
  assert.equal((await long.ci.list())[0]!.state, "brief");
});

test("check-in: survives a restart through the durable jobs, and is never asked twice by two processes on one store", async () => {
  const store = memKv();
  const clock = { now: MON9 };
  const jobsA = createJobs({ kv: store.kv, sleeps: true, now: () => clock.now, owner: "a" });
  const a = ciRig({ store, clock, jobs: jobsA });
  await a.ci.add({ when: MON9 + HOUR, thing: "the deck" });
  // "Restart": a new process, its own jobs and check-ins, the same store.
  clock.now = MON9 + HOUR + 10_000;
  const jobsB = createJobs({ kv: store.kv, sleeps: true, now: () => clock.now, owner: "b" });
  const b = ciRig({ store, clock, jobs: jobsB });
  assert.equal((await b.ci.sweep()).length, 1);
  assert.equal(b.cards.length, 1);
  // The old process, still around, finds it asked.
  await a.ci.sweep();
  assert.equal(a.cards.length, 0);
  const row = (await jobsB.rows()).find((x) => x.slot.startsWith("checkin:"))!;
  assert.equal(row.state, "done");
  // A crash after the send but before the check-in was marked: the slot is done, the retry does not send again.
  const store2 = memKv();
  const jobsC = createJobs({ kv: store2.kv, sleeps: false, now: () => clock.now, owner: "c" });
  let fail = true;
  const c = ciRig({ store: store2, clock, jobs: jobsC });
  const { id } = await c.ci.add({ when: clock.now + MIN, thing: "x" });
  clock.now += MIN;
  await jobsC.slot("checkin", `checkin:${id}@${clock.now}`, clock.now, async (x) => void (await x.once("send", async () => (fail = false, true))));
  assert.equal(fail, false);
  await c.ci.sweep();
  assert.equal(c.cards.length, 0, "the slot was done: no second send");
});

test("check-in: no storm after a sleep — over two hours old goes to the brief, and of several late ones only the newest is asked", async () => {
  const r = ciRig();
  for (const [h, thing] of [[9.5, "one"], [10, "two"], [11.5, "three"], [11.75, "four"]] as const) await r.ci.add({ when: MON9 + (h - 9) * HOUR, thing });
  r.clock.now = at("2026-11-23T12:00:00Z"); // woke at noon
  await r.ci.sweep();
  assert.equal(r.cards.length, 1);
  assert.match(r.cards[0]!.body, /four/);
  const states = Object.fromEntries((await r.ci.list()).map((c) => [c.thing, c.state]));
  assert.deepEqual(states, { one: "brief", two: "brief", three: "brief", four: "asked" });
  assert.match((await r.ci.briefLine())!, /“one” \(09:30\), “two” \(10:00\), “three” \(11:30\)/);
});

test("check-in: the day's cap is shared with the nudges (gentle 4, standard 6); only a first ask counts", async () => {
  let others = 3;
  const r = ciRig({ others: async () => others });
  // Offered on a nudge (a follow-up behind each): the ones the owner asked for in the chat are not held back by the cap (below).
  const first = await r.ci.add({ when: MON9 + MIN, thing: "a", loop: "a1b2c3d4e5" });
  await r.ci.add({ when: MON9 + 2 * MIN, thing: "b", loop: "b1b2c3d4e5" });
  r.clock.now = MON9 + MIN;
  await r.ci.sweep();
  assert.equal(r.cards.length, 1, "3 + 0 < 4");
  assert.equal(await r.ci.spentToday(), 1);
  r.clock.now = MON9 + 2 * MIN;
  await r.ci.sweep();
  assert.equal(r.cards.length, 1, "3 + 1 = 4: the cap");
  assert.equal((await r.ci.list()).find((c) => c.thing === "b")!.state, "brief");
  // "Not yet" on the first: its next look is not a new nudge.
  await r.ci.pressed("2", first.id!);
  r.clock.now += 16 * MIN;
  await r.ci.sweep();
  assert.equal(r.cards.length, 2);
  // Standard mode: the standard cap.
  others = 4;
  const s = ciRig({ gentle: { ...ON, on: false }, others: async () => others });
  await s.ci.add({ when: MON9 + MIN, thing: "c", loop: "c1b2c3d4e5" });
  s.clock.now = MON9 + MIN;
  await s.ci.sweep();
  assert.equal(s.cards.length, 1, "4 < 6");
});

test("check-in: one the owner asked for in the chat at a time (no follow-up behind it) is asked even when the day's cap is spent, and still counts", async () => {
  const r = ciRig({ others: async () => 6 });
  await r.ci.add({ when: MON9 + MIN, thing: "start the deck" });
  await r.ci.add({ when: MON9 + 2 * MIN, thing: "the nudged one", loop: "a1b2c3d4e5" });
  r.clock.now = MON9 + MIN;
  assert.equal((await r.ci.sweep()).length, 1, "6 of 6 spent by the others, and still asked: the owner asked for it");
  assert.match(r.cards[0]!.body, /the deck/);
  assert.equal(await r.ci.spentToday(), 1, "it still counts, so the others leave room for it");
  r.clock.now = MON9 + 2 * MIN;
  await r.ci.sweep();
  assert.equal(r.cards.length, 1, "the one offered on a nudge is held by the cap");
  assert.equal((await r.ci.list()).find((c) => c.thing === "the nudged one")!.state, "brief");
});

test("check-in: one asked and never answered goes to the brief after two hours and holds no place meanwhile (ten of them do not block new ones for days)", async () => {
  const r = ciRig();
  for (let i = 0; i < 10; i++) {
    await r.ci.add({ when: MON9 + (i + 1) * MIN, thing: `thing ${i}` });
    r.clock.now = MON9 + (i + 1) * MIN;
    await r.ci.sweep();
  }
  assert.equal(r.cards.length, 10);
  assert.ok((await r.ci.list()).every((c) => c.state === "asked"));
  const room = await r.ci.add({ when: r.clock.now + 30 * MIN, thing: "the deck" });
  assert.equal(room.ok, true, "asked ones are not waiting ones: only waiting ones count towards the ten");
  // Two hours (and a minute) after the last ask, with nothing waiting that is due, the unanswered ones are the brief's.
  r.clock.now += 2 * HOUR + 11 * MIN;
  await r.ci.sweep();
  const states = (await r.ci.list()).map((c) => c.state);
  assert.equal(states.filter((s) => s === "brief").length, 10, `all ten kept for the brief: ${states.join(",")}`);
  assert.match((await r.ci.briefLine())!, /“thing 9”/);
  // Still waiting ones are what count: ten of those are full.
  const full = ciRig();
  for (let i = 0; i < 10; i++) assert.equal((await full.ci.add({ when: MON9 + DAY + i * MIN, thing: `w${i}` })).ok, true);
  assert.match((await full.ci.add({ when: MON9 + DAY + 20 * MIN, thing: "one more" })).say, /10 check-ins waiting/);
});

test("check-in: gentle mode's cap never raises the standard one (gentle 10, standard 2): the lower of the two counts", async () => {
  const r = ciRig({ standardMax: 2, gentle: { ...ON, maxPerDay: 10 } });
  for (const [i, thing] of ["a", "b", "c"].entries()) await r.ci.add({ when: MON9 + (i + 1) * MIN, thing, loop: `${thing}1b2c3d4e5` });
  for (const i of [1, 2, 3]) {
    r.clock.now = MON9 + i * MIN;
    await r.ci.sweep();
  }
  assert.equal(r.cards.length, 2, "two asked: the standard cap, not gentle's 10");
  assert.equal((await r.ci.list()).find((c) => c.thing === "c")!.state, "brief");
});

/** A follow-ups engine with gentle mode on, its cards (and the fourth button) kept. */
function fuRig(clock = { now: MON9 }, caps: { standard?: number; gentle?: number } = {}) {
  const store = memKv();
  const cards: { body: string; buttons: { id: string; title: string }[]; more?: { buttons: { id: string; title: string }[]; line: string } }[] = [];
  const ref: { ci: ReturnType<typeof createCheckIns> | null } = { ci: null };
  const engine = createFollowups({
    config: { delayMs: 10 * MIN, maxPerDay: caps.standard ?? 6, batchMs: 3 * MIN, quiet: QUIET },
    kv: store.kv, timeZone: TZ, now: () => clock.now, enqueue: async () => true,
    card: async (body, buttons, _f, more) => (cards.push({ body, buttons, ...(more ? { more } : {}) }), true), notify: async () => undefined,
    gentle: async () => ({ maxPerDay: caps.gentle ?? 4, checkin: async (id) => ({ buttons: [await ref.ci!.loopButton(id)], line: "Starting now?" }) }),
  });
  ref.ci = createCheckIns({
    kv: store.kv, timeZone: TZ, now: () => clock.now, settings: async () => ON, standardMax: 6, quiet: QUIET,
    card: async (body, buttons) => (cards.push({ body, buttons }), true),
    loop: async (id) => (await engine.open()).find((l) => l.id === id) ?? null,
    parkLoop: (id) => engine.press("7", id),
  });
  return { clock, store, cards, engine, ci: ref.ci };
}

async function seedLoop(r: ReturnType<typeof fuRig>, title: string, o: Partial<Loop> = {}): Promise<Loop> {
  const l = (await r.engine.fromChat({ title, who: o.who ?? "Ana" }))!;
  const s = await r.engine.read();
  const x = s.loops.find((y) => y.id === l.id)!;
  Object.assign(x, { nextCheckAt: r.clock.now, ...o });
  await r.store.kv.set(FOLLOWUPS_KEY, JSON.stringify(s), 3600);
  return x;
}

test("check-in on a stuck item: its gentle nudge offers “Check on me in 30 min”; pressed, it asks 30 minutes later; Park parks the item", async () => {
  const r = fuRig();
  const fresh = await seedLoop(r, "Book the venue", { who: "Omar" });
  const stuck = await seedLoop(r, "Send Ana the Q4 deck", { whenSaid: MON9 - 3 * DAY });
  await r.engine.tick();
  const card = (title: RegExp) => r.cards.find((c) => title.test(c.body))!;
  assert.equal(card(/venue/).more, undefined, "a fresh one: no check-in offered");
  assert.deepEqual(card(/Q4 deck/).more!.buttons, [{ id: `ck:${stuck.id}`, title: "Check on me in 30 min" }]);
  assert.match(await r.ci.forLoop(stuck.id), /check on you at 09:30 \(“Send Ana the Q4 deck”\)/);
  assert.match(await r.ci.forLoop("0000000000"), /nothing to check on/);
  assert.equal((await r.ci.loopButton(fresh.id, true)).title, "Check in 30 min");
  r.clock.now += 30 * MIN;
  await r.ci.sweep();
  const ask = r.cards.at(-1)!;
  assert.equal(ask.body, "🌱 Started on “Send Ana the Q4 deck”?");
  const id = /^ci3:(.+)$/.exec(ask.buttons[2]!.id)![1]!;
  assert.match(await r.ci.pressed("3", id), /Parked: “Send Ana the Q4 deck”/);
  assert.equal((await r.engine.read()).loops.find((l) => l.id === stuck.id)!.status, "parked");
});

test("follow-ups: gentle mode's cap never raises the standard one for nudges either (gentle 10, standard 2)", async () => {
  const r = fuRig(undefined, { standard: 2, gentle: 10 });
  for (const title of ["Book the venue", "Send Ana the Q4 deck", "Pay the printer"]) await seedLoop(r, title);
  await r.engine.tick();
  assert.equal(r.cards.length, 2, "two nudged: the standard cap, not gentle's 10");
});

test("check-in words: no shame word in any of them", () => {
  const all = [...Object.values(CHECKIN_WORDS), ...Object.values(RESET_WORDS)];
  for (const s of all) assert.deepEqual(shameIn(s), [], s);
});

// ---------- the chat's ask: tag and tool ----------

test("bridge: <checkin> at a time or in minutes, and the check_in tool, give the same reply fields; the tag never shows", () => {
  const r = parseReply('Sure, I\'ll check at 3.<checkin at="2026-11-23 15:00">the deck</checkin><checkin in="20"/>');
  assert.equal(r.text, "Sure, I'll check at 3.");
  assert.deepEqual(r.checkins, [{ text: "the deck", at: "2026-11-23 15:00" }, { text: "", in: 20 }]);
  assert.equal(parseReply('<checkin at="3pm">x</checkin>OK').checkins, undefined);
  const t = applyToolCalls(parseReply("OK."), [
    { name: "check_in", input: { at: "2026-11-23 15:00", thing: "the deck" } }, { name: "check_in", input: { in_minutes: 20 } },
  ]);
  assert.deepEqual(t.checkins, r.checkins);
  assert.equal(checkArgs("check_in", { at: "3pm" }).ok, false, "a bad time is refused with a reason");
  assert.match(SYSTEM_PROMPT, /<checkin at="2026-11-20 15:00">/);
});

const ENV = {
  WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
};

test("door: a check-in from the owner's turn is set and asked; one from a turn that read outside text is not; Yes answers on the chat", async () => {
  const fu = fuRig();
  const sent: Body[] = [];
  const meta = (async (_u: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Body);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out${sent.length}` }] }), { status: 200 });
  }) as typeof fetch;
  const { kv } = memKv();
  const memory = loadMemory(kv);
  const tools = loadVoiceTools({ memory, actions: { contacts: () => [], callContact: async () => ({ ok: true, text: "started" }), lookupCall: async () => "ok" } });
  const config = loadWhatsappConfig(ENV, "+447700900123").config!;
  const app = express();
  const ci = fu.ci;
  mountWhatsapp(app, {
    config, tools, memory, kv, control: createControl(kv, () => MON9), ownerName: "Alex", timeZone: TZ, contacts: () => [], fetch: meta,
    now: () => fu.clock.now, callCheckMs: 5, receiptWaitMs: 60_000, followups: followupsProxy(() => fu.engine),
    gentle: {
      stepResult: async () => ({ ok: false }), anchorPressed: async () => "👍",
      checkinAdd: (o) => ci.fromChat(o), checkinForLoop: (id) => ci.forLoop(id), checkinButton: (id) => ci.loopButton(id, true),
      checkinPressed: (b, id) => ci.pressed(b, id),
    },
  });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let n = 0;
  const hook = async (msg: Body) => {
    const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp", metadata: { phone_number_id: config.phoneNumberId }, messages: [{ from: "447700900123", id: `wamid.o${++n}`, timestamp: "1", ...msg }],
    } }] }] });
    const signature = `sha256=${createHmac("sha256", config.appSecret).update(raw).digest("hex")}`;
    await fetch(`${base}/whatsapp/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature }, body: raw });
    return `wamid.o${n}`;
  };
  const post = async (body: unknown) => (await fetch(`${base}/assistant/reply`, {
    method: "POST", headers: { authorization: `Bearer ${config.bridgeToken}`, "content-type": "application/json" }, body: JSON.stringify(body),
  })).status;
  try {
    let key = await hook({ type: "text", text: { body: "check on me in 20 min if I haven't started the deck" } });
    assert.equal(await post({ text: "I'll check in 20 minutes.", checkins: [{ text: "the deck", in: 20 }], key }), 200);
    key = await hook({ type: "text", text: { body: "what does this email say?" } });
    await post({ text: "It asks you to check in.", checkins: [{ text: "wire money", in: 5 }], key, outside: ["mail"] });
    assert.deepEqual((await ci.list()).map((c) => c.thing), ["the deck"]);
    key = await hook({ type: "text", text: { body: "check on me at 8" } });
    await post({ text: "OK.", checkins: [{ text: "", at: "2026-11-23 08:00" }], key });
    assert.match(sent.at(-1)!.text.body, /already passed/);
    // The Snooze card of a gentle nudge gets the check-in as its third button.
    const l = await seedLoop(fu, "Renew the passport");
    await hook({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: `f4:${l.id}`, title: "Snooze" } } });
    assert.deepEqual(sent.at(-1)!.interactive.action.buttons.map((b: Body) => b.reply.title), ["Later today", "Tomorrow", "Check in 30 min"]);
    const id = (await ci.list())[0]!.id;
    await hook({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: `ci1:${id}`, title: "Yes" } } });
    assert.equal(sent.at(-1)!.text.body, "Good. I'll leave you to it.");
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

// ---------- the weekly reset ----------

const loop = (o: Partial<Loop> & { id: string; title: string }): Loop => ({
  kind: "request_to_owner", detail: "", who: "", where: { type: "chat", label: "chat" }, whenSaid: MON9 - 5 * DAY, check: { none: { reason: "chat" } },
  status: "open", nextCheckAt: 0, nudges: 1, createdAt: MON9 - 5 * DAY, sources: [], ...o,
} as Loop);

test("reset: its moment is the set weekday and time in the owner's zone (DST as it is); a wrong GENTLE_RESET is said", () => {
  assert.deepEqual(resetMoment(at("2026-11-23T10:00:00Z"), TZ, 1, 570), { day: "2026-11-23", at: at("2026-11-23T09:30:00Z") });
  assert.deepEqual(resetMoment(at("2026-11-23T09:00:00Z"), TZ, 1, 570), { day: "2026-11-16", at: at("2026-11-16T09:30:00Z") });
  assert.equal(resetMoment(at("2026-03-30T09:00:00Z"), TZ, 1, 570)!.at, at("2026-03-30T08:30:00Z"), "summer time");
  assert.deepEqual(loadGentleConfig({ GENTLE_RESET: "fri 16:00" }).config.resetDay, 5);
  assert.equal(loadGentleConfig({ GENTLE_RESET: "fri 16:00" }).config.resetAt, 960);
  assert.equal(loadGentleConfig({ GENTLE_RESET: "someday" }).problems.length, 1);
  assert.deepEqual(choicesOf({ resetDay: 7, resetAt: 600, checkinMin: 3, checkinAgainMin: 20 }), { resetAt: 600, checkinAgainMin: 20 });
});

test("reset: picks up to three slipping items, the owner's promises to people first, then the oldest; never fresh, never someone else's", () => {
  const loops = [
    loop({ id: "a000000001", title: "Old request", whenSaid: MON9 - 9 * DAY }),
    loop({ id: "a000000002", title: "Promise to Ana", kind: "owner_promise", who: "Ana", whenSaid: MON9 - 3 * DAY }),
    loop({ id: "a000000003", title: "Fresh one", whenSaid: MON9 - HOUR }),
    loop({ id: "a000000004", title: "Their promise", kind: "other_promise", who: "Omar", whenSaid: MON9 - 20 * DAY }),
    loop({ id: "a000000005", title: "Past its time", whenSaid: MON9 - HOUR, dueAt: MON9 - MIN }),
    loop({ id: "a000000006", title: "Another old", whenSaid: MON9 - 6 * DAY }),
  ];
  assert.deepEqual(pickSlipping(loops, MON9).map((l) => l.title), ["Promise to Ana", "Old request", "Another old"]);
});

function resetRig(o: { roomy?: boolean; events?: CalEvent[]; gentle?: GentleConfig | null } = {}) {
  const r = fuRig({ now: at("2026-11-23T09:30:00Z") });
  const cards: { body: string; buttons: { id: string; title: string }[] }[] = [];
  const deps: WeeklyResetDeps = {
    kv: r.store.kv, timeZone: TZ, now: () => r.clock.now, settings: async () => (o.gentle === undefined ? ON : o.gentle),
    loops: () => r.engine.open(), parked: () => r.engine.parked(), park: async (id) => /^Parked/.test(await r.engine.press("7", id)),
    letGo: (id) => r.engine.letGo(id), quiet: QUIET, roomy: async () => o.roomy ?? false,
    card: async (body, buttons) => (cards.push({ body, buttons }), true),
    ...(o.events ? { events: async () => o.events! } : {}),
  };
  return { ...r, resetCards: cards, reset: createWeeklyReset(deps) };
}

test("reset: Monday 09:30, once; never when gentle mode is off, never during a meeting (it waits for the end)", async () => {
  const off = resetRig({ gentle: null });
  await seedLoop(off, "Send Ana the Q4 deck", { whenSaid: off.clock.now - 3 * DAY });
  assert.equal(await off.reset.sweep(), false);
  const ev: CalEvent = { id: "e", title: "Standup", start: at("2026-11-23T09:15:00Z"), end: at("2026-11-23T10:00:00Z"), allDay: false, calendar: "Work" };
  const r = resetRig({ events: [ev] });
  await seedLoop(r, "Send Ana the Q4 deck", { whenSaid: r.clock.now - 3 * DAY, kind: "owner_promise" });
  await seedLoop(r, "Book the venue", { whenSaid: r.clock.now - 8 * DAY, who: "Omar", kind: "request_to_owner" });
  await seedLoop(r, "Renew the passport", { whenSaid: r.clock.now - 4 * DAY, who: "" });
  await seedLoop(r, "Call the plumber", { whenSaid: r.clock.now - 6 * DAY, who: "" });
  assert.equal(await r.reset.sweep(), false, "in a meeting");
  r.clock.now = at("2026-11-23T10:00:30Z");
  assert.equal(await r.reset.sweep(), true);
  assert.equal(await r.reset.sweep(), false, "once a week");
  const c = r.resetCards[0]!;
  assert.match(c.body, /^🌱 A gentle reset: 3 things are slipping\. Pick one to do this week, and I'll park the rest so they stop pulling at you\./);
  assert.match(c.body, /1\. Send Ana the Q4 deck \(for Ana\)\n2\. Book the venue \(for Omar\)\n3\. Call the plumber/);
  assert.deepEqual(c.buttons.map((b) => b.title), ["This one: 1", "This one: 2", "This one: 3"], "WhatsApp: three buttons");
  assert.match(c.body, /Or say “park 2”/);
  assert.deepEqual(shameIn(c.body), []);
  // Tuesday: nothing more this week.
  r.clock.now += DAY;
  assert.equal(await r.reset.sweep(), false);
});

test("reset: This one is the week's focus (the brief's first line), Park the rest parks the others; Park and “park 2” park one", async () => {
  const r = resetRig({ roomy: true });
  const a = await seedLoop(r, "Send Ana the Q4 deck", { whenSaid: r.clock.now - 3 * DAY, kind: "owner_promise" });
  const b = await seedLoop(r, "Book the venue", { whenSaid: r.clock.now - 8 * DAY, who: "Omar", kind: "request_to_owner" });
  const c = await seedLoop(r, "Call the plumber", { whenSaid: r.clock.now - 6 * DAY, who: "" });
  await r.reset.sweep();
  const card = r.resetCards[0]!;
  assert.deepEqual(card.buttons.map((x) => x.title), ["This one: 1", "This one: 2", "This one: 3", "Park 1", "Park 2", "Park 3"], "roomy: Park too");
  const id = /:(.+)$/.exec(card.buttons[0]!.id)![1]!;
  const pick = await r.reset.pressed("f1", id);
  // Every id fits what the panel's chat and Telegram carry (src/dashboard.ts, src/telegram.ts CARD_ID).
  const CARD_ID = /^[a-z0-9]{1,3}:[0-9a-f]{10}$/;
  for (const b of [...card.buttons, ...pick.card!.buttons, { id: `ck:${a.id}` }, { id: "ci2:0123456789" }]) assert.match(b.id, CARD_ID);
  assert.equal(pick.say, "This week's focus: “Send Ana the Q4 deck”. It'll lead your brief.");
  assert.deepEqual(pick.card!.buttons.map((x) => x.title), ["Park the rest", "Keep them"]);
  assert.equal(pick.card!.body, "Park the other 2 so they stop pulling at you?");
  assert.equal(await r.reset.briefLine(), "🌱 This week's focus: Send Ana the Q4 deck");
  const rest = await r.reset.pressed("pr", id);
  assert.match(rest.say, /^Parked 2: “Book the venue”, “Call the plumber”\./);
  const status = async (l: Loop) => (await r.engine.read()).loops.find((x) => x.id === l.id)!.status;
  assert.equal(await status(a), "open");
  assert.equal(await status(b), "parked");
  assert.equal(await status(c), "parked");
  assert.equal((await r.reset.pressed("kp", id)).say, "OK, they stay as they are.");
  // The brief: the focus first among the facts and in the chat's version; parked ones never listed.
  const g = await gatherFacts({ timeZone: TZ, lang: "en", now: r.clock.now, loops: () => r.engine.open(), focusLoop: async () => (await r.reset.focus())?.loop ?? null });
  assert.match(g.facts[0]!.text, /Send Ana the Q4 deck.*the owner's focus for this week/);
  assert.ok(!g.facts.some((f) => /venue|plumber/.test(f.text)), "parked: never in the brief");
  const doc: BriefDoc = { id: "x", day: "2026-11-23", at: r.clock.now, lang: "en", opening: "", focus: { title: "Prepare the board", story: "", offer: "", sources: [] },
    todos: [], updates: [], dayItems: [], sourcesUsed: [], refs: {} } as unknown as BriefDoc;
  const chat = chatText(doc, { name: "", timeZone: TZ, url: null, now: r.clock.now, weekFocus: await r.reset.briefLine() });
  assert.ok(chat.indexOf("This week's focus") < chat.indexOf("Most valuable today"), chat);
  // "park 2" typed, after another reset's card (the next Monday).
  const d = await seedLoop(r, "Write the newsletter", { whenSaid: r.clock.now - 3 * DAY, who: "" });
  r.clock.now += 7 * DAY;
  await r.reset.sweep();
  const second = r.resetCards.at(-1)!.body;
  assert.match(second, /2\. Write the newsletter/);
  assert.equal(await r.reset.typedPark(2), "Parked: “Write the newsletter”.");
  assert.equal(await status(d), "parked");
  assert.equal(await r.reset.typedPark(3), null);
});

test("reset: a month-old parked item gets “bring back or let go?”; a week later, still parked, it is let go with a note in the history", async () => {
  const r = resetRig();
  const p = await seedLoop(r, "Learn the ukulele", { who: "" });
  await r.engine.press("7", p.id);
  const s = await r.engine.read();
  s.loops.find((x) => x.id === p.id)!.parkedAt = r.clock.now - 31 * DAY;
  await r.store.kv.set(FOLLOWUPS_KEY, JSON.stringify(s), 3600);
  const kept = await seedLoop(r, "Sort the photos", { who: "" });
  await r.engine.press("7", kept.id);
  await r.reset.sweep();
  const body = r.resetCards[0]!.body;
  assert.match(body, /🅿️ Parked a month ago: “Learn the ukulele”\. Bring back or let go\?/);
  assert.match(body, /A gentle reset: nothing is slipping this week/);
  assert.doesNotMatch(body, /photos/);
  assert.deepEqual(r.resetCards[0]!.buttons.map((b) => b.title), ["Let them go"]);
  r.clock.now += 6 * DAY;
  await r.reset.sweep();
  assert.equal((await r.engine.read()).loops.find((x) => x.id === p.id)!.status, "parked", "not before a week");
  r.clock.now += DAY + 11 * MIN;
  await r.reset.sweep();
  assert.equal((await r.engine.read()).loops.find((x) => x.id === p.id)!.status, "dismissed");
  const h = await r.reset.history();
  assert.equal(h[0]!.title, "Learn the ukulele");
  assert.ok(h[0]!.at > h[0]!.parkedAt);
  assert.equal((await r.engine.read()).loops.find((x) => x.id === kept.id)!.status, "parked", "a recent one stays");
  // The next reset does not ask about it again.
  assert.doesNotMatch(r.resetCards.at(-1)!.body, /ukulele[\s\S]*ukulele/);
});

test("reset: Let them go lets the month-old ones go at once", async () => {
  const r = resetRig({ roomy: true });
  const p = await seedLoop(r, "Learn the ukulele", { who: "" });
  await r.engine.press("7", p.id);
  const s = await r.engine.read();
  s.loops.find((x) => x.id === p.id)!.parkedAt = r.clock.now - 40 * DAY;
  await r.store.kv.set(FOLLOWUPS_KEY, JSON.stringify(s), 3600);
  await r.reset.sweep();
  const lg = r.resetCards[0]!.buttons.find((b) => b.title === "Let them go")!;
  const said = await r.reset.pressed("lg", /:(.+)$/.exec(lg.id)![1]!);
  assert.match(said.say, /^Let go: “Learn the ukulele”\. A note stays in your Parked list\./);
  assert.equal((await r.reset.history()).length, 1);
});

test("brief: the plain brief puts gentle mode's lines first, under the greeting", async () => {
  const b = createBrief({
    at: 8 * 60, kv: null, timeZone: TZ, notify: async () => undefined, now: () => MON9,
    reminders: async () => [{ at: MON9 + HOUR, text: "Dentist", held: false }],
    first: [async () => "🌱 This week's focus: Send Ana the Q4 deck", async () => null],
  });
  const text = await b.compose(MON9);
  const lines = text.split("\n").filter(Boolean);
  assert.equal(lines[1], "🌱 This week's focus: Send Ana the Q4 deck");
  assert.ok(text.indexOf("focus") < text.indexOf("Dentist"));
});
