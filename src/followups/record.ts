// Reading what is stored: the record under FOLLOWUPS_KEY (src/followups/store.ts), every part checked field by field, and the small readers
// the bridge's answer is read with too.

import { randomBytes } from "node:crypto";
import {
  BATCH_MSGS_MAX, BATCHES_MAX, DETAIL_MAX, JOBS_MAX, LOOPS_MAX, MAIL_BATCH_MAX, MAIL_BATCHES_MAX, MAIL_READ_MAX, RULES_MAX, TITLE_MAX, WHO_MAX,
} from "./limits.ts";
import { chaseOf } from "./chase.ts";
import { isZone } from "./time.ts";
import { MAIL_BODY_MAX, MAIL_THREAD } from "../mail-body.ts";
import {
  LOOP_KINDS, type Batch, type BatchClaim, type BatchMsg, type Check, type FollowupsState, type Job, type LearnedRule, type Loop, type LoopKind, type LoopSource,
  type MailBatch, type MailSeen, type ParkedExpired, type Where,
} from "./types.ts";

export const HEX10 = /^[0-9a-f]{10}$/;
export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
export const strs = (v: unknown, n: number, max: number): string[] =>
  (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string" && !!x.trim()).slice(0, n).map((x) => x.slice(0, max));
export const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
export const TS = /^\d{1,12}(?:\.\d{1,8})?$/;
export const CHANNEL = /^[CDG][A-Z0-9]{2,30}$/;

export const whereOf = (v: unknown): Where | null => {
  if (!isObject(v)) return null;
  const type = v.type;
  if (type !== "slack_dm" && type !== "slack_channel" && type !== "zoom_meeting" && type !== "mail" && type !== "chat") return null;
  const channel = typeof v.channel === "string" && CHANNEL.test(v.channel) ? v.channel : undefined;
  const thread = channel && typeof v.thread === "string" && TS.test(v.thread) ? v.thread : undefined;
  const mailThread = type === "mail" && typeof v.mailThread === "string" && MAIL_THREAD.test(v.mailThread) ? v.mailThread : undefined;
  return { type, label: str(v.label, 120), ...(channel ? { channel } : {}), ...(thread ? { thread } : {}), ...(mailThread ? { mailThread } : {}) };
};

export const threadOf = (v: unknown): { thread?: string } => (typeof v === "string" && TS.test(v) ? { thread: v } : {});
const checkOf = (v: unknown): Check | null => {
  if (!isObject(v)) return null;
  if (isObject(v.zoomMeeting)) {
    const around = num(v.zoomMeeting.around);
    return { zoomMeeting: { ...(around ? { around } : {}), attendeesHints: strs(v.zoomMeeting.attendeesHints, 6, 60) } };
  }
  if (isObject(v.calendarEvent)) {
    const around = num(v.calendarEvent.around);
    return { calendarEvent: { ...(around ? { around } : {}), hints: strs(v.calendarEvent.hints, 6, 60) } };
  }
  if (isObject(v.slackReply) && typeof v.slackReply.channel === "string" && CHANNEL.test(v.slackReply.channel) && TS.test(String(v.slackReply.afterTs))) {
    return { slackReply: { channel: v.slackReply.channel, afterTs: String(v.slackReply.afterTs), ...threadOf(v.slackReply.thread), ...(v.slackReply.file === true ? { file: true as const } : {}) } };
  }
  if (isObject(v.slackPost) && typeof v.slackPost.channel === "string" && CHANNEL.test(v.slackPost.channel) && TS.test(String(v.slackPost.afterTs))) {
    const contains = strs(v.slackPost.contains, 3, 40);
    return { slackPost: { channel: v.slackPost.channel, afterTs: String(v.slackPost.afterTs), contains, ...threadOf(v.slackPost.thread) } };
  }
  if (isObject(v.none)) return { none: { reason: str(v.none.reason, 100) } };
  return null;
};

const sourceOf = (v: unknown): LoopSource | null =>
  isObject(v) && (v.kind === "slack" || v.kind === "mail" || v.kind === "meeting" || v.kind === "chat") && typeof v.at === "number"
    ? { kind: v.kind, label: str(v.label, 120), at: v.at, ...(typeof v.ref === "string" ? { ref: v.ref.slice(0, 200) } : {}) }
    : null;

/** One stored loop, checked; null when it is not one. */
export function loopOf(v: unknown): Loop | null {
  if (!isObject(v) || typeof v.id !== "string" || !HEX10.test(v.id) || !(LOOP_KINDS as readonly unknown[]).includes(v.kind)) return null;
  const where = whereOf(v.where);
  const check = checkOf(v.check);
  const status = v.status;
  if (!where || !check || (status !== "open" && status !== "done" && status !== "dismissed" && status !== "snoozed" && status !== "parked")) return null;
  if (typeof v.title !== "string" || !v.title || typeof v.whenSaid !== "number" || typeof v.createdAt !== "number") return null;
  const dueAt = num(v.dueAt);
  const tz = typeof v.tz === "string" && isZone(v.tz) ? v.tz : undefined;
  return {
    id: v.id,
    kind: v.kind as LoopKind,
    title: v.title.slice(0, TITLE_MAX),
    detail: str(v.detail, DETAIL_MAX),
    who: str(v.who, WHO_MAX),
    where,
    whenSaid: v.whenSaid,
    ...(dueAt ? { dueAt } : {}),
    ...(tz ? { tz } : {}),
    check,
    ...(num(v.effort) && num(v.effort)! >= 5 && num(v.effort)! <= 480 ? { effort: Math.round(num(v.effort)!) } : {}),
    status,
    nextCheckAt: num(v.nextCheckAt) ?? 0,
    nudges: num(v.nudges) ?? 0,
    ...(v.escalated === true ? { escalated: true } : {}),
    ...(typeof v.lastCheck === "string" ? { lastCheck: v.lastCheck.slice(0, 200) } : {}),
    ...(num(v.checkedAt) ? { checkedAt: num(v.checkedAt)! } : {}),
    createdAt: v.createdAt,
    ...(num(v.closedAt) ? { closedAt: num(v.closedAt)! } : {}),
    ...(isObject(v.autoClosed) && num(v.autoClosed.at) && typeof v.autoClosed.why === "string"
      ? { autoClosed: { at: num(v.autoClosed.at)!, why: v.autoClosed.why.slice(0, 160) } } : {}),
    ...(v.reopened === true ? { reopened: true as const } : {}),
    sources: (Array.isArray(v.sources) ? v.sources : []).map(sourceOf).filter((x): x is LoopSource => x !== null).slice(0, 5),
    // Gentle mode's own fields (src/gentle.ts): small counters and one checked line.
    ...(num(v.parkedAt) ? { parkedAt: num(v.parkedAt)! } : {}),
    ...(num(v.snoozes) ? { snoozes: Math.min(99, num(v.snoozes)!) } : {}),
    ...(num(v.unanswered) ? { unanswered: Math.min(99, num(v.unanswered)!) } : {}),
    ...(num(v.variant) !== undefined ? { variant: Math.max(0, Math.min(20, Math.floor(num(v.variant)!))) } : {}),
    ...(v.folded === true ? { folded: true } : {}),
    ...(v.afterAsked === true ? { afterAsked: true } : {}),
    ...(num(v.agedAt) ? { agedAt: num(v.agedAt)! } : {}),
    ...(typeof v.step === "string" && v.step.trim() ? { step: v.step.slice(0, 160) } : {}),
    // Its chases (src/followups/chase.ts): when, the drafts and where they go.
    ...(chaseOf(v.chase) ? { chase: chaseOf(v.chase)! } : {}),
  };
}

/** One stored job, checked; null when it is not one (src/rehearsal.ts reads its own back with it). */
export const jobOf = (v: unknown): Job | null => {
  if (!isObject(v) || typeof v.id !== "string" || !HEX10.test(v.id) || typeof v.at !== "number" || typeof v.whenSaid !== "number") return null;
  if (v.source !== "slack" && v.source !== "mail" && v.source !== "meeting") return null;
  const where = whereOf(v.where);
  if (!where) return null;
  const afterTs = typeof v.afterTs === "string" && TS.test(v.afterTs) ? v.afterTs : undefined;
  return {
    id: v.id, at: v.at, source: v.source, where, whenSaid: v.whenSaid, label: str(v.label, 120),
    ...(afterTs ? { afterTs } : {}), ...(typeof v.ref === "string" ? { ref: v.ref.slice(0, 200) } : {}), ...(v.closed === true ? { closed: true } : {}),
  };
};

const batchOf = (v: unknown): Batch | null => {
  if (!isObject(v) || typeof v.channel !== "string" || !CHANNEL.test(v.channel) || typeof v.firstAt !== "number") return null;
  const where = whereOf(v.where);
  if (!where) return null;
  const msgs = (Array.isArray(v.msgs) ? v.msgs : []).flatMap((m): BatchMsg[] =>
    isObject(m) && typeof m.ts === "string" && TS.test(m.ts) && typeof m.at === "number" && typeof m.text === "string"
      ? [{ ts: m.ts, at: m.at, who: str(m.who, WHO_MAX), text: m.text.slice(0, 600), ...(m.mine === true ? { mine: true } : {}) }]
      : []);
  return msgs.length ? { channel: v.channel, ...threadOf(v.thread), where, firstAt: v.firstAt, msgs: msgs.slice(-BATCH_MSGS_MAX), ...claimOf(v.claim) } : null;
};

/** A batch's job on its way (BatchClaim), checked. */
const claimOf = (v: unknown): { claim?: BatchClaim } =>
  isObject(v) && typeof v.id === "string" && HEX10.test(v.id) && Array.isArray(v.keys)
    ? { claim: { id: v.id, keys: v.keys.filter((k): k is string => typeof k === "string").slice(0, 50).map((k) => k.slice(0, 200)) } }
    : {};

/** One email waiting in a batch, checked; its words cut to what the reading takes. */
const mailSeenOf = (v: unknown): MailSeen | null =>
  isObject(v) && typeof v.ref === "string" && v.ref && typeof v.thread === "string" && MAIL_THREAD.test(v.thread) && typeof v.at === "number"
    && typeof v.body === "string"
    ? {
        ref: v.ref.slice(0, 200), thread: v.thread, at: v.at, from: str(v.from, 200), to: str(v.to, 200), cc: str(v.cc, 200), subject: str(v.subject, 300),
        body: v.body.slice(0, MAIL_BODY_MAX), ...(v.mine === true ? { mine: true } : {}), ...(v.closed === true ? { closed: true } : {}),
      }
    : null;

const mailBatchOf = (v: unknown): MailBatch | null => {
  if (!isObject(v) || typeof v.thread !== "string" || !MAIL_THREAD.test(v.thread) || typeof v.firstAt !== "number") return null;
  const where = whereOf(v.where);
  const mails = (Array.isArray(v.mails) ? v.mails : []).map(mailSeenOf).filter((x): x is MailSeen => x !== null && x.thread === v.thread);
  return where && mails.length ? { thread: v.thread, where, firstAt: v.firstAt, mails: mails.slice(-MAIL_BATCH_MAX), ...claimOf(v.claim) } : null;
};

/** Notes of parked loops let go after 45 days, kept at most (and 90 days: src/followups/store.ts). */
export const EXPIRED_MAX = 50;

/** The stored record, every part checked (what the brief and the Zoom review read from FOLLOWUPS_KEY). */
export function stateOf(raw: unknown): FollowupsState {
  const o = isObject(raw) ? raw : {};
  const rules = (Array.isArray(o.rules) ? o.rules : []).flatMap((r): LearnedRule[] =>
    isObject(r) && typeof r.at === "number" ? [{ at: r.at, who: str(r.who, WHO_MAX), where: str(r.where, 120), title: str(r.title, TITLE_MAX) }] : []);
  const b = isObject(o.budget) ? o.budget : {};
  const mb = isObject(o.mailBudget) ? o.mailBudget : {};
  const expired = (Array.isArray(o.expired) ? o.expired : []).flatMap((x): ParkedExpired[] =>
    isObject(x) && typeof x.title === "string" && typeof x.at === "number"
      ? [{ title: str(x.title, TITLE_MAX), who: str(x.who, WHO_MAX), parkedAt: num(x.parkedAt) ?? 0, at: x.at }] : []).slice(-EXPIRED_MAX);
  return {
    ...(expired.length ? { expired } : {}),
    loops: (Array.isArray(o.loops) ? o.loops : []).map(loopOf).filter((x): x is Loop => x !== null).slice(-LOOPS_MAX),
    rules: rules.slice(-RULES_MAX),
    jobs: (Array.isArray(o.jobs) ? o.jobs : []).map(jobOf).filter((x): x is Job => x !== null).slice(-JOBS_MAX),
    batches: (Array.isArray(o.batches) ? o.batches : []).map(batchOf).filter((x): x is Batch => x !== null).slice(-BATCHES_MAX),
    budget: { day: str(b.day, 10), n: num(b.n) ?? 0 },
    mailBatches: (Array.isArray(o.mailBatches) ? o.mailBatches : []).map(mailBatchOf).filter((x): x is MailBatch => x !== null).slice(-MAIL_BATCHES_MAX),
    mailRead: strs(o.mailRead, MAIL_READ_MAX * 2, 200).slice(-MAIL_READ_MAX),
    mailBudget: { day: str(mb.day, 10), n: num(mb.n) ?? 0 },
  };
}

/** The open loops of a stored value (FOLLOWUPS_KEY), newest first. */
export const loopsOf = (raw: unknown): Loop[] =>
  stateOf(raw).loops.filter((l) => l.status === "open" || l.status === "snoozed").sort((a, b) => b.whenSaid - a.whenSaid);

export const newId = (): string => randomBytes(5).toString("hex");
export const isOpen = (l: Loop): boolean => l.status === "open" || l.status === "snoozed";
