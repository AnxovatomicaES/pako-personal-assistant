// Moving from a server to a computer: the server's panel gives a file with what Pako keeps for its owner (src/data.ts exportData, with the
// server's own settings that are not secrets), and the computer's panel takes it in ("Importar de otro Pako"), so nothing is lost on the way.
//
//   GET  /panel/api/move              -> { mode: "server" | "computer" }: which card the panel shows
//   GET  /panel/api/move/export       -> (a server only) the file to take to the computer, as a download
//   POST /panel/api/move/import       { file, confirm?: true } -> (a computer only) without confirm, the plan: what would come in, what
//                                        would be replaced, what is left out and why; nothing is written. With confirm: the file is taken in,
//                                        what it replaces is kept first in ~/.pako/import-backup-<time>.json, and Pako starts again.
//
// The file is checked, not trusted: a size cap, the "pako-export" format, and an allow-list of keys (the person's things: notes, reminders,
// lists, people, routines, follow-ups and their 👍/👎, meetings, the brief's day, what was already told), each with the kind of value it must hold. Never a
// secret (the export carries none, and the keys that hold them are not on the list), never this computer's own state (its pause, its inbox,
// its store's marks, its Telegram pairing: a pairing from a file would let whoever wrote it talk to this Pako). The settings come in only
// where nothing is set here yet; those the panel cannot set are listed for the person to copy. Nothing is written without a confirm.
//
// The same protection as the rest of the panel: its signed-in session and the x-pako header another site cannot send.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import express, { type Express, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { KEYS as CONNECTION_KEYS, readStored, writeStored } from "./connections.ts";
import type { Control } from "./control.ts";
import { aboutKey, exportData, factFor, type DataStore } from "./data.ts";
import { ownerTimeZone } from "./region.ts";
import { texts, type Lang } from "./i18n.ts";
import { createLog } from "./log.ts";

const logMove = createLog("move");

type Env = Record<string, string | undefined>;

/** The largest file taken in: a year of a busy person's things is far less. */
export const IMPORT_MAX_BYTES = 8 * 1024 * 1024;
const VALUE_MAX = 2 * 1024 * 1024;
const ENTRIES_MAX = 200;

/** The keys a move carries, each with the kind of value it must hold. Everything else in a file is left out. */
export const MOVE_KEYS: Readonly<Record<string, "json" | "text">> = {
  "owner-memory": "json",
  "assistant-reminders": "json",
  "assistant-reminders-fired": "json", // so a reminder the server already sent is not sent again
  "assistant-lists": "json",
  "assistant-people": "json",
  "assistant-routines": "json",
  "followups": "json",
  "lessons": "json", // what Pako learned from the owner's corrections (src/lessons.ts)
  "feedback": "json", // the 👍/👎 and what was pressed on each nudge (src/quality.ts): the Calidad card's week comes along
  "meeting-reviews": "json",
  "brief-state": "json", // the day of the last brief: not sent twice on the day of the move
  "owner-language": "text",
  "zoom-state": "json", // the meetings already told
  "slack-alerts": "json",
  "slack-poll": "json", // where each Slack conversation was read up to
  "calendar-state": "json", // the events already reminded
  "assistant-mail": "json", // the mail already looked at
  "assistant-imap": "json",
  "memory-facts": "json", // the dated facts the owner told, with their history (src/memory-facts.ts)
  "people-identities": "json", // the same-person answers and identities (src/people-graph.ts): not asked again
};

/** Keys left out because they hold a secret (never in a file, and never taken from one). */
const SECRET_KEYS = new Set(["zoho-refresh", "telegram-pair", "assistant-mail-codes"]);

/** A server's settings that are not secrets, which the computer can take over. The panel can set the first kind; the rest go in ~/.pako/.env. */
export const MOVE_SETTINGS = [
  "PERSONAL_TIMEZONE", "PERSONAL_QUIET_HOURS", "MORNING_BRIEF", "BRIEF_SMART", "CALENDAR_REMIND_MINUTES",
  "SLACK_QUIET_HOURS", "SLACK_FORWARD", "ZOOM_USER", "ZOOM_POLL_MINUTES", "ZOOM_REVIEW", "ZOOM_REVIEW_WAIT_MIN",
  "FOLLOWUPS", "FOLLOWUP_DELAY_MIN", "FOLLOWUP_MAX_PER_DAY", "FOLLOWUP_QUIET_HOURS", "WATCHDOG", "WATCHDOG_QUIET_HOURS",
  "AGENTMAIL_INBOX", "AGENTMAIL_POLL_MINUTES", "AGENTMAIL_WORK_DOMAINS", "AGENTMAIL_VIP", "RESEND_FROM", "RESEND_REPLY_TO",
  "IMAP_HOST", "IMAP_USER", "IMAP_PORT", "IMAP_FOLDERS", "IMAP_POLL_MINUTES",
] as const;
const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD|_URL$/;

const T = texts(
  {
    notJson: "That file is not a Pako export (it is not JSON).",
    tooBig: "The file is too big (over 8 MB).",
    notExport: "That file is not a Pako export.",
    version: "That export is from a version of Pako this one does not understand. Update Pako and try again.",
    confirm: "Check what comes in, and confirm.",
    failed: "I couldn't import it right now. Nothing has changed. Try again.",
    half: "I couldn't finish: part of it is in already. What was replaced is kept in {file}, in Pako's folder. Try again.",
    noBackup: "I couldn't keep a copy of what would be replaced, so I changed nothing. Check that Pako's folder can be written.",
    secret: "A secret: never imported",
    own: "It belongs to that Pako (its pause, its inbox, its Telegram, its watchdog, its last rehearsal): this one has its own",
    badValue: "It does not have the expected shape",
    log: "Imported from another Pako: {n} thing(s)",
    restart: "Start Pako again to finish (quit it and open it).",
  },
);

/** The server's settings that are not secrets, as they are set now (the export's `server.settings`). */
export function serverSettings(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of MOVE_SETTINGS) {
    const v = (env[k] ?? "").trim();
    if (v && !SECRET_NAME.test(k)) out[k] = v;
  }
  return out;
}

interface Entry {
  key: string;
  raw: string;
}

export interface MoveFile {
  entries: Entry[];
  skipped: { key: string; why: "secret" | "own" | "badValue" }[];
  ownerName: string;
  settings: Record<string, string>;
}

const plainText = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length <= max && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v) ? v.trim() : null;

/** A file checked against the allow-list: its entries as they would be stored, and what is left out and why. A string when it is no export. */
export function readMoveFile(body: unknown): MoveFile | "notExport" | "version" {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "notExport";
  const f = body as { format?: unknown; version?: unknown; store?: unknown; server?: unknown; settings?: unknown };
  if (f.format !== "pako-export") return "notExport";
  if (f.version !== 1) return "version";
  if (!f.store || typeof f.store !== "object" || Array.isArray(f.store)) return "notExport";
  const all = Object.entries(f.store as Record<string, unknown>);
  if (all.length > ENTRIES_MAX) return "notExport";
  const entries: Entry[] = [];
  const skipped: MoveFile["skipped"] = [];
  for (const [key, item] of all) {
    const kind = Object.hasOwn(MOVE_KEYS, key) ? MOVE_KEYS[key] : undefined;
    if (!kind) {
      skipped.push({ key: key.slice(0, 80), why: SECRET_KEYS.has(key) ? "secret" : "own" });
      continue;
    }
    const value = item && typeof item === "object" && !Array.isArray(item) ? (item as { value?: unknown }).value : undefined;
    let raw: string | null = null;
    if (kind === "text") raw = plainText(value, 100);
    else if (value && typeof value === "object") {
      const s = JSON.stringify(value);
      raw = s.length <= VALUE_MAX ? s : null;
    }
    if (raw === null || raw === "") skipped.push({ key, why: "badValue" });
    else entries.push({ key, raw });
  }
  // The owner's name: a server's, or the choice made on another computer.
  const server = f.server && typeof f.server === "object" ? (f.server as { ownerName?: unknown; settings?: unknown }) : {};
  const chosen = f.settings && typeof f.settings === "object" ? (f.settings as { name?: unknown }).name : undefined;
  const ownerName = plainText(server.ownerName, 60) ?? plainText(chosen, 60) ?? "";
  const settings: Record<string, string> = {};
  const given = server.settings && typeof server.settings === "object" && !Array.isArray(server.settings) ? (server.settings as Record<string, unknown>) : {};
  for (const k of MOVE_SETTINGS) {
    const v = Object.hasOwn(given, k) ? plainText(given[k], 300) : null;
    if (v && !/[\r\n]/.test(v)) settings[k] = v;
  }
  return { entries, skipped, ownerName, settings };
}

export interface MovePlan {
  items: { key: string; what: string; action: "new" | "replace" | "same" }[];
  skipped: { key: string; what: string; why: string }[];
  /** The owner's name, taken only when this Pako has none yet. */
  name: string | null;
  /** Settings the panel will set (nothing set here yet), and those to put in ~/.pako/.env by hand (they differ from what is set here). */
  settings: { set: string[]; byHand: { key: string; value: string }[] };
}

export interface MoveDeps {
  signedIn: (req: express.Request) => boolean;
  env: Env;
  lang: () => Lang;
  control: Control;
  /** "server": the export for the move; "computer": the import. */
  mode: "server" | "computer";
  /** The store: the server's to export, the computer's file store to import into. */
  store: DataStore;
  /** Pako's folder on a computer (the backup and the panel's settings); on a server, unused. */
  dir: string;
  /** A server's owner and time zone, for its export. */
  server?: { ownerName: string; timeZone: string };
  /** The computer's settings (src/local.ts): its name, set when it has none. */
  settings?: { name: () => string; setName: (n: string) => void };
  restart?: () => boolean | void;
  now?: () => number;
}

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

/** What the import would do, written nowhere. */
async function plan(d: MoveDeps, file: MoveFile, l: Lang): Promise<MovePlan> {
  const t = T(l);
  const items: MovePlan["items"] = [];
  for (const e of file.entries) {
    const here = await d.store.get(e.key);
    items.push({ key: e.key, what: aboutKey(e.key, l), action: here === null ? "new" : here === e.raw ? "same" : "replace" });
  }
  const stored = readStored(d.dir) ?? {};
  const set: string[] = [];
  const byHand: { key: string; value: string }[] = [];
  for (const [k, v] of Object.entries(file.settings)) {
    const here = (d.env[k] ?? "").trim() || (stored[k] ?? "");
    if (here === v) continue;
    if (CONNECTION_KEYS.has(k) && !here) set.push(k);
    else byHand.push({ key: k, value: v });
  }
  return {
    items,
    skipped: file.skipped.map((s) => ({ key: s.key, what: aboutKey(s.key, l), why: t(s.why) })),
    name: file.ownerName && d.settings && !d.settings.name() ? file.ownerName : null,
    settings: { set, byHand },
  };
}

/** The panel's move routes. */
export function mountMovePanel(app: Express, d: MoveDeps): void {
  const now = d.now ?? Date.now;
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

  app.get("/panel/api/move", auth(false), limit(60), (_req, res) => {
    res.json({ mode: d.mode });
  });

  app.get("/panel/api/move/export", auth(true), limit(10), async (_req, res) => {
    if (d.mode !== "server") {
      res.status(404).json({ error: "a server only: on a computer, the Privacy card's export" });
      return;
    }
    try {
      const at = now();
      const server = { ownerName: d.server?.ownerName ?? "", timeZone: d.server?.timeZone ?? ownerTimeZone(d.env.PERSONAL_TIMEZONE).timeZone, settings: serverSettings(d.env) };
      const body = await exportData({ store: d.store, dir: d.dir, env: d.env, lang: d.lang(), now: at, server });
      res.set("Content-Disposition", `attachment; filename="pako-move-${new Date(at).toISOString().slice(0, 10)}.json"`);
      res.type("application/json").send(JSON.stringify(body, null, 2));
    } catch (err) {
      logMove.error(`the export: ${(err as Error).message}`);
      res.status(500).json({ error: T(d.lang())("failed") });
    }
  });

  let busy = false;
  app.post(
    "/panel/api/move/import",
    auth(true),
    limit(20),
    express.json({ limit: IMPORT_MAX_BYTES }),
    async (req, res) => {
      const l = d.lang();
      const t = T(l);
      if (d.mode !== "computer") {
        res.status(404).json({ error: "a computer only" });
        return;
      }
      const body = (req.body ?? {}) as { file?: unknown; confirm?: unknown };
      const file = readMoveFile(body.file);
      if (typeof file === "string") {
        res.status(400).json({ error: t(file) });
        return;
      }
      const p = await plan(d, file, l);
      if (body.confirm !== true) {
        res.json({ ok: true, confirm: t("confirm"), plan: p });
        return;
      }
      if (busy) {
        res.status(409).json({ error: t("failed") });
        return;
      }
      busy = true;
      let wrote = 0;
      let backupName: string | null = null;
      try {
        // What would be replaced is kept first: a person who confirmed too fast can still get it back.
        const replaced: Record<string, string> = {};
        for (const i of p.items) {
          if (i.action !== "replace") continue;
          const here = await d.store.get(i.key);
          if (here !== null) replaced[i.key] = here;
        }
        let backup: string | null = null;
        if (Object.keys(replaced).length) {
          backup = join(d.dir, `import-backup-${new Date(now()).toISOString().replace(/[:.]/g, "-")}.json`);
          try {
            writeFileSync(backup, JSON.stringify({ format: "pako-import-backup", at: new Date(now()).toISOString(), store: replaced }, null, 2), { mode: 0o600 });
          } catch (err) {
            logMove.error(`the backup (${(err as NodeJS.ErrnoException).code ?? "error"})`);
            res.status(500).json({ error: t("noBackup") });
            return;
          }
          backupName = backup.split(/[\\/]/).pop()!;
        }
        let n = 0;
        for (const e of file.entries) {
          const action = p.items.find((i) => i.key === e.key)?.action;
          if (action === "same") continue;
          const keep = factFor(e.key)?.keep ?? 30 * 24 * 3600;
          await d.store.set(e.key, e.raw, keep);
          n++;
          wrote = n;
        }
        if (p.name && d.settings) d.settings.setName(p.name);
        if (p.settings.set.length) {
          const patch: Record<string, string> = {};
          for (const k of p.settings.set) patch[k] = file.settings[k]!;
          if (!writeStored(d.dir, patch)) logMove.error("the settings could not be kept: set them in the panel's connections");
        }
        d.control.log("panel", t("log", { n }));
        const r = d.restart ?? (app.locals.restart as (() => boolean | void) | undefined);
        const restarting = typeof r === "function";
        if (restarting) {
          res.on("finish", () => setTimeout(() => {
            if (r() === false) logMove.error("Pako could not start again by itself: stop it and start it again to finish the import");
          }, 200).unref?.());
        }
        res.json({
          ok: true, imported: n, backup: backupName, restarting, byHand: p.settings.byHand,
          ...(restarting ? {} : { note: t("restart") }),
        });
      } catch (err) {
        logMove.error(`the import: ${(err as Error).message}`);
        // Halfway: said plainly, with where the replaced things are kept (a second try writes the same again).
        res.status(500).json({ error: wrote ? t("half", { file: backupName ?? "-" }) : t("failed") });
      } finally {
        busy = false;
      }
    },
  );
}
