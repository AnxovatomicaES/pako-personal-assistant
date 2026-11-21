// Nudges and their timing: the quiet hours, when a loop is looked at again, and the tick that turns due batches into jobs and checks due
// loops, closing them silently or nudging the owner within the day's budget.

import { today } from "../lists.ts";
import type { Base, Engine, Nudges } from "./parts.ts";
import { CLAIM_MS, ESCALATE_BEFORE_MS, JOB_HOLD_MS, RECHECK_FOR_MS, RECHECK_MS } from "./limits.ts";
import { isOpen, newId } from "./record.ts";
import { T } from "./texts.ts";
import type { Batch, CardFeedback, GentleRound, Loop } from "./types.ts";
import { GT, gentleNudgeText, isStuck, pickVariant, UNANSWERED_STOP, VARIANTS } from "../gentle.ts";
import { createLog } from "../log.ts";

const log = createLog("followups");

export function mountNudges(
  { d, now, lang, config }: Base,
  { mutate, read, flushBatch, flushMailDue, runCheck, nudgeText, dueText, sourceText }: Pick<
    Engine,
    "mutate" | "read" | "flushBatch" | "flushMailDue" | "runCheck" | "nudgeText" | "dueText" | "sourceText"
  >,
): Nudges {
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
        // "never mind" can close it. A job not answered within JOB_HOLD_MS (the inbox may have let it go) no longer holds it.
        const waiting = (b: Batch): boolean => s.jobs.some((j) =>
          t - j.at < JOB_HOLD_MS && j.id !== b.claim?.id && j.source === "slack" && j.where.channel === b.channel && j.where.thread === b.thread);
        // A batch already claimed was on its way when the server stopped: tried again under the same id. The others are claimed here,
        // in the store, before anything is read or queued; each leaves the store only once its job is (flushBatch).
        const ready = s.batches.filter((b) => b.claim || (t - b.firstAt >= config.batchMs && !waiting(b)));
        return ready.map((b) => {
          const again = !!b.claim;
          b.claim ??= { id: newId(), keys: b.msgs.map((m) => m.ts) };
          return { b: structuredClone(b), again };
        });
      });
      for (const { b, again } of due) if (await flushBatch(b, again)) out.jobs++;
      // Email threads too, each one job (src/followups/mail-jobs.ts).
      out.jobs += await flushMailDue(t);
      if (quietNow(t)) return out;
      // Gentle mode (src/gentle.ts): its own cap, words and buttons, and a loop left unanswered twice folded into the brief. Null: as before.
      const g: GentleRound | null = d.gentle ? await d.gentle().catch(() => null) : null;
      const cap = g ? g.maxPerDay : config.maxPerDay;
      const st = await read();
      // A loop whose conversation has a job still unanswered is looked at after that answer: it may say the loop was called off.
      const held = st.jobs.filter((j) => t - j.at < JOB_HOLD_MS);
      const asking = (l: Loop): boolean =>
        (!!l.where.channel && held.some((j) => j.source === "slack" && j.where.channel === l.where.channel && j.where.thread === l.where.thread))
        || (!!l.where.mailThread && held.some((j) => j.source === "mail" && j.where.mailThread === l.where.mailThread));
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
        // Reopened by the owner after Pako closed it: what the check sees is what they said was wrong, so it is said, never taken as done.
        const looked = await runCheck(l);
        const seen = looked.done && l.reopened ? { ...looked, done: false, what: "", said: l.lastCheck ?? "" } : looked;
        out.checked++;
        const lg = lang();
        if (seen.done) {
          await mutate((s) => {
            const x = s.loops.find((y) => y.id === l.id);
            if (x && isOpen(x)) {
              Object.assign(x, { status: "done", closedAt: now(), nextCheckAt: 0, checkedAt: now(), autoClosed: { at: now(), why: seen.what } });
            }
          });
          d.control?.log("followup", T(lg)("logDone", { what: seen.what, title: l.title }));
          out.done++;
          continue;
        }
        // Gentle: two nudges with no answer and it is not nudged again; it waits in the brief (and PENDING), where it can be closed or parked.
        if (g && (l.unanswered ?? 0) >= UNANSWERED_STOP) {
          await mutate((s) => {
            const x = s.loops.find((y) => y.id === l.id);
            if (unchanged(x)) Object.assign(x, { nextCheckAt: 0, folded: true, lastCheck: seen.said, checkedAt: now() });
          });
          d.control?.log("followup", GT()("folded", { title: l.title }));
          continue;
        }
        // Its time has passed (a late tick, a restart, the quiet hours, the budget): nothing to say any more; the brief may still mention it.
        // Gentle mode asks once instead, "did it happen?", so it is closed or parked rather than left to drift.
        const after = !!g && !!l.dueAt && t >= l.dueAt && (!l.afterAsked || l.status === "snoozed");
        if (l.dueAt && t >= l.dueAt && !after) {
          await mutate((s) => {
            const x = s.loops.find((y) => y.id === l.id);
            if (unchanged(x)) Object.assign(x, { nextCheckAt: 0, lastCheck: seen.said, checkedAt: now() });
          });
          continue;
        }
        const soon = !after && !!l.dueAt && !l.escalated && t >= l.dueAt - ESCALATE_BEFORE_MS && (l.nudges > 0 || !!seen.replied);
        const wanted = after || l.status === "snoozed" || soon || (l.nudges === 0 && !seen.replied);
        const variant = g ? pickVariant(VARIANTS[l.kind].length, l.variant, l.id) : undefined;
        // The budget is taken in the same write that records the nudge: two ticks can never both spend the last one.
        const others = wanted ? await (d.othersToday?.() ?? Promise.resolve(0)).catch(() => 0) : 0;
        const go = wanted
          ? await mutate((s) => {
            const day = today(now(), d.timeZone);
            if (s.budget.day !== day) s.budget = { day, n: 0 };
            const x = s.loops.find((y) => y.id === l.id);
            if (!unchanged(x)) return false;
            if (s.budget.n + others >= cap) {
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
            x.nextCheckAt = after ? 0 : nextAfter(x, now());
            if (g) {
              x.unanswered = (x.unanswered ?? 0) + 1;
              x.variant = variant;
              if (after) x.afterAsked = true;
            }
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
        const tl = T(lg);
        let body: string;
        let buttons: { id: string; title: string }[];
        let more: CardFeedback | undefined;
        if (g) {
          // A first tiny step only for a stuck one; how long similar meetings took only for a meeting, and only from three or more.
          const usually = l.kind === "agreed_meeting" && g.usually ? await g.usually(l.title).catch(() => null) : null;
          body = gentleNudgeText(l, {
            variant: variant ?? 0, due: dueText(l, lg), checked: seen.said, source: sourceText(l.sources[0], lg),
            ...(l.step && isStuck(l, t) ? { step: l.step } : {}), usually,
          }) + (draftable ? `\n${tl("draftHint")}` : "");
          buttons = [{ id: `f1:${l.id}`, title: GT()("btnDone") }, { id: `f4:${l.id}`, title: GT()("btnSnooze") }, { id: `f7:${l.id}`, title: GT()("btnPark") }];
          // A stuck one is offered a check-in too: "Check on me in 30 min" (src/gentle-checkins.ts).
          if (isStuck(l, t) && g.checkin) more = await g.checkin(l.id).catch(() => undefined);
        } else {
          body = nudgeText(l, seen.said, soon, lg) + (draftable ? `\n${tl("draftHint")}` : "");
          buttons = [
            { id: `f1:${l.id}`, title: tl("btnDone") }, { id: `f2:${l.id}`, title: tl("btnSnooze") }, { id: `f3:${l.id}`, title: tl("btnNotMine") },
          ];
        }
        const feedback = d.quality?.ask(l, lg);
        const sent = await d.card(body, buttons, feedback, more).catch(() => false);
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
