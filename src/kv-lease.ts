// One writer on the hosted Redis store. During a deploy, two servers run for a while on the same store (the new one is started before the
// old one is stopped), and a server has no home lock (src/local.ts has one, for a computer's folder). Both would write: the brief twice, a
// reminder's state written back over the other's. This lease makes one of them the writer.
//
// - The lease is a key (pako-writer) set with SET NX PX: the server that wrote it holds it for LEASE_MS, and renews it every RENEW_MS with a
//   script that extends it only while it still holds this server's id. A server that is stopped releases it (the same check, then DEL), so
//   the next one takes over within WAIT_MS; one that dies without a word loses it when it expires.
// - The other server waits: it asks again every WAIT_MS, and until it holds the lease its store is read only. Reads go through; a claim
//   (SET NX) answers "taken", so no job runs twice; a write waits for the lease (up to WRITE_WAIT_MS) and is then made, or fails loudly.
//   During a deploy the new server gets the owner's messages before the old one stops: a "remind me at 5" is kept, never skipped. It says so in the log once when it starts waiting, and once when it
//   takes over.
// - A renewal that fails because the store did not answer keeps the writer until its own lease would have run out (by its clock, from the
//   moment it asked); a renewal that finds another id means the lease was lost: read only at once, and waiting again.
// - The first look happens when the lease is made: a write before it has an answer waits for it (one store round trip), so nothing written
//   at start-up slips past the lease.

import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import type { Kv } from "./kv.ts";
import { createLog } from "./log.ts";

const log = createLog("store");

export const LEASE_KEY = "pako-writer";
export const LEASE_MS = 30_000;
export const RENEW_MS = 10_000;
export const WAIT_MS = 3_000;
/** How long a write waits for the lease: a full lease that ran out, and two more looks. */
export const WRITE_WAIT_MS = LEASE_MS + 2 * WAIT_MS;

/** Extends the lease only while it is still this server's (1), else nothing (0). */
export const RENEW_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
/** Deletes the lease only while it is still this server's (1), else nothing (0). */
export const RELEASE_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export interface WriterLease {
  /** The store as the rest of Pako uses it: writes go through only while this server holds the lease. */
  kv: Kv;
  /** True while this server holds the lease (by its own clock: never past the moment it would have run out). */
  writer(): boolean;
  /** This server's id in the lease (its host name, its process and a random part). */
  id: string;
  /** Settles once the first look (made when the lease is made) has its answer. */
  ready: Promise<void>;
  /** One look: renews the lease when held, else tries to take it. The loop calls it; the tests call it themselves. */
  step(): Promise<void>;
  /** Starts the loop (a renewal every RENEW_MS while writer, a try every WAIT_MS while waiting). */
  start(): Promise<void>;
  /** Stops the loop and releases the lease when this server holds it. */
  stop(): Promise<void>;
}

type Raw = Kv & { command: NonNullable<Kv["command"]> };

export const hasCommand = (kv: Kv | null): kv is Raw => !!kv && typeof kv.command === "function";

export function createWriterLease(
  raw: Raw,
  o: {
    key?: string; leaseMs?: number; renewMs?: number; waitMs?: number; writeWaitMs?: number; id?: string; now?: () => number;
    log?: (text: string) => void; sleep?: (ms: number) => Promise<void>;
  } = {},
): WriterLease {
  const key = o.key ?? LEASE_KEY;
  const leaseMs = o.leaseMs ?? LEASE_MS;
  const renewMs = o.renewMs ?? RENEW_MS;
  const waitMs = o.waitMs ?? WAIT_MS;
  const writeWaitMs = o.writeWaitMs ?? WRITE_WAIT_MS;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const say = o.log ?? ((text: string) => log.info(text));
  const id = o.id ?? `${hostname().slice(0, 60)}:${process.pid}:${randomBytes(4).toString("hex")}`;

  /** Until when this server is the writer, by its clock (0: it is not). */
  let heldUntil = 0;
  /** What the log last said: "writer", "waiting", or nothing yet. */
  let said: "writer" | "waiting" | null = null;
  let skipped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const writer = (): boolean => heldUntil > now();

  const becomeWriter = (at: number): void => {
    heldUntil = at + leaseMs;
    skipped = false;
    if (said !== "writer") say(said === "waiting" ? `took the store's writer lease (${id}): writing again` : `holds the store's writer lease (${id})`);
    said = "writer";
  };
  const wait = async (why: string): Promise<void> => {
    heldUntil = 0;
    if (said === "waiting") return;
    said = "waiting";
    const holder = await raw.get(key).catch(() => null);
    say(`${why}: another server writes the store${holder ? ` (${holder})` : ""}. Read only until its lease is free; waiting.`);
  };

  /** One look at a time: two at once would both SET NX, and the second's "held" would drop the first's win. */
  let inflight: Promise<void> | null = null;
  const step = (): Promise<void> => (inflight ??= look().finally(() => (inflight = null)));
  const look = async (): Promise<void> => {
    const at = now();
    try {
      if (heldUntil > 0) {
        const r = await raw.command(["EVAL", RENEW_SCRIPT, "1", key, id, String(leaseMs)]);
        if (Number(r) === 1) becomeWriter(at);
        else await wait("the writer lease was lost");
        return;
      }
      const r = await raw.command(["SET", key, id, "NX", "PX", String(leaseMs)]);
      if (r === "OK") becomeWriter(at);
      else await wait("the writer lease is held");
    } catch (err) {
      // No answer: a writer stays one until its lease would have run out; then it waits like any other.
      say(`the writer lease could not be ${heldUntil > 0 ? "renewed" : "asked for"}: ${(err as Error).message}`);
      if (heldUntil > 0 && !writer()) await wait("the writer lease ran out");
    }
  };

  // The first look, at once: a write before its answer waits for it.
  const ready = step();
  let first: Promise<void> | null = ready.finally(() => (first = null));

  const allowed = async (what: string): Promise<boolean> => {
    if (first) await first;
    if (writer()) return true;
    if (!skipped) say(`read only (another server holds the writer lease): a ${what} was skipped, and the next ones are too until it is free`);
    skipped = true;
    return false;
  };

  const loop = (): void => {
    if (!running) return;
    timer = setTimeout(() => {
      void step().finally(loop);
    }, writer() ? renewMs : waitMs);
    timer.unref?.();
  };

  /** A write on a server that waits: it waits for the lease, then is made; past writeWaitMs it fails, so the caller can say so. */
  const waitToWrite = async (): Promise<void> => {
    if (first) await first;
    if (writer()) return;
    say(`a write waits for the store's writer lease (another server holds it)`);
    const until = now() + writeWaitMs;
    for (;;) {
      await step();
      if (writer()) return;
      if (now() >= until) throw new Error("the store is read only: another server holds its writer lease");
      await sleep(waitMs);
    }
  };

  const kv: Kv = {
    get: (k) => raw.get(k),
    set: async (k, value, ttl) => {
      await waitToWrite();
      await raw.set(k, value, ttl);
    },
    ...(raw.add ? { add: async (k: string, value: string, ttl: number) => ((await allowed("claim")) ? raw.add!(k, value, ttl) : false) } : {}),
  };

  return {
    kv,
    id,
    ready,
    writer,
    step,
    start: async () => {
      if (running) return;
      running = true;
      if (first) await first;
      loop();
    },
    stop: async () => {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
      if (first) await first;
      if (heldUntil === 0) return;
      heldUntil = 0;
      await raw.command(["EVAL", RELEASE_SCRIPT, "1", key, id]).catch((err: Error) => say(`the writer lease could not be released: ${err.message}`));
    },
  };
}
