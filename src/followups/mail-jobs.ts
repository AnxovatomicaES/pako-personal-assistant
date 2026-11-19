// Email threads read whole: each email the server chose (src/mail-followups.ts) joins its thread's batch, and after a few minutes the batch
// becomes one job, as a Slack conversation's does (src/followups/jobs.ts observeSlack). The job carries the new emails' cleaned words (src/
// mail-body.ts), their sender, recipients, date and subject; the thread's open loops come with it (jobText), so a reply can close or move
// them. An email is read once: its ref is remembered, and an older one of the thread is never sent again, only the loops it made.
//
// At most FollowupsConfig.mailPerDay jobs a day: a thread already waiting takes more mail for free; a new one past the cap is refused, and
// the caller keeps the triage's own lines instead (no second run of Claude).

import { today } from "../lists.ts";
import { cleanMailBody, MAIL_BODY_MAX, MAIL_THREAD } from "../mail-body.ts";
import { inline, neutralise } from "../quarantine.ts";
import { createLog } from "../log.ts";
import { JOB_KEEP_MS, MAIL_BATCH_MAX, MAIL_JOB_CHARS, MAIL_JOBS_PER_DAY } from "./limits.ts";
import type { Engine } from "./parts.ts";
import { newId } from "./record.ts";
import { T } from "./texts.ts";
import type { Job, MailBatch, MailSeen } from "./types.ts";

const log = createLog("followups");

export function mountMailJobs(fu: Engine): Pick<Engine, "observeMail" | "flushMailDue"> {
  const { d, now, lang, config, mutate, enqueueJob, stamp } = fu;
  const perDay = config.mailPerDay ?? MAIL_JOBS_PER_DAY;

  /**
   * One email into its thread's batch. True when the follow-ups have it (now, or from before: it is never read twice); false when they do not
   * take it: off (0 a day), no thread, no words left once cleaned, or the day's jobs spent with no batch of that thread waiting.
   */
  const observeMail: Engine["observeMail"] = (m, label) =>
    mutate((s) => {
      if (perDay <= 0 || !MAIL_THREAD.test(m.thread) || !m.ref) return false;
      const ref = m.ref.slice(0, 200);
      if (s.mailRead.includes(ref) || s.mailBatches.some((b) => b.mails.some((x) => x.ref === ref))) return true;
      const body = cleanMailBody(m.body);
      if (!body) return false;
      const day = today(now(), d.timeZone);
      if (s.mailBudget.day !== day) s.mailBudget = { day, n: 0 };
      let b = s.mailBatches.find((x) => x.thread === m.thread);
      if (!b) {
        // A thread waiting counts as a job already: the cap holds however the day's mail is spread.
        const waiting = s.mailBatches.filter((x) => now() - x.firstAt < JOB_KEEP_MS).length;
        if (s.mailBudget.n + waiting >= perDay) {
          log.info("the day's email jobs are spent: this email keeps the triage's own lines");
          return false;
        }
        b = { thread: m.thread, where: { type: "mail", label: label.slice(0, 120) || "email", mailThread: m.thread }, firstAt: now(), mails: [] };
        s.mailBatches.push(b);
      }
      // A thread the owner opened is named again by the first email of the other side, which says who it is with.
      if (!m.mine && label && b.mails.every((x) => x.mine)) b.where.label = label.slice(0, 120);
      const kept: MailSeen = {
        ref, thread: m.thread, at: m.at, from: m.from.slice(0, 200), to: m.to.slice(0, 200), cc: m.cc.slice(0, 200), subject: m.subject.slice(0, 300),
        body, ...(m.mine ? { mine: true } : {}), ...(m.closed ? { closed: true } : {}),
      };
      b.mails = [...b.mails, kept].sort((x, y) => x.at - y.at).slice(-MAIL_BATCH_MAX);
      s.mailRead.push(ref);
      return true;
    }).catch((err: Error) => (log.error(`could not keep an email for the follow-ups: ${err.message}`), false));

  /** A thread's batch as a job and its material: each email's head and words, oldest first, all of them new. */
  const mailJob = (b: MailBatch): { job: Job; material: string[]; people: string[] } => {
    const t = T(lang());
    const share = Math.min(MAIL_BODY_MAX, Math.floor(MAIL_JOB_CHARS / Math.max(1, b.mails.length)));
    const blocks = b.mails.map((m) => [
      `* [${stamp(m.at, d.timeZone)}] ${t("mailFrom", { from: m.mine ? t("me") : inline(m.from, 200) })}`,
      ...(m.to ? [t("mailTo", { to: inline(m.to, 200) })] : []),
      ...(m.cc ? [t("mailCc", { cc: inline(m.cc, 200) })] : []),
      t("mailSubject", { subject: inline(m.subject, 300) }),
      neutralise(m.body, { max: share }),
    ].join("\n"));
    const last = b.mails[b.mails.length - 1]!;
    const job: Job = {
      id: newId(), at: now(), source: "mail", where: b.where, whenSaid: last.at, label: b.where.label, ref: last.ref,
      // The owner already answered every one of them (a catch-up): known, kept closed, never a nudge.
      ...(b.mails.every((m) => m.closed) ? { closed: true } : {}),
    };
    // Its people: the senders of the others' emails, and those the owner wrote to.
    const names = b.mails.flatMap((m) => (m.mine ? m.to.split(/,\s*/) : [m.from])).map((x) => x.trim()).filter(Boolean);
    return { job, material: [t("mailThread"), "", blocks.join("\n\n")], people: [...new Set(names)].slice(0, 8) };
  };

  /** One batch queued, or put back for the next tick (before any email that came since): what was in it is never lost. */
  const flushMail = async (b: MailBatch): Promise<boolean> => {
    const ok = await (async () => {
      const { job, material, people } = mailJob(b);
      return enqueueJob(job, material, people);
    })().catch((err: Error) => (log.error(`could not queue an email thread: ${err.message}`), false));
    await mutate((s) => {
      if (ok) {
        const day = today(now(), d.timeZone);
        if (s.mailBudget.day !== day) s.mailBudget = { day, n: 0 };
        s.mailBudget.n++;
        return;
      }
      const later = s.mailBatches.find((x) => x.thread === b.thread);
      if (!later) s.mailBatches.push(b);
      else Object.assign(later, { firstAt: b.firstAt, mails: [...b.mails, ...later.mails.filter((m) => !b.mails.some((x) => x.ref === m.ref))].slice(-MAIL_BATCH_MAX) });
    });
    return ok;
  };

  /** The threads whose batch is due, each as one job; a thread whose last job is unanswered waits for it (its loops then come listed). */
  const flushMailDue = async (t: number): Promise<number> => {
    const due = await mutate((s) => {
      const waiting = (b: MailBatch): boolean => s.jobs.some((j) => j.source === "mail" && j.where.mailThread === b.thread);
      const ready = s.mailBatches.filter((b) => t - b.firstAt >= config.batchMs && !waiting(b));
      s.mailBatches = s.mailBatches.filter((b) => !ready.includes(b));
      return ready;
    });
    let n = 0;
    for (const b of due) if (await flushMail(b)) n++;
    return n;
  };

  return { observeMail, flushMailDue };
}
