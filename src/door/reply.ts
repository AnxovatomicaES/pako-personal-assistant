// The assistant's answer and what its tags ask for: done, held for the owner's yes when outside text asked, or refused.

import type { Request, Response } from "express";
import type { CalendarProposalIn } from "./calendar-cards.ts";
import { isEvery, type Change } from "../undo.ts";
import { hasActs, outsideOf, type HeldActs } from "../quarantine.ts";
import { LIKE_MAX, LIKES_MAX, NAME_MAX, NOTE_MAX as PERSON_NOTE_MAX, RELATION_MAX, type PersonInput } from "../people.ts";
import { ATTRIBUTE_MAX, VALUE_MAX } from "../memory-facts.ts";
import { isRoutineKey } from "../routines.ts";
import type { Door } from "./door.ts";
import { dumpItemsOf } from "../gentle-dump.ts";
import { checkinItemsOf } from "../gentle-checkins.ts";
import { createLog } from "../log.ts";
import { cut } from "./shared.ts";

const logProactive = createLog("proactive");
const logFacts = createLog("facts");

type To = { to?: unknown; text?: unknown };
type Remind = { at?: unknown; text?: unknown; every?: unknown };
type ListOp = { name?: unknown; op?: unknown; items?: unknown };
type TaskAdd = { text?: unknown; due?: unknown };

/** What the bridge posts to /assistant/reply. */
type ReplyBody = {
  text?: unknown;
  /** A notice the owner did not just ask for (an email): kept for later when WhatsApp's 24-hour window is closed. */
  notice?: unknown;
  call?: { name?: unknown; message?: unknown; direct?: unknown };
  message?: To;
  send?: To;
  /** A newer bridge (<email>, src/autonomy.ts): an email from Pako's own inbox. */
  email?: { to?: unknown; subject?: unknown; text?: unknown };
  /** A newer bridge: the words it heard in the owner's voice note this answers (the server never hears them itself), for provenance. */
  heard?: unknown;
  remind?: Remind[];
  unremind?: unknown;
  book?: { what?: unknown; when?: unknown; party?: unknown; notes?: unknown; name?: unknown };
  /** Newer bridges (<list>, <task>, <done>): items added to or taken off a named list, tasks to keep, words of open tasks now done. */
  lists?: ListOp[];
  tasks?: TaskAdd[];
  done?: unknown;
  /** A newer bridge (<closed>, close_followup): words of follow-ups the owner said are handled. */
  closed?: unknown;
  /** A newer bridge (<promise>, keep_promise): promises the owner made in the chat. */
  promises?: unknown;
  /** A newer bridge whose server said calendarWrites: the proposed calendar change, asked on a card (src/door/calendar-cards.ts). */
  calendar?: unknown;
  /** The bridge's id for this answer: what it asks for (a card, a reminder, a table search) is done once, however many times it is sent. */
  key?: unknown;
  /** A newer bridge: this answer's notes went to /assistant/memory first (their entry may be another copy's, after a restart). */
  noted?: unknown;
  /**
   * A newer bridge: this answer's turn read outside text (src/quarantine.ts), and why. What its tags ask is held for the owner's press,
   * its notes too (`remember`, `forget`, sent here instead of to /assistant/memory). An older bridge never sends it: acted on as before.
   */
  outside?: unknown;
  remember?: unknown;
  forget?: unknown;
  /**
   * A newer bridge: new outside text was in this turn's context lines (src/quarantine.ts), and where from. What deletes, stands or is kept is held
   * for the owner's press (its `forget` comes here too), and words Pako wrote to someone ask first: only what reaches someone acts now.
   */
  context?: unknown;
  /** A newer bridge (<person>): someone in the owner's life, as the owner told it (src/people.ts). */
  people?: unknown;
  /** A newer bridge (<routine>, <watch>): routines and watches to make (src/routines.ts). */
  routines?: { at?: unknown; every?: unknown; text?: unknown }[];
  watches?: { on?: unknown; from?: unknown; words?: unknown; once?: unknown; text?: unknown }[];
  /** A newer bridge (<fact>): what the owner said about their tastes, plans and life (src/proactive.ts). */
  facts?: unknown;
  /** A newer bridge (<know>): dated facts the owner told about themselves or someone (src/memory-facts.ts). */
  know?: unknown;
  /** A newer bridge (<health>, <goal>, <card>): the health diary, learning goals and quiz cards (src/companion.ts). */
  health?: unknown;
  goals?: unknown;
  cards?: unknown;
  /** A newer bridge (<dump>, brain_dump): the owner's brain dump, sorted into reminders, promises, tasks and notes (src/gentle-dump.ts). */
  dump?: unknown;
  /** A newer bridge (<checkin>, check_in): check-ins the owner asked for, at a time or in minutes (src/gentle-checkins.ts). */
  checkins?: unknown;
};

/**
 * The answer's tags, read and bounded: what it asks for (`acts`), and, for a turn with new outside text in its context, the part held for
 * the owner's press (`contextHeld`) and the part done at once (`contextActs`).
 */
/** The proposed calendar changes, field by field: one at most, each time "YYYY-MM-DD HH:MM" (the card reads it in the owner's zone). */
const calendarOf = (v: unknown): CalendarProposalIn[] => {
  const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
  const s = (x: unknown, max: number): string => (typeof x === "string" ? cut(x.replace(/\s+/g, " ").trim(), max) : "");
  return (Array.isArray(v) ? v : []).slice(0, 1).flatMap((x): CalendarProposalIn[] => {
    if (!x || typeof x !== "object") return [];
    const p = x as Record<string, unknown>;
    const op = p.op === "create" || p.op === "move" || p.op === "cancel" ? p.op : null;
    const title = s(p.title, 150);
    const start = s(p.start, 16);
    if (!op || !title || !STAMP.test(start)) return [];
    const end = s(p.end, 16);
    const newStart = s(p.newStart, 16);
    if (op === "move" && !STAMP.test(newStart)) return [];
    return [{ op, title, start, ...(STAMP.test(end) ? { end } : {}), ...(op === "move" ? { newStart } : {}), ...(s(p.place, 150) ? { place: s(p.place, 150) } : {}) }];
  });
};

const readReply = (door: Door, b: ReplyBody) => {
  const { d, strings } = door;
  const book = d.booking && b.book && typeof b.book.what === "string" && typeof b.book.when === "string" && Number.isInteger(Number(b.book.party))
    ? {
        what: cut(b.book.what.replace(/\s+/g, " ").trim(), 200),
        when: b.book.when.trim().slice(0, 16),
        party: Number(b.book.party),
        ...(typeof b.book.notes === "string" && b.book.notes.trim() ? { notes: cut(b.book.notes.replace(/\s+/g, " ").trim(), 300) } : {}),
        ...(typeof b.book.name === "string" && b.book.name.trim() ? { name: cut(b.book.name.replace(/\s+/g, " ").trim(), 60) } : {}),
      }
    : null;
  const remind = (Array.isArray(b.remind) ? b.remind : []).slice(0, 2)
    .filter((r): r is Remind => !!r && typeof r.at === "string" && typeof r.text === "string")
    .map((r) => ({ at: String(r.at).trim().slice(0, 16), text: cut(String(r.text).replace(/\s+/g, " ").trim(), 200), every: isEvery(r.every) ? r.every : undefined }));
  const unremind = strings(b.unremind, 2, 3, 80);
  const listOps = (Array.isArray(b.lists) ? b.lists : []).slice(0, 2).flatMap((l: ListOp) => {
    if (!l || typeof l.name !== "string" || (l.op !== "add" && l.op !== "remove")) return [];
    const name = cut(l.name.replace(/\s+/g, " ").trim(), 40);
    const items = strings(l.items, 10, 1, 120);
    return name && items.length ? [{ name, op: l.op as "add" | "remove", items }] : [];
  });
  const taskAdds = (Array.isArray(b.tasks) ? b.tasks : []).slice(0, 3).flatMap((x: TaskAdd) =>
    x && typeof x.text === "string" && x.text.trim().length >= 2
      ? [{ text: cut(x.text.replace(/\s+/g, " ").trim(), 200), due: typeof x.due === "string" ? x.due.trim().slice(0, 20) : "" }]
      : []);
  const doneWords = strings(b.done, 3, 3, 80);
  const closedWords = strings(b.closed, 3, 2, 80);
  const promiseAdds = (Array.isArray(b.promises) ? b.promises : []).slice(0, 2).flatMap((x: unknown) => {
    const p = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const text = typeof p.text === "string" ? cut(p.text.replace(/\s+/g, " ").trim(), 200) : "";
    if (text.length < 3) return [];
    const who = typeof p.who === "string" ? cut(p.who.replace(/\s+/g, " ").trim(), 60) : "";
    const due = typeof p.due === "string" && /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(p.due.trim()) ? p.due.trim() : "";
    return [{ text, who, due }];
  });
  // Three people at most per answer, each field short: more would be a runaway or an injection.
  const line = (v: unknown, max: number): string => (typeof v === "string" ? cut(v.replace(/\s+/g, " ").trim(), max) : "");
  const personAdds = (Array.isArray(b.people) ? b.people : []).slice(0, 3).flatMap((x: unknown): PersonInput[] => {
    const p = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const name = line(p.name, NAME_MAX);
    if (!name) return [];
    const relation = line(p.relation, RELATION_MAX);
    const birthday = line(p.birthday, 20);
    const likes = strings(p.likes, LIKES_MAX, 1, LIKE_MAX);
    const notes = strings(p.notes, 3, 2, PERSON_NOTE_MAX);
    return [{ name, ...(relation ? { relation } : {}), ...(birthday ? { birthday } : {}), ...(likes.length ? { likes } : {}), ...(notes.length ? { notes } : {}) }];
  });
  const routineAdds = (Array.isArray(b.routines) ? b.routines : []).slice(0, 1).flatMap((r) =>
    r && typeof r.at === "string" && typeof r.every === "string" && typeof r.text === "string"
      ? [{ at: r.at.trim().slice(0, 16), every: r.every.trim().slice(0, 10), text: cut(r.text.replace(/\s+/g, " ").trim(), 300) }]
      : []);
  const watchAdds = (Array.isArray(b.watches) ? b.watches : []).slice(0, 1).flatMap((w) =>
    w && typeof w.on === "string" && typeof w.text === "string"
      ? [{ on: w.on.slice(0, 10), from: w.from, words: w.words, once: w.once !== false, text: cut(w.text.replace(/\s+/g, " ").trim(), 300) }]
      : []);
  const outside = outsideOf(b.outside);
  const context = outside.length ? [] : outsideOf(b.context);
  // The companion's tags, kept only from the owner's own turn: other people's text never writes the diary or a lesson (dropped, not held).
  const objs = (v: unknown, n: number): Record<string, unknown>[] =>
    (Array.isArray(v) ? v : []).slice(0, n).filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  const roleTags = outside.length ? {} : {
    health: objs(b.health, 3).flatMap((h) => (typeof h.text === "string" ? [{ kind: line(h.kind, 20), text: line(h.text, 300) }] : [])),
    goals: strings(b.goals, 2, 2, 60),
    cards: objs(b.cards, 5).flatMap((c) => {
      const [goal, q, a] = [line(c.goal, 60), line(c.q, 200), line(c.a, 120)];
      return goal && q && a ? [{ goal, q, a }] : [];
    }),
  };
  const roleCount = (roleTags.health?.length ?? 0) + (roleTags.goals?.length ?? 0) + (roleTags.cards?.length ?? 0);
  const knowAdds = objs(b.know, 3).flatMap((k) => {
    const [key, value] = [line(k.key, ATTRIBUTE_MAX), line(k.value, VALUE_MAX)];
    return key && value ? [{ who: line(k.who, 60), key, value, since: line(k.since, 10), starts: line(k.starts, 10) }] : [];
  });
  // Notes come with a reply only from a marked turn, or one with new outside text in its context (held below); any other reply's notes went
  // to /assistant/memory.
  const noteAdds = outside.length || context.length ? strings(b.remember, 3, 3, 300) : [];
  const noteDrops = outside.length || context.length ? strings(b.forget, 2, 4, 80) : [];
  const text = typeof b.text === "string" ? cut(b.text.trim(), 8000) : "";
  const call = b.call && typeof b.call.name === "string" && typeof b.call.message === "string"
    ? { name: cut(b.call.name.trim(), 40), message: cut(b.call.message.replace(/\s+/g, " ").trim(), 300), direct: b.call.direct === true }
    : null;
  const message = b.message && typeof b.message.to === "string" && typeof b.message.text === "string"
    ? { to: cut(b.message.to.trim(), 40), text: cut(b.message.text.trim(), 700) }
    : null;
  const send = b.send && typeof b.send.to === "string" && typeof b.send.text === "string"
    ? { to: cut(b.send.to.trim(), 40), text: cut(b.send.text.trim(), 700) }
    : null;
  const email = b.email && typeof b.email.to === "string" && typeof b.email.text === "string" && b.email.text.trim()
    ? {
        to: cut(b.email.to.replace(/\s+/g, " ").trim(), 120),
        subject: typeof b.email.subject === "string" ? cut(b.email.subject.replace(/\s+/g, " ").trim(), 150) : "",
        text: cut(b.email.text.trim(), 3000),
      }
    : null;
  const heard = typeof b.heard === "string" ? cut(b.heard, 4000) : "";
  const acts: HeldActs = {
    call, message, send, email, book, remind, unremind, lists: listOps, tasks: taskAdds, done: doneWords, remember: noteAdds, forget: noteDrops,
    ...(closedWords.length ? { closed: closedWords } : {}),
    ...(promiseAdds.length ? { promises: promiseAdds } : {}),
    ...(personAdds.length ? { people: personAdds } : {}),
  };
  const lifeFacts = Array.isArray(b.facts) ? b.facts.slice(0, 3) : [];
  // A turn with new outside text in its context: everything it would keep waits for the press, as a marked turn's would. What deletes or
  // stands, and also what it adds (a note, a reminder, a list item, a task, a promise, a fact, the diary): kept at once, an injected line
  // would be read in every later turn as the owner's own words. Only what reaches someone acts now, through src/autonomy.ts, which asks
  // first for words Pako wrote with that text in front of it.
  const contextHeld: HeldActs = {
    ...acts, call: null, message: null, send: null, email: null, book: null,
    ...(lifeFacts.length ? { facts: lifeFacts as NonNullable<HeldActs["facts"]> } : {}),
    ...(knowAdds.length ? { know: knowAdds } : {}),
    ...(roleCount ? { role: roleTags } : {}),
  };
  const contextActs: HeldActs = { call, message, send, email, book, remind: [], unremind: [], lists: [], tasks: [], done: [], remember: [], forget: [] };
  const dump = dumpItemsOf(b.dump);
  const checkins = checkinItemsOf(b.checkins);
  return { text, acts, contextHeld, contextActs, outside, context, heard, lifeFacts, routineAdds, watchAdds, knowAdds, roleTags, roleCount, dump, checkins };
};

export function mountReply(door: Door): void {
  const {
    app, d, now, tx, companion, via, telegramReady, lastRoute, sendText, turnOf, windowOver, notifyOwner, replyKeys, remember, keyOf, routeOf,
    claimReceipt, replyReceipt, learnKnow, failed, bridge, json, act, holdReply,
  } = door;
  /**
   * The assistant's answer: text for the owner, and at most one proposed call (shown with buttons, placed only when the owner presses Confirm).
   * True when its text went.
   */
  const handleReply = async (req: Request, res: Response): Promise<boolean> => {
    const b = (req.body ?? {}) as ReplyBody;
    const key = keyOf(b.key);
    const actionsDone = key !== "" && replyKeys.has(key);
    const {
      text, acts, contextHeld, contextActs, outside, context, heard, lifeFacts, routineAdds, watchAdds, knowAdds, roleTags, roleCount, dump, checkins,
    } = readReply(door, b);
    if (!text && !hasActs(acts) && !routineAdds.length && !watchAdds.length && !lifeFacts.length && !roleCount && !knowAdds.length && !calendarOf(b.calendar).length
      && !dump.length && !checkins.length) {
      res.status(400).json({ error: "Nothing to send." });
      return false;
    }
    // An answer sent without its message's key ("Un momento…", a note that Claude failed, an older bridge) belongs to the owner's last message: on
    // a computer it goes where they last wrote, not to the phone as what Pako starts does. A notice (an email's summary) is started by Pako.
    const route = routeOf(key) ?? (d.local && b.notice !== true ? await lastRoute() : null);
    /**
     * An answer: as it is, unless WhatsApp's 24 hours since the owner's message are over (the computer slept through them), where Meta would
     * take it and drop it saying nothing. Then on Telegram when paired, otherwise as a notice (the template, or with the owner's next message).
     */
    const replyText = async (t: string): Promise<boolean> => {
      if (d.local || via.getStore() === "telegram" || !(await windowOver(now()))) return sendText(t);
      if (await telegramReady()) return via.run("telegram", () => sendText(t));
      await notifyOwner(tx("lateAnswer", { text: t }));
      return true;
    };
    let outcome = false;
    const answer = async (): Promise<void> => {
      // The receipt for this answer's notes goes with it, after its text and what it asks for: their own wait is over (even if the text is slow).
      if (!actionsDone) claimReceipt(key);
      const changes: Change[] = [];
      let sent: boolean;
      try {
        // A routine's run is started by Pako, not an answer to a message just written: it goes like a notice (kept while the window is closed).
        sent = !text ? true : b.notice === true || isRoutineKey(key) ? (await notifyOwner(text), true) : await replyText(text);
        outcome = sent;
        if (actionsDone) {
          res.status(sent ? 200 : 502).json({ ok: sent, repeated: true });
          return;
        }
        if (key) remember(replyKeys, key);
        // Only a turn of the owner's own acts at once: one that read outside text is held, logged and asked about with a card.
        if (outside.length && hasActs(acts)) await holdReply(acts, outside);
        else if (context.length) {
          if (hasActs(contextHeld)) await holdReply(contextHeld, context);
          await act(contextActs, changes, { ...(await turnOf(key, heard, b.notice === true || isRoutineKey(key))), context });
        } else await act(acts, changes, await turnOf(key, heard, b.notice === true || isRoutineKey(key)));
        // Facts are kept only from a turn of the owner's own words: the engine drops those of a turn that read outside text, and those of a
        // turn with new outside text in its context are on its card (contextHeld).
        const own = !context.length;
        if (own && lifeFacts.length && d.life) await d.life.learn(lifeFacts, { outside: outside.length > 0 }).catch((err: Error) => logProactive.error(`${err.message}`));
        if (own && knowAdds.length) await learnKnow(knowAdds, outside.length > 0).catch((err: Error) => logFacts.error(`${err.message}`));
        if (own && roleCount) await companion.keep(roleTags);
        // A calendar change: always a card first, saying where it came from (this turn's outside text, if any).
        for (const p of calendarOf(b.calendar)) await door.proposeCalendar(p, outside.length ? outside : context);
        if (routineAdds.length || watchAdds.length) {
          await door.makeRoutines(routineAdds, watchAdds, outside.length ? "outside" : isRoutineKey(key) ? "fromRoutine" : context.length ? "outside" : null, changes);
        }
        // A brain dump: only from the owner's own words (a turn that read outside text, or a routine's run, sorts nothing), its own card.
        if (dump.length) await door.brainDump(dump, await turnOf(key, heard, b.notice === true || isRoutineKey(key)), { outside: outside.length > 0 || isRoutineKey(key) });
        // Check-ins: the owner's own asks only (never from a turn that read outside text, nor a routine's run); a time that did not work is said.
        if (checkins.length && d.gentle?.checkinAdd && !outside.length && !isRoutineKey(key)) {
          for (const c of checkins) {
            const r = await d.gentle.checkinAdd(c).catch(() => ({ ok: false, say: "" }));
            if (!r.ok && r.say) await sendText(r.say);
          }
        }
      } finally {
        // One receipt for all this answer changed (its notes too), after its text, even when something above failed half way.
        if (!actionsDone) await replyReceipt(key, changes, b.noted === true);
      }
      res.status(sent ? 200 : 502).json({ ok: sent });
    };
    try {
      await (route ? via.run(route, answer) : answer());
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
    return outcome;
  };
  /** Answers being handled, by key: what a second copy of one of them waits for. */
  const answering = new Map<string, Promise<boolean>>();
  app.post("/assistant/reply", failed, bridge, json, async (req, res) => {
    const key = keyOf(((req.body ?? {}) as ReplyBody).key);
    // The bridge gives up on a slow answer after 30 s and sends the same one again (same key) while the first is still being handled: the copy
    // waits for it and says how it went, so what the answer asks for is done once and its text goes once. (A copy that comes after it ended is
    // told apart by the key the first one kept: replyKeys.)
    const first = key ? answering.get(key) : undefined;
    if (first) {
      const sent = await first;
      res.status(sent ? 200 : 502).json({ ok: sent, repeated: true });
      return;
    }
    let settle: (sent: boolean) => void = () => undefined;
    if (key) answering.set(key, new Promise<boolean>((resolve) => (settle = resolve)));
    let sent = false;
    try {
      sent = await handleReply(req, res);
    } finally {
      if (key) answering.delete(key);
      settle(sent);
    }
  });
}
