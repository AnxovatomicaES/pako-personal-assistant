// The owner's lists ("shopping", "home"...) and tasks, kept in the store. The assistant changes them with its <list>, <task> and <done> tags
// (src/whatsapp.ts tells the owner what really changed, with an Undo button: src/undo.ts); the owner reads them with LISTS, LIST <name>
// and TASKS, the morning brief names the tasks due today, and the panel shows them (on a computer an item can be ticked or removed there).
//
// One key in the store. Writes are one at a time (each reads the whole record and writes it back) and never start from a copy that could not
// be read: a store that does not answer makes the change fail, it never overwrites the real record with an empty one.

import { randomBytes } from "node:crypto";
import express, { type Express, type Request, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { locale, texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import { createLog } from "./log.ts";
import { readJsonRecord } from "./json-record.ts";

const log = createLog("lists");

export interface Item {
  /** 10 lowercase hex characters: the panel names an item by it. */
  id: string;
  text: string;
  at: number;
  /** Ticked in the panel: still on the list, shown as done. */
  done?: boolean;
}
export interface TodoList {
  name: string;
  items: Item[];
}
export interface Task {
  id: string;
  text: string;
  at: number;
  /** The day it is for, "YYYY-MM-DD" in the owner's time zone. */
  due?: string;
  /** When it was done; absent while it is open. */
  done?: number;
}
export interface Book {
  lists: TodoList[];
  tasks: Task[];
}

const KEY = "assistant-lists";
const TTL_SECONDS = 400 * 24 * 3600;
export const LISTS_MAX = 20;
export const ITEMS_MAX = 100;
export const TASKS_MAX = 100;
const NAME_MAX = 40;
const ITEM_MAX = 120;
const TASK_MAX = 200;
/** A done task stays this long (the panel shows it, an undo can reopen it), then it goes. */
const DONE_KEEP_MS = 7 * 24 * 3600_000;
const HEX10 = /^[0-9a-f]{10}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** For comparing what the owner or Claude wrote: no accents, no case, single spaces. */
export const fold = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
const line = (s: string, max: number): string => s.replace(/\s+/g, " ").trim().slice(0, max);
const newId = (): string => randomBytes(5).toString("hex");

/** "2026-11-20" when it is a real day, else null. */
export function dueDay(s: unknown): string | null {
  const m = typeof s === "string" ? DAY.exec(s.trim()) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? m[0] : null;
}

/** Today in the owner's time zone, "YYYY-MM-DD". */
export function today(now: number, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";
export const itemOf = (v: unknown): Item | null =>
  isObject(v) && typeof v.id === "string" && HEX10.test(v.id) && typeof v.text === "string" && v.text && typeof v.at === "number"
    ? { id: v.id, text: v.text.slice(0, ITEM_MAX), at: v.at, ...(v.done === true ? { done: true } : {}) }
    : null;
export const taskOf = (v: unknown): Task | null => {
  if (!isObject(v) || typeof v.id !== "string" || !HEX10.test(v.id) || typeof v.text !== "string" || !v.text || typeof v.at !== "number") return null;
  const due = dueDay(v.due);
  return { id: v.id, text: v.text.slice(0, TASK_MAX), at: v.at, ...(due ? { due } : {}), ...(typeof v.done === "number" ? { done: v.done } : {}) };
};

function clean(raw: unknown): Book {
  const o = isObject(raw) ? raw : {};
  const lists = (Array.isArray(o.lists) ? o.lists : []).flatMap((l): TodoList[] => {
    if (!isObject(l) || typeof l.name !== "string" || !l.name.trim()) return [];
    const items = (Array.isArray(l.items) ? l.items : []).map(itemOf).filter((x): x is Item => x !== null).slice(0, ITEMS_MAX);
    return [{ name: line(l.name, NAME_MAX), items }];
  });
  const tasks = (Array.isArray(o.tasks) ? o.tasks : []).map(taskOf).filter((x): x is Task => x !== null);
  return { lists: lists.slice(0, LISTS_MAX), tasks: tasks.slice(-TASKS_MAX) };
}

/** The list a name means: the same name (case and accents aside), or said with "the list of..." or "my ... list" around it. */
function findList(b: Book, name: string): TodoList | undefined {
  const want = fold(name).replace(/^(?:the |my )?(?:list )?(?:of (?:the )?)?/, "").replace(/^(?:the |my )?/, "").replace(/ list$/, "");
  return b.lists.find((l) => fold(l.name) === fold(name)) ?? b.lists.find((l) => fold(l.name) === want);
}

/** What some words mean among some texts: those equal to them; when none is, those that contain them. */
function matching<T extends { text: string }>(all: T[], words: string): T[] {
  const w = fold(words);
  if (!w) return [];
  const exact = all.filter((x) => fold(x.text) === w);
  return exact.length ? exact : all.filter((x) => fold(x.text).includes(w));
}

export interface ListStore {
  /**
   * For showing: falls back to what this process last read or wrote when the store does not answer; `strict` throws instead (a command
   * says it could not read them rather than showing an old copy as if it were the record).
   */
  read(strict?: boolean): Promise<Book>;
  /** Items added to a list (made when it is new); `full`: what did not fit. Throws when the store fails. */
  add(list: string, items: string[], now: number): Promise<{ list: string; added: Item[]; full: string[] }>;
  /** Items taken off a list by words (an emptied list goes too). */
  remove(list: string, words: string[]): Promise<{ list: string; removed: Item[] }>;
  /** Undoing an add: exactly those items go, if they are still there. */
  removeItems(list: string, ids: string[]): Promise<Item[]>;
  /** Undoing a removal: the items come back as they were (the list too), unless they are there already or there is no room. */
  restoreItems(list: string, items: Item[]): Promise<{ restored: Item[]; full: Item[] }>;
  /** A new task; null when the same one is open already. `full` when there is no room. */
  addTask(text: string, due: string | undefined, now: number): Promise<{ task: Task | null; full: boolean }>;
  /** Open tasks marked done by words, as they were before (for the receipt and its undo). */
  doneTasks(words: string[], now: number): Promise<Task[]>;
  /** Undoing a task that was added: it goes if it is still there. */
  removeTasks(ids: string[]): Promise<Task[]>;
  /** Undoing tasks marked done: open again (back, if they went since). */
  reopenTasks(tasks: Task[]): Promise<Task[]>;
  /** The panel (a computer only): an item ticked or unticked, or removed; a task done or open again, or removed. False when not found. */
  tickItem(list: string, id: string, done: boolean): Promise<boolean>;
  dropItem(list: string, id: string): Promise<boolean>;
  tickTask(id: string, done: boolean, now: number): Promise<boolean>;
  dropTask(id: string): Promise<boolean>;
}

export function createLists(kv: Kv | null, now: () => number = Date.now): ListStore {
  let local: Book = { lists: [], tasks: [] };
  const readStrict = async (): Promise<Book> => {
    if (!kv) return structuredClone(local);
    const raw = await readJsonRecord(kv, KEY);
    if (!raw) return { lists: [], tasks: [] };
    return clean(raw);
  };
  const write = async (b: Book): Promise<void> => {
    // Done tasks go after a week, the oldest first when there are too many: an open task is never pushed out by a done one.
    const t = now();
    b.tasks = b.tasks.filter((x) => !x.done || t - x.done < DONE_KEEP_MS);
    while (b.tasks.length > TASKS_MAX) {
      const i = b.tasks.findIndex((x) => x.done);
      b.tasks.splice(i >= 0 ? i : 0, 1);
    }
    b.lists = b.lists.filter((l) => l.items.length);
    if (kv) await kv.set(KEY, JSON.stringify(b), TTL_SECONDS);
    local = structuredClone(b);
  };
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
  /** Runs a change on the record read now, and writes it back when it says something changed. */
  const change = <T>(fn: (b: Book) => { out: T; changed: boolean }): Promise<T> =>
    locked(async () => {
      const b = await readStrict();
      const { out, changed } = fn(b);
      if (changed) await write(b);
      return out;
    });

  return {
    async read(strict = false) {
      try {
        const b = await readStrict();
        local = structuredClone(b);
        return b;
      } catch (err) {
        if (strict) throw err;
        log.error(`read failed: ${(err as Error).message}`);
        return structuredClone(local);
      }
    },
    add: (name, items, at) =>
      change((b) => {
        const listName = line(name, NAME_MAX);
        let l = findList(b, listName);
        const out = { list: l?.name ?? listName, added: [] as Item[], full: [] as string[] };
        const wanted = items.map((x) => line(x, ITEM_MAX)).filter(Boolean);
        if (!listName || !wanted.length) return { out, changed: false };
        if (!l) {
          if (b.lists.length >= LISTS_MAX) return { out: { ...out, full: wanted }, changed: false };
          l = { name: listName, items: [] };
          b.lists.push(l);
        }
        for (const text of new Set(wanted)) {
          // Already there (ticked off or not): left as it is, so the receipt names only what really changed.
          if (l.items.some((x) => fold(x.text) === fold(text))) continue;
          if (l.items.length >= ITEMS_MAX) {
            out.full.push(text);
            continue;
          }
          const item = { id: newId(), text, at };
          l.items.push(item);
          out.added.push({ ...item });
        }
        return { out, changed: out.added.length > 0 };
      }),
    remove: (name, words) =>
      change((b) => {
        const l = findList(b, name);
        if (!l) return { out: { list: line(name, NAME_MAX), removed: [] }, changed: false };
        const removed: Item[] = [];
        for (const w of words) {
          for (const x of matching(l.items, w)) {
            l.items.splice(l.items.indexOf(x), 1);
            removed.push(x);
          }
        }
        return { out: { list: l.name, removed }, changed: removed.length > 0 };
      }),
    removeItems: (name, ids) =>
      change((b) => {
        const l = findList(b, name);
        const gone = l ? l.items.filter((x) => ids.includes(x.id)) : [];
        if (l) l.items = l.items.filter((x) => !ids.includes(x.id));
        return { out: gone, changed: gone.length > 0 };
      }),
    restoreItems: (name, items) =>
      change((b) => {
        const out = { restored: [] as Item[], full: [] as Item[] };
        let l = findList(b, name);
        for (const it of items) {
          if (l?.items.some((x) => x.id === it.id || fold(x.text) === fold(it.text))) continue;
          if (!l) {
            if (b.lists.length >= LISTS_MAX) {
              out.full.push(it);
              continue;
            }
            l = { name: line(name, NAME_MAX), items: [] };
            b.lists.push(l);
          }
          if (l.items.length >= ITEMS_MAX) {
            out.full.push(it);
            continue;
          }
          l.items.push({ ...it });
          out.restored.push(it);
        }
        return { out, changed: out.restored.length > 0 };
      }),
    addTask: (text, due, at) =>
      change<{ task: Task | null; full: boolean }>((b) => {
        const t = line(text, TASK_MAX);
        if (!t || b.tasks.some((x) => !x.done && fold(x.text) === fold(t))) return { out: { task: null, full: false }, changed: false };
        if (b.tasks.filter((x) => !x.done).length >= TASKS_MAX) return { out: { task: null, full: true }, changed: false };
        const task: Task = { id: newId(), text: t, at, ...(due ? { due } : {}) };
        b.tasks.push(task);
        return { out: { task: { ...task }, full: false }, changed: true };
      }),
    doneTasks: (words, at) =>
      change((b) => {
        const done: Task[] = [];
        for (const w of words) {
          for (const x of matching(b.tasks.filter((y) => !y.done), w)) {
            done.push({ ...x });
            x.done = at;
          }
        }
        return { out: done, changed: done.length > 0 };
      }),
    removeTasks: (ids) =>
      change((b) => {
        const gone = b.tasks.filter((x) => ids.includes(x.id));
        b.tasks = b.tasks.filter((x) => !ids.includes(x.id));
        return { out: gone, changed: gone.length > 0 };
      }),
    reopenTasks: (tasks) =>
      change((b) => {
        const back: Task[] = [];
        for (const t of tasks) {
          const there = b.tasks.find((x) => x.id === t.id);
          if (there && !there.done) continue;
          if (there) delete there.done;
          else if (b.tasks.some((x) => !x.done && fold(x.text) === fold(t.text))) continue;
          else {
            const { done: _d, ...open } = t;
            b.tasks.push(open);
          }
          back.push(t);
        }
        return { out: back, changed: back.length > 0 };
      }),
    tickItem: (name, id, done) =>
      change((b) => {
        const it = b.lists.find((l) => l.name === name)?.items.find((x) => x.id === id);
        if (!it) return { out: false, changed: false };
        if (done) it.done = true;
        else delete it.done;
        return { out: true, changed: true };
      }),
    dropItem: (name, id) =>
      change((b) => {
        const l = b.lists.find((x) => x.name === name);
        const i = l ? l.items.findIndex((x) => x.id === id) : -1;
        if (!l || i < 0) return { out: false, changed: false };
        l.items.splice(i, 1);
        return { out: true, changed: true };
      }),
    tickTask: (id, done, at) =>
      change((b) => {
        const t = b.tasks.find((x) => x.id === id);
        if (!t) return { out: false, changed: false };
        if (done) t.done = t.done ?? at;
        else delete t.done;
        return { out: true, changed: true };
      }),
    dropTask: (id) =>
      change((b) => {
        const i = b.tasks.findIndex((x) => x.id === id);
        if (i < 0) return { out: false, changed: false };
        b.tasks.splice(i, 1);
        return { out: true, changed: true };
      }),
  };
}

// ---------- what the owner reads: LISTS, LIST <name>, TASKS, the brief, and the assistant's context ----------

const T = texts(
  {
    quoted: "“{s}”",
    listsNone: "You have no lists yet. Just ask me: “put milk and bread on the shopping list”.",
    listsHead: "📋 Your lists:",
    listsLine: "• {name} ({n}): {items}",
    listsFoot: "Type LIST and its name to see all of it.",
    listHead: "📋 {name} ({n}):",
    listDone: "{n} ticked off.",
    tasksNone: "You have no open tasks.",
    tasksHead: "✅ Open tasks:",
    taskToday: " (today)",
    taskDue: " (for {day})",
    taskLate: " (was for {day})",
    brief: "✅ Tasks for today: {list}",
    unread: "I couldn't read your lists right now. Try again in a while.",
  },
);
export const listTexts = T;

/** "vie 20 nov" ("Fri 20 Nov") for a day written "2026-11-20". */
export function dayText(day: string, l: Lang = "en"): string {
  const m = DAY.exec(day);
  if (!m) return day;
  const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  const parts = new Intl.DateTimeFormat(locale(l), { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).formatToParts(at);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value.replace(/\.$/, "")]));
  return `${p.weekday} ${p.day} ${p.month}`;
}

const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const open = (l: TodoList): Item[] => l.items.filter((x) => !x.done);
/** Open tasks, the ones with a day first (soonest first), then the rest as they were added. */
const openTasks = (b: Book): Task[] =>
  b.tasks.filter((x) => !x.done).sort((a, c) => (a.due ?? "9999") < (c.due ?? "9999") ? -1 : (a.due ?? "9999") > (c.due ?? "9999") ? 1 : a.at - c.at);

/** LISTS: each list with how many open items it has and the first of them. */
export function listsText(b: Book, l: Lang = "en"): string {
  const t = T(l);
  if (!b.lists.length) return t("listsNone");
  const lines = b.lists.map((x) => t("listsLine", { name: x.name, n: open(x).length, items: cut(open(x).map((i) => i.text).join(", ") || "—", 120) }));
  return [t("listsHead"), ...lines, "", t("listsFoot")].join("\n");
}

/** LIST <name>: one list whole, the items ticked off counted at the end. Null when there is no list by that name. */
export function listText(b: Book, name: string, l: Lang = "en"): string | null {
  const x = findList(b, name);
  if (!x) return null;
  const t = T(l);
  const ticked = x.items.length - open(x).length;
  return [t("listHead", { name: x.name, n: open(x).length }), ...open(x).map((i) => `• ${i.text}`), ...(ticked ? [t("listDone", { n: ticked })] : [])].join("\n");
}

const dueText = (task: Task, day: string, l: Lang): string => {
  const t = T(l);
  if (!task.due) return "";
  if (task.due === day) return t("taskToday");
  return t(task.due < day ? "taskLate" : "taskDue", { day: dayText(task.due, l) });
};

/** TASKS: the open tasks, with their day. */
export function tasksText(b: Book, now: number, timeZone: string, l: Lang = "en"): string {
  const t = T(l);
  const list = openTasks(b);
  if (!list.length) return t("tasksNone");
  const day = today(now, timeZone);
  return [t("tasksHead"), ...list.slice(0, 40).map((x) => `• ${x.text}${dueText(x, day, l)}`)].join("\n");
}

/** The open tasks due today or before (not done yet): what the morning brief names. */
export function todayTasks(b: Book, now: number, timeZone: string): Task[] {
  const day = today(now, timeZone);
  return openTasks(b).filter((x) => x.due && x.due <= day);
}

/** The brief's line for today's tasks, or null when there is none. */
export function briefLine(b: Book, now: number, timeZone: string, l: Lang = "en"): string | null {
  const due = todayTasks(b, now, timeZone);
  if (!due.length) return null;
  const day = today(now, timeZone);
  return T(l)("brief", { list: cut(due.map((x) => `${x.text}${x.due === day ? "" : dueText(x, day, l)}`).join("; "), 600) });
}

/** For the assistant's context, briefly: each list with its open items, and the open tasks with their day. */
export function contextLines(b: Book): { lists: string[]; tasks: string[] } {
  return {
    lists: b.lists.filter((x) => open(x).length).slice(0, 10).map((x) => cut(`${x.name}: ${open(x).slice(0, 25).map((i) => i.text).join("; ")}`, 600)),
    tasks: openTasks(b).slice(0, 25).map((x) => `${x.text}${x.due ? ` (${x.due})` : ""}`),
  };
}

// ---------- the panel: GET /panel/api/tasks; on a computer, POST /panel/api/tasks/item and /panel/api/tasks/task ----------

export interface TasksPanelDeps {
  /** The panel's session check (src/dashboard.ts). */
  signedIn: (req: Request) => boolean;
  lists: ListStore;
  /** A computer (local mode): items and tasks can be ticked and removed from the panel. A server's panel only shows them. */
  local: boolean;
  timeZone: string;
  now?: () => number;
}

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" };

export function mountTasksPanel(app: Express, d: TasksPanelDeps): void {
  const now = d.now ?? Date.now;
  const limiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false });
  // The same protection as the STOP switch: the strict session cookie, and on a change the x-pako header another site cannot send.
  const auth = (change: boolean): RequestHandler => (req, res, next) => {
    res.set(HEADERS);
    if (change && !d.local) {
      res.status(404).json({ error: "read only here" });
      return;
    }
    if (!d.signedIn(req) || (change && req.get("x-pako") !== "1")) {
      res.status(401).json({ error: "sign in" });
      return;
    }
    next();
  };
  app.get("/panel/api/tasks", auth(false), async (_req, res) => {
    const b = await d.lists.read();
    res.json({ lists: b.lists, tasks: b.tasks, today: today(now(), d.timeZone), edit: d.local });
  });
  const body = express.json({ limit: "1kb" });
  const read = (req: Request): { id: string; list: string; done: boolean | null; remove: boolean } | null => {
    const b = req.body as Record<string, unknown> | undefined;
    if (!b || typeof b.id !== "string" || !HEX10.test(b.id)) return null;
    const done = typeof b.done === "boolean" ? b.done : null;
    const remove = b.remove === true;
    if (done === null && !remove) return null;
    return { id: b.id, list: typeof b.list === "string" ? b.list.slice(0, NAME_MAX) : "", done, remove };
  };
  const answer = async (res: express.Response, run: () => Promise<boolean>): Promise<void> => {
    try {
      const ok = await run();
      res.status(ok ? 200 : 404).json({ ok });
    } catch (err) {
      log.error(`the panel's change was not kept: ${(err as Error).message}`);
      res.status(503).json({ error: "not kept" });
    }
  };
  app.post("/panel/api/tasks/item", auth(true), limiter, body, async (req, res) => {
    const r = read(req);
    if (!r || !r.list) {
      res.status(400).json({ error: "send { list, id, done } or { list, id, remove: true }" });
      return;
    }
    await answer(res, () => (r.remove ? d.lists.dropItem(r.list, r.id) : d.lists.tickItem(r.list, r.id, r.done!)));
  });
  app.post("/panel/api/tasks/task", auth(true), limiter, body, async (req, res) => {
    const r = read(req);
    if (!r) {
      res.status(400).json({ error: "send { id, done } or { id, remove: true }" });
      return;
    }
    await answer(res, () => (r.remove ? d.lists.dropTask(r.id) : d.lists.tickTask(r.id, r.done!, now())));
  });
}
