// Pako · the dashboard's rules, as plain functions (the page, app.js, calls them; the tests call them with fixtures). The dashboard shows
// CONTENT, never setup: what the owner owes, what others owe them, today's meetings, the mail that needs them. So:
// - a section with nothing in it is not shown at all (hideWhenEmpty), and appears by itself the first time it has something;
// - channels (Telegram, WhatsApp) are how Pako reaches the owner, not content: no card, only one line when one is broken;
// - at most one quiet suggestion for the single most useful thing not connected yet;
// - the system's health is one section, a single calm line when all is well.
// Its words are English only (Pako's new words are).

export const WORDS = {
  owe: "Things to do",
  waiting: "Waiting on others",
  meetings: "Today's meetings",
  needsYou: "Needs you in mail",
  allClear: "all clear",
  dueToday: "{n} due today",
  overdue: "{n} overdue",
  /** Gentle mode's words for the same count: no "overdue", never in red (src/gentle.ts, no shame). */
  pastTime: "{n} past their time",
  nextAt: "next: {title}",
  noneLeft: "none left today",
  invited: "Invited · not answered",
  invitedMail: "Invited (from email)",
  broken: "{name} stopped working · fix in Settings",
  allGood: "All good · checked {ago}",
  problems: "{n} thing(s) need a look",
  welcomeTitle: "Pako keeps track of what you promise, so nothing gets dropped.",
  welcomeLead: "It reads your mail and your calendar, notices what you owe and what others owe you, and reminds you once, at the right time.",
  justNow: "just now",
  minAgo: "{n} min ago",
  hAgo: "{n} h ago",
  synced: "{label} · synced {ago}",
  neverSynced: "{label} · not synced yet",
  stale: "older than 30 minutes",
  googleSlow: "Google updates private links slowly",
  calendars: "Calendars: {list}",
  suggest: {
    calendar: "Connect your calendar to see today's meetings",
    macCalendar: "Connect your calendar to see today's meetings",
    imap: "Connect your mail so Pako can tell you what needs you",
    mail: "Connect your mail so Pako can tell you what needs you",
    telegram: "Connect Telegram so Pako can reach you on your phone",
    contacts: "Import your contacts so Pako knows who's who",
  },
  settings: "Settings",
  catchingUp: "Catching up on the last {days} days… {percent}%",
  notAnalysed: "From the last {days} days: {n} older emails are listed but not analysed (the catch-up's allowance was used).",
  briefTitle: "Today's brief",
  briefAsOf: "as of {time}",
  briefOpen: "Open the full brief",
  briefMore: "and {n} more",
};

const fill = (s, vars = {}) => String(s).replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));

/** "3 min ago". */
export function ago(at, now) {
  const m = Math.max(0, Math.round((now - at) / 60_000));
  return m < 1 ? WORDS.justNow : m < 90 ? fill(WORDS.minAgo, { n: m }) : fill(WORDS.hAgo, { n: Math.round(m / 60) });
}

// ---------- empty sections ----------

/**
 * Shows a section only while it has something in it. `keep`: the owner is using it now (the pointer on it, the focus in it): it stays until
 * the next refresh, so nothing jumps under their cursor. Exposed as window.pakoSection.hideWhenEmpty for the other cards' scripts (People).
 */
export function hideWhenEmpty(el, hasContent, { keep = false } = {}) {
  if (!el) return false;
  const using = keep || (typeof el.matches === "function" && el.matches(":hover")) || (typeof document !== "undefined" && el.contains?.(document.activeElement));
  el.hidden = !hasContent && !using;
  return !el.hidden;
}

/** Whether a card has real content: an item that is not the "nothing here" placeholder. */
export function cardHasContent(card) {
  if (!card) return false;
  // .tl-event and .pill: the agenda's timed and all-day events (a calendar with only meetings in it is not an empty card).
  return card.querySelectorAll("li:not(.empty), .ev, .tl-event, .pill, .note, .item:not(.empty), .svc, [data-content]").length > 0;
}

/** Everything empty (a brand-new install): the page shows only the welcome block. */
export const allEmpty = (shown) => shown.every((x) => !x);

// ---------- the KPI tiles ----------

const OWES = new Set(["request_to_owner", "owner_promise", "agreed_meeting", "deadline"]);

/** The day's bounds (ms) in a time zone, for "due today". */
function dayEnd(now, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(now).map((x) => [x.type, x.value]));
  const into = ((Number(p.hour) % 24) * 3600 + Number(p.minute) * 60 + Number(p.second)) * 1000;
  return now - into + 24 * 3600_000;
}

/**
 * The row of tiles: what the owner owes, what others owe them, today's meetings. A tile whose source is not
 * connected is null (hidden); a tile at 0 still shows ("0 · all clear").
 */
export function kpiTiles(data, now, timeZone = "UTC") {
  const end = dayEnd(now, timeZone);
  const loops = Array.isArray(data.loops) ? data.loops : null;
  const open = (loops ?? []).filter((l) => l.status === "open" || l.status === "snoozed");
  const owe = open.filter((l) => OWES.has(l.kind));
  const waiting = open.filter((l) => l.kind === "other_promise");
  const overdue = owe.filter((l) => l.dueAt && l.dueAt < now).length;
  const dueToday = owe.filter((l) => l.dueAt && l.dueAt >= now && l.dueAt < end).length;
  // Gentle mode (data.gentle): the count is said without "overdue" and never in red.
  const gentle = data.gentle === true;
  const parts = [dueToday ? fill(WORDS.dueToday, { n: dueToday }) : "", overdue ? fill(gentle ? WORDS.pastTime : WORDS.overdue, { n: overdue }) : ""].filter(Boolean);
  const events = (data.events ?? []).filter((e) => !e.allDay && e.start < end && e.end > now - 12 * 3600_000 && e.start >= end - 24 * 3600_000);
  const left = events.filter((e) => e.end > now).sort((a, b) => a.start - b.start);
  // The mail that needs the owner is not a tile: the "Needs you" preview block mounts under the row (#needs-you-mail).
  return {
    owe: loops ? { n: owe.length, foot: parts.join(" · ") || WORDS.allClear, warn: overdue > 0 && !gentle, href: "#loops" } : null,
    waiting: loops ? { n: waiting.length, foot: waiting.length ? waiting[0].who || "" : WORDS.allClear, warn: false, href: "#loops" } : null,
    meetings: data.calendarOn ? { n: events.length, foot: left[0] ? fill(WORDS.nextAt, { title: left[0].title }) : WORDS.noneLeft, warn: false, href: "#h-agenda" } : null,
  };
}

// ---------- a new mailbox's catch-up ----------

/** The calm line while a new mailbox's last days are read ("Catching up on the last 14 days… 40%"), and what was left unread after. */
export function catchUpLine(c) {
  if (!c) return "";
  if (c.running) return fill(WORDS.catchingUp, { days: c.days, percent: c.percent });
  return c.notAnalysed ? fill(WORDS.notAnalysed, { n: c.notAnalysed, days: c.days }) : "";
}

// ---------- the brief, first on the page ----------

/**
 * The brief's compact block at the top: today's headline and its first items with their sources, or, before today's exists, the latest
 * one marked "as of" its time. Null when there has never been one.
 */
export function briefTop(view, max = 3) {
  const doc = view?.doc ?? view?.latest ?? null;
  if (!doc) return null;
  const refs = new Map((doc.refs ?? []).map((r) => [r.id, r.label]));
  const items = (doc.todos ?? []).slice(0, max).map((x) => ({
    title: String(x.title ?? ""), done: x.done === true, sources: (x.sources ?? []).map((id) => refs.get(id)).filter(Boolean).slice(0, 2),
  }));
  return { headline: String(doc.opening ?? ""), items, asOf: view?.doc ? null : doc.at, more: Math.max(0, (doc.todos ?? []).length - max) };
}

// ---------- calendar ----------

/** The tag an event carries: an invitation not answered, or one known only from an invitation mail. "" for none. */
export const eventTag = (e) => (e.invited === "email" ? WORDS.invitedMail : e.response === "needs" ? WORDS.invited : "");

/** The line under the agenda: each calendar source and when it was last read; one older than 30 minutes says so. */
export function freshnessLine(sources, now) {
  if (!Array.isArray(sources) || !sources.length) return "";
  const list = sources.map((s) => {
    const base = s.lastSync ? fill(WORDS.synced, { label: s.label, ago: ago(s.lastSync, now) }) : fill(WORDS.neverSynced, { label: s.label });
    const notes = [s.lastSync && now - s.lastSync > 30 * 60_000 ? WORDS.stale : "", s.slow ? WORDS.googleSlow : "", s.error ?? ""].filter(Boolean);
    return notes.length ? `${base} (${notes.join("; ")})` : base;
  });
  return fill(WORDS.calendars, { list: list.join(" · ") });
}

// ---------- channels and the one suggestion ----------

const CHANNELS = { telegram: "Telegram", whatsapp: "WhatsApp" };

/** One line per channel that is set up but broken (unpaired, token refused): reminders would stop arriving silently otherwise. */
export function brokenChannels(status) {
  return (status ?? []).filter((c) => Object.hasOwn(CHANNELS, c.id) && (c.state === "error" || c.state === "needsAction"))
    .map((c) => ({ id: c.id, text: fill(WORDS.broken, { name: CHANNELS[c.id] }) }));
}

const SUGGEST_ORDER = ["calendar", "macCalendar", "imap", "telegram", "contacts"];

/** At most one quiet suggestion: the single most useful source not connected yet; none once a calendar and a mailbox are there. */
export function oneSuggestion(status) {
  const list = status ?? [];
  const on = (id) => list.some((c) => c.id === id && c.state === "connected");
  const hasCal = on("calendar") || on("macCalendar");
  const hasMail = on("imap") || on("mail");
  for (const id of SUGGEST_ORDER) {
    if ((id === "calendar" || id === "macCalendar") && hasCal) continue;
    if (id === "imap" && hasMail) continue;
    const c = list.find((x) => x.id === id);
    if (c && c.state === "notSet") return { id, text: WORDS.suggest[id], href: `/panel/settings#${id === "imap" ? "mail" : id === "macCalendar" ? "calendar" : id}` };
  }
  return null;
}

// ---------- health: one section ----------

/** The system section's summary: problems first (each with its fix), or a single calm line. */
export function healthSummary(state, now) {
  const parts = Array.isArray(state?.parts) ? state.parts : [];
  const bad = parts.filter((p) => p.status === "down" || p.status === "failing");
  // A Claude Code that failed the bridge's self-test is a problem too, though Claude still answers: the sentence says how to go back. So is
  // one too old for a model Pako asks for ("behind"): the sentence says how to update it.
  const cli = state?.cli;
  if (cli && (cli.status === "failed" || cli.status === "behind") && typeof cli.note === "string" && cli.note) bad.push({ key: "claude", detail: cli.note });
  const times = parts.map((p) => Math.max(Number(p.okAt) || 0, Number(p.failSince) || 0)).filter(Boolean);
  const last = times.length ? Math.max(...times) : now;
  return bad.length
    ? { ok: false, line: fill(WORDS.problems, { n: bad.length }), problems: bad.map((p) => ({ key: String(p.key), detail: String(p.detail ?? "") })) }
    : { ok: true, line: fill(WORDS.allGood, { ago: ago(last, now) }), problems: [] };
}

if (typeof window !== "undefined") window.pakoSection = { hideWhenEmpty, cardHasContent };
