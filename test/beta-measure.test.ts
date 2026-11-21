// The beta's estimates (src/beta-measure.ts): Wilson and Kish on known values, recall, precision and auto-close accuracy on a fixture whose
// answers are worked out by hand, the bootstrap's interval, the pooled rate a stratum with no answers takes, and an export's strata checked.

import assert from "node:assert/strict";
import { test } from "node:test";
import { beta, effectiveN, estimate, intervalText, seeded, stratumOf, wilson, Z90, type Stratum } from "../src/beta-measure.ts";

const close = (a: number | null, b: number, eps = 1e-9): void => assert.ok(a !== null && Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test("wilson: 8 of 10 at 90% is 54.1%–93.1%, worked out from the formula; nothing answered is 0–1", () => {
  // p = 0.8, n = 10, z² = 2.7055: centre (0.8 + z²/20) / (1 + z²/10), half z·√(p(1−p)/n + z²/(4n²)) / (1 + z²/10).
  const z2 = Z90 * Z90;
  const den = 1 + z2 / 10;
  const mid = (0.8 + z2 / 20) / den;
  const half = (Z90 * Math.sqrt(0.016 + z2 / 400)) / den;
  const w = wilson(0.8, 10);
  close(w.low, mid - half);
  close(w.high, mid + half);
  close(w.low, 0.5408, 1e-4);
  close(w.high, 0.9314, 1e-4);
  assert.deepEqual(wilson(0.5, 0), { low: 0, high: 1 });
  // Never outside 0–1, at the edges too.
  assert.ok(wilson(1, 3).high <= 1 && wilson(0, 3).low >= 0);
});

test("kish: one stratum's effective size is its answers; unequal weights make it smaller than the answers", () => {
  close(effectiveN([{ N: 40, n: 4 }]), 4);
  // Weights 10 (×10) and 1 (×10): (110)² / (10·10² + 10·1²) = 12100 / 1010.
  close(effectiveN([{ N: 100, n: 10 }, { N: 10, n: 10 }]), 12100 / 1010);
  assert.equal(effectiveN([{ N: 5, n: 0 }]), 0);
});

/** Slack: 40 follow-ups made, 4 asked, 3 real; 200 threads with none, 8 asked, 1 had a promise; 10 closed by Pako, 2 asked, both right. */
const FIXTURE: Stratum[] = [
  { kind: "loop", source: "slack", N: 40, n: 4, yes: 3 },
  { kind: "thread", source: "slack", N: 200, n: 8, yes: 1 },
  { kind: "closed", source: "slack", N: 10, n: 2, yes: 2 },
];

test("estimates: the fixture's known answers (caught 30, missed 25 + 5 told: recall 50%; precision 75%; closes 10 of 12 right)", () => {
  const m = estimate({ strata: FIXTURE, missed: 5, reopened: 2 }, { reps: 400 });
  // Caught: 40 × 3/4 = 30. Missed in threads: 200 × 1/8 = 25. Told: 5. Recall = 30 / (30 + 25 + 5) = 0.5.
  close(m.recall.point, 0.5);
  assert.deepEqual(m.totals, { caught: 30, missedInThreads: 25, told: 5, made: 40, closed: 10, reopened: 2, uncovered: 0 });
  // Precision: 30 / 40, Wilson on 4 answers.
  close(m.precision.point, 0.75);
  close(m.precision.low, wilson(0.75, 4).low);
  close(m.precision.high, wilson(0.75, 4).high);
  // Auto-close accuracy: 10 right of 10 closed + 2 reopened (wrong for certain); Kish over weights 5 (×2) and 1 (×2).
  close(m.closeAccuracy.point, 10 / 12);
  const n = effectiveN([{ N: 10, n: 2 }, { N: 2, n: 2 }]);
  close(m.closeAccuracy.low, wilson(10 / 12, n).low);
  assert.equal(m.closeAccuracy.answered, 4);
  // The bootstrap's recall interval holds the point, stays in 0–1, and is the same twice (seeded).
  assert.ok(m.recall.low! <= 0.5 && m.recall.high! >= 0.5 && m.recall.low! >= 0 && m.recall.high! <= 1);
  assert.ok(m.recall.high! - m.recall.low! > 0.1, "a dozen answers cannot give a narrow interval");
  assert.deepEqual(estimate({ strata: FIXTURE, missed: 5, reopened: 2 }, { reps: 400 }).recall, m.recall);
  // By source: the told misses and the reopened closes belong to no source. Slack's recall = 30 / 55.
  close(m.bySource.slack.recall.point, 30 / 55);
  close(m.bySource.slack.closeAccuracy.point, 1);
  assert.equal(m.bySource.mail.recall.point, null);
  assert.match(intervalText(m.precision), /^75% \(90% interval 36%–94%, 4 answers\)$/);
  assert.match(intervalText(m.bySource.mail.recall), /^not measured yet/);
});

test("estimates: a few answers that all agree still give a wide interval, not 100%–100%; nothing answered gives no number", () => {
  const sure = estimate({ strata: [{ kind: "loop", source: "mail", N: 10, n: 3, yes: 3 }, { kind: "thread", source: "mail", N: 50, n: 6, yes: 0 }], missed: 0, reopened: 0 },
    { reps: 2000 });
  assert.equal(sure.recall.point, 1);
  assert.equal(sure.recall.high, 1);
  assert.ok(sure.recall.low! < 0.8, `low ${sure.recall.low}: nine answers cannot prove a perfect catch rate`);
  // With many more answers that agree, it narrows.
  const many = estimate({ strata: [{ kind: "loop", source: "mail", N: 1000, n: 300, yes: 300 }, { kind: "thread", source: "mail", N: 5000, n: 600, yes: 0 }],
    missed: 0, reopened: 0 }, { reps: 2000 });
  assert.ok(many.recall.low! > sure.recall.low! && many.recall.low! > 0.95);
  const none = estimate({ strata: [{ kind: "loop", source: "mail", N: 10, n: 0, yes: 0 }], missed: 3, reopened: 0 }, { reps: 50 });
  assert.equal(none.recall.point, null);
  assert.equal(none.precision.point, null);
  assert.equal(none.totals.uncovered, 10);
});

test("estimates: a week with no answers takes the same source's rate from its other weeks, else every source's", () => {
  const m = estimate({
    strata: [
      { kind: "loop", source: "mail", N: 20, n: 4, yes: 2 },
      { kind: "loop", source: "mail", N: 20, n: 0, yes: 0 }, // another week, nothing answered: mail's 50%
      { kind: "loop", source: "slack", N: 10, n: 2, yes: 2 },
      { kind: "loop", source: "meeting", N: 6, n: 0, yes: 0 }, // no meeting answered ever: every source's (4 of 6)
      { kind: "thread", source: "mail", N: 100, n: 5, yes: 0 },
    ],
    missed: 0, reopened: 0,
  }, { reps: 100 });
  // Caught: 20·½ + 20·½ + 10·1 + 6·⅔ = 34; made 56.
  close(m.totals.caught, 34);
  assert.equal(m.totals.made, 56);
  close(m.precision.point, 34 / 56);
});

test("beta draws: Beta(a, b) has mean a / (a + b), seeded", () => {
  const r = seeded(5);
  for (const [a, b] of [[0.5, 0.5], [3.5, 1.5], [1.5, 8.5]] as const) {
    let sum = 0;
    for (let i = 0; i < 20000; i++) sum += beta(a, b, r);
    assert.ok(Math.abs(sum / 20000 - a / (a + b)) < 0.01, `Beta(${a}, ${b})`);
  }
});

test("strata from an export: fixed words and whole counts only, yes ≤ n ≤ N", () => {
  assert.deepEqual(stratumOf({ kind: "thread", source: "mail", N: 3, n: 2, yes: 1 }), { kind: "thread", source: "mail", N: 3, n: 2, yes: 1 });
  for (const bad of [
    { kind: "thread", source: "mail", N: 3, n: 4, yes: 1 },
    { kind: "thread", source: "mail", N: 3, n: 2, yes: 3 },
    { kind: "thread", source: "email from Ana", N: 3, n: 2, yes: 1 },
    { kind: "other", source: "mail", N: 3, n: 2, yes: 1 },
    { kind: "thread", source: "mail", N: 3.5, n: 2, yes: 1 },
    { kind: "thread", source: "mail", N: -1, n: 0, yes: 0 },
    "thread", null, [],
  ]) assert.equal(stratumOf(bad), null, JSON.stringify(bad));
});
