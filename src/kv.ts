// A minimal Redis-protocol client (GET, SET with expiry, SET NX, and a raw command for the writer lease) for the Render Key Value store
// that keeps the voice calls' results across restarts of the main server: a free web service forgets its memory and its disk every time it
// sleeps.
// No dependency: one short-lived connection per command is enough at a few calls a day.

import { connect as tcp, type Socket } from "node:net";
import { connect as tls } from "node:tls";

export interface Kv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /**
   * Writes `value` only when `key` holds nothing (Redis SET NX): true when this call wrote it. Atomic across every process on the store, so
   * two servers on one store (a deploy's overlap) cannot both take one claim (src/jobs.ts). Optional: a store without it (the tests' stand-ins)
   * leaves the jobs on their one-process guard.
   */
  add?(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  /**
   * One raw command, its reply as it came (a string, a number or null): what the writer lease (src/kv-lease.ts) needs beyond GET and SET
   * (SET NX PX, and EVAL for a renewal or a release that touches the lease only while it is still this server's). Only the Redis store has it.
   */
  command?(args: string[]): Promise<string | number | null>;
}

/** Encodes one command in the protocol's array-of-bulk-strings form. */
export function encode(args: string[]): Buffer {
  const parts = [`*${args.length}\r\n`];
  for (const a of args) parts.push(`$${Buffer.byteLength(a)}\r\n${a}\r\n`);
  return Buffer.from(parts.join(""));
}

/**
 * Reads one reply: simple string, error, integer or bulk string. Returns undefined while the buffer holds less than a whole reply.
 * Throws on an error reply.
 */
export function decode(buf: Buffer): { value: string | number | null } | undefined {
  const end = buf.indexOf("\r\n");
  if (end < 0) return undefined;
  const head = buf.subarray(1, end).toString();
  switch (String.fromCharCode(buf[0]!)) {
    case "+":
      return { value: head };
    case "-":
      throw new Error(`key value store: ${head}`);
    case ":":
      return { value: Number(head) };
    case "$": {
      const len = Number(head);
      if (len < 0) return { value: null };
      if (buf.length < end + 2 + len + 2) return undefined;
      return { value: buf.subarray(end + 2, end + 2 + len).toString() };
    }
    default:
      throw new Error("key value store: unexpected reply");
  }
}

/** Null without a usable URL (redis:// or rediss://, optional user:password): results then stay in memory only, as before. */
export function loadKv(rawUrl: string | undefined, o: { timeoutMs?: number } = {}): Kv | null {
  let url: URL;
  try {
    url = new URL((rawUrl ?? "").trim());
  } catch {
    /* not a URL: no store, results stay in memory (as documented above) */
    return null;
  }
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") return null;
  const host = url.hostname;
  const port = Number(url.port || 6379);
  const secure = url.protocol === "rediss:";
  // A malformed escape in a pasted password is kept as typed rather than failing the whole server start.
  const dec = (v: string) => {
    try {
      return decodeURIComponent(v);
    } catch {
      /* a malformed escape: kept as typed (above) */
      return v;
    }
  };
  const auth = url.password ? [dec(url.username || "default"), dec(url.password)] : undefined;
  const timeoutMs = o.timeoutMs ?? 3000;

  const run = (args: string[]): Promise<string | number | null> =>
    new Promise((resolve, reject) => {
      const sock: Socket = secure ? tls({ host, port, servername: host }) : tcp({ host, port });
      const replies: (string | number | null)[] = [];
      const want = auth ? 2 : 1;
      let buf = Buffer.alloc(0);
      // A hard deadline, independent of the socket's idle timer (which a destroyed or half-closed socket no longer runs).
      const deadline = setTimeout(() => done(new Error("key value store: timed out")), timeoutMs);
      const done = (err?: Error) => {
        clearTimeout(deadline);
        sock.destroy();
        if (err) reject(err);
        else resolve(replies[want - 1] ?? null);
      };
      sock.setTimeout(timeoutMs, () => done(new Error("key value store: timed out")));
      sock.on("error", (err) => done(err));
      // Closed by the store before the whole reply came: settle now (after a full reply this reject is a no-op).
      sock.on("close", () => done(new Error("key value store: connection closed")));
      sock.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        try {
          while (replies.length < want) {
            const r = decode(buf);
            if (!r) return;
            replies.push(r.value);
            buf = buf.subarray(replyLength(buf));
          }
          done();
        } catch (err) {
          done(err as Error);
        }
      });
      sock.write(Buffer.concat([...(auth ? [encode(["AUTH", ...auth])] : []), encode(args)]));
    });

  return {
    async get(key) {
      const v = await run(["GET", key]);
      return typeof v === "string" ? v : null;
    },
    async set(key, value, ttlSeconds) {
      await run(["SET", key, value, "EX", String(Math.max(1, Math.floor(ttlSeconds)))]);
    },
    async add(key, value, ttlSeconds) {
      // "OK" when written, a nil reply when the key was already there.
      return (await run(["SET", key, value, "NX", "EX", String(Math.max(1, Math.floor(ttlSeconds)))])) === "OK";
    },
    command: (args) => run(args),
  };
}

/** Byte length of the whole reply at the start of the buffer (decode already checked it is complete). */
function replyLength(buf: Buffer): number {
  const end = buf.indexOf("\r\n");
  if (String.fromCharCode(buf[0]!) === "$") {
    const len = Number(buf.subarray(1, end).toString());
    return len < 0 ? end + 2 : end + 2 + len + 2;
  }
  return end + 2;
}
