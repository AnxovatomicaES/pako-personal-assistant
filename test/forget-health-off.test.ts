// FORGET MY HEALTH with PROACTIVE=off: the health facts and the health nudges' entries an earlier run kept are deleted all the same
// (src/proactive.ts forgetHealthStored); before, with no engine, it did nothing and the health data stayed on disk.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Kv } from "../src/kv.ts";
import { forgetHealthStored, HEALTH_KEY, LIFE_KEY } from "../src/proactive.ts";

test("forget health with the engine off: the health store emptied, the health nudges gone from the sent list, the rest kept", async () => {
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  m.set(HEALTH_KEY, JSON.stringify([{ text: "slept badly", at: 1 }]));
  const now = Date.now();
  m.set(LIFE_KEY, JSON.stringify({
    sent: [
      { id: "a1b2c3d4e5", at: now, topic: "bienestar", say: "A walk?", why: "health:sleep", status: "sent" },
      { id: "b1b2c3d4e5", at: now, topic: "comida", say: "Lunch?", why: "fact:likes", status: "sent" },
    ],
  }));
  await forgetHealthStored(kv);
  assert.equal(m.get(HEALTH_KEY), "[]");
  const life = JSON.parse(m.get(LIFE_KEY)!);
  assert.deepEqual(life.sent.map((x: { why: string }) => x.why), ["fact:likes"]);
  await forgetHealthStored(null);
});
