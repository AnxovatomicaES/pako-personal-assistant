// The owner's own mailbox, READ ONLY, by IMAP: the mail that reaches them, without forwarding it to Pako's inbox (src/mail.ts).
//
// What it may do is narrow on purpose, and the client type below allows nothing else: connect over TLS only (implicit TLS, the certificate
// checked, no STARTTLS and never a plain connection), open each folder with EXAMINE (read-only: the server sets no \Seen and changes
// nothing), look for new UIDs (UID SEARCH) and fetch a message with BODY.PEEK (which never marks it read). Never STORE (no flag), never
// COPY, MOVE, EXPUNGE, DELETE or APPEND, never SMTP: Pako cannot send from this account, and no line of this file knows how.
//
// Every few minutes (IMAP_POLL_MINUTES, 5 by default) it logs in, takes the UIDs above the last one it read in each folder (UIDVALIDITY
// says when the server renumbered a folder: that folder then starts again from the last 24 hours), and logs out. The first look reads only
// the last 24 hours, and mail older than that is never news. That first look is QUIET: the mail already in the mailbox is kept, summarized
// and may feed the follow-ups, but the owner is told about none of it, only one calm line that the mailbox is connected. Connecting an
// inbox used to send a burst of notices for a day of mail the owner had already seen. A renumbered folder, or a folder added later, is read
// again just as quietly, without the line. While Pako is paused (STOP) it does not log in.
//
// An email here is a stranger's text exactly as in Pako's own inbox: each one goes through src/mail.ts takeMail (one-time codes hidden, mail
// sent to many only kept, the VIP senders, the same mailbox state) and its words are read in full only in the isolated summary run on the
// owner's computer (assistant/bridge.ts handleEmail, src/quarantine.ts). The MIME parsing below is plain and bounded: a hostile message
// can make it read less, never loop or grow.
//
// Microsoft and Google accounts no longer take passwords: for them the panel signs in with the provider (src/mail-oauth.ts) and keeps a
// refresh token (IMAP_OAUTH, IMAP_REFRESH_TOKEN). Before each look this asks for a fresh access token (`tokens`) and logs in with XOAUTH2
// instead of a password. A refresh token the provider no longer takes makes the card say "Sign in again".
//
// A failing login is said once (the server's log, the panel's action log and its Connections card), then tried again later and later
// (30 minutes doubling to 6 hours for a refused password, so a provider does not lock the account). The password is never logged: errors
// are reduced to their kind, and any other text is cleaned of it first. Nothing here writes to the owner: a broken mailbox is not news worth
// a message they did not ask for.

import { createHash } from "node:crypto";
import type { ConnectionOptions } from "node:tls";
import type { Control } from "./control.ts";
import { english, texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import { mailClients, type MailOAuthProvider } from "./mail-clients.ts";
import { providerOf } from "./mail-categories.ts";
import { addressOf, loadMailFilters, type IntakeDeps, type MailAccount, type Mailbox } from "./mail.ts";
import { createMailIntake } from "./mail-intake.ts";
import type { Inbound } from "./whatsapp.ts";
import type { HealthReport } from "./watchdog.ts";
import type { InviteStore } from "./invites.ts";
import type { Backfill } from "./backfill.ts";
import type { SentMail } from "./mail-followups.ts";
import { createLog } from "./log.ts";
import { readJsonRecord } from "./json-record.ts";
import { waitLeft } from "./clock.ts";

const log = createLog("imap");

type Env = Record<string, string | undefined>;

export interface ImapConfig {
  host: string;
  /** Implicit TLS: 993 unless IMAP_PORT says otherwise (143, plain or STARTTLS, is refused). */
  port: number;
  user: string;
  /** An app password (the provider's, made for one app), never the account's own password if the provider offers one. "" when signed in
   * with the provider instead (`oauth`). */
  password: string;
  /** Signed in with the provider (Microsoft, Google): its client and the refresh token; the access token is asked for before each look. */
  oauth?: { provider: MailOAuthProvider; clientId: string; clientSecret?: string; refreshToken: string };
  /** The access token for this one login (XOAUTH2), set just before connecting; never kept. */
  accessToken?: string;
  /** The folders read; INBOX by default. */
  folders: string[];
  pollMinutes: number;
  /** The same lists as Pako's own inbox (AGENTMAIL_WORK_DOMAINS, AGENTMAIL_VIP): one place says who matters. */
  workDomains: string[];
  vip: string[];
}

/** Off (null) unless IMAP_HOST, IMAP_USER and IMAP_PASSWORD are set (IMAP2_*, the second mailbox's, with `p`); a wrong value is named and keeps it off. */
export function loadImapConfig(env: Env, p: "IMAP" | "IMAP2" = "IMAP"): { config: ImapConfig | null; problems: string[] } {
  const v = (k: string): string => env[`${p}_${k}`] ?? "";
  const host = v("HOST").trim().toLowerCase();
  const user = v("USER").trim();
  const password = v("PASSWORD").trim();
  const oauthName = v("OAUTH").trim().toLowerCase();
  const refreshToken = v("REFRESH_TOKEN").trim();
  if (!host && !user && !password && !oauthName && !refreshToken) return { config: null, problems: [] };
  const problems: string[] = [];
  // Signed in with the provider: a refresh token instead of a password, and the project's client for that provider.
  let oauth: ImapConfig["oauth"];
  if (oauthName || refreshToken) {
    const provider = oauthName === "microsoft" || oauthName === "google" ? oauthName : null;
    const client = provider ? mailClients(env)[provider] : null;
    if (!provider) problems.push("IMAP_OAUTH must be microsoft or google (set by signing in from the panel)");
    else if (!client) problems.push(`IMAP_OAUTH is ${provider}, but no client is set up for it (${provider === "microsoft" ? "PAKO_MS_CLIENT_ID" : "PAKO_GOOGLE_CLIENT_ID"})`);
    if (!/^[\w.~/+=*!-]{16,4000}$/.test(refreshToken)) problems.push("IMAP_REFRESH_TOKEN must be the sign-in kept by connecting the mailbox in the panel");
    const secret = (client as { secret?: string } | null)?.secret;
    if (provider && client) oauth = { provider, clientId: client.id, ...(secret ? { clientSecret: secret } : {}), refreshToken };
  }
  // A name, not an address: the certificate is checked against it.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || host.length > 253) problems.push("IMAP_HOST must be the mail server's name, for example imap.gmail.com");
  if (!user || user.length > 320 || /[\s\u0000-\u001f\u007f]/.test(user)) problems.push("IMAP_USER must be the account's user name, usually its email address");
  if (!oauthName && !refreshToken && (!password || password.length > 500 || /[\u0000-\u001f\u007f]/.test(password))) {
    problems.push("IMAP_PASSWORD must be an app password made for Pako in the account's security settings");
  }
  const rawPort = v("PORT").trim();
  const port = rawPort === "" ? 993 : Number(rawPort);
  // 143 is IMAP without TLS (or with STARTTLS, which a man in the middle can strip): Pako never sends a password that way.
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 143) {
    problems.push("IMAP_PORT must be the server's port for IMAP over TLS (993 almost always); Pako never connects without TLS");
  }
  const folders = v("FOLDERS").split(",").map((f) => f.trim()).filter(Boolean);
  if (!folders.length) folders.push("INBOX");
  // A wildcard would name other folders than the one meant; a control character would break the command line.
  if (folders.length > 10 || folders.some((f) => f.length > 200 || /[\u0000-\u001f\u007f*%]/.test(f))) {
    problems.push("IMAP_FOLDERS must be a comma list of up to 10 folder names, for example INBOX, Work");
  }
  const rawPoll = v("POLL_MINUTES").trim();
  const pollMinutes = rawPoll === "" ? 5 : Number(rawPoll);
  if (!Number.isInteger(pollMinutes) || pollMinutes < 1 || pollMinutes > 1440) problems.push("IMAP_POLL_MINUTES must be a whole number from 1 to 1440");
  // The shared lists are checked (and named when wrong) by Pako's own inbox; a wrong entry here is only left out.
  const filters = loadMailFilters(env);
  const okDomain = (x: string) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(x);
  const okVip = (x: string) => /^([^\s@,]+)?@[a-z0-9.-]+\.[a-z]{2,}$/.test(x);
  if (problems.length) return { config: null, problems: problems.map((x) => x.replaceAll("IMAP_", `${p}_`)) };
  return {
    config: {
      host, port, user, password: oauth ? "" : password, ...(oauth ? { oauth } : {}), folders: [...new Set(folders)], pollMinutes,
      workDomains: filters.workDomains.filter(okDomain), vip: filters.vip.filter(okVip),
    },
    problems,
  };
}

// ---------- the client: only what reading needs ----------

/** What EXAMINE answers. */
export interface ImapMailbox {
  uidValidity: bigint | number | string;
  uidNext?: number | undefined;
  readOnly?: boolean | undefined;
}

export interface ImapFetched {
  uid: number;
  internalDate?: Date | string | undefined;
  source?: Buffer | undefined;
}

/**
 * The calls Pako makes, and no other: `readOnly: true` is the only way to open a folder (EXAMINE), and there is no call that sets a flag,
 * moves, deletes, appends or sends. imapflow's client fits it; the tests give a fake that records each call.
 */
export interface ImapClient {
  connect(): Promise<void>;
  mailboxOpen(path: string, options: { readOnly: true }): Promise<ImapMailbox>;
  search(query: { since: Date; uid?: string }, options: { uid: true }): Promise<number[] | false | undefined>;
  fetchOne(uid: string, query: FetchQuery, options: { uid: true }): Promise<ImapFetched | false>;
  /** The folders and their special use (\\Sent): which one holds the owner's sent mail, for a new account's catch-up. Read only (LIST). */
  list?(): Promise<{ path: string; specialUse?: string | undefined }[]>;
  logout(): Promise<void>;
  close(): void;
  on(event: "error", listener: (err: Error) => void): unknown;
}

/** UID, arrival date and the first bytes of the message, as BODY.PEEK[]<0.n>: PEEK leaves \Seen alone even where a server ignores EXAMINE. */
type FetchQuery = { uid: true; internalDate: true; source: { start: 0; maxLength: number } };

export type ImapConnect = (c: ImapConfig) => ImapClient | Promise<ImapClient>;

/** Bytes of a message read at most: enough for its words (attachments come after them and are only named). */
const SOURCE_MAX = 256 * 1024;

/**
 * imapflow, loaded only when a mailbox is set (a server without IMAP_* never loads it). `tls` may add a trusted certificate (the tests' own
 * server); it can never turn the check off.
 */
export function imapflowConnect(tls: ConnectionOptions = {}): ImapConnect {
  return async (c) => {
    const { ImapFlow } = await import("imapflow");
    const client = new ImapFlow({
      host: c.host,
      port: c.port,
      secure: true,
      // XOAUTH2 with a fresh access token for an account signed in with its provider; the app password otherwise.
      auth: c.accessToken ? { user: c.user, accessToken: c.accessToken } : { user: c.user, pass: c.password },
      tls: { ...tls, minVersion: "TLSv1.2", rejectUnauthorized: true, servername: c.host },
      // imapflow's own log would print every command and answer (the user name with them): Pako logs only what it decides to.
      logger: false,
      // One short look each time: no IDLE kept open, no extensions switched on that reading does not need.
      disableAutoIdle: true,
      disableAutoEnable: true,
      disableCompression: true,
      connectionTimeout: 30_000,
      greetingTimeout: 15_000,
      socketTimeout: 120_000,
    });
    const typed: ImapClient = {
      connect: () => client.connect(),
      mailboxOpen: (path, o) => client.mailboxOpen(path, o),
      search: (q, o) => client.search(q, o),
      fetchOne: (uid, q, o) => client.fetchOne(uid, q, o),
      list: async () => (await client.list()).map((f) => ({ path: f.path, specialUse: f.specialUse })),
      logout: () => client.logout(),
      close: () => client.close(),
      on: (event, listener) => client.on(event, listener),
    };
    return typed;
  };
}

// ---------- a message, made plain ----------

interface Header {
  name: string;
  value: string;
}

const HEADERS_MAX = 300;
const PARTS_MAX = 40;
const DEPTH_MAX = 6;

/** Header and body: at the first empty line (a part that starts with one has no headers). */
function splitHeadBody(raw: string): [string, string] {
  if (/^\r?\n/.test(raw)) return ["", raw.replace(/^\r?\n/, "")];
  const m = /\r?\n\r?\n/.exec(raw);
  return m ? [raw.slice(0, m.index), raw.slice(m.index + m[0].length)] : [raw, ""];
}

/** Header lines, unfolded; at most HEADERS_MAX, each at most 4000 characters. Names as written, values as raw bytes (latin1). */
function headerLines(head: string): Header[] {
  const out: Header[] = [];
  for (const line of head.split(/\r?\n/)) {
    const last = out.at(-1);
    if (/^[ \t]/.test(line)) {
      if (last && last.value.length < 4000) last.value = `${last.value} ${line.trim()}`.slice(0, 4000);
      continue;
    }
    const i = line.indexOf(":");
    if (i <= 0 || i > 100) continue;
    if (out.length >= HEADERS_MAX) break;
    out.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1).trim().slice(0, 4000) });
  }
  return out;
}

const get = (h: Header[], name: string): string => h.find((x) => x.name.toLowerCase() === name)?.value ?? "";

/** Text in a charset the message names; one Node does not know reads as UTF-8 (the usual one), never a failure. */
function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  const label = (charset ?? "").trim().toLowerCase().replace(/^"|"$/g, "") || "utf-8";
  try {
    return new TextDecoder(label === "us-ascii" ? "utf-8" : label).decode(bytes);
  } catch {
    /* a charset this runtime does not know: read as UTF-8 */
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** A raw header (bytes as latin1): UTF-8 when its bytes are (SMTPUTF8, or a sender that skipped encoding), latin1 otherwise. */
function rawHeaderText(s: string): string {
  if (!/[\u0080-ÿ]/.test(s)) return s;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(s, "latin1"));
  } catch {
    /* not UTF-8 read as Latin-1: kept as it was */
    return s;
  }
}

/** Quoted-printable to bytes, in one pass; `header`: the Q of an encoded word, where _ is a space. */
function qpBytes(s: string, header = false): Buffer {
  const src = header ? s.replace(/_/g, " ") : s.replace(/=\r?\n/g, "");
  const out = Buffer.alloc(src.length);
  let n = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 61 && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) {
      out[n++] = Number.parseInt(src.slice(i + 1, i + 3), 16);
      i += 2;
    } else {
      out[n++] = c & 0xff;
    }
  }
  return out.subarray(0, n);
}

const ENCODED_WORD = /=\?([^?\s]{1,40})\?([bBqQ])\?([^?\s]{0,2000})\?=/g;

/** "<", ">" and "@" made from an encoded word in an address header: shown, but never read as address syntax (RFC 2047 5). */
const ADDRESS_SAFE: Record<string, string> = { "<": "‹", ">": "›", "@": "＠" };

/**
 * RFC 2047 encoded words; neighbours in the same charset are joined before decoding (a character may be split across two). `address`: an
 * address header (From, To, Reply-To...), where an encoded word is only ever a name: what it decodes to can never make an address, so
 * a mail whose real From passes its own server's checks cannot show, or be trusted, as someone else's.
 */
export function decodeHeader(raw: string, address = false): string {
  const s = rawHeaderText(raw);
  let out = "";
  let at = 0;
  let charset = "";
  let bytes: Buffer[] = [];
  const flush = () => {
    if (bytes.length) {
      const text = decodeCharset(Buffer.concat(bytes), charset);
      out += address ? text.replace(/[<>@]/g, (c) => ADDRESS_SAFE[c]!) : text;
    }
    bytes = [];
  };
  for (const m of s.matchAll(ENCODED_WORD)) {
    const between = s.slice(at, m.index);
    const cs = m[1]!.replace(/\*.*$/, "").toLowerCase();
    // Space between two encoded words is not part of the text (RFC 2047 6.2).
    const gap = bytes.length > 0 && /^\s*$/.test(between);
    if (!gap) {
      flush();
      out += between;
    } else if (cs !== charset) {
      flush();
    }
    charset = cs;
    bytes.push(m[2]!.toLowerCase() === "b" ? Buffer.from(m[3]!, "base64") : qpBytes(m[3]!, true));
    at = m.index + m[0].length;
  }
  flush();
  return out + s.slice(at);
}

/** `type/subtype; key=value; ...`: the type in lowercase and its parameters (RFC 2231's key*= and key*0= joined and decoded). */
function headerParams(value: string): { type: string; params: Record<string, string> } {
  const pieces: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of value.slice(0, 4000)) {
    if (ch === '"') quoted = !quoted;
    if (ch === ";" && !quoted) {
      pieces.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  pieces.push(cur);
  const params: Record<string, string> = {};
  const extended = new Set<string>();
  for (const p of pieces.slice(1, 30)) {
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    const rawKey = p.slice(0, eq).trim().toLowerCase();
    let v = p.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).replace(/\\(.)/g, "$1");
    const key = rawKey.replace(/\*\d*\*?$/, "");
    if (rawKey.endsWith("*")) extended.add(key);
    params[key] = (params[key] ?? "") + v;
  }
  for (const key of extended) {
    const v = params[key] ?? "";
    const m = /^([^']*)'[^']*'(.*)$/.exec(v);
    // %XX are bytes in the named charset: made bytes first, then decoded once.
    const bytes = (m ? m[2]! : v).replace(/%([0-9a-f]{2})/gi, (_all, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    params[key] = decodeCharset(Buffer.from(bytes, "latin1"), m?.[1]);
  }
  return { type: (pieces[0] ?? "").trim().toLowerCase(), params };
}

/** The parts of a multipart body: between `--boundary` lines, up to the closing `--boundary--` or the end. Linear, at most PARTS_MAX. */
function multipartParts(body: string, boundary: string): string[] {
  const delim = `--${boundary}`;
  const parts: string[] = [];
  let pos = body.startsWith(delim) ? 0 : body.indexOf(`\n${delim}`);
  if (pos < 0) return parts;
  if (pos > 0) pos += 1;
  while (parts.length < PARTS_MAX) {
    const after = pos + delim.length;
    if (body.startsWith("--", after)) break;
    const lineEnd = body.indexOf("\n", after);
    if (lineEnd < 0) break;
    const start = lineEnd + 1;
    const next = body.indexOf(`\n${delim}`, start - 1);
    const end = next < 0 ? body.length : next;
    parts.push(body.slice(start, end).replace(/\r$/, ""));
    if (next < 0) break;
    pos = next + 1;
  }
  return parts;
}

function transferDecode(body: string, encoding: string): Buffer {
  const e = encoding.trim().toLowerCase();
  if (e === "base64") return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (e === "quoted-printable") return qpBytes(body);
  return Buffer.from(body, "latin1");
}

interface Found {
  text?: string;
  html?: string;
  /** The first iCalendar part (an invitation: text/calendar, or an .ics attachment), cut at 256 KB. */
  calendar?: string;
  attachments: string[];
}

function walk(head: string, body: string, depth: number, found: Found): void {
  const h = headerLines(head);
  const ct = headerParams(get(h, "content-type") || "text/plain");
  const disp = headerParams(get(h, "content-disposition"));
  const boundary = ct.params.boundary;
  if (ct.type.startsWith("multipart/")) {
    if (!boundary || depth >= DEPTH_MAX) return;
    for (const part of multipartParts(body, boundary)) {
      const [ph, pb] = splitHeadBody(part);
      walk(ph, pb, depth + 1, found);
    }
    return;
  }
  const name = disp.params.filename ?? ct.params.name;
  // An invitation: its iCalendar part is read (src/invites.ts) as well as named, whether inline or attached.
  const ics = ct.type === "text/calendar" || ct.type === "application/ics" || /\.ics$/i.test(name ?? "");
  if (ics && found.calendar === undefined) {
    found.calendar = decodeCharset(transferDecode(body.slice(0, 400 * 1024), get(h, "content-transfer-encoding")), ct.params.charset).slice(0, 256 * 1024);
  }
  if (name !== undefined || disp.type === "attachment" || !ct.type.startsWith("text/") || ics) {
    // An attachment is only named (the owner reads its name in the summary); a forwarded message is one too.
    if (name !== undefined || disp.type === "attachment") found.attachments.push(decodeHeader(name ?? ct.type).slice(0, 200));
    return;
  }
  const words = () => decodeCharset(transferDecode(body, get(h, "content-transfer-encoding")), ct.params.charset);
  if (ct.type === "text/plain" && found.text === undefined) found.text = words();
  else if (ct.type === "text/html" && found.html === undefined) found.html = words();
}

export interface ParsedMessage {
  messageId: string;
  from: string;
  subject: string;
  /** To, Cc and Delivered-To, decoded. */
  to: string[];
  headers: Header[];
  text?: string;
  html?: string;
  calendar?: string;
  attachments: string[];
}

/** An RFC 822 message (possibly cut at SOURCE_MAX) made into what the mail intake reads. Never throws. */
export function parseMessage(source: Buffer): ParsedMessage {
  const raw = source.subarray(0, SOURCE_MAX).toString("latin1");
  const [head, body] = splitHeadBody(raw);
  const h = headerLines(head);
  const found: Found = { attachments: [] };
  try {
    walk(head, body, 0, found);
  } catch (err) {
    log.error(`a message could not be read whole (${(err as Error).name}): its headers are kept`);
  }
  const addressHeader = (n: string): boolean => /^(from|sender|reply-to|to|cc|bcc|delivered-to|x-original-to|return-path)$/i.test(n);
  const headers = h.map((x) => ({ name: x.name, value: decodeHeader(x.value, addressHeader(x.name)) }));
  const pick = (n: string) => decodeHeader(get(h, n), addressHeader(n));
  return {
    messageId: get(h, "message-id").replace(/\s+/g, "").slice(0, 500),
    from: pick("from"),
    subject: pick("subject"),
    to: headers.filter((x) => /^(to|cc|delivered-to|x-original-to)$/i.test(x.name)).map((x) => x.value),
    headers,
    ...(found.text !== undefined ? { text: found.text } : {}),
    ...(found.html !== undefined ? { html: found.html } : {}),
    ...(found.calendar !== undefined ? { calendar: found.calendar } : {}),
    attachments: found.attachments.slice(0, 10),
  };
}

// ---------- reading ----------

const T = texts(
  {
    auth: "{host} doesn't accept the user name or password for {user}. Use an app password (the account makes one in its security settings), "
      + "not your usual one. I'll try again later.",
    network: "I couldn't reach {host} (port {port}). Check the server name, the port and the internet connection. I'll try again later.",
    tls: "The secure connection to {host} failed: its certificate isn't valid for that name, or it doesn't speak TLS on port {port}. I'll try again later.",
    other: "Something unexpected failed while reading your mail ({user}). I'll try again later.",
    signIn: "Sign in again: {host} no longer takes Pako's sign-in for {user} (it was revoked, the password changed, or it went unused too long).",
    folder: "I can't open the folder “{folder}” in your mail: check its name. The others are still read.",
    logFail: "Your mail by IMAP: {problem}",
    logBack: "Reading your mail again ({user}).",
    connected: "Connected to {address}. I'll tell you about new mail that needs you.",
  },
);

export type FailKind = "auth" | "signIn" | "network" | "tls" | "other";

/** What went wrong, from the error's marks only (its words may quote the server, never the password, but are not trusted to be clean). */
export function failKind(err: unknown): FailKind {
  const e = (err ?? {}) as { authenticationFailed?: unknown; serverResponseCode?: unknown; code?: unknown; tlsFailed?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  // The provider refused to give an access token (src/mail-oauth.ts SignInAgain): only the person can fix it, by signing in again.
  if (code === "EOAUTHSIGNIN") return "signIn";
  const response = typeof e.serverResponseCode === "string" ? e.serverResponseCode.toUpperCase() : "";
  if (e.authenticationFailed === true || response === "AUTHENTICATIONFAILED" || response === "AUTHORIZATIONFAILED") return "auth";
  const message = typeof e.message === "string" ? e.message : "";
  if (e.tlsFailed === true || /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH|ClosedAfterConnectTLS)/.test(code)
    || /certificate|SSL routines|wrong version number|TLS/i.test(message)) return "tls";
  if (/^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|ETIMEOUT|CONNECT_TIMEOUT|GREETING_TIMEOUT|NoConnection|EConnectionClosed)$/.test(code)) {
    return "network";
  }
  return "other";
}

/** Gentler each time: a refused password from 30 minutes to 6 hours (a provider may lock an account that keeps trying), the rest from the poll to an hour. */
export function backoffMinutes(kind: FailKind, failures: number, pollMinutes: number): number {
  const slow = kind === "auth" || kind === "signIn";
  const first = slow ? Math.max(30, pollMinutes) : pollMinutes;
  const most = Math.max(slow ? 360 : 60, pollMinutes);
  return Math.min(first * 2 ** Math.min(Math.max(failures, 1) - 1, 12), most);
}

interface FolderState {
  /** UIDVALIDITY when `last` was read: another one means the UIDs were renumbered. */
  v: string;
  /** The highest UID dealt with (passed on, or skipped as old). */
  last: number;
}

interface ImapState {
  /** Whose mailbox the UIDs are of: another account (or server) starts again. */
  who: string;
  folders: Record<string, FolderState>;
  /**
   * False from the first look at this account until the owner was told it is connected. A state saved before this field existed is an
   * account connected long ago: it counts as told, so an update never says "Connected" out of the blue.
   */
  greeted: boolean;
}

const STATE_KEY = "assistant-imap";
const STATE_TTL_S = 60 * 24 * 3600;
const WINDOW_MS = 24 * 3600_000;
/** Messages taken per folder in one look, oldest first: the rest come at the next. */
const PER_POLL = 50;
/** Messages a new account's catch-up takes per folder, the newest. */
const CATCH_UP_MAX = 300;

/** A sent email's catch-up ref: the second mailbox's carries its address (UID 42 in each is another email); the first's stay as they were. */
export const sentRef = (stateKey: string | undefined, own: string, uid: number): string =>
  stateKey === "assistant-imap2" ? `imap-sent:${own}:${uid}` : `imap-sent:${uid}`;

export interface ImapDeps {
  config: ImapConfig;
  /** Where its place is kept ("assistant-imap"): the second mailbox has its own, so two readers never take each other's state. */
  stateKey?: string;
  /** The owner's other mailbox's address: mail from it is the owner's own here too (not a stranger's to triage). */
  alsoOwn?: string;
  kv: Kv | null;
  box: Mailbox;
  /** The owner's assistant inbox (src/whatsapp.ts). */
  enqueue: (m: Inbound) => Promise<boolean>;
  control?: Control;
  /** imapflow without it. */
  connect?: ImapConnect;
  /** A fresh access token before each look, for an account signed in with its provider (src/mail-oauth.ts createTokenSource). */
  tokens?: () => Promise<string>;
  /** Drops the held access token (src/mail-oauth.ts forget): a login refused with it is tried once with a fresh one. */
  forgetToken?: () => void;
  now?: () => number;
  /** The language of the log's lines and of the card's problem (src/i18n.ts): always English now, kept as a function so callers need not change. */
  lang?: () => Lang;
  /** The watchdog (src/watchdog.ts): whether each look at the mailbox went through (a look skipped while waiting or paused says nothing). */
  health?: HealthReport;
  /** Writes to the owner (Telegram or WhatsApp): only the one line once a new account is connected. */
  notify?: (text: string) => Promise<unknown>;
  /** Invitations caught from the mail (src/invites.ts): shown on the dashboard before the calendar has them. */
  invites?: InviteStore;
  /**
   * A new account's catch-up (src/backfill.ts): its last `days` read quietly, INBOX and Sent, handed there to go out paced. Without it the
   * first look reads the last 24 hours quietly.
   */
  backfill?: Pick<Backfill, "add" | "addSent" | "startLine"> & { days: number };
  /**
   * Each email the owner sent from their own mailbox (the Sent folder): their own words, compared with a draft Pako wrote for that address
   * (src/lessons.ts ownSent). Only the recipients, the words (quoted lines left out) and when.
   */
  ownSent?: (o: { to: string[]; text: string; at: number }) => Promise<unknown>;
  /**
   * Each email the owner sent, after the catch-up (src/mail-followups.ts sent): read whole by the follow-ups, for their promises and for what
   * their reply answers. In a catch-up it goes through the catch-up instead, paced.
   */
  sentMail?: (m: SentMail) => Promise<unknown>;
  /** An email a sender rule filed with no run of Claude, for the follow-ups (src/mail.ts IntakeDeps filed). */
  filed?: IntakeDeps["filed"];
}

export interface PollResult {
  /** "paused": STOP; "waiting": backing off after a failure; "busy": a look already running; "failed": this one failed. */
  skipped?: "paused" | "waiting" | "busy" | "failed";
  queued: number;
  stored: number;
  old: number;
  /** Of `queued`: mail that was already there on a first look, passed on to be kept, never told. */
  quiet: number;
  /** This look finished a new account's first read and told the owner it is connected. */
  connected?: boolean;
  /** Of `quiet`: handed to the catch-up (src/backfill.ts), sent mail included. */
  caughtUp?: number;
}

export function createImapReader(d: ImapDeps) {
  const { config } = d;
  const now = d.now ?? Date.now;
  const lang = d.lang ?? english;
  const connect = d.connect ?? imapflowConnect();
  const who = `${config.user.toLowerCase()}@${config.host}:${config.port}`;
  const own = addressOf(config.user);
  const userDomain = own.includes("@") ? own.split("@").pop()! : "";
  // Where this mailbox lives (Gmail, iCloud, Outlook), for the panel's "Open in…" link: its host, else its address.
  const provider = providerOf(config.host, [config.user]);
  let memory: ImapState | null = null;
  let polling = false;
  let failure: { kind: FailKind; count: number; until: number; ms: number } | null = null;
  /** The failure last said (its kind): the same one again is not said again. */
  let said: FailKind | null = null;
  const badFolders = new Set<string>();
  /** For the panel's row: when the mailbox was last looked at, and how many emails were read on that day (the owner's server's day). */
  let lastLook: number | null = null;
  let today = { day: "", n: 0 };
  // The day in this computer's own zone (it was the UTC day, so "emails read today" started again at UTC midnight: audit finding).
  const dayOf = (t: number): string => new Intl.DateTimeFormat("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
  let timers: { first: ReturnType<typeof setTimeout>; every: ReturnType<typeof setInterval> } | null = null;

  /** The password, and the user name with it, out of any text before it is logged (a server may quote what it was sent). */
  const clean = (s: string): string => {
    let out = s;
    for (const secret of [config.password, encodeURIComponent(config.password), Buffer.from(config.password).toString("base64")]) {
      if (secret.length >= 3) out = out.split(secret).join("***");
    }
    return out.replace(/\s+/g, " ").slice(0, 200);
  };

  const load = async (): Promise<ImapState> => {
    const empty: ImapState = { who, folders: {}, greeted: false };
    if (!d.kv) return memory?.who === who ? memory : empty;
    const raw = await readJsonRecord(d.kv, d.stateKey ?? STATE_KEY);
    if (!raw) return empty;
    try {
      const p = raw as Partial<ImapState>;
      if (p.who !== who || !p.folders || typeof p.folders !== "object") return empty;
      const folders: Record<string, FolderState> = {};
      for (const [k, v] of Object.entries(p.folders)) {
        if (v && typeof v.v === "string" && Number.isInteger(v.last) && v.last >= 0) folders[k] = { v: v.v, last: v.last };
      }
      // Missing (a state from before the greeting): an account connected long ago, already known to the owner.
      return { who, folders, greeted: p.greeted !== false };
    } catch {
      log.error("the stored state could not be used: starting again from the last 24 hours");
      return empty;
    }
  };
  const save = async (s: ImapState): Promise<void> => {
    memory = s;
    if (d.kv) await d.kv.set(d.stateKey ?? STATE_KEY, JSON.stringify(s), STATE_TTL_S);
  };

  const accountOf = (p: ParsedMessage): MailAccount => {
    const to = p.to.join(" ").toLowerCase();
    return config.workDomains.some((dom) => dom === userDomain || to.includes(`@${dom}`)) ? "trabajo" : "personal";
  };

  /** One folder: the new UIDs, each passed on through the mail intake. False when the folder could not be opened. */
  /** Where the owner's sent mail is (the folder with the \\Sent special use): undefined until looked for, null when there is none. */
  let sentPath: string | null | undefined;
  /** In-Reply-To and References of the owner's sent mail in the catch-up: an inbox email they answered is made closed. */
  const answered = new Set<string>();

  /**
   * One folder: the new UIDs, each passed on through the mail intake. False when the folder could not be opened. `catchUp`: a new account's
   * first look, over the catch-up's days instead of 24 hours; `sent`: the owner's Sent folder (read only in a catch-up).
   */
  const readFolder = async (
    client: ImapClient, folder: string, state: ImapState, out: PollResult, o: { catchUp?: boolean; sent?: boolean; firstLook?: boolean } = {},
  ): Promise<boolean> => {
    let box: ImapMailbox;
    try {
      box = await client.mailboxOpen(folder, { readOnly: true });
    } catch (err) {
      const kind = failKind(err);
      // The connection itself went: the whole look fails (and backs off).
      if (kind === "network" || kind === "tls") throw err;
      if (!badFolders.has(folder)) {
        badFolders.add(folder);
        log.error(`could not open the folder "${clean(folder)}" (${kind}): the other folders are still read`);
        d.control?.log("failure", T(lang())("logFail", { problem: T(lang())("folder", { folder }) }));
      }
      return false;
    }
    badFolders.delete(folder);
    const validity = String(box.uidValidity);
    const before = state.folders[folder];
    const fresh = !before || before.v !== validity;
    if (before && fresh) log.info(`the folder "${clean(folder)}" was renumbered (UIDVALIDITY): reading its last 24 hours again, quietly`);
    // A folder looked at for the first time (a new account, a folder added, a renumbering): what is in it was there before Pako watched it,
    // so it is kept without telling the owner. Only mail that arrives after this look can be news. A first look cut short (a dropped
    // connection) goes on just as quietly at the next look: what it had not reached yet was there before Pako watched too.
    const quiet = fresh || !!o.firstLook;
    const last = fresh ? 0 : before.last;
    const windowMs = o.catchUp && d.backfill ? d.backfill.days * 24 * 3600_000 : WINDOW_MS;
    // SINCE counts whole days on the server's clock, and imapflow names the UTC day: a day earlier, so a server west of UTC still finds the
    // first hours of the window. The exact window is checked on each message's arrival time below.
    const since = new Date(now() - windowMs - 24 * 3600_000);
    const found = await client.search(fresh ? { since } : { since, uid: `${last + 1}:*` }, { uid: true });
    // imapflow answers `false` when the server refused the SEARCH (a NO or a BAD, "temporary failure"): that is a failed look, not an empty
    // one. Read as "nothing new" it moved the pointer to the folder's end and the mail that came meanwhile was never read.
    if (found === false) throw Object.assign(new Error("the server refused the search"), { code: "ESEARCHREFUSED" });
    const uids = [...new Set(Array.isArray(found) ? found : [])].filter((u) => Number.isInteger(u) && u > last).sort((a, b) => a - b);
    // A first look takes the newest; later ones the oldest first, so nothing new is skipped.
    const take = fresh ? uids.slice(-(o.catchUp ? CATCH_UP_MAX : PER_POLL)) : uids.slice(0, o.catchUp ? CATCH_UP_MAX : PER_POLL);
    let done = last;
    let completed = false;
    try {
      for (const uid of take) {
        const msg = await client.fetchOne(String(uid), { uid: true, internalDate: true, source: { start: 0, maxLength: SOURCE_MAX } }, { uid: true });
        if (msg && msg.source) {
          const at = msg.internalDate ? new Date(msg.internalDate).getTime() : Number.NaN;
          if (Number.isFinite(at) && at < now() - windowMs) out.old++;
          else if (o.sent) {
            if (await passSent(msg.source, Number.isFinite(at) ? at : now(), uid, !!o.catchUp)) out.caughtUp = (out.caughtUp ?? 0) + 1;
          } else {
            const r = await pass(msg.source, Number.isFinite(at) ? at : now(), folder, validity, uid, quiet, !!o.catchUp, folder === sentPath);
            if (r === "queued") {
              out.queued++;
              if (quiet) out.quiet++;
              if (o.catchUp && d.backfill) out.caughtUp = (out.caughtUp ?? 0) + 1;
            }
            else if (r === "stored") out.stored++;
          }
        }
        done = uid;
      }
      completed = true;
    } finally {
      // What was dealt with is kept even when a later message failed: that one (and those after it) are tried again next time. When all
      // was taken, the pointer moves to the folder's end (UIDs below UIDNEXT that the search left out are older than the window).
      const all = completed && take.length === uids.length;
      const next = all ? Math.max(done, (box.uidNext ?? 0) - 1, last) : done;
      await save({ ...state, folders: { ...state.folders, [folder]: { v: validity, last: Math.max(next, 0) } } });
      state.folders[folder] = { v: validity, last: Math.max(next, 0) };
    }
    return true;
  };

  /** The mail intake both readers of the owner's mailbox share (src/mail-intake.ts): the mailbox, the follow-ups, the lessons, the invitations. */
  const intake = createMailIntake({
    box: d.box, enqueue: d.enqueue, control: d.control, lang, now, vip: config.vip, provider, authServer: config.host, mailbox: own, filed: d.filed, invites: d.invites, ownSent: d.ownSent,
    sentMail: d.sentMail, backfill: d.backfill, log,
  });

  /** A sent email: what it answers is noted for the catch-up, then the shared intake takes it (paced through the catch-up in one). */
  const passSent = async (source: Buffer, at: number, uid: number, catchUp: boolean): Promise<boolean> => {
    const p = parseMessage(source);
    for (const h of p.headers) {
      if (/^(in-reply-to|references)$/i.test(h.name)) for (const m of h.value.match(/<[^<>\s]{1,300}>/g) ?? []) answered.add(m.toLowerCase());
    }
    return intake.sent(p, at, { catchUp, ref: sentRef(d.stateKey, own, uid) });
  };

  /** One message into the shared intake (src/mail-intake.ts, then src/mail.ts takeMail), under this mailbox's own id. */
  const pass = async (
    source: Buffer, at: number, folder: string, validity: string, uid: number, quiet: boolean, catchUp = false, sentFolder = false,
  ): Promise<"queued" | "stored" | "seen" | "own"> => {
    const p = parseMessage(source);
    // The same email in two folders (Gmail's labels) or read again after a renumbering is the same id; the sender's address is part of it, so
    // a stranger who copies another email's Message-ID cannot hide that email.
    const key = p.messageId ? `${own}\n${p.messageId}\n${addressOf(p.from)}` : `${own}\n${folder}\n${validity}\n${uid}`;
    const id = `imap:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
    // A catch-up email the owner already answered is marked so.
    const replied = catchUp && !!p.messageId && answered.has(p.messageId.toLowerCase());
    return intake.inbox(p, at, { id, own: [own, addressOf(d.alsoOwn ?? "")].filter(Boolean), account: accountOf(p), quiet, replied, catchUp, sentFolder });
  };

  const fail = (err: unknown): void => {
    const kind = failKind(err);
    const count = (failure?.kind === kind ? failure.count : 0) + 1;
    const wait = backoffMinutes(kind, count, config.pollMinutes);
    failure = { kind, count, until: now() + wait * 60_000, ms: wait * 60_000 };
    if (said === kind) return;
    said = kind;
    const code = typeof (err as { code?: unknown })?.code === "string" ? ` (${clean((err as { code: string }).code)})` : "";
    const what = { auth: "the login was refused", signIn: "the sign-in must be renewed", network: "cannot connect", tls: "TLS failed", other: "failed" }[kind];
    log.error(`${config.host}: ${what}${code}; trying again in ${wait} min`);
    d.control?.log("failure", T(lang())("logFail", { problem: problemText(kind, lang()) }));
  };

  const problemText = (kind: FailKind, l: Lang): string => T(l)(kind, { host: config.host, port: config.port, user: config.user });

  const poll = async (): Promise<PollResult> => {
    const out: PollResult = { queued: 0, stored: 0, old: 0, quiet: 0 };
    if (polling) return { ...out, skipped: "busy" };
    // Never longer than the backoff itself: a clock put back meanwhile would otherwise add the jump to the wait.
    if (failure && waitLeft(failure.until, failure.ms, now())) return { ...out, skipped: "waiting" };
    polling = true;
    let client: ImapClient | null = null;
    try {
      // STOP holds everything: no login, nothing read. What arrives meanwhile is read after RESUME (within the last 24 hours).
      if (d.control && (await d.control.paused()) !== null) return { ...out, skipped: "paused" };
      // Signed in with the provider: a fresh access token for this login (refreshed when it is about to run out).
      if (config.oauth && !d.tokens) throw Object.assign(new Error("no token source"), { code: "EOAUTHSIGNIN" });
      // The login is `client.connect()`: with imapflow `connect(...)` only builds the client, so a refusal comes from there and the retry below
      // has to cover it. A client whose login failed is closed before the next try.
      const login = async (c: ImapConfig): Promise<ImapClient> => {
        const made = await connect(c);
        // An error after the look (the server closing an idle socket) must not end the process.
        made.on("error", (err) => log.error(`the connection: ${failKind(err)}`));
        try {
          await made.connect();
        } catch (err) {
          try {
            made.close();
          } catch {
            /* already closed */
          }
          throw err;
        }
        return made;
      };
      if (!config.oauth) client = await login(config);
      else {
        try {
          client = await login({ ...config, accessToken: await d.tokens!() });
        } catch (err) {
          // A refused login with a provider's token is not a wrong app password: the held token may have been revoked or rotated before its
          // time. Once with a fresh one; refused again, only a new sign-in mends it.
          if (failKind(err) !== "auth") throw err;
          d.forgetToken?.();
          try {
            client = await login({ ...config, accessToken: await d.tokens!() });
          } catch (again) {
            throw failKind(again) === "auth" ? Object.assign(new Error("the provider's token was refused"), { code: "EOAUTHSIGNIN" }) : again;
          }
        }
      }
      const state = await load();
      // A new account's first look is its catch-up: the last days of the inbox, and of Sent first (what the owner answered closes what was
      // asked of them). Later looks read the configured folders only.
      // Until that first look was whole (not greeted yet), every look goes on with it: one cut short by a dropped connection is not lost.
      const firstLook = !state.greeted;
      const catchUp = !!d.backfill && firstLook;
      // The owner's Sent folder (its special use, \\Sent), found once per process: read at every look, quietly, so a reply sent from Outlook,
      // Mail or a phone closes what it answers within one look, not only during the first catch-up.
      // A LIST that failed says nothing: it is asked again at the next look.
      if (sentPath === undefined && client.list) {
        const listed = await client.list().catch(() => null);
        if (listed) sentPath = listed.find((f) => /\\sent/i.test(f.specialUse ?? ""))?.path ?? null;
      }
      if (sentPath && !config.folders.includes(sentPath)) await readFolder(client, sentPath, state, out, { catchUp, sent: true, firstLook });
      // The Sent folder named in IMAP_FOLDERS too is still the owner's own mail: read first and as Sent, never as news (an alias in From is
      // theirs), so a catch-up knows what they answered before it reads the inbox.
      const order = [...config.folders].sort((a, b) => Number(b === sentPath) - Number(a === sentPath));
      for (const folder of order) await readFolder(client, folder, state, out, { catchUp, firstLook, sent: !!sentPath && folder === sentPath });
      await client.logout().catch(() => undefined);
      client = null;
      // A new account read whole for the first time: one calm line, once. Kept as told before it is sent, so a failing send is never repeated
      // at every look (the panel shows the account as connected anyway).
      if (!state.greeted && Object.keys(state.folders).length) {
        state.greeted = true;
        await save({ ...state });
        out.connected = true;
        if (d.notify) {
          const n = out.caughtUp ?? 0;
          await d.notify(d.backfill && n ? d.backfill.startLine(config.user, n) : T(lang())("connected", { address: config.user })).catch((err: unknown) => {
            log.error(`could not tell the owner the mailbox is connected: ${(err as Error)?.name ?? "error"}`);
          });
        }
      }
      if (said) {
        log.info(`${config.host}: reading again`);
        d.control?.log("mail", T(lang())("logBack", { user: config.user }));
      }
      failure = null;
      said = null;
      d.health?.(true);
      if (out.queued || out.stored) log.info(`${out.queued} email(s) passed on (${out.quiet} quietly), ${out.stored} kept as mass mail`);
      lastLook = now();
      const day = dayOf(lastLook);
      today = { day, n: (today.day === day ? today.n : 0) + out.queued + out.stored };
      return out;
    } catch (err) {
      fail(err);
      lastLook = now();
      d.health?.(false, problemText(failKind(err), lang()));
      return { ...out, skipped: "failed" };
    } finally {
      if (client) {
        try {
          client.close();
        } catch {
          /* already closed */
        }
      }
      polling = false;
    }
  };

  return {
    poll,
    /** The first look half a minute after the start, then every IMAP_POLL_MINUTES. */
    start: (): void => {
      if (timers) return;
      const first = setTimeout(() => void poll(), 30_000);
      const every = setInterval(() => void poll(), config.pollMinutes * 60_000);
      first.unref?.();
      every.unref?.();
      timers = { first, every };
    },
    stop: (): void => {
      if (!timers) return;
      clearTimeout(timers.first);
      clearInterval(timers.every);
      timers = null;
    },
    /** What the panel's Connections card says is wrong now; null when the last look worked. */
    problem: (l: Lang): string | null => {
      if (failure) return problemText(failure.kind, l);
      const folder = [...badFolders][0];
      return folder ? T(l)("folder", { folder }) : null;
    },
    /** The account, for the assistant's context and the panel (the user name, never the password). */
    address: config.user,
    /** The panel's row: the server, the folders, the last look, the emails read today and what is wrong now. Never the password. */
    info: (l: Lang) => ({
      address: config.user,
      host: config.host,
      port: config.port,
      folders: [...config.folders],
      pollMinutes: config.pollMinutes,
      lastCheck: lastLook,
      readToday: lastLook !== null && today.day === dayOf(now()) ? today.n : 0,
      lastError: failure ? problemText(failure.kind, l) : [...badFolders][0] ? T(l)("folder", { folder: [...badFolders][0]! }) : null,
    }),
  };
}

export type ImapReader = ReturnType<typeof createImapReader>;
