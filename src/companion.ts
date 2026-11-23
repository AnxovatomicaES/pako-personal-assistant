// More than an assistant: the friend (src/friend.ts), the health companion (src/health.ts) and the teacher (src/learning.ts) behind one
// door. src/whatsapp.ts answers the owner's plain words with `command` (before Claude, from the owner's own message only) and keeps what a
// reply's <health>, <goal> and <card> tags ask for with `keep` (dropped for a turn that read other people's text).
//
// `offers` is what the proactive check may say, one candidate per role, each claimed only when it is really sent (`claim`), so two ticks never
// both send it. Every offer is about the owner alone: a quiz, a habit, a date, a check-in. None reaches another person; a birthday is an
// offer to draft a message the owner sends themselves. The check decides when (its budget, quiet and active hours, idle only, topics on or
// off): with nothing worth saying here, `offers` is empty, which is its NO_REPLY.

import type { Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import { birthdayEves, checkinNudge, createFriend, datesContext, friendCommand, friendTexts } from "./friend.ts";
import {
  createHealth, doctorSummary, healthCommand, healthNudge, healthText, healthTexts, HEALTH_KINDS, loggedText, notDeviceText, redFlag, redFlagReply, sleepText,
  type HealthKind, type RedFlag,
} from "./health.ts";
import {
  answerText, createLearning, learningCommand, learningContext, learningNudge, learningTexts, progressText, questionText, waitingAnswer,
} from "./learning.ts";
import type { Person } from "./people.ts";
import { createLog } from "./log.ts";

const logHealth = createLog("health");
const logLearning = createLog("learning");

export type Topic = "friend" | "health" | "learning";

export interface Offer {
  topic: Topic;
  /** Stable for the day: the same offer twice has the same key. */
  key: string;
  text: string;
  /** Marks it sent (and, for a quiz, the question asked): false when another tick sent it first. Call it just before sending. */
  claim(): Promise<boolean>;
  /** Gives the claim back when its card could not be sent: it was never said, so it may come at the next look. */
  release(): Promise<void>;
}

export interface CompanionDeps {
  kv: Kv | null;
  timeZone: string;
  lang: () => Lang;
  /** The people in the owner's life (src/people.ts), for the dates; [] when they cannot be read. */
  people: () => Promise<Person[]>;
  /** The owner's country (PAKO_COUNTRY), for the emergency number. */
  country?: string;
  /**
   * Whether the health diary goes to `kv` (the owner's own computer: ~/.pako). False on a server on the internet: the diary is kept in
   * memory only there, like proactive Pako's mood and health facts. Default true (tests and the computer).
   */
  healthOnDisk?: boolean;
  /** FORGET MY HEALTH forgets the mood and health facts proactive Pako keeps too (src/proactive.ts): one confirmation for both. */
  alsoForget?: () => Promise<void>;
  /** Those facts, read only for the owner's own "how am I sleeping?" (never logged, never in a context). */
  moreHealth?: () => Promise<{ at: number; text: string }[]>;
  /**
   * Labs (PAKO_LABS=on): the health diary, learning and the weekly check-in. Off (false), none of them is answered, kept or offered, and the
   * owner's words go to the assistant as any message; the red flag's emergency answer (`red`), the birthdays and FORGET MY HEALTH stay on
   * (the mood and health facts are kept whatever Labs says). Default on.
   */
  labs?: boolean;
  now?: () => number;
}

/** What a reply's tags ask the companion to keep (from the owner's own turn only). */
export interface CompanionTags {
  health?: { kind: string; text: string }[];
  goals?: string[];
  cards?: { goal: string; q: string; a: string }[];
}

export function createCompanion(d: CompanionDeps) {
  const now = d.now ?? Date.now;
  const health = createHealth(d.healthOnDisk === false ? null : d.kv);
  const learning = createLearning(d.kv);
  const friend = createFriend(d.kv);
  const country = d.country ?? "";
  const labs = d.labs !== false;
  /** FORGET MY HEALTH asked once: the confirmation counts for 5 minutes. */
  let forgetAskedAt = 0;

  /**
   * The owner's plain words, answered here: `say` is the answer, and `pass` true lets the message go on to the assistant too (a new goal: the
   * assistant starts the lesson). Null: not one of these.
   */
  const command = async (text: string, command: string): Promise<{ say: string; pass?: boolean } | null> => {
    const l = d.lang();
    const t = now();
    const h = healthCommand(text, command);
    // Without Labs nothing is answered, except FORGET MY HEALTH: the assistant's turns still keep mood and health facts whatever Labs says
    // (assistant/prompt.ts, src/door/reply.ts), so the owner must always be able to delete them, in the default install too.
    if (!labs && h?.op !== "forget") return null;
    if (h) {
      const ht = healthTexts(l);
      try {
        if (h.op === "show") return { say: healthText(await health.read(), t, d.timeZone, l) };
        if (h.op === "doctor") return { say: doctorSummary(await health.read(), t, d.timeZone, l) };
        if (h.op === "sleep") {
          const more = await (d.moreHealth?.() ?? Promise.resolve([])).catch(() => []);
          return { say: sleepText(await health.read(), more, t, d.timeZone, l) };
        }
        if (h.op === "forget") {
          if (!h.sure || t - forgetAskedAt > 5 * 60_000) {
            forgetAskedAt = t;
            return { say: ht("forgetAsk") };
          }
          forgetAskedAt = 0;
          await health.forget();
          await d.alsoForget?.().catch((err: Error) => logHealth.error(`the mood and health facts could not be forgotten: ${err.name}`));
          return { say: ht("forgotten") };
        }
        // The first note says what the diary is and is not (not a medical device), once.
        const first = (await health.read().catch(() => null))?.entries?.length === 0;
        await health.add({ at: t, kind: h.kind, text: h.text });
        return { say: first ? `${loggedText(h.kind, l)}\n\n${notDeviceText(l, country)}` : loggedText(h.kind, l) };
      } catch (err) {
        // Never the diary's words in a log: only that the store failed.
        logHealth.error(`the diary could not be ${h.op === "log" ? "saved" : "read"}: ${(err as Error).name}`);
        return { say: ht(h.op === "log" ? "unsaved" : "unread") };
      }
    }
    const f = friendCommand(command);
    if (f) {
      await friend.setCheckin(f.on);
      return { say: friendTexts(l)(f.on ? "checkinOn" : "checkinOff") };
    }
    const c = learningCommand(text, command);
    if (c) {
      const lt = learningTexts(l);
      try {
        if (c.op === "goal") {
          const r = await learning.addGoal(c.topic, t);
          if (!r) return { say: lt("goalFull", { n: 10 }) };
          return { say: lt(r.isNew ? "goalNew" : "goalAgain", { topic: r.goal.topic }), pass: true };
        }
        const s = await learning.read();
        // With no goal at all, "quiz me…" and "my progress" are ordinary words for the assistant.
        if (!s.goals.length) return null;
        if (c.op === "progress") return { say: progressText(s, t, l) };
        if (c.op === "pause") {
          const g = await learning.pauseGoal(c.topic);
          return { say: g ? lt("pausedSaid", { topic: g.topic }) : lt("unknownGoal", { topic: c.topic }) };
        }
        const asked = await learning.ask(t, c.topic);
        if (!asked) return { say: lt("nothingDue", { topic: c.topic ? ` (${c.topic})` : "" }) };
        return { say: questionText(asked.card, asked.goal, l) };
      } catch (err) {
        logLearning.error(`could not answer: ${(err as Error).message}`);
        return { say: lt("unread") };
      }
    }
    // The answer to the question just asked (by QUIZ ME or the proactive quiz): a short message within the quarter of an hour.
    try {
      const s = await learning.read();
      if (waitingAnswer(s, text, t)) {
        // A "not now" to the quiz the check offered: let it go (the card stays due), said once, never graded as a miss.
        if (await learning.decline(text, t)) return { say: learningTexts(l)("declined") };
        const r = await learning.answer(text, t);
        if (r) {
          const due = (await learning.read()).cards.filter((x) => x.due <= t && x.goal === r.card.goal).length;
          return { say: answerText(r, due, t, l) };
        }
      }
    } catch (err) {
      logLearning.error(`could not grade an answer: ${(err as Error).message}`);
    }
    return null;
  };

  /** What a reply's tags ask to keep. Never throws; returns how many things were kept. */
  const keep = async (tags: CompanionTags): Promise<number> => {
    if (!labs) return 0;
    const t = now();
    let kept = 0;
    try {
      for (const h of (tags.health ?? []).slice(0, 3)) {
        const kind: HealthKind = (HEALTH_KINDS as readonly string[]).includes(h.kind) ? (h.kind as HealthKind) : "other";
        if (h.text.trim().length < 2) continue;
        await health.add({ at: t, kind, text: h.text });
        kept++;
      }
    } catch (err) {
      logHealth.error(`the diary could not be saved: ${(err as Error).name}`);
    }
    try {
      for (const g of (tags.goals ?? []).slice(0, 2)) if (await learning.addGoal(g, t)) kept++;
      if (tags.cards?.length) kept += await learning.addCards(tags.cards, t);
    } catch (err) {
      logLearning.error(`the cards could not be saved: ${(err as Error).message}`);
    }
    return kept;
  };

  /** For the assistant's context: learning goals and the next week's birthdays. Never health: the diary stays here. */
  const context = async (): Promise<{ learning?: string[]; dates?: string[] }> => {
    const t = now();
    const [s, people] = await Promise.all([learning.read().catch(() => null), d.people().catch(() => [] as Person[])]);
    const goals = s && labs ? learningContext(s, t) : [];
    const dates = datesContext(people, t, d.timeZone, d.lang());
    return { ...(goals.length ? { learning: goals } : {}), ...(dates.length ? { dates } : {}) };
  };

  /** What the proactive check may say now; [] when nothing is worth saying (NO_REPLY). */
  const offers = async (): Promise<Offer[]> => {
    const t = now();
    const l = d.lang();
    const out: Offer[] = [];
    const [people, f, h, s] = await Promise.all([
      d.people().catch(() => [] as Person[]),
      friend.read().catch(() => null),
      health.read().catch(() => null),
      learning.read().catch(() => null),
    ]);
    // A birthday first: tomorrow does not wait.
    for (const e of birthdayEves(people, t, d.timeZone, l)) {
      if (f?.offered.includes(`${e.person.id}:${e.year}`)) continue;
      out.push({
        topic: "friend", key: `friend:birthday:${e.person.id}:${e.year}`, text: e.text, claim: () => friend.claimBirthday(e.person.id, e.year),
        release: () => friend.releaseBirthday(e.person.id, e.year),
      });
    }
    // Without Labs only the birthdays: no check-in, quiz or health nudge.
    if (!labs) return out;
    const c = f ? checkinNudge(f, t, d.timeZone, l) : null;
    if (c) out.push({ topic: "friend", ...c, claim: () => friend.claimCheckin(t), release: () => friend.releaseCheckin(t, f?.lastCheckin) });
    const q = s ? learningNudge(s, t, d.timeZone, l) : null;
    if (q) {
      out.push({
        topic: "learning", key: q.key, text: q.text,
        claim: async () => (await learning.claimOffer(q.key.slice("learning:".length))) && !!(await learning.ask(t, q.topic, { offered: true })),
        release: () => learning.releaseOffer(q.key.slice("learning:".length), t),
      });
    }
    const n = h ? healthNudge(h, t, d.timeZone, l) : null;
    if (n) out.push({ topic: "health", ...n, claim: () => health.claimNudge(n.key.split(":").pop()!), release: () => health.releaseNudge(n.key.split(":").pop()!) });
    return out;
  };

  /** The red flag in the owner's own words, answered at once (the number first, nothing before it); null when there is none. */
  const red = (text: string): { flag: RedFlag; say: string } | null => {
    const flag = redFlag(text);
    return flag ? { flag, say: redFlagReply(flag, "en", country) } : null;
  };

  return { command, keep, context, offers, red, health, learning, friend, labs };
}

export type Companion = ReturnType<typeof createCompanion>;
