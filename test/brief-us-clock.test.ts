// The written brief in the chat for an owner whose country writes AM/PM (the US): its day reads "9:00 AM", as the rest of Pako and the
// plain brief write it, not "09:00". Its own file: the owner's region is set for the whole process (src/region.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { chatText, gatherFacts, validateBrief } from "../src/brief-v2.ts";
import type { CalEvent } from "../src/calendar.ts";
import { setOwnerRegion } from "../src/region.ts";

const NY = "America/New_York";
const T0 = Date.parse("2026-11-16T12:00:00Z"); // Mon 07:00 New York

test("a US owner's written brief gives the day's times on their clock: 9:00 AM–9:30 AM, 2:00 PM", async () => {
  setOwnerRegion("US");
  const events: CalEvent[] = [
    { id: "a", title: "Standup", start: Date.parse("2026-11-16T14:00:00Z"), end: Date.parse("2026-11-16T14:30:00Z"), allDay: false, calendar: "" },
    { id: "b", title: "Review", start: Date.parse("2026-11-16T19:00:00Z"), end: Date.parse("2026-11-16T20:00:00Z"), allDay: false, calendar: "" },
  ];
  const g = await gatherFacts({ timeZone: NY, lang: "en", now: T0, events: async () => events });
  const day = g.facts.filter((f) => f.kind === "event").map((f) => ({ title: f.title, sources: [f.id] }));
  const raw = JSON.stringify({ opening: "Two meetings today.", day });
  const doc = validateBrief(raw, g, { now: T0, timeZone: NY, lang: "en", id: "x" })!;
  const chat = chatText(doc, { name: "", timeZone: NY, url: null }).replace(/ /g, " ");
  assert.match(chat, /• 9:00 AM–9:30 AM Standup/);
  assert.match(chat, /• 2:00 PM–3:00 PM Review/);
  // A 24-hour country keeps 24 hours.
  setOwnerRegion("GB");
  assert.match(chatText(doc, { name: "", timeZone: NY, url: null }), /• 14:00–15:00 Review/);
});
