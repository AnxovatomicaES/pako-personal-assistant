// Pako · panel: Settings › Labs (src/labs.ts), on a person's computer only (GET /panel/api/labs answers there; a server answers 404 and the
// tab says nothing is here). One switch per lab, with why it is in Labs and the same honest note for all. A change restarts Pako (as the
// demo week does), and the page waits for it and reloads. Everything the server sends is put on the page as text, never as HTML.

import { h, waitForRestart } from "./dom.js";

const WORDS = {
  title: "Labs",
  lead: "Experimental parts of Pako. They work, but each one depends on a service that can change without notice, so they are off for a "
    + "new install. Anything you had already set up before Labs stays on.",
  note: "Experimental: may break when the service changes.",
  locked: "On by PAKO_LABS in your settings file.",
  kept: "On because you had already set it up.",
  working: "Pako is starting again…",
  failed: "That didn't work. Try again.",
  notBack: "Pako hasn't come back yet. Reload this page in a moment.",
  none: "Labs are set on this computer's Pako only.",
};

const t = (key) => WORDS[key] ?? key;


let holder = null;
/** The server's word: { note, labs: [{ id, name, why, on, source, locked }] }; null until it answered (or on a server). */
let state = null;
let busy = false;
let message = "";


async function change(id, on) {
  if (busy) return;
  busy = true;
  message = "";
  paint();
  try {
    const r = await fetch("/panel/api/labs", {
      method: "POST", credentials: "same-origin", headers: { "x-pako": "1", "content-type": "application/json" }, body: JSON.stringify({ id, on }),
    });
    if (r.status === 401) return void location.reload();
    const body = await r.json().catch(() => null);
    if (!r.ok || !body?.ok) throw new Error(typeof body?.error === "string" ? body.error : t("failed"));
    if (body.restarting) {
      message = t("working");
      paint();
      if (!(await waitForRestart())) message = t("notBack");
    } else await load();
  } catch (err) {
    message = err instanceof Error && err.message ? err.message : t("failed");
  }
  busy = false;
  paint();
}

function row(lab) {
  const id = `lab-${lab.id}`;
  const sub = lab.locked ? t("locked") : lab.source === "grandfathered" ? t("kept") : "";
  return h("li", { class: "lab" },
    h("div", { class: "lab-words" },
      h("label", { for: id, class: "lab-name" }, String(lab.name ?? lab.id)),
      h("p", { class: "muted small", id: `${id}-why` }, String(lab.why ?? "")),
      sub ? h("p", { class: "muted small" }, sub) : null),
    h("input", {
      id, type: "checkbox", role: "switch", class: "lab-switch", checked: !!lab.on, disabled: busy || !!lab.locked,
      "aria-describedby": `${id}-why labs-note`, onchange: (e) => void change(lab.id, !!e.target.checked),
    }));
}

function paint() {
  if (!holder) return;
  if (!state) return void holder.replaceChildren(h("p", { class: "muted" }, t("none")));
  holder.replaceChildren(h("section", { class: "card labs-card", "aria-labelledby": "h-labs" },
    h("h2", { id: "h-labs" }, h("i", { "data-lucide": "flask-conical" }), h("span", {}, t("title"))),
    h("p", { class: "muted" }, t("lead")),
    h("p", { class: "labs-note", id: "labs-note" }, h("i", { "data-lucide": "triangle-alert" }), h("span", {}, String(state.note || t("note")))),
    h("ul", { class: "labs" }, ...state.labs.map(row)),
    h("p", { class: "muted", "aria-live": "polite" }, message)));
  window.lucide?.createIcons?.({ attrs: { "aria-hidden": "true" } });
}

async function load() {
  try {
    const r = await fetch("/panel/api/labs", { credentials: "same-origin", cache: "no-store" });
    const body = r.ok ? await r.json() : null;
    state = body && Array.isArray(body.labs) ? body : null;
  } catch {
    /* restarting: the next load asks again */
    state = null;
  }
  paint();
}

function mount() {
  holder = document.querySelector('[data-mount="labs"]');
  if (!holder) return;
  void load();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
