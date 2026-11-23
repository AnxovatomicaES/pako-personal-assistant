// Dated facts: what Pako knows, with when it was true and when Pako learnt it (the bi-temporal idea of Graphiti/Zep, rebuilt small on the
// key value store). Each fact is about a subject (the owner, "", or a person by name), an attribute ("weekly meeting", "relation") and a
// value, with validFrom/validTo (when it was true), learnedAt/closedAt (when Pako learnt it, and when it learnt it stopped) and its source
// (who said it, where, when). A fact is never overwritten: a newer one that contradicts it closes it, so Pako can say "lo movieron del
// martes al jueves" and the old value stays as history.
//
// - Two kinds of fact. Derived ones mirror what the older stores keep (the owner's notes, src/voice-memory.ts; the people's relation,
//   birthday, likes and notes, src/people.ts): they are read into this shape on every load (`origin` says from where), so the first load
//   migrates everything and a later change there (a note corrected, a relation changed) closes the old fact and opens the new one. Something
//   deleted there (FORGET 3, FORGET PERSON Ana) is deleted here too: forgetting means forgetting, never "closed".
// - Told ones (<know>, src/whatsapp.ts) live only here. One that gives another value for the same subject and attribute is a candidate
//   contradiction: decided by a small isolated job on the owner's computer (strict JSON, judgeText / verdict below), which may say both hold
//   ("speaks English" and "speaks French"). Without an answer within JUDGE_MS (an older bridge lets the job go, the computer is off) the
//   newest wins: the old fact is closed. A `multi` attribute (notes, likes) holds many values at once and never closes another.
//
// One key in the store. Writes are one at a time and never start from a copy that could not be read.

import { randomBytes } from "node:crypto";
import { locale, texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import { fold } from "./lists.ts";
import type { Person } from "./people.ts";
import { createLog } from "./log.ts";
import { readJsonRecord } from "./json-record.ts";

const log = createLog("facts");

export interface FactSource {
  /** Who said it: "owner" for the owner's own words, otherwise a name. */
  who: string;
  /** Where: "chat", "notas", "personas". */
  where: string;
  at: number;
}

export interface Fact {
  /** 10 lowercase hex characters. */
  id: string;
  /** "" for the owner; otherwise the person's name as it was said (matched by name and alias, src/people-graph.ts). */
  subject: string;
  attribute: string;
  value: string;
  validFrom: number;
  /** When it stopped being true; absent while it holds. */
  validTo?: number;
  learnedAt: number;
  /** When Pako learnt it stopped, and the fact that closed it. */
  closedAt?: number;
  closedBy?: string;
  source: FactSource;
  /** Many values hold at once (notes, likes): never closes another. */
  multi?: true;
  /** A derived fact: what in the older stores it mirrors ("note:3", "person:<id>:relation"). */
  origin?: string;
  /** Waiting for the isolated judge: the facts it may close, and when the newest wins without an answer. */
  pending?: { until: number; against: string[] };
}

/** A fact as it is told: the parts said. `validFrom` absent: from when it was learnt. */
export interface FactInput {
  subject: string;
  attribute: string;
  value: string;
  validFrom?: number;
  source: FactSource;
  multi?: boolean;
}

/** What the older stores keep, read into facts on every load. */
export interface FactSeed {
  notes: { id: number; at: number; text: string }[];
  people: Person[];
}

export interface AddOutcome {
  added: Fact[];
  /** Old facts the new ones closed at once (newest wins: no judge asked for). */
  closed: { old: Fact; by: Fact }[];
  /** New facts waiting for the judge, with the old ones they may close. */
  pending: { fact: Fact; against: Fact[] }[];
  /** Already known: the same subject, attribute and value hold now. */
  same: number;
}

const KEY = "memory-facts";
const DAY_MS = 24 * 3600_000;
const TTL_SECONDS = 400 * 24 * 3600;
/** Facts kept at most, not counting the current derived ones (rebuilt from their store): the closed ones go first, the oldest first. */
export const FACTS_MAX = 800;
/** How long a candidate contradiction waits for the isolated judge before the newest wins. */
export const JUDGE_MS = 10 * 60_000;
/** A closed fact is history for a year, then it goes. */
const CLOSED_KEEP_MS = 365 * DAY_MS;
/** "What changed" looks this far back. */
export const CHANGES_DAYS = 7;
export const SUBJECT_MAX = 60;
export const ATTRIBUTE_MAX = 60;
export const VALUE_MAX = 300;
const HEX10 = /^[0-9a-f]{10}$/;

const line = (s: unknown, max: number): string => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");
const newId = (): string => randomBytes(5).toString("hex");
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

/** A stored fact, checked field by field; a record from an older shape gets what it lacks (learnt when it became true, source unknown). */
export function factOf(v: unknown): Fact | null {
  if (!isObject(v) || typeof v.id !== "string" || !HEX10.test(v.id)) return null;
  const attribute = line(v.attribute, ATTRIBUTE_MAX);
  const value = line(v.value, VALUE_MAX);
  const validFrom = num(v.validFrom) ?? num(v.learnedAt);
  if (!attribute || !value || validFrom === undefined) return null;
  const learnedAt = num(v.learnedAt) ?? validFrom;
  const s = isObject(v.source) ? v.source : {};
  const validTo = num(v.validTo);
  const p = isObject(v.pending) ? v.pending : null;
  const against = p && Array.isArray(p.against) ? p.against.filter((x): x is string => typeof x === "string" && HEX10.test(x)).slice(0, 10) : [];
  return {
    id: v.id,
    subject: line(v.subject, SUBJECT_MAX),
    attribute,
    value,
    validFrom,
    ...(validTo !== undefined ? { validTo } : {}),
    learnedAt,
    ...(validTo !== undefined ? { closedAt: num(v.closedAt) ?? validTo } : {}),
    ...(typeof v.closedBy === "string" && HEX10.test(v.closedBy) ? { closedBy: v.closedBy } : {}),
    source: { who: line(s.who, 60) || "?", where: line(s.where, 40) || "?", at: num(s.at) ?? learnedAt },
    ...(v.multi === true ? { multi: true as const } : {}),
    ...(typeof v.origin === "string" && v.origin.length <= 120 ? { origin: v.origin } : {}),
    ...(p && against.length && num(p.until) !== undefined ? { pending: { until: num(p.until)!, against } } : {}),
  };
}

function clean(raw: unknown): Fact[] {
  const list = isObject(raw) && Array.isArray(raw.facts) ? raw.facts : Array.isArray(raw) ? raw : [];
  const out: Fact[] = [];
  const seen = new Set<string>();
  for (const x of list) {
    const f = factOf(x);
    if (f && !seen.has(f.id)) {
      seen.add(f.id);
      out.push(f);
    }
  }
  return out;
}

const holds = (f: Fact): boolean => f.validTo === undefined;
const sameSubject = (a: string, b: string): boolean => fold(a) === fold(b);

/** Closes `old` because of `by`: it was true until `by` became true (never before it began), and Pako learnt that now. */
function close(old: Fact, by: Fact, now: number): void {
  old.validTo = Math.max(old.validFrom, by.validFrom);
  old.closedAt = now;
  old.closedBy = by.id;
  delete old.pending;
}

/**
 * A derived fact's attribute is Pako's own word, English. Facts derived before Pako was English only keep the Spanish word they were stored
 * with (a fact is not rewritten while its value holds): said in English, and compared as the English word, so the old ones and the new ones
 * are one attribute. A told fact with the Spanish word (an owner who tells Claude in Spanish) is the same attribute too.
 */
const OLD_OWN: Record<string, string> = { nota: "note", relacion: "relation", cumpleanos: "birthday", "le gusta": "likes" };
const attrKey = (a: string): string => OLD_OWN[fold(a)] ?? fold(a);
export const ownAttribute = (f: Pick<Fact, "attribute" | "origin">): string => (f.origin ? OLD_OWN[fold(f.attribute)] ?? f.attribute : f.attribute);

/** What the older stores keep, as derived facts by origin. */
function derive(seed: FactSeed): Map<string, Omit<Fact, "id" | "learnedAt">> {
  const out = new Map<string, Omit<Fact, "id" | "learnedAt">>();
  for (const n of seed.notes) {
    const value = line(n.text, VALUE_MAX);
    if (!value) continue;
    const at = n.at > 0 ? n.at : 0;
    out.set(`note:${n.id}`, { subject: "", attribute: "note", value, validFrom: at, source: { who: "owner", where: "notas", at }, multi: true });
  }
  for (const p of seed.people) {
    const base = { subject: p.name, source: { who: "owner", where: "personas", at: p.updated } };
    if (p.relation) out.set(`person:${p.id}:relation`, { ...base, attribute: "relation", value: p.relation, validFrom: p.at });
    if (p.birthday) out.set(`person:${p.id}:birthday`, { ...base, attribute: "birthday", value: p.birthday, validFrom: p.at });
    for (const x of p.likes) out.set(`person:${p.id}:like:${fold(x)}`, { ...base, attribute: "likes", value: x, validFrom: p.at, multi: true });
    for (const x of p.notes) out.set(`person:${p.id}:note:${fold(x)}`, { ...base, attribute: "note", value: x, validFrom: p.at, multi: true });
  }
  return out;
}

/**
 * The older stores read into facts: a new note or person part becomes a fact (dated from when it was kept: the first load is the migration),
 * a changed one closes its old fact and opens a new one from now, a deleted one is deleted with its history. True when anything changed.
 */
export function reconcile(facts: Fact[], seed: FactSeed, now: number): boolean {
  const want = derive(seed);
  let changed = false;
  const live = new Set(want.keys());
  for (let i = facts.length - 1; i >= 0; i--) {
    const o = facts[i]!.origin;
    if (o && !live.has(o)) {
      facts.splice(i, 1);
      changed = true;
    }
  }
  for (const [origin, d] of want) {
    // The newest fact this origin gave, holding or not: one a told fact closed ("her birthday is on 12 May") stays closed while the
    // older store still says the same; only a change there opens it again.
    const last = facts.findLast((f) => f.origin === origin);
    if (last && fold(last.value) === fold(d.value)) {
      if (last.subject !== d.subject) {
        last.subject = d.subject; // a person renamed: the same facts, under the new name
        changed = true;
      }
      continue;
    }
    // A fact changed in the older store starts now; a new one starts when the older store kept it (or now, with no date).
    const from = last ? now : d.validFrom || now;
    const fresh: Fact = { id: newId(), ...d, validFrom: from, learnedAt: last ? now : from, origin };
    if (last && holds(last)) close(last, fresh, now);
    // The owner changed it there after telling another value: the newest wins over the told one too.
    if (last && !d.multi) {
      for (const f of facts) {
        if (!f.origin && !f.multi && holds(f) && sameSubject(f.subject, d.subject) && attrKey(f.attribute) === attrKey(d.attribute)) close(f, fresh, now);
      }
    }
    facts.push(fresh);
    changed = true;
  }
  return changed;
}

/** Pending facts whose judge did not answer in time: the newest wins. True when anything changed. */
export function sweep(facts: Fact[], now: number): boolean {
  let changed = false;
  for (const f of facts) {
    if (!f.pending || f.pending.until > now) continue;
    for (const id of f.pending.against) {
      const old = facts.find((x) => x.id === id);
      if (old && holds(old)) close(old, f, now);
    }
    delete f.pending;
    changed = true;
  }
  return changed;
}

/** A derived fact that holds: rebuilt from its older store on every load, so it never counts against FACTS_MAX and is never pruned. */
const mirror = (f: Fact): boolean => !!f.origin && holds(f);

/**
 * What each origin derives now, by value (folded): a closed derived fact whose origin still says the same is what keeps it closed (see
 * reconcile). Null when the older store could not be read at this load: nothing can be said to have changed there, so none is let go.
 */
export type Derives = Map<string, string> | null;

/** The values the older stores derive now, by origin. */
export function derivedValues(seed: FactSeed): Derives {
  return new Map([...derive(seed)].map(([origin, d]) => [origin, fold(d.value)]));
}

/**
 * Closed history past a year goes; then, past the limit (counting all but the current derived facts), the oldest closed facts, and only
 * when no closed one is left the oldest told one. A full PEOPLE list never pushes out what the owner told. A closed derived fact whose origin
 * still derives the same value is never pruned, by age or by count: the next load would derive it again as current, and what the owner told
 * since (the reason it closed) would sit beside it as if both held.
 */
function prune(facts: Fact[], now: number, derives: Derives): void {
  const newest = new Map<string, Fact>();
  for (const f of facts) if (f.origin) newest.set(f.origin, f);
  const keeps = (f: Fact): boolean => !!f.origin && !holds(f) && newest.get(f.origin) === f && (derives === null || derives.get(f.origin) === fold(f.value));
  for (let i = facts.length - 1; i >= 0; i--) {
    const f = facts[i]!;
    if (!holds(f) && (f.closedAt ?? 0) < now - CLOSED_KEEP_MS && !keeps(f)) facts.splice(i, 1);
  }
  const counted = (f: Fact): boolean => !mirror(f) && !keeps(f);
  let over = facts.filter(counted).length - FACTS_MAX;
  if (over <= 0) return;
  const closed = facts.filter((f) => !holds(f) && !keeps(f)).sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
  const drop = new Set(closed.slice(0, over));
  over -= drop.size;
  for (const f of facts) {
    if (over <= 0) break;
    if (counted(f) && !drop.has(f)) {
      drop.add(f);
      over--;
    }
  }
  for (let i = facts.length - 1; i >= 0; i--) if (drop.has(facts[i]!)) facts.splice(i, 1);
}

export interface FactStore {
  /** Every fact (current and closed), the older stores read in and late judgements settled. Throws when the store cannot be read. */
  read(): Promise<Fact[]>;
  /**
   * New facts. One that gives another value for the same subject and attribute: with `judge`, it waits for the isolated judge (`pending`);
   * without, the newest wins at once (`closed`). Throws when the store fails.
   */
  add(inputs: FactInput[], now: number, o?: { judge?: boolean }): Promise<AddOutcome>;
  /** The judge's answer for a pending fact (its raw text); anything not strict JSON is the newest winning. False: no such pending fact. */
  verdict(id: string, raw: string, now: number): Promise<{ ok: boolean; closed: number }>;
  /** Every told fact about these names (a person forgotten): deleted, history too. Returns the facts that went (an undo puts them back). */
  forget(names: string[]): Promise<Fact[]>;
  /** Forgotten facts put back as they were (an undo of FORGET PERSON); one already there is left. Returns how many came back. */
  restore(list: Fact[]): Promise<number>;
}

export function createFacts(kv: Kv | null, o: { seed?: () => Promise<FactSeed>; now?: () => number } = {}): FactStore {
  const clock = o.now ?? Date.now;
  let local: Fact[] = [];
  const readRaw = async (): Promise<Fact[]> => {
    if (!kv) return structuredClone(local);
    const raw = await readJsonRecord(kv, KEY);
    if (!raw) return [];
    return clean(raw);
  };
  const write = async (facts: Fact[]): Promise<void> => {
    if (kv) await kv.set(KEY, JSON.stringify({ v: 1, facts }), TTL_SECONDS);
    local = structuredClone(facts);
  };
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
  /** The record with the older stores read in and late judgements settled; `dirty` when that changed it (the caller writes). `derives`: what they say now. */
  const load = async (now: number): Promise<{ facts: Fact[]; dirty: boolean; derives: Derives }> => {
    const facts = await readRaw();
    let dirty = false;
    let derives: Derives = new Map();
    if (o.seed) {
      // An older store that cannot be read now is read next time: nothing is deleted on a failed read.
      const seed = await o.seed().catch((err: Error) => (log.error(`could not read the notes and people: ${err.message}`), null));
      if (seed) {
        dirty = reconcile(facts, seed, now);
        derives = derivedValues(seed);
      } else derives = null;
    }
    if (sweep(facts, now)) dirty = true;
    return { facts, dirty, derives };
  };
  const change = <T>(fn: (facts: Fact[], now: number) => { out: T; changed: boolean }, at?: number): Promise<T> =>
    locked(async () => {
      const now = at ?? clock();
      const { facts, dirty, derives } = await load(now);
      const { out, changed } = fn(facts, now);
      if (changed || dirty) {
        prune(facts, now, derives);
        await write(facts);
      }
      return out;
    });
  return {
    read: () => change((facts) => ({ out: structuredClone(facts), changed: false })),
    add: (inputs, at, opt = {}) =>
      change((facts, now): { out: AddOutcome; changed: boolean } => {
        const out: AddOutcome = { added: [], closed: [], pending: [], same: 0 };
        for (const input of inputs.slice(0, 10)) {
          const named = line(input.attribute, ATTRIBUTE_MAX);
          const value = line(input.value, VALUE_MAX);
          if (!named || !value) continue;
          const said = line(input.subject, SUBJECT_MAX);
          // The way the subject was first written ("Rohan", not a later "rohan").
          const subject = facts.find((f) => !f.origin && sameSubject(f.subject, said))?.subject ?? said;
          const attribute = facts.find((f) => !f.origin && sameSubject(f.subject, subject) && attrKey(f.attribute) === attrKey(named))?.attribute ?? named;
          const same = facts.filter((f) => holds(f) && sameSubject(f.subject, subject) && attrKey(f.attribute) === attrKey(attribute));
          if (same.some((f) => fold(f.value) === fold(value))) {
            out.same++;
            continue;
          }
          const fact: Fact = {
            id: newId(), subject, attribute, value, validFrom: input.validFrom ?? now, learnedAt: now,
            source: { who: line(input.source.who, 60) || "?", where: line(input.source.where, 40) || "?", at: input.source.at },
            ...(input.multi ? { multi: true as const } : {}),
          };
          const rivals = fact.multi ? [] : same.filter((f) => !f.multi);
          // One that began after this one ("works at Acme" since October, "at Initech" since 2020 told today): this one is history. It was
          // true until the next began, and it closes nothing.
          const next = rivals.filter((f) => f.validFrom > fact.validFrom).sort((a, b) => a.validFrom - b.validFrom)[0];
          if (next) {
            Object.assign(fact, { validTo: next.validFrom, closedAt: now, closedBy: next.id });
          } else if (rivals.length && opt.judge) {
            fact.pending = { until: now + JUDGE_MS, against: rivals.map((f) => f.id).slice(0, 10) };
            out.pending.push({ fact: structuredClone(fact), against: structuredClone(rivals) });
          } else {
            for (const old of rivals) {
              close(old, fact, now);
              out.closed.push({ old: structuredClone(old), by: structuredClone(fact) });
            }
          }
          facts.push(fact);
          out.added.push(structuredClone(fact));
        }
        return { out, changed: out.added.length > 0 };
      }, at),
    verdict: (id, raw, at) =>
      change((facts, now): { out: { ok: boolean; closed: number }; changed: boolean } => {
        const f = facts.find((x) => x.id === id);
        if (!f?.pending) return { out: { ok: false, closed: 0 }, changed: false };
        const v = judgement(raw);
        let closed = 0;
        for (const oldId of f.pending.against) {
          const old = facts.find((x) => x.id === oldId);
          // Both hold only when the judge said so of this one; anything else (unsure, not named, not JSON) is the newest winning.
          if (!old || !holds(old) || (v && v.compatible.has(oldId) && !v.contradicts.has(oldId))) continue;
          close(old, f, now);
          closed++;
        }
        delete f.pending;
        return { out: { ok: true, closed }, changed: true };
      }, at),
    forget: (names) =>
      change((facts) => {
        const want = new Set(names.map(fold).filter(Boolean));
        const gone: Fact[] = [];
        for (let i = facts.length - 1; i >= 0; i--) if (!facts[i]!.origin && want.has(fold(facts[i]!.subject))) gone.unshift(...facts.splice(i, 1));
        return { out: gone, changed: gone.length > 0 };
      }),
    restore: (list) =>
      change((facts) => {
        const have = new Set(facts.map((f) => f.id));
        const back = list.filter((f) => !f.origin && !have.has(f.id)).map((f) => structuredClone(f));
        facts.push(...back);
        return { out: back.length, changed: back.length > 0 };
      }),
  };
}

/** The judge's strict JSON: {"contradicts": [ids], "compatible": [ids]}; null when it is not that. */
export function judgement(raw: string): { contradicts: Set<string>; compatible: Set<string> } | null {
  const s = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    /* not JSON: nothing kept */
    return null;
  }
  if (!isObject(v)) return null;
  const ids = (x: unknown): Set<string> | null =>
    x === undefined ? new Set() : Array.isArray(x) && x.every((y) => typeof y === "string") ? new Set(x as string[]) : null;
  const contradicts = ids(v.contradicts);
  const compatible = ids(v.compatible);
  return contradicts && compatible ? { contradicts, compatible } : null;
}

// ---------- what the owner, the judge and the assistant read ----------

const T = texts(
  {
    owner: "you",
    since: "since {day}",
    change: "{subject} · {attribute}: “{old}” → “{new}” ({day})",
    ended: "{subject} · {attribute}: “{old}” no longer holds ({day})",
    briefHead: "🔁 Changed since yesterday:",
    briefHeadSince: "🔁 Changed since the last brief ({day}):",
    judgeHead: "Two facts about {subject}, attribute “{attribute}”. Does the new one contradict the old one (only one can be true now)?",
    judgeNew: "NEW {id}: “{value}” (true since {from}, said by {who})",
    judgeOld: "OLD {id}: “{value}” (true since {from}, said by {who})",
    recallNow: "now",
    logKnow: "Fact noted: {subject} · {attribute}: {value}",
    logClosed: "Fact changed: {subject} · {attribute}: “{old}” → “{new}”",
    logOutside: "A fact was not kept: it came from a turn that read other people's text",
  },
);
export const factWords = T;

const dayOf = (at: number, l: Lang, timeZone: string): string =>
  new Intl.DateTimeFormat(locale(l), { timeZone, day: "numeric", month: "short" }).format(at).replace(/\.$/, "");
const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const attr = (f: Fact, _l: Lang): string => ownAttribute(f);

/** The facts that hold now about these names ("" is the owner), newest learnt first. */
export function currentAbout(facts: Fact[], names: string[]): Fact[] {
  const want = new Set(names.map(fold));
  return facts.filter((f) => holds(f) && want.has(fold(f.subject))).sort((a, b) => b.learnedAt - a.learnedAt);
}

/** "weekly meeting: Thursday 10:00 (since 15 Nov)". */
export function factLine(f: Fact, l: Lang, timeZone: string): string {
  return cut(`${attr(f, l)}: ${f.value} (${T(l)("since", { day: dayOf(f.validFrom || f.learnedAt, l, timeZone) })})`, 200);
}

/** What changed: facts Pako learnt stopped holding since `since`, each with what replaced it, newest first. */
export function changesSince(facts: Fact[], since: number, l: Lang, timeZone: string, max = 10): string[] {
  const t = T(l);
  // A fact learnt as history (closed by one Pako knew before it) is not a change.
  const history = (f: Fact): boolean => !!f.closedBy && (facts.find((x) => x.id === f.closedBy)?.learnedAt ?? 0) < f.learnedAt;
  return facts
    .filter((f) => !holds(f) && (f.closedAt ?? 0) >= since && !history(f))
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
    .slice(0, max)
    .map((f) => {
      const next = f.closedBy ? facts.find((x) => x.id === f.closedBy) : undefined;
      const vars = { subject: f.subject || t("owner"), attribute: attr(f, l), old: cut(f.value, 80), day: dayOf(f.closedAt ?? f.validTo!, l, timeZone) };
      return cut(next ? t("change", { ...vars, new: cut(next.value, 80) }) : t("ended", vars), 240);
    });
}

/**
 * The brief's line: what changed since the last brief (`since`; a day back without it), or null when nothing did. A brief skipped while the
 * computer slept leaves a longer span: its head then names the day it starts from.
 */
export function changesBrief(facts: Fact[], now: number, l: Lang, timeZone: string, since: number = now - DAY_MS): string | null {
  const from = Math.min(since, now - DAY_MS);
  const lines = changesSince(facts, from, l, timeZone, 5);
  const head = now - from > 36 * 3600_000 ? T(l)("briefHeadSince", { day: dayOf(from, l, timeZone) }) : T(l)("briefHead");
  return lines.length ? [head, ...lines.map((x) => `• ${x}`)].join("\n") : null;
}

/** The isolated judge's material: the new fact and the old ones it may close, with their ids (the prompt asks for strict JSON). */
export function judgeText(fact: Fact, olds: Fact[], l: Lang, timeZone: string): string {
  const t = T(l);
  const from = (f: Fact): string => dayOf(f.validFrom || f.learnedAt, l, timeZone);
  const who = (f: Fact): string => (f.source.who === "owner" ? t("owner") : f.source.who);
  return [
    t("judgeHead", { subject: fact.subject || t("owner"), attribute: fact.attribute }),
    t("judgeNew", { id: fact.id, value: fact.value, from: from(fact), who: who(fact) }),
    ...olds.map((f) => t("judgeOld", { id: f.id, value: f.value, from: from(f), who: who(f) })),
  ].join("\n");
}
