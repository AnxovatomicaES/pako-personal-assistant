import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { authenticated } from "../src/mail-categories.ts";
import { accountOf, addressOf, bodyText, createMailbox, headerValues, htmlToText, isBulk, isVip, loadMailConfig, mountMail, takeMail, verifySvix, type MailConfig, type RecentMail } from "../src/mail.ts";
import { createInbox, type Inbound } from "../src/whatsapp.ts";

const SECRET = `whsec_${Buffer.from("a-test-signing-key-0123456789").toString("base64")}`;
const sign = (id: string, ts: number, body: string, secret = SECRET) =>
  `v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${ts}.${body}`).digest("base64")}`;
const CONFIG: MailConfig = { apiKey: "am_test_key_0123456789", inbox: "yo-asistente@agentmail.to", webhookSecret: SECRET, pollMinutes: 0, workDomains: ["empresa.example"], vip: ["@jefe.example"] };

test("loadMailConfig: off with nothing set; each wrong value is named and keeps it off; the poll defaults to 10 minutes", () => {
  assert.deepEqual(loadMailConfig({}), { config: null, problems: [] });
  const bad = loadMailConfig({ AGENTMAIL_API_KEY: "x", AGENTMAIL_INBOX: "a b", AGENTMAIL_WEBHOOK_SECRET: "secret" });
  assert.equal(bad.config, null);
  assert.equal(bad.problems.length, 3);
  const ok = loadMailConfig({ AGENTMAIL_API_KEY: CONFIG.apiKey, AGENTMAIL_INBOX: CONFIG.inbox, AGENTMAIL_WEBHOOK_SECRET: SECRET });
  assert.equal(ok.config?.pollMinutes, 10);
  assert.equal(loadMailConfig({ AGENTMAIL_API_KEY: CONFIG.apiKey, AGENTMAIL_INBOX: CONFIG.inbox, AGENTMAIL_WEBHOOK_SECRET: SECRET, AGENTMAIL_POLL_MINUTES: "-1" }).config, null);
});

test("verifySvix: the right signature passes (among several); a wrong secret, a changed body or an old timestamp does not", () => {
  const now = 1_800_000_000_000;
  const ts = now / 1000;
  const body = '{"a":1}';
  const h = { id: "msg_1", timestamp: String(ts), signature: `v1,AAAA ${sign("msg_1", ts, body)}` };
  assert.equal(verifySvix(SECRET, h, Buffer.from(body), now), true);
  assert.equal(verifySvix(SECRET, { ...h, signature: sign("msg_1", ts, body, `whsec_${Buffer.from("other-key-0123456789abc").toString("base64")}`) }, Buffer.from(body), now), false);
  assert.equal(verifySvix(SECRET, h, Buffer.from('{"a":2}'), now), false);
  assert.equal(verifySvix(SECRET, h, Buffer.from(body), now + 10 * 60_000), false, "older than five minutes");
  assert.equal(verifySvix(SECRET, { ...h, signature: undefined }, Buffer.from(body), now), false);
});

test("bodyText: the extracted new text first, then text, then HTML made plain, then the preview", () => {
  assert.equal(bodyText({ extracted_text: "nuevo", text: "nuevo\n> viejo" }), "nuevo");
  assert.equal(bodyText({ text: "solo texto" }), "solo texto");
  assert.equal(bodyText({ html: "<style>p{}</style><p>Hola&nbsp;<b>Marta</b></p><p>Adiós</p>" }), "Hola Marta\nAdiós");
  assert.equal(bodyText({ preview: "vista previa" }), "vista previa");
  assert.equal(htmlToText("a<br>b &amp; c"), "a\nb & c");
});

async function rig(fetchImpl?: typeof fetch) {
  const queued: Inbound[] = [];
  let failNext = false;
  const box = createMailbox(null);
  const app = express();
  let clock = 1_800_000_000_000;
  const mail = mountMail(app, {
    config: CONFIG,
    box,
    now: () => clock,
    fetch: fetchImpl ?? (async (input) => (String(input).endsWith("/inboxes/yo-asistente%40agentmail.to") ? new Response(JSON.stringify({ inbox_id: "inbox_123", email: CONFIG.inbox })) : new Response("{}", { status: 500 }))),
    enqueue: async (m) => {
      if (failNext) {
        failNext = false;
        throw new Error("store down");
      }
      if (queued.some((q) => q.id === m.id)) return false;
      queued.push(m);
      return true;
    },
  });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let n = 0;
  const post = (event: unknown, opts: { badSig?: boolean } = {}) => {
    const body = JSON.stringify(event);
    const id = `msg_${++n}`;
    const ts = Math.floor(clock / 1000);
    return fetch(`${base}/email/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(ts), "svix-signature": opts.badSig ? "v1,AAAA" : sign(id, ts, body) },
      body,
    });
  };
  return {
    queued,
    box,
    mail,
    post,
    failOnce: () => (failNext = true),
    tick: (ms: number) => (clock += ms),
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

const event = (message: Record<string, unknown>, eventType = "message.received") => ({
  type: "event",
  event_type: eventType,
  event_id: `evt_${String(message.message_id)}`,
  message: { inbox_id: CONFIG.inbox, labels: ["received"], to: [CONFIG.inbox], timestamp: "2026-11-14T20:00:00Z", ...message },
  thread: {},
});

test("webhook: a signed email is passed on once, with sender, subject, words and attachment names; retries, spam and other inboxes are not", async () => {
  const r = await rig();
  try {
    assert.equal((await r.post(event({ message_id: "<a@x>" }), { badSig: true })).status, 401);
    const first = await r.post(event({ message_id: "<a@x>", from: "Ana <ana@example.com>", subject: "Cena  el\nviernes", extracted_text: "¿Vienes a las 21?", attachments: [{ attachment_id: "1", filename: "menu.pdf" }] }));
    assert.equal(first.status, 200);
    assert.equal(r.queued.length, 1);
    assert.deepEqual(r.queued[0]!.email, { from: "Ana <ana@example.com>", subject: "Cena el viernes", text: "¿Vienes a las 21?", attachments: ["menu.pdf"], account: "directo", vip: false });
    assert.equal(r.queued[0]!.id, "mail:<a@x>");
    assert.equal(r.queued[0]!.text, "");
    await r.post(event({ message_id: "<a@x>", extracted_text: "otra vez" }));
    assert.equal(r.queued.length, 1, "AgentMail delivers at least once: the same email is passed on once");
    await r.post(event({ message_id: "<s@x>", labels: ["received", "spam"], text: "gana dinero" }));
    await r.post(event({ message_id: "<b@x>", text: "x" }, "message.received.blocked"));
    await r.post(event({ message_id: "<o@x>", inbox_id: "otro@agentmail.to", to: ["otro@agentmail.to"], text: "x" }));
    assert.equal(r.queued.length, 1, "spam, blocked and another inbox's mail are dropped");
    const lines = await r.box.recent("Europe/Madrid");
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /14\/11.*21:00 from Ana <ana@example\.com> “Cena el viernes”: ¿Vienes a las 21\?/);
  } finally {
    r.close();
  }
});

test("webhook: an email that could not be queued answers 503 and goes through on AgentMail's retry", async () => {
  const r = await rig();
  try {
    r.failOnce();
    assert.equal((await r.post(event({ message_id: "<c@x>", text: "hola" }))).status, 503);
    assert.equal(r.queued.length, 0);
    assert.equal((await r.post(event({ message_id: "<c@x>", text: "hola" }))).status, 200);
    assert.equal(r.queued.length, 1);
  } finally {
    r.close();
  }
});

test("webhook: an email without its body (over 64 KiB) is read from the body link, else from the API with the key", async () => {
  const asked: { url: string; auth: string | null }[] = [];
  const r = await rig(async (input, init) => {
    const url = String(input);
    asked.push({ url, auth: new Headers(init?.headers).get("authorization") });
    if (url.startsWith("https://bodies.example/")) return new Response(JSON.stringify({ text: "cuerpo largo" }));
    if (url.includes("/messages/")) return new Response(JSON.stringify({ html: "<p>desde la API</p>" }));
    if (url.endsWith("/inboxes/yo-asistente%40agentmail.to")) return new Response(JSON.stringify({ inbox_id: "inbox_123" }));
    return new Response("{}", { status: 404 });
  });
  try {
    await r.post(event({ message_id: "<big@x>", body_url: "https://bodies.example/1" }));
    await r.post(event({ message_id: "<big2@x>" }));
    assert.deepEqual(r.queued.map((q) => q.email?.text), ["cuerpo largo", "desde la API"]);
    assert.equal(asked[0]!.auth, null, "the signed body link gets no key");
    assert.equal(asked[1]!.url, "https://api.agentmail.to/v0/inboxes/yo-asistente%40agentmail.to/messages/%3Cbig2%40x%3E");
    assert.equal(asked[1]!.auth, `Bearer ${CONFIG.apiKey}`);
  } finally {
    r.close();
  }
});

test("listing (the safety net): the first run only marks what is already there; later runs pass on what the webhook missed, oldest first", async () => {
  let listed: Record<string, unknown>[] = [{ message_id: "<old@x>", labels: ["received"], from: "viejo@x", preview: "viejo" }];
  const r = await rig(async (input) => {
    const url = String(input);
    if (url.endsWith("/messages?limit=25")) return new Response(JSON.stringify({ count: listed.length, messages: listed }));
    const id = decodeURIComponent(url.split("/messages/")[1] ?? "");
    return new Response(JSON.stringify({ message_id: id, text: `texto de ${id}` }));
  });
  try {
    assert.equal(await r.mail.poll(), 0);
    assert.equal(r.queued.length, 0, "the mail already in the inbox is not announced");
    listed = [
      { message_id: "<n2@x>", labels: ["received"], from: "dos@x", timestamp: "2026-11-14T21:00:00Z" },
      { message_id: "<n1@x>", labels: ["received"], from: "uno@x", timestamp: "2026-11-14T20:00:00Z" },
      { message_id: "<sp@x>", labels: ["spam"], from: "spam@x" },
      ...listed,
    ];
    assert.equal(await r.mail.poll(), 2);
    assert.deepEqual(r.queued.map((q) => [q.email?.from, q.email?.text]), [["uno@x", "texto de <n1@x>"], ["dos@x", "texto de <n2@x>"]]);
    assert.equal(await r.mail.poll(), 0, "nothing twice");
  } finally {
    r.close();
  }
});

test("the assistant inbox keeps an email with its parts, its text capped", async () => {
  const inbox = createInbox(null);
  assert.equal(await inbox.add({ id: "mail:<z@x>", at: 1, text: "", email: { from: "a@x", subject: "s", text: "x".repeat(20_000), attachments: ["f.pdf"] } }), true);
  const [m] = await inbox.peek();
  assert.equal(m!.email?.from, "a@x");
  assert.equal(m!.email?.text.length, 12_000);
  assert.deepEqual(m!.email?.attachments, ["f.pdf"]);
});

test("triage helpers: mass mail by its headers (any shape), whose account it is, VIP senders", () => {
  assert.deepEqual(headerValues({ headers: { "List-Unsubscribe": "<mailto:x>" } }, ["list-unsubscribe"]), ["<mailto:x>"]);
  assert.deepEqual(headerValues({ headers: [{ name: "Delivered-To", value: "a@b.c" }] }, ["delivered-to"]), ["a@b.c"]);
  assert.equal(isBulk({ headers: { "List-Id": "news.example" } }), true);
  assert.equal(isBulk({ headers: [{ name: "Precedence", value: "bulk" }] }), true);
  assert.equal(isBulk({ headers: { Subject: "Tu código" } }), false, "a code or an alert is not mass mail");
  assert.equal(accountOf({ headers: { "Delivered-To": "marta@empresa.example" } }, CONFIG), "trabajo");
  assert.equal(accountOf({ to: ["marta@gmail.example"] }, CONFIG), "personal");
  assert.equal(accountOf({ to: [CONFIG.inbox] }, CONFIG), "directo");
  assert.equal(isVip("Jefa <ceo@jefe.example>", CONFIG.vip), true);
  assert.equal(isVip("otro@ejemplo.example", CONFIG.vip), false);
  const env = { AGENTMAIL_API_KEY: CONFIG.apiKey, AGENTMAIL_INBOX: CONFIG.inbox, AGENTMAIL_WEBHOOK_SECRET: SECRET };
  assert.deepEqual(loadMailConfig(env).config?.workDomains, [], "no work domain unless the owner names one");
  assert.deepEqual(loadMailConfig({ ...env, AGENTMAIL_VIP: "ceo@x.example, @y.example" }).config?.vip, ["ceo@x.example", "@y.example"]);
  assert.equal(loadMailConfig({ ...env, AGENTMAIL_VIP: "not an address" }).config, null);
});

test("triage: mass mail is kept without asking Claude (unless the sender is VIP); forwarded work mail is marked; an opaque inbox id is learned", async () => {
  const r = await rig();
  try {
    await r.post(event({ message_id: "<news@x>", inbox_id: "inbox_123", to: ["marta@gmail.example"], from: "Tienda <ofertas@tienda.example>", subject: "-50%", text: "rebajas", headers: { "List-Unsubscribe": "<mailto:u@tienda.example>", "Authentication-Results": "mx.owner.example; dkim=pass header.d=tienda.example" } }));
    assert.equal(r.queued.length, 0, "no run of Claude for a newsletter");
    await r.post(event({ message_id: "<vip@x>", inbox_id: "inbox_123", from: "CEO <ceo@jefe.example>", subject: "Informe", text: "x", headers: { "List-Id": "board" } }));
    await r.post(event({ message_id: "<work@x>", inbox_id: "inbox_123", to: ["marta@empresa.example"], from: "Colega <c@empresa.example>", subject: "Reunión", text: "¿mañana a las 10?" }));
    await r.post(event({ message_id: "<other@x>", inbox_id: "inbox_999", text: "de otro buzón" }));
    assert.deepEqual(r.queued.map((q) => [q.email?.from, q.email?.account, q.email?.vip]), [["CEO <ceo@jefe.example>", "directo", true], ["Colega <c@empresa.example>", "trabajo", false]]);

    assert.equal(await r.box.annotate("<vip@x>", "aviso", "Careful: this looks like a scam attempt.", Date.now(), { scam: true }), true);
    assert.equal((await r.box.items()).find((m) => m.id === "<vip@x>")?.scam, true, "the panel marks it from the flag, whatever the language");
    assert.equal(await r.box.annotate("<vip@x>", "guardado", "Un informe."), true);
    assert.equal((await r.box.items()).find((m) => m.id === "<vip@x>")?.scam, undefined, "summarized again by a bridge that gives no verdict: the flag goes");
    assert.equal(await r.box.annotate("<vip@x>", "guardado", "Tu banco recuerda cómo evitar el phishing.", Date.now(), { scam: false }), true);
    assert.equal((await r.box.items()).find((m) => m.id === "<vip@x>")?.scam, false, "'not a scam' is kept: the panel does not guess from the words");
    assert.equal(await r.box.annotate("<vip@x>", "guardado", "Un informe."), true);
    assert.equal(await r.box.annotate("<work@x>", "aviso", "Pregunta si os veis mañana a las 10."), true);
    const ctx = await r.box.recent("Europe/Madrid", Date.parse("2026-11-14T21:00:00Z"));
    assert.match(ctx[0]!, /\[work\] from Colega <c@empresa\.example> “Reunión”: Pregunta si os veis mañana a las 10\./);
    assert.equal(ctx.at(-1), "and 1 bulk email(s) in the last 24 h (newsletters, offers, notifications)");
    const digest = await r.box.digest("Europe/Madrid", Date.parse("2026-11-14T21:00:00Z"));
    assert.match(digest, /^📥 Email in the last 24 h: 3\./);
    assert.match(digest, /Needs you \(1\):\n• .*Reunión/, "told, and its summary asks something");
    assert.match(digest, /Important \(1\):\n• .*Informe/);
    assert.match(digest, /Promotions \(1\): Tienda/);
    assert.equal(await r.box.digest("Europe/Madrid", Date.parse("2026-11-20T00:00:00Z")), "📭 No email in the last 24 hours.");
  } finally {
    r.close();
  }
});

test("bug hunt: one listed email that cannot be fetched does not stop the others", async () => {
  let listed: Record<string, unknown>[] = [];
  const r = await rig(async (input) => {
    const url = String(input);
    if (url.endsWith("/messages?limit=25")) return new Response(JSON.stringify({ count: listed.length, messages: listed }));
    if (url.includes("%3Cbad%40x%3E")) return new Response("{}", { status: 500 });
    const id = decodeURIComponent(url.split("/messages/")[1] ?? "");
    return new Response(JSON.stringify({ message_id: id, text: `texto de ${id}` }));
  });
  const keep = console.error;
  console.error = () => undefined;
  try {
    await r.mail.poll();
    listed = [
      { message_id: "<good@x>", labels: ["received"], from: "b@x", timestamp: "2026-11-14T21:00:00Z" },
      { message_id: "<bad@x>", labels: ["received"], from: "a@x", timestamp: "2026-11-14T20:00:00Z" },
    ];
    assert.equal(await r.mail.poll(), 1);
    assert.deepEqual(r.queued.map((q) => q.email?.from), ["b@x"]);
  } finally {
    console.error = keep;
    r.close();
  }
});

test("sendEmail: one POST from the assistant's inbox with the key; a read-only key's 403 names the permission; nothing else is sent", async () => {
  const { sendEmail } = await import("../src/mail.ts");
  const calls: { url: string; auth: string; body: Record<string, unknown> }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), auth: String((init?.headers as Record<string, string>).authorization), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: calls.length === 1 ? 200 : 403 });
  }) as typeof fetch;
  await sendEmail(CONFIG, { to: "reservas@calpep.example", subject: "Solicitud de mesa", text: "Hola" }, f);
  assert.deepEqual(calls[0], { url: "https://api.agentmail.to/v0/inboxes/yo-asistente%40agentmail.to/messages/send", auth: `Bearer ${CONFIG.apiKey}`, body: { to: ["reservas@calpep.example"], subject: "Solicitud de mesa", text: "Hola" } });
  await assert.rejects(() => sendEmail(CONFIG, { to: "a@b.es", subject: "x", text: "y" }, f), /403.*message_send/);
});

// ---------- bug hunt 2: regression tests ----------

test("mail: a hostile body cannot freeze the server (the HTML is only read when there is no text, and in linear time); entities decode once", () => {
  // CPU time, not the wall clock: on a machine busy with other work the wall clock says nothing about this code's own cost.
  const t0 = process.cpuUsage();
  assert.equal(bodyText({ text: "hola", html: "<".repeat(65_536) }), "hola", "a text part is never traded for the HTML");
  htmlToText("<".repeat(80_000));
  htmlToText("<style>".repeat(10_000));
  htmlToText(`${" ".repeat(80_000)}x`);
  htmlToText(`<a ${"<b ".repeat(100_000)}`);
  // Under half a second on a laptop; the version this replaced took over a minute on the same input.
  const used = process.cpuUsage(t0);
  const ms = (used.user + used.system) / 1000;
  assert.ok(ms < 4000, `took ${ms} ms of CPU`);
  assert.equal(htmlToText("<p>Caf&eacute; &amp;lt;b&amp;gt; &iacute; &#8217; &euro;5</p><script>alert(1)</script><p>fin</p>"), "Café &lt;b&gt; í ’ €5\nfin");
  assert.equal(htmlToText("a < b and c > d"), "a < b and c > d", "a lone < is text");
});

test("mail: an HTML5 <header> is not a <head>: its words are kept; a real head, with or without attributes, is still dropped", () => {
  const html = "<html><body><header><h1>Invoice 4471: payment due Friday</h1></header><p>Hello, see the details below.</p></body></html>";
  assert.equal(htmlToText(html), "Invoice 4471: payment due Friday\nHello, see the details below.");
  assert.equal(bodyText({ html }), "Invoice 4471: payment due Friday\nHello, see the details below.", "an email with only an HTML part");
  assert.equal(htmlToText("<html><head><title>Hidden</title></head><body><p>Shown</p></body></html>"), "Shown");
  assert.equal(htmlToText("<HEAD lang=en><meta charset=utf-8><title>Hidden</title></HEAD ><p>Shown</p>"), "Shown");
  // A header inside a real head does not end it early, and a <header> after it is kept.
  assert.equal(htmlToText("<head><header>Hidden</header><title>Hidden too</title></head><header>Shown</header><p>and this</p>"), "Shown and this");
});

test("mail: a display name that looks like an address does not make a VIP; invisible characters are removed from what reaches the phone", () => {
  assert.equal(isVip('"<ceo@jefe.example>" <attacker@evil.example>', ["@jefe.example"]), false);
  assert.equal(isVip('"Jefe" <ceo@jefe.example>', ["@jefe.example"]), true);
  assert.equal(bodyText({ text: "pagar‮ 100​€" }), "pagar 100€");
});

test("mail: an address inside a comment of the From line is not the sender: it makes no VIP and vouches for nothing", async () => {
  // RFC 5322 comments, "(...)", may hold anything; the sender, and what the mail server checked, is the address outside them.
  const boss = "pay@evil.example (Your boss <boss@jefe.example>)";
  assert.equal(addressOf(boss), "pay@evil.example");
  assert.equal(addressOf("a@evil.example (nested (<boss@jefe.example>) twice) <b@evil.example>"), "b@evil.example");
  assert.equal(addressOf("a@evil.example (never closed <boss@jefe.example>"), "a@evil.example");
  assert.equal(isVip(boss, ["boss@jefe.example"]), false);
  assert.equal(isVip(boss, ["@jefe.example"]), false);
  assert.equal(authenticated(boss, ["mx.owner.example; dkim=pass header.d=jefe.example"]), false, "signed for the real domain only");
  assert.equal(authenticated(boss, ["mx.owner.example; dkim=pass header.d=evil.example"]), true);
  // A real VIP with a comment, or with brackets in a quoted name, still is one.
  assert.equal(isVip("Boss (the CEO) <boss@jefe.example>", ["boss@jefe.example"]), true);
  assert.equal(addressOf('"Smith (CEO)" <smith@jefe.example>'), "smith@jefe.example");
  // Through the intake: not marked VIP, so it is not told whatever the triage files it as.
  const queued: Inbound[] = [];
  const box = createMailbox(null);
  const d = { box, enqueue: async (m: Inbound) => (queued.push(m), true), lang: () => "en" as const, now: () => 1_800_000_000_000, vip: ["boss@jefe.example"] };
  await takeMail(d, "v1", { from: boss, subject: "Urgent wire", text: "Please pay the invoice today.", timestamp: new Date(1_800_000_000_000 - 3600_000).toISOString() }, "personal");
  assert.equal(queued[0]!.email?.vip, false);
  assert.equal((await box.get("v1"))?.vip, undefined);
});

test("mail: what the assistant itself sent is not announced as incoming mail, and a date in the future is today", async () => {
  let listed: Record<string, unknown>[] = [];
  const r = await rig(async (input) => {
    const url = String(input);
    if (url.endsWith("/messages?limit=25")) return new Response(JSON.stringify({ messages: listed }));
    return new Response(JSON.stringify({ message_id: decodeURIComponent(url.split("/messages/")[1] ?? ""), text: "hola" }));
  });
  try {
    await r.mail.poll(); // priming
    listed = [
      { message_id: "<out1@x>", labels: ["sent"], from: "yo-asistente@agentmail.to", subject: "Solicitud de mesa" },
      { message_id: "<out2@x>", labels: ["received"], from: "Pako <yo-asistente@agentmail.to>", subject: "Solicitud de mesa" },
      { message_id: "<in1@x>", labels: ["received"], from: "ana@x", timestamp: "2099-01-01T00:00:00Z" },
    ];
    assert.equal(await r.mail.poll(), 1);
    assert.deepEqual(r.queued.map((q) => q.email?.from), ["ana@x"]);
    assert.ok(r.queued[0]!.at <= 1_800_000_000_000, "the 2099 date is clamped to now");
  } finally {
    r.close();
  }
});

test("mailbox: the newest 150 records are kept, and with them every Needs you or Waiting on others mail not dealt with, for 30 days; done, replied and older ones give way", async () => {
  const DAY = 24 * 3600_000;
  const NOW = Date.UTC(2026, 10, 20, 10, 0, 0);
  const box = createMailbox(null);
  const mail = (id: string, at: number, o: Partial<RecentMail> = {}): RecentMail => ({ id, at, from: "Dana <dana@client.example>", subject: id, preview: "", kind: "aviso", ...o });
  await box.record(mail("ask", NOW, { category: "needs_you" }), "", NOW);
  await box.record(mail("owed", NOW, { category: "waiting" }), "", NOW);
  await box.record(mail("done", NOW, { category: "needs_you", handledAt: NOW }), "", NOW);
  await box.record(mail("replied", NOW, { category: "needs_you", repliedAt: NOW }), "", NOW);
  await box.record(mail("fyi", NOW, { category: "important" }), "", NOW);
  await box.record(mail("stale", NOW - 31 * DAY, { category: "needs_you" }), "", NOW);
  // Three days of an ordinary inbox: 150 newsletters, offers and notices after them.
  for (let i = 1; i <= 150; i++) await box.record(mail(`bulk${i}`, NOW + i * 28 * 60_000, { kind: "masivo", category: "promotions" }), "", NOW + i * 28 * 60_000);
  const kept = async (id: string) => !!(await box.get(id));
  assert.deepEqual([await kept("ask"), await kept("owed")], [true, true], "what the owner has not dealt with is kept past the newest 150");
  assert.deepEqual([await kept("done"), await kept("replied"), await kept("fyi"), await kept("stale")], [false, false, false, false],
    "done, replied to, only to read, or older than the 30 days the dashboard shows: they give way as before");
  assert.equal((await box.items(Infinity)).length, 152, "the newest 150 and the two");
  assert.equal(await kept("bulk1"), true);
  assert.equal(await kept("bulk150"), true);
  // Once the owner marks it done, the next record lets it go; after 30 days an untouched one goes too.
  await box.handle("ask", true, NOW + 4 * DAY);
  await box.record(mail("bulk151", NOW + 3 * DAY, { kind: "masivo", category: "promotions" }), "", NOW + 3 * DAY);
  assert.equal(await kept("ask"), false, "done: no longer spared");
  assert.equal(await kept("owed"), true);
  await box.record(mail("bulk152", NOW + 31 * DAY, { kind: "masivo", category: "promotions" }), "", NOW + 31 * DAY);
  assert.equal(await kept("owed"), false, "past the 30 days: no longer spared");
});
