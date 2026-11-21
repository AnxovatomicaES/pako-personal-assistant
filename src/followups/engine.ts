// The engine: createFollowups mounts its parts (src/followups/parts.ts) in order, handing each by name what it needs of the parts before
// it; then what the rest of Pako is given.

import type { Lang } from "../i18n.ts";
import type { Jobs } from "../jobs.ts";
import { today } from "../lists.ts";
import { mountChase } from "./chase.ts";
import { mountChecks } from "./checks.ts";
import { mountDue } from "./due.ts";
import { mountJobs } from "./jobs.ts";
import { mountMailLoops } from "./mail.ts";
import { mountMailJobs } from "./mail-jobs.ts";
import { mountMatching } from "./matching.ts";
import { mountNudges } from "./nudges.ts";
import { mountOwner } from "./owner.ts";
import type { Base } from "./parts.ts";
import { mountRehearse } from "./rehearse.ts";
import { mountStore } from "./store.ts";
import { T } from "./texts.ts";
import type { FollowupsDeps, Loop } from "./types.ts";
import { mountWords } from "./words.ts";
import { createLog } from "../log.ts";

const log = createLog("followups");

export function createFollowups(d: FollowupsDeps) {
  const now = d.now ?? Date.now;
  const lang = d.lang ?? ((): Lang => "en");
  const { config } = d;
  // The engine is built in parts (src/followups/), mounted in order: each is handed the base and, by name, only what it uses of the parts
  // before it (docs/how-it-works.md, "The follow-ups engine"). No part calls a later one.
  const base: Base = { d, config, now, lang };
  const { mutate, read } = mountStore(base);
  const { stamp, dueText, sourceText, nudgeText } = mountWords(base);
  const { jobText, queueJob, slackJob, flushBatch, observeSlack, textJob, offer } = mountJobs(base, { mutate, read, stamp });
  const { observeMail, flushMailDue } = mountMailJobs(base, { mutate, queueJob, stamp });
  const { ruledOut, keep, result, ingest, fromChat, dropFromChat, touched, told } = mountMatching(base, { mutate });
  const { runCheck } = mountChecks(base);
  const { quietNow, nextAfter, tick } = mountNudges(base, { mutate, read, flushBatch, flushMailDue, runCheck, nudgeText, dueText, sourceText });
  const { press, open, command, context, closeByWords, calendarChanged, reopenClosed, forDraft, draftFacts, snoozeCard, parked, parkedText, unpark,
    setStep, letGo, engaged, expiredParked, closedForYou, reopenByWords } = mountOwner(base, { mutate, read, dueText, sourceText, quietNow, nextAfter });
  const { draft, dryAnswer } = mountRehearse(base, { read, slackJob, textJob, jobText, keep, ruledOut, runCheck, dueText, sourceText, nudgeText, quietNow });
  // Loops from the mail triage, and the panel's Done on a mail (src/followups/mail.ts).
  const mail = mountMailLoops(base, { mutate, read, keep, press, touched, told });
  // Chasing what others owe the owner, once it is overdue (src/followups/chase.ts).
  const { chaseTick, chaseWritten, chasePressed, chaseNow } = mountChase(base, { mutate, read, runCheck, draftFacts, forDraft, quietNow, dueText });
  /** A round: the nudges, then the chases (each with its own guard: a failing chase never stops a nudge). */
  const sweep = async () => {
    const out = await tick();
    await chaseTick().catch((err: Error) => log.error(`chases: ${err.message}`));
    return out;
  };
  // A loop's time moved by the owner elsewhere (its reminder in Apple Reminders, src/reminders-local.ts).
  const { moveDue } = mountDue(base, { mutate, nextAfter });

  return {
    observeSlack,
    /** An email the server chose (src/mail-followups.ts), read whole with its thread's other new mail (src/followups/mail-jobs.ts). */
    observeMail,
    offer,
    result,
    ingest,
    tick,
    press,
    command,
    context,
    closeByWords,
    calendarChanged,
    forDraft,
    draftFacts,
    fromChat,
    dropFromChat,
    reopenClosed,
    /** Gentle mode (src/gentle.ts): the Snooze card, the Parked list, bringing one back, and a loop's first tiny step. */
    snoozeCard,
    parked,
    parkedText,
    unpark,
    setStep,
    letGo,
    /** The owner engaged with a loop without a Done/Snooze/Park press (a check-in asked from its nudge): its unanswered count starts again. */
    engaged,
    /** Parked loops the store let go after PARKED_KEEP_MS, newest first: the Parked list's history (src/gentle-reset.ts). */
    expiredParked,
    /** What Pako closed on its own (the brief's "Closed for you"), and "reopen <words>" for one of them. */
    closedForYou,
    reopenByWords,
    /** Someone else's overdue promise: its reminder written, a press on its card, and "chase <words>" (src/followups/chase.ts). */
    chaseWritten,
    chasePressed,
    chaseNow,
    chaseTick,
    /** The owner moved a loop's time in Apple Reminders (src/reminders-local.ts): the loop follows. */
    moveDue,
    open,
    read,
    /** Nudges given today: proactive Pako (src/proactive.ts) counts them in the day's shared budget. */
    spentToday: async (): Promise<number> => {
      const s = await read();
      return s.budget.day === today(now(), d.timeZone) ? s.budget.n : 0;
    },
    /** One loop as the owner reads it in a list: title, time (both zones), source. For the brief. */
    describe: (l: Loop, lg: Lang = lang()): string => T(lg)("line", { title: l.title, due: dueText(l, lg), source: sourceText(l.sources[0], lg) }).slice(2),
    /** Every half minute; with the durable jobs (src/jobs.ts) on their clock instead: a check due while the computer slept runs when it wakes. */
    start: (jobs?: Pick<Jobs, "define">) => {
      if (jobs) jobs.define({ kind: "followups", sweep });
      else setInterval(() => void sweep(), 30_000).unref?.();
    },
    /** The rehearsal's dry run (src/rehearsal.ts): never a loop kept, a check moved or a nudge sent. */
    rehearse: { draft, dryAnswer },
    ...mail,
  };
}

export type Followups = ReturnType<typeof createFollowups>;
