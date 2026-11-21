// Matching: candidates made into loops (what a "Not mine" rule excludes dropped, the same thing said again merged into its open loop, a
// time moved followed), from the bridge's answer to a job or from a meeting review.

import { instructsPako } from "../brief-support.ts";
import { fold, today } from "../lists.ts";
import { candidate, clean, parseAnswer, sameAsk, sameThing } from "./answer.ts";
import type { Base, Engine, Matching } from "./parts.ts";
import { ESCALATE_BEFORE_MS, LOOPS_PER_JOB, NONE_BEFORE_MS, REVIEW_LOOPS_MAX, SAME_TIME_MS, WHO_MAX } from "./limits.ts";
import { HEX10, isObject, isOpen, newId, num } from "./record.ts";
import { T } from "./texts.ts";
import type { Check, FollowupsDoor, FollowupsState, Job, Loop, LoopSource } from "./types.ts";
import { createLog } from "../log.ts";

const log = createLog("followups");

export function mountMatching({ d, now, lang, config }: Base, { mutate }: Pick<Engine, "mutate">): Matching {
  /** A rule "Not mine" taught covers it: the same person, the same place, the same thing. */
  const ruledOut = (s: FollowupsState, c: { who: string; title: string }, job: Job): boolean =>
    s.rules.some((r) => fold(r.who) === fold(c.who) && fold(r.where) === fold(job.where.label) && sameThing(r.title, c.title));

  /**
   * Candidates made into loops: each checked field by field (candidate), what a rule excludes dropped, a duplicate merged into the open loop.
   * `checkAt` (a number on a candidate) is honoured only from this server's own code (a meeting review), never from the model's JSON.
   */
  const keep = (s: FollowupsState, job: Job, list: unknown[], max: number, trusted: boolean): number => {
    const t = now();
    let added = 0;
    const fresh = new Set<string>();
    for (const v of list.slice(0, max)) {
      const c = candidate(v, job, d.timeZone);
      if (!c) continue;
      if (c.who && d.who) c.who = clean(d.who(c.who), WHO_MAX) || c.who;
      const src: LoopSource = { kind: job.source, label: job.label, at: job.whenSaid, ...(job.ref ? { ref: job.ref } : {}) };
      if (ruledOut(s, c, job)) continue;
      // The same thing again: the open loop the run named (of this conversation only), the same title, (a re-ping worded differently, in a
      // later message) the same kind and check from the same person in the same conversation for the same time, or the same ask from the
      // same person said elsewhere (on Slack, then by email), its title's words in another order.
      const here = (l: Loop): boolean =>
        (!!job.where.channel && l.where.channel === job.where.channel) || (!!job.where.mailThread && l.where.mailThread === job.where.mailThread);
      const checkKind = (k: Check): string => Object.keys(k)[0]!;
      const named = isObject(v) && typeof v.same === "string" && HEX10.test(v.same) ? v.same : "";
      const sameTime = (a?: number, b?: number): boolean => (a === undefined && b === undefined) || (!!a && !!b && Math.abs(a - b) <= SAME_TIME_MS);
      const twin = s.loops.find((l) => isOpen(l) && here(l) && l.id === named)
        ?? s.loops.find((l) => isOpen(l) && fold(l.who) === fold(c.who) && sameThing(l.title, c.title))
        ?? s.loops.find((l) => isOpen(l) && here(l) && !fresh.has(l.id) && !!c.who && fold(l.who) === fold(c.who) && l.kind === c.kind
          && checkKind(l.check) === checkKind(c.check) && sameTime(l.dueAt, c.dueAt))
        ?? s.loops.find((l) => isOpen(l) && !fresh.has(l.id) && sameAsk(l, c, SAME_TIME_MS));
      const given = trusted && isObject(v) ? num(v.checkAt) : undefined;
      // Someone else's promise is theirs to keep: looked at once, near its time (their invitation on the calendar), never 10 minutes after.
      const theirs = c.kind === "other_promise" && !trusted && "calendarEvent" in c.check;
      const firstCheck = given !== undefined
        ? Math.max(given, t)
        : "none" in c.check
          ? (c.dueAt && c.dueAt - NONE_BEFORE_MS > t ? c.dueAt - NONE_BEFORE_MS : 0)
          : theirs
            ? (c.dueAt ? Math.max(c.dueAt - ESCALATE_BEFORE_MS, job.whenSaid + config.delayMs, t) : 0)
            : Math.max(job.whenSaid + config.delayMs, t);
      if (twin) {
        const repeat = twin.sources.some((x) => x.ref && x.ref === src.ref);
        const later = job.whenSaid > Math.max(twin.whenSaid, ...twin.sources.map((x) => x.at));
        // Moved in a later message ("can we make it 6:15 instead?"): the loop follows the new time, and is checked and nudged for it afresh.
        // A day alone ("Friday") said of a loop that has a time that day ("Friday 12:00") is the same time said more loosely: not a move.
        const zone = c.tz ?? d.timeZone;
        const dayOnly = isObject(v) && typeof v.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.due.trim());
        const looser = dayOnly && !!c.dueAt && !!twin.dueAt && today(c.dueAt, zone) === today(twin.dueAt, zone);
        const moved = !repeat && !looser && !!c.dueAt && !!twin.dueAt && Math.abs(c.dueAt - twin.dueAt) > SAME_TIME_MS && later;
        // A time given later in the same conversation to a loop that had none ("let's do it Friday 3pm", "I'll confirm it tomorrow 10:00"):
        // the loop takes it, as a moved one does. Only from its own conversation or thread: a time said elsewhere is another matter.
        const timed = !repeat && !!c.dueAt && !twin.dueAt && here(twin) && later;
        if (moved || timed) {
          twin.dueAt = c.dueAt;
          // The zone the new time was said in. A run that gives the owner's own (or none) keeps the zone the loop had: «can we make it 6:15
          // instead?» of a 5:15 AM ET meeting is still ET, and the same instant written in the owner's zone is no reason to lose it.
          if (c.tz) twin.tz = c.tz;
          if ("zoomMeeting" in twin.check) twin.check.zoomMeeting.around = c.dueAt;
          else if ("calendarEvent" in twin.check) twin.check.calendarEvent.around = c.dueAt;
          if (!theirs) delete twin.escalated;
          twin.nextCheckAt = firstCheck;
        }
        if (!repeat) twin.sources = [...twin.sources, src].slice(-5);
        continue;
      }
      const id = newId();
      fresh.add(id);
      // A job found already answered (the owner replied later in the same thread) makes its loops closed: known, never a nudge.
      s.loops.push({
        id, ...c, where: job.where, whenSaid: job.whenSaid, status: job.closed ? "done" : "open", nextCheckAt: job.closed ? 0 : firstCheck, nudges: 0,
        ...(theirs ? { escalated: true } : {}), createdAt: t, ...(job.closed ? { closedAt: t } : {}), sources: [src],
      });
      added++;
    }
    return added;
  };

  /** The loops a job made or added to: each carries its source (the same kind, place and time), as keep() writes it. */
  const touched = (s: FollowupsState, job: Job): number =>
    s.loops.filter((l) => l.sources.some((x) => x.kind === job.source && x.at === job.whenSaid && x.label === job.label)).length;
  /** The beta's audit (src/beta-audit.ts): this conversation was read, and gave this many follow-ups. It never throws into the write. */
  const told = (job: Job, loops: number, queued = true): void => {
    try {
      d.audit?.answered({ ...(queued ? { id: job.id } : {}), source: job.source, label: job.label, at: job.whenSaid, loops });
    } catch (err) {
      log.error(`the beta's audit: ${(err as Error).message}`);
    }
  };

  /** The bridge's answer to a job: each candidate checked field by field; duplicates and what a rule excludes are dropped. */
  const result: FollowupsDoor["result"] = (jobId, raw) =>
    mutate((s) => {
      const job = s.jobs.find((j) => j.id === jobId);
      if (!job) return { ok: false, added: 0 };
      s.jobs = s.jobs.filter((j) => j !== job);
      const answer = parseAnswer(raw);
      if (!answer) {
        log.error(`the answer to job ${jobId} is not the JSON asked for: nothing kept`);
        return { ok: false, added: 0 };
      }
      // Closed by what was said later ("nvm, Stan set it up", the owner's reply with the signed copy): only an open loop of this same Slack
      // conversation or email thread.
      const same = (l: Loop): boolean =>
        (job.source === "slack" && !!job.where.channel && l.where.channel === job.where.channel)
        || (job.source === "mail" && !!job.where.mailThread && l.where.mailThread === job.where.mailThread);
      for (const id of answer.closes) {
        const x = s.loops.find((l) => l.id === id && isOpen(l) && same(l));
        if (!x) continue;
        Object.assign(x, { status: "done", closedAt: now(), nextCheckAt: 0, autoClosed: { at: now(), why: T(lang())("whyLater") } });
        d.control?.log("followup", T(lang())("logClosed", { title: x.title }));
      }
      // An email's words are other people's: a candidate that reads as an order to an assistant is not kept, whatever the run made of it.
      const loops = job.source === "mail" ? answer.loops.filter((v) => !(isObject(v) && instructsPako(`${v.title ?? ""} ${v.detail ?? ""}`))) : answer.loops;
      const before = touched(s, job);
      const added = keep(s, job, loops, LOOPS_PER_JOB, false);
      told(job, touched(s, job) - before + answer.closes.length);
      return { ok: true, added };
    });

  /**
   * What a meeting review found (src/meeting-review.ts), already read field by field there: kept as loops of that meeting (its id as their
   * source's ref), like an answer to a job, with the review's own first check time. No job and no bridge round trip of their own.
   */
  const ingest = (o: { ref: string; label: string; at: number; loops: unknown[] }): Promise<number> =>
    mutate((s) => {
      const label = o.label.slice(0, 120) || "Zoom";
      const job: Job = { id: newId(), at: now(), source: "meeting", where: { type: "zoom_meeting", label }, whenSaid: o.at, label, ref: o.ref.slice(0, 200) };
      const before = touched(s, job);
      const added = keep(s, job, o.loops, REVIEW_LOOPS_MAX, true);
      told(job, touched(s, job) - before, false);
      return added;
    });

  /**
   * A promise the owner made in the chat with Pako: their own loop, checked like any other with no check a server can see (nudged once before
   * its time when it has one). The same thing already open is not kept twice. Never from outside text: the door holds a turn that read any.
   */
  const fromChat: Engine["fromChat"] = (o) =>
    mutate((s) => {
      const t = now();
      const label = T(lang())("chatLabel");
      const job: Job = { id: newId(), at: t, source: "chat", where: { type: "chat", label }, whenSaid: t, label, ...(o.ref ? { ref: o.ref.slice(0, 200) } : {}) };
      const before = new Set(s.loops.map((l) => l.id));
      const added = keep(s, job, [{ kind: "owner_promise", title: o.title, who: o.who ?? "", ...(o.due ? { due: o.due } : {}), check: "none", reason: "chat" }], 1, false);
      return added ? s.loops.find((l) => !before.has(l.id)) ?? null : null;
    });

  /** Undo of fromChat: each loop goes, unless it was closed since or something other than the chat also said it (then it stays). */
  const dropFromChat: Engine["dropFromChat"] = (ids) =>
    mutate((s) => {
      const gone = s.loops.filter((l) => ids.includes(l.id) && isOpen(l) && l.sources.every((x) => x.kind === "chat")).map((l) => l.id);
      s.loops = s.loops.filter((l) => !gone.includes(l.id));
      return gone;
    });

  return { ruledOut, keep, result, ingest, fromChat, dropFromChat, touched, told };
}
