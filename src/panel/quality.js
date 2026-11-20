// Pako · panel: "Quality" (src/quality.ts: GET /panel/api/quality) and "Rehearsal" (src/rehearsal.ts: GET and POST /panel/api/rehearsal).
// Quality: the last 7 days of the follow-up nudges (sent, Done, Not mine, ignored, 👍/👎) and the brief's 👍/👎. Rehearsal: a button that
// runs the follow-ups and today's brief in a dry run over what Pako already keeps, and what Pako WOULD have said: each would-be nudge with its
// source and what its check found, and the brief with the text the chat would get. Nothing here sends anything. Without the routes (both
// follow-ups and the written brief off) the cards stay hidden. Everything is put on the page as text, never as HTML.

import { hideWhenEmpty } from "./dashboard-model.js";
import { localeFor } from "./i18n.js";

const WORDS = {
  quality: "Quality",
  qualityLead: "The last 7 days: whether what I tell you on my own is useful.",
  sent: "Reminders sent", done: "Marked “Done”", notMine: "“Not mine”", ignored: "No answer", up: "👍", down: "👎",
  briefVotes: "Brief: {up} 👍 · {down} 👎",
  poor: "{n} of {of} reminders weren't useful to you. I'll say so in Monday's brief.",
  noData: "No reminders this week yet.",
  rehearsal: "Rehearsal",
  rehearsalLead: "What I would have told you from what I already keep of the last 48 h (Slack, mail, meetings) and today's brief. A dry run: I send and change nothing. On the chat: REHEARSAL.",
  run: "Rehearse now", running: "Rehearsing on the assistant's computer…", none: "No rehearsal yet.",
  startFailed: "I couldn't start the rehearsal. Try again in a while.",
  away: "The assistant's computer isn't connected: the rehearsal will start when it is back.",
  oldBridge: "The assistant's computer can't do the rehearsal: update it (git pull in its Pako folder, or the latest version of the app).",
  when: "Rehearsal of {when}", found: "Read: {slack} Slack conversation(s), {mail} email(s), {meeting} meeting(s).",
  waiting: "waiting for your computer…", failed: "no usable answer", unread: "your computer didn't read it (it needs an update)",
  nothingFound: "Nothing to follow up here.", merged: "Already followed: {list}", closes: "Would mark closed: {list}", ruled: "{n} dropped by “Not mine”.",
  out_nudge: "Would remind you", out_later: "Would look near its time", out_closed: "Would see it done and close it silently",
  out_replied: "Wouldn't remind you: you replied there", out_silent: "Would keep it open, no reminder (nothing to check)",
  out_past: "Its time has passed: would say nothing",
  check: "Would check: {what}", checked: "Now it finds: {what}", quiet: "(would wait for your quiet hours to end)",
  ch_zoomMeeting: "your Zoom and calendar", ch_calendarEvent: "your calendar", ch_slackReply: "your reply on Slack",
  ch_slackPost: "a message of yours on Slack", ch_none: "nothing (it can't see it)",
  brief: "Today's brief", chat: "What the chat would get", todos: "To-dos", updates: "Updates", day: "Your day",
  k_slack: "Slack", k_mail: "Email", k_meeting: "Meeting", k_brief: "Brief",
};

/** Dates written the way the owner's country writes English (i18n.js localeFor). */
const localeOf = () => localeFor(document.documentElement.dataset.region);
const t = (key, vars = {}) => String(WORDS[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
const str = (v) => (typeof v === "string" ? v : "");
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== "") el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const pre = (text) => {
  const p = h("p", {}, text);
  p.style.whiteSpace = "pre-line";
  return p;
};

let qCard = null;
let rCard = null;

/** Whether a stats object holds any count above zero, anywhere in it: a week with no nudge and no rating has nothing to show. */
function anyCount(v) {
  if (typeof v === "number") return v > 0;
  if (Array.isArray(v)) return v.some(anyCount);
  if (v && typeof v === "object") return Object.values(v).some(anyCount);
  return false;
}
let stats = null;
let view = null;
let note = "";
let polling = null;

function paintQuality() {
  if (!qCard || !stats) return;
  // The dashboard's rule: a card with nothing in it is not shown. Quality has something once a nudge was sent or a brief was rated.
  if (!hideWhenEmpty(qCard, anyCount(stats))) return;
  qCard.querySelector("[data-q-title]").textContent = t("quality");
  qCard.querySelector("[data-q-lead]").textContent = t("qualityLead");
  const body = qCard.querySelector("[data-q-body]");
  const n = stats.nudges ?? {};
  const cell = (label, value) => h("div", { class: "q-cell" }, h("strong", {}, String(num(value))), h("span", { class: "muted" }, label));
  const unhelpful = num(stats.unhelpful);
  const poor = num(n.sent) >= 3 && unhelpful >= 2 && unhelpful * 3 >= num(n.sent);
  body.replaceChildren(
    num(n.sent) ? h("div", { class: "q-grid" }, cell(t("sent"), n.sent), cell(t("done"), n.done), cell(t("notMine"), n.notMine),
      cell(t("ignored"), n.ignored), cell(t("up"), n.up), cell(t("down"), n.down)) : h("p", { class: "muted" }, t("noData")),
    h("p", {}, t("briefVotes", { up: num(stats.brief?.up), down: num(stats.brief?.down) })),
    poor ? h("p", {}, t("poor", { n: unhelpful, of: num(n.sent) })) : "",
  );
}

const whenText = (at, tz) =>
  new Intl.DateTimeFormat(localeOf(), { timeZone: tz || undefined, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    .format(new Date(at));

function wouldBe(item) {
  const lines = [
    h("strong", {}, t(`out_${str(item.outcome)}`)),
    item.text ? pre(str(item.text)) : h("p", {}, `${str(item.title)}${str(item.due) ? ` (${str(item.due)})` : ""}`),
    h("p", { class: "muted" }, t("check", { what: t(`ch_${str(item.check)}`) })),
    str(item.seen) ? h("p", { class: "muted" }, t("checked", { what: str(item.seen) })) : "",
    item.quiet ? h("p", { class: "muted" }, t("quiet")) : "",
    str(item.source) ? h("p", { class: "muted" }, str(item.source)) : "",
  ];
  return h("li", { class: `rh-item ${str(item.outcome)}` }, ...lines);
}

function jobBlock(j, tz) {
  const head = `${t(`k_${str(j.kind)}`)} · ${str(j.label)} · ${whenText(num(j.at), tz)}`;
  const body = [];
  if (j.status === "waiting") body.push(h("p", { class: "muted" }, t("waiting")));
  else if (j.status === "failed") body.push(h("p", { class: "muted" }, t("failed")));
  else if (j.status === "unread") body.push(h("p", { class: "muted" }, t("unread")));
  else if (j.kind === "brief" && j.brief) {
    const b = j.brief;
    if (str(b.opening)) body.push(h("p", {}, str(b.opening)));
    if (b.focus?.title) body.push(h("p", {}, h("strong", {}, str(b.focus.title)), ` ${str(b.focus.story)}`));
    const list = (key, items, line) => (Array.isArray(items) && items.length ? [h("h4", {}, t(key)), h("ul", {}, ...items.map((x) => h("li", {}, line(x))))] : []);
    body.push(...list("todos", b.todos, (x) => `${str(x.title)}${str(x.checked) ? ` — ${str(x.checked)}` : ""}`));
    body.push(...list("updates", b.updates, (x) => `${str(x.title)}${str(x.text) ? `: ${str(x.text)}` : ""}`));
    body.push(...list("day", b.day, (x) => `${str(x.time)} ${str(x.title)}`));
    if (str(j.chat)) body.push(h("h4", {}, t("chat")), pre(str(j.chat)));
  } else if (j.outcome) {
    const o = j.outcome;
    const items = Array.isArray(o.items) ? o.items : [];
    if (items.length) body.push(h("ul", { class: "rh-list" }, ...items.map(wouldBe)));
    if (Array.isArray(o.merged) && o.merged.length) body.push(h("p", { class: "muted" }, t("merged", { list: o.merged.join(", ") })));
    if (Array.isArray(o.closes) && o.closes.length) body.push(h("p", { class: "muted" }, t("closes", { list: o.closes.join(", ") })));
    if (num(o.ruled)) body.push(h("p", { class: "muted" }, t("ruled", { n: num(o.ruled) })));
    if (!body.length) body.push(h("p", { class: "muted" }, t("nothingFound")));
  }
  const speaks = j.outcome && Array.isArray(j.outcome.items) && j.outcome.items.some((x) => x.outcome === "nudge" || x.outcome === "later");
  return h("details", { open: speaks || j.kind === "brief" ? true : false }, h("summary", {}, head), ...body);
}

function paintRehearsal() {
  if (!rCard || !view) return;
  // Shown once a rehearsal ran or is running; before that the chat's REHEARSAL command starts one (the card then appears).
  const ran = view.running || (Array.isArray(view.jobs) && view.jobs.length > 0) || !!view.at || !!view.brief;
  if (!hideWhenEmpty(rCard, ran)) return;
  rCard.querySelector("[data-r-title]").textContent = t("rehearsal");
  rCard.querySelector("[data-r-lead]").textContent = t("rehearsalLead");
  const button = rCard.querySelector("[data-r-run]");
  button.textContent = view.running ? t("running") : t("run");
  button.disabled = !!view.running;
  const body = rCard.querySelector("[data-r-body]");
  const run = view.run;
  const parts = [];
  if (note) parts.push(h("p", { role: "status" }, note));
  if (!view.bridge) parts.push(h("p", { class: "muted" }, t("away")));
  if (!run) parts.push(h("p", { class: "muted" }, t("none")));
  else {
    const jobs = Array.isArray(run.jobs) ? run.jobs : [];
    if (jobs.length && jobs.every((j) => j.status === "unread")) parts.push(h("p", {}, t("oldBridge")));
    parts.push(h("p", { class: "muted" }, t("when", { when: whenText(num(run.at), view.timeZone) })));
    parts.push(h("p", { class: "muted" }, t("found", { slack: num(run.found?.slack), mail: num(run.found?.mail), meeting: num(run.found?.meeting) })));
    // The brief first, then what would have spoken, then the rest.
    const rank = (j) => (j.kind === "brief" ? 0 : j.outcome?.items?.some((x) => x.outcome === "nudge" || x.outcome === "later") ? 1 : 2);
    for (const j of [...jobs].sort((a, b) => rank(a) - rank(b))) parts.push(jobBlock(j, view.timeZone));
  }
  body.replaceChildren(...parts);
}

async function load() {
  try {
    const [q, r] = await Promise.all([
      fetch("/panel/api/quality", { credentials: "same-origin", cache: "no-store" }),
      fetch("/panel/api/rehearsal", { credentials: "same-origin", cache: "no-store" }),
    ]);
    if (q.ok) stats = (await q.json())?.stats ?? null;
    if (r.ok) view = await r.json();
    paintQuality();
    paintRehearsal();
    if (view?.running) watch();
  } catch {
    /* the server is restarting: the next load asks again */
  }
}

function watch() {
  if (polling) return;
  polling = setTimeout(() => {
    polling = null;
    void load();
  }, 5000);
}

async function start() {
  const button = rCard.querySelector("[data-r-run]");
  button.disabled = true;
  try {
    const r = await fetch("/panel/api/rehearsal", { method: "POST", credentials: "same-origin", headers: { "x-pako": "1", "content-type": "application/json" }, body: "{}" });
    const body = r.ok ? await r.json() : null;
    note = body && typeof body.text === "string" ? body.text : t("startFailed");
  } catch {
    /* offline: said in the note */
    note = t("startFailed");
  }
  await load();
  watch();
}

function mount() {
  const grid = document.querySelector("#grid");
  if (!grid) return;
  qCard = h("section", { class: "card quality", id: "quality-card", "aria-labelledby": "h-quality", hidden: true },
    h("div", { class: "card-head" }, h("h2", { id: "h-quality" }, h("i", { "data-lucide": "gauge" }), h("span", { "data-q-title": true }))),
    h("p", { class: "muted", "data-q-lead": true }),
    h("div", { "data-q-body": true }));
  const run = h("button", { class: "btn", type: "button", "data-r-run": true });
  run.addEventListener("click", () => void start());
  rCard = h("section", { class: "card rehearsal", id: "rehearsal-card", "aria-labelledby": "h-rehearsal", hidden: true },
    h("div", { class: "card-head" }, h("h2", { id: "h-rehearsal" }, h("i", { "data-lucide": "flask-conical" }), h("span", { "data-r-title": true })), run),
    h("p", { class: "muted", "data-r-lead": true }),
    h("div", { "data-r-body": true, "aria-live": "polite" }));
  // Right after Salud (src/panel/health.js) whichever script runs first: how Pako runs, then how useful it is.
  const health = document.querySelector("#health-card");
  if (health) health.after(qCard, rCard);
  else grid.append(qCard, rCard);
  window.lucide?.createIcons?.({ attrs: { "aria-hidden": "true" } });
  void load();
  setInterval(() => void load(), 5 * 60_000);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
