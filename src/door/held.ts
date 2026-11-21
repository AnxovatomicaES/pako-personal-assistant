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
  /** False when it certainly did not go (no mail, the day's maximum, a refusal): the owner was told why. */
  const sendMailNow = async (e: { label: string; target: string; subject?: string; text: string }, id: string): Promise<boolean> => {
    if (!d.sendEmail) {
      await sendText(at("emailOff"));
      return false;
    }
    const t = now();
    while (emailStamps.length && t - emailStamps[0]! > 24 * 3600_000) emailStamps.shift();
    if (emailStamps.length >= EMAIL_DAILY) {
      await sendText(at("emailToday", { n: EMAIL_DAILY }));
      return false;
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
      const refused = status >= 400 && status < 500;
      await sendText(refused ? at("emailFailed", { to: e.label, why: reason, address: e.target }) : at("emailUnknown", { to: e.label }));
      return !refused;
    }
    emailStamps.push(t);
    d.control?.log("mail", at("sentEmail", { to: e.label, text: shortText(e.text) }));
    note(at("sentEmail", { to: e.label, text: shortText(e.text) }));
    await sendText(at("sentEmail", { to: e.label, text: shortText(e.text) }));
    return true;
  };
  /**
   * A held action whose window is over: it goes now (unless Pako is paused). Called once per action (src/autonomy.ts). False when it
   * certainly did not go.
   */
  const runHeld = async (a: HeldAction): Promise<boolean> => {
    const pause = d.control ? await d.control.state() : null;
    if (pause && pause.paused !== null) {
      await sendText(at("paused", { what: whatOf(a.type), to: a.label }));
      return false;
    }
    if (a.type === "message") return deliver({ digits: a.target, label: a.label, text: a.text });
    if (a.type === "email") return sendMailNow(a, a.id);
    // A call: staged and confirmed in one go, the owner's own words being the yes (the same tools as the card's Call).
    const staged = await d.tools.run({ callId: CALL_ID, tool: "call_contact", args: { name: a.target, message: a.text, direct: a.direct === true }, trusted: true, now: now() });
    if (!staged.verbatim) {
      await sendText(tx("callNotReady", { why: staged.say }));
      return false;
    }
    const r = await d.tools.run({ callId: CALL_ID, tool: "confirm_call", args: {}, readbackText: staged.say, answerText: "yes", trusted: true, now: now() });
    if (r.placed) note(tx("noteCallPlaced", { name: r.placed.name }));
    else note(tx(r.unknown ? "noteCallUnknown" : r.simulated ? "noteCallSimulated" : "noteCallFailed", { name: a.label }));
    await sendText(r.say);
    if (r.placed) watchCall(r.placed);
    return !!r.placed || r.unknown === true;
  };
  /** A chase's email that did not go (undone, refused, paused, stale): no longer kept as sent on its follow-up, so its card works again. */
  const unsent = async (a: { chase?: HeldAction["chase"] }): Promise<void> => {
    if (!a.chase || !d.followups?.chaseUnsent) return;
    await d.followups.chaseUnsent(a.chase).catch((err: Error) => log.error(`a chase that did not go is still kept as sent: ${err.message}`));
  };
  const heldQueue: HeldQueue = createHeldQueue({
    kv: d.kv,
    now,
    ...(d.autonomy?.delay ? { delay: d.autonomy.delay } : {}),
    run: async (a) => {
      let went = true;
      await inChat(a.route, async () => void (went = await runHeld(a)));
      if (!went) await unsent(a);
      return went;
    },
    tell: async (a, kind) => {
      if (kind === "stale") await unsent(a);
      await inChat(a.route, async () => void (await sendText(at(kind, { what: whatOf(a.type), to: a.label }))));
    },
  });
  void heldQueue.start();
  /** Holds it for its window, with the receipt and its Undo. False when it could not be kept (then nothing goes). */
  const holdAction = async (
    input: { type: HeldType; label: string; target: string; text: string; subject?: string; direct?: boolean; chase?: HeldAction["chase"] },
    seconds: number, key: string,
  ): Promise<void> => {
    const id = heldId(key, input.type);
    // Asked while paused: refused now, not held. Held, it would go by itself after a RESUME within its window.
    const pause = d.control ? await d.control.state() : null;
    if (pause && pause.paused !== null) {
      d.control?.log("autonomy", at("paused", { what: whatOf(input.type), to: input.label }));
      await unsent(input);
      await sendText(at("paused", { what: whatOf(input.type), to: input.label }));
      return;
    }
    const t = now();
    let fresh: boolean;
    try {
      fresh = await heldQueue.hold({ ...input, id, route: via.getStore() ?? null, at: t, due: t + seconds * 1000 });
    } catch (err) {
      log.error(`could not keep a held ${input.type}: ${(err as Error).message}`);
      await unsent(input);
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
      await unsent(r.action);
      // Stopped before it went: a lesson for the next drafts and actions (src/lessons.ts), from the action Pako itself held.
      void d.lessons?.undone({ what: r.action.type, title: shortText(r.action.text), who: r.action.label })
        .catch((err: Error) => log.error(`a stopped ${r.action?.type ?? "action"} could not be kept as a lesson: ${err.message}`));
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

  // STOP takes back everything held (src/door/stop-resume.ts): a chase among them did not go either.
  const queue: HeldQueue = {
    ...heldQueue,
    cancelAll: async () => {
      const gone = await heldQueue.cancelAll();
      for (const a of gone) await unsent(a);
      return gone;
    },
  };
  return { heldQueue: queue, holdAction, undoLatestHeld, pressedAutonomy };
}
