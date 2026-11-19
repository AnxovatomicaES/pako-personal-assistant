// What the door is given (WhatsappDeps) and the shapes it shares with the other channels: the owner's ask, the chats, Telegram.

import type { CalendarWrite } from "../calendar-writes.ts";
import type { Request } from "express";
import type { Control } from "../control.ts";
import type { Lang } from "../i18n.ts";
import type { Kv } from "../kv.ts";
import type { MemoryStore } from "../voice-memory.ts";
import type { VoiceTools } from "../voice-tools.ts";
import type { Booking } from "../booking.ts";
import type { LocalChannel } from "../local.ts";
import type { ListStore } from "../lists.ts";
import type { FollowupsDoor } from "../followups.ts";
import type { Verdict } from "../mail-categories.ts";
import type { LifeDoor } from "../proactive.ts";
import type { ReviewDoor } from "../meeting-review.ts";
import type { AutonomyConfig, AutonomySettings } from "../autonomy.ts";
import type { PeopleStore } from "../people.ts";
import type { Companion } from "../companion.ts";
import type { FactStore } from "../memory-facts.ts";
import type { PeopleGraph } from "../people-graph.ts";
import type { WatchSources } from "../routines.ts";
import type { HealthReport } from "../watchdog.ts";
import type { Jobs } from "../jobs.ts";
import type { PaperStore } from "../papers.ts";
import type { WhatsappConfig } from "./config.ts";

export interface WhatsappDeps {
  config: WhatsappConfig;
  /** The voice line's plain tools: the same staging and confirmation of a friend call, the same checks. */
  tools: Pick<VoiceTools, "run">;
  /** The memory the voice line reads. */
  memory: MemoryStore;
  kv: Kv | null;
  ownerName: string;
  timeZone: string;
  contacts: () => string[];
  /** A friend's name and number by the name the assistant used (case and accents do not matter), or null. Never sent to the assistant. */
  contactByName?: (name: string) => { name: string; number: string } | null;
  /** The contact book's email addresses (PERSONAL_CONTACT_EMAILS, src/autonomy.ts): <email to="Ana"> goes to Ana's. */
  contactEmails?: () => { name: string; address: string }[];
  /**
   * Sends one email: through Resend when it is set, else from Pako's own AgentMail inbox (src/resend.ts chooseSender); absent, <email> says it
   * cannot. A 4xx error carries `status`, and Resend's reason as `why`. `idempotencyKey`: the held action's or the card's id.
   */
  sendEmail?: (m: { to: string; subject: string; text: string; idempotencyKey?: string }) => Promise<void>;
  /**
   * Autonomy (src/autonomy.ts): AUTONOMY and AUTONOMY_UNDO_SECONDS, the panel's choices per type (kept in `kv` when absent), and how long a
   * window's real timer waits (the tests shorten it).
   */
  autonomy?: { config?: AutonomyConfig; settings?: AutonomySettings; delay?: (ms: number) => number };
  fetch?: typeof fetch;
  now?: () => number;
  /** How often a placed call is looked up until it has ended (default 20 s; the tests use a few milliseconds). */
  callCheckMs?: number;
  /** How long the receipt for an answer's notes waits for that answer's reply before it goes alone (default 90 s; the tests use a few ms). */
  receiptWaitMs?: number;
  /** The kill switch and the action log (src/control.ts). */
  control?: Control;
  /**
   * Local mode (src/local.ts): there is no WhatsApp. What the door would send to Meta goes to the chat window of the panel instead, and the
   * window never closes. `ingest` (in what mountWhatsapp returns) is how what the owner types there arrives.
   */
  local?: Pick<LocalChannel, "deliver">;
  /** Booking a table (src/booking.ts): the search, the owner's choice and the card that makes Pako write to a restaurant. */
  booking?: Booking;
  /** Telegram, a second chat beside this one (src/telegram.ts): off unless TELEGRAM_BOT_TOKEN is set. */
  telegram?: TelegramDoor;
  /**
   * On a computer only: the owner's real WhatsApp, set up in the panel (src/whatsapp-computer.ts), a chat beside the panel's like Telegram.
   * Its messages arrive by `ingest` with the channel "whatsapp"; absent, or not set up, everything works as before.
   */
  whatsapp?: WhatsappLine;
  /**
   * The owner's panel (src/dashboard.ts): a one-time sign-in link for the PANEL command; null while the server does not know its own public
   * address (PANEL then says how to set PUBLIC_URL).
   */
  panelLink?: () => string | null;
  /**
   * Called with a webhook request whose signature checked out and whose body Meta stamped a few minutes ago at most (a message or a status),
   * before it is handled. Only such a request may teach the server something about itself, like its public address (src/app.ts): an unsigned
   * request can carry any Host header, and so can a signed body sent again later by someone who kept it (the signature covers the body only, and
   * never expires).
   */
  onSigned?: (req: Request) => void;
  /** The language of the door's own fixed texts (src/i18n.ts): English only. Kept as a function so the modules that ask for it need not change. */
  lang?: () => Lang;
  /** The owner's calendar, read only (src/calendar.ts): a day's events as text, and the next week one line each. */
  calendar?: { day: (offset: number) => Promise<string>; context: () => Promise<string[]> };
  /**
   * The daily brief on demand (src/brief.ts), for BRIEF. `daily`: whether it also comes by itself every morning (MORNING_BRIEF is
   * not off), for HELP's line.
   */
  brief?: { now: () => Promise<string>; daily: boolean };
  /** The owner's Zoom, read only (src/zoom.ts): the coming meetings, the latest summaries, and the Mac's summary of a transcript to keep. */
  zoom?: { upcoming: () => Promise<string[]>; summaries: () => Promise<string[]>; annotate: (id: string, summary: string) => Promise<boolean> };
  /** The owner's Slack, read only (src/slack.ts): its search, and the alerts of the last day. */
  slack?: { search: (query: string) => Promise<string[]>; recent: () => Promise<string[]> };
  /**
   * "Sign in again" pressed on the notice that Claude needs a new sign-in (src/claude-connect.ts): starts Claude's own sign-in on the computer
   * and says what happens next. Absent on a server.
   */
  claudeSignIn?: () => Promise<string>;
  /** Follow-ups (src/followups.ts): its buttons, PENDING, the assistant's context lines, the bridge's extraction answers; absent when off. */
  followups?: FollowupsDoor;
  /**
   * A draft for one follow-up (src/brief-v2.ts draftFor): the isolated run that writes the message the owner sends to close it, told in the
   * chat when it is written. Absent when the written brief is off.
   */
  /**
   * This Mac's calendar, written by its app (src/calendar-writes.ts): whether it can be now (a recent push from an app that writes), the event a
   * change means, and the queue the owner's yes goes into. Absent without this Mac's calendars.
   */
  calendarWrites?: {
    canWrite: () => Promise<boolean>;
    find: (title: string, start: number) => Promise<{ eventId: string; at: number; start: number; end: number; title: string; calendarId: string } | null>;
    enqueue: (w: Omit<CalendarWrite, "status" | "queuedAt">) => Promise<boolean>;
    get: (id: string) => Promise<CalendarWrite | null>;
  };
  draftFor?: (o: { title: string; facts: { label: string; text: string; at?: number }[]; mailRef?: string }) => Promise<{ status: string } | null>;
  /** A mailbox's catch-up (src/backfill.ts): each verdict on its mail, for its "Caught up" line. */
  backfillAnswered?: (id: string, o: { worth: boolean; replied: boolean }) => Promise<boolean>;
  /** Proactive Pako (src/proactive.ts): the facts a reply learnt, its buttons, topics in plain words, the context lines, the bridge's answers. */
  life?: LifeDoor;
  /** Zoom meetings reviewed (src/meeting-review.ts): the bridge's answers, MEETING TODOS; absent when Zoom or the review is off. */
  reviews?: ReviewDoor;
  /** Today's written brief's to-dos not ticked yet (src/brief-v2.ts openTodos), for the assistant's context; absent when that brief is off. */
  briefTodos?: () => Promise<string[]>;
  /** The written brief's jobs (src/brief-v2.ts): the bridge's answers, and the acknowledgements of an older bridge that let one go unread. */
  briefJobs?: { result: (id: string, raw: string) => Promise<{ ok: boolean }>; acked: (ids: string[], capable: boolean) => Promise<void> };
  /**
   * Quality (src/quality.ts): a 👍/👎 pressed (null: not one of its buttons), a typed yes or no as the answer to the last card or brief that
   * asked (null: not one, and the message goes on), and the question forgotten when anything else is sent.
   */
  quality?: { press: (buttonId: string) => Promise<string | null>; answerText: (text: string) => Promise<string | null>; clearAsk: () => void };
  /** The rehearsal (src/rehearsal.ts): REHEARSAL, the bridge's answers to its jobs (rh:, rb:), and those an older bridge let go unread. */
  rehearsal?: {
    start: () => Promise<{ text: string }>;
    answer: (id: string, raw: string) => Promise<{ ok: boolean }>;
    acked: (ids: string[]) => Promise<void>;
  };
  /**
   * HEALTH, or "how is Pako doing?" (src/intents.ts): the panel's Health card in words (src/watchdog.ts summary) and the Quality card's week
   * (src/quality.ts weekText), one block each; the door adds REHEARSAL's hint when the rehearsal is on.
   */
  status?: { summary: () => Promise<string[]> };
  /**
   * The assistant's own email inbox (src/mail.ts), when it has one: its address, the latest emails one line each, what the Mac made of one
   * (its summary, and whether the owner was told), and the last day of mail for the owner's MAIL command.
   */
  mail?: {
    address: string;
    recent: () => Promise<string[]>;
    /**
     * `scam`: whether Claude took the email for a scam; undefined when the bridge did not say (an older one). `verdict`: the triage's
     * category and lines (src/mail-categories.ts), from a bridge that gives them.
     */
    annotate?: (id: string, kind: "aviso" | "guardado", summary: string, scam?: boolean, verdict?: Verdict) => Promise<boolean>;
    /** The owner already replied to this email (a mailbox's catch-up saw their answer): it leaves the dashboard's preview. */
    replied?: (id: string) => Promise<unknown>;
    /** Whether this email is told to the owner now (its category and the owner's switches; a VIP always). */
    notifies?: (id: string) => Promise<boolean>;
    /** The email as kept (its sender and time, for the loops it makes). */
    get?: (id: string) => Promise<{ from: string; at: number; subject: string } | null>;
    digest?: () => Promise<string>;
  };
  /**
   * The one-time codes found in the owner's mail in the last 30 minutes (src/codes.ts), newest first: hidden everywhere else, shown only when
   * the owner writes CODE.
   */
  codes?: { recent: () => Promise<{ at: number; from: string; codes: string[] }[]> };
  /** The owner's lists and tasks (src/lists.ts); absent, kept in `kv` like the reminders. */
  lists?: ListStore;
  /** The people in the owner's life (src/people.ts); absent, kept in `kv` like the lists. */
  people?: PeopleStore;
  /** Dated facts (src/memory-facts.ts) and people with identities (src/people-graph.ts); absent, kept in `kv` like the people. */
  facts?: FactStore;
  peopleGraph?: PeopleGraph;
  /** The friend, health companion and teacher (src/companion.ts); absent, made here and kept in `kv`. */
  companion?: Companion;
  /** The owner's country (PAKO_COUNTRY, src/health.ts), for the emergency number a red flag gives; ES when absent. */
  country?: string;
  /**
   * Whether the health diary is written to `kv` (default true). src/app.ts passes false for a server on the internet: health data stays on
   * the owner's own computer, so a hosted server keeps the diary in memory only.
   */
  healthOnDisk?: boolean;
  /** Labs (PAKO_LABS=on, src/app.ts): the health diary, learning and the weekly check-in (src/companion.ts). Default on. */
  labs?: boolean;
  /** What the watches look at (src/routines.ts): the mail, the calendar and Slack the server already has; read each time. */
  watchSources?: () => WatchSources;
  /** How long a routine's claim waits before it reads itself back (default 1.5 s; the tests use a few milliseconds). */
  routineClaimMs?: number;
  /**
   * The durable jobs (src/jobs.ts): when given, its runner is the clock (no timer of the door's own), each reminder sent is a slot that a
   * restart never sends twice, and on a computer one due while it slept comes late with a note (or, over 12 hours late, is told as missed).
   */
  jobs?: Pick<Jobs, "slot" | "slept">;
  /** Where the photos and PDFs the owner sends are kept until read (src/papers.ts): ~/.pako/papers on a computer; absent, memory only. */
  papers?: PaperStore;
  /**
   * The watchdog (src/watchdog.ts): how each send to Meta went. A refusal that says WhatsApp itself is not working for this server (the
   * token refused, Meta down or limiting, no answer) counts; one about a single message (its 24 hours, a number) does not.
   */
  health?: HealthReport;
}

/**
 * A friend call the connector asked for (the call_contact tool, src/personal-caller.ts). The owner gets a card of its own, and nothing rings
 * unless they press Call on it. The card's text is the server's, written from the request: who would be called and every word the call
 * would use. `place` places exactly that call (the contact list, quiet hours, caps and STOP are checked again then) and runs at most once.
 */
export interface OwnerAsk {
  name: string;
  card: string;
  /**
   * Places at most one call. `unknown`: the phone service did not answer clearly, so the call may or may not have gone out (it is not tried
   * again). `wait`: too soon after another friend call; nothing was used up, and it can run again after that many seconds. `gap`: the same,
   * but the wait is longer than a card lasts, so it is over (ask again after that many seconds).
   */
  place: () => Promise<{ ok: boolean; text: string; unknown?: boolean; wait?: number; gap?: number }>;
  /**
   * The card stopped counting with no call: the owner said no, a newer request took its place, STOP, it was pressed too late, or it could not
   * be shown again after a wait.
   */
  closed: (why: "cancelled" | "replaced" | "stopped" | "expired" | "unshown") => void;
}
/** Whether the card reached the owner, and where; or why not. Both are for the connector, in English like its other answers. */
export type AskResult = { ok: true; where: string } | { ok: false; why: string };

/**
 * Where the owner wrote, and so where Pako answers: the door's own chat (WhatsApp, or the panel's chat in local mode), Telegram, or, on a
 * computer, the owner's WhatsApp set up in the panel ("whatsapp", src/whatsapp-computer.ts).
 */
export type OwnerChannel = "base" | "telegram" | "whatsapp";

/** The owner's WhatsApp on a computer (src/whatsapp-computer.ts): it sends the door's Meta-format bodies while Meta lets it (24 hours). */
export interface WhatsappLine {
  /** Set up, and the owner wrote on WhatsApp less than 24 hours ago (WhatsApp's window), so a message can reach them there. */
  reachable(): Promise<boolean>;
  deliver(body: Record<string, unknown>): Promise<boolean>;
}

/**
 * Telegram as a second chat beside the door's own (src/telegram.ts): it sends the door's Meta-format bodies (text and button cards) to the
 * owner's Telegram chat, and gives the voice notes it queued under a short id (TELEGRAM_MEDIA_ID).
 */
export interface TelegramDoor {
  /** The owner's Telegram chat is known (paired, or TELEGRAM_OWNER_ID and a first message). */
  paired(): Promise<boolean>;
  /** Paired, and Telegram has not said the chat cannot be reached (a blocked bot) since the owner last wrote there. */
  reachable(): Promise<boolean>;
  deliver(body: Record<string, unknown>): Promise<boolean>;
  /** A one-time link that pairs the Telegram account that opens it; null when it cannot be made now. */
  pairLink(): Promise<string | null>;
  /** Forgets the paired account and any pending link; false when the store did not take it (it is forgotten here anyway). */
  unpair(): Promise<boolean>;
  /** One last line to the account that was just unpaired. */
  farewell(text: string): Promise<void>;
  media(id: string): Promise<{ bytes: Buffer; mime: string } | null>;
}
/** The ids of messages that came from Telegram start with this: a reply to one goes back there. */
export const TELEGRAM_ID_PREFIX = "tg-";
/** The short id a Telegram voice note is queued under (Telegram's own file ids are longer than the door takes). */
export const TELEGRAM_MEDIA_ID = /^tg_[0-9a-f]{16}$/;
