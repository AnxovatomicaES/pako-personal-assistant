// The ledger: every booking Maître attempts is a transaction with a key (restaurant, date, time, party) and a state, kept in the store.
//
//   planned -> submitted -> confirmed
//      |           |  \-> failed         (only with proof that nothing went through)
//      |           \----> (stays submitted when the answer never came: maybe booked, never retried)
//      \-> failed / cancelled
//
// The one rule it exists for: a booking is never submitted twice for one key. Before any submit the ledger refuses when a submitted or
// confirmed entry has that key, and the inbox is checked for the engine's confirmation email. "submitted" is written BEFORE the press that
// submits (the same order as the email route's count): a press whose answer is lost may have booked, and a retry would book twice.

import { randomBytes } from "node:crypto";
import type { Kv } from "../kv.ts";
import type { Evidence } from "./cartridge.ts";

export type LedgerState = "planned" | "submitted" | "confirmed" | "failed" | "cancelled";

export interface LedgerEntry {
  id: string;
  key: string;
  placeId: string;
  name: string;
  engine: string;
  url: string;
  date: string;
  time: string;
  party: number;
  guest: string;
  state: LedgerState;
  at: number;
  updated: number;
  submittedAt?: number;
  evidence?: Evidence;
  /** Why it failed or stopped, typed by the cartridge ("gate:captcha", "no_slot", "timeout"...). */
  reason?: string;
  /** A Handoff is open for it: the owner is finishing it in the window. */
  handoff?: boolean;
}

/** The idempotency key: one restaurant, one day, one time, one party. */
export const ledgerKey = (placeId: string, date: string, time: string, party: number): string => `${placeId}|${date}|${time}|${party}`;

export const LEDGER_KEY = "maitre-ledger";
const KEEP_SECONDS = 400 * 24 * 3600;
const MAX_KEPT = 300;
/** A planned entry this fresh is someone's attempt in progress (a Handoff open): a second one waits for it. */
const LIVE_MS = 20 * 60_000;

export class DuplicateBooking extends Error {
  readonly existing: LedgerEntry;
  constructor(existing: LedgerEntry) {
    super(`a booking for ${existing.key} is already ${existing.state}`);
    this.existing = existing;
  }
}

/** A recent email, as the mailbox keeps it (src/mail.ts RecentMail). */
export interface MailLine {
  at: number;
  from: string;
  subject: string;
  preview: string;
}

const fold = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Whether an email reads like the engine's confirmation of this booking: the restaurant named, a confirmation word, and the day. */
export function confirmsBooking(m: MailLine, e: Pick<LedgerEntry, "name" | "date" | "engine">): boolean {
  const text = fold(`${m.from} ${m.subject} ${m.preview}`);
  const name = fold(e.name).replace(/^(restaurante?|bar)\s+/, "");
  if (name.length < 3 || !text.includes(name)) return false;
  if (!/confirm|reserva|booking|reservation|r[eé]servation/.test(text)) return false;
  const [y, mo, d] = e.date.split("-");
  const day = String(Number(d));
  const forms = [e.date, `${d}/${mo}/${y}`, `${d}-${mo}-${y}`, `${day}/${Number(mo)}/${y}`, `${d}/${mo}`, `${d}.${mo}.${y}`];
  const months = [
    ["january", "enero", "gener", "janvier"], ["february", "febrero", "febrer", "fevrier"], ["march", "marzo", "marc", "mars"], ["april", "abril", "avril"],
    ["may", "mayo", "maig", "mai"], ["june", "junio", "juny", "juin"], ["july", "julio", "juliol", "juillet"], ["august", "agosto", "agost", "aout"],
    ["september", "septiembre", "setembre", "septembre"], ["october", "octubre", "octobre"], ["november", "noviembre", "novembre"], ["december", "diciembre", "desembre", "decembre"],
  ][Number(mo) - 1] ?? [];
  if (forms.some((f) => text.includes(f))) return true;
  return months.some((mn) => new RegExp(`\\b${day}\\b[^\\d]{0,6}(de )?${mn.slice(0, 3)}|${mn.slice(0, 3)}[a-z]*\\.? ${day}\\b`).test(text));
}

export interface LedgerDeps {
  kv: Kv | null;
  now?: () => number;
  /** The recent emails Pako reads (its inbox and the owner's mailbox): where an engine's confirmation shows up. */
  recentMail?: () => Promise<MailLine[]>;
}

export function createLedger(d: LedgerDeps) {
  const now = d.now ?? Date.now;
  let memory: LedgerEntry[] | null = null;
  // Every change runs one at a time: two presses of Book must not both find the key free.
  let chain: Promise<unknown> = Promise.resolve();
  const lock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  /** The entries. A store that cannot be read THROWS: nothing is submitted without knowing what was. */
  const load = async (): Promise<LedgerEntry[]> => {
    if (memory) return memory;
    const raw = d.kv ? await d.kv.get(LEDGER_KEY) : null;
    let list: LedgerEntry[] = [];
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) list = parsed.filter((e): e is LedgerEntry => !!e && typeof e.id === "string" && typeof e.key === "string" && typeof e.state === "string");
    } catch {
      list = [];
    }
    memory = list;
    return list;
  };
  const save = async (list: LedgerEntry[]): Promise<void> => {
    const kept = list.slice(-MAX_KEPT);
    if (d.kv) await d.kv.set(LEDGER_KEY, JSON.stringify(kept), KEEP_SECONDS);
    memory = kept;
  };
  const change = (id: string, fn: (e: LedgerEntry) => void): Promise<LedgerEntry | null> =>
    lock(async () => {
      const list = [...(await load())];
      const i = list.findIndex((e) => e.id === id);
      if (i < 0) return null;
      const e = { ...list[i]! };
      fn(e);
      e.updated = now();
      list[i] = e;
      await save(list);
      return e;
    });

  /** What stands in the way of a new attempt for this key: a submitted or confirmed booking, or a live attempt (a Handoff open). */
  const blocking = (list: LedgerEntry[], key: string, except?: string): LedgerEntry | undefined =>
    list.find((e) => e.key === key && e.id !== except && (e.state === "submitted" || e.state === "confirmed" || (e.state === "planned" && now() - e.updated < LIVE_MS)));

  return {
    list: async (): Promise<LedgerEntry[]> => [...(await load())],
    get: async (id: string): Promise<LedgerEntry | undefined> => (await load()).find((e) => e.id === id),

    /** The engine's confirmation already in the inbox for this booking, if the mail shows one. */
    inboxConfirmation: async (e: Pick<LedgerEntry, "name" | "date" | "engine">): Promise<MailLine | null> => {
      if (!d.recentMail) return null;
      try {
        return (await d.recentMail()).find((m) => confirmsBooking(m, e)) ?? null;
      } catch {
        return null;
      }
    },

    /**
     * A new attempt: refused (DuplicateBooking) when this key is submitted, confirmed or being finished. A store that cannot be read throws
     * too, and nothing is attempted.
     */
    plan: (p: Omit<LedgerEntry, "id" | "key" | "state" | "at" | "updated">): Promise<LedgerEntry> =>
      lock(async () => {
        const list = [...(await load())];
        const key = ledgerKey(p.placeId, p.date, p.time, p.party);
        const there = blocking(list, key);
        if (there) throw new DuplicateBooking(there);
        const e: LedgerEntry = { ...p, id: randomBytes(5).toString("hex"), key, state: "planned", at: now(), updated: now() };
        list.push(e);
        await save(list);
        return e;
      }),

    /** Right before the press that submits: checked again under the lock, then written as submitted. Throws DuplicateBooking otherwise. */
    submitting: (id: string): Promise<LedgerEntry> =>
      lock(async () => {
        const list = [...(await load())];
        const i = list.findIndex((e) => e.id === id);
        if (i < 0) throw new Error("ledger: no such attempt");
        const e = list[i]!;
        if (e.state !== "planned") throw new DuplicateBooking(e);
        const there = blocking(list, e.key, e.id);
        if (there) throw new DuplicateBooking(there);
        const next = { ...e, state: "submitted" as const, submittedAt: now(), updated: now() };
        list[i] = next;
        await save(list);
        return next;
      }),

    confirm: (id: string, evidence: Evidence) => change(id, (e) => ((e.state = "confirmed"), (e.evidence = evidence), delete e.handoff, delete e.reason)),
    /** A failure. A submitted entry stays submitted unless `proof` says nothing went through (the page showed the gate on the same form). */
    fail: (id: string, reason: string, proof = false) =>
      change(id, (e) => {
        e.reason = reason;
        delete e.handoff;
        if (e.state === "planned" || proof) e.state = "failed";
      }),
    /** A gate stopped the attempt before anything was taken: the owner finishes it in a Handoff. */
    handoff: (id: string, reason: string) => change(id, (e) => ((e.state = "planned"), (e.handoff = true), (e.reason = reason))),
    cancel: (id: string) => change(id, (e) => ((e.state = "cancelled"), delete e.handoff)),
    /** Submitted or confirmed bookings in the last 24 h (the day's limit) and for one restaurant (once a day). */
    lastDay: async (): Promise<LedgerEntry[]> => (await load()).filter((e) => (e.state === "submitted" || e.state === "confirmed") && now() - (e.submittedAt ?? e.at) < 24 * 3600_000),
  };
}

export type Ledger = ReturnType<typeof createLedger>;
