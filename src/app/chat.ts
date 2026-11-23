// Wires what the door's chats need before the door exists: the panel's window as a chat, Telegram's channel, the public address
// for sign-in links, autonomy's settings, and Claude in one button (on a computer).

import { randomBytes } from "node:crypto";
import type { Request } from "express";
import { createAutonomySettings, loadAutonomyConfig, parseContactEmails } from "../autonomy.ts";
import { claudeNotice, createClaudeConnect, createClaudeKeeper } from "../claude-connect.ts";
import { emailOf } from "../connect-routes.ts";
import { createLog } from "../log.ts";
import { createTelegram, loadTelegramConfig, type TelegramChannel, type TelegramConfig } from "../telegram.ts";
import type { OwnerChannel } from "../whatsapp.ts";
import type { AfterBooking } from "./context.ts";
import { TG } from "./texts.ts";

const logAutonomy = createLog("autonomy");
const logChat = createLog("chat");
const logTelegram = createLog("telegram");

export function wireChat(ctx: AfterBooking) {
  const { config, env, local, uiLang, dog, kv } = ctx;
  // Local mode: what the owner types or presses in the panel's window arrives as a message from them, like one from WhatsApp.
  const doorRef: {
    ingest: ((m: Record<string, unknown>, channel?: OwnerChannel) => Promise<string>) | null;
    from: string;
    tell: ((text: string) => Promise<void>) | null;
  } = { ingest: null, from: "", tell: null };
  const fromWindow = (m: Record<string, unknown>): void => {
    const id = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    void doorRef.ingest?.({ from: doorRef.from, id, ...m }).catch((err: Error) => logChat.error(`${err.message}`));
  };
  // Telegram, a second chat beside this one (src/telegram.ts): off until there is a bot token. TELEGRAM_BOT_TOKEN wins; on a computer the
  // token can also be set in the panel (src/telegram-panel.ts), which keeps it in ~/.pako/secrets.json for the next start. Its messages
  // reach the door built below. The channel can appear while Pako runs (set in the panel): what needs it reads tgRef.channel at that moment.
  const envToken = (env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const savedToken = local && !envToken ? (local.settings?.telegramToken?.() ?? "") : "";
  const tg = loadTelegramConfig(savedToken ? { ...env, TELEGRAM_BOT_TOKEN: savedToken } : env);
  if (tg.problems.length) {
    logTelegram.error(`off, because: ${tg.problems.join("; ")}${savedToken ? " (the bot token was set in the panel: set it there again)" : ""}`);
  }
  const makeTelegram = (cfg: TelegramConfig): TelegramChannel =>
    createTelegram({
      config: cfg,
      kv,
      lang: uiLang,
      ingest: (m) => (doorRef.ingest ? doorRef.ingest({ from: doorRef.from, ...m }, "telegram") : Promise.reject(new Error("the door is not ready yet"))),
      onPaired: (who) => void doorRef.tell?.(TG(uiLang())("paired", { who })),
      health: dog.reporter("telegram"),
    });
  const tgRef: { channel: TelegramChannel | null } = { channel: tg.config ? makeTelegram(tg.config) : null };
  void tgRef.channel?.paired().catch(() => false); // read the paired account now, for the panel
  // The panel's sign-in link needs the server's public https address: PUBLIC_URL, else Render's own variables, else the host that Meta's
  // webhook reached. That last one is learnt only from a request Meta signed (src/whatsapp.ts, onSigned), never before the signature is
  // checked: anyone can send an unsigned request with any Host header, and every later link would then hand the owner's one-time sign-in to
  // that host. A localhost or http value is never used on a server.
  const usable = (u: string | undefined) => {
    const v = (u ?? "").trim().replace(/\/$/, "");
    return /^https:\/\/[^/\s]+$/.test(v) && !/\/\/(localhost|127\.0\.0\.1)\b/.test(v) ? v : "";
  };
  const fromEnv = usable(env.PUBLIC_URL) || usable(env.RENDER_EXTERNAL_URL) || usable(env.RENDER_EXTERNAL_HOSTNAME ? `https://${env.RENDER_EXTERNAL_HOSTNAME}` : "");
  let learnt = "";
  // Once, from the first such request (signed, and stamped by Meta minutes ago at most) that came over https: its Host header (never
  // X-Forwarded-Host), when it is a plain host name.
  const learn = (req: Request): void => {
    const host = (req.get("host") ?? "").toLowerCase();
    if (!learnt && req.secure && /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/.test(host)) learnt = usable(`https://${host}`);
  };
  // Local mode is opened on this computer, at its loopback address. A server on the internet with no known address has none: it gives no
  // link at all (a localhost link on the owner's phone leads nowhere). The address it listens on by default, 127.0.0.1, and not the name
  // "localhost": browsers try ::1 for that name first, where another program (another account on this Mac) could listen on the same port
  // and receive the sign-in link and the cookie. Told to listen elsewhere (PAKO_HOST), the name it was given.
  const loopback = (env.PAKO_HOST ?? "").trim() === "" || (env.PAKO_HOST ?? "").trim() === "127.0.0.1" ? "127.0.0.1" : "localhost";
  const publicUrl = (): string => fromEnv || learnt || (local ? `http://${loopback}:${config.port}` : "");
  // Autonomy (src/autonomy.ts): what the owner asks in their own words goes after a window to undo; the panel can set each type to ask.
  const autonomyProblems: string[] = [];
  const autonomyConfig = loadAutonomyConfig(env, autonomyProblems);
  const contactEmails = parseContactEmails(env.PERSONAL_CONTACT_EMAILS, autonomyProblems);
  if (autonomyProblems.length) logAutonomy.error(`${autonomyProblems.join("; ")} (the default is used)`);
  const autonomySettings = createAutonomySettings(kv, autonomyConfig);
  // Claude in one button (src/claude-connect.ts), on a computer only: the panel's connect flow, and the keeper that asks the owner, once,
  // to sign in again when the sign-in is about to expire, has expired, or a run was refused for it. The notice goes through the door
  // (the panel's chat, and Telegram when paired), which is made just below.
  const claudeDoor: { card: ((body: string, buttons: { id: string; title: string }[]) => Promise<boolean>) | null; tell: ((text: string) => Promise<unknown>) | null } = { card: null, tell: null };
  const claudeConnect = local
    ? createClaudeConnect({
        env,
        email: () => emailOf(env.IMAP_USER),
        changed: (_a, why) => {
          void local.bridge.refresh?.();
          if (why === "signed-out") void claudeKeeper?.signedOut();
          else if (why === "connected") void claudeKeeper?.connected();
        },
      })
    : null;
  const claudeKeeper = claudeConnect
    ? createClaudeKeeper({
        check: () => claudeConnect.check(0),
        notify: async () => {
          const t = claudeNotice(uiLang());
          const id = `cl:${randomBytes(5).toString("hex")}`;
          if (claudeDoor.card && (await claudeDoor.card(t("again"), [{ id, title: t("button") }]))) return true;
          if (!claudeDoor.tell) return false;
          await claudeDoor.tell(t("again"));
          return true;
        },
        ...(kv ? { kv } : {}),
      })
    : null;
  return {
    doorRef, fromWindow, makeTelegram, tgRef, usable, fromEnv, learn, publicUrl, autonomyConfig, contactEmails, autonomySettings, claudeDoor,
    claudeConnect, claudeKeeper,
  };
}
