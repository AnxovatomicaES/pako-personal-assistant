// Times and zones: a zone as a person writes it, a time said in a zone, and how a time is said.

export const isZone = (tz: string): boolean => {
  if (!/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2})$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    /* not a zone this runtime knows */
    return false;
  }
};
/** What a person writes for a zone, as an IANA one: "ET" is New York's. */
export const ZONE_WORDS: Record<string, string> = {
  et: "America/New_York", est: "America/New_York", edt: "America/New_York", ny: "America/New_York",
  ct: "America/Chicago", cst: "America/Chicago", cdt: "America/Chicago",
  mt: "America/Denver", mst: "America/Denver", mdt: "America/Denver",
  pt: "America/Los_Angeles", pst: "America/Los_Angeles", pdt: "America/Los_Angeles",
  hkt: "Asia/Hong_Kong", hk: "Asia/Hong_Kong", cet: "Europe/Paris", cest: "Europe/Paris", utc: "UTC", gmt: "UTC",
};
export const zoneOf = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return ZONE_WORDS[s.toLowerCase()] ?? (isZone(s) ? s : null);
};
/** How a zone is said in a nudge: ET, PT, Hong Kong, London. */
export const ZONE_NAMES: Record<string, string> = {
  "America/New_York": "ET", "America/Chicago": "CT", "America/Denver": "MT", "America/Los_Angeles": "PT", UTC: "UTC",
};
export const zoneName = (tz: string): string => ZONE_NAMES[tz] ?? (tz.split("/").pop() ?? tz).replace(/_/g, " ");

export const offsetAt = (t: number, tz: string): number => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(t).map((x) => [x.type, x.value]),
  );
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - Math.floor(t / 1000) * 1000;
};

/** "2026-11-16 05:15" (or "2026-11-16": 18:00) in a zone, as ms; null when it is not a real time. */
export function zonedTime(stamp: unknown, tz: string): number | null {
  const m = typeof stamp === "string" ? /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(stamp.trim()) : null;
  if (!m) return null;
  const [y, mo, d, h, mi] = [+m[1]!, +m[2]!, +m[3]!, m[4] === undefined ? 18 : +m[4], m[5] === undefined ? 0 : +m[5]];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  if (new Date(guess).getUTCDate() !== d) return null;
  const first = guess - offsetAt(guess, tz);
  return guess - offsetAt(first, tz);
}

export const clock12 = (t: number, tz: string): string =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(t);
