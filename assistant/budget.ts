// The budget of the runs of Claude this computer makes by itself: one place that decides whether a background job (an email to triage, a
// meeting to summarize or review, follow-ups to extract, a proactive check, a judge, the morning brief) may start a `claude -p` run now.
//
// - The owner's own runs (their messages, a paper they sent, a Slack search they asked for, their routines, a document asked from the page, a
//   rehearsal) are never refused here. They are only counted, so the day's numbers say where the plan's quota went.
// - A daily cap on background runs (ASSISTANT_BACKGROUND_PER_DAY, 40 by default), counted on this computer's own calendar day. The proactive
//   checks and the judge are the least useful of them: they stop at half the cap, so the rest of it is kept for mail, meetings and the brief.
//   A run that never reached Claude (signed out, the command missing) is not counted: started() gives its count back.
// - Coalescing: a background job whose material is the same as one answered a few minutes ago (ASSISTANT_COALESCE_MIN, 10 by default) gets
//   that answer again instead of a new run. Lines that only say what time it is ("Now: ...", "Ahora: ...") do not count as material.
// - Nothing changed: a proactive check whose material is the same as the last one that found nothing to say gets "nothing to say" again
//   for ASSISTANT_UNCHANGED_MIN (120 by default) without a run.
// - Claude's limit: when a run (any run, the owner's too) says the plan's limit was reached, background work stops until the reset the CLI
//   names (a rate_limit_event's resetsAt, "resets 9pm", or an epoch after a "|"), or for half an hour when it names none. A later run that
//   works ends the pause early. Whether the owner was told of the limit is kept here too (limitTold), so it is said once, not per job or
//   per restart, and "back" is said once when a run works again.
// - The model: the writing kinds (the morning brief, a draft) run on the writing model (ASSISTANT_WRITING_MODEL), the rest on the general one.
//   The day's runs are counted by the model that answered too, and a writing model the account cannot use is set aside until the next day.
//
// A job that is refused here never fails: bridge.ts gives each kind its answer without Claude (an email kept with its first lines, an empty
// review so the server sends Zoom's own summary, "nothing to say", an empty brief so the server sends the brief it builds by itself).
//
// The counts and the pause are kept in the state folder (budget.json), so a restart neither forgets the day nor runs into the limit again.
// The answers kept for coalescing stay in memory: they are other people's words, and a restart losing them only costs one run.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What a run of Claude is for. */
export type RunKind =
  | "message" | "routine" | "paper" | "slack" | "task" | "rehearsal"
  /** A draft for one follow-up (a reply, an email: src/brief-v2.ts draftFor), asked by the owner: a "task" written on the writing model. */
  | "draft"
  | "email" | "meeting" | "review" | "followup" | "proactive" | "judge" | "brief"
  /** Gentle mode's first tiny step for a stuck follow-up (src/gentle.ts): a short verdict, a few a day. */
  | "step"
  /** The catch-up of a newly connected mailbox: its own one-time allowance, paced by the server (src/backfill.ts), never the day's cap. */
  | "backfill";

/** The owner's own: counted, never refused. */
const OWNER: ReadonlySet<RunKind> = new Set<RunKind>(["message", "routine", "paper", "slack", "task", "rehearsal", "draft"]);
/** Background kinds that stop at half the cap. */
const LOW: ReadonlySet<RunKind> = new Set<RunKind>(["proactive", "judge", "step"]);
/** Background kinds whose answer is a short verdict: they get the lighter effort (ASSISTANT_BACKGROUND_EFFORT). */
export const LIGHT: ReadonlySet<RunKind> = new Set<RunKind>(["email", "proactive", "judge", "backfill", "step"]);
/** The kinds whose words the owner reads as written: they run on the writing model (BridgeConfig.writingModel). */
export const WRITING: ReadonlySet<RunKind> = new Set<RunKind>(["brief", "draft"]);
/** Counted apart from the day's background runs and never refused here: the server gives them out one a minute, up to their own allowance. */
const APART: ReadonlySet<RunKind> = new Set<RunKind>(["backfill"]);

export const isOwnerRun = (k: RunKind): boolean => OWNER.has(k);

export interface BudgetConfig {
  /** Background runs a day; 0: none at all (every background job gets its answer without Claude). */
  perDay: number;
  /** How long an answer serves a background job with the same material. */
  coalesceMs: number;
  /** How long "nothing to say" serves a proactive check whose material did not change. */
  unchangedMs: number;
}

export type SkipWhy = "cap" | "paused" | "same";

export interface Usage {
  /** This computer's calendar day, YYYY-MM-DD. */
  day: string;
  interactive: number;
  background: number;
  /** Background jobs answered without a run, by why. */
  skipped: { cap: number; paused: number; same: number };
  /** Runs by kind (today). */
  kinds: Partial<Record<RunKind, number>>;
  /** Runs by the model that answered (today), when the bridge named one. */
  models: Record<string, number>;
  /** Models set aside for today: the account could not use them, so their runs went to the general model. */
  modelsOff: string[];
  /** Background work waits until this time (ms) for Claude's limit; 0 when it does not. */
  pausedUntil: number;
  perDay: number;
}

const DEFAULTS: BudgetConfig = { perDay: 40, coalesceMs: 10 * 60_000, unchangedMs: 120 * 60_000 };
/** When the CLI says the limit was reached but not when it resets. */
const UNKNOWN_RESET_MS = 30 * 60_000;
/** A reset further away than this is not believed (a misread date): the pause is this long at most, then a run finds out. */
const MAX_PAUSE_MS = 8 * 24 * 3600_000;
const CACHE_MAX = 60;

export function loadBudgetConfig(env: Record<string, string | undefined>): { config: BudgetConfig; problems: string[] } {
  const problems: string[] = [];
  const num = (key: string, fallback: number, min: number, max: number): number => {
    const raw = (env[key] ?? "").trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${key} must be a whole number from ${min} to ${max} (${fallback} is used)`);
      return fallback;
    }
    return n;
  };
  return {
    config: {
      perDay: num("ASSISTANT_BACKGROUND_PER_DAY", DEFAULTS.perDay, 0, 1000),
      coalesceMs: num("ASSISTANT_COALESCE_MIN", DEFAULTS.coalesceMs / 60_000, 0, 240) * 60_000,
      unchangedMs: num("ASSISTANT_UNCHANGED_MIN", DEFAULTS.unchangedMs / 60_000, 0, 720) * 60_000,
    },
    problems,
  };
}

/**
 * When Claude's limit resets, as the CLI says it, or null when it says no time. Read: an epoch in seconds after a "|" (older Claude Code:
 * "Claude AI usage limit reached|1763600000"), and "resets 9pm", "resets 9:30 pm", "resets at 21:00", "resets Nov 20, 5am" (this computer's
 * own clock: the CLI says it in the zone it runs in). A time already past today is tomorrow's.
 */
export function resetAt(message: string, now: number): number | null {
  const epoch = /\|\s*(\d{10})\b/.exec(message);
  if (epoch) return Number(epoch[1]) * 1000;
  const m = /resets?\s+(?:at\s+)?(?:([A-Z][a-z]{2,8})\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(message);
  if (!m) return null;
  let hour = Number(m[3]);
  const minute = m[4] ? Number(m[4]) : 0;
  const half = m[5]?.toLowerCase();
  if (!half && !m[4]) return null; // "resets 5" says nothing sure
  if (hour > 23 || minute > 59 || (half && (hour < 1 || hour > 12))) return null;
  if (half === "pm" && hour < 12) hour += 12;
  if (half === "am" && hour === 12) hour = 0;
  const at = new Date(now);
  at.setSeconds(0, 0);
  at.setHours(hour, minute);
  if (m[1] && m[2]) {
    const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (month < 0) return null;
    at.setMonth(month, Number(m[2]));
    if (at.getTime() < now - 24 * 3600_000) at.setFullYear(at.getFullYear() + 1);
    return at.getTime();
  }
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The material of a job as it is compared: without the lines that only say what time it is now. */
export function materialKey(kind: RunKind, material: string): string {
  const kept = material.split("\n").filter((l) => !/^\s*\[?\s*(now|ahora)\s*:/i.test(l)).join("\n");
  return createHash("sha256").update(`${kind}\n${kept}`).digest("hex");
}

interface Saved {
  day: string;
  kinds: Partial<Record<RunKind, number>>;
  models: Record<string, number>;
  modelsOff: string[];
  skipped: Usage["skipped"];
  pausedUntil: number;
  /** The owner was told Claude is at its limit, and not yet that it is back. */
  told?: boolean;
}

const localDay = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
/** The start of the next calendar day on this computer (a day of 23 or 25 hours at a clock change included). */
const nextDay = (t: number): number => {
  const d = new Date(t);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
};

/** `until`: when the refusal ends (ms): Claude's reset for a pause, the start of tomorrow for the cap. */
export type Admission = { go: true; key: string } | { go: false; why: "cap" | "paused"; until: number } | { go: false; why: "same"; text: string };

export function createBudget(o: { config: BudgetConfig; stateDir?: string; now?: () => number; log?: (line: string) => void }) {
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => undefined);
  const path = o.stateDir ? join(o.stateDir, "budget.json") : "";
  const fresh = (day: string): Saved => ({ day, kinds: {}, models: {}, modelsOff: [], skipped: { cap: 0, paused: 0, same: 0 }, pausedUntil: 0 });
  let s: Saved = ((): Saved => {
    if (!path) return fresh(localDay(now()));
    try {
      const v = JSON.parse(readFileSync(path, "utf8")) as Partial<Saved>;
      const n = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0);
      const kinds: Saved["kinds"] = {};
      for (const [k, c] of Object.entries(v.kinds ?? {})) kinds[k as RunKind] = n(c);
      const models: Saved["models"] = {};
      for (const [k, c] of Object.entries(v.models ?? {})) if (/^[A-Za-z0-9-]{1,80}$/.test(k)) models[k] = n(c);
      const modelsOff = (Array.isArray(v.modelsOff) ? v.modelsOff : []).filter((m): m is string => typeof m === "string").slice(0, 10);
      return {
        day: typeof v.day === "string" ? v.day : localDay(now()),
        kinds,
        models,
        modelsOff,
        skipped: { cap: n(v.skipped?.cap), paused: n(v.skipped?.paused), same: n(v.skipped?.same) },
        pausedUntil: n(v.pausedUntil),
        ...(v.told === true ? { told: true } : {}),
      };
    } catch {
      return fresh(localDay(now()));
    }
  })();
  const save = (): void => {
    if (!path) return;
    try {
      mkdirSync(o.stateDir!, { recursive: true, mode: 0o700 });
      writeFileSync(`${path}.tmp`, JSON.stringify(s), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    } catch (err) {
      log(`could not save the budget: ${(err as Error).message}`);
    }
  };
  /** A new day starts the counts again; a pause for the limit outlives midnight. */
  const today = (): Saved => {
    const d = localDay(now());
    if (s.day !== d) {
      s = { ...fresh(d), pausedUntil: s.pausedUntil, ...(s.told ? { told: true } : {}) };
      save();
    }
    return s;
  };
  const backgroundToday = (x: Saved): number =>
    Object.entries(x.kinds).reduce((n, [k, c]) => n + (OWNER.has(k as RunKind) || APART.has(k as RunKind) ? 0 : (c ?? 0)), 0);
  const cache: { key: string; kind: RunKind; at: number; text: string }[] = [];
  /** The kinds already said to be over the cap today: said once a day each, not for every job. */
  const capSaid = new Set<string>();

  const skip = (why: SkipWhy): void => {
    today().skipped[why]++;
    save();
  };

  return {
    /**
     * Whether a background job may run now. `material`: what the job reads, compared with the answers kept for coalescing. The owner's own
     * kinds always may (and are not compared: two equal messages are two questions).
     */
    admit(kind: RunKind, material: string): Admission {
      const x = today();
      const key = materialKey(kind, material);
      if (OWNER.has(kind) || APART.has(kind)) return { go: true, key };
      const t = now();
      const hit = [...cache].reverse().find((c) => c.key === key);
      if (hit) {
        const serves = kind === "proactive" && hit.text.trim() === "NO_REPLY" ? Math.max(o.config.unchangedMs, o.config.coalesceMs) : o.config.coalesceMs;
        if (t - hit.at < serves) {
          skip("same");
          return { go: false, why: "same", text: hit.text };
        }
      }
      if (x.pausedUntil > t) {
        skip("paused");
        return { go: false, why: "paused", until: x.pausedUntil };
      }
      const used = backgroundToday(x);
      const cap = LOW.has(kind) ? Math.floor(o.config.perDay / 2) : o.config.perDay;
      if (used >= cap) {
        skip("cap");
        if (!capSaid.has(`${x.day}:${kind}`)) {
          // Only today's are needed: an earlier day's go (one a day per kind was added forever).
          for (const k of capSaid) if (!k.startsWith(`${x.day}:`)) capSaid.delete(k);
          capSaid.add(`${x.day}:${kind}`);
          log(`background budget: no more ${kind} runs today (${used} background runs of Claude so far, ${cap} allowed for this kind): answered without Claude`);
        }
        return { go: false, why: "cap", until: nextDay(t) };
      }
      return { go: true, key };
    },
    /** A background job let go without a run because a newer one of the same kind makes it moot (bridge.ts: an older proactive check). */
    coalesced(): void {
      skip("same");
    },
    /**
     * A run started (owner's or background): counted whatever comes of it, except a run that never reached Claude (signed out, the command
     * missing): the function it returns takes that count back, so a lost login tried again every few minutes does not spend the day's cap.
     */
    started(kind: RunKind): () => void {
      const x = today();
      const day = x.day;
      x.kinds[kind] = (x.kinds[kind] ?? 0) + 1;
      save();
      return () => {
        const y = today();
        const n = y.kinds[kind] ?? 0;
        if (y.day !== day || n === 0) return; // a new day began meanwhile: the run was counted in a day that is gone
        if (n === 1) delete y.kinds[kind];
        else y.kinds[kind] = n - 1;
        save();
      };
    },
    /** The model that answered a run: counted for the day's numbers. */
    answeredBy(model: string): void {
      if (!model) return;
      const x = today();
      x.models[model] = (x.models[model] ?? 0) + 1;
      save();
    },
    /** A model this account cannot use now: set aside until the day ends. True the first time today (the caller says it once). */
    modelOff(model: string): boolean {
      const x = today();
      if (x.modelsOff.includes(model)) return false;
      x.modelsOff.push(model);
      save();
      return true;
    },
    /** Whether a model was set aside today (modelOff). */
    isModelOff(model: string): boolean {
      return today().modelsOff.includes(model);
    },
    /** A background run's answer, kept for the same material within the coalescing window. */
    answered(kind: RunKind, key: string, text: string): void {
      if (OWNER.has(kind) || !text.trim()) return;
      cache.push({ key, kind, at: now(), text: text.slice(0, 40_000) });
      while (cache.length > CACHE_MAX) cache.shift();
    },
    /**
     * A run said Claude's limit was reached: background work waits until the reset. Returns that time. `resetsAt`: the reset the stream gave
     * in structure (ClaudeError.resetsAt), believed before the words.
     */
    limited(message: string, resetsAt?: number): number {
      const t = now();
      const named = resetsAt && resetsAt > t ? resetsAt : resetAt(message, t);
      const until = Math.min(named && named > t ? named : t + UNKNOWN_RESET_MS, t + MAX_PAUSE_MS);
      const x = today();
      if (until > x.pausedUntil) {
        x.pausedUntil = until;
        save();
        log(`Claude's limit was reached: background runs wait until ${new Date(until).toISOString()}${named ? "" : " (no reset time given: half an hour)"}`);
      }
      return x.pausedUntil;
    },
    /** Whether the owner was told of this limit (until a run works again), kept across restarts so a restart does not say it again. */
    limitTold(): boolean {
      return today().told === true;
    },
    /** The owner was told of the limit (the notice went through): not said again until a run works. */
    markLimitTold(): void {
      const x = today();
      if (x.told) return;
      x.told = true;
      save();
    },
    /**
     * A run worked: whatever the pause said, Claude answers again. True when the owner was told of a limit and is still to hear it is over:
     * true again on each run that works until backTold says the note went.
     */
    working(): boolean {
      const x = today();
      if (x.pausedUntil > now()) {
        x.pausedUntil = 0;
        save();
        log("Claude answers again: background runs resume");
      }
      return x.told === true;
    },
    /** The "back" note went through: the limit's notice is closed. */
    backTold(): void {
      const x = today();
      if (!x.told) return;
      delete x.told;
      save();
    },
    usage(): Usage {
      const x = today();
      const interactive = Object.entries(x.kinds).reduce((n, [k, c]) => n + (OWNER.has(k as RunKind) ? (c ?? 0) : 0), 0);
      return {
        day: x.day, interactive, background: backgroundToday(x), skipped: { ...x.skipped }, kinds: { ...x.kinds },
        models: { ...x.models }, modelsOff: [...x.modelsOff],
        pausedUntil: x.pausedUntil > now() ? x.pausedUntil : 0, perDay: o.config.perDay,
      };
    },
  };
}

export type Budget = ReturnType<typeof createBudget>;

/** The day's numbers in one log line. */
export function usageLine(u: Usage): string {
  const skipped = u.skipped.cap + u.skipped.paused + u.skipped.same;
  return `claude today: ${u.interactive + u.background} runs (${u.interactive} yours, ${u.background}/${u.perDay} background), ${skipped} background jobs answered without a run`
    + (skipped ? ` (${u.skipped.same} unchanged or coalesced, ${u.skipped.cap} over the cap, ${u.skipped.paused} during the limit)` : "")
    + (u.pausedUntil ? `; background paused until ${new Date(u.pausedUntil).toISOString()}` : "")
    + (Object.keys(u.models ?? {}).length ? `; by model: ${Object.entries(u.models).map(([m, n]) => `${m} ${n}`).join(", ")}` : "")
    + (u.modelsOff?.length ? `; set aside today: ${u.modelsOff.join(", ")}` : "");
}
