// The laptop's side of Pako Relay (src/relay.ts): every two minutes, and before its own look at the reminders that are due, it sends the
// relay the reminders of the next week and hears back what the relay fired while it slept. Those it marks sent instead of sending again.
// Opt-in: RELAY_URL and RELAY_TOKEN set here, the relay's own settings there (docs/relay.md).

import { createHash } from "node:crypto";
import type { RelayFired, RelayReminder } from "./relay.ts";
import { createLog } from "./log.ts";

const log = createLog("relay");

const WEEK_MS = 7 * 24 * 3600_000;
/** A wake's sync waits this long at most before the laptop's own reminders go (the relay may be away too). */
const SYNC_WAIT_MS = 8_000;

export interface RelayClientConfig {
  url: string;
  token: string;
}

export function loadRelayClientConfig(env: Record<string, string | undefined>): { config: RelayClientConfig | null; problems: string[] } {
  const url = (env.RELAY_URL ?? "").trim().replace(/\/+$/, "");
  const token = (env.RELAY_TOKEN ?? "").trim();
  if (!url) return { config: null, problems: [] };
  const problems: string[] = [];
  if (!/^https:\/\/[^\s/]+/.test(url)) problems.push("RELAY_URL must be an https:// address");
  if (token.length < 32) problems.push("RELAY_TOKEN must be 32 characters or more, the same as on the relay");
  return problems.length ? { config: null, problems } : { config: { url, token }, problems };
}

/** One occurrence of a reminder as the relay keeps it: its id and time, and a version that changes with its words or time. */
export function occurrence(r: { id: string; at: number; text: string }): RelayReminder {
  const version = createHash("sha256").update(`${r.at}\n${r.text}`).digest("hex").slice(0, 16);
  return { id: `${r.id}@${r.at}`, version, at: r.at, text: r.text };
}

export function createRelayClient(d: {
  config: RelayClientConfig;
  /** The reminders as the laptop keeps them now (held ones are the owner's next message's, never the relay's). */
  reminders: () => Promise<{ id: string; at: number; text: string; held?: boolean }[]>;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const f = d.fetch ?? fetch;
  const now = d.now ?? Date.now;
  let since = 0;
  /** What the relay said it fired, as "id|version": the laptop's look never sends these again. */
  const fired = new Set<string>();

  /** One sync; false when the relay did not answer (the laptop then sends its reminders itself, as without a relay). */
  const sync = async (): Promise<boolean> => {
    const t = now();
    // What is due now is left out: this computer is awake and sends it itself (src/door/reminders-due.ts, right after this sync). Sent
    // to the relay, it would fire there too (its sync runs a tick at once, and another comes within 30 s) before the next sync takes it
    // back: the owner would get it twice. One the relay already fired comes back in this answer, and the laptop marks it sent instead.
    const list = (await d.reminders()).filter((r) => !r.held && r.at > t && r.at < t + WEEK_MS).map(occurrence);
    try {
      const r = await f(`${d.config.url}/relay/sync`, {
        method: "POST",
        headers: { authorization: `Bearer ${d.config.token}`, "content-type": "application/json" },
        body: JSON.stringify({ reminders: list, since }),
        signal: AbortSignal.timeout(SYNC_WAIT_MS),
      });
      if (!r.ok) {
        log.error(`the relay answered ${r.status}`);
        return false;
      }
      const body = (await r.json()) as { fired?: RelayFired[] };
      for (const x of Array.isArray(body.fired) ? body.fired : []) {
        if (typeof x?.id === "string" && typeof x?.version === "string") fired.add(`${x.id}|${x.version}`);
        if (typeof x?.at === "number") since = Math.max(since, x.at);
      }
      return true;
    } catch (err) {
      log.error(`the relay could not be reached: ${(err as Error).name}`);
      return false;
    }
  };

  /** Whether the relay already sent this reminder at this time (the laptop then marks it sent, and sends nothing). */
  const firedByRelay = (r: { id: string; at: number; text: string }): boolean => {
    const o = occurrence(r);
    return fired.has(`${o.id}|${o.version}`);
  };

  return {
    sync,
    firedByRelay,
    start: () => {
      void sync();
      setInterval(() => void sync(), 2 * 60_000).unref?.();
    },
  };
}

export type RelayClient = ReturnType<typeof createRelayClient>;
