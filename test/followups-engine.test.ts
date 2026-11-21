// The engine's parts are wired by name in src/followups/engine.ts; what createFollowups hands the rest of Pako stays the same set of names.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFollowups } from "../src/followups.ts";

test("createFollowups gives the same names it always has, each a function (the rehearsal's two under rehearse)", () => {
  const engine = createFollowups({
    config: { delayMs: 60_000, maxPerDay: 6, batchMs: 60_000, quiet: { start: 23 * 60, end: 8 * 60 } },
    kv: null, timeZone: "Europe/London", now: () => Date.parse("2026-11-16T09:00:00Z"), enqueue: async () => true, card: async () => true, notify: async () => undefined,
  });
  assert.deepEqual(Object.keys(engine).sort(), [
    "answered", "calendarChanged", "chaseNow", "chasePressed", "chaseTick", "chaseUnsent", "chaseWritten", "closeByWords", "closedForYou", "command", "context",
    "describe", "doneFor", "draftFacts", "dropFromChat", "engaged",
    "expiredParked", "forDraft", "forRef", "fromChat", "fromMail", "ingest", "letGo", "moveDue", "observeMail", "observeSlack", "offer", "open", "parked",
    "parkedText", "press", "read", "rehearse", "reopen", "reopenByWords", "reopenClosed", "result", "setStep", "snoozeCard", "spentToday", "start",
    "tick", "unpark",
  ]);
  for (const [k, v] of Object.entries(engine)) if (k !== "rehearse") assert.equal(typeof v, "function", `${k} is a function`);
  assert.deepEqual(Object.keys(engine.rehearse).sort(), ["draft", "dryAnswer"]);
});
