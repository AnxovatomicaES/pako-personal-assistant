// The follow-ups' limits and timings: how much is kept, for how long, and when a loop is looked at (src/followups.ts says how they fit).

export const LOOPS_MAX = 100;
export const RULES_MAX = 30;
export const JOBS_MAX = 40;
export const BATCHES_MAX = 30;
export const BATCH_MSGS_MAX = 20;
export const LOOPS_PER_JOB = 3;
/** A meeting's review may leave more: the owner's to-dos, others' promises and the meetings agreed. */
export const REVIEW_LOOPS_MAX = 10;
/** A job the bridge never answered (an older bridge, a computer off for days) is forgotten after this. */
export const JOB_KEEP_MS = 2 * 24 * 3600_000;
/** An open loop nobody closed goes after this; a closed one is kept this long (the brief, an undo of a press). */
export const OPEN_KEEP_MS = 14 * 24 * 3600_000;
export const CLOSED_KEEP_MS = 7 * 24 * 3600_000;
/** The second (and last) nudge comes this long before the deadline. */
export const ESCALATE_BEFORE_MS = 60 * 60_000;
/** A loop that cannot be checked by anything (an email to send) is said once, this long before its deadline. */
export const NONE_BEFORE_MS = 2 * 3600_000;
export const SNOOZE_MS = 3600_000;
/** After its nudge, a loop with no time is looked at again (silently: only to close it) this often, for this long after it was said. */
export const RECHECK_MS = 3 * 3600_000;
export const RECHECK_FOR_MS = 3 * 24 * 3600_000;
/** A loop whose time passed this long ago is no longer shown (PENDING, the brief, the assistant's context). */
export const PAST_HIDE_MS = 6 * 3600_000;
/** A check is claimed for this long first: two processes (a deploy's overlap) never both check and nudge one loop. */
export const CLAIM_MS = 5 * 60_000;
/** A meeting created before the ask, or a repeating one, is not taken for the one asked for on its time alone. */
export const CREATED_SLACK_MS = 5 * 60_000;
/** A meeting counts as the one asked for when it starts this close to the time, whatever its topic; within the window when its topic names them. */
export const SAME_TIME_MS = 15 * 60_000;
export const NEAR_TIME_MS = 90 * 60_000;
export const TITLE_MAX = 140;
export const DETAIL_MAX = 300;
export const WHO_MAX = 60;

/** Button ids: f1 Done, f2 In 1 h, f3 Not mine (src/whatsapp.ts pressed). */
export const FOLLOWUP_BUTTON = /^f([123]):([0-9a-f]{10})$/;
/** The inbox id of an extraction job. */
export const jobInboxId = (id: string): string => `fu:${id}`;
