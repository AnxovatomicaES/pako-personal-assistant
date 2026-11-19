// The clients Pako signs in to Microsoft and Google mail with (src/mail-oauth.ts), from the project's built-in apps (src/connect-clients.ts),
// kept apart so the mailbox reader (src/imap.ts) can name a missing one without importing the sign-in routes.

import { builtInClients, type BuiltInDefaults } from "./connect-clients.ts";

type Env = Record<string, string | undefined>;
export type MailOAuthProvider = "microsoft" | "google";

export interface MailClients {
  microsoft: { id: string } | null;
  /** Google for mail only when Gmail's restricted scope is allowed (GOOGLE_GMAIL_ALLOWED, PAKO_GOOGLE_GMAIL). */
  google: { id: string; secret?: string } | null;
}

export function mailClients(env: Env, defaults?: BuiltInDefaults): MailClients {
  const c = builtInClients(env, defaults);
  return { microsoft: c.microsoft ? { id: c.microsoft } : null, google: c.google && c.gmail ? c.google : null };
}
