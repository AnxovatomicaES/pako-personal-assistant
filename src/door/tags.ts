// What the reply's tags change in routines, watches and lists, with the receipt that tells the owner.

import type { Change } from "../undo.ts";
import { dueDay, TASKS_MAX } from "../lists.ts";
import { routineTexts } from "../routines.ts";
import type { Door } from "./door.ts";
import { createLog } from "../log.ts";

const logRoutines = createLog("routines");
const logLists = createLog("lists");

export function mountTags(door: Door): Pick<Door, "makeRoutines" | "changeLists"> {
  const { d, now, lang, tx, lists, routines, sendText } = door;
  /**
   * What the assistant's <routine> and <watch> tags ask (src/routines.ts); each one made goes into `changes` (the answer's receipt, with its
   * Undo). `refused`: why this turn may not make them: it read outside text (a standing order planted by someone else's words would
   * outlive the card that holds its other tags), or it is a routine's own run (a routine that makes routines would never end).
   */
  const makeRoutines = async (
    rs: { at: string; every: string; text: string }[], ws: { on: string; from: unknown; words: unknown; once: boolean; text: string }[],
    refused: "outside" | "fromRoutine" | null, changes: Change[],
  ): Promise<void> => {
    if (refused) {
      logRoutines.info(`refused a routine or a watch: ${refused === "outside" ? "the turn read outside text" : "a routine's own run"}`);
      d.control?.log("security", routineTexts(lang())(refused));
      await sendText(routineTexts(lang())(refused));
      return;
    }
    try {
      for (const r of rs) {
        const out = await routines.addRoutine(r);
        if (out.added) changes.push({ kind: "routine-added", routine: out.added });
        else if (out.say) await sendText(out.say);
      }
      for (const w of ws) {
        const out = await routines.addWatch(w);
        if (out.added) changes.push({ kind: "watch-added", watch: out.added });
        else if (out.say) await sendText(out.say);
      }
    } catch (err) {
      logRoutines.error(`could not make one: ${(err as Error).message}`);
      await sendText(routineTexts(lang())("unsaved"));
    }
  };

  /**
   * What the assistant's <list>, <task> and <done> tags ask, in that order; each real change goes into `changes` (the answer's receipt). A
   * store that does not answer is said once and stops the rest: never a 503, which would make the bridge send the answer's text again.
   */
  const changeLists = async (
    ops: { name: string; op: "add" | "remove"; items: string[] }[], adds: { text: string; due: string }[], done: string[], changes: Change[],
  ): Promise<void> => {
    if (!ops.length && !adds.length && !done.length) return;
    const t = now();
    try {
      for (const op of ops) {
        if (op.op === "add") {
          const r = await lists.add(op.name, op.items, t);
          if (r.added.length) {
            changes.push({ kind: "items-added", list: r.list, items: r.added });
            d.control?.log("list", tx("logListAdded", { name: r.list, items: r.added.map((x) => x.text).join(", ") }));
          }
          if (r.full.length) await sendText(tx("listFull", { name: r.list, items: r.full.join(", ") }));
        } else {
          const r = await lists.remove(op.name, op.items);
          if (r.removed.length) {
            changes.push({ kind: "items-removed", list: r.list, items: r.removed });
            d.control?.log("list", tx("logListRemoved", { name: r.list, items: r.removed.map((x) => x.text).join(", ") }));
          } else await sendText(tx("noItemFound", { name: r.list }));
        }
      }
      for (const a of adds) {
        const due = a.due ? dueDay(a.due) : null;
        const r = await lists.addTask(a.text, due ?? undefined, t);
        if (r.task) {
          changes.push({ kind: "task-added", task: r.task });
          d.control?.log("task", tx("logTask", { text: r.task.text }));
          if (a.due && !due) await sendText(tx("taskBadDay", { due: a.due, text: r.task.text }));
        } else if (r.full) await sendText(tx("tasksFull", { n: TASKS_MAX }));
      }
      if (done.length) {
        const r = await lists.doneTasks(done, t);
        if (r.length) {
          changes.push({ kind: "tasks-done", tasks: r });
          for (const x of r) d.control?.log("task", tx("logTaskDone", { text: x.text }));
        } else await sendText(tx("noTaskFound"));
      }
    } catch (err) {
      logLists.error(`could not change them: ${(err as Error).message}`);
      await sendText(tx("listsUnsaved"));
    }
  };

  return { makeRoutines, changeLists };
}
