// Time to do it (src/time-to-do.ts): the free working time before a follow-up's time (working hours, quiet hours, meetings, all-day events,
// zones and clock changes), when it is at risk, the words of its card and brief line, and its buttons: Block is the owner's yes and the only
// way a focus block reaches the calendar's queue; a read-only calendar offers a snooze; the caps and gentle mode's limits hold.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import type { CalEvent } from "../src/calendar.ts";
import { createCalendarWrites } from "../src/calendar-writes.ts";
import { candidate } from "../src/followups/answer.ts";
import { loopOf } from "../src/followups/record.ts";
import type { Job, Loop } from "../src/followups/types.ts";
import { FOLLOWUP_BUTTON } from "../src/followups.ts";
import { shameIn } from "../src/gentle.ts";
import { CHECKIN_BUTTON, CHECKIN_LOOP_BUTTON } from "../src/gentle-checkins.ts";
import { RESET_BUTTON } from "../src/gentle-reset.ts";
import type { Kv } from "../src/kv.ts";
import { PROACTIVE_BUTTON } from "../src/proactive.ts";
import { CALENDAR_BUTTON } from "../src/door/calendar-cards.ts";
import { createControl } from "../src/control.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";
import { loadWhatsappConfig, mountWhatsapp } from "../src/whatsapp.ts";
import {
  assess, blockTitle, busySpans, createTimeToDo, effortMinutes, freeSlots, freeWords, horizonEnd, loadWorkHours, riskText, TIME_BUTTON,
  TIME_TO_DO_KEY, TIME_WORDS, type Span, type TimeToDoDeps, type WorkHours,
} from "../src/time-to-do.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const TZ = "Europe/London";
const at = (iso: string): number => Date.parse(iso);
const WORK: WorkHours = { start: 9 * 60, end: 18 * 60, days: [1, 2, 3, 4, 5] };
const QUIET = { start: 23 * 60, end: 8 * 60 };
/** Tuesday 2026-11-24 18:00 in London (GMT): the working day is over. */
const TUE18 = at("2026-11-24T18:00:00Z");
const FRI12 = at("2026-11-27T12:00:00Z");

function memKv() {
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  return { kv, m };
}

const loop = (o: Partial<Loop> = {}): Loop => ({
  id: "a1b2c3d4e5", kind: "owner_promise", title: "Send Ana the Q4 deck", detail: "", who: "Ana", where: { type: "chat", label: "chat" },
  whenSaid: TUE18 - 24 * HOUR, dueAt: FRI12, check: { none: { reason: "email" } }, status: "open", nextCheckAt: 0, nudges: 0,
  createdAt: TUE18 - 24 * HOUR, sources: [], ...o,
});

let n = 0;
const ev = (title: string, start: string, end: string, o: Partial<CalEvent> = {}): CalEvent => ({
  id: `e${++n}`, title, start: at(start), end: at(end), allDay: false, calendar: "Work", ...o,
});

/** The week of the example: Wednesday all busy, Thursday free 10:00–11:00 only, Friday morning busy. One free hour before Friday 12:00. */
const WEEK: CalEvent[] = [
  ev("Offsite", "2026-11-25T09:00:00Z", "2026-11-25T18:00:00Z"),
  ev("Board prep", "2026-11-26T09:00:00Z", "2026-11-26T10:00:00Z"),
  ev("Customer day", "2026-11-26T11:00:00Z", "2026-11-26T18:00:00Z"),
  ev("Workshop", "2026-11-27T09:00:00Z", "2026-11-27T12:00:00Z"),
];

const spans = (list: Span[]): string[] => list.map((s) => `${new Date(s.start).toISOString().slice(5, 16)}~${new Date(s.end).toISOString().slice(11, 16)}`);

// ---------- working hours and effort ----------

test("working hours: 09:00-18:00 Monday to Friday by default; Sunday to Thursday where the country works then; wrong values reported", () => {
  assert.deepEqual(loadWorkHours({}).hours, WORK);
  assert.deepEqual(loadWorkHours({}, "SA").hours.days, [0, 1, 2, 3, 4]);
  assert.deepEqual(loadWorkHours({}, "ES").hours.days, [1, 2, 3, 4, 5]);
  assert.deepEqual(loadWorkHours({ WORK_HOURS: "08:30-17:00", WORK_DAYS: "mon,tue,thu" }).hours, { start: 510, end: 1020, days: [1, 2, 4] });
  assert.deepEqual(loadWorkHours({ WORK_DAYS: "sat-wed" }).hours.days, [6, 0, 1, 2, 3]);
  const bad = loadWorkHours({ WORK_HOURS: "18:00-09:00", WORK_DAYS: "weekdays" });
  assert.deepEqual(bad.hours, WORK);
  assert.equal(bad.problems.length, 2);
});

test("effort: what similar things took first, then the extraction's guess, then a careful default by its words", () => {
  assert.equal(effortMinutes(loop()), 60, "a deck");
  assert.equal(effortMinutes(loop({ title: "Review the contract for Omar" })), 60);
  assert.equal(effortMinutes(loop({ title: "Reply to Omar about the dates" })), 15);
  assert.equal(effortMinutes(loop({ title: "Pick up the keys", check: { slackReply: { channel: "D1", afterTs: "1.2" } } })), 15, "a reply there");
  assert.equal(effortMinutes(loop({ title: "Pick up the keys" })), 30);
  assert.equal(effortMinutes(loop({ effort: 90 })), 90, "the extraction's guess beats the default");
  assert.equal(effortMinutes(loop({ effort: 7 })), 15, "never under a quarter of an hour");
  assert.equal(effortMinutes(loop({ effort: 90 }), 40), 45, "learned beats the guess, rounded up to a quarter");
  assert.equal(effortMinutes(loop({ effort: 2000 })), 480);
});

test("effort: read from the extraction (5 to 480 whole minutes) and kept on the stored loop", () => {
  const job: Job = { id: "0123456789", at: TUE18, source: "chat" as never, where: { type: "chat", label: "chat" }, whenSaid: TUE18, label: "chat" };
  const c = candidate({ kind: "owner_promise", title: "Send Ana the Q4 deck", check: "none", effort: 45 }, job, TZ);
  assert.equal(c?.effort, 45);
  assert.equal(candidate({ kind: "owner_promise", title: "Send Ana the Q4 deck", check: "none", effort: "lots" }, job, TZ)?.effort, undefined);
  assert.equal(candidate({ kind: "owner_promise", title: "Send Ana the Q4 deck", check: "none", effort: 9000 }, job, TZ)?.effort, undefined);
  assert.equal(loopOf(JSON.parse(JSON.stringify(loop({ effort: 45 }))))?.effort, 45);
  assert.equal(loopOf(JSON.parse(JSON.stringify(loop({ effort: 1 }))))?.effort, undefined);
});

// ---------- free time ----------

test("free time: working hours less meetings, in whole quarters; a 10-minute gap is not free time", () => {
  const events = [ev("1:1", "2026-11-23T10:00:00Z", "2026-11-23T11:10:00Z"), ev("Call", "2026-11-23T11:20:00Z", "2026-11-23T12:00:00Z")];
  const free = freeSlots({ from: at("2026-11-23T08:00:00Z"), to: at("2026-11-23T20:00:00Z"), tz: TZ, hours: WORK, quiet: QUIET, events });
  assert.deepEqual(spans(free), ["11-23T09:00~10:00", "11-23T12:00~18:00"]);
  const later = freeSlots({ from: at("2026-11-23T09:07:00Z"), to: at("2026-11-23T10:00:00Z"), tz: TZ, hours: WORK, quiet: QUIET, events });
  assert.deepEqual(spans(later), ["11-23T09:15~10:00"], "from now, rounded up to the quarter");
});

test("free time: never in the quiet hours, never on a day off; declined and mail-only invitations are not busy", () => {
  const early: WorkHours = { start: 6 * 60, end: 23 * 60 + 30, days: [1, 2, 3, 4, 5] };
  const events = [
    ev("Declined", "2026-11-23T09:00:00Z", "2026-11-23T12:00:00Z", { response: "declined" }),
    ev("Invited by mail", "2026-11-23T12:00:00Z", "2026-11-23T13:00:00Z", { invited: "email" }),
    ev("Tentative", "2026-11-23T13:00:00Z", "2026-11-23T14:00:00Z", { response: "tentative" }),
  ];
  const free = freeSlots({ from: at("2026-11-21T00:00:00Z"), to: at("2026-11-24T00:00:00Z"), tz: TZ, hours: early, quiet: QUIET, events });
  assert.deepEqual(spans(free), ["11-23T08:00~13:00", "11-23T14:00~23:00"], "Saturday and Sunday are not worked; 06:00–08:00 and 23:00– are quiet");
});

test("free time: an all-day birthday is not busy; an all-day “Out of office” is, the whole day", () => {
  const day = (title: string): CalEvent => ev(title, "2026-11-23T00:00:00Z", "2026-11-24T00:00:00Z", { allDay: true });
  const o = { from: at("2026-11-23T00:00:00Z"), to: at("2026-11-24T00:00:00Z"), tz: TZ, hours: WORK, quiet: QUIET };
  assert.deepEqual(spans(freeSlots({ ...o, events: [day("Ana's birthday"), day("Thanksgiving")] })), ["11-23T09:00~18:00"]);
  assert.deepEqual(freeSlots({ ...o, events: [day("Out of office")] }), []);
  assert.deepEqual(freeSlots({ ...o, events: [day("Vacation in Lisbon")] }), []);
  assert.equal(busySpans([day("Day off")], o.from, o.to).length, 1);
});

test("free time: in the owner's zone, wherever the server's clock is (Tokyo and New York at the same instant)", () => {
  const from = at("2026-11-23T00:00:00Z"); // Monday 09:00 in Tokyo; Sunday 19:00 in New York
  const to = at("2026-11-23T09:00:00Z"); // Monday 18:00 in Tokyo; Monday 04:00 in New York
  assert.deepEqual(spans(freeSlots({ from, to, tz: "Asia/Tokyo", hours: WORK, quiet: QUIET, events: [] })), ["11-23T00:00~09:00"]);
  assert.deepEqual(freeSlots({ from, to, tz: "America/New_York", hours: WORK, quiet: QUIET, events: [] }), []);
  // A zone a quarter of an hour off UTC keeps its own 09:00.
  assert.deepEqual(spans(freeSlots({ from: at("2026-11-23T00:00:00Z"), to: at("2026-11-23T06:00:00Z"), tz: "Asia/Kathmandu", hours: WORK, quiet: null, events: [] })),
    ["11-23T03:15~06:00"]);
});

test("free time: the clocks going forward and back keep 09:00–18:00 local (London, March and October)", () => {
  // Friday 27 March 17:00 GMT to Monday 30 March 10:00 BST: Friday's last hour, then Monday 09:00 BST is 08:00 UTC.
  const spring = freeSlots({ from: at("2026-03-27T17:00:00Z"), to: at("2026-03-30T09:00:00Z"), tz: TZ, hours: WORK, quiet: QUIET, events: [] });
  assert.deepEqual(spans(spring), ["03-27T17:00~18:00", "03-30T08:00~09:00"]);
  // Friday 23 October 16:00 BST to Monday 26 October 10:00 GMT: Friday 16:00–18:00 BST is 15:00–17:00 UTC, Monday 09:00 GMT is 09:00 UTC.
  const autumn = freeSlots({ from: at("2026-10-23T15:00:00Z"), to: at("2026-10-26T10:00:00Z"), tz: TZ, hours: WORK, quiet: QUIET, events: [] });
  assert.deepEqual(spans(autumn), ["10-23T15:00~17:00", "10-26T09:00~10:00"]);
});

test("horizon: the end of the third working day, today counting while its working hours last", () => {
  assert.equal(horizonEnd(at("2026-11-26T10:00:00Z"), TZ, WORK), at("2026-11-30T18:00:00Z"), "Thursday: Thu, Fri, Mon");
  assert.equal(horizonEnd(at("2026-11-27T19:00:00Z"), TZ, WORK), at("2026-12-02T18:00:00Z"), "Friday evening: Mon, Tue, Wed");
});

// ---------- at risk ----------

test("at risk: one free hour for an hour's work is the last chance; less is short; none is none; twice the room is fine", () => {
  const o = { now: TUE18, until: FRI12, tz: TZ, hours: WORK, quiet: QUIET };
  const last = assess(loop(), WEEK, o)!;
  assert.equal(last.reason, "last");
  assert.equal(last.free, 60);
  assert.deepEqual(last.proposal, { start: at("2026-11-26T10:00:00Z"), end: at("2026-11-26T11:00:00Z") });
  assert.equal(assess(loop({ effort: 90 }), WEEK, o)!.reason, "short");
  assert.equal(assess(loop(), [...WEEK, ev("Dentist", "2026-11-26T10:00:00Z", "2026-11-26T11:00:00Z")], o)!.reason, "none");
  assert.equal(assess(loop({ effort: 30 }), WEEK, o)!.reason, "ok", "room for it twice in the hour");
  // Enough free time, in pieces none of which holds it: the longest is proposed.
  const split = [ev("Offsite", "2026-11-25T09:00:00Z", "2026-11-25T18:00:00Z"), ev("A", "2026-11-26T09:00:00Z", "2026-11-26T09:45:00Z"),
    ev("B", "2026-11-26T10:30:00Z", "2026-11-26T11:00:00Z"), ev("C", "2026-11-26T11:45:00Z", "2026-11-27T12:00:00Z")];
  const r = assess(loop(), split, o)!;
  assert.equal(r.reason, "split");
  assert.deepEqual(r.proposal, { start: at("2026-11-26T09:45:00Z"), end: at("2026-11-26T10:30:00Z") });
  // An event before its time named after it: already planned.
  assert.equal(assess(loop(), [...WEEK, ev("Focus: Send Ana the Q4 deck", "2026-11-26T10:00:00Z", "2026-11-26T11:00:00Z")], o), null);
});

test("words: the card says why and proposes the block, as the owner reads it", () => {
  const r = assess(loop(), WEEK, { now: TUE18, until: FRI12, tz: TZ, hours: WORK, quiet: QUIET })!;
  assert.equal(riskText(r, TUE18, TZ),
    "⏳ At risk: “Send Ana the Q4 deck” is due Fri 12:00 and you have one free hour before then — Thu 10:00–11:00. Block it?");
  assert.equal(blockTitle(r.proposal!, TUE18, TZ), "Block Thu 10–11");
  assert.equal(blockTitle({ start: at("2026-11-26T10:30:00Z"), end: at("2026-11-26T11:30:00Z") }, TUE18, TZ), "Block Thu 10:30");
  const short = assess(loop({ effort: 90 }), WEEK, { now: TUE18, until: FRI12, tz: TZ, hours: WORK, quiet: QUIET })!;
  assert.match(riskText(short, TUE18, TZ), /you have one free hour before then — Thu 10:00–11:00 \(it takes about 90 min\)\. Block it\?$/);
  assert.equal(freeWords(45), "45 free minutes");
  assert.equal(freeWords(120), "2 free hours");
  assert.equal(freeWords(150), "2 h 30 min of free time");
  for (const w of Object.values(TIME_WORDS)) assert.deepEqual(shameIn(w), [], w);
});

test("buttons: tb, ta and tn are their own; no other card's button is taken for one", () => {
  assert.deepEqual(TIME_BUTTON.exec("tb:a1b2c3d4e5")?.slice(1), ["b", "a1b2c3d4e5"]);
  for (const id of ["tb:a1b2c3d4e5", "ta:a1b2c3d4e5", "tn:a1b2c3d4e5"]) {
    for (const other of [FOLLOWUP_BUTTON, CALENDAR_BUTTON, CHECKIN_BUTTON, CHECKIN_LOOP_BUTTON, RESET_BUTTON, PROACTIVE_BUTTON]) assert.equal(other.test(id), false);
  }
  assert.equal(TIME_BUTTON.test("tx:a1b2c3d4e5"), false);
});

// ---------- the engine ----------

type Card = { body: string; buttons: { id: string; title: string }[] };

function rig(o: Omit<Partial<TimeToDoDeps>, "loops" | "events"> & { clock?: { now: number }; loops?: Loop[]; events?: CalEvent[]; writable?: boolean | null } = {}) {
  const clock = o.clock ?? { now: TUE18 };
  const store = memKv();
  const cards: Card[] = [];
  const queue = createCalendarWrites({ kv: null, now: () => clock.now });
  const enqueued: unknown[] = [];
  const state = { loops: o.loops ?? [loop()], events: o.events ?? WEEK, paused: null as string | null, stops: 0 };
  const engaged: string[] = [];
  const { loops: _l, events: _e, writable, clock: _c, ...rest } = o;
  const t = createTimeToDo({
    kv: store.kv, timeZone: TZ, now: () => clock.now, hours: WORK, quiet: QUIET, standardMax: 6,
    loops: async () => state.loops, events: async () => state.events,
    writes: () => writable === null ? null : {
      canWrite: async () => writable !== false,
      enqueue: async (w) => (enqueued.push(w), queue.enqueue(w)),
    },
    paused: async () => state.paused, stops: () => state.stops,
    card: async (body, buttons) => (cards.push({ body, buttons }), true),
    engaged: async (id) => void engaged.push(id),
    ...rest,
  });
  return { clock, store, cards, queue, enqueued, state, engaged, t };
}

test("engine: one at-risk card with Block, Another time and Not needed; nothing written before a press; never twice for one follow-up", async () => {
  const r = rig();
  assert.equal(await r.t.sweep(), "a1b2c3d4e5");
  assert.equal(r.cards.length, 1);
  assert.match(r.cards[0]!.body, /^⏳ At risk: “Send Ana the Q4 deck” is due Fri 12:00/);
  assert.deepEqual(r.cards[0]!.buttons, [
    { id: "tb:a1b2c3d4e5", title: "Block Thu 10–11" }, { id: "ta:a1b2c3d4e5", title: "Another time" }, { id: "tn:a1b2c3d4e5", title: "Not needed" },
  ]);
  assert.deepEqual(r.enqueued, [], "no write without the owner's yes");
  r.clock.now += 11 * MIN;
  assert.equal(await r.t.sweep(), null, "one card per follow-up");
  r.clock.now += 24 * HOUR;
  assert.equal(await r.t.sweep(), null, "not the next day either");
  assert.equal(r.cards.length, 1);
  assert.deepEqual(r.enqueued, []);
  assert.equal(await r.t.spentToday(), 0, "the day moved on");
});

test("engine: Block is the yes: the focus block goes into the calendar's queue once, titled with the follow-up, under the offer's id", async () => {
  const r = rig();
  await r.t.sweep();
  const said = await r.t.pressed("b", "a1b2c3d4e5");
  assert.equal(said, "OK: “Focus: Send Ana the Q4 deck”, Thu 10:00–11:00, goes on your Mac's calendar in a few seconds.");
  assert.equal(r.enqueued.length, 1);
  const w = r.enqueued[0] as { id: string; op: string; title: string; start: number; end: number };
  assert.match(w.id, /^[0-9a-f]{10}$/);
  assert.deepEqual({ op: w.op, title: w.title, start: w.start, end: w.end },
    { op: "create", title: "Focus: Send Ana the Q4 deck", start: at("2026-11-26T10:00:00Z"), end: at("2026-11-26T11:00:00Z") });
  assert.equal((await r.queue.get(w.id))?.status, "queued");
  assert.deepEqual(r.engaged, ["a1b2c3d4e5"], "a press is an answer to the follow-up");
  // Pressed again (twice, or on another chat): still one write.
  assert.equal(await r.t.pressed("b", "a1b2c3d4e5"), "That block is already on its way to your calendar.");
  assert.equal(r.enqueued.length, 1);
  // Blocked: no longer at risk in the brief.
  assert.equal(await r.t.briefLine(), null);
});

test("engine: Not needed and Another time never write; Another time proposes the next free time with a new id, then says it was the only one", async () => {
  const events = WEEK.filter((e) => e.title !== "Workshop"); // Friday 09:00–12:00 free too
  const r = rig({ events, loops: [loop({ effort: 60 })] });
  // Thursday 10–11 and Friday 09–12: room three times, not at risk; asked for by words.
  assert.equal(await r.t.sweep(), null);
  assert.equal(await r.t.findTime("ana deck"), "");
  assert.match(r.cards[0]!.body, /^🗓 Free time for “Send Ana the Q4 deck” \(about 60 min\): Thu 10:00–11:00\. Block it\?$/);
  const first = (await r.t.offers())[0]!;
  assert.equal(await r.t.pressed("a", "a1b2c3d4e5"), "");
  assert.match(r.cards[1]!.body, /Fri 09:00–10:00/);
  const second = (await r.t.offers())[0]!;
  assert.notEqual(second.write, first.write, "a new time is a new write");
  assert.equal(await r.t.pressed("a", "a1b2c3d4e5"), "");
  assert.match(r.cards[2]!.body, /Fri 10:00–11:00/);
  await r.t.pressed("a", "a1b2c3d4e5");
  assert.equal(await r.t.pressed("a", "a1b2c3d4e5"), "That's the only free time I see before it's due. Block it, or leave it?");
  assert.equal(await r.t.pressed("n", "a1b2c3d4e5"), "OK, no block for “Send Ana the Q4 deck”.");
  assert.equal(await r.t.pressed("b", "a1b2c3d4e5"), TIME_WORDS.gone, "a Block after Not needed changes nothing");
  assert.deepEqual(r.enqueued, []);
});

test("engine: a read-only calendar says so and offers the follow-up's snooze instead of Block; a Block pressed then writes nothing", async () => {
  const r = rig({ writable: null });
  await r.t.sweep();
  assert.match(r.cards[0]!.body, /I can't write to your calendar from here/);
  assert.deepEqual(r.cards[0]!.buttons.map((b) => b.id), ["f2:a1b2c3d4e5", "ta:a1b2c3d4e5", "tn:a1b2c3d4e5"]);
  // An older card's Block, the calendar no longer writable (the Mac app closed): said, with the snooze.
  const w = rig({ writable: false });
  await w.t.sweep();
  assert.equal(await w.t.pressed("b", "a1b2c3d4e5"), "");
  assert.match(w.cards.at(-1)!.body, /^I can't write to your calendar from here, so nothing was added\. Block Thu 10:00–11:00 yourself/);
  assert.deepEqual(w.cards.at(-1)!.buttons.map((b) => b.id), ["f2:a1b2c3d4e5", "tn:a1b2c3d4e5"]);
  assert.deepEqual(w.enqueued, []);
});

test("engine: no write while paused, after a STOP, for a closed follow-up, or for a time that has passed (proposed again instead)", async () => {
  const p = rig();
  await p.t.sweep();
  p.state.paused = "Pako is paused.";
  assert.equal(await p.t.pressed("b", "a1b2c3d4e5"), "Pako is paused. Your calendar was not changed.");
  const s = rig();
  await s.t.sweep();
  s.state.stops = 1;
  assert.equal(await s.t.pressed("b", "a1b2c3d4e5"), TIME_WORDS.gone);
  const c = rig();
  await c.t.sweep();
  c.state.loops = [];
  assert.equal(await c.t.pressed("b", "a1b2c3d4e5"), "“Send Ana the Q4 deck” is closed already, so I added nothing.");
  // Thursday 10:30: the hour proposed has begun. Friday 09:00–12:00 is free now: proposed, not written.
  const l = rig({ events: WEEK.filter((e) => e.title !== "Workshop") });
  await l.t.findTime("deck");
  l.clock.now = at("2026-11-26T10:30:00Z");
  assert.equal(await l.t.pressed("b", "a1b2c3d4e5"), "");
  assert.match(l.cards.at(-1)!.body, /^That time has passed, so I added nothing\. Here is the next free time I see:\n.*tomorrow 09:00–10:00/);
  for (const x of [p, s, c, l]) assert.deepEqual(x.enqueued, []);
});

test("engine: none due in under two hours, none in the quiet hours, none past the day's shared cap, none without a calendar", async () => {
  const soon = rig({ loops: [loop({ dueAt: TUE18 + 90 * MIN })], events: [] });
  assert.equal(await soon.t.sweep(), null);
  const quiet = rig({ clock: { now: at("2026-11-24T23:30:00Z") } });
  assert.equal(await quiet.t.sweep(), null);
  const capped = rig({ others: async () => 6 });
  assert.equal(await capped.t.sweep(), null);
  const shared = rig({ others: async () => 5 });
  assert.equal(await shared.t.sweep(), "a1b2c3d4e5");
  assert.equal(await shared.t.spentToday(), 1, "counted for the others' cap");
  const none = createTimeToDo({ kv: null, timeZone: TZ, hours: WORK, quiet: QUIET, standardMax: 6, loops: async () => [loop()], card: async () => true, now: () => TUE18 });
  assert.equal(await none.sweep(), null);
  assert.equal(await none.findTime("deck"), "I can't see your calendar, so I can't find free time for it.");
  // Someone else's promise, a meeting to set up, or one without a time: never at risk.
  const others = rig({
    loops: [
      loop({ id: "b1b2c3d4e5", kind: "other_promise" }),
      loop({ id: "c1b2c3d4e5", check: { calendarEvent: { around: FRI12, hints: ["Ana"] } } }),
      loop({ id: "d1b2c3d4e5", dueAt: undefined }),
    ],
  });
  assert.equal(await others.t.sweep(), null);
});

test("engine: a card that could not go is not counted, and the next look tries again", async () => {
  let up = false;
  const r = rig({ card: async () => up });
  assert.equal(await r.t.sweep(), null);
  assert.equal(await r.t.spentToday(), 0);
  up = true;
  r.clock.now += 11 * MIN;
  assert.equal(await r.t.sweep(), "a1b2c3d4e5");
});

test("gentle: its own cap, no card for a follow-up it stopped nudging, and none after two of these cards went unanswered", async () => {
  const capped = rig({ gentle: async () => ({ maxPerDay: 2 }), others: async () => 2 });
  assert.equal(await capped.t.sweep(), null, "gentle's cap of 2 is spent");
  const folded = rig({ gentle: async () => ({ maxPerDay: 4 }), loops: [loop({ folded: true }), loop({ id: "b1b2c3d4e5", unanswered: 2 })] });
  assert.equal(await folded.t.sweep(), null);
  const ids = ["a1b2c3d4e5", "b1b2c3d4e5", "c1b2c3d4e5"];
  const ignored = rig({ gentle: async () => ({ maxPerDay: 10 }), loops: ids.map((id, i) => loop({ id, title: `Write report ${i + 1}` })) });
  assert.equal(await ignored.t.sweep(), "a1b2c3d4e5");
  ignored.clock.now += 61 * MIN;
  assert.equal(await ignored.t.sweep(), "b1b2c3d4e5");
  ignored.clock.now += 61 * MIN;
  assert.equal(await ignored.t.sweep(), null, "two unanswered: no third");
  // Normal mode has no such stop.
  const normal = rig({ loops: ids.map((id, i) => loop({ id, title: `Write report ${i + 1}` })) });
  for (let i = 0; i < 3; i++) {
    assert.ok(await normal.t.sweep());
    normal.clock.now += 61 * MIN;
  }
});

test("brief: each follow-up at risk in one line, with its block and how to ask for it; a read-only calendar says to block it there", async () => {
  const r = rig();
  assert.equal(await r.t.briefLine(),
    "⏳ At risk: “Send Ana the Q4 deck” is due Fri 12:00 and you have one free hour before then — Thu 10:00–11:00. Block it?"
    + " Say “find time for send ana the q4 deck”.");
  const ro = rig({ writable: null });
  assert.match((await ro.t.briefLine())!, /Block it\? Worth blocking it in your calendar\.$/);
  const fine = rig({ loops: [loop({ effort: 15 })] });
  assert.equal(await fine.t.briefLine(), null, "room for it: nothing said");
});

test("find time: the one open follow-up of the owner's that the words name; several or none are said, never guessed", async () => {
  const r = rig({ loops: [loop(), loop({ id: "b1b2c3d4e5", title: "Send Omar the Q4 deck", who: "Omar" }), loop({ id: "c1b2c3d4e5", kind: "other_promise", title: "Ana sends the budget" })] });
  assert.equal(await r.t.findTime("the deck"), "Several match: “Send Ana the Q4 deck”, “Send Omar the Q4 deck”. Which one?");
  assert.equal(await r.t.findTime("budget"), TIME_WORDS.findNone, "someone else's promise is theirs");
  assert.equal(await r.t.findTime("omar"), "");
  assert.match(r.cards[0]!.body, /“Send Omar the Q4 deck”/);
  assert.equal((await r.t.offers())[0]!.nudge, false, "asked for: not counted as a nudge");
  assert.equal(await r.t.spentToday(), 0);
  // Pressing Block on it writes the block like any other.
  assert.match(await r.t.pressed("b", "b1b2c3d4e5"), /^OK: “Focus: Send Omar the Q4 deck”/);
  assert.equal(r.enqueued.length, 1);
  assert.ok(r.store.m.has(TIME_TO_DO_KEY));
});

// ---------- through the door ----------

const ENV = {
  WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
};

test("door: “find time for the deck” shows the card; only its Block, pressed, queues the block (once); after a STOP it changes nothing", async () => {
  type Body = Record<string, any>;
  const sent: Body[] = [];
  const meta = (async (_u: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Body);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out${sent.length}` }] }), { status: 200 });
  }) as typeof fetch;
  const { kv } = memKv();
  const writes = createCalendarWrites({ kv, now: () => TUE18 });
  const memory = loadMemory(kv);
  const tools = loadVoiceTools({ memory, actions: { contacts: () => [], callContact: async () => ({ ok: true, text: "started" }), lookupCall: async () => "ok" } });
  const config = loadWhatsappConfig(ENV, "+447700900123").config!;
  const app = express();
  const ref: { t: ReturnType<typeof createTimeToDo> | null } = { t: null };
  const door = mountWhatsapp(app, {
    config, tools, memory, kv, control: createControl(kv, () => TUE18), ownerName: "Alex", timeZone: TZ, contacts: () => [], fetch: meta,
    now: () => TUE18, callCheckMs: 5, receiptWaitMs: 60_000,
    calendarWrites: { canWrite: async () => true, find: async () => null, enqueue: writes.enqueue, get: writes.get },
    timeToDo: { pressed: (b, id) => ref.t!.pressed(b, id), findTime: (w) => ref.t!.findTime(w) },
  });
  ref.t = createTimeToDo({
    kv, timeZone: TZ, now: () => TUE18, hours: WORK, quiet: QUIET, standardMax: 6, loops: async () => [loop()], events: async () => WEEK,
    writes: () => door.calendarWrites(), stops: () => door.stops(), card: (body, buttons) => door.sendCard(body, buttons),
  });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let k = 0;
  const hook = async (msg: Body) => {
    const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp", metadata: { phone_number_id: config.phoneNumberId }, messages: [{ from: "447700900123", id: `wamid.t${++k}`, timestamp: String(TUE18 / 1000), ...msg }],
    } }] }] });
    const signature = `sha256=${createHmac("sha256", config.appSecret).update(raw).digest("hex")}`;
    await fetch(`${base}/whatsapp/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature }, body: raw });
  };
  const cards = () => sent.filter((b) => b.type === "interactive");
  const press = (id: string) => hook({ type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: "x" } } });
  const texts = () => sent.map((b) => (b.type === "text" ? b.text.body : b.interactive.body.text) as string);
  try {
    await hook({ type: "text", text: { body: "find time for the deck" } });
    const card = cards().at(-1)!;
    assert.match(card.interactive.body.text, /^⏳ At risk: “Send Ana the Q4 deck” is due Fri 12:00/);
    const ids = card.interactive.action.buttons.map((b: Body) => b.reply.id as string);
    assert.deepEqual(ids, ["tb:a1b2c3d4e5", "ta:a1b2c3d4e5", "tn:a1b2c3d4e5"]);
    assert.deepEqual(await writes.exchange([]), [], "nothing queued before the press");
    await press("tb:a1b2c3d4e5");
    await press("tb:a1b2c3d4e5");
    const queued = await writes.exchange([]);
    assert.equal(queued.length, 1, "pressed twice: one write");
    assert.deepEqual([queued[0]!.op, queued[0]!.title, queued[0]!.start], ["create", "Focus: Send Ana the Q4 deck", at("2026-11-26T10:00:00Z")]);
    assert.match(texts().at(-2)!, /^OK: “Focus: Send Ana the Q4 deck”, Thu 10:00–11:00/);
    // A STOP ends the cards waiting: a new card's Block, pressed after it, changes nothing.
    await press("tn:a1b2c3d4e5");
    await hook({ type: "text", text: { body: "find time for ana deck" } });
    await hook({ type: "text", text: { body: "STOP" } });
    await press("tb:a1b2c3d4e5");
    assert.deepEqual(await writes.exchange([]), [], "no write after the STOP");
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
