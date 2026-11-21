// Mail on this Mac: the email Apple Mail already downloaded, read only, so a Mac owner connects their mail with one switch and no password.
// Whatever accounts they set up in Mail (iCloud, Gmail, Outlook, Exchange, any IMAP) come with it; Pako never logs in anywhere.
//
// Mail keeps its store in ~/Library/Mail/V<N>/ (the highest N is the live one): an index, MailData/Envelope Index (SQLite: the tables
// messages and mailboxes are the ones read here), and each message as a file, <account>/<mailbox>.mbox/<store>/Data/<digits>/Messages/
// <ROWID>.emlx (or .partial.emlx when Mail keeps the attachments apart). An .emlx starts with a line holding the message's length in bytes,
// then the RFC 822 message itself, then an Apple property list. Pako opens the index read only (node:sqlite, read only and query only, as
// src/imessage.ts opens Messages' history), never writes it or a message file, and holds nothing open between looks.
//
// Columns differ across macOS versions: each one is looked for before it is read, and a missing one reads as nothing. A store without the
// two tables Pako needs is said plainly ("unknown"), never a crash.
//
// What it reads, and from when: each new row of the index after a mark (its ROWID), so none is handed on twice. The first look sets the mark
// just before the first message dated after it was turned on: no backlog floods the mailbox or the follow-ups. A message dated more than a
// few days before it shows up (an account's first sync bringing old mail) is skipped too. Only inboxes and Sent mailboxes are read; Junk,
// Trash, Drafts, archives and every other folder are not, and a message Mail marks deleted is skipped. A message Mail has not downloaded yet
// is looked for again for a while.
//
// Each message goes through the same intake as IMAP's (src/mail-intake.ts): parsed by src/imap.ts parseMessage, an inbox email into
// src/mail.ts takeMail, a sent one to what it answers, the lessons and the follow-ups. The owner's replies in Sent close the loops of the
// emails they answer, as with IMAP. With IMAP on too for the same account, an email is taken once: takeMail's same-email key (its Message-ID
// and sender) makes the second reader's copy a no-op, and the follow-ups know a sent email by its Message-ID.
//
// It is off until the owner turns it on (APPLE_MAIL=on, kept by the panel), on a Mac only. macOS guards ~/Library/Mail: the process needs
// Full Disk Access, said to the owner in plain words with the button to the System Settings pane, as for Messages.
//
// Privacy: no message text, subject or address is ever logged; the store keeps only the mark, when it was turned on, the rows waiting for
// Mail to download them (numbers), and the last read and error (APPLE_MAIL_KEY). The owner's own addresses, learnt from their Sent mail,
// stay in memory.

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Express } from "express";
import { guard, limit, localOnly, type RouteAuth } from "./connect-routes.ts";
import { texts, type Lang } from "./i18n.ts";
import { FULL_DISK_PANE } from "./imessage.ts";
import { parseMessage, type ParsedMessage } from "./imap.ts";
import type { Kv } from "./kv.ts";
import { readJsonRecord } from "./json-record.ts";
import { createMailIntake, type MailIntakeDeps } from "./mail-intake.ts";
import { addressOf, loadMailFilters, type MailAccount } from "./mail.ts";
import { openForeignReadOnly, type Database } from "./sqlite-kv.ts";
import { createLog } from "./log.ts";

const log = createLog("apple-mail");

type Env = Record<string, string | undefined>;

export const APPLE_MAIL_KEY = "apple-mail-poll";
/** Where Apple Mail keeps its store on a Mac. */
export const MAIL_ROOT = join(homedir(), "Library", "Mail");

const PER_ROUND = 300;
const KEEP_S = 60 * 24 * 3600;
/** A message dated this long before it shows up is old mail arriving (an account's first sync), not something new. */
const LATE_MS = 3 * 24 * 3600_000;
/** A message whose file Mail has not written yet is looked for again this long. */
const WAIT_MS = 2 * 3600_000;
const WAIT_MAX = 200;
/** Bytes of a message read at most: the same as IMAP reads (its words; attachments are only named). */
const SOURCE_MAX = 256 * 1024;
/** Apple's other epoch (2001-01-01) in seconds since 1970: a date below it is counted from 2001. */
const APPLE_EPOCH_S = 978_307_200;

export interface AppleMailConfig {
  /** ~/Library/Mail (another folder only in the tests). */
  root: string;
  pollMinutes: number;
  /** The same lists as the other mailboxes (AGENTMAIL_WORK_DOMAINS, AGENTMAIL_VIP). */
  workDomains: string[];
  vip: string[];
}

/** Off (null) unless APPLE_MAIL=on, on a Mac. A wrong value keeps it off and says why. */
export function loadAppleMailConfig(env: Env, platform: NodeJS.Platform = process.platform): { config: AppleMailConfig | null; problems: string[] } {
  const raw = (env.APPLE_MAIL ?? "").trim().toLowerCase();
  if (!raw || raw === "off") return { config: null, problems: [] };
  const problems: string[] = [];
  if (raw !== "on") problems.push("APPLE_MAIL must be on or off");
  else if (platform !== "darwin") problems.push("APPLE_MAIL is for a Mac only: it reads what Apple Mail downloaded on macOS");
  const rawPoll = (env.APPLE_MAIL_POLL_MINUTES ?? "").trim();
  const pollMinutes = rawPoll ? Number(rawPoll) : 3;
  if (!Number.isInteger(pollMinutes) || pollMinutes < 1 || pollMinutes > 60) problems.push("APPLE_MAIL_POLL_MINUTES must be a whole number from 1 to 60");
  if (problems.length) return { config: null, problems };
  const f = loadMailFilters(env);
  return { config: { root: MAIL_ROOT, pollMinutes, workDomains: f.workDomains, vip: f.vip }, problems };
}

// ---------- Mail's store ----------

/** Whether Pako can read Mail's store: "ok", "denied" (no Full Disk Access), "missing" (Mail was never set up), "unknown" (a store it cannot read). */
export type AppleMailAccess = "ok" | "denied" | "missing" | "unknown" | null;

const errCode = (err: unknown): string => String((err as NodeJS.ErrnoException)?.code ?? "");
const deniedCode = (c: string): boolean => c === "EPERM" || c === "EACCES";

/** The live store (the highest V<N> with an index), or why there is none. Any other failure is thrown. */
export function findMailStore(root: string): { access: "ok"; dir: string; index: string } | { access: "denied" | "missing" } {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (err) {
    if (deniedCode(errCode(err))) return { access: "denied" };
    if (errCode(err) === "ENOENT" || errCode(err) === "ENOTDIR") return { access: "missing" };
    throw err;
  }
  const versions = names.map((n) => /^V(\d{1,3})$/.exec(n)).filter((m): m is RegExpExecArray => !!m).sort((a, b) => Number(b[1]) - Number(a[1]));
  for (const v of versions) {
    const dir = join(root, v[0]);
    const index = join(dir, "MailData", "Envelope Index");
    try {
      closeSync(openSync(index, "r"));
      return { access: "ok", dir, index };
    } catch (err) {
      if (deniedCode(errCode(err))) return { access: "denied" };
      /* no index in this one: an older store left behind */
    }
  }
  return { access: "missing" };
}

/** What a mailbox is to Pako, by its URL's path: an inbox, the owner's Sent, or one not read (Junk, Trash, Drafts, archives, the rest). */
export type MailboxKind = "inbox" | "sent" | "skip";

const SKIP_NAMES = /^(junk|junk e-?mail|spam|bulk mail|trash|deleted messages|deleted items|bin|drafts|outbox|archive|all mail|notes)$/;
const SENT_NAMES = /^(sent|sent messages|sent items|sent mail|enviados|elementos enviados|gesendet|gesendete objekte|envoy[ée]s|[ée]l[ée]ments envoy[ée]s|posta inviata|inviati|verzonden)$/;

/** A mailbox URL of the index ("imap://<account>/INBOX", "ews://<account>/Sent%20Items", "local:///Name") as scheme, account and path. */
export function mailboxParts(url: string): { scheme: string; account: string; path: string[] } | null {
  const m = /^([a-z][a-z0-9+.-]{0,20}):\/\/([^/]{0,200})\/(.{1,1000})$/i.exec(url.trim());
  if (!m) return null;
  let path: string[];
  try {
    path = m[3]!.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  } catch {
    /* a badly encoded name: not one Pako reads */
    return null;
  }
  // A name that would leave the store (or an account that is not a plain id) is never made into a path.
  if (!path.length || path.some((s) => s === "." || s === ".." || /[/\\\u0000]/.test(s))) return null;
  if (!/^([A-Za-z0-9][A-Za-z0-9._-]{0,99})?$/.test(m[2]!)) return null;
  return { scheme: m[1]!.toLowerCase(), account: m[2]!, path };
}

export function mailboxKind(url: string): MailboxKind {
  const p = mailboxParts(url);
  if (!p) return "skip";
  const last = p.path.at(-1)!.trim().toLowerCase();
  if (SKIP_NAMES.test(last)) return "skip";
  if (SENT_NAMES.test(last)) return "sent";
  return p.path.length === 1 && last === "inbox" ? "inbox" : "skip";
}

/** The folder a mailbox's messages live in: <V>/<account>/<A>.mbox/<B>.mbox, or <V>/Mailboxes/... for one "On My Mac". */
export function mailboxDir(store: string, url: string): string | null {
  const p = mailboxParts(url);
  if (!p) return null;
  return join(store, p.account || "Mailboxes", ...p.path.map((s) => `${s}.mbox`));
}

/** Where a message's file is: Mail's layout first (Data/<digits of ROWID / 1000, reversed>/Messages), then a bounded search. */
function emlxPath(dir: string, id: number, found: Map<string, Map<string, string>>): string | null {
  const names = [`${id}.emlx`, `${id}.partial.emlx`];
  const thousands = id >= 1000 ? String(Math.floor(id / 1000)).split("").reverse() : [];
  let stores: string[];
  try {
    stores = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.endsWith(".mbox")).map((e) => join(dir, e.name)).slice(0, 20);
  } catch {
    /* the mailbox's folder is not there (Mail has not made it yet): no file to read */
    return null;
  }
  for (const base of [...stores, dir]) {
    for (const sub of [join(base, "Data", ...thousands, "Messages"), join(base, "Data", "Messages"), join(base, "Messages")]) {
      for (const n of names) if (existsSync(join(sub, n))) return join(sub, n);
    }
  }
  // Another layout (an older or newer Mail): one search of the mailbox's folder per look, bounded, its file names kept for the next rows.
  let files = found.get(dir);
  if (!files) {
    files = new Map();
    found.set(dir, files);
    const walk = (at: string, depth: number): void => {
      if (depth > 6 || files!.size > 50_000) return;
      let entries;
      try {
        entries = readdirSync(at, { withFileTypes: true });
      } catch {
        /* a folder that cannot be listed holds nothing Pako can read */
        return;
      }
      for (const e of entries) {
        if (e.isDirectory() && !e.name.endsWith(".mbox")) walk(join(at, e.name), depth + 1);
        else if (e.isFile() && /^\d+(\.partial)?\.emlx$/.test(e.name)) files!.set(e.name, join(at, e.name));
      }
    };
    walk(dir, 0);
  }
  for (const n of names) if (files.has(n)) return files.get(n)!;
  return null;
}

/** The RFC 822 message inside an .emlx: after the first line's byte count, that many bytes (cut at `max`). Null when it is not one. */
export function emlxMessage(buf: Buffer): Buffer | null {
  const nl = buf.indexOf(0x0a);
  if (nl <= 0 || nl > 20) return null;
  const n = Number(buf.subarray(0, nl).toString("latin1").trim());
  if (!Number.isInteger(n) || n <= 0) return null;
  return buf.subarray(nl + 1, Math.min(nl + 1 + n, buf.length));
}

/** A message file's first bytes, read only, closed at once. */
function readEmlx(path: string): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(SOURCE_MAX + 32);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return emlxMessage(buf.subarray(0, n));
  } catch {
    /* gone or unreadable since it was found (Mail moved or deleted it): skipped */
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** A date of the index (seconds since 1970 on the Macs seen; since 2001 on an older one; milliseconds read as such) in ms; null when none. */
export function mailTime(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 1e12) return Math.trunc(n);
  return Math.trunc((n < APPLE_EPOCH_S ? n + APPLE_EPOCH_S : n) * 1000);
}

// ---------- reading ----------

export interface AppleMailStatus {
  access: AppleMailAccess;
  lastRead: number | null;
  lastError: string | null;
  /** When it was turned on: nothing older is read. */
  since: number | null;
}

export interface AppleMailDeps extends Omit<MailIntakeDeps, "vip" | "backfill" | "log" | "provider"> {
  config: AppleMailConfig;
  kv: Kv | null;
  /** Pako for Mac runs this server (src/autostart.ts runsInMacApp): the Full Disk Access step names Pako, else the terminal. */
  inApp?: boolean;
}

const SAY = texts({
  denied: "Pako can't read the mail on this Mac yet: macOS needs your permission. Open System Settings › Privacy & Security › Full Disk Access, "
    + "turn on {app}, then press Check again.",
  appMac: "Pako",
  appTerminal: "the app you start Pako from (Terminal, or iTerm)",
  missing: "There's no mail on this Mac yet: open the Mail app and add your email account there first.",
  unknown: "This Mac's version of Mail keeps its mail in a way this Pako can't read yet: update Pako.",
  failed: "Pako couldn't read the mail on this Mac just now: it tries again in a few minutes.",
});

interface Waiting {
  id: number;
  mbox: number;
  at: number;
}

interface State {
  start: number;
  /** The last row of the index already looked at; null until the first look that could read it. */
  mark: number | null;
  /** The store the mark belongs to (V10, V11): another one (a macOS update moved it) starts again from now. */
  store: string | null;
  /** Rows whose file Mail had not written yet (numbers only). */
  waiting: Waiting[];
  access: AppleMailAccess;
  lastRead: number | null;
  lastError: string | null;
}

interface Row {
  id: number;
  mbox: number;
  at: number | null;
  deleted: boolean;
}

export function createAppleMail(d: AppleMailDeps) {
  const now = d.now;
  const kv = d.kv;
  const { config } = d;
  let s: State | null = null;
  /** The owner's own addresses, learnt from the senders of their Sent mailboxes: in memory only. */
  const own = new Set<string>();
  const intake = createMailIntake({ ...d, vip: config.vip, log });

  const load = async (): Promise<State> => {
    if (s) return s;
    const p = kv ? ((await readJsonRecord(kv, APPLE_MAIL_KEY)) as Partial<State> | undefined) : undefined;
    s = p && typeof p.start === "number"
      ? {
          start: p.start, mark: typeof p.mark === "number" ? p.mark : null, store: typeof p.store === "string" ? p.store : null,
          waiting: Array.isArray(p.waiting) ? p.waiting.filter((w) => w && Number.isInteger(w.id) && Number.isInteger(w.mbox) && typeof w.at === "number") : [],
          access: p.access ?? null, lastRead: p.lastRead ?? null, lastError: p.lastError ?? null,
        }
      : { start: now(), mark: null, store: null, waiting: [], access: null, lastRead: null, lastError: null };
    return s;
  };
  const save = async (): Promise<void> => {
    if (kv && s) await kv.set(APPLE_MAIL_KEY, JSON.stringify(s), KEEP_S).catch((err: Error) => log.error(`could not keep where it is: ${err.message}`));
  };

  /** The index, read only, closed by the caller at once; immutable while Mail is closed, so nothing is left beside it (src/sqlite-kv.ts). */
  const open = (path: string): Database => openForeignReadOnly(path);
  const columnsOf = (db: Database, table: string): Set<string> =>
    new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name)));

  const accountOf = (p: ParsedMessage): MailAccount => {
    const to = p.to.join(" ").toLowerCase();
    return config.workDomains.some((dom) => to.includes(`@${dom}`)) ? "trabajo" : "personal";
  };

  /** The same email whichever reader of the owner's mail found it: its Message-ID and sender; the row when it has no Message-ID. */
  const idOf = (p: ParsedMessage, store: string, row: number): string => {
    const mid = p.messageId.replace(/^<|>$/g, "").toLowerCase();
    const key = mid ? `${mid}\n${addressOf(p.from)}` : `${store}\n${row}`;
    return `applemail:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
  };

  let busy = false;
  /** One look: the new rows of the index, each message read from its file and handed to the intake. The messages handed on. */
  const round = async (): Promise<number> => {
    if (busy) return 0;
    busy = true;
    let st: State;
    try {
      // STOP holds everything, as IMAP does not log in: nothing read. The mark stays, so what came meanwhile is read after RESUME.
      if (d.control && (await d.control.paused()) !== null) {
        busy = false;
        return 0;
      }
      st = await load();
    } catch (err) {
      // The store could not say where it was: nothing read, and the next look tries again (a stuck `busy` stopped every later look).
      log.error(`could not read where it was: ${(err as Error)?.name ?? "error"}`);
      busy = false;
      return 0;
    }
    let db: Database | null = null;
    try {
      const found = findMailStore(config.root);
      st.access = found.access;
      if (found.access !== "ok") return 0;
      const storeName = basename(found.dir);
      if (st.store !== storeName) {
        st.mark = null;
        st.waiting = [];
        st.store = storeName;
      }
      db = open(found.index);
      const has = columnsOf(db, "messages");
      const boxHas = columnsOf(db, "mailboxes");
      // The two tables every Mail since 2017 has; without them this is a store Pako does not know.
      if (!has.has("mailbox") || !boxHas.has("url")) {
        st.access = "unknown";
        st.lastError = "the index has no messages.mailbox or mailboxes.url";
        log.error("Mail's index is not one Pako knows: nothing read");
        return 0;
      }
      const dateCol = ["date_received", "date_sent", "date_created"].find((c) => has.has(c));
      const date = dateCol ? `m.${dateCol}` : "NULL";
      const deleted = has.has("deleted") ? "m.deleted" : "0";
      // The first look that can read: the mark just before the first message dated after it was turned on (or at the end).
      if (st.mark === null) {
        const first = dateCol ? db.prepare(`SELECT MIN(ROWID) AS r FROM messages m WHERE ${date} >= ?`).get(Math.floor(st.start / 1000))?.r : null;
        st.mark = first !== null && first !== undefined ? Number(first) - 1 : Number(db.prepare("SELECT MAX(ROWID) AS r FROM messages").get()?.r ?? 0) || 0;
      }
      const boxes = new Map<number, { kind: MailboxKind; dir: string | null }>();
      for (const b of db.prepare("SELECT ROWID AS id, url FROM mailboxes").all()) {
        const url = typeof b.url === "string" ? b.url : "";
        boxes.set(Number(b.id), { kind: mailboxKind(url), dir: mailboxDir(found.dir, url) });
      }
      const sentIds = [...boxes].filter(([, b]) => b.kind === "sent").map(([id]) => id);
      // The owner's addresses: who sent what is in their Sent mailboxes (the index's sender, when this Mail has one).
      if (sentIds.length && has.has("sender") && columnsOf(db, "addresses").has("address")) {
        const rows = db.prepare(
          `SELECT DISTINCT address FROM (SELECT a.address AS address FROM messages m JOIN addresses a ON a.ROWID = m.sender `
          + `WHERE m.mailbox IN (${sentIds.map(() => "?").join(",")}) ORDER BY m.ROWID DESC LIMIT 200) LIMIT 20`,
        ).all(...sentIds);
        for (const r of rows) if (typeof r.address === "string" && r.address.includes("@")) own.add(addressOf(r.address));
      }
      const select = `SELECT m.ROWID AS id, m.mailbox AS mbox, ${date} AS received, ${deleted} AS deleted FROM messages m`;
      const fresh = db.prepare(`${select} WHERE m.ROWID > ? ORDER BY m.ROWID LIMIT ?`).all(st.mark, PER_ROUND);
      db.close();
      db = null;
      const rowOf = (r: Record<string, unknown>): Row => ({ id: Number(r.id), mbox: Number(r.mbox), at: mailTime(r.received), deleted: Number(r.deleted) === 1 });
      const retry = st.waiting.filter((w) => w.at >= now() - WAIT_MS).map((w): Row => ({ id: w.id, mbox: w.mbox, at: w.at, deleted: false }));
      st.waiting = [];
      const searched = new Map<string, Map<string, string>>();
      let handed = 0;
      for (const [i, r] of [...retry.map((x) => [-1, x] as const), ...fresh.map((x, j) => [j, rowOf(x)] as const)]) {
        if (i >= 0) st.mark = Math.max(st.mark ?? 0, r.id);
        const box = boxes.get(r.mbox);
        if (r.deleted || !box || box.kind === "skip" || !box.dir) continue;
        const at = Math.min(r.at ?? now(), now());
        if (at < st.start || at < now() - LATE_MS) continue;
        const path = emlxPath(box.dir, r.id, searched);
        if (!path) {
          // Mail lists a message before its file is written (or keeps only its headers until it is opened): looked for again a while.
          if (at >= now() - WAIT_MS && st.waiting.length < WAIT_MAX) st.waiting.push({ id: r.id, mbox: r.mbox, at });
          continue;
        }
        const source = readEmlx(path);
        if (!source) continue;
        try {
          const p = parseMessage(source);
          if (box.kind === "sent") {
            const from = addressOf(p.from);
            if (from.includes("@")) own.add(from);
            await intake.sent(p, at);
          } else {
            await intake.inbox(p, at, { id: idOf(p, storeName, r.id), own: [...own], account: accountOf(p) });
          }
          handed++;
        } catch (err) {
          // Only the error's kind: never a word of the message. The intake throws when the store could not keep it: that message, and
          // those after it, are read again at the next look (as IMAP does), never dropped.
          log.error(`a message could not be handed on (${(err as Error)?.name ?? "error"}): the next look tries it again`);
          if (i >= 0) st.mark = r.id - 1;
          else if (st.waiting.length < WAIT_MAX) st.waiting.push({ id: r.id, mbox: r.mbox, at });
          if (i >= 0) break;
        }
      }
      st.lastRead = now();
      st.lastError = null;
      if (handed) log.info(`${handed} message(s) handed on`);
      return handed;
    } catch (err) {
      // Only the error's own words: never a message's text, a subject or an address.
      st.lastError = String((err as Error)?.message ?? "error").replace(/\s+/g, " ").slice(0, 200);
      if (/authori[sz]ation denied|not permitted/i.test(st.lastError)) st.access = "denied";
      log.error(`a look failed: ${st.lastError}`);
      return 0;
    } finally {
      db?.close();
      await save();
      busy = false;
    }
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    round,
    start: (): void => {
      if (timer) return;
      setTimeout(() => void round(), 15_000).unref?.();
      timer = setInterval(() => void round(), config.pollMinutes * 60_000);
      timer.unref?.();
    },
    stop: (): void => {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** The owner's addresses learnt from their Sent mail (the brief and the drafts know who "me" is). */
    addresses: (): string[] => [...own],
    /** The card's facts. Never a message, a subject or an address. */
    status: async (): Promise<AppleMailStatus> => {
      const st = await load();
      return { access: st.access, lastRead: st.lastRead, lastError: st.lastError, since: st.start };
    },
    /** What is wrong now, in plain words for the owner (the connections page and its status); null when nothing is. */
    problem: (l: Lang): string | null => {
      const say = SAY(l);
      if (!s || s.access === null) return null;
      if (s.access === "denied") return say("denied", { app: say(d.inApp ? "appMac" : "appTerminal") });
      if (s.access === "missing") return say("missing");
      if (s.access === "unknown") return say("unknown");
      return s.lastError ? say("failed") : null;
    },
  };
}

export type AppleMailReader = ReturnType<typeof createAppleMail>;

/** Turned off: where it was is forgotten, so turning it on again starts from that moment, never from the old mark. */
export async function forgetAppleMail(kv: Kv): Promise<void> {
  if (await kv.get(APPLE_MAIL_KEY)) await kv.set(APPLE_MAIL_KEY, "", 1);
}

// ---------- the card's route ----------

export interface AppleMailPanelDeps extends RouteAuth {
  lang: () => Lang;
  mac: boolean;
  reader: () => AppleMailReader | null;
  /** IMAP is on too: the card says the same email is taken once. */
  imapOn: () => boolean;
}

const PATHS = ["/panel/api/apple-mail", "/panel/api/apple-mail/check"];

/**
 * GET  /panel/api/apple-mail        -> { mac, on, access, lastRead, since, problem, pane, imap }
 * POST /panel/api/apple-mail/check  -> the same, after one look now (after the owner turned Full Disk Access on).
 * Turning it on or off is the connections' own save (APPLE_MAIL=on, src/connections-panel.ts), which restarts Pako.
 */
export function mountAppleMailPanel(app: Express, d: AppleMailPanelDeps | null): void {
  if (!d) return localOnly(app, PATHS);
  const view = async () => {
    const r = d.reader();
    const st = r ? await r.status() : null;
    return {
      mac: d.mac, on: !!r, access: st?.access ?? null, lastRead: st?.lastRead ?? null, since: st?.since ?? null,
      problem: r?.problem(d.lang()) ?? null, pane: FULL_DISK_PANE, imap: d.imapOn(),
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
