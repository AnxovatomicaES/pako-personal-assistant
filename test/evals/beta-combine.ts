// The beta's pooled numbers (npm run beta:combine): the exports testers chose to send (npm run beta:report -- --export) read together into
// one catch rate (recall), precision and auto-close accuracy, with 90% intervals, overall and by source (mail, Slack, meetings, chat).
//
// Each tester's weekly strata stay strata of their own (their sampling weights are their own); the told misses and reopened closes are
// summed. A file that is not an export is named and left out; the same tester sent twice counts once (the newest export).
//
//   npm run beta:combine -- a.json b.json ...

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { estimate, measuresText } from "../../src/beta-measure.ts";
import { exportOf, type BetaExport } from "./beta-report.ts";

/** The exports to pool: the newest of each tester (an export with no tester id is its own), in the order given. */
export function dedupe(list: readonly BetaExport[]): BetaExport[] {
  const best = new Map<string, BetaExport>();
  list.forEach((e, i) => {
    const k = e.tester || `#${i}`;
    const was = best.get(k);
    if (!was || e.day >= was.day) best.set(k, e);
  });
  return list.filter((e, i) => best.get(e.tester || `#${i}`) === e);
}

/** Everything pooled: the strata side by side, the counts summed. */
export function pool(list: readonly BetaExport[]): { strata: BetaExport["audit"]["strata"]; missed: number; reopened: number; made: number; answered: number } {
  return {
    strata: list.flatMap((e) => e.audit.strata),
    missed: list.reduce((a, e) => a + e.counts.missed, 0),
    reopened: list.reduce((a, e) => a + e.counts.reopened, 0),
    made: list.reduce((a, e) => a + e.counts.loops.made, 0),
    answered: list.reduce((a, e) => a + e.audit.answered, 0),
  };
}

/** The pooled report as Markdown: numbers only. */
export function combineText(list: readonly BetaExport[], o: { reps?: number } = {}): string {
  const used = dedupe(list);
  const p = pool(used);
  const m = estimate({ strata: p.strata, missed: p.missed, reopened: p.reopened }, o.reps ? { reps: o.reps } : {});
  return [
    `## Pako beta, pooled: ${used.length} tester(s)`,
    "",
    `- Follow-ups made: ${p.made}; misses told: ${p.missed}; closes reopened: ${p.reopened}; audit answers: ${p.answered}`,
    "",
    ...measuresText(m, "### Measured"),
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!files.length) {
    console.error("Usage: npm run beta:combine -- a.json b.json ...");
    process.exit(2);
  }
  const list: BetaExport[] = [];
  for (const f of files) {
    let e: BetaExport | null = null;
    try {
      e = exportOf(JSON.parse(readFileSync(f, "utf8")));
    } catch (err) {
      console.error(`${basename(f)}: ${(err as Error).message}`);
    }
    if (e) list.push(e);
    else console.error(`${basename(f)}: not a Pako beta export, left out`);
  }
  console.log(combineText(list));
}
