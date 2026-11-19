// The weekly quality bar (npm run evals:weekly; never in the gate): every live-capable golden case once (k=1) through the real `claude -p`,
// under a cap, with the same pieces as npm run evals:live (test/evals/live.ts). The report goes to .claude/evals/weekly-YYYY-MM-DD.md
// (ignored by git: a run's own result, never tracked), with one line per case, and is compared with the latest earlier weekly report:
// a case that passed then and fails now is a regression, printed and listed in the report. The command exits 1 when there is one.
//
//   npm run evals:weekly [-- --max-usd 5] [--yes] [--suite followups] [--model claude-sonnet-5-5] [--model-brief ...]

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_SUITES, type EvalCase } from "./harness.ts";
import { confirm, options, pickCases, REPORTS_DIR, reportLines, runLive, type LiveRun, type Options } from "./live.ts";

export type Outcome = "PASS" | "FAIL" | "NOT RUN";

/** Each case's outcome in a run: PASS, FAIL, or NOT RUN (the cap stopped the run first). */
export function outcomes(run: LiveRun, files: string[], k: number): Map<string, Outcome> {
  const out = new Map<string, Outcome>(files.map((f) => [f, "NOT RUN"]));
  for (const r of run.rows) if (r.ran === k) out.set(r.c.file ?? "", r.passed === k ? "PASS" : "FAIL");
  return out;
}

/** The case lines of a weekly report ("| followups/x.json | PASS |"), read back. */
export function readOutcomes(text: string): Map<string, Outcome> {
  const out = new Map<string, Outcome>();
  for (const m of text.matchAll(/^\| ([a-z]+\/[\w.-]+\.json) \| (PASS|FAIL|NOT RUN) \|$/gm)) out.set(m[1]!, m[2] as Outcome);
  return out;
}

/** What changed since the last report: passed then and fails now (regressions), failed then and passes now, new cases. */
export function compare(before: Map<string, Outcome>, now: Map<string, Outcome>): { regressions: string[]; fixed: string[]; added: string[] } {
  const regressions: string[] = [];
  const fixed: string[] = [];
  const added: string[] = [];
  for (const [file, o] of now) {
    const was = before.get(file);
    if (was === undefined) added.push(file);
    else if (was === "PASS" && o === "FAIL") regressions.push(file);
    else if (was === "FAIL" && o === "PASS") fixed.push(file);
  }
  return { regressions, fixed, added };
}

/** The latest weekly report before this one's date, by name (weekly-YYYY-MM-DD.md). */
export function previousReport(dir: string, date: string): string | null {
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir).filter((f) => /^weekly-\d{4}-\d{2}-\d{2}\.md$/.test(f) && f < `weekly-${date}.md`).sort();
  return names.length ? join(dir, names.at(-1)!) : null;
}

/** The weekly report: the live report's lines, then what changed since the last one, then one line per case. */
export function weeklyLines(
  run: LiveRun, cases: EvalCase[], o: Options, date: string, now: Map<string, Outcome>, prev: { name: string; was: Map<string, Outcome> } | null,
): string[] {
  const lines = reportLines(run, cases, o, `Pako evals, weekly, ${date}`);
  const diff = prev ? compare(prev.was, now) : null;
  const bySuite = MODEL_SUITES.map((s) => {
    const of = [...now].filter(([f]) => f.startsWith(`${s}/`));
    return of.length ? `${s} ${of.filter(([, x]) => x === "PASS").length}/${of.length}` : "";
  }).filter(Boolean).join(", ");
  return [
    ...lines,
    `## Since ${prev ? prev.name : "the first weekly run"}`,
    "",
    `Passed by suite: ${bySuite}.`,
    "",
    ...(diff
      ? [`- Regressions (passed then, fail now): ${diff.regressions.join(", ") || "none"}`, `- Fixed (failed then, pass now): ${diff.fixed.join(", ") || "none"}`,
          `- New cases: ${diff.added.length}`]
      : ["- No earlier weekly report to compare with."]),
    "",
    "## Cases",
    "",
    "| Case | Result |",
    "|---|---|",
    ...[...now].sort(([a], [b]) => a.localeCompare(b)).map(([f, x]) => `| ${f} | ${x} |`),
    "",
  ];
}

export async function main(argv: string[], dir = REPORTS_DIR): Promise<void> {
  // Every live-capable suite once: k is 1 whatever is asked, the cap 5 dollars unless --max-usd says otherwise.
  const o = { ...options(argv.filter((a, i) => a !== "--k" && argv[i - 1] !== "--k")), k: 1 };
  const cases = pickCases(o);
  if (!cases.length) throw new Error("no case with a model step matches");
  if (!(await confirm(cases, o))) return;
  const run = await runLive(cases, o);
  const date = new Date().toISOString().slice(0, 10);
  const now = outcomes(run, cases.map((c) => c.file ?? ""), 1);
  const before = previousReport(dir, date);
  const prev = before ? { name: before.split("/").at(-1)!.replace(/\.md$/, ""), was: readOutcomes(readFileSync(before, "utf8")) } : null;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `weekly-${date}.md`);
  writeFileSync(file, weeklyLines(run, cases, o, date, now, prev).join("\n"));
  const passed = [...now.values()].filter((x) => x === "PASS").length;
  const ran = [...now.values()].filter((x) => x !== "NOT RUN").length;
  console.log(`Weekly: ${passed} of ${ran} cases passed (${now.size - ran} not run); spent $${run.spent.toFixed(2)}. Report: ${file}`);
  if (!prev) return console.log("No earlier weekly report: nothing to compare with yet.");
  const diff = compare(prev.was, now);
  console.log(`Since ${prev.name}: ${diff.regressions.length} regression(s), ${diff.fixed.length} fixed, ${diff.added.length} new case(s).`);
  for (const f of diff.regressions) console.log(`  REGRESSION ${f}`);
  if (diff.regressions.length) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  });
}
