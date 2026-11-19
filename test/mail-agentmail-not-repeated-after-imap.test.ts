import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { createMailbox, mountMail, takeMail } from "../src/mail.ts";

function memKv() {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void m.set(k, v) };
}

test("an old AgentMail email is announced again once the owner's IMAP mail fills the seen list", async () => {
  const kv = memKv();
  const box = createMailbox(kv);
  const queued: string[] = [];
  const enqueue = async (m: { id: string }) => (queued.push(m.id), true);
  let now = Date.parse("2026-11-01T10:00:00Z");
  // Pako's own AgentMail inbox: one restaurant reply, weeks old, still the latest in the listing.
  const old = { message_id: "<reply-1@resto.example>", inbox_id: "pako@agentmail.to", from: "Resto <res@resto.example>", subject: "Re: mesa", text: "Confirmado", timestamp: "2026-11-01T09:00:00Z", labels: ["received"] };
  const fetch = (async () => new Response(JSON.stringify({ messages: [old] }), { status: 200 })) as typeof globalThis.fetch;
  const app = express();
  const mail = mountMail(app, {
    config: { apiKey: "k".repeat(20), inbox: "pako@agentmail.to", webhookSecret: "", pollMinutes: 0, workDomains: [], vip: [] },
    box, enqueue: enqueue as any, fetch, now: () => now,
  });
  await mail.poll(); // primes
  await box.forget("nothing"); // no-op
  // The reply arrives (webhook or listing) and is announced once.
  // simulate: unprime state by passing a newer listing? simpler: it is primed already as seen. Now the owner's IMAP mailbox brings 160 emails.
  for (let i = 0; i < 160; i++) {
    now += 60_000;
    await takeMail({ box, enqueue: enqueue as any, lang: () => "en", now: () => now, vip: [] }, `imap:INBOX:${i}`,
      { from: `x${i}@work.example`, subject: `s${i}`, text: "hola", headers: { "message-id": `<m${i}@work.example>` } }, "personal");
  }
  queued.length = 0;
  await mail.poll();
  assert.deepEqual(queued, [], "the weeks-old reply must not be passed on again");
});

test("the seen list is still capped: the oldest IMAP ids go once there are too many of them", async () => {
  const kv = memKv();
  const box = createMailbox(kv);
  let now = Date.parse("2026-11-01T10:00:00Z");
  const enqueue = async () => true;
  for (let i = 0; i < 320; i++) {
    now += 1000;
    await takeMail({ box, enqueue: enqueue as any, lang: () => "en", now: () => now, vip: [] }, `imap:${i}`,
      { from: `x${i}@work.example`, subject: `s${i}`, text: "hola", headers: { "message-id": `<m${i}@work.example>` } }, "personal");
  }
  assert.equal(await box.isSeen("imap:0"), false);
  assert.equal(await box.isSeen("imap:319"), true);
  const stored = JSON.parse((await kv.get("assistant-mail"))!) as { seen: string[] };
  assert.ok(stored.seen.length <= 600, `kept ${stored.seen.length}`);
});
