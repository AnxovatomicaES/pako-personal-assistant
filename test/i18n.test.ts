// Pako's own fixed texts, English only (src/i18n.ts), the person's choices in the panel (src/local.ts createSettings), and PAKO_LANGUAGE,
// which is accepted and ignored (src/app.ts).

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { languageIgnoredNote, STAND_IN_NAME } from "../src/app.ts";
import { english, fill, locale, texts } from "../src/i18n.ts";
import * as i18n from "../src/i18n.ts";
import { createSettings } from "../src/local.ts";

test("i18n: texts() holds one English table, fills placeholders and leaves a missing one visible", () => {
  const T = texts({ hi: "Hi, {name}.", n: "{n} notes" });
  assert.equal(T()("hi", { name: "Ana" }), "Hi, Ana.");
  assert.equal(T("en")("n", { n: 3 }), "3 notes", "a language may still be passed: it is English");
  assert.equal(T()("hi"), "Hi, {name}.");
  assert.equal(fill("{a}{b}", { a: 1 }), "1{b}");
  // A key named like an object's own property is not taken from the prototype.
  assert.equal(fill("{toString}", {}), "{toString}");
  assert.equal(english(), "en");
  assert.equal(locale(), "en-GB", "no country set: British English dates");
});

test("i18n: there is no language choice left to make", () => {
  for (const gone of ["asLang", "systemLang"]) assert.equal(gone in i18n, false, gone);
});

test("local settings: kept in config.json (mode 600), only the changed field written, PAKO_NAME wins; an old `lang` is left alone and never read", () => {
  const dir = mkdtempSync(join(tmpdir(), "pako-settings-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ name: "Ana", other: 1, lang: "es" }));
  const s = createSettings(dir, { LANG: "es_ES.UTF-8" }, true);
  assert.equal("lang" in s, false, "no language setting");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")), { name: "Ana", other: 1, lang: "es" }, "nothing written at start");
  assert.equal(s.name(), "Ana");
  assert.equal(s.welcomed(), false);
  s.setName("  Ana\u0000 María  ");
  s.setWelcomed();
  const saved = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(saved, { name: "Ana María", other: 1, lang: "es", welcomed: true });
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "config.json")).mode & 0o777, 0o600);
  const again = createSettings(dir, { PAKO_NAME: "Marta" });
  assert.equal(again.name(), "Marta", "PAKO_NAME wins");
  assert.equal(again.welcomed(), true);
});

test("local settings: a new home on a Spanish computer writes no language down", () => {
  const dir = mkdtempSync(join(tmpdir(), "pako-settings-"));
  createSettings(dir, { LANG: "es_ES.UTF-8", LC_ALL: "es_ES.UTF-8" }, true).setName("Ana");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")), { name: "Ana" });
});

test("PAKO_LANGUAGE: accepted and ignored, said once for the log; the stand-in name is English", () => {
  assert.equal(languageIgnoredNote({}), null);
  assert.equal(languageIgnoredNote({ PAKO_LANGUAGE: " " }), null);
  for (const v of ["es", "en", "fr"]) assert.match(languageIgnoredNote({ PAKO_LANGUAGE: v }) ?? "", /^PAKO_LANGUAGE is ignored/, v);
  assert.equal(STAND_IN_NAME, "friend");
});
