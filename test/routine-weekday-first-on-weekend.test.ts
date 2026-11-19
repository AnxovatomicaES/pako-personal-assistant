import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoutines } from "../src/routines.ts";

test("a weekday routine whose first time is a Saturday does not run on that Saturday", async () => {
  const clock = { now: Date.parse("2026-11-20T19:00:00Z") }; // Friday 20:00 Madrid
  const queued: string[] = [];
  const r = createRoutines({ kv: null, timeZone: "Europe/Madrid", now: () => clock.now, enqueue: async (m) => (queued.push(m.id), true), notify: async () => undefined });
  const out = await r.addRoutine({ at: "2026-11-21 09:00", every: "weekday", text: "dime la agenda del día" }); // Saturday
  assert.ok(out.added);
  clock.now = Date.parse("2026-11-21T08:00:30Z"); // Saturday 09:00:30 Madrid
  await r.tick();
  assert.deepEqual(queued, [], "ran on a Saturday although it is every weekday (Monday to Friday)");
});

test("it starts on the Monday after, at the same hour", async () => {
  const clock = { now: Date.parse("2026-11-20T19:00:00Z") };
  const queued: string[] = [];
  const r = createRoutines({ kv: null, timeZone: "Europe/Madrid", now: () => clock.now, enqueue: async (m) => (queued.push(m.id), true), notify: async () => undefined });
  const out = await r.addRoutine({ at: "2026-11-21 09:00", every: "weekday", text: "dime la agenda del día" });
  assert.equal(out.added?.next, Date.parse("2026-11-23T08:00:00Z"));
  clock.now = Date.parse("2026-11-23T08:00:30Z"); // Monday 09:00:30 Madrid
  await r.tick();
  assert.equal(queued.length, 1, "runs on Monday");
});

test("a weekday reminder given a Sunday is first on Monday; any other repeat keeps its day", async () => {
  const { firstRepeat } = await import("../src/whatsapp.ts");
  const sunday = Date.parse("2026-11-22T08:00:00Z"); // Sunday 09:00 Madrid
  assert.equal(firstRepeat(sunday, "weekday", "Europe/Madrid"), Date.parse("2026-11-23T08:00:00Z"));
  assert.equal(firstRepeat(sunday, "week", "Europe/Madrid"), sunday);
  assert.equal(firstRepeat(sunday, undefined, "Europe/Madrid"), sunday);
  const friday = Date.parse("2026-11-20T08:00:00Z");
  assert.equal(firstRepeat(friday, "weekday", "Europe/Madrid"), friday);
});
