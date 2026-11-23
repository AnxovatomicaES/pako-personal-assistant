// What changed on the owner's calendar: a snapshot of the next two weeks kept in the store, compared with each new reading. An event that is
// new, one that moved (the same id at another time), and one that is gone before its time (cancelled, deleted or declined) are logged for
// three days. The brief's "since your last brief" facts come from this log, and the follow-ups follow a meeting that moved or was called off.
//
// A reading that fails, or one that comes back empty while the last one had several events ahead, is never taken for a wave of
// cancellations: it is skipped, and the snapshot stays as it was. A partial one (a calendar could not be read: its events may be missing)
// still finds what is new or moved, but nothing in it is cancelled: what it does not show stays in the snapshot until a full reading.

import type { CalEvent } from "./calendar.ts";
import type { Kv } from "./kv.ts";
import { createLog } from "./log.ts";
import { readJsonRecord } from "./json-record.ts";

const log = createLog("calendar");

export const CALENDAR_CHANGES_KEY = "calendar-changes";
const WINDOW_MS = 14 * 24 * 3600_000;
const KEEP_MS = 3 * 24 * 3600_000;
const LOG_MAX = 100;
const SNAP_MAX = 400;
/** A move smaller than this is the same time (a feed rounding seconds). */
const SAME_MS = 60_000;
/** An event first seen this soon is new; one further out only came into the window. */
const ADDED_MS = 7 * 24 * 3600_000;

export interface CalChange {
  kind: "added" | "moved" | "cancelled";
  /** The event's id in the feed. */
  id: string;
  title: string;
  /** Its start now (moved, added) or the start it had (cancelled). */
  start: number;
  end?: number;
  /** For a move: the start it had before. */
  was?: number;
  /** When Pako noticed it. */
  at: number;
}

interface Snap {
  id: string;
  title: string;
  start: number;
  end: number;
  /** The event's iCalendar UID, when the feed gives it: the same meeting (or series) whatever its id. */
  uid?: string;
}

/**
 * The meeting (or series) an event is one of: its UID, or its id without the start that the Mac, CalDAV and a calendar link put in it
 * ("mac:E1@1763290800000"). Moving such an event changes its id; this stays.
 */
const seriesOf = (e: Snap): string => (e.uid ? `uid:${e.uid}` : e.id.endsWith(`@${e.start}`) ? `id:${e.id.slice(0, -String(e.start).length - 1)}` : `own:${e.id}`);
interface State {
  /** Null before the first reading: nothing is a change until there is something to compare with. */
  events: Snap[] | null;
  log: CalChange[];
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function stateOf(v: unknown): State {
  if (!isObject(v)) return { events: null, log: [] };
  const snap = (x: unknown): Snap | null =>
    isObject(x) && typeof x.id === "string" && typeof x.title === "string" && num(x.start) !== undefined && num(x.end) !== undefined
      ? { id: x.id, title: x.title, start: x.start as number, end: x.end as number, ...(typeof x.uid === "string" && x.uid ? { uid: x.uid.slice(0, 200) } : {}) }
      : null;
  const change = (x: unknown): CalChange | null =>
    isObject(x) && (x.kind === "added" || x.kind === "moved" || x.kind === "cancelled") && typeof x.id === "string" && typeof x.title === "string"
      && num(x.start) !== undefined && num(x.at) !== undefined
      ? {
          kind: x.kind, id: x.id, title: x.title, start: x.start as number, at: x.at as number,
          ...(num(x.end) !== undefined ? { end: x.end as number } : {}), ...(num(x.was) !== undefined ? { was: x.was as number } : {}),
        }
      : null;
  return {
    events: Array.isArray(v.events) ? v.events.map(snap).filter((x): x is Snap => !!x) : null,
    log: Array.isArray(v.log) ? v.log.map(change).filter((x): x is CalChange => !!x) : [],
  };
}

/** The changes between two readings, as of `t`: only events ahead (one that started or ended is not a cancellation). */
export function diffEvents(prev: Snap[], next: Snap[], t: number): CalChange[] {
  const before = new Map(prev.map((e) => [e.id, e]));
  const now = new Map(next.map((e) => [e.id, e]));
  const out: CalChange[] = [];
  const fresh = next.filter((e) => !before.has(e.id));
  const gone = prev.filter((x) => !now.has(x.id) && x.start > t);
  const movedTo = new Map<string, Snap>();
  const paired = new Set<string>();
  // The same meeting at the same time under another id: two sources hold it (this Mac's calendar and a calendar link, Zoho and a link) and
  // the copy the reading kept changed (a link that reads fewer days ahead, a source that failed once). Nothing happened to it. The same as
  // the reading's own rule (src/calendar.ts): its UID, or its title, within a minute.
  const sameTitle = (a: Snap, b: Snap): boolean => a.title.trim().toLowerCase() === b.title.trim().toLowerCase();
  for (const e of gone) {
    const same = fresh.find((n) => !movedTo.has(n.id) && Math.abs(n.start - e.start) < SAME_MS && ((!!e.uid && e.uid === n.uid) || sameTitle(e, n)));
    if (same) {
      movedTo.set(same.id, e);
      paired.add(e.id);
    }
  }
  // An event whose id carries its start gets a new id when it moves: gone under the old one, new under the other. Paired by meeting, the
  // nearest pairs first (two changes in one series are each paired with their own), that is a move, never a cancellation and a new event: a
  // single event anywhere; a series' occurrence within the week, or anywhere before the last one the snapshot had (one after it may be the
  // next one only coming into the window).
  const count = (list: Snap[], k: string): number => list.filter((x) => seriesOf(x) === k).length;
  const last = new Map<string, number>();
  for (const e of prev) last.set(seriesOf(e), Math.max(last.get(seriesOf(e)) ?? -Infinity, e.start));
  const pairs: { e: Snap; n: Snap; d: number }[] = [];
  for (const e of gone.filter((x) => !paired.has(x.id))) {
    const k = seriesOf(e);
    const single = count(prev, k) === 1 && count(next, k) === 1;
    for (const n of fresh) {
      if (seriesOf(n) === k && !movedTo.has(n.id) && (single || n.start < t + ADDED_MS || n.start <= last.get(k)!)) pairs.push({ e, n, d: Math.abs(n.start - e.start) });
    }
  }
  for (const { e, n } of pairs.sort((a, b) => a.d - b.d)) {
    if (paired.has(e.id) || movedTo.has(n.id)) continue;
    movedTo.set(n.id, e);
    paired.add(e.id);
  }
  for (const e of next) {
    const old = before.get(e.id) ?? movedTo.get(e.id);
    if (!old) {
      // New within the week: one that only came into the two weeks' window (a repeating meeting's next one) was there all along.
      if (e.start > t && e.start < t + ADDED_MS) out.push({ kind: "added", id: e.id, title: e.title, start: e.start, end: e.end, at: t });
    } else if (Math.abs(old.start - e.start) >= SAME_MS && (e.start > t || old.start > t)) {
      out.push({ kind: "moved", id: e.id, title: e.title, start: e.start, end: e.end, was: old.start, at: t });
    }
  }
  for (const e of prev) {
    if (!now.has(e.id) && !paired.has(e.id) && e.start > t) out.push({ kind: "cancelled", id: e.id, title: e.title, start: e.start, end: e.end, at: t });
  }
  return out;
}

export function createCalendarChanges(d: {
  kv: Kv | null;
  /** The events; `partial` when some calendar could not be read this time (src/calendar.ts readAll). */
  read: () => Promise<CalEvent[] | { events: CalEvent[]; partial: boolean }>;
  now?: () => number;
  /** Told of each reading's changes (the follow-ups move or close what was tied to a meeting). */
  onChange?: (changes: CalChange[]) => Promise<unknown>;
}) {
  const now = d.now ?? Date.now;
  let memory: State = { events: null, log: [] };
  let chain: Promise<unknown> = Promise.resolve();
  const load = async (): Promise<State> => {
    if (!d.kv) return structuredClone(memory);
    const raw = await readJsonRecord(d.kv, CALENDAR_CHANGES_KEY);
    try {
      return raw ? stateOf(raw) : { events: null, log: [] };
    } catch {
      /* not JSON: nothing known yet */
      return { events: null, log: [] };
    }
  };
  const save = async (s: State): Promise<void> => {
    memory = s;
    if (d.kv) await d.kv.set(CALENDAR_CHANGES_KEY, JSON.stringify(s), 30 * 24 * 3600);
  };

  /** One reading compared with the last: what changed is logged, and passed on. The changes found (none on the first reading). */
  const tick = (): Promise<CalChange[]> => {
    const run = chain.then(async (): Promise<CalChange[]> => {
      const t = now();
      let read: CalEvent[];
      let partial = false;
      try {
        const got = await d.read();
        read = Array.isArray(got) ? got : got.events;
        partial = !Array.isArray(got) && got.partial;
      } catch (err) {
        log.error(`the calendar could not be read for its changes: ${(err as Error).message}`);
        return [];
      }
      // Events on the calendar itself (one known only from an invitation mail is not there yet), ahead, within the window.
      const next: Snap[] = read
        .filter((e) => !e.invited && e.end > t && e.start < t + WINDOW_MS && e.response !== "declined")
        .slice(0, SNAP_MAX)
        .map((e) => ({ id: e.id, title: e.title.slice(0, 200), start: e.start, end: e.end, ...(e.uid ? { uid: e.uid.slice(0, 200) } : {}) }));
      const s = await load();
      const ahead = (s.events ?? []).filter((e) => e.start > t).length;
      if (!next.length && ahead >= 3) {
        log.warn(`the calendar came back empty with ${ahead} events ahead before: not taken as cancellations`);
        return [];
      }
      // A partial first reading is no snapshot: the calendar that failed would have all its events "new" at the next one.
      if (partial && !s.events) return [];
      let changes = s.events ? diffEvents(s.events, next, t) : [];
      let snap = next;
      if (partial) {
        const gone = new Set(changes.filter((c) => c.kind === "cancelled").map((c) => c.id));
        changes = changes.filter((c) => c.kind !== "cancelled");
        snap = [...next, ...(s.events ?? []).filter((e) => gone.has(e.id))];
      }
      const kept = [...s.log.filter((c) => t - c.at < KEEP_MS), ...changes].slice(-LOG_MAX);
      await save({ events: snap, log: kept });
      if (changes.length && d.onChange) await d.onChange(changes).catch((err: Error) => log.error(`the changes could not be passed on: ${err.message}`));
      return changes;
    });
    chain = run.catch(() => undefined);
    return run;
  };

  /** What changed since `since` (the last brief), oldest first; a change undone since (moved back) is still listed as it happened. */
  const since = async (t: number): Promise<CalChange[]> => (await load()).log.filter((c) => c.at > t);

  return { tick, since };
}

export type CalendarChanges = ReturnType<typeof createCalendarChanges>;
