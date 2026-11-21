// A meeting's transcript summarized, and a meeting's review: each read in an isolated run of its own.

import { randomBytes } from "node:crypto";
import { MEETING_PROMPT, REVIEW_PROMPT } from "../prompt.ts";
import { ClaudeError } from "./claude.ts";
import { fenced, languageLine } from "./context.ts";
import type { Meeting, Review } from "./items.ts";
import { parseReply } from "./reply.ts";
import { T } from "./texts.ts";
import type { AfterLanguage } from "./parts.ts";

export function mountMeetings(b: AfterLanguage) {
  const { config, log, api, say, background, retryAt, hold, attempts, ownerLanguage, unsent, deliver } = b;
  /** A meeting's transcript: summarized in a run of its own like an email (no tools, no conversation, tags dropped), kept by the server, told. */
  const handleMeeting = async (id: string, m: Meeting): Promise<boolean> => {
    const fence = `REUNION-${randomBytes(4).toString("hex")}`;
    const { code, ui } = await ownerLanguage();
    const t = T(ui);
    const tongue = languageLine(code);
    const topic = m.topic || t("noTitle");
    const prompt = [...(tongue ? [tongue] : []), "", `<<<${fence}`, t("meeting", { topic: fenced(topic) }), t("started", { when: fenced(m.when) }), "", fenced(m.transcript, 60_000), `${fence}>>>`]
      .join("\n");
    let summary: string;
    try {
      const r = await background("meeting", JSON.stringify([m, code]), prompt, { ...config, tools: [], systemPrompt: MEETING_PROMPT.replaceAll("REUNION", fence) });
      if ("skipped" in r) {
        if (r.skipped === "paused") {
          hold(id, r.until);
          return false;
        }
        summary = t("meetingFailed");
      } else {
        summary = parseReply(r.text).text;
        log(`meeting ${id.slice(-8)}: ${summary.length} chars, $${r.costUsd.toFixed(4)}`);
      }
    } catch (err) {
      const kind = err instanceof ClaudeError ? err.kind : "other";
      log(`claude failed on a meeting (${kind}): ${(err as Error).message.slice(0, 200)}`);
      if (kind === "limit" || kind === "login") {
        if (kind === "limit") hold(id);
        else retryAt.set(id, Date.now() + 5 * 60_000);
        return false;
      }
      summary = t("meetingFailed");
    }
    try {
      const r = await api("/assistant/meeting-summary", { method: "POST", body: { id, summary } });
      if (!r.ok) log(`meeting summary refused: ${r.status}`);
    } catch (err) {
      log(`meeting summary failed: ${(err as Error).message}`);
    }
    const sent = await say({ text: `${t("meetingHead", { topic })}${m.when ? ` (${m.when})` : ""}\n${summary}`, notice: true });
    if (sent) return true;
    const n = (attempts.get(id) ?? 0) + 1;
    attempts.set(id, n);
    return n >= 3;
  };

  /**
   * A meeting's review (src/meeting-review.ts): Zoom's summary or the transcript read in a run of its own (no tools, no conversation, its own
   * fence, nothing acted on), whose answer goes back to the server as raw text; the server takes only the JSON it asked for, field by field, and
   * tells the owner their to-dos itself. Nothing is said to the owner here.
   */
  const handleReview = async (id: string, r: Review): Promise<boolean> => {
    const kept = unsent.get(id);
    if (kept !== undefined) return deliver(id, "/assistant/meeting-review", kept, "review");
    const fence = `REVISION-${randomBytes(4).toString("hex")}`;
    const { code, ui } = await ownerLanguage();
    const t = T(ui);
    const tongue = languageLine(code);
    const prompt = [
      ...(tongue ? [tongue] : []), fenced(r.head, 1000), "", `<<<${fence}`, t("meeting", { topic: fenced(r.topic || t("noTitle")) }),
      t("started", { when: fenced(r.when) }), "", fenced(r.text, r.source === "transcript" ? 60_000 : 16_000), `${fence}>>>`,
    ].join("\n");
    let text = "";
    try {
      // Without a run (over the day's budget) the answer is empty: the server then tells Zoom's own summary, as for an older bridge.
      const got = await background("review", JSON.stringify([r, code]), prompt, { ...config, tools: [], systemPrompt: REVIEW_PROMPT.replaceAll("REVISION", fence) });
      if ("skipped" in got) {
        if (got.skipped === "paused") {
          hold(id, got.until);
          return false;
        }
      } else {
        text = got.text.slice(0, 40_000);
        log(`review ${id.slice(-8)}: ${text.length} chars, $${got.costUsd.toFixed(4)}`);
      }
    } catch (err) {
      const kind = err instanceof ClaudeError ? err.kind : "other";
      log(`claude failed on a review (${kind}): ${(err as Error).message.slice(0, 200)}`);
      if (kind === "limit" || kind === "login") {
        if (kind === "limit") hold(id);
        else retryAt.set(id, Date.now() + 5 * 60_000);
        return false;
      }
    }
    return deliver(id, "/assistant/meeting-review", text, "review");
  };
  return { handleMeeting, handleReview };
}

export type Meetings = ReturnType<typeof mountMeetings>;
