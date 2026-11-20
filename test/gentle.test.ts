// Gentle mode (src/gentle.ts, src/gentle-dump.ts, src/door/dump.ts): the settings, the day's cap, the rotating words and their no-shame scan,
// Park, the time anchors across a clock change, learned durations, the first tiny step and its cache, and the brain dump with its one card,
// removing one and undoing all. Nothing here reaches the network.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { parseReply } from "../assistant/bridge.ts";
import { applyToolCalls, checkArgs } from "../assistant/tools.ts";
import { STEP_PROMPT, SYSTEM_PROMPT } from "../assistant/prompt.ts";
import type { CalEvent } from "../src/calendar.ts";
import { createControl } from "../src/control.ts";
import { createFollowups, FOLLOWUPS_KEY, followupsProxy, type Loop } from "../src/followups.ts";
import {
  anchorsDue, choicesOf, createFirstSteps, createGentleSettings, createTimeAnchors, GENTLE_DEFAULTS, GENTLE_DESCRIPTION, GENTLE_WORDS, gentleNudgeText, isOnline, kindKey,
  learnedMinutes, loadGentleConfig, mountGentlePanel, parseStep, pickVariant, SHAME_WORDS, shameIn, stepFacts, VARIANTS, type GentleConfig,
} from "../src/gentle.ts";
import { DUMP_WORDS, dumpCardText, dumpItemsOf, ownItems, removeAsk, sortDump } from "../src/gentle-dump.ts";
import { CHECKIN_WORDS } from "../src/gentle-checkins.ts";
import { RESET_WORDS } from "../src/gentle-reset.ts";
import type { Kv } from "../src/kv.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";
import { loadWhatsappConfig, mountWhatsapp, type Inbound } from "../src/whatsapp.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-11-16T09:00:00Z"); // Mon 09:00 London
type Body = Record<string, any>;

function memKv() {
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  return { kv, m };
}

const ON: GentleConfig = { ...GENTLE_DEFAULTS, on: true };

/** A follow-ups engine with gentle mode on (or off), its cards and buttons kept. */
function rig(o: { gentle?: GentleConfig | null; maxPerDay?: number } = {}) {
  const clock = { now: T0 };
  const store = memKv();
  const cards: { body: string; buttons: { id: string; title: string }[] }[] = [];
  const gentle = o.gentle === undefined ? ON : o.gentle;
  const engine = createFollowups({
    config: { delayMs: 10 * MIN, maxPerDay: o.maxPerDay ?? 6, batchMs: 3 * MIN, quiet: { start: 23 * 60, end: 8 * 60 } },
    kv: store.kv, timeZone: "Europe/London", now: () => clock.now, enqueue: async () => true,
    card: async (body, buttons) => (cards.push({ body, buttons }), true), notify: async () => undefined,
    gentle: async () => (gentle ? { maxPerDay: gentle.maxPerDay, usually: async () => null } : null),
  });
  return { clock, store, cards, engine };
}

/** Every gentle text: the variants of each kind, every fixed word, the brain dump's, the panel's description, and nudges built from them. */
function allGentleTexts(): string[] {
  const out: string[] = [
    ...Object.values(VARIANTS).flat(), ...Object.values(GENTLE_WORDS), ...Object.values(DUMP_WORDS), GENTLE_DESCRIPTION,
    // Batch B: the check-ins' and the weekly reset's words (src/gentle-checkins.ts, src/gentle-reset.ts).
    ...Object.values(CHECKIN_WORDS), ...Object.values(RESET_WORDS),
  ];
  for (const kind of Object.keys(VARIANTS) as Loop["kind"][]) {
    for (let v = 0; v < VARIANTS[kind].length; v++) {
      out.push(gentleNudgeText({ kind, title: "Send the deck", who: "" }, {
        variant: v, due: ", at 17:00", checked: "I don't see it in your calendar.", source: "Slack", step: "Open the deck", usually: 40,
      }));
    }
  }
  out.push(dumpCardText([{ kind: "reminder", text: "Call the dentist", when: "Thu 10:00" }, { kind: "note", text: "Wifi", when: "", removed: true }], { dropped: 1, failed: ["x"] }));
  return out;
}

// ---------- settings ----------

test("settings: off by default; PAKO_GENTLE=1 turns it on with a cap of 4 (below the standard 6); wrong values are said and their default used", () => {
  assert.deepEqual(loadGentleConfig({}).config, {
    on: false, maxPerDay: 4, leadOnlineMin: 10, leadPlaceMin: 25, stepsPerDay: 3, checkinMin: 30, checkinAgainMin: 15, resetDay: 1, resetAt: 570,
  });
  const on = loadGentleConfig({ PAKO_GENTLE: "1", GENTLE_MAX_PER_DAY: "3", GENTLE_LEAD_PLACE_MIN: "30" });
  assert.equal(on.config.on, true);
  assert.equal(on.config.maxPerDay, 3);
  assert.equal(on.config.leadPlaceMin, 30);
  const bad = loadGentleConfig({ PAKO_GENTLE: "maybe", GENTLE_MAX_PER_DAY: "99" });
  assert.equal(bad.config.on, false);
  assert.equal(bad.config.maxPerDay, 4);
  assert.equal(bad.problems.length, 2);
  assert.deepEqual(choicesOf({ on: true, maxPerDay: 0, leadOnlineMin: 15, extra: 1 }), { on: true, leadOnlineMin: 15 });
});

test("settings: stored like the others (one key); the panel's choices win over the environment's; view() is null while off", async () => {
  const { kv, m } = memKv();
  const s = createGentleSettings(kv, loadGentleConfig({ PAKO_GENTLE: "1" }).config);
  assert.equal((await s.view())?.maxPerDay, 4);
  await s.write({ maxPerDay: 2 });
  assert.deepEqual(JSON.parse(m.get("gentle-settings")!), { maxPerDay: 2 });
  assert.equal((await s.read()).maxPerDay, 2);
  await s.write({ on: false });
  assert.equal(await s.view(), null);
  assert.equal((await s.read()).maxPerDay, 2, "a field not given stays as it was");
});

test("settings: the panel's card reads and changes them (signed in, x-pako for a change), says the not-medical line, and lists Parked", async () => {
  const { kv } = memKv();
  const settings = createGentleSettings(kv, loadGentleConfig({}).config);
  const app = express();
  let unparked = "";
  mountGentlePanel(app, {
    signedIn: (req) => req.get("cookie") === "s=1", settings, standardMax: 6,
    parked: async () => [{ id: "a1b2c3d4e5", title: "Book the dentist", who: "", at: T0 }],
    unpark: async (id) => ((unparked = id), true),
  });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/panel/api/gentle`)).status, 401);
    const got = await (await fetch(`${base}/panel/api/gentle`, { headers: { cookie: "s=1" } })).json() as Body;
    assert.equal(got.settings.on, false);
    assert.match(got.description, /not a medical device and not a treatment/);
    assert.equal(got.parked[0].title, "Book the dentist");
    const post = (path: string, body: unknown, pako = true) => fetch(`${base}${path}`, {
      method: "POST", headers: { cookie: "s=1", "content-type": "application/json", ...(pako ? { "x-pako": "1" } : {}) }, body: JSON.stringify(body),
    });
    assert.equal((await post("/panel/api/gentle", { on: true }, false)).status, 401);
    const on = await (await post("/panel/api/gentle", { on: true, maxPerDay: 3 })).json() as Body;
    assert.deepEqual([on.settings.on, on.settings.maxPerDay], [true, 3]);
    assert.equal((await post("/panel/api/gentle/unpark", { id: "a1b2c3d4e5" })).status, 200);
    assert.equal(unparked, "a1b2c3d4e5");
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

/** A loop the owner promised in the chat (due Friday), looked at now: its next check set to this moment, with any field changed. */
async function dueNow(r: ReturnType<typeof rig>, title: string, o: Partial<Loop> = {}): Promise<Loop> {
  const l = (await r.engine.fromChat({ title, who: o.who ?? "Ana", due: "2026-11-20 17:00" }))!;
  const s = await r.engine.read();
  const x = s.loops.find((y) => y.id === l.id)!;
  Object.assign(x, { nextCheckAt: r.clock.now, ...o });
  await r.store.kv.set(FOLLOWUPS_KEY, JSON.stringify(s), 3600);
  return x;
}

// ---------- the nudges ----------

test("cap: in gentle mode the day's nudges stop at its cap (4), where standard mode goes to 6", async () => {
  for (const [gentle, want] of [[ON, 4], [null, 6]] as const) {
    const r = rig({ gentle });
    for (let i = 0; i < 8; i++) await dueNow(r, `Send report number ${i + 1} to the board`, { who: `Person${i}` });
    await r.engine.tick();
    assert.equal(r.cards.length, want, gentle ? "gentle" : "standard");
  }
});

test("nudge: gentle asks “did it happen?” with Done, Snooze and Park; standard keeps Done, In 1 h, Not mine", async () => {
  const g = rig();
  await dueNow(g, "Send Ana the Q4 deck");
  await g.engine.tick();
  assert.match(g.cards[0]!.body, /^🌱 .*\?/);
  assert.deepEqual(g.cards[0]!.buttons.map((b) => b.title), ["Done", "Snooze", "Park"]);
  assert.match(g.cards[0]!.buttons[1]!.id, /^f4:/);
  assert.match(g.cards[0]!.buttons[2]!.id, /^f7:/);
  const s = rig({ gentle: null });
  await dueNow(s, "Send Ana the Q4 deck");
  await s.engine.tick();
  assert.deepEqual(s.cards[0]!.buttons.map((b) => b.title), ["Done", "In 1 h", "Not mine"]);
  assert.doesNotMatch(s.cards[0]!.body, /^🌱/);
});

test("variants: six per kind; a loop is never asked the same way twice in a row, over many nudges", async () => {
  for (const list of Object.values(VARIANTS)) assert.ok(list.length >= 5);
  let last: number | undefined;
  for (let i = 0; i < 200; i++) {
    const v = pickVariant(6, last, "a1b2c3d4e5");
    assert.ok(v >= 0 && v < 6);
    assert.notEqual(v, last);
    last = v;
  }
  // Through the engine: snoozed and asked again, each time a different wording.
  const r = rig({ gentle: { ...ON, maxPerDay: 20 } });
  const l = await dueNow(r, "Book the venue", { who: "Omar" });
  const bodies: string[] = [];
  for (let i = 0; i < 5; i++) {
    await r.engine.tick();
    bodies.push(r.cards.at(-1)!.body.split("\n")[0]!);
    await r.engine.press("5", l.id);
    r.clock.now = (await r.engine.read()).loops[0]!.nextCheckAt + MIN;
  }
  assert.equal(r.cards.length, 5);
  for (let i = 1; i < bodies.length; i++) assert.notEqual(bodies[i], bodies[i - 1], `nudge ${i + 1} repeats the one before`);
});

test("no shame: no gentle text holds overdue, failed, missed, you forgot or again (nor late, behind or should have)", () => {
  for (const w of ["overdue", "failed", "missed", "you forgot", "again"]) assert.ok((SHAME_WORDS as readonly string[]).includes(w));
  const texts = allGentleTexts();
  assert.ok(texts.length > 80, `${texts.length} texts scanned`);
  for (const t of texts) assert.deepEqual(shameIn(t), [], t);
  assert.deepEqual(shameIn("You missed it AGAIN"), ["missed", "again"]);
  assert.deepEqual(shameIn("Later today works"), [], "later is not late");
});

test("spacing: two gentle nudges with no answer and the loop is not nudged again; it is folded into the brief", async () => {
  const r = rig();
  const l = await dueNow(r, "Send Ana the Q4 deck");
  await r.engine.tick();
  assert.equal(r.cards.length, 1);
  // The one near its time (an hour before), still unanswered: the second.
  r.clock.now = Date.parse("2026-11-20T16:01:00Z");
  await dueNow(r, "unused filler so the store is written", { who: "Nobody", status: "done" });
  let s = await r.engine.read();
  Object.assign(s.loops.find((y) => y.id === l.id)!, { nextCheckAt: r.clock.now });
  await r.store.kv.set(FOLLOWUPS_KEY, JSON.stringify(s), 3600);
  await r.engine.tick();
  assert.equal(r.cards.length, 2);
  assert.equal((await r.engine.read()).loops.find((y) => y.id === l.id)!.unanswered, 2);
  // Looked at again: folded, no third nudge.
  s = await r.engine.read();
  Object.assign(s.loops.find((y) => y.id === l.id)!, { nextCheckAt: r.clock.now, status: "snoozed" });
  await r.store.kv.set(FOLLOWUPS_KEY, JSON.stringify(s), 3600);
  await r.engine.tick();
  const x = (await r.engine.read()).loops.find((y) => y.id === l.id)!;
  assert.equal(x.folded, true);
  assert.equal(x.nextCheckAt, 0);
  assert.equal(r.cards.length, 2, "no third nudge");
  assert.ok((await r.engine.open()).some((y) => y.id === l.id), "still open, for the brief");
  // A press is an answer: the count starts again.
  await r.engine.press("6", l.id);
  const back = (await r.engine.read()).loops.find((y) => y.id === l.id)!;
  assert.equal(back.unanswered, undefined);
  assert.equal(back.folded, undefined);
});

test("gentle: a follow-up whose time passed is asked once, “did it happen?”, instead of going quiet; standard says nothing", async () => {
  for (const gentle of [ON, null]) {
    const r = rig({ gentle });
    const l = (await r.engine.fromChat({ title: "Send Ana the Q4 deck", who: "Ana", due: "2026-11-16 17:00" }))!;
    const s = await r.engine.read();
    s.loops[0]!.nextCheckAt = Date.parse("2026-11-16T18:00:00Z");
    s.loops[0]!.nudges = 1;
    s.loops[0]!.escalated = true;
    await r.store.kv.set(FOLLOWUPS_KEY, JSON.stringify(s), 3600);
    r.clock.now = Date.parse("2026-11-16T18:00:00Z");
    await r.engine.tick();
    if (gentle) {
      assert.equal(r.cards.length, 1);
      assert.match(r.cards[0]!.body, /\?/);
      const x = (await r.engine.read()).loops.find((y) => y.id === l.id)!;
      assert.equal(x.afterAsked, true);
      assert.equal(x.nextCheckAt, 0);
    } else assert.equal(r.cards.length, 0);
  }
});

test("snooze: Snooze asks when; Later today is three hours on, Tomorrow is 09:00 the next morning in the owner's zone", async () => {
  const r = rig();
  const l = (await r.engine.fromChat({ title: "Book the venue", who: "Omar" }))!;
  const ask = await r.engine.snoozeCard(l.id);
  assert.deepEqual(ask!.buttons.map((b) => [b.id.slice(0, 2), b.title]), [["f5", "Later today"], ["f6", "Tomorrow"]]);
  assert.match(await r.engine.press("5", l.id), /around 12:00/);
  let x = (await r.engine.read()).loops[0]!;
  assert.equal(x.status, "snoozed");
  assert.equal(x.nextCheckAt, T0 + 3 * HOUR);
  assert.equal(x.snoozes, 1);
  assert.match(await r.engine.press("6", l.id), /tomorrow around 09:00/);
  x = (await r.engine.read()).loops[0]!;
  assert.equal(x.nextCheckAt, Date.parse("2026-11-17T09:00:00Z"));
  assert.equal(x.snoozes, 2);
  // Late in the evening, "later today" would land in the quiet hours: it is the next morning instead.
  r.clock.now = Date.parse("2026-11-16T21:30:00Z");
  assert.match(await r.engine.press("5", l.id), /tomorrow around 09:00/);
});

test("park: Park sets it aside, out of nudges, OPEN and the assistant's context; it is in the Parked list and comes back by its words", async () => {
  const r = rig();
  const l = (await r.engine.fromChat({ title: "Renew the passport", who: "" }))!;
  await r.engine.fromChat({ title: "Send Ana the Q4 deck", who: "Ana" });
  assert.match(await r.engine.press("7", l.id), /Parked: “Renew the passport”/);
  const x = (await r.engine.read()).loops.find((y) => y.id === l.id)!;
  assert.equal(x.status, "parked");
  assert.equal(x.nextCheckAt, 0);
  assert.ok(!(await r.engine.open()).some((y) => y.id === l.id), "never shown as open or due");
  assert.doesNotMatch(await r.engine.command(), /passport/);
  assert.ok(!(await r.engine.context()).some((c) => /passport/.test(c)));
  r.clock.now += 11 * MIN;
  await r.engine.tick();
  assert.ok(!r.cards.some((c) => /passport/.test(c.body)), "no nudge for a parked item");
  assert.match(await r.engine.parkedText(), /Parked \(1\).*Renew the passport/s);
  assert.equal((await r.engine.unpark({ words: "deck" })).ok, false);
  const back = await r.engine.unpark({ words: "passport" });
  assert.equal(back.ok, true);
  assert.match(back.say, /Back on your open list/);
  assert.ok((await r.engine.open()).some((y) => y.id === l.id));
  assert.equal(await r.engine.parkedText(), "Nothing parked right now.");
});

test("park: kept a month in the store (findable), unlike a closed loop's week", async () => {
  const r = rig();
  const a = (await r.engine.fromChat({ title: "Renew the passport" }))!;
  const b = (await r.engine.fromChat({ title: "Call the plumber about the leak" }))!;
  await r.engine.press("7", a.id);
  await r.engine.press("1", b.id);
  r.clock.now += 10 * DAY;
  await r.engine.fromChat({ title: "Something new to keep" });
  const ids = (await r.engine.read()).loops.map((l) => l.id);
  assert.ok(ids.includes(a.id));
  assert.ok(!ids.includes(b.id));
});

// ---------- time anchors ----------

const ev = (o: Partial<CalEvent> & { start: number }): CalEvent =>
  ({ id: "e1", title: "Board review", end: o.start + HOUR, allDay: false, calendar: "Work", ...o });

test("anchors: online is wrap-up 10 min before, a place is leave-now 25 min before; nothing in the quiet hours, all-day or declined", () => {
  const start = Date.parse("2026-11-18T15:00:00Z");
  const base = { timeZone: "Europe/London", leadOnlineMin: 10, leadPlaceMin: 25, quiet: { start: 23 * 60, end: 8 * 60 }, lastOwner: 0, sent: [], seen: [] };
  assert.equal(isOnline({ join: "https://zoom.us/j/1" }), true);
  assert.equal(isOnline({ location: "Microsoft Teams Meeting" }), true);
  assert.equal(isOnline({ location: "Café Central, 12 High St" }), false);
  const online = ev({ start, join: "https://meet.google.com/x" });
  assert.equal(anchorsDue([online], start - 11 * MIN, base).length, 0);
  const w = anchorsDue([online], start - 10 * MIN, base);
  assert.equal(w.length, 1);
  assert.match(w[0]!.text, /^⏳ .*15:00/);
  const place = ev({ id: "e2", start, location: "Café Central" });
  assert.equal(anchorsDue([place], start - 26 * MIN, base).length, 0);
  const p = anchorsDue([place], start - 25 * MIN, base);
  assert.match(p[0]!.text, /^🚶 .*Café Central/);
  assert.equal(anchorsDue([ev({ start, allDay: true }), ev({ id: "e3", start, response: "declined" })], start - 10 * MIN, base).length, 0);
  const night = Date.parse("2026-11-18T23:30:00Z");
  assert.equal(anchorsDue([ev({ start: night + 10 * MIN })], night, base).length, 0, "quiet hours");
});

test("anchors: across the spring clock change the lead is 10 real minutes and the time is said in the owner's new local time", () => {
  // London springs forward at 01:00 UTC on 29 March 2026: a 09:00 meeting that day is 08:00 UTC.
  const start = Date.parse("2026-03-29T08:00:00Z");
  const base = { timeZone: "Europe/London", leadOnlineMin: 10, leadPlaceMin: 25, quiet: { start: 23 * 60, end: 8 * 60 }, lastOwner: 0, sent: [], seen: [] };
  const a = anchorsDue([ev({ start })], start - 10 * MIN, base);
  assert.equal(a.length, 1);
  assert.match(a[0]!.text, /09:00/);
  assert.doesNotMatch(a[0]!.text, /08:00/);
  // New York's own change (8 March 2026): the owner's zone decides, not the server's.
  const ny = Date.parse("2026-03-08T13:30:00Z"); // 09:30 EDT
  const b = anchorsDue([ev({ start: ny })], ny - 10 * MIN, { ...base, timeZone: "America/New_York" });
  assert.match(b[0]!.text, /9:30|09:30/);
  // Autumn: London falls back on 25 October 2026; a 08:30 meeting after it is 08:30 UTC, and 08:20 is outside the 23:00-08:00 quiet hours.
  const fall = Date.parse("2026-10-25T08:30:00Z");
  assert.match(anchorsDue([ev({ start: fall })], fall - 10 * MIN, base)[0]!.text, /08:30/);
});

test("anchors: “your call starts in 5” only when nothing shows the owner saw it; once per meeting", () => {
  const start = Date.parse("2026-11-18T15:00:00Z");
  const base = { timeZone: "Europe/London", leadOnlineMin: 10, leadPlaceMin: 25, quiet: null, seen: [] as string[] };
  const e = ev({ start, join: "https://zoom.us/j/1" });
  const sent = [{ key: `e1@${start}`, kind: "lead" as const, at: start - 10 * MIN }];
  const quiet = anchorsDue([e], start - 5 * MIN, { ...base, lastOwner: start - 30 * MIN, sent });
  assert.equal(quiet.length, 1);
  assert.match(quiet[0]!.text, /^⏰ Your call starts in 5/);
  assert.equal(anchorsDue([e], start - 5 * MIN, { ...base, lastOwner: start - 7 * MIN, sent }).length, 0, "the owner wrote since: they saw it");
  assert.equal(anchorsDue([e], start - 5 * MIN, { ...base, lastOwner: 0, sent, seen: [`e1@${start}`] }).length, 0, "On it pressed");
  assert.equal(anchorsDue([e], start - 5 * MIN, { ...base, lastOwner: 0, sent: [...sent, { key: `e1@${start}`, kind: "five", at: start - 6 * MIN }] }).length, 0);
});

test("anchors' clock: off sends nothing; on, one card per anchor with On it; pressing it stops the “in 5”; past meetings' lengths are learnt", async () => {
  const { kv } = memKv();
  const clock = { now: Date.parse("2026-11-18T14:50:00Z") };
  const start = Date.parse("2026-11-18T15:00:00Z");
  let on: GentleConfig | null = null;
  const cards: { body: string; buttons: { id: string }[] }[] = [];
  const past = [0, 1, 2].map((i) => ev({ id: `p${i}`, title: "Weekly sync", start: start - (i + 1) * DAY, end: start - (i + 1) * DAY + (40 + i * 5) * MIN }));
  const a = createTimeAnchors({
    kv, timeZone: "Europe/London", now: () => clock.now, settings: async () => on,
    events: async () => [...past, ev({ title: "Weekly sync", start, join: "https://zoom.us/j/9" })], quiet: null, lastOwner: () => 0,
    card: async (body, buttons) => (cards.push({ body, buttons }), true),
  });
  assert.deepEqual(await a.tick(), []);
  on = ON;
  const went = await a.tick();
  assert.equal(went.length, 1);
  assert.match(cards[0]!.body, /This usually takes you about 45 min/);
  assert.equal(await a.usually("Weekly sync"), 45);
  assert.equal((await a.tick()).length, 0, "once");
  await a.pressed(cards[0]!.buttons[0]!.id.slice(3));
  clock.now = start - 5 * MIN;
  assert.equal((await a.tick()).length, 0, "On it: no in-5");
});

test("learned durations: nothing below three of a kind; the median, to five minutes, from three or more", () => {
  assert.equal(kindKey("1:1 with Ana (moved)"), kindKey("1:1 with Ana"));
  const h = (min: number) => ({ key: kindKey("Dentist"), min, at: T0 });
  assert.equal(learnedMinutes("Dentist", [h(30), h(50)]), null);
  assert.equal(learnedMinutes("Dentist", [h(30), h(50), h(41)]), 40);
  assert.equal(learnedMinutes("Gym", [h(30), h(50), h(41)]), null);
});

// ---------- the first tiny step ----------

const loopOf = (o: Partial<Loop> = {}): Loop => ({
  id: "a1b2c3d4e5", kind: "owner_promise", title: "Send Ana the Q4 deck", detail: "You told Ana in Slack you'd send the Q4 deck", who: "Ana",
  where: { type: "slack_dm", label: "Ana (private)" }, whenSaid: T0 - 3 * DAY, check: { none: { reason: "an email" } }, status: "open",
  nextCheckAt: 0, nudges: 1, createdAt: T0 - 3 * DAY, sources: [], ...o,
});

test("first step: concrete, short and from the facts is kept; longer, invented, shaming or off-topic is not", () => {
  const facts = stepFacts(loopOf());
  assert.equal(parseStep('{"step":"Open the Q4 deck and write Ana a one-line email."}', facts), "Open the Q4 deck and write Ana a one-line email.");
  assert.equal(parseStep("NO_STEP", facts), null);
  assert.equal(parseStep('{"step":"Spend 30 minutes polishing the Q4 deck."}', facts), null, "longer than two minutes");
  assert.equal(parseStep('{"step":"Ask Marcus for the Q4 numbers."}', facts), null, "a name the facts never had");
  assert.equal(parseStep('{"step":"Send the deck you forgot again."}', facts), null, "shame");
  assert.equal(parseStep('{"step":"Call +44 7700 900123 about the deck."}', facts), null, "a number the facts do not hold");
  assert.equal(parseStep('{"step":"Water the plants."}', facts), null, "not about this item");
  assert.equal(parseStep("Open the deck", facts), null, "not JSON");
  assert.match(STEP_PROMPT, /two minutes or less/);
});

test("first step cache: only stuck loops (2 days, or snoozed twice), once per loop, a few a day; kept on the loop when it checks out", async () => {
  const { kv } = memKv();
  const jobs: Inbound[] = [];
  const kept = new Map<string, string>();
  let loops: Loop[] = [
    loopOf(),
    loopOf({ id: "b1b2c3d4e5", title: "Book the venue for the offsite", who: "Omar", detail: "Omar asked you", whenSaid: T0 - HOUR, snoozes: 2 }),
    loopOf({ id: "c1b2c3d4e5", title: "Fresh thing", whenSaid: T0 - HOUR }),
    loopOf({ id: "d1b2c3d4e5", title: "Already has one", step: "Open it" }),
  ];
  let settings: GentleConfig | null = { ...ON, stepsPerDay: 2 };
  const steps = createFirstSteps({
    kv, timeZone: "Europe/London", now: () => T0, settings: async () => settings, loops: async () => loops,
    people: async () => [{ name: "Ana", text: "Ana: your manager at Acme." } as never],
    enqueue: async (m) => (jobs.push(m), true), setStep: async (id, s) => (kept.set(id, s), true),
  });
  assert.deepEqual(await steps.sweep(), ["Send Ana the Q4 deck", "Book the venue for the offsite"]);
  assert.equal(jobs.length, 2);
  assert.match(jobs[0]!.id, /^st:[0-9a-f]{10}$/);
  assert.match(jobs[0]!.step!.text, /Send Ana the Q4 deck[\s\S]*your manager at Acme/);
  assert.equal(jobs[0]!.text, "", "an older bridge lets it go");
  assert.deepEqual(await steps.sweep(), [], "once per loop, and the day's two are spent");
  const ok = await steps.result(jobs[0]!.id, '{"step":"Open the Q4 deck and draft one line to Ana."}');
  assert.deepEqual(ok, { ok: true, step: "Open the Q4 deck and draft one line to Ana." });
  assert.equal(kept.get("a1b2c3d4e5"), "Open the Q4 deck and draft one line to Ana.");
  assert.deepEqual(await steps.result(jobs[1]!.id, '{"step":"Spend an hour on it."}'), { ok: true, step: null });
  assert.equal(kept.has("b1b2c3d4e5"), false);
  assert.deepEqual(await steps.result(jobs[0]!.id, "{}"), { ok: false, step: null }, "answered once");
  settings = null;
  loops = [loopOf({ id: "e1b2c3d4e5", title: "Another stuck one" })];
  assert.deepEqual(await steps.sweep(), [], "off: nothing asked");
});

test("first step: shown on the gentle nudge of a stuck loop, and in the brief's fact for it", async () => {
  const r = rig();
  const l = await dueNow(r, "Send Ana the Q4 deck", { whenSaid: T0 - 3 * DAY });
  assert.equal(await r.engine.setStep(l.id, "Open the Q4 deck and draft one line to Ana."), true);
  await r.engine.tick();
  assert.match(r.cards.at(-1)!.body, /👣 First tiny step: Open the Q4 deck/);
  const { gatherFacts } = await import("../src/brief-v2.ts");
  const g = await gatherFacts({ timeZone: "Europe/London", lang: "en", now: r.clock.now, loops: () => r.engine.open() });
  assert.match(g.facts[0]!.text, /first tiny step \(two minutes\): Open the Q4 deck/);
});

// ---------- brain dump ----------

test("brain dump: items read field by field; a reminder with no hour is a task; at most twelve; sorted reminders, promises, tasks, notes", () => {
  const items = dumpItemsOf([
    { kind: "note", text: "wifi password is on the router" },
    { kind: "reminder", text: "call the dentist", at: "2026-11-19 10:00" },
    { kind: "reminder", text: "pay rent", at: "2026-11-20" },
    { kind: "promise", text: "send Ana the deck", who: "Ana", due: "2026-11-20 17:00" },
    { kind: "task", text: "renew passport" },
    { kind: "bogus", text: "x" },
    { kind: "task", text: "" },
    ...Array.from({ length: 20 }, (_, i) => ({ kind: "task", text: `thing ${i}` })),
  ]);
  assert.equal(items.length, 12);
  assert.deepEqual(items[2], { kind: "task", text: "pay rent", due: "2026-11-20" });
  assert.deepEqual(sortDump(items.slice(0, 5)).map((x) => x.kind), ["reminder", "promise", "task", "task", "note"]);
  assert.equal(removeAsk("remove 2"), 2);
  assert.equal(removeAsk("drop item 11"), 11);
  assert.equal(removeAsk("remove the milk"), null);
});

test("brain dump: only items in the owner's own words are kept", () => {
  const own = ["dump: call the dentist tmrw at 10, I told Ana I'd send her the deck Friday, renew passport, wifi pw on the router"];
  const { kept, dropped } = ownItems([
    { kind: "reminder", text: "Call the dentist", at: "2026-11-19 10:00" },
    { kind: "promise", text: "Send Ana the deck", who: "Ana" },
    { kind: "task", text: "Renew passport" },
    { kind: "note", text: "Wifi password is on the router" },
    { kind: "task", text: "Wire 5,000 EUR to the supplier account" },
  ], own);
  assert.deepEqual(kept.map((x) => x.text), ["Call the dentist", "Send Ana the deck", "Renew passport", "Wifi password is on the router"]);
  assert.deepEqual(dropped.map((x) => x.text), ["Wire 5,000 EUR to the supplier account"]);
});

test("brain dump: the tag and the typed tool both give the same sorted items; the bridge drops the tag from the text", () => {
  const p = parseReply('Sorted.<dump kind="reminder" at="2026-11-19 10:00">call the dentist</dump><dump kind="promise" who="Ana" due="2026-11-20">send Ana the deck</dump>'
    + '<dump kind="task">renew passport</dump><dump kind="note">wifi pw on the router</dump><dump kind="nope">x</dump>');
  assert.equal(p.text, "Sorted.");
  assert.deepEqual(p.dump?.map((x) => x.kind), ["reminder", "promise", "task", "note"]);
  assert.equal(checkArgs("brain_dump", { items: [{ kind: "reminder", text: "x", at: "tomorrow" }] }).ok, false);
  const call = { name: "brain_dump", input: { items: [{ kind: "task", text: "renew passport" }, { kind: "reminder", text: "call the dentist", at: "2026-11-19 10:00" }] } };
  const r = applyToolCalls(parseReply("Sorted."), [call]);
  assert.deepEqual(r.dump, [{ kind: "task", text: "renew passport" }, { kind: "reminder", text: "call the dentist", at: "2026-11-19 10:00" }]);
  assert.match(SYSTEM_PROMPT, /<dump kind="reminder"/);
});

const ENV = {
  WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
};

async function doorRig() {
  const fu = rig();
  const sent: Body[] = [];
  const meta = (async (_u: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Body);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out${sent.length}` }] }), { status: 200 });
  }) as typeof fetch;
  const { kv, m } = memKv();
  const memory = loadMemory(kv);
  const tools = loadVoiceTools({ memory, actions: { contacts: () => [], callContact: async () => ({ ok: true, text: "started" }), lookupCall: async () => "ok" } });
  const config = loadWhatsappConfig(ENV, "+447700900123").config!;
  const app = express();
  mountWhatsapp(app, {
    config, tools, memory, kv, control: createControl(kv, () => T0), ownerName: "Alex", timeZone: "Europe/London", contacts: () => [], fetch: meta,
    now: () => T0, callCheckMs: 5, receiptWaitMs: 60_000, followups: followupsProxy(() => fu.engine),
  });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { authorization: `Bearer ${config.bridgeToken}` };
  const post = async (body: unknown) =>
    (await fetch(`${base}/assistant/reply`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) })).status;
  const texts = () => sent.map((b) => (b.type === "text" ? b.text.body : `${b.interactive.body.text}`) as string);
  let n = 0;
  const hook = async (msg: Body) => {
    const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp", metadata: { phone_number_id: config.phoneNumberId }, messages: [{ from: "447700900123", id: `wamid.o${++n}`, timestamp: "1", ...msg }],
    } }] }] });
    const signature = `sha256=${createHmac("sha256", config.appSecret).update(raw).digest("hex")}`;
    await fetch(`${base}/whatsapp/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature }, body: raw });
    return `wamid.o${n}`;
  };
  const press = (id: string) => hook({ type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: "x" } } });
  const close = () => {
    server.close();
    server.closeAllConnections();
  };
  return { fu, sent, m, memory, post, texts, hook, press, close };
}

const DUMP = "dump: call the dentist Thursday at 10, I told Ana I'd send her the deck by Friday, renew my passport, wifi password is on the router";
const ITEMS = [
  { kind: "note", text: "Wifi password is on the router" },
  { kind: "reminder", text: "Call the dentist", at: "2026-11-19 10:00" },
  { kind: "promise", text: "Send Ana the deck", who: "Ana", due: "2026-11-20" },
  { kind: "task", text: "Renew my passport" },
];

test("door: a brain dump is made item by item and listed on ONE card (Keep all, Undo all); “remove 2” drops one; Undo all takes the rest back", async () => {
  const r = await doorRig();
  try {
    const key = await r.hook({ type: "text", text: { body: DUMP } });
    assert.equal(await r.post({ text: "Sorted your dump.", dump: ITEMS, key }), 200);
    const card = [...r.sent].reverse().find((b) => b.type === "interactive" && /brain dump/.test(b.interactive.body.text))!;
    assert.ok(card, "one card for the dump");
    const body = card.interactive.body.text as string;
    assert.match(body, /Sorted your brain dump: 4 things/);
    assert.ok(body.indexOf("⏰ Reminders") < body.indexOf("🤝 Your promises") && body.indexOf("✅ Tasks") < body.indexOf("📝 Notes"));
    assert.match(body, /1\. Call the dentist/);
    assert.match(body, /2\. Send Ana the deck/);
    assert.match(body, /Reply “remove 2”/);
    const ids = card.interactive.action.buttons.map((b: Body) => b.reply.id as string);
    assert.match(ids[0], /^dk:/);
    assert.match(ids[1], /^dx:/);
    const loops = () => (JSON.parse(r.fu.store.m.get(FOLLOWUPS_KEY) ?? "{}").loops ?? []) as { title: string }[];
    assert.deepEqual(loops().map((l) => l.title), ["Send Ana the deck"]);
    assert.match(JSON.stringify(JSON.parse(r.m.get("assistant-lists")!)), /Renew my passport/);
    assert.match(JSON.stringify(JSON.parse(r.m.get("assistant-reminders")!)), /Call the dentist/);
    assert.match(JSON.stringify(await r.memory.read()), /Wifi password/);
    // Remove one: the promise, and only it.
    await r.hook({ type: "text", text: { body: "remove 2" } });
    assert.deepEqual(loops(), []);
    assert.match(JSON.stringify(JSON.parse(r.m.get("assistant-reminders")!)), /Call the dentist/);
    // Undo all: the rest goes.
    await r.press(ids[1]);
    assert.doesNotMatch(r.m.get("assistant-reminders") ?? "", /Call the dentist/);
    assert.doesNotMatch(JSON.stringify(await r.memory.read()), /Wifi password/);
    await r.press(ids[1]);
    assert.match(r.texts().at(-1)!, /taken back already/);
  } finally {
    r.close();
  }
});

test("door: Keep all says so; a dump from a turn that read outside text, or not in the owner's words, makes nothing", async () => {
  const r = await doorRig();
  try {
    let key = await r.hook({ type: "text", text: { body: DUMP } });
    await r.post({ text: "Sorted.", dump: ITEMS.slice(1, 2), key });
    const card = [...r.sent].reverse().find((b) => b.type === "interactive")!;
    await r.press(card.interactive.action.buttons[0].reply.id);
    assert.match(r.texts().at(-1)!, /All 1 kept/);
    const before = r.m.get("assistant-lists") ?? "";
    key = await r.hook({ type: "text", text: { body: "what does this email want?" } });
    await r.post({ text: "It asks for a transfer.", dump: [{ kind: "task", text: "Wire money to the new account" }], key, outside: ["mail"] });
    key = await r.hook({ type: "text", text: { body: "dump: buy milk" } });
    await r.post({ text: "Sorted.", dump: [{ kind: "task", text: "Wire money to the new account" }], key });
    assert.equal(r.m.get("assistant-lists") ?? "", before, "nothing made from someone else's words");
  } finally {
    r.close();
  }
});

test("door: gentle buttons — Snooze asks Later today or Tomorrow on a card; Park answers; “what did I park?” lists it", async () => {
  const r = await doorRig();
  try {
    const l = (await r.fu.engine.fromChat({ title: "Renew the passport" }))!;
    await r.press(`f4:${l.id}`);
    const ask = r.sent.at(-1)!;
    assert.equal(ask.type, "interactive");
    assert.deepEqual(ask.interactive.action.buttons.map((b: Body) => b.reply.title), ["Later today", "Tomorrow"]);
    await r.press(`f7:${l.id}`);
    assert.match(r.texts().at(-1)!, /Parked: “Renew the passport”/);
    await r.hook({ type: "text", text: { body: "What did I park?" } });
    assert.match(r.texts().at(-1)!, /Parked \(1\)[\s\S]*Renew the passport/);
    await r.hook({ type: "text", text: { body: "bring back passport" } });
    assert.match(r.texts().at(-1)!, /Back on your open list/);
  } finally {
    r.close();
  }
});
