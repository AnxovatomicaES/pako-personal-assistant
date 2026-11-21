// The owner moved a loop's time somewhere else (its reminder in Apple Reminders, src/reminders-local.ts): the loop follows, and is looked at
// again as a loop with that time is. A snoozed one is open again (the owner planned it anew); a closed or parked one is not touched.

import { NONE_BEFORE_MS } from "./limits.ts";
import type { Base, Engine } from "./parts.ts";

export interface Due {
  /** The loop's time is now `at` (ms; null: no time any more). False when it is gone, closed or parked, or already at that time. */
  moveDue: (id: string, at: number | null) => Promise<boolean>;
}

export function mountDue({ now }: Base, { mutate, nextAfter }: Pick<Engine, "mutate" | "nextAfter">): Due {
  const moveDue: Due["moveDue"] = (id, at) =>
    mutate((s) => {
      const l = s.loops.find((x) => x.id === id);
      if (!l || (l.status !== "open" && l.status !== "snoozed")) return false;
      if (at === null ? l.dueAt === undefined : l.dueAt !== undefined && Math.abs(l.dueAt - at) < 60_000) return false;
      const t = now();
      if (at === null) delete l.dueAt;
      else l.dueAt = at;
      // Its time was said in another zone ("5:15 AM ET"): the owner's own new time is in theirs, so the other zone no longer says it.
      delete l.tz;
      const c = "zoomMeeting" in l.check ? l.check.zoomMeeting : "calendarEvent" in l.check ? l.check.calendarEvent : null;
      if (c && at === null) delete c.around;
      else if (c && at !== null) c.around = at;
      delete l.escalated;
      delete l.afterAsked;
      l.status = "open";
      // As a new one's first look is set (src/followups/matching.ts): two hours before its time when no server can see it, else nextAfter.
      l.nextCheckAt = at && "none" in l.check ? (at - NONE_BEFORE_MS > t ? at - NONE_BEFORE_MS : 0) : nextAfter(l, t);
      return true;
    });
  return { moveDue };
}
