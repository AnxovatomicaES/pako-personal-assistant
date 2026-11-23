// What the bridge hands back besides answers: meeting summaries and reviews, judgments, proactive offers, follow-ups.

import type { Door } from "./door.ts";
import { cut } from "./shared.ts";

export function mountFeeds(door: Door): void {
  const { app, d, now, facts, failed, bridge, json } = door;
  /** The Mac's summary of a meeting transcript, kept for ZOOM and the assistant's context (the Mac tells the owner through /assistant/reply). */
  app.post("/assistant/meeting-summary", failed, bridge, json, async (req, res) => {
    const b = (req.body ?? {}) as { id?: unknown; summary?: unknown };
    const id = typeof b.id === "string" ? b.id.replace(/^zoom:/, "").slice(0, 200) : "";
    if (!id || !d.zoom || typeof b.summary !== "string") {
      res.status(400).json({ error: "No such meeting." });
      return;
    }
    try {
      const kept = await d.zoom.annotate(id, b.summary);
      res.json({ ok: kept });
      // An older bridge summarized it and told the owner itself: the review it could not do is closed, with the summary for the panel.
      if (d.reviews) await d.reviews.settle(id, b.summary).catch(() => undefined);
      // What the meeting left to do, for the follow-ups (an extraction job of its own).
      if (kept && d.followups) void d.followups.offer({ source: "meeting", ref: id, label: "Zoom", text: b.summary }).catch(() => undefined);
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });

  /**
   * The bridge's answer to a meeting's review (src/meeting-review.ts): the isolated run's raw text, which the server takes field by field. An
   * unreadable one is told as before (Zoom's summary as it is).
   */
  app.post("/assistant/meeting-review", failed, bridge, json, async (req, res) => {
    const b = (req.body ?? {}) as { id?: unknown; text?: unknown };
    const id = typeof b.id === "string" && /^(?:review|zoom):[^\s]{1,200}$/.test(b.id) ? b.id : "";
    if (!id || !d.reviews) {
      res.status(400).json({ error: d.reviews ? "No such meeting." : "Meeting reviews are off." });
      return;
    }
    try {
      const r = await d.reviews.result(id, typeof b.text === "string" ? cut(b.text, 40_000) : "");
      res.status(r.ok ? 200 : 400).json(r);
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });

  /** The bridge's answer to a judge job (src/memory-facts.ts): its raw text, strict JSON; anything else is the newest fact winning. */
  app.post("/assistant/judge", failed, bridge, json, async (req, res) => {
    const b = (req.body ?? {}) as { id?: unknown; text?: unknown };
    const id = typeof b.id === "string" ? /^jd:([0-9a-f]{10})$/.exec(b.id)?.[1] : undefined;
    if (!id) {
      res.status(400).json({ error: "No such job." });
      return;
    }
    try {
      const r = await facts.verdict(id, typeof b.text === "string" ? cut(b.text, 4000) : "", now());
      res.status(r.ok ? 200 : 400).json(r);
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });

  /** The bridge's answer to a first-tiny-step job (src/gentle.ts): its raw text, strict JSON, checked before anything is kept. */
  app.post("/assistant/step", failed, bridge, json, async (req, res) => {
    const b = (req.body ?? {}) as { id?: unknown; text?: unknown };
    const id = typeof b.id === "string" ? /^st:([0-9a-f]{10})$/.exec(b.id)?.[1] : undefined;
    if (!id || !d.gentle) {
      res.status(400).json({ error: d.gentle ? "No such job." : "Gentle mode is off." });
      return;
    }
    try {
      const r = await d.gentle.stepResult(id, typeof b.text === "string" ? cut(b.text, 2000) : "");
      res.status(r.ok ? 200 : 400).json(r);
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });

  /** The bridge's answer to a proactive check (src/proactive.ts): its raw text, NO_REPLY or JSON, which the engine decides on. */
  app.post("/assistant/proactive", failed, bridge, json, async (req, res) => {
    const b = (req.body ?? {}) as { id?: unknown; text?: unknown };
    const id = typeof b.id === "string" ? /^pr:([0-9a-f]{10})$/.exec(b.id)?.[1] : undefined;
    if (!id || !d.life) {
      res.status(400).json({ error: d.life ? "No such job." : "Proactive Pako is off." });
      return;
    }
    try {
      const r = await d.life.result(id, typeof b.text === "string" ? cut(b.text, 8000) : "");
      res.status(r.ok ? 200 : 400).json(r);
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });

  /**
   * The bridge's answer to a follow-ups job (src/followups.ts): the isolated run's raw text, which the engine takes field by field. An empty
   * text (the run failed) closes the job with nothing kept.
   */
  app.post("/assistant/followups", failed, bridge, json, async (req, res) => {
    const b = (req.body ?? {}) as { id?: unknown; text?: unknown };
    // A rehearsal's job (src/rehearsal.ts): read as a real one is, kept for the panel, nothing more.
    if (typeof b.id === "string" && /^rh:[0-9a-f]{10}$/.test(b.id)) {
      if (!d.rehearsal) return void res.status(400).json({ error: "No such job." });
      try {
        res.json(await d.rehearsal.answer(b.id, typeof b.text === "string" ? cut(b.text, 20_000) : ""));
      } catch (err) {
        res.status(503).json({ error: (err as Error).message });
      }
      return;
    }
    const id = typeof b.id === "string" ? /^fu:([0-9a-f]{10})$/.exec(b.id)?.[1] : undefined;
    if (!id || !d.followups) {
      res.status(400).json({ error: d.followups ? "No such job." : "Follow-ups are off." });
      return;
    }
    try {
      res.json(await d.followups.result(id, typeof b.text === "string" ? cut(b.text, 20_000) : ""));
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });
}
