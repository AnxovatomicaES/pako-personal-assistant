// The evening wrap-up (src/shutdown.ts): what is due on the next working day and still open, whether it fits the calendar, Plan and Done,
// sent once at the end of the working day, never on a day off, in the quiet hours, during a meeting or in gentle mode.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CalEvent } from "../src/calendar.ts";
import type { Loop } from "../src/followups/types.ts";
import { shameIn } from "../src/gentle.ts";
import type { Kv } from "../src/kv.ts";
import {
  createShutdown, loadShutdownConfig, nextWorkingDay, planShutdown, SHUTDOWN_BUTTON, SHUTDOWN_KEY, SHUTDOWN_WORDS, type ShutdownDeps,
} from "../src/shutdown.ts";
import type { WorkHours } from "../src/time-to-do.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const TZ = "Europe/London";
const at = (iso: string): number => Date.parse(iso);
const WORK: WorkHours = { start: 9 * 60, end: 18 * 60, days: [1, 2, 3, 4, 5] };
const QUIET = { start: 23 * 60, end: 8 * 60 };
/** Thursday 2026-11-26 18:00 in London (GMT). */
const THU18 = at("2026-11-26T18:00:00Z");

const loop = (o: Partial<Loop> = {}): Loop => ({
  id: "a1b2c3d4e5", kind: "owner_promise", title: "Send Ana the Q4 deck", detail: "", who: "Ana", where: { type: "chat", label: "chat" },
  whenSaid: THU18 - 48 * HOUR, dueAt: at("2026-11-27T12:00:00Z"), check: { none: { reason: "email" } }, status: "open", nextCheckAt: 0,
  nudges: 0, createdAt: THU18 - 48 * HOUR, sources: [], ...o,
});
let n = 0;
const ev = (title: string, start: string, end: string): CalEvent => ({ id: `e${++n}`, title, start: at(start), end: at(end), allDay: false, calendar: "Work" });

function memKv() {
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  return { kv, m };
}

function rig(o: { loops?: Loop[]; events?: CalEvent[]; roomy?: boolean; gentle?: boolean; now?: number; at?: string } = {}) {
  const clock = { now: o.now ?? THU18 };
  const cards: { body: string; buttons: { id: string; title: string }[] }[] = [];
  const planned: string[] = [];
  const done: string[] = [];
  const loops = o.loops ?? [loop()];
  const store = memKv();
  const deps: ShutdownDeps = {
    kv: store.kv, timeZone: TZ, now: () => clock.now, config: loadShutdownConfig(o.at ? { SHUTDOWN: o.at } : {}, WORK), hours: WORK, quiet: QUIET,
    loops: async () => loops,
    ...(o.events ? { events: async () => o.events! } : {}),
    gentle: async () => !!o.gentle,
    roomy: async () => o.roomy ?? true,
    card: async (body, buttons) => (cards.push({ body, buttons }), true),
    plan: async (id) => (planned.push(id), ""),
    done: async (id) => (done.push(id), "Done ✓"),
  };
  return { clock, cards, planned, done, loops, store, s: createShutdown(deps) };
}

test("config: SHUTDOWN off, a time, or the end of the working day; a bad value is said and the default kept", () => {
  assert.equal(loadShutdownConfig({}, WORK).at, 18 * 60);
  assert.equal(loadShutdownConfig({ SHUTDOWN: "off" }, WORK).at, null);
  assert.equal(loadShutdownConfig({ SHUTDOWN: "17:45" }, WORK).at, 17 * 60 + 45);
  const bad = loadShutdownConfig({ SHUTDOWN: "late" }, WORK);
  assert.equal(bad.at, 18 * 60);
  assert.equal(bad.problems.length, 1);
  assert.equal(nextWorkingDay("2026-11-27", WORK), "2026-11-30", "Friday's next working day is Monday");
});

test("plan: overdue and next-day items are the owner's only, open, not meetings; done today counted; the next day's fit from the calendar", () => {
  const loops = [
    loop({ id: "aaaaaaaaa1", title: "Send Ana the Q4 deck", dueAt: at("2026-11-27T12:00:00Z") }),
    loop({ id: "aaaaaaaaa2", title: "Reply to Omar", kind: "request_to_owner", who: "Omar", dueAt: at("2026-11-26T15:00:00Z") }),
    loop({ id: "aaaaaaaaa3", title: "Their contract", kind: "other_promise", dueAt: at("2026-11-27T10:00:00Z") }),
    loop({ id: "aaaaaaaaa4", title: "Set up the call", check: { calendarEvent: { hints: ["call"] } } }),
    loop({ id: "aaaaaaaaa5", title: "Old done", status: "done", closedAt: THU18 - HOUR }),
    loop({ id: "aaaaaaaaa6", title: "Next week", dueAt: at("2026-12-02T12:00:00Z") }),
  ];
  // Friday: meetings 09:00-17:30, so 30 minutes free; the deck (60) and the reply (15) need 75.
  const events = [ev("Offsite", "2026-11-27T09:00:00Z", "2026-11-27T17:30:00Z")];
  const p = planShutdown({ loops, events, now: THU18, tz: TZ, hours: WORK, quiet: QUIET })!;
  assert.deepEqual(p.overdue.map((l) => l.id), ["aaaaaaaaa2"]);
  assert.deepEqual(p.next.map((l) => l.id), ["aaaaaaaaa1"]);
  assert.equal(p.doneToday, 1);
  assert.equal(p.day, "2026-11-27");
  assert.deepEqual(p.fit, { need: 75, free: 30 });
  assert.equal(planShutdown({ loops, events: null, now: THU18, tz: TZ, hours: WORK, quiet: QUIET })!.fit, null, "no calendar: nothing said of fit");
});

test("the message: done today, still open, due tomorrow, and that it doesn't fit; Plan and Done per item, which act on the right loop", async () => {
  const loops = [
    loop({ id: "aaaaaaaaa1", title: "Send Ana the Q4 deck", dueAt: at("2026-11-27T12:00:00Z") }),
    loop({ id: "aaaaaaaaa2", title: "Reply to Omar", kind: "request_to_owner", who: "Omar", dueAt: at("2026-11-26T15:00:00Z") }),
    loop({ id: "aaaaaaaaa5", title: "Old done", status: "done", closedAt: THU18 - HOUR }),
  ];
  const r = rig({ loops, events: [ev("Offsite", "2026-11-27T09:00:00Z", "2026-11-27T17:30:00Z")] });
  assert.equal(await r.s.sweep(), true);
  assert.equal(r.cards.length, 1);
  const { body, buttons } = r.cards[0]!;
  assert.match(body, /^🌇 Wrapping up Thursday\. Done today: 1\./);
  assert.match(body, /Still open:\n1\. Reply to Omar \(for Omar\) · today 15:00/);
  assert.match(body, /Due tomorrow:\n2\. Send Ana the Q4 deck \(for Ana\) · 12:00/);
  assert.match(body, /⚠️ Tomorrow doesn't fit: about 1 h 15 min of work due and 30 min free/);
  assert.deepEqual(buttons.map((b) => b.title), ["Plan 1", "Plan 2", "Done 1", "Done 2"]);
  const id = SHUTDOWN_BUTTON.exec(buttons[1]!.id)![3]!;
  assert.equal(await r.s.pressed("p", 2, id), "");
  assert.deepEqual(r.planned, ["aaaaaaaaa1"]);
  assert.equal(await r.s.pressed("d", 1, id), "Done ✓");
  assert.deepEqual(r.done, ["aaaaaaaaa2"]);
  // Once a day: a second look sends nothing.
  r.clock.now += 30 * MIN;
  assert.equal(await r.s.sweep(), false);
  assert.equal(r.cards.length, 1);
  assert.ok(r.store.m.has(SHUTDOWN_KEY));
  // A closed one, and an old wrap-up, are said so.
  r.loops[0]!.status = "done";
  assert.match(await r.s.pressed("p", 2, id), /isn't open any more/);
  r.clock.now += 3 * 24 * HOUR;
  assert.match(await r.s.pressed("d", 1, id), /earlier day/);
});

test("a chat with three buttons: the first item's Plan and Done only; a day that fits says so", async () => {
  const r = rig({ roomy: false, events: [ev("Standup", "2026-11-27T09:00:00Z", "2026-11-27T09:30:00Z")] });
  await r.s.sweep();
  assert.deepEqual(r.cards[0]!.buttons.map((b) => b.title), ["Plan 1", "Done 1"]);
  assert.match(r.cards[0]!.body, /Tomorrow fits: about 1 h of work due and 8 h 30 min free\./);
});

test("silence: nothing due or open, a day off, before its time, too late, the quiet hours, a meeting, gentle mode, SHUTDOWN=off", async () => {
  const none = rig({ loops: [loop({ dueAt: at("2026-12-02T12:00:00Z") })] });
  assert.equal(await none.s.sweep(), true, "the day's look is done");
  assert.equal(none.cards.length, 0, "nothing to say: no message");
  const saturday = rig({ now: at("2026-11-28T18:00:00Z") });
  assert.equal(await saturday.s.sweep(), false);
  const early = rig({ now: THU18 - MIN });
  assert.equal(await early.s.sweep(), false);
  const late = rig({ now: THU18 + 3 * HOUR + MIN });
  assert.equal(await late.s.sweep(), false);
  const quiet = rig({ at: "23:15", now: at("2026-11-26T23:20:00Z") });
  assert.equal(await quiet.s.sweep(), false, "the quiet hours");
  const busy = rig({ events: [ev("Late call", "2026-11-26T17:30:00Z", "2026-11-26T18:45:00Z")] });
  assert.equal(await busy.s.sweep(), false, "during a meeting");
  busy.clock.now = at("2026-11-26T18:46:00Z");
  assert.equal(await busy.s.sweep(), true, "after it");
  const gentle = rig({ gentle: true });
  assert.equal(await gentle.s.sweep(), false);
  const off = rig({ at: "off" });
  assert.equal(await off.s.sweep(), false);
  for (const r of [saturday, early, late, quiet, gentle, off]) assert.equal(r.cards.length, 0);
});

test("words: none of the wrap-up's words shame", () => {
  for (const w of Object.values(SHUTDOWN_WORDS)) assert.deepEqual(shameIn(w), [], w);
});

test("Friday: the week too — done this week, what others owe that is late, what is due later next week; a plain message with nothing to press", async () => {
  const FRI18 = at("2026-11-27T18:00:00Z");
  const loops = [
    loop({ id: "aaaaaaaaa1", title: "Send Ana the Q4 deck", dueAt: at("2026-11-30T12:00:00Z") }),
    loop({ id: "aaaaaaaaa2", title: "Review the SOW", dueAt: at("2026-12-02T12:00:00Z") }),
    loop({ id: "aaaaaaaaa3", title: "Plan the offsite", dueAt: at("2026-12-04T12:00:00Z") }),
    loop({ id: "aaaaaaaaa4", title: "Send the contract", kind: "other_promise", who: "Nadia", dueAt: at("2026-11-25T17:00:00Z") }),
    loop({ id: "aaaaaaaaa5", title: "Done Monday", status: "done", closedAt: at("2026-11-23T11:00:00Z") }),
    loop({ id: "aaaaaaaaa6", title: "Done last month", status: "done", closedAt: at("2026-10-23T11:00:00Z") }),
  ];
  const r = rig({ loops, now: FRI18 });
  assert.equal(await r.s.sweep(), true);
  const { body, buttons } = r.cards[0]!;
  assert.match(body, /^🌇 Wrapping up the week\. Done this week: 1\./);
  assert.match(body, /Due Monday:\n1\. Send Ana the Q4 deck \(for Ana\) · 12:00/);
  assert.match(body, /Waiting on others:\n• Nadia: Send the contract \(due Wed\)/);
  assert.match(body, /Later next week: 2 more due, the first “Review the SOW” on Wed\./);
  assert.deepEqual(buttons.map((b) => b.title), ["Plan 1", "Done 1"]);
  const p = planShutdown({ loops, events: null, now: THU18, tz: TZ, hours: WORK, quiet: QUIET })!;
  assert.equal(p.week, undefined, "a Thursday is only the day");

  // Only what others owe: a plain message, no card with no buttons.
  const lines: string[] = [];
  const only = createShutdown({
    kv: null, timeZone: TZ, now: () => FRI18, config: loadShutdownConfig({}, WORK), hours: WORK, quiet: QUIET,
    loops: async () => [loops[3]!], roomy: async () => true, card: async () => assert.fail("no card"),
    notify: async (t) => (lines.push(t), true), plan: async () => "", done: async () => "",
  });
  assert.equal(await only.sweep(), true);
  assert.match(lines[0]!, /Waiting on others:\n• Nadia: Send the contract/);
});

test("tomorrow's calendar: a double booking and an invitation not answered are said, even with nothing due; a declined one is not", async () => {
  const events = [
    ev("Bluefin review", "2026-11-27T10:00:00Z", "2026-11-27T11:00:00Z"),
    ev("Sales sync", "2026-11-27T10:30:00Z", "2026-11-27T11:30:00Z"),
    { ...ev("Offsite planning", "2026-11-27T14:00:00Z", "2026-11-27T15:00:00Z"), response: "needs" as const },
    { ...ev("Declined thing", "2026-11-27T10:15:00Z", "2026-11-27T10:45:00Z"), response: "declined" as const },
    ev("Back to back", "2026-11-27T11:30:00Z", "2026-11-27T12:00:00Z"),
  ];
  const lines: string[] = [];
  const s = createShutdown({
    kv: null, timeZone: TZ, now: () => THU18, config: loadShutdownConfig({}, WORK), hours: WORK, quiet: QUIET, loops: async () => [],
    events: async () => events, roomy: async () => true, card: async () => false, notify: async (t) => (lines.push(t), true),
    plan: async () => "", done: async () => "",
  });
  assert.equal(await s.sweep(), true);
  assert.match(lines[0]!, /📅 Tomorrow: “Bluefin review” 10:00 overlaps “Sales sync” 10:30\./);
  assert.match(lines[0]!, /✉️ Not answered yet for tomorrow: “Offsite planning” 14:00\./);
  assert.doesNotMatch(lines[0]!, /Declined|Back to back/);
});

test("tonight and the days off are their own group, labelled with their day: never read as the next working day's", async () => {
  const tonight = loop({ id: "aaaaaaaaa7", title: "Send Ana the deck", dueAt: at("2026-11-26T20:00:00Z") });
  const r = rig({ loops: [tonight, loop({ id: "aaaaaaaaa8", title: "Review the SOW", dueAt: at("2026-11-27T12:00:00Z") })] });
  await r.s.sweep();
  assert.match(r.cards[0]!.body, /Later today:\n1\. Send Ana the deck \(for Ana\) · today 20:00\n\nDue tomorrow:\n2\. Review the SOW/);
  const FRI18 = at("2026-11-27T18:00:00Z");
  const sat = loop({ id: "aaaaaaaaa9", title: "Book the venue", dueAt: at("2026-11-28T12:00:00Z") });
  const p = planShutdown({ loops: [sat, tonight], events: null, now: FRI18, tz: TZ, hours: WORK, quiet: QUIET })!;
  assert.deepEqual(p.later.map((l) => l.id), ["aaaaaaaaa9"]);
  assert.deepEqual(p.next, []);
  const w = rig({ loops: [sat], now: FRI18 });
  await w.s.sweep();
  assert.match(w.cards[0]!.body, /Before Monday:\n1\. Book the venue \(for Ana\) · Sat 12:00/);
});

test("review fixes: a gap inside the week is not its end; next Monday says its date; an old 'due' too", async () => {
  // WORK_DAYS mon,tue,thu,fri: Tuesday's next working day is Thursday — not the week's end.
  const gappy: WorkHours = { ...WORK, days: [1, 2, 4, 5] };
  const TUE18 = at("2026-11-24T18:00:00Z");
  const p = planShutdown({ loops: [loop({ dueAt: at("2026-11-26T12:00:00Z") })], events: null, now: TUE18, tz: TZ, hours: gappy, quiet: QUIET })!;
  assert.equal(p.day, "2026-11-26");
  assert.equal(p.week, undefined);
  // Friday: something due on the Monday after next says its date.
  const FRI18 = at("2026-11-27T18:00:00Z");
  const loops = [
    loop({ id: "aaaaaaaab1", title: "Plan the offsite", dueAt: at("2026-12-04T12:00:00Z") }),
    loop({ id: "aaaaaaaab2", title: "Old contract", kind: "other_promise", who: "Nadia", dueAt: at("2026-11-16T12:00:00Z") }),
  ];
  const lines: string[] = [];
  const s = createShutdown({
    kv: null, timeZone: TZ, now: () => FRI18, config: loadShutdownConfig({}, WORK), hours: WORK, quiet: QUIET, loops: async () => loops,
    roomy: async () => true, card: async () => false, notify: async (x) => (lines.push(x), true), plan: async () => "", done: async () => "",
  });
  assert.equal(await s.sweep(), true);
  assert.match(lines[0]!, /“Plan the offsite”, due Fri 4\./);
  assert.match(lines[0]!, /Nadia: Old contract \(due Mon 16\)/);
});
