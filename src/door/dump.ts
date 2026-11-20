// A brain dump (src/gentle-dump.ts): each sorted item made by the door's usual steps (act: a reminder, the owner's promise as a follow-up, a
// task, a note), then ONE card listing them, with Keep all and Undo all, and "remove 2" typed (or its button where the chat has room).
//
// What each item changed is kept with the dump (BRAIN_DUMPS_KEY, two days): removing one, or undoing all, records exactly those changes in
// the undo journal and undoes them there, so the owner is told what came back as with any other undo. The whole dump is also one journal
// entry, so a typed UNDO right after it takes it all back.

import { randomBytes } from "node:crypto";
import { dayText } from "../lists.ts";
import { whenText, type Change } from "../undo.ts";
import { DT, dumpCardText, ownItems, removeAsk, sortDump, type DumpItem, type DumpKind, type DumpLine } from "../gentle-dump.ts";
import { zonedTime } from "../followups.ts";
import type { HeldActs } from "../quarantine.ts";
import type { Door, Turn } from "./door.ts";
import type { Handler } from "./incoming.ts";
import { createLog } from "../log.ts";

const log = createLog("dump");

export const BRAIN_DUMPS_KEY = "brain-dumps";
const KEEP_S = 2 * 24 * 3600;
const DUMPS_MAX = 10;

interface DumpRecord {
  id: string;
  at: number;
  items: { kind: DumpKind; text: string; when: string; changes: Change[]; removed?: boolean }[];
  /** The journal entry of the whole dump (a typed UNDO); and whether Undo all was pressed. */
  entry?: string;
  undone?: boolean;
}

const none = (): HeldActs => ({ call: null, message: null, send: null, book: null, remind: [], unremind: [], lists: [], tasks: [], done: [], remember: [], forget: [] });

export function mountDump(door: Door): Pick<Door, "brainDump" | "dumpPressed" | "dumpRemove"> {
  const { d, now, sendText, graph, journal, act } = door;
  let memory: DumpRecord[] = [];
  const load = async (): Promise<DumpRecord[]> => {
    if (!d.kv) return memory;
    try {
      const v = JSON.parse((await d.kv.get(BRAIN_DUMPS_KEY)) ?? "[]") as unknown;
      return (Array.isArray(v) ? v : []).filter((x): x is DumpRecord => !!x && typeof x.id === "string" && Array.isArray(x.items)).slice(-DUMPS_MAX);
    } catch {
      return [];
    }
  };
  const save = async (list: DumpRecord[]): Promise<void> => {
    memory = list.filter((x) => now() - x.at < KEEP_S * 1000).slice(-DUMPS_MAX);
    if (d.kv) await d.kv.set(BRAIN_DUMPS_KEY, JSON.stringify(memory), KEEP_S);
  };
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <R>(fn: () => Promise<R>): Promise<R> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  /** The card: in chats with room (the panel's, Telegram) a Remove button per item too, up to five. */
  const card = async (r: DumpRecord, o: { dropped?: number; failed?: string[] } = {}): Promise<boolean> => {
    const lines: DumpLine[] = r.items.map((x) => ({ kind: x.kind, text: x.text, when: x.when, ...(x.removed ? { removed: true } : {}) }));
    const roomy = !!d.local || (via() === "telegram" && !!d.telegram);
    const removes = roomy && r.items.length <= 5
      ? r.items.flatMap((x, i) => (x.removed ? [] : [{ type: "reply", reply: { id: `d${i + 1}:${r.id}`, title: DT()("btnRemove", { i: i + 1 }) } }]))
      : [];
    return graph({
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: dumpCardText(lines, o).slice(0, 1000) },
        action: {
          buttons: [
            { type: "reply", reply: { id: `dk:${r.id}`, title: DT()("btnKeep") } },
            { type: "reply", reply: { id: `dx:${r.id}`, title: DT()("btnUndo") } },
            ...removes,
          ],
        },
      },
    });
  };
  const via = (): string | undefined => door.via.getStore();

  const whenOf = (it: DumpItem): string => {
    if (it.at) {
      const t = zonedTime(it.at, d.timeZone);
      return t === null ? "" : whenText(t, d.timeZone);
    }
    if (it.due) return dayText(it.due.slice(0, 10));
    return "";
  };

  /**
   * Makes the items of a brain dump that are the owner's own words, each by the door's usual steps, and sends its one card. The items made.
   * `outside`: the turn read someone else's text, so nothing is made (said in the log only: the answer's text already went).
   */
  const brainDump = async (items: DumpItem[], turn: Turn, o: { outside: boolean }): Promise<number> => {
    if (!items.length) return 0;
    if (o.outside) {
      log.info(`a brain dump from a turn that read outside text: ${items.length} items not made`);
      return 0;
    }
    const { kept, dropped } = ownItems(items, turn.sources.owner);
    if (dropped.length) log.info(`a brain dump's ${dropped.length} items were not in the owner's words: left out`);
    const r: DumpRecord = { id: randomBytes(5).toString("hex"), at: now(), items: [] };
    const failed: string[] = [];
    for (const it of sortDump(kept)) {
      const a = none();
      if (it.kind === "reminder") a.remind = [{ at: it.at!, text: it.text }];
      else if (it.kind === "promise") a.promises = [{ text: it.text, who: it.who ?? "", due: it.due ?? "" }];
      else if (it.kind === "task") a.tasks = [{ text: it.text, due: it.due ?? "" }];
      else a.remember = [it.text];
      const changes: Change[] = [];
      try {
        await act(a, changes, turn);
      } catch (err) {
        log.error(`a brain dump item could not be kept: ${(err as Error).message}`);
      }
      if (!changes.length) {
        failed.push(it.text);
        continue;
      }
      r.items.push({ kind: it.kind, text: it.text, when: whenOf(it), changes });
    }
    if (!r.items.length) {
      if (failed.length || dropped.length) await sendText(DT()("none"));
      return 0;
    }
    try {
      r.entry = (await journal.record(r.items.flatMap((x) => x.changes), { carded: true })).id;
    } catch (err) {
      log.error(`the brain dump's undo entry: ${(err as Error).message}`);
    }
    await serial(async () => save([...(await load()), r]));
    d.control?.log("note", DT()("logDump", { n: r.items.length }));
    if (!(await card(r, { dropped: dropped.length, failed }))) await sendText(dumpCardText(r.items.map((x) => ({ kind: x.kind, text: x.text, when: x.when })), { dropped: dropped.length, failed }));
    return r.items.length;
  };

  /** Undoes these changes through the journal (its own entry), so the owner is told what came back as with any undo. */
  const undoChanges = async (changes: Change[], by: string): Promise<void> => {
    const e = await journal.record(changes, { carded: true });
    await door.undoNow({ id: e.id }, by);
  };

  /** Keep all (dk), Undo all (dx), Remove n (d1…d12). */
  const dumpPressed = (what: "keep" | "undo" | number, id: string, by = ""): Promise<void> =>
    serial(async () => {
      const list = await load();
      const r = list.find((x) => x.id === id);
      if (!r) return void (await sendText(DT()("gone")));
      if (r.undone) return void (await sendText(DT()("already")));
      if (what === "keep") return void (await sendText(DT()("kept", { n: r.items.filter((x) => !x.removed).length })));
      if (what === "undo") {
        const changes = r.items.filter((x) => !x.removed).flatMap((x) => x.changes);
        r.undone = true;
        await save(list);
        if (changes.length) await undoChanges(changes, by);
        return;
      }
      const it = r.items[what - 1];
      if (!it) return void (await sendText(DT()("noSuch", { i: what })));
      if (it.removed) return void (await sendText(DT()("already")));
      it.removed = true;
      await save(list);
      await undoChanges(it.changes, by);
    });

  /** "remove 2" typed: the latest brain dump of the last two days. False when there is none (the message goes on as any other). */
  const dumpRemove = async (n: number, by: string): Promise<boolean> => {
    const last = (await load()).filter((x) => !x.undone).at(-1);
    if (!last) return false;
    await dumpPressed(n, last.id, by);
    return true;
  };

  return { brainDump, dumpPressed, dumpRemove };
}

/** "remove 2" after a brain dump; anything else goes on (a "remove" with no dump to change goes to the assistant). */
export const onDumpRemove: Handler = async (door, { command, id }) => {
  const n = removeAsk(command);
  if (n === null) return null;
  return (await door.dumpRemove(n, id)) ? "brain dump item removed" : null;
};
