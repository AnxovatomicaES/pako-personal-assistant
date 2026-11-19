// npm run evals:live -- --suite chat: the chat cases of test/evals/chat-cases/ through the bridge and the real `claude -p` on the owner's plan, k times each (test/evals/README.md).
// pass^k: a case passes only when all its k runs pass. Never in the gate: it costs quota and the model's answers vary.
//
//   npm run evals:live -- --suite chat [-- --k 3] [--case remind] [--area injection] [--parallel 2] [--max-usd 5] [--model <id>] [--typed-tools on|off] [--yes]
//
// The bridge's own settings apply (ASSISTANT_MODEL, ASSISTANT_TOOLS, CLAUDE_BIN, ASSISTANT_RUN_TIMEOUT_MS). Pako's typed tools are on when
// this Claude Code can load them, as for the owner (assistant/run.ts); --typed-tools off runs the tags alone, to compare. Nothing touches a running Pako:
// the fake server lives in this process, each turn gets a state folder of its own, and PAKO_HOME points at a temporary folder for the run.
// The result: test/evals/results/<time>.json (not tracked), and a table here.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { ClaudeError, loadBridgeConfig, offersMcpTools, offersNoBare, runClaude, type BridgeConfig } from "../../assistant/bridge.ts";
import { AREAS, judgeTurn, loadCases, runChecks, runTurn, tagCounts, type CheckResult, type EvalCase } from "./chat-harness.ts";

/** A guess to show first, on the plan's notional prices (claude -p reports each run's): not a bill. */
const USD_PER_TURN = 0.05;
const USD_PER_JUDGE = 0.02;

export interface Options { k: number; only: string[]; area?: string; parallel: number; maxUsd: number; model?: string; yes: boolean; typedTools: "auto" | "on" | "off" }

export function options(argv: string[]): Options {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const all = (name: string): string[] => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? argv[i + 1]!.split(",") : []));
  const k = Number(arg("k") ?? 3);
  const parallel = Number(arg("parallel") ?? 2);
  const maxUsd = Number(arg("max-usd") ?? 5);
  if (!Number.isInteger(k) || k < 1 || k > 10) throw new Error("--k is a whole number from 1 to 10");
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 6) throw new Error("--parallel is a whole number from 1 to 6");
  if (!(maxUsd > 0) || maxUsd > 50) throw new Error("--max-usd is above 0 and at most 50");
  const area = arg("area");
  if (area && !(AREAS as readonly string[]).includes(area)) throw new Error(`--area is one of ${AREAS.join(", ")}`);
  const model = arg("model");
  if (model !== undefined && !/^[A-Za-z0-9-]+$/.test(model)) throw new Error("--model may only hold letters, digits and -");
  const typedTools = arg("typed-tools") ?? "auto";
  if (typedTools !== "auto" && typedTools !== "on" && typedTools !== "off") throw new Error("--typed-tools is on, off or auto");
  return { k, only: all("case"), ...(area ? { area } : {}), parallel, maxUsd, ...(model ? { model } : {}), yes: argv.includes("--yes"), typedTools };
}

export interface RunResult {
  pass: boolean;
  checks: CheckResult[];
  judge?: { pass: boolean; why: string };
  reply: string;
  tags: Record<string, number>;
  held: boolean;
  costUsd: number;
  ms: number;
  error?: string;
}
export interface CaseResult {
  id: string;
  area: string;
  behaviour: string;
  k: number;
  passed: number;
  /** All k runs passed. */
  passK: boolean;
  rate: number;
  runs: RunResult[];
}

/** One run of a case: the turn, its code checks, and the judge only when every code check passed (code first, and it saves quota). */
export async function runOnce(c: EvalCase, config: BridgeConfig, run = runClaude): Promise<RunResult> {
  const o = await runTurn(c, config, run);
  const checks = runChecks(c, o);
  let judge: RunResult["judge"];
  let cost = o.costUsd;
  if (c.judge && checks.every((x) => x.pass)) {
    const j = await judgeTurn(c, o, config, run);
    judge = { pass: j.pass, why: j.why };
    cost += j.costUsd;
  }
  return {
    pass: checks.every((x) => x.pass) && (judge?.pass ?? true), checks, ...(judge ? { judge } : {}), reply: o.reply.text,
    tags: tagCounts(o.reply) as Record<string, number>, held: o.held, costUsd: cost, ms: o.ms,
  };
}

/** Summing up: pass^k and the pass rate per case, and by area. */
export function summarise(rows: CaseResult[]): { cases: number; passK: number; runs: number; passedRuns: number; byArea: Record<string, { cases: number; passK: number }> } {
  const byArea: Record<string, { cases: number; passK: number }> = {};
  for (const r of rows) {
    const a = (byArea[r.area] ??= { cases: 0, passK: 0 });
    a.cases++;
    if (r.passK) a.passK++;
  }
  return {
    cases: rows.length, passK: rows.filter((r) => r.passK).length, runs: rows.reduce((n, r) => n + r.runs.length, 0),
    passedRuns: rows.reduce((n, r) => n + r.passed, 0), byArea,
  };
}

export function table(rows: CaseResult[], k: number): string {
  const w = Math.max(4, ...rows.map((r) => r.id.length));
  const lines = [`${"case".padEnd(w)}  ${"area".padEnd(10)}  pass^${k}  rate`];
  for (const r of rows) lines.push(`${r.id.padEnd(w)}  ${r.area.padEnd(10)}  ${(r.passK ? "PASS" : "FAIL").padEnd(6)}  ${r.passed}/${r.runs.length}`);
  const s = summarise(rows);
  lines.push("", "By area: " + Object.entries(s.byArea).map(([a, v]) => `${a} ${v.passK}/${v.cases}`).join(", "));
  lines.push(`pass^${k}: ${s.passK} of ${s.cases} cases; runs passed: ${s.passedRuns} of ${s.runs}${s.runs ? ` (${Math.round((100 * s.passedRuns) / s.runs)}%)` : ""}`);
  return lines.join("\n");
}

export async function main(argv: string[]): Promise<void> {
  const o = options(argv);
  const cases = loadCases().filter((c) => (!o.area || c.area === o.area) && (!o.only.length || o.only.some((s) => c.id.includes(s))));
  if (!cases.length) throw new Error("no case matches");
  // Never the owner's real Pako: anything that reads PAKO_HOME in this process gets an empty folder of its own.
  const home = mkdtempSync(join(tmpdir(), "pako-eval-home-"));
  process.env.PAKO_HOME = home;
  const config = loadBridgeConfig({
    ...process.env,
    ASSISTANT_SERVER_URL: "http://127.0.0.1:9",
    ASSISTANT_BRIDGE_TOKEN: "eval".repeat(10),
    ASSISTANT_STATE_DIR: join(home, "bridge"),
    ...(o.model ? { ASSISTANT_MODEL: o.model } : {}),
  });
  config.noBare = offersNoBare(config.claudeBin);
  config.mcpTools = o.typedTools !== "off" && offersMcpTools(config.claudeBin);
  if (o.typedTools === "on" && !config.mcpTools) throw new Error("--typed-tools on: this Claude Code cannot load Pako's MCP server");
  console.log(`Pako's typed tools: ${config.mcpTools ? "on" : "off (tags only)"}`);
  const judged = cases.filter((c) => c.judge).length;
  const usd = Math.round((cases.length * o.k * USD_PER_TURN + judged * o.k * USD_PER_JUDGE) * 100) / 100;
  console.log(`${cases.length} cases × k=${o.k}: ${cases.length * o.k} turns of ${config.claudeBin} -p (${config.model}, tools: ${config.tools.join(",") || "none"})`
    + `${judged ? ` and up to ${judged * o.k} judge runs` : ""}, about $${usd.toFixed(2)} on the plan's prices. Cap: $${o.maxUsd.toFixed(2)}.`);
  if (!o.yes) {
    if (!process.stdin.isTTY) throw new Error("this uses your Claude plan's quota: run it with --yes to go on without asking");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ok = /^(y|yes|s|si|sí)$/i.test((await rl.question("Go on? [y/N] ")).trim());
    rl.close();
    if (!ok) return;
  }
  const rows: CaseResult[] = cases.map((c) => ({ id: c.id, area: c.area, behaviour: c.behaviour, k: o.k, passed: 0, passK: false, rate: 0, runs: [] }));
  const jobs = cases.flatMap((c, n) => Array.from({ length: o.k }, () => ({ c, row: rows[n]! })));
  let spent = 0;
  let stop = "";
  const worker = async (): Promise<void> => {
    for (let job = jobs.shift(); job && !stop; job = jobs.shift()) {
      if (spent >= o.maxUsd) {
        stop = `the $${o.maxUsd.toFixed(2)} cap was reached`;
        return;
      }
      let r: RunResult;
      try {
        r = await runOnce(job.c, config);
      } catch (err) {
        // A limit or a lost login ends the run (every other turn would fail the same way); anything else is that run's failure.
        if (err instanceof ClaudeError && err.kind !== "other") {
          stop = `Claude said: ${err.message} (${err.kind})`;
          return;
        }
        r = { pass: false, checks: [], reply: "", tags: {}, held: false, costUsd: 0, ms: 0, error: (err as Error).message.slice(0, 300) };
      }
      spent += r.costUsd;
      job.row.runs.push(r);
      if (r.pass) job.row.passed++;
      process.stdout.write(r.error ? "E" : r.pass ? "." : "F");
    }
  };
  try {
    await Promise.all(Array.from({ length: o.parallel }, worker));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  console.log("");
  for (const r of rows) {
    r.rate = r.runs.length ? Math.round((r.passed / r.runs.length) * 100) / 100 : 0;
    r.passK = r.runs.length === o.k && r.passed === o.k;
  }
  const done = rows.filter((r) => r.runs.length);
  for (const r of done.filter((x) => !x.passK)) {
    console.log(`\n✗ ${r.id} (${r.passed}/${r.runs.length}): ${r.behaviour}`);
    r.runs.forEach((run, i) => {
      if (run.pass) return;
      const why = run.error ? `error: ${run.error}` : [...run.checks.filter((x) => !x.pass).map((x) => `${x.name}${x.detail ? ` (${x.detail})` : ""}`),
        ...(run.judge && !run.judge.pass ? [`judge: ${run.judge.why}`] : [])].join("; ");
      console.log(`  run ${i + 1}: ${why}`);
    });
  }
  console.log(`\n${table(done, o.k)}`);
  if (stop) console.log(`Stopped early: ${stop}. ${rows.length - done.length} case(s) did not run, and a case with fewer than ${o.k} runs is no pass^k.`);
  const at = new Date();
  const dir = fileURLToPath(new URL("./results/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${at.toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`);
  writeFileSync(file, `${JSON.stringify({ at: at.toISOString(), model: config.model, tools: config.tools, typedTools: config.mcpTools === true, k: o.k, spentUsd: Math.round(spent * 10000) / 10000,
    ...(stop ? { stopped: stop } : {}), summary: summarise(done), cases: rows }, null, 2)}\n`);
  console.log(`Spent about $${spent.toFixed(2)}. Results: ${file}`);
  if (stop || done.some((r) => !r.passK) || done.length < rows.length) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  });
}
