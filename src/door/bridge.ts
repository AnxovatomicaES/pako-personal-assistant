// The bridge for the assistant on the owner's computer: its token, and the inbox it reads and acknowledges.

import express, { type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { paperText } from "../papers.ts";
import { type Inbound, MAX_MSGS, isRehearsal } from "./inbox.ts";
import { cut, same } from "./shared.ts";
import type { Door } from "./door.ts";
import { createLog } from "../log.ts";

const logRehearsal = createLog("rehearsal");
const logReview = createLog("review");
const logBrief = createLog("brief");
const logPapers = createLog("papers");

export function mountBridge(door: Door): Pick<Door, "failed" | "bridge" | "json" | "strings"> {
  const { app, d, config, now, lang, inbox, papers, sendText, runReminders, inRoute } = door;
  // ---------- the bridge for the assistant on the owner's computer ----------

  const failed = rateLimit({
    windowMs: 15 * 60_000,
    limit: 30,
    skipSuccessfulRequests: true,
    // Only a refused token counts: a 503 from the store or a 502 from Meta must not lock the Mac out.
    requestWasSuccessful: (_req, res) => res.statusCode !== 401,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).type("text").send("Too many attempts.");
    },
  });
  const bridge: RequestHandler = (req, res, next) => {
    const m = /^Bearer (.+)$/.exec(req.get("authorization") ?? "");
    if (!m || !same(m[1]!, config.bridgeToken)) {
      res.status(401).type("text").send("Unauthorized");
      return;
    }
    res.set("Cache-Control", "no-store");
    next();
  };
  const json = express.json({ limit: "64kb" });
  const strings = (v: unknown, count: number, min: number, max: number): string[] =>
    (Array.isArray(v) ? v : [])
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.replace(/\s+/g, " ").trim())
      .filter((x) => x.length >= min)
      .map((x) => cut(x, max))
      .slice(0, count);

  /**
   * The messages waiting (they stay until acknowledged), held up to `wait` seconds when there are none. `uiLanguage` is the language of
   * Pako's own texts at this moment: what the bridge says before it has read a message's context (a voice note it could not hear, the head
   * of an email's notice) follows a change made in the panel at once. An older bridge ignores it.
   */
  app.get("/assistant/inbox", failed, bridge, async (req, res) => {
    door.lastPollAt = now();
    door.polled = true;
    void runReminders(); // the assistant's computer asks every few seconds: that is also what keeps due reminders on time
    const wait = Math.min(25, Math.max(0, Number(req.query.wait) || 0));
    try {
      let msgs = await inbox.peek();
      if (!msgs.length && wait > 0) {
        await inbox.wait(wait * 1000);
        msgs = await inbox.peek();
      }
      door.lastPollAt = now();
      res.json({ messages: msgs, uiLanguage: lang() });
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });

  /** `papers: 1`: a bridge that reads papers (assistant/bridge.ts); an older one acknowledges a paper it let go without it. */
  app.post("/assistant/ack", failed, bridge, json, async (req, res) => {
    const b = (req.body ?? {}) as { ids?: unknown; papers?: unknown; briefs?: unknown };
    let acked: Inbound[];
    let reviewed: string[] = [];
    let briefs: string[] = [];
    let rehearsed: string[] = [];
    try {
      const ids = strings(b.ids, MAX_MSGS, 1, 400);
      const held = (await inbox.peek()).filter((m) => ids.includes(m.id));
      acked = held.filter((m) => m.paper);
      reviewed = held.filter((m) => m.review).map((m) => m.id);
      rehearsed = held.filter(isRehearsal).map((m) => m.id);
      briefs = held.filter((m) => m.brief && !isRehearsal(m)).map((m) => m.id);
      await inbox.ack(ids);
      res.json({ ok: true });
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
      return;
    }
    // A rehearsal's job acknowledged before its answer came: an older bridge let it go (src/rehearsal.ts says to update it).
    if (rehearsed.length && d.rehearsal) await d.rehearsal.acked(rehearsed).catch((err: Error) => logRehearsal.error(`${err.message}`));
    // A review let go without its answer (an older bridge): the meeting is told as before (src/meeting-review.ts).
    if (reviewed.length && d.reviews) await d.reviews.acked(reviewed).catch((err: Error) => logReview.error(`${err.message}`));
    // `briefs: 1`: a bridge that writes the brief (it answered before acknowledging); an older one let it go, and the old brief goes now.
    if (briefs.length && d.briefJobs) await d.briefJobs.acked(briefs, b.briefs === 1).catch((err: Error) => logBrief.error(`${err.message}`));
    for (const m of acked) {
      papers.done(m.paper!.id);
      // Let go unread by an older bridge: the owner hears, on the chat they sent it from, how to update the assistant's computer.
      if (b.papers === 1) continue;
      if (now() - door.lastOldBridgeNoticeAt < 10 * 60_000) continue;
      door.lastOldBridgeNoticeAt = now();
      logPapers.error("the assistant's bridge cannot read papers (it needs a git pull): the owner is told");
      await inRoute(m.id, async () => void (await sendText(paperText("oldBridge", lang())))).catch((err: Error) => logPapers.error(`${err.message}`));
    }
  });

  return { failed, bridge, json, strings };
}
