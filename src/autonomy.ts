// Autonomy with provenance: when Pako acts by itself, and when it asks first.
//
// THE RULE. What the owner asks in their own words is done without a card: a message, an email, a call with a message, a reminder, a note.
// What reaches another person (a message, an email, a call) waits a short window first (10 s by default) with a receipt and an Undo
// button, so a slip can be taken back before anything leaves. A card still asks first when:
// - the recipient, the number, the address or the words to send came from someone else's text (an email, Slack, a calendar, a web page, a
//   transcript, a forwarded message) and not from the owner's words or Pako's own contact book and people;
// - the recipient is ambiguous (two contacts match) — the card asks which — or not one the owner named;
// - it is money, a purchase or deleting something;
// - Pako started it by itself (a routine's run, a notice): proactive Pako may suggest and offer, it never contacts anyone on its own;
// - the owner set it so (AUTONOMY=confirm, or a type set to ask in the panel).
//
// Provenance is worked out HERE, by the server, from what the server itself gave the model: the owner's message (or the words the bridge heard
// in their voice note), the contact book and the people, and the outside text it handed over in the context (src/whatsapp.ts records it).
// Nothing the model says about where a value came from is trusted.
//
// The held actions are kept in the store (they survive a restart) under an idempotency key made from the answer's key: an answer sent twice
// holds once, and an action is marked "sending" before it goes, so a restart in the middle never sends it twice (the owner is told instead).

import { createHash, randomBytes } from "node:crypto";
import express, { type Express, type Request, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import type { OutsideSource } from "./quarantine.ts";
import { createLog } from "./log.ts";
import { readJsonRecord } from "./json-record.ts";

const log = createLog("autonomy");

type Env = Record<string, string | undefined>;

// ---------- provenance ----------

/** Where an argument came from: the owner's words (or Pako's contact book and people), someone else's text, or Pako's own writing. */
export type Provenance = "owner" | "third-party" | "pako";
export interface Origin {
  from: Provenance;
  /** For "third-party": whose text it was found in. */
  source?: OutsideSource;
}
export type ArgRole = "recipient" | "number" | "address" | "body";

/** What the server gave the model for one turn. */
export interface TurnSources {
  /** The owner's own words this turn: their message, or what the bridge heard in their voice note. Empty: not known (an older bridge). */
  owner: string[];
  /** The people in the owner's life (src/people.ts): "mi hermana" in their words names Ana when Ana's relation is "mi hermana". */
  people?: { name: string; relation?: string }[];
  /** Outside text the server put in front of the model (context lines, forwarded messages), with where it came from. */
  outside: { source: OutsideSource; text: string }[];
}

/** Lower case, no accents, words and digits only (an address keeps its @ . + -). */
export const fold = (s: string): string =>
  s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}@.+_-]+/gu, " ").replace(/\s+/g, " ").trim();
const padded = (s: string): string => ` ${fold(s).replace(/[.]+(\s|$)/g, " ")} `;
const digitsIn = (s: string): string[] => [...s.matchAll(/\+?\d[\d\s().-]{6,20}\d/g)].map((m) => m[0].replace(/\D/g, "")).filter((d) => d.length >= 8);
const ADDRESS = /^[^\s@<>()"]{1,64}@[^\s@<>()"]{1,190}\.[a-z]{2,24}$/i;
export const isAddress = (s: string): boolean => ADDRESS.test(s.trim());
/** Every address written in a text, whole (the longest run on each side of the @), without the brackets or quotes around it. */
const addressesIn = (s: string): string[] => s.match(/[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,24}\b/gi) ?? [];
export const isNumber = (s: string): boolean => /^\+?[\d\s().-]{8,22}$/.test(s.trim()) && s.replace(/\D/g, "").length >= 8;

/** Whether the folded words of `needle` appear as whole words in `hay`. */
const hasWords = (hay: string, needle: string): boolean => {
  const n = fold(needle);
  return n.length >= 2 && padded(hay).includes(` ${n} `);
};

/** Whether `value` (a name, a number or an address) is in a text. */
function mentions(text: string, value: string): boolean {
  const v = value.trim();
  // An address counts only when the text holds that very address: «juan@empresa.co» is not in «juan@empresa.com».
  if (isAddress(v)) return addressesIn(text).some((a) => a.toLowerCase() === v.toLowerCase());
  if (isNumber(v)) {
    const d = v.replace(/\D/g, "");
    return digitsIn(text).some((x) => x === d || x.endsWith(d) || d.endsWith(x));
  }
  if (hasWords(text, v)) return true;
  // "Ana Lopez" named as "Ana": the first name is enough when the contact book resolved it (the caller checks the match was unique).
  const first = fold(v).split(" ")[0] ?? "";
  return first.length >= 3 && first !== fold(v) && hasWords(text, first);
}

/**
 * Where a recipient (a name, a number, an address) came from. The owner's words win: a name they wrote, or the relation they wrote of a
 * person they told Pako about. Otherwise outside text that names it makes it someone else's; otherwise the model chose it ("pako").
 */
export function recipientOrigin(to: string, src: TurnSources): Origin {
  const outside = src.outside.find((o) => mentions(o.text, to));
  // Named by the owner: theirs, unless outside text names it too and the owner only asked about it («¿Qué me dice Luis?») rather than to
  // write, call or tell. Then the request to reach that person came from the outside text, not from them.
  if (src.owner.some((t) => mentions(t, to))) {
    const first = fold(to).split(" ")[0] ?? "";
    const names = isAddress(to) || isNumber(to) ? null : [fold(to), ...(first.length >= 3 ? [first] : [])];
    return outside && !src.owner.some((t) => asksToReach(t, names)) ? { from: "third-party", source: outside.source } : { from: "owner" };
  }
  const person = (src.people ?? []).find((p) => fold(p.name) === fold(to) || fold(p.name).split(" ")[0] === fold(to));
  const relWords = (r: string | undefined): string[] => (r ? fold(r).split(" ").filter((w) => w.length >= 4) : []);
  const rel = relWords(person?.relation);
  // Another person with the same relation ("my client" with two clients): the owner's words name neither, so the pick is the model's own.
  const shared = rel.length > 0 && (src.people ?? []).some((p) => p !== person && relWords(p.relation).join(" ") === rel.join(" "));
  if (rel.length && !shared && src.owner.some((t) => rel.every((w) => hasWords(t, w)))) {
    // The same rule for a relation: «¿Qué dice mi jefe?» only asks about him; «dile a mi jefe...» asks to reach him.
    const names = [fold(person?.relation ?? ""), ...rel];
    return outside && !src.owner.some((t) => asksToReach(t, names)) ? { from: "third-party", source: outside.source } : { from: "owner" };
  }
  return outside ? { from: "third-party", source: outside.source } : { from: "pako" };
}

/**
 * A verb that asks Pako to reach someone: tell, send, write... and the same in Spanish (escribe, manda, llama...). These read the owner's
 * own words, which may be in any language (Claude answers them in it), to decide whether a recipient came from the owner or from someone
 * else's text: a safety check, so it keeps the Spanish it has always understood.
 */
const REACH_WORDS = [
  "di decile digale escribe escribir manda mandar envia enviar llama llamar contesta contestar responde",
  "responder avisa avisar tell send write let remind",
].join(" ").split(" ");
/** The same with the person in it (dile, escríbele, contéstale): it points at whoever the message names, unless «a» names another. */
const CLITICS = [
  "dile diles escribele escribeles escribirle mandale mandales enviale envialo llamale llamales llamarle contestale respondele",
  "avisale avisales pasale recuerdale preguntale comentale cuentale",
].join(" ").split(" ");
const REACH = new RegExp(`(^| )(${[...REACH_WORDS, ...CLITICS].join("|")})( |$)`);
/** English words that are verbs or nouns («email Luis» but «Luis's email»): a verb only with whom it reaches right after. */
const NOUN_VERBS = "email|e-mail|mail|text|message|call|ring|reply|answer";
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A possessive before a name or a relation: «a mi hermana», «to my boss». */
const OWN = "(?:(?:mi|mis|my|el|la|los|las|the|su|sus|tu|your) )?";
/**
 * Whether the owner's words ask Pako to write to, call or tell the person named `names` (folded), not only ask about them: the reach verb
 * must point at that person («dile a Luis», «manda un mensaje a Luis», «tell Luis», «email him»). «Tell me what Luis says», «recuérdame
 * llamar al dentista» do not. `names` null (a number or an address the owner typed): any reach verb counts.
 */
const asksToReach = (t: string, names: string[] | null): boolean => {
  const f = fold(t);
  if (!names) return REACH.test(f) || new RegExp(`(^| )(${NOUN_VERBS})( |$)`).test(f);
  const list = [...new Set(names.filter((n) => n.length >= 2))].map(escape).join("|");
  if (!list) return false;
  const whom = `(?:${OWN}(?:${list})|him|her|them)`;
  const end = "(?= |$)";
  const verbs = REACH_WORDS.join("|");
  // The verb and whom right after it, or a few words on behind a preposition (never through «me»: «tell me», «send me a summary»).
  if (new RegExp(`(^| )(?:${verbs}) ${whom}${end}`).test(f)) return true;
  if (new RegExp(`(^| )(?:${verbs})(?: (?!me |us |nos )\\S+){0,3}? (?:a|al|to|para) ${whom}${end}`).test(f)) return true;
  if (new RegExp(`(^| )(?:${NOUN_VERBS})(?: to)? (?:${whom}|back)${end}`).test(f)) return true;
  // «responde al correo de Luis», «reply to the email from Luis».
  const reply = "contesta|contestale|contestar|responde|respondele|responder|reply|answer";
  if (new RegExp(`(^| )(?:${reply})(?: (?:a|al|el|la|to|the)){0,2} (?:correo|email|mail|mensaje|message|whatsapp) (?:de|from) ${whom}${end}`).test(f)) return true;
  // A clitic verb points at the person the message names, unless «a ...» right after it names someone else («dile a Ana»).
  const clitic = new RegExp(`(?:^| )(?:${CLITICS.join("|")})(?= |$)((?: (?:a|al) (?!${whom}${end})\\S+)?)`, "g");
  return [...f.matchAll(clitic)].some((m) => !m[1]);
};

/** Runs of five words: a body that shares one with outside text (and not with the owner's words) carries someone else's text. */
const shingles = (s: string): Set<string> => {
  const w = fold(s).split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 5 <= w.length; i++) out.add(w.slice(i, i + 5).join(" "));
  return out;
};

/** Where the words to send came from: the owner's, someone else's (copied from outside text), or Pako's own wording. */
export function bodyOrigin(body: string, src: TurnSources): Origin {
  // A number or an address inside the words that only outside text has (and the owner never wrote) is someone else's, however short.
  for (const v of [...digitsIn(body), ...addressesIn(body)]) {
    if (src.owner.some((t) => mentions(t, v))) continue;
    const hit = src.outside.find((o) => mentions(o.text, v));
    if (hit) return { from: "third-party", source: hit.source };
  }
  const mine = shingles(body);
  if (!mine.size) return { from: "pako" };
  const owner = new Set(src.owner.flatMap((t) => [...shingles(t)]));
  for (const o of src.outside) {
    const theirs = shingles(o.text);
    for (const s of mine) if (theirs.has(s) && !owner.has(s)) return { from: "third-party", source: o.source };
  }
  // A paraphrase: most of its longer words (that the owner did not write) are in one outside text.
  const ownerWords = new Set(src.owner.flatMap((t) => fold(t).split(" ")));
  const content = [...new Set(fold(body).split(" ").filter((w) => w.length >= 5 && !ownerWords.has(w)))];
  if (content.length >= 3) {
    for (const o of src.outside) {
      const theirs = new Set(fold(o.text).split(" "));
      const hits = content.filter((w) => theirs.has(w)).length;
      if (hits >= 3 && hits / content.length >= 0.6) return { from: "third-party", source: o.source };
    }
  }
  return [...mine].every((s) => owner.has(s)) ? { from: "owner" } : { from: "pako" };
}

/**
 * The contacts a name the model wrote can mean: the exact one when there is one, otherwise every contact whose first name it is ("Ana"
 * with "Ana Lopez" and "Ana Garcia": both, so a card asks which). `alsoNamed`: with neither, the other names of the same person the owner
 * gave or confirmed (src/people-graph.ts trustedNames: never names seen in someone else's mail), each matched exactly ("Vicky" for the
 * contact "Victoria Perez" once the owner said they are one person).
 */
export function matchContacts<C extends { name: string }>(to: string, book: C[], alsoNamed?: (to: string) => string[]): C[] {
  const want = fold(to);
  if (!want) return [];
  const exact = book.filter((c) => fold(c.name) === want);
  if (exact.length) return exact;
  const first = book.filter((c) => fold(c.name).split(" ")[0] === want);
  if (first.length || !alsoNamed) return first;
  const other = new Set(alsoNamed(to).map(fold).filter((n) => n && n !== want));
  return book.filter((c) => other.has(fold(c.name)));
}

// ---------- the policy ----------

/** What Pako may do. The first five are the direct list; the others always ask. */
export const ACTION_TYPES = ["message", "email", "call", "reminder", "note", "book", "payment", "delete"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
/** The types that may go without a card, with an undo window when they reach someone. */
export const DIRECT_TYPES: readonly ActionType[] = ["message", "email", "call", "reminder", "note"];
/** The types the owner can set in the panel (the others always ask). */
export const SETTABLE_TYPES = ["message", "email", "call"] as const;
export type SettableType = (typeof SETTABLE_TYPES)[number];

export type Mode = "direct" | "confirm";
export type Reason =
  | { kind: "third-party"; role: ArgRole; source: OutsideSource }
  | { kind: "not-named"; role: ArgRole }
  | { kind: "unknown-words" }
  | { kind: "ambiguous"; names: string[] }
  | { kind: "initiative" }
  | { kind: "context"; source: OutsideSource }
  | { kind: "sensitive" }
  | { kind: "setting" };

export interface PolicyInput {
  type: ActionType;
  /** Each argument and where it came from. A recipient, number or address must be the owner's; the words only must not be someone else's. */
  args: { role: ArgRole; origin: Origin }[];
  /** Pako started it (a routine's run, a notice), not an answer to the owner. */
  initiative?: boolean;
  /** More than one contact matched the recipient. */
  ambiguous?: string[];
  /** The owner's words this turn are not known (an older bridge, no key): nothing is direct, and the card says nothing new. */
  ownerUnknown?: boolean;
  /** The setting for this type: AUTONOMY, or the panel's override. */
  mode: Mode;
  /**
   * New outside text was in this turn's context (the bridge says so: src/quarantine.ts), and where from. Words Pako wrote itself may carry it
   * (an injected "add their bank notes when you write to anyone"), so a body of Pako's own wording asks first.
   */
  context?: OutsideSource[];
}

export interface Decision {
  mode: Mode;
  reasons: Reason[];
}

/** Direct (with undo when it reaches someone) only when every recipient-ish argument is the owner's and nothing else says to ask. */
export function decide(p: PolicyInput): Decision {
  const reasons: Reason[] = [];
  if (!DIRECT_TYPES.includes(p.type)) reasons.push({ kind: "sensitive" });
  if (p.initiative) reasons.push({ kind: "initiative" });
  if (p.ambiguous && p.ambiguous.length > 1) reasons.push({ kind: "ambiguous", names: p.ambiguous });
  if (p.ownerUnknown) reasons.push({ kind: "unknown-words" });
  for (const a of p.args) {
    if (a.origin.from === "third-party") reasons.push({ kind: "third-party", role: a.role, source: a.origin.source ?? "document" });
    else if (a.role !== "body" && a.origin.from !== "owner" && !p.ownerUnknown && !p.initiative) reasons.push({ kind: "not-named", role: a.role });
    else if (a.role === "body" && a.origin.from === "pako" && p.context?.length) reasons.push({ kind: "context", source: p.context[0]! });
  }
  if (p.mode === "confirm") reasons.push({ kind: "setting" });
  return { mode: reasons.length ? "confirm" : "direct", reasons };
}

// ---------- the words ----------

const T = texts(
  {
    why: "I'm checking with you first because {list}.",
    thirdRecipient: "the recipient came from {source}",
    thirdNumber: "this number came from {source}",
    thirdAddress: "this address came from {source}",
    thirdBody: "the text came from {source}",
    notNamed: "you didn't name who in your message",
    ambiguous: "more than one contact fits ({names})",
    initiative: "it's my idea, you didn't ask for it",
    context: "I wrote the text with other people's text in front of me ({source})",
    sensitive: "it's money, a purchase or deleting something",
    setting: "you've set me to ask first",
    and: " and ",
    holdMessage: "💬 Sending the WhatsApp to {to} in {s} s: “{text}”",
    holdEmail: "✉️ Sending the email to {to} in {s} s: “{text}”",
    holdCall: "📞 Calling {to} in {s} s: “{text}”",
    undoBtn: "Undo",
    undone: "Undone: nothing went out.",
    tooLate: "It had already gone out: it can't be undone.",
    gone: "That's no longer pending.",
    sentEmail: "✉️ Sent to {to}: “{text}”",
    emailFailed: "I couldn't send the email to {to} ({why}). If you like, write to them yourself: {address}",
    emailUnknown: "I don't know whether the email to {to} went out (no answer): I won't retry so it isn't sent twice.",
    emailOff: "I have no mail to send from (Pako's inbox needs connecting with send permission).",
    emailNoAddress: "I don't have an email address for “{to}”. Tell me it (name@domain) or add it to your contacts.",
    emailCard: "✉️ Email to {to} ({address}), on your behalf and written by your assistant:\n\nSubject: {subject}\n{text}",
    draftSendWhy: "📝 The draft for “{title}”, as a reply to that email. It goes only if you press Send:",
    emailYes: "Send",
    emailNo: "OK, I won't send anything.",
    emailToday: "I've already sent {n} emails today: that's the daily maximum.",
    subject: "Message from {owner}",
    opening: "Message on behalf of {owner}, sent by their AI assistant:\n\n{text}",
    which: "Which {to}? There's more than one in your contacts.",
    whichMany: "There are several “{to}” in your contacts ({names}). Tell me the full name.",
    stale: "I didn't send {what} to {to}: Pako was stopped longer than expected and it was no longer the moment. If you still want it, ask me again.",
    unsure: "Pako restarted just as it was sending {what} to {to}: it may or may not have gone out. I won't repeat it so it isn't sent twice.",
    whatMessage: "the WhatsApp",
    whatEmail: "the email",
    whatCall: "the call",
    paused: "I'm paused: I didn't send {what} to {to}.",
    logHeld: "Direct with a window to undo ({s} s): {what} to {to}",
    logUndone: "Undone by the owner before it went out: {what} to {to}",
    logAsked: "Asked first ({why}): {what} to {to}",
  },
);
export const autonomyText = (l: Lang): ((key: Parameters<ReturnType<typeof T>>[0], vars?: Record<string, string | number>) => string) => T(l);

const SOURCE_WORDS: Record<OutsideSource, string> = {
  email: "an email", slack: "Slack", calendar: "the calendar", web: "the web", document: "a document", forwarded: "a forwarded message",
  meeting: "a meeting", booking: "a restaurant", event: "a notice", routine: "a routine",
};

/** One reason in words: "this number came from an email". "" for one that says nothing new (the owner's words unknown). */
export function reasonText(r: Reason, l: Lang): string {
  const t = T(l);
  switch (r.kind) {
    case "third-party": {
      const key = r.role === "number" ? "thirdNumber" : r.role === "address" ? "thirdAddress" : r.role === "body" ? "thirdBody" : "thirdRecipient";
      return t(key, { source: SOURCE_WORDS[r.source] });
    }
    case "not-named":
      return t("notNamed");
    case "ambiguous":
      return t("ambiguous", { names: r.names.slice(0, 4).join(", ") });
    case "initiative":
      return t("initiative");
    case "context":
      return t("context", { source: SOURCE_WORDS[r.source] });
    case "sensitive":
      return t("sensitive");
    case "setting":
      return t("setting");
    default:
      return "";
  }
}

/** The line a card starts with: why it asks. "" when no reason says anything new (the card then reads as it always did). */
export function whyLine(reasons: Reason[], l: Lang): string {
  const parts = [...new Set(reasons.map((r) => reasonText(r, l)).filter(Boolean))];
  return parts.length ? T(l)("why", { list: parts.join(T(l)("and")) }) : "";
}

// ---------- the settings ----------

export interface AutonomyConfig {
  /** AUTONOMY: direct (the default) or confirm (every message, email and call asks with a card, as before). */
  mode: Mode;
  /** AUTONOMY_UNDO_SECONDS: how long a direct message, email or call waits for an Undo (default 10). */
  seconds: number;
}

/** The settings, read from the environment; a wrong value is reported and the default kept. */
export function loadAutonomyConfig(env: Env, problems: string[] = []): AutonomyConfig {
  const raw = (env.AUTONOMY ?? "").trim().toLowerCase();
  let mode: Mode = "direct";
  if (raw === "confirm") mode = "confirm";
  else if (raw && raw !== "direct") problems.push("AUTONOMY must be direct or confirm");
  const s = (env.AUTONOMY_UNDO_SECONDS ?? "").trim();
  let seconds = 10;
  if (s) {
    const n = Number(s);
    if (Number.isInteger(n) && n >= 3 && n <= 120) seconds = n;
    else problems.push("AUTONOMY_UNDO_SECONDS must be a whole number of seconds from 3 to 120");
  }
  return { mode, seconds };
}

/** The panel's choices: a mode and a window per type, each left out to follow the environment. */
export interface AutonomyChoices {
  types: Partial<Record<SettableType, Mode>>;
  seconds: Partial<Record<SettableType, number>>;
}

const SETTINGS_KEY = "assistant-autonomy-settings";
const KEEP_SECONDS = 5 * 365 * 24 * 3600;

const cleanChoices = (v: unknown): AutonomyChoices => {
  const o = (v && typeof v === "object" ? v : {}) as { types?: Record<string, unknown>; seconds?: Record<string, unknown> };
  const out: AutonomyChoices = { types: {}, seconds: {} };
  for (const t of SETTABLE_TYPES) {
    const m = o.types?.[t];
    if (m === "direct" || m === "confirm") out.types[t] = m;
    const s = o.seconds?.[t];
    if (typeof s === "number" && Number.isInteger(s) && s >= 3 && s <= 120) out.seconds[t] = s;
  }
  return out;
};

export interface AutonomySettings {
  read: () => Promise<AutonomyChoices>;
  write: (c: unknown) => Promise<AutonomyChoices>;
  /** The mode and the undo window of a type: the panel's choice, else the environment's. A store that cannot be read asks (confirm). */
  effective: (type: ActionType) => Promise<{ mode: Mode; seconds: number }>;
}

export function createAutonomySettings(kv: Kv | null, config: AutonomyConfig): AutonomySettings {
  let memory: AutonomyChoices = { types: {}, seconds: {} };
  const read = async (): Promise<AutonomyChoices> => {
    if (!kv) return memory;
    const raw = await readJsonRecord(kv, SETTINGS_KEY);
    if (!raw) return { types: {}, seconds: {} };
    try {
      return cleanChoices(raw);
    } catch {
      /* not JSON: no choices, as a fresh install has */
      return { types: {}, seconds: {} };
    }
  };
  return {
    read,
    write: async (c) => {
      const clean = cleanChoices(c);
      if (kv) await kv.set(SETTINGS_KEY, JSON.stringify(clean), KEEP_SECONDS);
      else memory = clean;
      return clean;
    },
    effective: async (type) => {
      const settable = (SETTABLE_TYPES as readonly string[]).includes(type) ? (type as SettableType) : null;
      let c: AutonomyChoices;
      try {
        c = await read();
      } catch {
        /* the store did not answer: ask first, the safe default */
        return { mode: "confirm", seconds: config.seconds };
      }
      return {
        mode: (settable && c.types[settable]) || config.mode,
        seconds: (settable && c.seconds[settable]) || config.seconds,
      };
    },
  };
}

// ---------- held actions: the undo window ----------

export type HeldType = "message" | "email" | "call";
export interface HeldAction {
  /** 10 hex characters: the Undo button names it. Made from the answer's key, so the same answer holds once. */
  id: string;
  type: HeldType;
  /** Who, as the owner reads it ("Ana"). */
  label: string;
  /** Where: digits for a message, an address for an email, the contact's name for a call. */
  target: string;
  text: string;
  subject?: string;
  /** A call that goes straight to the friend's voicemail. */
  direct?: boolean;
  /** The chat the answer went to (the receipts go there too). */
  route: string | null;
  at: number;
  due: number;
  state: "held" | "sending" | "sent" | "undone" | "failed" | "stale" | "unsure";
}

const HELD_KEY = "assistant-autonomy-held";
const HELD_KEEP = 40;
const HELD_KEEP_MS = 24 * 3600_000;
/** A held action found after a restart this long past its time is not sent ("llego tarde" an hour later is wrong): the owner is told. */
export const STALE_MS = 10 * 60_000;

/** The idempotency key of an action: the answer's key and the action's type; a random one without a key. */
export const heldId = (key: string, type: HeldType): string =>
  key ? createHash("sha256").update(`${key}\u0000${type}`).digest("hex").slice(0, 10) : randomBytes(5).toString("hex");

export interface HeldQueueDeps {
  kv: Kv | null;
  now: () => number;
  /**
   * Sends it. Called once per action at most, after it is marked "sending" in the store. `false`: it certainly did not go (paused, refused,
   * not ready), and the owner was told so; its Undo then says it is no longer pending, never that it already went out.
   */
  run: (a: HeldAction) => Promise<boolean | void>;
  /** Tells the owner something about an action (a restart's stale or unsure one), on its chat. */
  tell: (a: HeldAction, kind: "stale" | "unsure") => Promise<void>;
  /** How long the real timer waits, from the window's milliseconds (the tests shorten it). */
  delay?: (ms: number) => number;
}

export interface HeldQueue {
  /** Holds it; `false` when the same id was already held (an answer sent twice): nothing new to tell. */
  hold: (a: Omit<HeldAction, "state">) => Promise<boolean>;
  /** The owner's Undo. */
  undo: (id: string) => Promise<{ status: "undone" | "too-late" | "gone"; action?: HeldAction }>;
  /** After a restart: what was held is held again (or sent now, if its time came); stale and half-sent ones are told. */
  start: () => Promise<void>;
  /** STOP: everything still held is undone (nothing goes out after a RESUME either). The ones taken back. */
  cancelAll: () => Promise<HeldAction[]>;
  /** Stops the timers (tests, shutdown). */
  stop: () => void;
  list: () => Promise<HeldAction[]>;
}

export function createHeldQueue(d: HeldQueueDeps): HeldQueue {
  let memory: HeldAction[] = [];
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let chain: Promise<unknown> = Promise.resolve();
  /** One change at a time: each reads the whole list and writes it back. */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => undefined);
    return p;
  };
  const load = async (): Promise<HeldAction[]> => {
    if (!d.kv) return memory.map((x) => ({ ...x }));
    const raw = await readJsonRecord(d.kv, HELD_KEY);
    if (!raw) return [];
    const v: unknown = raw;
    return Array.isArray(v) ? (v.filter((x) => x && typeof x === "object" && typeof (x as HeldAction).id === "string") as HeldAction[]) : [];
  };
  const save = async (list: HeldAction[]): Promise<void> => {
    const t = d.now();
    const keep = list.filter((x) => x.state === "held" || x.state === "sending" || t - x.at < HELD_KEEP_MS).slice(-HELD_KEEP);
    if (!d.kv) memory = keep.map((x) => ({ ...x }));
    else await d.kv.set(HELD_KEY, JSON.stringify(keep), Math.ceil(HELD_KEEP_MS / 1000) * 2);
  };
  const setState = (id: string, from: HeldAction["state"][], to: HeldAction["state"]): Promise<HeldAction | null> =>
    serial(async () => {
      const list = await load();
      const a = list.find((x) => x.id === id);
      if (!a || !from.includes(a.state)) return null;
      a.state = to;
      await save(list);
      return a;
    });
  const fire = async (id: string): Promise<void> => {
    timers.delete(id);
    let a: HeldAction | null;
    let stale = false;
    try {
      // Marked before it goes: a restart from here on finds it "sending" and never sends it again.
      // A timer that fires long after its time (the computer slept in the window) does not send it late: it is told, as after a restart.
      a = await serial(async () => {
        const list = await load();
        const x = list.find((y) => y.id === id);
        if (!x || x.state !== "held") return null;
        stale = d.now() - x.due > STALE_MS;
        x.state = stale ? "stale" : "sending";
        await save(list);
        return x;
      });
    } catch (err) {
      log.error(`could not mark an action as sending, so it was not sent: ${(err as Error).message}`);
      return;
    }
    if (!a) return;
    if (stale) {
      await d.tell(a, "stale").catch(() => undefined);
      return;
    }
    let ok = true;
    try {
      ok = (await d.run(a)) !== false;
    } catch (err) {
      ok = false;
      log.error(`a held ${a.type} failed: ${(err as Error).message}`);
    }
    await setState(id, ["sending"], ok ? "sent" : "failed").catch(() => undefined);
  };
  const schedule = (a: HeldAction): void => {
    clearTimeout(timers.get(a.id));
    const wait = Math.max(0, a.due - d.now());
    const t = setTimeout(() => void fire(a.id), d.delay ? d.delay(wait) : wait);
    t.unref?.();
    timers.set(a.id, t);
  };
  return {
    hold: async (input) => {
      const a: HeldAction = { ...input, state: "held" };
      const fresh = await serial(async () => {
        const list = await load();
        if (list.some((x) => x.id === a.id)) return false;
        list.push(a);
        await save(list);
        return true;
      });
      if (fresh) schedule(a);
      return fresh;
    },
    undo: async (id) => {
      const before = (await load()).find((x) => x.id === id);
      if (!before) return { status: "gone" };
      const a = await setState(id, ["held"], "undone");
      if (a) {
        clearTimeout(timers.get(id));
        timers.delete(id);
        return { status: "undone", action: a };
      }
      // Only one that went (or may have) is too late; one that was undone, did not go, or was let go stale is simply no longer pending.
      return { status: before.state === "sending" || before.state === "sent" || before.state === "unsure" ? "too-late" : "gone", action: before };
    },
    start: async () => {
      let list: HeldAction[];
      try {
        list = await load();
      } catch (err) {
        log.error(`could not read the held actions: ${(err as Error).message}`);
        return;
      }
      for (const a of list) {
        if (a.state === "held") {
          if (d.now() - a.due > STALE_MS) {
            if (await setState(a.id, ["held"], "stale").catch(() => null)) await d.tell(a, "stale").catch(() => undefined);
          } else schedule(a);
        } else if (a.state === "sending") {
          if (await setState(a.id, ["sending"], "unsure").catch(() => null)) await d.tell(a, "unsure").catch(() => undefined);
        }
      }
    },
    cancelAll: () =>
      serial(async () => {
        const list = await load();
        const gone = list.filter((x) => x.state === "held");
        for (const a of gone) {
          a.state = "undone";
          clearTimeout(timers.get(a.id));
          timers.delete(a.id);
        }
        if (gone.length) await save(list);
        return gone;
      }),
    stop: () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
    list: () => load(),
  };
}

// ---------- the contact book's email addresses ----------

/** PERSONAL_CONTACT_EMAILS: {"Ana Lopez":"ana@example.com"}. The names may be the phone contacts' or others; addresses only, checked. */
export function parseContactEmails(raw: string | undefined, problems: string[] = []): { name: string; address: string }[] {
  if (!raw || !raw.trim()) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    /* said in the problems list */
    problems.push('PERSONAL_CONTACT_EMAILS must be JSON, for example {"Ana":"ana@example.com"}');
    return [];
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    problems.push("PERSONAL_CONTACT_EMAILS must be a JSON object of name to address");
    return [];
  }
  const out: { name: string; address: string }[] = [];
  for (const [name, address] of Object.entries(v as Record<string, unknown>).slice(0, 100)) {
    const n = name.replace(/\s+/g, " ").trim().slice(0, 40);
    if (!n || typeof address !== "string" || !isAddress(address)) {
      problems.push(`PERSONAL_CONTACT_EMAILS: the address for ${JSON.stringify(n)} is not an email address`);
      continue;
    }
    out.push({ name: n, address: address.trim() });
  }
  return out;
}

// ---------- the panel: a small section in Settings ----------

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" };

/** GET and POST /panel/api/autonomy: the mode and the undo window of messages, emails and calls. Same protection as STOP. */
export function mountAutonomyPanel(app: Express, d: { signedIn: (req: Request) => boolean; settings: AutonomySettings; config: AutonomyConfig }): void {
  const limit = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false });
  const auth = (change: boolean): RequestHandler => (req, res, next) => {
    res.set(HEADERS);
    if (!d.signedIn(req) || (change && req.get("x-pako") !== "1")) {
      res.status(401).json({ error: "sign in" });
      return;
    }
    next();
  };
  const answer = (c: AutonomyChoices) => ({ types: SETTABLE_TYPES, choices: c, defaults: { mode: d.config.mode, seconds: d.config.seconds } });
  app.get("/panel/api/autonomy", auth(false), limit, async (_req, res) => {
    try {
      res.json(answer(await d.settings.read()));
    } catch (err) {
      log.warn(`the autonomy choices could not be read: ${(err as Error).message}`);
      res.status(503).json({ error: "store" });
    }
  });
  app.post("/panel/api/autonomy", auth(true), limit, express.json({ limit: "2kb" }), async (req, res) => {
    try {
      res.json(answer(await d.settings.write(req.body)));
    } catch (err) {
      log.warn(`the autonomy choices could not be kept: ${(err as Error).message}`);
      res.status(503).json({ error: "store" });
    }
  });
}
