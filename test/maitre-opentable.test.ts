// What OpenTable's details and confirmation pages say about the day, the time and the party (read without a browser): the cartridge books
// only when the page shows what was asked for, and the confirmation's own day, time and party are read back so the planner can compare them.

import assert from "node:assert/strict";
import test from "node:test";
import { factsOf } from "../src/maitre/cartridges/opentable.ts";

test("maitre opentable: the day, time and party are read in the forms of the English and Spanish pages", () => {
  const f = (text: string) => factsOf(text, "2026-11-27");
  assert.deepEqual(f("Saturday, November 28 · 9:00 PM · 2 people"), { dates: ["2026-11-28"], times: ["21:00"], parties: [2] });
  assert.deepEqual(f("Fri, 27 Nov · 21:00 · Table for 4"), { dates: ["2026-11-27"], times: ["21:00"], parties: [4] });
  assert.deepEqual(f("viernes, 27 de noviembre · 21h00 · 2 personas"), { dates: ["2026-11-27"], times: ["21:00"], parties: [2] });
  assert.deepEqual(f("Reserved 2026-11-27 at 9 pm, party size: 3. Free cancellation until 7:00 PM"), { dates: ["2026-11-27"], times: ["21:00", "19:00"], parties: [3] });
  // A day without its year is the one nearest the day asked for: across New Year too.
  assert.deepEqual(factsOf("Saturday, January 2 · 9:00 PM", "2026-12-30").dates, ["2027-01-02"]);
  // A time written next to a day is not a day; a size is not a time.
  assert.deepEqual(f("Friday, November 27 20:30 for 2 people").dates, ["2026-11-27"]);
  assert.deepEqual(f("Nothing free on this day"), { dates: [], times: [], parties: [] });
});

test("maitre opentable: another day on the page is not the day asked for", () => {
  const shown = factsOf("Saturday, November 28 · 9:00 PM · 2 people", "2026-11-27");
  assert.equal(shown.dates.includes("2026-11-27"), false);
  assert.equal(shown.times.includes("21:00") && shown.parties.includes(2), true, "time and party alone say nothing about the day");
});
