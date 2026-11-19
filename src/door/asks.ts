// The connector's asks for a call (src/personal-caller.ts): one card per friend, renewed, replaced or annulled, and the owner's answer.

import { randomBytes } from "node:crypto";
import { PAUSED_WHY_EN } from "../control.ts";
import { friendCallAnswer } from "../voice-tools.ts";
import type { OwnerAsk, OwnerChannel, AskResult } from "./deps.ts";
import { PENDING_CALL_MS } from "./shared.ts";
import type { Door } from "./door.ts";

export function mountAsks(door: Door): Pick<Door, "askCall" | "answerAsk"> {
  const {
    d, now, lang, tx, connectorCards, cardEnds, endCard, sweepCards, note, hhmm, via, startedRoute, ownStart, reachable, placeName, sendText,
    sendButtons, watchCall,
  } = door;
  /**
   * The connector's call_contact: the owner's card. The other cards are not touched (an older connector card for the same friend aside, which
   * this one replaces), except that no typed word can answer them any more: the newest card on screen is this one, and it takes no typed
   * answer, so a "yes" written now is not about them.
   */
  const askCall = async (ask: OwnerAsk): Promise<AskResult> => {
    const stopsBefore = door.stops; // before anything waits: a STOP from here on ends this card too
    const pause = d.control ? await d.control.state() : null;
    // Why, as it is: a pause Pako set by itself (its store) is not the owner's STOP.
    if (pause && pause.paused !== null) return { ok: false, why: PAUSED_WHY_EN[pause.why ?? "owner"] };
    // Outside WhatsApp's 24-hour window Meta takes the card and then drops it: it would be reported as shown and never arrive (Telegram has no such window).
    if (!(await reachable(now()))) {
      return {
        ok: false,
        why: "The owner has not written to Pako on WhatsApp for about a day (WhatsApp's 24-hour window, less half an hour to be safe), and until "
          + "they do WhatsApp lets Pako write first only with an approved template: the card would not arrive. Ask them to send Pako any message "
          + `on WhatsApp, then try again.${d.telegram ? " (With Telegram connected, which they do by writing TELEGRAM to Pako, this does not happen.)" : ""}`,
      };
    }
    const route = await startedRoute();
    if (door.stops !== stopsBefore) return { ok: false, why: "Pako is paused (STOP)." };
    sweepCards();
    const id = randomBytes(5).toString("hex");
    const card = { seq: ++door.cardSeq, at: now(), ask, shown: false };
    connectorCards.set(id, card);
    const shownOn: { on?: OwnerChannel } = {};
    const sent = await ownStart.run(true, () => via.run(route, () => sendButtons(ask.card, `k1:${id}`, `k0:${id}`, tx("btnCall"), shownOn)));
    if (connectorCards.get(id) !== card) {
      // Something answered or ended it while it was being sent: the owner pressed it already (a quick thumb), a STOP came, or a newer card for
      // the same friend took its place.
      const ended = cardEnds.get(id);
      if (ended === "answered" || ended === "renewed") {
        // It was on screen and answered (or answered too soon, and a fresh card took over): it still replaces an older card for the same
        // friend, and still ends typed answers to older cards.
        card.shown = true;
        shownNow(card, "answered");
        return { ok: true, where: placeName(shownOn.on ?? route) };
      }
      if (ended === "replaced") return { ok: false, why: `A newer request for ${ask.name} took this card's place while it was being sent: nothing will be called for this one.` };
      return { ok: false, why: "The owner wrote STOP while the card was being sent: it counts for nothing, and nothing will be called." };
    }
    if (!sent) {
      connectorCards.delete(id);
      return { ok: false, why: d.local ? "The panel's chat could not show the card." : "WhatsApp did not take the card (the server's log says why)." };
    }
    card.shown = true;
    // Two requests for the same friend whose cards were sent at the same time: the one asked for later counts, the other is replaced.
    const newer = [...connectorCards.values()].some((c) => c !== card && c.shown && c.ask.name === ask.name && c.seq > card.seq);
    if (newer) {
      connectorCards.delete(id);
      endCard(id, "replaced");
      ask.closed("replaced");
      return { ok: false, why: `A newer request for ${ask.name} took this card's place while it was being sent: nothing will be called for this one.` };
    }
    shownNow(card, "new");
    return { ok: true, where: placeName(shownOn.on ?? route) };
  };

  /**
   * A connector card is on the owner's screen: older shown cards for the same friend stop counting, and no older card takes a typed answer.
   * `mode`: a new card (the assistant's context is told it waits for a press), one answered while it was being sent, or a renewed one.
   */
  const shownNow = (card: { seq: number; at: number; ask: OwnerAsk; shown: boolean }, mode: "new" | "answered" | "renewed"): void => {
    let replaced = false;
    for (const [other, c] of connectorCards) {
      // Only older requests: a fresh card after a wait carries its request's own number, and must not be taken for an older one.
      if (c === card || !c.shown || c.ask.name !== card.ask.name || c.seq >= card.seq) continue;
      connectorCards.delete(other);
      endCard(other, "replaced");
      c.ask.closed("replaced");
      replaced = true;
    }
    if (door.pendingCall) door.pendingCall.typed = false;
    if (door.pendingSend) door.pendingSend.typed = false;
    d.booking?.take();
    const instead = replaced ? tx("noteOlderCard") : "";
    if (mode === "new") note(tx("noteAsked", { name: card.ask.name, instead, until: hhmm(card.at + PENDING_CALL_MS) }));
    else if (mode === "answered" && replaced) note(tx("noteNewerAnswered", { name: card.ask.name }));
  };

  /** The owner's press on a connector's card, already taken out of the waiting ones: Call places exactly that call, Cancel drops it. */
  const answerAsk = async (id: string, c: { seq: number; at: number; ask: OwnerAsk; shown: boolean }, yes: boolean): Promise<void> => {
    const name = c.ask.name;
    if (!yes) {
      c.ask.closed("cancelled");
      note(tx("noteAskCancelled", { name }));
      await sendText(tx("noCall"));
      return;
    }
    let r: { ok: boolean; text: string; unknown?: boolean; wait?: number; gap?: number };
    try {
      r = await c.ask.place();
    } catch (err) {
      r = { ok: false, text: (err as Error).message };
    }
    if (r.wait) {
      // Too soon after another friend call ("llama a Ana y a Luis"). The request still waits for this owner's press, on a fresh card: the
      // panel's chat turns a pressed card's buttons off, and a fresh card has its full minutes again (the phone line restarted its clock too).
      // It keeps the request's place in line: a newer request for the same friend, already on screen, wins.
      const newer = (): boolean => [...connectorCards.values()].some((x) => x.shown && x.ask.name === name && x.seq > c.seq);
      if (newer()) {
        endCard(id, "replaced");
        c.ask.closed("replaced");
        await sendText(tx("newerCard", { name }));
        return;
      }
      endCard(id, "renewed");
      const fresh = { seq: c.seq, at: now(), ask: c.ask, shown: false };
      const freshId = randomBytes(5).toString("hex");
      connectorCards.set(freshId, fresh);
      await sendText(tx("waitThenPress", { s: r.wait }));
      const sent = await sendButtons(c.ask.card, `k1:${freshId}`, `k0:${freshId}`, tx("btnCall"));
      if (connectorCards.get(freshId) !== fresh) return; // answered or ended while it was being sent
      if (!sent) {
        connectorCards.delete(freshId);
        endCard(id, "lost");
        c.ask.closed("unshown");
        await sendText(tx("cardNotShown", { name }));
        return;
      }
      fresh.shown = true;
      if (newer()) {
        // A newer request for the same friend reached the screen while this card was on its way: it wins.
        connectorCards.delete(freshId);
        endCard(freshId, "replaced");
        c.ask.closed("replaced");
        return;
      }
      shownNow(fresh, "renewed");
      return;
    }
    const a = friendCallAnswer(r, name, lang());
    note(tx(a.placed ? "noteAskPlaced" : a.unknown ? "noteAskUnknown" : a.simulated ? "noteAskSimulated" : "noteAskFailed", { name }));
    await sendText(a.say);
    if (a.placed) watchCall(a.placed);
  };

  return { askCall, answerAsk };
}
