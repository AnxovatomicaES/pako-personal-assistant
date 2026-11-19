// The panel's agenda (src/panel/app.js) puts each event on its day in the owner's time zone: whatever the browser's own zone (an owner
// abroad), and on the nights the clocks change (a day of 23 or 25 hours). The page's own functions, as the browser runs them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/panel/app.js", import.meta.url), "utf8");
/** A `const name = ...;` that ends at the first line ending in ";" (or "};" for a block). */
const decl = (start: string, end = ";\n") => {
  const i = src.indexOf(start);
  assert.ok(i >= 0, `${start} is in app.js`);
  return src.slice(i, src.indexOf(end, i) + end.length);
};
const fn = (name: string) => new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`).exec(src)![0];

type Page = { dayKey: (at: number) => string; dayAt: (i: number) => number; eventsOn: (key: string) => unknown[] };
function page(data: unknown, now: number): Page {
  const code = [decl("const tz = () =>"), decl("const partsOf ="), decl("const dayKey =", "};\n"), decl("const hourOf =", "};\n"),
    decl("const dayAt =", "};\n"), fn("eventsOn")].join("\n");
  return new Function("data", "nowMs", `${code}\nreturn { dayKey, dayAt, eventsOn };`)(data, () => now) as Page;
}

test("an all-day event shows on its own day in the owner's zone only, with the browser in another zone", () => {
  const before = process.env.TZ;
  process.env.TZ = "America/New_York"; // the owner (Madrid) with the panel open on a laptop in New York
  try {
    // 20 Nov in Madrid, as src/ics.ts gives it (midnight to midnight there); and a three-day one, 20 to 22 Nov.
    const one = { id: "a", title: "Holiday", allDay: true, start: Date.UTC(2026, 10, 19, 23), end: Date.UTC(2026, 10, 20, 23) };
    const three = { id: "b", title: "Trip", allDay: true, start: Date.UTC(2026, 10, 19, 23), end: Date.UTC(2026, 10, 22, 23) };
    const p = page({ timeZone: "Europe/Madrid", events: [one, three] }, one.start);
    const on = (key: string) => (p.eventsOn(key) as { id: string }[]).map((e) => e.id).sort();
    assert.deepEqual(on("2026-11-19"), [], "not on the day before");
    assert.deepEqual(on("2026-11-20"), ["a", "b"]);
    assert.deepEqual(on("2026-11-21"), ["b"]);
    assert.deepEqual(on("2026-11-22"), ["b"]);
    assert.deepEqual(on("2026-11-23"), [], "not on the day it ends at midnight");
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});

test("tomorrow and the week are the next days on the nights the clocks change, never today again or a day skipped", () => {
  const week = (now: number) => {
    const p = page({ timeZone: "Europe/Madrid", events: [] }, now);
    return [0, 1, 2, 3, 4, 5, 6].map((i) => p.dayKey(p.dayAt(i)));
  };
  // 25 Oct 2026 at 00:30 in Madrid: that day has 25 hours.
  assert.deepEqual(week(Date.UTC(2026, 9, 24, 22, 30)), ["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31"]);
  // Saturday 27 Mar 2027 at 23:30 in Madrid: the next day has 23 hours.
  assert.deepEqual(week(Date.UTC(2027, 2, 27, 22, 30)), ["2027-03-27", "2027-03-28", "2027-03-29", "2027-03-30", "2027-03-31", "2027-04-01", "2027-04-02"]);
  // An ordinary afternoon.
  assert.deepEqual(week(Date.UTC(2026, 10, 16, 15)).slice(0, 2), ["2026-11-16", "2026-11-17"]);
  assert.match(src, /const key = dayKey\(dayAt\(Number\(day\)\)\);/, "the day tabs use it");
  assert.match(src, /const at = dayAt\(i\);/, "the week uses it");
});
