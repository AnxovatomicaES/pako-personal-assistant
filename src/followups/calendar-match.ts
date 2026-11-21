// Which open follow-up a calendar change is about: one due at that meeting (within five minutes of the start it had) whose words name it
// (the meeting's title words of four letters or more in the loop's title, detail or hints, or the person's first name in the meeting's title).
// Used by the follow-ups when a meeting moves or is called off (src/followups/owner.ts) and by the owner's alert (src/calendar-alerts.ts).

import { fold } from "../lists.ts";
import type { Loop } from "./types.ts";

export interface MeetingChange {
  kind: "added" | "moved" | "cancelled";
  title: string;
  start: number;
  was?: number;
}

/** This open loop is due at the meeting this change is about (its old start, for a move). */
export function dueAtMeeting(l: Loop, c: MeetingChange): boolean {
  if (c.kind === "added" || (l.status !== "open" && l.status !== "snoozed") || !l.dueAt) return false;
  const old = c.kind === "moved" ? (c.was ?? c.start) : c.start;
  if (Math.abs(l.dueAt - old) > 5 * 60_000) return false;
  const title = fold(c.title);
  const words = title.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4);
  const hints = "zoomMeeting" in l.check ? l.check.zoomMeeting.attendeesHints : "calendarEvent" in l.check ? l.check.calendarEvent.hints : [];
  const mine = fold(`${l.title} ${l.detail} ${hints.join(" ")}`);
  const first = fold(l.who).split(" ")[0] ?? "";
  return words.some((w) => mine.includes(w)) || (first.length >= 3 && title.includes(first));
}
