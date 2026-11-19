// A held message whose 10 s timer only fires after the computer wakes, hours later, is not sent late: the owner is told it is stale.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHeldQueue, type HeldAction } from "../src/autonomy.ts";
import type { Kv } from "../src/kv.ts";

function memKv(): Kv {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const held = (now: number) => ({
  id: "abcdef0123", type: "message" as const, label: "Ana", target: "34611222333", text: "Llego en 5 minutos", route: null, at: now, due: now + 10_000,
});

test("a held message whose timer fires hours after its time is told as stale, not sent", async () => {
  const clock = { now: Date.parse("2026-11-17T18:00:00Z") };
  const sent: HeldAction[] = [];
  const told: string[] = [];
  const q = createHeldQueue({ kv: memKv(), now: () => clock.now, delay: () => 30, run: async (a) => void sent.push(a), tell: async (_a, k) => void told.push(k) });
  await q.hold(held(clock.now));
  clock.now += 3 * 3600_000;
  await pause(120);
  q.stop();
  assert.deepEqual(sent, []);
  assert.deepEqual(told, ["stale"]);
  assert.equal((await q.list())[0]!.state, "stale");
});

test("a held message whose timer fires on time is still sent", async () => {
  const clock = { now: Date.parse("2026-11-17T18:00:00Z") };
  const sent: string[] = [];
  const q = createHeldQueue({ kv: memKv(), now: () => clock.now, delay: () => 30, run: async (a) => void sent.push(a.text), tell: async () => undefined });
  await q.hold(held(clock.now));
  clock.now += 10_500;
  await pause(120);
  q.stop();
  assert.deepEqual(sent, ["Llego en 5 minutos"]);
  assert.equal((await q.list())[0]!.state, "sent");
});
