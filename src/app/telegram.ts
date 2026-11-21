// Wires Telegram's lifecycle (webhook or long polling, started by server.ts) and its panel card, and the WhatsApp of this computer's
// panel routes.

import type { Express } from "express";
import { createLog } from "../log.ts";
import { mountTelegramPanel } from "../telegram-panel.ts";
import type { AfterPanel } from "./context.ts";

const logTelegram = createLog("telegram");

/**
 * The panel's WhatsApp setup routes when this computer's WhatsApp (LABS: whatsapp, src/whatsapp-computer.ts) is not there: a server, or the
 * lab off. Here in core, so the lab's code is not loaded for it.
 */
function mountWhatsappSetupAbsent(app: Express): void {
  app.all("/panel/api/whatsapp/setup", (_req, res) => {
    res.status(404).set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    }).json({ error: "local mode only" });
  });
}

export function wireTelegram(ctx: AfterPanel) {
  const { app, env, local, uiLang, waComputer, control, makeTelegram, tgRef, fromEnv, door, panel } = ctx;
  const telegram = tgRef.channel;
  /** Telegram's news, started once the server listens and stopped on shutdown (src/app/services.ts); none on a server without a bot. */
  let handle: { start(): void; stop(): void } | undefined;
  if (telegram && !local) {
    // On a server with a public address Telegram brings the news (one webhook: Render runs two copies for a moment during a deploy, and
    // two copies polling the same bot would clash); on a server with none, Pako asks for them.
    const webhook = fromEnv ? `${fromEnv}/telegram/webhook` : "";
    if (webhook) telegram.mountWebhook(app, "/telegram/webhook");
    let poller: { stop(): void } | null = null;
    let stopped = false;
    const setHook = async (n: number): Promise<void> => {
      if (stopped) return;
      if (await telegram.setWebhook(webhook)) logTelegram.info("webhook set");
      else if (n < 5) setTimeout(() => void setHook(n + 1), 30_000 * n).unref?.();
    };
    handle = {
      start: (): void => {
        if (webhook) void setHook(1);
        else poller = telegram.poll();
      },
      stop: (): void => {
        stopped = true;
        poller?.stop();
      },
    };
    logTelegram.info(`ON: ${webhook ? "news by webhook" : "long polling"}; ${telegram.pairedNow() ? "paired" : "write TELEGRAM in the chat to pair your account"}`);
  }
  if (local) {
    // On a computer Pako asks Telegram for its news (long polling): for a bot whose token was there at the start, once the server listens
    // (server.ts calls start); for one set in the panel, at once (a request to the panel means it listens). One poller at a time.
    let poller: { stop(): void } | null = null;
    let stopped = false;
    const pollNow = (): void => {
      poller?.stop();
      poller = !stopped && tgRef.channel ? tgRef.channel.poll() : null;
    };
    handle = {
      start: (): void => {
        if (!poller) pollNow();
      },
      stop: (): void => {
        stopped = true;
        poller?.stop();
        poller = null;
      },
    };
    const keep = local.settings?.setTelegramToken;
    mountTelegramPanel(app, {
      signedIn: panel.signedIn,
      env,
      lang: uiLang,
      control,
      current: () => tgRef.channel,
      create: makeTelegram,
      ...(keep ? { keep } : {}),
      use: (channel) => {
        tgRef.channel = channel;
        void channel.paired(); // read the paired account now, for the panel (a pairing made with this bot before is still good)
        pollNow();
        logTelegram.info("ON: long polling, with the bot token set in the panel");
      },
    });
    if (telegram) logTelegram.info(`ON: long polling; ${telegram.pairedNow() ? "paired" : "pair your phone in the panel, or write TELEGRAM in the chat"}`);
  } else {
    mountTelegramPanel(app, null);
  }
  if (waComputer) {
    waComputer.mountPanel(app, panel.signedIn);
    waComputer.attach((m, channel) => door.ingest(m, channel), () => door.ownerFrom);
  } else {
    mountWhatsappSetupAbsent(app);
  }
  return { telegram: handle };
}
