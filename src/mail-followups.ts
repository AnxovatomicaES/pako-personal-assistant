// Which email the follow-ups read whole, decided here and never by a model: what the triage filed as Needs you, Waiting on others, Important
// or Personal (told to the owner or not), and every email the owner sent (their Sent folder: their own promises, and the replies that answer
// what was asked of them). Never Promotions, Updates, Read later or Suspicious, never one taken for a scam, never mail sent to a list.
//
// What is read is the email's own words, cleaned (src/mail-body.ts: the newest message, no quoted history, no signature, about 4,000
// characters at most), with its sender, recipients, date and subject, gathered per thread into one job (src/followups/mail-jobs.ts). Nothing
// new is kept for it: the words come from what the mailbox already keeps for the panel's reader (src/mail.ts keepBody), and wait in the
// follow-ups' store only until the thread's job is queued.

import { hideCodes } from "./codes.ts";
import type { FollowupsDoor, MailSeen } from "./followups.ts";
import { cleanMailBody, mailThreadKey, MAIL_THREAD } from "./mail-body.ts";
import { senderName, type MailCategory } from "./mail-categories.ts";
import { addressOf, type RecentMail } from "./mail.ts";
import { createHash } from "node:crypto";

/** The categories whose mail the follow-ups read. */
export const LOOP_CATEGORIES: ReadonlySet<MailCategory> = new Set<MailCategory>(["needs_you", "waiting", "important", "personal"]);

/** Whether an email is one the follow-ups read: its category, not a scam, not mail sent to a list. */
export const readForFollowups = (r: Pick<RecentMail, "bulk" | "scam"> & { category: MailCategory }): boolean =>
  LOOP_CATEGORIES.has(r.category) && r.scam !== true && r.bulk !== true;

export interface MailFollowupsDeps {
  /** The mailbox (src/mail.ts): the email as kept, and its words as kept for the reader (codes already hidden). */
  box: { get: (id: string) => Promise<(RecentMail & { category: MailCategory }) | null>; body: (id: string) => Promise<string> };
  /** The follow-ups' door (src/followups/door-proxy.ts): absent or off, nothing is read. */
  followups: () => Pick<FollowupsDoor, "observeMail"> | null;
}

/** An email the owner sent, as src/imap.ts reads it from their Sent folder. */
export interface SentMail {
  messageId: string;
  inReplyTo: string;
  references: string;
  subject: string;
  to: string;
  cc: string;
  /** The text part, or the HTML made text (src/mail.ts htmlToText). */
  text: string;
  at: number;
  /** The owner's own address: the From line. */
  from: string;
}

/** A sent email made into what the follow-ups read (its words cleaned, codes hidden); null when nothing of it is left to read. */
export function sentSeen(m: SentMail): MailSeen | null {
  const body = cleanMailBody(hideCodes(m.text).text);
  if (!body) return null;
  const thread = mailThreadKey({ references: m.references, inReplyTo: m.inReplyTo, messageId: m.messageId, subject: m.subject });
  const key = m.messageId.trim().toLowerCase() || `${m.at}\n${m.subject}\n${m.to}`;
  return {
    ref: `sent:${createHash("sha256").update(key).digest("hex").slice(0, 20)}`, thread, at: m.at, from: m.from.slice(0, 200), to: m.to.slice(0, 200),
    cc: m.cc.slice(0, 200), subject: m.subject.slice(0, 300), body, mine: true,
  };
}

/** The label a sent email's thread goes by until the other side writes ("email to Ana"). */
export const sentLabel = (to: string): string => {
  const first = to.split(/,\s*/)[0]?.trim() ?? "";
  const name = first ? senderName(first) || addressOf(first) : "";
  return name ? `email to ${name}`.slice(0, 120) : "sent email";
};

export function createMailFollowups(d: MailFollowupsDeps) {
  return {
    /**
     * An inbox email once filed (the triage's verdict, or a sender rule): read whole when its category is one of LOOP_CATEGORIES. True when
     * the follow-ups have it (the caller then leaves the triage's own LOOP line out: one reading, not two); false otherwise.
     */
    inbox: async (id: string, o: { category?: MailCategory; scam?: boolean; closed?: boolean } = {}): Promise<boolean> => {
      const fu = d.followups();
      if (!fu?.observeMail) return false;
      const r = await d.box.get(id);
      if (!r) return false;
      const category = o.category ?? r.category;
      if (!readForFollowups({ category, bulk: r.bulk, scam: o.scam ?? r.scam })) return false;
      const thread = r.thread && MAIL_THREAD.test(r.thread) ? r.thread : mailThreadKey({ messageId: r.messageId ?? "", subject: r.subject });
      const body = await d.box.body(id);
      if (!body.trim()) return false;
      const seen: MailSeen = {
        ref: id, thread, at: r.at, from: r.from, to: r.to ?? "", cc: r.cc ?? "", subject: r.subject, body, ...(o.closed ? { closed: true } : {}),
      };
      return fu.observeMail(seen, `email · ${senderName(r.from) || addressOf(r.from)}`.slice(0, 120));
    },
    /** An email the owner sent (their Sent folder): their promises, and what their reply answers. True when the follow-ups took it. */
    sent: async (m: SentMail): Promise<boolean> => {
      const fu = d.followups();
      const seen = sentSeen(m);
      if (!fu?.observeMail || !seen) return false;
      return fu.observeMail(seen, sentLabel(m.to));
    },
  };
}

export type MailFollowups = ReturnType<typeof createMailFollowups>;
