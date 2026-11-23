// A draft per follow-up (one-job audit §5): the reminder offers one, DRAFT picks the loop (the one reminded of last, or the one a few words
// name; several or none are said), and the draft is written from the loop and what Pako knows of that person. Nothing is ever sent.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { createControl } from "../src/control.ts";
import { createFollowups, FOLLOWUPS_KEY, followupsProxy } from "../src/followups.ts";
import type { Kv } from "../src/kv.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";
import { loadWhatsappConfig, mountWhatsapp } from "../src/whatsapp.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-11-16T09:00:00Z");
type Body = Record<string, any>;

const loop = (id: string, kind: string, title: string, who: string, extra: Record<string, unknown> = {}) => ({
  id, kind, title, detail: `${who} asked on Slack.`, who, where: { type: "slack_dm", label: `${who} (private)`, channel: "D1" }, whenSaid: T0 - 60 * MIN,
  check: { none: { reason: "email" } }, status: "open", nextCheckAt: T0 + 60 * MIN, nudges: 0, createdAt: T0 - 60 * MIN,
  sources: [{ kind: "slack", label: `Slack · ${who}`, at: T0 - 60 * MIN }], ...extra,
});

function rig(drafts = true) {
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  m.set(FOLLOWUPS_KEY, JSON.stringify({
    loops: [
      loop("b000000001", "request_to_owner", "Send Ana the Q4 deck", "Ana", { nudges: 1, checkedAt: T0 - 5 * MIN, lastCheck: "I can't see your mail." }),
      loop("b000000002", "owner_promise", "Book the call with Omar", "Omar"),
      loop("b000000003", "owner_promise", "Send Omar the contract", "Omar"),
      loop("b000000004", "other_promise", "Stan sends the pricing", "Stan", { dueAt: T0 + 3 * 60 * MIN, check: { calendarEvent: { hints: [] } } }),
    ],
  }));
  const cards: string[] = [];
  const clock = { now: T0 };
  const engine = createFollowups({
    config: { delayMs: 10 * MIN, maxPerDay: 6, batchMs: 3 * MIN, quiet: { start: 23 * 60, end: 8 * 60 } }, drafts,
    kv, timeZone: "Europe/London", now: () => clock.now, enqueue: async () => true, card: async (b) => (cards.push(b), true), notify: async () => undefined,
  });
  return { engine, cards, clock, m, kv };
}

test("DRAFT picks the follow-up reminded of last; a few words pick the one they name; several or none are said", async () => {
  const r = rig();
  const last = await r.engine.forDraft("");
  assert.ok("loop" in last && last.loop.id === "b000000001");
  const named = await r.engine.forDraft("contract");
  assert.ok("loop" in named && named.loop.id === "b000000003");
  assert.deepEqual(await r.engine.forDraft("Omar"), { many: ["Book the call with Omar", "Send Omar the contract"] });
  assert.deepEqual(await r.engine.forDraft("dentist"), { none: true });
  if (!("loop" in last)) throw new Error("no loop");
  const facts = r.engine.draftFacts(last.loop);
  assert.match(facts[0]!.text, /^They asked the owner: Send Ana the Q4 deck · person: Ana · where it was said: Ana \(private\)/);
  assert.match(facts[0]!.text, /what Pako checked: I can't see your mail\./);
});

test("the reminder offers a draft for what is the owner's to do, never for someone else's promise, and only when drafts are on", async () => {
  const r = rig();
  r.clock.now = T0 + 60 * MIN;
  await r.engine.tick();
  const mine = r.cards.find((c) => c.includes("Book the call with Omar"));
  assert.ok(mine);
  assert.match(mine, /\n✍️ Reply DRAFT and I'll write it for you to send\.$/);
  const off = rig(false);
  off.clock.now = T0 + 60 * MIN;
  await off.engine.tick();
  assert.ok(off.cards.length && off.cards.every((c) => !c.includes("DRAFT")));
});

const ENV = {
  WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
};

test("door: DRAFT asks for the draft with the loop and what the owner told about that person; words that fit no follow-up, or two, are left to the assistant", async () => {
  const fu = rig();
  const sent: Body[] = [];
  const meta = (async (_u: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Body);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out${sent.length}` }] }), { status: 200 });
  }) as typeof fetch;
  const memory = loadMemory(fu.kv);
  const tools = loadVoiceTools({ memory, actions: { contacts: () => [], callContact: async () => ({ ok: true, text: "started" }), lookupCall: async () => "ok" } });
  const config = loadWhatsappConfig(ENV, "+447700900123").config!;
  const asked: { title: string; facts: { label: string; text: string }[] }[] = [];
  const app = express();
  mountWhatsapp(app, {
    config, tools, memory, kv: fu.kv, control: createControl(fu.kv, () => T0), ownerName: "Alex", timeZone: "Europe/London", contacts: () => [], fetch: meta,
    now: () => T0, callCheckMs: 5, receiptWaitMs: 60_000, followups: followupsProxy(() => fu.engine),
    draftFor: async (o) => (asked.push(o), { status: "pending" }),
  });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let n = 0;
  const say = async (body: string) => {
    const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp", metadata: { phone_number_id: config.phoneNumberId },
      messages: [{ from: "447700900123", id: `wamid.d${++n}`, timestamp: "1", type: "text", text: { body } }],
    } }] }] });
    const signature = `sha256=${createHmac("sha256", config.appSecret).update(raw).digest("hex")}`;
    await fetch(`${base}/whatsapp/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature }, body: raw });
  };
  const last = () => (sent.at(-1)?.text?.body ?? "") as string;
  try {
    // What the owner told about Ana, kept as a dated fact the way a reply's <know> is.
    await say("Ana prefers short notes");
    await fetch(`${base}/assistant/reply`, { method: "POST", headers: { authorization: `Bearer ${config.bridgeToken}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "Noted.", know: [{ who: "Ana", key: "style", value: "prefers short notes" }], key: "wamid.d1" }) });
    await say("DRAFT");
    assert.equal(last(), "✍️ Writing a draft for “Send Ana the Q4 deck”. It comes in a moment; nothing is sent.");
    assert.equal(asked[0]!.title, "Send Ana the Q4 deck");
    assert.match(asked[0]!.facts[0]!.text, /^They asked the owner: Send Ana the Q4 deck/);
    assert.ok(asked[0]!.facts.some((f) => /prefers short notes/.test(f.text)), JSON.stringify(asked[0]!.facts));
    // With words, the command takes the message only for exactly one follow-up: two (omar) or none (dentist) is a request for the assistant, so the
    // door says nothing and the message goes on to it (src/door/views.ts).
    const told = sent.length;
    await say("draft omar");
    await say("draft dentist");
    assert.equal(sent.length, told, "the door answered neither");
    assert.equal(asked.length, 1, "nothing asked when it is not one follow-up");
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
