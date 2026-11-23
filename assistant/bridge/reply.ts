// Reading an answer: the tags parseReply takes out of its text, and readReply, which folds in the accepted calls to Pako's tools.

import { applyToolCalls, type CalendarProposal } from "../tools.ts";
import type { ClaudeResult } from "./claude.ts";

export interface ParsedReply {
  text: string;
  remember: string[];
  forget: string[];
  call: { name: string; message: string; direct: boolean } | null;
  /** A WhatsApp the owner sends from their own phone: to a name from the list or a number they typed, and the words. */
  message: { to: string; text: string } | null;
  /** A WhatsApp the assistant sends from its own number once the owner presses Enviar. */
  send: { to: string; text: string } | null;
  /** An email from Pako's own inbox (<email>, src/autonomy.ts): to a name of the context's list or an address. Only when there is one. */
  email?: { to: string; subject: string; text: string };
  /**
   * Reminders to keep (the moment is "YYYY-MM-DD HH:MM" in the owner's time zone; `every` for one that repeats) and words of reminders to
   * delete.
   */
  remind: { at: string; text: string; every?: string }[];
  unremind: string[];
  /**
   * Newer tags, present only when the answer has them (an older server never gets them): items added to or taken off a named list, tasks to
   * keep (with their day, "YYYY-MM-DD"), and words of open tasks now done.
   */
  lists?: { name: string; op: "add" | "remove"; items: string[] }[];
  tasks?: { text: string; due?: string }[];
  done?: string[];
  /** Words of follow-ups the owner said are handled (<closed>, close_followup): the server closes the one open loop they name. */
  closed?: string[];
  /** Promises the owner made in this chat (<promise>, keep_promise): the server keeps each as their own follow-up. */
  promises?: { text: string; who?: string; due?: string }[];
  /**
   * Someone in the owner's life, as the owner told it (<person>, src/people.ts): the name, and only the parts said. Present only when the
   * answer has one.
   */
  people?: PersonTag[];
  /**
   * Newer still (<routine>, <watch>; src/routines.ts), present only when the answer has them: a prompt to run on a schedule (its first time
   * "YYYY-MM-DD HH:MM" in the owner's zone, and how often), and a condition to watch for in the mail, the calendar or Slack.
   */
  routines?: { at: string; every: string; text: string }[];
  watches?: { on: string; from?: string; words?: string; once: boolean; text: string }[];
  /**
   * Newer still (<fact>; src/proactive.ts), present only when the answer has one: something lasting the owner said about their tastes, plans
   * or life, typed (comida, dieta, viaje, aficion, deporte, persona, meta, animo, salud), with what it is about and, for a hobby, how often.
   */
  facts?: FactTag[];
  /**
   * Newer still (<know>; src/memory-facts.ts), present only when the answer has one: a dated fact the owner told about themselves or someone
   * (who, what it is about, its value, and since when when they said). Kept only from the owner's own turn.
   */
  know?: KnowTag[];
  /**
   * More than an assistant (src/companion.ts), present only when the answer has them: notes for the owner's health diary (<health kind>),
   * learning goals (<goal>) and quiz cards from a lesson (<card goal q a/>). Kept only from the owner's own turn.
   */
  health?: { kind: string; text: string }[];
  goals?: string[];
  cards?: { goal: string; q: string; a: string }[];
  /** A search of the owner's Slack the assistant wants before answering (Slack's search syntax). */
  slack: string | null;
  /** A table to look for: what and where, the owner's local time "YYYY-MM-DD HH:MM", how many, and notes for the restaurant. The server searches and asks the owner. */
  book: { what: string; when: string; party: number; notes?: string; name?: string } | null;
  /**
   * A brain dump (<dump kind>, brain_dump; src/gentle-dump.ts), present only when the answer has one: the owner's own list sorted into
   * reminders (with their time), their promises, tasks and notes. The server makes them and shows one card for all of them.
   */
  dump?: DumpTag[];
  /**
   * Check-ins the owner asked for (<checkin>, check_in; src/gentle-checkins.ts): at their time Pako asks "Started on …?". `at` is
   * "YYYY-MM-DD HH:MM" in their zone, `in` minutes from now; `text` what it is about ("" for nothing named). Present only when there is one.
   */
  checkins?: CheckinTag[];
}

export interface CheckinTag {
  text: string;
  at?: string;
  in?: number;
}

export interface DumpTag {
  kind: "reminder" | "promise" | "task" | "note";
  text: string;
  at?: string;
  who?: string;
  due?: string;
}
/** Items one brain dump may hold (src/gentle-dump.ts DUMP_MAX). */
export const DUMP_TAGS_MAX = 12;

export interface FactTag {
  kind: string;
  key?: string;
  text: string;
  every?: number;
  done?: string;
}

export interface KnowTag {
  /** Whom it is about, as the owner calls them; absent: the owner. */
  who?: string;
  key: string;
  value: string;
  /** "YYYY-MM-DD": since when it is true, when the owner said. */
  since?: string;
  /** "YYYY-MM-DD": a change still to come starts that day; what holds now stays true until then. */
  starts?: string;
}

export interface PersonTag {
  name: string;
  relation?: string;
  birthday?: string;
  likes?: string[];
  notes?: string[];
}

/** One <person> tag's attributes and body (a thing to remember about them), or null without a name. At most three per answer. */
function personTag(attrs: string, body: string): PersonTag | null {
  const attr = (n: string): string => (new RegExp(`\\b${n}\\s*=\\s*"([^"<>]{1,300})"`, "i").exec(attrs)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const name = attr("name").slice(0, 60);
  if (!name) return null;
  const relation = attr("relation").slice(0, 60);
  const birthday = attr("birthday").slice(0, 20);
  const likes = attr("likes").split(";").map((x) => x.trim().slice(0, 80)).filter(Boolean).slice(0, 10);
  const note = body.replace(/\s+/g, " ").trim().slice(0, 200);
  return { name, ...(relation ? { relation } : {}), ...(birthday ? { birthday } : {}), ...(likes.length ? { likes } : {}), ...(note ? { notes: [note] } : {}) };
}

/** A tag left half open or stray, of any kind parseReply reads: never sent to the owner as text. */
const STRAY_TAG = new RegExp(
  "</?(remember|forget|call|message|send|email|remind|unremind|slack|book|list|task|done|closed|promise|person|routine|watch|fact|know|health"
    + "|goal|card|dump|checkin)\\b[^>\\n]{0,300}>?",
  "gi",
);

/** Reads the tags out of an answer and removes every trace of them from the text. */
export function parseReply(raw: string): ParsedReply {
  const remember: string[] = [];
  const forget: string[] = [];
  const found: { call: ParsedReply["call"]; message: ParsedReply["message"]; send: ParsedReply["send"] } = { call: null, message: null, send: null };
  const words = (msg: string): string => msg.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  const remind: ParsedReply["remind"] = [];
  const unremind: string[] = [];
  let slack: string | null = null;
  let book: ParsedReply["book"] = null;
  let email: ParsedReply["email"];
  const lists: NonNullable<ParsedReply["lists"]> = [];
  const tasks: NonNullable<ParsedReply["tasks"]> = [];
  const done: string[] = [];
  const closed: string[] = [];
  const promises: NonNullable<ParsedReply["promises"]> = [];
  const people: PersonTag[] = [];
  const routines: NonNullable<ParsedReply["routines"]> = [];
  const watches: NonNullable<ParsedReply["watches"]> = [];
  const facts: FactTag[] = [];
  const know: KnowTag[] = [];
  const health: NonNullable<ParsedReply["health"]> = [];
  const goals: string[] = [];
  const cards: NonNullable<ParsedReply["cards"]> = [];
  const dump: DumpTag[] = [];
  const checkins: CheckinTag[] = [];
  const attrOf = (attrs: string, n: string): string | undefined => new RegExp(`\\b${n}\\s*=\\s*"([^"<>]{1,60})"`, "i").exec(attrs)?.[1]?.trim();
  const attrLong = (attrs: string, n: string): string =>
    (new RegExp(`\\b${n}\\s*=\\s*"([^"<>]{1,200})"`, "i").exec(attrs)?.[1] ?? "").replace(/\s+/g, " ").trim();
  let text = raw
    // Three facts at most per answer, each short: what the owner said about their life, typed.
    .replace(/<fact\s+((?:[^<>"]|"[^"<>]{0,60}"){1,200})>([\s\S]{0,600}?)<\/fact>/gi, (_m, attrs: string, body: string) => {
      const kind = attrOf(attrs, "kind")?.toLowerCase();
      const what = body.replace(/\s+/g, " ").trim().slice(0, 200);
      const every = Number(attrOf(attrs, "every"));
      const key = attrOf(attrs, "key");
      const done = attrOf(attrs, "done");
      if (kind && what && facts.length < 3) {
        facts.push({ kind, text: what, ...(key ? { key } : {}), ...(Number.isInteger(every) && every > 0 ? { every } : {}), ...(done ? { done } : {}) });
      }
      return "";
    })
    // Dated facts (src/memory-facts.ts): three at most per answer, each short; the value is the body.
    .replace(/<know\s+((?:[^<>"]|"[^"<>]{0,60}"){1,200})>([\s\S]{0,600}?)<\/know>/gi, (_m, attrs: string, body: string) => {
      const key = attrOf(attrs, "key");
      const who = attrOf(attrs, "who");
      const since = attrOf(attrs, "since");
      const starts = attrOf(attrs, "starts");
      const value = body.replace(/\s+/g, " ").trim().slice(0, 300);
      if (key && value && know.length < 3) {
        know.push({ key, value, ...(who ? { who } : {}), ...(since && /^\d{4}-\d{2}-\d{2}$/.test(since) ? { since } : {}),
          ...(starts && /^\d{4}-\d{2}-\d{2}$/.test(starts) ? { starts } : {}) });
      }
      return "";
    })
    // The health diary, learning goals and quiz cards (src/companion.ts): a few per answer, short.
    .replace(/<health(\s+[^<>]{0,100})?>([\s\S]{0,1000}?)<\/health>/gi, (_m, attrs: string | undefined, body: string) => {
      const what = body.replace(/\s+/g, " ").trim().slice(0, 300);
      const kind = (attrs ? attrOf(attrs, "kind") : undefined)?.toLowerCase() ?? "other";
      if (what && health.length < 3) health.push({ kind: kind.slice(0, 20), text: what });
      return "";
    })
    .replace(/<goal>([\s\S]{0,200}?)<\/goal>/gi, (_m, body: string) => {
      const what = body.replace(/\s+/g, " ").trim().slice(0, 60);
      if (what && goals.length < 2) goals.push(what);
      return "";
    })
    .replace(/<card\s+((?:[^<>"]|"[^"<>]{0,200}"){1,700}?)\s*(?:\/>|><\/card>)/gi, (_m, attrs: string) => {
      const goal = attrLong(attrs, "goal").slice(0, 60);
      const q = attrLong(attrs, "q");
      const a = attrLong(attrs, "a").slice(0, 120);
      if (goal && q && a && cards.length < 5) cards.push({ goal, q, a });
      return "";
    })
    // One routine and one watch at most per answer: each is a standing order, made only when the owner asks for it.
    .replace(/<routine\s+((?:[^<>"]|"[^"<>]{0,60}"){1,200})>([\s\S]{0,2000}?)<\/routine>/gi, (_m, attrs: string, body: string) => {
      const at = attrOf(attrs, "at");
      const every = attrOf(attrs, "every")?.toLowerCase();
      const what = body.replace(/\s+/g, " ").trim();
      if (at && every && what && !routines.length) routines.push({ at, every, text: what });
      return "";
    })
    .replace(/<watch\s+((?:[^<>"]|"[^"<>]{0,60}"){1,300})>([\s\S]{0,2000}?)<\/watch>/gi, (_m, attrs: string, body: string) => {
      const on = attrOf(attrs, "on")?.toLowerCase();
      const from = attrOf(attrs, "from");
      const words = attrOf(attrs, "words");
      const what = body.replace(/\s+/g, " ").trim();
      if (on && what && (from || words) && !watches.length) {
        watches.push({ on, ...(from ? { from } : {}), ...(words ? { words } : {}), once: !/^(false|no|0)$/i.test(attrOf(attrs, "once") ?? ""), text: what });
      }
      return "";
    })
    // Lists and tasks first: their words are the owner's, and "; " or a new line separates a list's items.
    .replace(/<list\s+((?:[^<>"]|"[^"<>]{0,60}"){1,200})>([\s\S]{0,2000}?)<\/list>/gi, (_m, attrs: string, body: string) => {
      const name = attrOf(attrs, "name")?.replace(/\s+/g, " ");
      const op = /\bremove\b/i.test(attrs.replace(/"[^"]*"/g, "")) ? "remove" : /\badd\b/i.test(attrs.replace(/"[^"]*"/g, "")) ? "add" : null;
      const items = body.split(/[;\n]/).map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 10);
      if (name && op && items.length && lists.length < 2) lists.push({ name, op, items });
      return "";
    })
    .replace(/<task(\s+[^<>]{0,200})?>([\s\S]{0,2000}?)<\/task>/gi, (_m, attrs: string | undefined, body: string) => {
      const what = body.replace(/\s+/g, " ").trim();
      const due = attrs ? attrOf(attrs, "due") : undefined;
      if (what && tasks.length < 3) tasks.push({ text: what, ...(due ? { due } : {}) });
      return "";
    })
    .replace(/<done>([\s\S]{0,2000}?)<\/done>/gi, (_m, w: string) => {
      const words = w.replace(/\s+/g, " ").trim();
      if (words && done.length < 3) done.push(words);
      return "";
    })
    .replace(/<promise(\s+[^<>]{0,300})?>([\s\S]{0,2000}?)<\/promise>/gi, (_m, attrs: string | undefined, body: string) => {
      const what = body.replace(/\s+/g, " ").trim().slice(0, 200);
      const who = attrs ? attrOf(attrs, "who") : undefined;
      const due = attrs ? attrOf(attrs, "due") : undefined;
      if (what && promises.length < 2) promises.push({ text: what, ...(who ? { who } : {}), ...(due ? { due } : {}) });
      return "";
    })
    // A brain dump's items, one tag each: <dump kind="reminder" at="2026-11-20 10:00">call the dentist</dump>.
    .replace(/<dump(\s+[^<>]{0,300})?>([\s\S]{0,1000}?)<\/dump>/gi, (_m, attrs: string | undefined, body: string) => {
      const what = body.replace(/\s+/g, " ").trim().slice(0, 200);
      const kind = attrs ? attrOf(attrs, "kind")?.toLowerCase() : undefined;
      if (!what || dump.length >= DUMP_TAGS_MAX || (kind !== "reminder" && kind !== "promise" && kind !== "task" && kind !== "note")) return "";
      const at = attrs ? attrOf(attrs, "at") : undefined;
      const who = attrs ? attrOf(attrs, "who") : undefined;
      const due = attrs ? attrOf(attrs, "due") : undefined;
      dump.push({ kind, text: what, ...(at ? { at } : {}), ...(who ? { who } : {}), ...(due ? { due } : {}) });
      return "";
    })
    // A check-in: <checkin at="2026-11-20 15:00">the deck</checkin>, or in="20" (minutes from now); the body may be empty, or <checkin … />.
    .replace(/<checkin(\s+[^<>]{0,200}?)?\s*(?:\/>|>([\s\S]{0,400}?)<\/checkin>)/gi, (_m, attrs: string | undefined, body: string | undefined) => {
      const what = (body ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      const at = attrs ? attrOf(attrs, "at") : undefined;
      const mins = attrs ? attrOf(attrs, "in") : undefined;
      const n = mins && /^\d{1,5}$/.test(mins) ? Number(mins) : NaN;
      if (checkins.length >= 2) return "";
      if (n >= 1 && n <= 7 * 24 * 60) checkins.push({ text: what, in: n });
      else if (at && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(at)) checkins.push({ text: what, at });
      return "";
    })
    .replace(/<closed>([\s\S]{0,2000}?)<\/closed>/gi, (_m, w: string) => {
      const words = w.replace(/\s+/g, " ").trim().slice(0, 80);
      if (words && closed.length < 3) closed.push(words);
      return "";
    })
    // Someone in the owner's life; a tag closed on itself (<person name="Ana" relation="mi hermana"/>) has no thing to remember.
    .replace(/<person\s+((?:[^<>"]|"[^"<>]{0,300}"){1,900}?)(?:\/>|>([\s\S]{0,2000}?)<\/person>)/gi, (_m, attrs: string, body: string | undefined) => {
      const p = personTag(attrs, body ?? "");
      if (p && people.length < 3) people.push(p);
      return "";
    })
    .replace(/<book\s+((?:[^<>"]|"[^"<]{0,300}"){1,600})>([\s\S]{0,2000}?)<\/book>/gi, (_m, attrs: string, what: string) => {
      const attr = (n: string): string | undefined => new RegExp(`\\b${n}\\s*=\\s*"([^"]{1,300})"`, "i").exec(attrs)?.[1]?.trim();
      const when = attr("when");
      const party = Number(attr("party"));
      const w = what.replace(/\s+/g, " ").trim().slice(0, 200);
      if (!book && when && Number.isInteger(party) && w) book = { what: w, when, party, ...(attr("notes") ? { notes: attr("notes")! } : {}), ...(attr("name") ? { name: attr("name")! } : {}) };
      return "";
    })
    .replace(/<slack>([\s\S]{0,2000}?)<\/slack>/gi, (_m, q: string) => {
      slack ??= q.replace(/\s+/g, " ").trim().slice(0, 200) || null;
      return "";
    })
    .replace(/<remember>([\s\S]{0,2000}?)<\/remember>/gi, (_m, t: string) => {
      remember.push(t);
      return "";
    })
    .replace(/<forget>([\s\S]{0,2000}?)<\/forget>/gi, (_m, t: string) => {
      forget.push(t);
      return "";
    })
    .replace(/<call\s+to\s*=\s*"([^"<>]{1,40})"(?:\s+direct\s*=\s*"(true|false)")?\s*>([\s\S]{0,2000}?)<\/call>/gi, (_m, name: string, direct: string | undefined, msg: string) => {
      found.call ??= { name: name.trim(), message: msg.replace(/\s+/g, " ").trim(), direct: direct === "true" };
      return "";
    })
    .replace(/<message\s+to\s*=\s*"([^"<>]{1,40})"\s*>([\s\S]{0,2000}?)<\/message>/gi, (_m, to: string, msg: string) => {
      found.message ??= { to: to.trim(), text: words(msg) };
      return "";
    })
    .replace(/<send\s+to\s*=\s*"([^"<>]{1,40})"\s*>([\s\S]{0,2000}?)<\/send>/gi, (_m, to: string, msg: string) => {
      found.send ??= { to: to.trim(), text: words(msg) };
      return "";
    })
    .replace(/<email\s+((?:[^<>"]|"[^"<>]{0,200}"){1,400})>([\s\S]{0,2000}?)<\/email>/gi, (_m, attrs: string, msg: string) => {
      const attr = (n: string): string => (new RegExp(`\\b${n}\\s*=\\s*"([^"<>]{1,200})"`, "i").exec(attrs)?.[1] ?? "").replace(/\s+/g, " ").trim();
      const to = attr("to").slice(0, 120);
      const body = words(msg);
      if (!email && to && body) email = { to, subject: attr("subject").slice(0, 150), text: body.slice(0, 3000) };
      return "";
    })
    .replace(/<remind\s+at\s*=\s*"([^"<>]{1,20})"(?:\s+every\s*=\s*"([a-z]{1,10})")?\s*>([\s\S]{0,2000}?)<\/remind>/gi, (_m, at: string, every: string | undefined, msg: string) => {
      // "every" goes only when it is one the server knows: an older server ignores it, and the reminder still fires once.
      const rule = every && /^(day|weekday|week|month|year)$/i.test(every) ? every.toLowerCase() : undefined;
      if (remind.length < 2) remind.push({ at: at.trim(), text: msg.replace(/\s+/g, " ").trim(), ...(rule ? { every: rule } : {}) });
      return "";
    })
    .replace(/<unremind>([\s\S]{0,2000}?)<\/unremind>/gi, (_m, w: string) => {
      if (unremind.length < 2) unremind.push(w.replace(/\s+/g, " ").trim());
      return "";
    });
  // A tag left half open or malformed is never sent to the owner as text.
  // Bounded to one line and 300 characters (an opener left without its ">" must not swallow the rest of the answer), and repeated until nothing changes
  // (`<rem<remember>ember>` would otherwise leave a live tag behind).
  for (let before = ""; before !== text; ) {
    before = text;
    text = text.replace(STRAY_TAG, "");
  }
  text = text.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return {
    text, remember: remember.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean), forget: forget.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean),
    call: found.call?.message ? found.call : null, message: found.message?.text ? found.message : null, send: found.send?.text ? found.send : null,
    remind: remind.filter((r) => r.at && r.text), unremind: unremind.filter(Boolean), slack, book,
    ...(lists.length ? { lists } : {}), ...(tasks.length ? { tasks } : {}), ...(done.length ? { done } : {}), ...(closed.length ? { closed } : {}),
    ...(promises.length ? { promises } : {}), ...(people.length ? { people } : {}), ...(routines.length ? { routines } : {}), ...(watches.length ? { watches } : {}),
    ...(email ? { email } : {}), ...(facts.length ? { facts } : {}), ...(know.length ? { know } : {}),
    ...(health.length ? { health } : {}), ...(goals.length ? { goals } : {}), ...(cards.length ? { cards } : {}), ...(dump.length ? { dump } : {}),
    ...(checkins.length ? { checkins } : {}),
  };
}

/**
 * What a turn asked for: the tags of its text (parseReply) and the accepted calls to Pako's tools, folded into the one ParsedReply the rest
 * of the bridge and the server already know. A turn with no tools is parseReply's alone.
 */
export function readReply(r: Pick<ClaudeResult, "text" | "toolCalls">): ParsedReply & { calendar?: CalendarProposal[] } {
  const parsed = parseReply(r.text);
  return r.toolCalls?.length ? applyToolCalls(parsed, r.toolCalls) : parsed;
}

/**
 * The text tags an answer acted through (by name), from the parsed tags alone, never the tool calls: an empty list when the answer used none.
 * The tags are the fallback path now (docs/how-it-works.md): turn.ts counts every turn that still uses them.
 */
export function tagActions(raw: string): string[] {
  const p = parseReply(raw);
  const has: [string, boolean][] = [
    ["remember", p.remember.length > 0], ["forget", p.forget.length > 0], ["call", !!p.call], ["message", !!p.message], ["send", !!p.send],
    ["email", !!p.email], ["remind", p.remind.length > 0], ["unremind", p.unremind.length > 0], ["slack", !!p.slack], ["book", !!p.book],
    ["list", !!p.lists], ["task", !!p.tasks], ["done", !!p.done], ["closed", !!p.closed], ["promise", !!p.promises], ["person", !!p.people],
    ["routine", !!p.routines], ["watch", !!p.watches], ["fact", !!p.facts], ["know", !!p.know], ["health", !!p.health], ["goal", !!p.goals],
    ["card", !!p.cards], ["dump", !!p.dump], ["checkin", !!p.checkins],
  ];
  return has.filter(([, yes]) => yes).map(([name]) => name);
}
