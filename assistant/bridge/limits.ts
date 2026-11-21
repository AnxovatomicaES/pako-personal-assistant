// What the owner reads when Claude's limit stops Pako, and how long held work waits before it is tried again (runs.ts uses both).

import { locale, ownerClock } from "../../src/i18n.ts";
import { T } from "./texts.ts";

/** This computer's time zone: the CLI says its reset in it (budget.ts resetAt), so the owner reads it in the same one. */
const here = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const dayOf = (t: number, zone: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);

/**
 * The one notice: what is paused, what keeps working without Claude, and when what waits is done. `resetsAt`: the reset the CLI named (ms),
 * or null when it named none (then "as soon as Claude answers again"). `busy`: Claude overloaded rather than this plan's limit.
 */
export function limitText(o: { resetsAt: number | null; busy: boolean; now: number; zone?: string }): string {
  const t = T();
  const zone = o.zone ?? here();
  let when = t("whenBack");
  if (!o.busy && o.resetsAt !== null && o.resetsAt > o.now) {
    const time = ownerClock(o.resetsAt, zone);
    const today = dayOf(o.now, zone);
    const that = dayOf(o.resetsAt, zone);
    if (that === today) when = t("whenReset", { time });
    else {
      // The day after today's date, by the calendar: 24 hours on from now can land on the same day or skip one at a clock change.
      const [y, m, d] = today.split("-").map(Number);
      const tomorrow = new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10) === that;
      const day = tomorrow ? t("tomorrow") : `on ${new Intl.DateTimeFormat(locale(), { timeZone: zone, weekday: "long", day: "numeric", month: "long" }).format(o.resetsAt)}`;
      when = t("whenResetDay", { day, time });
    }
  }
  return `${t(o.busy ? "busyHead" : "limitHead")} ${t("limitBody", { when })}`;
}

/** The first wait of held work, doubled on each try after it, up to the longest. */
export const LIMIT_FIRST_WAIT_MS = 5 * 60_000;
export const LIMIT_LONGEST_WAIT_MS = 60 * 60_000;

/**
 * How long an item held by Claude's limit waits before it is tried again: 5 minutes, then 10, 20, 40 and every hour; never past the reset the
 * CLI named (plus a moment, so the first try after it finds the limit renewed). `tries`: how many times this item already met the limit.
 */
export function limitWait(tries: number, resetsAt: number, now: number): number {
  const backoff = Math.min(LIMIT_FIRST_WAIT_MS * 2 ** Math.max(0, tries - 1), LIMIT_LONGEST_WAIT_MS);
  return resetsAt > now ? Math.max(15_000, Math.min(backoff, resetsAt - now + 15_000)) : backoff;
}
