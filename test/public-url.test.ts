// The panel's sign-in link (src/app.ts, src/whatsapp.ts, src/dashboard.ts) points only at an address the server was given, or learnt from a
// webhook Meta signed a moment ago. A forged Host header on an unsigned request (right after a restart, say) must never become the link the
// owner taps: the one-time token in it would go to whoever is at that host.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import express from "express";
import { createApp, loadAppConfig, type LocalContext } from "../src/app.ts";
import { createLocalChannel, loadHome, localEnv } from "../src/local.ts";
import { sqliteKv } from "../src/sqlite-kv.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";
import { loadWhatsappConfig, mountWhatsapp, type TelegramDoor } from "../src/whatsapp.ts";
import { logBody } from "../src/log.ts";

const OWNER = "+34600111222";
const OWNER_WA = "34600111222";
// Made-up values in the shapes the settings take: they open nothing.
const ENV = {
  PERSONAL_CALLER_TOKEN: "t".repeat(32),
  PERSONAL_OWNER_NAME: "Marta",
  PERSONAL_OWNER_NUMBER: OWNER,
  WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
};
const NO_ADDRESS = /^🖥️ .*PUBLIC_URL.*\(for example, https:\/\/pako\.example\.com\)/s;

type Answer = { status: number; headers: IncomingHttpHeaders; text: string };

/** One request with its headers exactly as given (fetch would not let the test forge the Host header). */
function call(port: number, path: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: o.method ?? "GET", headers: o.headers ?? {}, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(o.body);
  });
}

let n = 0;
const change = (value: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: ENV.WHATSAPP_PHONE_NUMBER_ID }, ...value } }] }],
});
/** A webhook body with one message from the owner, stamped `at` (Meta's stamps are in seconds). */
const message = (text: string, at = Date.now()) =>
  JSON.stringify(change({ messages: [{ from: OWNER_WA, id: `wamid.url${++n}`, timestamp: String(Math.floor(at / 1000)), type: "text", text: { body: text } }] }));
/** A webhook body with only a delivery status, stamped `at`. */
const status = (at = Date.now()) =>
  JSON.stringify(change({ statuses: [{ id: "wamid.out1", status: "delivered", timestamp: String(Math.floor(at / 1000)), recipient_id: OWNER_WA }] }));
const sign = (raw: string) => `sha256=${createHmac("sha256", ENV.WHATSAPP_APP_SECRET).update(raw).digest("hex")}`;
const HTTPS = { "x-forwarded-proto": "https" };

/**
 * The whole app as a server on the internet runs it (not local mode), with a stand-in for Meta's Graph API: what the door says to the owner is
 * kept in `sent`, and nothing reaches the network.
 */
async function hosted(extra: Record<string, string> = {}) {
  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (!u.startsWith("https://graph.facebook.com/")) throw new Error(`no network in this test: ${u}`);
    const body = JSON.parse(String(init?.body)) as { type?: string; text?: { body?: string } };
    if (body.type === "text") sent.push(String(body.text?.body));
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out${sent.length}` }] }), { status: 200 });
  }) as typeof fetch;
  const env = { ...ENV, ...extra };
  let app: ReturnType<typeof createApp>;
  try {
    app = createApp(loadAppConfig(env), env);
  } catch (err) {
    globalThis.fetch = realFetch;
    throw err;
  }
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  /** A webhook as Meta sends it (signed), or as anyone can (signature "": none at all). */
  const hook = (raw: string, headers: Record<string, string> = {}, signature = sign(raw)) =>
    call(port, "/whatsapp/webhook", {
      method: "POST",
      body: raw,
      headers: { "content-type": "application/json", ...(signature ? { "x-hub-signature-256": signature } : {}), ...headers },
    });
  return {
    port,
    sent,
    hook,
    /** What PANEL would give now (the same function the door calls). */
    link: () => (app.locals.panelLink as () => string | null)(),
    close: () => {
      globalThis.fetch = realFetch;
      server.close();
      server.closeAllConnections();
    },
  };
}

test("the attack: an unsigned webhook with a forged Host teaches nothing, and PANEL then gives no link at all, only how to set PUBLIC_URL", async () => {
  // Behind a proxy that says https (TRUST_PROXY_HOPS), as on a server on the internet: the forged request looks like it came over https.
  const r = await hosted({ TRUST_PROXY_HOPS: "1" });
  try {
    const forged = { ...HTTPS, host: "evil.example", "x-forwarded-host": "evil.example" };
    assert.equal((await r.hook(message("hola"), forged, "")).status, 401, "no signature");
    assert.equal((await r.hook(message("hola"), forged, "sha256=00")).status, 401, "a made-up signature");
    // The way in before: the Host of any request that the webhook's own routes did not answer (another method, a path under it) was taken.
    for (const [method, path] of [["PUT", "/whatsapp/webhook"], ["OPTIONS", "/whatsapp/webhook"], ["GET", "/whatsapp/webhook/x"], ["POST", "/whatsapp/webhook/x"]]) {
      const body = method === "PUT" || method === "POST" ? { body: message("hola") } : {};
      await call(r.port, path!, { method: method!, headers: { ...forged, "content-type": "application/json" }, ...body });
    }
    // The owner writes PANEL. Meta's request reaches this test server by its loopback address, which is no public address either.
    assert.equal((await r.hook(message("PANEL"), { ...HTTPS, "x-forwarded-host": "evil.example" })).status, 200);
    assert.equal(r.sent.length, 1);
    assert.doesNotMatch(r.sent[0]!, /evil\.example/, "the link never points at the forged host");
    assert.doesNotMatch(r.sent[0]!, /\/panel\/login\//, "no link at all: nothing else is known");
    assert.match(r.sent[0]!, NO_ADDRESS);
    assert.ok(r.sent[0]!.length < 1024, "short");
    assert.equal(r.link(), null, "and no one-time token is made for nothing");
  } finally {
    r.close();
  }
});

test("a webhook Meta signed teaches the address, once: PANEL's link goes there; the cookie of a panel that learnt its address after the start is the https one", async () => {
  const r = await hosted({ TRUST_PROXY_HOPS: "1" });
  try {
    assert.equal(r.link(), null, "nothing known at the start");
    assert.equal((await r.hook(message("hola"), { ...HTTPS, host: "evil.example" }, "")).status, 401);
    // Signed: its Host header is the address Meta calls. X-Forwarded-Host is never read.
    assert.equal((await r.hook(message("hola"), { ...HTTPS, host: "Pako.Example.com", "x-forwarded-host": "evil.example" })).status, 200);
    // A later signed request with another Host does not move it.
    assert.equal((await r.hook(message("PANEL"), { ...HTTPS, host: "other.example" })).status, 200);
    const link = /\n(https:\/\/\S+)$/.exec(r.sent.at(-1)!)?.[1] ?? "";
    assert.match(link, /^https:\/\/pako\.example\.com\/panel\/login\/[A-Za-z0-9_-]{32}$/);

    const login = await call(r.port, new URL(link).pathname, { headers: { ...HTTPS, host: "pako.example.com" } });
    assert.equal(login.status, 200);
    const setCookie = login.headers["set-cookie"]?.[0] ?? "";
    assert.match(setCookie, /^pako_panel_443=\d+\.[A-Za-z0-9_-]+; .*HttpOnly; Secure; SameSite=Strict$/, "named for https, and Secure");
    const cookie = setCookie.split(";")[0]!;
    assert.equal((await call(r.port, "/panel/api/overview", { headers: { cookie } })).status, 200, "and it signs the browser in");
    assert.equal((await call(r.port, new URL(link).pathname)).status, 401, "the link works once");
  } finally {
    r.close();
  }
});

test("what teaches nothing: a signed request not seen as https, one that names localhost or no plain host name, one Meta stamped long ago", async () => {
  // No proxy that says https: the server cannot tell the request came over https.
  const plain = await hosted();
  try {
    assert.equal((await plain.hook(message("hola"), { host: "pako.example.com" })).status, 200);
    assert.equal(plain.link(), null);
  } finally {
    plain.close();
  }
  const r = await hosted({ TRUST_PROXY_HOPS: "1" });
  try {
    for (const host of ["localhost:8787", "127.0.0.1", "marta@evil.example", "evil.example/x", "evil"]) {
      assert.equal((await r.hook(message("hola"), { ...HTTPS, host })).status, 200, host);
      assert.equal(r.link(), null, host);
    }
    // Meta's signature covers the body only and never expires: a body it signed an hour ago, sent again with another Host, proves nothing.
    assert.equal((await r.hook(message("hola", Date.now() - 3600_000), { ...HTTPS, host: "evil.example" })).status, 200, "the message is still handled");
    assert.equal((await r.hook(status(Date.now() + 3600_000), { ...HTTPS, host: "evil.example" })).status, 200);
    assert.equal(r.link(), null, "an old (or future) stamp teaches nothing");
    // One stamped just now does, a delivery status as much as a message.
    assert.equal((await r.hook(status(), { ...HTTPS, host: "pako.example.com" })).status, 200);
    assert.match(r.link() ?? "", /^https:\/\/pako\.example\.com\/panel\/login\/[A-Za-z0-9_-]{32}$/);
  } finally {
    r.close();
  }
});

test("the address from the settings: PUBLIC_URL wins over what a signed webhook would teach; Render's own variables work; a localhost or http one is never used", async () => {
  const r = await hosted({ PUBLIC_URL: "https://pako.example.com/", RENDER_EXTERNAL_URL: "https://pako-abc.onrender.com", TRUST_PROXY_HOPS: "1" });
  try {
    assert.equal((await r.hook(message("PANEL"), { ...HTTPS, host: "other.example" })).status, 200);
    assert.match(r.sent.at(-1)!, /^🖥️ Your Pako panel .*\nhttps:\/\/pako\.example\.com\/panel\/login\/[A-Za-z0-9_-]{32}$/s);
  } finally {
    r.close();
  }
  const cases: [Record<string, string>, string | null][] = [
    [{ RENDER_EXTERNAL_URL: "https://pako-abc.onrender.com" }, "https://pako-abc.onrender.com"],
    [{ RENDER_EXTERNAL_HOSTNAME: "pako-abc.onrender.com" }, "https://pako-abc.onrender.com"],
    [{ PUBLIC_URL: "http://localhost:8787", RENDER_EXTERNAL_URL: "https://pako-abc.onrender.com" }, "https://pako-abc.onrender.com"],
    [{ PUBLIC_URL: "http://localhost:8787" }, null],
    [{ PUBLIC_URL: "http://pako.example.com" }, null],
    [{ PUBLIC_URL: "https://127.0.0.1:8787" }, null],
  ];
  const keepErr = console.error;
  for (const [env, base] of cases) {
    const errs: string[] = [];
    console.error = (...a: unknown[]) => void errs.push(logBody(a.join(" ")));
    const s = await hosted(env).finally(() => (console.error = keepErr));
    try {
      const link = s.link();
      if (base === null) assert.equal(link, null, JSON.stringify(env));
      else assert.ok(link?.startsWith(`${base}/panel/login/`), `${JSON.stringify(env)}: ${link}`);
      // The owner who set a PUBLIC_URL that cannot be used is told why in the log.
      assert.equal(errs.some((e) => /^\[panel\] PUBLIC_URL is ignored/.test(e)), !!env.PUBLIC_URL, JSON.stringify(env));
    } finally {
      s.close();
    }
  }
});

test("nothing known on a server: the panel shows only its sign-in page, and no cookie signs anyone in", async () => {
  const r = await hosted();
  try {
    const page = await call(r.port, "/panel", { headers: { host: "evil.example" } });
    assert.equal(page.status, 200);
    assert.match(page.text, /type <b>PANEL<\/b> to Pako on WhatsApp/);
    const madeUp = `pako_panel=${Date.now() + 3600_000}.AAAA; pako_panel_443=${Date.now() + 3600_000}.AAAA`;
    assert.equal((await call(r.port, "/panel/api/overview", { headers: { cookie: madeUp } })).status, 401);
    assert.equal(r.link(), null);
  } finally {
    r.close();
  }
});

test("PANEL with no known address answers how to set PUBLIC_URL where the owner wrote: WhatsApp or Telegram", async () => {
  const memory = loadMemory(null);
  const whatsapp: string[] = [];
  const telegram: string[] = [];
  const tg: TelegramDoor = {
    paired: async () => true,
    reachable: async () => true,
    deliver: async (body) => {
      telegram.push(String((body.text as { body?: string } | undefined)?.body));
      return true;
    },
    pairLink: async () => null,
    unpair: async () => true,
    farewell: async () => undefined,
    media: async () => null,
  };
  const door = mountWhatsapp(express(), {
    config: loadWhatsappConfig(ENV, OWNER).config!, memory, kv: null, ownerName: "Marta", timeZone: "Europe/Madrid", contacts: () => [],
    tools: loadVoiceTools({ memory, actions: { contacts: () => [], callContact: async () => ({ ok: true, text: "" }), lookupCall: async () => "" } }),
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      whatsapp.push(String((JSON.parse(String(init?.body)) as { text?: { body?: string } }).text?.body));
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
    panelLink: () => null,
    telegram: tg,
  });
  assert.equal(await door.ingest({ from: door.ownerFrom, id: "tg-7001-1", type: "text", text: { body: "PANEL" } }, "telegram"), "panel address unknown");
  assert.equal(telegram.length, 1);
  assert.match(telegram[0]!, NO_ADDRESS);
  assert.equal(await door.ingest({ from: door.ownerFrom, id: "wamid.url-wa", type: "text", text: { body: "Panel" } }), "panel address unknown");
  assert.equal(whatsapp.length, 1);
  assert.match(whatsapp[0]!, NO_ADDRESS);
  assert.deepEqual(await door.inbox.peek(), [], "answered by the server, not queued for the assistant");
});

test("onSigned (the door's hook): called only for a webhook signed and stamped minutes ago, with its request; a hook that throws does not stop the message", async () => {
  const memory = loadMemory(null);
  const hosts: string[] = [];
  let boom = false;
  const app = express();
  const door = mountWhatsapp(app, {
    config: loadWhatsappConfig(ENV, OWNER).config!, memory, kv: null, ownerName: "Marta", timeZone: "Europe/Madrid", contacts: () => [],
    tools: loadVoiceTools({ memory, actions: { contacts: () => [], callContact: async () => ({ ok: true, text: "" }), lookupCall: async () => "" } }),
    fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch,
    onSigned: (req) => {
      hosts.push(String(req.get("host")));
      if (boom) throw new Error("boom");
    },
  });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const hook = (raw: string, host: string, signature = sign(raw)) =>
    call(port, "/whatsapp/webhook", { method: "POST", body: raw, headers: { "content-type": "application/json", host, ...(signature ? { "x-hub-signature-256": signature } : {}) } });
  const keepErr = console.error;
  const errs: string[] = [];
  console.error = (...a: unknown[]) => void errs.push(logBody(a.join(" ")));
  try {
    assert.equal((await hook(message("uno"), "a.example", "")).status, 401);
    assert.equal((await hook(message("dos", Date.now() - 3600_000), "b.example")).status, 200);
    assert.deepEqual(hosts, [], "not for an unsigned request, nor for a body Meta signed an hour ago");
    assert.equal((await hook(message("tres"), "c.example")).status, 200);
    assert.deepEqual(hosts, ["c.example"]);
    boom = true;
    assert.equal((await hook(message("cuatro"), "d.example")).status, 200, "Meta is not made to send it again");
    assert.ok(errs.some((e) => e === "[whatsapp] could not learn from a signed webhook: boom"), errs.join(" | "));
    assert.deepEqual((await door.inbox.peek()).map((m) => m.text), ["dos", "tres", "cuatro"], "every signed message is still handled");
  } finally {
    console.error = keepErr;
    server.close();
    server.closeAllConnections();
  }
});

test("local mode is unchanged: the loopback link at the start and from PANEL in the panel's chat; a forged Host on the webhook changes nothing", async () => {
  const home = loadHome({ PAKO_HOME: join(mkdtempSync(join(tmpdir(), "pako-url-")), "home"), PAKO_NAME: "Ana" });
  const env: Record<string, string | undefined> = { ...localEnv({}, home, 0), PAKO_HOME: home.dir };
  const kv = sqliteKv(home.dir);
  const local: LocalContext = {
    kv, channel: createLocalChannel({ kv }), bridgeToken: home.bridgeToken, panelSecret: home.panelSecret, bridge: { status: () => ({ claude: "ok", running: true }) },
  };
  const app = createApp(loadAppConfig(env), env, local);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    const link = (app.locals.panelLink as () => string | null)() ?? "";
    assert.match(link, /^http:\/\/127\.0\.0\.1:8787\/panel\/login\/[A-Za-z0-9_-]{32}$/, "the loopback address, as before");
    const forged = { "content-type": "application/json", host: "evil.example", "x-forwarded-proto": "https" };
    // On a computer a name that is not this one's is refused before any route (src/guard-http.ts): 421, not even the webhook's 401.
    assert.equal((await call(port, "/whatsapp/webhook", { method: "POST", headers: forged, body: message("hola") })).status, 421);

    const cookie = (await call(port, new URL(link).pathname)).headers["set-cookie"]?.[0]?.split(";")[0] ?? "";
    assert.match(cookie, /^pako_panel_8787=/, "the cookie is named for the port, as before");
    const typed = await call(port, "/panel/api/chat", {
      method: "POST",
      headers: { cookie, "x-pako": "1", "content-type": "application/json" },
      body: JSON.stringify({ text: "PANEL" }),
    });
    assert.equal(typed.status, 202);
    let answer = "";
    for (let i = 0; i < 200 && !answer; i++) {
      await sleep(25);
      const chat = JSON.parse((await call(port, "/panel/api/chat?since=0", { headers: { cookie } })).text) as { messages: { who: string; text: string }[] };
      answer = chat.messages.find((m) => m.who === "pako" && m.text.startsWith("🖥️"))?.text ?? "";
    }
    assert.match(answer, /^🖥️ Your Pako panel .*\nhttp:\/\/127\.0\.0\.1:8787\/panel\/login\/[A-Za-z0-9_-]{32}$/s);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
