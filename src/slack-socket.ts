// Slack's Socket Mode: the events of the owner's Slack app come over a WebSocket that Pako opens itself, so a computer at home with no public
// address gets them as a server does (src/slack.ts takes them in the same handler as the events address).
//
// - apps.connections.open, with the app-level token (xapp-, scope connections:write), gives a one-time wss:// address; Node's own WebSocket
//   opens it. Slack says "hello", then sends envelopes: each is acknowledged at once ({ envelope_id }), well within Slack's three seconds, and
//   only then is an events_api payload handed on. Other envelope types (slash commands, buttons) are acknowledged and left: the app has none.
// - Slack asks for a new connection now and then ("disconnect", refresh_requested or warning): a new one is opened at once. A connection that
//   closes, fails or never says hello is opened again after a wait that doubles each time (1 s up to a minute), back to 1 s after a hello.
// - A token Slack refuses, or an app with Socket Mode switched off, is said once in the log and tried again every ten minutes (not hammered).
// - A computer that slept leaves a connection that looks open and is dead: a clock that jumps (a tick that comes far later than it should)
//   opens a new one.
//
// The token is never written to the log. What comes in is other people's words: src/slack.ts treats it as information, never instructions.

import { createLog } from "./log.ts";

const logSlack = createLog("slack");

const OPEN_URL = "https://slack.com/api/apps.connections.open";
/** Errors from apps.connections.open that waiting a few seconds will not fix: the token or the app's settings must change. */
const LASTING = new Set(["invalid_auth", "not_authed", "not_allowed_token_type", "account_inactive", "token_revoked", "missing_scope", "app_not_found"]);

/** The part of the WebSocket this needs (Node 22's global one has it all). */
export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  readonly readyState: number;
  send(data: string): void;
  close(): void;
}

export interface SlackSocketDeps {
  /** The app-level token (xapp-...). */
  appToken: string;
  /** Each events_api payload, after it was acknowledged (src/slack.ts receive: the same handler as the events address). */
  receive: (payload: unknown) => void;
  fetch?: typeof fetch;
  /** Makes the WebSocket (Node's own without it). */
  connect?: (url: string) => SocketLike;
  now?: () => number;
  /** The first wait after a failure, doubled each time up to `maxBackoffMs` (1 s and 60 s; the tests use a few ms). */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** The wait after a refused token or Socket Mode switched off (10 minutes). */
  lastingMs?: number;
  /** How long a new connection may take to say hello (30 s). */
  helloMs?: number;
  /** How often the clock is looked at for a sleep (30 s); a tick later than three times this means the computer slept. */
  tickMs?: number;
  log?: (line: string) => void;
  /**
   * The watchdog (src/watchdog.ts, the slackEvents part): a refused token or Socket Mode switched off is a failed round each time it is tried
   * (every ten minutes), a hello a good one. A dropped connection that comes back is not reported: the next hello says it works.
   */
  health?: (ok: boolean, detail?: string) => void;
}

export interface SlackSocket {
  start(): void;
  stop(): void;
  /** For the log and the tests: whether a connection said hello and is open, and how many envelopes were acknowledged. */
  state(): { connected: boolean; acked: number; opens: number };
  /** Why Slack refuses this connection for good (a revoked token, Socket Mode switched off), or null: for the watchdog's half-hourly look. */
  problem(): string | null;
}

const OPEN = 1;

export function createSlackSocket(d: SlackSocketDeps): SlackSocket {
  const f = d.fetch ?? fetch;
  const now = d.now ?? Date.now;
  const log = d.log ?? ((line: string) => console.log(line));
  const make = d.connect ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
  const base = d.backoffMs ?? 1000;
  const max = d.maxBackoffMs ?? 60_000;
  const tickMs = d.tickMs ?? 30_000;

  let running = false;
  let ws: SocketLike | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let helloTimer: ReturnType<typeof setTimeout> | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let lastTick = 0;
  let failures = 0;
  let connected = false;
  let saidOn = false;
  let saidLasting = "";
  /** Slack said Socket Mode is switched off for this app (link_disabled): until the next hello. */
  let switchedOff = false;
  let acked = 0;
  let opens = 0;
  /** Each attempt's number: what an older connection or request does after a newer one began is ignored. */
  let generation = 0;

  const drop = (): void => {
    connected = false;
    if (helloTimer) clearTimeout(helloTimer);
    helloTimer = null;
    const old = ws;
    ws = null;
    if (old) {
      old.onopen = old.onmessage = old.onerror = null;
      old.onclose = null;
      try {
        old.close();
      } catch {
        /* already closed */
      }
    }
  };

  const schedule = (ms: number): void => {
    if (!running) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void open();
    }, ms);
    timer.unref?.();
  };
  const retry = (): void => {
    const wait = Math.min(max, base * 2 ** Math.min(failures, 16));
    failures++;
    schedule(wait);
  };

  const open = async (): Promise<void> => {
    if (!running) return;
    if (timer) clearTimeout(timer);
    timer = null;
    drop();
    const mine = ++generation;
    let url = "";
    try {
      const r = await f(OPEN_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${d.appToken}`, "content-type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout(10_000),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: unknown; url?: unknown; error?: unknown };
      if (mine !== generation || !running) return;
      if (j.ok !== true || typeof j.url !== "string" || !/^wss:\/\//.test(j.url)) {
        const why = typeof j.error === "string" ? j.error : `HTTP ${r.status}`;
        if (LASTING.has(why)) {
          // Said once until it changes: every ten minutes the same line would fill the log.
          if (saidLasting !== why) log(`[slack] Socket Mode refused (${why}): check SLACK_APP_TOKEN (an App-Level Token with connections:write); trying again in 10 min`);
          saidLasting = why;
          d.health?.(false, `Socket Mode: ${why}`);
          schedule(d.lastingMs ?? 10 * 60_000);
          return;
        }
        throw new Error(why);
      }
      url = j.url;
    } catch (err) {
      if (mine !== generation || !running) return;
      logSlack.error(`Socket Mode could not open a connection: ${(err as Error).message}`);
      retry();
      return;
    }
    saidLasting = "";
    let sock: SocketLike;
    try {
      sock = make(url);
    } catch (err) {
      logSlack.error(`Socket Mode: ${(err as Error).message}`);
      retry();
      return;
    }
    ws = sock;
    opens++;
    // A connection that never says hello is as good as none.
    helloTimer = setTimeout(() => {
      if (ws !== sock || connected) return;
      logSlack.error("Socket Mode: no hello from Slack; opening another connection");
      drop();
      retry();
    }, d.helloMs ?? 30_000);
    helloTimer.unref?.();
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      let m: { type?: unknown; envelope_id?: unknown; payload?: unknown; reason?: unknown };
      try {
        m = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString("utf8")) as typeof m;
      } catch {
        return;
      }
      if (!m || typeof m !== "object") return;
      // Acknowledged first, before anything is looked at: Slack sends an envelope again when it hears nothing within three seconds.
      if (typeof m.envelope_id === "string" && m.envelope_id) {
        if (sock.readyState === OPEN) {
          sock.send(JSON.stringify({ envelope_id: m.envelope_id }));
          acked++;
        }
        if (m.type === "events_api") d.receive(m.payload);
        return;
      }
      if (m.type === "hello") {
        connected = true;
        failures = 0;
        if (helloTimer) clearTimeout(helloTimer);
        helloTimer = null;
        if (!saidOn) log("[slack] Socket Mode connected: Slack's events come to this Pako directly");
        saidOn = true;
        switchedOff = false;
        d.health?.(true);
        return;
      }
      if (m.type === "disconnect") {
        if (m.reason === "link_disabled") {
          log("[slack] Socket Mode is switched off in the Slack app (Settings, Socket Mode): trying again in 10 min");
          switchedOff = true;
          d.health?.(false, "Socket Mode: link_disabled");
          drop();
          schedule(d.lastingMs ?? 10 * 60_000);
          return;
        }
        // refresh_requested, warning: Slack moves this connection; a new one now (events in between are sent again, unacknowledged).
        void open();
      }
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      connected = false;
      if (helloTimer) clearTimeout(helloTimer);
      helloTimer = null;
      retry();
    };
    sock.onerror = () => {
      // A close follows an error: the wait is set there.
    };
  };

  return {
    start: () => {
      if (running) return;
      running = true;
      failures = 0;
      lastTick = now();
      ticker = setInterval(() => {
        const t = now();
        const slept = t - lastTick > 3 * tickMs;
        lastTick = t;
        if (slept && running) {
          log("[slack] the computer slept: opening a new Socket Mode connection");
          failures = 0;
          void open();
        }
      }, tickMs);
      ticker.unref?.();
      void open();
    },
    stop: () => {
      running = false;
      generation++;
      if (timer) clearTimeout(timer);
      timer = null;
      if (ticker) clearInterval(ticker);
      ticker = null;
      drop();
    },
    state: () => ({ connected, acked, opens }),
    problem: () => (saidLasting ? saidLasting : switchedOff ? "link_disabled" : null),
  };
}
