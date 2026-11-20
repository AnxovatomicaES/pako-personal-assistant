// The owner's personal assistant server: one HTTP app with the phone line (src/personal-caller.ts: the Caller connector,
// the LiveKit voice routes, the admin voice tools) and the WhatsApp door (src/whatsapp.ts: Meta's webhook and the Mac
// bridge routes). Nothing else is served. The restaurant connector that used to live here is at the git tag
// `connector-final`.
//
// createApp only composes: each part is wired by a module of src/app/ (one section each, in the order they run), which takes the
// typed context the ones before it made (src/app/context.ts). What starts once the server listens is in src/app/services.ts.

import type { Express, NextFunction, Request, Response } from "express";
import { createStoreGuard } from "./store-guard.ts";
import { createLog } from "./log.ts";
import { wireBase } from "./app/base.ts";
import type { AppConfig, Env, LocalContext } from "./app/config.ts";
import type { AppCtx } from "./app/context.ts";
import { wireCore } from "./app/core.ts";
import { wireGuards } from "./app/guards.ts";
import { wireOwner } from "./app/owner.ts";
import { createServiceRegistry, named, setAppServices } from "./app/services.ts";

export { adminRequest, languageIgnoredNote, loadAppConfig } from "./app/config.ts";
export type { AppConfig, LocalContext } from "./app/config.ts";
export { STAND_IN_NAME } from "./local.ts";

const logApp = createLog("app");

export function createApp(config: AppConfig, env: Env = process.env, local?: LocalContext): Express {
  const given: AppCtx = { config, env, local };
  const base = { ...given, ...wireBase(given) };
  const guarded = { ...base, ...wireGuards(base) };
  const core = { ...guarded, ...wireCore(guarded) };
  const { app, uiLang, dog, store, control, whatsappComputer } = core;
  // Everything that hangs from the owner's settings: the phone line, the door, the panel, the connections and the clocks (src/app/owner.ts).
  const owner = wireOwner(core);

  // A store that came back empty (wiped, or a first start) pauses everything and tells the owner (src/store-guard.ts) through the door's
  // chat, with a line in the assistant's context; without the door there is no one to tell. server.ts starts it once listening: an app
  // that is only built (as in most tests) keeps no watch.
  const storeGuard = createStoreGuard({
    store,
    control,
    notify: owner?.tellOwner ?? null,
    ...(owner?.tellAssistant ? { note: owner.tellAssistant } : {}),
    parts: owner?.parts ?? { mail: false, telegram: false, calendar: false },
    lang: uiLang,
    ...(local ? { local: local.storeStart ?? { firstRun: true, lost: null } } : {}),
  });

  // What server.ts starts once the server listens and stops on shutdown, in this order and in reverse (src/app/services.ts).
  const lifecycle = createServiceRegistry();
  const afterGuard = { after: ["storeGuard"] };
  // A server's writer lease on its Redis store (src/kv-lease.ts): renewed while it runs, released on shutdown so the next server takes over.
  if (core.lease) lifecycle.add(named("writerLease", core.lease));
  // First, before any request is handled: until the store guard has looked at the store, the pause counts as on (src/store-guard.ts).
  lifecycle.add(named("storeGuard", storeGuard), { after: ["writerLease"] });
  if (owner?.telegram) lifecycle.add(named("telegram", owner.telegram), afterGuard);
  lifecycle.add(named("watchdog", dog), afterGuard);
  // Slack's Socket Mode (src/slack-socket.ts, SLACK_APP_TOKEN): its connection is opened once the server listens.
  if (owner?.slackSocket) lifecycle.add(named("slackSocket", owner.slackSocket), afterGuard);
  // The owner's WhatsApp set up in the panel (src/whatsapp-computer.ts): its tunnel comes back with Pako, and goes with it.
  if (whatsappComputer) lifecycle.add(named("whatsappComputer", whatsappComputer), afterGuard);
  const panelLink = owner?.panelLink ?? null;
  setAppServices(app, { lifecycle, panelLink: () => (panelLink ? panelLink() : null) });
  // The same handles on app.locals, where the tests reach them (typed in src/app/services.ts).
  app.locals.watchdog = dog;
  app.locals.storeGuard = storeGuard;
  if (owner?.telegram) app.locals.telegram = owner.telegram;
  if (owner?.slackSocket) app.locals.slackSocket = owner.slackSocket;
  if (whatsappComputer) app.locals.whatsappComputer = whatsappComputer;
  if (panelLink) app.locals.panelLink = panelLink;

  // Last: body-parser and unexpected errors become clean answers. Never a stack trace.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { status?: number };
    const status = typeof e.status === "number" && e.status >= 400 && e.status < 600 ? e.status : 500;
    if (status === 500) logApp.error("Unhandled error:", err);
    if (res.headersSent) return;
    res.status(status).type("text").send(status === 500 ? "Something went wrong." : "Bad request.");
  });
  return app;
}
