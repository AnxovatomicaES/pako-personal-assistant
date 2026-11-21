// Follow-ups matched to the right loop and meeting (the chief-of-staff pieces), each replayed with fakes: a nudge after the meeting's time, a loop with no time never
// looked at again, later messages that cannot close a loop, a re-ping that makes a twin, a standing meeting taken for the one asked for, Slack
// threads, someone else's promise checked on the owner's Zoom, follow-up jobs crowding the inbox, Zoom summaries held while the computer is
// off, and two processes during a deploy.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { gatherFacts } from "../src/brief-v2.ts";
import { createFollowups, FOLLOWUPS_KEY, stateOf, type EventSeen, type FollowupsConfig, type SlackLine, type SlackSeen, type ZoomSeen } from "../src/followups.ts";
import type { Kv } from "../src/kv.ts";
import { createMeetingReview } from "../src/meeting-review.ts";
import { mountSlack } from "../src/slack.ts";
import { createInbox, type Inbound } from "../src/whatsapp.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const ASK = "samir@acmeco.example Maya Chen Stan myself for meeting at 5:15 AM ET Today — can you set it up pls";
/** 5:15 AM ET on Monday 16 November 2026 (11:15 Madrid). */
const DUE = Date.parse("2026-11-16T10:15:00Z");

function memKv() {
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  return { kv, m };
}

const SETUP = (o: { due?: string | null; title?: string; same?: string } = {}) => JSON.stringify({
  loops: [{
    kind: "request_to_owner", title: o.title ?? "Montar la reunión con samir@acmeco.example, Maya Chen y Stan", who: "Rohan",
    ...(o.due === null ? {} : { due: o.due ?? "2026-11-16 05:15", tz: "America/New_York" }),
    check: "zoomMeeting", hints: ["samir@acmeco.example", "Maya Chen", "Stan"], ...(o.same ? { same: o.same } : {}),
  }],
});

type HistoryCall = { channel: string; oldest?: string; thread?: string; limit?: number };

function rig(o: {
  at: number; kv?: ReturnType<typeof memKv>; config?: Partial<FollowupsConfig>; zoom?: () => Promise<ZoomSeen[]>;
  calendar?: () => Promise<EventSeen[] | { events: EventSeen[]; partial: boolean }>;
}) {
  const clock = { now: o.at };
  const store = o.kv ?? memKv();
  const queued: Inbound[] = [];
  const cards: string[] = [];
  const notices: string[] = [];
  const zoomMeetings: ZoomSeen[] = [];
  const events: EventSeen[] = [];
  const history: Record<string, SlackLine[]> = {};
  const calls: HistoryCall[] = [];
  const engine = createFollowups({
    config: { delayMs: 10 * MIN, maxPerDay: 6, batchMs: 3 * MIN, quiet: { start: 23 * 60, end: 8 * 60 }, ...o.config },
    kv: store.kv,
    timeZone: "Europe/Madrid",
    now: () => clock.now,
    enqueue: async (m) => (queued.push(m), true),
    card: async (body) => (cards.push(body), true),
    notify: async (t) => void notices.push(t),
    zoom: o.zoom ?? (async () => zoomMeetings),
    calendar: o.calendar ?? (async () => events),
    slackHistory: async (channel, q) => {
      calls.push({ channel, ...q });
      const key = q.thread ? `${channel}/${q.thread}` : channel;
      return (history[key] ?? []).filter((m) => !q.oldest || Number(m.ts) > Number(q.oldest));
    },
  });
  /** A Slack message, its batch, its job, and the bridge's answer: the job's id. */
  const say = async (answer: string, m: { channel?: string; who?: string; text?: string; thread?: string; where?: string } = {}): Promise<string> => {
    const at = clock.now;
    await engine.observeSlack({
      channel: m.channel ?? "D0ROHAN", ts: String(at / 1000), at, who: m.who ?? "Rohan", where: m.where ?? "Rohan (privado)",
      direct: !(m.channel ?? "D0ROHAN").startsWith("C"), text: m.text ?? ASK, ...(m.thread ? { thread: m.thread } : {}),
    });
    clock.now += 3 * MIN;
    await engine.tick();
    const id = /^fu:([0-9a-f]{10})$/.exec(queued.at(-1)!.id)![1]!;
    assert.equal((await engine.result(id, answer)).ok, true);
    return id;
  };
  const at = async (iso: string | number) => {
    clock.now = typeof iso === "number" ? iso : Date.parse(iso);
    return engine.tick();
  };
  const stored = () => stateOf(JSON.parse(store.m.get(FOLLOWUPS_KEY)!));
  return { clock, store, queued, cards, notices, zoomMeetings, events, history, calls, engine, say, at, stored };
}

test("finding 1, case A: nudged at 09:11; the next tick comes at 11:50 (late, a restart): nothing about a meeting that already started", async () => {
  const r = rig({ at: Date.parse("2026-11-16T08:00:00Z") }); // 09:00 Madrid
  await r.say(SETUP());
  await r.at("2026-11-16T08:11:00Z");
  assert.equal(r.cards.length, 1, "the first nudge, in time");
  await r.at("2026-11-16T10:50:00Z"); // 11:50 Madrid, 35 minutes after 11:15
  assert.equal(r.cards.length + r.notices.length, 1, "no ⏰ Queda poco after the time");
  const l = r.stored().loops[0]!;
  assert.equal(l.nextCheckAt, 0, "no more checks");
  assert.equal(l.lastCheck, "I don't see it in your Zoom or your calendar.");
  assert.ok(l.checkedAt, "when it was looked at");
  await r.at("2026-11-16T12:00:00Z");
  assert.equal(r.cards.length, 1);
});

test("finding 1, case B: asked at 22:55 for 07:00; the check falls in the quiet hours; at 08:00 the meeting is over: no first nudge", async () => {
  const r = rig({ at: Date.parse("2026-11-16T21:55:00Z") }); // 22:55 Madrid
  await r.say(SETUP({ due: "2026-11-17 07:00" }).replace("America/New_York", "Europe/Madrid"));
  for (const t of ["2026-11-16T22:05:00Z", "2026-11-17T05:00:00Z", "2026-11-17T07:00:00Z", "2026-11-17T08:30:00Z"]) await r.at(t);
  assert.equal(r.cards.length + r.notices.length, 0, "never \"I don't see it in your Zoom\" for a meeting that has ended");
  assert.equal(r.stored().loops[0]!.nextCheckAt, 0);
});

test("finding 2: a loop with no time is looked at again after its nudge (silently) and closes when the meeting appears; old ones are hidden", async () => {
  const T = Date.parse("2026-11-16T08:00:00Z");
  const r = rig({ at: T });
  await r.say(SETUP({ due: null }), { text: "can you set up a call with Samir and Stan" });
  await r.at(T + 13 * MIN);
  assert.equal(r.cards.length, 1);
  const first = r.stored().loops[0]!;
  assert.ok(first.nextCheckAt > 0, "not abandoned after the nudge");
  await r.at(first.nextCheckAt);
  assert.equal(r.cards.length, 1, "a re-check never says it again");
  assert.equal((await r.engine.open()).length, 1);
  // The owner sets it up an hour later and does not press Hecho.
  r.zoomMeetings.push({ topic: "Acmeco intro: Samir, Stan", at: Date.parse("2026-11-17T15:00:00Z"), createdAt: T + 70 * MIN });
  await r.at(r.stored().loops[0]!.nextCheckAt);
  assert.deepEqual(await r.engine.open(), [], "closed by itself");
  assert.equal(r.cards.length, 1);

  // A loop whose time passed hours ago is not shown any more (PENDIENTES, the brief, the context).
  const s = rig({ at: Date.parse("2026-11-16T08:00:00Z") });
  await s.say(SETUP());
  await s.at("2026-11-16T08:11:00Z");
  s.clock.now = DUE + 2 * HOUR;
  assert.equal((await s.engine.open()).length, 1, "still shown a while after");
  s.clock.now = DUE + 7 * HOUR;
  assert.deepEqual(await s.engine.open(), []);
});

test("finding 2: the brief says when Pako checked, so an old check is not presented as current", async () => {
  const r = rig({ at: Date.parse("2026-11-16T08:00:00Z") });
  await r.say(SETUP());
  await r.at("2026-11-16T08:11:00Z");
  const g = await gatherFacts({ timeZone: "Europe/Madrid", lang: "en", now: Date.parse("2026-11-16T08:30:00Z"), loops: () => r.engine.open() });
  const fact = g.facts.find((f) => f.id === "L1")!;
  assert.match(fact.text, /what Pako checked \(Mon 16\/11, 09:11; it may have changed since\): I don't see it in your Zoom or your calendar\./);
});

test("finding 3: \"nvm, Stan set it up\" closes the loop (only one of that conversation); the job lists the open loops with their ids", async () => {
  const T = Date.parse("2026-11-16T08:00:00Z");
  const r = rig({ at: T });
  await r.say(SETUP());
  const a = r.stored().loops[0]!.id;
  // Another conversation's open loop, which this one must not close.
  await r.say(JSON.stringify({ loops: [{ kind: "request_to_owner", title: "Mandar el informe a Ana", who: "Ana", check: "slackReply" }] }), {
    channel: "D0ANA", who: "Ana", where: "Ana (privado)", text: "send me the report",
  });
  const other = r.stored().loops.find((l) => l.who === "Ana")!.id;
  r.clock.now = T + 7 * MIN;
  await r.say(JSON.stringify({ loops: [], closes: [a, other, "zzzz"] }), { text: "nvm, Stan set it up" });
  const job = r.queued.at(-1)!.followup!.text;
  assert.match(job, new RegExp(`Open loops of this conversation \\(id: what\\):\\n- ${a}: Montar la reunión con samir@acmeco\\.example, Maya Chen y Stan \\(Rohan\\)`));
  assert.ok(!job.includes(other), "only this conversation's loops");
  const s = r.stored();
  assert.equal(s.loops.find((l) => l.id === a)!.status, "done");
  assert.equal(s.loops.find((l) => l.id === other)!.status, "open", "another conversation's loop stays open");
  await r.at(T + 15 * MIN);
  assert.ok(!r.cards.some((c) => c.includes("Montar la reunión")), "no nudge for something already handled");
});

test("finding 3: the owner answered in the DM (\"Done, invite sent\", hosted by Stan): no nudge at +10 min; one soft one near the time", async () => {
  const T = Date.parse("2026-11-16T08:30:00Z");
  const r = rig({ at: T });
  await r.say(SETUP());
  r.history.D0ROHAN = [{ ts: String((T + 5 * MIN) / 1000), at: T + 5 * MIN, mine: true, who: "", text: "Done, invite sent" }];
  await r.at(T + 13 * MIN);
  assert.equal(r.cards.length, 0, "the owner replied: not nagged ten minutes later");
  assert.match(r.stored().loops[0]!.lastCheck!, /You did reply in that conversation/);
  await r.at(DUE - HOUR);
  assert.equal(r.cards.length, 1);
  assert.match(r.cards[0]!, /^⏰ .*I don't see it in your Zoom or your calendar\. You did reply in that conversation: if it's done, press Done\./);
  await r.at(DUE - 5 * MIN);
  assert.equal(r.cards.length, 1);
});

test("finding 4: a re-ping worded differently is the same loop (no twin, no second nudge); so is one the run names with \"same\"", async () => {
  const T = Date.parse("2026-11-16T08:00:00Z");
  const r = rig({ at: T });
  await r.say(SETUP());
  await r.at(T + 13 * MIN);
  r.clock.now = T + 30 * MIN;
  await r.say(SETUP({ title: "Montar la reunión con Samir, Michael y Stan" }), { text: "any news on the setup?" });
  assert.equal((await r.engine.open()).length, 1, "merged");
  assert.equal(r.stored().loops[0]!.sources.length, 2, "with both messages as its sources");
  await r.at(T + 45 * MIN);
  assert.equal(r.cards.length, 1);
  const a = r.stored().loops[0]!.id;
  await r.say(
    JSON.stringify({ loops: [{ kind: "owner_promise", title: "Confirmar a Rohan la reunión", who: "Rohan", check: "slackReply", same: a }] }),
    { text: "ping" },
  );
  assert.equal((await r.engine.open()).length, 1, "the id the run gave");
});

test("finding 5: a standing meeting at the time asked, or one set up before the ask, or a weekly with a colleague's name, is not the one", async () => {
  const T = Date.parse("2026-11-16T08:00:00Z");
  const cases: [string, ZoomSeen, boolean][] = [
    ["a weekly standup at 11:00", { topic: "Sales standup", at: DUE - 15 * MIN, recurring: true }, false],
    ["a one-off set up last week at 11:15", { topic: "Sales standup", at: DUE, createdAt: T - 7 * 24 * HOUR }, false],
    ["a meeting set up after the ask at 11:15, any topic", { topic: "Sync", at: DUE, createdAt: T + 5 * MIN }, true],
    ["one set up before, named for them", { topic: "Acmeco: Samir + Maya Chen", at: DUE + 30 * MIN, createdAt: T - HOUR }, true],
  ];
  for (const [what, meeting, done] of cases) {
    const r = rig({ at: T });
    await r.say(SETUP());
    r.zoomMeetings.push(meeting);
    const out = await r.at(T + 13 * MIN);
    assert.equal(out.done, done ? 1 : 0, what);
    assert.equal(r.cards.length, done ? 0 : 1, what);
  }
  // No time given: "Stan / Theo weekly" later in the week is not the call with Samir and Stan.
  const r = rig({ at: T });
  await r.say(SETUP({ due: null }));
  r.zoomMeetings.push({ topic: "Stan / Theo weekly", at: Date.parse("2026-11-18T09:00:00Z"), recurring: true });
  r.events.push({ title: "Stan / Theo weekly", start: Date.parse("2026-11-18T09:00:00Z"), recurring: true });
  await r.at(T + 13 * MIN);
  assert.equal(r.cards.length, 1);
});

test("finding 6: a mention in a #sales thread: the thread is the context, and the owner's reply in the thread closes it", async () => {
  const T = Date.parse("2026-11-16T08:00:00Z");
  const r = rig({ at: T });
  const parent = String((T - HOUR) / 1000);
  r.history[`C0SALES/${parent}`] = [
    { ts: parent, at: T - HOUR, mine: false, who: "Stan", text: "Acmeco wants a call at 5:15 AM ET with Samir" },
    { ts: String(T / 1000), at: T, mine: false, who: "Stan", text: "@owner can you set up the Acmeco call?" },
  ];
  await r.say(JSON.stringify({ loops: [{ kind: "request_to_owner", title: "Contestar a Stan sobre la llamada de Acmeco", who: "Stan", check: "slackReply" }] }), {
    channel: "C0SALES", who: "Stan", where: "Stan en #sales", text: "@owner can you set up the Acmeco call?", thread: parent,
  });
  assert.deepEqual(r.calls[0], { channel: "C0SALES", limit: 15, thread: parent }, "the thread's messages, not the channel's");
  assert.match(r.queued[0]!.followup!.text, /Stan: Acmeco wants a call at 5:15 AM ET with Samir/, "the parent, with who and when");
  const l = r.stored().loops[0]!;
  assert.equal(l.where.thread, parent);
  assert.deepEqual(l.check, { slackReply: { channel: "C0SALES", afterTs: String(T / 1000), thread: parent } });
  r.history[`C0SALES/${parent}`]!.push({ ts: String((T + 5 * MIN) / 1000), at: T + 5 * MIN, mine: true, who: "", text: "on it, done" });
  await r.at(T + 13 * MIN);
  assert.equal(r.cards.length, 0, "the reply in the thread is seen");
  assert.deepEqual(await r.engine.open(), []);
});

test("finding 6: Slack's reader passes a thread on, and reads a thread with conversations.replies", async () => {
  const SECRET = "s".repeat(32);
  const asked: { method: string; params: URLSearchParams }[] = [];
  const fake = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const method = url.pathname.split("/").pop()!;
    asked.push({ method, params: url.searchParams });
    const json = (b: unknown) => new Response(JSON.stringify(b));
    if (method === "auth.test") return json({ ok: true, user_id: "UME" });
    if (method === "users.info") return json({ ok: true, user: { profile: { display_name: "Stan" } } });
    if (method === "conversations.info") return json({ ok: true, channel: { name: "sales" } });
    if (method === "conversations.replies") {
      return json({ ok: true, messages: [{ ts: "100.1", user: "USTAN", text: "parent" }, { ts: "100.2", user: "UME", text: "mine" }] });
    }
    return json({ ok: false, error: "unknown_method" });
  }) as typeof fetch;
  const seen: SlackSeen[] = [];
  const app = express();
  const reader = mountSlack(app, {
    config: { token: "xoxp-test", signingSecret: SECRET, quiet: null, forward: false }, kv: null, timeZone: "Europe/Madrid",
    notify: async () => undefined, fetch: fake, observe: (m) => void seen.push(m), batchMs: 10, retryMs: 10,
  });
  const server = createServer(app);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const body = JSON.stringify({
      type: "event_callback", event_id: "Ev1",
      event: { type: "message", channel: "C1", channel_type: "channel", user: "USTAN", text: "<@UME> can you?", ts: "100.5", thread_ts: "100.1" },
    });
    const ts = Math.floor(Date.now() / 1000);
    const sig = `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
    const res = await fetch(`${base}/slack/events`, {
      method: "POST", headers: { "content-type": "application/json", "x-slack-request-timestamp": String(ts), "x-slack-signature": sig }, body,
    });
    assert.equal(res.status, 200);
    for (let i = 0; i < 50 && !seen.length; i++) await new Promise((ok) => setTimeout(ok, 20));
    assert.equal(seen[0]?.thread, "100.1");
    const lines = await reader.history("C1", { thread: "100.1", oldest: "100.0" });
    const call = asked.find((a) => a.method === "conversations.replies")!;
    assert.equal(call.params.get("ts"), "100.1");
    assert.equal(call.params.get("channel"), "C1");
    assert.deepEqual(lines.map((l) => [l.text, l.mine]), [["parent", false], ["mine", true]]);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("finding 7: Stan's promise to set up a call: no +10 min check of the owner's Zoom; one look near the time, at the calendar", async () => {
  const T = Date.parse("2026-11-16T08:00:00Z");
  const r = rig({ at: T });
  const due = Date.parse("2026-11-17T08:30:00Z"); // 4:30 PM Hong Kong, Tuesday
  await r.say(JSON.stringify({
    loops: [{
      kind: "other_promise", title: "Montar una llamada técnica con Tariq, Rory y Vic", who: "Stan", due: "2026-11-17 16:30", tz: "Asia/Hong_Kong",
      check: "zoomMeeting", hints: ["Tariq", "Rory", "Vic"],
    }],
  }), { channel: "C0SALES", who: "Stan", where: "Stan en #sales", text: "I'll set up a tech call with Tariq, Rory and Vic at 4:30 PM HK" });
  const l = r.stored().loops[0]!;
  assert.ok("calendarEvent" in l.check, "their meeting is never on the owner's Zoom");
  assert.equal(l.nextCheckAt, due - HOUR);
  await r.at(T + 13 * MIN);
  await r.at(T + 3 * HOUR);
  assert.equal(r.cards.length, 0, "nothing ten minutes later");
  await r.at(due - HOUR);
  assert.equal(r.cards.length, 1);
  assert.match(r.cards[0]!, /^🔔 Stan said they would do this: Montar una llamada técnica .*I don't see the invitation in your calendar\./);
  assert.ok(!r.cards[0]!.includes("Zoom"));
  await r.at(due - 5 * MIN);
  assert.equal(r.cards.length, 1, "once");
  // Their invitation on the calendar: nothing said at all.
  const s = rig({ at: T });
  await s.say(JSON.stringify({
    loops: [{ kind: "other_promise", title: "Montar una llamada técnica con Tariq", who: "Stan", due: "2026-11-17 16:30", tz: "Asia/Hong_Kong", check: "zoomMeeting", hints: ["Tariq"] }],
  }), { channel: "C0SALES", who: "Stan", where: "Stan en #sales" });
  s.events.push({ title: "Tech call: Tariq / Rory / Vic", start: due });
  await s.at(due - HOUR);
  assert.equal(s.cards.length, 0);
});

test("finding 8: a night of Slack jobs never pushes a meeting's transcript out of the inbox (follow-up jobs capped, dropped first)", async () => {
  const inbox = createInbox(null);
  const t = Date.parse("2026-11-16T01:00:00Z");
  await inbox.add({ id: "zoom:abc", at: t, text: "", meeting: { topic: "Acmeco", when: "16/11", transcript: "..." } });
  await inbox.add({ id: "mail:1", at: t, text: "", email: { from: "a@b.c", subject: "s", text: "x" } } as Inbound);
  for (let i = 0; i < 80; i++) {
    await inbox.add({ id: `fu:${i.toString(16).padStart(10, "0")}`, at: t + i, text: "", followup: { source: "slack", label: "x", text: "y".repeat(100) } });
  }
  let msgs = await inbox.peek();
  assert.equal(msgs.filter((m) => m.followup).length, 10, "only the newest follow-up jobs wait");
  assert.ok(msgs.some((m) => m.id === "zoom:abc") && msgs.some((m) => m.id === "mail:1"));
  for (let i = 0; i < 45; i++) await inbox.add({ id: `wa:${i}`, at: t + i, text: `hola ${i}` });
  msgs = await inbox.peek();
  assert.equal(msgs.length, 50);
  assert.ok(msgs.some((m) => m.id === "zoom:abc"), "the transcript survives");
  assert.equal(msgs.filter((m) => m.followup).length, 3, "follow-up jobs went first");
});

test("a calendar read in part (one of its sources failed) is no proof the invitation is missing: not said as checked", async () => {
  const T = Date.parse("2026-11-16T08:00:00Z");
  const due = Date.parse("2026-11-17T08:30:00Z");
  const r = rig({ at: T, calendar: async () => ({ events: [], partial: true }) });
  await r.say(JSON.stringify({
    loops: [{ kind: "other_promise", title: "Montar una llamada técnica con Tariq", who: "Stan", due: "2026-11-17 16:30", tz: "Asia/Hong_Kong", check: "zoomMeeting", hints: ["Tariq"] }],
  }), { channel: "C0SALES", who: "Stan", where: "Stan en #sales" });
  await r.at(due - HOUR);
  assert.ok(!r.cards.some((c) => /I don't see the invitation in your calendar/.test(c)), "its calendar may be the one that could not be read");
  // Found in what was read: done, partial or not.
  const s = rig({ at: T, calendar: async () => ({ events: [{ title: "Tech call: Tariq / Rory / Vic", start: due }], partial: true }) });
  await s.say(JSON.stringify({
    loops: [{ kind: "other_promise", title: "Montar una llamada técnica con Tariq", who: "Stan", due: "2026-11-17 16:30", tz: "Asia/Hong_Kong", check: "zoomMeeting", hints: ["Tariq"] }],
  }), { channel: "C0SALES", who: "Stan", where: "Stan en #sales" });
  await s.at(due - HOUR);
  assert.equal(s.cards.length, 0);
});

function reviewRig(alive: boolean) {
  const clock = { now: Date.parse("2026-11-16T10:00:00Z") };
  const queued: Inbound[] = [];
  const told: string[] = [];
  const reviewer = createMeetingReview({
    config: { waitMs: 120 * MIN }, kv: memKv().kv, timeZone: "Europe/Madrid", now: () => clock.now,
    enqueue: async (m) => (queued.push(m), true), notify: async (t) => void told.push(t), bridgeAlive: () => alive,
  });
  return { clock, queued, told, reviewer };
}

test("finding 9: the computer is off or asleep: Zoom's summary is not held for a review (told at once, as before); awake: held", async () => {
  const off = reviewRig(false);
  assert.equal(await off.reviewer.summary({ id: "u1", topic: "Acmeco", at: off.clock.now - HOUR, text: "recap", notice: "🎥 recap" }), false);
  assert.equal(off.queued.length, 0);
  assert.deepEqual(await off.reviewer.read(), []);
  const on = reviewRig(true);
  assert.equal(await on.reviewer.summary({ id: "u1", topic: "Acmeco", at: on.clock.now - HOUR, text: "recap", notice: "🎥 recap" }), true);
  assert.equal(on.queued.length, 1);
});

test("finding 8: a transcript review given up by the bridge (acked zoom:<id>) or lost is told, not left pending for 30 days", async () => {
  const r = reviewRig(true);
  assert.ok(await r.reviewer.transcript({ id: "t1", topic: "Acmeco call", at: r.clock.now - HOUR }));
  await r.reviewer.acked(["zoom:t1"]);
  assert.equal(r.told.length, 1);
  assert.match(r.told[0]!, /Acmeco call/);
  assert.equal((await r.reviewer.read())[0]!.status, "fallback");

  const s = reviewRig(true);
  await s.reviewer.transcript({ id: "t2", topic: "Lost call", at: s.clock.now - HOUR });
  s.clock.now += 3 * HOUR;
  assert.equal(await s.reviewer.sweep(), 0, "a transcript is given longer than Zoom's summary");
  s.clock.now += 22 * HOUR;
  assert.equal(await s.reviewer.sweep(), 1);
  assert.match(s.told[0]!, /Lost call/);
});

test("finding 10: two processes on one store (a deploy's overlap): the loop is claimed, checked and nudged once", async () => {
  const store = memKv();
  const T = Date.parse("2026-11-16T08:00:00Z");
  let release: () => void = () => {};
  let entered = 0;
  const slow = async (): Promise<ZoomSeen[]> => {
    entered++;
    await new Promise<void>((ok) => (release = ok));
    return [];
  };
  const a = rig({ at: T, kv: store, zoom: slow });
  const b = rig({ at: T, kv: store });
  await a.say(SETUP());
  a.clock.now = b.clock.now = T + 13 * MIN;
  const first = a.engine.tick();
  for (let i = 0; i < 50 && !entered; i++) await new Promise((ok) => setTimeout(ok, 5));
  assert.equal(entered, 1, "A is checking");
  const other = await b.engine.tick();
  assert.equal(other.checked, 0, "B finds it claimed");
  release();
  await first;
  assert.equal(a.cards.length + b.cards.length, 1);
  assert.equal(stateOf(JSON.parse(store.m.get(FOLLOWUPS_KEY)!)).budget.n, 1, "the budget spent once");
});

test("the same ask said in two places (Slack, then email) is one loop; another person, kind, time or thing never is", async () => {
  const { sameAsk } = await import("../src/followups/answer.ts");
  const at = Date.parse("2026-11-19T11:00:00Z");
  const a = { who: "Dana Whitlock", title: "Send Dana Whitlock the signed NDA", kind: "request_to_owner", dueAt: at };
  assert.ok(sameAsk(a, { ...a, who: "Dana", title: "Send the signed NDA to Dana Whitlock" }, 15 * MIN));
  assert.ok(sameAsk(a, { ...a, who: "Dana", title: "Send the signed NDA to Dana", dueAt: at + 10 * MIN }, 15 * MIN));
  assert.ok(!sameAsk(a, { ...a, who: "Mira", title: "Send Mira the signed NDA" }, 15 * MIN), "another person");
  assert.ok(!sameAsk(a, { ...a, kind: "owner_promise" }, 15 * MIN), "another kind");
  assert.ok(!sameAsk(a, { ...a, dueAt: at + 2 * HOUR }, 15 * MIN), "another time");
  assert.ok(!sameAsk(a, { ...a, dueAt: undefined }, 15 * MIN), "a time on one only");
  assert.ok(!sameAsk(a, { ...a, title: "Send Dana Whitlock the unsigned NDA" }, 15 * MIN), "another thing");
  assert.ok(!sameAsk({ ...a, title: "Send report 1" }, { ...a, title: "Send report 2" }, 15 * MIN), "a number tells them apart");
  assert.ok(!sameAsk({ ...a, title: "Call Dana" }, { ...a, title: "Call Dana Whitlock" }, 15 * MIN), "one word is too little to go on");
});

test("Pako's own focus block (time to do it) at a meeting's time is not taken for the meeting asked for", async () => {
  const r = rig({ at: Date.parse("2026-11-16T08:00:00Z") });
  await r.say(SETUP());
  // The owner pressed Block on an at-risk card: "Focus: …" goes on the calendar at the free time, which is the meeting's time (still unset up).
  r.events.push({ title: "Focus: Send Ana the Q4 deck", start: DUE, created: r.clock.now + MIN });
  await r.at("2026-11-16T08:11:00Z");
  assert.equal(r.stored().loops[0]!.status, "open", "a focus block is no meeting with them");
  assert.equal(r.cards.length, 1, "the nudge goes");
});
