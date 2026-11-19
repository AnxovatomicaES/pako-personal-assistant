// The follow-ups door the server hands out (src/followups/door-proxy.ts) carries every method FollowupsDoor declares: one left out is one the
// chat never reaches. Found the hard way: closing by words and chat promises worked against the engine and did nothing through the server.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createFollowups, followupsProxy, PROXIED } from "../src/followups.ts";

test("the proxy carries every method of FollowupsDoor, and each reaches the engine", async () => {
  const src = readFileSync(new URL("../src/followups/types.ts", import.meta.url), "utf8");
  const body = /export interface FollowupsDoor \{([\s\S]*?)\n\}/.exec(src)![1]!;
  const declared = [...body.matchAll(/^ {2}(\w+)\??\(/gm)].map((m) => m[1]!);
  assert.ok(declared.length >= 10, `the interface was read: ${declared.join(", ")}`);
  assert.deepEqual([...declared].sort(), [...PROXIED].sort(), "every declared method is proxied, and nothing else");
  const engine = createFollowups({
    config: { delayMs: 60_000, maxPerDay: 6, batchMs: 60_000, quiet: { start: 23 * 60, end: 8 * 60 } },
    kv: null, timeZone: "Europe/London", now: () => Date.parse("2026-11-16T09:00:00Z"), enqueue: async () => true, card: async () => true, notify: async () => undefined,
  });
  for (const k of PROXIED) assert.equal(typeof (engine as Record<string, unknown>)[k], "function", `the engine has ${k}`);
  const door = followupsProxy(() => engine);
  const kept = await door.fromChat({ title: "Send Ana the Q4 deck", who: "Ana" });
  assert.ok(kept, "a chat promise goes through");
  assert.deepEqual((await door.closeByWords(["deck"])).closed.map((c) => c.id), [kept.id], "closing by words goes through");
  const before = followupsProxy(() => null);
  assert.deepEqual(await before.closeByWords(["x"]), { closed: [], none: ["x"], many: [] }, "before the engine: nothing, said as not found");
});
