// Bugs found in the calendar connections (src/ics.ts, src/calendar.ts, src/google-calendar.ts), each pinned by a test that failed before
// its fix: a repeating event's last occurrence lost to an UNTIL in UTC, an EXDATE given as a day, a declined meeting shown through another
// source's copy, an unanswered invitation's tag lost in the merge, Google's later pages of events, and the same Google meeting twice.

import assert from "node:assert/strict";
import { test } from "node:test";
import { type CalendarSource, type CalEvent, createCalendarCore, invitesBrief } from "../src/calendar.ts";
import { createGoogleCalendarSource } from "../src/google-calendar.ts";
import { icsEvents, parseFeed } from "../src/ics.ts";
import { memoryKv } from "./helpers/connect-rig.ts";

const ZONE = "Europe/Madrid";
const NOW = Date.parse("2026-11-15T07:30:00Z"); // Sunday 15 Nov 2026, 08:30 in Madrid
const window = { from: NOW - 86_400_000, to: NOW + 9 * 86_400_000, timeZone: ZONE };
const cal = (...events: string[][]): string => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN", ...events.flat(), "END:VCALENDAR"].join("\r\n") + "\r\n";
const starts = (text: string): string[] => icsEvents(parseFeed(text), window, "c").map((e) => new Date(e.start).toISOString());

test("ics: an UNTIL in UTC keeps the series' last occurrence when its zone has no VTIMEZONE (an IANA name, a Windows name, floating)", () => {
  // 10:00 in Madrid is 09:00 UTC: UNTIL=...T090000Z is exactly the last occurrence, which RFC 5545 counts (UNTIL is inclusive).
  for (const tz of [";TZID=Europe/Madrid", ";TZID=W. Europe Standard Time", ""]) {
    const text = cal([
      "BEGIN:VEVENT", "UID:until-utc", `DTSTART${tz}:20261116T100000`, `DTEND${tz}:20261116T110000`, "RRULE:FREQ=DAILY;UNTIL=20261118T090000Z",
      "SUMMARY:Daily", "END:VEVENT",
    ]);
    assert.deepEqual(starts(text), ["2026-11-16T09:00:00.000Z", "2026-11-17T09:00:00.000Z", "2026-11-18T09:00:00.000Z"], `DTSTART${tz}`);
  }
  // Tokyo (UTC+9), as Google writes "ends on the 17th": 23:59:59 that day in UTC. The 18th's 08:00 (17th 23:00 UTC) is after it.
  const tokyo = cal([
    "BEGIN:VEVENT", "UID:tokyo", "DTSTART;TZID=Asia/Tokyo:20261116T080000", "DTEND;TZID=Asia/Tokyo:20261116T090000",
    "RRULE:FREQ=DAILY;UNTIL=20261117T225959Z", "SUMMARY:Asa", "END:VEVENT",
  ]);
  assert.deepEqual(starts(tokyo), ["2026-11-15T23:00:00.000Z", "2026-11-16T23:00:00.000Z"]);
});

test("ics: an UNTIL given as a day on a timed series counts that whole day (RFC 2445's form, still written)", () => {
  const text = cal([
    "BEGIN:VEVENT", "UID:until-date", "DTSTART;TZID=Europe/Madrid:20261116T100000", "DTEND;TZID=Europe/Madrid:20261116T110000",
    "RRULE:FREQ=DAILY;UNTIL=20261118", "SUMMARY:Daily", "END:VEVENT",
  ]);
  assert.deepEqual(starts(text), ["2026-11-16T09:00:00.000Z", "2026-11-17T09:00:00.000Z", "2026-11-18T09:00:00.000Z"]);
});

test("ics: an EXDATE given as a day (VALUE=DATE) removes that day's occurrence of a timed series", () => {
  const text = cal([
    "BEGIN:VEVENT", "UID:exdate-day", "DTSTART;TZID=Europe/Madrid:20261116T100000", "DTEND;TZID=Europe/Madrid:20261116T110000",
    "RRULE:FREQ=DAILY;COUNT=3", "EXDATE;VALUE=DATE:20261117", "SUMMARY:Daily", "END:VEVENT",
  ]);
  assert.deepEqual(starts(text), ["2026-11-16T09:00:00.000Z", "2026-11-18T09:00:00.000Z"]);
});

test("ics: an EXDATE or RECURRENCE-ID with no zone on a series in another zone is that series' own wall clock, not the owner's", () => {
  // New York's 10:00 is 15:00 UTC; read in the owner's zone (Madrid) the EXDATE was 09:00 UTC and matched nothing.
  const text = cal([
    "BEGIN:VEVENT", "UID:ny-daily", "DTSTART;TZID=America/New_York:20261116T100000", "DTEND;TZID=America/New_York:20261116T110000",
    "RRULE:FREQ=DAILY;COUNT=4", "EXDATE:20261117T100000", "SUMMARY:NY daily", "END:VEVENT",
  ], [
    "BEGIN:VEVENT", "UID:ny-daily", "RECURRENCE-ID:20261118T100000", "DTSTART;TZID=America/New_York:20261118T120000",
    "DTEND;TZID=America/New_York:20261118T130000", "SUMMARY:NY daily (moved)", "END:VEVENT",
  ]);
  const ev = icsEvents(parseFeed(text), window, "c");
  assert.deepEqual(ev.map((e) => [e.title, new Date(e.start).toISOString()]), [
    ["NY daily", "2026-11-16T15:00:00.000Z"],
    ["NY daily (moved)", "2026-11-18T17:00:00.000Z"],
    ["NY daily", "2026-11-19T15:00:00.000Z"],
  ]);
  assert.equal(ev[1]!.id, `ny-daily@${Date.parse("2026-11-18T15:00:00Z")}`, "the moved one keeps its occurrence's id");
});

const source = (label: string, events: CalEvent[]): CalendarSource => ({ label, events: async () => ({ events, partial: false }) });
const core = (sources: CalendarSource[], now = NOW) =>
  createCalendarCore({ sources, timing: { remindMinutes: 10 }, kv: memoryKv(), timeZone: ZONE, now: () => now, notify: async () => undefined, lang: () => "en" });

test("core: a meeting declined in one source is left out, even when another source's copy does not know the answer", async () => {
  const start = Date.parse("2026-11-15T15:00:00Z");
  const base = { title: "Budget review", start, end: start + 3600_000, allDay: false, uid: "budget@corp" };
  const feed = source("ICS: outlook.office365.com", [{ ...base, id: "ics-1", calendar: "Calendar" }]);
  const mac = source("Mac", [{ ...base, id: "mac:1", calendar: "Work", response: "declined" }]);
  for (const order of [[feed, mac], [mac, feed]]) {
    const day = await core(order).day(0);
    assert.doesNotMatch(day, /Budget review/, `${order.map((s) => s.label).join(" then ")}: ${day}`);
  }
});

test("core: an invitation not answered keeps its tag (and its organizer) when another source's copy came first", async () => {
  const start = Date.parse("2026-11-15T15:00:00Z");
  const base = { title: "Budget review", start, end: start + 3600_000, allDay: false, uid: "budget@corp" };
  const feed = source("ICS: outlook.office365.com", [{ ...base, id: "ics-1", calendar: "Calendar" }]);
  const mac = source("Mac", [{ ...base, id: "mac:1", calendar: "Work", response: "needs", organizer: "Ana" }]);
  const events = await core([feed, mac]).today();
  assert.equal(events.length, 1);
  assert.match(invitesBrief(events, NOW, ZONE, "en") ?? "", /Ana invited you to Budget review today at 16:00/);
});

const G_ID = "1234567890-abcdefghij.apps.googleusercontent.com";
const googleRig = (pages: (url: URL) => Record<string, unknown>, calendars: Record<string, unknown>[]) => {
  const asked: string[] = [];
  const fake = (async (url: string) => {
    if (url === "https://token.example/token") return new Response(JSON.stringify({ access_token: "acc", expires_in: 3600 }));
    asked.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith("/calendarList")) return new Response(JSON.stringify({ items: calendars }));
    return new Response(JSON.stringify(pages(u)));
  }) as typeof fetch;
  const src = createGoogleCalendarSource({
    config: { clientId: G_ID, refreshToken: "1//r", account: "ana@gmail.example" }, timeZone: ZONE, fetch: fake, now: () => NOW, log: () => undefined,
    tokenUrl: "https://token.example/token", api: "https://cal.example/v3",
  });
  return { src, asked };
};
const gEvent = (id: string, iso: string, more: Record<string, unknown> = {}) => ({
  id, summary: `Meeting ${id}`, start: { dateTime: iso }, end: { dateTime: new Date(Date.parse(iso) + 1800_000).toISOString() }, ...more,
});

test("google: every page of a busy calendar is read (nextPageToken), not only the first 250 events", async () => {
  const { src, asked } = googleRig((u) => (u.searchParams.get("pageToken") === "p2"
    ? { items: [gEvent("late", "2026-11-20T10:00:00Z")] }
    : { items: [gEvent("early", "2026-11-16T10:00:00Z")], nextPageToken: "p2" }), [{ id: "primary", summary: "Ana", primary: true }]);
  const r = await src.events();
  assert.deepEqual(r.events.map((e) => e.id), ["google:early", "google:late"]);
  assert.equal(asked.filter((u) => u.includes("/events?")).length, 2);
});

test("google: the same meeting in two selected calendars is said once; one with no title reads (no title)", async () => {
  const { src } = googleRig(() => ({ items: [gEvent("shared", "2026-11-16T10:00:00Z"), { ...gEvent("untitled", "2026-11-16T12:00:00Z"), summary: undefined }] }),
    [{ id: "primary", summary: "Ana", primary: true }, { id: "team@x", summary: "Team" }]);
  const r = await src.events();
  assert.deepEqual(r.events.filter((e) => e.id === "google:shared").map((e) => e.calendar), ["Ana"]);
  assert.equal(r.events.find((e) => e.id === "google:untitled")?.title, "(no title)");
});
