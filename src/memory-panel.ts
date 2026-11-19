// The panel's Memory card: the owner's notes with their numbers (the same as NOTAS / NOTES gives), and, on a person's computer, a way to
// correct or delete each one. A server's panel reads them only: there the notes are changed in the chat (EDIT 3: …, FORGET 3),
// where each change comes with its receipt and Deshacer.
//
// The same protection as the STOP switch: the panel's signed-in session, and on a POST the x-pako header that another site cannot send.
//   GET  /panel/api/memory          -> { notes: [{ id, at, text }] oldest first, max, calls, lastCallAt, editable }
//   POST /panel/api/memory/edit     { id, text, was } -> { ok: true, note } | { error }
//   POST /panel/api/memory/delete   { id, was }       -> { ok: true, note } | { error }
// `was` is the note's words as the page showed them: when the note has changed since (the assistant, the chat, another tab), nothing is
// changed and the answer is 409 "changed", so the page shows the note as it is now before anyone overwrites it. `error` is a code the page
// puts in words: gone, changed, duplicate, long, empty, same, bad, store.

import express, { type Express, type Request, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import type { Control } from "./control.ts";
import type { Lang } from "./i18n.ts";
import { MAX_NOTES, noteWords, type MemoryStore } from "./voice-memory.ts";
import { createLog } from "./log.ts";

const log = createLog("panel");

export interface MemoryPanelDeps {
  /** The panel's session check (src/dashboard.ts). */
  signedIn: (req: Request) => boolean;
  memory: MemoryStore;
  /** True on a person's computer (local mode): the notes can be changed here. False on a server: read only. */
  editable: boolean;
  /** The language of the log's lines (always English: src/i18n.ts). */
  lang: () => Lang;
  control?: Control;
}

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

export function mountMemoryPanel(app: Express, d: MemoryPanelDeps): void {
  // Not signed in is answered before anything is counted: only the owner's own requests use up the allowance.
  const auth = (post: boolean): RequestHandler => (req, res, next) => {
    res.set(HEADERS);
    if (post && !d.editable) {
      res.status(404).json({ error: "local mode only" });
      return;
    }
    if (!d.signedIn(req) || (post && req.get("x-pako") !== "1")) {
      res.status(401).json({ error: "sign in" });
      return;
    }
    next();
  };
  const limit = (n: number) =>
    rateLimit({ windowMs: 60_000, limit: n, standardHeaders: "draft-8", legacyHeaders: false, handler: (_req, res) => void res.status(429).json({ error: "too many" }) });
  const reads = limit(120);
  const writes = limit(30);
  const json = express.json({ limit: "4kb" });
  /** The note and the words the page showed, or null when the body is not that. */
  const target = (body: unknown): { id: number; was: string } | null => {
    const b = (body ?? {}) as { id?: unknown; was?: unknown };
    return typeof b.id === "number" && Number.isInteger(b.id) && b.id > 0 && typeof b.was === "string" ? { id: b.id, was: b.was } : null;
  };

  app.get("/panel/api/memory", auth(false), reads, async (_req, res) => {
    try {
      const [notes, mem] = await Promise.all([d.memory.numbered(), d.memory.read()]);
      res.json({ notes, max: MAX_NOTES, calls: mem.calls.length, lastCallAt: mem.calls.at(-1)?.at ?? null, editable: d.editable });
    } catch (err) {
      log.error(`could not read the notes: ${(err as Error).message}`);
      res.status(503).json({ error: "store" });
    }
  });

  app.post("/panel/api/memory/edit", auth(true), writes, json, async (req, res) => {
    const t = target(req.body);
    const text = (req.body as { text?: unknown } | undefined)?.text;
    if (!t || typeof text !== "string") {
      res.status(400).json({ error: "bad" });
      return;
    }
    try {
      const r = await d.memory.editNote(t.id, text, t.was);
      if (r.status === "edited" || r.status === "same") {
        if (r.status === "edited") d.control?.log("note", noteWords(d.lang())("logEditedPanel", { id: r.after.id, text: r.after.text }));
        res.json({ ok: true, ...(r.status === "edited" ? { note: r.after } : {}) });
        return;
      }
      const code = { gone: 404, changed: 409, duplicate: 409, empty: 400, long: 400 }[r.status];
      res.status(code).json({ error: r.status, ...(r.status === "changed" ? { note: r.now } : {}) });
    } catch (err) {
      log.error(`could not change a note: ${(err as Error).message}`);
      res.status(503).json({ error: "store" });
    }
  });

  app.post("/panel/api/memory/delete", auth(true), writes, json, async (req, res) => {
    const t = target(req.body);
    if (!t) {
      res.status(400).json({ error: "bad" });
      return;
    }
    try {
      const r = await d.memory.removeNoteById(t.id, t.was);
      if (r === "changed" || !r) {
        res.status(r ? 409 : 404).json({ error: r ? "changed" : "gone" });
        return;
      }
      d.control?.log("note", noteWords(d.lang())("logDeletedPanel", { id: r.id, text: r.text }));
      res.json({ ok: true, note: r });
    } catch (err) {
      log.error(`could not delete a note: ${(err as Error).message}`);
      res.status(503).json({ error: "store" });
    }
  });
}
