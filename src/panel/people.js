// Pako · panel · People: everyone Pako can see in what the owner connected (src/people-directory.ts), ranked so the people with open loops
// come first, then upcoming meetings, then the recent ones; a search box finds the rest. A person's card says how Pako knows them (each
// line with its source), the open loops both ways, the next meeting and the last contact, and, kept apart, what the owner told Pako. On a
// computer a person can be hidden, a brief for the next meeting asked for ("Prep", the brief's own run), and the owner's own record
// corrected or forgotten (the strict session cookie and the x-pako header, like STOP; the chat gets the receipt with its undo). Everything
// is put on the page as text, never as HTML. Its words are English, like all of Pako's fixed texts.

import { hideWhenEmpty } from "./dashboard-model.js";
import { localeFor } from "./i18n.js";

const REFRESH_MS = 60_000;
const CONFIRM_MS = 4000;
const PREP_POLL_MS = 5000;
const PREP_WAIT_MS = 4 * 60_000;

const EN = {
  title: "People",
  search: "Search people",
  searchHint: "Name, email or phone",
  empty: "Connect your contacts or calendar so Pako can fill this in. You can also tell Pako about someone in the chat: “my sister Ana's birthday is 14 March”.",
  nobody: "No one to show yet: Pako lists people once they write, meet or owe you something.",
  noMatch: "No one matches that.",
  more: "{n} more: search to find them.",
  hiddenLine: "{n} hidden",
  showHidden: "Show hidden",
  backToList: "Back to the list",
  unhide: "Show again",
  hide: "Hide",
  hiddenToast: "Hidden from the list.",
  unhiddenToast: "Back in the list.",
  loops: "Open loops",
  youOwe: "You owe",
  theyOwe: "They owe you",
  agreed: "Agreed meeting",
  due: "due {when}",
  told: "What you told me",
  toldNone: "Nothing yet. Tell Pako in the chat: “PERSON {name}: notes …”.",
  seen: "Seen in your calendar and mail",
  next: "Next meeting",
  last: "Last contact",
  seenNone: "Nothing recent.",
  via: "from {source}",
  prep: "Prep",
  prepping: "Writing a brief for your next meeting with them…",
  prepFailed: "I couldn't prepare it. Try again in a while.",
  prepDone: "Brief (also sent to the chat):",
  birthday: "Birthday",
  likes: "Likes",
  notes: "To remember",
  relation: "Relation",
  name: "Name",
  edit: "Correct",
  del: "Forget",
  sure: "Sure?",
  save: "Save",
  cancel: "Cancel",
  hintBirthday: "day/month, like 14/03 or 14/03/1990",
  hintList: "separated by ;",
  saved: "Saved. The chat has the button to undo it.",
  forgotten: "Forgotten. The chat has the button to undo it.",
  gone: "That person is no longer there.",
  changed: "Someone changed them meanwhile: here they are as they are now.",
  duplicate: "There's someone else by that name already.",
  bad: "I didn't understand the date: day/month, like 14/03.",
  failed: "Couldn't change it right now.",
  readOnly: "To change someone, write it in the chat: PERSON Ana: relation my cousin.",
};
/** Dates written the way the owner's country writes English (i18n.js localeFor). */
const localeOf = () => localeFor(document.documentElement.dataset.region);
function t(key, vars) {
  const s = EN[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m)) : s;
}

/** An element from a tag, attributes and children; text is always text. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const icon = (name) => h("i", { "data-lucide": name });

const state = {
  data: null, q: "", showHidden: false, open: null, editing: null, confirming: null, busy: false,
  /** Per person key: { id, status, text, at } of their prep. */
  preps: {},
};
let card = null;

/** "Thu 20 Nov, 10:00" (the time only when there is one that matters). */
function dateText(at, withTime = true) {
  return new Intl.DateTimeFormat(localeOf(), {
    weekday: "short", day: "numeric", month: "short", ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(at).replace(/\.(?=\s|,|$)/g, "");
}
/** "14 Mar" (with the year when it is known) for "03-14" or "1990-03-14". */
function birthdayText(b) {
  const m = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(b ?? "");
  if (!m) return "";
  const day = new Intl.DateTimeFormat(localeOf(), { timeZone: "UTC", day: "numeric", month: "short" })
    .format(Date.UTC(2028, Number(m[2]) - 1, Number(m[3]), 12)).replace(/\.$/, "");
  return m[1] ? `${day} ${m[1]}` : day;
}
const typedBirthday = (b) => {
  const m = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(b ?? "");
  return m ? `${m[3]}/${m[2]}${m[1] ? `/${m[1]}` : ""}` : "";
};

function toast(text) {
  const el = document.querySelector("#toast");
  if (!el) return;
  el.textContent = text;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2600);
}

const post = (path, body) =>
  fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-pako": "1" }, body: JSON.stringify(body) });

/** A correction or a forget of the owner's own record (the routes of src/people.ts). */
async function change(kind, body) {
  if (state.busy) return;
  state.busy = true;
  let said = "";
  try {
    const r = await post(`/panel/api/people/${kind}`, body);
    const out = await r.json().catch(() => ({}));
    if (r.ok) {
      said = t(kind === "edit" ? "saved" : "forgotten");
      state.editing = null;
    } else {
      said = Object.hasOwn(EN, out.error) ? t(out.error) : t("failed");
      if (out.error === "gone" || out.error === "changed") state.editing = null;
    }
  } catch (err) {
    console.error(err);
    said = t("failed");
  }
  state.busy = false;
  toast(said);
  if (state.editing === null) await load();
  else render();
}

async function hide(p, again) {
  if (state.busy) return;
  state.busy = true;
  try {
    const r = await post(`/panel/api/people/${again ? "unhide" : "hide"}`, { keys: p.keys });
    toast(r.ok ? t(again ? "unhiddenToast" : "hiddenToast") : t("failed"));
    if (r.ok && state.open === p.key) state.open = null;
  } catch {
    /* offline: said in a toast */
    toast(t("failed"));
  }
  state.busy = false;
  await load();
}

async function prep(p) {
  const was = state.preps[p.key];
  if (was && was.status === "pending") return;
  state.preps[p.key] = { status: "pending", text: "", at: Date.now() };
  render();
  try {
    const r = await post("/panel/api/people/prep", { key: p.key });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.task) throw new Error(out.error ?? String(r.status));
    state.preps[p.key] = { ...out.task, at: Date.now() };
  } catch (err) {
    console.warn("prep", err);
    state.preps[p.key] = { status: "failed", text: "", at: Date.now() };
  }
  render();
  void watchPrep(p.key);
}

/** Asks after a prep until its brief is written (it also arrives in the chat), or it failed, or it took too long. */
async function watchPrep(key) {
  for (;;) {
    const job = state.preps[key];
    if (!job || job.status !== "pending" || !job.id) return;
    if (Date.now() - job.at > PREP_WAIT_MS) {
      state.preps[key] = { ...job, status: "failed" };
      render();
      return;
    }
    await new Promise((ok) => setTimeout(ok, PREP_POLL_MS));
    try {
      const r = await fetch(`/panel/api/people/prep?id=${encodeURIComponent(job.id)}`, { credentials: "same-origin", cache: "no-store" });
      if (r.status === 404) state.preps[key] = { ...job, status: "failed" };
      else if (r.ok) {
        const out = await r.json();
        if (out.task) state.preps[key] = { ...job, ...out.task };
      }
    } catch {
      // A missed look is tried again at the next turn.
    }
    render();
  }
}

function field(label, value, hint, attrs = {}) {
  const input = h("input", { class: "tg-input", type: "text", "aria-label": label, placeholder: hint ?? "", ...attrs });
  input.value = value;
  return { input, el: h("label", { class: "small", style: "display:block;margin-top:6px" }, h("span", { class: "muted" }, label), input) };
}

function editor(p) {
  const name = field(t("name"), p.name, "", { maxlength: "60" });
  const relation = field(t("relation"), p.relation ?? "", "", { maxlength: "60" });
  const birthday = field(t("birthday"), typedBirthday(p.birthday), t("hintBirthday"), { maxlength: "10" });
  const likes = field(t("likes"), (p.likes ?? []).join("; "), t("hintList"));
  const notes = field(t("notes"), (p.notes ?? []).join("; "), t("hintList"));
  const split = (s) => s.split(";").map((x) => x.trim()).filter(Boolean);
  const save = h("button", {
    type: "button", class: "btn primary",
    onclick: () => void change("edit", {
      id: p.id, was: p.updated, name: name.input.value, relation: relation.input.value, birthday: birthday.input.value,
      likes: split(likes.input.value), notes: split(notes.input.value),
    }),
  }, icon("check"), t("save"));
  const cancel = h("button", { type: "button", class: "btn ghost", onclick: () => ((state.editing = null), render()) }, t("cancel"));
  return h("div", { class: "people-edit" }, name.el, relation.el, birthday.el, likes.el, notes.el, h("div", { class: "tg-form", style: "margin-top:8px" }, save, cancel));
}

function askForget(own) {
  if (state.confirming !== own.id) {
    state.confirming = own.id;
    render();
    clearTimeout(askForget.timer);
    askForget.timer = setTimeout(() => ((state.confirming = null), render()), CONFIRM_MS);
    return;
  }
  clearTimeout(askForget.timer);
  state.confirming = null;
  void change("delete", { id: own.id, was: own.updated });
}

const section = (title, ...lines) => h("div", { class: "people-sec" }, h("div", { class: "people-h" }, title), ...lines);
const sourced = (text, source) => h("div", { class: "small" }, text, h("span", { class: "muted" }, ` · ${t("via", { source })}`));

/** The open card of one person: loops both ways, the owner's own words, then what was seen, each line with its source. */
function details(p) {
  const parts = [];
  const ids = [...p.emails, ...p.phones, ...(p.org ? [p.org] : [])];
  if (ids.length) parts.push(h("div", { class: "small muted" }, ids.join(" · ")));
  if (p.loops.length) {
    const DIR = { you_owe: t("youOwe"), they_owe: t("theyOwe"), agreed: t("agreed") };
    parts.push(section(t("loops"), ...p.loops.map((l) => h("div", { class: `small people-loop d-${l.dir}` },
      h("strong", {}, `${DIR[l.dir] ?? ""}: `), l.title, l.due ? h("span", {}, ` · ${t("due", { when: dateText(l.due) })}`) : null,
      h("span", { class: "muted" }, ` · ${t("via", { source: `${l.source}, ${dateText(l.at, false)}` })}`)))));
  }
  // The owner's own words, kept apart from anything derived: only these are facts.
  const told = [];
  if (state.editing && p.own && state.editing === p.own.id) told.push(editor(p.own));
  else {
    for (const x of p.told) told.push(h("div", { class: "small" }, x.text, h("span", { class: "muted" }, ` · ${dateText(x.at, false)}`)));
    if (!p.told.length) told.push(h("div", { class: "small muted" }, t("toldNone", { name: p.name.split(" ")[0] })));
    if (p.own && state.data.edit) {
      const sure = state.confirming === p.own.id;
      told.push(h("div", { class: "people-actions" },
        h("button", { type: "button", class: "tg-other", disabled: state.busy, onclick: () => ((state.editing = p.own.id), (state.confirming = null), render()) }, t("edit")),
        h("button", { type: "button", class: "tg-other", disabled: state.busy, style: sure ? "color:var(--danger)" : null, onclick: () => askForget(p.own) },
          sure ? t("sure") : t("del"))));
    }
  }
  parts.push(section(t("told"), ...told));
  const seen = [];
  if (p.next) seen.push(sourced(`${t("next")}: ${p.next.label} · ${dateText(p.next.at)}`, p.next.source));
  if (p.last) seen.push(sourced(`${t("last")}: ${p.last.label} · ${dateText(p.last.at)}`, p.last.source));
  if (!seen.length) seen.push(h("div", { class: "small muted" }, t("seenNone")));
  parts.push(section(t("seen"), ...seen));
  const job = state.preps[p.key];
  const acts = [];
  if (state.data.prep && !state.showHidden) {
    acts.push(h("button", { type: "button", class: "btn primary", disabled: job?.status === "pending", onclick: () => void prep(p) }, icon("notebook-pen"), t("prep")));
  }
  if (state.data.edit) {
    acts.push(h("button", { type: "button", class: "tg-other", disabled: state.busy, onclick: () => void hide(p, state.showHidden) }, state.showHidden ? t("unhide") : t("hide")));
  }
  if (acts.length) parts.push(h("div", { class: "people-actions" }, ...acts));
  if (job?.status === "pending") parts.push(h("p", { class: "small muted" }, t("prepping")));
  else if (job?.status === "failed" || job?.status === "old") parts.push(h("p", { class: "small", style: "color:var(--danger)" }, t("prepFailed")));
  else if (job?.status === "done" && job.text) parts.push(h("div", { class: "people-prep small" }, h("div", { class: "muted" }, t("prepDone")), h("div", { class: "people-prep-text" }, job.text)));
  return h("div", { class: "people-card" }, ...parts);
}

function row(p) {
  const open = state.open === p.key;
  const hint = p.loops.length ? `${p.loops.length} ${p.loops.length === 1 ? "open loop" : "open loops"}`
    : p.tier === "soon" && p.next ? `📅 ${dateText(p.next.at)}`
    : p.last ? dateText(p.last.at, false) : "";
  const head = h("button", {
    type: "button", class: "people-head", "aria-expanded": open ? "true" : "false",
    onclick: () => ((state.open = open ? null : p.key), (state.editing = null), render()),
  },
  h("span", { class: "row" }, h("span", { class: "subj" }, p.name), hint ? h("span", { class: "ago" }, hint) : null),
  p.knownText ? h("span", { class: "small muted people-known" }, p.knownText) : null);
  return h("li", { class: `item people-item t-${p.tier}` }, h("span", { class: "ic" }, icon(p.loops.length ? "user-check" : "user")),
    h("div", { class: "body" }, head, open ? details(p) : null));
}

function render() {
  if (!card || !state.data) return;
  // The dashboard's rule: a section with nothing in it is not shown. No sources yet means no People card at all (the dashboard's one
  // suggestion line already says what to connect); a search with no match keeps the card, since the person is using it.
  if (!hideWhenEmpty(card, !state.data.empty, { keep: !!state.q.trim() || state.showHidden })) return;
  card.querySelector("[data-people-title]").textContent = t("title");
  const input = card.querySelector("[data-people-q]");
  input.placeholder = t("searchHint");
  input.setAttribute("aria-label", t("search"));
  const d = state.data;
  const people = Array.isArray(d.people) ? d.people : [];
  const parts = [];
  if (d.empty) parts.push(h("p", { class: "muted small" }, t("empty")));
  else if (!people.length) parts.push(h("p", { class: "muted small" }, state.q.trim() || state.showHidden ? t("noMatch") : t("nobody")));
  else parts.push(h("ul", { class: "list compact" }, ...people.map(row)));
  if (d.more) parts.push(h("p", { class: "muted small" }, t("more", { n: d.more })));
  if (!d.edit && people.some((p) => p.own)) parts.push(h("p", { class: "muted small" }, t("readOnly")));
  const foot = [];
  if (state.showHidden) foot.push(h("button", { type: "button", class: "tg-other", onclick: () => ((state.showHidden = false), (state.open = null), void load()) }, t("backToList")));
  else if (d.hidden) {
    foot.push(h("span", { class: "small muted" }, t("hiddenLine", { n: d.hidden })), " · ",
      h("button", { type: "button", class: "tg-other", onclick: () => ((state.showHidden = true), (state.open = null), void load()) }, t("showHidden")));
  }
  if (foot.length) parts.push(h("div", { class: "people-foot" }, ...foot));
  card.querySelector("[data-people-body]").replaceChildren(...parts);
  window.lucide?.createIcons?.({ attrs: { "aria-hidden": "true" } });
}

let loading = 0;
async function load() {
  // Not while the owner's own record is being corrected: the half-written words stay where they are.
  if (state.editing !== null || state.busy) return;
  const mine = ++loading;
  try {
    const qs = new URLSearchParams();
    if (state.q.trim()) qs.set("q", state.q.trim());
    if (state.showHidden) qs.set("hidden", "1");
    const r = await fetch(`/panel/api/people/directory${qs.size ? `?${qs}` : ""}`, { credentials: "same-origin", cache: "no-store" });
    if (mine !== loading) return; // a newer search went out meanwhile: its answer is the one shown
    if (r.status === 404) {
      clearInterval(timer);
      return;
    }
    if (!r.ok) return;
    state.data = await r.json();
    render();
  } catch (err) {
    console.warn("people", err);
  }
}

function mount() {
  let typing = null;
  const q = h("input", {
    class: "tg-input people-q", type: "search", "data-people-q": true, autocomplete: "off", maxlength: "80",
    oninput: (e) => {
      state.q = e.target.value;
      clearTimeout(typing);
      typing = setTimeout(() => void load(), 250);
    },
  });
  card = h("section", { class: "card people", id: "people-card", "aria-labelledby": "h-people", hidden: true },
    h("div", { class: "card-head" }, h("h2", { id: "h-people" }, icon("users"), h("span", { "data-people-title": true }, t("title")))),
    q,
    h("div", { "data-people-body": true }));
  const after = document.querySelector("#tasks-card") ?? document.querySelector(".card.reminders");
  if (after) after.after(card);
  else document.querySelector("#grid")?.append(card);
  void load();
}

const timer = setInterval(() => {
  // Not while a card is open: the person being read stays as they are.
  if (!document.hidden && state.open === null) void load();
}, REFRESH_MS);
mount();
