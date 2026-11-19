// The calls, messages and emails the assistant asks for, decided by the autonomy settings: done, held, or put to the owner as a card.

import { randomBytes } from "node:crypto";
import { bodyOrigin, decide, isAddress, isNumber, matchContacts } from "../autonomy.ts";
import { callWords } from "./format.ts";
import { addressOf } from "../mail.ts";
import { senderName } from "../mail-categories.ts";
import { PENDING_CALL_MS, CALL_ID } from "./shared.ts";
import type { Turn, Door } from "./door.ts";

export function mountActions(door: Door): Pick<Door, "choices" | "emailCards" | "callAuto" | "sendAuto" | "emailAuto" | "offerDraftSend"> {
  const {
    d, config, now, tx, idGraph, graph, sendText, sendButtons, propose, resolveFriend, sendLimit, proposeSend, at, chosen, originOf, effective,
    asked, holdAction,
  } = door;
  /** Ambiguous names ("Ana" with two Anas): a card with one button per contact; more than two are asked in words. In memory only. */
  const choices = new Map<string, { at: number; names: string[]; go: (name: string) => Promise<void> }>();
  const askWhich = async (to: string, names: string[], go: (name: string) => Promise<void>): Promise<void> => {
    if (names.length > 2) {
      await sendText(at("whichMany", { to, names: names.slice(0, 6).join(", ") }));
      return;
    }
    for (const [k, c] of choices) if (now() - c.at >= PENDING_CALL_MS) choices.delete(k);
    while (choices.size >= 10) choices.delete(choices.keys().next().value!);
    const id = randomBytes(5).toString("hex");
    choices.set(id, { at: now(), names, go });
    if (door.pendingCall) door.pendingCall.typed = false;
    if (door.pendingSend) door.pendingSend.typed = false;
    const buttons = [...names.map((n, i) => ({ type: "reply", reply: { id: `w${i}:${id}`, title: n.slice(0, 20) } })), { type: "reply", reply: { id: `wx:${id}`, title: tx("btnCancel") } }];
    await graph({ type: "interactive", interactive: { type: "button", body: { text: at("which", { to }) }, action: { buttons } } });
  };

  /** An email waiting for the owner's press, by its card's id. In memory only: after a restart the card says it is gone. */
  const emailCards = new Map<string, { at: number; label: string; target: string; subject: string; text: string }>();
  const proposeEmail = async (e: { label: string; target: string; subject: string; text: string }, why: string): Promise<void> => {
    for (const [k, c] of emailCards) if (now() - c.at >= PENDING_CALL_MS) emailCards.delete(k);
    while (emailCards.size >= 10) emailCards.delete(emailCards.keys().next().value!);
    const id = randomBytes(5).toString("hex");
    emailCards.set(id, { at: now(), ...e });
    if (door.pendingCall) door.pendingCall.typed = false;
    if (door.pendingSend) door.pendingSend.typed = false;
    const card = at("emailCard", { to: e.label, address: e.target, subject: e.subject, text: e.text.slice(0, 600) });
    await sendButtons(why ? `${why}\n\n${card}` : card, `e1:${id}`, `e0:${id}`, at("emailYes"));
  };

  /** The assistant's <call>: direct with a window to undo when the policy allows, otherwise the card (now saying why). */
  const callAuto = async (call: { name: string; message: string; direct: boolean }, turn: Turn): Promise<void> => {
    const found = matchContacts(call.name, d.contacts().map((name) => ({ name })), idGraph.trustedNames);
    if (found.length > 1) {
      await askWhich(call.name, found.map((c) => c.name), (name) => callAuto({ ...call, name }, chosen(turn, call.name)));
      return;
    }
    if (!found.length) {
      await propose(call); // the tools say who is in the contacts
      return;
    }
    const name = found[0]!.name;
    const eff = await effective("call");
    const dec = decide({
      type: "call",
      args: [{ role: "recipient", origin: originOf(call.name, turn) }, { role: "body", origin: bodyOrigin(call.message, turn.sources) }],
      initiative: turn.initiative, ownerUnknown: turn.ownerUnknown, mode: eff.mode, context: turn.context,
    });
    if (dec.mode === "confirm") {
      await propose({ ...call, name }, asked(dec, "call", name));
      return;
    }
    // Checked now, so the receipt never promises a call the tools would refuse (an unknown contact, no words).
    const message = callWords(call.message, d.ownerName, false);
    const check = await d.tools.run({ callId: CALL_ID, tool: "call_contact", args: { name, message, direct: call.direct === true }, trusted: true, now: now() });
    if (!check.verbatim) {
      await sendText(tx("callNotReady", { why: check.say }));
      return;
    }
    await holdAction({ type: "call", label: name, target: name, text: message, ...(call.direct ? { direct: true } : {}) }, eff.seconds, turn.key);
  };

  /** The assistant's <send> (a WhatsApp from Pako's own number, when WHATSAPP_FRIEND_MESSAGES is on): the same policy. */
  const sendAuto = async (s: { to: string; text: string }, turn: Turn): Promise<void> => {
    if (!config.friendMessages) {
      await proposeSend(s);
      return;
    }
    const found = isNumber(s.to) ? [] : matchContacts(s.to, d.contacts().map((name) => ({ name })), idGraph.trustedNames);
    if (found.length > 1) {
      await askWhich(s.to, found.map((c) => c.name), (name) => sendAuto({ ...s, to: name }, chosen(turn, s.to)));
      return;
    }
    const to = found[0]?.name ?? s.to;
    const who = resolveFriend(to, now());
    const blocked = who ? sendLimit(who.digits, now()) : "";
    if (!who || blocked) {
      await proposeSend({ ...s, to }); // says who is unknown, or the day's limit
      return;
    }
    const eff = await effective("message");
    const dec = decide({
      type: "message",
      args: [{ role: isNumber(s.to) ? "number" : "recipient", origin: originOf(s.to, turn) }, { role: "body", origin: bodyOrigin(s.text, turn.sources) }],
      initiative: turn.initiative, ownerUnknown: turn.ownerUnknown, mode: eff.mode, context: turn.context,
    });
    if (dec.mode === "confirm") {
      await proposeSend({ ...s, to }, asked(dec, "message", who.label));
      return;
    }
    await holdAction({ type: "message", label: who.label, target: who.digits, text: s.text }, eff.seconds, turn.key);
  };

  /**
   * The assistant's <email>: to a name in the contact book's addresses (PERSONAL_CONTACT_EMAILS) or an address. Without the turn (a held
   * reply the owner pressed Do it on, an older path) always the card.
   */
  const emailAuto = async (e: { to: string; subject: string; text: string }, turn: Turn | null): Promise<void> => {
    if (!d.sendEmail) {
      await sendText(at("emailOff"));
      return;
    }
    const book = d.contactEmails?.() ?? [];
    let label: string;
    let target: string;
    const typed = isAddress(e.to);
    if (typed) {
      target = e.to.trim();
      label = book.find((c) => c.address.toLowerCase() === target.toLowerCase())?.name ?? target;
    } else {
      const found = matchContacts(e.to, book, idGraph.trustedNames);
      if (!found.length) {
        await sendText(at("emailNoAddress", { to: e.to }));
        return;
      }
      if (found.length > 1) {
        await askWhich(e.to, found.map((c) => c.name), (name) => emailAuto({ ...e, to: name }, turn && chosen(turn, e.to)));
        return;
      }
      label = found[0]!.name;
      target = found[0]!.address;
    }
    const subject = e.subject || at("subject", { owner: d.ownerName });
    if (!turn) {
      await proposeEmail({ label, target, subject, text: e.text }, "");
      return;
    }
    const eff = await effective("email");
    const dec = decide({
      type: "email",
      args: [
        { role: typed ? "address" : "recipient", origin: originOf(e.to, turn) },
        { role: "body", origin: bodyOrigin(`${e.subject} ${e.text}`, turn.sources) },
      ],
      initiative: turn.initiative, ownerUnknown: turn.ownerUnknown, mode: eff.mode, context: turn.context,
    });
    if (dec.mode === "confirm") {
      await proposeEmail({ label, target, subject, text: e.text }, asked(dec, "email", label));
      return;
    }
    await holdAction({ type: "email", label, target, subject, text: e.text }, eff.seconds, turn.key);
  };

  /**
   * A draft written for a follow-up that came from an email (src/brief-v2.ts offerSend): the same card as any email Pako would send, to the
   * email's sender, as a reply, with the draft's message (its first line, which says where it goes, left out). Nothing goes before the press.
   */
  const offerDraftSend = async (o: { from: string; subject: string; title: string; text: string }): Promise<void> => {
    if (!d.sendEmail) return;
    const target = addressOf(o.from);
    if (!isAddress(target)) return;
    const lines = o.text.split("\n");
    const body = (lines.length > 1 ? lines.slice(1) : lines).join("\n").trim();
    if (!body) return;
    const subject = /^re:/i.test(o.subject.trim()) ? o.subject.trim() : `Re: ${o.subject.trim()}`.slice(0, 150);
    await proposeEmail({ label: senderName(o.from), target, subject, text: body }, at("draftSendWhy", { title: o.title }));
  };

  return { choices, emailCards, callAuto, sendAuto, emailAuto, offerDraftSend };
}
