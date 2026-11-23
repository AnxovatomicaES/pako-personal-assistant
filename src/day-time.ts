// The owner's clock, one way everywhere: "HH:MM" settings, quiet-hour windows, the minute of the day in their zone, and calendar dates
// ("YYYY-MM-DD", no zone) moved by whole days. Before this, each module kept its own copy (five "HH:MM" parsers, five minute-of-day
// readers, four date shifts); they agreed, but the settings around them did not: an "OFF" in capitals was read by one and refused by the
// others, and a mistyped SLACK_QUIET_HOURS turned Slack off instead of falling back.

/** Minutes of the day [start, end): a window that crosses midnight when start > end. */
export interface Window {
  start: number;
  end: number;
}

/** "9:30" or "21:05" as minutes of the day; null when it is not a time. */
export function hhmm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/** "23:00-08:00" as a window; null when it does not read, or starts and ends at the same minute. */
export function windowOf(raw: string): Window | null {
  const [a, b, extra] = raw.split("-");
  if (extra !== undefined) return null;
  const start = hhmm(a ?? "");
  const end = hhmm(b ?? "");
  return start === null || end === null || start === end ? null : { start, end };
}

export const DEFAULT_QUIET: Window = { start: 23 * 60, end: 8 * 60 };

/**
 * A quiet-hours setting (`name` for the problem's words): "off" in any case is none, empty is the fallback, and a value that does not read
 * is reported and the fallback used (never something switched off because of it).
 */
export function quietSetting(raw: string | undefined, name: string, fallback: Window | null = DEFAULT_QUIET): { quiet: Window | null; problem?: string } {
  const v = (raw ?? "").trim();
  if (!v) return { quiet: fallback };
  if (v.toLowerCase() === "off") return { quiet: null };
  const w = windowOf(v);
  if (w) return { quiet: w };
  const used = fallback ? ` (${clock(fallback.start)}-${clock(fallback.end)} is used)` : "";
  return { quiet: fallback, problem: `${name} must be like 23:00-08:00, or off${used}` };
}

/** Minutes of the day as "HH:MM". */
export const clock = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

const fmts = new Map<string, Intl.DateTimeFormat>();
/** The minute of the day at `t` in the zone (0-1439). */
export function minutesOfDay(t: number, tz: string): number {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    fmts.set(tz, f);
  }
  const [h, m] = f.format(t).split(":").map(Number);
  return h! * 60 + m!;
}

/** Whether minute-of-day `x` is in the window. */
export const within = (w: Window, x: number): boolean => (w.start < w.end ? x >= w.start && x < w.end : x >= w.start || x < w.end);

/** Whether `t` falls in the quiet hours in the zone (none: never). */
export const quietAt = (q: Window | null, t: number, tz: string): boolean => !!q && within(q, minutesOfDay(t, tz));

/** The calendar date `k` days after "YYYY-MM-DD" (no zone: a date). */
export function addDays(day: string, k = 1): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + k)).toISOString().slice(0, 10);
}

/** The weekday of "YYYY-MM-DD", 0 = Sunday. */
export function weekdayOf(day: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * The weekday (0 = Sunday) a working week starts on: the working day after the longest run of days off, the earliest of them in a Monday-first
 * week when runs tie. Monday for Monday to Friday (and for seven days), Sunday for Sunday to Thursday, Friday for Friday to Sunday, so a week that
 * runs over the weekend ends on its Sunday and one that starts on it ends on its Thursday.
 */
export function weekStartOf(days: readonly number[]): number {
  let start = 1;
  let longest = 0;
  for (const d of [1, 2, 3, 4, 5, 6, 0]) {
    if (!days.includes(d)) continue;
    let gap = 1;
    while (!days.includes((d - gap + 7) % 7)) gap++;
    if (gap > longest) [start, longest] = [d, gap];
  }
  return start;
}
