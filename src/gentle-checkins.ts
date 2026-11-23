// Opt-in check-ins: "check on me at 10:30", "ping me in 20 min if I haven't started the deck" (the chat's <checkin> tag, or the check_in
// tool), or the "Check on me in 30 min" button gentle mode puts on a stuck follow-up's nudge and on its Snooze card. At that time Pako asks
// "Started on the deck?" with Yes (closes it), Not yet (another look in 15 minutes, three times at most, then it stops and the brief carries
// it) and Park (a follow-up's goes to the Parked list).
//
// Available to everyone, gentle mode or not. The rules, the same for all:
// - Quiet hours: a check-in that falls in them is moved to their end when that is within two hours of the time asked; otherwise it is kept
//   for the brief instead.
// - Never during a meeting on the calendar: moved to just after it (back-to-back meetings too), within the same two hours.
// - Each ask is a durable slot (src/jobs.ts, "checkin:<id>@<time>"): a restart neither loses one nor sends one twice.
// - No catch-up storm after a sleep: one more than two hours past its time is not sent (the brief says it, quietly), and of several that came
//   due while the computer slept only the newest goes; the others go to the brief too.
// - The day's cap: the lower of gentle mode's nudge cap and the standard one, shared with the follow-ups' nudges and Pako's own suggestions.
//   Only a check-in's first ask counts; the looks after a "Not yet" are part of the same one. One asked for in the chat at a time (no
//   follow-up behind it) is asked whatever the cap says, and still counts.
// - One asked and never answered goes to the brief after two hours, and only the ones still to be asked count towards the ten waiting.

import { randomBytes } from "node:crypto";
import { cap, takeOf, type Take } from "./app/budget.ts";
import type { CalEvent } from "./calendar.ts";
import { zonedTime } from "./followups/time.ts";
import { quietAt, type GentleConfig } from "./gentle.ts";
import { ownerClock, texts } from "./i18n.ts";
import type { Jobs } from "./jobs.ts";
import type { Kv } from "./kv.ts";
import { today } from "./lists.ts";
import { inline } from "./quarantine.ts";
import { createLog } from "./log.ts";
import { readJsonRecord } from "./json-record.ts";

const log = createLog("gentle");

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const CHECKINS_KEY = "gentle-checkins";
/** The answer buttons: ci1 Yes, ci2 Not yet, ci3 Park. */
export const CHECKIN_BUTTON = /^ci([123]):([0-9a-f]{10})$/;
/** "Check on me in 30 min" on a follow-up's nudge or its Snooze card: ck:<loop id>. */
export const CHECKIN_LOOP_BUTTON = /^ck:([0-9a-f]{10})$/;
/** "Not yet" brings another look this many times at most; the next "Not yet" stops it and the brief carries it. */
export const CHECKIN_TRIES = 3;
/** A check-in more than this past the time it was asked for is never sent: it goes to the brief. */
export const CHECKIN_STALE_MS = 2 * HOUR;
/** Later than this (a sleep, a restart), it is a late one: of several, only the newest goes. */
const LATE_MS = 5 * MIN;
/** Waiting at most this many; asked this far ahead at most. */
export const CHECKINS_MAX = 10;
const AHEAD_MAX_MS = 7 * DAY;
/** An answered or ended one is kept this long (its press still finds it; the brief reads the last day). */
const KEEP_MS = 2 * DAY;

/** Check-ins' words (English, like all of Pako's own): exported whole so the no-shame test reads every one. */
export const CHECKIN_WORDS = {
  ask: "🌱 Started on “{thing}”?",
  ask2: "🌱 Checking in, as you asked: started on “{thing}”?",
  ask3: "🌱 A quick look, as promised: started on “{thing}”?",
  askNone: "🌱 Checking in, as you asked: started?",
  btnYes: "Yes",
  btnNotYet: "Not yet",
  btnPark: "Park",
  btnLoop: "Check on me in {min} min",
  btnLoopShort: "Check in {min} min",
  loopLine: "Starting now? Say “check on me in {min} min” and I'll look in.",
  yes: "Good. I'll leave you to it.",
  notYet: "OK. I'll look in at {time}.",
  stopped: "OK, no more check-ins for “{thing}”. It'll be in your brief, so it stays in view without pings.",
  parked: "Parked: “{thing}”. No more check-ins for it.",
  set: "OK. I'll check on you at {time}{about}.",
  about: " (“{thing}”)",
  past: "That time has already passed. Tell me another one?",
  far: "I keep check-ins for the next 7 days. A nearer time?",
  full: "You have {n} check-ins waiting already. One can go once it's answered.",
  noLoop: "I don't see that one open any more, so there's nothing to check on.",
  gone: "That check-in is no longer waiting.",
  unread: "I couldn't read your check-ins just now, so nothing changed. Could you try once more in a moment?",
  answered: "Already answered.",
  briefLine: "🌱 Check-ins kept for here: {list}",
  briefItem: "“{thing}” ({time})",
  briefNone: "what you were on",
  logSet: "Check-in set for {time}: {thing}",
  logAsked: "Check-in asked: {thing}",
  logBrief: "Check-in kept for the brief: {thing}",
};
export const CT = texts(CHECKIN_WORDS);

export type CheckInState = "waiting" | "asked" | "done" | "parked" | "brief";

export interface CheckIn {
  id: string;
  /** What it is about, in the owner's words ("" when they named nothing). */
  thing: string;
  /** The follow-up it came from (the nudge's button): Park parks that follow-up. */
  loop?: string;
  /** The time asked for (the first one, or "Not yet" + 15 min): the two hours run from it. */
  due: number;
  /** When it is looked at next (the time asked for, or moved past quiet hours or a meeting). */
  at: number;
  /** "Not yet" presses so far. */
  tries: number;
  state: CheckInState;
  createdAt: number;
  /** When it ended (answered, parked, or kept for the brief). */
  endedAt?: number;
  /** Its first ask went (counted once in the day's cap). */
  counted?: boolean;
  /** Its last ask went at. */
  askedAt?: number;
}

interface State {
  list: CheckIn[];
  /** The day's first asks, for the shared cap. */
  day: string;
  n: number;
}
const empty = (): State => ({ list: [], day: "", n: 0 });
const STATES: readonly CheckInState[] = ["waiting", "asked", "done", "parked", "brief"];
const stateOf = (v: unknown): State => {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const num = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
  const list = (Array.isArray(o.list) ? o.list : []).flatMap((x): CheckIn[] => {
    const c = x && typeof x === "object" ? (x as Record<string, unknown>) : null;
    if (!c || typeof c.id !== "string" || !/^[0-9a-f]{10}$/.test(c.id) || num(c.due) === undefined || num(c.at) === undefined) return [];
    const state = STATES.includes(c.state as CheckInState) ? (c.state as CheckInState) : "waiting";
    return [{
      id: c.id, thing: typeof c.thing === "string" ? c.thing.slice(0, 120) : "", due: num(c.due)!, at: num(c.at)!,
      tries: Math.min(CHECKIN_TRIES, Math.max(0, num(c.tries) ?? 0)), state, createdAt: num(c.createdAt) ?? num(c.due)!,
      ...(typeof c.loop === "string" && /^[0-9a-f]{10}$/.test(c.loop) ? { loop: c.loop } : {}),
      ...(num(c.endedAt) !== undefined ? { endedAt: num(c.endedAt)! } : {}),
      ...(c.counted === true ? { counted: true } : {}),
      ...(num(c.askedAt) !== undefined ? { askedAt: num(c.askedAt)! } : {}),
    }];
  });
  return { list: list.slice(-50), day: typeof o.day === "string" ? o.day.slice(0, 10) : "", n: num(o.n) ?? 0 };
};

/** The end of the meeting (or run of back-to-back meetings) going on at `t`, or null: never all-day, declined, or one only invited by mail. */
export function busyUntil(events: readonly CalEvent[], t: number): number | null {
  const real = events.filter((e) => !e.allDay && e.response !== "declined" && !e.invited && e.end > e.start);
  let x = t;
  let moved = true;
  let found = false;
  for (let guard = 0; moved && guard < 20; guard++) {
    moved = false;
    for (const e of real) {
      if (e.start <= x && e.end > x) {
        x = e.end;
        moved = true;
        found = true;
      }
    }
  }
  return found ? x : null;
}

/** When the quiet hours that hold `t` end (the next minute out of them), in the owner's zone. */
export function quietEnd(q: { start: number; end: number }, t: number, tz: string): number {
  let x = Math.floor(t / MIN) * MIN;
  // By the hour first, then back by the minute to the first one out: a clock change (DST) in the quiet hours is followed as it is.
  for (let i = 0; i < 26 && quietAt(q, x, tz); i++) x += HOUR;
  for (let i = 0; i < 60 && x - MIN > t && !quietAt(q, x - MIN, tz); i++) x -= MIN;
  return x;
}

/** The time a request names: "YYYY-MM-DD HH:MM" in the owner's zone, or minutes from now. Null when neither reads. */
export function checkinTime(o: { at?: string; inMin?: number }, now: number, tz: string): number | null {
  if (typeof o.inMin === "number" && Number.isFinite(o.inMin) && o.inMin >= 1 && o.inMin <= 7 * 24 * 60) return now + Math.round(o.inMin) * MIN;
  if (typeof o.at === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(o.at.trim())) return zonedTime(o.at.trim(), tz);
  return null;
}

/** What a check-in is about, as a thing: "start the deck" and "getting going on the deck" are "the deck" ("Started on “the deck”?"). */
export const thingOf = (s: string): string =>
  inline(s, 120).replace(/^(?:to\s+)?(?:start(?:ed|ing)?|begin(?:ning)?|get(?:ting)?\s+(?:going|started))(?:\s+(?:on|with))?\s+(?=\S)/i, "");

/** The check-ins the bridge sent with an answer (<checkin>, check_in), checked field by field: at most two. */
export function checkinItemsOf(v: unknown): { at?: string; inMin?: number; thing: string }[] {
  const out: { at?: string; inMin?: number; thing: string }[] = [];
  for (const x of Array.isArray(v) ? v : []) {
    if (out.length >= 2) break;
    const o = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
    const thing = typeof o.text === "string" ? inline(o.text, 120) : "";
    const at = typeof o.at === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(o.at.trim()) ? o.at.trim() : undefined;
    const inMin = typeof o.in === "number" && Number.isInteger(o.in) && o.in >= 1 && o.in <= 7 * 24 * 60 ? o.in : undefined;
    if (at === undefined && inMin === undefined) continue;
    out.push({ thing, ...(inMin !== undefined ? { inMin } : { at: at! }) });
  }
  return out;
}

export interface CheckInsDeps {
  kv: Kv | null;
  timeZone: string;
  now?: () => number;
  /** The settings as they apply now (gentle on or off): the minutes of the button and of "Not yet", and the cap. */
  settings: () => Promise<GentleConfig>;
  /** The standard day's cap (the follow-ups' FOLLOWUP_MAX_PER_DAY) when gentle mode is off. */
  standardMax: number;
  /** Follow-up nudges and Pako's own suggestions sent today: the cap is shared. */
  others?: () => Promise<number>;
  /** This part's turn at the day's cap (src/app/budget.ts): the check against the others and the count are one turn. Absent: `others`. */
  take?: Take;
  quiet: { start: number; end: number } | null;
  /** The calendar (never during a meeting); absent or failing: no meeting is known. */
  events?: () => Promise<CalEvent[]>;
  /** Each ask is a durable slot (src/jobs.ts); without it (the tests' plain runs) it just goes. */
  jobs?: Pick<Jobs, "slot">;
  card: (body: string, buttons: { id: string; title: string }[]) => Promise<boolean>;
  /** A follow-up's title by its id while it is open (the nudge's button), and its Park (src/followups/owner.ts press "7"). */
  loop?: (id: string) => Promise<{ title: string } | null>;
  parkLoop?: (id: string) => Promise<string>;
  /** The owner engaged with a follow-up (its "Check on me" pressed): an answer, so its unanswered nudges start again (src/followups/owner.ts). */
  engaged?: (id: string) => Promise<unknown>;
  log?: (text: string) => void;
}

export function createCheckIns(d: CheckInsDeps) {
  const now = d.now ?? Date.now;
  const take = takeOf(d.take, d.others);
  let memory = empty();
  // A store that does not answer throws (src/json-record.ts): an empty list in its place would be saved over every check-in waiting. What
  // changes the list then changes nothing (and says so); what only reads it (the brief's line, the day's count) gets nothing.
  const load = async (): Promise<State> => (d.kv ? stateOf((await readJsonRecord(d.kv, CHECKINS_KEY)) ?? {}) : structuredClone(memory));
  const peek = (): Promise<State> => load().catch((err: Error) => {
    log.warn(`the check-ins could not be read: ${err.message}`);
    return empty();
  });
  const unread = (err: unknown): string => {
    log.warn(`the check-ins could not be read, nothing changed: ${(err as Error).message}`);
    return CT()("unread");
  };
  const save = async (s: State): Promise<void> => {
    const t = now();
    s.list = s.list.filter((c) => c.state === "waiting" || c.state === "asked" ? t - c.at < KEEP_MS + AHEAD_MAX_MS : t - (c.endedAt ?? c.at) < KEEP_MS).slice(-50);
    memory = s;
    if (d.kv) await d.kv.set(CHECKINS_KEY, JSON.stringify(s), 10 * 24 * 3600);
  };
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <R>(fn: () => Promise<R>): Promise<R> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const clock = (t: number): string => {
    const time = ownerClock(t, d.timeZone);
    return today(t, d.timeZone) === today(now(), d.timeZone) ? time : `${new Intl.DateTimeFormat("en-GB", { timeZone: d.timeZone, weekday: "short" }).format(t)} ${time}`;
  };
  const toBrief = (c: CheckIn, t: number): void => {
    Object.assign(c, { state: "brief", endedAt: t });
    d.log?.(CT()("logBrief", { thing: c.thing || CT()("briefNone") }));
  };

  /** A new check-in at `when` (ms): what to tell the owner, and whether it was kept. */
  const add = (o: { when: number; thing: string; loop?: string }): Promise<{ ok: boolean; say: string; id?: string }> => serial(async () => {
    const t = now();
    if (o.when < t + 30_000) return { ok: false, say: CT()("past") };
    if (o.when - t > AHEAD_MAX_MS) return { ok: false, say: CT()("far") };
    let s: State;
    try {
      s = await load();
    } catch (err) {
      return { ok: false, say: unread(err) };
    }
    // Only the ones still to be asked: one asked and never answered is the brief's after two hours (sweep), and holds no place meanwhile.
    const waiting = s.list.filter((c) => c.state === "waiting");
    if (waiting.length >= CHECKINS_MAX) return { ok: false, say: CT()("full", { n: waiting.length }) };
    const thing = thingOf(o.thing);
    // One per follow-up: asked again from its nudge, the waiting one just moves.
    const same = o.loop ? s.list.find((c) => c.loop === o.loop && c.state === "waiting") : undefined;
    const c: CheckIn = same ?? { id: randomBytes(5).toString("hex"), thing, due: o.when, at: o.when, tries: 0, state: "waiting", createdAt: t, ...(o.loop ? { loop: o.loop } : {}) };
    Object.assign(c, { due: o.when, at: o.when });
    if (!same) s.list.push(c);
    await save(s);
    d.log?.(CT()("logSet", { time: clock(o.when), thing: thing || CT()("briefNone") }));
    return { ok: true, id: c.id, say: CT()("set", { time: clock(o.when), about: thing ? CT()("about", { thing }) : "" }) };
  });

  /** From the chat: "YYYY-MM-DD HH:MM" or minutes from now. */
  const fromChat = async (o: { at?: string; inMin?: number; thing: string }): Promise<{ ok: boolean; say: string }> => {
    const when = checkinTime(o, now(), d.timeZone);
    if (when === null) return { ok: false, say: CT()("past") };
    return add({ when, thing: o.thing });
  };

  /** "Check on me in 30 min" pressed on a follow-up's nudge or its Snooze card. */
  const forLoop = async (loopId: string): Promise<string> => {
    const l = d.loop ? await d.loop(loopId).catch(() => null) : null;
    if (!l) return CT()("noLoop");
    const g = await d.settings();
    const r = await add({ when: now() + g.checkinMin * MIN, thing: l.title, loop: loopId });
    // The press is the owner's answer to the nudge, as Done, Snooze or Park are: no fold into the brief for nudges they did answer.
    if (r.ok && d.engaged) await d.engaged(loopId).catch((err: Error) => log.warn(`a check-in's answer could not be kept on its follow-up: ${err.message}`));
    return r.say;
  };

  /** The button for a follow-up's card ("Check on me in 30 min", or the short one where a title has 20 characters). */
  const loopButton = async (loopId: string, short = false): Promise<{ id: string; title: string }> => {
    const g = await d.settings();
    return { id: `ck:${loopId}`, title: CT()(short ? "btnLoopShort" : "btnLoop", { min: g.checkinMin }) };
  };

  const askText = (c: CheckIn): string => {
    if (!c.thing) return CT()("askNone");
    return CT()(c.tries === 0 ? "ask" : c.tries === 1 ? "ask2" : "ask3", { thing: c.thing });
  };

  /** One ask, as a durable slot: never twice for the same id and time, whatever restarts in between. */
  const send = async (c: CheckIn): Promise<"sent" | "unsent" | "busy"> => {
    const buttons = [
      { id: `ci1:${c.id}`, title: CT()("btnYes") }, { id: `ci2:${c.id}`, title: CT()("btnNotYet") }, { id: `ci3:${c.id}`, title: CT()("btnPark") },
    ];
    const go = (): Promise<boolean> => d.card(askText(c), buttons).catch(() => false);
    if (!d.jobs) return (await go()) ? "sent" : "unsent";
    let sent = false;
    const out = await d.jobs.slot("checkin", `checkin:${c.id}@${c.due}`, c.due, async (x) => {
      sent = await x.once("send", go);
      return sent ? undefined : "retry";
    });
    if (out === "done") return "sent";
    if (out === "busy") return "busy";
    return sent ? "sent" : "unsent";
  };

  /**
   * The look (every tick of the durable jobs): the check-ins whose time has come are asked, moved past quiet hours or a meeting, or kept for
   * the brief (too old, over the cap, or one of several late ones). The ids asked.
   */
  const sweep = (): Promise<string[]> => serial(async () => {
    const t = now();
    const s = await load();
    // Asked and never answered for two hours: kept for the brief, like one that was never sent (it would hold its place for days otherwise).
    const unanswered = s.list.filter((c) => c.state === "asked" && t - (c.askedAt ?? c.at) > CHECKIN_STALE_MS);
    for (const c of unanswered) toBrief(c, t);
    const waiting = s.list.filter((c) => c.state === "waiting" && c.at <= t).sort((a, b) => a.at - b.at);
    if (!waiting.length) {
      if (unanswered.length) await save(s);
      return [];
    }
    // A follow-up's check-in whose follow-up was parked or closed since: nothing to ask about, nor to carry to the brief. It ends quietly.
    // (A follow-up that cannot be read just now is taken as still open.)
    const due: CheckIn[] = [];
    for (const c of waiting) {
      const l = c.loop && d.loop ? await d.loop(c.loop).catch(() => undefined) : undefined;
      if (l === null) Object.assign(c, { state: "done", endedAt: t });
      else due.push(c);
    }
    if (!due.length) {
      await save(s);
      return [];
    }
    const day = today(t, d.timeZone);
    if (s.day !== day) Object.assign(s, { day, n: 0 });
    // Too old: the brief, quietly. Of several late ones (a sleep), only the newest goes.
    const fresh: CheckIn[] = [];
    for (const c of due) {
      if (t - c.due > CHECKIN_STALE_MS) toBrief(c, t);
      else fresh.push(c);
    }
    const late = fresh.filter((c) => t - c.at > LATE_MS);
    for (const c of late.slice(0, -1)) toBrief(c, t);
    const go = fresh.filter((c) => !late.includes(c) || c === late.at(-1));
    const events = go.length && d.events ? await d.events().catch(() => [] as CalEvent[]) : [];
    const g = go.length ? await d.settings() : null;
    const asked: string[] = [];
    for (const c of go) {
      // Quiet hours, then a meeting: moved to their end, within two hours of the time asked; past that, the brief.
      const quiet = d.quiet && quietAt(d.quiet, t, d.timeZone) ? quietEnd(d.quiet, t, d.timeZone) : null;
      const busy = quiet === null ? busyUntil(events, t) : null;
      const later = quiet ?? (busy === null ? null : busy + MIN);
      if (later !== null) {
        if (later - c.due > CHECKIN_STALE_MS) toBrief(c, t);
        else c.at = later;
        continue;
      }
      // The first ask takes its place in the day's cap before the card goes (the check and the count are one turn, saved so the other
      // parts' turns see it); a card that did not go gives the place back. A re-ask of one already counted costs nothing.
      let reserved = false;
      if (!c.counted) {
        reserved = await take(cap(d.standardMax, g!.on ? g!.maxPerDay : null), async (room) => {
          // One the owner asked for in the chat at a time (no follow-up behind it) is asked whatever the day's cap says: it was never Pako's
          // to hold back for the brief. It still counts, so the parts that speak on their own leave room for it.
          if (c.loop && s.n >= room) return false;
          s.n++;
          c.counted = true;
          await save(s);
          return true;
        });
        if (!reserved) {
          toBrief(c, t);
          continue;
        }
      }
      const out = await send(c);
      if (out !== "sent") {
        // The next look tries again, until it is two hours old.
        if (reserved) {
          s.n = Math.max(0, s.n - 1);
          c.counted = false;
          await save(s);
        }
        continue;
      }
      Object.assign(c, { state: "asked", askedAt: t, counted: true });
      d.log?.(CT()("logAsked", { thing: c.thing || CT()("briefNone") }));
      asked.push(c.id);
    }
    await save(s);
    return asked;
  }).catch((err: Error) => {
    log.error(`the check-ins: ${err.message}`);
    return [];
  });

  /** Yes (1), Not yet (2), Park (3): what to tell the owner. */
  const pressed = (button: "1" | "2" | "3", id: string): Promise<string> => serial(async () => {
    const t = now();
    let s: State;
    try {
      s = await load();
    } catch (err) {
      return unread(err);
    }
    const c = s.list.find((x) => x.id === id);
    if (!c) return CT()("gone");
    if (c.state !== "asked" && c.state !== "waiting") return CT()("answered");
    const thing = c.thing || CT()("briefNone");
    let say: string;
    let park = false;
    if (button === "1") {
      Object.assign(c, { state: "done", endedAt: t });
      say = CT()("yes");
    } else if (button === "2" && c.state === "waiting" && c.tries > 0) {
      // This card's Not yet was pressed already (the same card on another chat, or twice): it counts once, and says the same look again.
      return CT()("notYet", { time: clock(c.at) });
    } else if (button === "2") {
      if (c.tries >= CHECKIN_TRIES) {
        toBrief(c, t);
        say = CT()("stopped", { thing });
      } else {
        const g = await d.settings();
        const at = t + g.checkinAgainMin * MIN;
        Object.assign(c, { state: "waiting", tries: c.tries + 1, due: at, at });
        say = CT()("notYet", { time: clock(at) });
      }
    } else {
      Object.assign(c, { state: "parked", endedAt: t });
      park = !!c.loop && !!d.parkLoop;
      say = CT()("parked", { thing });
    }
    await save(s);
    // A follow-up's check-in parks the follow-up itself: it goes to the Parked list, and its own words say so.
    if (park) return d.parkLoop!(c.loop!).catch(() => say);
    return say;
  });

  /** The brief's line: check-ins kept for it in the last day (too old, over the cap, or stopped after three "Not yet"); null when none. */
  const briefLine = async (): Promise<string | null> => {
    const t = now();
    const list = (await peek()).list.filter((c) => c.state === "brief" && t - (c.endedAt ?? 0) < DAY);
    if (!list.length) return null;
    return CT()("briefLine", {
      list: list.slice(-5).map((c) => CT()("briefItem", { thing: c.thing || CT()("briefNone"), time: ownerClock(c.due, d.timeZone) })).join(", "),
    });
  };

  /** First asks today: counted in the shared cap by the follow-ups and proactive Pako. */
  const spentToday = async (): Promise<number> => {
    const s = await peek();
    return s.day === today(now(), d.timeZone) ? s.n : 0;
  };

  return { add, fromChat, forLoop, loopButton, sweep, pressed, briefLine, spentToday, list: async () => (await peek()).list };
}
export type CheckIns = ReturnType<typeof createCheckIns>;
