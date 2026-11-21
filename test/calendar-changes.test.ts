// What changed on the calendar (src/calendar-changes.ts), and what follows from it: the brief's "since your last brief" facts, and the
// follow-ups that move with their meeting or close when an agreed meeting is called off. A failed or empty reading is never a cancellation.
import assert from "node:assert/strict";
import { test } from "node:test";
import { gatherFacts, validateBrief } from "../src/brief-v2.ts";
import type { CalEvent } from "../src/calendar.ts";
import { createCalendarChanges, diffEvents } from "../src/calendar-changes.ts";
import { createFollowups, FOLLOWUPS_KEY } from "../src/followups.ts";
import type { Kv } from "../src/kv.ts";

const H = 3600_000;
const T0 = Date.parse("2026-11-16T07:00:00Z"); // Mon 07:00 London
const ev = (id: string, title: string, start: number, extra: Partial<CalEvent> = {}): CalEvent =>
  ({ id, title, start, end: start + H, allDay: false, calendar: "Work", ...extra });
function memKv() {
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  return { kv, m };
}

test("the first reading is a snapshot; then new, moved and gone are found, and only for what is ahead", async () => {
  const clock = { now: T0 };
  let list: CalEvent[] = [ev("a", "Q4 review with Ana", T0 + 26 * H), ev("b", "Standup", T0 + 3 * H), ev("c", "Lunch with Omar", T0 + 5 * H), ev("old", "Done already", T0 + H)];
  let fail = false;
  const seen: unknown[] = [];
  const cc = createCalendarChanges({ kv: memKv().kv, now: () => clock.now, read: async () => { if (fail) throw new Error("down"); return list; }, onChange: async (c) => void seen.push(c) });
  assert.deepEqual(await cc.tick(), [], "nothing to compare with yet");
  clock.now = T0 + 2 * H; // "Done already" has started: its absence is not a cancellation
  list = [ev("a", "Q4 review with Ana", T0 + 50 * H), ev("b", "Standup", T0 + 3 * H), ev("n", "Call with Stan", T0 + 30 * H), ev("far", "Offsite", T0 + 10 * 24 * H)];
  const changes = await cc.tick();
  assert.deepEqual(changes.map((c) => [c.kind, c.id, c.start - T0, c.was !== undefined ? c.was - T0 : null]), [
    ["moved", "a", 50 * H, 26 * H],
    ["added", "n", 30 * H, null],
    ["cancelled", "c", 5 * H, null],
  ], "an event first seen ten days out only came into the window: not new");
  assert.equal(seen.length, 1);
  fail = true;
  assert.deepEqual(await cc.tick(), [], "a reading that fails changes nothing");
  fail = false;
  list = [];
  assert.deepEqual(await cc.tick(), [], "an empty reading after several events ahead is not taken as cancellations");
  assert.deepEqual((await cc.since(T0)).map((c) => c.id), ["a", "n", "c"]);
  assert.deepEqual(await cc.since(T0 + 3 * H), [], "only what changed after the moment asked");
});

test("diffEvents: a feed that rounds seconds is not a move", () => {
  assert.deepEqual(diffEvents([{ id: "a", title: "x", start: T0 + H, end: T0 + 2 * H }], [{ id: "a", title: "x", start: T0 + H + 30_000, end: T0 + 2 * H }], T0), []);
});

const loop = (id: string, kind: string, title: string, who: string, dueAt: number, check: unknown) => ({
  id, kind, title, detail: "", who, where: { type: "slack_dm", label: `${who} (private)`, channel: "D1" }, whenSaid: T0 - H, dueAt,
  check, status: "open", nextCheckAt: dueAt - 2 * H, nudges: 0, createdAt: T0 - H, sources: [{ kind: "slack", label: `Slack · ${who}`, at: T0 - H }],
});

test("follow-ups: a deliverable due at a meeting moves with it; an agreed meeting called off closes; another tied to a gone meeting says so", async () => {
  const { kv, m } = memKv();
  m.set(FOLLOWUPS_KEY, JSON.stringify({
    loops: [
      loop("c000000001", "owner_promise", "Send Ana the deck before the Q4 review", "Ana", T0 + 26 * H, { none: { reason: "email" } }),
      loop("c000000002", "agreed_meeting", "Lunch with Omar", "Omar", T0 + 5 * H, { calendarEvent: { around: T0 + 5 * H, hints: ["Omar"] } }),
      loop("c000000003", "request_to_owner", "Bring the numbers to the lunch", "Omar", T0 + 5 * H, { none: { reason: "document" } }),
      loop("c000000004", "owner_promise", "Call the bank", "", T0 + 26 * H, { none: { reason: "phone" } }),
    ],
  }));
  const fu = createFollowups({
    config: { delayMs: 600_000, maxPerDay: 6, batchMs: 60_000, quiet: { start: 23 * 60, end: 8 * 60 } },
    kv, timeZone: "Europe/London", now: () => T0, enqueue: async () => true, card: async () => true, notify: async () => undefined,
  });
  const n = await fu.calendarChanged([
    { kind: "moved", title: "Q4 review with Ana", start: T0 + 50 * H, was: T0 + 26 * H },
    { kind: "cancelled", title: "Lunch with Omar", start: T0 + 5 * H },
  ]);
  assert.equal(n, 3);
  const loops = Object.fromEntries((JSON.parse(m.get(FOLLOWUPS_KEY)!).loops as { id: string; status: string; dueAt: number; lastCheck?: string; nextCheckAt: number }[]).map((l) => [l.id, l]));
  assert.equal(loops.c000000001!.dueAt, T0 + 50 * H);
  assert.equal(loops.c000000001!.nextCheckAt, T0 + 48 * H, "reminded two hours before the new time");
  assert.match(loops.c000000001!.lastCheck!, /moved on your calendar/);
  assert.equal(loops.c000000002!.status, "done");
  assert.match(loops.c000000002!.lastCheck!, /called off/);
  assert.equal(loops.c000000003!.status, "open", "what was owed for the lunch may still be owed");
  assert.match(loops.c000000003!.lastCheck!, /no longer on your calendar/);
  assert.equal(loops.c000000004!.dueAt, T0 + 26 * H, "the same time, but nothing ties it to the review: untouched");
});

test("follow-ups: one a server can check, due at a meeting moved earlier, is looked at before its new time (not at the old one)", async () => {
  const { kv, m } = memKv();
  const l = loop("c000000005", "owner_promise", "Answer Ana about the Q4 review agenda", "Ana", T0 + 26 * H, { slackReply: { channel: "D0ANA", afterTs: "1.0" } });
  m.set(FOLLOWUPS_KEY, JSON.stringify({ loops: [{ ...l, nudges: 1, nextCheckAt: T0 + 25 * H }] }));
  const clock = { now: T0 };
  const cards: string[] = [];
  const fu = createFollowups({
    config: { delayMs: 600_000, maxPerDay: 6, batchMs: 60_000, quiet: { start: 23 * 60, end: 8 * 60 } },
    kv, timeZone: "Europe/London", now: () => clock.now, enqueue: async () => true, card: async (b) => (cards.push(b), true), notify: async () => undefined,
    slackHistory: async () => [],
  });
  assert.equal(await fu.calendarChanged([{ kind: "moved", title: "Q4 review with Ana", start: T0 + 6 * H, was: T0 + 26 * H }]), 1);
  const [moved] = (await fu.read()).loops;
  assert.equal(moved!.dueAt, T0 + 6 * H);
  assert.ok(moved!.nextCheckAt > 0 && moved!.nextCheckAt <= T0 + 6 * H, "looked at before the new time");
  clock.now = T0 + 5 * H;
  await fu.tick();
  assert.equal(cards.length, 1, "the nudge near its new time goes");
});

test("follow-ups: an agreed meeting closed because the calendar called it off is listed as closed for you, and can be reopened", async () => {
  const { kv, m } = memKv();
  m.set(FOLLOWUPS_KEY, JSON.stringify({
    loops: [loop("c000000002", "agreed_meeting", "Lunch with Omar", "Omar", T0 + 5 * H, { calendarEvent: { around: T0 + 5 * H, hints: ["Omar"] } })],
  }));
  const fu = createFollowups({
    config: { delayMs: 600_000, maxPerDay: 6, batchMs: 60_000, quiet: null },
    kv, timeZone: "Europe/London", now: () => T0, enqueue: async () => true, card: async () => true, notify: async () => undefined,
  });
  assert.equal(await fu.calendarChanged([{ kind: "cancelled", title: "Lunch with Omar", start: T0 + 5 * H }]), 1);
  const closed = await fu.closedForYou(T0 - H);
  assert.deepEqual(closed.map((c) => c.title), ["Lunch with Omar"], "no close of Pako's is silent");
  assert.match(closed[0]!.why, /called off/);
  assert.equal((await fu.reopenByWords("lunch omar")).ok, true, "a calendar that was wrong can be undone");
});

test("brief: the calendar's changes since the last brief are facts the brief cites; an event moved twice is told at its last place", async () => {
  const g = await gatherFacts({
    timeZone: "Europe/London", lang: "en", now: T0, since: T0 - 12 * H,
    calendarChanges: async (since) => {
      assert.equal(since, T0 - 12 * H);
      return [
        { kind: "moved", id: "a", title: "Q4 review with Ana", start: T0 + 30 * H, was: T0 + 26 * H, at: T0 - 6 * H },
        { kind: "moved", id: "a", title: "Q4 review with Ana", start: T0 + 50 * H, was: T0 + 30 * H, at: T0 - 2 * H },
        { kind: "cancelled", id: "c", title: "Lunch with Omar", start: T0 + 5 * H, at: T0 - H },
      ];
    },
  });
  const c = g.facts.filter((f) => f.kind === "change");
  assert.equal(c.length, 2);
  assert.match(c[0]!.text, /^calendar change since your last brief: MOVED Q4 review with Ana, from .+ to .+/);
  assert.match(c[1]!.text, /GONE Lunch with Omar, which was today 12:00/);
  const doc = validateBrief(JSON.stringify({
    opening: "A quieter Monday.",
    updates: [{ title: "Lunch with Omar is off", tag: "Since your last brief", text: "Lunch with Omar at 12:00 is no longer on your calendar.", sources: [c[1]!.id] }],
  }), g, { now: T0, timeZone: "Europe/London", lang: "en", id: "x" })!;
  assert.equal(doc.updates.length, 1, "a change cited, with its time, holds");
  assert.deepEqual(doc.dayItems, [], "a gone event is never on the day");
});

test("a partial reading (one calendar could not be read) cancels nothing: what it misses stays; what is new or moved is still found", async () => {
  const clock = { now: T0 };
  const both = [ev("m", "Lunch with Omar", T0 + 5 * H), ev("g", "Budget review", T0 + 8 * H)];
  let reading: { events: CalEvent[]; partial: boolean } = { events: both, partial: true };
  const seen: unknown[] = [];
  const cc = createCalendarChanges({ kv: memKv().kv, now: () => clock.now, read: async () => reading, onChange: async (c) => void seen.push(c) });
  assert.deepEqual(await cc.tick(), [], "a partial first reading is not the snapshot");
  reading = { events: both, partial: false };
  assert.deepEqual(await cc.tick(), [], "the first full one is");
  // The second calendar's token failed for one reading: only the other's events come back, one of them moved, one new.
  reading = { events: [{ ...both[1]!, start: T0 + 9 * H, end: T0 + 10 * H }, ev("n", "Call with Stan", T0 + 30 * H)], partial: true };
  assert.deepEqual((await cc.tick()).map((c) => [c.kind, c.id]), [["moved", "g"], ["added", "n"]], "a meeting of the calendar that failed is not cancelled");
  assert.ok(!seen.flat().some((c) => (c as { kind: string }).kind === "cancelled"), "the follow-ups are not told of a cancellation");
  reading = { events: [both[0]!, { ...both[1]!, start: T0 + 9 * H, end: T0 + 10 * H }, ev("n", "Call with Stan", T0 + 30 * H)], partial: false };
  assert.deepEqual(await cc.tick(), [], "back again: nothing new either");
  reading = { events: [{ ...both[1]!, start: T0 + 9 * H, end: T0 + 10 * H }, ev("n", "Call with Stan", T0 + 30 * H)], partial: false };
  assert.deepEqual((await cc.tick()).map((c) => [c.kind, c.id]), [["cancelled", "m"]], "a full reading still finds what is gone");
});
