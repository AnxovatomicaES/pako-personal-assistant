import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createControl } from "../src/control.ts";
import { inQuiet, loadSlackConfig, mountSlack, mountSlackCheckOnly, plainSlack, verifySlack, type SlackConfig } from "../src/slack.ts";

const SECRET = "0123456789abcdef0123456789abcdef";
const TOKEN = "xoxp-1234567890-1234567890-abcdefghijklmnop";
const sign = (ts: number, body: string, secret = SECRET) => `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;

test("loadSlackConfig: off with nothing; each value checked; quiet hours parsed or off", () => {
  assert.deepEqual(loadSlackConfig({}), { config: null, problems: [] });
  assert.equal(loadSlackConfig({ SLACK_USER_TOKEN: "xoxb-bot" }).problems.length, 1, "a bot token (the user token alone is enough: Pako looks itself)");
  const ok = loadSlackConfig({ SLACK_USER_TOKEN: TOKEN, SLACK_SIGNING_SECRET: SECRET }).config;
  assert.deepEqual(ok?.quiet, { start: 23 * 60, end: 8 * 60 });
  assert.equal(loadSlackConfig({ SLACK_USER_TOKEN: TOKEN, SLACK_SIGNING_SECRET: SECRET, SLACK_QUIET_HOURS: "off" }).config?.quiet, null);
  assert.equal(loadSlackConfig({ SLACK_USER_TOKEN: TOKEN, SLACK_SIGNING_SECRET: SECRET, SLACK_QUIET_HOURS: "late" }).config, null);
  assert.equal(ok?.forward, false, "Slack already notifies the owner: no copy unless asked");
  assert.equal(loadSlackConfig({ SLACK_USER_TOKEN: TOKEN, SLACK_SIGNING_SECRET: SECRET, SLACK_FORWARD: "on" }).config?.forward, true);
  assert.equal(loadSlackConfig({ SLACK_USER_TOKEN: TOKEN, SLACK_SIGNING_SECRET: SECRET, SLACK_FORWARD: "maybe" }).config, null);
});

test("verifySlack, plainSlack and inQuiet", () => {
  const now = 1_800_000_000_000;
  const ts = now / 1000;
  assert.equal(verifySlack(SECRET, String(ts), sign(ts, "{}"), Buffer.from("{}"), now), true);
  assert.equal(verifySlack(SECRET, String(ts), sign(ts, "{}", "f".repeat(32)), Buffer.from("{}"), now), false);
  assert.equal(verifySlack(SECRET, String(ts), sign(ts, "{}"), Buffer.from("{}"), now + 6 * 60_000), false, "older than five minutes");
  assert.equal(
    plainSlack("<@U1> mira <#C9|proyecto> y <https://x.example|esto> &amp; <!here>", (id) => (id === "U1" ? "Ana" : "?")),
    "@Ana mira #proyecto y esto (https://x.example) & @here",
  );
  const q = { start: 23 * 60, end: 8 * 60 };
  assert.equal(inQuiet(q, Date.parse("2026-11-14T23:30:00Z"), "Europe/Madrid"), true, "00:30 in Madrid");
  assert.equal(inQuiet(q, Date.parse("2026-11-14T10:00:00Z"), "Europe/Madrid"), false);
  assert.equal(inQuiet(null, Date.parse("2026-11-14T23:30:00Z"), "Europe/Madrid"), false);
});

async function rig(o: { quiet?: SlackConfig["quiet"]; clock?: number; authFailsOnce?: boolean; forward?: boolean } = {}) {
  let authFails = o.authFailsOnce === true;
  const told: string[] = [];
  const asked: string[] = [];
  const clock = { now: o.clock ?? Date.parse("2026-11-14T11:00:00Z") };
  const control = createControl(null);
  const fake = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const method = url.pathname.split("/").pop()!;
    asked.push(method);
    const json = (b: unknown) => new Response(JSON.stringify(b));
    if (method === "auth.test" && authFails) {
      authFails = false;
      return new Response("{}", { status: 503 });
    }
    if (method === "auth.test") return json({ ok: true, user_id: "UME" });
    if (method === "users.info") return json({ ok: true, user: { profile: { display_name: url.searchParams.get("user") === "UANA" ? "Ana" : "Luis" } } });
    if (method === "conversations.info") return json({ ok: true, channel: { name: "proyecto" } });
    if (method === "search.messages")
      return json({ ok: true, messages: { matches: [{ ts: "1794686400", text: "va el <@UME>", user: "UANA", channel: { name: "proyecto" } }, { ts: "1794682800", text: "hola", user: "ULUIS", channel: { is_im: true } }] } });
    return json({ ok: false, error: "unknown_method" });
  }) as typeof fetch;
  const app = express();
  const reader = mountSlack(app, {
    config: { token: TOKEN, signingSecret: SECRET, quiet: o.quiet ?? null, forward: o.forward ?? true },
    kv: null,
    timeZone: "Europe/Madrid",
    control,
    notify: async (t) => void told.push(t),
    fetch: fake,
    now: () => clock.now,
    batchMs: 1500,
    retryMs: 20,
  });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let n = 0;
  const post = (payload: unknown, opts: { badSig?: boolean } = {}) => {
    const body = JSON.stringify(payload);
    const ts = Math.floor(clock.now / 1000);
    return fetch(`${base}/slack/events`, { method: "POST", headers: { "content-type": "application/json", "x-slack-request-timestamp": String(ts), "x-slack-signature": opts.badSig ? "v0=00" : sign(ts, body) }, body });
  };
  const message = (e: Record<string, unknown>, id = `Ev${++n}`) => post({ type: "event_callback", event_id: id, event: { type: "message", ts: "1794657600.000100", ...e } });
  const settle = () => new Promise((r) => setTimeout(r, 2000));
  return { told, asked, clock, control, reader, post, message, settle, close: () => (server.close(), server.closeAllConnections()) };
}

test("events: Slack's check is answered; a DM and a mention reach the owner in one WhatsApp per conversation; the rest, own messages, bots and repeats do not", async () => {
  const r = await rig();
  try {
    assert.equal((await r.post({ type: "url_verification", challenge: "abc" }, { badSig: true })).status, 401);
    assert.deepEqual(await (await r.post({ type: "url_verification", challenge: "abc" })).json(), { challenge: "abc" });
    await r.message({ channel: "D1", channel_type: "im", user: "UANA", text: "¿hablamos?" }, "EvDM");
    await r.message({ channel: "D1", channel_type: "im", user: "UANA", text: "es sobre el <https://x.example|informe>" });
    await r.message({ channel: "D1", channel_type: "im", user: "UANA", text: "¿hablamos?" }, "EvDM"); // Slack's retry
    await r.message({ channel: "C1", channel_type: "channel", user: "ULUIS", text: "<@UME> ¿lo revisas?" });
    await r.message({ channel: "C1", channel_type: "channel", user: "ULUIS", text: "comentario sin mención" });
    await r.message({ channel: "D2", channel_type: "im", user: "UME", text: "mío" });
    await r.message({ channel: "D3", channel_type: "im", user: "UBOT", bot_id: "B1", text: "bot" });
    await r.message({ channel: "D1", channel_type: "im", user: "UANA", subtype: "message_changed", text: "editado" });
    await r.settle();
    assert.equal(r.told.length, 1, "one WhatsApp for the batch");
    assert.match(r.told[0]!, /^💬 Slack · Ana \(private\):\n• ¿hablamos\?\n• es sobre el informe \(https:\/\/x\.example\)\n\n💬 Slack · Luis in #proyecto:\n@.+ ¿lo revisas\?$/);
    const recent = await r.reader.recent();
    assert.equal(recent.length, 3);
    assert.ok((await r.control.recent(10)).some((l) => l.text === "Slack from Ana (private)"));
  } finally {
    r.close();
  }
});

test("events: with SLACK_FORWARD off (the default) a DM is kept for SLACK and the brief but not copied to the owner, day or night", async () => {
  const r = await rig({ forward: false, quiet: { start: 23 * 60, end: 8 * 60 }, clock: Date.parse("2026-11-14T10:30:00Z") });
  try {
    await r.message({ channel: "D1", channel_type: "im", user: "UANA", text: "¿me montas la reunión?" });
    await r.settle();
    assert.equal(r.told.length, 0, "Slack already notified the owner");
    assert.equal((await r.reader.recent()).length, 1, "still kept");
    assert.ok((await r.control.recent(10)).some((l) => l.text === "Slack from Ana (private)"), "still logged");
  } finally {
    r.close();
  }
});

test("events: at night they wait, and come in one message after the quiet hours", async () => {
  const r = await rig({ quiet: { start: 23 * 60, end: 8 * 60 }, clock: Date.parse("2026-11-14T23:30:00Z") });
  try {
    await r.message({ channel: "D1", channel_type: "im", user: "UANA", text: "¿estás?" });
    await r.settle();
    assert.deepEqual(r.told, [], "nothing at night");
    assert.equal(await r.reader.morning(), 0, "still night");
    r.clock.now = Date.parse("2026-11-15T07:05:00Z"); // 08:05 in Madrid
    assert.equal(await r.reader.morning(), 1);
    assert.deepEqual(r.told, ["This came in on Slack while you were off (1):\n\n💬 Slack · Ana (private):\n¿estás?"]);
    assert.equal(await r.reader.morning(), 0, "once");
  } finally {
    r.close();
  }
});

test("search: Slack's search, newest first, one line each with where and who", async () => {
  const r = await rig();
  try {
    const lines = await r.reader.search("informe in:#proyecto");
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /^\d\d\/\d\d,? \d\d:\d\d #proyecto · Ana: va el @/);
    assert.match(lines[1]!, /private · Luis: hola$/);
  } finally {
    r.close();
  }
});

test("without the app's values the events address only answers Slack's check", async () => {
  const app = express();
  mountSlackCheckOnly(app);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const ok = await fetch(`${base}/slack/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "url_verification", challenge: "xyz" }) });
    assert.deepEqual(await ok.json(), { challenge: "xyz" });
    const no = await fetch(`${base}/slack/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "event_callback" }) });
    assert.equal(no.status, 503);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

// ---------- bug hunt 2: regression tests ----------

test("hunt2 slack: Slack's own markup is made readable, and invisible characters are dropped", () => {
  const names = () => "alguien";
  assert.equal(plainSlack("<!subteam^S1|@equipo> mirad <mailto:ana@x.example|Ana> <#C123> el <!date^1700000000^{date}|15 nov>", names), "@equipo mirad Ana #channel el 15 nov");
  assert.equal(plainSlack("pago\u202e 100\u200b€", names), "pago 100€");
});

test("hunt2 slack: a DM that arrives while Slack's own API is down for a moment is still told (the event is retried)", async () => {
  const r = await rig({ authFailsOnce: true });
  try {
    await r.message({ channel: "D1", channel_type: "im", user: "UANA", text: "¿hablamos?" });
    await r.settle();
    assert.equal(r.told.length, 1);
    assert.match(r.told[0]!, /¿hablamos\?/);
  } finally {
    r.close();
  }
});

test("hunt2 slack: a message with hundreds of mentions does not make hundreds of lookups", async () => {
  const r = await rig();
  try {
    const mentions = Array.from({ length: 300 }, (_, i) => `<@UX${i}>`).join(" ");
    await r.message({ channel: "D1", channel_type: "im", user: "UANA", text: `hola ${mentions}` });
    await r.settle();
    assert.ok(r.asked.filter((m) => m === "users.info").length <= 11, `${r.asked.filter((m) => m === "users.info").length} lookups`);
    assert.equal(r.told.length, 1);
  } finally {
    r.close();
  }
});
