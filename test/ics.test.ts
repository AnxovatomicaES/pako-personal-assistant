import assert from "node:assert/strict";
import test from "node:test";
import { calendarLog, createCalendar, createCalendarCore, loadCalendarConfig, type CalendarSource, type CalEvent } from "../src/calendar.ts";
import type { Control } from "../src/control.ts";
import { createIcsSource, icsEvents, icsHosts, ICS_SETTING, loadIcsConfig, parseFeed } from "../src/ics.ts";

// ---------- real-world samples (shapes copied from what Google, Apple and Outlook publish) ----------

const MADRID_TZ = [
  "BEGIN:VTIMEZONE", "TZID:Europe/Madrid", "X-LIC-LOCATION:Europe/Madrid",
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST", "DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET", "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
  "END:VTIMEZONE",
];

const cal = (...lines: (string | string[])[]): string =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN", ...lines.flat(), "END:VCALENDAR"].join("\r\n") + "\r\n";

/** Google: a weekly meeting with an exception (one week skipped), a moved week, a Meet link, a cancelled occurrence of a daily stand-up. */
const GOOGLE = cal(
  "X-WR-CALNAME:Trabajo",
  "X-WR-TIMEZONE:Europe/Madrid",
  MADRID_TZ,
  [
    "BEGIN:VEVENT", "DTSTART;TZID=Europe/Madrid:20260105T100000", "DTEND;TZID=Europe/Madrid:20260105T110000", "RRULE:FREQ=WEEKLY;BYDAY=MO",
    "EXDATE;TZID=Europe/Madrid:20261116T100000", "UID:weekly123@google.com", "SUMMARY:Comité semanal",
    "DESCRIPTION:Únete con Google Meet: https://meet.google.com/abc-defg-hij\\nMás opciones", "STATUS:CONFIRMED", "END:VEVENT",
  ],
  [
    "BEGIN:VEVENT", "DTSTART;TZID=Europe/Madrid:20261123T120000", "DTEND;TZID=Europe/Madrid:20261123T130000",
    "RECURRENCE-ID;TZID=Europe/Madrid:20261123T100000", "UID:weekly123@google.com", "SUMMARY:Comité semanal (movido)", "SEQUENCE:1", "END:VEVENT",
  ],
  [
    "BEGIN:VEVENT", "DTSTART:20260601T073000Z", "DTEND:20260601T074500Z", "RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR", "UID:standup@google.com",
    "SUMMARY:Stand-up", "LOCATION:Sala 2", "END:VEVENT",
  ],
  [
    "BEGIN:VEVENT", "DTSTART:20261117T073000Z", "DTEND:20261117T074500Z", "RECURRENCE-ID:20261117T073000Z", "UID:standup@google.com",
    "SUMMARY:Stand-up", "STATUS:CANCELLED", "END:VEVENT",
  ],
  ["BEGIN:VEVENT", "DTSTART:20261115T090000Z", "DTEND:20261115T093000Z", "UID:dentist@google.com", "SUMMARY:Dentista", "END:VEVENT"],
  ["BEGIN:VEVENT", "DTSTART:20261115T150000Z", "DTEND:20261115T160000Z", "UID:gone@google.com", "SUMMARY:Cancelada", "STATUS:CANCELLED", "END:VEVENT"],
);

/** Apple iCloud: an all-day trip over two days, a yearly birthday since 1985, a floating-time dinner (no zone: the owner's). */
const APPLE = cal(
  "X-WR-CALNAME:Casa",
  ["BEGIN:VEVENT", "UID:7C1A-TRIP", "DTSTART;VALUE=DATE:20261116", "DTEND;VALUE=DATE:20261118", "SUMMARY:Viaje a Lisboa", "END:VEVENT"],
  ["BEGIN:VEVENT", "UID:7C1A-BDAY", "DTSTART;VALUE=DATE:19851117", "DURATION:P1D", "RRULE:FREQ=YEARLY", "SUMMARY:Cumple de Ana", "END:VEVENT"],
  ["BEGIN:VEVENT", "UID:7C1A-DINNER", "DTSTART:20261115T210000", "DURATION:PT2H", "SUMMARY:Cena", "LOCATION:Casa de Pepe", "END:VEVENT"],
);

/** Outlook / Exchange: Windows' zone names, with their own definitions, and a Teams link in the description. */
const OUTLOOK = cal(
  "X-WR-CALNAME:Calendar",
  [
    "BEGIN:VTIMEZONE", "TZID:W. Europe Standard Time",
    "BEGIN:STANDARD", "DTSTART:16010101T030000", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10", "END:STANDARD",
    "BEGIN:DAYLIGHT", "DTSTART:16010101T020000", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3", "END:DAYLIGHT",
    "END:VTIMEZONE",
  ],
  [
    "BEGIN:VTIMEZONE", "TZID:Eastern Standard Time",
    "BEGIN:STANDARD", "DTSTART:16010101T020000", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11", "END:STANDARD",
    "BEGIN:DAYLIGHT", "DTSTART:16010101T020000", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3", "END:DAYLIGHT",
    "END:VTIMEZONE",
  ],
  [
    "BEGIN:VEVENT", "UID:040000008200E00074C5B7101A82E00800000000", "SUMMARY:Revisión con cliente",
    "DTSTART;TZID=W. Europe Standard Time:20261115T150000", "DTEND;TZID=W. Europe Standard Time:20261115T160000",
    "LOCATION:Microsoft Teams Meeting",
    "DESCRIPTION:Join: https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=x\\n",
    "END:VEVENT",
  ],
  [
    "BEGIN:VEVENT", "UID:040000008200E00074C5B7101A82E00800000001", "SUMMARY:Call NY",
    "DTSTART;TZID=Eastern Standard Time:20261116T090000", "DTEND;TZID=Eastern Standard Time:20261116T093000", "END:VEVENT",
  ],
  [
    "BEGIN:VEVENT", "UID:custom-zone", "SUMMARY:Zona propia",
    "DTSTART;TZID=Custom Zone:20261116T120000", "DTEND;TZID=Custom Zone:20261116T130000", "END:VEVENT",
    "BEGIN:VTIMEZONE", "TZID:Custom Zone", "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:+0300", "TZOFFSETTO:+0300", "END:STANDARD", "END:VTIMEZONE",
  ],
);

/** A week with a clock change: a daily 09:00 in Madrid since 2015 (long before the window), around 25 Oct 2026. */
const DST = cal(MADRID_TZ, [
  "BEGIN:VEVENT", "UID:daily-since-2015", "DTSTART;TZID=Europe/Madrid:20150101T090000", "DTEND;TZID=Europe/Madrid:20150101T093000",
  "RRULE:FREQ=DAILY", "SUMMARY:Correo", "END:VEVENT",
]);

const NOW = Date.parse("2026-11-15T07:30:00Z"); // Sunday 15 Nov 2026, 08:30 in Madrid
const ZONE = "Europe/Madrid";
const window = (now = NOW) => ({ from: now - 86_400_000, to: now + 9 * 86_400_000, timeZone: ZONE });
const at = (iso: string) => Date.parse(iso);

// ---------- settings ----------

test("loadIcsConfig: off with nothing; webcal is https; spaces or commas; http and passwords refused without repeating the link", () => {
  assert.deepEqual(loadIcsConfig({}), { config: null, problems: [] });
  const two = loadIcsConfig({ CALENDAR_ICS_URL: " webcal://p12-caldav.icloud.com/published/2/SECRET ,https://calendar.google.com/calendar/ical/x%40gmail.com/private-abc/basic.ics" });
  assert.deepEqual(two.config?.urls, ["https://p12-caldav.icloud.com/published/2/SECRET", "https://calendar.google.com/calendar/ical/x%40gmail.com/private-abc/basic.ics"]);
  assert.deepEqual(icsHosts(two.config!.urls), ["p12-caldav.icloud.com", "calendar.google.com"]);
  const bad = loadIcsConfig({ CALENDAR_ICS_URL: "http://example.com/SECRET.ics https://u:p@example.com/x.ics" });
  assert.equal(bad.config, null);
  assert.equal(bad.problems.length, 2);
  assert.ok(!bad.problems.join(" ").includes("SECRET"), "a problem never repeats the secret link");
  assert.equal(ICS_SETTING.name, "CALENDAR_ICS_URL");
  assert.equal(ICS_SETTING.secret, true);
  assert.deepEqual(ICS_SETTING.check("webcal://example.com/a.ics"), []);
  assert.equal(ICS_SETTING.check("notalink").length, 1);
});

// ---------- parsing ----------

test("Google: weekly series with an EXDATE and a moved week, a cancelled occurrence, a cancelled event, UTC times, the Meet link", () => {
  const ev = icsEvents(parseFeed(GOOGLE), window(), "Trabajo");
  const weekly = ev.filter((e) => e.title.startsWith("Comité"));
  // The 16th is skipped (EXDATE); the 23rd is moved to 12:00 (Madrid = UTC+1 in November).
  assert.deepEqual(weekly.map((e) => [e.title, new Date(e.start).toISOString()]), [["Comité semanal (movido)", "2026-11-23T11:00:00.000Z"]]);
  const moved = weekly[0]!;
  assert.equal(moved.id, `weekly123@google.com@${at("2026-11-23T09:00:00Z")}`, "the id is the occurrence's original start: stable when it moves");
  const standups = ev.filter((e) => e.title === "Stand-up").map((e) => new Date(e.start).toISOString().slice(0, 10));
  assert.deepEqual(standups, ["2026-11-16", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-23"], "weekdays only, the 17th cancelled");
  assert.ok(!ev.some((e) => e.title === "Cancelada"));
  const dentist = ev.find((e) => e.title === "Dentista")!;
  assert.equal(dentist.start, at("2026-11-15T09:00:00Z"));
  assert.equal(dentist.end, at("2026-11-15T09:30:00Z"));
  // The ids stay the same when the feed is read again.
  assert.deepEqual(icsEvents(parseFeed(GOOGLE), window(), "Trabajo").map((e) => e.id), ev.map((e) => e.id));
  // The Meet link of the series (seen on a later occurrence in the window).
  const later = icsEvents(parseFeed(GOOGLE), window(at("2026-11-29T07:30:00Z")), "Trabajo").find((e) => e.title === "Comité semanal")!;
  assert.equal(later.join, "https://meet.google.com/abc-defg-hij");
});

test("Apple: all-day dates are the owner's days; a yearly birthday since 1985; a floating time is in the owner's zone", () => {
  const ev = icsEvents(parseFeed(APPLE), window(), "Casa");
  const trip = ev.find((e) => e.title === "Viaje a Lisboa")!;
  assert.equal(trip.allDay, true);
  assert.equal(trip.start, at("2026-11-15T23:00:00Z"), "16 Nov at midnight in Madrid");
  assert.equal(trip.end, at("2026-11-17T23:00:00Z"), "two days");
  const bday = ev.find((e) => e.title === "Cumple de Ana")!;
  assert.equal(bday.start, at("2026-11-16T23:00:00Z"));
  assert.equal(bday.id, "7C1A-BDAY@20261117");
  const dinner = ev.find((e) => e.title === "Cena")!;
  assert.equal(dinner.start, at("2026-11-15T20:00:00Z"));
  assert.equal(dinner.end, at("2026-11-15T22:00:00Z"));
  assert.equal(dinner.location, "Casa de Pepe");
});

test("Outlook: Windows zone names, the feed's own zone definition, and the Teams link from the description", () => {
  const ev = icsEvents(parseFeed(OUTLOOK), window(), "Calendar");
  const review = ev.find((e) => e.title === "Revisión con cliente")!;
  assert.equal(review.start, at("2026-11-15T14:00:00Z"));
  assert.match(review.join ?? "", /^https:\/\/teams\.microsoft\.com\/l\/meetup-join\//);
  assert.equal(review.location, "Microsoft Teams Meeting");
  assert.equal(ev.find((e) => e.title === "Call NY")!.start, at("2026-11-16T14:00:00Z"), "09:00 in New York");
  assert.equal(ev.find((e) => e.title === "Zona propia")!.start, at("2026-11-16T09:00:00Z"), "+03:00 from the feed's definition");
});

test("a week with a clock change: a daily series since 2015 stays at 09:00 on both sides of 25 Oct", () => {
  const now = at("2026-10-22T10:00:00Z");
  const ev = icsEvents(parseFeed(DST), window(now));
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const days = ev.map((e) => fmt.format(e.start));
  assert.equal(days.length, 10, "one a day, in the window");
  for (const d of days) assert.match(d, / 09:00$/);
  assert.ok(ev.some((e) => e.start === at("2026-10-24T07:00:00Z")) && ev.some((e) => e.start === at("2026-10-26T08:00:00Z")));
  assert.ok(ev.every((e) => e.end - e.start === 30 * 60_000));
});

test("a huge feed: thousands of past events and a rule every minute are read quickly; the rule every minute is left out", () => {
  const many: string[] = [];
  for (let i = 0; i < 20_000; i++) many.push("BEGIN:VEVENT", `UID:old-${i}`, "DTSTART:20200101T100000Z", "DTEND:20200101T110000Z", `SUMMARY:Old ${i}`, "END:VEVENT");
  many.push("BEGIN:VEVENT", "UID:spam", "DTSTART:20261115T000000Z", "DURATION:PT1M", "RRULE:FREQ=MINUTELY", "SUMMARY:Spam", "END:VEVENT");
  many.push("BEGIN:VEVENT", "UID:real", "DTSTART:20261115T100000Z", "DTEND:20261115T110000Z", "SUMMARY:Real", "END:VEVENT");
  const warned: string[] = [];
  const t0 = Date.now();
  const ev = icsEvents(parseFeed(cal(many)), window(), "Big", (w) => warned.push(w));
  assert.ok(Date.now() - t0 < 10_000, "quick");
  assert.ok(ev.some((e) => e.title === "Real"));
  assert.equal(ev.filter((e) => e.title === "Spam").length, 0, "no calendar app repeats every minute");
  assert.ok(warned.some((w) => /repeats too often/.test(w)));
  assert.ok(!ev.some((e) => e.title.startsWith("Old")));
});

test("rules that ical.js searches second by second (SECONDLY;BYMONTH=2) do not stall the read: left out, warned once, the rest kept", () => {
  const evil: string[] = [];
  for (let i = 0; i < 50; i++) {
    evil.push("BEGIN:VEVENT", `UID:evil-${i}`, "DTSTART:20261114T000000Z", "DURATION:PT1S", "RRULE:FREQ=SECONDLY;BYMONTH=2", "SUMMARY:Evil", "END:VEVENT");
    evil.push("BEGIN:VEVENT", `UID:evil-h-${i}`, "DTSTART:20261114T000000Z", "DURATION:PT1H", "RRULE:FREQ=HOURLY;BYMONTH=2", "SUMMARY:Evil", "END:VEVENT");
  }
  evil.push("BEGIN:VEVENT", "UID:real", "DTSTART:20261116T100000Z", "DTEND:20261116T110000Z", "SUMMARY:Real", "END:VEVENT");
  evil.push("BEGIN:VEVENT", "UID:hourly", "DTSTART:20261116T100000Z", "DURATION:PT10M", "RRULE:FREQ=HOURLY;COUNT=3", "SUMMARY:Hourly", "END:VEVENT");
  const warned: string[] = [];
  const t0 = Date.now();
  const ev = icsEvents(parseFeed(cal(evil)), window(), "Evil", (w) => warned.push(w));
  assert.ok(Date.now() - t0 < 1000, `quick (${Date.now() - t0} ms)`);
  assert.deepEqual(ev.map((e) => e.title), ["Real", "Hourly", "Hourly", "Hourly"]);
  assert.equal(warned.filter((w) => /repeats too often/.test(w)).length, 1, "one warning for the feed");
});

test("a long series with a COUNT that started years ago still shows today", () => {
  const ev = icsEvents(parseFeed(cal(
    "BEGIN:VEVENT", "UID:since-2010", "DTSTART:20100101T090000Z", "DTEND:20100101T091500Z", "RRULE:FREQ=DAILY;COUNT=10000", "SUMMARY:Diario", "END:VEVENT",
  )), window(), "Casa");
  assert.equal(ev.length, 10);
  assert.ok(ev.every((e) => e.title === "Diario"));
});

test("a changed occurrence named by its day (RECURRENCE-ID;VALUE=DATE) replaces it; RANGE=THISANDFUTURE changes every one from there on", () => {
  const w = { from: at("2026-11-16T00:00:00Z"), to: at("2026-11-22T00:00:00Z"), timeZone: ZONE };
  const hm = (e: CalEvent) => new Intl.DateTimeFormat("sv-SE", { timeZone: ZONE, dateStyle: "short", timeStyle: "short" }).format(e.start);
  const byDay = icsEvents(parseFeed(cal(
    "BEGIN:VEVENT", "UID:a", "DTSTART;TZID=Europe/Madrid:20261116T100000", "DTEND;TZID=Europe/Madrid:20261116T110000", "RRULE:FREQ=DAILY;COUNT=5", "SUMMARY:Daily", "END:VEVENT",
    "BEGIN:VEVENT", "UID:a", "RECURRENCE-ID;VALUE=DATE:20261118", "DTSTART;TZID=Europe/Madrid:20261118T150000", "DTEND;TZID=Europe/Madrid:20261118T160000", "SUMMARY:Daily (moved)", "END:VEVENT",
  )), w, "Work");
  assert.deepEqual(byDay.map((e) => `${hm(e)} ${e.title}`), [
    "2026-11-16 10:00 Daily", "2026-11-17 10:00 Daily", "2026-11-18 15:00 Daily (moved)", "2026-11-19 10:00 Daily", "2026-11-20 10:00 Daily",
  ], "the 18th's 10:00 is gone, not left beside its new time");
  assert.equal(byDay[2]!.id, `a@${at("2026-11-18T09:00:00Z")}`, "its id is the occurrence's");
  const future = icsEvents(parseFeed(cal(
    "BEGIN:VEVENT", "UID:b", "DTSTART;TZID=Europe/Madrid:20261116T100000", "DTEND;TZID=Europe/Madrid:20261116T110000", "RRULE:FREQ=DAILY;COUNT=5", "SUMMARY:Daily", "END:VEVENT",
    "BEGIN:VEVENT", "UID:b", "RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Madrid:20261118T100000", "DTSTART;TZID=Europe/Madrid:20261118T150000",
    "DTEND;TZID=Europe/Madrid:20261118T160000", "SUMMARY:Daily (later)", "END:VEVENT",
  )), w, "Work");
  assert.deepEqual(future.map((e) => `${hm(e)} ${e.title}`), [
    "2026-11-16 10:00 Daily", "2026-11-17 10:00 Daily", "2026-11-18 15:00 Daily (later)", "2026-11-19 15:00 Daily (later)", "2026-11-20 15:00 Daily (later)",
  ]);
  assert.equal(new Set(future.map((e) => e.id)).size, 5, "each keeps an id of its own");
});

// ---------- the source and the core ----------

interface Served {
  status?: number;
  body?: string;
  etag?: string;
  throws?: Error;
}

function rig(o: { feeds: Record<string, Served | (() => Served)>; now?: number; remind?: number; zoho?: CalendarSource }) {
  const clock = { now: o.now ?? NOW };
  const asked: { url: string; headers: Record<string, string> }[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    asked.push({ url, headers });
    const got = o.feeds[url];
    const s = typeof got === "function" ? got() : got;
    if (!s) return new Response("nope", { status: 404 });
    if (s.throws) throw s.throws;
    if (s.etag && headers["if-none-match"] === s.etag) return new Response(null, { status: 304 });
    return new Response(s.body ?? "", { status: s.status ?? 200, headers: s.etag ? { etag: s.etag } : {} });
  }) as typeof fetch;
  const logged: string[] = [];
  const control = { log: (_k: string, text: string) => void logged.push(text) } as unknown as Control;
  const errs: string[] = [];
  const log = (text: string) => void errs.push(text);
  const urls = Object.keys(o.feeds);
  const ics = createIcsSource({ config: { urls }, timeZone: ZONE, fetch: fake, resolve: async () => ["93.184.216.34"], now: () => clock.now, control, log });
  const told: string[] = [];
  const core = createCalendarCore({
    sources: [...(o.zoho ? [o.zoho] : []), ics],
    timing: { remindMinutes: o.remind ?? 10 },
    kv: null,
    timeZone: ZONE,
    control,
    now: () => clock.now,
    log,
    notify: async (t) => void told.push(t),
  });
  return { core, ics, clock, asked, told, logged, errs };
}

const G = "https://calendar.google.com/calendar/ical/owner%40gmail.com/private-0123456789abcdef/basic.ics";
const A = "https://p42-caldav.icloud.com/published/2/MTIzNDU2Nzg5MDEyMzQ1Ng";

test("AGENDA from ICS: Google and Apple together, overlaps marked, all-day first; the label names the hosts only", async () => {
  const r = rig({ feeds: { [G]: { body: GOOGLE }, [A]: { body: APPLE } } });
  assert.equal(r.ics.label, "ICS: calendar.google.com, p42-caldav.icloud.com");
  assert.ok(!r.ics.label.includes("private"));
  const today = await r.core.day(0);
  assert.match(today, /^📅 Today, Sunday 15 November:\n• 10:00–10:30 Dentista\n• 21:00–23:00 Cena \(Casa de Pepe\)$/);
  const tomorrow = await r.core.day(1);
  assert.match(tomorrow, /all day Viaje a Lisboa/);
  assert.match(tomorrow, /08:30–08:45 Stand-up \(Sala 2\)/);
  assert.doesNotMatch(tomorrow, /Comité/, "the EXDATE week");
  assert.match(await r.core.day(8), /12:00–13:00 Comité semanal \(movido\)/, "the moved week at its new time");
});

test("reminders and today's events for the brief from ICS; a moved occurrence is reminded at its new time", async () => {
  const r = rig({ feeds: { [G]: { body: GOOGLE } } });
  r.clock.now = at("2026-11-15T07:05:00Z"); // 08:05 in Madrid
  assert.deepEqual(await r.core.tick(), { reminded: 0 });
  assert.equal(r.told.length, 0, "the calendar never sends a brief of its own (src/brief.ts does)");
  assert.deepEqual((await r.core.today()).map((e) => e.title), ["Dentista"]);
  r.clock.now = at("2026-11-15T08:52:00Z"); // 09:52, the dentist at 10:00
  assert.deepEqual(await r.core.tick(), { reminded: 1 });
  assert.equal(r.told.at(-1), "⏰ In 8 min: Dentista (10:00–10:30)");
  assert.equal((await r.core.tick()).reminded, 0, "once");
  r.clock.now = at("2026-11-23T10:52:00Z"); // 11:52 on the 23rd: the committee moved to 12:00
  assert.equal((await r.core.tick()).reminded, 1);
  assert.equal(r.told.filter((t) => t.startsWith("⏰")).at(-1), "⏰ In 8 min: Comité semanal (movido) (12:00–13:00)");
});

test("fetching: If-None-Match after the first read, every 10 minutes; a failure keeps the last copy and is reported once; never the link", async () => {
  let fail = false;
  const r = rig({ feeds: { [G]: () => (fail ? { status: 500 } : { body: GOOGLE, etag: '"v1"' }) } });
  assert.equal((await r.ics.events()).events.length > 0, true);
  assert.equal(r.asked.length, 1);
  assert.equal(r.asked[0]!.headers["if-none-match"], undefined);
  await r.ics.events();
  assert.equal(r.asked.length, 1, "not again within 10 minutes");
  r.clock.now += 10 * 60_000;
  await r.ics.events();
  assert.equal(r.asked.length, 2);
  assert.equal(r.asked[1]!.headers["if-none-match"], '"v1"');
  fail = true;
  for (let i = 0; i < 3; i++) {
    r.clock.now += 10 * 60_000;
    const got = await r.ics.events();
    assert.ok(got.events.some((e) => e.title === "Dentista"), "the last good copy");
  }
  assert.equal(r.asked.length, 5);
  assert.equal(r.logged.length, 1, "reported once");
  assert.match(r.logged[0]!, /calendar\.google\.com: using the last copy I have/);
  assert.equal(r.errs.length, 1);
  fail = false;
  r.clock.now += 10 * 60_000;
  await r.ics.events();
  assert.match(r.logged.at(-1)!, /can be read again/);
  for (const line of [...r.logged, ...r.errs]) assert.ok(!line.includes("private-0123456789abcdef"), "never the secret part");
});

test("a link never read: an outage said in the agenda, tried again in 2 minutes; a sign-in page, a timeout and a huge body are refused", async () => {
  const r = rig({ feeds: { [G]: { body: "<html>Sign in</html>" } } });
  await assert.rejects(() => r.core.day(0), /no ICS calendar could be read \(calendar\.google\.com\)/);
  assert.match(r.errs[0]!, /not a calendar/);
  r.clock.now += 60_000;
  await r.ics.events().catch(() => undefined);
  assert.equal(r.asked.length, 1);
  r.clock.now += 61_000;
  await r.ics.events().catch(() => undefined);
  assert.equal(r.asked.length, 2, "again after 2 minutes");

  const slow = rig({ feeds: { [G]: { throws: Object.assign(new Error(`timeout at ${G}`), { name: "TimeoutError" }) } } });
  await assert.rejects(() => slow.ics.events());
  assert.match(slow.errs[0]!, /no answer in time/);
  assert.ok(!slow.errs[0]!.includes("private"), "the error's own text (with the link) is not logged");

  const huge = rig({ feeds: { [G]: { body: "BEGIN:VCALENDAR\r\n" + "X".repeat(5 * 1024 * 1024 + 10) } } });
  await assert.rejects(() => huge.ics.events());
  assert.match(huge.errs[0]!, /larger than 5 MB/);
});

test("Zoho and ICS together: one agenda, a meeting in both said once; one failing leaves the other", async () => {
  const shared: CalEvent = { id: "zoho-1@x", title: "dentista", start: at("2026-11-15T09:00:00Z"), end: at("2026-11-15T09:30:00Z"), allDay: false, calendar: "Z" };
  const own: CalEvent = { id: "zoho-2@x", title: "Solo en Zoho", start: at("2026-11-15T16:00:00Z"), end: at("2026-11-15T17:00:00Z"), allDay: false, calendar: "Z" };
  let zohoDown = false;
  const zoho: CalendarSource = { label: "Zoho (eu)", events: async () => {
    if (zohoDown) throw new Error("Zoho down");
    return { events: [shared, own], partial: false };
  } };
  const r = rig({ feeds: { [G]: { body: GOOGLE } }, zoho });
  const today = await r.core.day(0);
  assert.equal((today.match(/Dentista|dentista/g) ?? []).length, 1);
  assert.match(today, /17:00–18:00 Solo en Zoho/);
  assert.equal((await r.core.todayRead()).partial, false);
  zohoDown = true;
  r.clock.now += 6 * 60_000;
  assert.match(await r.core.day(0), /Dentista/);
  assert.equal((await r.core.todayRead()).partial, true, "the brief can say a calendar is missing");
  assert.ok(r.errs.some((e) => e.startsWith("Zoho (eu): Zoho down")));
});

test("Zoho and ICS together: a meeting in both is reminded of once, even when Zoho drops out between ticks", async () => {
  const shared: CalEvent = { id: "zoho-1@x", title: "dentista", start: at("2026-11-15T09:00:00Z"), end: at("2026-11-15T09:30:00Z"), allDay: false, calendar: "Z" };
  let zohoDown = false;
  const zoho: CalendarSource = { label: "Zoho (eu)", events: async () => {
    if (zohoDown) throw new Error("Zoho down");
    return { events: [shared], partial: false };
  } };
  const r = rig({ feeds: { [G]: { body: GOOGLE } }, zoho, now: at("2026-11-15T08:51:00Z") });
  assert.deepEqual(await r.core.tick(), { reminded: 1 });
  zohoDown = true;
  r.clock.now = at("2026-11-15T08:56:30Z");
  assert.match(await r.core.day(0), /Dentista/, "the feed's copy is there now");
  assert.deepEqual(await r.core.tick(), { reminded: 0 });
  assert.equal(r.told.length, 1);
});

test("the calendar's state keeps the brief's old day (briefDay) when it saves its reminders", async () => {
  const m = new Map<string, string>([["calendar-state", JSON.stringify({ reminded: [], briefDay: "2026-11-15" })]]);
  const kv = { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void m.set(k, v) };
  const ev: CalEvent = { id: "a@1", title: "Cita", start: NOW + 5 * 60_000, end: NOW + 35 * 60_000, allDay: false, calendar: "" };
  const core = createCalendarCore({
    sources: [{ label: "x", events: async () => ({ events: [ev], partial: false }) }],
    timing: { remindMinutes: 10 }, kv, timeZone: ZONE, now: () => NOW, log: () => undefined, notify: async () => undefined,
  });
  assert.deepEqual(await core.tick(), { reminded: 1 });
  assert.equal(JSON.parse(m.get("calendar-state")!).briefDay, "2026-11-15");
});

test("Zoho alone is unchanged: createCalendar is the core with Zoho's source, and its log line is shared", () => {
  const config = loadCalendarConfig({ ZOHO_CLIENT_ID: "1000.ABCDEFGHIJ1234567890", ZOHO_CLIENT_SECRET: "0123456789abcdef0123456789abcdef01234567", ZOHO_GRANT_CODE: "1000.grant.code" }).config!;
  const c = createCalendar({ config, kv: null, timeZone: ZONE, notify: async () => undefined, fetch: (async () => new Response("{}")) as typeof fetch });
  assert.equal(c.label, "Zoho (eu)");
  const lines: string[] = [];
  const keep = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    let t = 0;
    const log = calendarLog(() => t);
    log("x");
    log("x");
    t = 3600_001;
    log("x");
    assert.equal(lines.length, 2, "the same line once an hour");
  } finally {
    console.error = keep;
  }
});
