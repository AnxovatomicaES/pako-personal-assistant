// Calls to friends: the assistant's proposal, the owner's yes, and the watch on how the call went; and the table bookings' cards.

import { randomBytes } from "node:crypto";
import type { BookingReply } from "../booking.ts";
import { callWords } from "./format.ts";
import { callOutcome } from "./texts.ts";
import { CALL_ID, CALL_WATCH_POLLS } from "./shared.ts";
import type { Door, Turn } from "./door.ts";
import { createLog } from "../log.ts";

const logBooking = createLog("booking");
const logWhatsapp = createLog("whatsapp");

/**
 * Whether a booking the assistant asked for is the owner's own order, which Maître books at once: their turn, with their words known, not
 * one Pako started, and no new outside text in its context (src/quarantine.ts). A held reply (outside text) has no turn and keeps the card.
 */
export function directOrder(turn?: Turn): boolean {
  return !!turn && !turn.initiative && !turn.ownerUnknown && !turn.context?.length && turn.sources.owner.length > 0;
}

export function mountCalls(door: Door): Pick<Door, "deliverBooking" | "startBooking" | "propose" | "watchCall" | "answerCall"> {
  const { d, now, lang, tx, note, sendText, sendButtons, sendButton, sendConfirm } = door;
  // ---------- booking a table: the search and the choice (src/booking.ts); the card to approve is the only thing that makes Pako write ----------

  const deliverBooking = async (r: BookingReply): Promise<void> => {
    // A new card or list is the only thing a typed word can answer now.
    if (door.pendingCall) door.pendingCall.typed = false;
    if (door.pendingSend) door.pendingSend.typed = false;
    if (r.card) await sendButtons(r.card.body, `b1:${r.card.id}`, `b0:${r.card.id}`, r.card.yes);
    else if (r.say) await sendText(r.say);
    // A receipt with Undo (a booking Maître made), then whatever comes after this reply (the booking itself, a few seconds later).
    if (r.undo) await sendButton(r.undo.body, `bu:${r.undo.id}`, r.undo.label);
    if (r.after) await deliverBooking(await r.after());
  };
  /** The assistant's <book> tag, or the connector's book_restaurant tool: searches in the background and tells the owner what it found. */
  const startBooking = (req: { what: string; when: string; party: number; notes?: string; name?: string }, turn?: Turn): void => {
    const b = d.booking;
    if (!b) return;
    const direct = directOrder(turn);
    void (async () => {
      try {
        await deliverBooking(await b.start(req, direct ? { direct: true, owner: turn!.sources.owner } : {}));
      } catch (err) {
        logBooking.error(`${(err as Error).message}`);
        await sendText(tx("bookingFailed")).catch(() => undefined);
      }
    })();
  };

  // ---------- friend calls: proposed by the assistant, confirmed by a button ----------

  /** `why`: the line that says why it asks (src/autonomy.ts), above the read-back; the read-back itself is what the call will say. */
  const propose = async (call: { name: string; message: string; direct?: boolean }, why = ""): Promise<void> => {
    d.booking?.take(); // a new proposal is the only thing a typed word can answer now
    // One text for the card and the call, as for the connector's cards (if nothing would be left, the words are kept as they were).
    const message = callWords(call.message, d.ownerName, false);
    const a = await d.tools.run({ callId: CALL_ID, tool: "call_contact", args: { name: call.name, message, direct: call.direct === true }, trusted: true, now: now() });
    if (!a.verbatim) {
      await sendText(tx("callNotReady", { why: a.say }));
      return;
    }
    door.pendingCall = { id: randomBytes(5).toString("hex"), name: call.name, readback: a.say, at: now(), typed: true };
    if (door.pendingSend) door.pendingSend.typed = false;
    await sendConfirm(why ? `${why}\n\n${a.say}` : a.say, door.pendingCall.id);
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    });
  const watching = new Set<string>();
  /** Looks up a placed call until it has ended, then tells the owner how it went and keeps a line about it for the assistant. */
  const watchCall = (placed: { name: string; callId: string }): void => {
    if (watching.size >= 3 || watching.has(placed.callId)) return;
    watching.add(placed.callId);
    void (async () => {
      try {
        for (let i = 0; i < CALL_WATCH_POLLS; i++) {
          await sleep(d.callCheckMs ?? 20_000);
          let info: Record<string, unknown> | null = null;
          try {
            const a = await d.tools.run({ callId: CALL_ID, tool: "check_call", args: { call_id: placed.callId }, trusted: true, now: now() });
            const parsed: unknown = JSON.parse(a.say);
            if (parsed && typeof parsed === "object") info = parsed as Record<string, unknown>;
          } catch { // not ready, or the lookup failed: ask again
            info = null;
          }
          const status = String(info?.call_status ?? "");
          if (!info || !["ended", "error", "not_connected"].includes(status)) continue;
          const said = callOutcome(placed.name, info, lang());
          const summary = typeof info.summary === "string" ? info.summary.replace(/\s+/g, " ").trim().slice(0, 300) : "";
          note(tx("noteCallEnded", { name: placed.name, said, summary: summary ? tx("noteCallSummary", { summary }) : "" }), !!summary);
          await sendText(said);
          return;
        }
        note(tx("noteCallUnchecked", { name: placed.name }));
        await sendText(tx("callUnchecked", { name: placed.name }));
      } catch (err) {
        logWhatsapp.error(`could not report on a call: ${(err as Error).message}`);
      } finally {
        watching.delete(placed.callId);
      }
    })();
  };

  /** The owner's answer to the proposed call, from a button or typed: true places it, false drops it. The tools decide, from the owner's own words. */
  const answerCall = async (p: NonNullable<typeof door.pendingCall>, yes: boolean, said: string): Promise<void> => {
    door.pendingCall = null;
    // Even a no goes through here, so the staged call is used up either way.
    const a = await d.tools.run({ callId: CALL_ID, tool: "confirm_call", args: {}, readbackText: p.readback, answerText: yes ? said : "no", trusted: true, now: now() });
    if (!yes) note(tx("noteCallCancelled", { name: p.name }));
    else if (a.placed) note(tx("noteCallPlaced", { name: a.placed.name }));
    else note(tx(a.unknown ? "noteCallUnknown" : a.simulated ? "noteCallSimulated" : "noteCallFailed", { name: p.name }));
    await sendText(yes ? a.say : tx("noCall"));
    if (yes && a.placed) watchCall(a.placed);
  };

  return { deliverBooking, startBooking, propose, watchCall, answerCall };
}
