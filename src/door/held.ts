// Actions held in their window to undo: a message, an email or a call that goes out by itself unless the owner presses Undo.

import { autonomyText, createHeldQueue, heldId, type HeldAction, type HeldQueue, type HeldType } from "../autonomy.ts";
import { PENDING_CALL_MS, CALL_ID, EMAIL_DAILY } from "./shared.ts";
import type { Door } from "./door.ts";
import { createLog } from "../log.ts";

const log = createLog("autonomy");

export function mountHeld(door: Door): Pick<Door, "heldQueue" | "holdAction" | "undoLatestHeld" | "pressedAutonomy"> {
  const { d, now, tx, note, via, sendText, sendButton, deliver, watchCall, at, whatOf, shortText, inChat } = door;
  const emailStamps: number[] = [];
  /** Sends an email from Pako's own inbox, opened by a line that says it is the owner's AI assistant writing. */
  const sendMailNow = async (e: { label: string; target: string; subject?: string; text: string }, id: string): Promise<void> => {
    if (!d.sendEmail) {
      await sendText(at("emailOff"));
      return;
    }
    const t = now();
    while (emailStamps.length && t - emailStamps[0]! > 24 * 3600_000) emailStamps.shift();
    if (emailStamps.length >= EMAIL_DAILY) {
      await sendText(at("emailToday", { n: EMAIL_DAILY }));
      return;
    }
    // The subject and the opening line are Pako's own words, English; the owner's text under them stays as written.
    const theirs = autonomyText("en");
    const subject = e.subject || theirs("subject", { owner: d.ownerName });
    try {
      // The id makes a retried send the same send at Resend (its Idempotency-Key): the same email never goes twice.
      await d.sendEmail({ to: e.target, subject, text: theirs("opening", { owner: d.ownerName, text: e.text }), idempotencyKey: `pako-email-${id}` });
    } catch (err) {
      const status = Number((err as { status?: unknown }).status) || 0;
      log.error(`an email was not sent: ${(err as Error).message}`);
      d.control?.log("failure", `${whatOf("email")} → ${e.label}: ${status || "?"}`);
      // A refusal certainly did not send; anything else may have, and is never sent again.
      // The service's own reason (Resend says which domain is not verified, which address it refused), else the status.
      const why = String((err as { why?: unknown }).why ?? "").trim().replace(/[.\s]+$/, "");
      const reason = why ? `HTTP ${status}: ${why}` : `HTTP ${status}`;
      await sendText(status >= 400 && status < 500 ? at("emailFailed", { to: e.label, why: reason, address: e.target }) : at("emailUnknown", { to: e.label }));
      return;
    }
    emailStamps.push(t);
    d.control?.log("mail", at("sentEmail", { to: e.label, text: shortText(e.text) }));
    note(at("sentEmail", { to: e.label, text: shortText(e.text) }));
    await sendText(at("sentEmail", { to: e.label, text: shortText(e.text) }));
  };
  /** A held action whose window is over: it goes now (unless Pako is paused). Called once per action (src/autonomy.ts). */
  const runHeld = async (a: HeldAction): Promise<void> => {
    const pause = d.control ? await d.control.state() : null;
    if (pause && pause.paused !== null) {
      await sendText(at("paused", { what: whatOf(a.type), to: a.label }));
      return;
    }
    if (a.type === "message") {
      await deliver({ digits: a.target, label: a.label, text: a.text });
      return;
    }
    if (a.type === "email") {
      await sendMailNow(a, a.id);
      return;
    }
    // A call: staged and confirmed in one go, the owner's own words being the yes (the same tools as the card's Call).
    const staged = await d.tools.run({ callId: CALL_ID, tool: "call_contact", args: { name: a.target, message: a.text, direct: a.direct === true }, trusted: true, now: now() });
    if (!staged.verbatim) {
      await sendText(tx("callNotReady", { why: staged.say }));
      return;
    }
    const r = await d.tools.run({ callId: CALL_ID, tool: "confirm_call", args: {}, readbackText: staged.say, answerText: "yes", trusted: true, now: now() });
    if (r.placed) note(tx("noteCallPlaced", { name: r.placed.name }));
    else note(tx(r.unknown ? "noteCallUnknown" : r.simulated ? "noteCallSimulated" : "noteCallFailed", { name: a.label }));
    await sendText(r.say);
    if (r.placed) watchCall(r.placed);
  };
  const heldQueue: HeldQueue = createHeldQueue({
    kv: d.kv,
    now,
    ...(d.autonomy?.delay ? { delay: d.autonomy.delay } : {}),
    run: (a) => inChat(a.route, () => runHeld(a)),
    tell: (a, kind) => inChat(a.route, async () => void (await sendText(at(kind, { what: whatOf(a.type), to: a.label })))),
  });
  void heldQueue.start();
  /** Holds it for its window, with the receipt and its Undo. False when it could not be kept (then nothing goes). */
  const holdAction = async (
    input: { type: HeldType; label: string; target: string; text: string; subject?: string; direct?: boolean }, seconds: number, key: string,
  ): Promise<void> => {
    const id = heldId(key, input.type);
    const t = now();
    let fresh: boolean;
    try {
      fresh = await heldQueue.hold({ ...input, id, route: via.getStore() ?? null, at: t, due: t + seconds * 1000 });
    } catch (err) {
      log.error(`could not keep a held ${input.type}: ${(err as Error).message}`);
      await sendText(tx("reminderUnsaved"));
      return;
    }
    if (!fresh) return; // the same answer, sent again: held once, told once
    d.control?.log("autonomy", at("logHeld", { s: seconds, what: whatOf(input.type), to: input.label }));
    const key2 = input.type === "email" ? "holdEmail" : input.type === "call" ? "holdCall" : "holdMessage";
    await sendButton(at(key2, { to: input.label, s: seconds, text: shortText(input.text) }), `a0:${id}`, at("undoBtn"));
  };
  /** The typed UNDO while something is still in its window: the latest one is taken back. */
  const undoLatestHeld = async (): Promise<boolean> => {
    const list = await heldQueue.list().catch(() => [] as HeldAction[]);
    const last = list.filter((a) => a.state === "held").at(-1);
    if (!last) return false;
    await undoHeld(last.id);
    return true;
  };
  const undoHeld = async (id: string): Promise<void> => {
    const r = await heldQueue.undo(id).catch(() => ({ status: "gone" as const, action: undefined }));
    if (r.status === "undone" && r.action) {
      d.control?.log("autonomy", at("logUndone", { what: whatOf(r.action.type), to: r.action.label }));
      await sendText(at("undone"));
      return;
    }
    await sendText(at(r.status === "too-late" ? "tooLate" : "gone"));
  };

  /** Undo (a0), an email card (e1 / e0), a name from an ambiguous card (w0, w1, wx). */
  const pressedAutonomy = async (kind: string, id: string): Promise<void> => {
    if (kind === "a0") {
      await undoHeld(id);
      return;
    }
    if (kind.startsWith("e")) {
      const c = door.emailCards.get(id);
      door.emailCards.delete(id); // taken before anything waits: a second press finds it gone
      if (!c || now() - c.at >= PENDING_CALL_MS) {
        await sendText(tx("expired"));
        return;
      }
      if (kind === "e0") {
        await sendText(at("emailNo"));
        return;
      }
      const pause = d.control ? await d.control.state() : null;
      if (pause && pause.paused !== null) {
        await sendText(at("paused", { what: whatOf("email"), to: c.label }));
        return;
      }
      await sendMailNow(c, `card-${id}`);
      return;
    }
    const c = door.choices.get(id);
    door.choices.delete(id);
    if (!c || now() - c.at >= PENDING_CALL_MS) {
      await sendText(tx("expired"));
      return;
    }
    const name = kind === "wx" ? undefined : c.names[Number(kind.slice(1))];
    if (!name) {
      await sendText(at("emailNo"));
      return;
    }
    await c.go(name);
  };

  return { heldQueue, holdAction, undoLatestHeld, pressedAutonomy };
}
