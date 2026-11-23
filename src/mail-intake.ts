// One parsed email of the owner's own mailbox into everything that reads mail, whichever reader found it: IMAP (src/imap.ts) or the mail
// Apple Mail already downloaded on this Mac (src/apple-mail.ts). Both hand over the same thing, a message parsed by src/imap.ts parseMessage,
// so the mailbox, the triage, the follow-ups, the lessons and the invitations see one kind of email, never two.
//
// An inbox email goes through src/mail.ts takeMail (codes hidden, mail sent to many only kept, VIPs, the summary run); its id is the reader's,
// and takeMail's same-email key (Message-ID and sender) makes the second reader of the same email a no-op. An email the owner sent (a Sent
// folder) closes what it answers (src/mail.ts takeOwnMail), is set beside a draft Pako wrote (src/lessons.ts ownSent), and is read whole by
// the follow-ups (src/mail-followups.ts sent), whose ref is its Message-ID: read by both readers, it still counts once.

import type { Backfill } from "./backfill.ts";
import type { ParsedMessage } from "./imap.ts";
import type { InviteStore } from "./invites.ts";
import { cleanMailBody } from "./mail-body.ts";
import { authenticated, mailboxes, type MailProvider } from "./mail-categories.ts";
import type { SentMail } from "./mail-followups.ts";
import { addressOf, htmlToText, takeMail, takeOwnMail, type AgentMailMessage, type IntakeDeps, type MailAccount, type Mailbox } from "./mail.ts";
import type { Inbound } from "./whatsapp.ts";
import { createLog } from "./log.ts";

type Lang = ReturnType<IntakeDeps["lang"]>;

export interface MailIntakeDeps {
  box: Mailbox;
  /** The owner's assistant inbox (src/whatsapp.ts). */
  enqueue: (m: Inbound) => Promise<boolean>;
  control?: IntakeDeps["control"];
  lang: () => Lang;
  now: () => number;
  /** Senders whose mail always reaches the owner at once. */
  vip: string[];
  /** Where the owner's copy lives (an IMAP host tells); without it, read from the addresses the mail was delivered to. */
  provider?: MailProvider | undefined;
  /** The mailbox's server (its IMAP host): off the big providers, only an Authentication-Results header that names it counts (src/mail-categories.ts authenticated). */
  authServer?: string | undefined;
  filed?: IntakeDeps["filed"];
  /** Invitations caught from the mail (src/invites.ts). */
  invites?: InviteStore | undefined;
  /** The owner's own words beside a draft Pako wrote for that address (src/lessons.ts ownSent). */
  ownSent?: ((o: { to: string[]; text: string; at: number }) => Promise<unknown>) | undefined;
  /** Each email the owner sent, for the follow-ups (src/mail-followups.ts sent). */
  sentMail?: ((m: SentMail) => Promise<unknown>) | undefined;
  /** A new account's catch-up (src/backfill.ts): only IMAP has one. */
  backfill?: Pick<Backfill, "add" | "addSent"> | undefined;
  /** The log the lines go to: the reader's own. */
  log?: ReturnType<typeof createLog> | undefined;
}

export interface InboxOptions {
  /** The mailbox's id for this email (the reader's own prefix: "imap:", "applemail:"). */
  id: string;
  /** The owner's own addresses: mail from one of them is the owner's, not news. */
  own: string[];
  account: MailAccount;
  /** Already there when the mailbox was first read: kept, never told. */
  quiet?: boolean;
  /** The owner already answered it (seen in a catch-up's Sent). */
  replied?: boolean;
  /** Part of a new account's catch-up: goes through the catch-up, paced. */
  catchUp?: boolean;
  /** Found in the owner's Sent folder: their own mail beyond doubt. */
  sentFolder?: boolean;
}

export function createMailIntake(d: MailIntakeDeps) {
  const log = d.log ?? createLog("mail");

  /**
   * An email the owner sent: what it answers is closed, its words go beside a draft and to the follow-ups. In a catch-up (`ref` names it
   * there) it goes through the catch-up, paced; true then. False otherwise, and when nothing of it is left to read.
   */
  const sent = async (p: ParsedMessage, at: number, o: { catchUp?: boolean; ref?: string } = {}): Promise<boolean> => {
    // What it answers and is already kept leaves the dashboard's preview (src/mail.ts takeOwnMail).
    await takeOwnMail(d.box, { headers: p.headers }, d.now()).catch((err: Error) => log.error(`a reply of the owner's could not be matched: ${err.message}`));
    if (d.ownSent) {
      // Only the quoted lines go (a reply written under or between them stays); each header holds a list, so one address per mailbox.
      const mine = (p.text ?? (p.html ? htmlToText(p.html) : "")).replace(/^>.*$/gm, "").trim().slice(0, 3000);
      const to = p.to.flatMap(mailboxes).map(addressOf).filter((a) => a.includes("@"));
      if (mine) await d.ownSent({ to, text: mine, at }).catch((err: Error) => log.error(`a sent email's lesson failed: ${err.message}`));
    }
    // The owner's own email, read whole by the follow-ups (src/mail-followups.ts): what they promise in it ("I'll send it Friday") becomes
    // their loop, and a reply that does what was asked closes it.
    const header = (name: string): string => p.headers.filter((h) => h.name.toLowerCase() === name).map((h) => h.value).join(", ");
    const mail: SentMail = {
      messageId: p.messageId, inReplyTo: header("in-reply-to"), references: header("references"), subject: p.subject.slice(0, 300),
      to: header("to").slice(0, 200), cc: header("cc").slice(0, 200), text: cleanMailBody(p.text ?? (p.html ? htmlToText(p.html) : "")), at, from: p.from.slice(0, 200),
    };
    if (!mail.text) return false;
    if (!o.catchUp || !d.backfill) {
      if (d.sentMail) await d.sentMail(mail).catch((err: Error) => log.error(`a sent email could not reach the follow-ups: ${err.message}`));
      return false;
    }
    const to = mail.to || p.to.join(", ").slice(0, 200);
    await d.backfill.addSent({
      ref: o.ref ?? `sent:${at}`, label: to ? `email to ${to}` : "sent email", text: `To: ${to}\nSubject: ${p.subject}\n\n${mail.text}`, at, mail,
    });
    return true;
  };

  /** An email in an inbox: the owner's own is not news (it closes what it answers); anyone else's goes through takeMail. */
  const inbox = async (p: ParsedMessage, at: number, o: InboxOptions): Promise<"queued" | "stored" | "seen" | "own"> => {
    // An invitation (or its cancellation) shows on the dashboard at once, whatever else the mail is: kept apart, never acted on.
    // Its sender as the owner's mail server vouched for it: only the organizer's own mail changes or cancels an invitation already kept.
    const authResults = p.headers.filter((h) => /^authentication-results$/i.test(h.name)).map((h) => h.value);
    const from = addressOf(p.from);
    if (p.calendar && d.invites) {
      await d.invites.take(p.calendar, at, { address: from, vouched: authenticated(p.from, authResults, d.authServer) })
        .catch((err: unknown) => log.error(`an invitation could not be read: ${(err as Error)?.name}`));
    }
    // Anyone can write the owner's address on a From line: outside the Sent folder only a mail their own server vouched for (DKIM or DMARC
    // aligned) closes what it answers. A forged one is not news either, and closes nothing.
    if (from && o.own.includes(from)) {
      const vouched = o.sentFolder || authenticated(p.from, authResults, d.authServer);
      if (vouched) await takeOwnMail(d.box, { headers: p.headers }, d.now()).catch((err: Error) => log.error(`a reply of the owner's could not be matched: ${err.message}`));
      return "own";
    }
    if (await d.box.isSeen(o.id)) return "seen";
    const m: AgentMailMessage = {
      message_id: o.id,
      from: p.from,
      subject: p.subject,
      to: p.to,
      headers: p.headers,
      timestamp: new Date(at).toISOString(),
      attachments: p.attachments.map((filename) => ({ filename })),
      ...(p.text !== undefined ? { text: p.text } : {}),
      ...(p.html !== undefined ? { html: p.html } : {}),
    };
    const bf = o.catchUp ? d.backfill : undefined;
    const replied = !!o.replied;
    return takeMail({ box: d.box, enqueue: d.enqueue, control: d.control, lang: d.lang, now: d.now, vip: d.vip, provider: d.provider, authServer: d.authServer, filed: d.filed }, o.id, m, o.account, {
      quiet: !!o.quiet, ...(replied ? { replied: true } : {}), ...(bf ? { enqueue: (x: Inbound) => bf.add(x, { from, replied }) } : {}),
    });
  };

  return { sent, inbox };
}

export type MailIntake = ReturnType<typeof createMailIntake>;
