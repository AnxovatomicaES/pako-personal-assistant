// The mail cards' times follow the owner's country like the rest of the panel (src/panel/i18n.js localeFor): 5:00 PM in the US, 17:00 elsewhere.
import { test } from "node:test";
import assert from "node:assert/strict";

const { dueWords } = (await import(new URL("../src/panel/mail.js", import.meta.url).href)) as {
  dueWords: (at: number, now?: number, locale?: string, gentle?: boolean) => string;
};

test("mail panel: a due time is written in the owner's locale, not always on a 24-hour clock", () => {
  const now = new Date(2026, 10, 18, 9, 0).getTime();
  const at = new Date(2026, 10, 18, 17, 0).getTime();
  assert.match(dueWords(at, now, "en-US"), /^today 0?5:00\s?PM$/i, "a US owner reads 5:00 PM, like the dashboard's times");
  assert.equal(dueWords(at, now, "en-GB"), "today 17:00");
  // No country known (the tests, a bare page): the panel's fallback, a 24-hour clock.
  assert.equal(dueWords(at, now), "today 17:00");
  assert.equal(dueWords(now - 1, now, "en-US"), "overdue");
});

test("mail panel, gentle mode: a time that passed is “time passed”, never “overdue” (no words of shame)", () => {
  const now = new Date(2026, 10, 18, 9, 0).getTime();
  assert.equal(dueWords(now - 1, now, "en-GB", true), "time passed");
  assert.equal(dueWords(now + 8 * 3600_000, now, "en-GB", true), "today 17:00");
});
