// Extraction, the server's side: what the bridge's run sends back (strict JSON) read, each candidate checked field by field, and the test
// for the same thing said twice.

import { fold } from "../lists.ts";
import { neutralise } from "../quarantine.ts";
import { DETAIL_MAX, TITLE_MAX, WHO_MAX } from "./limits.ts";
import { HEX10, isObject } from "./record.ts";
import { zonedTime, zoneOf } from "./time.ts";
import { LOOP_KINDS, type Check, type Job, type Loop, type LoopKind } from "./types.ts";

/** Owner-facing text from the model: neutralised (no tags, nothing hidden), one line, no links (a nudge never carries one), cut. */
export const clean = (v: unknown, max: number): string =>
  neutralise(typeof v === "string" ? v : "", { max: max * 2, oneLine: true })
    .replace(/‹[^›]{0,300}›/g, " ")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "…")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();

/** The JSON object in what the model wrote (it may wrap it in a code fence or a sentence); null when there is none. */
export function parseExtraction(raw: unknown): unknown[] | null {
  return parseAnswer(raw)?.loops ?? null;
}

/**
 * The whole answer: its loops, and the open loops of that conversation the new messages show done or called off (`closes`: their ids, which the
 * server takes only when they are open loops of that same conversation). An older bridge's answer has no `closes`.
 */
export function parseAnswer(raw: unknown): { loops: unknown[]; closes: string[] } | null {
  if (typeof raw !== "string") return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start || end - start > 20_000) return null;
  try {
    const j = JSON.parse(raw.slice(start, end + 1)) as unknown;
    if (!isObject(j) || !Array.isArray(j.loops)) return null;
    const closes = (Array.isArray(j.closes) ? j.closes : []).filter((x): x is string => typeof x === "string" && HEX10.test(x)).slice(0, 5);
    return { loops: j.loops, closes };
  } catch {
    /* not JSON: no answer */
    return null;
  }
}

/** A candidate as the model gave it, made into a loop's fields, or null. Only fixed words, cut texts and times this file can read get through. */
export function candidate(
  v: unknown, job: Job, ownerTz: string,
): Pick<Loop, "kind" | "title" | "detail" | "who" | "dueAt" | "tz" | "check" | "effort"> | null {
  if (!isObject(v) || !(LOOP_KINDS as readonly unknown[]).includes(v.kind)) return null;
  const title = clean(v.title, TITLE_MAX);
  if (title.length < 3) return null;
  const tz = zoneOf(v.tz) ?? ownerTz;
  let dueAt = zonedTime(v.due, tz) ?? undefined;
  // A time far from when it was said is a misreading: kept without it.
  if (dueAt !== undefined && (dueAt < job.whenSaid - 24 * 3600_000 || dueAt > job.whenSaid + 90 * 24 * 3600_000)) dueAt = undefined;
  const hints = (Array.isArray(v.hints) ? v.hints : []).map((h) => clean(h, 60)).filter((h) => h.length >= 2).slice(0, 5);
  const channel = job.where.channel;
  const thread = job.where.thread ? { thread: job.where.thread } : {};
  const slackOk = job.source === "slack" && !!channel && !!job.afterTs;
  let check: Check;
  switch (v.check) {
    case "zoomMeeting":
      // Someone else's meeting is never on the owner's Zoom: their invitation on the owner's calendar is all that can be seen.
      check = v.kind === "other_promise"
        ? { calendarEvent: { ...(dueAt ? { around: dueAt } : {}), hints } }
        : { zoomMeeting: { ...(dueAt ? { around: dueAt } : {}), attendeesHints: hints } };
      break;
    case "calendarEvent":
      check = { calendarEvent: { ...(dueAt ? { around: dueAt } : {}), hints } };
      break;
    case "slackReply":
      check = slackOk ? { slackReply: { channel: channel!, afterTs: job.afterTs!, ...thread } } : { none: { reason: "slack" } };
      break;
    case "slackFile":
      // A document to send: any later word of the owner's there ("thanks!") is not it; a file or a link is.
      check = slackOk ? { slackReply: { channel: channel!, afterTs: job.afterTs!, ...thread, file: true } } : { none: { reason: "slack" } };
      break;
    case "slackPost": {
      const contains = (Array.isArray(v.contains) ? v.contains : []).map((h) => clean(h, 40)).filter((h) => h.length >= 2).slice(0, 3);
      check = slackOk && contains.length ? { slackPost: { channel: channel!, afterTs: job.afterTs!, contains, ...thread } } : { none: { reason: "slack" } };
      break;
    }
    default:
      check = { none: { reason: clean(v.reason, 100) || (job.source === "mail" ? "mail" : "") } };
  }
  return {
    kind: v.kind as LoopKind,
    title,
    detail: clean(v.detail, DETAIL_MAX),
    who: clean(v.who, WHO_MAX),
    ...(dueAt ? { dueAt } : {}),
    ...(dueAt && tz !== ownerTz ? { tz } : {}),
    check,
    // The work it takes, in minutes (src/time-to-do.ts): a whole number from 5 to 480, or none.
    ...(typeof v.effort === "number" && Number.isInteger(v.effort) && v.effort >= 5 && v.effort <= 480 ? { effort: v.effort } : {}),
  };
}

/** Words that say nothing of what is asked: left out when two titles are compared word by word. */
const FILLER = new Set(["the", "to", "and", "for", "with", "of", "from", "an", "el", "la", "los", "las", "de", "del", "al", "y", "para", "con", "por"]);
const wordsOf = (s: string, drop: Set<string>): Set<string> =>
  new Set(fold(s).split(/[^\p{L}\p{N}]+/u).filter((w) => (w.length >= 2 || /\d/.test(w)) && !FILLER.has(w) && !drop.has(w)));

/**
 * The same ask from the same person, said in another place (on Slack, then by email): the same first name, the same kind, the same time
 * (or none on both), and the same words in its title whatever their order, the person's own name aside ("Send Dana Whitlock the signed NDA"
 * is "Send the signed NDA to Dana"). Two words at least: a bare "Call Dana" is never taken for another call.
 */
export function sameAsk(
  a: { who: string; title: string; kind: string; dueAt?: number }, b: { who: string; title: string; kind: string; dueAt?: number }, sameTimeMs: number,
): boolean {
  const first = (w: string): string => fold(w).split(/\s+/)[0] ?? "";
  if (!first(a.who) || first(a.who) !== first(b.who) || a.kind !== b.kind) return false;
  if ((a.dueAt === undefined) !== (b.dueAt === undefined) || (a.dueAt !== undefined && Math.abs(a.dueAt - b.dueAt!) > sameTimeMs)) return false;
  const names = new Set(`${fold(a.who)} ${fold(b.who)}`.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const x = wordsOf(a.title, names);
  const y = wordsOf(b.title, names);
  return x.size >= 2 && x.size === y.size && [...x].every((w) => y.has(w));
}

/** Same thing said twice: one title holds the other (case, accents and spaces aside). */
export const sameThing = (a: string, b: string): boolean => {
  const x = fold(a);
  const y = fold(b);
  return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 12 && (x.includes(y) || y.includes(x))));
};
