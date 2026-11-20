// The owner's controls over everything the assistant does: the kill switch (STOP / RESUME on WhatsApp) and the action log.
//
// STOP halts every outbound action at the server, where it cannot be talked around: no call (to the owner or a friend, from WhatsApp, the
// Caller connector or the voice line) and no WhatsApp to anyone else is placed until RESUME. The chat with the owner, their reminders and the
// email summaries go on (they only reach the owner). The log keeps one line per action (a call, a message, a reminder, an email passed on, a note,
// a pause), newest last, for the owner ("registro" on WhatsApp) and the admin route.
//
// The pause fails closed: while this process cannot know it (the store has never answered here, or the store guard of src/store-guard.ts has
// not vouched for the store yet, or could not read the pause), it is reported as on, so nothing goes out on a state nobody could read. A STOP
// or RESUME the owner types always wins, in memory, even when the store is down. A pause Pako set by itself is never worded as the owner's STOP.

import { locale, texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import { createLog } from "./log.ts";
import { readJsonRecord } from "./json-record.ts";

const logControl = createLog("control");

const PAUSE_KEY = "assistant-paused";
/** Why the pause in PAUSE_KEY was set, when it was not the owner: {"at": <that pause's time>, "why": "store-empty"}. */
const WHY_KEY = "assistant-paused-why";
const PAUSE_TTL_S = 365 * 24 * 3600;
const LOG_KEY = "assistant-log";
const LOG_KEEP = 300;
const LOG_TTL_S = 90 * 24 * 3600;
const LINE_MAX = 300;
/** How long a look at the store by the store guard is waited for before the pause is said to be on: a little over one request's limit. */
const LOOK_WAIT_MS = 5000;

export interface LogLine {
  at: number;
  kind: string;
  text: string;
}

/**
 * Why everything is paused: the owner (STOP, or the panel's switch); the store came back empty, so a STOP may have been lost with it
 * (src/store-guard.ts); or the store cannot be read yet, so nobody knows.
 */
export type PauseWhy = "owner" | "store-empty" | "store-unknown";

export interface PauseState {
  /** Since when (epoch ms), or null when running. */
  paused: number | null;
  /** Null when running. */
  why: PauseWhy | null;
}

export interface Control {
  /** Since when everything is paused (epoch ms), or null when running. While the pause cannot be known, on since this process started. */
  paused: () => Promise<number | null>;
  /** The same, and why. */
  state: () => Promise<PauseState>;
  /**
   * False when the store could not keep it (it holds in memory until a restart). The owner's, unless the store guard pauses because the store
   * came back empty.
   */
  setPaused: (on: boolean, at: number, why?: "owner" | "store-empty") => Promise<boolean>;
  /** Adds one line; never throws (a log that cannot be written must not stop an action). */
  log: (kind: string, text: string, at?: number) => void;
  recent: (n: number) => Promise<LogLine[]>;
  /** For the store guard (src/store-guard.ts) only. */
  guard: {
    /**
     * A look at the store in flight, true once the guard vouches for the store and for the pause in it. From the first one on, until one does,
     * the pause is reported as on (a look in flight is waited for a few seconds first), and what was read before is not trusted: an emptied
     * store reads "running". From then on only the guard reads the pause (`read`), which it checks against the store after the read.
     */
    checking: (look: Promise<boolean>) => void;
    /** Reads the pause from the store when it is not known here; what the read found (or still unknown, when the store did not answer). */
    read: () => Promise<PauseState>;
    /** The pause as this process knows it: set here (the owner's STOP or RESUME, the guard's pause), or read from a store worth trusting. */
    known: () => PauseState | null;
    /** Drops what was read from the store (never what was set here): the store turned out to have been emptied around that read. */
    forget: () => void;
    /** Writes the pause this process knows back to the store, after a wipe. False when the store did not take it. */
    keep: () => Promise<boolean>;
  };
}

const T = texts(
  {
    paused: "Pako is paused (STOP): no calls or messages go out until you type RESUME.",
    pausedEmpty: "Pako is paused to be safe (its store came back empty, and a STOP may have been lost with it): no calls or messages go out "
      + "until you type RESUME.",
    pausedUnknown: "Pako is paused to be safe (it can't read its store right now, and that is where a STOP is kept): no calls or messages go out "
      + "until it can read it or you type RESUME.",
    labelOwner: "STOP",
    labelEmpty: "store empty",
    labelUnknown: "store not read",
    emptyLog: "The log is empty so far.",
  },
);

const PAUSE_KEYS = { owner: "paused", "store-empty": "pausedEmpty", "store-unknown": "pausedUnknown" } as const;
const LABEL_KEYS = { owner: "labelOwner", "store-empty": "labelEmpty", "store-unknown": "labelUnknown" } as const;
const WHYS: PauseWhy[] = ["owner", "store-empty", "store-unknown"];

/**
 * What a refusal says while paused, by why (the owner's when it is not known), in English like all of Pako's own texts. Only the owner's
 * pause is a STOP they wrote: a pause Pako set by itself must never be put down to them (they would think someone else used their chat).
 * Every wording starts with the same words, and a text passed on (a call's error) is told by them.
 */
export const pausedText = (why: PauseWhy | null, l: Lang = "en"): string => T(l)(PAUSE_KEYS[why ?? "owner"]);
/** The refusals, by why: what a module that words no answer of its own writes. */
export const PAUSED_TEXTS: Record<PauseWhy, string> = {
  owner: pausedText("owner"),
  "store-empty": pausedText("store-empty"),
  "store-unknown": pausedText("store-unknown"),
};
export const PAUSED_TEXT = PAUSED_TEXTS.owner;
/** Which pause a text carries (a call's error, passed on); null when it carries none. The voice line and the door word their own answer from it. */
export const pauseWhyIn = (text: string): PauseWhy | null =>
  WHYS.find((why) => text.includes(pausedText(why))) ?? null;
/** The same, in English, for the Caller connector: why nothing was asked or called. */
export const PAUSED_WHY_EN: Record<PauseWhy, string> = {
  owner: "Pako is paused (STOP, or the panel's switch).",
  "store-empty": "Pako paused itself for safety (not the owner's STOP): its store came back empty, and a STOP may have been lost with it. "
    + "Nothing is called or sent until the owner writes RESUME.",
  "store-unknown": "Pako is paused for safety (not the owner's STOP): it cannot read its store, where a STOP is kept, right now. "
    + "It goes on by itself once the store answers, or when the owner writes RESUME.",
};
/** A pause in a line of the owner's log ("paused (STOP)"). */
export const pauseLabel = (why: PauseWhy | null, l: Lang = "en"): string => T(l)(LABEL_KEYS[why ?? "owner"]);

export function createControl(kv: Kv | null, now: () => number = Date.now): Control {
  const bornAt = now();
  /** The pause as known here; undefined until it was read or set. */
  let pausedAt: number | null | undefined;
  let reason: "owner" | "store-empty" = "owner";
  /** Set here since this process started (by the owner, or by the store guard): memory wins over anything the store says. */
  let decided = false;
  /** Moves on whenever memory is set or stops being trusted: a read that was in flight then is dropped. */
  let epoch = 0;
  let reading: Promise<PauseState> | null = null;
  /** The store guard started looking, whether it vouched for the store yet, and its look in flight. */
  let watched = false;
  let vouched = false;
  let look: Promise<boolean> | null = null;
  /** Settles the first time the pause is set here: whoever waits for a look or a read stops waiting then (memory wins anyway). */
  let wake: () => void = () => undefined;
  const set = new Promise<void>((resolve) => (wake = resolve));
  let unknownSaid = false;
  let lines: LogLine[] | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
  // Writes of the pause go one at a time, each with what memory holds when its turn comes: a STOP and a quick RESUME cannot land in the store
  // in the wrong order.
  let pauseChain: Promise<unknown> = Promise.resolve();
  const pauseLocked = (fn: () => Promise<boolean>): Promise<boolean> => {
    const run = pauseChain.then(fn, fn);
    pauseChain = run.then(() => undefined, () => undefined);
    return run;
  };
  /** Throws when the store cannot be read: a fresh list in its place would overwrite the log kept there. */
  const loadLog = async (): Promise<LogLine[]> => {
    if (lines) return lines;
    const raw = kv ? await readJsonRecord(kv, LOG_KEY) : null;
    if (lines) return lines;
    let p: unknown = [];
    try {
      p = raw ? raw : [];
    } catch {
      logControl.error("the stored log could not be used: starting again");
    }
    lines = (Array.isArray(p) ? p : []).filter((x): x is LogLine => !!x && typeof x.at === "number" && typeof x.text === "string" && typeof x.kind === "string");
    return lines;
  };

  const current = (): PauseState => (typeof pausedAt === "number" ? { paused: pausedAt, why: reason } : { paused: null, why: null });
  const unknown = (because: string): PauseState => {
    if (!unknownSaid) {
      unknownSaid = true;
      logControl.error(`the pause cannot be known (${because}): it counts as ON, so no call or message goes out until the store answers`);
    }
    return { paused: bornAt, why: "store-unknown" };
  };
  const within = (p: Promise<unknown>, ms: number): Promise<void> =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
      const done = (): void => {
        clearTimeout(t);
        resolve();
      };
      p.then(done, done);
    });
  const read = async (): Promise<PauseState> => {
    const gen = epoch;
    try {
      const [raw, whyRaw] = kv ? await Promise.all([kv.get(PAUSE_KEY), kv.get(WHY_KEY).catch(() => null)]) : [null, null];
      const n = raw ? Number(raw) : NaN;
      let w: { at?: unknown; why?: unknown } | null = null;
      try {
        w = whyRaw ? (JSON.parse(whyRaw) as { at?: unknown; why?: unknown } | null) : null;
      } catch {
        /* not JSON: the pause stands, with no reason to show */
        w = null;
      }
      // A STOP (or RESUME) typed while this read was in flight is newer than what the store said: it stays.
      if (gen === epoch && pausedAt === undefined) {
        pausedAt = Number.isFinite(n) && n > 0 ? n : null;
        // The reason belongs to this pause only when it carries its time: an older one is left over from another pause.
        reason = pausedAt !== null && w?.at === pausedAt && w.why === "store-empty" ? "store-empty" : "owner";
      }
      unknownSaid = false;
    } catch (err) {
      // The store cannot say. Never read here, the pause is unknown: a STOP may be kept there, so it counts as on, never as "running".
      if (pausedAt === undefined) return unknown(`the store did not answer: ${(err as Error).message}`);
    }
    // A read dropped on the way (the store guard stopped trusting what it says) leaves nothing known: on, never "running" by default.
    return pausedAt === undefined ? unknown("the store's answer is no longer trusted") : current();
  };
  // One read at a time for everyone asking; one dropped on the way is left to its own callers, and the next asker reads afresh.
  const readShared = (): Promise<PauseState> => {
    if (!reading) {
      const r: Promise<PauseState> = read().finally(() => {
        if (reading === r) reading = null;
      });
      reading = r;
    }
    return reading;
  };
  const state = async (): Promise<PauseState> => {
    if (decided) return current();
    if (watched && !vouched) {
      if (look) await within(Promise.race([look, set]), LOOK_WAIT_MS);
      if (decided) return current();
      if (!vouched) return unknown("the store has not been checked yet");
    }
    if (pausedAt !== undefined) return current();
    if (watched && kv) {
      // Once the store guard watches, only it reads the pause, and it checks the store after the read: a read here, after a look that could
      // not read the pause, could take a store emptied since for "running". Its read in flight is waited for; without one, the pause is not
      // known yet (the guard reads it again within half a minute).
      if (reading) await within(Promise.race([reading, set]), LOOK_WAIT_MS);
      return pausedAt !== undefined ? current() : unknown("the store guard could not read the pause yet");
    }
    return readShared();
  };
  const write = async (): Promise<boolean> => {
    if (!kv || pausedAt === undefined) return true;
    try {
      if (pausedAt === null) await kv.set(PAUSE_KEY, "0", 60);
      else {
        await kv.set(PAUSE_KEY, String(pausedAt), PAUSE_TTL_S);
        if (reason !== "owner") await kv.set(WHY_KEY, JSON.stringify({ at: pausedAt, why: reason }), PAUSE_TTL_S);
      }
      return true;
    } catch (err) {
      logControl.error(`could not keep the pause: ${(err as Error).message}`);
      return false;
    }
  };
  return {
    paused: async () => (await state()).paused,
    state,
    setPaused: (on, at, why = "owner") => {
      // In memory at once: a failing store must not keep calls going, and a read in flight must not undo it.
      decided = true;
      epoch++;
      pausedAt = on ? at : null;
      reason = why;
      wake();
      return pauseLocked(write);
    },
    log: (kind, text, at) => {
      const line: LogLine = { at: at ?? now(), kind: kind.slice(0, 20), text: text.replace(/\s+/g, " ").trim().slice(0, LINE_MAX) };
      void locked(async () => {
        const l = [...(await loadLog()), line].slice(-LOG_KEEP);
        lines = l;
        if (kv) await kv.set(LOG_KEY, JSON.stringify(l), LOG_TTL_S);
      }).catch((err) => logControl.error(`could not write the log: ${(err as Error).message}`));
    },
    recent: async (n) => {
      await chain;
      try {
        return (await loadLog()).slice(-n);
      } catch (err) {
        logControl.error(`could not read the log: ${(err as Error).message}`);
        return [];
      }
    },
    guard: {
      checking: (p) => {
        if (!watched) {
          watched = true;
          if (!decided) {
            pausedAt = undefined;
            epoch++;
            reading = null;
          }
        }
        look = p;
        const settle = (ok: boolean): void => {
          if (ok) vouched = true;
          if (look === p) look = null;
        };
        p.then(settle, () => settle(false));
      },
      read: () => (pausedAt !== undefined ? Promise.resolve(current()) : readShared()),
      known: () => (pausedAt === undefined ? null : current()),
      forget: () => {
        if (decided) return;
        pausedAt = undefined;
        epoch++;
        reading = null;
      },
      keep: () => pauseLocked(write),
    },
  };
}

/**
 * The log as the owner reads it on WhatsApp: one line each, oldest first, in their time zone. A line stays in the language it was written in
 * (the log keeps words, not keys); the dates and the empty log are English.
 */
export function logText(lines: LogLine[], timeZone: string, l: Lang = "en"): string {
  if (!lines.length) return T(l)("emptyLog");
  const when = new Intl.DateTimeFormat(locale(l), { timeZone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  return lines.map((line) => `${when.format(line.at)} · ${line.text}`).join("\n");
}
