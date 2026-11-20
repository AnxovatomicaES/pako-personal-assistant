// Pako · panel: the Privacy card, on a person's computer only (src/data-panel.ts answers there; a server answers 404 and the card never
// shows). What Pako keeps and where, what leaves the computer and to whom, what never does; the export; deleting everything.
// The facts come from the server (src/data.ts); the card's own words are here. Everything is put on the page as
// text, never as HTML.

const $ = (s, root = document) => root.querySelector(s);

const WORDS = {
  title: "Privacy and your data",
  lead: "Everything Pako keeps is on this computer, in {folder}. Here is what it keeps, what leaves and to whom, and how to take it with you or delete it.",
  files: "The files",
  keys: "What it keeps, and for how long",
  keysLead: "Each thing deletes itself after that long without a change.",
  sends: "What leaves this computer",
  sendsLead: "Only to what you have connected.",
  never: "What never leaves",
  here: "there",
  notHere: "not there",
  export: "Export my data",
  exporting: "Preparing…",
  exported: "Downloaded: {file}",
  exportFailed: "I couldn't export it. Try again.",
  deleteTitle: "Delete everything",
  deleteLead: "Pako stops, deletes your notes, reminders, lists, chat and log, unpairs Telegram, forgets the panel's connections and starts "
    + "again as on the first day. It can't be undone: export first if you want to keep anything.",
  deleteLabel: "Type {phrase} to confirm",
  deleteButton: "Delete everything",
  deleting: "Deleting…",
  deleteFailed: "I couldn't delete it. Try again.",
  restarting: "Deleted. Pako is starting again…",
  done: "Deleted.",
  notBack: "Pako hasn't come back. Look at its terminal, or start it again with npm start.",
  kept: "What stays:",
};

function t(key, vars) {
  const s = WORDS[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m)) : s;
}

/** An element from a tag, attributes and children; text is always text. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const icon = (name) => h("i", { "data-lucide": name });
const paintIcons = () => window.lucide?.createIcons?.({ attrs: { "aria-hidden": "true" } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const st = { data: null, busy: "", error: "", note: "", kept: [], restarting: false, typed: "", card: null, body: null };

async function load() {
  try {
    const r = await fetch("/panel/api/privacy", { credentials: "same-origin", cache: "no-store" });
    // 404: a server's panel, which has no such card. 401: signed out (the page itself handles it).
    if (!r.ok) return;
    st.data = await r.json();
    render();
  } catch (err) {
    console.warn("privacy", err);
  }
}

/** The export is fetched with the header another site cannot send, then saved from the page (a plain link could not carry it). */
async function exportAll() {
  st.busy = "export";
  st.error = "";
  st.note = "";
  render();
  try {
    const r = await fetch("/panel/api/export", { credentials: "same-origin", cache: "no-store", headers: { "x-pako": "1" } });
    if (r.status === 401) return void location.reload();
    if (!r.ok) throw new Error(String(r.status));
    const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "pako-export.json";
    const url = URL.createObjectURL(await r.blob());
    const a = h("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    st.note = t("exported", { file: name });
  } catch {
    /* said in the error line */
    st.error = t("exportFailed");
  } finally {
    st.busy = "";
    render();
  }
}

/** Waits for the server to go down and come back (/health), then reloads the page: the fresh start shows its welcome. */
async function waitForRestart() {
  const start = Date.now();
  let down = false;
  while (Date.now() - start < 60_000) {
    await sleep(700);
    let up = false;
    try {
      up = (await fetch("/health", { cache: "no-store" })).ok;
    } catch {
      /* still restarting: asked again */
      up = false;
    }
    if (!up) down = true;
    else if (down || Date.now() - start > 8_000) {
      location.reload();
      return;
    }
  }
  st.restarting = false;
  st.error = t("notBack");
  render();
}

async function deleteAll() {
  st.busy = "delete";
  st.error = "";
  st.note = "";
  render();
  try {
    const r = await fetch("/panel/api/delete-all", {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-pako": "1" }, body: JSON.stringify({ confirm: st.typed }),
    });
    if (r.status === 401) return void location.reload();
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.ok) {
      st.error = out.error || t("deleteFailed");
      return;
    }
    st.typed = "";
    st.kept = Array.isArray(out.kept) ? out.kept : [];
    st.note = out.restarting ? t("restarting") : t("done");
    st.restarting = !!out.restarting;
    if (out.restarting) void waitForRestart();
  } catch {
    /* offline or refused: said in the error line */
    st.error = t("deleteFailed");
  } finally {
    st.busy = "";
    render();
  }
}

/** Whether the phrase typed is one the server takes (it ignores spaces and capitals as this does). */
const typedOk = () => (st.data?.phrases ?? []).includes(st.typed.trim().replace(/\s+/g, " ").toUpperCase());

const section = (title, lead, ...content) => h("details", { class: "tg" }, h("summary", { class: "mini-h" }, title), lead ? h("p", {}, lead) : null, ...content);

function render() {
  const d = st.data;
  if (!d) return;
  if (!st.card) {
    st.body = h("div", { class: "tg" });
    st.card = h("section", { class: "card privacy", id: "privacy-card", "aria-labelledby": "h-privacy" },
      h("div", { class: "card-head" }, h("h2", { id: "h-privacy" }, icon("shield"), h("span", { id: "privacy-title" }))), st.body);
    // In Settings, Privacy & your data. The dashboard shows content, not settings: no card there.
    const grid = $('[data-mount="privacy"]');
    if (!grid) return;
    grid.append(st.card);
  }
  $("#privacy-title", st.card).textContent = t("title");
  const had = st.body.contains(document.activeElement) ? document.activeElement.id : "";
  const open = new Set([...st.body.querySelectorAll("details[open]")].map((x) => x.dataset.part));
  const busy = !!st.busy || st.restarting;
  const parts = [
    ["files", section(t("files"), "", h("ul", { class: "list compact" }, d.files.map((f) =>
      h("li", { class: "item" }, h("div", {}, h("b", {}, f.name), h("p", { class: "muted small" }, `${f.what} · ${f.there ? t("here") : t("notHere")}`))))))],
    ["keys", section(t("keys"), t("keysLead"), h("ul", { class: "list compact" }, d.keys.map((k) =>
      h("li", { class: "item" }, h("div", {}, h("b", {}, k.what), h("p", { class: "muted small" }, `${k.key} · ${k.kept}`))))))],
    ["sends", section(t("sends"), t("sendsLead"), h("ul", { class: "list compact" }, d.sends.map((s) =>
      h("li", { class: "item" }, h("div", {}, h("b", {}, `${s.name} · ${s.detail}`), h("p", { class: "muted small" }, s.what))))))],
    ["never", section(t("never"), "", h("ul", { class: "list compact" }, d.never.map((x) => h("li", { class: "item" }, x))))],
  ];
  for (const [name, el] of parts) {
    el.dataset.part = name;
    if (open.has(name)) el.open = true;
  }
  const field = h("input", {
    id: "privacy-confirm", class: "tg-input", type: "text", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", maxlength: 40,
    placeholder: d.confirm, disabled: busy, "aria-describedby": "privacy-delete-lead",
    oninput: (e) => {
      st.typed = e.target.value;
      const go = $("#privacy-delete", st.card);
      if (go) go.disabled = busy || !typedOk();
    },
  });
  field.value = st.typed;
  const go = h("button", { id: "privacy-delete", type: "submit", class: "btn", disabled: busy || !typedOk() },
    st.busy === "delete" ? h("span", { class: "spinner", "aria-hidden": "true" }) : icon("trash-2"), st.busy === "delete" ? t("deleting") : t("deleteButton"));
  // The one red button in the panel: set here (CSSOM), as the page's style sheet has no such button.
  go.style.borderColor = "var(--danger)";
  go.style.color = "var(--danger)";
  // replaceChildren would write a null as the text "null": the parts not shown now are left out.
  st.body.replaceChildren(...[
    h("p", { class: "tg-lead" }, t("lead", { folder: d.folder })),
    ...parts.map(([, el]) => el),
    h("ul", { class: "list compact" }, d.how.map((x) => h("li", { class: "muted small" }, x))),
    h("div", { class: "tg-form" },
      h("button", { type: "button", class: "btn primary", disabled: busy, onclick: () => void exportAll() },
        st.busy === "export" ? h("span", { class: "spinner", "aria-hidden": "true" }) : icon("download"), st.busy === "export" ? t("exporting") : t("export"))),
    h("h3", { class: "mini-h" }, icon("trash-2"), t("deleteTitle")),
    h("p", { id: "privacy-delete-lead" }, t("deleteLead")),
    h("form", { class: "tg-form", onsubmit: (e) => (e.preventDefault(), void deleteAll()) },
      h("label", { class: "sr-only", for: "privacy-confirm" }, t("deleteLabel", { phrase: d.confirm })),
      field, go),
    h("p", { class: "muted small" }, t("deleteLabel", { phrase: d.confirm })),
    st.error ? h("p", { class: "tg-error", role: "alert" }, st.error) : null,
    st.note ? h("p", { class: "tg-ok", role: "status" }, st.restarting ? h("span", { class: "spinner", "aria-hidden": "true" }) : icon("circle-check"), st.note) : null,
    st.kept.length ? h("div", {}, h("p", {}, t("kept")), h("ul", { class: "list compact" }, st.kept.map((x) => h("li", { class: "muted small" }, x)))) : null,
  ].filter(Boolean));
  paintIcons();
  if (had) document.getElementById(had)?.focus();
}

void load();
