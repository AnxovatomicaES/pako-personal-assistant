// Wires what runs before every route: the owner's WhatsApp on a computer (its tunnel gate and webhook), the local guard, the demo's
// guard, the public /health, and the admin key's check with its rate limit.

import { join } from "node:path";
import type { Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { demoGuard } from "../demo.ts";
import { localGuard } from "../guard-http.ts";
import { pakoHome } from "../local.ts";
import { createTunnel, installCloudflared } from "../tunnel.ts";
import type { HealthReport } from "../watchdog.ts";
import { type ComputerWhatsapp, createComputerWhatsapp } from "../whatsapp-computer.ts";
import { ADMIN_HEADERS, adminRequest } from "./config.ts";
import type { AfterBase } from "./context.ts";

export function wireGuards(ctx: AfterBase) {
  const { config, env, local, app, uiLang, labs } = ctx;
  // The owner's WhatsApp on a computer (src/whatsapp-computer.ts), set up in the panel: first of all, what came through its tunnel reaches
  // the webhook paths only. Then, on a computer, before every route: only this computer's own names for Pako, and nothing another website's
  // page sends (src/guard-http.ts). Its webhook comes before the door's (which on a computer has stand-in settings only).
  /** The watchdog's WhatsApp part for the computer's webhook, set once the watchdog is made (below). */
  const waHealth: { report: HealthReport | null } = { report: null };
  // LABS: whatsapp. Off: no setup routes, no webhook, no tunnel.
  const waComputer: ComputerWhatsapp | null = local && labs.on("whatsapp")
    ? createComputerWhatsapp({
        health: (ok, detail) => waHealth.report?.(ok, detail),
        store: {
          read: () => local.settings?.whatsapp?.() ?? null,
          write: (v) => (local.settings?.setWhatsapp ? local.settings.setWhatsapp(v as Record<string, unknown> | null) : false),
        },
        kv: local.kv,
        env,
        lang: uiLang,
        tunnel: (onUrl) => createTunnel({ port: () => config.port, install: () => installCloudflared({ dir: join(pakoHome(env), "bin") }), onUrl }),
        phoneOn: () => !!((env.LIVEKIT_URL ?? "").trim() && (env.LIVEKIT_API_KEY ?? "").trim() && (env.LIVEKIT_API_SECRET ?? "").trim()),
      })
    : null;
  if (waComputer) app.use(waComputer.gate);
  if (local) app.use(localGuard({ host: env.PAKO_HOST, lang: uiLang }));
  // The demo week (src/demo.ts): no account is connected, nothing is imported and nothing of the person's is exported while it runs.
  const demo = local?.demo?.on ? local.demo : null;
  if (demo) app.use(demoGuard());
  /** Started once the server listens (the tunnel again, if it was on), stopped on shutdown (src/app/services.ts). */
  let whatsappComputer: { start(): void; stop(): void } | undefined;
  if (waComputer) {
    waComputer.mountWebhook(app);
    whatsappComputer = { start: waComputer.start, stop: waComputer.stop };
  }

  // Public, so it says only that the server is up.
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  const adminLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, skipSuccessfulRequests: true, standardHeaders: "draft-8", legacyHeaders: false });
  const adminOnly = (req: Request, res: Response): boolean => {
    res.set(ADMIN_HEADERS);
    if (config.adminKey && adminRequest(req, config.adminKey)) return true;
    res.status(401).set("WWW-Authenticate", 'Basic realm="assistant admin", charset="UTF-8"').type("text").send("Admin key required.");
    return false;
  };
  return { waHealth, waComputer, whatsappComputer, demo, adminLimiter, adminOnly };
}
