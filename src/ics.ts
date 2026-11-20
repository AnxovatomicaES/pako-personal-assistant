// Any calendar (Google, Apple, Outlook...) through its secret ICS link, read only: the calendar app publishes the owner's events as one
// iCalendar file at a private address, and Pako reads it every ten minutes. It gives the same CALENDAR, reminders before events, morning
// brief and panel events as Zoho (src/calendar.ts is the core both feed).
//
// The link is a secret (whoever has it reads the whole calendar): it is never logged, shown or sent anywhere but to its own host. The
// panel and the log name the host only.
//
// ical.js parses the file and expands the repeating events, only inside the window the core needs (yesterday to eight days ahead).

import { createHash } from "node:crypto";
import ICAL from "ical.js";
import type { CalEvent, CalendarSource } from "./calendar.ts";
import { attendeesOf, joinLink } from "./calendar.ts";
import type { Control } from "./control.ts";
import { texts, type Lang } from "./i18n.ts";
import { guardedGet, isPrivateHost, type Resolver } from "./restaurants/website.ts";
import { localToEpoch } from "./whatsapp.ts";
import { createLog } from "./log.ts";

const logCalendar = createLog("calendar");

type Env = Record<string, string | undefined>;
type Component = InstanceType<typeof ICAL.Component>;
type Time = InstanceType<typeof ICAL.Time>;
type Recur = InstanceType<typeof ICAL.Recur>;

/** What the owner reads about the links: the log's line when a calendar stops (or starts again) being read, and an event with no title. */
const T = texts(
  {
    noTitle: "(no title)",
    feedFailed: "I couldn't read the calendar at {host}: using the last copy I have",
    feedNever: "I couldn't read the calendar at {host}",
    feedBack: "The calendar at {host} can be read again",
    brokenBrief: "Your calendar “{name}” stopped working: {why} Fix it in Settings, Calendar.",
    "why.badLink": "That isn't a calendar link: it must start with https:// or webcal://.",
    "why.notFound": "Not found (404): the link was reset or removed. Copy the secret iCal address again.",
    "why.forbidden": "Expired or forbidden: the calendar refuses this link. Copy the secret iCal address again.",
    "why.notCalendar": "That's a web page, not a calendar (often a sign-in page, or the calendar's browser address instead of its secret iCal address).",
    "why.unreadable": "The file isn't a calendar Pako can read.",
    "why.tooBig": "The calendar is larger than 5 MB.",
    "why.timeout": "The calendar didn't answer in time. Check the link and the internet connection.",
    "why.unreachable": "The calendar's server can't be reached. Check the link and the internet connection.",
    "why.refused": "That address isn't allowed: only https calendars on the internet, never this computer or the local network.",
    "why.serverError": "The calendar's server failed. Try again in a moment.",
    "help.google": "In Google Calendar on the web: Settings, pick the calendar under “Settings for my calendars”, then “Integrate calendar”, and copy “Secret address in iCal format”.",
    "help.outlook": "In Outlook on the web: Settings, Calendar, Shared calendars, “Publish a calendar”, then copy the ICS link (not the HTML one).",
    "help.icloud": "In the Calendar app on your iPhone or Mac: tap the calendar's info, turn on “Public Calendar”, and copy the webcal:// link it shows.",
  },
);

/**
 * The setting a panel can store on a computer (the "connect" settings card): its name, and that it is a secret (shown masked, kept with the
 * other secrets, never printed). `check` gives the problems with a value, [] when it can be used.
 */
export const ICS_SETTING = {
  name: "CALENDAR_ICS_URL",
  secret: true,
  check: (value: string): string[] => loadIcsConfig({ CALENDAR_ICS_URL: value }).problems,
} as const;

export interface IcsConfig {
  /** The https addresses of the feeds (webcal:// read as https://). */
  urls: string[];
}

const MAX_LINKS = 10;

/** CALENDAR_ICS_URL: one or more links, separated by spaces or commas. The problems never repeat a link (it is a secret): only its place. */
export function loadIcsConfig(env: Env): { config: IcsConfig | null; problems: string[] } {
  const raw = (env.CALENDAR_ICS_URL ?? "").trim();
  if (!raw) return { config: null, problems: [] };
  const parts = raw.split(/[\s,]+/).filter(Boolean);
  const problems: string[] = [];
  const urls: string[] = [];
  if (parts.length > MAX_LINKS) problems.push(`CALENDAR_ICS_URL has ${parts.length} links: ${MAX_LINKS} at most`);
  parts.slice(0, MAX_LINKS).forEach((p, i) => {
    const url = p.replace(/^webcals?:\/\//i, "https://");
    let u: URL | null = null;
    try {
      u = new URL(url);
    } catch {
      // not an address at all
    }
    const which = parts.length > 1 ? `link ${i + 1} of CALENDAR_ICS_URL` : "CALENDAR_ICS_URL";
    // Only https: a secret link sent in clear text would hand the calendar to anyone on the way.
    if (!u || u.protocol !== "https:" || !u.hostname) problems.push(`${which} must be an https:// or webcal:// address (the calendar's secret ICS link)`);
    else if (u.username || u.password) problems.push(`${which} must not carry a user name or password`);
    // A calendar is someone's server on the internet, never this computer or the local network (the feed is read without a person looking).
    else if (isPrivateHost(u.hostname)) problems.push(`${which} must be an address on the internet, not this computer or the local network`);
    else if (!urls.includes(u.href)) urls.push(u.href);
  });
  return problems.length ? { config: null, problems } : { config: { urls }, problems };
}

/** The host of each link, the only part of it Pako ever shows (the panel, the log). */
export const icsHosts = (urls: string[]): string[] => [...new Set(urls.map((u) => new URL(u).host))];

// ---------- time zones ----------

/**
 * Outlook and Exchange write Windows' names for time zones ("W. Europe Standard Time"). The feed usually defines them too (VTIMEZONE), but
 * the real rules (the IANA zone) are more trustworthy than a definition that may stop at some year: the common ones, by their Windows name.
 */
const WINDOWS_ZONES: Record<string, string> = {
  "UTC": "UTC",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "E. Europe Standard Time": "Europe/Chisinau",
  "FLE Standard Time": "Europe/Kiev",
  "GTB Standard Time": "Europe/Bucharest",
  "Turkey Standard Time": "Europe/Istanbul",
  "Russian Standard Time": "Europe/Moscow",
  "Morocco Standard Time": "Africa/Casablanca",
  "W. Central Africa Standard Time": "Africa/Lagos",
  "South Africa Standard Time": "Africa/Johannesburg",
  "Egypt Standard Time": "Africa/Cairo",
  "Israel Standard Time": "Asia/Jerusalem",
  "Arabian Standard Time": "Asia/Dubai",
  "Arab Standard Time": "Asia/Riyadh",
  "India Standard Time": "Asia/Kolkata",
  "China Standard Time": "Asia/Shanghai",
  "Singapore Standard Time": "Asia/Singapore",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Korea Standard Time": "Asia/Seoul",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "New Zealand Standard Time": "Pacific/Auckland",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "US Mountain Standard Time": "America/Phoenix",
  "Pacific Standard Time": "America/Los_Angeles",
  "Alaskan Standard Time": "America/Anchorage",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "Atlantic Standard Time": "America/Halifax",
  "Central Standard Time (Mexico)": "America/Mexico_City",
  "SA Pacific Standard Time": "America/Bogota",
  "Pacific SA Standard Time": "America/Santiago",
  "Argentina Standard Time": "America/Buenos_Aires",
  "E. South America Standard Time": "America/Sao_Paulo",
};

const knownZones = new Map<string, boolean>();
/** Whether the runtime knows this IANA zone. */
const ianaZone = (tz: string): boolean => {
  let ok = knownZones.get(tz);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      ok = true;
    } catch {
      /* a zone this runtime does not know */
      ok = false;
    }
    knownZones.set(tz, ok);
  }
  return ok;
};

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/** A wall-clock time in a zone as a moment. A time that does not exist (the hour the clocks skip) is read with the offset before it, as RFC 5545 says. */
function wallToEpoch(t: { year: number; month: number; day: number; hour: number; minute: number; second: number }, tz: string): number {
  const date = `${t.year}-${pad(t.month)}-${pad(t.day)}`;
  for (let k = 0; k < 3 && t.hour + k < 24; k++) {
    const at = localToEpoch(`${date} ${pad(t.hour + k)}:${pad(t.minute)}`, tz);
    if (at !== null) return at + t.second * 1000;
  }
  return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
}

/** The start of a day in the owner's zone ("2026-11-15"): its midnight, or the first hour that exists (a zone whose clocks change at midnight). */
export function dayStart(date: string, tz: string): number {
  for (let h = 0; h < 4; h++) {
    const at = localToEpoch(`${date} ${pad(h)}:00`, tz);
    if (at !== null) return at;
  }
  return Date.parse(`${date}T00:00:00Z`);
}

/** The calendar date `days` after a date ("2026-11-15" + 1 = "2026-11-16"). */
const addDays = (date: string, days: number): string => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

/**
 * How one property's times become moments: from the zone named by its TZID (an IANA name, a Windows name, the feed's own definition), UTC, or
 * floating (no zone: the owner's). Dates (all-day) are days in the owner's zone, like Zoho's.
 */
function resolver(t: Time, ownerZone: string): (x: Time) => number {
  if (t.isDate) return (x) => dayStart(`${x.year}-${pad(x.month)}-${pad(x.day)}`, ownerZone);
  const zone = t.zone;
  if (zone?.tzid === "UTC" || zone === ICAL.Timezone.utcTimezone) return (x) => Date.UTC(x.year, x.month - 1, x.day, x.hour, x.minute, x.second);
  const named = (zone && zone.tzid !== "floating" ? zone.tzid : (t as unknown as { timezone?: string }).timezone) ?? "";
  const tzid = named.trim().replace(/^"|"$/g, "");
  if (!tzid) return (x) => wallToEpoch(x, ownerZone);
  if (ianaZone(tzid)) return (x) => wallToEpoch(x, tzid);
  const windows = WINDOWS_ZONES[tzid];
  if (windows && ianaZone(windows)) return (x) => wallToEpoch(x, windows);
  // "/mozilla.org/20050126_1/Europe/Berlin" and the like: an IANA name at the end.
  const tail = /([A-Za-z]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)$/.exec(tzid)?.[1];
  if (tail && ianaZone(tail)) return (x) => wallToEpoch(x, tail);
  // The feed's own definition of a zone with a name nobody else knows.
  if (zone && zone.tzid !== "floating" && zone.component) {
    return (x) => {
      const c = x.clone();
      c.zone = zone;
      return c.toUnixTime() * 1000;
    };
  }
  return (x) => wallToEpoch(x, ownerZone);
}

// ---------- reading a feed ----------

export interface IcsWindow {
  /** The first and last moments wanted: an occurrence that ends before `from` or starts at `to` or later is left out. */
  from: number;
  to: number;
  /** The owner's zone: floating times and all-day dates are read in it. */
  timeZone: string;
  lang?: Lang;
  /** The owner's own addresses: their attendee line says whether an invitation was answered (PARTSTAT). */
  me?: string[];
}

/** Most occurrences of one repeating event kept in the window, and most steps taken to find them (a rule every minute must not stall Pako). */
const PER_EVENT = 200;
const STEPS = 5000;
/** A series with a COUNT is walked from its real start (it cannot be fast-forwarded): a daily one since the 1970s still reaches today. */
const COUNT_STEPS = 20_000;
/** Most time spent expanding one feed's repeating events: a rule that slips past the checks below must not stall Pako for long. */
const EXPAND_MS = 2000;
/**
 * Rules no calendar app writes, which ical.js may search one second (or minute) at a time inside a single step: FREQ=SECONDLY;BYMONTH=2 takes
 * seconds to find nothing, and no cap on steps can stop it. Left out with their whole event.
 */
const tooFine = (rule: Recur): boolean => {
  const freq = String(rule.freq ?? "").toUpperCase();
  const parts = (rule.parts ?? {}) as Record<string, unknown[] | undefined>;
  return freq === "SECONDLY" || freq === "MINUTELY" || (freq === "HOURLY" && ["BYMONTH", "BYYEARDAY", "BYWEEKNO", "BYMONTHDAY"].some((k) => parts[k]?.length));
};
/** Most events from one feed in the window. */
const PER_FEED = 3000;

const clean = (s: unknown, max: number): string => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** A short, stable key for an event's UID (UIDs can be long, and they end up in the reminders' state). */
const uidKey = (uid: string): string => (/^[\w.@-]{1,64}$/.test(uid) ? uid : createHash("sha256").update(uid).digest("base64url").slice(0, 22));

/** The parsed feed's root VCALENDAR (ical.js gives several roots for a file with several calendars: their events are read together). */
export function parseFeed(text: string): Component {
  const jcal = ICAL.parse(text) as unknown;
  const roots = (Array.isArray(jcal) && typeof jcal[0] === "string" ? [jcal] : (jcal as unknown[])) as unknown[];
  const comps = roots.map((r) => new ICAL.Component(r as unknown[]));
  if (!comps.length || comps.some((c) => c.name !== "vcalendar")) throw new Error("not an iCalendar file");
  if (comps.length === 1) return comps[0]!;
  const all = new ICAL.Component("vcalendar");
  for (const c of comps) for (const sub of c.getAllSubcomponents()) all.addSubcomponent(sub);
  return all;
}

/**
 * The events of a parsed feed inside the window, one per occurrence: repeating events expanded (RRULE, RDATE), minus EXDATE and cancelled
 * ones, with each RECURRENCE-ID override in place of the occurrence it changes. An occurrence's id is its UID and its original start, so it
 * stays the same when the feed is read again (and when that occurrence is moved).
 */
export function icsEvents(root: Component, w: IcsWindow, calendar = "", warn: (text: string) => void = () => {}): CalEvent[] {
  const lang = w.lang ?? "en";
  const vevents = root.getAllSubcomponents("vevent");
  const masters = new Map<string, Component>();
  const overrides = new Map<string, Map<string, Component>>();
  const loose: Component[] = [];
  for (const v of vevents) {
    const uid = String(v.getFirstPropertyValue("uid") ?? "").trim();
    if (!uid) {
      loose.push(v);
      continue;
    }
    const rid = v.getFirstPropertyValue("recurrence-id") as Time | null;
    if (!rid) {
      // Two masters with one UID (a feed that repeats an event): the one with the higher SEQUENCE.
      const before = masters.get(uid);
      if (!before || Number(v.getFirstPropertyValue("sequence") ?? 0) >= Number(before.getFirstPropertyValue("sequence") ?? 0)) masters.set(uid, v);
      continue;
    }
    let m = overrides.get(uid);
    if (!m) overrides.set(uid, (m = new Map()));
    m.set(occurrenceKey(rid, resolver(rid, w.timeZone)), v);
  }

  const out: CalEvent[] = [];
  const deadline = Date.now() + EXPAND_MS;
  const once = new Set<string>();
  const warnOnce = (text: string): void => {
    if (once.has(text)) return;
    once.add(text);
    warn(text);
  };
  const cancelled = (v: Component): boolean => String(v.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED";
  // The owner's addresses: the ones Pako knows, and the calendar's own name when it is one (Google names a calendar by its address).
  const me = new Set([...(w.me ?? []), calendar].map((x) => x.trim().toLowerCase()).filter((x) => x.includes("@")));
  /** The owner's answer on their own attendee line; none when the feed does not list them (an event they made themselves). */
  const responseOf = (v: Component): CalEvent["response"] | undefined => {
    if (!me.size) return undefined;
    const mine = v.getAllProperties("attendee").find((p) => me.has(String(p.getFirstValue() ?? "").replace(/^mailto:/i, "").trim().toLowerCase()));
    const ps = String(mine?.getParameter("partstat") ?? "").toUpperCase();
    return ps === "NEEDS-ACTION" ? "needs" : ps === "TENTATIVE" ? "tentative" : ps === "DECLINED" ? "declined" : undefined;
  };

  /** One occurrence as Pako's event, or null when it is outside the window. */
  const make = (v: Component, id: string, start: Time, at: (x: Time) => number, span: Span): CalEvent | null => {
    const s = at(start);
    const allDay = start.isDate;
    const end = allDay ? dayStart(addDays(`${start.year}-${pad(start.month)}-${pad(start.day)}`, Math.max(1, span.days)), w.timeZone) : s + span.ms;
    if (end <= w.from || s >= w.to) return null;
    const location = clean(v.getFirstPropertyValue("location"), 2000);
    const description = String(v.getFirstPropertyValue("description") ?? "").slice(0, 20_000);
    const url = String(v.getFirstPropertyValue("url") ?? "");
    const join = joinLink(location, url, description);
    const made = v.getFirstPropertyValue("created") as Time | null;
    const created = made && typeof made === "object" && "toUnixTime" in made ? made.toUnixTime() * 1000 : NaN;
    const attendees = attendeesOf(v.getAllProperties("attendee").slice(0, 60).map((p) => ({ email: String(p.getFirstValue() ?? ""), name: p.getParameter("cn") })));
    // The event's own UID: the same meeting on this Mac's calendar and in this feed is told once by it (src/calendar.ts).
    const uid = clean(v.getFirstPropertyValue("uid"), 200);
    const answer = responseOf(v);
    const org = v.getFirstProperty("organizer");
    const organizer = org ? clean(org.getParameter("cn") || String(org.getFirstValue() ?? "").replace(/^mailto:/i, ""), 60) : "";
    return {
      id,
      ...(uid ? { uid } : {}),
      ...(answer ? { response: answer } : {}),
      ...(organizer && !me.has(organizer.toLowerCase()) ? { organizer } : {}),
      title: clean(v.getFirstPropertyValue("summary"), 150) || T(lang)("noTitle"),
      start: s,
      end: Math.max(end, s),
      allDay,
      calendar,
      ...(location && !/^https?:\/\//i.test(location) ? { location: location.slice(0, 120) } : {}),
      ...(join ? { join: join.slice(0, 300) } : {}),
      ...(Number.isFinite(created) ? { created } : {}),
      ...(attendees.length ? { attendees } : {}),
    };
  };

  const single = (v: Component, uid: string): void => {
    const start = v.getFirstPropertyValue("dtstart") as Time | null;
    if (!start || cancelled(v)) return;
    const at = resolver(start, w.timeZone);
    const e = make(v, `${uidKey(uid)}@${occurrenceKey(start, at)}`, start, at, span(v, start, at, w.timeZone));
    if (e) out.push(e);
  };

  for (const [uid, master] of masters) {
    if (out.length >= PER_FEED) break;
    try {
      const start = master.getFirstPropertyValue("dtstart") as Time | null;
      if (!start) continue;
      const own = overrides.get(uid);
      // A cancelled series is gone, with its changed occurrences.
      if (cancelled(master)) {
        overrides.delete(uid);
        continue;
      }
      const rules = master.getAllProperties("rrule").map((p) => p.getFirstValue() as Recur);
      const rdates = master.getAllProperties("rdate").flatMap((p) => p.getValues() as unknown[]);
      if (!rules.length && !rdates.length) {
        // A single event with an override: the override (read below) replaces it.
        if (!own?.size) single(master, uid);
        continue;
      }
      const at = resolver(start, w.timeZone);
      const length = span(master, start, at, w.timeZone);
      const skip = new Set<string>();
      for (const p of master.getAllProperties("exdate")) {
        for (const x of p.getValues() as Time[]) {
          if (!x || typeof x !== "object" || !("isDate" in x)) continue;
          skip.add(occurrenceKey(x, resolver(x, w.timeZone)));
          // A day (VALUE=DATE) on a timed series: that day's occurrence, on the series' own clock.
          if (x.isDate && !start.isDate) skip.add(`day:${x.year}${pad(x.month)}${pad(x.day)}`);
        }
      }
      const occurrences = new Map<string, Time>();
      // The window, in the start's own terms: an occurrence starting before `from - length` cannot reach the window.
      const earliest = w.from - Math.max(length.ms, length.days * 24 * 3600_000) - 24 * 3600_000;
      for (const rule of rules) {
        if (tooFine(rule)) {
          warnOnce(`a repeating event of ${calendar || "a calendar"} repeats too often and was left out`);
          continue;
        }
        let kept = 0;
        let steps = 0;
        const { first, synthetic } = fastForward(rule, start, at, earliest);
        // UNTIL is compared here, as a moment: ical.js compares it with the occurrence's wall-clock time, read as UTC when the zone has no
        // VTIMEZONE in the feed (the series' last occurrence was lost east of UTC). A day as UNTIL on a timed series counts that whole day.
        const untilAt = until(rule, start, at);
        const walk = Number.isFinite(untilAt) ? rule.clone() : rule;
        if (walk !== rule) walk.until = null;
        const it = walk.iterator(first);
        for (let x = it.next(); x; x = it.next()) {
          if (Date.now() > deadline) {
            warnOnce(`${calendar || "a calendar"} took too long to read: some repeating events were left out`);
            break;
          }
          if (++steps > (rule.count ? COUNT_STEPS : STEPS)) {
            warn(`a repeating event of ${calendar || "a calendar"} has too many occurrences: the rest were left out`);
            break;
          }
          if (synthetic && steps === 1) continue;
          const s = at(x);
          if (s > untilAt || s >= w.to) break;
          if (s < earliest) continue;
          occurrences.set(occurrenceKey(x, at), x.clone());
          if (++kept >= PER_EVENT) break;
        }
      }
      for (const r of rdates) {
        // An RDATE is a time or a period (its start).
        const x = (r && typeof r === "object" && "start" in r ? (r as { start: Time }).start : r) as Time | null;
        if (!x || typeof x !== "object" || !("isDate" in x)) continue;
        const ra = resolver(x, w.timeZone);
        if (ra(x) < w.to && ra(x) >= earliest) occurrences.set(occurrenceKey(x, ra), x);
      }
      for (const [key, x] of occurrences) {
        if (skip.has(key) || skip.has(`day:${x.year}${pad(x.month)}${pad(x.day)}`)) continue;
        const changed = own?.get(key);
        if (changed) continue; // the override below takes its place
        const e = make(master, `${uidKey(uid)}@${key}`, x, at, length);
        if (e) out.push({ ...e, recurring: true });
      }
    } catch (err) {
      warn(`an event of ${calendar || "a calendar"} could not be read and was skipped: ${(err as Error).message}`);
    }
  }
  // The changed occurrences (moved, retitled), each at its own time, and those whose series is not in the feed (an invitation to one occurrence).
  for (const [uid, own] of overrides) {
    for (const [key, v] of own) {
      try {
        const start = v.getFirstPropertyValue("dtstart") as Time | null;
        if (!start || cancelled(v)) continue;
        const at = resolver(start, w.timeZone);
        const e = make(v, `${uidKey(uid)}@${key}`, start, at, span(v, start, at, w.timeZone));
        // A changed occurrence of a series in the feed is still one of a repeating event.
        if (e) out.push(masters.has(uid) ? { ...e, recurring: true } : e);
      } catch (err) {
        warn(`a changed event of ${calendar || "a calendar"} could not be read and was skipped: ${(err as Error).message}`);
      }
    }
  }
  for (const v of loose) {
    try {
      // No UID (not allowed, but seen): a key from what it says, so it is still the same event at the next read.
      const start = v.getFirstPropertyValue("dtstart") as Time | null;
      const uid = `nouid-${createHash("sha256").update(`${v.getFirstPropertyValue("summary") ?? ""}|${start?.toString() ?? ""}`).digest("base64url").slice(0, 16)}`;
      single(v, uid);
    } catch (err) {
      warn(`an event of ${calendar || "a calendar"} could not be read and was skipped: ${(err as Error).message}`);
    }
  }
  if (out.length > PER_FEED) warn(`${calendar || "a calendar"} has more than ${PER_FEED} events in the next days: the rest were left out`);
  return out.sort((a, b) => a.start - b.start).slice(0, PER_FEED);
}

/** How long one event lasts: in days for an all-day one (its end is that many midnights later), else in milliseconds. */
interface Span {
  days: number;
  ms: number;
}

function span(v: Component, start: Time, at: (x: Time) => number, ownerZone: string): Span {
  const end = v.getFirstPropertyValue("dtend") as Time | null;
  const duration = v.getFirstPropertyValue("duration") as InstanceType<typeof ICAL.Duration> | null;
  if (start.isDate) {
    if (end && typeof end === "object" && "isDate" in end) {
      const days = Math.round((Date.UTC(end.year, end.month - 1, end.day) - Date.UTC(start.year, start.month - 1, start.day)) / 86_400_000);
      return { days: Math.max(1, days), ms: 0 };
    }
    if (duration) return { days: Math.max(1, Math.round(duration.toSeconds() / 86_400)), ms: 0 };
    return { days: 1, ms: 0 };
  }
  if (end && typeof end === "object" && "isDate" in end) return { days: 0, ms: Math.max(0, resolver(end, ownerZone)(end) - at(start)) };
  if (duration) return { days: 0, ms: Math.max(0, duration.toSeconds() * 1000) };
  return { days: 0, ms: 0 };
}

/**
 * A rule's UNTIL as a moment (Infinity without one): a time in UTC or in a zone as it says, a day on a timed series as the end of that day on
 * the series' clock. An all-day series' day is left to ical.js (both are days).
 */
function until(rule: Recur, start: Time, at: (x: Time) => number): number {
  const u = rule.until as Time | null | undefined;
  if (!u || typeof u !== "object" || !("isDate" in u) || start.isDate) return Infinity;
  if (u.isDate) {
    const end = start.clone();
    end.year = u.year;
    end.month = u.month;
    end.day = u.day;
    end.hour = 23;
    end.minute = 59;
    end.second = 59;
    return at(end);
  }
  return u.zone?.tzid === "UTC" || u.zone === ICAL.Timezone.utcTimezone ? Date.UTC(u.year, u.month - 1, u.day, u.hour, u.minute, u.second) : at(u);
}

/** An occurrence's key: its day for an all-day one, else its moment. EXDATE and RECURRENCE-ID are matched by it, whatever zone each is written in. */
function occurrenceKey(x: Time, at: (t: Time) => number): string {
  return x.isDate ? `${x.year}${pad(x.month)}${pad(x.day)}` : String(at(x));
}

/**
 * A long-running series (a daily meeting since 2015) would take thousands of steps to reach today. Without a COUNT (which counts from the
 * real start), the rule repeats in whole periods: starting it a whole number of periods later gives the same occurrences from there on. The
 * new start itself may not fit the rule (the iterator always gives it first): it is "synthetic", and skipped. It is put two periods before
 * the window, so nothing near the window depends on it.
 */
function fastForward(rule: Recur, start: Time, at: (x: Time) => number, earliest: number): { first: Time; synthetic: boolean } {
  const interval = Math.max(1, rule.interval || 1);
  const behind = earliest - at(start);
  if (rule.count || behind <= 0) return { first: start, synthetic: false };
  const freq = String(rule.freq ?? "").toUpperCase();
  const unitMs: Record<string, number> = { SECONDLY: 1000, MINUTELY: 60_000, HOURLY: 3600_000, DAILY: 86_400_000, WEEKLY: 7 * 86_400_000 };
  const first = start.clone();
  if (unitMs[freq]) {
    const period = unitMs[freq]! * interval;
    const k = Math.floor(behind / period) - 2;
    if (k <= 0) return { first: start, synthetic: false };
    const seconds = (k * period) / 1000;
    // Days and seconds apart: a whole-day step keeps the wall-clock time across the clock changes.
    if (freq === "DAILY" || freq === "WEEKLY") first.adjust(seconds / 86_400, 0, 0, 0);
    else first.adjust(0, 0, 0, seconds);
    return { first, synthetic: true };
  }
  // Months and years: only when the start's day exists in every month (or year) it may land on.
  const months = freq === "MONTHLY" ? interval : freq === "YEARLY" ? 12 * interval : 0;
  if (!months || start.day > 28) return { first: start, synthetic: false };
  const k = Math.floor(behind / (months * 31 * 86_400_000)) - 2;
  if (k <= 0) return { first: start, synthetic: false };
  const total = start.year * 12 + (start.month - 1) + k * months;
  first.year = Math.floor(total / 12);
  first.month = (total % 12) + 1;
  return { first, synthetic: true };
}

// ---------- the source: fetching the feeds ----------

/** Fetched again after this long (with If-None-Match / If-Modified-Since: an unchanged calendar costs one short answer). */
const EVERY_MS = 10 * 60_000;
/** A feed never read yet is tried again sooner. */
const RETRY_MS = 2 * 60_000;
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

export interface IcsDeps {
  config: IcsConfig;
  timeZone: string;
  fetch?: typeof fetch;
  now?: () => number;
  lang?: () => Lang;
  control?: Control;
  /** The calendar's own log line, once an hour for the same text (src/calendar.ts calendarLog). */
  log?: (text: string) => void;
  /** The name lookup each hop's host is checked with (src/restaurants/website.ts checkUrl): every address must be public. */
  resolve?: Resolver;
  /** The owner's own addresses (their mailbox, their Zoom): whether an invitation was answered is read from their attendee line. */
  me?: () => string[];
}

/**
 * Why a link could not be read, as the panel names it: a link that was never the calendar's secret address (a page, a sign-in), one that was
 * reset or removed, one the server refuses, one that does not answer. Only the kind: the link itself is the secret and is never repeated.
 */
export type IcsWhy = "badLink" | "notFound" | "forbidden" | "notCalendar" | "unreadable" | "tooBig" | "timeout" | "unreachable" | "refused" | "serverError";

const failed = (why: IcsWhy, message: string): Error & { why: IcsWhy } => Object.assign(new Error(message), { why });
export const whyOf = (err: unknown): IcsWhy => {
  const w = (err as { why?: unknown } | null)?.why;
  return typeof w === "string" ? (w as IcsWhy) : "unreachable";
};

interface Feed {
  url: string;
  /** A short id for the panel (a hash of the link): which row to remove, never the link. */
  id: string;
  host: string;
  /** The last failure, until the feed is read again: shown on its row, and once in the brief. */
  error: { why: IcsWhy; since: number } | null;
  /** The failure already said in the brief (its `since`). */
  told: number;
  /** The last read that worked (0: none since Pako started). */
  okAt: number;
  etag: string;
  modified: string;
  root: Component | null;
  name: string;
  version: number;
  fetchedAt: number;
  failing: boolean;
  running: Promise<void> | null;
  expanded: { key: string; events: CalEvent[] } | null;
}

/** The body, read up to the size cap: a link that returns something huge (or never ends) must not fill the memory. */
async function readCapped(r: Response): Promise<string> {
  const declared = Number(r.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    await r.body?.cancel().catch(() => undefined);
    throw failed("tooBig", `the calendar is larger than ${MAX_BYTES / 1024 / 1024} MB`);
  }
  if (!r.body) return "";
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw failed("tooBig", `the calendar is larger than ${MAX_BYTES / 1024 / 1024} MB`);
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

/** A link's id for the panel: a short hash, the same at every start (the link itself never leaves the server). */
export const icsId = (url: string): string => createHash("sha256").update(url).digest("hex").slice(0, 12);

interface Got {
  /** Null: unchanged since the copy Pako has (304). */
  root: Component | null;
  name: string;
  etag: string;
  modified: string;
}

/**
 * One read of a link: every hop checked (a public host, https), redirects never followed blindly, a size cap and a timeout. Throws an error
 * whose `why` names the kind of failure; its text never carries the link.
 */
async function getFeed(
  url: string,
  o: { fetch?: typeof fetch; resolve?: Resolver; etag?: string; modified?: string; timeoutMs?: number },
): Promise<Got> {
  const headers: Record<string, string> = { accept: "text/calendar, text/plain;q=0.9, */*;q=0.5", "user-agent": "Pako calendar reader" };
  if (o.etag) headers["if-none-match"] = o.etag;
  if (o.modified) headers["if-modified-since"] = o.modified;
  let r: Response;
  try {
    // A redirect to plain http would carry the rest of the calendar in clear text: refused before it is asked, like a private address.
    ({ res: r } = await guardedGet(url, {
      ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.resolve ? { resolve: o.resolve } : {}), headers, signal: AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS), https: true, anyPort: true,
    }));
  } catch (err) {
    // Only the kind of failure: an error's text may carry the address, and the address is the secret.
    const e = err as Error & { code?: string; cause?: { code?: string } };
    const ours = new RegExp("^(it was redirected to an address without https|host is not a public address|too many redirects"
      + "|HTTP \\d+ with no address to go to|non-standard port|credentials in URL|only http\\(s\\) URLs)$");
    if (e.name === "TimeoutError" || e.name === "AbortError") throw failed("timeout", "no answer in time");
    if (ours.test(e.message)) throw failed("refused", e.message);
    throw failed("unreachable", e.cause?.code ?? e.code ?? "no answer");
  }
  if (r.status === 304 && (o.etag || o.modified)) {
    await r.body?.cancel().catch(() => undefined);
    return { root: null, name: "", etag: o.etag ?? "", modified: o.modified ?? "" };
  }
  if (!r.ok) {
    await r.body?.cancel().catch(() => undefined);
    const why: IcsWhy = r.status === 404 || r.status === 410 ? "notFound" : r.status === 401 || r.status === 403 ? "forbidden" : "serverError";
    throw failed(why, `HTTP ${r.status}${why === "notFound" || why === "forbidden" ? " (the link may have been reset: copy it again)" : ""}`);
  }
  const text = (await readCapped(r)).replace(/^\uFEFF/, "");
  if (!/^\s*BEGIN:VCALENDAR/i.test(text)) throw failed("notCalendar", "the answer is not a calendar (a sign-in page?)");
  let root: Component;
  try {
    root = parseFeed(text);
  } catch (err) {
    throw failed("unreadable", `the calendar could not be read: ${(err as Error).message.slice(0, 120)}`);
  }
  return { root, name: clean(root.getFirstPropertyValue("x-wr-calname"), 60), etag: r.headers.get("etag") ?? "", modified: r.headers.get("last-modified") ?? "" };
}

/** A calendar service the owner may paste a link from: where its secret iCal address is, said when the link pasted is the wrong kind. */
export type IcsProvider = "google" | "outlook" | "icloud";
export function icsProvider(url: string): IcsProvider | null {
  let host = "";
  try {
    host = new URL(url.trim().replace(/^webcals?:\/\//i, "https://")).hostname.toLowerCase();
  } catch {
    /* not a URL: no provider */
    return null;
  }
  if (host === "calendar.google.com" || host.endsWith(".google.com")) return "google";
  if (/^outlook\.(live|office|office365)\.com$/.test(host) || host.endsWith(".outlook.com")) return "outlook";
  if (host === "icloud.com" || host.endsWith(".icloud.com")) return "icloud";
  return null;
}

/** A link of a known service that is plainly not its iCal address (the calendar's web page, a share page): said before it is fetched. */
export function wrongKind(url: string): boolean {
  const p = icsProvider(url);
  let u: URL;
  try {
    u = new URL(url.trim().replace(/^webcals?:\/\//i, "https://"));
  } catch {
    /* not a URL */
    return false;
  }
  const path = u.pathname.toLowerCase();
  if (p === "google") return !path.includes("/ical/");
  if (p === "outlook") return path.endsWith(".html") || !path.includes("/calendar/");
  if (p === "icloud") return u.hostname.toLowerCase() === "www.icloud.com" || u.hostname.toLowerCase() === "icloud.com";
  return false;
}

export type IcsCheck =
  | { ok: true; name: string; host: string; events: number }
  | { ok: false; why: IcsWhy; host: string; provider: IcsProvider | null };

/**
 * A link read once, right when the owner adds it: whether it is a calendar, its name, and how many events it has in the next 30 days. With
 * the same guards as the regular reads (only https, only a public host, a size cap) and a shorter wait.
 */
export async function checkIcsLink(
  raw: string,
  o: { timeZone: string; fetch?: typeof fetch; resolve?: Resolver; now?: () => number; lang?: Lang; timeoutMs?: number },
): Promise<IcsCheck> {
  const c = loadIcsConfig({ CALENDAR_ICS_URL: raw });
  const url = c.config?.urls.length === 1 ? c.config.urls[0]! : null;
  let host = "";
  try {
    host = new URL(raw.trim().replace(/^webcals?:\/\//i, "https://")).host;
  } catch {
    // not an address
  }
  const provider = icsProvider(raw);
  if (!url) return { ok: false, why: "badLink", host, provider };
  try {
    const got = await getFeed(url, { ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.resolve ? { resolve: o.resolve } : {}), timeoutMs: o.timeoutMs ?? 10_000 });
    const now = (o.now ?? Date.now)();
    const w: IcsWindow = { from: now, to: now + 30 * 24 * 3600_000, timeZone: o.timeZone, lang: o.lang ?? "en" };
    const events = got.root ? icsEvents(got.root, w, got.name).length : 0;
    return { ok: true, name: got.name || host, host, events };
  } catch (err) {
    return { ok: false, why: whyOf(err), host, provider };
  }
}

/** What the panel shows of one link: its host and name, never the link; when it was last read, how many events, and why it fails. */
export interface IcsFeedStatus {
  id: string;
  host: string;
  name: string;
  /** The link with its secret part hidden: the host and a few characters of the path, for telling two links of one host apart. */
  masked: string;
  lastSync: number | null;
  events: number;
  error: IcsWhy | null;
  errorSince: number | null;
}

/** The link as the panel may show it: scheme and host, then the path's first and last characters around dots. */
export function maskIcsUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname;
    const shown = path.length > 12 ? `${path.slice(0, 4)}…${path.slice(-4)}` : "/…";
    return `${u.protocol}//${u.host}${shown}`;
  } catch {
    /* not a URL: shown as an ellipsis */
    return "…";
  }
}

export function createIcsSource(d: IcsDeps): CalendarSource & {
  hosts: string[];
  status: () => IcsFeedStatus[];
  brokenNews: (l: Lang) => string | null;
  stale: () => void;
} {
  // Every hop checked (a public host, https), redirects never followed blindly: a feed cannot send Pako to this computer, the local network or
  // a cloud's metadata address. The default fetch checks the address again at connect time.
  const f = d.fetch;
  const now = d.now ?? Date.now;
  const lang = d.lang ?? ((): Lang => "en");
  const log = d.log ?? ((text: string) => logCalendar.error(`${text}`));
  const feeds: Feed[] = d.config.urls.map((url) => ({
    url, id: icsId(url), host: new URL(url).host, error: null, told: 0, okAt: 0, etag: "", modified: "", root: null, name: "", version: 0, fetchedAt: 0, failing: false,
    running: null, expanded: null,
  }));
  const hosts = icsHosts(d.config.urls);

  const fetchFeed = async (feed: Feed): Promise<void> => {
    const t = now();
    try {
      // Each sync checks the link again: one that breaks later (reset, removed, now a sign-in page) is named on its row at once.
      const got = await getFeed(feed.url, {
        ...(f ? { fetch: f } : {}), ...(d.resolve ? { resolve: d.resolve } : {}),
        ...(feed.root && feed.etag ? { etag: feed.etag } : {}), ...(feed.root && feed.modified ? { modified: feed.modified } : {}),
      });
      if (got.root) {
        feed.root = got.root;
        feed.name = got.name || feed.host;
        feed.version++;
        feed.etag = got.etag;
        feed.modified = got.modified;
      }
      feed.error = null;
      feed.okAt = t;
      feed.fetchedAt = t;
      if (feed.failing) {
        feed.failing = false;
        logCalendar.info(`the ICS calendar at ${feed.host} is read again`);
        d.control?.log("calendar", T(lang())("feedBack", { host: feed.host }));
      }
    } catch (err) {
      // A feed that fails keeps its last good copy, and the failure is said once, until it is read again.
      feed.error = { why: whyOf(err), since: feed.error?.since ?? t };
      feed.fetchedAt = feed.root ? t : t - EVERY_MS + RETRY_MS;
      if (!feed.failing) {
        feed.failing = true;
        log(`the ICS calendar at ${feed.host} could not be read (${(err as Error).message})${feed.root ? ": using the last good copy" : ""}`);
        d.control?.log("calendar", T(lang())(feed.root ? "feedFailed" : "feedNever", { host: feed.host }));
      }
    }
  };
  const refresh = (feed: Feed): Promise<void> => {
    // One fetch at a time per feed: the agenda, a tick and the panel asking at once share it.
    if (!feed.running) feed.running = fetchFeed(feed).finally(() => (feed.running = null));
    return feed.running;
  };

  const ymd = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: d.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);

  const events = async (): Promise<{ events: CalEvent[]; partial: boolean }> => {
    const t = now();
    await Promise.all(feeds.filter((x) => t - x.fetchedAt >= EVERY_MS).map(refresh));
    // The window: from the start of yesterday to the end of the eighth day ahead, in the owner's days.
    const today = ymd(t);
    const w: IcsWindow = {
      from: dayStart(addDays(today, -1), d.timeZone), to: dayStart(addDays(today, 9), d.timeZone), timeZone: d.timeZone, lang: lang(), me: d.me?.() ?? [],
    };
    const out: CalEvent[] = [];
    const seen = new Set<string>();
    let read = 0;
    for (const feed of feeds) {
      if (!feed.root) continue;
      read++;
      // Expanded again when the feed changed, the day changed, or the language of "(no title)" did.
      const key = `${feed.version}|${today}|${w.lang}`;
      if (feed.expanded?.key !== key) feed.expanded = { key, events: icsEvents(feed.root, w, feed.name, log) };
      for (const e of feed.expanded.events) {
        // The same event in two of the owner's feeds (an invitation in two calendars) counts once.
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        out.push(e);
      }
    }
    if (!read) throw new Error(`no ICS calendar could be read (${hosts.join(", ")})`);
    return { events: out.sort((a, b) => a.start - b.start), partial: read < feeds.length };
  };

  /** The events each feed gave in its last expansion: the count on its row. */
  const counted = (feed: Feed): number => feed.expanded?.events.length ?? 0;
  const status = (): IcsFeedStatus[] => feeds.map((feed) => ({
    id: feed.id, host: feed.host, name: feed.name || feed.host, masked: maskIcsUrl(feed.url),
    lastSync: feed.okAt || null,
    events: counted(feed), error: feed.error?.why ?? null, errorSince: feed.error?.since ?? null,
  }));
  /**
   * A link that stopped working, said once in the brief (its row says it for as long as it lasts): the first one not told yet, marked told.
   * A link never read since Pako started (a restart) has nothing to say yet.
   */
  const brokenNews = (l: Lang): string | null => {
    const feed = feeds.find((x) => x.error && x.told !== x.error.since);
    if (!feed || !feed.error) return null;
    feed.told = feed.error.since;
    return T(l)("brokenBrief", { name: feed.name || feed.host, why: icsWhyText(feed.error.why, l) });
  };

  /** Every link read again at the next look, whatever its age (the dashboard's refresh). */
  const stale = (): void => {
    for (const feed of feeds) feed.fetchedAt = 0;
  };

  return { label: `ICS: ${hosts.join(", ")}`, hosts, events, status, brokenNews, stale };
}

/** The kind of failure as the owner reads it (the panel's row, the add check, the brief). English only, as Pako's new words are. */
export function icsWhyText(why: IcsWhy, l: Lang = "en"): string {
  return T(l)(`why.${why}` as Parameters<ReturnType<typeof T>>[0]);
}

/** Where the secret iCal address is, for a known service. */
export function icsProviderHelp(p: IcsProvider, l: Lang = "en"): string {
  return T(l)(`help.${p}` as Parameters<ReturnType<typeof T>>[0]);
}
