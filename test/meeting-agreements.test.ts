// What a meeting left with each person goes into Pako's dated memory of them (audit §6): one "last meeting" fact per person named in the
// review, never one for the owner; the next meeting with that person closes the one before, which stays as history.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFacts, currentAbout } from "../src/memory-facts.ts";
import { agreementFacts, type ReviewFound } from "../src/meeting-review.ts";

const T1 = Date.parse("2026-11-16T10:00:00Z");
const T2 = Date.parse("2026-11-23T10:00:00Z");
const found = (o: Partial<ReviewFound> = {}): ReviewFound => ({ summary: "", todos: [], promises: [], decisions: [], meetings: [], questions: [], ...o });

test("one fact per person named: what the owner agreed to do for them, what they will do, what was decided; none for the owner", () => {
  const facts = agreementFacts(found({
    todos: [
      { title: "Send Ana the Q4 deck", who: "Ana", evidence: "" },
      { title: "Book the venue", who: "Alex", evidence: "" },
      { title: "Write the summary", who: "", evidence: "" },
    ],
    promises: [{ title: "send the signed contract", who: "Omar", evidence: "" }, { title: "review the budget", who: "Ana", evidence: "" }],
    decisions: ["Launch moves to March", "Budget stays at 40k", "a third one"],
  }), { topic: "Q4 review", at: T1, owner: "Alex Moreno", timeZone: "Europe/London" });
  assert.deepEqual(facts.map((f) => f.subject), ["Ana", "Omar"], "the owner (by first name too) and nobody get nothing");
  assert.equal(facts[0]!.attribute, "last meeting");
  assert.equal(facts[0]!.value, "«Q4 review», 16 Nov: you agreed to Send Ana the Q4 deck. they will review the budget. decided: Launch moves to March; Budget stays at 40k");
  assert.deepEqual(facts[1]!.source, { who: "meeting", where: "Q4 review", at: T1 });
  assert.equal(facts[1]!.validFrom, T1);
  assert.deepEqual(agreementFacts(found({ decisions: ["x"] }), { topic: "t", at: T1, owner: "", timeZone: "UTC" }), [], "no one named: nothing kept");
});

test("in the store: the newest meeting with Ana is what holds now; the earlier one stays as history", async () => {
  const store = createFacts(null, { now: () => T2 });
  await store.add(agreementFacts(found({ todos: [{ title: "Send Ana the Q4 deck", who: "Ana", evidence: "" }] }), { topic: "Q4 review", at: T1, owner: "Alex", timeZone: "UTC" }), T1);
  await store.add(agreementFacts(found({ promises: [{ title: "send the numbers", who: "Ana", evidence: "" }] }), { topic: "Weekly sync", at: T2, owner: "Alex", timeZone: "UTC" }), T2);
  const all = await store.read();
  const now = currentAbout(all, ["Ana"]).filter((f) => f.attribute === "last meeting");
  assert.equal(now.length, 1);
  assert.match(now[0]!.value, /^«Weekly sync», 23 Nov: they will send the numbers$/);
  const past = all.filter((f) => f.subject === "Ana" && f.attribute === "last meeting" && f.closedAt);
  assert.equal(past.length, 1, "the earlier meeting is history, not lost");
  assert.match(past[0]!.value, /Q4 review/);
});
