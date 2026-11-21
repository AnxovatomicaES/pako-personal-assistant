// The beta's measured catch rate: what the weekly sampled audit (src/beta-audit.ts) labelled, made into estimates with 90% intervals. Pure
// functions on counts only (no title, name or message ever reaches here), shared by the report (npm run beta:report), its export, and the
// pooling of several testers' exports (npm run beta:combine).
//
// - A stratum: one week's population of one kind from one source: threads read with no follow-up made ("thread"), follow-ups made ("loop"),
//   follow-ups Pako closed on its own ("closed"). N is its size, n how many of its sampled items were answered Yes or No, yes how many were
//   Yes (a promise was there, it was a real promise, the close was right). Each answered item stands for N / n of its stratum: its weight.
// - recall = caught real promises / all real promises. Caught: Σ N·(share real) over the follow-ups made. Missed: Σ N·(share with a promise)
//   over the threads with none, plus the misses the tester told Pako about ("you missed …"), counted whole and overall only. A told miss that
//   was also in a sampled thread is counted twice, so recall errs low, never high.
// - precision = real / made. Auto-close accuracy = right / closed by Pako, with the closes the tester reopened counted wrong (overall only:
//   a reopen does not say its source).
// - Intervals at 90%: Wilson on the weighted share with Kish's effective sample size for precision and close accuracy. Recall is a ratio of
//   estimated totals: a stratified Bayesian bootstrap, each answered stratum's share drawn from its Jeffreys posterior Beta(yes + ½, no + ½)
//   (a plain resampling of three answers that all agree would claim 100%–100%), seeded so the same data always reads the same.
// - A stratum with N but no answers takes its kind's rate from the same source's other weeks, else from every source; with none, its N is
//   reported as not covered and left out of the estimates.

export const AUDIT_KINDS = ["thread", "loop", "closed"] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];
export const AUDIT_SOURCES = ["mail", "slack", "meeting", "chat"] as const;
export type AuditSource = (typeof AUDIT_SOURCES)[number];

export interface Stratum {
  kind: AuditKind;
  source: AuditSource;
  /** The population's size that week. */
  N: number;
  /** Sampled items answered Yes or No (Skip, unanswered and expired ones are not). */
  n: number;
  yes: number;
}

export interface Interval {
  /** null: nothing answered to estimate it from. */
  point: number | null;
  low: number | null;
  high: number | null;
  /** The answers it rests on. */
  answered: number;
}

export interface Measures {
  recall: Interval;
  precision: Interval;
  closeAccuracy: Interval;
  /** Estimated totals behind them (rounded to one decimal), and the population no answer covers. */
  totals: { caught: number; missedInThreads: number; told: number; made: number; closed: number; reopened: number; uncovered: number };
}

export interface MeasureInput {
  strata: Stratum[];
  /** "you missed …" in the window. */
  missed: number;
  /** Closes of Pako's the tester reopened in the window. */
  reopened: number;
}

/** z for a two-sided 90% interval. */
export const Z90 = 1.6448536269514722;
const BOOT_REPS = 2000;
const BOOT_SEED = 20261120;

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1e7;

/** A stratum from untrusted JSON (an export), or null: fixed words and whole counts only, yes ≤ n ≤ N. */
export function stratumOf(v: unknown): Stratum | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!(AUDIT_KINDS as readonly unknown[]).includes(o.kind) || !(AUDIT_SOURCES as readonly unknown[]).includes(o.source)) return null;
  if (!isCount(o.N) || !isCount(o.n) || !isCount(o.yes) || o.yes > o.n || o.n > o.N) return null;
  return { kind: o.kind as AuditKind, source: o.source as AuditSource, N: o.N, n: o.n, yes: o.yes };
}

/** Wilson's interval for a share p over n answers (n may be an effective, fractional size). */
export function wilson(p: number, n: number, z: number = Z90): { low: number; high: number } {
  if (!(n > 0)) return { low: 0, high: 1 };
  const z2 = z * z;
  const den = 1 + z2 / n;
  const mid = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return { low: Math.max(0, mid - half), high: Math.min(1, mid + half) };
}

/** Kish's effective sample size of the answered items of these strata (each weighing N / n). */
export function effectiveN(strata: readonly Pick<Stratum, "N" | "n">[]): number {
  let sw = 0;
  let sw2 = 0;
  for (const s of strata) {
    if (s.n <= 0 || s.N <= 0) continue;
    sw += s.N;
    sw2 += (s.N * s.N) / s.n;
  }
  return sw2 > 0 ? (sw * sw) / sw2 : 0;
}

/** The rate each stratum is estimated with (its own, else pooled as the header says); null: not covered. `share` may be a bootstrap draw. */
function ratesOf(strata: readonly Stratum[], share: readonly number[]): (number | null)[] {
  const pool = (f: (s: Stratum) => boolean): number | null => {
    let y = 0;
    let n = 0;
    strata.forEach((s, i) => {
      if (s.n > 0 && f(s)) {
        y += share[i]! * s.n;
        n += s.n;
      }
    });
    return n > 0 ? y / n : null;
  };
  const cache = new Map<string, number | null>();
  const pooled = (k: string, f: (s: Stratum) => boolean): number | null => {
    if (!cache.has(k)) cache.set(k, pool(f));
    return cache.get(k)!;
  };
  return strata.map((s, i) => {
    if (s.N <= 0) return null;
    if (s.n > 0) return share[i]!;
    return pooled(`${s.kind}/${s.source}`, (x) => x.kind === s.kind && x.source === s.source) ?? pooled(s.kind, (x) => x.kind === s.kind);
  });
}

interface Totals {
  caught: number;
  made: number;
  missed: number;
  threads: number;
  right: number;
  closed: number;
  uncovered: number;
}

function totalsOf(strata: readonly Stratum[], rates: readonly (number | null)[], keep: (s: Stratum) => boolean): Totals {
  const t: Totals = { caught: 0, made: 0, missed: 0, threads: 0, right: 0, closed: 0, uncovered: 0 };
  strata.forEach((s, i) => {
    if (!keep(s)) return;
    const r = rates[i];
    if (r === null || r === undefined) {
      t.uncovered += s.N;
      return;
    }
    if (s.kind === "loop") {
      t.caught += s.N * r;
      t.made += s.N;
    } else if (s.kind === "thread") {
      t.missed += s.N * r;
      t.threads += s.N;
    } else {
      t.right += s.N * r;
      t.closed += s.N;
    }
  });
  return t;
}

const recallOf = (t: Totals, told: number): number | null => {
  // Without an answered follow-up and an answered thread, a recall would only say what was not measured.
  if (t.made <= 0 || t.threads <= 0) return null;
  const all = t.caught + t.missed + told;
  return all > 0 ? t.caught / all : null;
};

/** mulberry32: a small seeded generator, so a bootstrap reads the same each time. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A standard normal draw (Box–Muller). */
const normal = (rand: () => number): number => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

/** A Gamma(a, 1) draw (Marsaglia–Tsang; for a < 1, Gamma(a + 1)·U^(1/a)). */
function gamma(a: number, rand: () => number): number {
  if (a < 1) return gamma(a + 1, rand) * Math.pow(1 - rand(), 1 / a);
  const d = a - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rand);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = 1 - rand();
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}

/** A Beta(a, b) draw. */
export function beta(a: number, b: number, rand: () => number): number {
  const x = gamma(a, rand);
  const y = gamma(b, rand);
  return x / (x + y);
}

const quantile = (sorted: readonly number[], q: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!;
const round1 = (x: number): number => Math.round(x * 10) / 10;
const answeredOf = (strata: readonly Stratum[], kind: AuditKind, keep: (s: Stratum) => boolean): number =>
  strata.filter((s) => s.kind === kind && keep(s)).reduce((a, s) => a + s.n, 0);

/** A share with Wilson's interval on Kish's effective size; `extra`: answers known for certain (reopened closes: N = n, all "no"). */
function shareOf(strata: readonly Stratum[], kind: AuditKind, num: number, den: number, keep: (s: Stratum) => boolean, extra = 0): Interval {
  const answered = answeredOf(strata, kind, keep);
  if (den + extra <= 0 || answered + extra <= 0) return { point: null, low: null, high: null, answered };
  const p = num / (den + extra);
  const labelled = strata.filter((s) => s.kind === kind && keep(s) && s.n > 0);
  const n = effectiveN([...labelled, ...(extra ? [{ N: extra, n: extra }] : [])]);
  const w = wilson(p, n);
  return { point: p, low: w.low, high: w.high, answered: answered + extra };
}

/**
 * The estimates over these strata (one tester's, or many pooled): overall, with the told misses and reopened closes, and by source, without
 * them. `reps`, `seed`: the bootstrap's (tests use fewer).
 */
export function estimate(input: MeasureInput, o: { reps?: number; seed?: number } = {}): Measures & { bySource: Record<AuditSource, Measures> } {
  const strata = input.strata.filter((s) => s.N > 0);
  const told = Math.max(0, input.missed);
  const reopened = Math.max(0, input.reopened);
  const rates = ratesOf(strata, strata.map((s) => (s.n > 0 ? s.yes / s.n : 0)));
  const all = (): boolean => true;
  const bySourceKeep = (src: AuditSource) => (s: Stratum): boolean => s.source === src;

  // The bootstrap: each answered stratum's share drawn from its Jeffreys posterior, every rate then worked out again (the pooled ones too),
  // and recall with them.
  const reps = o.reps ?? BOOT_REPS;
  const rand = seeded(o.seed ?? BOOT_SEED);
  const draws: { all: number[]; by: Record<AuditSource, number[]> } = { all: [], by: { mail: [], slack: [], meeting: [], chat: [] } };
  for (let r = 0; r < reps; r++) {
    const rr = ratesOf(strata, strata.map((s) => (s.n > 0 ? beta(s.yes + 0.5, s.n - s.yes + 0.5, rand) : 0)));
    const a = recallOf(totalsOf(strata, rr, all), told);
    if (a !== null) draws.all.push(a);
    for (const src of AUDIT_SOURCES) {
      const b = recallOf(totalsOf(strata, rr, bySourceKeep(src)), 0);
      if (b !== null) draws.by[src].push(b);
    }
  }

  const measure = (keep: (s: Stratum) => boolean, toldHere: number, reopenedHere: number, boot: number[]): Measures => {
    const t = totalsOf(strata, rates, keep);
    const point = recallOf(t, toldHere);
    const sorted = [...boot].sort((x, y) => x - y);
    const answered = answeredOf(strata, "loop", keep) + answeredOf(strata, "thread", keep);
    return {
      recall: point === null || !sorted.length
        ? { point: null, low: null, high: null, answered }
        : { point, low: Math.min(point, quantile(sorted, 0.05)), high: Math.max(point, quantile(sorted, 0.95)), answered },
      precision: shareOf(strata, "loop", t.caught, t.made, keep),
      closeAccuracy: shareOf(strata, "closed", t.right, t.closed, keep, reopenedHere),
      totals: {
        caught: round1(t.caught), missedInThreads: round1(t.missed), told: toldHere, made: t.made, closed: t.closed, reopened: reopenedHere,
        uncovered: t.uncovered,
      },
    };
  };
  const bySource = Object.fromEntries(AUDIT_SOURCES.map((src) => [src, measure(bySourceKeep(src), 0, 0, draws.by[src])])) as Record<AuditSource, Measures>;
  return { ...measure(all, told, reopened, draws.all), bySource };
}

const pct = (x: number | null): string => (x === null ? "–" : `${Math.round(x * 100)}%`);

/** One estimate as a report reads it: "72% (90% interval 58–83%, 19 answers)", or "not measured yet". */
export function intervalText(i: Interval): string {
  const answers = `${i.answered} ${i.answered === 1 ? "answer" : "answers"}`;
  if (i.point === null) return `not measured yet (${answers})`;
  return `${pct(i.point)} (90% interval ${pct(i.low)}–${pct(i.high)}, ${answers})`;
}

/** The measured part of a report or of the pooled one, as Markdown: counts and shares only. */
export function measuresText(m: Measures & { bySource: Record<AuditSource, Measures> }, title: string): string[] {
  const names: Record<AuditSource, string> = { mail: "Mail", slack: "Slack", meeting: "Meetings", chat: "Chat" };
  const rows = AUDIT_SOURCES.filter((s) => {
    const x = m.bySource[s];
    return x.recall.answered || x.precision.answered || x.closeAccuracy.answered || x.totals.made || x.totals.uncovered;
  });
  return [
    title,
    "",
    `- **Catch rate (recall):** ${intervalText(m.recall)}`,
    `- **Precision** (follow-ups that were real promises): ${intervalText(m.precision)}`,
    `- **Auto-close accuracy:** ${intervalText(m.closeAccuracy)}`,
    `- Estimated: real promises caught ${m.totals.caught}; missed in threads with no follow-up ${m.totals.missedInThreads}; misses you told Pako `
      + `${m.totals.told}; follow-ups made ${m.totals.made}; closed by Pako ${m.totals.closed}; reopened ${m.totals.reopened}`
      + (m.totals.uncovered ? `; not covered by any answer ${m.totals.uncovered}` : ""),
    ...(rows.length
      ? ["", "| Source | Recall | Precision | Auto-close accuracy |", "| --- | --- | --- | --- |",
        ...rows.map((s) => `| ${names[s]} | ${intervalText(m.bySource[s].recall)} | ${intervalText(m.bySource[s].precision)} | `
          + `${intervalText(m.bySource[s].closeAccuracy)} |`)]
      : []),
  ];
}
