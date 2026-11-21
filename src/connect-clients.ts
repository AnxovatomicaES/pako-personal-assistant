// The project's own apps at Slack, Zoom, Microsoft and Google: one each, used by every Pako, so connecting is one "Connect" button and
// an Allow on the vendor's page. Nobody creates an app or pastes a Client ID.
//
// They are public clients:
// - Each signs in with PKCE and sends the browser back to this computer (a loopback address).
// - None holds a secret. A Client ID is not one, so it may live in the code.
// - Google is the exception that proves it: Google gives a desktop client a "secret" too, its token endpoint asks for it even with PKCE,
//   and its own documentation says an installed app's secret is not treated as confidential.
//
// The IDs are EMPTY until the project owner registers the apps (docs/owner-app-setup.md says how, click by click), then pastes them here.
// While one is empty, that card falls back to the person's own app (Slack, Zoom) or to the other ways in (mail: forwarding or an app
// password), so a Pako built from source by anyone still connects. PAKO_<VENDOR>_CLIENT_ID overrides a built-in one: an owner tries a new
// registration on one computer first, a self-builder uses their own.

type Env = Record<string, string | undefined>;

export const SLACK_CLIENT_ID = "12665943306579.12665955320899";
export const ZOOM_CLIENT_ID = "";
/** One multi-tenant public client for mail (IMAP) and calendar (Microsoft Graph): one consent covers both. */
export const MS_CLIENT_ID = "";
/** One desktop client for Google Calendar and, once Google allows it, Gmail. */
export const GOOGLE_CLIENT_ID = "";
export const GOOGLE_CLIENT_SECRET = "";
/**
 * Gmail's scope (https://mail.google.com/) is restricted. Google lets an app use it for its listed test users while in testing, and for
 * everyone only once verified. Turn this on then (or PAKO_GOOGLE_GMAIL=on on a test user's computer). Until then Gmail is read with an
 * app password, and the Google button connects the calendar only.
 */
export const GOOGLE_GMAIL_ALLOWED = false;

/**
 * The fixed loopback port the project's Slack app sends the browser back to. Slack matches a desktop redirect against the URLs registered
 * on the app, and whether it ignores the port is not documented. So the project's app registers exactly this address
 * (http://localhost:53682/connect/slack/callback), and Pako opens a small listener on it for the minutes a sign-in takes. Pako's own port
 * may differ from computer to computer, but this one does not.
 */
export const SLACK_LOOPBACK_PORT = 53682;

/**
 * Where the project's Slack app sends the browser back to. Slack lets an app be installed in other workspaces only when every redirect URL
 * is https, so it cannot return to http://localhost directly. This page on the project's site (site/connect/slack/callback.html) passes
 * the code and state on to http://localhost:SLACK_LOOPBACK_PORT/connect/slack/callback at once and keeps nothing. The code alone is
 * worthless: exchanging it needs the PKCE verifier, which never leaves this computer.
 */
export const SLACK_RELAY_REDIRECT = "https://pako-os.com/connect/slack/callback.html";

/**
 * Whether the project's Slack app is listed in the Slack Marketplace. Until it is, Slack treats it as a commercially distributed app and
 * allows it one conversations.history call a minute (since 2025-05-29), so Pako reads one DM per look. Listed: the usual Tier 3 limits.
 * A person's own app is an internal one and is never limited this way.
 */
export const SLACK_MARKETPLACE_LISTED = false;

export interface BuiltInDefaults {
  slack: string;
  zoom: string;
  microsoft: string;
  google: string;
  googleSecret: string;
  gmail: boolean;
}
export const DEFAULTS: BuiltInDefaults = {
  slack: SLACK_CLIENT_ID, zoom: ZOOM_CLIENT_ID, microsoft: MS_CLIENT_ID, google: GOOGLE_CLIENT_ID, googleSecret: GOOGLE_CLIENT_SECRET,
  gmail: GOOGLE_GMAIL_ALLOWED,
};

export interface BuiltInClients {
  slack: string | null;
  zoom: string | null;
  microsoft: string | null;
  google: { id: string; secret?: string } | null;
  /** Whether Gmail may be read by signing in with Google (the restricted scope, see GOOGLE_GMAIL_ALLOWED). */
  gmail: boolean;
}

/** The client each card signs in with: an environment value wins over the built-in one; only a well-formed ID counts. */
export function builtInClients(env: Env, defaults: BuiltInDefaults = DEFAULTS): BuiltInClients {
  const pick = (key: string, d: string, ok: RegExp): string | null => {
    const v = (env[key] ?? "").trim() || d;
    return ok.test(v) ? v : null;
  };
  const google = pick("PAKO_GOOGLE_CLIENT_ID", defaults.google, /^[\w.-]{10,200}\.apps\.googleusercontent\.com$/);
  const secret = (env.PAKO_GOOGLE_CLIENT_SECRET ?? "").trim() || defaults.googleSecret;
  const gmailEnv = (env.PAKO_GOOGLE_GMAIL ?? "").trim().toLowerCase();
  return {
    slack: pick("PAKO_SLACK_CLIENT_ID", defaults.slack, /^\d{5,20}\.\d{5,20}$/),
    zoom: pick("PAKO_ZOOM_CLIENT_ID", defaults.zoom, /^[A-Za-z0-9_-]{10,64}$/),
    microsoft: pick("PAKO_MS_CLIENT_ID", defaults.microsoft, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
    google: google ? { id: google, ...(secret ? { secret } : {}) } : null,
    gmail: !!google && (gmailEnv ? gmailEnv === "on" : defaults.gmail),
  };
}
