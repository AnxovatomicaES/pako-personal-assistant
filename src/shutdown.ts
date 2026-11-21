// The evening shutdown: one message at the end of the owner's working day, on working days, that closes the day the way a chief of staff
// would. It is sent only when there is something to say (something due on the next working day, or still open from a time already passed):
//
//   "🌇 Wrapping up Thursday. Done today: 3.
//    Due tomorrow:
//    1. Send Ana the Q4 deck · 12:00
//    2. Reply to Omar about the SOW
//    ⚠️ Tomorrow doesn't fit: about 2 h of work due and 45 min free between meetings."
//
// with Plan <n> (a focus block for it, through time-to-do's own card: nothing is written without its Block) and Done <n>. Never in the quiet
// hours or during a meeting (it waits for the end, up to three hours), never in gentle mode (its weekly reset and softer nudges are the
// place for that), and once a day whatever restarts (a durable slot, "shutdown:<day>"). It never contacts anyone: it speaks to the owner only.
// SHUTDOWN: off, or the time (HH:MM); by default the end of WORK_HOURS.

import { randomBytes } from "node:crypto";
import type { CalEvent } from "./calendar.ts";
import type { Loop } from "./followups/types.ts";
import { zonedTime } from "./followups/time.ts";
import { busyUntil } from "./gentle-checkins.ts";
import { quietAt } from "./gentle.ts";
import { ownerClock, texts } from "./i18n.ts";
import type { Jobs } from "./jobs.ts";
import { readJsonRecord } from "./json-record.ts";
import type { Kv } from "./kv.ts";
import { today } from "./lists.ts";
import { createLog } from "./log.ts";
import { inline } from "./quarantine.ts";
import { effortMinutes, freeSlots, OWED_KINDS, type WorkHours } from "./time-to-do.ts";

const log = createLog("shutdown");

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const SHUTDOWN_KEY = "shutdown";
/** e + p (Plan) or d (Done) + the item's number: e<p|d><n>:<shutdown id>. */
export const SHUTDOWN_BUTTON = /^e([pd])([1-3]):([0-9a-f]{10})$/;
/** A shutdown whose moment passed more than this ago (a meeting that ran on, a computer asleep) is not sent that day. */
const LATE_MAX_MS = 3 * HOUR;
/** Its buttons work this long. */
const PRESS_MS = 2 * DAY;
/** Something past its time is "still open" in the shutdown for a week at most; older, the brief and the weekly reset carry it. */
const OVERDUE_MS = 7 * DAY;
const ITEMS_MAX = 3;

/** The shutdown's words, exported whole so the no-shame test can read every one. */
export const SHUTDOWN_WORDS = {
  head: "🌇 Wrapping up {day}.",
  done: " Done today: {n}.",
  overdue: "Still open:",
  tomorrow: "Due {day}:",
  item: "{i}. {title}{who}{time}",
  who: " (for {who})",
  time: " · {time}",
  more: "…and {n} more in your brief.",
  fits: "{day} fits: about {need} of work due and {free} free.",
  tight: "⚠️ {day} doesn't fit: about {need} of work due and {free} free. Plan the first, or ask for more time.",
  noFree: "⚠️ {day} has no free time between meetings, and about {need} of work due. Plan one, or ask for more time.",
  btnPlan: "Plan {i}",
  btnDone: "Done {i}",
  gone: "That wrap-up is from an earlier day.",
  closed: "“{title}” isn't open any more.",
  unread: "I couldn't read today's wrap-up just now, so nothing changed. Could you try once more in a moment?",
  logSent: "Evening wrap-up sent ({n} open)",
  tomorrowWord: "tomorrow",
  todayWord: "today",
  laterToday: "Later today:",
  before: "Before {day}:",
  headWeek: "🌇 Wrapping up the week.",
  clash: "📅 {day}: “{a}” {at} overlaps “{b}” {bt}.",
  unanswered: "✉️ Not answered yet for {day}: {list}.",
  doneWeek: " Done this week: {n}.",
  waiting: "Waiting on others:",
  waitingItem: "• {who}{title}{due}",
  wasDue: " (due {day})",
  ahead: "Later next week: {n} more due, the first “{title}” on {day}.",
  aheadOne: "Later next week: “{title}”, due {day}.",
};
export const SW = texts(SHUTDOWN_WORDS);

export interface ShutdownConfig {
  /** Minutes of the day it is sent at; null: off. */
  at: number | null;
  problems: string[];
}

/** SHUTDOWN: "off", "HH:MM", or unset (the end of the working day). */
export function loadShutdownConfig(env: Record<string, string | undefined>, hours: WorkHours): ShutdownConfig {
  const v = (env.SHUTDOWN ?? "").trim().toLowerCase();
  if (!v || v === "on") return { at: hours.end, problems: [] };
  if (v === "off" || v === "0" || v === "false") return { at: null, problems: [] };
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (m && Number(m[1]) < 24 && Number(m[2]) < 60) return { at: Number(m[1]) * 60 + Number(m[2]), problems: [] };
  return { at: hours.end, problems: [`SHUTDOWN must be off or a time like 18:00, not "${v.slice(0, 20)}": the end of the working day is used`] };
}

interface Item {
  loop: string;
  title: string;
}
interface Sent {
  id: string;
  day: string;
  at: number;
  items: Item[];
}
interface State {
  sent: Sent[];
}
const HEX10 = /^[0-9a-f]{10}$/;
const stateOf = (v: unknown): State => {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const sent = (Array.isArray(o.sent) ? o.sent : []).flatMap((x): Sent[] => {
    const r = x && typeof x === "object" ? (x as Record<string, unknown>) : null;
    if (!r || typeof r.id !== "string" || !HEX10.test(r.id) || typeof r.day !== "string" || typeof r.at !== "number") return [];
    const items = (Array.isArray(r.items) ? r.items : []).flatMap((i): Item[] => {
      const it = i && typeof i === "object" ? (i as Record<string, unknown>) : null;
      return it && typeof it.loop === "string" && HEX10.test(it.loop) ? [{ loop: it.loop, title: typeof it.title === "string" ? it.title.slice(0, 140) : "" }] : [];
    }).slice(0, ITEMS_MAX);
    return [{ id: r.id, day: r.day.slice(0, 10), at: r.at, items }];
  });
  return { sent: sent.slice(-14) };
};

/** The calendar day after "YYYY-MM-DD". */
const nextDate = (day: string, k = 1): string => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + k)).toISOString().slice(0, 10);
};
const weekdayOf = (day: string): number => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};
/** The owner's next working day after `day` (within two weeks), or null. */
export function nextWorkingDay(day: string, hours: WorkHours): string | null {
  for (let k = 1; k <= 14; k++) {
    const d = nextDate(day, k);
    if (hours.days.includes(weekdayOf(d))) return d;
  }
  return null;
}
/** That minute of that day in the zone. */
const atMinute = (day: string, minutes: number, tz: string): number | null =>
  zonedTime(`${day} ${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`, tz);

/** A length of time as the owner reads it: "45 min", "1 h", "2 h 15 min". */
export const duration = (min: number): string => {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
};

const owed = (l: Loop): boolean => OWED_KINDS.includes(l.kind);
const isOpenLoop = (l: Loop): boolean => l.status === "open" || l.status === "snoozed";

export interface ShutdownPlan {
  /** Past their time and still open (the owner's), oldest first. */
  overdue: Loop[];
  /** Due on the next working day (the owner's), earliest first. */
  next: Loop[];
  /** Due before it, still ahead: later today, and on the days off before it (review finding: these were listed as "due tomorrow"). */
  later: Loop[];
  /** The owner's follow-ups closed today. */
  doneToday: number;
  /** The next working day ("YYYY-MM-DD"). */
  day: string;
  /** Minutes of work due that day (and still open from before), and the free working minutes that day; null without a calendar. */
  fit: { need: number; free: number } | null;
  /**
   * The last working day before days off (a Friday): the week as well. Done in the last seven days; what others owe the owner that is past
   * its time (oldest first); and what the owner owes in the week after the next working day (earliest first).
   */
  week?: { done: number; waiting: Loop[]; ahead: Loop[] };
  /** The next working day's double bookings (timed, not declined, overlapping by 5 minutes or more), and invitations not answered yet. */
  clashes: [CalEvent, CalEvent][];
  unanswered: CalEvent[];
}

/** That day's timed meetings that overlap (each pair once, in time order), and those still waiting for the owner's answer. */
export function dayTroubles(events: readonly CalEvent[], from: number, to: number): { clashes: [CalEvent, CalEvent][]; unanswered: CalEvent[] } {
  const timed = events.filter((e) => !e.allDay && e.response !== "declined" && !e.invited && e.end > e.start && e.start >= from && e.start < to)
    .sort((a, b) => a.start - b.start);
  const clashes: [CalEvent, CalEvent][] = [];
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i]!;
      const b = timed[j]!;
      if (b.start >= a.end) break;
      if (Math.min(a.end, b.end) - b.start >= 5 * MIN && (a.uid ?? a.id) !== (b.uid ?? b.id)) clashes.push([a, b]);
    }
  }
  return { clashes, unanswered: timed.filter((e) => e.response === "needs") };
}

/** What the shutdown would say now, from the follow-ups and the calendar. Null when there is no next working day in two weeks. */
export function planShutdown(o: {
  loops: readonly Loop[]; events: readonly CalEvent[] | null; now: number; tz: string; hours: WorkHours; quiet: { start: number; end: number } | null;
}): ShutdownPlan | null {
  const t = o.now;
  const todayDay = today(t, o.tz);
  const day = nextWorkingDay(todayDay, o.hours);
  if (!day) return null;
  const open = o.loops.filter((l) => owed(l) && isOpenLoop(l) && !("zoomMeeting" in l.check) && !("calendarEvent" in l.check));
  const overdue = open.filter((l) => !!l.dueAt && l.dueAt <= t && t - l.dueAt < OVERDUE_MS).sort((a, b) => a.dueAt! - b.dueAt!);
  const next = open.filter((l) => !!l.dueAt && l.dueAt > t && today(l.dueAt, o.tz) === day).sort((a, b) => a.dueAt! - b.dueAt!);
  const later = open.filter((l) => !!l.dueAt && l.dueAt > t && today(l.dueAt, o.tz) < day).sort((a, b) => a.dueAt! - b.dueAt!);
  const doneToday = o.loops.filter((l) => owed(l) && l.status === "done" && !!l.closedAt && today(l.closedAt, o.tz) === todayDay).length;
  let fit: ShutdownPlan["fit"] = null;
  let troubles: ReturnType<typeof dayTroubles> = { clashes: [], unanswered: [] };
  if (o.events) {
    const from = atMinute(day, 0, o.tz);
    const to = atMinute(nextDate(day), 0, o.tz);
    if (from !== null && to !== null) {
      troubles = dayTroubles(o.events, from, to);
      const slots = freeSlots({ from, to, tz: o.tz, hours: o.hours, quiet: o.quiet, events: o.events });
      const free = Math.round(slots.reduce((n, s) => n + (s.end - s.start), 0) / MIN);
      const need = [...overdue, ...next].reduce((n, l) => n + effortMinutes(l), 0);
      fit = { need, free };
    }
  }
  const { clashes, unanswered } = troubles;
  // The week's end: the next working day starts the owner's next week (it comes earlier in the week than today, or a week or more on).
  // A gap inside the week (WORK_DAYS mon,tue,thu,fri: Tuesday) is not one (review finding).
  const weekEnd = weekdayOf(day) < weekdayOf(todayDay) || day >= nextDate(todayDay, 7);
  if (!weekEnd) return { overdue, next, later, doneToday, day, fit, clashes, unanswered };
  const done = o.loops.filter((l) => owed(l) && l.status === "done" && !!l.closedAt && t - l.closedAt < 7 * DAY).length;
  const waiting = o.loops.filter((l) => l.kind === "other_promise" && isOpenLoop(l) && !!l.dueAt && l.dueAt <= t && t - l.dueAt < 14 * DAY)
    .sort((a, b) => a.dueAt! - b.dueAt!);
  // After the next working day, up to the same weekday a week on (midnight in the owner's zone, across a clock change).
  const after = atMinute(nextDate(day), 0, o.tz) ?? Infinity;
  const until = atMinute(nextDate(day, 7), 0, o.tz) ?? after + 7 * DAY;
  const ahead = open.filter((l) => !!l.dueAt && l.dueAt >= after && l.dueAt < until).sort((a, b) => a.dueAt! - b.dueAt!);
  return { overdue, next, later, doneToday, day, fit, clashes, unanswered, week: { done, waiting, ahead } };
}

export interface ShutdownDeps {
  kv: Kv | null;
  timeZone: string;
  now?: () => number;
  config: ShutdownConfig;
  hours: WorkHours;
  quiet: { start: number; end: number } | null;
  /** Every follow-up kept, open and closed (src/followups/owner.ts read). */
  loops: () => Promise<Loop[]>;
  events?: () => Promise<CalEvent[]>;
  /** The panel's switch (src/day-helpers.ts): whether it is on now. Absent: SHUTDOWN alone decides. */
  enabled?: () => Promise<boolean>;
  /** Gentle mode is on: no shutdown then. */
  gentle?: () => Promise<boolean>;
  jobs?: Pick<Jobs, "slot">;
  /** The chat has room for more than three buttons. */
  roomy: () => Promise<boolean>;
  card: (body: string, buttons: { id: string; title: string }[], roomy: boolean) => Promise<boolean>;
  /** A plain message (a week's end with nothing of the owner's to press on): whether it went. */
  notify?: (text: string) => Promise<boolean>;
  /** Plan: time-to-do's card for that follow-up ("" when the card says it). */
  plan: (loopId: string) => Promise<string>;
  /** Done: the follow-ups' own Done (src/followups/owner.ts press "1"). */
  done: (loopId: string) => Promise<string>;
  log?: (text: string) => void;
}

export function createShutdown(d: ShutdownDeps) {
  const now = d.now ?? Date.now;
  const tz = d.timeZone;
  let memory: State = { sent: [] };
  const load = async (): Promise<State> => (d.kv ? stateOf((await readJsonRecord(d.kv, SHUTDOWN_KEY)) ?? {}) : structuredClone(memory));
  const save = async (s: State): Promise<void> => {
    const t = now();
    s.sent = s.sent.filter((x) => t - x.at < 14 * DAY).slice(-14);
    memory = s;
    if (d.kv) await d.kv.set(SHUTDOWN_KEY, JSON.stringify(s), 30 * 24 * 3600);
  };
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <R>(fn: () => Promise<R>): Promise<R> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const dayName = (day: string): string =>
    new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long" }).format(new Date(`${day}T12:00:00Z`));

  /** The message and its buttons; null when there is nothing to say. */
  const compose = (p: ShutdownPlan, id: string, t: number, roomy: boolean): { body: string; buttons: { id: string; title: string }[]; items: Item[] } | null => {
    const wk = p.week;
    if (!p.overdue.length && !p.next.length && !p.later.length && !wk?.waiting.length && !wk?.ahead.length && !p.clashes.length && !p.unanswered.length) return null;
    const nextWord = p.day === nextDate(today(t, tz)) ? SW()("tomorrowWord") : dayName(p.day);
    const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);
    const lines = [wk ? SW()("headWeek") + (wk.done ? SW()("doneWeek", { n: wk.done }) : "")
      : SW()("head", { day: dayName(today(t, tz)) }) + (p.doneToday ? SW()("done", { n: p.doneToday }) : "")];
    const listed = [...p.overdue, ...p.later, ...p.next].slice(0, ITEMS_MAX);
    let i = 0;
    const short = (at: number): string => new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).format(at);
    // A day more than six days from today, either way, also says its date ("Mon 7"), so it is never read as this week's Monday.
    const dayLabel = (at: number): string => (Math.abs(at - t) > 6 * DAY
      ? new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric" }).format(at) : short(at));
    // On the day its group names, the clock alone; otherwise "today 20:00" or "Sat 12:00", so no time can be read as another day's.
    const when = (at: number): string => (today(at, tz) === p.day ? ownerClock(at, tz)
      : today(at, tz) === today(t, tz) ? `${SW()("todayWord")} ${ownerClock(at, tz)}` : `${short(at)} ${ownerClock(at, tz)}`);
    const row = (l: Loop): string => {
      i++;
      const time = l.dueAt ? SW()("time", { time: when(l.dueAt) }) : "";
      return SW()("item", { i, title: inline(l.title, 120), who: l.who ? SW()("who", { who: inline(l.who, 40) }) : "", time });
    };
    const over = listed.filter((l) => p.overdue.includes(l));
    const nxt = listed.filter((l) => p.next.includes(l));
    const soon = listed.filter((l) => p.later.includes(l));
    if (over.length) lines.push([SW()("overdue"), ...over.map(row)].join("\n"));
    if (soon.length) {
      const allToday = soon.every((l) => today(l.dueAt!, tz) === today(t, tz));
      lines.push([allToday ? SW()("laterToday") : SW()("before", { day: dayName(p.day) }), ...soon.map(row)].join("\n"));
    }
    if (nxt.length) lines.push([SW()("tomorrow", { day: nextWord }), ...nxt.map(row)].join("\n"));
    const rest = p.overdue.length + p.later.length + p.next.length - listed.length;
    if (rest > 0) lines.push(SW()("more", { n: rest }));
    // The week's end: what others owe that is late (their chase is its own card), and what is due after the next working day.
    if (wk?.waiting.length) {
      const due = (l: Loop): string => (l.dueAt ? SW()("wasDue", { day: dayLabel(l.dueAt) }) : "");
      lines.push([SW()("waiting"), ...wk.waiting.slice(0, ITEMS_MAX).map((l) =>
        SW()("waitingItem", { who: l.who ? `${inline(l.who, 40)}: ` : "", title: inline(l.title, 100), due: due(l) }))].join("\n"));
    }
    if (wk?.ahead.length) {
      const first = wk.ahead[0]!;
      const day = dayLabel(first.dueAt!);
      lines.push(SW()(wk.ahead.length === 1 ? "aheadOne" : "ahead", { n: wk.ahead.length, title: inline(first.title, 100), day }));
    }
    // The next working day's calendar: double bookings and invitations not answered (someone else's titles: one line each, quoted).
    const clock = (e: CalEvent): string => ownerClock(e.start, tz);
    for (const [a, b] of p.clashes.slice(0, 2)) {
      lines.push(SW()("clash", { day: cap(nextWord), a: inline(a.title, 60), at: clock(a), b: inline(b.title, 60), bt: clock(b) }));
    }
    if (p.unanswered.length) {
      lines.push(SW()("unanswered", { day: nextWord, list: p.unanswered.slice(0, 2).map((e) => `“${inline(e.title, 60)}” ${clock(e)}`).join(", ") }));
    }
    if (p.fit && p.fit.need > 0) {
      const w = { day: cap(nextWord), need: duration(p.fit.need), free: duration(p.fit.free) };
      lines.push(p.fit.free === 0 ? SW()("noFree", w) : p.fit.need > p.fit.free ? SW()("tight", w) : SW()("fits", w));
    }
    const buttons: { id: string; title: string }[] = [];
    listed.forEach((_l, k) => {
      if (roomy || k === 0) buttons.push({ id: `ep${k + 1}:${id}`, title: SW()("btnPlan", { i: k + 1 }) });
    });
    listed.forEach((_l, k) => {
      if (roomy || k === 0) buttons.push({ id: `ed${k + 1}:${id}`, title: SW()("btnDone", { i: k + 1 }) });
    });
    return { body: lines.join("\n\n"), buttons, items: listed.map((l) => ({ loop: l.id, title: inline(l.title, 140) })) };
  };

  /** The shutdown, now: composed and sent. True when it went or there was nothing to say (both end the day's slot). */
  const send = async (day: string): Promise<boolean> => {
    const t = now();
    const s = await load();
    if (s.sent.some((x) => x.day === day)) return true;
    const events = d.events ? await d.events().catch(() => null) : null;
    const p = planShutdown({ loops: await d.loops(), events, now: t, tz, hours: d.hours, quiet: d.quiet });
    const id = randomBytes(5).toString("hex");
    const roomy = await d.roomy().catch(() => false);
    const c = p ? compose(p, id, t, roomy) : null;
    if (!c) {
      s.sent.push({ id, day, at: t, items: [] });
      await save(s);
      return true;
    }
    const went = c.buttons.length ? await d.card(c.body, c.buttons, roomy).catch(() => false)
      : d.notify ? await d.notify(c.body).catch(() => false) : false;
    if (!went) return false;
    s.sent.push({ id, day, at: t, items: c.items });
    await save(s);
    d.log?.(SW()("logSent", { n: c.items.length }));
    return true;
  };

  /** The look, on every tick of the durable jobs: today's shutdown when its moment came. Whether one went now. */
  const sweep = (): Promise<boolean> => serial(async () => {
    // The panel's switch (src/day-helpers.ts) when there is one, else SHUTDOWN; switched on with SHUTDOWN=off, at the working day's end.
    if (d.enabled ? !(await d.enabled().catch(() => d.config.at !== null)) : d.config.at === null) return false;
    const t = now();
    const day = today(t, tz);
    if (!d.hours.days.includes(weekdayOf(day))) return false;
    const at = atMinute(day, d.config.at ?? d.hours.end, tz);
    if (at === null || t < at || t - at > LATE_MAX_MS) return false;
    if ((await load()).sent.some((x) => x.day === day)) return false;
    if (d.gentle && (await d.gentle().catch(() => false))) return false;
    if (d.quiet && quietAt(d.quiet, t, tz)) return false;
    if (d.events && busyUntil(await d.events().catch(() => [] as CalEvent[]), t) !== null) return false;
    if (!d.jobs) return send(day);
    let went = false;
    const out = await d.jobs.slot("shutdown", `shutdown:${day}`, at, async (c) => {
      const ok = await c.once("send", async () => (went = await send(day)));
      return ok ? undefined : "retry";
    });
    return out === "done" && went;
  }).catch((err: Error) => {
    log.error(`the evening wrap-up: ${err.message}`);
    return false;
  });

  /** Plan <n> or Done <n> on a shutdown: what to tell the owner ("" when another card says it). */
  const pressed = (what: "p" | "d", n: number, id: string): Promise<string> => serial(async () => {
    let s: State;
    try {
      s = await load();
    } catch (err) {
      log.warn(`the evening wrap-up could not be read, nothing changed: ${(err as Error).message}`);
      return SW()("unread");
    }
    const r = s.sent.find((x) => x.id === id);
    const item = r?.items[n - 1];
    if (!r || !item || now() - r.at > PRESS_MS) return SW()("gone");
    const open = (await d.loops()).some((l) => l.id === item.loop && isOpenLoop(l));
    if (!open) return SW()("closed", { title: item.title });
    return what === "p" ? d.plan(item.loop) : d.done(item.loop);
  });

  return { sweep, send, pressed, compose };
}
export type Shutdown = ReturnType<typeof createShutdown>;
