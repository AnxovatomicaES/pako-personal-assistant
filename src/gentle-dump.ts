// Brain dump: "dump: …", a long message with many things in it, or a voice note, sorted by the assistant into reminders (with their times),
// the owner's own promises (follow-ups), tasks and notes (assistant/tools.ts brain_dump, the <dump> tag), each item then made by the door's
// usual steps (src/door/dump.ts) and listed on ONE card: keep all, remove one ("remove 2"), or undo all.
//
// Only the owner's own words: a turn that read someone else's text sorts nothing (src/door/reply.ts), and each item must be said in what the
// owner wrote or said (ownItems): an item the model took from anywhere else is dropped, never made. Pure: no store, no network.

import { fold } from "./lists.ts";
import { texts } from "./i18n.ts";

export const DUMP_KINDS = ["reminder", "promise", "task", "note"] as const;
export type DumpKind = (typeof DUMP_KINDS)[number];
/** Items one dump may hold. */
export const DUMP_MAX = 12;

export interface DumpItem {
  kind: DumpKind;
  text: string;
  /** A reminder's time, "YYYY-MM-DD HH:MM" in the owner's zone. */
  at?: string;
  /** A promise's person. */
  who?: string;
  /** A promise's or a task's day ("YYYY-MM-DD", a promise's also with "HH:MM"). */
  due?: string;
}

const MINUTE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const DAYS = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/;
const line = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/**
 * The items as the bridge sent them, checked field by field: a known kind, words, and a time that reads. A reminder without a time is a task
 * (with its day when it had one): Pako never guesses an hour. At most DUMP_MAX, the rest dropped.
 */
export function dumpItemsOf(v: unknown): DumpItem[] {
  const out: DumpItem[] = [];
  for (const x of Array.isArray(v) ? v : []) {
    if (out.length >= DUMP_MAX) break;
    const o = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
    const kind = (DUMP_KINDS as readonly unknown[]).includes(o.kind) ? (o.kind as DumpKind) : null;
    const text = line(o.text, 200);
    if (!kind || text.length < 2) continue;
    const at = line(o.at, 16);
    const due = line(o.due, 16);
    const who = line(o.who, 60);
    if (kind === "reminder") {
      if (MINUTE.test(at)) out.push({ kind, text, at });
      else out.push({ kind: "task", text, ...(DAYS.test(at) ? { due: at.slice(0, 10) } : DAYS.test(due) ? { due: due.slice(0, 10) } : {}) });
    } else if (kind === "promise") out.push({ kind, text, ...(who ? { who } : {}), ...(DAYS.test(due) ? { due } : {}) });
    else if (kind === "task") out.push({ kind, text, ...(DAYS.test(due) ? { due: due.slice(0, 10) } : {}) });
    else out.push({ kind, text });
  }
  return out;
}

/** Words that say nothing of what an item is about: an item is matched to the owner's words by the others. */
const STOP = new Set(("the a an to of for and or with my me i i'll ill im it its that this need needs have has should must will would can could "
  + "remember remind dont don't not just also get got make do does did be is are was were on in at by from about up out into then "
  + "tomorrow today tonight morning afternoon evening next week monday tuesday wednesday thursday friday saturday sunday "
  + "him her them his their your you our we us").split(" "));
const wordsOf = (s: string): string[] => fold(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w));
/** A word said in the owner's text: the same word, or one of the same stem ("calling" for "call", "invoices" for "invoice"). */
const said = (w: string, own: Set<string>, stems: string[]): boolean => own.has(w) || stems.some((x) => x.length >= 4 && (w.startsWith(x) || x.startsWith(w.slice(0, 4))));

/**
 * The items said in the owner's own words (their message, or what the bridge heard in their voice note): at least half of an item's words
 * are there. An item from anywhere else is dropped. Without the owner's words (an older bridge, a restart) only a turn with no outside text
 * gets here, and the items are kept as the assistant sorted them.
 */
export function ownItems(items: readonly DumpItem[], owner: readonly string[]): { kept: DumpItem[]; dropped: DumpItem[] } {
  const text = owner.join("\n");
  if (!text.trim()) return { kept: [...items], dropped: [] };
  const all = wordsOf(text);
  const own = new Set(all);
  const kept: DumpItem[] = [];
  const dropped: DumpItem[] = [];
  for (const it of items) {
    const w = wordsOf(`${it.text} ${it.who ?? ""}`);
    const hits = w.filter((x) => said(x, own, all)).length;
    (w.length && hits * 2 >= w.length ? kept : dropped).push(it);
  }
  return { kept, dropped };
}

/** The brain dump's fixed words, exported whole so the no-shame test reads every one. */
export const DUMP_WORDS = {
  head: "🧠 Sorted your brain dump: {n} {things}.",
  thing: "thing",
  things: "things",
  reminder: "⏰ Reminders",
  promise: "🤝 Your promises (I'll follow them up)",
  task: "✅ Tasks",
  note: "📝 Notes",
  item: "{i}. {text}{when}",
  removed: "{i}. ~{text}~ (removed)",
  when: " ({when})",
  foot: "All kept. Reply “remove 2” to drop one, or Undo to take them all back.",
  dropped: "I left out {n} that I couldn't find in your own words.",
  failed: "Not added ({n}): {list}. Already on your lists, or it could not be kept just now.",
  btnKeep: "Keep all",
  btnUndo: "Undo all",
  btnRemove: "Remove {i}",
  kept: "All {n} kept. 👍",
  gone: "That brain dump is no longer here to change.",
  unread: "I couldn't read your brain dumps just now, so nothing changed. Could you try once more in a moment?",
  already: "That one was taken back already.",
  noSuch: "Your last brain dump has no item {i}.",
  none: "Nothing kept from that brain dump, so there is nothing to change.",
  logDump: "Brain dump sorted: {n} items",
};
export const DT = texts(DUMP_WORDS);

export interface DumpLine {
  kind: DumpKind;
  text: string;
  /** How its time reads ("Thu 20/11 10:00", "Fri 21/11"); "" without one. */
  when: string;
  removed?: boolean;
}

/** The card's words: the items numbered in one sequence, grouped by kind (reminders, promises, tasks, notes), and what can be done with them. */
export function dumpCardText(lines: readonly DumpLine[], o: { dropped?: number; failed?: string[] } = {}): string {
  const t = DT();
  const live = lines.filter((l) => !l.removed).length;
  const out = [t("head", { n: live, things: t(live === 1 ? "thing" : "things") })];
  let i = 0;
  const numbered = lines.map((l) => ({ ...l, i: ++i }));
  for (const kind of DUMP_KINDS) {
    const of = numbered.filter((l) => l.kind === kind);
    if (!of.length) continue;
    out.push("", t(kind));
    for (const l of of) {
      out.push(l.removed ? t("removed", { i: l.i, text: l.text }) : t("item", { i: l.i, text: l.text, when: l.when ? t("when", { when: l.when }) : "" }));
    }
  }
  out.push("");
  if (o.dropped) out.push(t("dropped", { n: o.dropped }));
  if (o.failed?.length) out.push(t("failed", { n: o.failed.length, list: o.failed.map((x) => `“${x}”`).join(", ") }));
  out.push(t("foot"));
  return out.join("\n");
}

/** The order the card numbers items in: by kind (reminders first), then as the owner said them. */
export const sortDump = <T extends { kind: DumpKind }>(items: readonly T[]): T[] =>
  [...items].map((x, i) => ({ x, i })).sort((a, b) => DUMP_KINDS.indexOf(a.x.kind) - DUMP_KINDS.indexOf(b.x.kind) || a.i - b.i).map((y) => y.x);

/** "remove 2", "drop #3", "delete 4": the item the owner wants out of their last brain dump. */
export const removeAsk = (command: string): number | null => {
  const m = /^(?:remove|drop|delete|take out|scrap)\s+(?:item\s+|number\s+|#)?(\d{1,2})$/.exec(command.trim());
  return m ? Number(m[1]) : null;
};
