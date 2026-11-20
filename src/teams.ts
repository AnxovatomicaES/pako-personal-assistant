// The owner's Microsoft Teams, read only, through Microsoft Graph with the owner's own sign-in (src/teams-connect.ts keeps it).
//
// Chats and meetings are where promises are made, so Teams feeds the same follow-ups engine as Slack:
// - Direct and group chats (and meeting chats): every new message to or from the owner goes to the engine as a message of that conversation
//   (src/followups/jobs.ts observeSlack). The owner's own messages count too: they carry the owner's promises ("I'll send it Friday") and
//   close what they answer.
// - Channel messages that @mention the owner, only when the owner's admin granted ChannelMessage.Read.All.
// - Meetings: the Teams meetings on the calendar are "it happened" signals for the checks (src/followups/checks.ts reads them as calendar
//   events). When the admin granted transcripts, a finished meeting's transcript goes to the engine like a Zoom summary (decisions and who
//   owes what become loops).
//
// How it reads, and why it polls: Microsoft's change notifications need a public HTTPS address, which a laptop does not have, and the delta
// API for all of a user's chats is for apps acting without a user (application permissions). So every few minutes Pako asks for the chats
// sorted by their last message (one call), and reads only the chats with something new, each with a date filter (the form Microsoft's
// polling rules ask for). Where it stands in each chat is kept in the store (TEAMS_KEY), so a restart continues where it left off.
//
// The engine knows conversations by a Slack-shaped id: each Teams conversation gets a stable one of its own ("GTEAMS" and 20 hex digits,
// never a real Slack id), and its message times are written as Slack writes them (seconds.milliseconds). So the batches, the checks of the
// owner's later replies and the labels work unchanged, and `history` answers for a Teams id what Slack's answers for a Slack one.
//
// Teams text is other people's words: information for the owner, never instructions. It is cut, stripped of markup and invisible
// characters here, and fenced by the engine (src/quarantine.ts) like Slack's. Nothing is ever sent: the sign-in has no write permission.
// No token ever goes to a log or to the panel.

import { createHash } from "node:crypto";
import type { Kv } from "./kv.ts";
import type { HealthReport } from "./watchdog.ts";
import { createLog } from "./log.ts";
import { readJsonRecord } from "./json-record.ts";

const log = createLog("teams");

type Env = Record<string, string | undefined>;

export const TEAMS_KEY = "teams-poll";
export const GRAPH_API = "https://graph.microsoft.com/v1.0";
export const MS_LOGIN = "https://login.microsoftonline.com";
/** The tenant every personal Microsoft account signs in from: Teams personal has no Graph API for chats. */
export const CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
const G = "https://graph.microsoft.com/";

/**
 * What "Connect Teams" asks for: only what an employee may grant alone (where their company lets them). The chats, the calendar's Teams
 * meetings, and who they are.
 */
export const TEAMS_SCOPES = ["User.Read", "Chat.Read", "Calendars.Read"];
/** What only the owner's admin can grant, by what it adds. Asked with "Add what my admin approved", and named in the admin's request. */
export const TEAMS_ADMIN_SCOPES = {
  mentions: ["ChannelMessage.Read.All", "Team.ReadBasic.All", "Channel.ReadBasic.All"],
  transcripts: ["OnlineMeetings.Read", "OnlineMeetingTranscript.Read.All"],
} as const;
export const SIGN_IN_SCOPES = "offline_access openid email profile";
export const graphScopes = (names: readonly string[]): string => names.map((n) => `${G}${n}`).join(" ");

const TEXT_MAX = 600;
const PER_ROUND = 10;
const CHANNELS_PER_ROUND = 3;
const SEEN_KEEP = 60;
const IDS_KEEP = 400;
const KEEP_S = 60 * 24 * 3600;
const WAIT_MAX_MS = 30_000;
/** A group chat's members, once read, are kept this long; a failed read is asked again after MEMBERS_RETRY_MS, doubling up to the max. */
const MEMBERS_TTL_MS = 6 * 3600_000;
const MEMBERS_RETRY_MS = 2 * 60_000;
const MEMBERS_RETRY_MAX_MS = 3600_000;

export interface TeamsConfig {
  clientId: string;
  refreshToken: string;
  account: string;
  name: string;
  org: string;
  pollMinutes: number;
}

/** Off (null) unless the sign-in is kept (TEAMS_REFRESH_TOKEN, written by connecting Teams in the panel). A wrong value keeps it off. */
export function loadTeamsConfig(env: Env): { config: TeamsConfig | null; problems: string[] } {
  const refreshToken = (env.TEAMS_REFRESH_TOKEN ?? "").trim();
  if (!refreshToken) return { config: null, problems: [] };
  const problems: string[] = [];
  if (!/^[\w.~/+=*!-]{16,4000}$/.test(refreshToken)) problems.push("TEAMS_REFRESH_TOKEN must be the sign-in kept by connecting Teams in the panel");
  const clientId = (env.TEAMS_CLIENT_ID ?? "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) problems.push("TEAMS_CLIENT_ID must be the Microsoft app's Application (client) ID");
  const rawPoll = (env.TEAMS_POLL_MINUTES ?? "").trim();
  const pollMinutes = rawPoll ? Number(rawPoll) : 5;
  if (!Number.isInteger(pollMinutes) || pollMinutes < 2 || pollMinutes > 60) problems.push("TEAMS_POLL_MINUTES must be a whole number from 2 to 60");
  const text = (k: string, n: number) => (env[k] ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
  return problems.length
    ? { config: null, problems }
    : { config: { clientId, refreshToken, account: text("TEAMS_ACCOUNT", 320), name: text("TEAMS_NAME", 120), org: text("TEAMS_ORG", 160), pollMinutes }, problems };
}

// ---------- the conversation ids the engine knows ----------

/** A Teams conversation's id for the engine: Slack-shaped (src/followups/record.ts CHANNEL), never a real Slack id. */
export const teamsChannel = (key: string): string => `GTEAMS${createHash("sha256").update(key).digest("hex").slice(0, 20).toUpperCase()}`;
export const isTeamsChannel = (ch: string): boolean => /^GTEAMS[0-9A-F]{20}$/.test(ch);
/** A message's time as Slack writes it (seconds.milliseconds), so the engine's "after this message" works unchanged. */
export const teamsTs = (ms: number): string => (ms / 1000).toFixed(3);

// ---------- Teams' text, made plain ----------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** A message body as the owner would read it: mentions as @Name, no markup, no invisible characters, one line, cut. */
export function plainTeams(body: { contentType?: unknown; content?: unknown } | undefined): string {
  const raw = typeof body?.content === "string" ? body.content : "";
  let s = raw;
  if (body?.contentType !== "text") {
    s = s
      .replace(/<at\b[^>]*>([\s\S]*?)<\/at>/gi, (_m, name: string) => `@${name.replace(/<[^>]*>/g, "")}`)
      .replace(/<(br|\/p|\/div|\/li)\b[^>]*>/gi, " ")
      .replace(/<(attachment|systemEventMessage)\b[^>]*>(<\/\1>)?/gi, " ")
      .replace(/<[^>]*>/g, "");
  }
  return s
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (m, e: string) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TEXT_MAX);
}

/** A WebVTT transcript as "Speaker: words" lines, the same speaker's turns joined. */
export function vttText(vtt: string, max = 12_000): string {
  const out: string[] = [];
  for (const block of vtt.replace(/\r/g, "").split(/\n\n+/)) {
    const lines = block.split("\n").filter((x) => x && x !== "WEBVTT" && !/-->/.test(x) && !/^[\w-]+$/.test(x.trim()) && !/^NOTE\b/.test(x));
    for (const l of lines) {
      const m = /^<v\s+([^>]{1,80})>([\s\S]*?)(?:<\/v>)?$/.exec(l.trim());
      const who = m ? m[1]!.trim() : "";
      const said = plainTeams({ contentType: "html", content: m ? m[2]! : l });
      if (!said) continue;
      const last = out.at(-1);
      if (who && last?.startsWith(`${who}: `)) out[out.length - 1] = `${last} ${said}`;
      else out.push(who ? `${who}: ${said}` : said);
    }
  }
  return out.join("\n").slice(0, max);
}

// ---------- the sign-in: fresh access tokens, and what was granted ----------

/** Microsoft no longer takes the kept sign-in (revoked, expired, password changed): the card says "Sign in again". */
export class SignInAgain extends Error {
  code = "EOAUTHSIGNIN";
}

/** The granted Graph permissions as short names ("Chat.Read"), from a token answer's `scope`. */
export const grantedOf = (scope: unknown): string[] =>
  typeof scope === "string" ? [...new Set(scope.split(/\s+/).map((s) => s.replace(/^https:\/\/graph\.microsoft\.com\//i, "")).filter(Boolean))] : [];

export interface Granted {
  chats: boolean;
  calendar: boolean;
  mentions: boolean;
  transcripts: boolean;
}
export function features(scopes: readonly string[]): Granted {
  const has = (...names: string[]) => names.some((n) => scopes.some((s) => s.toLowerCase() === n.toLowerCase()));
  return {
    chats: has("Chat.Read", "Chat.ReadWrite"),
    calendar: has("Calendars.Read", "Calendars.ReadWrite"),
    mentions: has("ChannelMessage.Read.All") && has("Team.ReadBasic.All", "TeamMember.Read.All") && has("Channel.ReadBasic.All"),
    transcripts: has("OnlineMeetingTranscript.Read.All") && has("OnlineMeetings.Read", "OnlineMeetings.ReadWrite"),
  };
}

/**
 * Fresh Graph tokens from the kept refresh token, one refresh at a time. Asking for ".default" gives every Graph permission the owner (or
 * their admin) granted this app, and the answer says which: so an admin's later approval is seen without signing in again. A refresh token
 * Microsoft replaces is handed to `keep` before it is used.
 */
export function graphTokens(o: {
  clientId: string; refreshToken: string; keep?: (refreshToken: string) => void; fetch?: typeof fetch; now?: () => number; tokenUrl?: string;
}) {
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const url = o.tokenUrl ?? `${MS_LOGIN}/common/oauth2/v2.0/token`;
  let refresh = o.refreshToken;
  let token: { value: string; until: number } | null = null;
  let granted: string[] = [];
  let asking: Promise<string> | null = null;
  const ask = async (): Promise<string> => {
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: o.clientId, scope: `${G}.default offline_access` });
    const r = await f(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(), signal: AbortSignal.timeout(15_000) });
    const j = (await r.json().catch(() => ({}))) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; error?: unknown; scope?: unknown };
    if (typeof j.access_token !== "string") {
      if (j.error === "invalid_grant" || j.error === "unauthorized_client" || j.error === "interaction_required") throw new SignInAgain("Microsoft wants you to sign in to Teams again");
      throw new Error(`Microsoft sign-in: ${typeof j.error === "string" ? j.error.slice(0, 60) : `HTTP ${r.status}`}`);
    }
    if (typeof j.refresh_token === "string" && j.refresh_token && j.refresh_token !== refresh) {
      refresh = j.refresh_token;
      try {
        o.keep?.(refresh);
      } catch (err) {
        log.error(`could not keep the new refresh token: ${(err as Error).name}`);
      }
    }
    granted = grantedOf(j.scope);
    token = { value: j.access_token, until: now() + (Number(j.expires_in) || 3600) * 1000 - 120_000 };
    return token.value;
  };
  return {
    access: (): Promise<string> => {
      if (token && token.until > now()) return Promise.resolve(token.value);
      asking ??= ask().finally(() => {
        asking = null;
      });
      return asking;
    },
    /** Forget the access token (Graph said 401): the next call refreshes. */
    drop: (): void => {
      token = null;
    },
    granted: (): string[] => granted,
  };
}

// ---------- Graph, politely ----------

/** Graph said "slow down" for longer than Pako waits: the reader skips rounds until then. */
export class Throttled extends Error {
  until: number;
  constructor(until: number) {
    super("Microsoft asked Pako to slow down");
    this.until = until;
  }
}
export class GraphError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, what: string) {
    super(`${what}: HTTP ${status}${code ? ` ${code}` : ""}`);
    this.status = status;
    this.code = code;
  }
}

/** Retry-After as milliseconds: seconds, or an HTTP date; 30 s when Graph gives none. */
export const retryAfterMs = (v: string | null, now: number): number => {
  if (!v) return 30_000;
  if (/^\d{1,6}$/.test(v.trim())) return Number(v.trim()) * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : 30_000;
};

// ---------- what is kept ----------

interface Place {
  /** Graph's lastModifiedDateTime of the newest message seen (ISO): the next read asks only for what changed after it. */
  after: string;
  /** The ids already handed on, so an edited message is not handed on twice. */
  seen: string[];
}
interface Conv {
  chat?: string;
  team?: string;
  channel?: string;
  label: string;
  direct: boolean;
  at: number;
}
interface State {
  /** When Teams was connected (ISO): nothing older is handed on live (the catch-up reads the days before, once). */
  start: string;
  chats: Record<string, Place>;
  /** Each channel's delta link, kept as Graph gave it. */
  channels: Record<string, { delta: string }>;
  /** The engine's conversation ids, and the Teams conversation each one is. */
  ids: Record<string, Conv>;
  /** Meetings whose transcript was handed on, or given up on. */
  meetings: string[];
  lastRead: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  transcriptsOff: boolean;
  caughtUp: boolean;
}

/** One message to or from the owner, as the engine takes a Slack one (src/followups/types.ts SlackSeen), with whether it is the owner's. */
export interface TeamsSeen {
  channel: string;
  ts: string;
  at: number;
  who: string;
  where: string;
  direct: boolean;
  text: string;
  mine: boolean;
}

/** A conversation of the catch-up: its last days' messages, handed to the engine paced (src/backfill.ts addChat). */
export interface TeamsCatchUp {
  channel: string;
  where: string;
  direct: boolean;
  msgs: { ts: string; at: number; who: string; text: string }[];
}

export interface TeamsMeeting {
  id: string;
  title: string;
  start: number;
  end: number;
  created?: number;
  recurring: boolean;
  joinUrl: string;
}

export interface TeamsStatus {
  account: string;
  name: string;
  org: string;
  granted: Granted;
  lastRead: number | null;
  lastError: string | null;
  transcriptsOff: boolean;
  throttledUntil: number | null;
}

export interface TeamsDeps {
  config: TeamsConfig;
  kv: Kv | null;
  /** Each new message to or from the owner (src/followups.ts observeSlack). */
  observe: (m: TeamsSeen) => void | Promise<void>;
  /** A finished meeting's transcript, as a Zoom summary is offered (src/followups.ts offer). */
  offer?: (o: { source: "meeting"; ref: string; label: string; text: string; at: number }) => Promise<boolean>;
  /** The quiet catch-up of the last days (src/backfill.ts): its days, and where each conversation goes. */
  catchUp?: { days: number; add: (c: TeamsCatchUp) => Promise<unknown> };
  /** One calm line to the owner (the catch-up's start only). */
  notify?: (text: string) => Promise<unknown>;
  /** A refresh token Microsoft replaced: kept where the panel keeps it. */
  keep?: (refreshToken: string) => void;
  health?: HealthReport;
  fetch?: typeof fetch;
  now?: () => number;
  /** For the tests: a fake Graph and a fake sign-in, and a wait that does not wait. */
  graph?: string;
  tokenUrl?: string;
  sleep?: (ms: number) => Promise<void>;
}

const SAY = {
  start: "Connected to Teams as {name}. Catching up on the last {days} days quietly ({n} conversations); what still needs you will be on the dashboard.",
  dm: "Teams · {who} (private)",
  group: "Teams · {who} in {topic}",
  meetingChat: "Teams · {who} in the chat of {topic}",
  aGroup: "a group chat",
  inChannel: "Teams · {who} in #{channel}",
  someone: "someone",
  noText: "(a file, or a message with no text)",
};
const say = (k: keyof typeof SAY, v: Record<string, string | number> = {}): string => SAY[k].replace(/\{(\w+)\}/g, (m, x: string) => String(v[x] ?? m));

interface GraphMessage {
  id?: string;
  messageType?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  deletedDateTime?: string | null;
  from?: { user?: { id?: string; displayName?: string } | null; application?: unknown } | null;
  body?: { contentType?: string; content?: string };
  /** Files and cards sent with the message. */
  attachments?: unknown[];
  mentions?: { mentioned?: { user?: { id?: string } | null } | null }[];
  replyToId?: string | null;
  chatId?: string | null;
}
interface GraphChat {
  id?: string;
  topic?: string | null;
  chatType?: string;
  lastMessagePreview?: { createdDateTime?: string } | null;
  members?: { displayName?: string; userId?: string }[];
}

export function createTeams(d: TeamsDeps) {
  const f = d.fetch ?? fetch;
  const now = d.now ?? Date.now;
  const base = (d.graph ?? GRAPH_API).replace(/\/+$/, "");
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tokens = graphTokens({
    clientId: d.config.clientId, refreshToken: d.config.refreshToken, ...(d.keep ? { keep: d.keep } : {}), fetch: f, now, ...(d.tokenUrl ? { tokenUrl: d.tokenUrl } : {}),
  });
  let throttledUntil = 0;

  /**
   * One Graph GET. A link Graph gave (next page, delta) is followed only when it is on Graph itself: the token never goes anywhere else.
   * 429 and 503 honour Retry-After: a short wait is waited once, a long one makes the reader skip rounds until then.
   */
  const get = async (pathOrUrl: string, what: string, headers: Record<string, string> = {}): Promise<Record<string, unknown>> => {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${base}${pathOrUrl}`;
    if (!url.startsWith(`${base}/`)) throw new Error(`${what}: a link outside Microsoft Graph was not followed`);
    for (let attempt = 0; ; attempt++) {
      if (now() < throttledUntil) throw new Throttled(throttledUntil);
      const token = await tokens.access();
      let r: Response;
      try {
        r = await f(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json", ...headers }, signal: AbortSignal.timeout(20_000) });
      } catch {
        /* said in the health line, and thrown */
        d.health?.(false, `Teams ${what}: no answer`);
        throw new Error(`${what}: no answer`);
      }
      if (r.status === 429 || r.status === 503 || r.status === 504) {
        const wait = retryAfterMs(r.headers.get("retry-after"), now());
        await r.body?.cancel().catch(() => undefined);
        if (attempt === 0 && wait <= WAIT_MAX_MS) {
          await sleep(wait);
          continue;
        }
        throttledUntil = now() + Math.max(wait, 60_000);
        throw new Throttled(throttledUntil);
      }
      if (r.status === 401 && attempt === 0) {
        tokens.drop();
        await r.body?.cancel().catch(() => undefined);
        continue;
      }
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: { code?: unknown; innerError?: { code?: unknown } } };
        const code = String(j.error?.innerError?.code ?? j.error?.code ?? "").slice(0, 60);
        // Refused for lack of a permission is that feature's (said on the card); anything else is Teams failing.
        if (r.status !== 403 && r.status !== 404) d.health?.(false, `Teams ${what}: HTTP ${r.status}`);
        throw new GraphError(r.status, code, what);
      }
      d.health?.(true);
      if ((r.headers.get("content-type") ?? "").includes("json")) return (await r.json().catch(() => ({}))) as Record<string, unknown>;
      return { text: await r.text() };
    }
  };

  // ----- the store -----
  let state: State | null = null;
  const fresh = (): State => ({
    start: new Date(now()).toISOString(), chats: {}, channels: {}, ids: {}, meetings: [], lastRead: null, lastError: null, lastErrorAt: null,
    transcriptsOff: false, caughtUp: false,
  });
  let firstEver = false;
  const load = async (): Promise<State> => {
    if (state) return state;
    let s: State | null = null;
    try {
      const raw = d.kv ? await readJsonRecord(d.kv, TEAMS_KEY) : null;
      const p = raw ? (raw as Partial<State>) : null;
      if (p && typeof p.start === "string") s = { ...fresh(), ...p } as State;
    } catch {
      /* not JSON, or the store did not answer: logged, and started from now */
      log.error("the stored place could not be read: starting from now");
    }
    firstEver = !s;
    state = s ?? fresh();
    return state;
  };
  const save = async (): Promise<void> => {
    if (!state || !d.kv) return;
    const ids = Object.entries(state.ids);
    if (ids.length > IDS_KEEP) state.ids = Object.fromEntries(ids.sort((a, b) => b[1].at - a[1].at).slice(0, IDS_KEEP));
    state.meetings = state.meetings.slice(-200);
    await d.kv.set(TEAMS_KEY, JSON.stringify(state), KEEP_S).catch((err: Error) => log.error(`could not keep its place: ${err.message}`));
  };

  // ----- who the owner is -----
  let me: { id: string; name: string } | null = null;
  const whoAmI = async (): Promise<{ id: string; name: string }> => {
    if (me) return me;
    const j = await get("/me?$select=id,displayName", "who you are");
    if (typeof j.id !== "string") throw new Error("Teams did not say who signed in");
    me = { id: j.id, name: typeof j.displayName === "string" ? j.displayName.slice(0, 120) : d.config.name };
    return me;
  };

  // ----- chats -----
  const names = (c: GraphChat, self: string): string =>
    (c.members ?? []).filter((m) => m.userId !== self && m.displayName).map((m) => m.displayName!.slice(0, 40)).slice(0, 3).join(", ");
  /** Where a message was said, as the owner reads it, and whether the conversation is a private one. */
  const whereOf = (c: GraphChat, who: string, self: string): { where: string; direct: boolean } => {
    const topic = (c.topic ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || names(c, self) || say("aGroup");
    if (c.chatType === "oneOnOne") return { where: say("dm", { who }), direct: true };
    if (c.chatType === "meeting") return { where: say("meetingChat", { who, topic }), direct: true };
    return { where: say("group", { who, topic }), direct: true };
  };
  const remember = (s: State, channel: string, conv: Omit<Conv, "at">): void => {
    s.ids[channel] = { ...conv, label: conv.label.slice(0, 120), at: now() };
  };

  const usable = (m: GraphMessage): boolean =>
    m.messageType === "message" && !m.deletedDateTime && !!m.id && !!m.from?.user?.id && typeof m.createdDateTime === "string";

  /** One message handed to the engine, as the owner reads it. */
  const hand = async (s: State, channel: string, c: GraphChat | null, m: GraphMessage, self: string, label?: string): Promise<void> => {
    const at = Date.parse(m.createdDateTime!);
    const mine = m.from!.user!.id === self;
    const who = mine ? (me?.name || d.config.name || "me") : (m.from!.user!.displayName ?? "").slice(0, 80) || say("someone");
    const w = label ? { where: label, direct: false } : whereOf(c ?? {}, who, self);
    const text = plainTeams(m.body) || say("noText");
    await Promise.resolve(d.observe({ channel, ts: teamsTs(at), at, who, where: w.where, direct: w.direct, text, mine }))
      .catch((err: Error) => log.error(`a message could not be handed on: ${err.message}`));
  };

  /** The chats with something new since Pako's place in them, newest first (one call). */
  const listChats = async (): Promise<GraphChat[]> => {
    const j = await get("/me/chats?$expand=lastMessagePreview&$orderby=lastMessagePreview/createdDateTime%20desc&$top=50", "chats");
    return (Array.isArray(j.value) ? (j.value as GraphChat[]) : []).filter((c) => typeof c.id === "string" && c.id.length < 300);
  };
  /**
   * A chat's messages changed after `after` (ISO), newest first. Graph gives 50 a page: the next pages (@odata.nextLink) are followed, up to
   * ten, so a busy chat (or one not read for a while) loses none of its older new messages when its place moves to the newest.
   */
  const chatMessages = async (chatId: string, after: string): Promise<GraphMessage[]> => {
    const q = `$top=50&$orderby=lastModifiedDateTime%20desc&$filter=lastModifiedDateTime%20gt%20${encodeURIComponent(after)}`;
    const out: GraphMessage[] = [];
    let link: string | null = `/me/chats/${encodeURIComponent(chatId)}/messages?${q}`;
    for (let page = 0; link && page < 10; page++) {
      const j: Record<string, unknown> = await get(link, "a chat's messages");
      if (Array.isArray(j.value)) out.push(...(j.value as GraphMessage[]));
      link = typeof j["@odata.nextLink"] === "string" ? (j["@odata.nextLink"] as string) : null;
    }
    return out;
  };
  /**
   * The chat's members' names (for a group's label). A good answer is kept for MEMBERS_TTL_MS, then asked again (people join and leave). A
   * failed one is not kept: the chat goes on with the plain label and asks again after a backoff (doubling from MEMBERS_RETRY_MS, at most
   * MEMBERS_RETRY_MAX_MS), so one bad moment does not leave a group without its names for the rest of the process.
   */
  const members = new Map<string, { list: NonNullable<GraphChat["members"]>; until: number }>();
  const membersFailed = new Map<string, { tries: number; next: number }>();
  const withMembers = async (c: GraphChat): Promise<GraphChat> => {
    if (c.topic || c.chatType === "oneOnOne") return c;
    const id = c.id!;
    const kept = members.get(id);
    if (kept && kept.until > now()) return { ...c, members: kept.list };
    const failed = membersFailed.get(id);
    if (failed && failed.next > now()) return { ...c, members: kept?.list ?? [] };
    try {
      const j = await get(`/me/chats/${encodeURIComponent(id)}/members`, "a chat's members");
      const list = (Array.isArray(j.value) ? (j.value as NonNullable<GraphChat["members"]>) : []).slice(0, 10);
      members.set(id, { list, until: now() + MEMBERS_TTL_MS });
      membersFailed.delete(id);
      return { ...c, members: list };
    } catch (err) {
      const tries = (failed?.tries ?? 0) + 1;
      membersFailed.set(id, { tries, next: now() + Math.min(MEMBERS_RETRY_MS * 2 ** (tries - 1), MEMBERS_RETRY_MAX_MS) });
      log.error(`a chat's members could not be read (asked again later): ${(err as Error).message}`);
      // An older good answer is still better than none while it is asked again.
      return { ...c, members: kept?.list ?? [] };
    }
  };

  const readChats = async (s: State, self: string): Promise<number> => {
    const chats = await listChats();
    let read = 0;
    let found = 0;
    for (const c0 of chats) {
      if (read >= PER_ROUND) break;
      const last = Date.parse(c0.lastMessagePreview?.createdDateTime ?? "");
      const place = s.chats[c0.id!] ?? { after: s.start, seen: [] };
      if (!Number.isFinite(last) || last <= Date.parse(place.after)) continue;
      read++;
      let msgs: GraphMessage[];
      try {
        msgs = (await chatMessages(c0.id!, place.after)).filter(usable);
      } catch (err) {
        // A chat this sign-in may not read (one the owner left, a meeting chat closed to them): that chat's, not Teams failing. Passed by
        // until it has something newer, so it does not stop the chats after it from being read every round.
        if (!(err instanceof GraphError) || (err.status !== 403 && err.status !== 404)) throw err;
        log.error(`a chat could not be read: ${err.message}`);
        s.chats[c0.id!] = { after: new Date(last).toISOString(), seen: place.seen };
        continue;
      }
      const c = await withMembers(c0);
      const channel = teamsChannel(`chat:${c.id}`);
      remember(s, channel, { chat: c.id!, label: whereOf(c, "", self).where, direct: true });
      // Oldest first, as they were written; only the ones new since Teams was connected (an edit of an older one is not news).
      msgs.sort((a, b) => Date.parse(a.createdDateTime!) - Date.parse(b.createdDateTime!));
      for (const m of msgs) {
        if (place.seen.includes(m.id!) || Date.parse(m.createdDateTime!) <= Date.parse(s.start)) continue;
        await hand(s, channel, c, m, self);
        place.seen.push(m.id!);
        found++;
      }
      const newest = msgs.map((m) => m.lastModifiedDateTime ?? m.createdDateTime!).sort().at(-1);
      s.chats[c.id!] = { after: newest && newest > place.after ? newest : new Date(Math.max(last, Date.parse(place.after))).toISOString(), seen: place.seen.slice(-SEEN_KEEP) };
    }
    return found;
  };

  // ----- channel mentions (admin-granted) -----
  let channelList: { team: string; channel: string; name: string }[] = [];
  let rounds = 0;
  let turn = 0;
  const listChannels = async (): Promise<void> => {
    const teams = await get("/me/joinedTeams?$select=id,displayName", "your teams");
    const out: typeof channelList = [];
    for (const t of (Array.isArray(teams.value) ? (teams.value as { id?: string }[]) : []).slice(0, 20)) {
      if (typeof t.id !== "string") continue;
      try {
        const ch = await get(`/teams/${encodeURIComponent(t.id)}/channels?$select=id,displayName`, "a team's channels");
        for (const c of (Array.isArray(ch.value) ? (ch.value as { id?: string; displayName?: string }[]) : []).slice(0, 30)) {
          if (typeof c.id === "string") out.push({ team: t.id, channel: c.id, name: (c.displayName ?? "").replace(/\s+/g, " ").slice(0, 60) });
        }
      } catch (err) {
        if (err instanceof Throttled) throw err;
      }
    }
    channelList = out.slice(0, 200);
  };
  const readMentions = async (s: State, self: string): Promise<number> => {
    if (!channelList.length || rounds % 12 === 0) await listChannels();
    if (!channelList.length) return 0;
    let found = 0;
    for (let i = 0; i < Math.min(CHANNELS_PER_ROUND, channelList.length); i++) {
      const c = channelList[(turn + i) % channelList.length]!;
      const key = `${c.team}|${c.channel}`;
      let link: string | null = s.channels[key]?.delta
        ?? `/teams/${encodeURIComponent(c.team)}/channels/${encodeURIComponent(c.channel)}/messages/delta?$filter=lastModifiedDateTime%20gt%20${encodeURIComponent(s.start)}`;
      for (let page = 0; link && page < 5; page++) {
        const j: Record<string, unknown> = await get(link, "a channel's messages");
        for (const m of (Array.isArray(j.value) ? (j.value as GraphMessage[]) : []).filter(usable)) {
          const toMe = (m.mentions ?? []).some((x) => x.mentioned?.user?.id === self);
          if (!toMe || m.from!.user!.id === self || Date.parse(m.createdDateTime!) <= Date.parse(s.start)) continue;
          const channel = teamsChannel(`channel:${key}`);
          const who = (m.from!.user!.displayName ?? "").slice(0, 80) || say("someone");
          const label = say("inChannel", { who, channel: c.name || "channel" });
          remember(s, channel, { team: c.team, channel: c.channel, label: `Teams · #${c.name || "channel"}`, direct: false });
          await hand(s, channel, null, m, self, label);
          found++;
        }
        const next = typeof j["@odata.nextLink"] === "string" ? (j["@odata.nextLink"] as string) : null;
        // Where to go on from: the delta link at the end, or (more pages than one round reads) the next page, so the next round continues
        // there instead of reading the same pages, and handing on the same mentions, again.
        if (typeof j["@odata.deltaLink"] === "string") s.channels[key] = { delta: j["@odata.deltaLink"] as string };
        else if (next) s.channels[key] = { delta: next };
        link = next;
      }
    }
    turn = (turn + CHANNELS_PER_ROUND) % channelList.length;
    return found;
  };

  // ----- meetings: the calendar's Teams meetings, and their transcripts (admin-granted) -----
  let meetingCache: { at: number; list: TeamsMeeting[] } | null = null;
  const meetings = async (): Promise<TeamsMeeting[]> => {
    if (meetingCache && now() - meetingCache.at < 5 * 60_000) return meetingCache.list;
    const from = new Date(now() - 2 * 24 * 3600_000).toISOString();
    const to = new Date(now() + 7 * 24 * 3600_000).toISOString();
    const sel = "subject,start,end,isOnlineMeeting,onlineMeeting,onlineMeetingProvider,createdDateTime,type,seriesMasterId";
    const j = await get(`/me/calendarView?startDateTime=${encodeURIComponent(from)}&endDateTime=${encodeURIComponent(to)}&$select=${sel}&$top=100`, "your calendar", {
      prefer: 'outlook.timezone="UTC"',
    });
    type Ev = {
      id?: string; subject?: string; start?: { dateTime?: string }; end?: { dateTime?: string }; isOnlineMeeting?: boolean; onlineMeetingProvider?: string;
      onlineMeeting?: { joinUrl?: string } | null; createdDateTime?: string; type?: string; seriesMasterId?: string | null;
    };
    const utc = (v: string | undefined) => Date.parse(v ? (/[zZ]|[+-]\d\d:\d\d$/.test(v) ? v : `${v}Z`) : "");
    const list = (Array.isArray(j.value) ? (j.value as Ev[]) : [])
      .filter((e) => e.isOnlineMeeting && (e.onlineMeetingProvider ?? "teamsForBusiness") === "teamsForBusiness" && typeof e.onlineMeeting?.joinUrl === "string")
      .map((e): TeamsMeeting => {
        const created = Date.parse(e.createdDateTime ?? "");
        return {
          id: String(e.id ?? "").slice(0, 300), title: (e.subject ?? "").replace(/\s+/g, " ").trim().slice(0, 120), start: utc(e.start?.dateTime), end: utc(e.end?.dateTime),
          ...(Number.isFinite(created) ? { created } : {}), recurring: e.type === "occurrence" || !!e.seriesMasterId, joinUrl: e.onlineMeeting!.joinUrl!,
        };
      })
      .filter((m) => Number.isFinite(m.start) && Number.isFinite(m.end));
    meetingCache = { at: now(), list };
    return list;
  };

  const readTranscripts = async (s: State): Promise<number> => {
    if (!d.offer || s.transcriptsOff) return 0;
    const t = now();
    const done = (await meetings()).filter((m) => m.end < t - 10 * 60_000 && m.end > t - 2 * 24 * 3600_000 && !s.meetings.includes(m.id));
    const m = done[0];
    if (!m) return 0;
    try {
      const filter = encodeURIComponent(`JoinWebUrl eq '${m.joinUrl.replace(/'/g, "''")}'`);
      const om = await get(`/me/onlineMeetings?$filter=${filter}`, "a meeting");
      const id = ((Array.isArray(om.value) ? om.value : []) as { id?: string }[])[0]?.id;
      if (typeof id !== "string") {
        s.meetings.push(m.id);
        return 0;
      }
      const ts = await get(`/me/onlineMeetings/${encodeURIComponent(id)}/transcripts`, "a meeting's transcripts");
      const list = (Array.isArray(ts.value) ? ts.value : []) as { id?: string; createdDateTime?: string }[];
      const last = list.filter((x) => typeof x.id === "string").sort((a, b) => String(a.createdDateTime).localeCompare(String(b.createdDateTime))).at(-1);
      if (!last) {
        // No transcript (nobody turned it on): looked for again until six hours after the meeting, then given up.
        if (t - m.end > 6 * 3600_000) s.meetings.push(m.id);
        return 0;
      }
      const c = await get(`/me/onlineMeetings/${encodeURIComponent(id)}/transcripts/${encodeURIComponent(last.id!)}/content?$format=text/vtt`, "a transcript", { accept: "text/vtt" });
      const text = vttText(typeof c.text === "string" ? c.text : "");
      s.meetings.push(m.id);
      if (!text) return 0;
      await d.offer({ source: "meeting", ref: `teams:${createHash("sha256").update(m.id).digest("hex").slice(0, 24)}`, label: `Teams · ${m.title || "meeting"}`, text, at: m.start });
      return 1;
    } catch (err) {
      if (err instanceof GraphError && err.status === 403) {
        // The admin turned Graph's access to transcripts off for the whole company: said on the card, not tried again.
        if (err.code === "GraphAccessToTranscriptsDisabled") s.transcriptsOff = true;
        s.meetings.push(m.id);
        return 0;
      }
      throw err;
    }
  };

  // ----- the catch-up of the last days, once -----
  const catchUp = async (s: State, self: string): Promise<void> => {
    if (!d.catchUp || s.caughtUp) return;
    s.caughtUp = true;
    const since = new Date(now() - d.catchUp.days * 24 * 3600_000).toISOString();
    const chats = (await listChats()).filter((c) => Date.parse(c.lastMessagePreview?.createdDateTime ?? "") > Date.parse(since)).slice(0, 40);
    const found: TeamsCatchUp[] = [];
    for (const c0 of chats) {
      try {
        const msgs = (await chatMessages(c0.id!, since)).filter(usable).filter((m) => Date.parse(m.createdDateTime!) <= Date.parse(s.start));
        if (!msgs.length) continue;
        const c = await withMembers(c0);
        const channel = teamsChannel(`chat:${c.id}`);
        msgs.sort((a, b) => Date.parse(a.createdDateTime!) - Date.parse(b.createdDateTime!));
        const label = whereOf(c, "", self).where;
        remember(s, channel, { chat: c.id!, label, direct: true });
        const firstOther = msgs.find((m) => m.from!.user!.id !== self);
        const who = (firstOther?.from?.user?.displayName ?? "").slice(0, 80) || say("someone");
        found.push({
          channel, where: whereOf(c, who, self).where, direct: true,
          msgs: msgs.slice(-25).map((m) => ({
            ts: teamsTs(Date.parse(m.createdDateTime!)), at: Date.parse(m.createdDateTime!),
            who: m.from!.user!.id === self ? me?.name || d.config.name || "me" : (m.from!.user!.displayName ?? "").slice(0, 80) || say("someone"),
            text: plainTeams(m.body) || say("noText"),
          })),
        });
      } catch (err) {
        if (err instanceof Throttled) break;
      }
    }
    if (!found.length) return;
    await d.notify?.(say("start", { name: d.config.name || me?.name || d.config.account || "you", days: d.catchUp.days, n: found.length })).catch(() => undefined);
    for (const c of found) await d.catchUp.add(c).catch(() => undefined);
  };

  // ----- one round -----
  let busy = false;
  const round = async (): Promise<number> => {
    if (busy) return 0;
    busy = true;
    const s = await load();
    try {
      if (now() < throttledUntil) return 0;
      const self = (await whoAmI()).id;
      if (firstEver) {
        firstEver = false;
        await catchUp(s, self);
      }
      const g = features(tokens.granted());
      let found = 0;
      if (g.chats) found += await readChats(s, self);
      if (g.mentions) found += await readMentions(s, self);
      if (g.transcripts) found += await readTranscripts(s);
      rounds++;
      s.lastRead = now();
      s.lastError = null;
      s.lastErrorAt = null;
      return found;
    } catch (err) {
      if (!(err instanceof Throttled)) {
        // Only the error's own words: never a request with its token, never a message's text.
        s.lastError = (err as Error).message.slice(0, 200);
        s.lastErrorAt = now();
        if (err instanceof SignInAgain) d.health?.(false, "Teams: sign in again");
        log.error(`a round failed: ${s.lastError}`);
      }
      return 0;
    } finally {
      await save();
      busy = false;
    }
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    round,
    start: (): void => {
      if (timer) return;
      // The first look soon after start, then every few minutes.
      setTimeout(() => void round(), 15_000).unref?.();
      timer = setInterval(() => void round(), d.config.pollMinutes * 60_000);
      timer.unref?.();
    },
    stop: (): void => {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /**
     * A Teams conversation's latest messages, oldest first, the owner's marked `mine` (what src/followups.ts asks Slack's history for: the
     * context of an extraction and the checks of a later reply). Throws when the conversation is not one Pako knows.
     */
    history: async (channel: string, o: { limit?: number; oldest?: string } = {}): Promise<{ ts: string; at: number; mine: boolean; who: string; text: string; file?: boolean }[]> => {
      const s = await load();
      const conv = s.ids[channel];
      if (!conv) throw new Error("Teams: that conversation is not known here");
      const self = (await whoAmI()).id;
      const limit = Math.min(50, Math.max(1, o.limit ?? 15));
      let msgs: GraphMessage[];
      if (conv.chat) {
        const oldest = o.oldest ? new Date(Number(o.oldest) * 1000).toISOString() : "";
        const q = oldest
          ? `$top=50&$orderby=lastModifiedDateTime%20desc&$filter=lastModifiedDateTime%20gt%20${encodeURIComponent(oldest)}`
          : `$top=${limit}&$orderby=createdDateTime%20desc`;
        const j = await get(`/me/chats/${encodeURIComponent(conv.chat)}/messages?${q}`, "a chat's messages");
        msgs = Array.isArray(j.value) ? (j.value as GraphMessage[]) : [];
      } else {
        const j = await get(`/teams/${encodeURIComponent(conv.team!)}/channels/${encodeURIComponent(conv.channel!)}/messages?$top=${limit}`, "a channel's messages");
        msgs = Array.isArray(j.value) ? (j.value as GraphMessage[]) : [];
      }
      const out = msgs.filter(usable).map((m) => {
        const at = Date.parse(m.createdDateTime!);
        const mine = m.from!.user!.id === self;
        // A file or a link: what a document sent there is seen by.
        const file = (Array.isArray(m.attachments) && m.attachments.length > 0) || /https?:\/\//.test(m.body?.content ?? "");
        return { ts: teamsTs(at), at, mine, who: mine ? "" : (m.from!.user!.displayName ?? "").slice(0, 80) || say("someone"), text: plainTeams(m.body) || say("noText"), ...(file ? { file } : {}) };
      });
      out.sort((a, b) => a.at - b.at);
      return (o.oldest ? out.filter((m) => Number(m.ts) > Number(o.oldest)) : out).slice(-limit);
    },
    /** The calendar's Teams meetings as the follow-ups' checks read events: "the meeting happened". Empty without the calendar's permission. */
    events: async (): Promise<{ title: string; start: number; created?: number; recurring?: boolean }[]> => {
      if (!features(tokens.granted()).calendar && tokens.granted().length) return [];
      return (await meetings()).map((m) => ({ title: m.title, start: m.start, ...(m.created ? { created: m.created } : {}), recurring: m.recurring }));
    },
    meetings,
    /** The card's facts (src/teams-connect.ts status). Never a token. Asks Microsoft for a fresh token once when none was asked yet. */
    status: async (): Promise<TeamsStatus> => {
      const s = await load();
      if (!tokens.granted().length) await tokens.access().catch(() => undefined);
      return {
        account: d.config.account, name: d.config.name || me?.name || "", org: d.config.org, granted: features(tokens.granted()),
        lastRead: s.lastRead, lastError: s.lastError, transcriptsOff: s.transcriptsOff, throttledUntil: throttledUntil > now() ? throttledUntil : null,
      };
    },
    /** For the watchdog's half-hourly look: whether the sign-in still works. */
    check: async (): Promise<boolean> => {
      try {
        await get("/me?$select=id", "who you are");
        return true;
      } catch (err) {
        return err instanceof Throttled;
      }
    },
  };
}

export type TeamsReader = ReturnType<typeof createTeams>;
