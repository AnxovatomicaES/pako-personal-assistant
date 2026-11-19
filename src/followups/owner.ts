// The owner's side: the nudge's buttons, PENDING, and the open loops in the assistant's context.

import type { Engine } from "./parts.ts";
import { NONE_BEFORE_MS, PAST_HIDE_MS, RULES_MAX, SNOOZE_MS } from "./limits.ts";
import { loopsOf } from "./record.ts";
import { T } from "./texts.ts";
import type { ClosedLoop, CloseOutcome, FollowupsDoor, Loop } from "./types.ts";
import { fold } from "../lists.ts";
import { createLog } from "../log.ts";

const log = createLog("followups");

/** The words the owner names a loop by: each one starts a word of its title or person ("deck" finds "decks"; "Ana" never finds "Mariana"). */
const keysOf = (words: string): string[] => fold(words).split(/[^\p{L}\p{N}]+/u).filter((k) => k.length >= 2);
const names = (keys: string[], l: Loop): boolean => {
  const words = fold(`${l.title} ${l.who}`).split(/[^\p{L}\p{N}]+/u);
  return keys.every((k) => words.some((w) => w.startsWith(k)));
};

export function mountOwner(fu: Engine): Pick<Engine, "press" | "open" | "command" | "context" | "closeByWords" | "calendarChanged" | "reopenClosed" | "forDraft" | "draftFacts"> {
  const { d, now, lang, mutate, read, dueText, sourceText } = fu;
  const press: FollowupsDoor["press"] = async (button, id) => {
    const t = T(lang());
    try {
      let hit: Loop | null = null;
      const said = await mutate((s) => {
        const l = s.loops.find((x) => x.id === id);
        if (!l) return t("pressedGone");
        if (l.status === "done" || l.status === "dismissed") return t("pressedAlready");
        hit = l;
        if (button === "1") {
          Object.assign(l, { status: "done", closedAt: now(), nextCheckAt: 0 });
          return t("pressedDone", { title: l.title });
        }
        if (button === "2") {
          Object.assign(l, { status: "snoozed", nextCheckAt: now() + SNOOZE_MS });
          return t("pressedSnooze");
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
      if (pressedOn) d.quality?.pressed(button, { id: pressedOn.id, title: pressedOn.title });
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
        Object.assign(l, { status: c.status, nextCheckAt: c.nextCheckAt });
        delete l.closedAt;
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
        const old = c.kind === "moved" ? (c.was ?? c.start) : c.start;
        const title = fold(c.title);
        const words = title.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4);
        for (const l of s.loops) {
          if ((l.status !== "open" && l.status !== "snoozed") || !l.dueAt || Math.abs(l.dueAt - old) > 5 * 60_000) continue;
          const hints = "zoomMeeting" in l.check ? l.check.zoomMeeting.attendeesHints : "calendarEvent" in l.check ? l.check.calendarEvent.hints : [];
          const mine = fold(`${l.title} ${l.detail} ${hints.join(" ")}`);
          const first = fold(l.who).split(" ")[0] ?? "";
          if (!words.some((w) => mine.includes(w)) && !(first.length >= 3 && title.includes(first))) continue;
          changed++;
          if (c.kind === "moved") {
            l.dueAt = c.start;
            if ("zoomMeeting" in l.check) l.check.zoomMeeting.around = c.start;
            else if ("calendarEvent" in l.check) l.check.calendarEvent.around = c.start;
            delete l.escalated;
            if ("none" in l.check) l.nextCheckAt = Math.max(now(), c.start - NONE_BEFORE_MS);
            Object.assign(l, { lastCheck: t("calMovedCheck"), checkedAt: now() });
            said.push(t("logCalMoved", { title: l.title }));
          } else if (l.kind === "agreed_meeting") {
            // The meeting itself, called off: nothing is owed any more.
            Object.assign(l, { status: "done", closedAt: now(), nextCheckAt: 0, lastCheck: t("calCancelledCheck"), checkedAt: now() });
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

  return { press, open, command, context, closeByWords, calendarChanged, reopenClosed, forDraft, draftFacts };
}
