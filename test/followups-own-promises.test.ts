// The owner's own promises (one-job audit §1): what they promise in Slack reaches the follow-ups (never told back to them), and what they
// promise in the chat with Pako is kept as their own loop at once, with its person and time, a receipt and Undo.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { parseReply } from "../assistant/bridge.ts";
import { createControl } from "../src/control.ts";
import { createFollowups, FOLLOWUPS_KEY, followupsProxy, type SlackSeen } from "../src/followups.ts";
import type { Kv } from "../src/kv.ts";
import { mountSlack } from "../src/slack.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";
import { loadWhatsappConfig, mountWhatsapp } from "../src/whatsapp.ts";
import type { Inbound } from "../src/whatsapp.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-11-16T09:00:00Z"); // Mon 09:00 London
type Body = Record<string, any>;

function memKv() {
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  return { kv, m };
}
function engineRig() {
  const clock = { now: T0 };
  const store = memKv();
  const queued: Inbound[] = [];
  const cards: string[] = [];
  const engine = createFollowups({
    config: { delayMs: 10 * MIN, maxPerDay: 6, batchMs: 3 * MIN, quiet: { start: 23 * 60, end: 8 * 60 } },
    kv: store.kv, timeZone: "Europe/London", now: () => clock.now, enqueue: async (m) => (queued.push(m), true),
    card: async (body) => (cards.push(body), true), notify: async () => undefined,
  });
  return { clock, store, queued, cards, engine };
}

test("chat: a promise is the owner's own loop with its person and time; said again it is not kept twice; Undo drops it", async () => {
  const r = engineRig();
  const l = await r.engine.fromChat({ title: "Send Ana the Q4 deck", who: "Ana", due: "2026-11-20 17:00", ref: "wamid.x" });
  assert.ok(l);
  assert.equal(l.kind, "owner_promise");
  assert.equal(l.who, "Ana");
  assert.equal(l.dueAt, Date.parse("2026-11-20T17:00:00Z"));
  assert.equal(l.sources[0]!.kind, "chat");
  assert.equal(l.where.type, "chat");
  assert.equal(await r.engine.fromChat({ title: "send Ana the Q4 deck", who: "Ana" }), null, "the same thing open is not kept twice");
  assert.equal(await r.engine.fromChat({ title: "ok" }), null, "too short to be a promise");
  assert.match((await r.engine.command()), /Send Ana the Q4 deck.*you told me/s);
  assert.deepEqual(await r.engine.dropFromChat([l.id]), [l.id]);
  assert.deepEqual((await r.engine.read()).loops, []);
});

test("chat: the promise is nudged once before its time, saying the owner told Pako", async () => {
  const r = engineRig();
  await r.engine.fromChat({ title: "Send Ana the Q4 deck", who: "Ana", due: "2026-11-16 17:00" });
  r.clock.now = Date.parse("2026-11-16T15:01:00Z");
  await r.engine.tick();
  assert.equal(r.cards.length, 1);
  assert.match(r.cards[0]!, /Send Ana the Q4 deck/);
});

test("Slack: the owner's own message is batched with its conversation, marked YOU in the job, and the conversation keeps the other side's name", async () => {
  const r = engineRig();
  const own: SlackSeen = { channel: "D0ANA", ts: "1763283600.000100", at: T0, who: "Alex", where: "Ana (private)", direct: true, text: "I'll send you the Q4 deck by Friday", mine: true };
  await r.engine.observeSlack(own);
  r.clock.now += 3 * MIN;
  await r.engine.tick();
  const job = r.queued.at(-1)!;
  assert.ok(job.followup);
  assert.match(job.followup!.text, /\* \[[^\]]+\] YOU: I'll send you the Q4 deck by Friday/);
  assert.match(job.followup!.label, /Ana \(private\)/);
});

test("Slack's reader: the owner's own DM goes to the follow-ups (never to the owner), a channel post naming no one does not", async () => {
  const SECRET = "s".repeat(32);
  const fake = (async (input: string | URL | Request) => {
    const method = new URL(String(input)).pathname.split("/").pop()!;
    const json = (b: unknown) => new Response(JSON.stringify(b));
    if (method === "auth.test") return json({ ok: true, user_id: "UME" });
    if (method === "users.info") return json({ ok: true, user: { profile: { display_name: new URL(String(input)).searchParams.get("user") === "UME" ? "Alex" : "Ana" } } });
    if (method === "conversations.info") return json({ ok: true, channel: { user: "UANA", name: "general" } });
    return json({ ok: false, error: "unknown_method" });
  }) as typeof fetch;
  const seen: SlackSeen[] = [];
  const told: string[] = [];
  const app = express();
  mountSlack(app, {
    config: { token: "xoxp-test", signingSecret: SECRET, quiet: null, forward: true }, kv: null, timeZone: "Europe/London",
    notify: async (t) => void told.push(t), fetch: fake, observe: (m) => void seen.push(m as SlackSeen), batchMs: 10, retryMs: 10,
  });
  const server = createServer(app);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = async (id: string, event: Body) => {
    const body = JSON.stringify({ type: "event_callback", event_id: id, event });
    const ts = Math.floor(Date.now() / 1000);
    const sig = `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
    const res = await fetch(`${base}/slack/events`, { method: "POST", headers: { "content-type": "application/json", "x-slack-request-timestamp": String(ts), "x-slack-signature": sig }, body });
    assert.equal(res.status, 200);
  };
  try {
    await send("Ev1", { type: "message", channel: "D0ANA", channel_type: "im", user: "UME", text: "I'll send you the deck by Friday", ts: "200.1" });
    await send("Ev2", { type: "message", channel: "C0GEN", channel_type: "channel", user: "UME", text: "lunch is here", ts: "200.2" });
    await send("Ev3", { type: "message", channel: "C0GEN", channel_type: "channel", user: "UME", text: "<@UANA> I'll review it tomorrow", ts: "200.3" });
    for (let i = 0; i < 50 && seen.length < 2; i++) await new Promise((ok) => setTimeout(ok, 20));
    await new Promise((ok) => setTimeout(ok, 60));
    assert.deepEqual(seen.map((m) => [m.ts, m.mine, m.where, m.who]), [
      ["200.1", true, "Ana (private)", "Alex"],
      ["200.3", true, "you in #general", "Alex"],
    ]);
    assert.equal(seen[1]!.text, "@Ana I'll review it tomorrow");
    assert.deepEqual(told, [], "the owner is never told their own message");
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("the tag: <promise> with its person and time, at most two, removed from the text", () => {
  const p = parseReply('I\'ll keep an eye on it.<promise who="Ana" due="2026-11-20 17:00">send Ana the deck</promise><promise>a</promise><promise>b</promise>');
  assert.equal(p.text, "I'll keep an eye on it.");
  assert.deepEqual(p.promises, [{ text: "send Ana the deck", who: "Ana", due: "2026-11-20 17:00" }, { text: "a" }]);
});

const ENV = {
  WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
};

test("door: «I'll send Ana the deck by Friday 17:00» is kept with a receipt; Undo drops it", async () => {
  const fu = engineRig();
  const sent: Body[] = [];
  const meta = (async (_u: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Body);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out${sent.length}` }] }), { status: 200 });
  }) as typeof fetch;
  const { kv } = memKv();
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
  const post = async (body: unknown) => (await fetch(`${base}/assistant/reply`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) })).status;
  const texts = () => sent.map((b) => (b.type === "text" ? b.text.body : `${b.interactive.body.text}`) as string);
  let n = 0;
  const hook = async (msg: Body) => {
    const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp", metadata: { phone_number_id: config.phoneNumberId }, messages: [{ from: "447700900123", id: `wamid.o${++n}`, timestamp: "1", ...msg }],
    } }] }] });
    const signature = `sha256=${createHmac("sha256", config.appSecret).update(raw).digest("hex")}`;
    await fetch(`${base}/whatsapp/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature }, body: raw });
  };
  try {
    await hook({ type: "text", text: { body: "I'll send Ana the deck by Friday 17:00" } });
    assert.equal(await post({ text: "Got it, I'll keep an eye on it.", promises: [{ text: "Send Ana the Q4 deck", who: "Ana", due: "2026-11-20 17:00" }], key: "k-p1" }), 200);
    assert.equal(texts().at(-1), "📌 I'll keep an eye on it: “Send Ana the Q4 deck” · for Fri 20 Nov, 17:00");
    const loops = JSON.parse(fu.store.m.get(FOLLOWUPS_KEY)!).loops as { title: string; status: string }[];
    assert.deepEqual(loops.map((l) => [l.title, l.status]), [["Send Ana the Q4 deck", "open"]]);
    const card = [...sent].reverse().find((b) => b.type === "interactive")!;
    await hook({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: String(card.interactive.action.buttons[0].reply.id), title: "x" } } });
    assert.match(texts().at(-1)!, /stopped following “Send Ana the Q4 deck”/);
    assert.deepEqual(JSON.parse(fu.store.m.get(FOLLOWUPS_KEY)!).loops, []);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
