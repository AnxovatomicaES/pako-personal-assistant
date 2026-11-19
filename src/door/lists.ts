// LISTS and TASKS (src/lists.ts), read by the server at once (they work while paused: reading them is not an action
// STOP holds).

import { listsText, listTexts, listText, tasksText } from "../lists.ts";
import type { Handler } from "./incoming.ts";
import { createLog } from "../log.ts";

const log = createLog("lists");

/** LIST <name> answers only for a list that exists: "list three ideas for dinner" is a request for the assistant. */
export const onLists: Handler = async (door, { command }) => {
  const { lang, lists, sendText } = door;
  const listWord = /^(?:lists|list)(?: (.{1,60}))?$/.exec(command);
  if (listWord) {
    let said: string | null;
    try {
      const b = await lists.read(true);
      said = listWord[1] ? listText(b, listWord[1], lang()) : listsText(b, lang());
    } catch (err) {
      log.error(`could not read them: ${(err as Error).message}`);
      said = listWord[1] ? null : listTexts(lang())("unread");
    }
    if (said !== null) {
      await sendText(said);
      return "lists shown";
    }
  }
  return null;
};

export const onTasks: Handler = async (door, { command, at }) => {
  const { d, lang, lists, sendText } = door;
  if (/^tasks$/.test(command)) {
    try {
      await sendText(tasksText(await lists.read(true), at, d.timeZone, lang()));
    } catch (err) {
      log.error(`could not read the tasks: ${(err as Error).message}`);
      await sendText(listTexts(lang())("unread"));
    }
    return "tasks shown";
  }
  return null;
};
