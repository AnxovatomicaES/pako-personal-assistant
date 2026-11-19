// "Done" in the chat closes a follow-up (one-job audit §2): the owner's own words name one open loop and it closes as the Done button would;
// words that name none or several close nothing and say so; Undo opens it again; a turn that read new outside text holds it on a card.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReply } from "../assistant/bridge.ts";
import { applyToolCalls, checkArgs, toolDataOf, unavailable } from "../assistant/tools.ts";
import { createFollowups, FOLLOWUPS_KEY, followupsProxy } from "../src/followups.ts";
import type { Kv } from "../src/kv.ts";
import { heldLines } from "../src/quarantine.ts";
import { receiptText, undoneText, nothingReverted } from "../src/undo.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-11-16T09:00:00Z");

const loop = (id: string, title: string, who: string, status = "open") => ({
  id, kind: "owner_promise", title, detail: "", who, where: { type: "slack_dm", label: `${who} (DM)`, channel: "D1" }, whenSaid: T0 - 60 * MIN,
  check: { none: { reason: "email" } }, status, nextCheckAt: T0 + 60 * MIN, nudges: 0, createdAt: T0 - 60 * MIN,
  sources: [{ kind: "slack", label: `Slack · ${who}`, at: T0 - 60 * MIN }],
});

function rig() {
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  m.set(FOLLOWUPS_KEY, JSON.stringify({
    loops: [
      loop("a000000001", "Send Ana the Q4 deck", "Ana Ruiz"),
      loop("a000000002", "Book the call with Omar", "Omar"),
      loop("a000000003", "Send Omar the contract", "Omar"),
      loop("a000000004", "Send Ana the old invoice", "Ana Ruiz", "done"),
    ],
  }));
  const engine = createFollowups({
    config: { delayMs: 10 * MIN, maxPerDay: 6, batchMs: 3 * MIN, quiet: { start: 23 * 60, end: 8 * 60 } },
    kv, timeZone: "Europe/London", now: () => T0, enqueue: async () => true, card: async () => true, notify: async () => undefined,
  });
  const all = async () => Object.fromEntries((JSON.parse(m.get(FOLLOWUPS_KEY)!).loops as { id: string; status: string }[]).map((l) => [l.id, l.status]));
  return { engine, all };
}

test("the owner's words close the one open follow-up they name, accents and case aside; a closed one is not named again", async () => {
  const r = rig();
  const out = await r.engine.closeByWords(["deck ANA"]);
  assert.deepEqual(out.closed.map((c) => c.id), ["a000000001"]);
  assert.deepEqual([out.none, out.many], [[], []]);
  assert.equal((await r.all()).a000000001, "done");
  assert.equal((await r.all()).a000000004, "done", "an already closed one is untouched");
  const again = await r.engine.closeByWords(["deck ana"]);
  assert.deepEqual(again.none, ["deck ana"], "nothing open has those words any more");
});

test("words that name several or none close nothing and say which", async () => {
  const r = rig();
  const out = await r.engine.closeByWords(["Omar", "dentist"]);
  assert.deepEqual(out.closed, []);
  assert.deepEqual(out.none, ["dentist"]);
  assert.deepEqual(out.many, [{ words: "Omar", titles: ["Book the call with Omar", "Send Omar the contract"] }]);
  const all = await r.all();
  assert.equal(all.a000000002, "open");
  assert.equal(all.a000000003, "open");
});

test("Undo opens the closed follow-up again as it was; one closed another way since stays closed", async () => {
  const r = rig();
  const out = await r.engine.closeByWords(["call Omar", "contract"]);
  assert.equal(out.closed.length, 2);
  await r.engine.press("1", "a000000003"); // already done: the press says so, nothing changes
  const back = await r.engine.reopenClosed(out.closed);
  assert.deepEqual(back.map((b) => b.id), ["a000000002", "a000000003"]);
  const all = await r.all();
  assert.equal(all.a000000002, "open");
  assert.equal(all.a000000003, "open");
  const l = (await r.engine.read()).loops.find((x) => x.id === "a000000002")!;
  assert.equal(l.nextCheckAt, T0 + 60 * MIN, "its next check is back");
  assert.equal(l.closedAt, undefined);
});

test("the receipt, the undo answer and the held card say it in the owner's words", () => {
  const closed = [{ id: "a000000001", title: "Send Ana the Q4 deck", status: "open" as const, nextCheckAt: 0 }];
  assert.equal(receiptText([{ kind: "loops-closed", loops: closed }], "Europe/London"), "☑️ Follow-up closed: “Send Ana the Q4 deck”");
  assert.match(undoneText({ ...nothingReverted(), reopenedLoops: closed }, "Europe/London").text, /opened the follow-up “Send Ana the Q4 deck” again/);
  const card = heldLines({ call: null, message: null, send: null, book: null, remind: [], unremind: [], lists: [], tasks: [], done: [], closed: ["deck Ana"], remember: [], forget: [] }, "en");
  assert.deepEqual(card, ["Close the follow-up: “deck Ana”"]);
});

test("the tag and the tool give the same field; the tool is refused when the context lists no follow-up", () => {
  assert.deepEqual(parseReply("Great, closing it. <closed>deck Ana</closed>").closed, ["deck Ana"]);
  assert.equal(parseReply("Great, closing it. <closed>deck Ana</closed>").text, "Great, closing it.");
  assert.deepEqual(applyToolCalls(parseReply(""), [{ name: "close_followup", input: { words: "deck Ana" } }]).closed, ["deck Ana"]);
  assert.equal(checkArgs("close_followup", { words: "" }).ok, false);
  assert.match(unavailable("close_followup", toolDataOf("t", {}))!, /no open follow-up/);
  assert.equal(unavailable("close_followup", toolDataOf("t", { followups: ["Send Ana the Q4 deck (Slack · Ana)"] })), null);
  const caps = parseReply("<closed>a1</closed><closed>a2</closed><closed>a3</closed><closed>a4</closed>").closed;
  assert.equal(caps?.length, 3, "three at most per answer");
});

// ---------- through the real door: the reply's <closed>, its receipt with Undo, and the press that opens it again ----------

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import express from "express";
import { createControl } from "../src/control.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";
import { loadWhatsappConfig, mountWhatsapp } from "../src/whatsapp.ts";

const ENV = {
  WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
};
type Body = Record<string, any>;

test("door: the owner's «sent Ana the deck» closes that follow-up with a receipt; Undo opens it again; words for several close nothing", async () => {
  const fu = rig();
  const sent: Body[] = [];
  const meta = (async (_u: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Body);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out${sent.length}` }] }), { status: 200 });
  }) as typeof fetch;
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
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
      messaging_product: "whatsapp", metadata: { phone_number_id: config.phoneNumberId }, messages: [{ from: "447700900123", id: `wamid.c${++n}`, timestamp: "1", ...msg }],
    } }] }] });
    const signature = `sha256=${createHmac("sha256", config.appSecret).update(raw).digest("hex")}`;
    await fetch(`${base}/whatsapp/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature }, body: raw });
  };
  const press = (id: string) => hook({ type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: "x" } } });
  try {
    await hook({ type: "text", text: { body: "Sent Ana the deck" } }); // the owner wrote: WhatsApp's 24 hours are open
    assert.equal(await post({ text: "Nice, that's off your list.", closed: ["deck Ana"], key: "k-c1" }), 200);
    assert.equal(texts().at(-1), "☑️ Follow-up closed: “Send Ana the Q4 deck”");
    assert.equal((await fu.all()).a000000001, "done");
    const card = [...sent].reverse().find((b) => b.type === "interactive")!;
    await press(String(card.interactive.action.buttons[0].reply.id));
    assert.match(texts().at(-1)!, /opened the follow-up “Send Ana the Q4 deck” again/);
    assert.equal((await fu.all()).a000000001, "open");
    await post({ text: "OK.", closed: ["Omar"], key: "k-c2" });
    assert.equal(texts().at(-1), "Several open follow-ups have “Omar”: “Book the call with Omar”, “Send Omar the contract”. Nothing was closed: tell me which one.");
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
