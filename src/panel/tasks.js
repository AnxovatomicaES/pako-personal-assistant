// Pako · panel · lists and tasks. Its own card, put after the reminders: the lists ("compra", "casa"...) with their items, and the open tasks
// with their day. Read from /panel/api/tasks (src/lists.ts); on a computer an item or a task can be ticked or removed here (the strict
// session cookie and the x-pako header, like STOP). A server's panel only shows them. Without the route (no WhatsApp door) the card stays hidden.
// Everything is put on the page as text, never as HTML. Its words are its own (English, here).

import { h, localeOf, fill } from "./dom.js";

const REFRESH_MS = 60_000;

const WORDS = {
  title: "Lists and tasks",
  lists: "Lists",
  tasks: "Tasks",
  noLists: "No lists yet. Ask Pako: “put milk on the shopping list”.",
  noTasks: "No open tasks.",
  today: "today",
  late: "was for {day}",
  due: "for {day}",
  tick: "Mark “{text}” as done",
  untick: "Unmark “{text}”",
  remove: "Remove “{text}”",
  done: "Done this week",
  failed: "Couldn't change it right now",
};
/** A text of this card, its {placeholders} filled from vars (the page's own t(), for this card's words). */
function t(key, vars) {
  const s = WORDS[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m)) : s;
}

const icon = (name) => h("i", { "data-lucide": name });

let data = null;
let card = null;
let busy = false;

/** "vie 20 nov" for "2026-11-20" (noon UTC: the same day in any time zone). */
function dayText(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  return new Intl.DateTimeFormat(localeOf(), { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" })
    .format(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
}
const dueText = (due) => (!due ? "" : due === data.today ? t("today") : t(due < data.today ? "late" : "due", { day: dayText(due) }));

function toast(text) {
  const el = document.querySelector("#toast");
  if (!el) return;
  el.textContent = text;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2600);
}

async function change(path, body) {
  if (busy) return;
  busy = true;
  try {
    const r = await fetch(`/panel/api/tasks/${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-pako": "1" },
      body: JSON.stringify(body),
    });
    if (!r.ok && r.status !== 404) toast(t("failed"));
    // A task ticked as done: Pako's figure is glad (pako-figure.js listens).
    else if (r.ok && body.done === true) dispatchEvent(new CustomEvent("pako:happy"));
  } catch {
    /* offline: said in a toast */
    toast(t("failed"));
  } finally {
    busy = false;
  }
  await load();
}

/** One row: a tick (on a computer), the words, what it is for, and a remove button (on a computer). */
function row({ text, done, note, onTick, onRemove }) {
  const tick = data.edit
    ? h("button", { class: "ic", type: "button", "aria-label": t(done ? "untick" : "tick", { text }), "aria-pressed": done ? "true" : "false", onclick: onTick },
      icon(done ? "check-square" : "square"))
    : h("span", { class: "ic" }, icon(done ? "check-square" : "square"));
  const body = h("div", { class: "body" },
    h("div", { class: "row" }, h("span", { class: "subj", style: done ? "text-decoration: line-through; opacity: .6" : false }, text),
      note ? h("span", { class: "ago" }, note) : null));
  const remove = data.edit
    ? h("button", { class: "ic", type: "button", "aria-label": t("remove", { text }), onclick: onRemove }, icon("x"))
    : null;
  return h("li", { class: "item" }, tick, body, remove);
}

function render() {
  if (!card || !data) return;
  card.hidden = false;
  card.querySelector("[data-tasks-title]").textContent = t("title");
  const lists = Array.isArray(data.lists) ? data.lists : [];
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const parts = [h("h3", { class: "muted small" }, t("lists"))];
  if (!lists.length) parts.push(h("p", { class: "muted small" }, t("noLists")));
  for (const l of lists.slice(0, 20)) {
    parts.push(h("p", { class: "small" }, h("b", {}, l.name)));
    parts.push(h("ul", { class: "list compact" }, ...l.items.slice(0, 100).map((i) => row({
      text: i.text,
      done: i.done === true,
      onTick: () => change("item", { list: l.name, id: i.id, done: i.done !== true }),
      onRemove: () => change("item", { list: l.name, id: i.id, remove: true }),
    }))));
  }
  const open = tasks.filter((x) => !x.done).sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.at - b.at);
  const done = tasks.filter((x) => x.done).sort((a, b) => b.done - a.done);
  parts.push(h("h3", { class: "muted small" }, t("tasks")));
  if (!open.length) parts.push(h("p", { class: "muted small" }, t("noTasks")));
  const taskRow = (x) => row({
    text: x.text,
    done: !!x.done,
    note: x.done ? "" : dueText(x.due),
    onTick: () => change("task", { id: x.id, done: !x.done }),
    onRemove: () => change("task", { id: x.id, remove: true }),
  });
  if (open.length) parts.push(h("ul", { class: "list compact" }, ...open.slice(0, 100).map(taskRow)));
  if (done.length) {
    parts.push(h("p", { class: "muted small" }, t("done")));
    parts.push(h("ul", { class: "list compact" }, ...done.slice(0, 20).map(taskRow)));
  }
  fill(card.querySelector("[data-tasks-body]"), ...parts);
  window.lucide?.createIcons?.({ attrs: { "aria-hidden": "true" } });
}

async function load() {
  try {
    const r = await fetch("/panel/api/tasks", { credentials: "same-origin" });
    if (r.status === 404) {
      // No lists on this server (no WhatsApp door): the card stays hidden and is not asked again.
      clearInterval(timer);
      return;
    }
    if (!r.ok) return;
    data = await r.json();
    render();
  } catch (err) {
    console.warn("tasks", err);
  }
}

function mount() {
  card = h("section", { class: "card tasks", id: "tasks-card", "aria-labelledby": "h-tasks", hidden: true },
    h("div", { class: "card-head" }, h("h2", { id: "h-tasks" }, icon("list-checks"), h("span", { "data-tasks-title": true }, t("title")))),
    h("div", { "data-tasks-body": true }));
  const after = document.querySelector(".card.reminders");
  if (after) after.after(card);
  else document.querySelector("#grid")?.append(card);
  void load();
}

const timer = setInterval(() => {
  if (!document.hidden) void load();
}, REFRESH_MS);
mount();
