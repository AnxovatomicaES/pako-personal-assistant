// The owner's side: the nudge's buttons, PENDING, and the open loops in the assistant's context.

import { dueAtMeeting } from "./calendar-match.ts";
import type { Base, Engine, Owner } from "./parts.ts";
import { LAST_LOOK_BEFORE_MS, LATER_TODAY_MS, NONE_BEFORE_MS, PAST_HIDE_MS, REOPEN_MS, RULES_MAX, SNOOZE_MS } from "./limits.ts";
import { loopsOf } from "./record.ts";
import { T } from "./texts.ts";
import { zonedTime } from "./time.ts";
import type { ClosedLoop, CloseOutcome, FollowupsDoor, Loop } from "./types.ts";
import { GT } from "../gentle.ts";
import { ownerClock } from "../i18n.ts";
import { fold, today, tomorrow } from "../lists.ts";
import { createLog } from "../log.ts";

const log = createLog("followups");

/** The words the owner names a loop by: each one starts a word of its title or person ("deck" finds "decks"; "Ana" never finds "Mariana"). */
const keysOf = (words: string): string[] => fold(words).split(/[^\p{L}\p{N}]+/u).filter((k) => k.length >= 2);
const names = (keys: string[], l: Loop): boolean => {
  const words = fold(`${l.title} ${l.who}`).split(/[^\p{L}\p{N}]+/u);
  return keys.every((k) => words.some((w) => w.startsWith(k)));
};

export function mountOwner(
  { d, config, now, lang }: Base,
  { mutate, read, dueText, sourceText, quietNow, nextAfter }: Pick<
    Engine,
    "mutate" | "read" | "dueText" | "sourceText" | "quietNow" | "nextAfter"
  >,
): Owner {
  /** Gentle mode's "tomorrow": 09:00 in the owner's zone (or when the quiet hours end, if later), the day after today, whatever DST does. */
  const morningOf = (day: string): number | null => {
    const q = config.quiet;
    const nine = 9 * 60;
    const at = q && q.start > q.end && q.end > nine ? q.end : nine;
    return zonedTime(`${day} ${String(Math.floor(at / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}`, d.timeZone);
  };
  const tomorrowAt = (t: number): number => morningOf(tomorrow(t, d.timeZone)) ?? t + 24 * 3600_000;
  /**
   * Gentle mode's "later today": three hours on; if that falls in the quiet hours, the morning they end (09:00, or their end if later). Pressed
   * after midnight (01:00, quiet until 08:00) that is this morning, not the morning after.
   */
  const laterToday = (t: number): number => {
    const at = t + LATER_TODAY_MS;
    if (!quietNow(at)) return at;
    let end = at;
    for (let i = 0; i < 24 * 4 && quietNow(end); i++) end += 15 * 60_000;
    const morning = morningOf(today(end, d.timeZone));
    return morning !== null && morning > t ? Math.max(morning, end) : tomorrowAt(t);
  };
  const press: FollowupsDoor["press"] = async (button, id) => {
    const t = T(lang());
    try {
      let hit: Loop | null = null;
      const said = await mutate((s) => {
        const l = s.loops.find((x) => x.id === id);
        if (!l) return t("pressedGone");
        if (l.status === "done" || l.status === "dismissed") return t("pressedAlready");
        hit = l;
        // Any press is an answer: gentle mode counts nudges since the last one.
        delete l.unanswered;
        delete l.folded;
        if (button === "1") {
          Object.assign(l, { status: "done", closedAt: now(), nextCheckAt: 0 });
          return l.variant !== undefined ? GT()("pressedDone", { title: l.title }) : t("pressedDone", { title: l.title });
        }
        if (button === "2") {
          // An hour on, but never past its time: the reminder an hour before a deadline snoozed for an hour would be looked at after it, where
          // nothing is said any more (nudges.ts). Looked at again just before it instead (a minute on at the least, when it is that near).
          const t0 = now();
          const hour = t0 + SNOOZE_MS;
          const before = l.dueAt && l.dueAt > t0 + 60_000 && hour > l.dueAt - LAST_LOOK_BEFORE_MS ? Math.max(l.dueAt - LAST_LOOK_BEFORE_MS, t0 + 60_000) : null;
          Object.assign(l, { status: "snoozed", nextCheckAt: before ?? hour, snoozes: (l.snoozes ?? 0) + 1 });
          return t(before === null ? "pressedSnooze" : "pressedSnoozeSoon");
        }
        if (button === "4") return GT()("snoozeAsk", { title: l.title });
        if (button === "5" || button === "6") {
          const at = button === "5" ? laterToday(now()) : tomorrowAt(now());
          // An old Snooze card pressed after the item was parked (another chat, or later): it still comes back, and the reply says so.
          const wasParked = l.status === "parked";
          Object.assign(l, { status: "snoozed", nextCheckAt: at, snoozes: (l.snoozes ?? 0) + 1 });
          delete l.afterAsked;
          delete l.parkedAt;
          const sameDay = today(at, d.timeZone) === today(now(), d.timeZone);
          const words = wasParked ? (sameDay ? "backLater" : "backTomorrow") : sameDay ? "pressedLater" : "pressedTomorrow";
          return GT()(words, { title: l.title, time: ownerClock(at, d.timeZone) });
        }
        if (button === "7") {
          // Parked already (the same card on another chat, or pressed twice): it keeps when it was parked, and its month runs from then.
          if (l.status === "parked") return GT()("pressedPark", { title: l.title });
          Object.assign(l, { status: "parked", parkedAt: now(), nextCheckAt: 0 });
          d.control?.log("followup", GT()("pressedPark", { title: l.title }));
          return GT()("pressedPark", { title: l.title });
        }
        Object.assign(l, { status: "dismissed", closedAt: now(), nextCheckAt: 0 });
        s.rules = [...s.rules, { at: now(), who: l.who, where: l.where.label, title: l.title }].slice(-RULES_MAX);
        // The same press, kept as a lesson too (src/lessons.ts): the owner's own correction, which every next extraction reads.
        void d.lessons?.notMine({
          title: l.title, who: l.who, where: l.where.label, ...(l.where.channel ? { channel: l.where.channel } : {}), nudged: l.nudges > 0,
        }).catch((err: Error) => log.error(`a "Not mine" could not be kept as a lesson: ${err.message}`));
        d.control?.log("followup", t("logLearned", { title: l.title }));
        return t("pressedNotMine", { title: l.title });
      });
      const pressedOn = hit as Loop | null;
      // The quality card counts Done, a snooze and Not mine; gentle mode's Snooze question and Park are not one of those.
      const counted = button === "5" || button === "6" ? "2" : button === "1" || button === "2" || button === "3" ? button : null;
      if (pressedOn && counted) d.quality?.pressed(counted, { id: pressedOn.id, title: pressedOn.title });
      return said;
    } catch (err) {
      log.error(`a press could not be kept: ${(err as Error).message}`);
      return t("unread");
    }
  };

  /** The open loops, newest first; one whose time passed hours ago is no longer shown (it stays in the store until it expires). */
  const open = async (): Promise<Loop[]> => {
    const t = now();
    return loopsOf(await read()).filter((l) => !l.dueAt || l.dueAt > t - PAST_HIDE_MS);
  };

  const command: FollowupsDoor["command"] = async () => {
    const lg = lang();
    const t = T(lg);
    let list: Loop[];
    try {
      list = await open();
    } catch {
      /* the store did not answer: said as unread */
      return t("unread");
    }
    if (!list.length) return t("none");
    const lines = list.slice(0, 15).map((l) => t("line", { title: l.title, due: dueText(l, lg), source: sourceText(l.sources[0], lg) }));
    return t("list", { n: list.length, list: lines.join("\n") });
  };

  /** For the assistant's context: the open loops, one short line each (newest first), so it can answer "what am I forgetting". */
  const context: FollowupsDoor["context"] = async () => {
    const lg = lang();
    const t = T(lg);
    try {
      return (await open()).slice(0, 10).map((l) =>
        t("ctx", { title: l.title, due: dueText(l, lg), source: sourceText(l.sources[0], lg), checked: l.lastCheck ? t("ctxChecked", { checked: l.lastCheck }) : "" }));
    } catch {
      /* the store did not answer: Claude goes without the loops */
      return [];
    }
  };

  /**
   * The owner's own words in the chat ("done, I sent Ana the deck"): each set of words closes the one open loop whose title and person hold
   * them all, as the Done button would. Words that match none or several close nothing (the owner is told which, never a guess).
   */
  const closeByWords: Engine["closeByWords"] = async (words) => {
    const out: CloseOutcome = { closed: [], none: [], many: [] };
    const shown = new Set((await open()).map((l) => l.id));
    await mutate((s) => {
      for (const w of words) {
        const keys = keysOf(w);
        if (!keys.length) continue;
        const hits = s.loops.filter((l) => shown.has(l.id) && l.status !== "done" && l.status !== "dismissed" && names(keys, l));
        if (hits.length === 1) {
          const l = hits[0]!;
          out.closed.push({ id: l.id, title: l.title, status: l.status, nextCheckAt: l.nextCheckAt });
          Object.assign(l, { status: "done", closedAt: now(), nextCheckAt: 0 });
          shown.delete(l.id);
        } else if (!hits.length) out.none.push(w);
        else out.many.push({ words: w, titles: hits.slice(0, 5).map((l) => l.title) });
      }
      return null;
    });
    for (const c of out.closed) d.quality?.pressed("1", { id: c.id, title: c.title });
    return out;
  };

  /** Undo: each loop the chat closed is open again as it was, unless it was changed since (reopened, or closed another way). */
  const reopenClosed: Engine["reopenClosed"] = async (loops) => {
    const back: ClosedLoop[] = [];
    await mutate((s) => {
      for (const c of loops) {
        const l = s.loops.find((x) => x.id === c.id);
        if (!l || l.status !== "done") continue;
        // Kept as an open loop from now (the store keeps one 14 days from when it was made), as "reopen" and unpark do.
        Object.assign(l, { status: c.status, nextCheckAt: c.nextCheckAt, createdAt: Math.max(l.createdAt, now()) });
        delete l.closedAt;
        // One Pako had closed (the phone's Reopen): no longer "closed for you", and its check never closes it again.
        if (l.autoClosed) l.reopened = true;
        delete l.autoClosed;
        back.push(c);
      }
      return null;
    });
    return back;
  };

  const forDraft: Engine["forDraft"] = async (words) => {
    const list = (await open()).filter((l) => l.status === "open" || l.status === "snoozed");
    const keys = keysOf(words);
    if (!keys.length) {
      // The one reminded of last, the last day: what a DRAFT right after a reminder means.
      const recent = list.filter((l) => l.nudges > 0 && l.checkedAt && now() - l.checkedAt < 24 * 3600_000).sort((a, b) => b.checkedAt! - a.checkedAt!);
      if (recent[0]) return { loop: recent[0] };
      return list.length === 1 ? { loop: list[0]! } : list.length ? { many: list.slice(0, 5).map((l) => l.title) } : { none: true };
    }
    const hits = list.filter((l) => names(keys, l));
    return hits.length === 1 ? { loop: hits[0]! } : hits.length ? { many: hits.slice(0, 5).map((l) => l.title) } : { none: true };
  };

  const draftFacts: Engine["draftFacts"] = (l) => {
    const lg = lang();
    const t = T(lg);
    const s = l.sources[0];
    return [{
      label: sourceText(s, lg) || l.where.label,
      text: t("draftFact", {
        kind: t(`draft_${l.kind}`), title: l.title, who: l.who || "—", where: l.where.label, due: dueText(l, lg) || "—",
        detail: l.detail || "—", checked: l.lastCheck || "—",
      }),
      ...(s ? { at: s.at } : {}),
    }];
  };

  const calendarChanged: Engine["calendarChanged"] = async (changes) => {
    const t = T(lang());
    const hit = changes.filter((c) => c.kind !== "added");
    if (!hit.length) return 0;
    const said: string[] = [];
    const n = await mutate((s) => {
      let changed = 0;
      for (const c of hit) {
        for (const l of s.loops) {
          if (!dueAtMeeting(l, c)) continue;
          changed++;
          if (c.kind === "moved") {
            l.dueAt = c.start;
            if ("zoomMeeting" in l.check) l.check.zoomMeeting.around = c.start;
            else if ("calendarEvent" in l.check) l.check.calendarEvent.around = c.start;
            delete l.escalated;
            if ("none" in l.check) l.nextCheckAt = Math.max(now(), c.start - NONE_BEFORE_MS);
            else {
              // One a server can check: looked at again for the new time, never later than that (moved earlier, the old look came after it).
              const next = nextAfter(l, now());
              if (next && (!l.nextCheckAt || l.nextCheckAt > next)) l.nextCheckAt = next;
            }
            Object.assign(l, { lastCheck: t("calMovedCheck"), checkedAt: now() });
            said.push(t("logCalMoved", { title: l.title }));
          } else if (l.kind === "agreed_meeting") {
            // The meeting itself, called off: nothing is owed any more.
            // Closed by Pako: listed as closed for the owner, and "reopen" undoes it (a calendar can be wrong).
            Object.assign(l, {
              status: "done", closedAt: now(), nextCheckAt: 0, lastCheck: t("calCancelledCheck"), checkedAt: now(), autoClosed: { at: now(), why: t("whyCancelled") },
            });
            said.push(t("logCalCancelled", { title: l.title }));
          } else {
            // Something due at a meeting that is gone may still be owed: kept, and the reminder says why.
            Object.assign(l, { lastCheck: t("calGoneCheck"), checkedAt: now() });
          }
        }
      }
      return changed;
    });
    for (const x of said) d.control?.log("followup", x);
    return n;
  };

  /** Gentle mode's Snooze: when to bring it back. Null when it is gone or answered already. */
  const snoozeCard: Engine["snoozeCard"] = async (id) => {
    const l = (await read()).loops.find((x) => x.id === id);
    if (!l || (l.status !== "open" && l.status !== "snoozed")) return null;
    return {
      body: GT()("snoozeAsk", { title: l.title }),
      buttons: [{ id: `f5:${l.id}`, title: GT()("btnLaterToday") }, { id: `f6:${l.id}`, title: GT()("btnTomorrow") }],
    };
  };
  const parked: Engine["parked"] = async () =>
    (await read()).loops.filter((l) => l.status === "parked").sort((a, b) => (b.parkedAt ?? 0) - (a.parkedAt ?? 0));
  const parkedText: Engine["parkedText"] = async () => {
    let list: Loop[];
    try {
      list = await parked();
    } catch {
      /* the store did not answer: said as unread */
      return T(lang())("unread");
    }
    if (!list.length) return GT()("parkedNone");
    const lines = list.slice(0, 20).map((l) => GT()("parkedLine", { title: l.title, who: l.who ? GT()("parkedWho", { who: l.who }) : "" }));
    return GT()("parkedList", { n: list.length, list: lines.join("\n") });
  };
  /** Back on the open list, as it was before it was parked (no nudge at once: the brief and PENDING show it again). */
  const unpark: Engine["unpark"] = async (which) => {
    const out = await mutate((s) => {
      const all = s.loops.filter((l) => l.status === "parked");
      const hits = "id" in which ? all.filter((l) => l.id === which.id) : all.filter((l) => names(keysOf(which.words), l));
      if (hits.length !== 1) return { hits: hits.map((l) => l.title) };
      const l = hits[0]!;
      // Its time still ahead: looked at again before it, as when it was new (left at 0 it was never nudged again). And it is kept as an open
      // loop from now (the store keeps one 14 days from when it was made: one parked for weeks was dropped at the next change).
      const t = now();
      Object.assign(l, { status: "open", nextCheckAt: 0, createdAt: Math.max(l.createdAt, t) });
      // As a new one's first look is set (src/followups/matching.ts): two hours before its time when no server can see it, else nextAfter.
      if (l.dueAt && l.dueAt > t) l.nextCheckAt = "none" in l.check ? (l.dueAt - NONE_BEFORE_MS > t ? l.dueAt - NONE_BEFORE_MS : 0) : nextAfter(l, t);
      delete l.parkedAt;
      delete l.unanswered;
      delete l.folded;
      return { title: l.title };
    });
    if ("title" in out) return { ok: true, say: GT()("unparked", { title: out.title! }) };
    if (!out.hits.length) return { ok: false, say: GT()("unparkNone") };
    return { ok: false, say: GT()("unparkMany", { list: out.hits.slice(0, 5).map((x) => `“${x}”`).join(", ") }) };
  };
  /** The first tiny step written for a loop (src/gentle.ts), kept on it while it is open. */
  const setStep: Engine["setStep"] = (id, step) =>
    mutate((s) => {
      const l = s.loops.find((x) => x.id === id);
      if (!l || (l.status !== "open" && l.status !== "snoozed")) return false;
      l.step = step.slice(0, 160);
      return true;
    });

  /** The weekly reset's "let go" (src/gentle-reset.ts): a parked loop closed for good, like a dismissed one (no lesson: it was not "Not mine"). */
  const letGo: Engine["letGo"] = (id) =>
    mutate((s) => {
      const l = s.loops.find((x) => x.id === id);
      if (!l || l.status !== "parked") return false;
      Object.assign(l, { status: "dismissed", closedAt: now(), nextCheckAt: 0 });
      return true;
    });

  /** A check-in asked from a loop's nudge ("Check on me in 30 min"): the owner engaged, so gentle mode's unanswered count starts again. */
  const engaged: Engine["engaged"] = (id) =>
    mutate((s) => {
      const l = s.loops.find((x) => x.id === id);
      if (!l || (l.status !== "open" && l.status !== "snoozed")) return false;
      delete l.unanswered;
      delete l.folded;
      return true;
    });
  const expiredParked: Engine["expiredParked"] = async () => [...((await read()).expired ?? [])].reverse();

  /** What Pako closed on its own since a moment and is still closed, newest first: no close of Pako's is silent. */
  const closedForYou: Engine["closedForYou"] = async (since) =>
    (await read()).loops
      .filter((l) => l.status === "done" && l.autoClosed && l.autoClosed.at >= since)
      .sort((a, b) => b.autoClosed!.at - a.autoClosed!.at)
      .map((l) => ({ id: l.id, title: l.title, why: l.autoClosed!.why }));

  /** "reopen <words>": one loop Pako closed in the last week, open again and looked at again as a new one is. */
  const reopenByWords: Engine["reopenByWords"] = async (words) => {
    const t = now();
    const out = await mutate((s) => {
      const hits = s.loops.filter((l) => l.status === "done" && l.autoClosed && t - l.autoClosed.at < REOPEN_MS && names(keysOf(words), l));
      if (hits.length !== 1) return { hits: hits.map((l) => l.title) };
      const l = hits[0]!;
      Object.assign(l, { status: "open", nextCheckAt: 0, createdAt: Math.max(l.createdAt, t) });
      if (l.dueAt && l.dueAt > t) l.nextCheckAt = "none" in l.check ? (l.dueAt - NONE_BEFORE_MS > t ? l.dueAt - NONE_BEFORE_MS : 0) : nextAfter(l, t);
      l.lastCheck = `You reopened it: I had closed it because ${l.autoClosed!.why}.`;
      delete l.closedAt;
      delete l.autoClosed;
      l.reopened = true;
      return { title: l.title };
    });
    const say = T(lang());
    if ("title" in out) return { ok: true, say: say("reopened", { title: out.title! }) };
    if (!out.hits.length) return { ok: false, say: say("reopenNone") };
    return { ok: false, say: say("reopenMany", { list: out.hits.slice(0, 5).map((x) => `“${x}”`).join(", ") }) };
  };

  return {
    press, open, command, context, closeByWords, calendarChanged, reopenClosed, forDraft, draftFacts, snoozeCard, parked, parkedText, unpark, setStep, letGo,
    engaged, expiredParked, closedForYou, reopenByWords,
  };
}
