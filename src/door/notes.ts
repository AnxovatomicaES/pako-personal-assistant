// The owner's note commands (src/voice-memory.ts): NOTES, FORGET 3, EDIT 3.

import { noteWords, notesCommand, notesListText, quoteNote, NOTE_MAX, type NotesCommand } from "../voice-memory.ts";
import type { Change, UndoEntry } from "../undo.ts";
import type { Door } from "./door.ts";
import type { Handler } from "./incoming.ts";
import { createLog } from "../log.ts";

const logVoiceMemory = createLog("voice-memory");
const logUndo = createLog("undo");

export function mountNotes(door: Door): Pick<Door, "notesNow"> {
  const { d, lang, tx, note, sendText, sendButton, journal } = door;
  /**
   * The owner's own note commands. A note is named by its number, which never moves to another note: the same command delivered twice
   * (Meta's retry, a restart) finds no note 3, or a note that already says that, and changes nothing. A change gets a receipt with Undo,
   * like the assistant's (src/undo.ts): UNDO typed undoes it too. Says what it did, for the log.
   */
  const notesNow = async (c: NotesCommand): Promise<string> => {
    const l = lang();
    const say = noteWords(l);
    if (c.kind === "list") {
      try {
        await sendText(notesListText(await d.memory.numbered(), d.timeZone, l));
        return "notes shown";
      } catch (err) {
        logVoiceMemory.error(`could not read the notes: ${(err as Error).message}`);
        await sendText(say("unread"));
        return "notes not read";
      }
    }
    let changes: Change[];
    let body: string;
    try {
      if (c.kind === "forget") {
        const gone = await d.memory.removeNoteById(c.id);
        if (!gone || gone === "changed") {
          await sendText(say("gone", { id: c.id }));
          return "no such note";
        }
        changes = [{ kind: "notes-forgotten", notes: [gone] }];
        body = say("deleted", { id: gone.id, q: quoteNote(l, gone.text) });
        d.control?.log("note", say("logDeleted", { id: gone.id, text: gone.text }));
        note(say("contextDeleted", { text: gone.text }));
      } else {
        const r = await d.memory.editNote(c.id, c.text);
        if (r.status !== "edited") {
          const why = r.status === "duplicate" ? say("duplicate", { id: c.id, other: r.other.id })
            : r.status === "long" ? say("long", { max: NOTE_MAX })
            : say(r.status === "empty" ? "empty" : r.status === "same" ? "same" : "gone", { id: c.id });
          await sendText(why);
          return `note not edited (${r.status})`;
        }
        // Undone backwards: the new words leave, then the old ones come back under the same number.
        changes = [{ kind: "notes-forgotten", notes: [r.before] }, { kind: "note-added", note: r.after }];
        body = say("edited", { id: r.after.id, q: quoteNote(l, r.after.text), was: quoteNote(l, r.before.text) });
        d.control?.log("note", say("logEdited", { id: r.after.id, text: r.after.text }));
        note(say("contextEdited", { was: r.before.text, text: r.after.text }));
      }
    } catch (err) {
      logVoiceMemory.error(`could not change a note: ${(err as Error).message}`);
      await sendText(say("notChanged"));
      return "note not changed";
    }
    // The owner just wrote, so the chat is open: the receipt goes now, as a card (a journal that could not keep it: as text, with no button).
    let entry: UndoEntry | null = null;
    try {
      entry = await journal.record(changes, { carded: true });
    } catch (err) {
      logUndo.error(`could not record a change: ${(err as Error).message}`);
    }
    if (!entry || !(await sendButton(body, `u1:${entry.id}`, tx("btnUndo")))) await sendText(entry ? say("typed", { body }) : body);
    return c.kind === "forget" ? "note deleted" : "note edited";
  };

  return { notesNow };
}

/**
 * NOTES, FORGET 3, EDIT 3: … (src/voice-memory.ts): answered here at once, the Mac off too,
 * and while paused (they change only what Pako knows, nothing outside it).
 */
export const onNotes: Handler = async (door, { text, command }) => {
  const notesAsked = notesCommand(text, command);
  if (notesAsked) return door.notesNow(notesAsked);
  return null;
};
