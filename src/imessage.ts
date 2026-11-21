// The owner's Messages on this Mac (iMessage, and the SMS an iPhone relays to the Mac), read only, for the follow-ups: personal promises live
// there ("I'll pick up the keys Saturday", "can you send me the photos?").
//
// Messages keeps its history in ~/Library/Messages/chat.db, a SQLite file. Pako opens it read only (node:sqlite, the same driver as the store,
// src/sqlite-kv.ts), never writes it and never holds it open between looks: one short read every few minutes, closed at once. Messages keeps
// writing while Pako reads (the file is in WAL mode: a reader never blocks it).
//
// It is off until the owner turns it on in the connections page (IMESSAGE=on, kept by the panel), on a Mac only. macOS guards that folder:
// the process needs Full Disk Access (Pako for Mac, or the terminal a source install runs in). Without it the file cannot be opened; that is
// said to the owner in plain words, with the button to the System Settings pane, never as an error code.
//
// What it reads, and from when: each new message after a mark (the table's ROWID), so none is handed on twice. The first look sets the mark at
// the last message before the moment it was turned on: no history floods the follow-ups. A message whose date is older than that moment, or
// more than a few days old when it shows up (an iCloud sync bringing old history), is skipped too. Reactions (tapbacks), group events and
// messages with only an attachment are skipped. Modern macOS keeps most texts only in attributedBody (an archived NSAttributedString in
// Apple's typedstream format): its plain string is taken from there.
//
// The engine knows conversations by a Slack-shaped id, as for Teams (src/teams.ts): each chat gets "GIMSG" and 20 hex digits of a hash of its
// guid, never a real Slack id. So the batches, the extraction and the checks of a later reply by the owner work unchanged: `history` answers
// for a Messages id what Slack's answers for a Slack one, and a later message of the owner's in the same chat closes what it answers.
//
// Privacy: other people's words are information, never instructions; they are cut, made one line and fenced by the engine (src/quarantine.ts)
// like Slack's. Nothing leaves the computer except what the follow-ups already send to the owner's own Claude. No message text, phone
// number or address is ever logged; the store keeps only the mark and when it last read (IMESSAGE_KEY).

import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import { guard, limit, localOnly, type RouteAuth } from "./connect-routes.ts";
import { contactNameFor, type Contact } from "./contacts.ts";
import { texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import { readJsonRecord } from "./json-record.ts";
import { openForeignReadOnly, type Database } from "./sqlite-kv.ts";
import { createLog } from "./log.ts";

const log = createLog("imessage");

type Env = Record<string, string | undefined>;

export const IMESSAGE_KEY = "imessage-poll";
/** Where Messages keeps its history on a Mac. */
export const CHAT_DB = join(homedir(), "Library", "Messages", "chat.db");
/** System Settings › Privacy & Security › Full Disk Access (the Mac app opens it: desktop/mac/DiscoveryCore.swift allowedOpenURL). */
export const FULL_DISK_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

const TEXT_MAX = 600;
const PER_ROUND = 500;
const HISTORY_SCAN = 200;
const KEEP_S = 60 * 24 * 3600;
/** A message that shows up this long after its date is old history arriving (a sync), not something new. */
const LATE_MS = 3 * 24 * 3600_000;
/** Apple's dates count from 2001-01-01 UTC. */
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
/** Above this a date is in nanoseconds (macOS 10.13 and later); at or below it, in seconds. */
const NANO_FROM = 100_000_000_000n;

export interface ImessageConfig {
  /** The history file (CHAT_DB; another path only in the tests). */
  path: string;
  pollMinutes: number;
}

/** Off (null) unless IMESSAGE=on, on a Mac. A wrong value keeps it off and says why. */
export function loadImessageConfig(env: Env, platform: NodeJS.Platform = process.platform): { config: ImessageConfig | null; problems: string[] } {
  const raw = (env.IMESSAGE ?? "").trim().toLowerCase();
  if (!raw || raw === "off") return { config: null, problems: [] };
  const problems: string[] = [];
  if (raw !== "on") problems.push("IMESSAGE must be on or off");
  else if (platform !== "darwin") problems.push("IMESSAGE is for a Mac only: Messages keeps its history on macOS");
  const rawPoll = (env.IMESSAGE_POLL_MINUTES ?? "").trim();
  const pollMinutes = rawPoll ? Number(rawPoll) : 2;
  if (!Number.isInteger(pollMinutes) || pollMinutes < 1 || pollMinutes > 60) problems.push("IMESSAGE_POLL_MINUTES must be a whole number from 1 to 60");
  return problems.length ? { config: null, problems } : { config: { path: CHAT_DB, pollMinutes }, problems };
}

// ---------- the conversation ids the engine knows ----------

/** A Messages chat's id for the engine: Slack-shaped (src/followups/record.ts CHANNEL), never a real Slack id. */
export const imessageChannel = (guid: string): string => `GIMSG${createHash("sha256").update(guid).digest("hex").slice(0, 20).toUpperCase()}`;
export const isImessageChannel = (ch: string): boolean => /^GIMSG[0-9A-F]{20}$/.test(ch);
/** A message's time as Slack writes it (seconds.milliseconds), so the engine's "after this message" works unchanged. */
export const imessageTs = (ms: number): string => (ms / 1000).toFixed(3);

// ---------- Apple's formats ----------

/** A date of chat.db (seconds or, on modern macOS, nanoseconds since 2001-01-01) in ms since 1970; null when it is not one. */
export function appleTime(raw: unknown): number | null {
  let v: bigint;
  try {
    v = typeof raw === "bigint" ? raw : BigInt(typeof raw === "number" ? Math.trunc(raw) : String(raw ?? "").trim() || "x");
  } catch {
    /* not a whole number: no date */
    return null;
  }
  if (v <= 0n) return null;
  const ms = v > NANO_FROM ? Number(v / 1_000_000n) : Number(v) * 1000;
  return APPLE_EPOCH_MS + ms;
}

/**
 * The plain string of an attributedBody (an NSAttributedString archived in Apple's typedstream format): after the NSString class comes "+"
 * and the string's length (one byte; 0x81 and two bytes; 0x82 and four, little endian), then its UTF-8 bytes. "" when there is none.
 */
export function attributedText(blob: unknown): string {
  if (!(blob instanceof Uint8Array) || blob.length < 16) return "";
  const b = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const at = b.indexOf("NSString");
  if (at < 0) return "";
  const plus = b.indexOf(0x2b, at + 8);
  if (plus < 0 || plus - (at + 8) > 12) return "";
  let i = plus + 1;
  let len = b[i++];
  if (len === undefined) return "";
  if (len === 0x81) {
    if (i + 2 > b.length) return "";
    len = b.readUInt16LE(i);
    i += 2;
  } else if (len === 0x82) {
    if (i + 4 > b.length) return "";
    len = b.readUInt32LE(i);
    i += 4;
  } else if (len > 0x7f) return "";
  if (!len || i + len > b.length) return "";
  return b.subarray(i, i + len).toString("utf8");
}

/** A message's words as the owner would read them: no attachment marks, no invisible characters, one line, cut. */
export function plainMessage(s: string): string {
  return s
    .replace(/[\ufffc\ufffd]/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TEXT_MAX);
}

// ---------- what goes out ----------

/** One message to or from the owner, as the engine takes a Slack one (src/followups/types.ts SlackSeen). */
export interface ImessageSeen {
  channel: string;
  ts: string;
  at: number;
  who: string;
  where: string;
  direct: boolean;
  text: string;
  mine: boolean;
}

/** Whether Pako can read the history: "ok", "denied" (no Full Disk Access), "missing" (no Messages history on this Mac), or not tried yet. */
export type ImessageAccess = "ok" | "denied" | "missing" | null;

export interface ImessageStatus {
  access: ImessageAccess;
  lastRead: number | null;
  lastError: string | null;
  /** When it was turned on: nothing older is read. */
  since: number | null;
}

export interface ImessageDeps {
  config: ImessageConfig;
  kv: Kv | null;
  /** Each new message to or from the owner (src/followups.ts observeSlack). */
  observe: (m: ImessageSeen) => void | Promise<void>;
  /** The imported contacts of this Mac (src/contacts.ts): a handle's name. Absent: the number or address itself. */
  contacts?: () => Promise<Contact[]>;
  /** Pako for Mac runs this server (src/autostart.ts runsInMacApp): the Full Disk Access step names Pako, else the terminal. */
  inApp?: boolean;
  /** The owner's pause (STOP): while it lasts nothing is read; the mark stays, so what came meanwhile is read after RESUME. */
  paused?: () => Promise<boolean>;
  now?: () => number;
}

const SAY = texts({
  dm: "Messages · {who} (private)",
  group: "Messages · {who} in {chat}",
  mineInGroup: "Messages · {chat}",
  aGroup: "a group chat",
  someone: "someone",
  me: "me",
  noText: "(a photo or a file)",
  denied: "Pako can't read your Messages yet: macOS needs your permission. Open System Settings › Privacy & Security › Full Disk Access, "
    + "turn on {app}, then press Check again.",
  appMac: "Pako",
  appTerminal: "the app you start Pako from (Terminal, or iTerm)",
  missing: "There's no Messages history on this Mac yet: open Messages and sign in with your Apple Account first.",
  failed: "Pako couldn't read your Messages just now: it tries again in a few minutes.",
});

interface State {
  /** When it was turned on (ms): nothing older is handed on. */
  start: number;
  /** The last message (ROWID) already looked at; null until the first look that could read the file. */
  mark: number | null;
  access: ImessageAccess;
  lastRead: number | null;
  lastError: string | null;
}

interface Row {
  id: number;
  text: string;
  mine: boolean;
  at: number | null;
  skip: boolean;
  file: boolean;
  handle: string;
}

/** The columns a message is read with; a column an older macOS lacks reads as nothing. */
const messageColumns = (has: Set<string>): string =>
  [
    "m.ROWID AS id", "m.text AS text", `${has.has("attributedBody") ? "m.attributedBody" : "NULL"} AS body`, "m.is_from_me AS mine",
    "CAST(m.date AS TEXT) AS date", `${has.has("associated_message_type") ? "m.associated_message_type" : "0"} AS assoc`,
    `${has.has("item_type") ? "m.item_type" : "0"} AS item`, `${has.has("cache_has_attachments") ? "m.cache_has_attachments" : "0"} AS files`,
    "h.id AS handle",
  ].join(", ");

const rowOf = (r: Record<string, unknown>): Row => {
  const raw = typeof r.text === "string" && r.text.trim() ? r.text : attributedText(r.body);
  const text = plainMessage(raw);
  const file = Number(r.files) > 0 || /https?:\/\//i.test(text);
  // A reaction (a tapback, "Loved …") and a group event (renamed, someone added) are never a message of their own.
  const skip = Number(r.assoc) !== 0 || Number(r.item) !== 0;
  return { id: Number(r.id), text, mine: Number(r.mine) === 1, at: appleTime(r.date), skip, file, handle: typeof r.handle === "string" ? r.handle : "" };
};

/** "denied" or "missing" when the file cannot be opened at all; "ok" when it can. Any other failure is thrown. */
export function chatDbAccess(path: string): "ok" | "denied" | "missing" {
  try {
    closeSync(openSync(path, "r"));
    return "ok";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") return "denied";
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    throw err;
  }
}

export function createImessage(d: ImessageDeps) {
  const now = d.now ?? Date.now;
  const kv = d.kv;
  let s: State | null = null;
  /** The chat a Messages id stands for (its row), learned while reading: kept in memory only. */
  const chats = new Map<string, number>();

  const load = async (): Promise<State> => {
    if (s) return s;
    const p = kv ? ((await readJsonRecord(kv, IMESSAGE_KEY)) as Partial<State> | undefined) : undefined;
    s = p && typeof p.start === "number"
      ? { start: p.start, mark: typeof p.mark === "number" ? p.mark : null, access: p.access ?? null, lastRead: p.lastRead ?? null, lastError: p.lastError ?? null }
      : { start: now(), mark: null, access: null, lastRead: null, lastError: null };
    return s;
  };
  const save = async (): Promise<void> => {
    if (kv && s) await kv.set(IMESSAGE_KEY, JSON.stringify(s), KEEP_S).catch((err: Error) => log.error(`could not keep where it is: ${err.message}`));
  };

  /** The file, read only: never written (immutable while Messages is closed), never locked against it, closed by the caller at once. */
  const open = (): Database => openForeignReadOnly(d.config.path);
  const columnsOf = (db: Database, table: string): Set<string> =>
    new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name)));

  /** The imported contacts, once per look; a handle with none is said as it is. */
  const namer = async (): Promise<(handle: string) => string> => {
    const book = d.contacts ? await d.contacts().catch(() => [] as Contact[]) : [];
    return (handle: string) => (handle ? contactNameFor(book, handle) ?? handle.slice(0, 80) : SAY()("someone"));
  };

  // ----- one look -----
  let busy = false;
  const round = async (): Promise<number> => {
    if (busy) return 0;
    busy = true;
    let st: State | null = null;
    let db: Database | null = null;
    try {
      // Inside the try: a store that fails to answer once must not leave `busy` set, and Messages unread, until Pako restarts.
      // STOP holds everything, as IMAP does not log in.
      if (await d.paused?.()) return 0;
      st = await load();
      st.access = chatDbAccess(d.config.path);
      if (st.access !== "ok") return 0;
      db = open();
      // The first look that can read: the mark at the last message from before it was turned on.
      if (st.mark === null) {
        const since = BigInt(st.start - APPLE_EPOCH_MS);
        const top = db.prepare("SELECT MAX(ROWID) AS top FROM message WHERE (date > ? AND date < ?) OR (date <= ? AND date < ?)")
          .get(NANO_FROM, since * 1_000_000n, NANO_FROM, since / 1000n);
        st.mark = Number(top?.top ?? 0) || 0;
      }
      const has = columnsOf(db, "message");
      const chatHas = columnsOf(db, "chat");
      const rows = db.prepare(
        `SELECT ${messageColumns(has)}, c.ROWID AS chatRow, c.guid AS guid, c.chat_identifier AS ident, c.display_name AS chatName, `
        + `${chatHas.has("style") ? "c.style" : "0"} AS style, (SELECT COUNT(*) FROM chat_handle_join j WHERE j.chat_id = c.ROWID) AS members `
        + "FROM message m JOIN chat_message_join cm ON cm.message_id = m.ROWID JOIN chat c ON c.ROWID = cm.chat_id "
        + "LEFT JOIN handle h ON h.ROWID = m.handle_id WHERE m.ROWID > ? ORDER BY m.ROWID LIMIT ?",
      ).all(st.mark, PER_ROUND);
      db.close();
      db = null;
      const name = await namer();
      const say = SAY();
      let found = 0;
      for (const r of rows) {
        const m = rowOf(r);
        st.mark = Math.max(st.mark ?? 0, m.id);
        if (m.skip || !m.text || m.at === null || m.at < st.start || m.at < now() - LATE_MS) continue;
        const guid = typeof r.guid === "string" ? r.guid : "";
        if (!guid) continue;
        const channel = imessageChannel(guid);
        chats.set(channel, Number(r.chatRow));
        const group = Number(r.style) === 43 || Number(r.members) > 1;
        const who = m.mine ? say("me") : name(m.handle);
        const chat = (typeof r.chatName === "string" && r.chatName.trim() ? plainMessage(r.chatName).slice(0, 60) : "") || say("aGroup");
        const where = group
          ? m.mine ? say("mineInGroup", { chat }) : say("group", { who, chat })
          : say("dm", { who: name(typeof r.ident === "string" ? r.ident : m.handle) });
        await Promise.resolve(d.observe({ channel, ts: imessageTs(m.at), at: m.at, who, where: where.slice(0, 120), direct: !group, text: m.text, mine: m.mine }))
          .catch((err: Error) => log.error(`could not hand on a message: ${err.message}`));
        found++;
      }
      st.lastRead = now();
      st.lastError = null;
      return found;
    } catch (err) {
      // Only the error's own words: never a message's text, a number or an address.
      const why = (err as Error).message.replace(/\s+/g, " ").slice(0, 200);
      if (st) {
        st.lastError = why;
        // macOS refuses the open itself when Full Disk Access is missing (the file's check above may pass on an older macOS).
        if (/authori[sz]ation denied|not permitted/i.test(why)) st.access = "denied";
      }
      log.error(`a look failed: ${why}`);
      return 0;
    } finally {
      db?.close();
      if (st) await save();
      busy = false;
    }
  };

  /** The row of the chat a Messages id stands for: learned while reading, else looked up among the chats' guids. */
  const chatRow = (db: Database, channel: string): number | null => {
    const known = chats.get(channel);
    if (known !== undefined) return known;
    for (const c of db.prepare("SELECT ROWID AS id, guid FROM chat").all()) {
      if (typeof c.guid === "string") chats.set(imessageChannel(c.guid), Number(c.id));
    }
    return chats.get(channel) ?? null;
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    round,
    start: (): void => {
      if (timer) return;
      // The first look soon after start, then every few minutes.
      setTimeout(() => void round(), 10_000).unref?.();
      timer = setInterval(() => void round(), d.config.pollMinutes * 60_000);
      timer.unref?.();
    },
    stop: (): void => {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /**
     * A Messages chat's latest messages, oldest first, the owner's marked `mine` (what src/followups.ts asks Slack's history for: the context of
     * an extraction and the checks of a later reply). A photo or a file counts as `file`. Throws when the chat is not one on this Mac.
     */
    history: async (channel: string, o: { limit?: number; oldest?: string } = {}): Promise<{ ts: string; at: number; mine: boolean; who: string; text: string; file?: boolean }[]> => {
      if (chatDbAccess(d.config.path) !== "ok") throw new Error("Messages: the history cannot be read now");
      const st = await load();
      const db = open();
      let rows: Record<string, unknown>[];
      try {
        const row = chatRow(db, channel);
        if (row === null) throw new Error("Messages: that conversation is not known here");
        rows = db.prepare(
          `SELECT ${messageColumns(columnsOf(db, "message"))} FROM chat_message_join cm JOIN message m ON m.ROWID = cm.message_id `
          + "LEFT JOIN handle h ON h.ROWID = m.handle_id WHERE cm.chat_id = ? ORDER BY m.ROWID DESC LIMIT ?",
        ).all(row, HISTORY_SCAN);
      } finally {
        db.close();
      }
      const name = await namer();
      const say = SAY();
      const limitN = Math.min(50, Math.max(1, o.limit ?? 15));
      const after = o.oldest ? Number(o.oldest) * 1000 : null;
      const out = rows.map(rowOf)
        // Nothing from before it was turned on, here either: the context of a job is what came since.
        .filter((m): m is Row & { at: number } => !m.skip && m.at !== null && m.at >= st.start && (!!m.text || m.file))
        .map((m) => ({ ts: imessageTs(m.at), at: m.at, mine: m.mine, who: m.mine ? "" : name(m.handle), text: m.text || say("noText"), ...(m.file ? { file: true } : {}) }))
        .sort((a, b) => a.at - b.at);
      return (after !== null ? out.filter((m) => Number(m.ts) > Number(o.oldest)) : out).slice(-limitN);
    },
    /** The card's facts. Never a message, a number or an address. */
    status: async (): Promise<ImessageStatus> => {
      const st = await load();
      return { access: st.access, lastRead: st.lastRead, lastError: st.lastError, since: st.start };
    },
    /** What is wrong now, in plain words for the owner (the connections page and its status); null when nothing is. */
    problem: (l: Lang): string | null => {
      const say = SAY(l);
      if (!s || s.access === null) return null;
      if (s.access === "denied") return say("denied", { app: say(d.inApp ? "appMac" : "appTerminal") });
      if (s.access === "missing") return say("missing");
      return s.lastError ? say("failed") : null;
    },
  };
}

export type ImessageReader = ReturnType<typeof createImessage>;

/**
 * Turned off: where it was is forgotten, so turning it on again starts from that moment, never from the old mark (which would hand on
 * everything said in between). Called at start while it is off; writes only when something is kept.
 */
export async function forgetImessage(kv: Kv): Promise<void> {
  if (await kv.get(IMESSAGE_KEY)) await kv.set(IMESSAGE_KEY, "", 1);
}

// ---------- the card's route ----------

export interface ImessagePanelDeps extends RouteAuth {
  lang: () => Lang;
  /** This server runs on a Mac: elsewhere the card says it is for a Mac only. */
  mac: boolean;
  /** The running reader, once built (it is built after the panel's routes): null while it is off. */
  reader: () => ImessageReader | null;
}

const PATHS = ["/panel/api/imessage", "/panel/api/imessage/check"];

/**
 * GET  /panel/api/imessage        -> { mac, on, access, lastRead, since, problem, pane }
 * POST /panel/api/imessage/check  -> the same, after one look now (after the owner turned Full Disk Access on).
 * Turning it on or off is the connections' own save (IMESSAGE=on, src/connections-panel.ts), which restarts Pako.
 */
export function mountImessagePanel(app: Express, d: ImessagePanelDeps | null): void {
  if (!d) return localOnly(app, PATHS);
  const view = async () => {
    const r = d.reader();
    const st = r ? await r.status() : null;
    return {
      mac: d.mac, on: !!r, access: st?.access ?? null, lastRead: st?.lastRead ?? null, since: st?.since ?? null,
      problem: r?.problem(d.lang()) ?? null, pane: FULL_DISK_PANE,
    };
  };
  app.get(PATHS[0]!, guard(d, false), limit(60), async (_req, res) => {
    res.json(await view());
  });
  app.post(PATHS[1]!, guard(d, true), limit(20), async (_req, res) => {
    await d.reader()?.round();
    res.json(await view());
  });
}
