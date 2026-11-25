// The owner's Slack (their work workspace), read only, through a Slack app the owner installs with a user token that only has read scopes.
//
// - How messages come, three ways into the same handler:
//   - POST /slack/events, signed with the app's signing secret (a server with a public address).
//   - Socket Mode (src/slack-socket.ts, SLACK_APP_TOKEN): Pako opens the connection itself, so a computer at home gets them live.
//   - With the user token alone (what connecting from the panel gives, src/connect-setup.ts): Pako looks every minute
//     (src/slack-poll.ts). The token that only Slack's app page can make (xapp-) is then not needed at all.
//   A direct
//   message, a group DM or a channel message that mentions the owner becomes a WhatsApp ("💬 Slack · Ana (private): ..."), several from one
//   conversation within a few seconds in one message. Outside the owner's quiet hours only: what comes at night waits for the morning.
//   Only with SLACK_FORWARD=on: by default the message is kept (SLACK, the context, the brief) and not copied, since Slack already notifies.
// - On request: the assistant can search the workspace (`search.messages`), and SLACK on WhatsApp lists the last day's alerts.
//
// It cannot write anything: the token has no write scope. Slack text is other people's words: information for the owner, never instructions.

import { createHmac, timingSafeEqual } from "node:crypto";
import { quietAt, quietSetting } from "./day-time.ts";
import express, { type Express, type Request, type Response } from "express";
import type { Control } from "./control.ts";
import { locale, texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import type { HealthReport } from "./watchdog.ts";
import { createSlackGate } from "./slack-gate.ts";
import { createSlackPoll } from "./slack-poll.ts";
import { createSlackSocket, type SlackSocketDeps } from "./slack-socket.ts";
import { createLog } from "./log.ts";
import { readJsonRecord } from "./json-record.ts";

const logSlack = createLog("slack");

type Env = Record<string, string | undefined>;

/**
 * What the owner reads about their Slack (the alerts, the night's batch, the morning brief, the log) and the lines the assistant gets. Who
 * wrote and where is written when the message comes, and kept that way.
 */
const T = texts(
  {
    channel: "#channel",
    group: "@group",
    someone: "someone",
    aChannel: "a channel",
    dm: "{who} (private)",
    groupDm: "{who} (private group)",
    inChannel: "{who} in {channel}",
    ownGroupDm: "your private group",
    ownInChannel: "you in {channel}",
    private: "private",
    privateGroup: "private group",
    noText: "(a file, or a message with no text)",
    log: "Slack from {where}",
    night: "This came in on Slack while you were off ({n}):",
    brief: "💬 Slack (24 h): {n} message(s) for you. Type SLACK to see them.",
  },
);

export interface SlackConfig {
  token: string;
  /** The app's Signing Secret, for the events address; "" when the events come by Socket Mode only. */
  signingSecret: string;
  /** The app-level token (xapp-) that opens Socket Mode; "" without it (the events address only). */
  appToken?: string;
  /** Minutes of the day [start, end) when alerts wait (start > end crosses midnight); null = never. */
  quiet: { start: number; end: number } | null;
  /** Whether each message is also sent to the owner (SLACK_FORWARD=on). Off by default: Slack already notifies the owner, so a copy from
   * Pako is noise; the messages are still kept for SLACK, the assistant's context and the morning brief. */
  forward: boolean;
}

const API = "https://slack.com/api";
const ALERTS_KEY = "slack-alerts";
const QUIET_KEY = "slack-held";
/** The owner's own messages, kept for the morning brief only (both sides of a conversation): { since, list }. */
const OWN_KEY = "slack-own";
const ALERTS_KEEP = 100;
const BATCH_MS = 15_000;
const TEXT_MAX = 600;

/** The user scopes the app asks for: reading only. Kept here so the manifest in the docs and the code agree. */
export const SLACK_USER_SCOPES = [
  "channels:history", "channels:read", "groups:history", "groups:read", "im:history", "im:read", "mpim:history", "mpim:read", "users:read", "search:read",
];

/**
 * Off (null) unless the user token is set. The signing secret (the events address) and the app-level token (Socket Mode) are optional
 * ways for messages to come live; with neither, Pako looks for them itself every minute. A wrong value is reported and keeps it off.
 */
export function loadSlackConfig(env: Env): { config: SlackConfig | null; problems: string[] } {
  const token = (env.SLACK_USER_TOKEN ?? "").trim();
  const signingSecret = (env.SLACK_SIGNING_SECRET ?? "").trim();
  const appToken = (env.SLACK_APP_TOKEN ?? "").trim();
  if (!token && !signingSecret && !appToken) return { config: null, problems: [] };
  const problems: string[] = [];
  if (!/^xoxp-[A-Za-z0-9-]{20,}$/.test(token)) problems.push("SLACK_USER_TOKEN must be the app's User OAuth Token (it starts with xoxp-)");
  if (appToken && !/^xapp-[A-Za-z0-9-]{20,}$/.test(appToken)) problems.push("SLACK_APP_TOKEN must be the app's App-Level Token (it starts with xapp-)");
  if (signingSecret && !/^[a-f0-9]{32}$/i.test(signingSecret)) problems.push("SLACK_SIGNING_SECRET must be the app's Signing Secret (32 letters and digits)");
  // A mistyped quiet-hours value is said and 23:00-08:00 used; it no longer turns Slack off (it kept Slack off before).
  const q = quietSetting(env.SLACK_QUIET_HOURS, "SLACK_QUIET_HOURS");
  const quiet: SlackConfig["quiet"] = q.quiet;
  const rawForward = (env.SLACK_FORWARD ?? "off").trim().toLowerCase();
  if (rawForward !== "on" && rawForward !== "off") problems.push("SLACK_FORWARD must be on or off");
  const forward = rawForward === "on";
  const notes = q.problem ? [q.problem] : [];
  return problems.length
    ? { config: null, problems: [...problems, ...notes] }
    : { config: { token, signingSecret, ...(appToken ? { appToken } : {}), quiet, forward }, problems: notes };
}

/** Slack's request signature: v0=HMAC-SHA256(secret, "v0:" + timestamp + ":" + body), within five minutes. */
export function verifySlack(secret: string, timestamp: string | undefined, signature: string | undefined, body: Buffer, nowMs: number): boolean {
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp) || !signature.startsWith("v0=")) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > 300) return false;
  const expected = Buffer.from(`v0=${createHmac("sha256", secret).update(`v0:${timestamp}:`).update(body).digest("hex")}`);
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function inQuiet(quiet: SlackConfig["quiet"], at: number, timeZone: string): boolean {
  return quietAt(quiet, at, timeZone);
}

/** Slack's markup made readable: mentions and channels by name, links as "label (url)", entities decoded. */
export function plainSlack(text: string, names: (id: string) => string, l: Lang = "en"): string {
  return text
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, "") // invisible characters that reorder or hide text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (_m, id: string, label?: string) => `@${label || names(id)}`)
    .replace(/<#[CG][A-Z0-9]+\|([^>]*)>/g, (_m, name: string) => `#${name}`)
    .replace(/<#[CG][A-Z0-9]+>/g, () => T(l)("channel"))
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_m, label?: string) => label || T(l)("group"))
    .replace(/<!date\^[^|>]*(?:\|([^>]*))?>/g, (_m, fallback?: string) => fallback || "")
    .replace(/<!(here|channel|everyone)[^>]*>/g, (_m, w: string) => `@${w}`)
    .replace(/<mailto:([^|>]+)(?:\|([^>]+))?>/g, (_m, addr: string, label?: string) => label || addr)
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, (_m, url: string, label: string) => `${label} (${url})`)
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export interface SlackAlert {
  at: number;
  /** Who wrote and where: "Ana (private)", "Ana in #project". */
  where: string;
  text: string;
  /** Kept since the rehearsal (src/rehearsal.ts) reads a conversation again: its channel, the message's ts, its thread, who wrote. */
  channel?: string;
  ts?: string;
  thread?: string;
  who?: string;
  direct?: boolean;
  /** The owner's own message (kept under OWN_KEY, never among the alerts): the brief reads both sides of a conversation. */
  mine?: true;
}

export interface SlackEvent {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  /** Set on a message in a thread: the thread's parent ts. */
  thread_ts?: string;
  /** The files shared with the message (a file_share). */
  files?: unknown[];
}

export interface SlackDeps {
  config: SlackConfig;
  kv: Kv | null;
  timeZone: string;
  /** Tells the owner (src/whatsapp.ts notifyOwner: kept for later when WhatsApp's 24-hour window is closed). */
  notify: (text: string) => Promise<unknown>;
  control?: Control;
  fetch?: typeof fetch;
  now?: () => number;
  /** How long messages of one conversation are gathered before the WhatsApp (default 15 s; the tests use a few ms). */
  batchMs?: number;
  /** Wait before retrying an event that failed (default 3 s, then 6 s; the tests use a few milliseconds). */
  retryMs?: number;
  /** The language of what it writes (src/i18n.ts), asked each time; always English now, kept as a function so callers need not change. */
  lang?: () => Lang;
  /** Socket Mode's timings and WebSocket, for the tests (src/slack-socket.ts); the real ones without it. */
  socket?: Omit<SlackSocketDeps, "appToken" | "receive" | "fetch">;
  /** Each message kept for the owner, as it comes (src/followups.ts gathers a conversation's for its extraction). */
  /** `user`: the author's Slack id, for the people's identities (src/people-graph.ts); a newer field, ignored by those that do not need it. */
  observe?: (m: { channel: string; ts: string; at: number; who: string; where: string; direct: boolean; text: string; user?: string; mine?: boolean; thread?: string }) => void;
  /**
   * The watchdog (src/watchdog.ts): how each call to Slack's API went. Slack brings its news by itself, so `check` (auth.test, which the
   * watchdog runs every half hour) is what finds a revoked token on a quiet day.
   */
  health?: HealthReport;
  /**
   * Socket Mode's own part (the watchdog's slackEvents): its token is another one (SLACK_APP_TOKEN), so its refusals and hellos never open
   * or close the Web API's incident, nor the other way round.
   */
  eventsHealth?: HealthReport;
  /**
   * How many DMs one look may read (src/slack-poll.ts, 15 by default). The project's own Slack app, while not listed in the Slack
   * Marketplace, is a "commercially distributed" app to Slack and gets 1 conversations.history call a minute: 1 then.
   */
  pollPerRound?: number;
  /**
   * Conversation reads a minute Slack allows this token (src/slack-gate.ts): 1 for the project's own app before it is listed; none for an
   * app made by the workspace (only Slack's own Retry-After is kept).
   */
  historyPerMinute?: number;
  /** The gate's wait, for the tests. */
  historySleep?: (ms: number) => Promise<void>;
}

/** Without the app's secret the events address can only answer Slack's one-time check, so the app can be created before Render has its values. */
export function mountSlackCheckOnly(app: Express) {
  app.post("/slack/events", express.json({ limit: "64kb" }), (req, res) => {
    const b = (req.body ?? {}) as { type?: unknown; challenge?: unknown };
    if (b.type === "url_verification" && typeof b.challenge === "string") res.json({ challenge: b.challenge.slice(0, 200) });
    else res.status(503).type("text").send("Slack is not set up on this server yet");
  });
}

export function mountSlack(app: Express, d: SlackDeps) {
  const { config } = d;
  const f = d.fetch ?? fetch;
  const now = d.now ?? Date.now;
  const lang = d.lang ?? ((): Lang => "en");

  // One gate for this token's conversation reads: the poll's and the follow-ups' (history below) share Slack's budget and its waits.
  const gate = createSlackGate({ now, ...(d.historyPerMinute ? { perMinute: d.historyPerMinute } : {}), ...(d.historySleep ? { sleep: d.historySleep } : {}) });
  const READS = new Set(["conversations.history", "conversations.replies"]);
  const api = async (method: string, params: Record<string, string>): Promise<Record<string, unknown>> => {
    let r: globalThis.Response;
    try {
      r = await f(`${API}/${method}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(8_000) });
    } catch (err) {
      d.health?.(false, `Slack ${method}: no answer`);
      throw err;
    }
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok || j.ok !== true) {
      const why = typeof j.error === "string" ? j.error : r.status === 429 ? "ratelimited" : `HTTP ${r.status}`;
      // Slack busy: it answered, and asks to wait (Retry-After, in seconds). Neither a failure nor a round that went through.
      if (why === "ratelimited") {
        if (READS.has(method)) gate.limited(Number(r.headers.get("retry-after")) * 1000);
        throw new Error(`Slack ${method}: ratelimited`);
      }
      // A message or a channel this token may not read is that one's; anything else (the token, Slack itself) is Slack failing.
      if (!/^(channel_not_found|not_in_channel|thread_not_found|message_not_found|user_not_found|missing_scope)$/.test(why)) {
        d.health?.(false, `Slack ${method}: ${why}`);
      }
      throw new Error(`Slack ${method}: ${why}`);
    }
    d.health?.(true);
    return j;
  };

  let me: string | null = null;
  /** The workspace and the signed-in user as auth.test names them: shown on the panel's row (never the token). */
  let who: { workspace: string; user: string } | null = null;
  /** When the last message for the owner came (a direct message or a mention), for the panel's row. */
  let lastSeen: number | null = null;
  const whoAmI = async (): Promise<string | null> => {
    if (me) return me;
    try {
      const j = await api("auth.test", {});
      me = typeof j.user_id === "string" ? j.user_id : null;
      who = { workspace: typeof j.team === "string" ? j.team.slice(0, 100) : "", user: typeof j.user === "string" ? j.user.slice(0, 100) : "" };
    } catch (err) {
      logSlack.error(`auth.test failed: ${(err as Error).message}`);
    }
    return me;
  };
  const people = new Map<string, string>();
  // A channel's name, or "" when Slack gives none: the stand-in for that is written in the language of each message, so it is not kept.
  const channels = new Map<string, string>();
  const nameOf = async (id: string): Promise<string> => {
    if (people.has(id)) return people.get(id)!;
    try {
      const u = (await api("users.info", { user: id })).user as { real_name?: string; profile?: { display_name?: string; real_name?: string } } | undefined;
      const name = u?.profile?.display_name || u?.real_name || u?.profile?.real_name || id;
      people.set(id, name);
      return name;
    } catch {
      /* Slack did not answer: the id stands in */
      return id;
    }
  };
  const channelOf = async (id: string, l: Lang): Promise<string> => {
    if (channels.has(id)) return channels.get(id) || T(l)("aChannel");
    try {
      const c = (await api("conversations.info", { channel: id })).channel as { name?: string } | undefined;
      const name = c?.name ? `#${c.name}` : "";
      channels.set(id, name);
      return name || T(l)("aChannel");
    } catch {
      /* Slack did not answer: a channel */
      return T(l)("aChannel");
    }
  };

  let storeChain: Promise<unknown> = Promise.resolve();
  const store = (alerts: SlackAlert[]): Promise<void> => {
    const run = storeChain.then(() => storeNow(alerts));
    storeChain = run.catch(() => undefined);
    return run;
  };
  const storeNow = async (alerts: SlackAlert[]): Promise<void> => {
    if (!d.kv) return;
    try {
      const raw = await readJsonRecord(d.kv, ALERTS_KEY);
      const old = raw ? (raw as SlackAlert[]) : [];
      await d.kv.set(ALERTS_KEY, JSON.stringify([...(Array.isArray(old) ? old : []), ...alerts].slice(-ALERTS_KEEP)), 14 * 24 * 3600);
    } catch (err) {
      logSlack.error(`could not keep the alerts: ${(err as Error).message}`);
    }
  };
  const memoryAlerts: SlackAlert[] = [];
  const allAlerts = async (): Promise<SlackAlert[]> => {
    if (!d.kv) return memoryAlerts;
    try {
      const raw = await readJsonRecord(d.kv, ALERTS_KEY);
      const p = raw ? (raw as unknown) : [];
      return (Array.isArray(p) ? p : []).filter((a): a is SlackAlert => !!a && typeof a.at === "number" && typeof a.text === "string");
    } catch {
      /* not JSON, or the store did not answer: the memory copy */
      return memoryAlerts;
    }
  };

  const render = (list: SlackAlert[]): string => {
    const byWhere = new Map<string, string[]>();
    for (const a of list) byWhere.set(a.where, [...(byWhere.get(a.where) ?? []), a.text]);
    return [...byWhere].map(([where, texts]) => `💬 Slack · ${where}:\n${texts.map((t) => (texts.length > 1 ? `• ${t}` : t)).join("\n")}`).join("\n\n");
  };

  // Several messages of one conversation in a few seconds become one WhatsApp; at night they wait for the morning.
  const pending: SlackAlert[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = async (): Promise<void> => {
    timer = null;
    const batch = pending.splice(0);
    if (!batch.length || !config.forward) return;
    if (inQuiet(config.quiet, now(), d.timeZone)) {
      try {
        const raw = d.kv ? await readJsonRecord(d.kv, QUIET_KEY) : null;
        const held = raw ? (raw as SlackAlert[]) : quietHeld;
        quietHeld = [...(Array.isArray(held) ? held : []), ...batch].slice(-ALERTS_KEEP);
        if (d.kv) await d.kv.set(QUIET_KEY, JSON.stringify(quietHeld), 2 * 24 * 3600);
      } catch (err) {
        quietHeld = [...quietHeld, ...batch].slice(-ALERTS_KEEP);
        logSlack.error(`could not keep the night's alerts: ${(err as Error).message}`);
      }
      return;
    }
    await d.notify(render(batch));
  };
  let quietHeld: SlackAlert[] = [];
  /** After the quiet hours: what came in the night, in one message. */
  const morning = async (): Promise<number> => {
    if (!config.forward || inQuiet(config.quiet, now(), d.timeZone)) return 0;
    let held = quietHeld;
    try {
      const raw = d.kv ? await readJsonRecord(d.kv, QUIET_KEY) : null;
      if (raw) held = raw as SlackAlert[];
    } catch {
      /* the memory copy */
    }
    if (!Array.isArray(held) || !held.length) return 0;
    // Cleared BEFORE telling: a store that cannot be cleared would make every minute tell the same night again.
    if (d.kv) {
      try {
        await d.kv.set(QUIET_KEY, "[]", 60);
      } catch (err) {
        logSlack.error(`could not clear the night's messages (not told yet): ${(err as Error).message}`);
        return 0;
      }
    }
    quietHeld = [];
    await d.notify(`${T(lang())("night", { n: held.length })}\n\n${render(held)}`);
    return held.length;
  };
  setInterval(() => void morning().catch((err) => logSlack.error(`morning: ${(err as Error).message}`)), 60_000).unref?.();

  /**
   * The owner's own message, in any conversation (a DM, a group DM, a channel): kept for a week, the last ALERTS_KEEP, for the morning brief,
   * which reads both sides of a conversation ("You told Ana you'd call", "nothing from you there since"). Never told, never an alert.
   */
  const keepOwn = async (e: SlackEvent): Promise<void> => {
    if (!d.kv || !e.ts || !e.channel) return;
    const l = lang();
    const t = T(l);
    const text = plainSlack(e.text ?? "", (id) => people.get(id) ?? t("someone"), l).slice(0, TEXT_MAX);
    if (!text.trim()) return;
    const where = e.channel_type === "im" ? t("dm", { who: await partnerOf(e.channel) })
      : e.channel_type === "mpim" ? t("privateGroup") : await channelOf(e.channel, l);
    const own: SlackAlert = { at: Number(e.ts) * 1000 || now(), where, text, channel: e.channel, ts: e.ts, mine: true };
    const run = storeChain.then(async () => {
      try {
        const raw = (await readJsonRecord(d.kv!, OWN_KEY)) as { since?: unknown; list?: unknown } | null;
        const list = Array.isArray(raw?.list) ? (raw.list as SlackAlert[]) : [];
        const since = typeof raw?.since === "number" ? raw.since : own.at;
        await d.kv!.set(OWN_KEY, JSON.stringify({ since, list: [...list, own].slice(-ALERTS_KEEP) }), 8 * 24 * 3600);
      } catch (err) {
        logSlack.error(`could not keep the owner's message: ${(err as Error).message}`);
      }
    });
    storeChain = run;
    await run;
  };
  /**
   * The owner's own message: never told back to them, but read for what they promise ("I'll send it by Friday"), in a DM, a group DM, a
   * thread, or a channel message that names someone. The follow-ups batch it with its conversation, so one run reads both sides.
   */
  const observeOwn = async (e: SlackEvent): Promise<void> => {
    if (!d.observe || !e.ts || !e.channel || !e.user) return;
    const raw = e.text ?? "";
    const direct = e.channel_type === "im" || e.channel_type === "mpim";
    const inThread = !!e.thread_ts && e.thread_ts !== e.ts;
    if (!direct && !inThread && !/<@[UW][A-Z0-9]+>/.test(raw)) return;
    const l = lang();
    const t = T(l);
    for (const id of [...new Set([...raw.matchAll(/<@([UW][A-Z0-9]+)>/g)].map((m) => m[1]!))].slice(0, 10)) await nameOf(id);
    const text = plainSlack(raw, (id) => people.get(id) ?? t("someone"), l).slice(0, TEXT_MAX);
    if (!text.trim()) return;
    const where = e.channel_type === "im" ? t("dm", { who: await partnerOf(e.channel) })
      : e.channel_type === "mpim" ? t("ownGroupDm") : t("ownInChannel", { channel: await channelOf(e.channel, l) });
    const thread = inThread && /^\d{1,12}(?:\.\d{1,8})?$/.test(e.thread_ts!) ? { thread: e.thread_ts! } : {};
    d.observe({ channel: e.channel, ts: e.ts, at: Number(e.ts) * 1000 || now(), who: await nameOf(e.user), where, direct, text, user: e.user, mine: true, ...thread });
  };
  /** Whom a direct conversation is with (Slack's conversations.info names the other person), by name; "someone" when Slack does not say. */
  const partners = new Map<string, string>();
  const partnerOf = async (channel: string): Promise<string> => {
    if (partners.has(channel)) return partners.get(channel)!;
    try {
      const c = (await api("conversations.info", { channel })).channel as { user?: string } | undefined;
      const name = c?.user ? await nameOf(c.user) : T(lang())("someone");
      partners.set(channel, name);
      return name;
    } catch {
      /* Slack did not answer: someone */
      return T(lang())("someone");
    }
  };

  const seen = new Set<string>();
  const handle = async (e: SlackEvent): Promise<void> => {
    if (e.type !== "message" || (e.subtype && e.subtype !== "thread_broadcast" && e.subtype !== "file_share") || e.bot_id || !e.user || !e.channel) return;
    const self = await whoAmI();
    if (!self) throw new Error("could not tell whose Slack this is (auth.test failed)");
    if (e.user === self) {
      await keepOwn(e);
      await observeOwn(e);
      return;
    }
    const raw = e.text ?? "";
    const direct = e.channel_type === "im" || e.channel_type === "mpim";
    if (!direct && !raw.includes(`<@${self}>`)) return;
    lastSeen = Date.now();
    const author = await nameOf(e.user);
    const l = lang();
    const t = T(l);
    const where =
      e.channel_type === "im" ? t("dm", { who: author }) : e.channel_type === "mpim" ? t("groupDm", { who: author }) : t("inChannel", { who: author, channel: await channelOf(e.channel, l) });
    // At most ten names are looked up for one message: a text holding hundreds of mentions must not hold the notice back for hundreds of calls.
    for (const id of [...new Set([...raw.matchAll(/<@([UW][A-Z0-9]+)>/g)].map((m) => m[1]!))].slice(0, 10)) await nameOf(id);
    const text = plainSlack(raw, (id) => people.get(id) ?? t("someone"), l).slice(0, TEXT_MAX) || t("noText");
    // A message in a thread (not the parent itself) belongs to that thread: its context and its checks are read there.
    const thread = e.thread_ts && e.thread_ts !== e.ts && /^\d{1,12}(?:\.\d{1,8})?$/.test(e.thread_ts) ? { thread: e.thread_ts } : {};
    const alert: SlackAlert = {
      at: Number(e.ts) * 1000 || now(), where, text, channel: e.channel, ...(e.ts ? { ts: e.ts } : {}), ...thread, who: author, direct,
    };
    memoryAlerts.push(alert);
    if (memoryAlerts.length > ALERTS_KEEP) memoryAlerts.shift();
    await store([alert]);
    d.control?.log("slack", t("log", { where }));
    if (d.observe && e.ts) d.observe({ channel: e.channel, ts: e.ts, at: alert.at, who: author, where, direct, text, user: e.user, ...thread });
    pending.push(alert);
    timer ??= setTimeout(() => void flush().catch((err) => logSlack.error(`could not tell the owner: ${(err as Error).message}`)), d.batchMs ?? BATCH_MS);
  };

  /**
   * One delivery of Slack's Events API, whichever way it came (the signed events address, or Socket Mode once acknowledged): looked at once
   * per event id, so an event that comes both ways, or again after a reconnection, is handled once.
   */
  const receive = (raw: unknown): void => {
    const payload = (raw ?? {}) as { type?: unknown; event_id?: unknown; event?: SlackEvent };
    if (payload.type !== "event_callback" || !payload.event || typeof payload.event !== "object" || typeof payload.event_id !== "string") return;
    if (seen.has(payload.event_id)) return;
    seen.add(payload.event_id);
    if (seen.size > 1000) seen.delete(seen.values().next().value!);
    // Slack has its answer already and will not send it again: a failure here (Slack's own API down for a moment) is retried a few times by us.
    const event = payload.event;
    void (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await handle(event);
          return;
        } catch (err) {
          logSlack.error(`an event failed (try ${attempt + 1}): ${(err as Error).message}`);
          if (attempt >= 2) return;
          await new Promise((r) => setTimeout(r, d.retryMs ?? 3000 * (attempt + 1)));
        }
      }
    })();
  };

  if (config.signingSecret) {
    app.post("/slack/events", express.raw({ type: "*/*", limit: "1mb" }), (req: Request, res: Response) => {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!verifySlack(config.signingSecret, req.get("x-slack-request-timestamp"), req.get("x-slack-signature"), body, now())) {
        res.status(401).type("text").send("Bad signature");
        return;
      }
      let payload: { type?: unknown; challenge?: unknown };
      try {
        payload = JSON.parse(body.toString("utf8")) as typeof payload;
      } catch {
        /* not JSON: refused */
        res.status(400).type("text").send("Not JSON");
        return;
      }
      if (payload.type === "url_verification" && typeof payload.challenge === "string") {
        res.json({ challenge: payload.challenge.slice(0, 200) });
        return;
      }
      // Slack wants an answer within three seconds and retries otherwise: answer first, then look at the message.
      res.json({ ok: true });
      receive(payload);
    });
  } else {
    // Socket Mode only: there is no secret to check a request with, so nothing that comes to this address is taken.
    app.post("/slack/events", (_req, res) => {
      res.status(404).type("text").send("Slack's events come by Socket Mode to this Pako");
    });
  }

  // Socket Mode (src/slack-socket.ts): built here, opened by the server once it listens (src/server.ts), so an app only built opens nothing.
  const socket = config.appToken
    ? createSlackSocket({ appToken: config.appToken, receive, fetch: f, ...(d.eventsHealth ? { health: d.eventsHealth } : {}), ...(d.socket ?? {}) })
    : null;
  // The poll's reads never wait: a call the gate does not give now is Slack's limit to it, and that conversation is read first next round.
  const pollApi = async (method: string, params: Record<string, string>): Promise<Record<string, unknown>> => {
    if (READS.has(method) && !gate.poll()) throw new Error(`Slack ${method}: ratelimited (waiting for the next free call)`);
    return api(method, params);
  };
  // Neither live way set up (what connecting from the panel gives): Pako looks for new messages itself (src/slack-poll.ts), started by the
  // app like Zoom's listing. A message that fails is logged and the round goes on with the next one.
  const poll = !config.appToken && !config.signingSecret
    ? createSlackPoll({ api: pollApi, self: whoAmI, deliver: (e) => handle(e), kv: d.kv, now, ...(d.pollPerRound ? { perRound: d.pollPerRound } : {}) })
    : null;

  const when = (at: number, l: Lang = lang()) =>
    new Intl.DateTimeFormat(locale(l), { timeZone: d.timeZone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(at);
  return {
    /** The panel's row: whose Slack this is, and when a message for the owner last came. Asks auth.test once when not known yet. */
    identity: async (): Promise<{ workspace: string; user: string; lastSeen: number | null }> => {
      if (!who) await whoAmI();
      return { workspace: who?.workspace ?? "", user: who?.user ?? "", lastSeen };
    },
    /** Slack's own search (its syntax: words, from:@name, in:#channel, after:YYYY-MM-DD), newest first, one line each. */
    search: async (query: string): Promise<string[]> => {
      const j = await api("search.messages", { query: query.slice(0, 200), count: "20", sort: "timestamp", sort_dir: "desc" });
      type Match = { ts?: string; text?: string; user?: string; username?: string; channel?: { name?: string; is_im?: boolean; is_mpim?: boolean } };
      const matches = ((j.messages as { matches?: Match[] } | undefined)?.matches ?? []).slice(0, 20);
      const l = lang();
      const t = T(l);
      const out: string[] = [];
      for (const m of matches) {
        if (m.user) await nameOf(m.user);
        const who = (m.user && people.get(m.user)) || m.username || t("someone");
        const where = m.channel?.is_im ? t("private") : m.channel?.is_mpim ? t("privateGroup") : m.channel?.name ? `#${m.channel.name}` : "";
        const text = plainSlack(m.text ?? "", (id) => people.get(id) ?? t("someone"), l).slice(0, 300);
        out.push(`${m.ts ? when(Number(m.ts) * 1000, l) : ""} ${where ? `${where} · ` : ""}${who}: ${text}`.trim());
      }
      return out;
    },
    /**
     * A conversation's latest messages, oldest first, the owner's own marked `mine` (src/followups.ts: the context of an extraction, and its
     * checks: a reply or a Zoom link posted after the ask). `oldest`: only messages after that ts. `thread`: that thread's messages instead
     * (conversations.replies: a channel's history holds no thread replies). Throws when Slack cannot be read.
     */
    history: async (
      channel: string, o: { limit?: number; oldest?: string; thread?: string } = {},
    ): Promise<{ ts: string; at: number; mine: boolean; who: string; text: string; file?: boolean }[]> => {
      const self = await whoAmI();
      const limit = Math.min(100, Math.max(1, o.limit ?? 15));
      const q = { channel, limit: String(o.thread ? 100 : limit), ...(o.oldest ? { oldest: o.oldest } : {}), ...(o.thread ? { ts: o.thread } : {}) };
      // Its turn at the gate, before the poll's: a check that cannot read Slack would remind the owner of what they may have done.
      if (!(await gate.check())) throw new Error("Slack is busy: ratelimited for longer than a read waits");
      const j = await api(o.thread ? "conversations.replies" : "conversations.history", q);
      const l = lang();
      const t = T(l);
      const out: { ts: string; at: number; mine: boolean; who: string; text: string; file?: boolean }[] = [];
      for (const m of ((j.messages as SlackEvent[] | undefined) ?? []).slice(0, 100)) {
        if (!m.ts || (m.subtype && m.subtype !== "thread_broadcast" && m.subtype !== "file_share")) continue;
        const mine = !!self && m.user === self;
        const who = mine ? "" : m.user ? await nameOf(m.user) : t("someone");
        // A file or a link (Slack writes a link as <https://...>): what a document sent there is seen by.
        const file = (Array.isArray(m.files) && m.files.length > 0) || /<https?:\/\//.test(m.text ?? "");
        out.push({ ts: m.ts, at: Number(m.ts) * 1000, mine, who, text: plainSlack(m.text ?? "", (id) => people.get(id) ?? t("someone"), l).slice(0, TEXT_MAX), ...(file ? { file } : {}) });
      }
      out.sort((a, b) => a.at - b.at);
      // A thread comes oldest first: its parent (who asked what, for when) and its latest replies.
      return o.thread && !o.oldest && limit > 1 && out.length > limit ? [out[0]!, ...out.slice(1 - limit)] : out;
    },
    /** The alerts of the last week, newest first, as data (the owner's panel). */
    alerts: async (): Promise<SlackAlert[]> => {
      const t = now();
      return (await allAlerts()).filter((a) => t - a.at < 7 * 24 * 3600_000).reverse();
    },
    /**
     * For the morning brief: the last week's alerts and the owner's own messages, newest first (own ones `mine`), and since when the owner's
     * own are kept (null: none yet): before that moment "nothing from you since" cannot be said.
     */
    conversations: async (): Promise<{ list: SlackAlert[]; ownSince: number | null }> => {
      const t = now();
      let own: SlackAlert[] = [];
      let ownSince: number | null = null;
      try {
        const raw = d.kv ? ((await readJsonRecord(d.kv, OWN_KEY)) as { since?: unknown; list?: unknown } | null) : null;
        if (Array.isArray(raw?.list)) own = (raw.list as SlackAlert[]).filter((a) => !!a && typeof a.at === "number" && typeof a.text === "string");
        if (typeof raw?.since === "number") ownSince = raw.since;
      } catch {
        /* not JSON, or the store did not answer: the alerts alone, and nothing said about replies */
      }
      const list = [...(await allAlerts()), ...own.map((a): SlackAlert => ({ ...a, mine: true }))].filter((a) => t - a.at < 7 * 24 * 3600_000);
      return { list: list.sort((a, b) => b.at - a.at), ownSince };
    },
    /** The alerts of the last 24 hours, for the owner's SLACK command and the assistant's context. */
    recent: async (): Promise<string[]> => {
      const t = now();
      const l = lang();
      return (await allAlerts()).filter((a) => t - a.at < 24 * 3600_000).map((a) => `${when(a.at, l)} ${a.where}: ${a.text}`);
    },
    /** The morning brief's line about the last day of Slack; null when nothing came. */
    brief: async (): Promise<string | null> => {
      const t = now();
      const n = (await allAlerts()).filter((a) => t - a.at < 24 * 3600_000).length;
      return n ? T(lang())("brief", { n }) : null;
    },
    morning,
    flush,
    /**
     * One look at both tokens, for the watchdog's half-hourly check: Socket Mode refused for good is a failed round of Slack's events
     * (a quiet day has no other), and auth.test says how the user token is (Slack's part). True when both are fine.
     */
    check: async (): Promise<boolean> => {
      const refused = socket?.problem() ?? null;
      if (refused) d.eventsHealth?.(false, `Socket Mode: ${refused}`);
      try {
        await api("auth.test", {});
        return !refused;
      } catch {
        /* Slack did not answer: not working */
        return false;
      }
    },
    /** Socket Mode's connection, when SLACK_APP_TOKEN is set: started and stopped by the server; null otherwise. */
    socket,
    /** The look every minute, when neither live way is set up: started by the app (src/app.ts); null otherwise. */
    poll,
    /** One delivery of the Events API, as the events address hands it on after its checks (the tests use it as Socket Mode does). */
    receive,
    /** Who this Slack is ("Connected as … in …" on the panel): auth.test and the owner's name. Null when Slack cannot be asked. */
    account: async (): Promise<{ user: string; team: string } | null> => {
      try {
        const j = await api("auth.test", {});
        const id = typeof j.user_id === "string" ? j.user_id : "";
        const name = id ? await nameOf(id) : "";
        return { user: (name && name !== id ? name : typeof j.user === "string" ? j.user : "").slice(0, 100), team: (typeof j.team === "string" ? j.team : "").slice(0, 100) };
      } catch {
        /* Slack did not answer: unknown */
        return null;
      }
    },
  };
}

export type SlackReader = ReturnType<typeof mountSlack>;
