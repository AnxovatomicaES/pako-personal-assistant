// The assistant's own email inbox, at AgentMail (https://docs.agentmail.to). It reads it; it sends only the one kind of email the owner approved
// with a button (a table request to a restaurant, src/booking.ts), through sendEmail below.
//
// An email arrives as AgentMail's signed `message.received` webhook (POST /email/webhook, Svix signature). Spam, blocked and unauthenticated mail
// never comes as that event, and anything labelled so is dropped here too. Each new email goes into the owner's assistant inbox (src/whatsapp.ts),
// where the Mac summarizes it in a run with no tools and no tags (assistant/bridge.ts) and the owner gets the summary on WhatsApp. A safety net
// lists the inbox every few minutes, because AgentMail gives up on a webhook after about a day of failed attempts and disables it after five days.
//
// An email is a stranger's text: it is passed on as information, never acted on. A one-time code in it (a sign-in or verification code) is
// taken out before anything keeps, logs or passes the email on (src/codes.ts): the owner sees it only by asking (CODE).
//
// The owner's own mailbox, read only by IMAP (src/imap.ts), goes through the same intake (takeMail) into the same mailbox state.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { createCodeVault, hideCodes } from "./codes.ts";
import {
  CATEGORIES, CATEGORY_LABEL, categoryOf, cleanMessageId, notifyPrefsOf, preClassify, providerOf, rulesOf, RULES_MAX, senderAddress,
  shouldNotify, trustedSender, type MailAction, type MailCategory, type MailProvider, type NotifyKey, type NotifyPrefs, type SenderRule, type Verdict,
} from "./mail-categories.ts";
import type { Control } from "./control.ts";
import { english, locale, texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import type { Inbound } from "./whatsapp.ts";
import type { HealthReport } from "./watchdog.ts";
import { createLog } from "./log.ts";

const log = createLog("mail");

type Env = Record<string, string | undefined>;

/**
 * What the owner reads about their mail (MAIL, the morning brief, the panel's log) and the lines the assistant's context gets. The brief
 * names the command as HELP does: MAIL (src/whatsapp.ts).
 */
const T = texts(
  {
    unknownSender: "(unknown sender)",
    from: "from {from}",
    subject: " “{subject}”",
    work: "[work] ",
    personal: "[personal] ",
    bulkCount: "and {n} bulk email(s) in the last 24 h (newsletters, offers, notifications)",
    none: "📭 No email in the last 24 hours.",
    head: "📥 Email in the last 24 h: {n}.",
    group: "{label} ({n}):",
    senders: "{label} ({n}): {senders}",
    logBulk: "Email kept in {label}: {from}{subject}",
    logMail: "Email from {from}{subject}",
    brief: "📧 Email (24 h): {total} ({parts}). Type MAIL to see them.",
  },
);

export interface MailConfig {
  apiKey: string;
  /** AgentMail's inbox id: the address in AgentMail's examples (`name@agentmail.to`). */
  inbox: string;
  /** The webhook's signing secret, `whsec_` and base64. */
  webhookSecret: string;
  /** Minutes between the safety-net listings of the inbox; 0 = none. */
  pollMinutes: number;
  /** Domains of the owner's work mail (a forwarded email to one of them is marked as work). */
  workDomains: string[];
  /** Senders whose mail always reaches the owner at once (an address, or @domain). */
  vip: string[];
  /**
   * MAIL_SHOW_CODES=1: one-time codes stay in the emails' words, as before (they are still kept for CODE). Off (the default), they are
   * hidden. The mailbox does it (createMailbox), so the summaries the Mac writes later are covered too.
   */
  showCodes?: boolean;
}

const API = "https://api.agentmail.to/v0";

/** Off (null) unless the three AgentMail values are set; a wrong one is reported and keeps it off, without stopping the server. */
export function loadMailConfig(env: Env): { config: MailConfig | null; problems: string[] } {
  const apiKey = (env.AGENTMAIL_API_KEY ?? "").trim();
  const inbox = (env.AGENTMAIL_INBOX ?? "").trim();
  const webhookSecret = (env.AGENTMAIL_WEBHOOK_SECRET ?? "").trim();
  if (!apiKey && !inbox && !webhookSecret) return { config: null, problems: [] };
  const problems: string[] = [];
  if (!/^[A-Za-z0-9_.:-]{16,200}$/.test(apiKey)) problems.push("AGENTMAIL_API_KEY must be the API key from AgentMail's console");
  if (!/^[A-Za-z0-9_.+@-]{3,200}$/.test(inbox)) problems.push("AGENTMAIL_INBOX must be the inbox id (its address, for example name@agentmail.to)");
  const rawPoll = (env.AGENTMAIL_POLL_MINUTES ?? "").trim();
  const pollMinutes = rawPoll === "" ? 10 : Number(rawPoll);
  // The webhook needs a public address (a computer at home has none): without its secret the inbox is only listed every few minutes, which needs no webhook.
  if (webhookSecret ? !/^whsec_[A-Za-z0-9+/=]{16,}$/.test(webhookSecret) : !(pollMinutes > 0)) {
    problems.push(
      "AGENTMAIL_WEBHOOK_SECRET must be the webhook's signing secret (it starts with whsec_); "
      + "leave it out only if AGENTMAIL_POLL_MINUTES is above 0 (the inbox is then only listed, no webhook)",
    );
  }
  if (!Number.isInteger(pollMinutes) || pollMinutes < 0 || pollMinutes > 1440) problems.push("AGENTMAIL_POLL_MINUTES must be a whole number from 0 to 1440");
  const filters = loadMailFilters(env);
  problems.push(...filters.problems);
  const { workDomains, vip, showCodes } = filters;
  return problems.length ? { config: null, problems } : { config: { apiKey, inbox, webhookSecret, pollMinutes, workDomains, vip, showCodes }, problems };
}

/**
 * The settings every mailbox Pako reads shares (AgentMail's and the owner's own by IMAP, src/imap.ts): the work domains, the VIP senders and
 * whether codes stay visible. Their names keep AGENTMAIL_ because they came first with that inbox and servers already set them so.
 */
export function loadMailFilters(env: Env): { workDomains: string[]; vip: string[]; showCodes: boolean; problems: string[] } {
  const problems: string[] = [];
  const list = (raw: string | undefined, fallback: string) =>
    (raw ?? fallback).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 50);
  const workDomains = list(env.AGENTMAIL_WORK_DOMAINS, "").map((x) => x.replace(/^@/, ""));
  const vip = list(env.AGENTMAIL_VIP, "");
  if (workDomains.some((x) => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(x))) problems.push("AGENTMAIL_WORK_DOMAINS must be a comma list of domains, for example example.com");
  if (vip.some((x) => !/^([^\s@,]+)?@[a-z0-9.-]+\.[a-z]{2,}$/.test(x))) problems.push("AGENTMAIL_VIP must be a comma list of addresses or @domains");
  // Anything but 1 hides the codes: a mistyped value must not put them back on the lock screen.
  const showCodes = (env.MAIL_SHOW_CODES ?? "").trim() === "1";
  return { workDomains, vip, showCodes, problems };
}

/** Svix's scheme, which AgentMail uses: HMAC-SHA256 of `id.timestamp.body` with the secret's base64 bytes, any of the `v1,` signatures matching. */
export function verifySvix(secret: string, headers: { id?: string; timestamp?: string; signature?: string }, body: Buffer, nowMs: number, toleranceS = 300): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > toleranceS) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  if (!key.length) return false;
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.`).update(body).digest();
  return signature.split(" ").some((part) => {
    const [version, sig] = part.split(",", 2);
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** What AgentMail sends and lists (only the fields used here; any may be missing in a list item). */
export interface AgentMailMessage {
  inbox_id?: string;
  message_id?: string;
  labels?: string[];
  timestamp?: string;
  created_at?: string;
  from?: string;
  to?: string[];
  subject?: string;
  preview?: string;
  text?: string;
  html?: string;
  extracted_text?: string;
  attachments?: { filename?: string; size?: number }[];
  body_url?: string;
  /** The email's headers, as AgentMail gives them (a name to value map, or a list of name and value). */
  headers?: unknown;
}

/** The values of the headers with these names (any case), whatever shape AgentMail gives them in. */
export function headerValues(m: AgentMailMessage, names: string[]): string[] {
  const want = new Set(names.map((n) => n.toLowerCase()));
  const out: string[] = [];
  const add = (name: unknown, value: unknown) => {
    if (typeof name !== "string" || !want.has(name.toLowerCase())) return;
    for (const v of Array.isArray(value) ? value : [value]) if (typeof v === "string") out.push(v);
  };
  if (Array.isArray(m.headers)) for (const h of m.headers) add((h as { name?: unknown })?.name, (h as { value?: unknown })?.value);
  else if (m.headers && typeof m.headers === "object") for (const [k, v] of Object.entries(m.headers)) add(k, v);
  return out;
}

/** Mail sent to many at once (newsletters, offers, notifications): it says so in its headers. Codes and alerts usually do not. */
export function isBulk(m: AgentMailMessage): boolean {
  if (headerValues(m, ["list-unsubscribe", "list-id"]).length) return true;
  return headerValues(m, ["precedence"]).some((v) => /\b(bulk|list|junk)\b/i.test(v));
}

/** The address of a From header: the LAST <...> pair (the display name comes first and may itself look like an address: "<ceo@x>" <evil@y>). */
export const addressOf = (s: string): string => ([...s.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)].at(-1)?.[1] ?? s.trim()).toLowerCase();

/**
 * The same email whichever way it came (forwarded to Pako's inbox, read from the owner's mailbox by IMAP): its Message-ID and its sender's
 * address, so a stranger who copies another email's Message-ID cannot hide that email. "" when it has no Message-ID.
 */
export function sameMailKey(m: AgentMailMessage): string {
  const mid = (headerValues(m, ["message-id"])[0] ?? "").replace(/\s+/g, "").replace(/^<|>$/g, "").toLowerCase().slice(0, 500);
  const from = addressOf(String(m.from ?? ""));
  return mid && from ? `mid:${createHash("sha256").update(`${mid}\n${from}`).digest("hex").slice(0, 32)}` : "";
}

/** Whose mail it is: forwarded from the owner's work address, from a personal one, or written straight to the assistant. */
export function accountOf(m: AgentMailMessage, c: Pick<MailConfig, "inbox" | "workDomains">): MailAccount {
  const to = [...headerValues(m, ["delivered-to", "x-forwarded-to", "x-original-to", "to", "cc"]), ...(m.to ?? [])].map((t) => String(t).toLowerCase());
  if (to.some((t) => c.workDomains.some((d) => t.includes(`@${d}`)))) return "trabajo";
  const own = c.inbox.toLowerCase();
  return to.some((t) => /@/.test(t) && !t.includes(own)) ? "personal" : "directo";
}

export function isVip(from: string, vip: string[]): boolean {
  const a = addressOf(from);
  return vip.some((v) => (v.startsWith("@") ? a.endsWith(v) : a === v));
}

export type MailAccount = "trabajo" | "personal" | "directo";

const DROP_LABELS = new Set(["spam", "blocked", "unauthenticated", "trash", "agent-armor-held"]);
const TEXT_MAX = 12_000;
const RECENT_KEEP = 150;
const RECENT_SHOW = 15;
const SEEN_KEEP = 300;
const STATE_KEY = "assistant-mail";
const STATE_TTL_S = 60 * 24 * 3600;
/** The owner's mail choices: the sender rules taught by Move to…, and the notification switches. Kept long: they are the owner's own. */
export const PREFS_KEY = "mail-prefs";
const PREFS_TTL_S = 5 * 365 * 24 * 3600;
/** One key per email for its words (codes already hidden), for the panel's reader: kept as long as the mailbox state keeps the email. */
const bodyKey = (id: string): string => `assistant-mail-body:${id}`;
const BODY_MAX = 12_000;

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", euro: "€", pound: "£", copy: "©", hellip: "…", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", ntilde: "ñ", Ntilde: "Ñ", uuml: "ü", Uuml: "Ü",
  agrave: "à", egrave: "è", ograve: "ò", ccedil: "ç", Ccedil: "Ç", iexcl: "¡", iquest: "¿", laquo: "«", raquo: "»",
};
/** Entities decoded once, in one pass: `&amp;lt;` stays the text "&lt;" instead of becoming "<". */
const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (all, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 && !(n >= 0xd800 && n < 0xe000) ? String.fromCodePoint(n) : " ";
    }
    return NAMED_ENTITIES[e] ?? NAMED_ENTITIES[e.toLowerCase()] ?? all;
  });

/** Removes `<tag ...> ... </tag>` blocks by scanning, never with a lazy pattern (those are quadratic on hostile input). An unclosed opener is dropped alone. */
function dropBlocks(s: string, tag: string): string {
  const lower = s.toLowerCase();
  const open = `<${tag}`;
  const close = `</${tag}`;
  let out = "";
  let i = 0;
  for (;;) {
    const a = lower.indexOf(open, i);
    if (a < 0) return out + s.slice(i);
    out += s.slice(i, a);
    const b = lower.indexOf(close, a + open.length);
    if (b < 0) {
      const gt = lower.indexOf(">", a);
      i = gt < 0 ? s.length : gt + 1;
      continue;
    }
    const gt = lower.indexOf(">", b);
    out += " ";
    i = gt < 0 ? s.length : gt + 1;
  }
}

/** Removes `<...>` tags in one pass, keeping a lone `<` as text. Linear: the next `>` is looked for only when the last one found is behind. */
function stripTags(s: string): string {
  let out = "";
  let i = 0;
  let gt = -2;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) return out + s.slice(i);
    out += s.slice(i, lt);
    // "a < b" is text: a tag starts with a letter, "/", "!" or "?".
    if (!/[A-Za-z/!?]/.test(s[lt + 1] ?? "")) {
      out += "<";
      i = lt + 1;
      continue;
    }
    if (gt !== -1 && gt < lt) gt = s.indexOf(">", lt + 1);
    if (gt < 0) return `${out}${s.slice(lt)}`;
    if (gt - lt > 2000) {
      out += "<";
      i = lt + 1;
      continue;
    }
    out += " ";
    i = gt + 1;
  }
  return out;
}

/** HTML to readable text, roughly: enough for a summary, never rendered anywhere. Linear in the size of the input whatever it holds. */
export function htmlToText(html: string): string {
  const capped = html.slice(0, 400_000);
  let t = dropBlocks(dropBlocks(dropBlocks(capped, "script"), "style"), "head");
  t = stripTags(t.replace(/<br\s{0,20}\/?>|<\/(?:p|div|li|tr|h[1-6])>/gi, "\n"));
  t = decodeEntities(t).replace(/[ \t]+/g, " ");
  return t
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The words of an email: the new text AgentMail extracted (no quoted thread), else the text, else the HTML made plain, else the preview. */
export function bodyText(m: AgentMailMessage): string {
  // The HTML is turned into text only when there is nothing better (it is the costly one, and a text part is what the sender meant to be read).
  let pick = [m.extracted_text, m.text].find((t) => typeof t === "string" && t.trim()) ?? "";
  if (!pick && typeof m.html === "string") pick = htmlToText(m.html);
  if (!pick.trim() && typeof m.preview === "string") pick = m.preview;
  return pick.replace(INVISIBLE, "").replace(/\r\n?/g, "\n").trim().slice(0, TEXT_MAX);
}

/** Invisible characters that reorder or hide text (right-to-left override, zero-width joiners, the byte order mark) are removed from anything shown on the owner's phone. */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const oneLine = (s: unknown, max: number): string => (typeof s === "string" ? s.replace(INVISIBLE, "").replace(/\s+/g, " ").trim().slice(0, max) : "");

/** What became of an email: sent to many (kept, Claude not asked), waiting for the Mac, told to the owner, or kept without telling. */
export type MailKind = "masivo" | "pendiente" | "aviso" | "guardado";

export interface RecentMail {
  id: string;
  at: number;
  from: string;
  subject: string;
  preview: string;
  account?: MailAccount;
  kind?: MailKind;
  /** Claude's summary, once the Mac has read it. */
  summary?: string;
  /**
   * Whether Claude took it for a scam, when the bridge said (a newer one always does): the panel marks it from this, whatever language the
   * summary is in. Absent: not known (an older bridge), and the panel goes by the summary's words.
   */
  scam?: boolean;
  /**
   * Where it landed (src/mail-categories.ts): set by the triage run, the pre-classification or the owner's Move to…. Absent on a record kept
   * before categories: categoryOf reads it from the old verdict then.
   */
  category?: MailCategory;
  /** One line: why it is in that category (shown under the mail in the panel). */
  why?: string;
  /** An Updates mail that is a security alert: it has its own notification switch. */
  security?: boolean;
  /** A sender the owner always wants to hear about: told whatever the category. */
  vip?: boolean;
  /** The email's own Message-ID (no angle brackets), to open it in the owner's mail app; absent on older records. */
  messageId?: string;
  /** Where the owner's copy lives (Gmail, iCloud, Outlook), when it can be told: the "Open in…" link depends on it. */
  provider?: MailProvider;
  /** Moved by the owner (Move to…): a later triage answer does not move it back. */
  moved?: boolean;
  /** For Needs you: the triage's one-line ask and its kind (reply, decide, do); never written by anything but the triage. */
  ask?: { action: MailAction; text: string };
  /** When it is due, as the triage read it ("2026-11-20" or "2026-11-20 17:00", the owner's time zone). */
  due?: string;
  /** The owner marked it done on the dashboard (Pako only: the real mailbox is never touched), and the loops that closed then (for Undo). */
  handledAt?: number;
  closedLoops?: string[];
  /** The owner opened it in the panel's reader. */
  openedAt?: number;
  /** The owner replied to its thread (a mail of theirs whose In-Reply-To or References name it). */
  repliedAt?: number;
}

/** A record with its category always filled in, as the panel, the brief and the digest read it. */
export const withCategory = (r: RecentMail): RecentMail & { category: MailCategory } => ({ ...r, category: categoryOf(r) });

const accountTag = (a: MailAccount | undefined, l: Lang): string => (a === "trabajo" ? T(l)("work") : a === "personal" ? T(l)("personal") : "");

/**
 * The seen list, cut to its last SEEN_KEEP ids of each kind: Pako's own inbox (AgentMail ids), the owner's mailbox read by IMAP ("imap:") and
 * the same-email keys of both ("mid:"). One shared cut let a busy IMAP mailbox push out the few AgentMail ids that its listing of the latest 25
 * still shows every few minutes, and those weeks-old emails were passed on again.
 */
const keepSeen = (seen: string[]): string[] => {
  const kind = (id: string): string => (id.startsWith("imap:") ? "imap" : id.startsWith("mid:") ? "mid" : "box");
  const left = new Map<string, number>();
  const out: string[] = [];
  for (let i = seen.length - 1; i >= 0; i--) {
    const k = kind(seen[i]!);
    const n = left.get(k) ?? SEEN_KEEP;
    if (n <= 0) continue;
    left.set(k, n - 1);
    out.push(seen[i]!);
  }
  return out.reverse();
};

interface MailState {
  seen: string[];
  recent: RecentMail[];
  /** False until the first listing: the mail already in the inbox then is marked seen, not announced. */
  primed: boolean;
}

/**
 * What the server remembers about the inbox: the emails already passed on, the latest few for the assistant's context, and the one-time codes
 * found in them for the owner's CODE (hidden everywhere else unless `showCodes`: MAIL_SHOW_CODES=1). `lang`: the language of what it writes
 * (src/i18n.ts), asked each time; always English now, kept as a function so callers need not change.
 */
export function createMailbox(kv: Kv | null, o: { showCodes?: boolean; lang?: () => Lang; onReplied?: (ids: string[]) => void } = {}) {
  const vault = createCodeVault(kv);
  const lang = o.lang ?? english;
  let state: MailState | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
  // Mail kept before codes were hidden (or while MAIL_SHOW_CODES was on) is hidden as it is read back: MAIL, the panel and Claude's
  // context must not show an old code either. Hiding is idempotent, so mail kept hidden comes back as it was.
  const hiddenNow = (r: RecentMail): RecentMail => {
    if (o.showCodes) return r;
    const hide = (s: unknown): string => (typeof s === "string" ? hideCodes(s, lang()).text : "");
    return { ...r, subject: hide(r.subject), preview: hide(r.preview), ...(typeof r.summary === "string" ? { summary: hide(r.summary) } : {}) };
  };
  const load = async (): Promise<MailState> => {
    if (state) return state;
    let s: MailState = { seen: [], recent: [], primed: false };
    const raw = kv ? await kv.get(STATE_KEY) : null;
    if (state) return state; // loaded (and maybe changed) by someone else while this read was in flight: theirs is newer
    if (raw) {
      try {
        const p = JSON.parse(raw) as Partial<MailState>;
        s = {
          seen: (Array.isArray(p.seen) ? p.seen : []).filter((x): x is string => typeof x === "string"),
          recent: (Array.isArray(p.recent) ? p.recent : [])
            .filter((r): r is RecentMail => !!r && typeof r.id === "string" && typeof r.at === "number")
            .map(hiddenNow),
          primed: p.primed === true,
        };
      } catch {
        log.error("the stored state is not valid JSON: starting again");
      }
    }
    state = s;
    return s;
  };
  const save = async (s: MailState): Promise<void> => {
    if (kv) await kv.set(STATE_KEY, JSON.stringify(s), STATE_TTL_S);
    state = s;
  };
  /** The last day of mail by category (every category present, 0 when none), and the total. */
  const counts = async (nowMs: number = Date.now()): Promise<{ total: number } & Record<MailCategory, number>> => {
    const day = (await load()).recent.filter((r) => nowMs - r.at < 24 * 3600_000);
    const out = { total: day.length, ...Object.fromEntries(CATEGORIES.map((c) => [c, 0])) } as { total: number } & Record<MailCategory, number>;
    for (const r of day) out[categoryOf(r)]++;
    return out;
  };

  // The owner's choices (rules and switches), read once and kept: written one change at a time, under the same lock as the mailbox.
  let prefs: { rules: SenderRule[]; notify: NotifyPrefs } | null = null;
  const loadPrefs = async (): Promise<{ rules: SenderRule[]; notify: NotifyPrefs }> => {
    if (prefs) return prefs;
    let p = { rules: [] as SenderRule[], notify: notifyPrefsOf(null) };
    const raw = kv ? await kv.get(PREFS_KEY) : null;
    if (raw) {
      try {
        const v = JSON.parse(raw) as { rules?: unknown; notify?: unknown };
        p = { rules: rulesOf(v.rules), notify: notifyPrefsOf(v.notify) };
      } catch {
        log.error("the stored mail choices are not valid JSON: the defaults hold");
      }
    }
    prefs ??= p;
    return prefs;
  };
  const savePrefs = async (p: { rules: SenderRule[]; notify: NotifyPrefs }): Promise<void> => {
    if (kv) await kv.set(PREFS_KEY, JSON.stringify(p), PREFS_TTL_S);
    prefs = p;
  };
  return {
    /**
     * An email's subject, words and preview as Pako keeps them and passes them on: each one-time code replaced by the mark, in the language
     * of Pako's own texts (src/codes.ts codeMark; left in place with `showCodes`), and the codes kept for CODE. Throws when the store cannot
     * keep them, so the email is tried again and no code is lost.
     */
    conceal: async (
      e: { id: string; at: number; from: string; subject: string; text: string; preview: string },
      nowMs: number = Date.now(),
    ): Promise<{ subject: string; text: string; preview: string }> => {
      const subject = hideCodes(e.subject, lang());
      const text = hideCodes(e.text, lang());
      const preview = hideCodes(e.preview, lang());
      const codes = [...new Set([...subject.codes, ...text.codes, ...preview.codes])];
      if (codes.length) await vault.add({ id: e.id, at: e.at, from: e.from, subject: subject.text, codes }, nowMs);
      return o.showCodes ? { subject: e.subject, text: e.text, preview: e.preview } : { subject: subject.text, text: text.text, preview: preview.text };
    },
    /** The codes of the last 30 minutes, newest first, for the owner's CODE. Throws when the store cannot be read. */
    codes: (nowMs?: number) => vault.recent(nowMs),
    isSeen: async (id: string): Promise<boolean> => (await load()).seen.includes(id),
    primed: async (): Promise<boolean> => (await load()).primed,
    /** Marks emails seen without passing them on (the first listing of an inbox that already has mail). */
    prime: (ids: string[]): Promise<void> =>
      locked(async () => {
        const s = await load();
        await save({ ...s, seen: keepSeen([...s.seen, ...ids.filter((id) => !s.seen.includes(id))]), primed: true });
      }),
    /** Records an email as passed on, with `also` (sameMailKey: the same email by the other way in). False when either already was. */
    record: (r: RecentMail, also = ""): Promise<boolean> =>
      locked(async () => {
        const s = await load();
        if (s.seen.includes(r.id) || (also && s.seen.includes(also))) return false;
        const seen = keepSeen([...s.seen, r.id, ...(also ? [also] : [])]);
        await save({ ...s, seen, recent: [...s.recent, r].sort((a, b) => a.at - b.at).slice(-RECENT_KEEP) });
        return true;
      }),
    /** Undoes `record` when the email could not be queued, so a retry or the next listing passes it on. */
    forget: (id: string, also = ""): Promise<void> =>
      locked(async () => {
        const s = await load();
        await save({ ...s, seen: s.seen.filter((x) => x !== id && x !== also), recent: s.recent.filter((r) => r.id !== id) });
      }),
    /**
     * Keeps what the Mac made of an email: its summary, and whether the owner was told. The Mac never saw the email's codes, but a model can
     * restate a number: a code in the summary is hidden too (unless `showCodes`) and kept with the email's others.
     */
    annotate: (id: string, kind: MailKind, summary: string, nowMs: number = Date.now(), how: { scam?: boolean; verdict?: Verdict } = {}): Promise<boolean> =>
      locked(async () => {
        const s = await load();
        const r = s.recent.find((x) => x.id === id);
        if (!r) return false;
        // The triage's category, why and security mark; an older bridge's answer (no verdict) leaves them out and categoryOf reads its verdict.
        // A mail the owner already moved keeps their category.
        const v = how.verdict;
        const triaged = (x: RecentMail): RecentMail => {
          if (x.moved) return x;
          const { category: _c, why: _w, security: _s, ask: _a, due: _d, ...rest } = x;
          if (!v) return rest;
          // The run's words are a model's: a code it restated is hidden in them as in the summary.
          const hide = (t: string): string => (o.showCodes ? t : hideCodes(t, lang()).text);
          return {
            ...rest, category: v.category, ...(v.why ? { why: hide(v.why) } : {}), ...(v.security ? { security: true } : {}),
            ...(v.ask ? { ask: { action: v.ask.action, text: hide(v.ask.text) } } : {}), ...(v.loop?.due ? { due: v.loop.due } : {}),
          };
        };
        const said = summary.replace(/\s+/g, " ").trim().slice(0, 4000);
        const found = hideCodes(said, lang());
        if (found.codes.length) await vault.add({ id, at: r.at, from: r.from, subject: hideCodes(r.subject, lang()).text, codes: found.codes }, nowMs);
        const kept = (o.showCodes ? said : found.text).slice(0, 400);
        const marked = (x: RecentMail): RecentMail => {
          const { scam: _was, ...rest } = x;
          // "Not a scam" is kept as said: without it the panel could not tell that verdict from an older bridge's silence.
          return triaged({ ...rest, kind, summary: kept, ...(how.scam === undefined ? {} : { scam: how.scam }) });
        };
        await save({ ...s, recent: s.recent.map((x) => (x.id === id ? marked(x) : x)) });
        return true;
      }),
    /** The latest emails, newest first, one line each, for the assistant's context; mail sent to many only as a count. */
    recent: async (timeZone: string, nowMs: number = Date.now()): Promise<string[]> => {
      const l = lang();
      const all = [...(await load()).recent].reverse();
      const bulky = (r: RecentMail): boolean => LOW.has(categoryOf(r));
      const lines = all.filter((r) => !bulky(r)).slice(0, RECENT_SHOW).map((r) => mailLine(r, timeZone, l));
      const bulk = all.filter((r) => bulky(r) && nowMs - r.at < 24 * 3600_000).length;
      return bulk ? [...lines, T(l)("bulkCount", { n: bulk })] : lines;
    },
    /** The latest emails, newest first, as data (the owner's panel), each with its category filled in. */
    items: async (n = 60): Promise<(RecentMail & { category: MailCategory })[]> => [...(await load()).recent].reverse().slice(0, n).map(withCategory),
    /** One email by its id, with its category; null when the mailbox no longer keeps it. */
    get: async (id: string): Promise<(RecentMail & { category: MailCategory }) | null> => {
      const r = (await load()).recent.find((x) => x.id === id);
      return r ? withCategory(r) : null;
    },
    /** Keeps an email's words (codes already hidden) for the panel's reader. A store that fails loses only the reader's text, never the mail. */
    keepBody: async (id: string, text: string): Promise<void> => {
      if (!kv || !text.trim()) return;
      await kv.set(bodyKey(id), text.slice(0, BODY_MAX), STATE_TTL_S).catch((err: Error) => log.error(`could not keep an email's words: ${err.message}`));
    },
    /** An email's words as kept, codes hidden as everywhere else (unless `showCodes`); "" when none were kept. */
    body: async (id: string): Promise<string> => {
      const raw = kv ? await kv.get(bodyKey(id)) : null;
      return raw ? (o.showCodes ? raw : hideCodes(raw, lang()).text) : "";
    },
    /**
     * The owner moved an email to another category: kept on the record (marked moved, so a late triage answer does not move it back), and the
     * sender's rule learned, so their next mail lands there before any run of Claude. The record as it is now; null when it is gone.
     */
    move: (id: string, category: MailCategory, nowMs: number = Date.now()): Promise<(RecentMail & { category: MailCategory }) | null> =>
      locked(async () => {
        const s = await load();
        const r = s.recent.find((x) => x.id === id);
        if (!r) return null;
        const { security: _s, ...rest } = r;
        const moved: RecentMail = { ...rest, category, moved: true, why: `You moved it to ${CATEGORY_LABEL[category]}` };
        await save({ ...s, recent: s.recent.map((x) => (x.id === id ? moved : x)) });
        const from = senderAddress(r.from);
        if (from.includes("@")) {
          const p = await loadPrefs();
          await savePrefs({ ...p, rules: [...p.rules.filter((x) => x.from !== from), { from, category, at: nowMs }].slice(-RULES_MAX) });
        }
        return withCategory(moved);
      }),
    /** Done on the dashboard (handled: true) with the loops it closed, or its Undo (false). The record as it is now; null when it is gone. */
    handle: (id: string, handled: boolean, nowMs: number = Date.now(), closedLoops: string[] = []): Promise<RecentMail | null> =>
      locked(async () => {
        const s = await load();
        const r = s.recent.find((x) => x.id === id);
        if (!r) return null;
        const { handledAt: _h, closedLoops: _c, ...rest } = r;
        const next: RecentMail = handled ? { ...rest, handledAt: nowMs, ...(closedLoops.length ? { closedLoops: closedLoops.slice(0, 5) } : {}) } : rest;
        await save({ ...s, recent: s.recent.map((x) => (x.id === id ? next : x)) });
        return { ...r };
      }),
    /** Opened in the panel's reader: a "to read" mail leaves the dashboard. */
    opened: (id: string, nowMs: number = Date.now()): Promise<void> =>
      locked(async () => {
        const s = await load();
        if (!s.recent.some((x) => x.id === id && !x.openedAt)) return;
        await save({ ...s, recent: s.recent.map((x) => (x.id === id ? { ...x, openedAt: nowMs } : x)) });
      }),
    /**
     * The owner wrote a mail that answers others (its In-Reply-To and References): each kept mail with one of those Message-IDs is replied to.
     * The ids of the mail marked now.
     */
    replied: (messageIds: string[], nowMs: number = Date.now()): Promise<string[]> =>
      locked(async () => {
        const want = new Set(messageIds.map((x) => cleanMessageId(x)).filter(Boolean));
        if (!want.size) return [];
        const s = await load();
        const hit = s.recent.filter((x) => x.messageId && want.has(x.messageId) && !x.repliedAt).map((x) => x.id);
        if (!hit.length) return [];
        await save({ ...s, recent: s.recent.map((x) => (hit.includes(x.id) ? { ...x, repliedAt: nowMs } : x)) });
        o.onReplied?.(hit);
        return hit;
      }),
    /** One email the owner already answered (a catch-up saw their reply), by its id here. */
    repliedById: (id: string, nowMs: number = Date.now()): Promise<void> =>
      locked(async () => {
        const s = await load();
        if (!s.recent.some((x) => x.id === id && !x.repliedAt)) return;
        await save({ ...s, recent: s.recent.map((x) => (x.id === id ? { ...x, repliedAt: nowMs } : x)) });
      }),
    /** The sender rules, oldest first. */
    rules: async (): Promise<SenderRule[]> => [...(await loadPrefs()).rules],
    /** Forgets one sender rule (by its address or @domain). False when there was none. */
    forgetRule: (from: string): Promise<boolean> =>
      locked(async () => {
        const p = await loadPrefs();
        const want = from.trim().toLowerCase();
        if (!p.rules.some((r) => r.from === want)) return false;
        await savePrefs({ ...p, rules: p.rules.filter((r) => r.from !== want) });
        return true;
      }),
    /** The notification switches, over the defaults. */
    notifyPrefs: async (): Promise<NotifyPrefs> => ({ ...(await loadPrefs()).notify }),
    /** Turns one switch on or off. */
    setNotify: (key: NotifyKey, on: boolean): Promise<NotifyPrefs> =>
      locked(async () => {
        const p = await loadPrefs();
        const notify = { ...p.notify, [key]: on };
        await savePrefs({ ...p, notify });
        return { ...notify };
      }),
    /** Whether this email is told to the owner now, by its category and the switches (a VIP always is). False when it is gone. */
    notifies: async (id: string): Promise<boolean> => {
      const r = (await load()).recent.find((x) => x.id === id);
      if (!r) return false;
      return shouldNotify({ category: categoryOf(r), security: r.security, vip: r.vip }, (await loadPrefs()).notify);
    },
    /** How many emails came in the last day, and how many the owner was told about (the morning brief). */
    counts,
    /** The morning brief's line about the last day of mail; null when none came. */
    brief: async (nowMs: number = Date.now()): Promise<string | null> => {
      const c = await counts(nowMs);
      if (!c.total) return null;
      const parts = CATEGORIES.filter((k) => c[k]).map((k) => `${c[k]} ${CATEGORY_LABEL[k]}`).join(", ");
      return T(lang())("brief", { total: c.total, parts });
    },
    /** The last day of mail, for the owner's MAIL command: what was told, what was kept, and the mass mail by sender. */
    digest: async (timeZone: string, nowMs: number = Date.now()): Promise<string> => {
      const l = lang();
      const t = T(l);
      const day = [...(await load()).recent].filter((r) => nowMs - r.at < 24 * 3600_000).reverse();
      if (!day.length) return t("none");
      const parts = [t("head", { n: day.length })];
      // Category by category, in the panel's order; the mail nobody reads one by one (newsletters, offers) only by sender.
      for (const c of CATEGORIES) {
        const list = day.filter((r) => categoryOf(r) === c);
        if (!list.length) continue;
        const label = CATEGORY_LABEL[c];
        if (LOW.has(c)) {
          const senders = [...new Set(list.map((r) => r.from.replace(/\s*<[^>]*>/, "").trim() || r.from))].slice(0, 6).join(", ");
          parts.push(`${t("senders", { label, n: list.length, senders })}${list.length > 6 ? "…" : ""}`);
        } else parts.push(`${t("group", { label, n: list.length })}\n${list.slice(0, 8).map((r) => `• ${mailLine(r, timeZone, l)}`).join("\n")}`);
      }
      return parts.join("\n\n");
    },
  };
}

export type Mailbox = ReturnType<typeof createMailbox>;

/** Categories read in bulk, never one by one: the assistant's context and MAIL give them as a count or by sender. */
const LOW = new Set<MailCategory>(["read_later", "promotions"]);

function mailLine(r: RecentMail, timeZone: string, l: Lang): string {
  const when = new Intl.DateTimeFormat(locale(l), { timeZone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(r.at);
  const about = r.summary || r.preview;
  const t = T(l);
  return `${when} ${accountTag(r.account, l)}${t("from", { from: r.from })}${r.subject ? t("subject", { subject: r.subject }) : ""}${about ? `: ${about}` : ""}`;
}

/**
 * Sends one email from the assistant's inbox (AgentMail's send needs an API key with the message_send permission; a read-only key answers 403).
 * Only src/booking.ts calls it, after the owner pressed the card that shows the email's address and purpose. Replies come back to the inbox.
 */
export async function sendEmail(
  config: Pick<MailConfig, "apiKey" | "inbox">,
  m: { to: string; subject: string; text: string; replyTo?: string },
  f: typeof fetch = fetch,
): Promise<void> {
  const r = await f(`${API}/inboxes/${encodeURIComponent(config.inbox)}/messages/send`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ to: [m.to], subject: m.subject.slice(0, 200), text: m.text.slice(0, 5000), ...(m.replyTo ? { reply_to: m.replyTo } : {}) }),
    signal: AbortSignal.timeout(15_000),
  });
  // The status travels with the error: a refusal (4xx) certainly did not send; anything else may have.
  if (!r.ok) throw Object.assign(new Error(`AgentMail answered ${r.status} to the send${r.status === 403 ? " (the API key has no message_send permission)" : ""}`), { status: r.status });
}

/**
 * A mail the owner wrote (read from their Sent folder, or a copy to themselves): never news to them, but the mail it answers is dealt with.
 * Its In-Reply-To and References name the mail of the thread; those kept here are marked replied (they leave the dashboard, and their loops
 * close through onReplied). The ids marked.
 */
export async function takeOwnMail(box: Pick<Mailbox, "replied">, m: AgentMailMessage, nowMs: number = Date.now()): Promise<string[]> {
  const ids = headerValues(m, ["in-reply-to", "references"]).flatMap((v) => [...v.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)].map((x) => x[1]!)).slice(0, 50);
  return ids.length ? box.replied(ids, nowMs) : [];
}

/** What an email needs to be taken in, whichever mailbox it came from (AgentMail's here, the owner's own by IMAP in src/imap.ts). */
export interface IntakeDeps {
  box: Mailbox;
  /** The owner's assistant inbox (src/whatsapp.ts). False when it already had this id. */
  enqueue: (m: Inbound) => Promise<boolean>;
  control?: Control | undefined;
  lang: () => Lang;
  now: () => number;
  /** Senders whose mail always reaches the owner at once (an address, or @domain). */
  vip: string[];
  /** Where the owner's copy lives (src/imap.ts knows its host); without it, read from the addresses the mail was delivered to. */
  provider?: MailProvider | undefined;
}

/**
 * Takes one email in, once: its one-time codes hidden, mail sent to many only kept, the rest queued for the summary Claude writes in a run
 * with no tools (assistant/bridge.ts handleEmail). `id`: the mailbox's own id for it. Throws when it could not be queued, so the caller can
 * try again.
 */
/**
 * Mail that never needs Claude, by its headers and sender alone: no-reply senders and receipts (mail sent to many is isBulk). Used for a
 * mailbox's catch-up, where every run of Claude counts against a small allowance.
 */
export function cheapSkip(m: AgentMailMessage): boolean {
  const from = addressOf(String(m.from ?? ""));
  if (/^(no-?reply|do-?not-?reply|donotreply|notifications?|alerts?|mailer-daemon|postmaster|bounce[s]?)([+.-][^@]*)?@/i.test(from)) return true;
  const subject = String(m.subject ?? "");
  return /\b(receipt|your order|order confirmation|invoice|payment received|shipping confirmation|has shipped|delivery update|password reset|verify your)\b/i.test(subject);
}

export async function takeMail(
  d: IntakeDeps,
  id: string,
  m: AgentMailMessage,
  account: MailAccount,
  o: { quiet?: boolean; replied?: boolean; enqueue?: (m: Inbound) => Promise<boolean> } = {},
): Promise<"queued" | "stored" | "seen"> {
  const { box, now } = d;
  // Read by IMAP and forwarded to Pako's inbox too: taken once, by whichever way came first.
  const also = sameMailKey(m);
  if (also && (await box.isSeen(also))) return "seen";
  const t = T(d.lang());
  // The stand-in is kept with the email (MAIL, the panel, the notice's head): in the language of the day it came.
  const from = oneLine(m.from, 200) || t("unknownSender");
  // A date in the future (a wrong clock, a hostile Date header) is today: it must not stay at the top of the list for years.
  const at = Math.min(Date.parse(m.timestamp ?? m.created_at ?? "") || now(), now());
  // One-time codes come out before anything below keeps, logs or queues the words, and before the subject and preview are cut (a code cut in
  // two would show its first digits).
  const body = bodyText(m);
  const words = await box.conceal({ id, at, from, subject: oneLine(m.subject, 1000), text: body, preview: oneLine(m.preview ?? body, 1000) }, now());
  const subject = words.subject.slice(0, 300);
  const text = words.text;
  const vip = isVip(from, d.vip);
  const preview = words.preview.slice(0, 160);
  const quoted = subject ? t("subject", { subject }) : "";
  // What opens it in the owner's own mail app later: its Message-ID and where the owner's copy lives.
  const messageId = cleanMessageId(headerValues(m, ["message-id"])[0]);
  const delivered = [...headerValues(m, ["delivered-to", "x-forwarded-to", "x-original-to", "to"]), ...(m.to ?? [])].map(String);
  const provider = d.provider ?? providerOf(undefined, delivered);
  const where = { ...(messageId ? { messageId } : {}), ...(provider ? { provider } : {}) };
  // Decided without a run of Claude (src/mail-categories.ts preClassify): a sender rule the owner taught, mail sent to a list, a known carrier's
  // or shop's notice. Most of the volume, none of the news; a VIP always gets the run (and the notice). Only for a sender the owner's mail
  // server vouched for (DKIM or DMARC aligned with From) and with no red flag: anything else, a look-alike "orders@" first of all, gets the
  // full read, the Suspicious check included.
  const trusted = !vip && trustedSender({
    from, authResults: headerValues(m, ["authentication-results"]), replyTo: headerValues(m, ["reply-to"]), subject, text,
    ...(typeof m.html === "string" ? { html: m.html.slice(0, 200_000) } : {}),
  });
  const pre = trusted ? preClassify({ from, subject, bulk: isBulk(m), listId: headerValues(m, ["list-id"])[0] ?? "" }, await box.rules().catch(() => [])) : null;
  // In a quiet catch-up (old mail, never told), a proven no-reply sender or receipt is not worth a run either: kept as Updates.
  const filed = pre ?? (trusted && o.quiet && cheapSkip(m) ? { category: "updates" as const, why: "A notice or receipt already in your mailbox when it was connected" } : null);
  if (filed) {
    if (!(await box.record({ id, at, from, subject, preview, account, kind: "masivo", category: filed.category, why: filed.why, ...where }, also))) return "seen";
    await box.keepBody(id, text);
    d.control?.log("mail", t("logBulk", { label: CATEGORY_LABEL[filed.category], from, subject: quoted }), at);
    return "stored";
  }
  if (!(await box.record({ id, at, from, subject, preview, account, kind: "pendiente", ...(vip ? { vip: true } : {}), ...where }, also))) return "seen";
  await box.keepBody(id, text);
  try {
    const attachments = (m.attachments ?? []).map((a) => oneLine(a?.filename, 120)).filter(Boolean).slice(0, 10);
    // `quiet`: mail that was already there when the mailbox was connected (src/imap.ts): kept and summarized, never told.
    await (o.enqueue ?? d.enqueue)({
      id: `mail:${id}`, at, text: "",
      email: { from, subject, text, attachments, account, vip, ...(o.quiet ? { quiet: true } : {}), ...(o.replied ? { replied: true } : {}) },
    });
  } catch (err) {
    await box.forget(id, also);
    throw err;
  }
  log.info(`passed on an email (${text.length} characters)`);
  d.control?.log("mail", t("logMail", { from, subject: quoted }), at);
  return "queued";
}

export interface MailDeps {
  config: MailConfig;
  box: Mailbox;
  /** The owner's assistant inbox (src/whatsapp.ts). False when it already had this id. */
  enqueue: (m: Inbound) => Promise<boolean>;
  control?: Control;
  fetch?: typeof fetch;
  now?: () => number;
  /** The language of the log's lines and of a missing sender's stand-in (src/i18n.ts): always English now, kept as a function so callers need not change. */
  lang?: () => Lang;
  /** The watchdog (src/watchdog.ts): whether each listing of the inbox went through. */
  health?: HealthReport;
}

export function mountMail(app: Express, d: MailDeps) {
  const { config, box } = d;
  const f = d.fetch ?? fetch;
  const now = d.now ?? Date.now;
  const lang = d.lang ?? english;
  const auth = { authorization: `Bearer ${config.apiKey}` };
  const inboxPath = `${API}/inboxes/${encodeURIComponent(config.inbox)}`;

  const getJson = async (url: string, headers: Record<string, string> = auth): Promise<unknown> => {
    const r = await f(url, { headers, signal: AbortSignal.timeout(8_000) });
    if (!r.ok) throw new Error(`AgentMail answered ${r.status} for ${url.startsWith(API) ? url.slice(API.length) : "the body link"}`);
    return r.json();
  };

  /** The full message when the event or the listing came without its body (over 64 KiB, or a list item). */
  const withBody = async (m: AgentMailMessage): Promise<AgentMailMessage> => {
    if (m.extracted_text || m.text || m.html) return m;
    if (m.body_url && /^https:\/\//.test(m.body_url)) {
      try {
        return { ...m, ...((await getJson(m.body_url, {})) as AgentMailMessage) };
      } catch (err) {
        log.error(`the body link failed: ${(err as Error).message}`);
      }
    }
    if (!m.message_id) return m;
    return { ...m, ...((await getJson(`${inboxPath}/messages/${encodeURIComponent(m.message_id)}`)) as AgentMailMessage) };
  };

  // AgentMail's own id for the inbox may be its address or an opaque id: it is asked once. Forwarded mail is not addressed to the inbox, so the
  // recipients cannot tell; the signature already proves the event is AgentMail's, so if the inbox cannot be looked up the event is taken.
  let inboxIds: Set<string> | null = null;
  const ours = async (m: AgentMailMessage): Promise<boolean> => {
    if (m.inbox_id === config.inbox) return true;
    if (!inboxIds) {
      try {
        const info = (await getJson(inboxPath)) as { inbox_id?: unknown; email?: unknown };
        inboxIds = new Set([config.inbox, info.inbox_id, info.email].filter((x): x is string => typeof x === "string"));
      } catch (err) {
        log.error(`could not look the inbox up: ${(err as Error).message}`);
        return true;
      }
    }
    return typeof m.inbox_id !== "string" || inboxIds.has(m.inbox_id);
  };

  /** Passes one email on to the assistant, once. Throws when it could not be queued, so the caller can retry. */
  const pass = async (raw: AgentMailMessage): Promise<"queued" | "stored" | "seen" | "dropped"> => {
    const id = oneLine(raw.message_id, 300);
    if (!id) return "dropped";
    if ((raw.labels ?? []).some((l) => DROP_LABELS.has(l) || l === "sent")) return "dropped";
    // The inbox also lists what the assistant itself sent (a table request): that is not mail to announce.
    if (addressOf(oneLine(raw.from, 200)) === config.inbox.toLowerCase()) return "dropped";
    if (await box.isSeen(id)) return "seen";
    const m = await withBody(raw);
    return takeMail({ box, enqueue: d.enqueue, control: d.control, lang, now, vip: config.vip }, id, m, accountOf(m, config));
  };

  const failed = rateLimit({
    windowMs: 15 * 60_000,
    limit: 60,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) => res.statusCode !== 401, // a 503 (store down) must not lock AgentMail out
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  // No webhook secret: no webhook route (the listing every few minutes brings the mail).
  if (config.webhookSecret) app.post("/email/webhook", failed, express.raw({ type: "*/*", limit: "1mb" }), async (req: Request, res: Response) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const ok = verifySvix(config.webhookSecret, { id: req.get("svix-id"), timestamp: req.get("svix-timestamp"), signature: req.get("svix-signature") }, body, now());
    if (!ok) {
      res.status(401).type("text").send("Bad signature");
      return;
    }
    let event: { type?: unknown; event_type?: unknown; message?: AgentMailMessage };
    try {
      event = JSON.parse(body.toString("utf8")) as typeof event;
    } catch {
      res.status(400).type("text").send("Not JSON");
      return;
    }
    // Only plain received mail of this inbox; every other event (spam and the like, if ever subscribed) is acknowledged and ignored.
    if (event.event_type !== "message.received" || !event.message || !(await ours(event.message))) {
      res.json({ ok: true, ignored: true });
      return;
    }
    try {
      res.json({ ok: true, result: await pass(event.message) });
    } catch (err) {
      log.error(`could not pass an email on: ${(err as Error).message}`);
      res.status(503).type("text").send("Try again");
    }
  });

  /** The safety net: the latest mail in the inbox, anything not passed on yet goes now. The first run only marks what is already there. */
  let polling = false;
  const poll = async (): Promise<number> => {
    if (polling) return 0;
    polling = true;
    try {
      const list = (await getJson(`${inboxPath}/messages?limit=25`)) as { messages?: AgentMailMessage[] };
      d.health?.(true);
      const msgs = (Array.isArray(list.messages) ? list.messages : []).filter((m) => typeof m?.message_id === "string");
      if (!(await box.primed())) {
        await box.prime(msgs.map((m) => oneLine(m.message_id, 300)));
        log.info(`inbox ${config.inbox}: ${msgs.length} email(s) already there, not announced`);
        return 0;
      }
      let queued = 0;
      for (const m of [...msgs].reverse()) {
        try {
          if ((await pass(m)) === "queued") queued++;
        } catch (err) {
          log.error(`one listed email could not be passed on (the others go on): ${(err as Error).message}`);
        }
      }
      if (queued) log.info(`the listing found ${queued} email(s) the webhook had not brought`);
      return queued;
    } catch (err) {
      log.error(`listing the inbox failed: ${(err as Error).message}`);
      d.health?.(false, (err as Error).message);
      return 0;
    } finally {
      polling = false;
    }
  };
  if (config.pollMinutes > 0) {
    setTimeout(() => void poll(), 30_000).unref?.();
    setInterval(() => void poll(), config.pollMinutes * 60_000).unref?.();
  }
  return { poll, address: config.inbox };
}
