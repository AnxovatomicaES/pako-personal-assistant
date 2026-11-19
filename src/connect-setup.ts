// Slack and Zoom connected from the panel with one paste and one Allow. Nobody copies a token or a secret.
//
// Both services now let a program on the person's own computer finish OAuth by itself (PKCE, no client secret):
// - Slack since 2026-03-30. With PKCE on, a redirect to http://localhost is a "desktop redirect".
// - Zoom with "Use Public Client OAuth". A redirect to http://127.0.0.1 is allowed at any port.
// Each person still needs an app of their own (a single shared Pako app would be a distributed app, which Slack and Zoom only allow
// through their marketplaces), so the flow is:
//
// 1. Pako writes the app for them.
//    - Slack: its manifest goes into Slack's own "Create app" link, with PKCE on, the read-only user scopes, and this computer's
//      redirect. The person picks the workspace and presses Create.
//    - Zoom has no such link: Pako gives the manifest as a file for "Build from an app manifest", with the user-level scopes and the
//      redirect in it.
// 2. The person pastes the app's Client ID, which is not a secret: it is in the address the browser opens next.
// 3. Pako opens the service's Allow page with a fresh PKCE challenge and a one-time `state`. The browser comes back to this computer
//    (/connect/<service>/callback). Pako checks the state, exchanges the code (with the verifier only it knows), checks the scopes, asks
//    who the person is, keeps the tokens in the secret store (src/connections-panel.ts saver, src/secrets.ts: the keychain on a Mac) and
//    restarts so Slack and Zoom read them.
// 4. The page shows "Connected as <name> in <workspace>" (Slack) or "Connected as <name> (<email>)" (Zoom). After the restart this comes
//    from the running reader itself, so it is always what Pako really reads.
//
// The callback is the only way in that a browser reaches without the panel's session, so it takes three checks before anything: it must
// come from this computer (the socket's address), name this computer (the Host header, against DNS rebinding), and carry a state that
// Pako made in the last ten minutes for that service. A state works once.
//
//   GET  /panel/api/slack/setup     -> { createUrl, redirectUri, scopes }
//   POST /panel/api/slack/connect   { clientId } -> { ok, authorizeUrl } | { ok: false, error }
//   GET  /panel/api/slack/account   -> { state: "off" | "waiting" | "failed" | "connected" | "unreachable", account?, error? }
//   GET  /panel/api/zoom/setup      -> { createUrl, manifestUrl, redirectUri, scopes, local }
//   GET  /panel/api/zoom/manifest   -> the app's manifest, as a file to upload to Zoom
//   POST /panel/api/zoom/manifest   -> { ok, path }: the same file saved in ~/Downloads (the Mac app's window cannot download)
//   POST /panel/api/zoom/connect    { clientId } -> { ok, authorizeUrl } | { ok: false, error }
//   GET  /panel/api/zoom/account    -> the same as Slack's
//   GET  /connect/slack/callback, /connect/zoom/callback   (the browser, back from the Allow)
//
// Claude (src/claude-connect.ts): one button that installs Claude Code when needed and opens Claude's own sign-in in the browser; the panel
// polls the view while it works. Nothing here sees a token: Claude Code keeps its own sign-in.
//
//   GET  /panel/api/claude/connect          -> ConnectView (the sign-in looked at again when the last look is over 30 s old)
//   POST /panel/api/claude/connect          { switch?: true, again?: true } -> ConnectView (started; `switch` signs out first)
//   POST /panel/api/claude/connect/cancel   -> ConnectView
//   POST /panel/api/claude/signout          { confirm: true } -> { ok } & ConnectView

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import express, { type Express, type Request, type Response } from "express";
import { guard, HEADERS, isObject, limit, line, localOnly, type RouteAuth } from "./connect-routes.ts";
import type { ClaudeConnect } from "./claude-connect.ts";
import type { ConnectionsSaver } from "./connections-panel.ts";
import { isLoopback } from "./dashboard.ts";
import type { DiscoveryStore } from "./discovery.ts";
import { hostOf } from "./guard-http.ts";
import type { Lang } from "./i18n.ts";
import { builtInClients, SLACK_LOOPBACK_PORT, type BuiltInDefaults } from "./connect-clients.ts";
import { SLACK_USER_SCOPES } from "./slack.ts";
import { ZOOM_USER_SCOPES } from "./zoom.ts";
import { createLog } from "./log.ts";

const log = createLog("connect");

export type Service = "slack" | "zoom";

/** Where each service is reached. The tests point them at a fake server on this computer. */
export interface ServiceUrls {
  slackAuthorize: string;
  slackApi: string;
  zoomAuthorize: string;
  zoomToken: string;
  zoomApi: string;
}
export const SERVICE_URLS: ServiceUrls = {
  slackAuthorize: "https://slack.com/oauth/v2/authorize",
  slackApi: "https://slack.com/api",
  zoomAuthorize: "https://zoom.us/oauth/authorize",
  zoomToken: "https://zoom.us/oauth/token",
  zoomApi: "https://api.zoom.us/v2",
};

/** How long a started connection waits for the browser to come back. */
const FLOW_MS = 10 * 60_000;
const CALLBACK = { slack: "/connect/slack/callback", zoom: "/connect/zoom/callback" } as const;

/**
 * The address the service sends the browser back to, at the port this Pako answers on.
 * - Slack only treats `localhost` as a desktop redirect (its PKCE page names no other), and it must match the manifest.
 * - Zoom wants the numeric 127.0.0.1 and refuses `localhost`, and ignores the port.
 */
export const redirectUri = (service: Service, port: number): string =>
  `http://${service === "slack" ? "localhost" : "127.0.0.1"}:${port}${CALLBACK[service]}`;

// ---------- Slack ----------

/**
 * The manifest of the person's Slack app.
 * - User scopes only: a desktop redirect may not ask for bot scopes, and reading the owner's own DMs needs a user token anyway.
 * - PKCE on, so there is no secret.
 * - Token rotation off, so the token does not expire.
 * - Socket Mode off: Pako looks for new messages itself (src/slack-poll.ts), so no app-level token is needed.
 */
export function slackManifest(redirect: string): Record<string, unknown> {
  return {
    display_information: { name: "Pako", description: "Your assistant, reading your Slack so nothing promised gets dropped (read only)" },
    oauth_config: { redirect_urls: [redirect], scopes: { user: [...SLACK_USER_SCOPES] }, pkce_enabled: true },
    settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
  };
}

/** Slack's "Create New App" with the manifest already in it: the person picks the workspace and presses Create. */
export const slackCreateUrl = (redirect: string): string =>
  `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackManifest(redirect)))}`;

// ---------- Zoom ----------

/** Where "Build from an app manifest" is: the Marketplace's Develop menu. */
export const ZOOM_CREATE_URL = "https://marketplace.zoom.us/develop/create";

/**
 * The manifest of the person's Zoom app:
 * - a General app used by its own user (USER_OPERATION), with PKCE;
 * - this computer's redirect in both places Zoom reads it, and in the allow list;
 * - the read-only user-level scopes.
 */
export function zoomManifest(redirect: string): Record<string, unknown> {
  return {
    display_information: {
      display_name: "Pako",
      description: "Your assistant, reading your meetings so nothing promised gets dropped (read only)",
    },
    oauth_information: {
      usage: "USER_OPERATION",
      development_redirect_uri: redirect,
      production_redirect_uri: redirect,
      oauth_allow_list: [redirect],
      strict_mode: false,
      subdomain_strict_mode: false,
      scopes: ZOOM_USER_SCOPES.map((scope) => ({ scope, optional: false })),
      scope_description: "Reads your meetings, their AI Companion summaries and your cloud recordings' transcripts, to find what was promised. Never writes.",
      enable_private_pkce_client: true,
      enable_public_pkce_client: true,
    },
  };
}

// ---------- words (English only) ----------

const SAY = {
  slackId: "That doesn't look like a Slack Client ID. It is two numbers joined by a dot, like 1234567890.9876543210, under “App Credentials” on your app's page.",
  zoomId: "That doesn't look like a Zoom Client ID. Copy the one under “Use Public Client OAuth” on your app's page.",
  refused: "You pressed Cancel, so nothing was connected. Press Connect again when you're ready.",
  stale: "This link has expired or was already used. Go back to Pako and press Connect again.",
  notHere: "This only works on the computer where Pako runs.",
  exchange: "{service} didn't accept the sign-in: {why}. Press Connect again.",
  noToken: "{service} answered without a token. Press Connect again.",
  rotating: "Your Slack app has token rotation on, so its token would stop working in 12 hours. Turn it off under “OAuth & Permissions”, then press Connect again.",
  scopes: "The app is missing some permissions ({scopes}). Create it again from Pako's button, which has them all, then press Connect.",
  noAnswer: "I couldn't reach {service}. Check the internet connection and press Connect again.",
  notKept: "Connected, but Pako couldn't keep the sign-in on this computer: {why}",
  done: "Connected as {who}. You can close this tab and go back to Pako.",
  noBuiltIn: "This Pako has no {service} app of its own yet: open “Advanced: use your own app” and paste your app's Client ID.",
  portBusy: "Another program is using port {port}, where Slack sends you back to Pako. Close it, or use your own app under “Advanced”.",
  admin: "Your workspace needs an admin to approve new apps. Slack has sent them a request; press Connect again once it's approved.",
};
const say = (key: keyof typeof SAY, vars: Record<string, string> = {}): string => SAY[key].replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
const NAME: Record<Service, string> = { slack: "Slack", zoom: "Zoom" };

// ---------- the flows ----------

export const base64url = (b: Buffer): string => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A PKCE pair (RFC 7636, S256): the verifier stays here, the challenge goes in the authorize address. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

export type Account = { user: string; team?: string; email?: string };
export type AccountState =
  | { state: "off" }
  | { state: "waiting" }
  | { state: "failed"; error: string }
  | { state: "connected"; account: Account }
  | { state: "unreachable" };

interface Flow {
  service: Service;
  clientId: string;
  verifier: string;
  redirect: string;
  at: number;
}

export interface ConnectSetupDeps extends RouteAuth {
  lang: () => Lang;
  saver: ConnectionsSaver | null;
  discovery?: DiscoveryStore;
  fetch?: typeof fetch;
  /** The one-button Claude connection (src/claude-connect.ts); absent: its routes answer 404. */
  claude?: ClaudeConnect | null;
  now?: () => number;
  urls?: Partial<ServiceUrls>;
  /** Where "Save the app file" puts Zoom's manifest (~/Downloads without it; the tests give a temporary folder). */
  downloads?: string;
  /** The environment, for the built-in clients' overrides (PAKO_SLACK_CLIENT_ID...). */
  env?: Record<string, string | undefined>;
  /** The built-in client IDs (src/connect-clients.ts), for the tests; the real ones without it. */
  defaults?: BuiltInDefaults;
  /** The fixed loopback port the project's Slack app returns to (SLACK_LOOPBACK_PORT; the tests give 0, any free port). */
  slackPort?: number;
  /** Who the running Slack and Zoom readers say they are (src/slack.ts and src/zoom.ts account); absent or null: not connected. */
  slackAccount?: () => Promise<{ user: string; team: string } | null> | null;
  zoomAccount?: () => Promise<{ name: string; email: string } | null> | null;
}

type Done = { ok: true; who: string; account: Account } | { ok: false; error: string };

/** The code exchange and the "who is this" for each service. Kept apart from the routes, so the tests can read it plainly. */
export function createExchanges(o: { fetch?: typeof fetch; urls?: Partial<ServiceUrls> }) {
  const f = o.fetch ?? fetch;
  const u = { ...SERVICE_URLS, ...(o.urls ?? {}) };

  const slack = async (flow: Flow, code: string): Promise<Done & { values?: Record<string, string> }> => {
    let j: Record<string, unknown>;
    try {
      // PKCE: the verifier instead of a client secret (Slack's "Using PKCE": a desktop redirect sends no client_secret).
      const r = await f(`${u.slackApi}/oauth.v2.access`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: flow.clientId, code, code_verifier: flow.verifier, redirect_uri: flow.redirect }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
      j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    } catch {
      return { ok: false, error: say("noAnswer", { service: "Slack" }) };
    }
    if (j.ok !== true) return { ok: false, error: say("exchange", { service: "Slack", why: typeof j.error === "string" ? j.error.slice(0, 80) : "no reason given" }) };
    const user = (j.authed_user ?? {}) as { access_token?: unknown; scope?: unknown; refresh_token?: unknown; expires_in?: unknown; id?: unknown };
    const token = typeof user.access_token === "string" ? user.access_token : "";
    if (!/^xoxp-[A-Za-z0-9-]{20,}$/.test(token)) return { ok: false, error: say("noToken", { service: "Slack" }) };
    // A rotating token lasts 12 hours and needs a refresh Pako's Slack reader does not do: said plainly rather than failing tomorrow.
    if (typeof user.refresh_token === "string" || typeof user.expires_in === "number") return { ok: false, error: say("rotating") };
    const has = typeof user.scope === "string" ? user.scope.split(",").map((s) => s.trim()) : [];
    const missing = SLACK_USER_SCOPES.filter((s) => !has.includes(s));
    if (missing.length) return { ok: false, error: say("scopes", { scopes: missing.join(", ") }) };
    // Who and where, for "Connected as": auth.test, then the person's own name.
    let name = "";
    let team = typeof (j.team as { name?: unknown } | undefined)?.name === "string" ? (j.team as { name: string }).name : "";
    try {
      const a = (await (await f(`${u.slackApi}/auth.test`, { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8_000) })).json()) as Record<string, unknown>;
      if (a.ok === true) {
        team = typeof a.team === "string" ? a.team : team;
        name = typeof a.user === "string" ? a.user : "";
        if (typeof a.user_id === "string") {
          const q = new URLSearchParams({ user: a.user_id });
          const p = (await (await f(`${u.slackApi}/users.info?${q}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8_000) })).json()) as {
            ok?: boolean; user?: { real_name?: string; profile?: { real_name?: string; display_name?: string } };
          };
          name = p.ok ? p.user?.profile?.real_name || p.user?.real_name || p.user?.profile?.display_name || name : name;
        }
      }
    } catch {
      // The token was given; a name that cannot be read now is shown after the restart, from the reader.
    }
    const account: Account = { user: (name || "you").slice(0, 100), ...(team ? { team: team.slice(0, 100) } : {}) };
    return { ok: true, account, who: `${account.user}${account.team ? ` in ${account.team}` : ""}`, values: { SLACK_USER_TOKEN: token, SLACK_CLIENT_ID: flow.clientId } };
  };

  const zoom = async (flow: Flow, code: string): Promise<Done & { values?: Record<string, string> }> => {
    let j: Record<string, unknown>;
    let status = 0;
    try {
      // A public client: the Client ID in the body, the verifier, and no Authorization header (Zoom's PKCE page).
      const r = await f(u.zoomToken, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: flow.redirect, code_verifier: flow.verifier, client_id: flow.clientId }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
      status = r.status;
      j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    } catch {
      return { ok: false, error: say("noAnswer", { service: "Zoom" }) };
    }
    const access = typeof j.access_token === "string" ? j.access_token : "";
    const refresh = typeof j.refresh_token === "string" ? j.refresh_token : "";
    if (!access || !refresh) {
      const why = typeof j.reason === "string" ? j.reason : typeof j.error === "string" ? j.error : status ? `HTTP ${status}` : "no reason given";
      return { ok: false, error: access ? say("noToken", { service: "Zoom" }) : say("exchange", { service: "Zoom", why: why.slice(0, 80) }) };
    }
    const has = typeof j.scope === "string" ? j.scope.split(/\s+/) : [];
    // Without "user:read:user" Pako only loses the name on the card; every other scope is one of Pako's sources.
    const missing = ZOOM_USER_SCOPES.filter((s) => s !== "user:read:user" && !has.includes(s));
    if (has.length && missing.length) return { ok: false, error: say("scopes", { scopes: missing.join(", ") }) };
    let name = "";
    let email = "";
    try {
      const r = await f(`${u.zoomApi}/users/me`, { headers: { authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(8_000) });
      const me = r.ok ? ((await r.json()) as Record<string, unknown>) : {};
      name = [me.first_name, me.last_name].filter((x) => typeof x === "string" && x).join(" ") || (typeof me.display_name === "string" ? me.display_name : "");
      email = typeof me.email === "string" ? me.email : "";
    } catch {
      // As for Slack: the name comes from the reader after the restart.
    }
    const account: Account = { user: (name || email || "you").slice(0, 100), ...(email ? { email: email.slice(0, 200) } : {}) };
    const values: Record<string, string> = { ZOOM_CLIENT_ID: flow.clientId, ZOOM_REFRESH_TOKEN: refresh };
    // The email is only shown (the reader reads "me"). A Server-to-Server app's values from before may stay: with a refresh token,
    // src/zoom.ts uses this app and leaves them aside.
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) values.ZOOM_USER = email;
    return { ok: true, account, who: email && name ? `${name} (${email})` : account.user, values };
  };

  return { slack, zoom, urls: u };
}

/** The small page the browser lands on after the Allow: what happened, in plain words. Everything in it is text, never HTML. */
export function oauthPage(res: Response, status: number, ok: boolean, text: string): void {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  res
    .status(status)
    .set({ ...HEADERS, "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" })
    .type("html")
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
        + `<title>Pako</title><style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;`
        + `background:#f6f5f2;color:#1d1d1f}main{max-width:28rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}`
        + `@media (prefers-color-scheme:dark){body{background:#141414;color:#eee}}</style></head><body><main>`
        + `<h1>${ok ? "✓ Connected" : "Not connected"}</h1><p>${esc(text)}</p></main></body></html>`,
    );
}

/** The callback names this computer: 127.0.0.1, localhost or [::1], whatever the port. */
const namesThisComputer = (req: Request): boolean => {
  const h = hostOf(req.headers.host);
  return !!h && ["127.0.0.1", "localhost", "[::1]"].includes(h.name);
};

/** An OAuth callback's first check (here and src/mail-oauth.ts): it came from this computer's loopback, and names this computer. */
export const fromThisComputer = (req: Request): boolean => isLoopback(req.socket.remoteAddress) && namesThisComputer(req);

/**
 * The listener on the project's Slack app's fixed loopback port (SLACK_LOOPBACK_PORT). It is one per process: Pako restarts in place,
 * and a second listener would find the port taken, so a new mount only swaps the handler. It answers the Slack callback only, and closes
 * once the browser came back, or after a quarter of an hour with no sign-in started.
 */
const loopback: { server: Server | null; port: number; handler: ((req: Request, res: Response) => unknown) | null; timer: NodeJS.Timeout | null } = {
  server: null, port: 0, handler: null, timer: null,
};
/** Closes the listener: the browser came back (or nobody started a sign-in in time). The next Connect opens it again. */
function closeLoopback(): void {
  if (loopback.timer) clearTimeout(loopback.timer);
  loopback.timer = null;
  loopback.server?.close();
  loopback.server?.closeIdleConnections();
  loopback.server = null;
}
async function slackLoopback(port: number, handler: (req: Request, res: Response) => unknown): Promise<number> {
  loopback.handler = handler;
  if (loopback.timer) clearTimeout(loopback.timer);
  loopback.timer = setTimeout(closeLoopback, 15 * 60_000);
  loopback.timer.unref?.();
  if (loopback.server) return loopback.port;
  const mini = express();
  mini.get(CALLBACK.slack, (req, res) => void loopback.handler?.(req, res));
  mini.use((_req, res) => void res.status(404).set(HEADERS).type("text").send("Not here"));
  const server = createServer(mini);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  server.unref();
  loopback.server = server;
  loopback.port = (server.address() as { port: number }).port;
  return loopback.port;
}

const CLAUDE_PATHS = ["/panel/api/claude/connect", "/panel/api/claude/connect/cancel", "/panel/api/claude/signout"];
const PATHS = [
  "/panel/api/connect/clients", "/panel/api/slack/setup", "/panel/api/slack/connect", "/panel/api/slack/account",
  "/panel/api/zoom/setup", "/panel/api/zoom/manifest", "/panel/api/zoom/connect", "/panel/api/zoom/account",
  CALLBACK.slack, CALLBACK.zoom, ...CLAUDE_PATHS,
];

export function mountConnectSetup(app: Express, d: ConnectSetupDeps | null): void {
  if (!d) return localOnly(app, PATHS);
  const now = d.now ?? Date.now;
  const exchanges = createExchanges({ ...(d.fetch ? { fetch: d.fetch } : {}), ...(d.urls ? { urls: d.urls } : {}) });
  const body = express.json({ limit: "4kb" });
  mountClaudeConnect(app, d);
  /** The started connections, by their state. One per service at a time: a new Connect replaces the one before. */
  const flows = new Map<string, Flow>();
  /** What the last connection of each service came to, until the next Connect (or the restart it causes). */
  const last: Partial<Record<Service, { ok: true; account: Account } | { ok: false; error: string }>> = {};
  /** The services whose code is being exchanged now: their state is used up, and how it went is not known yet. */
  const exchanging = new Set<Service>();
  const sweep = (): void => {
    for (const [k, f] of flows) if (now() - f.at > FLOW_MS) flows.delete(k);
  };
  const port = (req: Request): number => req.socket.localPort ?? 8787;

  // Which cards are one button: the project's own app is there (src/connect-clients.ts). The others show the person's own-app steps.
  const clients = builtInClients(d.env ?? {}, d.defaults);
  app.get("/panel/api/connect/clients", guard(d, false), limit(60), (_req, res) => {
    res.json({ slack: !!clients.slack, zoom: !!clients.zoom, microsoft: !!clients.microsoft, google: !!clients.google, gmail: clients.gmail });
  });

  app.get("/panel/api/slack/setup", guard(d, false), limit(60), (req, res) => {
    const redirect = redirectUri("slack", port(req));
    res.json({ builtIn: !!clients.slack, createUrl: slackCreateUrl(redirect), redirectUri: redirect, scopes: SLACK_USER_SCOPES });
  });

  app.get("/panel/api/zoom/setup", guard(d, false), limit(60), async (req, res) => {
    const found = await d.discovery?.read().catch(() => null);
    res.json({
      builtIn: !!clients.zoom, createUrl: ZOOM_CREATE_URL, manifestUrl: "/panel/api/zoom/manifest", redirectUri: redirectUri("zoom", port(req)), scopes: ZOOM_USER_SCOPES,
      local: found?.zoomRecordings ?? null,
    });
  });

  app.get("/panel/api/zoom/manifest", guard(d, false), limit(30), (req, res) => {
    res.set("Content-Disposition", 'attachment; filename="pako-zoom-app.json"').type("application/json").send(JSON.stringify(zoomManifest(redirectUri("zoom", port(req))), null, 2));
  });
  // The same file, saved by Pako into the person's Downloads folder. The Mac app's window has no downloads of its own, and Zoom only takes
  // a file. Pako runs as the person, on their computer, so this is the folder they will pick it from.
  app.post("/panel/api/zoom/manifest", guard(d, true), limit(10), (req, res) => {
    const dir = d.downloads ?? join(homedir(), "Downloads");
    const file = join(dir, "pako-zoom-app.json");
    try {
      if (!existsSync(dir)) throw new Error("no Downloads folder");
      writeFileSync(file, `${JSON.stringify(zoomManifest(redirectUri("zoom", port(req))), null, 2)}\n`, { mode: 0o644 });
    } catch (err) {
      log.error(`could not save Zoom's app file: ${(err as Error).message}`);
      return void res.status(500).json({ ok: false });
    }
    res.json({ ok: true, path: file.startsWith(`${homedir()}/`) ? `~/${file.slice(homedir().length + 1)}` : file });
  });

  const start = (service: Service) => async (req: Request, res: Response): Promise<void> => {
    const typed = line((req.body as { clientId?: unknown } | undefined)?.clientId, 120);
    // No Client ID typed: the project's own app (one button). One typed: the person's own app (the Advanced way, or no built-in one).
    const builtIn = service === "slack" ? clients.slack : clients.zoom;
    const raw = typed || builtIn || "";
    if (!raw) return void res.status(400).json({ ok: false, error: say("noBuiltIn", { service: NAME[service] }) });
    // A Slack Client ID is two numbers joined by a dot; Zoom's is letters, digits, _ and -.
    const ok = service === "slack" ? /^\d{5,20}\.\d{5,20}$/.test(raw) : /^[A-Za-z0-9_-]{10,64}$/.test(raw);
    if (!ok) return void res.status(400).json({ ok: false, error: say(service === "slack" ? "slackId" : "zoomId") });
    // The project's Slack app returns to its one registered address, on a fixed port: a listener is opened there for the sign-in.
    let back = port(req);
    if (service === "slack" && !typed) {
      try {
        back = await slackLoopback(d.slackPort ?? SLACK_LOOPBACK_PORT, slackCallback);
      } catch {
        return void res.status(409).json({ ok: false, error: say("portBusy", { port: String(d.slackPort ?? SLACK_LOOPBACK_PORT) }) });
      }
    }
    sweep();
    for (const [k, f] of flows) if (f.service === service) flows.delete(k);
    delete last[service];
    const state = base64url(randomBytes(24));
    const { verifier, challenge } = pkcePair();
    const redirect = redirectUri(service, back);
    flows.set(state, { service, clientId: raw, verifier, redirect, at: now() });
    const u = exchanges.urls;
    const q = service === "slack"
      ? new URLSearchParams({ client_id: raw, scope: "", user_scope: SLACK_USER_SCOPES.join(","), redirect_uri: redirect, state, code_challenge: challenge, code_challenge_method: "S256" })
      : new URLSearchParams({ response_type: "code", client_id: raw, redirect_uri: redirect, state, code_challenge: challenge, code_challenge_method: "S256" });
    res.json({ ok: true, authorizeUrl: `${service === "slack" ? u.slackAuthorize : u.zoomAuthorize}?${q}` });
  };
  app.post("/panel/api/slack/connect", guard(d, true), limit(20), body, start("slack"));
  app.post("/panel/api/zoom/connect", guard(d, true), limit(20), body, start("zoom"));

  const account = (service: Service) => async (_req: Request, res: Response): Promise<void> => {
    sweep();
    const r = last[service];
    // Still waiting while the code is exchanged: the running reader would answer with the account from before this Connect.
    if (exchanging.has(service) || [...flows.values()].some((f) => f.service === service)) return void res.json({ state: "waiting" } satisfies AccountState);
    if (r && !r.ok) return void res.json({ state: "failed", error: r.error } satisfies AccountState);
    if (r?.ok) return void res.json({ state: "connected", account: r.account } satisfies AccountState);
    const ask = service === "slack" ? d.slackAccount?.() : d.zoomAccount?.();
    if (!ask) return void res.json({ state: "off" } satisfies AccountState);
    const a = await ask.catch(() => null);
    if (!a) return void res.json({ state: "unreachable" } satisfies AccountState);
    const acc: Account = "team" in a ? { user: a.user, ...(a.team ? { team: a.team } : {}) } : { user: a.name || a.email, ...(a.email ? { email: a.email } : {}) };
    res.json({ state: "connected", account: acc } satisfies AccountState);
  };
  app.get("/panel/api/slack/account", guard(d, false), limit(120), account("slack"));
  app.get("/panel/api/zoom/account", guard(d, false), limit(120), account("zoom"));

  const callback = (service: Service) => async (req: Request, res: Response): Promise<void> => {
    // From this computer and naming it, before anything is looked at: nothing that comes over the network, or under another name, gets in.
    if (!fromThisComputer(req)) return oauthPage(res, 403, false, say("notHere"));
    sweep();
    const q = req.query as Record<string, unknown>;
    const state = typeof q.state === "string" ? q.state : "";
    const flow = flows.get(state);
    if (!flow || flow.service !== service) return oauthPage(res, 400, false, say("stale"));
    // A state works once, whatever comes of it.
    flows.delete(state);
    exchanging.add(service);
    try {
      await finish(service, flow, q, res);
    } finally {
      exchanging.delete(service);
      // The project's Slack app's port is not held once its sign-in is over (another program may want it): only while one is under way.
      if (service === "slack" && ![...flows.values()].some((f) => f.service === "slack")) closeLoopback();
    }
  };
  const finish = async (service: Service, flow: Flow, q: Record<string, unknown>, res: Response): Promise<void> => {
    const fail = (error: string): void => {
      last[service] = { ok: false, error };
      oauthPage(res, 200, false, error);
    };
    if (typeof q.error === "string") {
      // Slack's "access_denied" is the person's Cancel; an admin approval request comes back as its own error.
      return fail(/approval|admin/i.test(q.error) ? say("admin") : say("refused"));
    }
    const code = typeof q.code === "string" && /^[A-Za-z0-9._~-]{4,512}$/.test(q.code) ? q.code : "";
    if (!code) return fail(say("exchange", { service: NAME[service], why: "no code" }));
    const done = await exchanges[service](flow, code);
    if (!done.ok) return fail(done.error);
    if (!d.saver) return fail(say("notKept", { why: "this Pako cannot save connections" }));
    const saved = await d.saver.save(service, done.values!);
    if (!saved.ok) return fail(say("notKept", { why: saved.error }));
    last[service] = { ok: true, account: done.account };
    oauthPage(res, 200, true, say("done", { who: done.who }));
    // After the page has gone: Pako restarts so the reader starts with the new values, and the panel, which is asking for the account,
    // waits for it and then hears from the reader itself.
    d.saver.restartAfter(res);
  };
  const slackCallback = callback("slack");
  app.get(CALLBACK.slack, limit(20), slackCallback);
  app.get(CALLBACK.zoom, limit(20), callback("zoom"));
}

// ---------- Claude ----------

function mountClaudeConnect(app: Express, d: ConnectSetupDeps): void {
  const c = d.claude;
  if (!c) return localOnly(app, CLAUDE_PATHS);
  const body = express.json({ limit: "1kb" });
  // Polled every two seconds while the panel shows a step under way.
  app.get(CLAUDE_PATHS[0]!, guard(d, false), limit(120), async (_req, res) => {
    if (!c.busy()) await c.check(30_000);
    res.json(c.view());
  });
  app.post(CLAUDE_PATHS[0]!, guard(d, true), limit(20), body, async (req, res) => {
    const b = isObject(req.body) ? req.body : {};
    void c.start({ switch: b.switch === true, again: b.again === true });
    // A moment for the first step to show (the look for `claude`), so the answer already says it is under way.
    await new Promise((r) => setTimeout(r, 50));
    res.json(c.view());
  });
  app.post(CLAUDE_PATHS[1]!, guard(d, true), limit(20), async (_req, res) => {
    await c.cancel();
    res.json(c.view());
  });
  app.post(CLAUDE_PATHS[2]!, guard(d, true), limit(10), body, async (req, res) => {
    const b = isObject(req.body) ? req.body : {};
    if (b.confirm !== true) return void res.status(400).json({ ok: false, error: "confirm" });
    const ok = await c.signOut();
    res.json({ ok, ...c.view() });
  });
}
