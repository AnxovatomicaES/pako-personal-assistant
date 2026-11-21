// A meeting that moved or was called off, when the owner owes something at it (src/calendar-alerts.ts): told at once, with Plan and Done for
// one moved earlier, Done and Park for one cancelled, a plain line for one moved later; never for someone else's promise, a change days
// away, in the quiet hours or over three a day. The meeting's title is someone else's text: shown quoted on one line, never followed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { alertCard, ALERT_WORDS, changeAlerts, createCalendarAlerts } from "../src/calendar-alerts.ts";
import { dueAtMeeting } from "../src/followups/calendar-match.ts";
import type { Loop } from "../src/followups/types.ts";
import { FOLLOWUP_BUTTON } from "../src/followups.ts";
import { shameIn } from "../src/gentle.ts";
import { SHUTDOWN_BUTTON } from "../src/shutdown.ts";
import { TIME_BUTTON } from "../src/time-to-do.ts";

const HOUR = 3600_000;
const TZ = "Europe/London";
const at = (iso: string): number => Date.parse(iso);
/** Wednesday 2026-11-25 10:00 London. */
const NOW = at("2026-11-25T10:00:00Z");
const THU15 = at("2026-11-26T15:00:00Z");

const loop = (o: Partial<Loop> = {}): Loop => ({
  id: "a1b2c3d4e5", kind: "owner_promise", title: "Send the Bluefin deck", detail: "", who: "Ana", where: { type: "chat", label: "chat" },
  whenSaid: NOW - 24 * HOUR, dueAt: THU15, check: { none: { reason: "email" } }, status: "open", nextCheckAt: 0, nudges: 0,
  createdAt: NOW - 24 * HOUR, sources: [], ...o,
});

test("which: a change at a meeting the owner owes something for, soon; not theirs, not days away, not added, not another meeting", () => {
  const mine = loop();
  const theirs = loop({ id: "b1b2c3d4e5", kind: "other_promise", title: "Bluefin contract" });
  const moved = { kind: "moved" as const, title: "Bluefin review", start: at("2026-11-26T11:00:00Z"), was: THU15 };
  assert.equal(dueAtMeeting(mine, moved), true);
  const a = changeAlerts([mine, theirs], [moved], NOW);
  assert.equal(a.length, 1);
  assert.deepEqual(a[0]!.loops.map((l) => l.id), ["a1b2c3d4e5"]);
  assert.equal(changeAlerts([mine], [{ ...moved, title: "Dentist" }], NOW).length, 0, "another meeting");
  assert.equal(changeAlerts([mine], [{ kind: "added", title: "Bluefin review", start: THU15 }], NOW).length, 0);
  const far = loop({ dueAt: at("2026-12-04T15:00:00Z") });
  assert.equal(changeAlerts([far], [{ kind: "cancelled", title: "Bluefin review", start: at("2026-12-04T15:00:00Z") }], NOW).length, 0, "days away");
  assert.equal(changeAlerts([loop({ status: "done" })], [moved], NOW).length, 0, "closed");
});

test("words: earlier with Plan and Done, cancelled with Done and Park, later with no buttons; the title quoted on one line", () => {
  const l = loop();
  const earlier = alertCard({ change: { kind: "moved", title: "Bluefin review", start: at("2026-11-26T11:00:00Z"), was: THU15 }, loops: [l] }, NOW, TZ);
  assert.equal(earlier.body, "📅 “Bluefin review” moved earlier: Thu 15:00 → Thu 11:00. “Send the Bluefin deck” is now due then.");
  assert.deepEqual(earlier.buttons, [{ id: "tf:a1b2c3d4e5", title: "Plan it" }, { id: "f1:a1b2c3d4e5", title: "Done" }]);
  assert.deepEqual(TIME_BUTTON.exec(earlier.buttons[0]!.id)?.slice(1), ["f", "a1b2c3d4e5"]);
  assert.deepEqual(FOLLOWUP_BUTTON.exec(earlier.buttons[1]!.id)?.slice(1), ["1", "a1b2c3d4e5"]);
  const gone = alertCard({ change: { kind: "cancelled", title: "Bluefin\nreview <b>", start: THU15 }, loops: [l] }, NOW, TZ);
  assert.equal(gone.body, "📅 “Bluefin review ‹b›” (Thu 15:00) was cancelled. You still owe “Send the Bluefin deck”: keep it, or close it?");
  assert.deepEqual(gone.buttons.map((b) => b.id), ["f1:a1b2c3d4e5", "f7:a1b2c3d4e5"]);
  const later = alertCard({ change: { kind: "moved", title: "Bluefin review", start: at("2026-11-27T10:00:00Z"), was: THU15 }, loops: [l] }, NOW, TZ);
  assert.equal(later.body, "📅 “Bluefin review” moved to Fri 10:00 (was Thu 15:00). “Send the Bluefin deck” follows it: more time.");
  assert.deepEqual(later.buttons, []);
  for (const w of Object.values(ALERT_WORDS)) assert.deepEqual(shameIn(w), [], w);
  for (const b of [...earlier.buttons, ...gone.buttons]) assert.equal(SHUTDOWN_BUTTON.test(b.id), false);
});

test("sending: a card or a line; nothing in the quiet hours; three a day at most", async () => {
  const cards: string[] = [];
  const lines: string[] = [];
  const clock = { now: NOW };
  const loops = [loop()];
  const alerts = createCalendarAlerts({
    timeZone: TZ, now: () => clock.now, quiet: { start: 23 * 60, end: 8 * 60 }, loops: async () => loops,
    card: async (b) => (cards.push(b), true), notify: async (t) => void lines.push(t),
  });
  const earlier = { kind: "moved" as const, title: "Bluefin review", start: at("2026-11-26T11:00:00Z"), was: THU15 };
  const later = { kind: "moved" as const, title: "Bluefin review", start: at("2026-11-27T10:00:00Z"), was: THU15 };
  assert.equal(await alerts.tell([earlier]), 1);
  assert.equal(await alerts.tell([later]), 1);
  assert.equal(cards.length, 1);
  assert.equal(lines.length, 1);
  assert.equal(await alerts.tell([earlier, earlier]), 1, "the third of the day");
  assert.equal(await alerts.tell([earlier]), 0, "over three a day");
  clock.now = at("2026-11-26T00:30:00Z");
  assert.equal(await alerts.tell([earlier]), 0, "the quiet hours");
  clock.now = at("2026-11-26T08:30:00Z");
  assert.equal(await alerts.tell([earlier]), 1, "a new day");
});

test("the shared cap: no alert once the day's cap is spent by the others; its own count is read by them", async () => {
  const cards: string[] = [];
  const others = { n: 5 };
  const alerts = createCalendarAlerts({
    timeZone: TZ, now: () => NOW, quiet: null, loops: async () => [loop()], card: async (b) => (cards.push(b), true), notify: async () => undefined,
    cap: async () => 6, others: async () => others.n,
  });
  const earlier = { kind: "moved" as const, title: "Bluefin review", start: at("2026-11-26T11:00:00Z"), was: THU15 };
  assert.equal(await alerts.tell([earlier]), 1, "5 of 6: one more");
  assert.equal(alerts.spentToday(), 1);
  assert.equal(await alerts.tell([earlier]), 0, "6 of 6: none");
  others.n = 0;
  assert.equal(await alerts.tell([earlier]), 1);
});

test("budget: each part sees what all the others sent today, never itself; a part that fails counts as none", async () => {
  const { createBudget } = await import("../src/app/budget.ts");
  const b = createBudget();
  b.add("followups", async () => 2);
  b.add("life", () => 1);
  b.add("alerts", () => undefined);
  b.add("after", async () => Promise.reject(new Error("no store")));
  assert.equal(await b.others("followups"), 1);
  assert.equal(await b.others("life"), 2);
  assert.equal(await b.others("time"), 3);
});
