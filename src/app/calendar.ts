// Wires the calendar's reader from its sources (Zoho, ICS links, this Mac, Google, the demo's), its changes every ten minutes, and the
// people graph fed from the mail and the calendar.

import { createCalendarChanges } from "../calendar-changes.ts";
import { calendarLog, createCalendarCore, createZohoSource } from "../calendar.ts";
import { createGoogleCalendarSource } from "../google-calendar.ts";
import { createIcsSource } from "../ics.ts";
import { createLog } from "../log.ts";
import { eventSightings, mailSightings, type Sighting } from "../people-graph.ts";
import type { AfterConnect } from "./context.ts";

const logCalendar = createLog("calendar");
const logPeopleGraph = createLog("people-graph");

export function wireCalendar(ctx: AfterConnect) {
  const { local, uiLang, dog, kv, control, timeZone, box, timing, cal, calOn, calLabel, calRef, calChangesRef, icsRef, myAddresses, followupsDoor, door } = ctx;
  const calTiming = cal.zoho ?? timing.timing;
  if (calOn && calTiming) {
    // A meeting about to start is urgent: it always reaches the phone.
    // Zoho and the ICS links are sources of one calendar: the same agenda, reminders and brief lines, whichever is connected.
    const log = calendarLog();
    const sources = [
      ...(cal.zoho ? [createZohoSource({ config: cal.zoho, kv, timeZone, lang: uiLang, log })] : []),
      ...(cal.ics ? [(icsRef.source = createIcsSource({ config: cal.ics, timeZone, lang: uiLang, control, log, me: myAddresses, ...(local?.icsNet ?? {}) }))] : []),
      ...(cal.mac ? [cal.mac.source] : []),
      ...(cal.google ? [createGoogleCalendarSource({ config: cal.google, timeZone, log })] : []),
      ...(cal.demo ? [cal.demo] : []),
    ];
    const notify = (text: string) => door.notifyOwner(text, { urgent: true });
    calRef.reader = createCalendarCore({ sources, timing: calTiming, kv, timeZone, control, lang: uiLang, log, notify, health: dog.reporter("calendar") });
    dog.watch("calendar");
    calRef.reader.start();
    // What changed on the calendar (src/calendar-changes.ts), every ten minutes: the follow-ups follow a meeting that moved or was called off,
    // and the brief says what changed since the last one.
    const reader = calRef.reader;
    calChangesRef.c = createCalendarChanges({ kv, read: () => reader.load(), onChange: (c) => followupsDoor.calendarChanged?.(c) ?? Promise.resolve(0) });
    const cc = calChangesRef.c;
    setTimeout(() => void cc.tick(), 60_000).unref?.();
    setInterval(() => void cc.tick(), 10 * 60_000).unref?.();
    logCalendar.info(`ON: ${calLabel}, reminders ${calTiming.remindMinutes || "off"} min before`);
  }
  // The people's identities (src/people-graph.ts): who wrote, who was invited, who spoke, from what Pako already reads (names and identities
  // only, never what anyone wrote). Slack and Zoom as they come; the mail and the calendar looked at every quarter of an hour.
  const feedPeople = (list: Sighting[]): void => {
    if (list.length) void door.peopleGraph.observe(list).catch((err: Error) => logPeopleGraph.error(`${err.message}`));
  };
  const harvestPeople = async (): Promise<void> => {
    const mails = box ? await box.items(60).catch(() => []) : [];
    const events = calRef.reader ? await calRef.reader.load().catch(() => []) : [];
    feedPeople([...mailSightings(mails), ...eventSightings(events)]);
  };
  setTimeout(() => void harvestPeople(), 60_000).unref?.();
  setInterval(() => void harvestPeople(), 15 * 60_000).unref?.();
  return { feedPeople };
}
