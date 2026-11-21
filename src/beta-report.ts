// The beta's report as counts (betaCounts, betaText) and the export a tester may send (betaExport, exportOf): pure functions on the stored
// follow-ups, feedback and audit, no title, name, address, channel or message ever in what they return. Used by npm run beta:report
// (test/evals/beta-report.ts), npm run beta:combine and the panel's beta report (src/beta-audit.ts), so a tester with only the Mac app, no
// terminal, can see and save the same file.

import type { Express, Request } from "express";
import { rateLimit } from "express-rate-limit";
import { AUDIT_KEY, auditCounts, auditStateOf } from "./beta-audit.ts";
import { estimate, measuresText, stratumOf, type Stratum } from "./beta-measure.ts";
import { FOLLOWUPS_KEY, LOOP_KINDS, stateOf, type Loop } from "./followups.ts";
import type { Kv } from "./kv.ts";
import { createLog } from "./log.ts";
import { FEEDBACK_KEY, qualityStateOf } from "./quality.ts";

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

export interface AuditPart {
  rounds: number;
  asked: number;
  answered: number;
  skipped: number;
  ignored: number;
  strata: Stratum[];
}

/** The report as Markdown: numbers only. With the audit's counts (opted in), its measured catch rate too. */
export function betaText(c: BetaCounts, audit?: AuditPart | null): string {
  const measured = audit && audit.rounds
    ? [
        "",
        ...measuresText(estimate({ strata: audit.strata, missed: c.missed, reopened: c.reopened }), `### Measured (weekly sampled check, ${audit.rounds} week(s))`),
        "",
        `- Questions: ${audit.asked} asked, ${audit.answered} answered, ${audit.skipped} skipped, ${audit.ignored} unanswered`,
      ]
    : [];
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
    ...measured,
    "",
    "Counts only: no titles, names or messages. Add in your own words what Pako got wrong or right, if you like.",
  ].join("\n");
}

// ---------- the export ----------

export const EXPORT_KIND = "pako-beta-export";
const SOURCE_KEYS = ["slack", "mail", "meeting", "chat", "other"] as const;

/** What a tester may send the owner: counts, the audit's strata and a random install id. Every map's keys come from fixed lists. */
export interface BetaExport {
  kind: typeof EXPORT_KIND;
  version: 1;
  /** A random id made on this computer when the audit was first turned on ("" if never): the pooling counts one tester once. */
  tester: string;
  /** The day it was made (YYYY-MM-DD, UTC). */
  day: string;
  days: number;
  counts: BetaCounts;
  audit: AuditPart;
}

const only = (r: Record<string, number>, keys: readonly string[]): Record<string, number> =>
  Object.fromEntries(keys.filter((k) => Number.isInteger(r[k]) && r[k]! > 0).map((k) => [k, r[k]!]));

/** The export of the last `days` days, from the stored follow-ups, feedback and audit (read only). */
export function betaExport(followups: unknown, feedback: unknown, audit: unknown, o: { now: number; days: number }): BetaExport {
  const c = betaCounts(followups, feedback, o);
  const a = auditCounts(audit, o);
  return {
    kind: EXPORT_KIND, version: 1, tester: auditStateOf(audit).tester, day: new Date(o.now).toISOString().slice(0, 10), days: o.days,
    counts: { ...c, loops: { made: c.loops.made, bySource: only(c.loops.bySource, SOURCE_KEYS), byKind: only(c.loops.byKind, LOOP_KINDS) } },
    audit: { rounds: a.rounds, asked: a.asked, answered: a.answered, skipped: a.skipped, ignored: a.ignored, strata: a.strata },
  };
}

const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1e7 ? v : null);
const countsIn = (v: unknown, keys: readonly string[]): Record<string, number> | null => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) {
    if (!keys.includes(k) || count(n) === null) return null;
    out[k] = n as number;
  }
  return out;
};

/** An export read back (by beta:combine), every field checked; null when it is not one. Only numbers and fixed words get through. */
export function exportOf(raw: unknown): BetaExport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.kind !== EXPORT_KIND || o.version !== 1 || typeof o.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.day) || count(o.days) === null) return null;
  const tester = typeof o.tester === "string" && /^([0-9a-f]{8,16})?$/.test(o.tester) ? o.tester : null;
  const c = o.counts as Record<string, unknown> | undefined;
  const a = o.audit as Record<string, unknown> | undefined;
  if (tester === null || !c || typeof c !== "object" || !a || typeof a !== "object") return null;
  const loops = c.loops as Record<string, unknown> | undefined;
  const bySource = countsIn(loops?.bySource, SOURCE_KEYS);
  const byKind = countsIn(loops?.byKind, LOOP_KINDS);
  const closed = countsIn(c.closed, ["byOwner", "byPako", "dismissed"]);
  const nudges = countsIn(c.nudges, ["sent", "done", "notMine", "snoozed", "unanswered"]);
  const thumbs = countsIn(c.thumbs, ["up", "down"]);
  const strata = Array.isArray(a.strata) ? a.strata.map(stratumOf) : null;
  const nums = [count(loops?.made), count(c.open), count(c.reopened), count(c.missed), count(a.rounds), count(a.asked), count(a.answered), count(a.skipped),
    count(a.ignored)];
  if (!bySource || !byKind || !closed || !nudges || !thumbs || !strata || strata.some((x) => !x) || nums.some((x) => x === null)) return null;
  const [made, open, reopened, missed, rounds, asked, answered, skipped, ignored] = nums as number[];
  return {
    kind: EXPORT_KIND, version: 1, tester, day: o.day, days: o.days as number,
    counts: {
      days: o.days as number, loops: { made: made!, bySource, byKind }, open: open!, reopened: reopened!, missed: missed!,
      closed: { byOwner: closed.byOwner ?? 0, byPako: closed.byPako ?? 0, dismissed: closed.dismissed ?? 0 },
      nudges: { sent: nudges.sent ?? 0, done: nudges.done ?? 0, notMine: nudges.notMine ?? 0, snoozed: nudges.snoozed ?? 0, unanswered: nudges.unanswered ?? 0 },
      thumbs: { up: thumbs.up ?? 0, down: thumbs.down ?? 0 },
    },
    audit: { rounds: rounds!, asked: asked!, answered: answered!, skipped: skipped!, ignored: ignored!, strata: strata as Stratum[] },
  };
}

const log = createLog("pako");

/**
 * GET /panel/api/beta-export?days=14: the export (betaExport) of this Pako's store, for the panel's beta report; with &download=1 as a
 * file (pako-beta-<day>.json). Signed in only; read only; nothing is sent anywhere: the tester saves the file and sends it if they choose.
 */
export function mountBetaExport(app: Express, d: { signedIn: (req: Request) => boolean; kv: () => Kv | null; now?: () => number }): void {
  const limit = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });
  app.get("/panel/api/beta-export", limit, async (req, res) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" });
    if (!d.signedIn(req)) return void res.status(401).json({ error: "sign in" });
    const kv = d.kv();
    if (!kv) return void res.status(404).json({ error: "off" });
    const days = Math.max(1, Math.min(365, Math.floor(Number(req.query.days)) || 14));
    const read = async (key: string): Promise<unknown> => {
      const v = await kv.get(key);
      try {
        return v ? JSON.parse(v) : null;
      } catch {
        // A value that is not JSON counts as nothing, as each module reads it (stateOf and the rest start empty).
        return null;
      }
    };
    try {
      const e = betaExport(await read(FOLLOWUPS_KEY), await read(FEEDBACK_KEY), await read(AUDIT_KEY), { now: (d.now ?? Date.now)(), days });
      if (req.query.download === "1") res.attachment(`pako-beta-${e.day}.json`);
      res.type("application/json").send(`${JSON.stringify(e, null, 2)}\n`);
    } catch (err) {
      log.warn(`the beta report: the store did not answer: ${(err as Error).message}`);
      res.status(503).json({ error: "store" });
    }
  });
}
