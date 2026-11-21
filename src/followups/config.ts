// The follow-ups' settings from the environment (FOLLOWUPS, FOLLOWUP_*).

import { MAIL_JOBS_PER_DAY } from "./limits.ts";
import { quietSetting } from "../day-time.ts";
import type { FollowupsConfig } from "./types.ts";

type Env = Record<string, string | undefined>;

/**
 * Null when FOLLOWUPS=off. FOLLOWUP_DELAY_MIN (1-240, default 10), FOLLOWUP_MAX_PER_DAY (0-50, default 6), FOLLOWUP_BATCH_MIN (0-30, default 3),
 * FOLLOWUP_QUIET_HOURS (like 23:00-08:00 or off; default SLACK_QUIET_HOURS, else 23:00-08:00), FOLLOWUP_MAIL_JOBS_PER_DAY (0-200, default 40:
 * the email threads read whole a day; 0 reads only the triage's lines). A wrong value is reported and its default used.
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
  const mailPerDay = num("FOLLOWUP_MAIL_JOBS_PER_DAY", env.FOLLOWUP_MAIL_JOBS_PER_DAY, MAIL_JOBS_PER_DAY, 0, 200);
  const q = quietSetting(env.FOLLOWUP_QUIET_HOURS ?? env.SLACK_QUIET_HOURS, "FOLLOWUP_QUIET_HOURS");
  if (q.problem) problems.push(q.problem);
  const quiet: FollowupsConfig["quiet"] = q.quiet;
  return { config: { delayMs, maxPerDay, batchMs, quiet, mailPerDay }, problems };
}
