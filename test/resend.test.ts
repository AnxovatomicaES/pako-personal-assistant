// Sending from Pako's own domain through Resend (src/resend.ts): the settings, the choice between Resend and the AgentMail inbox, the
// request Resend gets, its refusals, and the panel's card (the key tried with GET /domains, kept with the other secrets). The door's side
// (the held window, the assistant line, the owner told of a refusal) is in test/autonomy.test.ts. Nothing here reaches the network.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import express from "express";
import { CATALOGUE, KEYS, readStored } from "../src/connections.ts";
import { mountConnectionsPanel } from "../src/connections-panel.ts";
import { MOVE_SETTINGS } from "../src/move.ts";
import { checkResendKey, chooseSender, loadResendConfig, sendViaResend } from "../src/resend.ts";

type Seen = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null };

/** A fake fetch: every request kept, each answered by `answer` (200 {} without it). */
function fake(answer: (url: string) => Response = () => new Response("{}", { status: 200 })) {
  const seen: Seen[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    });
    return answer(String(url));
  }) as typeof fetch;
  return { f, seen };
}

const KEY = "re_AbCdEf123456_7890";
const AGENTMAIL = { apiKey: "am_cccccccccccccccccccccccccccccc", inbox: "pako@agentmail.to" };

test("settings: off without any; the key and the sender needed; a wrong one is named; RESEND_REPLY_TO optional", () => {
  assert.deepEqual(loadResendConfig({}), { config: null, problems: [] });
  assert.deepEqual(loadResendConfig({ RESEND_API_KEY: KEY, RESEND_FROM: "Pako <hello@pako-os.com>" }).config, { apiKey: KEY, from: "Pako <hello@pako-os.com>" });
  assert.deepEqual(loadResendConfig({ RESEND_API_KEY: KEY, RESEND_FROM: "hello@pako-os.com", RESEND_REPLY_TO: "me@example.com" }).config, {
    apiKey: KEY, from: "hello@pako-os.com", replyTo: "me@example.com",
  });
  const bad = loadResendConfig({ RESEND_API_KEY: "sk_nope", RESEND_FROM: "not an address", RESEND_REPLY_TO: "a, b" });
  assert.equal(bad.config, null);
  assert.deepEqual(bad.problems.map((p) => p.split(" ")[0]), ["RESEND_API_KEY", "RESEND_FROM", "RESEND_REPLY_TO"]);
  assert.match(loadResendConfig({ RESEND_API_KEY: KEY }).problems.join(), /^RESEND_FROM/, "a key alone is not enough");
});

test("the sender: Resend when it is set, else AgentMail exactly as before, else nobody", async () => {
  const resend = loadResendConfig({ RESEND_API_KEY: KEY, RESEND_FROM: "Pako <hello@pako-os.com>" }).config;
  assert.equal(chooseSender({ resend, agentmail: AGENTMAIL })?.via, "resend");
  assert.equal(chooseSender({ resend, agentmail: null })?.via, "resend", "Resend alone is enough to send");
  assert.equal(chooseSender({ resend: null, agentmail: null }), null);

  // No Resend key: the AgentMail inbox's own send, unchanged (no Resend request, no idempotency header).
  const net = fake();
  const am = chooseSender({ resend: loadResendConfig({}).config, agentmail: AGENTMAIL, fetch: net.f })!;
  assert.equal(am.via, "agentmail");
  await am.send({ to: "ana@example.com", subject: "Hola", text: "Llego tarde", idempotencyKey: "pako-email-abc" });
  assert.equal(net.seen.length, 1);
  assert.equal(net.seen[0]!.url, "https://api.agentmail.to/v0/inboxes/pako%40agentmail.to/messages/send");
  assert.deepEqual(net.seen[0]!.body, { to: ["ana@example.com"], subject: "Hola", text: "Llego tarde" });
  assert.equal(net.seen[0]!.headers["idempotency-key"], undefined);
  assert.equal(net.seen[0]!.headers.authorization, `Bearer ${AGENTMAIL.apiKey}`);
});

test("the request: POST /emails with the key, from, to, subject, text, reply_to and the Idempotency-Key", async () => {
  const net = fake(() => new Response(JSON.stringify({ id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }), { status: 200 }));
  const config = { apiKey: KEY, from: "Pako <hello@pako-os.com>", replyTo: "owner@example.com" };
  const sent = await sendViaResend(config, { to: "ana@example.com", subject: "Message from Marta", text: "On behalf of Marta…", idempotencyKey: "pako-email-0123456789" }, net.f);
  assert.equal(sent.id, "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794");
  const r = net.seen[0]!;
  assert.equal(r.url, "https://api.resend.com/emails");
  assert.equal(r.method, "POST");
  assert.equal(r.headers.authorization, `Bearer ${KEY}`);
  assert.equal(r.headers["content-type"], "application/json");
  assert.equal(r.headers["idempotency-key"], "pako-email-0123456789");
  assert.deepEqual(r.body, { from: "Pako <hello@pako-os.com>", to: ["ana@example.com"], subject: "Message from Marta", text: "On behalf of Marta…", reply_to: "owner@example.com" });

  // Through the chooser: RESEND_REPLY_TO wins over the AgentMail inbox; without either there is no reply_to.
  const both = fake();
  await chooseSender({ resend: config, agentmail: AGENTMAIL, fetch: both.f })!.send({ to: "a@b.com", subject: "s", text: "t", idempotencyKey: "k1" });
  assert.equal(both.seen[0]!.body!.reply_to, "owner@example.com");
  const alone = fake();
  await chooseSender({ resend: { apiKey: KEY, from: "hello@pako-os.com" }, agentmail: null, fetch: alone.f })!.send({ to: "a@b.com", subject: "s", text: "t" });
  assert.equal(Object.hasOwn(alone.seen[0]!.body!, "reply_to"), false);
  assert.equal(alone.seen[0]!.headers["idempotency-key"], undefined, "no id, no header");
});

test("a refusal: the status and Resend's own reason travel with the error (one line, short); no answer has no status", async () => {
  const config = { apiKey: KEY, from: "hello@pako-os.com" };
  const refused = fake(() => new Response(JSON.stringify({ statusCode: 422, name: "validation_error", message: "Invalid `to` field.\nThe email address needs to follow the `email@example.com` format." }), { status: 422 }));
  const err = await sendViaResend(config, { to: "x", subject: "s", text: "t" }, refused.f).then(() => null, (e: Error & { status?: number; why?: string }) => e);
  assert.ok(err);
  assert.equal(err.status, 422);
  assert.equal(err.why, "Invalid `to` field. The email address needs to follow the `email@example.com` format.");
  assert.match(err.message, /^Resend answered 422 to the send: Invalid/);
  const html = fake(() => new Response("<html>bad gateway</html>", { status: 502 }));
  const e502 = await sendViaResend(config, { to: "a@b.com", subject: "s", text: "t" }, html.f).then(() => null, (e: Error & { status?: number; why?: string }) => e);
  assert.deepEqual([e502?.status, e502?.why], [502, ""]);
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  const e0 = await sendViaResend(config, { to: "a@b.com", subject: "s", text: "t" }, down).then(() => null, (e: Error & { status?: number }) => e);
  assert.equal(e0?.status, undefined, "no answer: it may have gone, and the door never sends it again");
});

test("the key check: GET /domains; accepted with its domains, a sending-only key accepted, a wrong key refused, no answer said so", async () => {
  const ok = fake(() => new Response(JSON.stringify({ data: [{ name: "pako-os.com", status: "verified" }] }), { status: 200 }));
  assert.deepEqual(await checkResendKey(KEY, ok.f), { ok: true, domains: ["pako-os.com (verified)"] });
  assert.equal(ok.seen[0]!.url, "https://api.resend.com/domains");
  assert.equal(ok.seen[0]!.method, "GET");
  assert.equal(ok.seen[0]!.headers.authorization, `Bearer ${KEY}`);
  const restricted = fake(() => new Response(JSON.stringify({ statusCode: 401, name: "restricted_api_key", message: "This API key is restricted to only send emails" }), { status: 401 }));
  assert.deepEqual(await checkResendKey(KEY, restricted.f), { ok: true, domains: [] });
  const wrong = fake(() => new Response(JSON.stringify({ statusCode: 400, name: "validation_error", message: "API key is invalid" }), { status: 401 }));
  assert.deepEqual(await checkResendKey(KEY, wrong.f), { ok: false, why: "resendRefused" });
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  assert.deepEqual(await checkResendKey(KEY, down), { ok: false, why: "resendNoAnswer" });
});

test("the panel: a Resend card with the key, the sender and the reply-to; the key a secret never moved or exported as a plain setting", () => {
  const card = CATALOGUE.find((c) => c.id === "resend")!;
  assert.deepEqual(card.fields.map((f) => [f.key, !!f.optional]), [["RESEND_API_KEY", false], ["RESEND_FROM", false], ["RESEND_REPLY_TO", true]]);
  for (const k of ["RESEND_API_KEY", "RESEND_FROM", "RESEND_REPLY_TO"]) assert.ok(KEYS.has(k), k);
  assert.deepEqual(card.check!({ RESEND_API_KEY: "nope", RESEND_FROM: "hello@pako-os.com" }), ["RESEND_API_KEY"]);
  assert.ok(!(MOVE_SETTINGS as readonly string[]).includes("RESEND_API_KEY"), "the key never travels with the settings a computer takes over");
});

test("the panel routes: saving tries the key first (a refused one is not kept); Check tries the typed key or the saved one, and never echoes it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pako-resend-"));
  let answer: () => Response = () => new Response(JSON.stringify({ data: [{ name: "pako-os.com", status: "verified" }] }), { status: 200 });
  const net = fake(() => answer());
  const app = express();
  mountConnectionsPanel(app, {
    signedIn: (req) => req.get("cookie") === "ok=1", env: { PAKO_HOME: dir }, lang: () => "en", dir, fromStore: () => new Set<string>(),
    restart: () => undefined, fetch: net.f,
  });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(`${base}/panel/api/connections${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: "ok=1", "x-pako": "1" }, body: JSON.stringify(body) });
  try {
    // Nothing typed and nothing saved: asked for a key, Resend not asked.
    const none = await post("/resend/check", {});
    assert.equal(none.status, 400);
    assert.equal(net.seen.length, 0);

    // A refused key is not saved.
    answer = () => new Response(JSON.stringify({ name: "validation_error", message: "API key is invalid" }), { status: 401 });
    const refused = await post("", { id: "resend", values: { RESEND_API_KEY: KEY, RESEND_FROM: "Pako <hello@pako-os.com>" } });
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { ok: false, error: "Resend doesn't accept that key. Copy it again from its dashboard (API Keys).", field: "RESEND_API_KEY" });
    assert.equal(readStored(dir)?.RESEND_API_KEY, undefined);
    assert.equal(net.seen.at(-1)!.url, "https://api.resend.com/domains");

    // An accepted one is kept with the other secrets.
    answer = () => new Response(JSON.stringify({ data: [{ name: "pako-os.com", status: "verified" }] }), { status: 200 });
    const saved = await post("", { id: "resend", values: { RESEND_API_KEY: KEY, RESEND_FROM: "Pako <hello@pako-os.com>", RESEND_REPLY_TO: "me@example.com" } });
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.deepEqual(readStored(dir), { RESEND_API_KEY: KEY, RESEND_FROM: "Pako <hello@pako-os.com>", RESEND_REPLY_TO: "me@example.com" });

    // Check with nothing typed: the saved key. The answer names the domains, never the key.
    const before = net.seen.length;
    const checked = await post("/resend/check", {});
    const text = await checked.text();
    assert.deepEqual(JSON.parse(text), { ok: true, domains: ["pako-os.com (verified)"] });
    assert.equal(net.seen.length, before + 1);
    assert.equal(net.seen.at(-1)!.headers.authorization, `Bearer ${KEY}`);
    assert.ok(!text.includes(KEY));
    // A typed key is the one tried.
    await post("/resend/check", { key: "re_typed_key_123456" });
    assert.equal(net.seen.at(-1)!.headers.authorization, "Bearer re_typed_key_123456");
    // The panel's protection: no x-pako header, no check.
    const bare = await fetch(`${base}/panel/api/connections/resend/check`, { method: "POST", headers: { "content-type": "application/json", cookie: "ok=1" }, body: "{}" });
    assert.equal(bare.status, 401);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
