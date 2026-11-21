// The question after a meeting Pako could not hear (src/after-meeting.ts): asked once per meeting, 10 to 60 minutes after its end, in working
// hours, outside the quiet hours and the next meeting, two a day and within the shared cap; Nothing and Not for these; never after a focus
// block, a short or declined meeting, one with nobody else, or a Zoom call the Zoom review reads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AFTER_BUTTON, AFTER_MEETING_KEY, AFTER_WORDS, askable, createAfterMeeting, titleKey } from "../src/after-meeting.ts";
import type { CalEvent } from "../src/calendar.ts";
import { shameIn } from "../src/gentle.ts";
import type { Kv } from "../src/kv.ts";
import { SHUTDOWN_BUTTON } from "../src/shutdown.ts";
import { TIME_BUTTON, type WorkHours } from "../src/time-to-do.ts";

const MIN = 60_000;
const TZ = "Europe/London";
const at = (iso: string): number => Date.parse(iso);
const WORK: WorkHours = { start: 9 * 60, end: 18 * 60, days: [1, 2, 3, 4, 5] };
const people = [{ email: "me@acme.example" }, { email: "ana@client.example", name: "Ana" }];
let n = 0;
const ev = (title: string, start: string, end: string, o: Partial<CalEvent> = {}): CalEvent =>
  ({ id: `e${++n}`, title, start: at(start), end: at(end), allDay: false, calendar: "Work", attendees: people, ...o });

function memKv() {
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  return { kv, m };
}
function rig(events: CalEvent[], o: { others?: number; zoomReview?: boolean; on?: boolean } = {}) {
  const clock = { now: at("2026-11-25T11:10:00Z") };
  const cards: { body: string; buttons: { id: string; title: string }[] }[] = [];
  const store = memKv();
  const a = createAfterMeeting({
    kv: store.kv, timeZone: TZ, now: () => clock.now, on: o.on ?? true, hours: WORK, quiet: { start: 23 * 60, end: 8 * 60 },
    events: async () => events, zoomReview: o.zoomReview ?? false, cap: async () => 6, others: async () => o.others ?? 0,
    card: async (body, buttons) => (cards.push({ body, buttons }), true),
  });
  return { clock, cards, store, a };
}

test("asked once, ten minutes after the end, with Nothing and Not for these; Not for these mutes that title, numbers aside", async () => {
  const review = ev("Bluefin review", "2026-11-25T10:00:00Z", "2026-11-25T11:00:00Z");
  const r = rig([review]);
  r.clock.now = at("2026-11-25T11:05:00Z");
  assert.equal(await r.a.sweep(), false, "too soon");
  r.clock.now = at("2026-11-25T11:10:00Z");
  assert.equal(await r.a.sweep(), true);
  assert.match(r.cards[0]!.body, /^🤝 “Bluefin review” just ended\. Did you promise anything/);
  assert.deepEqual(r.cards[0]!.buttons.map((b) => b.title), ["Nothing", "Not for these"]);
  assert.equal(await r.a.sweep(), false, "once per meeting");
  assert.equal(await r.a.spentToday(), 1);
  const id = AFTER_BUTTON.exec(r.cards[0]!.buttons[1]!.id)![2]!;
  assert.match(await r.a.pressed("n", id), /nothing to keep/);
  assert.match(await r.a.pressed("m", id), /from now on I won't ask after “Bluefin review”/);
  assert.equal(titleKey("Weekly sync 12/3"), titleKey("weekly sync 19/3"));
  // Next week's Bluefin review: not asked.
  const again = rig([ev("Bluefin review", "2026-11-25T10:00:00Z", "2026-11-25T11:00:00Z")]);
  again.store.m.set(AFTER_MEETING_KEY, r.store.m.get(AFTER_MEETING_KEY)!);
  assert.equal(await again.a.sweep(), false);
  assert.match(await r.a.pressed("n", "0000000000"), /earlier meeting/);
});

test("which meetings: not a focus block, a short one, a declined one, an all-day one, one alone, or a Zoom call the review reads", () => {
  const ok = ev("Bluefin review", "2026-11-25T10:00:00Z", "2026-11-25T11:00:00Z");
  assert.equal(askable(ok, { zoomReview: false }), true);
  assert.equal(askable({ ...ok, title: "Focus: Send the deck" }, { zoomReview: false }), false);
  assert.equal(askable({ ...ok, end: ok.start + 10 * MIN }, { zoomReview: false }), false);
  assert.equal(askable({ ...ok, response: "declined" }, { zoomReview: false }), false);
  assert.equal(askable({ ...ok, allDay: true }, { zoomReview: false }), false);
  assert.equal(askable({ ...ok, attendees: [{ email: "me@acme.example" }] }, { zoomReview: false }), false);
  assert.equal(askable({ ...ok, attendees: undefined }, { zoomReview: false }), false);
  assert.equal(askable({ ...ok, join: "https://acme.zoom.us/j/123" }, { zoomReview: true }), false);
  assert.equal(askable({ ...ok, join: "https://acme.zoom.us/j/123" }, { zoomReview: false }), true);
  assert.equal(askable({ ...ok, join: "https://meet.google.com/abc" }, { zoomReview: true }), true);
});

test("never: during the next meeting, after an hour, out of working hours, over two a day or the shared cap, or AFTER_MEETING=off", async () => {
  const a1 = ev("Bluefin review", "2026-11-25T10:00:00Z", "2026-11-25T11:00:00Z");
  const busy = rig([a1, ev("Next call", "2026-11-25T11:05:00Z", "2026-11-25T11:30:00Z")]);
  assert.equal(await busy.a.sweep(), false, "in the next meeting");
  busy.clock.now = at("2026-11-25T11:31:00Z");
  assert.equal(await busy.a.sweep(), true, "after it, within the hour");
  const late = rig([a1]);
  late.clock.now = at("2026-11-25T12:01:00Z");
  assert.equal(await late.a.sweep(), false, "more than an hour after");
  const evening = rig([ev("Dinner with Ana", "2026-11-25T18:30:00Z", "2026-11-25T19:30:00Z")]);
  evening.clock.now = at("2026-11-25T19:40:00Z");
  assert.equal(await evening.a.sweep(), false, "out of working hours");
  const full = rig([a1], { others: 6 });
  assert.equal(await full.a.sweep(), false, "the shared cap");
  const off = rig([a1], { on: false });
  assert.equal(await off.a.sweep(), false);
  const three = rig([
    ev("One", "2026-11-25T09:00:00Z", "2026-11-25T09:30:00Z"), ev("Two", "2026-11-25T10:00:00Z", "2026-11-25T10:30:00Z"),
    ev("Three", "2026-11-25T11:00:00Z", "2026-11-25T11:30:00Z"),
  ]);
  for (const t of ["2026-11-25T09:45:00Z", "2026-11-25T10:45:00Z", "2026-11-25T11:45:00Z"]) {
    three.clock.now = at(t);
    await three.a.sweep();
  }
  assert.equal(three.cards.length, 2, "two a day");
});

test("words and buttons: no shame; its buttons are its own", () => {
  for (const w of Object.values(AFTER_WORDS)) assert.deepEqual(shameIn(w), [], w);
  for (const id of ["an:a1b2c3d4e5", "am:a1b2c3d4e5"]) {
    assert.equal(AFTER_BUTTON.test(id), true);
    for (const other of [TIME_BUTTON, SHUTDOWN_BUTTON]) assert.equal(other.test(id), false);
  }
});

test("review fixes: its own questions count in its cap check; Not for these mutes a long or escaped title", async () => {
  const meetings = [ev("One", "2026-11-25T09:00:00Z", "2026-11-25T09:30:00Z"), ev("Two", "2026-11-25T10:00:00Z", "2026-11-25T10:30:00Z")];
  const r = rig(meetings, { others: 4 });
  r.clock.now = at("2026-11-25T09:45:00Z");
  assert.equal(await r.a.sweep(), true, "4 + 0 of 6");
  r.clock.now = at("2026-11-25T10:45:00Z");
  assert.equal(await r.a.sweep(), true, "4 + 1 of 6");
  const full = rig(meetings, { others: 5 });
  full.clock.now = at("2026-11-25T09:45:00Z");
  assert.equal(await full.a.sweep(), true, "5 + 0 of 6");
  full.clock.now = at("2026-11-25T10:45:00Z");
  assert.equal(await full.a.sweep(), false, "5 + 1 of 6: the cap");
  for (const title of [`Quarterly planning ${"and review ".repeat(12)}with the whole team`, "Planning <Q4> review &amp; budget"]) {
    const m = rig([ev(title, "2026-11-25T10:00:00Z", "2026-11-25T11:00:00Z")]);
    assert.equal(await m.a.sweep(), true);
    const id = AFTER_BUTTON.exec(m.cards[0]!.buttons[1]!.id)![2]!;
    await m.a.pressed("m", id);
    const next = rig([ev(title, "2026-11-25T10:00:00Z", "2026-11-25T11:00:00Z")]);
    next.store.m.set(AFTER_MEETING_KEY, m.store.m.get(AFTER_MEETING_KEY)!);
    assert.equal(await next.a.sweep(), false, `muted: ${title.slice(0, 30)}`);
  }
});
