// Durable jobs: the one clock for what Pako does at a time (the morning brief, reminders, routines, follow-up checks), kept as rows in the
// store so that a computer that sleeps, or a server that restarts, neither loses a run nor gives one twice. The ideas are DBOS's and Absurd's
// (durable sleep stored as a wake-up time, idempotency keys, a recovery scan), rebuilt on Pako's own key-value store: one small table under
// one key, no engine and no database.
//
// A row is one planned run: {id, kind, dueAt, slot, state, attempts, lastError}. `slot` is its idempotency key ("brief:2026-11-17",
// "reminder:ab12cd34@1763362800000"): one row per slot, ever. The runner ticks every 30 s, and notices a wake (a tick more than 2 minutes after
// the last one began and ended: the laptop slept, or the process was stopped; a look that was only slow is not one). Each kind's own sweep has
// its own guard. Each tick plans the slots that are due, claims each one on the store (pending -> running, written and read back), runs it
// and records done. Before the table is touched, the slot is taken on the store with an atomic "write only if empty" (Redis SET NX, Kv.add),
// under its own key and for the lease: two servers on one store at the same moment (a deploy's overlap) cannot both take it, and the loser
// says "busy" as for any held slot. A store without `add` (the tests' stand-ins) keeps the one-process guard. A run that crashed half way is found running with no live
// owner and run again under the same slot; whatever it already did is marked on the row (`once`), so the retry does not do it again.
//
// What happens to a run that comes late is each kind's own rule (its `policy`): the brief only until 11:00, a reminder up to 12 hours with
// a note, a routine never (said once), a follow-up check always, a proactive check never. `slept(at)` says whether a moment fell while this
// computer was asleep (or Pako was not running): only on a computer (`sleeps`); a hosted server, always on, behaves as before.

import { createHash, randomBytes } from "node:crypto";
import type { Kv } from "./kv.ts";
import { createLog } from "./log.ts";
import { readJsonRecord } from "./json-record.ts";

const log = createLog("jobs");

export const JOBS_KEY = "jobs";
/** How long a finished row is kept: a slot done must still be known as done after any restart that could plan it again. */
const KEEP_S = 8 * 24 * 3600;
const KEEP_MS = KEEP_S * 1000;
/** At most this many rows: the oldest finished ones go first. */
const ROWS_MAX = 400;
export const TICK_MS = 30_000;
/** Two ticks further apart than this: the computer slept (or the process was stopped) in between. */
export const WAKE_GAP_MS = 2 * 60_000;
/** A run less late than this is on time: a busy moment, not a sleep. */
export const GRACE_MS = 5 * 60_000;
/** A row running for longer than this with no live owner here is taken as crashed, and run again. */
const LEASE_MS = 10 * 60_000;
/** The store key that takes one slot for one process (Kv.add), for the lease: the slot hashed, as a slot can be long. */
export const claimKey = (slot: string): string => `job-claim:${createHash("sha256").update(slot).digest("hex").slice(0, 32)}`;
/** A run that throws this many times is given up (missed, with its last error). A "retry" the run asks for itself does not count. */
const MAX_ERRORS = 5;
/** The sleeps remembered: enough for a few days of nights. */
const WINDOWS_MAX = 20;

/**
 * Whether a timer's run comes late: it last ran at `last` and should run every `everyMs`, and the gap is longer than that by more than a
 * wake gap (the computer slept through its time). A kind that never runs late (the proactive check) lets such a run go.
 */
export const lateTick = (last: number, t: number, everyMs: number, gapMs: number = WAKE_GAP_MS): boolean => last > 0 && t - last > everyMs + gapMs;

export type JobState = "pending" | "running" | "done" | "missed";

export interface Job {
  id: string;
  kind: string;
  dueAt: number;
  slot: string;
  state: JobState;
  attempts: number;
  lastError?: string;
  /** Which process claimed it, and when: a run that crashed is told by an owner that is not alive here and a claim older than the lease. */
  owner?: string;
  claimedAt?: number;
  /** The claim's own mark: the claim reads it back. */
  stamp?: string;
  /** When it ended (done or missed): finished rows are kept KEEP_MS after it. */
  endedAt?: number;
  /** The side effects already done for this slot (`once`): a retry skips them. */
  effects?: string[];
  /** Errors thrown so far (a "retry" asked for by the run is not one). */
  errors?: number;
}

/** What a run is given. */
export interface RunCtx {
  job: Job;
  /** How late it runs, in ms (0 when on time). */
  late: number;
  /** Whether its time fell while the computer was asleep (or Pako was not running): only on a computer. */
  slept: boolean;
  /** Its time came before this process started (Pako was not running, or the computer was off): not a sleep seen. Only on a computer. */
  off: boolean;
  /**
   * A side effect done at most once for this slot: when the row says it was done (a retry after a crash), `fn` is not called and the answer
   * is true. `fn` answers whether it happened; only then is it marked.
   */
  once: (name: string, fn: () => Promise<boolean>) => Promise<boolean>;
}

/** "run": now, however late; "skip": the slot is missed (its `missed` is told). */
export type Policy = (o: { job: Job; now: number; late: number; slept: boolean }) => "run" | "skip";

export interface JobKind {
  kind: string;
  /** The slots due by `t` that must exist (a planned kind: the brief). Called every tick; a slot already there is left as it is. */
  plan?: (t: number) => { slot: string; dueAt: number }[];
  /** The rule for a late run; without one every run goes, late or not. */
  policy?: Policy;
  /** The run of a planned slot: "retry" leaves it pending for the next tick. */
  run?: (c: RunCtx) => Promise<void | "retry">;
  /** A planned slot skipped by its policy; `off`: its time came before this process started (no sleep was seen). */
  missed?: (job: Job, o: { off: boolean }) => Promise<void>;
  /** A look of its own on every tick, after the planned slots (the kinds that keep their own list: reminders, routines, follow-ups). */
  sweep?: () => Promise<unknown>;
}

export type SlotOutcome = "done" | "missed" | "retry" | "busy";

export interface JobsDeps {
  kv: Kv | null;
  now?: () => number;
  /** On a person's computer (local mode): it sleeps, so late runs follow their kind's rule and their notes. False on a hosted server. */
  sleeps: boolean;
  tickMs?: number;
  wakeGapMs?: number;
  /** This process's id on its claims (the tests give two runners two ids, as two processes). */
  owner?: string;
  /**
   * A clock that stops while the computer sleeps (the default: performance.now, which pauses in a sleep on macOS and Linux). A tick whose
   * work took long by `now` but not by this one slept in between; long by both, it was only slow (offline, waiting for timeouts). With an
   * injected `now` and no `mono`, `now` is used: a long tick then reads as slow, never as a sleep.
   */
  mono?: () => number;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";
const STATES: readonly JobState[] = ["pending", "running", "done", "missed"];

/** The rows as stored, each checked: a row this version cannot read is dropped, never the whole table. */
/** The table's rows from its record as read (readJsonRecord), or from its JSON text (this process's own copy when there is no store). */
export function readRows(raw: unknown): Job[] {
  let p: unknown = raw;
  if (typeof raw === "string") {
    try {
      p = raw ? JSON.parse(raw) : null;
    } catch {
      log.error("the job table is not valid JSON: starting again");
      p = null;
    }
  }
  const list = Array.isArray(p) ? p : isObject(p) && Array.isArray(p.rows) ? p.rows : [];
  return list.flatMap((x): Job[] => {
    if (!isObject(x) || typeof x.slot !== "string" || typeof x.kind !== "string" || typeof x.dueAt !== "number") return [];
    const state = STATES.includes(x.state as JobState) ? (x.state as JobState) : "pending";
    const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const job: Job = {
      id: typeof x.id === "string" ? x.id : randomBytes(5).toString("hex"),
      kind: x.kind, dueAt: x.dueAt, slot: x.slot.slice(0, 200), state, attempts: num(x.attempts) ?? 0,
    };
    if (typeof x.lastError === "string") job.lastError = x.lastError.slice(0, 300);
    if (typeof x.owner === "string") job.owner = x.owner;
    if (typeof x.stamp === "string") job.stamp = x.stamp;
    const claimedAt = num(x.claimedAt);
    if (claimedAt !== undefined) job.claimedAt = claimedAt;
    const endedAt = num(x.endedAt);
    if (endedAt !== undefined) job.endedAt = endedAt;
    if (Array.isArray(x.effects)) job.effects = x.effects.filter((e): e is string => typeof e === "string").slice(0, 10);
    const errors = num(x.errors);
    if (errors !== undefined) job.errors = errors;
    return [job];
  });
}

export function createJobs(d: JobsDeps) {
  const now = d.now ?? Date.now;
  const tickMs = d.tickMs ?? TICK_MS;
  const wakeGapMs = d.wakeGapMs ?? WAKE_GAP_MS;
  const owner = d.owner ?? randomBytes(6).toString("hex");
  const mono = d.mono ?? (d.now ? now : () => performance.now());
  const kinds = new Map<string, JobKind>();
  /** Without a store (only the tests): the table lives here. */
  let memory: string | null = null;
  const bootAt = now();
  let lastTick = 0;
  /** The sleeps seen: from the last tick before, to the first after. */
  const windows: { from: number; to: number }[] = [];
  /** Slots this process is running right now. */
  const inflight = new Set<string>();

  // One change of the table at a time in this process: read, change, write, read back.
  let chain: Promise<unknown> = Promise.resolve();
  const lock = <R>(fn: () => Promise<R>): Promise<R> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  /** Throws when the store cannot be read: guessing an empty table could run a slot already done. */
  const load = async (): Promise<Job[]> => readRows(d.kv ? await readJsonRecord(d.kv, JOBS_KEY) : memory);
  const save = async (rows: Job[]): Promise<void> => {
    const t = now();
    // A finished row goes KEEP_MS after it ended; one never finished (a reminder held for later, a kind gone) KEEP_MS after it was due.
    const live = rows.filter((r) => !(r.endedAt !== undefined ? t - r.endedAt > KEEP_MS : t - r.dueAt > KEEP_MS));
    // Too many: the oldest finished ones go; pending and running rows always stay.
    // Never one that ended in the last two days, whatever the count: a sweep that plans it again must find it done (audit finding).
    const ended = live.filter((r) => r.endedAt !== undefined && t - r.endedAt > 2 * 24 * 3600_000).sort((a, b) => a.endedAt! - b.endedAt!);
    const drop = new Set(ended.slice(0, Math.max(0, live.length - ROWS_MAX)));
    const kept = live.filter((r) => !drop.has(r));
    const text = JSON.stringify({ v: 1, rows: kept });
    if (d.kv) await d.kv.set(JOBS_KEY, text, KEEP_S);
    else memory = text;
  };
  /** The table changed by `fn`, written, and read back: false when another writer's change is what the store holds now (a lost race). */
  const change = <R>(fn: (rows: Job[]) => R, check?: (rows: Job[]) => boolean): Promise<{ out: R; ok: boolean }> =>
    lock(async () => {
      const rows = await load();
      const out = fn(rows);
      await save(rows);
      const ok = check ? check(await load()) : true;
      return { out, ok };
    });

  /** Whether the moment `at` fell while this computer was asleep, or before this process started (it was off, or Pako was). */
  const slept = (at: number): boolean => {
    if (!d.sleeps) return false;
    // A caller right after a wake (the bridge's poll running reminders) may come before the next look: the wake is noticed here too.
    // Not during a look: a slow look is measured by the look itself (by the clock that stops in a sleep).
    if (!looking) wake(now());
    if (at < bootAt) return true;
    return windows.some((w) => at > w.from && at <= w.to);
  };

  const claimable = (r: Job, t: number): boolean => {
    if (r.state === "pending") return true;
    if (r.state !== "running") return false;
    if (r.owner === owner) return !inflight.has(r.slot);
    return t - (r.claimedAt ?? 0) >= LEASE_MS;
  };

  /**
   * One slot, now: planned if new, skipped by `policy` when it says so, otherwise claimed, run and recorded. "done" also when it was done
   * before (the caller then does not do it again); "busy" when another run holds it, or the store could not be read.
   */
  const slot = async (
    kind: string, key: string, dueAt: number, run: (c: RunCtx) => Promise<void | "retry">, o: { policy?: Policy; missed?: JobKind["missed"] } = {},
  ): Promise<SlotOutcome> => {
    const t = now();
    const late = Math.max(0, t - dueAt);
    const wasAsleep = slept(dueAt);
    const wasOff = !!d.sleeps && dueAt < bootAt;
    const stamp = `${owner}:${t}:${randomBytes(3).toString("hex")}`;
    let claimed: { job: Job; verdict: "run" | "skip" } | "done" | "missed" | "busy";
    let tried = false;
    // The slot taken on the store first, atomically: another process holding it now (or the store refusing) is "busy", tried at a later look.
    const add = d.kv?.add?.bind(d.kv);
    let held = false;
    if (add) {
      // A slot already finished, or held by a live run, needs no claim: no write to the store at every look for a slot done long ago.
      try {
        const was = (await load()).find((x) => x.slot === key);
        if (was && (was.state === "done" || was.state === "missed")) return was.state;
        if (was && !claimable(was, t)) return "busy";
      } catch (err) {
        log.error(`${key.slice(0, 60)} could not be read: ${(err as Error).message}`);
        return "busy";
      }
      try {
        held = await add(claimKey(key), stamp, LEASE_MS / 1000);
      } catch (err) {
        log.error(`${key.slice(0, 60)} could not be taken: ${(err as Error).message}`);
        return "busy";
      }
      if (!held) return "busy";
    }
    /** Lets the slot go (a moment's expiry: the store has no delete), unless the lease ran out and another process holds it now. */
    const release = async (): Promise<void> => {
      if (!held || !d.kv) return;
      held = false;
      try {
        if ((await d.kv.get(claimKey(key))) === stamp) await d.kv.set(claimKey(key), "", 1);
      } catch (err) {
        log.error(`${key.slice(0, 60)} could not be let go (it goes by itself at the lease's end): ${(err as Error).message}`);
      }
    };
    try {
      const r = await change<typeof claimed>((rows) => {
        let job = rows.find((x) => x.slot === key);
        if (!job) {
          job = { id: randomBytes(5).toString("hex"), kind, dueAt, slot: key, state: "pending", attempts: 0 };
          rows.push(job);
        }
        if (job.state === "done" || job.state === "missed") return job.state;
        if (!claimable(job, t)) return "busy";
        const verdict = o.policy ? o.policy({ job, now: t, late, slept: wasAsleep }) : "run";
        if (verdict === "skip") {
          const why = wasOff ? "late: Pako was not running" : wasAsleep ? "late: the computer was asleep" : "late";
          Object.assign(job, { state: "missed", endedAt: t, lastError: why });
          delete job.owner;
          return { job: { ...job }, verdict };
        }
        Object.assign(job, { state: "running", owner, claimedAt: t, attempts: job.attempts + 1, stamp });
        tried = true;
        return { job: { ...job }, verdict };
      }, (rows) => {
        // The read back: nothing was claimed, or what the store holds now is this claim (its stamp), not another writer's.
        return !tried || rows.find((y) => y.slot === key)?.stamp === stamp;
      });
      claimed = r.ok ? r.out : "busy";
    } catch (err) {
      log.error(`${key.slice(0, 60)} could not be claimed: ${(err as Error).message}`);
      await release();
      return "busy";
    }
    if (claimed === "done" || claimed === "missed" || claimed === "busy") {
      await release();
      return claimed;
    }
    const { job, verdict } = claimed;
    if (verdict === "skip") {
      await o.missed?.(job, { off: wasOff }).catch((err: Error) => log.error(`${key.slice(0, 60)}: telling it was missed failed: ${err.message}`));
      await release();
      return "missed";
    }
    inflight.add(key);
    const finish = (fn: (x: Job) => void): Promise<unknown> =>
      change((rows) => {
        const x = rows.find((y) => y.slot === key);
        if (x) fn(x);
      }).catch((err: Error) => log.error(`${key.slice(0, 60)} could not be recorded: ${err.message}`));
    const ctx: RunCtx = {
      job,
      late: late > GRACE_MS ? late : 0,
      slept: wasAsleep,
      off: wasOff,
      once: async (name, fn) => {
        if (job.effects?.includes(name)) return true;
        const happened = await fn();
        if (!happened) return false;
        job.effects = [...(job.effects ?? []), name];
        // Marked before anything else is done: a crash after this line does not do it again.
        await finish((x) => {
          x.effects = [...new Set([...(x.effects ?? []), name])];
        });
        return true;
      },
    };
    try {
      const out = await run(ctx);
      if (out === "retry") {
        await finish((x) => Object.assign(x, { state: "pending", lastError: "not yet" }));
        return "retry";
      }
      await finish((x) => {
        Object.assign(x, { state: "done", endedAt: now() });
        delete x.lastError;
      });
      return "done";
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      log.error(`${key.slice(0, 60)} failed: ${message}`);
      await finish((x) => {
        x.errors = (x.errors ?? 0) + 1;
        x.lastError = message.slice(0, 300);
        if (x.errors >= MAX_ERRORS) Object.assign(x, { state: "missed", endedAt: now() });
        else x.state = "pending";
      });
      return "retry";
    } finally {
      inflight.delete(key);
      await release();
    }
  };

  const sleptWindow = (from: number, to: number): void => {
    windows.push({ from, to });
    if (windows.length > WINDOWS_MAX) windows.shift();
  };
  /** A gap since the last look longer than a wake gap: the computer slept in it. */
  const wake = (t: number): void => {
    if (lastTick && t - lastTick > wakeGapMs) sleptWindow(lastTick, t);
    lastTick = Math.max(lastTick, t);
  };
  let ticking = false;
  /** Looks running now. */
  let looking = 0;
  /** The kinds whose own sweep is running now: each has its own guard, so a slow follow-up look holds up neither reminders nor the brief. */
  const sweeping = new Set<string>();
  /**
   * One look: notices a wake, runs the planned slots due (and any left pending or crashed), then each kind's own sweep, side by side. Never
   * throws. The wake gap is measured from the end of the last look too: a look that was only slow is not a sleep.
   */
  const tick = async (): Promise<void> => {
    const t = now();
    const m0 = mono();
    wake(t);
    looking++;
    const sweeps: Promise<unknown>[] = [];
    try {
      if (!ticking) {
        ticking = true;
        try {
          await planned(t);
        } finally {
          ticking = false;
        }
      }
      for (const k of kinds.values()) {
        if (!k.sweep || sweeping.has(k.kind)) continue;
        sweeping.add(k.kind);
        const run = k.sweep;
        sweeps.push(
          Promise.resolve()
            .then(() => run())
            .catch((err: Error) => log.error(`${k.kind}: ${err.message}`))
            .finally(() => sweeping.delete(k.kind)),
        );
      }
      await Promise.all(sweeps);
    } finally {
      looking--;
      const end = now();
      // Long by the wall clock but not by the one that stops in a sleep: the computer slept during this look.
      if (end - lastTick > wakeGapMs && end - t - (mono() - m0) > wakeGapMs) sleptWindow(lastTick, end);
      lastTick = Math.max(lastTick, end);
    }
  };
  /** The planned slots due by `t`, one kind after another. */
  const planned = async (t: number): Promise<void> => {
    for (const k of kinds.values()) {
      if (!k.plan || !k.run) continue;
      const o = { ...(k.policy ? { policy: k.policy } : {}), ...(k.missed ? { missed: k.missed } : {}) };
      let due: { slot: string; dueAt: number }[] = [];
      try {
        due = k.plan(t).filter((p) => p.dueAt <= t);
      } catch (err) {
        log.error(`${k.kind} could not plan: ${(err as Error).message}`);
      }
      // The recovery scan: a slot of this kind left pending (a retry) or running by a process that is gone, from an earlier plan.
      let left: Job[] = [];
      try {
        left = (await load()).filter((r) => r.kind === k.kind && r.dueAt <= t && claimable(r, t) && !due.some((p) => p.slot === r.slot));
      } catch {
        /* the store could not be read: the planned slots still try, and say so */
      }
      for (const p of [...due, ...left.map((r) => ({ slot: r.slot, dueAt: r.dueAt }))]) await slot(k.kind, p.slot, p.dueAt, k.run, o);
    }
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    sleeps: d.sleeps,
    owner,
    define: (k: JobKind): void => {
      kinds.set(k.kind, k);
    },
    slot,
    slept,
    tick,
    /** The rows as stored now (the panel's health, the tests). */
    rows: (): Promise<Job[]> => load(),
    /** The sleeps seen since this process started. */
    sleepsSeen: (): { from: number; to: number }[] => windows.map((w) => ({ ...w })),
    start: (): void => {
      if (timer) return;
      timer = setInterval(() => void tick().catch((err: Error) => log.error(`${err.message}`)), tickMs);
      timer.unref?.();
    },
    stop: (): void => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export type Jobs = ReturnType<typeof createJobs>;
