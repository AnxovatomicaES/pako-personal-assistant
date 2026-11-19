// The teacher: learning goals the owner states ("I want to learn to cook"), the short quiz cards the assistant writes during a lesson
// (<card goal="Italian" q="…" a="…"/>), and spaced repetition (SM-2 style) so each card comes back just before it would be forgotten. All of
// it stays in one key of the store ("learning").
//
// The owner's plain words, English like every command: "I want to learn X" keeps the goal (the message still goes to the assistant, which
// starts the first lesson); "quiz me" asks the next card that is due; the next short message is the answer, graded here (exact, close,
// wrong; "pass" is a miss), and the card's next time follows. "my progress" lists the goals; "stop learning X" pauses a goal (its cards
// stay, nothing is deleted). A quiz the proactive check offers is the same question: answered the same way. The same wishes in another
// language go to the assistant. An answer to a card is graded in any language (it is the owner's answer, often in the language they learn),
// so its "I don't know" words stay in Spanish too.
//
// Cards come only from the owner's own conversation (a turn that read other people's text keeps none: src/whatsapp.ts).

import { randomBytes } from "node:crypto";
import { texts, type Lang } from "./i18n.ts";
import { plainWords } from "./intents.ts";
import type { Kv } from "./kv.ts";
import { fold, today } from "./lists.ts";
import { createLog } from "./log.ts";

const log = createLog("learning");

export const LEARNING_KEY = "learning";
const TTL_SECONDS = 400 * 24 * 3600;
export const GOALS_MAX = 10;
export const CARDS_MAX = 500;
export const TOPIC_MAX = 60;
export const Q_MAX = 200;
export const A_MAX = 120;
const DAY_MS = 24 * 3600_000;
/** A question waits this long for its answer; after it, a short message is an ordinary message again. */
export const ASK_MS = 15 * 60_000;

export interface Goal {
  id: string;
  topic: string;
  at: number;
  paused?: boolean;
}

export interface Card {
  id: string;
  goal: string;
  q: string;
  a: string;
  /** SM-2: easiness (1.3 and up), repetitions in a row answered well, the interval in days, and when it is due. */
  ef: number;
  reps: number;
  interval: number;
  due: number;
  at: number;
  /** Answers given, and how many were right (for the progress line). */
  seen?: number;
  right?: number;
}

export interface LearningState {
  goals: Goal[];
  cards: Card[];
  /** The card asked and when: the next short message answers it, within ASK_MS. */
  asking?: { card: string; at: number };
  /** The last quiz offered by the proactive check (the owner's day). */
  offered?: string;
}

const empty = (): LearningState => ({ goals: [], cards: [] });
const line = (s: unknown, max: number): string => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");
const newId = (): string => randomBytes(4).toString("hex");
const num = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

export function learningOf(raw: unknown): LearningState {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const goals = (Array.isArray(o.goals) ? o.goals : []).flatMap((g: unknown): Goal[] => {
    const x = (g && typeof g === "object" ? g : {}) as Record<string, unknown>;
    const topic = line(x.topic, TOPIC_MAX);
    const id = line(x.id, 16);
    return topic && id ? [{ id, topic, at: num(x.at, 0, 1e15, 0), ...(x.paused === true ? { paused: true } : {}) }] : [];
  });
  const cards = (Array.isArray(o.cards) ? o.cards : []).flatMap((c: unknown): Card[] => {
    const x = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
    const q = line(x.q, Q_MAX);
    const a = line(x.a, A_MAX);
    const id = line(x.id, 16);
    const goal = line(x.goal, 16);
    if (!q || !a || !id || !goals.some((g) => g.id === goal)) return [];
    return [{
      id, goal, q, a, ef: num(x.ef, 1.3, 3, 2.5), reps: num(x.reps, 0, 100, 0), interval: num(x.interval, 0, 3650, 0), due: num(x.due, 0, 1e15, 0),
      at: num(x.at, 0, 1e15, 0), seen: num(x.seen, 0, 1e6, 0), right: num(x.right, 0, 1e6, 0),
    }];
  });
  const ask = o.asking && typeof o.asking === "object" ? (o.asking as Record<string, unknown>) : null;
  return {
    goals: goals.slice(-GOALS_MAX),
    cards: cards.slice(-CARDS_MAX),
    ...(ask && typeof ask.card === "string" && Number.isFinite(ask.at) ? { asking: { card: ask.card, at: Number(ask.at) } } : {}),
    ...(typeof o.offered === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.offered) ? { offered: o.offered } : {}),
  };
}

// ---------- spaced repetition ----------

/**
 * SM-2: quality 0-5 (5 perfect, 3 right with effort, below 3 wrong). A wrong answer starts the card again tomorrow; a right one waits 1 day,
 * then 6, then the last interval times its easiness, which moves with each answer (never under 1.3).
 */
export function sm2(c: Pick<Card, "ef" | "reps" | "interval">, quality: number, now: number): Pick<Card, "ef" | "reps" | "interval" | "due"> {
  const q = Math.max(0, Math.min(5, Math.round(quality)));
  const ef = Math.max(1.3, c.ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  if (q < 3) return { ef, reps: 0, interval: 1, due: now + DAY_MS };
  const reps = c.reps + 1;
  const interval = reps === 1 ? 1 : reps === 2 ? 6 : Math.round(c.interval * ef);
  return { ef, reps, interval, due: now + interval * DAY_MS };
}

/** Optimal string alignment distance (small words only). */
function distance(a: string, b: string): number {
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) rows.push([i]);
  for (let j = 1; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = v;
    }
  }
  return rows[a.length]![b.length]!;
}

const PASS = /^(?:no se|ni idea|paso|no me acuerdo|no lo se|i don t know|dunno|no idea|pass|skip|i forgot)$/;

/** The answer's quality: 5 the same (accents, capitals and punctuation aside), 4 one slip, 3 two slips in a long one, 1 wrong, 0 "pass". */
export function grade(answer: string, expected: string): number {
  const a = plainWords(answer);
  if (!a || PASS.test(a)) return 0;
  // Any one of the accepted answers, separated by "/" or ";" ("hello / hi").
  const options = expected.split(/[/;]/).map(plainWords).filter(Boolean);
  let best = 1;
  for (const e of options) {
    if (a === e || a.replace(/^(?:the|a|an|el|la|los|las|un|una|to) /, "") === e.replace(/^(?:the|a|an|el|la|los|las|un|una|to) /, "")) return 5;
    const d = distance(a, e);
    if (d === 1 && e.length >= 4) best = Math.max(best, 4);
    else if (d === 2 && e.length >= 8) best = Math.max(best, 3);
  }
  return best;
}

// ---------- the owner's words ----------

export type LearningCommand =
  | { op: "goal"; topic: string }
  | { op: "quiz"; topic?: string }
  | { op: "progress" }
  | { op: "pause"; topic: string };

/** On plainWords; `text` is the original, for the topic as written ("Italian", as typed, not "italian"). */
export function learningCommand(text: string, command: string): LearningCommand | null {
  const topicOf = (re: RegExp): string => {
    const m = re.exec(text.trim().replace(/[?!.]+$/u, "").trim());
    return line(m?.[1] ?? "", TOPIC_MAX);
  };
  if (/^i (?:want|d like|would like|m going) to learn \S/.test(command)) {
    const topic = topicOf(/to\s+learn\s+(?:to\s+|how\s+to\s+)?(.+)$/i);
    if (topic) return { op: "goal", topic };
  }
  const quiz = /^(?:quiz me|test me|let s review|review time)(?: (?:on|about) (.{1,40}))?$/.exec(command);
  if (quiz) return { op: "quiz", ...(quiz[1] ? { topic: quiz[1] } : {}) };
  if (/^(?:my progress|my learning|what am i learning)$/.test(command)) return { op: "progress" };
  if (/^(?:stop learning|pause learning) \S/.test(command)) {
    const topic = topicOf(/(?:stop|pause)\s+learning\s+(.+)$/i);
    if (topic) return { op: "pause", topic };
  }
  return null;
}

// ---------- the store ----------

export interface LearningStore {
  read(): Promise<LearningState>;
  /** A goal kept (the one with that topic again, started again if it was paused). */
  addGoal(topic: string, now: number): Promise<{ goal: Goal; isNew: boolean } | null>;
  pauseGoal(topic: string): Promise<Goal | null>;
  /** Cards from a lesson, for a goal by its topic (made when it is new). Repeats of a question are skipped. Returns how many were kept. */
  addCards(cards: { goal: string; q: string; a: string }[], now: number): Promise<number>;
  /** The next due card (of one goal when a topic is given) marked as asked; null when nothing is due. */
  ask(now: number, topic?: string): Promise<{ card: Card; goal: Goal; due: number } | null>;
  /** The answer to the card being asked, or null when nothing is waiting for one. */
  answer(text: string, now: number): Promise<{ card: Card; quality: number; next: number } | null>;
  /** A quiz offered by the proactive check today: false when one was already offered. */
  claimOffer(day: string): Promise<boolean>;
}

const match = (topic: string, g: Goal): boolean => {
  const a = fold(topic);
  const b = fold(g.topic);
  return a === b || b.startsWith(`${a} `) || a.startsWith(`${b} `);
};

export function createLearning(kv: Kv | null): LearningStore {
  let local = empty();
  const readStrict = async (): Promise<LearningState> => {
    if (!kv) return structuredClone(local);
    const raw = await kv.get(LEARNING_KEY);
    if (!raw) return empty();
    try {
      return learningOf(JSON.parse(raw));
    } catch {
      log.error("the stored record is not valid JSON: starting again");
      return empty();
    }
  };
  const write = async (s: LearningState): Promise<void> => {
    if (kv) await kv.set(LEARNING_KEY, JSON.stringify(s), TTL_SECONDS);
    local = structuredClone(s);
  };
  let chain: Promise<unknown> = Promise.resolve();
  const change = <T>(fn: (s: LearningState) => { out: T; changed: boolean }): Promise<T> => {
    const run = chain.then(async () => {
      const s = await readStrict();
      const { out, changed } = fn(s);
      if (changed) await write(s);
      return out;
    });
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
  const goalFor = (s: LearningState, topic: string, now: number): { goal: Goal; isNew: boolean } | null => {
    const t = line(topic, TOPIC_MAX);
    if (!t) return null;
    const there = s.goals.find((g) => match(t, g));
    if (there) {
      delete there.paused;
      return { goal: there, isNew: false };
    }
    if (s.goals.length >= GOALS_MAX) {
      // The oldest paused goal makes room, with its cards; with none paused, no new goal.
      const old = s.goals.find((g) => g.paused);
      if (!old) return null;
      s.goals = s.goals.filter((g) => g !== old);
      s.cards = s.cards.filter((c) => c.goal !== old.id);
    }
    const goal: Goal = { id: newId(), topic: t, at: now };
    s.goals.push(goal);
    return { goal, isNew: true };
  };
  return {
    read: () => change((s) => ({ out: s, changed: false })),
    addGoal: (topic, now) =>
      change((s) => {
        const r = goalFor(s, topic, now);
        return { out: r ? structuredClone(r) : null, changed: !!r };
      }),
    pauseGoal: (topic) =>
      change((s) => {
        const g = s.goals.find((x) => match(topic, x));
        if (!g) return { out: null, changed: false };
        g.paused = true;
        if (s.asking && s.cards.find((c) => c.id === s.asking!.card)?.goal === g.id) delete s.asking;
        return { out: structuredClone(g), changed: true };
      }),
    addCards: (cards, now) =>
      change((s) => {
        let kept = 0;
        for (const c of cards.slice(0, 5)) {
          const q = line(c.q, Q_MAX);
          const a = line(c.a, A_MAX);
          if (!q || !a) continue;
          const r = goalFor(s, c.goal, now);
          if (!r) continue;
          if (s.cards.some((x) => x.goal === r.goal.id && fold(x.q) === fold(q))) continue;
          // First due tomorrow: today's lesson already showed it.
          s.cards.push({ id: newId(), goal: r.goal.id, q, a, ef: 2.5, reps: 0, interval: 0, due: now + DAY_MS, at: now, seen: 0, right: 0 });
          kept++;
        }
        s.cards = s.cards.slice(-CARDS_MAX);
        return { out: kept, changed: kept > 0 };
      }),
    ask: (now, topic) =>
      change((s) => {
        const goals = s.goals.filter((g) => !g.paused && (!topic || match(topic, g)));
        const due = s.cards.filter((c) => goals.some((g) => g.id === c.goal) && c.due <= now).sort((a, b) => a.due - b.due);
        const card = due[0];
        if (!card) return { out: null, changed: false };
        s.asking = { card: card.id, at: now };
        return { out: { card: structuredClone(card), goal: structuredClone(goals.find((g) => g.id === card.goal)!), due: due.length }, changed: true };
      }),
    answer: (text, now) =>
      change((s) => {
        const ask = s.asking;
        if (!ask || now - ask.at > ASK_MS) return { out: null, changed: false };
        const card = s.cards.find((c) => c.id === ask.card);
        if (!card) {
          delete s.asking;
          return { out: null, changed: true };
        }
        const quality = grade(text, card.a);
        // Not right, and not shaped like an answer ("remind me to call the dentist", "what's on tomorrow?"): a new request, which goes on to
        // the assistant; the question keeps waiting for its answer.
        if (quality < 3 && !answerShaped(text, card.a)) return { out: null, changed: false };
        delete s.asking;
        Object.assign(card, sm2(card, quality, now), { seen: (card.seen ?? 0) + 1, right: (card.right ?? 0) + (quality >= 3 ? 1 : 0) });
        return { out: { card: structuredClone(card), quality, next: card.due }, changed: true };
      }),
    claimOffer: (day) =>
      change((s) => {
        if (s.offered === day) return { out: false, changed: false };
        s.offered = day;
        return { out: true, changed: true };
      }),
  };
}

/** The first words of a request or a question, not of an answer: English, and Spanish for an owner who answers cards in it. On plainWords. */
const REQUEST = new RegExp(
  "^(?:recuerdame|recuerdale|llama|llamame|llamale|dile|dime|escribe|escribele|manda|mandale|envia|enviale|apunta|anota|pon|ponme|busca" +
    "|reserva|cancela|mueve|avisa|avisame|contesta|responde|que|cual|cuando|donde|quien|cuanto|cuantos|tengo|hay|puedes|podrias" +
    "|remind|call|tell|send|text|email|write|add|set|book|cancel|move|find|what|when|where|who|which|how|can|could|do|is|are)\\b",
);

/**
 * Whether a message not graded right still reads as an attempt at `expected` rather than a new request: no question mark, not opening
 * with a request or question word that the answer itself does not start with, and not much longer than the answer.
 */
export function answerShaped(text: string, expected: string): boolean {
  if (/[?¿]/.test(text)) return false;
  const a = plainWords(text);
  const e = expected.split(/[/;]/).map(plainWords).filter(Boolean);
  const first = a.split(" ")[0] ?? "";
  if (REQUEST.test(a) && !e.some((x) => x.split(" ")[0] === first)) return false;
  const most = Math.max(0, ...e.map((x) => x.split(" ").length));
  return a.split(" ").length <= Math.max(4, most * 2 + 1);
}

/** Whether a question is waiting for this message as its answer: asked a moment ago, and the message is short (not a new request). */
export const waitingAnswer = (s: LearningState, text: string, now: number): boolean =>
  !!s.asking && now - s.asking.at <= ASK_MS && text.trim().length <= 80 && !/\n/.test(text.trim());

// ---------- what the owner reads ----------

const T = texts(
  {
    goalNew: "📚 Noted your goal: {topic}. I'll give you short lessons and quiz you at good moments (QUIZ ME whenever you like).",
    goalAgain: "📚 Back to {topic}.",
    goalFull: "You already have {n} goals. Pause one (STOP LEARNING and its name) to start another.",
    question: "❓ {topic}: {q}\n(Answer in one message; “I don't know” is fine too.)",
    nothingDue: "Nothing to review right now{topic}. Shall I give you a new lesson?",
    noGoals: "You have no learning goals yet. Tell me “I want to learn…” and we'll start.",
    right: "✅ Right! I'll ask again {when}.",
    close: "✅ Nearly: “{a}”. I'll ask again {when}.",
    wrong: "❌ It was “{a}”. I'll ask you again tomorrow.",
    passed: "It was “{a}”. I'll ask you again tomorrow.",
    more: "{n} more to review: QUIZ ME for the next one.",
    progressHead: "📚 What you're learning:",
    progressLine: "• {topic}{paused}: {cards} cards, {due} to review today, {pct} right",
    paused: " (paused)",
    pausedSaid: "⏸️ Paused {topic}. Its cards stay; “I want to learn {topic}” to carry on.",
    unknownGoal: "I have no goal called “{topic}”.",
    offer: "📚 A minute of {topic}? {q}\n(Answer here, or carry on with your day.)",
    tomorrow: "tomorrow",
    inDays: "in {n} days",
    unread: "I couldn't read what you're learning right now. Try again in a moment.",
  },
);
export const learningTexts = T;

export const questionText = (card: Card, goal: Goal, l: Lang): string => T(l)("question", { topic: goal.topic, q: card.q });

export function answerText(r: { card: Card; quality: number; next: number }, due: number, now: number, l: Lang): string {
  const t = T(l);
  const days = Math.max(1, Math.round((r.next - now) / DAY_MS));
  const when = days === 1 ? t("tomorrow") : t("inDays", { n: days });
  const said = r.quality >= 5 ? t("right", { when }) : r.quality >= 3 ? t("close", { a: r.card.a, when }) : r.quality === 0 ? t("passed", { a: r.card.a })
    : t("wrong", { a: r.card.a });
  return due > 0 ? `${said}\n${t("more", { n: due })}` : said;
}

export function progressText(s: LearningState, now: number, l: Lang): string {
  const t = T(l);
  if (!s.goals.length) return t("noGoals");
  const lines = s.goals.map((g) => {
    const cards = s.cards.filter((c) => c.goal === g.id);
    const seen = cards.reduce((n, c) => n + (c.seen ?? 0), 0);
    const right = cards.reduce((n, c) => n + (c.right ?? 0), 0);
    return t("progressLine", {
      topic: g.topic, paused: g.paused ? t("paused") : "", cards: cards.length, due: g.paused ? 0 : cards.filter((c) => c.due <= now).length,
      pct: seen ? `${Math.round((right / seen) * 100)} %` : "—",
    });
  });
  return [t("progressHead"), ...lines].join("\n");
}

/** For the assistant's context: each goal, with the questions it already has (so a new lesson does not repeat them). Nothing about health. */
export function learningContext(s: LearningState, now: number): string[] {
  return s.goals.filter((g) => !g.paused).map((g) => {
    const cards = s.cards.filter((c) => c.goal === g.id);
    const due = cards.filter((c) => c.due <= now).length;
    const qs = cards.slice(-8).map((c) => c.q).join(" / ");
    return `${g.topic}: ${cards.length} cards, ${due} due${qs ? `; latest: ${qs}` : ""}`.slice(0, 600);
  });
}

/**
 * A quiz the proactive check may offer: the most overdue card, once a day, from a goal that is not paused. Null when there is nothing due
 * (NO_REPLY). The check claims the day (claimOffer) and marks the card asked (ask) when it really sends it.
 */
export function learningNudge(s: LearningState, now: number, tz: string, l: Lang): { key: string; text: string; topic: string } | null {
  const day = today(now, tz);
  if (s.offered === day) return null;
  const goals = s.goals.filter((g) => !g.paused);
  const card = s.cards.filter((c) => c.due <= now && goals.some((g) => g.id === c.goal)).sort((a, b) => a.due - b.due)[0];
  if (!card) return null;
  const goal = goals.find((g) => g.id === card.goal)!;
  return { key: `learning:${day}`, topic: goal.topic, text: T(l)("offer", { topic: goal.topic, q: card.q }) };
}
