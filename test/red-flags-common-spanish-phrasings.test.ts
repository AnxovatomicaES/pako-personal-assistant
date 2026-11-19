// The server's red-flag answer (024 / 112) is the one that goes even when Pako is paused or the bridge is asleep,
// so the most common Spanish ways to say it must be caught, and the idioms must not be.
import { test } from "node:test";
import assert from "node:assert/strict";
import { redFlag } from "../src/health.ts";

for (const [text, want] of [
  ["me quiero matar", "suicide"],
  ["Me voy a matar", "suicide"],
  ["me quiero quitar la vida", "suicide"],
  ["me voy a quitar la vida", "suicide"],
  ["quiero matarme", "suicide"],
  ["mi madre no puede respirar", "emergency"],
  ["mi hijo apenas puede respirar", "emergency"],
  ["me voy a matar a estudiar este finde", null],
  ["mi abuelo tuvo un infarto hace años", null],
] as const) {
  test(`red flag for «${text}»: ${want ?? "none"}`, () => assert.equal(redFlag(text), want));
}
