// Pako Relay (src/relay.ts, src/relay-client.ts): reminders that still come with the laptop's lid shut. Each occurrence fires once, on the
// relay or on the laptop, never both; a cancel on the laptop is a reminder its next sync no longer sends; the token guards every route.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { createControl } from "../src/control.ts";
import type { Kv } from "../src/kv.ts";
import { createRelay, loadRelayConfig, mountRelay, remindersOf } from "../src/relay.ts";
import { createRelayClient, loadRelayClientConfig, occurrence } from "../src/relay-client.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";
import { loadWhatsappConfig, mountWhatsapp } from "../src/whatsapp.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-11-16T09:00:00Z");
const TOKEN = "r".repeat(40);
type Body = Record<string, any>;
function memKv() {
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  return { kv, m };
}

test("settings: off unless set; a half-set relay or client says what is wrong", () => {
  assert.deepEqual(loadRelayConfig({}), { config: null, problems: [] });
  assert.match(loadRelayConfig({ RELAY_TOKEN: "short" }).problems.join(";"), /32 characters.*bot token.*chat id/);
  assert.ok(loadRelayConfig({ RELAY_TOKEN: TOKEN, RELAY_TELEGRAM_TOKEN: `12345:${"A".repeat(35)}`, RELAY_TELEGRAM_CHAT: "987654321" }).config);
  assert.deepEqual(loadRelayClientConfig({}), { config: null, problems: [] });
  assert.match(loadRelayClientConfig({ RELAY_URL: "http://relay.example", RELAY_TOKEN: TOKEN }).problems[0]!, /https/);
  assert.deepEqual(loadRelayClientConfig({ RELAY_URL: "https://relay.example/", RELAY_TOKEN: TOKEN }).config, { url: "https://relay.example", token: TOKEN });
});

test("relay: fires each occurrence once at its time; a send that fails is tried again; one changed fires at its new version only", async () => {
  const clock = { now: T0 };
  const sent: string[] = [];
  let up = false;
  const relay = createRelay({ kv: memKv().kv, now: () => clock.now, send: async (t) => (up ? (sent.push(t), true) : false) });
  const a = occurrence({ id: "aa", at: T0 + 10 * MIN, text: "Call the bank" });
  const b = occurrence({ id: "bb", at: T0 + 20 * MIN, text: "Pick up the kids" });
  await relay.sync([a, b], 0);
  clock.now = T0 + 11 * MIN;
  assert.equal(await relay.tick(), 0, "Telegram is down: nothing recorded as sent");
  up = true;
  assert.equal(await relay.tick(), 1);
  assert.equal(await relay.tick(), 0, "once");
  assert.deepEqual(sent, ["⏰ Call the bank"]);
  // The laptop moved the second one: its new occurrence replaces the old (the old is no longer in the list).
  const moved = occurrence({ id: "bb", at: T0 + 30 * MIN, text: "Pick up the kids" });
  const r = await relay.sync([a, moved], 0);
  assert.deepEqual(r.fired.map((f) => f.id), [a.id], "what fired comes back to the laptop");
  clock.now = T0 + 25 * MIN;
  assert.equal(await relay.tick(), 0, "the old time is gone");
  clock.now = T0 + 31 * MIN;
  assert.equal(await relay.tick(), 1);
  // Cancelled on the laptop: not in the next sync, never fired.
  await relay.sync([occurrence({ id: "cc", at: T0 + 40 * MIN, text: "Gym" })], 0);
  await relay.sync([], 0);
  clock.now = T0 + 41 * MIN;
  assert.equal(await relay.tick(), 0);
  // Far too late (the host slept past it): not fired; the laptop says it was missed when it wakes.
  await relay.sync([occurrence({ id: "dd", at: T0 + 50 * MIN, text: "Old" })], 0);
  clock.now = T0 + 50 * MIN + 13 * 3600_000;
  assert.equal(await relay.tick(), 0);
  assert.deepEqual(sent, ["⏰ Call the bank", "⏰ Pick up the kids"]);
});

test("relay: what a sync sends is read field by field", () => {
  assert.equal(remindersOf("x"), null);
  assert.deepEqual(remindersOf([{ id: "a@1", version: "v1", at: 1, text: "  hi  there " }, { id: "<script>", version: "v", at: 1, text: "x" }, { id: "b", at: 1 }]),
    [{ id: "a@1", version: "v1", at: 1, text: "hi there" }]);
});

test("routes: the token guards every one; sync answers what fired; tick is the outside wake", async () => {
  const sent: string[] = [];
  const relay = createRelay({ kv: memKv().kv, now: () => T0 + 15 * MIN, send: async (t) => (sent.push(t), true) });
  const app = express();
  mountRelay(app, { relay, token: TOKEN });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, token = TOKEN) =>
    fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await post("/relay/sync", { reminders: [] }, "wrong".repeat(8))).status, 401);
    assert.equal((await post("/relay/tick", {}, "")).status, 401);
    assert.equal((await post("/relay/sync", { nope: 1 })).status, 400);
    const a = occurrence({ id: "aa", at: T0 + 10 * MIN, text: "Call the bank" });
    assert.equal((await post("/relay/sync", { reminders: [a], since: 0 })).status, 200);
    assert.deepEqual(await (await post("/relay/tick", {})).json(), { sent: 0 }, "the sync's own tick already sent it");
    assert.deepEqual(sent, ["⏰ Call the bank"], "five minutes after its time is not yet late");
    const back = await (await post("/relay/sync", { reminders: [a], since: 0 })).json() as { fired: { id: string }[] };
    assert.deepEqual(back.fired.map((f) => f.id), [a.id]);
    assert.equal((await fetch(`${base}/relay/sync`, { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

const ENV = {
  WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
};

test("the laptop: a reminder the relay sent while it slept is marked sent when it wakes, never sent again; without the relay it goes as before", async () => {
  const clock = { now: T0 };
  const relaySent: string[] = [];
  const relay = createRelay({ kv: memKv().kv, now: () => clock.now, send: async (t) => (relaySent.push(t), true) });
  const relayApp = express();
  mountRelay(relayApp, { relay, token: TOKEN });
  const relayServer: Server = createServer(relayApp);
  await new Promise<void>((r) => relayServer.listen(0, "127.0.0.1", () => r()));
  const relayUrl = `http://127.0.0.1:${(relayServer.address() as AddressInfo).port}`;

  const sent: Body[] = [];
  const meta = (async (_u: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Body);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out${sent.length}` }] }), { status: 200 });
  }) as typeof fetch;
  const { kv } = memKv();
  const memory = loadMemory(kv);
  const tools = loadVoiceTools({ memory, actions: { contacts: () => [], callContact: async () => ({ ok: true, text: "started" }), lookupCall: async () => "ok" } });
  const config = loadWhatsappConfig(ENV, "+447700900123").config!;
  const ref: { c: ReturnType<typeof createRelayClient> | null } = { c: null };
  const app = express();
  const door = mountWhatsapp(app, {
    config, tools, memory, kv, control: createControl(kv, () => clock.now), ownerName: "Alex", timeZone: "Europe/London", contacts: () => [], fetch: meta,
    now: () => clock.now, callCheckMs: 5, receiptWaitMs: 60_000,
    relay: { sync: () => (ref.c ? ref.c.sync() : Promise.resolve(false)), firedByRelay: (r) => ref.c?.firedByRelay(r) ?? false },
  });
  // The client talks to the relay over http (its address is http here: the setting's https rule is for real use).
  ref.c = createRelayClient({ config: { url: relayUrl, token: TOKEN }, reminders: () => door.relayReminders(), now: () => clock.now });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const hook = async (body: string) => {
    const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp", metadata: { phone_number_id: config.phoneNumberId },
      messages: [{ from: "447700900123", id: `wamid.r${clock.now}`, timestamp: String(clock.now / 1000), type: "text", text: { body } }],
    } }] }] });
    const signature = `sha256=${createHmac("sha256", config.appSecret).update(raw).digest("hex")}`;
    await fetch(`${base}/whatsapp/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature }, body: raw });
  };
  const post = (body: unknown) =>
    fetch(`${base}/assistant/reply`, { method: "POST", headers: { authorization: `Bearer ${config.bridgeToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const texts = () => sent.map((b) => (b.type === "text" ? b.text.body : b.interactive?.body?.text ?? "") as string);
  try {
    await hook("remind me at 09:10 to call the bank and at 09:20 to stretch");
    await post({ text: "Done.", remind: [{ at: "2026-11-16 09:10", text: "Call the bank" }, { at: "2026-11-16 09:20", text: "Stretch" }], key: `wamid.r${T0}` });
    assert.equal(await ref.c.sync(), true, "the laptop syncs before it sleeps");
    // The lid shuts; at 09:10 the relay fires.
    clock.now = T0 + 11 * MIN;
    await relay.tick();
    assert.deepEqual(relaySent, ["⏰ Call the bank"]);
    // The laptop wakes at 09:21: it hears what the relay sent, marks it sent, and sends only the one the relay did not.
    clock.now = T0 + 21 * MIN;
    const before = texts().length;
    await door.runReminders();
    const after = texts().slice(before);
    assert.ok(!after.some((t) => /Call the bank/.test(t)), `not sent twice: ${JSON.stringify(after)}`);
    assert.ok(after.some((t) => /Stretch/.test(t)), "the other one goes from the laptop as before");
    assert.deepEqual((await door.relayReminders()).map((r) => r.text), [], "both are done");
  } finally {
    server.close();
    server.closeAllConnections();
    relayServer.close();
    relayServer.closeAllConnections();
  }
});
