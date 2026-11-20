// The engine: createFollowups builds the shared context (src/followups/parts.ts) and its parts, in order, each adding its names for the
// parts after it; then what the rest of Pako is given.

import type { Lang } from "../i18n.ts";
import type { Jobs } from "../jobs.ts";
import { today } from "../lists.ts";
import { mountChecks } from "./checks.ts";
import { mountJobs } from "./jobs.ts";
import { mountMailLoops } from "./mail.ts";
import { mountMailJobs } from "./mail-jobs.ts";
import { mountMatching } from "./matching.ts";
import { mountNudges } from "./nudges.ts";
import { mountOwner } from "./owner.ts";
import type { Engine } from "./parts.ts";
import { mountRehearse } from "./rehearse.ts";
import { mountStore } from "./store.ts";
import { T } from "./texts.ts";
import type { FollowupsDeps, Loop } from "./types.ts";
import { mountWords } from "./words.ts";

export function createFollowups(d: FollowupsDeps) {
  const now = d.now ?? Date.now;
  const lang = d.lang ?? ((): Lang => "en");
  const { config } = d;
  // The engine is built in parts (src/followups/), each adding its names to `fu` for the parts after it.
  const fu = { d, config, now, lang } as Engine;
  Object.assign(fu, mountStore(fu));
  Object.assign(fu, mountWords(fu));
  Object.assign(fu, mountJobs(fu));
  Object.assign(fu, mountMailJobs(fu));
  Object.assign(fu, mountMatching(fu));
  Object.assign(fu, mountChecks(fu));
  Object.assign(fu, mountNudges(fu));
  Object.assign(fu, mountOwner(fu));
  Object.assign(fu, mountRehearse(fu));
  const { observeSlack, observeMail, offer, result, ingest, tick, press, command, context, open, read, dueText, sourceText, draft, dryAnswer } = fu;
  const { closeByWords, calendarChanged, reopenClosed, forDraft, draftFacts, fromChat, dropFromChat, snoozeCard, parked, parkedText, unpark,
    setStep, letGo, engaged, expiredParked, closedForYou, reopenByWords } = fu;
  // Loops from the mail triage, and the panel's Done on a mail (src/followups/mail.ts).
  const mail = mountMailLoops(fu);

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
      if (jobs) jobs.define({ kind: "followups", sweep: () => tick() });
      else setInterval(() => void tick(), 30_000).unref?.();
    },
    /** The rehearsal's dry run (src/rehearsal.ts): never a loop kept, a check moved or a nudge sent. */
    rehearse: { draft, dryAnswer },
    ...mail,
  };
}

export type Followups = ReturnType<typeof createFollowups>;
