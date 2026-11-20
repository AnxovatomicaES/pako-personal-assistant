// Gentle mode's weekly reset: one message a week (Monday 09:30 in the owner's zone by default, set in the panel), never in the quiet hours
// and never during a meeting (it waits for the end):
//
//   "🌱 A gentle reset: 3 things are slipping. Pick one to do this week, and I'll park the rest so they stop pulling at you."
//
// Up to three open follow-ups that are slipping (stuck two days, snoozed twice, folded into the brief, or past their time), the owner's
// promises to people first, then the oldest. Each has "This one" (the week's focus: first in the brief for seven days) and "Park"; after a
// pick, "Park the rest" parks the others. Where a chat has three buttons at most (WhatsApp), the picks are buttons and "park 2" is typed.
//
// Parked items older than 30 days get one line in it, "bring back or let go?"; a week later, still parked, they are let go, with a note kept
// in the Parked list's history (90 days). The send is a durable slot (src/jobs.ts, "gentle-reset:<day>"): once a week, whatever restarts.

import { randomBytes } from "node:crypto";
import type { CalEvent } from "./calendar.ts";
import type { Loop } from "./followups.ts";
import { zonedTime } from "./followups/time.ts";
import { busyUntil } from "./gentle-checkins.ts";
import { isStuck, quietAt, type GentleConfig } from "./gentle.ts";
import { texts } from "./i18n.ts";
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

export const RESET_KEY = "gentle-reset";
/** w + f1..f3 This one, p1..p3 Park, pr Park the rest, kp Keep them, lg Let them go (the month-old parked ones): w<x>:<reset id>. */
export const RESET_BUTTON = /^w(f[1-3]|p[1-3]|pr|kp|lg):([0-9a-f]{10})$/;
/** Parked this long, an item gets its "bring back or let go?" line; a week after that line, still parked, it is let go. */
export const PARKED_ASK_MS = 30 * DAY;
export const LET_GO_AFTER_MS = 7 * DAY;
/** The week's focus lasts this long (or until it is closed). */
const FOCUS_MS = 7 * DAY;
/** A reset whose moment passed more than this ago (a computer off all Monday) waits for next week. */
const LATE_MAX_MS = 12 * HOUR;
const HISTORY_KEEP_MS = 90 * DAY;

/** The reset's words: exported whole so the no-shame test reads every one. */
export const RESET_WORDS = {
  head: "🌱 A gentle reset: {n} things are slipping. Pick one to do this week, and I'll park the rest so they stop pulling at you.",
  headOne: "🌱 A gentle reset: one thing is slipping. Make it this week's one, or park it so it stops pulling at you.",
  headNone: "🌱 A gentle reset: nothing is slipping this week.",
  item: "{i}. {title}{who}",
  who: " (for {who})",
  typed: "Or say “park 2” to park one.",
  old: "🅿️ Parked a month ago: “{title}”. Bring back or let go?",
  oldHint: "Say “bring back” and a few of its words to bring one back; otherwise I'll let it go next week, with a note in your Parked list.",
  btnThis: "This one",
  btnThisN: "This one: {i}",
  btnPark: "Park",
  btnParkN: "Park {i}",
  btnParkRest: "Park the rest",
  btnKeep: "Keep them",
  btnLetGo: "Let them go",
  focus: "This week's focus: “{title}”. It'll lead your brief.",
  restAsk: "Park the other {n} so they stop pulling at you?",
  restParked: "Parked {n}: {list}. They wait in your Parked list.",
  kept: "OK, they stay as they are.",
  parked: "Parked: “{title}”.",
  letGo: "Let go: {list}. A note stays in your Parked list.",
  nothingLeft: "Nothing left to park there.",
  gone: "That reset is from an earlier week.",
  unread: "I couldn't read this week's reset just now, so nothing changed. Could you try once more in a moment?",
  closed: "“{title}” isn't open any more.",
  briefFocus: "🌱 This week's focus: {title}",
  logSent: "Weekly reset sent ({n} slipping)",
  logFocus: "This week's focus: {title}",
  logLetGo: "Let go after a month parked: {title}",
};
export const RT = texts(RESET_WORDS);

interface ResetItem {
  loop: string;
  title: string;
  who: string;
}
interface Reset {
  id: string;
  at: number;
  /** The day it was for ("2026-11-23"). */
  day: string;
  items: ResetItem[];
  /** The month-old parked ones it asked about. */
  old: ResetItem[];
}
export interface LetGo {
  title: string;
  who: string;
  parkedAt: number;
  at: number;
  /** Let go by the reset ("bring back or let go?", a week later or Let them go), or by the store after 45 days parked (src/followups/store.ts). */
  why?: "reset" | "expired";
}
interface State {
  resets: Reset[];
  focus: (ResetItem & { at: number }) | null;
  /** Parked loops asked "bring back or let go?", and when. */
  asked: { loop: string; at: number }[];
  /** The Parked list's history: what was let go, and when. */
  letGo: LetGo[];
}
const empty = (): State => ({ resets: [], focus: null, asked: [], letGo: [] });
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const itemOf = (v: unknown): ResetItem | null => {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  return o && typeof o.loop === "string" && /^[0-9a-f]{10}$/.test(o.loop) ? { loop: o.loop, title: str(o.title, 140), who: str(o.who, 60) } : null;
};
const stateOf = (v: unknown): State => {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
  const items = (x: unknown): ResetItem[] => arr(x).map(itemOf).filter((i): i is ResetItem => i !== null).slice(0, 3);
  const f = itemOf(o.focus);
  return {
    resets: arr(o.resets).flatMap((x): Reset[] => {
      const r = x && typeof x === "object" ? (x as Record<string, unknown>) : null;
      return r && typeof r.id === "string" && /^[0-9a-f]{10}$/.test(r.id)
        ? [{ id: r.id, at: num(r.at), day: str(r.day, 10), items: items(r.items), old: items(r.old) }] : [];
    }).slice(-6),
    focus: f ? { ...f, at: num((o.focus as Record<string, unknown>).at) } : null,
    asked: arr(o.asked).flatMap((x) => {
      const a = x as Record<string, unknown>;
      return a && typeof a.loop === "string" && typeof a.at === "number" ? [{ loop: a.loop, at: a.at }] : [];
    }).slice(-100),
    letGo: arr(o.letGo).flatMap((x) => {
      const a = x as Record<string, unknown>;
      return a && typeof a.title === "string" ? [{ title: str(a.title, 140), who: str(a.who, 60), parkedAt: num(a.parkedAt), at: num(a.at) }] : [];
    }).slice(-50),
  };
};

/** Parked at or before `t` and not brought back since (its parking is the one a reset asked about at `t`). */
const parkedBefore = (l: Loop, t: number): boolean => (l.parkedAt ?? l.createdAt) <= t;

/** This week's reset moment at or before `t` (the configured weekday and time, in the owner's zone, DST as it is), and its day. */
export function resetMoment(t: number, tz: string, day: number, at: number): { day: string; at: number } | null {
  for (let k = 0; k < 8; k++) {
    const d = today(t - k * DAY, tz);
    if (new Date(`${d}T12:00:00Z`).getUTCDay() !== day) continue;
    const when = zonedTime(`${d} ${String(Math.floor(at / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}`, tz);
    if (when !== null && when <= t) return { day: d, at: when };
  }
  return null;
}

/** Slipping: stuck (said two days ago, or snoozed twice), folded into the brief, or past its time. Never someone else's promise. */
const slipping = (l: Loop, t: number): boolean =>
  l.kind !== "other_promise" && (l.status === "open" || l.status === "snoozed") && (isStuck(l, t) || !!l.folded || (!!l.dueAt && l.dueAt < t));

/** Up to three slipping loops: the owner's promises to people first, then the oldest. */
export function pickSlipping(loops: readonly Loop[], t: number): Loop[] {
  const rank = (l: Loop): number => (l.kind === "owner_promise" && l.who ? 0 : 1);
  return loops.filter((l) => slipping(l, t)).sort((a, b) => rank(a) - rank(b) || a.whenSaid - b.whenSaid).slice(0, 3);
}

export interface WeeklyResetDeps {
  kv: Kv | null;
  timeZone: string;
  now?: () => number;
  /** Gentle mode's settings: null while it is off (no reset then, and no expiry). */
  settings: () => Promise<GentleConfig | null>;
  loops: () => Promise<Loop[]>;
  parked: () => Promise<Loop[]>;
  /** Park one (src/followups/owner.ts press "7"), and let a parked one go (letGo): each says whether it happened. */
  park: (id: string) => Promise<boolean>;
  letGo: (id: string) => Promise<boolean>;
  quiet: { start: number; end: number } | null;
  events?: () => Promise<CalEvent[]>;
  jobs?: Pick<Jobs, "slot">;
  /** Whether the chat has room for more than three buttons (the panel's chat, Telegram). */
  roomy: () => Promise<boolean>;
  card: (body: string, buttons: { id: string; title: string }[]) => Promise<boolean>;
  /** Parked items the store let go after 45 days (src/followups/owner.ts expiredParked): in the history too, whether the reset ran or not. */
  expired?: () => Promise<{ title: string; who: string; parkedAt: number; at: number }[]>;
  log?: (text: string) => void;
}

export function createWeeklyReset(d: WeeklyResetDeps) {
  const now = d.now ?? Date.now;
  let memory = empty();
  // A store that does not answer throws (src/json-record.ts): an empty state in its place would send this week's reset again and be saved
  // over the week's focus and the Parked list's history. What changes it then changes nothing; what only reads it gets nothing.
  const load = async (): Promise<State> => (d.kv ? stateOf((await readJsonRecord(d.kv, RESET_KEY)) ?? {}) : structuredClone(memory));
  const peek = (): Promise<State> => load().catch((err: Error) => {
    log.warn(`the weekly reset could not be read: ${err.message}`);
    return empty();
  });
  const save = async (s: State): Promise<void> => {
    const t = now();
    s.letGo = s.letGo.filter((x) => t - x.at < HISTORY_KEEP_MS).slice(-50);
    s.resets = s.resets.filter((r) => t - r.at < 21 * DAY).slice(-6);
    if (s.focus && t - s.focus.at >= FOCUS_MS) s.focus = null;
    memory = s;
    if (d.kv) await d.kv.set(RESET_KEY, JSON.stringify(s), 120 * 24 * 3600);
  };
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <R>(fn: () => Promise<R>): Promise<R> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const who = (w: string): string => (w ? RT()("who", { who: w }) : "");

  /** The message and its buttons for these items and month-old parked ones. */
  const compose = (r: Reset, roomy: boolean): { body: string; buttons: { id: string; title: string }[] } => {
    const n = r.items.length;
    const lines = [n === 0 ? RT()("headNone") : n === 1 ? RT()("headOne") : RT()("head", { n })];
    if (n) lines.push(r.items.map((x, i) => RT()("item", { i: i + 1, title: x.title, who: who(x.who) })).join("\n"));
    const buttons: { id: string; title: string }[] = [];
    if (n === 1) buttons.push({ id: `wf1:${r.id}`, title: RT()("btnThis") }, { id: `wp1:${r.id}`, title: RT()("btnPark") });
    else if (n) {
      r.items.forEach((_x, i) => buttons.push({ id: `wf${i + 1}:${r.id}`, title: RT()("btnThisN", { i: i + 1 }) }));
      if (roomy) r.items.forEach((_x, i) => buttons.push({ id: `wp${i + 1}:${r.id}`, title: RT()("btnParkN", { i: i + 1 }) }));
      else lines.push(RT()("typed"));
    }
    if (r.old.length) {
      lines.push(r.old.map((x) => RT()("old", { title: x.title })).join("\n"), RT()("oldHint"));
      if (roomy || buttons.length < 3) buttons.push({ id: `wlg:${r.id}`, title: RT()("btnLetGo") });
    }
    return { body: lines.join("\n\n"), buttons };
  };

  /** Lets go of parked loops asked about a week ago or more (and still parked): each with a note in the history. */
  const expire = async (s: State, t: number): Promise<boolean> => {
    const due = s.asked.filter((a) => t - a.at >= LET_GO_AFTER_MS);
    if (!due.length) return false;
    const parked = await d.parked();
    for (const a of due) {
      const l = parked.find((x) => x.id === a.loop);
      s.asked = s.asked.filter((x) => x !== a);
      // Brought back and parked again since it was asked about: a new parking, with its own month.
      if (!l || !parkedBefore(l, a.at) || !(await d.letGo(l.id).catch(() => false))) continue;
      s.letGo.push({ title: l.title, who: l.who, parkedAt: l.parkedAt ?? l.createdAt, at: t });
      d.log?.(RT()("logLetGo", { title: l.title }));
    }
    return true;
  };

  /** The reset itself, now: picked, sent, kept. False when there was nothing to say or it could not go. */
  const send = async (day: string): Promise<boolean> => {
    const t = now();
    const s = await load();
    const loops = await d.loops();
    const items = pickSlipping(loops, t).map((l) => ({ loop: l.id, title: inline(l.title, 140), who: inline(l.who, 60) }));
    const askedIds = new Set(s.asked.map((a) => a.loop));
    const old = (await d.parked()).filter((l) => t - (l.parkedAt ?? l.createdAt) >= PARKED_ASK_MS && !askedIds.has(l.id)).slice(0, 3)
      .map((l) => ({ loop: l.id, title: inline(l.title, 140), who: inline(l.who, 60) }));
    const r: Reset = { id: randomBytes(5).toString("hex"), at: t, day, items, old };
    // Nothing slipping and nothing month-old: no message (a quiet week), kept as this week's so it is not looked at again.
    if (!items.length && !old.length) {
      s.resets.push(r);
      await save(s);
      return true;
    }
    const { body, buttons } = compose(r, await d.roomy().catch(() => false));
    if (!(await d.card(body, buttons).catch(() => false))) return false;
    s.resets.push(r);
    for (const x of old) s.asked.push({ loop: x.loop, at: t });
    await save(s);
    d.log?.(RT()("logSent", { n: items.length }));
    return true;
  };

  let expiredAt = 0;
  /**
   * The look (every tick of the durable jobs, gentle mode only): the week's reset when its moment came (today, out of the quiet hours and
   * of any meeting), as a durable slot; and, every ten minutes, letting go of what was asked about a week ago. Whether a reset went now.
   */
  const sweep = (): Promise<boolean> => serial(async () => {
    const g = await d.settings();
    if (!g) return false;
    const t = now();
    if (t - expiredAt >= 10 * MIN) {
      expiredAt = t;
      const s = await load();
      if (await expire(s, t)) await save(s);
    }
    const m = resetMoment(t, d.timeZone, g.resetDay, g.resetAt);
    if (!m || t - m.at > LATE_MAX_MS || today(t, d.timeZone) !== m.day) return false;
    if ((await load()).resets.some((r) => r.day === m.day)) return false;
    if (d.quiet && quietAt(d.quiet, t, d.timeZone)) return false;
    if (d.events && busyUntil(await d.events().catch(() => [] as CalEvent[]), t) !== null) return false;
    if (!d.jobs) return send(m.day);
    let went = false;
    const out = await d.jobs.slot("gentle-reset", `gentle-reset:${m.day}`, m.at, async (c) => {
      const ok = await c.once("send", async () => (went = await send(m.day)));
      return ok ? undefined : "retry";
    });
    return out === "done" && went;
  }).catch((err: Error) => {
    log.error(`the weekly reset: ${err.message}`);
    return false;
  });

  /** A button of a reset's card (or "park 2" typed): what to tell the owner, and a card to follow (after a pick: Park the rest). */
  const pressed = (what: string, id: string): Promise<{ say: string; card?: { body: string; buttons: { id: string; title: string }[] } }> =>
    serial(async () => {
      const t = now();
      let s: State;
      try {
        s = await load();
      } catch (err) {
        log.warn(`the weekly reset could not be read, nothing changed: ${(err as Error).message}`);
        return { say: RT()("unread") };
      }
      const r = s.resets.find((x) => x.id === id);
      if (!r || t - r.at > 8 * DAY) return { say: RT()("gone") };
      const open = new Set((await d.loops()).map((l) => l.id));
      const i = Number(what.slice(1)) - 1;
      if (what[0] === "f") {
        const x = r.items[i];
        if (!x) return { say: RT()("gone") };
        if (!open.has(x.loop)) return { say: RT()("closed", { title: x.title }) };
        s.focus = { ...x, at: t };
        await save(s);
        d.log?.(RT()("logFocus", { title: x.title }));
        const rest = r.items.filter((y) => y.loop !== x.loop && open.has(y.loop));
        if (!rest.length) return { say: RT()("focus", { title: x.title }) };
        return {
          say: RT()("focus", { title: x.title }),
          card: {
            body: RT()("restAsk", { n: rest.length }),
            buttons: [{ id: `wpr:${r.id}`, title: RT()("btnParkRest") }, { id: `wkp:${r.id}`, title: RT()("btnKeep") }],
          },
        };
      }
      if (what[0] === "p" && what !== "pr") {
        const x = r.items[i];
        if (!x) return { say: RT()("gone") };
        if (!open.has(x.loop)) return { say: RT()("closed", { title: x.title }) };
        await d.park(x.loop);
        if (s.focus?.loop === x.loop) {
          s.focus = null;
          await save(s);
        }
        return { say: RT()("parked", { title: x.title }) };
      }
      if (what === "pr") {
        const rest = r.items.filter((y) => y.loop !== s.focus?.loop && open.has(y.loop));
        const done: string[] = [];
        for (const y of rest) if (await d.park(y.loop).catch(() => false)) done.push(`“${y.title}”`);
        return { say: done.length ? RT()("restParked", { n: done.length, list: done.join(", ") }) : RT()("nothingLeft") };
      }
      if (what === "kp") return { say: RT()("kept") };
      // lg: the month-old parked ones of this reset, let go now.
      const parked = await d.parked();
      const done: string[] = [];
      for (const x of r.old) {
        const l = parked.find((y) => y.id === x.loop);
        if (!l || !parkedBefore(l, r.at) || !(await d.letGo(l.id).catch(() => false))) continue;
        s.letGo.push({ title: l.title, who: l.who, parkedAt: l.parkedAt ?? l.createdAt, at: t });
        s.asked = s.asked.filter((a) => a.loop !== l.id);
        done.push(`“${l.title}”`);
      }
      await save(s);
      return { say: done.length ? RT()("letGo", { list: done.join(", ") }) : RT()("nothingLeft") };
    });

  /** "park 2" typed after a reset (WhatsApp's three buttons): the latest reset of the last week. Null when there is none. */
  const typedPark = async (n: number): Promise<string | null> => {
    const r = (await peek()).resets.filter((x) => now() - x.at < 7 * DAY).at(-1);
    if (!r || !r.items[n - 1]) return null;
    return (await pressed(`p${n}`, r.id)).say;
  };

  /** The week's focus while it lasts and its follow-up is still open: the brief puts it first. */
  const focus = async (): Promise<{ loop: string; title: string; who: string } | null> => {
    const s = await peek();
    const f = s.focus;
    if (!f || now() - f.at >= FOCUS_MS) return null;
    const open = await d.loops().catch(() => [] as Loop[]);
    return open.some((l) => l.id === f.loop) ? { loop: f.loop, title: f.title, who: f.who } : null;
  };

  return {
    sweep, send, pressed, typedPark, focus, compose,
    /** The brief's first line in gentle mode, or null. */
    briefLine: async (): Promise<string | null> => {
      if (!(await d.settings())) return null;
      const f = await focus();
      return f ? RT()("briefFocus", { title: f.title }) : null;
    },
    /** The Parked list's history: what was let go, by the reset or by the store after 45 days, newest first. */
    history: async (): Promise<LetGo[]> => {
      const mine = (await peek()).letGo.map((x): LetGo => ({ ...x, why: "reset" }));
      const expired = d.expired ? (await d.expired().catch(() => [])).map((x): LetGo => ({ ...x, why: "expired" })) : [];
      return [...mine, ...expired].sort((a, b) => b.at - a.at);
    },
  };
}
export type WeeklyReset = ReturnType<typeof createWeeklyReset>;
