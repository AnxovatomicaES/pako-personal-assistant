// The store on a computer: one SQLite file (kv.db) through Node's own node:sqlite, no dependency. Same surface as the JSON file store it
// replaced (fileKv, before): every module still sees a Kv. What changes is underneath: each write is on disk when set() returns, in a
// transaction, instead of the whole file being rewritten a moment later; a crash loses nothing that was written. It is also the ground for
// tables that are not key/value (facts that close, people by identifier, commitments: docs/roadmap.md).
//
// A first start after an update finds kv.json and no kv.db: every live entry is copied in one transaction, read back and compared, and only
// then is kv.json deleted. A copy that did not match keeps it aside as kv.json.migrated.

import { createRequire } from "node:module";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FileKv } from "./local.ts";
import type { StoreLost } from "./store-guard.ts";
import { createLog } from "./log.ts";

const log = createLog("pako");

/** The files of the store, in the Pako folder. */
export const STORE_FILES = {
  db: "kv.db",
  made: "kv.db.made",
  bad: "kv.db.bad",
  /** The JSON store an older Pako kept, and what it becomes once copied in. */
  legacy: "kv.json",
  legacyMade: "kv.json.made",
  legacyBad: "kv.json.bad",
  migrated: "kv.json.migrated",
} as const;

// The subset of node:sqlite used here: typed by hand so the module loads (and type-checks) on any Node the project supports.
/** What a statement binds: text, numbers (a bigint past 2^53), null, bytes. */
export type SqlValue = string | number | bigint | null | Uint8Array;
export interface Statement {
  run(...params: SqlValue[]): unknown;
  get(...params: SqlValue[]): Record<string, unknown> | undefined;
  all(...params: SqlValue[]): Record<string, unknown>[];
}
export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

let DatabaseSync: (new (path: string, o?: { readOnly?: boolean; timeout?: number }) => Database) | undefined;
/**
 * node:sqlite, loaded on first use. On Node 22 it prints an "experimental" warning when it loads: that one warning is held back (the person
 * would read it at every start and think something broke); any other warning goes through as usual. Messages' history (src/imessage.ts)
 * is opened with it too, read only.
 */
export function sqlite(): new (path: string, o?: { readOnly?: boolean; timeout?: number }) => Database {
  if (DatabaseSync) return DatabaseSync;
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (/SQLite is an experimental feature/i.test(text)) return;
    return (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    DatabaseSync = (createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string, o?: { readOnly?: boolean; timeout?: number }) => Database }).DatabaseSync;
  } finally {
    process.emitWarning = emit;
  }
  return DatabaseSync;
}

/** The file itself is bad: SQLite says it is not a database or is malformed, or its own check found a fault. The only thing that moves it aside. */
class StoreDamaged extends Error {}

/**
 * The file cannot be opened now, and nothing says it is bad: another process is in the middle of a write, a program holds it, the folder or
 * the file has no permission for us, the disk gave an error. It stays exactly where it is, with its journal; the message is a sentence for the
 * owner (src/server.ts prints it).
 */
export class StoreUnavailable extends Error {}

/** SQLite's own words for a bad file: SQLITE_CORRUPT (11) and SQLITE_NOTADB (26), whatever the extended code. Anything else is not about the file. */
const damageOf = (err: unknown): boolean => {
  const code = (err as { errcode?: unknown } | null)?.errcode;
  return typeof code === "number" && ((code & 0xff) === 11 || (code & 0xff) === 26);
};

/** Why a file could not be opened, in plain words (a busy file is the one everybody meets: a second Pako, or a backup program, at that moment). */
function whyNotOpened(err: unknown): string {
  const e = err as NodeJS.ErrnoException & { errcode?: number };
  const base = typeof e.errcode === "number" ? e.errcode & 0xff : -1;
  if (base === 5 || base === 6 || e.code === "EBUSY") return "another program is using it";
  if (e.code === "ENOSPC" || base === 13) return "the disk is full";
  if (base === 3 || base === 8 || base === 14 || base === 23 || e.code === "EACCES" || e.code === "EPERM" || e.code === "EROFS") return "Pako has no permission to open it";
  return `a disk error (${e.code ?? e.message})`.slice(0, 120);
}

/**
 * Opens the file and checks it is a sound SQLite database with the store's table. Throws StoreDamaged when it is not one, StoreUnavailable when
 * it cannot be opened for any other reason (waited for `busyMs` first when another process holds it: its write takes a few milliseconds).
 */
function open(path: string, busyMs: number): Database {
  try {
    // Made empty first with the folder's private mode: SQLite keeps an existing file's mode, and gives its journal the same one.
    if (!existsSync(path)) writeFileSync(path, "", { mode: 0o600 });
    const Db = sqlite();
    const db = new Db(path, { timeout: busyMs });
    try {
      db.exec("PRAGMA synchronous = FULL");
      // What is deleted (an expired transcript, everything at "delete everything") is overwritten in the file, not left in free pages.
      db.exec("PRAGMA secure_delete = ON");
      const check = db.prepare("PRAGMA quick_check").get();
      if (!check || Object.values(check)[0] !== "ok") throw new StoreDamaged("quick_check failed");
      db.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER NOT NULL) WITHOUT ROWID");
      // The wait was for the opening only: a write that finds the file held fails at once, as it always did (and is told, see `failing`).
      db.exec("PRAGMA busy_timeout = 0");
      return db;
    } catch (err) {
      db.close();
      throw err;
    }
  } catch (err) {
    if (err instanceof StoreDamaged) throw err;
    if (damageOf(err)) throw new StoreDamaged((err as Error).message);
    throw new StoreUnavailable(`Pako cannot open its store (${path}): ${whyNotOpened(err)}. Nothing was changed. Close whatever is using it, then start Pako again.`);
  }
}

/** The names a damaged store's copies go by: kv.db.bad or kv.json.bad, an older one with the time it was displaced (kv.db.bad.2026-…Z), a journal beside its file. */
export const SET_ASIDE_COPY = /^kv\.(db|json)\.bad(\.\d{4}-\d{2}-\d{2}T[\d-]+Z(-\d+)?)?(-journal)?$/;

/**
 * Puts a damaged file aside as `to`, with the journal beside it (a journal belongs to its file: left next to a new store, SQLite would roll its
 * pages into it). A copy already at `to` is never written over: it is renamed with the time first, since it may be all that is left of what the
 * person kept. A move that fails leaves the files where they are: the next start sees them again.
 */
function setAside(from: string, to: string, at: number): void {
  try {
    const stamp = new Date(at).toISOString().replace(/[:.]/g, "-");
    let older = `${to}.${stamp}`;
    for (let n = 2; existsSync(older) || existsSync(`${older}-journal`); n++) older = `${to}.${stamp}-${n}`;
    for (const tail of ["-journal", ""]) if (existsSync(`${to}${tail}`)) renameSync(`${to}${tail}`, `${older}${tail}`);
    for (const tail of ["-journal", ""]) if (existsSync(`${from}${tail}`)) renameSync(`${from}${tail}`, `${to}${tail}`);
  } catch {
    /* left where it is: the next start sees it again */
  }
}

const move = (from: string, to: string): void => {
  try {
    rmSync(to, { force: true });
    renameSync(from, to);
  } catch {
    /* left where it is: the next start sees it again */
  }
};

/**
 * The store in `dir`. `lost` says why it started empty, as the JSON store did: its file was gone although one had been made here (kv.db.made, or an
 * older Pako's kv.json.made, remembers that), or it was damaged and kept aside (kv.db.bad, or kv.json.bad for an old JSON file). Null when
 * it was read, migrated, or never made.
 */
/**
 * Another app's database (Messages' chat.db, Mail's Envelope Index), read only, closed by the caller at once. While that app runs, its
 * write-ahead log sits beside it (-wal): read through it. With the app closed there is none, and a read-only open would still leave an
 * empty -wal and -shm behind: the file is then opened immutable, which writes nothing at all (an older SQLite without URI filenames falls
 * back to the plain read-only open). `query_only` on top, so no statement can change it.
 */
export function openForeignReadOnly(path: string): Database {
  const Db = sqlite();
  let db: Database | null = null;
  if (!existsSync(`${path}-wal`)) {
    try {
      db = new Db(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true, timeout: 2000 });
    } catch {
      /* no URI filenames here: the plain read-only open below */
    }
  }
  db ??= new Db(path, { readOnly: true, timeout: 2000 });
  try {
    db.exec("PRAGMA query_only = ON");
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

export function sqliteKv(dir: string, now: () => number = Date.now, busyMs = 3000): FileKv {
  const p = (name: keyof typeof STORE_FILES): string => join(dir, STORE_FILES[name]);
  let lost: StoreLost | null = null;
  let legacy: Record<string, { v: string; exp: number }> | null = null;

  /** An older Pako's kv.json, its well-formed entries; throws when it is not JSON. */
  const readLegacy = (): Record<string, { v: string; exp: number }> => {
    const raw = JSON.parse(readFileSync(p("legacy"), "utf8")) as Record<string, { v?: unknown; exp?: unknown }>;
    const out: Record<string, { v: string; exp: number }> = {};
    for (const [k, e] of Object.entries(raw ?? {})) if (typeof e?.v === "string" && typeof e.exp === "number") out[k] = { v: e.v, exp: e.exp };
    return out;
  };

  // A kv.db with nothing in it beside an older Pako's kv.json is a copy that did not finish (the process stopped inside the transaction,
  // which SQLite rolled back, or the disk was full): kv.json is still the store, and is copied in again now.
  let unfinished = false;
  if (existsSync(p("db"))) {
    try {
      const db = open(p("db"), busyMs);
      try {
        unfinished = existsSync(p("legacy")) && !db.prepare("SELECT 1 FROM kv LIMIT 1").get();
      } finally {
        db.close();
      }
    } catch (err) {
      // Only a file SQLite calls bad moves. One that is busy, or that this process cannot open, is not damaged: it stays as it is, with its
      // journal, and Pako does not start on an empty store over it (StoreUnavailable says why).
      if (!(err instanceof StoreDamaged)) throw err;
      lost = "damaged";
      log.error(`${p("db")} is damaged (${err.message}): kept as ${p("bad")}, starting with an empty one`);
      setAside(p("db"), p("bad"), now());
    }
  }
  if (lost) {
    /* said above */
  } else if (unfinished || (!existsSync(p("db")) && existsSync(p("legacy")))) {
    try {
      legacy = readLegacy();
    } catch {
      /* not JSON: logged, set aside, and an empty store */
      lost = "damaged";
      log.error(`${p("legacy")} is not valid JSON: kept as ${p("legacyBad")}, starting with an empty store`);
      setAside(p("legacy"), p("legacyBad"), now());
    }
  } else if (!existsSync(p("db")) && (existsSync(p("made")) || existsSync(p("legacyMade")))) lost = "missing";

  const db = open(p("db"), busyMs);
  const live = (exp: number): boolean => !(exp > 0 && exp < now());
  const q = {
    get: db.prepare("SELECT v, exp FROM kv WHERE k = ?"),
    put: db.prepare("INSERT INTO kv (k, v, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp"),
    del: db.prepare("DELETE FROM kv WHERE k = ?"),
    purge: db.prepare("DELETE FROM kv WHERE exp > 0 AND exp < ?"),
    all: db.prepare("SELECT k, v, exp FROM kv WHERE exp = 0 OR exp >= ? ORDER BY k"),
    clear: db.prepare("DELETE FROM kv"),
  };
  const tx = <T>(work: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = work();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* already rolled back by SQLite */
      }
      throw err;
    }
  };

  let marked = false;
  const markMade = (): void => {
    if (marked) return;
    try {
      if (!existsSync(p("made"))) writeFileSync(p("made"), "Pako keeps kv.db in this folder; if it goes missing, Pako starts paused and says so.\n", { mode: 0o600 });
      marked = true;
    } catch {
      /* tried again at the next write */
    }
  };

  /** Whether kv.db holds every live entry of an older Pako's kv.json exactly: the check that lets that file go. */
  const holds = (old: Record<string, { v: string; exp: number }>): boolean =>
    Object.entries(old).filter(([, e]) => live(e.exp)).every(([k, e]) => {
      const r = q.get.get(k);
      return !!r && String(r.v) === e.v && Number(r.exp) === e.exp;
    });
  if (legacy) {
    // One transaction: either everything is copied, or kv.json stays as it is and the next start tries again.
    tx(() => {
      for (const [k, e] of Object.entries(legacy!)) if (live(e.exp)) q.put.run(k, e.v, e.exp);
    });
    // Read every live key back from kv.db and compare. Only an exact copy lets the old plaintext file go: a leftover copy of the person's
    // things is a privacy cost, so it is not kept "just in case". If anything differs (which would be a bug), the old file is kept aside as
    // kv.json.migrated, listed on the privacy page and removed by "delete everything".
    const copied = Object.entries(legacy).filter(([, e]) => live(e.exp));
    if (holds(legacy)) {
      rmSync(p("legacy"), { force: true });
      log.info(`the store moved from ${STORE_FILES.legacy} to ${STORE_FILES.db} (${copied.length} entries, each checked); the old file is deleted`);
    } else {
      move(p("legacy"), p("migrated"));
      log.error(`the store moved to ${STORE_FILES.db}, but the copy did not match ${STORE_FILES.legacy}: the old file is kept as ${STORE_FILES.migrated}`);
    }
    rmSync(p("legacyMade"), { force: true });
  } else if (!lost && existsSync(p("legacy"))) {
    // A kv.json beside a kv.db that holds things: the copy was made and checked, and Pako stopped before the old file was deleted. Deleted
    // now, after the same check; one that does not match what kv.db holds is kept aside as kv.json.migrated, as a copy that did not match is.
    let old: Record<string, { v: string; exp: number }> | null = null;
    try {
      old = readLegacy();
    } catch {
      /* not JSON: kept aside below, never read as the store */
    }
    if (old && holds(old)) {
      rmSync(p("legacy"), { force: true });
      log.info(`${STORE_FILES.legacy} was still beside ${STORE_FILES.db}, which holds all of it: the old file is deleted`);
    } else {
      move(p("legacy"), p("migrated"));
      log.error(`${STORE_FILES.legacy} was still beside ${STORE_FILES.db} and does not match it: kept as ${STORE_FILES.migrated}`);
    }
    rmSync(p("legacyMade"), { force: true });
  }
  // A store read now (or just copied in) was made here: from now on, losing it can be told from a first run.
  if (existsSync(p("made")) || legacy || lost || q.all.all(0).length > 0) markMade();
  // An entry whose time has run out is not kept (docs/privacy.md: each one is deleted by itself), read again or not.
  q.purge.run(now());
  let purged = now();

  let saved: ((ok: boolean, detail?: string, since?: number) => void) | null = null;
  /**
   * The writes failing now, since when and why, in plain words; null while they go through. A failed write is not thrown to its caller (each
   * module would have to handle it): it is kept here and told to the watchdog (onSave), which tells the owner once, also when it came before
   * the watchdog was listening, and says so again when a write goes through.
   */
  let failing: { since: number; detail: string } | null = null;
  const plain = (err: unknown): string => {
    const e = err as NodeJS.ErrnoException & { errcode?: number };
    const base = typeof e.errcode === "number" ? e.errcode & 0xff : -1;
    if (e.code === "ENOSPC" || base === 13) return "the disk is full";
    if (e.code === "EACCES" || e.code === "EPERM" || e.code === "EROFS" || base === 8 || base === 14) {
      return "the disk is full, or the Pako folder cannot be written to";
    }
    return `a disk error (${e.code ?? e.message})`.slice(0, 120);
  };
  /** Set by wipe: nothing is written any more, until the process starts again. */
  let sealed = false;
  let closed = false;
  const write = (work: () => void): boolean => {
    if (sealed || closed) return false;
    try {
      work();
      if (now() - purged > 60_000) {
        q.purge.run(now());
        purged = now();
      }
      markMade();
      if (failing) log.info(`saving to ${p("db")} works again`);
      failing = null;
      saved?.(true);
      return true;
    } catch (err) {
      log.error(`could not save to ${p("db")}: ${(err as Error).message}`);
      failing ??= { since: now(), detail: plain(err) };
      saved?.(false, failing.detail, failing.since);
      return false;
    }
  };
  const ttl = (seconds: number): number => (seconds > 0 ? now() + seconds * 1000 : 0);
  process.on("exit", () => {
    if (closed) return;
    closed = true;
    try {
      db.close();
    } catch {
      /* the process is ending */
    }
  });

  return {
    lost,
    onSave: (report) => {
      saved = report;
      if (failing) report(false, failing.detail, failing.since);
    },
    entries: () =>
      q.all.all(now()).map((r) => ({ key: String(r.k), value: String(r.v), expires: Number(r.exp) > 0 ? Number(r.exp) : null })),
    wipe: (keep = []) => {
      sealed = true;
      try {
        tx(() => {
          q.clear.run();
          for (const k of keep) q.put.run(k.key, k.value, ttl(k.ttlSeconds));
        });
        saved?.(true);
        return true;
      } catch (err) {
        log.error(`could not empty ${p("db")}: ${(err as Error).message}`);
      }
      // A full disk can still remove a file: the next start must not read back what was just deleted. Without .made it starts as a first run.
      try {
        if (!closed) {
          closed = true;
          db.close();
        }
        for (const f of [p("db"), `${p("db")}-journal`, p("made")]) rmSync(f, { force: true, recursive: true });
        return true;
      } catch (err) {
        log.error(`could not remove ${p("db")} either: ${(err as Error).message}`);
        return false;
      }
    },
    get: async (k) => {
      if (closed) return null;
      const r = q.get.get(k);
      if (!r) return null;
      if (!live(Number(r.exp))) {
        write(() => q.del.run(k));
        return null;
      }
      return String(r.v);
    },
    // A write the disk refused rejects, as the hosted store's does (audit finding: it resolved, so a reminder said "saved" lived only in
    // memory and was gone at the next start). After delete-everything (sealed) or at exit (closed) nothing is written, on purpose: no error.
    set: async (k, v, ttlSeconds) => {
      if (sealed || closed) return;
      if (!write(() => q.put.run(k, v, ttl(ttlSeconds)))) throw new Error(`could not save: ${failing?.detail ?? "a disk error"}`);
    },
    // One process holds this folder (the home's lock), and the read and the write run with no await between them: atomic here.
    add: async (k, v, ttlSeconds) => {
      if (sealed || closed) return false;
      const r = q.get.get(k);
      if (r && live(Number(r.exp))) return false;
      return write(() => q.put.run(k, v, ttlSeconds > 0 ? ttl(ttlSeconds) : 0));
    },
  };
}
