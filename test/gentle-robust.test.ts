// Gentle mode's bugs, each with the test that failed before its fix: a store that cannot be read never starts a gentle record again empty
// (the next write would save over it), a long-parked item brought back stays, "Later today" after midnight, a check-in for an item parked
// since, the weekly reset letting go of an item parked again since it asked, the dashboard's red "overdue" in gentle mode, durations learnt
// from invitations only, Park pressed twice, and the legacy zone names' countries. Nothing here reaches the network.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CalEvent } from "../src/calendar.ts";
import { createFollowups, FOLLOWUPS_KEY, type Loop } from "../src/followups.ts";
import { createFirstSteps, createTimeAnchors, GENTLE_ANCHORS_KEY, GENTLE_DEFAULTS, GENTLE_STEPS_KEY, GENTLE_WORDS, shameIn, type GentleConfig } from "../src/gentle.ts";
import { CHECKIN_WORDS, CHECKINS_KEY, createCheckIns } from "../src/gentle-checkins.ts";
import { createWeeklyReset, RESET_KEY, RESET_WORDS } from "../src/gentle-reset.ts";
import { BRAIN_DUMPS_KEY, mountDump } from "../src/door/dump.ts";
import { DUMP_WORDS } from "../src/gentle-dump.ts";
import { resetCorruptRecords } from "../src/json-record.ts";
import type { Kv } from "../src/kv.ts";
import { zoneCountry } from "../src/region.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TZ = "Europe/London";
const MON9 = Date.parse("2026-11-23T09:00:00Z");
const QUIET = { start: 23 * 60, end: 8 * 60 };
const ON: GentleConfig = { ...GENTLE_DEFAULTS, on: true };

/** A store whose reads of the keys in `broken` fail (a disk error, a store that does not answer), its writes kept. */
function flakyKv() {
  const m = new Map<string, string>();
  const broken = new Set<string>();
  const kv: Kv = {
    get: async (k) => {
      if (broken.has(k)) throw new Error("the store did not answer");
      return m.get(k) ?? null;
    },
    set: async (k, v) => void m.set(k, v),
  };
  return { kv, m, broken };
}

function fuRig(clock = { now: MON9 }, kv: Kv = flakyKv().kv) {
  const store = { kv };
  const cards: { body: string; buttons: { id: string; title: string }[] }[] = [];
  const engine = createFollowups({
    config: { delayMs: 10 * MIN, maxPerDay: 6, batchMs: 3 * MIN, quiet: QUIET },
    kv, timeZone: TZ, now: () => clock.now, enqueue: async () => true,
    card: async (body, buttons) => (cards.push({ body, buttons }), true), notify: async () => undefined,
    gentle: async () => ({ maxPerDay: 4 }),
  });
  return { clock, store, cards, engine };
}

async function seedLoop(r: ReturnType<typeof fuRig>, title: string, o: Partial<Loop> = {}): Promise<Loop> {
  const l = (await r.engine.fromChat({ title, who: o.who ?? "Ana" }))!;
  const s = await r.engine.read();
  const x = s.loops.find((y) => y.id === l.id)!;
  Object.assign(x, { nextCheckAt: r.clock.now, ...o });
  await r.store.kv.set(FOLLOWUPS_KEY, JSON.stringify(s), 3600);
  return x;
}

const ev = (o: Partial<CalEvent> & { start: number }): CalEvent =>
  ({ id: "e1", title: "Board review", end: o.start + HOUR, allDay: false, calendar: "Work", ...o });

// ---------- a store that cannot be read ----------

test("store: the time anchors' record that cannot be read is never written over (its learnt durations and On it presses stay)", async () => {
  const { kv, m, broken } = flakyKv();
  const kept = JSON.stringify({ sent: [], seen: ["e9@1"], durations: [{ key: "sync weekly", min: 45, at: MON9 - DAY }], measured: ["p0@1"] });
  m.set(GENTLE_ANCHORS_KEY, kept);
  const cards: string[] = [];
  const a = createTimeAnchors({
    kv, timeZone: TZ, now: () => MON9, settings: async () => ON, quiet: null, lastOwner: () => 0,
    events: async () => [ev({ start: MON9 + 10 * MIN, join: "https://zoom.us/j/1" })], card: async (b) => (cards.push(b), true),
  });
  broken.add(GENTLE_ANCHORS_KEY);
  assert.deepEqual(await a.tick(), []);
  assert.equal(await a.pressed("0123456789"), "👍");
  assert.equal(m.get(GENTLE_ANCHORS_KEY), kept, "not saved over");
  assert.deepEqual(cards, [], "nothing sent from a state that could not be read");
});

test("store: the first steps' record that cannot be read is never written over, and no step is asked past the day's allowance", async () => {
  const { kv, m, broken } = flakyKv();
  const day = "2026-11-23";
  const kept = JSON.stringify({ day, n: 3, jobs: [{ id: "0123456789", loop: "a1b2c3d4e5", at: MON9 - HOUR, facts: "What: x" }], asked: [] });
  m.set(GENTLE_STEPS_KEY, kept);
  const jobs: string[] = [];
  const stuck = { id: "b1b2c3d4e5", kind: "owner_promise", title: "Send Ana the deck", detail: "", who: "Ana", where: { type: "chat", label: "chat" },
    whenSaid: MON9 - 3 * DAY, check: { none: { reason: "x" } }, status: "open", nextCheckAt: 0, nudges: 1, createdAt: MON9 - 3 * DAY, sources: [] } as unknown as Loop;
  const steps = createFirstSteps({
    kv, timeZone: TZ, now: () => MON9, settings: async () => ON, loops: async () => [stuck],
    enqueue: async (x) => (jobs.push(x.id), true), setStep: async () => true,
  });
  broken.add(GENTLE_STEPS_KEY);
  await steps.sweep().catch(() => []);
  await steps.result("st:0123456789", '{"step":"x"}').catch(() => null);
  assert.equal(m.get(GENTLE_STEPS_KEY), kept, "not saved over");
  assert.deepEqual(jobs, [], "the day's three were spent: none asked from an empty start");
});

test("store: the check-ins' record that cannot be read is never written over; a new one is refused, said, not kept alone", async () => {
  const { kv, m, broken } = flakyKv();
  const kept = JSON.stringify({ list: [{ id: "0123456789", thing: "the deck", due: MON9 + HOUR, at: MON9 + HOUR, tries: 0, state: "waiting", createdAt: MON9 }], day: "", n: 0 });
  m.set(CHECKINS_KEY, kept);
  const ci = createCheckIns({ kv, timeZone: TZ, now: () => MON9, settings: async () => ON, standardMax: 6, quiet: QUIET, card: async () => true });
  broken.add(CHECKINS_KEY);
  const r = await ci.fromChat({ inMin: 20, thing: "the report" }).catch(() => ({ ok: false, say: "" }));
  assert.equal(r.ok, false);
  assert.ok(r.say, "the owner is told it was not set");
  assert.deepEqual(shameIn(r.say), []);
  await ci.pressed("2", "0123456789").catch(() => "");
  await ci.sweep();
  assert.equal(m.get(CHECKINS_KEY), kept, "not saved over");
  broken.clear();
  assert.deepEqual((await ci.list()).map((c) => c.thing), ["the deck"]);
});

test("store: the weekly reset's record that cannot be read is never written over, and this week's reset is not sent twice", async () => {
  const flaky = flakyKv();
  const r = fuRig({ now: Date.parse("2026-11-23T09:31:00Z") }, flaky.kv);
  await seedLoop(r, "Send Ana the Q4 deck", { whenSaid: r.clock.now - 3 * DAY });
  const cards: string[] = [];
  const reset = createWeeklyReset({
    kv: flaky.kv, timeZone: TZ, now: () => r.clock.now, settings: async () => ON, loops: () => r.engine.open(), parked: () => r.engine.parked(),
    park: async () => true, letGo: async () => true, quiet: QUIET, roomy: async () => true, card: async (b) => (cards.push(b), true),
  });
  const kept = JSON.stringify({
    resets: [{ id: "0123456789", at: r.clock.now - MIN, day: "2026-11-23", items: [], old: [] }],
    focus: { loop: "a1b2c3d4e5", title: "The focus", who: "", at: r.clock.now - MIN }, asked: [], letGo: [{ title: "Old", who: "", parkedAt: 1, at: 2 }],
  });
  flaky.m.set(RESET_KEY, kept);
  flaky.broken.add(RESET_KEY);
  assert.equal(await reset.sweep(), false);
  await reset.pressed("f1", "0123456789").catch(() => null);
  assert.deepEqual(cards, [], "not sent again");
  assert.equal(flaky.m.get(RESET_KEY), kept, "not saved over (the focus and the let-go history stay)");
});

test("store: the brain dumps' record that cannot be read is never written over by the next dump", async () => {
  resetCorruptRecords();
  const { kv, m, broken } = flakyKv();
  const kept = JSON.stringify([{ id: "0123456789", at: MON9 - HOUR, items: [{ kind: "task", text: "Renew the passport", when: "", changes: [] }] }]);
  m.set(BRAIN_DUMPS_KEY, kept);
  const said: string[] = [];
  const door = {
    d: { kv, timeZone: TZ }, now: () => MON9, sendText: async (t: string) => (said.push(t), true), graph: async () => true,
    journal: { record: async () => ({ id: "j1" }) }, act: async (_a: unknown, changes: unknown[]) => void changes.push({ kind: "x" }),
    via: { getStore: () => undefined }, undoNow: async () => undefined,
  };
  const dump = mountDump(door as never);
  broken.add(BRAIN_DUMPS_KEY);
  await dump.brainDump([{ kind: "task", text: "Call the plumber" }], { sources: { owner: ["call the plumber"] } } as never, { outside: false }).catch(() => 0);
  assert.equal(m.get(BRAIN_DUMPS_KEY), kept, "not saved over");
});

// ---------- Parked: bring back ----------

test("bring back: an item parked weeks ago stays on the open list after the next change (it was dropped as a 14-day-old open loop)", async () => {
  const r = fuRig();
  const l = await seedLoop(r, "Renew the passport", { who: "", createdAt: MON9 - 20 * DAY, whenSaid: MON9 - 20 * DAY });
  await r.engine.press("7", l.id);
  assert.equal((await r.engine.unpark({ id: l.id })).ok, true);
  await r.engine.fromChat({ title: "Something new to keep", who: "" });
  const x = (await r.engine.read()).loops.find((y) => y.id === l.id);
  assert.ok(x, "still in the store");
  assert.equal(x.status, "open");
  assert.ok((await r.engine.open()).some((y) => y.id === l.id));
});

test("bring back: an item with its time still ahead is looked at again before it (it was never nudged again)", async () => {
  const r = fuRig();
  const l = await seedLoop(r, "Send Ana the Q4 deck", { dueAt: MON9 + 2 * DAY });
  await r.engine.press("7", l.id);
  await r.engine.unpark({ id: l.id });
  const x = (await r.engine.read()).loops.find((y) => y.id === l.id)!;
  assert.ok(x.nextCheckAt > MON9 && x.nextCheckAt < x.dueAt!, `looked at before its time (${x.nextCheckAt})`);
});

test("park: Park pressed again (another chat's card) keeps when it was first parked", async () => {
  const r = fuRig();
  const l = await seedLoop(r, "Renew the passport", { who: "" });
  await r.engine.press("7", l.id);
  r.clock.now += DAY;
  assert.match(await r.engine.press("7", l.id), /^Parked/);
  assert.equal((await r.engine.read()).loops.find((y) => y.id === l.id)!.parkedAt, MON9);
});

// ---------- Snooze: later today ----------

test("snooze: Later today pressed after midnight, in the quiet hours, is this morning, not the morning after", async () => {
  const r = fuRig({ now: Date.parse("2026-11-24T01:00:00Z") });
  const l = await seedLoop(r, "Book the venue", { who: "Omar" });
  const said = await r.engine.press("5", l.id);
  assert.equal((await r.engine.read()).loops.find((y) => y.id === l.id)!.nextCheckAt, Date.parse("2026-11-24T09:00:00Z"));
  assert.match(said, /around 09:00/);
  assert.doesNotMatch(said, /tomorrow/);
  // In the evening it is still the next morning.
  r.clock.now = Date.parse("2026-11-24T21:30:00Z");
  await r.engine.press("5", l.id);
  assert.equal((await r.engine.read()).loops.find((y) => y.id === l.id)!.nextCheckAt, Date.parse("2026-11-25T09:00:00Z"));
});

// ---------- check-ins ----------

test("check-in: one for a follow-up parked (or closed) since is not asked; it ends quietly", async () => {
  const r = fuRig();
  const cards: string[] = [];
  const ci = createCheckIns({
    kv: r.store.kv, timeZone: TZ, now: () => r.clock.now, settings: async () => ON, standardMax: 6, quiet: QUIET,
    card: async (b) => (cards.push(b), true), loop: async (id) => (await r.engine.open()).find((l) => l.id === id) ?? null,
  });
  const a = await seedLoop(r, "Send Ana the Q4 deck", { whenSaid: MON9 - 3 * DAY });
  const b = await seedLoop(r, "Book the venue", { whenSaid: MON9 - 3 * DAY, who: "Omar" });
  await ci.forLoop(a.id);
  await ci.forLoop(b.id);
  await r.engine.press("7", a.id);
  await r.engine.press("1", b.id);
  r.clock.now += 30 * MIN;
  assert.deepEqual(await ci.sweep(), []);
  assert.deepEqual(cards, [], "no “Started on …?” for an item set aside or done");
  assert.ok((await ci.list()).every((c) => c.state !== "waiting" && c.state !== "brief"), "ended, and not carried to the brief either");
});

// ---------- the weekly reset ----------

test("reset: an item brought back and parked again since it was asked about is not let go a week later (nor by Let them go)", async () => {
  const r = fuRig({ now: Date.parse("2026-11-23T09:31:00Z") });
  const cards: { body: string; buttons: { id: string; title: string }[] }[] = [];
  const reset = createWeeklyReset({
    kv: r.store.kv, timeZone: TZ, now: () => r.clock.now, settings: async () => ON, loops: () => r.engine.open(), parked: () => r.engine.parked(),
    park: async (id) => /^Parked/.test(await r.engine.press("7", id)), letGo: (id) => r.engine.letGo(id), quiet: QUIET, roomy: async () => true,
    card: async (body, buttons) => (cards.push({ body, buttons }), true),
  });
  const p = await seedLoop(r, "Learn the ukulele", { who: "" });
  await r.engine.press("7", p.id);
  const s = await r.engine.read();
  s.loops.find((x) => x.id === p.id)!.parkedAt = r.clock.now - 31 * DAY;
  await r.store.kv.set(FOLLOWUPS_KEY, JSON.stringify(s), 3600);
  await reset.sweep();
  assert.match(cards[0]!.body, /Parked a month ago: “Learn the ukulele”/);
  // The owner brings it back, then parks it again two days later: a fresh parking.
  r.clock.now += DAY;
  await r.engine.unpark({ id: p.id });
  r.clock.now += DAY;
  await r.engine.press("7", p.id);
  const lg = cards[0]!.buttons.find((b) => b.title === "Let them go")!;
  assert.match((await reset.pressed("lg", /:(.+)$/.exec(lg.id)![1]!)).say, /Nothing left/);
  r.clock.now += 6 * DAY;
  await reset.sweep();
  assert.equal((await r.engine.read()).loops.find((x) => x.id === p.id)!.status, "parked", "parked again five days ago: kept");
  assert.deepEqual(await reset.history(), []);
});

// ---------- the dashboard ----------

test("dashboard: in gentle mode the “Things to do” tile never says overdue, nor shows it in red", async () => {
  const model = (await import(new URL("../src/panel/dashboard-model.js", import.meta.url).href)) as Record<string, (...a: any[]) => any>;
  const loops = [{ id: "a", kind: "owner_promise", title: "Send the deck", who: "Ana", status: "open", dueAt: MON9 - HOUR }];
  const std = model.kpiTiles!({ loops, calendarOn: false, events: [] }, MON9, "UTC");
  assert.match(std.owe.foot, /overdue/);
  const gentle = model.kpiTiles!({ loops, calendarOn: false, events: [], gentle: true }, MON9, "UTC");
  assert.deepEqual(shameIn(gentle.owe.foot), [], gentle.owe.foot);
  assert.equal(gentle.owe.warn, false);
  assert.match(gentle.owe.foot, /1/);
});

// ---------- learned durations ----------

test("learned durations: never from meetings only known from an invitation mail", async () => {
  const start = Date.parse("2026-11-18T15:00:00Z");
  const past = [0, 1, 2].map((i) =>
    ev({ id: `p${i}`, title: "Weekly sync", start: start - (i + 1) * DAY, end: start - (i + 1) * DAY + 45 * MIN, invited: "email", response: "needs" }));
  const a = createTimeAnchors({
    kv: flakyKv().kv, timeZone: TZ, now: () => start - 50 * MIN, settings: async () => ON, events: async () => past, quiet: null,
    lastOwner: () => 0, card: async () => true,
  });
  await a.tick();
  assert.equal(await a.usually("Weekly sync"), null);
});

// ---------- words ----------

test("no shame: the words added for these fixes", () => {
  for (const t of [...Object.values(GENTLE_WORDS), ...Object.values(CHECKIN_WORDS), ...Object.values(RESET_WORDS), ...Object.values(DUMP_WORDS)]) {
    assert.deepEqual(shameIn(t), [], t);
  }
});

// ---------- region ----------

test("region: the legacy zone names a computer may still report have their country (Asia/Calcutta is India)", () => {
  const want: [string, string][] = [
    ["Asia/Calcutta", "IN"], ["Asia/Kolkata", "IN"], ["Asia/Saigon", "VN"], ["Asia/Ho_Chi_Minh", "VN"], ["Asia/Katmandu", "NP"],
    ["Asia/Kathmandu", "NP"], ["America/Buenos_Aires", "AR"], ["America/Catamarca", "AR"], ["Asia/Rangoon", "MM"], ["Asia/Dacca", "BD"],
    ["Europe/Kiev", "UA"], ["Europe/Kyiv", "UA"], ["Asia/Ulan_Bator", "MN"], ["Asia/Thimbu", "BT"], ["Asia/Istanbul", "TR"], ["Asia/Tel_Aviv", "IL"],
  ];
  for (const [zone, country] of want) assert.equal(zoneCountry(zone), country, zone);
});

// ---------- product decisions after #199 ----------

/** Looked at again now, as a snoozed one: the next tick nudges it (or folds it). */
async function lookAgain(r: ReturnType<typeof fuRig>, id: string): Promise<void> {
  const s = await r.engine.read();
  Object.assign(s.loops.find((y) => y.id === id)!, { nextCheckAt: r.clock.now, status: "snoozed" });
  await r.store.kv.set(FOLLOWUPS_KEY, JSON.stringify(s), 3600);
}

test("check-in: “Check on me in 30 min” on a nudge is an answer — the unanswered count starts again and the item is not folded", async () => {
  const r = fuRig();
  const ci = createCheckIns({
    kv: r.store.kv, timeZone: TZ, now: () => r.clock.now, settings: async () => ON, standardMax: 6, quiet: QUIET, card: async () => true,
    loop: async (id) => (await r.engine.open()).find((l) => l.id === id) ?? null, engaged: (id) => r.engine.engaged(id),
  });
  const l = await seedLoop(r, "Send Ana the Q4 deck", { whenSaid: MON9 - 3 * DAY });
  await r.engine.tick();
  assert.equal(r.cards.length, 1);
  assert.match(await ci.forLoop(l.id), /check on you/);
  assert.equal((await r.engine.read()).loops.find((y) => y.id === l.id)!.unanswered, undefined, "the press was an answer");
  r.clock.now += HOUR;
  await lookAgain(r, l.id);
  await r.engine.tick();
  r.clock.now += HOUR;
  await lookAgain(r, l.id);
  await r.engine.tick();
  const x = (await r.engine.read()).loops.find((y) => y.id === l.id)!;
  assert.equal(x.folded, undefined, "not folded: only one nudge went unanswered since the owner engaged");
  assert.equal(r.cards.length, 3);
});

test("parked: an item the store drops at 45 days always leaves a note in the Parked history, gentle mode off and no reset run", async () => {
  const r = fuRig();
  const reset = createWeeklyReset({
    kv: r.store.kv, timeZone: TZ, now: () => r.clock.now, settings: async () => null, loops: () => r.engine.open(), parked: () => r.engine.parked(),
    park: async () => true, letGo: (id) => r.engine.letGo(id), quiet: QUIET, roomy: async () => true, card: async () => true,
    expired: () => r.engine.expiredParked(),
  });
  const p = await seedLoop(r, "Learn the ukulele", { who: "Omar" });
  await r.engine.press("7", p.id);
  r.clock.now += 46 * DAY;
  await r.engine.fromChat({ title: "Something new to keep", who: "" });
  assert.ok(!(await r.engine.read()).loops.some((y) => y.id === p.id), "dropped by the store");
  const h = await reset.history();
  assert.equal(h.length, 1);
  assert.equal(h[0]!.title, "Learn the ukulele");
  assert.equal(h[0]!.who, "Omar");
  assert.equal(h[0]!.parkedAt, MON9);
  assert.equal(h[0]!.why, "expired");
  // Kept with the next writes too, once.
  await r.engine.fromChat({ title: "Another one", who: "" });
  assert.equal((await reset.history()).length, 1);
});

test("check-in: Not yet pressed on the same card from two chats counts once", async () => {
  const r = fuRig();
  const cards: { buttons: { id: string }[] }[] = [];
  const ci = createCheckIns({
    kv: r.store.kv, timeZone: TZ, now: () => r.clock.now, settings: async () => ON, standardMax: 6, quiet: QUIET,
    card: async (_b, buttons) => (cards.push({ buttons }), true),
  });
  await ci.fromChat({ inMin: 20, thing: "the deck" });
  r.clock.now += 20 * MIN;
  await ci.sweep();
  const id = /:(.+)$/.exec(cards[0]!.buttons[1]!.id)![1]!;
  const first = await ci.pressed("2", id);
  r.clock.now += MIN;
  const second = await ci.pressed("2", id);
  assert.equal(second, first, "the same answer");
  const c = (await ci.list())[0]!;
  assert.equal(c.tries, 1);
  assert.equal(c.at, MON9 + 20 * MIN + 15 * MIN);
});

test("snooze card after Park: Later today or Tomorrow still brings it back, and the reply says “Brought back from Parked”", async () => {
  const r = fuRig();
  const l = await seedLoop(r, "Book the venue", { who: "Omar" });
  await r.engine.press("7", l.id);
  const said = await r.engine.press("5", l.id);
  assert.match(said, /^Brought back from Parked: “Book the venue”/);
  assert.deepEqual(shameIn(said), []);
  const x = (await r.engine.read()).loops.find((y) => y.id === l.id)!;
  assert.equal(x.status, "snoozed");
  assert.equal(x.parkedAt, undefined);
  await r.engine.press("7", l.id);
  assert.match(await r.engine.press("6", l.id), /^Brought back from Parked: .*tomorrow/);
  // Not parked: as before.
  assert.doesNotMatch(await r.engine.press("5", l.id), /Parked/);
});
