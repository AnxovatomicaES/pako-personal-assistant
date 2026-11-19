// Your data from the panel, on a person's computer (local mode only): what is kept and where, the export, deleting everything (src/data.ts).
//
//   GET  /panel/api/privacy      -> the facts for the Privacy card
//   GET  /panel/api/export       -> a JSON download of everything Pako keeps about the person, with no secret in it
//   POST /panel/api/delete-all   { confirm: "DELETE EVERYTHING" } -> { ok, restarting, removed, kept } | { error }
//
// The same protection as the STOP switch: the panel's signed-in session, and the x-pako header another site cannot send, on the export too
// (it is everything about the person: the page fetches it and saves it, a plain link could not). Deleting asks for one more thing: the phrase.
// A server's panel has none of this (every route answers 404): there the data lives in its Key Value store, managed where it is hosted.

import express, { type Express, type RequestHandler, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import type { Control } from "./control.ts";
import { CONFIRM, confirmed, deleteEverything, exportData, privacy, restartLine, type DataStore } from "./data.ts";
import { texts, type Lang } from "./i18n.ts";
import { pakoHome } from "./local.ts";
import { createLog } from "./log.ts";

const log = createLog("data");

type Env = Record<string, string | undefined>;

const T = texts(
  {
    confirm: "To delete everything, type {phrase} exactly.",
    busy: "I'm already deleting everything. Wait a moment.",
    noWipe: "This store can't be emptied from here.",
    failed: "I couldn't do it right now. Try again.",
    notStored:
      "I couldn't delete your data from ~/.pako/kv.db: the disk is full or the folder can't be written. Pako stays paused and keeps nothing "
      + "new: free some space or check the folder, then press again.",
  },
);

export interface DataPanelDeps {
  /** The panel's session check (src/dashboard.ts). */
  signedIn: (req: express.Request) => boolean;
  env: Env;
  /** The language of the card and of the answers (always English: src/i18n.ts). */
  lang: () => Lang;
  control: Control;
  /** The file store at home (src/sqlite-kv.ts): it lists its keys and can be emptied. */
  store: DataStore;
  /** The chat window's conversation (src/local.ts createLocalChannel). */
  chat?: { forget: () => void };
  /** Pako's folder; ~/.pako (PAKO_HOME) without it. */
  dir?: string;
  /** Starts Pako again (src/server.ts sets app.locals.restart). Without it, app.locals.restart is asked when it is needed. */
  restart?: () => boolean | void;
  now?: () => number;
}

const PATHS = ["/panel/api/privacy", "/panel/api/export", "/panel/api/delete-all"];
const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

/** The panel's data routes. `d` null: not a person's computer, and every route answers 404. */
export function mountDataPanel(app: Express, d: DataPanelDeps | null): void {
  if (!d) {
    app.all(PATHS, (_req, res) => {
      res.status(404).set(HEADERS).json({ error: "local mode only" });
    });
    return;
  }
  const dir = d.dir ?? pakoHome(d.env);
  const now = d.now ?? Date.now;
  const restartFn = (): (() => boolean | void) | null => {
    const r = d.restart ?? (app.locals.restart as unknown);
    return typeof r === "function" ? (r as () => boolean | void) : null;
  };
  /** Set once everything was deleted: the store takes no more writes, and a second press has nothing left to do. */
  let deleting = false;

  // Not signed in is answered before anything is counted: only the owner's own requests use up the allowance.
  const auth = (header: boolean): RequestHandler => (req, res, next) => {
    res.set(HEADERS);
    if (!d.signedIn(req) || (header && req.get("x-pako") !== "1")) {
      res.status(401).json({ error: "sign in" });
      return;
    }
    next();
  };
  const limit = (n: number) =>
    rateLimit({ windowMs: 60_000, limit: n, standardHeaders: "draft-8", legacyHeaders: false, handler: (_req, res) => void res.status(429).json({ error: "too many" }) });

  app.get("/panel/api/privacy", auth(false), limit(60), (_req, res) => {
    res.json(privacy({ dir, env: d.env, lang: d.lang() }));
  });

  app.get("/panel/api/export", auth(true), limit(10), async (_req, res) => {
    try {
      const at = now();
      const body = await exportData({ store: d.store, dir, env: d.env, lang: d.lang(), now: at });
      const day = new Date(at).toISOString().slice(0, 10);
      res.set("Content-Disposition", `attachment; filename="pako-export-${day}.json"`);
      res.type("application/json").send(JSON.stringify(body, null, 2));
    } catch (err) {
      log.error(`the export: ${(err as Error).message}`);
      res.status(500).json({ error: T(d.lang())("failed") });
    }
  });

  /** After the answer has gone: the page shows "starting again" and waits for the server to come back. */
  const restartAfter = (res: Response): boolean => {
    const r = restartFn();
    if (!r) return false;
    res.on("finish", () => setTimeout(() => {
      if (r() === false) log.error("Pako could not start again by itself: stop it and start it again to finish deleting");
    }, 200).unref?.());
    return true;
  };

  app.post("/panel/api/delete-all", auth(true), limit(20), express.json({ limit: "1kb" }), async (req, res) => {
    const l = d.lang();
    const t = T(l);
    if (!confirmed((req.body as { confirm?: unknown } | undefined)?.confirm)) {
      res.status(400).json({ error: t("confirm", { phrase: CONFIRM }) });
      return;
    }
    if (deleting) {
      res.status(409).json({ error: t("busy") });
      return;
    }
    deleting = true;
    let done: Awaited<ReturnType<typeof deleteEverything>>;
    try {
      done = await deleteEverything({ store: d.store, dir, env: d.env, control: d.control, lang: l, ...(d.chat ? { chat: d.chat } : {}), now: now() });
    } catch (err) {
      // Halfway, perhaps: a second try is allowed (each step can run again), and nothing more is written here.
      log.error(`deleting everything: ${(err as Error).message}`);
      deleting = false;
      res.status(500).json({ error: t("failed") });
      return;
    }
    if (!done.ok) {
      deleting = false;
      res.status(500).json({ error: t("noWipe") });
      return;
    }
    if (!done.stored) {
      // Starting again would read the old file back, with everything in it: no restart. Paused and sealed meanwhile; another press tries again.
      deleting = false;
      res.status(500).json({ error: t("notStored") });
      return;
    }
    const restarting = restartAfter(res);
    res.json({ ok: true, restarting, stored: done.stored, removed: done.removed, kept: restarting ? done.kept : [...done.kept, restartLine(l)] });
  });
}
