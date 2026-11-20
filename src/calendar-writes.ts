// Changes to the owner's calendar, made by the Mac app with EventKit (audit A / beta-plan step 5): a move, a new event, an event called off.
// Pako never writes on its own: each one is asked on a card that says where it came from, and goes into this queue only once the owner
// presses yes. The Mac app fetches the queue every few seconds (POST /panel/api/calendar/writes, which also brings back what it did), does
// each one once, and says what was there before, so a receipt's Undo can put it back.
//
// A write's id is its idempotency key: the card's press, a retried fetch or a restart never makes the change twice. The Mac marks an event it
// creates with the write's id (its URL), and a second "create" with that id finds it instead of making another.

import express, { type Express } from "express";
import { guard, limit, type RouteAuth } from "./connect-routes.ts";
import type { Kv } from "./kv.ts";
import { createLog } from "./log.ts";
import { readJsonRecord } from "./json-record.ts";

const log = createLog("calendar");

export const CALENDAR_WRITES_KEY = "calendar-writes";
/** Sent and no answer: sent again (the Mac app restarted mid-way). */
const RESEND_MS = 2 * 60_000;
/** Never fetched: the Mac app is not running; the owner is told it did not happen. */
const EXPIRE_MS = 30 * 60_000;
const KEEP_MS = 7 * 24 * 3600_000;
/** A move or delete whose event the Mac could not find: said so, never "deleted". */
const NOT_FOUND = "it wasn't found on your Mac's calendars (deleted or moved already?)";

export type WriteOp = "move" | "create" | "delete";

export interface CalendarWrite {
  id: string;
  op: WriteOp;
  /** move, delete: the event (EventKit's identifier) and the start of the occurrence meant (a repeating event's ids are shared). */
  eventId?: string;
  at?: number;
  /** move, create: the new times. */
  start?: number;
  end?: number;
  title: string;
  location?: string;
  calendarId?: string;
  status: "queued" | "sent" | "done" | "failed";
  queuedAt: number;
  sentAt?: number;
  /** What the Mac did: the event's id now, and what was there before (a move's times, a deleted event's details). */
  result?: { eventId?: string; before?: { start: number; end: number; title?: string; calendarId?: string; location?: string } };
  error?: string;
  /** This write undoes another (its id). */
  undoOf?: string;
  /**
   * move, delete: the event as this Mac's calendar showed it when the owner said yes. What Undo puts back when the Mac's own "before" is lost:
   * a move made, the app restarted before answering, and sent again (the second try sees the new times), or a delete sent again (nothing left).
   */
  was?: { start: number; end: number; title?: string; calendarId?: string; location?: string };
  /** How many times it was sent to the Mac (more than once: the app restarted mid-way). */
  sends?: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

export function createCalendarWrites(d: {
  kv: Kv | null;
  now?: () => number;
  /** Told when a write is done or failed (the receipt, with Undo; or what went wrong). */
  onResult?: (w: CalendarWrite) => Promise<unknown>;
}) {
  const now = d.now ?? Date.now;
  let memory: CalendarWrite[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  const load = async (): Promise<CalendarWrite[]> => {
    if (!d.kv) return structuredClone(memory);
    // A store that does not answer (or a damaged record that could not be kept aside: src/json-record.ts) throws: an empty list in its
    // place would be saved over every queued write and every Undo's record.
    const v = ((await readJsonRecord(d.kv, CALENDAR_WRITES_KEY)) ?? []) as unknown;
    return Array.isArray(v) ? (v.filter((x) => isObject(x) && typeof x.id === "string" && typeof x.op === "string") as CalendarWrite[]) : [];
  };
  const save = async (list: CalendarWrite[]): Promise<void> => {
    memory = list;
    if (d.kv) await d.kv.set(CALENDAR_WRITES_KEY, JSON.stringify(list), 8 * 24 * 3600);
  };
  const locked = <R>(fn: (list: CalendarWrite[]) => Promise<R>): Promise<R> => {
    const run = chain.then(async () => {
      const list = await load();
      return fn(list);
    });
    chain = run.catch(() => undefined);
    return run;
  };

  /** Queues a write the owner said yes to; one with the same id is never queued twice. False when it was already there. */
  const enqueue = (w: Omit<CalendarWrite, "status" | "queuedAt">): Promise<boolean> =>
    locked(async (list) => {
      if (list.some((x) => x.id === w.id)) return false;
      await save([...list.filter((x) => now() - x.queuedAt < KEEP_MS), { ...w, status: "queued" as const, queuedAt: now() }].slice(-200));
      return true;
    });

  /**
   * The Mac app's round: what it did (each result once, by id) and the writes it should do now. A write never fetched in half an hour has
   * failed (the app is closed); one sent and not answered in two minutes is sent again (the Mac finds a created event by its id).
   */
  const exchange = async (results: unknown): Promise<CalendarWrite[]> => {
    const finished: CalendarWrite[] = [];
    const out = await locked(async (list) => {
      const t = now();
      for (const r of Array.isArray(results) ? results.slice(0, 50) : []) {
        if (!isObject(r) || typeof r.id !== "string") continue;
        const w = list.find((x) => x.id === r.id);
        if (!w || w.status === "done" || w.status === "failed") continue;
        if (r.ok === true) {
          const b = isObject(r.before) ? r.before : null;
          const before = b && num(b.start) !== undefined && num(b.end) !== undefined
            ? {
                start: b.start as number, end: b.end as number, ...(str(b.title, 200) ? { title: str(b.title, 200) } : {}),
                ...(str(b.calendarId, 200) ? { calendarId: str(b.calendarId, 200) } : {}), ...(str(b.location, 200) ? { location: str(b.location, 200) } : {}),
              }
            : undefined;
          const resent = (w.sends ?? 1) > 1;
          if (w.op === "delete" && !before && !(resent && w.was)) {
            // Nothing was there to delete (an older app answers ok with nothing before): it was not deleted, and there is nothing to Undo.
            Object.assign(w, { status: "failed", error: NOT_FOUND });
            finished.push(w);
            continue;
          }
          // Sent again after a restart: the first try's "before" is lost (a move now sees its new times, a delete finds nothing). What the
          // calendar showed when the owner said yes stands in, so Undo puts it back where it was.
          const reapplied = w.op === "move" && before && before.start === w.start && before.end === w.end;
          const kept = (reapplied || (w.op === "delete" && !before)) && w.was
            ? (w.op === "move" ? { start: w.was.start, end: w.was.end } : w.was)
            : before;
          Object.assign(w, { status: "done", result: { ...(str(r.eventId, 300) ? { eventId: str(r.eventId, 300) } : {}), ...(kept ? { before: kept } : {}) } });
        } else if (r.notFound === true && w.op === "delete" && (w.sends ?? 1) > 1 && w.was) {
          // The first try deleted it and the app restarted before saying so: deleted, and Undo brings it back.
          Object.assign(w, { status: "done", result: { before: w.was } });
        } else if (r.notFound === true) {
          Object.assign(w, { status: "failed", error: NOT_FOUND });
        } else {
          Object.assign(w, { status: "failed", error: str(r.error, 200) || "the Mac could not make the change" });
        }
        finished.push(w);
      }
      for (const w of list) {
        if (w.status === "queued" && t - w.queuedAt > EXPIRE_MS) {
          Object.assign(w, { status: "failed", error: "the Pako app on this Mac did not pick it up (is it open?)" });
          finished.push(w);
        }
      }
      const due = list.filter((w) => w.status === "queued" || (w.status === "sent" && t - (w.sentAt ?? 0) > RESEND_MS));
      for (const w of due) Object.assign(w, { status: "sent", sentAt: t, sends: (w.sends ?? 0) + 1 });
      await save(list);
      return due.map(({ id, op, eventId, at, start, end, title, location, calendarId }) => ({ id, op, eventId, at, start, end, title, location, calendarId }));
    });
    for (const w of finished) await d.onResult?.(w).catch((err: Error) => log.error(`a calendar write's result: ${err.message}`));
    return out as CalendarWrite[];
  };

  const get = async (id: string): Promise<CalendarWrite | null> => (await load()).find((x) => x.id === id) ?? null;

  return { enqueue, exchange, get };
}

export type CalendarWrites = ReturnType<typeof createCalendarWrites>;

/** The write that undoes a done one: a move goes back, a new event goes, a deleted event comes back. Null when it cannot be undone. */
export function undoOf(w: CalendarWrite, id: string): Omit<CalendarWrite, "status" | "queuedAt"> | null {
  if (w.status !== "done") return null;
  const b = w.result?.before;
  if (w.op === "move" && b && w.result?.eventId) {
    return { id, op: "move", eventId: w.result.eventId, at: w.start, start: b.start, end: b.end, title: w.title, undoOf: w.id };
  }
  if (w.op === "create" && w.result?.eventId) return { id, op: "delete", eventId: w.result.eventId, at: w.start, title: w.title, undoOf: w.id };
  if (w.op === "delete" && b) {
    return {
      id, op: "create", start: b.start, end: b.end, title: b.title ?? w.title, ...(b.location ? { location: b.location } : {}),
      ...(b.calendarId ? { calendarId: b.calendarId } : {}), undoOf: w.id,
    };
  }
  return null;
}

const PATHS = ["/panel/api/calendar/writes"];

/** The Mac app's route: POST { results: [...] } -> { writes: [...] }. The panel's own session and its x-pako header, like the calendar push. */
export function mountCalendarWrites(app: Express, d: (RouteAuth & { writes: CalendarWrites }) | null): void {
  if (!d) return;
  app.post(PATHS[0]!, guard(d, true), limit(120), express.json({ limit: "64kb" }), async (req, res) => {
    try {
      const writes = await d.writes.exchange(isObject(req.body) ? req.body.results : []);
      res.json({ writes });
    } catch (err) {
      log.error(`the calendar writes could not be read: ${(err as Error).message}`);
      res.status(503).json({ error: "store" });
    }
  });
}
