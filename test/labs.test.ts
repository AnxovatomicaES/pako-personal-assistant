// Labs (PAKO_LABS, src/companion.ts): off, the health diary, learning and the weekly check-in are not answered, kept or offered, and the
// assistant is told so; the emergency answer to a red flag stays on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompanion } from "../src/companion.ts";
import { HEALTH_KEY } from "../src/health.ts";
import { plainWords } from "../src/intents.ts";
import type { Kv } from "../src/kv.ts";
import { createProactive, HEALTH_KEY as LIFE_HEALTH_KEY, loadProactiveConfig } from "../src/proactive.ts";

function memKv(): Kv & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}
const at = Date.parse("2026-11-17T10:00:00Z");
const make = (labs: boolean, kv = memKv()) =>
  ({ kv, c: createCompanion({ kv, timeZone: "Europe/Madrid", country: "ES", lang: () => "en", people: async () => [], now: () => at, labs }) });

test("Labs off: the diary, learning and check-in words go on to the assistant, nothing is kept or offered", async () => {
  const { kv, c } = make(false);
  for (const w of ["log: slept 5 hours", "MY HEALTH", "QUIZ ME", "I want to learn Spanish", "CHECK-IN ON"]) {
    assert.equal(await c.command(w, plainWords(w)), null, w);
  }
  assert.equal(await c.keep({ health: [{ kind: "sleep", text: "5 h" }], goals: ["inglés"], cards: [] } as never), 0);
  assert.deepEqual(await c.offers(), []);
  assert.deepEqual(await c.context(), {});
  assert.equal([...kv.m.keys()].filter((k) => /health|learning|friend/.test(k)).length, 0, "nothing written");
  assert.equal(c.labs, false);
});

test("Labs off: a red flag in the owner's words, in English or in Spanish, still gets the emergency answer at once, in English", () => {
  const { c } = make(false);
  for (const words of ["my chest hurts a lot and I can't breathe", "me duele mucho el pecho y no puedo respirar"]) {
    const r = c.red(words);
    assert.ok(r, words);
    assert.match(r!.say, /112/, "the number of the owner's country (Spain here, from the per-country table)");
    assert.match(r!.say, /^🚨 If this is happening now, call/);
  }
  const nowhere = createCompanion({ kv: memKv(), timeZone: "Europe/Madrid", lang: () => "en", people: async () => [], now: () => at, labs: false });
  assert.match(nowhere.red("my chest hurts a lot and I can't breathe")!.say, /your local emergency number/, "no country known: no number guessed");
});

test("Labs on (the default when not said): the diary takes a note as before", async () => {
  const kv = memKv();
  const c = createCompanion({ kv, timeZone: "Europe/Madrid", country: "ES", lang: () => "en", people: async () => [], now: () => at });
  assert.equal(c.labs, true);
  const r = await c.command("log: slept 5 hours", plainWords("log: slept 5 hours"));
  assert.ok(r && /health diary/.test(r.say), JSON.stringify(r));
});

test("the health diary says once, with its first note, that it is a notebook and not a medical device (EU MDR intended purpose)", async () => {
  const kv = memKv();
  const c = createCompanion({ kv, timeZone: "Europe/Madrid", country: "ES", lang: () => "en", people: async () => [], now: () => at });
  const first = await c.command("log: slept 5 hours", plainWords("log: slept 5 hours"));
  assert.match(first!.say, /not a medical device/);
  assert.match(first!.say, /112/);
  const second = await c.command("log: drank 2 glasses of water", plainWords("log: drank 2 glasses of water"));
  assert.ok(second && !/medical device/.test(second.say), "said once only");
});

test("Labs off (the default install): FORGET MY HEALTH still asks, then forgets the diary of an earlier run and the mood and health facts", async () => {
  const kv = memKv();
  const life = createProactive({
    config: loadProactiveConfig({}).config!, kv, timeZone: "Europe/Madrid", local: true, now: () => at,
    enqueue: async () => true, card: async () => true, lastOwner: () => 0, bridgeAlive: () => true,
  });
  // The assistant's turns keep mood and health facts whatever Labs says; the diary is what an earlier run with the lab on left.
  assert.equal(await life.learn([{ kind: "mood", key: "today", text: "exhausted and anxious" }], { outside: false }), 1);
  kv.m.set(HEALTH_KEY, JSON.stringify({ entries: [{ at, kind: "sleep", text: "slept 4 hours" }], meds: [] }));
  assert.match(kv.m.get(LIFE_HEALTH_KEY) ?? "", /exhausted/);
  let also = 0;
  const c = createCompanion({
    kv, timeZone: "Europe/Madrid", country: "ES", lang: () => "en", people: async () => [], now: () => at, labs: false,
    alsoForget: async () => { also++; await life.forgetHealth(); },
  });
  const asked = await c.command("FORGET MY HEALTH", plainWords("FORGET MY HEALTH"));
  assert.match(asked?.say ?? "", /FORGET MY HEALTH CONFIRM/, "asked first, as with the lab on");
  assert.match(kv.m.get(LIFE_HEALTH_KEY) ?? "", /exhausted/, "nothing is deleted on the first ask");
  const done = await c.command("FORGET MY HEALTH CONFIRM", plainWords("FORGET MY HEALTH CONFIRM"));
  assert.match(done?.say ?? "", /I deleted your health diary/);
  assert.equal(also, 1);
  assert.doesNotMatch(kv.m.get(LIFE_HEALTH_KEY) ?? "", /exhausted/, "the mood and health facts are gone");
  assert.doesNotMatch(kv.m.get(HEALTH_KEY) ?? "", /slept 4 hours/, "the diary is gone");
  // Only the forgetting stays on: the rest of the diary's words still go to the assistant.
  assert.equal(await c.command("MY HEALTH", plainWords("MY HEALTH")), null);
  assert.equal(await c.command("log: slept 5 hours", plainWords("log: slept 5 hours")), null);
});
