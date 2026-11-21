// The phone's page and its routes (src/panel/m.html, m.js, m-model.js, m.css), served by the phone's own server on the home network
// (src/mobile-access.ts) and nothing else: this app has none of the panel's routes, so a device token opens these few and no more.
//
//   GET  /m, /m/pair                 the page (no data in it; the pairing code rides in the address's #fragment, never sent here)
//   GET  /m/assets/<file>            its script, styles, the web app manifest and the home-screen icons
//   POST /m/api/pair  {code, name}   a pairing code (one use, 10 minutes) → the device token, in an httpOnly cookie
//   GET  /m/api/today                today's brief with its sources, the open loops both ways, parked and just closed ones, drafts
//   POST /m/api/loop  {id, action}   done | snooze (1 h) | tomorrow | park | reopen: the same engine calls as the chat's buttons
//   POST /m/api/draft {id}           a draft reply for one loop (written on the assistant's computer, as DRAFT in the chat)
//   POST /m/api/forget               this phone forgets itself
//
// Every request names one of the addresses it listens on (Host), so another site's name pointed at this computer (DNS rebinding) is
// refused. What changes something needs the x-pako header (a page on another site cannot send it without asking first, and is never
// answered yes) and an Origin of this server, and the cookie is SameSite=Strict, so another site's page cannot press anything for the owner.
// The token is never in an address, and no answer here carries it but the pairing's Set-Cookie.

import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { readFileSync } from "node:fs";
import { rateLimit } from "express-rate-limit";
import { hostOf } from "./guard-http.ts";
import { iconPng } from "./mobile-icon.ts";
import type { MobileAccess, MobileDevice } from "./mobile-access.ts";
import { createLog } from "./log.ts";

const log = createLog("mobile");

export const PHONE_COOKIE = "pako_phone";
/** Browsers keep a cookie 400 days at most: it is set again on each visit, so a phone in use never loses it. */
const COOKIE_MS = 400 * 24 * 3600_000;

/** One loop as the phone shows it. */
export interface MobileLoop {
  id: string;
  kind: string;
  title: string;
  who: string;
  where: string;
  status: string;
  nudges: number;
  dueAt?: number;
  lastCheck?: string;
  step?: string;
  parkedAt?: number;
  closedAt?: number;
  /** An email address to answer to, when the loop names one. */
  to?: string;
  /** The draft asked for it: being written, written (its text), or failed. */
  draft?: { status: string; text: string };
}

export interface MobileToday {
  now: number;
  timeZone: string;
  name: string;
  /** Gentle mode: a time passed is "time passed", never "overdue". */
  gentle: boolean;
  /** The written brief (null when it is off): today's, or the last one with its time. */
  brief: { doc: unknown; latest: unknown; pending: boolean } | null;
  /** Open and snoozed loops (null when the follow-ups are off). */
  loops: MobileLoop[] | null;
  parked: MobileLoop[];
  /** Closed in the last two days: what Reopen can bring back. */
  closed: MobileLoop[];
  /** Whether Telegram is set up: the page says to use it away from home. */
  telegram: boolean;
  /** Whether a draft can be asked for (the written brief is on). */
  drafts: boolean;
}

export const MOBILE_ACTIONS = ["done", "snooze", "tomorrow", "park", "reopen"] as const;
export type MobileAction = (typeof MOBILE_ACTIONS)[number];

export interface MobileDeps {
  access: MobileAccess;
  /** The addresses the phone's server listens on now: the only names a request may use. */
  hosts: () => string[];
  today: () => Promise<MobileToday>;
  act: (id: string, action: MobileAction) => Promise<{ ok: boolean; say: string }>;
  /** Null when no draft can be asked for. */
  draft: ((id: string) => Promise<{ ok: boolean; say: string }>) | null;
  log?: (text: string) => void;
}

const HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; "
    + "form-action 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};

const FILES: Record<string, string> = {
  "m.js": "text/javascript",
  "m-model.js": "text/javascript",
  "m.css": "text/css",
};

const MANIFEST = JSON.stringify({
  name: "Pako",
  short_name: "Pako",
  description: "Your brief and what you promised, on your phone.",
  start_url: "/m",
  scope: "/m",
  display: "standalone",
  background_color: "#14110f",
  theme_color: "#14110f",
  icons: [
    { src: "/m/assets/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/m/assets/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/m/assets/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
});
const ICONS: Record<string, number> = { "icon-192.png": 192, "icon-512.png": 512, "apple-touch-icon.png": 180 };

const tokenOf = (req: Request): string => {
  const raw = String(req.headers.cookie ?? "")
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${PHONE_COOKIE}=`));
  return raw ? raw.slice(PHONE_COOKIE.length + 1) : "";
};

export function createMobileApp(d: MobileDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  const pages = new URL("./panel/", import.meta.url);
  const cache = new Map<string, Buffer>();
  const file = (name: string): Buffer => {
    if (!cache.has(name)) cache.set(name, name.endsWith(".png") ? iconPng(ICONS[name]!) : readFileSync(new URL(name, pages)));
    return cache.get(name)!;
  };

  // Before anything: this server's own name, and nothing another site's page sends.
  app.use((req, res, next) => {
    res.set(HEADERS);
    const host = hostOf(req.headers.host);
    if (!host || !d.hosts().includes(host.name)) return void res.status(421).type("text").send("Wrong address.");
    const changes = req.method !== "GET" && req.method !== "HEAD";
    const site = req.get("sec-fetch-site");
    const navigating = !changes && req.get("sec-fetch-mode") === "navigate" && !req.path.startsWith("/m/api/");
    if ((site === "cross-site" || site === "same-site") && !navigating) return void res.status(403).type("text").send("Not from another site.");
    const origin = req.get("origin");
    if (origin !== undefined && origin !== `http://${req.headers.host}`) return void res.status(403).type("text").send("Not from another site.");
    if (changes && (origin === undefined || req.get("x-pako") !== "1")) return void res.status(403).json({ error: "send it from the page" });
    next();
  });

  const page: RequestHandler = (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.type("html").send(file("m.html"));
  };
  app.get(["/m", "/m/", "/m/pair"], page);
  app.get("/", (_req, res) => res.redirect(302, "/m"));

  app.get("/m/assets/:name", (req, res) => {
    const name = String(req.params.name ?? "");
    if (name === "manifest.webmanifest") {
      res.set("Cache-Control", "no-cache");
      return void res.type("application/manifest+json").send(MANIFEST);
    }
    if (Object.hasOwn(ICONS, name)) {
      res.set("Cache-Control", "public, max-age=604800");
      return void res.type("image/png").send(file(name));
    }
    if (!Object.hasOwn(FILES, name)) return void res.status(404).type("text").send("Not found");
    res.set("Cache-Control", "no-cache");
    res.type(FILES[name]!).send(file(name));
  });

  const setCookie = (res: Response, token: string): void => {
    res.cookie(PHONE_COOKIE, token, { httpOnly: true, sameSite: "strict", path: "/m", maxAge: COOKIE_MS, secure: false });
  };
  /** The paired phone, or a 401 (its cookie cleared). */
  const device: RequestHandler = async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const found: MobileDevice | null = await d.access.check(tokenOf(req)).catch(() => null);
    if (!found) {
      res.clearCookie(PHONE_COOKIE, { path: "/m" });
      return void res.status(401).json({ error: "pair this phone" });
    }
    res.locals.phone = found;
    next();
  };
  const json = express.json({ limit: "2kb" });
  // A wrong code is answered slowly and counted: ten tries a quarter of an hour from one address, and the code itself burns after five.
  const pairLimit = rateLimit({
    windowMs: 15 * 60_000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false,
    handler: (_req, res) => void res.status(429).json({ error: "too many tries: wait a while, then make a new code on your computer" }),
  });
  const useLimit = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false });

  app.post("/m/api/pair", pairLimit, json, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const b = (req.body ?? {}) as { code?: unknown; name?: unknown };
    if (typeof b.code !== "string" || b.code.length > 40) return void res.status(400).json({ error: "send { code, name }" });
    const got = await d.access.redeem(b.code, typeof b.name === "string" ? b.name : "");
    if (!got) return void res.status(401).json({ error: "that code is wrong, used or older than 10 minutes: make a new one on your computer" });
    setCookie(res, got.token);
    d.log?.(`Phone paired: ${got.device.name}`);
    res.json({ ok: true, name: got.device.name });
  });

  app.get("/m/api/today", useLimit, device, async (req, res) => {
    // Set again on each visit: a phone in use keeps its pairing.
    setCookie(res, tokenOf(req));
    try {
      res.json({ ...(await d.today()), device: (res.locals.phone as MobileDevice).name });
    } catch (err) {
      log.error(`today: ${(err as Error).message}`);
      res.status(503).json({ error: "could not read" });
    }
  });

  app.post("/m/api/loop", useLimit, device, json, async (req, res) => {
    const b = (req.body ?? {}) as { id?: unknown; action?: unknown };
    if (typeof b.id !== "string" || !/^[0-9a-f]{10}$/.test(b.id) || !MOBILE_ACTIONS.includes(b.action as MobileAction)) {
      return void res.status(400).json({ error: "send { id, action }" });
    }
    try {
      res.json(await d.act(b.id, b.action as MobileAction));
    } catch (err) {
      log.error(`a press: ${(err as Error).message}`);
      res.status(503).json({ error: "could not do it" });
    }
  });

  app.post("/m/api/draft", useLimit, device, json, async (req, res) => {
    const id = (req.body as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string" || !/^[0-9a-f]{10}$/.test(id)) return void res.status(400).json({ error: "send { id }" });
    if (!d.draft) return void res.status(404).json({ error: "drafts are off" });
    try {
      res.json(await d.draft(id));
    } catch (err) {
      log.error(`a draft: ${(err as Error).message}`);
      res.status(503).json({ error: "could not ask for it" });
    }
  });

  app.post("/m/api/forget", useLimit, device, async (_req, res) => {
    const me = res.locals.phone as MobileDevice;
    await d.access.revoke(me.id);
    d.log?.(`Phone removed itself: ${me.name}`);
    res.clearCookie(PHONE_COOKIE, { path: "/m" });
    res.json({ ok: true });
  });

  app.use((_req, res) => void res.status(404).type("text").send("Not found"));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number }).status;
    if (res.headersSent) return;
    res.status(typeof status === "number" && status >= 400 && status < 500 ? status : 500).type("text").send("Bad request.");
  });
  return app;
}
