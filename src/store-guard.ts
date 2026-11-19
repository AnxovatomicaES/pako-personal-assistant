// Pako keeps its state (a STOP, the notes, the reminders, the inbox, the Telegram link…) in a key value store, and a free Render Key Value keeps
// nothing when Render restarts it: every key is gone, and Pako would come back "running" without a word. This guard notices, and fails safe.
//
// - A sentinel (pako-store-id, a random id) marks a store the guard has looked at. At start: there, all is well. Missing while other keys of a
//   Pako in use are there: a store from before the guard (the first start of this version), marked without a word; unless the era (below)
//   is there too. Missing with nothing else: the store came back empty (a wipe, or the very first start). A STOP may have gone with it, so
//   everything is paused (no call, no message to anyone) and the owner is told how to go on (RESUME) and how to keep it from happening again.
// - The era (pako-store-era): a copy that found its sentinel in the store writes it just before each key a Pako in use keeps. A copy still
//   running after a wipe writes those keys again before its next look; the era tells a copy that starts then that this is a wipe, not a store
//   from before the guard (a Pako before the guard never writes it).
// - A store that cannot be read at start decides nothing: the pause is unknown and counts as on (src/control.ts), and the store is looked at
//   again every half minute until it answers.
// - While Pako runs, the sentinel is looked at every two minutes. Gone, the store was wiped under this process, which still knows the pause:
//   it is written back (a STOP survives), the sentinel too, and the owner is told what may be lost, once. Nothing is newly paused, unless this
//   process never managed to read the pause: then it cannot know, and pauses as at a start. A sentinel this process could not write is no wipe.
// - Hosted with no store at all (VOICE_RESULTS_URL unset), every start is an empty store. At home (src/local.ts) the file store says itself
//   whether it started empty because its file was lost or damaged; only that pauses, and never on the person's first run.
// - Nothing is paused where nobody could write RESUME (a server with no chat at all): the server's log says it all then.

import { randomBytes } from "node:crypto";
import type { Control } from "./control.ts";
import { texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import { createLog } from "./log.ts";

const log = createLog("store");

// What the owner reads (the notice), the line in the action log and the line for the assistant's context, in the language of Pako's own texts.
const T = texts(
  {
    notes: "your notes",
    reminders: "your reminders",
    chat: "the earlier chat",
    mail: "the email state",
    telegram: "the Telegram connection",
    calendar: "calendar access",
    lost: "{list} and {last} may have been lost",
    stopStart: "I started PAUSED to be safe: I won't call or message anyone. Type RESUME to go on.",
    stopRunning: "I've PAUSED to be safe: I won't call or message anyone. Type RESUME to go on.",
    fix: "So it doesn't happen again: on Render, put the Key Value on a paid plan (with persistence), or run Pako on your computer.",
    none: "⚠️ Pako has no store (VOICE_RESULTS_URL is missing): every restart forgets everything, a STOP too. {stop}\n"
      + "To fix it: set VOICE_RESULTS_URL to the address of a Key Value with persistence.",
    missing: "⚠️ I can't find the file where I keep your things (kv.db, in your Pako folder): {lost}. {stop}",
    damaged: "⚠️ The file where I keep your things was damaged: I moved it aside (.bad, in your Pako folder) and started an empty one, so {lost}. {stop}",
    stillPaused: "Still paused, as you asked.",
    stillRunning: "Still running, as you asked.",
    startEmpty: "⚠️ Pako's store came back empty (it's the first start, or Render wiped it): {lost}. {then}\n{fix}",
    wipedPausing: "⚠️ Pako's store was emptied while it was running, and I don't know whether it was paused: {lost}. {stop}\n{fix}",
    wiped: "⚠️ Pako's store was emptied while it was running. {what}.\n{fix}",
    stopHolds: "Your STOP still holds, but {lost}",
    logNone: "No store (VOICE_RESULTS_URL)",
    logLost: "Store (kv.db) lost or damaged",
    logStart: "The store came back empty",
    logWiped: "The store was emptied while Pako was running",
    logPausing: "{line}: everything stopped until RESUME",
    logKept: "{line}: the pause stays as it was",
    noteSelfPaused: "Pako paused itself to be safe ({why}, and a STOP may have been lost): it was not the owner's STOP. "
      + "No calls or messages go out until the owner writes RESUME.",
    noteWhyNone: "it has no store",
    noteWhyWiped: "its store came back empty",
    noteWhyLost: "its kv.db file was lost",
  },
);

export const SENTINEL_KEY = "pako-store-id";
/** Written just before each key of SIGNS by a copy that found its sentinel in the store (watchStore): see the top of this file. */
export const ERA_KEY = "pako-store-era";
const SENTINEL_TTL_S = 10 * 365 * 24 * 3600;
const RETRY_MS = 30_000;
const EVERY_MS = 2 * 60_000;

/**
 * Keys a Pako in use keeps for days or years (src/*.ts): any of them, without the sentinel, is a store from before the guard. One this process
 * wrote itself says nothing about an older Pako (watchStore notes them): Pako runs while the store cannot be read, and writes once it can.
 */
const SIGNS = [
  "owner-memory", "assistant-reminders", "assistant-log", "assistant-mail", "assistant-paused", "assistant-last-owner-at", "assistant-last-channel",
  "assistant-held-notices", "assistant-inbox", "telegram-owner", "telegram-off", "whatsapp-owner-bsuid", "pako-bookings", "zoho-refresh",
];

export interface WatchedStore {
  kv: Kv | null;
  /** True once this process wrote that key (only the keys the guard looks at are noted). */
  wrote: (key: string) => boolean;
  /**
   * Set by the store guard: the sentinel the store holds as far as this process knows (null: not seen there yet, or gone). While it is set,
   * each write of a key the guard looks at goes after the era.
   */
  stamp: (id: string | null) => void;
}

/** The store as the app uses it, noting which of the keys the guard looks at this process writes itself. */
export function watchStore(kv: Kv | null): WatchedStore {
  if (!kv) return { kv: null, wrote: () => false, stamp: () => undefined };
  const signs = new Set(SIGNS);
  const written = new Set<string>();
  let era: string | null = null;
  return {
    kv: {
      get: (key) => kv.get(key),
      set: async (key, value, ttlSeconds) => {
        if (signs.has(key)) {
          written.add(key);
          // The era first, and awaited: no copy can find this key without it. A key whose era the store did not take is not written either.
          if (era) await kv.set(ERA_KEY, era, SENTINEL_TTL_S);
        }
        return kv.set(key, value, ttlSeconds);
      },
      // The jobs' claims only: none of them is a key the guard looks at.
      ...(kv.add ? { add: (key: string, value: string, ttlSeconds: number) => kv.add!(key, value, ttlSeconds) } : {}),
    },
    wrote: (key) => written.has(key),
    stamp: (id) => {
      era = id;
    },
  };
}

/** Why the file store at home started empty: its file was gone although Pako had made one there, or it was damaged (kept aside as .bad). */
export type StoreLost = "missing" | "damaged";

export interface StoreGuardDeps {
  store: WatchedStore;
  control: Control;
  /** Tells the owner, as an urgent notice (the door's notifyOwner). Null with no chat at all: then nothing is paused, as nobody could RESUME. */
  notify: ((text: string) => Promise<unknown>) | null;
  /** A line for the assistant's context (the door's events): a pause the guard set is not the owner's STOP, and Claude must not say it is. */
  note?: (text: string) => void;
  /** What else this server keeps in the store, so the notice names what may be lost. */
  parts?: { mail?: boolean; telegram?: boolean; calendar?: boolean };
  /** At home (src/local.ts): whether this is the person's first run, and why the file store started empty, if it did. Absent on a server. */
  local?: { firstRun: boolean; lost: StoreLost | null };
  /** The language of Pako's own texts (src/i18n.ts), asked when the notice and the log line are written. Always English now. */
  lang?: () => Lang;
  now?: () => number;
  /** How often a store that could not be read is looked at again (30 s), and how often the sentinel is looked at (two minutes). */
  retryMs?: number;
  everyMs?: number;
}

export interface StoreGuard {
  /** The look at start, then the one every two minutes. server.ts calls it once listening; an app that is only built keeps no watch. */
  start(): void;
  stop(): void;
  /** Looks at the store now, as the timers do (the start's look until the store answers, then the sentinel); resolves when it is done. */
  check(): Promise<void>;
}

type Cause = "wiped" | "none" | StoreLost;

export function createStoreGuard(d: StoreGuardDeps): StoreGuard {
  const now = d.now ?? Date.now;
  const kv = d.store.kv;
  const { control } = d;
  const retryMs = d.retryMs ?? RETRY_MS;
  const everyMs = d.everyMs ?? EVERY_MS;
  let started = false;
  let stopped = false;
  /** The store answered the look at start (and what it held was dealt with). */
  let vouched = false;
  /** The sentinel this process knows; null until the store was vouched for. */
  let id: string | null = null;
  /** The store holds `id`: this process saw it there, or wrote it and the store took it. False before, and from a look that finds it gone. */
  let marked = false;
  /**
   * The owner was told of the emptying the last looks found, and the sentinel is not back yet: a look that still cannot put it back says
   * nothing more (one notice for each emptying, not one every two minutes while the store refuses writes).
   */
  let told = false;
  /**
   * The keys of a Pako in use that the look at start found, from before this process. Until this process has seen its sentinel in the store
   * (its own write of it may have failed), one of them still there, and not written since by this process, says the store was not emptied.
   */
  let witnesses: string[] = [];
  let timer: NodeJS.Timeout | null = null;
  let chain: Promise<void> = Promise.resolve();
  let downSaid = false;

  const fresh = (): string => randomBytes(8).toString("hex");
  const setMarked = (on: boolean): void => {
    marked = on;
    d.store.stamp(on ? id : null);
  };
  /** Writes the sentinel; false when the store did not take it (nothing is decided from that: the next look writes it again). */
  const mark = async (): Promise<boolean> => {
    if (!kv || !id) return false;
    try {
      await kv.set(SENTINEL_KEY, id, SENTINEL_TTL_S);
      setMarked(true);
      return true;
    } catch (err) {
      log.error(`could not mark the store (pako-store-id): ${(err as Error).message}; the next look tries again`);
      return false;
    }
  };

  /** The words for the notice and the log, in the language asked for now (a choice made in the panel meanwhile counts). */
  const say = (): ReturnType<typeof T> => T(d.lang?.() ?? "en");
  /** What may be lost, in the owner's words. */
  const lostText = (t: ReturnType<typeof T>, atHome: boolean): string => {
    const what = [
      t("notes"),
      t("reminders"),
      ...(atHome ? [t("chat")] : []),
      ...(d.parts?.mail ? [t("mail")] : []),
      ...(d.parts?.telegram ? [t("telegram")] : []),
      ...(d.parts?.calendar ? [t("calendar")] : []),
    ];
    return t("lost", { list: what.slice(0, -1).join(", "), last: what.at(-1)! });
  };
  // Short enough for the notice template (600 characters on one line): it reaches the phone whole even when WhatsApp's 24 hours are over.
  const notice = (when: "start" | "running", cause: Cause, pausing: boolean, paused: boolean): string => {
    const t = say();
    const stop = t(when === "start" ? "stopStart" : "stopRunning");
    const fix = t("fix");
    if (cause === "none") return t("none", { stop });
    if (cause === "missing") return t("missing", { lost: lostText(t, true), stop });
    if (cause === "damaged") return t("damaged", { lost: lostText(t, true), stop });
    const lost = lostText(t, false);
    if (when === "start") return t("startEmpty", { lost, then: pausing ? stop : t(paused ? "stillPaused" : "stillRunning"), fix });
    if (pausing) return t("wipedPausing", { lost, stop, fix });
    return t("wiped", { what: paused ? t("stopHolds", { lost }) : `${lost[0]!.toUpperCase()}${lost.slice(1)}`, fix });
  };
  const SAID: Record<Exclude<Cause, "wiped">, string> = {
    none:"NO STORE: VOICE_RESULTS_URL is not set, so every restart forgets everything, a STOP too. Set it to a Key Value with persistence.",
    missing: "kv.db is gone although Pako had made one in this folder: the notes, the reminders and the chat may be lost.",
    damaged: "The store was damaged (kept aside as kv.db.bad or kv.json.bad): Pako started with an empty one.",
  };

  /**
   * The store came back empty, or there is none. Sets the pause in memory at once (before anyone waiting for the look reads it), and returns
   * what follows: the writes, the log, the console, the notice.
   */
  const emptied = (when: "start" | "running", cause: Cause): (() => Promise<void>) => {
    // What this process knows stands: a STOP or RESUME the owner typed since it started, or, while running, what it read. Otherwise a STOP may
    // have gone with the rest, so everything is paused; but not where nobody could write RESUME.
    const known = control.guard.known();
    const pausing = !known && !!d.notify;
    const kept = pausing ? control.setPaused(true, now(), "store-empty") : control.guard.keep();
    if (cause === "wiped" && !(when === "running" && id)) id = fresh();
    return async () => {
      await kept;
      await mark();
      const said = cause !== "wiped" ? SAID[cause]
        : when === "start" ? "the store came back EMPTY (no pako-store-id, and none of the keys a Pako in use keeps, or only ones written since "
          + "a wipe): a first start, or the store was wiped (a free Render Key Value keeps nothing when it restarts)."
        : "the store was WIPED while Pako was running (pako-store-id is gone): notes, reminders, mail state and the Telegram link may be lost; "
          + "a free Render Key Value keeps nothing when it restarts.";
      const then = pausing ? "Everything is PAUSED until the owner writes RESUME." : !d.notify ? "No chat to tell the owner in: nothing is paused."
        : "The pause this process knew was written back.";
      log.error(`${said} ${then}`);
      const t = say();
      const line = t(cause === "none" ? "logNone" : cause !== "wiped" ? "logLost" : when === "start" ? "logStart" : "logWiped");
      control.log(pausing ? "pause" : "failure", t(pausing ? "logPausing" : "logKept", { line }));
      // Told once for this emptying: a look that cannot put the sentinel back afterwards says nothing more.
      told = true;
      if (pausing) {
        // Claude sees the pause as the owner's STOP unless it is told (an assistant on the owner's computer that has not been updated).
        d.note?.(t("noteSelfPaused", { why: t(cause === "none" ? "noteWhyNone" : cause === "wiped" ? "noteWhyWiped" : "noteWhyLost") }));
      }
      if (!d.notify) return;
      // Worded as things stand when it goes: a RESUME (or STOP) the owner typed meanwhile makes it "as you asked", not "write RESUME".
      const state = control.guard.known();
      try {
        await d.notify(notice(when, cause, pausing && state?.why === "store-empty", (state?.paused ?? null) !== null));
      } catch (err) {
        log.error(`could not tell the owner: ${(err as Error).message}`);
      }
    };
  };

  /** What the store holds at start: the sentinel; else whether a Pako used it before. Throws when it cannot be read. */
  const find = async (): Promise<"seen" | "older" | "empty"> => {
    witnesses = [];
    const seen = await kv!.get(SENTINEL_KEY);
    if (seen) {
      id = seen;
      setMarked(true);
      return "seen";
    }
    const values = await Promise.all(SIGNS.map((key) => kv!.get(key)));
    const found = SIGNS.filter((key, i) => values[i] !== null && !d.store.wrote(key));
    if (!found.length) return "empty";
    // Read after those keys: a copy that checks the store writes the era just before each of them, so the era of any write found above is here.
    // There, a copy still running after a wipe wrote them: the store was emptied, and a STOP may have gone with it.
    if (await kv!.get(ERA_KEY)) return "empty";
    witnesses = found;
    return "older";
  };
  /** The sentinel this process saw (or wrote) is still in the store. */
  const sentinelThere = async (): Promise<boolean> => !!(await kv!.get(SENTINEL_KEY));
  /** One of the keys the start found, not written since by this process, is still in the store (with none of those left, nothing says no). */
  const witnessed = async (): Promise<boolean> => {
    const left = witnesses.filter((key) => !d.store.wrote(key));
    for (const key of left) if ((await kv!.get(key)) !== null) return true;
    return !left.length;
  };
  /**
   * The pause, read and kept in memory so a later wipe cannot take a STOP with it; then the store is checked again (`still`). As it was, what
   * was read came from the store as it was. Emptied in between, what was read is dropped, and false. A check that fails drops it too.
   */
  const loadPause = async (still: () => Promise<boolean>): Promise<boolean> => {
    await control.guard.read();
    if (!control.guard.known()) return true;
    let there: boolean;
    try {
      there = await still();
    } catch (err) {
      control.guard.forget();
      throw err;
    }
    if (!there) control.guard.forget();
    return there;
  };
  /** Called the moment the look at start found what the store holds: the pause is set in memory at once; returns what follows. */
  const decide = (found: "seen" | "older" | "empty"): (() => Promise<void>) => {
    if (found === "empty") return emptied("start", "wiped");
    return async () => {
      if (found === "older") {
        id = fresh();
        if (await mark()) log.info("a store kept from before the store check: marked (pako-store-id), nothing else changes");
      }
      // A STOP or RESUME the owner typed while the store could not be read is written now; otherwise the pause is read now and kept, checked
      // against the sentinel seen at start, or (a store from before the guard, whose new mark may not have landed) against the keys found then.
      if (control.guard.known()) await control.guard.keep();
      else if (!(await loadPause(found === "seen" ? sentinelThere : witnessed))) {
        setMarked(false);
        await emptied("running", "wiped")();
      }
    };
  };
  const boot = async (): Promise<void> => {
    let then: () => Promise<void> = async () => undefined;
    const look = find().then(
      (found) => {
        then = decide(found);
        return true;
      },
      (err: Error) => {
        if (!downSaid) {
          downSaid = true;
          log.error(`the store cannot be read (${err.message}): the pause counts as ON until it answers; looking again every ${Math.round(retryMs / 1000)} s`);
        }
        return false;
      },
    );
    // The pause counts as unknown until all of the look is done: what the store holds, and the pause read from it (or set) and checked.
    const done = look.then(async (ok) => {
      if (!ok) return false;
      vouched = true;
      downSaid = false;
      try {
        await then();
      } catch (err) {
        log.error(`${(err as Error).message}`);
      }
      return true;
    });
    control.guard.checking(done);
    await done;
  };
  /** Every two minutes: the sentinel. Gone, the store was wiped under this process. */
  const watch = async (): Promise<void> => {
    let wiped = false;
    try {
      const seen = await kv!.get(SENTINEL_KEY);
      if (seen) {
        // Ours, or one another copy wrote after its own look (two run for a moment during a deploy): the store is as it was. The pause is read
        // now if the read at start failed, never before the sentinel: a store emptied since the last look would read "running".
        id = seen;
        setMarked(true);
        told = false;
        wiped = !control.guard.known() && !(await loadPause(sentinelThere));
      } else if (marked) {
        wiped = true; // it was there: the store was emptied under this process
      } else if (told) {
        // Emptied, the owner told, and the sentinel could not be put back since: again, without another word.
        await control.guard.keep();
        await mark();
      } else if (await witnessed()) {
        // This process's own mark never landed (the store did not take the write), and the store was not emptied: marked now, without a word.
        if (await mark()) log.info("marked (pako-store-id) on a later look: the first write did not go through");
        wiped = !control.guard.known() && !(await loadPause(witnessed));
      } else {
        wiped = true; // the keys found at start are gone: emptied before this process ever marked it
      }
      downSaid = false;
    } catch (err) {
      if (!downSaid) {
        downSaid = true;
        log.error(`could not look at the store (${(err as Error).message}); looking again in ${Math.round(nextMs() / 1000)} s`);
      }
      return;
    }
    if (!wiped) return;
    setMarked(false);
    await emptied("running", "wiped")();
  };

  // Every two minutes while all is known; every half minute while the store cannot be read, the pause is unknown (every call and message
  // waits for it) or the sentinel did not land.
  const nextMs = (): number => (vouched && marked && control.guard.known() !== null ? everyMs : retryMs);
  const later = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (stopped) return;
    timer = setTimeout(() => void run(), nextMs());
    timer.unref?.();
  };
  /** One look at a time. The first runs at once, so the pause counts as unknown before start() returns (and before any request is handled). */
  const run = (first = false): Promise<void> => {
    const go = async (): Promise<void> => {
      try {
        if (stopped) return;
        if (!vouched) await boot();
        else await watch();
      } catch (err) {
        log.error(`${(err as Error).message}`);
      }
      later();
    };
    chain = first ? go() : chain.then(go);
    return chain;
  };

  return {
    start: () => {
      if (started || stopped) return;
      started = true;
      if (kv && !d.local) {
        void run(true);
        return;
      }
      // At home, or with no store at all: what the start found is known at once.
      const cause: Cause | null = d.local ? (!d.local.firstRun && d.local.lost ? d.local.lost : null) : d.notify ? "none" : null;
      if (!cause) return;
      control.guard.checking(Promise.resolve(true)); // a pause read before now is not trusted
      // Only the guard reads the pause from now on, and here it looks no more: a pause it did not set is read once (nothing to check it against).
      chain = emptied("start", cause)()
        .then(async () => void (control.guard.known() ?? (await control.guard.read())))
        .catch((err: Error) => log.error(`${err.message}`));
    },
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    check: () => (started && kv && !d.local ? run() : chain),
  };
}
