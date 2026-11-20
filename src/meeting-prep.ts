// Meeting prep before the meeting, by itself (one-job audit §4): about 40 minutes before a meeting with someone else on it, the brief's prep
// run (src/brief-v2.ts prepMeeting) writes the note from the meeting itself, who is coming, what is still open with those people (the follow-ups),
// and what the owner's memory says about them (src/person-context.ts, the same block the brief, the drafts and the extraction read). Told in
// the chat like a "Prepare me".
//
// Never for an all-day event, a declined one, or one with nobody but the owner; a repeating meeting (a standup) only when something is open
// with its people; once per meeting; six a day at most. MEETING_PREP=off turns it off.

import type { CalEvent } from "./calendar.ts";
import type { Loop } from "./followups.ts";
import type { Kv } from "./kv.ts";
import { fold } from "./lists.ts";
import { createLog } from "./log.ts";
import { readJsonRecord } from "./json-record.ts";

const log = createLog("prep");

export const MEETING_PREP_KEY = "meeting-prep";
/** How long before the meeting the note is asked for (it takes a minute or two to write). */
export const PREP_LEAD_MS = 40 * 60_000;
/** Too close to the start: not asked any more (it would come during the meeting). */
const LATEST_MS = 10 * 60_000;
const PER_DAY = 6;

export interface PrepFact {
  label: string;
  text: string;
  at?: number;
}

export interface MeetingPrepDeps {
  kv: Kv | null;
  now?: () => number;
  timeZone: string;
  events: () => Promise<CalEvent[]>;
  /** The open follow-ups. */
  loops?: () => Promise<Loop[]>;
  /**
   * What the owner's memory says about these people (src/person-context.ts: who they are, what was last agreed, dated facts), one fact each.
   * Given each attendee as "Name <address>", or the address alone.
   */
  about?: (people: string[]) => Promise<PrepFact[]>;
  /** The owner's own addresses: never counted as someone else on the meeting. */
  self?: () => string[];
  /** The prep run; null when it could not be asked. */
  prep: (o: { event?: string; title: string; at: number; facts: PrepFact[] }) => Promise<{ status: string } | null>;
  /** The time in the owner's zone, as the brief writes it ("09:30"). */
  clock: (t: number) => string;
}

interface State {
  /** Event keys (id and start) already looked at, with when, and whether a note was asked: one per meeting, even after a restart. */
  done: { key: string; at: number; asked?: boolean }[];
}

const keyOf = (e: CalEvent): string => `${e.id}@${e.start}`;
/** A person's name or address as words to find them by: "Ana Ruiz" -> ["ana", "ruiz"]; "ana.ruiz@x.com" -> ["ana", "ruiz"]. */
const wordsOf = (s: string): string[] => fold(s.split("@")[0]!).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);

export function createMeetingPrep(d: MeetingPrepDeps) {
  const now = d.now ?? Date.now;
  let memory: State = { done: [] };
  const load = async (): Promise<State> => {
    if (!d.kv) return structuredClone(memory);
    try {
      const v = ((await readJsonRecord(d.kv, MEETING_PREP_KEY)) ?? {}) as Partial<State>;
      return { done: Array.isArray(v.done) ? v.done.filter((x) => typeof x?.key === "string" && typeof x?.at === "number").slice(-200) : [] };
    } catch (err) {
      log.warn(`the prepared meetings could not be read, starting empty: ${err instanceof SyntaxError ? "not JSON" : (err as Error).message}`);
      return { done: [] };
    }
  };
  const save = async (s: State): Promise<void> => {
    memory = s;
    if (d.kv) await d.kv.set(MEETING_PREP_KEY, JSON.stringify(s), 8 * 24 * 3600);
  };

  /** The open follow-ups with any of these people (by name or address words), newest first. */
  const loopsWith = (loops: Loop[], people: { email: string; name?: string }[]): Loop[] => {
    const words = new Set(people.flatMap((p) => [...wordsOf(p.name ?? ""), ...wordsOf(p.email)]));
    return loops.filter((l) => {
      const who = wordsOf(l.who);
      return who.length > 0 && who.some((w) => words.has(w));
    });
  };

  /** The facts a meeting's note is written from: the meeting, then what is open with its people, then what Pako knows of them. */
  const factsFor = async (e: CalEvent, others: { email: string; name?: string }[]): Promise<{ facts: PrepFact[]; open: number }> => {
    const names = others.map((p) => p.name || p.email);
    const meeting: PrepFact = {
      label: `Calendar · ${e.title}`,
      text: `The meeting: ${e.title}, at ${d.clock(e.start)}–${d.clock(e.end)}${e.location ? ` (${e.location})` : ""}${e.recurring ? ", a repeating meeting" : ""}. `
        + `Who is invited: ${names.slice(0, 12).join(", ")}${names.length > 12 ? ` and ${names.length - 12} more` : ""}.`
        + (e.organizer ? ` Organized by ${e.organizer}.` : ""),
      at: e.start,
    };
    const open = d.loops ? loopsWith(await d.loops().catch(() => [] as Loop[]), others).slice(0, 8) : [];
    const loopFacts = open.map((l) => ({
      label: `Follow-up · ${l.who}`,
      text: `Still open with ${l.who}: ${l.title}${l.detail ? ` (${l.detail})` : ""}${l.lastCheck ? `. What Pako checked: ${l.lastCheck}` : ""}`,
      ...(l.sources[0] ? { at: l.sources[0].at } : {}),
    }));
    // By name and address ("Ana Ruiz <ana@x.com>"): the people graph knows them by either (src/person-context.ts).
    const words = others.map((p) => (p.name ? `${p.name} <${p.email}>` : p.email));
    const about = d.about ? await d.about(words).catch(() => [] as PrepFact[]) : [];
    return { facts: [meeting, ...loopFacts, ...about.slice(0, 10)], open: open.length };
  };

  /** Every few minutes: the meetings starting in about 40 minutes get their note asked for, once each. The titles asked. */
  const tick = async (): Promise<string[]> => {
    const t = now();
    let events: CalEvent[];
    try {
      events = await d.events();
    } catch (err) {
      log.error(`the calendar could not be read for meeting prep: ${(err as Error).message}`);
      return [];
    }
    const mine = new Set((d.self?.() ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean));
    const due = events.filter((e) => !e.allDay && !e.invited && e.response !== "declined" && e.start - PREP_LEAD_MS <= t && e.start - LATEST_MS > t);
    if (!due.length) return [];
    const s = await load();
    s.done = s.done.filter((x) => t - x.at < 7 * 24 * 3600_000);
    const today = s.done.filter((x) => x.asked && t - x.at < 24 * 3600_000).length;
    const asked: string[] = [];
    for (const e of due.sort((a, b) => a.start - b.start)) {
      if (s.done.some((x) => x.key === keyOf(e))) continue;
      if (today + asked.length >= PER_DAY) break;
      const others = (e.attendees ?? []).filter((a) => !mine.has(a.email.trim().toLowerCase()));
      if (!others.length) continue;
      const { facts, open } = await factsFor(e, others);
      // A repeating meeting (a standup) gets a note only when something is open with its people: otherwise it is the same every day.
      if (e.recurring && !open) {
        s.done.push({ key: keyOf(e), at: t });
        continue;
      }
      const r = await d.prep({ event: e.id, title: e.title, at: e.start, facts }).catch(() => null);
      if (!r || r.status === "failed") continue; // tried again at the next look, while it is still early enough
      s.done.push({ key: keyOf(e), at: t, asked: true });
      asked.push(e.title);
    }
    await save(s);
    return asked;
  };

  return { tick };
}

export function loadMeetingPrepConfig(env: Record<string, string | undefined>): { on: boolean } {
  return { on: (env.MEETING_PREP ?? "on").trim().toLowerCase() !== "off" };
}
