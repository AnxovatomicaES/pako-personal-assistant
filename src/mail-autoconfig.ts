// The owner's own mailbox in two steps: their address, then one app password. Pako works out the rest (src/imap.ts reads it).
//
// - Where the mail server is: a built-in table for the big providers (iCloud, Gmail, Outlook, Yahoo, Fastmail, Zoho); else Mozilla's
//   database (autoconfig.thunderbird.net, asked for the domain only, never the address); else the domain's own autoconfig file; else its MX
//   records (a company mailbox at Google or Microsoft); else imap.<domain>, said to be a guess. Within four seconds each, kept for a day (a guess made offline is not kept).
// - The app password: where to make it and the exact steps, per provider, in English; what must be on first (2-step verification), and
//   what to do when the provider refuses it. A work account at Microsoft 365 or Google Workspace (found by its MX) is told plainly that its
//   organisation may block IMAP with a password, and offered forwarding: an app password cannot change that.
// - Then a live login (read only, nothing opened) before anything is kept, with an error that says what to do: "That password doesn't work: Gmail
//   needs an app password". The values then go where the IMAP card keeps them (src/connections-panel.ts).
//
//   GET  /panel/api/mail/autoconfig?address=x  -> { host, port, tls, username, provider, source, work, appPassword: { needed, url, steps[] },
//                                                   before, refused, note? }
//   POST /panel/api/mail/connect               { address, password, host?, port?, username? } -> { ok, restarting } | { ok: false, error, why }

import { resolveMx as dnsMx } from "node:dns/promises";
import express, { type Express } from "express";
import { emailOf, guard, isObject, limit, line, localOnly, type RouteAuth, within } from "./connect-routes.ts";
import type { ConnectionsSaver } from "./connections-panel.ts";
import { mailSlot, WORDS } from "./connections.ts";
import { texts, type Lang } from "./i18n.ts";
import { failKind, type ImapConfig, type ImapConnect, imapflowConnect, type FailKind } from "./imap.ts";
import { guardedGet, type Resolver } from "./public-fetch.ts";

export type MailProvider = "icloud" | "google" | "microsoft" | "yahoo" | "fastmail" | "zoho" | "other";

export interface AutoConfig {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  provider: MailProvider;
  /** Where it came from: "builtin", "ispdb", "autoconfig", "mx", or "guess" (imap.<domain>, unchecked). */
  source: "builtin" | "ispdb" | "autoconfig" | "mx" | "guess";
  appPassword: { needed: boolean; url: string | null; steps: string[] };
  /** A company's own domain at a big provider (found by its MX): Microsoft 365 or Google Workspace, whose admin decides about IMAP. */
  work: boolean;
  /** What must be on before the app password page shows (2-step verification); null when nothing. */
  before: string | null;
  /** What to do when the provider refuses the password: the likely reason and the other way (forwarding). */
  refused: string;
  /** A word of warning for this provider, in the asked language. */
  note?: string;
}

interface Server {
  host: string;
  provider: MailProvider;
}

const SERVERS: Record<Exclude<MailProvider, "other">, Server> = {
  icloud: { host: "imap.mail.me.com", provider: "icloud" },
  google: { host: "imap.gmail.com", provider: "google" },
  microsoft: { host: "outlook.office365.com", provider: "microsoft" },
  yahoo: { host: "imap.mail.yahoo.com", provider: "yahoo" },
  fastmail: { host: "imap.fastmail.com", provider: "fastmail" },
  zoho: { host: "imap.zoho.com", provider: "zoho" },
};

const DOMAINS: Record<string, Server> = {
  "icloud.com": SERVERS.icloud, "me.com": SERVERS.icloud, "mac.com": SERVERS.icloud,
  "gmail.com": SERVERS.google, "googlemail.com": SERVERS.google,
  "outlook.com": SERVERS.microsoft, "outlook.es": SERVERS.microsoft, "hotmail.com": SERVERS.microsoft, "hotmail.es": SERVERS.microsoft,
  "live.com": SERVERS.microsoft, "live.es": SERVERS.microsoft, "msn.com": SERVERS.microsoft,
  "yahoo.com": SERVERS.yahoo, "yahoo.es": SERVERS.yahoo, "ymail.com": SERVERS.yahoo, "rocketmail.com": SERVERS.yahoo,
  "fastmail.com": SERVERS.fastmail, "fastmail.fm": SERVERS.fastmail,
  "zoho.com": SERVERS.zoho, "zohomail.com": SERVERS.zoho, "zoho.eu": { host: "imap.zoho.eu", provider: "zoho" },
};

/**
 * A company's own domain whose mail is at a big provider, by its MX records, and the IMAP server for such a domain when it is not the
 * provider's usual one: Zoho keeps organisations' mailboxes on imappro.*, in the data centre their MX names (zoho.eu for the EU one).
 */
const MX: [RegExp, Exclude<MailProvider, "other">, string?][] = [
  [/(^|\.)(google|googlemail)\.com$/, "google"],
  [/(^|\.)(outlook\.com|office365\.us)$/, "microsoft"],
  [/(^|\.)icloud\.com$/, "icloud"],
  [/(^|\.)yahoodns\.net$/, "yahoo"],
  [/(^|\.)messagingengine\.com$/, "fastmail"],
  [/(^|\.)zoho\.eu$/, "zoho", "imappro.zoho.eu"],
  [/(^|\.)zoho\.(com|in|com\.au|jp)$/, "zoho", "imappro.zoho.com"],
];

const APP_URLS: Record<MailProvider, string | null> = {
  icloud: "https://account.apple.com/account/manage/section/security",
  google: "https://myaccount.google.com/apppasswords",
  microsoft: "https://account.live.com/proofs/AppPassword",
  yahoo: "https://login.yahoo.com/account/security/app-passwords",
  fastmail: "https://app.fastmail.com/settings/security/apps",
  zoho: "https://accounts.zoho.com/home#security/app_password",
  other: null,
};

const STEPS = texts(
  {
    icloud: "Open account.apple.com and sign in|Go to “Sign-In and Security” → “App-Specific Passwords”|"
      + "Press “+”, type “Pako” and create the password|Copy it (xxxx-xxxx-xxxx-xxxx) and paste it here",
    google: "Open myaccount.google.com/apppasswords (2-Step Verification must be on)|Type “Pako” as the name and press “Create”|"
      + "Copy the 16 letters shown and paste them here (with or without spaces)",
    microsoft: "Open account.live.com/proofs/AppPassword (two-step verification must be on)|Press “Create a new app password”|Copy it and paste it here",
    yahoo: "Open login.yahoo.com/account/security/app-passwords|Type “Pako” and press “Generate password”|Copy it and paste it here",
    fastmail: "Open Settings → Privacy & Security → App passwords in Fastmail|Press “New app password”, access “Mail (IMAP)”|Copy it and paste it here",
    zoho: "Turn IMAP on in Zoho Mail: Settings → Mail Accounts → IMAP|Open accounts.zoho.com → Security → App Passwords|"
      + "Make one for “Pako”, copy it and paste it here",
    other: "Use your mail password, or an app password if your provider has them (look in its security settings)|Paste it here",
    microsoftNote: "Microsoft no longer lets many Outlook and Hotmail accounts sign in with a password. If it doesn't work, forward your mail "
      + "to Pako's inbox (the Mail card) and it reads it just the same.",
    guessNote: "I couldn't find your server's details: I'm trying {host}. If it doesn't work, ask your mail provider for them.",
    microsoftWorkNote: "This looks like a Microsoft 365 work or school account. Most organisations block IMAP sign-in with a password, and an "
      + "app password doesn't change that. Forward your mail to Pako's inbox instead (the Mail card), or ask your IT team to allow IMAP.",
    googleWorkNote: "This looks like a Google Workspace account: your admin decides whether app passwords and IMAP are allowed. If the "
      + "App passwords page says it isn't available, forward your mail to Pako's inbox instead, or ask your admin.",
  },
);

/** What must be on first, per provider (2-step verification): without it the provider never shows its app password page. */
const BEFORE = texts(
  {
    icloud: "Two-factor authentication must be on for your Apple Account (account.apple.com → Sign-In and Security). It is on for most accounts.",
    google: "2-Step Verification must be on first (myaccount.google.com → Security → 2-Step Verification). Without it, Google doesn't show "
      + "the App passwords page.",
    microsoft: "Two-step verification must be on first (account.microsoft.com → Security → Advanced security options).",
    yahoo: "If Yahoo doesn't offer app passwords, turn on 2-step verification first (Account security → 2-step verification).",
    zoho: "Two-factor authentication must be on first: Zoho makes app passwords only for accounts with it.",
  },
);

/** When the provider says no: the likely reason, and the way that always works (forwarding to Pako's inbox). */
const REFUSED = texts(
  {
    icloud: "If iCloud refuses it: make a new app-specific password (changing your Apple Account password cancels the old ones) and use your "
      + "full iCloud address. Or forward your mail to Pako instead.",
    google: "If Gmail refuses it: make a new app password and paste it whole. No App passwords page usually means 2-Step Verification is off, "
      + "or the account uses Advanced Protection or is managed by a school or company. Or forward your mail to Pako instead.",
    microsoft: "If Outlook refuses it: Microsoft has turned off password sign-in for many accounts, and nothing on your side changes that. "
      + "Forward your mail to Pako instead: it reads it just the same.",
    microsoftWork: "If it's refused: your organisation blocks IMAP with a password (most Microsoft 365 work accounts do). Forward your mail "
      + "to Pako instead, or ask your IT team.",
    googleWork: "If it's refused: your Workspace admin has turned off app passwords or IMAP. Forward your mail to Pako instead, or ask your admin.",
    yahoo: "If Yahoo refuses it: generate a new app password (your usual Yahoo password never works here). Or forward your mail to Pako instead.",
    fastmail: "If Fastmail refuses it: check the app password's access includes Mail (IMAP), or make a new one. Or forward your mail to Pako instead.",
    zoho: "If Zoho refuses it: check that IMAP access is on in Zoho Mail's settings, then make a new app password. Or forward your mail to Pako.",
    other: "If it's refused: ask your mail provider whether IMAP is on and whether it needs an app password. Or forward your mail to Pako instead.",
  },
);

type Advice = Pick<AutoConfig, "appPassword" | "note" | "work" | "before" | "refused">;

function advice(p: MailProvider, l: Lang, host: string, source: AutoConfig["source"]): Advice {
  const s = STEPS(l);
  // A company's own domain at Microsoft or Google: its organisation decides about IMAP, not the person.
  const work = source === "mx" && (p === "microsoft" || p === "google");
  const note = work ? s(p === "microsoft" ? "microsoftWorkNote" : "googleWorkNote")
    : p === "microsoft" ? s("microsoftNote") : source === "guess" ? s("guessNote", { host }) : undefined;
  const before = p === "fastmail" || p === "other" ? null : BEFORE(l)(p);
  const refused = REFUSED(l)(work ? (p === "microsoft" ? "microsoftWork" : "googleWork") : p);
  return { appPassword: { needed: p !== "other", url: APP_URLS[p], steps: s(p).split("|") }, work, before, refused, ...(note ? { note } : {}) };
}

/** The IMAP server in a Thunderbird autoconfig file (implicit TLS only: Pako refuses port 143), its user name filled in. */
export function parseAutoconfig(xml: string, address: string): { host: string; port: number; username: string } | null {
  const [local, domain] = address.split("@") as [string, string];
  for (const m of xml.matchAll(/<incomingServer\s+type="imap"\s*>([\s\S]*?)<\/incomingServer>/gi)) {
    const tag = (name: string) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, "i").exec(m[1]!)?.[1] ?? "";
    const host = tag("hostname").toLowerCase();
    const port = Number(tag("port"));
    if (tag("socketType").toUpperCase() !== "SSL" || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    const username = (tag("username") || "%EMAILADDRESS%")
      .replace(/%EMAILADDRESS%/g, address).replace(/%EMAILLOCALPART%/g, local).replace(/%EMAILDOMAIN%/g, domain);
    return { host, port, username };
  }
  return null;
}

export interface AutoconfigDeps {
  fetch?: typeof fetch;
  /** The name lookup each hop's host is checked with (src/public-fetch.ts checkUrl): every address must be public. */
  resolve?: Resolver;
  resolveMx?: (domain: string) => Promise<{ exchange: string; priority: number }[]>;
  now?: () => number;
}

const CACHE_MS = 24 * 3600_000;
const TIMEOUT_MS = 4000;
/** A config file is a few kilobytes: no more is read. */
const XML_MAX = 200_000;

/** At most `max` bytes of a body, then the rest is let go (never read whole first). */
async function readUpTo(r: Response, max: number): Promise<string> {
  if (!r.body) return "";
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max));
}

/** The finder, with its day-long cache by domain (the language is applied after). */
export function createAutoconfig(d: AutoconfigDeps = {}) {
  const f = d.fetch;
  const mx = d.resolveMx ?? dnsMx;
  const now = d.now ?? Date.now;
  type Found = { host: string; port: number; username: string; provider: MailProvider; source: AutoConfig["source"] };
  /** Per lookup: whether a source could not be reached (offline, a captive portal). A guess made then is not kept: the next try looks again. */
  type Lookup = { unreached: boolean };
  const cache = new Map<string, { at: number; address: string; found: Found }>();

  const xml = async (url: string, l: Lookup): Promise<string | null> => {
    try {
      // Every hop checked (a public host, https, a standard port), never a redirect followed blindly: a domain's own file cannot send Pako to
      // this computer or the local network. The default fetch checks the address again at connect time.
      const { res: r } = await guardedGet(url, {
        ...(f ? { fetch: f } : {}), ...(d.resolve ? { resolve: d.resolve } : {}), signal: AbortSignal.timeout(TIMEOUT_MS), https: true,
        headers: { accept: "application/xml, text/xml" },
      });
      if (!r.ok) {
        await r.body?.cancel().catch(() => {});
        return null;
      }
      return await readUpTo(r, XML_MAX);
    } catch {
      // Mozilla's database always answers when online (a 404 for an unknown domain); a domain's own file is often simply not there.
      if (url.startsWith("https://autoconfig.thunderbird.net/")) l.unreached = true;
      return null;
    }
  };

  const find = async (address: string, l: Lookup): Promise<Found> => {
    const domain = address.split("@")[1]!;
    const known = DOMAINS[domain];
    if (known) return { host: known.host, port: 993, username: address, provider: known.provider, source: "builtin" };
    const ispdb = await xml(`https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`, l);
    const fromIspdb = ispdb ? parseAutoconfig(ispdb, address) : null;
    if (fromIspdb) return { ...fromIspdb, provider: providerOfHost(fromIspdb.host), source: "ispdb" };
    // The domain's own file: its address only, never the person's (the ?emailaddress= Thunderbird may add is left out).
    const own = await xml(`https://autoconfig.${domain}/mail/config-v1.1.xml`, l);
    const fromOwn = own ? parseAutoconfig(own, address) : null;
    if (fromOwn) return { ...fromOwn, provider: providerOfHost(fromOwn.host), source: "autoconfig" };
    // No MX record (ENODATA, ENOTFOUND) is an answer; any other failure, or no answer in time, is not.
    const noAnswer = (): [] => ((l.unreached = true), []);
    const clean = (e: unknown): [] => (/^(ENODATA|ENOTFOUND)$/.test(String((e as { code?: unknown })?.code ?? "")) ? [] : noAnswer());
    const records = (await within(mx(domain).catch(clean), TIMEOUT_MS)) ?? noAnswer();
    for (const r of [...records].sort((a, b) => a.priority - b.priority)) {
      const hit = MX.find(([re]) => re.test(r.exchange.toLowerCase().replace(/\.$/, "")));
      if (hit) return { host: hit[2] ?? SERVERS[hit[1]].host, port: 993, username: address, provider: hit[1], source: "mx" };
    }
    return { host: `imap.${domain}`, port: 993, username: address, provider: "other", source: "guess" };
  };

  return async (rawAddress: string, l: Lang): Promise<AutoConfig | null> => {
    const address = emailOf(rawAddress);
    if (!address) return null;
    const domain = address.split("@")[1]!;
    const hit = cache.get(domain);
    let found: Found;
    if (hit && now() - hit.at < CACHE_MS) {
      // The cache is by domain: the user name is made for this address as it was for the other.
      const u = hit.found.username;
      found = { ...hit.found, username: u === hit.address ? address : u === hit.address.split("@")[0] ? address.split("@")[0]! : u };
    } else {
      const l: Lookup = { unreached: false };
      found = await find(address, l);
      if (!(found.source === "guess" && l.unreached)) cache.set(domain, { at: now(), address, found });
    }
    return { ...found, tls: true, ...advice(found.provider, l, found.host, found.source) };
  };
}

/** Which provider a server name belongs to. */
export const providerOfHost = (host: string): MailProvider => {
  const h = host.toLowerCase();
  for (const [p, s] of Object.entries(SERVERS)) if (s.host === h) return p as MailProvider;
  if (/(^|\.)(gmail|google)\.com$/.test(h)) return "google";
  if (/(^|\.)(office365|outlook)\.com$/.test(h)) return "microsoft";
  if (/(^|\.)me\.com$/.test(h)) return "icloud";
  if (/(^|\.)zoho\.(com|eu|in|com\.au|jp)$/.test(h)) return "zoho";
  return "other";
};

// ---------- the live login ----------

const SAY = texts(
  {
    address: "Type your whole email address, like ana@gmail.com.",
    password: "Paste the app password.",
    authApp: "That password doesn't work: {provider} needs an app password, not your usual one. Make one and paste it.",
    auth: "That password doesn't work for {address}. Copy it again, with no extra spaces.",
    network: "I couldn't reach {host}. Check the internet connection, or that the server is right.",
    tls: "{host} doesn't offer a secure connection Pako accepts.",
    other: "The mail server gave an unexpected answer. Try again in a moment.",
  },
);

const NAMES: Record<MailProvider, string> = {
  icloud: "iCloud", google: "Gmail", microsoft: "Outlook", yahoo: "Yahoo", fastmail: "Fastmail", zoho: "Zoho", other: "",
};

/** Logs in and out, nothing opened: ok, or what went wrong (from the error's marks only, never its words). Within 30 seconds. */
export async function loginTest(c: ImapConfig, connect: ImapConnect, ms = 30_000): Promise<{ ok: true } | { ok: false; kind: FailKind }> {
  let client: Awaited<ReturnType<ImapConnect>> | null = null;
  const shut = (): void => {
    try {
      client?.close();
    } catch {
      /* already closed */
    }
  };
  try {
    client = await connect(c);
    client.on("error", () => undefined);
    const done = await within(client.connect().then(() => true), ms);
    if (!done) {
      // Given up on: the half-open connection is closed, not left to the server's own timeout.
      shut();
      return { ok: false, kind: "network" };
    }
    await client.logout().catch(() => undefined);
    return { ok: true };
  } catch (err) {
    shut();
    return { ok: false, kind: failKind(err) };
  }
}

export interface MailConnectDeps extends RouteAuth {
  lang: () => Lang;
  /** The connections' save (src/connections-panel.ts); null: nothing is kept. */
  saver: ConnectionsSaver | null;
  /** The settings Pako started with: which mailboxes are taken. */
  env?: Record<string, string | undefined>;
  autoconfig?: ReturnType<typeof createAutoconfig>;
  /** The login's connection (the tests give a fake); imapflow without it. */
  connect?: ImapConnect;
}

const PATHS = ["/panel/api/mail/autoconfig", "/panel/api/mail/connect"];

export function mountMailConnect(app: Express, d: MailConnectDeps | null): void {
  if (!d) return localOnly(app, PATHS);
  const auto = d.autoconfig ?? createAutoconfig();
  const connect = d.connect ?? imapflowConnect();
  app.get(PATHS[0]!, guard(d, false), limit(30), async (req, res) => {
    const found = await auto(String(req.query.address ?? ""), d.lang());
    if (!found) {
      res.status(400).json({ error: SAY(d.lang())("address") });
      return;
    }
    res.json(found);
  });
  // A login is slow and a provider may lock an account that keeps trying: few per minute.
  app.post(PATHS[1]!, guard(d, true), limit(6), express.json({ limit: "4kb" }), async (req, res) => {
    const say = SAY(d.lang());
    const b = isObject(req.body) ? req.body : {};
    const address = emailOf(b.address);
    // App passwords are often shown in groups ("abcd efgh ijkl mnop"): Google's and Apple's work without the spaces.
    const password = typeof b.password === "string" ? b.password.trim() : "";
    if (!address) return void res.status(400).json({ ok: false, why: "address", error: say("address") });
    if (!password || password.length > 500 || /[\u0000-\u001f\u007f]/.test(password)) return void res.status(400).json({ ok: false, why: "password", error: say("password") });
    const found = await auto(address, d.lang());
    const host = line(b.host, 253).toLowerCase() || found!.host;
    const port = typeof b.port === "number" && Number.isInteger(b.port) && b.port > 0 && b.port < 65536 ? b.port : found!.port;
    const user = line(b.username, 320) || found!.username;
    const provider = line(b.host, 253) ? providerOfHost(host) : found!.provider;
    const pass = provider === "google" || provider === "icloud" ? password.replace(/\s+/g, "") : password;
    const config: ImapConfig = { host, port, user, password: pass, folders: ["INBOX"], pollMinutes: 5, workDomains: [], vip: [] };
    const test = await loginTest(config, connect);
    if (!test.ok) {
      const why = test.kind;
      const error = why === "auth"
        ? provider !== "other" ? say("authApp", { provider: NAMES[provider] }) : say("auth", { address })
        : why === "network" ? say("network", { host }) : why === "tls" ? say("tls", { host }) : say("other");
      res.json({ ok: false, why, error });
      return;
    }
    if (!d.saver) return void res.json({ ok: true, restarting: false });
    // An earlier sign-in with Microsoft or Google is removed: kept, it would win over this password (src/imap.ts loadImapConfig).
    const slot = mailSlot(d.env ?? {}, {
      IMAP_HOST: host, IMAP_USER: user, IMAP_PASSWORD: pass, IMAP_PORT: port === 993 ? "" : String(port), IMAP_OAUTH: "", IMAP_REFRESH_TOKEN: "",
    });
    if (!slot) return void res.status(409).json({ ok: false, why: "save", error: WORDS()("twoMailboxes") });
    const saved = await d.saver.save(slot.id, slot.values);
    if (!saved.ok) return void res.status(saved.status ?? 400).json({ ok: false, why: "save", error: saved.error });
    res.json({ ok: true, restarting: d.saver.restartAfter(res) });
  });
}
