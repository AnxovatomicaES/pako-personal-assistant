// Third-party text, kept apart from the part of Pako that acts.
//
// THE RULE. Text written by anyone but the owner (an email, a Slack message, a calendar invitation or ICS feed, a web page, a document, a
// forwarded message, a meeting transcript, a restaurant's name) is READ IN FULL only in an isolated run: Claude with no tools and no
// conversation, whose tags are never acted on (assistant/bridge.ts: handleEmail, handleMeeting, answerWithSlack). The conversation that can
// act gets at most that run's short verdict or summary, or one short line of it, always passed through this file first: neutralised (no tag
// of Pako's, no delimiter, nothing invisible, nothing a renderer hides), cut to a length, and inside a block that says where it came from.
// And a turn whose input was outside text acts on nothing by itself: the bridge marks it (`outside` on /assistant/reply) and the server
// holds what its tags asked for until the owner presses a card (src/whatsapp.ts). An older bridge marks nothing: today's behaviour.
//
// Where outside text reaches a prompt today, and how each goes through here:
// - the main conversation's context lines (assistant/bridge.ts contextBlock): the mailbox (summaries made by the isolated email run),
//   the calendar (titles and places; ICS descriptions are never passed on, only a join link is taken from them), Zoom (coming meetings and
//   the summaries made by the isolated meeting run), Slack alerts, table bookings (restaurant names), call events: `inline`, inside the
//   bracketed context note that names the source and says it is other people's text. A line the owner's last turn did not have in front of
//   it marks the turn by halves (`context` on /assistant/reply): what deletes, stands or is kept (forget, unremind, a list change, done,
//   person, routine, watch, and a note, reminder, task, promise or fact it adds, which would later read as the owner's own words) waits for a
//   press, and words Pako wrote to someone ask first (src/autonomy.ts). A line seen
//   before marks nothing (every turn carries them, so every tag would wait). A routine's own run is always marked so;
// - a forwarded message the owner sends on (WhatsApp's or Telegram's forwarded flag): `wrap`, and the turn is marked;
// - what the main run read on the web with its own WebSearch or WebFetch (seen in the run's result as more than one turn): the turn is marked;
// - an email, a meeting transcript and Slack search results, each in its isolated run: `neutralise` (`keepBrackets` for the email and the
//   transcript, whose fence is the run's own, so an address like <ana@example.com> stays readable).
//
// Everything here is pure (no store, no network): the bridge on the owner's computer and the server both import it.

import { texts, type Lang } from "./i18n.ts";
import type { PersonInput } from "./people.ts";

/** Pako's tags (assistant/bridge.ts parseReply): text that is not the assistant's own can never carry one that reads as live. */
export const TAG_NAMES = [
  "remember", "forget", "call", "message", "send", "remind", "unremind", "slack", "book", "list", "task", "done", "routine", "watch", "person",
  "email", "health", "goal", "card",
] as const;

/** The block that marks outside text in the conversation that acts; its brackets are taken out of everything that goes inside. */
export const BLOCK_OPEN = "⟦outside";
export const BLOCK_CLOSE = "⟦/outside⟧";

/** Where a piece of outside text came from: the label of its block, and why a turn was marked. */
export type OutsideSource = "email" | "slack" | "calendar" | "web" | "document" | "forwarded" | "meeting" | "booking" | "event" | "routine";
const SOURCES: readonly OutsideSource[] = ["email", "slack", "calendar", "web", "document", "forwarded", "meeting", "booking", "event", "routine"];

// Characters that show nothing, or turn text around: they can hide a word from the owner and from a check (`<re​mind>`), or smuggle
// letters a model reads and a person does not (the Unicode tag block). Soft hyphen, combining grapheme joiner, Arabic letter mark, Hangul
// fillers, Mongolian selectors, zero-width and bidi controls, word joiner and invisible operators, variation selectors, BOM, interlinear
// annotation marks, tag characters, and the C0 and C1 controls except tab and new line.
const INVISIBLE = new RegExp(
  "[\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\u3164\\ufe00-\\ufe0f"
    + "\\ufeff\\uffa0\\ufff9-\\ufffb\\u{e0000}-\\u{e007f}\\u{e0100}-\\u{e01ef}\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]",
  "gu",
);
/** Brackets that look like < and > to a reader (or to a model) without being them; NFKC already folds the full-width and small ones. */
const LOOKS_OPEN = /[‹〈⟨〈❬❮〔❰]/g;
const LOOKS_CLOSE = /[›〉⟩〉❭❯〕❱]/g;
const TAG_WORD = `(?:${TAG_NAMES.join("|")})`;

export interface NeutraliseOptions {
  /** At most this many characters (an ellipsis says it was cut). */
  max?: number;
  /** One line: new lines become spaces (a context list). */
  oneLine?: boolean;
  /**
   * Leaves a lone < or > that is not one of Pako's tags (an isolated run's own fence is the only delimiter there, and "Ana <ana@x.com>" stays
   * readable); runs of three are still broken, so the text cannot close that fence. Otherwise every < and > becomes ‹ ›, and [ ] | become
   * ( ) /: the text cannot open or close a bracketed context note nor fake a list's separator.
   */
  keepBrackets?: boolean;
}

/** Cut by characters, never in the middle of one (an emoji is two UTF-16 units). */
const cut = (s: string, max: number): string => {
  if (s.length <= max) return s;
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…`;
};

/**
 * Outside text made harmless to put in front of Claude: nothing invisible, no HTML comment (a mail client hides it, a model reads it), no
 * entity-written bracket, no tag of Pako's that could read as live, none of this file's delimiters, and no longer than `max`.
 */
export function neutralise(text: unknown, o: NeutraliseOptions = {}): string {
  let s = typeof text === "string" ? text : "";
  // Very long input is cut before the work below (a feed of megabytes must not cost seconds); the exact cut comes at the end.
  const max = o.max ?? 2000;
  if (s.length > max * 4 + 1000) s = s.slice(0, max * 4 + 1000);
  s = s.replace(/\r\n?/g, "\n");
  // Entities first, so "&lt;remind&gt;" is caught as the tag it would be once a renderer or a model reads it.
  s = s.replace(/&(?:lt|#0*60|#x0*3c);?/gi, "<").replace(/&(?:gt|#0*62|#x0*3e);?/gi, ">");
  // NFKC folds the full-width ＜remind＞ and the small ﹤ ﹥ into < and >, and wide letters into plain ones.
  s = s.normalize("NFKC").replace(INVISIBLE, "");
  s = s.replace(LOOKS_OPEN, "<").replace(LOOKS_CLOSE, ">");
  // An HTML comment a mail client would hide: gone, its words too (an unclosed one hides the rest, as a client would).
  s = s.replace(/<!--[\s\S]*?(?:-->|$)/g, " ");
  // This file's delimiters, in any spelling a model could take for one.
  s = s.replace(/[⟦⟧]/g, (c) => (c === "⟦" ? "(" : ")"));
  if (o.keepBrackets) {
    // A tag of Pako's, opened or closed, with or without spaces inside: softened as a whole, so it reads as quoted text, not as one of its own.
    s = s.replace(new RegExp(`<(\\s*\\/?\\s*${TAG_WORD}\\b[^<>\\n]{0,300})>?`, "gi"), "‹$1›");
    s = s.replace(/[<>]{3,}/g, "‹‹");
  } else {
    s = s.replace(/</g, "‹").replace(/>/g, "›").replace(/\[/g, "(").replace(/\]/g, ")").replace(/\|/g, "/");
  }
  if (o.oneLine) s = s.replace(/\s+/g, " ");
  else s = s.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n");
  return cut(s.trim(), max);
}

/** One line of outside text for a list in the conversation's context: neutralised, on one line, cut short. */
export const inline = (text: unknown, max = 500): string => neutralise(text, { max, oneLine: true });

/** The label of a block: who wrote it, on one line, with nothing that could end the label or the block. */
const label = (s: string): string => neutralise(s, { max: 120, oneLine: true }).replace(/["=]/g, "'");

/**
 * Outside text as a block of its own in the conversation that acts: where it came from, who wrote it (when known), and the text,
 * neutralised and cut. Nothing inside can close the block: its brackets are taken out of the text.
 */
export function wrap(text: unknown, o: { source: OutsideSource; from?: string; max?: number }): string {
  const from = o.from ? label(o.from) : "";
  const body = neutralise(text, { max: o.max ?? 4000 });
  return `${BLOCK_OPEN} source=${o.source}${from ? ` from="${from}"` : ""}⟧\n${body}\n${BLOCK_CLOSE}`;
}

/**
 * Why a reply's turn was marked, as the bridge sends it (`outside` on /assistant/reply): the sources it names, an unknown one as "document",
 * `true` alone as "document". Nothing (an older bridge, a turn of the owner's own) is an empty list: the reply acts as it always did.
 */
export function outsideOf(v: unknown): OutsideSource[] {
  if (v === true) return ["document"];
  if (!Array.isArray(v)) return [];
  const out = new Set<OutsideSource>();
  for (const x of v.slice(0, 10)) {
    if (typeof x !== "string" || !x.trim()) continue;
    out.add((SOURCES as readonly string[]).includes(x) ? (x as OutsideSource) : "document");
  }
  return [...out];
}

/** What a reply's tags asked for, as the server read them: held as a whole when the turn was marked, done on the owner's press. */
export interface HeldActs {
  call: { name: string; message: string; direct: boolean } | null;
  message: { to: string; text: string } | null;
  send: { to: string; text: string } | null;
  /** An email from Pako's own inbox (src/autonomy.ts): to a name from the contact book or an address, a subject, the words. */
  email?: { to: string; subject: string; text: string } | null;
  book: { what: string; when: string; party: number; notes?: string; name?: string } | null;
  remind: { at: string; text: string; every?: string }[];
  unremind: string[];
  lists: { name: string; op: "add" | "remove"; items: string[] }[];
  tasks: { text: string; due: string }[];
  done: string[];
  /** Words of the follow-ups the owner said are handled (src/followups/owner.ts closeByWords). Absent from an older bridge: none. */
  closed?: string[];
  /** Promises the owner made in the chat, kept as their own follow-ups (src/followups/matching.ts fromChat). Absent from an older bridge: none. */
  promises?: { text: string; who: string; due: string }[];
  /** Notes: a marked turn's bridge sends them here, with the reply, instead of to /assistant/memory. */
  remember: string[];
  forget: string[];
  /** People the reply's <person> tags describe (src/people.ts): what someone else's text says about anyone is never kept without a press. */
  people?: PersonInput[];
  /**
   * What a turn with new outside text in its context would keep as the owner's own words, read back in every later turn as theirs: its
   * <fact> tags (src/proactive.ts), its <know> tags (src/memory-facts.ts), and its diary, goals and cards (src/companion.ts). Held, never kept
   * silently. Absent from an older bridge: none.
   */
  facts?: { kind?: unknown; text?: unknown }[];
  know?: { who: string; key: string; value: string; since: string; starts?: string }[];
  role?: { health?: { kind: string; text: string }[]; goals?: string[]; cards?: { goal: string; q: string; a: string }[] };
}

export const hasActs = (a: HeldActs): boolean =>
  !!(a.call || a.message || a.send || a.email || a.book || a.remind.length || a.unremind.length || a.lists.length || a.tasks.length || a.done.length
    || a.closed?.length || a.promises?.length || a.remember.length || a.forget.length || a.people?.length || a.facts?.length || a.know?.length
    || a.role?.health?.length || a.role?.goals?.length || a.role?.cards?.length);

const T = texts(
  {
    card: "⚠️ This answer was written while reading other people's text ({why}), so I haven't done what it asked without checking with you:\n"
      + "{list}\n\nShall I do it?",
    yes: "Do it",
    more: "…and {n} more",
    expired: "That's no longer pending (time ran out, Pako restarted or you sent STOP). If you want it, ask me again.",
    dropped: "OK, I won't.",
    paused: "I'm paused: I won't do any of that. Once you send RESUME, ask me again if you want it.",
    local: "(I haven't done what this answer asked: it was written while reading other people's text ({why}). If you want it, ask me yourself.)",
    log: "Held without asking (other people's text: {why}): {what}",
    logDone: "Done after the owner confirmed: {what}",
    logDropped: "Dropped by the owner: {what}",
    forwarded: "a forwarded message",
    web: "the web",
    email: "an email",
    slack: "Slack",
    calendar: "the calendar",
    document: "a document",
    meeting: "a meeting",
    booking: "a restaurant",
    event: "a notice",
    routine: "a routine",
    call: "Call {name}: “{text}”",
    message: "WhatsApp to {to}: “{text}”",
    send: "Message from my number to {to}: “{text}”",
    emailTo: "Email to {to}: “{text}”",
    book: "Look for a table: {what}, {when}, {party} people",
    remind: "Reminder {at}{every}: “{text}”",
    every: " (repeats: {every})",
    day: "every day",
    weekday: "on weekdays",
    week: "every week",
    month: "every month",
    year: "every year",
    unremind: "Delete reminders with “{text}”",
    add: "Add to the {name} list: {items}",
    remove: "Take off the {name} list: {items}",
    task: "Task: “{text}”{due}",
    due: " for {due}",
    done: "Mark as done: “{text}”",
    closed: "Close the follow-up: “{text}”",
    promise: "Keep as your follow-up: “{text}”",
    remember: "Keep the note: “{text}”",
    forget: "Delete the notes with “{text}”",
    person: "Keep {name}: {what}",
    fact: "Keep the fact: {text}",
    health: "Keep in the health diary: “{text}”",
    goal: "Keep the learning goal: “{text}”",
    cardQ: "Keep the study card: “{text}”",
  },
);

/** Why a turn was marked, in words: "the web, a forwarded message". */
export const whyText = (why: OutsideSource[], l: Lang): string => {
  const t = T(l);
  return (why.length ? why : (["document"] as OutsideSource[])).map((w) => t(w)).join(", ");
};

/** The owner reads exactly what would be done: nothing hidden in it, on one line, short. */
const shown = (s: string, max = 160): string => cut(s.normalize("NFKC").replace(INVISIBLE, "").replace(/\s+/g, " ").trim(), max);

/** One line per thing the held reply asked for, as the owner reads it on the card. */
export function heldLines(a: HeldActs, l: Lang): string[] {
  const t = T(l);
  const out: string[] = [];
  if (a.call) out.push(t("call", { name: shown(a.call.name, 40), text: shown(a.call.message) }));
  if (a.message) out.push(t("message", { to: shown(a.message.to, 40), text: shown(a.message.text) }));
  if (a.send) out.push(t("send", { to: shown(a.send.to, 40), text: shown(a.send.text) }));
  if (a.email) out.push(t("emailTo", { to: shown(a.email.to, 80), text: shown(a.email.text) }));
  if (a.book) out.push(t("book", { what: shown(a.book.what, 80), when: shown(a.book.when, 20), party: a.book.party }));
  for (const w of a.unremind) out.push(t("unremind", { text: shown(w, 80) }));
  const often = (e: string): string => (/^(day|weekday|week|month|year)$/.test(e) ? t(e as "day") : shown(e, 10));
  for (const r of a.remind) out.push(t("remind", { at: shown(r.at, 20), every: r.every ? t("every", { every: often(r.every) }) : "", text: shown(r.text) }));
  for (const x of a.lists) out.push(t(x.op, { name: shown(x.name, 40), items: shown(x.items.join("; ")) }));
  for (const x of a.tasks) out.push(t("task", { text: shown(x.text), due: x.due ? t("due", { due: shown(x.due, 20) }) : "" }));
  for (const w of a.done) out.push(t("done", { text: shown(w, 80) }));
  for (const w of a.closed ?? []) out.push(t("closed", { text: shown(w, 80) }));
  for (const p of a.promises ?? []) out.push(t("promise", { text: shown(p.text, 120) }));
  for (const w of a.remember) out.push(t("remember", { text: shown(w) }));
  for (const w of a.forget) out.push(t("forget", { text: shown(w, 80) }));
  // Every field the tag gave, so the owner sees exactly what would be kept about that person.
  for (const p of a.people ?? []) {
    const what = [p.relation, p.birthday, ...(p.likes ?? []), ...(p.notes ?? [])].filter((x): x is string => !!x).join("; ");
    out.push(t("person", { name: shown(p.name, 40), what: shown(what) }));
  }
  for (const f of a.facts ?? []) out.push(t("fact", { text: shown(`${typeof f.kind === "string" ? `${f.kind}: ` : ""}${typeof f.text === "string" ? f.text : ""}`) }));
  for (const k of a.know ?? []) out.push(t("fact", { text: shown(`${k.who ? `${k.who}, ` : ""}${k.key}: ${k.value}`) }));
  for (const h of a.role?.health ?? []) out.push(t("health", { text: shown(h.text) }));
  for (const g of a.role?.goals ?? []) out.push(t("goal", { text: shown(g, 80) }));
  for (const c of a.role?.cards ?? []) out.push(t("cardQ", { text: shown(c.q) }));
  return out;
}

/** The card that asks the owner: why it was held and each thing, one a line (the card's body is cut at 1000 characters by WhatsApp). */
export const heldCard = (a: HeldActs, why: OutsideSource[], l: Lang): string => {
  const all = heldLines(a, l).map((x) => `• ${x}`);
  const lines = all.slice(0, 12);
  while (lines.join("\n").length > 700 && lines.length > 1) lines.pop();
  // Do it does all of them: what the card has no room for is counted, never left out without a word.
  const more = all.length - lines.length;
  const list = more ? `${lines.join("\n")}\n• ${T(l)("more", { n: more })}` : lines.join("\n");
  return T(l)("card", { why: whyText(why, l), list });
};

/** The other words of a held reply: the card's button, its answers, the bridge's note when the server cannot hold, the log lines. */
export const heldText = (key: "yes" | "expired" | "dropped" | "paused", l: Lang): string => T(l)(key);
export const heldLocally = (why: OutsideSource[], l: Lang): string => T(l)("local", { why: whyText(why, l) });
export const heldLog = (kind: "log" | "logDone" | "logDropped", a: HeldActs, why: OutsideSource[], l: Lang): string =>
  T(l)(kind, { why: whyText(why, l), what: heldLines(a, l).join("; ").slice(0, 400) });
