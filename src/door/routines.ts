// Routines and watches (src/routines.ts): listed, deleted, paused and started again by their number. Answered while paused too: they
// change only what Pako keeps. "Watch for an email from…" is a request for the assistant: only the bare word lists.

import type { Handler } from "./incoming.ts";

export const onRoutines: Handler = async (door, { command }) => {
  if (/^routines$/.test(command)) {
    await door.sendText(await door.routines.routinesText());
    return "routines shown";
  }
  return null;
};

export const onWatches: Handler = async (door, { command }) => {
  if (/^watches$/.test(command)) {
    await door.sendText(await door.routines.watchesText());
    return "watches shown";
  }
  return null;
};

export const onRoutineChange: Handler = async (door, { command }) => {
  const { routines, sendText } = door;
  const routineOp = /^(?:(delete|remove)|(pause)|(resume)) (routine|watch) (\d{1,3})$/.exec(command);
  if (routineOp) {
    const kind = /^routine$/.test(routineOp[4]!) ? "routine" : "watch";
    await sendText(await routines.command(kind, routineOp[1] ? "delete" : routineOp[2] ? "pause" : "resume", Number(routineOp[5])));
    return `${kind} changed`;
  }
  return null;
};
