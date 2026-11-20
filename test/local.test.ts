// Local mode (src/local.ts): Pako on one computer with no key: the home folder, the file store, the chat window and the whole path through the server.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { createApp, loadAppConfig, type LocalContext } from "../src/app.ts";
import { createLocalChannel, isLocalMode, loadHome, localEnv, LOCAL_OWNER_NUMBER } from "../src/local.ts";
import { sqliteKv } from "../src/sqlite-kv.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "pako-local-"));

test("isLocalMode: the default for someone who set nothing up; never on a server meant to be reached from outside", () => {
  assert.equal(isLocalMode({}), true);
  assert.equal(isLocalMode({ WHATSAPP_ACCESS_TOKEN: "EAAB" }), false, "WhatsApp is set up: the hosted way");
  assert.equal(isLocalMode({ PERSONAL_CALLER_TOKEN: "x".repeat(30) }), true, "the phone line alone does not leave local mode (it works from a computer too)");
  for (const host of ["RENDER", "RAILWAY_ENVIRONMENT", "FLY_APP_NAME", "K_SERVICE", "DYNO"]) assert.equal(isLocalMode({ [host]: "x" }), false, `on a hosting platform (${host})`);
  assert.equal(isLocalMode({ PAKO_LOCAL: "0" }), false);
  assert.equal(isLocalMode({ PAKO_LOCAL: "1", RENDER: "true" }), true, "forced on");
});

test("loadHome: secrets are made once, kept between starts, readable only by the owner; the name comes from the setting or the file", async () => {
  const dir = join(tmp(), "home");
  const first = loadHome({ PAKO_HOME: dir });
  assert.match(first.bridgeToken, /^[0-9a-f]{48}$/);
  assert.notEqual(first.bridgeToken, first.callerToken);
  assert.equal(statSync(join(dir, "secrets.json")).mode & 0o777, 0o600, "not readable by other users");
  assert.equal(loadHome({ PAKO_HOME: dir }).bridgeToken, first.bridgeToken, "the same at the next start: the browser stays signed in");
  assert.equal(first.name, "", "no name yet: the panel's welcome asks for it (the terminal never does)");
  assert.equal(loadHome({ PAKO_HOME: dir, PAKO_NAME: "Ana\u0007 López" }).name, "Ana López", "control characters never reach a prompt");
});

test("localEnv: fills only what is missing; the stand-in number is never dialled", () => {
  const home = { dir: "/h", bridgeToken: "b".repeat(48), callerToken: "c".repeat(48), panelSecret: "p".repeat(48), name: "Ana" };
  const env = localEnv({ PERSONAL_LIVE: "1", RETELL_API_KEY: "k" }, home, 8787);
  assert.equal(env.PERSONAL_OWNER_NUMBER, LOCAL_OWNER_NUMBER);
  assert.equal(env.PERSONAL_LIVE, "", "live calls are off while the number is a stand-in");
  assert.equal(env.ASSISTANT_SERVER_URL, "http://127.0.0.1:8787");
  assert.equal(env.PERSONAL_OWNER_NAME, "Ana");
  const real = localEnv({ PERSONAL_LIVE: "1", PERSONAL_OWNER_NUMBER: "+34600111222", PERSONAL_OWNER_NAME: "Marta" }, home, 8787);
  assert.deepEqual([real.PERSONAL_LIVE, real.PERSONAL_OWNER_NUMBER, real.PERSONAL_OWNER_NAME], ["1", "+34600111222", "Marta"], "the owner's own settings win");
});

test("local channel: what the door would send to Meta becomes chat messages; buttons keep their ids; the window is capped", async () => {
  const c = createLocalChannel({ kv: null, now: () => 5 });
  await c.deliver({ type: "text", text: { body: "Hi" } });
  await c.deliver({ type: "interactive", interactive: { type: "button", body: { text: "Shall I call Ana?" }, action: { buttons: [{ type: "reply", reply: { id: "c1:abcdef0123", title: "Call" } }, { type: "reply", reply: { id: "c0:abcdef0123", title: "Cancel" } }] } } });
  await c.deliver({ type: "template", template: { components: [{ type: "body", parameters: [{ type: "text", text: "⏰ Reminder: pay" }] }] } });
  await c.deliver({ type: "reaction" });
  const all = await c.list(0);
  assert.deepEqual(all.map((m) => [m.n, m.who, m.text]), [[1, "pako", "Hi"], [2, "pako", "Shall I call Ana?"], [3, "pako", "⏰ Reminder: pay"]]);
  assert.deepEqual(all[1]!.buttons, [{ id: "c1:abcdef0123", title: "Call" }, { id: "c0:abcdef0123", title: "Cancel" }]);
  assert.deepEqual((await c.list(2)).map((m) => m.n), [3], "only what is new");
  for (let i = 0; i < 320; i++) await c.push("you", `m${i}`);
  assert.equal((await c.list(0)).length, 300);
  const kv = sqliteKv(tmp());
  const kept = createLocalChannel({ kv });
  await kept.push("you", "persistente");
  assert.equal((await createLocalChannel({ kv }).list(0))[0]!.text, "persistente");
});

async function rig() {
  const home = loadHome({ PAKO_HOME: join(tmp(), "home"), PAKO_NAME: "Ana" });
  const env: Record<string, string | undefined> = { ...localEnv({}, home, 0), PAKO_HOME: home.dir };
  const kv = sqliteKv(home.dir);
  const local: LocalContext = { kv, channel: createLocalChannel({ kv }), bridgeToken: home.bridgeToken, panelSecret: home.panelSecret, bridge: { status: () => ({ claude: "ok", running: true }) } };
  const app = createApp(loadAppConfig(env), env, local);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const link = (app.locals.panelLink as () => string)().replace(/^http:\/\/127\.0\.0\.1:\d+/, base);
  const login = await fetch(link, { redirect: "manual" });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const api = (path: string, init: RequestInit = {}, headers: Record<string, string> = { cookie, "x-pako": "1" }) =>
    fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...headers, ...((init.headers as Record<string, string>) ?? {}) } });
  const bridge = (path: string, body?: unknown) => fetch(`${base}${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${home.bridgeToken}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { base, cookie, api, bridge, home, close: () => { server.close(); server.closeAllConnections(); } };
}

test("local mode end to end: the panel's chat reaches the assistant's inbox, the assistant's reply comes back to the window, and only the signed-in browser can use it", async () => {
  const r = await rig();
  try {
    assert.equal((await r.api("/panel/api/chat?since=0", {}, {})).status, 401, "no cookie");
    assert.equal((await r.api("/panel/api/chat", { method: "POST", body: JSON.stringify({ text: "hola" }) }, { cookie: r.cookie })).status, 401, "no custom header: another site cannot type for you");
    assert.equal((await r.api("/panel/api/chat", { method: "POST", body: JSON.stringify({ text: "   " }) })).status, 400);

    // The hello is there the first time.
    const first = (await (await r.api("/panel/api/chat?since=0")).json()) as { messages: { who: string; text: string }[]; status: { claude: string } };
    assert.match(first.messages[0]!.text, /^Hi, Ana\. I'm Pako/, "the hello is English, whatever language the owner then writes in");
    assert.equal(first.status.claude, "ok");

    assert.equal((await r.api("/panel/api/chat", { method: "POST", body: JSON.stringify({ text: "recuérdame pagar la luz" }) })).status, 202);
    // What the owner typed is waiting for the assistant exactly as a WhatsApp message would be.
    let inbox: { text: string }[] = [];
    for (let i = 0; i < 40 && !inbox.length; i++) {
      await sleep(25);
      inbox = ((await (await r.bridge("/assistant/inbox")).json()) as { messages: { text: string }[] }).messages;
    }
    assert.deepEqual(inbox.map((m) => m.text), ["recuérdame pagar la luz"]);
    // The assistant answers through the same route as always; the window shows it.
    assert.equal((await r.bridge("/assistant/reply", { text: "Hecho: te lo apunto." })).status, 200);
    const after = (await (await r.api("/panel/api/chat?since=0")).json()) as { messages: { n: number; who: string; text: string }[] };
    assert.deepEqual(after.messages.map((m) => [m.who, m.text]).slice(1), [["you", "recuérdame pagar la luz"], ["pako", "Hecho: te lo apunto."]]);
    assert.deepEqual((await (await r.api(`/panel/api/chat?since=${after.messages.at(-2)!.n}`)).json() as { messages: unknown[] }).messages.length, 1, "only what is new");
    // An answer (with the message's key) or a word with no key ("Un momento…": the owner's last chat) is not Pako's own start; a notice is,
    // and only that one is what the Mac app tells about (GET /panel/api/notices).
    assert.equal((await r.bridge("/assistant/reply", { text: "Un momento…" })).status, 200);
    assert.equal((await r.bridge("/assistant/reply", { text: "📧 Correo de Ana: «la cena»", notice: true })).status, 200);
    const marks = (await (await r.api("/panel/api/chat?since=0")).json()) as { messages: { who: string; text: string; started?: boolean }[] };
    assert.deepEqual(marks.messages.filter((m) => m.started).map((m) => m.text), ["📧 Correo de Ana: «la cena»"]);

    // Commands are answered by the server itself, with no assistant: the same STOP as on WhatsApp.
    await r.api("/panel/api/chat", { method: "POST", body: JSON.stringify({ text: "STOP" }) });
    await sleep(100);
    const stopped = (await (await r.api("/panel/api/chat?since=0")).json()) as { messages: { text: string }[] };
    assert.match(stopped.messages.at(-1)!.text, /Stopped/);
    assert.equal(((await (await r.api("/panel/api/overview")).json()) as { chat: boolean }).chat, true);
  } finally {
    r.close();
  }
});

test("a hosted server has no chat window: its routes answer 404, and local mode never exposes the chat without a login", async () => {
  const env: Record<string, string | undefined> = { PERSONAL_CALLER_TOKEN: "t".repeat(32), PERSONAL_OWNER_NAME: "Ana", PERSONAL_OWNER_NUMBER: "+34600111222", WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value", WHATSAPP_PHONE_NUMBER_ID: "109876543210", WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef", WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789", ASSISTANT_BRIDGE_TOKEN: "b".repeat(48) };
  const server = createServer(createApp(loadAppConfig(env), env));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/panel/api/chat`)).status, 404);
    assert.equal((await fetch(`${base}/panel/api/chat`, { method: "POST", headers: { "content-type": "application/json", "x-pako": "1" }, body: "{}" })).status, 404);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

// ---------- bug hunt 2: regression tests ----------

test("local: one Pako per home (a live one blocks, a dead one's lock is taken over); blank settings do not wipe the defaults; the bridge pair cannot be overridden", async () => {
  const { spawn } = await import("node:child_process");
  const { lockHome } = await import("../src/local.ts");
  const { writeFileSync } = await import("node:fs");
  const dir = tmp();
  const sleeper = spawn("sleep", ["30"]);
  try {
    writeFileSync(join(dir, ".lock"), String(sleeper.pid));
    assert.throws(() => lockHome(dir), /already running for this folder/);
    sleeper.kill();
    await new Promise((r) => sleeper.once("exit", r));
    const release = lockHome(dir); // the process in the lock is gone: taken over
    assert.equal(readFileSync(join(dir, ".lock"), "utf8"), String(process.pid));
    release();
  } finally {
    sleeper.kill();
  }
  const home = { dir: "/h", bridgeToken: "b".repeat(48), callerToken: "c".repeat(48), panelSecret: "p".repeat(48), name: "Ana" };
  const env = localEnv({ PERSONAL_OWNER_NAME: "", PERSONAL_OWNER_NUMBER: "  ".trim(), ASSISTANT_BRIDGE_TOKEN: "x".repeat(40), ASSISTANT_SERVER_URL: "https://elsewhere.example", PERSONAL_LIVE: "1" }, home, 8787);
  assert.equal(env.PERSONAL_OWNER_NAME, "Ana", "a blank line in .env does not turn the phone line off");
  assert.equal(env.ASSISTANT_BRIDGE_TOKEN, home.bridgeToken, "a stray token cannot leave the bridge refused for ever");
  assert.equal(env.ASSISTANT_SERVER_URL, "http://127.0.0.1:8787");
  assert.equal(env.PERSONAL_LIVE, "", "and no live call to the stand-in number");
});

test("local: the chat is answered 'sign in' before anything is counted, so anonymous requests cannot use up the owner's allowance; "
  + "the sign-in page fits local mode; the cookie is per port; a made-up asset name is a 404", async () => {
  const r = await rig();
  try {
    for (let i = 0; i < 80; i++) await fetch(`${r.base}/panel/api/chat`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
    assert.equal((await r.api("/panel/api/chat", { method: "POST", body: JSON.stringify({ text: "hola" }) })).status, 202, "the owner is not locked out by 80 anonymous posts");
    const page = await (await fetch(`${r.base}/panel`)).text();
    assert.match(page, /npm run panel/);
    assert.doesNotMatch(page, /WhatsApp/);
    assert.match(r.cookie, /^pako_panel_\d+=/);
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) assert.equal((await fetch(`${r.base}/panel/assets/${name}`)).status, 404, name);
    const first = (await (await r.api("/panel/api/chat?since=0")).json()) as { epoch: string };
    assert.match(first.epoch, /^\d+$/, "the poll says which start of the server it comes from");
  } finally {
    r.close();
  }
});
