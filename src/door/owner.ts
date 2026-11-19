// Who the owner is on WhatsApp, and which chat Pako answers on: the door's own, Telegram, or the owner's WhatsApp on a computer.

import { AsyncLocalStorage } from "node:async_hooks";
import { BSUID } from "./config.ts";
import type { OwnerChannel } from "./deps.ts";
import type { Door } from "./door.ts";
import { createLog } from "../log.ts";

const log = createLog("whatsapp");

/** The names this part adds to the door. */
type Part = Pick<
  Door,
  | "isOwner" | "via" | "setLastChannel" | "telegramReady" | "startedRoute" | "lastRoute" | "ownStart" | "reachable" | "placeName"
>;

export function mountOwner(door: Door): Part {
  const { d, config, now } = door;
  // ---------- who is the owner: by phone number, or by user id when WhatsApp leaves the number out ----------

  door.ownerBsuid = config.ownerBsuid;
  let bsuidLoaded = false;
  /** The owner's last message came without a phone number (they use a username): answer by user id. */
  door.preferBsuid = false;
  const hinted = new Set<string>();
  const BSUID_KEY = "whatsapp-owner-bsuid";
  const loadBsuid = async (): Promise<void> => {
    if (bsuidLoaded) return;
    bsuidLoaded = true;
    if (door.ownerBsuid || !d.kv) return;
    try {
      const v = await d.kv.get(BSUID_KEY);
      if (v && BSUID.test(v)) door.ownerBsuid = v;
    } catch {
      bsuidLoaded = false; // try again with the next message
    }
  };
  /** True for the owner. A message that carries both the owner's number and a user id teaches the id (Meta signs the payload, so it cannot be forged). */
  const isOwner = async (m: Record<string, unknown>): Promise<boolean> => {
    await loadBsuid();
    const phone = String(m.from ?? "").replace(/\D/g, "");
    const id = typeof m.from_user_id === "string" && BSUID.test(m.from_user_id) ? m.from_user_id : "";
    if (phone && phone === config.ownerDigits) {
      door.preferBsuid = false;
      if (id && id !== door.ownerBsuid) {
        door.ownerBsuid = id;
        d.kv?.set(BSUID_KEY, id, 365 * 24 * 3600).catch(() => undefined);
      }
      return true;
    }
    if (id && door.ownerBsuid && id === door.ownerBsuid) {
      door.preferBsuid = !phone;
      return true;
    }
    // Someone known only by user id: it may be the owner with a username. Say so once, so the owner can set WHATSAPP_OWNER_BSUID.
    if (!phone && id && !hinted.has(id) && hinted.size < 20) {
      hinted.add(id);
      log.error(`a message came from a sender known only by the user id ${id}: if that is you, set WHATSAPP_OWNER_BSUID to it (it is ignored until then)`);
    }
    return false;
  };

  // ---------- which chat: the one the owner is being answered on, else the one they last wrote on ----------

  // Each owner message is handled inside its chat's context, which every send made while handling it (and anything started from it, like a
  // call's outcome) can read. A send with no context was started by Pako: a reminder, a notice, a connector's card.
  const via = new AsyncLocalStorage<OwnerChannel>();
  const LAST_CHANNEL_KEY = "assistant-last-channel";
  let lastChannel: OwnerChannel | null = null;
  const loadLastChannel = async (): Promise<OwnerChannel> => {
    if (lastChannel) return lastChannel;
    try {
      const v = await d.kv?.get(LAST_CHANNEL_KEY);
      if (v === "telegram" || v === "base" || v === "whatsapp") lastChannel = v;
    } catch {
      /* the store did not answer: the door's own chat until it does */
    }
    return lastChannel ?? "base";
  };
  const setLastChannel = (c: OwnerChannel): void => {
    if (lastChannel === c) return;
    lastChannel = c;
    d.kv?.set(LAST_CHANNEL_KEY, c, 365 * 24 * 3600).catch(() => undefined);
  };
  const telegramReady = async (): Promise<boolean> => !!d.telegram && (await d.telegram.reachable().catch(() => false));
  /**
   * Where something Pako starts goes. On a server: where the owner last wrote; when that is WhatsApp and its 24 hours are over, Telegram (if
   * paired). On a computer: Telegram whenever it is paired, as the panel's chat is seen only while it is open; the chat keeps a copy (graph).
   */
  const lineReady = async (): Promise<boolean> => !!d.local && !!d.whatsapp && (await d.whatsapp.reachable().catch(() => false));
  const startedRoute = async (): Promise<OwnerChannel> => {
    // On a computer with the owner's WhatsApp open (they wrote there in the last 24 hours): there, unless they last wrote on Telegram.
    if (await lineReady()) return (await telegramReady()) && (await loadLastChannel()) === "telegram" ? "telegram" : "whatsapp";
    if (!(await telegramReady())) return "base";
    if (d.local) return "telegram";
    if ((await loadLastChannel()) === "telegram") return "telegram";
    return (await door.windowOpen(now())) ? "base" : "telegram";
  };
  /** Where the owner last wrote: Telegram while it can be reached there, else the door's own chat. */
  const lastRoute = async (): Promise<OwnerChannel> => {
    const last = await loadLastChannel();
    if (last === "whatsapp" && (await lineReady())) return "whatsapp";
    return (await telegramReady()) && last === "telegram" ? "telegram" : "base";
  };
  // Set while a send that Pako started is under way although its chat was already chosen (a receipt with no answer to go with, a connector's
  // card): graph tells it from an answer by this, as those run inside their chat's context.
  const ownStart = new AsyncLocalStorage<boolean>();
  /** The owner can be written to: WhatsApp's 24-hour window is open (the panel's chat always is), or Telegram is paired. */
  const reachable = async (t: number): Promise<boolean> => (await door.windowOpen(t)) || (await telegramReady());
  /** How the connector's answers name where the owner was asked. */
  const placeName = (route: OwnerChannel): string =>
    route === "telegram" ? "on Telegram" : route === "whatsapp" || !d.local ? "on WhatsApp" : "in the panel's chat";

  return { isOwner, via, setLastChannel, telegramReady, startedRoute, lastRoute, ownStart, reachable, placeName };
}
