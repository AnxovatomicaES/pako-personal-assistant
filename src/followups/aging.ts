// What the owner owes with no date and nothing a check can see (a "Needs you" email's ask, a promise made by mail): before this, such a loop
// was never nudged (its first check was 0) and was let go silently after OPEN_KEEP_MS. Now it is said twice as it ages, in working time:
// after two working days and after five, inside the day's budget and outside the quiet hours (src/followups/nudges.ts), with Done for the
// reply the owner already sent where Pako cannot see it. Someone else's promise is theirs to keep: chased (src/followups/chase.ts), never aged.

import { afterWorking, DEFAULT_WORK } from "./chase.ts";
import type { FollowupsConfig, Loop } from "./types.ts";

/** Working time after it was said, for each aging nudge in turn: two working days, then five. */
export const AGING_DAYS = [2, 5] as const;

/** A loop the owner owes, open, with no time and no check that could ever see it done. */
export function owedUndated(l: Pick<Loop, "kind" | "dueAt" | "check" | "status">): boolean {
  return l.kind !== "other_promise" && !l.dueAt && "none" in l.check && (l.status === "open" || l.status === "snoozed");
}

/**
 * When this loop's next aging nudge is due: its `nudges`-th step of AGING_DAYS working days after it was said, and, after the first, never
 * sooner than the steps' difference after the last one (a first nudge that came late, or an old loop at the upgrade, is not followed by the
 * second at the next tick). 0: none (not an owed undated loop, both said already, or no working time in the next two weeks).
 */
export function agingAt(l: Loop, tz: string, quiet: FollowupsConfig["quiet"], work: FollowupsConfig["work"]): number {
  if (!owedUndated(l)) return 0;
  const days = AGING_DAYS[l.nudges];
  if (days === undefined) return 0;
  const w = work ?? DEFAULT_WORK;
  const day = (w.end - w.start) * 60_000;
  const fromSaid = afterWorking(l.whenSaid, days * day, tz, quiet, w);
  if (fromSaid === null) return 0;
  const before = AGING_DAYS[l.nudges - 1];
  // From the last aging nudge itself (agedAt), never from checkedAt: a look that did not nudge (the day's cap spent) also sets that one,
  // and counting from it pushed the second nudge three working days back at every such look (review finding).
  if (before === undefined || !l.agedAt) return fromSaid;
  const fromLast = afterWorking(l.agedAt, (days - before) * day, tz, quiet, w);
  return fromLast === null ? 0 : Math.max(fromSaid, fromLast);
}

/** Whole days since it was said, for the card's "waiting N days". */
export function agedDays(l: Pick<Loop, "whenSaid">, t: number): number {
  return Math.max(1, Math.floor((t - l.whenSaid) / (24 * 3600_000)));
}
