// The people in the owner's life: a small record for each one the owner tells Pako about on purpose ("mi hermana Ana cumple el 14 de marzo,
// le encanta el jazz"): the name, how they relate, a birthday, what they like and a few things to remember. The assistant keeps them with its
// <person> tag; the owner reads them with PEOPLE and PERSON <name>, corrects or forgets one with a command or in the panel (on a
// computer). src/whatsapp.ts tells the owner every change with an Undo button (src/undo.ts), turns a birthday into one yearly reminder, and
// gives Claude a short list of names (the whole record only when the owner's message names that person: assistant/bridge.ts).
//
// Only the owner's own words make a record. A <person> tag written in a turn that read other people's text (an email, a forwarded message, the
// web) is held for the owner's press like every other tag (src/quarantine.ts), and an isolated run's tags are never acted on.
//
// One key in the store. Writes are one at a time (each reads the whole record and writes it back) and never start from a copy that could not
// be read: a store that does not answer makes the change fail, it never overwrites the real record with an empty one.

import { randomBytes } from "node:crypto";
import express, { type Express, type Request } from "express";
import { rateLimit } from "express-rate-limit";
import { locale, texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import { fold, today } from "./lists.ts";
import { createLog } from "./log.ts";
import { readJsonRecord } from "./json-record.ts";
import { panelGuard } from "./panel-guard.ts";

const log = createLog("people");

export interface Person {
  /** 10 lowercase hex characters: the panel and the journal name a person by it. */
  id: string;
  name: string;
  /** In the owner's words: "mi hermana", "my boss". */
  relation?: string;
  /** "MM-DD", or "YYYY-MM-DD" when the year is known. */
  birthday?: string;
  likes: string[];
  /** Things to remember about them ("her daughter starts school in September"). */
  notes: string[];
  at: number;
  updated: number;
  /** Its yearly birthday reminder's id (src/whatsapp.ts), while one is set: one per person, and it goes with the person. */
  reminder?: string;
}

/** What the owner said about someone, as a tag, a command or the panel brings it: only the parts that were said. */
export interface PersonInput {
  name: string;
  relation?: string;
  birthday?: string;
  likes?: string[];
  notes?: string[];
}

/** A correction: a field given replaces what is there ("" or [] clears it); one left out stays as it is. */
export interface PersonPatch {
  name?: string;
  relation?: string;
  birthday?: string;
  likes?: string[];
  notes?: string[];
}

const KEY = "assistant-people";
const TTL_SECONDS = 400 * 24 * 3600;
export const PEOPLE_MAX = 100;
/** The names and relations Claude is given with every context: the most recently changed first. */
export const CONTEXT_PEOPLE_MAX = 30;
export const NAME_MAX = 60;
export const RELATION_MAX = 60;
export const LIKES_MAX = 10;
export const LIKE_MAX = 80;
export const NOTES_MAX = 10;
export const NOTE_MAX = 200;
const HEX10 = /^[0-9a-f]{10}$/;

const line = (s: unknown, max: number): string => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");
const newId = (): string => randomBytes(5).toString("hex");
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";
/** Short texts, each on one line, cut, without empties or repeats (case and accents aside), the last `max` kept. */
const words = (v: unknown, max: number, len: number): string[] => {
  const out: string[] = [];
  for (const x of Array.isArray(v) ? v : []) {
    const s = line(x, len);
    if (s && !out.some((y) => fold(y) === fold(s))) out.push(s);
  }
  return out.slice(-max);
};

const daysIn = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * A birthday as kept ("MM-DD" or "YYYY-MM-DD"), or null when it is not a real day. Takes what Claude writes ("1990-03-14", "03-14",
 * "--03-14") and what the owner types (day first: "14/03", "14/3/1990", "14.03"); a dash with the day first is never guessed at.
 */
export function birthdayOf(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  let y: number | null = null;
  let m: number;
  let d: number;
  let r: RegExpExecArray | null;
  if ((r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(?:--)?(\d{1,2})-(\d{1,2})$/.exec(s))) [m, d] = [Number(r[1]), Number(r[2])];
  else if ((r = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{4}))?$/.exec(s))) [d, m, y] = [Number(r[1]), Number(r[2]), r[3] ? Number(r[3]) : null];
  else return null;
  if (m < 1 || m > 12 || d < 1) return null;
  // Without a year, the 29th of February is a real birthday; with one, only in a leap year. A year far off is not one.
  if (d > (y === null ? daysIn(2028, m) : daysIn(y, m))) return null;
  if (y !== null && (y < 1900 || y > 2100)) return null;
  const two = (n: number): string => String(n).padStart(2, "0");
  return y === null ? `${two(m)}-${two(d)}` : `${y}-${two(m)}-${two(d)}`;
}

/** "03-14" from a kept birthday. */
const monthDay = (b: string): string => b.slice(-5);

/**
 * The birthday's reminder: its first time ("YYYY-MM-DD 09:00", today when 09:00 is still ahead) and the time a yearly repeat keeps its day
 * from. Born on the 29th of February: the 28th in a year without one, and the anchor is a 29th, so a leap year has it on the day itself.
 */
export function birthdayReminder(b: string, now: number, timeZone: string, hour = "09:00"): { when: string; anchor: string } {
  const md = monthDay(b);
  const [m, d] = [Number(md.slice(0, 2)), Number(md.slice(3))];
  const day = today(now, timeZone);
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  let y = Number(day.slice(0, 4));
  const two = (n: number): string => String(n).padStart(2, "0");
  const on = (yy: number): string => `${yy}-${two(m)}-${two(Math.min(d, daysIn(yy, m)))}`;
  if (on(y) < day || (on(y) === day && hm >= hour)) y++;
  let leap = y;
  while (d === 29 && m === 2 && daysIn(leap, 2) < 29) leap++;
  return { when: `${on(y)} ${hour}`, anchor: `${leap}-${two(m)}-${two(d)} ${hour}` };
}

/** Whether today (in the owner's zone) is their birthday: the 29th of February counts on the 28th in a year without one. */
export function isBirthdayToday(p: Person, now: number, timeZone: string): boolean {
  return isBirthdayOn(p, today(now, timeZone));
}

/** Whether a date ("YYYY-MM-DD") is this person's birthday (29 February on the 28th in a year without it). */
export function isBirthdayOn(p: Person, day: string): boolean {
  if (!p.birthday) return false;
  const md = monthDay(p.birthday);
  if (day.slice(5) === md) return true;
  return md === "02-29" && day.slice(5) === "02-28" && daysIn(Number(day.slice(0, 4)), 2) === 28;
}

export const personOf = (v: unknown): Person | null => {
  if (!isObject(v) || typeof v.id !== "string" || !HEX10.test(v.id) || typeof v.at !== "number") return null;
  const name = line(v.name, NAME_MAX);
  if (!name) return null;
  const relation = line(v.relation, RELATION_MAX);
  const birthday = birthdayOf(v.birthday);
  return {
    id: v.id,
    name,
    ...(relation ? { relation } : {}),
    ...(birthday ? { birthday } : {}),
    likes: words(v.likes, LIKES_MAX, LIKE_MAX),
    notes: words(v.notes, NOTES_MAX, NOTE_MAX),
    at: v.at,
    updated: typeof v.updated === "number" ? v.updated : v.at,
    ...(typeof v.reminder === "string" && /^[0-9a-f]{1,32}$/.test(v.reminder) ? { reminder: v.reminder } : {}),
  };
};

function clean(raw: unknown): Person[] {
  const out: Person[] = [];
  for (const x of Array.isArray(raw) ? raw : []) {
    const p = personOf(x);
    if (p && !out.some((y) => y.id === p.id || fold(y.name) === fold(p.name))) out.push(p);
  }
  return out.slice(0, PEOPLE_MAX);
}

/**
 * The person a name means: the same name (case and accents aside); else, for a single word, the one person whose first name it is ("Ana"
 * for "Ana Garcia", never when two people are called Ana).
 */
export function findPerson(people: Person[], name: string): Person | undefined {
  const want = fold(line(name, NAME_MAX));
  if (!want) return undefined;
  const exact = people.find((p) => fold(p.name) === want);
  if (exact || want.includes(" ")) return exact;
  const first = people.filter((p) => fold(p.name).split(" ")[0] === want);
  return first.length === 1 ? first[0] : undefined;
}

const same = (a: Person, b: Person): boolean =>
  a.name === b.name && a.relation === b.relation && a.birthday === b.birthday && a.reminder === b.reminder
  && JSON.stringify(a.likes) === JSON.stringify(b.likes) && JSON.stringify(a.notes) === JSON.stringify(b.notes);

export type UpsertOutcome =
  | { status: "added"; after: Person }
  | { status: "changed"; before: Person; after: Person }
  | { status: "same"; after: Person }
  | { status: "full" | "empty" };

export type EditOutcome =
  | { status: "edited"; before: Person; after: Person }
  | { status: "same"; after: Person }
  | { status: "gone" | "empty" }
  | { status: "changed"; now: Person }
  | { status: "duplicate"; other: Person };

export interface PeopleStore {
  /** For showing: falls back to what this process last read or wrote when the store does not answer; `strict` throws instead. */
  read(strict?: boolean): Promise<Person[]>;
  /**
   * What the owner said about someone: a new record, or the one by that name merged (a relation or birthday given replaces the old one; likes
   * and things to remember are added, the oldest going past the limit). Throws when the store fails.
   */
  upsert(input: PersonInput, now: number): Promise<UpsertOutcome>;
  /** A correction by id. `was`: the record's `updated` as the page showed it; a record changed since is left alone ("changed"). */
  edit(id: string, patch: PersonPatch, now: number, was?: number): Promise<EditOutcome>;
  /** Forgets one (by id); null when it is not there. `was` as for edit: "changed" leaves it. */
  remove(id: string, was?: number): Promise<Person | null | "changed">;
  /** Its birthday reminder's id, set or cleared (no new `updated`: this is Pako's bookkeeping, not the owner's change). */
  link(id: string, reminder: string | undefined): Promise<Person | null>;
  /**
   * An undo: puts a record back exactly as it was (in its place when its id is there; back in the list when it went). "taken": another person
   * has its name now; "full": no room.
   */
  restore(p: Person): Promise<"restored" | "same" | "taken" | "full">;
}

export function createPeople(kv: Kv | null): PeopleStore {
  let local: Person[] = [];
  const readStrict = async (): Promise<Person[]> => {
    if (!kv) return structuredClone(local);
    const raw = await readJsonRecord(kv, KEY);
    if (!raw) return [];
    return clean(raw);
  };
  const write = async (list: Person[]): Promise<void> => {
    if (kv) await kv.set(KEY, JSON.stringify(list), TTL_SECONDS);
    local = structuredClone(list);
  };
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
  const change = <T>(fn: (list: Person[]) => { out: T; changed: boolean }): Promise<T> =>
    locked(async () => {
      const list = await readStrict();
      const { out, changed } = fn(list);
      if (changed) await write(list);
      return out;
    });

  return {
    async read(strict = false) {
      try {
        const list = await readStrict();
        local = structuredClone(list);
        return list;
      } catch (err) {
        if (strict) throw err;
        log.error(`read failed: ${(err as Error).message}`);
        return structuredClone(local);
      }
    },
    upsert: (input, now) =>
      change<UpsertOutcome>((list) => {
        const name = line(input.name, NAME_MAX);
        if (!name) return { out: { status: "empty" }, changed: false };
        const relation = line(input.relation, RELATION_MAX);
        const birthday = birthdayOf(input.birthday);
        const likes = words(input.likes, LIKES_MAX, LIKE_MAX);
        const notes = words(input.notes, NOTES_MAX, NOTE_MAX);
        const there = findPerson(list, name);
        if (!there) {
          if (list.length >= PEOPLE_MAX) return { out: { status: "full" }, changed: false };
          const p: Person = {
            id: newId(), name, ...(relation ? { relation } : {}), ...(birthday ? { birthday } : {}), likes, notes, at: now, updated: now,
          };
          list.push(p);
          return { out: { status: "added", after: structuredClone(p) }, changed: true };
        }
        const before = structuredClone(there);
        if (relation) there.relation = relation;
        if (birthday) there.birthday = birthday;
        there.likes = words([...there.likes, ...likes], LIKES_MAX, LIKE_MAX);
        there.notes = words([...there.notes, ...notes], NOTES_MAX, NOTE_MAX);
        if (same(before, there)) return { out: { status: "same", after: before }, changed: false };
        there.updated = now;
        return { out: { status: "changed", before, after: structuredClone(there) }, changed: true };
      }),
    edit: (id, patch, now, was) =>
      change<EditOutcome>((list) => {
        const p = list.find((x) => x.id === id);
        if (!p) return { out: { status: "gone" }, changed: false };
        if (was !== undefined && was !== p.updated) return { out: { status: "changed", now: structuredClone(p) }, changed: false };
        const before = structuredClone(p);
        if (patch.name !== undefined) {
          const name = line(patch.name, NAME_MAX);
          if (!name) return { out: { status: "empty" }, changed: false };
          const other = list.find((x) => x.id !== id && fold(x.name) === fold(name));
          if (other) return { out: { status: "duplicate", other: structuredClone(other) }, changed: false };
          p.name = name;
        }
        if (patch.relation !== undefined) {
          const r = line(patch.relation, RELATION_MAX);
          if (r) p.relation = r;
          else delete p.relation;
        }
        if (patch.birthday !== undefined) {
          const b = birthdayOf(patch.birthday);
          if (b) p.birthday = b;
          else delete p.birthday;
        }
        if (patch.likes !== undefined) p.likes = words(patch.likes, LIKES_MAX, LIKE_MAX);
        if (patch.notes !== undefined) p.notes = words(patch.notes, NOTES_MAX, NOTE_MAX);
        if (same(before, p)) return { out: { status: "same", after: before }, changed: false };
        p.updated = now;
        return { out: { status: "edited", before, after: structuredClone(p) }, changed: true };
      }),
    remove: (id, was) =>
      change<Person | null | "changed">((list) => {
        const i = list.findIndex((x) => x.id === id);
        if (i < 0) return { out: null, changed: false };
        if (was !== undefined && was !== list[i]!.updated) return { out: "changed", changed: false };
        const [gone] = list.splice(i, 1);
        return { out: gone!, changed: true };
      }),
    link: (id, reminder) =>
      change<Person | null>((list) => {
        const p = list.find((x) => x.id === id);
        if (!p) return { out: null, changed: false };
        if (p.reminder === reminder) return { out: structuredClone(p), changed: false };
        if (reminder) p.reminder = reminder;
        else delete p.reminder;
        return { out: structuredClone(p), changed: true };
      }),
    restore: (person) =>
      change<"restored" | "same" | "taken" | "full">((list) => {
        const p = personOf(person);
        if (!p) return { out: "same", changed: false };
        const i = list.findIndex((x) => x.id === p.id);
        const other = list.find((x) => x.id !== p.id && fold(x.name) === fold(p.name));
        if (other) return { out: "taken", changed: false };
        if (i >= 0) {
          if (same(list[i]!, p) && list[i]!.updated === p.updated) return { out: "same", changed: false };
          list[i] = p;
          return { out: "restored", changed: true };
        }
        if (list.length >= PEOPLE_MAX) return { out: "full", changed: false };
        // Back where it was among the others (kept in the order they were met).
        const j = list.findIndex((x) => x.at > p.at);
        list.splice(j < 0 ? list.length : j, 0, p);
        return { out: "restored", changed: true };
      }),
  };
}

// ---------- what the owner reads: PEOPLE, PERSON <name>, the receipts, the brief; and what Claude is given ----------

const T = texts(
  {
    quoted: "“{s}”",
    none: "I don't have anyone noted yet. Tell me about someone (“my sister Ana's birthday is 14 March”) and I'll keep it.",
    head: "👥 The people in your life ({n}):",
    line: "• {name}{relation}{birthday}",
    relation: " ({relation})",
    birthday: " · 🎂 {day}",
    foot: "Type PERSON and the name to see one in full. To change one: PERSON Ana: relation my cousin (or birthday, likes, notes, name). "
      + "To forget one: FORGET PERSON Ana.",
    card: "👤 {name}{relation}",
    cardBirthday: "🎂 Birthday: {day}",
    cardLikes: "❤️ Likes: {list}",
    cardNotes: "📝 To remember:",
    cardContact: "📞 In your contacts: {link}",
    cardFoot: "To change something: PERSON {name}: relation … (or birthday, likes, notes, name; empty clears it). To forget them: FORGET PERSON {name}.",
    unread: "I couldn't read your people right now. Try again in a while.",
    notChanged: "I couldn't change that right now: it's as it was. Try again in a while.",
    unknown: "I don't have anyone called {q}. Type PEOPLE to see who I have.",
    same: "{name} is already like that.",
    duplicate: "I already have someone else called {q}: {name} is as it was.",
    empty: "The name can't be empty.",
    badBirthday: "I didn't understand the date {q}: write it day first, like 14/03 (or 14/03/1990).",
    full: "There's no room for more people ({n} at most): forget someone (FORGET PERSON and the name) to make room.",
    typed: "{body}\n(Type UNDO to undo it.)",
    brief: "🎂 It's {list}'s birthday today",
    reminder: "🎂 It's {name}'s birthday today{relation}",
    added: "👤 Noted {q}{relation}",
    changed: "👤 Updated {q}: {what}",
    forgotten: "🗑️ Forgot {q}",
    fRelation: "relation {q}",
    fBirthday: "birthday {day}",
    fName: "now called {q}",
    fLikes: "likes {list}",
    fNotes: "to remember {list}",
    fCleared: "no {what}",
    wRelation: "relation",
    wBirthday: "birthday",
    wLikes: "likes",
    wNotes: "notes",
    logAdded: "Person noted: {name}",
    logChanged: "Person updated: {name}",
    logForgotten: "Person forgotten: {name}",
    logPanel: " (from the panel)",
    contextForgotten: "The owner forgot {name}: do not note them again unless they ask.",
    ctxRelation: "relation: {relation}",
    ctxBirthday: "birthday: {day}",
    ctxLikes: "likes: {list}",
    ctxNotes: "to remember: {list}",
    ctxContact: "is in their contacts",
  },
);
export const peopleWords = T;

const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
/** Quoted, cut short: a receipt is a card, and WhatsApp's card text stops at 1024 characters. */
export const quotePerson = (l: Lang, s: string, max = 60): string => T(l)("quoted", { s: cut(s, max) });

/** "14 mar" ("14 Mar"), with the year when it is known: "14 mar 1990". */
export function birthdayText(b: string, l: Lang = "en"): string {
  const md = monthDay(b);
  const at = Date.UTC(2028, Number(md.slice(0, 2)) - 1, Number(md.slice(3)), 12);
  const day = new Intl.DateTimeFormat(locale(l), { timeZone: "UTC", day: "numeric", month: "short" }).format(at).replace(/\.$/, "");
  return b.length > 5 ? `${day} ${b.slice(0, 4)}` : day;
}

const relationOf = (p: Person, l: Lang): string => (p.relation ? T(l)("relation", { relation: p.relation }) : "");

/** PEOPLE: everyone, by name, with how they relate and their birthday. */
export function peopleText(people: Person[], l: Lang = "en"): string {
  const t = T(l);
  if (!people.length) return t("none");
  const sorted = [...people].sort((a, b) => fold(a.name).localeCompare(fold(b.name)));
  const lines = sorted.map((p) => t("line", { name: p.name, relation: relationOf(p, l), birthday: p.birthday ? t("birthday", { day: birthdayText(p.birthday, l) }) : "" }));
  return [t("head", { n: people.length }), ...lines, "", t("foot")].join("\n");
}

/** PERSON <name>: one record whole. `link`: a wa.me link when the name is one of the owner's contacts. */
export function personText(p: Person, l: Lang = "en", link?: string): string {
  const t = T(l);
  return [
    t("card", { name: p.name, relation: relationOf(p, l) }),
    ...(p.birthday ? [t("cardBirthday", { day: birthdayText(p.birthday, l) })] : []),
    ...(p.likes.length ? [t("cardLikes", { list: p.likes.join(", ") })] : []),
    ...(p.notes.length ? [t("cardNotes"), ...p.notes.map((n) => `• ${n}`)] : []),
    ...(link ? [t("cardContact", { link })] : []),
    "",
    t("cardFoot", { name: p.name }),
  ].join("\n");
}

/** What changed between two versions of a record, in a few words for the receipt. */
export function personChanges(before: Person, after: Person, l: Lang = "en"): string {
  const t = T(l);
  const q = (s: string): string => quotePerson(l, s);
  const added = (a: string[], b: string[]): string[] => b.filter((x) => !a.some((y) => fold(y) === fold(x)));
  const out: string[] = [];
  if (before.name !== after.name) out.push(t("fName", { q: q(after.name) }));
  if (before.relation !== after.relation) out.push(after.relation ? t("fRelation", { q: q(after.relation) }) : t("fCleared", { what: t("wRelation") }));
  if (before.birthday !== after.birthday) {
    out.push(after.birthday ? t("fBirthday", { day: birthdayText(after.birthday, l) }) : t("fCleared", { what: t("wBirthday") }));
  }
  // New likes or notes are named; a list that only shrank (a correction) is named as it is now, or as cleared.
  const listChange = (a: string[], b: string[], key: "fLikes" | "fNotes", what: "wLikes" | "wNotes"): void => {
    const fresh = added(a, b);
    if (fresh.length) out.push(t(key, { list: fresh.map((x) => q(x)).join(", ") }));
    else if (b.length < a.length) out.push(b.length ? t(key, { list: b.map((x) => q(x)).join(", ") }) : t("fCleared", { what: t(what) }));
  };
  listChange(before.likes, after.likes, "fLikes", "wLikes");
  listChange(before.notes, after.notes, "fNotes", "wNotes");
  return cut(out.join("; "), 400);
}

/** The receipt's line for one change to the people (src/undo.ts receiptText). */
export function personReceipt(kind: "added" | "changed" | "forgotten", p: Person, l: Lang = "en", before?: Person): string {
  const t = T(l);
  if (kind === "added") return t("added", { q: quotePerson(l, p.name), relation: relationOf(p, l) });
  if (kind === "forgotten") return t("forgotten", { q: quotePerson(l, p.name) });
  return t("changed", { q: quotePerson(l, before?.name ?? p.name), what: before ? personChanges(before, p, l) : "" });
}

/** The words of a birthday's yearly reminder. */
export const birthdayReminderText = (p: Person, l: Lang = "en"): string =>
  cut(T(l)("reminder", { name: p.name, relation: relationOf(p, l) }), 200);

/** The brief's line for today's birthdays, or null when there is none. */
export function birthdaysBrief(people: Person[], now: number, timeZone: string, l: Lang = "en"): string | null {
  const due = people.filter((p) => isBirthdayToday(p, now, timeZone));
  if (!due.length) return null;
  return T(l)("brief", { list: cut(due.map((p) => `${p.name}${relationOf(p, l)}`).join(", "), 400) });
}

/**
 * For the assistant's context: the short list (name and relation, at most 30, the most recently changed first), and each record in full,
 * which the bridge puts in front of a message only when the message names that person.
 */
export function peopleContext(people: Person[], l: Lang = "en", inContacts: (name: string) => boolean = () => false): {
  people: string[];
  peopleRecords: { name: string; text: string }[];
} {
  const t = T(l);
  const recent = [...people].sort((a, b) => b.updated - a.updated);
  return {
    people: recent.slice(0, CONTEXT_PEOPLE_MAX).map((p) => `${p.name}${relationOf(p, l)}`),
    peopleRecords: recent.map((p) => ({
      name: p.name,
      text: cut([
        ...(p.relation ? [t("ctxRelation", { relation: p.relation })] : []),
        ...(p.birthday ? [t("ctxBirthday", { day: birthdayText(p.birthday, l) })] : []),
        ...(p.likes.length ? [t("ctxLikes", { list: p.likes.join(", ") })] : []),
        ...(p.notes.length ? [t("ctxNotes", { list: p.notes.join(" / ") })] : []),
        ...(inContacts(p.name) ? [t("ctxContact")] : []),
      ].join("; "), 800),
    })),
  };
}

/** One of the owner's people commands. `text` of an edit: as typed, after the field's word ("" clears it). */
export type PeopleCommand =
  | { kind: "list" }
  | { kind: "show"; name: string }
  | { kind: "forget"; name: string }
  | { kind: "edit"; name: string; field: "name" | "relation" | "birthday" | "likes" | "notes"; text: string };

/** The field an edit names, and the new words after it. */
const FIELD = /^(name|relation(?:ship)?|birthday|likes|notes?)(?=\s|[:=]|$)\s*[:=]?\s*([\s\S]*)$/iu;
const FIELDS: [RegExp, "name" | "relation" | "birthday" | "likes" | "notes"][] = [
  [/^name$/, "name"],
  [/^(?:relation|relationship)$/, "relation"],
  [/^birthday$/, "birthday"],
  [/^likes$/, "likes"],
  [/^(?:notes|note)$/, "notes"],
];

/**
 * The owner's people commands, in English like every command. `command` is the message as the door compares commands (lower case, no
 * accents, punctuation as spaces); an edit is read from `text`, the message as typed: "PERSON Ana: relation my cousin" (the field's word,
 * then the new words; nothing after it clears that field). "PERSON <name>" without a colon shows that person only when there is one (the
 * door checks), so "person of interest" still reaches the assistant.
 */
export function peopleCommand(text: string, command: string): PeopleCommand | null {
  if (/^(people|my people)$/.test(command)) return { kind: "list" };
  const forget = /^(?:forget person|delete person) (.{1,60})$/.exec(command);
  if (forget) return { kind: "forget", name: forget[1]! };
  const edit = /^\s*person\s+([^:：\n]{1,60}?)\s*[:：]\s*([\s\S]*)$/iu.exec(text);
  const said = edit ? FIELD.exec(edit[2]!) : null;
  if (edit && said) {
    const word = said[1]!.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ");
    const field = FIELDS.find(([re]) => re.test(word))?.[1];
    if (field) return { kind: "edit", name: edit[1]!.trim(), field, text: said[2]!.trim() };
  }
  const show = /^person (.{1,60})$/.exec(command);
  if (show) return { kind: "show", name: show[1]! };
  return null;
}

/** An edit command's words as a patch: likes and notes are separated by ";" or ","; "" clears the field. */
export function patchOf(field: "name" | "relation" | "birthday" | "likes" | "notes", text: string): PersonPatch {
  if (field === "likes") return { likes: text.split(/[;,\n]/) };
  if (field === "notes") return { notes: text.split(/[;\n]/) };
  return { [field]: text };
}

// ---------- the panel: GET /panel/api/people; on a computer, POST /panel/api/people/edit and /panel/api/people/delete ----------

/** What the door does with a change from the panel: the same reminders, receipt and Undo as a command (src/whatsapp.ts). */
export interface PeopleDoor {
  store: PeopleStore;
  edit(id: string, patch: PersonPatch, was: number): Promise<EditOutcome | { status: "bad" }>;
  forget(id: string, was: number): Promise<Person | null | "changed">;
  /** A wa.me link when the name is one of the owner's contacts. */
  contactLink(name: string): string | undefined;
}

export interface PeoplePanelDeps {
  signedIn: (req: Request) => boolean;
  people: PeopleDoor;
  /** A computer (local mode): people can be corrected and forgotten here. A server's panel only shows them. */
  local: boolean;
}


export function mountPeoplePanel(app: Express, d: PeoplePanelDeps): void {
  const reads = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false });
  const writes = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });
  // The same protection as the STOP switch: the strict session cookie, and on a change the x-pako header another site cannot send.
  const auth = panelGuard(d.signedIn, { readOnly: () => !d.local });
  app.get("/panel/api/people", auth(false), reads, async (_req, res) => {
    try {
      const list = await d.people.store.read(true);
      const people = list.map((p) => {
        const link = d.people.contactLink(p.name);
        const { reminder: _r, ...shown } = p;
        return { ...shown, ...(link ? { contact: link } : {}) };
      });
      res.json({ people, max: PEOPLE_MAX, edit: d.local });
    } catch (err) {
      log.error(`the panel could not read them: ${(err as Error).message}`);
      res.status(503).json({ error: "store" });
    }
  });
  const body = express.json({ limit: "8kb" });
  const target = (b: unknown): { id: string; was: number } | null => {
    const o = (b ?? {}) as { id?: unknown; was?: unknown };
    return typeof o.id === "string" && HEX10.test(o.id) && typeof o.was === "number" ? { id: o.id, was: o.was } : null;
  };
  app.post("/panel/api/people/edit", auth(true), writes, body, async (req, res) => {
    const t = target(req.body);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: PersonPatch = {};
    for (const k of ["name", "relation", "birthday"] as const) if (typeof b[k] === "string") patch[k] = b[k] as string;
    for (const k of ["likes", "notes"] as const) if (Array.isArray(b[k])) patch[k] = (b[k] as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 20);
    if (!t || !Object.keys(patch).length) {
      res.status(400).json({ error: "bad" });
      return;
    }
    try {
      const r = await d.people.edit(t.id, patch, t.was);
      if (r.status === "edited" || r.status === "same") {
        res.json({ ok: true, person: r.after });
        return;
      }
      const code = { gone: 404, changed: 409, duplicate: 409, empty: 400, bad: 400 }[r.status];
      res.status(code).json({ error: r.status });
    } catch (err) {
      log.error(`the panel's change was not kept: ${(err as Error).message}`);
      res.status(503).json({ error: "store" });
    }
  });
  app.post("/panel/api/people/delete", auth(true), writes, body, async (req, res) => {
    const t = target(req.body);
    if (!t) {
      res.status(400).json({ error: "bad" });
      return;
    }
    try {
      const r = await d.people.forget(t.id, t.was);
      if (!r || r === "changed") {
        res.status(r ? 409 : 404).json({ error: r ? "changed" : "gone" });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      log.error(`the panel's change was not kept: ${(err as Error).message}`);
      res.status(503).json({ error: "store" });
    }
  });
}
