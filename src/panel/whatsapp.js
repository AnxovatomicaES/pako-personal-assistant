// Pako · panel: WhatsApp on a person's computer, in five guided steps (src/whatsapp-computer.ts answers GET/POST /panel/api/whatsapp/setup;
// a server's panel answers 404 and this card never shows). 1) create a Meta developer app, 2) add WhatsApp and copy its details, 3) paste
// them (checked live with Meta), 4) Pako turns on Cloudflare's tunnel and registers the webhook itself, 5) "Send me a hi": a test message,
// and a ✓ when the owner answers it. Meta's official Cloud API only.
// Everything the server sends is put on the page as text, never as HTML; no secret is ever sent back to the page.

import { localeFor } from "./i18n.js";
import { h } from "./dom.js";

const $ = (s, root = document) => root.querySelector(s);

const WORDS = {
  "title": "WhatsApp",
  "pill.off": "not connected",
  "pill.half": "half set",
  "pill.on": "connected",
  "lead": "Talk to Pako from your usual WhatsApp. It takes five steps, and I'll walk you through each one.",
  "official": "Meta's official WhatsApp API only: unofficial libraries break WhatsApp's terms and can get your number banned.",
  "s1": "Create a Meta app",
  "s2": "Add WhatsApp and copy the details",
  "s3": "Paste the details here",
  "s4": "Open the safe tunnel",
  "s5": "Send me a hi",
  "s1.lead": "It's free and takes a couple of minutes. On Meta's page, choose exactly this:",
  "s1.a": "Details: name “Pako” and your email.",
  "s1.b": "Use case: “Connect with customers through WhatsApp”.",
  "s1.c": "Business: yours, or “I don't want to connect a business portfolio yet”.",
  "s1.d": "Review and press “Create app”.",
  "s1.open": "Open Meta for Developers",
  "s1.next": "I have the app",
  "s2.lead": "Inside your new app:",
  "s2.a": "WhatsApp menu → “API Setup”.",
  "s2.b": "Under “From” is the test number: copy its “Phone number ID”.",
  "s2.c": "Under “To”, add your number and confirm it with the code you get on WhatsApp.",
  "s2.d": "Press “Generate access token” and copy it. That one lasts 24 hours.",
  "s2.e": "App settings → Basic: copy the App ID and the App secret (“Show”).",
  "s2.perm": "So it never expires: in your business settings make a system user (Admin), assign it the app and generate a token "
    + "with whatsapp_business_messaging and whatsapp_business_management, expiry “Never”.",
  "s2.permLink": "System users",
  "s2.open": "Open my apps",
  "s2.next": "I have the details",
  "f.appId": "App ID",
  "f.appSecret": "App secret",
  "f.phoneNumberId": "Phone number ID",
  "f.accessToken": "Access token",
  "f.ownerNumber": "Your WhatsApp number",
  "f.ownerHint": "With the country code, for example +44 7700 900123",
  "f.kept": "Saved: leave it empty to keep it",
  "s3.check": "Check with Meta and save",
  "s3.checking": "Checking with Meta…",
  "s3.ok": "Meta accepts them: number {number}{app}.",
  "s4.lead": "WhatsApp delivers your messages to a public internet address, which this computer doesn't have. Pako downloads cloudflared, "
    + "Cloudflare's official program (checked against the SHA-256 checksum Cloudflare publishes), and opens a tunnel that lets through "
    + "WhatsApp's messages only: the panel and everything else stay closed.",
  "s4.go": "Yes, open the tunnel",
  "s4.off": "Close the tunnel",
  "s4.download": "Downloading cloudflared and checking its checksum",
  "s4.start": "Opening the tunnel",
  "s4.meta": "Meta checks the address",
  "s4.ok": "Address verified by Meta",
  "s4.again": "Try again",
  "s5.lead": "Pako sends a test message to your WhatsApp. Reply “hi” and you'll see the ✓ here.",
  "s5.go": "Send me a hi",
  "s5.wait": "Check your WhatsApp and reply “hi”…",
  "s5.again": "Send it again",
  "done.title": "WhatsApp connected",
  "done.lead": "Write to Pako from your WhatsApp whenever you like.",
  "win.open": "I can write to you on WhatsApp until {time}.",
  "win.closed": "Window closed: write me anything on WhatsApp to open it.",
  "fine.window": "WhatsApp lets Pako write to you freely only for 24 hours after your last message; after that, what Pako starts reaches "
    + "you in the panel (or on Telegram).",
  "fine.template": "To write to you after those 24 hours, Pako needs a message template approved by Meta.",
  "tpl": "Template {name}: {status}",
  "tpl.approved": "approved",
  "tpl.pending": "in review",
  "tpl.rejected": "rejected",
  "tpl.missing": "not created",
  "tpl.unknown": "no news yet",
  "phone": "Phone line: set PAKO_URL = {url} on your voice worker (it changes each time the tunnel starts).",
  "copy": "Copy",
  "copied": "Copied",
  "forget": "Forget WhatsApp on this computer",
  "forgetConfirm": "Forget WhatsApp? Pako deletes your Meta app's details from this computer and closes the tunnel.",
  "failed": "I couldn't do it. Try again.",
  "step": "Step {n} of 5",
  "back": "Back",
};

function t(key, vars) {
  const s = WORDS[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m)) : s;
}

const icon = (name) => h("i", { "data-lucide": name });
const paintIcons = () => window.lucide?.createIcons?.({ attrs: { "aria-hidden": "true" } });
const link = (href, text, cls = "btn ghost") => h("a", { class: cls, href, target: "_blank", rel: "noopener noreferrer" }, icon("external-link"), text);

const META_NEW_APP = "https://developers.facebook.com/apps/creation/";
const META_APPS = "https://developers.facebook.com/apps/";
const SYSTEM_USERS = "https://business.facebook.com/settings/system-users";
const FIELDS = [
  { key: "appId", type: "text", mode: "numeric" },
  { key: "appSecret", type: "password" },
  { key: "phoneNumberId", type: "text", mode: "numeric" },
  { key: "accessToken", type: "password" },
  { key: "ownerNumber", type: "tel", hint: "f.ownerHint" },
];

const st = {
  data: null,
  /** The step the person is looking at (1 to 5), or 0: the one the server says. */
  view: 0,
  busy: false,
  error: "",
  note: "",
  card: null,
  sig: "",
  timer: 0,
  copied: false,
};

async function call(body) {
  const init = body === undefined
    ? { credentials: "same-origin", cache: "no-store" }
    : { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-pako": "1" }, body: JSON.stringify(body) };
  return fetch("/panel/api/whatsapp/setup", init);
}

/** The step the server's state puts the person on: 1 to 3 before anything is saved (steps 1 and 2 happen on Meta's site), then 4, 5, 6 (done). */
function serverStep(d) {
  if (!d) return 1;
  return d.step === "app" ? 1 : d.step === "tunnel" ? 4 : d.step === "test" ? 5 : 6;
}
const current = () => st.view || serverStep(st.data);

/** Something is under way that the server will finish by itself: the page looks often until it has. */
function moving(d) {
  if (!d) return false;
  const tun = d.tunnel?.state;
  return tun === "downloading" || tun === "starting" || d.meta?.webhook === "registering" || d.meta?.awaiting === true
    || (tun === "on" && d.meta?.webhook !== "verified" && d.meta?.webhook !== "failed");
}

async function load() {
  try {
    const r = await call();
    // 404: a server's panel. 401: signed out (the page itself handles it).
    if (!r.ok) return;
    const before = st.data;
    st.data = await r.json();
    // The connections page (/panel/settings) leads here with #whatsapp: the card comes into view once, the first time it is drawn.
    if (!before && location.hash === "#whatsapp") setTimeout(() => window.pakoWhatsapp.open(), 0);
    // A step finished by the server (the tunnel verified, the owner's reply): the view follows it.
    if (before && serverStep(before) !== serverStep(st.data) && st.view && st.view < serverStep(st.data)) st.view = 0;
    render();
  } catch (err) {
    console.warn("whatsapp", err);
  } finally {
    clearTimeout(st.timer);
    st.timer = setTimeout(load, moving(st.data) ? 1500 : 20_000);
  }
}

async function act(action, values) {
  st.busy = true;
  st.error = "";
  st.note = "";
  render();
  try {
    const r = await call({ action, ...(values ? { values } : {}) });
    const body = await r.json().catch(() => ({}));
    if (body && typeof body === "object" && body.step) st.data = body;
    if (!body.ok) st.error = typeof body.error === "string" && body.error ? body.error : t("failed");
    else if (action === "saveMeta") {
      const m = st.data?.meta ?? {};
      st.note = t("s3.ok", { number: m.testNumber || m.phoneNumberId || "", app: m.appName ? ` · ${m.appName}` : "" });
      st.view = 0;
    } else st.view = 0;
    return !!body.ok;
  } catch {
    /* offline: said in the error line */
    st.error = t("failed");
    return false;
  } finally {
    st.busy = false;
    render();
    clearTimeout(st.timer);
    st.timer = setTimeout(load, 1200);
  }
}

// ---------- the steps ----------

/** The exact choices to make on Meta's pages, drawn as a small window whose lines light up one after the other. */
function bullets(label, keys) {
  return h("div", { class: "wa-mock" },
    h("div", { class: "wa-mock-bar", "aria-hidden": "true" }, h("span"), h("span"), h("span")),
    h("ol", { "aria-label": label }, keys.map((k, i) => h("li", { "data-i": String(i) }, h("span", { class: "wa-mock-n" }, String(i + 1)), t(k)))));
}

function stepOne() {
  return [
    h("p", { class: "wa-lead" }, t("s1.lead")),
    bullets(t("s1"), ["s1.a", "s1.b", "s1.c", "s1.d"]),
    h("div", { class: "wa-row" },
      link(META_NEW_APP, t("s1.open"), "btn primary"),
      h("button", { type: "button", class: "btn ghost", onclick: () => go(2) }, t("s1.next"), icon("arrow-right"))),
  ];
}

function stepTwo() {
  return [
    h("p", { class: "wa-lead" }, t("s2.lead")),
    bullets(t("s2"), ["s2.a", "s2.b", "s2.c", "s2.d", "s2.e"]),
    h("p", { class: "wa-fine" }, icon("key-round"), t("s2.perm"), " ", h("a", { href: SYSTEM_USERS, target: "_blank", rel: "noopener noreferrer" }, t("s2.permLink"))),
    h("div", { class: "wa-row" },
      h("button", { type: "button", class: "btn ghost", onclick: () => go(1) }, icon("arrow-left"), t("back")),
      link(META_APPS, t("s2.open")),
      h("button", { type: "button", class: "btn primary", onclick: () => go(3) }, t("s2.next"), icon("arrow-right"))),
  ];
}

function stepThree() {
  const saved = !!st.data?.meta?.appId;
  const form = h("form", { class: "wa-form", autocomplete: "off", onsubmit: (e) => {
    e.preventDefault();
    const values = {};
    for (const f of FIELDS) {
      const v = form.elements[f.key]?.value.trim() ?? "";
      if (v) values[f.key] = v;
    }
    void act("saveMeta", values).then((ok) => {
      if (ok) for (const f of FIELDS) if (form.elements[f.key]) form.elements[f.key].value = "";
    });
  } },
  FIELDS.map((f) => {
    const id = `wa-${f.key}`;
    const shown = f.key === "appId" || f.key === "phoneNumberId" || f.key === "ownerNumber" ? st.data?.meta?.[f.key] : "";
    return h("div", { class: "wa-field" },
      h("label", { for: id }, t(`f.${f.key}`)),
      h("input", {
        id, name: f.key, type: f.type, class: "tg-input", spellcheck: "false", autocapitalize: "off", autocomplete: "off", maxlength: 1200,
        ...(f.mode ? { inputmode: f.mode } : {}),
        placeholder: saved ? (shown ? `${shown} · ${t("f.kept")}` : t("f.kept")) : "",
        required: !saved,
      }),
      f.hint ? h("p", { class: "muted small" }, t(f.hint)) : null);
  }),
  h("div", { class: "wa-row" },
    h("button", { type: "button", class: "btn ghost", onclick: () => go(2) }, icon("arrow-left"), t("back")),
    h("button", { type: "submit", class: "btn primary", disabled: st.busy },
      st.busy ? h("span", { class: "spinner", "aria-hidden": "true" }) : icon("shield-check"), st.busy ? t("s3.checking") : t("s3.check"))));
  return [form];
}

function stepFour() {
  const d = st.data ?? {};
  const tun = d.tunnel?.state ?? "off";
  const hook = d.meta?.webhook ?? "none";
  if (tun === "off" || (tun === "error" && !st.busy)) {
    return [
      h("p", { class: "wa-lead" }, t("s4.lead")),
      h("div", { class: "wa-row" },
        h("button", { type: "button", class: "btn primary", disabled: st.busy, onclick: () => void act("tunnelOn") },
          icon("shield-check"), tun === "error" ? t("s4.again") : t("s4.go"))),
    ];
  }
  // The pipeline, each stage lit as the server reaches it.
  const stage = tun === "downloading" ? 0 : tun === "starting" ? 1 : hook === "verified" ? 3 : 2;
  const stages = ["s4.download", "s4.start", "s4.meta", "s4.ok"];
  return [
    h("ol", { class: "wa-pipe" }, stages.map((k, i) =>
      h("li", { class: i < stage || (i === 3 && stage === 3) ? "done" : i === stage ? "now" : "" },
        h("span", { class: "wa-pipe-dot", "aria-hidden": "true" }), t(k)))),
    d.tunnel?.url ? h("p", { class: "wa-url" }, icon("globe-lock"), h("code", {}, d.tunnel.url)) : null,
    h("div", { class: "wa-row" },
      hook === "failed" ? h("button", { type: "button", class: "btn ghost", disabled: st.busy, onclick: () => void act("tunnelOn") }, t("s4.again")) : null,
      h("button", { type: "button", class: "btn ghost", disabled: st.busy, onclick: () => void act("tunnelOff") }, icon("power"), t("s4.off"))),
  ];
}

function stepFive() {
  const waiting = st.data?.meta?.awaiting === true;
  return [
    h("p", { class: "wa-lead" }, t("s5.lead")),
    waiting ? h("div", { class: "wa-wait", role: "status" }, h("span", { class: "wa-phone", "aria-hidden": "true" }, icon("smartphone")), t("s5.wait")) : null,
    h("div", { class: "wa-row" },
      h("button", { type: "button", class: waiting ? "btn ghost" : "btn primary", disabled: st.busy, onclick: () => void act("sendTest") },
        icon("send"), waiting ? t("s5.again") : t("s5.go"))),
  ];
}

function doneBody() {
  const d = st.data ?? {};
  const w = d.meta?.window ?? {};
  const until = w.open && w.until ? new Intl.DateTimeFormat(localeFor(document.documentElement.dataset.region), { hour: "2-digit", minute: "2-digit" }).format(w.until) : "";
  return [
    h("div", { class: "wa-done" },
      h("span", { class: "wa-big-check", "aria-hidden": "true" }, icon("check")),
      h("div", {}, h("b", {}, t("done.title")), h("p", { class: "muted" }, t("done.lead")))),
    h("p", { class: "wa-fine" }, icon(w.open ? "message-circle" : "clock"), until ? t("win.open", { time: until }) : t("win.closed")),
    h("div", { class: "wa-row" },
      h("button", { type: "button", class: "btn ghost", disabled: st.busy, onclick: () => void act("tunnelOff") }, icon("power"), t("s4.off"))),
  ];
}

const BODIES = [stepOne, stepTwo, stepThree, stepFour, stepFive];

function go(n) {
  st.view = n;
  st.error = "";
  st.note = "";
  render();
  $(".wa-step.open .wa-step-head", st.card)?.focus({ preventScroll: true });
}

function render() {
  // WhatsApp is how Pako reaches the owner, not content: its guide lives only in Settings, Connections (the card's [data-mount=whatsapp]).
  // That slot is drawn again with its card, so the guide follows it there.
  const slot = $('[data-mount="whatsapp"]');
  if (!slot) return;
  if (!st.card) st.card = h("section", { class: "card wa-card", id: "wa-card", "aria-labelledby": "h-wa" });
  if (st.card.parentElement !== slot) {
    slot.append(st.card);
    st.sig = "";
  }
  const d = st.data ?? {};
  const at = current();
  const doneSet = new Set(d.done ?? []);
  const sig = JSON.stringify([d, st.view, st.busy, st.error, st.note, st.copied]);
  if (sig === st.sig) return;
  st.sig = sig;
  const had = st.card.contains(document.activeElement) ? document.activeElement?.id : "";
  const kept = {};
  for (const f of FIELDS) {
    const el = document.getElementById(`wa-${f.key}`);
    if (el?.value) kept[f.key] = el.value;
  }
  const finished = at === 6;
  const pill = finished ? "on" : doneSet.has("values") ? "half" : "off";
  const names = ["app", "number", "values", "tunnel", "test"];
  const progress = Math.round((names.filter((n) => doneSet.has(n)).length / names.length) * 100);
  const tpl = d.meta?.template;
  // Through h() so that the parts left out (null) are left out, not written as text.
  st.card.replaceChildren(...h("div", {},
    h("div", { class: "card-head" },
      h("h2", { id: "h-wa" }, icon("message-circle"), h("span", {}, t("title"))),
      h("span", { class: `wa-pill ${pill}` }, t(`pill.${pill}`))),
    h("div", { class: "wa-progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(progress) },
      h("span", { class: "wa-progress-fill", "data-p": String(progress) })),
    finished ? null : h("p", { class: "wa-lead" }, t("lead")),
    finished
      ? h("div", { class: "wa-body" }, doneBody())
      : h("ol", { class: "wa-steps" }, BODIES.map((body, i) => {
          const n = i + 1;
          const isDone = doneSet.has(names[i]) || n < serverStep(d);
          const open = n === at;
          return h("li", { class: `wa-step${open ? " open" : ""}${isDone ? " done" : ""}` },
            h("button", { type: "button", class: "wa-step-head", "aria-expanded": String(open), onclick: () => go(n),
              disabled: n > Math.max(serverStep(d), 3) },
              h("span", { class: "wa-dot", "aria-hidden": "true" }, isDone ? icon("check") : String(n)),
              h("span", { class: "wa-step-title" }, t(`s${n}`)),
              open ? h("span", { class: "muted small" }, t("step", { n })) : null),
            open ? h("div", { class: "wa-body" }, body()) : null);
        })),
    st.error ? h("p", { class: "tg-error", role: "alert" }, icon("triangle-alert"), st.error) : null,
    st.note ? h("p", { class: "tg-ok", role: "status" }, icon("circle-check"), st.note) : null,
    ...(d.problems ?? []).filter((p) => p !== st.error).map((p) => h("p", { class: "tg-error", role: "status" }, icon("triangle-alert"), p)),
    d.phone?.on && d.phone.url ? h("p", { class: "wa-fine" }, icon("phone"), t("phone", { url: d.phone.url }), " ",
      h("button", { type: "button", class: "chip", onclick: () => void copy(d.phone.url) }, st.copied ? t("copied") : t("copy"))) : null,
    h("div", { class: "wa-foot" },
      h("p", { class: "wa-fine" }, icon("shield-check"), t("official")),
      h("p", { class: "wa-fine" }, icon("clock"), t("fine.window")),
      h("p", { class: "wa-fine" }, icon("file-check"), t("fine.template"), " ",
        tpl ? h("span", { class: `wa-tpl ${tpl.status}` }, t("tpl", { name: tpl.name, status: WORDS[`tpl.${tpl.status}`] ?? tpl.status })) : null),
      d.meta?.appId
        ? h("button", { type: "button", class: "btn ghost small", disabled: st.busy, onclick: () => {
            if (confirm(t("forgetConfirm"))) void act("forget");
          } }, icon("trash-2"), t("forget"))
        : null)).childNodes);
  for (const [k, v] of Object.entries(kept)) {
    const el = document.getElementById(`wa-${k}`);
    if (el) el.value = v;
  }
  // The bar grows to its width after it is drawn, so the change animates.
  const fill = $(".wa-progress-fill", st.card);
  if (fill) requestAnimationFrame(() => fill.style.setProperty("width", `${fill.dataset.p}%`));
  if (had) document.getElementById(had)?.focus({ preventScroll: true });
  paintIcons();
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    st.copied = true;
    render();
    setTimeout(() => {
      st.copied = false;
      render();
    }, 1500);
  } catch {
    /* no clipboard here: the address is on the page to copy by hand */
  }
}

// The stylesheet of this card, beside the page's own (a file of the panel, as the page's rules require).
document.head.append(h("link", { rel: "stylesheet", href: "/panel/assets/whatsapp.css" }));

/** Brings the card into view (the Connections drawer and the Mac app's Connect step point here). False when there is no card (a server). */
window.pakoWhatsapp = {
  open: () => {
    if (!st.card || !st.data) return false;
    document.querySelector("dialog[open]")?.close?.();
    st.card.scrollIntoView({ behavior: "smooth", block: "start" });
    $("h2", st.card)?.setAttribute("tabindex", "-1");
    $("h2", st.card)?.focus({ preventScroll: true });
    return true;
  },
};

void load();

// The Settings page draws its WhatsApp card again as the owner moves around: the guide moves into the new slot.
new MutationObserver(() => {
  const slot = document.querySelector('[data-mount="whatsapp"]');
  if (slot && st.data && (!st.card || st.card.parentElement !== slot)) render();
}).observe(document.documentElement, { childList: true, subtree: true });
