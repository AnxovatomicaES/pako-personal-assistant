// Undo: a change undone, pressed or typed, and what the owner is told about it.

import { randomBytes } from "node:crypto";
import { undoOf } from "../calendar-writes.ts";
import { lessonsOfUndo, nothingReverted, undoneText, UNDO_RECENT_MS, type Change, type Reversal, type Reverted, type UndoEntry } from "../undo.ts";
import { T } from "./texts.ts";
import type { Door } from "./door.ts";
import type { Handler } from "./incoming.ts";
import { createLog } from "../log.ts";

const logFacts = createLog("facts");
const logUndo = createLog("undo");

export function mountRevert(door: Door): Pick<Door, "undoNow"> {
  const {
    d, now, lang, tx, lists, people, facts, routines, note, sendText, sendButton, loadReminders, remLock, removeReminderById, restoreReminders,
    journal,
  } = door;
  /**
   * Puts back what one entry changed, its last change first (a moved reminder: the new one goes, then the old one comes back). What found no
   * room stays for a later press; a reminder it set that is gone is said (sent, or changed since), with any pending one of the same words.
   */
  const revert = async (e: UndoEntry): Promise<Reversal<Reverted>> => {
    const r = nothingReverted();
    const left: Change[] = [];
    for (const c of [...e.changes].reverse()) {
      if (c.kind === "reminder-added") {
        if (await removeReminderById(c.reminder.id)) r.removedReminders.push(c.reminder);
        else (c.reminder.at <= now() ? r.sentReminders : r.changedReminders).push(c.reminder);
      } else if (c.kind === "reminders-removed") {
        const back = await restoreReminders(c.reminders);
        r.restoredReminders.push(...back.restored);
        r.pastReminders.push(...back.past);
        r.fullReminders.push(...back.full);
        if (back.full.length) left.unshift({ kind: "reminders-removed", reminders: back.full });
      } else if (c.kind === "notes-forgotten") {
        const back = await d.memory.restoreNotes(c.notes);
        r.restoredNotes.push(...back.restored);
        r.fullNotes.push(...back.full);
        if (back.full.length) left.unshift({ kind: "notes-forgotten", notes: back.full });
      } else if (c.kind === "items-added") {
        const gone = await lists.removeItems(c.list, c.items.map((x) => x.id));
        if (gone.length) r.removedItems.push({ list: c.list, items: gone });
      } else if (c.kind === "items-removed") {
        const back = await lists.restoreItems(c.list, c.items);
        if (back.restored.length) r.restoredItems.push({ list: c.list, items: back.restored });
        if (back.full.length) {
          r.fullItems.push({ list: c.list, items: back.full });
          left.unshift({ kind: "items-removed", list: c.list, items: back.full });
        }
      } else if (c.kind === "task-added") {
        r.removedTasks.push(...(await lists.removeTasks([c.task.id])));
      } else if (c.kind === "tasks-done") {
        r.reopenedTasks.push(...(await lists.reopenTasks(c.tasks)));
      } else if (c.kind === "person-added") {
        if (await people.remove(c.person.id)) r.removedPeople.push(c.person);
      } else if (c.kind === "person-changed" || c.kind === "person-removed") {
        // Back exactly as it was before this change (with its birthday reminder's id: the reminder comes back under it, above or below).
        const p = c.kind === "person-changed" ? c.before : c.person;
        const back = await people.restore(p);
        if (back === "restored") r.restoredPeople.push(p);
        else if (back === "taken") r.takenPeople.push(p);
        else if (back === "full") {
          r.fullPeople.push(p);
          left.unshift(c);
        }
      } else if (c.kind === "facts-forgotten") {
        await facts.restore(c.facts).catch((err: Error) => logFacts.error(`could not put the told facts back: ${err.message}`));
      } else if (c.kind === "routine-added") {
        const gone = await routines.removeById("routine", c.routine.id);
        if (gone) (r.removedRoutines ??= []).push(gone);
      } else if (c.kind === "calendar-written") {
        // The write that puts it back, under an id of its own (pressed twice: the second finds the entry undone already).
        const w = d.calendarWrites ? await d.calendarWrites.get(c.write.id) : null;
        const back = w ? undoOf(w, `${c.write.id.slice(0, 5)}${randomBytes(3).toString("hex").slice(0, 5)}`) : null;
        if (back && (await d.calendarWrites!.enqueue(back))) (r.calendarUndone ??= []).push({ title: c.write.title });
      } else if (c.kind === "loop-added") {
        const gone = d.followups?.dropFromChat ? await d.followups.dropFromChat([c.loop.id]) : [];
        if (gone.length) (r.droppedLoops ??= []).push(c.loop);
      } else if (c.kind === "loops-closed") {
        const back = d.followups?.reopenClosed ? await d.followups.reopenClosed(c.loops) : [];
        if (back.length) (r.reopenedLoops ??= []).push(...back);
      } else if (c.kind === "watch-added") {
        const gone = await routines.removeById("watch", c.watch.id);
        if (gone) (r.removedWatches ??= []).push(gone);
      } else if (await d.memory.removeNote(c.note)) r.removedNotes.push(c.note);
    }
    const gone = [...r.sentReminders, ...r.changedReminders].map((x) => x.text.toLowerCase());
    if (gone.length) {
      r.samePending = await remLock(async () =>
        (await loadReminders()).filter((x) => gone.includes(x.text.toLowerCase())).map((x) => ({ id: x.id, at: x.at, text: x.text })));
    }
    const changed = r.removedNotes.length + r.restoredNotes.length + r.removedReminders.length + r.restoredReminders.length + r.removedItems.length
      + r.restoredItems.length + r.removedTasks.length + r.reopenedTasks.length + r.removedPeople.length + r.restoredPeople.length
      + (r.removedRoutines?.length ?? 0) + (r.removedWatches?.length ?? 0) + (r.reopenedLoops?.length ?? 0) + (r.droppedLoops?.length ?? 0) + (r.calendarUndone?.length ?? 0) > 0;
    return { result: r, left, changed };
  };

  /**
   * Undo pressed (the entry its receipt names) or UNDO typed (the latest of the last day): undone once, the owner told exactly what came
   * back, and the assistant's context told too (the notes and reminders it sees changed under it). Says what it did, for the log.
   */
  const undoNow = async (which: { id: string } | { within: number }, by: string): Promise<string> => {
    let out;
    try {
      out = await journal.undo(which, by, revert);
    } catch (err) {
      logUndo.error(`could not undo: ${(err as Error).message}`);
      await sendText(tx("undoFailed"));
      return "undo failed";
    }
    if (out.status !== "done") {
      await sendText(tx(out.status === "already" ? "undoAlready" : out.status === "gone" ? "undoGone" : "undoNone"));
      return `undo ${out.status}`;
    }
    // The owner undid it: each thing put back is a lesson for the next runs (src/lessons.ts), from what Pako itself recorded doing.
    for (const x of lessonsOfUndo(out.entry.changes)) {
      void d.lessons?.undone(x).catch((err: Error) => logUndo.error(`an undo could not be kept as a lesson: ${err.message}`));
    }
    // One language for the answer, the log line, the note and the button: the summary is the answer's own words.
    const l = lang();
    const { text, summary } = undoneText(out.result, d.timeZone, l);
    d.control?.log("undo", T(l)("logUndone", { summary }));
    note(T(l)("noteUndone", { summary }));
    // What found no room waits in the same entry: the answer carries its button (a typed UNDO, or a receipt given as text, had none).
    if (out.open && text.length <= 1000 && (await sendButton(text, `u1:${out.entry.id}`, T(l)("btnUndo")))) return "undone in part";
    await sendText(text);
    if (out.open) await sendButton(T(l)("undoWhenRoom"), `u1:${out.entry.id}`, T(l)("btnUndo"));
    return out.open ? "undone in part" : "undone";
  };

  return { undoNow };
}

/**
 * The receipt's Undo, typed: the latest change of the last day (from when its receipt reached the owner). Once that one is undone, an
 * UNDO typed again says so: it never reaches back to an older change, which keeps its own button.
 */
export const onUndo: Handler = async (door, { command, id }) => {
  if (/^undo$/.test(command)) {
    // A message, an email or a call still in its window to undo comes first: it has not gone out yet.
    if (await door.undoLatestHeld()) return "held action undone";
    return door.undoNow({ within: UNDO_RECENT_MS }, id);
  }
  return null;
};
