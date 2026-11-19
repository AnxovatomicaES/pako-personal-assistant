// Slack's Socket Mode (src/slack-socket.ts, src/slack.ts): the events of the owner's Slack reach a computer with no public address. Each
// envelope is acknowledged before it is looked at, events come into the same handler as the events address (and once, whichever way they
// came), Slack's refresh and a dropped or dead connection open a new one, a refused token is not hammered. One test runs Node's own
// WebSocket against a small WebSocket server here (real frames, no Slack): nothing reaches the network.

import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import test from "node:test";
import express from "express";
import { createControl } from "../src/control.ts";
import { loadSlackConfig, mountSlack } from "../src/slack.ts";
import { createSlackSocket, type SocketLike } from "../src/slack-socket.ts";
import { createWatchdog } from "../src/watchdog.ts";

const APP_TOKEN = "xapp-1-A0123456789-1234567890123-abcdef0123456789";
const USER_TOKEN = "xoxp-1234567890-1234567890-abcdefghijklmnop";
const SECRET = "0123456789abcdef0123456789abcdef";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await wait(5);
  }
}

/** A socket the test drives: what Pako sends is kept, and the test plays Slack's side. */
class FakeSocket implements SocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readyState = 1;
  sent: string[] = [];
  closed = false;
  readonly url: string;
  private readonly order: string[];
  constructor(url: string, order: string[]) {
    this.url = url;
    this.order = order;
  }
  send(data: string) {
    this.sent.push(data);
    this.order.push(`ack ${(JSON.parse(data) as { envelope_id: string }).envelope_id}`);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  slack(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

function rig(o: { refuse?: string; failOpens?: number } = {}) {
  const order: string[] = [];
  const health: string[] = [];
  const sockets: FakeSocket[] = [];
  const opened: { auth: string; method: string }[] = [];
  const logs: string[] = [];
  let failOpens = o.failOpens ?? 0;
  let n = 0;
  const clock = { now: 1_800_000_000_000 };
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), "https://slack.com/api/apps.connections.open");
    opened.push({ auth: String((init?.headers as Record<string, string>).authorization), method: String(init?.method) });
    if (o.refuse) return new Response(JSON.stringify({ ok: false, error: o.refuse }));
    if (failOpens > 0) {
      failOpens--;
      return new Response("busy", { status: 503 });
    }
    return new Response(JSON.stringify({ ok: true, url: `wss://wss-primary.slack.com/link/?ticket=t${++n}` }));
  }) as typeof fetch;
  const socket = createSlackSocket({
    appToken: APP_TOKEN,
    receive: (p) => order.push(`event ${(p as { event_id: string }).event_id}`),
    fetch: fake,
    connect: (url) => {
      const s = new FakeSocket(url, order);
      sockets.push(s);
      return s;
    },
    now: () => clock.now,
    backoffMs: 20,
    maxBackoffMs: 80,
    lastingMs: 60,
    helloMs: 200,
    tickMs: 25,
    log: (l) => void logs.push(l),
    health: (ok, detail) => void health.push(ok ? "ok" : `fail ${detail}`),
  });
  return { socket, sockets, opened, order, logs, clock, health };
}

const envelope = (id: string, eventId: string, ts = "1.1") => ({
  envelope_id: id, type: "events_api", accepts_response_payload: false,
  payload: { type: "event_callback", event_id: eventId, event: { type: "message", channel: "D1", channel_type: "im", user: "UANA", text: "hola", ts } },
});

test("socket mode: opened with the app-level token; each envelope acknowledged at once, before its event is handed on", async () => {
  const r = rig();
  r.socket.start();
  try {
    await until(() => r.sockets.length === 1);
    assert.deepEqual(r.opened[0], { auth: `Bearer ${APP_TOKEN}`, method: "POST" });
    assert.match(r.sockets[0]!.url, /^wss:\/\/wss-primary\.slack\.com\//);
    r.sockets[0]!.slack({ type: "hello", num_connections: 1 });
    assert.equal(r.socket.state().connected, true);
    r.sockets[0]!.slack(envelope("env-1", "Ev1"));
    r.sockets[0]!.slack({ envelope_id: "env-2", type: "slash_commands", payload: {} });
    assert.deepEqual(r.order, ["ack env-1", "event Ev1", "ack env-2"], "acknowledged first; a slash command is acknowledged and left");
    assert.deepEqual(JSON.parse(r.sockets[0]!.sent[0]!), { envelope_id: "env-1" });
    assert.ok(r.logs.some((l) => /Socket Mode connected/.test(l)));
    assert.ok(!r.logs.join("\n").includes(APP_TOKEN), "the token never reaches the log");
  } finally {
    r.socket.stop();
  }
});

test("socket mode: Slack's refresh opens a new connection at once; a dropped one comes back after a wait that grows", async () => {
  const r = rig({ failOpens: 2 });
  r.socket.start();
  try {
    // Two failed opens first (503): tried again after 20 ms, then 40 ms.
    await until(() => r.sockets.length === 1);
    assert.equal(r.opened.length, 3);
    r.sockets[0]!.slack({ type: "hello" });
    r.sockets[0]!.slack({ type: "disconnect", reason: "refresh_requested" });
    await until(() => r.sockets.length === 2);
    assert.equal(r.sockets[0]!.closed, true, "the old connection is closed");
    r.sockets[1]!.slack({ type: "hello" });
    r.sockets[1]!.drop();
    assert.equal(r.socket.state().connected, false);
    await until(() => r.sockets.length === 3);
    // A connection that never says hello is replaced.
    await until(() => r.sockets.length === 4, 2000);
    assert.equal(r.sockets[2]!.closed, true);
  } finally {
    r.socket.stop();
  }
  const after = r.opened.length;
  await wait(150);
  assert.equal(r.opened.length, after, "stopped: nothing is opened again");
});

test("socket mode: a refused token is said once and tried again slowly; a computer that slept opens a new connection", async () => {
  const refused = rig({ refuse: "invalid_auth" });
  refused.socket.start();
  try {
    await until(() => refused.opened.length >= 3, 2000);
    assert.equal(refused.logs.filter((l) => /refused \(invalid_auth\)/.test(l)).length, 1, "said once, not each time");
    assert.equal(refused.sockets.length, 0);
  } finally {
    refused.socket.stop();
  }

  const r = rig();
  r.socket.start();
  try {
    await until(() => r.sockets.length === 1);
    r.sockets[0]!.slack({ type: "hello" });
    r.clock.now += 10 * 60_000; // the lid was closed for ten minutes
    await until(() => r.sockets.length === 2);
    assert.equal(r.sockets[0]!.closed, true);
    assert.ok(r.logs.some((l) => /slept/.test(l)));
  } finally {
    r.socket.stop();
  }
});

test("socket mode and the watchdog: a refused token or Socket Mode switched off is a failed round each try, until a hello says it works", async () => {
  const refused = rig({ refuse: "token_revoked" });
  refused.socket.start();
  try {
    await until(() => refused.opened.length >= 3, 2000);
    assert.equal(refused.socket.problem(), "token_revoked");
    assert.ok(refused.health.length >= 3 && refused.health.every((h) => h === "fail Socket Mode: token_revoked"), refused.health.join(", "));
  } finally {
    refused.socket.stop();
  }
  const r = rig({ failOpens: 1 });
  r.socket.start();
  try {
    await until(() => r.sockets.length === 1);
    assert.deepEqual(r.health, [], "a busy Slack once is not reported: the reconnect handles it");
    r.sockets[0]!.slack({ type: "hello" });
    assert.deepEqual(r.health, ["ok"]);
    assert.equal(r.socket.problem(), null);
    r.sockets[0]!.slack({ type: "disconnect", reason: "link_disabled" });
    assert.equal(r.socket.problem(), "link_disabled");
    assert.deepEqual(r.health, ["ok", "fail Socket Mode: link_disabled"]);
    await until(() => r.sockets.length === 2, 2000);
    r.sockets[1]!.slack({ type: "hello" });
    assert.equal(r.socket.problem(), null, "switched on again: the next hello clears it");
  } finally {
    r.socket.stop();
  }
});

test("slack config: the app-level token alone (with the user token) is enough; a wrong one is named; the signing secret is still checked when set", () => {
  const socketOnly = loadSlackConfig({ SLACK_USER_TOKEN: USER_TOKEN, SLACK_APP_TOKEN: APP_TOKEN });
  assert.deepEqual(socketOnly.problems, []);
  assert.equal(socketOnly.config?.appToken, APP_TOKEN);
  assert.equal(socketOnly.config?.signingSecret, "");
  assert.match(loadSlackConfig({ SLACK_USER_TOKEN: USER_TOKEN, SLACK_APP_TOKEN: "xoxb-bot" }).problems.join(), /^SLACK_APP_TOKEN must/);
  assert.match(loadSlackConfig({ SLACK_USER_TOKEN: USER_TOKEN, SLACK_APP_TOKEN: APP_TOKEN, SLACK_SIGNING_SECRET: "short" }).problems.join(), /SLACK_SIGNING_SECRET/);
  assert.deepEqual(loadSlackConfig({ SLACK_USER_TOKEN: USER_TOKEN }).problems, [], "the user token alone: Pako looks every minute (src/slack-poll.ts)");
  assert.equal(loadSlackConfig({ SLACK_USER_TOKEN: USER_TOKEN, SLACK_SIGNING_SECRET: SECRET }).config?.appToken, undefined, "the events address alone, as before");
});

// ---------- the whole way, with Node's own WebSocket ----------

/** A WebSocket server just big enough for this: the handshake, text frames out, masked text frames in. */
function wsServer() {
  const conns: Duplex[] = [];
  const received: string[] = [];
  const server: Server = createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (req, sock: Duplex) => {
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    conns.push(sock);
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const op = buf[0]! & 0x0f;
        let len = buf[1]! & 0x7f;
        let at = 2;
        if (len === 126) {
          len = buf.readUInt16BE(2);
          at = 4;
        }
        if (buf.length < at + 4 + len) return;
        const mask = buf.subarray(at, at + 4);
        const data = Buffer.from(buf.subarray(at + 4, at + 4 + len).map((b, i) => b ^ mask[i % 4]!));
        buf = buf.subarray(at + 4 + len);
        if (op === 1) received.push(data.toString("utf8"));
        if (op === 8) sock.end();
      }
    });
    sock.on("error", () => undefined);
  });
  const send = (sock: Duplex, m: unknown) => {
    const data = Buffer.from(JSON.stringify(m));
    const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 0xff]);
    sock.write(Buffer.concat([head, data]));
  };
  return { server, conns, received, send };
}

test("socket mode, the whole way: Node's WebSocket, Slack's envelopes, the owner told once even when the events address brings the same event", async () => {
  const ws = wsServer();
  await new Promise<void>((r) => ws.server.listen(0, "127.0.0.1", () => r()));
  const wsPort = (ws.server.address() as AddressInfo).port;
  const told: string[] = [];
  const slackApi = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const method = url.pathname.split("/").pop()!;
    const json = (b: unknown) => new Response(JSON.stringify(b));
    if (method === "apps.connections.open") return json({ ok: true, url: "wss://wss-primary.slack.com/link/?ticket=abc" });
    if (method === "auth.test") return json({ ok: true, user_id: "UME" });
    if (method === "users.info") return json({ ok: true, user: { profile: { display_name: "Ana" } } });
    return json({ ok: false, error: "unknown_method" });
  }) as typeof fetch;
  const app = express();
  const reader = mountSlack(app, {
    config: { token: USER_TOKEN, signingSecret: SECRET, appToken: APP_TOKEN, quiet: null, forward: true },
    kv: null,
    timeZone: "Europe/Madrid",
    control: createControl(null),
    notify: async (t) => void told.push(t),
    fetch: slackApi,
    batchMs: 50,
    // Slack's address goes to the small server here instead, over plain ws (no certificate to make).
    socket: { connect: (url) => new WebSocket(url.replace(/^wss:\/\/[^/]+/, `ws://127.0.0.1:${wsPort}`)) as unknown as SocketLike },
  });
  const http = createServer(app);
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  assert.ok(reader.socket, "SLACK_APP_TOKEN makes a socket");
  reader.socket.start();
  try {
    await until(() => ws.conns.length === 1);
    ws.send(ws.conns[0]!, { type: "hello", num_connections: 1, connection_info: { app_id: "A1" } });
    await until(() => reader.socket!.state().connected);
    const now = (Date.now() / 1000).toFixed(6);
    ws.send(ws.conns[0]!, envelope("e-1", "EvSame", now));
    await until(() => ws.received.length === 1);
    assert.deepEqual(JSON.parse(ws.received[0]!), { envelope_id: "e-1" });
    // The same event by the signed events address too (an app with both on): handled once.
    const body = JSON.stringify(envelope("x", "EvSame", now).payload);
    const ts = Math.floor(Date.now() / 1000);
    const sig = `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
    const r = await fetch(`${base}/slack/events`, { method: "POST", headers: { "x-slack-request-timestamp": String(ts), "x-slack-signature": sig }, body });
    assert.equal(r.status, 200);
    await until(() => told.length === 1);
    await wait(150);
    assert.equal(told.length, 1, "told once");
    assert.match(told[0]!, /^💬 Slack · Ana \(private\):\nhola$/);
    assert.equal((await reader.recent()).length, 1);
    // Slack closes the connection: Pako opens another by itself.
    ws.conns[0]!.end();
    await until(() => ws.conns.length === 2, 5000);
  } finally {
    reader.socket.stop();
    http.close();
    http.closeAllConnections();
    for (const c of ws.conns) c.destroy();
    ws.server.close();
  }
});

test("socket mode only: the events address takes nothing (there is no secret to check a request with)", async () => {
  const app = express();
  mountSlack(app, {
    config: { token: USER_TOKEN, signingSecret: "", appToken: APP_TOKEN, quiet: null, forward: true },
    kv: null, timeZone: "Europe/Madrid", notify: async () => undefined,
    fetch: (async () => new Response("{}")) as typeof fetch,
  });
  const http = createServer(app);
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  try {
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const r = await fetch(`${base}/slack/events`, { method: "POST", body: JSON.stringify({ type: "event_callback", event_id: "E1", event: {} }) });
    assert.equal(r.status, 404);
  } finally {
    http.close();
    http.closeAllConnections();
  }
});

test("a refused Socket Mode token and a working user token are two parts: one incident told once, no false recovery from a search", async () => {
  const MIN = 60_000;
  const clock = { t: Date.UTC(2026, 10, 16, 11, 0) };
  const said: string[] = [];
  const dog = createWatchdog({
    config: { on: true, quiet: null }, local: true, timeZone: "Europe/Madrid", now: () => clock.t,
    notify: () => async (text: string) => void said.push(text), log: () => undefined, kv: null,
  });
  dog.start();
  const api = (async (input: string | URL | Request) => {
    const method = new URL(String(input)).pathname.split("/").pop();
    if (method === "apps.connections.open") return new Response(JSON.stringify({ ok: false, error: "token_revoked" }));
    if (method === "search.messages") return new Response(JSON.stringify({ ok: true, messages: { matches: [] } }));
    return new Response(JSON.stringify({ ok: true }));
  }) as typeof fetch;
  const reader = mountSlack(express(), {
    config: { token: USER_TOKEN, signingSecret: "", appToken: APP_TOKEN, quiet: null, forward: false },
    kv: null, timeZone: "Europe/Madrid", control: createControl(null), notify: async () => undefined, fetch: api,
    health: dog.reporter("slack"), eventsHealth: dog.reporter("slackEvents"), socket: { lastingMs: 10 * MIN, log: () => undefined },
  });
  reader.socket!.start();
  for (let i = 0; i < 50 && !reader.socket!.problem(); i++) await wait(10);
  assert.equal(reader.socket!.problem(), "token_revoked");
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
      await dog.settled();
    }
  };
  for (let cycle = 0; cycle < 3; cycle++) {
    for (let i = 0; i < 3; i++) {
      clock.t += 10 * MIN;
      await reader.check(); // the watchdog's half-hourly probe: Socket Mode refused, auth.test fine
      await settle();
    }
    await reader.search("x"); // the owner (or a follow-up's check) uses Slack's Web API
    await settle();
  }
  reader.socket!.stop();
  dog.stop();
  assert.equal(said.length, 1, said.join("\n---\n"));
  assert.match(said[0]!, /^⚠️ Slack's connection for new messages \(Socket Mode\) is failing \(Socket Mode: token_revoked\)/);
  assert.match(said[0]!, /SLACK_APP_TOKEN/);
  const parts = dog.state().parts;
  assert.equal(parts.find((p) => p.key === "slackEvents")?.status, "down", "still down: its events do not come");
  assert.equal(parts.find((p) => p.key === "slack")?.status, "ok", "the user token works");
});
