// Pako · panel, the Memory card: what Pako knows about the owner in a sentence, then every note under its number (the same number NOTAS /
// NOTES gives in the chat). On a person's computer each note can be corrected or deleted here (the routes in src/memory-panel.ts, with the
// signed cookie and the x-pako header, like STOP); a server's panel reads them only, and says how to change them in the chat.
// It takes over the card's notes from app.js (which keeps drawing its own copy, hidden: the card still shows notes if this file fails).
// Everything a note says is put on the page as text, never as HTML.

import { h } from "./dom.js";

const REFRESH_MS = 60_000;
const CONFIRM_MS = 4_000;

const WORDS = {
  knowsNone: "Pako doesn't keep anything about you yet. When you tell it something to remember, it shows up here.",
  knowsOne: "Pako keeps **1 note** about you.",
  knowsMany: "Pako keeps **{n} notes** about you (room for {max}).",
  knowsCalls: " It also remembers a summary of your **last {n} calls**.",
  knowsCall: " It also remembers a summary of your **last call**.",
  knowsLatest: " The latest thing it noted: “{text}”.",
  knowsUse: " It uses them when it talks to you and when it calls you.",
  canEdit: " If something is wrong, correct it or delete it here.",
  readOnly: " To change one, write in the chat **EDIT 3: the new text** or **FORGET 3**.",
  unread: "I couldn't read the notes right now.",
  edit: "Correct",
  del: "Delete",
  sure: "Sure? Press again",
  save: "Save",
  cancel: "Cancel",
  editAria: "New text for note {id}",
  saved: "Note {id} corrected",
  deleted: "Note {id} deleted",
  gone: "That note isn't there any more: the list is up to date.",
  changed: "That note had changed: look at it again before you touch it.",
  duplicate: "Another note already says that.",
  long: "Too long: 300 characters at most.",
  empty: "Write the note's text, or delete it.",
  failed: "I couldn't change it. Try again in a moment.",
};

function t(key, vars) {
  const s = WORDS[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m)) : s;
}

/** A text whose **parts** are bold, as nodes: nothing is parsed as HTML. */
const rich = (text) => text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? h("b", {}, part) : part));
const icon = (name) => h("i", { "data-lucide": name });
const paintIcons = () => window.lucide?.createIcons?.({ attrs: { "aria-hidden": "true" } });
const short = (s, max = 90) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

function toast(text) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 2800);
}

const card = document.querySelector(".card.memory");
const old = document.getElementById("notes");
const state = { data: null, failed: false, editing: null, draft: null, confirming: null, busy: false };
let know = null;
let list = null;

if (card && old) {
  know = h("p", { class: "hint", id: "mem-know", "aria-live": "polite" });
  list = h("ul", { class: "list compact", id: "mem-list" });
  old.hidden = true;
  old.after(know, list);
  void load();
  setInterval(() => void load(), REFRESH_MS);
  document.getElementById("refresh")?.addEventListener("click", () => void load());
}

async function load() {
  // Not while a note is being corrected: the person's half-written words stay where they are.
  if (state.editing !== null || state.busy) return;
  try {
    const r = await fetch("/panel/api/memory", { credentials: "same-origin", cache: "no-store" });
    if (r.status === 401) return;
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state.data = await r.json();
    state.failed = false;
  } catch (err) {
    console.error(err);
    state.failed = true;
  }
  render();
}

function render() {
  if (!know || !list) return;
  const d = state.data;
  if (!d) {
    know.replaceChildren(state.failed ? t("unread") : "");
    list.replaceChildren();
    return;
  }
  const n = d.notes.length;
  const latest = n ? d.notes.reduce((a, b) => (b.at >= a.at ? b : a)) : null;
  const parts = !n ? [t("knowsNone")] : [n === 1 ? t("knowsOne") : t("knowsMany", { n, max: d.max })];
  if (d.calls) parts.push(d.calls === 1 ? t("knowsCall") : t("knowsCalls", { n: d.calls }));
  if (latest) parts.push(t("knowsLatest", { text: short(latest.text) }), t("knowsUse"), d.editable ? t("canEdit") : t("readOnly"));
  know.replaceChildren(icon("sparkles"), h("span", {}, ...rich(parts.join(""))));
  // Newest first, as the rest of the panel; each with the number the chat uses.
  list.replaceChildren(...[...d.notes].reverse().map((note) => row(note, d.editable)));
  if (state.failed) know.append(h("span", { class: "muted small" }, ` ${t("unread")}`));
  paintIcons();
}

function row(note, editable) {
  const num = h("span", { class: "ic", "aria-hidden": "true", style: "font-weight:750;font-size:12.5px" }, String(note.id));
  if (state.editing === note.id) {
    const input = h("textarea", { class: "tg-input", rows: "3", maxlength: "300", "aria-label": t("editAria", { id: note.id }) });
    // What the person typed survives a redraw (a refused save).
    input.value = state.draft ?? note.text;
    input.addEventListener("input", () => (state.draft = input.value));
    const save = h("button", { type: "button", class: "btn primary", onclick: () => void change("edit", note, input.value) }, icon("check"), t("save"));
    const cancel = h("button", { type: "button", class: "btn ghost", onclick: () => ((state.editing = null), (state.draft = null), render()) }, t("cancel"));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") cancel.click();
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save.click();
    });
    queueMicrotask(() => input.focus());
    return h("li", { class: "item" }, num, h("div", { class: "body" }, input, h("div", { class: "tg-form", style: "margin-top:8px" }, save, cancel)));
  }
  const body = h("div", { class: "body" }, h("div", { class: "what", style: "display:block;color:var(--text)" }, note.text));
  if (editable) {
    const sure = state.confirming === note.id;
    body.append(h("div", { class: "row", style: "justify-content:flex-start;gap:14px;margin-top:4px" },
      h("button", { type: "button", class: "tg-other", disabled: state.busy, onclick: () => ((state.editing = note.id), (state.draft = null), (state.confirming = null), render()) }, t("edit")),
      h("button", { type: "button", class: "tg-other", disabled: state.busy, style: sure ? "color:var(--danger)" : null, onclick: () => askDelete(note) },
        sure ? t("sure") : t("del"))));
  }
  return h("li", { class: "item" }, num, body);
}

/** Deleting asks twice: the first press turns the button into "Sure?", for a few seconds. */
function askDelete(note) {
  if (state.confirming !== note.id) {
    state.confirming = note.id;
    render();
    clearTimeout(askDelete.timer);
    askDelete.timer = setTimeout(() => ((state.confirming = null), render()), CONFIRM_MS);
    return;
  }
  clearTimeout(askDelete.timer);
  state.confirming = null;
  void change("delete", note);
}

async function change(kind, note, text) {
  if (state.busy) return;
  state.busy = true;
  render();
  let said = "";
  try {
    const body = kind === "edit" ? { id: note.id, text, was: note.text } : { id: note.id, was: note.text };
    const r = await fetch(`/panel/api/memory/${kind}`, {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-pako": "1" }, body: JSON.stringify(body),
    });
    const out = await r.json().catch(() => ({}));
    if (r.ok) {
      said = out.note ? t(kind === "edit" ? "saved" : "deleted", { id: note.id }) : "";
      state.editing = null;
    } else {
      said = Object.hasOwn(WORDS, out.error) ? t(out.error) : t("failed");
      // The note is not what the page showed (or not there): the page shows it as it is now, and the correction starts again from there.
      if (out.error === "gone" || out.error === "changed") state.editing = null;
    }
  } catch (err) {
    console.error(err);
    said = t("failed");
  }
  state.busy = false;
  if (said) toast(said);
  if (state.editing === null) {
    state.draft = null;
    await load();
  }
  else render();
}
