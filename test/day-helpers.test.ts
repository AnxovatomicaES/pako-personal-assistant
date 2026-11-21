// "Around your day" (src/day-helpers.ts): the panel's switches for the evening wrap-up, the question after a meeting and the calendar alerts.
// Each starts from its setting, the panel's choice wins once made, the route needs the session and the x-pako header, and each feature
// listens to its switch. Also: a 1:1 the owner set up, from a feed that lists only the guest, gets its after-meeting question.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { createAfterMeeting, withSomeone } from "../src/after-meeting.ts";
import { createCalendarAlerts } from "../src/calendar-alerts.ts";
import type { CalEvent } from "../src/calendar.ts";
import { createDayHelpers, DAY_HELPERS_KEY, HELPER_WORDS, mountDayHelpersPanel } from "../src/day-helpers.ts";
import type { Loop } from "../src/followups/types.ts";
import { shameIn } from "../src/gentle.ts";
import type { Kv } from "../src/kv.ts";
import { createShutdown, loadShutdownConfig } from "../src/shutdown.ts";
import type { WorkHours } from "../src/time-to-do.ts";

const TZ = "Europe/London";
const at = (iso: string): number => Date.parse(iso);
const WORK: WorkHours = { start: 9 * 60, end: 18 * 60, days: [1, 2, 3, 4, 5] };
function memKv() {
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  return { kv, m };
}
const loop = (o: Partial<Loop> = {}): Loop => ({
  id: "a1b2c3d4e5", kind: "owner_promise", title: "Send the Bluefin deck", detail: "", who: "Ana", where: { type: "chat", label: "chat" },
  whenSaid: at("2026-11-24T10:00:00Z"), dueAt: at("2026-11-27T12:00:00Z"), check: { none: { reason: "email" } }, status: "open", nextCheckAt: 0,
  nudges: 0, createdAt: at("2026-11-24T10:00:00Z"), sources: [], ...o,
});

test("switches: their settings first; the panel's choice wins and is kept; a store that fails gives the setting", async () => {
  const s = memKv();
  const h = createDayHelpers(s.kv, { wrapUp: true, afterMeeting: false, alerts: true });
  assert.deepEqual(await h.view(), { wrapUp: true, afterMeeting: false, alerts: true });
  assert.deepEqual(await h.set({ afterMeeting: true, wrapUp: false }), { wrapUp: false, afterMeeting: true, alerts: true });
  assert.deepEqual(JSON.parse(s.m.get(DAY_HELPERS_KEY)!), { wrapUp: false, afterMeeting: true });
  const again = createDayHelpers(s.kv, { wrapUp: true, afterMeeting: false, alerts: false });
  assert.equal(await again.on("afterMeeting"), true);
  assert.equal(await again.on("alerts"), false, "untouched: its setting");
  const broken = createDayHelpers({ get: async () => Promise.reject(new Error("down")), set: async () => undefined }, { wrapUp: true, afterMeeting: true, alerts: false });
  assert.equal(await broken.on("wrapUp"), true);
  assert.equal(await broken.on("alerts"), false);
  for (const w of Object.values(HELPER_WORDS)) for (const x of [w.label, w.description]) assert.deepEqual(shameIn(x), [], x);
});

test("route: signed in to read; the x-pako header to change; only the three switches, as true or false", async () => {
  const app = express();
  let signed = true;
  const h = createDayHelpers(null, { wrapUp: true, afterMeeting: true, alerts: true });
  mountDayHelpersPanel(app, { signedIn: () => signed, helpers: () => h });
  const server = createServer(app).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/panel/api/day-helpers`;
  const post = (body: unknown, header = true) =>
    fetch(base, { method: "POST", headers: { "content-type": "application/json", ...(header ? { "x-pako": "1" } : {}) }, body: JSON.stringify(body) });
  try {
    const got = await (await fetch(base)).json();
    assert.equal(got.wrapUp, true);
    assert.equal(got.words.alerts.label, "Tell me when a meeting moves");
    assert.equal((await post({ alerts: false }, false)).status, 401, "no header");
    assert.equal((await post({ alerts: "no" })).status, 400);
    assert.equal((await post({ alerts: false, other: true })).status, 400);
    assert.equal((await post({})).status, 400);
    const r = await post({ alerts: false });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).alerts, false);
    signed = false;
    assert.equal((await fetch(base)).status, 401);
  } finally {
    server.close();
  }
});

test("each feature listens to its switch: the wrap-up (on even with SHUTDOWN=off), the after-meeting question, the calendar alerts", async () => {
  const cards: string[] = [];
  const wrap = (on: boolean, env: Record<string, string>) => createShutdown({
    kv: null, timeZone: TZ, now: () => at("2026-11-26T18:00:00Z"), config: loadShutdownConfig(env, WORK), hours: WORK, quiet: null,
    loops: async () => [loop()], enabled: async () => on, roomy: async () => true, card: async (b) => (cards.push(b), true),
    plan: async () => "", done: async () => "",
  });
  assert.equal(await wrap(false, {}).sweep(), false);
  assert.equal(await wrap(true, { SHUTDOWN: "off" }).sweep(), true, "on from the panel: at the working day's end");
  const meeting: CalEvent = {
    id: "e1", title: "Bluefin review", start: at("2026-11-25T10:00:00Z"), end: at("2026-11-25T11:00:00Z"), allDay: false, calendar: "Work",
    attendees: [{ email: "me@acme.example" }, { email: "ana@client.example" }],
  };
  const after = (on: boolean) => createAfterMeeting({
    kv: null, timeZone: TZ, now: () => at("2026-11-25T11:10:00Z"), on: true, enabled: async () => on, hours: WORK, quiet: null,
    events: async () => [meeting], zoomReview: false, cap: async () => 6, others: async () => 0, card: async (b) => (cards.push(b), true),
  });
  assert.equal(await after(false).sweep(), false);
  assert.equal(await after(true).sweep(), true);
  const alerts = (on: boolean) => createCalendarAlerts({
    timeZone: TZ, now: () => at("2026-11-25T10:00:00Z"), quiet: null, loops: async () => [loop({ dueAt: at("2026-11-26T15:00:00Z") })],
    card: async (b) => (cards.push(b), true), notify: async () => undefined, enabled: async () => on,
  });
  const moved = { kind: "moved" as const, title: "Bluefin review", start: at("2026-11-26T11:00:00Z"), was: at("2026-11-26T15:00:00Z") };
  assert.equal(await alerts(false).tell([moved]), 0);
  assert.equal(await alerts(true).tell([moved]), 1);
});

test("a 1:1: one guest who isn't the owner is someone; the owner alone is not; without the owner's addresses, the organizer counts", () => {
  const e = (attendees: string[], organizer?: string): CalEvent => ({
    id: "e", title: "1:1", start: 0, end: 3600_000, allDay: false, calendar: "Work", attendees: attendees.map((email) => ({ email })),
    ...(organizer ? { organizer } : {}),
  });
  const self = ["me@acme.example"];
  assert.equal(withSomeone(e(["ana@client.example"]), self), true, "a feed that lists only the guest");
  assert.equal(withSomeone(e(["Me@Acme.example"]), self), false, "the owner alone");
  assert.equal(withSomeone(e(["ana@client.example"], "me@acme.example"), []), true, "unknown owner: guest and organizer");
  assert.equal(withSomeone(e(["ana@client.example"]), []), false, "unknown owner, one attendee, no organizer");
  assert.equal(withSomeone(e(["me@acme.example", "ana@client.example"]), []), true);
});

test("settings: off, 0, false and no all start a switch off (the engines' reading of SHUTDOWN, AFTER_MEETING, CALENDAR_ALERTS)", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../src/app/engines.ts", import.meta.url), "utf8");
  assert.match(src, /\["off", "0", "false", "no"\]\.includes/);
});
