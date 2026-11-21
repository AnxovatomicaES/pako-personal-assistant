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

// ---------- the measured part, the export and the pooling ----------

import { betaExport, exportOf, type BetaExport } from "./evals/beta-report.ts";
import { combineText, dedupe, pool } from "./evals/beta-combine.ts";
import { estimate } from "../src/beta-measure.ts";

/** What a tester's store holds: words of messages, names and addresses everywhere the audit could have kept them. */
const BODIES = ["Can you send me the Henderson contract by Thursday?", "Priya will forward the Q3 budget numbers"];
const NAMES = ["Ana Ruiz", "Priya Raman", "Omar"];
const ADDRESSES = ["ana.ruiz@acme-corp.com", "priya@example.org"];
const SUBJECTS = ["Re: Henderson renewal"];
const auditStore = {
  on: true, since: T0 - 14 * DAY, tester: "0a1b2c3d4e5f",
  seen: [{ id: "j000000001", at: T0 - DAY, source: "mail", label: `${SUBJECTS[0]} · ${ADDRESSES[0]}`, people: [NAMES[0], ADDRESSES[1]], lines: BODIES, loops: 0 }],
  rounds: [{
    id: "1234567890", at: T0 - 2 * DAY, from: T0 - 9 * DAY, ignoredRun: 0,
    strata: [
      { kind: "thread", source: "mail", N: 40, drawn: 6 }, { kind: "thread", source: "slack", N: 20, drawn: 2 },
      { kind: "loop", source: "slack", N: 8, drawn: 2 }, { kind: "closed", source: "mail", N: 2, drawn: 2 },
    ],
    questions: [
      { id: "a000000001", kind: "thread", source: "mail", ref: "j000000001", stratum: 0, askedAt: T0 - DAY, answer: "yes", answeredAt: T0 - DAY },
      ...[2, 3, 4, 5].map((i) => ({ id: `a00000000${i}`, kind: "thread", source: "mail", ref: `j00000000${i}`, stratum: 0, askedAt: T0 - DAY, answer: "no" })),
      // Still waiting, and still showing its words: the export must not carry them.
      { id: "a000000006", kind: "thread", source: "mail", ref: "j000000006", stratum: 0, askedAt: T0 - 3600_000,
        show: { label: `${SUBJECTS[0]} · ${ADDRESSES[0]}`, people: [NAMES[1], ADDRESSES[1]], lines: BODIES } },
      { id: "a000000007", kind: "thread", source: "slack", ref: "j000000007", stratum: 1, askedAt: T0 - DAY, answer: "skip" },
      { id: "a000000008", kind: "thread", source: "slack", ref: "j000000008", stratum: 1, askedAt: T0 - DAY, answer: "no" },
      { id: "a000000009", kind: "loop", source: "slack", ref: "a000000001", stratum: 2, askedAt: T0 - DAY, answer: "yes" },
      { id: "a000000010", kind: "loop", source: "slack", ref: "a000000002", stratum: 2, askedAt: T0 - DAY, answer: "no" },
      { id: "a000000011", kind: "closed", source: "mail", ref: "a000000003", stratum: 3, askedAt: T0 - DAY, answer: "ignored" },
      { id: "a000000012", kind: "closed", source: "mail", ref: "a000000004", stratum: 3, askedAt: T0 - DAY, answer: "yes" },
    ],
  }],
};
const followupsStore = {
  loops: [
    loop("a000000001", { title: `Send ${NAMES[0]} the Henderson contract`, who: NAMES[0], where: { type: "mail", label: ADDRESSES[0], mailThread: SUBJECTS[0] } }),
    loop("a000000003", { status: "done", closedAt: T0 - 3600_000, autoClosed: { at: T0 - 3600_000, why: `${NAMES[1]} replied from ${ADDRESSES[1]}` } }),
  ],
  batches: [],
};
const feedbackStore = {
  verdicts: [], nudges: [{ at: T0 - DAY, ref: "a000000001", what: `Send ${NAMES[0]} the Henderson contract` }],
  misses: [{ at: T0 - DAY, what: `send ${NAMES[2]} the NDA ${ADDRESSES[1]}`, loop: "a000000009" }], reopens: [{ at: T0 - DAY, what: "henderson" }],
};

test("beta report: the measured part (opted in) is computed from the audit's counts, and printed with no word of any message", () => {
  const c = betaCounts(followupsStore, feedbackStore, { now: T0, days: 7 });
  const e = betaExport(followupsStore, feedbackStore, auditStore, { now: T0, days: 7 });
  assert.deepEqual(e.audit.strata, [
    { kind: "thread", source: "mail", N: 40, n: 5, yes: 1 },
    { kind: "thread", source: "slack", N: 20, n: 1, yes: 0 },
    { kind: "loop", source: "slack", N: 8, n: 2, yes: 1 },
    { kind: "closed", source: "mail", N: 2, n: 1, yes: 1 },
  ]);
  assert.deepEqual([e.audit.rounds, e.audit.asked, e.audit.answered, e.audit.skipped, e.audit.ignored], [1, 12, 9, 1, 1]);
  const text = betaText(c, e.audit);
  assert.match(text, /### Measured \(weekly sampled check, 1 week\(s\)\)/);
  assert.match(text, /\*\*Catch rate \(recall\):\*\* \d+% \(90% interval \d+%–\d+%, 8 answers\)/);
  assert.match(text, /\| Mail \|.*\n\| Slack \|/s);
  for (const secret of [...BODIES, ...NAMES, ...ADDRESSES, ...SUBJECTS, "Henderson", "Priya", "acme"]) assert.ok(!text.includes(secret), `no "${secret}"`);
  // Without an audit (not opted in), the report is as before.
  assert.ok(!betaText(c, null).includes("Measured"));
});

test("beta export: only counts, fixed words and a random id; no text from any message, name, subject or address", () => {
  const e = betaExport(followupsStore, feedbackStore, auditStore, { now: T0, days: 7 });
  const json = JSON.stringify(e);
  for (const secret of [...BODIES, ...NAMES, ...ADDRESSES, ...SUBJECTS, "Henderson", "henderson", "Priya", "Ruiz", "acme", "NDA", "Thursday", "budget"]) {
    assert.ok(!json.includes(secret), `the export holds "${secret}"`);
  }
  // Every string in it is a fixed word, the day or the random id.
  const strings: string[] = [];
  const walk = (v: unknown, key = ""): void => {
    if (typeof v === "string") strings.push(v);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (strings.push(k), walk(x, k));
    void key;
  };
  walk(e);
  const allowed = /^(pako-beta-export|0a1b2c3d4e5f|\d{4}-\d{2}-\d{2}|[a-zA-Z_]{1,20}|\d{1,3})$/;
  assert.deepEqual(strings.filter((s) => !allowed.test(s)), []);
  assert.ok(strings.every((s) => !/\s|@/.test(s)), "no spaces or addresses in any string");
  assert.deepEqual(exportOf(JSON.parse(json)), e, "it reads back the same");
});

test("beta export: read back strictly; anything else in the file is dropped, a wrong field refuses the file", () => {
  const e = betaExport(followupsStore, feedbackStore, auditStore, { now: T0, days: 7 });
  const extra = { ...structuredClone(e), note: "from Ana Ruiz", counts: { ...structuredClone(e.counts), who: "Ana" } };
  const back = exportOf(extra);
  assert.ok(back);
  assert.ok(!JSON.stringify(back).includes("Ana"));
  assert.equal(exportOf({ ...structuredClone(e), version: 2 }), null);
  assert.equal(exportOf({ ...structuredClone(e), tester: "Ana Ruiz" }), null);
  const bad = structuredClone(e);
  (bad.audit.strata[0] as unknown as Record<string, unknown>).source = "ana.ruiz@acme-corp.com";
  assert.equal(exportOf(bad), null);
  const badKey = structuredClone(e);
  (badKey.counts.loops.bySource as Record<string, number>)["Ana Ruiz"] = 1;
  assert.equal(exportOf(badKey), null);
});

test("beta combine: pools testers' strata side by side and sums their counts; the same tester sent twice counts once", () => {
  const mk = (tester: string, day: string, strata: BetaExport["audit"]["strata"], missed: number, reopened: number): BetaExport => {
    const e = betaExport(null, null, null, { now: Date.parse(`${day}T12:00:00Z`), days: 14 });
    return { ...e, tester, counts: { ...e.counts, missed, reopened, loops: { ...e.counts.loops, made: 5 } }, audit: { ...e.audit, answered: 3, strata } };
  };
  const a = mk("aaaaaaaa", "2026-11-20", [{ kind: "loop", source: "slack", N: 40, n: 4, yes: 3 }, { kind: "thread", source: "slack", N: 100, n: 8, yes: 1 }], 2, 1);
  const aOld = mk("aaaaaaaa", "2026-11-13", [{ kind: "loop", source: "slack", N: 99, n: 1, yes: 0 }], 50, 50);
  const b = mk("bbbbbbbb", "2026-11-20", [{ kind: "loop", source: "mail", N: 20, n: 2, yes: 2 }, { kind: "thread", source: "mail", N: 100, n: 4, yes: 0 },
    { kind: "closed", source: "mail", N: 4, n: 2, yes: 1 }], 3, 0);
  assert.deepEqual(dedupe([aOld, a, b]), [a, b], "the newest export of a tester");
  const p = pool(dedupe([aOld, a, b]));
  assert.equal(p.strata.length, 5);
  assert.deepEqual([p.missed, p.reopened, p.made, p.answered], [5, 1, 10, 6]);
  // The pooled recall, by hand: caught 40·¾ + 20·1 = 50; missed in threads 100·⅛ + 100·0 = 12.5; told 5. 50 / 67.5.
  const m = estimate({ strata: p.strata, missed: p.missed, reopened: p.reopened }, { reps: 200 });
  assert.ok(Math.abs(m.recall.point! - 50 / 67.5) < 1e-9);
  assert.ok(Math.abs(m.precision.point! - 50 / 60) < 1e-9);
  // Closes: 4·½ = 2 right of 4 + 1 reopened.
  assert.ok(Math.abs(m.closeAccuracy.point! - 2 / 5) < 1e-9);
  assert.ok(Math.abs(m.bySource.slack.recall.point! - 30 / 42.5) < 1e-9);
  assert.equal(m.bySource.mail.recall.point, 1);
  const text = combineText([aOld, a, b], { reps: 200 });
  assert.match(text, /^## Pako beta, pooled: 2 tester\(s\)/);
  assert.match(text, /Follow-ups made: 10; misses told: 5; closes reopened: 1; audit answers: 6/);
  assert.match(text, /\*\*Catch rate \(recall\):\*\* 74% \(90% interval \d+%–\d+%, 18 answers\)/);
  assert.match(text, /\| Slack \| 71% /);
  assert.match(text, /\| Mail \| 100% /);
});
