// What the server's inbox passes on besides the owner's words (an email, a meeting, a paper, the background jobs), read and bounded here.

import { paperName, PAPER_ID } from "../../src/papers.ts";
import { NOTIFY_DEFAULTS, readVerdict, shouldNotify, type Verdict } from "../../src/mail-categories.ts";
import { parseReply } from "./reply.ts";

/** A photo or a PDF the owner sent (src/papers.ts), as the server passes it on: the file is fetched by its id. */
export interface Paper {
  id: string;
  name: string;
  /** The words sent with it: the owner's own, or (forwarded) someone else's. */
  caption: string;
}

export const paperOf = (m: { paper?: unknown }): Paper | undefined => {
  const p = m.paper as { id?: unknown; name?: unknown; caption?: unknown } | undefined;
  if (!p || typeof p.id !== "string" || !PAPER_ID.test(p.id)) return undefined;
  // The name is someone else's, cleaned again here whatever server sent it: it heads the owner's answer and sits in the run's fence.
  return { id: p.id, name: paperName(p.name), caption: typeof p.caption === "string" ? p.caption.slice(0, 4000) : "" };
};

/** An email that arrived in the assistant's inbox, as the server passes it on. */
export interface Email {
  from: string;
  subject: string;
  text: string;
  attachments: string[];
  /** Forwarded from the owner's work address, a personal one, or written straight to the assistant. */
  account?: "trabajo" | "personal" | "directo";
  /** A sender the owner always wants to hear about at once. */
  vip?: boolean;
  /** Mail that was already there when the mailbox was connected: summarized and kept, never told (src/door/inbox.ts). */
  quiet?: boolean;
  /** The owner already replied to it (a catch-up): its follow-ups are made closed. */
  replied?: boolean;
}

/** A Zoom meeting's transcript, as the server passes it on. */
export interface Meeting {
  topic: string;
  when: string;
  transcript: string;
}

/** A follow-ups extraction job (src/followups.ts), as the server passes it on: other people's words, read in an isolated run. */
export interface FollowupJob {
  source: "slack" | "mail" | "meeting";
  label: string;
  text: string;
}
export const followupOf = (m: { followup?: unknown }): FollowupJob | undefined => {
  const j = m.followup as Partial<Record<keyof FollowupJob, unknown>> | undefined;
  if (!j || typeof j.text !== "string" || !j.text.trim()) return undefined;
  const source = j.source === "mail" || j.source === "meeting" ? j.source : "slack";
  return { source, label: typeof j.label === "string" ? j.label.replace(/\s+/g, " ").slice(0, 120) : "", text: j.text.slice(0, 16_000) };
};

/** A proactive check (src/proactive.ts), as the server passes it on: what Pako knows of the owner's day, read in an isolated run. */
export interface ProactiveJob {
  text: string;
}
export const proactiveOf = (m: { proactive?: unknown }): ProactiveJob | undefined => {
  const j = m.proactive as { text?: unknown } | undefined;
  return j && typeof j.text === "string" && j.text.trim() ? { text: j.text.slice(0, 16_000) } : undefined;
};

/** A judge job (src/memory-facts.ts): two dated facts that may contradict, read in an isolated run that answers strict JSON. */
export interface JudgeJob {
  text: string;
}
export const judgeOf = (m: { judge?: unknown }): JudgeJob | undefined => {
  const j = m.judge as { text?: unknown } | undefined;
  return j && typeof j.text === "string" && j.text.trim() ? { text: j.text.slice(0, 4000) } : undefined;
};

/** A meeting's review (src/meeting-review.ts), as the server passes it on: Zoom's summary, or (beside `meeting`) a transcript to review. */
export interface Review {
  source: "summary" | "transcript";
  topic: string;
  when: string;
  /** The server's own lines: now, when the meeting started, who the owner is. */
  head: string;
  text: string;
}
export const reviewOf = (m: { review?: unknown; meeting?: unknown }): Review | undefined => {
  const r = m.review as Partial<Record<keyof Review, unknown>> | undefined;
  if (!r || typeof r !== "object") return undefined;
  const line = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");
  const head = typeof r.head === "string" ? r.head.slice(0, 1000) : "";
  if (r.source === "summary" && typeof r.text === "string" && r.text.trim()) {
    return { source: "summary", topic: line(r.topic, 200), when: line(r.when, 40), head, text: r.text.slice(0, 16_000) };
  }
  const meeting = meetingOf(m);
  if (r.source === "transcript" && meeting) return { source: "transcript", topic: meeting.topic, when: meeting.when, head, text: meeting.transcript };
  return undefined;
};

/** A written-brief job (src/brief-v2.ts): the day's facts, prepared and neutralised by the server; `kind` brief answers JSON, do and prep text. */
export interface BriefJob {
  kind: "brief" | "do" | "prep";
  label: string;
  text: string;
  /** A "do" that is a draft for one follow-up (a reply, an email): run as a "draft", on the writing model. An older server never says it. */
  draft?: true;
}
export const briefOf = (m: { brief?: unknown }): BriefJob | undefined => {
  const j = m.brief as Partial<Record<keyof BriefJob, unknown>> | undefined;
  if (!j || typeof j.text !== "string" || !j.text.trim()) return undefined;
  const kind = j.kind === "do" || j.kind === "prep" ? j.kind : "brief";
  const label = typeof j.label === "string" ? j.label.replace(/\s+/g, " ").slice(0, 160) : "";
  return { kind, label, text: j.text.slice(0, 32_000), ...(kind === "do" && j.draft === true ? { draft: true as const } : {}) };
};

/** A missing topic stays empty here: it is written in the owner's language when the meeting is handled. */
export const meetingOf = (m: { meeting?: unknown }): Meeting | undefined => {
  const e = m.meeting as Partial<Record<keyof Meeting, unknown>> | undefined;
  if (!e || typeof e.transcript !== "string" || !e.transcript.trim()) return undefined;
  const line = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");
  return { topic: line(e.topic, 200), when: line(e.when, 40), transcript: e.transcript.slice(0, 60_000) };
};

/**
 * Claude's answer for an email (EMAIL_PROMPT): its category with the why, the ask and the loop lines (src/mail-categories.ts readVerdict), the
 * summary, and for a server from before categories whether to tell the owner and whether it took it for a scam. `notify` is the default
 * switches' answer: the server's own answer (the owner's switches) wins when it gives one. No category line: told, rather than lost.
 */
export function parseEmailVerdict(raw: string): { notify: boolean; summary: string; scam: boolean; verdict?: Verdict } {
  const text = parseReply(raw).text;
  const read = readVerdict(text);
  if (!read) return { notify: true, summary: text, scam: false };
  const { verdict, rest } = read;
  return { notify: shouldNotify(verdict, NOTIFY_DEFAULTS), summary: rest, scam: verdict.category === "suspicious", verdict };
}

/** A blank sender stays empty here: it is written in the owner's language when the email is handled. */
export const emailOf = (m: { email?: unknown }): Email | undefined => {
  const e = m.email as Partial<Record<keyof Email, unknown>> | undefined;
  if (!e || typeof e.from !== "string" || typeof e.text !== "string") return undefined;
  const line = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");
  return {
    from: line(e.from, 200),
    subject: line(e.subject, 300),
    text: e.text.slice(0, 12_000),
    attachments: (Array.isArray(e.attachments) ? e.attachments : []).map((a) => line(a, 120)).filter(Boolean).slice(0, 10),
    ...(e.account === "trabajo" || e.account === "personal" || e.account === "directo" ? { account: e.account } : {}),
    ...(e.vip === true ? { vip: true } : {}),
    ...(e.quiet === true ? { quiet: true } : {}),
    ...(e.replied === true ? { replied: true } : {}),
  };
};
