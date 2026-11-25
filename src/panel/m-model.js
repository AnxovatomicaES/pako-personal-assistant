// Pako · the phone's page, its rules (src/panel/m.js draws them; test/mobile.test.ts reads them in Node): what goes in "Needs you now",
// what the owner owes and what others owe them, which buttons each item has, the brief with the sources each item cites, a loop's time in
// words, and the mail app's link for a draft. Plain functions of the server's answer (GET /m/api/today): no page, no network.

/** What the owner owes (the rest, "other_promise", is owed to them). */
export const OWES = new Set(["request_to_owner", "owner_promise", "agreed_meeting", "deadline"]);
/** A time this close counts as "now". */
export const SOON_MS = 3 * 3600_000;

/** The buttons of an item, by where it is: an open one is answered, a parked or closed one comes back. */
export const ACTIONS = { open: ["done", "snooze", "tomorrow", "park"], parked: ["reopen"], closed: ["reopen"] };

const DAY_MS = 24 * 3600_000;

/** The day (YYYY-MM-DD) of a time, in a time zone. */
const dayOf = (t, timeZone) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);

/**
 * A loop's time as the phone says it: "Overdue" (or, in gentle mode, "Time passed", never red), "Today 3:00 PM", "Tomorrow 9:30",
 * "Mon 12 Jan 9:30". `late` marks it red.
 */
export function dueText(at, now, o = {}) {
  const timeZone = o.timeZone || "UTC";
  const locale = o.locale || "en-GB";
  if (at < now) return { text: o.gentle ? "Time passed" : "Overdue", late: !o.gentle };
  const time = new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit" }).format(at);
  const day = dayOf(at, timeZone);
  if (day === dayOf(now, timeZone)) return { text: `Today ${time}`, late: false };
  if (day === dayOf(now + DAY_MS, timeZone)) return { text: `Tomorrow ${time}`, late: false };
  const date = new Intl.DateTimeFormat(locale, { timeZone, weekday: "short", day: "numeric", month: "short" }).format(at);
  return { text: `${date} ${time}`, late: false };
}

/** Whether a loop wants the owner now: theirs, open, and reminded already or due within three hours (or past). */
export const needsNow = (l, now) => OWES.has(l.kind) && l.status === "open" && (l.nudges > 0 || (l.dueAt !== undefined && l.dueAt <= now + SOON_MS));

/** One loop as an item of a list: its words, its time, its buttons, its draft. */
export function loopItem(l, now, o = {}, where = "open") {
  return {
    id: l.id,
    title: String(l.title ?? ""),
    who: String(l.who ?? ""),
    where: String(l.where ?? ""),
    due: l.dueAt !== undefined && where === "open" ? dueText(l.dueAt, now, o) : null,
    snoozed: l.status === "snoozed",
    checked: l.lastCheck ? String(l.lastCheck) : "",
    step: l.step ? String(l.step) : "",
    owes: OWES.has(l.kind),
    actions: ACTIONS[where],
    draft: l.draft ? { status: String(l.draft.status), text: String(l.draft.text ?? "") } : null,
    // A draft can be asked for something the owner owes, while none is written or being written.
    canDraft: where === "open" && o.drafts === true && OWES.has(l.kind) && (!l.draft || l.draft.status === "failed" || l.draft.status === "old"),
    to: l.to ? String(l.to) : "",
    from: l.from ? String(l.from) : "",
  };
}

/** The sources an item cites, as chips: their kind ("Email") and who or where ("Ana Ruiz"). Unknown ids are left out. */
export function citations(ids, refs) {
  const by = new Map((refs ?? []).map((r) => [r.id, r]));
  const names = { slack: "Slack", zoom: "Zoom", mail: "Email", calendar: "Calendar", tasks: "Tasks", people: "People" };
  return (ids ?? []).map((id) => by.get(id)).filter(Boolean).map((r) => ({ id: r.id, kind: names[r.icon] ?? "Source", label: String(r.label ?? "") }));
}

/** The brief as the phone shows it: today's, or the last one with its time ("as of"); null when there is none. */
export function briefModel(brief) {
  if (!brief) return null;
  const doc = brief.doc ?? brief.latest;
  if (!doc) return { none: true, pending: brief.pending === true };
  const cite = (ids) => citations(ids, doc.refs);
  return {
    none: false,
    pending: brief.pending === true,
    asOf: brief.doc ? null : doc.at,
    at: doc.at,
    opening: String(doc.opening ?? ""),
    focus: doc.focus ? { title: String(doc.focus.title), story: String(doc.focus.story ?? ""), cites: cite(doc.focus.sources) } : null,
    todos: (doc.todos ?? []).filter((x) => !x.parked).map((x) => ({ title: String(x.title), context: String(x.context || x.checked || ""), done: x.done === true, cites: cite(x.sources) })),
    updates: (doc.updates ?? []).map((x) => ({ title: String(x.title), text: String(x.text ?? ""), tag: String(x.tag ?? ""), cites: cite(x.sources) })),
    day: (doc.dayItems ?? []).map((x) => ({
      when: x.allDay ? "All day" : x.time ? `${x.time}${x.end ? `–${x.end}` : ""}` : x.end ? `Until ${x.end}` : "",
      title: String(x.title), note: String(x.note ?? ""), confirmed: x.confirmed !== false, cites: cite(x.sources),
    })),
  };
}

/** The whole page from the server's answer: "Needs you now" first, then the brief, what the owner owes, what others owe them. */
export function phoneModel(data, o = {}) {
  const now = data.now;
  const opts = { timeZone: data.timeZone, locale: o.locale, gentle: data.gentle === true, drafts: data.drafts === true };
  const loops = Array.isArray(data.loops) ? data.loops : [];
  const byTime = (a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity);
  const urgent = loops.filter((l) => needsNow(l, now)).sort(byTime);
  const rest = loops.filter((l) => !urgent.includes(l));
  return {
    name: String(data.name ?? ""),
    followups: Array.isArray(data.loops),
    now: urgent.map((l) => loopItem(l, now, opts)),
    brief: briefModel(data.brief),
    owe: rest.filter((l) => OWES.has(l.kind)).sort(byTime).map((l) => loopItem(l, now, opts)),
    owed: rest.filter((l) => !OWES.has(l.kind)).sort(byTime).map((l) => loopItem(l, now, opts)),
    parked: (data.parked ?? []).map((l) => loopItem(l, now, opts, "parked")),
    closed: (data.closed ?? []).map((l) => loopItem(l, now, opts, "closed")),
    telegram: data.telegram === true,
    device: String(data.device ?? ""),
  };
}

/** The mail app with a draft in it: to the address the loop names (if any), the draft as the body. */
export function mailtoFor(item, text) {
  const to = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/.test(item.to ?? "") ? encodeURIComponent(item.to) : "";
  return `mailto:${to}?body=${encodeURIComponent(text)}`;
}

/** What is kept on the phone for when Pako cannot be reached: the last answer and when it came. */
export const CACHE_KEY = "pako.m.v1";
export function readCache(raw) {
  try {
    const v = JSON.parse(raw ?? "");
    return v && typeof v.at === "number" && v.data && typeof v.data === "object" ? v : null;
  } catch {
    /* nothing kept, or something else under that name: nothing to show */
    return null;
  }
}
