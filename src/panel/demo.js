// Pako · panel: the demo week (src/demo.ts) on the pages beside the dashboard, on a person's computer only (GET /panel/api/demo answers
// there; a server answers 404 and nothing shows). Two mounts:
//   [data-mount="demo"]         the Settings card: "Try with a demo week", or "Leave demo" while it runs;
//   [data-mount="demo-banner"]  the banner across the page while it runs ("Demo week: invented data. Leave demo");
//   [data-mount="demo-connect"] on Settings' connection tabs while it runs: what is connected is invented, and the way to your own
//                               (the connection cards are hidden then: connecting is refused in the demo, src/demo.ts demoGuard).
// Starting or leaving restarts Pako on the other folder; the page waits for it and reloads. Everything is put on the page as text.

import { h, waitForRestart } from "./dom.js";

const WORDS = {
  title: "Demo week",
  leadOff: "See Pako on an invented week (people, mail, Slack, meetings, follow-ups) before you connect anything. Nothing is sent, and "
    + "leaving it deletes everything it made.",
  leadOn: "The demo week is on: everything you see is invented, and nothing leaves this computer. Leaving deletes it and brings back your own setup.",
  start: "Try with a demo week",
  leave: "Leave demo",
  banner: "Demo week: invented data.",
  live: "Connect Claude to see it live",
  starting: "Setting up the demo week… Pako is starting again.",
  leaving: "Leaving the demo… Pako is starting again.",
  failed: "That didn't work. Try again.",
  notBack: "Pako hasn't come back yet. Reload this page in a moment.",
  connectTitle: "Connections are off in the demo week",
  connectLead: "Its calendar, mail and Slack are invented and read only, and nothing is sent. Leave the demo to connect your own accounts.",
};

const t = (key) => WORDS[key] ?? key;


/** The server's word: { on, live }; null until it answered (or on a server). */
let state = null;
let busy = false;
let note = "";
const views = [];


/**
 * Starts the demo week ("start") or leaves it ("leave"), wherever it is pressed (this card, the banner, the dashboard's welcome and its
 * banner in app.js): Pako starts again on the other folder, the Mac app is told (so its Connect window does not open over the demo), and
 * the page reloads once Pako is back. `say` shows each step's words. Before, app.js kept its own copy, and only that one told the app.
 */
export async function switchDemo(kind, say) {
  try {
    const r = await fetch(`/panel/api/demo/${kind}`, { method: "POST", credentials: "same-origin", headers: { "x-pako": "1" } });
    if (r.status === 401) return void location.reload();
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.json();
    say(t(kind === "start" ? "starting" : "leaving"));
    try {
      window.webkit?.messageHandlers?.pako?.postMessage({ demo: kind === "start" });
    } catch {
      /* not in the app */
    }
    if (!body.restarting) return void location.reload();
    if (!(await waitForRestart())) say(t("notBack"));
  } catch {
    /* offline: said in the note */
    say(t("failed"));
  }
}

async function change(kind) {
  if (busy) return;
  busy = true;
  note = "";
  paint();
  await switchDemo(kind, (text) => {
    note = text;
    paint();
  });
  busy = false;
  paint();
}

function paint() {
  for (const v of views) v();
}

function card(mount) {
  const el = h("section", { class: "card demo-card", "aria-labelledby": "h-demo", hidden: true },
    h("div", { class: "card-head" }, h("h2", { id: "h-demo" }, h("i", { "data-lucide": "flask-conical" }), h("span", {}, t("title")))),
    h("p", { class: "muted", "data-demo-lead": true }),
    h("button", { class: "btn", type: "button", "data-demo-button": true }),
    h("p", { class: "muted", "data-demo-note": true, "aria-live": "polite" }));
  const button = el.querySelector("[data-demo-button]");
  button.addEventListener("click", () => void change(state?.on ? "leave" : "start"));
  mount.append(el);
  views.push(() => {
    if (!state) return;
    el.hidden = false;
    el.querySelector("[data-demo-lead]").textContent = t(state.on ? "leadOn" : "leadOff");
    button.textContent = t(state.on ? "leave" : "start");
    button.disabled = busy;
    el.querySelector("[data-demo-note]").textContent = note;
  });
}

function banner(mount) {
  const live = h("a", { class: "demo-live", href: "/panel/settings", hidden: true }, t("live"));
  const leave = h("button", { class: "demo-leave", type: "button" }, t("leave"));
  const el = h("div", { class: "demo-banner", role: "status", hidden: true },
    h("span", { class: "demo-text" }, h("b", {}, t("banner")), " ", live), leave);
  leave.addEventListener("click", () => void change("leave"));
  mount.append(el);
  views.push(() => {
    el.hidden = !state?.on;
    live.hidden = !state?.on || state.live;
    leave.disabled = busy;
    leave.textContent = busy && note ? note : t("leave");
  });
}

function connectNote(mount) {
  const leave = h("button", { class: "btn", type: "button" }, t("leave"));
  const el = h("section", { class: "card demo-card demo-connect", role: "note", hidden: true },
    h("div", { class: "card-head" }, h("h2", {}, h("i", { "data-lucide": "flask-conical" }), h("span", {}, t("connectTitle")))),
    h("p", { class: "muted" }, t("connectLead")), leave);
  leave.addEventListener("click", () => void change("leave"));
  mount.append(el);
  views.push(() => {
    el.hidden = !state?.on;
    leave.disabled = busy;
    document.body.classList.toggle("demo-on", !!state?.on);
  });
}

async function load() {
  try {
    const r = await fetch("/panel/api/demo", { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) return;
    const body = await r.json();
    state = { on: body.on === true, live: body.live === true };
    paint();
  } catch {
    /* the server is restarting: the next load asks again */
  }
}

function mount() {
  const c = document.querySelector('[data-mount="demo"]');
  const b = document.querySelector('[data-mount="demo-banner"]');
  const notes = document.querySelectorAll('[data-mount="demo-connect"]');
  if (!c && !b && !notes.length) return;
  for (const n of notes) connectNote(n);
  if (c) card(c);
  if (b) banner(b);
  window.lucide?.createIcons?.({ attrs: { "aria-hidden": "true" } });
  void load();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
