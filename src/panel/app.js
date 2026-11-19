// Pako · panel. Reads /panel/api/overview, draws every section, animates with GSAP, refreshes itself every minute.
// Everything that comes from outside (emails, Slack, invitations) is put on the page as text, never as HTML.
// Its words are English (./i18n.js), like all of Pako's fixed texts; Claude's answers in the chat follow the language they are asked in.

import { startOrb } from "./orb.js";
import { pageFigure, tell } from "./pako-figure.js";
import { mountTwins } from "./figure-twin.js";
import { CHAT_WORDS, localeFor, WORDS } from "./i18n.js";
import { allEmpty, briefTop, cardHasContent, catchUpLine, eventTag, freshnessLine, hideWhenEmpty, kpiTiles, WORDS as DASH } from "./dashboard-model.js";
import { setMail } from "./mail.js";

const REFRESH_MS = 60_000;
const $ = (s, root = document) => root.querySelector(s);
const gsap = () => window.gsap;
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
/** Motion only when it can be seen: not for people who ask for less, and not in a hidden tab (it would stay half-drawn until shown). */
let noFrames = false;
const animate = () => !!window.gsap && !reduce && !document.hidden && !noFrames;

let data = null;
let day = "0";
let orb = null;
let firstPaint = true;
let refreshTween = null;
/** The server's clock: a phone whose clock is off still shows the right "now". */
let skew = 0;
const nowMs = () => Date.now() + skew;

// ---------- small helpers ----------

/** An element from a tag, attributes and children; text is always text. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const icon = (name) => h("i", { "data-lucide": name });
const paintIcons = () => window.lucide?.createIcons?.({ attrs: { "aria-hidden": "true" } });

// ---------- words ----------

/** Dates in English, written the way the owner's country writes them (i18n.js localeFor). */
const localeOf = () => localeFor(document.documentElement.dataset.region);

/**
 * Whether this panel has the chat in it (a person's computer): the server marks the page, so the first paint already knows. A server's panel
 * has none, and its texts name WhatsApp, as they always did.
 */
const HAS_CHAT = document.documentElement.hasAttribute("data-chat");

/** A text of the page, its {placeholders} filled from vars; one without a value stays visible, so it is noticed. */
function t(key, vars) {
  const here = HAS_CHAT && Object.hasOwn(CHAT_WORDS, key) ? CHAT_WORDS[key] : undefined;
  const s = here ?? WORDS[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m)) : s;
}

/** A text whose **parts** are bold, as nodes: nothing is parsed as HTML. */
const rich = (text) => text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? h("b", {}, part) : part));

/** The page's fixed words: the text of every element marked data-i18n, and the attributes marked data-i18n-aria and -placeholder. */
function applyStatic() {
  // The hint's icon as written in the page is a server's (a phone: the commands go by WhatsApp); with the chat here, the chat's own.
  if (HAS_CHAT) $("#sys-hint > i[data-lucide]")?.setAttribute("data-lucide", "message-circle");
  for (const el of document.querySelectorAll("[data-i18n]")) el.replaceChildren(...rich(t(el.dataset.i18n)));
  for (const el of document.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.dataset.i18nAria));
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.setAttribute("placeholder", t(el.dataset.i18nPlaceholder));
  document.documentElement.classList.add("i18n-ready");
}

// ---------- times ----------

// The owner's zone as the server sends it; before that, this browser's own (the computer Pako runs on, or the owner's).
const tz = () => data?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const fmt = (opts) => new Intl.DateTimeFormat(localeOf(), { timeZone: tz(), ...opts });
/** The numbers of a moment in the owner's time zone, for the page's own sums. */
const partsOf = (at, opts) =>
  Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz(), hourCycle: "h23", ...opts }).formatToParts(at).map((p) => [p.type, p.value]));
const hm = (at) => fmt({ hour: "2-digit", minute: "2-digit" }).format(at);
/** The day a moment falls on, as yyyy-mm-dd. */
const dayKey = (at) => {
  const p = partsOf(at, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${p.year}-${p.month}-${p.day}`;
};
const dayLabel = (at) => fmt({ weekday: "long", day: "numeric", month: "long" }).format(at);
const hourOf = (at) => {
  const p = partsOf(at, { hour: "2-digit", minute: "2-digit" });
  return Number(p.hour) + Number(p.minute) / 60;
};
/**
 * A moment on the day `i` days from today, in the owner's time zone: about noon of that day, never now + i × 24 h, which lands on the same
 * day or skips one around a change of the clocks (a day of 23 or 25 hours).
 */
const dayAt = (i) => {
  const now = nowMs();
  return now + (12 - hourOf(now)) * 3600_000 + i * 24 * 3600_000;
};

function ago(at, now = nowMs()) {
  const s = Math.round((now - at) / 1000);
  if (s < 45) return t("ago.now");
  const m = Math.round(s / 60);
  if (m < 60) return t("ago.min", { n: m });
  const hrs = Math.round(m / 60);
  if (hrs < 24) return t("ago.h", { n: hrs });
  const d = Math.round(hrs / 24);
  return d === 1 ? t("ago.yesterday") : t("ago.days", { n: d });
}
/** How long until a moment: the words ("in 5 min"), the bare span for the next meeting's big number ("5 min"), and the chip's colour. */
function until(at, now = nowMs()) {
  const m = Math.round((at - now) / 60_000);
  if (m < 0) return { text: t("until.late"), span: t("until.late"), cls: "late" };
  if (m < 1) return { text: t("until.now"), span: t("until.now"), cls: "soon" };
  if (m < 60) {
    const span = t("span.min", { n: m });
    return { text: t("until.in", { span }), span, cls: m <= 15 ? "soon" : "" };
  }
  const hrs = Math.floor(m / 60);
  if (hrs < 24) {
    const span = m % 60 ? t("span.hm", { h: hrs, m: m % 60 }) : t("span.h", { h: hrs });
    return { text: t("until.in", { span }), span, cls: "" };
  }
  const d = Math.round(hrs / 24);
  if (d === 1) return { text: t("until.tomorrow"), span: t("until.tomorrow"), cls: "" };
  const span = t("span.days", { n: d });
  return { text: t("until.in", { span }), span, cls: "" };
}

function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 2800);
}

function countUp(el, to) {
  const from = Number(el.dataset.v || 0);
  el.dataset.v = String(to);
  if (!animate()) return void (el.textContent = String(to));
  const o = { v: from };
  gsap().to(o, { v: to, duration: 1.1, ease: "power3.out", onUpdate: () => (el.textContent = String(Math.round(o.v))) });
}

// ---------- data ----------

async function load(manual = false, fresh = false) {
  const btn = $("#refresh");
  if (manual) {
    btn.classList.remove("spin");
    void btn.offsetWidth;
    btn.classList.add("spin");
  }
  try {
    if (manual || fresh) {
      try {
        window.webkit?.messageHandlers?.pako?.postMessage({ type: "calendarPush" });
      } catch {
        /* not the Mac app */
      }
    }
    const r = await fetch(`/panel/api/overview${manual || fresh ? "?fresh=1" : ""}`, { credentials: "same-origin", cache: "no-store" });
    if (r.status === 401) return void location.reload();
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data = await r.json();
    skew = data.now - Date.now();
    render();
    if (manual) toast(t("toast.updated"));
    // Telegram's state with the rest (paired from the chat, say); not while a pairing code is being watched, which asks more often.
    if (!tg.gone && !tg.timer && Date.now() - tg.checked > 30_000) void tgLoad();
  } catch (err) {
    console.error(err);
    toast(t("toast.loadFailed"));
  }
  startRefreshRing();
}

function startRefreshRing() {
  const c = $(".refresh-ring circle");
  if (!c || !gsap()) return;
  refreshTween?.kill();
  gsap().set(c, { strokeDashoffset: 100 });
  refreshTween = gsap().to(c, { strokeDashoffset: 0, duration: REFRESH_MS / 1000, ease: "none", onComplete: () => load() });
}

// ---------- header ----------

/** The greeting for the hour. */
function greeting(hour) {
  return t(hour < 5 ? "greet.late" : hour < 12 ? "greet.morning" : hour < 18 ? "greet.afternoon" : "greet.evening");
}

function renderHeader() {
  const now = data.now;
  $("#date").textContent = dayLabel(now);
  // The name the person gave (on a server, the owner's setting); none yet: what Pako calls them meanwhile.
  $("#greeting").replaceChildren(`${greeting(hourOf(now))}, `, h("span", { class: "grad" }, data.name || t("friend")));

  const today = eventsOn(dayKey(now));
  const upcoming = today.filter((e) => !e.allDay && e.end > nowMs());
  const toldMail = (data.mail?.items ?? []).filter((m) => m.category === "needs_you" && now - m.at < 24 * 3600_000).length;
  const slack = (data.slack ?? []).filter((a) => now - a.at < 24 * 3600_000).length;
  const rems = data.reminders.length;
  const parts = [];
  const n = upcoming.length;
  parts.push(n ? [h("b", {}, n === 1 ? t("sum.meeting", { n }) : t("sum.meetings", { n })), t("sum.ahead")] : [t("sum.noMeetings")]);
  if (data.mail) parts.push([h("b", {}, String(toldMail)), toldMail === 1 ? t("sum.mail") : t("sum.mails")]);
  if (data.slack) parts.push([h("b", {}, String(slack)), t("sum.slack")]);
  if (rems) parts.push([h("b", {}, String(rems)), rems === 1 ? t("sum.rem") : t("sum.rems")]);
  const sum = $("#summary");
  sum.replaceChildren(...parts.flatMap((p, i) => (i ? [i === parts.length - 1 ? t("sum.and") : ", ", ...p] : p)), ".");
  // Why, when it was not the owner: the store came back empty (a STOP may have been lost), or it cannot be read yet.
  const why = data.pauseWhy === "store-empty" ? t("why.storeEmpty") : data.pauseWhy === "store-unknown" ? t("why.storeUnknown") : "";
  if (data.paused) sum.prepend(h("b", { style: "color: var(--danger)" }, t("sum.paused", { why })), t("sum.pausedTail"));

  const sw = $("#pause");
  const active = !data.paused;
  sw.setAttribute("aria-checked", String(active));
  sw.setAttribute("aria-label", active ? t("switch.onAria") : t("switch.offAria"));
  $(".switch-label", sw).textContent = active ? t("switch.on") : t("switch.off");
  tell("paused", { on: !active }); // Pako's figure (the orb and its twins) turns its slow red
  // On a computer: the name can be changed from the footer (unless PAKO_NAME decides it).
  $("#settings-open").hidden = !(data.choose && data.choose.name);
}

function tickClock() {
  const p = partsOf(new Date(nowMs()), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  $("#clock").replaceChildren(`${p.hour}:${p.minute}`, h("span", { class: "sec" }, p.second));
}

// ---------- KPIs ----------

function renderKpis() {
  // Three tiles, Pako's one job: what the owner owes, what others owe them, today's meetings (dashboard-model.js kpiTiles). A tile whose
  // source is not connected is hidden; one at 0 says "all clear".
  const tiles = kpiTiles(data, nowMs(), data.timeZone);
  for (const [key, tile] of Object.entries(tiles)) {
    const card = document.querySelector(`[data-kpi="${key}"]`);
    if (!card) continue;
    card.hidden = !tile;
    if (!tile) continue;
    countUp($(`#kpi-${key}`), tile.n);
    const foot = $(`#kpi-${key}-foot`);
    foot.textContent = tile.foot;
    foot.classList.toggle("warn", tile.warn);
  }
}

// The other cards' scripts (lists and tasks, routines, people…) draw themselves after the page and on their own refresh: the empty rule is
// applied again whenever the grid's content changes, once per frame.
let emptyFrame = 0;
new MutationObserver(() => {
  if (emptyFrame || !data) return;
  emptyFrame = requestAnimationFrame(() => {
    emptyFrame = 0;
    applyEmptyRule();
  });
}).observe(document.getElementById("grid") ?? document.documentElement, { childList: true, subtree: true });

/** Today's brief, first on the page: read on its own (the written brief may be off: no block then). */
let briefView = null;
async function loadBriefTop() {
  try {
    const r = await fetch("/panel/api/brief/today", { credentials: "same-origin", cache: "no-store" });
    briefView = r.ok ? await r.json() : null;
  } catch {
    briefView = null;
  }
  renderBriefTop();
  applyEmptyRule();
}
function renderBriefTop() {
  const card = $("#brief-top");
  if (!card) return;
  const b = briefTop(briefView);
  card.hidden = !b;
  if (!b) return;
  $("#brief-top-title").textContent = DASH.briefTitle;
  $("#brief-top-asof").textContent = b.asOf ? DASH.briefAsOf.replace("{time}", `${dayLabel(b.asOf)} ${hm(b.asOf)}`) : "";
  $("#brief-top-headline").textContent = b.headline;
  $("#brief-top-items").replaceChildren(...b.items.map((x) => h("li", { class: `item${x.done ? " done" : ""}` },
    h("span", { class: "ic" }, icon(x.done ? "circle-check" : "circle")),
    h("div", { class: "body" }, h("div", { class: "what" }, x.title), x.sources.length ? h("div", { class: "src muted small" }, x.sources.join(" · ")) : ""))),
  ...(b.more ? [h("li", { class: "muted small" }, DASH.briefMore.replace("{n}", String(b.more)))] : []));
  $("#brief-top-open").textContent = DASH.briefOpen;
}

/** The open loops: what the owner owes first (overdue on top), then what others owe them. Hidden while there are none. */
function renderLoops() {
  const card = $("#loops");
  if (!card) return;
  const loops = (data.loops ?? []).filter((l) => l.status === "open" || l.status === "snoozed");
  const now = nowMs();
  const owes = (l) => l.kind !== "other_promise";
  const sorted = [...loops].sort((x, y) => Number(owes(y)) - Number(owes(x)) || (x.dueAt ?? Infinity) - (y.dueAt ?? Infinity));
  $("#loops-list").replaceChildren(...sorted.slice(0, 20).map((l) => h("li", { class: "item" },
    h("span", { class: "ic" }, icon(owes(l) ? "circle-dot" : "hourglass")),
    h("div", { class: "body" },
      h("div", { class: "row" }, h("span", { class: "who" }, l.title), l.dueAt ? h("span", { class: `count-chip ${l.dueAt < now ? "late" : ""}` }, until(l.dueAt, now).text) : ""),
      l.who ? h("div", { class: "what" }, l.who) : ""))));
  hideWhenEmpty(card, sorted.length > 0);
}

/**
 * The empty rule: a section with nothing in it is not shown, and comes back by itself with its first item. The tiles, the system section
 * and the welcome block decide for themselves. Nothing at all to show (a new install): only the welcome block, with the one next step.
 */
function applyEmptyRule() {
  const fixed = new Set(["system-card", "welcome-block", "loops", "brief-top"]);
  const shown = [];
  for (const card of document.querySelectorAll("#grid > section.card:not(.kpi)")) {
    if (fixed.has(card.id) || card.dataset.selfHides === "true") {
      if (card.id === "loops" || card.id === "brief-top") shown.push(!card.hidden);
      continue;
    }
    shown.push(hideWhenEmpty(card, cardHasContent(card)));
  }
  for (const k of document.querySelectorAll("#grid > .kpi")) shown.push(!k.hidden && Number($(".num", k)?.textContent ?? "0") > 0);
  const welcome = $("#welcome-block");
  const empty = allEmpty(shown);
  welcome.hidden = !empty;
  if (empty) {
    $("#welcome-title").textContent = DASH.welcomeTitle;
    $("#welcome-lead").textContent = DASH.welcomeLead;
    const next = window.pakoNextStep;
    $("#welcome-next").replaceChildren(next ? h("a", { class: "btn primary", href: next.href }, next.text, " · ", DASH.settings) : "");
  }
}

// ---------- agenda ----------

function eventsOn(key) {
  return data.events.filter((e) => {
    if (dayKey(e.start) === key) return true;
    // The days in the owner's time zone, as dayKey says them: never the browser's own (Date.parse), which may be another zone.
    return e.allDay && dayKey(e.start) <= key && dayKey(Math.max(e.start, e.end - 1)) >= key;
  });
}

/** The catch-up of a new mailbox, as one quiet line at the top while it runs (and what it left unread after). */
function renderCatchUp() {
  const box = $("#notices");
  if (!box) return;
  let el = $("#catch-up", box);
  const text = catchUpLine(data.catchUp);
  if (!text) return void el?.remove();
  if (!el) {
    el = h("span", { class: "notice", id: "catch-up", role: "status" });
    box.prepend(el);
  }
  el.textContent = text;
}

function renderAgenda() {
  const tl = $("#timeline");
  const allday = $("#allday");
  allday.replaceChildren();
  // Which calendars were read, and when: a new invitation not shown yet may simply not have reached that source (Google's links lag).
  const fresh = $("#cal-fresh");
  if (fresh) fresh.textContent = freshnessLine(data.calendarSources, nowMs());
  if (!data.calendarOn) {
    tl.replaceChildren(h("div", { class: "empty" }, icon("calendar-plus"), t("agenda.off")));
    paintIcons();
    return;
  }
  if (!data.calendarOk && !data.events.length) {
    tl.replaceChildren(h("div", { class: "empty" }, icon("calendar-x"), t("agenda.unread")));
    paintIcons();
    return;
  }
  if (day === "week") return renderWeek(tl);
  const key = dayKey(dayAt(Number(day)));
  const list = eventsOn(key);
  for (const e of list.filter((x) => x.allDay)) allday.append(h("span", { class: "pill" }, icon("sun"), e.title));
  const timed = list.filter((x) => !x.allDay).sort((a, b) => a.start - b.start);
  if (!timed.length) {
    tl.replaceChildren(h("div", { class: "empty" }, icon("coffee"), Number(day) === 0 ? t("agenda.freeToday") : t("agenda.freeTomorrow")));
    paintIcons();
    return;
  }
  const startH = Math.max(0, Math.min(7, Math.floor(Math.min(...timed.map((e) => hourOf(e.start))))));
  const endH = Math.min(24, Math.max(22, Math.ceil(Math.max(...timed.map((e) => hourOf(e.end) || 24)))));
  const px = 58;
  const inner = h("div", { class: "tl-inner", style: `height:${(endH - startH) * px + 12}px` });
  for (let hr = startH; hr <= endH; hr++) inner.append(h("div", { class: "tl-hour", style: `top:${(hr - startH) * px + 6}px` }, h("span", {}, `${String(hr % 24).padStart(2, "0")}:00`)));
  // Only events that overlap share the width: each group of overlapping events gets its own lanes.
  let group = [];
  let groupEnd = 0;
  const closeGroup = () => {
    const lanes = [];
    for (const e of group) {
      let lane = lanes.findIndex((end) => end <= e.start);
      if (lane < 0) lane = lanes.push(0) - 1;
      lanes[lane] = e.end;
      e._lane = lane;
    }
    for (const e of group) e._lanes = Math.max(1, lanes.length);
    group = [];
  };
  for (const e of timed) {
    if (group.length && e.start >= groupEnd) closeGroup();
    group.push(e);
    groupEnd = Math.max(groupEnd, e.end);
  }
  closeGroup();
  const now = nowMs();
  for (const e of timed) {
    const top = (Math.max(hourOf(e.start), startH) - startH) * px + 6;
    const endHour = dayKey(e.end) === key ? hourOf(e.end) : 24;
    const height = Math.max(34, (endHour - Math.max(hourOf(e.start), startH)) * px - 4);
    const meta = h("div", { class: "m" }, `${hm(e.start)}–${hm(e.end)}`);
    if (e.location) meta.append(h("span", {}, "· ", e.location));
    if (e.join) meta.append(h("a", { href: e.join, target: "_blank", rel: "noopener noreferrer" }, icon("video"), "Zoom"));
    if (e.clash) meta.append(h("span", { class: "warn" }, t("agenda.clash")));
    // An invitation not answered (or known only from its mail yet): tagged, so answering it is not forgotten.
    const tag = eventTag(e);
    if (tag) meta.append(h("span", { class: "tag invite" }, tag));
    inner.append(
      h("div", {
        class: `tl-event${e.clash ? " clash" : ""}${e.end < now ? " past" : ""}`,
        style: `top:${top}px;height:${height}px;left:calc(${(e._lane * 100) / e._lanes}% + 6px);width:calc(${100 / e._lanes}% - 12px)`,
        title: `${e.title} · ${hm(e.start)}–${hm(e.end)}`,
      }, h("div", { class: "t" }, e.title), meta),
    );
  }
  if (Number(day) === 0) {
    const nowH = hourOf(now);
    if (nowH >= startH && nowH <= endH) inner.append(h("div", { class: "tl-now", id: "tl-now", style: `top:${(nowH - startH) * px + 6}px` }));
  }
  tl.replaceChildren(inner);
  paintIcons();
  const nowLine = $("#tl-now");
  if (nowLine && firstPaint) tl.scrollTop = Math.max(0, nowLine.offsetTop - 120);
  if (animate()) gsap().from(".tl-event", { x: -16, opacity: 0, duration: 0.6, stagger: 0.05, ease: "power3.out" });
}

function renderWeek(tl) {
  const box = h("div", { class: "week" });
  for (let i = 0; i < 7; i++) {
    const at = dayAt(i);
    const list = eventsOn(dayKey(at)).sort((a, b) => a.start - b.start);
    if (!list.length) continue;
    box.append(
      h("div", { class: "week-day" }, h("h4", {}, i === 0 ? t("agenda.today") : i === 1 ? t("agenda.tomorrow") : dayLabel(at)),
        h("ul", { class: "list compact" }, list.map((e) =>
          h("li", { class: `item${e.clash ? " scam" : ""}` },
            h("span", { class: "ic" }, icon(e.allDay ? "sun" : e.join ? "video" : "calendar")),
            h("div", { class: "body" },
              h("div", { class: "row" }, h("span", { class: "who" }, e.title), h("span", { class: "ago" }, e.allDay ? t("agenda.allDay") : `${hm(e.start)}–${hm(e.end)}`)),
              e.location ? h("div", { class: "what" }, e.location) : null))))));
  }
  tl.replaceChildren(box.childElementCount ? box : h("div", { class: "empty" }, icon("calendar-check"), t("agenda.freeWeek")));
  paintIcons();
  if (animate()) gsap().from(".week-day", { y: 12, opacity: 0, duration: 0.5, stagger: 0.06, ease: "power2.out" });
}

function moveInk() {
  const sel = $(".tabs [aria-selected='true']");
  const ink = $(".tab-ink");
  if (!sel || !ink) return;
  ink.style.left = `${sel.offsetLeft}px`;
  ink.style.width = `${sel.offsetWidth}px`;
}

// ---------- mail ----------

function renderMail() {
  const list = $("#mail-list");
  $(".mail-top").hidden = !data.mail; // nothing to chart without a mailbox
  $("#mail-filter").hidden = !data.mail;
  if (!data.mail) {
    $("#mail-address").textContent = "";
    for (const k of ["aviso", "guardado", "masivo"]) $(`.seg-${k}`).style.opacity = "0";
    list.replaceChildren(h("li", { class: "empty" }, icon("mail-x"), t("mail.off")));
    return;
  }
  $("#mail-address").textContent = data.mail.address;
  const now = nowMs();
  const day24 = data.mail.items.filter((m) => now - m.at < 24 * 3600_000);
  // The ring's three arcs group the eight categories: on the owner (Needs you, Suspicious), worth knowing (the rest), and read in bulk.
  const n = { aviso: 0, guardado: 0, masivo: 0 };
  const arc = (c) => (c === "needs_you" || c === "suspicious" ? "aviso" : c === "read_later" || c === "promotions" ? "masivo" : "guardado");
  for (const m of day24) n[arc(m.category)]++;
  const total = day24.length || 1;
  // The ring: three arcs, one after another.
  let offset = 0;
  for (const k of ["aviso", "guardado", "masivo"]) {
    const seg = $(`.seg-${k}`);
    const len = day24.length ? (n[k] / total) * 100 : 0;
    const gap = len > 2 ? 1.6 : 0;
    seg.style.strokeDasharray = `${Math.max(0, len - gap)} ${100 - Math.max(0, len - gap)}`;
    seg.style.opacity = len > 0 ? "1" : "0"; // an empty arc would still draw a round dot
    seg.style.strokeDashoffset = String(-offset);
    offset += len;
  }
  countUp($("#ring-num"), day24.length);
  $("#mail-legend").replaceChildren(
    ...[["aviso", "Needs you", "var(--aviso)"], ["guardado", "Worth knowing", "var(--guardado)"], ["masivo", "Read later and promotions", "var(--masivo)"]].map(([k, label, color]) =>
      h("li", {}, h("i", { class: "sw", style: `background:${color}` }), label, h("b", {}, String(n[k])))),
  );
  // Per hour, the last 24.
  const bins = new Array(24).fill(0);
  for (const m of day24) bins[Math.min(23, Math.floor((now - m.at) / 3600_000))]++;
  bins.reverse();
  const max = Math.max(1, ...bins);
  const spark = $("#mail-spark");
  const ns = "http://www.w3.org/2000/svg";
  spark.replaceChildren();
  const defs = document.createElementNS(ns, "defs");
  const grad = document.createElementNS(ns, "linearGradient");
  grad.setAttribute("id", "sparkfill");
  grad.setAttribute("x1", "0");
  grad.setAttribute("y1", "0");
  grad.setAttribute("x2", "0");
  grad.setAttribute("y2", "1");
  for (const [o, c] of [["0", "#39d0ff"], ["1", "#8b7bff"]]) {
    const st = document.createElementNS(ns, "stop");
    st.setAttribute("offset", o);
    st.setAttribute("stop-color", c);
    grad.append(st);
  }
  defs.append(grad);
  spark.append(defs);
  bins.forEach((v, i) => {
    const r = document.createElementNS(ns, "rect");
    const hgt = v ? Math.max(4, (v / max) * 46) : 2;
    r.setAttribute("x", String(i * 10 + 1));
    r.setAttribute("y", String(48 - hgt));
    r.setAttribute("width", "7");
    r.setAttribute("height", String(hgt));
    r.setAttribute("opacity", v ? "1" : "0.25");
    const title = document.createElementNS(ns, "title");
    title.textContent = t("mail.bar", { n: v, h: 23 - i });
    r.append(title);
    spark.append(r);
  });
  if (animate()) gsap().from("#mail-spark rect", { scaleY: 0, duration: 0.7, stagger: 0.015, ease: "back.out(1.6)" });
  renderMailList();
}

/** The category tabs, each mail with its why, its loop and Move to… (./mail.js): every item comes with its category from the server. */
function renderMailList() {
  setMail(data.mail.items);
  if (animate()) gsap().from("#mail-list .item", { y: 10, opacity: 0, duration: 0.45, stagger: 0.035, ease: "power2.out" });
}

// ---------- the rest ----------

// The log's kinds, the English ones and the Spanish ones older lines in the store still carry (correo, calendario, pausa...).
const KIND_ICON = {
  mail: "mail", correo: "mail", slack: "hash", calendar: "calendar", calendario: "calendar", reminder: "bell", recordatorio: "bell",
  call: "phone", llamada: "phone", note: "sticky-note", nota: "sticky-note", pause: "power", pausa: "power", panel: "monitor",
  whatsapp: "message-circle", failure: "triangle-alert", fallo: "triangle-alert", blocked: "shield", bloqueado: "shield", zoom: "video",
  health: "heart-pulse", salud: "heart-pulse",
};

function renderFeed() {
  const feed = $("#feed");
  const log = data.log.slice(0, 40);
  feed.replaceChildren(
    ...(log.length
      ? log.map((l) => h("li", {}, h("span", { class: "ic" }, icon(KIND_ICON[l.kind] ?? "dot")), h("div", { class: "txt" }, l.text, h("span", { class: "ago" }, ago(l.at)))))
      : [h("li", { class: "empty" }, icon("sparkles"), t("act.empty"))]),
  );
}

function renderSlack() {
  const list = $("#slack-list");
  // Not connected: no card at all (setting it up is in Settings, Connections).
  if (!data.slack) return void list.replaceChildren();
  if (!data.slack.length) return void list.replaceChildren(h("li", { class: "empty" }, icon("message-square-dashed"), t("slack.empty")));
  list.replaceChildren(
    ...data.slack.slice(0, 12).map((a) =>
      h("li", { class: "item" }, h("span", { class: "ic" }, icon(/privado|private/.test(a.where) ? "at-sign" : "hash")),
        h("div", { class: "body" }, h("div", { class: "row" }, h("span", { class: "who" }, a.where), h("span", { class: "ago" }, ago(a.at))), h("div", { class: "what" }, a.text)))),
  );
}

function renderBookings() {
  const card = $("#bookings-card");
  card.hidden = !data.bookings;
  if (!data.bookings) return;
  const list = $("#book-list");
  const how = { pedida: t("book.pedida"), enlace: t("book.enlace") };
  if (!data.bookings.length) return void list.replaceChildren(h("li", { class: "empty" }, icon("utensils-crossed"), t("book.empty")));
  list.replaceChildren(
    ...data.bookings.map((b) => {
      const u = until(b.slot);
      return h("li", { class: "item" }, h("span", { class: "ic" }, icon(b.status === "pedida" ? "mail-check" : "link")),
        h("div", { class: "body" }, h("div", { class: "row" }, h("span", { class: "who" }, b.name), h("span", { class: `count-chip ${u.cls}` }, u.text)),
          h("div", { class: "what" }, t(b.party === 1 ? "book.lineOne" : "book.line", { day: dayLabel(b.slot), time: hm(b.slot), n: b.party, how: how[b.status] ?? b.status }))));
    }),
  );
}

function renderReminders() {
  const list = $("#rem-list");
  const items = [...data.reminders].sort((a, b) => a.at - b.at);
  if (!items.length) return void list.replaceChildren(h("li", { class: "empty" }, icon("bell-off"), t("rem.empty")));
  list.replaceChildren(
    ...items.map((r) => {
      const u = r.held ? { text: t("rem.held"), cls: "late" } : until(r.at);
      return h("li", { class: "item" }, h("span", { class: "ic" }, icon("alarm-clock")),
        h("div", { class: "body" }, h("div", { class: "row" }, h("span", { class: "who" }, r.text), h("span", { class: `count-chip ${u.cls}` }, u.text)),
          h("div", { class: "what" }, `${dayLabel(r.at)}, ${hm(r.at)}`)));
    }),
  );
}

function renderMemory() {
  const notes = $("#notes");
  notes.replaceChildren(...(data.notes.length ? data.notes.slice(0, 24).map((n) => h("span", { class: "note" }, n.text)) : [h("p", { class: "muted small" }, t("mem.empty"))]));
  const calls = $("#calls");
  const all = [...data.calls.map((c) => ({ at: c.at, text: c.summary })), ...data.happenings].sort((a, b) => b.at - a.at).slice(0, 6);
  calls.replaceChildren(...(all.length ? all.map((c) => h("li", { class: "item" }, h("span", { class: "ic" }, icon("phone-call")), h("div", { class: "body" }, h("div", { class: "what" }, c.text), h("span", { class: "ago" }, ago(c.at))))) : [h("li", { class: "muted small empty" }, t("mem.noCalls"))]));
}

const SVC_ICON = { whatsapp: "message-circle", mac: "laptop", phone: "phone", mail: "mail", calendar: "calendar", slack: "hash", zoom: "video", telegram: "send" };
function renderSystem() {
  $("#services").replaceChildren(
    ...data.integrations.map((s) => {
      const detail = s.detail;
      return h("div", { class: `svc${s.on ? "" : " off"}` }, h("div", { class: "name" }, icon(SVC_ICON[s.key] ?? "circle"), s.name, h("span", { class: "dot", style: "margin-left:auto" })), h("div", { class: "detail", title: detail }, detail));
    }),
  );
  $("#sys-updated").textContent = t("sys.updated", { time: hm(data.now) });
}

function render() {
  renderDemo();
  renderHeader();
  renderKpis();
  renderAgenda();
  renderMail();
  renderFeed();
  renderSlack();
  renderBookings();
  renderReminders();
  renderMemory();
  renderSystem();
  renderLoops();
  renderCatchUp();
  if (firstPaint || briefView === null) void loadBriefTop();
  else renderBriefTop();
  // The "Needs you" mail preview (the mail categories' block) draws itself here when its script is on the page.
  if (typeof window.pakoRenderNeedsYou === "function") window.pakoRenderNeedsYou($("#needs-you-mail"), data);
  applyEmptyRule();
  startChat();
  paintIcons();
  if (firstPaint) intro();
  // The first visit on a computer: the welcome, once the page is drawn and Telegram has answered (for its last step), or after two seconds.
  if (firstPaint && data.firstVisit) {
    void Promise.race([tgReady, new Promise((r) => setTimeout(r, 2000))]).then(() => setTimeout(() => openWelcome(true), animate() ? 700 : 0));
  }
  firstPaint = false;
  requestAnimationFrame(moveInk);
}

// ---------- motion ----------

function intro() {
  document.body.classList.remove("is-loading");
  const g = gsap();
  if (!g || !animate()) return;
  const tl = g.timeline({ defaults: { ease: "power3.out" } });
  tl.from(".orb-wrap", { scale: 0.4, opacity: 0, duration: 1.1, ease: "elastic.out(1, 0.6)" })
    .from(".hello > *", { y: 18, opacity: 0, duration: 0.7, stagger: 0.08 }, "-=0.8")
    .from(".top-actions > *", { y: -10, opacity: 0, duration: 0.5, stagger: 0.06 }, "-=0.6")
    .from(".card", { y: 28, opacity: 0, scale: 0.98, duration: 0.8, stagger: 0.06 }, "-=0.45")
    .from(".feed li", { x: -12, opacity: 0, duration: 0.4, stagger: 0.03 }, "-=0.5")
    .from(".note", { scale: 0.85, opacity: 0, duration: 0.4, stagger: 0.03, ease: "back.out(2)" }, "<");
}

/** The card's border follows the pointer, and the card leans a little towards it (desktop only). */
function pointerGlow() {
  if (reduce || matchMedia("(hover: none)").matches) return;
  for (const card of document.querySelectorAll(".card")) {
    card.addEventListener("pointermove", (e) => {
      const r = card.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      card.style.setProperty("--mx", `${x}px`);
      card.style.setProperty("--my", `${y}px`);
      if (card.classList.contains("kpi") && gsap()) gsap().to(card, { rotateX: ((y / r.height) - 0.5) * -6, rotateY: ((x / r.width) - 0.5) * 6, transformPerspective: 700, duration: 0.4 });
    });
    card.addEventListener("pointerleave", () => card.classList.contains("kpi") && gsap()?.to(card, { rotateX: 0, rotateY: 0, duration: 0.6, ease: "elastic.out(1, 0.5)" }));
  }
}

// ---------- events ----------

function wire() {
  $("#refresh").addEventListener("click", () => load(true));
  for (const b of document.querySelectorAll(".tabs button")) {
    b.addEventListener("click", () => {
      for (const o of document.querySelectorAll(".tabs button")) o.setAttribute("aria-selected", String(o === b));
      day = b.dataset.day;
      moveInk();
      renderAgenda();
    });
  }
  $("#pause").addEventListener("click", async () => {
    if (!data) return;
    const pausing = !data.paused;
    if (pausing && !confirm(t("stop.confirm"))) return;
    try {
      const r = await fetch("/panel/api/pause", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-pako": "1" }, body: JSON.stringify({ on: pausing }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      data.paused = j.paused;
      data.pauseWhy = j.why ?? null;
      renderHeader();
      toast(pausing ? t("toast.paused") : t("toast.running"));
      if (animate()) gsap().fromTo(".orb-wrap", { scale: 0.9 }, { scale: 1, duration: 0.9, ease: "elastic.out(1, 0.4)" });
    } catch {
      toast(t("toast.cantChange"));
    }
  });
  $("#settings-open").addEventListener("click", () => openWelcome(false));
  addEventListener("resize", moveInk);
  document.addEventListener("visibilitychange", () => {
    // Back after two minutes or more: the calendars are read again too (a new invitation shows without pressing refresh).
    if (!document.hidden && data && nowMs() - data.now > 30_000) load(false, nowMs() - data.now > 2 * 60_000);
    if (!document.hidden) renderTg(); // a pairing code may have run out while the tab was hidden
  });
  // Every minute the relative times and the now-line move on, between refreshes.
  setInterval(() => {
    if (!data) return;
    renderFeed();
    renderReminders();
    renderKpis();
    paintIcons();
  }, 30_000);
}

// ---------- start ----------

/** If the browser gives no animation frames (a page out of sight, some embedded views), every animation is finished at once: never half-drawn. */
function watchFrames() {
  let seen = false;
  requestAnimationFrame(() => (seen = true));
  setTimeout(() => {
    if (seen) return;
    noFrames = true;
    window.gsap?.globalTimeline.getChildren(true, true, true).forEach((tw) => tw.progress(1));
    document.body.classList.remove("is-loading");
  }, 1500);
}

// ---------- chat (local mode: the chat window is here, not on WhatsApp) ----------

const chat = { on: false, open: false, last: 0, waiting: 0, read: { at: 0, n: 0 }, messages: [], timer: null, busy: false, epoch: "", trouble: "", misses: 0 };
const SAFE_URL = /(https?:\/\/[^\s<>"')]+)/g;

// What keeps Pako from answering on this computer, and what to do about it: said in the chat itself, so a message never waits with no word.
// The server tells the state (src/local.ts, BridgeStatus): the claude command is missing, Claude is not signed in or out of its limit (as the
// assistant found when it last ran it), or the assistant stops right after it starts. When the server itself stops answering, this page says so.
function chatTrouble(status) {
  if (!status) return "";
  if (status.claude === "missing") return "missing";
  if (status.failing) return "failing";
  return status.claude === "login" || status.claude === "limit" ? status.claude : "";
}

// Claude missing or signed out: one calm line and the one button that fixes it (the connections page's Claude card, src/claude-connect.ts).
const claudeLink = (label) => h("a", { class: "banner-action", href: "/panel/settings#claude" }, label);
const BANNERS = {
  missing: () => [
    h("b", {}, "Pako needs Claude to think. "),
    claudeLink("Connect your Claude account"),
  ],
  login: () => [
    h("b", {}, "Claude needs you to sign in again. "),
    claudeLink("Connect your Claude account"),
  ],
  limit: () => [
    h("b", {}, "Claude has reached its usage limit for now: "),
    "your message waits and will be answered by itself when the limit resets. Nothing to do.",
  ],
  failing: () => [
    h("b", {}, "Pako's assistant can't start. "),
    "The terminal where you typed ",
    h("code", {}, "npm start"),
    " says why (usually a setting in ",
    h("code", {}, "~/.pako/.env"),
    "): fix it and start Pako again.",
  ],
  offline: () => [
    h("b", {}, "Pako isn't answering. "),
    "Did the terminal where you typed ",
    h("code", {}, "npm start"),
    " close? Start it again in the Pako folder: this window will catch up by itself.",
  ],
};
const STATUS_LINE = { missing: "no brain yet", login: "Claude: sign in again", limit: "waiting: Claude's limit", failing: "assistant stopped", offline: "offline" };

/** Shows what keeps Pako from answering ("" for nothing); says whether the newest message was in view before the banner moved the log. */
function showTrouble(trouble) {
  const log = $("#chat-log");
  // The banner coming or going moves the log's top edge: whether the newest message was in view is measured before, so it stays in view.
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const banner = $("#chat-banner");
  banner.hidden = !trouble;
  // Drawn again only when it changes: the poll comes every second and a half, and a link being pressed must not be swapped
  // under the pointer.
  if (trouble && trouble !== chat.trouble) tell("error"); // a short shake when something new keeps Pako from answering
  if (trouble !== chat.trouble) banner.replaceChildren(...(trouble ? BANNERS[trouble]() : []));
  chat.trouble = trouble;
  $("#chat-status").textContent = trouble ? STATUS_LINE[trouble] : chat.waiting ? t("chat.typing") : t("chat.online");
  return stick;
}

/** Text with line breaks and links, built from nodes: nothing the assistant or a restaurant wrote is ever parsed as HTML. */
function richText(text) {
  const out = [];
  for (const part of String(text).split(SAFE_URL)) {
    if (/^https?:\/\//.test(part)) out.push(h("a", { href: part, target: "_blank", rel: "noopener noreferrer" }, part.length > 48 ? `${part.slice(0, 45)}…` : part));
    else out.push(part);
  }
  return out;
}

function chatBubble(m) {
  const buttons = (m.buttons ?? []).map((b) =>
    h("button", { class: "chat-btn", type: "button", "data-id": b.id, onclick: (e) => pressChat(e.currentTarget, b.id) }, b.title),
  );
  return h("div", { class: `bubble ${m.who === "you" ? "you" : "pako"}`, "data-n": String(m.n) },
    h("div", { class: "bubble-text" }, ...richText(m.text)),
    buttons.length ? h("div", { class: "bubble-actions" }, ...buttons) : null,
    // A copy of something Pako started and sent to the phone (a reminder, a notice): said so, as it was not written here.
    m.via === "telegram" ? h("div", { class: "bubble-via" }, t("chat.viaTelegram"))
      : m.via === "whatsapp" ? h("div", { class: "bubble-via" }, t("chat.viaWhatsapp")) : null,
    h("span", { class: "bubble-time" }, hm(m.at)));
}

// Where the owner stopped reading: the newest message shown while the window was open. Kept by its time as well as its number, in this
// browser, so a reload, a restart of Pako, or numbers starting again (a lost chat file) never turn old answers into new ones.
const READ_KEY = "pako-chat-read";
const isRead = (m) => m.at < chat.read.at || (m.at === chat.read.at && m.n <= chat.read.n);

function loadRead() {
  try {
    const r = JSON.parse(localStorage.getItem(READ_KEY) ?? "null");
    if (r && Number.isFinite(r.at) && Number.isFinite(r.n)) chat.read = { at: r.at, n: r.n };
  } catch {
    /* no storage, or something unreadable in it: everything counts as new once */
  }
}

function markRead() {
  const last = chat.messages.at(-1);
  if (!last || isRead(last)) return;
  chat.read = { at: last.at, n: last.n };
  try {
    localStorage.setItem(READ_KEY, JSON.stringify(chat.read));
  } catch {
    /* no storage: it is remembered until the page is closed */
  }
}

/** `stick`: whether the newest message was in view before something above the log (the banner) moved its edge; measured here when not given. */
function renderChat(stick) {
  const log = $("#chat-log");
  const atEnd = stick ?? log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const known = new Set([...log.querySelectorAll(".bubble")].map((b) => b.dataset.n));
  for (const m of chat.messages) if (!known.has(String(m.n))) log.append(chatBubble(m));
  log.querySelector(".typing")?.remove();
  if (chat.waiting) log.append(h("div", { class: "bubble pako typing", "aria-label": t("chat.typingAria") }, h("i"), h("i"), h("i")));
  if (atEnd || known.size === 0) log.scrollTop = log.scrollHeight;
  if (chat.open) markRead();
  const unread = chat.open ? 0 : chat.messages.filter((m) => m.who === "pako" && !isRead(m)).length;
  const badge = $("#chat-unread");
  badge.hidden = unread === 0;
  badge.textContent = String(unread);
  renderWelcomeReply();
}

async function pollChat() {
  if (!chat.on || chat.busy) return;
  chat.busy = true;
  let reached = false;
  try {
    const r = await fetch(`/panel/api/chat?since=${chat.last}`, { credentials: "same-origin", cache: "no-store" });
    reached = true;
    if (r.status === 401) return void location.reload();
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.json();
    if (chat.epoch && body.epoch !== chat.epoch) {
      // The server started again: the ids it hands out may not continue ours. Start from the top (one more request).
      chat.epoch = body.epoch;
      chat.messages = [];
      chat.last = 0;
      $("#chat-log").replaceChildren();
      chat.busy = false;
      return void pollChat();
    }
    const primed = !!chat.epoch; // the first answer brings what was said before: Pako's figure does not say all of that again
    chat.epoch = body.epoch;
    let said = 0;
    for (const m of body.messages) {
      chat.messages.push(m);
      chat.last = Math.max(chat.last, m.n);
      if (m.who === "pako") {
        chat.waiting = 0;
        if (primed) said += String(m.text ?? "").length;
      }
    }
    if (said) tell("answer", { length: said });
    if (chat.waiting && Date.now() - chat.waiting > 240_000) chat.waiting = 0;
    if (!said) tell("waiting", { on: !!chat.waiting });
    chat.misses = 0;
    renderChat(showTrouble(chatTrouble(body.status)));
  } catch (err) {
    console.warn("chat", err);
    // No answer at all, twice in a row (an answer with an error is not this): Pako itself has stopped, its terminal closed most likely.
    if (!reached && ++chat.misses >= 2) renderChat(showTrouble("offline"));
  } finally {
    chat.busy = false;
  }
}

/** How often the chat is asked for news: often while it is open (or while the welcome shows Pako's answers), seldom otherwise. */
function chatPace() {
  clearInterval(chat.timer);
  chat.timer = setInterval(pollChat, chat.open || welcome.open ? 1500 : 6000);
}

function setChatOpen(open) {
  chat.open = open;
  const box = $("#chat");
  box.hidden = false;
  box.classList.toggle("open", open);
  $("#chat-fab").setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("chat-open", open);
  box.toggleAttribute("inert", !open); // a closed chat is not focusable and not read out by a screen reader
  if (open) {
    renderChat();
    requestAnimationFrame(() => {
      const log = $("#chat-log");
      log.scrollTop = log.scrollHeight; // shown now, so it can be measured: the newest message is the one in view
    });
    setTimeout(() => $("#chat-input").focus(), 120);
    try {
      localStorage.setItem("pako-chat-seen", "1");
    } catch {
      /* no storage: it simply opens again next time */
    }
  }
  else if (document.activeElement && box.contains(document.activeElement)) $("#chat-fab").focus();
  chatPace();
}

async function sendChat(text) {
  chat.waiting = Date.now();
  tell("sent");
  try {
    const r = await fetch("/panel/api/chat", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-pako": "1" }, body: JSON.stringify({ text }) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (err) {
    chat.waiting = 0;
    tell("error");
    // Not lost: back in the box, so one press of send tries again.
    const input = $("#chat-input");
    if (!input.value) input.value = text;
    toast(t("toast.sendFailed"));
    console.warn(err);
    return false;
  } finally {
    pollChat();
  }
  return true;
}

async function pressChat(button, id) {
  for (const b of button.parentElement.querySelectorAll("button")) b.disabled = true;
  button.classList.add("chosen");
  chat.waiting = Date.now();
  tell("sent");
  try {
    const r = await fetch("/panel/api/chat/press", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-pako": "1" }, body: JSON.stringify({ id }) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (err) {
    chat.waiting = 0;
    tell("error");
    for (const b of button.parentElement.querySelectorAll("button")) {
      b.disabled = false;
      b.classList.remove("chosen");
    }
    toast(t("toast.sendFailed"));
    console.warn(err);
  }
  pollChat();
}

function wireChat() {
  $("#chat-fab").addEventListener("click", () => setChatOpen(!chat.open));
  $("#chat-close").addEventListener("click", () => setChatOpen(false));
  const input = $("#chat-input");
  const grow = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  };
  input.addEventListener("input", grow);
  // Pako's figure listens while the owner writes (and leans towards the box).
  const typing = () => tell("typing", { on: document.activeElement === input && input.value.trim() !== "" });
  input.addEventListener("input", typing);
  input.addEventListener("focus", typing);
  input.addEventListener("blur", typing);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $("#chat-form").requestSubmit();
    }
  });
  $("#chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    grow();
    tell("typing", { on: false });
    sendChat(text);
  });
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && chat.open && !welcome.open) setChatOpen(false);
  });
}

/** Called after each overview: the window exists only when the server has one (local mode). */
function startChat() {
  if (chat.on || !data?.chat) return;
  chat.on = true;
  $("#chat-fab").hidden = false;
  wireChat();
  let first = true;
  try {
    first = !localStorage.getItem("pako-chat-seen");
  } catch {
    /* no storage */
  }
  loadRead();
  // Read in another tab of the panel: the count here follows.
  addEventListener("storage", (e) => {
    if (e.key !== READ_KEY) return;
    loadRead();
    renderChat();
  });
  pollChat().then(() => setChatOpen(first || window.innerWidth >= 1000));
}

// ---------- Telegram: a second chat in the phone (its server side answers /panel/api/telegram; without it, the card stays hidden) ----------

const TG_LINK_MS = 10 * 60_000;
const tg = {
  /** null until the first answer; false when this server has no Telegram card (404) or could not say. */
  available: null,
  /** The server answered 404: it has no such route, so it is not asked again. */
  gone: false,
  state: "",
  bot: "",
  account: "",
  /** With no usable bot: the server's sentence on why the one there cannot be used here (its messages go to a server, or to another Pako). */
  why: "",
  /** A setting decides the bot (TELEGRAM_BOT_TOKEN): the card does not offer another. */
  fixed: false,
  /** "Use another bot" was pressed: the steps are on show although a bot is set, until one connects or the person goes back. */
  other: false,
  /** The one-time pairing link on show, its QR, and when it was made (it works for 10 minutes). */
  link: "",
  svg: "",
  linkAt: 0,
  busy: false,
  error: "",
  /** The three steps are open (always in the welcome; after a press on the card). */
  expanded: false,
  timer: null,
  /** When the server was last asked. */
  checked: 0,
  sig: "",
  /** One body, moved between the card and the welcome's last step, so what was typed and the pairing in progress go with it. */
  el: null,
  input: null,
};
let tgReady = Promise.resolve();

async function tgCall(path, body) {
  const init = body === undefined
    ? { credentials: "same-origin", cache: "no-store" }
    : { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-pako": "1" }, body: JSON.stringify(body) };
  const r = await fetch(`/panel/api/telegram${path}`, init);
  if (r.status === 401) {
    location.reload();
    throw new Error("signed out");
  }
  return r;
}

async function tgLoad() {
  tg.checked = Date.now();
  let paired = false;
  try {
    const r = await tgCall("");
    if (r.status === 404) {
      tg.available = false;
      tg.gone = true;
      return void renderTg();
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const s = await r.json();
    const was = tg.state;
    tg.available = true;
    tg.state = s.state === "paired" || s.state === "unpaired" ? s.state : "no-token";
    tg.bot = typeof s.bot === "string" ? s.bot.slice(0, 64) : "";
    tg.account = typeof s.account === "string" ? s.account.slice(0, 80) : "";
    tg.why = tg.state === "no-token" && typeof s.why === "string" ? s.why.trim().slice(0, 400) : "";
    tg.fixed = s.fixed === true;
    if (tg.state === "no-token" || tg.fixed) tg.other = false;
    if (tg.state !== "unpaired") {
      paired = tg.state === "paired" && was === "unpaired" && !!tg.link;
      if (paired) {
        toast(t("tg.pairedToast"));
        tell("happy");
        if (animate()) gsap().fromTo(".w-orb, .orb-wrap", { scale: 0.85 }, { scale: 1, duration: 0.9, ease: "elastic.out(1, 0.4)" });
      }
      tg.link = "";
      tg.svg = "";
      clearInterval(tg.timer);
      tg.timer = null;
    }
  } catch (err) {
    console.warn("telegram", err);
    if (tg.available === null) tg.available = false;
  }
  renderTg();
  welcomeTexts();
  // Paired from the welcome: what is left is to finish it.
  if (paired && welcome.open && tg.el.contains(document.activeElement)) $("#w-next").focus();
}

/** A bot token out of what was pasted (the whole BotFather message will do); "" when there is none. */
function tokenFrom(text) {
  const s = String(text ?? "").trim();
  return /\d{5,}:[A-Za-z0-9_-]{30,}/.exec(s)?.[0] ?? (/^\S+:\S{20,}$/.test(s) ? s : "");
}

async function tgToken(raw) {
  const token = tokenFrom(raw);
  if (!token) {
    tg.error = t("tg.tokenBad");
    renderTg();
    tg.input.focus();
    return;
  }
  tg.busy = true;
  tg.error = "";
  renderTg();
  try {
    const r = await tgCall("/token", { token });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok !== true) tg.error = typeof j.error === "string" && j.error.trim() ? j.error.trim().slice(0, 300) : t("tg.tokenFailed");
    else {
      tg.input.value = "";
      tg.busy = false;
      tg.other = false;
      // Taken: the bot exists now, even if the next look at the state goes astray.
      tg.state = "unpaired";
      if (typeof j.bot === "string") tg.bot = j.bot.slice(0, 64);
      await tgLoad();
      // The person is in the middle of it: the code to scan comes at once.
      if (tg.state === "unpaired") await tgLink();
    }
  } catch (err) {
    console.warn("telegram", err);
    tg.error = t("tg.failed");
  } finally {
    tg.busy = false;
    renderTg();
  }
  if (tg.error) tg.input.focus();
}

async function tgLink() {
  if (tg.busy) return;
  tg.busy = true;
  renderTg();
  try {
    const r = await tgCall("/link", {});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      // The server says why in a sentence: no token any more (409), or Telegram not answering (502).
      const said = (r.status === 409 || r.status === 502) && typeof j.error === "string" ? j.error.trim().slice(0, 300) : "";
      toast(said || t("tg.failed"));
      // No token any more (Telegram revoked it): the card asks for a new one.
      if (r.status === 409) void tgLoad();
      return;
    }
    if (typeof j.link !== "string" || !/^https:\/\/\S+$/.test(j.link)) throw new Error("no link");
    tg.link = j.link;
    // The QR is put in an image (data: URL), never into the page as markup: an SVG in an <img> cannot run anything.
    tg.svg = typeof j.svg === "string" && /^\s*<svg[\s>]/.test(j.svg) ? j.svg : "";
    tg.linkAt = Date.now();
    clearInterval(tg.timer);
    tg.timer = setInterval(() => {
      if (tg.state !== "unpaired" || !tg.link || Date.now() - tg.linkAt > TG_LINK_MS) {
        clearInterval(tg.timer);
        tg.timer = null;
        return void renderTg();
      }
      if (!document.hidden) void tgLoad();
    }, 3000);
  } catch (err) {
    console.warn("telegram", err);
    toast(t("tg.failed"));
  } finally {
    tg.busy = false;
    renderTg();
  }
}

async function tgOff() {
  if (!confirm(t("tg.offConfirm"))) return;
  try {
    const r = await tgCall("/off", {});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    toast(t("tg.offDone"));
  } catch (err) {
    console.warn("telegram", err);
    toast(t("tg.failed"));
  }
  await tgLoad();
}

function tgView() {
  if (!tg.available) return "hidden";
  if (tg.other && tg.state !== "no-token") return "steps";
  if (tg.state === "paired") return "paired";
  if (tg.state === "unpaired") return !tg.link ? "ready" : Date.now() - tg.linkAt > TG_LINK_MS ? "expired" : "code";
  // A bot that cannot be used here: straight to the steps, with the reason above them.
  return tg.expanded || tg.why ? "steps" : "intro";
}

function tgBody(view) {
  const lead = h("p", { class: "tg-lead" }, t("tg.lead"));
  const ready = h("p", {}, tg.bot ? t("tg.ready", { bot: tg.bot }) : t("tg.readyPlain"));
  const button = (cls, label, ic, onclick) => h("button", { type: "button", class: `btn ${cls}`, disabled: tg.busy, onclick }, icon(ic), label);
  // The way to another bot once one is set (the wrong one was pasted, or a new one is wanted); not when a setting decides the bot.
  const other = tg.fixed ? null
    : h("button", { type: "button", class: "tg-other", disabled: tg.busy, onclick: () => ((tg.other = true), (tg.error = ""), renderTg(), tg.input.focus()) }, t("tg.otherBot"));
  if (view === "intro") return [lead, button("primary", t("tg.setup"), "send", () => ((tg.expanded = true), renderTg(), tg.input.focus()))];
  if (view === "steps") {
    const form = h("form", { class: "tg-form", onsubmit: (e) => (e.preventDefault(), void tgToken(tg.input.value)) },
      tg.input, h("button", { type: "submit", class: "btn primary", disabled: tg.busy }, tg.busy ? t("tg.connecting") : t("tg.connect")));
    return [
      tg.why && !tg.other ? h("p", { class: "tg-error", role: "alert" }, tg.why) : null,
      lead,
      h("ol", { class: "tg-steps" },
        h("li", {}, h("p", {}, ...rich(t("tg.step1"))),
          h("div", { class: "tg-qr-row" },
            h("img", { class: "tg-qr small", src: "/panel/assets/botfather.svg", alt: t("tg.qrBotFather"), width: 120, height: 120 }),
            h("a", { class: "btn ghost", href: "https://t.me/BotFather", target: "_blank", rel: "noopener noreferrer" }, icon("external-link"), t("tg.openBotFather")))),
        h("li", {}, h("p", {}, ...rich(t("tg.step2")))),
        h("li", {}, h("label", { for: "tg-token" }, t("tg.step3")), form, tg.error ? h("p", { class: "tg-error", role: "alert" }, tg.error) : null)),
      tg.other ? button("ghost", t("tg.keepBot"), "undo-2", () => ((tg.other = false), (tg.error = ""), renderTg())) : null,
    ].filter(Boolean);
  }
  if (view === "ready") return [ready, button("primary", t("tg.showCode"), "qr-code", () => void tgLink()), other].filter(Boolean);
  if (view === "code") {
    return [
      ready,
      h("div", { class: "tg-code" },
        tg.svg ? h("img", { class: "tg-qr", src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(tg.svg)}`, alt: t("tg.qr"), width: 196, height: 196 }) : null,
        h("div", { class: "tg-code-side" },
          h("p", { class: "muted small" }, t("tg.orLink")),
          h("a", { class: "tg-link", href: tg.link, target: "_blank", rel: "noopener noreferrer" }, tg.link),
          h("p", { class: "muted small" }, t("tg.expires")),
          h("p", { class: "tg-wait", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), t("tg.waiting")))),
      other,
    ].filter(Boolean);
  }
  if (view === "expired") return [h("p", {}, t("tg.expired")), button("primary", t("tg.newCode"), "refresh-cw", () => void tgLink()), other].filter(Boolean);
  if (view === "paired") {
    const said = !tg.account ? t("tg.pairedPlain") : tg.bot ? t("tg.pairedBot", { account: tg.account, bot: tg.bot }) : t("tg.paired", { account: tg.account });
    return [h("p", { class: "tg-ok" }, icon("circle-check"), said), button("ghost", t("tg.off"), "unlink", () => void tgOff()), other].filter(Boolean);
  }
  return [];
}

/** Draws the Telegram body for its state, only when something it shows has changed (a half-typed token, and the QR, stay put). */
function renderTg() {
  if (!tg.el) return;
  const view = tgView();
  $("#tg-card").hidden = true;
  $("#tg-state").textContent = !tg.available ? "" : t(tg.state === "paired" ? "tg.state.paired" : tg.state === "unpaired" ? "tg.state.unpaired" : "tg.state.none");
  const sig = [view, tg.bot, tg.account, tg.link, tg.busy, tg.error, tg.why, tg.fixed, tg.other].join("|");
  if (sig === tg.sig) return;
  tg.sig = sig;
  const had = tg.el.contains(document.activeElement);
  tg.el.replaceChildren(...tgBody(view));
  paintIcons();
  // A press that changed the view leaves the focus on something that is gone: it goes to the token field, or to the first thing to press;
  // while there is none (a request on its way), the body itself keeps it, so it is never dropped on the page behind.
  // Once paired, never on Disconnect: the next Enter must not be the one that undoes it.
  if (had && (document.activeElement === tg.el || !tg.el.contains(document.activeElement))) {
    const target = view === "steps" ? tg.input : view === "paired" ? null : tg.el.querySelector("button:not([disabled]), a");
    (target ?? tg.el).focus();
  }
}

/** Puts the Telegram body in the card or in the welcome. */
function placeTg(slot) {
  if (!tg.el || !slot || tg.el.parentElement === slot) return;
  slot.append(tg.el);
  tg.sig = "";
  renderTg();
}

// ---------- the welcome: the first visit on a computer ----------

const welcome = { open: false, first: false, steps: [], i: 0, watch: "", replySig: "", finishing: false, saving: Promise.resolve(true) };

/**
 * The steps this time: on the first visit, the demo week or the person's own (where the server offers the demo); what a setting already
 * decides is not asked (overview.choose), and Telegram only where the server has it.
 */
function welcomeSteps(first) {
  const c = data?.choose ?? { name: false };
  const start = first && data?.demo && !data.demo.on ? ["start"] : [];
  return [...start, ...(c.name ? ["name"] : []), ...(first ? ["try", ...(tg.available ? ["phone"] : [])] : [])];
}

/** `first`: the first visit (everything, and it ends the welcome for good); otherwise from the footer, for the name. */
function openWelcome(first) {
  const dlg = $("#welcome");
  if (welcome.open || !data?.choose) return;
  const steps = welcomeSteps(first);
  if (typeof dlg.showModal !== "function" || !steps.length) {
    // A browser with no dialogs, or nothing to ask: the first visit still counts as done, so the chat says hello.
    if (first) void saveSettings({ welcomed: true });
    return;
  }
  Object.assign(welcome, { open: true, first, steps, i: 0, watch: "", replySig: "", finishing: false, saving: Promise.resolve(true) });
  $("#w-name").value = data.name || "";
  for (const b of dlg.querySelectorAll(".w-sugg")) {
    b.classList.remove("sent");
    b.removeAttribute("aria-disabled");
    b.querySelector(".w-sent")?.remove();
  }
  $("#w-skip").dataset.i18n = first ? "w.skip" : "w.close";
  $("#w-dots").replaceChildren(...steps.map(() => h("li")));
  applyStatic();
  dlg.showModal();
  document.body.classList.add("welcoming");
  chatPace();
  showStep(0);
}

function showStep(i) {
  const dlg = $("#welcome");
  welcome.i = Math.max(0, Math.min(i, welcome.steps.length - 1));
  const name = welcome.steps[welcome.i];
  for (const s of dlg.querySelectorAll(".w-step")) s.hidden = s.dataset.step !== name;
  dlg.setAttribute("aria-labelledby", `w-title-${name}`);
  dlg.setAttribute("aria-describedby", "w-progress");
  [...$("#w-dots").children].forEach((dot, k) => {
    dot.classList.toggle("on", k === welcome.i);
    dot.classList.toggle("done", k < welcome.i);
  });
  // The Telegram body goes where it is seen: in the last step, with its three steps open and, once there is a bot, its code to scan.
  if (name === "phone") {
    tg.expanded = true;
    placeTg($("#w-tg-slot"));
    if (tg.state === "unpaired" && !tg.link) void tgLink();
  } else placeTg($("#tg-slot"));
  // Past "about you": what was chosen is saved now, so the chat's hello comes with that name, before anything is tried.
  if (name === "try") welcome.saving = saveSettings(aboutYou());
  welcomeTexts();
  const step = $(`.w-step[data-step="${name}"]`, dlg);
  if (animate()) gsap().fromTo(step, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.45, ease: "power3.out" });
  // The focus goes to what this step asks for (the name); otherwise to its title, so a screen reader says where it is.
  const target = name === "name" ? $("#w-name") : $(`#w-title-${name}`);
  // The start step is a choice of its own: its two buttons, no Continue.
  $("#w-next").hidden = name === "start";
  target?.focus();
}

/** The welcome's words that depend on the moment: the try step's title (with the name), the progress, the main button. */
function welcomeTexts() {
  if (!welcome.open) return;
  const typed = welcome.steps.includes("name") ? $("#w-name").value.replace(/\s+/g, " ").trim() : data?.name ?? "";
  $("#w-title-try").textContent = typed ? t("w.try.title", { name: typed }) : t("w.try.titlePlain");
  $("#w-progress").textContent = t("w.progress", { n: welcome.i + 1, total: welcome.steps.length });
  $("#w-back").hidden = welcome.i === 0;
  const last = welcome.i === welcome.steps.length - 1;
  const next = $("#w-next");
  next.dataset.i18n = !last ? "w.next" : welcome.steps[welcome.i] === "phone" && tg.state !== "paired" ? "w.later" : "w.done";
  next.textContent = t(next.dataset.i18n);
  renderWelcomeReply();
}

/** What was chosen in the steps shown: the name. */
function aboutYou() {
  const out = {};
  if (welcome.steps.includes("name")) out.name = $("#w-name").value.replace(/\s+/g, " ").trim().slice(0, 40);
  return out;
}

/** Saves the person's choices on this computer (POST /panel/api/settings); the answer is what now holds. False when it could not. */
async function saveSettings(body) {
  try {
    const r = await fetch("/panel/api/settings", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-pako": "1" }, body: JSON.stringify(body) });
    if (r.status === 401) {
      location.reload();
      return false;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (data) {
      if (typeof j.name === "string") data.name = j.name;
      if (body.welcomed) data.firstVisit = false;
      renderHeader();
    }
    // The chat's hello may have just been said: shown without waiting for the next poll.
    void pollChat();
    return true;
  } catch (err) {
    console.warn("settings", err);
    toast(t("w.saveFailed"));
    return false;
  }
}

/**
 * The Mac app (desktop/mac) hears the welcome as it happens: {lang} once its first step is passed (the app opens its Connect Claude window only
 * then, not over a welcome that has not said hello; the language is always English now, the field stays because the app waits for it), and
 * the end. Anywhere else there is no such handler.
 */
function tellApp(message) {
  try {
    window.webkit?.messageHandlers?.pako?.postMessage(message);
  } catch {
    /* not in the app */
  }
}

async function welcomeNext() {
  if (welcome.i === 0) tellApp({ lang: "en" });
  if (welcome.i < welcome.steps.length - 1) return showStep(welcome.i + 1);
  await finishWelcome();
}

/** Done (or skipped on the first visit): everything chosen is saved, and the first visit never comes back. */
async function finishWelcome() {
  if (welcome.finishing) return; // a second press (or Escape) while the first one is being saved
  welcome.finishing = true;
  const first = welcome.first;
  const saved = await saveSettings({ ...aboutYou(), ...(first ? { welcomed: true } : {}) }).finally(() => (welcome.finishing = false));
  if (saved) tellApp({ lang: "en", ...(first ? { welcomed: true } : {}) });
  // A change of name from the footer that did not take: the dialog stays, to try again (unless the browser closed it already).
  if (!saved && !first && $("#welcome").open) return;
  closeWelcome();
  if (first && chat.on) {
    setChatOpen(true);
    toast(t("w.doneToast"));
  }
}

/** Closed from the footer without saving. */
function cancelWelcome() {
  closeWelcome();
}

function closeWelcome() {
  const dlg = $("#welcome");
  welcome.open = false;
  placeTg($("#tg-slot"));
  if (dlg.open) dlg.close();
  document.body.classList.remove("welcoming");
  chatPace();
}

/** Under the suggestions: what was sent, then Pako's answer as it arrives (the same messages as the chat). */
function renderWelcomeReply() {
  const box = $("#w-reply");
  if (!welcome.open || !welcome.watch) {
    if (box.childElementCount) box.replaceChildren();
    welcome.replySig = "";
    return;
  }
  const mine = chat.messages.findLastIndex((m) => m.who === "you" && m.text === welcome.watch);
  const answer = mine >= 0 ? chat.messages.slice(mine + 1).filter((m) => m.who === "pako").at(-1) : undefined;
  // Drawn again only when something changed: a polite live region would otherwise read it out at every poll.
  const sig = [welcome.watch, answer?.n ?? "", chat.trouble].join("|");
  if (sig === welcome.replySig) return;
  welcome.replySig = sig;
  box.replaceChildren(
    h("div", { class: "w-msg you" }, h("b", {}, t("w.try.you")), welcome.watch),
    answer
      ? h("div", { class: "w-msg pako" }, h("b", {}, "Pako"), h("span", {}, ...richText(answer.text)))
      : h("div", { class: "w-msg pako wait" }, h("span", { class: "spinner", "aria-hidden": "true" }), chat.trouble ? t("w.try.waiting") : t("w.try.thinking")),
  );
}

/** A suggestion pressed: the real message goes to the chat, once, and its answer shows below. */
async function trySay(button) {
  if (button.classList.contains("sent")) return;
  const text = t(button.dataset.say);
  button.classList.add("sent");
  button.setAttribute("aria-disabled", "true");
  button.append(h("span", { class: "w-sent", "data-i18n": "w.try.sent" }, t("w.try.sent")));
  welcome.watch = text;
  renderWelcomeReply();
  await welcome.saving; // the hello first, then this
  if (!(await sendChat(text))) {
    button.classList.remove("sent");
    button.removeAttribute("aria-disabled");
    button.querySelector(".w-sent")?.remove();
    welcome.watch = "";
    renderWelcomeReply();
  }
}

// ---------- the demo week (src/demo.ts) ----------

/** The banner across the panel while the demo runs; "Connect Claude" while its answers are recorded. */
function renderDemo() {
  const d = data?.demo;
  $("#demo-banner").hidden = !d?.on;
  $("#demo-live").hidden = !d?.on || d.live;
  document.body.classList.toggle("demo", !!d?.on);
}

/** Waits for Pako to stop and come back (the demo's start or end restarts it), then reloads. False when it did not come back in a minute. */
async function waitForRestart() {
  const start = Date.now();
  let down = false;
  while (Date.now() - start < 60_000) {
    await new Promise((r) => setTimeout(r, 700));
    let up = false;
    try {
      up = (await fetch("/health", { cache: "no-store" })).ok;
    } catch {
      up = false;
    }
    if (!up) down = true;
    else if (down || Date.now() - start > 8_000) {
      location.reload();
      return true;
    }
  }
  return false;
}

/** Starts the demo week ("start") or leaves it ("leave"): Pako starts again on the other folder, and the page reloads. */
async function demoSwitch(kind, say) {
  try {
    const r = await fetch(`/panel/api/demo/${kind}`, { method: "POST", credentials: "same-origin", headers: { "x-pako": "1" } });
    if (r.status === 401) return void location.reload();
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    say(t(kind === "start" ? "demo.starting" : "demo.leaving"));
    tellApp({ demo: kind === "start" });
    if (!j.restarting) return void location.reload();
    if (!(await waitForRestart())) say(t("demo.notBack"));
  } catch (err) {
    console.warn("demo", err);
    say(t("demo.failed"));
  }
}

/** "Try with a demo week" in the welcome (and from the Mac app's Connect window, window.pakoTryDemo). */
async function tryDemo() {
  const b = $("#w-demo");
  if (b.getAttribute("aria-disabled") === "true") return;
  for (const x of [b, $("#w-own")]) x.setAttribute("aria-disabled", "true");
  await demoSwitch("start", (text) => (welcome.open ? ($("#w-start-note").textContent = text) : toast(text)));
  for (const x of [b, $("#w-own")]) x.removeAttribute("aria-disabled");
}
window.pakoTryDemo = () => void tryDemo();

function wireDemo() {
  $("#demo-leave").addEventListener("click", (e) => {
    const b = e.currentTarget;
    if (b.disabled) return;
    b.disabled = true;
    void demoSwitch("leave", (text) => toast(text)).finally(() => (b.disabled = false));
  });
}

function wireWelcome() {
  const dlg = $("#welcome");
  $("#w-demo").addEventListener("click", () => void tryDemo());
  $("#w-own").addEventListener("click", () => void welcomeNext());
  // Enter on the name goes on, as in a form (a real form here would hold Telegram's own inside it).
  dlg.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing && e.target.id === "w-name") {
      e.preventDefault();
      void welcomeNext();
    }
  });
  $("#w-name").addEventListener("input", () => welcomeTexts());
  for (const b of dlg.querySelectorAll(".w-sugg")) b.addEventListener("click", () => void trySay(b));
  $("#w-next").addEventListener("click", () => void welcomeNext());
  $("#w-back").addEventListener("click", () => showStep(welcome.i - 1));
  $("#w-skip").addEventListener("click", () => void (welcome.first ? finishWelcome() : cancelWelcome()));
  // Escape: the same as the top button (skip on the first visit, close otherwise); the dialog is not left half closed.
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault();
    void (welcome.first ? finishWelcome() : cancelWelcome());
  });
  // A browser may close it by itself (a second Escape straight after the first): the same, so nothing is left behind.
  dlg.addEventListener("close", () => {
    if (welcome.open) void (welcome.first ? finishWelcome() : cancelWelcome());
  });
}

function start() {
  // An empty list (no meetings, no mail yet) has nothing to animate: normal on a fresh install, not worth a console warning.
  gsap()?.config({ nullTargetWarn: false });
  applyStatic();
  watchFrames();
  try {
    orb = startOrb($("#orb"));
  } catch (err) {
    console.warn("orb", err);
  }
  if (!orb) document.body.classList.add("no-webgl");
  mountTwins(); // the figure's CSS twins: the chat's header, the welcome, Settings
  // The header's aura and its z's, and the chat's glow, follow the figure too.
  const follow = (state) => {
    $(".orb-wrap").dataset.state = state;
    $("#chat").classList.toggle("pako-busy", state === "thinking" || state === "speaking");
  };
  follow(pageFigure().state);
  pageFigure().subscribe(follow);
  tg.input = h("input", {
    id: "tg-token", class: "tg-input", type: "text", autocomplete: "off", autocapitalize: "off", spellcheck: "false", maxlength: 4000, placeholder: "123456789:AA…",
  });
  tg.el = h("div", { class: "tg", tabindex: "-1" });
  $("#tg-slot").append(tg.el);
  tickClock();
  setInterval(tickClock, 1000);
  wire();
  wireWelcome();
  wireDemo();
  pointerGlow();
  tgReady = tgLoad();
  load();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
