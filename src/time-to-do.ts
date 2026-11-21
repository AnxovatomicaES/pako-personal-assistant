// Time to do it: a promise the owner made is often dropped not from forgetting but because there is no time left before it is due. For each
// open follow-up the owner owes (src/followups/) with a time in the next three working days, Pako guesses the work it takes, looks at the
// calendar for free working time before then, and, when there is not enough (or only one chance left), says it is at risk and proposes a
// focus block: in the brief, and once as a card with [Block Thu 10–11] [Another time] [Not needed].
//
// The rules:
// - The work it takes: what similar things took the owner before (gentle mode's learning, src/gentle.ts learnedMinutes), else the extraction's
//   own guess (a loop's `effort`), else a careful default by kind: a reply 15 min, a review, a document or a deck 60 min, anything else 30.
// - Free working time: the working hours (WORK_HOURS, WORK_DAYS; the owner's country picks the working week), never the quiet hours, never a
//   timed meeting (declined ones aside), never an all-day event that says the owner is away (an all-day birthday or holiday reminder is not
//   busy). Pieces under 15 minutes do not count.
// - At risk: less free time than the work, or room for it only once before its time. Enough room twice or more: nothing is said.
// - Pako never writes the calendar on its own: Block IS the owner's yes, and only then the block goes into the Mac app's queue
//   (src/calendar-writes.ts) under the card's own id, so a second press never makes two. A calendar Pako cannot write (no Mac app, or a feed
//   that is read-only) is said so, with a snooze offered instead.
// - At most one at-risk card per follow-up, none for one due in under two hours (too close to plan), none in the quiet hours, within the day's
//   nudge cap shared with the follow-ups, check-ins and Pako's own suggestions. Gentle mode: its own cap, no card for a follow-up it stopped
//   nudging, and none after two of these cards went unanswered in a row (the brief still carries them).
// - A follow-up that is itself a meeting to set up (its check is a meeting on the calendar or Zoom) is left out: a block titled with it could
//   pass for that meeting.

import { randomBytes } from "node:crypto";
import { addDays, hhmm, weekdayOf } from "./day-time.ts";
import type { CalEvent } from "./calendar.ts";
import { zonedTime } from "./followups/time.ts";
import type { Loop, LoopKind } from "./followups/types.ts";
import { quietAt, UNANSWERED_STOP } from "./gentle.ts";
import { ownerClock, texts } from "./i18n.ts";
import { readJsonRecord } from "./json-record.ts";
import type { Kv } from "./kv.ts";
import { fold, today } from "./lists.ts";
import { createLog } from "./log.ts";

const log = createLog("followups");

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Free time is counted in quarters of an hour: a block starts and ends on one, and a piece shorter than this is not free time. */
const QUARTER = 15 * MIN;

export const TIME_TO_DO_KEY = "time-to-do";
/** tb Block, ta Another time, tn Not needed: tb:<follow-up id>. */
export const TIME_BUTTON = /^t([banf]):([0-9a-f]{10})$/;
/** What the owner owes: their own promise, a request to them, a deadline of theirs. */
export const OWED_KINDS: readonly LoopKind[] = ["owner_promise", "request_to_owner", "deadline"];
/** Looked at when due within this many working days (today counts while its working hours last). */
export const HORIZON_WORKING_DAYS = 3;
/** Too close to plan: no card for a follow-up due within this. */
export const TOO_SOON_MS = 2 * HOUR;
/** The look runs this often at most (the jobs' clock ticks every half minute). */
const LOOK_EVERY_MS = 10 * MIN;
/** An offer is kept this long (its card's buttons find it; one card per follow-up is known by it). */
const KEEP_MS = 14 * DAY;
const EFFORT_MIN = 15;
const EFFORT_MAX = 8 * 60;

/** Its words (English, like all of Pako's own): exported whole so the no-shame test reads every one. */
export const TIME_WORDS = {
  risk: "⏳ At risk: “{title}” is due {due} and you have {free} before then — {slot}{short}. Block it?",
  riskSplit: "⏳ At risk: “{title}” is due {due}. It takes about {need} min and your free time before then comes in short pieces; the longest is {slot}. Block it?",
  riskNone: "⏳ At risk: “{title}” is due {due} and I don't see free working time before then (it takes about {need} min). Move something, or ask for more time?",
  short: " (it takes about {need} min)",
  offer: "🗓 Free time for “{title}” (about {need} min): {slot}. Block it?",
  readOnly: "I can't write to your calendar from here, so blocking it is yours to do. Or snooze this for now?",
  briefHint: " Say “find time for {words}”.",
  briefReadOnly: " Worth blocking it in your calendar.",
  freeHour: "one free hour",
  freeHours: "{h} free hours",
  freeMinutes: "{m} free minutes",
  freeMixed: "{h} h {m} min of free time",
  today: "today",
  tomorrow: "tomorrow",
  btnBlock: "Block {when}",
  btnBlockIt: "Block it",
  btnOther: "Another time",
  btnNo: "Not needed",
  btnSnooze: "Snooze 1 h",
  eventTitle: "Focus: {title}",
  blocked: "OK: “{event}”, {slot}, goes on your Mac's calendar in a few seconds.",
  already: "That block is already on its way to your calendar.",
  passed: "That time has passed, so I added nothing. Here is the next free time I see:",
  closed: "“{title}” is closed already, so I added nothing.",
  gone: "That's no longer pending. Say “find time for …” to look once more.",
  paused: "{paused} Your calendar was not changed.",
  readOnlyPress: "I can't write to your calendar from here, so nothing was added. Block {slot} yourself, or snooze this for now?",
  noOther: "That's the only free time I see before it's due. Block it, or leave it?",
  noOtherOpen: "That's the only free time I see in the next few working days. Block it, or leave it?",
  declined: "OK, no block for “{title}”.",
  failed: "Your calendar was not changed: Pako could not keep it.",
  findNone: "I don't see an open follow-up of yours with those words. Say “pending” to see them.",
  findMany: "Several match: {list}. Which one?",
  planned: "“{title}” already has time on your calendar before it's due.",
  findNoTime: "I don't see free working time for “{title}” before it's due ({due}).",
  findNoTimeOpen: "I don't see free working time for “{title}” in the next few working days.",
  noCalendar: "I can't see your calendar, so I can't find free time for it.",
  unread: "I couldn't read that just now, so nothing changed. Could you try once more in a moment?",
  logAsked: "At risk, a focus block proposed: {title}",
  logBlocked: "Focus block for {title}: {slot}",
};
export const TW = texts(TIME_WORDS);
/** A focus block Pako put on the calendar ("Focus: …"): never taken for a meeting a follow-up asked for (src/followups/checks.ts). */
export const isFocusBlock = (title: string): boolean => title.startsWith(TIME_WORDS.eventTitle.replace("{title}", ""));

// ---------- working hours ----------

/** The working day: minutes of the day [start, end), and the weekdays worked (0 Sunday … 6 Saturday). */
export interface WorkHours {
  start: number;
  end: number;
  days: number[];
}

/** Countries whose working week runs Sunday to Thursday (their weekend is Friday and Saturday). */
const SUN_THU = new Set(["IL", "SA", "EG", "KW", "QA", "BH", "OM", "JO", "DZ", "IQ", "YE", "LY", "SD", "SY"]);
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** "mon-fri", "sun-thu", "sat-wed" or "mon,tue,thu": the weekdays, or null when it does not read. */
function daysOf(raw: string): number[] | null {
  const s = raw.trim().toLowerCase();
  const range = /^([a-z]{3})\s*-\s*([a-z]{3})$/.exec(s);
  if (range) {
    const a = DAY_NAMES.indexOf(range[1]!);
    const b = DAY_NAMES.indexOf(range[2]!);
    if (a < 0 || b < 0) return null;
    const out: number[] = [];
    for (let i = a; ; i = (i + 1) % 7) {
      out.push(i);
      if (i === b || out.length >= 7) break;
    }
    return out;
  }
  const list = s.split(/\s*,\s*/).map((x) => DAY_NAMES.indexOf(x));
  return list.length && list.every((x) => x >= 0) ? [...new Set(list)].sort() : null;
}

/**
 * WORK_HOURS (like 09:00-18:00, the default) and WORK_DAYS (like mon-fri or sun-thu; by default the owner's country's working week). A wrong
 * value is reported and its default used.
 */
export function loadWorkHours(env: Record<string, string | undefined>, country = ""): { hours: WorkHours; problems: string[] } {
  const problems: string[] = [];
  const fallbackDays = SUN_THU.has(country.toUpperCase()) ? [0, 1, 2, 3, 4] : [1, 2, 3, 4, 5];
  let start = 9 * 60;
  let end = 18 * 60;
  const rawHours = (env.WORK_HOURS ?? "").trim();
  if (rawHours) {
    const [a, b] = rawHours.split("-");
    const s = hhmm(a ?? "");
    const e = hhmm(b ?? "");
    if (s === null || e === null || e <= s) problems.push("WORK_HOURS must be like 09:00-18:00, the end after the start (09:00-18:00 is used)");
    else [start, end] = [s, e];
  }
  let days = fallbackDays;
  const rawDays = (env.WORK_DAYS ?? "").trim();
  if (rawDays) {
    const d = daysOf(rawDays);
    if (!d) problems.push(`WORK_DAYS must be like mon-fri, sun-thu or mon,tue,wed (${fallbackDays[0] === 0 ? "sun-thu" : "mon-fri"} is used)`);
    else days = d;
  }
  return { hours: { start, end, days }, problems };
}

// ---------- the work it takes ----------

const REPLY = /\b(reply|answer|respond|confirm|tell|let \w+ know|call|ring|text|email|approve|sign|decide|forward|book|pay|ok)\b/i;
const DOCUMENT = /\b(review|read|draft|write|prepare|prep|deck|slides?|doc|document|report|proposal|presentation|plan|budget|analysis|summary|spec|memo|contract|pack)\b/i;

/**
 * The minutes it takes, between 15 and 480: what similar things took the owner (learned), else the extraction's guess, else a default by
 * its words: a reply 15, a review, document or deck 60, anything else 30 (rounded up to a quarter of an hour).
 */
export function effortMinutes(l: Pick<Loop, "title" | "check" | "effort">, learned?: number | null): number {
  const quarter = (m: number): number => Math.min(EFFORT_MAX, Math.max(EFFORT_MIN, Math.ceil(m / 15) * 15));
  if (learned && learned > 0) return quarter(learned);
  if (l.effort && l.effort > 0) return quarter(l.effort);
  if (DOCUMENT.test(l.title) || ("slackReply" in l.check && l.check.slackReply.file)) return 60;
  if (REPLY.test(l.title) || "slackReply" in l.check) return 15;
  return 30;
}

// ---------- free time ----------

export interface Span {
  start: number;
  end: number;
}

const nextDate = addDays;
const weekday = weekdayOf;
const stampOf = (day: string, minutes: number): string =>
  `${day} ${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
/** That minute of that day in the zone; the day's end (minutes 1440) is the next day's 00:00. A minute the clock skips (DST) is the one after it. */
const at = (day: string, minutes: number, tz: string): number | null =>
  minutes >= 24 * 60 ? zonedTime(stampOf(nextDate(day), 0), tz) : zonedTime(stampOf(day, minutes), tz);

/** The days (owner's dates) from the one holding `from` to the one holding `to`, at most 60. */
const daysBetween = (from: number, to: number, tz: string): string[] => {
  const out: string[] = [];
  const last = today(to, tz);
  for (let d = today(from, tz); out.length < 60; d = nextDate(d)) {
    out.push(d);
    if (d >= last) break;
  }
  return out;
};

const clip = (list: Span[], from: number, to: number): Span[] =>
  list.map((s) => ({ start: Math.max(s.start, from), end: Math.min(s.end, to) })).filter((s) => s.end > s.start);

/** What is left of `list` once `cuts` are taken out. */
export function subtract(list: Span[], cuts: Span[]): Span[] {
  let out = list.map((s) => ({ ...s }));
  for (const c of cuts) {
    if (c.end <= c.start) continue;
    out = out.flatMap((s) => {
      if (c.end <= s.start || c.start >= s.end) return [s];
      return [{ start: s.start, end: c.start }, { start: c.end, end: s.end }].filter((x) => x.end > x.start);
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The working hours between two times, day by day in the owner's zone (a day of 23 or 25 hours keeps its own clock times). */
export function workSpans(from: number, to: number, tz: string, hours: WorkHours): Span[] {
  const out: Span[] = [];
  for (const day of daysBetween(from, to, tz)) {
    if (!hours.days.includes(weekday(day))) continue;
    const s = at(day, hours.start, tz);
    const e = at(day, hours.end, tz);
    if (s !== null && e !== null && e > s) out.push({ start: s, end: e });
  }
  return clip(out, from, to);
}

/** The quiet hours between two times (crossing midnight when start > end). */
export function quietSpans(from: number, to: number, tz: string, q: { start: number; end: number } | null): Span[] {
  if (!q) return [];
  const out: Span[] = [];
  for (const day of daysBetween(from - DAY, to, tz)) {
    const parts: [number, number][] = q.start < q.end ? [[q.start, q.end]] : [[0, q.end], [q.start, 24 * 60]];
    for (const [a, b] of parts) {
      const s = at(day, a, tz);
      const e = at(day, b, tz);
      if (s !== null && e !== null && e > s) out.push({ start: s, end: e });
    }
  }
  return clip(out, from, to);
}

/** An all-day event that says the owner is away: their whole day is busy. Any other all-day event (a birthday, a holiday reminder) is not. */
const AWAY = /\b(out of (?:the )?office|ooo|vacation|holidays?|annual leave|on leave|day off|days off|off sick|sick leave|pto|away|travel(?:l?ing)?)\b/i;

/** The busy times: timed events (not declined, not only invited by mail) and all-day ones that say the owner is away. */
export function busySpans(events: readonly CalEvent[], from: number, to: number): Span[] {
  const out: Span[] = [];
  for (const e of events) {
    if (e.response === "declined" || e.invited || !(e.end > e.start)) continue;
    if (e.allDay && !AWAY.test(e.title)) continue;
    out.push({ start: e.start, end: e.end });
  }
  return clip(out, from, to);
}

/** The free working time between two times: working hours, less the quiet hours and the busy times, in whole quarters of an hour. */
export function freeSlots(o: {
  from: number; to: number; tz: string; hours: WorkHours; quiet: { start: number; end: number } | null; events: readonly CalEvent[];
}): Span[] {
  const spans = subtract(subtract(workSpans(o.from, o.to, o.tz, o.hours), quietSpans(o.from, o.to, o.tz, o.quiet)), busySpans(o.events, o.from, o.to));
  return spans
    .map((s) => ({ start: Math.ceil(s.start / QUARTER) * QUARTER, end: Math.floor(s.end / QUARTER) * QUARTER }))
    .filter((s) => s.end - s.start >= QUARTER);
}

/** The end of the working hours of the third working day from now (today counts while its working hours last). */
export function horizonEnd(now: number, tz: string, hours: WorkHours, days = HORIZON_WORKING_DAYS): number {
  let found = 0;
  let last = now;
  for (let day = today(now, tz), i = 0; i < 21 && found < days; day = nextDate(day), i++) {
    if (!hours.days.includes(weekday(day))) continue;
    const e = at(day, hours.end, tz);
    if (e === null || e <= now) continue;
    found++;
    last = e;
  }
  return last;
}

// ---------- at risk ----------

export interface Risk {
  loop: Loop;
  /** The work it takes (minutes). */
  need: number;
  /** All the free working time before its time (minutes). */
  free: number;
  /**
   * short: less free time than the work; last: room for it only once; split: enough time, but in pieces none of which holds it; none: no
   * free time at all; ok: room for it twice or more (not at risk: only "find time for" shows it).
   */
  reason: "short" | "last" | "split" | "none" | "ok";
  /** The block proposed: the first time that holds the work, else the longest free piece; null when there is none. */
  proposal: Span | null;
}

/** A follow-up this looks at: one the owner owes, open, with a time still ahead, that is not itself a meeting to set up. */
export const considered = (l: Loop, now: number): boolean =>
  OWED_KINDS.includes(l.kind) && (l.status === "open" || l.status === "snoozed") && !!l.dueAt && l.dueAt > now
  && !("zoomMeeting" in l.check) && !("calendarEvent" in l.check);

/** Already planned: an event before its time named after it (a block made by Pako, or one the owner made with its words). */
const planned = (l: Loop, events: readonly CalEvent[], now: number, until: number): boolean => {
  const t = fold(l.title);
  return events.some((e) => e.end > now && e.start < until && t.length >= 6 && fold(e.title).includes(t));
};

/**
 * How it stands: the work, the free time before `until` (its time), and the block to propose. `after`: only free time from then on (Another
 * time). Null when it is already planned on the calendar.
 */
export function assess(
  l: Loop, events: readonly CalEvent[],
  o: { now: number; until: number; tz: string; hours: WorkHours; quiet: { start: number; end: number } | null; learned?: number | null; after?: number },
): Risk | null {
  if (planned(l, events, o.now, o.until)) return null;
  const need = effortMinutes(l, o.learned);
  const slots = freeSlots({ from: Math.max(o.now, o.after ?? 0), to: o.until, tz: o.tz, hours: o.hours, quiet: o.quiet, events });
  const len = (s: Span): number => Math.round((s.end - s.start) / MIN);
  const free = slots.reduce((n, s) => n + len(s), 0);
  const chances = slots.reduce((n, s) => n + Math.floor(len(s) / need), 0);
  const fits = slots.find((s) => len(s) >= need);
  const longest = slots.reduce<Span | null>((b, s) => (!b || len(s) > len(b) ? s : b), null);
  const proposal = fits ? { start: fits.start, end: fits.start + need * MIN } : longest;
  const reason = !slots.length ? "none" : free < need ? "short" : chances >= 2 ? "ok" : chances === 1 ? "last" : "split";
  return { loop: l, need, free, reason, proposal };
}

// ---------- words ----------

/** "today", "tomorrow" or the weekday ("Thu") of a time, in the owner's zone. */
const dayWord = (t: number, now: number, tz: string): string => {
  const d = today(t, tz);
  if (d === today(now, tz)) return TW()("today");
  if (d === nextDate(today(now, tz))) return TW()("tomorrow");
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).format(t);
};
export const dueWords = (t: number, now: number, tz: string): string => `${dayWord(t, now, tz)} ${ownerClock(t, tz)}`;
export const slotWords = (s: Span, now: number, tz: string): string => `${dayWord(s.start, now, tz)} ${ownerClock(s.start, tz)}–${ownerClock(s.end, tz)}`;

export const freeWords = (min: number): string => {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (min === 60) return TW()("freeHour");
  if (!m) return TW()("freeHours", { h });
  if (!h) return TW()("freeMinutes", { m });
  return TW()("freeMixed", { h, m });
};

/** The Block button: "Block Thu 10–11" (a full hour without its ":00"), else "Block Thu 10:30", else "Block it": 20 characters at most. */
export function blockTitle(s: Span, now: number, tz: string): string {
  const d = today(s.start, tz) === today(now, tz) ? TW()("today") : new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).format(s.start);
  const short = (t: number): string => ownerClock(t, tz).replace(/^(\d{1,2}):00$/, "$1").replace(/:00(?=\s)/, "");
  for (const when of [`${d} ${short(s.start)}–${short(s.end)}`, `${d} ${short(s.start)}`]) {
    const title = TW()("btnBlock", { when });
    if (title.length <= 20) return title;
  }
  return TW()("btnBlockIt");
}

/** The card's (or the brief's) words for one follow-up: why it is at risk, and the block proposed. */
export function riskText(r: Risk, now: number, tz: string): string {
  const title = r.loop.title;
  const due = r.loop.dueAt ? dueWords(r.loop.dueAt, now, tz) : "";
  if (!r.proposal || r.reason === "none") return TW()("riskNone", { title, due, need: r.need });
  const slot = slotWords(r.proposal, now, tz);
  if (r.reason === "ok") return TW()("offer", { title, need: r.need, slot });
  if (r.reason === "split") return TW()("riskSplit", { title, due, need: r.need, slot });
  return TW()("risk", { title, due, free: freeWords(r.free), slot, short: r.reason === "short" ? TW()("short", { need: r.need }) : "" });
}

// ---------- the engine ----------

/** What the calendar-writing side gives (src/door/deps.ts calendarWrites): whether it can write now, and the queue a yes goes into. */
export interface TimeWrites {
  canWrite: () => Promise<boolean>;
  enqueue: (w: { id: string; op: "create"; start: number; end: number; title: string }) => Promise<boolean>;
}

/** One block proposed for a follow-up, and what became of it. */
export interface Offer {
  loop: string;
  title: string;
  /** When it was proposed. */
  at: number;
  start: number;
  end: number;
  /** The calendar write's id (its idempotency key): a second Block never makes a second event. A new time is a new id. */
  write: string;
  state: "asked" | "blocked" | "declined";
  /** Sent on its own (the at-risk card), counted in the day's cap; false: asked for ("find time for …"). */
  nudge: boolean;
  /** The owner pressed one of its buttons. */
  pressed?: boolean;
  /** The STOPs sent before it was shown: a STOP ends every card waiting, so its Block changes nothing after. */
  stops: number;
}

interface State {
  offers: Offer[];
  day: string;
  n: number;
}
const empty = (): State => ({ offers: [], day: "", n: 0 });
const HEX10 = /^[0-9a-f]{10}$/;
const stateOf = (v: unknown): State => {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const num = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
  const offers = (Array.isArray(o.offers) ? o.offers : []).flatMap((x): Offer[] => {
    const c = x && typeof x === "object" ? (x as Record<string, unknown>) : null;
    if (!c || typeof c.loop !== "string" || !HEX10.test(c.loop) || typeof c.write !== "string" || !HEX10.test(c.write)) return [];
    if (num(c.at) === undefined || num(c.start) === undefined || num(c.end) === undefined) return [];
    const state = c.state === "blocked" || c.state === "declined" ? c.state : "asked";
    return [{
      loop: c.loop, title: typeof c.title === "string" ? c.title.slice(0, 160) : "", at: num(c.at)!, start: num(c.start)!, end: num(c.end)!,
      write: c.write, state, nudge: c.nudge === true, ...(c.pressed === true ? { pressed: true } : {}), stops: num(c.stops) ?? 0,
    }];
  });
  return { offers: offers.slice(-100), day: typeof o.day === "string" ? o.day.slice(0, 10) : "", n: num(o.n) ?? 0 };
};

export interface TimeToDoDeps {
  kv: Kv | null;
  timeZone: string;
  now?: () => number;
  hours: WorkHours;
  quiet: { start: number; end: number } | null;
  /** The standard day's cap (the follow-ups' FOLLOWUP_MAX_PER_DAY) when gentle mode is off. */
  standardMax: number;
  /** The open follow-ups (src/followups/owner.ts open). */
  loops: () => Promise<Loop[]>;
  /** The calendar; absent: nothing can be said of free time, so nothing is. */
  events?: () => Promise<CalEvent[]>;
  /** Gentle mode, as it applies now: its cap; null when it is off. */
  gentle?: () => Promise<{ maxPerDay: number } | null>;
  /** What similar things took the owner, in minutes (src/gentle.ts learnedMinutes); null when fewer than three are known. */
  usually?: (title: string) => Promise<number | null>;
  /** Follow-up nudges, check-ins and Pako's own suggestions sent today: the cap is shared. */
  others?: () => Promise<number>;
  /** The calendar writes (src/door/deps.ts); absent or null: the calendar is read-only for Pako. */
  writes?: () => TimeWrites | null | undefined;
  /** Pako paused (STOP, the panel's switch): what to say, or null when it is not. */
  paused?: () => Promise<string | null>;
  /** The STOPs sent so far (src/door/stop-resume.ts). */
  stops?: () => number;
  card: (body: string, buttons: { id: string; title: string }[]) => Promise<boolean>;
  /** A press on its card is an answer to the follow-up: gentle mode's unanswered count starts again. */
  engaged?: (id: string) => Promise<unknown>;
  log?: (text: string) => void;
}

export function createTimeToDo(d: TimeToDoDeps) {
  const now = d.now ?? Date.now;
  const tz = d.timeZone;
  let memory = empty();
  let lookedAt = 0;
  const load = async (): Promise<State> => (d.kv ? stateOf((await readJsonRecord(d.kv, TIME_TO_DO_KEY)) ?? {}) : structuredClone(memory));
  const peek = (): Promise<State> => load().catch((err: Error) => {
    log.warn(`time to do it could not be read: ${err.message}`);
    return empty();
  });
  const save = async (s: State): Promise<void> => {
    const t = now();
    s.offers = s.offers.filter((o) => t - o.at < KEEP_MS).slice(-100);
    memory = s;
    if (d.kv) await d.kv.set(TIME_TO_DO_KEY, JSON.stringify(s), 15 * 24 * 3600);
  };
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <R>(fn: () => Promise<R>): Promise<R> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const learned = (l: Loop): Promise<number | null> => (d.usually ? d.usually(l.title).catch(() => null) : Promise.resolve(null));
  const canWrite = async (): Promise<boolean> => {
    const w = d.writes?.();
    return !!w && (await w.canWrite().catch(() => false));
  };
  const opts = (t: number, until: number) => ({ now: t, until, tz, hours: d.hours, quiet: d.quiet });

  /** The card for one block: Block, Another time, Not needed; a calendar Pako cannot write: Snooze 1 h (the follow-up's own) instead of Block. */
  const cardFor = async (r: Risk, writable: boolean, lead?: string): Promise<boolean> => {
    const t = now();
    const id = r.loop.id;
    const body = [lead, riskText(r, t, tz), ...(writable || !r.proposal || r.reason === "none" ? [] : [TW()("readOnly")])].filter(Boolean).join("\n");
    const buttons = !r.proposal || r.reason === "none"
      ? [{ id: `tn:${id}`, title: TW()("btnNo") }]
      : [
          writable ? { id: `tb:${id}`, title: blockTitle(r.proposal, t, tz) } : { id: `f2:${id}`, title: TW()("btnSnooze") },
          { id: `ta:${id}`, title: TW()("btnOther") },
          { id: `tn:${id}`, title: TW()("btnNo") },
        ];
    return d.card(body, buttons).catch(() => false);
  };

  /** A new offer for this follow-up (the one before it ends): a new write id, so a new time is never taken for the old one. */
  const offerOf = (r: Risk, nudge: boolean, s: State): Offer => {
    const was = s.offers.find((o) => o.loop === r.loop.id);
    const o: Offer = {
      loop: r.loop.id, title: r.loop.title, at: now(), start: r.proposal?.start ?? 0, end: r.proposal?.end ?? 0, write: randomBytes(5).toString("hex"),
      state: "asked", nudge: nudge || !!was?.nudge, stops: d.stops?.() ?? 0, ...(was?.pressed ? { pressed: true } : {}),
    };
    s.offers = [...s.offers.filter((x) => x.loop !== r.loop.id), o];
    return o;
  };

  /** The follow-ups at risk now (those due in the next working days), each with its block; the ones already blocked or declined left out. */
  const risks = async (s: State): Promise<Risk[]> => {
    if (!d.events) return [];
    const t = now();
    const until = horizonEnd(t, tz, d.hours);
    const loops = (await d.loops()).filter((l) => considered(l, t) && l.dueAt! <= until);
    const done = new Set(s.offers.filter((o) => o.state !== "asked").map((o) => o.loop));
    const todo = loops.filter((l) => !done.has(l.id));
    if (!todo.length) return [];
    const events = await d.events();
    const out: Risk[] = [];
    for (const l of todo.sort((a, b) => a.dueAt! - b.dueAt!)) {
      const r = assess(l, events, { ...opts(t, l.dueAt!), learned: await learned(l) });
      if (r && r.reason !== "ok") out.push(r);
    }
    return out;
  };

  /**
   * The look (every tick of the durable jobs, at most every ten minutes): one at-risk card, for the follow-up due first that has had none,
   * within the day's cap and outside the quiet hours. The follow-up's id when one went.
   */
  const sweep = (): Promise<string | null> => serial(async () => {
    const t = now();
    if (t - lookedAt < LOOK_EVERY_MS) return null;
    lookedAt = t;
    if (quietAt(d.quiet, t, tz)) return null;
    const s = await load();
    const g = d.gentle ? await d.gentle().catch(() => null) : null;
    // Gentle: its own stop after two unanswered nudges, for the follow-up and for these cards (the last two sent, neither pressed).
    const sent = s.offers.filter((o) => o.nudge).sort((a, b) => a.at - b.at);
    if (g && sent.length >= UNANSWERED_STOP && sent.slice(-UNANSWERED_STOP).every((o) => !o.pressed && t - o.at > HOUR)) return null;
    const asked = new Set(sent.map((o) => o.loop));
    const list = (await risks(s)).filter((r) => {
      const l = r.loop;
      if (asked.has(l.id) || l.dueAt! - t < TOO_SOON_MS) return false;
      return !(g && (l.folded || (l.unanswered ?? 0) >= UNANSWERED_STOP));
    });
    const r = list[0];
    if (!r) return null;
    const day = today(t, tz);
    if (s.day !== day) Object.assign(s, { day, n: 0 });
    const cap = g ? g.maxPerDay : d.standardMax;
    const others = await (d.others?.() ?? Promise.resolve(0)).catch(() => 0);
    if (s.n + others >= cap) return null;
    // Counted and kept before the card goes: two looks never both send it. A card that could not go is taken back (the next look tries).
    offerOf(r, true, s);
    s.n++;
    await save(s);
    const writable = await canWrite();
    if (!(await cardFor(r, writable))) {
      s.offers = s.offers.filter((o) => o.loop !== r.loop.id);
      s.n = Math.max(0, s.n - 1);
      await save(s);
      return null;
    }
    d.log?.(TW()("logAsked", { title: r.loop.title }));
    return r.loop.id;
  }).catch((err: Error) => {
    log.error(`time to do it: ${err.message}`);
    return null;
  });

  /** The brief's lines: each follow-up at risk (three at most), with its block and how to ask for it. Null when none. */
  const briefLine = async (): Promise<string | null> => {
    try {
      const t = now();
      const list = (await risks(await peek())).filter((r) => r.loop.dueAt! - t >= TOO_SOON_MS).slice(0, 3);
      if (!list.length) return null;
      const writable = await canWrite();
      return list.map((r) => {
        const words = fold(r.loop.title).replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);
        const tail = !r.proposal || r.reason === "none" ? "" : writable ? TW()("briefHint", { words }) : TW()("briefReadOnly");
        return riskText(r, t, tz) + tail;
      }).join("\n");
    } catch (err) {
      log.warn(`time to do it, the brief's line: ${(err as Error).message}`);
      return null;
    }
  };

  /** The follow-up an offer is for, while it is open; null when it closed. */
  const loopOf = async (id: string): Promise<Loop | null> => (await d.loops()).find((l) => l.id === id && (l.status === "open" || l.status === "snoozed")) ?? null;
  const untilOf = (l: Loop, t: number): number => (l.dueAt && l.dueAt > t ? l.dueAt : horizonEnd(t, tz, d.hours));

  /** Block (b), Another time (a), Not needed (n), pressed on its card: what to tell the owner ("" when a new card says it). */
  const pressed = (button: "b" | "a" | "n", loopId: string): Promise<string> => serial(async () => {
    const t = now();
    let s: State;
    try {
      s = await load();
    } catch (err) {
      log.warn(`time to do it could not be read, nothing changed: ${(err as Error).message}`);
      return TW()("unread");
    }
    const o = s.offers.find((x) => x.loop === loopId);
    if (!o || o.stops !== (d.stops?.() ?? 0)) return TW()("gone");
    if (o.state === "blocked") return TW()("already");
    if (o.state === "declined") return TW()("gone");
    o.pressed = true;
    if (d.engaged) await d.engaged(loopId).catch((err: Error) => log.warn(`a press could not be kept on its follow-up: ${err.message}`));
    if (button === "n") {
      o.state = "declined";
      await save(s);
      return TW()("declined", { title: o.title });
    }
    const l = await loopOf(loopId);
    if (!l) {
      o.state = "declined";
      await save(s);
      return TW()("closed", { title: o.title });
    }
    const events = d.events ? await d.events() : null;
    if (!events) {
      await save(s);
      return TW()("noCalendar");
    }
    const until = untilOf(l, t);
    if (button === "a") {
      // The next time that holds it, after the one proposed; a new card (a new write id) for it, or "that's the only one".
      const r = assess(l, events, { ...opts(t, until), learned: await learned(l), after: o.end });
      const next = r?.proposal && r.proposal.end - r.proposal.start >= r.need * MIN ? r : null;
      if (!next) {
        await save(s);
        return TW()(l.dueAt ? "noOther" : "noOtherOpen");
      }
      offerOf(next, false, s);
      await save(s);
      await cardFor(next, await canWrite());
      return "";
    }
    // Block: the owner's yes. Nothing is written while Pako is paused, for a time that has passed, or on a calendar Pako cannot write.
    const paused = d.paused ? await d.paused().catch(() => null) : null;
    if (paused) {
      await save(s);
      return TW()("paused", { paused });
    }
    const slot = { start: o.start, end: o.end };
    if (o.start < t) {
      const r = assess(l, events, { ...opts(t, until), learned: await learned(l) });
      await save(s);
      if (!r?.proposal) return TW()(l.dueAt ? "findNoTime" : "findNoTimeOpen", { title: l.title, due: l.dueAt ? dueWords(l.dueAt, t, tz) : "" });
      offerOf(r, false, s);
      await save(s);
      await cardFor(r, await canWrite(), TW()("passed"));
      return "";
    }
    const w = d.writes?.();
    if (!w || !(await w.canWrite().catch(() => false))) {
      await save(s);
      await d.card(TW()("readOnlyPress", { slot: slotWords(slot, t, tz) }), [
        { id: `f2:${loopId}`, title: TW()("btnSnooze") }, { id: `tn:${loopId}`, title: TW()("btnNo") },
      ]).catch(() => false);
      return "";
    }
    const event = TW()("eventTitle", { title: l.title }).slice(0, 200);
    try {
      const fresh = await w.enqueue({ id: o.write, op: "create", start: o.start, end: o.end, title: event });
      o.state = "blocked";
      await save(s);
      if (!fresh) return TW()("already");
    } catch (err) {
      log.error(`a focus block could not be queued: ${(err as Error).message}`);
      return TW()("failed");
    }
    d.log?.(TW()("logBlocked", { title: l.title, slot: slotWords(slot, t, tz) }));
    return TW()("blocked", { event, slot: slotWords(slot, t, tz) });
  });

  /** "find time for <words>": the one open follow-up the owner owes whose title and person hold the words, and a card with its block. */
  const findTime = (words: string): Promise<string> => serial(async () => {
    const t = now();
    const filler = new Set(["the", "a", "an", "my", "to", "for", "of", "on", "it"]);
    const keys = fold(words).split(/[^\p{L}\p{N}]+/u).filter((k) => k.length >= 2 && !filler.has(k));
    if (!keys.length) return TW()("findNone");
    const mine = (await d.loops()).filter((l) => OWED_KINDS.includes(l.kind) && (l.status === "open" || l.status === "snoozed"));
    const hits = mine.filter((l) => {
      const ws = fold(`${l.title} ${l.who}`).split(/[^\p{L}\p{N}]+/u);
      return keys.every((k) => ws.some((w) => w.startsWith(k)));
    });
    if (!hits.length) return TW()("findNone");
    if (hits.length > 1) return TW()("findMany", { list: hits.slice(0, 4).map((l) => `“${l.title}”`).join(", ") });
    return offerTime(hits[0]!, t);
  });

  /** The same for one follow-up by its id (the evening shutdown's Plan, src/shutdown.ts): open and the owner's to do, or "none found". */
  const findTimeFor = (loopId: string): Promise<string> => serial(async () => {
    const l = await loopOf(loopId);
    return l && OWED_KINDS.includes(l.kind) ? offerTime(l, now()) : TW()("findNone");
  });

  /** The block for one follow-up, as a card (its Block, Another time, Not needed): "" when the card says it, else why there is none. */
  const offerTime = async (l: Loop, t: number): Promise<string> => {
    if (!d.events) return TW()("noCalendar");
    const events = await d.events().catch(() => null);
    if (!events) return TW()("noCalendar");
    const r = assess(l, events, { ...opts(t, untilOf(l, t)), learned: await learned(l) });
    if (!r) return TW()("planned", { title: l.title });
    if (!r.proposal || r.reason === "none") {
      return TW()(l.dueAt && l.dueAt > t ? "findNoTime" : "findNoTimeOpen", { title: l.title, due: l.dueAt ? dueWords(l.dueAt, t, tz) : "" });
    }
    let s: State;
    try {
      s = await load();
    } catch (err) {
      log.warn(`time to do it could not be read, nothing changed: ${(err as Error).message}`);
      return TW()("unread");
    }
    offerOf(r, false, s);
    await save(s);
    await cardFor(r, await canWrite());
    return "";
  };

  /** At-risk cards sent today: counted in the shared cap by the follow-ups, the check-ins and proactive Pako. */
  const spentToday = async (): Promise<number> => {
    const s = await peek();
    return s.day === today(now(), tz) ? s.n : 0;
  };

  return { sweep, briefLine, pressed, findTime, findTimeFor, spentToday, offers: async () => (await peek()).offers };
}
export type TimeToDo = ReturnType<typeof createTimeToDo>;
