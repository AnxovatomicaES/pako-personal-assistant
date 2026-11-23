// The Concierge: for one restaurant, which lane books it, in this order, and what a typed failure means for the next one.
//
//   Passport   what Pako remembers about the restaurant (engine, page, required fields, gates seen, last success, time taken)
//   Cartridge  the engine's script, headless, in Pako's own browser profile (cartridge.ts)
//   Handoff    a gate is the owner's: the window opens at that step, everything filled (handoff.ts)
//   Off-web    today's routes: the email from Pako's inbox, the restaurant's WhatsApp, its phone (src/booking.ts)
//
// Never a blind retry: a "no_slot" goes back to the owner with the real free times, a "changed" page goes to Off-web, a gate or a bot wall
// to Handoff, and a submit whose answer was lost stops there (the inbox will say), because a second try could book twice.

import { join } from "node:path";
import type { Kv } from "../kv.ts";
import type { Page, PagePool } from "./cdp.ts";
import { mismatchOf, policyOf, type BookResult, type Cartridge, type CartridgeContext, type Evidence, type GateKind, type Guest, type LookQuery, type LookResult, type Slot } from "./cartridge.ts";
import { CARTRIDGES, cartridgeFor } from "./cartridges/index.ts";
import { forkLink } from "./cartridges/thefork.ts";
import { tableLink } from "./cartridges/opentable.ts";
import { createHandoffs, type HandoffEnd, type HandoffReason } from "./handoff.ts";
import { createLedger, DuplicateBooking, type LedgerEntry, type MailLine } from "./ledger.ts";
import { readJsonRecord } from "../json-record.ts";

export type Lane = "passport" | "cartridge" | "handoff" | "offweb";

export interface Passport {
  engine: string;
  url: string;
  /** The cartridge version that last worked here. */
  version: number;
  required: (keyof Guest)[];
  gates: GateKind[];
  lastSuccess?: number;
  /** The last few booking times (ms), for the median. */
  times: number[];
  /** The last failures' reasons, newest last (a page that changed twice in a row turns the cartridge off here for a day). */
  failures: { at: number; reason: string }[];
}

const PASSPORT_KEY = "maitre-passports";
const LOOK_CACHE_MS = 5 * 60_000;
const DAY_MS = 24 * 3600_000;

/** The lanes for a restaurant, in order. Pure: what the planner tries, given what is known. */
export function planLanes(o: { engine: string | null; hasCartridge: boolean; passport?: Passport; now: number }): Lane[] {
  if (o.engine && policyOf(o.engine).handoffOnly) return ["handoff", "offweb"];
  const lanes: Lane[] = [];
  if (o.passport) lanes.push("passport");
  const broken = (o.passport?.failures ?? []).filter((f) => f.reason === "changed" && o.now - f.at < DAY_MS).length >= 2;
  if (o.hasCartridge && !broken) lanes.push("cartridge");
  if (o.hasCartridge || o.engine) lanes.push("handoff");
  lanes.push("offweb");
  return lanes;
}

/** Where a cartridge's answer sends the attempt next. Pure, and the only place this is decided. */
export function nextLane(r: BookResult): "done" | "handoff" | "offweb" | "ask" | "stop" {
  switch (r.kind) {
    case "confirmed":
      return "done";
    case "gate":
    case "blocked":
      return "handoff";
    case "no_slot":
      return "ask";
    case "changed":
      return "offweb";
    case "timeout":
      return r.submitted ? "stop" : "handoff";
  }
}

export function medianMs(times: number[]): number | undefined {
  if (!times.length) return undefined;
  const s = [...times].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** What Maître answers to one booking. */
export type BookOutcome =
  | { kind: "confirmed"; entry: LedgerEntry; evidence: Evidence; ms: number; mismatch?: string }
  | { kind: "handoff"; entry: LedgerEntry; reason: HandoffReason; detail: string }
  | { kind: "no_slot"; alternatives: Slot[] }
  | { kind: "duplicate"; entry?: LedgerEntry; mail?: MailLine }
  | { kind: "unknown"; entry: LedgerEntry; detail: string }
  | { kind: "offweb"; reason: string }
  | { kind: "limit"; reason: "rate" };

export type LookOutcome = LookResult | { kind: "skipped"; detail: string };

export interface BookRequest {
  placeId: string;
  name: string;
  url: string;
  date: string;
  time: string;
  party: number;
  zone?: string;
  guest: Guest;
}

export interface MaitreDeps {
  kv: Kv | null;
  pool: PagePool;
  now?: () => number;
  cartridges?: Cartridge[];
  recentMail?: () => Promise<MailLine[]>;
  /** Where the confirmations' screenshots go: <PAKO_HOME>/maitre. */
  dir?: string;
  /** Each step's timeout (ms). */
  stepMs?: number;
  /** The whole Book's deadline (ms). */
  bookMs?: number;
  /** A Handoff that ended by itself (confirmation seen, or time ran out): for the owner's chat. */
  onHandoffEnd?: (end: HandoffEnd) => void | Promise<void>;
  handoffWatchMs?: number;
  handoffEveryMs?: number;
  /** Waits between page loads on one engine (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

export function createMaitre(d: MaitreDeps) {
  const now = d.now ?? Date.now;
  const list = d.cartridges ?? CARTRIDGES;
  const stepMs = d.stepMs ?? 15_000;
  const bookMs = d.bookMs ?? 150_000;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const ledger = createLedger({ kv: d.kv, now, ...(d.recentMail ? { recentMail: d.recentMail } : {}) });
  const shot = (id: string): string | undefined => (d.dir ? join(d.dir, "shots", `${id}.png`) : undefined);
  const handoffs = createHandoffs({
    pool: d.pool,
    ledger,
    ...(d.onHandoffEnd ? { onEnd: d.onHandoffEnd } : {}),
    ...(d.handoffWatchMs ? { watchMs: d.handoffWatchMs } : {}),
    ...(d.handoffEveryMs ? { everyMs: d.handoffEveryMs } : {}),
    ...(d.dir ? { shotPath: (id: string) => shot(id)! } : {}),
  });

  // ---------- Passports ----------
  let passports: Record<string, Passport> | null = null;
  const readPassports = async (): Promise<Record<string, Passport>> => {
    if (passports) return passports;
    try {
      const raw = d.kv ? await readJsonRecord(d.kv, PASSPORT_KEY) : null;
      const p = raw ? (raw as unknown) : {};
      passports = p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, Passport>) : {};
    } catch {
      /* not JSON, or the store did not answer: no passports */
      passports = {};
    }
    return passports;
  };
  const writePassport = async (placeId: string, fn: (p: Passport) => void, base: Omit<Passport, "times" | "failures" | "gates">): Promise<void> => {
    const all = await readPassports();
    const p: Passport = all[placeId] ?? { ...base, gates: [], times: [], failures: [] };
    p.engine = base.engine;
    p.url = base.url;
    p.version = base.version;
    p.required = base.required;
    fn(p);
    p.times = p.times.slice(-5);
    p.failures = p.failures.slice(-5);
    all[placeId] = p;
    // Keep the store small: the restaurants used most recently.
    const ids = Object.keys(all);
    if (ids.length > 300) delete all[ids[0]!];
    await d.kv?.set(PASSPORT_KEY, JSON.stringify(all), 400 * 24 * 3600).catch(() => undefined);
  };

  // ---------- pace: a person's pace on each engine ----------
  const lastLoad = new Map<string, number>();
  const loads = new Map<string, number[]>();
  const queue = new Map<string, Promise<unknown>>();
  /** Runs one page load on an engine after the engine's gap; false (nothing run) when the hour's budget is spent. */
  const paced = <T>(engine: string, fn: () => Promise<T>): Promise<T | "rate"> => {
    const pol = policyOf(engine);
    const prev = queue.get(engine) ?? Promise.resolve();
    const run = prev.then(async () => {
      const hour = (loads.get(engine) ?? []).filter((t) => now() - t < 3600_000);
      if (hour.length >= pol.maxPerHour) return "rate" as const;
      const wait = (lastLoad.get(engine) ?? 0) + pol.minGapMs - now();
      if (wait > 0) await sleep(wait);
      lastLoad.set(engine, now());
      loads.set(engine, [...hour, now()]);
      return fn();
    });
    queue.set(engine, run.catch(() => undefined));
    return run;
  };

  // ---------- Look ----------
  const looks = new Map<string, { at: number; result: Promise<LookOutcome> }>();
  const lookOne = (c: { url: string }, q: LookQuery): Promise<LookOutcome> => {
    const cart = cartridgeFor(c.url, list);
    if (!cart) return Promise.resolve({ kind: "skipped", detail: "no cartridge for this engine" });
    if (policyOf(cart.engine).handoffOnly) return Promise.resolve({ kind: "skipped", detail: `${cart.engine} is handoff-only` });
    // One look per restaurant, day and party in five minutes: the times of a whole day come back at once.
    const key = `${c.url}|${q.date}|${q.party}`;
    const hit = looks.get(key);
    if (hit && now() - hit.at < LOOK_CACHE_MS) return hit.result;
    const result = paced(cart.engine, () =>
      d.pool.withPage((page) => cart.look(ctx(page, c.url, async () => {
        throw new Error("look never submits");
      }), q)),
    ).then((r): LookOutcome => (r === "rate" ? { kind: "skipped", detail: "rate limit" } : r))
      .catch((err: Error): LookOutcome => ({ kind: "timeout", detail: err.message.slice(0, 200) }));
    looks.set(key, { at: now(), result });
    // A failed look is not kept: the next request may look again (once the gap allows).
    void result.then((r) => {
      if (r.kind !== "slots") looks.delete(key);
    });
    for (const [k, v] of looks) if (now() - v.at >= LOOK_CACHE_MS) looks.delete(k);
    return result;
  };

  const ctx = (page: Page, url: string, submitting: () => Promise<void>, extra: Partial<CartridgeContext> = {}): CartridgeContext => ({ page, url, submitting, stepMs, ...extra });

  /** The deep link a Handoff opens for a bot wall or an engine only the owner may use: the restaurant's page with the date, time and party. */
  const deepLink = (cart: Cartridge | null, url: string, s: Slot): string =>
    cart?.engine === "TheFork" ? forkLink(url, s) : cart?.engine === "OpenTable" ? tableLink(url, s) : url;

  const handOff = async (entry: LedgerEntry, cart: Cartridge, reason: HandoffReason, detail: string, slot: Slot, guest: Guest): Promise<BookOutcome> => {
    const e = (await ledger.handoff(entry.id, `${reason}: ${detail}`)) ?? entry;
    await handoffs.start(e, cart, reason, async (page) => {
      if (reason === "blocked" || reason === "handoff_only") {
        await page.goto(deepLink(cart, entry.url, slot), stepMs * 2);
        return;
      }
      // Everything filled up to the gate; the press that submits stays the owner's (it may bring the gate up again).
      await cart.book(ctx(page, entry.url, async () => {
        throw new Error("a Handoff never submits for the owner");
      }, { stopBeforeSubmit: true }), slot, guest);
    });
    return { kind: "handoff", entry: e, reason, detail };
  };

  return {
    ledger,
    handoffs,

    /** The engine of a restaurant's booking page when Maître has a cartridge for it, else null. */
    handles: (url: string | undefined): string | null => cartridgeFor(url, list)?.engine ?? null,
    passport: async (placeId: string): Promise<Passport | undefined> => (await readPassports())[placeId],
    lanes: async (placeId: string, url: string): Promise<Lane[]> => {
      const cart = cartridgeFor(url, list);
      const passport = (await readPassports())[placeId];
      return planLanes({ engine: cart?.engine ?? null, hasCartridge: !!cart, ...(passport ? { passport } : {}), now: now() });
    },

    /** Read-only: the free slots at each candidate, all at once, each engine at a person's pace, cached five minutes. */
    look: async (candidates: { placeId: string; url: string }[], q: LookQuery): Promise<Map<string, LookOutcome>> => {
      const out = await Promise.all(candidates.map(async (c) => [c.placeId, await lookOne(c, q)] as const));
      return new Map(out);
    },

    /** Books one slot through the lanes. Only called on the owner's own order or press. */
    async book(r: BookRequest): Promise<BookOutcome> {
      const started = now();
      const passport = (await readPassports())[r.placeId];
      const url = passport && cartridgeFor(passport.url, list) ? passport.url : r.url;
      const cart = cartridgeFor(url, list);
      const lanes = planLanes({ engine: cart?.engine ?? null, hasCartridge: !!cart, ...(passport ? { passport } : {}), now: now() });
      if (!cart) return { kind: "offweb", reason: "no cartridge for this engine" };
      const missing = cart.required.filter((k) => !String(r.guest[k] ?? "").trim());
      if (missing.length) return { kind: "offweb", reason: `missing ${missing.join(", ")}` };
      const slot: Slot = { date: r.date, time: r.time, party: r.party, ...(r.zone ? { zone: r.zone } : {}) };
      // The engine's confirmation already in the inbox: it is booked (by the owner, or by an earlier try whose answer was lost).
      const mail = await ledger.inboxConfirmation({ placeId: r.placeId, name: r.name, date: r.date, time: r.time, engine: cart.engine });
      if (mail) return { kind: "duplicate", mail };
      let entry: LedgerEntry;
      try {
        entry = await ledger.plan({ placeId: r.placeId, name: r.name, engine: cart.engine, url, date: r.date, time: r.time, party: r.party, guest: `${r.guest.firstName} ${r.guest.lastName}`.trim() });
      } catch (err) {
        if (err instanceof DuplicateBooking) return { kind: "duplicate", entry: err.existing };
        throw err;
      }
      const base = { engine: cart.engine, url, version: cart.version, required: cart.required };
      if (!lanes.includes("cartridge")) {
        const reason: HandoffReason = policyOf(cart.engine).handoffOnly ? "handoff_only" : "blocked";
        return handOff(entry, cart, reason, lanes.includes("handoff") ? "the cartridge is off for this restaurant" : "", slot, r.guest);
      }
      // The ledger's word right before the press that submits: a refusal there means another attempt got in first.
      let refused: DuplicateBooking | null = null;
      let submitted = false;
      // The whole-booking deadline below ends this run for good: a step that was only slow must not press anything later, with the entry
      // already handed over (planned again) or its window opened.
      let stopped = false;
      let tab: Page | undefined;
      const submitting = async (): Promise<void> => {
        if (stopped) throw new Error("the booking took too long and was stopped");
        try {
          entry = await ledger.submitting(entry.id);
          submitted = true;
        } catch (err) {
          if (err instanceof DuplicateBooking) refused = err;
          throw err;
        }
      };
      const shotPath = shot(entry.id);
      const run = paced(cart.engine, () => d.pool.withPage((page) => {
        if (stopped) throw new Error("the booking took too long and was stopped");
        tab = page;
        return cart.book(ctx(page, url, submitting, shotPath ? { shotPath } : {}), slot, r.guest);
      }));
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<BookResult>((res) => {
        timer = setTimeout(() => {
          // The losing run is stopped, not left to go on: its tab is closed (every step it takes then fails) and its press is refused above.
          stopped = true;
          void Promise.resolve().then(() => tab?.close()).catch(() => undefined);
          res({ kind: "timeout", detail: "the whole booking took too long", submitted });
        }, bookMs);
      });
      let result: BookResult | "rate";
      try {
        result = await Promise.race([run, deadline]);
      } catch (err) {
        result = { kind: "timeout", detail: (err as Error).message.slice(0, 200), submitted };
      } finally {
        clearTimeout(timer);
      }
      if (refused) {
        await ledger.fail(entry.id, "duplicate", true);
        return { kind: "duplicate", entry: (refused as DuplicateBooking).existing };
      }
      if (result === "rate") {
        await ledger.fail(entry.id, "rate");
        return { kind: "limit", reason: "rate" };
      }
      // Whatever the result says, a submit that went out and has no confirmation is never "failed": it may have booked.
      if (result.kind !== "confirmed" && submitted && !(result.kind === "gate" && !result.submitted)) result = { kind: "timeout", detail: "detail" in result ? result.detail : "", submitted: true };
      const next = nextLane(result);
      const ms = now() - started;
      switch (result.kind) {
        case "confirmed": {
          const e = (await ledger.confirm(entry.id, result.evidence)) ?? entry;
          await writePassport(r.placeId, (p) => ((p.lastSuccess = now()), p.times.push(ms)), base);
          const off = mismatchOf(result.evidence.said, r);
          return { kind: "confirmed", entry: e, evidence: result.evidence, ms, ...(off ? { mismatch: off } : {}) };
        }
        case "gate":
          await writePassport(r.placeId, (p) => void (p.gates.includes(result.gate) || p.gates.push(result.gate)), base);
          return handOff(entry, cart, result.gate, result.detail, slot, r.guest);
        case "blocked":
          await writePassport(r.placeId, (p) => p.failures.push({ at: now(), reason: "blocked" }), base);
          return handOff(entry, cart, "blocked", result.detail, slot, r.guest);
        case "no_slot":
          await ledger.fail(entry.id, "no_slot");
          return { kind: "no_slot", alternatives: result.alternatives };
        case "changed":
          await ledger.fail(entry.id, `changed: ${result.detail}`);
          await writePassport(r.placeId, (p) => p.failures.push({ at: now(), reason: "changed" }), base);
          return { kind: "offweb", reason: result.detail };
        case "timeout":
          if (next === "stop") {
            await ledger.fail(entry.id, `timeout after submit: ${result.detail}`);
            return { kind: "unknown", entry: (await ledger.get(entry.id)) ?? entry, detail: result.detail };
          }
          return handOff(entry, cart, "timeout", result.detail, slot, r.guest);
      }
    },

    /** Whether Undo can cancel this booking from Pako: a cartridge with a cancel, and a cancel page the confirmation gave. */
    cancellable: (e: LedgerEntry): boolean => e.state === "confirmed" && !!e.evidence?.cancelUrl && !!cartridgeFor(e.url, list)?.cancel,

    /** The owner said "done" for a Handoff. */
    done: (entryId: string) => handoffs.done(entryId),

    /**
     * Undo: cancels a confirmed booking through the engine's own cancel page when the cartridge has a cancel and the confirmation gave its
     * link. Otherwise it says how (the link, or the engine's email).
     */
    async cancel(entryId: string): Promise<{ ok: true; entry: LedgerEntry } | { ok: false; entry?: LedgerEntry; how?: string }> {
      const e = await ledger.get(entryId);
      if (!e || e.state !== "confirmed" || !e.evidence) return e ? { ok: false, entry: e } : { ok: false };
      const cart = cartridgeFor(e.url, list);
      const how = e.evidence.cancelUrl;
      if (!cart?.cancel || !how) return { ok: false, entry: e, ...(how ? { how } : {}) };
      const done = await paced(cart.engine, () => d.pool.withPage((page) => cart.cancel!(ctx(page, e.url, async () => undefined), e.evidence!)))
        .catch(() => false as const);
      if (done !== true) return { ok: false, entry: e, how };
      return { ok: true, entry: (await ledger.cancel(entryId)) ?? e };
    },
  };
}

export type Maitre = ReturnType<typeof createMaitre>;
