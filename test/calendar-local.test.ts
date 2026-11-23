// This Mac's calendars as a calendar source (src/calendar-local.ts): what the app pushes is read in the owner's zone (all-day days as dates),
// only the picked calendars and the window kept, never the notes; the core gives the same agenda and the reminder ten minutes before, and the
// same meeting from an ICS link and from the Mac is said once. The first push restarts Pako once so the calendar reads it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { type CalendarSource, createCalendarCore } from "../src/calendar.ts";
import { createLocalCalendar, hasLocalCalendar, LOCAL_CALENDAR_KEY, mountLocalCalendarPanel, pushOf } from "../src/calendar-local.ts";
import { createDiscoveryStore } from "../src/discovery.ts";
import { APP, auth, memoryKv, serve } from "./helpers/connect-rig.ts";
import { eventually } from "./helpers/wait.ts";

const TZ = "Europe/Madrid";
const NOW = Date.parse("2026-11-16T08:00:00Z"); // 09:00 in Madrid

const PUSH = {
  calendars: ["work", "home"],
  events: [
    { id: "e1", calendarId: "work", title: "Comité", start: "2026-11-16T09:10:00Z", end: "2026-11-16T10:00:00Z", allDay: false,
      location: "Sala 2", notes: "Secret notes https://us02web.zoom.us/j/123456", attendees: ["x@y.com"] },
    { id: "e2", calendarId: "home", title: "Cumple de Ana", start: "2026-11-17", end: "2026-11-18", allDay: true },
    { id: "e3", calendarId: "hidden", title: "Not picked", start: NOW + 3600_000, end: NOW + 7200_000 },
    { id: "e4", calendarId: "work", title: "Far away", start: NOW + 40 * 24 * 3600_000, end: NOW + 40 * 24 * 3600_000 + 1 },
    { id: "rep", calendarId: "work", title: "Daily", start: (NOW + 86400_000) / 1000, end: (NOW + 86400_000) / 1000 + 900 },
    { id: "rep", calendarId: "work", title: "Daily", start: (NOW + 2 * 86400_000) / 1000, end: (NOW + 2 * 86400_000) / 1000 + 900 },
  ],
};

test("a push keeps the picked calendars' events in the window, all-day days in Madrid, the call's link but never the notes", () => {
  const kept = pushOf(PUSH, { now: NOW, timeZone: TZ, titles: new Map([["work", "Trabajo"]]) })!;
  assert.deepEqual(kept.calendars, [{ id: "work", title: "Trabajo" }, { id: "home", title: "Mac" }]);
  assert.deepEqual(kept.events.map((e) => e.title), ["Comité", "Cumple de Ana", "Daily", "Daily"]);
  const [meeting, birthday, rep1, rep2] = kept.events;
  assert.equal(meeting!.join, "https://us02web.zoom.us/j/123456");
  assert.equal(meeting!.location, "Sala 2");
  assert.doesNotMatch(JSON.stringify(kept), /Secret notes|x@y\.com/);
  assert.equal(birthday!.start, Date.parse("2026-11-16T23:00:00Z"), "midnight in Madrid");
  assert.equal(birthday!.end - birthday!.start, 24 * 3600_000);
  assert.notEqual(rep1!.id, rep2!.id, "each occurrence of a repeating event is its own");
  assert.equal(pushOf({ events: [] }, { now: NOW, timeZone: TZ }), null);
});

test("the Mac's events give the agenda and the reminder ten minutes before, and an ICS copy of the same meeting is said once", async () => {
  const kv = memoryKv();
  const mac = createLocalCalendar({ kv, now: () => NOW });
  assert.deepEqual(await mac.source.events(), { events: [], partial: false }, "nothing pushed (or forgotten) is an empty calendar, not a fault");
  await mac.write(pushOf(PUSH, { now: NOW, timeZone: TZ })!);
  const ics: CalendarSource = {
    label: "ICS: calendar.example.com",
    events: async () => ({
      events: [{ id: "ics-1", title: "Comité", start: Date.parse("2026-11-16T09:10:00Z"), end: Date.parse("2026-11-16T10:00:00Z"), allDay: false, calendar: "Google" }],
      partial: false,
    }),
  };
  const told: string[] = [];
  let t = NOW;
  const core = createCalendarCore({
    sources: [ics, mac.source], timing: { remindMinutes: 10 } as never, kv: memoryKv(), timeZone: TZ, now: () => t,
    notify: async (text) => void told.push(text), lang: () => "en",
  });
  const today = await core.day(0);
  assert.equal(today.match(/Comité/g)?.length, 1, today);
  t = Date.parse("2026-11-16T09:01:00Z");
  await core.tick();
  assert.equal(told.length, 1);
  assert.match(told[0]!, /In 9 min: Comité/);
  assert.match(told[0]!, /zoom\.us/);
  // Thirty minutes without a push: the app is closed, and the agenda may be missing something.
  assert.equal((await mac.source.events()).partial, false);
  const later = createLocalCalendar({ kv, now: () => NOW + 31 * 60_000 });
  assert.equal((await later.source.events()).partial, true);
});

test("the push route keeps the events, names the calendars from the discovery, and restarts Pako once when the calendar did not read them", async () => {
  const kv = memoryKv();
  const discovery = createDiscoveryStore(kv);
  await discovery.write({
    at: NOW, apps: {} as never, calendars: [{ id: "work", title: "Trabajo", source: "iCloud", color: "", writable: true }], mailAccounts: [],
    contacts: { count: 0 }, zoomRecordings: null, permissions: { calendars: "granted", contacts: "notAsked", mail: "notAsked" },
  });
  const calendar = createLocalCalendar({ kv, now: () => NOW });
  let restarts = 0;
  let changed = 0;
  const p = await serve((app) => mountLocalCalendarPanel(app, {
    ...auth, calendar, timeZone: TZ, lang: () => "en", now: () => NOW, discovery, inUse: () => false,
    restart: () => (restarts++, true), changed: () => void changed++,
  }));
  try {
    const first = await p.post("/panel/api/calendar/local", PUSH, APP);
    assert.deepEqual(first.body, { ok: true, events: 4, restarting: true });
    const second = await p.post("/panel/api/calendar/local", PUSH, APP);
    assert.deepEqual(second.body, { ok: true, events: 4 }, "asked once only");
    await eventually(() => restarts >= 1, { then: 50 });
    assert.equal(restarts, 1);
    assert.equal(changed, 2);
    const shown = await p.get("/panel/api/calendar/local");
    assert.deepEqual((shown.body as { calendars: unknown }).calendars, [{ id: "work", title: "Trabajo" }, { id: "home", title: "Mac" }]);
    assert.equal(hasLocalCalendar({ entries: () => [...kv.data].map(([key, value]) => ({ key, value })) }), true);
    // No calendar picked any more: forgotten.
    await p.post("/panel/api/calendar/local", { calendars: [], events: [] }, APP);
    assert.equal(kv.data.get(LOCAL_CALENDAR_KEY), "");
    assert.equal(hasLocalCalendar(kv), false, "a plain store cannot be read synchronously: not started");
    assert.equal((await p.post("/panel/api/calendar/local", { nope: 1 }, APP)).status, 400);
    assert.equal((await p.post("/panel/api/calendar/local", PUSH, {})).status, 401);
  } finally {
    await p.close();
  }
});

test("an all-day event as the Mac app sends it (ISO with its offset, EventKit's end at 23:59:59) and its ICS copy are said once", async () => {
  const push = { calendars: ["home"], events: [
    { id: "bd@1", calendarId: "home", title: "Cumple de Ana", start: "2026-11-17T00:00:00+01:00", end: "2026-11-17T23:59:59+01:00", allDay: true },
  ] };
  const kept = pushOf(push, { now: NOW, timeZone: TZ })!;
  assert.equal(kept.events[0]!.start, Date.parse("2026-11-16T23:00:00Z"), "midnight in Madrid");
  assert.equal(kept.events[0]!.end, Date.parse("2026-11-17T23:00:00Z"), "the next midnight, as an ICS link ends it");
  const kv = memoryKv();
  const mac = createLocalCalendar({ kv, now: () => NOW });
  await mac.write(kept);
  const ics: CalendarSource = {
    label: "ICS: calendar.google.com",
    events: async () => ({
      events: [{ id: "ics-bd", title: "Cumple de Ana", start: Date.parse("2026-11-16T23:00:00Z"), end: Date.parse("2026-11-17T23:00:00Z"), allDay: true, calendar: "G" }],
      partial: false,
    }),
  };
  const core = createCalendarCore({
    sources: [ics, mac.source], timing: { remindMinutes: 10 } as never, kv: memoryKv(), timeZone: TZ, now: () => NOW,
    notify: async () => undefined, lang: () => "en",
  });
  assert.equal((await core.day(1)).match(/Cumple de Ana/g)?.length, 1);
});

test("an all-day event pushed by a Mac in another zone than the owner's keeps its own day (the date as the Mac wrote it)", () => {
  // The Mac is in Tokyo (a trip; or PERSONAL_TIMEZONE set to home): its 17 Nov starts at 15:00 on the 16th in Madrid.
  const push = { calendars: ["home"], events: [
    { id: "bd@1", calendarId: "home", title: "Cumple de Ana", start: "2026-11-17T00:00:00+09:00", end: "2026-11-17T23:59:59+09:00", allDay: true },
    { id: "trip@1", calendarId: "home", title: "Viaje", start: "2026-11-18T00:00:00+09:00", end: "2026-11-20T00:00:00+09:00", allDay: true },
  ] };
  const [bd, trip] = pushOf(push, { now: NOW, timeZone: TZ })!.events;
  assert.deepEqual([bd!.start, bd!.end], [Date.parse("2026-11-16T23:00:00Z"), Date.parse("2026-11-17T23:00:00Z")], "17 Nov in Madrid, not the 16th");
  assert.deepEqual([trip!.start, trip!.end], [Date.parse("2026-11-17T23:00:00Z"), Date.parse("2026-11-19T23:00:00Z")], "18 and 19 Nov: an end at midnight is the day after");
});

test("stopping or forgetting this Mac's calendars leaves the running calendar healthy and empty, not broken for the watchdog", async () => {
  const kv = memoryKv();
  const mac = createLocalCalendar({ kv, now: () => NOW });
  const health: boolean[] = [];
  const core = createCalendarCore({
    sources: [mac.source], timing: { remindMinutes: 10 } as never, kv, timeZone: TZ, notify: async () => undefined, now: () => NOW,
    health: (ok) => void health.push(ok),
  });
  const s = await serve((app) => mountLocalCalendarPanel(app, {
    ...auth, calendar: mac, timeZone: TZ, lang: () => "en", now: () => NOW, inUse: () => true, restart: () => true,
  }));
  try {
    await s.post("/panel/api/calendar/local", { calendars: ["work"], events: [{ id: "e1", calendarId: "work", title: "Comité", start: NOW + 3600_000, end: NOW + 7200_000 }] });
    await core.load(true);
    assert.equal(health.at(-1), true);
    assert.equal((await s.post("/panel/api/calendar/local", { calendars: [], events: [] })).status, 200);
    await core.load(true);
    assert.equal(health.at(-1), true, "the owner chose to stop reading them: nothing to warn about");
    await mac.forget();
    await core.load(true);
    assert.equal(health.at(-1), true);
  } finally {
    await s.close();
  }
});

test("the Mac's attendees are kept (address and name, at most 30) for People and meeting prep; one without an address is not", () => {
  const push = { calendars: [{ id: "work", title: "Work" }], events: [{
    id: "m1", calendarId: "work", title: "Budget review", start: "2026-11-17T10:00:00+01:00", end: "2026-11-17T11:00:00+01:00", allDay: false,
    attendees: [{ email: "Ana@Example.com", name: "Ana García" }, { email: "not an address", name: "Ghost" }, { email: "marc@example.com" }],
  }] };
  const kept = pushOf(push, { now: NOW, timeZone: TZ })!;
  assert.deepEqual(kept.events[0]!.attendees, [{ email: "ana@example.com", name: "Ana García" }, { email: "marc@example.com" }]);
});

test("the same meeting in two calendars picked on this Mac is kept once: one agenda line, no overlap with itself, one reminder", async () => {
  const copy = (id: string, calendarId: string, extra: Record<string, unknown> = {}) => ({
    id, calendarId, title: "Budget review", start: "2026-11-16T09:08:00+01:00", end: "2026-11-16T10:00:00+01:00", allDay: false, uid: "040000008200E00074C5", ...extra,
  });
  const kept = pushOf({ calendars: ["work", "team"], events: [copy("AAAA:1@1", "work"), copy("BBBB:2@1", "team", { location: "Sala 2" })] }, { now: NOW, timeZone: TZ })!;
  assert.equal(kept.events.length, 1);
  assert.equal(kept.events[0]!.location, "Sala 2", "what the other copy knows is kept");
  const local = createLocalCalendar({ kv: memoryKv(), now: () => NOW });
  await local.write(kept);
  const told: string[] = [];
  const core = createCalendarCore({ sources: [local.source], timing: { remindMinutes: 10 }, kv: null, timeZone: TZ, notify: async (t) => void told.push(t), now: () => NOW, log: () => {} });
  assert.doesNotMatch(await core.day(0), /overlaps/);
  assert.equal((await core.tick()).reminded, 1);
});
