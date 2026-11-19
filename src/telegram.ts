// Telegram as a second chat beside WhatsApp (or beside the panel's chat in local mode). The owner talks to Pako on either, and Pako answers
// where they wrote; what Pako starts goes where they last wrote, or on a computer to Telegram while it is paired (src/whatsapp.ts decides). Off
// until there is a bot token: TELEGRAM_BOT_TOKEN, or on a computer the one set in the panel (src/telegram-panel.ts). The token of a bot the
// owner made with @BotFather.
//
// Who the owner is: the Telegram account that opened a one-time link the owner asked for in the chat they already have (they write TELEGRAM,
// or scan the panel's QR code), or the account TELEGRAM_OWNER_ID names. Anyone else gets one short line and nothing they write reaches Pako.
// How Telegram's news arrive: a webhook with a secret header on a server with a public address (Render), long polling on a computer at home.
// What this file does: turns Telegram's messages and button presses into the messages the WhatsApp door already handles, and the door's
// messages (text, and cards with two buttons) into Telegram's. STOP, the cards, the reminders and the assistant work the same here.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import express, { type Express } from "express";
import { texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import type { HealthReport } from "./watchdog.ts";
import { replaceFormatting, TELEGRAM_ID_PREFIX, TELEGRAM_MEDIA_ID, type TelegramDoor } from "./whatsapp.ts";
import { createLog } from "./log.ts";

const log = createLog("telegram");

/** What this file says to people on Telegram, in the language of Pako's own texts (src/i18n.ts). */
const T = texts(
  {
    private: "This bot is a private assistant.",
    notKept: "I couldn't save the connection. Ask for a new link: type TELEGRAM in your chat with Pako.",
    paired: "Done: we can talk on Telegram now too. Write to me here whenever you like, as in your other chat.",
    already: "We're already connected: write me anything.",
    badLink: "That link doesn't work or has expired. Ask for a new one: type TELEGRAM in your chat with Pako.",
    replaced: "Pako no longer talks to this account: another Telegram account has been connected.",
    who: "“{name}” ({at}, id {id})",
    whoNameless: "({at}, id {id})",
    noAt: "no @username",
  },
);

export interface TelegramConfig {
  token: string;
  /** Only this Telegram account can be the owner (it needs no link). Null: whoever opens the owner's one-time link. */
  ownerId: number | null;
  /** The Bot API's address: Telegram's own, or a Bot API server of your own (TELEGRAM_API_URL). */
  api: string;
}

/** Off (no problems) when TELEGRAM_BOT_TOKEN is empty; a wrong value is said by name, never shown. */
export function loadTelegramConfig(env: Record<string, string | undefined>): { config: TelegramConfig | null; problems: string[] } {
  const token = (env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const owner = (env.TELEGRAM_OWNER_ID ?? "").trim();
  const api = (env.TELEGRAM_API_URL ?? "").trim().replace(/\/$/, "") || "https://api.telegram.org";
  if (!token) return { config: null, problems: owner ? ["TELEGRAM_OWNER_ID is set but TELEGRAM_BOT_TOKEN is not"] : [] };
  const problems: string[] = [];
  // The token travels in every address: only https, or plain http to this same computer.
  if (!/^https:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(api) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(api)) {
    problems.push("TELEGRAM_API_URL must be an https address, or http://localhost:<port> for a Bot API server on this computer");
  }
  if (!/^\d{5,15}:[A-Za-z0-9_-]{30,60}$/.test(token)) problems.push("TELEGRAM_BOT_TOKEN must be the token @BotFather gave (digits, a colon, then letters, digits, _ or -)");
  if (owner && !/^\d{1,16}$/.test(owner)) problems.push("TELEGRAM_OWNER_ID must be your numeric Telegram user id (digits only), or left empty");
  return problems.length ? { config: null, problems } : { config: { token, ownerId: owner ? Number(owner) : null, api }, problems };
}

export interface TelegramDeps {
  config: TelegramConfig;
  /** Where the owner's account, the pending link and the voice notes' files are kept. Null: in memory (a restart forgets the pairing). */
  kv: Kv | null;
  /** The door (src/whatsapp.ts): a message from the paired account, shaped as WhatsApp would give it. Throws when it could not be taken. */
  ingest: (m: Record<string, unknown>) => Promise<string>;
  /** An account was just paired: the owner hears it on their usual chat too (a link forwarded by mistake would show up there). */
  onPaired?: (who: string) => void;
  /** Accepted for the callers that still pass it: what this file writes is English (src/i18n.ts). */
  lang?: () => Lang;
  fetch?: typeof fetch;
  now?: () => number;
  /** How long one long poll waits for news, in seconds (tests use 0). */
  pollSeconds?: number;
  /** The poller's pause after an error or an instant empty answer, in ms (default 1000; tests use a few). */
  pauseMs?: number;
  /**
   * The watchdog (src/watchdog.ts): how each send and each poll went. A refusal about one chat (the owner blocked the bot) is not Telegram
   * failing; a refused token, Telegram down or unreachable is.
   */
  health?: HealthReport;
}

export interface TelegramChannel extends TelegramDoor {
  /** After OFF: one last line to the account that was paired (the OFF came from it). */
  farewell(text: string): Promise<void>;
  /** One update from Telegram (from the webhook or a poll). Throws when the door could not take it, so it comes again. */
  handle(update: unknown): Promise<void>;
  /** POST `path`: Telegram's webhook, taken only with the secret header. */
  mountWebhook(app: Express, path: string): void;
  /** Tells Telegram to send its news to `url` (the server's public https address and the webhook's path). */
  setWebhook(url: string): Promise<boolean>;
  /** Long polling, for a computer with no public address. It stops by itself when the bot's news go elsewhere, or the token is refused. */
  poll(): { stop(): void };
  /** The bot's @name, for the link; null when Telegram did not answer. */
  username(): Promise<string | null>;
  /** For the panel, without waiting: whether an owner's account is known (as last read). */
  pairedNow(): boolean;
  /**
   * Asks Telegram whose token this is (getMe): the bot's username (without the @), or why not. "refused": Telegram says the token is wrong or
   * was revoked; "no-answer": Telegram could not be reached; "other": anything else.
   */
  check(): Promise<{ ok: true; bot: string } | { ok: false; why: "refused" | "no-answer" | "other" }>;
  /** For the panel: the paired account's name and @username as Telegram gave them when it paired; null when not paired, or not known. */
  account(): Promise<string | null>;
  /** Telegram refused the token (it was revoked, or the bot deleted): nothing works until a new one is set. */
  tokenRefused(): boolean;
  /**
   * Whether this bot's news go to a webhook (getWebhookInfo): a bot some server already uses, which a poll can never hear. Null when
   * Telegram gave no clear answer. It only asks: the webhook is never removed here (that would cut that server off).
   */
  hasWebhook(): Promise<boolean | null>;
  /**
   * Why the last poll() ended by itself, for the panel: this bot's news go to a webhook, or another Pako keeps polling with the same token.
   * Null while it runs, was stopped on purpose, or never started.
   */
  pollStopped(): "webhook" | "conflict" | null;
}

interface TgUser {
  id?: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
}
interface TgMessage {
  message_id?: number;
  from?: TgUser;
  chat?: { id?: number; type?: string };
  text?: string;
  voice?: { file_id?: string; mime_type?: string };
  audio?: { file_id?: string; mime_type?: string };
  /** A photo, in the sizes Telegram made of it (always JPEG); a file sent as a file. `caption`: the words sent with either. */
  photo?: { file_id?: string; file_size?: number; width?: number }[];
  document?: { file_id?: string; file_name?: string; mime_type?: string; file_size?: number };
  caption?: string;
  /** Set on a forwarded message (Bot API 7 and later); the older fields, from a Bot API server that predates it (TELEGRAM_API_URL). */
  forward_origin?: unknown;
  forward_from?: unknown;
  forward_from_chat?: unknown;
  forward_sender_name?: unknown;
  forward_date?: unknown;
}
interface TgUpdate {
  update_id?: number;
  message?: TgMessage;
  callback_query?: { id?: string; from?: TgUser; data?: string; message?: TgMessage };
}
type ApiResult = { ok: boolean; result?: unknown; error_code?: number; description?: string; parameters?: { retry_after?: number } };

const OWNER_KEY = "telegram-owner";
const PAIR_KEY = "telegram-pair";
const FILE_KEY = (id: string): string => `telegram-file:${id}`;
const PAIR_MS = 10 * 60_000;
const UPDATES = ["message", "callback_query"];
/** The ids of the door's cards (src/whatsapp.ts): the only button data a press may carry. */
const CARD_ID = /^[a-z0-9]{1,3}:[0-9a-f]{10}$/;
/** What the door takes as a voice note's size (the same limit as WhatsApp's notes). */
const MEDIA_MAX = 16 * 1024 * 1024;
/** A @username Telegram would give (anything else is not shown). */
const USERNAME = /^[A-Za-z0-9_]{3,40}$/;

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
/** A person's first name as it may be shown: no control characters, nothing that could pass for a tag or a quote mark, 40 characters at most. */
const cleanName = (v: unknown): string => (typeof v === "string" ? v.replace(/[\p{C}<>«»“”]/gu, "").trim().slice(0, 40) : "");
const same = (a: string, b: string): boolean => timingSafeEqual(Buffer.from(sha(a), "hex"), Buffer.from(sha(b), "hex"));
const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The door's text (WhatsApp's *bold*, _italic_, ~struck~, `code`) as Telegram's HTML: everything else escaped, so nothing in it is a tag. A link
 * is left exactly as it is: a one-time link with _x_ in it must still work.
 */
export function telegramHtml(text: string): string {
  const tag = { "*": "b", _: "i", "~": "s", "```": "pre", "`": "code" } as const;
  const format = (part: string): string => {
    let out = part;
    for (let i = 0; i <= part.length; i++) {
      const next = replaceFormatting(out, (mark, inner) => `<${tag[mark]}>${inner}</${tag[mark]}>`);
      if (next === out) break;
      out = next;
    }
    return out;
  };
  return escapeHtml(text)
    .split(/((?:https?:\/\/|t\.me\/)[^\s<>"]+)/)
    .map((part, i) => (i % 2 ? part : format(part)))
    .join("");
}

export function createTelegram(d: TelegramDeps): TelegramChannel {
  const f = d.fetch ?? fetch;
  const now = d.now ?? Date.now;
  const t = (key: Parameters<ReturnType<typeof T>>[0], vars?: Record<string, string | number>): string => T(d.lang?.() ?? "en")(key, vars);
  const base = d.config.api.replace(/\/$/, "");
  // The webhook's secret header comes from the token itself: one setting fewer, and it changes with the token.
  const secret = createHmac("sha256", d.config.token).update("pako-telegram-webhook").digest("hex");
  // The bot's own number, the part of the token before the colon (public: it is the bot's user id). A pairing belongs to one bot: after the
  // token is changed to another bot's, the account paired with the first one is not the owner here (that bot cannot write to it).
  const botId = Number(d.config.token.split(":")[0]);
  // Telegram said the token is not valid (revoked, or the bot deleted): the panel asks for a new one.
  let refused = false;
  let pollEnded: "webhook" | "conflict" | null = null;

  /** One Bot API call. The token is part of the address: neither the address nor the network error's own text is ever logged. */
  const call = async (method: string, params: Record<string, unknown>, o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ApiResult> => {
    const timeout = AbortSignal.timeout(o.timeoutMs ?? 10_000);
    try {
      const res = await f(`${base}/bot${d.config.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout,
      });
      const doc = (await res.json().catch(() => ({}))) as ApiResult;
      return typeof doc.ok === "boolean" ? doc : { ok: false, error_code: res.status, description: `HTTP ${res.status}` };
    } catch (err) {
      const name = (err as Error).name;
      return { ok: false, error_code: -1, description: name === "TimeoutError" ? "no answer" : name === "AbortError" ? "stopped" : "network error" };
    }
  };
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  // ---------- the owner's account ----------

  /** `label`: how the panel names the account (its name and @username at pairing); absent for one paired before it was kept. */
  type Owner = { userId: number; chatId: number; label?: string };
  let owner: Owner | null | undefined; // undefined: not read from the store yet
  // OFF was written: a pinned account (TELEGRAM_OWNER_ID) does not come back by itself; only a fresh link brings an account back.
  let off: boolean | undefined;
  const OFF_KEY = "telegram-off";
  const loadOff = async (): Promise<boolean> => {
    if (off !== undefined) return off;
    try {
      off = d.kv ? (await d.kv.get(OFF_KEY)) === "1" : false;
    } catch {
      return true; // the store did not answer: no account is let in by itself until it does
    }
    return off;
  };
  // Telegram said the owner's chat cannot be reached (they blocked the bot, the chat is gone): not used until they write there again.
  let unreachable = false;
  // Links already used, until they would have expired anyway: one that the store failed to forget still works only once.
  const used = new Map<string, number>();
  const loadOwner = async (): Promise<Owner | null> => {
    if (owner !== undefined) return owner;
    try {
      const v = d.kv ? await d.kv.get(OWNER_KEY) : null;
      const o = v ? (JSON.parse(v) as { userId?: unknown; chatId?: unknown; label?: unknown; bot?: unknown }) : null;
      // A record kept before pairings named their bot has no `bot`: it stays good.
      const ours = o?.bot === undefined || o.bot === botId;
      owner = o && ours && Number.isSafeInteger(o.userId) && Number.isSafeInteger(o.chatId)
        ? { userId: o.userId as number, chatId: o.chatId as number, ...(typeof o.label === "string" && o.label ? { label: o.label.slice(0, 90) } : {}) }
        : null;
    } catch {
      return null; // the store did not answer: asked again next time
    }
    // A pinned owner (TELEGRAM_OWNER_ID) that changed: the account kept from before is not the owner any more.
    if (owner && d.config.ownerId !== null && owner.userId !== d.config.ownerId) owner = null;
    return owner;
  };
  /** Kept first, then used: an account the store did not take is not the owner (it would come and go with restarts). */
  const saveOwner = async (o: Owner): Promise<void> => {
    await d.kv?.set(OWNER_KEY, JSON.stringify({ ...o, bot: botId }), 5 * 365 * 24 * 3600);
    owner = o;
    unreachable = false;
  };
  const isOwner = async (userId: unknown): Promise<boolean> => {
    const o = await loadOwner();
    return !!o && typeof userId === "number" && o.userId === userId;
  };

  // ---------- the one-time link ----------

  let pending: { hash: string; until: number } | null = null;
  let formerChat: number | null = null;
  let me: string | null = null;
  type Checked = { ok: true; bot: string } | { ok: false; why: "refused" | "no-answer" | "other" };
  // One question at a time: the panel looks every few seconds, and a Telegram that hangs must not collect a pile of them.
  let asking: Promise<Checked> | null = null;
  const check = (): Promise<Checked> =>
    (asking ??= (async (): Promise<Checked> => {
      try {
        const r = await call("getMe", {});
        const name = (r.result as { username?: unknown } | undefined)?.username;
        if (r.ok && typeof name === "string" && /^[A-Za-z0-9_]{5,64}$/.test(name)) {
          me = name;
          refused = false;
          return { ok: true, bot: name };
        }
        if (r.error_code === 401 || r.error_code === 404) {
          refused = true;
          return { ok: false, why: "refused" };
        }
        return { ok: false, why: r.error_code === -1 ? "no-answer" : "other" };
      } finally {
        asking = null;
      }
    })());
  const username = async (): Promise<string | null> => {
    if (me) return me;
    const r = await check();
    return r.ok ? r.bot : null;
  };
  const pairLink = async (): Promise<string | null> => {
    const name = await username();
    if (!name) return null;
    // 24 characters of [A-Za-z0-9_-]: what a t.me/<bot>?start= link may carry. Only its hash is kept, for 10 minutes, and a newer link replaces it.
    const code = randomBytes(18).toString("base64url");
    pending = { hash: sha(code), until: now() + PAIR_MS };
    await d.kv?.set(PAIR_KEY, JSON.stringify(pending), PAIR_MS / 1000).catch(() => undefined);
    return `https://t.me/${name}?start=${code}`;
  };
  /** True once, for the code of the link still pending. */
  const takeCode = async (code: string): Promise<boolean> => {
    if (!/^[A-Za-z0-9_-]{24}$/.test(code)) return false;
    let p = pending;
    if (!p && d.kv) {
      try {
        const v = await d.kv.get(PAIR_KEY);
        p = v ? (JSON.parse(v) as { hash: string; until: number }) : null;
      } catch {
        p = null;
      }
    }
    if (!p || typeof p.hash !== "string" || !/^[0-9a-f]{64}$/.test(p.hash) || now() > p.until) return false;
    if (!timingSafeEqual(Buffer.from(sha(code), "hex"), Buffer.from(p.hash, "hex"))) return false;
    for (const [h, until] of used) if (until < now()) used.delete(h);
    if (used.has(p.hash)) return false;
    used.set(p.hash, p.until);
    pending = null;
    await d.kv?.set(PAIR_KEY, "", 1).catch(() => undefined);
    return true;
  };
  /** Who an account is, for the owner's notice: its name, its @username if it has one, and always its number (a name can be anyone's). */
  const describe = (u: TgUser | undefined, userId: number): string => {
    const name = cleanName(u?.first_name);
    const at = typeof u?.username === "string" && USERNAME.test(u.username) ? `@${u.username}` : t("noAt");
    return name ? t("who", { name, at, id: userId }) : t("whoNameless", { at, id: userId });
  };
  /** How the panel names the account: "Marta (@marta)", or whichever of the two it has. */
  const labelOf = (u: TgUser | undefined): string => {
    const name = cleanName(u?.first_name);
    const at = typeof u?.username === "string" && USERNAME.test(u.username) ? `@${u.username}` : "";
    return name && at ? `${name} (${at})` : name || at;
  };
  /** An account becomes the owner: the one it replaces is told first, then the owner hears it on their usual chat. */
  const takeOver = async (u: TgUser | undefined, userId: number, chatId: number): Promise<boolean> => {
    const before = await loadOwner();
    const label = labelOf(u);
    try {
      await saveOwner({ userId, chatId, ...(label ? { label } : {}) });
    } catch {
      return false;
    }
    if (before && before.userId !== userId) await sendTo(before.chatId, t("replaced"));
    if (off) {
      off = false;
      await d.kv?.set(OFF_KEY, "", 1).catch(() => undefined);
    }
    d.onPaired?.(describe(u, userId));
    return true;
  };

  // ---------- sending (to the owner's chat only, and a short line to anyone else) ----------

  const rows = <X>(list: X[], n: number): X[][] => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
  const sendTo = async (chatId: number, text: string, keyboard?: { text: string; callback_data: string }[]): Promise<boolean> => {
    const params: Record<string, unknown> = {
      chat_id: chatId,
      text: telegramHtml(text),
      parse_mode: "HTML",
      // No preview: Telegram's own visit to a link would use up a one-time link (the panel's).
      link_preview_options: { is_disabled: true },
      // Three to a row: a card's own answers on the first, its quiet 👍/👎 (src/quality.ts) on the next.
      ...(keyboard?.length ? { reply_markup: { inline_keyboard: rows(keyboard, 3) } } : {}),
    };
    let r = await call("sendMessage", params);
    if (!r.ok && r.error_code === 429) {
      await sleep(Math.min(10, Math.max(1, r.parameters?.retry_after ?? 1)) * 1000);
      r = await call("sendMessage", params);
    }
    // Something Telegram could not read as HTML: the same words as plain text.
    if (!r.ok && r.error_code === 400 && /parse entities/i.test(r.description ?? "")) r = await call("sendMessage", { ...params, text, parse_mode: undefined });
    if (r.ok) {
      d.health?.(true);
      return true;
    }
    if (r.error_code === -1 || r.error_code === 401 || r.error_code === 404 || r.error_code === 429 || (r.error_code ?? 0) >= 500) {
      d.health?.(false, r.error_code === 401 || r.error_code === 404 ? "the bot token was refused" : r.description ?? `error ${r.error_code}`);
    }
    // No answer at all: it may have arrived, so it is not sent again another way (a reminder would come twice).
    if (r.error_code === -1 && r.description === "no answer") {
      log.error("a message got no answer from Telegram (counted as sent)");
      return true;
    }
    log.error(`a message was not sent: ${r.error_code} ${(r.description ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
    // The owner blocked the bot, or the chat is gone: Telegram is left aside until the owner writes there again.
    if (owner && chatId === owner.chatId && (r.error_code === 403 || (r.error_code === 400 && /chat not found/i.test(r.description ?? "")))) unreachable = true;
    return false;
  };

  const deliver = async (body: Record<string, unknown>): Promise<boolean> => {
    const o = await loadOwner();
    if (!o || unreachable) return false;
    if (body.type === "text") {
      const text = String((body.text as { body?: unknown } | undefined)?.body ?? "");
      return text ? sendTo(o.chatId, text) : true;
    }
    if (body.type === "interactive") {
      const i = body.interactive as { body?: { text?: unknown }; action?: { buttons?: { reply?: { id?: unknown; title?: unknown } }[] } } | undefined;
      const keyboard = (i?.action?.buttons ?? [])
        .map((b) => b.reply)
        .filter((r): r is { id: string; title: string } => typeof r?.id === "string" && CARD_ID.test(r.id) && typeof r.title === "string" && r.title.trim() !== "")
        .map((r) => ({ text: r.title.slice(0, 40), callback_data: r.id }));
      return sendTo(o.chatId, String(i?.body?.text ?? ""), keyboard);
    }
    return true; // nothing else is ever sent to the owner through here
  };

  // One short line to someone who is not the owner, once (a bot's address can be found by anyone).
  const told = new Set<number>();
  const tellStranger = async (userId: number, chatId: number, text: string): Promise<void> => {
    if (told.has(userId) || told.size > 500) return;
    told.add(userId);
    await sendTo(chatId, text);
  };

  // ---------- voice notes ----------

  const files = new Map<string, { fileId: string; mime: string }>();
  const keepFile = async (fileId: string, mime: string): Promise<string> => {
    const id = `tg_${randomBytes(8).toString("hex")}`;
    files.set(id, { fileId, mime });
    while (files.size > 200) files.delete(files.keys().next().value!);
    // Kept as long as the door keeps an unanswered note (two days), so a restart in between does not lose it.
    await d.kv?.set(FILE_KEY(id), JSON.stringify({ fileId, mime }), 2 * 24 * 3600).catch(() => undefined);
    return id;
  };
  const media = async (id: string): Promise<{ bytes: Buffer; mime: string } | null> => {
    if (!TELEGRAM_MEDIA_ID.test(id)) return null;
    let ref = files.get(id);
    if (!ref && d.kv) {
      try {
        const v = await d.kv.get(FILE_KEY(id));
        ref = v ? (JSON.parse(v) as { fileId: string; mime: string }) : undefined;
      } catch {
        ref = undefined;
      }
    }
    if (!ref) return null;
    const info = await call("getFile", { file_id: ref.fileId });
    const file = info.result as { file_path?: unknown; file_size?: unknown } | undefined;
    const path = typeof file?.file_path === "string" ? file.file_path : "";
    if (!info.ok || !/^[A-Za-z0-9_./-]{1,200}$/.test(path) || path.includes("..")) return null;
    if (typeof file?.file_size === "number" && file.file_size > MEDIA_MAX) return null;
    try {
      const res = await f(`${base}/file/bot${d.config.token}/${path}`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      return bytes.length > MEDIA_MAX ? null : { bytes, mime: ref.mime };
    } catch {
      return null;
    }
  };

  // ---------- what Telegram sends ----------

  const onMessage = async (m: TgMessage): Promise<void> => {
    const userId = m.from?.id;
    const chatId = m.chat?.id;
    // Only one-to-one chats with a person: a group, a channel or another bot is not the owner talking to Pako.
    if (m.chat?.type !== "private" || m.from?.is_bot || typeof userId !== "number" || typeof chatId !== "number") return;
    const text = typeof m.text === "string" ? m.text : "";
    const start = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/.exec(text);
    if (start) {
      const code = start[1] ?? "";
      if (code && (await takeCode(code))) {
        // A pinned owner: another account cannot take the bot, even with a link.
        if (d.config.ownerId !== null && userId !== d.config.ownerId) {
          await sendTo(chatId, t("private"));
          return;
        }
        if (!(await takeOver(m.from, userId, chatId))) {
          await sendTo(chatId, t("notKept"));
          return;
        }
        await sendTo(chatId, t("paired"));
        return;
      }
      if (d.config.ownerId === userId && !(await isOwner(userId)) && !(await loadOff())) await takeOver(m.from, userId, chatId);
      if (await isOwner(userId)) {
        await sendTo(chatId, t("already"));
        return;
      }
      await tellStranger(userId, chatId, code ? t("badLink") : t("private"));
      return;
    }
    // TELEGRAM_OWNER_ID: that account is the owner from its first message (Telegram lets a bot write only to someone who wrote first),
    // unless the owner wrote TELEGRAM OFF: then only a fresh link brings it back.
    if (d.config.ownerId === userId && !(await isOwner(userId)) && !(await loadOff())) await takeOver(m.from, userId, chatId);
    if (!(await isOwner(userId))) {
      await tellStranger(userId, chatId, t("private"));
      return;
    }
    if (owner && owner.chatId !== chatId) await saveOwner({ ...owner, userId, chatId });
    unreachable = false; // the owner wrote here: Telegram reaches them again
    const id = `${TELEGRAM_ID_PREFIX}${chatId}-${m.message_id ?? "x"}`;
    // A forwarded message is someone else's words, as WhatsApp's own forwarded flag says: the door does not take its language for the owner's.
    const forwarded = [m.forward_origin, m.forward_from, m.forward_from_chat, m.forward_sender_name, m.forward_date].some((v) => v != null);
    const context = forwarded ? { context: { forwarded: true } } : {};
    if (text.trim()) {
      await d.ingest({ id, type: "text", text: { body: text }, ...context });
      return;
    }
    // A photo or a file (src/papers.ts): shaped as WhatsApp's image and document, with the size Telegram gives, so the door refuses one too big
    // before fetching it. The door checks what the bytes are; the type and name given here are the sender's word only.
    const caption = typeof m.caption === "string" && m.caption.trim() ? { caption: m.caption.trim() } : {};
    const photo = (Array.isArray(m.photo) ? m.photo : []).filter((p) => typeof p?.file_id === "string" && p.file_id).at(-1); // the largest comes last
    if (photo) {
      const image = { id: await keepFile(photo.file_id!, "image/jpeg"), mime_type: "image/jpeg", file_size: photo.file_size, ...caption };
      await d.ingest({ id, type: "image", image, ...context });
      return;
    }
    const doc = m.document;
    if (typeof doc?.file_id === "string" && doc.file_id) {
      const mime = typeof doc.mime_type === "string" && /^[a-z]+\/[a-z0-9.+-]+$/i.test(doc.mime_type) ? doc.mime_type : "application/octet-stream";
      const document = { id: await keepFile(doc.file_id, mime), mime_type: mime, filename: doc.file_name, file_size: doc.file_size, ...caption };
      await d.ingest({ id, type: "document", document, ...context });
      return;
    }
    const note = m.voice ?? m.audio;
    if (typeof note?.file_id === "string" && note.file_id) {
      const mime = typeof note.mime_type === "string" && /^[a-z]+\/[a-z0-9.+-]+$/i.test(note.mime_type) ? note.mime_type : "audio/ogg";
      await d.ingest({ id, type: "audio", audio: { id: await keepFile(note.file_id, mime), mime_type: mime }, ...context });
      return;
    }
    await d.ingest({ id, type: "other" }); // a sticker, a video: the door says it reads text only
  };

  const onPress = async (q: NonNullable<TgUpdate["callback_query"]>): Promise<void> => {
    // The button's spinner stops whatever happens: Telegram waits for this answer.
    if (typeof q.id === "string") void call("answerCallbackQuery", { callback_query_id: q.id });
    const data = typeof q.data === "string" ? q.data : "";
    if (!(await isOwner(q.from?.id)) || !CARD_ID.test(data) || typeof q.id !== "string") return;
    // The card's buttons go, as in the panel's chat: a card is answered once (the door answers a second press anyway).
    const chat = q.message?.chat?.id;
    if (typeof chat === "number" && typeof q.message?.message_id === "number") {
      void call("editMessageReplyMarkup", { chat_id: chat, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });
    }
    const id = `${TELEGRAM_ID_PREFIX}cb-${q.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 60)}`;
    await d.ingest({ id, type: "interactive", interactive: { type: "button_reply", button_reply: { id: data, title: "" } } });
  };

  const handle = async (update: unknown): Promise<void> => {
    const u = (update ?? {}) as TgUpdate;
    if (u.callback_query) await onPress(u.callback_query);
    else if (u.message) await onMessage(u.message);
    // Edited messages and anything else: nothing to do.
  };

  // ---------- how the news arrive ----------

  const mountWebhook = (app: Express, path: string): void => {
    app.post(path, express.json({ limit: "1mb" }), async (req, res) => {
      if (!same(String(req.get("x-telegram-bot-api-secret-token") ?? ""), secret)) {
        res.status(401).type("text").send("Unauthorized");
        return;
      }
      try {
        await handle(req.body);
        res.status(200).type("text").send("ok");
      } catch (err) {
        // Not taken (the store did not answer, say): Telegram sends it again.
        log.error(`an update was not taken: ${(err as Error).message}`);
        res.status(500).type("text").send("retry");
      }
    });
  };

  const setWebhook = async (url: string): Promise<boolean> => {
    // One update at a time: the owner's messages are handled in the order they wrote them.
    const r = await call("setWebhook", { url, secret_token: secret, allowed_updates: UPDATES, max_connections: 1 });
    if (!r.ok) log.error(`could not set the webhook: ${r.error_code} ${(r.description ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
    return r.ok;
  };

  const poll = (): { stop(): void } => {
    const stopper = new AbortController();
    let stopped = false;
    // A pause that stop() cuts short, so stopping never waits for one.
    const sleep = (ms: number): Promise<void> => new Promise((r) => {
      const t = setTimeout(r, ms);
      stopper.signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
    });
    const waitSeconds = d.pollSeconds ?? 25;
    const pause = d.pauseMs ?? 1000;
    pollEnded = null;
    void (async () => {
      let offset = 0;
      /** The offset Telegram was last told: the updates before it are confirmed there, and never sent again. */
      let told = 0;
      let backoff = pause;
      let conflicts = 0;
      const tries = new Map<number, number>();
      while (!stopped) {
        const asked = now();
        told = offset;
        const r = await call("getUpdates", { offset, timeout: waitSeconds, allowed_updates: UPDATES }, { timeoutMs: (waitSeconds + 15) * 1000, signal: stopper.signal });
        if (stopped) return;
        // An empty answer that came at once (no long wait on the other side): a pause, so this never turns into a loop that asks without rest.
        if (r.ok && Array.isArray(r.result) && r.result.length === 0 && now() - asked < 1000) await sleep(pause);
        if (!r.ok) {
          if (r.error_code === 409) {
            // A webhook: this bot's news go to a server. Another poll (a second copy of Pako, or a restart a moment ago): it may pass, so a few tries.
            const webhook = /webhook/i.test(r.description ?? "");
            if (webhook || ++conflicts > 5) {
              // Kept, so the panel can say why nothing written on Telegram arrives instead of showing a bot that looks ready.
              pollEnded = webhook ? "webhook" : "conflict";
              log.error(`this bot's news already go elsewhere (${webhook ? "a webhook" : "another Pako polling with the same token"}): `
                + "not polling here. Give this computer a bot of its own.");
              return;
            }
            await sleep(pause * 30);
            continue;
          }
          if (r.error_code === 401 || r.error_code === 404) {
            refused = true;
            d.health?.(false, "the bot token was refused");
            log.error("Telegram refused the bot token (revoked, or the bot was deleted): not polling. Set a new one.");
            return;
          }
          if (r.description !== "stopped") d.health?.(false, r.description ?? `error ${r.error_code}`);
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 60_000);
          continue;
        }
        d.health?.(true);
        backoff = pause;
        conflicts = 0;
        for (const u of Array.isArray(r.result) ? (r.result as TgUpdate[]) : []) {
          if (typeof u.update_id !== "number") continue;
          try {
            await handle(u);
          } catch (err) {
            // Not taken: asked for again from this one (the door drops what it already handled). One that keeps failing is let go after a few tries.
            const n = (tries.get(u.update_id) ?? 0) + 1;
            tries.set(u.update_id, n);
            log.error(`an update was not taken (try ${n}): ${(err as Error).message}`);
            if (n < 5) {
              await sleep(backoff);
              break;
            }
          }
          offset = u.update_id + 1;
          tries.delete(u.update_id);
        }
      }
      // Stopped while updates were being handled: Telegram has not been told they were taken (only the next getUpdates tells it), so the next
      // start would get them again and the owner's last message would be acted on twice. One short call confirms them.
      if (offset > told) await call("getUpdates", { offset, timeout: 0, limit: 1, allowed_updates: UPDATES }, { timeoutMs: 5000 });
    })();
    return {
      stop: () => {
        stopped = true;
        stopper.abort();
      },
    };
  };

  return {
    paired: async () => !!(await loadOwner()),
    reachable: async () => !unreachable && !!(await loadOwner()),
    pairedNow: () => !!owner,
    deliver,
    pairLink,
    unpair: async () => {
      // Forgotten here at once whatever the store says; a pending link stops working too, and a pinned account does not come back by itself.
      formerChat = owner?.chatId ?? formerChat;
      owner = null;
      off = true;
      pending = null;
      told.clear(); // the account that was the owner is told it is private, once, if it writes again
      if (!d.kv) return true;
      try {
        await d.kv.set(OFF_KEY, "1", 5 * 365 * 24 * 3600);
        await d.kv.set(OWNER_KEY, "", 1);
        await d.kv.set(PAIR_KEY, "", 1);
        return true;
      } catch {
        return false;
      }
    },
    farewell: async (text: string) => {
      if (formerChat !== null) await sendTo(formerChat, text);
    },
    media,
    handle,
    mountWebhook,
    setWebhook,
    poll,
    username,
    check,
    account: async () => (await loadOwner())?.label ?? null,
    tokenRefused: () => refused,
    hasWebhook: async () => {
      const r = await call("getWebhookInfo", {});
      const url = (r.result as { url?: unknown } | undefined)?.url;
      return r.ok && typeof url === "string" ? url !== "" : null;
    },
    pollStopped: () => pollEnded,
  };
}
