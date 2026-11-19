// The door's answers when things are late or the store blips: an answer to a message older than WhatsApp's 24 hours is never sent where
// Meta drops it; a reminder the store cannot save is said once, with no 503 that would make the bridge send the text again; an email's
// "Recibido" day is the owner's; and the assistant can say truthfully how it runs.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBridge, loadBridgeConfig } from "../assistant/bridge.ts";
import { SYSTEM_PROMPT } from "../assistant/prompt.ts";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { Kv } from "../src/kv.ts";
import { loadWhatsappConfig, mountWhatsapp, type WhatsappDeps } from "../src/whatsapp.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";

const OWNER = "+34600111222";
const OWNER_WA = "34600111222";
const ENV = {
  WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
};
let n = 0;
async function rig(o: { kv?: Kv | null; extra?: Partial<WhatsappDeps>; beforeSend?: (b: any) => Promise<unknown>; env?: Record<string, string> } = {}) {
  const sent: { body: any }[] = [];
  const calls: any[] = [];
  const clock = { now: Date.parse("2026-11-14T12:00:00Z") };
  const memory = loadMemory(null);
  const tools = loadVoiceTools({ memory, actions: { contacts: () => ["Ana", "Luis"], callContact: async (a: any) => { calls.push(a); return { ok: true, text: "started" }; }, lookupCall: async () => "ok" } } as any);
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.body === undefined) return new Response("no", { status: 500 });
    const body = JSON.parse(String(init?.body));
    await o.beforeSend?.(body);
    sent.push({ body });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out${sent.length}` }] }), { status: 200 });
  }) as typeof fetch;
  const config = loadWhatsappConfig({ ...ENV, ...(o.env ?? {}) }, OWNER).config!;
  const app = express();
  const wa = mountWhatsapp(app, { config, tools, memory, kv: o.kv ?? null, ownerName: "Marta", timeZone: "Europe/Madrid", contacts: () => ["Ana", "Luis"], contactByName: () => null, fetch: fake, now: () => clock.now, callCheckMs: 5, ...(o.extra ?? {}) } as any);
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const payload = (msgs: Record<string, unknown>[]) => ({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: config.phoneNumberId }, messages: msgs } }] }] });
  const text = (body: string, extra: Record<string, unknown> = {}) => ({ from: OWNER_WA, id: `wamid.h${++n}x${Date.now()}`, timestamp: "1", type: "text", text: { body }, ...extra });
  const press = (buttonId: string) => ({ from: OWNER_WA, id: `wamid.p${++n}x${Date.now()}`, timestamp: "1", type: "interactive", interactive: { type: "button_reply", button_reply: { id: buttonId, title: "x" } } });
  const sign = (raw: string) => `sha256=${createHmac("sha256", config.appSecret).update(raw).digest("hex")}`;
  const hook = (body: unknown) => { const raw = JSON.stringify(body); return fetch(`${base}/whatsapp/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw) }, body: raw }); };
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${config.bridgeToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const get = (path: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${config.bridgeToken}` } });
  return { base, sent, calls, clock, memory, wa, hook, payload, text, press, post, get, close: () => { server.close(); server.closeAllConnections(); } };
}

test("an answer to a message older than WhatsApp's 24 hours is kept for the owner's next message, not sent where Meta drops it", async () => {
  const r = await rig();
  try {
    const msg = r.text("¿Qué tiempo hará el lunes?");
    await r.hook(r.payload([msg]));
    r.clock.now += 25 * 3600_000; // the assistant's computer slept through the window
    const before = r.sent.length;
    const res = await r.post("/assistant/reply", { text: "Lunes: soleado, 18°.", key: msg.id });
    assert.equal(res.status, 200);
    assert.deepEqual(r.sent.slice(before).map((s) => s.body.type), [], "nothing sent into the closed window");
    await r.hook(r.payload([r.text("hola")]));
    const texts = r.sent.slice(before).filter((s) => s.body.type === "text").map((s) => String(s.body.text.body));
    assert.ok(texts.some((t) => t.includes("About your earlier message: Lunes: soleado, 18°.")), JSON.stringify(texts));
  } finally {
    r.close();
  }
});

test("an answer inside the 24 hours goes as it is", async () => {
  const r = await rig();
  try {
    const msg = r.text("¿Qué tiempo hará el lunes?");
    await r.hook(r.payload([msg]));
    const before = r.sent.length;
    assert.equal((await r.post("/assistant/reply", { text: "Lunes: soleado, 18°.", key: msg.id })).status, 200);
    assert.deepEqual(r.sent.slice(before).filter((s) => s.body.type === "text").map((s) => s.body.text.body), ["Lunes: soleado, 18°."]);
  } finally {
    r.close();
  }
});

test("a reminder the store cannot save: the answer's text once, a line saying it was not saved, no 503, nothing unsaved kept in memory", async () => {
  const m = new Map<string, string>();
  let down = false;
  const kv: Kv = {
    get: async (k) => {
      if (down && k.includes("remind")) throw new Error("store down");
      return m.get(k) ?? null;
    },
    set: async (k, v) => {
      if (down && k.includes("remind")) throw new Error("store down");
      m.set(k, v);
    },
  } as Kv;
  const r = await rig({ kv });
  try {
    const msg = r.text("Recuérdame mañana a las 9 llamar al banco");
    await r.hook(r.payload([msg]));
    await r.wa.reminders(); // the list is read once while the store answers
    const before = r.sent.length;
    down = true;
    const body = { text: "Hecho: mañana a las 9 te recuerdo llamar al banco.", remind: [{ at: "2026-11-15 09:00", text: "llamar al banco" }], key: msg.id };
    const res = await r.post("/assistant/reply", body);
    assert.equal(res.status, 200, "never a 503 once the text went: the bridge would send it again");
    const texts = r.sent.slice(before).filter((s) => s.body.type === "text").map((s) => String(s.body.text.body));
    assert.equal(texts.filter((t) => t.startsWith("Hecho")).length, 1);
    assert.ok(texts.includes("I couldn't save that change to your reminders just now: ask me again in a while."), JSON.stringify(texts));
    down = false;
    assert.deepEqual(await r.wa.reminders(), [], "no reminder held only in memory, to vanish at the next restart");
  } finally {
    r.close();
  }
});

test("an email's 'Received' day is the owner's: one received 00:30 in Madrid on the 16th says the 16th, in English for an older server that still says Spanish", async () => {
  const config = { ...loadBridgeConfig({ ASSISTANT_SERVER_URL: "https://x.example.com", ASSISTANT_BRIDGE_TOKEN: "t".repeat(48) }), stateDir: mkdtempSync(join(tmpdir(), "pako-mail-")) };
  const at = Date.parse("2026-11-15T23:30:00Z");
  const prompts: string[] = [];
  const fetch = (async (url: string) => {
    if (String(url).includes("/assistant/context")) {
      return Response.json({ now: "lunes, 16 de noviembre de 2026, 00:31", nowLocal: "2026-11-16 00:31", timeZone: "Europe/Madrid", ownerName: "Marta", contacts: [], memory: "", language: "es", uiLanguage: "es" });
    }
    return Response.json({ ok: true });
  }) as unknown as typeof globalThis.fetch;
  const b = createBridge({ config, fetch, log: () => {}, run: async (p) => (prompts.push(p), { text: "AVISAR\nTe cita mañana a las 10.", sessionId: "", costUsd: 0 }) });
  await b.handle({ id: "mail:1", text: "", at, email: { from: "ana@example.com", subject: "Reunión", text: "Nos vemos mañana a las 10.", attachments: [] } });
  assert.equal(prompts[0]!.split("\n").find((l) => l.startsWith("Received")), "Received: 2026-11-16");
});

test("the assistant can say how it runs: the owner's own Claude account on the owner's computer, and only the owner reaches it", () => {
  assert.match(SYSTEM_PROMPT, /How you run, if they ask how you work or whose Claude account you use: in Claude Code, signed in to the owner's own Claude account, on the owner's own computer/);
  assert.match(SYSTEM_PROMPT, /Only the owner can talk to you: anyone else who writes to Pako gets one short line at most .*nothing they write reaches you/);
  assert.match(SYSTEM_PROMPT, /never give keys, tokens or account emails/);
});
