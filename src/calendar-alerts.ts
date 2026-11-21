// A meeting that moved or was called off, when the owner owes something at it: told at once, not only in tomorrow's brief. Before this, the
// follow-ups followed the change in silence (src/followups/owner.ts calendarChanged). Now, for a change within the next three days that
// touches something the owner owes (a deck for the review, a reply due at the call):
//
//   moved earlier  "📅 “Bluefin review” moved earlier: Thu 15:00 → Thu 11:00. “Send Ana the deck” is now due then."  Plan · Done
//   moved later    "📅 “Bluefin review” moved to Fri 10:00 (was Thu 15:00). “Send Ana the deck” follows it: more time."
//   cancelled      "📅 “Bluefin review” (Thu 15:00) was cancelled. You still owe “Send Ana the deck”: keep it, or close it?"  Done · Park
//
// Plan is time-to-do's own card (its Block is the only write); Done and Park are the follow-ups' own. Never in the quiet hours (the brief says
// it then), at most three a day, to the owner only. The meeting's title is someone else's text: inline()d and quoted, never followed.

import type { Loop } from "./followups/types.ts";
import { dueAtMeeting, type MeetingChange } from "./followups/calendar-match.ts";
import { quietAt } from "./gentle.ts";
import { ownerClock, texts } from "./i18n.ts";
import { today } from "./lists.ts";
import { createLog } from "./log.ts";
import { inline } from "./quarantine.ts";
import { OWED_KINDS } from "./time-to-do.ts";

const log = createLog("calendar");

const HOUR = 3600_000;
/** Only a change this close (its new or old start) is told now; a later one is the brief's. */
export const ALERT_AHEAD_MS = 72 * HOUR;
export const ALERTS_PER_DAY = 3;

export const ALERT_WORDS = {
  earlier: "📅 “{event}” moved earlier: {was} → {now}. {list} now due then.",
  later: "📅 “{event}” moved to {now} (was {was}). {list} follows it: more time.",
  laterMany: "📅 “{event}” moved to {now} (was {was}). {list} follow it: more time.",
  cancelled: "📅 “{event}” ({was}) was cancelled. You still owe {list}: keep it, or close it?",
  earlierOne: "is",
  earlierMany: "are",
  btnPlan: "Plan it",
  btnDone: "Done",
  btnPark: "Park",
};
export const AT = texts(ALERT_WORDS);

export interface Alert {
  change: MeetingChange;
  loops: Loop[];
}

/** The changes worth telling now: moved or cancelled, within ALERT_AHEAD_MS, with open follow-ups the owner owes due at that meeting. */
export function changeAlerts(loops: readonly Loop[], changes: readonly MeetingChange[], now: number): Alert[] {
  const out: Alert[] = [];
  for (const c of changes) {
    if (c.kind === "added") continue;
    const soonest = Math.min(c.start, c.was ?? c.start);
    if (soonest <= now || soonest - now > ALERT_AHEAD_MS) continue;
    const mine = loops.filter((l) => OWED_KINDS.includes(l.kind) && dueAtMeeting(l, c));
    if (mine.length) out.push({ change: c, loops: mine });
  }
  return out;
}

/** "Thu 15:00", or "15:00" today. */
const when = (t: number, now: number, tz: string): string =>
  (today(t, tz) === today(now, tz) ? ownerClock(t, tz) : `${new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).format(t)} ${ownerClock(t, tz)}`);

/** The alert's words and buttons (the first follow-up's: Plan and Done for an earlier move, Done and Park for a cancellation, none later). */
export function alertCard(a: Alert, now: number, tz: string): { body: string; buttons: { id: string; title: string }[] } {
  const c = a.change;
  const shown = a.loops.slice(0, 3).map((l) => `“${inline(l.title, 100)}”`);
  const list = shown.join(", ") + (a.loops.length > 3 ? ` (+${a.loops.length - 3})` : "");
  const event = inline(c.title, 80);
  const first = a.loops[0]!;
  if (c.kind === "cancelled") {
    return {
      body: AT()("cancelled", { event, was: when(c.start, now, tz), list }),
      buttons: [{ id: `f1:${first.id}`, title: AT()("btnDone") }, { id: `f7:${first.id}`, title: AT()("btnPark") }],
    };
  }
  const was = c.was ?? c.start;
  if (c.start < was) {
    const verb = AT()(a.loops.length > 1 ? "earlierMany" : "earlierOne");
    return {
      body: AT()("earlier", { event, was: when(was, now, tz), now: when(c.start, now, tz), list: `${list} ${verb}` }),
      buttons: [{ id: `tf:${first.id}`, title: AT()("btnPlan") }, { id: `f1:${first.id}`, title: AT()("btnDone") }],
    };
  }
  return { body: AT()(a.loops.length > 1 ? "laterMany" : "later", { event, was: when(was, now, tz), now: when(c.start, now, tz), list }), buttons: [] };
}

export interface CalendarAlertsDeps {
  timeZone: string;
  now?: () => number;
  quiet: { start: number; end: number } | null;
  /** The open follow-ups, as they were before the change moved them. */
  loops: () => Promise<Loop[]>;
  card: (body: string, buttons: { id: string; title: string }[]) => Promise<boolean>;
  notify: (text: string) => Promise<unknown>;
  /** The panel's switch (src/day-helpers.ts), or CALENDAR_ALERTS: whether to tell at all. */
  enabled?: () => Promise<boolean>;
  /** The day's shared cap (gentle mode's when it is on) and what the other parts sent today (src/app/budget.ts): none once it is spent. */
  cap?: () => Promise<number>;
  others?: () => Promise<number>;
  log?: (text: string) => void;
}

/** Tells the owner of the changes in `changes` that touch what they owe; call it before the follow-ups follow the change. */
export function createCalendarAlerts(d: CalendarAlertsDeps) {
  const now = d.now ?? Date.now;
  let day = "";
  let sent = 0;
  const tell = async (changes: readonly MeetingChange[]): Promise<number> => {
    try {
      const t = now();
      if (d.enabled && !(await d.enabled().catch(() => true))) return 0;
      if (d.quiet && quietAt(d.quiet, t, d.timeZone)) return 0;
      const alerts = changeAlerts(await d.loops(), changes, t);
      let n = 0;
      for (const a of alerts) {
        if (today(t, d.timeZone) !== day) {
          day = today(t, d.timeZone);
          sent = 0;
        }
        if (sent >= ALERTS_PER_DAY) break;
        if (d.cap && d.others && sent + (await d.others().catch(() => 0)) >= (await d.cap().catch(() => 0))) break;
        const { body, buttons } = alertCard(a, t, d.timeZone);
        const ok = buttons.length ? await d.card(body, buttons).catch(() => false) : (await d.notify(body).then(() => true, () => false));
        if (!ok) continue;
        sent++;
        n++;
        d.log?.(`Calendar change told: ${inline(a.change.title, 80)} (${a.change.kind})`);
      }
      return n;
    } catch (err) {
      log.warn(`a calendar change could not be told: ${(err as Error).message}`);
      return 0;
    }
  };
  /** Alerts told today, for the shared cap (kept in memory: a restart forgets them, as it forgets nothing else that matters). */
  const spentToday = (): number => (day === today(now(), d.timeZone) ? sent : 0);
  return { tell, spentToday };
}
export type CalendarAlerts = ReturnType<typeof createCalendarAlerts>;
