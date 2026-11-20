// Signing in with Microsoft and Google, from the project's own apps (src/connect-clients.ts): one button, an Allow on the provider's page,
// done. This is the same machinery as Slack and Zoom (src/connect-setup.ts): OAuth 2.0 with PKCE as a public client (no secret that
// matters), the browser coming back to this computer, and the tokens kept in the secret store. Pako never borrows another program's client
// ID. While the project's IDs are empty, the panel offers the other ways (forwarding, an app password, a calendar link).
//
// What each sign-in connects:
// - Microsoft (Outlook.com, Hotmail, Live, Microsoft 365): the mailbox, read by IMAP with XOAUTH2. The same Allow also consents to the
//   calendar (Microsoft Graph Calendars.ReadWrite), so the calendar writes that are coming need no second consent. Microsoft gives a token
//   for one resource at a time, so the code is exchanged for the mailbox's; the same refresh token later gives Graph's.
// - Google, the calendar (calendar.events: read now, writes later) with "Connect Google Calendar". Gmail's scope is restricted, so Gmail
//   by sign-in only once Google allows it for this app (GOOGLE_GMAIL_ALLOWED); until then, Gmail with an app password.
//
// The flow:
// 1. A fresh PKCE challenge and a one-time state, then the provider's page (with the address as a hint for mail).
// 2. The browser comes back to http://127.0.0.1:<port>/connect/<provider>/callback. It must come from this computer, name this computer,
//    and carry a state Pako made in the last ten minutes for that provider and purpose.
// 3. Pako exchanges the code with the verifier and reads who signed in from the ID token. Then one live check: a read-only IMAP login
//    with the access token for mail, or the calendar list for Google Calendar.
// 4. Pako keeps the account and the refresh token in the secret store (through the panel's saver) and restarts. After that src/imap.ts
//    (createTokenSource) and src/google-calendar.ts ask for fresh access tokens themselves. A refresh token the provider no longer takes
//    makes the card say "Sign in again".
//
//   GET  /panel/api/mail/oauth            -> { microsoft: boolean, google: boolean }   (which mail sign-ins this Pako can offer)
//   POST /panel/api/mail/oauth/start      { provider, address? } -> { ok, authorizeUrl } | { ok: false, error }
//   GET  /panel/api/mail/oauth/account    -> { state: "off" | "waiting" | "failed" | "connected", account?, error? }
//   POST /panel/api/google/connect        -> { ok, authorizeUrl }   (Google Calendar)
//   GET  /panel/api/google/account        -> the same states
//   GET  /connect/microsoft/callback, /connect/google/callback

import { randomBytes } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import { oauthPage, pkcePair, fromThisComputer, base64url } from "./connect-setup.ts";
import { emailOf, guard, limit, localOnly, type RouteAuth } from "./connect-routes.ts";
import type { ConnectionsSaver } from "./connections-panel.ts";
import { imapflowConnect, type ImapConfig, type ImapConnect } from "./imap.ts";
import { builtInClients, type BuiltInDefaults } from "./connect-clients.ts";
import { GOOGLE_CALENDAR_API } from "./google-calendar.ts";
import { mailClients, type MailOAuthProvider } from "./mail-clients.ts";
import { createLog } from "./log.ts";

const log = createLog("imap");

export { mailClients, type MailClients, type MailOAuthProvider } from "./mail-clients.ts";

type Env = Record<string, string | undefined>;

export interface ProviderDef {
  authorize: string;
  token: string;
  /** The scope of the token Pako asks for (the mailbox's). */
  scope: string;
  /** What the Allow consents to, when more than the token's scope (Microsoft: the calendar too, in the same sign-in). */
  consent?: string;
  imapHost: string;
  name: string;
}
export const PROVIDERS: Record<MailOAuthProvider, ProviderDef> = {
  microsoft: {
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "https://outlook.office.com/IMAP.AccessAsUser.All offline_access openid email",
    consent: "https://outlook.office.com/IMAP.AccessAsUser.All https://graph.microsoft.com/Calendars.ReadWrite offline_access openid email",
    imapHost: "outlook.office365.com",
    name: "Microsoft",
  },
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "https://mail.google.com/ openid email",
    imapHost: "imap.gmail.com",
    name: "Google",
  },
};

/** Google Calendar: read (and, later, write) the events of the person's calendars, and who they are. */
export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events openid email";
export { GOOGLE_CALENDAR_API } from "./google-calendar.ts";

/** Where each provider is reached. The tests point them at a fake server on this computer. */
export type ProviderUrls = Partial<Record<MailOAuthProvider, Partial<Pick<ProviderDef, "authorize" | "token">>>>;
const urlsOf = (p: MailOAuthProvider, over: ProviderUrls = {}): ProviderDef => ({ ...PROVIDERS[p], ...(over[p] ?? {}) });

export const mailRedirectUri = (p: MailOAuthProvider, port: number): string => `http://127.0.0.1:${port}/connect/${p}/callback`;

/** An access token the provider no longer gives: the refresh token was revoked, expired or the password changed. Sign in again. */
export class SignInAgain extends Error {
  code = "EOAUTHSIGNIN";
}

/** The ID token's claims (it came straight from the provider over TLS, in answer to our own code: not verified again here). */
export function idClaims(idToken: unknown): Record<string, unknown> {
  if (typeof idToken !== "string") return {};
  try {
    return JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    /* not a JWT: no claims */
    return {};
  }
}

/**
 * Fresh access tokens for one mailbox, from its refresh token. One refresh at a time. A refresh token the provider replaces (Microsoft does)
 * is handed to `keep` before it is used, so a restart starts from the new one.
 */
export function createTokenSource(o: {
  provider: MailOAuthProvider; clientId: string; clientSecret?: string; refreshToken: string;
  keep?: (refreshToken: string) => void; fetch?: typeof fetch; now?: () => number; urls?: ProviderUrls;
}) {
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const def = urlsOf(o.provider, o.urls);
  let refresh = o.refreshToken;
  let token: { value: string; until: number } | null = null;
  let asking: Promise<string> | null = null;
  const ask = async (): Promise<string> => {
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: o.clientId, scope: def.scope });
    if (o.clientSecret) body.set("client_secret", o.clientSecret);
    const r = await f(def.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(), signal: AbortSignal.timeout(15_000) });
    const j = (await r.json().catch(() => ({}))) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; error?: unknown };
    if (typeof j.access_token !== "string") {
      // invalid_grant: the refresh token is no good any more. Anything else (the provider down) is tried again at the next look.
      if (j.error === "invalid_grant" || j.error === "unauthorized_client") throw new SignInAgain(`${def.name} wants you to sign in again`);
      throw Object.assign(new Error(`${def.name} token: ${typeof j.error === "string" ? j.error : `HTTP ${r.status}`}`), { code: "ETIMEDOUT" });
    }
    if (typeof j.refresh_token === "string" && j.refresh_token && j.refresh_token !== refresh) {
      refresh = j.refresh_token;
      try {
        o.keep?.(refresh);
      } catch (err) {
        log.error(`could not keep the new refresh token: ${(err as Error).name}`);
      }
    }
    token = { value: j.access_token, until: now() + (Number(j.expires_in) || 3600) * 1000 - 120_000 };
    return token.value;
  };
  return {
    /** Drops the access token held: the next access asks the provider for a new one (the server refused the held one). */
    forget: (): void => {
      token = null;
    },
    access: (): Promise<string> => {
      if (token && token.until > now()) return Promise.resolve(token.value);
      asking ??= ask().finally(() => {
        asking = null;
      });
      return asking;
    },
  };
}

// ---------- the routes ----------

const SAY = {
  noClient: "Signing in with {name} isn't set up in this Pako yet. Forward your mail to Pako instead, or use an app password where your provider has one.",
  refused: "You didn't allow it, so nothing was connected. Press Sign in again when you're ready.",
  stale: "This link has expired or was already used. Go back to Pako and press Sign in again.",
  notHere: "This only works on the computer where Pako runs.",
  exchange: "{name} didn't accept the sign-in: {why}. Press Sign in again.",
  noRefresh: "{name} gave no lasting sign-in (no refresh token). Press Sign in again.",
  noEmail: "{name} didn't say which address signed in. Press Sign in again.",
  imap: "Signed in, but {host} refused to open the mailbox for {user}: {why}. If it's a work account, its admin may have turned IMAP off.",
  notKept: "Signed in, but Pako couldn't keep it on this computer: {why}",
  done: "Connected: Pako now reads {user} (read only). You can close this tab and go back to Pako.",
  calendar: "Signed in, but Google didn't let Pako read the calendar of {user}: {why}. Press Connect again.",
  noCalendarClient: "Connecting Google Calendar isn't set up in this Pako yet. Add your calendar's private link instead.",
  calendarDone: "Connected: Pako now reads the calendar of {user}. You can close this tab and go back to Pako.",
};
const say = (k: keyof typeof SAY, v: Record<string, string> = {}): string => SAY[k].replace(/\{(\w+)\}/g, (m, x: string) => v[x] ?? m);

export interface MailOAuthDeps extends RouteAuth {
  env: Env;
  saver: ConnectionsSaver | null;
  fetch?: typeof fetch;
  now?: () => number;
  urls?: ProviderUrls;
  /** The live IMAP login after the sign-in (imapflow without it; the tests give a fake). */
  connect?: ImapConnect;
  /** Google Calendar's API (the tests point it at a fake). */
  calendarApi?: string;
  /** The built-in client IDs (src/connect-clients.ts), for the tests; the real ones without it. */
  defaults?: BuiltInDefaults;
}

type Purpose = "mail" | "calendar";
type Last = { ok: true; user: string; provider: MailOAuthProvider } | { ok: false; error: string } | null;

interface Flow {
  purpose: Purpose;
  provider: MailOAuthProvider;
  verifier: string;
  redirect: string;
  at: number;
}

const FLOW_MS = 10 * 60_000;
const PATHS = [
  "/panel/api/mail/oauth", "/panel/api/mail/oauth/start", "/panel/api/mail/oauth/account", "/panel/api/google/connect", "/panel/api/google/account",
  "/connect/microsoft/callback", "/connect/google/callback",
];

export function mountMailOAuth(app: Express, d: MailOAuthDeps | null): void {
  if (!d) return localOnly(app, PATHS);
  const f = d.fetch ?? fetch;
  const now = d.now ?? Date.now;
  const clients = mailClients(d.env, d.defaults);
  const googleCalendar = builtInClients(d.env, d.defaults).google;
  const calendarApi = d.calendarApi ?? GOOGLE_CALENDAR_API;
  const connect = d.connect ?? imapflowConnect();
  const flows = new Map<string, Flow>();
  const last: Record<Purpose, Last> = { mail: null, calendar: null };
  const sweep = (): void => {
    for (const [k, fl] of flows) if (now() - fl.at > FLOW_MS) flows.delete(k);
  };

  app.get("/panel/api/mail/oauth", guard(d, false), limit(60), (_req, res) => {
    res.json({ microsoft: !!clients.microsoft, google: !!clients.google });
  });

  app.post("/panel/api/mail/oauth/start", guard(d, true), limit(20), express.json({ limit: "2kb" }), (req, res) => {
    const b = (req.body ?? {}) as { provider?: unknown; address?: unknown };
    const provider = b.provider === "microsoft" || b.provider === "google" ? b.provider : null;
    if (!provider) return void res.status(400).json({ ok: false, error: "Unknown provider." });
    const client = clients[provider];
    if (!client) return void res.status(409).json({ ok: false, error: say("noClient", { name: PROVIDERS[provider].name }) });
    res.json({ ok: true, authorizeUrl: begin("mail", provider, client.id, emailOf(b.address), req.socket.localPort ?? 8787) });
  });

  /** A new sign-in for this purpose: the one before it is forgotten. The provider's page, with the PKCE challenge and the state. */
  const begin = (purpose: Purpose, provider: MailOAuthProvider, clientId: string, hint: string, port: number): string => {
    sweep();
    for (const [k, fl] of flows) if (fl.purpose === purpose) flows.delete(k);
    last[purpose] = null;
    const state = base64url(randomBytes(24));
    const { verifier, challenge } = pkcePair();
    const redirect = mailRedirectUri(provider, port);
    flows.set(state, { purpose, provider, verifier, redirect, at: now() });
    const def = urlsOf(provider, d.urls);
    const scope = purpose === "calendar" ? GOOGLE_CALENDAR_SCOPE : (def.consent ?? def.scope);
    const q = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirect, scope, state, code_challenge: challenge, code_challenge_method: "S256" });
    if (hint) q.set("login_hint", hint);
    // Google gives a refresh token only with offline access, and only at a consent screen.
    if (provider === "google") {
      q.set("access_type", "offline");
      q.set("prompt", "consent");
    }
    return `${def.authorize}?${q}`;
  };

  app.post("/panel/api/google/connect", guard(d, true), limit(20), (req, res) => {
    if (!googleCalendar) return void res.status(409).json({ ok: false, error: say("noCalendarClient") });
    res.json({ ok: true, authorizeUrl: begin("calendar", "google", googleCalendar.id, "", req.socket.localPort ?? 8787) });
  });

  const account = (purpose: Purpose) => (_req: Request, res: Response): void => {
    sweep();
    if ([...flows.values()].some((fl) => fl.purpose === purpose)) return void res.json({ state: "waiting" });
    const l = last[purpose];
    if (!l) return void res.json({ state: "off" });
    res.json(l.ok ? { state: "connected", account: { user: l.user, provider: l.provider } } : { state: "failed", error: l.error });
  };
  app.get("/panel/api/mail/oauth/account", guard(d, false), limit(120), account("mail"));
  app.get("/panel/api/google/account", guard(d, false), limit(120), account("calendar"));

  const callback = (provider: MailOAuthProvider) => async (req: Request, res: Response): Promise<void> => {
    if (!fromThisComputer(req)) return oauthPage(res, 403, false, say("notHere"));
    sweep();
    const q = req.query as Record<string, unknown>;
    const state = typeof q.state === "string" ? q.state : "";
    const flow = flows.get(state);
    if (!flow || flow.provider !== provider) return oauthPage(res, 400, false, say("stale"));
    flows.delete(state);
    const name = PROVIDERS[provider].name;
    const fail = (error: string): void => {
      last[flow.purpose] = { ok: false, error };
      oauthPage(res, 200, false, error);
    };
    if (typeof q.error === "string") return fail(say("refused"));
    const code = typeof q.code === "string" && /^[\w.~/*!$-]{4,2048}$/.test(q.code) ? q.code : "";
    if (!code) return fail(say("exchange", { name, why: "no code" }));
    const client = (flow.purpose === "calendar" ? googleCalendar : clients[provider])!;
    const def = urlsOf(provider, d.urls);
    let j: Record<string, unknown>;
    try {
      const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: flow.redirect, client_id: client.id, code_verifier: flow.verifier });
      // Microsoft gives a token for one resource: the mailbox's (the calendar's consent was given at the same Allow, for later).
      if (provider === "microsoft") body.set("scope", def.scope);
      const secret = (client as { secret?: string }).secret;
      if (secret) body.set("client_secret", secret);
      const r = await f(def.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(), signal: AbortSignal.timeout(15_000) });
      j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    } catch {
      /* the network failed: said to the user as no answer */
      return fail(say("exchange", { name, why: "no answer" }));
    }
    if (typeof j.access_token !== "string") return fail(say("exchange", { name, why: typeof j.error === "string" ? j.error.slice(0, 80) : "no token" }));
    if (typeof j.refresh_token !== "string" || !j.refresh_token) return fail(say("noRefresh", { name }));
    const claims = idClaims(j.id_token);
    const user = emailOf(claims.email) || emailOf(claims.preferred_username);
    if (!user) return fail(say("noEmail", { name }));
    if (flow.purpose === "calendar") return calendarDone(res, user, j.access_token, j.refresh_token, fail);
    // One read-only login with the new token, before anything is kept: a work account whose admin turned IMAP off is said now, plainly.
    const host = def.imapHost;
    const cfg: ImapConfig = { host, port: 993, user, password: "", accessToken: j.access_token, folders: ["INBOX"], pollMinutes: 5, workDomains: [], vip: [] };
    let client2: Awaited<ReturnType<ImapConnect>> | null = null;
    try {
      client2 = await connect(cfg);
      client2.on("error", () => undefined);
      await client2.connect();
      await client2.logout().catch(() => undefined);
      client2 = null;
    } catch (err) {
      const why = (err as { serverResponseCode?: unknown }).serverResponseCode;
      return fail(say("imap", { host, user, why: typeof why === "string" ? why.slice(0, 60) : "the login was refused" }));
    } finally {
      try {
        client2?.close();
      } catch {
        /* closed */
      }
    }
    if (!d.saver) return fail(say("notKept", { why: "this Pako cannot save connections" }));
    // An earlier app password and port are removed: the provider's server is on 993, and a password no longer used is not kept.
    const saved = await d.saver.save("imap", {
      IMAP_HOST: host, IMAP_USER: user, IMAP_OAUTH: provider, IMAP_REFRESH_TOKEN: j.refresh_token, IMAP_PASSWORD: "", IMAP_PORT: "",
    });
    if (!saved.ok) return fail(say("notKept", { why: saved.error }));
    last.mail = { ok: true, user, provider };
    oauthPage(res, 200, true, say("done", { user }));
    d.saver.restartAfter(res);
  };

  /** Google Calendar: one look at the calendar list with the new token, then the sign-in kept for src/google-calendar.ts. */
  const calendarDone = async (res: Response, user: string, access: string, refresh: string, fail: (e: string) => void): Promise<void> => {
    try {
      const r = await f(`${calendarApi}/users/me/calendarList?maxResults=1`, { headers: { authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: { message?: unknown } };
        return fail(say("calendar", { user, why: typeof j.error?.message === "string" ? j.error.message.slice(0, 80) : `HTTP ${r.status}` }));
      }
    } catch {
      /* the network failed: said to the user as no answer */
      return fail(say("calendar", { user, why: "no answer" }));
    }
    if (!d.saver) return fail(say("notKept", { why: "this Pako cannot save connections" }));
    const saved = await d.saver.save("google", { GOOGLE_REFRESH_TOKEN: refresh, GOOGLE_ACCOUNT: user });
    if (!saved.ok) return fail(say("notKept", { why: saved.error }));
    last.calendar = { ok: true, user, provider: "google" };
    oauthPage(res, 200, true, say("calendarDone", { user }));
    d.saver.restartAfter(res);
  };
  app.get("/connect/microsoft/callback", limit(20), callback("microsoft"));
  app.get("/connect/google/callback", limit(20), callback("google"));
}
