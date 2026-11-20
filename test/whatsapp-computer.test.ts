// WhatsApp from a person's computer (src/whatsapp-computer.ts, src/tunnel.ts): cloudflared downloaded only with a matching published checksum,
// the tunnel as a supervised child (a fake cloudflared that prints a trycloudflare address), only the webhook reachable through it, Meta told
// the address each time it changes, the five-step setup, and the owner's WhatsApp as a chat of the door (src/whatsapp.ts) beside the panel's.
// Meta and Cloudflare are stand-ins on this computer: nothing here reaches the network.

import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import express from "express";
import { createApp, loadAppConfig, type LocalContext } from "../src/app.ts";
import { localGuard } from "../src/guard-http.ts";
import type { Kv } from "../src/kv.ts";
import { createLocalChannel, createSettings, loadHome, localEnv, LOCAL_OWNER_NUMBER } from "../src/local.ts";
import { cloudflaredAsset, createTunnel, installCloudflared, publishedSha256 } from "../src/tunnel.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";
import { createComputerWhatsapp, ownerDigits, type SavedWhatsapp } from "../src/whatsapp-computer.ts";
import { mountWhatsapp, type WhatsappConfig } from "../src/whatsapp.ts";

type Body = Record<string, any>;

// Made-up values in the shapes Meta gives: they open nothing.
const APP_ID = "1234567890123";
const SECRET = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const NUMBER_ID = "109876543210987";
const TOKEN = `EAAG${"x".repeat(60)}`;
const WABA = "102938475610293";
const OWNER = "34612345678";

async function until(ok: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return ok();
}

function memKv(): Kv {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

/** A request as Cloudflare's tunnel delivers it to Pako: the tunnel's host name, and Cloudflare's own headers. */
function throughTunnel(port: number, host: string, method: string, path: string, o: { body?: string; headers?: Record<string, string>; cf?: boolean } = {}) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1", port, method, path,
      headers: { host, ...(o.cf === false ? {} : { "cf-connecting-ip": "203.0.113.9", "cf-ray": "8e1f-MAD" }), ...o.headers },
    }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", reject);
    req.end(o.body);
  });
}

/**
 * A cloudflared stand-in: it notes its arguments, prints a quick tunnel's address as cloudflared does (a new one each start: its process id)
 * and waits. A Node script, run by this Node (runFake): a freshly written executable can take a security scan's minute to start on a Mac.
 */
function fakeCloudflared(dir: string): string {
  const bin = join(dir, "cloudflared.mjs");
  writeFileSync(bin, [
    `import { writeFileSync } from "node:fs";`,
    `writeFileSync(${JSON.stringify(join(dir, "args.txt"))}, process.argv.slice(2).join(" "));`,
    "process.stderr.write(`2026-11-16T10:00:00Z INF |  https://fake-${process.pid}-tunnel.trycloudflare.com  |\\n`);",
    "setInterval(() => {}, 1 << 30);",
  ].join("\n"));
  return bin;
}
const runFake = (bin: string, args: string[]) => spawn(process.execPath, [bin, ...args], { stdio: ["ignore", "pipe", "pipe"] });

/** Meta's Graph API, as far as the setup uses it. Its webhook check calls the address it was given, through the tunnel, as Meta does. */
function fakeMeta(port: () => number) {
  const calls: { method: string; path: string; query: URLSearchParams; body: Body; auth: string }[] = [];
  const state = { ownerAllowed: true, subscribeOk: true };
  const json = (status: number, doc: unknown) => new Response(JSON.stringify(doc), { status, headers: { "content-type": "application/json" } });
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.host, "graph.facebook.com", "nothing but Meta's Graph API is called");
    const raw = typeof init?.body === "string" ? init.body : "";
    const isForm = String((init?.headers as Record<string, string> | undefined)?.["content-type"] ?? "").includes("form");
    const body = raw ? (isForm ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw)) : {};
    const auth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "");
    const path = url.pathname.replace(/^\/v23\.0/, "");
    const method = init?.method ?? "GET";
    calls.push({ method, path, query: url.searchParams, body, auth });
    const bearerOk = auth === `Bearer ${TOKEN}`;
    if (method === "GET" && path === `/${NUMBER_ID}`) {
      return bearerOk ? json(200, { display_phone_number: "+1 555-010-0999", verified_name: "Test Number", id: NUMBER_ID }) : json(401, { error: { code: 190 } });
    }
    if (method === "GET" && /^\/\d+$/.test(path) && path !== `/${APP_ID}`) return bearerOk ? json(400, { error: { code: 100 } }) : json(401, { error: { code: 190 } });
    if (method === "GET" && path === `/${APP_ID}`) {
      return url.searchParams.get("access_token") === `${APP_ID}|${SECRET}` ? json(200, { id: APP_ID, name: "Pako" }) : json(400, { error: { code: 101 } });
    }
    if (method === "GET" && path === "/debug_token") {
      return json(200, { data: { granular_scopes: [{ scope: "whatsapp_business_management", target_ids: [WABA] }, { scope: "whatsapp_business_messaging" }] } });
    }
    if (method === "POST" && path === `/${APP_ID}/subscriptions`) {
      if (!state.subscribeOk || body.access_token !== `${APP_ID}|${SECRET}`) return json(400, { error: { code: 2200 } });
      // Meta checks the callback before it answers: a GET with the verify token, which must echo the challenge.
      const cb = new URL(body.callback_url);
      const q = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": body.verify_token, "hub.challenge": "1158201444" });
      const got = await throughTunnel(port(), cb.host, "GET", `${cb.pathname}?${q}`);
      return got.status === 200 && got.text === "1158201444" ? json(200, { success: true }) : json(400, { error: { code: 2200 } });
    }
    if (method === "POST" && path === `/${WABA}/subscribed_apps`) return json(200, { success: true });
    if (method === "GET" && path === `/${WABA}/message_templates`) return json(200, { data: [{ name: "pako_notice", status: "PENDING" }] });
    if (method === "POST" && path === `/${NUMBER_ID}/messages`) {
      if (!bearerOk) return json(401, { error: { code: 190 } });
      if (!state.ownerAllowed) return json(400, { error: { code: 131030 } });
      return json(200, { messages: [{ id: `wamid.out${calls.length}` }] });
    }
    return json(404, { error: { code: 0 } });
  }) as typeof fetch;
  return {
    fetch: f, state, calls,
    sent: () => calls.filter((c) => c.method === "POST" && c.path === `/${NUMBER_ID}/messages`).map((c) => c.body),
    subscriptions: () => calls.filter((c) => c.path === `/${APP_ID}/subscriptions`).map((c) => c.body),
  };
}

/** The setup on its own server, as src/app.ts puts it together on a computer: the gate, the local guard, the webhook, the panel's routes. */
async function setupServer(o: { phoneOn?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pako-wa-"));
  const bin = fakeCloudflared(dir);
  let stored: SavedWhatsapp | null = null;
  let port = 0;
  const meta = fakeMeta(() => port);
  const ingested: { m: Body; channel: string }[] = [];
  const logged: string[] = [];
  const health: [boolean, string?][] = [];
  const c = createComputerWhatsapp({
    health: (ok, detail) => void health.push(detail === undefined ? [ok] : [ok, detail]),
    store: { read: () => (stored ? { ...stored } : null), write: (v) => ((stored = v ? { ...v } : null), true) },
    kv: memKv(), env: {}, lang: () => "en", fetch: meta.fetch, verifyWaitMs: 3000, retryMs: 50,
    control: { log: (_k: string, t: string) => void logged.push(t) } as never,
    tunnel: (onUrl) => createTunnel({ port: () => port, install: async () => ({ ok: true, bin, version: "fake" }), onUrl, retryMs: 50, spawn: runFake }),
    phoneOn: () => o.phoneOn === true,
  });
  const app = express();
  app.use(c.gate);
  app.use(localGuard({}));
  c.mountWebhook(app);
  c.mountPanel(app, () => true);
  c.attach(async (m, channel) => (ingested.push({ m, channel }), "queued"), () => "15555550100");
  app.get("/panel", (_q, r) => void r.type("text").send("the panel"));
  app.get("/assistant/inbox", (_q, r) => void r.json({ messages: [] }));
  app.post("/personal-voice/result", (_q, r) => void r.status(204).end());
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const get = async () => (await (await fetch(`${base}/panel/api/whatsapp/setup`)).json()) as Body;
  const post = async (action: string, values?: Body) => {
    const r = await fetch(`${base}/panel/api/whatsapp/setup`, {
      method: "POST", headers: { "content-type": "application/json", "x-pako": "1" }, body: JSON.stringify({ action, ...(values ? { values } : {}) }),
    });
    return { status: r.status, body: (await r.json()) as Body, raw: "" };
  };
  /** A webhook from Meta through the tunnel, signed with the app secret (or not). */
  const deliver = (host: string, messages: Body[], o2: { secret?: string; numberId?: string } = {}) => {
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ value: { metadata: { phone_number_id: o2.numberId ?? NUMBER_ID }, messages } }] }],
    });
    const sig = `sha256=${createHmac("sha256", o2.secret ?? SECRET).update(body).digest("hex")}`;
    return throughTunnel(port, host, "POST", "/whatsapp/webhook", { body, headers: { "content-type": "application/json", "x-hub-signature-256": sig } });
  };
  return {
    c, meta, ingested, logged, health, dir, port: () => port, base, get, post, deliver, stored: () => stored,
    close: () => {
      c.stop();
      server.close();
      server.closeAllConnections();
    },
  };
}

const VALUES = { appId: APP_ID, appSecret: SECRET, phoneNumberId: NUMBER_ID, accessToken: TOKEN, ownerNumber: "+34 612 34 56 78" };

test("cloudflared: the release file for each system and processor, and the checksum Cloudflare published for it", () => {
  assert.equal(cloudflaredAsset("darwin", "arm64"), "cloudflared-darwin-arm64.tgz");
  assert.equal(cloudflaredAsset("darwin", "x64"), "cloudflared-darwin-amd64.tgz");
  assert.equal(cloudflaredAsset("linux", "x64"), "cloudflared-linux-amd64");
  assert.equal(cloudflaredAsset("linux", "arm64"), "cloudflared-linux-arm64");
  assert.equal(cloudflaredAsset("win32", "x64"), "cloudflared-windows-amd64.exe");
  assert.equal(cloudflaredAsset("freebsd", "x64"), null);
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  const notes = `### SHA256 Checksums:\n\`\`\`\ncloudflared-darwin-amd64.tgz: ${a}\ncloudflared-darwin-arm64.tgz: ${b}\ncloudflared-linux-amd64: ${a}\n\`\`\``;
  assert.equal(publishedSha256(notes, "cloudflared-darwin-arm64.tgz"), b);
  assert.equal(publishedSha256(notes, "cloudflared-linux-amd64"), a);
  assert.equal(publishedSha256(notes, "cloudflared-linux-arm64"), null);
});

/** Cloudflare's latest release on GitHub, as its API describes it, and the file's bytes. */
function fakeGithub(o: { asset: string; bytes: Buffer; published?: string; digest?: string; from?: string }) {
  const sha = createHash("sha256").update(o.bytes).digest("hex");
  const asked: string[] = [];
  const f = (async (input: string | URL) => {
    const url = String(input);
    asked.push(url);
    if (url === "https://api.github.com/repos/cloudflare/cloudflared/releases/latest") {
      return Response.json({
        tag_name: "2026.11.0",
        body: `SHA256 Checksums:\n${o.asset}: ${o.published ?? sha}\ncloudflared-other: ${"c".repeat(64)}`,
        assets: [{ name: o.asset, browser_download_url: `${o.from ?? "https://github.com/cloudflare/cloudflared/releases/download/2026.11.0"}/${o.asset}`,
          ...(o.digest ? { digest: o.digest } : {}) }],
      });
    }
    if (url.endsWith(`/${o.asset}`)) return new Response(new Uint8Array(o.bytes), { status: 200 });
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { fetch: f, asked, sha };
}

test("cloudflared: kept in ~/.pako/bin only when its bytes match the checksum Cloudflare published (and GitHub's digest); anything else is not kept", async () => {
  const bytes = Buffer.from("#!/bin/sh\necho cloudflared\n");
  const home = mkdtempSync(join(tmpdir(), "pako-cf-"));
  // Matching: kept, runnable, and used as it is next time (no second download).
  const ok = fakeGithub({ asset: "cloudflared-linux-amd64", bytes });
  const dir = join(home, "bin");
  const got = await installCloudflared({ dir, platform: "linux", arch: "x64", fetch: ok.fetch });
  assert.deepEqual(got, { ok: true, bin: join(dir, "cloudflared"), version: "2026.11.0" });
  assert.equal(readFileSync(join(dir, "cloudflared"), "utf8"), bytes.toString());
  assert.equal(statSync(join(dir, "cloudflared")).mode & 0o777, 0o755);
  const before = ok.asked.length;
  assert.equal((await installCloudflared({ dir, platform: "linux", arch: "x64", fetch: ok.fetch })).ok, true);
  assert.equal(ok.asked.length, before, "already there: nothing downloaded again");

  for (const [why, bad] of [
    ["the bytes differ from the published checksum", fakeGithub({ asset: "cloudflared-linux-amd64", bytes, published: "d".repeat(64) })],
    ["GitHub's digest disagrees with Cloudflare's checksum", fakeGithub({ asset: "cloudflared-linux-amd64", bytes, digest: `sha256:${"e".repeat(64)}` })],
    ["the file is not on Cloudflare's own release page", fakeGithub({ asset: "cloudflared-linux-amd64", bytes, from: "https://example.com/x" })],
  ] as const) {
    const other = join(mkdtempSync(join(tmpdir(), "pako-cf-")), "bin");
    const r = await installCloudflared({ dir: other, platform: "linux", arch: "x64", fetch: bad.fetch });
    assert.deepEqual(r, { ok: false, why: "checksum" }, why);
    assert.equal(existsSync(join(other, "cloudflared")), false, why);
  }
  assert.deepEqual(await installCloudflared({ dir: join(home, "x"), platform: "aix", arch: "ppc64" }), { ok: false, why: "platform" });
});

test("cloudflared: on a Mac the release is a .tgz, unpacked after its checksum matched, and only the program is kept", async () => {
  const work = mkdtempSync(join(tmpdir(), "pako-cf-tgz-"));
  mkdirSync(join(work, "src"));
  writeFileSync(join(work, "src", "cloudflared"), "#!/bin/sh\necho mac\n");
  execFileSync("tar", ["-czf", join(work, "cf.tgz"), "-C", join(work, "src"), "cloudflared"]);
  const gh = fakeGithub({ asset: "cloudflared-darwin-arm64.tgz", bytes: readFileSync(join(work, "cf.tgz")) });
  const dir = join(work, "bin");
  const got = await installCloudflared({ dir, platform: "darwin", arch: "arm64", fetch: gh.fetch });
  assert.equal(got.ok, true);
  assert.equal(readFileSync(join(dir, "cloudflared"), "utf8"), "#!/bin/sh\necho mac\n");
  assert.deepEqual(execFileSync("ls", ["-A", dir]).toString().trim().split("\n"), ["cloudflared"], "the download and its folder are gone");
});

test("tunnel: cloudflared runs as a child with the quick tunnel's arguments, its printed address is heard, and it starts again (a new address) when it stops", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pako-tun-"));
  const bin = fakeCloudflared(dir);
  const urls: (string | null)[] = [];
  const t = createTunnel({ port: () => 8787, install: async () => ({ ok: true, bin, version: "fake" }), onUrl: (u) => void urls.push(u), retryMs: 30, spawn: runFake });
  try {
    assert.equal(t.state(), "off");
    t.start();
    assert.ok(await until(() => t.state() === "on"));
    const first = t.url()!;
    assert.match(first, /^https:\/\/fake-\d+-tunnel\.trycloudflare\.com$/);
    assert.equal(readFileSync(join(dir, "args.txt"), "utf8").trim(), "tunnel --no-autoupdate --url http://127.0.0.1:8787");
    // It stops by itself (a crash): started again, with a new address.
    process.kill(Number(/fake-(\d+)-/.exec(first)![1]), "SIGKILL");
    assert.ok(await until(() => t.url() !== null && t.url() !== first), "started again");
    assert.deepEqual(urls, [first, null, t.url()]);
  } finally {
    t.stop();
  }
  assert.equal(t.state(), "off");
  assert.equal(t.url(), null);
  // An installation that failed is said, and nothing runs.
  const bad = createTunnel({ port: () => 1, install: async () => ({ ok: false, why: "checksum" }), onUrl: () => undefined });
  bad.start();
  assert.ok(await until(() => bad.state() === "error"));
  assert.equal(bad.why(), "checksum");
  bad.stop();
});

test("setup: Meta's values are checked live and kept without ever going back to the page; the tunnel is opened only on request and the webhook registered by Pako", async () => {
  const s = await setupServer();
  try {
    let d = await s.get();
    assert.equal(d.step, "app");
    assert.deepEqual(d.done, []);
    assert.equal(d.tunnel.state, "off");
    assert.match(d.official, /official WhatsApp API/);
    // Nothing can be opened before Meta's values are in, and nothing is downloaded or run until then.
    assert.equal((await s.post("tunnelOn")).status, 400);
    assert.equal(existsSync(join(s.dir, "args.txt")), false);

    assert.match((await s.post("saveMeta", { ...VALUES, appId: "pako" })).body.error, /digits only/);
    assert.match((await s.post("saveMeta", { ...VALUES, ownerNumber: "612" })).body.error, /country code/);
    // Typed the way the owner usually writes it, without the country code: refused, never kept as a number WhatsApp's replies never come from.
    assert.match((await s.post("saveMeta", { ...VALUES, ownerNumber: "612 345 678" })).body.error, /country code/);
    assert.match((await s.post("saveMeta", { ...VALUES, accessToken: `EAAG${"y".repeat(60)}` })).body.error, /doesn't accept that token/);
    assert.match((await s.post("saveMeta", { ...VALUES, phoneNumberId: "999999999" })).body.error, /doesn't know that phone number ID/);
    assert.match((await s.post("saveMeta", { ...VALUES, appSecret: "z".repeat(32) })).body.error, /don't match/);
    assert.equal(s.stored(), null, "nothing kept while Meta refuses");

    const saved = await s.post("saveMeta", VALUES);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.ok, true);
    assert.equal(saved.body.step, "tunnel");
    assert.deepEqual(saved.body.done, ["app", "number", "values"]);
    assert.equal(saved.body.meta.testNumber, "+1 555-010-0999");
    assert.equal(saved.body.meta.ownerNumber, `+${OWNER}`);
    const page = JSON.stringify(saved.body);
    for (const secret of [TOKEN, SECRET, s.stored()!.verifyToken]) assert.ok(!page.includes(secret), "no secret goes to the page");
    assert.equal(s.stored()!.ownerNumber, OWNER);
    assert.equal(s.stored()!.wabaId, WABA);
    // An empty field keeps what was saved.
    assert.equal((await s.post("saveMeta", { ownerNumber: "+34 612 345 678" })).body.ok, true);
    assert.equal(s.stored()!.accessToken, TOKEN);

    assert.equal((await s.post("tunnelOn")).body.ok, true);
    assert.ok(await until(async () => (d = await s.get()).meta.webhook === "verified"), "Meta checked the address");
    assert.deepEqual(s.health.at(-1), [true], "the watchdog's WhatsApp part hears that the webhook works");
    assert.equal(d.step, "test");
    assert.deepEqual(d.done, ["app", "number", "values", "tunnel"]);
    assert.match(d.tunnel.url, /^https:\/\/fake-\d+-tunnel\.trycloudflare\.com$/);
    const sub = s.meta.subscriptions().at(-1)!;
    assert.deepEqual(
      [sub.object, sub.callback_url, sub.fields, sub.verify_token, sub.access_token],
      ["whatsapp_business_account", `${d.tunnel.url}/whatsapp/webhook`, "messages", s.stored()!.verifyToken, `${APP_ID}|${SECRET}`],
    );
    assert.ok(s.meta.calls.some((c) => c.path === `/${WABA}/subscribed_apps` && c.auth === `Bearer ${TOKEN}`), "the account's messages reach the app");
    assert.deepEqual(d.meta.template, { name: "pako_notice", status: "pending" });
    assert.equal(s.stored()!.tunnel, true, "kept: it opens again with Pako");
  } finally {
    s.close();
  }
});

test("tunnel gate: through the tunnel only the webhook answers (the phone line's paths too when it is on); the panel and /assistant are 404", async () => {
  for (const phoneOn of [false, true]) {
    const s = await setupServer({ phoneOn });
    try {
      await s.post("saveMeta", VALUES);
      await s.post("tunnelOn");
      assert.ok(await until(async () => (await s.get()).meta.webhook === "verified"));
      const host = new URL((await s.get()).tunnel.url).host;
      for (const path of ["/panel", "/panel/api/whatsapp/setup", "/assistant/inbox", "/WHATSAPP/webhook", "/health", "/"]) {
        assert.equal((await throughTunnel(s.port(), host, "GET", path)).status, 404, path);
        // Cloudflare's headers alone, or the tunnel's name alone, are each enough to tell.
        assert.equal((await throughTunnel(s.port(), "127.0.0.1", "GET", path)).status, 404, `${path} with cf headers`);
        assert.equal((await throughTunnel(s.port(), host, "GET", path, { cf: false })).status, 404, `${path} by host`);
      }
      // The webhook itself is reached (here refused for its token, by its own route).
      assert.equal((await throughTunnel(s.port(), host, "GET", "/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong")).status, 403);
      assert.equal((await throughTunnel(s.port(), host, "POST", "/personal-voice/result", { body: "{}" })).status, phoneOn ? 204 : 404);
      // From this computer the panel's routes work as ever.
      assert.equal((await fetch(`${s.base}/panel`)).status, 200);
      // Tunnel off: nothing at all through it.
      await s.post("tunnelOff");
      assert.equal((await throughTunnel(s.port(), host, "GET", "/whatsapp/webhook?hub.mode=subscribe")).status, 404);
    } finally {
      s.close();
    }
  }
});

test("Send me a hi: a test message to the owner, their reply puts the ✓, and from then on their WhatsApp is a chat with Pako", async () => {
  const s = await setupServer();
  try {
    assert.match((await s.post("sendTest")).body.error, /First paste your Meta app/);
    await s.post("saveMeta", VALUES);
    assert.match((await s.post("sendTest")).body.error, /First turn the tunnel on/);
    await s.post("tunnelOn");
    assert.ok(await until(async () => (await s.get()).meta.webhook === "verified"));
    const host = new URL((await s.get()).tunnel.url).host;
    // The owner's number is not on the test number's list yet: said how to fix it.
    s.meta.state.ownerAllowed = false;
    assert.match((await s.post("sendTest")).body.error, /add your number under “To”/);
    s.meta.state.ownerAllowed = true;
    const sent = await s.post("sendTest");
    assert.equal(sent.body.ok, true);
    assert.equal(sent.body.meta.awaiting, true);
    // Outside the 24 hours only a template can start: hello_world, which every number has.
    assert.deepEqual(s.meta.sent().at(-1), {
      messaging_product: "whatsapp", recipient_type: "individual", to: OWNER, type: "template", template: { name: "hello_world", language: { code: "en_US" } },
    });
    assert.equal(s.c.line.reachable && (await s.c.line.reachable()), false, "no chat before the reply");

    // Someone else, a wrong signature, another number's news: nothing happens.
    assert.equal((await s.deliver(host, [{ from: "34600000000", id: "wamid.x1", type: "text", text: { body: "hola" } }])).status, 200);
    assert.equal((await s.deliver(host, [{ from: OWNER, id: "wamid.x2", type: "text", text: { body: "hola" } }], { secret: "f".repeat(32) })).status, 401);
    await s.deliver(host, [{ from: OWNER, id: "wamid.x3", type: "text", text: { body: "hola" } }], { numberId: "111111111111" });
    assert.equal((await s.get()).step, "test");

    assert.equal((await s.deliver(host, [{ from: OWNER, id: "wamid.hola", type: "text", text: { body: "Hola!" } }])).status, 200);
    const d = await s.get();
    assert.equal(d.step, "done");
    assert.deepEqual(d.done, ["app", "number", "values", "tunnel", "test"]);
    assert.equal(d.meta.window.open, true);
    assert.match(s.meta.sent().at(-1)!.text.body, /WhatsApp is connected to Pako/);
    assert.deepEqual(s.ingested, [], "the reply to the test is the setup's, not a message for the assistant");

    // Now a message: to the door, as the chat "whatsapp", from the owner as the door knows them. Meta's second delivery of it: dropped.
    await s.deliver(host, [{ from: OWNER, id: "wamid.m1", type: "text", text: { body: "¿qué tengo hoy?" } }]);
    await s.deliver(host, [{ from: OWNER, id: "wamid.m1", type: "text", text: { body: "¿qué tengo hoy?" } }]);
    assert.deepEqual(s.ingested, [{ m: { from: "15555550100", id: "wamid.m1", type: "text", text: { body: "¿qué tengo hoy?" } }, channel: "whatsapp" }]);
    // A voice note: not taken on a computer, and the owner is told where to send it.
    await s.deliver(host, [{ from: OWNER, id: "wamid.v1", type: "audio", audio: { id: "123456" } }]);
    assert.match(s.meta.sent().at(-1)!.text.body, /the panel's chat/);
    assert.equal(s.ingested.length, 1);

    // The door's way out: the owner's number, by Meta's messages endpoint.
    assert.equal(await s.c.line.reachable(), true);
    assert.equal(await s.c.line.deliver({ type: "text", text: { body: "Tienes dentista a las 5." } }), true);
    assert.deepEqual(s.meta.sent().at(-1), { messaging_product: "whatsapp", recipient_type: "individual", to: OWNER, type: "text", text: { body: "Tienes dentista a las 5." } });
    assert.ok(s.logged.some((l) => /connected/.test(l)));
  } finally {
    s.close();
  }
});

test("a new tunnel address (cloudflared started again) is registered with Meta again by itself; forgetting removes everything and closes the tunnel", async () => {
  const s = await setupServer();
  try {
    await s.post("saveMeta", VALUES);
    await s.post("tunnelOn");
    assert.ok(await until(async () => (await s.get()).meta.webhook === "verified"));
    const first = (await s.get()).tunnel.url as string;
    process.kill(Number(/fake-(\d+)-/.exec(first)![1]), "SIGKILL");
    assert.ok(await until(async () => {
      const d = await s.get();
      return d.tunnel.url && d.tunnel.url !== first && d.meta.webhook === "verified";
    }), "the new address verified");
    const second = (await s.get()).tunnel.url as string;
    assert.deepEqual(s.meta.subscriptions().map((b) => b.callback_url), [`${first}/whatsapp/webhook`, `${second}/whatsapp/webhook`]);

    // Meta refuses for a while (a new name not known everywhere yet): Pako tries again by itself.
    s.meta.state.subscribeOk = false;
    process.kill(Number(/fake-(\d+)-/.exec(second)![1]), "SIGKILL");
    assert.ok(await until(async () => (await s.get()).problems.some((p: string) => /hasn.t accepted/.test(p))));
    s.meta.state.subscribeOk = true;
    assert.ok(await until(async () => (await s.get()).meta.webhook === "verified"), "accepted on a later try");
    assert.deepEqual((await s.get()).problems, []);

    const gone = await s.post("forget");
    assert.equal(gone.body.ok, true);
    assert.equal(gone.body.step, "app");
    assert.equal(gone.body.tunnel.state, "off");
    assert.equal(s.stored(), null);
  } finally {
    s.close();
  }
});

test("owner numbers are written as WhatsApp writes them: digits with the country code", () => {
  assert.equal(ownerDigits("+34 612 34 56 78"), OWNER);
  assert.equal(ownerDigits("0034 (612) 345-678"), OWNER);
  assert.equal(ownerDigits("+34 612 abc"), "34612abc");
});

// ---------- the door: the owner's WhatsApp as a chat beside the panel's, on a computer ----------

const BRIDGE = "k".repeat(48);
async function localDoorWithWhatsapp() {
  const kv = memKv();
  const memory = loadMemory(kv);
  const channel = createLocalChannel({ kv });
  const got: Body[] = [];
  const line = { open: true, works: true };
  const config: WhatsappConfig = {
    accessToken: "local", phoneNumberId: "0", appSecret: "s".repeat(48), verifyToken: "s".repeat(48), bridgeToken: BRIDGE,
    ownerDigits: LOCAL_OWNER_NUMBER.replace(/\D/g, ""), ownerBsuid: "", graphVersion: "v23.0", templateName: "", templateLang: "es", friendMessages: false, reminderTemplate: "",
  };
  const app = express();
  const door = mountWhatsapp(app, {
    config, memory, kv, ownerName: "Marta", timeZone: "Europe/Madrid", contacts: () => [], local: channel, receiptWaitMs: 5000,
    tools: loadVoiceTools({ memory, actions: { contacts: () => [], callContact: async () => ({ ok: true, text: "" }), lookupCall: async () => "" } }),
    fetch: (async () => { throw new Error("nothing goes to Meta from the door in local mode"); }) as typeof fetch,
    whatsapp: { reachable: async () => line.open, deliver: async (b) => (line.works ? (got.push(b), true) : false) },
  });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: Body) =>
    fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${BRIDGE}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return {
    door, channel, got, line, post,
    fromWhatsapp: (id: string, text: string) => door.ingest({ from: door.ownerFrom, id, type: "text", text: { body: text } }, "whatsapp"),
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

test("the door, on a computer: an answer to a WhatsApp message goes back to WhatsApp; what Pako starts goes there too, with a copy in the panel", async () => {
  const r = await localDoorWithWhatsapp();
  try {
    await r.fromWhatsapp("wamid.HBgLMzQ2MTIzNDU2NzgVAgASGBQzQUE1", "apunta que el dentista es el martes");
    assert.equal((await r.post("/assistant/reply", { key: "wamid.HBgLMzQ2MTIzNDU2NzgVAgASGBQzQUE1", text: "Apuntado." })).status, 200);
    assert.ok(await until(() => r.got.some((b) => b.text?.body === "Apuntado.")), "the answer went to WhatsApp");
    assert.ok(!(await r.channel.list(0)).some((m) => m.text === "Apuntado."), "an answer has no copy in the panel");

    // Something Pako starts by itself (an older bridge's notes with no answer): on WhatsApp, and a copy in the panel marked so.
    const before = r.got.length;
    assert.equal((await r.post("/assistant/memory", { remember: ["la clave del wifi es pez espada"] })).status, 200);
    assert.ok(await until(() => r.got.length > before));
    const card = r.got.at(-1)!;
    assert.equal(card.type, "interactive");
    const copy = (await r.channel.list(0)).at(-1)!;
    assert.deepEqual([copy.text, copy.via], [card.interactive.body.text, "whatsapp"]);

    // WhatsApp's 24 hours over: what Pako starts stays in the panel's chat, unmarked.
    r.line.open = false;
    const n = r.got.length;
    assert.equal((await r.post("/assistant/memory", { remember: ["el portal es el 3B"] })).status, 200);
    assert.ok(await until(async () => (await r.channel.list(0)).filter((m) => m.buttons?.length).length >= 2));
    assert.equal(r.got.length, n);
    assert.equal((await r.channel.list(0)).at(-1)!.via, undefined);
  } finally {
    r.close();
  }
});

// ---------- the real app on a computer ----------

test("local Pako: the setup is in its panel, the door's stand-in verify token opens nothing, and the tunnel's requests never reach the panel", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "pako-wa-app-")), "home");
  const home = loadHome({ PAKO_HOME: dir });
  // WhatsApp is a lab (src/labs.ts): on here, as an owner who turned it on in Settings › Labs.
  const env = { ...localEnv({}, home, 0), PAKO_HOME: home.dir, PAKO_LABS: "whatsapp" };
  const kv = memKv();
  const settings = createSettings(home.dir, env);
  const local: LocalContext = {
    kv, channel: createLocalChannel({ kv }), bridgeToken: home.bridgeToken, panelSecret: home.panelSecret,
    bridge: { status: () => ({ claude: "ok", running: true }) }, settings,
  };
  const app = createApp(loadAppConfig(env), env, local);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch((app.locals.panelLink as () => string)().replace(/^http:\/\/127\.0\.0\.1:\d+/, base));
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const setup = await fetch(`${base}/panel/api/whatsapp/setup`, { headers: { cookie } });
    assert.equal(setup.status, 200);
    assert.equal(((await setup.json()) as Body).step, "app");
    assert.equal((await fetch(`${base}/panel/api/whatsapp/setup`)).status, 401, "signed in only");
    assert.equal((await fetch(`${base}/panel/api/whatsapp/setup`, { method: "POST", headers: { cookie } })).status, 401, "a POST needs x-pako");
    // The door's stand-in settings on a computer use the panel's secret as the verify token: it must never verify a webhook.
    const q = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": home.panelSecret, "hub.challenge": "42" });
    assert.equal((await fetch(`${base}/whatsapp/webhook?${q}`)).status, 403);
    // Through a tunnel (Cloudflare's headers), even with the panel's cookie: nothing but 404, and no tunnel is on.
    for (const path of ["/panel", "/panel/api/whatsapp/setup", "/assistant/inbox?wait=0", "/whatsapp/webhook"]) {
      assert.equal((await throughTunnel(port, "abc-def.trycloudflare.com", "GET", path, { headers: { cookie } })).status, 404, path);
    }
    // Saved values come back after a restart, from secrets.json (mode 600), never from the page.
    assert.equal(settings.setWhatsapp!({ ...VALUES, ownerNumber: OWNER, verifyToken: "v".repeat(32) }), true);
    assert.equal(statSync(join(home.dir, "secrets.json")).mode & 0o777, 0o600);
    assert.equal((settings.whatsapp!() as Body).phoneNumberId, NUMBER_ID);
    assert.equal(settings.setWhatsapp!(null), true);
    assert.equal(settings.whatsapp!(), null);
  } finally {
    (app.locals.whatsappComputer as { stop(): void }).stop();
    server.close();
    server.closeAllConnections();
  }
});

test("Meta refusing the tunnel's address for longer than the fast retries (an outage): Pako keeps trying, as the panel says, and gets there", async () => {
  let metaUp = false;
  let attempts = 0;
  const f = (async (input: string | URL) => {
    if (new URL(String(input)).pathname.endsWith("/subscriptions")) {
      attempts++;
      return new Response(JSON.stringify(metaUp ? { success: true } : { error: { code: 2 } }), { status: metaUp ? 200 : 500 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  let onUrl: (u: string | null) => void = () => {};
  const url = "https://a-b.trycloudflare.com";
  const health: [boolean, string?][] = [];
  const c = createComputerWhatsapp({
    health: (ok, detail) => void health.push([ok, detail]),
    store: { read: () => ({ appId: APP_ID, appSecret: SECRET, phoneNumberId: NUMBER_ID, accessToken: TOKEN, ownerNumber: OWNER,
      verifyToken: "v".repeat(32), tunnel: true, repliedAt: 1 }), write: () => true },
    kv: null, env: {}, lang: () => "en", fetch: f, phoneOn: () => false, retryMs: 2, verifyWaitMs: 10,
    tunnel: (cb) => ((onUrl = cb), { state: () => "on", url: () => url, why: () => null, start: () => onUrl(url), stop: () => {} }),
  });
  try {
    c.start();
    // 2 ms stands for the real 5 s: past the doubling waits (about five minutes in real time).
    await new Promise((r) => setTimeout(r, 600));
    const before = attempts;
    assert.ok(before >= 7);
    // Each refusal reaches the watchdog's WhatsApp part, with why: it tells the owner on the chat that still works once it lasts.
    assert.ok(health.length >= 7 && health.every(([ok]) => ok === false), JSON.stringify(health.slice(0, 2)));
    assert.match(health[0]![1]!, /Meta hasn't accepted the tunnel's address yet \(code 2\)/);
    metaUp = true;
    assert.ok(await until(async () => attempts > before, 3000), "registered again once Meta came back");
  } finally {
    c.stop();
  }
});
