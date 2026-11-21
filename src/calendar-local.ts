// The calendars of this Mac (Apple Calendar: iCloud, Google, Exchange... whatever the person has set up there), as one more source of the
// calendar (src/calendar.ts), beside Zoho and the ICS links: the same agenda, reminders before events, brief and follow-ups' checks.
//
// The Mac app reads them with EventKit, only the calendars the person picked, from two days ago to fourteen ahead, and pushes them here every
// ten minutes and whenever they change (EKEventStoreChanged). Nothing is asked of the Mac from here. What is kept: each event's title, times,
// place and video-call link, and its attendees (address and name, at most 30); never its notes (the link is taken from the notes, then they
// are dropped). It stays in the store
// under "calendar-local" for 30 days after the last push, and goes with the discovery's "forget everything".
//
//   POST /panel/api/calendar/local   { calendars: [id], events: [{ id, calendarId, title, start, end, allDay, location, notes?, url? }] }
//                                    -> { ok, events, restarting? }
//   GET  /panel/api/calendar/local   -> { at, calendars: [{ id, title }], events: number } | {}
//
// Times: ms, seconds, or ISO text with its offset; an all-day event may give its days as "YYYY-MM-DD" (read in the owner's zone,
// src/region.ts), its end being the day after the last one, as EventKit and iCalendar say it.

import express, { type Express } from "express";
import { attendeesOf, type CalEvent, type CalendarSource, dayBounds, joinLink } from "./calendar.ts";
import { guard, isObject, limit, line, localOnly, type RouteAuth } from "./connect-routes.ts";
import type { Control } from "./control.ts";
import type { DiscoveryStore } from "./discovery.ts";
import { timeOf } from "./discovery.ts";
import { texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import { localToEpoch } from "./whatsapp.ts";
import { createLog } from "./log.ts";
import { readJsonRecord } from "./json-record.ts";

const log = createLog("calendar");

export const LOCAL_CALENDAR_KEY = "calendar-local";
const KEEP_SECONDS = 30 * 24 * 3600;
const DAY = 24 * 3600_000;
const PAST_MS = 2 * DAY;
const AHEAD_MS = 14 * DAY;
/** A push older than this: the app is not running, and the agenda says something may be missing. */
const STALE_MS = 30 * 60_000;
const MAX_EVENTS = 3000;
const MAX_CALENDARS = 100;

interface Kept {
  at: number;
  /** The app can change the calendar (src/calendar-writes.ts): a newer app says so in each push. */
  writes?: boolean;
  calendars: { id: string; title: string }[];
  events: (Omit<CalEvent, "calendar"> & { calendarId: string })[];
}

/** One event's time: "YYYY-MM-DD" is the start of that day in the owner's zone; anything else as timeOf reads it. */
function when(v: unknown, timeZone: string): number | null {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return localToEpoch(`${v.trim()} 00:00`, timeZone) ?? dayStart(v.trim(), timeZone);
  return timeOf(v);
}
const dayStart = (date: string, timeZone: string): number | null => {
  const t = Date.parse(`${date}T12:00:00Z`);
  return Number.isFinite(t) ? dayBounds(t, timeZone).start : null;
};

/**
 * An all-day event's day as the app wrote it: "2026-11-17", or "2026-11-17T00:00:00+09:00" (the Mac's own offset), is the 17th wherever the
 * owner's zone is. `midnight`: it is that day's start (an end there is exclusive). Null for a number or anything else.
 */
const dayOf = (v: unknown): { date: string; midnight: boolean } | null => {
  const m = typeof v === "string" ? /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?/.exec(v.trim()) : null;
  return m ? { date: m[1]!, midnight: !m[2] || /^00:00(?::00(?:\.0+)?)?$/.test(m[2]) } : null;
};
const nextDate = (date: string): string => {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().slice(0, 10);
};

/** What the app pushed, read field by field; the events outside the window or of a calendar not picked are dropped. Null when it is not one. */
export function pushOf(raw: unknown, o: { now: number; timeZone: string; titles?: Map<string, string> }): Kept | null {
  if (!isObject(raw) || !Array.isArray(raw.calendars) || !Array.isArray(raw.events)) return null;
  const calendars: Kept["calendars"] = [];
  for (const c of raw.calendars) {
    const id = line(isObject(c) ? c.id : c, 200);
    if (!id || calendars.some((x) => x.id === id)) continue;
    calendars.push({ id, title: line(isObject(c) ? c.title : "", 100) || o.titles?.get(id) || "Mac" });
    if (calendars.length >= MAX_CALENDARS) break;
  }
  const picked = new Set(calendars.map((c) => c.id));
  const events: Kept["events"] = [];
  const seen = new Set<string>();
  for (const e of raw.events) {
    if (events.length >= MAX_EVENTS) break;
    if (!isObject(e)) continue;
    const id = line(e.id, 300);
    const calendarId = line(e.calendarId, 200);
    if (!id || !picked.has(calendarId)) continue;
    const allDay = e.allDay === true;
    // An all-day event's days as the Mac wrote them, in the owner's zone: a Mac in another zone (a trip) must not move it a day.
    const days = allDay ? dayOf(e.start) : null;
    const lastDay = days ? dayOf(e.end) : null;
    const at = days ? when(days.date, o.timeZone) : when(e.start, o.timeZone);
    let end = lastDay ? when(lastDay.midnight ? lastDay.date : nextDate(lastDay.date), o.timeZone) : when(e.end, o.timeZone);
    if (at === null) continue;
    // An all-day event in whole days of the owner's zone: the app sends ISO times and EventKit's end (23:59:59 of the last day), an ICS link
    // ends the same event at the next midnight; both then say it once (the core's key is its start, end and title).
    const start = allDay ? dayBounds(at, o.timeZone).start : at;
    if (end === null || end < start) end = allDay ? start + DAY : start;
    if (allDay) end = end > start ? dayBounds(end - 1, o.timeZone).end : dayBounds(start, o.timeZone).end;
    if (start > o.now + AHEAD_MS + DAY || end < o.now - PAST_MS - DAY) continue;
    // One occurrence of a repeating event has the same identifier as the others in EventKit: its start makes it one of its own.
    const key = `mac:${id}@${start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const location = line(e.location, 200);
    const join = joinLink(e.url, e.location, e.notes);
    // The event's iCalendar UID (newer apps send it): the same meeting from a private link too is told once by it (src/calendar.ts).
    const uid = line(e.uid, 200);
    // The owner's answer to an invitation, as EventKit gives it (the app sends it): one not answered is tagged, a declined one left out.
    const response = e.response === "needs" || e.response === "tentative" || e.response === "declined" ? e.response : undefined;
    const organizer = line(e.organizer, 60);
    // Who the owner meets, for People and meeting prep: the app sends at most 30, kept as addresses that look like one (src/calendar.ts).
    const attendees = attendeesOf(Array.isArray(e.attendees) ? e.attendees : []);
    events.push({
      id: key, calendarId, title: line(e.title, 200), start, end, allDay, ...(uid ? { uid } : {}), ...(response ? { response } : {}),
      ...(organizer ? { organizer } : {}), ...(location ? { location } : {}), ...(join ? { join } : {}),
      ...(attendees.length ? { attendees } : {}),
    });
  }
  return { at: o.now, ...(raw.writes === true ? { writes: true } : {}), calendars, events };
}

/** The Mac event a proposed change means: the one with that title (case and accents aside, either holding the other) at that start. */
export function findLocalEvent(k: Kept, title: string, start: number): { eventId: string; at: number; start: number; end: number; title: string; calendarId: string } | null {
  const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
  const want = fold(title);
  const hits = k.events.filter((e) => Math.abs(e.start - start) < 60_000 && !!want && (fold(e.title) === want || fold(e.title).includes(want) || want.includes(fold(e.title))));
  if (hits.length !== 1) return null;
  const e = hits[0]!;
  // Its key is "mac:<EventKit id>@<start>": the Mac finds the occurrence by both.
  const m = /^mac:(.+)@(-?\d+)$/.exec(e.id);
  return m ? { eventId: m[1]!, at: e.start, start: e.start, end: e.end, title: e.title, calendarId: e.calendarId } : null;
}

export interface LocalCalendar {
  /** The source for the calendar's core (src/calendar.ts). */
  source: CalendarSource;
  /** What was last pushed, or null. Throws when the store does not answer. */
  read(): Promise<Kept | null>;
  write(k: Kept): Promise<void>;
  forget(): Promise<void>;
}

export function createLocalCalendar(d: { kv: Kv; now?: () => number; lang?: () => Lang }): LocalCalendar {
  const now = d.now ?? Date.now;
  const read = async (): Promise<Kept | null> => {
    const raw = await readJsonRecord(d.kv, LOCAL_CALENDAR_KEY);
    if (!raw) return null;
    try {
      const p = raw as Kept;
      return isObject(p) && Array.isArray(p.events) && Array.isArray(p.calendars) && typeof p.at === "number" ? p : null;
    } catch {
      /* not JSON: nothing kept */
      return null;
    }
  };
  return {
    read,
    write: (k) => d.kv.set(LOCAL_CALENDAR_KEY, JSON.stringify(k), KEEP_SECONDS),
    forget: () => d.kv.set(LOCAL_CALENDAR_KEY, "", 1),
    source: {
      label: "Mac",
      events: async () => {
        const kept = await read();
        // Nothing kept: the owner stopped reading this Mac's calendars or forgot them (the source was added at start). A normal state, not a fault:
        // only the store failing makes it one (read throws then).
        if (!kept) return { events: [], partial: false };
        const t = now();
        const titles = new Map(kept.calendars.map((c) => [c.id, c.title]));
        const events: CalEvent[] = kept.events
          .filter((e) => e.end > t - PAST_MS && e.start < t + AHEAD_MS && titles.has(e.calendarId))
          .map(({ calendarId, ...e }) => ({ ...e, calendar: titles.get(calendarId) ?? "Mac" }));
        // The app has not pushed for a while (it is closed): what is here may be out of date.
        return { events, partial: t - kept.at > STALE_MS };
      },
    },
  };
}

/** Synchronously, from the file store's own copy: whether this Mac's calendars were ever pushed (they then start with the calendar). */
export function hasLocalCalendar(kv: unknown): boolean {
  const entries = (kv as { entries?: () => { key: string; value: string }[] }).entries;
  if (typeof entries !== "function") return false;
  try {
    return entries.call(kv).some((e) => e.key === LOCAL_CALENDAR_KEY && e.value.length > 0);
  } catch {
    /* a store whose entries cannot be read: as if empty */
    return false;
  }
}

const T = texts(
  { logFirst: "This Mac's calendars connected: {n}", logNone: "This Mac's calendars are no longer read" },
);

export interface LocalCalendarPanelDeps extends RouteAuth {
  calendar: LocalCalendar;
  timeZone: string;
  lang: () => Lang;
  control?: Control;
  now?: () => number;
  /** For the calendars' names when the push gives ids only. */
  discovery?: DiscoveryStore;
  /** Whether the running calendar reads this source; false: the first push restarts Pako so it does (after the answer has gone). */
  inUse: () => boolean;
  restart?: () => boolean;
  /** After each push: the calendar reads its events again (its five-minute copy would hide a change). */
  changed?: () => void;
}

const PATHS = ["/panel/api/calendar/local"];

export function mountLocalCalendarPanel(app: Express, d: LocalCalendarPanelDeps | null): void {
  if (!d) return localOnly(app, PATHS);
  const now = d.now ?? Date.now;
  /** One restart asked for by this process: one that could not happen is not asked again at every push. */
  let asked = false;
  app.get(PATHS[0]!, guard(d, false), limit(120), async (_req, res) => {
    try {
      const kept = await d.calendar.read();
      res.json(kept ? { at: kept.at, calendars: kept.calendars, events: kept.events.length } : {});
    } catch (err) {
      log.warn(`the kept calendar could not be read: ${(err as Error).message}`);
      res.status(503).json({ error: "store" });
    }
  });
  // The app pushes every ten minutes and at each change; a burst of changes (a calendar synced from scratch) is still well inside this.
  app.post(PATHS[0]!, guard(d, true), limit(60), express.json({ limit: "4mb" }), async (req, res) => {
    let titles: Map<string, string> | undefined;
    try {
      const found = await d.discovery?.read();
      if (found) titles = new Map(found.calendars.map((c) => [c.id, c.title]));
    } catch {
      // the names are a nicety: "Mac" stands in
    }
    const kept = pushOf(req.body, { now: now(), timeZone: d.timeZone, ...(titles ? { titles } : {}) });
    if (!kept) {
      res.status(400).json({ ok: false, error: "bad" });
      return;
    }
    let before: Kept | null = null;
    try {
      before = await d.calendar.read();
      await (kept.calendars.length ? d.calendar.write(kept) : d.calendar.forget());
    } catch (err) {
      log.error(`could not keep this Mac's events: ${(err as Error).name}`);
      res.status(503).json({ ok: false, error: "store" });
      return;
    }
    const say = T(d.lang());
    if (!before?.calendars.length && kept.calendars.length) d.control?.log("calendar", say("logFirst", { n: kept.calendars.length }));
    if (before?.calendars.length && !kept.calendars.length) d.control?.log("calendar", say("logNone"));
    d.changed?.();
    // The calendar was built without this source (no push before the start): it is added by starting again, once.
    const restart = d.restart;
    const restarting = kept.calendars.length > 0 && !d.inUse() && !!restart && !asked;
    if (restarting) asked = true;
    if (restarting) res.on("finish", () => setTimeout(() => void restart!(), 200).unref?.());
    res.json({ ok: true, events: kept.events.length, ...(restarting ? { restarting: true } : {}) });
  });
}
