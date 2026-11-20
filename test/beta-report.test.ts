// The beta's report (test/evals/beta-report.ts): counts only, never a title, name or message; misses and reopened closes counted.

import assert from "node:assert/strict";
import { test } from "node:test";
import { betaCounts, betaText } from "./evals/beta-report.ts";

const T0 = Date.parse("2026-11-20T09:00:00Z");
const DAY = 24 * 3600_000;
const loop = (id: string, o: Record<string, unknown>) => ({
  id, kind: "owner_promise", title: `Send Ana Ruiz the secret deck ${id}`, detail: "", who: "Ana Ruiz", where: { type: "slack_dm", label: "Ana Ruiz" },
  whenSaid: T0 - DAY, check: { none: { reason: "" } }, status: "open", nextCheckAt: 0, nudges: 0, createdAt: T0 - DAY,
  sources: [{ kind: "slack", ref: "1", label: "Ana Ruiz", at: T0 - DAY }], ...o,
});

test("beta report: counts the week (made, closed by whom, reopened, missed, reminders, thumbs) and prints no title or name", () => {
  const followups = {
    loops: [
      loop("a000000001", {}),
      loop("a000000002", { status: "done", closedAt: T0 - 2 * 3600_000 }),
      loop("a000000003", { status: "done", closedAt: T0 - 3600_000, autoClosed: { at: T0 - 3600_000, why: "seen on your calendar" } }),
      loop("a000000004", { kind: "request_to_owner", sources: [{ kind: "mail", ref: "m1", label: "email", at: T0 - DAY }] }),
      loop("a000000005", { createdAt: T0 - 30 * DAY, whenSaid: T0 - 30 * DAY, status: "done", closedAt: T0 - 29 * DAY }),
    ],
    batches: [],
  };
  const feedback = {
    verdicts: [{ what: "Send Ana Ruiz the secret deck", verdict: "down", at: T0 - DAY, source: "nudge", ref: "a000000001" }],
    nudges: [
      { at: T0 - DAY, ref: "a000000001", what: "Send Ana Ruiz the secret deck", outcome: "notmine" },
      { at: T0 - DAY, ref: "a000000004", what: "x", outcome: "done" },
      { at: T0 - DAY, ref: "a000000002", what: "y" },
    ],
    misses: [{ at: T0 - DAY, what: "send Omar the NDA" }, { at: T0 - 20 * DAY, what: "old" }],
    reopens: [{ at: T0 - 3600_000, what: "samir" }],
  };
  const c = betaCounts(followups, feedback, { now: T0, days: 7 });
  assert.equal(c.loops.made, 4, "the one from a month ago is not this week's");
  assert.deepEqual(c.loops.bySource, { slack: 3, mail: 1 });
  assert.deepEqual(c.closed, { byOwner: 1, byPako: 1, dismissed: 0 });
  assert.equal(c.open, 2);
  assert.equal(c.missed, 1);
  assert.equal(c.reopened, 1);
  assert.deepEqual(c.nudges, { sent: 3, done: 1, notMine: 1, snoozed: 0, unanswered: 1 });
  assert.deepEqual(c.thumbs, { up: 0, down: 1 });
  const text = betaText(c);
  assert.match(text, /\*\*Missed\*\* \(you told Pako it missed one\): 1/);
  assert.match(text, /Closed by Pako, then reopened by you:\*\* 1/);
  for (const secret of ["Ana", "Ruiz", "secret", "deck", "Omar", "NDA", "samir", "calendar"]) assert.ok(!text.includes(secret), `no "${secret}"`);
});

test("beta report: an empty or broken store gives zeros, not an error", () => {
  const c = betaCounts(null, "nonsense", { now: T0, days: 7 });
  assert.equal(c.loops.made, 0);
  assert.equal(c.missed, 0);
  assert.match(betaText(c), /Follow-ups made: 0 \(from: none; kinds: none\)/);
});
