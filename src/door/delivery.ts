// A message to a friend on its way: sent as text or by the template, tracked, and its delivery news told to the owner.

import { pauseLabel, pausedText } from "../control.ts";
import { waLink } from "../links.ts";
import { T } from "./texts.ts";
import type { Delivery, Door } from "./door.ts";
import { createLog } from "../log.ts";

const log = createLog("whatsapp");

export function mountDelivery(door: Door): Pick<Door, "graphTo" | "deliver" | "handleStatus"> {
  const { d, config, f, now, lang, tx, sendStamps, sentTo, tracked, note, sendHealth, sendText, sendLimit, withOpening } = door;
  /** One message to a friend, from the assistant's own number. Says what WhatsApp answered; an unanswered request is never repeated. */
  const graphTo = async (digits: string, body: Record<string, unknown>): Promise<Delivery> => {
    try {
      const res = await f(`https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: digits, ...body }),
        signal: AbortSignal.timeout(10_000),
      });
      const doc = (await res.json().catch(() => ({}))) as { messages?: { id?: string }[]; error?: { code?: number; message?: string; error_data?: { details?: string } } };
      sendHealth(res.status);
      if (res.ok) return { ok: true, id: doc.messages?.[0]?.id ?? "", code: 0, detail: "" };
      const detail = (doc.error?.error_data?.details ?? doc.error?.message ?? `HTTP ${res.status}`).replace(/\s+/g, " ").slice(0, 200);
      log.error(`a message to a friend was refused (${res.status}), code ${doc.error?.code ?? "?"}: ${detail}`);
      return { ok: false, id: "", code: Number(doc.error?.code) || 0, detail };
    } catch (err) {
      d.health?.(false, "no answer from Meta");
      log.error(`a message to a friend got no answer: ${(err as Error).message}`);
      return { ok: false, id: "", code: -1, detail: "" };
    }
  };

  const track = (id: string, info: { digits: string; label: string; text: string; templated: boolean }): void => {
    if (!id) return;
    tracked.set(id, info);
    if (tracked.size > 50) tracked.delete(tracked.keys().next().value!);
  };
  const markSent = (digits: string, label: string, at: number): void => {
    sendStamps.push({ digits, at });
    sentTo.set(digits, { label, at });
  };

  const failureText = (label: string, digits: string, text: string, code: number, detail: string): string => {
    const template = tx(config.templateName ? "templateFailed" : "templateMissing");
    const why = code === 131030
      ? tx("refusedTestNumber", { label })
      : code === 131047
        ? tx("refusedWindow", { label, template })
        : tx("refused", { label, code: code || "?", detail: detail ? `: ${detail}` : "" });
    return tx("sendItYourself", { why, link: waLink(digits, text) });
  };

  /** The approved template: its two variables are the owner's name and the message (one line: WhatsApp refuses line breaks in a variable). */
  const sendTemplate = (t: { digits: string; text: string }): Promise<Delivery> =>
    graphTo(t.digits, {
      type: "template",
      template: {
        name: config.templateName,
        language: { code: config.templateLang },
        components: [{ type: "body", parameters: [{ type: "text", text: d.ownerName }, { type: "text", text: t.text.replace(/\s+/g, " ").trim().slice(0, 700) }] }],
      },
    });

  /** False when it certainly did not go (paused, over the limit, refused): the owner was told why. */
  const deliver = async (p: { digits: string; label: string; text: string }): Promise<boolean> => {
    const pause = d.control ? await d.control.state() : null;
    if (d.control && pause && pause.paused !== null) {
      // One language for the log line and the answer; why, as it is (a pause Pako set by itself is not the owner's STOP).
      const l = lang();
      d.control.log("blocked", T(l)("logBlocked", { label: p.label, why: pauseLabel(pause.why, l) }));
      await sendText(T(l)("notSentPaused", { paused: pausedText(pause.why, l) }));
      return false;
    }
    const at = now();
    const blocked = sendLimit(p.digits, at);
    if (blocked) {
      await sendText(blocked);
      return false;
    }
    let r = await graphTo(p.digits, { type: "text", text: { body: withOpening(p.text), preview_url: false } });
    let templated = false;
    if (!r.ok && r.code === 131047 && config.templateName) {
      templated = true;
      r = await sendTemplate(p);
    }
    if (r.ok) {
      markSent(p.digits, p.label, at);
      d.control?.log("whatsapp", tx("logSent", { label: p.label, template: templated ? tx("logSentTemplate") : "" }));
      track(r.id, { ...p, templated });
      note(tx("noteSent", { label: p.label, template: templated ? tx("noteSentTemplate") : "" }));
      await sendText(tx("sentFriend", { label: p.label, template: templated ? tx("sentFriendTemplate") : "" }));
      return true;
    }
    note(tx("noteNotSent", { label: p.label, code: r.code }));
    d.control?.log("failure", tx("logNotSent", { label: p.label, code: r.code }));
    await sendText(r.code === -1 ? tx("sendUnknown", { label: p.label }) : failureText(p.label, p.digits, p.text, r.code, r.detail));
    return r.code === -1; // no answer: it may have gone
  };

  /** What WhatsApp later says about a message to a friend: delivered, or failed (and then the template, if there is one, or the link). */
  const handleStatus = async (st: Record<string, unknown>): Promise<string | null> => {
    const id = typeof st.id === "string" ? st.id : "";
    const info = tracked.get(id);
    if (!info) return null;
    const status = String(st.status ?? "");
    if (status === "delivered" || status === "read") {
      tracked.delete(id);
      note(tx("noteDelivered", { label: info.label }));
      await door.notifyOwner(tx("delivered", { label: info.label }));
      return "status delivered";
    }
    if (status !== "failed") return null;
    tracked.delete(id);
    const err = (Array.isArray(st.errors) ? st.errors[0] : null) as { code?: number; message?: string; error_data?: { details?: string } } | null;
    const code = Number(err?.code) || 0;
    // 8. STOP also stops the template retry to the friend.
    const paused = d.control ? (await d.control.paused()) !== null : false;
    if (code === 131047 && config.templateName && !info.templated && !paused) {
      const r = await sendTemplate(info);
      if (r.ok) {
        track(r.id, { ...info, templated: true });
        note(tx("noteResent", { label: info.label }));
        await door.notifyOwner(tx("resentTemplate", { label: info.label }));
        return "status failed, template sent";
      }
    }
    const detail = (err?.error_data?.details ?? err?.message ?? "").replace(/\s+/g, " ").slice(0, 200);
    note(tx("noteNotDelivered", { label: info.label, code }));
    await door.notifyOwner(failureText(info.label, info.digits, info.text, code, detail));
    return "status failed";
  };

  return { graphTo, deliver, handleStatus };
}
