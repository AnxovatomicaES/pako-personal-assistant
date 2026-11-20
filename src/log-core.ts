// Pako's log: one line per thing worth knowing, with when, how serious, which part said it ([whatsapp], [pako], [bridge]...) and what.
//
// People read it: ~/.pako/logs/pako.log and the terminal get the same plain text as always, now with a timestamp and a level in front of the
// part's name. With PAKO_LOG_FORMAT=json each line is a JSON object instead, for a log service to search. PAKO_LOG_LEVEL (debug, info, warn
// or error; info by default) drops the lines below it.
//
// Every line goes out through console.log, console.warn or console.error, looked up when the line is written: what a test puts in their place
// sees the line, exactly as it saw console's before.
//
// Nothing secret is written. A field whose name says it holds a secret (token, secret, password, authorization, cookie, key, code...) is
// replaced whole, and in any text bearer tokens, API keys in their known shapes, secrets in a URL's query and phone numbers (all but their
// last 3 digits) are hidden. The server adds the one-time codes of the owner's mail (src/log.ts).
//
// This file has no import but Node's own, and voice-worker/src/log.ts is a copy of it (a test checks they stay the same): the voice worker is
// built on its own and cannot import from src/.

import { formatWithOptions, inspect } from "node:util";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Log {
  /** The part's name, shown in brackets: [whatsapp]. */
  readonly name: string;
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  /** A log for another part (its name replaces this one's), carrying these fields on top of this one's on each line. */
  child(name: string, fields?: LogFields): Log;
}

/** One line before it is written. */
export interface LogEntry {
  ts: string;
  level: LogLevel;
  component: string;
  msg: string;
  fields?: LogFields;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACTED = "[redacted]";

/** The level below which lines are dropped: PAKO_LOG_LEVEL, read on each line so a change in a test or a REPL counts at once. */
export function logLevel(env: Record<string, string | undefined> = process.env): LogLevel {
  const v = (env.PAKO_LOG_LEVEL ?? "").trim().toLowerCase();
  return v === "debug" || v === "info" || v === "warn" || v === "error" ? v : "info";
}

export function logFormat(env: Record<string, string | undefined> = process.env): "text" | "json" {
  return (env.PAKO_LOG_FORMAT ?? "").trim().toLowerCase() === "json" ? "json" : "text";
}

// ---------- redaction ----------

/** Words that make a field's name a secret's, when they are a whole word of it (apiKey, x-api-key, refresh_token, set-cookie). */
const SECRET_WORDS = new Set([
  "token", "secret", "password", "passwd", "passphrase", "pwd", "authorization", "auth", "cookie", "cookies", "key", "apikey", "code",
  "otp", "pin", "credential", "credentials", "signature", "sig",
]);
/** The same, inside a name written all in one word (accesstoken, clientsecret). */
const SECRET_INSIDE = /token|secret|password|passwd|authorization|cookie|apikey|credential/;
/** A "code" that is no secret: an HTTP status, an exit code, a country or a language. */
const PLAIN_CODE = new Set(["status", "exit", "http", "error", "err", "response", "country", "lang", "language", "locale", "postal", "zip", "currency", "area", "iso"]);
/** Words that make a field's name a phone number's: its value keeps only its last 3 digits. */
const PHONE_WORDS = new Set(["phone", "tel", "telephone", "mobile", "msisdn", "caller", "callee", "waid", "wa", "from", "to", "number"]);

function words(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Whether a field of this name holds a secret. */
export function isSecretName(name: string): boolean {
  const w = words(name);
  for (let i = 0; i < w.length; i++) {
    const word = w[i]!;
    if (!SECRET_WORDS.has(word)) continue;
    if (word === "code" && i > 0 && PLAIN_CODE.has(w[i - 1]!)) continue;
    return true;
  }
  // A name in one word can still hold one (clientsecret); a longer one has said what it is (tokens_used is a count).
  return w.length === 1 && SECRET_INSIDE.test(w[0]!);
}

function isPhoneName(name: string): boolean {
  return words(name).some((w) => PHONE_WORDS.has(w));
}

/** A phone number with all but its last 3 digits hidden: +34600111222 is +***222. */
function maskPhone(s: string): string {
  const digits = s.replace(/\D/g, "");
  return `${s.trim().startsWith("+") ? "+" : ""}***${digits.slice(-3)}`;
}

// Known shapes of keys and tokens: Anthropic and OpenAI (sk-), Slack (xox?-, xapp-), GitHub, AWS, Google, Stripe-like (sk_live_), Telegram
// bots (123456:ABC...), JSON web tokens.
const KEY_SHAPES = new RegExp(
  [
    String.raw`\bsk-[A-Za-z0-9_-]{16,}`,
    String.raw`\bxox[abposr]-[A-Za-z0-9-]{10,}`,
    String.raw`\bxapp-[A-Za-z0-9-]{10,}`,
    String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}`,
    String.raw`\bgithub_pat_\w{20,}`,
    String.raw`\bAKIA[0-9A-Z]{16}\b`,
    String.raw`\bAIza[0-9A-Za-z_-]{35}`,
    String.raw`\b[rsp]k_(?:live|test)_[A-Za-z0-9]{10,}`,
    // A bot token also inside its API address, where "bot" comes right before it (https://api.telegram.org/bot123456:ABC.../getUpdates).
    String.raw`(?:\b|(?<=bot))\d{6,12}:[A-Za-z0-9_-]{30,}`,
    String.raw`\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}`,
  ].join("|"),
  "g",
);
const BEARER = /\b(Bearer|Basic|Token)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
// key=value in a URL's query or a command line: the value goes, the name stays (so the line still says what was there).
const ASSIGNED = /([?&;\s"'(]|^)((?:access_|refresh_|id_|api_|auth_|client_)?(?:token|key|apikey|secret|password|code|sig|signature))=([^&\s"')]+)/gi;
// "password": "..." in a body written into a line.
const JSON_SECRET = /("[A-Za-z_-]*(?:token|secret|password|authorization|cookie|api_?key|apiKey)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi;
// A phone number written with its country code (+34 600 111 222), and WhatsApp's ids (34600111222@s.whatsapp.net).
const PHONE = /\+\d[\d ().-]{6,18}\d/g;
const JID = /\b\d{5,}(\d{3})@(s\.whatsapp\.net|c\.us|g\.us|lid)\b/g;

type Scrub = (text: string) => string;
let extraScrub: Scrub | null = null;

/** Any text with the secrets above hidden. */
export function scrubText(text: string): string {
  let s = text
    .replace(BEARER, (_m, kind: string, space: string) => `${kind}${space}${REDACTED}`)
    .replace(KEY_SHAPES, REDACTED)
    .replace(ASSIGNED, (_m, before: string, name: string) => `${before}${name}=${REDACTED}`)
    .replace(JSON_SECRET, (_m, head: string) => `${head}"${REDACTED}"`)
    .replace(PHONE, (m) => {
      const n = m.replace(/\D/g, "").length;
      return n >= 8 && n <= 15 ? maskPhone(m) : m;
    })
    .replace(JID, (_m, last: string, host: string) => `***${last}@${host}`);
  if (extraScrub) s = extraScrub(s);
  return s;
}

/** The fields with secrets replaced and every text scrubbed, to a few levels deep. */
export function redactFields(fields: LogFields, depth = 0): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) out[k] = redactValue(k, v, depth);
  return out;
}

function redactValue(name: string, v: unknown, depth: number): unknown {
  if (v === undefined || v === null) return v;
  if (isSecretName(name)) return REDACTED;
  if (isPhoneName(name) && (typeof v === "string" || typeof v === "number") && /^\+?[\d ().-]{7,20}$/.test(String(v).trim())) {
    const n = String(v).replace(/\D/g, "").length;
    if (n >= 7 && n <= 15) return maskPhone(String(v));
  }
  if (typeof v === "string") return scrubText(v);
  if (v instanceof Error) return scrubText(v.message);
  if (depth >= 4) return typeof v === "object" ? "[…]" : v;
  if (Array.isArray(v)) return v.map((x) => redactValue("", x, depth + 1));
  if (isPlainObject(v)) return redactFields(v, depth + 1);
  return v;
}

function isPlainObject(v: unknown): v is LogFields {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// ---------- lines ----------

function textValue(v: unknown): string {
  if (typeof v === "string") return /^[^\s"=]+$/.test(v) ? v : JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean" || v === null || v === undefined) return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    /* a cycle or a BigInt: inspected instead */
    return inspect(v, { depth: 2, breakLength: Infinity });
  }
}

/** The line as written: text by default, a JSON object with PAKO_LOG_FORMAT=json. */
export function formatEntry(e: LogEntry, format: "text" | "json"): string {
  if (format === "json") {
    const out: Record<string, unknown> = { ts: e.ts, level: e.level, component: e.component, msg: e.msg };
    // A field never hides the four above: it gets a _ in front of its name instead.
    for (const [k, v] of Object.entries(e.fields ?? {})) out[k in out ? `_${k}` : k] = v;
    try {
      return JSON.stringify(out);
    } catch {
      /* a field that will not serialize: the line without its fields */
      return JSON.stringify({ ts: e.ts, level: e.level, component: e.component, msg: e.msg });
    }
  }
  const fields = Object.entries(e.fields ?? {}).map(([k, v]) => ` ${k}=${textValue(v)}`).join("");
  return `${e.ts} ${e.level.toUpperCase()} [${e.component}] ${e.msg}${fields}`;
}

/** A text line without its timestamp and level: "[whatsapp] webhook: 1 queued", for a test that compares what a part said. */
export function logBody(line: string): string {
  return line.replace(/^\S+ (?:DEBUG|INFO|WARN|ERROR) (?=\[)/, "");
}

let clock: () => Date = () => new Date();

/** For tests: the clock the lines are stamped with, and a scrub run after the built-in ones (the server's hides the mail's one-time codes). */
export function configureLog(o: { now?: () => Date; scrub?: Scrub | null }): void {
  if (o.now) clock = o.now;
  if (o.scrub !== undefined) extraScrub = o.scrub;
}

/**
 * The message and its arguments as console would join them (the same %s placeholders, an Error with its stack), except that a last argument
 * that is a plain object is taken as the line's fields: in text they are written as name=value after the message.
 */
function entryOf(level: LogLevel, component: string, bound: LogFields | undefined, message: string, args: unknown[]): LogEntry {
  let rest = args;
  let fields: LogFields | undefined = bound;
  const last = args[args.length - 1];
  if (args.length && isPlainObject(last)) {
    rest = args.slice(0, -1);
    fields = { ...bound, ...last };
  }
  const msg = scrubText(rest.length ? formatWithOptions({ colors: false }, message, ...rest) : String(message));
  const entry: LogEntry = { ts: clock().toISOString(), level, component, msg };
  if (fields && Object.keys(fields).length) entry.fields = redactFields(fields);
  return entry;
}

function write(level: LogLevel, line: string): void {
  // Looked up now, not kept: a test that swaps console.error must see this line.
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function make(name: string, bound?: LogFields): Log {
  const at = (level: LogLevel) => (message: string, ...args: unknown[]): void => {
    if (RANK[level] < RANK[logLevel()]) return;
    try {
      write(level, formatEntry(entryOf(level, name, bound, message, args), logFormat()));
    } catch (err) {
      // A line that cannot be written must not break what was being logged.
      console.error(`[log] could not write a line of [${name}]: ${(err as Error).message}`);
    }
  };
  return {
    name,
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: (n: string, fields?: LogFields) => (fields || bound ? make(n, { ...bound, ...fields }) : createLog(n)),
  };
}

const made = new Map<string, Log>();

/** The log of one part, by the name it has always shown in brackets ("whatsapp" for [whatsapp]). The same object each time for a name. */
export function createLog(name: string, fields?: LogFields): Log {
  if (fields) return make(name, fields);
  let l = made.get(name);
  if (!l) made.set(name, (l = make(name)));
  return l;
}

/** Pako's own log ([pako]): log.child("whatsapp") gives a part's. */
export const log: Log = createLog("pako");
