// The rehearsal counts a "Not mine" rule the way real processing applies it: after the person's name is turned into the contact's own name.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFollowups } from "../src/followups.ts";
import type { Kv } from "../src/kv.ts";

const T0 = Date.parse("2026-11-16T08:30:00Z");

test("a rule saved under the contact's full name counts in the rehearsal when the model wrote a short name", async () => {
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  const engine = createFollowups({
    config: { delayMs: 0, maxPerDay: 6, batchMs: 0, quiet: null },
    kv,
    timeZone: "Europe/London",
    now: () => T0,
    enqueue: async () => true,
    card: async () => true,
    notify: async () => undefined,
    zoom: async () => [],
    slackHistory: async () => [],
    // The contacts: "Vik" is Rohan Patel.
    who: (name: string) => (/^vik$/i.test(name.trim()) ? "Rohan Patel" : name),
  });
  const { job } = await engine.rehearse.draft({ source: "mail", ref: "msg-1", label: "Rohan Patel: budget", text: "can you send me the budget by Friday?" } as never);
  // The owner said "Not mine" to this exact thing from this person here, saved under the contact's full name.
  const state = await engine.read();
  state.rules.push({ at: T0 - 1000, who: "Rohan Patel", where: job.where.label, title: "Send Vik the budget" });
  m.set("followups", JSON.stringify(state));
  const answer = JSON.stringify({ loops: [{ kind: "request_to_owner", title: "Send Vik the budget", who: "Vik", due: "", check: "none", reason: "email" }] });
  const out = await engine.rehearse.dryAnswer(job, answer);
  assert.ok(out);
  assert.equal(out!.ruled, 1, "the rule applies to 'Vik' as it would in real processing");
  assert.deepEqual(out!.items, [], "and nothing would be added");
});
