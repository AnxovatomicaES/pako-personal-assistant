// The follow-ups' settings from the environment (FOLLOWUPS, FOLLOWUP_*).

import type { FollowupsConfig } from "./types.ts";

type Env = Record<string, string | undefined>;

const hhmm = (s: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
};

/**
 * Null when FOLLOWUPS=off. FOLLOWUP_DELAY_MIN (1-240, default 10), FOLLOWUP_MAX_PER_DAY (0-50, default 6), FOLLOWUP_BATCH_MIN (0-30, default 3),
 * FOLLOWUP_QUIET_HOURS (like 23:00-08:00 or off; default SLACK_QUIET_HOURS, else 23:00-08:00). A wrong value is reported and its default used.
 */
export function loadFollowupsConfig(env: Env): { config: FollowupsConfig | null; problems: string[] } {
  const problems: string[] = [];
  const flag = (env.FOLLOWUPS ?? "on").trim().toLowerCase();
  if (flag === "off") return { config: null, problems };
  if (flag !== "on" && flag !== "") problems.push("FOLLOWUPS must be on or off (on is used)");
  const num = (key: string, raw: string | undefined, fallback: number, min: number, max: number): number => {
    const v = (raw ?? "").trim();
    if (!v) return fallback;
    const n = Number(v);
    if (Number.isInteger(n) && n >= min && n <= max) return n;
    problems.push(`${key} must be a whole number from ${min} to ${max} (${fallback} is used)`);
    return fallback;
  };
  const delayMs = num("FOLLOWUP_DELAY_MIN", env.FOLLOWUP_DELAY_MIN, 10, 1, 240) * 60_000;
  const maxPerDay = num("FOLLOWUP_MAX_PER_DAY", env.FOLLOWUP_MAX_PER_DAY, 6, 0, 50);
  const batchMs = num("FOLLOWUP_BATCH_MIN", env.FOLLOWUP_BATCH_MIN, 3, 0, 30) * 60_000;
  const rawQuiet = (env.FOLLOWUP_QUIET_HOURS ?? env.SLACK_QUIET_HOURS ?? "23:00-08:00").trim();
  let quiet: FollowupsConfig["quiet"] = { start: 23 * 60, end: 8 * 60 };
  if (rawQuiet === "off") quiet = null;
  else {
    const [a, b] = rawQuiet.split("-");
    const start = hhmm(a ?? "");
    const end = hhmm(b ?? "");
    if (start === null || end === null || start === end) problems.push("FOLLOWUP_QUIET_HOURS must be like 23:00-08:00, or off (23:00-08:00 is used)");
    else quiet = { start, end };
  }
  return { config: { delayMs, maxPerDay, batchMs, quiet }, problems };
}
