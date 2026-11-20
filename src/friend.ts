// The friend: the important dates of the people in the owner's life (src/people.ts) the day before, with an offer to draft a message, and a
// light weekly check-in only when the owner turns it on ("activa el check-in semanal" / "turn on the weekly check-in"). The warmth itself is
// the assistant's (assistant/prompt.ts SYSTEM_PROMPT): honest that it is an AI, never needy, never guilt-tripping, and it points to real
// people and rest. This file only decides when a date is worth a word, once.
//
// One key in the store ("friend"): whether the check-in is on, when it last went, and which birthdays were already offered this year.

import { texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import { today } from "./lists.ts";
import { isBirthdayToday, type Person } from "./people.ts";
import { readJsonRecord } from "./json-record.ts";

export const FRIEND_KEY = "friend";
const TTL_SECONDS = 400 * 24 * 3600;
const DAY_MS = 24 * 3600_000;
const OFFERED_MAX = 200;

export interface FriendState {
  checkin: boolean;
  lastCheckin?: number;
  /** "<person id>:<year>": a birthday already offered the day before. */
  offered: string[];
}

export function friendOf(raw: unknown): FriendState {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const offered = (Array.isArray(o.offered) ? o.offered : []).filter((x): x is string => typeof x === "string" && /^[0-9a-f]{1,32}:\d{4}$/.test(x));
  return {
    checkin: o.checkin === true,
    ...(typeof o.lastCheckin === "number" && Number.isFinite(o.lastCheckin) ? { lastCheckin: o.lastCheckin } : {}),
    offered: offered.slice(-OFFERED_MAX),
  };
}

/** The check-in turned on or off, in plain English words (on plainWords: "check-in" is "check in"). */
export function friendCommand(command: string): { op: "checkin"; on: boolean } | null {
  if (/^(?:turn on|start|enable) (?:the |a )?(?:weekly )?check ?ins?$/.test(command)) return { op: "checkin", on: true };
  if (/^(?:turn off|stop|disable) (?:the )?(?:weekly )?check ?ins?$/.test(command)) return { op: "checkin", on: false };
  return null;
}

export interface FriendStore {
  read(): Promise<FriendState>;
  setCheckin(on: boolean): Promise<void>;
  /** A birthday offered for this year, or the check-in sent: false when it already was (two ticks never both send it). */
  claimBirthday(personId: string, year: string): Promise<boolean>;
  claimCheckin(now: number): Promise<boolean>;
}

export function createFriend(kv: Kv | null): FriendStore {
  let local: FriendState = { checkin: false, offered: [] };
  const readStrict = async (): Promise<FriendState> => {
    if (!kv) return structuredClone(local);
    const raw = await readJsonRecord(kv, FRIEND_KEY);
    if (!raw) return { checkin: false, offered: [] };
    try {
      return friendOf(raw);
    } catch {
      /* not JSON: a fresh state */
      return { checkin: false, offered: [] };
    }
  };
  const write = async (s: FriendState): Promise<void> => {
    if (kv) await kv.set(FRIEND_KEY, JSON.stringify(s), TTL_SECONDS);
    local = structuredClone(s);
  };
  let chain: Promise<unknown> = Promise.resolve();
  const change = <T>(fn: (s: FriendState) => { out: T; changed: boolean }): Promise<T> => {
    const run = chain.then(async () => {
      const s = await readStrict();
      const { out, changed } = fn(s);
      if (changed) await write(s);
      return out;
    });
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
  return {
    read: () => change((s) => ({ out: s, changed: false })),
    setCheckin: (on) =>
      change((s) => {
        s.checkin = on;
        return { out: undefined, changed: true };
      }),
    claimBirthday: (id, year) =>
      change((s) => {
        const k = `${id}:${year}`;
        if (s.offered.includes(k)) return { out: false, changed: false };
        s.offered = [...s.offered, k].slice(-OFFERED_MAX);
        return { out: true, changed: true };
      }),
    claimCheckin: (now) =>
      change((s) => {
        if (!s.checkin || (s.lastCheckin && now - s.lastCheckin < 6.5 * DAY_MS)) return { out: false, changed: false };
        s.lastCheckin = now;
        return { out: true, changed: true };
      }),
  };
}

const T = texts(
  {
    eve: "🎂 Tomorrow is {name}'s birthday{relation}. Shall I draft a message for you to send?",
    checkin: "👋 How has your week been? If you feel like telling me something, I'm here; and if not, have a good weekend.",
    checkinOn: "👋 Done: once a week I'll ask how things are going, no pressure. TURN OFF THE CHECK-IN to stop it.",
    checkinOff: "Done, no weekly check-in.",
    soon: "{name}{relation}: birthday {when}",
    tomorrow: "tomorrow",
    today: "today",
    inDays: "in {n} days",
  },
);
export const friendTexts = T;

const relationOf = (p: Person): string => (p.relation ? ` (${p.relation})` : "");

/** People whose birthday is tomorrow in the owner's zone, each with the words of the offer. */
export function birthdayEves(people: Person[], now: number, tz: string, l: Lang): { person: Person; year: string; text: string }[] {
  const tomorrow = now + DAY_MS;
  const year = today(tomorrow, tz).slice(0, 4);
  return people
    .filter((p) => isBirthdayToday(p, tomorrow, tz))
    .map((p) => ({ person: p, year, text: T(l)("eve", { name: p.name, relation: relationOf(p) }) }));
}

/** For the assistant's context: the birthdays of the next 7 days, so it can bring them up at the right moment. */
export function datesContext(people: Person[], now: number, tz: string, l: Lang): string[] {
  const t = T(l);
  const out: string[] = [];
  for (let n = 0; n <= 7; n++) {
    for (const p of people.filter((x) => isBirthdayToday(x, now + n * DAY_MS, tz))) {
      out.push(t("soon", { name: p.name, relation: relationOf(p), when: n === 0 ? t("today") : n === 1 ? t("tomorrow") : t("inDays", { n }) }));
    }
  }
  return out.slice(0, 10);
}

/** The weekly check-in's words, when it is on, a week has passed and it is a calm hour (Friday to Sunday, 18:00 to 21:00); else null. */
export function checkinNudge(s: FriendState, now: number, tz: string, l: Lang): { key: string; text: string } | null {
  if (!s.checkin || (s.lastCheckin && now - s.lastCheckin < 6.5 * DAY_MS)) return null;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const day = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  if (!["Fri", "Sat", "Sun"].includes(day) || hour < 18 || hour >= 21) return null;
  return { key: `friend:checkin:${today(now, tz)}`, text: T(l)("checkin") };
}
