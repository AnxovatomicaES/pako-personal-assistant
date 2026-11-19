// Every Zoom meeting reviewed. After a meeting the owner had (Zoom's AI Companion summary, or the cloud recording's transcript: src/zoom.ts),
// the assistant's computer reads it in an ISOLATED run (assistant/bridge.ts handleReview, REVIEW_PROMPT: no tools, no conversation, its own
// fence) and posts back strict JSON (POST /assistant/meeting-review): the owner's to-dos (who is waiting, by when, the words that show it),
// what others promised the owner, the decisions, the follow-up meetings agreed (with their time zone) and the open questions.
//
// - The server takes it field by field (texts neutralised and cut, times it can read, fixed check words, a few of each) and keeps it for the
//   panel's meeting view (GET /panel/api/meetings) and for MEETING TODOS: what is still open from the last 7 days.
// - The to-dos, the promises and the meetings become loops of the commitments engine (src/followups.ts ingest), checked later like any other.
// - The owner hears ONLY their own to-dos, in one short message, or nothing when there are none. That replaces Zoom's summary "as it is".
// - An older bridge cannot read a review: it lets the job go (its `text` is empty) and the owner gets Zoom's summary as before; a transcript
//   goes to it as before (the `meeting` field) and it summarizes and tells it itself. A review the computer never answers (it is off) is
//   given up after ZOOM_REVIEW_WAIT_MIN: Zoom's summary goes as before. A review never ACTS: it tells and keeps.

import type { Express, Request, RequestHandler } from "express";
import type { Control } from "./control.ts";
import { clean, zonedTime, zoneName, zoneOf, type Loop } from "./followups.ts";
import { locale, texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import { SUBJECT_MAX, VALUE_MAX, type FactInput } from "./memory-facts.ts";
import { instructsPako, stripPayloads } from "./brief-support.ts";
import { neutralise } from "./quarantine.ts";
import type { Inbound } from "./whatsapp.ts";
import { createLog } from "./log.ts";

const log = createLog("review");

type Env = Record<string, string | undefined>;

/** The store key: the reviews of the latest meetings (what the panel's meeting view and MEETING TODOS read). */
export const REVIEWS_KEY = "meeting-reviews";
const TTL_SECONDS = 30 * 24 * 3600;
const REVIEWS_MAX = 40;
const WEEK_MS = 7 * 24 * 3600_000;
const TODOS_MAX = 6;
const PROMISES_MAX = 5;
const DECISIONS_MAX = 5;
const MEETINGS_MAX = 3;
const QUESTIONS_MAX = 5;
const SUMMARY_MAX = 1500;
/** A loop that can be checked (a meeting to set up) is first looked at this long after the review, or an hour before its time if sooner. */
const CHECK_AFTER_MS = 2 * 3600_000;
/** Someone's promise with no time is asked about once, this long after the meeting. */
const PROMISE_AFTER_MS = 2 * 24 * 3600_000;

/** The inbox ids of a review: `review:<uuid>` for Zoom's summary; a transcript keeps its `zoom:<uuid>` (an older bridge summarizes it). */
/** How long a transcript's review may wait for the computer before it is told as not reviewed. */
const TRANSCRIPT_WAIT_MS = 24 * 3600_000;
export const reviewInboxId = (id: string): string => `review:${id}`;
export const reviewIdOf = (inboxId: string): string => inboxId.replace(/^(?:review|zoom):/, "").slice(0, 200);

export interface ReviewConfig {
  /** How long the assistant's computer has to answer before Zoom's summary goes as before. */
  waitMs: number;
}

/** Null when ZOOM_REVIEW=off (Zoom's summary goes as it is, as before). ZOOM_REVIEW_WAIT_MIN: 5-1440, default 120. */
export function loadReviewConfig(env: Env): { config: ReviewConfig | null; problems: string[] } {
  const problems: string[] = [];
  const flag = (env.ZOOM_REVIEW ?? "on").trim().toLowerCase();
  if (flag === "off") return { config: null, problems };
  if (flag !== "on" && flag !== "") problems.push("ZOOM_REVIEW must be on or off (on is used)");
  const raw = (env.ZOOM_REVIEW_WAIT_MIN ?? "").trim();
  let wait = 120;
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 5 && n <= 1440) wait = n;
    else problems.push("ZOOM_REVIEW_WAIT_MIN must be a whole number from 5 to 1440 (120 is used)");
  }
  return { config: { waitMs: wait * 60_000 }, problems };
}

/** One thing to do or promised, as the server keeps it. `due`: ms; `tz`: the zone it was said in, when not the owner's. */
export interface ReviewItem {
  title: string;
  who: string;
  due?: number;
  tz?: string;
  evidence: string;
  /** For a to-do: how a server could see it done. */
  check?: "zoomMeeting" | "calendarEvent" | "none";
  /** Names, emails or topic words (a meeting's people). */
  with?: string[];
  /** For a to-do or a promise checked by nothing: why ("email"). */
  reason?: string;
}

export interface ReviewFound {
  summary: string;
  todos: ReviewItem[];
  promises: ReviewItem[];
  decisions: string[];
  meetings: ReviewItem[];
  questions: string[];
}

export interface MeetingReview extends ReviewFound {
  /** Zoom's meeting UUID. */
  id: string;
  topic: string;
  at: number;
  source: "summary" | "transcript";
  /** pending: waiting for the computer; reviewed: its JSON was kept; fallback: told as before (an older bridge, no answer, an unreadable one). */
  status: "pending" | "reviewed" | "fallback";
  queuedAt: number;
  /** For Zoom's summary: the message as it went before, for the fallback. */
  notice?: string;
}

/** What goes in the inbox with a review: the server's own lines above the material (now, the meeting's time, the owner), and Zoom's summary. */
export interface InboundReview {
  source: "summary" | "transcript";
  topic: string;
  when: string;
  head: string;
  /** Zoom's summary; a transcript's text is the `meeting` field's. */
  text?: string;
}

const T = texts(
  {
    told: "🎥 From the meeting “{topic}” ({when}), on you:\n{list}",
    more: "(MEETING TODOS shows what is open from the week; the summary is in the panel.)",
    item: "• {title}{who}{due}",
    waits: " ({who} is waiting)",
    due: ", by {due}",
    failed: "🎥 Zoom · “{topic}” ({when})\n{summary}",
    noSummary: "I couldn't review the transcript; it's in Zoom.",
    head: "Meetings of the last 7 days, still open:",
    none: "Nothing open from your meetings of the last 7 days.",
    unread: "I couldn't read your meetings just now. Try again in a while.",
    meeting: "🎥 “{topic}” ({when})",
    todo: "• {title}{who}{due}",
    promise: "• {who} said they would: {title}{due}",
    agreed: "• Meeting agreed: {title}{due}",
    question: "• Open question: {text}",
    now: "Now: {now} ({tz})",
    started: "The meeting started: {at} ({tz})",
    owner: "The owner (YOU) is: {name}",
    ownerUnknown: "The owner is whoever has this Zoom account; their name is not given.",
    reasonMeeting: "said in the meeting",
    logReview: "Meeting “{topic}” reviewed: {todos} to-dos of yours, {loops} follow-ups",
    logFallback: "Meeting “{topic}”: summary sent as it is",
  },
);

// ---------- what the bridge sends back ----------

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const CHECKS = ["zoomMeeting", "calendarEvent", "none"] as const;

/** One item of the model's JSON, read field by field; null when it is not one. Times far from the meeting are dropped as misreadings. */
function itemOf(v: unknown, at: number, ownerTz: string): ReviewItem | null {
  if (!isObject(v)) return null;
  const title = clean(v.title, 140);
  if (title.length < 3) return null;
  const tz = zoneOf(v.tz) ?? ownerTz;
  let due = zonedTime(v.due, tz) ?? undefined;
  if (due !== undefined && (due < at - 24 * 3600_000 || due > at + 90 * 24 * 3600_000)) due = undefined;
  const check = (CHECKS as readonly unknown[]).includes(v.check) ? (v.check as ReviewItem["check"]) : undefined;
  const people = (Array.isArray(v.with) ? v.with : []).map((x) => clean(x, 60)).filter((x) => x.length >= 2).slice(0, 5);
  const reason = clean(v.reason, 60);
  return {
    title,
    who: clean(v.who, 60),
    ...(due ? { due } : {}),
    ...(due && tz !== ownerTz ? { tz } : {}),
    evidence: clean(v.evidence, 200),
    ...(check ? { check } : {}),
    ...(people.length ? { with: people } : {}),
    ...(reason ? { reason } : {}),
  };
}

/**
 * The review in what the model wrote (it may wrap it in a code fence or a sentence), read field by field; null when there is no such JSON.
 * `at`: when the meeting was (times are read against it); `ownerTz`: the zone of a time said without one.
 */
export function parseReview(raw: unknown, at: number, ownerTz: string): ReviewFound | null {
  if (typeof raw !== "string") return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start || end - start > 40_000) return null;
  let j: unknown;
  try {
    j = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!isObject(j)) return null;
  const lists = ["todos", "promises", "decisions", "meetings", "questions"] as const;
  if (!lists.some((k) => Array.isArray(j[k]))) return null;
  const items = (v: unknown, n: number) => (Array.isArray(v) ? v : []).map((x) => itemOf(x, at, ownerTz)).filter((x): x is ReviewItem => !!x).slice(0, n);
  const lines = (v: unknown, n: number) => (Array.isArray(v) ? v : []).map((x) => clean(x, 200)).filter((x) => x.length >= 3).slice(0, n);
  return {
    summary: typeof j.summary === "string" ? neutralise(j.summary, { max: SUMMARY_MAX }).replace(/‹[^›]{0,300}›/g, " ").trim() : "",
    todos: items(j.todos, TODOS_MAX),
    promises: items(j.promises, PROMISES_MAX),
    decisions: lines(j.decisions, DECISIONS_MAX),
    meetings: items(j.meetings, MEETINGS_MAX),
    questions: lines(j.questions, QUESTIONS_MAX),
  };
}

const reviewOf = (v: unknown): MeetingReview | null => {
  if (!isObject(v) || typeof v.id !== "string" || !v.id || typeof v.at !== "number" || typeof v.queuedAt !== "number") return null;
  if (v.source !== "summary" && v.source !== "transcript") return null;
  if (v.status !== "pending" && v.status !== "reviewed" && v.status !== "fallback") return null;
  const items = (x: unknown): ReviewItem[] =>
    (Array.isArray(x) ? x : []).filter((i): i is ReviewItem => isObject(i) && typeof i.title === "string" && typeof i.who === "string").slice(0, 10);
  const lines = (x: unknown): string[] => (Array.isArray(x) ? x : []).filter((s): s is string => typeof s === "string").slice(0, 10);
  return {
    id: v.id.slice(0, 200), topic: typeof v.topic === "string" ? v.topic.slice(0, 120) : "", at: v.at, source: v.source, status: v.status,
    queuedAt: v.queuedAt, ...(typeof v.notice === "string" ? { notice: v.notice.slice(0, 2000) } : {}),
    summary: typeof v.summary === "string" ? v.summary.slice(0, SUMMARY_MAX) : "",
    todos: items(v.todos), promises: items(v.promises), decisions: lines(v.decisions), meetings: items(v.meetings), questions: lines(v.questions),
  };
};

/** The stored reviews, every one checked, oldest first. */
export const reviewsOf = (raw: unknown): MeetingReview[] =>
  (isObject(raw) && Array.isArray(raw.reviews) ? raw.reviews : []).map(reviewOf).filter((x): x is MeetingReview => !!x).slice(-REVIEWS_MAX);

// ---------- the engine's loops ----------

/** "2026-11-18 10:00" in a zone: what src/followups.ts reads back (candidate's `due`). */
const stampIn = (t: number, tz: string): string =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(t);

/**
 * A review's items as the engine's candidates (src/followups.ts candidate, through ingest): the owner's to-dos, others' promises, the meetings
 * agreed. The first check time is this file's: a meeting to set up is looked at two hours later (or an hour before it, if sooner); someone's
 * promise with no time is asked about once, two days later; the rest as the engine does it (a deadline two hours before, or never).
 */
export function reviewLoops(r: ReviewFound, at: number, now: number, ownerTz: string, l: Lang): Record<string, unknown>[] {
  const reason = T(l)("reasonMeeting");
  const due = (i: ReviewItem) => (i.due ? { due: stampIn(i.due, i.tz ?? ownerTz), tz: i.tz ?? ownerTz } : {});
  const checkable = (i: ReviewItem) => ({ checkAt: i.due ? Math.max(now, Math.min(now + CHECK_AFTER_MS, i.due - 3600_000)) : now + CHECK_AFTER_MS });
  const detail = (i: ReviewItem) => (i.evidence ? `«${i.evidence}»` : "");
  const todos = r.todos.map((i) => ({
    kind: i.who ? "request_to_owner" : "owner_promise", title: i.title, detail: detail(i), who: i.who, ...due(i),
    check: i.check ?? "none", hints: i.with ?? [], reason: i.reason ?? reason, ...(i.check && i.check !== "none" ? checkable(i) : {}),
  }));
  const promises = r.promises.map((i) => ({
    kind: "other_promise", title: i.title, detail: detail(i), who: i.who, ...due(i), check: "none", reason: i.reason ?? reason,
    ...(i.due ? {} : { checkAt: at + PROMISE_AFTER_MS }),
  }));
  const meetings = r.meetings.map((i) => ({
    kind: "agreed_meeting", title: i.title, detail: detail(i), who: i.who || (i.with ?? []).join(", ").slice(0, 60), ...due(i),
    check: "zoomMeeting", hints: i.with ?? [], ...checkable(i),
  }));
  return [...todos, ...promises, ...meetings];
}

// ---------- the reviewer ----------

/** A meeting as the written brief reads it (src/brief-v2.ts): Zoom's summary, and what the review found in it. */
export interface BriefMeeting {
  id: string;
  topic: string;
  at: number;
  summary: string;
  decisions?: string[];
  questions?: string[];
  /** The owner's to-dos, others' promises and agreed meetings: only when no engine keeps them as loops (one source of truth). */
  items?: { kind: "todo" | "promise" | "meeting"; title: string; who: string; due?: number; tz?: string }[];
}

/**
 * The meetings of the last `days` days for the brief: each Zoom summary with its review's decisions and open questions; a reviewed transcript
 * with no Zoom summary is added with the review's own. With `ownItems` (the engine is off), the review's to-dos and promises come along too;
 * with the engine on they are the engine's loops (the brief's L facts), never told twice.
 */
export function briefMeetings(
  zoom: { id: string; topic: string; at: number; summary: string }[], reviews: MeetingReview[], o: { now: number; days: number; ownItems: boolean },
): BriefMeeting[] {
  const since = o.now - o.days * 24 * 3600_000;
  const done = new Map(reviews.filter((r) => r.status === "reviewed" && r.at >= since).map((r) => [r.id, r]));
  const out: BriefMeeting[] = [];
  const add = (m: { id: string; topic: string; at: number; summary: string }, r: MeetingReview | undefined): void => {
    const items = !r || !o.ownItems ? [] : [
      ...r.todos.map((i) => ({ kind: "todo" as const, title: i.title, who: i.who, due: i.due, tz: i.tz })),
      ...r.promises.map((i) => ({ kind: "promise" as const, title: i.title, who: i.who, due: i.due, tz: i.tz })),
      ...r.meetings.map((i) => ({ kind: "meeting" as const, title: i.title, who: i.who, due: i.due, tz: i.tz })),
    ];
    out.push({
      ...m,
      ...(r?.decisions.length ? { decisions: [...r.decisions] } : {}),
      ...(r?.questions.length ? { questions: [...r.questions] } : {}),
      ...(items.length ? { items } : {}),
    });
  };
  for (const m of zoom.filter((x) => x.at >= since)) {
    add(m, done.get(m.id));
    done.delete(m.id);
  }
  for (const r of done.values()) if (r.summary || r.decisions.length || r.questions.length) add({ id: r.id, topic: r.topic, at: r.at, summary: r.summary }, r);
  return out.sort((a, b) => b.at - a.at);
}

/**
 * What a meeting left with each person named in it, as one dated fact per person ("last meeting": its topic and day, what the owner agreed to
 * do for them, what they will do, a meeting agreed with them, what was decided). The newest meeting with someone closes the one before, which
 * stays as history. Only the review's structured outcome is used (names, titles, decisions), never the transcript; at most six people.
 * It came from other people's words: a part that tries to instruct Pako is left out, and no phone number, IBAN or link is kept. `canon`:
 * the name a person is kept under (src/people-graph.ts canon), so "Ana" said in the meeting is the owner's Ana Ruiz.
 */
export function agreementFacts(
  found: ReviewFound, o: { topic: string; at: number; owner: string; timeZone: string; canon?: (name: string) => string },
): FactInput[] {
  const fold = (x: string) => x.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
  const owner = fold(o.owner);
  const ownerFirst = owner.split(" ")[0] ?? "";
  const isOwner = (who: string) => !who || fold(who) === owner || (!!ownerFirst && fold(who) === ownerFirst) || /^(me|yo|i|myself|owner)$/i.test(who.trim());
  const safe = (x: string): string => (instructsPako(x) ? "" : stripPayloads(x, new Set(), "").replace(/\s+/g, " ").trim());
  const people = new Map<string, { name: string; mine: string[]; theirs: string[]; meet: string[] }>();
  const of = (who: string) => {
    const said = who.replace(/\s+/g, " ").trim();
    const name = (o.canon?.(said) || said).replace(/\s+/g, " ").trim().slice(0, SUBJECT_MAX);
    const k = fold(name);
    if (!people.has(k)) people.set(k, { name, mine: [], theirs: [], meet: [] });
    return people.get(k)!;
  };
  const add = (list: string[], title: string) => {
    const t = safe(title);
    if (t && !list.includes(t)) list.push(t);
  };
  for (const t of found.todos) if (!isOwner(t.who)) add(of(t.who).mine, t.title);
  for (const p of found.promises) if (!isOwner(p.who)) add(of(p.who).theirs, p.title);
  // A meeting agreed: its person, and the people it is with (names only; an address stays a name the graph may know).
  for (const m of found.meetings) {
    for (const who of [m.who, ...(m.with ?? [])]) {
      // An address the people graph does not know stays out: it may be the owner's own, and it names no one the owner calls by name.
      const bare = who.includes("@") && (o.canon?.(who.trim()) ?? who.trim()) === who.trim();
      if (!isOwner(who) && !bare && !instructsPako(who)) add(of(who).meet, m.title);
    }
  }
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: o.timeZone, day: "numeric", month: "short" }).format(o.at);
  const decided = found.decisions.map(safe).filter(Boolean).slice(0, 2);
  const topic = safe(o.topic) || "a meeting";
  return [...people.values()].filter((x) => x.name && !instructsPako(x.name)).slice(0, 6).flatMap((x) => {
    const parts = [
      ...(x.mine.length ? [`you agreed to ${x.mine.slice(0, 3).join("; ")}`] : []),
      ...(x.theirs.length ? [`they will ${x.theirs.slice(0, 3).join("; ")}`] : []),
      ...(x.meet.length ? [`meeting agreed: ${x.meet.slice(0, 2).join("; ")}`] : []),
      ...(decided.length ? [`decided: ${decided.join("; ")}`] : []),
    ];
    if (!x.mine.length && !x.theirs.length && !x.meet.length) return [];
    return [{
      subject: x.name, attribute: "last meeting",
      value: `«${topic}», ${day}: ${parts.join(". ")}`.slice(0, VALUE_MAX),
      validFrom: o.at, source: { who: "meeting", where: topic.slice(0, 120), at: o.at },
    }];
  });
}

export interface ReviewDeps {
  config: ReviewConfig;
  kv: Kv | null;
  timeZone: string;
  now?: () => number;
  lang?: () => Lang;
  /** The owner's name, so the run knows which speaker is them (PERSONAL_OWNER_NAME). */
  ownerName?: () => string;
  control?: Control;
  /** The assistant inbox (src/whatsapp.ts inbox.add): where the review of Zoom's summary goes. */
  enqueue: (m: Inbound) => Promise<boolean>;
  /** Tells the owner (src/whatsapp.ts notifyOwner). */
  notify: (text: string) => Promise<unknown>;
  /** The commitments engine (src/followups.ts); absent when it is off: the review is still kept and told. */
  loops?: {
    ingest: (o: { ref: string; label: string; at: number; loops: unknown[] }) => Promise<number>;
    open: () => Promise<Loop[]>;
    /** As before the review: the meeting's text as one job of the engine (the fallback). */
    offer: (o: { source: "meeting"; ref: string; label: string; text: string; at?: number }) => Promise<boolean>;
  };
  /**
   * Pako's dated memory of people (src/memory-facts.ts add): what a meeting left with each person named in it ("last meeting"), so the prep
   * before the next one, a draft and the person's card know what was last agreed. Absent: nothing is kept about people.
   */
  remember?: (facts: FactInput[]) => Promise<unknown>;
  /** The name a person said in the meeting is kept under (src/people-graph.ts canon). Absent: as the review wrote it. */
  canon?: (name: string) => string;
  /** Keeps a transcript's summary for ZOOM and the assistant's context (src/zoom.ts annotate). */
  annotate?: (id: string, summary: string) => Promise<boolean>;
  /**
   * Whether the assistant's computer asked for messages lately. When it did not (off, asleep), Zoom's summary is not held for a review that
   * could take hours: summary() says false and it is told at once, as before.
   */
  bridgeAlive?: () => boolean;
}

/** What src/whatsapp.ts asks of the reviewer: the bridge's answer, its acknowledgement, an older bridge's own summary, and the weekly list. */
export interface ReviewDoor {
  result(inboxId: string, raw: string): Promise<{ ok: boolean; todos: number; loops: number }>;
  acked(inboxIds: string[]): Promise<void>;
  settle(id: string, summary: string): Promise<void>;
  command(): Promise<string>;
  /** For the assistant's context: what is still open from the week's meetings, one short line each; absent on an older door. */
  context?(): Promise<string[]>;
}

export function createMeetingReview(d: ReviewDeps) {
  const now = d.now ?? Date.now;
  const lang = d.lang ?? ((): Lang => "en");
  let memory: MeetingReview[] = [];
  let chain: Promise<unknown> = Promise.resolve();

  const readStrict = async (): Promise<MeetingReview[]> => {
    if (!d.kv) return structuredClone(memory);
    const raw = await d.kv.get(REVIEWS_KEY);
    if (!raw) return [];
    try {
      return reviewsOf(JSON.parse(raw));
    } catch {
      log.error("the stored reviews are not valid JSON: starting again");
      return [];
    }
  };
  /** One change at a time, from the whole record as read (a store that cannot be read makes the change fail, never empties it). */
  const mutate = <R>(fn: (list: MeetingReview[]) => R | Promise<R>): Promise<R> => {
    const run = chain.then(async () => {
      const list = await readStrict();
      const out = await fn(list);
      const kept = list.sort((a, b) => a.queuedAt - b.queuedAt).slice(-REVIEWS_MAX);
      if (d.kv) await d.kv.set(REVIEWS_KEY, JSON.stringify({ reviews: kept }), TTL_SECONDS);
      memory = kept;
      return out;
    });
    chain = run.catch(() => undefined);
    return run;
  };
  const read = async (): Promise<MeetingReview[]> => {
    await chain.catch(() => undefined);
    return readStrict();
  };

  const when = (t: number, l: Lang): string =>
    new Intl.DateTimeFormat(locale(l), { timeZone: d.timeZone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(t);
  /** "18/11 10:00", and "(4:30 PM Hong Kong)" when it was said in another zone. */
  const dueText = (due: number | undefined, tz: string | undefined, l: Lang): string => {
    if (!due) return "";
    const theirs = tz && tz !== d.timeZone
      ? ` (${new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(due)} ${zoneName(tz)})`
      : "";
    return T(l)("due", { due: `${when(due, l)}${theirs}` });
  };
  const head = (topic: string, at: number, l: Lang): string => {
    const t = T(l);
    // With the weekday: "Tuesday" is the next Tuesday after the meeting, worked out from it, never from a bare date.
    const stamp = (x: number) => `${stampIn(x, d.timeZone)}, ${new Intl.DateTimeFormat("en-US", { timeZone: d.timeZone, weekday: "long" }).format(x)}`;
    return [
      t("now", { now: stamp(now()), tz: d.timeZone }),
      t("started", { at: stamp(at), tz: d.timeZone }),
      d.ownerName?.() ? t("owner", { name: d.ownerName().slice(0, 60) }) : t("ownerUnknown"),
    ].join("\n");
  };

  /** Told as before the review: Zoom's summary as it is (and the engine's own job), or a transcript's summary with its head. */
  const fallback = async (r: MeetingReview): Promise<void> => {
    const l = lang();
    if (r.source === "summary") {
      if (r.notice) await d.notify(r.notice);
      if (d.loops && r.summary) await d.loops.offer({ source: "meeting", ref: r.id, label: r.topic, text: r.summary, at: r.at }).catch(() => false);
    } else {
      await d.notify(T(l)("failed", { topic: r.topic, when: when(r.at, l), summary: r.summary || T(l)("noSummary") }));
    }
    d.control?.log("zoom", T(l)("logFallback", { topic: r.topic }));
  };

  const register = (r: MeetingReview): Promise<void> =>
    mutate((list) => {
      const i = list.findIndex((x) => x.id === r.id);
      if (i >= 0) list.splice(i, 1, { ...list[i]!, ...r, status: list[i]!.status === "pending" ? "pending" : list[i]!.status });
      else list.push(r);
    });

  /**
   * Zoom's summary of a meeting: queued for review instead of told. False when it could not be queued (the store is down): the caller tells it
   * as before. `notice`: the message as it went before, kept for the fallback.
   */
  const summary = async (m: { id: string; topic: string; at: number; text: string; notice: string }): Promise<boolean> => {
    const l = lang();
    if (d.bridgeAlive && !d.bridgeAlive()) return false;
    try {
      await register({
        id: m.id, topic: m.topic, at: m.at, source: "summary", status: "pending", queuedAt: now(), notice: m.notice, summary: m.text,
        todos: [], promises: [], decisions: [], meetings: [], questions: [],
      });
      const review: InboundReview = { source: "summary", topic: m.topic, when: when(m.at, l), head: head(m.topic, m.at, l), text: m.text };
      return await d.enqueue({ id: reviewInboxId(m.id), at: now(), text: "", review });
    } catch (err) {
      log.error(`could not queue a meeting: ${(err as Error).message}`);
      return false;
    }
  };

  /** A transcript about to go to the computer: what to add to its inbox item so a newer bridge reviews it (null: as before). */
  const transcript = async (m: { id: string; topic: string; at: number }): Promise<InboundReview | null> => {
    const l = lang();
    try {
      await register({
        id: m.id, topic: m.topic, at: m.at, source: "transcript", status: "pending", queuedAt: now(), summary: "",
        todos: [], promises: [], decisions: [], meetings: [], questions: [],
      });
      return { source: "transcript", topic: m.topic, when: when(m.at, l), head: head(m.topic, m.at, l) };
    } catch (err) {
      log.error(`could not keep a meeting: ${(err as Error).message}`);
      return null;
    }
  };

  /** The bridge's answer: kept, made into loops, and the owner told their to-dos only (nothing when there are none). */
  const result: ReviewDoor["result"] = async (inboxId, raw) => {
    const id = reviewIdOf(inboxId);
    const l = lang();
    const t = T(l);
    const out = await mutate((list) => {
      const r = list.find((x) => x.id === id);
      if (!r) return null;
      const was = r.status;
      const found = parseReview(raw, r.at, d.timeZone);
      if (!found) {
        if (was === "pending") r.status = "fallback";
        return { r: { ...r }, was, found: null };
      }
      Object.assign(r, {
        status: was === "pending" ? "reviewed" : was, todos: found.todos, promises: found.promises, decisions: found.decisions, meetings: found.meetings,
        questions: found.questions, ...(r.source === "transcript" && found.summary ? { summary: found.summary } : {}),
      });
      return { r: { ...r }, was, found };
    });
    if (!out) return { ok: false, todos: 0, loops: 0 };
    const { r, was, found } = out;
    if (!found) {
      log.error(`the answer for meeting ${id.slice(0, 12)} is not the JSON asked for: told as before`);
      if (was === "pending") await fallback(r);
      return { ok: false, todos: 0, loops: 0 };
    }
    if (r.source === "transcript" && found.summary && d.annotate) await d.annotate(r.id, found.summary).catch(() => false);
    // Told as before already (no answer in time): the review is kept for the panel; the engine had the meeting's job then.
    if (was !== "pending") return { ok: true, todos: found.todos.length, loops: 0 };
    let loops = 0;
    if (d.loops) {
      try {
        loops = await d.loops.ingest({ ref: r.id, label: r.topic, at: r.at, loops: reviewLoops(found, r.at, now(), d.timeZone, l) });
      } catch (err) {
        log.error(`the loops could not be kept: ${(err as Error).message}`);
      }
    }
    if (d.remember) {
      const facts = agreementFacts(found, { topic: r.topic, at: r.at, owner: d.ownerName?.() ?? "", timeZone: d.timeZone, ...(d.canon ? { canon: d.canon } : {}) });
      if (facts.length) await d.remember(facts).catch((err: Error) => log.error(`what the meeting left with its people was not kept: ${err.message}`));
    }
    if (found.todos.length) {
      const items = found.todos.map((i) => t("item", { title: i.title, who: i.who ? t("waits", { who: i.who }) : "", due: dueText(i.due, i.tz, l) }));
      await d.notify(`${t("told", { topic: r.topic, when: when(r.at, l), list: items.join("\n") })}\n${t("more")}`);
    }
    d.control?.log("zoom", t("logReview", { topic: r.topic, todos: found.todos.length, loops }));
    return { ok: true, todos: found.todos.length, loops };
  };

  /** Fallbacks for the reviews in `pick` that are still pending, marked first so two callers never tell one twice. */
  const giveUp = async (pick: (r: MeetingReview) => boolean): Promise<number> => {
    const due = await mutate((list) => {
      const out = list.filter((r) => r.status === "pending" && pick(r));
      for (const r of out) r.status = "fallback";
      return out.map((r) => ({ ...r }));
    });
    for (const r of due) await fallback(r).catch((err: Error) => log.error(`could not tell a meeting: ${err.message}`));
    return due.length;
  };

  /**
   * Acknowledged by the computer without an answer: an older bridge let it go, or a newer one gave up posting it. Zoom's summary goes as
   * before; a transcript still pending (an older bridge settles it first) is told as one that could not be reviewed.
   */
  const acked: ReviewDoor["acked"] = async (inboxIds) => {
    const summaries = new Set(inboxIds.filter((x) => x.startsWith("review:")).map(reviewIdOf));
    const transcripts = new Set(inboxIds.filter((x) => x.startsWith("zoom:")).map(reviewIdOf));
    if (summaries.size || transcripts.size) {
      await giveUp((r) => (r.source === "summary" ? summaries.has(r.id) : transcripts.has(r.id)));
    }
  };

  /** An older bridge summarized a transcript and told the owner itself: kept for the panel, nothing more to tell. */
  const settle: ReviewDoor["settle"] = async (id, text) => {
    await mutate((list) => {
      const r = list.find((x) => x.id === reviewIdOf(id));
      if (r && r.status === "pending") Object.assign(r, { status: "fallback", summary: neutralise(text, { max: SUMMARY_MAX }) });
    });
  };

  /**
   * Zoom's summaries the computer did not answer in time: told as before. A transcript (the computer's to read) is given longer, a day, then
   * told as one that could not be reviewed: one lost on the way (dropped from a full inbox) is never left pending for weeks.
   */
  const sweep = (): Promise<number> =>
    giveUp((r) => now() - r.queuedAt >= (r.source === "summary" ? d.config.waitMs : Math.max(d.config.waitMs, TRANSCRIPT_WAIT_MS)));

  /** MEETING TODOS: what is still open from the last 7 days of meetings, by meeting, newest first. */
  const command: ReviewDoor["command"] = async () => {
    const l = lang();
    const t = T(l);
    let reviews: MeetingReview[];
    let open: Loop[] | null = null;
    try {
      reviews = (await read()).filter((r) => now() - r.at < WEEK_MS);
      if (d.loops) open = (await d.loops.open()).filter((x) => x.sources.some((s) => s.kind === "meeting" && now() - s.at < WEEK_MS));
    } catch {
      return t("unread");
    }
    type Group = { at: number; topic: string; lines: string[] };
    const groups = new Map<string, Group>();
    const group = (ref: string, topic: string, at: number): Group => {
      const g = groups.get(ref) ?? { at, topic, lines: [] };
      groups.set(ref, g);
      return g;
    };
    if (open) {
      for (const x of open) {
        const src = x.sources.find((s) => s.kind === "meeting")!;
        const r = reviews.find((y) => y.id === src.ref);
        const g = group(src.ref ?? src.label, r?.topic ?? src.label, r?.at ?? src.at);
        const due = dueText(x.dueAt, x.tz, l);
        if (x.kind === "other_promise") g.lines.push(t("promise", { who: x.who || "?", title: x.title, due }));
        else if (x.kind === "agreed_meeting") g.lines.push(t("agreed", { title: x.title, due }));
        else g.lines.push(t("todo", { title: x.title, who: x.who && x.kind === "request_to_owner" ? t("waits", { who: x.who }) : "", due }));
      }
    } else {
      // No engine: the reviews' own items, as they were found.
      for (const r of reviews) {
        const g = group(r.id, r.topic, r.at);
        for (const i of r.todos) g.lines.push(t("todo", { title: i.title, who: i.who ? t("waits", { who: i.who }) : "", due: dueText(i.due, i.tz, l) }));
        for (const i of r.promises) g.lines.push(t("promise", { who: i.who || "?", title: i.title, due: dueText(i.due, i.tz, l) }));
        for (const i of r.meetings) g.lines.push(t("agreed", { title: i.title, due: dueText(i.due, i.tz, l) }));
      }
    }
    for (const r of reviews) if (r.questions.length) group(r.id, r.topic, r.at).lines.push(...r.questions.map((q) => t("question", { text: q })));
    const list = [...groups.values()].filter((g) => g.lines.length).sort((a, b) => b.at - a.at);
    if (!list.length) return t("none");
    return [t("head"), ...list.map((g) => [t("meeting", { topic: g.topic, when: when(g.at, l) }), ...g.lines].join("\n"))].join("\n\n").slice(0, 3500);
  };

  /**
   * For the assistant's context, so "what came out of my meetings?" asked in any words has an answer: what is still open from the last 7 days
   * of meetings, "topic: item (who)", newest meeting first, at most 8 lines. Other people's words: the bridge neutralises them. Empty when
   * nothing is open or the store cannot be read.
   */
  const context = async (): Promise<string[]> => {
    const line = (topic: string, title: string, who: string): string => `${topic}: ${title}${who ? ` (${who})` : ""}`.slice(0, 160);
    try {
      const reviews = (await read()).filter((r) => now() - r.at < WEEK_MS).sort((a, b) => b.at - a.at);
      if (!d.loops) return reviews.flatMap((r) => [...r.todos, ...r.promises, ...r.meetings].map((i) => line(r.topic, i.title, i.who))).slice(0, 8);
      const open = (await d.loops.open()).filter((x) => x.sources.some((s) => s.kind === "meeting" && now() - s.at < WEEK_MS));
      const at = (x: Loop): number => x.sources.find((s) => s.kind === "meeting")!.at;
      return open.sort((a, b) => at(b) - at(a)).slice(0, 8).map((x) => {
        const src = x.sources.find((s) => s.kind === "meeting")!;
        return line(reviews.find((r) => r.id === src.ref)?.topic ?? src.label, x.title, x.who);
      });
    } catch {
      return [];
    }
  };

  /** The panel's meeting view: the latest meetings, newest first, with Zoom's (or the computer's) summary and what the review found. */
  const recent = async (): Promise<Record<string, unknown>[]> => {
    const l = lang();
    return (await read()).sort((a, b) => b.at - a.at).slice(0, 15).map((r) => ({
      topic: r.topic, when: when(r.at, l), status: r.status, summary: r.summary,
      todos: r.todos.map((i) => ({ title: i.title, who: i.who, due: i.due ? when(i.due, l) : "" })),
      promises: r.promises.map((i) => ({ title: i.title, who: i.who, due: i.due ? when(i.due, l) : "" })),
      meetings: r.meetings.map((i) => ({ title: i.title, who: i.who, due: i.due ? when(i.due, l) : "" })),
      decisions: r.decisions, questions: r.questions,
    }));
  };

  return {
    summary,
    transcript,
    result,
    acked,
    settle,
    sweep,
    command,
    context,
    recent,
    read,
    start: () => {
      setInterval(() => void sweep().catch(() => 0), 5 * 60_000).unref?.();
    },
  };
}

export type MeetingReviewer = ReturnType<typeof createMeetingReview>;

// ---------- the panel: GET /panel/api/meetings ----------

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" };

/**
 * The panel's meeting view (src/panel/meetings.js): read only, the panel's session. Without Zoom: no meetings and `connected: false` (the
 * card stays hidden), not a 404 the browser shows as an error at every load.
 */
export function mountMeetingsPanel(app: Express, d: { signedIn: (req: Request) => boolean; recent: (() => Promise<Record<string, unknown>[]>) | null }): void {
  const auth: RequestHandler = (req, res, next) => {
    res.set(HEADERS);
    if (!d.signedIn(req)) {
      res.status(401).json({ error: "sign in" });
      return;
    }
    next();
  };
  app.get("/panel/api/meetings", auth, async (_req, res) => {
    if (!d.recent) {
      res.json({ meetings: [], connected: false });
      return;
    }
    try {
      res.json({ meetings: await d.recent(), connected: true });
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });
}
