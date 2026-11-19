// Pako · panel: the meetings reviewed (src/meeting-review.ts answers GET /panel/api/meetings; 404 when Zoom is not connected, and the card never
// shows). Each meeting: its summary (Zoom's, or the one the computer wrote from the transcript) and what the review found: your to-dos, what
// others promised, the decisions, the meetings agreed and the open questions. Read only. Everything the server sends is put on the page as
// text, never as HTML.

const WORDS = {
  title: "Meetings",
  lead: "What each Zoom meeting left. I only message you your to-dos; the rest is here.",
  none: "No meetings reviewed yet.",
  pending: "Waiting for your computer to review it.",
  fallback: "Not reviewed: you got the summary as it is.",
  todos: "On you",
  promises: "Promised",
  decisions: "Decided",
  meetings: "Meetings agreed",
  questions: "Open questions",
  waits: "{who} is waiting",
  due: "by {due}",
  summary: "Summary",
};

const t = (key, vars = {}) => (WORDS[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
const str = (v) => (typeof v === "string" ? v : "");

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

/** The summary keeps its lines (set through the style object: the page's CSP allows no style attribute). */
function pre(text) {
  const p = h("p", {}, text);
  p.style.whiteSpace = "pre-line";
  return p;
}

let card = null;
let meetings = null;

/** One list of the review ("Te toca", "Prometieron"...), or nothing when it is empty. */
function section(key, items, line) {
  if (!Array.isArray(items) || !items.length) return [];
  return [h("h4", {}, t(key)), h("ul", {}, ...items.map((i) => h("li", {}, line(i))))];
}

const itemLine = (i) => {
  const extra = [str(i.who) ? t("waits", { who: str(i.who) }) : "", str(i.due) ? t("due", { due: str(i.due) }) : ""].filter(Boolean).join(", ");
  return `${str(i.title)}${extra ? ` (${extra})` : ""}`;
};
const promiseLine = (i) => `${str(i.who) ? `${str(i.who)}: ` : ""}${str(i.title)}${str(i.due) ? ` (${t("due", { due: str(i.due) })})` : ""}`;

function paint() {
  if (!card || !meetings) return;
  card.hidden = false;
  card.querySelector("[data-mt-title]").textContent = t("title");
  card.querySelector("[data-mt-lead]").textContent = t("lead");
  const list = card.querySelector("[data-mt-list]");
  list.replaceChildren();
  if (!meetings.length) {
    list.append(h("p", { class: "muted" }, t("none")));
    return;
  }
  for (const m of meetings) {
    const status = m.status === "pending" ? t("pending") : m.status === "fallback" ? t("fallback") : "";
    const body = [
      ...(status ? [h("p", { class: "muted" }, status)] : []),
      ...section("todos", m.todos, itemLine),
      ...section("promises", m.promises, promiseLine),
      ...section("meetings", m.meetings, itemLine),
      ...section("decisions", m.decisions, str),
      ...section("questions", m.questions, str),
      ...(str(m.summary) ? [h("h4", {}, t("summary")), pre(str(m.summary))] : []),
    ];
    list.append(h("details", {}, h("summary", {}, `${str(m.topic)} · ${str(m.when)}`), ...body));
  }
}

async function load() {
  try {
    const r = await fetch("/panel/api/meetings", { credentials: "same-origin", cache: "no-store" });
    // 404: Zoom is not connected. 401: signed out (the page itself handles it).
    if (!r.ok) return;
    const body = await r.json();
    meetings = Array.isArray(body?.meetings) ? body.meetings : [];
    paint();
  } catch {
    /* the server is restarting: the next load asks again */
  }
}

function mount() {
  const grid = document.querySelector("#grid");
  if (!grid) return;
  card = h("section", { class: "card meetings", id: "meetings-card", "aria-labelledby": "h-meetings", hidden: true },
    h("div", { class: "card-head" }, h("h2", { id: "h-meetings" }, h("i", { "data-lucide": "video" }), h("span", { "data-mt-title": true }))),
    h("p", { class: "muted", "data-mt-lead": true }),
    h("div", { "data-mt-list": true }));
  grid.append(card);
  window.lucide?.createIcons?.({ attrs: { "aria-hidden": "true" } });
  void load();
  setInterval(() => void load(), 5 * 60_000);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
