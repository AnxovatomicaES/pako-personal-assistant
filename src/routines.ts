// Routines and watches: the owner's standing requests.
//
// A routine is a short prompt the owner asked for on a schedule ("every Friday at 18:00 ask me about the weekly report"). At its time the
// server puts the prompt in the assistant's inbox as a turn of the owner's own (they wrote it: it may act like any message of theirs), and the
// answer comes to the owner like a notice (src/whatsapp.ts: kept for later when WhatsApp's 24-hour window is closed). The schedule is the one
// of the repeating reminders (src/whatsapp.ts repeatAfter): the owner's time zone, the hour kept across a change of daylight saving.
//
// A watch is a condition checked by the server against data Pako already has: the mail of its own inbox (src/mail.ts), the calendar's coming
// events (src/calendar.ts), the Slack alerts (src/slack.ts). Nothing is fetched from the web for it. The condition is plain words matched by
// code against fields that cannot quote it: an email's SENDER ADDRESS and its subject, never its body nor Claude's summary of it; an event's
// title; a Slack alert's author and text. A hit sends one message, written here; a watch is one-shot (it goes after its hit) or ongoing.
//
// Safety, which does not depend on the model:
// - Both are made by the assistant's <routine> and <watch> tags only on a turn of the owner's own: a turn that read outside text, and a
//   routine's own run, cannot make one (src/whatsapp.ts says so to the owner). Each one made gets a receipt with Undo (src/undo.ts).
// - At most ROUTINES_MAX routines and WATCHES_MAX watches. While everything is paused (STOP) no routine runs and no watch tells anything:
//   their times go by, nothing is kept to pour out after RESUME.
// - A routine runs at most once per occurrence, across a restart and two copies of the server sharing one store (a deploy's overlap): an
//   occurrence is claimed in the store (a key per occurrence, written and read back after a pause) before it is queued, and a claim found there
//   means it is not run again. A watch's hit is claimed the same way. The store gives no atomic write, so the pause is what makes two copies
//   that look at once both see the last writer.
//
// One key in the store for both lists, read again before every change (another copy may have changed it), never overwritten from a copy that
// could not be read.

import { createHash, randomBytes } from "node:crypto";
import express, { type Express, type Request, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import type { Control } from "./control.ts";
import { texts, type Lang } from "./i18n.ts";
import { GRACE_MS, type Jobs } from "./jobs.ts";
import type { Kv } from "./kv.ts";
import { fold } from "./lists.ts";
import { addressOf } from "./mail.ts";
import { inline } from "./quarantine.ts";
import { isEvery, repeatText, whenText, type Every } from "./undo.ts";
import { firstRepeat, localStamp, localToEpoch, repeatAfter } from "./whatsapp.ts";
import { createLog } from "./log.ts";

const log = createLog("routines");

export type WatchSource = "mail" | "calendar" | "slack";
const SOURCES: readonly WatchSource[] = ["mail", "calendar", "slack"];
export const isWatchSource = (v: unknown): v is WatchSource => typeof v === "string" && (SOURCES as readonly string[]).includes(v);

export interface Routine {
  /** 10 lowercase hex characters: the panel, the receipt and the inbox name a routine by it. */
  id: string;
  /** The number the owner names it by (DELETE ROUTINE 2): never given to another while this one is there. */
  n: number;
  /** The prompt, in the owner's words: what the assistant is asked at each time. */
  text: string;
  every: Every;
  /** Its first time as written ("2026-11-20 18:00"): the day of the month and the hour every next one keeps. */
  anchor: string;
  /** Its next time (epoch ms). */
  next: number;
  at: number;
  /** Paused by the owner (PAUSE ROUTINE 2): its times go by without a run. */
  paused?: boolean;
}

/** A calendar watch's view of the events it matched at its last look, by event id. */
type CalSeen = Record<string, { sig: string; title: string; start: number; miss?: number }>;

export interface Watch {
  id: string;
  n: number;
  /** What it is for, in the owner's words ("an email from my bank"). */
  text: string;
  on: WatchSource;
  /** Words of the sender's address (mail) or of who wrote (Slack): any one is enough. */
  from: string[];
  /** Words of the subject (mail), the title (calendar) or the text (Slack): any one is enough. With `from` too, both must match. */
  words: string[];
  /** Goes after its first hit. */
  once: boolean;
  at: number;
  paused?: boolean;
  hits: number;
  lastHit?: number;
  cal?: CalSeen;
}

/** What a receipt keeps to undo a routine or a watch that a tag made (src/undo.ts). */
export interface SavedRoutine {
  id: string;
  text: string;
  every: Every;
  next: number;
}
export interface SavedWatch {
  id: string;
  text: string;
  on: WatchSource;
  once: boolean;
}

interface Book {
  routines: Routine[];
  watches: Watch[];
  /** Mail ids and Slack alerts already looked at: a watch is told only of what came after it was made. Absent: not looked at yet. */
  seen: { mail?: string[]; slack?: string[] };
}

const ROUTINES_KEY = "assistant-routines";
const TTL_SECONDS = 400 * 24 * 3600;
/** A claimed occurrence or hit: kept long enough to outlive any restart or overlap that could run it again. */
const CLAIM_TTL_S = 8 * 24 * 3600;
const runKey = (name: string): string => `assistant-routine-run:${name}`;
export const ROUTINES_MAX = 20;
export const WATCHES_MAX = 20;
const TEXT_MAX = 300;
const TERM_MAX = 60;
const TERMS_MAX = 5;
const SEEN_MAX = 300;
/** A routine's time missed by more than this (the server was down) is skipped: a "good morning" routine at night helps nobody. */
const LATE_MS = 3 * 3600_000;
/** An ongoing watch tells at most this many times a day: a busy sender must not become a flood. */
const HITS_PER_DAY = 10;
const DAY_MS = 24 * 3600_000;
const HEX10 = /^[0-9a-f]{10}$/;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";
const line = (s: string, max: number): string => s.replace(/\s+/g, " ").trim().slice(0, max);
const strs = (v: unknown, max: number, len: number): string[] =>
  (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string").map((x) => line(x, len)).filter(Boolean).slice(0, max);

/** The words of a condition as the code compares them: folded (no case, no accents), 3 characters at least ("it" alone would match half of every text), a few at most. */
export function terms(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;|]/) : [];
  const out = list.filter((x): x is string => typeof x === "string").map((x) => fold(x).slice(0, TERM_MAX)).filter((x) => x.length >= 3);
  return [...new Set(out)].slice(0, TERMS_MAX);
}

const routineOf = (v: unknown): Routine | null => {
  if (!isObject(v) || typeof v.id !== "string" || !HEX10.test(v.id) || typeof v.text !== "string" || !v.text) return null;
  if (!isEvery(v.every) || typeof v.anchor !== "string" || typeof v.next !== "number" || typeof v.n !== "number") return null;
  return {
    id: v.id, n: v.n, text: v.text.slice(0, TEXT_MAX), every: v.every, anchor: v.anchor, next: v.next, at: typeof v.at === "number" ? v.at : 0,
    ...(v.paused === true ? { paused: true } : {}),
  };
};
const watchOf = (v: unknown): Watch | null => {
  if (!isObject(v) || typeof v.id !== "string" || !HEX10.test(v.id) || typeof v.text !== "string" || !v.text || !isWatchSource(v.on)) return null;
  if (typeof v.n !== "number") return null;
  const cal: CalSeen = {};
  if (isObject(v.cal)) {
    for (const [k, x] of Object.entries(v.cal).slice(0, 40)) {
      if (isObject(x) && typeof x.sig === "string" && typeof x.title === "string" && typeof x.start === "number") {
        cal[k] = { sig: x.sig, title: x.title, start: x.start, ...(typeof x.miss === "number" ? { miss: x.miss } : {}) };
      }
    }
  }
  return {
    id: v.id, n: v.n, text: v.text.slice(0, TEXT_MAX), on: v.on, from: terms(v.from), words: terms(v.words), once: v.once !== false,
    at: typeof v.at === "number" ? v.at : 0, hits: typeof v.hits === "number" ? v.hits : 0,
    ...(v.paused === true ? { paused: true } : {}),
    ...(typeof v.lastHit === "number" ? { lastHit: v.lastHit } : {}),
    ...(isObject(v.cal) ? { cal } : {}),
  };
};
function clean(raw: unknown): Book {
  const o = isObject(raw) ? raw : {};
  const seen = isObject(o.seen) ? o.seen : {};
  return {
    routines: (Array.isArray(o.routines) ? o.routines : []).map(routineOf).filter((x): x is Routine => x !== null).slice(0, ROUTINES_MAX),
    watches: (Array.isArray(o.watches) ? o.watches : []).map(watchOf).filter((x): x is Watch => x !== null).slice(0, WATCHES_MAX),
    seen: {
      ...(Array.isArray(seen.mail) ? { mail: strs(seen.mail, SEEN_MAX, 300) } : {}),
      ...(Array.isArray(seen.slack) ? { slack: strs(seen.slack, SEEN_MAX, 40) } : {}),
    },
  };
}

/**
 * The address in "Ana <ana@bank.example>" (what a sender cannot dress up as someone else's), or the whole text when there is none: src/mail.ts's,
 * which takes the last pair, since a display name may itself look like an address ("<avisos@bbva.es>" <x@evil.example>).
 */
export { addressOf };
const has = (field: string, list: string[]): boolean => {
  const f = fold(field);
  return list.some((w) => f.includes(w));
};

export interface MailSeen {
  id: string;
  at: number;
  from: string;
  subject: string;
}
export interface EventSeen {
  id: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  location?: string;
}
export interface SlackSeen {
  at: number;
  where: string;
  text: string;
}

/**
 * Whether an email meets a watch: the sender's ADDRESS has one of `from`, and the subject one of `words` (each only when given). Never the
 * body, never a summary: text that only quotes the condition ("this is a mail from your bank") cannot make a hit.
 */
export const mailHit = (w: Pick<Watch, "from" | "words">, m: Pick<MailSeen, "from" | "subject">): boolean =>
  (w.from.length > 0 || w.words.length > 0) && (!w.from.length || has(addressOf(m.from), w.from)) && (!w.words.length || has(m.subject, w.words));
export const slackHit = (w: Pick<Watch, "from" | "words">, a: Pick<SlackSeen, "where" | "text">): boolean =>
  (w.from.length > 0 || w.words.length > 0) && (!w.from.length || has(a.where, w.from)) && (!w.words.length || has(a.text, w.words));
export const eventHit = (w: Pick<Watch, "words">, e: Pick<EventSeen, "title">): boolean => w.words.length > 0 && has(e.title, w.words);

/** What the server already has, for the watches: each absent when that part is not connected. */
export interface WatchSources {
  mail?: () => Promise<MailSeen[]>;
  calendar?: () => Promise<EventSeen[]>;
  slack?: () => Promise<SlackSeen[]>;
}

export interface RoutinesDeps {
  kv: Kv | null;
  timeZone: string;
  now?: () => number;
  lang?: () => Lang;
  control?: Control;
  /** Puts a routine's prompt in the assistant's inbox (src/whatsapp.ts). False when that id was there already. */
  enqueue: (m: { id: string; at: number; text: string; routine: { id: string; text: string } }) => Promise<boolean>;
  /** Tells the owner (src/whatsapp.ts notifyOwner: kept for later when WhatsApp's window is closed). */
  notify: (text: string) => Promise<unknown>;
  /** Read each time: a part connected later counts at once. */
  sources?: () => WatchSources;
  /** How long a claim waits before it reads itself back (default 1.5 s; the tests use a few ms). */
  claimMs?: number;
  /** The durable jobs (src/jobs.ts): on a computer, a routine whose time fell while it slept is skipped, and the owner told once. */
  jobs?: Pick<Jobs, "slept">;
}

// ---------- the words (src/i18n.ts) ----------

const T = texts(
  {
    quoted: "“{s}”",
    run: "[A routine you scheduled ({every}); do it now and answer me:] {text}",
    badTime: "I couldn't schedule the routine {q}: I don't understand the time “{when}”.",
    past: "I couldn't schedule the routine {q}: its first time has already passed.",
    tooFar: "I couldn't schedule the routine {q}: its first time is more than a year away.",
    badEvery: "I couldn't schedule the routine {q}: tell me how often (every day, every week, every month…).",
    empty: "The routine doesn't say what to do: tell me in more words.",
    routinesFull: "There's no room for more routines (the most is {n}). Delete one with DELETE ROUTINE and its number.",
    watchesFull: "There's no room for more watches (the most is {n}). Delete one with DELETE WATCH and its number.",
    noSource: "I can't watch that: {source} isn't connected.",
    noTerms: "I couldn't set up the watch {q}: I need specific words (of the sender, the subject or the title).",
    outside: "I didn't set up the routine or the watch: this answer was written reading other people's text. If you want it, ask me yourself.",
    fromRoutine: "A routine can't set up other routines or watches. If you want one, ask me yourself.",
    old: "I didn't set up the routine or the watch: Pako's server doesn't know them yet (it needs an update).",
    srcMail: "your email",
    srcCalendar: "your calendar",
    srcSlack: "Slack",
    routinesNone: "You have no routines. Just ask me: “every Friday at 18:00 ask me about the weekly report”.",
    routinesHead: "🔁 Your routines:",
    routineLine: "• {n} · {every}, next on {when} · {q}{paused}",
    routinesFoot: "DELETE ROUTINE and its number removes one; PAUSE ROUTINE stops it and RESUME ROUTINE starts it again.",
    watchesNone: "I'm not watching anything. Just ask me: “tell me if an email from my bank arrives”.",
    watchesHead: "👀 What I'm watching:",
    watchLine: "• {n} · {what} · {q}{once}{paused}",
    watchesFoot: "DELETE WATCH and its number removes one; PAUSE WATCH stops it and RESUME WATCH starts it again.",
    paused: " (paused)",
    once: " (once)",
    mailWhat: "email",
    calendarWhat: "calendar",
    slackWhat: "Slack",
    fromTerms: " from {list}",
    wordTerms: " with {list}",
    unread: "I couldn't read your routines right now. Try again in a while.",
    unsaved: "I couldn't save the change right now. Try again in a while.",
    notFound: "You have no {kind} number {n}. Type {list} to see them.",
    kindRoutine: "routine",
    kindWatch: "watch",
    listRoutines: "ROUTINES",
    listWatches: "WATCHES",
    deleted: "🗑️ Removed the {kind} {q}.",
    pausedNow: "⏸️ Paused the {kind} {q}. RESUME {word} {n} starts it again.",
    resumedNow: "▶️ The {kind} {q} is running again.",
    wordRoutine: "ROUTINE",
    wordWatch: "WATCH",
    hitHead: "👀 Something you asked me to watch for: {q}",
    hitMail: "• Email from {from}{subject}",
    hitSubject: ": “{s}”",
    hitSlack: "• Slack, {where}: {text}",
    hitAdded: "• New in your calendar: {title}, {when}",
    hitChanged: "• Changed: {title}, now {when} (was {was})",
    hitRemoved: "• No longer in your calendar for the coming days: {title} ({when})",
    hitMore: "…and {n} more.",
    hitOnce: "I've stopped watching it: it was a one-off.",
    logRun: "Routine {q}: asked of the assistant",
    logSkip: "Routine {q}: not done ({why})",
    whyPaused: "Pako was paused",
    whyLate: "its time passed too long ago",
    whySlept: "the computer was asleep",
    sleptOne: "💤 Your computer was asleep at the time of the routine {q} ({when}): I skipped it; the next one will come at its time.",
    sleptMany: "💤 Your computer was asleep at the time of these routines: I skipped them; the next ones will come at their time.\n{list}",
    logHit: "Watch {q}: told",
    logRoutine: "New routine {q} ({every})",
    logWatch: "New watch {q}",
    logRemoved: "Removed the {kind} {q}",
    ctxRoutine: "{n} · {every} · next {when} · {text}{paused}",
    ctxWatch: "{n} · {what} · {text}{once}{paused}",
  },
);
export const routineTexts = T;
export type RoutineSay = "outside" | "fromRoutine" | "old";

const cutQ = (l: Lang, s: string, max = 80): string => T(l)("quoted", { s: s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s });

/** "mail from bank.example with invoice": what a watch looks at, as the owner reads it. */
export function watchWhat(w: Pick<Watch, "on" | "from" | "words">, l: Lang): string {
  const t = T(l);
  const what = t(w.on === "mail" ? "mailWhat" : w.on === "calendar" ? "calendarWhat" : "slackWhat");
  return `${what}${w.from.length ? t("fromTerms", { list: w.from.join(", ") }) : ""}${w.words.length ? t("wordTerms", { list: w.words.join(", ") }) : ""}`;
}

/** The inbox id of one occurrence of a routine: the bridge's key for its answer, which the door tells apart (isRoutineKey). */
export const routineMessageId = (id: string, occ: number): string => `routine-${id}-${occ}`;
export const isRoutineKey = (key: string): boolean => /^routine-[0-9a-f]{10}-\d{1,16}$/.test(key);

export function createRoutines(d: RoutinesDeps) {
  const now = d.now ?? Date.now;
  const lang = d.lang ?? ((): Lang => "en");
  const claimMs = d.claimMs ?? 1500;
  const token = randomBytes(8).toString("hex");
  let local: Book = { routines: [], watches: [], seen: {} };

  const readStrict = async (): Promise<Book> => {
    if (!d.kv) return structuredClone(local);
    const raw = await d.kv.get(ROUTINES_KEY);
    if (!raw) return { routines: [], watches: [], seen: {} };
    try {
      return clean(JSON.parse(raw));
    } catch {
      log.error("the stored routines are not valid JSON: starting again");
      return { routines: [], watches: [], seen: {} };
    }
  };
  const write = async (b: Book): Promise<void> => {
    if (d.kv) await d.kv.set(ROUTINES_KEY, JSON.stringify(b), TTL_SECONDS);
    local = structuredClone(b);
  };
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <R>(fn: () => Promise<R>): Promise<R> => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
  /** A change on the record as it is in the store now (another copy of the server may have changed it), written back when it changed. */
  const change = <R>(fn: (b: Book) => { out: R; changed: boolean }): Promise<R> =>
    locked(async () => {
      const b = await readStrict();
      const { out, changed } = fn(b);
      if (changed) await write(b);
      return out;
    });
  const nextNumber = (list: { n: number }[]): number => Math.max(0, ...list.map((x) => x.n)) + 1;

  /**
   * One occurrence or hit for this process alone, at most once in all: nobody claimed it yet, this copy writes its own mark, waits, and reads
   * the mark back (two copies that both wrote see the same last writer). A store that cannot be read means no claim: better a run missed than
   * two. Without a store (only the tests) it is always this process's.
   */
  const claim = async (name: string): Promise<boolean> => {
    if (!d.kv) return true;
    try {
      if (await d.kv.get(runKey(name))) return false;
      await d.kv.set(runKey(name), token, CLAIM_TTL_S);
      await new Promise((r) => setTimeout(r, claimMs));
      return (await d.kv.get(runKey(name))) === token;
    } catch (err) {
      log.error(`could not claim ${name.slice(0, 40)}: ${(err as Error).message}`);
      return false;
    }
  };
  const pausedNow = async (): Promise<boolean> => {
    if (!d.control) return false;
    try {
      return (await d.control.state()).paused !== null;
    } catch {
      return true; // a pause nobody can read is a pause (src/control.ts fails closed too)
    }
  };

  // ---------- making them (the assistant's tags), removing them (commands, the panel, Undo) ----------

  /**
   * When a routine comes round, from its first time ("2026-11-16 09:00"): the hour for a daily one, plus the weekday for a weekly one, the day of
   * the month for a monthly one, the month and day for a yearly one. Two with the same words are the same routine only on the same slot.
   */
  const slot = (every: Every, anchor: string): string => {
    if (every === "week") return `${new Date(`${anchor.slice(0, 10)}T00:00:00Z`).getUTCDay()} ${anchor.slice(11)}`;
    if (every === "month") return anchor.slice(8);
    if (every === "year") return anchor.slice(5);
    return anchor.slice(11);
  };

  /** A routine from a <routine> tag: `added` when it was made, `say` (to the owner) when not. The same one twice is made once. */
  const addRoutine = (r: { at: string; every: string; text: string }): Promise<{ added?: SavedRoutine; say?: string }> => {
    const t = T(lang());
    const text = line(r.text, TEXT_MAX);
    const q = cutQ(lang(), text);
    if (text.length < 3) return Promise.resolve({ say: t("empty") });
    if (!isEvery(r.every)) return Promise.resolve({ say: t("badEvery", { q }) });
    const every = r.every;
    const given = localToEpoch(r.at, d.timeZone);
    if (given === null) return Promise.resolve({ say: t("badTime", { q, when: line(r.at, 20) }) });
    const first = firstRepeat(given, every, d.timeZone);
    const at = now();
    if (first < at + 30_000) return Promise.resolve({ say: t("past", { q }) });
    if (first > at + 366 * DAY_MS) return Promise.resolve({ say: t("tooFar", { q }) });
    return change<{ added?: SavedRoutine; say?: string }>((b) => {
      const anchor = localStamp(first, d.timeZone);
      if (b.routines.some((x) => x.every === every && slot(every, x.anchor) === slot(every, anchor) && fold(x.text) === fold(text))) {
        return { out: {}, changed: false };
      }
      if (b.routines.length >= ROUTINES_MAX) return { out: { say: t("routinesFull", { n: ROUTINES_MAX }) }, changed: false };
      const made: Routine = { id: randomBytes(5).toString("hex"), n: nextNumber(b.routines), text, every, anchor, next: first, at };
      b.routines.push(made);
      d.control?.log("routine", t("logRoutine", { q, every: repeatText(every, lang()) }));
      return { out: { added: { id: made.id, text, every, next: first } }, changed: true };
    });
  };

  /** A watch from a <watch> tag. Its source must be connected now, and it needs words to match: a watch on everything is a flood. */
  const addWatch = (w: { on: string; from?: unknown; words?: unknown; once?: boolean; text: string }): Promise<{ added?: SavedWatch; say?: string }> => {
    const t = T(lang());
    const text = line(w.text, TEXT_MAX);
    const q = cutQ(lang(), text || "?");
    if (!isWatchSource(w.on)) return Promise.resolve({ say: t("noTerms", { q }) });
    const on = w.on;
    const sources = d.sources?.() ?? {};
    if (!sources[on]) return Promise.resolve({ say: t("noSource", { source: t(on === "mail" ? "srcMail" : on === "calendar" ? "srcCalendar" : "srcSlack") }) });
    // The calendar has no sender: only its titles' words count there.
    const from = on === "calendar" ? [] : terms(w.from);
    const words = terms(w.words);
    if (text.length < 3 || (!from.length && !words.length)) return Promise.resolve({ say: t("noTerms", { q }) });
    const once = w.once !== false;
    return change<{ added?: SavedWatch; say?: string }>((b) => {
      const same = (x: Watch): boolean => x.on === on && x.from.join() === from.join() && x.words.join() === words.join() && x.once === once;
      if (b.watches.some(same)) return { out: {}, changed: false };
      if (b.watches.length >= WATCHES_MAX) return { out: { say: t("watchesFull", { n: WATCHES_MAX }) }, changed: false };
      const made: Watch = { id: randomBytes(5).toString("hex"), n: nextNumber(b.watches), text, on, from, words, once, at: now(), hits: 0 };
      b.watches.push(made);
      d.control?.log("watch", t("logWatch", { q }));
      return { out: { added: { id: made.id, text, on, once } }, changed: true };
    });
  };

  /** Removes one by id (Undo, the panel): what was removed, or null when it is not there any more. */
  const removeById = (kind: "routine" | "watch", id: string): Promise<{ text: string } | null> =>
    change((b) => {
      const list: { id: string; text: string }[] = kind === "routine" ? b.routines : b.watches;
      const i = list.findIndex((x) => x.id === id);
      if (i < 0) return { out: null, changed: false };
      const [gone] = list.splice(i, 1);
      return { out: { text: gone!.text }, changed: true };
    });

  /** DELETE / PAUSE / RESUME ROUTINE n (WATCH n): the owner's answer. Answered while paused too: it changes only what Pako keeps. */
  const command = async (kind: "routine" | "watch", op: "delete" | "pause" | "resume", n: number): Promise<string> => {
    const l = lang();
    const t = T(l);
    const k = t(kind === "routine" ? "kindRoutine" : "kindWatch");
    try {
      const hit = await change((b) => {
        const list: (Routine | Watch)[] = kind === "routine" ? b.routines : b.watches;
        const x = list.find((y) => y.n === n);
        if (!x) return { out: null, changed: false };
        if (op === "delete") list.splice(list.indexOf(x), 1);
        else if (op === "pause") x.paused = true;
        else {
          delete x.paused;
          // A routine started again goes on from its next time after now (the ones it missed while paused stay missed).
          if (kind === "routine") {
            const r = x as Routine;
            if (r.next <= now()) r.next = repeatAfter(r.next, r.every, r.anchor, d.timeZone, now()) ?? r.next;
          }
        }
        return { out: { text: x.text }, changed: true };
      });
      if (!hit) return t("notFound", { kind: k, n, list: t(kind === "routine" ? "listRoutines" : "listWatches") });
      const q = cutQ(l, hit.text);
      if (op === "delete") {
        d.control?.log(kind === "routine" ? "rutina" : "vigilancia", t("logRemoved", { kind: k, q }));
        return t("deleted", { kind: k, q });
      }
      return op === "pause" ? t("pausedNow", { kind: k, q, n, word: t(kind === "routine" ? "wordRoutine" : "wordWatch") }) : t("resumedNow", { kind: k, q });
    } catch (err) {
      log.error(`could not change one: ${(err as Error).message}`);
      return t("unsaved");
    }
  };

  // ---------- what the owner and the assistant read ----------

  const read = async (): Promise<Book> => {
    try {
      const b = await readStrict();
      local = structuredClone(b);
      return b;
    } catch (err) {
      log.error(`read failed: ${(err as Error).message}`);
      return structuredClone(local);
    }
  };
  const routinesText = async (): Promise<string> => {
    const l = lang();
    const t = T(l);
    let b: Book;
    try {
      b = await readStrict();
    } catch {
      return t("unread");
    }
    if (!b.routines.length) return t("routinesNone");
    const lines = [...b.routines].sort((a, c) => a.n - c.n).map((r) =>
      t("routineLine", { n: r.n, every: repeatText(r.every, l), when: whenText(r.next, d.timeZone, l), q: cutQ(l, r.text), paused: r.paused ? t("paused") : "" }));
    return [t("routinesHead"), ...lines, "", t("routinesFoot")].join("\n");
  };
  const watchesText = async (): Promise<string> => {
    const l = lang();
    const t = T(l);
    let b: Book;
    try {
      b = await readStrict();
    } catch {
      return t("unread");
    }
    if (!b.watches.length) return t("watchesNone");
    const lines = [...b.watches].sort((a, c) => a.n - c.n).map((w) =>
      t("watchLine", { n: w.n, what: watchWhat(w, l), q: cutQ(l, w.text), once: w.once ? t("once") : "", paused: w.paused ? t("paused") : "" }));
    return [t("watchesHead"), ...lines, "", t("watchesFoot")].join("\n");
  };
  /** For the assistant's context: one line each (the owner's own words, nobody else's). Null when the store cannot be read. */
  const contextLines = async (): Promise<{ routines: string[]; watches: string[] } | null> => {
    const l = lang();
    const t = T(l);
    try {
      const b = await readStrict();
      return {
        routines: b.routines.map((r) =>
          t("ctxRoutine", { n: r.n, every: repeatText(r.every, l), when: localStamp(r.next, d.timeZone), text: r.text, paused: r.paused ? t("paused") : "" })),
        watches: b.watches.map((w) => t("ctxWatch", { n: w.n, what: watchWhat(w, l), text: w.text, once: w.once ? t("once") : "", paused: w.paused ? t("paused") : "" })),
      };
    } catch {
      return null;
    }
  };

  // ---------- the clock: routines due, and the watches' look at what came ----------

  const runRoutines = async (stopped: boolean): Promise<void> => {
    const l = lang();
    const t = T(l);
    const due = (await readStrict()).routines.filter((r) => r.next <= now());
    /** The ones skipped because the computer slept: told in one message at the end of this look. */
    const slept: { q: string; at: number }[] = [];
    for (const r of due) {
      const occ = r.next;
      const at = now();
      // Claimed before its time moves on: a copy that restarts in between finds the claim and does not run it again.
      const own = r.paused ? false : await claim(`${r.id}:${occ}`);
      // The claim decides who runs it; the record only moves on (a copy that lost the claim may be the one that moves it first).
      const there = await change((b) => {
        const x = b.routines.find((y) => y.id === r.id);
        if (!x) return { out: false, changed: false }; // removed meanwhile: not run
        if (x.next !== occ) return { out: true, changed: false };
        const next = repeatAfter(occ, x.every, x.anchor, d.timeZone, at);
        if (next === null) b.routines.splice(b.routines.indexOf(x), 1);
        else x.next = next;
        return { out: true, changed: true };
      });
      if (!own || !there) continue;
      const q = cutQ(l, r.text);
      const asleep = !stopped && at - occ > GRACE_MS && !!d.jobs?.slept(occ);
      if (stopped || asleep || at - occ > LATE_MS) {
        d.control?.log("routine", t("logSkip", { q, why: t(stopped ? "whyPaused" : asleep ? "whySlept" : "whyLate") }));
        if (asleep) slept.push({ q, at: occ });
        continue;
      }
      const text = t("run", { every: repeatText(r.every, l), text: r.text });
      if (await d.enqueue({ id: routineMessageId(r.id, occ), at, text, routine: { id: r.id, text: r.text } })) d.control?.log("routine", t("logRun", { q }));
    }
    // Said once: each routine's slot was claimed above, so a restart neither runs it nor tells it again.
    if (slept.length === 1) await d.notify(t("sleptOne", { q: slept[0]!.q, when: whenText(slept[0]!.at, d.timeZone, l) }));
    else if (slept.length > 1) await d.notify(t("sleptMany", { list: slept.map((x) => `• ${x.q} (${whenText(x.at, d.timeZone, l)})`).join("\n") }));
  };

  /** One hit's message, cut to a few lines. */
  const hitMessage = (w: Watch, lines: string[]): string => {
    const t = T(lang());
    const shown = lines.slice(0, 5);
    return [t("hitHead", { q: cutQ(lang(), w.text) }), ...shown, ...(lines.length > shown.length ? [t("hitMore", { n: lines.length - shown.length })] : []),
      ...(w.once ? [t("hitOnce")] : [])].join("\n");
  };
  const short = (s: string, max: number): string => inline(s, max);
  const when = (e: { start: number; allDay?: boolean }): string => whenText(e.start, d.timeZone, lang());
  const hash = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

  const lookWatches = async (stopped: boolean): Promise<void> => {
    const sources = d.sources?.() ?? {};
    const t = T(lang());
    const b0 = await readStrict();
    // Nothing watched and nothing to forget: no source is read and the store is not written (this runs every half minute).
    if (!b0.watches.length && !b0.seen.mail && !b0.seen.slack) return;
    const live = (on: WatchSource): Watch[] => b0.watches.filter((w) => w.on === on);
    // What each source has now; a source that cannot be read is looked at next time (nothing is marked seen, no event is taken as gone).
    const got = async <X>(on: WatchSource, fn: (() => Promise<X[]>) | undefined): Promise<X[] | null> =>
      fn && live(on).length ? await fn().catch((err: Error) => (log.error(`${on} could not be read: ${err.message}`), null)) : null;
    const mail = await got("mail", sources.mail);
    const slack = await got("slack", sources.slack);
    const events = await got("calendar", sources.calendar);
    const at = now();
    const mailKey = (m: MailSeen): string => m.id.slice(0, 300);
    const slackKey = (a: SlackSeen): string => hash(`${a.at}|${a.where}|${a.text}`);
    // New since the last look; on the very first look, only what came after the oldest of these watches was made.
    const fresh = <X>(list: X[] | null, seen: string[] | undefined, key: (x: X) => string, at0: (x: X) => number, on: WatchSource): X[] => {
      if (!list) return [];
      if (!seen) {
        const since = Math.min(...live(on).map((w) => w.at));
        return list.filter((x) => at0(x) >= since);
      }
      const s = new Set(seen);
      return list.filter((x) => !s.has(key(x)));
    };
    const newMail = fresh(mail, b0.seen.mail, mailKey, (m) => m.at, "mail");
    const newSlack = fresh(slack, b0.seen.slack, slackKey, (a) => a.at, "slack");
    const told: { w: Watch; lines: string[]; keys: string[] }[] = [];
    const calNext = new Map<string, CalSeen>();
    for (const w of b0.watches) {
      let lines: string[] = [];
      let keys: string[] = [];
      if (w.on === "mail") {
        const hits = newMail.filter((m) => mailHit(w, m));
        lines = hits.map((m) => t("hitMail", { from: short(m.from, 120), subject: m.subject ? t("hitSubject", { s: short(m.subject, 160) }) : "" }));
        keys = hits.map(mailKey);
      } else if (w.on === "slack") {
        const hits = newSlack.filter((a) => slackHit(w, a));
        lines = hits.map((a) => t("hitSlack", { where: short(a.where, 80), text: short(a.text, 200) }));
        keys = hits.map(slackKey);
      } else if (events) {
        // The coming events with its words; the first look only notes them. A change of time or place, a new one, or one gone for two looks
        // in a row (a calendar read in part must not read as a cancellation) within the next five days is a hit.
        const prev = w.cal;
        const seen: CalSeen = {};
        const sig = (e: EventSeen): string => `${e.start}|${e.end}|${e.allDay ? 1 : 0}|${e.location ?? ""}|${e.title}`;
        for (const e of events.filter((x) => x.end > at && eventHit(w, x)).slice(0, 20)) {
          seen[e.id] = { sig: sig(e), title: e.title, start: e.start };
          if (!prev) continue;
          const before = prev[e.id];
          const title = short(e.title, 120) + (e.location ? ` (${short(e.location, 80)})` : "");
          if (!before) lines.push(t("hitAdded", { title, when: when(e) }));
          else if (before.sig !== sig(e)) lines.push(t("hitChanged", { title, when: when(e), was: when(before) }));
          else continue;
          keys.push(hash(`${e.id}|${sig(e)}`));
        }
        for (const [id, x] of Object.entries(prev ?? {})) {
          if (seen[id] || x.start <= at || x.start > at + 5 * DAY_MS) continue;
          const miss = (x.miss ?? 0) + 1;
          if (miss < 2) seen[id] = { ...x, miss };
          else {
            lines.push(t("hitRemoved", { title: short(x.title, 120), when: when(x) }));
            keys.push(hash(`${id}|gone|${x.sig}`));
          }
        }
        calNext.set(w.id, seen);
      }
      // Paused (the owner's, or STOP): what came is looked at and let go, so nothing pours out afterwards.
      if (!lines.length || w.paused || stopped) continue;
      if (!w.once && w.lastHit && at - w.lastHit < DAY_MS && w.hits >= HITS_PER_DAY) continue;
      told.push({ w, lines, keys });
    }
    // Sent before the record is written: a hit is claimed in the store, so a restart in between cannot send it twice.
    const sent = new Set<string>();
    for (const x of told) {
      if (!(await claim(`w:${x.w.id}:${hash(x.keys.join("|"))}`))) continue;
      await d.notify(hitMessage(x.w, x.lines));
      d.control?.log("watch", t("logHit", { q: cutQ(lang(), x.w.text) }));
      sent.add(x.w.id);
    }
    await change((b) => {
      const before = JSON.stringify(b);
      if (mail) b.seen.mail = [...(b.seen.mail ?? []), ...mail.map(mailKey).filter((k) => !(b.seen.mail ?? []).includes(k))].slice(-SEEN_MAX);
      if (slack) b.seen.slack = [...(b.seen.slack ?? []), ...slack.map(slackKey).filter((k) => !(b.seen.slack ?? []).includes(k))].slice(-SEEN_MAX);
      // A source nobody watches any more forgets what it saw: a new watch starts from its own creation, not from an old list.
      for (const on of ["mail", "slack"] as const) if (!b.watches.some((w) => w.on === on)) delete b.seen[on];
      for (const w of b.watches) {
        const cal = calNext.get(w.id);
        if (cal) w.cal = cal;
        if (!sent.has(w.id)) continue;
        w.hits = w.lastHit && at - w.lastHit < DAY_MS ? w.hits + 1 : 1;
        w.lastHit = at;
      }
      b.watches = b.watches.filter((w) => !(sent.has(w.id) && w.once));
      // Written only when something changed: an idle look every half minute is no write to the store.
      return { out: undefined, changed: JSON.stringify(b) !== before };
    });
  };

  let ticking = false;
  /** Every half minute (src/whatsapp.ts): the routines that are due, then the watches. Never throws; one at a time. */
  const tick = async (): Promise<void> => {
    if (ticking) return;
    ticking = true;
    try {
      const stopped = await pausedNow();
      await runRoutines(stopped).catch((err: Error) => log.error(`could not run the routines: ${err.message}`));
      await lookWatches(stopped).catch((err: Error) => log.error(`could not look at the watches: ${err.message}`));
    } finally {
      ticking = false;
    }
  };

  return { read, addRoutine, addWatch, removeById, command, routinesText, watchesText, contextLines, tick };
}

export type Routines = ReturnType<typeof createRoutines>;

// ---------- the panel: GET /panel/api/routines; on a computer, POST /panel/api/routines/remove ----------

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" };

export function mountRoutinesPanel(app: Express, d: { signedIn: (req: Request) => boolean; routines: Routines; local: boolean; timeZone: string }): void {
  const limiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false });
  // The same protection as the STOP switch: the strict session cookie, and on a change the x-pako header another site cannot send.
  const auth = (change: boolean): RequestHandler => (req, res, next) => {
    res.set(HEADERS);
    if (change && !d.local) {
      res.status(404).json({ error: "read only here" });
      return;
    }
    if (!d.signedIn(req) || (change && req.get("x-pako") !== "1")) {
      res.status(401).json({ error: "sign in" });
      return;
    }
    next();
  };
  app.get("/panel/api/routines", auth(false), async (_req, res) => {
    const b = await d.routines.read();
    res.json({
      routines: b.routines.map((r) => ({ id: r.id, n: r.n, text: r.text, every: r.every, next: r.next, paused: r.paused === true })),
      watches: b.watches.map((w) => ({ id: w.id, n: w.n, text: w.text, on: w.on, from: w.from, words: w.words, once: w.once, paused: w.paused === true })),
      timeZone: d.timeZone,
      edit: d.local,
    });
  });
  app.post("/panel/api/routines/remove", auth(true), limiter, express.json({ limit: "1kb" }), async (req, res) => {
    const b = req.body as { kind?: unknown; id?: unknown } | undefined;
    const kind = b?.kind === "routine" || b?.kind === "watch" ? b.kind : null;
    if (!kind || typeof b?.id !== "string" || !HEX10.test(b.id)) {
      res.status(400).json({ error: "send { kind: \"routine\" | \"watch\", id }" });
      return;
    }
    try {
      const gone = await d.routines.removeById(kind, b.id);
      res.status(gone ? 200 : 404).json({ ok: !!gone });
    } catch (err) {
      log.error(`the panel's change was not kept: ${(err as Error).message}`);
      res.status(503).json({ error: "not kept" });
    }
  });
}
