// "find time for <words>": a focus block for one of the owner's open follow-ups (src/time-to-do.ts), on a card whose Block is the owner's
// yes. Read by the server, like PENDING; a server without follow-ups lets the words go on to the assistant.

import type { Handler } from "./incoming.ts";

export const onFindTime: Handler = async (door, { command }) => {
  const { d, sendText } = door;
  if (!d.timeToDo) return null;
  const m = /^(?:find|make|block) (?:some )?time (?:for|to do) (.{2,80})$/.exec(command);
  if (!m) return null;
  const say = await d.timeToDo.findTime(m[1]!);
  if (say) await sendText(say);
  return "find time asked";
};
