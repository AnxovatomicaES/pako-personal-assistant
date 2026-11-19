// Quality from day one: the rehearsal (src/rehearsal.ts) runs the follow-ups and the brief in a dry run on what Pako already keeps and shows
// what it WOULD have said, changing nothing; the quiet 👍/👎 on nudges and the brief (src/quality.ts); the Calidad card's numbers and the one
// Monday line. Engine by engine with fakes, then through the real door (src/whatsapp.ts). Nothing here reaches the network.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import type { BriefDoc, Gathered } from "../src/brief-v2.ts";
import { createFollowups, FOLLOWUPS_KEY, type CardFeedback, type FollowupsConfig } from "../src/followups.ts";
import type { Kv } from "../src/kv.ts";
import { createLocalChannel } from "../src/local.ts";
import { createQuality, FEEDBACK_KEY, poorPrecision, statsOf, verdictOfText } from "../src/quality.ts";
import { createRehearsal, JOBS_MAX, REHEARSAL_KEY } from "../src/rehearsal.ts";
import type { SlackAlert } from "../src/slack.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";
import { loadWhatsappConfig, mountWhatsapp, type Inbound } from "../src/whatsapp.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Monday 16 November 2026, 09:30 in Madrid. */
const T0 = Date.parse("2026-11-16T08:30:00Z");
const ASK = "samir@acmeco.example Maya Chen Stan myself for meeting at 5:15 AM ET Today — can you set it up pls";
const EXTRACTED = JSON.stringify({
  loops: [{
    kind: "request_to_owner", title: "Montar la reunión con samir@acmeco.example, Maya Chen y Stan", who: "Rohan",
    due: "2026-11-16 05:15", tz: "America/New_York", check: "zoomMeeting", hints: ["samir@acmeco.example", "Maya Chen", "Stan"],
  }],
});
const CONFIG: FollowupsConfig = { delayMs: 10 * MIN, maxPerDay: 6, batchMs: 3 * MIN, quiet: null };

function memKv() {
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  return { kv, m };
}

function rig(o: { quality?: ReturnType<typeof createQuality> } = {}) {
  const clock = { now: T0 };
  const store = memKv();
  const queued: Inbound[] = [];
  const cards: { body: string; buttons: { id: string; title: string }[]; feedback?: CardFeedback }[] = [];
  const engine = createFollowups({
    config: CONFIG, kv: store.kv, timeZone: "Europe/Madrid", now: () => clock.now,
    enqueue: async (m) => (queued.push(m), true),
    card: async (body, buttons, feedback) => (cards.push({ body, buttons, ...(feedback ? { feedback } : {}) }), true),
    notify: async () => undefined,
    zoom: async () => [],
    ...(o.quality ? { quality: o.quality.followups } : {}),
  });
  return { clock, store, queued, cards, engine };
}

const rohan = (at: number) => ({ channel: "D0ROHAN", ts: String(at / 1000), at, who: "Rohan", where: "Rohan (privado)", direct: true, text: ASK });

test("quality: an English yes or no (and the thumbs) are verdicts; anything longer, or Spanish words, are not", () => {
  for (const yes of ["yes", "Yes!", "useful", "👍"]) assert.equal(verdictOfText(yes), "up", yes);
  for (const no of ["no", "No.", "not useful", "👎"]) assert.equal(verdictOfText(no), "down", no);
  // Like every command, the answer to "Useful?" is English: a Spanish "sí" is an ordinary message for the assistant.
  for (const other of ["sí", "útil", "no útil", "no sé", "yes, call her", "ok", "", "not today"]) assert.equal(verdictOfText(other), null, other);
});

test("quality: the week's numbers count each nudge once (Done, Not mine, ignored after 12 h) and poor precision needs 3 sent, 2 bad, a third", () => {
  const t = T0;
  const s = {
    nudges: [
      { at: t - 2 * HOUR, ref: "a000000001", what: "A", outcome: "done" as const },
      { at: t - 20 * HOUR, ref: "a000000002", what: "B", outcome: "notmine" as const },
      { at: t - 30 * HOUR, ref: "a000000003", what: "C" },
      { at: t - 1 * HOUR, ref: "a000000004", what: "D" },
      { at: t - 8 * 24 * HOUR, ref: "a000000005", what: "old", outcome: "notmine" as const },
    ],
    verdicts: [
      { at: t - 29 * HOUR, ref: "a000000003", what: "C", verdict: "down" as const, source: "nudge" as const },
      { at: t - 3 * HOUR, ref: "b000000001", what: "brief", verdict: "up" as const, source: "brief" as const },
      { at: t - 3 * HOUR, ref: "b000000001.t0", what: "todo", verdict: "down" as const, source: "brief_todo" as const },
    ],
  };
  const q = statsOf(s, t);
  assert.deepEqual(q.nudges, { sent: 4, done: 1, notMine: 1, snoozed: 0, ignored: 0, up: 0, down: 1 }, "C was answered with 👎; D is too fresh to be ignored");
  assert.deepEqual(q.brief, { up: 1, down: 1 });
  assert.equal(q.unhelpful, 2);
  assert.equal(poorPrecision(q), true);
  assert.equal(poorPrecision({ ...q, unhelpful: 1 }), false);
  assert.equal(poorPrecision({ ...q, nudges: { ...q.nudges, sent: 7 } }), false, "2 of 7 is not a third");
});

test("quality: the Monday line comes on Mondays only, when the week did poorly, in English", async () => {
  const store = memKv();
  const clock = { now: T0 };
  const q = createQuality({ kv: store.kv, timeZone: "Europe/Madrid", now: () => clock.now });
  assert.equal(await q.monday(), null, "nothing sent: nothing said");
  for (const id of ["c000000001", "c000000002", "c000000003", "c000000004"]) q.followups.nudged({ id, title: `T ${id}` }, true);
  q.followups.pressed("3", { id: "c000000001", title: "x" });
  q.followups.pressed("3", { id: "c000000002", title: "x" });
  await q.read();
  assert.equal(await q.monday(), "2 of 4 reminders weren't useful to you: tell me what to ignore.");
  clock.now = T0 + 24 * HOUR;
  assert.equal(await q.monday(), null, "a Tuesday says nothing");
  const kept = JSON.parse(store.m.get(FEEDBACK_KEY)!);
  assert.equal(kept.nudges.length, 4);
});

test("quality: a typed yes answers only the card or brief sent last; anything sent or written in between forgets the question", async () => {
  const q = createQuality({ kv: memKv().kv, timeZone: "Europe/Madrid", now: () => T0 });
  assert.equal(await q.answerText("no"), null, "nothing asked: a plain no");
  q.followups.nudged({ id: "d000000001", title: "Montar la reunión" }, true);
  assert.equal(await q.answerText("no"), "Noted 👎. If something like it isn't yours, press “Not mine” and I won't say it again.");
  assert.equal(await q.answerText("no"), null, "answered once");
  q.followups.nudged({ id: "d000000002", title: "Otra" }, true);
  q.clearAsk(); // Pako sent something else
  assert.equal(await q.answerText("yes"), null);
  q.followups.nudged({ id: "d000000003", title: "Kept as a notice" }, false);
  assert.equal(await q.answerText("yes"), null, "a card kept for later was not read yet");
  q.briefAsked({ id: "e000000001", day: "2026-11-16" });
  assert.equal(await q.answerText("👍"), "Noted 👍");
  const verdicts = (await q.read()).verdicts;
  assert.deepEqual(verdicts.map((v) => [v.source, v.ref, v.verdict, v.what]), [
    ["nudge", "d000000001", "down", "Montar la reunión"], ["brief", "e000000001", "up", "brief of 2026-11-16"],
  ]);
});

test("followups: the nudge card keeps its three buttons and carries a quiet 👍/👎; nudges and presses are counted for the Calidad card", async () => {
  const quality = createQuality({ kv: memKv().kv, timeZone: "Europe/Madrid", now: () => T0 });
  const r = rig({ quality });
  await r.engine.observeSlack(rohan(T0));
  r.clock.now += 3 * MIN;
  await r.engine.tick();
  const id = /^fu:(.+)$/.exec(r.queued[0]!.id)![1]!;
  await r.engine.result(id, EXTRACTED);
  r.clock.now = T0 + 10 * MIN;
  await r.engine.tick();
  const card = r.cards[0]!;
  assert.deepEqual(card.buttons.map((b) => b.title), ["Done", "In 1 h", "Not mine"]);
  assert.deepEqual(card.feedback?.buttons.map((b) => b.title), ["👍", "👎"]);
  assert.match(card.feedback!.buttons[0]!.id, /^g1:[0-9a-f]{10}$/);
  assert.equal(card.feedback?.line, "Useful? Reply yes or no.");
  await r.engine.press("3", card.buttons[2]!.id.slice(3));
  await quality.read();
  const q = await quality.stats();
  assert.equal(q.nudges.sent, 1);
  assert.equal(q.nudges.notMine, 1);
});

test("rehearsal (engine): a draft is the real job's text; its dry answer says what would be nudged, and the record is left exactly as it was", async () => {
  const r = rig();
  const { job, text } = await r.engine.rehearse.draft({
    source: "slack", channel: "D0ROHAN", where: { type: "slack_dm", label: "Rohan (privado)", channel: "D0ROHAN" },
    msgs: [{ ts: String(T0 / 1000), at: T0, who: "Rohan", text: ASK }],
  });
  assert.match(text, /Now: 2026-11-16 09:30 \(Europe\/Madrid\)/);
  assert.match(text, /\* \[2026-11-16 09:30\] Rohan: samir@acmeco\.example/);
  assert.equal(r.queued.length, 0, "nothing queued");
  const before = r.store.m.get(FOLLOWUPS_KEY);
  const out = await r.engine.rehearse.dryAnswer(job, EXTRACTED);
  assert.ok(out);
  assert.equal(out.items.length, 1);
  const item = out.items[0]!;
  assert.equal(item.outcome, "nudge");
  assert.equal(item.check, "zoomMeeting");
  assert.equal(item.seen, "I don't see it in your Zoom.");
  assert.match(item.text!, /^🔔 Rohan asked you to montar la reunión .*\(11:15 Madrid\)\. I don't see it in your Zoom\./);
  assert.match(item.source, /^Slack · Rohan \(privado\)/);
  assert.equal(r.store.m.get(FOLLOWUPS_KEY), before, "no loop kept, no job, no budget");
  assert.equal(r.cards.length, 0, "nothing sent");
  assert.equal(await r.engine.rehearse.dryAnswer(job, "not json"), null);

  // A real loop already open for it: the rehearsal says it is followed, and makes no second one.
  await r.engine.observeSlack(rohan(T0));
  r.clock.now += 3 * MIN;
  await r.engine.tick();
  await r.engine.result(/^fu:(.+)$/.exec(r.queued[0]!.id)![1]!, EXTRACTED);
  const again = await r.engine.rehearse.dryAnswer(job, EXTRACTED);
  assert.equal(again?.items.length, 0);
  assert.deepEqual(again?.merged, ["Montar la reunión con samir@acmeco.example, Maya Chen y Stan"]);
});

function rehearsalRig(o: { alerts?: SlackAlert[]; alive?: boolean } = {}) {
  const r = rig();
  const store = memKv();
  const queued: Inbound[] = [];
  const dropped: string[] = [];
  const gathered: Gathered = { facts: [{ id: "L1", kind: "loop", icon: "slack", label: "Slack · Rohan", text: "Rohan te pidió montar la reunión" }], read: ["slack"], unread: [] };
  const reh = createRehearsal({
    kv: store.kv, timeZone: "Europe/Madrid", now: () => r.clock.now,
    enqueue: async (m) => (queued.push(m), true),
    drop: async (ids) => void dropped.push(...ids),
    bridgeAlive: () => o.alive ?? true,
    followups: () => r.engine.rehearse,
    brief: () => ({ draft: async () => ({ gathered, text: "facts" }), chat: (doc: BriefDoc) => `Buenos días. ${doc.opening}` }),
    slack: async () => o.alerts ?? [],
    mail: async () => [
      { id: "m1", at: T0 - HOUR, from: "a@b.c", subject: "Contrato", preview: "", kind: "aviso", summary: "Te piden firmar el contrato hoy." },
      { id: "m2", at: T0 - HOUR, from: "n@b.c", subject: "News", preview: "", kind: "masivo", summary: "x" },
      { id: "m3", at: T0 - 3 * 24 * HOUR, from: "a@b.c", subject: "Viejo", preview: "", kind: "aviso", summary: "old" },
    ],
    meetings: async () => [{ id: "z1", topic: "Weekly sync", at: T0 - 2 * HOUR, summary: "Marta enviará el informe el jueves." }],
  });
  return { r, store, queued, dropped, reh };
}

test("rehearsal: 48 h of kept Slack (one job per conversation), the mail told about, the meetings, and today's brief; capped at 20; never twice at once", async () => {
  const alerts: SlackAlert[] = [];
  for (let i = 0; i < 25; i++) {
    const ch = `D0PERSON${String(i).padStart(2, "0")}`;
    alerts.push({ at: T0 - (i + 1) * MIN, where: `P${i} (privado)`, text: `ask ${i}`, channel: ch, ts: String((T0 - (i + 1) * MIN) / 1000), who: `P${i}`, direct: true });
  }
  alerts.push({ at: T0 - 30 * MIN, where: "P0 (privado)", text: "another in the same conversation", channel: "D0PERSON00", ts: String((T0 - 30 * MIN) / 1000), who: "P0" });
  alerts.push({ at: T0 - 50 * HOUR, where: "Old (privado)", text: "too old", channel: "D0OLD", ts: "1" });
  const x = rehearsalRig({ alerts });
  const started = await x.reh.start();
  assert.equal(started.started, true);
  assert.match(started.text, /^Rehearsal under way: 19 dry read\(s\) \(the 19 most recent\) of what came in over the last 48 h and today's brief\./);
  assert.equal(x.queued.length, JOBS_MAX);
  assert.equal(x.queued.filter((m) => /^rh:[0-9a-f]{10}$/.test(m.id) && m.followup && m.text === "").length, 19);
  assert.equal(x.queued.filter((m) => /^rb:[0-9a-f]{10}$/.test(m.id) && m.brief?.kind === "brief").length, 1);
  const p0 = x.queued.find((m) => m.followup?.label === "P0 (privado)")!;
  assert.match(p0.followup!.text, /ask 0[\s\S]*another in the same conversation|another in the same conversation[\s\S]*ask 0/, "one job for the whole conversation");
  const view = await x.reh.view();
  assert.deepEqual(view.run?.found, { slack: 25, mail: 1, meeting: 1 }, "the old alert, the mass mail and the old email are not read");
  assert.equal(view.running, true);
  assert.deepEqual(await x.reh.start(), { started: false, text: "A rehearsal is already under way: see it in the panel (“Rehearsal”)." });
  assert.equal(x.r.cards.length, 0);
  assert.equal(x.r.store.m.get(FOLLOWUPS_KEY), undefined, "the follow-ups' record is never written");
});

test("rehearsal: answers are read as real ones and kept for the page; an older bridge's acknowledgement says to update it; a new run takes back the old jobs", async () => {
  const x = rehearsalRig({
    alerts: [{ at: T0 - 5 * MIN, where: "Rohan (privado)", text: ASK }], // an older alert: no channel id, read without its history
  });
  await x.reh.start();
  const ids = x.queued.map((m) => m.id);
  const slackJob = x.queued.find((m) => m.followup?.label === "Rohan (privado)")!;
  assert.deepEqual(await x.reh.answer(slackJob.id, EXTRACTED), { ok: true });
  assert.deepEqual(await x.reh.answer(slackJob.id, EXTRACTED), { ok: false }, "answered once");
  const doc = JSON.stringify({ opening: "Un día tranquilo.", focus: null, todos: [{ title: "Montar la reunión", context: "", checked: "", sources: ["L1"] }], updates: [], day: [] });
  const briefJob = x.queued.find((m) => m.brief)!;
  assert.deepEqual(await x.reh.answer(briefJob.id, doc), { ok: true });
  await x.reh.acked(ids); // the bridge acknowledges each after answering: the answered stay done; the rest were let go
  const view = await x.reh.view();
  const jobs = view.run!.jobs;
  const slack = jobs.find((j) => j.kind === "slack")!;
  assert.equal(slack.status, "done");
  assert.equal(slack.outcome?.items[0]?.outcome, "nudge");
  assert.equal(slack.outcome?.items[0]?.check, "zoomMeeting");
  const brief = jobs.find((j) => j.kind === "brief")!;
  assert.equal(brief.status, "done");
  assert.equal(brief.chat, "Buenos días. Un día tranquilo.");
  assert.deepEqual(brief.brief?.todos.map((t) => t.title), ["Montar la reunión"]);
  assert.deepEqual(jobs.filter((j) => j.status === "unread").map((j) => j.kind).sort(), ["mail", "meeting"], "acknowledged without an answer: an older bridge");
  assert.equal(view.running, false);
  assert.ok(x.store.m.get(REHEARSAL_KEY));
  // A new run: the old one's jobs still queued are taken back out of the inbox.
  const y = rehearsalRig({ alerts: [{ at: T0 - 5 * MIN, where: "Rohan (privado)", text: ASK }] });
  await y.reh.start();
  y.r.clock.now += 31 * MIN;
  assert.equal((await y.reh.view()).run!.jobs.every((j) => j.status === "failed"), true, "no answer in 30 minutes: given up");
  await y.reh.start();
  assert.equal(y.dropped.length, 4);
});

const ENV = {
  WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
};

test("the door: WhatsApp's card has three buttons and the ¿Útil? line; a typed no right after is kept; 👍 by button; ENSAYO; rh: answers and acks", async () => {
  const sent: Record<string, any>[] = [];
  const clock = { now: T0 };
  const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out${sent.length}` }] }));
  }) as typeof fetch;
  const config = loadWhatsappConfig(ENV, "+34600111222").config!;
  const memory = loadMemory(null);
  const tools = loadVoiceTools({ memory, actions: { contacts: () => [], callContact: async () => ({ ok: true, text: "x" }), lookupCall: async () => "ok" } });
  const quality = createQuality({ kv: null, timeZone: "Europe/Madrid", now: () => clock.now });
  const ref: { engine: ReturnType<typeof createFollowups> | null; reh: ReturnType<typeof createRehearsal> | null } = { engine: null, reh: null };
  const answers: string[] = [];
  const acks: string[] = [];
  const app = express();
  const wa = mountWhatsapp(app, {
    config, tools, memory, kv: null, ownerName: "Marta", timeZone: "Europe/Madrid", contacts: () => [], contactByName: () => null, fetch: fake,
    now: () => clock.now,
    followups: {
      press: (b, id) => ref.engine!.press(b, id),
      command: () => ref.engine!.command(),
      context: () => ref.engine!.context(),
      result: (id, raw) => ref.engine!.result(id, raw),
      offer: (o) => ref.engine!.offer(o),
    },
    quality: {
      press: (id) => quality.press(id, async (_k, r) => (await ref.engine!.read()).loops.find((l) => l.id === r)?.title ?? null),
      answerText: (t) => quality.answerText(t),
      clearAsk: quality.clearAsk,
    },
    rehearsal: {
      start: async () => ({ text: "Ensayo en marcha." }),
      answer: async (id) => (answers.push(id), { ok: true }),
      acked: async (ids) => void acks.push(...ids),
    },
  });
  ref.engine = createFollowups({
    config: CONFIG, kv: null, timeZone: "Europe/Madrid", now: () => clock.now, quality: quality.followups,
    enqueue: (m) => wa.inbox.add(m), card: (b, bt, fb) => wa.sendCard(b, bt, fb), notify: (t) => wa.notifyOwner(t), zoom: async () => [],
  });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let n = 0;
  const hook = (msg: Record<string, unknown>) => {
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: config.phoneNumberId }, messages: [msg] } }] }],
    });
    const sig = `sha256=${createHmac("sha256", config.appSecret).update(raw).digest("hex")}`;
    return fetch(`${base}/whatsapp/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body: raw });
  };
  const text = (body: string) => hook({ from: "34600111222", id: `wamid.q${++n}`, timestamp: "1", type: "text", text: { body } });
  const press = (id: string) => hook({ from: "34600111222", id: `wamid.q${++n}`, timestamp: "1", type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: "x" } } });
  const bridge = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${config.bridgeToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const nudge = async () => {
    await ref.engine!.observeSlack({ ...rohan(clock.now), ts: String(clock.now / 1000) });
    clock.now += 3 * MIN;
    await ref.engine!.tick();
    const job = (await wa.inbox.peek()).find((m) => m.followup)!;
    await bridge("/assistant/followups", { id: job.id, text: EXTRACTED });
    await wa.inbox.ack([job.id]);
    clock.now += 10 * MIN;
    await ref.engine!.tick();
    return sent.filter((s) => s.type === "interactive").at(-1)!;
  };
  try {
    await text("hola");
    await wa.inbox.ack((await wa.inbox.peek()).map((m) => m.id));
    const card = await nudge();
    assert.equal(card.interactive.action.buttons.length, 3, "WhatsApp: three buttons at most");
    assert.match(card.interactive.body.text, /\nUseful\? Reply yes or no\.$/);
    await text("no");
    assert.match(sent.at(-1)!.text.body, /^Noted 👎/);
    assert.equal((await wa.inbox.peek()).length, 0, "the no did not go to the assistant");
    await text("no");
    assert.equal((await wa.inbox.peek()).filter((m) => m.text === "no").length, 1, "a second no is an ordinary message");
    await wa.inbox.ack((await wa.inbox.peek()).map((m) => m.id));
    const loopId = /^f1:(.+)$/.exec(card.interactive.action.buttons[0].reply.id)![1]!;
    await press(`g1:${loopId}`);
    assert.equal(sent.at(-1)!.text.body, "Noted 👍");
    const verdicts = (await quality.read()).verdicts;
    assert.deepEqual(verdicts.map((v) => v.verdict), ["up"], "the button changed the first verdict on the same nudge");
    await text("REHEARSAL");
    assert.equal(sent.at(-1)!.text.body, "Ensayo en marcha.");
    assert.deepEqual(await (await bridge("/assistant/followups", { id: "rh:0123456789", text: "{}" })).json(), { ok: true });
    assert.deepEqual(await (await bridge("/assistant/brief", { id: "rb:0123456789", text: "{}" })).json(), { ok: true });
    assert.deepEqual(answers, ["rh:0123456789", "rb:0123456789"]);
    await wa.inbox.add({ id: "rh:abcdefabcd", at: clock.now, text: "", followup: { source: "slack", label: "x", text: "y" } });
    await bridge("/assistant/ack", { ids: ["rh:abcdefabcd"], papers: 1, briefs: 1 });
    assert.deepEqual(acks, ["rh:abcdefabcd"]);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("the inbox: a rehearsal's 20 jobs never push out a real follow-up job, and go first when the inbox is full", async () => {
  const config = loadWhatsappConfig(ENV, "+34600111222").config!;
  const memory = loadMemory(null);
  const tools = loadVoiceTools({ memory, actions: { contacts: () => [], callContact: async () => ({ ok: true, text: "x" }), lookupCall: async () => "ok" } });
  const wa = mountWhatsapp(express(), {
    config, tools, memory, kv: null, ownerName: "Marta", timeZone: "Europe/Madrid", contacts: () => [], contactByName: () => null,
    fetch: (async () => new Response("{}")) as typeof fetch,
  });
  const job = (id: string) => ({ id, at: T0, text: "", followup: { source: "slack" as const, label: "x", text: "y" } });
  for (let i = 0; i < 10; i++) await wa.inbox.add(job(`fu:${String(i).padStart(10, "0")}`));
  for (let i = 0; i < 25; i++) await wa.inbox.add(job(`rh:${String(i).padStart(10, "0")}`));
  const held = await wa.inbox.peek();
  assert.equal(held.filter((m) => m.id.startsWith("fu:")).length, 10);
  assert.equal(held.filter((m) => m.id.startsWith("rh:")).length, 20);
  for (let i = 0; i < 25; i++) await wa.inbox.add({ id: `own${i}`, at: T0, text: `hola ${i}` });
  const full = await wa.inbox.peek();
  assert.equal(full.length, 50);
  assert.equal(full.filter((m) => m.id.startsWith("own")).length, 25, "the owner's own messages stay");
  assert.equal(full.filter((m) => m.id.startsWith("fu:")).length, 10, "the real jobs stay");
  assert.equal(full.filter((m) => m.id.startsWith("rh:")).length, 15, "the rehearsal's went first");
});

test("the panel's chat has room: the nudge card shows its three buttons and then 👍 and 👎, with no ¿Útil? line", async () => {
  const config = loadWhatsappConfig(ENV, "+34600111222").config!;
  const memory = loadMemory(null);
  const tools = loadVoiceTools({ memory, actions: { contacts: () => [], callContact: async () => ({ ok: true, text: "x" }), lookupCall: async () => "ok" } });
  const channel = createLocalChannel({ kv: null, now: () => T0 });
  const wa = mountWhatsapp(express(), {
    config, tools, memory, kv: null, ownerName: "Marta", timeZone: "Europe/Madrid", contacts: () => [], contactByName: () => null, local: channel,
    fetch: (async () => { throw new Error("no network in local mode"); }) as typeof fetch,
  });
  const quality = createQuality({ kv: null, timeZone: "Europe/Madrid", now: () => T0 });
  const fb = quality.followups.ask({ id: "f000000001", title: "x" }, "en");
  assert.equal(await wa.sendCard("🔔 Rohan asked you for something.", [
    { id: "f1:f000000001", title: "Done" }, { id: "f2:f000000001", title: "In 1 h" }, { id: "f3:f000000001", title: "Not mine" },
  ], fb), true);
  const shown = (await channel.list(0)).at(-1)!;
  assert.equal(shown.text, "🔔 Rohan asked you for something.");
  assert.deepEqual(shown.buttons?.map((b) => b.title), ["Done", "In 1 h", "Not mine", "👍", "👎"]);
});
