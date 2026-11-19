// Labs (PAKO_LABS, src/companion.ts): off, the health diary, learning and the weekly check-in are not answered, kept or offered, and the
// assistant is told so; the emergency answer to a red flag stays on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompanion } from "../src/companion.ts";
import { plainWords } from "../src/intents.ts";
import type { Kv } from "../src/kv.ts";

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
