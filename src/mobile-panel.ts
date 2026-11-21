// Settings › General › "Use on my phone (same Wi-Fi)", on a person's computer (src/panel/mobile.js). The switch, the pairing code and the
// phones paired; the phone's own page and server are src/mobile.ts and src/mobile-access.ts.
//
//   GET  /panel/api/phone                     → { on, url, addresses, port, problem, pairing, devices, telegram }
//   POST /panel/api/phone          { on }     → the same, after turning it on (it listens on the home network) or off (it stops)
//   POST /panel/api/phone/pair                → { link, code, qr, expiresAt }: a code that works once, for 10 minutes
//   POST /panel/api/phone/revoke   { id } | { all: true }
//
// The panel's own protection: its signed-in session, and on a POST the x-pako header another site cannot send.

import express, { type Express, type Request } from "express";
import { rateLimit } from "express-rate-limit";
import { renderSVG } from "uqr";
import type { Control } from "./control.ts";
import { showCode, type MobileAccess, type MobileListener } from "./mobile-access.ts";
import { panelGuard } from "./panel-guard.ts";


export interface MobilePanelDeps {
  signedIn: (req: Request) => boolean;
  access: MobileAccess;
  listener: MobileListener;
  port: () => number;
  /** Whether Telegram is set up: away from home the owner uses it. */
  telegram: () => boolean;
  control?: Control;
}

/** The phone's address, on the first address it listens on; null while it listens nowhere. */
export const phoneUrl = (listener: Pick<MobileListener, "listening">, port: number): string | null => {
  const a = listener.listening()[0];
  return a ? `http://${a}:${port}/m` : null;
};

export function mountMobilePanel(app: Express, d: MobilePanelDeps): void {
  const auth = panelGuard(d.signedIn);
  const limit = (n: number) =>
    rateLimit({ windowMs: 60_000, limit: n, standardHeaders: "draft-8", legacyHeaders: false, handler: (_req, res) => void res.status(429).json({ error: "too many" }) });
  const json = express.json({ limit: "1kb" });

  const status = async () => {
    const on = await d.access.enabled();
    return {
      on,
      url: on ? phoneUrl(d.listener, d.port()) : null,
      addresses: on ? d.listener.listening() : [],
      port: d.port(),
      problem: on ? d.listener.problem() : null,
      pairing: on ? d.access.pairing() : null,
      devices: await d.access.devices(),
      telegram: d.telegram(),
    };
  };

  app.get("/panel/api/phone", auth(false), limit(120), async (_req, res) => {
    res.json(await status());
  });
  app.post("/panel/api/phone", auth(true), limit(20), json, async (req, res) => {
    const on = (req.body as { on?: unknown } | undefined)?.on;
    if (typeof on !== "boolean") return void res.status(400).json({ error: "on: true or false" });
    await d.access.setEnabled(on);
    if (on) await d.listener.start();
    else await d.listener.stop();
    d.control?.log("phone", on ? "Phone access on (same Wi-Fi)" : "Phone access off");
    res.json(await status());
  });
  app.post("/panel/api/phone/pair", auth(true), limit(20), async (_req, res) => {
    const url = (await d.access.enabled()) ? phoneUrl(d.listener, d.port()) : null;
    if (!url) return void res.status(409).json({ error: "turn it on first (and be on Wi-Fi)" });
    const { code, expiresAt } = d.access.pair();
    // The code rides after the #: a phone's browser never sends that part to any server, nor keeps it in a referrer.
    const link = `${url.replace(/\/m$/, "/m/pair")}#${code}`;
    res.json({ link, code: showCode(code), qr: renderSVG(link, { border: 2 }), expiresAt });
  });
  app.post("/panel/api/phone/revoke", auth(true), limit(30), json, async (req, res) => {
    const b = (req.body ?? {}) as { id?: unknown; all?: unknown };
    if (b.all === true) {
      const n = await d.access.revokeAll();
      d.control?.log("phone", `All paired phones removed (${n})`);
      return void res.json({ ok: true, removed: n });
    }
    if (typeof b.id !== "string" || !/^[0-9a-f]{10}$/.test(b.id)) return void res.status(400).json({ error: "send { id } or { all: true }" });
    const name = (await d.access.devices()).find((x) => x.id === b.id)?.name;
    const ok = await d.access.revoke(b.id);
    if (ok) d.control?.log("phone", `Phone removed: ${name ?? b.id}`);
    res.json({ ok });
  });
}
