// Core and Labs (src/labs.ts): the registry's defaults, PAKO_LABS, grandfathering an install that already set a lab up, the panel's switch
// (Settings › Labs), a lab that is off starting nothing in the real app on a computer, and the assistant told nothing of a lab that is off.
// test/labs.test.ts covers the companion lab itself (the health diary, learning, the check-in).

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contextBlock, type Context } from "../assistant/bridge/context.ts";
import { answerCall } from "../assistant/mcp-server.ts";
import { labsOffOf, SYSTEM_PROMPT, systemPromptFor, toolsSystemPromptFor } from "../assistant/prompt.ts";
import { toolDataOf, unavailable } from "../assistant/tools.ts";
import { createApp, loadAppConfig, type LocalContext } from "../src/app.ts";
import { labsFor } from "../src/app/base.ts";
import { loadLabCode } from "../src/lab-code.ts";
import {
  grandfatherNote, LAB_IDS, LABS, LABS_NOTE, parseLabsSetting, readLabChoices, resolveLabs, writeLabChoice, type LabId,
} from "../src/labs.ts";
import { createLocalChannel, createSettings, loadHome, localEnv } from "../src/local.ts";
import { sqliteKv } from "../src/sqlite-kv.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "pako-labs-"));
type Body = Record<string, unknown>;

// ---------- the registry ----------

test("the registry: five labs, each with a name and a one-line reason; all off for a new install", () => {
  assert.deepEqual([...LAB_IDS], ["booking", "calls", "whatsapp", "relay", "companion"]);
  for (const l of LABS) {
    assert.ok(l.name && l.why, l.id);
    assert.ok(!l.why.includes("\n") && l.why.length <= 140, `${l.id}: one short line`);
  }
  const labs = resolveLabs({ env: {} });
  assert.deepEqual(labs.enabled(), []);
  assert.ok(labs.states().every((s) => !s.on && s.source === "default"));
  assert.deepEqual(labs.grandfathered, []);
  assert.equal(grandfatherNote(labs), null, "nothing to say for a new install");
  // A computer's new install too: no switch set, nothing set up.
  assert.deepEqual(resolveLabs({ env: {}, choices: {}, setUp: { whatsapp: false } }).enabled(), []);
});

test("PAKO_LABS: ids with commas, on/all for every lab (as PAKO_LABS=on always meant for the diary), off for none, unknown words said", () => {
  assert.deepEqual([...parseLabsSetting("booking, calls").ids].sort(), ["booking", "calls"]);
  assert.deepEqual([...parseLabsSetting("on").ids], [...LAB_IDS]);
  assert.deepEqual([...parseLabsSetting("ALL").ids], [...LAB_IDS]);
  assert.equal(parseLabsSetting("off").ids.size, 0);
  assert.equal(parseLabsSetting(undefined).ids.size, 0);
  assert.deepEqual(parseLabsSetting("booking,teleport").unknown, ["teleport"]);
  const labs = resolveLabs({ env: { PAKO_LABS: "companion" }, choices: { companion: false } });
  assert.equal(labs.on("companion"), true, "the setting wins over the panel's switch");
  assert.equal(labs.states().find((s) => s.id === "companion")!.source, "env");
});

test("grandfathering: a lab already set up stays on, said in one line; the panel's switch can still turn it off", () => {
  const env = {
    GOOGLE_PLACES_API_KEY: "AIza" + "x".repeat(35), RETELL_API_KEY: "key_1", RELAY_URL: "https://relay.example", WHATSAPP_ACCESS_TOKEN: "EAAB",
  };
  const labs = resolveLabs({ env });
  assert.deepEqual(labs.enabled(), ["booking", "calls", "whatsapp", "relay"]);
  assert.deepEqual(labs.grandfathered, ["booking", "calls", "whatsapp", "relay"]);
  assert.equal(labs.on("companion"), false, "the diary was off by default before: nothing to keep");
  const note = grandfatherNote(labs)!;
  assert.match(note, /^kept on, set up before Labs: booking, calls, whatsapp, relay/);
  assert.ok(!note.includes("AIza") && !note.includes("key_1"), "never a value");
  // A computer's WhatsApp is kept with the secrets, not in the environment.
  assert.equal(resolveLabs({ env: {}, setUp: { whatsapp: true } }).on("whatsapp"), true);
  // Blank values do not count.
  assert.equal(resolveLabs({ env: { GOOGLE_PLACES_API_KEY: "  " } }).on("booking"), false);
  // The owner's own switch wins over grandfathering.
  const off = resolveLabs({ env, choices: { booking: false } });
  assert.equal(off.on("booking"), false);
  assert.deepEqual(off.grandfathered, ["calls", "whatsapp", "relay"]);
});

test("the switches are kept in config.json under labs, beside the name, and read back as true or false only", () => {
  const dir = tmp();
  assert.deepEqual(readLabChoices(dir), {}, "no file: nothing chosen");
  const settings = createSettings(dir, {});
  settings.setName("Ana");
  assert.equal(writeLabChoice(dir, "booking", true), true);
  assert.equal(writeLabChoice(dir, "calls", false), true);
  assert.deepEqual(readLabChoices(dir), { booking: true, calls: false });
  const file = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Body;
  assert.equal(file.name, "Ana", "the other fields stay");
  assert.equal(createSettings(dir, {}).name(), "Ana");
});

// ---------- the real app on a computer ----------

async function rig(o: { env?: Record<string, string>; choices?: Partial<Record<LabId, boolean>> } = {}) {
  const home = loadHome({ PAKO_HOME: join(tmp(), "home"), PAKO_NAME: "Ana" });
  for (const [id, on] of Object.entries(o.choices ?? {})) writeLabChoice(home.dir, id as LabId, on);
  const env: Record<string, string | undefined> = { ...localEnv({}, home, 0), PAKO_HOME: home.dir, ...(o.env ?? {}) };
  const kv = sqliteKv(home.dir);
  const local: LocalContext = {
    kv, channel: createLocalChannel({ kv }), bridgeToken: home.bridgeToken, panelSecret: home.panelSecret,
    bridge: { status: () => ({ claude: "ok", running: true }) }, settings: createSettings(home.dir, env),
  };
  // As src/server.ts does: the code of the labs that are on, before the app.
  await loadLabCode(labsFor(env, local));
  const app = createApp(loadAppConfig(env), env, local);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const link = (app.locals.panelLink as () => string)().replace(/^http:\/\/127\.0\.0\.1:\d+/, base);
  const cookie = ((await fetch(link, { redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0]!;
  const panel = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { cookie, "x-pako": "1", "content-type": "application/json", ...((init.headers as Record<string, string>) ?? {}) } });
  const context = async () => (await (await fetch(`${base}/assistant/context`, { headers: { authorization: `Bearer ${home.bridgeToken}` } })).json()) as Body;
  return {
    app, base, home, panel, context, cookie,
    close: () => {
      (app.locals.whatsappComputer as { stop(): void } | undefined)?.stop();
      server.close();
      server.closeAllConnections();
    },
  };
}

const RELAY = { RELAY_TOKEN: "r".repeat(40), RELAY_TELEGRAM_TOKEN: `12345:${"A".repeat(35)}`, RELAY_TELEGRAM_CHAT: "987654321" };
const PLACES = { GOOGLE_PLACES_API_KEY: `AIza${"x".repeat(35)}`, PAKO_MAITRE: "off" };

test("a new install: every lab off, and none starts: no WhatsApp setup, webhook or tunnel, no relay, no booking in the context", async () => {
  const r = await rig();
  try {
    assert.equal(r.app.locals.whatsappComputer, undefined, "nothing for server.ts to start (no tunnel)");
    assert.equal((await r.panel("/panel/api/whatsapp/setup")).status, 404);
    assert.equal((await fetch(`${r.base}/relay/sync`, { method: "POST" })).status, 404, "not a relay");
    const ctx = await r.context();
    assert.deepEqual(ctx.labsOn, []);
    assert.equal("bookings" in ctx, false);
    assert.equal(ctx.labsOff, 1, "the companion lab is off as before");
  } finally {
    r.close();
  }
});

test("disabled labs start nothing even when set up: the owner's switch off for booking and the relay", async () => {
  const r = await rig({ env: { ...PLACES, ...RELAY }, choices: { booking: false, relay: false } });
  try {
    assert.equal((await fetch(`${r.base}/relay/sync`, { method: "POST" })).status, 404, "no relay routes, no relay timer");
    const ctx = await r.context();
    assert.equal("bookings" in ctx, false, "no Places, no Maître, no browser");
    assert.deepEqual(ctx.labsOn, []);
  } finally {
    r.close();
  }
});

test("an existing install keeps what it set up: booking, the relay and WhatsApp from before Labs are on (grandfathered)", async () => {
  const r = await rig({ env: { ...PLACES, ...RELAY } });
  try {
    assert.equal((await fetch(`${r.base}/relay/sync`, { method: "POST" })).status, 401, "the relay answers (wrong token)");
    const ctx = await r.context();
    assert.ok(Array.isArray(ctx.bookings), "booking is in the assistant's context");
    assert.deepEqual(ctx.labsOn, ["booking", "relay"]);
    const labs = (await (await r.panel("/panel/api/labs")).json()) as { labs: { id: string; on: boolean; source: string }[] };
    assert.deepEqual(labs.labs.filter((l) => l.on).map((l) => [l.id, l.source]), [["booking", "grandfathered"], ["relay", "grandfathered"]]);
  } finally {
    r.close();
  }
  // A computer's WhatsApp set up in the panel before Labs: its setup stays.
  const home = loadHome({ PAKO_HOME: join(tmp(), "home") });
  const settings = createSettings(home.dir, {});
  assert.equal(settings.setWhatsapp!({ phoneNumberId: "123456789012345", tunnel: false }), true);
  const env = { ...localEnv({}, home, 0), PAKO_HOME: home.dir };
  const kv = sqliteKv(home.dir);
  const local: LocalContext = {
    kv, channel: createLocalChannel({ kv }), bridgeToken: home.bridgeToken, panelSecret: home.panelSecret,
    bridge: { status: () => ({ claude: "ok", running: true }) }, settings,
  };
  await loadLabCode(labsFor(env, local));
  const app = createApp(loadAppConfig(env), env, local);
  assert.ok(app.locals.whatsappComputer, "the WhatsApp of this computer is still there");
  (app.locals.whatsappComputer as { stop(): void }).stop();
});

test("the phone line's LiveKit voice stack exists only with the calls lab on", async () => {
  const livekit = { LIVEKIT_URL: "wss://lk.example", LIVEKIT_API_KEY: "APIkey", LIVEKIT_API_SECRET: "s".repeat(32), ADMIN_KEY: "a".repeat(32) };
  // The voice stack reads the process's environment (src/voice-bridge.ts): set for this file's process only.
  Object.assign(process.env, livekit);
  try {
    for (const [on, status] of [[false, 404], [true, 200]] as const) {
      const r = await rig({ env: livekit, choices: { calls: on } });
      try {
        const page = await fetch(`${r.base}/admin/voice-lab`, { headers: { authorization: `Bearer ${livekit.ADMIN_KEY}` } });
        assert.equal(page.status, status, `calls ${on ? "on" : "off"}`);
        assert.equal(((await r.context()).labsOn as string[]).includes("calls"), on);
      } finally {
        r.close();
      }
    }
  } finally {
    for (const k of Object.keys(livekit)) delete process.env[k];
  }
});

test("the panel lists every lab with its note; a switch is kept and restarts; PAKO_LABS locks it; signed in with x-pako only", async () => {
  let restarts = 0;
  const r = await rig({ env: { PAKO_LABS: "companion" } });
  r.app.locals.restart = () => void restarts++;
  try {
    assert.equal((await fetch(`${r.base}/panel/api/labs`)).status, 401, "signed in only");
    const got = (await (await r.panel("/panel/api/labs")).json()) as { note: string; labs: Body[] };
    assert.equal(got.note, LABS_NOTE);
    assert.equal(got.note, "Experimental: may break when the service changes.");
    assert.deepEqual(got.labs.map((l) => l.id), [...LAB_IDS]);
    assert.ok(got.labs.every((l) => typeof l.name === "string" && typeof l.why === "string"));
    assert.deepEqual(got.labs.filter((l) => l.on).map((l) => [l.id, l.locked]), [["companion", true]]);

    const body = JSON.stringify({ id: "booking", on: true });
    const noHeader = await fetch(`${r.base}/panel/api/labs`, { method: "POST", headers: { cookie: r.cookie, "content-type": "application/json" }, body });
    assert.equal(noHeader.status, 401, "a POST needs the session and x-pako");
    assert.equal((await r.panel("/panel/api/labs", { method: "POST", body: JSON.stringify({ id: "teleport", on: true }) })).status, 400);
    assert.equal((await r.panel("/panel/api/labs", { method: "POST", body: JSON.stringify({ id: "companion", on: false }) })).status, 409);

    const res = await r.panel("/panel/api/labs", { method: "POST", body: JSON.stringify({ id: "booking", on: true }) });
    assert.deepEqual(await res.json(), { ok: true, restarting: true });
    await new Promise((done) => setTimeout(done, 400));
    assert.equal(restarts, 1, "Pako starts again with the new choice");
    assert.deepEqual(readLabChoices(r.home.dir), { booking: true });
  } finally {
    r.close();
  }
});

test("the settings page hides a lab's cards while it is off, and hides none for an older Pako", async () => {
  const model = (await import(new URL("../src/panel/settings-model.js", import.meta.url).href)) as {
    labHiddenCards: (labs: unknown) => Set<string>;
    LAB_CARDS: Record<string, string>;
  };
  const off = { labs: LAB_IDS.map((id) => ({ id, on: id === "whatsapp" })) };
  assert.deepEqual([...model.labHiddenCards(off)].sort(), ["phone", "tables"]);
  assert.deepEqual([...model.labHiddenCards(null)], []);
  // Every card a lab names is one the registry knows, and back.
  assert.deepEqual(Object.entries(model.LAB_CARDS).sort(), LABS.flatMap((l) => l.cards.map((c) => [c, l.id])).sort());
});

// ---------- the assistant ----------

test("the assistant: with booking and calls off, their tags leave the prompt, their tools are refused, and the context says so", () => {
  const ctx = { labsOn: [] as string[], bookings: [] as string[] };
  assert.deepEqual(labsOffOf(ctx), { book: true, call: true });
  assert.deepEqual(labsOffOf({}), {}, "an older server lists no labs: nothing is left out");
  assert.deepEqual(labsOffOf({ labsOn: ["booking", "calls"] }), { book: false, call: false });

  const prompt = systemPromptFor(false, labsOffOf(ctx));
  assert.ok(!prompt.includes("<book ") && !prompt.includes('<call to="Name">'), "no tag for a lab that is off");
  assert.ok(SYSTEM_PROMPT.includes("<book ") && SYSTEM_PROMPT.includes('<call to="Name">'), "the default prompt is as before");
  assert.equal(systemPromptFor(false, {}), SYSTEM_PROMPT);
  assert.ok(prompt.includes("<remind"), "only those lines go");
  assert.ok(toolsSystemPromptFor(false, labsOffOf(ctx)).length > 0, "the tools' prompt still builds");

  const data = toolDataOf("m1", ctx);
  assert.equal(data.on.book, false);
  assert.equal(data.on.call, false);
  assert.match(unavailable("book_table", data)!, /not connected/);
  assert.match(unavailable("propose_call", data)!, /Labs/);
  const refused = answerCall("propose_call", { to: "Ana", message: "running late" }, data, new Map());
  assert.equal(refused.isError, true);
  const on = toolDataOf("m2", { labsOn: ["booking", "calls"], bookings: [] });
  assert.equal(unavailable("book_table", on), null);
  assert.equal(unavailable("propose_call", on), null);
  assert.equal(unavailable("propose_call", toolDataOf("m3", {})), null, "an older server: calls as before");

  const block = contextBlock({ now: "Friday", ownerName: "Ana", contacts: [], memory: "", reminders: [], ...ctx } as unknown as Context, true);
  assert.match(block, /Turned off on this Pako \(Labs\): table booking, phone calls\. Do not offer them/);
  const older = contextBlock({ now: "Friday", ownerName: "Ana", contacts: [], memory: "", reminders: [] } as unknown as Context, true);
  assert.ok(!older.includes("Turned off on this Pako"));
});
