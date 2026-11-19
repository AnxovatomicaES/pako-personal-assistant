// A photo or a PDF put in the panel's chat, on a computer (src/papers.ts says what happens to it next). A server's chat is WhatsApp or
// Telegram, where the door takes papers itself: this route is mounted in local mode only (src/app.ts).
//
//   POST /panel/api/chat/paper   the file itself as the body; its name in x-pako-name (URI-encoded)
//     -> 202 { ok: true } | { error }: type, heic, big, empty (what the bytes are or how big), store, sign in, too many
//
// The same protection as the chat: the panel's strict cookie and the x-pako header another site cannot send. Kept apart from src/papers.ts so
// the bridge, which imports that file on a computer that may have no npm packages, never loads express.

import express, { type Express, type Request, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { checkPaper, paperExt, paperName, PAPER_MAX, type PaperStore } from "./papers.ts";
import { createLog } from "./log.ts";

const log = createLog("papers");

export interface PaperUploadDeps {
  /** The panel's session check (src/dashboard.ts). */
  signedIn: (req: Request) => boolean;
  papers: PaperStore;
  /** The owner's line in the chat window ("📎 factura.pdf"). */
  push: (text: string) => Promise<unknown>;
  /** The paper as a message from the owner, handled by the door (src/whatsapp.ts) like one from WhatsApp. */
  ingest: (m: Record<string, unknown>) => void;
}

export function mountPaperUpload(app: Express, d: PaperUploadDeps): void {
  // Not signed in is answered before anything is counted or read: only the owner's own requests use up the allowance.
  const auth: RequestHandler = (req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    if (!d.signedIn(req) || req.get("x-pako") !== "1") {
      res.status(401).json({ error: "sign in" });
      return;
    }
    next();
  };
  const limiter = rateLimit({
    windowMs: 60_000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false, handler: (_req, res) => void res.status(429).json({ error: "too many" }),
  });
  const raw = express.raw({ type: () => true, limit: PAPER_MAX });
  // A body over the cap is said as such, in the page's own words (express would answer with its own error page).
  const body: RequestHandler = (req, res, next) =>
    raw(req, res, (err?: unknown) => {
      if (!err) return next();
      const status = (err as { status?: number }).status;
      res.status(status === 413 ? 413 : 400).json({ error: status === 413 ? "big" : "bad" });
    });
  app.post("/panel/api/chat/paper", auth, limiter, body, async (req, res) => {
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    // What the bytes are, never what the browser says (a file's type there comes from its name).
    const checked = checkPaper(bytes);
    if (!checked.ok) {
      res.status(checked.why === "big" ? 413 : checked.why === "empty" ? 400 : 415).json({ error: checked.why });
      return;
    }
    let name: string;
    try {
      name = paperName(decodeURIComponent(String(req.get("x-pako-name") ?? "")));
    } catch {
      name = "";
    }
    let id: string;
    try {
      id = d.papers.put(bytes, checked.mime, name);
    } catch (err) {
      log.error(`could not keep a file from the panel: ${(err as Error).message}`);
      res.status(503).json({ error: "store" });
      return;
    }
    await d.push(`📎 ${name || paperExt(checked.mime).toUpperCase()}`);
    d.ingest({ type: "paper", paper: { id } });
    res.status(202).json({ ok: true });
  });
}
