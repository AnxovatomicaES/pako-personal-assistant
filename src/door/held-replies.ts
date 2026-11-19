// What a reply read from outside text asks for: done at once when it is safe, otherwise held on a card for the owner's yes.

import { randomBytes } from "node:crypto";
import { isEvery, type Change } from "../undo.ts";
import { heldCard, heldLog, heldText, type HeldActs, type OutsideSource } from "../quarantine.ts";
import type { Turn, Door } from "./door.ts";
import { createLog } from "../log.ts";

const logWhatsapp = createLog("whatsapp");
const logQuarantine = createLog("quarantine");

export function mountHeldReplies(door: Door): Pick<Door, "heldReplies" | "act" | "holdReply" | "answerHeld"> {
  const {
    d, now, lang, tx, via, telegramReady, sendText, sendButtons, startBooking, propose, prepareMessage, proposeSend, callAuto, sendAuto, emailAuto,
    windowOver, addReminder, removeReminders, sendReceipt, keepPeople,
  } = door;
  // ---------- outside text: what a marked turn's tags asked for, held until the owner presses its card (src/quarantine.ts) ----------

  /** Replies held because their turn read outside text, by their card's id. In memory only: after a restart the card says it is gone. */
  const heldReplies = new Map<string, { acts: HeldActs; why: OutsideSource[]; at: number }>();
  const HELD_MS = 15 * 60_000;
  /**
   * Does what a reply's tags asked for; each real change goes into `changes` (the answer's receipt). Notes come here only from a held reply:
   * an unmarked one sent them to /assistant/memory before its reply.
   */
  const act = async (a: HeldActs, changes: Change[], turn?: Turn): Promise<void> => {
    // With the turn (an answer to the owner's own message): the policy of src/autonomy.ts decides, direct with a window to undo or a card
    // that says why. Without it (a held reply the owner pressed Do it on): the cards, as before.
    if (a.call && a.call.name && a.call.message) await (turn ? callAuto(a.call, turn) : propose(a.call));
    if (a.message && a.message.to && a.message.text) await prepareMessage(a.message);
    if (a.send && a.send.to && a.send.text) await (turn ? sendAuto(a.send, turn) : proposeSend(a.send));
    if (a.email && a.email.to && a.email.text) await emailAuto(a.email, turn ?? null);
    // With the turn of the owner's own words a named restaurant is booked at once; a held reply (outside text) keeps the card.
    if (a.book) startBooking(a.book, turn);
    // Deleting comes first: moving a reminder is "remove the old one, add the new one", and the removal (by words) must not take the new one with it.
    // A store that does not answer is said once: never a 503 after the answer's text went (the bridge would send that text again).
    try {
      if (a.unremind.length) {
        const gone = await removeReminders(a.unremind);
        if (gone.length) changes.push({ kind: "reminders-removed", reminders: gone });
        else await sendText(tx("noReminderFound"));
      }
      for (const r of a.remind) {
        const result = await addReminder(r.at, r.text, isEvery(r.every) ? r.every : undefined);
        if (result.added) changes.push({ kind: "reminder-added", reminder: result.added });
        if (!result.ok) await sendText(result.say);
        else if (result.warn) await sendText(result.warn);
      }
    } catch (err) {
      logWhatsapp.error(`could not change the reminders: ${(err as Error).message}`);
      await sendText(tx("reminderUnsaved"));
    }
    await door.changeLists(a.lists, a.tasks, a.done, changes);
    // Promises the owner made in the chat: each kept as their own follow-up, said in the receipt (with Undo).
    for (const p of a.promises ?? []) {
      if (!d.followups?.fromChat) break;
      try {
        const kept = await d.followups.fromChat({ title: p.text, ...(p.who ? { who: p.who } : {}), ...(p.due ? { due: p.due } : {}), ...(turn?.key ? { ref: turn.key } : {}) });
        if (kept) changes.push({ kind: "loop-added", loop: { id: kept.id, title: kept.title, ...(kept.dueAt ? { dueAt: kept.dueAt } : {}) } });
      } catch (err) {
        logQuarantine.error(`could not keep a promise: ${(err as Error).message}`);
        await sendText(tx("loopsUnsaved"));
      }
    }
    // Follow-ups the owner said are handled: the one open loop each set of words names is closed; none or several are said, never guessed.
    if (a.closed?.length) {
      if (!d.followups?.closeByWords) await sendText(tx("noLoopFound", { words: a.closed.join(" / ") }));
      else {
        try {
          const r = await d.followups.closeByWords(a.closed);
          if (r.closed.length) changes.push({ kind: "loops-closed", loops: r.closed });
          for (const w of r.none) await sendText(tx("noLoopFound", { words: w }));
          for (const m of r.many) await sendText(tx("loopsMany", { words: m.words, list: m.titles.map((x) => `“${x}”`).join(", ") }));
        } catch (err) {
          logQuarantine.error(`could not close the follow-ups: ${(err as Error).message}`);
          await sendText(tx("loopsUnsaved"));
        }
      }
    }
    if (a.people?.length) await keepPeople(a.people, changes);
    try {
      for (const t of a.remember) {
        const r = await d.memory.addNote(t, now());
        if (r.dropped.length) changes.push({ kind: "notes-forgotten", notes: r.dropped });
        if (r.added) changes.push({ kind: "note-added", note: r.added });
        d.control?.log("note", tx("logNoteKept", { text: t }));
      }
      for (const m of a.forget) {
        const gone = await d.memory.forgetNotes(m);
        if (gone.length) {
          changes.push({ kind: "notes-forgotten", notes: gone });
          d.control?.log("note", tx("logNotesForgotten", { n: gone.length, words: m }));
        }
      }
    } catch (err) {
      logQuarantine.error(`could not change the notes: ${(err as Error).message}`);
    }
  };
  /** Holds what a marked reply asked for, logs it, and asks the owner with a card (Do it / Cancel) on the chat its answer went to. */
  const holdReply = async (a: HeldActs, why: OutsideSource[]): Promise<void> => {
    for (const [k, h] of heldReplies) if (now() - h.at >= HELD_MS) heldReplies.delete(k);
    while (heldReplies.size >= 10) heldReplies.delete(heldReplies.keys().next().value!);
    const id = randomBytes(5).toString("hex");
    heldReplies.set(id, { acts: a, why, at: now() });
    logQuarantine.info(`held what a reply asked for: its turn read outside text (${why.join(", ")})`);
    d.control?.log("security", heldLog("log", a, why, lang()));
    // A new card is the only thing a typed word can answer now; this one takes its buttons only (a typed "yes" may be about anything).
    if (door.pendingCall) door.pendingCall.typed = false;
    if (door.pendingSend) door.pendingSend.typed = false;
    const card = () => sendButtons(heldCard(a, why, lang()), `q1:${id}`, `q0:${id}`, heldText("yes", lang()));
    // WhatsApp's 24 hours over (an answer to an old message): on Telegram when paired; never into a window where Meta drops it.
    const late = !d.local && via.getStore() !== "telegram" && (await windowOver(now()));
    const asked = !late ? await card() : (await telegramReady()) ? await via.run("telegram", card) : false;
    if (!asked) heldReplies.delete(id);
  };
  /** The held card's buttons: done only while it is fresh, not after a STOP or a restart, and not while paused. */
  const answerHeld = async (id: string, yes: boolean): Promise<void> => {
    const h = heldReplies.get(id);
    heldReplies.delete(id); // taken before anything waits: a second press finds it gone
    if (!h || now() - h.at >= HELD_MS) {
      await sendText(heldText("expired", lang()));
      return;
    }
    if (!yes) {
      d.control?.log("security", heldLog("logDropped", h.acts, h.why, lang()));
      await sendText(heldText("dropped", lang()));
      return;
    }
    const pause = d.control ? await d.control.state() : null;
    if (pause && pause.paused !== null) {
      await sendText(heldText("paused", lang()));
      return;
    }
    d.control?.log("security", heldLog("logDone", h.acts, h.why, lang()));
    const changes: Change[] = [];
    try {
      await act(h.acts, changes);
    } finally {
      await sendReceipt(changes);
    }
  };

  return { heldReplies, act, holdReply, answerHeld };
}
