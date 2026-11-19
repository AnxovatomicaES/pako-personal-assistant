import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoutines } from "../src/routines.ts";

test("two weekly routines, same text and hour, different weekdays: both are made", async () => {
  const T0 = Date.parse("2026-11-14T12:00:00Z"); // Sat
  const r = createRoutines({ kv: null, timeZone: "Europe/Madrid", now: () => T0, enqueue: async () => true, notify: async () => undefined });
  const a = await r.addRoutine({ at: "2026-11-16 09:00", every: "week", text: "pregúntame por el informe" }); // Monday
  const b = await r.addRoutine({ at: "2026-11-19 09:00", every: "week", text: "pregúntame por el informe" }); // Thursday
  assert.ok(a.added, "monday made");
  assert.ok(b.added || b.say, `thursday neither made nor refused: ${JSON.stringify(b)}`);
});

test("monthly routines on the 1st and the 15th are both made; the same one twice is still made once", async () => {
  const T0 = Date.parse("2026-11-14T12:00:00Z");
  const r = createRoutines({ kv: null, timeZone: "Europe/Madrid", now: () => T0, enqueue: async () => true, notify: async () => undefined });
  assert.ok((await r.addRoutine({ at: "2026-12-01 09:00", every: "month", text: "paga el alquiler" })).added);
  assert.ok((await r.addRoutine({ at: "2026-12-15 09:00", every: "month", text: "paga el alquiler" })).added, "the 15th made too");
  assert.deepEqual(await r.addRoutine({ at: "2026-12-15 09:00", every: "month", text: "Paga el alquiler" }), {});
  assert.deepEqual(await r.addRoutine({ at: "2026-11-23 09:00", every: "day", text: "bebe agua" }).then((x) => !!x.added), true);
  assert.deepEqual(await r.addRoutine({ at: "2026-11-24 09:00", every: "day", text: "bebe agua" }), {}, "a daily one on another day is the same");
});
