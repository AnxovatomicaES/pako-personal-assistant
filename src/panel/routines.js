// Pako · panel · routines and watches. Its own card, put after the lists and tasks: the routines (a prompt on a schedule) with their next
// time, and what Pako watches for (mail, calendar, Slack). Read from /panel/api/routines (src/routines.ts); on a computer one can be removed
// here (the strict session cookie and the x-pako header, like STOP). A server's panel only shows them. Without the route the card stays hidden.
// Everything is put on the page as text, never as HTML. Its words are its own (English, here).

import { localeFor } from "./i18n.js";

const REFRESH_MS = 60_000;

const WORDS = {
  title: "Routines and watches",
  routines: "Routines",
  watches: "What I'm watching",
  noRoutines: "No routines. Ask Pako: “every Friday at 18:00 ask me about the weekly report”.",
  noWatches: "Nothing watched. Ask Pako: “tell me if an email from my bank arrives”.",
  next: "next: {when}",
  paused: "paused",
  once: "once",
  always: "ongoing",
  day: "every day",
  weekday: "every weekday",
  week: "every week",
  month: "every month",
  year: "every year",
  mail: "email",
  calendar: "calendar",
  slack: "Slack",
  from: "from {list}",
  with: "with {list}",
  remove: "Remove “{text}”",
  failed: "Couldn't remove it right now",
};
/** Dates written the way the owner's country writes English (i18n.js localeFor). */
const localeOf = () => localeFor(document.documentElement.dataset.region);
/** A text of this card, its {placeholders} filled from vars. */
function t(key, vars) {
  const s = WORDS[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m)) : s;
}

/** An element from a tag, attributes and children; text is always text. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const icon = (name) => h("i", { "data-lucide": name });

let data = null;
let card = null;
let busy = false;

function toast(text) {
  const el = document.querySelector("#toast");
  if (!el) return;
  el.textContent = text;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2600);
}

async function remove(kind, id) {
  if (busy) return;
  busy = true;
  try {
    const r = await fetch("/panel/api/routines/remove", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-pako": "1" },
      body: JSON.stringify({ kind, id }),
    });
    if (!r.ok && r.status !== 404) toast(t("failed"));
  } catch {
    /* offline: said in a toast */
    toast(t("failed"));
  } finally {
    busy = false;
  }
  await load();
}

const when = (at) => new Intl.DateTimeFormat(localeOf(), {
  timeZone: data.timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
}).format(at);

/** One row: the number, the words, what it is for, and a remove button (on a computer). */
function row({ n, text, note, onRemove }) {
  const body = h("div", { class: "body" },
    h("div", { class: "row" }, h("span", { class: "subj" }, `${n} · ${text}`), note ? h("span", { class: "ago" }, note) : null));
  const del = data.edit ? h("button", { class: "ic", type: "button", "aria-label": t("remove", { text }), onclick: onRemove }, icon("x")) : null;
  return h("li", { class: "item" }, h("span", { class: "ic" }, icon("repeat")), body, del);
}

function render() {
  if (!card || !data) return;
  card.hidden = false;
  card.querySelector("[data-routines-title]").textContent = t("title");
  const routines = Array.isArray(data.routines) ? data.routines : [];
  const watches = Array.isArray(data.watches) ? data.watches : [];
  const parts = [h("h3", { class: "muted small" }, t("routines"))];
  if (!routines.length) parts.push(h("p", { class: "muted small" }, t("noRoutines")));
  else {
    parts.push(h("ul", { class: "list compact" }, ...routines.slice(0, 20).map((r) => row({
      n: r.n,
      text: r.text,
      note: [WORDS[r.every] ? t(r.every) : "", r.paused ? t("paused") : t("next", { when: when(r.next) })].filter(Boolean).join(" · "),
      onRemove: () => remove("routine", r.id),
    }))));
  }
  parts.push(h("h3", { class: "muted small" }, t("watches")));
  if (!watches.length) parts.push(h("p", { class: "muted small" }, t("noWatches")));
  else {
    parts.push(h("ul", { class: "list compact" }, ...watches.slice(0, 20).map((w) => row({
      n: w.n,
      text: w.text,
      note: [
        t(w.on === "mail" || w.on === "calendar" ? w.on : "slack"),
        Array.isArray(w.from) && w.from.length ? t("from", { list: w.from.join(", ") }) : "",
        Array.isArray(w.words) && w.words.length ? t("with", { list: w.words.join(", ") }) : "",
        w.paused ? t("paused") : t(w.once ? "once" : "always"),
      ].filter(Boolean).join(" · "),
      onRemove: () => remove("watch", w.id),
    }))));
  }
  card.querySelector("[data-routines-body]").replaceChildren(...parts);
  window.lucide?.createIcons?.({ attrs: { "aria-hidden": "true" } });
}

async function load() {
  try {
    const r = await fetch("/panel/api/routines", { credentials: "same-origin" });
    if (r.status === 404) {
      // No routines on this server (no WhatsApp door): the card stays hidden and is not asked again.
      clearInterval(timer);
      return;
    }
    if (!r.ok) return;
    data = await r.json();
    render();
  } catch (err) {
    console.warn("routines", err);
  }
}

function mount() {
  card = h("section", { class: "card routines", id: "routines-card", "aria-labelledby": "h-routines", hidden: true },
    h("div", { class: "card-head" }, h("h2", { id: "h-routines" }, icon("repeat"), h("span", { "data-routines-title": true }, t("title")))),
    h("div", { "data-routines-body": true }));
  // After the lists and tasks card when it is there (it is added by its own script), else after the reminders.
  const after = document.querySelector("#tasks-card") ?? document.querySelector(".card.reminders");
  if (after) after.after(card);
  else document.querySelector("#grid")?.append(card);
  void load();
}

const timer = setInterval(() => {
  if (!document.hidden) void load();
}, REFRESH_MS);
mount();
