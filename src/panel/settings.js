// Pako · the connections page (/panel/settings, src/settings-page.ts). One calm page: a ring of what is connected and the one thing to do
// next; in the Mac app, "May I look at what you have on this Mac?" (nothing is looked at before that yes, and macOS asks its own permissions);
// then one card per connection, each with a wizard that opens inline as a stepper and can be left and resumed (the step and the choices are
// kept in this browser, never a secret); last, everything the app found, with "Olvidar".
//
// The server's routes it uses: GET/POST /panel/api/connections (the values, saved in ~/.pako; a save restarts Pako, and the page waits for it),
// /panel/api/telegram*, /panel/api/whatsapp/setup, GET/DELETE /panel/api/discovery (?all=1: with the Mac's events and imported contacts),
// GET/POST /panel/api/calendar/local, GET /panel/api/mail/autoconfig, GET/DELETE /panel/api/people/imported, GET /panel/api/claude, and the
// live checks that test a value with its service before it is kept: POST /panel/api/mail/connect, and Slack's and Zoom's own Allow
// (POST /panel/api/slack/connect, /panel/api/zoom/connect, then GET .../account until the browser came back: src/connect-setup.ts).
// A "connected" screen is only shown after one of those said yes (or the Mac app did); what has no live check (a Claude key, an ICS link, a
// Places key) is said to be saved, not connected. One route that does not answer (an older Pako) is left out, never an error on the page. The
// talk with the Mac app is in settings-model.js. Everything from the server or the app is put on the page as text, never as HTML.

import { mountTwins } from "./figure-twin.js";
import { WORDS } from "./settings-words.js";
import {
  ADVANCED, askApp, cardStates, importedCount, checkField, cleanAppPassword, cleanDiscovery, connectedCount, COUNTED, discoveryChips, inApp, isEmail, nextSuggestion,
  providerOf, resumable, tellApp, accountLine, mailStatus, cleanClients, labHiddenCards,
} from "./settings-model.js";
import { h, localeOf, fill } from "./dom.js";

const $ = (s, root = document) => root.querySelector(s);
function t(key, vars) {
  const s = WORDS[key] ?? key;
  return vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m)) : String(s);
}
const has = (key) => Object.hasOwn(WORDS, key);
const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const icon = (name, cls = "") => h("i", { "data-lucide": name, class: cls || null });
const paint = () => window.lucide?.createIcons?.({ attrs: { "aria-hidden": "true" } });
// Any icon put on the page later (a result written into a step after an answer) is drawn too, once per frame.
let painting = 0;
new MutationObserver(() => {
  if (painting || !document.querySelector("i[data-lucide]")) return;
  painting = requestAnimationFrame(() => {
    painting = 0;
    paint();
  });
}).observe(document.documentElement, { childList: true, subtree: true });
const SVGNS = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const k of kids) el.append(k);
  return el;
}

// ---------- the server ----------

async function api(path, { method = "GET", body } = {}) {
  const init = { method, credentials: "same-origin", cache: "no-store", headers: {} };
  if (method !== "GET") init.headers["x-pako"] = "1";
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  try {
    const r = await fetch(path, init);
    if (r.status === 401) {
      location.href = "/panel";
      return { ok: false, status: 401, data: {} };
    }
    const data = await r.json().catch(() => ({}));
    // A route's rate limit says only "too many": the person gets what happened and what to do instead.
    if (r.status === 429) return { ok: false, status: 429, data: { ...data, error: t("err.tooMany") } };
    return { ok: r.ok, status: r.status, data };
  } catch {
    /* offline: no answer (status 0) */
    return { ok: false, status: 0, data: {} };
  }
}
/** A route's answer, or null when it does not answer here. */
const read = async (path) => {
  const r = await api(path);
  return r.ok ? r.data : null;
};

const S = {
  data: {},
  states: {},
  open: null,
  /** Each wizard's place: {step, path, address, provider} kept; the rest (fields typed, answers) lives only while the page is open. */
  wiz: {},
  app: inApp(window),
  discovering: false,
  declined: false,
  restarting: false,
  /** The cards of a lab that is off (labHiddenCards): not drawn. */
  hidden: new Set(),
};
const KEEP = "pako.settings.v1";
function remember() {
  try {
    localStorage.setItem(KEEP, JSON.stringify({ wiz: resumable(S.wiz), open: S.open, declined: S.declined }));
  } catch {
    /* private window: nothing is kept */
  }
}
function recall() {
  try {
    const v = JSON.parse(localStorage.getItem(KEEP) ?? "{}");
    S.wiz = resumable(v.wiz);
    S.open = typeof v.open === "string" && Object.hasOwn(CARD, v.open) ? v.open : null;
    S.declined = v.declined === true;
  } catch {
    /* not JSON, or no storage (a private window): started fresh */
    S.wiz = {};
  }
}
const W = (id) => (S.wiz[id] ??= { step: 0 });

async function loadAll() {
  const [connections, telegram, whatsapp, claude, discovery, localCalendar, people, details, claudeConnect, clients, reminders] = await Promise.all([
    read("/panel/api/connections"), read("/panel/api/telegram"), read("/panel/api/whatsapp/setup"), read("/panel/api/claude"),
    read("/panel/api/discovery"), read("/panel/api/calendar/local"), read("/panel/api/people/imported"), read("/panel/api/connections/details"),
    read("/panel/api/claude/connect"), read("/panel/api/connect/clients"), read("/panel/api/reminders"),
  ]);
  // The cards of a lab that is off (Settings › Labs, src/labs.ts) are not drawn.
  S.hidden = labHiddenCards(await read("/panel/api/labs"));
  // Which connections are one button (the project's own apps, src/connect-clients.ts); an older Pako answers nothing: none are.
  S.data = {
    connections, telegram, whatsapp, claude, discovery: cleanDiscovery(discovery), localCalendar, people, details, claudeConnect, clients: cleanClients(clients),
    reminders: reminders && typeof reminders === "object" ? reminders : null,
  };
  // Signed in here once: a later sign-out is "sign in again", not a first connection.
  if (claudeConnect?.account?.loggedIn) S.claudeSeen = true;
  if (claudeConnect && CLAUDE_BUSY.has(claudeConnect.phase)) claudeWatch();
  S.states = cardStates(S.data);
}

/** After a save that restarts Pako: waits for it to go and come back (/health), within a minute. True when it is back. */
async function waitForRestart() {
  S.restarting = true;
  const start = Date.now();
  let down = false;
  try {
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
      else if (down || Date.now() - start > 8_000) return true;
    }
    return false;
  } finally {
    S.restarting = false;
  }
}

/** Saves a connection's values (POST /panel/api/connections) and waits for the restart. {ok} or {error, field}. */
async function saveConnection(id, values) {
  const r = await api("/panel/api/connections", { method: "POST", body: { id, values } });
  if (!r.ok || !r.data.ok) return { ok: false, error: r.data.error || t(r.status ? "err.save" : "err.offline"), field: r.data.field || "" };
  if (r.data.restarting && !(await waitForRestart())) return { ok: false, error: t("err.notBack") };
  await loadAll();
  return { ok: true, later: !r.data.restarting };
}

/**
 * A live check that also saves (mail/connect, slack/check, zoom/check): POSTs, and when the service said yes waits for Pako's restart and
 * reads everything again. {ok: true} or {ok: false, data, error}: data is the route's answer (its why, its per-token errors).
 */
async function checkAndSave(path, body) {
  const r = await api(path, { method: "POST", body });
  if (!r.ok || r.data.ok !== true) {
    const error = typeof r.data.error === "string" && r.data.error ? r.data.error.slice(0, 400) : t(r.status ? "err.save" : "err.offline");
    return { ok: false, data: r.data ?? {}, error };
  }
  if (r.data.restarting && !(await waitForRestart())) return { ok: false, data: {}, error: t("err.notBack") };
  await loadAll();
  return { ok: true, data: r.data };
}

// ---------- the parts every wizard uses ----------

/** A field that checks itself as the person types: a ✓ when it looks right, a plain sentence when not (after the first blur). */
function field({ id, label, hint = "", kind = "", type = "text", value = "", secret = false, placeholder = "", onValue = null, autocomplete = "off" }) {
  const msgId = `${id}-msg`;
  const input = h("input", {
    id, type: secret ? "password" : type, class: "field-input", value, placeholder: placeholder || null, autocomplete, autocapitalize: "off",
    spellcheck: "false", maxlength: 2000, "aria-describedby": msgId, inputmode: type === "email" ? "email" : null,
  });
  const msg = h("p", { class: "field-msg", id: msgId }, hint);
  const mark = h("span", { class: "field-mark", "aria-hidden": "true" }, icon("check"));
  const wrap = h("div", { class: "field" }, h("label", { for: id }, label), h("div", { class: "field-box" }, input, mark), msg);
  let touched = false;
  const check = () => {
    const v = input.value;
    const verdict = kind ? checkField(kind, v) : v.trim() ? "ok" : "empty";
    wrap.classList.toggle("ok", verdict === "ok");
    const bad = verdict !== "ok" && verdict !== "empty" && touched;
    wrap.classList.toggle("bad", bad);
    input.setAttribute("aria-invalid", bad ? "true" : "false");
    msg.textContent = bad ? t(verdict, { other: kind === "slackApp" ? "xapp-" : "xoxp-" }) : hint;
    onValue?.(v, verdict === "ok");
    return verdict === "ok";
  };
  input.addEventListener("input", () => {
    if (input.value.length > 6) touched = true;
    check();
  });
  input.addEventListener("blur", () => {
    touched = input.value.trim().length > 0;
    check();
  });
  wrap.check = () => {
    touched = true;
    return check();
  };
  wrap.input = input;
  wrap.error = (text) => {
    wrap.classList.add("bad");
    wrap.classList.remove("ok");
    input.setAttribute("aria-invalid", "true");
    msg.textContent = text;
    input.focus();
  };
  queueMicrotask(check);
  return wrap;
}

/** A button that copies a text, and says so. */
function copyButton(text, label = t("copy")) {
  const b = h("button", { type: "button", class: "btn tiny ghost copy" }, icon("copy"), h("span", {}, label));
  b.addEventListener("click", async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      /* no clipboard permission: said on the button */
      ok = false;
    }
    b.classList.add("copied");
    b.querySelector("span").textContent = ok ? t("copied") : t("copyFailed");
    announce(ok ? t("copied") : t("copyFailed"));
    setTimeout(() => {
      b.classList.remove("copied");
      b.querySelector("span").textContent = label;
    }, 1600);
  });
  return b;
}
const codeLine = (text) => h("div", { class: "code-line" }, h("code", {}, text), copyButton(text));
/** A link to another site, in a new tab (the Mac app opens it in the default browser). */
const outLink = (url, label, cls = "btn primary") => h("a", { class: cls, href: url, target: "_blank", rel: "noopener noreferrer" }, label, icon("arrow-up-right"));

const live = () => $("#live");
function announce(text) {
  const l = live();
  if (!l) return;
  l.textContent = "";
  setTimeout(() => (l.textContent = text), 30);
}

/** "Probando…": a calm spinner with a sentence. */
const testing = (text = t("testing")) => h("div", { class: "testing", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", {}, text));

/** The ✓ connected moment: a ring that draws itself, a tick, a few sparks; and the sentence for screen readers. */
function success(title, line = "") {
  const ring = svg("svg", { viewBox: "0 0 64 64", class: "done-mark", "aria-hidden": "true" },
    svg("circle", { cx: 32, cy: 32, r: 28, class: "done-ring" }), svg("path", { d: "M20 33l8 8 16-17", class: "done-tick" }));
  const sparks = h("div", { class: "sparks", "aria-hidden": "true" }, Array.from({ length: 8 }, (_, i) => h("i", { style: { "--i": String(i) } })));
  announce(`${title} ${line}`.trim());
  dispatchEvent(new CustomEvent("pako:happy")); // Pako's figure in the header is glad (pako-figure.js)
  return h("div", { class: "done" }, h("div", { class: "done-art" }, ring, sparks), h("p", { class: "done-title" }, title), line ? h("p", { class: "done-line" }, line) : null);
}

/** Saved, not tested: a calm tick and what happens next (no "connected" claim). */
const saved = (title, line) => h("div", { class: "saved", role: "status" }, icon("circle-check"),
  h("div", {}, h("p", { class: "saved-title" }, title), h("p", {}, line)));

const problem = (text, fix = "") => h("div", { class: "problem", role: "alert" }, icon("circle-alert"), h("div", {}, h("p", {}, text), fix ? h("p", { class: "fix" }, fix) : null));

/**
 * A small illustrated screen (CSS made here, no picture from anywhere): a window or a phone with a few rows, one of them lit up with a
 * pointer moving to it. `rows`: [text | {text, hot?, mono?, dim?}].
 */
function mini({ kind = "window", title = "", rows = [], tint = "" }) {
  const body = rows.map((r, i) => {
    const o = typeof r === "string" ? { text: r } : r;
    const cls = ["mini-row", o.hot ? "hot" : "", o.mono ? "mono" : "", o.dim ? "dim" : "", o.me ? "me" : "", o.bubble ? "bubble" : ""].filter(Boolean).join(" ");
    return h("div", { class: cls, style: { "--d": `${i * 0.12}s` } }, o.text, o.hot ? h("span", { class: "mini-pointer" }) : null);
  });
  return h("figure", { class: `mini ${kind}${tint ? ` tint-${tint}` : ""}`, "aria-hidden": "true" },
    kind === "phone" ? h("div", { class: "mini-notch" }) : h("div", { class: "mini-bar" }, h("i"), h("i"), h("i"), h("span", {}, title)),
    kind === "phone" && title ? h("div", { class: "mini-head" }, title) : null,
    h("div", { class: "mini-body" }, body));
}

/** A step: its number, its title, what to do, the illustration beside it. */
const step = ({ title, text = "", art = null, children = [] }) =>
  h("div", { class: `step-view${art ? " with-art" : ""}` },
    h("div", { class: "step-main" }, h("h3", { class: "step-title", tabindex: "-1" }, title), text ? h("p", { class: "step-text" }, text) : null, children),
    art ? h("div", { class: "step-art" }, art) : null);

const actions = (...kids) => h("div", { class: "step-actions" }, kids);
/** A button; its handler gets {currentTarget: the button}, which stays good after an await (an event's own currentTarget does not). */
function btn(label, onclick, cls = "primary", attrs = {}) {
  const el = h("button", { type: "button", class: `btn ${cls}`, ...attrs }, label);
  el.addEventListener("click", () => onclick({ currentTarget: el }));
  return el;
}

/** Opens a card's wizard at a step and redraws it; the new step's title takes the focus. */
function go(id, stepNo, extra = {}) {
  Object.assign(W(id), { step: stepNo }, extra);
  remember();
  drawCard(id, { focusStep: true });
}

// ---------- the cards ----------

/** Each card: its icon and colour; what it does and its wizard come below. */
const CARD = {
  claude: { icon: "sparkles", hue: "violet" },
  calendar: { icon: "calendar-days", hue: "sky" },
  mail: { icon: "mail", hue: "rose" },
  applemail: { icon: "laptop", hue: "sky" },
  telegram: { icon: "send", hue: "sky" },
  whatsapp: { icon: "message-circle", hue: "green" },
  slack: { icon: "hash", hue: "plum" },
  zoom: { icon: "video", hue: "blue" },
  teams: { icon: "users-round", hue: "violet" },
  imessage: { icon: "message-square", hue: "green" },
  contacts: { icon: "users", hue: "amber" },
  tables: { icon: "utensils", hue: "rose" },
  resend: { icon: "send", hue: "rose" },
  phone: { icon: "phone", hue: "slate" },
  more: { icon: "sliders-horizontal", hue: "slate" },
};

/** The steps' names for the stepper at the top of each wizard. */
function stepNames(id) {
  const w = W(id);
  switch (id) {
    // The key's own step only when it is open: the main view is one button, with no stepper.
    case "claude": return w.step === 1 ? [t("claude.s1"), t("claude.s2")] : [t("claude.s1")];
    case "calendar": return w.path === "ics" ? [t("cal.s1"), t("cal.sIcs"), t("cal.sDone")] : [t("cal.s1"), t("cal.sPick"), t("cal.sDone")];
    case "mail": return w.path === "forward" ? [t("mail.s1"), t("mail.sFwd"), t("mail.sFwd2"), t("mail.sDone")]
      : [t("mail.s1"), t("mail.s2"), t("mail.sDone")];
    case "telegram": return [t("tg.s1"), t("tg.s2"), t("tg.s3"), t("tg.sDone")];
    case "slack": return [t("slack.s1"), t("slack.sConnect"), t("slack.sDone")];
    case "zoom": return w.path === "local" ? [t("zoom.s0"), t("zoom.sLocal")] : [t("zoom.s0"), t("zoom.sMake"), t("zoom.sConnect"), t("zoom.sDone")];
    case "contacts": return [t("contacts.s1"), t("contacts.sDone")];
    case "tables": return [t("tables.s1"), t("tables.s2"), t("tables.sDone")];
    case "resend": return [t("resend.s1"), t("resend.s2"), t("resend.sDone")];
    case "whatsapp": {
      const steps = Array.isArray(S.data.whatsapp?.steps) ? S.data.whatsapp.steps : [];
      return steps.length ? steps.map((s) => String(s.title ?? "").slice(0, 60)) : [t("wa.s1")];
    }
    default: return [];
  }
}

function badge(state) {
  const key = { on: "state.on", saved: "state.saved", partial: "state.partial", problem: "state.problem", off: "state.off" }[state] ?? "state.off";
  return h("span", { class: `badge ${state}` }, h("span", { class: "badge-dot", "aria-hidden": "true" }), t(key));
}

function drawCards() {
  // The essentials first; the Advanced group (a developer app on Meta, Slack or Zoom, or a fine detail) in its own list below.
  const slot = (id) => h("li", { class: "card-slot", id: `slot-${id}` });
  const ids = Object.keys(CARD).filter((id) => !S.hidden?.has(id));
  // Mail on this Mac sits beside the mail card: two ways to the same mailbox.
  const mailIds = ["mail", "applemail"].filter((id) => ids.includes(id));
  fill($("#cards"), ...ids.filter((id) => !ADVANCED.includes(id) && !mailIds.includes(id)).map(slot));
  { const m = $("#cards-mail"); if (m) fill(m, ...mailIds.map(slot)); }
  fill($("#cards-advanced"), ...ids.filter((id) => ADVANCED.includes(id)).map(slot));
  for (const id of ids) drawCard(id);
}

function drawCard(id, { focusStep = false, focusToggle = false } = {}) {
  const slot = $(`#slot-${id}`);
  if (!slot) return;
  const state = id === "phone" ? "advanced" : id === "more" ? "extra" : S.states[id] ?? "off";
  const open = S.open === id;
  const c = CARD[id];
  const wizId = `wiz-${id}`;
  const toggle = h("button", {
    type: "button", class: "card-toggle", "aria-expanded": open ? "true" : "false", "aria-controls": wizId, id: `toggle-${id}`,
    onclick: () => {
      S.open = open ? null : id;
      remember();
      for (const other of Object.keys(CARD)) if (other !== id) drawCard(other);
      drawCard(id, { focusToggle: !S.open, focusStep: !!S.open });
      if (S.open) $(`#slot-${id}`)?.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "nearest" });
    },
  },
  h("span", { class: `card-icon hue-${c.hue}` }, icon(c.icon)),
  h("span", { class: "card-words" },
    h("span", { class: "card-name" }, t(`${id}.name`)),
    h("span", { class: "card-what" }, t(`${id}.what`))),
  h("span", { class: "card-side" },
    state === "advanced" ? h("span", { class: "badge off" }, t("state.advanced")) : state === "extra" ? null : badge(state),
    h("span", { class: "card-cta" }, open ? t("close") : t(state === "on" || state === "saved" || state === "advanced" || state === "extra" ? "see" : state === "partial" || state === "problem" ? "continue" : "connect")),
    icon("chevron-down", "chev")));
  const wiz = open ? h("div", { class: "wizard", id: wizId, role: "group", "aria-labelledby": `toggle-${id}` }, details(id), wizard(id)) : null;
  const article = h("article", { class: `conn${open ? " open" : ""} state-${state}`, "data-id": id }, toggle, wiz);
  fill(slot, article);
  paint();
  if (focusStep) ($(".step-title", article) ?? toggle).focus({ preventScroll: false });
  else if (focusToggle) toggle.focus();
  drawHero();
}

/** The wizards whose last step only says it is done. */
const DONE_LAST = new Set(["calendar", "mail", "telegram", "slack", "zoom", "contacts", "tables", "resend"]);

/** The stepper and the step: shared by every wizard. */
function wizard(id) {
  const names = stepNames(id);
  const w = W(id);
  if (w.step >= Math.max(1, names.length)) w.step = 0;
  // A wizard left on its "Done" for a connection that is no longer on (disconnected since, or forgotten) starts again. Zoom's recordings on
  // this Mac are not a "Done": their last step is the one that turns them on (the card stays off for them).
  const lastIsAction = id === "zoom" && w.path === "local";
  if (DONE_LAST.has(id) && !lastIsAction && names.length > 1 && w.step === names.length - 1 && S.states[id] !== "on") w.step = 0;
  const body = VIEWS[id]?.(w) ?? h("p", {}, "");
  const stepper = names.length > 1
    ? h("ol", { class: "stepper", "aria-label": t("stepsOf", { n: names.length }) },
      names.map((n, i) => {
        // The last step of a connection that is on is a tick too: there is nothing left to do.
        const past = i < w.step || (i === names.length - 1 && i === w.step && S.states[id] === "on");
        return h("li", { class: past ? `past${i === w.step ? " now" : ""}` : i === w.step ? "now" : "", "aria-current": i === w.step ? "step" : null },
          h("span", { class: "dot", "aria-hidden": "true" }, past ? "✓" : String(i + 1)), h("span", { class: "label" }, n));
      }))
    : null;
  const leave = id === "phone" || id === "more" ? null : h("p", { class: "leave" }, icon("bookmark"), t("resumeNote"));
  return [stepper, h("div", { class: "step-wrap" }, body), leave];
}

// ---------- the wizards ----------

const VIEWS = {};

VIEWS.claude = (w) => {
  const st = S.data.claude?.status?.claude;
  const keyOn = S.data.connections?.connections?.find((c) => c.id === "claude")?.state === "on";
  if (w.step === 1) {
    const key = field({ id: "f-claude-key", label: t("claude.key"), hint: t("claude.keyHint"), kind: "anthropic", secret: true });
    const out = h("div", { "aria-live": "polite" });
    return step({
      title: t("claude.s2"), text: t("claude.keyText"),
      art: mini({ title: "console.anthropic.com", rows: [t("mini.apiKeys"), { text: t("mini.createKey"), hot: true }, { text: "sk-ant-api03-•••••", mono: true, dim: true }] }),
      children: [
        actions(outLink("https://console.anthropic.com/settings/keys", t("claude.openConsole"), "btn ghost")), key, out,
        actions(btn(t("back"), () => go("claude", 0), "ghost"), btn(t("save"), async (e) => {
          if (!key.check()) return key.input.focus();
          e.currentTarget.disabled = true;
          fill(out, testing(t("restarting")));
          const r = await saveConnection("claude", { ANTHROPIC_API_KEY: key.input.value.trim() });
          if (!r.ok) {
            fill(out);
            e.currentTarget.disabled = false;
            return key.error(r.error);
          }
          fill(out, saved(t("claude.keySaved"), t("claude.keySavedLine")));
          drawHero();
        })),
      ],
    });
  }
  // One button (src/claude-connect.ts, through the server on every system): it installs Claude Code when it is missing, opens Claude's own
  // sign-in in the browser when signed out, and says who is connected on which plan. The API key stays behind "Advanced".
  const v = S.data.claudeConnect;
  const phase = v?.phase ?? "idle";
  const a = v?.account ?? null;
  // A sign-in past its expiry still reads as signed in, but Claude refuses its runs: the button to sign in again, not "Connected".
  const expired = typeof a?.expiresAt === "number" && a.expiresAt <= Date.now();
  const signedIn = !!a?.loggedIn && !expired && phase !== "needs-plan";
  const kids = [];
  const connectBtn = (label = t("claude.connect"), body = {}) =>
    btn(label, () => claudeStart(body), "primary big", { "aria-describedby": "claude-sub" });
  const cancelBtn = () => btn(t("claude.cancel"), () => claudeCancel(), "ghost");
  if (phase === "checking") kids.push(testing(t("claude.checking")), actions(cancelBtn()));
  else if (phase === "installing") kids.push(testing(t("claude.installing", { s: v.seconds })), h("p", { class: "step-text" }, t("claude.installingLine")), actions(cancelBtn()));
  else if (phase === "signing-in") kids.push(testing(t("claude.browser")), h("p", { class: "step-text" }, t("claude.browserLine")), actions(cancelBtn()));
  else if (phase === "needs-plan") {
    kids.push(problem(t("claude.needsPlan"), t("claude.needsPlanLine")),
      actions(outLink(v.upgradeUrl || "https://claude.ai/upgrade", t("claude.upgrade"), "btn ghost"), btn(t("claude.checkAgain"), () => claudeStart())));
  } else if (phase === "install-failed") {
    kids.push(problem(t("claude.installFailed"), t("claude.installFix")), v.fix ? codeLine(v.fix) : null,
      v.detail ? h("p", { class: "field-msg" }, v.detail) : null, actions(btn(t("claude.retry"), () => claudeStart())));
  } else if (signedIn) {
    // Said calmly on every redraw; the ✓ moment only once, right after connecting here.
    const line = claudeAccountLine(a);
    kids.push(S.claudeJustConnected ? success(line, t("claude.readyLine")) : saved(line, st === "limit" ? t("claude.limit") : t("claude.readyLine")));
    S.claudeJustConnected = false;
    kids.push(S.claudeSignOutAsk
      ? h("div", { class: "problem", role: "alertdialog", "aria-label": t("claude.signOut") }, icon("circle-alert"),
        h("div", {}, h("p", {}, t("claude.signOutAsk")), actions(btn(t("claude.cancel"), () => ((S.claudeSignOutAsk = false), drawCard("claude")), "ghost"),
          btn(t("claude.signOut"), () => claudeSignOut(), "danger"))))
      : actions(btn(t("claude.switch"), () => claudeStart({ switch: true }), "ghost"), btn(t("claude.signOut"), () => ((S.claudeSignOutAsk = true), drawCard("claude")), "ghost")));
  } else if (v || st !== "ok") {
    const calm = phase === "timeout" ? t("claude.timeout") : phase === "failed" || phase === "cancelled" ? t("claude.notFinished")
      : phase === "missing" || st === "missing" ? t("claude.missing") : a && (expired || (!a.loggedIn && S.claudeSeen)) ? t("claude.login") : "";
    kids.push(calm ? h("p", { class: "step-text" }, calm) : null, actions(connectBtn(phase === "timeout" || phase === "failed" || phase === "cancelled" ? t("claude.retry") : t("claude.connect"))),
      h("p", { class: "field-msg", id: "claude-sub" }, t("claude.connectSub")));
  } else {
    // An older Pako without the connect route: its own word.
    kids.push(success(t("claude.ready"), t("claude.readyLine")));
  }
  if (S.claudeError) kids.push(problem(S.claudeError));
  if (keyOn) kids.push(h("p", { class: "step-text" }, t("claude.keyOn")));
  // The advanced way, tucked away: an Anthropic API key, paid by use.
  kids.push(h("details", { class: "advanced-key" }, h("summary", {}, t("claude.keyAdvanced")),
    h("p", { class: "step-text" }, t("claude.keyText")), actions(btn(t("claude.useKey"), () => go("claude", 1), "ghost"))));
  return step({
    title: t("claude.s1"), text: "",
    art: mini({ kind: "phone", title: "Pako", rows: [{ text: t("mini.claudeAsk"), me: true, bubble: true }, { text: t("mini.claudeAnswer"), bubble: true }] }),
    children: kids,
  });
};

/** "Connected · ana@example.com · Pro plan", or "Connected (API billing)". */
function claudeAccountLine(a) {
  if (a.billing === "api") return t("claude.api");
  if (a.billing === "cloud") return t("claude.cloud");
  return [t("claude.connected"), a.email, a.planLabel ? t("claude.planName", { plan: a.planLabel }) : ""].filter(Boolean).join(" · ");
}

const CLAUDE_BUSY = new Set(["checking", "installing", "signing-in"]);
/** While a step is under way: the server asked every two seconds, the card drawn again, until it ends (the server's own limits end it). */
function claudeWatch() {
  if (S.claudeTimer) return;
  S.claudeTimer = setInterval(async () => {
    const v = await read("/panel/api/claude/connect");
    if (v) S.data.claudeConnect = v;
    if (!v || !CLAUDE_BUSY.has(v.phase)) {
      clearInterval(S.claudeTimer);
      S.claudeTimer = null;
      if (v?.phase === "connected") {
        S.claudeJustConnected = true;
        S.claudeSeen = true;
        await loadAll();
      }
    }
    drawCard("claude");
  }, 2000);
}
async function claudeStart(body = {}) {
  S.claudeError = "";
  S.claudeSignOutAsk = false;
  const r = await api("/panel/api/claude/connect", { method: "POST", body });
  if (!r.ok) S.claudeError = t(r.status ? "err.save" : "err.offline");
  else S.data.claudeConnect = r.data;
  drawCard("claude", { focusStep: true });
  if (r.ok) claudeWatch();
}
async function claudeCancel() {
  const r = await api("/panel/api/claude/connect/cancel", { method: "POST" });
  if (r.ok) S.data.claudeConnect = r.data;
  drawCard("claude", { focusStep: true });
}
async function claudeSignOut() {
  S.claudeSignOutAsk = false;
  const r = await api("/panel/api/claude/signout", { method: "POST", body: { confirm: true } });
  S.claudeError = r.ok && r.data.ok ? "" : t("claude.signOutFailed");
  if (r.ok) S.data.claudeConnect = { ...r.data };
  S.claudeSeen = true;
  await loadAll();
  drawCard("claude", { focusStep: true });
}

// ----- Calendar: the Mac's own calendars (checkboxes with colours), or a private ICS link -----

VIEWS.calendar = (w) => {
  const d = S.data.discovery;
  const googleOut = h("div", { "aria-live": "polite" });
  if (w.step === 0) {
    const cals = d?.calendars ?? [];
    return step({
      title: t("cal.add"), text: t("cal.lead"),
      art: mini({ title: t("mini.calendar"), rows: [{ text: "09:30  Team" }, { text: "11:00  Dentist", hot: true }, { text: "16:00  Pick up Lucy" }], tint: "sky" }),
      children: [
        h("div", { class: "choices" },
          S.app ? choice("laptop", t("cal.fromMac"), cals.length ? t("cal.fromMacFound", { n: cals.length }) : t("cal.fromMacHint"), async () => {
            if (!cals.length) {
              const found = await discover(["calendars"]);
              if (!found?.calendars.length) return;
            }
            go("calendar", 1, { path: "mac" });
          }) : null,
          S.data.clients?.google ? choice("calendar", t("cal.google"), t("cal.googleLine"), async (e) => {
            const acc = await waitForAllow({ start: "/panel/api/google/connect", body: {}, account: "/panel/api/google/account", service: "Google" },
              googleOut, e.currentTarget);
            if (acc) go("calendar", 2, { path: "google", works: t("cal.googleDone", { user: typeof acc.user === "string" ? acc.user : "" }) });
          }) : null,
          choice("link", t("cal.fromLink"), t("cal.fromLinkHint"), () => go("calendar", 1, { path: "ics" }))),
        googleOut,
        !S.app ? h("p", { class: "aside" }, icon("laptop"), t("cal.appCanDo")) : null,
      ],
    });
  }
  if (w.step === 1 && w.path !== "ics") return calendarPick(d);
  if (w.step === 1) return calendarIcs(w);
  // The Mac's calendars are on when the app said so; a link is kept only after it was read once (or the owner said to keep it anyway).
  const end = w.path === "google" ? success(t("cal.added"), w.works ?? "") : w.path === "ics" ? (w.works ? success(t("cal.added"), w.works) : saved(t("cal.icsSaved"), t("cal.icsSavedLine"))) : success(t("cal.done"), t("cal.doneLine"));
  return step({ title: t("cal.sDone"), children: [end, actions(btn(t("cal.again"), () => go("calendar", 0), "ghost"))] });
};

function calendarPick(d) {
  const cals = d?.calendars ?? [];
  // What the app already shows Pako; the first time, every calendar ticked (one untick is quicker than many ticks).
  // The server lists them as {id, title}; an older one as ids.
  const now = (Array.isArray(S.data.localCalendar?.calendars) ? S.data.localCalendar.calendars : [])
    .map((c) => (typeof c === "string" ? c : c?.id)).filter((id) => cals.some((c) => c.id === id));
  const chosen = new Set(now.length ? now : cals.map((c) => c.id));
  const out = h("div", { "aria-live": "polite" });
  const groups = {};
  for (const c of cals) (groups[c.source || t("cal.otherSource")] ??= []).push(c);
  const boxes = Object.entries(groups).map(([src, list]) => h("fieldset", { class: "cal-group" }, h("legend", {}, src),
    list.map((c) => {
      const id = `cal-${c.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
      const box = h("input", { type: "checkbox", id, checked: chosen.has(c.id) });
      box.addEventListener("change", () => (box.checked ? chosen.add(c.id) : chosen.delete(c.id)));
      return h("label", { class: "cal-row", for: id }, box, h("span", { class: "swatch", style: { background: c.color } }), h("span", {}, c.title));
    })));
  return step({
    title: t("cal.sPick"), text: t("cal.pickText"),
    children: [
      cals.length ? h("div", { class: "cal-list" }, boxes) : h("p", { class: "aside" }, t("cal.noneFound")), out,
      actions(btn(t("back"), () => go("calendar", 0), "ghost"), btn(t("cal.useThese"), async (e) => {
        if (!chosen.size) return fill(out, problem(t("cal.pickOne")));
        e.currentTarget.disabled = true;
        fill(out, testing(t("cal.connecting")));
        const r = await askApp(window, { type: "use", what: "calendars", ids: [...chosen] }, "pakoUsed", 30_000, (v) => v?.what === "calendars");
        if (!r?.ok) {
          e.currentTarget.disabled = false;
          return fill(out, problem(r ? (typeof r.error === "string" && r.error ? r.error.slice(0, 300) : t("cal.appFailed")) : t("app.noAnswer"),
            r ? "" : t("app.update")));
        }
        await loadAll();
        // "Lo que Pako sabe" and the chips say it too (with its forget), not only this card.
        drawKnown();
        drawDiscovery();
        go("calendar", 2, { path: "mac" });
      })),
    ],
  });
}

const ICS_HELP = ["google", "microsoft", "icloud", "zoho"];
function calendarIcs(w) {
  const provider = ICS_HELP.includes(w.provider) ? w.provider : "google";
  const link = field({ id: "f-ics", label: t("cal.icsLabel"), hint: t("cal.icsHint"), kind: "ics", placeholder: "https://calendar.google.com/…/basic.ics" });
  const out = h("div", { "aria-live": "polite" });
  const tabs = h("div", { class: "tabs", role: "group", "aria-label": t("cal.whichProvider") }, ICS_HELP.map((p) => h("button", {
    type: "button", class: `tab${p === provider ? " on" : ""}`, "aria-pressed": p === provider ? "true" : "false",
    onclick: () => go("calendar", 1, { path: "ics", provider: p }),
  }, t(`prov.${p}`))));
  const steps = [1, 2, 3].map((n) => t(`ics.${provider}.${n}`));
  return step({
    title: t("cal.sIcs"), text: t("cal.icsText"),
    art: mini({ title: t(`ics.${provider}.where`), rows: [t(`ics.${provider}.row1`), { text: t(`ics.${provider}.row2`), hot: true }, { text: "https://…/basic.ics", mono: true, dim: true }] }),
    children: [
      tabs, h("ol", { class: "how" }, steps.map((s) => h("li", {}, s))),
      provider === "google" ? actions(outLink("https://calendar.google.com/calendar/r/settings", t("ics.openGoogle"), "btn ghost")) : null,
      link, out,
      actions(btn(t("back"), () => go("calendar", 0), "ghost"), btn(t("cal.check"), async (e) => {
        if (!link.check()) return link.input.focus();
        const button = e.currentTarget;
        button.disabled = true;
        const add = async (anyway) => {
          fill(out, testing(t("cal.checking")));
          const r = await addCalendarLink(link.input.value.trim(), anyway);
          if (r.ok) return go("calendar", 2, { path: "ics", works: r.works ?? "" });
          button.disabled = false;
          // Why it does not work, where the right link is for a known service, and the way to keep it anyway (a calendar down for now).
          fill(out, problem(r.error, r.help ?? ""), r.canForce ? actions(btn(t("cal.anyway"), () => void add(true), "ghost")) : "");
        };
        await add(false);
      })),
    ],
  });
}

/** A big choice: an icon, a title, a line. */
const choice = (iconName, title, line, onclick) => h("button", { type: "button", class: "choice", onclick },
  h("span", { class: "choice-icon" }, icon(iconName)), h("span", { class: "choice-title" }, title), h("span", { class: "choice-line" }, line), icon("arrow-right", "go"));

// ----- Mail: pick an account (or type one), the server fills in the rest, one app password, a live test -----

const MAIL_PASSWORD_PAGE = {
  google: "https://myaccount.google.com/apppasswords",
  icloud: "https://account.apple.com/account/manage/section/security",
  microsoft: "https://account.live.com/proofs/AppPassword",
  yahoo: "https://login.yahoo.com/account/security/app-passwords",
};
const mailCache = new Map();

VIEWS.mail = (w) => {
  if (w.path === "forward") return mailForward(w);
  if (w.step === 1) return mailPassword(w);
  if (w.step === 2) return step({ title: t("mail.sDone"), children: [success(t("mail.done", { address: w.address ?? "" }), t("mail.doneLine")),
    actions(btn(t("mail.another"), () => go("mail", 0, { address: undefined }), "ghost"))] });
  const d = S.data.discovery;
  const accounts = d?.mailAccounts ?? [];
  const typed = field({ id: "f-mail-address", label: t(accounts.length ? "mail.addressOr" : "mail.address"), hint: t("mail.addressHint"), kind: "email",
    type: "email", value: w.address ?? "", autocomplete: "email" });
  const next = (address) => go("mail", 1, { address, provider: providerOf(address), path: "imap" });
  // After a look on this Mac that found no account: why (Mail refused) with its way out, or that there was none.
  const lookedNone = S.app && !accounts.length && mailLooked;
  const status = S.app ? mailStatus(d) : null;
  return step({
    title: t("mail.s1"), text: t("mail.lead"),
    art: mini({ title: t("mini.inbox"), rows: [{ text: t("mini.mail1"), hot: true }, t("mini.mail2"), { text: t("mini.mail3"), dim: true }], tint: "rose" }),
    children: [
      accounts.length ? h("div", { class: "pick-list", role: "group", "aria-label": t("mail.found") },
        accounts.map((a) => h("button", { type: "button", class: "pick", onclick: () => next(a.address) },
          h("span", { class: `prov-dot prov-${a.provider}`, "aria-hidden": "true" }),
          h("span", { class: "pick-main" }, a.address, a.apps?.length ? h("small", { class: "pick-from" }, ` · ${t("mail.foundIn", { apps: a.apps.map((x) => t(`from.${x}`)).join(", ") })}`) : null),
          h("span", { class: "pick-side" }, a.icloudMail ? t("mail.icloudConnect") : t(`prov.${a.provider}`)), icon("arrow-right")))) : null,
      // The explicit button may open Mail (openMail): without it the app skips a closed Mail and finds nothing.
      S.app && (!accounts.length || ["closed", "failed"].includes(d?.mailState)) ? h("div", { class: "look-mac" }, actions(btn(t("mail.lookMac"), async () => {
        await discover(["mail"], { openMail: true });
        mailLooked = true;
        drawCard("mail");
      }, "ghost")), h("p", { class: "field-msg" }, t("mail.lookMacHint"))) : null,
      // The last look's exact words: how many addresses, and what Mail itself said (not set up, refused, closed, no answer).
      status ? h("div", { class: "mail-status", role: "status" },
        status.found ? h("p", { class: "aside" }, icon("circle-check"), t(status.found.key, status.found.vars)) : null,
        status.mail ? h("p", { class: "aside" }, icon("info"), t(status.mail)) : null,
        status.denied ? deniedBox(["mail"]) : null)
        : lookedNone && d?.permissions.mail === "denied" ? deniedBox(["mail"]) : lookedNone ? h("p", { class: "aside" }, icon("info"), t("mail.noneOnMac")) : null,
      typed,
      actions(btn(t("next"), () => (typed.check() ? next(typed.input.value.trim().toLowerCase()) : typed.input.focus()))),
      h("p", { class: "aside" }, icon("forward"), h("span", {}, t("mail.orForward"), " ",
        h("button", { type: "button", class: "link", onclick: () => go("mail", 1, { path: "forward" }) }, t("mail.forwardLink")))),
    ],
  });
};
/** "Sign in with Microsoft/Google", filled in once the server says it has a client for that provider (otherwise nothing is shown). */
function signInBox(address, provider) {
  const box = h("div");
  const name = provider === "microsoft" ? "Microsoft" : "Google";
  void read("/panel/api/mail/oauth").then((d) => {
    if (d?.[provider] !== true) return;
    const out = h("div", { "aria-live": "polite" });
    fill(box, h("div", { class: "note", role: "note" }, icon("log-in"), h("div", {},
      h("p", {}, t("mail.signInLine", { name })),
      actions(btn(t("mail.signInWith", { name }), async (e) => {
        const acc = await waitForAllow({ start: "/panel/api/mail/oauth/start", body: { provider, address }, account: "/panel/api/mail/oauth/account", service: name },
          out, e.currentTarget);
        if (acc) go("mail", 2, { address: typeof acc.user === "string" ? acc.user : address });
      })), out,
      provider === "google" ? h("p", { class: "fix" }, t("mail.signInOr")) : null)));
    paint();
  });
  return box;
}

/** Whether the mail card's own "find my accounts" ran on this page (its answer is then said on the card). */
let mailLooked = false;
/** Whether the contacts card's own look ran on this page (a count of 0 then means none, not "never looked"). */
let contactsLooked = false;

const SOURCES = ["builtin", "ispdb", "autoconfig", "mx", "guess"];
async function autoconfig(address) {
  if (mailCache.has(address)) return mailCache.get(address);
  const r = await api(`/panel/api/mail/autoconfig?address=${encodeURIComponent(address)}`);
  const d = r.ok && typeof r.data?.host === "string" && r.data.host ? r.data : null;
  const clean = d ? {
    host: String(d.host).slice(0, 253), port: Number.isInteger(d.port) ? d.port : 993, tls: d.tls !== false, username: typeof d.username === "string" && d.username
      ? d.username.slice(0, 254) : address, provider: typeof d.provider === "string" ? d.provider : providerOf(address),
    // "guess": imap.<domain>, checked by nobody: the person is asked to confirm it. The note: the server's warning for this provider.
    source: SOURCES.includes(d.source) ? d.source : "builtin",
    note: typeof d.note === "string" ? d.note.slice(0, 500) : "",
    // What must be on first (2-step verification), and what to do when the provider says no (src/mail-autoconfig.ts advice).
    before: typeof d.before === "string" ? d.before.slice(0, 500) : "",
    refused: typeof d.refused === "string" ? d.refused.slice(0, 500) : "",
    work: d.work === true,
    appPassword: {
      needed: d.appPassword?.needed !== false,
      url: typeof d.appPassword?.url === "string" && /^https:\/\//.test(d.appPassword.url) ? d.appPassword.url : "",
      steps: Array.isArray(d.appPassword?.steps) ? d.appPassword.steps.filter((s) => typeof s === "string").slice(0, 6).map((s) => s.slice(0, 300)) : [],
    },
  } : null;
  if (clean) mailCache.set(address, clean);
  return clean;
}

function mailPassword(w) {
  const address = w.address ?? "";
  const holder = h("div", {}, testing(t("mail.looking", { address })));
  void (async () => {
    const cfg = await autoconfig(address);
    if (S.open !== "mail" || W("mail").step !== 1) return;
    fill(holder, cfg ? passwordStep(w, cfg) : manualServer(w));
    paint();
  })();
  return holder;
}

/** The provider's illustrated steps (its own words when the server sent them), its page, the one field, and the server's warning if any. */
function passwordStep(w, cfg) {
  const p = ["google", "icloud", "microsoft", "yahoo"].includes(cfg.provider) ? cfg.provider : providerOf(w.address);
  const url = cfg.appPassword.url || MAIL_PASSWORD_PAGE[p] || "";
  const steps = cfg.appPassword.steps.length ? cfg.appPassword.steps : has(`apppw.${p}.1`) ? [1, 2, 3].map((n) => t(`apppw.${p}.${n}`))
    : [t("apppw.other.1"), t("apppw.other.2"), t("apppw.other.3")];
  const app = cfg.appPassword.needed;
  const pw = field({ id: "f-mail-pw", label: t(app ? "mail.pwLabel" : "mail.pwLabelPlain"), hint: t(app ? "mail.pwHint" : "mail.pwHintPlain"),
    kind: "appPassword", secret: true, placeholder: app ? "abcd efgh ijkl mnop" : "" });
  const out = h("div", { "aria-live": "polite" });
  const guess = cfg.source === "guess";
  // A guessed server is shown to be confirmed or changed; a found one is folded away under "details".
  const host = guess ? field({ id: "f-imap-host", label: t("mail.server"), hint: t("mail.serverHint"), value: cfg.host, placeholder: "imap.example.com" }) : null;
  const found = guess ? h("div", { class: "found-server warn" }, icon("circle-help"), h("div", {}, h("p", {}, t("mail.guessed")), host))
    : h("div", { class: "found-server" }, icon("wand-sparkles"), h("div", {},
      h("p", {}, t("mail.filled", { address: w.address ?? "" })),
      // The server is said, not only folded away: someone setting up another mail app with the same steps sees what to type there.
      h("p", { class: "aside" }, icon("server"), h("span", {}, t("mail.serverLine", { host: cfg.host, port: cfg.port }))),
      h("details", {}, h("summary", {}, t("mail.details")), h("dl", {}, h("dt", {}, t("mail.server")), h("dd", {}, `${cfg.host}:${cfg.port}`),
        h("dt", {}, t("mail.user")), h("dd", {}, cfg.username)))));
  // Microsoft: many accounts can no longer sign in with a password; forwarding is offered first, the password below as the other way.
  const ms = cfg.provider === "microsoft" || cfg.work;
  const note = cfg.note && !guess ? h("div", { class: "note warn", role: "note" }, icon("triangle-alert"), h("div", {}, h("p", {}, cfg.note),
    ms ? actions(btn(t("mail.forwardInstead"), () => go("mail", 1, { path: "forward" }))) : null,
    ms ? h("p", { class: "fix" }, t("mail.orPassword")) : null)) : null;
  // Microsoft and Google: signing in on their own page, when this Pako has a client for it (src/mail-oauth.ts). Microsoft takes no
  // password any more, so that is the way; for Gmail the app password below stays as the other way.
  const signIn = ["microsoft", "google"].includes(cfg.provider) ? signInBox(w.address ?? "", cfg.provider) : null;
  return step({
    title: app ? t("mail.s2") : t("mail.s2plain"),
    text: app ? t("mail.pwWhy") : t("mail.pwPlain"),
    // The "app passwords" picture only where one is made; a usual password needs no picture.
    art: app ? mini({ title: t(`apppw.${has(`apppw.${p}.where`) ? p : "other"}.where`), rows: [t("mini.security"), { text: t("mini.appPasswords"), hot: true },
      { text: "abcd efgh ijkl mnop", mono: true }], tint: "rose" }) : null,
    children: [
      signIn, note, found,
      app && cfg.before ? h("p", { class: "aside" }, icon("shield-check"), h("span", {}, cfg.before)) : null,
      app ? h("ol", { class: "how illustrated" }, steps.map((s, i) => h("li", { style: { "--d": `${i * 0.08}s` } }, s))) : null,
      url && app ? actions(outLink(url, t("mail.openPw"), "btn ghost")) : null,
      pw, out,
      cfg.refused ? h("p", { class: "aside" }, icon("life-buoy"), h("span", {}, cfg.refused)) : null,
      actions(btn(t("back"), () => go("mail", 0), "ghost"), btn(t("saveTest"), async (e) => {
        if (host && !host.check()) return host.input.focus();
        if (!pw.check()) return pw.input.focus();
        e.currentTarget.disabled = true;
        const server = host ? { ...cfg, host: host.input.value.trim().toLowerCase(), port: 993 } : cfg;
        // An app password is shown in groups ("abcd efgh ijkl mnop"): its spaces are not part of it. A usual password is sent as typed.
        await connectImap(w, server, app ? cleanAppPassword(pw.input.value) : pw.input.value, out, pw, e.currentTarget, host);
      })),
    ],
  });
}

/** No autoconfiguration (an older Pako, or a domain nobody knows): the server's name and the password, with a plain hint. */
function manualServer(w) {
  const host = field({ id: "f-imap-host", label: t("mail.server"), hint: t("mail.serverHint"), placeholder: "imap.example.com" });
  const pw = field({ id: "f-mail-pw", label: t("mail.pwLabelPlain"), hint: t("mail.pwHintPlain"), kind: "appPassword", secret: true });
  const out = h("div", { "aria-live": "polite" });
  return step({
    title: t("mail.manual"), text: t("mail.manualText"),
    children: [host, pw, out, actions(btn(t("back"), () => go("mail", 0), "ghost"), btn(t("saveTest"), async (e) => {
      if (!host.check()) return host.input.focus();
      if (!pw.check()) return pw.input.focus();
      e.currentTarget.disabled = true;
      const cfg = { host: host.input.value.trim().toLowerCase(), port: 993, tls: true, username: w.address, provider: "other" };
      await connectImap(w, cfg, pw.input.value, out, pw, e.currentTarget, host);
    }))],
  });
}

/**
 * The live login (POST /panel/api/mail/connect): the server signs in, read only, and keeps the mailbox only when that worked. A refused
 * password is said on the password field; a server that cannot be reached, with how to fix the server; "Done" only after a yes.
 */
async function connectImap(w, cfg, password, out, pw, button, hostField = null) {
  fill(out, testing(t("mail.testingLogin", { address: w.address ?? "" })));
  const body = { address: w.address, password: String(password ?? "").trim(), host: cfg.host, port: cfg.port || 993, username: cfg.username || w.address };
  const r = await checkAndSave("/panel/api/mail/connect", body);
  if (S.open !== "mail") return;
  if (!r.ok) {
    button.disabled = false;
    fill(out);
    const why = r.data.why;
    if (why === "auth" || why === "password") {
      pw.error(r.error);
      // Refused: forwarding is the way that always works (a Microsoft 365 or Workspace account may never accept a password). What else to
      // try is said under the field (cfg.refused).
      if (why === "auth") fill(out, actions(btn(t("mail.forwardInstead"), () => go("mail", 1, { path: "forward" }), "ghost")));
      return;
    }
    if ((why === "network" || why === "tls") && hostField) return hostField.error(`${r.error} ${t("mail.fixServer")}`);
    return fill(out, problem(r.error, why === "network" || why === "tls" ? t("mail.fixServer") : ""));
  }
  go("mail", 2, { path: "imap" });
}

/** Forwarding to a mailbox of Pako's own (AgentMail): the key and the inbox (checked live by the server), then how to forward. */
function mailForward(w) {
  if (w.step <= 1) {
    const key = field({ id: "f-am-key", label: t("fwd.key"), hint: t("fwd.keyHint"), kind: "agentmailKey", secret: true });
    const inbox = field({ id: "f-am-inbox", label: t("fwd.inbox"), hint: t("fwd.inboxHint"), kind: "email", placeholder: "pako@agentmail.to" });
    const out = h("div", { "aria-live": "polite" });
    return step({
      title: t("mail.sFwd"), text: t("fwd.text"),
      art: mini({ title: "agentmail.to", rows: [t("mini.inboxes"), { text: "pako@agentmail.to", hot: true, mono: true }, { text: t("mini.apiKey"), dim: true }] }),
      children: [
        actions(outLink("https://agentmail.to", t("fwd.open"), "btn ghost")), key, inbox, out,
        actions(btn(t("back"), () => go("mail", 0, { path: "imap" }), "ghost"), btn(t("saveTest"), async (e) => {
          if (!key.check()) return key.input.focus();
          if (!inbox.check()) return inbox.input.focus();
          e.currentTarget.disabled = true;
          fill(out, testing());
          const r = await saveConnection("mail", { AGENTMAIL_API_KEY: key.input.value.trim(), AGENTMAIL_INBOX: inbox.input.value.trim() });
          if (!r.ok) {
            e.currentTarget.disabled = false;
            fill(out);
            return (r.field === "AGENTMAIL_INBOX" ? inbox : key).error(r.error);
          }
          go("mail", 2, { path: "forward", address: inbox.input.value.trim() });
        })),
      ],
    });
  }
  if (w.step === 2) {
    const inbox = w.address ?? S.data.connections?.connections?.find((c) => c.id === "mail")?.fields?.find((f) => f.key === "AGENTMAIL_INBOX")?.tail ?? "";
    return step({
      title: t("mail.sFwd2"), text: t("fwd.howText"),
      art: mini({ title: t("mini.settings"), rows: [t("mini.forwarding"), { text: t("mini.addForward"), hot: true }, { text: inbox || "pako@agentmail.to", mono: true }] }),
      children: [
        isEmail(inbox) ? codeLine(inbox) : null,
        h("ol", { class: "how" }, [1, 2, 3].map((n) => h("li", {}, t(`fwd.how${n}`)))),
        actions(btn(t("done"), () => go("mail", 3, { path: "forward" }))),
      ],
    });
  }
  return step({ title: t("mail.sDone"), children: [success(t("fwd.done"), t("fwd.doneLine")), actions(btn(t("mail.another"), () => go("mail", 0, { path: "imap" }), "ghost"))] });
}

// ----- Telegram: open BotFather, paste the token, tap the pairing link, done -----

let tgPoll = 0;
VIEWS.telegram = (w) => {
  const tg = S.data.telegram;
  if (tg?.state === "paired" && w.step < 3) w.step = 3;
  else if (tg?.state === "unpaired" && w.step < 2) w.step = 2;
  if (!tg) return step({ title: t("tg.s1"), children: [problem(t("tg.unavailable"))] });
  // A bot already stored whose messages go elsewhere (a server's webhook, another Pako): the server says why, in a sentence, as the panel does.
  const why = tg.state === "no-token" && typeof tg.why === "string" && tg.why.trim() ? problem(tg.why.trim().slice(0, 400)) : null;
  if (w.step === 0) {
    return step({
      title: t("tg.s1"), text: t("tg.lead"),
      art: h("div", { class: "qr-art" }, h("img", { src: "/panel/assets/botfather.svg", alt: t("tg.qrAlt"), width: 132, height: 132 }), h("p", {}, t("tg.qrLine"))),
      children: [
        why,
        h("ol", { class: "how" }, h("li", {}, t("tg.how1")), h("li", {}, t("tg.how2"), " ", h("code", {}, "/newbot")), h("li", {}, t("tg.how3"))),
        codeLine("/newbot"),
        actions(outLink("https://t.me/BotFather", t("tg.openBotFather")), btn(t("tg.haveToken"), () => go("telegram", 1), "ghost")),
      ],
    });
  }
  if (w.step === 1) {
    const token = field({ id: "f-tg-token", label: t("tg.token"), hint: t("tg.tokenHint"), kind: "telegramToken", secret: true,
      placeholder: "123456789:AAH…" });
    const out = h("div", { "aria-live": "polite" });
    return step({
      title: t("tg.s2"), text: t("tg.pasteText"),
      art: mini({ kind: "phone", title: "BotFather", rows: [{ text: "/newbot", me: true, bubble: true }, { text: t("mini.tgName"), bubble: true },
        { text: t("mini.tgDone"), bubble: true }, { text: "123456789:AAH…", bubble: true, hot: true, mono: true }] }),
      children: [why, token, out, tg.fixed ? problem(t("tg.fixed")) : null,
        actions(btn(t("back"), () => go("telegram", 0), "ghost"), btn(t("tg.check"), async (e) => {
          if (!token.check()) return token.input.focus();
          e.currentTarget.disabled = true;
          fill(out, testing(t("tg.checking")));
          const r = await api("/panel/api/telegram/token", { method: "POST", body: { token: token.input.value.trim() } });
          if (!r.ok || !r.data.ok) {
            e.currentTarget.disabled = false;
            fill(out);
            return token.error(r.data.error || t("err.save"));
          }
          announce(t("tg.botOk", { bot: r.data.bot }));
          await loadAll();
          go("telegram", 2);
        }))],
    });
  }
  if (w.step === 2) {
    const holder = h("div", { class: "pair" }, testing(t("tg.making")));
    void pairTelegram(holder);
    return step({ title: t("tg.s3"), text: t("tg.pairText", { bot: tg.bot ? `@${tg.bot}` : t("tg.yourBot") }), children: [holder] });
  }
  clearInterval(tgPoll);
  return step({
    title: t("tg.sDone"),
    children: [success(t("tg.done"), tg.account ? t("tg.doneWho", { who: String(tg.account).slice(0, 80) }) : t("tg.doneLine")),
      actions(btn(t("tg.unpair"), async () => {
        if (!confirm(t("tg.unpairConfirm"))) return;
        await api("/panel/api/telegram/off", { method: "POST" });
        await loadAll();
        go("telegram", 2);
      }, "ghost"))],
  });
};

async function pairTelegram(holder) {
  const r = await api("/panel/api/telegram/link", { method: "POST" });
  if (!r.ok || typeof r.data.link !== "string" || !/^https:\/\/t\.me\//.test(r.data.link)) {
    fill(holder, problem(r.data.error || t("tg.noLink")), actions(btn(t("tryAgain"), () => go("telegram", 2))));
    return paint();
  }
  const qr = typeof r.data.svg === "string" && /^\s*<svg[\s>]/.test(r.data.svg)
    ? h("img", { class: "qr", src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(r.data.svg)}`, alt: t("tg.pairQr"), width: 180, height: 180 }) : null;
  fill(holder, 
    h("div", { class: "pair-row" }, qr, h("div", {},
      h("p", {}, t(S.app ? "tg.tapHere" : "tg.scanOrTap")),
      actions(outLink(r.data.link, t("tg.openLink"))),
      h("p", { class: "waiting" }, h("span", { class: "pulse", "aria-hidden": "true" }), t("tg.waiting")))));
  paint();
  clearInterval(tgPoll);
  const started = Date.now();
  tgPoll = setInterval(async () => {
    if (S.open !== "telegram" || Date.now() - started > 10 * 60_000) return clearInterval(tgPoll);
    const now = await read("/panel/api/telegram");
    if (now?.state === "paired") {
      clearInterval(tgPoll);
      S.data.telegram = now;
      S.states = cardStates({ ...S.data });
      go("telegram", 3);
    }
  }, 2500);
}

// ----- WhatsApp: the guided setup the server leads (GET/POST /panel/api/whatsapp/setup), drawn step by step -----

VIEWS.whatsapp = (w) => {
  const wa = S.data.whatsapp;
  const steps = Array.isArray(wa?.steps) ? wa.steps.filter((s) => s && typeof s === "object").slice(0, 10) : [];
  // The computer's own five-step guide (src/panel/whatsapp.js, on the panel's main page): this card says what it is and leads there.
  if (wa && !steps.length && typeof wa.step === "string") {
    return step({ title: t("wa.s1"), text: t(wa.step === "done" ? "wa.guideDone" : "wa.guide"),
      art: mini({ kind: "phone", title: "WhatsApp", rows: [{ text: t("mini.waHello"), bubble: true }, { text: t("mini.waAnswer"), me: true, bubble: true }] }),
      children: [h("div", { class: "wa-mount", "data-mount": "whatsapp" })] });
  }
  if (!wa || !steps.length) {
    return step({ title: t("wa.s1"), text: t("wa.lead"), art: mini({ kind: "phone", title: "WhatsApp", rows: [{ text: t("mini.waHello"), bubble: true }] }),
      children: [problem(t("wa.unavailable"), t("wa.unavailableFix"))] });
  }
  const firstOpen = steps.findIndex((s) => !s.done);
  if (typeof wa.current === "string") {
    const i = steps.findIndex((s) => s.id === wa.current);
    if (i >= 0 && w.step < i) w.step = i;
  } else if (w.step === 0 && firstOpen > 0) w.step = firstOpen;
  const s = steps[Math.min(w.step, steps.length - 1)];
  const str = (v, n = 400) => (typeof v === "string" ? v.slice(0, n) : "");
  const fields = (Array.isArray(s.fields) ? s.fields : []).filter((f) => f && typeof f.name === "string" && /^[A-Za-z0-9_]{1,60}$/.test(f.name)).slice(0, 6)
    .map((f) => field({ id: `f-wa-${f.name}`, label: str(f.label, 80) || f.name, hint: str(f.hint, 200), secret: f.secret === true }));
  const out = h("div", { "aria-live": "polite" });
  const linkOk = typeof s.link?.url === "string" && /^https:\/\//.test(s.link.url);
  const doIt = async (e) => {
    for (const f of fields) if (!f.check()) return f.input.focus();
    e.currentTarget.disabled = true;
    fill(out, testing());
    const values = Object.fromEntries(fields.map((f) => [f.input.id.slice(5), f.input.value.trim()]));
    const r = await api("/panel/api/whatsapp/setup", { method: "POST", body: { step: s.id, values } });
    e.currentTarget.disabled = false;
    if (!r.ok || r.data.ok === false) return fill(out, problem(str(r.data.error) || t("err.save"), str(r.data.fix)));
    await loadAll();
    const again = Array.isArray(S.data.whatsapp?.steps) ? S.data.whatsapp.steps.findIndex((x) => !x.done) : -1;
    go("whatsapp", again < 0 ? steps.length - 1 : again);
  };
  const last = w.step >= steps.length - 1 && steps.every((x) => x.done);
  return step({
    title: str(s.title, 120) || t("wa.s1"), text: str(s.text, 600),
    art: mini({ kind: "phone", title: "WhatsApp", rows: [{ text: t("mini.waHello"), bubble: true }, { text: t("mini.waAnswer"), me: true, bubble: true }] }),
    children: [
      typeof s.copy === "string" && s.copy ? codeLine(s.copy.slice(0, 300)) : null,
      linkOk ? actions(outLink(s.link.url, str(s.link.label, 60) || t("open"), "btn ghost")) : null,
      fields, out,
      last ? success(t("wa.done"), t("wa.doneLine")) : null,
      actions(w.step > 0 ? btn(t("back"), () => go("whatsapp", w.step - 1), "ghost") : null,
        s.done && w.step < steps.length - 1 ? btn(t("next"), () => go("whatsapp", w.step + 1)) : null,
        !s.done ? btn(str(s.action?.label, 60) || (fields.length ? t("saveTest") : t("done")), doIt) : null),
    ],
  });
};

// ----- Slack and Zoom: the person's own app, then one Allow (src/connect-setup.ts) -----

/**
 * Connect with the person's own app. Pako opens the service's Allow page; the browser comes back to Pako, which keeps the token itself.
 * Meanwhile the account route is asked until it says how it went. A success restarts Pako, which is waited for, so the card then shows
 * what the running reader says. True when connected.
 */
async function oauthConnect(id, clientId, out, button) {
  const service = id === "slack" ? "Slack" : "Zoom";
  return (await waitForAllow({ start: `/panel/api/${id}/connect`, body: { clientId }, account: `/panel/api/${id}/account`, service }, out, button)) !== null;
}

/**
 * The shared part of every "sign in on the service's own page" (Slack, Zoom, Microsoft and Google mail): start, open the page, ask the
 * account route until the browser came back, then wait for Pako's restart. The account it says, or null.
 */
async function waitForAllow({ start: startPath, body, account, service }, out, button) {
  button.disabled = true;
  fill(out, testing());
  const r = await api(startPath, { method: "POST", body });
  if (!r.ok || r.data.ok !== true || typeof r.data.authorizeUrl !== "string") {
    button.disabled = false;
    fill(out, problem(typeof r.data.error === "string" && r.data.error ? r.data.error.slice(0, 400) : t(r.status ? "err.save" : "err.offline")));
    return null;
  }
  const url = r.data.authorizeUrl;
  // Opened at once where the browser allows it (the Mac app sends it to the default browser); the link is there when it does not.
  try {
    const w = window.open(url, "_blank");
    if (w) w.opener = null;
  } catch {
    /* the link below */
  }
  fill(out, testing(t("oauth.waiting", { service })), h("p", { class: "aside" }, outLink(url, t("oauth.reopen", { service }), "btn ghost")));
  const start = Date.now();
  while (Date.now() - start < 10 * 60_000) {
    await sleep(1500);
    // The wizard was closed, or another step drawn: nobody is looking at this one any more.
    if (!document.body.contains(out)) return null;
    const a = await api(account);
    if (!a.ok || a.data.state === "waiting") continue;
    if (a.data.state === "failed") {
      button.disabled = false;
      fill(out, problem(String(a.data.error ?? "").slice(0, 400) || t("oauth.timeout")));
      return null;
    }
    if (a.data.state === "connected") {
      fill(out, testing(t("oauth.restarting")));
      await waitForRestart();
      await loadAll();
      return a.data.account && typeof a.data.account === "object" ? a.data.account : {};
    }
  }
  button.disabled = false;
  fill(out, problem(t("oauth.timeout")));
  return null;
}

/** The done step's "Connected as …", from the running reader (filled in when it answers). */
function connectedAs(id) {
  const line = h("p", { class: "aside" });
  void read(`/panel/api/${id}/account`).then((a) => {
    const who = a?.state === "connected" ? accountLine(a.account) : "";
    if (who) fill(line, icon("circle-check"), t("oauth.connectedAs", { who }));
  });
  return line;
}

/** The one-button connection with the project's own app: the button, the waiting, and the way to use one's own app instead. */
function oneButton(id, { title, text, art, note }) {
  const out = h("div", { "aria-live": "polite" });
  const service = id === "slack" ? "Slack" : "Zoom";
  return step({
    title, text, art,
    children: [
      out,
      actions(btn(t(`${id}.connectOne`), async (e) => {
        if (await waitForAllow({ start: `/panel/api/${id}/connect`, body: {}, account: `/panel/api/${id}/account`, service }, out, e.currentTarget)) {
          go(id, id === "slack" ? 2 : 3, id === "zoom" ? { path: "cloud" } : {});
        }
      })),
      note ? h("p", { class: "aside" }, icon("info"), note) : null,
      h("details", { class: "advanced" }, h("summary", {}, t("connect.ownApp")),
        h("p", {}, t("connect.ownAppLine", { service })),
        actions(btn(t("connect.ownAppStart"), () => go(id, id === "slack" ? 0 : 1, { path: id === "slack" ? "own" : "cloudOwn" }), "ghost"))),
    ],
  });
}

VIEWS.slack = (w) => {
  // The project's own Slack app: one button. The person's own app (the steps below) under Advanced, or when this Pako has none.
  if (w.step === 0 && S.data.clients?.slack && w.path !== "own") {
    return oneButton("slack", {
      title: t("slack.s1one"), text: t("slack.leadOne"),
      art: mini({ title: "slack.com", rows: [t("mini.slackPick"), { text: "Allow", hot: true }, { text: "Pako · read only", dim: true }], tint: "plum" }),
      note: t("slack.adminNote"),
    });
  }
  if (w.step === 0) {
    // Slack's Create link is written by the server: it carries this Pako's own address for the way back.
    const create = outLink("https://api.slack.com/apps", t("slack.create"));
    void read("/panel/api/slack/setup").then((d) => {
      if (typeof d?.createUrl === "string" && d.createUrl.startsWith("https://api.slack.com/apps?")) create.href = d.createUrl;
    });
    return step({
      title: t("slack.s1"), text: t("slack.lead2"),
      art: mini({ title: "api.slack.com", rows: [t("mini.slackPick"), { text: t("mini.slackCreate"), hot: true }, { text: "Pako · read only", dim: true }], tint: "plum" }),
      children: [
        h("ol", { class: "how" }, [1, 2, 3].map((n) => h("li", {}, t(`slack.how${n}`)))),
        actions(create, btn(t("slack.made"), () => go("slack", 1), "ghost")),
        h("p", { class: "aside" }, icon("shield-check"), t("slack.readOnly")),
      ],
    });
  }
  if (w.step === 1) {
    const id = field({ id: "f-slack-client", label: t("slack.clientId"), hint: t("slack.clientHint"), kind: "slackClientId", placeholder: "1234567890.9876543210" });
    const out = h("div", { "aria-live": "polite" });
    return step({
      title: t("slack.sConnect"), text: t("slack.clientText"),
      art: mini({ title: "Basic Information", rows: ["App Credentials", { text: "Client ID  1234567890.98…", mono: true, hot: true }, { text: "Allow", dim: true }], tint: "plum" }),
      children: [id, h("p", { class: "aside" }, t("slack.allowLine")), out, actions(btn(t("back"), () => go("slack", 0), "ghost"), btn(t("slack.connect"), async (e) => {
        if (!id.check()) return id.input.focus();
        if (await oauthConnect("slack", id.input.value.trim(), out, e.currentTarget)) go("slack", 2);
      }))],
    });
  }
  return step({ title: t("slack.sDone"), children: [success(t("slack.done"), t("slack.doneLine2")), connectedAs("slack")] });
};

// ----- Microsoft Teams: one button with the Microsoft sign-in, what is granted, and the admin's request (src/teams-connect.ts) -----

/** The admin's request: what each permission adds, the approval link, and a copy button. */
function teamsAdmin(st) {
  if (!st?.adminText) return null;
  return h("section", { class: "details", "aria-label": t("teams.adminTitle") },
    h("p", { class: "step-text" }, h("strong", {}, t("teams.adminTitle")), " ", t("teams.adminLead")),
    h("p", { class: "muted small" }, t("teams.adminWhat")),
    h("pre", { class: "code-block", style: { whiteSpace: "pre-wrap", maxHeight: "12rem", overflow: "auto" } }, st.adminText),
    actions(copyButton(st.adminText, t("teams.copyRequest"))));
}

VIEWS.teams = () => {
  const out = h("div", { "aria-live": "polite" });
  const body = h("div", {}, testing());
  void read("/panel/api/teams/status").then((st) => {
    if (!st || typeof st !== "object") return fill(body, problem(t("err.offline")));
    const connect = (more) => btn(t(more ? "teams.more" : "teams.connect"), async (e) => {
      const a = await waitForAllow({ start: "/panel/api/teams/connect", body: more ? { more: true } : {}, account: "/panel/api/teams/account", service: "Microsoft" }, out, e.currentTarget);
      if (a) drawCard("teams");
      // Refused for want of an admin: the request to send them, at once.
      else void read("/panel/api/teams/status").then((s2) => s2?.adminNeeded && out.append(teamsAdmin(s2) ?? ""));
    }, more ? "ghost" : "primary");
    if (!st.available && !st.connected) return fill(body, step({ title: t("teams.s1"), text: t("teams.noClient") }));
    if (!st.connected) {
      return fill(body, step({
        title: t("teams.s1"), text: t("teams.lead"),
        art: mini({ title: "login.microsoftonline.com", rows: [t("teams.chats"), { text: "Accept", hot: true }, { text: "Pako · read only", dim: true }], tint: "violet" }),
        children: [
          st.incremental ? h("p", { class: "aside" }, icon("info"), t("teams.leadMore")) : null,
          out, actions(connect(false)),
          h("p", { class: "aside" }, icon("shield-check"), t("teams.personal")),
          st.adminNeeded ? teamsAdmin(st) : null,
        ],
      }));
    }
    const g = st.granted ?? {};
    const mark = (on, off = t("teams.needsAdmin")) => (on ? t("teams.yes") : off);
    fill(body, 
      rows(
        row(t("d.account"), [st.name, st.account && `(${st.account})`].filter(Boolean).join(" ")),
        row(t("teams.org"), st.org),
        row(t("teams.chats"), mark(g.chats)),
        row(t("teams.calendar"), mark(g.calendar)),
        row(t("teams.mentions"), mark(g.mentions)),
        row(t("teams.transcripts"), st.transcriptsOff ? t("teams.off") : mark(g.transcripts)),
        row(t("teams.lastRead"), ago(st.lastRead)),
        row(t("d.lastError"), st.lastError ?? t("d.none"))),
      st.throttledUntil ? h("p", { class: "muted small" }, t("teams.throttled")) : null,
      out,
      actions(!g.mentions || !g.transcripts ? connect(true) : null, btn(t("d.disconnect"), () => disconnect("teams", t("teams.name")), "tiny ghost")),
      !g.mentions || !g.transcripts || !g.chats ? teamsAdmin(st) : null);
  });
  return step({ title: t("teams.name"), children: [body] });
};

// ----- Messages and Mail on this Mac: one switch, macOS's Full Disk Access said plainly, and how it is doing (src/imessage.ts, src/apple-mail.ts) -----

/** The two sources read from this Mac's own files: their card id, their route and the setting their switch saves. */
const MAC_SOURCES = {
  imessage: { api: "/panel/api/imessage", key: "IMESSAGE" },
  applemail: { api: "/panel/api/apple-mail", key: "APPLE_MAIL" },
};

for (const id of Object.keys(MAC_SOURCES)) {
  VIEWS[id] = () => {
    const body = h("div", { "aria-live": "polite" }, testing(t(`${id}.looking`)));
    void read(MAC_SOURCES[id].api).then((st) => macSourceView(id, body, st));
    return step({ title: t(`${id}.s1`), children: [body] });
  };
}

/** A card's body from its GET route: Mac only, off, waiting for Full Disk Access, or reading. */
function macSourceView(id, body, st) {
  const src = MAC_SOURCES[id];
  if (!st) return fill(body, h("p", { class: "step-text" }, t(`${id}.older`)));
  if (!st.mac) return fill(body, h("p", { class: "step-text" }, t(`${id}.macOnly`)));
  const out = h("div", { "aria-live": "polite" });
  const checkAgain = (label = t(`${id}.check`)) => btn(label, async (e) => {
    e.currentTarget.disabled = true;
    fill(out, testing());
    const r = await api(`${src.api}/check`, { method: "POST", body: {} });
    if (!r.ok) {
      e.currentTarget.disabled = false;
      return fill(out, problem(t(r.status ? "err.save" : "err.offline")));
    }
    await loadAll();
    macSourceView(id, body, r.data);
    drawCard(id);
  }, "tiny ghost");
  const off = btn(t(`${id}.turnOff`), () => void disconnect(id, t(`${id}.name`)), "tiny ghost");
  // Mail read by IMAP too: the same email is taken once, said so the owner is not left wondering.
  const both = st.imap === true ? h("p", { class: "aside" }, icon("info"), t(`${id}.withImap`)) : null;
  if (!st.on) {
    return fill(body, 
      h("p", { class: "step-text" }, t(`${id}.lead`)),
      h("p", { class: "aside" }, icon("shield-check"), t(`${id}.private`)),
      h("p", { class: "aside" }, icon("lock"), t(`${id}.fdaFirst`)),
      both,
      out,
      actions(btn(t(`${id}.turnOn`), async (e) => {
        e.currentTarget.disabled = true;
        fill(out, testing(t("restarting")));
        const r = await saveConnection(id, { [src.key]: "on" });
        if (!r.ok) {
          e.currentTarget.disabled = false;
          return fill(out, problem(r.error));
        }
        drawCard(id);
      })));
  }
  if (st.access === "denied") {
    // The app opens the pane itself (desktop/mac/DiscoveryCore.swift allows it); a browser follows the link, and macOS asks first.
    const pane = typeof st.pane === "string" ? st.pane : "";
    const open = S.app
      ? btn(t(`${id}.openPane`), () => tellApp(window, { type: "openURL", url: pane }), "tiny primary")
      : h("a", { class: "btn tiny primary", href: pane }, t(`${id}.openPane`));
    return fill(body, 
      h("div", { class: "denied" },
        h("p", {}, icon("lock"), h("span", {}, typeof st.problem === "string" && st.problem ? st.problem : t(`${id}.fda`))),
        h("ol", { class: "how" }, [1, 2, 3].map((n) => h("li", {}, t(`${id}.fda${n}`, { app: t(S.app ? `${id}.appMac` : `${id}.appTerminal`) })))),
        actions(open, checkAgain())),
      out, actions(off));
  }
  const lines = st.access === "missing" ? [h("p", { class: "step-text" }, t(`${id}.missing`))]
    : st.access === "unknown" ? [problem(typeof st.problem === "string" && st.problem ? st.problem : t(`${id}.unknown`))]
    : st.access === "ok" ? [success(t(`${id}.on`), t(`${id}.onLine`))]
    : [h("p", { class: "step-text" }, t(`${id}.soon`))];
  const problemLine = st.access === "ok" && typeof st.problem === "string" && st.problem ? problem(st.problem) : null;
  return fill(body, ...lines, problemLine, both,
    rows(row(t(`${id}.lastRead`), st.lastRead ? ago(st.lastRead) : t("d.never")), row(t(`${id}.since`), st.since ? ago(st.since) : "")),
    out, actions(checkAgain(st.access === "ok" ? t(`${id}.checkNow`) : t(`${id}.check`)), off));
}

// ----- Zoom: the recordings already on this Mac, or the guided Server-to-Server app -----

VIEWS.zoom = (w) => {
  const rec = S.data.discovery?.zoomRecordings;
  if (w.step === 0) {
    return step({
      title: t("zoom.s0"), text: t("zoom.lead"),
      art: mini({ title: "Zoom", rows: [{ text: t("mini.zoomMeeting") }, { text: t("mini.zoomSummary"), hot: true }, { text: t("mini.zoomTodo"), dim: true }], tint: "blue" }),
      children: [h("div", { class: "choices" },
        S.app && rec ? choice("folder-open", t("zoom.useLocal"), t("zoom.useLocalLine", { n: rec.count }), () => go("zoom", 1, { path: "local" })) : null,
        choice("cloud", t("zoom.cloud"), t("zoom.cloudLine2"), () => go("zoom", 1, { path: "cloud" })))],
    });
  }
  if (w.path === "local") {
    const out = h("div", { "aria-live": "polite" });
    return step({
      title: t("zoom.sLocal"), text: t("zoom.localText", { folder: rec?.folder ?? "" }),
      children: [out, actions(btn(t("back"), () => go("zoom", 0), "ghost"), btn(t("zoom.useLocalBtn"), async (e) => {
        e.currentTarget.disabled = true;
        fill(out, testing());
        const r = await askApp(window, { type: "use", what: "zoomRecordings" }, "pakoUsed", 30_000, (v) => v?.what === "zoomRecordings");
        e.currentTarget.disabled = false;
        fill(out, r?.ok ? success(t("zoom.localDone"), t("zoom.localDoneLine")) : problem(r ? t("zoom.localFailed") : t("app.noAnswer"), r ? "" : t("app.update")));
        paint();
      }))],
    });
  }
  if (w.step === 1 && S.data.clients?.zoom && w.path !== "cloudOwn") {
    return oneButton("zoom", {
      title: t("zoom.s1one"), text: t("zoom.leadOne"),
      art: mini({ title: "zoom.us", rows: [{ text: t("mini.zoomMeeting") }, { text: "Allow", hot: true }, { text: t("mini.zoomTodo"), dim: true }], tint: "blue" }),
      note: t("zoom.planNote"),
    });
  }
  if (w.step === 1) {
    const saved = h("div", { "aria-live": "polite" });
    return step({
      title: t("zoom.sMake"), text: t("zoom.makeText2"),
      art: mini({ title: "marketplace.zoom.us", rows: ["Develop", { text: "Build from an app manifest", hot: true }, { text: "Use Public Client OAuth", dim: true }], tint: "blue" }),
      children: [h("ol", { class: "how" }, [1, 2, 3].map((n) => h("li", {}, t(`zoom.mk${n}`)))),
        saved,
        actions(btn(t("zoom.saveFile"), async (e) => {
          // Saved by Pako itself into Downloads: the Mac app's window has no downloads of its own.
          e.currentTarget.disabled = true;
          const r = await api("/panel/api/zoom/manifest", { method: "POST" });
          e.currentTarget.disabled = false;
          fill(saved, r.ok && typeof r.data.path === "string"
            ? h("p", { class: "aside" }, icon("circle-check"), t("zoom.savedTo", { path: r.data.path.slice(0, 300) }))
            : problem(t("zoom.saveFailed")));
        }), h("a", { class: "btn ghost", href: "/panel/api/zoom/manifest", download: "pako-zoom-app.json" }, t("zoom.download"))),
        actions(outLink("https://marketplace.zoom.us/develop/create", t("zoom.open")), btn(t("zoom.made"), () => go("zoom", 2, { path: w.path === "cloudOwn" ? "cloudOwn" : "cloud" }), "ghost"))],
    });
  }
  if (w.step === 2) {
    const id = field({ id: "f-zoom-client", label: "Client ID", hint: t("zoom.fromApp"), kind: "zoomClientId" });
    const redirect = h("div");
    void read("/panel/api/zoom/setup").then((d) => {
      if (typeof d?.redirectUri === "string") fill(redirect, h("p", { class: "aside" }, t("zoom.redirectIf")), codeLine(d.redirectUri));
    });
    const out = h("div", { "aria-live": "polite" });
    return step({
      title: t("zoom.sConnect"), text: t("zoom.clientText"),
      art: mini({
        title: "App Credentials", tint: "blue",
        rows: [{ text: "Use Public Client OAuth  ●", hot: true }, { text: "Client ID  •••••", mono: true }, { text: "Allow", dim: true }],
      }),
      children: [id, h("p", { class: "aside" }, t("zoom.allowLine")), redirect, out, actions(btn(t("back"), () => go("zoom", 1, { path: w.path === "cloudOwn" ? "cloudOwn" : "cloud" }), "ghost"), btn(t("zoom.connect"), async (e) => {
        if (!id.check()) return id.input.focus();
        if (await oauthConnect("zoom", id.input.value.trim(), out, e.currentTarget)) go("zoom", 3, { path: w.path === "cloudOwn" ? "cloudOwn" : "cloud" });
      }))],
    });
  }
  return step({ title: t("zoom.sDone"), children: [success(t("zoom.done"), t("zoom.doneLine")), connectedAs("zoom")] });
};

// ----- Contacts: the count (after a look that had macOS's yes), one press, what Pako's import did -----

VIEWS.contacts = (w) => {
  const d = S.data.discovery;
  const known = importedCount(S.data.people);
  if (w.step === 1) {
    const added = Number.isInteger(w.added) ? t("contacts.added", { added: w.added, merged: Number.isInteger(w.merged) ? w.merged : 0 }) : "";
    return step({ title: t("contacts.sDone"), children: [success(t("contacts.done", { n: known }), `${added} ${t("contacts.doneLine")}`.trim())] });
  }
  const out = h("div", { "aria-live": "polite" });
  if (!S.app) {
    return step({ title: t("contacts.s1"), text: t("contacts.browser", { n: known }), children: [h("p", { class: "aside" }, icon("laptop"), t("contacts.appCanDo"))] });
  }
  const perm = d?.permissions.contacts;
  if (perm === "denied") return step({ title: t("contacts.s1"), text: t("contacts.lead"), children: [deniedBox(["contacts"])] });
  // A count of 0 is "not looked" (a look that skipped the contacts stores 0 too, whatever the permission says), unless this card's own look
  // just came back with it: then there really is none.
  const n = d?.contacts?.count ?? 0;
  if (perm !== "granted" || (!n && !contactsLooked)) {
    return step({ title: t("contacts.s1"), text: t("contacts.lead"), children: [out, actions(btn(t("contacts.look"), async () => {
      await discover(["contacts"]);
      contactsLooked = true;
      drawCard("contacts");
    }))] });
  }
  if (!n) {
    return step({ title: t("contacts.s1"), text: t("contacts.none"), children: [actions(btn(t("disc.lookAgain"), async () => {
      await discover(["contacts"]);
      drawCard("contacts");
    }, "ghost"))] });
  }
  return step({
    title: t("contacts.s1"), text: t("contacts.found", { n }),
    children: [
      h("p", { class: "aside" }, icon("shield-check"), t("contacts.private")), out,
      actions(btn(t("contacts.import", { n }), async (e) => {
        e.currentTarget.disabled = true;
        fill(out, testing(t("contacts.importing")));
        const r = await askApp(window, { type: "use", what: "contacts" }, "pakoUsed", 60_000, (v) => v?.what === "contacts");
        if (!r?.ok) {
          e.currentTarget.disabled = false;
          return fill(out, problem(r ? t("contacts.failed") : t("app.noAnswer"), r ? "" : t("app.update")));
        }
        await loadAll();
        // "Lo que Pako sabe" gets its "Olvidar contactos" and the chip goes, not only on the next load.
        drawKnown();
        drawDiscovery();
        // What Pako's import counted (two cards of one person are one), as the app passes it on; the app's own count is not it.
        const num = (v) => (Number.isInteger(v) && v >= 0 ? v : undefined);
        go("contacts", 1, { added: num(r.added), merged: num(r.merged) });
      })),
    ],
  });
};

// ----- Booking a table: one Google Places key -----

VIEWS.tables = (w) => {
  if (w.step === 0) {
    return step({
      title: t("tables.s1"), text: t("tables.lead"),
      art: mini({ title: "console.cloud.google.com", rows: ["Places API (New)", { text: t("mini.enable"), hot: true }, { text: t("mini.createCreds"), dim: true }] }),
      children: [h("ol", { class: "how" }, [1, 2, 3].map((n) => h("li", {}, t(`tables.how${n}`)))),
        h("p", { class: "aside" }, icon("coins"), t("tables.cost")),
        actions(outLink("https://console.cloud.google.com/apis/library/places.googleapis.com", t("tables.open")),
          btn(t("tables.have"), () => go("tables", 1), "ghost"))],
    });
  }
  if (w.step === 1) {
    const key = field({ id: "f-places", label: t("tables.key"), hint: t("tables.keyHint"), kind: "places", secret: true, placeholder: "AIza…" });
    const out = h("div", { "aria-live": "polite" });
    return step({
      title: t("tables.s2"), text: t("tables.pasteText"),
      children: [key, out, actions(btn(t("back"), () => go("tables", 0), "ghost"), btn(t("save"), async (e) => {
        if (!key.check()) return key.input.focus();
        e.currentTarget.disabled = true;
        fill(out, testing(t("restarting")));
        const r = await saveConnection("tables", { GOOGLE_PLACES_API_KEY: key.input.value.trim() });
        if (!r.ok) {
          e.currentTarget.disabled = false;
          fill(out);
          return key.error(r.error);
        }
        go("tables", 2);
      }))],
    });
  }
  return step({ title: t("tables.sDone"), children: [saved(t("tables.saved"), t("tables.savedLine")), h("p", { class: "step-text" }, t("tables.doneLine"))] });
};

// ----- Sending from the owner's own domain: Resend's key, the sender and an optional reply-to (src/resend.ts) -----

/**
 * The Check button: POST /panel/api/connections/resend/check with the typed key (or none: the one Pako has). Resend's GET /domains answers;
 * nothing is saved and nothing is sent. Shows the domains Resend knows for the key, or why it was refused.
 */
function resendCheck(out, key = "") {
  return btn(t("resend.check"), async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    fill(out, testing());
    const r = await api("/panel/api/connections/resend/check", { method: "POST", body: key ? { key: key() } : {} });
    b.disabled = false;
    if (!r.ok || r.data.ok !== true) return fill(out, problem(typeof r.data.error === "string" && r.data.error ? r.data.error.slice(0, 300) : t(r.status ? "err.save" : "err.offline")));
    const domains = Array.isArray(r.data.domains) ? r.data.domains.filter((x) => typeof x === "string").slice(0, 20) : [];
    fill(out, saved(t("resend.works"), domains.length ? t("resend.domains", { list: domains.join(", ") }) : t("resend.sendOnly")));
  }, "ghost");
}

VIEWS.resend = (w) => {
  if (w.step === 0) {
    return step({
      title: t("resend.s1"), text: t("resend.lead"),
      art: mini({ title: "resend.com", rows: ["Domains", { text: t("mini.apiKeys"), hot: true }, { text: "Emails", dim: true }] }),
      children: [h("ol", { class: "how" }, [1, 2, 3].map((n) => h("li", {}, t(`resend.how${n}`)))),
        h("p", { class: "aside" }, icon("info"), t("resend.inbound")),
        actions(outLink("https://resend.com/domains", t("resend.open")), btn(t("resend.have"), () => go("resend", 1), "ghost"))],
    });
  }
  if (w.step === 1) {
    const key = field({ id: "f-resend-key", label: t("resend.key"), hint: t("resend.keyHint"), kind: "resendKey", secret: true, placeholder: "re_…" });
    const from = field({ id: "f-resend-from", label: t("resend.from"), hint: t("resend.fromHint"), placeholder: "Pako <hello@example.com>" });
    const reply = field({ id: "f-resend-reply", label: t("resend.replyTo"), hint: t("resend.replyToHint"), type: "email" });
    const out = h("div", { "aria-live": "polite" });
    return step({
      title: t("resend.s2"), text: t("resend.pasteText"),
      children: [key, from, reply, out, actions(btn(t("back"), () => go("resend", 0), "ghost"), resendCheck(out, () => key.input.value.trim()),
        btn(t("save"), async (e) => {
          if (!key.check()) return key.input.focus();
          if (!from.input.value.trim()) return from.error(t("resend.fromHint"));
          e.currentTarget.disabled = true;
          fill(out, testing(t("restarting")));
          const values = { RESEND_API_KEY: key.input.value.trim(), RESEND_FROM: from.input.value.trim() };
          if (reply.input.value.trim()) values.RESEND_REPLY_TO = reply.input.value.trim();
          const r = await saveConnection("resend", values);
          if (!r.ok) {
            e.currentTarget.disabled = false;
            fill(out);
            return (r.field === "RESEND_FROM" ? from : r.field === "RESEND_REPLY_TO" ? reply : key).error(r.error);
          }
          go("resend", 2);
        }))],
    });
  }
  const out = h("div", { "aria-live": "polite" });
  return step({ title: t("resend.sDone"), children: [saved(t("resend.saved"), t("resend.savedLine")), out,
    actions(resendCheck(out), btn(t("resend.change"), () => go("resend", 1), "ghost"))] });
};

// ----- Every setting, as the server lists them (the fine-tuning the wizards leave out: quiet hours, VIP senders, folders…) -----

VIEWS.more = (w) => {
  const list = (S.data.connections?.connections ?? []).filter((c) => !c.card && Array.isArray(c.fields) && c.fields.length);
  const pick = list.find((c) => c.id === w.path) ?? list[0];
  if (!pick) return step({ title: t("more.title"), text: t("err.noConnections") });
  const out = h("div", { "aria-live": "polite" });
  const inputs = pick.fields.map((f) => {
    const outside = f.from === "outside";
    const placeholder = outside ? "" : f.set ? (f.tail ? t("more.setTail", { tail: f.tail }) : t("more.set")) : f.hint;
    const wrap = field({ id: `m-${f.key}`, label: `${f.label}${f.optional ? ` (${t("more.optional")})` : ""}`, hint: outside ? t("more.outside") : f.set ? f.hint : "",
      secret: true, placeholder });
    wrap.input.name = f.key;
    wrap.input.disabled = outside || !S.data.connections.readable;
    return wrap;
  });
  return step({
    title: t("more.title"), text: t("more.lead"),
    children: [
      h("div", { class: "tabs", role: "group", "aria-label": t("more.which") }, list.map((c) => h("button", {
        type: "button", class: `tab${c.id === pick.id ? " on" : ""}`, "aria-pressed": c.id === pick.id ? "true" : "false",
        onclick: () => go("more", 0, { path: c.id }),
      }, c.name))),
      typeof pick.how === "string" ? h("p", { class: "step-text" }, pick.how) : null,
      typeof pick.problem === "string" && pick.problem ? problem(pick.problem) : null,
      inputs, out,
      actions(
        btn(t("more.save"), async (e) => {
          const values = {};
          for (const f of inputs) if (!f.input.disabled && f.input.value.trim()) values[f.input.name] = f.input.value.trim();
          if (!Object.keys(values).length) return fill(out, problem(t("more.nothing")));
          e.currentTarget.disabled = true;
          fill(out, testing(t("restarting")));
          const r = await saveConnection(pick.id, values);
          e.currentTarget.disabled = false;
          if (!r.ok) {
            fill(out);
            const bad = inputs.find((f) => f.input.name === r.field);
            return bad ? bad.error(r.error) : fill(out, problem(r.error));
          }
          go("more", 0, { path: pick.id });
          announce(t("more.saved"));
        }),
        pick.fields.some((f) => f.from === "panel") ? btn(t("more.remove"), async (e) => {
          if (!confirm(t("more.removeConfirm", { name: pick.name }))) return;
          e.currentTarget.disabled = true;
          fill(out, testing(t("restarting")));
          const r = await api("/panel/api/connections/remove", { method: "POST", body: { id: pick.id } });
          if (!r.ok || !r.data.ok) {
            e.currentTarget.disabled = false;
            return fill(out, problem(r.data.error || t("err.save")));
          }
          if (r.data.restarting) await waitForRestart();
          await loadAll();
          go("more", 0, { path: pick.id });
          announce(t("more.removed"));
        }, "danger") : null),
      S.data.connections?.readable === false ? problem(t("more.unreadable")) : null,
    ],
  });
};

VIEWS.phone = () => step({ title: t("phone.title"), text: t("phone.text"), children: [h("p", { class: "aside" }, icon("book-open"), t("phone.where"))] });

// ---------- the top: the ring and the one suggestion ----------

function drawHero() {
  const n = connectedCount(S.states);
  const total = COUNTED.length;
  const ring = $("#ring-fill");
  if (ring) ring.style.strokeDashoffset = String(100 - (100 * n) / total);
  $("#ring-n").textContent = String(n);
  $("#ring-of").textContent = t("ringOf", { total });
  $("#ring").setAttribute("aria-label", t("ringAria", { n, total }));
  const next = nextSuggestion(S.states);
  const box = $("#next");
  fill(box, ...(next
    ? [h("span", { class: "next-kicker" }, t("nextKicker")), h("span", { class: "next-what" }, t(`next.${next}`)),
      h("button", { type: "button", class: "btn primary", onclick: () => openCard(next) }, t(S.states[next] === "off" ? "start" : "continue"), icon("arrow-right"))]
    : [h("span", { class: "next-what" }, t("allDone"))]));
  paint();
}

function openCard(id) {
  S.open = id;
  remember();
  for (const other of Object.keys(CARD)) drawCard(other);
  drawCard(id, { focusStep: true });
  $(`#slot-${id}`)?.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "start" });
}

// ---------- "May I look at what you have on this Mac?" ----------

/**
 * Asks the app to look (only after a press on this page); the answer is cleaned, kept on the page, and every card redrawn. `openMail`: the
 * press was on a button that says it opens Mail (without it the app leaves a closed Mail alone and finds no account).
 */
async function discover(what = ["apps", "calendars", "mail", "contacts", "zoomRecordings"], { openMail = false } = {}) {
  if (!S.app || S.discovering) return null;
  S.discovering = true;
  drawDiscovery();
  const raw = await askApp(window, { type: "discover", what, ...(openMail ? { openMail: true } : {}) }, "pakoDiscovered", 120_000);
  S.discovering = false;
  if (raw) {
    // The app posted it to the server too; a fresh read keeps the page and the server in step (the page's own copy when that fails).
    const kept = cleanDiscovery(await read("/panel/api/discovery"));
    S.data.discovery = kept ?? cleanDiscovery(raw);
    S.states = cardStates({ ...S.data });
  }
  drawDiscovery(raw ? "done" : "noAnswer");
  drawKnown();
  for (const id of Object.keys(CARD)) if (id !== S.open) drawCard(id);
  return S.data.discovery;
}

/** macOS's own privacy pane for each permission (the app opens only these: desktop/mac/DiscoveryCore.swift allowedOpenURL). */
const PRIVACY_PANE = { calendars: "Privacy_Calendars", contacts: "Privacy_Contacts", mail: "Privacy_Automation" };
const LOOK_FOR = { calendars: "calendars", contacts: "contacts", mail: "mail" };

/** A refused permission is not a dead end: a button to its pane in System Settings, and one to look again once it is on. */
function deniedBox(kinds) {
  const list = kinds.filter((k) => Object.hasOwn(PRIVACY_PANE, k));
  return h("div", { class: "denied" },
    h("p", {}, icon("lock"), h("span", {}, t("disc.denied", { what: list.map((k) => t(`perm.${k}`)).join(", ") }))),
    actions(
      list.map((k) => btn(t("perm.open", { what: t(`perm.${k}`) }), () => {
        tellApp(window, { type: "openURL", url: `x-apple.systempreferences:com.apple.preference.security?${PRIVACY_PANE[k]}` });
      }, "tiny primary")),
      btn(t("disc.lookAgain"), async () => {
        await discover(list.map((k) => LOOK_FOR[k]), { openMail: list.includes("mail") });
        if (list.includes("contacts")) contactsLooked = true;
        if (list.includes("mail")) mailLooked = true;
        for (const id of Object.keys(CARD)) drawCard(id);
      }, "tiny ghost")));
}

function drawDiscovery(outcome = "") {
  const box = $("#discover");
  const d = S.data.discovery;
  if (!S.app) {
    fill(box, h("div", { class: "disc-browser" }, icon("laptop"), h("div", {}, h("p", { class: "disc-title" }, t("disc.browserTitle")),
      h("p", {}, t("disc.browserText")))));
    return paint();
  }
  if (S.discovering) {
    fill(box, h("div", { class: "disc looking", role: "status" }, h("div", { class: "radar", "aria-hidden": "true" }, h("i"), h("i"), h("i")),
      h("div", {}, h("p", { class: "disc-title" }, t("disc.looking")), h("p", {}, t("disc.lookingLine")))));
    return paint();
  }
  if (d) {
    const chips = discoveryChips(d, t).filter((c) => !S.hidden?.has(c.card));
    const denied = Object.entries(d.permissions).filter(([, v]) => v === "denied").map(([k]) => k);
    // Mail closed at the look (its permission never asked, no account): said, with the button that may open it.
    const mailClosed = d.mailState ? d.mailState === "closed" : !d.mailAccounts.length && d.permissions.mail === "notAsked";
    fill(box, h("div", { class: "disc found" },
      h("div", { class: "disc-head" }, h("p", { class: "disc-title" }, chips.length ? t("disc.found") : t("disc.nothing")),
        h("button", { type: "button", class: "btn tiny ghost", onclick: () => void discover() }, icon("refresh-cw"), t("disc.again"))),
      h("ul", { class: "chips" }, chips.map((c, i) => h("li", { class: "chip", style: { "--i": String(i) } },
        h("span", { class: "chip-icon" }, icon(c.icon)), h("span", { class: "chip-text" }, c.text),
        S.states[c.card] === "on" && !c.use.address ? h("span", { class: "chip-on" }, icon("check"), t("state.on"))
          : h("button", { type: "button", class: "btn tiny primary", onclick: () => useChip(c) }, t("useThis"))))),
      mailClosed ? h("div", { class: "disc-mail" }, h("p", { class: "aside" }, icon("mail"), t("disc.mailClosed")),
        btn(t("disc.mailLook"), () => void discover(["mail"], { openMail: true }), "tiny ghost")) : null,
      denied.length ? deniedBox(denied) : null,
      outcome === "noAnswer" ? problem(t("app.noAnswer"), t("app.update")) : null));
    return paint();
  }
  if (S.declined) {
    fill(box, h("div", { class: "disc small" }, h("p", {}, t("disc.later")),
      btn(t("disc.lookNow"), () => {
        S.declined = false;
        remember();
        void discover();
      }, "tiny ghost")));
    return paint();
  }
  fill(box, h("div", { class: "disc ask" },
    h("div", { class: "disc-art", "aria-hidden": "true" }, h("span", { class: "mac" }), h("span", { class: "glass" })),
    h("div", { class: "disc-words" },
      h("h2", { class: "disc-title", id: "disc-title" }, t("disc.ask")),
      h("p", {}, t("disc.what")),
      h("ul", { class: "disc-promise" }, [1, 2, 3].map((n) => h("li", {}, icon("check"), t(`disc.promise${n}`)))),
      outcome === "noAnswer" ? problem(t("app.noAnswer"), t("app.update")) : null,
      actions(btn(t("disc.yes"), () => void discover()), btn(t("disc.no"), () => {
        S.declined = true;
        remember();
        drawDiscovery();
      }, "ghost")))));
  paint();
}

function useChip(c) {
  if (c.use.address) {
    S.wiz.mail = { step: 1, path: "imap", address: c.use.address, provider: providerOf(c.use.address) };
    remember();
  } else if (c.card === "calendar") {
    S.wiz.calendar = { step: 1, path: "mac" };
  } else if (c.card === "zoom" && S.data.discovery?.zoomRecordings) {
    S.wiz.zoom = { step: 1, path: "local" };
  }
  openCard(c.card);
}

// ---------- "What Pako knows about this Mac" ----------

/** Pako stops reading this Mac's calendars: the app stops its feed (ids: []) and the server forgets the events it had. */
async function stopCalendars() {
  if (S.app) await askApp(window, { type: "use", what: "calendars", ids: [] }, "pakoUsed", 15_000, (v) => v?.what === "calendars");
  const r = await api("/panel/api/calendar/local", { method: "POST", body: { calendars: [], events: [] } });
  return r.ok;
}

/** Everything Pako keeps from this Mac: what the look found, the calendars it reads, the contacts imported; each with its own forget. */
function drawKnown() {
  const box = $("#known");
  const d = S.data.discovery;
  const cals = (Array.isArray(S.data.localCalendar?.calendars) ? S.data.localCalendar.calendars : [])
    .map((c) => (typeof c === "string" ? c : typeof c?.title === "string" ? c.title : "")).filter(Boolean);
  const people = importedCount(S.data.people);
  if (!d && !cals.length && !people) {
    fill(box, h("p", { class: "aside" }, icon("shield-check"), t("known.none")));
    return paint();
  }
  const redraw = () => {
    S.states = cardStates({ ...S.data });
    drawKnown();
    drawDiscovery();
    for (const id of Object.keys(CARD)) drawCard(id);
  };
  const rows = [];
  if (d) {
    const appsFound = Object.entries(d.apps).filter(([, v]) => v).map(([k]) => t(`app.${k}`));
    if (appsFound.length) rows.push([t("known.apps"), appsFound.join(", ")]);
    if (d.calendars.length) rows.push([t("known.calendars"), d.calendars.map((c) => c.title).join(", ")]);
    if (d.mailAccounts.length) rows.push([t("known.mail"), d.mailAccounts.map((a) => a.address).join(", ")]);
    if (d.contacts && d.permissions.contacts === "granted") rows.push([t("known.contacts"), t("known.contactsN", { n: d.contacts.count })]);
    if (d.zoomRecordings) rows.push([t("known.zoom"), t("known.zoomN", { n: d.zoomRecordings.count, folder: d.zoomRecordings.folder })]);
  }
  if (cals.length) {
    const n = Number.isInteger(S.data.localCalendar?.events) ? S.data.localCalendar.events : 0;
    rows.push([t("known.macCalendars"), t("known.macCalendarsN", { names: cals.join(", "), n }), btn(t("known.stopCalendars"), async (e) => {
      e.currentTarget.disabled = true;
      if (!(await stopCalendars())) {
        e.currentTarget.disabled = false;
        return announce(t("err.save"));
      }
      await loadAll();
      announce(t("known.stoppedCalendars"));
      redraw();
    }, "tiny ghost")]);
  }
  if (people) {
    rows.push([t("known.imported"), t("known.importedN", { n: people }), btn(t("known.forgetContacts"), async (e) => {
      if (!confirm(t("known.forgetContactsConfirm", { n: people }))) return;
      e.currentTarget.disabled = true;
      const r = await api("/panel/api/people/imported", { method: "DELETE" });
      if (!r.ok) {
        e.currentTarget.disabled = false;
        return announce(t("err.save"));
      }
      await loadAll();
      announce(t("known.forgotContacts"));
      redraw();
    }, "tiny ghost")]);
  }
  const when = d?.at ? new Date(d.at) : null;
  fill(box, 
    h("dl", { class: "known-list" }, rows.map(([k, v, act]) => [h("dt", {}, k), h("dd", {}, h("span", {}, v), act ?? null)])),
    h("p", { class: "aside" }, icon("hard-drive"), t("known.where"), when && !Number.isNaN(when.getTime())
      ? ` ${t("known.when", { when: when.toLocaleString(localeOf(), { dateStyle: "medium", timeStyle: "short" }) })}` : ""),
    actions(btn(t("known.forget"), async (e) => {
      if (!confirm(t("known.forgetConfirm"))) return;
      e.currentTarget.disabled = true;
      // The app stops pushing first (or it would bring the events back within ten minutes); then the look, the events and the contacts go.
      if (S.app) await askApp(window, { type: "use", what: "calendars", ids: [] }, "pakoUsed", 15_000, (v) => v?.what === "calendars");
      const r = await api("/panel/api/discovery?all=1", { method: "DELETE" });
      if (!r.ok) {
        e.currentTarget.disabled = false;
        return announce(t("err.save"));
      }
      mailLooked = false;
      contactsLooked = false;
      await loadAll();
      announce(t("known.forgotten"));
      redraw();
    }, "danger")));
  paint();
}

// ---------- what each connection is: its account, its settings, its actions (never a secret) ----------

/** Everything on the page drawn again from what was just read. */
function redrawAll() {
  drawDiscovery();
  drawCards();
  drawKnown();
  drawHero();
}

/** "3 min ago", from a time in ms; "not yet" for none. */
function ago(at) {
  if (!Number.isFinite(at) || !at) return t("d.never");
  const m = Math.max(0, Math.round((Date.now() - at) / 60_000));
  return m < 1 ? t("ago.now") : m < 60 ? t("ago.min", { n: m }) : m < 48 * 60 ? t("ago.h", { n: Math.round(m / 60) }) : t("ago.d", { n: Math.round(m / 1440) });
}
const row = (label, value) => (value === null || value === undefined || value === "" ? null
  : h("div", { class: "d-row" }, h("dt", {}, label), h("dd", {}, String(value))));
const rows = (...r) => h("dl", { class: "d-rows" }, r.filter(Boolean));

/** Disconnects one connection (the panel's own remove), after a yes; waits for Pako's restart and reads everything again. */
async function disconnect(id, name) {
  if (!window.confirm(t("d.disconnectConfirm", { name }))) return;
  const r = await api("/panel/api/connections/remove", { method: "POST", body: { id } });
  if (!r.ok || !r.data.ok) return announce(r.data.error || t("err.save"));
  if (r.data.restarting) await waitForRestart();
  await loadAll();
  redrawAll();
}

/** A calendar link added: read once first; kept when it works, or when the owner says to keep it anyway. */
async function addCalendarLink(url, anyway = false) {
  const r = await api("/panel/api/calendar/links", { method: "POST", body: { url, ...(anyway ? { anyway: true } : {}) } });
  if (!r.ok || !r.data.ok) {
    const c = r.data.check ?? {};
    return { ok: false, error: r.data.error || t("err.save"), help: r.data.help, canForce: !anyway && c.why && c.why !== "badLink" && c.why !== "refused" };
  }
  if (r.data.restarting && !(await waitForRestart())) return { ok: false, error: t("err.notBack") };
  await loadAll();
  return { ok: true, works: r.data.check?.message ?? "" };
}

async function removeCalendarLink(id, name) {
  if (!window.confirm(t("cal.removeConfirm", { name }))) return;
  const r = await api("/panel/api/calendar/links/remove", { method: "POST", body: { id } });
  if (!r.ok || !r.data.ok) return announce(r.data.error || t("err.save"));
  if (r.data.restarting) await waitForRestart();
  await loadAll();
  redrawAll();
}

/** Every calendar source: this Mac's chosen calendars and each private link, each with its last sync, events, error and Remove. */
function calendarSources(c) {
  const items = [];
  if (c?.mac) {
    items.push(h("li", { class: "src" },
      h("div", { class: "src-head" }, icon("laptop"), h("b", {}, t("cal.mac")),
        btn(t("cal.remove"), async () => {
          if (!window.confirm(t("cal.removeConfirm", { name: t("cal.mac") }))) return;
          await stopCalendars();
          await loadAll();
          redrawAll();
        }, "tiny ghost")),
      rows(row(t("cal.macWhich"), c.mac.calendars.join(", ")), row(t("cal.events"), c.mac.events), row(t("cal.lastSync"), ago(c.mac.lastSync)))));
  }
  for (const l of c?.links ?? []) {
    items.push(h("li", { class: `src${l.error ? " bad" : ""}` },
      h("div", { class: "src-head" }, icon("link"), h("b", {}, l.name || l.host), h("span", { class: "muted mono" }, l.masked),
        btn(t("cal.remove"), () => void removeCalendarLink(l.id, l.name || l.host), "tiny ghost")),
      rows(row(t("cal.lastSync"), ago(l.lastSync)), row(t("cal.events"), l.events), l.error ? row(t("d.lastError"), l.errorText) : null)));
  }
  return h("div", { class: "sources" },
    h("div", { class: "src-top" }, h("h4", {}, t("cal.sources")),
      h("div", { class: "src-add" },
        S.app ? btn(t("cal.addMac"), () => go("calendar", 1, { path: "mac" }), "tiny ghost") : null,
        btn(t("cal.addLink"), () => go("calendar", 1, { path: "ics" }), "tiny primary"))),
    items.length ? h("ul", { class: "src-list" }, items) : h("p", { class: "muted" }, t("cal.noSources")),
    items.length ? h("p", { class: "muted small" }, t("cal.sourcesLead")) : null);
}

/**
 * Apple Reminders (src/reminders-local.ts): the follow-ups on the iPhone and the Watch through the person's own Reminders. Off until turned
 * on here; the app asks macOS first (a refusal says where to turn it on), then keeps Pako's own lists in step. Only in the Mac app.
 */
function remindersBox() {
  const r = S.data.reminders ?? {};
  const out = h("div", { "aria-live": "polite" });
  const redraw = async () => {
    S.data.reminders = (await read("/panel/api/reminders")) ?? S.data.reminders;
    drawCard("calendar");
  };
  const on = h("input", { type: "checkbox", id: "rem-on", checked: !!r.on });
  on.addEventListener("change", async () => {
    on.disabled = true;
    fill(out, testing(t(on.checked ? "rem.turningOn" : "rem.turningOff")));
    const a = await askApp(window, { type: "reminders", on: on.checked }, "pakoReminders", 60_000);
    on.disabled = false;
    if (!a) return fill(out, problem(t("app.noAnswer"), t("app.update")));
    if (a.access === "denied") {
      on.checked = false;
      return fill(out, problem(t("rem.denied")), actions(btn(t("perm.open", { what: t("perm.reminders") }), () => {
        tellApp(window, { type: "openURL", url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders" });
      }, "tiny primary")));
    }
    if (!a.ok) return fill(out, problem(typeof a.error === "string" && a.error ? a.error.slice(0, 300) : t("rem.failed")));
    await redraw();
  });
  const theirs = h("input", { type: "checkbox", id: "rem-waiting", checked: r.waiting !== false });
  theirs.addEventListener("change", async () => {
    theirs.disabled = true;
    const w = await api("/panel/api/reminders/settings", { method: "POST", body: { waiting: theirs.checked } });
    theirs.disabled = false;
    if (!w.ok) return fill(out, problem(t("err.save")));
    // In step now rather than at the app's next round.
    if (r.on) await askApp(window, { type: "reminders", on: true }, "pakoReminders", 30_000);
    await redraw();
  });
  return h("div", { class: "sources reminders" },
    h("div", { class: "src-top" }, h("h4", {}, t("rem.title"))),
    h("p", { class: "muted small" }, t("rem.lead")),
    h("label", { class: "cal-row", for: "rem-on" }, on, h("span", {}, t("rem.on"))),
    r.on ? h("label", { class: "cal-row", for: "rem-waiting" }, theirs, h("span", {}, t("rem.waiting"))) : null,
    r.on ? rows(row(t("rem.inList"), t("rem.count", { owe: r.owe ?? 0, theirs: r.theirs ?? 0 })), row(t("cal.lastSync"), ago(r.at))) : null,
    r.on && r.stale ? h("p", { class: "muted small" }, icon("info"), t("rem.stale")) : null,
    h("p", { class: "muted small" }, t(r.on ? "rem.howOff" : "rem.private")),
    out);
}

/** What the open card shows above its wizard: the connected account and its settings, with its actions. Nothing when not connected. */
function details(id) {
  const d = S.data.details;
  if (!d) return null;
  const box = (...kids) => h("section", { class: "details", "aria-label": t("d.title") }, kids);
  if (id === "calendar") return box(calendarSources(d.calendar), S.app ? remindersBox() : null);
  if (id === "mail") {
    const m = d.mail?.imap;
    const parts = [];
    if (m) {
      const out = h("p", { class: "muted small", "aria-live": "polite" });
      parts.push(rows(
        row(t("d.address"), m.address), row(t("d.server"), `${m.host}:${m.port}`), row(t("d.folders"), m.folders.join(", ")),
        row(t("d.lastCheck"), ago(m.lastCheck)), row(t("d.readToday"), m.readToday), row(t("d.lastError"), m.lastError ?? t("d.none"))),
      actions(
        btn(t("d.checkNow"), async (e) => {
          e.currentTarget.disabled = true;
          out.textContent = t("d.checking");
          const r = await api("/panel/api/mail/check-now", { method: "POST", body: {} });
          if (r.ok && r.data.mail && S.data.details?.mail) S.data.details.mail.imap = r.data.mail;
          drawCard("mail");
        }, "tiny ghost"),
        btn(t("d.edit"), () => go("mail", 1, { path: "imap", address: m.address }), "tiny ghost"),
        btn(t("d.disconnect"), () => void disconnect("imap", m.address), "tiny danger")), out);
    }
    if (d.mail?.agentmail) parts.push(rows(row(t("d.inbox"), d.mail.agentmail.inbox)));
    return parts.length ? box(...parts) : null;
  }
  if (id === "slack" && d.slack) {
    return box(rows(row(t("d.workspace"), d.slack.workspace), row(t("d.user"), d.slack.user), row(t("d.watches"), d.slack.watches),
      row(t("d.socket"), d.slack.socketMode ? t("d.on") : t("d.off")), row(t("d.lastSeen"), ago(d.slack.lastSeen))),
    actions(btn(t("d.disconnect"), () => void disconnect("slack", "Slack"), "tiny danger")));
  }
  if (id === "zoom" && d.zoom) {
    const last = d.zoom.lastMeeting;
    return box(rows(row(t("d.account"), d.zoom.account), row(t("d.lastMeeting"), last ? `${last.topic} · ${ago(last.at)}` : t("d.never"))),
      actions(btn(t("d.disconnect"), () => void disconnect("zoom", "Zoom"), "tiny danger")));
  }
  if (id === "telegram" && d.telegram) return box(rows(row(t("d.bot"), d.telegram.bot), row(t("d.owner"), d.telegram.owner ?? (d.telegram.paired ? "" : t("d.notPaired")))));
  if (id === "whatsapp" && d.whatsapp) {
    return box(rows(row(t("d.number"), d.whatsapp.number), row(t("d.template"), d.whatsapp.template ? `${d.whatsapp.template} (${d.whatsapp.language})` : "")));
  }
  if (id === "tables" && d.tables) return box(rows(row(t("d.service"), d.tables.service)));
  if (id === "phone" && d.phone) return box(rows(row(t("d.calls"), d.phone.calls)));
  if (id === "claude" && d.claude) return box(rows(row(t("d.way"), d.claude.way)));
  return null;
}

// ---------- the tabs: Connections, Mail, How Pako acts, Privacy & your data, Move & import, Labs, General ----------

const TABS = ["connections", "mail", "acts", "privacy", "move", "labs", "general"];
/** The tab a link lands on: a tab's own name, the mail card (#mail, #imap), or any other card's name (Connections). */
function tabOf(hash) {
  if (TABS.includes(hash)) return hash;
  if (hash === "imap") return "mail";
  // Older links to the dashboard's cards that live here now.
  if (hash === "privacy-card" || hash === "data") return "privacy";
  if (hash === "acts-card" || hash === "autonomy") return "acts";
  if (hash === "move-card" || hash === "import") return "move";
  if (hash === "autostart" || hash === "health" || hash === "system" || hash === "phone") return "general";
  return "connections";
}
function showTab(id, focus = false) {
  for (const tab of TABS) {
    const b = $(`#tab-btn-${tab}`);
    const p = $(`#tab-${tab}`);
    if (b) {
      b.setAttribute("aria-selected", tab === id ? "true" : "false");
      b.tabIndex = tab === id ? 0 : -1;
    }
    if (p) p.hidden = tab !== id;
  }
  if (focus) $(`#tab-btn-${id}`)?.focus();
}
function drawTabs() {
  const bar = $("#tabs");
  if (!bar) return;
  bar.setAttribute("aria-label", t("tabs.aria"));
  fill(bar, ...TABS.map((tab) => h("button", {
    type: "button", role: "tab", class: "tabbtn", id: `tab-btn-${tab}`, "aria-controls": `tab-${tab}`,
    onclick: () => {
      // The address follows the tab, so a reload or a shared link lands on it.
      history.replaceState(null, "", `#${tab}`);
      showTab(tab);
    },
    onkeydown: (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const i = (TABS.indexOf(tab) + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
      history.replaceState(null, "", `#${TABS[i]}`);
      showTab(TABS[i], true);
    },
  }, t(`tab.${tab}`))));
  showTab(tabOf(location.hash.slice(1)));
}

// ---------- the page ----------

function words() {
  document.title = t("pageTitle");
  for (const el of document.querySelectorAll("[data-t]")) el.textContent = t(el.dataset.t);
}

async function start() {
  recall();
  words();
  drawTabs();
  await loadAll();
  if (!S.data.connections) {
    // Not a computer's Pako (or not signed in, handled in api()): nothing here can be connected.
    fill($("#cards"), h("li", {}, problem(t("err.noConnections"))));
    return;
  }
  const fromHash = location.hash.slice(1);
  showTab(tabOf(fromHash));
  if (Object.hasOwn(CARD, fromHash)) S.open = fromHash;
  drawDiscovery();
  drawCards();
  drawKnown();
  drawHero();
  document.body.classList.add("ready");
  if (Object.hasOwn(CARD, fromHash)) openCard(fromHash);
}

window.addEventListener("hashchange", () => {
  const id = location.hash.slice(1);
  showTab(tabOf(id));
  if (Object.hasOwn(CARD, id)) openCard(id);
});
// Back on the tab after a while (a token made in another tab, a phone paired): what is connected is read again, the open wizard left alone.
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || S.restarting) return;
  await loadAll();
  for (const id of Object.keys(CARD)) if (id !== S.open) drawCard(id);
  drawHero();
});

mountTwins(); // Pako's figure in the header (figure-twin.js)
void start();
