// The brief's day as the owner lives it: all-day events and ones begun yesterday, a page left open on an older brief, a to-do unticked,
// RESUMEN asked late in the day (what is over is not listed as ahead), overlaps named, an owner outside Madrid, a restart while gathering,
// and the spring-forward day.
import assert from "node:assert/strict";
import { test } from "node:test";
import { briefMaterial, chatText, createBriefV2, gatherFacts, validateBrief } from "../src/brief-v2.ts";
import { createBrief } from "../src/brief.ts";
import type { CalEvent } from "../src/calendar.ts";
import type { Kv } from "../src/kv.ts";

const MADRID = "Europe/Madrid";
const T0 = Date.parse("2026-11-16T07:00:00Z"); // Mon 08:00 Madrid
function memKv() {
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  return { kv, m };
}

test("an all-day event of today is on the written brief's day, as all day", async () => {
  const ev: CalEvent = { id: "h1", title: "Vacaciones en Lisboa", start: Date.parse("2026-11-15T23:00:00Z"), end: Date.parse("2026-11-16T23:00:00Z"), allDay: true, calendar: "" };
  const g = await gatherFacts({ timeZone: MADRID, lang: "en", now: T0, events: async () => [ev] });
  const E = g.facts.find((f) => f.kind === "event")!;
  // the model does what the prompt asks: puts every E fact of today in "day"; an all-day one has no HH:MM
  const raw1 = JSON.stringify({ opening: "Día tranquilo.", day: [{ time: "", title: "Vacaciones en Lisboa", sources: [E.id] }] });
  const doc1 = validateBrief(raw1, g, { now: T0, timeZone: MADRID, lang: "en", id: "x" })!;
  const chat1 = chatText(doc1, { name: "", timeZone: MADRID, url: null });
  console.log(chat1);
  assert.ok(chat1.includes("• all day Vacaciones en Lisboa"), "the all-day event of today is on the day");
});

test("an all-day event the model gave a time is still all day and confirmed", async () => {
  const ev: CalEvent = { id: "h1", title: "Vacaciones en Lisboa", start: Date.parse("2026-11-15T23:00:00Z"), end: Date.parse("2026-11-16T23:00:00Z"), allDay: true, calendar: "" };
  const g = await gatherFacts({ timeZone: MADRID, lang: "en", now: T0, events: async () => [ev] });
  const E = g.facts.find((f) => f.kind === "event")!;
  const raw = JSON.stringify({ opening: "Día tranquilo.", day: [{ time: "00:00", title: "Vacaciones en Lisboa", sources: [E.id] }] });
  const doc = validateBrief(raw, g, { now: T0, timeZone: MADRID, lang: "en", id: "x" })!;
  const chat = chatText(doc, { name: "", timeZone: MADRID, url: null });
  console.log(chat);
  assert.ok(!chat.includes("unconfirmed"), "a calendar event is called unconfirmed");
  assert.ok(chat.includes("• all day Vacaciones en Lisboa"));
});

test("a timed event begun yesterday that runs into today is on the day, until its end", async () => {
  const ev: CalEvent = { id: "f1", title: "Vuelo nocturno a NY", start: Date.parse("2026-11-15T21:00:00Z"), end: Date.parse("2026-11-16T09:00:00Z"), allDay: false, calendar: "" };
  const g = await gatherFacts({ timeZone: MADRID, lang: "en", now: Date.parse("2026-11-16T06:00:00Z"), events: async () => [ev] });
  const E = g.facts.find((f) => f.kind === "event")!;
  const raw = JSON.stringify({ opening: "Hoy aterrizas.", day: [{ time: "22:00", end: "10:00", title: "Vuelo nocturno a NY", sources: [E.id] }] });
  const doc = validateBrief(raw, g, { now: Date.parse("2026-11-16T06:00:00Z"), timeZone: MADRID, lang: "en", id: "x" })!;
  console.log(doc.dayItems);
  assert.deepEqual(doc.dayItems.map((d) => [d.time, d.end, d.title, d.confirmed]), [["", "10:00", "Vuelo nocturno a NY", true]]);
  assert.match(chatText(doc, { name: "", timeZone: MADRID, url: null }), /• until 10:00 Vuelo nocturno a NY/);
});

test("two real events that start together are both on the day, whichever the run listed; a meeting that is a Zoom and a calendar event is one line", async () => {
  const at = (s: string): number => Date.parse(`${s}Z`);
  const ev = (id: string, title: string, start: string, end: string): CalEvent => ({ id, title, start: at(start), end: at(end), allDay: false, calendar: "" });
  const g = await gatherFacts({
    timeZone: MADRID, lang: "en", now: T0,
    events: async () => [ev("e1", "Board review", "2026-11-16T10:00", "2026-11-16T11:00"), ev("e2", "Dentist", "2026-11-16T10:00", "2026-11-16T10:45"), ev("e3", "Weekly sync", "2026-11-16T13:00", "2026-11-16T14:00")],
    zoom: async () => [{ topic: "Weekly sync", at: at("2026-11-16T13:00") }],
  });
  const E = (title: string) => g.facts.find((f) => f.kind === "event" && f.title === title)!.id;
  for (const [what, day] of [
    ["the run lists one of the two", [{ time: "10:00", title: "Board review", sources: [E("Board review")] }]],
    ["the run gives no day", []],
  ] as const) {
    const doc = validateBrief(JSON.stringify({ opening: "A full morning.", day }), g, { now: T0, timeZone: MADRID, lang: "en", id: "x" })!;
    assert.deepEqual(doc.dayItems.map((d) => `${d.time} ${d.title}`), ["11:00 Board review", "11:00 Dentist", "14:00 Weekly sync"], what);
  }
});

test("a page left open on an older brief cannot tick a to-do of the newer one: its index would name another follow-up", async () => {
  const { kv } = memKv();
  let t = Date.parse("2026-11-16T06:30:00Z");
  const enq: any[] = [];
  const closed: string[] = [];
  const loops = [
    { id: "aaaaaaaaa1", kind: "request_to_owner", title: "Reply to Rohan", who: "Rohan", detail: "", where: { type: "slack_dm", label: "Rohan" }, sources: [], status: "open" },
    { id: "aaaaaaaaa2", kind: "owner_promise", title: "Send contract to Ana", who: "Ana", detail: "", where: { type: "slack_dm", label: "Ana" }, sources: [], status: "open" },
  ] as any[];
  const b = createBriefV2({
    config: { waitMs: 15 * 60_000 }, kv, timeZone: MADRID, now: () => t,
    sources: { loops: async () => loops },
    enqueue: async (m) => (enq.push(m), true), plain: async () => {}, notify: async () => {},
    closeLoop: async (id) => void closed.push(id),
  });
  // 07:30: the owner presses "Prepararlo ahora" on the page (quiet)
  await b.make();
  const id1 = enq[0].id.slice(3);
  await b.result(id1, JSON.stringify({ opening: "a", todos: [{ title: "Reply to Rohan", sources: ["L1"], loopId: "L1" }, { title: "Send contract to Ana", sources: ["L2"], loopId: "L2" }] }));
  const pageView = await b.view(); // the page shows todo 0 = Reply to Rohan
  assert.equal(pageView.doc!.todos[0]!.title, "Reply to Rohan");
  // 08:00: the scheduled brief writes today's brief again; the model orders the to-dos differently
  t = Date.parse("2026-11-16T07:00:00Z");
  await b.begin(t);
  const id2 = enq[1].id.slice(3);
  await b.result(id2, JSON.stringify({ opening: "b", todos: [{ title: "Send contract to Ana", sources: ["L2"], loopId: "L2" }, { title: "Reply to Rohan", sources: ["L1"], loopId: "L1" }] }));
  // the owner, on the still-open page, ticks "Reply to Rohan" (index 0)
  assert.equal(await b.current(pageView.doc!.id), false, "the page is told to reload");
  assert.equal(await b.check(0, true, pageView.doc!.id), false);
  assert.equal(await b.ask("prep", 0, pageView.doc!.id), null);
  assert.deepEqual(closed, [], "nothing closed from the older page");
  const fresh = await b.view();
  assert.equal(await b.check(1, true, fresh.doc!.id), true);
  assert.deepEqual(closed, ["aaaaaaaaa1"], "the reloaded page ticks the follow-up it shows");
});

test("a to-do whose follow-up was closed from the page cannot be unticked: the page never shows it open while it is closed", async () => {
  const { kv } = memKv();
  const enq: any[] = [];
  const state = new Map<string, string>([["aaaaaaaaa1", "open"]]);
  const loops = [{ id: "aaaaaaaaa1", kind: "request_to_owner", title: "Reply to Rohan", who: "Rohan", detail: "", where: { type: "slack_dm", label: "Rohan" }, sources: [], status: "open" }] as any[];
  const b = createBriefV2({
    config: { waitMs: 15 * 60_000 }, kv, timeZone: MADRID, now: () => T0,
    sources: { loops: async () => loops },
    enqueue: async (m) => (enq.push(m), true), plain: async () => {}, notify: async () => {},
    closeLoop: async (id) => void state.set(id, "closed"),
  });
  await b.begin(T0);
  await b.result(enq[0].id.slice(3), JSON.stringify({ opening: "a", todos: [{ title: "Reply to Rohan", sources: ["L1"], loopId: "L1" }] }));
  await b.check(0, true);
  const ok = await b.check(0, false);
  const v = await b.view();
  assert.equal(ok, false);
  assert.equal(v.doc!.todos[0]!.done, true, "still ticked, as its follow-up is still closed");
  assert.equal(state.get("aaaaaaaaa1"), "closed");
});

test("RESUMEN asked in the evening greets for the evening, not with the brief's morning", async () => {
  const { kv } = memKv();
  let t = T0;
  const enq: any[] = [];
  const b = createBriefV2({
    config: { waitMs: 15 * 60_000 }, kv, timeZone: MADRID, now: () => t,
    sources: { tasks: async () => [{ id: "abcdefabcd", text: "Pagar IBI", at: T0 - 86400000 }] },
    enqueue: async (m) => (enq.push(m), true), plain: async () => {}, notify: async () => {},
  });
  await b.begin(T0);
  await b.result(enq[0].id.slice(3), JSON.stringify({ opening: "Día tranquilo.", todos: [{ title: "Pagar el IBI", sources: ["T1"] }] }));
  t = Date.parse("2026-11-16T20:30:00Z"); // 21:30 Madrid
  const s = await b.short();
  console.log(s);
  assert.ok(s!.startsWith("🌙 Good evening. Día tranquilo."), "at 21:30 the brief says Good morning");
});

test("an owner in New York: the material names their zone, not Madrid", async () => {
  const NY = "America/New_York";
  const g = await gatherFacts({ timeZone: NY, lang: "en", now: T0, events: async () => [{ id: "e", title: "Standup", start: Date.parse("2026-11-16T14:00:00Z"), end: Date.parse("2026-11-16T14:30:00Z"), allDay: false, calendar: "" }] });
  const text = briefMaterial(g, { now: T0, timeZone: NY, lang: "en", ownerLanguage: "en", name: "" });
  console.log(text.split("\n")[0]);
  assert.ok(!/Madrid/.test(text), "the NY owner's times are labelled Madrid time");
  assert.match(text, /^Now: .*\(ET time, America\/New_York\)\. Every time in the brief in ET time\./);
});

test("a restart while the written brief gathers: the old brief still goes that day", async () => {
  const { kv, m } = memKv();
  const t = T0;
  let release!: () => void;
  const hang = new Promise<void>((r) => (release = r));
  const sent: string[] = [];
  // old server: tick at 08:00, gathering hangs (slow Slack/Zoom), then the process is killed (we simply never resume it)
  const v2a = createBriefV2({ config: { waitMs: 15 * 60_000 }, kv, timeZone: MADRID, now: () => t,
    sources: { slack: async () => { await hang; return []; } }, enqueue: async () => true, plain: async () => void sent.push("plain"), notify: async (x) => void sent.push(String(x)) });
  const a = createBrief({ at: 8 * 60, kv, timeZone: MADRID, now: () => t, notify: async (x) => void sent.push(x), smart: { begin: (x) => v2a.begin(x), short: () => v2a.short() } });
  void a.tick();
  await new Promise((r) => setTimeout(r, 50));
  // new server (after the restart), with the same store
  let t2 = t + 60_000;
  const v2b = createBriefV2({ config: { waitMs: 15 * 60_000 }, kv, timeZone: MADRID, now: () => t2,
    sources: {}, enqueue: async () => true, plain: async () => void sent.push("plain"), notify: async (x) => void sent.push(String(x)) });
  const b = createBrief({ at: 8 * 60, kv, timeZone: MADRID, now: () => t2, notify: async (x) => void sent.push(x), smart: { begin: (x) => v2b.begin(x), short: () => v2b.short() } });
  for (let i = 0; i < 30; i++) { t2 += 60_000; await b.tick(); await v2b.tick(); }
  console.log("store:", [...m.entries()].map(([k, v]) => `${k}=${v.slice(0, 80)}`));
  assert.deepEqual(sent, ["plain"], "the old brief goes once");
  release();
});

test("on the spring-forward day an event running since yesterday is today's, not 'tomorrow'", async () => {
  const now = Date.parse("2027-03-28T06:00:00Z"); // 08:00 CEST, Sunday 28 March 2027 (clocks went forward at 02:00)
  const ev = { id: "v", title: "Congreso en Lisboa", start: Date.parse("2027-03-26T23:00:00Z"), end: Date.parse("2027-03-29T22:00:00Z"), allDay: true, calendar: "" };
  const g = await gatherFacts({ timeZone: "Europe/Madrid", lang: "en", now, events: async () => [ev] });
  console.log(g.facts[0]!.text);
  assert.match(g.facts[0]!.text, /^today /);
});
