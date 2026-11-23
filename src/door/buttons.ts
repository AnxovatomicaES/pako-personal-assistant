// What each button press means: the owner's answer to a card, routed by the button's id.

import { AUDIT_BUTTON } from "../beta-audit.ts";
import { CLAUDE_BUTTON } from "../claude-connect.ts";
import { pausedText } from "../control.ts";
import { isAddress } from "../autonomy.ts";
import { FOLLOWUP_BUTTON } from "../followups.ts";
import { CHASE_BUTTON } from "../followups/chase.ts";
import type { PressButton } from "../followups/types.ts";
import { CHECKIN_BUTTON, CHECKIN_LOOP_BUTTON } from "../gentle-checkins.ts";
import { RESET_BUTTON } from "../gentle-reset.ts";
import { PROACTIVE_BUTTON } from "../proactive.ts";
import { AFTER_BUTTON } from "../after-meeting.ts";
import { SHUTDOWN_BUTTON } from "../shutdown.ts";
import { TIME_BUTTON } from "../time-to-do.ts";
import { PENDING_CALL_MS, cut } from "./shared.ts";
import { CALENDAR_BUTTON } from "./calendar-cards.ts";
import type { Door } from "./door.ts";

export function mountButtons(door: Door): Pick<Door, "pressed" | "NO" | "SEND_YES"> {
  const { d, now, lang, tx, connectorCards, cardEnds, endCard, note, sendText, answerAsk, answerSend, answerCall, pressedAutonomy } = door;
  /** `by`: the press's own message id (an undo remembers it, so the same press delivered again cannot undo twice). */
  const pressed = async (buttonId: string, by = ""): Promise<void> => {
    const cal = CALENDAR_BUTTON.exec(buttonId);
    if (cal) {
      await door.pressedCalendar(cal[1] === "1", cal[2]!);
      return;
    }
    const undo = /^u1:([0-9a-f]{10})$/.exec(buttonId);
    if (undo) {
      await door.undoNow({ id: undo[1]! }, by);
      return;
    }
    if (CLAUDE_BUTTON.test(buttonId)) {
      await sendText(d.claudeSignIn ? await d.claudeSignIn() : tx("expired"));
      return;
    }
    const thumbs = d.quality ? await d.quality.press(buttonId) : null;
    if (thumbs !== null) {
      await sendText(thumbs);
      return;
    }
    const pr = PROACTIVE_BUTTON.exec(buttonId);
    if (pr) {
      await sendText(d.life ? await d.life.press(pr[1] as "1" | "2" | "3", pr[2]!) : tx("expired"));
      return;
    }
    const same = /^n([01]):([0-9a-f]{10})$/.exec(buttonId);
    if (same) {
      await sendText(await door.answerSame(same[2]!, same[1] === "1"));
      return;
    }
    const fu = FOLLOWUP_BUTTON.exec(buttonId);
    if (fu) {
      // Gentle mode's Snooze asks when, on a card of its own (Later today, Tomorrow).
      const ask = fu[1] === "4" && d.followups?.snoozeCard ? await d.followups.snoozeCard(fu[2]!).catch(() => null) : null;
      if (ask) {
        // And a check-in (src/gentle-checkins.ts) as its third: "Check in 30 min", for when the owner is about to start.
        const ck = d.gentle?.checkinButton ? await d.gentle.checkinButton(fu[2]!).catch(() => null) : null;
        const buttons = [...ask.buttons, ...(ck ? [ck] : [])].map((b) => ({ type: "reply", reply: { id: b.id, title: cut(b.title, 20) } }));
        if (await door.graph({ type: "interactive", interactive: { type: "button", body: { text: ask.body }, action: { buttons } } })) return;
      }
      await sendText(d.followups ? await d.followups.press(fu[1] as PressButton, fu[2]!) : tx("expired"));
      return;
    }
    // Time to do it (src/time-to-do.ts): Block (the owner's yes to the focus block), Another time, Not needed.
    const ttd = TIME_BUTTON.exec(buttonId);
    if (ttd) {
      const say = !d.timeToDo ? tx("expired")
        : ttd[1] === "f" ? (d.timeToDo.findTimeFor ? await d.timeToDo.findTimeFor(ttd[2]!) : tx("expired"))
        : await d.timeToDo.pressed(ttd[1] as "b" | "a" | "n", ttd[2]!);
      if (say) await sendText(say);
      return;
    }
    // The evening wrap-up (src/shutdown.ts): Plan <n> (time-to-do's own card, whose Block is the yes) and Done <n>.
    const sd = SHUTDOWN_BUTTON.exec(buttonId);
    if (sd) {
      const say = d.shutdown ? await d.shutdown.pressed(sd[1] as "p" | "d", Number(sd[2]), sd[3]!) : tx("expired");
      if (say) await sendText(say);
      return;
    }
    // The question after a meeting (src/after-meeting.ts): Nothing, or Not for these.
    const am = AFTER_BUTTON.exec(buttonId);
    if (am) {
      const say = d.afterMeeting ? await d.afterMeeting.pressed(am[1] as "n" | "m", am[2]!) : "";
      await sendText(say || tx("expired"));
      return;
    }
    // A chase for what someone owes the owner (src/followups/chase.ts): the press is the yes. An email reply goes through the held path
    // (its receipt and Undo window, then the send); a read-only chat gets the draft back to copy, with the app's link.
    const ch = CHASE_BUTTON.exec(buttonId);
    if (ch) {
      if (!d.followups?.chasePressed) return void (await sendText(tx("expired")));
      // Paused: asked before the press is taken, so a Send that cannot go is not kept as sent (after RESUME the same button still works).
      const pause = ch[1] !== "3" && d.control ? await d.control.state() : null;
      if (pause && pause.paused !== null) return void (await sendText(tx("notSentPaused", { paused: pausedText(pause.why, lang()) })));
      const r = await d.followups.chasePressed(ch[1] as "1" | "2" | "3", ch[2]!);
      if (r.copy) await sendText(r.copy);
      if (r.say) await sendText(r.say);
      if (r.send && isAddress(r.send.target)) {
        const { key, ...mail } = r.send;
        await door.holdAction({ type: "email", ...mail }, (await door.effective("email")).seconds, key);
      }
      return;
    }
    // Gentle mode's time anchors: "On it" (src/gentle.ts).
    const anchor = /^ga:([0-9a-f]{10})$/.exec(buttonId);
    if (anchor) {
      await sendText(d.gentle ? await d.gentle.anchorPressed(anchor[1]!) : tx("expired"));
      return;
    }
    // Check-ins (src/gentle-checkins.ts): Yes, Not yet, Park on the ask; "Check on me in 30 min" on a follow-up's nudge or Snooze card.
    const ci = CHECKIN_BUTTON.exec(buttonId);
    if (ci) {
      await sendText(d.gentle?.checkinPressed ? await d.gentle.checkinPressed(ci[1] as "1" | "2" | "3", ci[2]!) : tx("expired"));
      return;
    }
    const ck = CHECKIN_LOOP_BUTTON.exec(buttonId);
    if (ck) {
      await sendText(d.gentle?.checkinForLoop ? await d.gentle.checkinForLoop(ck[1]!) : tx("expired"));
      return;
    }
    // The weekly reset (src/gentle-reset.ts): This one, Park, Park the rest, Keep them, Let them go.
    const wr = RESET_BUTTON.exec(buttonId);
    if (wr) {
      const r = d.gentle?.resetPressed ? await d.gentle.resetPressed(wr[1]!, wr[2]!) : null;
      if (!r) return void (await sendText(tx("expired")));
      await sendText(r.say);
      if (r.card) {
        const buttons = r.card.buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: cut(b.title, 20) } }));
        await door.graph({ type: "interactive", interactive: { type: "button", body: { text: r.card.body }, action: { buttons } } });
      }
      return;
    }
    // The beta's audit (src/beta-audit.ts): Yes, No or Skip, then its next question at once.
    const au = AUDIT_BUTTON.exec(buttonId);
    if (au) {
      const say = d.beta ? await d.beta.pressed(au[1] as "y" | "n" | "s", au[2]!) : null;
      await sendText(say ?? tx("expired"));
      if (say !== null) await d.beta?.next().catch(() => false);
      return;
    }
    // A brain dump's card (src/door/dump.ts): Keep all, Undo all, Remove n.
    const dump = /^d(k|x|\d{1,2}):([0-9a-f]{10})$/.exec(buttonId);
    if (dump) {
      await door.dumpPressed(dump[1] === "k" ? "keep" : dump[1] === "x" ? "undo" : Number(dump[1]), dump[2]!, by);
      return;
    }
    const rem = /^r([123]):([0-9a-f]{10})$/.exec(buttonId);
    if (rem) {
      await door.answerReminder(rem[2]!, rem[1] === "1" ? "done" : rem[1] === "2" ? "snooze" : "tomorrow");
      return;
    }
    const auto = /^(a0|e[01]|w[01x]):([0-9a-f]{10})$/.exec(buttonId);
    if (auto) {
      await pressedAutonomy(auto[1]!, auto[2]!);
      return;
    }
    const held = /^q([01]):([0-9a-f]{10})$/.exec(buttonId);
    if (held) {
      await door.answerHeld(held[2]!, held[1] === "1");
      return;
    }
    const bk = /^b([01]):([0-9a-f]{10})$/.exec(buttonId);
    if (bk && d.booking) {
      await door.deliverBooking(await d.booking.press(bk[2]!, bk[1] === "1"));
      return;
    }
    // Undo on a booking's receipt (src/maitre/): cancelled on the engine's own page.
    const bu = /^bu:([0-9a-f]{10})$/.exec(buttonId);
    if (bu && d.booking) {
      await sendText(await d.booking.undo(bu[1]!));
      return;
    }
    const k = /^k([01]):([0-9a-f]{10})$/.exec(buttonId);
    if (k) {
      const id = k[2]!;
      const yes = k[1] === "1";
      const c = connectorCards.get(id);
      if (c && now() - c.at >= PENDING_CALL_MS) {
        connectorCards.delete(id);
        endCard(id, "expired");
        c.ask.closed("expired");
        note(tx("noteAskExpired", { name: c.ask.name }));
      }
      const live = connectorCards.get(id);
      if (!live) {
        const ended = cardEnds.get(id);
        await sendText(tx(
          ended === "answered" ? "cardAnswered"
          : ended === "replaced" ? "cardReplaced"
          : ended === "stopped" ? "cardStopped"
          : ended === "renewed" ? "cardRenewed"
          : ended === "lost" ? "cardLost"
          : yes ? "cardExpiredAsk" : "cardExpired",
        ));
        return;
      }
      // Taken before anything waits: a second tap, or the same press delivered twice, finds it answered.
      connectorCards.delete(id);
      endCard(id, "answered");
      // Paused (STOP, the panel's switch, or Pako's own pause for its store): a Call ends the card here, so it cannot place the call after a
      // RESUME either. Cancel is a no.
      const pause = yes && d.control ? await d.control.state() : null;
      if (pause && pause.paused !== null) {
        endCard(id, "stopped");
        live.ask.closed("stopped");
        note(tx("noteAskPaused", { name: live.ask.name }));
        await sendText(tx("pausedNoCall", { paused: pausedText(pause.why, lang()), name: live.ask.name }));
        return;
      }
      await answerAsk(id, live, yes);
      return;
    }
    const m = /^([cs])([01]):([0-9a-f]{10})$/.exec(buttonId);
    const p = m?.[1] === "s" ? door.pendingSend : door.pendingCall;
    if (!m || !p || p.id !== m[3] || now() - p.at >= PENDING_CALL_MS) {
      await sendText(tx("expired"));
      return;
    }
    if (m[1] === "s") await answerSend(p as NonNullable<typeof door.pendingSend>, m[2] === "1");
    else await answerCall(p as NonNullable<typeof door.pendingCall>, m[2] === "1", "yes");
  };

  // A typed no, in English like the card it answers (a typed yes is isYes).
  const NO = new RegExp(
    "^(no|nope|nah|cancel|cancel it|don['’]?t|do not|no,? thanks|no,? thank you|never ?mind|don['’]?t (?:call|send|do it|send it))[\\s.!]*$",
    "i",
  );

  // English's own yes to "Send it?": said of the card that sends a message only, never of a call.
  const SEND_YES = /^send(?: it)?[\s.!]*$/i;

  return { pressed, NO, SEND_YES };
}
