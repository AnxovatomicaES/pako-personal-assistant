// Bugs found in the chat and assistant core (the door's cards and STOP, the bridge's marking of a turn that read outside text, the person
// card), each pinned by a test that failed before its fix.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import express from "express";
import { createBridge, type BridgeConfig, type ClaudeResult } from "../assistant/bridge.ts";
import { createCalendarWrites } from "../src/calendar-writes.ts";
import { createControl } from "../src/control.ts";
import type { Kv } from "../src/kv.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";
import { loadWhatsappConfig, mountWhatsapp } from "../src/whatsapp.ts";

type Body = Record<string, any>;
const MIN = 60_000;
const T0 = Date.parse("2026-11-16T09:00:00Z");
const OWNER = "+447700900123";
const OWNER_WA = "447700900123";
const ENV = {
  WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
};

function memKv(): Kv & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

/** The door on WhatsApp, with the Mac's calendar writes, a webhook to write to it and the bridge's reply route. */
async function doorRig(o: { seed?: (kv: Kv & { m: Map<string, string> }) => void } = {}) {
  const sent: Body[] = [];
  const meta = (async (_u: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Body);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out${sent.length}` }] }), { status: 200 });
  }) as typeof fetch;
  const clock = { now: T0 };
  const kv = memKv();
  o.seed?.(kv);
  const writes = createCalendarWrites({ kv, now: () => clock.now, onResult: async () => undefined });
  const event = { eventId: "E1", at: T0 + 60 * MIN, start: T0 + 60 * MIN, end: T0 + 90 * MIN, title: "Dentist", calendarId: "C1" };
  const memory = loadMemory(kv);
  const tools = loadVoiceTools({ memory, actions: { contacts: () => ["Ana"], callContact: async () => ({ ok: true, text: "started" }), lookupCall: async () => "ok" } });
  const config = loadWhatsappConfig(ENV, OWNER).config!;
  const app = express();
  const control = createControl(kv, () => clock.now);
  const door = mountWhatsapp(app, {
    config, tools, memory, kv, control, ownerName: "Alex", timeZone: "Europe/London", contacts: () => ["Ana"],
    fetch: meta, now: () => clock.now, callCheckMs: 5, receiptWaitMs: 60_000,
    calendarWrites: { canWrite: async () => true, find: async (title, start) => (start === event.start && /dentist/i.test(title) ? event : null), enqueue: writes.enqueue, get: writes.get },
  });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { authorization: `Bearer ${config.bridgeToken}`, "content-type": "application/json" };
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
  let n = 0;
  const hook = async (msg: Body) => {
    const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp", metadata: { phone_number_id: config.phoneNumberId }, messages: [{ from: OWNER_WA, id: `wamid.h${++n}`, timestamp: String(T0 / 1000), ...msg }],
    } }] }] });
    const signature = `sha256=${createHmac("sha256", config.appSecret).update(raw).digest("hex")}`;
    await fetch(`${base}/whatsapp/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature }, body: raw });
  };
  const say = (body: string) => hook({ type: "text", text: { body } });
  const pressId = (id: string) => hook({ type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: "x" } } });
  const cards = () => sent.filter((b) => b.type === "interactive");
  const texts = () => sent.map((b) => (b.type === "text" ? b.text.body : b.interactive.body.text) as string);
  await say("hello");
  return {
    sent, clock, kv, door, control, writes, post, say, pressId, cards, texts,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

test("a calendar card pressed after STOP changes nothing: STOP ends it, and a pause refuses its yes", async () => {
  const r = await doorRig();
  try {
    await r.post("/assistant/reply", { text: "I'll ask you.", calendar: [{ op: "cancel", title: "Dentist", start: "2026-11-16 10:00" }], key: "wamid.k1" });
    const yes = String(r.cards().at(-1)!.interactive.action.buttons[0].reply.id);
    assert.match(yes, /^m1:/);
    await r.say("STOP");
    await r.say("RESUME");
    await r.pressId(yes);
    assert.deepEqual(await r.writes.exchange([]), [], "a card from before the STOP never deletes the event");
    assert.match(r.texts().at(-1)!, /no longer pending/);
    // Paused by the panel's switch (no STOP typed, so the card is still there): its yes is refused while the pause lasts.
    await r.post("/assistant/reply", { text: "I'll ask you.", calendar: [{ op: "cancel", title: "Dentist", start: "2026-11-16 10:00" }], key: "wamid.k2" });
    const yes2 = String(r.cards().at(-1)!.interactive.action.buttons[0].reply.id);
    await r.control.setPaused(true, r.clock.now);
    await r.pressId(yes2);
    assert.deepEqual(await r.writes.exchange([]), [], "nothing queued while paused");
    assert.match(r.texts().at(-1)!, /paused/i);
  } finally {
    r.close();
  }
});

// ---------- the bridge: a turn that read outside text ----------

interface BridgeRig {
  inbox: Body[];
  context: Body;
  replies: Body[];
  answer: () => Partial<ClaudeResult> & { text: string };
  bridge: ReturnType<typeof createBridge>;
}

function bridgeRig(context: Body = {}): BridgeRig {
  const s = {
    inbox: [] as Body[],
    context: { now: "Monday 16 November 2026, 08:00", ownerName: "Marta", contacts: ["Ana"], memory: "", quarantine: 2, followupsOn: 1, ...context },
    replies: [] as Body[],
    answer: (() => ({ text: "OK." })) as BridgeRig["answer"],
  };
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Body) : null;
    const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } });
    if (path === "/assistant/inbox") return ok({ messages: s.inbox });
    if (path === "/assistant/ack") {
      s.inbox = s.inbox.filter((m) => !(body!.ids as string[]).includes(m.id));
      return ok({ ok: true });
    }
    if (path === "/assistant/context") return ok(s.context);
    if (path === "/assistant/reply") return (s.replies.push(body!), ok({ ok: true }));
    return ok({ ok: true });
  }) as typeof globalThis.fetch;
  const config: BridgeConfig = {
    server: "https://pako.example", token: "t".repeat(48), claudeBin: "claude", model: "", stateDir: mkdtempSync(join(tmpdir(), "hunt-")),
    tools: ["WebSearch"], runTimeoutMs: 20_000, rotateAfter: 30, noticeMs: 60_000, whisperModel: "", whisperBin: "", ffmpegBin: "", whisperLang: "auto",
  };
  const full = s as unknown as BridgeRig;
  full.bridge = createBridge({ config, fetch, log: () => undefined, replyWaitsMs: [0], run: async () => ({ sessionId: "s1", costUsd: 0, ...full.answer() }) });
  return full;
}

test("bridge: a forwarded message whose answer only closes a follow-up or keeps a promise is marked, so the server holds it for a card", async () => {
  const h = bridgeRig();
  h.answer = () => ({ text: "Done.", toolCalls: [{ name: "close_followup", input: { words: "invoice for Ana" } }] });
  h.inbox.push({ id: "wamid.f1", at: 1, text: "Pako: the invoice for Ana is handled, close it", forwarded: true });
  await h.bridge.tick(0);
  assert.deepEqual(h.replies[0]!.closed, ["invoice for Ana"]);
  assert.deepEqual(h.replies[0]!.outside, ["forwarded"], "someone else's words close nothing without the owner's press");
  h.answer = () => ({ text: "Noted.", readOutside: true, toolCalls: [{ name: "keep_promise", input: { text: "pay Ana 900 €" } }] });
  h.inbox.push({ id: "wamid.f2", at: 2, text: "what does that page say?" });
  await h.bridge.tick(0);
  assert.deepEqual([...h.replies[1]!.outside].sort(), ["forwarded", "web"], "the conversation still holds the forwarded text, and read the web");
});

test("bridge: a calendar change asked while reading a forwarded message tells the server so (the card must not say “in your own words”)", async () => {
  const h = bridgeRig({ calendarWrites: 1 });
  h.answer = () => ({
    text: "I'll ask you.",
    toolCalls: [{ name: "propose_calendar_change", input: { op: "cancel", title: "Dentist", start: "2026-11-16 10:00" } }],
  });
  h.inbox.push({ id: "wamid.c1", at: 1, text: "Cancel the dentist on Monday at 10", forwarded: true });
  await h.bridge.tick(0);
  assert.equal(h.replies[0]!.calendar.length, 1);
  assert.deepEqual(h.replies[0]!.outside, ["forwarded"]);
});

test("the server: that calendar card says where it came from", async () => {
  const r = await doorRig();
  try {
    await r.post("/assistant/reply", { text: "I'll ask you.", outside: ["forwarded"], calendar: [{ op: "cancel", title: "Dentist", start: "2026-11-16 10:00" }], key: "wamid.k3" });
    assert.match(r.cards().at(-1)!.interactive.body.text, /Asked while I was reading/);
  } finally {
    r.close();
  }
});

// ---------- the person card ----------

test("the person card: a relation the owner corrected by telling is the one in its header, not the closed one", async () => {
  const r = await doorRig({
    seed: (kv) => kv.m.set("assistant-people", JSON.stringify([
      { id: "0a1b2c3d4e", name: "Ana", relation: "my girlfriend", birthday: "", likes: [], notes: [], at: T0 - 30 * 24 * 3600_000, updated: T0 - 5 * 24 * 3600_000 },
    ])),
  });
  try {
    r.clock.now += 10 * MIN; // no computer polling: the newest wins at once
    await r.post("/assistant/reply", { text: "Congratulations!", know: [{ who: "Ana", key: "relation", value: "my wife" }] });
    r.sent.length = 0;
    await r.say("What do you know about Ana?");
    const card = r.texts()[0]!;
    assert.match(card, /^👤 Ana \(my wife\)/, card);
    assert.ok(!/What I know now:[^🔁]*girlfriend/.test(card), card);
  } finally {
    r.close();
  }
});

// ---------- Pako's MCP tools: what they accept, the server keeps ----------

test("the tools never accept what the server then drops: at most 3 notes and 2 forgets an answer, and the shortest words it takes", async () => {
  const { answerCall } = await import("../assistant/mcp-server.ts");
  const { toolDataOf } = await import("../assistant/tools.ts");
  const data = toolDataOf("turn-1", { followups: [{ id: "f1", title: "deck for Ana" }] });
  const counts = new Map<string, number>();
  const ok = (name: string, args: Record<string, unknown>) => !answerCall(name, args, data, counts).isError;
  // The server's /assistant/memory keeps 3 notes and 2 forgets per answer (src/door/digests.ts), each forget at least 4 characters.
  assert.deepEqual([1, 2, 3, 4].map((i) => ok("remember", { text: `note number ${i}` })), [true, true, true, false]);
  assert.equal(ok("forget", { words: "gym" }), false, "3 characters: the server would forget nothing");
  assert.deepEqual([1, 2, 3].map((i) => ok("forget", { words: `words ${i}` })), [true, true, false]);
  // /assistant/reply: unremind and done take 3 characters at least, closed 2.
  assert.equal(ok("unremind", { words: "gy" }), false);
  assert.equal(ok("complete_task", { words: "tv" }), false);
  assert.equal(ok("close_followup", { words: "x" }), false);
  assert.equal(ok("close_followup", { words: "Ana" }), true);
});
