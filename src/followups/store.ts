// The store: one key (FOLLOWUPS_KEY), written one change at a time, never from a copy that could not be read. Old loops, jobs and
// batches are dropped on each write.

import {
  BATCHES_MAX, CLOSED_KEEP_MS, JOB_KEEP_MS, JOBS_MAX, LOOPS_MAX, MAIL_BATCHES_MAX, MAIL_READ_MAX, OPEN_KEEP_MS, PAST_HIDE_MS, RULES_MAX,
} from "./limits.ts";
import { stateOf } from "./record.ts";
import type { Engine } from "./parts.ts";
import type { FollowupsState } from "./types.ts";
import { createLog } from "../log.ts";

const log = createLog("followups");

/** The store key the brief and the Zoom review read (loopsOf turns its value into checked loops). */
export const FOLLOWUPS_KEY = "followups";
const TTL_SECONDS = 60 * 24 * 3600;

export function mountStore(fu: Engine): Pick<Engine, "mutate" | "read"> {
  const { d, now } = fu;
  let memory: FollowupsState = stateOf({});
  let chain: Promise<unknown> = Promise.resolve();

  const readStrict = async (): Promise<FollowupsState> => {
    if (!d.kv) return structuredClone(memory);
    const raw = await d.kv.get(FOLLOWUPS_KEY);
    if (!raw) return stateOf({});
    try {
      return stateOf(JSON.parse(raw));
    } catch {
      log.error("the stored record is not valid JSON: starting again");
      return stateOf({});
    }
  };
  /** One change at a time: read the whole record, change it, write it back. A store that cannot be read makes the change fail. */
  const mutate = <R>(fn: (s: FollowupsState) => R | Promise<R>): Promise<R> => {
    const run = chain.then(async () => {
      const s = await readStrict();
      const out = await fn(s);
      const t = now();
      s.loops = s.loops
        // An open loop is kept until its time has passed too (a deadline 30 days out keeps its reminder), not only 14 days from when it was made.
        .filter((l) => (l.status === "open" || l.status === "snoozed"
          ? t - l.createdAt < OPEN_KEEP_MS || (!!l.dueAt && t < l.dueAt + PAST_HIDE_MS)
          : t - (l.closedAt ?? l.createdAt) < CLOSED_KEEP_MS));
      // Over the cap, the oldest closed loops go first: an open one (a promise due in weeks) is never pushed out by newer closed ones.
      let over = s.loops.length - LOOPS_MAX;
      if (over > 0) s.loops = s.loops.filter((l) => l.status === "open" || l.status === "snoozed" || over-- <= 0).slice(-LOOPS_MAX);
      s.jobs = s.jobs.filter((j) => t - j.at < JOB_KEEP_MS).slice(-JOBS_MAX);
      s.batches = s.batches.slice(-BATCHES_MAX);
      // An email thread's words wait only for its job: one held for days (a queue that kept failing) goes, its words with it.
      s.mailBatches = s.mailBatches.filter((b) => t - b.firstAt < JOB_KEEP_MS).slice(-MAIL_BATCHES_MAX);
      s.mailRead = s.mailRead.slice(-MAIL_READ_MAX);
      s.rules = s.rules.slice(-RULES_MAX);
      if (d.kv) await d.kv.set(FOLLOWUPS_KEY, JSON.stringify(s), TTL_SECONDS);
      memory = s;
      return out;
    });
    chain = run.catch(() => undefined);
    return run;
  };
  const read = async (): Promise<FollowupsState> => {
    await chain.catch(() => undefined);
    return readStrict();
  };

  return { mutate, read };
}
