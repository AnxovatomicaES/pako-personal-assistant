// One gate for reading a Slack conversation's messages (conversations.history and conversations.replies) with one user token: the
// minute's look for new DMs (src/slack-poll.ts) and the follow-ups' own reads (a conversation's context, whether the owner replied) go
// through it, so they never spend the same call twice. The project's own app, while not in the Slack Marketplace, gets one such call a
// minute from Slack: the gate keeps to it. Slack's "ratelimited" says how long to wait (Retry-After): no call goes before that.
// A follow-up's read waits for the next free call and goes before the poll; the poll never waits: it reads that conversation next round.

import { waitLeft } from "./clock.ts";

/** A call this close to its minute is let go: the poll's own minute is never quite sixty seconds. */
const EARLY_MS = 2_000;
/** A follow-up waits at most this long for a call; past it the read is said as Slack being busy. */
const WAIT_MAX_MS = 75_000;

export interface SlackGateDeps {
  /** Calls a minute Slack allows this app (1 for the project's own app before it is listed); none: only Slack's own Retry-After. */
  perMinute?: number;
  now?: () => number;
  /** The wait itself (the tests move their clock instead). */
  sleep?: (ms: number) => Promise<void>;
}

export function createSlackGate(d: SlackGateDeps = {}) {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const spacing = d.perMinute && d.perMinute > 0 ? 60_000 / d.perMinute : 0;
  /** The next call the minute's budget allows, and the end of the wait Slack asked for. */
  let spacedAt = 0;
  let retryAt = 0;
  /** How long the wait Slack asked for lasts (waitLeft: never longer, whatever the clock does). */
  let retryMs = 0;
  /** Follow-up reads waiting: the poll leaves the call to them. */
  let waiting = 0;
  let chain: Promise<unknown> = Promise.resolve();
  const waitFor = (): number => Math.max(waitLeft(retryAt, retryMs, now()), spacing ? waitLeft(spacedAt - EARLY_MS, spacing, now()) : 0);
  const take = (): void => {
    if (spacing) spacedAt = now() + spacing;
  };
  return {
    /** A follow-up's read: waits its turn and the next free call. False when Slack asked for a longer wait than a read can take. */
    check: (): Promise<boolean> => {
      waiting++;
      const run = chain.then(async () => {
        try {
          const ms = waitFor();
          if (ms > WAIT_MAX_MS) return false;
          if (ms > 0) await sleep(ms);
          take();
          return true;
        } finally {
          waiting--;
        }
      });
      chain = run.catch(() => undefined);
      return run;
    },
    /** The poll's read: true when a call is free now and no follow-up waits for one (it is then spent); false to read it next round. */
    poll: (): boolean => {
      if (waiting > 0 || waitFor() > 0) return false;
      take();
      return true;
    },
    /** Slack answered "ratelimited": no read before `ms` from now (Retry-After, a minute when it named none). */
    limited: (ms: number): void => {
      const wait = Number.isFinite(ms) && ms > 0 ? Math.min(ms, 3600_000) : 60_000;
      if (now() + wait > retryAt || !waitLeft(retryAt, retryMs, now())) [retryAt, retryMs] = [now() + wait, wait];
    },
  };
}

export type SlackGate = ReturnType<typeof createSlackGate>;
