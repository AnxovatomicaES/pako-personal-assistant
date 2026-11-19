// What the connection helpers' panel routes share (src/discovery.ts, src/calendar-local.ts, src/contacts.ts, src/mail-autoconfig.ts,
// src/connect-setup.ts, src/connections-status.ts): the same protection as the STOP switch, the same headers, the same rate limits.
//
// Two ways in, both on a person's computer only:
// - The panel: its signed-in session, and on a change the x-pako header that another site cannot send.
// - The Mac app's own requests (URLSession, not its web view): the bridge token it already reads from ~/.pako/secrets.json, as a Bearer
//   header, from this computer only (the socket's address, never a header), and never from a browser (no Origin, no Sec-Fetch-Site).

import { createHash, timingSafeEqual } from "node:crypto";
import type { Express, Request, RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { isLoopback } from "./dashboard.ts";

export const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

export interface RouteAuth {
  /** The panel's session check (src/dashboard.ts). */
  signedIn: (req: Request) => boolean;
  /** The bridge token the Mac app sends as `Authorization: Bearer`; absent: only the panel's session. */
  appToken?: string;
}

const same = (a: string, b: string): boolean => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

/** The Mac app's own request: its token, from this computer, not from a browser page. */
export function fromApp(req: Request, token: string | undefined): boolean {
  if (!token) return false;
  const m = /^Bearer (.+)$/.exec(req.get("authorization") ?? "");
  if (!m || !same(m[1]!, token)) return false;
  return isLoopback(req.socket.remoteAddress) && req.get("origin") === undefined && req.get("sec-fetch-site") === undefined;
}

/** `change`: a POST or DELETE, which needs the x-pako header too when it comes from the panel. */
export const guard = (a: RouteAuth, change: boolean): RequestHandler => (req, res, next) => {
  res.set(HEADERS);
  if (fromApp(req, a.appToken)) return next();
  if (!a.signedIn(req) || (change && req.get("x-pako") !== "1")) {
    res.status(401).json({ error: "sign in" });
    return;
  }
  next();
};

export const limit = (n: number): RequestHandler =>
  rateLimit({ windowMs: 60_000, limit: n, standardHeaders: "draft-8", legacyHeaders: false, handler: (_req, res) => void res.status(429).json({ error: "too many" }) });

/** A server's panel: every one of these routes answers 404 (its settings are its environment). */
export function localOnly(app: Express, paths: string[]): void {
  app.all(paths, (_req, res) => {
    res.status(404).set(HEADERS).json({ error: "local mode only" });
  });
}

/** One line of text, cut, or "" when it is not text. */
export const line = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim().slice(0, max) : "");

/** A plain email address, lower case, or "" when it is not one. */
export const emailOf = (v: unknown): string => {
  const s = line(v, 254).toLowerCase();
  return /^[^\s@<>()",;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : "";
};

export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** At most `ms` of waiting: null after it. */
export const within = <V>(p: Promise<V>, ms: number): Promise<V | null> => {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
};
