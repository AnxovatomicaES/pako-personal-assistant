import assert from "node:assert/strict";
import { test } from "node:test";
import { createBooking } from "../src/booking.ts";

test("a date that does not exist (31 November) is not called the hour skipped by the clock change", () => {
  const b = createBooking({ engine: {} as any, kv: null, ownerName: "Ana", timeZone: "Europe/Madrid", now: () => Date.parse("2026-11-16T10:00:00Z") });
  const why = b.check({ what: "italiano en Gràcia", when: "2026-11-31 21:00", party: 2 });
  assert.doesNotMatch(why ?? "", /clocks skip it/, `told: ${why}`);
});

test("the hour really skipped by the clock change is still called that; 30 February and 25:00 are not", () => {
  const b = createBooking({ engine: {} as any, kv: null, ownerName: "Ana", timeZone: "Europe/Madrid", now: () => Date.parse("2027-03-20T10:00:00Z") });
  assert.match(b.check({ what: "italiano", when: "2027-03-28 02:30", party: 2 }) ?? "", /clocks skip it/);
  assert.doesNotMatch(b.check({ what: "italiano", when: "2027-02-30 21:00", party: 2 }) ?? "", /clocks skip it/);
  assert.doesNotMatch(b.check({ what: "italiano", when: "2027-03-29 25:00", party: 2 }) ?? "", /clocks skip it/);
});
