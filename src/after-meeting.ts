// After a meeting Pako could not hear: one question, while it is fresh. Promises made in a room, on Google Meet or on Teams are the ones most
// often lost, and Pako reads only what is written (a Zoom call has its own review, src/meeting-review.ts). About ten minutes after a meeting
// with other people ends:
//
//   "🤝 “Bluefin review” just ended. Did you promise anything, or were you asked for something? Tell me in a line (“I'll send Ana the deck
//    Friday”) and I'll keep track."   Nothing · Not for these
//
// The answer is an ordinary chat message: the assistant keeps a promise said there as a follow-up (src/door/held-replies.ts), as always.
// Nothing (n) ends it; Not for these (m) never asks again after a meeting with that title (a weekly standup). Only in working hours, never in
// the quiet hours or during the next meeting (it waits, up to an hour after the end), not for a focus block, a meeting shorter than 15
// minutes, one the owner declined, one with nobody else on it, or a Zoom call when the Zoom review is on; two a day at most, and none once
// the day's shared nudge cap is spent. AFTER_MEETING=off turns it off.

import { randomBytes } from "node:crypto";
import type { CalEvent } from "./calendar.ts";
import { busyUntil } from "./gentle-checkins.ts";
import { quietAt } from "./gentle.ts";
import { texts } from "./i18n.ts";
import { readJsonRecord } from "./json-record.ts";
import type { Kv } from "./kv.ts";
import { fold, today } from "./lists.ts";
import { createLog } from "./log.ts";
import { inline } from "./quarantine.ts";
import { isFocusBlock, workSpans, type WorkHours } from "./time-to-do.ts";

const log = createLog("after-meeting");

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export const AFTER_MEETING_KEY = "after-meeting";
/** n Nothing, m Not for these: a<n|m>:<ask id>. */
export const AFTER_BUTTON = /^a([nm]):([0-9a-f]{10})$/;
/** Asked this long after the end, and no later than this. */
export const ASK_AFTER_MS = 10 * MIN;
export const ASK_UNTIL_MS = 60 * MIN;
const SHORTEST_MS = 15 * MIN;
export const ASKS_PER_DAY = 2;
const MUTED_MAX = 100;

export const AFTER_WORDS = {
  ask: "🤝 “{title}” just ended. Did you promise anything, or were you asked for something? Tell me in a line (“I'll send Ana the deck Friday”) "
    + "and I'll keep track.",
  btnNothing: "Nothing",
  btnMute: "Not for these",
  nothing: "OK, nothing to keep from “{title}”.",
  muted: "OK, from now on I won't ask after “{title}”.",
  gone: "That question is from an earlier meeting.",
  unread: "I couldn't read that just now, so nothing changed. Could you try once more in a moment?",
  logAsked: "Asked after a meeting: {title}",
};
export const AW = texts(AFTER_WORDS);

interface Ask {
  id: string;
  /** The title's mute key, made from the meeting's own title when it was asked (src: titleKey), so "Not for these" mutes what is compared. */
  key: string;
  /** The event's id and start: one question per occurrence. */
  event: string;
  start: number;
  title: string;
  at: number;
}
interface State {
  asks: Ask[];
  /** Folded titles never asked after. */
  muted: string[];
}
const HEX10 = /^[0-9a-f]{10}$/;
const stateOf = (v: unknown): State => {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const asks = (Array.isArray(o.asks) ? o.asks : []).flatMap((x): Ask[] => {
    const a = x && typeof x === "object" ? (x as Record<string, unknown>) : null;
    if (!a || typeof a.id !== "string" || !HEX10.test(a.id) || typeof a.event !== "string" || typeof a.start !== "number" || typeof a.at !== "number") return [];
    const title = typeof a.title === "string" ? a.title.slice(0, 120) : "";
    return [{ id: a.id, key: typeof a.key === "string" ? a.key.slice(0, 300) : titleKey(title), event: a.event.slice(0, 300), start: a.start, title, at: a.at }];
  });
  const muted = (Array.isArray(o.muted) ? o.muted : []).filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 300));
  return { asks: asks.slice(-60), muted: muted.slice(-MUTED_MAX) };
};

/** The key a title is muted under: folded, numbers and dates left out ("Weekly sync 12/3" and "Weekly sync 19/3" are one). */
export const titleKey = (title: string): string => fold(title).replace(/[\p{N}]+/gu, " ").replace(/[^\p{L} ]+/gu, " ").replace(/\s+/g, " ").trim();

/**
 * Someone else is on it. Knowing the owner's addresses: one attendee who is not them (an ICS feed often lists only the guests, the organizer
 * apart: a 1:1 the owner set up has one attendee, review finding). Not knowing them: two attendees, or one and an organizer who is not that
 * one.
 */
export function withSomeone(e: CalEvent, self: readonly string[]): boolean {
  const list = (e.attendees ?? []).map((a) => a.email.trim().toLowerCase()).filter(Boolean);
  const me = new Set(self.map((x) => x.trim().toLowerCase()).filter(Boolean));
  if (me.size) return list.some((a) => !me.has(a));
  if (list.length >= 2) return true;
  const org = (e.organizer ?? "").trim().toLowerCase();
  return list.length === 1 && !!org && !org.includes(list[0]!);
}

/** A meeting worth asking after: timed, not declined or only invited by mail, 15 minutes or more, with someone else on it, not a focus block. */
export function askable(e: CalEvent, o: { zoomReview: boolean; self?: readonly string[] }): boolean {
  if (e.allDay || e.response === "declined" || e.invited || e.end - e.start < SHORTEST_MS) return false;
  if (isFocusBlock(e.title) || !titleKey(e.title)) return false;
  if (!withSomeone(e, o.self ?? [])) return false;
  if (o.zoomReview && e.join && /zoom\.(us|com)\//i.test(e.join)) return false;
  return true;
}

export interface AfterMeetingDeps {
  kv: Kv | null;
  timeZone: string;
  now?: () => number;
  /** AFTER_MEETING is not "off". */
  on: boolean;
  /** The panel's switch (src/day-helpers.ts), which wins over `on` when given. */
  enabled?: () => Promise<boolean>;
  /** The owner's own addresses: a meeting needs one attendee who is not them (an ICS feed may list only the guests). */
  self?: () => string[];
  hours: WorkHours;
  quiet: { start: number; end: number } | null;
  events: () => Promise<CalEvent[]>;
  /** The Zoom review is connected: a Zoom call is reviewed from its summary instead. */
  zoomReview: boolean;
  /** The day's shared cap, and what the follow-ups, check-ins, time-to-do and suggestions sent today. */
  cap: () => Promise<number>;
  others: () => Promise<number>;
  card: (body: string, buttons: { id: string; title: string }[]) => Promise<boolean>;
  log?: (text: string) => void;
}

export function createAfterMeeting(d: AfterMeetingDeps) {
  const now = d.now ?? Date.now;
  const tz = d.timeZone;
  let memory: State = { asks: [], muted: [] };
  const load = async (): Promise<State> => (d.kv ? stateOf((await readJsonRecord(d.kv, AFTER_MEETING_KEY)) ?? {}) : structuredClone(memory));
  const save = async (s: State): Promise<void> => {
    const t = now();
    s.asks = s.asks.filter((a) => t - a.at < 14 * DAY).slice(-60);
    s.muted = s.muted.slice(-MUTED_MAX);
    memory = s;
    if (d.kv) await d.kv.set(AFTER_MEETING_KEY, JSON.stringify(s), 400 * 24 * 3600);
  };
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <R>(fn: () => Promise<R>): Promise<R> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const working = (t: number): boolean => workSpans(t - 1, t + 1, tz, d.hours).some((s) => s.start <= t && s.end > t);

  /** The look (every tick of the durable jobs): one question for one meeting that ended 10 to 60 minutes ago. Whether one went. */
  const sweep = (): Promise<boolean> => serial(async () => {
    if (d.enabled ? !(await d.enabled().catch(() => d.on)) : !d.on) return false;
    const t = now();
    if (!working(t) || (d.quiet && quietAt(d.quiet, t, tz))) return false;
    const events = await d.events();
    if (busyUntil(events, t) !== null) return false;
    const s = await load();
    const day = today(t, tz);
    if (s.asks.filter((a) => today(a.at, tz) === day).length >= ASKS_PER_DAY) return false;
    const muted = new Set(s.muted);
    const asked = new Set(s.asks.map((a) => `${a.event}@${a.start}`));
    const due = events
      .filter((e) => e.end + ASK_AFTER_MS <= t && t - e.end <= ASK_UNTIL_MS && askable(e, { zoomReview: d.zoomReview, self: d.self?.() ?? [] }))
      .filter((e) => !muted.has(titleKey(e.title).slice(0, 300)) && !asked.has(`${e.id.slice(0, 300)}@${e.start}`))
      .sort((a, b) => b.end - a.end);
    const e = due[0];
    if (!e) return false;
    // The others' total and this part's own questions today (review finding: its own were left out of its check).
    const mine = s.asks.filter((x) => today(x.at, tz) === day).length;
    if (mine + (await d.others().catch(() => 0)) >= (await d.cap().catch(() => 0))) return false;
    const a: Ask = {
      id: randomBytes(5).toString("hex"), key: titleKey(e.title).slice(0, 300), event: e.id.slice(0, 300), start: e.start, title: inline(e.title, 120), at: t,
    };
    // Kept before it is sent: a send that fails is not tried again for that meeting (one question, never two).
    s.asks.push(a);
    await save(s);
    const ok = await d.card(AW()("ask", { title: a.title }), [
      { id: `an:${a.id}`, title: AW()("btnNothing") }, { id: `am:${a.id}`, title: AW()("btnMute") },
    ]).catch(() => false);
    if (ok) d.log?.(AW()("logAsked", { title: a.title }));
    return ok;
  }).catch((err: Error) => {
    log.error(`${err.message}`);
    return false;
  });

  /** Nothing or Not for these: what to tell the owner. */
  const pressed = (what: "n" | "m", id: string): Promise<string> => serial(async () => {
    let s: State;
    try {
      s = await load();
    } catch (err) {
      log.warn(`could not be read, nothing changed: ${(err as Error).message}`);
      return AW()("unread");
    }
    const a = s.asks.find((x) => x.id === id);
    if (!a) return AW()("gone");
    if (what === "n") return AW()("nothing", { title: a.title });
    if (a.key && !s.muted.includes(a.key)) s.muted.push(a.key);
    await save(s);
    return AW()("muted", { title: a.title });
  });

  /** Questions asked today: for the shared cap. */
  const spentToday = async (): Promise<number> => {
    const s = await load().catch(() => ({ asks: [] as Ask[] }));
    const day = today(now(), tz);
    return s.asks.filter((a) => today(a.at, tz) === day).length;
  };

  return { sweep, pressed, spentToday };
}
export type AfterMeeting = ReturnType<typeof createAfterMeeting>;
