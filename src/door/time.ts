// Local times in the owner's zone, and the next time of a repeating reminder.

import type { Every } from "../undo.ts";

const stampParts = (t: number, timeZone: string): Record<string, number> => {
  const field = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" } as const;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", ...field }).formatToParts(t);
  return Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]));
};

/** "2026-11-15 09:00" in a time zone as a moment, or null when it is not a real time there (a made-up day, or the hour that daylight saving skips). */
export function localToEpoch(local: string, timeZone: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(local.trim());
  if (!m) return null;
  const [y, mo, day, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const asUtc = Date.UTC(y, mo - 1, day, h, mi);
  const offset = (t: number): number => {
    const p = stampParts(t, timeZone);
    return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - t;
  };
  let t = asUtc - offset(asUtc);
  t = asUtc - offset(t);
  const back = stampParts(t, timeZone);
  return back.year === y && back.month === mo && back.day === day && back.hour === h && back.minute === mi ? t : null;
}

/** A moment as "2026-11-15 09:00" in a time zone: the form a reminder is written in. */
export function localStamp(t: number, timeZone: string): string {
  const p = stampParts(t, timeZone);
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${p.year}-${two(p.month!)}-${two(p.day!)} ${two(p.hour!)}:${two(p.minute!)}`;
}

/** A local day and hour as a moment; when daylight saving skips that hour, the first real minute after it (a quarter of an hour at a time). */
export function localOrLater(y: number, mo: number, day: number, h: number, mi: number, timeZone: string): number | null {
  const two = (n: number): string => String(n).padStart(2, "0");
  for (let k = 0; k <= 12; k++) {
    const t = new Date(Date.UTC(y, mo - 1, day, h, mi + 15 * k));
    const stamp = `${t.getUTCFullYear()}-${two(t.getUTCMonth() + 1)}-${two(t.getUTCDate())} ${two(t.getUTCHours())}:${two(t.getUTCMinutes())}`;
    const at = localToEpoch(stamp, timeZone);
    if (at !== null) return at;
  }
  return null;
}

/**
 * The next time of a repeating reminder after the one at `at`: its first time (`anchor`, "2026-01-31 09:00") gives the hour and, for a month or
 * a year, the day of the month; a month without that day takes its last day (31 Jan, 28 Feb, 31 Mar). In the owner's time zone, so 09:00
 * stays 09:00 across a change of daylight saving; an hour that a change skips becomes the first real time after it. Null when it cannot say.
 */
export function nextRepeat(at: number, every: Every, anchor: string, timeZone: string): number | null {
  const a = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(anchor);
  const cur = /^(\d{4})-(\d{2})-(\d{2})/.exec(localStamp(at, timeZone));
  if (!a || !cur) return null;
  let [y, m, d] = [Number(cur[1]), Number(cur[2]), Number(cur[3])];
  const anchorDay = Number(a[3]);
  const daysIn = (yy: number, mm: number): number => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const shift = (days: number): void => {
    const t = new Date(Date.UTC(y, m - 1, d + days));
    [y, m, d] = [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
  };
  if (every === "day") shift(1);
  else if (every === "week") shift(7);
  else if (every === "weekday") {
    do shift(1);
    while ([0, 6].includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay()));
  } else {
    if (every === "month") m = m === 12 ? 1 : m + 1;
    if (every === "month" && m === 1) y++;
    if (every === "year") y++;
    d = Math.min(anchorDay, daysIn(y, m));
  }
  const next = localOrLater(y, m, d, Number(a[4]), Number(a[5]), timeZone);
  return next !== null && next > at ? next : null;
}

/**
 * A repeat's first time: as given, except one that repeats on weekdays and was given a Saturday or a Sunday (in the owner's time zone),
 * which starts on the next Monday at that hour, as its later times skip weekends too (nextRepeat).
 */
export function firstRepeat(at: number, every: Every | undefined, timeZone: string): number {
  if (every !== "weekday") return at;
  const stamp = localStamp(at, timeZone);
  const [y, m, d] = stamp.slice(0, 10).split("-").map(Number);
  if (![0, 6].includes(new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay())) return at;
  return nextRepeat(at, every, stamp, timeZone) ?? at;
}

/** The first time of a repeating reminder after `after`, from the one at `at` (a reminder given late skips the times it missed). */
export function repeatAfter(at: number, every: Every, anchor: string, timeZone: string, after: number): number | null {
  let t = at;
  for (let i = 0; i < 2000 && t <= after; i++) {
    const next = nextRepeat(t, every, anchor, timeZone);
    if (next === null) return null;
    t = next;
  }
  return t > after ? t : null;
}
