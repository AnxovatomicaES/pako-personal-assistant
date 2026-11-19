// Nudges and their timing: the quiet hours, when a loop is looked at again, and the tick that turns due batches into jobs and checks due
// loops, closing them silently or nudging the owner within the day's budget.

import { today } from "../lists.ts";
import type { Engine } from "./parts.ts";
import { CLAIM_MS, ESCALATE_BEFORE_MS, RECHECK_FOR_MS, RECHECK_MS } from "./limits.ts";
import { isOpen } from "./record.ts";
import { T } from "./texts.ts";
import type { Batch, Loop } from "./types.ts";
import { createLog } from "../log.ts";

const log = createLog("followups");

export function mountNudges(fu: Engine): Pick<Engine, "quietNow" | "nextAfter" | "tick"> {
  const { d, now, lang, config, mutate, read, flushBatch, flushMailDue, runCheck, nudgeText } = fu;
  const quietNow = (t: number): boolean => {
    const q = config.quiet;
    if (!q) return false;
    const [h, m] = new Intl.DateTimeFormat("en-GB", { timeZone: d.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(t).split(":").map(Number);
    const x = h! * 60 + m!;
    return q.start < q.end ? x >= q.start && x < q.end : x >= q.start || x < q.end;
  };

  /**
   * When a loop is looked at again after a check that did not close it. With a time: an hour before it (the one nudge near the deadline), then
   * just before it, silently (a meeting set up late still closes it). Without one: every few hours for a few days, silently: only to close it.
   */
  const nextAfter = (l: Loop, t: number): number => {
    if (!l.dueAt) return "none" in l.check || t - l.whenSaid >= RECHECK_FOR_MS ? 0 : t + RECHECK_MS;
    // Nothing a server can see (an email to send): said once, two hours before its time; a second look would only say the same again.
    if ("none" in l.check) return 0;
    if (!l.escalated && l.dueAt - ESCALATE_BEFORE_MS > t + 15 * 60_000) return l.dueAt - ESCALATE_BEFORE_MS;
    return !("none" in l.check) && l.dueAt - 5 * 60_000 > t + 60_000 ? l.dueAt - 5 * 60_000 : 0;
  };

  let ticking = false;
  /** Due batches become jobs; due loops are checked, closed silently when done, or nudged within the budget and outside the quiet hours. */
  const tick = async (): Promise<{ jobs: number; checked: number; nudged: number; done: number }> => {
    const out = { jobs: 0, checked: 0, nudged: 0, done: 0 };
    if (ticking) return out;
    ticking = true;
    try {
      const t = now();
      const due = await mutate((s) => {
        // A conversation whose last job is still unanswered waits for that answer: the next job then lists the loop it made, so a later
        // "never mind" can close it. A job never answered is forgotten after JOB_KEEP_MS, and the wait with it.
        const waiting = (b: Batch): boolean => s.jobs.some((j) => j.source === "slack" && j.where.channel === b.channel && j.where.thread === b.thread);
        const ready = s.batches.filter((b) => t - b.firstAt >= config.batchMs && !waiting(b));
        s.batches = s.batches.filter((b) => !ready.includes(b));
        return ready;
      });
      // One not queued is back in the store (flushBatch), for the next tick.
      for (const b of due) if (await flushBatch(b)) out.jobs++;
      // Email threads too, each one job (src/followups/mail-jobs.ts).
      out.jobs += await flushMailDue(t);
      if (quietNow(t)) return out;
      const st = await read();
      // A loop whose conversation has a job still unanswered is looked at after that answer: it may say the loop was called off.
      const asking = (l: Loop): boolean =>
        (!!l.where.channel && st.jobs.some((j) => j.source === "slack" && j.where.channel === l.where.channel && j.where.thread === l.where.thread))
        || (!!l.where.mailThread && st.jobs.some((j) => j.source === "mail" && j.where.mailThread === l.where.mailThread));
      const ready = st.loops.filter((l) => isOpen(l) && l.nextCheckAt > 0 && l.nextCheckAt <= t && !asking(l));
      for (const l of ready) {
        // Claimed first, in the store: another process (a deploy's overlap) that read the same loop finds it moved on and leaves it.
        const unchanged = (x: Loop | undefined): x is Loop => !!x && x.status === l.status && x.nudges === l.nudges;
        const claimed = await mutate((s) => {
          const x = s.loops.find((y) => y.id === l.id);
          if (!unchanged(x) || x.nextCheckAt !== l.nextCheckAt) return false;
          x.nextCheckAt = now() + CLAIM_MS;
          return true;
        });
        if (!claimed) continue;
        const seen = await runCheck(l);
        out.checked++;
        const lg = lang();
        if (seen.done) {
          await mutate((s) => {
            const x = s.loops.find((y) => y.id === l.id);
            if (x && isOpen(x)) Object.assign(x, { status: "done", closedAt: now(), nextCheckAt: 0, checkedAt: now() });
          });
          d.control?.log("followup", T(lg)("logDone", { what: seen.what, title: l.title }));
          out.done++;
          continue;
        }
        // Its time has passed (a late tick, a restart, the quiet hours, the budget): nothing to say any more; the brief may still mention it.
        if (l.dueAt && t >= l.dueAt) {
          await mutate((s) => {
            const x = s.loops.find((y) => y.id === l.id);
            if (unchanged(x)) Object.assign(x, { nextCheckAt: 0, lastCheck: seen.said, checkedAt: now() });
          });
          continue;
        }
        const soon = !!l.dueAt && !l.escalated && t >= l.dueAt - ESCALATE_BEFORE_MS && (l.nudges > 0 || !!seen.replied);
        const wanted = l.status === "snoozed" || soon || (l.nudges === 0 && !seen.replied);
        // The budget is taken in the same write that records the nudge: two ticks can never both spend the last one.
        const others = wanted ? await (d.othersToday?.() ?? Promise.resolve(0)).catch(() => 0) : 0;
        const go = wanted
          ? await mutate((s) => {
            const day = today(now(), d.timeZone);
            if (s.budget.day !== day) s.budget = { day, n: 0 };
            const x = s.loops.find((y) => y.id === l.id);
            if (!unchanged(x)) return false;
            if (s.budget.n + others >= config.maxPerDay) {
              x.nextCheckAt = now() + 30 * 60_000;
              return false;
            }
            s.budget.n++;
            x.nudges++;
            // The nudge near the deadline is this one, or it would come too soon after it.
            if (soon || (x.dueAt && x.dueAt - ESCALATE_BEFORE_MS <= now() + 15 * 60_000)) x.escalated = true;
            x.status = "open";
            x.lastCheck = seen.said;
            x.checkedAt = now();
            x.nextCheckAt = nextAfter(x, now());
            return true;
          })
          : await mutate((s) => {
            const x = s.loops.find((y) => y.id === l.id);
            if (unchanged(x)) Object.assign(x, { lastCheck: seen.said, checkedAt: now(), nextCheckAt: nextAfter(x, now()) });
            return false;
          });
        if (!go) continue;
        // Someone else's promise is theirs to keep: a draft is offered only for what the owner has to do or answer.
        const draftable = !!d.drafts && l.kind !== "other_promise";
        const body = nudgeText(l, seen.said, soon, lg) + (draftable ? `\n${T(lg)("draftHint")}` : "");
        const tl = T(lg);
        const buttons = [
          { id: `f1:${l.id}`, title: tl("btnDone") }, { id: `f2:${l.id}`, title: tl("btnSnooze") }, { id: `f3:${l.id}`, title: tl("btnNotMine") },
        ];
        const feedback = d.quality?.ask(l, lg);
        const sent = await d.card(body, buttons, feedback).catch(() => false);
        if (!sent) await d.notify(tl("held", { text: body }));
        d.quality?.nudged(l, sent);
        d.control?.log("followup", tl("logNudge", { title: l.title }));
        out.nudged++;
      }
      return out;
    } catch (err) {
      log.error(`${(err as Error).message}`);
      return out;
    } finally {
      ticking = false;
    }
  };

  return { quietNow, nextAfter, tick };
}
