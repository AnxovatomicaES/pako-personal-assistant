// HELP: what Pako does, and the commands that work on this server.

import { noteWords } from "../voice-memory.ts";
import type { Door } from "./door.ts";
import type { Handler } from "./incoming.ts";

export function mountHelp(door: Door): Pick<Door, "helpText"> {
  const { d, lang, tx } = door;
  /**
   * HELP: what Pako does, in a few lines, and the commands that work on this server (a feature that is off has no command here: its
   * word goes to the assistant like any other).
   */
  const helpText = (): string => {
    const commands = [
      ...(d.control ? [tx("helpStop")] : []),
      ...(d.mail?.digest ? [tx("helpMail")] : []),
      ...(d.codes ? [tx("helpCode")] : []),
      ...(d.calendar ? [tx("helpCalendar")] : []),
      ...(d.brief ? [tx("helpBrief", { daily: d.brief.daily ? tx("helpBriefDaily") : "" })] : []),
      ...(d.zoom ? [tx("helpZoom")] : []),
      ...(d.booking ? [tx("helpBookings")] : []),
      ...(d.slack ? [tx("helpSlack")] : []),
      ...(d.followups ? [tx("helpFollowups")] : []),
      ...(d.followups && d.draftFor ? [tx("helpDraft")] : []),
      ...(d.reviews ? [tx("helpReviews")] : []),
      ...(d.rehearsal ? [tx("helpRehearsal")] : []),
      ...(d.status ? [tx("helpHealth")] : []),
      ...(d.panelLink ? [tx("helpPanel")] : []),
      // On a computer the word always answers: with no bot yet it says where to set one up (the panel's Telegram card).
      ...(d.telegram || d.local ? [tx("helpTelegram")] : []),
      // What Pako keeps for the owner: notes, reminders, lists, tasks.
      noteWords(lang())("help"),
      tx("helpReminders"),
      tx("helpLists"),
      tx("helpTasks"),
      // Phase 4: the people in the owner's life, routines and watches (src/people.ts, src/routines.ts); after the older lines, which stay as they were.
      tx("helpPeople"),
      tx("helpRoutines"),
      tx("helpWatches"),
      ...(d.control ? [tx("helpLog")] : []),
      tx("helpUndo"),
      tx("helpHelp"),
    ];
    // Calls only where there is someone to call: the contact list is what a friend call can reach.
    const intro = [tx("helpIntro"), ...(d.contacts().length ? [tx("helpCalls")] : [])].join(" ");
    return `${intro}\n\n${tx("helpCommands")}\n${commands.join("\n")}`;
  };

  return { helpText };
}

export const onHelp: Handler = async (door, { command }) => {
  if (/^help$/.test(command)) {
    await door.sendText(door.helpText());
    return "help shown";
  }
  return null;
};
