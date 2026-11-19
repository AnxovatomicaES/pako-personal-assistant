// The server's context for a turn, and how it is put in front of Claude: the context lines, other people's text, the owner's language.

import { createHash } from "node:crypto";
import type { Lang } from "../../src/i18n.ts";
import { inline, neutralise, type OutsideSource } from "../../src/quarantine.ts";
import { paperText } from "../../src/papers.ts";
import { T } from "./texts.ts";

export interface Context {
  now: string;
  ownerName: string;
  /** The owner's IANA time zone (America/New_York). */
  timeZone?: string;
  contacts: string[];
  memory: string;
  /** What happened to the calls it proposed (a press, how a call ended): the server tells it, since the assistant never sees these. */
  events?: string[];
  /**
   * The events that carry someone else's words (a friend's reply, a call's summary); the others are Pako's own records. An older server
   * leaves it out: every event then counts as someone else's.
   */
  outsideEvents?: string[];
  /** The time now in the owner's zone as "YYYY-MM-DD HH:MM", and the reminders waiting ("YYYY-MM-DD HH:MM text"). */
  nowLocal?: string;
  reminders?: string[];
  /** The owner's open lists ("compra: leche; pan") and tasks ("llamar al banco (2026-11-20)"), one a line. An older server leaves them out. */
  lists?: string[];
  tasks?: string[];
  /**
   * The people in the owner's life (src/people.ts): "Ana (mi hermana)", at most 30, and each record whole, given to Claude only when the
   * owner's message names that person. An older server leaves both out: a <person> tag then becomes a note it does keep.
   */
  people?: string[];
  peopleRecords?: { name?: unknown; text?: unknown }[];
  /** The assistant's own email address (read only), and the latest emails in it, one line each. */
  mailAddress?: string;
  emails?: string[];
  /** Tables the assistant asked restaurants for (or handed links for), soonest first, one line each. Present when booking is on. */
  bookings?: string[];
  /** Everything is paused: the server refuses every call and message until it runs again. */
  paused?: boolean;
  /**
   * Why: the owner wrote STOP (or used the panel's switch), or Pako paused itself for safety (its store came back empty, or cannot be read
   * now). An older server leaves it out: the owner's STOP then, as before.
   */
  pauseWhy?: string | null;
  /** The owner's language as a two-letter code ("en"), for the runs that answer no message of theirs. An older server leaves it out. */
  language?: string;
  /**
   * The language heard from the owner's own messages (never PAKO_LANGUAGE): the chat's fallback at the start of a conversation for a message
   * that shows none. Left out before any is heard, and by an older server.
   */
  chatLanguage?: string;
  /**
   * The language of Pako's own fixed texts as an older server said it ("es" or "en"). Ignored: Pako's fixed texts are English only now, and
   * the field stays in the type only so an older server's context still reads.
   */
  uiLanguage?: string;
  /** The owner's Slack is connected (read only): the alerts of the last day, one line each. */
  slack?: string[];
  /** The owner's calendar is connected (read only): the next week, one event a line; null when it could not be read. */
  calendar?: string[] | null;
  /** The owner's Zoom is connected (read only): the coming meetings and the latest summaries, one line each. */
  zoom?: { upcoming?: string[]; summaries?: string[] };
  /** What Pako follows up for the owner (src/followups.ts): the open loops, one line each. Absent when off, and from an older server. */
  followups?: string[];
  /** 1: this Mac's app writes the calendar (src/calendar-writes.ts): a proposed change goes to the server, which asks the owner first. */
  calendarWrites?: number;
  /** A server that keeps the health diary, learning goals and cards (src/companion.ts); absent from an older one, which never gets those tags. */
  companion?: number;
  /** A server whose Labs are off (PAKO_LABS): no health diary, lessons, quiz cards or weekly check-in in this Pako. */
  labsOff?: number;
  /** The owner's learning goals, each with its latest questions, and the birthdays of the next 7 days (src/companion.ts). */
  learning?: string[];
  dates?: string[];
  /** What is still open from the week's meetings (src/meeting-review.ts), one line each. Absent when there is none, and from an older server. */
  meetingTodos?: string[];
  /** Today's brief's to-dos not ticked yet (src/brief-v2.ts), one line each. Absent when there is none, and from an older server. */
  briefTodos?: string[];
  /**
   * The server holds the tags of a turn marked as outside text and asks the owner with a card (src/quarantine.ts). An older server leaves it
   * out: the bridge then drops those tags itself, since that server would act on them. 2: it also takes `context` on a reply (new outside
   * text was in the context): it holds only that reply's destructive and standing tags, and words Pako wrote to someone ask first.
   */
  quarantine?: number;
  /**
   * The server makes routines and watches (src/routines.ts), and the owner's, one line each. An older server leaves them out: the bridge then
   * drops <routine> and <watch> and says so, since that server would ignore them while Claude said they were set.
   */
  routinesOn?: number;
  /**
   * The server decides by itself what goes at once and what asks (src/autonomy.ts); `emailOn`: it can send email, to `emailContacts` or an
   * address. An older server leaves them out: the bridge then drops <email> and says so.
   */
  autonomy?: number;
  emailOn?: boolean;
  emailContacts?: string[];
  routines?: string[];
  watches?: string[];
  /** What the latest papers the owner sent said, as the isolated read summarized them (src/papers.ts). Absent when none, and from an older server. */
  papers?: string[];
  /**
   * The server keeps <fact> (src/proactive.ts), what the owner told about their tastes and plans (never health), one line each, and the
   * emergency number of their country. An older server leaves them out: the bridge then drops <fact>, which it would ignore.
   */
  lifeOn?: number;
  life?: string[];
  emergency?: string;
  /**
   * The server keeps <know> (src/memory-facts.ts): dated facts. With it, the owner's own told facts that hold now and what changed in the
   * last days (an old value closed by a new one). An older server leaves them out: the bridge then drops <know>.
   */
  knowOn?: number;
  memoryNow?: string[];
  memoryChanges?: string[];
}

/**
 * A stranger's text inside an isolated run's own fence (src/quarantine.ts): it cannot write a fence of its own (no run of three `<` or `>`),
 * nor a tag of Pako's, nor hide words; a lone `<` stays ("Ana <ana@example.com>").
 */
export const fenced = (s: string, max = 300): string => neutralise(s, { max, keepBrackets: true });
/** `<` and `>` of text that is not the assistant's own can never form a tag the bridge would act on if the assistant quotes it. */
export const noTags = (s: string): string => s.replace(/</g, "‹").replace(/>/g, "›");
/**
 * Other people's text in the conversation that acts (an email's summary, a Slack message, an invitation): one short line that cannot close or
 * open a bracketed context note, fake a list separator, write a tag or hide anything (src/quarantine.ts).
 */
export const outside = (s: string): string => inline(s);

/**
 * Every line of other people's text a context carries (the lines contextBlock gives as other people's text), with where it came from. A turn
 * whose context holds one that the owner's last turn did not have in front of it is marked (src/quarantine.ts): its destructive and standing
 * tags wait for the owner's press, and words Pako writes to someone ask first. A server that says which events carry someone else's words
 * (`outsideEvents`) is believed; from an older one every event counts.
 */
export function contextOutside(ctx: Partial<Context>): { source: OutsideSource; line: string }[] {
  const out: { source: OutsideSource; line: string }[] = [];
  const add = (source: OutsideSource, v: unknown): void => {
    for (const x of Array.isArray(v) ? v : []) if (typeof x === "string" && x.trim()) out.push({ source, line: x });
  };
  add("email", ctx.emails);
  add("calendar", ctx.calendar);
  add("calendar", ctx.zoom?.upcoming);
  add("meeting", ctx.zoom?.summaries);
  add("meeting", ctx.meetingTodos);
  add("slack", ctx.slack);
  add("booking", ctx.bookings);
  add("document", ctx.followups);
  add("document", ctx.briefTodos);
  add("document", ctx.papers);
  add("event", Array.isArray(ctx.outsideEvents) ? ctx.outsideEvents : ctx.events);
  return out;
}
export const outsideKey = (l: { source: OutsideSource; line: string }): string =>
  createHash("sha256").update(`${l.source}\n${l.line}`).digest("hex").slice(0, 24);

/** The owner's language as the server's context gives it, or "" when it does not (an older server) or gives something that is not a code. */
export const languageOf = (ctx: { language?: unknown } | null | undefined): string =>
  typeof ctx?.language === "string" && /^[a-z]{2,3}$/.test(ctx.language) ? ctx.language : "";

/** At most this many people's records go in front of one message (a message naming the whole family gets the first five). */
const NAMED_MAX = 5;
const foldName = (s: string): string => s.normalize("NFKC").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The records of the people the owner's message names (src/people.ts): by their whole name, or by a first name only one of them has ("Ana"
 * for "Ana Garcia"), as a word of its own. What the owner told about them, so the lines go through noTags like the notes. Empty when the
 * server sends none (an older one) or the message names nobody.
 */
export function namedPeople(ctx: Pick<Context, "peopleRecords">, text: string): { name: string; text: string }[] {
  const records = (Array.isArray(ctx.peopleRecords) ? ctx.peopleRecords : [])
    .flatMap((r) => (r && typeof r.name === "string" && r.name.trim() && typeof r.text === "string" ? [{ name: r.name.trim(), text: r.text }] : []))
    .slice(0, 200);
  const said = ` ${foldName(text).replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  const has = (words: string): boolean => !!words && said.includes(` ${words} `);
  const first = (name: string): string => foldName(name).replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ")[0] ?? "";
  const firsts = new Map<string, number>();
  for (const r of records) firsts.set(first(r.name), (firsts.get(first(r.name)) ?? 0) + 1);
  return records
    .filter((r) => has(foldName(r.name).replace(/[^\p{L}\p{N}]+/gu, " ").trim()) || (first(r.name).length >= 2 && firsts.get(first(r.name)) === 1 && has(first(r.name))))
    .slice(0, NAMED_MAX);
}

/**
 * "Owner's language: Spanish (es)": the line that tells a run of its own (an email, a meeting, a Slack answer) which language the owner reads.
 * "" when it is not known: the prompts then say English.
 */
export function languageLine(code: string): string {
  if (!/^[a-z]{2,3}$/.test(code)) return "";
  let name: string | undefined;
  try {
    name = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" }).of(code);
  } catch {
    name = undefined; // no language names on this computer: the code says it
  }
  return `Owner's language: ${name ? `${name} (${code})` : code}`;
}

/** How long the language of the last context read serves an email or a meeting before the context is read again (the owner may switch). */
export const LANGUAGE_FRESH_MS = 30 * 60_000;
/** After a context that could not be read: asked again this much later, not for every email. */
export const LANGUAGE_RETRY_MS = 60_000;

/** The language of Pako's fixed texts: English, whatever the server's context says (an older server may still send "es"). */
export const uiOf = (_ctx?: { uiLanguage?: unknown } | null): Lang => "en";
/** The owner's time zone as the context gives it, when it is a real one; "" otherwise (an older server: UTC days, as before). */
export const zoneOf = (ctx: { timeZone?: unknown } | null | undefined): string => {
  const z = typeof ctx?.timeZone === "string" ? ctx.timeZone : "";
  try {
    return z ? (new Intl.DateTimeFormat("en-CA", { timeZone: z }), z) : "";
  } catch {
    return "";
  }
};

export const dayIn = (at: number, zone: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

/** The few lines that go in front of each message: the date always; the notes and contacts when they are new to this conversation. */
export const contextBlock = (ctx: Context, includeKnown: boolean, wasPaused = false): string => {
  const t = T(uiOf(ctx));
  const lines = [t("now", { now: ctx.now, local: ctx.nowLocal ? ` (${ctx.nowLocal})` : "" })];
  // Neutral: a pause for a store that could not be read ends by itself, with no RESUME from anyone.
  if (!ctx.paused && wasPaused) lines.push(t("pauseOver"));
  // By why: only the owner's pause is a STOP they wrote (an older server gives no reason: the owner's, as before).
  if (ctx.paused) lines.push(t(ctx.pauseWhy === "store-empty" ? "pausedEmpty" : ctx.pauseWhy === "store-unknown" ? "pausedUnknown" : "paused"));
  if (includeKnown) {
    // A conversation that starts again (every few messages, or one that could not be resumed) has no message of theirs to take the language
    // from: a "ok 👍" is answered in the one they write in, not in English by default.
    const chat = languageOf({ language: ctx.chatLanguage });
    if (chat) lines.push(t("chatLanguage", { line: languageLine(chat) }));
    lines.push(t("notes", { name: ctx.ownerName, notes: ctx.memory ? noTags(ctx.memory.replace(/\n+/g, " | ")) : t("noneYetF") }));
    lines.push(t("friends", { list: ctx.contacts.length ? ctx.contacts.join(", ") : t("noneM") }));
    if (ctx.emailOn === true && Array.isArray(ctx.emailContacts)) {
      const names = ctx.emailContacts.filter((e) => typeof e === "string" && e.trim()).slice(0, 50).map(noTags);
      lines.push(t("emailContacts", { list: names.length ? names.join(", ") : t("noneM") }));
    }
    const waiting = Array.isArray(ctx.reminders) ? ctx.reminders.filter((e) => typeof e === "string" && e.trim()) : [];
    lines.push(t("reminders", { list: waiting.length ? waiting.map(noTags).join(" | ") : t("noneM") }));
    // Lists and tasks only from a server that keeps them (an older one sends neither, and Claude is not told it has none).
    for (const k of ["lists", "tasks"] as const) {
      if (!Array.isArray(ctx[k])) continue;
      const got = ctx[k].filter((e) => typeof e === "string" && e.trim()).map(noTags);
      lines.push(t(k, { list: got.length ? got.join(" | ") : t("noneF") }));
    }
    // The people only from a server that keeps them, and only when there is someone (nobody yet needs no line).
    const people = Array.isArray(ctx.people) ? ctx.people.filter((e) => typeof e === "string" && e.trim()).slice(0, 30).map(outside) : [];
    if (people.length) lines.push(t("people", { list: people.join(" | ") }));
    // Routines and watches only from a server that makes them; said only when there is one (no "none" line for every owner).
    for (const k of ["routines", "watches"] as const) {
      const got = Array.isArray(ctx[k]) ? ctx[k].filter((e) => typeof e === "string" && e.trim()).map(noTags) : [];
      if (got.length) lines.push(t(k, { list: got.join(" | ") }));
    }
    const events = Array.isArray(ctx.events) ? ctx.events.filter((e) => typeof e === "string" && e.trim()).map(outside) : [];
    const emails = Array.isArray(ctx.emails) ? ctx.emails.filter((e) => typeof e === "string" && e.trim()).map(outside) : [];
    if (ctx.mailAddress) lines.push(t("mailbox", { address: ctx.mailAddress, list: emails.length ? emails.join(" | ") : t("noneYetM") }));
    if ("calendar" in ctx) {
      const list = Array.isArray(ctx.calendar) ? ctx.calendar.filter((e) => typeof e === "string" && e.trim()).map(outside) : null;
      lines.push(t("calendar", { list: list === null ? t("calendarUnread") : list.length ? list.join(" | ") : t("nothing") }));
    }
    if (ctx.zoom && typeof ctx.zoom === "object") {
      const up = (Array.isArray(ctx.zoom.upcoming) ? ctx.zoom.upcoming : []).filter((e) => typeof e === "string" && e.trim()).map(outside);
      const done = (Array.isArray(ctx.zoom.summaries) ? ctx.zoom.summaries : []).filter((e) => typeof e === "string" && e.trim()).map(outside);
      lines.push(t("zoom", { up: up.length ? up.join(" | ") : t("noneF"), done: done.length ? done.join(" | ") : t("noneM") }));
    }
    // What Pako follows up: other people's asks as Pako read them, one neutralised line each; only when there is one.
    const loops = Array.isArray(ctx.followups) ? ctx.followups.filter((e) => typeof e === "string" && e.trim()).slice(0, 10).map(outside) : [];
    if (loops.length) lines.push(t("followups", { list: loops.join(" | ") }));
    // What is open from the week's meetings and today's brief's to-dos: other people's words as Pako read them, a few lines, only when there are.
    for (const k of ["meetingTodos", "briefTodos"] as const) {
      const got = Array.isArray(ctx[k]) ? ctx[k].filter((e) => typeof e === "string" && e.trim()).slice(0, 8).map(outside) : [];
      if (got.length) lines.push(t(k, { list: got.join(" | ") }));
    }
    if (Array.isArray(ctx.slack)) {
      const list = ctx.slack.filter((e) => typeof e === "string" && e.trim()).map(outside);
      lines.push(t("slack", { list: list.length ? list.join(" | ") : t("noneM") }));
    }
    if (Array.isArray(ctx.bookings)) {
      const list = ctx.bookings.filter((e) => typeof e === "string" && e.trim()).map(outside);
      lines.push(t("bookings", { list: list.length ? list.join(" | ") : t("noneF") }));
    }
    // The papers' summaries: other people's text, one neutralised line each (src/quarantine.ts), so "remind me about it" knows what "it" is.
    const papers = Array.isArray(ctx.papers) ? ctx.papers.filter((e) => typeof e === "string" && e.trim()).slice(0, 3).map(outside) : [];
    if (papers.length) lines.push(paperText("context", uiOf(ctx), { list: papers.join(" | ") }));
    // What they are learning and the coming birthdays (src/companion.ts): the owner's own records; only when there is some.
    for (const k of ["learning", "dates"] as const) {
      const got = Array.isArray(ctx[k]) ? ctx[k].filter((e) => typeof e === "string" && e.trim()).slice(0, 10).map(noTags) : [];
      if (got.length) lines.push(t(k, { list: got.join(" | ") }));
    }
    // Labs off on the server (PAKO_LABS): the diary, lessons and check-in are not there, so the assistant never claims to keep them.
    if (typeof ctx.labsOff === "number" && ctx.labsOff >= 1) lines.push(t("labsOff"));
    if (events.length) lines.push(t("events", { list: events.join(" | ") }));
    // What the owner told about their life (their own words, kept by the server), and the emergency number: only from a server that keeps them.
    const life = Array.isArray(ctx.life) ? ctx.life.filter((e) => typeof e === "string" && e.trim()).slice(0, 30).map(noTags) : [];
    if (life.length) lines.push(t("life", { list: life.join(" | ") }));
    // Dated facts: the owner's own that hold now, and what changed lately (their words and Pako's own records, kept by the server).
    for (const k of ["memoryNow", "memoryChanges"] as const) {
      const got = Array.isArray(ctx[k]) ? ctx[k].filter((e) => typeof e === "string" && e.trim()).slice(0, 10).map(noTags) : [];
      if (got.length) lines.push(t(k, { list: got.join(" | ") }));
    }
    // The number and its crisis line ("911 (for suicidal thoughts: 988)", "131 (…: *4141)", "…: findahelpline.com"): a short line of plain
    // words, digits and the few signs those use, nothing that could carry a tag.
    if (typeof ctx.emergency === "string" && /^[\p{L}\d /()*.,:]{2,100}$/u.test(ctx.emergency)) lines.push(t("emergency", { number: ctx.emergency }));
  }
  return lines.join("\n");
};
