// Messages to friends: the card that asks, the owner's yes, the limits, and a friend's answer passed on to the owner.

import { randomBytes } from "node:crypto";
import { waLink } from "../links.ts";
import { MAX_SEEN } from "./inbox.ts";
import { TYPED_NUMBER_MS, SEND_DAILY, SEND_PER_NUMBER_DAILY, REPLY_FORWARD_MS } from "./shared.ts";
import { callingCode, nationalNumber, phoneCountry, withoutTrunkZero } from "../region.ts";
import type { Door } from "./door.ts";
import type { Handler } from "./incoming.ts";

/** The names this part adds to the door. */
type Part = Pick<
  Door,
  | "prepareMessage" | "rememberNumbers" | "resolveFriend" | "sendLimit" | "withOpening" | "proposeSend" | "answerSend" | "forwardReply"
>;

/** The digits of a typed number with its country code: as written when it has + or 00, else read as a national number of the owner's country. */
const international = (raw: string): string => {
  const digits = withoutTrunkZero(raw).replace(/\D/g, "");
  if (/^\s*(?:\+|00)/.test(raw)) return digits.replace(/^00/, "");
  return (nationalNumber(digits) ?? digits).replace(/^\+/, "");
};

/** The owner's country's calling code as an example ("+1…"); a bare "+…" when the country is not known (no country is assumed). */
const codeExample = (_l?: string): string => {
  const c = callingCode(phoneCountry());
  return c ? `+${c}…` : "+…";
};

export function mountMessages(door: Door): Part {
  const { d, config, now, lang, tx, sendStamps, ownerNumbers, sentTo, seenReplies, note, sendText, sendButtons } = door;
  /**
   * A WhatsApp "in the owner's name" is never sent by the server: it gives the owner a wa.me link with the words filled in, and the owner opens
   * it and presses send in their own WhatsApp. The number comes from the approved contacts, or from a full international number the owner
   * typed; the link goes to the owner only.
   */
  const prepareMessage = async (m: { to: string; text: string }): Promise<void> => {
    const friend = d.contactByName?.(m.to) ?? null;
    // A number written without its country code ("612 34 56 78") is read in the owner's country (src/region.ts): the link needs the code.
    const typed = /^\+?[\d\s().-]{8,22}$/.test(m.to.trim()) ? international(m.to) : "";
    const digits = friend ? friend.number.replace(/\D/g, "") : typed.length >= 8 && typed.length <= 15 ? typed : "";
    const label = friend ? friend.name : digits ? `+${digits}` : "";
    if (!digits) {
      await sendText(tx("unknownFriend", { to: m.to, cc: codeExample(lang()) }));
      return;
    }
    const words = m.text.slice(0, 700);
    note(tx("notePrepared", { label, owner: d.ownerName }));
    await sendText(tx("messageLink", { label, words, link: waLink(digits, words) }));
  };

  // ---------- a message from the assistant's own number to a friend ----------

  const rememberNumbers = (text: string, at: number): void => {
    for (const m of text.matchAll(/\+?\d[\d\s().-]{6,20}\d/g)) {
      const digits = withoutTrunkZero(m[0]).replace(/\D/g, "");
      if (digits.length >= 8 && digits.length <= 15) ownerNumbers.push({ digits, at });
    }
    while (ownerNumbers.length > 30) ownerNumbers.shift();
  };

  /** A friend from the approved contacts, or a full international number (+34...) the owner wrote in this chat in the last hours. */
  const resolveFriend = (to: string, at: number): { label: string; digits: string } | null => {
    const friend = d.contactByName?.(to) ?? null;
    if (friend) return { label: friend.name, digits: friend.number.replace(/\D/g, "") };
    if (!/^\+\d[\d\s().-]{6,20}$/.test(to.trim())) return null;
    const digits = withoutTrunkZero(to.trim()).replace(/\D/g, "");
    return digits.length >= 8 && digits.length <= 15 && ownerNumbers.some((n) => n.digits === digits && at - n.at < TYPED_NUMBER_MS) ? { label: `+${digits}`, digits } : null;
  };

  const sendLimit = (digits: string, at: number): string => {
    while (sendStamps.length && at - sendStamps[0]!.at > 24 * 3600_000) sendStamps.shift();
    if (sendStamps.length >= SEND_DAILY) return tx("sentToday", { n: SEND_DAILY });
    if (sendStamps.filter((x) => x.digits === digits).length >= SEND_PER_NUMBER_DAILY) return tx("sentToNumber", { n: SEND_PER_NUMBER_DAILY });
    return "";
  };

  /** What the friend reads. The server writes the first line: the message is always said to come from the owner's AI assistant. */
  const withOpening = (text: string): string => {
    // Pako's own line, English like all its fixed texts; the owner's message under it stays in whatever language it was written in.
    return `Message on behalf of ${d.ownerName}, sent by their AI assistant:\n\n${text}`;
  };

  const proposeSend = async (s: { to: string; text: string }, why = ""): Promise<void> => {
    d.booking?.take();
    if (!config.friendMessages) {
      // Off: the same words, as a link the owner sends from their own WhatsApp.
      await sendText(tx("friendMessagesOff"));
      await prepareMessage(s);
      return;
    }
    const at = now();
    const who = resolveFriend(s.to, at);
    if (!who) {
      await sendText(tx("unknownSendTo", { to: s.to, cc: codeExample(lang()) }));
      return;
    }
    const blocked = sendLimit(who.digits, at);
    if (blocked) {
      await sendText(blocked);
      return;
    }
    door.pendingSend = { id: randomBytes(5).toString("hex"), digits: who.digits, label: who.label, text: s.text, at, typed: true };
    if (door.pendingCall) door.pendingCall.typed = false;
    const card = tx("sendCard", { label: who.label, text: withOpening(s.text) });
    await sendButtons(why ? `${why}\n\n${card}` : card, `s1:${door.pendingSend.id}`, `s0:${door.pendingSend.id}`, tx("btnSend"));
  };

  const answerSend = async (p: NonNullable<typeof door.pendingSend>, yes: boolean): Promise<void> => {
    door.pendingSend = null;
    if (!yes) {
      note(tx("noteSendCancelled", { label: p.label }));
      await sendText(tx("noSend"));
      return;
    }
    await door.deliver(p);
  };

  /** A friend the assistant wrote to answers: it is passed on to the owner (what they said stays out of the assistant's context). */
  const forwardReply = async (m: Record<string, unknown>): Promise<string | null> => {
    const digits = String(m.from ?? "").replace(/\D/g, "");
    const who = digits ? sentTo.get(digits) : undefined;
    const id = typeof m.id === "string" ? m.id : "";
    if (!who || !id || now() - who.at > REPLY_FORWARD_MS) return null;
    if (seenReplies.has(id)) return "reply repeated";
    seenReplies.add(id);
    if (seenReplies.size > MAX_SEEN) seenReplies.delete(seenReplies.values().next().value!);
    const body = m.type === "text" ? String((m.text as { body?: string } | undefined)?.body ?? "").trim().slice(0, 1500) : "";
    who.at = now(); // the conversation goes on while they talk
    note(tx("noteReplied", { label: who.label, owner: d.ownerName }));
    await door.notifyOwner(body ? tx("friendReplied", { label: who.label, body }) : tx("friendRepliedOther", { label: who.label }));
    return "reply forwarded";
  };

  return { prepareMessage, rememberNumbers, resolveFriend, sendLimit, withOpening, proposeSend, answerSend, forwardReply };
}

/**
 * Numbers the owner typed, kept a while so a message to one of them can go (resolveFriend). A number in a forwarded message is someone
 * else's: never one the owner wrote (src/autonomy.ts works out the same from the words). It never answers by itself.
 */
export const onNumbers: Handler = async (door, { m, text, at }) => {
  const passedOn = m.context as { forwarded?: unknown; frequently_forwarded?: unknown } | undefined;
  if (passedOn?.forwarded !== true && passedOn?.frequently_forwarded !== true) door.rememberNumbers(text, at);
  return null;
};
