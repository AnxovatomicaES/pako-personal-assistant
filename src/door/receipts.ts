// Receipts with Undo (src/undo.ts): what really changed, told to the owner once, on the chat the change came from.

import { createUndoJournal, receiptText, UNDO_KEY, type Change, type UndoEntry } from "../undo.ts";
import { type OwnerChannel, TELEGRAM_ID_PREFIX } from "./deps.ts";
import type { Door } from "./door.ts";
import { createLog } from "../log.ts";

const log = createLog("undo");

/** The names this part adds to the door. */
type Part = Pick<
  Door,
  | "journal" | "replyKeys" | "remember" | "keyOf" | "routeOf" | "inRoute" | "sendReceipt" | "claimReceipt" | "noteReceipt" | "replyReceipt"
>;

export function mountReceipts(door: Door): Part {
  const { d, now, lang, tx, via, startedRoute, ownStart, sendButton, windowOpen, hold } = door;
  // ---------- undo: what the assistant changed by itself, told from here with an Undo button (src/undo.ts) ----------

  const journal = createUndoJournal(d.kv, now);
  /** Answers already acted on, by the bridge's key: one sent again does what it asks once, and makes no second receipt. */
  const replyKeys = new Set<string>();
  /** Answers whose receipt went from here already (its reply, or the wait for one ran out): a reply after that starts a receipt of its own. */
  const cardedKeys = new Set<string>();
  const remember = (set: Set<string>, key: string): void => {
    set.add(key);
    if (set.size > 300) set.delete(set.values().next().value!);
  };
  /** The bridge's key for an answer: the id of the message it answers (WhatsApp's own ids may carry + / =, base64). */
  const keyOf = (v: unknown): string => (typeof v === "string" && UNDO_KEY.test(v) ? v : "");
  /** The answer to a message goes back to the chat that message came from; with no key (a notice, "un momento") it is started by Pako. */
  // On a computer a WhatsApp id (wamid.) can only be a message from the owner's WhatsApp set up in the panel.
  const routeOf = (key: string): OwnerChannel | null =>
    key.startsWith(TELEGRAM_ID_PREFIX) ? "telegram" : d.local && d.whatsapp && key.startsWith("wamid.") ? "whatsapp" : /^(wamid\.|local-)/.test(key) ? "base" : null;
  const inRoute = (key: string, fn: () => Promise<void>): Promise<void> => {
    const route = routeOf(key);
    return route ? via.run(route, fn) : fn();
  };

  /**
   * The card for one entry (all its answer changed), with an Undo button, on the chat that answer went to. When it cannot arrive there
   * (WhatsApp's 24 hours are over, or the send failed) it waits, with its button, for the owner's next message. Never throws.
   */
  const sendCard = async (entry: UndoEntry): Promise<void> => {
    const body = receiptText(entry.changes, d.timeZone, lang());
    try {
      const given = via.getStore();
      const route = given ?? (await startedRoute());
      // After WhatsApp's 24 hours Meta takes the card and drops it, saying nothing (Telegram falls back to WhatsApp only while it is open).
      const open = !!d.local || route === "telegram" || (await windowOpen(now()));
      if (open && (await ownStart.run(given === undefined, () => via.run(route, () => sendButton(body, `u1:${entry.id}`, tx("btnUndo")))))) return;
    } catch (err) {
      log.error(`could not send a receipt: ${(err as Error).message}`);
    }
    await hold(body, entry.id);
  };
  /** One entry and its card for what changed, at once. Never throws. */
  const sendReceipt = async (changes: Change[], key = ""): Promise<void> => {
    if (!changes.length) return;
    let entry: UndoEntry;
    try {
      entry = await journal.record(changes, { key, carded: true });
    } catch (err) {
      log.error(`could not record a change: ${(err as Error).message}`);
      await hold(receiptText(changes, d.timeZone, lang()));
      return;
    }
    await sendCard(entry);
  };

  /**
   * Answers whose notes were recorded (their entry is in the journal at once) and whose card waits for their reply, to go after its text with
   * its reminders: the entry, and the timer that sends the card alone when no reply comes.
   */
  const receipts = new Map<string, { entry: Promise<UndoEntry | null>; timer: ReturnType<typeof setTimeout> | null }>();
  const takeReceipt = (key: string): { entry: Promise<UndoEntry | null> } | null => {
    const waiting = key ? receipts.get(key) : undefined;
    if (!waiting) return null;
    receipts.delete(key);
    if (waiting.timer) clearTimeout(waiting.timer);
    return waiting;
  };
  /** The reply came: its notes stop waiting for the timer (they go with it, after its text and what it asks for). */
  const claimReceipt = (key: string): void => {
    const waiting = key ? receipts.get(key) : undefined;
    if (!waiting?.timer) return;
    clearTimeout(waiting.timer);
    waiting.timer = null;
  };
  /** No reply came in time (an answer that was only tags): the card goes by itself; a reply after it starts a receipt of its own. */
  const sendWaiting = async (key: string): Promise<void> => {
    const waiting = takeReceipt(key);
    if (!waiting) return;
    remember(cardedKeys, key);
    const entry = await waiting.entry;
    if (entry && !entry.undoneAt) await inRoute(key, () => sendCard(entry));
  };
  /**
   * Notes the bridge changed. Recorded now: a restart before the reply comes can lose the card, never what UNDO undoes. With the answer's
   * key the card waits for its reply (a while at most: a reply with no text never comes); an old bridge sends no key, and its receipt goes at
   * once, by itself (its reply comes next). Never throws.
   */
  const noteReceipt = async (key: string, changes: Change[]): Promise<void> => {
    if (!changes.length) return;
    if (!key) return sendReceipt(changes);
    // The reply went already (notes the bridge kept after a failed try, and sent later): nothing to wait for.
    if (replyKeys.has(key) || cardedKeys.has(key)) return inRoute(key, () => sendReceipt(changes, key));
    const waiting = receipts.get(key);
    if (waiting) {
      await journal.join(key, changes, { card: false, look: false }); // after the record that started it: one journal write at a time
      return;
    }
    // Keys that never get a reply (a runaway) must not pile up: the oldest one waiting goes now.
    if (receipts.size >= 20) void sendWaiting(receipts.keys().next().value!);
    const timer = setTimeout(() => void sendWaiting(key), d.receiptWaitMs ?? 90_000);
    timer.unref?.();
    const entry = journal.join(key, changes, { card: false, look: false });
    receipts.set(key, { entry, timer });
    await entry;
  };
  /**
   * The receipt that follows an answer's reply: one entry and one card for all the answer changed, its notes (recorded when they came, here
   * or, after a restart, by the copy of the server that took them: `noted`, a newer bridge's word that there were some) and what the reply
   * itself changed. Never throws.
   */
  const replyReceipt = async (key: string, changes: Change[], noted: boolean): Promise<void> => {
    const waiting = takeReceipt(key);
    if (!key || cardedKeys.has(key)) return sendReceipt(changes, key);
    if (!waiting && !noted) return sendReceipt(changes, key);
    if (waiting) await waiting.entry;
    remember(cardedKeys, key);
    const entry = await journal.join(key, changes, { card: true, look: !waiting });
    if (entry) await sendCard(entry);
  };

  return { journal, replyKeys, remember, keyOf, routeOf, inRoute, sendReceipt, claimReceipt, noteReceipt, replyReceipt };
}
