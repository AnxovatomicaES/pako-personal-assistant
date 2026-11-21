// Apple Reminders as the owner's phone-side copy of their follow-ups (docs/features.md, "On your iPhone, through Reminders"). Off until the
// owner turns it on in the Mac app's panel (the calendar card); Reminders then carries it to the iPhone and the Watch through iCloud.
//
// The Mac app keeps two lists of its own in the default Reminders account: "Pako" (one reminder per open loop the owner owes) and, unless the
// owner turned it off here, "Pako: waiting on" (what others owe the owner). Each reminder carries its loop's id twice: as its link
// (pako://loop/<id>) and as a tag at the end of its notes. The app never reads or changes a reminder outside those two lists, nor one of
// theirs without that id (a reminder the owner added to a Pako list by hand is left alone).
//
// Like the Mac's calendars (src/calendar-local.ts), nothing is asked of the Mac from here: the app pushes what is in Pako's lists every three
// minutes and a few seconds after Reminders changes (EKEventStoreChanged), and this answers with the changes that bring them in step:
//
//   POST /panel/api/reminders/local   { on, access, lists: { owe?, waiting? }, reminders: [{ id, list, loop?, title, due, completed, modified? }] }
//                                     -> { ok, on, waiting, zone, ops: [create | update | remove] }
//   GET  /panel/api/reminders         -> { on, at, access, waiting, owe, theirs }          (the panel's card)
//   POST /panel/api/reminders/settings { waiting }                                         (the panel's "also what others owe me")
//
// Both ways, as a three-way merge against what both sides last agreed on (kept here, per loop): a side that changed since wins; when both
// changed the same thing, the newer change wins (the reminder's own modification time against the loop's last change). Completed on any device:
// the loop is Done through the same press as the Done button. Its date moved in Reminders: the loop's time moves. Pako closed it: the reminder
// is completed; parked or gone: removed; snoozed past its time: re-dated. A reminder the owner deleted is not made again. The title and notes
// only ever go from Pako to the reminder. Every answer only asks for what still differs, so a round whose changes were made answers nothing,
// and an op the Mac keeps failing (a list it cannot change) is asked for at most five times.
//
// What goes into Reminders (and so iCloud): the loop's title, its time, who and where, and the line it came from (its source and when). Never
// a message's words. Kept here under "reminders-mirror": the setting, and per loop the reminder's id and what was last agreed.

import { createHash } from "node:crypto";
import express, { type Express } from "express";
import { guard, isObject, limit, line, localOnly, type RouteAuth } from "./connect-routes.ts";
import type { Control } from "./control.ts";
import { PAST_HIDE_MS } from "./followups/limits.ts";
import { zonedTime } from "./followups/time.ts";
import type { Loop } from "./followups/types.ts";
import { locale, texts, type Lang } from "./i18n.ts";
import { readJsonRecord } from "./json-record.ts";
import type { Kv } from "./kv.ts";
import { createLog } from "./log.ts";

const log = createLog("reminders");

export const REMINDERS_KEY = "reminders-mirror";
const KEEP_SECONDS = 400 * 24 * 3600;
/** A push older than this: the app is not running, and the card says the copy may be behind. */
const STALE_MS = 30 * 60_000;
const MAX_REMINDERS = 500;
/** An op asked for this many rounds in a row without the reminder changing: not asked again until something changes. */
const MAX_TRIES = 5;
/** Two times this close are the same time (Reminders keeps minutes, not milliseconds). */
const SAME_MS = 60_000;
const LOOP_ID = /^[0-9a-f]{10}$/;

export type ListKind = "owe" | "waiting";

/** What both sides last agreed on for one loop. `gone`: the owner deleted its reminder, so it is not made again. */
export interface Agreed {
  rid: string;
  list: ListKind;
  title: string;
  due: number | null;
  /** A fingerprint of the notes Pako last wrote (the notes themselves are not kept, nor ever read back). */
  notes: string;
  done: boolean;
  at: number;
  gone?: true;
  tries?: number;
}

export interface Mirror {
  /** The owner's setting: "Pako: waiting on" too (on unless turned off). */
  waiting: boolean;
  /** The app's last word: on, and when it pushed. */
  on: boolean;
  at: number;
  access: string;
  lists: Partial<Record<ListKind, string>>;
  items: Record<string, Agreed>;
}

/** One reminder of Pako's lists, as the app pushes it (read field by field: pushOf). */
export interface Seen {
  id: string;
  list: ListKind;
  loop?: string;
  title: string;
  /** ms; a date with no time ("YYYY-MM-DD") is read as 09:00 that day in the owner's zone. */
  due: number | null;
  completed: boolean;
  modified?: number;
}

export interface Push {
  on: boolean;
  access: string;
  lists: Partial<Record<ListKind, string>>;
  reminders: Seen[];
}

export type Op =
  | { op: "create"; loop: string; list: ListKind; title: string; due: number | null; notes: string; url: string }
  | { op: "update"; id: string; loop: string; title?: string; due?: number | null; notes?: string; completed?: boolean }
  | { op: "remove"; id: string; loop: string };

/** What the reminders ask of the loops: Done (the Done button's own press), open again, or a new time. */
export type Action = { do: "done"; id: string } | { do: "reopen"; id: string } | { do: "due"; id: string; at: number | null };

export const emptyMirror = (): Mirror => ({ waiting: true, on: false, at: 0, access: "notAsked", lists: {}, items: {} });

const T = texts({
  leadRequest: "{who} asked you.",
  leadRequestAnon: "You were asked.",
  leadPromise: "You told {who} you would.",
  leadPromiseAnon: "You said you would.",
  leadMeeting: "A meeting agreed with {who}.",
  leadMeetingAnon: "A meeting you agreed.",
  leadDeadline: "A deadline.",
  leadTheirs: "{who} said they would.",
  leadTheirsAnon: "Someone said they would.",
  where: "Where: {where}",
  from: "From {label}, {when}",
  tag: "Kept in step by Pako [pako:{id}]",
  logOn: "Apple Reminders: your follow-ups are on your iPhone now ({n} reminders)",
  logOff: "Apple Reminders: no longer kept in step (Pako's lists stay in Reminders)",
  logDone: "Done in Reminders: {title}",
  logReopen: "Open again in Reminders: {title}",
  logMoved: "Moved in Reminders: {title}",
});

/** The link that names a loop in its reminder. */
export const loopUrl = (id: string): string => `pako://loop/${id}`;

const kindOf = (l: Loop): ListKind => (l.kind === "other_promise" ? "waiting" : "owe");
const sameTime = (a: number | null, b: number | null): boolean => (a === null || b === null ? a === b : Math.abs(a - b) < SAME_MS);
const print = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);
const isActive = (l: Loop): boolean => l.status === "open" || l.status === "snoozed";
const isClosed = (l: Loop): boolean => l.status === "done" || l.status === "dismissed";

/** The loop's time in Reminders: its due, or when a snooze brings it back if that is later (a snooze past its time re-dates it). */
export function dueOf(l: Loop): number | null {
  const due = l.dueAt ?? null;
  if (l.status !== "snoozed" || !l.nextCheckAt) return due;
  return due === null || l.nextCheckAt > due ? l.nextCheckAt : due;
}

/** The reminder's notes: who and where, the line it came from, and the loop's tag. Nothing of what was said beyond what the loop shows. */
export function notesOf(l: Loop, timeZone: string, lg: Lang = "en"): string {
  const t = T(lg);
  const who = l.who.trim();
  const lead = l.kind === "other_promise" ? (who ? t("leadTheirs", { who }) : t("leadTheirsAnon"))
    : l.kind === "request_to_owner" ? (who ? t("leadRequest", { who }) : t("leadRequestAnon"))
    : l.kind === "agreed_meeting" ? (who ? t("leadMeeting", { who }) : t("leadMeetingAnon"))
    : l.kind === "deadline" ? t("leadDeadline")
    : who ? t("leadPromise", { who }) : t("leadPromiseAnon");
  const s = l.sources[0];
  const when = (at: number) => new Intl.DateTimeFormat(locale(lg), { timeZone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(at);
  return [
    lead,
    l.where.label ? t("where", { where: l.where.label }) : "",
    s ? t("from", { label: s.label, when: when(s.at) }) : "",
    t("tag", { id: l.id }),
  ].filter(Boolean).join("\n");
}

/** What the app pushed, read field by field; null when it is not one. Only reminders of Pako's two lists, each with a loop's id or none. */
export function pushOf(raw: unknown, timeZone: string): Push | null {
  if (!isObject(raw) || typeof raw.on !== "boolean") return null;
  const lists: Push["lists"] = {};
  if (isObject(raw.lists)) {
    for (const k of ["owe", "waiting"] as const) {
      const id = line(raw.lists[k], 300);
      if (id) lists[k] = id;
    }
  }
  const reminders: Seen[] = [];
  const seen = new Set<string>();
  for (const r of Array.isArray(raw.reminders) ? raw.reminders : []) {
    if (reminders.length >= MAX_REMINDERS) break;
    if (!isObject(r)) continue;
    const id = line(r.id, 300);
    const list = r.list === "owe" || r.list === "waiting" ? r.list : null;
    if (!id || !list || !lists[list] || seen.has(id)) continue;
    seen.add(id);
    const loop = typeof r.loop === "string" && LOOP_ID.test(r.loop) ? r.loop : undefined;
    let due: number | null = null;
    if (typeof r.due === "number" && Number.isFinite(r.due)) due = Math.round(r.due);
    else if (typeof r.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.due)) due = zonedTime(`${r.due} 09:00`, timeZone);
    const modified = typeof r.modified === "number" && Number.isFinite(r.modified) ? r.modified : undefined;
    reminders.push({
      id, list, ...(loop ? { loop } : {}), title: line(r.title, 300), due, completed: r.completed === true, ...(modified !== undefined ? { modified } : {}),
    });
  }
  return { on: raw.on, access: line(raw.access, 20) || "notAsked", lists, reminders };
}

/** When the loop last changed on Pako's side, as near as the loop says: closed, parked, last looked at, made. */
const changedAt = (l: Loop): number => Math.max(l.createdAt, l.closedAt ?? 0, l.parkedAt ?? 0, l.checkedAt ?? 0, l.autoClosed?.at ?? 0);

/**
 * One round: the loops as they are, what was last agreed, and what the app found in Pako's lists. Gives what the loops must do (actions), what
 * the app must do (ops), and the new agreement. Pure: the route does the rest.
 */
export function reconcile(o: { loops: Loop[]; mirror: Mirror; push: Push; now: number; timeZone: string; lang?: Lang }): {
  mirror: Mirror; ops: Op[]; actions: Action[];
} {
  const { push, now } = o;
  const m: Mirror = structuredClone(o.mirror);
  m.at = now;
  m.access = push.access;
  const ops: Op[] = [];
  const actions: Action[] = [];
  if (!push.on) return { mirror: { ...m, on: false, lists: {}, items: {} }, ops, actions };
  m.on = true;
  // Without access nothing is known of the lists: nothing is changed, and nothing taken for deleted.
  if (push.access !== "granted") return { mirror: m, ops, actions };
  // A list made anew (the owner deleted Pako's list): what was agreed for the old one is gone with it.
  for (const k of ["owe", "waiting"] as const) {
    if (push.lists[k] && m.lists[k] && push.lists[k] !== m.lists[k]) for (const [id, a] of Object.entries(m.items)) if (a.list === k) delete m.items[id];
    if (push.lists[k]) m.lists[k] = push.lists[k];
  }
  const loops = new Map(o.loops.map((l) => [l.id, l]));
  // A loop's reminders: one is its own (the agreed one, else the first open one); any other one with its tag is a twin, removed.
  const byLoop = new Map<string, Seen>();
  const groups = new Map<string, Seen[]>();
  for (const r of push.reminders) if (r.loop) groups.set(r.loop, [...(groups.get(r.loop) ?? []), r]);
  for (const [id, list] of groups) {
    const rid = m.items[id]?.rid;
    const own = list.find((r) => r.id === rid) ?? list.find((r) => !r.completed) ?? list[0]!;
    byLoop.set(id, own);
    for (const r of list) if (r !== own && loops.has(id)) ops.push({ op: "remove", id: r.id, loop: id });
  }
  const ids = new Set([...Object.keys(m.items), ...byLoop.keys(), ...o.loops.filter(isActive).map((l) => l.id)]);
  for (const id of ids) {
    const l = loops.get(id);
    const r = byLoop.get(id);
    const a = m.items[id];
    // A tagged reminder of a loop this Pako never knew (another computer's, a store started again): never touched.
    if (!l && !a) continue;
    const list = l ? kindOf(l) : a!.list;
    const wanted = !!l && (list === "owe" || m.waiting) && l.status !== "parked";
    if (!wanted) {
      // Parked, gone, or a list turned off: its reminder goes, unless the owner already completed it (that one is their history now).
      if (r && !r.completed) ops.push({ op: "remove", id: r.id, loop: id });
      delete m.items[id];
      continue;
    }
    const loop = l!;
    const title = loop.title.slice(0, 200);
    const due = dueOf(loop);
    const notes = notesOf(loop, o.timeZone, o.lang);
    if (r && r.list !== list) {
      // In the other list (its kind changed): removed there, made again in the right one next round.
      ops.push({ op: "remove", id: r.id, loop: id });
      delete m.items[id];
      continue;
    }
    if (!r) {
      if (a && !a.gone) {
        if (a.done || isClosed(loop)) delete m.items[id];
        // Its list was read and it is not there: the owner deleted it. Not made again (the loop itself stays as it is).
        else if (push.lists[list] && push.lists[list] === m.lists[list]) m.items[id] = { ...a, gone: true, at: now };
        continue;
      }
      if (a?.gone) {
        if (isClosed(loop)) delete m.items[id];
        continue;
      }
      const hidden = !!loop.dueAt && loop.dueAt < now - PAST_HIDE_MS;
      if (isActive(loop) && !hidden) ops.push({ op: "create", loop: id, list, title, due, notes, url: loopUrl(id) });
      continue;
    }
    // First sight of its reminder (just made, or after the agreement was lost): agreed as the reminder is, never as completed (Pako makes
    // none completed), so a completion the owner already made counts and everything else of the loop goes to the reminder. Its notes are
    // taken as made with it (they are never read back).
    const base: Agreed = a && !a.gone && a.rid === r.id
      ? { ...a }
      : { rid: r.id, list, title: r.title, due: r.due, notes: print(notes), done: false, at: now };
    const update: { title?: string; due?: number | null; notes?: string; completed?: boolean } = {};
    // Done: two values, so one side always still says what was agreed and the other is the change.
    let closed = isClosed(loop);
    if (r.completed === closed) base.done = closed;
    else if (r.completed === base.done) update.completed = closed;
    else if (r.completed && isActive(loop)) {
      actions.push({ do: "done", id });
      base.done = true;
      closed = true;
    } else if (!r.completed && loop.status === "done") {
      actions.push({ do: "reopen", id });
      base.done = false;
      closed = false;
    } else update.completed = closed;
    // The time: only while it is open (a completed reminder's date says nothing any more).
    if (!closed) {
      if (sameTime(r.due, due)) base.due = r.due;
      else if (sameTime(r.due, base.due)) update.due = due;
      else if (sameTime(due, base.due) || (r.modified ?? 0) > changedAt(loop)) {
        actions.push({ do: "due", id, at: r.due });
        base.due = r.due;
      } else update.due = due;
    }
    // The title and the notes go one way only, and only when Pako's changed since: an edit the owner made in Reminders stays.
    if (r.title === title) base.title = title;
    else if (title !== base.title) update.title = title;
    if (print(notes) !== base.notes) {
      update.notes = notes;
      // The notes are never read back (they are the owner's to add to): agreed once asked for.
      base.notes = print(notes);
    }
    base.at = now;
    const asked = Object.keys(update).length > 0;
    base.tries = asked ? (base.tries ?? 0) + 1 : 0;
    if (!base.tries) delete base.tries;
    if (asked && (base.tries ?? 0) <= MAX_TRIES) ops.push({ op: "update", id: r.id, loop: id, ...update });
    m.items[id] = base;
  }
  return { mirror: m, ops, actions };
}

/** What the reminders ask of the loops (src/followups engine): the Done button's press, open again, a new time. */
export interface RemindersLoops {
  loops: () => Promise<Loop[]>;
  done: (id: string) => Promise<unknown>;
  reopen: (id: string) => Promise<unknown>;
  moveDue: (id: string, at: number | null) => Promise<unknown>;
}

export interface RemindersStore {
  read(): Promise<Mirror>;
  write(m: Mirror): Promise<void>;
  forget(): Promise<void>;
}

export function createRemindersStore(kv: Kv): RemindersStore {
  return {
    read: async () => {
      const raw = await readJsonRecord(kv, REMINDERS_KEY);
      if (!isObject(raw) || !isObject(raw.items)) return emptyMirror();
      const m = raw as unknown as Mirror;
      return { ...emptyMirror(), ...m, waiting: m.waiting !== false, lists: isObject(m.lists) ? m.lists : {} };
    },
    write: (m) => kv.set(REMINDERS_KEY, JSON.stringify(m), KEEP_SECONDS),
    forget: () => kv.set(REMINDERS_KEY, "", 1),
  };
}

export interface RemindersPanelDeps extends RouteAuth {
  store: RemindersStore;
  /** The follow-ups engine, looked up when a push comes (null: it is not running, and the push changes nothing). */
  loops: () => RemindersLoops | null;
  timeZone: string;
  lang: () => Lang;
  control?: Control;
  now?: () => number;
}

const PATHS = ["/panel/api/reminders/local", "/panel/api/reminders", "/panel/api/reminders/settings"];

export function mountRemindersPanel(app: Express, d: RemindersPanelDeps | null): void {
  if (!d) return localOnly(app, PATHS);
  const now = d.now ?? Date.now;
  /** The owner's pause (while it cannot be known, src/control.ts says paused). */
  const paused = async (): Promise<boolean> => !!d.control && (await d.control.paused()) !== null;
  /** One round at a time: two pushes close together (a change and the timer) never merge against the same agreement. */
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <R>(fn: () => Promise<R>): Promise<R> => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };

  app.get(PATHS[1]!, guard(d, false), limit(120), async (_req, res) => {
    try {
      const m = await d.store.read();
      const open = Object.values(m.items).filter((a) => !a.done && !a.gone);
      res.json({
        on: m.on, at: m.at || null, stale: !!m.at && now() - m.at > STALE_MS, access: m.access, waiting: m.waiting,
        owe: open.filter((a) => a.list === "owe").length, theirs: open.filter((a) => a.list === "waiting").length,
      });
    } catch (err) {
      log.warn(`the reminders' record could not be read: ${(err as Error).message}`);
      res.status(503).json({ error: "store" });
    }
  });

  app.post(PATHS[2]!, guard(d, true), limit(30), express.json({ limit: "4kb" }), async (req, res) => {
    if (!isObject(req.body) || typeof req.body.waiting !== "boolean") {
      res.status(400).json({ ok: false, error: "bad" });
      return;
    }
    const waiting = req.body.waiting;
    try {
      await serial(async () => d.store.write({ ...(await d.store.read()), waiting }));
      res.json({ ok: true, waiting });
    } catch (err) {
      log.error(`the reminders' setting could not be kept: ${(err as Error).name}`);
      res.status(503).json({ ok: false, error: "store" });
    }
  });

  app.post(PATHS[0]!, guard(d, true), limit(60), express.json({ limit: "1mb" }), async (req, res) => {
    const push = pushOf(req.body, d.timeZone);
    if (!push) {
      res.status(400).json({ ok: false, error: "bad" });
      return;
    }
    try {
      const out = await serial(async () => {
        const before = await d.store.read();
        // Paused (STOP): the app's word is kept, but nothing is asked of Reminders and no loop changes. Nothing is agreed either, so after
        // RESUME the next round sees every difference and catches up.
        if (await paused()) {
          const mirror = { ...before, on: push.on, at: now(), access: push.access };
          await d.store.write(mirror);
          return { mirror, ops: [] as Op[], said: [] as string[] };
        }
        const engine = d.loops();
        // No follow-ups running (turned off, or not started yet): nothing to keep in step, and nothing taken for a change.
        if (!engine && push.on) {
          const mirror = { ...before, on: true, at: now(), access: push.access };
          await d.store.write(mirror);
          return { mirror, ops: [] as Op[], said: [] as string[] };
        }
        const loops = engine ? await engine.loops() : [];
        const r = reconcile({ loops, mirror: before, push, now: now(), timeZone: d.timeZone, lang: d.lang() });
        const say = T(d.lang());
        const titles = new Map(loops.map((l) => [l.id, l.title]));
        const said: string[] = [];
        // The loops first: when one of them cannot be changed (the store did not answer), nothing is agreed and nothing asked of the Mac,
        // so the next round sees the same difference again instead of undoing the owner's change.
        for (const a of r.actions) {
          const title = titles.get(a.id) ?? "";
          if (a.do === "done") {
            await engine!.done(a.id);
            // The press answers in words even when the loops' store could not be written: read back, a loop still open is not agreed.
            const back = (await engine!.loops()).find((l) => l.id === a.id);
            if (back && isActive(back)) throw new Error("a completion could not be kept on its loop");
            said.push(say("logDone", { title }));
          } else if (a.do === "reopen") {
            await engine!.reopen(a.id);
            said.push(say("logReopen", { title }));
          } else {
            await engine!.moveDue(a.id, a.at);
            said.push(say("logMoved", { title }));
          }
        }
        if (!before.on && push.on && push.access === "granted") said.push(say("logOn", { n: r.ops.filter((x) => x.op === "create").length }));
        if (before.on && !push.on) said.push(say("logOff"));
        await d.store.write(r.mirror);
        return { mirror: r.mirror, ops: r.ops, said };
      });
      for (const s of out.said) d.control?.log("followup", s);
      res.json({ ok: true, on: out.mirror.on, waiting: out.mirror.waiting, zone: d.timeZone, ops: out.ops });
    } catch (err) {
      log.error(`a reminders round could not be kept: ${(err as Error).message}`);
      res.status(503).json({ ok: false, error: "store" });
    }
  });
}
