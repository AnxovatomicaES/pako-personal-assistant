// Pako · panel: moving from a server to a computer (src/move.ts). On a server's panel, one button gives the file to take to the computer; on a
// computer's panel, "Importar de otro Pako" takes that file: first it shows what would come in, what would be replaced and what is left out,
// and only a second press writes anything. Everything the server sends is put on the page as text, never as HTML.

const $ = (s, root = document) => root.querySelector(s);
const MAX = 8 * 1024 * 1024;

const WORDS = {
  serverTitle: "Move Pako to your computer",
  serverLead: "Download a file with your notes, reminders, lists, people, routines, follow-ups, meetings and the settings that are not secrets "
    + "(no secret at all). On your computer, \"Import from another Pako\" in Pako's panel takes it. The steps are in docs/server.md, "
    + "\"Move from a server to your Mac\".",
  download: "Download for my computer",
  downloading: "Preparing…",
  downloaded: "Downloaded: {file}. Open it in Pako's panel on your computer.",
  downloadFailed: "I couldn't prepare it. Try again.",
  title: "Import from another Pako",
  lead: "Were you using Pako on a server or another computer? Choose the file you downloaded there. Before anything changes I show you what comes in.",
  choose: "Choose file",
  reading: "Reading…",
  tooBig: "The file is too big (over 8 MB).",
  notJson: "That file is not a Pako export (it is not JSON).",
  failed: "I couldn't do it. Try again.",
  willCome: "What comes in",
  new: "new",
  replace: "replaces what is here",
  same: "already the same",
  left: "What stays out ({n})",
  name: "Your name: {name}",
  setHere: "Settings set in this Pako: {list}",
  byHand: "Settings to copy by hand into ~/.pako/.env (different here, or not set from the panel):",
  warnReplace: "It replaces {n} thing(s) this Pako already has. I keep a copy in its folder first.",
  go: "Import",
  going: "Importing…",
  cancel: "Cancel",
  nothing: "There is nothing to import in this file.",
  done: "Imported: {n} thing(s).",
  backup: "What was replaced is kept in {file}.",
  restarting: "Pako is starting again…",
  notBack: "Pako hasn't come back. Quit it and open it again.",
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
const spinner = () => h("span", { class: "spinner", "aria-hidden": "true" });

const st = { mode: "", busy: "", error: "", note: "", file: null, plan: null, result: null, restarting: false, card: null, body: null };

async function load() {
  try {
    const r = await fetch("/panel/api/move", { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) return;
    st.mode = (await r.json()).mode;
    render();
  } catch (err) {
    console.warn("move", err);
  }
}

async function download() {
  st.busy = "download";
  st.error = st.note = "";
  render();
  try {
    const r = await fetch("/panel/api/move/export", { credentials: "same-origin", cache: "no-store", headers: { "x-pako": "1" } });
    if (r.status === 401) return void location.reload();
    if (!r.ok) throw new Error(String(r.status));
    const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "pako-move.json";
    const url = URL.createObjectURL(await r.blob());
    const a = h("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    st.note = t("downloaded", { file: name });
  } catch {
    /* said in the error line */
    st.error = t("downloadFailed");
  } finally {
    st.busy = "";
    render();
  }
}

async function send(confirm) {
  const r = await fetch("/panel/api/move/import", {
    method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-pako": "1" },
    body: JSON.stringify(confirm ? { file: st.file, confirm: true } : { file: st.file }),
  });
  if (r.status === 401) {
    location.reload();
    return null;
  }
  const out = await r.json().catch(() => ({}));
  if (!r.ok || !out.ok) throw new Error(out.error || t("failed"));
  return out;
}

async function choose(input) {
  const f = input.files?.[0];
  input.value = "";
  if (!f) return;
  st.error = st.note = "";
  st.plan = st.result = null;
  if (f.size > MAX) {
    st.error = t("tooBig");
    return render();
  }
  st.busy = "read";
  render();
  try {
    try {
      st.file = JSON.parse(await f.text());
    } catch {
      /* not JSON: said as such */
      throw new Error(t("notJson"));
    }
    const out = await send(false);
    if (out) st.plan = out.plan;
  } catch (err) {
    st.file = null;
    st.error = err.message || t("failed");
  } finally {
    st.busy = "";
    render();
  }
}

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
    else if (down || Date.now() - start > 8_000) return void location.reload();
  }
  st.restarting = false;
  st.error = t("notBack");
  render();
}

async function confirmImport() {
  st.busy = "import";
  st.error = "";
  render();
  try {
    const out = await send(true);
    if (!out) return;
    st.result = out;
    st.plan = null;
    st.file = null;
    st.restarting = !!out.restarting;
    if (out.restarting) void waitForRestart();
  } catch (err) {
    st.error = err.message || t("failed");
  } finally {
    st.busy = "";
    render();
  }
}

function planView(p) {
  const moving = p.items.filter((i) => i.action !== "same");
  const replacing = p.items.filter((i) => i.action === "replace").length;
  const out = [];
  if (p.items.length) {
    out.push(h("h3", { class: "mini-h" }, t("willCome")),
      h("ul", { class: "list compact" }, p.items.map((i) => h("li", { class: "item" },
        h("div", {}, h("b", {}, i.what), h("p", { class: "muted small" }, `${i.key} · ${t(i.action)}`))))));
  }
  if (p.name) out.push(h("p", {}, t("name", { name: p.name })));
  if (p.settings.set.length) out.push(h("p", {}, t("setHere", { list: p.settings.set.join(", ") })));
  if (p.settings.byHand.length) {
    out.push(h("p", {}, t("byHand")), h("pre", { class: "muted small" }, p.settings.byHand.map((s) => `${s.key}=${s.value}`).join("\n")));
  }
  if (p.skipped.length) {
    out.push(h("details", { class: "tg" }, h("summary", { class: "mini-h" }, t("left", { n: p.skipped.length })),
      h("ul", { class: "list compact" }, p.skipped.map((s) => h("li", { class: "item" },
        h("div", {}, h("b", {}, s.what), h("p", { class: "muted small" }, `${s.key} · ${s.why}`)))))));
  }
  const anything = moving.length || p.name || p.settings.set.length;
  if (!anything) {
    out.push(h("p", { class: "muted" }, t("nothing")));
    return out;
  }
  if (replacing) out.push(h("p", { class: "tg-error" }, t("warnReplace", { n: replacing })));
  const busy = !!st.busy;
  out.push(h("div", { class: "tg-form" },
    h("button", { type: "button", class: "btn primary", disabled: busy, onclick: () => void confirmImport() },
      st.busy === "import" ? spinner() : icon("upload"), st.busy === "import" ? t("going") : t("go")),
    h("button", { type: "button", class: "btn", disabled: busy, onclick: () => ((st.plan = st.file = null), render()) }, t("cancel"))));
  return out;
}

function render() {
  if (!st.mode) return;
  if (!st.card) {
    st.body = h("div", { class: "tg" });
    st.card = h("section", { class: "card move", id: "move-card", "aria-labelledby": "h-move" },
      h("div", { class: "card-head" }, h("h2", { id: "h-move" }, icon("truck"), h("span", { id: "move-title" }))), st.body);
    // A computer's import is in Settings, Move & import; a server's panel (no Settings page) keeps its download card on the dashboard.
    const grid = $('[data-mount="move"]') ?? (st.mode === "server" ? $("#grid") : null);
    if (!grid) return;
    grid.append(st.card);
  }
  const server = st.mode === "server";
  $("#move-title", st.card).textContent = t(server ? "serverTitle" : "title");
  const busy = !!st.busy || st.restarting;
  const parts = [h("p", { class: "tg-lead" }, t(server ? "serverLead" : "lead"))];
  if (server) {
    parts.push(h("div", { class: "tg-form" }, h("button", { type: "button", class: "btn primary", disabled: busy, onclick: () => void download() },
      st.busy === "download" ? spinner() : icon("download"), st.busy === "download" ? t("downloading") : t("download"))));
  } else if (st.plan) {
    parts.push(...planView(st.plan));
  } else if (!st.result) {
    const input = h("input", { id: "move-file", type: "file", accept: ".json,application/json", class: "sr-only", disabled: busy, onchange: (e) => void choose(e.target) });
    parts.push(h("div", { class: "tg-form" }, input,
      h("label", { for: "move-file", class: "btn primary", role: "button" }, st.busy === "read" ? spinner() : icon("file-up"), st.busy === "read" ? t("reading") : t("choose"))));
  }
  if (st.result) {
    const r = st.result;
    parts.push(h("p", { class: "tg-ok", role: "status" }, st.restarting ? spinner() : icon("circle-check"),
      `${t("done", { n: r.imported })}${r.restarting ? ` ${t("restarting")}` : r.note ? ` ${r.note}` : ""}`));
    if (r.backup) parts.push(h("p", { class: "muted small" }, t("backup", { file: r.backup })));
    if (r.byHand?.length) parts.push(h("p", {}, t("byHand")), h("pre", { class: "muted small" }, r.byHand.map((s) => `${s.key}=${s.value}`).join("\n")));
  }
  if (st.error) parts.push(h("p", { class: "tg-error", role: "alert" }, st.error));
  if (st.note) parts.push(h("p", { class: "tg-ok", role: "status" }, icon("circle-check"), st.note));
  st.body.replaceChildren(...parts);
  paintIcons();
}

void load();
