// The brief asked later in the day (RESUMEN at 16:54): meetings already over are counted, not listed as still ahead; the 08:00 brief is as
// before. Overlapping meetings say which meeting and by how much, in both languages, and the written brief gets the overlap as a fact.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrief } from "../src/brief.ts";
import { chatText, createBriefV2, dayItemOver, gatherFacts, validateBrief } from "../src/brief-v2.ts";
import type { CalEvent } from "../src/calendar.ts";
import type { Lang } from "../src/i18n.ts";

const MADRID = "Europe/Madrid";
/** Monday 16 November 2026: 08:00 and 16:54 in Madrid. */
const EIGHT = Date.parse("2026-11-16T07:00:00Z");
const LATE = Date.parse("2026-11-16T15:54:00Z");
const ev = (id: string, title: string, start: string, end: string, more: Partial<CalEvent> = {}): CalEvent => ({
  id, title, start: Date.parse(start), end: Date.parse(end), allDay: false, calendar: "", ...more,
});
/** Today's meetings, 11:00 to 15:30 Madrid, one at 17:30 still ahead, and two that overlap by 45 minutes. */
const DAY: CalEvent[] = [
  ev("a", "Steerco", "2026-11-16T10:00:00Z", "2026-11-16T11:00:00Z"),
  ev("b", "Maya Chen <> Acme", "2026-11-16T12:00:00Z", "2026-11-16T13:00:00Z"),
  ev("c", "Revisión de propuesta", "2026-11-16T12:15:00Z", "2026-11-16T14:30:00Z"),
  ev("d", "Call con Samir", "2026-11-16T16:30:00Z", "2026-11-16T17:00:00Z"),
  ev("h", "Festivo local", "2026-11-15T23:00:00Z", "2026-11-16T23:00:00Z", { allDay: true }),
];

const brief = (t: number, l: Lang, events = DAY) =>
  createBrief({ at: 8 * 60, kv: null, timeZone: MADRID, now: () => t, lang: () => l, notify: async () => undefined, calendars: [async () => events] });

test("old brief at 08:00: every meeting of the day, overlaps named with which meeting and by how much", async () => {
  const text = await brief(EIGHT, "en").compose(EIGHT);
  assert.match(text, /📅 On your calendar today:\n• all day Festivo local\n• 11:00–12:00 Steerco\n/);
  assert.match(text, /• 13:00–14:00 Maya Chen <> Acme ⚠️ overlaps Revisión de propuesta by 45 min\n/);
  assert.match(text, /• 13:15–15:30 Revisión de propuesta ⚠️ overlaps Maya Chen <> Acme by 45 min\n/);
  assert.doesNotMatch(text, /already over|Still ahead/);
});

test("old brief at 16:54: what ended is counted, the rest is what is left today", async () => {
  const text = await brief(LATE, "en").compose(LATE);
  assert.match(text, /📅 Still ahead today:\n• all day Festivo local\n• 17:30–18:00 Call con Samir\n✓ 3 already over today\./);
  assert.doesNotMatch(text, /Steerco|Maya Chen|overlaps/, "nothing over is shown as ahead");
  const night = Date.parse("2026-11-16T19:00:00Z");
  const timed = DAY.filter((e) => !e.allDay);
  assert.match(await brief(night, "en", timed).compose(night), /📅 Nothing left on your calendar today \(4 already over\)\./);
});

test("written brief: the overlap is a fact the model may turn into a suggestion", async () => {
  const g = await gatherFacts({ timeZone: MADRID, lang: "en", now: EIGHT, events: async () => DAY });
  // Other people's words are neutralised in a fact ("<>" becomes "‹›"): the clause itself is the server's.
  const b = g.facts.find((f) => f.title?.startsWith("Maya Chen"))!;
  assert.match(b.text, /^today 13:00–14:00 · Maya Chen ‹› Acme · ⚠\uFE0F? overlaps Revisión de propuesta by 45 min$/);
  const en = await gatherFacts({ timeZone: MADRID, lang: "en", now: EIGHT, events: async () => DAY });
  assert.match(en.facts.find((f) => f.title === "Steerco")!.text, /^today 11:00–12:00 · Steerco$/);
  assert.match(en.facts.find((f) => f.title === "Revisión de propuesta")!.text, /overlaps Maya Chen ‹› Acme by 45 min$/);
});

test("written brief, BRIEF at 16:54: the chat counts what is over; at 08:00 it lists the whole day", async () => {
  let t = EIGHT;
  const jobs: string[] = [];
  const v2 = createBriefV2({
    config: { waitMs: 15 * 60_000 }, kv: null, timeZone: MADRID, now: () => t, sources: { events: async () => DAY },
    enqueue: async (m) => (jobs.push(m.id), true), plain: async () => undefined, notify: async () => undefined,
  });
  await v2.begin(EIGHT);
  await v2.result(jobs[0]!.slice(3), JSON.stringify({ opening: "Día lleno.", todos: [] }));
  const morning = (await v2.short())!;
  assert.match(morning, /^☀️ Good morning\. Día lleno\.\n\n📅 Your day:\n• all day Festivo local\n• 11:00–12:00 Steerco\n/);
  assert.match(morning, /• 17:30–18:00 Call con Samir\n\n📰/);
  t = LATE;
  const late = (await v2.short())!;
  assert.match(late, /^👋 Good afternoon\. Día lleno\.\n\n📅 Still ahead today:\n• all day Festivo local\n• 17:30–18:00 Call con Samir\n✓ 3 already over today\.\n\n📰/);
  const doc = (await v2.todayDoc())!;
  const en = chatText(doc, { name: "", timeZone: MADRID, url: null, lang: "en", now: LATE });
  assert.match(en, /📅 Still ahead today:\n• all day Festivo local\n• 17:30–18:00 Call con Samir\n✓ 3 already over today\./);
  // The page marks the same items as over.
  assert.deepEqual(doc.dayItems.map((d) => dayItemOver(d, "16:54")), [false, true, true, true, false]);
});

test("a day item is over once its end has passed; one without an end an hour after it began; all day never", () => {
  assert.equal(dayItemOver({ time: "11:00", end: "12:00" }, "12:00"), true);
  assert.equal(dayItemOver({ time: "11:00", end: "12:00" }, "11:59"), false);
  assert.equal(dayItemOver({ time: "23:00", end: "01:00" }, "23:59"), false, "ends after midnight");
  assert.equal(dayItemOver({ time: "15:00" }, "15:59"), false);
  assert.equal(dayItemOver({ time: "15:00" }, "16:00"), true);
  assert.equal(dayItemOver({ time: "", allDay: true }, "23:59"), false);
  assert.equal(dayItemOver({ time: "", end: "10:00" }, "10:00"), true, "begun yesterday, until 10:00");
  const g = { facts: [], read: [], unread: [] };
  const doc = validateBrief(JSON.stringify({ opening: "x" }), g, { now: EIGHT, timeZone: MADRID, lang: "en", id: "x" })!;
  assert.match(chatText(doc, { name: "", timeZone: MADRID, url: null, now: LATE }), /📅 Nothing on your calendar today\./);
});
