// Meeting prep by itself (src/meeting-prep.ts): about 40 minutes before a meeting with someone else on it, once, with what is open with those
// people and what Pako knows of them; never all-day, declined, alone or (a standup with nothing open) repeating; six a day at most.
import { readFileSync as readRepoFile } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BRIEF_V2_KEY, createBriefV2 } from "../src/brief-v2.ts";
import type { CalEvent } from "../src/calendar.ts";
import type { Loop } from "../src/followups.ts";
import type { Kv } from "../src/kv.ts";
import { createMeetingPrep, loadMeetingPrepConfig, type PrepFact } from "../src/meeting-prep.ts";
import type { Inbound } from "../src/whatsapp.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-11-16T09:00:00Z");
function memKv() {
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  return { kv, m };
}
const ev = (id: string, title: string, start: number, extra: Partial<CalEvent> = {}): CalEvent => ({
  id, title, start, end: start + 30 * MIN, allDay: false, calendar: "Work",
  attendees: [{ email: "me@acme.example" }, { email: "ana.ruiz@client.example", name: "Ana Ruiz" }], ...extra,
});
const loopWith = (who: string, title: string) => ({ id: "d000000001", kind: "owner_promise", title, detail: "", who, status: "open", sources: [] } as unknown as Loop);

function rig(events: CalEvent[], o: { loops?: Loop[] } = {}) {
  const clock = { now: T0 };
  const asked: { title: string; at: number; facts: PrepFact[] }[] = [];
  const prep = createMeetingPrep({
    kv: memKv().kv, now: () => clock.now, timeZone: "Europe/London", events: async () => events,
    loops: async () => o.loops ?? [], about: async (people) =>
      people.includes("Ana Ruiz <ana.ruiz@client.example>") ? [{ label: "Ana Ruiz", text: "Ana prefers numbers first" }] : [],
    self: () => ["ME@acme.example"], prep: async (x) => (asked.push(x), { status: "pending" }), clock: () => "09:40",
  });
  return { prep, asked, clock };
}

test("a meeting with Ana: its note is asked about 40 minutes before, once, with the meeting, what is open with her and what Pako knows", async () => {
  const r = rig([ev("m1", "Q4 review", T0 + 60 * MIN)], { loops: [loopWith("Ana", "Send Ana the Q4 deck"), loopWith("Omar", "Call Omar")] });
  assert.deepEqual(await r.prep.tick(), [], "an hour before: not yet");
  r.clock.now = T0 + 20 * MIN;
  assert.deepEqual(await r.prep.tick(), ["Q4 review"]);
  const f = r.asked[0]!.facts;
  assert.match(f[0]!.text, /^The meeting: Q4 review, at 09:40–09:40\. Who is invited: Ana Ruiz\./, "the owner's own address is not among the others, case aside");
  assert.deepEqual(f.slice(1).map((x) => x.text), ["Still open with Ana: Send Ana the Q4 deck", "Ana prefers numbers first"]);
  r.clock.now += 5 * MIN;
  assert.deepEqual(await r.prep.tick(), [], "once per meeting");
});

test("never: all day, declined, only the owner, too close to the start, or a standup with nothing open; six a day at most", async () => {
  const at = T0 + 35 * MIN;
  const r = rig([
    ev("a", "Holiday", at, { allDay: true }),
    ev("b", "Declined thing", at, { response: "declined" }),
    ev("c", "Focus time", at, { attendees: [{ email: "me@acme.example" }] }),
    ev("d", "Daily standup", at, { recurring: true }),
    ev("e", "Too late", T0 + 5 * MIN),
  ]);
  assert.deepEqual(await r.prep.tick(), []);
  const many = rig(Array.from({ length: 8 }, (_, i) => ev(`x${i}`, `Meeting ${i}`, at + i * MIN)));
  assert.equal((await many.prep.tick()).length, 6);
  const standup = rig([ev("s", "Daily standup", at, { recurring: true })], { loops: [loopWith("Ana Ruiz", "Answer Ana about the budget")] });
  assert.deepEqual(await standup.prep.tick(), ["Daily standup"], "a repeating meeting with something open gets one");
  assert.equal(loadMeetingPrepConfig({ MEETING_PREP: "off" }).on, false);
  assert.equal(loadMeetingPrepConfig({}).on, true);
});

test("brief: prepMeeting asks the prep run with the meeting's facts first, once per meeting", async () => {
  const store = memKv();
  const queued: Inbound[] = [];
  const v2 = createBriefV2({
    config: { waitMs: 15 * MIN }, kv: store.kv, timeZone: "Europe/London", now: () => T0, sources: {}, enqueue: async (m) => (queued.push(m), true),
    plain: async () => undefined, notify: async () => undefined,
  });
  const task = (await v2.prepMeeting({ title: "Q4 review", at: T0 + 40 * MIN, facts: [{ label: "Calendar · Q4 review", text: "The meeting: Q4 review" }] }))!;
  assert.equal(task.kind, "prep");
  assert.equal(queued[0]!.brief?.kind, "prep");
  assert.match(queued[0]!.brief!.text, /OWNER'S REQUEST: Prepare me for the meeting: 09:40 Q4 review/);
  assert.match(queued[0]!.brief!.text, /\nP1 · The meeting: Q4 review/);
  assert.equal((await v2.prepMeeting({ title: "Q4 review", at: T0 + 40 * MIN, facts: [{ label: "x", text: "y" }] }))!.id, task.id);
  assert.ok(store.m.get(BRIEF_V2_KEY));
});

test("the owner's own address written with capitals by the calendar (Outlook does) is still the owner: a meeting alone gets no note", async () => {
  const r = rig([ev("c", "Focus time", T0 + 35 * MIN, { attendees: [{ email: "Me@Acme.example", name: "Me" }] })]);
  assert.deepEqual(await r.prep.tick(), []);
  const f = rig([ev("d", "With Ana", T0 + 35 * MIN, { attendees: [{ email: "Me@ACME.example" }, { email: "ana.ruiz@client.example", name: "Ana Ruiz" }] })]);
  assert.deepEqual(await f.prep.tick(), ["With Ana"]);
  assert.match(f.asked[0]!.facts[0]!.text, /Who is invited: Ana Ruiz\./);
});


/** A file of the repository, as text. */
const repoText = (p: string): string => readRepoFile(new URL(`../${p}`, import.meta.url), "utf8");

// A meeting held twice in a day under one title (a 9:00 and a 16:00 "Sync") gets a prep for each: a prep is one event at one start.
test("meeting prep: the same title twice in a day is two meetings, each with its own prep; the same one asked twice is one", async () => {
  const { createBriefV2 } = await import("../src/brief-v2.ts");
  const T0 = Date.parse("2026-11-16T09:00:00Z");
  const m = new Map<string, string>();
  const queued: unknown[] = [];
  const v2 = createBriefV2({
    config: { waitMs: 15 * 60_000 }, kv: { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) }, timeZone: "Europe/London",
    now: () => T0, sources: {}, enqueue: async (x) => (queued.push(x), true), plain: async () => undefined, notify: async () => undefined,
  });
  const facts = [{ label: "Calendar · Sync", text: "The meeting: Sync" }];
  const morning = (await v2.prepMeeting({ event: "E1", title: "Sync", at: T0 + 40 * 60_000, facts }))!;
  const again = (await v2.prepMeeting({ event: "E1", title: "Sync", at: T0 + 40 * 60_000, facts }))!;
  assert.equal(again.id, morning.id, "the same meeting asked twice: one prep");
  const afternoon = (await v2.prepMeeting({ event: "E2", title: "Sync", at: T0 + 7 * 3600_000, facts }))!;
  assert.notEqual(afternoon.id, morning.id, "the afternoon's Sync is its own meeting");
  assert.equal(queued.length, 2);
  assert.match(repoText("src/meeting-prep.ts"), /d\.prep\(\{ event: e\.id, /);
});
