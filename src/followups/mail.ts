// Loops from mail: what the mail triage found owed (src/mail-categories.ts, "Needs you" and "Waiting on others") kept as loops with the person,
// the date and the email as their source, without a second run of Claude; a later email from someone the owner is waiting on closes what they
// owed; and the panel's Done on a mail closes its loops the way the nudge's Done button does (and its Undo opens them again).

import { fold } from "../lists.ts";
import { MAIL_THREAD } from "../mail-body.ts";
import { splitAddress } from "../people-graph.ts";
import type { Base, Engine } from "./parts.ts";
import { LOOPS_PER_JOB } from "./limits.ts";
import { isOpen, newId } from "./record.ts";
import type { Job, Loop } from "./types.ts";

export interface MailLoops {
  /** Loops the triage found in one email (candidates as the extraction gives them): kept like an answer to a job of that email. */
  fromMail: (o: { ref: string; label: string; at: number; loops: unknown[]; closed?: boolean; thread?: string }) => Promise<number>;
  /**
   * A new email from these names or addresses, in the thread of what they owed the owner by mail: that loop is closed (they answered). Only
   * when `from` (the sender's address) is one Pako knows for that person: `known` gives a loop's "Name <address>" lines (the contacts, the
   * mail the promise came from). A display name is anyone's to write.
   */
  answered: (o: { who: string[]; from: string; ref: string; thread?: string; known: (l: Loop) => Promise<string[]> }) => Promise<number>;
  /** Every loop (open or closed) that came from this email, newest first. */
  forRef: (ref: string) => Promise<Loop[]>;
  /** The owner marked the email done: its open loops closed through the button's own path. The ids closed. */
  doneFor: (ref: string, reason?: string) => Promise<string[]>;
  /** Undo of doneFor: those loops open again (when they are still closed). */
  reopen: (ids: string[]) => Promise<number>;
}

export function mountMailLoops(
  { now }: Base,
  { mutate, read, keep, press, touched, told }: Pick<Engine, "mutate" | "read" | "keep" | "press" | "touched" | "told">,
): MailLoops {
  const fromMail: MailLoops["fromMail"] = (o) =>
    mutate((s) => {
      const label = o.label.slice(0, 120) || "mail";
      const mailThread = o.thread && MAIL_THREAD.test(o.thread) ? { mailThread: o.thread } : {};
      const job: Job = { id: newId(), at: now(), source: "mail", where: { type: "mail", label, ...mailThread }, whenSaid: o.at, label, ref: o.ref.slice(0, 200) };
      // Not trusted: the candidates come from a model's answer, so a check time in them is ignored, as for any job.
      const before = touched(s, job);
      const added = keep(s, job, o.loops, LOOPS_PER_JOB, false);
      told(job, touched(s, job) - before, false);
      // The owner already replied (a mailbox's catch-up): known, kept closed, never a nudge.
      if (o.closed) {
        for (const l of s.loops) {
          if (isOpen(l) && l.sources.some((x) => x.ref === job.ref)) Object.assign(l, { status: "done", closedAt: now(), nextCheckAt: 0, lastCheck: "You already replied." });
        }
      }
      return added;
    });

  const answered: MailLoops["answered"] = (o) =>
    mutate(async (s) => {
      // Whole words: "Ana" is Ana Ruiz or ana.ruiz@…, never Mariana or joana@….
      const wordsOf = (x: string): string[] => fold(x.split("@")[0]!).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
      const names = o.who.map(wordsOf).filter((w) => w.length);
      if (!names.length) return 0;
      let n = 0;
      for (const l of s.loops) {
        if (!isOpen(l) || l.kind !== "other_promise" || l.where.type !== "mail" || l.sources.some((x) => x.ref === o.ref)) continue;
        const who = wordsOf(l.who);
        const within = (a: string[], b: string[]): boolean => a.every((w) => b.includes(w));
        if (!who.length || !names.some((x) => within(who, x) || within(x, who))) continue;
        // Only an email in the thread of the promise is its answer: one in another thread is noted, and the loop stays open.
        if (!o.thread || l.where.mailThread !== o.thread) {
          l.lastCheck = `${l.who} emailed you since, in another thread: not taken as this.`;
          continue;
        }
        // Their name is anyone's to write on a From line: the address must be one known for them.
        const address = splitAddress(o.from).email || o.from.trim().toLowerCase();
        const theirs = (await o.known(l).catch(() => [] as string[])).map(splitAddress).filter((x) => {
          if (!x.email) return false;
          const w = x.name ? wordsOf(x.name) : wordsOf(x.email);
          return w.length > 0 && (within(who, w) || within(w, who));
        });
        if (!address.includes("@") || !theirs.some((x) => x.email === address)) {
          l.lastCheck = `An email in that thread used ${l.who}'s name from an address not known for them: not taken as their answer.`;
          continue;
        }
        const why = "They answered in that email thread.";
        Object.assign(l, { status: "done", closedAt: now(), nextCheckAt: 0, lastCheck: why, autoClosed: { at: now(), why } });
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
        // Kept as an open loop from now: the store keeps one 14 days from when it was made, so an old one would go at the next change.
        Object.assign(l, { status: "open", nextCheckAt: 0, createdAt: Math.max(l.createdAt, now()) });
        delete l.lastCheck;
        // One Pako had closed (completed again in Reminders, then opened): no longer "closed for you", and no check closes it again.
        if (l.autoClosed) l.reopened = true;
        delete l.autoClosed;
        n++;
      }
      return n;
    });

  return { fromMail, answered, forRef, doneFor, reopen };
}
