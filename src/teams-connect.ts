// Connecting Microsoft Teams: one button, with the project's own Microsoft app (MS_CLIENT_ID, src/connect-clients.ts), the same public
// client and the same PKCE-and-loopback sign-in as Microsoft mail and calendar (src/mail-oauth.ts). No new client ID.
//
// - Microsoft already connected for mail: "Connect Teams" asks only for Teams' permissions, with the same account as a hint. Microsoft's
//   consent is incremental, so its page shows just the new ones: one Allow. Not connected: the one sign-in covers what Teams needs.
// - By default only what an employee may grant alone (src/teams.ts TEAMS_SCOPES: chats, the calendar's meetings, who they are). Channel
//   mentions and transcripts need the company's admin: "Add what my admin approved" asks for them once the admin said yes, and the card
//   gives a copyable request for the admin with what each one adds and the tenant-wide approval link.
// - Many companies now let nobody consent to chats or calendars alone (Microsoft's managed default, since late 2025). Microsoft then
//   answers "admin approval required"; Pako says so plainly and shows the request for the admin instead of a bare error.
// - A personal Microsoft account (Teams free) has no Graph API for chats: said plainly, nothing kept.
//
// After the Allow: the code is exchanged (PKCE, no secret), one look at who signed in and at the chats, and the sign-in kept in the secret
// store through the panel's saver (TEAMS_REFRESH_TOKEN and who it is), then Pako restarts and src/teams.ts reads. Disconnecting is the
// panel's own remove (POST /panel/api/connections/remove { id: "teams" }).
//
//   POST /panel/api/teams/connect   { more? } -> { ok, authorizeUrl, incremental } | { ok: false, error }
//   GET  /panel/api/teams/account   -> { state: "off" | "waiting" | "failed" | "connected", account?, error?, adminNeeded? }
//   GET  /panel/api/teams/status    -> the card: account, organisation, what is granted, last read, last error, the admin's request
//   GET  /connect/teams/callback

import { randomBytes } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import { builtInClients, type BuiltInDefaults } from "./connect-clients.ts";
import { emailOf, guard, limit, line, localOnly, type RouteAuth } from "./connect-routes.ts";
import { base64url, fromThisComputer, oauthPage, pkcePair } from "./connect-setup.ts";
import type { ConnectionsSaver } from "./connections-panel.ts";
import { idClaims } from "./mail-oauth.ts";
import {
  CONSUMER_TENANT, GRAPH_API, graphScopes, MS_LOGIN, SIGN_IN_SCOPES, TEAMS_ADMIN_SCOPES, TEAMS_SCOPES, type Granted,
  type TeamsStatus,
} from "./teams.ts";

type Env = Record<string, string | undefined>;

const SAY = {
  noClient: "Connecting Teams isn't set up in this Pako yet: the project's Microsoft app isn't registered.",
  refused: "You didn't allow it, so nothing was connected. Press Connect Teams again when you're ready.",
  admin: "Your organisation needs an admin to approve Pako before it can read Teams. Go back to Pako: the Teams card has a request you can copy and send to your IT admin.",
  stale: "This link has expired or was already used. Go back to Pako and press Connect Teams again.",
  notHere: "This only works on the computer where Pako runs.",
  exchange: "Microsoft didn't accept the sign-in: {why}. Press Connect Teams again.",
  noRefresh: "Microsoft gave no lasting sign-in. Press Connect Teams again.",
  personal: "That's a personal Microsoft account. Microsoft doesn't let any app read Teams chats of personal accounts, so there is nothing Pako can connect. A work or school account works.",
  chats: "Signed in, but Teams refused to share your chats: {why}. Your organisation may need an admin to approve Pako.",
  notKept: "Signed in, but Pako couldn't keep it on this computer: {why}",
  done: "Connected to Teams as {who}. Pako reads your chats (read only). You can close this tab and go back to Pako.",
  adminText:
    "Hi, could you approve the app \"Pako\" for my Microsoft 365 account? It is a personal assistant that runs on my own computer and reads "
    + "my Teams, read only, so I don't drop anything I promised. It never sends messages.\n\n"
    + "What it asks for:\n{lines}\n\n"
    + "To approve it for the organisation, open this link signed in as an admin and press Accept (the page it returns to may not load; "
    + "that's fine):\n{url}\n\n"
    + "Or in the Microsoft Entra admin center: Enterprise applications, Pako, Permissions, Grant admin consent.",
  lineChats: "- Chat.Read, Calendars.Read, User.Read: my own chats and the Teams meetings on my calendar (needed for anything to work)",
  lineMentions: "- ChannelMessage.Read.All, Team.ReadBasic.All, Channel.ReadBasic.All: channel messages that @mention me",
  lineTranscripts: "- OnlineMeetings.Read, OnlineMeetingTranscript.Read.All: the transcripts of meetings I was in, to keep track of what was agreed",
};
const say = (k: keyof typeof SAY, v: Record<string, string> = {}): string => SAY[k].replace(/\{(\w+)\}/g, (m, x: string) => v[x] ?? m);

const ADMIN_ALL = [...TEAMS_ADMIN_SCOPES.mentions, ...TEAMS_ADMIN_SCOPES.transcripts];
const FLOW_MS = 10 * 60_000;
const PATHS = ["/panel/api/teams/connect", "/panel/api/teams/account", "/panel/api/teams/status", "/connect/teams/callback"];

export const teamsRedirectUri = (port: number): string => `http://127.0.0.1:${port}/connect/teams/callback`;

/** Microsoft's answer when the company lets nobody consent alone (admin approval required, or consent required for this tenant). */
export const needsAdmin = (error: string, description: string): boolean =>
  /AADSTS(65001|65004|90094|90095|90008)\b/.test(description) || /admin/i.test(description) || error === "consent_required";

/** The admin's request: what each permission adds, and the tenant-wide approval link (Microsoft's admin-consent page for this app). */
export function adminRequest(clientId: string, tenant: string, port: number, o: { chats: boolean } = { chats: true }): { text: string; url: string } {
  const scopes = graphScopes([...(o.chats ? TEAMS_SCOPES : []), ...ADMIN_ALL]);
  const q = new URLSearchParams({ client_id: clientId, scope: scopes, redirect_uri: teamsRedirectUri(port).replace(/:\d+\//, "/") });
  const url = `${MS_LOGIN}/${/^[0-9a-f-]{36}$/i.test(tenant) ? tenant : "organizations"}/v2.0/adminconsent?${q}`;
  const lines = [...(o.chats ? [say("lineChats")] : []), say("lineMentions"), say("lineTranscripts")].join("\n");
  return { text: say("adminText", { lines, url }), url };
}

export interface TeamsConnectDeps extends RouteAuth {
  env: Env;
  saver: ConnectionsSaver | null;
  /** The running reader's card facts (src/teams.ts status), when Teams is connected. */
  status?: () => Promise<TeamsStatus | null>;
  fetch?: typeof fetch;
  now?: () => number;
  /** For the tests: a fake Microsoft sign-in and a fake Graph. */
  login?: string;
  graph?: string;
  defaults?: BuiltInDefaults;
}

type Last = { ok: true; user: string; name: string } | { ok: false; error: string; adminNeeded?: boolean } | null;

export function mountTeamsConnect(app: Express, d: TeamsConnectDeps | null): void {
  if (!d) return localOnly(app, PATHS);
  const f = d.fetch ?? fetch;
  const now = d.now ?? Date.now;
  const login = (d.login ?? MS_LOGIN).replace(/\/+$/, "");
  const graph = (d.graph ?? GRAPH_API).replace(/\/+$/, "");
  const client = builtInClients(d.env, d.defaults).microsoft;
  const flows = new Map<string, { verifier: string; redirect: string; scope: string; at: number }>();
  let last: Last = null;
  /** The tenant Microsoft named at the last sign-in (for the admin's link), and what a refused sign-in asked for. */
  let tenant = (d.env.TEAMS_TENANT ?? "").trim();
  const sweep = (): void => {
    for (const [k, fl] of flows) if (now() - fl.at > FLOW_MS) flows.delete(k);
  };
  /** Microsoft is already connected for mail: its address is the hint, and Microsoft asks only for what is new. */
  const microsoftMail = (): string => ((d.env.IMAP_OAUTH ?? "").trim() === "microsoft" ? emailOf(d.env.IMAP_USER) : "");

  app.post("/panel/api/teams/connect", guard(d, true), limit(20), express.json({ limit: "2kb" }), (req, res) => {
    if (!client) return void res.status(409).json({ ok: false, error: say("noClient") });
    const more = (req.body as { more?: unknown } | undefined)?.more === true;
    sweep();
    flows.clear();
    last = null;
    const state = base64url(randomBytes(24));
    const { verifier, challenge } = pkcePair();
    const redirect = teamsRedirectUri(req.socket.localPort ?? 8787);
    const scope = `${graphScopes([...TEAMS_SCOPES, ...(more ? ADMIN_ALL : [])])} ${SIGN_IN_SCOPES}`;
    flows.set(state, { verifier, redirect, scope, at: now() });
    const q = new URLSearchParams({ client_id: client, response_type: "code", redirect_uri: redirect, scope, state, code_challenge: challenge, code_challenge_method: "S256" });
    const hint = emailOf(d.env.TEAMS_ACCOUNT) || microsoftMail();
    if (hint) q.set("login_hint", hint);
    // A work account only: "organizations" keeps personal accounts off Microsoft's page, where they could never read Teams anyway.
    res.json({ ok: true, authorizeUrl: `${login}/organizations/oauth2/v2.0/authorize?${q}`, incremental: !!microsoftMail() });
  });

  app.get("/panel/api/teams/account", guard(d, false), limit(120), (_req, res) => {
    sweep();
    if (flows.size) return void res.json({ state: "waiting" });
    if (!last) return void res.json({ state: "off" });
    res.json(last.ok ? { state: "connected", account: { user: last.user, team: last.name } }
      : { state: "failed", error: last.error, ...(last.adminNeeded ? { adminNeeded: true } : {}) });
  });

  app.get("/panel/api/teams/status", guard(d, false), limit(120), async (req, res) => {
    const port = req.socket.localPort ?? 8787;
    const on = !!(d.env.TEAMS_REFRESH_TOKEN ?? "").trim();
    const s = on && d.status ? await d.status().catch(() => null) : null;
    const granted: Granted = s?.granted ?? { chats: false, calendar: false, mentions: false, transcripts: false };
    // The admin's request: always there once something needs them (a refused sign-in, or the admin-only parts not granted yet).
    const wantAdmin = !on || !granted.mentions || !granted.transcripts;
    const request = client && wantAdmin ? adminRequest(client, tenant, port, { chats: !on || !granted.chats }) : null;
    res.json({
      available: !!client,
      connected: on,
      account: line(s?.account ?? d.env.TEAMS_ACCOUNT, 320),
      name: line(s?.name ?? d.env.TEAMS_NAME, 120),
      org: line(s?.org ?? d.env.TEAMS_ORG, 160),
      granted,
      transcriptsOff: s?.transcriptsOff ?? false,
      lastRead: s?.lastRead ?? null,
      lastError: s?.lastError ?? (last && !last.ok ? last.error : null),
      throttledUntil: s?.throttledUntil ?? null,
      adminNeeded: !!(last && !last.ok && last.adminNeeded),
      incremental: !!microsoftMail(),
      ...(request ? { adminText: request.text, adminUrl: request.url } : {}),
    });
  });

  app.get("/connect/teams/callback", limit(20), async (req: Request, res: Response) => {
    if (!fromThisComputer(req)) return oauthPage(res, 403, false, say("notHere"));
    sweep();
    const q = req.query as Record<string, unknown>;
    const flow = flows.get(typeof q.state === "string" ? q.state : "");
    if (!flow) return oauthPage(res, 400, false, say("stale"));
    flows.clear();
    const fail = (error: string, adminNeeded = false): void => {
      last = { ok: false, error, ...(adminNeeded ? { adminNeeded } : {}) };
      oauthPage(res, 200, false, error);
    };
    if (typeof q.error === "string") {
      const desc = typeof q.error_description === "string" ? q.error_description : "";
      return needsAdmin(q.error, desc) ? fail(say("admin"), true) : fail(say("refused"));
    }
    const code = typeof q.code === "string" && /^[\w.~/*!$-]{4,4096}$/.test(q.code) ? q.code : "";
    if (!code || !client) return fail(say("exchange", { why: "no code" }));
    let j: Record<string, unknown>;
    try {
      const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: flow.redirect, client_id: client, code_verifier: flow.verifier, scope: flow.scope });
      const r = await f(`${login}/organizations/oauth2/v2.0/token`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(), signal: AbortSignal.timeout(15_000),
      });
      j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    } catch {
      /* the network failed: said to the user as no answer */
      return fail(say("exchange", { why: "no answer" }));
    }
    if (typeof j.access_token !== "string") {
      const desc = typeof j.error_description === "string" ? j.error_description : "";
      if (needsAdmin(String(j.error ?? ""), desc)) return fail(say("admin"), true);
      return fail(say("exchange", { why: typeof j.error === "string" ? j.error.slice(0, 80) : "no token" }));
    }
    if (typeof j.refresh_token !== "string" || !j.refresh_token) return fail(say("noRefresh"));
    const claims = idClaims(j.id_token);
    if (claims.tid === CONSUMER_TENANT) return fail(say("personal"));
    if (typeof claims.tid === "string") tenant = claims.tid;
    const access = j.access_token;
    const ask = async (path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
      try {
        const r = await f(`${graph}${path}`, { headers: { authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(15_000) });
        return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
      } catch {
        /* no answer: status 0, said below */
        return { status: 0, body: {} };
      }
    };
    // One look at the chats with the new token before anything is kept: a company that blocks Teams' API is said now, plainly.
    const chats = await ask("/me/chats?$top=1");
    if (chats.status !== 200) {
      const e = chats.body.error as { code?: unknown } | undefined;
      return fail(say("chats", { why: typeof e?.code === "string" ? e.code.slice(0, 60) : chats.status ? `HTTP ${chats.status}` : "no answer" }), chats.status === 403);
    }
    const me = await ask("/me?$select=displayName,mail,userPrincipalName");
    const org = await ask("/organization?$select=displayName");
    const user = emailOf(me.body.mail) || emailOf(me.body.userPrincipalName) || emailOf(claims.preferred_username) || emailOf(claims.email);
    const name = line(me.body.displayName, 120);
    const orgName = line(((org.body.value as { displayName?: unknown }[] | undefined) ?? [])[0]?.displayName, 160);
    if (!d.saver) return fail(say("notKept", { why: "this Pako cannot save connections" }));
    const saved = await d.saver.save("teams", {
      TEAMS_REFRESH_TOKEN: j.refresh_token, TEAMS_CLIENT_ID: client, ...(user ? { TEAMS_ACCOUNT: user } : {}), ...(name ? { TEAMS_NAME: name } : {}),
      ...(orgName ? { TEAMS_ORG: orgName } : {}), ...(typeof claims.tid === "string" && /^[0-9a-f-]{36}$/i.test(claims.tid) ? { TEAMS_TENANT: claims.tid } : {}),
    });
    if (!saved.ok) return fail(say("notKept", { why: saved.error }));
    last = { ok: true, user: user || name, name: orgName };
    oauthPage(res, 200, true, say("done", { who: [name, user && `(${user})`].filter(Boolean).join(" ") || "you" }));
    d.saver.restartAfter(res);
  });
}
