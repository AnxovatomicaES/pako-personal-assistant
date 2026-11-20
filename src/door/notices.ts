// Notices for the owner: sent when they can arrive, otherwise kept and given the next time the owner writes.

import { localStamp } from "./time.ts";
import { TEMPLATE_TEXT_MAX, HELD_NOTICES_MAX, PING_EVERY_MS } from "./shared.ts";
import type { HeldNotice, Door } from "./door.ts";
import { createLog } from "../log.ts";
import { readJsonRecord } from "../json-record.ts";

const log = createLog("whatsapp");

const HELD_NOTICES_KEY = "assistant-held-notices";

export function mountNotices(door: Door): Pick<Door, "hold" | "notifyOwner" | "flushHeld"> {
  const {
    d, config, now, tx, note, reachable, sendText, sendButton, loadReminders, saveReminders, remLock, sendReminderTemplate, sendReminderCard,
  } = door;
  let heldNotices: HeldNotice[] | null = null;
  /** Throws when the store cannot be read: an empty list in its place would overwrite the notices kept there. */
  const loadHeldNotices = async (): Promise<HeldNotice[]> => {
    if (heldNotices) return heldNotices;
    const raw = d.kv ? await readJsonRecord(d.kv, HELD_NOTICES_KEY) : null;
    if (heldNotices) return heldNotices;
    let p: unknown = [];
    try {
      p = raw ? raw : [];
    } catch {
      log.error("the held notices could not be used: starting again");
    }
    heldNotices = (Array.isArray(p) ? p : []).flatMap((x): HeldNotice[] => {
      if (typeof x === "string") return [{ text: x }];
      const h = x as { text?: unknown; undo?: unknown } | null;
      if (!h || typeof h.text !== "string") return [];
      return [{ text: h.text, ...(typeof h.undo === "string" && /^[0-9a-f]{10}$/.test(h.undo) ? { undo: h.undo } : {}) }];
    });
    return heldNotices;
  };
  const saveHeldNotices = async (list: HeldNotice[]): Promise<void> => {
    heldNotices = list.slice(-HELD_NOTICES_MAX);
    const stored = heldNotices.map((h) => (h.undo ? h : h.text));
    if (d.kv) await d.kv.set(HELD_NOTICES_KEY, JSON.stringify(stored), 7 * 24 * 3600).catch((err: Error) => log.error(`could not keep a notice: ${err.message}`));
  };
  /**
   * Something the owner did not ask for just now (an email, a Slack message): sent if WhatsApp lets this server write (inside 24 hours of the owner's
   * last message, or with the reminder template), otherwise kept and given with the owner's next message. Never lost for the window.
   */
  let lastPingAt = 0;
  // Keeping a notice and giving the kept ones are never done at the same time: a notice kept while the others are being sent must not be wiped with them.
  let heldChain: Promise<unknown> = Promise.resolve();
  const heldLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = heldChain.then(fn, fn);
    heldChain = run.catch(() => undefined);
    return run;
  };
  const hold = (text: string, undo?: string): Promise<number> =>
    heldLock(async () => {
      try {
        const list = [...(await loadHeldNotices()), { text: text.slice(0, 1500), ...(undo ? { undo } : {}) }];
        await saveHeldNotices(list);
        return list.length;
      } catch (err) {
        log.error(`could not keep a notice for later: ${(err as Error).message}`);
        return 1;
      }
    });
  /**
   * Inside the window: sent as it is. Outside it, with the notice template (WHATSAPP_REMINDER_TEMPLATE): a notice that fits is sent whole; a longer
   * one is kept and a preview goes out, with the template's "See" button (or any message from the owner) bringing the rest. Without a template the
   * notice waits for the owner's next message. Urgent notices always ping; ordinary ones at most every half hour, saying how many are waiting.
   */
  const notifyOwner = async (text: string, o: { urgent?: boolean } = {}): Promise<"sent" | "held"> => {
    const t = now();
    if (await reachable(t)) {
      if (await sendText(text)) return "sent";
      await hold(text);
      return "held";
    }
    if (!config.reminderTemplate) {
      await hold(text);
      return "held";
    }
    const flat = text.replace(/\s+/g, " ").trim();
    if (flat.length <= TEMPLATE_TEXT_MAX && (o.urgent || t - lastPingAt >= PING_EVERY_MS)) {
      if (await sendReminderTemplate(flat)) {
        lastPingAt = t;
        return "sent";
      }
    }
    const waiting = await hold(text);
    if (o.urgent || t - lastPingAt >= PING_EVERY_MS) {
      const preview = flat.length > 280 ? `${flat.slice(0, 277).replace(/\s+\S*$/, "")}…` : flat;
      const more = waiting > 1 ? tx(waiting > 2 ? "moreNotices" : "moreNotice", { n: waiting - 1 }) : "";
      if (await sendReminderTemplate(`${preview}${more}`)) lastPingAt = t;
    }
    return "held";
  };

  /** The owner wrote: reminders that fell due while WhatsApp would not let this server write first are given now. */
  const flushHeld = (): Promise<void> => remLock(flushHeldNow);
  const flushHeldNow = async (): Promise<void> => {
    await heldLock(async () => {
      try {
        const held = await loadHeldNotices();
        if (!held.length) return;
        const plain = held.filter((h) => !h.undo);
        const kept: HeldNotice[] = [];
        if (plain.length && !(await sendText(tx("heldNotices", { notices: plain.map((h) => h.text).join("\n\n") })))) kept.push(...plain);
        // A receipt comes as it would have: a card with its own Undo (the owner just wrote, so it can arrive), and UNDO typed counts
        // its day from now, not from the change (which may be days old).
        for (const h of held.filter((x) => x.undo)) {
          const body = tx("heldReceipt", { text: h.text });
          if ((await sendButton(body, `u1:${h.undo}`, tx("btnUndo"))) || (await sendText(tx("heldReceiptTyped", { body })))) {
            // Not awaited: this runs inside the reminders' lock, and an undo holds the journal's while it waits for that one. The journal does
            // one thing at a time in order, so an UNDO in this very message still finds the receipt shown.
            void door.journal.shown(h.undo!, now()).catch(() => undefined);
          } else kept.push(h);
        }
        if (kept.length !== held.length) await saveHeldNotices(held.filter((h) => kept.includes(h)));
      } catch (err) {
        log.error(`could not give the held notices: ${(err as Error).message}`);
      }
    });
    try {
      const list = await loadReminders();
      const held = list.filter((r) => r.held);
      if (!held.length) return;
      for (const r of held) {
        if (!(await sendReminderCard(r, tx("reminderLate", { at: localStamp(r.at, d.timeZone), text: r.text })))) return;
        const i = list.indexOf(r);
        if (i >= 0) list.splice(i, 1);
        note(tx("noteReminderLate", { text: r.text }));
      }
      await saveReminders(list);
    } catch (err) {
      log.error(`could not give the held reminders: ${(err as Error).message}`);
    }
  };

  return { hold, notifyOwner, flushHeld };
}
