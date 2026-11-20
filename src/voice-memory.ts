// What the owner's voice assistant knows about the owner between calls: notes it was asked to remember, and a one-line summary of
// each recent call. Kept in the key value store (VOICE_RESULTS_URL) next to the call results, so a restart of the free web service
// does not wipe it; in memory only when no store is set.
//
// Only the owner's own line writes here (the owner's calls and the delegate the owner talks to). Nothing from a friend's call, and
// nothing from a call that was not verified (an inbound call on caller ID alone).
//
// Writes are one at a time (they read the whole record and write it back) and never start from a copy that could not be read: a store
// that does not answer makes the write fail, it does not overwrite the real record with an empty one.
//
// Each note has a short number of its own (its id), so the owner can see the notes (NOTES, the panel) and correct or delete one by
// that number. A number never moves to another note: deleting note 3 leaves 4 as 4, and the same command delivered twice finds no note 3
// rather than deleting the next one. Notes kept before there were numbers get them when they are read, in their order, the same way every
// time; the first write keeps them. (An older copy of the server that writes during a deploy drops the numbers: they are given again then.)

import { locale, texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import { createLog } from "./log.ts";
import { readJsonRecord } from "./json-record.ts";

const log = createLog("voice-memory");

/** `id`: the note's number, when it is known (an undo puts a note back under its own number when it is free). */
export type Note = { at: number; text: string; id?: number };
/** A note as the owner sees it in NOTES and the panel. */
export type NumberedNote = { id: number; at: number; text: string };

/** What correcting a note did. `changed`: someone else changed it after the panel showed it (`was` did not match), and it was left alone. */
export type EditOutcome =
  | { status: "edited"; before: NumberedNote; after: NumberedNote }
  | { status: "gone" | "same" | "empty" | "long" }
  | { status: "duplicate"; other: NumberedNote }
  | { status: "changed"; now: NumberedNote };

export interface OwnerMemory {
  notes: Note[];
  calls: { at: number; summary: string }[];
}

const KEY = "owner-memory";
export const MAX_NOTES = 60;
const MAX_CALLS = 8;
const TTL_SECONDS = 365 * 24 * 3600;
export const NOTE_MAX = 300;
/** The highest note number: far more than the notes kept in years (60 at most at a time). */
const ID_MAX = 999_999;

export interface MemoryStore {
  /** For showing in a prompt: falls back to what this process last wrote when the store does not answer. Notes come without numbers. */
  read(): Promise<OwnerMemory>;
  /**
   * Throws when the store cannot be read or written (the note is then not saved). `added` is the note as kept, or null when the same note was
   * already there; `dropped` are the oldest notes it pushed out to stay within the limit. Both are for the owner's receipt (src/undo.ts).
   */
  addNote(text: string, now?: number): Promise<OwnerMemory & { added: Note | null; dropped: Note[] }>;
  forgetNote(match: string): Promise<number>;
  /** forgetNote, giving back the notes it deleted (with their dates and numbers), so they can be put back exactly. */
  forgetNotes(match: string): Promise<Note[]>;
  /** Deletes exactly this note (the same words and date); false when it is not there any more. */
  removeNote(note: Note): Promise<boolean>;
  /**
   * Puts notes back with their own dates, each in its place, under its own number when it is free; a note already there is left alone, and
   * none is put back past the limit (`full`).
   */
  restoreNotes(notes: Note[]): Promise<{ restored: Note[]; full: Note[] }>;
  addCall(summary: string, now?: number): Promise<void>;
  /** The notes with their numbers, oldest first. Throws when the store cannot be read: a number is never shown from an old copy. */
  numbered(): Promise<NumberedNote[]>;
  /**
   * Deletes the note with this number and gives it back; null when there is none. `was`: the words the person saw; when they are not the
   * note's words now, it is left alone ("changed"). Throws when the store cannot be read or written.
   */
  removeNoteById(id: number, was?: string): Promise<NumberedNote | null | "changed">;
  /**
   * New words for the note with this number; it keeps its number and its date (so its place). `was`: the words the person saw; when they
   * are not the note's words now, it is left alone (`changed`). Throws when the store cannot be read or written.
   */
  editNote(id: number, text: string, was?: string): Promise<EditOutcome>;
}

/** The record as kept: the notes with their numbers, and the next number to give (a deleted note's number is not given to another). */
interface Stored {
  notes: NumberedNote[];
  calls: OwnerMemory["calls"];
  nextId: number;
}

const tidy = (text: string): string => text.replace(/\s+/g, " ").trim();
const plain = (n: Note): Note => ({ at: n.at, text: n.text });
const validId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= ID_MAX;
const empty = (): Stored => ({ notes: [], calls: [], nextId: 1 });

function clean(m: unknown): Stored {
  const o = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
  const list = (v: unknown, key: "text" | "summary") =>
    (Array.isArray(v) ? v : [])
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((x) => ({ at: typeof x.at === "number" ? x.at : 0, id: x.id, [key]: typeof x[key] === "string" ? (x[key] as string).slice(0, NOTE_MAX) : "" }))
      .filter((x) => (x as Record<string, unknown>)[key]);
  const raw = list(o.notes, "text") as unknown as { at: number; text: string; id: unknown }[];
  // Numbers are kept as they are (the first note with a number keeps it); a note with none, or with one another note has, gets the next one,
  // in order. The same record gives the same numbers every time it is read, so the numbers the owner was shown hold until a write keeps them.
  const taken = new Set<number>();
  for (const n of raw) if (validId(n.id)) taken.add(n.id);
  let nextId = Math.max(validId(o.nextId) ? o.nextId : 1, ...[...taken].map((i) => i + 1));
  const seen = new Set<number>();
  const notes = raw.map((n): NumberedNote => {
    if (validId(n.id) && !seen.has(n.id)) {
      seen.add(n.id);
      return { id: n.id, at: n.at, text: n.text };
    }
    return { id: nextId++, at: n.at, text: n.text };
  });
  const calls = (list(o.calls, "summary") as unknown as { at: number; summary: string }[]).map((c) => ({ at: c.at, summary: c.summary }));
  return { notes, calls, nextId };
}

/** The memory as everything before the numbers saw it: each note's words and date. */
const shown = (m: Stored): OwnerMemory => ({ notes: m.notes.map(plain), calls: m.calls.map((c) => ({ ...c })) });

export function loadMemory(kv: Kv | null): MemoryStore {
  let local: Stored = empty();
  // Strict: a store that does not answer is an error here, never an empty record.
  const readStrict = async (): Promise<Stored> => {
    if (!kv) return structuredClone(local);
    const raw = await readJsonRecord(kv, KEY);
    if (!raw) return empty();
    return clean(raw);
  };
  const write = async (m: Stored): Promise<void> => {
    if (kv) await kv.set(KEY, JSON.stringify(m), TTL_SECONDS);
    local = structuredClone(m);
  };
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
  const forgetNotes = (match: string): Promise<Note[]> =>
    locked(async () => {
      const needle = match.toLowerCase().trim();
      if (!needle) return [];
      const m = await readStrict();
      const gone = m.notes.filter((n) => n.text.toLowerCase().includes(needle));
      if (gone.length) {
        m.notes = m.notes.filter((n) => !n.text.toLowerCase().includes(needle));
        await write(m);
      }
      // With their numbers: an undo puts each back under its own.
      return gone.map((n) => ({ ...n }));
    });
  return {
    async read() {
      try {
        return shown(await readStrict());
      } catch (err) {
        log.error(`read failed: ${(err as Error).message}`);
        return shown(local);
      }
    },
    addNote(text, now = Date.now()) {
      return locked(async () => {
        const m = await readStrict();
        const t = tidy(text).slice(0, NOTE_MAX);
        const added = t && !m.notes.some((n) => same(n.text, t)) ? { id: m.nextId++, at: now, text: t } : null;
        if (added) m.notes.push(added);
        const dropped = m.notes.slice(0, Math.max(0, m.notes.length - MAX_NOTES));
        m.notes = m.notes.slice(-MAX_NOTES);
        await write(m);
        return { ...shown(m), added: added && plain(added), dropped: dropped.map(plain) };
      });
    },
    forgetNote: async (match) => (await forgetNotes(match)).length,
    forgetNotes,
    removeNote: (note) =>
      locked(async () => {
        const m = await readStrict();
        const i = m.notes.findIndex((n) => n.text === note.text && n.at === note.at);
        if (i < 0) return false;
        m.notes.splice(i, 1);
        await write(m);
        return true;
      }),
    restoreNotes: (notes) =>
      locked(async () => {
        const m = await readStrict();
        const restored: Note[] = [];
        const full: Note[] = [];
        for (const n of notes) {
          const note: Note = { at: n.at, text: tidy(n.text).slice(0, NOTE_MAX) };
          const numbered = validId(n.id);
          if (!note.text || m.notes.some((x) => same(x.text, note.text))) continue;
          if (m.notes.length >= MAX_NOTES) {
            full.push(numbered ? { ...note, id: n.id } : note);
            continue;
          }
          // Under its own number when no other note has it (a corrected note's undo gives it back its number), else under a new one.
          const id = numbered && !m.notes.some((x) => x.id === n.id) ? n.id! : m.nextId++;
          if (id >= m.nextId) m.nextId = id + 1;
          // Back where it was among the others (they are kept oldest first), so the newest notes stay the last ones.
          const i = m.notes.findIndex((x) => x.at > note.at);
          m.notes.splice(i < 0 ? m.notes.length : i, 0, { id, ...note });
          restored.push(numbered ? { ...note, id } : note);
        }
        if (restored.length) await write(m);
        return { restored, full };
      }),
    addCall(summary, now = Date.now()) {
      return locked(async () => {
        const s = summary.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX);
        if (!s) return;
        const m = await readStrict();
        m.calls = [...m.calls, { at: now, summary: s }].slice(-MAX_CALLS);
        await write(m);
      });
    },
    // After the writes queued before it: a NOTES right after a change shows the change.
    numbered: () => locked(async () => (await readStrict()).notes),
    removeNoteById: (id, was) =>
      locked(async () => {
        const m = await readStrict();
        const i = m.notes.findIndex((n) => n.id === id);
        if (i < 0) return null;
        if (was !== undefined && tidy(was) !== m.notes[i]!.text) return "changed" as const;
        const [gone] = m.notes.splice(i, 1);
        await write(m);
        return gone!;
      }),
    editNote: (id, text, was) =>
      locked(async (): Promise<EditOutcome> => {
        const t = tidy(text);
        if (!t) return { status: "empty" };
        if (t.length > NOTE_MAX) return { status: "long" };
        const m = await readStrict();
        const note = m.notes.find((n) => n.id === id);
        if (!note) return { status: "gone" };
        if (was !== undefined && tidy(was) !== note.text) return { status: "changed", now: { ...note } };
        if (note.text === t) return { status: "same" };
        const other = m.notes.find((n) => n.id !== id && same(n.text, t));
        if (other) return { status: "duplicate", other: { ...other } };
        const before = { ...note };
        note.text = t;
        await write(m);
        return { status: "edited", before, after: { ...note } };
      }),
  };
}

/** The memory as the voice prompt shows it: notes first, then the recent calls, newest last, with short dates. */
export function memoryText(m: OwnerMemory, tz: string): string {
  const day = (at: number) => new Intl.DateTimeFormat(locale(), { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(at);
  const notes = m.notes.map((n) => `- ${n.text}`);
  const calls = m.calls.map((c) => `- ${day(c.at)}: ${c.summary}`);
  return [...(notes.length ? ["Notes:", ...notes] : []), ...(calls.length ? ["Recent calls:", ...calls] : [])].join("\n");
}

// ---------- what the owner reads: NOTES and the answers to correcting or deleting a note ----------

const T = texts(
  {
    quoted: "“{s}”",
    help: "• NOTES: what I know about you, numbered (FORGET 3 deletes one; EDIT 3: text changes it)",
    none: "I don't have any notes about you yet. Whenever you want me to remember something, just tell me.",
    head: "📝 What I know about you ({n} of {max} notes, newest last):",
    one: "📝 What I know about you (1 note):",
    line: "{id}. {text} ({day})",
    lineBare: "{id}. {text}",
    foot: "To delete one: FORGET 3. To change it: EDIT 3: the new text. I tell you every change, with a button to undo it.",
    unread: "I couldn't read your notes right now. Try again in a while.",
    notChanged: "I couldn't change the note right now: it's as it was. Try again in a while.",
    gone: "I don't have a note {id}. Type NOTES to see them with their numbers.",
    deleted: "🗑️ Deleted note {id}: {q}",
    edited: "✏️ Corrected note {id}: {q}\n(Before: {was})",
    same: "Note {id} already says that.",
    empty: "Give me the new text after the colon: EDIT {id}: the new text.",
    long: "That text is too long for a note ({max} characters at most). Shorten it and send it again.",
    duplicate: "I already have that in note {other}: note {id} is as it was.",
    typed: "{body}\n(Type UNDO to undo it.)",
    logDeleted: "Note {id} deleted by you: {text}",
    logEdited: "Note {id} corrected by you: {text}",
    logDeletedPanel: "Note {id} deleted from the panel: {text}",
    logEditedPanel: "Note {id} corrected from the panel: {text}",
    contextDeleted: "The owner deleted their note “{text}”: do not note it again unless they ask.",
    contextEdited: "The owner corrected their note “{was}”: it now says “{text}”.",
  },
);

/** The owner's words about notes, in the language of Pako's own texts. */
export const noteWords = T;

/** Quoted, cut short: a receipt is a card, and WhatsApp's card text stops at 1024 characters. */
export const quoteNote = (l: Lang, s: string, max = 120): string => T(l)("quoted", { s: s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s });

/** NOTES: every note under its number, oldest first, each with the day it was kept, and how to change one. */
export function notesListText(notes: NumberedNote[], timeZone: string, l: Lang): string {
  const t = T(l);
  if (!notes.length) return t("none");
  const day = (at: number): string =>
    new Intl.DateTimeFormat(locale(l), { timeZone, day: "numeric", month: "short" }).format(at).replace(/\.$/, "");
  // A note kept with no date (an old record) has none to show.
  const lines = notes.map((n) => (n.at > 0 ? t("line", { id: n.id, text: n.text, day: day(n.at) }) : t("lineBare", { id: n.id, text: n.text })));
  const head = notes.length === 1 ? t("one") : t("head", { n: notes.length, max: MAX_NOTES });
  return [head, ...lines, "", t("foot")].join("\n");
}

/** One of the owner's note commands: see the notes, delete one, or give one new words (`text`: as typed, "" when nothing came after). */
export type NotesCommand = { kind: "list" } | { kind: "forget"; id: number } | { kind: "edit"; id: number; text: string };

/**
 * The owner's note commands, in English like every command. `command` is the message as the door compares commands (lower case, no accents,
 * punctuation as spaces); the new words of a correction come from `text`, the message as typed, after a colon ("EDIT 3: …"). With nothing
 * after the number ("EDIT NOTE 3") the answer says how; a sentence with no colon ("edit 3 photos for me") goes to the assistant as it always
 * did.
 */
export function notesCommand(text: string, command: string): NotesCommand | null {
  if (/^(notes|my notes)$/.test(command)) return { kind: "list" };
  const forget = /^(?:forget(?: note)?|delete note) (\d{1,6})$/.exec(command);
  if (forget) return { kind: "forget", id: Number(forget[1]) };
  const edit = /^\s*edit(?:\s+note)?\s*#?\s*(\d{1,6})\s*(?:[:：]\s*([\s\S]*)|[.!]?\s*$)/iu.exec(text);
  if (edit) return { kind: "edit", id: Number(edit[1]), text: (edit[2] ?? "").trim() };
  return null;
}
