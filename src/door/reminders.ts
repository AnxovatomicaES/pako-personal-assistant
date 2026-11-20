// The owner's reminders: kept, added, removed and put back, one change at a time.

import { randomBytes } from "node:crypto";
import { isEvery, type Every, type SavedReminder } from "../undo.ts";
import { localToEpoch, firstRepeat, localStamp, repeatAfter } from "./time.ts";
import { WINDOW_MS, REMINDERS_MAX } from "./shared.ts";
import type { Reminder, Door } from "./door.ts";
import { readJsonRecord } from "../json-record.ts";

const REMINDERS_KEY = "assistant-reminders";

/** The names this part adds to the door. */
type Part = Pick<
  Door,
  | "loadReminders" | "saveReminders" | "counted" | "remLock" | "addReminder" | "removeReminders" | "removeReminderById" | "restoreReminders"
>;

export function mountReminders(door: Door): Part {
  const { d, config, now, tx, reachable } = door;
  let reminders: Reminder[] | null = null;
  door.runningReminders = false;

  const loadReminders = async (): Promise<Reminder[]> => {
    if (reminders) return reminders;
    let list: Reminder[] = [];
    const raw = d.kv ? await readJsonRecord(d.kv, REMINDERS_KEY) : null;
    if (reminders) return reminders; // loaded by another call meanwhile
    try {
      const parsed: unknown = raw ? raw : [];
      if (Array.isArray(parsed)) {
        list = parsed.filter((r): r is Reminder => !!r && typeof r.id === "string" && typeof r.at === "number" && typeof r.text === "string");
        // A repeat that lost its first time cannot say its next one: it fires once, as a plain reminder.
        for (const r of list) {
          if (isEvery(r.every) && typeof r.anchor === "string") continue;
          delete r.every;
          delete r.anchor;
        }
      }
    } catch {
      /* not JSON: no reminders */
      list = [];
    }
    reminders = list;
    return list;
  };
  const saveReminders = async (list: Reminder[]): Promise<void> => {
    list.sort((a, b) => a.at - b.at);
    if (d.kv) await d.kv.set(REMINDERS_KEY, JSON.stringify(list), 400 * 24 * 3600);
  };

  /** How many count toward REMINDERS_MAX: a repeat's held copy does not (there is one per series at most, and the series counts). */
  // Nor does a birthday: there is one per person (src/people.ts keeps at most PEOPLE_MAX), and a hundred friends must not fill the owner's twenty.
  const counted = (list: Reminder[]): number => list.filter((r) => !(r.held && r.of) && !r.birthday).length;
  /** Saves one reminder; says in words why not when it cannot. `warn` is a heads-up that goes with a saved one. */
  // Everything that changes the reminders runs one at a time (two webhooks, the timer and a reply can overlap).
  let remindersChain: Promise<unknown> = Promise.resolve();
  const remLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = remindersChain.then(fn, fn);
    remindersChain = run.then(() => undefined, () => undefined);
    return run;
  };
  /** A reminder as the journal keeps it: what it takes to put it back exactly (a repeat with its rule). */
  const saved = (r: SavedReminder): SavedReminder => ({
    id: r.id, at: r.at, text: r.text, ...(r.every && r.anchor ? { every: r.every, anchor: r.anchor } : {}), ...(r.birthday ? { birthday: true as const } : {}),
  });
  /**
   * `added`: the reminder as saved (for the owner's receipt), absent when nothing was saved (refused, or the same one was already there).
   * `o.anchor`: the time a repeat keeps its day from, when it is not its first time (a birthday on the 29th of February, first on the 28th);
   * `o.birthday`: a person's birthday reminder (src/people.ts).
   */
  const addReminderNow = async (
    when: string, text: string, every?: Every, o: { anchor?: string; birthday?: boolean } = {},
  ): Promise<{ ok: boolean; say: string; warn?: string; added?: SavedReminder }> => {
    const t = now();
    const given = localToEpoch(when, d.timeZone);
    if (given === null) return { ok: false, say: tx("reminderBadTime", { when }) };
    const at = firstRepeat(given, every, d.timeZone);
    if (at < t + 30_000) return { ok: false, say: tx("reminderPast", { text }) };
    if (at > t + 366 * 24 * 3600_000) return { ok: false, say: tx("reminderTooFar", { text }) };
    if (text.length < 3) return { ok: false, say: tx("reminderEmpty") };
    // Changed on a copy, kept in memory only once the store took it: a store that fails leaves no unsaved reminder behind.
    const list = [...(await loadReminders())];
    if (list.some((r) => r.at === at && r.text.toLowerCase() === text.toLowerCase())) return { ok: true, say: "" };
    if (!o.birthday && counted(list) >= REMINDERS_MAX) return { ok: false, say: tx("remindersFull", { n: REMINDERS_MAX }) };
    const added: SavedReminder = {
      id: randomBytes(4).toString("hex"), at, text, ...(every ? { every, anchor: o.anchor ?? localStamp(at, d.timeZone) } : {}),
      ...(o.birthday ? { birthday: true as const } : {}),
    };
    list.push({ ...added, held: false, tries: 0 });
    await saveReminders(list);
    reminders = list;
    d.control?.log("reminder", tx("logReminderSet", { at: localStamp(at, d.timeZone), text }));
    const open = await reachable(at);
    const warn = !config.reminderTemplate && !open && at - door.lastOwnerAt >= WINDOW_MS ? tx("reminderWarn") : undefined;
    return { ok: true, say: "", added, ...(warn ? { warn } : {}) };
  };

  const addReminder = (when: string, text: string, every?: Every, o?: { anchor?: string; birthday?: boolean }) =>
    remLock(() => addReminderNow(when, text, every, o));
  /** The reminders it deleted, oldest first (for the owner's receipt, and to put them back). */
  const removeRemindersNow = async (words: string[]): Promise<SavedReminder[]> => {
    const list = [...(await loadReminders())];
    const gone: SavedReminder[] = [];
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i]!;
      // A birthday goes only with its person (forgotten, or a birthday changed): "<unremind>Ana</unremind>" is about the owner's own reminders.
      if (r.birthday || !words.some((w) => r.text.toLowerCase().includes(w.toLowerCase()))) continue;
      list.splice(i, 1);
      gone.unshift(saved(r));
    }
    if (gone.length) {
      await saveReminders(list);
      reminders = list;
    }
    return gone;
  };

  const removeReminders = (words: string[]) => remLock(() => removeRemindersNow(words));
  /** Undoing a reminder that was set: null when it is not there any more (it was sent, or deleted since). */
  const removeReminderById = (id: string): Promise<SavedReminder | null> =>
    remLock(async () => {
      const list = await loadReminders();
      const i = list.findIndex((r) => r.id === id);
      if (i < 0) return null;
      const [r] = list.splice(i, 1);
      // A repeat's held copy goes with its series.
      for (let j = list.length - 1; j >= 0; j--) if (list[j]!.of === id) list.splice(j, 1);
      await saveReminders(list);
      return saved(r!);
    });
  /**
   * Undoing deleted reminders: each comes back as it was set (its id, time and words), unless it is back already, its time has passed (it would
   * fire at once, late: it is reported instead), or there is no room for one more.
   */
  const restoreReminders = (gone: SavedReminder[]): Promise<{ restored: SavedReminder[]; past: SavedReminder[]; full: SavedReminder[] }> =>
    remLock(async () => {
      const list = await loadReminders();
      const out = { restored: [] as SavedReminder[], past: [] as SavedReminder[], full: [] as SavedReminder[] };
      const t = now();
      for (const g of gone) {
        // A repeat whose time passed while it was deleted comes back at its next time, not "too late".
        const next = g.every && g.anchor && g.at <= t ? repeatAfter(g.at, g.every, g.anchor, d.timeZone, t) : null;
        const r = next ? { ...g, at: next } : g;
        if (list.some((x) => x.id === r.id || (x.at === r.at && x.text.toLowerCase() === r.text.toLowerCase()))) continue;
        if (r.at <= t) out.past.push(r);
        else if (!r.birthday && counted(list) >= REMINDERS_MAX) out.full.push(r);
        else {
          list.push({ ...saved(r), held: false, tries: 0 });
          out.restored.push(r);
        }
      }
      if (out.restored.length) await saveReminders(list);
      return out;
    });

  return { loadReminders, saveReminders, counted, remLock, addReminder, removeReminders, removeReminderById, restoreReminders };
}
