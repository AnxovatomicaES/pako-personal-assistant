// A calendar change the assistant proposed (propose_calendar_change), when this Mac's app can write the calendar (src/calendar-writes.ts):
// always a card first, saying exactly what changes and where the request came from (the owner's own words, or someone else's text: "from
// an email"). Yes queues the write under the card's id (its idempotency key); the Mac app makes it; the receipt says what changed, with Undo.

import { randomBytes } from "node:crypto";
import { pausedText } from "../control.ts";
import { texts } from "../i18n.ts";
import { whyText, type OutsideSource } from "../quarantine.ts";
import { whenText } from "../undo.ts";
import { PENDING_CALL_MS, cut } from "./shared.ts";
import { localToEpoch } from "./time.ts";
import type { Door } from "./door.ts";
import type { CalendarWrite } from "../calendar-writes.ts";
import { createLog } from "../log.ts";

const log = createLog("calendar");

export const CALENDAR_BUTTON = /^m([01]):([0-9a-f]{10})$/;

const K = texts({
  move: "📅 Move “{title}” from {from} to {to} on your Mac's calendar?",
  create: "📅 Add “{title}”, {from}–{end}{place}, to your Mac's calendar?",
  cancel: "📅 Delete “{title}” ({from}) from your Mac's calendar? The people invited are not told by Pako.",
  fromYou: "Asked: in your own words.",
  fromOutside: "Asked while I was reading {what}: check it is what you want.",
  yes: "Change it",
  queued: "OK: the Pako app on your Mac makes the change in a few seconds.",
  no: "OK, I won't change it.",
  gone: "That's no longer pending. If you want it, ask me again.",
  notFound: "I don't see “{title}” at {when} on your Mac's calendars, so I changed nothing.",
  badTime: "I couldn't read the time for “{title}”, so I changed nothing.",
  failed: "Your calendar was not changed: {why}.",
  paused: "{paused} Your calendar was not changed.",
});

export interface CalendarProposalIn {
  op: "create" | "move" | "cancel";
  title: string;
  start: string;
  end?: string;
  newStart?: string;
  place?: string;
}

export function mountCalendarCards(door: Door): Pick<Door, "proposeCalendar" | "pressedCalendar" | "calendarResult"> {
  // sendReceipt is mounted after this module: read from the door when used.
  const { d, now, lang, sendText, sendButtons } = door;
  // `stops`: the STOPs sent before the card was shown. A STOP ends every card waiting (src/door/stop-resume.ts): its yes changes nothing after.
  const cards = new Map<string, { at: number; stops: number; write: Omit<CalendarWrite, "id" | "status" | "queuedAt"> }>();
  const k = () => K(lang());
  const when = (t: number) => whenText(t, d.timeZone, lang());

  /** The card for one proposed change; nothing is queued before the owner's yes. */
  const proposeCalendar = async (p: CalendarProposalIn, why: OutsideSource[]): Promise<void> => {
    const cw = d.calendarWrites;
    if (!cw) return;
    const start = localToEpoch(p.start, d.timeZone);
    if (start === null) return void (await sendText(k()("badTime", { title: p.title })));
    let write: Omit<CalendarWrite, "id" | "status" | "queuedAt">;
    let body: string;
    if (p.op === "create") {
      const end = (p.end ? localToEpoch(p.end, d.timeZone) : null) ?? start + 60 * 60_000;
      write = { op: "create", start, end: Math.max(end, start + 15 * 60_000), title: cut(p.title, 200), ...(p.place ? { location: cut(p.place, 200) } : {}) };
      body = k()("create", { title: p.title, from: when(start), end: when(write.end!).slice(-5), place: p.place ? `, ${p.place}` : "" });
    } else {
      const e = await cw.find(p.title, start).catch(() => null);
      if (!e) return void (await sendText(k()("notFound", { title: p.title, when: when(start) })));
      if (p.op === "move") {
        const to = p.newStart ? localToEpoch(p.newStart, d.timeZone) : null;
        if (to === null) return void (await sendText(k()("badTime", { title: p.title })));
        write = { op: "move", eventId: e.eventId, at: e.at, start: to, end: to + (e.end - e.start), title: e.title, was: { start: e.start, end: e.end } };
        body = k()("move", { title: e.title, from: when(e.start), to: when(to) });
      } else {
        write = { op: "delete", eventId: e.eventId, at: e.at, title: e.title, was: { start: e.start, end: e.end, title: e.title, calendarId: e.calendarId } };
        body = k()("cancel", { title: e.title, from: when(e.start) });
      }
    }
    for (const [key, c] of cards) if (now() - c.at >= PENDING_CALL_MS) cards.delete(key);
    while (cards.size >= 10) cards.delete(cards.keys().next().value!);
    const id = randomBytes(5).toString("hex");
    cards.set(id, { at: now(), stops: door.stops, write });
    const from = why.length ? k()("fromOutside", { what: whyText(why, lang()) }) : k()("fromYou");
    await sendButtons(`${body}\n${from}`, `m1:${id}`, `m0:${id}`, k()("yes"));
  };

  /** The owner's press: yes queues the write under the card's id (pressed twice, still once), no forgets it. */
  const pressedCalendar = async (yes: boolean, id: string): Promise<void> => {
    const c = cards.get(id);
    cards.delete(id);
    if (!c || now() - c.at >= PENDING_CALL_MS || c.stops !== door.stops) return void (await sendText(k()("gone")));
    if (!yes) return void (await sendText(k()("no")));
    // Paused (STOP, the panel's switch, or Pako's own pause for its store): the Mac changes nothing, and the card is used up.
    const pause = d.control ? await d.control.state() : null;
    if (pause && pause.paused !== null) return void (await sendText(k()("paused", { paused: pausedText(pause.why, lang()) })));
    try {
      await d.calendarWrites!.enqueue({ ...c.write, id });
      await sendText(k()("queued"));
    } catch (err) {
      log.error(`a calendar write could not be queued: ${(err as Error).message}`);
      await sendText(k()("failed", { why: "Pako could not keep it" }));
    }
  };

  /** The Mac's answer: done, a receipt with Undo; failed, why. An undo's own result says only a failure (its Undo answer was given). */
  const calendarResult = async (w: CalendarWrite): Promise<void> => {
    if (w.status === "failed") return void (await sendText(k()("failed", { why: w.error ?? "?" })));
    if (w.status !== "done" || w.undoOf) return;
    const write = { id: w.id, op: w.op, title: w.title, ...(w.start ? { start: w.start } : {}), ...(w.result?.before ? { was: w.result.before.start } : {}) };
    await door.sendReceipt([{ kind: "calendar-written", write }]);
  };

  return { proposeCalendar, pressedCalendar, calendarResult };
}
