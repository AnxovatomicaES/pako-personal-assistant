// The follow-ups' shapes: a loop and where it was said, how it is checked, the stored record, the configuration, what the engine is given
// (FollowupsDeps), what it reads from Slack, Zoom and the calendar, and what the door and the rehearsal get back.

import type { Control } from "../control.ts";
import type { Lang } from "../i18n.ts";
import type { Kv } from "../kv.ts";
import type { LessonsPort } from "../lessons.ts";
import type { PersonBlock } from "../person-context.ts";
import type { Inbound } from "../whatsapp.ts";

export const LOOP_KINDS = ["request_to_owner", "owner_promise", "other_promise", "agreed_meeting", "deadline"] as const;
export type LoopKind = (typeof LOOP_KINDS)[number];
/** "parked" (gentle mode, src/gentle.ts): set aside by the owner: no nudges, never shown as open, kept in the Parked list until brought back. */
export type LoopStatus = "open" | "done" | "dismissed" | "snoozed" | "parked";
export type SourceKind = "slack" | "mail" | "meeting" | "chat";

/** Where it was said: a Slack DM or channel (with the channel's id, to look at it again), a Zoom meeting, an email. */
export interface Where {
  type: "slack_dm" | "slack_channel" | "zoom_meeting" | "mail" | "chat";
  /** As the owner reads it: "Rohan (private)", "Stan in #sales", "“Weekly sync”", "email". */
  label: string;
  channel?: string;
  /** The Slack thread it was said in (its parent's ts), when it was in one. */
  thread?: string;
  /** The email thread it was said in (src/mail-body.ts mailThreadKey): a later email of that thread can close it. */
  mailThread?: string;
}

/** How the server sees that it was done. `around`: the time it is for (ms), when one was said. */
export type Check =
  | { zoomMeeting: { around?: number; attendeesHints: string[] } }
  | { calendarEvent: { around?: number; hints: string[] } }
  | { slackReply: { channel: string; afterTs: string; thread?: string } }
  | { slackPost: { channel: string; afterTs: string; contains: string[]; thread?: string } }
  | { none: { reason: string } };

export interface LoopSource {
  kind: SourceKind;
  /** Who and where, as the owner reads it ("Slack · Rohan (private)"). */
  label: string;
  at: number;
  /** The Slack message's ts, the email's or the meeting's id. */
  ref?: string;
}

export interface Loop {
  /** 10 lowercase hex characters: its buttons name it (f1:<id>). */
  id: string;
  kind: LoopKind;
  /** Imperative, in the owner's language: "Set up the meeting with samir@acmeco.example, Maya Chen and Stan". */
  title: string;
  detail: string;
  who: string;
  where: Where;
  whenSaid: number;
  dueAt?: number;
  /** The time zone the time was said in (America/New_York for "5:15 AM ET"). */
  tz?: string;
  check: Check;
  status: LoopStatus;
  /** When it is looked at next (ms); 0: no more automatic checks (it stays in PENDING and the brief until closed). */
  nextCheckAt: number;
  nudges: number;
  /** The nudge near the deadline was given. */
  escalated?: boolean;
  /** What the last check found, as the owner would read it ("I don't see it in your Zoom."; one stored before English-only texts stays as it was, read for display only). */
  lastCheck?: string;
  /** When that check ran (ms). */
  checkedAt?: number;
  createdAt: number;
  closedAt?: number;
  sources: LoopSource[];
  /** Gentle mode (src/gentle.ts): when it was parked; how often it was snoozed; nudges since the owner's last press; the last wording used. */
  parkedAt?: number;
  snoozes?: number;
  unanswered?: number;
  variant?: number;
  /** Gentle mode: two nudges went unanswered, so it is no longer nudged and the brief carries it instead. */
  folded?: boolean;
  /** Gentle mode: its one "did it happen?" after its time was asked. */
  afterAsked?: boolean;
  /** Gentle mode: its first tiny step (two minutes or less), written from its own facts and checked (src/gentle.ts parseStep). */
  step?: string;
}

/** What "Not mine" taught: this kind of thing, from this person and place, is not the owner's. */
export interface LearnedRule {
  at: number;
  who: string;
  where: string;
  title: string;
}

/** A job sent to the bridge, kept until its answer comes (or it is too old). */
export interface Job {
  id: string;
  at: number;
  source: SourceKind;
  where: Where;
  whenSaid: number;
  label: string;
  /** The newest Slack message the job covers: a reply after it is looked for. */
  afterTs?: string;
  ref?: string;
  /**
   * Already answered when it was found (the catch-up of a newly connected mailbox: the owner replied in the same thread later): its loops are
   * made closed, so they are known (the dashboard's past days) but never nag.
   */
  closed?: boolean;
}

export interface BatchMsg {
  ts: string;
  at: number;
  who: string;
  text: string;
  /** The owner's own message. */
  mine?: boolean;
}
/** A Slack conversation's new messages, gathered for a few minutes before they become one job. */
export interface Batch {
  channel: string;
  /** The thread's parent ts: a thread is a conversation of its own. */
  thread?: string;
  where: Where;
  firstAt: number;
  msgs: BatchMsg[];
}

/**
 * One email for the follow-ups' reading (src/mail-followups.ts): who, to whom, when, its subject and its words as cleaned (src/mail-body.ts
 * cleanMailBody, at most about 4,000 characters). `mine`: the owner sent it (their Sent folder). `closed`: the owner already answered it (a
 * catch-up). Its words wait in a batch only until the thread's job is queued.
 */
export interface MailSeen {
  /** The mailbox's id for it (an inbox email), or "sent:<hash>" for one the owner sent. */
  ref: string;
  thread: string;
  at: number;
  from: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
  mine?: boolean;
  closed?: boolean;
}
/** An email thread's new mail, gathered for a few minutes before it becomes one job. */
export interface MailBatch {
  thread: string;
  where: Where;
  firstAt: number;
  mails: MailSeen[];
}

/** A parked loop the store let go after PARKED_KEEP_MS (45 days): its note in the Parked list's history, kept 90 days. */
export interface ParkedExpired {
  title: string;
  who: string;
  parkedAt: number;
  at: number;
}

export interface FollowupsState {
  /** Parked loops the store let go after 45 days (their notes), written in the same change that drops them. */
  expired?: ParkedExpired[];
  loops: Loop[];
  rules: LearnedRule[];
  jobs: Job[];
  batches: Batch[];
  /** Email threads waiting to become jobs. */
  mailBatches: MailBatch[];
  /** The emails already read for follow-ups (their refs): none is ever sent to the model twice. */
  mailRead: string[];
  /** Email jobs queued on `day` (the owner's day): at most FollowupsConfig.mailPerDay. */
  mailBudget: { day: string; n: number };
  /** Nudges given on `day` (the owner's day, "YYYY-MM-DD"). */
  budget: { day: string; n: number };
}

export interface FollowupsConfig {
  delayMs: number;
  maxPerDay: number;
  batchMs: number;
  /** Minutes of the day [start, end) with no nudges (start > end crosses midnight); null = none. */
  quiet: { start: number; end: number } | null;
  /**
   * Email reading jobs a day (FOLLOWUP_MAIL_JOBS_PER_DAY, 40 by default; 0: the mail's own triage lines only, as before). A thread's mail
   * gathered into one job counts once.
   */
  mailPerDay?: number;
}

/** A Slack message kept for the owner (src/slack.ts observe). */
export interface SlackSeen {
  channel: string;
  ts: string;
  at: number;
  /** Who wrote it, by name. */
  who: string;
  /** "Rohan (private)", "Stan in #sales". */
  where: string;
  direct: boolean;
  text: string;
  /** The thread's parent ts, when it was said in a thread. */
  thread?: string;
  /** The owner wrote it: never told back to them, read only for what they promised (src/slack.ts). */
  mine?: boolean;
}
/** One message of a conversation, as Slack's history gives it (src/slack.ts history). */
export interface SlackLine {
  ts: string;
  at: number;
  mine: boolean;
  who: string;
  text: string;
}
/** A meeting on the owner's Zoom (src/zoom.ts scheduled). */
export interface ZoomSeen {
  topic: string;
  at: number;
  /** When it was set up (ms), when Zoom says. */
  createdAt?: number;
  /** A repeating meeting (a weekly standup). */
  recurring?: boolean;
}
/** An event on the owner's calendar, as a check reads it. */
export interface EventSeen {
  title: string;
  start: number;
  created?: number;
  recurring?: boolean;
}

export interface FollowupsDeps {
  config: FollowupsConfig;
  /** A draft can be written for a loop (DRAFT, src/brief-v2.ts draftFor): its reminders say so. */
  drafts?: boolean;
  kv: Kv | null;
  timeZone: string;
  now?: () => number;
  lang?: () => Lang;
  /** The owner's language as a code, for the extraction ("es", "en"...); the language of Pako's texts without it. */
  ownerLanguage?: () => Promise<string>;
  /** The owner's name ("" when not known): the run then tells a request to them from one to someone else in a channel. */
  ownerName?: () => string;
  control?: Control;
  /** The assistant inbox (src/whatsapp.ts inbox.add): where the extraction jobs go. */
  enqueue: (m: Inbound) => Promise<boolean>;
  /**
   * A card with buttons when the owner can be written to now (src/whatsapp.ts sendCard); false when it could not go. `feedback`: the quiet
   * 👍/👎, as buttons after the three where the chat has room for them, else as a line under the text.
   */
  card: (body: string, buttons: { id: string; title: string }[], feedback?: CardFeedback, more?: CardFeedback) => Promise<boolean>;
  /** What the quality card counts (src/quality.ts): each nudge given, each press on one, and the 👍/👎 a nudge carries. */
  quality?: FollowupsQuality;
  /** A notice kept for the owner's next message when the card cannot go (src/whatsapp.ts notifyOwner). */
  notify: (text: string) => Promise<unknown>;
  /** The owner's scheduled Zoom meetings; absent when Zoom is not connected. Throws when Zoom cannot be read now. */
  zoom?: () => Promise<ZoomSeen[]>;
  /** The calendar's events (src/calendar.ts load); absent when there is no calendar. */
  calendar?: () => Promise<EventSeen[]>;
  /** A Slack conversation's messages (a thread's, with `thread`), oldest first (src/slack.ts history); absent without Slack. */
  slackHistory?: (channel: string, o: { limit?: number; oldest?: string; thread?: string }) => Promise<SlackLine[]>;
  /**
   * The name a loop's "who" is kept under (src/people-graph.ts canon): the same person seen as "rohan@x.com", "Rohan S." or a Slack id is
   * one name, so their loops merge and read the same. Absent: as the extraction wrote it.
   */
  who?: (name: string) => string;
  /** What else Pako said on its own today (src/proactive.ts suggestions): the day's budget is shared. */
  othersToday?: () => Promise<number>;
  /** What Pako learned from the owner's corrections (src/lessons.ts): "Not mine" kept as a lesson, and the lessons each extraction reads. */
  lessons?: LessonsPort;
  /**
   * What the owner's memory says about the people of a job (src/person-context.ts many: names, Slack ids, addresses), at most three blocks:
   * who they are to the owner, what was last agreed, what is open with them. Absent: the job carries none.
   */
  people?: (words: string[]) => Promise<PersonBlock[]>;
  /**
   * Gentle mode (src/gentle.ts), asked before each round: null when it is off (everything as before). On: its day's cap, its words and
   * buttons (Done, Snooze, Park), and what similar meetings usually took.
   */
  gentle?: () => Promise<GentleRound | null>;
}

/** What a round of nudges reads of gentle mode. */
export interface GentleRound {
  maxPerDay: number;
  /** What similar meetings took, in minutes; null when fewer than three are known. */
  usually?: (title: string) => Promise<number | null>;
  /**
   * A check-in offered on a stuck one's nudge (src/gentle-checkins.ts): "Check on me in 30 min" as a fourth button where the chat has room,
   * else its line under the text. Absent: none offered.
   */
  checkin?: (loopId: string) => Promise<CardFeedback>;
}

/** The quiet 👍/👎 under a card: buttons where the chat has room for more than three, else a line answered by text. */
export interface CardFeedback {
  buttons: { id: string; title: string }[];
  line: string;
}

export interface FollowupsQuality {
  ask(loop: { id: string; title: string }, lg: Lang): CardFeedback;
  /** `sent`: the card went (a "yes"/"no" typed next can answer it); false: it was kept as a notice for later. */
  nudged(loop: { id: string; title: string }, sent: boolean): void;
  pressed(button: "1" | "2" | "3", loop: { id: string; title: string }): void;
}

/** What a rehearsal is made from: a Slack conversation's messages (no channel id: an older alert, read without its history), or a text. */
export type DraftInput =
  | { source: "slack"; channel: string; thread?: string; where: Where; msgs: { ts: string; at: number; who: string; text: string }[] }
  | { source: "mail" | "meeting"; ref: string; label: string; text: string; at?: number };

/** A loop a rehearsal's answer WOULD make, and what would become of it. */
export interface WouldBe {
  title: string;
  kind: LoopKind;
  who: string;
  /** Its time, as a nudge says it ("a las 17:00"); "" without one. */
  due: string;
  source: string;
  check: "zoomMeeting" | "calendarEvent" | "slackReply" | "slackPost" | "none";
  /** What the check found now: where it saw it done, or what a nudge would say was checked. */
  seen: string;
  /**
   * closed: seen done, closed silently; nudge: the card would go; later: someone else's promise, looked at near its time; replied: no card
   * (the owner answered there); silent: nothing a check can see and no time (kept for PENDING and the brief); past: its time has passed.
   */
  outcome: "closed" | "nudge" | "later" | "replied" | "silent" | "past";
  /** When it would first be looked at (ms; 0: never by itself). */
  checkAt: number;
  /** The nudge's words, as the card would say them. */
  text?: string;
  /** That time falls in the quiet hours: the card would wait for them to end. */
  quiet?: boolean;
}

export interface DryOutcome {
  items: WouldBe[];
  /** Open loops it would add to (said again, or moved), by title. */
  merged: string[];
  /** Open loops it would close, by title. */
  closes: string[];
  /** Candidates a "Not mine" rule would drop. */
  ruled: number;
}

/** What src/whatsapp.ts asks of the engine: the buttons, PENDING, the assistant's context, the bridge's answer, and mail and meetings. */
export interface FollowupsDoor {
  /** 1 Done, 2 In 1 h, 3 Not mine; gentle mode's 4 Snooze (asks when), 5 Later today, 6 Tomorrow, 7 Park. */
  press(button: PressButton, id: string): Promise<string>;
  command(): Promise<string>;
  context(): Promise<string[]>;
  result(jobId: string, raw: string): Promise<{ ok: boolean; added: number }>;
  /** `people`: who the text involves (names, addresses), for what the owner's memory says of them (src/person-context.ts). */
  offer(o: { source: "mail" | "meeting"; ref: string; label: string; text: string; at?: number; closed?: boolean; people?: string[] }): Promise<boolean>;
  /** The mail triage's loops for one email (src/followups/mail.ts); absent on an engine from before. */
  fromMail?(o: { ref: string; label: string; at: number; loops: unknown[]; closed?: boolean; thread?: string }): Promise<number>;
  /**
   * One email for the follow-ups to read whole (src/followups/mail-jobs.ts): added to its thread's batch (a few minutes, then one job). False
   * when it is not taken: read already, no words, or the day's email jobs are spent (the caller falls back to the triage's own lines).
   */
  observeMail?(m: MailSeen, label: string): Promise<boolean>;
  /** A new email from these people: what they owed the owner by mail is closed. */
  answered?(o: { who: string[]; ref: string }): Promise<number>;
  /**
   * The owner said in the chat that something is handled ("I sent Ana the deck"): the one open loop whose title and person hold all these
   * words is closed as done. None, or several, close nothing and say so. Absent on an engine from before.
   */
  closeByWords?(words: string[]): Promise<CloseOutcome>;
  /**
   * A promise the owner made in the chat with Pako ("I'll send Ana the deck by Friday"): kept as their own loop, with its person and time when
   * they said them. Null when it is not one (too short, a time far off), or it is already kept (the same thing open). Absent on an engine from before.
   */
  fromChat?(o: { title: string; who?: string; due?: string; ref?: string }): Promise<Loop | null>;
  /** Undo of fromChat: the loop goes again, unless something changed it since. */
  dropFromChat?(ids: string[]): Promise<string[]>;
  /**
   * The loop a DRAFT names: with words, the one open loop whose title and person hold them all; without, the one reminded of last (the
   * last day). Several or none: said, never guessed.
   */
  forDraft?(words: string): Promise<{ loop: Loop } | { none: true } | { many: string[] }>;
  /** What a draft for this loop is written from: the loop itself (who, what, where it was said, what Pako checked), as facts. */
  draftFacts?(l: Loop): { label: string; text: string; at?: number }[];
  /**
   * The calendar changed (src/calendar-changes.ts): an open loop due at a meeting that moved follows it; one that IS an agreed meeting that
   * was called off closes; any other tied to a meeting that is gone says so. Matched by its time (the meeting's old start) and a word of the
   * meeting's title or the person. The number of loops changed. Absent on an engine from before.
   */
  calendarChanged?(changes: { kind: "added" | "moved" | "cancelled"; title: string; start: number; was?: number }[]): Promise<number>;
  /** Undo of closeByWords: each loop back as it was before, unless something closed or changed it since. */
  reopenClosed?(loops: ClosedLoop[]): Promise<ClosedLoop[]>;
  /** Gentle mode's Snooze: the card that asks when (Later today, Tomorrow); null when the loop is gone or answered. */
  snoozeCard?(id: string): Promise<{ body: string; buttons: { id: string; title: string }[] } | null>;
  /** The parked loops, newest first (the panel's Parked list, and "what did I park?"). */
  parked?(): Promise<Loop[]>;
  /** "what did I park?" in the chat: the Parked list as text. */
  parkedText?(): Promise<string>;
  /** A parked loop back on the open list (by its id, or the words of its title or person): what to tell the owner. */
  unpark?(which: { id: string } | { words: string }): Promise<{ ok: boolean; say: string }>;
}

export type PressButton = "1" | "2" | "3" | "4" | "5" | "6" | "7";

/** A loop as it was just before the chat closed it: what an undo puts back. */
export interface ClosedLoop {
  id: string;
  title: string;
  status: LoopStatus;
  nextCheckAt: number;
}

/** What closing by words did: the loops closed, the words that matched none, and those that matched several (with their titles). */
export interface CloseOutcome {
  closed: ClosedLoop[];
  none: string[];
  many: { words: string; titles: string[] }[];
}
