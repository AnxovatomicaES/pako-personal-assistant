// The beta's weekly report (npm run beta:report): what Pako caught and how it closed things, as COUNTS only, for a tester to paste into an
// issue or an email. No title, name, address, channel or message is printed: only numbers, so it can be shared as it is.
//
// The two numbers that matter most for "nothing promised gets dropped":
// - missed: promises Pako never caught, as the tester told it ("you missed …" in the chat);
// - reopened: loops Pako closed on its own that the tester reopened ("reopen …"): a close on weak evidence.
//
//   npm run beta:report [-- --home <PAKO_HOME>] [--days 7]

import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FOLLOWUPS_KEY, stateOf, type Loop } from "../../src/followups.ts";
import { FEEDBACK_KEY, qualityStateOf } from "../../src/quality.ts";
import { readStore } from "./from-feedback.ts";

export interface BetaCounts {
  days: number;
  loops: { made: number; bySource: Record<string, number>; byKind: Record<string, number> };
  closed: { byOwner: number; byPako: number; dismissed: number };
  open: number;
  reopened: number;
  missed: number;
  nudges: { sent: number; done: number; notMine: number; snoozed: number; unanswered: number };
  thumbs: { up: number; down: number };
}

const bump = (r: Record<string, number>, k: string): void => void (r[k] = (r[k] ?? 0) + 1);

/** The counts of the last `days` days, from the stored follow-ups and feedback (read only). */
export function betaCounts(followups: unknown, feedback: unknown, o: { now: number; days: number }): BetaCounts {
  const since = o.now - o.days * 24 * 3600_000;
  const loops: Loop[] = stateOf(followups).loops;
  const q = qualityStateOf(feedback);
  const made = loops.filter((l) => l.createdAt >= since);
  const out: BetaCounts = {
    days: o.days,
    loops: { made: made.length, bySource: {}, byKind: {} },
    closed: { byOwner: 0, byPako: 0, dismissed: 0 },
    open: loops.filter((l) => l.status === "open" || l.status === "snoozed").length,
    reopened: (q.reopens ?? []).filter((m) => m.at >= since).length,
    missed: (q.misses ?? []).filter((m) => m.at >= since).length,
    nudges: { sent: 0, done: 0, notMine: 0, snoozed: 0, unanswered: 0 },
    thumbs: { up: 0, down: 0 },
  };
  for (const l of made) {
    bump(out.loops.bySource, l.sources[0]?.kind ?? "other");
    bump(out.loops.byKind, l.kind);
  }
  for (const l of loops) {
    if (!l.closedAt || l.closedAt < since) continue;
    if (l.status === "dismissed") out.closed.dismissed++;
    else if (l.status === "done") l.autoClosed ? out.closed.byPako++ : out.closed.byOwner++;
  }
  for (const n of q.nudges.filter((x) => x.at >= since)) {
    out.nudges.sent++;
    if (n.outcome === "done") out.nudges.done++;
    else if (n.outcome === "notmine") out.nudges.notMine++;
    else if (n.outcome === "snooze") out.nudges.snoozed++;
    else out.nudges.unanswered++;
  }
  for (const v of q.verdicts.filter((x) => x.at >= since)) out.thumbs[v.verdict === "up" ? "up" : "down"]++;
  return out;
}

const list = (r: Record<string, number>): string => Object.entries(r).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ") || "none";

/** The report as Markdown: numbers only. */
export function betaText(c: BetaCounts): string {
  return [
    `## Pako beta report, last ${c.days} days`,
    "",
    `- Follow-ups made: ${c.loops.made} (from: ${list(c.loops.bySource)}; kinds: ${list(c.loops.byKind)})`,
    `- **Missed** (you told Pako it missed one): ${c.missed}`,
    `- **Closed by Pako, then reopened by you:** ${c.reopened}`,
    `- Closed: ${c.closed.byOwner} by you, ${c.closed.byPako} by Pako, ${c.closed.dismissed} dismissed; open now: ${c.open}`,
    `- Reminders: ${c.nudges.sent} sent (${c.nudges.done} done, ${c.nudges.notMine} not yours, ${c.nudges.snoozed} snoozed, `
      + `${c.nudges.unanswered} unanswered)`,
    `- 👍 ${c.thumbs.up} · 👎 ${c.thumbs.down}`,
    "",
    "Counts only: no titles, names or messages. Add in your own words what Pako got wrong or right, if you like.",
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const home = arg("home") ?? ((process.env.PAKO_HOME ?? "").trim() || join(homedir(), ".pako"));
  const days = Math.max(1, Math.min(90, Number(arg("days") ?? 7) || 7));
  const get = readStore(home);
  console.log(betaText(betaCounts(get(FOLLOWUPS_KEY), get(FEEDBACK_KEY), { now: Date.now(), days })));
}
