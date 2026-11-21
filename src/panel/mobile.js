// Pako · Settings › General: "Use on my phone (same Wi-Fi)", on a person's computer only (src/mobile-panel.ts answers there; elsewhere the
// card never shows). One switch turns the phone's server on the home network on or off; "Pair a phone" shows a QR code and a code to type,
// which work once, for 10 minutes; each paired phone is listed with when it was last seen, and can be removed. Away from home, Telegram.
// Everything the server sends is put on the page as text, never as HTML; the QR code is an image made by the server (an SVG as data:).

const WORDS = {
  title: "Use on my phone (same Wi-Fi)",
  lead: "Your brief and your follow-ups in your phone's browser, with Done, Snooze and Park, while the phone is on the same Wi-Fi as this computer.",
  away: "Away from home, Pako reaches you on Telegram.",
  telegramOn: "Telegram is set up.",
  telegramOff: "Set up Telegram",
  safety: "Use it on a network you trust, like your home Wi-Fi: anyone on the same Wi-Fi can reach the page, only paired phones see anything, and "
    + "the connection is not encrypted.",
  off: "Off. Pako answers this computer only.",
  on: "On, at {url}",
  onNowhere: "On, but not reachable yet",
  turnOn: "Turn on",
  turnOff: "Turn off",
  pair: "Pair a phone",
  pairAgain: "New code",
  pairHow: "Scan this with the phone's camera, or open {url} on the phone and type the code. It works once, for 10 minutes.",
  qrAlt: "QR code to pair a phone",
  phones: "Paired phones",
  none: "No phone paired yet.",
  seen: "last seen {when}",
  paired: "paired {when}",
  remove: "Remove",
  removeAll: "Remove all",
  removeAsk: "Remove {name}? It will need a new code to come back.",
  removeAllAsk: "Remove every paired phone?",
  working: "One moment…",
  failed: "I couldn't change it. Try again.",
  now: "just now",
};
const t = (key, vars = {}) => String(WORDS[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k === "onclick") el.addEventListener("click", v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== "") el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const when = (at) => {
  if (Date.now() - at < 120_000) return t("now");
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(at);
};

let card = null;
let state = null;
/** The pairing on show: { link, code, qr, expiresAt }. */
let pairing = null;
let note = "";
let busy = false;

async function call(path, body) {
  const r = await fetch(path, body === undefined
    ? { credentials: "same-origin", cache: "no-store" }
    : { method: "POST", credentials: "same-origin", headers: { "x-pako": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
  if (r.status === 401) {
    location.reload(); // the session ended: the sign-in page says what to do
    throw new Error("sign in");
  }
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
}

async function load() {
  try {
    const r = await call("/panel/api/phone");
    // 404: a server's panel, which has no such card.
    if (!r.ok || !r.body) return;
    state = r.body;
    if (!state.on) pairing = null;
    paint();
  } catch {
    /* the server is restarting: the next load asks again */
  }
}

async function run(f) {
  if (busy) return;
  busy = true;
  note = "";
  paint();
  try {
    await f();
  } catch {
    /* offline or refused: said in the note */
    note = t("failed");
  } finally {
    busy = false;
    paint();
  }
}

const toggle = () => run(async () => {
  const r = await call("/panel/api/phone", { on: !state.on });
  if (r.ok && r.body) {
    state = r.body;
    pairing = null;
  } else note = r.body?.error || t("failed");
});
const pair = () => run(async () => {
  const r = await call("/panel/api/phone/pair", {});
  if (r.ok && r.body) pairing = r.body;
  else note = r.body?.error || t("failed");
});
const remove = (d) => run(async () => {
  if (!confirm(t("removeAsk", { name: d.name }))) return;
  await call("/panel/api/phone/revoke", { id: d.id });
  await load();
});
const removeAll = () => run(async () => {
  if (!confirm(t("removeAllAsk"))) return;
  await call("/panel/api/phone/revoke", { all: true });
  await load();
});

function paint() {
  if (!card || !state) return;
  card.hidden = false;
  const live = pairing && pairing.expiresAt > Date.now();
  const body = [
    h("p", { class: "muted" }, t("lead")),
    h("p", {}, t("away"), " ", state.telegram ? t("telegramOn") : h("a", { href: "/panel/settings#telegram" }, t("telegramOff"))),
    h("p", { "aria-live": "polite" }, h("strong", {}, !state.on ? t("off") : state.url ? t("on", { url: state.url }) : t("onNowhere"))),
    state.on && state.problem ? h("p", { class: "muted" }, state.problem) : null,
    h("div", { class: "src-add" },
      h("button", { type: "button", class: `btn${state.on ? " ghost" : " primary"}`, disabled: busy, onclick: toggle }, busy ? t("working") : t(state.on ? "turnOff" : "turnOn")),
      state.on && state.url ? h("button", { type: "button", class: "btn primary", disabled: busy, onclick: pair }, t(live ? "pairAgain" : "pair")) : null),
    live
      ? h("div", { class: "details phone-pair" },
          h("img", { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(pairing.qr)}`, alt: t("qrAlt"), width: "220", height: "220" }),
          h("p", { class: "mono phone-code" }, pairing.code),
          h("p", { class: "muted" }, t("pairHow", { url: state.url })))
      : null,
    state.on ? h("p", { class: "muted small" }, t("safety")) : null,
    h("h3", {}, t("phones")),
    state.devices.length
      ? h("ul", { class: "src-list" }, state.devices.map((d) => h("li", { class: "src" },
          h("div", { class: "src-head" }, h("strong", {}, d.name), h("button", { type: "button", class: "btn ghost", disabled: busy, onclick: () => remove(d) }, t("remove"))),
          h("p", { class: "muted small" }, `${t("paired", { when: when(d.createdAt) })} · ${t("seen", { when: when(d.lastSeen) })}`))))
      : h("p", { class: "muted" }, t("none")),
    state.devices.length > 1 ? h("button", { type: "button", class: "btn ghost", disabled: busy, onclick: removeAll }, t("removeAll")) : null,
    note ? h("p", { class: "muted", role: "alert" }, note) : null,
  ];
  card.replaceChildren(h("div", { class: "card-head" }, h("h2", { id: "h-phone" }, h("i", { "data-lucide": "smartphone" }), t("title"))), ...body);
  window.lucide?.createIcons?.({ attrs: { "aria-hidden": "true" } });
}

function mount() {
  const grid = document.querySelector('[data-mount="phone"]');
  if (!grid) return;
  card = h("section", { class: "card phone", id: "phone-card", "aria-labelledby": "h-phone", hidden: true });
  grid.append(card);
  void load();
  // While a code is on show: the list follows the phone that uses it.
  setInterval(() => {
    if (document.visibilityState === "visible" && pairing && pairing.expiresAt > Date.now()) void load();
    else if (pairing && pairing.expiresAt <= Date.now()) {
      pairing = null;
      paint();
    }
  }, 5000);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
