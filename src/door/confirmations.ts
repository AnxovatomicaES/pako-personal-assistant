// A typed yes or no to the card just shown: a proposed call, a message to a friend, a table card. Only the very next message can answer it
// (src/door/inbound.ts takes what waits before anything else); any other message moves on, and a later "ok" must never place a call about
// something else (its buttons still work until it expires).

import { isYes } from "../voice-tools.ts";
import type { Handler } from "./incoming.ts";

/** A typed answer to a call, delivered twice. */
export const onRepeatedAnswer: Handler = async (door, { id }) => {
  if (door.seenPresses.has(id)) return "typed answer repeated";
  return null;
};

export const onCallAnswer: Handler = async (door, { id, text, waiting }) => {
  const { seenPresses, NO, answerCall } = door;
  if (waiting && (isYes(text) || NO.test(text))) {
    seenPresses.add(id);
    await answerCall(waiting, !NO.test(text), text);
    return "typed answer to a call";
  }
  return null;
};

export const onSendAnswer: Handler = async (door, { id, text, waitingSend }) => {
  const { seenPresses, NO, SEND_YES, answerSend } = door;
  if (waitingSend && (isYes(text) || SEND_YES.test(text) || NO.test(text))) {
    seenPresses.add(id);
    await answerSend(waitingSend, !NO.test(text));
    return "typed answer to a message";
  }
  return null;
};

export const onBookingAnswer: Handler = async (door, { id, text, waitingBooking }) => {
  const { d, seenPresses, deliverBooking } = door;
  if (d.booking && waitingBooking) {
    const r = d.booking.resolve(waitingBooking, text);
    if (r) {
      seenPresses.add(id);
      if ("approve" in r) {
        await deliverBooking(await d.booking.press(r.approve.id, r.approve.yes));
        return "typed answer to a booking card";
      }
      await deliverBooking(r.reply);
      return "booking option chosen";
    }
  }
  return null;
};
