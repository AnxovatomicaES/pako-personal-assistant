// Pako · the phone's page (/m, src/mobile.ts). It reads GET /m/api/today and draws it as text, never as HTML: "Needs you now" with one-tap
// Done, In 1 h, Tomorrow and Park, today's brief with the sources each item cites, what the owner owes and what others owe them, parked and
// just closed items with Reopen, and a draft reply to copy or open in the mail app.
//
// Not paired yet (no device token, or it was removed): the pairing form. A code from the QR link rides in the address's #fragment, which is
// read here, taken out of the address at once, and sent in a POST's body: never in a URL a server sees. The token itself is an httpOnly
// cookie this script cannot read.
//
// Pako cannot be reached (away from home, the computer asleep): the last answer, kept on this phone, is shown with its time.

import { CACHE_KEY, mailtoFor, phoneModel, readCache } from "./m-model.js";

const WORDS = {
  needsNow: "Needs you now",
  brief: "Today's brief",
  briefAsOf: "Brief from {time}",
  briefNone: "No written brief for today yet.",
  briefPending: "Your brief is being written…",
  focus: "Most valuable today",
  todos: "To-dos",
  updates: "New updates",
  day: "Your day",
  unconfirmed: "time unconfirmed",
  owe: "You owe",
  owed: "Waiting on others",
  parked: "Parked",
  closed: "Closed lately",
  nothing: "Nothing open. Enjoy it.",
  followupsOff: "Follow-ups are off on your computer.",
  done: "Done",
  snooze: "In 1 h",
  tomorrow: "Tomorrow",
  park: "Park",
  reopen: "Reopen",
  draft: "Draft a reply",
  drafting: "Writing a draft…",
  draftFailed: "The draft could not be written.",
  copy: "Copy",
  copied: "Copied",
  copyFailed: "Select the text and copy it",
  mail: "Open in Mail",
  snoozed: "Snoozed",
  checked: "Checked: ",
  step: "First step: ",
  updated: "Updated {time}",
  offline: "Can't reach Pako. Showing what was loaded at {time}.",
  offlineNone: "Can't reach Pako. Are you on the same Wi-Fi as your computer?",
  away: "Works on the same Wi-Fi as your computer. Away from home, use Pako on Telegram.",
  awayNoTelegram: "Works on the same Wi-Fi as your computer. To reach Pako away from home, set up Telegram in Pako's Settings on your computer.",
  thisPhone: "This phone: {name}",
  unpair: "Unpair this phone",
  unpairAsk: "Unpair this phone? You can pair it again from Settings on your computer.",
  pairTitle: "Pair this phone",
  pairLead: "On your computer, open Pako › Settings › General › Use on my phone, then scan the QR code, or type the code it shows here.",
  pairCode: "Pairing code",
  pairName: "Name for this phone",
  pairButton: "Pair",
  pairing: "Pairing…",
  pairFailed: "That didn't work.",
  failed: "Couldn't reach Pako. Try again on your home Wi-Fi.",
  refresh: "Refresh",
};
const t = (key, vars = {}) => String(WORDS[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "onclick") node.addEventListener("click", v);
    else if (k === "class") node.className = v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== "") node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

const $ = (s) => document.querySelector(s);
const main = $("#main");
const statusLine = $("#status");
const clock = (at) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(at);
const dateTime = (at) => new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(at);

let data = null;
let busy = false;
let timer = null;

// ---------- the store on this phone ----------

const cache = {
  read: () => {
    try {
      return readCache(localStorage.getItem(CACHE_KEY));
    } catch {
      /* storage blocked (a private tab): nothing kept */
      return null;
    }
  },
  write: (d) => {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data: d }));
    } catch {
      /* storage full or blocked: the page works without it */
    }
  },
  clear: () => {
    try {
      localStorage.removeItem(CACHE_KEY);
    } catch {
      /* storage blocked: nothing to clear */
    }
  },
};

// ---------- talking to Pako ----------

async function api(path, body) {
  const r = await fetch(path, body === undefined
    ? { credentials: "same-origin", cache: "no-store" }
    : { method: "POST", credentials: "same-origin", headers: { "x-pako": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 3500);
}

async function load() {
  let r;
  try {
    r = await api("/m/api/today");
  } catch {
    // No network, or the computer cannot be reached: the last answer, with its time.
    const kept = cache.read();
    statusLine.textContent = kept ? t("offline", { time: dateTime(kept.at) }) : t("offlineNone");
    statusLine.classList.add("warn");
    // Whichever of these runs sets the next look (draw and drawOffline do it themselves): one failed refresh must never be the last.
    if (kept && !data) draw(kept.data);
    else if (!kept) drawOffline();
    else schedule(30_000);
    return;
  }
  statusLine.classList.remove("warn");
  if (r.status === 401) {
    cache.clear();
    data = null;
    return drawPairing();
  }
  if (r.status !== 200 || !r.body) {
    statusLine.textContent = t("failed");
    statusLine.classList.add("warn");
    schedule(30_000); // Pako answered with an error (it may be busy, or restarting): the page stays and asks again
    return;
  }
  cache.write(r.body);
  statusLine.textContent = t("updated", { time: clock(Date.now()) });
  draw(r.body);
}

async function act(id, action) {
  if (busy) return;
  busy = true;
  try {
    const r = await api("/m/api/loop", { id, action });
    if (r.status === 401) return void drawPairing();
    toast(r.body?.say || (r.status === 200 ? t(action) : t("failed")));
  } catch {
    /* offline: said in the toast */
    toast(t("failed"));
  } finally {
    busy = false;
  }
  await load();
}

async function askDraft(id) {
  try {
    const r = await api("/m/api/draft", { id });
    if (r.status === 401) return void drawPairing();
    toast(r.body?.say || t("failed"));
  } catch {
    /* offline: said in the toast */
    toast(t("failed"));
  }
  await load();
}

/** Copies a draft. The clipboard API needs https, which a home network has not: a selected text box and the copy command instead. */
async function copy(text, button) {
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch {
    /* refused: the old way below */
  }
  if (!ok) {
    const box = h("textarea", { class: "copy-box", readonly: true });
    box.value = text;
    document.body.append(box);
    box.focus();
    box.setSelectionRange(0, text.length);
    try {
      ok = document.execCommand("copy");
    } catch {
      /* not allowed here: the owner selects it by hand */
      ok = false;
    }
    box.remove();
  }
  button.textContent = ok ? t("copied") : t("copyFailed");
  setTimeout(() => (button.textContent = t("copy")), 2000);
}

// ---------- drawing ----------

const chip = (c) => h("span", { class: "cite" }, h("span", { class: "cite-kind" }, c.kind), c.label ? ` · ${c.label}` : "");
const cites = (list) => (list.length ? h("p", { class: "cites" }, list.map(chip)) : null);

function loopCard(item) {
  const meta = [item.who, item.where].filter(Boolean).join(" · ");
  const draft = item.draft;
  return h("li", { class: `card loop${item.owes ? "" : " owed"}`, "data-id": item.id },
    h("div", { class: "loop-head" },
      h("p", { class: "loop-title" }, item.title),
      item.due ? h("span", { class: `due${item.due.late ? " late" : ""}` }, item.due.text) : null,
      item.snoozed ? h("span", { class: "due" }, t("snoozed")) : null),
    meta ? h("p", { class: "meta" }, meta) : null,
    item.checked ? h("p", { class: "small muted" }, t("checked"), item.checked) : null,
    item.step ? h("p", { class: "small" }, t("step"), item.step) : null,
    draft && draft.status === "pending" ? h("p", { class: "small muted" }, t("drafting")) : null,
    draft && draft.status === "failed" ? h("p", { class: "small muted" }, t("draftFailed")) : null,
    draft && draft.status === "done" && draft.text
      ? h("div", { class: "draft" },
          h("p", { class: "draft-text" }, draft.text),
          h("div", { class: "row" },
            h("button", { type: "button", class: "btn", onclick: (e) => copy(draft.text, e.currentTarget) }, t("copy")),
            h("a", { class: "btn", href: mailtoFor(item, draft.text) }, t("mail"))))
      : null,
    h("div", { class: "actions" },
      item.actions.map((a) => h("button", { type: "button", class: `btn${a === "done" || a === "reopen" ? " primary" : ""}`, onclick: () => act(item.id, a) }, t(a))),
      item.canDraft ? h("button", { type: "button", class: "btn ghost", onclick: () => askDraft(item.id) }, t("draft")) : null));
}

const list = (items) => h("ul", { class: "cards" }, items.map(loopCard));
const section = (id, title, ...body) => h("section", { class: "block", "aria-labelledby": id }, h("h2", { id }, title), ...body);

function briefBlock(b) {
  if (!b) return null;
  if (b.none) return section("h-brief", t("brief"), h("p", { class: "muted" }, t(b.pending ? "briefPending" : "briefNone")));
  return section("h-brief", b.asOf ? t("briefAsOf", { time: dateTime(b.asOf) }) : t("brief"),
    b.opening ? h("p", { class: "opening" }, b.opening) : null,
    b.focus
      ? h("div", { class: "card focus" }, h("p", { class: "kicker" }, t("focus")), h("p", { class: "loop-title" }, b.focus.title),
          b.focus.story ? h("p", {}, b.focus.story) : null, cites(b.focus.cites))
      : null,
    b.todos.length
      ? h("div", {}, h("h3", {}, t("todos")), h("ul", { class: "plain" }, b.todos.map((x) =>
          h("li", { class: x.done ? "done" : "" }, h("p", { class: "item-title" }, x.title), x.context ? h("p", { class: "small muted" }, x.context) : null, cites(x.cites)))))
      : null,
    b.updates.length
      ? h("div", {}, h("h3", {}, t("updates")), h("ul", { class: "plain" }, b.updates.map((x) =>
          h("li", {}, h("p", { class: "item-title" }, x.title), x.text ? h("p", { class: "small" }, x.text) : null, cites(x.cites)))))
      : null,
    b.day.length
      ? h("div", {}, h("h3", {}, t("day")), h("ul", { class: "plain day" }, b.day.map((x) =>
          h("li", {}, h("p", { class: "item-title" }, h("span", { class: "when" }, x.when), " ", x.title, x.confirmed ? "" : ` (${t("unconfirmed")})`),
            x.note ? h("p", { class: "small muted" }, x.note) : null, cites(x.cites)))))
      : null);
}

function footer(m) {
  return h("footer", { class: "foot" },
    h("p", { class: "small" }, t(m.telegram ? "away" : "awayNoTelegram")),
    m.device ? h("p", { class: "small muted" }, t("thisPhone", { name: m.device })) : null,
    h("button", { type: "button", class: "btn ghost", onclick: unpair }, t("unpair")));
}

function draw(d) {
  data = d;
  const m = phoneModel(d, { locale: navigator.language || undefined });
  const blocks = [];
  if (m.now.length) blocks.push(section("h-now", t("needsNow"), list(m.now)));
  blocks.push(briefBlock(m.brief));
  if (!m.followups) blocks.push(h("p", { class: "muted" }, t("followupsOff")));
  else {
    if (!m.now.length && !m.owe.length && !m.owed.length) blocks.push(h("p", { class: "muted" }, t("nothing")));
    if (m.owe.length) blocks.push(section("h-owe", t("owe"), list(m.owe)));
    if (m.owed.length) blocks.push(section("h-owed", t("owed"), list(m.owed)));
    if (m.parked.length) blocks.push(h("details", { class: "block" }, h("summary", {}, `${t("parked")} (${m.parked.length})`), list(m.parked)));
    if (m.closed.length) blocks.push(h("details", { class: "block" }, h("summary", {}, `${t("closed")} (${m.closed.length})`), list(m.closed)));
  }
  blocks.push(footer(m));
  main.replaceChildren(...blocks.filter(Boolean));
  $("#refresh").hidden = false;
  // A draft being written: looked at again soon.
  const writing = [...m.now, ...m.owe].some((x) => x.draft?.status === "pending");
  schedule(writing ? 10_000 : 60_000);
}

function drawOffline() {
  main.replaceChildren(h("p", { class: "muted" }, t("offlineNone")));
  schedule(30_000);
}

function drawPairing(fromLink = "") {
  clearTimeout(timer);
  $("#refresh").hidden = true;
  statusLine.textContent = "";
  const guess = /iphone/i.test(navigator.userAgent) ? "iPhone" : /ipad/i.test(navigator.userAgent) ? "iPad" : /android/i.test(navigator.userAgent) ? "Android phone" : "Phone";
  const code = h("input", { id: "pair-code", class: "field", autocomplete: "one-time-code", autocapitalize: "characters", spellcheck: "false", maxlength: "20", inputmode: "text" });
  code.value = fromLink;
  const name = h("input", { id: "pair-name", class: "field", autocomplete: "off", maxlength: "40" });
  name.value = guess;
  const note = h("p", { class: "small", role: "alert" });
  const button = h("button", { type: "submit", class: "btn primary wide" }, t("pairButton"));
  const form = h("form", { class: "card pair" },
    h("label", { for: "pair-code" }, t("pairCode")), code,
    h("label", { for: "pair-name" }, t("pairName")), name,
    button, note);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    button.disabled = true;
    button.textContent = t("pairing");
    note.textContent = "";
    try {
      const r = await api("/m/api/pair", { code: code.value, name: name.value });
      if (r.status === 200) return void (await load());
      note.textContent = r.body?.error || t("pairFailed");
    } catch {
      /* offline: said under the form */
      note.textContent = t("failed");
    } finally {
      button.disabled = false;
      button.textContent = t("pairButton");
    }
  });
  main.replaceChildren(section("h-pair", t("pairTitle"), h("p", {}, t("pairLead")), form));
  (fromLink ? name : code).focus();
}

async function unpair() {
  if (!confirm(t("unpairAsk"))) return;
  let r = null;
  try {
    r = await api("/m/api/forget", {});
  } catch {
    /* offline: said below */
  }
  // Only Pako's word takes this phone out: 200 (forgotten) or 401 (it did not know this phone). With no answer, or an error, the cookie is
  // still good and so is the pairing: the page stays as it is and says so, not a pairing form for a phone that is still paired.
  if (!r || (r.status !== 200 && r.status !== 401)) return void toast(t("failed"));
  cache.clear();
  data = null;
  drawPairing();
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (document.visibilityState === "visible") void load();
    else schedule(ms);
  }, ms);
}

function start() {
  $("#refresh").setAttribute("aria-label", t("refresh"));
  $("#refresh").addEventListener("click", () => void load());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && data) void load();
  });
  // A pairing link (/m/pair#CODE): the code is taken out of the address before anything else, then offered in the form.
  const fromLink = location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)).replace(/[^A-Za-z0-9-]/g, "").slice(0, 20) : "";
  if (location.hash || location.pathname !== "/m") history.replaceState(null, "", "/m");
  if (fromLink) return drawPairing(fromLink);
  const kept = cache.read();
  if (kept) draw(kept.data);
  void load();
}

start();
