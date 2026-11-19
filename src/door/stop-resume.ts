// STOP and RESUME: the owner's pause, answered by the server at once, before any other word.

import type { Handler } from "./incoming.ts";
import { createLog } from "../log.ts";

const log = createLog("autonomy");

const squeezedOf = (command: string): string => (command.length <= 14 ? command.replace(/ /g, "") : command);

/**
 * STOP: Pako pauses, and nothing waiting goes out. "Stop…" as iOS writes it, STOP 🛑, "STOP!", “stop”, S T O P: punctuation, symbols, emoji and
 * invisible characters do not change the word.
 */
export const onStop: Handler = async (door, { command, at }) => {
  const { d, tx, sendText, note, choices, emailCards, heldQueue, sweepCards, connectorCards, endCard } = door;
  const squeezed = squeezedOf(command);
  if (d.control && (/^(stop|pause)( pako)?$/.test(command) || /^(stop|pause)$/.test(squeezed))) {
    const kept = await d.control.setPaused(true, at);
    door.pendingCall = null;
    door.pendingSend = null;
    door.heldReplies.clear(); // what a reply read from outside text asked for is not done after a STOP, even if its card is pressed
    // A message, an email or a call still in its window to undo never goes out after a STOP (nor after a RESUME).
    choices.clear();
    emailCards.clear();
    await heldQueue.cancelAll().catch((err: Error) => log.error(`STOP could not undo the held actions: ${err.message}`));
    door.stops++;
    sweepCards();
    const annulled = [...connectorCards.values()].map((c) => c.ask.name);
    for (const [id, c] of connectorCards) {
      endCard(id, "stopped");
      c.ask.closed("stopped");
    }
    connectorCards.clear();
    d.booking?.cancel();
    d.control.log("pause", tx("logStop"));
    const cards = annulled.length ? tx("noteStopCards", { names: [...new Set(annulled)].join(", ") }) : "";
    note(tx("noteStop", { cards }));
    await sendText(tx("stopped", { warn: kept ? "" : tx("stopNotKept") }));
    return "paused";
  }
  return null;
};

/** RESUME: the pause ends; after a store that came back empty, the owner is told what did not come back with it. */
export const onResume: Handler = async (door, { command, at }) => {
  const { d, tx, sendText, note } = door;
  const squeezed = squeezedOf(command);
  if (d.control && (/^resume( pako)?$/.test(command) || /^resume$/.test(squeezed))) {
    const was = await d.control.state();
    const kept = await d.control.setPaused(false, at);
    if (was.paused !== null) {
      d.control.log("pause", tx("logResume"));
      note(tx("noteResume"));
    }
    const warn = kept ? "" : tx("resumeNotKept");
    // After the pause for a store that came back empty (src/store-guard.ts): what went with the store does not come back by itself.
    const lost = was.why === "store-empty" ? tx("resumeLost", { telegram: d.telegram ? tx("resumeLostTelegram") : "" }) : "";
    await sendText(was.paused !== null ? tx("resumed", { lost, warn }) : tx("notStopped"));
    return "resumed";
  }
  return null;
};
