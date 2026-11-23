// The owner's calendar, read only: Zoho Calendar (https://www.zoho.com/calendar/help/api/, through a Zoho "Self Client" with read scopes
// only, below), any calendar's secret ICS link (src/ics.ts), or both. Each is a source of events; one core does the rest, the same way
// whatever the source:
//
// - CALENDAR (TODAY, TOMORROW) on the chat: the day's events, with overlaps marked; the assistant gets the next week in its context.
// - A few minutes before each timed event, a WhatsApp ("⏰ En 10 min: …").
// - Today's events for the daily brief (src/brief.ts, which says them, with or without this calendar).
// It never creates, changes or answers an event: Zoho's token only has read scopes, and an ICS link can only be read.
//
// Zoho's access without a browser redirect: the owner generates a one-time grant code in Zoho's API console and puts it in Render
// (ZOHO_GRANT_CODE); the server exchanges it at start for a refresh token, which it keeps in the key value store (it does not expire).

import type { Control } from "./control.ts";
import { locale, texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import { localToEpoch } from "./whatsapp.ts";
import type { HealthReport } from "./watchdog.ts";
import { createLog } from "./log.ts";
import { readJsonRecord } from "./json-record.ts";
import { waitLeft } from "./clock.ts";

const logCalendar = createLog("calendar");

type Env = Record<string, string | undefined>;

/** What the owner reads (CALENDAR, the reminder before an event, the log) and the week the assistant's context gets. */
const T = texts(
  {
    allDay: "all day",
    videoCall: "video call",
    clash: "overlaps {other} by {min} min{more}",
    clashMore: " and {n} more",
    today: "Today",
    tomorrow: "Tomorrow",
    nothing: "{title}: nothing on the calendar.",
    noTitle: "(no title)",
    soon: "⏰ In {mins} min: {title} ({start}–{end})",
    logSoon: "Reminder before “{title}”",
  },
);

const DCS: Record<string, { accounts: string; calendar: string }> = {
  com: { accounts: "https://accounts.zoho.com", calendar: "https://calendar.zoho.com" },
  eu: { accounts: "https://accounts.zoho.eu", calendar: "https://calendar.zoho.eu" },
  in: { accounts: "https://accounts.zoho.in", calendar: "https://calendar.zoho.in" },
  "com.au": { accounts: "https://accounts.zoho.com.au", calendar: "https://calendar.zoho.com.au" },
  jp: { accounts: "https://accounts.zoho.jp", calendar: "https://calendar.zoho.jp" },
  ca: { accounts: "https://accounts.zohocloud.ca", calendar: "https://calendar.zohocloud.ca" },
  sa: { accounts: "https://accounts.zoho.sa", calendar: "https://calendar.zoho.sa" },
  uk: { accounts: "https://accounts.zoho.uk", calendar: "https://calendar.zoho.uk" },
};

/** When the owner is told, whatever the source: CALENDAR_REMIND_MINUTES (MORNING_BRIEF is src/brief.ts's). */
export interface CalendarTiming {
  /** Minutes before a timed event to tell the owner; 0 = never. */
  remindMinutes: number;
}

export interface CalendarConfig extends CalendarTiming {
  clientId: string;
  clientSecret: string;
  dc: string;
  /** A one-time grant code to exchange (only until a refresh token is kept). */
  grantCode: string;
  /** A refresh token given directly (otherwise the one kept from the grant code). */
  refreshToken: string;
  /** Calendar names to read (lower case); empty = all of the owner's own calendars. */
  only: string[];
}

export function loadCalendarTiming(env: Env): { timing: CalendarTiming | null; problems: string[] } {
  const problems: string[] = [];
  const raw = (env.CALENDAR_REMIND_MINUTES ?? "").trim();
  const remindMinutes = raw === "" ? 10 : Number(raw);
  if (!Number.isInteger(remindMinutes) || remindMinutes < 0 || remindMinutes > 240) problems.push("CALENDAR_REMIND_MINUTES must be a whole number from 0 to 240");
  return problems.length ? { timing: null, problems } : { timing: { remindMinutes }, problems };
}

/** Zoho's settings (null when its Client ID and Secret are not set), with the timing every source shares. */
export function loadCalendarConfig(env: Env): { config: CalendarConfig | null; problems: string[] } {
  const clientId = (env.ZOHO_CLIENT_ID ?? "").trim();
  const clientSecret = (env.ZOHO_CLIENT_SECRET ?? "").trim();
  if (!clientId && !clientSecret) return { config: null, problems: [] };
  const problems: string[] = [];
  const dc = (env.ZOHO_DC ?? "eu").trim().toLowerCase().replace(/^\./, "");
  if (!/^1000\.[A-Z0-9]{10,}$/i.test(clientId)) problems.push("ZOHO_CLIENT_ID must be the Self Client's Client ID (it starts with 1000.)");
  if (!/^[a-f0-9]{20,}$/i.test(clientSecret)) problems.push("ZOHO_CLIENT_SECRET must be the Self Client's Client Secret");
  if (!DCS[dc]) problems.push(`ZOHO_DC must be one of ${Object.keys(DCS).join(", ")} (the end of your Zoho address: zoho.eu is eu)`);
  const grantCode = (env.ZOHO_GRANT_CODE ?? "").trim();
  const refreshToken = (env.ZOHO_REFRESH_TOKEN ?? "").trim();
  const only = (env.ZOHO_CALENDARS ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  const timing = loadCalendarTiming(env);
  problems.push(...timing.problems);
  if (problems.length || !timing.timing) return { config: null, problems };
  return { config: { clientId, clientSecret, dc, grantCode, refreshToken, only, ...timing.timing }, problems };
}

/** Zoho's moments: "20261115T090000Z", "20261115T100000+0100", a local "20261115T100000", or a day "20261115". */
export function parseZohoTime(s: string, timeZone: string): { at: number; allDay: boolean } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z|[+-]\d{4})?)?$/.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, zone] = m;
  // A local time that does not exist (the hour the clocks skip) is read with the offset before it, as an ICS feed's: an hour later. A day
  // starts at its midnight, or at the first hour that exists (a zone whose clocks change at midnight).
  const local = (hour: number, minute: string): number | null => {
    for (let k = 0; k < 3 && hour + k < 24; k++) {
      const at = localToEpoch(`${y}-${mo}-${d} ${String(hour + k).padStart(2, "0")}:${minute}`, timeZone);
      if (at !== null) return at;
    }
    return null;
  };
  if (h === undefined) {
    const at = local(0, "00");
    return at === null ? null : { at, allDay: true };
  }
  if (zone) {
    const offset = zone === "Z" ? 0 : (zone[0] === "-" ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
    return { at: Date.UTC(+y!, +mo! - 1, +d!, +h, +mi!, +sec!) - offset * 60_000, allDay: false };
  }
  const at = local(+h, mi!);
  return at === null ? null : { at, allDay: false };
}

export interface CalEvent {
  id: string;
  /** The event's own UID (iCalendar's, or EventKit's external id): the same meeting from two sources is told once by it. */
  uid?: string;
  /**
   * The owner's answer to an invitation, when the source says it: "needs" (invited, not answered yet), "tentative" or "declined". A declined
   * event is left out everywhere; one not answered is shown with its tag and named in the brief (answering is itself a small promise).
   */
  response?: "needs" | "tentative" | "declined";
  /** Who invited the owner (the organizer's name or address), for "Ana invited you to …". */
  organizer?: string;
  /** Known only from an invitation mail so far (src/invites.ts): the calendar has not shown it yet. */
  invited?: "email";
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  calendar: string;
  location?: string;
  /** The video call's join link found in the invitation (Zoom, Google Meet, Teams), if any. */
  join?: string;
  /** One occurrence of a repeating event. */
  recurring?: boolean;
  /** When the event was created (ms), when the feed says. */
  created?: number;
  /** Who was invited (an address, and a name when the feed gives one), at most 30: the people's identities (src/people-graph.ts). */
  attendees?: { email: string; name?: string }[];
}

/** An event's attendees as kept: addresses only that look like one, a short name, at most 30, no repeats. */
export function attendeesOf(list: { email?: unknown; name?: unknown }[]): { email: string; name?: string }[] {
  const out: { email: string; name?: string }[] = [];
  for (const a of list) {
    const email = String(a.email ?? "").replace(/^mailto:/i, "").trim().toLowerCase();
    if (!/^[^\s@<>"]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/.test(email) || out.some((x) => x.email === email)) continue;
    const name = typeof a.name === "string" ? a.name.replace(/\s+/g, " ").trim().slice(0, 60) : "";
    out.push({ email, ...(name && name.toLowerCase() !== email ? { name } : {}) });
    if (out.length >= 30) break;
  }
  return out;
}

/** The first video-call join link in an invitation's text: Zoom first (the owner's meetings), then Meet or Teams. */
export function joinLink(...texts: unknown[]): string | undefined {
  const all = texts.filter((t): t is string => typeof t === "string").join(" ");
  // zoom.us itself or one of its subdomains: "evilzoom.us" is not Zoom (the link is shown as one in the agenda, the reminder and the panel's button).
  const zoom = /https:\/\/(?:[a-z0-9-]+\.)*zoom\.us\/(?:j|my|w|s)\/[^\s"'<>)\]]+/i.exec(all);
  if (zoom) return zoom[0];
  return /https:\/\/(?:meet\.google\.com\/[a-z-]+|teams\.microsoft\.com\/l\/meetup-join\/[^\s"'<>)\]]+)/i.exec(all)?.[0];
}

/**
 * For each timed event that overlaps another: the one it overlaps most (its title), by how many minutes, and how many others it overlaps too.
 */
export function clashes(events: CalEvent[]): Map<string, { other: string; minutes: number; more: number }> {
  // A timed event with no length (a marker: "Submit expenses" at 10:30) takes no time: it overlaps nothing, and nothing overlaps it.
  const timed = events.filter((e) => !e.allDay && e.end > e.start);
  const out = new Map<string, { other: string; minutes: number; more: number }>();
  for (const a of timed) {
    const hits = timed.filter((b) => b !== a && b.id !== a.id && b.start < a.end && a.start < b.end)
      .map((b) => ({ other: b.title, minutes: Math.round((Math.min(a.end, b.end) - Math.max(a.start, b.start)) / 60_000) }))
      .sort((x, y) => y.minutes - x.minutes);
    if (hits.length) out.set(a.id, { ...hits[0]!, more: hits.length - 1 });
  }
  return out;
}

/** "overlaps Maya Chen <> Acme by 45 min": which meeting, and by how much, in one clause. */
export function clashText(c: { other: string; minutes: number; more: number }, l: Lang): string {
  const t = T(l);
  const other = c.other.replace(/\s+/g, " ").trim().slice(0, 60) || t("noTitle");
  return t("clash", { min: c.minutes, other, more: c.more ? t("clashMore", { n: c.more }) : "" });
}

/** Events that overlap another timed event, by id. */
export function overlaps(events: CalEvent[]): Set<string> {
  const timed = events.filter((e) => !e.allDay && e.end > e.start).sort((a, b) => a.start - b.start);
  const out = new Set<string>();
  for (let i = 0; i < timed.length; i++)
    for (let j = i + 1; j < timed.length && timed[j]!.start < timed[i]!.end; j++) {
      out.add(timed[i]!.id);
      out.add(timed[j]!.id);
    }
  return out;
}

/**
 * Where events come from (Zoho, an ICS link). `events` gives yesterday to at least a week ahead, sorted or not; `partial` when some of its
 * calendars could not be read this time (the rest still count). It throws when none could.
 */
export interface CalendarSource {
  /** What the panel and the log call it: "Zoho (eu)", "ICS: calendar.google.com" (a host, never a secret link). */
  label: string;
  events: () => Promise<{ events: CalEvent[]; partial: boolean }>;
}

/** The calendar's lines in the log: the same text once an hour, not every minute. Shared by the core and its sources. */
export function calendarLog(now: () => number = Date.now): (text: string) => void {
  let last = { text: "", at: 0 };
  return (text) => {
    if (text === last.text && now() - last.at < 3600_000) return;
    last = { text, at: now() };
    logCalendar.error(`${text}`);
  };
}

export interface ZohoSourceDeps {
  config: CalendarConfig;
  kv: Kv | null;
  timeZone: string;
  fetch?: typeof fetch;
  now?: () => number;
  lang?: () => Lang;
  log: (text: string) => void;
}

const REFRESH_KEY = "zoho-refresh";
const STATE_KEY = "calendar-state";

/** Zoho Calendar as a source: the owner's calendars (or those named in ZOHO_CALENDARS), the next two weeks. */
export function createZohoSource(d: ZohoSourceDeps): CalendarSource {
  const { config } = d;
  const f = d.fetch ?? fetch;
  const now = d.now ?? Date.now;
  const lang = d.lang ?? ((): Lang => "en");
  const dc = DCS[config.dc]!;
  const logOnce = d.log;
  const ymd = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: d.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);

  // ---------- access ----------
  let refresh: string | null = config.refreshToken || null;
  let access: { value: string; until: number } | null = null;
  const token = async (params: Record<string, string>): Promise<Record<string, unknown>> => {
    const r = await f(`${dc.accounts}/oauth/v2/token?${new URLSearchParams(params)}`, { method: "POST", signal: AbortSignal.timeout(10_000) });
    return (await r.json().catch(() => ({}))) as Record<string, unknown>;
  };
  // After a refused or failed token request nothing asks Zoho again for ten minutes: its limit is 10 requests in 10 minutes,
  // and retrying every minute would keep the block going for ever.
  const BLOCKED_MS = 10 * 60_000;
  let blockedUntil = 0;
  let blockedWhy = "";
  let refreshUnsaved = false;
  const blocked = (why: string): never => {
    blockedUntil = now() + BLOCKED_MS;
    blockedWhy = why;
    throw new Error(why);
  };
  const saveRefresh = async (): Promise<void> => {
    if (!d.kv || !refresh) return;
    try {
      await d.kv.set(REFRESH_KEY, refresh, 10 * 365 * 24 * 3600);
      refreshUnsaved = false;
    } catch (err) {
      refreshUnsaved = true; // tried again on the next request: without it, the next restart would need a new grant code
      logCalendar.error(`could not keep the Zoho access yet (retrying): ${(err as Error).message}`);
    }
  };
  const getRefresh = async (): Promise<string> => {
    if (refresh) {
      if (refreshUnsaved) await saveRefresh();
      return refresh;
    }
    if (waitLeft(blockedUntil, BLOCKED_MS, now())) throw new Error(blockedWhy);
    const kept = d.kv ? await d.kv.get(REFRESH_KEY).catch(() => null) : null;
    if (kept) return (refresh = kept);
    if (!config.grantCode) return blocked("no access yet: put a new ZOHO_GRANT_CODE in Render (assistant/README.md, Calendar)");
    const j = await token({ grant_type: "authorization_code", client_id: config.clientId, client_secret: config.clientSecret, code: config.grantCode });
    if (typeof j.refresh_token !== "string") {
      const why = String(j.error ?? "no refresh token");
      return blocked(`Zoho refused the grant code (${why}): it lasts a few minutes; generate a new one and save it in Render at once`);
    }
    refresh = j.refresh_token;
    await saveRefresh();
    if (typeof j.access_token === "string") access = { value: j.access_token, until: now() + (Number(j.expires_in) || 3600) * 1000 - 120_000 };
    logCalendar.info("the grant code was exchanged: access kept (ZOHO_GRANT_CODE can be removed from Render)");
    return refresh;
  };
  const bearer = async (): Promise<string> => {
    if (access && access.until > now()) return access.value;
    const rt = await getRefresh();
    if (access && access.until > now()) return access.value;
    if (waitLeft(blockedUntil, BLOCKED_MS, now())) throw new Error(blockedWhy);
    let j: Record<string, unknown>;
    try {
      j = await token({ grant_type: "refresh_token", client_id: config.clientId, client_secret: config.clientSecret, refresh_token: rt });
    } catch (err) {
      return blocked(`Zoho did not answer the token request: ${(err as Error).message}`);
    }
    if (typeof j.access_token !== "string") return blocked(`Zoho did not refresh the access (${String(j.error ?? "no token")})`);
    access = { value: j.access_token, until: now() + (Number(j.expires_in) || 3600) * 1000 - 120_000 };
    return access.value;
  };
  const get = async (path: string, extra: Record<string, string> = {}): Promise<Record<string, unknown>> => {
    const headers = { authorization: `Zoho-oauthtoken ${await bearer()}`, ...extra };
    const r = await f(`${dc.calendar}/api/v1${path}`, { headers, signal: AbortSignal.timeout(10_000) });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (r.status === 401) access = null; // a refused token is not used again: the next call asks for a new one
    if (!r.ok) throw new Error(`Zoho Calendar ${path.split("?")[0]}: HTTP ${r.status}`);
    return j;
  };

  // ---------- events ----------
  const stamp = (t: number) => new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const events = async (): Promise<{ events: CalEvent[]; partial: boolean }> => {
    const cals = (((await get("/calendars")).calendars ?? []) as { uid?: string; name?: string }[]).filter(
      (c) => typeof c.uid === "string" && (!config.only.length || config.only.includes(String(c.name ?? "").toLowerCase())),
    );
    const t = now();
    const range = encodeURIComponent(JSON.stringify({ start: stamp(t - 24 * 3600_000), end: stamp(t + 14 * 24 * 3600_000) }));
    const out: CalEvent[] = [];
    let failures = 0;
    for (const c of cals) {
      // One calendar that fails (or one odd event) must not take the others down with it: the owner would lose the agenda, the reminders and the brief.
      try {
      type Z = {
        uid?: string;
        title?: string;
        isallday?: boolean;
        /** Zoho marks a repeating event (isrep, rrule). */
        isrep?: boolean;
        rrule?: unknown;
        start?: string;
        end?: string;
        location?: string;
        description?: string;
        url?: string;
        dateandtime?: { start?: string; end?: string; timezone?: string };
        attendees?: { email?: unknown; name?: unknown }[];
      };
      // "application/json+large" makes Zoho include the description, where an invitation keeps its Zoom link.
      const path = `/calendars/${encodeURIComponent(c.uid!)}/events?range=${range}&byinstance=true`;
      const list = ((await get(path, { accept: "application/json+large" })).events ?? []) as Z[];
      for (const e of list) {
        try {
        const startRaw = String(e.dateandtime?.start ?? e.start ?? "");
        const endRaw = String(e.dateandtime?.end ?? e.end ?? "");
        const dateOnly = e.isallday === true || /^\d{8}$/.test(startRaw.trim());
        const tz = dateOnly ? d.timeZone : e.dateandtime?.timezone || d.timeZone;
        const s = parseZohoTime(startRaw, tz);
        let en = parseZohoTime(endRaw, tz);
        if (!s) continue;
        const allDay = dateOnly || s.allDay;
        // An all-day event ends at the next local midnight (a day is 23 or 25 hours long when the clocks change).
        const nextMidnight = (at: number): number => {
          const [yy, mm, dd] = ymd(at).split("-").map(Number) as [number, number, number];
          const next = new Date(Date.UTC(yy, mm - 1, dd + 1)).toISOString().slice(0, 10);
          return localToEpoch(`${next} 00:00`, d.timeZone) ?? at + 24 * 3600_000;
        };
        if (allDay && (!en || en.at <= s.at)) en = { at: nextMidnight(s.at), allDay: true };
        out.push({
          id: `${e.uid ?? ""}@${s.at}`,
          title: String(e.title ?? T(lang())("noTitle")).replace(/\s+/g, " ").slice(0, 150),
          start: s.at,
          end: en ? en.at : s.at + 3600_000,
          allDay,
          calendar: String(c.name ?? ""),
          ...(e.location && !/^https?:\/\//i.test(String(e.location).trim()) ? { location: String(e.location).replace(/\s+/g, " ").slice(0, 120) } : {}),
          ...(() => {
            const join = joinLink(e.location, e.url, e.description);
            return join ? { join: join.slice(0, 300) } : {};
          })(),
          ...(e.isrep === true || (typeof e.rrule === "string" && e.rrule) ? { recurring: true } : {}),
          ...(() => {
            const attendees = attendeesOf(Array.isArray(e.attendees) ? e.attendees : []);
            return attendees.length ? { attendees } : {};
          })(),
        });
        } catch (err) {
          logOnce(`an event of “${c.name ?? "?"}” could not be read and was skipped: ${(err as Error).message}`);
        }
      }
      } catch (err) {
        logOnce(`the calendar “${c.name ?? "?"}” could not be read and was skipped: ${(err as Error).message}`);
        failures++;
      }
    }
    // Every calendar failing is an outage (said as such); some failing is a partial agenda.
    if (cals.length && failures === cals.length) throw new Error("no calendar could be read");
    return { events: out, partial: failures > 0 };
  };

  return { label: `Zoho (${config.dc})`, events };
}

/**
 * Where a local day starts and ends, `offset` days from the day of `t` in the zone: a day is 23 or 25 hours long when the clocks change, and
 * a zone whose clocks change AT midnight has no 00:00 that day (the first hour that exists starts it).
 */
export function dayBounds(t: number, timeZone: string, offset = 0): { start: number; end: number } {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
  const [y, m, dd] = ymd.split("-").map(Number) as [number, number, number];
  const dateOf = (k: number) => new Date(Date.UTC(y, m - 1, dd + k)).toISOString().slice(0, 10);
  const startOf = (date: string): number | null => {
    for (let h = 0; h < 4; h++) {
      const at = localToEpoch(`${date} ${String(h).padStart(2, "0")}:00`, timeZone);
      if (at !== null) return at;
    }
    return null;
  };
  const start = startOf(dateOf(offset)) ?? t;
  return { start, end: startOf(dateOf(offset + 1)) ?? start + 24 * 3600_000 };
}

export interface CalendarCoreDeps {
  /** Where the events come from: Zoho, the ICS links, or both (their events are read together). */
  sources: CalendarSource[];
  timing: CalendarTiming;
  kv: Kv | null;
  timeZone: string;
  /** Tells the owner (src/whatsapp.ts notifyOwner). */
  notify: (text: string) => Promise<unknown>;
  control?: Control;
  now?: () => number;
  /** The language of what it writes (src/i18n.ts), asked each time: always English now, kept as a function so callers need not change. */
  lang?: () => Lang;
  /** The log line, shared with the sources (calendarLog); one of its own without it. */
  log?: (text: string) => void;
  /** The watchdog (src/watchdog.ts): whether each reading of the calendars went through (one that failed is named). */
  health?: HealthReport;
}

/** Zoho alone, as before the sources were split: the same settings, the same behavior. */
export interface CalendarDeps extends Omit<CalendarCoreDeps, "sources" | "timing" | "log"> {
  config: CalendarConfig;
  fetch?: typeof fetch;
}

export function createCalendar(d: CalendarDeps) {
  const log = calendarLog(d.now);
  const zoho = createZohoSource({
    config: d.config, kv: d.kv, timeZone: d.timeZone, log, ...(d.fetch ? { fetch: d.fetch } : {}), ...(d.now ? { now: d.now } : {}), ...(d.lang ? { lang: d.lang } : {}),
  });
  return createCalendarCore({ ...d, sources: [zoho], timing: d.config, log });
}

/**
 * Which reminder an event has had. A source's id stays the same for one occurrence (Zoho's has its start in it); an occurrence that an ICS
 * feed moved keeps its id but has a new start, and the owner must hear about the new time: the start is added then.
 */
const remindKey = (e: CalEvent): string => (e.id.endsWith(`@${e.start}`) ? e.id : `${e.id}>${e.start}`);

export function createCalendarCore(d: CalendarCoreDeps) {
  const config = d.timing;
  const now = d.now ?? Date.now;
  const lang = d.lang ?? ((): Lang => "en");
  // The formats are made once per language and kind (the agenda writes one per event), in the language asked for now.
  const formats = new Map<string, Intl.DateTimeFormat>();
  const fmt = (o: Intl.DateTimeFormatOptions, l: Lang = lang()): Intl.DateTimeFormat => {
    const key = `${l}|${JSON.stringify(o)}`;
    let made = formats.get(key);
    if (!made) formats.set(key, (made = new Intl.DateTimeFormat(locale(l), { timeZone: d.timeZone, ...o })));
    return made;
  };
  const hm = (t: number): string => fmt({ hour: "2-digit", minute: "2-digit" }).format(t);
  const dayName = (t: number): string => fmt({ weekday: "long", day: "numeric", month: "long" }).format(t);
  const logOnce = d.log ?? calendarLog(now);

  // ---------- events, from every source ----------
  // `partial`: a source (or one of Zoho's calendars) could not be read, so something may be missing (the brief says so).
  let cache: { at: number; events: CalEvent[]; partial: boolean } | null = null;
  const load = async (force = false): Promise<CalEvent[]> => (await read(force)).events;
  const read = async (force = false): Promise<{ events: CalEvent[]; partial: boolean }> => {
    if (!force && cache && now() - cache.at < 5 * 60_000) return cache;
    const t = now();
    const results = await Promise.allSettled(d.sources.map((s) => s.events()));
    const out: CalEvent[] = [];
    let partial = false;
    let failed = 0;
    // The same meeting in two sources (this Mac's calendar and a Google feed both have it, or Zoho and a feed) is said once, with the call's
    // link and the place either copy has (an ICS feed may leave out what the Mac's calendar gives). The same by its UID at the same start,
    // or else by its title within a minute of the same start (two sources may round a time differently).
    const byUid = new Map<string, CalEvent>();
    const byTitle = new Map<string, CalEvent[]>();
    const MINUTE = 60_000;
    const twin = (e: CalEvent): CalEvent | undefined => {
      if (e.uid) {
        const same = byUid.get(`${e.uid}|${Math.round(e.start / MINUTE)}`) ?? byUid.get(`${e.uid}|${Math.round(e.start / MINUTE) - 1}`)
          ?? byUid.get(`${e.uid}|${Math.round(e.start / MINUTE) + 1}`);
        if (same && Math.abs(same.start - e.start) <= MINUTE) return same;
      }
      return (byTitle.get(e.title.trim().toLowerCase()) ?? []).find((x) => x.allDay === e.allDay && Math.abs(x.start - e.start) <= MINUTE);
    };
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        failed++;
        if (d.sources.length > 1) logOnce(`${d.sources[i]!.label}: ${(r.reason as Error)?.message ?? String(r.reason)}`);
        return;
      }
      partial ||= r.value.partial;
      for (const e of r.value.events) {
        // Declined: not on the owner's day (the agenda, the reminders, the brief). With several sources one copy may know the answer and
        // another not (a feed that does not list the owner): the declined copy still takes the meeting's place, and is left out at the end.
        if (e.response === "declined" && d.sources.length === 1) continue;
        if (d.sources.length > 1) {
          const first = twin(e);
          if (first) {
            if (!first.join && e.join) first.join = e.join;
            if (!first.location && e.location) first.location = e.location;
            // The owner's answer, from whichever copy knows it: declined wins, then an answer over none (a copy that
            // lags may still say not answered), and who invited them.
            const rank = { declined: 3, tentative: 2, needs: 1 } as const;
            if (e.response && (!first.response || rank[e.response] > rank[first.response])) {
              first.response = e.response;
              if (e.organizer && !first.organizer) first.organizer = e.organizer;
            }
            continue;
          }
          // A copy: the source's own (its cached feed) is never changed.
          const mine = { ...e };
          if (e.uid) byUid.set(`${e.uid}|${Math.round(e.start / MINUTE)}`, mine);
          const k = e.title.trim().toLowerCase();
          byTitle.set(k, [...(byTitle.get(k) ?? []), mine]);
          out.push(mine);
          continue;
        }
        out.push(e);
      }
    });
    const reasons = results.flatMap((r, i) => (r.status === "rejected" ? [`${d.sources[i]!.label}: ${(r.reason as Error)?.message ?? String(r.reason)}`] : []));
    d.health?.(failed === 0, reasons.join("; "));
    // Every source failing is an outage: one source's own reason, or "none could be read".
    if (failed && failed === d.sources.length) {
      const first = results[0];
      throw failed === 1 && first?.status === "rejected" ? (first.reason as Error) : new Error("no calendar could be read");
    }
    const kept = out.filter((e) => e.response !== "declined").sort((a, b) => a.start - b.start);
    // A partial agenda (a calendar failed) is kept for half a minute only, not five: the missing events come back as soon as that calendar does.
    cache = { at: partial || failed ? t - 4.5 * 60_000 : t, events: kept, partial: partial || failed > 0 };
    return cache;
  };

  const line = (e: CalEvent, clash: ReturnType<typeof clashes>): string => {
    const t = T(lang());
    const time = e.allDay ? t("allDay") : `${hm(e.start)}–${hm(e.end)}`;
    const call = e.join ? ` (${/zoom\.us/i.test(e.join) ? "Zoom" : t("videoCall")})` : "";
    const c = clash.get(e.id);
    return `${time} ${e.title}${call}${e.location ? ` (${e.location})` : ""}${c ? ` ⚠️ ${clashText(c, lang())}` : ""}`;
  };

  /** One day's events, offset days from today, as the owner reads them. */
  const day = async (offset: number): Promise<string> => {
    const events = await load();
    const t = T(lang());
    const { start: dayStart, end: dayEnd } = dayBounds(now(), d.timeZone, offset);
    const list = events.filter((e) => e.start < dayEnd && e.end > dayStart);
    const label = offset === 0 ? t("today") : offset === 1 ? t("tomorrow") : "";
    const title = `📅 ${label}${label ? ", " : ""}${dayName(dayStart + 12 * 3600_000)}`;
    if (!list.length) return t("nothing", { title });
    const clash = clashes(list);
    return `${title}:\n${list.map((e) => `• ${line(e, clash)}`).join("\n")}`;
  };

  /** Today's events (any that overlap the owner's local day), for the daily brief (src/brief.ts). Throws when no calendar can be read. */
  const today = async (): Promise<CalEvent[]> => (await todayRead()).events;
  /** The same, saying whether a calendar could not be read (the others' events still come): the brief then says something may be missing. */
  const todayRead = async (): Promise<{ events: CalEvent[]; partial: boolean }> => {
    const { start, end } = dayBounds(now(), d.timeZone);
    const r = await read();
    return { events: r.events.filter((e) => e.start < end && e.end > start), partial: r.partial };
  };

  /** The next week, one line per event, for the assistant's context. */
  const context = async (): Promise<string[]> => {
    const t = now();
    const events = (await load()).filter((e) => e.end > t && e.start < t + 7 * 24 * 3600_000);
    const clash = clashes(events);
    const when = fmt({ weekday: "short", day: "2-digit", month: "2-digit" });
    return events.slice(0, 30).map((e) => `${when.format(e.start)} ${line(e, clash)}`);
  };

  // ---------- reminders before events ----------
  // The brief's day used to be kept here too (briefDay): src/brief.ts still reads it (an older server beside this one during a deploy writes
  // it there), so it is kept as it was read when this state is saved, never dropped.
  let state: { reminded: string[]; briefDay?: string } | null = null;
  /** Throws when the store cannot be read (the next tick tries again): an empty state saved over the real one would repeat reminders. */
  const loadState = async () => {
    if (state) return state;
    const raw = d.kv ? await readJsonRecord(d.kv, STATE_KEY) : null;
    if (state) return state;
    // Already parsed and checked as a record (readJsonRecord): its fields are checked one by one below.
    const p: Partial<{ reminded: unknown; briefDay: unknown }> = raw ?? {};
    state = { reminded: Array.isArray(p.reminded) ? p.reminded.filter((x) => typeof x === "string") : [], ...(typeof p.briefDay === "string" ? { briefDay: p.briefDay } : {}) };
    return state;
  };
  const saveState = async () => {
    if (d.kv && state) await d.kv.set(STATE_KEY, JSON.stringify({ ...state, reminded: state.reminded.slice(-200) }), 30 * 24 * 3600).catch(() => undefined);
  };

  // A tick that is still running (a slow notice) must not be joined by the next one: both would remind of the same event.
  let ticking = false;
  const tick = async (): Promise<{ reminded: number }> => {
    if (ticking) return { reminded: 0 };
    ticking = true;
    try {
      return await tickOnce();
    } finally {
      ticking = false;
    }
  };
  const tickOnce = async (): Promise<{ reminded: number }> => {
    const t = now();
    const s = await loadState();
    let reminded = 0;
    let events: CalEvent[] | null = null;
    try {
      events = await load();
    } catch (err) {
      logOnce((err as Error).message);
    }
    if (config.remindMinutes > 0 && events) {
      // With two sources the same meeting can come from either (one dropping out between ticks lets the other's copy through): its start and
      // title say it is the one already reminded of, whichever id it has.
      const keys = (e: CalEvent): string[] => [remindKey(e), ...(d.sources.length > 1 ? [`c:${e.start}|${e.title.toLowerCase()}`] : [])];
      const soon = events.filter((e) => !e.allDay && e.start > t && e.start - t <= config.remindMinutes * 60_000 && !keys(e).some((k) => s.reminded.includes(k)));
      for (const e of soon) {
        s.reminded.push(...keys(e));
        await saveState();
        const mins = Math.max(1, Math.round((e.start - t) / 60_000));
        const where = `${e.join ? `\n🎥 ${e.join}` : ""}${e.location ? `\n📍 ${e.location}` : ""}`;
        const say = T(lang());
        await d.notify(`${say("soon", { mins, title: e.title, start: hm(e.start), end: hm(e.end) })}${where}`);
        d.control?.log("calendar", say("logSoon", { title: e.title }));
        reminded++;
      }
    }
    return { reminded };
  };

  return {
    day,
    today,
    todayRead,
    context,
    tick,
    load,
    /** All the events, saying whether a calendar could not be read (src/calendar-changes.ts skips such a reading). */
    readAll: () => read(),
    /** What is connected, for the panel: "Zoho (eu)", "ICS: calendar.google.com", or both. */
    label: d.sources.map((s) => s.label).join(" + "),
    start: () => {
      setTimeout(() => void load(true).then(() => logCalendar.info("events read")).catch((err) => logCalendar.error(`${(err as Error).message}`)), 20_000).unref?.();
      setInterval(() => void tick().catch((err) => logOnce((err as Error).message)), 60_000).unref?.();
    },
  };
}

export type CalendarReader = ReturnType<typeof createCalendarCore>;

const INVITES = texts(
  {
    invited: "{who} invited you to {title} {when}, not answered.",
    someone: "Someone",
    today: "today at {time}",
    tomorrow: "tomorrow at {time}",
    todayAllDay: "today",
    tomorrowAllDay: "tomorrow",
  },
);

/**
 * The brief's lines about invitations the owner has not answered, today and tomorrow ("Ana invited you to Budget review today at 15:00, not
 * answered."): answering an invitation is a small promise too. Null when there is none.
 */
export function invitesBrief(events: CalEvent[], nowMs: number, timeZone: string, l: Lang): string | null {
  const today = dayBounds(nowMs, timeZone);
  const tomorrow = dayBounds(today.end + 1000, timeZone);
  const hm = (t: number) => new Intl.DateTimeFormat(locale(l), { timeZone, hour: "2-digit", minute: "2-digit" }).format(t);
  const say = INVITES(l);
  const lines = events
    .filter((e) => e.response === "needs" && e.end > nowMs && e.start < tomorrow.end)
    .sort((a, b) => a.start - b.start)
    .slice(0, 5)
    .map((e) => {
      const isToday = e.start < today.end;
      const when = e.allDay ? say(isToday ? "todayAllDay" : "tomorrowAllDay") : say(isToday ? "today" : "tomorrow", { time: hm(e.start) });
      return `• ${say("invited", { who: e.organizer || say("someone"), title: e.title, when })}`;
    });
  return lines.length ? lines.join("\n") : null;
}
