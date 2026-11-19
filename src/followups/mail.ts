// Loops from mail: what the mail triage found owed (src/mail-categories.ts, "Needs you" and "Waiting on others") kept as loops with the person,
// the date and the email as their source, without a second run of Claude; a later email from someone the owner is waiting on closes what they
// owed; and the panel's Done on a mail closes its loops the way the nudge's Hecho button does (and its Undo opens them again).

import { fold } from "../lists.ts";
import type { Engine } from "./parts.ts";
import { LOOPS_PER_JOB } from "./limits.ts";
import { isOpen, newId } from "./record.ts";
import type { Job, Loop } from "./types.ts";

export interface MailLoops {
  /** Loops the triage found in one email (candidates as the extraction gives them): kept like an answer to a job of that email. */
  fromMail: (o: { ref: string; label: string; at: number; loops: unknown[]; closed?: boolean }) => Promise<number>;
  /** A new email from these names or addresses: the open loops they owed the owner from mail are closed (they answered). */
  answered: (o: { who: string[]; ref: string }) => Promise<number>;
  /** Every loop (open or closed) that came from this email, newest first. */
  forRef: (ref: string) => Promise<Loop[]>;
  /** The owner marked the email done: its open loops closed through the button's own path. The ids closed. */
  doneFor: (ref: string, reason?: string) => Promise<string[]>;
  /** Undo of doneFor: those loops open again (when they are still closed). */
  reopen: (ids: string[]) => Promise<number>;
}

export function mountMailLoops(fu: Engine): MailLoops {
  const { now, mutate, read, keep, press } = fu;
  const fromMail: MailLoops["fromMail"] = (o) =>
    mutate((s) => {
      const label = o.label.slice(0, 120) || "mail";
      const job: Job = { id: newId(), at: now(), source: "mail", where: { type: "mail", label }, whenSaid: o.at, label, ref: o.ref.slice(0, 200) };
      // Not trusted: the candidates come from a model's answer, so a check time in them is ignored, as for any job.
      const added = keep(s, job, o.loops, LOOPS_PER_JOB, false);
      // The owner already replied (a mailbox's catch-up): known, kept closed, never a nudge.
      if (o.closed) {
        for (const l of s.loops) {
          if (isOpen(l) && l.sources.some((x) => x.ref === job.ref)) Object.assign(l, { status: "done", closedAt: now(), nextCheckAt: 0, lastCheck: "You already replied." });
        }
      }
      return added;
    });

  const answered: MailLoops["answered"] = (o) =>
    mutate((s) => {
      const names = o.who.map((w) => fold(w)).filter((w) => w.length >= 2);
      if (!names.length) return 0;
      let n = 0;
      for (const l of s.loops) {
        if (!isOpen(l) || l.kind !== "other_promise" || l.where.type !== "mail" || l.sources.some((x) => x.ref === o.ref)) continue;
        const who = fold(l.who);
        if (!who || !names.some((x) => x === who || x.includes(who) || who.includes(x))) continue;
        Object.assign(l, { status: "done", closedAt: now(), nextCheckAt: 0, lastCheck: "They answered by email." });
        n++;
      }
      return n;
    });

  const forRef: MailLoops["forRef"] = async (ref) =>
    (await read()).loops.filter((l) => l.sources.some((x) => x.kind === "mail" && x.ref === ref)).sort((a, b) => b.createdAt - a.createdAt);

  const doneFor: MailLoops["doneFor"] = async (ref, reason = "Owner marked done.") => {
    const ids = (await forRef(ref)).filter(isOpen).map((l) => l.id);
    for (const id of ids) {
      await mutate((s) => {
        const l = s.loops.find((x) => x.id === id);
        if (l) l.lastCheck = reason;
      });
      // The nudge's Done button: closed, never checked or nudged again, out of PENDING and the brief.
      await press("1", id);
    }
    return ids;
  };

  const reopen: MailLoops["reopen"] = (ids) =>
    mutate((s) => {
      let n = 0;
      for (const l of s.loops) {
        if (!ids.includes(l.id) || l.status !== "done") continue;
        delete l.closedAt;
        Object.assign(l, { status: "open", nextCheckAt: 0 });
        delete l.lastCheck;
        n++;
      }
      return n;
    });

  return { fromMail, answered, forRef, doneFor, reopen };
}
