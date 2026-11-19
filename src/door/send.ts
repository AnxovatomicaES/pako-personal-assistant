// Writing to the owner: one body in Meta's format, sent on the chat of this moment, and the text and button cards built on it.

import { threeButtons, plainWhatsapp } from "./format.ts";
import type { OwnerChannel } from "./deps.ts";
import { chunkText } from "./shared.ts";
import type { Door } from "./door.ts";
import { createLog } from "../log.ts";

const logTelegram = createLog("telegram");
const logWhatsapp = createLog("whatsapp");

export function mountSend(door: Door): Pick<Door, "sendHealth" | "graph" | "sendText" | "sendButtons" | "sendButton" | "sendConfirm"> {
  const { d, config, f, now, tx, via, startedRoute, ownStart } = door;
  // ---------- sending (always and only to the owner) ----------

  /**
   * One message to the owner. On Telegram when that is the chat (see above); otherwise by phone number or by user id (the order depends on how
   * the owner last wrote), the other way being tried when WhatsApp refuses the first.
   */
  /** For the watchdog: a send Meta took, or one refused for a reason that is WhatsApp's for this server, not the one message's. */
  const sendHealth = (status: number): void => {
    if (status >= 200 && status < 300) d.health?.(true);
    else if (status === 401 || status === 403 || status === 429 || status >= 500) d.health?.(false, `Meta answered ${status}`);
  };
  const graph = async (body: Record<string, unknown>, out?: { on?: OwnerChannel }, secret?: boolean): Promise<boolean> => {
    // Anything sent: a card's or a brief's "Useful?" is no longer the last thing the owner read (src/quality.ts).
    d.quality?.clearAsk();
    const given = via.getStore();
    const route = given ?? (await startedRoute());
    if (route === "telegram" && d.telegram) {
      if (await d.telegram.deliver(body)) {
        if (out) out.on = "telegram";
        // On a computer, what Pako started reaches the phone and the panel's chat keeps a copy marked as sent there, so it shows everything.
        // Only once it is on Telegram: one that falls back to the chat below is shown there once, unmarked.
        if (d.local && (given === undefined || ownStart.getStore() === true)) {
          await d.local.deliver(body, { via: "telegram", secret, started: true }).catch(() => false);
        }
        return true;
      }
      // Not on Telegram: the other chat, but only where it can arrive (WhatsApp drops what comes after its 24 hours, and says nothing).
      if (!d.local && !(await door.windowOpen(now()))) return false;
      logTelegram.error("the owner could not be reached on Telegram: sending it to the other chat");
    }
    if (route === "whatsapp" && d.local && d.whatsapp) {
      if (await d.whatsapp.deliver(threeButtons(body)).catch(() => false)) {
        if (out) out.on = "whatsapp";
        // As with Telegram: what Pako started has a copy in the panel's chat, marked as sent to WhatsApp.
        if (given === undefined || ownStart.getStore() === true) {
          await d.local.deliver(body, { via: "whatsapp", secret, started: true }).catch(() => false);
        }
        return true;
      }
      logWhatsapp.error("the owner could not be reached on WhatsApp: sending it to the panel's chat");
    }
    if (out) out.on = "base";
    // `secret`: the chat's copy is marked, so the export leaves it out (src/data.ts).
    // `started`: no chat's context (a reminder, a routine, a notice) or one Pako started inside it: the Mac app notifies about these.
    if (d.local) return d.local.deliver(body, { secret, started: given === undefined || ownStart.getStore() === true });
    body = threeButtons(body);
    const byPhone = { to: config.ownerDigits };
    const byId = door.ownerBsuid ? { recipient: door.ownerBsuid } : null;
    const order = byId ? (door.preferBsuid ? [byId, byPhone] : [byPhone, byId]) : [byPhone];
    for (const target of order) {
      try {
        const res = await f(`https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`, {
          method: "POST",
          headers: { authorization: `Bearer ${config.accessToken}`, "content-type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...target, ...body }),
          signal: AbortSignal.timeout(10_000),
        });
        sendHealth(res.status);
        if (res.ok) return true;
        logWhatsapp.error(`send failed ${res.status}: ${(await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 240)}`);
      } catch (err) {
        // No answer at all: it may have been delivered, so it is not sent again, another way or later (a reminder would come twice).
        logWhatsapp.error(`send got no answer (counted as sent): ${(err as Error).message}`);
        d.health?.(false, "no answer from Meta");
        return true;
      }
    }
    return false;
  };
  const sendText = async (text: string, o: { secret?: boolean } = {}): Promise<boolean> => {
    let ok = true;
    for (const part of chunkText(plainWhatsapp(text))) ok = (await graph({ type: "text", text: { body: part, preview_url: false } }, undefined, o.secret)) && ok;
    return ok;
  };
  const sendButtons = (body: string, yesId: string, noId: string, yesTitle: string, out?: { on?: OwnerChannel }): Promise<boolean> =>
    graph({
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body.slice(0, 1000) },
        action: {
          buttons: [
            { type: "reply", reply: { id: yesId, title: yesTitle } },
            { type: "reply", reply: { id: noId, title: tx("btnCancel") } },
          ],
        },
      },
    }, out);
  /** A card with one button (a receipt's Undo): nothing to cancel, so no Cancel. */
  const sendButton = (body: string, id: string, title: string): Promise<boolean> =>
    graph({
      type: "interactive",
      interactive: { type: "button", body: { text: body.slice(0, 1000) }, action: { buttons: [{ type: "reply", reply: { id, title } }] } },
    });
  const sendConfirm = (body: string, id: string): Promise<boolean> => sendButtons(body, `c1:${id}`, `c0:${id}`, tx("btnCall"));

  return { sendHealth, graph, sendText, sendButtons, sendButton, sendConfirm };
}
