// The beta's weekly report (npm run beta:report): what Pako caught and how it closed things, as COUNTS only, for a tester to paste into an
// issue or an email. No title, name, address, channel or message is printed: only numbers, so it can be shared as it is.
//
// The two numbers that matter most for "nothing promised gets dropped":
// - missed: promises Pako never caught, as the tester told it ("you missed …" in the chat);
// - reopened: loops Pako closed on its own that the tester reopened ("reopen …"): a close on weak evidence.
// And, for a tester who opted in to the weekly sampled audit (src/beta-audit.ts), what those two undercount: the MEASURED catch rate
// (recall), precision and auto-close accuracy, with 90% intervals (src/beta-measure.ts).
//
// --export writes the same numbers as a small JSON (betaExport: counts and the audit's strata, a random install id, nothing else) for the
// tester to send the owner if they choose; it is printed whole first, and written only on a yes (or --yes). The owner pools several with
// npm run beta:combine.
//
//   npm run beta:report [-- --home <PAKO_HOME>] [--days 7] [--export [file]] [--yes]

import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { AUDIT_KEY, auditCounts } from "../../src/beta-audit.ts";
import { FOLLOWUPS_KEY } from "../../src/followups.ts";
import { FEEDBACK_KEY } from "../../src/quality.ts";
import { betaCounts, betaExport, betaText, type BetaExport } from "../../src/beta-report.ts";
export * from "../../src/beta-report.ts";
import { readStore } from "./from-feedback.ts";

/** Writes the export after showing it whole: on --yes, or a "y" typed at the question. Whether it was written. */
async function exportNow(e: BetaExport, file: string, yes: boolean): Promise<boolean> {
  const json = `${JSON.stringify(e, null, 2)}\n`;
  console.log("This is everything the export holds (counts only; nothing else is in the file):\n");
  console.log(json);
  let ok = yes;
  if (!ok && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    ok = /^y(es)?$/i.test((await rl.question(`Write it to ${file}? [y/N] `)).trim());
    rl.close();
  }
  if (!ok) {
    console.log(process.stdin.isTTY ? "Not written." : "Not written: add --yes to write it.");
    return false;
  }
  writeFileSync(file, json, { mode: 0o600 });
  console.log(`Written to ${file}. Send it to the Pako team only if you want to; nothing is sent by Pako.`);
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const home = arg("home") ?? ((process.env.PAKO_HOME ?? "").trim() || join(homedir(), ".pako"));
  const days = Math.max(1, Math.min(365, Number(arg("days") ?? 7) || 7));
  const get = readStore(home);
  const now = Date.now();
  if (argv.includes("--export")) {
    const e = betaExport(get(FOLLOWUPS_KEY), get(FEEDBACK_KEY), get(AUDIT_KEY), { now, days });
    const given = arg("export");
    const file = resolve(given && !given.startsWith("--") ? given : `pako-beta-${e.day}.json`);
    await exportNow(e, file, argv.includes("--yes"));
  } else {
    const a = auditCounts(get(AUDIT_KEY), { now, days });
    console.log(betaText(betaCounts(get(FOLLOWUPS_KEY), get(FEEDBACK_KEY), { now, days }), a));
  }
}
