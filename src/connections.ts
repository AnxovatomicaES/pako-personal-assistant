// What can be connected from the panel on a person's computer, and where its values are kept (src/connections-panel.ts has the routes).
//
// The catalogue: each connection's settings (the same environment variables docs/configuration.md documents) and a short how-to.
// Telegram has its own card (src/telegram-panel.ts): it is listed here only to point at it. The phone line stays out: it is advanced, and
// its steps are in docs/personal-caller.md.
//
// The store: the values set in the panel are kept beside the other secrets (src/secrets.ts: the system's secret store, or ~/.pako/secrets.json) under "settings". At start,
// before anything reads the environment (src/server.ts), applyStoredSettings puts them in it, but only where nothing is set: a value in the
// shell, ~/.pako/.env or ./.env wins, and the panel says so. A value is never sent back to the browser: the card shows that it is set and,
// for a long one, its last four characters.

import { join } from "node:path";
import { texts, type Lang } from "./i18n.ts";
import { ICS_SETTING } from "./ics.ts";
import { loadAppleMailConfig } from "./apple-mail.ts";
import { loadImapConfig } from "./imap.ts";
import { loadImessageConfig } from "./imessage.ts";
import { loadMailConfig } from "./mail.ts";
import { loadResendConfig } from "./resend.ts";
import { readSecrets as readAllSecrets, writeSecrets } from "./secrets.ts";
import { loadSlackConfig } from "./slack.ts";
import { loadGoogleCalendarConfig } from "./google-calendar.ts";
import { loadTeamsConfig } from "./teams.ts";
import { loadZoomConfig } from "./zoom.ts";
import { createLog } from "./log.ts";

const log = createLog("connections");

type Env = Record<string, string | undefined>;

export type ConnectionId =
  | "claude" | "calendar" | "google" | "mail" | "imap" | "applemail" | "resend" | "slack" | "zoom" | "teams" | "imessage" | "tables" | "telegram"
  | "whatsapp";

interface FieldDef {
  key: string;
  optional?: true;
  /** A password the person chose or was given in full (no recognisable prefix): no tail of it ever leaves the server. */
  password?: true;
}

interface ConnectionDef {
  id: ConnectionId;
  /** A Lucide icon name for the card. */
  icon: string;
  fields: FieldDef[];
  /**
   * The values this connection would start with, checked as its own module checks them at start: the keys that are wrong. Only the shape:
   * whether the service accepts them is a live check (src/connections-panel.ts), where one is cheap.
   */
  check?: (env: Env) => string[];
  /** Set up in another card of the panel instead. */
  card?: "telegram" | "whatsapp";
}

/** The keys named at the start of a module's problem sentences ("AGENTMAIL_INBOX must be..."); one naming none counts against the first. */
const blame = (problems: string[], fields: FieldDef[]): string[] =>
  problems.map((p) => fields.find((f) => p.startsWith(f.key))?.key ?? fields.find((f) => p.includes(f.key))?.key ?? fields[0]!.key);

const shaped = (key: string, re: RegExp) => (env: Env): string[] => (re.test((env[key] ?? "").trim()) ? [] : [key]);

/** An ICS link as Pako keeps it: webcal:// (Apple's way of writing it) is the same address over https. Null when it is not an https link. */
export function icsLink(raw: string): string | null {
  const v = raw.trim().replace(/^webcals?:\/\//i, "https://");
  if (v.length > 2000 || /\s/.test(v)) return null;
  try {
    const u = new URL(v);
    // A user name or password in the link would be sent along with every request, and shown in logs: the calendar's own private link has none.
    return u.protocol === "https:" && u.hostname && !u.username && !u.password ? u.href : null;
  } catch {
    /* not a link */
    return null;
  }
}

const MAIL: FieldDef[] = [
  { key: "AGENTMAIL_API_KEY" },
  { key: "AGENTMAIL_INBOX" },
  { key: "AGENTMAIL_POLL_MINUTES", optional: true },
  { key: "AGENTMAIL_WORK_DOMAINS", optional: true },
  { key: "AGENTMAIL_VIP", optional: true },
];
// Sending from Pako's own domain (src/resend.ts): send only. The key is a secret like the others (kept by src/secrets.ts in the system's
// store, service "Pako"); the sender and the reply-to are plain addresses.
const RESEND: FieldDef[] = [
  { key: "RESEND_API_KEY" },
  { key: "RESEND_FROM" },
  { key: "RESEND_REPLY_TO", optional: true },
];
// The owner's own mailbox, read only (src/imap.ts). The VIP senders and work domains are the mail card's: one list for both mailboxes.
const IMAP: FieldDef[] = [
  { key: "IMAP_HOST" },
  { key: "IMAP_USER" },
  // A password, or (Microsoft, Google) a sign-in with the provider kept as a refresh token (src/mail-oauth.ts): one or the other.
  { key: "IMAP_PASSWORD", optional: true, password: true },
  { key: "IMAP_OAUTH", optional: true },
  { key: "IMAP_REFRESH_TOKEN", optional: true, password: true },
  { key: "IMAP_PORT", optional: true },
  { key: "IMAP_FOLDERS", optional: true },
  { key: "IMAP_POLL_MINUTES", optional: true },
];
// Connecting Slack from the panel (src/connect-setup.ts) keeps the user token and the app's Client ID, and Pako looks for new messages
// itself. The app-level token (Socket Mode, live) and the signing secret (a server's events address) are optional extras.
const SLACK: FieldDef[] = [
  { key: "SLACK_USER_TOKEN" },
  { key: "SLACK_CLIENT_ID", optional: true },
  { key: "SLACK_APP_TOKEN", optional: true },
  { key: "SLACK_SIGNING_SECRET", optional: true, password: true },
  { key: "SLACK_QUIET_HOURS", optional: true },
];
// Connecting Zoom from the panel (src/connect-setup.ts) keeps the app's Client ID and the refresh token of the person's Allow. A
// Server-to-Server app (a server's way) needs the account, the secret and the email instead; src/zoom.ts checks whichever is set.
const ZOOM: FieldDef[] = [
  { key: "ZOOM_CLIENT_ID" },
  { key: "ZOOM_REFRESH_TOKEN", optional: true, password: true },
  { key: "ZOOM_ACCOUNT_ID", optional: true },
  { key: "ZOOM_CLIENT_SECRET", optional: true, password: true },
  { key: "ZOOM_USER", optional: true },
  { key: "ZOOM_POLL_MINUTES", optional: true },
];

// Microsoft Teams, connected with one button (src/teams-connect.ts, src/teams.ts): the sign-in, the app it was made with, and who it is.
const TEAMS: FieldDef[] = [
  { key: "TEAMS_REFRESH_TOKEN", password: true },
  { key: "TEAMS_CLIENT_ID" },
  { key: "TEAMS_ACCOUNT", optional: true },
  { key: "TEAMS_NAME", optional: true },
  { key: "TEAMS_ORG", optional: true },
  { key: "TEAMS_TENANT", optional: true },
  { key: "TEAMS_POLL_MINUTES", optional: true },
];

// Mail on this Mac (src/apple-mail.ts): one switch, turned on in its card; read only, from what Apple Mail already downloaded. No password.
const APPLE_MAIL: FieldDef[] = [
  { key: "APPLE_MAIL" },
  { key: "APPLE_MAIL_POLL_MINUTES", optional: true },
];

// Messages on this Mac (src/imessage.ts): one switch, turned on in its card; read only, from the history macOS keeps for Messages.
const IMESSAGE: FieldDef[] = [
  { key: "IMESSAGE" },
  { key: "IMESSAGE_POLL_MINUTES", optional: true },
];

// Google Calendar, connected with one button (src/mail-oauth.ts, src/google-calendar.ts): the sign-in, and whose calendar it is.
const GOOGLE: FieldDef[] = [
  { key: "GOOGLE_REFRESH_TOKEN", password: true },
  { key: "GOOGLE_ACCOUNT", optional: true },
];

/** The calendar's links (read at start by src/ics.ts, which feeds src/calendar.ts): checked as that module checks them, several allowed. */
const ICS = ICS_SETTING.name;

export const CATALOGUE: readonly ConnectionDef[] = [
  // The claude command signed in with a Claude plan is the default and needs nothing: the key is for paying by use instead. The bridge passes
  // ANTHROPIC_* on to claude (assistant/bridge.ts childEnv).
  { id: "claude", icon: "sparkles", fields: [{ key: "ANTHROPIC_API_KEY" }], check: shaped("ANTHROPIC_API_KEY", /^sk-ant-[A-Za-z0-9_-]{20,300}$/) },
  { id: "calendar", icon: "calendar", fields: [{ key: ICS }], check: (env) => ((env[ICS] ?? "").trim() && !ICS_SETTING.check(env[ICS] ?? "").length ? [] : [ICS]) },
  { id: "google", icon: "calendar", fields: GOOGLE, check: (env) => blame(loadGoogleCalendarConfig(env).problems, GOOGLE) },
  { id: "mail", icon: "mail", fields: MAIL, check: (env) => blame(loadMailConfig(env).problems, MAIL) },
  { id: "imap", icon: "inbox", fields: IMAP, check: (env) => blame(loadImapConfig(env).problems, IMAP) },
  { id: "applemail", icon: "mail", fields: APPLE_MAIL, check: (env) => blame(loadAppleMailConfig(env).problems, APPLE_MAIL) },
  { id: "resend", icon: "send", fields: RESEND, check: (env) => blame(loadResendConfig(env).problems, RESEND) },
  { id: "slack", icon: "hash", fields: SLACK, check: (env) => blame(loadSlackConfig(env).problems, SLACK) },
  { id: "zoom", icon: "video", fields: ZOOM, check: (env) => blame(loadZoomConfig(env).problems, ZOOM) },
  { id: "teams", icon: "users", fields: TEAMS, check: (env) => blame(loadTeamsConfig(env).problems, TEAMS) },
  { id: "imessage", icon: "message-square", fields: IMESSAGE, check: (env) => blame(loadImessageConfig(env).problems, IMESSAGE) },
  { id: "tables", icon: "utensils", fields: [{ key: "GOOGLE_PLACES_API_KEY" }], check: shaped("GOOGLE_PLACES_API_KEY", /^AIza[0-9A-Za-z_-]{35}$/) },
  { id: "telegram", icon: "send", fields: [], card: "telegram" },
  // WhatsApp has its own card (src/whatsapp-computer.ts, src/panel/whatsapp.js): five guided steps.
  { id: "whatsapp", icon: "message-circle", fields: [], card: "whatsapp" },
];

/** Every key the panel may set: nothing else in the file is ever put in the environment (not NODE_OPTIONS, not PAKO_LOCAL). */
export const KEYS: ReadonlySet<string> = new Set(CATALOGUE.flatMap((c) => c.fields.map((f) => f.key)));

export const findConnection = (id: unknown): ConnectionDef | undefined => CATALOGUE.find((c) => c.id === id);

/** The words of the catalogue. The how-tos name the places to click as the services name them. */
export const WORDS = texts(
  {
    "claude.name": "Claude with an API key",
    "claude.how": "Not needed: Pako uses the claude command signed in with your Claude plan (Pro or Max) on this computer. If you'd rather pay "
      + "by use, make a key at console.anthropic.com (API Keys) and paste it here: claude will use it instead of your sign-in.",
    "calendar.name": "Calendar (ICS link)",
    "calendar.how": "Your calendar's private link in iCal format. Google Calendar: Settings, your calendar, \"Secret address in iCal format\". "
      + "Outlook: Calendar, Share, Publish, ICS link. iCloud: share the calendar as public and copy its link. Pako only reads it.",
    "mail.name": "Pako's mail (AgentMail)",
    "mail.how": "An inbox of Pako's own: make an account at agentmail.to, an inbox (its address is something@agentmail.to) and an API key. "
      + "Forward there what you want Pako to read; on this computer it looks at the inbox every few minutes.",
    "google.name": "Google Calendar",
    "google.how": "Press Connect Google Calendar in the Calendar card and allow it on Google's page. Pako reads your events; nothing to copy.",
    "GOOGLE_REFRESH_TOKEN": "Sign-in",
    "GOOGLE_REFRESH_TOKEN.hint": "Kept by connecting Google Calendar in the Calendar card",
    "GOOGLE_ACCOUNT": "Google account",
    "GOOGLE_ACCOUNT.hint": "The address that signed in",
    "slack.name": "Slack",
    "slack.how": "Press Connect in the Slack card: Pako opens Slack with a read-only app already written, you press Create, paste its Client ID and press Allow. No token to copy.",
    "teams.name": "Microsoft Teams",
    "teams.how": "Press Connect Teams in the Teams card and allow it on Microsoft's page. Pako reads your chats, read only; nothing to copy.",
    "TEAMS_REFRESH_TOKEN": "Sign-in",
    "TEAMS_REFRESH_TOKEN.hint": "Kept by connecting Teams in the Teams card; Pako renews it by itself",
    "TEAMS_CLIENT_ID": "Microsoft app",
    "TEAMS_CLIENT_ID.hint": "The Application (client) ID it signed in with",
    "TEAMS_ACCOUNT": "Account",
    "TEAMS_ACCOUNT.hint": "The address that signed in",
    "TEAMS_NAME": "Name",
    "TEAMS_NAME.hint": "Your name in Teams",
    "TEAMS_ORG": "Organisation",
    "TEAMS_ORG.hint": "Your company's name in Microsoft 365",
    "TEAMS_TENANT": "Tenant",
    "TEAMS_TENANT.hint": "Your company's Microsoft 365 directory ID",
    "TEAMS_POLL_MINUTES": "Look every (minutes)",
    "TEAMS_POLL_MINUTES.hint": "From 2 to 60; 5 when empty",
    "applemail.name": "Mail on this Mac",
    "applemail.how": "On a Mac: turn it on in the Mail on this Mac card. Pako reads the mail Apple Mail already downloaded, read only and with "
      + "no password, and needs Full Disk Access for that (System Settings › Privacy & Security › Full Disk Access).",
    "APPLE_MAIL": "Read Mail on this Mac",
    "APPLE_MAIL.hint": "on or off",
    "APPLE_MAIL_POLL_MINUTES": "Look every (minutes)",
    "APPLE_MAIL_POLL_MINUTES.hint": "From 1 to 60; 3 when empty",
    "imessage.name": "Messages (iMessage and SMS)",
    "imessage.how": "On a Mac: turn it on in the Messages card. Pako reads your Messages history on this Mac, read only, for promises made "
      + "both ways, and needs Full Disk Access for that (System Settings › Privacy & Security › Full Disk Access).",
    "IMESSAGE": "Read Messages",
    "IMESSAGE.hint": "on or off",
    "IMESSAGE_POLL_MINUTES": "Look every (minutes)",
    "IMESSAGE_POLL_MINUTES.hint": "From 1 to 60; 2 when empty",
    "zoom.name": "Zoom",
    "zoom.how": "Press Connect in the Zoom card: Pako gives you a ready-made app file for marketplace.zoom.us, you paste its Client ID and press Allow. No secret to copy.",
    "tables.name": "Table booking (Google Places)",
    "tables.how": "A Google Places API (New) key from console.cloud.google.com. Google bills each search (a few cents). To ask for a table by "
      + "email, connect Pako's mail too.",
    "telegram.name": "Telegram",
    "telegram.how": "Telegram has its own card in this panel: set the bot there and pair your phone with a QR code.",
    "whatsapp.name": "WhatsApp",
    "whatsapp.how": "WhatsApp has its own card in this panel: five guided steps with Meta's official API.",
    "phone": "The phone line is advanced and isn't connected from here: its steps are in docs/personal-caller.md.",
    "ANTHROPIC_API_KEY": "API key",
    "ANTHROPIC_API_KEY.hint": "It starts with sk-ant-",
    "CALENDAR_ICS_URL": "ICS link",
    "CALENDAR_ICS_URL.hint": "An https:// (or webcal://) address, usually ending in .ics",
    "AGENTMAIL_API_KEY": "API key",
    "AGENTMAIL_API_KEY.hint": "The one from AgentMail's console",
    "AGENTMAIL_INBOX": "Inbox",
    "AGENTMAIL_INBOX.hint": "Its address, for example pako@agentmail.to",
    "AGENTMAIL_POLL_MINUTES": "How often it looks, in minutes",
    "AGENTMAIL_POLL_MINUTES.hint": "From 1 to 1440; empty, 10",
    "AGENTMAIL_WORK_DOMAINS": "Your work's domains",
    "AGENTMAIL_WORK_DOMAINS.hint": "Separated by commas, for example company.com",
    "AGENTMAIL_VIP": "Senders who always alert you",
    "AGENTMAIL_VIP.hint": "Addresses or @domains, separated by commas",
    "resend.name": "Sending from your domain (Resend)",
    "resend.how": "Pako sends the emails you ask for from an address on your own domain, through resend.com: add and verify the domain there, "
      + "make an API key and paste it here with the sender. Resend only sends: Pako still reads mail through its inbox or yours. Without it, "
      + "emails go out from Pako's AgentMail inbox as before.",
    "RESEND_API_KEY": "API key",
    "RESEND_API_KEY.hint": "It starts with re_",
    "RESEND_FROM": "Sender",
    "RESEND_FROM.hint": "On your verified domain, for example Pako <hello@example.com>",
    "RESEND_REPLY_TO": "Replies go to",
    "RESEND_REPLY_TO.hint": "One address; empty, Pako's AgentMail inbox when it has one",
    "imap.name": "Your mail (IMAP, read only)",
    "imap.how": "Pako reads your own mailbox without you forwarding anything: it only reads, and never marks anything as read, moves, deletes or "
      + "sends. Give your provider's IMAP server (Gmail: imap.gmail.com; Outlook: outlook.office365.com; iCloud: imap.mail.me.com), your address "
      + "and an app password made for Pako in your account's security settings (not your usual password). Senders who always alert you and your "
      + "work's domains are set in the card for Pako's mail. If you forward this mailbox to Pako's inbox, stop forwarding it: otherwise the "
      + "same email may come twice.",
    "IMAP_HOST": "IMAP server",
    "IMAP_HOST.hint": "For example imap.gmail.com",
    "IMAP_USER": "User name",
    "IMAP_USER.hint": "Usually your email address",
    "IMAP_OAUTH": "Signed in with",
    "IMAP_OAUTH.hint": "microsoft or google, set by signing in from the mail card",
    "IMAP_REFRESH_TOKEN": "Sign-in",
    "IMAP_REFRESH_TOKEN.hint": "Kept by signing in from the mail card; Pako renews it by itself",
    "IMAP_PASSWORD": "App password",
    "IMAP_PASSWORD.hint": "The one your account makes for an app, not your usual one",
    "IMAP_PORT": "Port",
    "IMAP_PORT.hint": "With TLS; empty, 993",
    "IMAP_FOLDERS": "Folders",
    "IMAP_FOLDERS.hint": "Separated by commas; empty, INBOX",
    "IMAP_POLL_MINUTES": "How often it looks, in minutes",
    "IMAP_POLL_MINUTES.hint": "From 1 to 1440; empty, 5",
    "SLACK_USER_TOKEN": "User OAuth Token",
    "SLACK_USER_TOKEN.hint": "It starts with xoxp-",
    "SLACK_CLIENT_ID": "Client ID",
    "SLACK_CLIENT_ID.hint": "Your Slack app's, from connecting in the Slack card",
    "SLACK_APP_TOKEN": "App-Level Token (Socket Mode)",
    "SLACK_APP_TOKEN.hint": "It starts with xapp-",
    "SLACK_SIGNING_SECRET": "Signing Secret",
    "SLACK_SIGNING_SECRET.hint": "For a server only; not needed on this computer",
    "SLACK_QUIET_HOURS": "Quiet hours",
    "SLACK_QUIET_HOURS.hint": "Like 23:00-08:00, or off; empty, 23:00-08:00",
    "ZOOM_REFRESH_TOKEN": "Refresh token",
    "ZOOM_REFRESH_TOKEN.hint": "Kept by connecting in the Zoom card; Pako renews it by itself",
    "ZOOM_ACCOUNT_ID": "Account ID",
    "ZOOM_ACCOUNT_ID.hint": "The app's",
    "ZOOM_CLIENT_ID": "Client ID",
    "ZOOM_CLIENT_ID.hint": "The app's",
    "ZOOM_CLIENT_SECRET": "Client Secret",
    "ZOOM_CLIENT_SECRET.hint": "The app's",
    "ZOOM_USER": "Your Zoom email",
    "ZOOM_USER.hint": "Your Zoom account's",
    "ZOOM_POLL_MINUTES": "How often it looks, in minutes",
    "ZOOM_POLL_MINUTES.hint": "From 2 to 1440; empty, 10",
    "GOOGLE_PLACES_API_KEY": "API key",
    "GOOGLE_PLACES_API_KEY.hint": "It starts with AIza",
  },
);
type WordKey = Parameters<ReturnType<typeof WORDS>>[0];

// ---------- the store ----------

const FILE = "secrets.json";

/** Every secret, wherever it is kept (src/secrets.ts); null when they cannot be read (writing then would lose the others: the panel's, the bot's). */
const readSecrets = (dir: string): Record<string, unknown> | null => readAllSecrets(dir);

/** The values set in the panel: catalogue keys with text values only. Null when the file cannot be read. */
export function readStored(dir: string): Record<string, string> | null {
  const all = readSecrets(dir);
  if (!all) return null;
  const s = all.settings;
  const out: Record<string, string> = {};
  if (s && typeof s === "object" && !Array.isArray(s)) {
    for (const [k, v] of Object.entries(s as Record<string, unknown>)) if (KEYS.has(k) && typeof v === "string" && v.trim()) out[k] = v;
  }
  return out;
}

/**
 * Sets (a text) or removes (null) panel values, keeping every other secret. Written where they are kept (src/secrets.ts): the file is
 * written whole and renamed over the old one, a store gets the new value before the marker names it. False when it could not be read or
 * written (nothing is changed then).
 */
export function writeStored(dir: string, patch: Record<string, string | null>): boolean {
  const all = readSecrets(dir);
  if (!all) return false;
  const now = all.settings && typeof all.settings === "object" && !Array.isArray(all.settings) ? { ...(all.settings as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (!KEYS.has(k)) continue;
    if (v === null) delete now[k];
    else now[k] = v;
  }
  try {
    writeSecrets(dir, { ...all, settings: now });
  } catch (err) {
    // Only the code: nothing about the values may reach the terminal.
    log.error(`could not save ${join(dir, FILE)} (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    return false;
  }
  return true;
}

/** The keys this process took from the store at start (applyStoredSettings): any other value in the environment came from outside. */
const fromStoreAtStart = new Set<string>();
export const appliedAtStart = (): ReadonlySet<string> => fromStoreAtStart;

/**
 * Puts the panel's values in the environment where nothing is set (a blank `KEY=` in a file counts as nothing, as in src/local.ts localEnv).
 * Called once at start, before the settings are read. Returns the keys it set.
 */
export function applyStoredSettings(dir: string, env: Env): string[] {
  const stored = readStored(dir);
  if (stored === null) log.error(`could not read ${join(dir, FILE)}: the connections set in the panel are off until it can be`);
  const applied: string[] = [];
  for (const [k, v] of Object.entries(stored ?? {})) {
    if ((env[k] ?? "").trim()) continue;
    env[k] = v;
    applied.push(k);
    fromStoreAtStart.add(k);
  }
  return applied;
}

// ---------- what the card shows ----------

export interface FieldState {
  key: string;
  label: string;
  hint: string;
  optional: boolean;
  /** Set (here or outside). */
  set: boolean;
  /** The last four characters of a long token, so a person can tell which one it is; never more, never of a password. */
  tail?: string;
  /** "panel": kept by the panel; "outside": the shell, ~/.pako/.env or ./.env, which wins, and the panel cannot change it. */
  from: "panel" | "outside" | null;
}

export interface ConnectionState {
  id: ConnectionId;
  name: string;
  icon: string;
  how: string;
  /** "on": every required value is set; "partial": some are; "off": none. */
  state: "on" | "partial" | "off";
  fields: FieldState[];
  card?: "telegram" | "whatsapp";
  /** What is wrong with it while Pako runs (a refused login), absent when nothing is. */
  problem?: string;
  /**
   * For a connection with no live check when it is saved (a calendar link, a Places key): whether its service has answered once. False: saved,
   * not tried yet (the settings page then says so instead of "connected"). Absent when Pako does not know.
   */
  checked?: boolean;
}

/** Long values only: the last four of a short one (a number of minutes) would be most of it. */
export const tailOf = (v: string): string | undefined => (v.length >= 12 ? v.slice(-4) : undefined);

/**
 * Each connection with its state. `env`: the environment now; `stored`: the panel's values (null: the file cannot be read); `fromStore`: the
 * keys this process took from the store at start.
 */
export function connectionStates(o: {
  env: Env;
  stored: Record<string, string> | null;
  fromStore: ReadonlySet<string>;
  lang: Lang;
  /** What each running connection says is wrong now (src/imap.ts problem). */
  problems?: Partial<Record<ConnectionId, string | null>>;
  /** Whether a connection with no live check has answered once (ConnectionState.checked). */
  checked?: Partial<Record<ConnectionId, boolean>>;
}): ConnectionState[] {
  const w = WORDS(o.lang);
  return CATALOGUE.map((c) => {
    const fields = c.fields.map((f): FieldState => {
      const running = (o.env[f.key] ?? "").trim();
      const outside = !!running && !o.fromStore.has(f.key);
      const value = outside ? running : (o.stored?.[f.key] ?? "");
      const tail = value && !f.password ? tailOf(value) : undefined;
      return {
        key: f.key,
        label: w(f.key as WordKey),
        hint: w(`${f.key}.hint` as WordKey),
        optional: !!f.optional,
        set: !!value,
        ...(tail ? { tail } : {}),
        from: outside ? "outside" : value ? "panel" : null,
      };
    });
    const required = fields.filter((f) => !f.optional);
    const set = required.filter((f) => f.set).length;
    return {
      id: c.id,
      name: w(`${c.id}.name` as WordKey),
      icon: c.icon,
      how: w(`${c.id}.how` as WordKey),
      state: c.card ? "off" : set === required.length ? "on" : set || fields.some((f) => f.set) ? "partial" : "off",
      fields,
      ...(c.card ? { card: c.card } : {}),
      ...(o.problems?.[c.id] ? { problem: o.problems[c.id]! } : {}),
      ...(typeof o.checked?.[c.id] === "boolean" ? { checked: o.checked[c.id]! } : {}),
    };
  });
}
