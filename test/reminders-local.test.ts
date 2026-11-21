// Apple Reminders as the phone-side copy of the follow-ups (src/reminders-local.ts): what each loop asks of Reminders, a completion on the
// phone closing its loop through the Done button's own press, a date moved there moving the loop, a loop closed, parked or snoozed here
// changing its reminder, nothing outside Pako's lists (or without a loop's tag) ever touched, and a round whose changes were made answering
// nothing. The engine is the real one, on a store in memory; the Mac app is played by the test's pushes.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createControl } from "../src/control.ts";
import { createFollowups, FOLLOWUPS_KEY, type Loop } from "../src/followups.ts";
import {
  createRemindersStore, dueOf, emptyMirror, loopUrl, type Mirror, mountRemindersPanel, notesOf, type Op, pushOf, reconcile, REMINDERS_KEY, type Seen,
} from "../src/reminders-local.ts";
import { APP, auth, memoryKv, serve } from "./helpers/connect-rig.ts";

const TZ = "Europe/Madrid";
const NOW = Date.parse("2026-11-16T08:00:00Z"); // 09:00 in Madrid
const HOUR = 3600_000;
const LISTS = { owe: "list-owe", waiting: "list-wait" };

const loop = (id: string, o: Partial<Loop> = {}): Loop => ({
  id, kind: "owner_promise", title: `Send Ana the deck ${id}`, detail: "She asked twice in the meeting.", who: "Ana", where: { type: "slack_dm", label: "Ana (private)" },
  whenSaid: NOW - HOUR, dueAt: NOW + 8 * HOUR, check: { none: { reason: "a mail" } }, status: "open", nextCheckAt: NOW + 6 * HOUR, nudges: 0, createdAt: NOW - HOUR,
  sources: [{ kind: "slack", label: "Slack · Ana (private)", at: NOW - HOUR, ref: "1.2" }], ...o,
});
const A = "a000000001";
const B = "b000000002";
const C = "c000000003";

/** The reminder the app would read back after making `op` (a create) as asked. */
const made = (op: Op, id: string, o: Partial<Seen> = {}): Seen => {
  assert.equal(op.op, "create");
  const c = op as Extract<Op, { op: "create" }>;
  return { id, list: c.list, loop: c.loop, title: c.title, due: c.due, completed: false, modified: NOW, ...o };
};
const push = (reminders: Seen[], o: Partial<{ on: boolean; access: string; lists: Partial<typeof LISTS> }> = {}) =>
  ({ on: true, access: "granted", lists: LISTS, reminders, ...o });
const round = (loops: Loop[], mirror: Mirror, reminders: Seen[], at = NOW) =>
  reconcile({ loops, mirror, push: push(reminders), now: at, timeZone: TZ });

test("each open loop asks for one reminder: its title, its time, who and where, the line it came from and its tag; never what was said", () => {
  const l = loop(A);
  const r = round([l, loop(B, { kind: "other_promise", who: "Kenji", title: "Kenji sends the estimates" })], emptyMirror(), []);
  assert.deepEqual(r.actions, []);
  assert.equal(r.ops.length, 2);
  const [own, theirs] = r.ops as Extract<Op, { op: "create" }>[];
  assert.deepEqual({ ...own!, notes: undefined }, {
    op: "create", loop: A, list: "owe", title: l.title, due: l.dueAt, notes: undefined, url: `pako://loop/${A}`,
  });
  assert.equal(own!.notes, notesOf(l, TZ));
  assert.match(own!.notes, /^You told Ana you would\.\nWhere: Ana \(private\)\nFrom Slack · Ana \(private\), 16 Nov,? 08:00\n.*\[pako:a000000001\]$/);
  assert.doesNotMatch(own!.notes, /asked twice/, "the loop's detail (the words said) stays in Pako");
  assert.equal(theirs!.list, "waiting");
  assert.match(theirs!.notes, /^Kenji said they would\./);
  assert.equal(loopUrl(A), "pako://loop/a000000001");
  // "Pako: waiting on" turned off: only what the owner owes.
  const off = round([l, loop(B, { kind: "other_promise" })], { ...emptyMirror(), waiting: false }, []);
  assert.deepEqual(off.ops.map((o) => (o as { loop: string }).loop), [A]);
  // A loop whose time passed hours ago, a closed one and a parked one ask for nothing.
  const quiet = round([loop(A, { dueAt: NOW - 7 * HOUR }), loop(B, { status: "done", closedAt: NOW }), loop(C, { status: "parked", parkedAt: NOW })], emptyMirror(), []);
  assert.deepEqual(quiet.ops, []);
});

test("a round whose changes were made answers nothing, again and again: no round trip without an end", () => {
  const loops = [loop(A), loop(B, { kind: "other_promise" })];
  const first = round(loops, emptyMirror(), []);
  const seen = first.ops.map((op, i) => made(op, `r${i}`));
  let m = round(loops, first.mirror, seen).mirror;
  for (let i = 0; i < 5; i++) {
    const r = round(loops, m, seen, NOW + i * 60_000);
    assert.deepEqual(r.ops, [], `round ${i}`);
    assert.deepEqual(r.actions, []);
    m = r.mirror;
  }
  assert.equal(m.items[A]!.rid, "r0");
  assert.equal(m.items[B]!.list, "waiting");
});

test("completed on the phone: the loop is Done through the Done button's press; un-completed, it is open again; Pako's own close completes it", async () => {
  const kv = memoryKv();
  const engine = createFollowups({
    config: { delayMs: 60_000, maxPerDay: 6, batchMs: 60_000, quiet: null }, kv, timeZone: TZ, now: () => NOW,
    enqueue: async () => true, card: async () => true, notify: async () => undefined,
  });
  await kv.set(FOLLOWUPS_KEY, JSON.stringify({ loops: [loop(A), loop(B)] }), 60);
  const store = createRemindersStore(kv);
  let pressed: string[] = [];
  const p = await serve((app) => mountRemindersPanel(app, {
    ...auth, store, timeZone: TZ, lang: () => "en", now: () => NOW,
    loops: () => ({
      loops: async () => (await engine.read()).loops,
      done: (id) => (pressed.push(id), engine.press("1", id)),
      reopen: (id) => engine.reopen([id]),
      moveDue: (id, at) => engine.moveDue(id, at),
    }),
  }));
  try {
    const first = await p.post("/panel/api/reminders/local", push([]), APP);
    assert.equal(first.status, 200);
    assert.equal(first.body.zone, TZ);
    assert.deepEqual(first.body.ops.map((o: Op) => o.op), ["create", "create"]);
    const seen = (first.body.ops as Op[]).map((op, i) => made(op, `r${i}`));
    assert.deepEqual((await p.post("/panel/api/reminders/local", push(seen), APP)).body.ops, []);
    // The owner ticks A on their Watch.
    seen[0] = { ...seen[0]!, completed: true, modified: NOW + 60_000 };
    const done = await p.post("/panel/api/reminders/local", push(seen), APP);
    assert.deepEqual(done.body.ops, [], "nothing asked back of the reminder");
    assert.deepEqual(pressed, [A], "the Done button's own press");
    const a = (await engine.read()).loops.find((l) => l.id === A)!;
    assert.equal(a.status, "done");
    assert.deepEqual((await p.post("/panel/api/reminders/local", push(seen), APP)).body.ops, [], "and it stays agreed");
    assert.equal(pressed.length, 1, "pressed once");
    // Un-ticked on the phone: open again.
    seen[0] = { ...seen[0]!, completed: false, modified: NOW + 120_000 };
    await p.post("/panel/api/reminders/local", push(seen), APP);
    assert.equal((await engine.read()).loops.find((l) => l.id === A)!.status, "open");
    // Pako closes B (the chat said it is handled): its reminder is completed, once.
    pressed = [];
    await engine.press("1", B);
    const closed = await p.post("/panel/api/reminders/local", push(seen), APP);
    assert.deepEqual(closed.body.ops, [{ op: "update", id: "r1", loop: B, completed: true }]);
    seen[1] = { ...seen[1]!, completed: true };
    assert.deepEqual((await p.post("/panel/api/reminders/local", push(seen), APP)).body.ops, []);
    assert.deepEqual(pressed, [], "Pako's own close is not pressed again");
    // The panel's card.
    const card = await p.get("/panel/api/reminders");
    assert.deepEqual({ ...card.body, at: null }, { on: true, at: null, stale: false, access: "granted", waiting: true, owe: 1, theirs: 0 });
    assert.equal((await p.post("/panel/api/reminders/local", { nope: true }, APP)).status, 400);
    assert.equal((await p.post("/panel/api/reminders/local", push([]), {})).status, 401);
  } finally {
    await p.close();
  }
});

test("paused (STOP): the Mac is asked for no change and a tick on the phone changes no loop; after RESUME both catch up", async () => {
  const kv = memoryKv();
  const engine = createFollowups({
    config: { delayMs: 60_000, maxPerDay: 6, batchMs: 60_000, quiet: null }, kv, timeZone: TZ, now: () => NOW,
    enqueue: async () => true, card: async () => true, notify: async () => undefined,
  });
  await kv.set(FOLLOWUPS_KEY, JSON.stringify({ loops: [loop(A)] }), 60);
  const control = createControl(memoryKv(), () => NOW);
  const pressed: string[] = [];
  const p = await serve((app) => mountRemindersPanel(app, {
    ...auth, store: createRemindersStore(kv), timeZone: TZ, lang: () => "en", now: () => NOW, control,
    loops: () => ({
      loops: async () => (await engine.read()).loops,
      done: (id) => (pressed.push(id), engine.press("1", id)),
      reopen: (id) => engine.reopen([id]),
      moveDue: (id, at) => engine.moveDue(id, at),
    }),
  }));
  try {
    await control.setPaused(true, NOW);
    const first = await p.post("/panel/api/reminders/local", push([]), APP);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.ops, [], "paused: no reminder is made");
    await control.setPaused(false, NOW);
    const ops = (await p.post("/panel/api/reminders/local", push([]), APP)).body.ops as Op[];
    assert.deepEqual(ops.map((o) => o.op), ["create"], "after RESUME it is made");
    const seen = [made(ops[0]!, "r0")];
    assert.deepEqual((await p.post("/panel/api/reminders/local", push(seen), APP)).body.ops, []);
    await control.setPaused(true, NOW);
    seen[0] = { ...seen[0]!, completed: true, modified: NOW + 60_000 };
    assert.deepEqual((await p.post("/panel/api/reminders/local", push(seen), APP)).body.ops, []);
    assert.deepEqual(pressed, [], "paused: the tick changes no loop yet");
    assert.equal((await engine.read()).loops[0]!.status, "open");
    await control.setPaused(false, NOW);
    await p.post("/panel/api/reminders/local", push(seen), APP);
    assert.deepEqual(pressed, [A], "after RESUME the tick closes it");
  } finally {
    await p.close();
  }
});

test("a completion the loops' store could not keep is not agreed: the next round does not undo the owner's tick", async () => {
  const kv = memoryKv();
  let broken = false;
  const set = kv.set;
  // The follow-ups' record cannot be written for a moment (a disk full, the database busy); the reminders' own record still can.
  kv.set = async (k, v, ttl) => {
    if (broken && k === FOLLOWUPS_KEY) throw new Error("disk full");
    return set(k, v, ttl);
  };
  const engine = createFollowups({
    config: { delayMs: 60_000, maxPerDay: 6, batchMs: 60_000, quiet: null }, kv, timeZone: TZ, now: () => NOW,
    enqueue: async () => true, card: async () => true, notify: async () => undefined,
  });
  await kv.set(FOLLOWUPS_KEY, JSON.stringify({ loops: [loop(A)] }), 60);
  const store = createRemindersStore(kv);
  const p = await serve((app) => mountRemindersPanel(app, {
    ...auth, store, timeZone: TZ, lang: () => "en", now: () => NOW,
    loops: () => ({
      loops: async () => (await engine.read()).loops, done: (id) => engine.press("1", id), reopen: (id) => engine.reopen([id]),
      moveDue: (id, at) => engine.moveDue(id, at),
    }),
  }));
  try {
    const first = await p.post("/panel/api/reminders/local", push([]), APP);
    const seen = (first.body.ops as Op[]).map((op, i) => made(op, `r${i}`));
    await p.post("/panel/api/reminders/local", push(seen), APP);
    seen[0] = { ...seen[0]!, completed: true, modified: NOW + 60_000 };
    broken = true;
    await p.post("/panel/api/reminders/local", push(seen), APP);
    broken = false;
    assert.equal((await engine.read()).loops[0]!.status, "open", "the press could not be kept");
    const next = await p.post("/panel/api/reminders/local", push(seen), APP);
    assert.deepEqual(next.body.ops, [], "the owner's tick is not taken back");
    assert.equal((await engine.read()).loops[0]!.status, "done", "the next round closes it");
  } finally {
    await p.close();
  }
});

test("a date moved in Reminders moves the loop (a date with no time is 09:00 there); a time moved here re-dates the reminder", async () => {
  const kv = memoryKv();
  let t = NOW;
  const engine = createFollowups({
    config: { delayMs: 60_000, maxPerDay: 6, batchMs: 60_000, quiet: null }, kv, timeZone: TZ, now: () => t,
    enqueue: async () => true, card: async () => true, notify: async () => undefined,
  });
  await kv.set(FOLLOWUPS_KEY, JSON.stringify({ loops: [loop(A, { tz: "America/New_York" })] }), 60);
  const ports = { loops: async () => (await engine.read()).loops, done: (id: string) => engine.press("1", id),
    reopen: (id: string) => engine.reopen([id]), moveDue: (id: string, at: number | null) => engine.moveDue(id, at) };
  const store = createRemindersStore(kv);
  const p = await serve((app) => mountRemindersPanel(app, { ...auth, store, timeZone: TZ, lang: () => "en", now: () => t, loops: () => ports }));
  try {
    const first = await p.post("/panel/api/reminders/local", push([]), APP);
    const seen = [made(first.body.ops[0], "r0")];
    await p.post("/panel/api/reminders/local", push(seen), APP);
    // Friday at 18:00 on the phone.
    const friday = Date.parse("2026-11-20T17:00:00Z");
    seen[0] = { ...seen[0]!, due: friday, modified: NOW + 60_000 };
    assert.deepEqual((await p.post("/panel/api/reminders/local", push(seen), APP)).body.ops, []);
    let a = (await engine.read()).loops[0]!;
    assert.equal(a.dueAt, friday);
    assert.equal(a.tz, undefined, "the time the owner set is in their own zone");
    assert.ok(a.nextCheckAt > NOW && a.nextCheckAt < friday, "looked at again before its new time");
    // A date with no time, as the app sends it: 09:00 that day in the owner's zone.
    const raw = { ...push([]), reminders: [{ id: "r0", list: "owe", loop: A, title: a.title, due: "2026-11-21", completed: false, modified: NOW + 120_000 }] };
    assert.equal(pushOf(raw, TZ)!.reminders[0]!.due, Date.parse("2026-11-21T08:00:00Z"));
    await p.post("/panel/api/reminders/local", raw, APP);
    a = (await engine.read()).loops[0]!;
    assert.equal(a.dueAt, Date.parse("2026-11-21T08:00:00Z"));
    // Pako moves it (the meeting it is due at moved): the reminder follows.
    seen[0] = { ...seen[0]!, due: Date.parse("2026-11-21T08:00:00Z") };
    await p.post("/panel/api/reminders/local", push(seen), APP);
    await engine.moveDue(A, Date.parse("2026-11-23T10:00:00Z"));
    t = NOW + 10 * 60_000;
    const back = await p.post("/panel/api/reminders/local", push(seen), APP);
    assert.deepEqual(back.body.ops, [{ op: "update", id: "r0", loop: A, due: Date.parse("2026-11-23T10:00:00Z") }]);
  } finally {
    await p.close();
  }
});

test("both sides moved the time: the newer change wins", () => {
  const l = loop(A);
  const first = round([l], emptyMirror(), []);
  const seen = [made(first.ops[0]!, "r0")];
  const m = round([l], first.mirror, seen).mirror;
  // The loop moved (a check at NOW + 1 h saw the meeting move) and the owner moved the reminder: at NOW + 2 h they win, at NOW + 30 min Pako does.
  const moved = { ...l, dueAt: NOW + 20 * HOUR, checkedAt: NOW + HOUR };
  const later = round([moved], m, [{ ...seen[0]!, due: NOW + 30 * HOUR, modified: NOW + 2 * HOUR }], NOW + 3 * HOUR);
  assert.deepEqual(later.actions, [{ do: "due", id: A, at: NOW + 30 * HOUR }]);
  assert.deepEqual(later.ops, []);
  const earlier = round([moved], m, [{ ...seen[0]!, due: NOW + 30 * HOUR, modified: NOW + HOUR / 2 }], NOW + 3 * HOUR);
  assert.deepEqual(earlier.actions, []);
  assert.deepEqual(earlier.ops, [{ op: "update", id: "r0", loop: A, due: NOW + 20 * HOUR }]);
});

test("parked: its reminder is removed; snoozed past its time: re-dated; deleted by the owner: not made again; its title follows Pako's", () => {
  const base = [loop(A), loop(B), loop(C)];
  const first = round(base, emptyMirror(), []);
  const seen = first.ops.map((op, i) => made(op, `r${i}`));
  const m = round(base, first.mirror, seen).mirror;
  const snoozedUntil = NOW + 20 * HOUR;
  const now = [loop(A, { status: "parked", parkedAt: NOW }), loop(B, { status: "snoozed", nextCheckAt: snoozedUntil }), loop(C, { title: "Send Ana the new deck" })];
  const r = round(now, m, seen);
  assert.deepEqual(r.ops, [
    { op: "remove", id: "r0", loop: A },
    { op: "update", id: "r1", loop: B, due: snoozedUntil },
    { op: "update", id: "r2", loop: C, title: "Send Ana the new deck" },
  ]);
  assert.equal(dueOf(loop(B, { status: "snoozed", nextCheckAt: NOW + HOUR })), NOW + 8 * HOUR, "a snooze before its time leaves the time");
  assert.equal(r.mirror.items[A], undefined);
  // The owner renamed C's reminder on the phone: kept as they wrote it.
  const renamed = round(base, m, [seen[0]!, seen[1]!, { ...seen[2]!, title: "Deck for Ana!" }]);
  assert.deepEqual(renamed.ops, []);
  // The owner deleted B's reminder: B is not made again, and the loop is untouched.
  const gone = round(base, m, [seen[0]!, seen[2]!]);
  assert.deepEqual(gone.ops, []);
  assert.deepEqual(gone.actions, []);
  assert.equal(gone.mirror.items[B]!.gone, true);
  assert.deepEqual(round(base, gone.mirror, [seen[0]!, seen[2]!]).ops, [], "still not made again");
  // Pako's list itself made anew (the owner deleted the list): everything in it again.
  const fresh = reconcile({ loops: base, mirror: gone.mirror, push: push([], { lists: { owe: "list-new", waiting: "list-wait" } }), now: NOW, timeZone: TZ });
  assert.deepEqual(fresh.ops.map((o) => o.op), ["create", "create", "create"]);
});

test("never outside Pako's lists, never a reminder without a loop's tag, never one of a loop this Pako does not know; twins removed", () => {
  const l = loop(A);
  const raw = {
    on: true, access: "granted", lists: { owe: "list-owe" },
    reminders: [
      { id: "mine", list: "owe", title: "Buy milk", due: null, completed: false },
      { id: "elsewhere", list: "groceries", loop: A, title: "x", completed: false },
      { id: "other-list", list: "waiting", loop: A, title: "x", completed: false },
      { id: "stranger", list: "owe", loop: "ffffffffff", title: "Another computer's", completed: false },
      { id: "r0", list: "owe", loop: A, title: l.title, due: l.dueAt, completed: false },
      { id: "r0-twin", list: "owe", loop: A, title: l.title, due: l.dueAt, completed: false },
      { id: "bad-tag", list: "owe", loop: "../../x", title: "x", completed: false },
    ],
  };
  const p = pushOf(raw, TZ)!;
  assert.deepEqual(p.reminders.map((r) => r.id), ["mine", "stranger", "r0", "r0-twin", "bad-tag"], "only Pako's lists the app named");
  assert.equal(p.reminders.find((r) => r.id === "bad-tag")!.loop, undefined);
  const r = reconcile({ loops: [l], mirror: emptyMirror(), push: p, now: NOW, timeZone: TZ });
  const touched = r.ops.map((o) => ("id" in o ? o.id : `create:${o.loop}`));
  assert.deepEqual(touched, ["r0-twin"], "only the twin, which carries the loop's tag");
  for (const id of ["mine", "stranger", "bad-tag"]) assert.ok(!touched.includes(id), id);
  assert.equal(pushOf({ reminders: [] }, TZ), null, "no on/off: not a push");
});

test("without access, or turned off, nothing is changed and nothing taken for deleted; turning it off forgets the agreement, not the setting", () => {
  const l = loop(A);
  const first = round([l], emptyMirror(), []);
  const m = round([l], first.mirror, [made(first.ops[0]!, "r0")]).mirror;
  const denied = reconcile({ loops: [l], mirror: { ...m, waiting: false }, push: push([], { access: "denied" }), now: NOW, timeZone: TZ });
  assert.deepEqual(denied.ops, []);
  assert.equal(denied.mirror.items[A]!.gone, undefined, "an empty read without access is not a deletion");
  assert.equal(denied.mirror.access, "denied");
  const off = reconcile({ loops: [l], mirror: { ...m, waiting: false }, push: push([], { on: false }), now: NOW, timeZone: TZ });
  assert.deepEqual(off.ops, []);
  assert.deepEqual(off.mirror.items, {});
  assert.equal(off.mirror.on, false);
  assert.equal(off.mirror.waiting, false, "the owner's setting stays");
});

test("an op the Mac keeps failing is asked for five times, then left until something changes", () => {
  const l = loop(A, { status: "done", closedAt: NOW });
  const open = loop(A);
  const first = round([open], emptyMirror(), []);
  const seen = [made(first.ops[0]!, "r0")];
  let m = round([open], first.mirror, seen).mirror;
  const asked: number[] = [];
  for (let i = 0; i < 8; i++) {
    const r = round([l], m, seen, NOW + i * 60_000);
    asked.push(r.ops.length);
    m = r.mirror;
  }
  assert.deepEqual(asked, [1, 1, 1, 1, 1, 0, 0, 0]);
  // It went through at last: agreed, and counted from nothing again.
  const ok = round([l], m, [{ ...seen[0]!, completed: true }]);
  assert.deepEqual(ok.ops, []);
  assert.equal(ok.mirror.items[A]!.tries, undefined);
});

test("the settings route keeps \"waiting on\" and the forget empties the record", async () => {
  const kv = memoryKv();
  const store = createRemindersStore(kv);
  const p = await serve((app) => mountRemindersPanel(app, { ...auth, store, timeZone: TZ, lang: () => "en", now: () => NOW, loops: () => null }));
  try {
    assert.equal((await p.post("/panel/api/reminders/settings", { waiting: "no" })).status, 400);
    assert.deepEqual((await p.post("/panel/api/reminders/settings", { waiting: false })).body, { ok: true, waiting: false });
    assert.equal((await store.read()).waiting, false);
    // No follow-ups running: a push is kept as "on" and asks nothing.
    assert.deepEqual((await p.post("/panel/api/reminders/local", push([]), APP)).body, { ok: true, on: true, waiting: false, zone: TZ, ops: [] });
    await store.forget();
    assert.equal(kv.data.get(REMINDERS_KEY), "");
    assert.equal((await store.read()).waiting, true, "forgotten: back to the default");
  } finally {
    await p.close();
  }
});
