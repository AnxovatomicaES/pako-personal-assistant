// The owner's reminders as text: REMINDERS, and the lines for the assistant's context.

import { repeatText, whenText, type Every } from "../undo.ts";
import { localStamp } from "./time.ts";
import type { Reminder, Door } from "./door.ts";
import type { Handler } from "./incoming.ts";
import { createLog } from "../log.ts";

const log = createLog("whatsapp");

export function mountReminderTexts(door: Door): Pick<Door, "reminderLines" | "remindersText"> {
  const { d, lang, tx, loadReminders, remLock } = door;
  /** " (repeats: every day)" after a repeating reminder, "" for one that does not repeat. */
  const repeatNote = (r: { every?: Every }): string => (r.every ? tx("reminderRepeat", { every: repeatText(r.every, lang()) }) : "");
  // Birthdays are left out: Claude knows them from the people (src/people.ts), and a hundred of them would crowd every message.
  const reminderLines = async (): Promise<string[]> => {
    try {
      return (await loadReminders()).filter((r) => !r.birthday).map((r) =>`${localStamp(r.at, d.timeZone)} ${r.text}${repeatNote(r)}${r.held ? tx("reminderHeld") : ""}`);
    } catch {
      /* the reminders could not be read: Claude goes without them */
      return [];
    }
  };

  /** REMINDERS: the pending reminders, soonest first, a repeat marked. */
  const remindersText = async (): Promise<string> => {
    let list: Reminder[];
    try {
      list = [...(await remLock(loadReminders))].sort((a, b) => a.at - b.at);
    } catch (err) {
      log.error(`could not read the reminders: ${(err as Error).message}`);
      return tx("remindersUnread");
    }
    if (!list.length) return tx("remindersNone");
    const lines = list.map((r) => `• ${whenText(r.at, d.timeZone, lang())} · ${r.text}${repeatNote(r)}${r.held ? tx("reminderHeld") : ""}`);
    return [tx("remindersHead"), ...lines].join("\n");
  };

  return { reminderLines, remindersText };
}

/** Reminders, read by the server at once (they work while paused: reading them is not an action STOP holds). */
export const onReminders: Handler = async (door, { command }) => {
  if (/^reminders$/.test(command)) {
    await door.sendText(await door.remindersText());
    return "reminders shown";
  }
  return null;
};
