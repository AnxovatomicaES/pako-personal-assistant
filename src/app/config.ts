// The app's settings and the shapes createApp is given: the server's own settings (port, admin key, proxies, the phone line), the admin
// key's check, local mode's context (src/local.ts and src/server.ts fill it), and the note for the ignored PAKO_LANGUAGE.

import { sameSecret } from "../panel-guard.ts";
import type { Request } from "express";
import type { SessionGeneration } from "../dashboard.ts";
import type { Kv } from "../kv.ts";
import type { BridgeHealth, BridgeStatus, LocalChannel, LocalSettings } from "../local.ts";
import { loadPersonalConfigSafely, type PersonalConfig } from "../personal-caller.ts";
import type { StoreLost } from "../store-guard.ts";

export type Env = Record<string, string | undefined>;

export interface AppConfig {
  port: number;
  /** Opens the /admin routes (Basic or Bearer auth, or an X-Admin-Key header). Empty: they answer 401. */
  adminKey: string;
  /** Proxies in front of the app whose X-Forwarded-For is trusted (default 3 on Render, as measured). 0 = the socket address. */
  trustProxyHops: number;
  retell: { apiKey: string; fromNumber: string };
  /** Null when PERSONAL_CALLER_TOKEN is unset or a personal setting is wrong: the server still starts, without the line. */
  personalCaller: PersonalConfig | null;
}

/** The settings once the phone line's are known to be right: everything that hangs from the owner's settings is wired with these. */
export type OwnedConfig = AppConfig & { personalCaller: PersonalConfig };

export const ownsLine = (config: AppConfig): config is OwnedConfig => config.personalCaller !== null;

const intFrom = (env: Env, name: string, fallback: number): number => {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${name} must be a whole number`);
  return n;
};

export function loadAppConfig(env: Env = process.env): AppConfig {
  const port = intFrom(env, "PORT", 8787);
  if (port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535");
  const adminKey = env.ADMIN_KEY ?? "";
  if (adminKey && adminKey.length < 24) throw new Error("ADMIN_KEY must be at least 24 characters");
  return {
    port,
    adminKey,
    // Render was measured at 3 proxies (Cloudflare, its balancer, a local proxy): with fewer, every visitor shares one address in the rate limits.
    trustProxyHops: intFrom(env, "TRUST_PROXY_HOPS", env.RENDER ? 3 : 0),
    retell: { apiKey: env.RETELL_API_KEY ?? "", fromNumber: env.RETELL_FROM_NUMBER ?? "" },
    personalCaller: loadPersonalConfigSafely(env),
  };
}

/** Headers for the admin answers: nothing cached, no referrer, no framing. */
export const ADMIN_HEADERS: Record<string, string> = {
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

/** The admin key from Basic auth (any username), Bearer, or X-Admin-Key. Constant-time compare, of hashes: no early answer for a wrong length. */
export function adminRequest(req: Request, adminKey: string): boolean {
  const own = req.get("x-admin-key");
  const header = own !== undefined ? `Bearer ${own}` : req.headers.authorization;
  if (!header || !adminKey) return false;
  let supplied = "";
  if (header.toLowerCase().startsWith("bearer ")) supplied = header.slice(7).trim();
  else if (header.toLowerCase().startsWith("basic ")) {
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
    supplied = decoded.slice(decoded.indexOf(":") + 1);
  }
  return sameSecret(supplied, adminKey);
}

/** Local mode (src/local.ts): what the server needs to run for one person on this computer, with no WhatsApp. */
export interface LocalContext {
  /** The file store at home (src/sqlite-kv.ts): `onSave` tells the watchdog how each save went. */
  kv: Kv & { onSave?: (report: (ok: boolean, detail?: string, since?: number) => void) => void };
  channel: LocalChannel;
  bridgeToken: string;
  /** The secret that signs the panel's sessions, kept between starts so the browser stays signed in. */
  panelSecret: string;
  /** The supervised bridge (src/local.ts): its status for the chat's banner, and what it reports about Claude. */
  bridge: { status: () => BridgeStatus; report?: (claude: BridgeHealth) => void; refresh?: () => Promise<BridgeStatus> };
  /**
   * For the store guard (src/store-guard.ts): whether this is the person's first run, and why the file store started empty, if it did.
   * Absent: nothing is ever paused for it.
   */
  storeStart?: { firstRun: boolean; lost: StoreLost | null };
  /** What the person chose in the panel: their name, the welcome (src/local.ts). */
  settings?: LocalSettings;
  /**
   * Tests only: the fetch and the name lookup the ICS feeds are read through (src/ics.ts). Absent: the guarded fetch of
   * src/restaurants/website.ts, each hop's host checked to be public.
   */
  icsNet?: { fetch: typeof fetch; resolve: (host: string) => Promise<string[]> };
  /**
   * The panel's sessions' generation kept with the run secrets of Pako's real folder (src/local.ts sessionGeneration), so "Sign out
   * everywhere" holds through Delete everything and the demo week. Absent (tests): kept in the store only.
   */
  sessionGeneration?: SessionGeneration;
  /**
   * The demo week (src/demo.ts): `on` while it runs (its sources are the demo store's, nothing goes out), and Pako's real home, where the
   * panel makes and deletes the demo's folder. Absent: off, the home from PAKO_HOME.
   */
  demo?: { on: boolean; home: string };
}

/**
 * PAKO_LANGUAGE once chose the language of Pako's own texts (Spanish or English). Those are English only now, and Claude answers in the
 * language each message is written in, so the setting does nothing: a server that still has it starts as usual and says so once in its log.
 */
export const languageIgnoredNote = (env: Env): string | null =>
  (env.PAKO_LANGUAGE ?? "").trim()
    ? "PAKO_LANGUAGE is ignored: Pako's own texts are English; Claude replies in the language you write in"
    : null;
