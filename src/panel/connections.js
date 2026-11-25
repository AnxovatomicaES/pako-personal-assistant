// Pako · panel: the gear that opens the connections page (/panel/settings, src/panel/settings.*), on a person's computer only: it shows once
// /panel/api/connections answered (a hosted server answers 404 there, and its panel has no gear at all), with a dot when something there wants
// a look. The page opens in this same tab or window, in a browser and in the Mac app alike; its Back returns to /panel.

import { brokenChannels, oneSuggestion, WORDS as DASH } from "./dashboard-model.js";

const $ = (s, root = document) => root.querySelector(s);

/** The server's answer: { connections, restart, phone, readable }; null until it answered. */
let data = null;

/** Something on the page wants a look: a connection that says it is wrong or is half set, or the file it keeps them in unreadable. */
function needsAttention() {
  if (!data) return false;
  return !data.readable || data.connections.some((c) => (typeof c.problem === "string" && c.problem) || c.state === "partial");
}

/**
 * Opens the connections page, on one connection when `id` is given, in this same tab or window (the Mac app's main window too): a page of
 * its own in a new tab or window was one more thing to find and close.
 */
export function openSettingsPage(id = "") {
  location.href = `/panel/settings${/^[a-z]{1,20}$/.test(id) ? `#${id}` : ""}`;
}

async function load() {
  try {
    const r = await fetch("/panel/api/connections", { credentials: "same-origin", cache: "no-store" });
    // 404: a server's panel, which has no such page. 401: signed out (the page itself handles it).
    if (!r.ok) return;
    data = await r.json();
    const btn = $("#settings-btn");
    if (!btn) return;
    if (btn.hidden) {
      btn.hidden = false;
      btn.addEventListener("click", () => openSettingsPage());
    }
    const dot = $("#settings-dot");
    if (dot) dot.hidden = !needsAttention();
    void notices();
  } catch (err) {
    console.warn("connections", err);
  }
}

/** The lines notices() put in #notices last time: the only ones it takes away (the catch-up line, app.js's, lives in the same box). */
let mine = [];

/**
 * The quiet lines at the top of the dashboard: a channel that stopped working (Telegram unpaired, WhatsApp refused: reminders would stop
 * arriving), and at most ONE suggestion, the single most useful thing not connected yet. Setting things up happens in Settings.
 */
async function notices() {
  const box = $("#notices");
  if (!box) return;
  try {
    const r = await fetch("/panel/api/connections/status", { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) return;
    const status = (await r.json()).connections ?? [];
    const link = (text, href) => {
      const a = document.createElement("a");
      a.className = "notice";
      a.href = href;
      a.textContent = text;
      return a;
    };
    const lines = brokenChannels(status).map((c) => link(c.text, `/panel/settings#${c.id}`));
    // The demo week (src/demo.ts) connects nothing: no suggestion to connect over its invented data.
    const demo = await fetch("/panel/api/demo", { credentials: "same-origin", cache: "no-store" }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
    const next = demo?.on ? null : oneSuggestion(status);
    // The welcome block of an empty dashboard names the same one step.
    window.pakoNextStep = next;
    if (next) lines.push(link(`${next.text} · ${DASH.settings}`, next.href));
    // Only its own: replacing the whole box took app.js's catch-up line away until the next refresh of the page.
    for (const old of mine) old.remove();
    mine = lines;
    box.append(...lines);
  } catch {
    /* the server is restarting: the next load asks again */
  }
}

// The Mac app's Connect your things step (desktop/mac/App.swift) opens one connection: the page, on that one. False when the connections have
// not answered (a server's panel never has them) or there is no such connection: the app then does nothing more.
window.pakoOpenConnection = (id) => {
  if (!data) return false;
  const known = id === "telegram" || id === "whatsapp" || id === "contacts" || data.connections.some((c) => c.id === id);
  if (!known) return false;
  openSettingsPage(id === "imap" || id === "imap2" ? "mail" : id);
  return true;
};

// Back on the panel after connecting something in the other tab: the dot is read again.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && data) void load();
});
void load();
