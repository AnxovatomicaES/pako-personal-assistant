// Follow-ups over their whole life: who-less to-dos, deadlines far ahead, Zoom meetings set up weeks ahead, a call-off racing the first
// reading, and a meeting moved to a new time.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFollowups, type FollowupsConfig, type SlackLine, type ZoomSeen } from "../src/followups.ts";
import type { Kv } from "../src/kv.ts";
import { reviewLoops, type ReviewFound } from "../src/meeting-review.ts";
import type { Inbound } from "../src/whatsapp.ts";
import { createZoom } from "../src/zoom.ts";

const MIN = 60_000;
const DAY = 24 * 3600_000;
/** Monday 16 November 2026, 09:30 in Madrid. */
const T0 = Date.parse("2026-11-16T08:30:00Z");

function memKv() {
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  return { kv, m };
}

function rig(o: { zoom?: () => Promise<ZoomSeen[]>; history?: Record<string, SlackLine[]>; config?: Partial<FollowupsConfig>; clock?: { now: number } } = {}) {
  const clock = o.clock ?? { now: T0 };
  const store = memKv();
  const queued: Inbound[] = [];
  const cards: { body: string }[] = [];
  const notices: string[] = [];
  const history = o.history ?? {};
  const engine = createFollowups({
    config: { delayMs: 10 * MIN, maxPerDay: 6, batchMs: 3 * MIN, quiet: { start: 23 * 60, end: 8 * 60 }, ...o.config },
    kv: store.kv,
    timeZone: "Europe/Madrid",
    now: () => clock.now,
    enqueue: async (m) => (queued.push(m), true),
    card: async (body) => (cards.push({ body }), true),
    notify: async (t) => void notices.push(t),
    zoom: o.zoom ?? (async () => []),
    slackHistory: async (ch, q) => (history[ch] ?? []).filter((m) => !q.oldest || Number(m.ts) > Number(q.oldest)),
  });
  return { clock, store, queued, cards, notices, engine };
}

const rohan = (at: number, text: string) =>
  ({ channel: "D0ROHAN", ts: String(at / 1000), at, who: "Rohan", where: "Rohan (privado)", direct: true, text });
const jobId = (m: Inbound) => /^fu:([0-9a-f]{10})$/.exec(m.id)![1]!;

test("a meeting to-do with nobody waiting is nudged without a '?' for a person", async () => {
  const r = rig();
  const meetingAt = T0 - 60 * MIN;
  const found: ReviewFound = {
    summary: "", decisions: [], meetings: [], questions: [], promises: [],
    todos: [{ title: "Mandar el informe de riesgos", who: "", due: T0 + DAY + 6 * 3600_000, evidence: "Linus: lo mando mañana", check: "none", reason: "email" }],
  };
  const n = await r.engine.ingest({ ref: "uuid-1", label: "Weekly sync", at: meetingAt, loops: reviewLoops(found, meetingAt, T0, "Europe/Madrid", "en") });
  assert.equal(n, 1);
  r.clock.now = T0 + DAY + 4 * 3600_000 + MIN; // the "none" nudge, two hours before (Tue 13:31 Madrid)
  await r.engine.tick();
  assert.equal(r.cards.length, 1, "the to-do is said once before its time");
  console.log("NUDGE:", r.cards[0]!.body);
  assert.doesNotMatch(r.cards[0]!.body, /\?/, "no '?' standing for a person in the owner's reminder");
});

test("a deadline more than 14 days out is kept until its reminder, said once two hours before", async () => {
  const r = rig();
  await r.engine.observeSlack(rohan(T0, "Please send me the signed budget by Friday 4 December, it's for the board"));
  r.clock.now = T0 + 3 * MIN;
  await r.engine.tick();
  const answer = JSON.stringify({ loops: [{ kind: "request_to_owner", title: "Mandar a Rohan el presupuesto firmado", who: "Rohan", due: "2026-12-04", check: "none", reason: "email" }] });
  assert.deepEqual(await r.engine.result(jobId(r.queued[0]!), answer), { ok: true, added: 1 });
  const due = Date.parse("2026-12-04T17:00:00Z"); // 18:00 Madrid
  // Walk the clock forward every 30 minutes, like the real interval, up to the deadline.
  for (r.clock.now = T0 + 4 * MIN; r.clock.now < due; r.clock.now += 30 * MIN) {
    await r.engine.tick();
    if (r.clock.now - T0 < 13 * DAY + 31 * MIN && r.clock.now - T0 >= 13 * DAY) console.log("day 13, open:", (await r.engine.open()).length);
    if (r.clock.now - T0 < 15 * DAY + 31 * MIN && r.clock.now - T0 >= 15 * DAY) console.log("day 15, open:", (await r.engine.open()).length, "stored loops:", (await r.engine.read()).loops.length);
  }
  console.log("cards:", r.cards.length, "open now:", (await r.engine.open()).length);
  assert.equal(r.cards.length, 1, "the deadline is said once, two hours before it");
});

test("a Zoom meeting set up 10 days ahead is seen, and closes the loop silently", async () => {
  const clock = { now: T0 };
  const meetingAt = Date.parse("2026-11-26T10:15:00Z"); // Thursday 26 Nov, 5:15 AM ET
  const fakeFetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/oauth/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    if (u.includes("/meetings?type=upcoming")) {
      return new Response(JSON.stringify({
        meetings: [{ topic: "Samir / Maya Chen / Stan", start_time: new Date(meetingAt).toISOString(), created_at: new Date(T0 + 5 * MIN).toISOString(), type: 2 }],
      }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const zoom = createZoom({
    config: { accountId: "acct12345", clientId: "client12345", clientSecret: "secret1234567890ab", user: "o@example.com", pollMinutes: 10 },
    kv: null, timeZone: "Europe/Madrid", notify: async () => undefined, enqueue: async () => true, fetch: fakeFetch, now: () => clock.now,
  });
  const r = rig({ zoom: () => zoom.scheduled(), clock });
  await r.engine.observeSlack(rohan(T0, "Can you set up Samir, Maya Chen and Stan on Thu 26 Nov at 5:15 AM ET?"));
  clock.now = T0 + 3 * MIN;
  await r.engine.tick();
  const answer = JSON.stringify({ loops: [{ kind: "request_to_owner", title: "Montar la reunión con Samir, Maya Chen y Stan", who: "Rohan", due: "2026-11-26 05:15", tz: "America/New_York", check: "zoomMeeting", hints: ["Samir", "Maya Chen", "Stan"] }] });
  assert.deepEqual(await r.engine.result(jobId(r.queued[0]!), answer), { ok: true, added: 1 });
  clock.now = T0 + 14 * MIN; // after the owner set it up at T0+5
  const out = await r.engine.tick();
  console.log("tick:", out, "cards:", r.cards.map((c) => c.body));
  assert.equal(out.done, 1, "the meeting the owner set up on Zoom closes it");
  assert.equal(r.cards.length, 0, "no reminder saying it is not on Zoom");
});

test("'never mind' sent before the first reading is answered waits for it, then closes the loop: a called-off meeting is not nudged", async () => {
  const r = rig();
  await r.engine.observeSlack(rohan(T0, "Can you set up a call with Samir at 5:15 AM ET today?"));
  r.clock.now = T0 + 3 * MIN;
  await r.engine.tick(); // job 1 goes to the inbox (the Mac is busy / waking up)
  r.clock.now = T0 + 4 * MIN;
  await r.engine.observeSlack(rohan(T0 + 4 * MIN, "actually never mind, Stan already set it up"));
  r.clock.now = T0 + 7 * MIN;
  await r.engine.tick();
  assert.equal(r.queued.length, 1, "the conversation's next job waits for the answer to the first");
  await r.engine.result(jobId(r.queued[0]!), JSON.stringify({ loops: [{ kind: "request_to_owner", title: "Montar la llamada con Samir", who: "Rohan", due: "2026-11-16 05:15", tz: "America/New_York", check: "zoomMeeting", hints: ["Samir"] }] }));
  const [loop] = await r.engine.open();
  r.clock.now = T0 + 14 * MIN; // the loop's first check is due, but the next job is only being asked now
  await r.engine.tick();
  assert.equal(r.queued.length, 2);
  assert.match(r.queued[1]!.followup!.text, new RegExp(`Open loops of this conversation[\\s\\S]*${loop!.id}: Montar la llamada con Samir`), "the next job lists the loop");
  assert.equal(r.cards.length, 0, "not checked while its conversation is being read");
  await r.engine.result(jobId(r.queued[1]!), JSON.stringify({ loops: [], closes: [loop!.id] }));
  r.clock.now = T0 + 15 * MIN;
  await r.engine.tick();
  assert.equal(r.cards.length, 0, "a meeting called off in the conversation is not nudged");
  assert.equal((await r.engine.open()).length, 0);
});

test("a job that could not be queued does not hold its conversation", async () => {
  let accept = false;
  const r = rig();
  const engine = createFollowups({
    config: { delayMs: 10 * MIN, maxPerDay: 6, batchMs: 3 * MIN, quiet: null }, kv: memKv().kv, timeZone: "Europe/Madrid", now: () => r.clock.now,
    enqueue: async (m) => (accept ? (r.queued.push(m), true) : false), card: async () => true, notify: async () => undefined,
  });
  await engine.observeSlack(rohan(T0, "Can you set up a call with Samir?"));
  r.clock.now = T0 + 3 * MIN;
  await engine.tick();
  accept = true;
  await engine.observeSlack(rohan(T0 + 4 * MIN, "and with Stan too"));
  r.clock.now = T0 + 7 * MIN;
  await engine.tick();
  assert.equal(r.queued.length, 1);
});

test("a meeting moved from 5:15 to 6:15 AM ET in a later message: the loop follows the new time", async () => {
  const r = rig();
  await r.engine.observeSlack(rohan(T0, "Can you set up a call with Samir, Maya Chen and Stan at 5:15 AM ET today?"));
  r.clock.now = T0 + 3 * MIN;
  await r.engine.tick();
  const loop = (due: string) => ({ kind: "request_to_owner", title: "Montar la reunión con Samir, Maya Chen y Stan", who: "Rohan", due, tz: "America/New_York", check: "zoomMeeting", hints: ["Samir", "Maya Chen", "Stan"] });
  await r.engine.result(jobId(r.queued[0]!), JSON.stringify({ loops: [loop("2026-11-16 05:15")] }));
  r.clock.now = T0 + 5 * MIN;
  await r.engine.observeSlack(rohan(T0 + 5 * MIN, "sorry, can we make it 6:15 AM ET instead?"));
  r.clock.now = T0 + 8 * MIN;
  await r.engine.tick();
  const res = await r.engine.result(jobId(r.queued[1]!), JSON.stringify({ loops: [loop("2026-11-16 06:15")], closes: [] }));
  const open = await r.engine.open();
  console.log("result:", res, "open:", open.map((l) => new Date(l.dueAt!).toISOString()));
  r.clock.now = T0 + 14 * MIN;
  await r.engine.tick();
  console.log("cards:", r.cards.map((c) => c.body));
  assert.ok(open.some((l) => l.dueAt === Date.parse("2026-11-16T11:15:00Z")), "the loop follows the new time, 6:15 AM ET");
});

test("DST mismatch week (US still on summer time): 5:15 AM ET is 10:15 in Madrid", async () => {
  const at = Date.parse("2026-10-28T08:30:00Z");
  const r = rig({ clock: { now: at } });
  await r.engine.observeSlack(rohan(at, "set up 5:15 AM ET today pls"));
  r.clock.now = at + 3 * MIN;
  await r.engine.tick();
  await r.engine.result(jobId(r.queued[0]!), JSON.stringify({ loops: [{ kind: "request_to_owner", title: "Montar la reunión con Samir", who: "Rohan", due: "2026-10-28 05:15", tz: "America/New_York", check: "zoomMeeting", hints: ["Samir"] }] }));
  const [l] = await r.engine.open();
  console.log(r.engine.describe(l!));
  assert.match(r.engine.describe(l!), /5:15 AM ET \(10:15 Madrid\)/);
});
