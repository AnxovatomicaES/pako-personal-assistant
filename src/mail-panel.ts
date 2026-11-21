// The panel's mail: the dashboard's "Needs you" preview, the Mail section's reader and Move to…, Done with its Undo, and the Mail settings (the
// notification switches and the sender rules learned from Move to…). Everything here acts on Pako's own records only: the owner's real mailbox
// is never touched (no flag, no archive, no move on their server).
//
// The same protection as the STOP switch: the panel's signed-in session, and on a POST the x-pako header that another site cannot send.
//   GET  /panel/api/mail/view                 -> { connected, needs: { rows, more }, loops: { [mailId]: { open, title, due? } } }
//   GET  /panel/api/mail/item?id=             -> { item, text, partial, link, loops } (opening it counts as read)
//   POST /panel/api/mail/move    { id, category }   -> { ok, item, rule }
//   POST /panel/api/mail/done    { id }             -> { ok, closed }
//   POST /panel/api/mail/undone  { id }             -> { ok, reopened }
//   GET  /panel/api/mail/settings              -> { notify, defaults, labels, rules }
//   POST /panel/api/mail/notify  { key, on }        -> { notify }
//   POST /panel/api/mail/rule/delete { from }       -> { ok }
//
// An email is a stranger's text. The reader gives it as plain text only (the words kept at intake, already turned from HTML into text, with
// the one-time codes hidden): no HTML, no remote image, no script; a link is shown as text and never loaded. The page puts it on the screen as
// text, never as HTML.

import express, { type Express, type Request, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import {
  CATEGORIES, CATEGORY_LABEL, isCategory, needsPreview, NOTIFY_DEFAULTS, NOTIFY_KEYS, openLink, type NotifyKey, type PreviewLoop,
} from "./mail-categories.ts";
import type { Loop } from "./followups.ts";
import { htmlToText, type Mailbox } from "./mail.ts";
import { createLog } from "./log.ts";

const log = createLog("mail");

export interface MailPanelDeps {
  /** The panel's session check (src/dashboard.ts). */
  signedIn: (req: Request) => boolean;
  /** Null when no mailbox is connected: the routes say so and the dashboard hides the preview. */
  box: Mailbox | null;
  timeZone: string;
  /** The follow-ups' loops from mail (src/followups/mail.ts), looked up when used: null when the follow-ups are off. */
  loops: () => {
    all: () => Promise<Loop[]>;
    doneFor: (ref: string) => Promise<string[]>;
    reopen: (ids: string[]) => Promise<number>;
  } | null;
  /** Whether gentle mode is on (src/gentle.ts): the page then shows a passed time as "time passed", never "overdue" or in red. */
  gentle?: () => Promise<boolean>;
  now?: () => number;
}

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const READER_MAX = 12_000;

/**
 * An email's words as the reader shows them: plain text. Words that still look like HTML (a text part that carries markup) are made text the
 * way the intake does it (scripts, styles and tags dropped, so no image or script survives); characters that hide or reorder text removed.
 */
export function readerText(raw: string): string {
  const looksHtml = /<\s*(?:html|body|div|p|br|img|script|style|a|table|span|iframe)\b/i.test(raw);
  const text = looksHtml ? htmlToText(raw) : raw;
  return text.replace(INVISIBLE, "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, READER_MAX);
}

/** The loops of each mail, by mail id (a loop merged from several mails counts for each of them). */
const byMail = (loops: Loop[]): Map<string, Loop[]> => {
  const out = new Map<string, Loop[]>();
  for (const l of loops) {
    for (const s of l.sources) {
      if (s.kind !== "mail" || !s.ref) continue;
      out.set(s.ref, [...(out.get(s.ref) ?? []), l]);
    }
  }
  return out;
};
const isOpen = (l: Loop): boolean => l.status === "open" || l.status === "snoozed";

/** The dashboard's preview and each mail's loop status, from the mailbox and the loops as they are now. */
export async function mailView(d: Pick<MailPanelDeps, "box" | "timeZone" | "loops" | "gentle">, now: number) {
  const gentle = d.gentle ? await d.gentle().catch(() => false) : false;
  if (!d.box) return { connected: false as const, needs: { rows: [], more: 0 }, loops: {}, gentle };
  const items = await d.box.items(150);
  const engine = d.loops();
  const loops = engine ? byMail(await engine.all().catch(() => [])) : new Map<string, Loop[]>();
  const of = (id: string): PreviewLoop[] => (loops.get(id) ?? []).map((l) => ({ open: isOpen(l), ...(l.dueAt ? { dueAt: l.dueAt } : {}) }));
  const needs = needsPreview(items, of, { now, timeZone: d.timeZone });
  const status: Record<string, { open: boolean; title: string; due?: number }> = {};
  for (const m of items.slice(0, 60)) {
    const l = loops.get(m.id)?.[0];
    if (l) status[m.id] = { open: isOpen(l), title: l.title, ...(l.dueAt ? { due: l.dueAt } : {}) };
  }
  return { connected: true as const, needs, loops: status, gentle };
}

export function mountMailPanel(app: Express, d: MailPanelDeps): void {
  const now = d.now ?? Date.now;
  const auth = (post: boolean): RequestHandler => (req, res, next) => {
    res.set(HEADERS);
    if (!d.signedIn(req) || (post && req.get("x-pako") !== "1")) return void res.status(401).json({ error: "sign in" });
    if (!d.box) return void res.status(404).json({ error: "no mail" });
    next();
  };
  const limit = (n: number) =>
    rateLimit({ windowMs: 60_000, limit: n, standardHeaders: "draft-8", legacyHeaders: false, handler: (_req, res) => void res.status(429).json({ error: "too many" }) });
  const reads = limit(240);
  const writes = limit(60);
  const json = express.json({ limit: "2kb" });
  const idOf = (v: unknown): string => (typeof v === "string" ? v.slice(0, 300) : "");
  const fail = (res: express.Response, err: unknown): void => {
    log.error(`the panel: ${(err as Error).message}`);
    res.status(503).json({ error: "store" });
  };

  // Answers even without a mailbox: the dashboard hides the preview then.
  app.get("/panel/api/mail/view", reads, async (req, res) => {
    res.set(HEADERS);
    if (!d.signedIn(req)) return void res.status(401).json({ error: "sign in" });
    try {
      res.json(await mailView(d, now()));
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/panel/api/mail/item", auth(false), reads, async (req, res) => {
    const id = idOf(req.query.id);
    try {
      const item = await d.box!.get(id);
      if (!item) return void res.status(404).json({ error: "gone" });
      const kept = await d.box!.body(id);
      // Mail kept before the reader existed has no words of its own: its summary or first lines, said to be partial.
      const text = readerText(kept || item.summary || item.preview || "");
      await d.box!.opened(id, now());
      const engine = d.loops();
      const loops = engine ? (byMail(await engine.all().catch(() => [])).get(id) ?? []).map((l) => ({ title: l.title, open: isOpen(l), ...(l.dueAt ? { due: l.dueAt } : {}) })) : [];
      res.json({ item, text, partial: !kept, link: openLink(item), loops });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/panel/api/mail/move", auth(true), writes, json, async (req, res) => {
    const b = (req.body ?? {}) as { id?: unknown; category?: unknown };
    if (!isCategory(b.category)) return void res.status(400).json({ error: "bad" });
    try {
      const item = await d.box!.move(idOf(b.id), b.category, now());
      if (!item) return void res.status(404).json({ error: "gone" });
      res.json({ ok: true, item, rule: (await d.box!.rules()).at(-1) ?? null });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/panel/api/mail/done", auth(true), writes, json, async (req, res) => {
    const id = idOf((req.body as { id?: unknown } | undefined)?.id);
    try {
      if (!(await d.box!.get(id))) return void res.status(404).json({ error: "gone" });
      // Its loops close through the nudge button's own path, so it never nags again and leaves the brief; kept on the mail for Undo.
      const engine = d.loops();
      const closed = engine ? await engine.doneFor(id) : [];
      await d.box!.handle(id, true, now(), closed);
      res.json({ ok: true, closed });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/panel/api/mail/undone", auth(true), writes, json, async (req, res) => {
    const id = idOf((req.body as { id?: unknown } | undefined)?.id);
    try {
      const was = await d.box!.handle(id, false, now());
      if (!was) return void res.status(404).json({ error: "gone" });
      const engine = d.loops();
      const reopened = engine && was.closedLoops?.length ? await engine.reopen(was.closedLoops) : 0;
      res.json({ ok: true, reopened });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/panel/api/mail/settings", auth(false), reads, async (_req, res) => {
    try {
      const labels = Object.fromEntries([...CATEGORIES.map((c) => [c, CATEGORY_LABEL[c]]), ["security", "Security alerts"]]);
      res.json({ notify: await d.box!.notifyPrefs(), defaults: NOTIFY_DEFAULTS, keys: NOTIFY_KEYS, labels, rules: await d.box!.rules() });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/panel/api/mail/notify", auth(true), writes, json, async (req, res) => {
    const b = (req.body ?? {}) as { key?: unknown; on?: unknown };
    if (!(NOTIFY_KEYS as readonly unknown[]).includes(b.key) || typeof b.on !== "boolean") return void res.status(400).json({ error: "bad" });
    try {
      res.json({ notify: await d.box!.setNotify(b.key as NotifyKey, b.on) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/panel/api/mail/rule/delete", auth(true), writes, json, async (req, res) => {
    const from = idOf((req.body as { from?: unknown } | undefined)?.from);
    try {
      res.json({ ok: await d.box!.forgetRule(from) });
    } catch (err) {
      fail(res, err);
    }
  });
}
