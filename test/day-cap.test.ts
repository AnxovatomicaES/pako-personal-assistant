// The day's shared cap (src/app/budget.ts): one cap for every part (the lower of the standard and gentle mode's), and one turn at a time for the
// check against what the others sent and the count of what a part sends. The jobs' clock runs the parts side by side (src/jobs.ts), so two that
// each read the others' total before either had counted its own would both send the last place of the day.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cap, createBudget, takeOf } from "../src/app/budget.ts";
import { createAfterMeeting } from "../src/after-meeting.ts";
import type { CalEvent } from "../src/calendar.ts";
import { createCalendarAlerts } from "../src/calendar-alerts.ts";
import type { Loop } from "../src/followups/types.ts";
import { createCheckIns } from "../src/gentle-checkins.ts";
import { GENTLE_DEFAULTS } from "../src/gentle.ts";
import type { Kv } from "../src/kv.ts";
import { createProactive, type ProactiveConfig } from "../src/proactive.ts";

const MIN = 60_000;
/** Tuesday 17 November 2026, 10:30 in Madrid. */
const T0 = Date.parse("2026-11-17T09:30:00Z");
const TZ = "Europe/Madrid";
const yieldTurn = (): Promise<void> => new Promise((r) => setImmediate(r));

function memKv() {
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  return { kv, m };
}

test("cap: the standard cap, or gentle mode's when that is lower; never higher than the standard one", () => {
  assert.equal(cap(6, null), 6, "gentle mode off");
  assert.equal(cap(6, undefined), 6);
  assert.equal(cap(6, 4), 4, "gentle says less");
  assert.equal(cap(6, 10), 6, "gentle never says more than the standard cap");
  assert.equal(cap(6, 0), 0);
});

test("take: one turn at a time, the others' total read inside the turn, so two parts never both take the last place", async () => {
  const budget = createBudget();
  const spent = { checkins: 0, after: 0 };
  budget.add("followups", () => 5);
  budget.add("checkins", () => spent.checkins);
  budget.add("after", () => spent.after);
  const turn = (self: "checkins" | "after") =>
    budget.take(self, 6, async (room) => {
      await yieldTurn(); // the check and the count are not in one tick: another part's turn would fall in between without the lock
      if (spent[self] >= room) return false;
      spent[self]++;
      return true;
    });
  assert.deepEqual(await Promise.all([turn("checkins"), turn("after")]), [true, false], "5 + 1 = 6: the second finds no room");
  assert.deepEqual(spent, { checkins: 1, after: 0 });
  // A turn that throws lets the next one in.
  await assert.rejects(budget.take("after", 6, async () => Promise.reject(new Error("store"))), /store/);
  assert.equal(await budget.take("after", 7, async (room) => room), 1, "7 - (5 + 1)");
});

test("take of a part with no budget: the same without the turns (a part on its own, the tests)", async () => {
  assert.equal(await takeOf(undefined, async () => 2)(6, async (room) => room), 4);
  assert.equal(await takeOf(undefined, async () => Promise.reject(new Error("x")))(6, async (room) => room), 6, "a part that cannot say counts as none");
  assert.equal(await takeOf(undefined, undefined)(6, async (room) => room), 6);
});

test("a check-in and the question after a meeting due in the same tick, one place left: only one of them goes", async () => {
  const CAP = 6;
  const budget = createBudget();
  budget.add("followups", () => 5);
  const cards: string[] = [];
  const card = async (body: string): Promise<boolean> => (cards.push(body.split("\n")[0]!), true);
  let t = T0;
  const checkins = createCheckIns({
    kv: memKv().kv, timeZone: TZ, now: () => t, settings: async () => GENTLE_DEFAULTS, standardMax: CAP, quiet: null, card,
    others: () => budget.others("checkins"), take: (limit, fn) => budget.take("checkins", limit, fn),
  });
  const meeting: CalEvent = {
    id: "ev1", title: "Pricing review with Stan", start: t - 20 * MIN, end: t + 10 * MIN, allDay: false, calendar: "work",
    attendees: [{ email: "stan@example.com" }, { email: "me@example.com" }],
  } as CalEvent;
  const after = createAfterMeeting({
    kv: memKv().kv, timeZone: TZ, now: () => t, on: true, hours: { start: 9 * 60, end: 18 * 60, days: [1, 2, 3, 4, 5] }, quiet: null, events: async () => [meeting],
    zoomReview: false, cap: async () => CAP, others: () => budget.others("after"), take: (limit, fn) => budget.take("after", limit, fn), card,
  });
  budget.add("checkins", () => checkins.spentToday());
  budget.add("after", () => after.spentToday());
  // Offered on a nudge (a follow-up behind it): one the owner asked for in the chat at a time is not held back by the cap.
  await checkins.add({ when: t + 30 * MIN, thing: "the deck", loop: "a1b2c3d4e5" });
  t += 30 * MIN; // the check-in is due and the meeting ended 20 minutes ago
  const [asked, question] = await Promise.all([checkins.sweep(), after.sweep()]); // one tick of the jobs' clock
  assert.equal(asked.length + (question ? 1 : 0), 1, `one went: ${JSON.stringify(cards)}`);
  assert.equal(cards.length, 1);
  assert.equal(5 + (await checkins.spentToday()) + (await after.spentToday()), CAP, "the cap holds");
  // A card that could not go gives its place back.
  const down = createCheckIns({
    kv: memKv().kv, timeZone: TZ, now: () => t, settings: async () => GENTLE_DEFAULTS, standardMax: CAP, quiet: null, card: async () => false,
    take: (limit, fn) => budget.take("checkins", limit, fn),
  });
  await down.add({ when: t + MIN, thing: "x", loop: "b1b2c3d4e5" });
  t += MIN;
  assert.deepEqual(await down.sweep(), []);
  assert.equal(await down.spentToday(), 0, "not said: not counted");
});

test("a calendar alert and a check-in in the same tick, one place left: only one of them goes", async () => {
  const CAP = 3;
  const budget = createBudget();
  budget.add("followups", () => 2);
  const cards: string[] = [];
  const card = async (body: string): Promise<boolean> => (cards.push(body.split("\n")[0]!), true);
  let t = T0;
  const owed: Loop = {
    id: "a1b2c3d4e5", kind: "owner_promise", title: "Send the Bluefin deck", detail: "", who: "Ana", where: { type: "chat", label: "chat" },
    whenSaid: t - 24 * 3600_000, dueAt: Date.parse("2026-11-18T14:00:00Z"), check: { none: { reason: "email" } }, status: "open", nextCheckAt: 0,
    nudges: 0, createdAt: t - 24 * 3600_000, sources: [],
  };
  const alerts = createCalendarAlerts({
    timeZone: TZ, now: () => t, quiet: null, loops: async () => [owed], card, notify: async () => undefined,
    cap: async () => CAP, others: () => budget.others("alerts"), take: (limit, fn) => budget.take("alerts", limit, fn),
  });
  const checkins = createCheckIns({
    kv: memKv().kv, timeZone: TZ, now: () => t, settings: async () => GENTLE_DEFAULTS, standardMax: CAP, quiet: null, card,
    others: () => budget.others("checkins"), take: (limit, fn) => budget.take("checkins", limit, fn),
  });
  budget.add("alerts", () => alerts.spentToday());
  budget.add("checkins", () => checkins.spentToday());
  await checkins.add({ when: t + MIN, thing: "the deck", loop: "a1b2c3d4e5" });
  t += MIN;
  const moved = { kind: "moved" as const, title: "Bluefin review", start: Date.parse("2026-11-18T11:00:00Z"), was: Date.parse("2026-11-18T14:00:00Z") };
  const [told, asked] = await Promise.all([alerts.tell([moved]), checkins.sweep()]);
  assert.equal(told + asked.length, 1, `one place left, one card: ${JSON.stringify(cards)}`);
  assert.equal(2 + alerts.spentToday() + (await checkins.spentToday()), CAP, "the cap holds");
});

test("proactive Pako takes its place at the cap when it counts, not only at the look before: a stale look cannot overspend the day", async () => {
  const BASE: ProactiveConfig = {
    everyMs: 30 * MIN, active: { start: 9 * 60, end: 21 * 60 }, quiet: null, idleMs: 20 * MIN, maxPerDay: 2, totalPerDay: 6, repeatDays: 7,
    topics: ["trabajo", "comida", "viajes", "ocio", "deporte", "aficiones", "bienestar", "aprendizaje", "amigos"], place: null, country: "ES", emergency: "112",
  };
  const budget = createBudget();
  budget.add("followups", () => 6); // the others spent the day's total, but the look before read an older number
  const cards: string[] = [];
  const queued: { id: string }[] = [];
  const engine = createProactive({
    config: BASE, kv: memKv().kv, timeZone: TZ, local: true, now: () => T0, enqueue: async (m) => (queued.push(m), true),
    card: async (body) => (cards.push(body), true), lastOwner: () => T0 - 3600_000, bridgeAlive: () => true,
    othersToday: async () => 0, take: (limit, fn) => budget.take("life", limit, fn),
    offers: async () => [{ topic: "friend" as const, key: "friend:birthday:a1:2026", text: "🎂 Tomorrow is Ana's birthday.", claim: async () => true }],
  });
  // The companion's offer finds no room at its turn (so no card for it) and the check goes on to ask the assistant.
  assert.equal(await engine.tick(), "asked");
  assert.equal(cards.length, 0, "no card went for the offer");
  const out = await engine.result(queued.at(-1)!.id, JSON.stringify({ say: "Tienes la tarde libre: ¿un par de horas en el rocódromo?", topic: "aficiones", why: "x" }));
  assert.deepEqual(out, { ok: true, outcome: "dropped", reason: "budget" });
  assert.equal(cards.length, 0, "no card went for the suggestion");
});
