// The checks: whether the owner did it, from their Zoom, their calendar and their own posts in that conversation; what was checked, as the
// owner reads it, when not. A Teams chat goes through the same path as a Slack one (its ids start with GTEAMS), so the words name neither;
// a Messages chat (src/imessage.ts, ids starting with GIMSG) too, and where it was seen done says Messages.

import { isImessageChannel } from "../imessage.ts";
import { isFocusBlock } from "../time-to-do.ts";
import { fold } from "../lists.ts";
import type { Base, Checks } from "./parts.ts";
import { CREATED_SLACK_MS, NEAR_TIME_MS, SAME_TIME_MS } from "./limits.ts";
import { T } from "./texts.ts";
import type { Loop } from "./types.ts";
import { createLog } from "../log.ts";

const log = createLog("followups");

/** `replied`: the owner wrote in that conversation after the ask (not proof, but a reason to speak softly). */
export type Seen = { done: boolean | null; what: string; said: string; replied?: boolean };

export function mountChecks({ d, lang }: Base): Checks {
  const hintWords = (hints: string[]): string[] =>
    [...new Set(hints.flatMap((h) => fold(h).split(/[^\p{L}\p{N}]+/u)).filter((w) => w.length >= 4 && !/^(meeting|reunion|call|llamada|with|para|zoom|https?)$/.test(w)))];
  /**
   * Whether a meeting is the one asked for. A repeating one (the weekly standup) never is. One that starts at the time asked counts whatever
   * its topic only when it was set up after the ask (or Zoom does not say when); otherwise its topic must name them: one hint word (not the
   * asker's own name) for a meeting set up after the ask, two for one that was there before.
   */
  const matches = (m: { title: string; at: number; created?: number; recurring?: boolean }, around: number | undefined, words: string[], l: Loop): boolean => {
    if (m.recurring) return false;
    const before = m.created !== undefined && m.created < l.whenSaid - CREATED_SLACK_MS;
    const asker = new Set(fold(l.who).split(/[^\p{L}\p{N}]+/u));
    const hits = words.filter((w) => !asker.has(w) && fold(m.title).includes(w)).length;
    const named = hits >= (before ? 2 : 1);
    if (around !== undefined) return (!before && Math.abs(m.at - around) <= SAME_TIME_MS) || (named && Math.abs(m.at - around) <= NEAR_TIME_MS);
    return named && m.at >= l.whenSaid - 3600_000;
  };

  const runCheck = async (l: Loop): Promise<Seen> => {
    const lg = lang();
    const t = T(lg);
    const c = l.check;
    if ("zoomMeeting" in c || "calendarEvent" in c) {
      const around = "zoomMeeting" in c ? c.zoomMeeting.around : c.calendarEvent.around;
      const words = hintWords("zoomMeeting" in c ? c.zoomMeeting.attendeesHints : c.calendarEvent.hints);
      let sawZoom = false;
      let sawCal = false;
      if ("zoomMeeting" in c && d.zoom) {
        try {
          const list = await d.zoom();
          sawZoom = true;
          const seen = list.map((m) => ({ title: m.topic, at: m.at, created: m.createdAt, recurring: m.recurring }));
          if (seen.some((m) => matches(m, around, words, l))) return { done: true, what: t("zoomWhere"), said: "" };
        } catch (err) {
          log.error(`Zoom could not be read for a check: ${(err as Error).message}`);
        }
      }
      if (d.calendar) {
        try {
          const got = await d.calendar();
          const all = Array.isArray(got) ? got : got.events;
          // Read in part: what is there still counts, but what is not may be in the calendar that failed.
          sawCal = Array.isArray(got) || !got.partial;
          // Pako's own focus block (src/time-to-do.ts) sits in free time, often the very time of a meeting still to set up: never that meeting.
          const seen = all.filter((e) => !isFocusBlock(e.title));
          if (seen.some((e) => matches({ title: e.title, at: e.start, created: e.created, recurring: e.recurring }, around, words, l))) {
            return { done: true, what: t("calWhere"), said: "" };
          }
        } catch (err) {
          log.error(`the calendar could not be read for a check: ${(err as Error).message}`);
        }
      }
      // The owner may have set it up and posted its link in the conversation (or the thread) it was asked in, or answered there.
      const ch = l.where.channel;
      const after = l.sources.find((s) => s.kind === "slack")?.ref;
      let replied = false;
      if ("zoomMeeting" in c && ch && after && d.slackHistory) {
        try {
          const posts = (await d.slackHistory(ch, { oldest: after, limit: 50, ...(l.where.thread ? { thread: l.where.thread } : {}) }))
            .filter((p) => p.mine && Number(p.ts) > Number(after));
          if (posts.some((p) => /zoom\.us\/(?:j|my|s)\//i.test(p.text))) return { done: true, what: t("slackWhere"), said: "" };
          replied = posts.length > 0;
        } catch {
          /* said below as what was checked */
        }
      }
      const theirs = l.kind === "other_promise" && "calendarEvent" in c;
      const base = "zoomMeeting" in c
        ? sawZoom ? (sawCal ? t("noZoomNoCal") : t("noZoom")) : sawCal ? t("noCal") : t("cantZoom")
        : sawCal ? t(theirs ? "noInvite" : "noCal") : t("cantZoom");
      const said = replied ? t("replied", { said: base }) : base;
      return { done: sawZoom || sawCal ? false : null, what: "", said, ...(replied ? { replied } : {}) };
    }
    if ("slackReply" in c || "slackPost" in c) {
      const { channel, afterTs, thread } = "slackReply" in c ? c.slackReply : c.slackPost;
      if (!d.slackHistory) return { done: null, what: "", said: t("cantSlack") };
      const seenIn = t(isImessageChannel(channel) ? "messagesWhere" : "slackWhere");
      try {
        // A thread's replies are not in the channel's history: a check of a thread reads the thread.
        const posts = (await d.slackHistory(channel, { oldest: afterTs, limit: 50, ...(thread ? { thread } : {}) }))
          .filter((p) => p.mine && Number(p.ts) > Number(afterTs));
        if ("slackReply" in c && c.slackReply.file) {
          return posts.some((p) => p.file) ? { done: true, what: seenIn, said: "" } : { done: false, what: "", said: t("noFile") };
        }
        if ("slackReply" in c) return posts.length ? { done: true, what: seenIn, said: "" } : { done: false, what: "", said: t("noReply") };
        const words = c.slackPost.contains.map(fold);
        const hit = posts.some((p) => words.some((w) => fold(p.text).includes(w)));
        return hit ? { done: true, what: seenIn, said: "" } : { done: false, what: "", said: t("noPost", { words: c.slackPost.contains.join(", ") }) };
      } catch (err) {
        log.error(`Slack could not be read for a check: ${(err as Error).message}`);
        return { done: null, what: "", said: t("cantSlack") };
      }
    }
    const reason = c.none.reason;
    const mail = /^(mail|correo|email)$/i.test(reason) || l.where.type === "mail";
    // Someone else's email to the owner cannot be seen either: said as theirs, not as the owner's sent mail.
    if (mail && l.kind === "other_promise") return { done: null, what: "", said: t("cantMailIn") };
    return { done: null, what: "", said: mail ? t("cantMail") : t("cantSee", { reason: reason || "—" }) };
  };

  return { runCheck };
}
