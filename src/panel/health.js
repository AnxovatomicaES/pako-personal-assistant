// Pako · panel: the Health part of the System card. Every moving part Pako watches (src/watchdog.ts answers GET /panel/api/health): the assistant's
// computer and Claude, the data store, WhatsApp, Telegram, the calendar, the mail, Slack and Zoom, each with its state, since when it fails
// or when it last worked, and the version the assistant's computer runs. Read only. Everything the server sends is put on the page as text,
// never as HTML. Its words are its own (English, here).

import { localeFor } from "./i18n.js";
import { healthSummary } from "./dashboard-model.js";

const WORDS = {
  title: "Health",
  lead: "If something stops working, I tell you once on the chat that still works, and again when it is back. On the chat: “how is Pako doing?” or HEALTH.",
  off: "Watching is off (WATCHDOG=off).",
  quiet: "These are your quiet hours: I only tell you if the assistant's computer or the data store goes down.",
  "name.bridge": "Assistant's computer",
  "name.claude": "Claude",
  "name.store": "Data store",
  "name.whatsapp": "WhatsApp",
  "name.telegram": "Telegram",
  "name.calendar": "Calendar",
  "name.mail": "Pako's inbox",
  "name.imap": "Your mailbox",
  "name.slack": "Slack",
  "name.slackEvents": "Slack's events",
  "name.zoom": "Zoom",
  "name.update": "Computer's version",
  ok: "Working · {ago}",
  okNow: "Working",
  failing: "Failing since {when}",
  down: "Down since {when}: I told you",
  waiting: "No news yet",
  limit: "At its usage limit: it comes back by itself",
  version: "Version {sha} from {day}",
  updated: "updated itself on {day}",
  behind: "more than a day behind the server",
  auto: "auto-update: {why}",
  ago: "{n} min ago",
  agoH: "{n} h ago",
  justNow: "just now",
  usage: "Today, {n} runs of Claude: {mine} yours, {bg} of {cap} in the background",
  usageSkipped: "{n} jobs handled without Claude",
  usagePaused: "background work waits until {when}",
};

const ICONS = {
  bridge: "laptop", claude: "sparkles", store: "database", whatsapp: "message-circle", telegram: "send", calendar: "calendar", mail: "inbox",
  imap: "mail", slack: "hash", slackEvents: "hash", zoom: "video", update: "git-branch",
};

/** Dates written the way the owner's country writes English (i18n.js localeFor). */
const localeOf = () => localeFor(document.documentElement.dataset.region);
const t = (key, vars = {}) => (WORDS[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
const str = (v) => (typeof v === "string" ? v : "");
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const locale = () => localeOf();
const when = (at) => {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
  return today ? time : `${d.toLocaleDateString(locale(), { day: "numeric", month: "short" })} ${time}`;
};
const day = (at) => new Date(at).toLocaleDateString(locale(), { day: "numeric", month: "short" });
const ago = (at) => {
  const mins = Math.round((Date.now() - at) / 60_000);
  if (mins < 1) return t("justNow");
  return mins < 90 ? t("ago", { n: mins }) : t("agoH", { n: Math.round(mins / 60) });
};

let card = null;
let state = null;

function line(p) {
  const okAt = num(p.okAt);
  const failSince = num(p.failSince);
  if (p.status === "down") return t("down", { when: failSince ? when(failSince) : "?" });
  if (p.status === "failing") return t("failing", { when: failSince ? when(failSince) : "?" });
  if (p.status === "warn") return t("limit");
  if (p.status === "waiting") return t("waiting");
  return okAt ? t("ok", { ago: ago(okAt) }) : t("okNow");
}

function versionLine(b) {
  if (!b) return "";
  const parts = [t("version", { sha: str(b.sha).slice(0, 7), day: num(b.committedAt) ? day(b.committedAt) : "?" })];
  if (num(b.updatedAt)) parts.push(t("updated", { day: day(b.updatedAt) }));
  if (b.behind) parts.push(t("behind"));
  if (str(b.autoupdate) && b.autoupdate !== "on") parts.push(t("auto", { why: str(b.autoupdate) }));
  return parts.join(" · ");
}

/** Today's runs of Claude as the assistant's computer counts them (assistant/budget.ts); "" before it says any, or from another day. */
function usageLine(u) {
  if (!u || typeof u !== "object") return "";
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (str(u.day) !== today) return "";
  const mine = num(u.interactive) ?? 0;
  const bg = num(u.background) ?? 0;
  const s = u.skipped && typeof u.skipped === "object" ? u.skipped : {};
  const skipped = (num(s.cap) ?? 0) + (num(s.paused) ?? 0) + (num(s.same) ?? 0);
  const parts = [t("usage", { n: mine + bg, mine, bg, cap: num(u.perDay) ?? "?" })];
  if (skipped) parts.push(t("usageSkipped", { n: skipped }));
  if ((num(u.pausedUntil) ?? 0) > Date.now()) parts.push(t("usagePaused", { when: when(u.pausedUntil) }));
  return parts.join(" · ");
}

/**
 * Which Claude Code the assistant's computer drives, when there is something to say (assistant/bridge/cli-probe.ts): the bridge's own
 * sentence ("Claude Code X.Y: tested by probe", or what failed its self-test and how to go back); "" when it is plain ok or never said.
 */
function cliLine(c) {
  if (!c || typeof c !== "object" || c.status === "ok") return "";
  return str(c.note);
}

function paint() {
  if (!card || !state) return;
  card.hidden = false;
  // Calm by default: one line when all is well, the problems first (each with its fix) when not; the list folded below.
  const sum = healthSummary(state, Date.now());
  const top = card.querySelector("[data-hl-summary]");
  top.className = `hl-summary ${sum.ok ? "ok" : "bad"}`;
  top.replaceChildren(h("b", {}, sum.line), ...sum.problems.map((p) => h("p", { class: "hl-problem" }, `${t(`name.${p.key}`)}: ${p.detail}`)));
  card.querySelector("details")?.toggleAttribute("open", !sum.ok);
  card.querySelector("[data-hl-title]").textContent = t("title");
  card.querySelector("[data-hl-lead]").textContent = state.on === false ? t("off") : state.quietNow ? `${t("lead")} ${t("quiet")}` : t("lead");
  const list = card.querySelector("[data-hl-list]");
  const parts = Array.isArray(state.parts) ? state.parts : [];
  list.replaceChildren(
    ...parts.map((p) => {
      const key = str(p.key);
      const status = ["ok", "failing", "down", "waiting", "warn"].includes(p.status) ? p.status : "waiting";
      const detail = key === "update"
        ? versionLine(state.bridge)
        : [line(p), status !== "ok" && key !== "claude" ? str(p.detail) : "", key === "claude" ? usageLine(state.usage) : "",
          key === "claude" ? cliLine(state.cli) : ""].filter(Boolean).join(" · ");
      const icon = h("i", { "data-lucide": ICONS[key] ?? "circle" });
      return h("div", { class: `svc ${status}` },
        h("div", { class: "name" }, icon, t(`name.${key}`), h("span", { class: "dot" })),
        h("div", { class: "detail", title: detail }, detail));
    }),
  );
  window.lucide?.createIcons?.({ attrs: { "aria-hidden": "true" } });
}

async function load() {
  try {
    const r = await fetch("/panel/api/health", { credentials: "same-origin", cache: "no-store" });
    // 404: an older server. 401: signed out (the page itself handles it).
    if (!r.ok) return;
    state = await r.json();
    // Pako's figure sleeps in the owner's quiet hours (pako-figure.js listens).
    dispatchEvent(new CustomEvent("pako:quiet", { detail: { on: state?.quietNow === true } }));
    paint();
  } catch {
    /* the server is restarting: the next load asks again */
  }
}

function mount() {
  // ONE component for how Pako is doing: inside the dashboard's system section (the old System and Health cards, merged), and in Settings,
  // General. Never two cards.
  const slot = document.querySelector('[data-mount="health"]') ?? document.querySelector("#system-card [data-hl-slot]");
  if (!slot) return;
  card = h("div", { class: "health", "aria-live": "polite", hidden: true },
    h("div", { "data-hl-summary": true }),
    h("details", {}, h("summary", { "data-hl-title": true }),
      h("p", { class: "muted", "data-hl-lead": true }),
      h("div", { class: "services", "data-hl-list": true })));
  slot.append(card);
  window.lucide?.createIcons?.({ attrs: { "aria-hidden": "true" } });
  void load();
  setInterval(() => void load(), 60_000);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
