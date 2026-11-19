// Telegram from the panel, on a person's computer (local mode): the bot's token is set here (checked with Telegram, kept in ~/.pako/secrets.json,
// and the bot starts at once, with no restart), and the phone is paired by scanning a QR code of the same one-time link TELEGRAM gives in the
// chat. TELEGRAM_BOT_TOKEN, when it is set, wins: the panel can still pair and unpair that bot, not change it. A server's panel has none of
// this (the routes answer 404): there the token is a setting, and the phone is paired by writing TELEGRAM in the chat.
//
// The same protection as the STOP switch: the panel's signed-in session, and on a POST the x-pako header that another site cannot send.
//   GET  /panel/api/telegram         -> { state: "no-token" | "unpaired" | "paired", bot?, account?, why?, fixed? }
//   GET  /panel/api/telegram/guide   -> { botFather, steps[] }: the link that opens @BotFather and the exact /newbot steps
//   POST /panel/api/telegram/token   { token, pair? } -> { ok: true, bot, link?, svg? } | { ok: false, error }: with pair, the pairing link at once
//   POST /panel/api/telegram/link    -> { link, svg }: a one-time link (10 minutes; a newer one replaces it) and its QR code
//   POST /panel/api/telegram/off     -> { ok }: the paired account is let go (the token stays); ok is false when the store did not keep that
// `bot` is the bot's username without the @, `account` the paired account's name and @username, `error` a sentence for the person.
// `why` comes with "no-token" when there is a bot but it cannot be used here (its news go to a server, or to another Pako): a sentence for
// the person, and the card asks for another bot. `fixed` is true when TELEGRAM_BOT_TOKEN decides the bot: the panel does not offer to change it.

import express, { type Express, type Request, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { renderSVG } from "uqr";
import type { Control } from "./control.ts";
import { texts, type Lang } from "./i18n.ts";
import { loadTelegramConfig, type TelegramChannel, type TelegramConfig } from "./telegram.ts";
import { createLog } from "./log.ts";

const log = createLog("telegram");

const T = texts(
  {
    envWins: "This Pako uses the bot in TELEGRAM_BOT_TOKEN, in its settings: to change it, change it there.",
    shape: "That doesn't look like a bot token. Copy the whole one @BotFather gave you: digits, a colon, then letters.",
    refused: "Telegram doesn't accept that token. Copy it again from @BotFather, or ask it for a new one with /token.",
    noAnswer: "I couldn't reach Telegram. Check the internet connection and try again.",
    other: "Telegram gave an unexpected answer. Try again in a moment.",
    badApi: "TELEGRAM_API_URL isn't valid: it must be an https address, or http://localhost:<port>.",
    badOwner: "TELEGRAM_OWNER_ID isn't valid: it must be your numeric Telegram user id (digits only), or empty.",
    notKept: "I couldn't save the token on this computer (~/.pako/secrets.json). Check there's free space and permission, then try again.",
    noToken: "Set your bot's token first.",
    elsewhere: "That bot is already used by a server or by another Pako, and its messages go there, not to this computer. Make a new one "
      + "for this computer: send /newbot to @BotFather and paste its token here.",
    noLink: "I couldn't make the link: Telegram isn't answering. Try again in a moment.",
    logToken: "Telegram bot set from the panel: @{bot}",
    logLink: "QR code to connect Telegram shown in the panel",
    logOff: "Telegram disconnected from the panel",
    guide: "Press “Open @BotFather”: Telegram opens|Press “Start” and type /newbot|Type the bot's name, for example “Ana's Pako”|"
      + "Type its username: it must end in “bot”, for example pako_ana_bot|@BotFather gives you a token (digits, a colon, then letters): "
      + "copy it and paste it here|Tap the link I give you next: Telegram opens your chat with Pako, press “Start” and you're done",
  },
);

export interface TelegramPanelDeps {
  /** The panel's session check (src/dashboard.ts). */
  signedIn: (req: Request) => boolean;
  /** The server's settings: TELEGRAM_BOT_TOKEN there wins over the panel; TELEGRAM_API_URL and TELEGRAM_OWNER_ID apply to a token set here. */
  env: Record<string, string | undefined>;
  /** The language of the answers' sentences (always English: src/i18n.ts). */
  lang: () => Lang;
  control?: Control;
  /** The channel in use now (from the settings, or set here); null while there is no token. */
  current: () => TelegramChannel | null;
  /** A channel for a token, not started: it asks Telegram nothing until it is used. */
  create: (config: TelegramConfig) => TelegramChannel;
  /** Keeps a checked token for the next start; false when it could not. Absent: it lasts until Pako stops. */
  keep?: (token: string) => boolean;
  /** Makes a channel the one in use and starts it; the one before stops. */
  use: (channel: TelegramChannel) => void;
}

const PATHS = ["/panel/api/telegram", "/panel/api/telegram/guide", "/panel/api/telegram/token", "/panel/api/telegram/link", "/panel/api/telegram/off"];
const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

/** The QR code of a link, as an SVG: black on white with a margin of its own, so a phone reads it on a dark page too. */
export const qrSvg = (link: string): string => renderSVG(link, { ecc: "M", border: 2 });

/** At most `ms` of waiting for an answer that may hang (Telegram down): null then, and the panel asks again at its next look. */
const within = <V>(p: Promise<V>, ms: number): Promise<V | null> => {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
};

/** The panel's Telegram routes. `d` null: not a person's computer, and every route answers 404. */
export function mountTelegramPanel(app: Express, d: TelegramPanelDeps | null): void {
  if (!d) {
    app.all(PATHS, (_req, res) => {
      res.status(404).set(HEADERS).json({ error: "local mode only" });
    });
    return;
  }
  const t = () => T(d.lang());
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
  // The panel looks every few seconds while a phone is being paired; a change asks Telegram, so those are fewer.
  const reads = limit(120);
  const writes = limit(20);

  app.get("/panel/api/telegram/guide", auth(false), reads, (_req, res) => {
    res.json({ botFather: "https://t.me/BotFather", steps: t()("guide").split("|") });
  });

  app.get("/panel/api/telegram", auth(false), reads, async (_req, res) => {
    const ch = d.current();
    // The bot's name is known once Telegram has answered for this token; a Telegram that hangs does not hold the panel.
    const bot = ch ? await within(ch.username(), 3000) : null;
    const fixed = (d.env.TELEGRAM_BOT_TOKEN ?? "").trim() ? { fixed: true } : {};
    // A token Telegram refuses (revoked, or the bot deleted) is as good as none: the panel asks for a new one. So is a bot whose news go
    // elsewhere (a server's webhook, another Pako): a QR for it would never pair, and "connected" would be a lie. The panel says why.
    if (!ch || ch.tokenRefused() || ch.pollStopped()) {
      res.json({ state: "no-token", ...(ch?.pollStopped() ? { why: t()("elsewhere") } : {}), ...fixed });
      return;
    }
    const paired = await ch.paired().catch(() => false);
    const account = paired ? await ch.account().catch(() => null) : null;
    res.json({ state: paired ? "paired" : "unpaired", ...(bot ? { bot } : {}), ...(account ? { account } : {}), ...fixed });
  });

  // One change of token at a time: two at once would each start a bot, and only one would be stopped.
  let changing: Promise<unknown> = Promise.resolve();
  app.post("/panel/api/telegram/token", auth(true), writes, express.json({ limit: "1kb" }), async (req, res) => {
    const given = (req.body as { token?: unknown } | undefined)?.token;
    const token = typeof given === "string" ? given.trim() : "";
    const pair = (req.body as { pair?: unknown } | undefined)?.pair === true;
    const change = async (): Promise<{ ok: true; bot: string; link?: string; svg?: string } | { ok: false; error: string }> => {
      const say = t();
      if ((d.env.TELEGRAM_BOT_TOKEN ?? "").trim()) return { ok: false, error: say("envWins") };
      // Checked as the settings are (src/telegram.ts): the token's shape, and the other Telegram settings it would run with.
      const { config, problems } = loadTelegramConfig({ ...d.env, TELEGRAM_BOT_TOKEN: token });
      if (!token || !config) {
        const wrong = (name: string) => problems.some((p) => p.startsWith(name));
        return { ok: false, error: say(!token || wrong("TELEGRAM_BOT_TOKEN") ? "shape" : wrong("TELEGRAM_API_URL") ? "badApi" : "badOwner") };
      }
      const candidate = d.create(config);
      const checked = await candidate.check();
      if (!checked.ok) return { ok: false, error: say(checked.why === "refused" ? "refused" : checked.why === "no-answer" ? "noAnswer" : "other") };
      // A bot with a webhook is one a server already uses (the bot of a hosted Pako, pasted here): a poll never hears it, and the phone's
      // /start would go to that server. Refused before it is kept. Only asked, never removed; no clear answer in time: taken, as before.
      if ((await within(candidate.hasWebhook(), 5000)) === true) return { ok: false, error: say("elsewhere") };
      // Kept before it is used: a bot that worked only until the next start would stop answering with no word.
      if (d.keep && !d.keep(token)) return { ok: false, error: say("notKept") };
      d.use(candidate);
      d.control?.log("telegram", say("logToken", { bot: checked.bot }));
      // The one-time pairing link at once (one tap on the phone pairs it); no answer in time: the card asks for it as before.
      const link = pair ? await within(candidate.pairLink(), 5000).catch(() => null) : null;
      return { ok: true, bot: checked.bot, ...(link ? { link, svg: qrSvg(link) } : {}) };
    };
    const job = changing.then(change, change);
    changing = job.catch(() => undefined);
    try {
      res.json(await job);
    } catch (err) {
      log.error(`the panel could not set the bot token: ${(err as Error).name}`);
      res.status(500).json({ ok: false, error: t()("other") });
    }
  });

  app.post("/panel/api/telegram/link", auth(true), writes, async (_req, res) => {
    const say = t();
    const ch = d.current();
    if (!ch || ch.tokenRefused()) {
      res.status(409).json({ error: say("noToken") });
      return;
    }
    // No code for a bot that cannot hear the phone's answer.
    if (ch.pollStopped()) {
      res.status(409).json({ error: say("elsewhere") });
      return;
    }
    // The same one-time link as TELEGRAM in the chat: a newer one (from here or from there) replaces it.
    const link = await ch.pairLink();
    if (!link) {
      res.status(502).json({ error: say("noLink") });
      return;
    }
    d.control?.log("telegram", say("logLink"));
    res.json({ link, svg: qrSvg(link) });
  });

  app.post("/panel/api/telegram/off", auth(true), writes, async (_req, res) => {
    const ch = d.current();
    if (!ch) {
      res.json({ ok: true });
      return;
    }
    // As TELEGRAM OFF: forgotten here at once whatever the store says, a pending link stops working too, and a pinned account does not come
    // back by itself. ok is false when the store did not take it (after a restart that account could talk to Pako again).
    const kept = await ch.unpair();
    d.control?.log("telegram", t()("logOff"));
    res.json({ ok: kept });
  });
}
