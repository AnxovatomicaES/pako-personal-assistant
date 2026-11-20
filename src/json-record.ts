// Whole-record JSON in the store: most of Pako's state is one key holding one JSON value (the follow-ups, the reminders, the inbox...), read
// whole, changed, and written back whole. A value that is not valid JSON any more (a write cut short, a disk error, a hand edit) used to be
// read as "nothing" with a line in the log, and the next write then replaced it: whatever was in it was gone without a word.
//
// readJsonRecord is the one way such a record is read. A record that does not parse is first copied aside, as it is, to
// `corrupt:<key>:<time>` (kept 180 days, never exported: it may hold anything the record held; the sqlite store does the same for its whole file, kv.db.bad), then the owner is told, once per
// record and process, and only then does the caller start that record again empty. When the copy cannot be kept aside (the store refuses
// the write) the read fails instead: a caller that writes after reading then writes nothing, and the damaged value stays where it is.
//
// Who writes: at home, only the server, which holds the folder's lock (src/local.ts lockHome) before it opens the store (src/server.ts);
// the bridge, the panel command (bin/panel.cjs) and the Mac app never open kv.db (test/json-record.test.ts checks both). So there is one
// writer per store, and within it each module changes its record one change at a time (src/followups/store.ts and the like).

import { createHash } from "node:crypto";
import { texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import { createLog } from "./log.ts";

// Made when first used: src/codes.ts reads its record through this file, and src/log.ts imports src/codes.ts before the log exists.
let made: ReturnType<typeof createLog> | null = null;
const log = (): ReturnType<typeof createLog> => (made ??= createLog("store"));

const T = texts({
  notice: "⚠️ Part of what I keep ({what}) was damaged and could not be read. I kept the damaged copy aside ({aside}, for 180 days) "
    + "and started that part again empty; nothing else was touched.",
});

/** How long the damaged copy is kept. */
export const CORRUPT_TTL_S = 180 * 24 * 3600;
/** Where a damaged record's value is kept aside (src/data.ts lists the family). */
export const corruptKey = (keyAndTime: string): string => `corrupt:${keyAndTime}`;

export interface CorruptRecord {
  /** The record's key. */
  key: string;
  /** Where its damaged value was copied, as it was. */
  aside: string;
  bytes: number;
  at: number;
}

export type CorruptListener = (c: CorruptRecord) => void;

let listener: CorruptListener | null = null;
/** Found before anyone listened (the owner's chat is built after the first reads): told once a listener comes. */
const waiting: CorruptRecord[] = [];
/** key → a hash of the damaged value already kept aside by this process: the same damage is kept and told once. */
const keptAside = new Map<string, string>();

/** Who hears of a damaged record (src/app.ts: the owner, as a notice). Ones found before are passed on now. Null stops listening. */
export function onCorruptRecord(fn: CorruptListener | null): void {
  listener = fn;
  if (fn) for (const c of waiting.splice(0)) tell(fn, c);
}

const tell = (fn: CorruptListener, c: CorruptRecord): void => {
  try {
    fn(c);
  } catch (err) {
    log().error(`could not tell about ${c.key}: ${(err as Error).message}`);
  }
};

/** The owner's notice for a damaged record (English, as all of Pako's own texts). */
export function corruptNotice(c: CorruptRecord, lang: Lang = "en"): string {
  return T(lang)("notice", { what: c.key, aside: c.aside });
}

/** Test only: forgets what was kept aside and told, and the listener. */
export function resetCorruptRecords(): void {
  keptAside.clear();
  waiting.length = 0;
  listener = null;
}

/**
 * The record at `key`, parsed: undefined when there is none (or it is empty), and undefined too when it does not parse, after the damaged
 * value was kept aside and told (see the top of this file). Throws when the store cannot be read, or when a damaged value cannot be kept
 * aside: the caller then changes nothing. `onCorrupt` hears of it instead of the process-wide listener (onCorruptRecord).
 */
export async function readJsonRecord(kv: Kv, key: string, o: { onCorrupt?: CorruptListener; now?: () => number } = {}): Promise<unknown> {
  const raw = await kv.get(key);
  if (raw === null || raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // below
  }
  const hash = createHash("sha256").update(raw).digest("hex");
  if (keptAside.get(key) === hash) return undefined;
  const at = (o.now ?? Date.now)();
  const aside = corruptKey(`${key}:${at}`);
  try {
    await kv.set(corruptKey(`${key}:${at}`), raw, CORRUPT_TTL_S);
  } catch (err) {
    log().error(`${key} is not valid JSON and could not be kept aside (${(err as Error).message}): left as it is, nothing written over it`);
    throw new Error(`the stored ${key} is damaged and could not be kept aside`);
  }
  keptAside.set(key, hash);
  log().error(`${key} is not valid JSON (${raw.length} bytes): kept aside as ${aside}, that record starts again empty`);
  const c: CorruptRecord = { key, aside, bytes: raw.length, at };
  const fn = o.onCorrupt ?? listener;
  if (fn) tell(fn, c);
  else if (waiting.length < 20) waiting.push(c);
  return undefined;
}
