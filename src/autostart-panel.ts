// The panel's "start with this computer" switch, on a person's computer (local mode only): src/autostart.ts does the work (and on
// Windows, src/autostart-windows.ts through autostartFor).
//
//   GET  /panel/api/autostart        -> { supported, enabled, current, kind }
//   POST /panel/api/autostart  { on } -> { ok: true, enabled, message } | { ok: false, error }
//
// Turning it on here takes effect at the next login and turning it off leaves the running Pako alone: the Pako answering may be the very one
// launchd or systemd runs, and stopping it would end the answer half way. The command line (--autostart on|off) also starts and stops it.
//
// The same protection as the STOP switch: the panel's signed-in session, and on a POST the x-pako header that another site cannot send. A
// server's panel has none of this (every route answers 404): a server is started by its host, never by a login.

import express, { type Express, type Request, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { autostartFor, autostartLog, type AnyAutostart } from "./autostart.ts";
import type { Control } from "./control.ts";
import type { Lang } from "./i18n.ts";

export interface AutostartPanelDeps {
  /** The panel's session check (src/dashboard.ts). */
  signedIn: (req: Request) => boolean;
  /** The language of the answers' sentences (always English: src/i18n.ts). */
  lang: () => Lang;
  /** The environment the server runs with now (PAKO_HOME, PORT and PATH go into the service as they are). */
  env: Record<string, string | undefined>;
  control?: Control;
  /** For the tests: the switch itself; the real one for this computer without it. */
  autostart?: AnyAutostart;
}

const PATH = "/panel/api/autostart";
const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

/** The panel's autostart route. `d` null: not a person's computer, and it answers 404. */
export function mountAutostartPanel(app: Express, d: AutostartPanelDeps | null): void {
  if (!d) {
    app.all(PATH, (_req, res) => {
      res.status(404).set(HEADERS).json({ error: "local mode only" });
    });
    return;
  }
  const auto = d.autostart ?? autostartFor({ env: d.env, lang: d.lang });
  // Not signed in is answered before anything is counted: only the owner's own requests use up the allowance.
  const auth = (post: boolean): RequestHandler => (req, res, next) => {
    res.set(HEADERS);
    if (!d.signedIn(req) || (post && req.get("x-pako") !== "1")) {
      res.status(401).json({ error: "sign in" });
      return;
    }
    next();
  };
  const limit = (n: number) =>
    rateLimit({ windowMs: 60_000, limit: n, standardHeaders: "draft-8", legacyHeaders: false, handler: (_req, res) => void res.status(429).json({ error: "too many" }) });

  app.get(PATH, auth(false), limit(60), async (_req, res) => {
    const s = await auto.status();
    res.json({ supported: s.supported, enabled: s.enabled, current: s.current, kind: s.kind });
  });

  // A change runs systemctl (or writes a file) while the request waits: few of them.
  app.post(PATH, auth(true), limit(10), express.json({ limit: "1kb" }), async (req, res) => {
    const on = (req.body as { on?: unknown } | undefined)?.on;
    if (typeof on !== "boolean") {
      res.status(400).json({ ok: false, error: "on: true or false" });
      return;
    }
    const r = on ? await auto.enable() : await auto.disable();
    if (r.ok) d.control?.log("autostart", autostartLog(d.lang(), on));
    res.json(r);
  });
}
