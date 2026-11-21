// The daily brief: every morning at MORNING_BRIEF (08:00 in the owner's zone unless set; "off" turns it off), one message with whatever is
// connected: the day, today's events from every calendar (overlaps marked, join links given), the reminders still due today, the mail and
// Slack lines when those are on, and one line inviting a question. With nothing connected and nothing due it is two lines, not silence: it is
// Pako's daily touch. BRIEF (src/whatsapp.ts) and the panel's "Today's brief" button give it on demand.
//
// It goes through the door's notifyOwner as urgent, so it reaches the phone (Telegram when paired, WhatsApp inside its 24 hours or by the notice
// template). STOP does not hold it: it only ever reaches the owner. The day it was last given is kept in the store, so a restart never sends it
// twice, and a server that was asleep at the hour catches up until noon.
//
// On a person's computer the hour is a durable job (src/jobs.ts, jobKind below): a laptop asleep at 08:00 gives it when it wakes, with a
// line that says why it is late, but only until 11:00 (an hour set at 11:00 or later: three hours); after that the day's brief is skipped,
// and the next BRIEF says so once.

import type { Express, Request } from "express";
import { clock } from "./day-time.ts";
import { rateLimit } from "express-rate-limit";
import { clashes, clashText, dayBounds, type CalEvent } from "./calendar.ts";
import type { Control } from "./control.ts";
import { locale, texts, type Lang } from "./i18n.ts";
import type { JobKind, Jobs } from "./jobs.ts";
import type { Kv } from "./kv.ts";
import { localToEpoch } from "./whatsapp.ts";
import { createLog } from "./log.ts";
import { readJsonRecord } from "./json-record.ts";

const log = createLog("brief");

type Env = Record<string, string | undefined>;

const T = texts(
  {
    morning: "☀️ Good morning{name}. Today is {date}.",
    afternoon: "👋 Good afternoon{name}. Today is {date}.",
    evening: "🌙 Good evening{name}. Today is {date}.",
    events: "📅 On your calendar today:",
    noEvents: "📅 Nothing on your calendar today.",
    unread: "📅 I couldn't read your calendar right now.",
    partial: "(I couldn't read all your calendars: something may be missing.)",
    allDay: "all day",
    left: "📅 Still ahead today:",
    over: "✓ {n} already over today.",
    nothingLeft: "📅 Nothing left on your calendar today ({n} already over).",
    more: "…and {n} more",
    reminders: "⏰ Reminders for today:",
    invite: "Anything you'd like me to look into or help with today? Just ask.",
    connect: "Nothing is connected yet, so there is little to tell. Connect your calendar and mail in Pako's Settings (Your connections), and tomorrow's brief will have your day in it.",
    failed: "I couldn't put the brief together right now. Try again in a moment.",
    logSent: "Daily brief sent",
    logAsked: "Daily brief, asked for",
    late: "⏰ Late: your computer was asleep at {hour}.",
    skipped: "(The {hour} brief of {when} didn't go out: your computer was asleep until after {until}.)",
    today: "today",
    logSkipped: "Daily brief of {when} not sent: the computer was asleep",
  },
);

/** The daily brief's hour, as minutes after midnight in the owner's zone; null when it is off. */
export function loadBriefConfig(env: Env): { at: number | null; problems: string[] } {
  const raw = (env.MORNING_BRIEF ?? "").trim().toLowerCase();
  if (raw === "") return { at: 8 * 60, problems: [] };
  if (raw === "off") return { at: null, problems: [] };
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return { at: null, problems: ["MORNING_BRIEF must be like 08:00, or off (the daily brief is off until it is)"] };
  return { at: Number(m[1]) * 60 + Number(m[2]), problems: [] };
}

/** At most this many events and reminders are listed: the rest is counted, so a busy day still fits one message. */
const LIST_MAX = 15;
const STATE_KEY = "brief-state";
/** Where the calendar kept the brief's day before the brief had its own module: read once, so the day of an upgrade gets no second brief. */
const LEGACY_KEY = "calendar-state";
/** A day whose brief was skipped is said by BRIEF for this long; then it is old news. */
const SKIPPED_SAY_MS = 7 * 24 * 3600_000;
const DAY_MS = 24 * 3600_000;

const hhmm = clock;

/** On a computer, until when (minutes after midnight) a brief missed at its hour still comes: 11:00, or three hours for a later hour. */
export const lateUntil = (at: number): number => (at < 11 * 60 ? 11 * 60 : Math.min(at + 180, 24 * 60));

/**
 * The moment of `minutes` after midnight on the local day `ymd` ("2026-11-17"); when daylight saving skips that hour, the first real
 * minute after it (a quarter of an hour at a time).
 */
export function localMinute(ymd: string, minutes: number, timeZone: string): number | null {
  for (let k = 0; k <= 8; k++) {
    const m = minutes + 15 * k;
    if (m >= 24 * 60) break;
    const at = localToEpoch(`${ymd} ${hhmm(m)}`, timeZone);
    if (at !== null) return at;
  }
  return null;
}

export interface BriefDeps {
  /** Minutes after midnight in the owner's zone (loadBriefConfig); null: only on demand. */
  at: number | null;
  kv: Kv | null;
  timeZone: string;
  /** Tells the owner: the door's notifyOwner with urgent (src/whatsapp.ts). */
  notify: (text: string) => Promise<unknown>;
  /** The late line alone, when the written brief follows it (the door's notifyOwner, urgent): what comes after a brief must not come before. */
  notifyNote?: (text: string) => Promise<unknown>;
  /**
   * Each connected calendar's events for today (src/calendar.ts today, or todayRead with `partial` when one of its sources could not be read);
   * one that throws is said as not read, the others still come.
   */
  calendars?: (() => Promise<CalEvent[] | { events: CalEvent[]; partial: boolean }>)[];
  /** The door's reminders (src/whatsapp.ts reminders). */
  reminders?: () => Promise<{ at: number; text: string; held: boolean }[]>;
  /**
   * One line each from the other channels (mail, Slack), null when they have nothing. `since`: when the last brief before this one was
   * given (at least a day back, at most a week): after a skipped brief, what changed is told from then, not only since yesterday.
   */
  extras?: ((o: { now: number; since: number }) => Promise<string | null>)[];
  /** Lines that come first, right under the greeting (gentle mode's week's focus: src/gentle-reset.ts); null for none. */
  first?: (() => Promise<string | null>)[];
  /** The name the owner gave, "" for none (the greeting then has none). */
  name?: () => string;
  control?: Control;
  /** The language of what it writes (src/i18n.ts), asked each time. English without it. */
  lang?: () => Lang;
  now?: () => number;
  /**
   * The written brief (src/brief-v2.ts), when on: the scheduled brief hands the day over to it (begin answers false when it cannot take it,
   * and the brief goes as before at once); BRIEF answers its short version once today's is written.
   */
  smart?: { begin: (t: number, o?: { since: number }) => Promise<boolean>; short: () => Promise<string | null> };
}

export function createBrief(d: BriefDeps) {
  const now = d.now ?? Date.now;
  const lang = d.lang ?? ((): Lang => "en");
  const calendars = d.calendars ?? [];
  const extras = d.extras ?? [];
  const fmt = (o: Intl.DateTimeFormatOptions, l: Lang) => new Intl.DateTimeFormat(locale(l), { timeZone: d.timeZone, ...o });
  const ymd = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: d.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
  /** Minutes after local midnight: read by the code, so the same digits whatever the language. */
  const minutesOf = (t: number): number => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: d.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(t).map((x) => [x.type, x.value]));
    return Number(p.hour) * 60 + Number(p.minute);
  };

  // The same error once an hour, not every minute.
  let lastLogged = { text: "", at: 0 };
  const logOnce = (text: string): void => {
    if (text === lastLogged.text && now() - lastLogged.at < 3600_000) return;
    lastLogged = { text, at: now() };
    log.error(`${text}`);
  };

  /** The whole brief as the owner reads it, for the moment t, in the language asked for now. */
  /**
   * When the last brief before today's was given: its day at the brief's hour, at least a day back and at most a week (a day back when none
   * is known). A laptop that slept through yesterday's brief tells today what changed since the day before.
   */
  const sinceLast = (t: number): number => {
    const today = ymd(t);
    const day = lastDay && lastDay < today ? lastDay : givenBefore && givenBefore < today ? givenBefore : null;
    const at = day ? localMinute(day, d.at ?? 0, d.timeZone) : null;
    return Math.min(t - DAY_MS, Math.max(at ?? t - DAY_MS, t - 7 * DAY_MS));
  };

  const compose = async (t: number): Promise<string> => {
    const l = lang();
    const say = T(l);
    const hm = (at: number) => fmt({ hour: "2-digit", minute: "2-digit" }, l).format(at);
    const { start, end } = dayBounds(t, d.timeZone);
    const minutes = minutesOf(t);
    const name = (d.name?.() ?? "").trim();
    const greeting = say(minutes < 12 * 60 ? "morning" : minutes < 20 * 60 ? "afternoon" : "evening", {
      name: name ? `, ${name}` : "",
      date: fmt({ weekday: "long", day: "numeric", month: "long" }, l).format(t),
    });
    const sections: string[] = [];
    const first = (await Promise.all((d.first ?? []).map((x) => x().catch(() => null)))).filter((x): x is string => typeof x === "string" && x.trim() !== "");
    if (first.length) sections.push(first.join("\n"));

    if (calendars.length) {
      const read = await Promise.allSettled(calendars.map((c) => c()));
      const ok = read.flatMap((r) => (r.status === "fulfilled" ? [Array.isArray(r.value) ? { events: r.value, partial: false } : r.value] : []));
      for (const r of read) if (r.status === "rejected") logOnce(`a calendar could not be read: ${(r.reason as Error)?.message ?? r.reason}`);
      // Each source's own today, filtered again here: a source that gives more than today must not put tomorrow in today's brief.
      const events = ok.flatMap((r) => r.events).filter((e) => e.start < end && e.end > start).sort((a, b) => a.start - b.start);
      const partial = ok.length < read.length || ok.some((r) => r.partial) ? `\n${say("partial")}` : "";
      if (!ok.length) sections.push(say("unread"));
      else if (!events.length) sections.push(`${say("noEvents")}${partial}`);
      else {
        // Asked later in the day (BRIEF at 17:00): what has ended is counted, not listed as if still ahead. At 08:00 nothing has.
        const over = events.filter((e) => !e.allDay && e.end <= t).length;
        const left = events.filter((e) => e.allDay || e.end > t);
        const clash = clashes(left);
        const lines = left.slice(0, LIST_MAX).map((e) => {
          const time = e.allDay ? say("allDay") : `${hm(e.start)}–${hm(e.end)}`;
          // The link only while it can still be used: a meeting that is over needs none.
          const join = e.join && !e.allDay && e.end > t ? `\n  🎥 ${e.join}` : "";
          const c = clash.get(e.id);
          return `• ${time} ${e.title}${e.location ? ` (${e.location})` : ""}${c ? ` ⚠️ ${clashText(c, l)}` : ""}${join}`;
        });
        if (left.length > LIST_MAX) lines.push(say("more", { n: left.length - LIST_MAX }));
        if (!left.length) sections.push(`${say("nothingLeft", { n: over })}${partial}`);
        else if (!over) sections.push(`${say("events")}\n${lines.join("\n")}${partial}`);
        else sections.push(`${say("left")}\n${lines.join("\n")}\n${say("over", { n: over })}${partial}`);
      }
    }

    if (d.reminders) {
      // Still to come today: a reminder already due is given on its own (or with the owner's next message, when it is held).
      const due = await d.reminders().then(
        (list) => list.filter((r) => !r.held && r.at >= t && r.at < end).sort((a, b) => a.at - b.at),
        (err: Error) => (logOnce(`the reminders could not be read: ${err.message}`), []),
      );
      if (due.length) {
        const lines = due.slice(0, LIST_MAX).map((r) => `• ${hm(r.at)} ${r.text}`);
        if (due.length > LIST_MAX) lines.push(say("more", { n: due.length - LIST_MAX }));
        sections.push(`${say("reminders")}\n${lines.join("\n")}`);
      }
    }

    const span = { now: t, since: sinceLast(t) };
    const other = (await Promise.all(extras.map((x) => x(span).catch(() => null)))).filter((x): x is string => typeof x === "string" && x.trim() !== "");
    if (other.length) sections.push(other.join("\n"));

    // Nothing to say: two lines, the greeting and the invitation (still the daily touch).
    // Nothing to read at all (no calendar, no mail or Slack): a first brief says how to change that, instead of only a greeting.
    if (!calendars.length && !(d.extras ?? []).length) sections.push(say("connect"));
    return sections.length ? `${greeting}\n\n${sections.join("\n\n")}\n\n${say("invite")}` : `${greeting}\n${say("invite")}`;
  };

  // ---------- the day it was last given, kept in the store ----------
  let lastDay: string | null = null;
  /** The day given before lastDay (this process only): what "since the last brief" means once today's is kept. */
  let givenBefore: string | null = null;
  /** A day whose scheduled brief was skipped (the computer slept past its last hour), until BRIEF says so; "" once said. */
  let skipped: string | null = null;
  /**
   * Throws when the store cannot be read: guessing "never" could send a second brief after a restart. `fresh` reads the store again even when
   * the day is known here: during a deploy the old server and the new one run side by side for a moment, and the other may have given it.
   */
  const loadDay = async (fresh = false): Promise<string> => {
    if (lastDay !== null && !fresh) return lastDay;
    const raw = d.kv ? await readJsonRecord(d.kv, STATE_KEY) : null;
    let day = "";
    try {
      const p = raw ? (raw as { day?: unknown; skipped?: unknown }) : null;
      if (typeof p?.day === "string") day = p.day;
      // Older stores have no skipped day: none.
      if (typeof p?.skipped === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.skipped) && skipped === null) skipped = p.skipped;
    } catch {
      log.error("the stored day could not be used: starting again");
    }
    if (d.kv) {
      // Before this module the calendar kept the day as briefDay: a server upgraded after this morning's brief (or an old server still running
      // beside the new one while it deploys, which writes only there) must not lead to another. The later of the two days counts.
      try {
        const old = ((await readJsonRecord(d.kv, LEGACY_KEY)) ?? {}) as { briefDay?: unknown };
        if (typeof old.briefDay === "string" && old.briefDay > day) day = old.briefDay;
      } catch {
        /* nothing usable there */
      }
    }
    // A brief given while the store was being read (saveDay) is newer than what it held.
    const meanwhile = lastDay as string | null;
    lastDay = meanwhile !== null && meanwhile > day ? meanwhile : day;
    return lastDay;
  };
  const saveDay = async (day: string): Promise<void> => {
    if (lastDay && lastDay < day) givenBefore = lastDay;
    lastDay = day;
    if (!d.kv) return;
    try {
      await d.kv.set(STATE_KEY, JSON.stringify({ day, ...(skipped ? { skipped } : {}) }), 30 * 24 * 3600);
    } catch (err) {
      // Kept in memory: no second brief from this process. Said, as a restart before the store answers again could give one.
      log.error(`could not keep today's day in the store: ${(err as Error).message}`);
    }
  };

  // One at a time: a scheduled brief and one asked for at that very moment must not both find the day unused.
  let chain: Promise<unknown> = Promise.resolve();
  const lock = <R>(fn: () => Promise<R>): Promise<R> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  /** Until when, in minutes after midnight, a brief missed at its hour still comes: noon, or four hours for an hour set at noon or later. */
  const until = (at: number): number => (at < 12 * 60 ? 12 * 60 : Math.min(at + 240, 24 * 60));

  /** The scheduled brief: true when it was sent now. Called every minute; once a day, from the hour until the catch-up ends. */
  const tick = (): Promise<boolean> =>
    lock(async () => {
      if (d.at === null) return false;
      const t = now();
      const minutes = minutesOf(t);
      if (minutes < d.at || minutes >= until(d.at)) return false;
      return (await give(t)) === "sent";
    });

  /**
   * Today's brief, unless it was given today already (the day kept in the store is the slot's check): "sent" now, "given" before, "wait"
   * when the store could not say.
   */
  const give = async (t: number, note?: string): Promise<"sent" | "given" | "wait"> => {
    const today = ymd(t);
    let last: string;
    try {
      last = await loadDay();
      // Not given from here today: the store is read again just before giving it, in case another server (a deploy's overlap) just did.
      if (last !== today) last = await loadDay(true).catch(() => last);
    } catch (err) {
      logOnce(`the store could not be read, the brief waits for it: ${(err as Error).message}`);
      return "wait";
    }
    if (last === today) return "given";
    if (d.smart) {
      // Kept first: the written brief comes (or the old one instead) from src/brief-v2.ts, never a second one from here.
      const since = sinceLast(t);
      await saveDay(today);
      if (note) await (d.notifyNote ?? d.notify)(note);
      const taken = await d.smart.begin(t, { since }).catch((err: Error) => (logOnce(`the written brief could not start: ${err.message}`), false));
      if (!taken) await plain(t);
      return "sent";
    }
    const text = await compose(t);
    // Kept before it is sent: a send that fails half way must not become a second brief on the next tick.
    await saveDay(today);
    await d.notify(note ? `${note}\n\n${text}` : text);
    d.control?.log("brief", T(lang())("logSent"));
    return "sent";
  };

  /** A day whose scheduled brief was skipped: kept until BRIEF says so. */
  const skip = (day: string): Promise<void> =>
    lock(async () => {
      try {
        await loadDay();
      } catch {
        /* kept in memory, and written with the next day given */
      }
      skipped = day;
      d.control?.log("brief", T(lang())("logSkipped", { when: day }));
      if (lastDay !== null) await saveDay(lastDay);
      else if (d.kv) await d.kv.set(STATE_KEY, JSON.stringify({ day: "", skipped: day }), 30 * 24 * 3600).catch(() => undefined);
    });

  /** The line BRIEF gives once about a skipped brief, or null. */
  const skippedLine = (t: number): string | null => {
    if (!skipped || d.at === null) return null;
    const at = localMinute(skipped, d.at, d.timeZone);
    if (at === null || t - at > SKIPPED_SAY_MS || at > t) return null;
    const l = lang();
    const when = skipped === ymd(t) ? T(l)("today") : fmt({ weekday: "long", day: "numeric", month: "long" }, l).format(at);
    return T(l)("skipped", { hour: hhmm(d.at), when, until: hhmm(lateUntil(d.at)) });
  };

  /** Today's brief as before, sent now: the scheduled one without the written brief, and what goes when the written one does not come. */
  const plain = async (t: number = now()): Promise<void> => {
    const text = await compose(t);
    await d.notify(text);
    d.control?.log("brief", T(lang())("logSent"));
  };

  /** On a computer (the durable jobs say so): a brief missed at its hour comes until lateUntil, not until noon. */
  let sleeps = false;
  /**
   * The old brief instead of a written one that did not come: only for the day that was handed to it, and only while a brief may still come.
   * A laptop that slept with the written brief pending gets no "good morning" at 19:00 (BRIEF says it was skipped), and on waking the
   * next day before the hour no brief of that new day goes early: its own hour gives it.
   */
  const fallback = async (): Promise<void> => {
    const t = now();
    const day = await loadDay().catch(() => null);
    const last = d.at === null ? 24 * 60 : sleeps ? lateUntil(d.at) : until(d.at);
    if (day === ymd(t) && minutesOf(t) < last) return plain(t);
    log.error(`the written brief did not come in time, and the old one is too late now: none goes for ${day ?? "?"}`);
    if (sleeps && day === ymd(t)) await skip(day);
  };

  /**
   * The brief on demand (BRIEF, the panel's button): the text to show where it was asked. It counts as today's, so the morning's
   * does not come again on a day the owner already read one.
   */
  const now_ = (): Promise<string> =>
    lock(async () => {
      const t = now();
      let text: string;
      try {
        text = (await d.smart?.short().catch(() => null)) ?? (await compose(t));
      } catch (err) {
        logOnce(`the brief could not be made: ${(err as Error).message}`);
        return T(lang())("failed");
      }
      await loadDay().catch(() => "");
      const said = skippedLine(t);
      // Said once: from now on it is not.
      if (skipped) skipped = null;
      if (said) text = `${said}\n\n${text}`;
      await saveDay(ymd(t));
      d.control?.log("brief", T(lang())("logAsked"));
      return text;
    });

  /**
   * The brief as a durable job (src/jobs.ts): one slot a day, "brief:2026-11-17", due at the hour. On a computer (`sleeps`) it runs late
   * until lateUntil with a line that says why, and is skipped after that (BRIEF says so); on a server, as `tick` does: until noon, silently.
   */
  const jobKind = (o: { sleeps: boolean }): JobKind => ({
    kind: "brief",
    plan: (t) => {
      if (d.at === null) return [];
      const day = ymd(t);
      const dueAt = localMinute(day, d.at, d.timeZone);
      return dueAt === null ? [] : [{ slot: `brief:${day}`, dueAt }];
    },
    policy: ({ job, now: t }) => {
      if (d.at === null) return "skip";
      const day = job.slot.slice("brief:".length);
      const last = o.sleeps ? lateUntil(d.at) : until(d.at);
      return ymd(t) === day && minutesOf(t) < last ? "run" : "skip";
    },
    run: async (c) => {
      // «tu ordenador estaba dormido» only for a sleep seen: not when Pako was simply not running yet (a first start, opened after a quit).
      const note = o.sleeps && c.slept && !c.off && c.late && d.at !== null ? T(lang())("late", { hour: hhmm(d.at) }) : undefined;
      return (await lock(() => give(now(), note))) === "wait" ? "retry" : undefined;
    },
    missed: async (job, m) => {
      if (o.sleeps && !m.off) await skip(job.slot.slice("brief:".length));
    },
  });

  return {
    compose,
    tick,
    jobKind,
    /** What goes when the written brief does not come (src/brief-v2.ts giveUp): see fallback. */
    plain: () => fallback(),
    now: now_,
    /** With the durable jobs (src/jobs.ts), the brief is their slot a day; without them, its own timers as before. */
    start: (jobs?: Pick<Jobs, "define" | "sleeps">) => {
      // The day is read at once (before the calendar can save its state without the old briefDay); the first look comes half a minute after
      // the start, so a server woken after the hour catches up without waiting a whole minute.
      void loadDay().catch(() => undefined);
      if (jobs) {
        sleeps = !!jobs.sleeps;
        jobs.define(jobKind({ sleeps: jobs.sleeps }));
        return;
      }
      setTimeout(() => void tick().catch((err: Error) => logOnce(err.message)), 30_000).unref?.();
      setInterval(() => void tick().catch((err: Error) => logOnce(err.message)), 60_000).unref?.();
    },
  };
}

export type Brief = ReturnType<typeof createBrief>;

/**
 * The panel's "Today's brief" button (src/panel/brief.js): POST /panel/api/brief answers the brief's text. Same protection as STOP: the
 * signed-in session and the x-pako header another site cannot send.
 */
export function mountBriefPanel(app: Express, d: { signedIn: (req: Request) => boolean; brief: () => Promise<string> }): void {
  const limiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });
  // Nothing is read from the body: the button asks for today's brief, no more.
  app.post("/panel/api/brief", (req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    if (!d.signedIn(req) || req.get("x-pako") !== "1") {
      res.status(401).json({ error: "sign in" });
      return;
    }
    next();
  }, limiter, async (_req, res) => {
    res.json({ text: await d.brief() });
  });
}
