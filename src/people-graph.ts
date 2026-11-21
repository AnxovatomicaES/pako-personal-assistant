// People with identities: one record per person Pako has met anywhere, with a table of their identities (email, Slack id, phone, WhatsApp,
// Telegram id, Zoom display name), the names they go by and their last contacts. The people the owner told Pako about (src/people.ts) each
// get one, linked by `personId`; Slack, the mail, the calendar's attendees and Zoom's speakers feed the rest from what Pako already reads:
// identities and names only, never what anyone wrote.
//
// Resolution, in order (the idea of Graphiti's identity properties and Zep's human review, rebuilt small):
// - an identity seen before is the same person, always (an address, a Slack id, a number);
// - a name alone never merges two records: when a new record has the name of another ("Ana Garcia" from the mail, "Ana" the owner's sister)
//   a one-line question waits ("Same person: Ana and Ana Garcia <ana@x.com>?"), asked after the brief or with a person's card, answered
//   with a button. Yes merges them (the names become trusted aliases); no is remembered and never asked again.
// Only names the owner gave or confirmed are `aliases`; names that came with an identity from someone else's mail or Slack are `seen`, shown
// on the card but never used to decide who a message goes to (src/autonomy.ts matchContacts): an outsider cannot make "Bob" mean Ana.
//
// One key in the store. Writes are one at a time and never start from a copy that could not be read.

import { randomBytes } from "node:crypto";
import { locale, texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import { fold } from "./lists.ts";
import type { Person } from "./people.ts";
import { createLog } from "./log.ts";
import { readJsonRecord } from "./json-record.ts";

const log = createLog("people-graph");

export const IDENTITY_KINDS = ["email", "slack", "phone", "whatsapp", "telegram", "zoom"] as const;
export type IdentityKind = (typeof IDENTITY_KINDS)[number];

export interface Identity {
  kind: IdentityKind;
  /** Normalised: an address in lower case, digits only for a number, a Slack id as Slack writes it, a Zoom name as shown. */
  value: string;
  /** Where Pako saw it, a stored id kept from before Pako was English only (shown through the v_ words): "slack", "correo" (mail),
   * "calendario" (calendar), "zoom", "owner". */
  source: string;
  at: number;
}

export interface GraphPerson {
  /** 10 lowercase hex characters. */
  id: string;
  name: string;
  /** Other names the owner gave or confirmed: trusted. */
  aliases: string[];
  /** Names seen with an identity in other people's mail, Slack or calendar: shown, never trusted. */
  seen: string[];
  identities: Identity[];
  /** The owner's own record of them (src/people.ts), when there is one. */
  personId?: string;
  /** The last times Pako saw them (a mail, a Slack message, a meeting), newest last. `where`: the Slack conversation's label ("Rohan (DM)",
   *  "#sales"), a place and never what was said there, so the People card can say where they last spoke. */
  contacts: { at: number; via: string; where?: string }[];
  at: number;
  updated: number;
}

export interface SameQuestion {
  id: string;
  /** The record kept (the owner's own, or the older), and the one that would merge into it. */
  a: string;
  b: string;
  at: number;
  /** When it was last put to the owner. */
  asked?: number;
}

export interface Sighting {
  name?: string;
  identities: { kind: IdentityKind; value: string }[];
  /** Where: "slack", "correo", "calendario", "zoom". */
  via: string;
  /** The Slack conversation's label, when a Slack message was the sighting. */
  where?: string;
  /** When they were seen (the mail's date, the meeting's start). */
  at: number;
}

interface Stored {
  persons: GraphPerson[];
  questions: SameQuestion[];
  /** Pairs the owner said are not the same person ("idA|idB", sorted). */
  no: string[];
}

const KEY = "people-identities";
const TTL_SECONDS = 400 * 24 * 3600;
export const GRAPH_MAX = 400;
const IDENTITIES_MAX = 20;
const NAMES_MAX = 10;
const CONTACTS_MAX = 5;
const QUESTIONS_MAX = 20;
const NO_MAX = 300;
/** A question already asked is asked again after this long without an answer. */
const ASK_AGAIN_MS = 3 * 24 * 3600_000;
export const GNAME_MAX = 60;
const HEX10 = /^[0-9a-f]{10}$/;

const line = (s: unknown, max: number): string => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");
const newId = (): string => randomBytes(5).toString("hex");
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";
const pairKey = (a: string, b: string): string => [a, b].sort().join("|");

/** An identity's value as kept, or "" when it is not one (an address that is not one, a number too short, a sender that is a machine). */
export function identityValue(kind: IdentityKind, raw: string): string {
  const s = raw.trim();
  switch (kind) {
    case "email": {
      const e = s.toLowerCase().replace(/^mailto:/, "");
      if (!/^[^\s@<>"',;]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/.test(e)) return "";
      // Machines, not people: nobody to ask about.
      return /^(?:no-?reply|do-?not-?reply|notifications?|mailer-daemon|bounces?|postmaster)\b/.test(e) ? "" : e;
    }
    case "slack":
      return /^[UW][A-Z0-9]{2,20}$/.test(s) ? s : "";
    case "phone":
    case "whatsapp":
    case "telegram": {
      const d = s.replace(/[^\d]/g, "");
      return d.length >= 5 && d.length <= 16 ? d : "";
    }
    case "zoom":
      return line(s, GNAME_MAX);
  }
}

/** "Ana Garcia <ana@x.com>" (a From line, an attendee) as a name and an address; either may be empty. */
export function splitAddress(from: string): { name: string; email: string } {
  // Read by hand, not by one pattern: a pattern with a lazy name between two runs of blanks took cubic time on a From line of blanks.
  const s = from.trim();
  if (s.endsWith(">")) {
    const open = s.lastIndexOf("<");
    const address = open >= 0 ? s.slice(open + 1, -1) : "";
    // The address: no blank or bracket, and an @ with something on each side.
    if (address.length >= 3 && !/[\s<>]/.test(address) && address.slice(1, -1).includes("@")) {
      let name = s.slice(0, open).trim();
      if (name.startsWith('"')) name = name.slice(1);
      if (name.endsWith('"')) name = name.slice(0, -1);
      if (!/["<]/.test(name)) return { name: line(name, GNAME_MAX), email: address.toLowerCase() };
    }
  }
  const bare = /^[^\s<>@]+@[^\s<>@]+$/.test(s);
  return bare ? { name: "", email: s.toLowerCase() } : { name: line(from, GNAME_MAX), email: "" };
}

const names = (p: GraphPerson): string[] => [p.name, ...p.aliases];
const trustedHas = (p: GraphPerson, name: string): boolean => names(p).some((n) => fold(n) === fold(name));
const firstWord = (s: string): string => fold(s).split(" ")[0] ?? "";

function personOf(v: unknown): GraphPerson | null {
  if (!isObject(v) || typeof v.id !== "string" || !HEX10.test(v.id) || typeof v.at !== "number") return null;
  const name = line(v.name, GNAME_MAX);
  if (!name) return null;
  const strs = (x: unknown): string[] => {
    const out: string[] = [];
    for (const y of Array.isArray(x) ? x : []) {
      const s = line(y, GNAME_MAX);
      if (s && fold(s) !== fold(name) && !out.some((z) => fold(z) === fold(s))) out.push(s);
    }
    return out.slice(-NAMES_MAX);
  };
  const identities: Identity[] = [];
  for (const x of Array.isArray(v.identities) ? v.identities : []) {
    if (!isObject(x) || !IDENTITY_KINDS.includes(x.kind as IdentityKind)) continue;
    const kind = x.kind as IdentityKind;
    const value = identityValue(kind, String(x.value ?? ""));
    if (value && !identities.some((i) => i.kind === kind && i.value === value)) {
      identities.push({ kind, value, source: line(x.source, 20) || "?", at: typeof x.at === "number" ? x.at : v.at });
    }
  }
  const contacts = (Array.isArray(v.contacts) ? v.contacts : [])
    .flatMap((c) => {
      if (!isObject(c) || typeof c.at !== "number") return [];
      const where = line(c.where, 80);
      return [{ at: c.at, via: line(c.via, 20) || "?", ...(where ? { where } : {}) }];
    })
    .slice(-CONTACTS_MAX);
  const aliases = strs(v.aliases);
  return {
    id: v.id, name, aliases, seen: strs(v.seen).filter((s) => !aliases.some((a) => fold(a) === fold(s))), identities: identities.slice(-IDENTITIES_MAX),
    ...(typeof v.personId === "string" && HEX10.test(v.personId) ? { personId: v.personId } : {}),
    contacts, at: v.at, updated: typeof v.updated === "number" ? v.updated : v.at,
  };
}

function clean(raw: unknown): Stored {
  const o = isObject(raw) ? raw : {};
  const persons: GraphPerson[] = [];
  for (const x of Array.isArray(o.persons) ? o.persons : []) {
    const p = personOf(x);
    if (p && !persons.some((y) => y.id === p.id)) persons.push(p);
  }
  const ids = new Set(persons.map((p) => p.id));
  const questions = (Array.isArray(o.questions) ? o.questions : []).flatMap((q): SameQuestion[] =>
    isObject(q) && typeof q.id === "string" && HEX10.test(q.id) && ids.has(String(q.a)) && ids.has(String(q.b)) && q.a !== q.b && typeof q.at === "number"
      ? [{ id: q.id, a: String(q.a), b: String(q.b), at: q.at, ...(typeof q.asked === "number" ? { asked: q.asked } : {}) }]
      : []);
  const no = (Array.isArray(o.no) ? o.no : []).filter((x): x is string => typeof x === "string" && /^[0-9a-f]{10}\|[0-9a-f]{10}$/.test(x));
  return { persons, questions: questions.slice(-QUESTIONS_MAX), no: no.slice(-NO_MAX) };
}

/** Adds a question "same person?" for two records, unless one is already there or the owner said no. */
function ask(s: Stored, a: GraphPerson, b: GraphPerson, now: number): void {
  if (a.id === b.id || s.no.includes(pairKey(a.id, b.id))) return;
  // Two of the owner's own people are never asked about: a merge could keep only one link, so the question would come back (PEOPLE
  // is where the owner joins them).
  if (a.personId && b.personId) return;
  if (s.questions.some((q) => pairKey(q.a, q.b) === pairKey(a.id, b.id))) return;
  // The owner's own record, or else the older one, is the one kept.
  const [keep, other] = b.personId && !a.personId ? [b, a] : a.personId && !b.personId ? [a, b] : a.at <= b.at ? [a, b] : [b, a];
  s.questions.push({ id: newId(), a: keep.id, b: other.id, at: now });
  s.questions = s.questions.slice(-QUESTIONS_MAX);
}

/** Records whose trusted name is this one, or, for a one-word name, whose first name it is (and the other way round). */
function sameName(s: Stored, p: GraphPerson): GraphPerson[] {
  return s.persons.filter((q) => {
    if (q.id === p.id) return false;
    if (names(q).some((n) => trustedHas(p, n))) return true;
    const one = (x: string): boolean => !x.includes(" ");
    return names(q).some((n) => names(p).some((m) => (one(n) && firstWord(m) === fold(n)) || (one(m) && firstWord(n) === fold(m))));
  }).slice(0, 3);
}

/** Merges `b` into `a`: every identity, name and contact; the owner's link; the questions about `b` move to `a`. */
function merge(s: Stored, a: GraphPerson, b: GraphPerson, now: number): void {
  for (const n of names(b)) if (!trustedHas(a, n)) a.aliases = [...a.aliases, n].slice(-NAMES_MAX);
  a.seen = [...new Set([...a.seen, ...b.seen])].filter((n) => !trustedHas(a, n)).slice(-NAMES_MAX);
  for (const i of b.identities) if (!a.identities.some((x) => x.kind === i.kind && x.value === i.value)) a.identities.push(i);
  a.identities = a.identities.slice(-IDENTITIES_MAX);
  a.contacts = [...a.contacts, ...b.contacts].sort((x, y) => x.at - y.at).slice(-CONTACTS_MAX);
  if (!a.personId && b.personId) a.personId = b.personId;
  a.at = Math.min(a.at, b.at);
  a.updated = now;
  s.persons = s.persons.filter((p) => p.id !== b.id);
  s.no = s.no.map((k) => k.split("|").map((x) => (x === b.id ? a.id : x)).sort().join("|"));
  s.questions = s.questions.map((q) => ({ ...q, a: q.a === b.id ? a.id : q.a, b: q.b === b.id ? a.id : q.b })).filter((q) => q.a !== q.b);
}

/** The owner's people read in: each gets a linked record (renamed with them), and a forgotten one's link goes. True when anything changed. */
export function linkPeople(s: Stored, people: Person[], now: number): boolean {
  let changed = false;
  const ids = new Set(people.map((p) => p.id));
  for (const g of s.persons) {
    if (g.personId && !ids.has(g.personId)) {
      delete g.personId;
      changed = true;
    }
  }
  // A record that was only the owner's (no identity, never seen anywhere) goes with them.
  const before = s.persons.length;
  s.persons = s.persons.filter((g) => g.personId || g.identities.length || g.contacts.length);
  if (s.persons.length !== before) {
    const left = new Set(s.persons.map((p) => p.id));
    s.questions = s.questions.filter((q) => left.has(q.a) && left.has(q.b));
    changed = true;
  }
  for (const p of people) {
    const g = s.persons.find((x) => x.personId === p.id);
    if (g) {
      if (g.name !== p.name) {
        if (!trustedHas(g, p.name)) g.aliases = [...g.aliases, g.name].slice(-NAMES_MAX);
        g.aliases = g.aliases.filter((n) => fold(n) !== fold(p.name));
        g.name = p.name;
        g.updated = now;
        changed = true;
      }
      continue;
    }
    const fresh: GraphPerson = { id: newId(), name: p.name, aliases: [], seen: [], identities: [], personId: p.id, contacts: [], at: p.at, updated: now };
    s.persons.push(fresh);
    for (const other of sameName(s, fresh)) ask(s, fresh, other, now);
    changed = true;
  }
  // A question kept from before about two of the owner's own people goes (see ask).
  const own = new Set(s.persons.filter((g) => g.personId).map((g) => g.id));
  const asked = s.questions.length;
  s.questions = s.questions.filter((q) => !(own.has(q.a) && own.has(q.b)));
  return changed || s.questions.length !== asked;
}

/** One sighting into the records: the record its identity names, else a new one (with a question when its name is another's). */
export function sight(s: Stored, o: Sighting, now: number): { person: GraphPerson | null; changed: boolean } {
  const ids = o.identities.flatMap((i) => {
    const value = identityValue(i.kind, i.value);
    return value ? [{ kind: i.kind, value }] : [];
  });
  const name = line(o.name, GNAME_MAX).replace(/^["']|["']$/g, "");
  if (!ids.length) return { person: null, changed: false };
  const hit = s.persons.filter((p) => ids.some((i) => p.identities.some((x) => x.kind === i.kind && x.value === i.value)));
  const at = Number.isFinite(o.at) ? o.at : now;
  const where = line(o.where, 80);
  const contactOf = (t: number): GraphPerson["contacts"][number] => ({ at: t, via: o.via, ...(where ? { where } : {}) });
  const contact = (p: GraphPerson): boolean => {
    if (p.contacts.some((c) => c.at === at && c.via === o.via)) return false;
    p.contacts = [...p.contacts, contactOf(at)].sort((x, y) => x.at - y.at).slice(-CONTACTS_MAX);
    return true;
  };
  if (hit.length) {
    const p = hit[0]!;
    let changed = contact(p);
    for (const i of ids) {
      if (p.identities.some((x) => x.kind === i.kind && x.value === i.value)) continue;
      p.identities = [...p.identities, { ...i, source: o.via, at: now }].slice(-IDENTITIES_MAX);
      changed = true;
    }
    if (name && !trustedHas(p, name) && !p.seen.some((n) => fold(n) === fold(name))) {
      p.seen = [...p.seen, name].slice(-NAMES_MAX);
      changed = true;
    }
    // Two records each holding one of these identities: the owner is asked whether they are one person.
    for (const other of hit.slice(1)) ask(s, p, other, now);
    if (changed) p.updated = now;
    return { person: p, changed: changed || hit.length > 1 };
  }
  const fresh: GraphPerson = {
    id: newId(), name: name || ids[0]!.value, aliases: [], seen: [], identities: ids.map((i) => ({ ...i, source: o.via, at: now })),
    contacts: [contactOf(at)], at: now, updated: now,
  };
  s.persons.push(fresh);
  if (name) for (const other of sameName(s, fresh)) ask(s, other, fresh, now);
  // Past the limit, the record seen least recently that is not the owner's and has no question waiting goes.
  while (s.persons.length > GRAPH_MAX) {
    const asked = new Set(s.questions.flatMap((q) => [q.a, q.b]));
    const gone = s.persons.filter((p) => !p.personId && !asked.has(p.id) && p.id !== fresh.id).sort((a, b) => a.updated - b.updated)[0];
    if (!gone) break;
    s.persons = s.persons.filter((p) => p.id !== gone.id);
  }
  return { person: fresh, changed: true };
}

/**
 * The record a word means: an identity's value, a trusted name, else a one-word first name only one record has among the names the owner
 * gave or confirmed (a record of theirs, an alias). A name that came only with someone else's mail, Slack, calendar or Zoom never decides it:
 * a recruiter's "From: David Gomez" does not make the owner's friend "David" him.
 */
export function findIn(persons: GraphPerson[], word: string): GraphPerson | undefined {
  const w = word.trim();
  if (!w) return undefined;
  const email = identityValue("email", w);
  if (email) return persons.find((p) => p.identities.some((i) => i.kind === "email" && i.value === email));
  if (/^[UW][A-Z0-9]{2,20}$/.test(w)) return persons.find((p) => p.identities.some((i) => i.kind === "slack" && i.value === w));
  const exact = persons.filter((p) => trustedHas(p, w));
  const mine = exact.find((p) => p.personId);
  if (mine) return mine;
  const owned = (p: GraphPerson): string[] => (p.personId ? names(p) : p.aliases);
  const first = w.includes(" ") ? [] : persons.filter((p) => owned(p).some((n) => firstWord(n) === fold(w)));
  // A record named only by someone else's mail or Slack ("Ana <x@evil.example>") never takes the owner's Ana Garcia from her first name:
  // an exact match counts first only when the owner gave or confirmed that name (an alias).
  if (exact.some((p) => p.aliases.some((a) => fold(a) === fold(w)))) return exact.find((p) => p.aliases.some((a) => fold(a) === fold(w)));
  if (first.length === 1 && first[0]!.personId) return first[0];
  if (exact.length) return exact[0];
  return first.length === 1 ? first[0] : undefined;
}

export interface PeopleGraph {
  /** Every record and the questions waiting, the owner's people read in. Throws when the store cannot be read. */
  read(): Promise<{ persons: GraphPerson[]; questions: SameQuestion[] }>;
  /** Sightings from Slack, the mail, the calendar or Zoom (identities and names only); one write for all. Throws when the store fails. */
  observe(list: Sighting[], now?: number): Promise<number>;
  /** The record a word means (a name, an alias, an address, a Slack id), or undefined. */
  find(word: string): Promise<GraphPerson | undefined>;
  /** The next question to put to the owner (one not asked in three days; `about`: one about that record), marked asked; null when none waits. */
  nextQuestion(now?: number, about?: string): Promise<{ q: SameQuestion; a: GraphPerson; b: GraphPerson } | null>;
  /** The owner's answer: yes merges, no is remembered. Null when the question is gone. */
  answer(id: string, yes: boolean, now?: number): Promise<{ a: GraphPerson; b: GraphPerson; yes: boolean } | null>;
  /** From the last copy read or written (no wait): a name or identity's record's name, or the word as it was. */
  canon(word: string): string;
  /** From the last copy: the trusted names (name and aliases) of the record whose trusted name this is; [] when none. */
  trustedNames(word: string): string[];
}

export function createPeopleGraph(kv: Kv | null, o: { people?: () => Promise<Person[]>; now?: () => number } = {}): PeopleGraph {
  const clock = o.now ?? Date.now;
  const empty = (): Stored => ({ persons: [], questions: [], no: [] });
  let local: Stored = empty();
  let snapshot: GraphPerson[] = [];
  const readRaw = async (): Promise<Stored> => {
    if (!kv) return structuredClone(local);
    const raw = await readJsonRecord(kv, KEY);
    if (!raw) return empty();
    return clean(raw);
  };
  const write = async (s: Stored): Promise<void> => {
    if (kv) await kv.set(KEY, JSON.stringify({ v: 1, ...s }), TTL_SECONDS);
    local = structuredClone(s);
  };
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
  const change = <T>(fn: (s: Stored, now: number) => { out: T; changed: boolean }, at?: number): Promise<T> =>
    locked(async () => {
      const now = at ?? clock();
      const s = await readRaw();
      let dirty = false;
      if (o.people) {
        // The owner's people that cannot be read now are read next time: no link is dropped on a failed read.
        const people = await o.people().catch((err: Error) => (log.error(`could not read the people: ${err.message}`), null));
        if (people) dirty = linkPeople(s, people, now);
      }
      const { out, changed } = fn(s, now);
      if (changed || dirty) await write(s);
      snapshot = structuredClone(s.persons);
      return out;
    });
  return {
    read: () => change((s) => ({ out: { persons: structuredClone(s.persons), questions: structuredClone(s.questions) }, changed: false })),
    observe: (list, at) =>
      change((s, now) => {
        let n = 0;
        let changed = false;
        for (const x of list.slice(0, 200)) {
          const r = sight(s, x, now);
          if (r.person) n++;
          changed ||= r.changed;
        }
        return { out: n, changed };
      }, at),
    find: (word) => change((s) => ({ out: structuredClone(findIn(s.persons, word)), changed: false })),
    nextQuestion: (at, about) =>
      change((s, now) => {
        const q = s.questions.find((x) => (!about || x.a === about || x.b === about) && (!x.asked || now - x.asked >= ASK_AGAIN_MS));
        const a = q && s.persons.find((p) => p.id === q.a);
        const b = q && s.persons.find((p) => p.id === q.b);
        if (!q || !a || !b) return { out: null, changed: false };
        q.asked = now;
        return { out: { q: { ...q }, a: structuredClone(a), b: structuredClone(b) }, changed: true };
      }, at),
    answer: (id, yes, at) =>
      change((s, now) => {
        const q = s.questions.find((x) => x.id === id);
        const a = q && s.persons.find((p) => p.id === q.a);
        const b = q && s.persons.find((p) => p.id === q.b);
        s.questions = s.questions.filter((x) => x.id !== id);
        if (!q || !a || !b) return { out: null, changed: !!q };
        const before = { a: structuredClone(a), b: structuredClone(b) };
        if (yes) merge(s, a, b, now);
        else s.no = [...s.no, pairKey(a.id, b.id)].slice(-NO_MAX);
        return { out: { ...before, yes }, changed: true };
      }, at),
    canon: (word) => findIn(snapshot, word)?.name ?? word,
    trustedNames: (word) => {
      const hits = snapshot.filter((p) => trustedHas(p, word));
      return hits.length === 1 ? names(hits[0]!) : [];
    },
  };
}

// ---------- what the owner reads ----------

const T = texts(
  {
    question: "❓ Are these the same person: {a} and {b}?",
    yes: "Yes, the same",
    no: "No",
    merged: "👥 Done: {a} and {b} are the same person. What I know of both goes together.",
    kept: "👍 OK: {a} and {b} are different people. I won't ask again.",
    gone: "That question isn't open any more.",
    card: "👤 {name}{relation}",
    aka: "Also: {list}",
    seenAs: "Seen as: {list}",
    ids: "🪪 {list}",
    facts: "📌 What I know now:",
    changed: "🔁 Changed recently:",
    contacts: "🕑 Last seen: {list}",
    nothing: "I don't know anything else yet.",
    k_email: "email", k_slack: "Slack", k_phone: "phone", k_whatsapp: "WhatsApp", k_telegram: "Telegram", k_zoom: "Zoom",
    v_slack: "Slack", v_correo: "mail", v_calendario: "calendar", v_zoom: "Zoom",
  },
);
export const graphWords = T;

/** "Ana Garcia (ana@x.com)": a record as a question names it, so the owner can tell the two apart. */
export function personLabel(p: GraphPerson, l: Lang): string {
  const id = p.identities.find((i) => i.kind === "email") ?? p.identities.find((i) => i.kind !== "zoom");
  if (!id || fold(id.value) === fold(p.name)) return p.name;
  const v = id.kind === "email" ? id.value : `${T(l)(`k_${id.kind}`)} ${id.value}`;
  return `${p.name} (${v})`;
}

/** The question's line. */
export const questionText = (a: GraphPerson, b: GraphPerson, l: Lang): string => T(l)("question", { a: personLabel(a, l), b: personLabel(b, l) });

/** "what do you know about Rohan?" (`command` as the door compares commands): the name asked about, or null. */
export function whoCommand(command: string): string | null {
  const m = /^(?:what do you know about|tell me about) (.{1,60})$/.exec(command);
  return m ? m[1]!.trim() : null;
}

/**
 * The person card: names, identities, the facts that hold now and what changed lately (lines made by src/memory-facts.ts), the last contacts.
 * `relation`: the owner's word for them, when there is one.
 */
export function cardText(
  p: GraphPerson, o: { facts: string[]; changes: string[]; relation?: string; lang: Lang; timeZone: string },
): string {
  const t = T(o.lang);
  const when = (at: number): string =>
    new Intl.DateTimeFormat(locale(o.lang), { timeZone: o.timeZone, day: "numeric", month: "short" }).format(at).replace(/\.$/, "");
  const via = (v: string): string => (["slack", "correo", "calendario", "zoom"].includes(v) ? t(`v_${v}` as "v_slack") : v);
  const ids = p.identities.map((i) => `${t(`k_${i.kind}`)} ${i.value}`);
  const contacts = [...p.contacts].reverse().slice(0, 3).map((c) => `${via(c.via)} ${when(c.at)}`);
  return [
    t("card", { name: p.name, relation: o.relation ? ` (${o.relation})` : "" }),
    ...(p.aliases.length ? [t("aka", { list: p.aliases.join(", ") })] : []),
    ...(p.seen.length ? [t("seenAs", { list: p.seen.slice(-4).join(", ") })] : []),
    ...(ids.length ? [t("ids", { list: ids.slice(0, 6).join(" · ") })] : []),
    ...(o.facts.length ? [t("facts"), ...o.facts.slice(0, 8).map((f) => `• ${f}`)] : []),
    ...(o.changes.length ? [t("changed"), ...o.changes.slice(0, 4).map((f) => `• ${f}`)] : []),
    ...(contacts.length ? [t("contacts", { list: contacts.join(", ") })] : []),
    ...(!o.facts.length && !ids.length && !contacts.length ? [t("nothing")] : []),
  ].join("\n");
}

// ---------- what Pako already reads, as sightings: identities and names only, never what anyone wrote ----------

/** The senders of the mail Pako has read (its own inbox and the owner's, src/mail.ts): one sighting each. */
export function mailSightings(items: { at: number; from: string }[]): Sighting[] {
  return items.flatMap((m) => {
    const { name, email } = splitAddress(m.from);
    return email ? [{ ...(name ? { name } : {}), identities: [{ kind: "email" as const, value: email }], via: "correo", at: m.at }] : [];
  });
}

/** The attendees of the calendar's events (src/calendar.ts, src/ics.ts): one sighting each, dated by the meeting. */
export function eventSightings(events: { start: number; attendees?: { email: string; name?: string }[] }[]): Sighting[] {
  return events.flatMap((e) =>
    (e.attendees ?? []).map((a) => ({ ...(a.name ? { name: a.name } : {}), identities: [{ kind: "email" as const, value: a.email }], via: "calendario", at: e.start })));
}

/** A Slack message's author (src/slack.ts observe): their Slack id, the name Slack shows and the conversation's label (a place, not words). */
export function slackSightings(m: { who: string; user?: string; at: number; where?: string }): Sighting[] {
  return m.user ? [{ name: m.who, identities: [{ kind: "slack", value: m.user }], via: "slack", at: m.at, ...(m.where ? { where: m.where } : {}) }] : [];
}

/** The display names that spoke in a Zoom meeting (src/zoom.ts speakers). */
export function zoomSightings(names: string[], at: number): Sighting[] {
  return names.map((n) => ({ name: n, identities: [{ kind: "zoom" as const, value: n }], via: "zoom", at }));
}
