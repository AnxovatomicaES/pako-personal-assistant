// The watchdog: Pako must never go quiet without the owner knowing why.
//
// Every moving part says how its last round went (report): the store's writes, WhatsApp's and Telegram's sends, each look at Slack, Zoom, the
// calendar and the mail. Two parts are looked at instead (tick, every minute): when the assistant's computer last asked for messages (a server
// on the internet only), and how Claude is doing there. When a part has been failing for longer than its threshold (the computer: 15 minutes
// without asking; Claude: 15 minutes signed out or missing; a connection: 3 failed rounds over 5 minutes at least; the store: any failed
// write), the owner is told ONCE for that incident, on the chat that still works (Telegram when it is paired, else WhatsApp, else the panel's
// chat on a computer), with what failed, since when, and the one thing to do. When it works again, one line says so.
//
// The quiet hours (WATCHDOG_QUIET_HOURS, by default SLACK_QUIET_HOURS, else 23:00-08:00) hold a notice until they end, unless the incident is
// one that silences Pako altogether: the computer gone, or the store failing. A notice held for the night is not sent if the part is back by
// the morning. The incidents are kept in the store (best effort), so a restart neither repeats one nor forgets to say it is over.
//
// It also compares the assistant computer's version (it says it on POST /assistant/health, assistant/update.ts) with this server's, and says
// once when that computer has been more than a day behind. The panel's Health card (src/panel/health.js) shows every part's state.

import { execFileSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import express, { type Express, type Request, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { locale, ownerClock, texts, type Lang } from "./i18n.ts";
import type { Control } from "./control.ts";
import type { Kv } from "./kv.ts";
import { inQuiet } from "./slack.ts";
import { createLog } from "./log.ts";
import { readJsonRecord } from "./json-record.ts";

const logWatchdog = createLog("watchdog");

type Env = Record<string, string | undefined>;

/** What a part says about one round of its work: true when it went through, false with a short reason when it did not. */
export type HealthReport = (ok: boolean, detail?: string) => void;

// slack: Slack's Web API with the user token (searches, the half-hourly auth.test); slackEvents: Slack's events by Socket Mode (SLACK_APP_TOKEN).
// Two tokens, two parts: a working search must never close an incident of a refused Socket Mode, nor a hello one of a revoked user token.
export type PartKey =
  | "bridge" | "claude" | "store" | "whatsapp" | "telegram" | "calendar" | "mail" | "imap" | "slack" | "slackEvents" | "zoom" | "teams" | "update";
const ORDER: PartKey[] = ["bridge", "claude", "store", "whatsapp", "telegram", "calendar", "mail", "imap", "slack", "slackEvents", "zoom", "teams", "update"];
/** Told whatever the hour: without these Pako cannot answer at all, or forgets what it is told. */
const URGENT = new Set<PartKey>(["bridge", "store"]);
/** Parts whose failure is counted in rounds. */
const ROUNDS = 3;
/**
 * The store: two failed writes at least a minute apart with none good between (a write that fails once and then works is a blip of the
 * network), or a last write that failed with nothing good for ten minutes after it (seen by the minute's look).
 */
const STORE_ROUNDS = 2;
const STORE_MIN_MS = 60_000;
const STORE_SILENT_MS = 10 * 60_000;
/**
 * A part that fails again soon after its recovery was said (within six hours) is a flapping one: the new incident shows on the panel at
 * once but is said only if it lasts (30 minutes; 10 for the urgent parts). One that ends before that is never said, nor its recovery.
 */
const REPEAT_MS = 6 * 3600_000;
const REPEAT_WAIT_MS = 30 * 60_000;
const REPEAT_WAIT_URGENT_MS = 10 * 60_000;
/** And for that long at least: a connection that fails three times in a minute and then works is a blip, not an incident. */
const CONNECTOR_MIN_MS = 5 * 60_000;
const BRIDGE_DOWN_MS = 15 * 60_000;
const CLAUDE_DOWN_MS = 15 * 60_000;
const BEHIND_MS = 24 * 3600_000;
const KEY = "watchdog";

export interface WatchdogConfig {
  on: boolean;
  quiet: { start: number; end: number } | null;
}

const hhmm = (s: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
};

/** WATCHDOG (on unless off) and its quiet hours: WATCHDOG_QUIET_HOURS, else SLACK_QUIET_HOURS, else 23:00-08:00 (off: none). */
export function loadWatchdogConfig(env: Env): { config: WatchdogConfig; problems: string[] } {
  const problems: string[] = [];
  const raw = (env.WATCHDOG ?? "on").trim().toLowerCase() || "on";
  if (raw !== "on" && raw !== "off") problems.push("WATCHDOG must be on or off (on is used)");
  const rawQuiet = (env.WATCHDOG_QUIET_HOURS ?? env.SLACK_QUIET_HOURS ?? "23:00-08:00").trim().toLowerCase();
  let quiet: WatchdogConfig["quiet"] = { start: 23 * 60, end: 8 * 60 };
  if (rawQuiet === "off") quiet = null;
  else {
    const [a, b] = rawQuiet.split("-");
    const start = hhmm(a ?? "");
    const end = hhmm(b ?? "");
    if (start === null || end === null || start === end) problems.push("WATCHDOG_QUIET_HOURS must be like 23:00-08:00, or off (23:00-08:00 is used)");
    else quiet = { start, end };
  }
  return { config: { on: raw !== "off", quiet }, problems };
}

/** The version of a checkout: its commit and that commit's time (ms). */
export interface Version {
  sha: string;
  committedAt: number | null;
}

/**
 * The day's runs of Claude on the assistant's computer (assistant/budget.ts), as it says them on POST /assistant/health: the owner's own,
 * the background ones against their daily cap, and the background jobs it answered without a run.
 */
export interface BridgeUsage {
  day: string;
  interactive: number;
  background: number;
  perDay: number;
  skipped: { cap: number; paused: number; same: number };
  /** Background work waits for Claude's limit until this time (ms); 0 when it does not. */
  pausedUntil: number;
}

/** What the assistant's computer says about itself (POST /assistant/health). */
export interface BridgeVersion {
  sha: string;
  committedAt: number;
  /** When it last updated itself to this version (ms); absent when it never did. */
  updatedAt?: number;
  /** "on", "off", or why it did not update the last time it looked ("local changes", "on branch x"...). */
  autoupdate?: string;
}

/**
 * Which Claude Code the assistant's computer drives, and how it did in the bridge's self-test (assistant/bridge/cli-probe.ts). `note` is the
 * sentence the Health card shows when it is not plain "ok": "Claude Code X.Y: tested by probe", or, when it failed, what failed and the
 * command that goes back to the last version that passed. "newer" and "older": the self-test could not run (and from bridges before it).
 * "behind": it refused a model Pako asks for as too new for it, and Pako writes with another one until it is updated (the note says how).
 */
export const BRIDGE_CLI_STATUSES = ["ok", "probed", "failed", "newer", "older", "unknown", "behind"] as const;
export interface BridgeCli {
  version: string;
  status: (typeof BRIDGE_CLI_STATUSES)[number];
  note?: string;
}

/**
 * This server's own version: RENDER_GIT_COMMIT (set by Render), else the checkout it runs from (`git`, when there is one). The commit's time
 * comes from git only; without it the comparison counts how long the two versions have differed instead.
 */
export function readServerVersion(env: Env, root: string, run: (args: string[]) => string = gitIn(root)): Version | null {
  const given = (env.RENDER_GIT_COMMIT ?? "").trim().toLowerCase();
  let sha = /^[0-9a-f]{7,40}$/.test(given) ? given : "";
  let committedAt: number | null = null;
  try {
    const [head, at] = run(["log", "-1", "--format=%H %ct"]).trim().split(" ");
    if (/^[0-9a-f]{40}$/.test(head ?? "") && (!sha || head!.startsWith(sha) || sha.startsWith(head!))) {
      sha = head!;
      committedAt = Number(at) * 1000 || null;
    }
  } catch {
    /* no git here: the sha alone, when Render gave it */
  }
  return sha ? { sha, committedAt } : null;
}

const gitIn = (root: string) => (args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });

/** Whether the bridge's version is the server's (one sha may be the short form of the other). */
const sameSha = (a: string, b: string): boolean => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

/**
 * Whether the assistant's computer is more than a day behind this server: by the two commits' times when both are known, else by how long
 * the two have run different versions (`differentSince`).
 */
export function bridgeBehind(server: Version | null, bridge: BridgeVersion | null, differentSince: number | null, now: number): boolean {
  if (!server || !bridge || sameSha(server.sha, bridge.sha)) return false;
  if (server.committedAt !== null && bridge.committedAt > 0) return server.committedAt - bridge.committedAt > BEHIND_MS;
  return differentSince !== null && now - differentSince > BEHIND_MS;
}

const T = texts(
  {
    "name.bridge": "Your assistant's computer",
    "name.claude": "Claude",
    "name.store": "The data store",
    "name.whatsapp": "WhatsApp",
    "name.telegram": "Telegram",
    "name.calendar": "The calendar",
    "name.mail": "Pako's inbox (AgentMail)",
    "name.imap": "Your mailbox (IMAP)",
    "name.slack": "Slack",
    "name.slackEvents": "Slack's connection for new messages (Socket Mode)",
    "name.zoom": "Zoom",
    "name.teams": "Microsoft Teams",
    "name.update": "Your assistant computer's version",
    sinceToday: "since {time}",
    sinceDay: "since {day}, {time}",
    down: "⚠️ {what}, {since}.\nWhat to do: {todo}",
    back: "✅ {name} works again (it was failing {since}).",
    upToDate: "✅ Your assistant's computer is up to date again ({sha}).",
    "what.bridge": "Your assistant gets no messages: its computer has stopped asking me for them",
    "what.claude": "Claude does not answer on {where} ({detail})",
    "what.store": "I can't save anything ({detail}): what you tell me now may be lost",
    "what.part": "{name} is failing ({detail})",
    "what.update": "Your assistant's computer still runs an old version ({sha}, from {day}) and the server is more than a day ahead",
    "where.local": "this computer",
    "where.hosted": "your assistant's computer",
    "claude.login": "not signed in",
    "claude.missing": "the claude command is not installed",
    "claude.stopped": "the assistant does not start",
    "todo.bridge": "check that computer is on, awake and online, and that the assistant is still running "
      + "(tail -f ~/.pako-assistant/assistant.log, or ~/.ai-buyer-assistant/assistant.log if it was set up before Pako had its name).",
    "todo.claude.local": "in Pako's settings, press “Connect your Claude account”.",
    "todo.claude.hosted": "on that computer, open Terminal, type claude and sign in.",
    "todo.claude.missing": "install Claude Code (https://claude.com/claude-code) on {where} and type claude once to sign in.",
    "todo.store.local": "check the disk has free space and the ~/.pako folder can be written to.",
    "todo.store.hosted": "check the server's data store (VOICE_RESULTS_URL on Render): if it was deleted or expired, make a new one.",
    "todo.whatsapp": "check WHATSAPP_ACCESS_TOKEN in the server's settings: a token that is not permanent expires.",
    "todo.whatsapp.local": "open the WhatsApp card in the panel: Meta is not accepting the tunnel's address. I keep trying every ten minutes; "
      + "if it stays this way, turn the tunnel off and on again.",
    "todo.telegram": "write something to your bot on Telegram; if nothing changes, check its token {where}.",
    "todo.calendar": "check the calendar link or the Zoho connection {where}.",
    "todo.mail": "check the AgentMail key (AGENTMAIL_API_KEY) {where}.",
    "todo.imap": "check the mail user name and app password {where}.",
    "todo.slack": "check the Slack token (SLACK_USER_TOKEN) {where}: it may have been revoked.",
    "todo.slackSocket": "check the Socket Mode token (SLACK_APP_TOKEN) {where}, and that Socket Mode is still on in the Slack app.",
    "todo.zoom": "check the Zoom app (ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET) {where}.",
    "todo.teams": "connect Teams again from the panel's Teams card {where}: Microsoft may want you to sign in again.",
    "todo.update": "on that computer, in the Pako folder, type git pull and restart the assistant{why}.",
    "todo.updateWhy": " (it does not update itself: {why})",
    "where.panel": "in the panel's Connections card",
    "where.telegramPanel": "in the panel's Telegram card",
    "where.server": "in the server's settings",
    log: "Health: {name} is failing",
    logBack: "Health: {name} works again",
    "sum.ok": "✅ Working: {names}.",
    "sum.none": "✅ I see nothing failing. I have no connection to watch yet.",
    "sum.off": "The watchdog is off (WATCHDOG=off): I won't tell you if something stops working.",
    "sum.failing": "• {name} has been failing {since} ({detail}). If it goes on, I'll tell you.",
    "sum.waiting": "• {name}: nothing heard yet.",
    "sum.limit": "• Claude has reached its usage limit: it comes back by itself when that renews.",
    "sum.limitAt": "• Claude has reached its usage limit: it comes back by itself when that renews, around {time}. What needs it waits; nothing is lost.",
    "sum.quiet": "(It's your quiet hours now: what isn't urgent I'll tell you when they end.)",
  },
);

/** A part as the panel's Health card shows it. */
export interface PartState {
  key: PartKey;
  /** "ok"; "failing": failures, not yet an incident; "down": an incident (the owner was or will be told); "waiting": nothing heard yet; "warn". */
  status: "ok" | "failing" | "down" | "waiting" | "warn";
  /** The last time it worked (ms), or null. */
  okAt: number | null;
  /** Since when it fails (ms), or null. */
  failSince: number | null;
  detail: string;
}

export interface HealthState {
  on: boolean;
  quietNow: boolean;
  parts: PartState[];
  /** The assistant computer's version as it said it, and this server's; null when unknown. */
  bridge: (BridgeVersion & { behind: boolean }) | null;
  server: Version | null;
  /** Today's runs of Claude as the assistant's computer last said them; null before it says any (an older computer never does). */
  usage?: BridgeUsage | null;
  /** Which Claude Code the assistant's computer drives, and its self-test; null before it says (an older bridge never does). */
  cli?: BridgeCli | null;
}

export type ClaudeState = "ok" | "login" | "limit" | "missing" | "starting" | "stopped";

export interface WatchdogDeps {
  config: WatchdogConfig;
  /** On a computer (local mode): no bridge to watch (it runs beside the server), and the to-dos point at the panel. */
  local: boolean;
  timeZone: string;
  lang?: () => Lang;
  now?: () => number;
  /** Where the incidents are kept between starts (the raw store: never the watched one, whose failures this reports). Best effort. */
  kv?: Kv | null;
  /** How the owner is told, looked up when needed (the door is built after the watchdog). Null: nobody to tell (the panel still shows it). */
  notify: () => ((text: string) => Promise<unknown>) | null;
  /**
   * A server on the internet: when the assistant's computer last asked for messages (ms); null when there is no such computer (no chat set
   * up). Absent on a computer, where the bridge runs beside the server.
   */
  lastPoll?: () => number | null;
  /** On a computer: Claude's state as the bridge supervisor sees it. On a server it comes from the bridge's reports (bridgeReport). */
  claude?: () => ClaudeState | null;
  /** This server's own version, for the comparison with the assistant's computer (a server on the internet only; read once, when asked). */
  serverVersion?: () => Version | null;
  control?: Control;
  /** Checks that run every so often for parts with no rounds of their own (Slack: auth.test), each reporting by itself. */
  probes?: { everyMs: number; run: () => Promise<unknown> }[];
  log?: (line: string) => void;
}

interface Part {
  okAt: number | null;
  failSince: number | null;
  fails: number;
  detail: string;
}
/** An incident: since when, its detail, and whether the owner was told (false while the quiet hours hold it). */
interface Incident {
  since: number;
  told: boolean;
  /** A flapping part's (REPEAT_MS): not said before this time. */
  notBefore?: number;
}

export function createWatchdog(d: WatchdogDeps) {
  const now = d.now ?? Date.now;
  const lang = d.lang ?? ((): Lang => "en");
  const log = d.log ?? ((line: string) => logWatchdog.info(`${line}`));
  const parts = new Map<PartKey, Part>();
  const incidents = new Map<PartKey, Incident>();
  /** Recoveries of incidents the owner was told about, waiting for the quiet hours to end. */
  const recoveries: { key: PartKey; since: number; sha?: string }[] = [];
  /** When each part's recovery was last said: an incident soon after it waits before it is said (REPEAT_MS). */
  const saidBack = new Map<PartKey, number>();
  let claudeReported: { state: ClaudeState; at: number } | null = null;
  let claudeBadSince: number | null = null;
  let bridgeVersion: BridgeVersion | null = null;
  let bridgeUsage: BridgeUsage | null = null;
  let bridgeCli: BridgeCli | null = null;
  let differentSince: number | null = null;
  let loaded: Promise<void> | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const probeAt = new Map<number, number>();
  const probes = [...(d.probes ?? [])];

  /** Incidents kept from before a restart for parts this process has not met yet: they come back when the part does (and stay kept). */
  const dormant = new Map<PartKey, Incident>();
  const part = (key: PartKey): Part => {
    let p = parts.get(key);
    if (!p) {
      parts.set(key, (p = { okAt: null, failSince: null, fails: 0, detail: "" }));
      const was = dormant.get(key);
      if (was) {
        dormant.delete(key);
        incidents.set(key, was);
        p.failSince = was.since;
      }
    }
    return p;
  };
  const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);

  // ---------- kept between starts ----------

  const load = (): Promise<void> =>
    (loaded ??= (async () => {
      try {
        const raw = d.kv ? await readJsonRecord(d.kv, KEY) : null;
        const p = raw ? (raw as Record<string, { since?: unknown; told?: unknown }>) : {};
        for (const [k, v] of Object.entries(p)) {
          const key = k as PartKey;
          if (!ORDER.includes(key) || typeof v?.since !== "number" || incidents.has(key)) continue;
          const inc = { since: v.since, told: v.told === true };
          // A part this process has (it was watched or reported already) takes it now; another one when it first shows up.
          if (!parts.has(key)) {
            dormant.set(key, inc);
            continue;
          }
          incidents.set(key, inc);
          const was = part(key);
          was.failSince ??= v.since;
        }
      } catch {
        /* nothing kept, or the store does not answer: the incidents start from here */
      }
    })());
  const save = (): void => {
    if (!d.kv) return;
    const out: Record<string, Incident> = {};
    for (const [k, v] of [...dormant, ...incidents]) out[k] = v;
    d.kv.set(KEY, JSON.stringify(out), 30 * 24 * 3600).catch(() => undefined);
  };

  // ---------- the words ----------

  const sinceText = (at: number, l: Lang): string => {
    const time = ownerClock(at, d.timeZone, l);
    const dayOf = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: d.timeZone }).format(t);
    if (dayOf(at) === dayOf(now())) return T(l)("sinceToday", { time });
    const day = new Intl.DateTimeFormat(locale(l), { timeZone: d.timeZone, day: "numeric", month: "short" }).format(at);
    return T(l)("sinceDay", { day, time });
  };
  const nameOf = (key: PartKey, l: Lang): string => T(l)(`name.${key}`);
  const downText = (key: PartKey, since: number): string => {
    const l = lang();
    const t = T(l);
    const p = part(key);
    const where = t(d.local ? (key === "telegram" ? "where.telegramPanel" : "where.panel") : "where.server");
    const detail = p.detail || "?";
    let what: string;
    let todo: string;
    if (key === "bridge") {
      what = t("what.bridge");
      todo = t("todo.bridge");
    } else if (key === "claude") {
      const state = p.detail === "login" || p.detail === "missing" || p.detail === "stopped" ? p.detail : "stopped";
      what = t("what.claude", { where: t(d.local ? "where.local" : "where.hosted"), detail: t(`claude.${state}`) });
      const machine = t(d.local ? "where.local" : "where.hosted");
      // On a computer the connections page's one button installs Claude Code and signs in: no terminal.
      todo = state === "missing" && !d.local ? t("todo.claude.missing", { where: machine }) : t(d.local ? "todo.claude.local" : "todo.claude.hosted");
    } else if (key === "store") {
      what = t("what.store", { detail });
      todo = t(d.local ? "todo.store.local" : "todo.store.hosted");
    } else if (key === "update") {
      const v = bridgeVersion;
      const day = v ? new Intl.DateTimeFormat(locale(l), { timeZone: d.timeZone, day: "numeric", month: "long" }).format(v.committedAt) : "?";
      what = t("what.update", { sha: (v?.sha ?? "?").slice(0, 7), day });
      const why = v?.autoupdate && v.autoupdate !== "on" ? t("todo.updateWhy", { why: v.autoupdate }) : "";
      todo = t("todo.update", { why });
    } else {
      what = t("what.part", { name: nameOf(key, l), detail });
      // Slack's events by Socket Mode (src/slack-socket.ts) have their own token.
      // On a computer, WhatsApp's part is its webhook with Meta (src/whatsapp-computer.ts): the panel's card, not a server's token.
      todo = key === "slackEvents" ? t("todo.slackSocket", { where }) : key === "whatsapp" && d.local ? t("todo.whatsapp.local") : t(`todo.${key}`, { where });
    }
    return t("down", { what, since: sinceText(since, l), todo });
  };
  const backText = (key: PartKey, since: number, sha?: string): string => {
    const l = lang();
    if (key === "update") return T(l)("upToDate", { sha: (sha ?? "").slice(0, 7) });
    return T(l)("back", { name: nameOf(key, l), since: sinceText(since, l) });
  };

  // ---------- telling ----------

  const quietNow = (): boolean => inQuiet(d.config.quiet, now(), d.timeZone);
  /** One thing said at a time, in order: an incident and its recovery never cross. */
  const serial = (fn: () => Promise<void>): Promise<void> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const say = async (text: string): Promise<boolean> => {
    const tell = d.notify();
    if (!tell) return false;
    try {
      await tell(text);
      return true;
    } catch (err) {
      log(`could not tell the owner: ${(err as Error).message}`);
      return false;
    }
  };
  /** Says what is due: new incidents (outside the quiet hours unless urgent), then recoveries of told ones. */
  const flush = (): Promise<void> =>
    serial(async () => {
      // Only a server that listens tells anyone (server.ts starts it): an app that is only built, as in most tests, keeps count silently.
      if (!d.config.on || !started) return;
      await load();
      const quiet = quietNow();
      for (const key of ORDER) {
        const inc = incidents.get(key);
        if (!inc || inc.told || (quiet && !URGENT.has(key)) || (inc.notBefore ?? 0) > now()) continue;
        inc.told = true; // claimed first: a failure while it is being said (the store, say) must not say it twice
        save();
        if (!(await say(downText(key, inc.since)))) {
          inc.told = false;
          save();
          continue;
        }
        log(`told the owner: ${key} is failing since ${new Date(inc.since).toISOString()}`);
      }
      if (quiet) return;
      while (recoveries.length) {
        const r = recoveries[0]!;
        if (incidents.has(r.key)) {
          recoveries.shift(); // failing again: the open incident stands for it
          continue;
        }
        if (!(await say(backText(r.key, r.since, r.sha)))) return;
        recoveries.shift();
        saidBack.set(r.key, now());
        log(`told the owner: ${r.key} works again`);
      }
    });

  const open = (key: PartKey, since: number): void => {
    if (incidents.has(key)) return;
    const back = saidBack.get(key);
    const flapping = back !== undefined && now() - back < REPEAT_MS;
    const wait = URGENT.has(key) ? REPEAT_WAIT_URGENT_MS : REPEAT_WAIT_MS;
    incidents.set(key, { since, told: false, ...(flapping ? { notBefore: now() + wait } : {}) });
    save();
    d.control?.log("health", T(lang())("log", { name: nameOf(key, lang()) }));
    log(`${key} is failing since ${new Date(since).toISOString()}: ${part(key).detail || "no detail"}`);
    void flush();
  };
  const close = (key: PartKey, sha?: string): void => {
    const inc = incidents.get(key);
    if (!inc) return;
    incidents.delete(key);
    save();
    d.control?.log("health", T(lang())("logBack", { name: nameOf(key, lang()) }));
    log(`${key} works again`);
    // Never said (it was held for the night): nothing to take back either.
    if (inc.told) {
      recoveries.push({ key, since: inc.since, ...(sha ? { sha } : {}) });
      void flush();
    }
  };

  // ---------- what the parts say ----------

  /** One round of a part: true when it went through; false, with why, when it did not. Never throws. */
  const report = (key: PartKey, ok: boolean, detail = ""): void => {
    try {
      const p = part(key);
      const t = now();
      if (ok) {
        p.okAt = t;
        p.fails = 0;
        p.failSince = null;
        p.detail = "";
        void load().then(() => close(key));
        return;
      }
      p.fails++;
      p.failSince ??= t;
      p.detail = clean(detail) || p.detail;
      const due = key === "store" ? p.fails >= STORE_ROUNDS && t - p.failSince >= STORE_MIN_MS : p.fails >= ROUNDS && t - p.failSince >= CONNECTOR_MIN_MS;
      if (due) void load().then(() => open(key, p.failSince ?? t));
    } catch (err) {
      log(`a report was lost: ${(err as Error).message}`);
    }
  };
  /** A part that is set up, before its first round: the card shows it as waiting rather than not at all. */
  const watch = (key: PartKey): void => void part(key);

  /** What the assistant's computer said: how Claude is doing, its version, and the day's runs of Claude. */
  const bridgeReport = (r: { claude?: "ok" | "login" | "limit"; version?: BridgeVersion; usage?: BridgeUsage; cli?: BridgeCli }): void => {
    const t = now();
    if (r.usage) bridgeUsage = r.usage;
    if (r.cli) {
      if (r.cli.note && r.cli.note !== bridgeCli?.note) log(`the assistant's computer: ${r.cli.note}`);
      bridgeCli = r.cli;
    }
    if (!r.claude && !r.version) return; // numbers only: nothing to look at again
    if (r.claude) claudeReported = { state: r.claude, at: t };
    if (r.version) {
      const changed = !bridgeVersion || bridgeVersion.sha !== r.version.sha;
      bridgeVersion = r.version;
      if (changed) differentSince = null;
    }
    void tick();
  };

  // ---------- what is looked at ----------

  /** The computer, Claude, the version and the probes: every minute (server.ts starts it), and after each report from the computer. */
  const tick = async (): Promise<void> => {
    if (!d.config.on) return;
    await load();
    const t = now();
    // The assistant's computer (a server on the internet): its last request for messages.
    const last = d.lastPoll?.() ?? null;
    if (last !== null) {
      const p = part("bridge");
      if (last > 0 && t - last <= BRIDGE_DOWN_MS) {
        p.okAt = last;
        p.failSince = null;
        p.detail = "";
        // Back only once it really asks again (a request in the last two minutes), not merely under the threshold.
        if (t - last < 2 * 60_000) close("bridge");
      } else {
        p.failSince = last > 0 ? last : t;
        p.detail = "no poll";
        open("bridge", p.failSince);
      }
    }
    // Claude: on a computer as the supervisor sees it; on a server as the computer last said (only while that computer is there).
    const bridgeUp = last === null || t - last <= BRIDGE_DOWN_MS;
    const state: ClaudeState | null = d.claude ? d.claude() : bridgeUp && claudeReported ? claudeReported.state : null;
    if (state !== null) {
      const p = part("claude");
      const bad = state === "login" || state === "missing" || state === "stopped";
      if (bad) {
        claudeBadSince ??= t;
        p.failSince = claudeBadSince;
        p.detail = state;
        // On a computer a lost sign-in is the Claude keeper's one notice, with its Sign in again button (src/claude-connect.ts): not a second one.
        if (t - claudeBadSince >= CLAUDE_DOWN_MS && !(d.local && state === "login")) open("claude", claudeBadSince);
      } else {
        claudeBadSince = null;
        p.failSince = null;
        p.detail = state === "ok" ? "" : state;
        if (state === "ok") p.okAt = t;
        // Out of its limit is not an outage of the setup (the bridge already says when it comes back): a login that became a limit is mended.
        if (state === "ok" || state === "limit") close("claude");
      }
    }
    // The version of the assistant's computer against this server's.
    const server = d.serverVersion?.() ?? null;
    if (server && bridgeVersion) {
      const p = part("update");
      if (sameSha(server.sha, bridgeVersion.sha)) differentSince = null;
      else differentSince ??= t;
      const behind = bridgeBehind(server, bridgeVersion, differentSince, t);
      p.detail = bridgeVersion.sha.slice(0, 7);
      if (behind) {
        p.failSince ??= t;
        open("update", p.failSince);
      } else {
        p.okAt = t;
        p.failSince = null;
        if (incidents.has("update")) close("update", bridgeVersion.sha);
      }
    }
    // The store's last write failed and nothing good came for a while: an incident, however few writes there were (STORE_SILENT_MS).
    const store = parts.get("store");
    if (store?.failSince != null && store.fails > 0 && t - store.failSince >= STORE_SILENT_MS) open("store", store.failSince);
    for (const [i, probe] of probes.entries()) {
      if (t - (probeAt.get(i) ?? 0) < probe.everyMs) continue;
      probeAt.set(i, t);
      void probe.run().catch(() => undefined);
    }
    // What the quiet hours held, now that they may be over.
    await flush();
  };

  const state = (): HealthState => {
    const t = now();
    const out: PartState[] = [];
    for (const key of ORDER) {
      const p = parts.get(key);
      if (!p) continue;
      const down = incidents.has(key);
      const warn = key === "claude" && p.detail === "limit";
      const status: PartState["status"] = down ? "down" : p.failSince !== null ? "failing" : warn ? "warn" : p.okAt !== null ? "ok" : "waiting";
      out.push({ key, status, okAt: p.okAt, failSince: down ? incidents.get(key)!.since : p.failSince, detail: p.detail });
    }
    const server = d.serverVersion?.() ?? null;
    const behind = bridgeVersion ? bridgeBehind(server, bridgeVersion, differentSince, t) : false;
    return {
      on: d.config.on,
      quietNow: quietNow(),
      parts: out,
      bridge: bridgeVersion ? { ...bridgeVersion, behind } : null,
      server,
      usage: bridgeUsage,
      cli: bridgeCli,
    };
  };

  /** HEALTH on the chat, or "how is Pako doing?": what is down and what to do (the notice's own words), what fails for now, what works. */
  const summary = (): string => {
    const l = lang();
    const t = T(l);
    if (!d.config.on) return t("sum.off");
    const proper = new Set<PartKey>(["claude", "whatsapp", "telegram", "slack", "zoom", "teams"]);
    const listName = (key: PartKey): string => {
      const n = nameOf(key, l);
      return proper.has(key) ? n : n.charAt(0).toLowerCase() + n.slice(1);
    };
    const st = state();
    const lines: string[] = [];
    for (const p of st.parts.filter((x) => x.status === "down")) lines.push(downText(p.key, p.failSince ?? now()));
    for (const p of st.parts.filter((x) => x.status === "failing")) {
      lines.push(t("sum.failing", { name: nameOf(p.key, l), since: sinceText(p.failSince ?? now(), l), detail: p.detail || "?" }));
    }
    if (st.parts.some((x) => x.status === "warn")) {
      // The reset the assistant's computer last said with its numbers (assistant/budget.ts pausedUntil), when it is still ahead.
      const until = st.usage?.pausedUntil ?? 0;
      lines.push(until > now() ? t("sum.limitAt", { time: ownerClock(until, d.timeZone, l) }) : t("sum.limit"));
    }
    for (const p of st.parts.filter((x) => x.status === "waiting" && x.key !== "update")) lines.push(t("sum.waiting", { name: nameOf(p.key, l) }));
    const ok = st.parts.filter((x) => x.status === "ok" && x.key !== "update").map((x) => listName(x.key));
    if (ok.length) lines.push(t("sum.ok", { names: ok.join(", ") }));
    // A Claude Code that failed the bridge's self-test: its own sentence, with the command that goes back (assistant/bridge/cli-probe.ts).
    // One too old for a model Pako asks for: its sentence, with the update that fixes it (assistant/bridge/runs.ts).
    if ((st.cli?.status === "failed" || st.cli?.status === "behind") && st.cli.note) lines.unshift(st.cli.note);
    if (!lines.length) lines.push(t("sum.none"));
    if (st.quietNow && st.parts.some((x) => x.status === "down")) lines.push(t("sum.quiet"));
    return lines.join("\n");
  };

  let timer: NodeJS.Timeout | null = null;
  let started = false;
  return {
    summary,
    report,
    /** A reporter bound to one part, for a module's deps. */
    reporter: (key: PartKey): HealthReport => (ok, detail) => report(key, ok, detail),
    watch,
    /** A check for a part with no rounds of its own, run every `everyMs` from the next look on (Slack's auth.test). */
    probe: (everyMs: number, run: () => Promise<unknown>): void => void probes.push({ everyMs, run }),
    bridgeReport,
    tick,
    state,
    /** Every minute, once the server listens (server.ts); an app that is only built (tests) keeps no timer. */
    start: (): void => {
      if (timer || !d.config.on) return;
      started = true;
      if ((d.lastPoll?.() ?? null) !== null) watch("bridge");
      timer = setInterval(() => void tick().catch((err: Error) => log(`a look failed: ${err.message}`)), 60_000);
      timer.unref?.();
    },
    stop: (): void => {
      if (timer) clearInterval(timer);
      timer = null;
      started = false;
    },
    /** For the tests: everything said so far has been said. */
    settled: (): Promise<unknown> => chain,
  };
}

export type Watchdog = ReturnType<typeof createWatchdog>;

/** Wraps the store so each write says whether it went through (a server's store: a write that fails throws). */
export function reportingKv(kv: Kv, report: HealthReport): Kv {
  return {
    get: (key) => kv.get(key),
    set: async (key, value, ttl) => {
      try {
        await kv.set(key, value, ttl);
      } catch (err) {
        report(false, (err as Error).message);
        throw err;
      }
      report(true);
    },
    ...(kv.add
      ? {
          add: async (key: string, value: string, ttl: number) => {
            try {
              const ok = await kv.add!(key, value, ttl);
              report(true);
              return ok;
            } catch (err) {
              report(false, (err as Error).message);
              throw err;
            }
          },
        }
      : {}),
  };
}

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" };

/** What the assistant's computer may say on POST /assistant/health; null when the body says neither thing well. */
export function readBridgeReport(
  body: unknown,
): { claude?: "ok" | "login" | "limit"; version?: BridgeVersion; usage?: BridgeUsage; cli?: BridgeCli } | null {
  const b = (body ?? {}) as { claude?: unknown; version?: unknown; usage?: unknown; cli?: unknown };
  const out: { claude?: "ok" | "login" | "limit"; version?: BridgeVersion; usage?: BridgeUsage; cli?: BridgeCli } = {};
  if (b.cli !== undefined) {
    const c = (b.cli ?? {}) as { version?: unknown; status?: unknown; note?: unknown };
    const status = BRIDGE_CLI_STATUSES.find((x) => x === c.status);
    if (!status || typeof c.version !== "string" || !/^(\d+\.\d+\.\d+)?$/.test(c.version)) return null;
    // The sentence is the bridge's own, shown as text on the card: plain characters only (and the @ of the npm command that fixes it).
    const note = typeof c.note === "string" ? c.note.replace(/[^\p{L}\p{N} .,:;/_()'@"-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 400) : "";
    out.cli = { version: c.version, status, ...(note && status !== "ok" ? { note } : {}) };
  }
  if (b.usage !== undefined) {
    const u = (b.usage ?? {}) as Record<string, unknown>;
    const n = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1e13 ? v : null);
    const sk = (u.skipped ?? {}) as Record<string, unknown>;
    const nums = [n(u.interactive), n(u.background), n(u.perDay), n(sk.cap), n(sk.paused), n(sk.same), n(u.pausedUntil)];
    if (typeof u.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(u.day) || nums.some((x) => x === null)) return null;
    const [interactive, background, perDay, cap, paused, same, pausedUntil] = nums as number[];
    out.usage = { day: u.day, interactive: interactive!, background: background!, perDay: perDay!, skipped: { cap: cap!, paused: paused!, same: same! }, pausedUntil: pausedUntil! };
  }
  if (b.claude !== undefined) {
    if (b.claude !== "ok" && b.claude !== "login" && b.claude !== "limit") return null;
    out.claude = b.claude;
  }
  if (b.version !== undefined) {
    const v = (b.version ?? {}) as { sha?: unknown; committedAt?: unknown; updatedAt?: unknown; autoupdate?: unknown };
    if (typeof v.sha !== "string" || !/^[0-9a-f]{7,40}$/.test(v.sha) || typeof v.committedAt !== "number" || !Number.isFinite(v.committedAt)) return null;
    out.version = {
      sha: v.sha,
      committedAt: v.committedAt,
      ...(typeof v.updatedAt === "number" && Number.isFinite(v.updatedAt) ? { updatedAt: v.updatedAt } : {}),
      ...(typeof v.autoupdate === "string" ? { autoupdate: v.autoupdate.replace(/[^\p{L}\p{N} .,:;/_()'-]+/gu, " ").trim().slice(0, 80) } : {}),
    };
  }
  return out.claude || out.version || out.usage || out.cli ? out : null;
}

/**
 * A server on the internet: POST /assistant/health, where the assistant's computer says how Claude is doing and which version it runs (on a
 * computer the panel's own route takes it, from this computer only: src/dashboard.ts). The bridge token's; only a refused token counts.
 */
export function mountBridgeHealth(app: Express, d: { token: string; watchdog: Pick<Watchdog, "bridgeReport"> }): void {
  const hash = (s: string) => createHash("sha256").update(s).digest();
  const limiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 30,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) => res.statusCode !== 401,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  const auth: RequestHandler = (req, res, next) => {
    res.set(HEADERS);
    const m = /^Bearer (.+)$/.exec(req.get("authorization") ?? "");
    if (!m || !timingSafeEqual(hash(m[1]!), hash(d.token))) {
      res.status(401).json({ error: "wrong token" });
      return;
    }
    next();
  };
  app.post("/assistant/health", limiter, auth, express.json({ limit: "2kb" }), (req, res) => {
    const r = readBridgeReport(req.body);
    if (!r) {
      res.status(400).json({ error: "send claude (ok, login or limit) and/or version {sha, committedAt}" });
      return;
    }
    d.watchdog.bridgeReport(r);
    res.json({ ok: true });
  });
}

/** The panel's Health card (src/panel/health.js): every part's state, read only, the panel's session. */
export function mountHealthPanel(app: Express, d: { signedIn: (req: Request) => boolean; state: () => HealthState }): void {
  app.get("/panel/api/health", (req, res) => {
    res.set(HEADERS);
    if (!d.signedIn(req)) {
      res.status(401).json({ error: "sign in" });
      return;
    }
    res.json(d.state());
  });
}
