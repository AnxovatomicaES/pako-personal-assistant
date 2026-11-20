// What Pako learned from the owner's corrections: each one a short, dated lesson the next run reads.
//
// Captured on the server, by code, only from the owner's OWN actions:
// - "Not mine" pressed on a follow-up (the rule in src/followups/owner.ts stays; this is the same press, kept as a lesson too);
// - an Undo (a receipt's button or UNDO typed, src/door/revert.ts; a message, an email or a call stopped in its window, src/door/held.ts);
// - a 👎 on a follow-up's reminder, or on a to-do or an update of the brief (src/quality.ts);
// - a draft the owner sent changed: Pako's draft (DRAFT, src/brief-v2.ts draftFor) beside what the owner then posted in that Slack conversation
//   or sent to that address from their own mail, compared by code (length, greeting, sign-off, language, exclamation marks, emoji).
//
// Never from anyone else's words. This module has no way in for free text: each lesson is written here from fixed English templates. The
// few fields that come from a follow-up (its person, place and title, which a model wrote from other people's messages) are cut to one short
// line, and dropped for a neutral word when they try to instruct Pako or carry a number or a link (src/brief-support.ts). What a draft
// edit teaches is only what the code measured: counts, a greeting word from a fixed list, a language code. A model's answer never reaches it.
//
// Kept in one key (LESSONS_KEY), at most LESSONS_MAX lessons: the same lesson again reinforces the one kept (count + 1, dated now), and over
// the cap the least reinforced, oldest ones go first. Pako's last drafts wait here too (DRAFTS_MAX, DRAFT_KEEP_MS) for what the owner sends.
// Given to the follow-up extraction, the drafts and the brief as neutral data under one heading (LESSONS_HEAD), at most LESSONS_PER_RUN,
// those about the same person or place first. The panel shows them and deletes one (Settings › How Pako acts, "What Pako learned from you").

import { randomBytes } from "node:crypto";
import express, { type Express, type Request, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { instructsPako, payloads } from "./brief-support.ts";
import { sameThing } from "./followups/answer.ts";
import type { Kv } from "./kv.ts";
import { detectLanguage } from "./language.ts";
import { fold } from "./lists.ts";
import { inline } from "./quarantine.ts";
import { createLog } from "./log.ts";
import { readJsonRecord } from "./json-record.ts";

const log = createLog("lessons");

export const LESSONS_KEY = "lessons";
const TTL_SECONDS = 400 * 24 * 3600;
export const LESSONS_MAX = 60;
export const LESSONS_PER_RUN = 8;
export const DRAFTS_MAX = 10;
/** A draft waits this long for what the owner sends. */
export const DRAFT_KEEP_MS = 3 * 24 * 3600_000;
const FIELD_MAX = 80;
const TEXT_MAX = 300;
const DRAFT_MAX = 1500;

/** The heading the runs read the lessons under. */
export const LESSONS_HEAD = "Owner's corrections (most recent first), follow them:";

export const LESSON_KINDS = ["not_mine", "wrong", "undo", "draft_edit"] as const;
export type LessonKind = (typeof LESSON_KINDS)[number];

/**
 * What a lesson is about (its source's `what`): a follow-up said not to be the owner's, a reminder or an item of the brief that was not
 * useful, something Pako did that the owner undid, a draft the owner changed.
 */
export type LessonAbout =
  | "follow-up" | "follow-up reminder" | "brief to-do" | "brief update"
  | "follow-up kept" | "follow-up closed" | "reminder" | "note" | "task" | "list" | "person" | "calendar" | "routine"
  | "email" | "message" | "call"
  | "draft";

export interface LessonSource {
  what: LessonAbout;
  /** Who and where it was about, as the owner reads them ("Stan", "#sales"); the Slack conversation's id when there is one. */
  who?: string;
  where?: string;
  channel?: string;
  /** The thing itself ("Send the pricing sheet"), or for a draft edit the changes measured ("shorter,no-greeting"): what makes two the same. */
  title?: string;
}

export interface Lesson {
  id: string;
  /** When it was first learnt, and when it was last reinforced (ms). */
  at: number;
  last: number;
  kind: LessonKind;
  text: string;
  source: LessonSource;
  /** How many times the owner taught it. */
  count: number;
  /** A draft edit: Pako's draft and what the owner sent (their own words), cut. Shown in the panel; never given to a run. */
  draft?: string;
  sent?: string;
}

/** A draft Pako wrote, waiting for what the owner sends. */
interface PendingDraft {
  id: string;
  at: number;
  text: string;
  who: string;
  where: string;
  channel?: string;
  address?: string;
}

interface State {
  lessons: Lesson[];
  drafts: PendingDraft[];
}

/** Which lessons a run reads: these kinds (and, when given, only about these things), the same person or place first. */
export interface LessonQuery {
  kinds: readonly LessonKind[];
  about?: readonly LessonAbout[];
  who?: string;
  where?: string;
  channel?: string;
  /** Only lessons about one of these people (their names and aliases): what a person's context reads (src/person-context.ts). */
  only?: readonly string[];
  max?: number;
}

/** What src/followups/ needs: the "Not mine" press, and the lessons its extraction reads. */
export interface LessonsPort {
  notMine(o: { title: string; who: string; where: string; channel?: string; nudged?: boolean }): Promise<unknown>;
  lines(q: LessonQuery): Promise<string[]>;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const ABOUTS: readonly LessonAbout[] = [
  "follow-up", "follow-up reminder", "brief to-do", "brief update", "follow-up kept", "follow-up closed", "reminder", "note", "task", "list",
  "person", "calendar", "routine", "email", "message", "call", "draft",
];

/**
 * A field that came from a follow-up (written by a model from other people's text), made safe for a lesson: one short line; a field that
 * tries to instruct Pako, or carries a phone number, an account or a link, becomes a neutral word. Nothing else of it is kept.
 */
export const safeField = (v: unknown, max = FIELD_MAX): string => {
  const one = inline(typeof v === "string" ? v : "", max).replace(/[«»"]/g, "'").trim();
  if (!one) return "";
  return instructsPako(one) || payloads(one).length ? "(a text that tried to instruct Pako)" : one;
};

/** The stored record, checked field by field (never trusted). */
export function lessonsStateOf(v: unknown): State {
  const o = isObject(v) ? v : {};
  const lessons = (Array.isArray(o.lessons) ? o.lessons : []).flatMap((x): Lesson[] => {
    if (!isObject(x) || typeof x.id !== "string" || typeof x.at !== "number" || typeof x.text !== "string" || !x.text) return [];
    if (!(LESSON_KINDS as readonly unknown[]).includes(x.kind)) return [];
    const s = isObject(x.source) ? x.source : {};
    if (!ABOUTS.includes(s.what as LessonAbout)) return [];
    const source: LessonSource = { what: s.what as LessonAbout };
    for (const k of ["who", "where", "channel", "title"] as const) if (typeof s[k] === "string" && s[k]) source[k] = str(s[k], FIELD_MAX);
    return [{
      id: x.id.slice(0, 20), at: x.at, last: typeof x.last === "number" ? x.last : x.at, kind: x.kind as LessonKind, text: x.text.slice(0, TEXT_MAX),
      source, count: typeof x.count === "number" && x.count >= 1 ? Math.floor(x.count) : 1,
      ...(typeof x.draft === "string" ? { draft: x.draft.slice(0, DRAFT_MAX) } : {}), ...(typeof x.sent === "string" ? { sent: x.sent.slice(0, DRAFT_MAX) } : {}),
    }];
  });
  const drafts = (Array.isArray(o.drafts) ? o.drafts : []).flatMap((x): PendingDraft[] =>
    isObject(x) && typeof x.id === "string" && typeof x.at === "number" && typeof x.text === "string"
      ? [{
          id: x.id, at: x.at, text: x.text.slice(0, DRAFT_MAX), who: str(x.who, FIELD_MAX), where: str(x.where, FIELD_MAX),
          ...(typeof x.channel === "string" ? { channel: x.channel.slice(0, 40) } : {}), ...(typeof x.address === "string" ? { address: x.address.slice(0, 200) } : {}),
        }]
      : []);
  return { lessons: lessons.slice(-LESSONS_MAX), drafts: drafts.slice(-DRAFTS_MAX) };
}

// ---------- a draft beside what the owner sent ----------

const GREETING = /^(hi|hello|hey|dear|good (?:morning|afternoon|evening)|hola|buenos d[ií]as|buenas(?: tardes| noches)?|querid[oa]|estimad[oa])\b/i;
const SIGN_OFF = /^(thanks|thank you|many thanks|best|best regards|kind regards|regards|cheers|talk soon|gracias|muchas gracias|saludos|un saludo|un abrazo|abrazos|besos)\b/i;
const EMOJI = /\p{Extended_Pictographic}/u;
const LANG_NAME = new Intl.DisplayNames(["en"], { type: "language" });

const wordsOf = (text: string): string[] => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
const lines = (text: string): string[] => text.split("\n").map((l) => l.trim()).filter(Boolean);
const keyWords = (text: string): Set<string> => new Set(fold(text).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));

/** A draft's message: its first line says where it goes (src/brief-v2.ts DRAFT_LOOP); its sources line at the end is Pako's. */
export const draftMessage = (text: string): string => {
  const all = text.replace(/\r/g, "").split("\n");
  const body = (all.length > 1 ? all.slice(1) : all).join("\n").replace(/\(\s*(?:Sources|Fuentes)\s*:[^)]*\)\s*$/i, "").trim();
  return body.slice(0, DRAFT_MAX);
};

/** Whether what the owner sent is that draft (as written, or changed): enough of the same words. */
export const isSameMessage = (draft: string, sent: string): boolean => {
  const a = keyWords(draft);
  const b = keyWords(sent);
  if (!a.size || !b.size) return false;
  const common = [...a].filter((w) => b.has(w)).length;
  return common >= Math.min(3, a.size, b.size) && common / Math.min(a.size, b.size) >= 0.4;
};

/**
 * What the owner changed in a draft before sending it, measured by code only: each change a short key and the words a run reads. Nothing
 * of either text is copied, but a greeting or a sign-off word from the fixed lists above, and a language's name.
 */
export function draftChanges(draft: string, sent: string): { key: string; say: string }[] {
  const out: { key: string; say: string }[] = [];
  const a = wordsOf(draft).length;
  const b = wordsOf(sent).length;
  if (a >= 8 && b <= a * 0.7) out.push({ key: "shorter", say: `the owner cut one from ${a} to ${b} words: keep them about that short` });
  else if (b >= 8 && b >= a * 1.4) out.push({ key: "longer", say: `the owner grew one from ${a} to ${b} words: they want more detail` });
  const greetOf = (t: string): string => (GREETING.exec(lines(t)[0] ?? "")?.[1] ?? "").toLowerCase();
  const ga = greetOf(draft);
  const gb = greetOf(sent);
  if (ga && !gb) out.push({ key: "no-greeting", say: "no greeting" });
  else if (!ga && gb) out.push({ key: "greeting", say: `start with a greeting ("${gb.charAt(0).toUpperCase()}${gb.slice(1)}")` });
  // A sign-off on a line of its own, at the end or just above a name ("Best,\nAlex").
  const signOf = (t: string): boolean => {
    const l = lines(t);
    return l.length > 1 && (SIGN_OFF.test(l.at(-1) ?? "") || (l.length > 2 && SIGN_OFF.test(l.at(-2) ?? "") && wordsOf(l.at(-1) ?? "").length <= 3));
  };
  if (signOf(draft) && !signOf(sent)) out.push({ key: "no-sign-off", say: "no sign-off" });
  else if (!signOf(draft) && signOf(sent)) out.push({ key: "sign-off", say: "end with a sign-off" });
  const la = detectLanguage(draft);
  const lb = detectLanguage(sent);
  if (la && lb && la !== lb) out.push({ key: `lang-${lb}`, say: `write in ${LANG_NAME.of(lb) ?? lb}` });
  if (/!/.test(draft) && !/!/.test(sent)) out.push({ key: "no-exclamation", say: "no exclamation marks" });
  if (EMOJI.test(draft) && !EMOJI.test(sent)) out.push({ key: "no-emoji", say: "no emoji" });
  else if (!EMOJI.test(draft) && EMOJI.test(sent)) out.push({ key: "emoji", say: "an emoji is fine" });
  return out;
}

// ---------- the store ----------

export interface LessonsDeps {
  kv: Kv | null;
  timeZone: string;
  now?: () => number;
}

const newId = (): string => randomBytes(5).toString("hex");
/** "Stan in #sales", "Stan", "#sales", or "". */
const whoWhere = (who: string, where: string): string =>
  who && where && !fold(where).includes(fold(who)) ? `${who} in ${where}` : who || where;

const UNDONE: Record<string, string> = {
  "follow-up kept": "a follow-up Pako kept from the chat",
  "follow-up closed": "a follow-up Pako closed as done",
  reminder: "a reminder Pako set",
  note: "a note Pako kept",
  task: "a task Pako added",
  list: "items Pako added to a list",
  person: "a change Pako made to the people list",
  calendar: "a calendar change",
  routine: "a routine Pako set up",
  email: "an email before it went",
  message: "a message before it went",
  call: "a call before it went",
};

export function createLessons(d: LessonsDeps) {
  const now = d.now ?? Date.now;
  let memory: State = { lessons: [], drafts: [] };
  let chain: Promise<unknown> = Promise.resolve();

  const readNow = async (): Promise<State> => {
    if (!d.kv) return structuredClone(memory);
    const raw = await readJsonRecord(d.kv, LESSONS_KEY);
    if (!raw) return { lessons: [], drafts: [] };
    return lessonsStateOf(raw);
  };
  /** One change at a time, never written from a copy that could not be read. Over the cap: the least reinforced, then the oldest, go. */
  const mutate = <R>(fn: (s: State) => R): Promise<R> => {
    const run = chain.then(async () => {
      const s = await readNow();
      const out = fn(s);
      const t = now();
      s.drafts = s.drafts.filter((x) => t - x.at < DRAFT_KEEP_MS).slice(-DRAFTS_MAX);
      if (s.lessons.length > LESSONS_MAX) {
        const drop = new Set([...s.lessons].sort((a, b) => a.count - b.count || a.last - b.last).slice(0, s.lessons.length - LESSONS_MAX).map((x) => x.id));
        s.lessons = s.lessons.filter((x) => !drop.has(x.id));
      }
      if (d.kv) await d.kv.set(LESSONS_KEY, JSON.stringify(s), TTL_SECONDS);
      memory = s;
      return out;
    });
    chain = run.catch(() => undefined);
    return run;
  };
  const read = async (): Promise<State> => {
    await chain.catch(() => undefined);
    return readNow();
  };

  /** The same lesson as one kept: the same kind about the same thing, from the same person and place. */
  const same = (x: Lesson, kind: LessonKind, src: LessonSource): boolean =>
    x.kind === kind && x.source.what === src.what && fold(x.source.who ?? "") === fold(src.who ?? "")
    && fold(x.source.where ?? "") === fold(src.where ?? "")
    && (fold(x.source.title ?? "") === fold(src.title ?? "") || sameThing(x.source.title ?? "", src.title ?? ""));

  /** Kept, or the same one reinforced (its count, its date and its latest words). Internal: only the owner's actions below call it. */
  const learn = (kind: LessonKind, text: string, source: LessonSource, extra: Pick<Lesson, "draft" | "sent"> = {}): Promise<Lesson> =>
    mutate((s) => {
      const t = now();
      const clean: LessonSource = { what: source.what };
      for (const k of ["who", "where", "channel", "title"] as const) if (source[k]) clean[k] = source[k]!.slice(0, FIELD_MAX);
      const twin = s.lessons.find((x) => same(x, kind, clean));
      if (twin) {
        Object.assign(twin, { last: t, count: twin.count + 1, text: text.slice(0, TEXT_MAX), source: clean, ...extra });
        s.lessons = [...s.lessons.filter((x) => x !== twin), twin];
        return twin;
      }
      const lesson: Lesson = { id: newId(), at: t, last: t, kind, text: text.slice(0, TEXT_MAX), source: clean, count: 1, ...extra };
      s.lessons.push(lesson);
      return lesson;
    });

  /** The owner pressed "Not mine" on a follow-up (on its reminder, or in the list). */
  const notMine: LessonsPort["notMine"] = (o) => {
    const title = safeField(o.title);
    const who = safeField(o.who, 60);
    const where = safeField(o.where, 60);
    if (!title) return Promise.resolve(null);
    const from = whoWhere(who, where);
    const text = `Not the owner's to do: '${title}'${from ? `, asked by ${from}` : ""}${o.nudged ? " (said after a reminder)" : ""}. `
      + `Requests of this kind${where ? ` in ${where}` : ""} are not theirs either, whoever asks: make no follow-up like it.`;
    return learn("not_mine", text, { what: "follow-up", who, where, ...(o.channel ? { channel: o.channel.slice(0, 40) } : {}), title });
  };

  /** A 👎 on a follow-up's reminder, or on a to-do or an update of the brief: it was not useful. */
  const wrong = (o: { what: "follow-up reminder" | "brief to-do" | "brief update"; title: string; who?: string; where?: string; channel?: string }) => {
    const title = safeField(o.title);
    if (!title) return Promise.resolve(null);
    const who = safeField(o.who ?? "", 60);
    const where = safeField(o.where ?? "", 60);
    const from = whoWhere(who, where);
    const text = o.what === "follow-up reminder"
      ? `A reminder about '${title}'${from ? ` (${from})` : ""} was not useful: don't remind the owner of things like it.`
      : `'${title}' in the brief was not useful to the owner: leave things like it out.`;
    return learn("wrong", text, { what: o.what, who, where, ...(o.channel ? { channel: o.channel.slice(0, 40) } : {}), title });
  };

  /** The owner undid something Pako did (or stopped it in its window to undo): what it was, and about what or whom. */
  const undone = (o: { what: Exclude<LessonAbout, "follow-up" | "follow-up reminder" | "brief to-do" | "brief update" | "draft">; title: string; who?: string }) => {
    const title = safeField(o.title);
    const who = safeField(o.who ?? "", 60);
    if (!title && !who) return Promise.resolve(null);
    const thing = UNDONE[o.what] ?? o.what;
    const to = who && (o.what === "email" || o.what === "message" || o.what === "call") ? ` to ${who}` : "";
    const text = o.what === "follow-up kept"
      ? `The owner undid a follow-up Pako kept from the chat: '${title}'. Don't keep a promise like that as a follow-up.`
      : o.what === "follow-up closed"
        ? `The owner undid closing '${title}': it was not done. Don't close a follow-up from words like those.`
        : `The owner undid ${thing.replace(" before it went", `${to} before it went`)}${title ? `: '${title}'` : ""}. Ask first next time.`;
    return learn("undo", text, { what: o.what, ...(who ? { who } : {}), ...(title ? { title } : {}) });
  };

  /** A draft Pako wrote (src/brief-v2.ts draftFor): kept a few days, to be compared with what the owner sends there. */
  const drafted = (o: { text: string; who?: string; where?: string; channel?: string; address?: string }): Promise<boolean> => {
    const text = draftMessage(o.text);
    if (!text || (!o.channel && !o.address)) return Promise.resolve(false);
    return mutate((s) => {
      s.drafts.push({
        id: newId(), at: now(), text, who: safeField(o.who ?? "", 60), where: safeField(o.where ?? "", 60),
        ...(o.channel ? { channel: o.channel.slice(0, 40) } : {}), ...(o.address ? { address: o.address.toLowerCase().slice(0, 200) } : {}),
      });
      return true;
    });
  };

  /**
   * The owner's own words, sent: a Slack post of theirs (`channel`) or an email from their own mailbox (`to`). When it is a draft Pako wrote
   * for that conversation or address in the last days, changed, what the owner changed becomes a lesson; sent as written, nothing is learnt.
   * Either way that draft is done with. Null when it answers no draft.
   */
  const ownSent = async (o: { text: string; channel?: string; to?: string[]; at?: number }): Promise<Lesson | null> => {
    const sent = (o.text ?? "").replace(/\r/g, "").replace(/\n>.*$/gs, "").trim().slice(0, DRAFT_MAX);
    if (!sent) return null;
    const at = o.at ?? now();
    const to = new Set((o.to ?? []).map((x) => x.toLowerCase().trim()));
    const hit = await mutate((s) => {
      const d0 = [...s.drafts].reverse().find((x) => x.at <= at + 60_000
        && ((o.channel && x.channel === o.channel) || (x.address && to.has(x.address))) && isSameMessage(x.text, sent));
      if (d0) s.drafts = s.drafts.filter((x) => x !== d0);
      return d0 ?? null;
    });
    if (!hit) return null;
    const changes = draftChanges(hit.text, sent);
    if (!changes.length) return null;
    const text = `Drafts to ${whoWhere(hit.who, hit.where) || "this person"}: ${changes.map((c) => c.say).join("; ")}.`;
    return learn("draft_edit", text, {
      what: "draft", ...(hit.who ? { who: hit.who } : {}), ...(hit.where ? { where: hit.where } : {}), ...(hit.channel ? { channel: hit.channel } : {}),
      title: changes.map((c) => c.key).sort().join(","),
    }, { draft: hit.text, sent });
  };

  /** The day a lesson was last taught, in the owner's zone. */
  const dayOf = (t: number): string => new Intl.DateTimeFormat("sv-SE", { timeZone: d.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);

  /**
   * The lessons a run reads, one line each, most recent first: of these kinds (about these things), those about the same person, place or
   * conversation chosen first, then the most recent, at most `max` (LESSONS_PER_RUN). [] when there are none or the store cannot be read.
   */
  const lines = async (q: LessonQuery): Promise<string[]> => {
    let list: Lesson[];
    try {
      list = (await read()).lessons;
    } catch (err) {
      log.error(`the lessons could not be read: ${(err as Error).message}`);
      return [];
    }
    const who = fold(q.who ?? "");
    const where = fold(q.where ?? "");
    const score = (x: Lesson): number =>
      (who && fold(x.source.who ?? "") === who ? 2 : 0)
      + (q.channel && x.source.channel === q.channel ? 2 : where && x.source.where && (fold(x.source.where) === where || where.includes(fold(x.source.where))) ? 1 : 0);
    const only = q.only ? new Set(q.only.map(fold).filter(Boolean)) : null;
    const mine = list.filter((x) => q.kinds.includes(x.kind) && (!q.about || q.about.includes(x.source.what))
      && (!only || only.has(fold(x.source.who ?? ""))));
    const chosen = mine.sort((a, b) => score(b) - score(a) || b.last - a.last).slice(0, Math.max(0, Math.min(q.max ?? LESSONS_PER_RUN, LESSONS_PER_RUN)));
    return chosen.sort((a, b) => b.last - a.last).map((x) => inline(`- ${dayOf(x.last)} · ${x.text}${x.count > 1 ? ` (taught ${x.count} times)` : ""}`, 400));
  };

  const list = async (): Promise<Lesson[]> => [...(await read()).lessons].sort((a, b) => b.last - a.last);
  const remove = (id: string): Promise<boolean> =>
    mutate((s) => {
      const n = s.lessons.length;
      s.lessons = s.lessons.filter((x) => x.id !== id);
      return s.lessons.length < n;
    });

  return { notMine, wrong, undone, drafted, ownSent, lines, list, remove };
}

export type Lessons = ReturnType<typeof createLessons>;

/** The lines a run reads under their heading, or nothing when there are none. */
export const lessonsSection = (list: string[]): string[] => (list.length ? ["", LESSONS_HEAD, ...list] : []);

// ---------- the panel ----------

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

/**
 * "What Pako learned from you" (src/panel/acts.js, Settings › How Pako acts). The panel's session, and on a POST the x-pako header another
 * site cannot send.
 *   GET  /panel/api/lessons               -> { lessons: [{ id, at, last, kind, text, count, about, who, where, draft?, sent? }] }
 *   POST /panel/api/lessons/delete { id } -> { ok }
 */
export function mountLessonsPanel(app: Express, d: { signedIn: (req: Request) => boolean; lessons: () => Lessons | null }): void {
  const auth = (post: boolean): RequestHandler => (req, res, next) => {
    res.set(HEADERS);
    if (!d.signedIn(req) || (post && req.get("x-pako") !== "1")) return void res.status(401).json({ error: "sign in" });
    next();
  };
  const limit = (n: number) =>
    rateLimit({ windowMs: 60_000, limit: n, standardHeaders: "draft-8", legacyHeaders: false, handler: (_req, res) => void res.status(429).json({ error: "too many" }) });
  app.get("/panel/api/lessons", auth(false), limit(120), async (_req, res) => {
    const l = d.lessons();
    if (!l) return void res.json({ lessons: [] });
    try {
      res.json({
        lessons: (await l.list()).map((x) => ({
          id: x.id, at: x.at, last: x.last, kind: x.kind, text: x.text, count: x.count, about: x.source.what, who: x.source.who ?? "",
          where: x.source.where ?? "", ...(x.draft ? { draft: x.draft } : {}), ...(x.sent ? { sent: x.sent } : {}),
        })),
      });
    } catch (err) {
      log.error(`could not read the lessons: ${(err as Error).message}`);
      res.status(503).json({ error: "store" });
    }
  });
  app.post("/panel/api/lessons/delete", auth(true), limit(60), express.json({ limit: "1kb" }), async (req, res) => {
    const l = d.lessons();
    const id = (req.body ?? {}).id;
    if (!l || typeof id !== "string" || !/^[0-9a-f]{10}$/.test(id)) return void res.status(400).json({ error: "bad" });
    try {
      res.json({ ok: await l.remove(id) });
    } catch (err) {
      log.error(`could not delete a lesson: ${(err as Error).message}`);
      res.status(503).json({ error: "store" });
    }
  });
}
