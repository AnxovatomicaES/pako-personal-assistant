// A draft that answers an email can be sent as a reply (one-job audit §5): the written draft comes back on the email card, to that
// email's sender, with "Re:" its subject and the draft's message; nothing goes until the owner presses Send.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { BRIEF_V2_KEY, createBriefV2 } from "../src/brief-v2.ts";
import { createControl } from "../src/control.ts";
import type { Kv } from "../src/kv.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";
import { loadWhatsappConfig, mountWhatsapp, type Inbound } from "../src/whatsapp.ts";

const T0 = Date.parse("2026-11-16T09:00:00Z");
type Body = Record<string, any>;
function memKv() {
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  return { kv, m };
}

test("brief: a draft with its email offers the send once written; one without an email does not", async () => {
  const store = memKv();
  const queued: Inbound[] = [];
  const offered: { mailRef: string; title: string; text: string }[] = [];
  const v2 = createBriefV2({
    config: { waitMs: 15 * 60_000 }, kv: store.kv, timeZone: "Europe/London", now: () => T0, sources: {}, enqueue: async (m) => (queued.push(m), true),
    plain: async () => undefined, notify: async () => undefined, tell: async () => undefined, offerSend: async (o) => void offered.push(o),
  });
  const withMail = (await v2.draftFor({ title: "Reply to Ana about the invoice", facts: [{ label: "Email", text: "They asked the owner: reply to Ana" }], mailRef: "<m1@x>" }))!;
  assert.equal(withMail.mailRef, "<m1@x>");
  const id = (m: Inbound) => /^br:([0-9a-f]{10})$/.exec(m.id)![1]!;
  await v2.result(id(queued[0]!), "A reply to Ana's email:\nHi Ana, the invoice is paid.\n(Sources: D1)");
  assert.deepEqual(offered, [{ mailRef: "<m1@x>", title: "Draft: Reply to Ana about the invoice", text: "A reply to Ana's email:\nHi Ana, the invoice is paid." }]);
  await v2.draftFor({ title: "Send Omar the contract", facts: [{ label: "Slack", text: "The owner promised: send Omar the contract" }] });
  await v2.result(id(queued[1]!), "In Slack, Omar (private):\nOn it.");
  assert.equal(offered.length, 1, "a Slack draft is for copying: no email card");
  assert.ok(JSON.parse(store.m.get(BRIEF_V2_KEY)!).tasks.length >= 2);
});

const ENV = {
  WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
};

test("door: the draft comes back as the email card, to the sender, Re: the subject, without the «where it goes» line; Send sends it", async () => {
  const sent: Body[] = [];
  const meta = (async (_u: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Body);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out${sent.length}` }] }), { status: 200 });
  }) as typeof fetch;
  const { kv } = memKv();
  const mails: { to: string; subject: string; text: string }[] = [];
  const memory = loadMemory(kv);
  const tools = loadVoiceTools({ memory, actions: { contacts: () => [], callContact: async () => ({ ok: true, text: "started" }), lookupCall: async () => "ok" } });
  const config = loadWhatsappConfig(ENV, "+447700900123").config!;
  const app = express();
  const door = mountWhatsapp(app, {
    config, tools, memory, kv, control: createControl(kv, () => T0), ownerName: "Alex", timeZone: "Europe/London", contacts: () => [], fetch: meta,
    now: () => T0, callCheckMs: 5, receiptWaitMs: 60_000, sendEmail: async (m) => void mails.push(m),
  });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let n = 0;
  const hook = async (msg: Body) => {
    const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp", metadata: { phone_number_id: config.phoneNumberId }, messages: [{ from: "447700900123", id: `wamid.s${++n}`, timestamp: "1", ...msg }],
    } }] }] });
    const signature = `sha256=${createHmac("sha256", config.appSecret).update(raw).digest("hex")}`;
    await fetch(`${base}/whatsapp/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature }, body: raw });
  };
  try {
    await hook({ type: "text", text: { body: "DRAFT" } }); // the owner wrote: WhatsApp's 24 hours are open
    await door.offerDraftSend({ from: "Ana Ruiz <ana@client.example>", subject: "Invoice 42", title: "Draft: Reply to Ana", text: "A reply to Ana's email:\nHi Ana, the invoice is paid.\nBest, Alex" });
    const card = [...sent].reverse().find((b) => b.type === "interactive")!;
    const body = card.interactive.body.text as string;
    assert.match(body, /^📝 The draft for “Draft: Reply to Ana”, as a reply to that email\. It goes only if you press Send:/);
    assert.match(body, /Email to Ana Ruiz \(ana@client\.example\)/);
    assert.match(body, /Subject: Re: Invoice 42\nHi Ana, the invoice is paid\.\nBest, Alex$/);
    assert.equal(mails.length, 0, "nothing goes before the press");
    await hook({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: String(card.interactive.action.buttons[0].reply.id), title: "x" } } });
    for (let i = 0; i < 50 && !mails.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(mails.length, 1);
    assert.equal(mails[0]!.to, "ana@client.example");
    assert.equal(mails[0]!.subject, "Re: Invoice 42");
    assert.match(mails[0]!.text, /Hi Ana, the invoice is paid\.\nBest, Alex$/);
    assert.doesNotMatch(mails[0]!.text, /A reply to Ana's email/);
    await door.offerDraftSend({ from: "noreply", subject: "x", title: "t", text: "a\nb" });
    assert.equal(sent.filter((b) => b.type === "interactive").length, 1, "no address: no card");
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
