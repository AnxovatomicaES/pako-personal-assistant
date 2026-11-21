// What the owner owes with no date and nothing a check can see (src/followups/aging.ts): a "Needs you" email's ask was never nudged and was
// let go silently after two weeks. Now it is said after two working days and after five, never on a weekend, in the quiet hours or over the
// day's budget, and never for what someone else owes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFollowups } from "../src/followups.ts";
import { agingAt, owedUndated } from "../src/followups/aging.ts";
import type { Kv } from "../src/kv.ts";
import { loopFromVerdict, readVerdict } from "../src/mail-categories.ts";

const T0 = Date.parse("2026-11-16T09:00:00Z"); // Mon 10:00 Madrid

function rig(maxPerDay = 6) {
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  const clock = { now: T0 };
  const cards: string[] = [];
  const engine = createFollowups({
    config: { delayMs: 10 * 60_000, maxPerDay, batchMs: 3 * 60_000, quiet: { start: 23 * 60, end: 8 * 60 } },
    kv, timeZone: "Europe/Madrid", now: () => clock.now, lang: () => "en",
    enqueue: async () => true, card: async (body) => (cards.push(body), true), notify: async () => undefined,
  });
  return { clock, cards, engine };
}
const need = (title: string) => loopFromVerdict(readVerdict(`NEEDS_YOU\nWHY: x\nASK: reply | Ana asks you\nLOOP: ${title} | Ana\ny`)!.verdict, "Ana")!;
const waiting = loopFromVerdict(readVerdict("WAITING\nWHY: x\nLOOP: Send the contract | Nadia\ny")!.verdict, "Nadia")!;

async function runTo(r: ReturnType<typeof rig>, t: number) {
  r.clock.now = t;
  await r.engine.tick();
}

test("aging: an owed reply with no date is nudged after two working days and after five, with how long it waited, then never again", async () => {
  const r = rig();
  assert.equal(await r.engine.fromMail({ ref: "m1", label: "email · Ana", at: T0, loops: [need("Reply about the budget")] }), 1);
  const l = (await r.engine.read()).loops[0]!;
  assert.equal(owedUndated(l), true);
  assert.equal(l.nextCheckAt, 0, "nothing a check can see: no check of its own");
  // Two working days (09:00-18:00) after Mon 10:00 Madrid: Wed 10:00. Nothing before it.
  await runTo(r, Date.parse("2026-11-18T08:30:00Z"));
  assert.equal(r.cards.length, 0, "not yet aged");
  await runTo(r, Date.parse("2026-11-18T09:15:00Z"));
  assert.equal(r.cards.length, 1);
  assert.match(r.cards[0]!, /Ana asked you to reply about the budget/);
  assert.match(r.cards[0]!, /Waiting on you for 2 days\. Already answered it\? Press Done\./);
  // Five working days: Mon 23 Nov 10:00 (the weekend is not working time).
  await runTo(r, Date.parse("2026-11-21T10:00:00Z"));
  await runTo(r, Date.parse("2026-11-23T08:30:00Z"));
  assert.equal(r.cards.length, 1, "not on the weekend, not before five working days");
  await runTo(r, Date.parse("2026-11-23T09:15:00Z"));
  assert.equal(r.cards.length, 2);
  assert.match(r.cards[1]!, /Waiting on you for 7 days/);
  // Both said: never again.
  await runTo(r, Date.parse("2026-11-26T12:00:00Z"));
  assert.equal(r.cards.length, 2);
});

test("aging: someone else's promise is never aged; Done before it ages ends it", async () => {
  const r = rig();
  await r.engine.fromMail({ ref: "m2", label: "email · Nadia", at: T0, loops: [waiting] });
  const theirs = (await r.engine.read()).loops[0]!;
  assert.equal(owedUndated(theirs), false);
  assert.equal(agingAt(theirs, "Europe/Madrid", null, undefined), 0);
  await r.engine.fromMail({ ref: "m3", label: "email · Ana", at: T0, loops: [need("Sign the NDA")] });
  const mine = (await r.engine.read()).loops.find((x) => x.title === "Sign the NDA")!;
  await r.engine.press("1", mine.id);
  await runTo(r, Date.parse("2026-11-18T09:15:00Z"));
  await runTo(r, Date.parse("2026-11-23T09:15:00Z"));
  assert.equal(r.cards.length, 0, "Done before it aged: nothing; their promise: nothing");
});

test("aging: within the day's budget, and outside the quiet hours", async () => {
  const r = rig(1);
  await r.engine.fromMail({ ref: "m4", label: "email · Ana", at: T0, loops: [need("Reply about the venue"), need("Reply about the menu")] });
  await runTo(r, Date.parse("2026-11-18T09:15:00Z"));
  assert.equal(r.cards.length, 1, "one a day at most");
  await runTo(r, Date.parse("2026-11-18T23:30:00Z"));
  assert.equal(r.cards.length, 1, "the quiet hours");
  await runTo(r, Date.parse("2026-11-19T08:30:00Z"));
  assert.equal(r.cards.length, 2, "the next day, the other one");
});

test("aging: a first nudge that came late (Pako off for days, or an old one at the upgrade) is not followed by the second at the next tick", async () => {
  const r = rig();
  await r.engine.fromMail({ ref: "m9", label: "email · Ana", at: T0, loops: [need("Reply about the offsite")] });
  // First look eight days later (Tue 24, 11:00 Madrid), already past both steps.
  await runTo(r, Date.parse("2026-11-24T10:00:00Z"));
  assert.equal(r.cards.length, 1);
  await runTo(r, Date.parse("2026-11-24T10:00:30Z"));
  await runTo(r, Date.parse("2026-11-26T10:00:00Z"));
  assert.equal(r.cards.length, 1, "not the second at once, nor two working days later");
  await runTo(r, Date.parse("2026-11-27T10:30:00Z"));
  assert.equal(r.cards.length, 2, "three working days after the first (Fri 11:00 Madrid), before the store lets it go");
});

test("aging: a day whose cap is spent does not push the second nudge back by three more working days", async () => {
  const r = rig(1);
  await r.engine.fromMail({ ref: "m10", label: "email · Ana", at: T0, loops: [need("Reply about the venue")] });
  await runTo(r, Date.parse("2026-11-18T09:15:00Z"));
  assert.equal(r.cards.length, 1, "first, Wed");
  // Mon 23: its second is due, but another card spends the day's only one first.
  await r.engine.fromMail({ ref: "m11", label: "email · Omar", at: Date.parse("2026-11-19T09:00:00Z"), loops: [need("Reply about the menu")] });
  await runTo(r, Date.parse("2026-11-23T09:15:00Z"));
  await runTo(r, Date.parse("2026-11-23T10:15:00Z"));
  await runTo(r, Date.parse("2026-11-23T14:15:00Z"));
  // Tue 24: the venue's second goes (not Thu or later).
  await runTo(r, Date.parse("2026-11-24T08:30:00Z"));
  await runTo(r, Date.parse("2026-11-24T09:00:00Z"));
  const venue = r.cards.filter((c) => /venue/.test(c));
  assert.equal(venue.length, 2, `the venue's second by Tue: ${r.cards.length} cards`);
});

test("aging: a first nudge sent by the ordinary path after a cap-full day still starts the second one's gap", async () => {
  const r = rig(1);
  await r.engine.fromMail({ ref: "m20", label: "email · Ana", at: T0, loops: [need("Reply about the venue"), need("Reply about the menu")] });
  // Tue 24 (both past both steps): one goes, the other waits for the cap; Wed 25 it goes by the ordinary path.
  for (const t of ["2026-11-24T10:00:00Z", "2026-11-24T10:31:00Z", "2026-11-24T11:02:00Z", "2026-11-25T09:00:00Z", "2026-11-25T09:00:30Z"]) {
    await runTo(r, Date.parse(t));
  }
  const count = (w: RegExp) => r.cards.filter((c) => w.test(c)).length;
  assert.equal(count(/venue/) + count(/menu/), 2, "one each, Tue and Wed");
  await runTo(r, Date.parse("2026-11-25T09:01:00Z"));
  await runTo(r, Date.parse("2026-11-26T09:00:00Z"));
  await runTo(r, Date.parse("2026-11-26T09:00:30Z"));
  await runTo(r, Date.parse("2026-11-26T09:01:00Z"));
  assert.equal(count(/venue/) + count(/menu/), 2, "Wednesday's second not at once, nor on Thursday");
  await runTo(r, Date.parse("2026-11-27T10:30:00Z"));
  assert.equal(count(/venue/) + count(/menu/), 3, "Fri: Tuesday's second, three working days later");
  assert.equal(Math.max(count(/venue/), count(/menu/)), 2);
});
