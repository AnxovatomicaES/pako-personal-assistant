// The brief knows the day's people (audit §6): what Pako knows of those invited to today's meetings and of those the open follow-ups name
// comes as N facts; they add to a to-do or a meeting, and are never an item of their own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { gatherFacts, validateBrief } from "../src/brief-v2.ts";
import type { CalEvent } from "../src/calendar.ts";
import type { Loop } from "../src/followups.ts";

const T0 = Date.parse("2026-11-16T08:00:00Z");
const ev: CalEvent = {
  id: "e1", title: "Q4 review", start: T0 + 2 * 3600_000, end: T0 + 3 * 3600_000, allDay: false, calendar: "Work",
  attendees: [{ email: "ana@client.example", name: "Ana Ruiz" }, { email: "omar@client.example" }],
};
const loop = { id: "a000000001", kind: "owner_promise", title: "Send Ana the deck", detail: "", who: "Ana Ruiz", where: { type: "slack_dm", label: "Ana (DM)" }, whenSaid: T0 - 3600_000, check: { none: { reason: "email" } }, status: "open", nextCheckAt: 0, nudges: 0, createdAt: T0 - 3600_000, sources: [] } as unknown as Loop;

test("the people of today's meetings and of the follow-ups are looked up once each; what Pako knows comes as N facts", async () => {
  const asked: string[][] = [];
  const g = await gatherFacts({
    timeZone: "Europe/London", lang: "en", now: T0, events: async () => [ev], loops: async () => [loop],
    people: async (names) => (asked.push(names), [{ name: "Ana Ruiz", text: "last meeting: «Weekly sync», 9 Nov: they will send the numbers" }]),
  });
  assert.deepEqual(asked, [["Ana Ruiz <ana@client.example>", "omar@client.example", "Ana Ruiz"]], "attendees by name and address, then the follow-ups' people");
  const n = g.facts.filter((f) => f.kind === "person");
  assert.equal(n.length, 1);
  assert.equal(n[0]!.id, "N1");
  assert.equal(n[0]!.text, "what Pako knows of Ana Ruiz: last meeting: «Weekly sync», 9 Nov: they will send the numbers");
  const doc = validateBrief(JSON.stringify({
    opening: "A busy Monday.",
    todos: [
      { title: "Ana Ruiz: last time she promised the numbers", sources: ["N1"] },
      { title: "Send Ana Ruiz the deck before the review", context: "Last time Ana Ruiz said she would send the numbers.", sources: [g.facts.find((f) => f.kind === "loop")!.id, "N1"] },
    ],
  }), g, { now: T0, timeZone: "Europe/London", lang: "en", id: "x" })!;
  assert.deepEqual(doc.todos.map((t) => t.title), ["Send Ana Ruiz the deck before the review"], "an N fact alone is not a to-do; with the follow-up it adds context");
});

test("without people memory, or no one named, nothing is asked", async () => {
  let called = 0;
  await gatherFacts({ timeZone: "Europe/London", lang: "en", now: T0, events: async () => [{ ...ev, attendees: [] }], people: async () => (called++, []) });
  assert.equal(called, 0);
});
