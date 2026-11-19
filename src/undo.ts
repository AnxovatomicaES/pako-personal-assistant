// What the assistant changed by itself in the owner's notes, reminders, lists and tasks (its <remember>, <forget>, <remind>, <unremind>, <list>,
// <task> and <done> tags), as the server saw it happen. The owner never confirms these tags, so after each answer that changed something they get a receipt written here, from
// what really changed (not from what Claude says it did), with one Undo button; pressing it puts back exactly what that answer changed.
// UNDO typed undoes the latest change of the last day; typed again, it says that one was undone already (an older change has its own
// button: a second typed word, or a press followed by a typed word, must never undo something else).
//
// A change is recorded the moment it is made (an answer's notes, before its reply comes): a restart in between may lose a card, never what
// UNDO undoes. An undo that cannot put everything back (no room for a note) keeps what is missing, so the same button brings it back later.
//
// The journal is one key in the store: the last 30 entries, a week at most. Writes are one at a time and never start from a copy that could not
// be read: when the store does not answer, a new entry is kept in this process only (and joined to the record once it reads again), it never
// overwrites the record with an empty one.

import { randomBytes } from "node:crypto";
import { locale, texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import { factOf, type Fact } from "./memory-facts.ts";
import { dayText, itemOf, taskOf } from "./lists.ts";
import type { Item, Task } from "./lists.ts";
import type { Note } from "./voice-memory.ts";
import { personOf, personReceipt, quotePerson, type Person } from "./people.ts";
import type { SavedRoutine, SavedWatch } from "./routines.ts";
import type { ClosedLoop } from "./followups/types.ts";
import { createLog } from "./log.ts";

const log = createLog("undo");

/** How a reminder repeats: after it fires, the next one is set by the server (src/whatsapp.ts nextRepeat). */
export type Every = "day" | "weekday" | "week" | "month" | "year";
export const EVERY: readonly Every[] = ["day", "weekday", "week", "month", "year"];
export const isEvery = (v: unknown): v is Every => typeof v === "string" && (EVERY as readonly string[]).includes(v);

export interface SavedReminder {
  id: string;
  at: number;
  text: string;
  /** A repeating one: how often, and its first time as written ("2026-01-31 09:00": the day of the month and the hour every next one keeps). */
  every?: Every;
  anchor?: string;
  /** A person's yearly birthday reminder (src/people.ts): kept with that person, not counted among the owner's own reminders. */
  birthday?: true;
}

/** One change, with what it takes to put it back exactly: the note or reminder as it was kept, with its own date. */
export type Change =
  | { kind: "note-added"; note: Note }
  | { kind: "notes-forgotten"; notes: Note[] }
  | { kind: "reminder-added"; reminder: SavedReminder }
  | { kind: "reminders-removed"; reminders: SavedReminder[] }
  | { kind: "items-added"; list: string; items: Item[] }
  | { kind: "items-removed"; list: string; items: Item[] }
  | { kind: "task-added"; task: Task }
  | { kind: "tasks-done"; tasks: Task[] }
  // The people in the owner's life (src/people.ts): each record as it was, so an undo puts back exactly that.
  | { kind: "person-added"; person: Person }
  | { kind: "person-changed"; before: Person; after: Person }
  | { kind: "person-removed"; person: Person }
  // What the owner told about a person forgotten (src/memory-facts.ts): put back with them.
  | { kind: "facts-forgotten"; facts: Fact[] }
  // A routine or a watch the assistant's <routine> or <watch> tag made (src/routines.ts): undone by removing it.
  | { kind: "routine-added"; routine: SavedRoutine }
  | { kind: "watch-added"; watch: SavedWatch }
  // Follow-ups the owner said in the chat were handled (src/followups/owner.ts closeByWords): undone by opening them again as they were.
  | { kind: "loops-closed"; loops: ClosedLoop[] }
  // A promise the owner made in the chat, kept as their follow-up (src/followups/matching.ts fromChat): undone by dropping it.
  | { kind: "loop-added"; loop: { id: string; title: string; dueAt?: number } }
  // A change the Mac app made to the calendar (src/calendar-writes.ts): undone by the write that puts it back (src/calendar-writes.ts undoOf).
  | { kind: "calendar-written"; write: { id: string; op: "move" | "create" | "delete"; title: string; start?: number; was?: number } };

export interface UndoEntry {
  /** 10 lowercase hex characters: the Undo button carries it (u1:<id>). */
  id: string;
  at: number;
  changes: Change[];
  /** The bridge's key of the answer these changes belong to: its reply, on whichever copy of the server it comes, joins this entry. */
  key?: string;
  /** Its receipt went (a card, or kept for the owner's next message): a reply that comes later starts a receipt of its own. */
  carded?: boolean;
  /** When a receipt kept for later reached the owner: UNDO typed counts its day from then. */
  shownAt?: number;
  undoneAt?: number;
  /** The press or message that undid it: the same one delivered again, even after a restart, does not undo a second entry. */
  undoneBy?: string;
}

/** `open`: what did not come back (no room) is kept in the entry, and the same button (or UNDO) brings it back once there is room. */
export type UndoOutcome<R> = { status: "done"; entry: UndoEntry; result: R; open: boolean } | { status: "already" | "gone" | "none" };

/**
 * What one undo did: the result for the owner's answer; `left`, the changes that could not be put back for lack of room (they stay in the entry);
 * `changed`, whether anything changed at all (an undo that found nothing to do stays open: a later press tries again, as the notes and
 * reminders may have changed by then).
 */
export interface Reversal<R> {
  result: R;
  left: Change[];
  changed: boolean;
}

const KEY = "assistant-undo";
const KEEP = 30;
/** How long a receipt's button keeps working. */
export const UNDO_KEEP_MS = 7 * 24 * 3600_000;
/** What UNDO typed reaches back to: the latest change, if it is this recent (counted from when its receipt reached the owner). */
export const UNDO_RECENT_MS = 24 * 3600_000;
/** The bridge's key for an answer: the id of the message it answers (WhatsApp's own ids may carry + / =, base64). */
export const UNDO_KEY = /^[A-Za-z0-9_.:@+/=-]{1,120}$/;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";
// A note's number comes back with it (src/voice-memory.ts): an undo after a restart still puts a note back under its own number.
const noteOf = (v: unknown): Note | null =>
  isObject(v) && typeof v.text === "string" && typeof v.at === "number"
    ? { at: v.at, text: v.text, ...(typeof v.id === "number" && Number.isInteger(v.id) && v.id > 0 ? { id: v.id } : {}) }
    : null;
const reminderOf = (v: unknown): SavedReminder | null =>
  isObject(v) && typeof v.id === "string" && typeof v.at === "number" && typeof v.text === "string"
    ? {
        id: v.id, at: v.at, text: v.text, ...(isEvery(v.every) && typeof v.anchor === "string" ? { every: v.every, anchor: v.anchor } : {}),
        ...(v.birthday === true ? { birthday: true as const } : {}),
      }
    : null;
const routineOf = (v: unknown): SavedRoutine | null =>
  isObject(v) && typeof v.id === "string" && typeof v.text === "string" && isEvery(v.every) && typeof v.next === "number"
    ? { id: v.id, text: v.text, every: v.every, next: v.next }
    : null;
const watchOf = (v: unknown): SavedWatch | null =>
  isObject(v) && typeof v.id === "string" && typeof v.text === "string" && (v.on === "mail" || v.on === "calendar" || v.on === "slack")
    ? { id: v.id, text: v.text, on: v.on, once: v.once !== false }
    : null;
const all = <T>(v: unknown, of: (x: unknown) => T | null): T[] | null => {
  const list = Array.isArray(v) ? v.map(of) : [];
  return list.length && list.every((x) => x !== null) ? (list as T[]) : null;
};

/** A change as the store gave it back, or null when it is not one (the record is checked, not trusted). */
function changeOf(v: unknown): Change | null {
  if (!isObject(v)) return null;
  if (v.kind === "note-added") {
    const note = noteOf(v.note);
    return note && { kind: "note-added", note };
  }
  if (v.kind === "notes-forgotten") {
    const notes = all(v.notes, noteOf);
    return notes && { kind: "notes-forgotten", notes };
  }
  if (v.kind === "reminder-added") {
    const reminder = reminderOf(v.reminder);
    return reminder && { kind: "reminder-added", reminder };
  }
  if (v.kind === "reminders-removed") {
    const reminders = all(v.reminders, reminderOf);
    return reminders && { kind: "reminders-removed", reminders };
  }
  if ((v.kind === "items-added" || v.kind === "items-removed") && typeof v.list === "string" && v.list) {
    const items = all(v.items, itemOf);
    return items && { kind: v.kind, list: v.list, items };
  }
  if (v.kind === "task-added") {
    const task = taskOf(v.task);
    return task && { kind: "task-added", task };
  }
  if (v.kind === "tasks-done") {
    const tasks = all(v.tasks, taskOf);
    return tasks && { kind: "tasks-done", tasks };
  }
  if (v.kind === "person-added" || v.kind === "person-removed") {
    const person = personOf(v.person);
    return person && { kind: v.kind, person };
  }
  if (v.kind === "facts-forgotten") {
    const facts = all(v.facts, factOf);
    return facts && { kind: "facts-forgotten", facts };
  }
  if (v.kind === "person-changed") {
    const before = personOf(v.before);
    const after = personOf(v.after);
    return before && after && { kind: "person-changed", before, after };
  }
  if (v.kind === "calendar-written") {
    const w = v.write;
    return isObject(w) && typeof w.id === "string" && typeof w.title === "string" && (w.op === "move" || w.op === "create" || w.op === "delete")
      ? {
          kind: "calendar-written",
          write: { id: w.id, op: w.op, title: w.title, ...(typeof w.start === "number" ? { start: w.start } : {}), ...(typeof w.was === "number" ? { was: w.was } : {}) },
        }
      : null;
  }
  if (v.kind === "loop-added") {
    const x = v.loop;
    return isObject(x) && typeof x.id === "string" && typeof x.title === "string"
      ? { kind: "loop-added", loop: { id: x.id, title: x.title, ...(typeof x.dueAt === "number" ? { dueAt: x.dueAt } : {}) } }
      : null;
  }
  if (v.kind === "loops-closed") {
    const loops = all(v.loops, (x): ClosedLoop | null =>
      isObject(x) && typeof x.id === "string" && typeof x.title === "string" && typeof x.status === "string" && typeof x.nextCheckAt === "number"
        ? { id: x.id, title: x.title, status: x.status as ClosedLoop["status"], nextCheckAt: x.nextCheckAt }
        : null);
    return loops && { kind: "loops-closed", loops };
  }
  if (v.kind === "routine-added") {
    const routine = routineOf(v.routine);
    return routine && { kind: "routine-added", routine };
  }
  if (v.kind === "watch-added") {
    const watch = watchOf(v.watch);
    return watch && { kind: "watch-added", watch };
  }
  return null;
}

function entryOf(v: unknown): UndoEntry | null {
  if (!isObject(v) || typeof v.id !== "string" || !/^[0-9a-f]{10}$/.test(v.id) || typeof v.at !== "number") return null;
  const changes = all(v.changes, changeOf);
  if (!changes) return null;
  return {
    id: v.id,
    at: v.at,
    changes,
    ...(typeof v.key === "string" && UNDO_KEY.test(v.key) ? { key: v.key } : {}),
    ...(v.carded === true ? { carded: true } : {}),
    ...(typeof v.shownAt === "number" ? { shownAt: v.shownAt } : {}),
    ...(typeof v.undoneAt === "number" ? { undoneAt: v.undoneAt } : {}),
    ...(typeof v.undoneBy === "string" ? { undoneBy: v.undoneBy } : {}),
  };
}

/** From when UNDO typed counts an entry's day: when its receipt reached the owner, if it was kept for later. */
const seenAt = (e: UndoEntry): number => e.shownAt ?? e.at;

export function createUndoJournal(kv: Kv | null, now: () => number = Date.now) {
  let entries: UndoEntry[] | null = null;
  /** Entries kept while the store could not be read: never written over the record, joined to it when it reads again. */
  const unsaved: UndoEntry[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
  const recent = (list: UndoEntry[]): UndoEntry[] => list.filter((e) => now() - e.at < UNDO_KEEP_MS).slice(-KEEP);
  const parse = (raw: string | null): UndoEntry[] => {
    let parsed: unknown = [];
    try {
      parsed = raw ? JSON.parse(raw) : [];
    } catch {
      log.error("the stored journal is not valid JSON: starting again");
    }
    return (Array.isArray(parsed) ? parsed : []).map(entryOf).filter((e): e is UndoEntry => e !== null);
  };
  /** Joins entries to a list, those it has already kept as they are, oldest first. */
  const joined = (list: UndoEntry[], more: UndoEntry[]): UndoEntry[] => {
    const ids = new Set(list.map((e) => e.id));
    return recent([...list, ...more.filter((e) => !ids.has(e.id))].sort((a, b) => a.at - b.at));
  };
  /** Throws when the store does not answer: an empty journal in its place would be written over the real one. */
  const load = async (): Promise<UndoEntry[]> => {
    if (entries) return entries;
    const raw = kv ? await kv.get(KEY) : null;
    if (entries) return entries;
    entries = joined(parse(raw), unsaved.splice(0));
    return entries;
  };
  /**
   * The record as the store holds it now, joined to this process's: another copy of the server (one that stopped in a restart, or the other
   * one during a deploy) may have recorded an answer's notes since this one read it. Throws when the store does not answer.
   */
  const reread = async (): Promise<UndoEntry[]> => {
    const raw = kv ? await kv.get(KEY) : null;
    entries = joined(entries ?? [], parse(raw));
    return entries;
  };
  /** The entry an answer's changes are joined to: its key's latest whose receipt has not gone and that was not undone. */
  const openFor = (list: UndoEntry[], key: string): UndoEntry | undefined => list.filter((e) => e.key === key && !e.carded && !e.undoneAt).at(-1);
  /** In this process at once (a store that did not take it is said in the log): the next write that works carries it. */
  const save = async (list: UndoEntry[]): Promise<void> => {
    entries = recent(list);
    try {
      if (kv) await kv.set(KEY, JSON.stringify(entries), UNDO_KEEP_MS / 1000);
    } catch (err) {
      log.error(`the journal could not be saved (kept in this process): ${(err as Error).message}`);
    }
  };

  const fresh = (changes: Change[], o: { key?: string; carded?: boolean }): UndoEntry => ({
    id: randomBytes(5).toString("hex"),
    at: now(),
    changes,
    ...(o.key && UNDO_KEY.test(o.key) ? { key: o.key } : {}),
    ...(o.carded ? { carded: true } : {}),
  });
  /** Keeps a new entry, in the store when it answers, otherwise in this process (joined to the record once it reads again). */
  const keep = async (entry: UndoEntry): Promise<void> => {
    let list: UndoEntry[];
    try {
      list = await load();
    } catch (err) {
      log.error(`the journal could not be read (this entry is kept in this process): ${(err as Error).message}`);
      unsaved.push(entry);
      if (unsaved.length > KEEP) unsaved.shift();
      return;
    }
    await save([...list, entry]);
  };

  return {
    /**
     * Keeps what one answer changed and gives its entry (with the id for the button), even when the store does not answer. `key`: the
     * answer's (its reply joins this entry); `carded`: its receipt goes now.
     */
    record: (changes: Change[], o: { key?: string; carded?: boolean } = {}): Promise<UndoEntry> =>
      locked(async () => {
        const entry = fresh(changes, o);
        await keep(entry);
        return entry;
      }),
    /**
     * Joins `changes` to the entry of the answer `key` names whose receipt has not gone yet (this process's, or, with `look`, one another copy
     * of the server recorded: the store is read again for it). With `card`, its receipt goes now: the entry is marked so. A new entry when
     * there is none and there are changes; null when there is neither. Never throws: a store that cannot be read leaves this process's.
     */
    join: (key: string, changes: Change[], o: { card: boolean; look: boolean }): Promise<UndoEntry | null> =>
      locked(async () => {
        let list: UndoEntry[] | null = null;
        try {
          list = await load();
        } catch (err) {
          log.error(`the journal could not be read: ${(err as Error).message}`);
        }
        let entry = openFor(list ?? [], key) ?? openFor(unsaved, key);
        if (!entry && list && o.look) {
          try {
            list = await reread();
            entry = openFor(list, key);
          } catch (err) {
            log.error(`the journal could not be read again: ${(err as Error).message}`);
          }
        }
        if (!entry) {
          if (!changes.length) return null;
          const made = fresh(changes, { key, carded: o.card });
          await keep(made);
          return made;
        }
        entry.changes.push(...changes);
        if (o.card) entry.carded = true;
        if (list && list.includes(entry)) await save(list);
        return entry;
      }),
    /** A receipt kept for later reached the owner now: UNDO typed counts its day from now. Never throws. */
    shown: (id: string, at: number): Promise<void> =>
      locked(async () => {
        let list: UndoEntry[] | null = null;
        try {
          list = await load();
        } catch (err) {
          log.error(`the journal could not be read: ${(err as Error).message}`);
        }
        const entry = (list ?? unsaved).find((e) => e.id === id);
        if (!entry) return;
        entry.shownAt = at;
        if (list) await save(list);
      }),
    /**
     * Puts back one entry: the one a button names, or (`within`) the latest that is that recent, whatever its state: undone already, a
     * second UNDO typed says so (it never reaches back to an older change, which has its own button). `revert` runs once per entry, one
     * undo at a time. The entry counts as undone only when everything came back: an undo that failed half way can be pressed again (each step
     * of it finds what is already back and leaves it); what found no room stays in the entry, alone, for the same button; and an undo that
     * found nothing to do stays open (what it named may come back later). Throws when the store cannot say which entry it is.
     */
    undo: <R>(which: { id: string } | { within: number }, by: string, revert: (e: UndoEntry) => Promise<Reversal<R>>): Promise<UndoOutcome<R>> =>
      locked(async (): Promise<UndoOutcome<R>> => {
        let list: UndoEntry[] | null = null;
        let failure: unknown = null;
        try {
          list = await load();
        } catch (err) {
          failure = err;
        }
        const pool = list ?? unsaved;
        const t = now();
        if (by && pool.some((e) => e.undoneBy === by)) return { status: "already" };
        const entry = "id" in which
          ? pool.find((e) => e.id === which.id)
          : pool.filter((e) => t - seenAt(e) < which.within).sort((a, b) => seenAt(a) - seenAt(b)).at(-1);
        if (!entry) {
          if (list === null) throw failure;
          return { status: "id" in which ? "gone" : "none" };
        }
        if (t - entry.at >= UNDO_KEEP_MS) return { status: "gone" };
        if (entry.undoneAt) return { status: "already" };
        const { result, left, changed } = await revert(entry);
        if (left.length) entry.changes = left;
        else if (changed) entry.undoneAt = t;
        if (by) entry.undoneBy = by;
        if (list) await save(list);
        return { status: "done", entry, result, open: left.length > 0 };
      }),
  };
}

export type UndoJournal = ReturnType<typeof createUndoJournal>;

// ---------- what the owner reads ----------

// In English like all of Pako's own texts; each function still takes a language last, and ignores it.
const T = texts(
  {
    quoted: "“{s}”",
    noteAdded: "📝 Noted: {q}",
    noteForgotten: "🗑️ Deleted the note {q}",
    reminderAdded: "⏰ Reminder: {when} · {q}",
    reminderRemoved: "🗑️ Removed the reminder {q}",
    changed: "Here's what I changed:",
    moreChange: "…and {n} more change.",
    moreChanges: "…and {n} more changes.",
    removedReminder: "removed the reminder {q}",
    restoredReminder: "put back the reminder {q} ({when})",
    restoredNote: "put back the note {q}",
    removedNote: "removed the note {q}",
    pastReminder: "the reminder {q} did not come back: its time has passed",
    fullReminder: "the reminder {q} did not come back: there is no room for more reminders",
    fullNote: "the note {q} did not come back: there is no room for more notes",
    more: "…and {n} more",
    couldNot: "↩️ I couldn't undo it:",
    nothing: "↩️ Nothing to undo: it was already as before.",
    undoneOne: "↩️ Undone: {what}.",
    undoneMany: "↩️ Undone:",
    nothingSummary: "nothing to undo (it was already as before)",
    sentReminder: "the reminder {q} ({when}) was no longer pending: it has already gone off",
    changedReminder: "the reminder {q} ({when}) was no longer pending: it was changed or deleted since",
    samePending: "{q} ({when}) is still pending: if you don't want it either, tell me and I'll remove it",
    nothingBut: "↩️ Nothing to undo:",
    nothingButSummary: "nothing to undo: {gone}",
    makeRoom: "Make room (ask me to delete something) and press Undo again to get it back.",
    day: "every day",
    weekday: "every weekday",
    week: "every week",
    month: "every month",
    year: "every year",
    repeats: " ({every})",
    itemsAdded: "🛒 Added to the {list} list: {items}",
    itemsRemoved: "🗑️ Removed from the {list} list: {items}",
    taskAdded: "✅ Task: {q}{due}",
    taskDue: " · for {day}",
    taskDone: "☑️ Done: {q}",
    loopClosed: "☑️ Follow-up closed: {q}",
    calMoved: "📅 Moved {q} to {when}",
    calCreated: "📅 Added {q}, {when}",
    calDeleted: "📅 Deleted {q} from your calendar",
    calUndone: "asked your Mac to put {q} back as it was",
    loopAdded: "📌 I'll keep an eye on it: {q}{due}",
    loopDue: " · for {when}",
    droppedLoop: "stopped following {q}",
    reopenedLoop: "opened the follow-up {q} again",
    removedItems: "removed from the {list} list: {items}",
    restoredItems: "put back on the {list} list: {items}",
    fullItems: "did not come back to the {list} list (it is full): {items}",
    removedTask: "removed the task {q}",
    reopenedTask: "reopened the task {q}",
    removedPerson: "removed {q} from your people",
    restoredPerson: "put {q} back as they were",
    fullPerson: "{q} did not come back: there is no room for more people",
    takenPerson: "{q} did not come back: you have someone else by that name now",
    routineAdded: "🔁 Routine ({every}), first on {when}: {q}",
    watchAdded: "👀 Watching {source}{once}: {q}",
    watchOnce: " (once)",
    srcMail: "your email",
    srcCalendar: "your calendar",
    srcSlack: "Slack",
    removedRoutine: "removed the routine {q}",
    removedWatch: "removed the watch {q}",
  },
);

/** Quoted, cut short: a note can be 300 characters, and a receipt must stay well inside WhatsApp's 1024 for a card. */
const quote = (l: Lang, s: string, max = 80): string => T(l)("quoted", { s: s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s });

/** "every day": how a reminder repeats, as the owner reads it. */
export const repeatText = (every: Every, l: Lang = "en"): string => T(l)(every);
/** " (every day)" after a repeating reminder's words, "" for one that does not repeat. */
const repeats = (r: SavedReminder, l: Lang): string => (r.every ? T(l)("repeats", { every: T(l)(r.every) }) : "");
/** Some items' words, quoted one by one, cut short as a whole. */
const itemWords = (l: Lang, items: { text: string }[]): string => {
  const all = items.map((x) => quote(l, x.text, 60)).join(", ");
  return all.length > 300 ? `${all.slice(0, 299).trimEnd()}…` : all;
};

/** "lun 16 nov, 09:00" ("Mon 16 Nov, 09:00" in English) in the owner's time zone. */
export function whenText(at: number, timeZone: string, l: Lang = "en"): string {
  const fields = { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
  const parts = new Intl.DateTimeFormat(locale(l), { timeZone, ...fields }).formatToParts(at);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value.replace(/\.$/, "")]));
  return `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute}`;
}

const RECEIPT_LINES = 6;

/** The receipt: one line for one change; several get a short header and a line each (a long list ends in how many more there are). */
export function receiptText(changes: Change[], timeZone: string, l: Lang = "en"): string {
  const t = T(l);
  const lines = changes.flatMap((c): string[] => {
    if (c.kind === "note-added") return [t("noteAdded", { q: quote(l, c.note.text) })];
    if (c.kind === "notes-forgotten") return c.notes.map((n) => t("noteForgotten", { q: quote(l, n.text) }));
    if (c.kind === "reminder-added") {
      return [t("reminderAdded", { when: whenText(c.reminder.at, timeZone, l), q: quote(l, c.reminder.text) }) + repeats(c.reminder, l)];
    }
    if (c.kind === "reminders-removed") return c.reminders.map((r) => t("reminderRemoved", { q: quote(l, r.text) }) + repeats(r, l));
    if (c.kind === "items-added") return [t("itemsAdded", { list: quote(l, c.list, 40), items: itemWords(l, c.items) })];
    if (c.kind === "items-removed") return [t("itemsRemoved", { list: quote(l, c.list, 40), items: itemWords(l, c.items) })];
    if (c.kind === "task-added") {
      return [t("taskAdded", { q: quote(l, c.task.text), due: c.task.due ? t("taskDue", { day: dayText(c.task.due, l) }) : "" })];
    }
    if (c.kind === "person-added") return [personReceipt("added", c.person, l)];
    if (c.kind === "person-changed") return [personReceipt("changed", c.after, l, c.before)];
    if (c.kind === "person-removed") return [personReceipt("forgotten", c.person, l)];
    if (c.kind === "facts-forgotten") return []; // part of the person's line
    if (c.kind === "routine-added") {
      return [t("routineAdded", { every: t(c.routine.every), when: whenText(c.routine.next, timeZone, l), q: quote(l, c.routine.text) })];
    }
    if (c.kind === "calendar-written") {
      const w = c.write;
      if (w.op === "move") return [t("calMoved", { q: quote(l, w.title), when: w.start ? whenText(w.start, timeZone, l) : "?" })];
      if (w.op === "create") return [t("calCreated", { q: quote(l, w.title), when: w.start ? whenText(w.start, timeZone, l) : "?" })];
      return [t("calDeleted", { q: quote(l, w.title) })];
    }
    if (c.kind === "loop-added") {
      return [t("loopAdded", { q: quote(l, c.loop.title), due: c.loop.dueAt ? t("loopDue", { when: whenText(c.loop.dueAt, timeZone, l) }) : "" })];
    }
    if (c.kind === "loops-closed") return c.loops.map((x) => t("loopClosed", { q: quote(l, x.title) }));
    if (c.kind === "watch-added") {
      const source = t(c.watch.on === "mail" ? "srcMail" : c.watch.on === "calendar" ? "srcCalendar" : "srcSlack");
      return [t("watchAdded", { source, once: c.watch.once ? t("watchOnce") : "", q: quote(l, c.watch.text) })];
    }
    return c.tasks.map((x) => t("taskDone", { q: quote(l, x.text) }));
  });
  if (lines.length === 1) return lines[0]!;
  const shown = lines.slice(0, RECEIPT_LINES);
  const more = lines.length - shown.length;
  return [t("changed"), ...shown, ...(more ? [t(more > 1 ? "moreChanges" : "moreChange", { n: more })] : [])].join("\n");
}

/** What an undo did. A note or reminder that was already as it should be (gone, or back) is in none of the lists. */
export interface Reverted {
  removedNotes: Note[];
  restoredNotes: Note[];
  removedReminders: SavedReminder[];
  restoredReminders: SavedReminder[];
  /** Reminders that did not come back: their time had passed, or there was no room for another. */
  pastReminders: SavedReminder[];
  fullReminders: SavedReminder[];
  /** Notes that did not come back: there was no room for another. */
  fullNotes: Note[];
  /** Reminders it set that were not pending any more: their time had come (sent), or they were changed or deleted since. */
  sentReminders: SavedReminder[];
  changedReminders: SavedReminder[];
  /** Pending reminders with the same words as one of those (one moved to another time): named, never left out as "as before". */
  samePending: SavedReminder[];
  /** Lists: items taken off again (an add undone), put back (a removal undone), or that found no room; per list. */
  removedItems: { list: string; items: Item[] }[];
  restoredItems: { list: string; items: Item[] }[];
  fullItems: { list: string; items: Item[] }[];
  /** Tasks: one that was added, gone again; ones marked done, open again. */
  removedTasks: Task[];
  reopenedTasks: Task[];
  /** People: one that was added, gone again; one changed or forgotten, back as it was; one that found no room, or its name taken. */
  removedPeople: Person[];
  restoredPeople: Person[];
  fullPeople: Person[];
  takenPeople: Person[];
  /** Routines and watches a tag made, gone again (src/routines.ts). Absent from an older caller: none. */
  removedRoutines?: { text: string }[];
  removedWatches?: { text: string }[];
  /** Follow-ups the chat closed, open again. Absent from an older caller: none. */
  reopenedLoops?: { title: string }[];
  /** Promises kept from the chat, dropped again. */
  droppedLoops?: { title: string }[];
  /** Calendar changes the Mac is asked to put back. */
  calendarUndone?: { title: string }[];
}

export const nothingReverted = (): Reverted => ({
  removedNotes: [], restoredNotes: [], removedReminders: [], restoredReminders: [], pastReminders: [], fullReminders: [], fullNotes: [],
  sentReminders: [], changedReminders: [], samePending: [], removedItems: [], restoredItems: [], fullItems: [], removedTasks: [], reopenedTasks: [],
  removedPeople: [], restoredPeople: [], fullPeople: [], takenPeople: [],
  removedRoutines: [], removedWatches: [],
});

const UNDONE_LINES = 8;

/** The answer to Undo (what came back, and what could not), and the same in one line for the log and the assistant's context. */
export function undoneText(r: Reverted, timeZone: string, l: Lang = "en"): { text: string; summary: string } {
  const t = T(l);
  const q = (s: string): string => quote(l, s);
  const done = [
    ...r.removedReminders.map((x) => t("removedReminder", { q: q(x.text) })),
    ...r.restoredReminders.map((x) => t("restoredReminder", { q: q(x.text), when: whenText(x.at, timeZone, l) })),
    ...r.restoredNotes.map((x) => t("restoredNote", { q: q(x.text) })),
    ...r.removedNotes.map((x) => t("removedNote", { q: q(x.text) })),
    ...r.removedItems.map((x) => t("removedItems", { list: quote(l, x.list, 40), items: itemWords(l, x.items) })),
    ...r.restoredItems.map((x) => t("restoredItems", { list: quote(l, x.list, 40), items: itemWords(l, x.items) })),
    ...r.removedTasks.map((x) => t("removedTask", { q: q(x.text) })),
    ...r.reopenedTasks.map((x) => t("reopenedTask", { q: q(x.text) })),
    ...r.removedPeople.map((x) => t("removedPerson", { q: quotePerson(l, x.name) })),
    ...r.restoredPeople.map((x) => t("restoredPerson", { q: quotePerson(l, x.name) })),
    ...(r.removedRoutines ?? []).map((x) => t("removedRoutine", { q: q(x.text) })),
    ...(r.removedWatches ?? []).map((x) => t("removedWatch", { q: q(x.text) })),
    ...(r.reopenedLoops ?? []).map((x) => t("reopenedLoop", { q: q(x.title) })),
    ...(r.droppedLoops ?? []).map((x) => t("droppedLoop", { q: q(x.title) })),
    ...(r.calendarUndone ?? []).map((x) => t("calUndone", { q: q(x.title) })),
  ];
  const full = r.fullNotes.length + r.fullReminders.length + r.fullItems.length + r.fullPeople.length > 0;
  const missed = [
    ...r.fullItems.map((x) => t("fullItems", { list: quote(l, x.list, 40), items: itemWords(l, x.items) })),
    ...r.pastReminders.map((x) => t("pastReminder", { q: q(x.text) })),
    ...r.fullReminders.map((x) => t("fullReminder", { q: q(x.text) })),
    ...r.fullNotes.map((x) => t("fullNote", { q: q(x.text) })),
    ...r.fullPeople.map((x) => t("fullPerson", { q: quotePerson(l, x.name) })),
    ...r.takenPeople.map((x) => t("takenPerson", { q: quotePerson(l, x.name) })),
  ];
  // A reminder this receipt set that is not there any more was not "as before": what became of it is said, and a pending one with the same
  // words (moved to another time) is named, so the owner knows a reminder is still coming.
  const gone = [
    ...r.sentReminders.map((x) => t("sentReminder", { q: q(x.text), when: whenText(x.at, timeZone, l) })),
    ...r.changedReminders.map((x) => t("changedReminder", { q: q(x.text), when: whenText(x.at, timeZone, l) })),
    ...r.samePending.map((x) => t("samePending", { q: q(x.text), when: whenText(x.at, timeZone, l) })),
  ];
  const cap = (lines: string[]): string[] => {
    const more = lines.length - UNDONE_LINES;
    return more > 1 ? [...lines.slice(0, UNDONE_LINES - 1), t("more", { n: more + 1 })] : lines;
  };
  const sentence = (s: string): string => `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
  const head = done.length === 0
    ? missed.length ? t("couldNot") : gone.length ? t("nothingBut") : t("nothing")
    : done.length === 1 ? t("undoneOne", { what: done[0]! }) : `${t("undoneMany")}\n${cap(done).map((s) => `• ${s}`).join("\n")}`;
  // What found no room stays in the receipt: its button brings it back once there is room (the answer carries the button too).
  const again = full ? [t("makeRoom")] : [];
  const summary = (done.length || missed.length ? [...done, ...missed, ...gone].join("; ")
    : gone.length ? t("nothingButSummary", { gone: gone.join("; ") }) : t("nothingSummary")).slice(0, 600);
  return { text: [head, ...cap([...missed, ...gone]).map(sentence), ...again].join("\n"), summary };
}
