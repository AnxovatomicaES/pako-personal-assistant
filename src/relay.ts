// Pako Relay: reminders that still come when the laptop's lid is shut (beta-plan "Pako Relay"; audit B). Opt-in, off by default.
//
// The relay is this same server run somewhere that stays awake, with RELAY_TOKEN set. The owner's own Pako (the laptop) syncs to it every
// couple of minutes: the reminders of the next week, each an occurrence with an id and a version (POST /relay/sync, the whole list each time:
// one the laptop no longer sends was cancelled or changed). The relay fires each due (id, version) at most once, on Telegram, and records it.
// When the laptop wakes, its first sync brings back what the relay fired while it slept, and the laptop marks those sent instead of sending
// them again (src/relay-client.ts).
//
// Waking: a tick every 30 s while the process runs; a host that sleeps is woken by an outside ping (POST /relay/tick with the token, from a
// cron service every few minutes), which fires what is due. What it keeps (RELAY_STATE_KEY): the reminders' text and times for the week
// ahead, and what fired in the last 30 days (ids and times only). DELETE /relay/sync wipes it.
//
//   RELAY_TOKEN             the shared secret (32+ characters), the same on the laptop; turns relay mode on
//   RELAY_TELEGRAM_TOKEN    the bot that sends the reminders (the owner's own bot; see docs/relay.md)
//   RELAY_TELEGRAM_CHAT     the owner's chat id with that bot

import express, { type Express, type Request } from "express";
import { rateLimit } from "express-rate-limit";
import { sameSecret } from "./panel-guard.ts";
import type { Kv } from "./kv.ts";
import { createLog } from "./log.ts";
import { readJsonRecord } from "./json-record.ts";

const log = createLog("relay");

export const RELAY_STATE_KEY = "relay-state";
const FIRED_KEEP_MS = 30 * 24 * 3600_000;
/** Fired late (the host slept past it): said so; past this, not fired at all (the laptop says it was missed when it wakes). */
const LATE_MAX_MS = 12 * 3600_000;
const MAX_REMINDERS = 500;

export interface RelayReminder {
  /** The occurrence: the reminder's id and its time ("ab12cd34@1763280000000"); a repeat's next one is another. */
  id: string;
  /** Changes when its text or time changes: a changed reminder is fired at its new version, never twice. */
  version: string;
  at: number;
  text: string;
}
export interface RelayFired {
  id: string;
  version: string;
  at: number;
}
interface State {
  reminders: RelayReminder[];
  fired: RelayFired[];
  syncedAt: number;
}

export interface RelayConfig {
  token: string;
  telegramToken: string;
  telegramChat: string;
}

/** Relay mode's settings, or null (off) with the problems of a half-set one. */
export function loadRelayConfig(env: Record<string, string | undefined>): { config: RelayConfig | null; problems: string[] } {
  const token = (env.RELAY_TOKEN ?? "").trim();
  if (!token) return { config: null, problems: [] };
  const problems: string[] = [];
  if (token.length < 32) problems.push("RELAY_TOKEN must be 32 characters or more");
  const telegramToken = (env.RELAY_TELEGRAM_TOKEN ?? "").trim();
  const telegramChat = (env.RELAY_TELEGRAM_CHAT ?? "").trim();
  if (!/^\d+:[\w-]{30,}$/.test(telegramToken)) problems.push("RELAY_TELEGRAM_TOKEN is not a bot token (12345:ABC…)");
  if (!/^-?\d{3,20}$/.test(telegramChat)) problems.push("RELAY_TELEGRAM_CHAT is not a chat id (digits)");
  return problems.length ? { config: null, problems } : { config: { token, telegramToken, telegramChat }, problems };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const key = (x: { id: string; version: string }): string => `${x.id}|${x.version}`;

/** The reminders a sync sent, read field by field (other fields dropped, text cut): null when it is not a list of them. */
export function remindersOf(v: unknown): RelayReminder[] | null {
  if (!Array.isArray(v)) return null;
  const out: RelayReminder[] = [];
  for (const x of v.slice(0, MAX_REMINDERS)) {
    if (!isObject(x) || typeof x.id !== "string" || typeof x.version !== "string" || typeof x.at !== "number" || typeof x.text !== "string") continue;
    if (!/^[\w@.:-]{1,80}$/.test(x.id) || !/^[\w.:-]{1,80}$/.test(x.version) || !Number.isFinite(x.at)) continue;
    out.push({ id: x.id, version: x.version, at: x.at, text: x.text.replace(/\s+/g, " ").trim().slice(0, 500) });
  }
  return out;
}

export function createRelay(d: {
  kv: Kv | null;
  now?: () => number;
  /** Sends one message to the owner (Telegram); false when it did not go (tried again at the next tick). */
  send: (text: string) => Promise<boolean>;
}) {
  const now = d.now ?? Date.now;
  let memory: State = { reminders: [], fired: [], syncedAt: 0 };
  let chain: Promise<unknown> = Promise.resolve();
  const load = async (): Promise<State> => {
    if (!d.kv) return structuredClone(memory);
    try {
      const v = ((await readJsonRecord(d.kv, RELAY_STATE_KEY)) ?? {}) as Partial<State>;
      return { reminders: Array.isArray(v.reminders) ? v.reminders : [], fired: Array.isArray(v.fired) ? v.fired : [], syncedAt: Number(v.syncedAt) || 0 };
    } catch (err) {
      log.warn(`the relay's state could not be read, starting empty: ${err instanceof SyntaxError ? "not JSON" : (err as Error).message}`);
      return { reminders: [], fired: [], syncedAt: 0 };
    }
  };
  const save = async (s: State): Promise<void> => {
    memory = s;
    if (d.kv) await d.kv.set(RELAY_STATE_KEY, JSON.stringify(s), 31 * 24 * 3600);
  };
  const locked = <R>(fn: (s: State) => Promise<R>): Promise<R> => {
    const run = chain.then(async () => fn(await load()));
    chain = run.catch(() => undefined);
    return run;
  };

  /** The laptop's sync: its whole list replaces the relay's; the answer is what fired since `since` (the laptop marks those sent). */
  const sync = (reminders: RelayReminder[], since: number): Promise<{ fired: RelayFired[] }> =>
    locked(async (s) => {
      const t = now();
      s.fired = s.fired.filter((f) => t - f.at < FIRED_KEEP_MS);
      const done = new Set(s.fired.map(key));
      // What already fired is not kept to fire again; the rest is the laptop's list as it is now.
      s.reminders = reminders.filter((r) => !done.has(key(r)));
      s.syncedAt = t;
      await save(s);
      return { fired: s.fired.filter((f) => f.at > since) };
    });

  /** Fires what is due, each (id, version) once; one that could not go stays for the next tick. The number sent. */
  const tick = (): Promise<number> =>
    locked(async (s) => {
      const t = now();
      let sent = 0;
      for (const r of s.reminders.filter((x) => x.at <= t).sort((a, b) => a.at - b.at)) {
        if (s.fired.some((f) => key(f) === key(r))) continue;
        if (t - r.at > LATE_MAX_MS) {
          s.reminders = s.reminders.filter((x) => key(x) !== key(r));
          continue;
        }
        const late = t - r.at > 5 * 60_000;
        if (!(await d.send(`⏰ ${late ? "(late) " : ""}${r.text}`).catch(() => false))) continue;
        s.fired.push({ id: r.id, version: r.version, at: t });
        s.reminders = s.reminders.filter((x) => key(x) !== key(r));
        sent++;
      }
      await save(s);
      return sent;
    });

  /** Forgets everything the relay holds (the owner turned it off). */
  const wipe = (): Promise<void> => locked(async () => save({ reminders: [], fired: [], syncedAt: 0 }));

  return { sync, tick, wipe };
}

export type Relay = ReturnType<typeof createRelay>;

/** Sends through the Telegram Bot API to the owner's chat with that bot. */
export const telegramSender = (c: RelayConfig, fetchFn: typeof fetch = fetch) => async (text: string): Promise<boolean> => {
  try {
    const r = await fetchFn(`https://api.telegram.org/bot${c.telegramToken}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: c.telegramChat, text }),
    });
    return r.ok;
  } catch (err) {
    log.error(`a reminder could not be sent: ${(err as Error).name}`);
    return false;
  }
};

// Compared hashed, so nothing of the token's length leaks (audit finding: the lengths were compared first).
const bearer = (req: Request, token: string): boolean => sameSecret((req.get("authorization") ?? "").replace(/^Bearer\s+/i, ""), token);

/** The relay's routes: POST /relay/sync, POST /relay/tick (the outside wake), DELETE /relay/sync (wipe). The token on each. */
export function mountRelay(app: Express, d: { relay: Relay; token: string }): void {
  const json = express.json({ limit: "256kb" });
  // Only refusals are counted (the bridge's way): a guesser is slowed down, the relay's own computer never is.
  const refused = rateLimit({
    windowMs: 15 * 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false, skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) => res.statusCode !== 401,
    handler: (_req, res) => void res.status(429).json({ error: "too many" }),
  });
  const auth = (req: Request, res: express.Response, next: express.NextFunction) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    return bearer(req, d.token) ? next() : void res.status(401).json({ error: "token" });
  };
  app.post("/relay/sync", refused, auth, json, async (req, res) => {
    const b = isObject(req.body) ? req.body : {};
    const reminders = remindersOf(b.reminders);
    if (!reminders) return void res.status(400).json({ error: "send { reminders: [{ id, version, at, text }], since }" });
    try {
      res.json(await d.relay.sync(reminders, typeof b.since === "number" ? b.since : 0));
      void d.relay.tick().catch(() => undefined);
    } catch (err) {
      log.error(`a sync failed: ${(err as Error).message}`);
      res.status(503).json({ error: "store" });
    }
  });
  app.post("/relay/tick", refused, auth, async (_req, res) => {
    try {
      res.json({ sent: await d.relay.tick() });
    } catch (err) {
      log.warn(`the relay's tick failed: ${(err as Error).message}`);
      res.status(503).json({ error: "store" });
    }
  });
  // Turning the relay off: only "ok" once its copy of the reminders is really gone (audit finding: a failed wipe answered ok, and the
  // relay went on sending them).
  app.delete("/relay/sync", refused, auth, async (_req, res) => {
    try {
      await d.relay.wipe();
      res.json({ ok: true });
    } catch (err) {
      log.warn(`the relay's copy could not be deleted: ${(err as Error).message}`);
      res.status(503).json({ error: "store" });
    }
  });
}
