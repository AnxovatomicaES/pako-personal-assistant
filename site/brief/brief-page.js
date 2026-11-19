// Pako · the written brief's page (/panel/brief, src/brief-v2.ts). It reads today's brief (GET /panel/api/brief/today) and draws it as text,
// never as HTML: the opening, the focus with its offer ("Let's do it"), the to-dos with a box that closes their follow-up, the updates, the day
// with "Prep me" per meeting, and the sources each item comes from. Nothing is loaded from the network but this server.
// Pako's figure (its CSS twin, figure-twin.js) sits by the name in the header: it thinks while the brief is written, is glad at a to-do done.

import { mountTwins } from "./figure-twin.js";
import { localeFor } from "./i18n.js";

const figure = (name, detail) => dispatchEvent(new CustomEvent(`pako:${name}`, detail === undefined ? undefined : { detail }));

const WORDS = {
  skip: "Skip to the brief", back: "← Panel", title: "The {day} Brief", eyebrow: "{date} · prepared at {time}",
  eyebrowNone: "{date}", focus: "Push your work forward", focusKicker: "Most valuable today", todos: "Top to-dos",
  updates: "New updates", day: "Your day", doIt: "Let's do it", prep: "Prep me", unconfirmed: "(time unconfirmed)",
  checked: "Checked: ", working: "Preparing it on the assistant's computer…", failed: "I couldn't prepare it. Try again in a while.",
  old: "For this, the assistant's computer needs an update (git pull in its Pako folder).", again: "Again",
  none: "No written brief for today yet.", make: "Prepare it now", making: "Writing your brief… (usually about a minute)",
  makeFailed: "I couldn't ask for it. Is the assistant's computer on?", off: "The written brief is off (BRIEF_SMART=off).",
  used: "Sources read:", colophon: "Written by Pako from what it could read; every item cites where it comes from.", noDay: "Nothing on your calendar today.",
  markDone: "Mark as done", unread: "I couldn't read the brief. Try reloading.", allDay: "all day", until: "until {end}",
  over: "(over)", useful: "Useful", notUseful: "Not useful",
  icons: { slack: "Slack", zoom: "Zoom", mail: "Email", calendar: "Calendar", tasks: "Tasks", people: "People" },
};
/** Dates written the way the owner's country writes English (i18n.js localeFor). */
const localeOf = () => localeFor(document.documentElement.dataset.region);
/** The sources' names. */
const iconName = (k) => WORDS.icons[k] ?? k;
const t = (key, vars = {}) => String(WORDS[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));

const SVG = "http://www.w3.org/2000/svg";
/** Simple line icons, drawn here (no network, no library). */
const PATHS = {
  slack: ["M9 3v18", "M15 3v18", "M3 9h18", "M3 15h18"],
  zoom: ["M3 7.5A1.5 1.5 0 0 1 4.5 6h9A1.5 1.5 0 0 1 15 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 3 16.5z", "M15 10.5l6-3.5v10l-6-3.5"],
  mail: ["M3 6h18v12H3z", "M3 7l9 6 9-6"],
  calendar: ["M4 5h16v15H4z", "M4 10h16", "M8 3v4", "M16 3v4"],
  tasks: ["M4 4h16v16H4z", "M8 12l3 3 5-6"],
  people: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4 21c0-4 3.6-7 8-7s8 3 8 7"],
  search: ["M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z", "M21 21l-5-5"],
};
function icon(name, size = 14) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("class", "ico");
  svg.setAttribute("aria-hidden", "true");
  for (const d of PATHS[name] ?? PATHS.tasks) {
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : String(v));
  for (const c of children) if (c !== null && c !== undefined && c !== "") node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

const main = document.querySelector("#main");
const colophon = document.querySelector("#colophon");
let state = null;
let polling = null;
/** This brief's 👍/👎 on its items (src/quality.ts): "t0" → "up". */
let votes = {};

async function api(path, body) {
  const r = await fetch(path, body === undefined
    ? { credentials: "same-origin" }
    : { method: "POST", credentials: "same-origin", headers: { "x-pako": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
  if (r.status === 401) {
    location.href = "/panel";
    throw new Error("sign in");
  }
  return { status: r.status, body: await r.json().catch(() => null) };
}

function sourcesOf(ids, refs) {
  const box = el("div", { class: "sources" });
  for (const id of ids) {
    const ref = refs.find((r) => r.id === id);
    if (!ref) continue;
    box.append(el("span", { class: `src ${ref.icon}`, title: ref.label }, icon(ref.icon, 13), ref.label));
  }
  return box;
}

/** A quiet 👍/👎 on a to-do or an update: kept by src/quality.ts, never sent anywhere. */
function vote(kind, i, title) {
  const key = `${kind[0]}${i}`;
  const box = el("div", { class: "vote" });
  for (const [verdict, glyph, label] of [["up", "👍", t("useful")], ["down", "👎", t("notUseful")]]) {
    const b = el("button", { class: "thumb", type: "button", "aria-label": `${label}: ${title}`, "aria-pressed": votes[key] === verdict ? "true" : "false" }, glyph);
    b.addEventListener("click", async () => {
      const r = await api("/panel/api/quality/brief", { doc: state?.doc?.id, kind, i, verdict }).catch(() => null);
      if (r?.status === 409) return void (await load());
      if (r?.status !== 200) return;
      votes[key] = verdict;
      for (const x of box.querySelectorAll("button")) x.setAttribute("aria-pressed", x === b ? "true" : "false");
    });
    box.append(b);
  }
  return box;
}

function taskDoc(kind, ref) {
  const task = (state?.tasks ?? []).filter((x) => x.kind === kind && (kind === "do" || x.ref === ref)).pop();
  if (!task) return null;
  if (task.status === "done") return el("div", { class: "doc" }, task.text);
  if (task.status === "pending") return el("div", { class: "doc muted", role: "status" }, t("working"));
  return el("div", { class: "doc muted", role: "status" }, task.status === "old" ? t("old") : t("failed"));
}
const taskOf = (kind, ref) => (state?.tasks ?? []).filter((x) => x.kind === kind && (kind === "do" || x.ref === ref)).pop();

async function ask(kind, ref, button) {
  button.disabled = true;
  try {
    // The brief this page shows: a newer one (409) is loaded instead, never asked by this page's indexes.
    await api("/panel/api/brief/ask", { kind, ...(ref !== undefined ? { ref } : {}), doc: state?.doc?.id });
  } finally {
    await load();
  }
}

function render() {
  main.replaceChildren();
  const s = state;
  const tz = s?.timeZone || undefined;
  const now = new Date();
  const dayName = new Intl.DateTimeFormat(localeOf(), { timeZone: tz, weekday: "long" }).format(s?.doc ? new Date(s.doc.at) : now);
  const date = new Intl.DateTimeFormat(localeOf(), { timeZone: tz, weekday: "long", day: "numeric", month: "long" })
    .format(s?.doc ? new Date(s.doc.at) : now);
  document.querySelector("#title").textContent = t("title", { day: dayName[0].toUpperCase() + dayName.slice(1) });
  document.querySelector("#eyebrow").textContent = s?.doc
    ? t("eyebrow", { date, time: new Intl.DateTimeFormat(localeOf(), { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date(s.doc.at)) })
    : t("eyebrowNone", { date });
  document.querySelector("#back").textContent = t("back");
  document.querySelector(".skip").textContent = t("skip");
  document.title = `Pako · ${document.querySelector("#title").textContent}`;

  if (!s) {
    main.append(el("p", { class: "empty" }, t("unread")));
    return;
  }
  const doc = s.doc;
  if (!doc) {
    const button = el("button", { class: "btn", type: "button" }, t("make"));
    const note = el("p", { class: "empty", role: "status" }, s.pending ? t("making") : t("none"));
    button.disabled = !!s.pending;
    button.addEventListener("click", async () => {
      button.disabled = true;
      note.textContent = t("making");
      figure("waiting", { on: true }); // Pako thinks from the click on; load() lets go once the brief is no longer pending
      const r = await api("/panel/api/brief/make", {}).catch(() => null);
      if (!r || r.status !== 200 || !r.body?.ok) {
        note.textContent = r?.status === 404 ? t("off") : t("makeFailed");
        button.disabled = false;
        figure("waiting", { on: false });
        figure("error");
        return;
      }
      watch();
    });
    main.append(el("section", { class: "section" }, note, button));
    colophon.hidden = true;
    return;
  }

  if (doc.opening) main.append(el("p", { class: "opening" }, doc.opening));

  if (doc.focus) {
    const f = doc.focus;
    const box = el("div", { class: "focus" }, el("h3", {}, f.title), f.story ? el("p", {}, f.story) : null);
    if (f.offer) {
      const go = el("button", { class: "btn", type: "button" }, t("doIt"));
      const task = taskOf("do");
      if (task && (task.status === "pending" || task.status === "done")) go.disabled = true;
      go.addEventListener("click", () => ask("do", undefined, go));
      box.append(el("div", { class: "offer" }, el("p", {}, f.offer), go));
    }
    box.append(sourcesOf(f.sources, doc.refs));
    const out = taskDoc("do");
    if (out) box.append(out);
    main.append(el("section", { class: "section", "aria-labelledby": "h-focus" },
      el("h2", { id: "h-focus" }, t("focus"), el("span", { class: "kicker" }, t("focusKicker"))), box));
  }

  if (doc.todos.length) {
    const list = el("ul", { class: "todos" });
    doc.todos.forEach((x, i) => {
      // A follow-up closed from here stays closed: its box cannot be unticked.
      const input = el("input", { type: "checkbox", "aria-label": `${t("markDone")}: ${x.title}`, checked: x.done, disabled: !!(x.done && x.loopId) });
      const li = el("li", { class: `todo${x.done ? " done" : ""}` },
        el("label", { class: "check" }, input, el("span", { class: "box", "aria-hidden": "true" })),
        el("div", {},
          el("h3", {}, x.title),
          x.context ? el("p", {}, x.context) : null,
          x.checked ? el("p", { class: "checked" }, icon("search", 13), `${t("checked")}${x.checked}`) : null,
          sourcesOf(x.sources, doc.refs), vote("todo", i, x.title)));
      input.addEventListener("change", async () => {
        li.classList.toggle("done", input.checked);
        const r = await api("/panel/api/brief/check", { i, done: input.checked, doc: doc.id }).catch(() => null);
        if (r?.status === 409) return void (await load());
        if (!r || r.status !== 200 || !r.body?.ok) {
          input.checked = !input.checked;
          li.classList.toggle("done", input.checked);
        } else {
          if (input.checked) figure("happy");
          if (input.checked && x.loopId) input.disabled = true;
        }
      });
      list.append(li);
    });
    main.append(el("section", { class: "section", "aria-labelledby": "h-todos" }, el("h2", { id: "h-todos" }, t("todos")), list));
  }

  if (doc.updates.length) {
    const list = el("ol", { class: "updates" });
    doc.updates.forEach((u, i) => {
      list.append(el("li", { class: "update" }, el("span", { class: "num", "aria-hidden": "true" }, String(u.n)),
        el("div", {}, u.tag ? el("span", { class: "tag" }, u.tag) : null, el("h3", {}, u.title), u.text ? el("p", {}, u.text) : null,
          sourcesOf(u.sources, doc.refs), vote("update", i, u.title))));
    });
    main.append(el("section", { class: "section", "aria-labelledby": "h-updates" }, el("h2", { id: "h-updates" }, t("updates")), list));
  }

  const day = el("ol", { class: "timeline" });
  // What is over today is marked done (the same rule as src/brief-v2.ts dayItemOver), so a page read at 17:00 shows what is left.
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const mins = (x) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3, 5));
  const over = (d) => doc.day === today && !d.allDay && (!d.time ? !!d.end && mins(d.end) <= mins(hm)
    : d.end ? mins(d.end) >= mins(d.time) && mins(d.end) <= mins(hm) : mins(d.time) + 60 <= mins(hm));
  doc.dayItems.forEach((d, i) => {
    const row = el("div", { class: "row" }, sourcesOf(d.sources, doc.refs));
    // "Prep me" on every meeting of the day: a prep note from what is known about it.
    const b = el("button", { class: "ghost", type: "button" }, t("prep"));
    const task = taskOf("prep", i);
    if (task && (task.status === "pending" || task.status === "done")) b.disabled = true;
    b.addEventListener("click", () => ask("prep", i, b));
    row.append(b);
    const done = over(d);
    day.append(el("li", { class: done ? "slot over" : "slot" },
      d.allDay ? el("div", { class: "time" }, t("allDay"))
        : !d.time ? el("div", { class: "time" }, t("until", { end: d.end ?? "" }))
        : el("div", { class: "time" }, d.time, d.end ? el("small", {}, `– ${d.end}`) : null),
      el("div", {},
        el("h3", {}, done ? "✓ " : null, d.title, d.confirmed ? null : el("span", { class: "unconfirmed" }, t("unconfirmed")),
          done ? el("span", { class: "was" }, t("over")) : null),
        d.note ? el("p", {}, d.note) : null, row, taskDoc("prep", i))));
  });
  main.append(el("section", { class: "section", "aria-labelledby": "h-day" }, el("h2", { id: "h-day" }, t("day")),
    doc.dayItems.length ? day : el("p", { class: "empty" }, t("noDay"))));

  const used = el("div", { class: "used" }, t("used"));
  for (const k of doc.sourcesUsed) used.append(el("span", { class: `src ${k}` }, icon(k, 13), iconName(k)));
  colophon.replaceChildren(used, el("p", {}, t("colophon")));
  colophon.hidden = false;
}

async function load() {
  try {
    const r = await api("/panel/api/brief/today");
    if (r.status === 404) {
      state = { doc: null, pending: false, tasks: [] };
      render();
      main.querySelector(".empty").textContent = t("off");
      main.querySelector(".btn")?.remove();
      return;
    }
    state = r.status === 200 ? r.body : null;
  } catch {
    state = null;
  }
  if (state?.lang && state.lang !== document.documentElement.lang) document.documentElement.lang = state.lang;
  votes = {};
  if (state?.doc?.id) {
    const v = await api(`/panel/api/quality/brief?doc=${encodeURIComponent(state.doc.id)}`).catch(() => null);
    if (v?.status === 200 && v.body?.verdicts && typeof v.body.verdicts === "object") votes = v.body.verdicts;
  }
  render();
  // Something is being written: look again in a few seconds (never forever: the server gives up after its wait).
  const writing = !!(state && (state.pending || (state.tasks ?? []).some((x) => x.status === "pending")));
  figure("waiting", { on: writing });
  if (writing) watch();
}

function watch() {
  if (polling) return;
  polling = setTimeout(() => {
    polling = null;
    void load();
  }, 4000);
}

mountTwins();
void load();
