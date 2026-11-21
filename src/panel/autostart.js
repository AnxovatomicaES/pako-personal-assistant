// Pako · panel: the "start with this computer" card, on a person's computer only (src/autostart-panel.ts answers there; a server answers 404
// and the card never shows). One button turns it on or off; the server's sentence says what changed. On here means from the next login:
// the Pako running now goes on as it is. Everything the server sends is put on the page as text, never as HTML.

import { h } from "./dom.js";

const WORDS = {
  title: "Start with this computer",
  lead: "Pako starts by itself every time you log in, with no terminal left open.",
  on: "On",
  off: "Off",
  stale: "On for another folder or another Node.js: turn it off and on again.",
  turnOn: "Turn on",
  turnOff: "Turn off",
  working: "One moment…",
  failed: "I couldn't change it. Try again.",
};

const t = (key) => WORDS[key] ?? key;


let card = null;
/** The server's last word: { enabled, current }. */
let state = null;
/** The sentence after a change (the server's own). */
let note = "";
let busy = false;

function paint() {
  if (!card || !state) return;
  card.hidden = false;
  card.querySelector("[data-as-title]").textContent = t("title");
  card.querySelector("[data-as-lead]").textContent = t("lead");
  card.querySelector("[data-as-state]").textContent = state.enabled ? (state.current ? t("on") : t("stale")) : t("off");
  const button = card.querySelector("[data-as-button]");
  button.textContent = busy ? t("working") : state.enabled ? t("turnOff") : t("turnOn");
  button.disabled = busy;
  card.querySelector("[data-as-note]").textContent = note;
}

async function load() {
  try {
    const r = await fetch("/panel/api/autostart", { credentials: "same-origin", cache: "no-store" });
    // 404: a server's panel. 401: signed out (the page itself handles it).
    if (!r.ok) return;
    const body = await r.json();
    // A system Pako cannot set up (Windows, for now): no card rather than a button that only says no.
    if (!body?.supported) return;
    state = { enabled: body.enabled === true, current: body.current === true };
    paint();
  } catch {
    /* the server is restarting: the next load asks again */
  }
}

async function toggle() {
  if (busy || !state) return;
  busy = true;
  note = "";
  paint();
  try {
    const r = await fetch("/panel/api/autostart", {
      method: "POST",
      credentials: "same-origin",
      headers: { "x-pako": "1", "content-type": "application/json" },
      body: JSON.stringify({ on: !state.enabled }),
    });
    if (r.status === 401) return void location.reload(); // the session ended: the sign-in page says what to do
    const body = r.ok ? await r.json() : null;
    if (body?.ok) {
      state = { enabled: body.enabled === true, current: true };
      note = typeof body.message === "string" ? body.message : "";
    } else note = typeof body?.error === "string" ? body.error : t("failed");
  } catch {
    /* offline: said in the note */
    note = t("failed");
  } finally {
    busy = false;
    paint();
  }
}

function mount() {
  // In Settings, General: a setting, not content, so never on the dashboard.
  const grid = document.querySelector('[data-mount="autostart"]');
  if (!grid) return;
  card = h("section", { class: "card autostart", id: "autostart-card", "aria-labelledby": "h-autostart", hidden: true },
    h("div", { class: "card-head" }, h("h2", { id: "h-autostart" }, h("i", { "data-lucide": "power" }), h("span", { "data-as-title": true }))),
    h("p", { class: "muted", "data-as-lead": true }),
    h("p", { "data-as-state": true, "aria-live": "polite" }),
    h("button", { class: "btn", type: "button", "data-as-button": true }),
    h("p", { class: "muted", "data-as-note": true, "aria-live": "polite" }));
  card.querySelector("[data-as-button]").addEventListener("click", toggle);
  grid.append(card);
  window.lucide?.createIcons?.({ attrs: { "aria-hidden": "true" } });
  void load();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
