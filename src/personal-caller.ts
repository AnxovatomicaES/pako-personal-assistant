// Personal caller: lets the owner's own assistant (Claude, through a private connector) phone the owner, and a short
// list of approved friends by name, from the Retell number this server already uses. It is a separate feature from the
// restaurant caller: its own secret URL (/personal/<token>), its own Retell agent (src/personal-agent.ts), its own caps.
//
// Off unless PERSONAL_CALLER_TOKEN is set. Dry run (no real call) unless PERSONAL_LIVE=1. The first live call creates the
// personal Retell agent when it does not exist; list_voices and set_voice let the owner hear and choose its voice.
// A wrong configuration turns the feature off and says why in the log; it never stops the product from starting.
//
// What the server enforces (not the prompt): call_me can dial only the owner's number; call_contact only a name from
// PERSONAL_CONTACTS (a raw number is never accepted), and only once the owner has pressed Call on the card it sends them
// (WhatsApp, or the panel's chat in local mode); rolling 24 h caps for the owner, for all friends and for each friend;
// quiet hours for friends; Retell's do-not-call list is honoured; premium-rate numbers are refused.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  findPersonalAgent, listVoiceChoices, syncPersonalAgent,
  type AgentSyncOptions, type AgentSyncResult, type PersonalEngine,
} from "./personal-agent.ts";
import { pauseLabel, pausedText, type Control } from "./control.ts";
import { locale, texts, type Lang } from "./i18n.ts";
import { ownerTimeZone } from "./region.ts";
import { addCommunityVoice, call as retellCall, RetellError, searchCommunityVoices } from "./retell.ts";
import { loadKv, type Kv } from "./kv.ts";
import { buttonLabels, callWords, cleanCallMessage, PENDING_CALL_MS, type AskResult, type OwnerAsk } from "./whatsapp.ts";
import { GEMINI_VOICES, loadVoiceBridge, parseResult, type VoiceBridge } from "./voice-bridge.ts";
import { loadVoiceTools, type VoiceTools } from "./voice-tools.ts";
import { loadMemory, memoryText, type MemoryStore } from "./voice-memory.ts";
import { ownerPrompt, type OwnerMode } from "./voice-prompt.ts";
import { voiceLabCsp, voiceLabPage } from "./voice-lab.ts";
import { createLog } from "./log.ts";

const logPersonalCaller = createLog("personal-caller");
const logVoiceLab = createLog("voice-lab");

// ---------- Configuration ----------

export interface Contact {
  name: string;
  number: string;
}

export interface QuietHours {
  startMin: number;
  endMin: number;
  timeZone: string;
  label: string;
}

export interface PersonalConfig {
  /** The secret in the connector address: /personal/<token>. */
  token: string;
  ownerNumber: string;
  ownerName: string;
  /** Approved friends, by lower-case name. */
  contacts: Map<string, Contact>;
  quiet: QuietHours | null;
  /**
   * The owner's IANA time zone (PERSONAL_TIMEZONE, else this computer's own, else UTC: src/region.ts): reminders, the brief, bookings and
   * Slack's quiet hours use it, quiet hours on or off.
   */
  timeZone: string;
  /** Set when no zone was given and this computer only reports UTC: said once in the log at start. */
  timeZoneNote?: string;
  /** The personal agent's id; empty = found by its name in the Retell account. Never the restaurant agent. */
  agentId: string;
  /** False = dry run: the tools answer with a fake call id and nobody is rung. */
  live: boolean;
  dailyCap: number;
  minGapSeconds: number;
  contactDailyCap: number;
  perContactDailyCap: number;
}

type Env = Record<string, string | undefined>;

const E164 = /^\+[1-9]\d{6,14}$/;
const NAME = /^[\p{L}][\p{L}\p{M} .'-]{0,39}$/u;
/** Spanish premium-rate (803-807) and 90x shared-cost and televoting ranges: never a contact, never the owner's number. */
// The premium-rate ranges of the countries most likely to be called (not every country's: a number outside these is the owner's responsibility).
const BLOCKED_PREFIXES = [/^\+34(80[3-7]|90\d|70\d)/, /^\+1900/, /^\+449/, /^\+3389/, /^\+49900/, /^\+3989/, /^\+35176/];
const MAX_CONTACTS = 50;
const CONTROL = /[\u0000-\u001f\u007f]/g;

export function normalizeName(name: string): string {
  return String(name).normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Errors name the contact but never print the number. `source` is the setting the text came from (for the messages) and `contacts` the
 * list so far: a second setting is read into the same map, so a name in both is reported as a duplicate.
 */
export function parseContacts(raw: string | undefined, errors: string[], source = "PERSONAL_CONTACTS", contacts = new Map<string, Contact>()): Map<string, Contact> {
  if (!raw || !raw.trim()) return contacts;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* said in the errors */
    errors.push(`${source} must be valid JSON, for example {"Ana":"+447700900123"}`);
    return contacts;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    errors.push(`${source} must be a JSON object of name to E.164 number`);
    return contacts;
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length + contacts.size > MAX_CONTACTS) errors.push(`${source} makes more than ${MAX_CONTACTS} contacts`);
  for (const [name, number] of entries) {
    const label = JSON.stringify(String(name).slice(0, 40));
    if (!NAME.test(name)) {
      errors.push(`${source} name ${label} is invalid (letters, spaces, . ' - ; at most 40 characters)`);
      continue;
    }
    if (typeof number !== "string" || !E164.test(number)) {
      errors.push(`${source} number for ${label} must be E.164, for example +447700900123`);
      continue;
    }
    if (BLOCKED_PREFIXES.some((re) => re.test(number))) {
      errors.push(`${source} number for ${label} is in a blocked range (premium or shared-cost)`);
      continue;
    }
    const key = normalizeName(name);
    if (contacts.has(key)) {
      errors.push(`${source} has the name ${label} twice (names are not case-sensitive)`);
      continue;
    }
    contacts.set(key, { name: name.trim().replace(/\s+/g, " "), number });
  }
  return contacts;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

/** "22:00-09:00" in a time zone; "off" disables; start equal to end means always quiet. */
export function parseQuietHours(rawRange: string | undefined, rawTz: string | undefined, errors: string[]): QuietHours | null {
  const range = (rawRange ?? "").trim() || "22:00-09:00";
  if (range.toLowerCase() === "off") return null;
  const zone = ownerTimeZone(rawTz);
  if (zone.problem) {
    errors.push(zone.problem);
    return null;
  }
  const timeZone = zone.timeZone;
  const m = HHMM.exec(range);
  if (!m) {
    errors.push('PERSONAL_QUIET_HOURS must look like 22:00-09:00 (or "off")');
    return null;
  }
  return { startMin: Number(m[1]) * 60 + Number(m[2]), endMin: Number(m[3]) * 60 + Number(m[4]), timeZone, label: range };
}

export function inQuietHours(date: Date, quiet: QuietHours | null): boolean {
  if (!quiet) return false;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: quiet.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const now = Number(parts.find((p) => p.type === "hour")!.value) * 60 + Number(parts.find((p) => p.type === "minute")!.value);
  const { startMin, endMin } = quiet;
  if (startMin === endMin) return true;
  return startMin < endMin ? now >= startMin && now < endMin : now >= startMin || now < endMin;
}

function intFrom(env: Env, key: string, fallback: number, min: number, max: number, errors: string[]): number {
  const raw = (env[key] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(`${key} must be a whole number from ${min} to ${max}`);
    return fallback;
  }
  return n;
}

/** null = the feature is off (no PERSONAL_CALLER_TOKEN). Throws with every problem listed when it is on but wrong. */
export function loadPersonalConfig(env: Env): PersonalConfig | null {
  const token = (env.PERSONAL_CALLER_TOKEN ?? "").trim();
  if (!token) return null;
  const errors: string[] = [];
  if (!/^[A-Za-z0-9_-]{24,}$/.test(token)) errors.push("PERSONAL_CALLER_TOKEN must be 24+ letters, digits, - or _ (for example: openssl rand -hex 24)");
  const ownerNumber = (env.PERSONAL_OWNER_NUMBER ?? "").trim();
  if (!E164.test(ownerNumber)) errors.push("PERSONAL_OWNER_NUMBER must be your mobile in E.164 form, for example +447700900456");
  else if (BLOCKED_PREFIXES.some((re) => re.test(ownerNumber))) errors.push("PERSONAL_OWNER_NUMBER is in a blocked range (premium or shared-cost)");
  const ownerName = (env.PERSONAL_OWNER_NAME ?? "").replace(CONTROL, " ").trim().slice(0, 40);
  if (!ownerName) errors.push("PERSONAL_OWNER_NAME is missing (the opening line says whose assistant is calling)");
  const contacts = parseContacts(env.PERSONAL_CONTACTS, errors);
  // Friends added on top of that list, under the same rules: one can be added without rewriting (or reading back) the whole list.
  parseContacts(env.PERSONAL_CONTACTS_EXTRA, errors, "PERSONAL_CONTACTS_EXTRA", contacts);
  const quiet = parseQuietHours(env.PERSONAL_QUIET_HOURS, env.PERSONAL_TIMEZONE, errors);
  // The owner's time zone is its own setting: quiet hours "off" must not send the reminders, the brief and the bookings to another zone.
  // Without one, this computer's own zone (where the owner is, on their own computer); a server that only knows UTC says so once.
  const zone = ownerTimeZone(env.PERSONAL_TIMEZONE);
  if (zone.problem && !quiet && !errors.includes(zone.problem)) errors.push(zone.problem);
  const timeZone = zone.timeZone;
  const config: PersonalConfig = {
    token,
    ownerNumber,
    ownerName,
    contacts,
    quiet,
    timeZone,
    ...(zone.note ? { timeZoneNote: zone.note } : {}),
    agentId: (env.PERSONAL_AGENT_ID ?? "").trim(),
    live: env.PERSONAL_LIVE === "1",
    dailyCap: intFrom(env, "PERSONAL_DAILY_CAP", 5, 1, 50, errors),
    minGapSeconds: intFrom(env, "PERSONAL_MIN_GAP_SECONDS", 60, 0, 3600, errors),
    contactDailyCap: intFrom(env, "PERSONAL_CONTACT_DAILY_CAP", 5, 1, 50, errors),
    perContactDailyCap: intFrom(env, "PERSONAL_PER_CONTACT_DAILY_CAP", 2, 1, 20, errors),
  };
  if (config.agentId && !/^[A-Za-z0-9_-]{6,80}$/.test(config.agentId)) errors.push("PERSONAL_AGENT_ID is not a Retell agent id (agent_...)");
  if (errors.length) throw new Error(`Personal caller config invalid:\n - ${errors.join("\n - ")}`);
  return config;
}

/** loadConfig's entry: a wrong setting turns the personal caller off and says why; it never stops the server. */
export function loadPersonalConfigSafely(env: Env): PersonalConfig | null {
  try {
    return loadPersonalConfig(env);
  } catch (err) {
    logPersonalCaller.error(`OFF. ${(err as Error).message}`);
    return null;
  }
}

// ---------- Opening lines ----------

/**
 * First thing a friend hears: relaxed, but it says who is calling and in what role. Set per call, by the server. English, like every fixed
 * text of Pako's, whatever `language` says: it is kept on the type (and in the tools' arguments) so a caller or a client with the older tool
 * list still works, and it no longer changes these words. The message (`say`) is the owner's own, in whatever language it was given.
 */
export function buildOpening(o: { kind: "owner" | "friend"; language?: "es" | "en"; contactName?: string; ownerName: string; direct?: boolean; say?: string }): string {
  if (o.kind === "owner") return `Hi ${o.ownerName}, it's your assistant. Quick one for you.`;
  // A friend hears at once that it is an AI assistant calling for the owner. One short sentence, no "how are you": a long
  // greeting collided with the person answering. "direct" drops the question, and the agent then says the message straight away.
  // "say" is the message itself, in the same breath as the greeting: nothing to wait for, so nobody hangs up before hearing it.
  // A message that already ends a sentence (in any language: "?", "!", or the opening marks some languages also use) gets no full stop.
  const said = o.say ? ` ${/[.!?\u00a1\u00bf]$/.test(o.say) ? o.say : `${o.say}.`}` : "";
  const ask = o.direct || o.say;
  return `Hi ${o.contactName}, I'm ${o.ownerName}'s AI assistant, calling on ${o.ownerName}'s behalf.${said}${ask ? "" : " Got a minute?"}`;
}

// ---------- Limits ----------

const DAY_MS = 24 * 60 * 60 * 1000;

/** `wait`: refused only for the gap, and free again after that many seconds. */
export type Slot = { ok: true; id: number } | { ok: false; reason: string; wait?: number };

export interface Limiter {
  reserve(): Slot;
  release(id: number): void;
  used(): number;
  /** The cap's refusal when it is full now, without using a slot (the gap is not looked at); null when there is room. */
  full(): string | null;
}

/** A rolling 24 h cap with a minimum gap between calls. In memory: a restart resets it; Retell's own limits are the backstop. */
export function createLimiter(o: { dailyCap: number; minGapSeconds: number; now?: () => number }): Limiter {
  const now = o.now ?? Date.now;
  const capReason = `Daily cap reached (${o.dailyCap} calls in any 24 hours). Try again later.`;
  let slots: { id: number; at: number }[] = [];
  let nextId = 1;
  const prune = () => {
    const cutoff = now() - DAY_MS;
    slots = slots.filter((s) => s.at > cutoff);
  };
  return {
    // Reserve before calling the API, so two requests at once cannot both slip under the cap.
    reserve() {
      prune();
      const t = now();
      if (slots.length >= o.dailyCap) return { ok: false, reason: capReason };
      const last = slots.at(-1);
      if (last && t - last.at < o.minGapSeconds * 1000) {
        const wait = Math.max(1, Math.ceil((o.minGapSeconds * 1000 - (t - last.at)) / 1000));
        return { ok: false, reason: `Too soon after the previous call. Wait ${wait} s.`, wait };
      }
      const id = nextId++;
      slots.push({ id, at: t });
      return { ok: true, id };
    },
    // The slot goes back when the call could not be placed.
    release(id) {
      slots = slots.filter((s) => s.id !== id);
    },
    used() {
      prune();
      return slots.length;
    },
    full() {
      prune();
      return slots.length >= o.dailyCap ? capReason : null;
    },
  };
}

// ---------- The tools ----------

export interface PersonalDeps {
  config: PersonalConfig;
  retell: { apiKey: string; fromNumber: string };
  fetch?: typeof fetch;
  now?: () => number;
  /** The LiveKit voice stack (engine "livekit"); null or absent: the engine does not exist. */
  voice?: VoiceBridge | null;
  /** Start with the livekit engine for the owner's calls (PERSONAL_ENGINE=livekit); set_engine changes it at run time. */
  livekitDefault?: boolean;
  /** What the owner's voice assistant knows about the owner between calls (notes, recent calls). */
  memory?: MemoryStore;
  /** The kill switch and the action log (src/control.ts): no call is placed while paused, and every placed call is logged. */
  control?: Control;
  /** More tools for the same connector (the table booking of src/booking.ts), added to each request's server. */
  extraTools?: (server: McpServer) => void;
  /**
   * How a friend call the connector asks for reaches the owner first: the WhatsApp door's card (src/whatsapp.ts), or the panel's chat in
   * local mode. Nothing rings on the connector's say-so: without this, call_contact cannot call friends at all.
   */
  askOwner?: (ask: OwnerAsk) => Promise<AskResult>;
  /**
   * The language of what the OWNER reads (src/i18n.ts): the card for a friend call and the log's lines. English only; kept as a function so
   * the callers that pass it need not change.
   */
  lang?: () => Lang;
}

/** What the owner reads from the phone line: the card for a friend call the connector asks for, and the log's lines about calls. */
const T = texts(
  {
    asks: "Claude is asking to call {name} (from the connector, not from this chat).",
    says: "Right after hello it will say: “{say}”",
    direct: "It will give the message right after hello, without asking anything.",
    message: "The message: “{message}”",
    confirm: "Call? If you didn't ask for this, press {cancel}.",
    you: "you",
    aContact: "a contact",
    logStopped: "Call to {who} stopped: paused ({why})",
    logCall: "Call to {who} ({engine}{dry}){status}",
    dry: ", simulated",
  },
);

/** Cards asking the owner to approve a friend call, in any 24 hours: a connector gone wrong cannot flood the owner's phone with them. */
const ASK_DAILY_CAP = 12;

type AskStatus = "waiting" | "approving" | "placed" | "dry_run" | "not_placed" | "unknown" | "cancelled" | "replaced" | "stopped" | "expired";
/**
 * What the connector tells Claude about a request, in English (Claude reads it). The buttons are named as the owner sees them
 * (src/whatsapp.ts buttonLabels), so Claude tells the owner the name that is on the card.
 */
const askNote = (status: AskStatus, ui: Lang = "en"): string => {
  const { call, cancel } = buttonLabels(ui);
  const notes: Record<AskStatus, string> = {
    waiting: `Not called yet: waiting for the owner to press ${call} (or ${cancel}) on the card.`,
    approving: `The owner pressed ${call}: the call is being placed. Ask again in a few seconds.`,
    placed: `The owner pressed ${call} and the call was placed. \`call\` shows how it went (the summary and transcript come after it ends).`,
    dry_run: `The owner pressed ${call}, but the phone line is in dry run: nobody was rung.`,
    not_placed: `The owner pressed ${call}, but the call could not be placed (see reason).`,
    unknown: `The owner pressed ${call}, but the phone service did not answer clearly: the call may or may not have gone out. `
      + "Do not ask again (it could ring twice); the owner was told.",
    cancelled: `The owner pressed ${cancel}: nobody was called.`,
    replaced: "A newer call request for the same friend replaced this card before the owner answered it: nobody was called for this one.",
    stopped: "Pako was paused (the owner's STOP, the panel's switch, or a safety pause of its own) before the call could be placed: nobody was called. "
      + "Ask again once it runs again, only if the owner still wants it.",
    expired: `The owner did not press ${call} in time: nobody was called.`,
  };
  return notes[status];
};

/**
 * The owner's card for a friend call the connector asks for: where the request comes from, who, and every word the call would use (the
 * opening's fixed greeting aside), in English; under WhatsApp's 1024 characters by construction (a name of at most 40, words of at most 160, a message of at most 600).
 */
export function askCard(o: { name: string; message: string; say: string; language: "es" | "en"; direct: boolean }, ui: Lang = "en"): string {
  const t = T(ui);
  return [
    t("asks", { name: o.name }),
    ...(o.say ? [t("says", { say: o.say })] : o.direct ? [t("direct")] : []),
    t("message", { message: o.message }),
    "",
    // The button as the door shows it in this language (src/whatsapp.ts buttonLabels).
    t("confirm", { cancel: buttonLabels(ui).cancel }),
  ].join("\n");
}

const CALL_ID = /^[A-Za-z0-9_-]{6,80}$/;
const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });
const fail = (t: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: t }] });
// Invisible characters (tag characters, right-to-left overrides, zero-width joiners) too: the owner reads one text and the friend would hear another.
const clean = (s: string) => s.replace(CONTROL, " ").replace(/[\p{Cf}\p{Co}]/gu, "").replace(/\s+/g, " ").trim();
const shorten = (s: unknown, max: number): string | null => (typeof s !== "string" ? null : s.length > max ? `${s.slice(0, max)}… [truncated]` : s);

interface RetellCall {
  call_id: string;
  call_status?: string;
  direction?: string;
  duration_ms?: number;
  disconnection_reason?: string;
  transcript?: string;
  call_analysis?: { call_summary?: string; call_successful?: boolean };
  call_cost?: { combined_cost?: number };
  /** Retell's per-component latency in ms (after the call ends): how long the assistant took to answer, and where the time went. */
  latency?: Record<string, { p50?: number; p90?: number } | undefined>;
  metadata?: { source?: string };
}

/** The median and 90th percentile of each latency component Retell reports; nothing when it reports none. */
function latencySummary(c: RetellCall): Record<string, { p50: number | null; p90: number | null }> | undefined {
  const out: Record<string, { p50: number | null; p90: number | null }> = {};
  for (const k of ["e2e", "asr", "llm", "tts", "s2s"]) {
    const l = c.latency?.[k];
    if (l && (typeof l.p50 === "number" || typeof l.p90 === "number")) {
      out[k] = { p50: typeof l.p50 === "number" ? Math.round(l.p50) : null, p90: typeof l.p90 === "number" ? Math.round(l.p90) : null };
    }
  }
  return Object.keys(out).length ? out : undefined;
}

export function summarizeCall(c: RetellCall): Record<string, unknown> {
  const latency = latencySummary(c);
  return {
    ...(latency ? { latency_ms: latency } : {}),
    call_id: c.call_id,
    call_status: c.call_status,
    duration_seconds: typeof c.duration_ms === "number" ? Math.round(c.duration_ms / 1000) : null,
    disconnection_reason: c.disconnection_reason ?? null,
    summary: c.call_analysis?.call_summary ?? null,
    call_successful: c.call_analysis?.call_successful ?? null,
    transcript: shorten(c.transcript, 4000),
    cost_cents: c.call_cost?.combined_cost ?? null,
  };
}

export interface PersonalCaller {
  buildServer(): McpServer;
  limiters: { owner: Limiter; contacts: Limiter };
  /** The LiveKit voice stack, when configured: the result route of the worker records into it. */
  voice: VoiceBridge | null;
  agentId(): Promise<string>;
  /** Create the personal agent, or bring it up to date (a new voice, a new prompt). One at a time. */
  sync(o?: Pick<AgentSyncOptions, "voiceId" | "voiceModel" | "model" | "engine">): Promise<AgentSyncResult>;
  /** The plain tools of the owner's voice line (contacts, staging and confirming a call, call status, notes). No AI key involved. */
  tools: VoiceTools;
  memory: MemoryStore;
  /** The instructions and opening for a session on the owner's own line (outbound, inbound or the voice lab). */
  ownerSession(mode: OwnerMode, language?: "es" | "en", opts?: { verified?: boolean }): Promise<{ instructions: string; opening: string }>;
}

export function createPersonalCaller(deps: PersonalDeps): PersonalCaller {
  const { config, retell } = deps;
  const f = deps.fetch ?? fetch;
  const voiceStack = deps.voice ?? null;
  // Only the owner's own calls ever use the LiveKit voice: calls to friends stay on the Retell agent.
  let useLivekit = !!voiceStack && deps.livekitDefault === true;
  const owner = createLimiter({ dailyCap: config.dailyCap, minGapSeconds: config.minGapSeconds, now: deps.now });
  // Friends have their own caps, so they can never use up the owner's own call budget.
  const contacts = createLimiter({ dailyCap: config.contactDailyCap, minGapSeconds: config.minGapSeconds, now: deps.now });
  const perContact = new Map<string, Limiter>();
  const limiterFor = (key: string): Limiter => {
    let l = perContact.get(key);
    if (!l) perContact.set(key, (l = createLimiter({ dailyCap: config.perContactDailyCap, minGapSeconds: 0, now: deps.now })));
    return l;
  };

  let agent = config.agentId;
  let queue: Promise<unknown> = Promise.resolve();
  const sync: PersonalCaller["sync"] = (o = {}) => {
    const run = queue.then(() => syncPersonalAgent({ apiKey: retell.apiKey, fetch: f, timeZone: config.timeZone, ...o })).then((r) => {
      agent = r.agentId;
      logPersonalCaller.info(`agent ${r.created ? "created" : "updated"}: ${r.agentId}`);
      return r;
    });
    queue = run.catch(() => undefined);
    return run;
  };
  /** The personal agent only, never the restaurant agent. The first live call creates it when it does not exist yet. */
  const agentId = async (): Promise<string> => {
    if (agent) return agent;
    const found = await findPersonalAgent(retell.apiKey, f);
    if (found) return (agent = found);
    return (await sync()).agentId;
  };
  // Voice changes are rare: a few an hour is plenty, and it keeps a runaway loop away from the Retell account.
  const voiceChanges = createLimiter({ dailyCap: 20, minGapSeconds: 5, now: deps.now });

  const lang = deps.lang ?? ((): Lang => "en");
  /** Who a call was to, as the log says it: the owner ("you"), or the friend's name. */
  type Who = { owner: true } | { name: string };
  const whoText = (who: Who): string => ("owner" in who ? T(lang())("you") : who.name || T(lang())("aContact"));
  // The error carries the refusal by why (a pause Pako set by itself is not the owner's STOP), in the language of Pako's own texts: the
  // voice line and the door tell the pause by those words, in either language (pauseWhyIn in src/control.ts), and word their own answer.
  const stopIfPaused = async (who: Who): Promise<void> => {
    const pause = deps.control ? await deps.control.state() : null;
    if (!deps.control || !pause || pause.paused === null) return;
    const l = lang();
    deps.control.log("blocked", T(l)("logStopped", { who: whoText(who), why: pauseLabel(pause.why, l) }));
    throw new Error(pausedText(pause.why, l));
  };
  const logCall = (who: Who, engine: string, status?: string): void => {
    const t = T(lang());
    deps.control?.log("call", t("logCall", { who: whoText(who), engine, dry: config.live ? "" : t("dry"), status: status ? `: ${status}` : "" }));
  };

  const place = async (to: string, kind: "owner" | "friend", vars: Record<string, string>): Promise<{ call_id: string; call_status?: string }> => {
    const who: Who = kind === "owner" ? { owner: true } : { name: vars.contact_name ?? "" };
    await stopIfPaused(who);
    const placed = await placeRetell(to, kind, vars, who);
    logCall(who, "Retell", placed.call_status);
    return placed;
  };
  const placeRetell = async (
    to: string, kind: "owner" | "friend", vars: Record<string, string>, who: Who = { name: "" },
  ): Promise<{ call_id: string; call_status?: string }> => {
    if (!config.live) return { call_id: `dryrun_${randomUUID().slice(0, 8)}`, call_status: "dry_run" };
    const agent = await agentId(); // can take a while (the agent may have to be made first): STOP is looked at again right after it
    await stopIfPaused(who);
    // The same call asked twice within ten minutes has the same key, so Retell can recognise it: a retry after an answer that never came must not ring twice.
    const bucket = Math.floor((deps.now?.() ?? Date.now()) / 600_000);
    const idempotency_key = createHash("sha256").update(`${kind}|${to}|${JSON.stringify(vars)}|${bucket}`).digest("hex").slice(0, 32);
    try {
      return (await retellCall(f, retell.apiKey, "POST", "/v2/create-phone-call", {
        from_number: retell.fromNumber,
        to_number: to,
        override_agent_id: agent,
        retell_llm_dynamic_variables: vars,
        ...(kind === "friend" ? { honor_internal_dnc: true } : {}),
        metadata: { source: "personal-caller", kind },
        idempotency_key,
      })) as { call_id: string; call_status?: string };
    } catch (err) {
      // A refusal (4xx) means no call exists. A timeout, a server error or an answer that could not be read may mean it does.
      const refused = err instanceof RetellError && err.status >= 400 && err.status < 500;
      throw refused ? err : Object.assign(err instanceof Error ? err : new Error(String(err)), { outcomeUnknown: true });
    }
  };

  const memory = deps.memory ?? loadMemory(null);
  const timeZone = config.timeZone;
  // The owner's own line (LiveKit) has its own short prompt, with what the assistant knows about the owner; friend calls keep Retell's.
  const ownerSession = async (mode: OwnerMode, _language: "es" | "en" = "en", opts: { verified?: boolean } = {}): Promise<{ instructions: string; opening: string }> => {
    const verified = opts.verified !== false;
    const now = new Intl.DateTimeFormat(locale(), { timeZone, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })
      .format(deps.now?.() ?? Date.now());
    // The notes only go into a verified call's prompt: an unverified one never sees them, not even to ignore them.
    const instructions = ownerPrompt({ ownerName: config.ownerName, mode, memory: verified ? memoryText(await memory.read(), timeZone) : "", now, canDelegate: true, verified });
    const opening =
      mode.kind === "message"
        ? buildOpening({ kind: "owner", ownerName: config.ownerName })
        : `Hi ${config.ownerName}, it's your assistant. What's up?`;
    return { instructions, opening };
  };

  const placeLivekit = async (to: string, mode: OwnerMode, language: "es" | "en"): Promise<{ call_id: string; call_status?: string; done?: Promise<string | null> }> => {
    await stopIfPaused({ owner: true });
    if (!config.live) {
      logCall({ owner: true }, "LiveKit", "dry_run");
      return { call_id: `dryrun_${randomUUID().slice(0, 8)}`, call_status: "dry_run" };
    }
    const s = await ownerSession(mode, language);
    const started = voiceStack!.start({ to, kind: "owner", ...s, open: mode.kind === "open", delegate: true, proceed: async () => !deps.control || (await deps.control.paused()) === null });
    logCall({ owner: true }, "LiveKit");
    return { ...started, call_status: "waking_the_voice_server" };
  };

  /** The checks of a friend call that use nothing up: a listed name, the owner's own name, not in quiet hours. */
  const checkFriend = (a: { name: string; on_behalf_of?: string }): { ok: false; text: string } | { ok: true; key: string; entry: Contact } => {
    const key = normalizeName(a.name);
    const entry = config.contacts.get(key);
    if (!entry) return { ok: false, text: `"${a.name.slice(0, 40)}" is not in the contact list. Use list_contacts. Numbers cannot be passed.` };
    // The owner decided: every call goes out in the owner's name, never another person's.
    if (a.on_behalf_of && normalizeName(a.on_behalf_of) !== normalizeName(config.ownerName)) {
      return { ok: false, text: `Every call is made in ${config.ownerName}'s name: it cannot name anyone else.` };
    }
    const at = new Date(deps.now?.() ?? Date.now());
    if (inQuietHours(at, config.quiet)) return { ok: false, text: `Quiet hours (${config.quiet!.label}, ${config.quiet!.timeZone}). Friends are not called now; try later.` };
    return { ok: true, key, entry };
  };

  /** One friend call, placed now: the same way after the owner's press on the connector's card and after the voice line's spoken yes. */
  const callContact = async (
    a: { name: string; message: string; language: "es" | "en"; direct: boolean; say?: string; on_behalf_of?: string },
  ): Promise<{ ok: boolean; text: string; unknown?: boolean; wait?: number }> => {
    const checked = checkFriend(a);
    if (!checked.ok) return checked;
    const { key, entry } = checked;
    const all = contacts.reserve();
    if (!all.ok) return { ok: false, text: all.reason, ...(all.wait ? { wait: all.wait } : {}) };
    const one = limiterFor(key).reserve();
    if (!one.ok) {
      contacts.release(all.id);
      return { ok: false, text: `${entry.name}: ${one.reason}` };
    }
    try {
      // Whose assistant the call says it is: always the owner's. The words are cleaned of "soy <owner>" and the like, here for every way in.
      const caller = config.ownerName;
      const say = a.say ? cleanCallMessage(clean(a.say), caller) : "";
      const call = await place(entry.number, "friend", {
        call_kind: "friend",
        owner_name: caller,
        contact_name: entry.name,
        opening: buildOpening({ kind: "friend", language: a.language, contactName: entry.name, ownerName: caller, direct: a.direct, say: say || undefined }),
        style: a.direct || say ? "direct" : "normal",
        message: cleanCallMessage(clean(a.message), caller),
      });
      logPersonalCaller.info(`call_contact ok call_id=${call.call_id} status=${call.call_status} live=${config.live}`);
      return { ok: true, text: `Call to ${entry.name} started: call_id=${call.call_id}, status=${call.call_status}. Use get_call with this call_id after a few minutes for the outcome.` };
    } catch (err) {
      logPersonalCaller.error(`call_contact failed: ${(err as Error).message}`);
      // Whether the call exists is not known (no answer, a server error): the slots stay used, so a retry cannot ring the friend twice.
      if ((err as { outcomeUnknown?: boolean }).outcomeUnknown) {
        return { ok: false, unknown: true, text: `The call may or may not have been placed: Retell did not answer clearly. Do not try again for now; check get_call or ask the owner.` };
      }
      contacts.release(all.id);
      limiterFor(key).release(one.id);
      return { ok: false, text: `The call could not be placed: ${(err as Error).message}` };
    }
  };

  // ---------- friend calls the connector asks for: the owner's card first, the call only on their press ----------

  // What became of each request, for get_call (in memory: a restart forgets them, and the card the owner holds then answers "expired").
  const asks = new Map<string, { name: string; at: number; status: AskStatus; callId?: string; reason?: string }>();
  // No gap between asks: "no, tell her instead…" right after is a normal correction, and the newer card simply replaces the older one.
  const askSlots = createLimiter({ dailyCap: ASK_DAILY_CAP, minGapSeconds: 0, now: deps.now });

  /**
   * The connector's call_contact. The owner gets a card with who and every word (cleaned once and for all here, so placing the call later
   * changes none of it), and the call is placed only on their press, with the checks run again then. Nothing rings on the connector's say-so.
   */
  const askToCall = async (a: { name: string; message: string; language: "es" | "en"; direct: boolean; say?: string; on_behalf_of?: string }): Promise<{ ok: boolean; text: string }> => {
    const checked = checkFriend(a);
    if (!checked.ok) return checked;
    const { key, entry } = checked;
    // A call that would be refused on the press anyway gets no card: the caps are looked at now (without using them up).
    const capped = contacts.full() ?? (limiterFor(key).full() ? `${entry.name}: ${limiterFor(key).full()}` : null);
    if (capped) return { ok: false, text: capped };
    const pause = deps.control ? await deps.control.state() : null;
    if (deps.control && pause && pause.paused !== null) {
      // The same words and the same line in the owner's log as a call stopped at the last moment.
      const l = lang();
      deps.control.log("blocked", T(l)("logStopped", { who: entry.name, why: pauseLabel(pause.why, l) }));
      return { ok: false, text: `Nothing was asked or called: ${pausedText(pause.why, l)}` };
    }
    if (!deps.askOwner) {
      return { ok: false, text: `Calls to friends from the connector need ${config.ownerName}'s OK first, and this server has no way to ask (WhatsApp is not set up). Nothing was called.` };
    }
    const caller = config.ownerName;
    const message = callWords(a.message, caller);
    // Words that were only a greeting or "soy <owner>" are dropped: the opening already says whose assistant is calling.
    const say = a.say ? callWords(a.say, caller) : "";
    if (!message) return { ok: false, text: "The message is empty once cleaned (formatting, a greeting or the owner's own name are removed): say what the call is for." };
    const slot = askSlots.reserve();
    if (!slot.ok) return { ok: false, text: `Too many call requests: at most ${ASK_DAILY_CAP} cards to ${caller} in any 24 hours. Try again later.` };
    const id = `ask_${randomBytes(5).toString("hex")}`;
    let used = false;
    const ask: OwnerAsk = {
      name: entry.name,
      card: askCard({ name: entry.name, message, say, language: a.language, direct: a.direct }, lang()),
      place: async () => {
        const state = asks.get(id);
        if (used || (state && state.status !== "waiting")) return { ok: false, text: "This call request was already answered." };
        used = true;
        if (state) state.status = "approving";
        const r = await callContact({ name: entry.name, message, language: a.language, direct: a.direct, ...(say ? { say } : {}) });
        if (r.wait && r.wait * 1000 <= PENDING_CALL_MS - 30_000) {
          // Too soon after another friend call: nothing was used up. The owner gets a fresh card with its full minutes (src/whatsapp.ts), so this
          // request's clock starts again too, and get_call says "waiting" for as long as that card can be pressed.
          used = false;
          if (state) {
            state.status = "waiting";
            state.at = deps.now?.() ?? Date.now();
          }
          return r;
        }
        // A gap longer than a card lasts: the call is not placed, and the owner is told when to ask again (no fresh card that could not work).
        if (r.wait) {
          if (state) {
            state.status = "not_placed";
            state.reason = r.text;
          }
          return { ok: false, text: r.text, gap: r.wait };
        }
        const callId = /call_id=([A-Za-z0-9_-]+)/.exec(r.text)?.[1];
        if (state) {
          state.status = r.ok ? (callId?.startsWith("dryrun_") ? "dry_run" : "placed") : r.unknown ? "unknown" : "not_placed";
          if (callId) state.callId = callId;
          if (!r.ok) state.reason = r.text;
        }
        return r;
      },
      closed: (why) => {
        const state = asks.get(id);
        if (used || state?.status !== "waiting") return;
        if (why === "unshown") {
          state.status = "not_placed";
          state.reason = "After a wait for the gap between friend calls, the card could not be shown to the owner again.";
          return;
        }
        // Past its minutes it had expired already, whatever ended it later.
        state.status = (deps.now?.() ?? Date.now()) - state.at >= PENDING_CALL_MS ? "expired" : why;
      },
    };
    asks.set(id, { name: entry.name, at: deps.now?.() ?? Date.now(), status: "waiting" });
    while (asks.size > 30) asks.delete(asks.keys().next().value!);
    let sent: AskResult;
    try {
      sent = await deps.askOwner(ask);
    } catch (err) {
      sent = { ok: false, why: (err as Error).message };
    }
    if (!sent.ok) {
      // The record and the slot go only when nothing came of the card (a press can come before Meta's answer, and then it stays).
      const st = asks.get(id);
      if (!st || st.status === "waiting" || st.status === "stopped") {
        asks.delete(id);
        askSlots.release(slot.id);
      }
      logPersonalCaller.error(`call_contact: the owner could not be asked: ${sent.why}`);
      return { ok: false, text: `Nothing was called: ${caller} could not be asked. ${sent.why}` };
    }
    // Its minutes count from when the card was shown (the door's own clock starts a moment earlier): get_call never says "expired" while a
    // press could still place the call.
    const shownState = asks.get(id);
    if (shownState?.status === "waiting") shownState.at = deps.now?.() ?? Date.now();
    // Pressed already, or ended, while the card was on its way (a quick thumb): what happened is the answer, not "not called yet".
    const now2 = asks.get(id);
    if (now2 && now2.status !== "waiting") return { ok: true, text: `${askNote(now2.status, lang())} request_id=${id}: get_call with it says more.` };
    logPersonalCaller.info(`call_contact ${id}: ${entry.name}, waiting for the owner's press`);
    const minutes = Math.round(PENDING_CALL_MS / 60_000);
    return {
      ok: true,
      text: `Not called yet. ${caller} was asked ${sent.where}, with a card that shows who and every word the call would use: it rings only if they press ${buttonLabels(lang()).call} `
        + `within ${minutes} minutes. request_id=${id}: get_call with it says whether they approved and, once placed, how the call went. Do not ask again for the same call.`,
    };
  };

  /** What get_call says about one call, as text (the MCP tool and the voice line's tools). */
  const lookupCall = async (call_id: string): Promise<{ ok: boolean; text: string }> => {
    if (!CALL_ID.test(call_id)) return { ok: false, text: "call_id has an invalid format." };
    if (call_id.startsWith("ask_")) {
      const state = asks.get(call_id);
      if (!state) return { ok: false, text: "No call request with that id: it is not this server's, or the server restarted since (requests are kept in memory)." };
      const left = state.at + PENDING_CALL_MS - (deps.now?.() ?? Date.now());
      const status: AskStatus = state.status === "waiting" && left <= 0 ? "expired" : state.status;
      const out: Record<string, unknown> = { request_id: call_id, contact: state.name, status, note: askNote(status, lang()) };
      if (status === "waiting") out.expires_in_seconds = Math.ceil(left / 1000);
      if (state.reason) out.reason = state.reason;
      if (state.callId) {
        out.call_id = state.callId;
        const call = await lookupCall(state.callId);
        try {
          out.call = JSON.parse(call.text);
        } catch {
          /* not JSON: the text as it came */
          out.call = call.text;
        }
      }
      return { ok: true, text: JSON.stringify(out, null, 2) };
    }
    if (call_id.startsWith("dryrun_")) return { ok: true, text: JSON.stringify({ call_id, call_status: "dry_run", note: "Dry run: no real call was made." }, null, 2) };
    if (call_id.startsWith("lk_")) {
      let r;
      try {
        r = await voiceStack?.result(call_id);
      } catch (err) {
        logVoiceLab.warn(`the call reports could not be read: ${(err as Error).message}`);
        const note = "The store that keeps call reports did not answer. Ask again in a moment.";
        return { ok: true, text: JSON.stringify({ call_id, call_status: "lookup_failed", note }, null, 2) };
      }
      if (r) return { ok: true, text: JSON.stringify(r, null, 2) };
      if (voiceStack?.lost(call_id)) {
        const note = "No report of this call came, and none can still come: the call ended, or the main server restarted and had nowhere "
          + `to keep it. The server log line "voice result ${call_id}", if there is one, has its status, duration and opening line.`;
        return { ok: true, text: JSON.stringify({ call_id, call_status: "report_lost", note }, null, 2) };
      }
      const wait = { call_id, call_status: "ongoing_or_not_reported_yet", note: "The report arrives when the call ends. Ask again in a few seconds." };
      return { ok: true, text: JSON.stringify(wait, null, 2) };
    }
    try {
      const c = (await retellCall(f, retell.apiKey, "GET", `/v2/get-call/${encodeURIComponent(call_id)}`)) as RetellCall;
      // The Retell account also holds the restaurant calls of the product's customers: only this feature's own calls are readable here.
      if (c.metadata?.source !== "personal-caller") return { ok: false, text: "That call was not placed by this connector." };
      return { ok: true, text: JSON.stringify(summarizeCall(c), null, 2) };
    } catch (err) {
      return { ok: false, text: `The lookup failed: ${(err as Error).message}` };
    }
  };

  const tools = loadVoiceTools({
    memory,
    actions: {
      contacts: () => [...config.contacts.values()].map((c) => c.name),
      callContact: (a) => callContact(a),
      lookupCall: async (id) => (await lookupCall(id)).text,
    },
    lang,
  });

  const buildServer = (): McpServer => {
    const server = new McpServer({ name: "pako-assistant", title: "Pako Assistant", version: "1.0.0" });

    server.registerTool(
      "call_me",
      {
        title: "Call the owner",
        description:
          "Places a real phone call to the owner's own phone, from the owner's number, with a voice assistant that delivers the message. " +
          "Use it when something needs their attention by voice (an urgent result, a finished long task, a reminder). " +
          "The call can only go to the owner's number and is rate limited. Pass the exact thing to tell or ask, in the language the owner prefers.",
        inputSchema: {
          message: z
            .string()
            .trim()
            .max(1000)
            .optional()
            .describe(
              "What the assistant should say or ask when the owner picks up. Short and concrete. Leave it out when the owner just wants to talk: " +
                "the assistant then rings for an open conversation (own voice line only).",
            ),
          language: z.enum(["es", "en"]).default("en").describe("Accepted for older clients and ignored: the opening line is always English."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ message, language }) => {
        if (message !== undefined && !message.trim()) return fail("The message is empty. Leave it out to talk freely (own voice line), or say what to tell the owner.");
        if (!message && !useLivekit) return fail("An open conversation (no message) needs the owner's own voice line: set_engine livekit first, or pass a message.");
        const slot = owner.reserve();
        if (!slot.ok) return fail(slot.reason);
        try {
          const ownerVars = {
            call_kind: "owner",
            owner_name: config.ownerName,
            contact_name: config.ownerName,
            opening: buildOpening({ kind: "owner", language, ownerName: config.ownerName }),
            style: "normal",
            message: clean(message ?? ""),
          };
          const mode: OwnerMode = message ? { kind: "message", message: clean(message) } : { kind: "open", inbound: false };
          const call: { call_id: string; call_status?: string; done?: Promise<string | null> } = useLivekit
            ? await placeLivekit(config.ownerNumber, mode, language)
            : await place(config.ownerNumber, "owner", ownerVars);
          logPersonalCaller.info(`call_me ok call_id=${call.call_id} status=${call.call_status} live=${config.live}`);
          // The LiveKit worker may have to wake first: a start that fails there gives the owner's slot back.
          if (call.done) void call.done.then((why) => { if (why) owner.release(slot.id); });
          const wait = call.done ? " The voice server may need up to a minute to wake before the phone rings." : "";
          return text(`Call started: call_id=${call.call_id}, status=${call.call_status}.${wait} Use get_call with this call_id after about a minute for the outcome.`);
        } catch (err) {
          owner.release(slot.id);
          logPersonalCaller.error(`call_me failed: ${(err as Error).message}`);
          return fail(`The call could not be placed: ${(err as Error).message}`);
        }
      },
    );

    server.registerTool(
      "get_call",
      {
        title: "Get call outcome",
        description:
          "Looks up a call placed with call_me, or a friend call asked for with call_contact (by its request_id): whether the owner approved it, "
          + "then status, duration, why it ended, summary and transcript. The summary and transcript appear only after the call has ended.",
        inputSchema: { call_id: z.string().trim().describe("The call_id call_me returned, or the request_id call_contact returned.") },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ call_id }) => {
        const r = await lookupCall(call_id);
        return r.ok ? text(r.text) : fail(r.text);
      },
    );

    server.registerTool(
      "list_voices",
      {
        title: "List voices",
        description:
          "English-speaking voices the phone assistant can use, each with a link to hear it. " +
          "Use it, with set_voice and call_me, when the owner wants to choose or change how the assistant sounds.",
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async () => {
        if (!config.live) return text("Dry run: voices are listed and changed only when PERSONAL_LIVE=1.");
        try {
          const found = (await listVoiceChoices(retell.apiKey, f)).slice(0, 15);
          const voices: Record<string, unknown>[] = found.map((v) => ({
            voice_id: v.voice_id, name: v.voice_name ?? null, accent: v.accent ?? null, gender: v.gender ?? null, preview_audio_url: v.preview_audio_url ?? null,
          }));
          // The LiveKit engine speaks with Gemini's own voices: "gemini-<Name>" for set_voice.
          if (voiceStack) voices.push(...GEMINI_VOICES.map((g) => ({ voice_id: `gemini-${g}`, name: `${g} (Gemini Live, engine livekit)`, accent: null, gender: null, preview_audio_url: null })));
          return text(JSON.stringify(voices, null, 2));
        } catch (err) {
          return fail(`The voices could not be listed: ${(err as Error).message}`);
        }
      },
    );

    server.registerTool(
      "search_voice_library",
      {
        title: "Search the ElevenLabs voice library",
        description:
          "Searches ElevenLabs' public voice library (through Retell) for voices matching words such as 'conversational male' or 'warm British female'. " +
          "Each result has the ids add_voice needs. The accent comes from the voice itself, so search for the accent you want.",
        inputSchema: { query: z.string().trim().min(2).max(100).describe("What to look for, for example 'conversational male'.") },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ query }) => {
        if (!config.live) return text("Dry run: the voice library is searched only when PERSONAL_LIVE=1.");
        try {
          const found = await searchCommunityVoices(retell.apiKey, query, f);
          const rows = found.slice(0, 15).map((v) => ({
            provider_voice_id: v.provider_voice_id,
            public_user_id: v.public_user_id ?? null,
            name: v.name ?? null,
            description: shorten(v.description, 200),
          }));
          return text(JSON.stringify(rows, null, 2));
        } catch (err) {
          return fail(`The voice library could not be searched: ${(err as Error).message}`);
        }
      },
    );

    server.registerTool(
      "add_voice",
      {
        title: "Add a library voice to the assistant's voices",
        description:
          "Adds one ElevenLabs library voice found with search_voice_library to the Retell account, so list_voices shows it and set_voice can use it. " +
          "Copy provider_voice_id and public_user_id from the search result exactly. It does not change the voice in use.",
        inputSchema: {
          provider_voice_id: z.string().trim().regex(/^[\w-]{4,80}$/).describe("provider_voice_id from search_voice_library."),
          public_user_id: z.string().trim().regex(/^[\w-]{4,120}$/).optional().describe("public_user_id from search_voice_library."),
          name: z.string().trim().regex(/^[\p{L}\p{N} ._()-]{1,60}$/u).describe("A short name to list it under, for example Warm Hugo."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ provider_voice_id, public_user_id, name }) => {
        if (!config.live) return text("Dry run: voices are added only when PERSONAL_LIVE=1.");
        const slot = voiceChanges.reserve();
        if (!slot.ok) return fail(slot.reason);
        try {
          const v = await addCommunityVoice(retell.apiKey, { providerVoiceId: provider_voice_id, ...(public_user_id ? { publicUserId: public_user_id } : {}), name }, f);
          return text(`Added. voice_id=${v.voice_id}, name=${v.voice_name ?? name}, preview=${v.preview_audio_url ?? "none"}. Use set_voice with that voice_id.`);
        } catch (err) {
          voiceChanges.release(slot.id);
          return fail(`The voice could not be added: ${(err as Error).message}`);
        }
      },
    );

    server.registerTool(
      "set_voice",
      {
        title: "Set the assistant's voice",
        description:
          "Changes the voice the phone assistant uses from the next call on. Only a voice_id from list_voices works, " +
          "and while the engine is realtime only the openai- ones (use set_engine to go back to a Claude engine first). " +
          "Use it when the owner asks for a different voice; call_me then lets them hear it.",
        inputSchema: {
          voice_id: z.string().trim().min(3).max(80).describe("A voice_id from list_voices."),
          speech_model: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9_.-]{2,40}$/)
            .optional()
            .describe("Optional: the provider's speech model for this voice, for example eleven_v4_turbo or sonic-3.6. Default: the provider's newest conversational one."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async ({ voice_id, speech_model }) => {
        if (!config.live) return text("Dry run: voices are listed and changed only when PERSONAL_LIVE=1.");
        const gemini = /^gemini-(\w+)$/.exec(voice_id)?.[1];
        if (gemini) {
          const name = GEMINI_VOICES.find((g) => g.toLowerCase() === gemini.toLowerCase());
          if (!voiceStack || !name) return fail(voiceStack ? "That is not a Gemini Live voice. Use list_voices." : "The livekit engine is not set up on the server.");
          voiceStack.voice = name;
          return text(`Gemini voice set to ${name}. The next call with the livekit engine uses it.`);
        }
        const slot = voiceChanges.reserve();
        if (!slot.ok) return fail(slot.reason);
        try {
          const voice = (await listVoiceChoices(retell.apiKey, f)).find((v) => v.voice_id === voice_id);
          if (!voice) {
            voiceChanges.release(slot.id);
            return fail("That is not one of the listed voices. Use list_voices.");
          }
          const done = await sync({ voiceId: voice.voice_id, ...(speech_model ? { voiceModel: speech_model } : {}) });
          return text(`Voice set to ${voice.voice_name ?? voice.voice_id}. The next call uses it.${done.notes.length ? ` ${done.notes.join(" ")}` : ""}`);
        } catch (err) {
          voiceChanges.release(slot.id);
          return fail(`The voice could not be changed: ${(err as Error).message}`);
        }
      },
    );

    server.registerTool(
      "set_engine",
      {
        title: "Set the assistant's engine",
        description:
          "Chooses what thinks and speaks for the assistant from the next call on: 'claude-haiku' (fastest), 'claude-sonnet' or 'claude-opus' (smarter, slower) " +
          "write the words that the voice from set_voice reads out; 'realtime' and 'realtime-mini' are OpenAI speech-to-speech models that hear and speak themselves " +
          "(more natural and quicker to answer, but not Claude, and they speak only with OpenAI voices: the voice becomes openai-Santiago by itself); " +
          "'gpt-sol' is the fastest, dearest text brain Retell has (not Claude, ultrafast tier) with the chosen voice; " +
          "'grok-voice' is xAI's speech-to-speech model (lists es-ES; the voice that suits it may need trying); " +
          "'gpt-live' is OpenAI's newest full-duplex model (it listens and speaks at once, with a Claude model behind it for the end of the call; also OpenAI voices); " +
          "'livekit' is the owner's own voice stack: Gemini Live speaks straight over the owner's SIP number from a European server " +
          "(calls to the owner only; friends are still called by the Retell agent). " +
          "Use it when the owner wants it to sound more human, answer faster or think better; call_me then lets them hear it.",
        inputSchema: { engine: z.enum(["claude-haiku", "claude-sonnet", "claude-opus", "realtime", "realtime-mini", "gpt-live", "grok-voice", "gpt-sol", "livekit"]).describe("The engine to use.") },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async ({ engine }) => {
        if (!config.live) return text("Dry run: the engine is changed only when PERSONAL_LIVE=1.");
        if (engine === "livekit") {
          if (!voiceStack) return fail("The livekit engine is not set up on the server (LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are missing).");
          useLivekit = true;
          return text(`Engine set to livekit (Gemini ${voiceStack.model}, voice ${voiceStack.voice}). Calls to the owner use it from the next call; calls to friends still use the Retell agent.`);
        }
        const slot = voiceChanges.reserve();
        if (!slot.ok) return fail(slot.reason);
        try {
          const done = await sync({ engine });
          useLivekit = false;
          return text(`Engine set to ${engine}. The next call uses it.${done.notes.length ? ` ${done.notes.join(" ")}` : ""}`);
        } catch (err) {
          voiceChanges.release(slot.id);
          return fail(`The engine could not be changed: ${(err as Error).message}`);
        }
      },
    );

    if (config.contacts.size > 0) {
      server.registerTool(
        "list_contacts",
        {
          title: "List callable contacts",
          description: "The names of the friends the owner has approved for phone calls. Numbers are never shown. Only these people can be called with call_contact.",
          inputSchema: {},
          annotations: { readOnlyHint: true },
        },
        async () => text(`Callable contacts: ${[...config.contacts.values()].map((c) => c.name).join(", ")}`),
      );

      server.registerTool(
        "call_contact",
        {
          title: "Call a friend",
          description:
            "Asks the owner to approve a phone call to one of their approved friends, made by a voice assistant on the owner's behalf. " +
            "Nothing rings on this tool alone: the owner gets a card (on WhatsApp, Telegram, or in Pako's panel) that shows who and every word, and the call " +
            `is placed only if they press ${buttonLabels(lang()).call} on it within 5 minutes. ` +
            "Use ONLY when the owner explicitly asked, in this conversation, to call that specific person; never on your own initiative. " +
            "The call opens by saying it is the owner's AI assistant calling for them. Set direct=true when the owner wants no questions and the message said fast. " +
            "Only names from list_contacts work; phone numbers cannot be passed. Friends are not called during quiet hours, and calls are rate limited per person. " +
            "Returns a request_id: get_call with it says whether the owner approved and how the call went.",
          inputSchema: {
            name: z.string().trim().min(1).max(40).describe("The contact's name as in list_contacts (not case-sensitive)."),
            message: z.string().trim().min(1).max(600).describe("Why the owner is calling and what to say or ask. Short, concrete and friendly. No secrets or sensitive data."),
            language: z.enum(["es", "en"]).default("en").describe("Accepted for older clients and ignored: the opening line is always English."),
            // A client that cached the older tool list sends this as the text "true": accept both.
            direct: z
              .union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")])
              .default(false)
              .describe("True when the owner wants no questions and the message said at once: the opening asks nothing and the assistant delivers the message right after the greeting."),
            say: z
              .string()
              .trim()
              .min(1)
              .max(160)
              .optional()
              .describe(
                "The exact words to say in the opening, right after the greeting (for example the joke or the news), so the person hears the message before they can hang up. " +
                  "Written as it is spoken, to the contact. Implies direct.",
              ),
            on_behalf_of: z
              .string()
              .trim()
              .regex(/^[\p{L}\p{N} .'-]{1,40}$/u, "A first name, letters only")
              .optional()
              .describe("Not used: every call is made in the owner's name. Naming anyone else is refused."),
          },
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        async ({ name, message, language, direct, say, on_behalf_of }) => {
          const r = await askToCall({ name, message, language, direct, say, on_behalf_of });
          return r.ok ? text(r.text) : fail(r.text);
        },
      );
    }
    deps.extraTools?.(server);
    return server;
  };

  return { buildServer, limiters: { owner, contacts }, voice: voiceStack, agentId, sync, tools, memory, ownerSession };
}

// ---------- HTTP ----------

export interface MountOptions extends PersonalDeps {
  /** Where the notes and call results are kept: the server's own store (a file in local mode). Without it, VOICE_RESULTS_URL. */
  kv?: Kv | null;
  /** The existing admin checks of http.ts: the admin key, and its failed-attempt limiter. */
  adminOnly: (req: Request, res: Response) => boolean;
  adminLimiter: RequestHandler;
  /** Local mode: the terminal shows the newcomer's banner only, not a server's status lines about a phone line nobody set up. */
  quiet?: boolean;
}

const rpcError = (res: Response, status: number, code: number, message: string) => res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });

/**
 * POST /personal/<token>: the stateless MCP endpoint for the owner's connector (a wrong token is a plain 404, like no
 * route at all). Admin routes, behind the admin key: voices, agent-sync (create or update the personal agent), status.
 */
export function mountPersonalCaller(app: Express, o: MountOptions): PersonalCaller {
  // Live needs the server's Retell key and number; without them it stays a dry run, never a half-live feature.
  const creds = !!(o.retell.apiKey && o.retell.fromNumber);
  if (o.config.live && !creds) logPersonalCaller.error("PERSONAL_LIVE=1 but RETELL_API_KEY or RETELL_FROM_NUMBER is missing: staying in dry run.");
  const config = o.config.live && !creds ? { ...o.config, live: false } : o.config;
  const kv = o.kv !== undefined ? o.kv : loadKv(process.env.VOICE_RESULTS_URL);
  const voice = o.voice === undefined ? loadVoiceBridge(process.env, { kv }) : o.voice;
  const caller = createPersonalCaller({
    ...o,
    config,
    voice,
    memory: o.memory ?? loadMemory(kv),
    livekitDefault: o.livekitDefault ?? process.env.PERSONAL_ENGINE === "livekit",
  });
  const f = o.fetch ?? fetch;
  const digest = createHash("sha256").update(config.token).digest();

  const failed = rateLimit({
    windowMs: 15 * 60_000,
    limit: 30,
    skipSuccessfulRequests: true,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).type("text").send("Too many attempts.");
    },
  });
  // The worker's routes (results, tools, inbound): only a refused SIGNATURE (401) counts as a failed attempt. A stranger ringing the SIP number
  // gets a 403 from /inbound, and thirty of those must not lock the owner's own calls and the call reports out for a quarter of an hour.
  const workerFailed = rateLimit({
    windowMs: 15 * 60_000,
    limit: 30,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) => res.statusCode !== 401,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).type("text").send("Too many attempts.");
    },
  });
  const gate: RequestHandler = (req, res, next) => {
    const given = createHash("sha256").update(String(req.params.token ?? "")).digest();
    if (!timingSafeEqual(given, digest)) {
      res.status(404).type("text").send("Not found");
      return;
    }
    res.set("Cache-Control", "no-store");
    next();
  };
  const body: RequestHandler = (req, res, next) => {
    express.json({ limit: "64kb" })(req, res, (err?: unknown) => {
      if (!err) return next();
      const tooLarge = (err as { type?: string }).type === "entity.too.large";
      rpcError(res, tooLarge ? 413 : 400, tooLarge ? -32600 : -32700, tooLarge ? "Request too large" : "Parse error");
    });
  };

  app.post("/personal/:token", failed, gate, body, async (req, res) => {
    const server = caller.buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logPersonalCaller.error(`request failed: ${(err as Error).stack ?? err}`);
      if (!res.headersSent) rpcError(res, 500, -32603, "Internal error");
    }
  });
  app.all("/personal/:token", failed, gate, (_req, res) => {
    res.status(405).set("Allow", "POST").type("text").send("Method not allowed");
  });

  // The LiveKit worker reports each call here when it ends, signed with the LiveKit API secret.
  app.post("/personal-voice/result", workerFailed, express.text({ type: "*/*", limit: "64kb" }), async (req, res) => {
    const raw = typeof req.body === "string" ? req.body : "";
    if (!voice || !voice.verify(raw, req.get("x-voice-signature"))) {
      res.status(401).type("text").send("Unauthorized");
      return;
    }
    const result = parseResult(raw);
    if (!result) {
      res.status(400).type("text").send("Bad result");
      return;
    }
    await voice.record(result);
    // The log keeps what memory loses on a restart: whether the AI line was said (and the words), and how fast the replies came.
    const opening = (/^Agent: (.*)$/m.exec(result.transcript)?.[1] ?? "").slice(0, 140);
    const e2e = result.latency_ms ? `, e2e p50=${result.latency_ms.e2e.p50}ms p90=${result.latency_ms.e2e.p90}ms n=${result.latency_ms.e2e.n}` : "";
    const t = result.talk;
    const talk = t
      ? `, words p50=${t.words_per_turn?.p50 ?? "-"} max=${t.words_per_turn?.max ?? "-"}, cut off ${t.interruptions}x`
        + ` (stop p50=${t.barge_in_stop_ms?.p50 ?? "-"}ms), talked over ${t.talked_over}x, started over ${t.started_over ?? "-"}x`
      : "";
    const head = `${result.call_status}, ${result.duration_seconds}s, ${result.disconnection_reason || "?"}, ${result.voice || "?"}${e2e}${talk}`;
    logPersonalCaller.info(`voice result ${result.call_id}: ${head}, ai_disclosed=${result.disclosed_ai}, opening=${JSON.stringify(opening)}`);
    res.status(204).end();
    // Every LiveKit call is on the owner's own line (friends are called through Retell): the worker's one-line summary of it goes into the
    // owner memory. Only for a verified call: one that was not (caller ID alone) never writes to the owner's memory. The worker echoes the
    // trust decision the server put in the dispatch (it survives a restart of this server, the live-call map does not).
    if (result.summary && (result.trusted ?? voice?.trusted(result.call_id))) {
      void caller.memory.addCall(result.summary).catch((err) => logPersonalCaller.error(`call summary not saved: ${(err as Error).message}`));
    }
  });

  // Requests from the worker that are not results (tool calls, inbound sessions): signed under their own key, fresh, used once.
  const seen = new Map<string, number>();
  const signedBody = (req: Request): Record<string, unknown> | string => {
    const raw = typeof req.body === "string" ? req.body : "";
    if (!voice || !voice.verifyAsk(raw, req.get("x-voice-signature"))) return "Unauthorized";
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* not JSON: refused */
      return "Bad request";
    }
    const ts = typeof j.ts === "number" ? j.ts : 0;
    const nonce = typeof j.nonce === "string" ? j.nonce : "";
    const now = Date.now();
    for (const [n, exp] of seen) if (exp < now) seen.delete(n);
    if (Math.abs(now - ts) > 60_000 || !/^[\w-]{12,64}$/.test(nonce) || seen.has(nonce)) return "Stale";
    seen.set(nonce, now + 120_000);
    return j;
  };
  const str = (j: Record<string, unknown>, k: string, max: number) => (typeof j[k] === "string" ? (j[k] as string).slice(0, max) : "");

  // A tool of the voice line: the worker passes the tool the live voice chose and its arguments; this server runs it (see voice-tools.ts).
  // At most 40 per call and 300 a day: a call that loops, or one that got through on a faked caller ID, cannot hammer the server.
  const askCounts = new Map<string, { n: number; at: number }>();
  // Verified and unverified calls have their own daily budgets: a faked caller ID cannot use up the owner's.
  const askDaily = createLimiter({ dailyCap: 300, minGapSeconds: 0 });
  const askDailyUnverified = createLimiter({ dailyCap: 60, minGapSeconds: 0 });
  app.post("/personal-voice/tool", workerFailed, express.text({ type: "*/*", limit: "32kb" }), async (req, res) => {
    const j = signedBody(req);
    if (typeof j === "string") {
      res.status(j === "Unauthorized" ? 401 : 400).type("text").send(j);
      return;
    }
    const callId = str(j, "call_id", 80);
    const live = voice!.liveCall(callId, str(j, "token", 100));
    if (!live) {
      res.status(403).type("text").send("No such live call");
      return;
    }
    const now = Date.now();
    for (const [id, c] of askCounts) if (now - c.at > 30 * 60_000) askCounts.delete(id);
    const count = askCounts.get(callId) ?? { n: 0, at: now };
    count.n++;
    askCounts.set(callId, count);
    // The per-call cap first, so a call stuck in a loop does not drain the daily budget either.
    const slot = count.n > 40 ? undefined : (live.trusted ? askDaily : askDailyUnverified).reserve();
    if (!slot?.ok) {
      res.json({ say: "That's enough lookups for today.", verbatim: true });
      return;
    }
    const args = j.args && typeof j.args === "object" && !Array.isArray(j.args) ? (j.args as Record<string, unknown>) : {};
    try {
      const answer = await caller.tools.run({
        callId,
        tool: str(j, "tool", 40),
        args,
        readbackText: typeof j.readback_text === "string" ? j.readback_text.slice(0, 800) : undefined,
        answerText: typeof j.answer_text === "string" ? j.answer_text.slice(0, 300) : undefined,
        trusted: live.trusted,
      });
      res.json(answer);
    } catch (err) {
      logPersonalCaller.error(`tool ${str(j, "tool", 40)} ${callId} failed: ${(err as Error).message}`);
      res.json({ say: "That did not work just now (the notes store did not answer). Tell them briefly and offer to try again.", verbatim: false });
    }
  });

  // The owner rang the assistant (LiveKit inbound trunk): the worker asks here whether to take the call, and how.
  const ownerDigits = config.ownerNumber.replace(/\D/g, "");
  // The caller ID may come with the country code (+34...), with 00 in front, or as a national number: the whole number must be the owner's, and a
  // shorter one only counts when it is the end of it. Another country's number with the same last nine digits is not the owner.
  const isOwnerNumber = (raw: string): boolean => {
    const from = raw.replace(/\D/g, "").replace(/^00/, "");
    return from === ownerDigits || (from.length >= 8 && from.length < ownerDigits.length && ownerDigits.endsWith(from));
  };
  // A 20-minute live session costs money and caller ID can be faked: at most 30 inbound calls a day.
  const inboundStarts = createLimiter({ dailyCap: 30, minGapSeconds: 0 });
  app.post("/personal-voice/inbound", workerFailed, express.text({ type: "*/*", limit: "8kb" }), async (req, res) => {
    const j = signedBody(req);
    if (typeof j === "string") {
      res.status(j === "Unauthorized" ? 401 : 400).type("text").send(j);
      return;
    }
    const from = str(j, "from", 40).replace(/\D/g, "");
    if (!voice || !ownerDigits || !isOwnerNumber(from)) {
      logPersonalCaller.info(`inbound call refused: caller ...${from.slice(-3)} is not the owner`);
      res.status(403).type("text").send("Not the owner");
      return;
    }
    const slot = inboundStarts.reserve();
    if (!slot.ok) {
      logPersonalCaller.info(`inbound call refused: ${slot.reason}`);
      res.status(429).type("text").send(slot.reason);
      return;
    }
    // Caller ID can be faked: notes, contacts, calls and memory only when the dispatch rule made the caller type the PIN before the call got through.
    const verified = j.pin_checked === true;
    try {
      const s = await caller.ownerSession({ kind: "open", inbound: true }, "es", { verified });
      const meta = voice.inbound({ participant: str(j, "participant", 120), ...s, trusted: verified, delegate: true });
      logPersonalCaller.info(`inbound call accepted: ${meta.call_id} pin_checked=${verified}`);
      res.json(meta);
    } catch (err) {
      inboundStarts.release(slot.id);
      logPersonalCaller.error(`inbound call failed: ${(err as Error).message}`);
      res.status(500).type("text").send("Could not start the session");
    }
  });

  // The voice lab: talk to the assistant from the browser, no phone line in between.
  const labStarts = createLimiter({ dailyCap: 60, minGapSeconds: 5 });
  app.get("/admin/voice-lab", o.adminLimiter, (req, res) => {
    if (!o.adminOnly(req, res)) return;
    if (!voice) {
      res.status(404).type("text").send("The LiveKit voice stack is not configured (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET).");
      return;
    }
    const nonce = randomBytes(16).toString("base64");
    res.set("Content-Security-Policy", voiceLabCsp(nonce, voice.livekitUrl));
    res.type("html").send(voiceLabPage(nonce, GEMINI_VOICES, voice.voice));
  });
  app.post("/admin/voice-lab/session", o.adminLimiter, express.json({ limit: "1kb" }), async (req, res) => {
    if (!o.adminOnly(req, res)) return;
    if (req.get("x-admin-action") !== "voice-lab") {
      res.status(400).type("text").send('Send the header "X-Admin-Action: voice-lab".');
      return;
    }
    if (!voice) {
      res.status(409).type("text").send("The LiveKit voice stack is not configured.");
      return;
    }
    const slot = labStarts.reserve();
    if (!slot.ok) {
      res.status(429).type("text").send(slot.reason);
      return;
    }
    try {
      const s = await caller.ownerSession({ kind: "open", inbound: false });
      const lab = await voice.lab({ ...s, voice: typeof req.body?.voice === "string" ? req.body.voice : undefined, delegate: true });
      void lab.done.then((why) => why && logVoiceLab.error(`${lab.call_id}: ${why}`));
      res.json({ url: lab.url, token: lab.token, call_id: lab.call_id });
    } catch (err) {
      labStarts.release(slot.id);
      res.status(500).type("text").send((err as Error).message.slice(0, 200));
    }
  });

  const apiKey = o.retell.apiKey;
  app.get("/admin/personal-caller/status", o.adminLimiter, async (req, res) => {
    if (!o.adminOnly(req, res)) return;
    let agent = config.agentId || "";
    let agentNote: string | undefined;
    if (!agent && apiKey) {
      try {
        agent = (await findPersonalAgent(apiKey, f)) ?? "";
      } catch (err) {
        agentNote = `Could not look the agent up: ${(err as Error).message}`;
      }
    }
    res.json({
      live: config.live,
      retellKeyAndNumberSet: !!(apiKey && o.retell.fromNumber),
      agent: agent || "not created yet: POST /admin/personal-caller/agent-sync",
      ...(agentNote ? { agentNote } : {}),
      contacts: [...config.contacts.values()].map((c) => c.name),
      quietHours: config.quiet ? `${config.quiet.label} ${config.quiet.timeZone}` : "off",
      callsInLast24h: { owner: caller.limiters.owner.used(), friends: caller.limiters.contacts.used() },
      caps: { owner: config.dailyCap, friends: config.contactDailyCap, perFriend: config.perContactDailyCap, minGapSeconds: config.minGapSeconds },
    });
  });

  app.get("/admin/personal-caller/voices", o.adminLimiter, async (req, res) => {
    if (!o.adminOnly(req, res)) return;
    if (!apiKey) {
      res.status(409).json({ error: "RETELL_API_KEY is not set." });
      return;
    }
    try {
      res.json({ note: "Open preview_audio_url to listen. Choose one with POST /admin/personal-caller/agent-sync {\"voiceId\":\"...\"}.", voices: await listVoiceChoices(apiKey, f) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.post("/admin/personal-caller/agent-sync", o.adminLimiter, express.json({ limit: "2kb" }), async (req, res) => {
    if (!o.adminOnly(req, res)) return;
    if (req.get("x-admin-action") !== "personal-agent-sync") {
      res.status(400).type("text").send('Send the header "X-Admin-Action: personal-agent-sync".');
      return;
    }
    if (!apiKey) {
      res.status(409).json({ error: "RETELL_API_KEY is not set." });
      return;
    }
    const pick = (v: unknown, re: RegExp): string | undefined => (typeof v === "string" && re.test(v) ? v : undefined);
    const voiceId = pick(req.body?.voiceId, /^[A-Za-z0-9_.-]{3,80}$/);
    const voiceModel = pick(req.body?.voiceModel, /^[A-Za-z0-9_.-]{2,40}$/);
    const model = pick(req.body?.model, /^[A-Za-z0-9_.-]{3,60}$/);
    const engine = pick(req.body?.engine, /^(claude-haiku|claude-sonnet|claude-opus|realtime|realtime-mini|gpt-live|grok-voice|gpt-sol)$/) as PersonalEngine | undefined;
    const given: [unknown, unknown][] = [[req.body?.voiceId, voiceId], [req.body?.voiceModel, voiceModel], [req.body?.model, model], [req.body?.engine, engine]];
    if (given.some(([asked, valid]) => asked !== undefined && !valid)) {
      res.status(400).json({
        error:
          "voiceId, voiceModel and model must be plain ids (letters, digits, - _ .); " +
          "engine is claude-haiku, claude-sonnet, claude-opus, realtime, realtime-mini, gpt-live, grok-voice or gpt-sol.",
      });
      return;
    }
    try {
      const result = await caller.sync({ voiceId, voiceModel, model, engine });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  if (!o.quiet) logPersonalCaller.info(`ON: live=${config.live}, contacts=${config.contacts.size}, quiet=${config.quiet?.label ?? "off"}`);
  return caller;
}
