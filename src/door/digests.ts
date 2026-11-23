// What the bridge hands back besides answers: the brief, Slack's search, the mail's summary, the notes it keeps.

import { categoryOf, loopFromVerdict, readVerdict, senderAddress, senderName, VERDICT_WORD, type Verdict } from "../mail-categories.ts";
import type { Change } from "../undo.ts";
import type { Door } from "./door.ts";
import type { Loop } from "../followups/types.ts";
import { cut } from "./shared.ts";

export function mountDigests(door: Door): void {
  const { app, d, now, tx, keyOf, noteReceipt, failed, bridge, json, strings } = door;
  /**
   * The bridge's answer to a written-brief job (src/brief-v2.ts): the isolated run's raw text, which the brief takes field by field (the brief),
   * or as a plain document (asked from the page). An empty text (the run failed) makes the old brief go instead.
   */
  app.post("/assistant/brief", failed, bridge, json, async (req, res) => {
    const b = (req.body ?? {}) as { id?: unknown; text?: unknown };
    if (typeof b.id === "string" && /^rb:[0-9a-f]{10}$/.test(b.id)) {
      if (!d.rehearsal) return void res.status(400).json({ error: "No such job." });
      try {
        res.json(await d.rehearsal.answer(b.id, typeof b.text === "string" ? cut(b.text, 30_000) : ""));
      } catch (err) {
        res.status(503).json({ error: (err as Error).message });
      }
      return;
    }
    const id = typeof b.id === "string" ? /^br:([0-9a-f]{10})$/.exec(b.id)?.[1] : undefined;
    if (!id || !d.briefJobs) {
      res.status(400).json({ error: d.briefJobs ? "No such job." : "The written brief is off." });
      return;
    }
    try {
      res.json(await d.briefJobs.result(id, typeof b.text === "string" ? cut(b.text, 30_000) : ""));
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });

  /** A search of the owner's Slack for the assistant (its <slack> tag): one line per message, other people's words. */
  app.get("/assistant/slack/search", failed, bridge, async (req, res) => {
    const q = typeof req.query.q === "string" ? cut(req.query.q.replace(/\s+/g, " ").trim(), 200) : "";
    if (!d.slack || !q) {
      res.status(400).json({ error: d.slack ? "Empty search." : "Slack is not connected." });
      return;
    }
    try {
      res.json({ results: await d.slack.search(q) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /**
   * What the Mac made of an email: its summary, and (a newer bridge) the triage's verdict: its category, why, ask and loop lines
   * (src/mail-categories.ts). The answer says whether the owner is told now, by the category and the owner's switches (the bridge sends that
   * message itself through /assistant/reply); an older bridge decided by itself and sends only `notify` and `scam`.
   * Needs you, Waiting on others, Important and Personal mail (told or not; never a scam or mail sent to a list) is read whole by the
   * follow-ups: its cleaned words, with the rest of its thread's new mail, in one job (src/mail-followups.ts). When they do not take it (off,
   * or the day's email jobs spent), Needs you and Waiting on others become loops straight from the triage's LOOP line (no second run of
   * Claude), and a Needs you mail without one goes to the follow-ups' reading of its summary. Any new email from someone the owner is waiting
   * on closes what they owed.
   */
  app.post("/assistant/mail-summary", failed, bridge, json, async (req, res) => {
    const b = (req.body ?? {}) as {
      id?: unknown; notify?: unknown; summary?: unknown; scam?: unknown; verdict?: unknown; quiet?: unknown; worth?: unknown; replied?: unknown;
    };
    const id = typeof b.id === "string" ? b.id.replace(/^mail:/, "").slice(0, 300) : "";
    if (!id || !d.mail?.annotate) {
      res.status(400).json({ error: "No such email." });
      return;
    }
    try {
      const verdict = verdictOf(b.verdict);
      const scam = verdict ? verdict.category === "suspicious" : typeof b.scam === "boolean" ? b.scam : undefined;
      const summary = typeof b.summary === "string" ? b.summary : "";
      // Mail read quietly when the mailbox was connected was not told, but the bridge says whether it would have been (`worth`).
      const worth = b.notify === true || (b.quiet === true && b.worth === true);
      const kept = await d.mail.annotate(id, b.notify === true ? "aviso" : "guardado", summary, scam, verdict);
      const mail = kept && d.mail.get ? await d.mail.get(id).catch(() => null) : null;
      // One the owner already replied to is dealt with: off the dashboard, its loops closed (known, never a nudge). A mailbox's catch-up says so
      // (`replied`); so does the record, when the owner answered it from their phone before the Mac got to its summary (a sleeping computer, a
      // backlog): the summary then finds it already marked, and must neither open a loop for it nor tell the owner about it.
      const replied = b.replied === true || !!mail?.repliedAt;
      if (kept && b.replied === true && d.mail.replied) await d.mail.replied(id).catch(() => undefined);
      // Without a verdict the bridge decided (an older one, or a run that gave no category): its word stands. A catch-up is never told.
      const notify = b.quiet === true || mail?.repliedAt ? false : kept && verdict && d.mail.notifies ? await d.mail.notifies(id) : b.notify === true;
      res.json({ ok: kept, ...(verdict ? { notify } : {}) });
      if (kept && d.followups) {
        const fu = d.followups;
        const label = "email";
        const category = verdict?.category ?? categoryOf({ kind: worth ? "aviso" : "guardado", scam, summary });
        if (mail && category !== "suspicious" && fu.answered) {
          // The addresses Pako knows for the person who owed it: the owner's contacts, and the people on the mail the promise came from.
          // Never the new mail's own display name: that is anyone's to write.
          const known = async (l: Loop): Promise<string[]> => {
            const out = (d.contactEmails?.() ?? []).map((c) => `${c.name} <${c.address}>`);
            for (const s of l.sources.filter((x) => x.kind === "mail" && x.ref && x.ref !== id).slice(0, 5)) {
              const m = await d.mail?.get?.(s.ref!).catch(() => null);
              if (m) out.push(m.from, ...[m.to ?? "", m.cc ?? ""].flatMap((x) => x.split(",")).filter((x) => x.includes("@")));
            }
            return out;
          };
          void fu.answered({
            who: [senderName(mail.from), senderAddress(mail.from)], from: senderAddress(mail.from), ref: id, known, ...(mail.thread ? { thread: mail.thread } : {}),
          }).catch(() => undefined);
        }
        // The email's own words, read whole: one reading of it, so the triage's loop line is left out when the follow-ups take it.
        const whole = d.mail.followups && category !== "suspicious"
          ? await d.mail.followups(id, { category, ...(scam === undefined ? {} : { scam }), ...(replied ? { closed: true } : {}) }).catch(() => false)
          : false;
        const loop = verdict ? loopFromVerdict(verdict, mail ? senderName(mail.from) : "") : null;
        if (whole) {
          // Taken: its thread's job will come.
        } else if (loop && fu.fromMail) {
          void fu.fromMail({
            ref: id, label: mail ? `${label} · ${senderName(mail.from)}` : label, at: mail?.at ?? now(), loops: [loop], ...(replied ? { closed: true } : {}),
            ...(mail?.thread ? { thread: mail.thread } : {}),
          }).catch(() => undefined);
        } else if (category === "needs_you" && summary) {
          void fu.offer({ source: "mail", ref: id, label, text: summary, ...(replied ? { closed: true } : {}) }).catch(() => undefined);
        }
      }
      // A mailbox's catch-up hears each verdict: its "Caught up" line counts what needs the owner.
      if (b.quiet === true && d.backfillAnswered) void d.backfillAnswered(id, { worth: b.worth === true && scam !== true, replied }).catch(() => undefined);
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });

  /**
   * Notes, a few at a time: more would be a runaway or an injection. What really changed (a note kept, notes deleted, an old one pushed out by
   * the limit) is told to the owner in a receipt with Undo. `key` (newer bridges): the answer they belong to, whose reply the receipt follows.
   */
  app.post("/assistant/memory", failed, bridge, json, async (req, res) => {
    const b = (req.body ?? {}) as { remember?: unknown; forget?: unknown; key?: unknown };
    const remember = strings(b.remember, 3, 3, 300);
    const forget = strings(b.forget, 2, 4, 80);
    const changes: Change[] = [];
    let answer: { status: number; body: Record<string, unknown> };
    try {
      for (const t of remember) {
        const r = await d.memory.addNote(t, now());
        // The note the limit pushed out goes first: an undo runs backwards, so the new note leaves before the old one needs its room back.
        if (r.dropped.length) changes.push({ kind: "notes-forgotten", notes: r.dropped });
        if (r.added) changes.push({ kind: "note-added", note: r.added });
      }
      let forgotten = 0;
      for (const m of forget) {
        const gone = await d.memory.forgetNotes(m);
        forgotten += gone.length;
        if (gone.length) changes.push({ kind: "notes-forgotten", notes: gone });
      }
      for (const t of remember) d.control?.log("note", tx("logNoteKept", { text: t }));
      if (forgotten) d.control?.log("note", tx("logNotesForgotten", { n: forgotten, words: forget.join(", ") }));
      answer = { status: 200, body: { remembered: remember.length, forgotten } };
    } catch (err) {
      answer = { status: 503, body: { error: (err as Error).message } };
    }
    // What did change is told even when the store failed half way (the bridge sends it all again, and a note kept already is not kept twice).
    // Before the answer: an old bridge sends its reply right after it, and the receipt must not come after that reply's text.
    await noteReceipt(keyOf(b.key), changes);
    res.status(answer.status).json(answer.body);
  });
}

/**
 * The verdict as the bridge sent it, read again here field by field (the bridge is ours, but its JSON crosses the network): rebuilt as the
 * triage's own lines and read by the same reader, so nothing the reader would refuse gets through. Undefined when there is none.
 */
function verdictOf(v: unknown): Verdict | undefined {
  if (!v || typeof v !== "object") return undefined;
  const x = v as { category?: unknown; why?: unknown; security?: unknown; ask?: { action?: unknown; text?: unknown }; loop?: { title?: unknown; who?: unknown; due?: unknown } };
  const word = typeof x.category === "string" ? (VERDICT_WORD as Record<string, string>)[x.category] : undefined;
  if (!word) return undefined;
  const s = (u: unknown): string => (typeof u === "string" ? u.replace(/[|\n\r]/g, " ") : "");
  const lines = [
    `${word}${x.security === true ? " SECURITY" : ""}`,
    `WHY: ${s(x.why)}`,
    ...(x.ask ? [`ASK: ${s(x.ask.action)} | ${s(x.ask.text)}`] : []),
    ...(x.loop ? [`LOOP: ${s(x.loop.title)} | ${s(x.loop.who)} | ${s(x.loop.due)}`] : []),
    "",
  ];
  return readVerdict(lines.join("\n"))?.verdict;
}
