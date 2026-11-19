// The store guard (src/store-guard.ts) and the pause that fails closed (src/control.ts). A store that comes back empty (a free Render Key Value
// keeps nothing when it restarts) pauses everything and tells the owner once; a store from before the guard is marked without a word; a store
// that cannot be read keeps every call and message back until it answers; a wipe under a running Pako writes the pause back. Wired as
// src/app.ts wires it, with stand-ins for Meta and the store. Nothing here reaches the network.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import express from "express";
import { createApp, loadAppConfig, type LocalContext } from "../src/app.ts";
import { createControl } from "../src/control.ts";
import type { Kv } from "../src/kv.ts";
import { createLocalChannel, loadHome, localEnv } from "../src/local.ts";
import { sqliteKv } from "../src/sqlite-kv.ts";
import { createStoreGuard, ERA_KEY, SENTINEL_KEY, watchStore, type StoreGuard } from "../src/store-guard.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";
import { loadWhatsappConfig, mountWhatsapp, type OwnerAsk, type TelegramDoor } from "../src/whatsapp.ts";

const OWNER = "+34600111222";
const OWNER_WA = "34600111222";
const ENV = {
  WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
};
/** What the connector hears while paused, by why: only the owner's pause is put down to a STOP (src/control.ts). */
const PAUSED = {
  empty: {
    ok: false,
    why: "Pako paused itself for safety (not the owner's STOP): its store came back empty, and a STOP may have been lost with it. "
      + "Nothing is called or sent until the owner writes RESUME.",
  },
  unknown: {
    ok: false,
    why: "Pako is paused for safety (not the owner's STOP): it cannot read its store, where a STOP is kept, right now. "
      + "It goes on by itself once the store answers, or when the owner writes RESUME.",
  },
};
const T0 = Date.parse("2026-11-01T09:00:00Z");
type Body = Record<string, any>;

/** A store in memory that can be down (every request fails), slow, failing for some keys, or emptied by a read of a key. */
function fakeStore(seed: Record<string, string> = {}) {
  const s = {
    m: new Map(Object.entries(seed)),
    down: false,
    slowMs: 0,
    failing: new Set<string>(),
    /** Reading this key empties the store first (a wipe that lands in the middle of a look). */
    wipeOnRead: "",
    /** How long each next write takes, in turn (then none). */
    setDelays: [] as number[],
    /** "get:<key>" or "set:<key>": the next such request waits for that promise (once). */
    hold: new Map<string, Promise<unknown>>(),
    /** Every write refused while reads work (a full store, or one that refuses writes). */
    readOnly: false,
    /** Fails the n-th request of each kind ("get:<key>" or "set:<key>", counted from 1) it says yes to. */
    failIf: null as ((what: string, n: number) => boolean) | null,
    count: new Map<string, number>(),
    writes: [] as string[],
  };
  const held = async (what: string): Promise<void> => {
    const gate = s.hold.get(what);
    if (!gate) return;
    s.hold.delete(what);
    await gate;
  };
  const failed = (what: string): boolean => {
    const n = (s.count.get(what) ?? 0) + 1;
    s.count.set(what, n);
    return !!s.failIf?.(what, n);
  };
  const kv: Kv = {
    get: async (k) => {
      await held(`get:${k}`);
      if (s.slowMs) await sleep(s.slowMs);
      if (s.down || s.failing.has(k) || failed(`get:${k}`)) throw new Error("store down");
      if (k === s.wipeOnRead) {
        s.wipeOnRead = "";
        s.m.clear();
      }
      return s.m.get(k) ?? null;
    },
    set: async (k, v) => {
      await held(`set:${k}`);
      const delay = s.setDelays.shift() ?? s.slowMs;
      if (delay) await sleep(delay);
      if (s.down || s.readOnly || s.failing.has(k) || failed(`set:${k}`)) throw new Error("store down");
      s.m.set(k, v);
      s.writes.push(k);
    },
  };
  return Object.assign(s, { kv });
}
type FakeStore = ReturnType<typeof fakeStore>;

/** A friend call the connector asks for: the card the owner would be shown (askCall refuses to show it while paused). */
function ask(name = "Ana"): OwnerAsk {
  return { name, card: `Claude asks to call ${name}.\n\nShall I call?`, place: async () => ({ ok: true, text: "started" }), closed: () => undefined };
}

let n = 0;
/** The door, the control and the guard as src/app.ts wires them (hosted), with a stand-in for Meta. `store: null` is a server with no store. */
async function rig(o: { store?: FakeStore | null; template?: boolean; telegram?: TelegramDoor } = {}) {
  const sent: Body[] = [];
  const meta = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.body) sent.push(JSON.parse(String(init.body)) as Body);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out${sent.length}` }] }), { status: 200 });
  }) as typeof fetch;
  const clock = { now: Date.parse("2026-11-15T12:00:00Z") };
  const fake = o.store === undefined ? fakeStore() : o.store;
  const store = watchStore(fake ? fake.kv : null);
  const control = createControl(store.kv, () => clock.now);
  const memory = loadMemory(store.kv);
  const tools = loadVoiceTools({ memory, actions: { contacts: () => ["Ana"], callContact: async () => ({ ok: true, text: "started" }), lookupCall: async () => "ok" } });
  const config = loadWhatsappConfig({ ...ENV, ...(o.template ? { WHATSAPP_REMINDER_TEMPLATE: "pako_aviso" } : {}) }, OWNER).config!;
  const app = express();
  const door = mountWhatsapp(app, {
    config, tools, memory, kv: store.kv, ownerName: "Marta", timeZone: "Europe/Madrid", contacts: () => ["Ana"], fetch: meta, now: () => clock.now, control,
    ...(o.telegram ? { telegram: o.telegram } : {}),
  });
  const notices: string[] = [];
  const guard: StoreGuard = createStoreGuard({
    store,
    control,
    notify: (text) => {
      notices.push(text);
      return door.notifyOwner(text, { urgent: true });
    },
    note: door.note,
    parts: { mail: true, telegram: true, calendar: true },
    now: () => clock.now,
    // The tests look when they choose (check()): the timers never fire during one.
    retryMs: 3_600_000,
    everyMs: 3_600_000,
  });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const waText = (body: string) => {
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: config.phoneNumberId }, messages: [{ from: OWNER_WA, id: `wamid.sg${++n}`, timestamp: "1", type: "text", text: { body } }] } }] }],
    });
    return fetch(`${base}/whatsapp/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", config.appSecret).update(raw).digest("hex")}` }, body: raw });
  };
  const context = async () => (await (await fetch(`${base}/assistant/context`, { headers: { authorization: `Bearer ${config.bridgeToken}` } })).json()) as Body;
  return {
    fake, store, control, door, guard, notices, sent, clock, waText, context,
    texts: () => sent.filter((b) => b.type === "text").map((b) => String(b.text.body)),
    templates: () => sent.filter((b) => b.type === "template").map((b) => String(b.template.components[0].parameters[0].text)),
    close: () => {
      guard.stop();
      server.close();
      server.closeAllConnections();
    },
  };
}

/** Every notice fits the notice template whole (600 characters on one line) and WhatsApp's text limit. */
const fits = (text: string): boolean => text.replace(/\s+/g, " ").trim().length <= 600 && text.length <= 4096;

test("an empty store (wiped, or the very first start): everything is paused, and the owner gets exactly one urgent notice that reaches the phone", async () => {
  const fake = fakeStore();
  const r = await rig({ store: fake, template: true });
  try {
    r.guard.start();
    // Asked at once, while the look is in flight: it is waited for, and the answer is the guard's, never "running".
    assert.deepEqual(await r.control.state(), { paused: r.clock.now, why: "store-empty" });
    await r.guard.check();
    assert.equal(r.notices.length, 1);
    const said = r.notices[0]!;
    assert.match(said, /^⚠️ Pako's store came back empty \(it's the first start, or Render wiped it\): your notes, your reminders, the email state, the Telegram connection and calendar access may have been lost\. I started PAUSED to be safe: I won't call or message anyone\. Type RESUME to go on\.\nSo it doesn't happen again: on Render, put the Key Value on a paid plan \(with persistence\), or run Pako on your computer\.$/);
    assert.ok(fits(said), `${said.length} characters`);
    // Nobody has written since the store was emptied (WhatsApp's 24 hours are closed): urgent, so the notice template carries it, whole.
    assert.deepEqual(r.templates(), [said.replace(/\s+/g, " ")]);
    assert.match(fake.m.get(SENTINEL_KEY) ?? "", /^[0-9a-f]{16}$/, "the store is marked");
    assert.equal(fake.m.get("assistant-paused"), String(r.clock.now), "the pause is kept: a restart finds it");
    assert.equal((await r.control.recent(1))[0]?.text, "The store came back empty: everything stopped until RESUME");
    assert.match(fake.m.get("assistant-log") ?? "", /The store came back empty: everything stopped until RESUME/);
    assert.deepEqual(await r.door.askCall(ask()), PAUSED.empty, "no card, so no call");
    assert.equal((await r.context()).paused, true, "the assistant is told");
    await r.guard.check();
    assert.equal(r.notices.length, 1, "looking again says nothing more");
    // A restart now (the store kept its writes): still paused, and why.
    const after = createControl(fake.kv);
    assert.deepEqual(await after.state(), { paused: r.clock.now, why: "store-empty" });
  } finally {
    r.close();
  }
});

test("a store from before the guard (keys of a Pako in use, no sentinel): marked without a word, nothing paused, a STOP kept there stays", async () => {
  const fake = fakeStore({ "owner-memory": JSON.stringify({ notes: [{ at: 1, text: "black coffee" }], calls: [] }), "assistant-log": "[]" });
  const r = await rig({ store: fake, template: true });
  try {
    r.guard.start();
    await r.guard.check();
    assert.deepEqual(await r.control.state(), { paused: null, why: null });
    assert.match(fake.m.get(SENTINEL_KEY) ?? "", /^[0-9a-f]{16}$/);
    assert.deepEqual(r.notices, []);
    assert.deepEqual(r.sent, [], "nothing at all reaches the owner");
  } finally {
    r.close();
  }
  const stopped = fakeStore({ "assistant-paused": String(T0) });
  const s = await rig({ store: stopped });
  try {
    s.guard.start();
    await s.guard.check();
    assert.deepEqual(await s.control.state(), { paused: T0, why: "owner" }, "the owner's STOP from before the guard");
    assert.deepEqual(s.notices, []);
  } finally {
    s.close();
  }
});

test("a store the guard marked: nothing happens (no write, no notice, the pause as it was)", async () => {
  const fake = fakeStore({ [SENTINEL_KEY]: "abcdef0123456789" });
  const r = await rig({ store: fake });
  try {
    r.guard.start();
    await r.guard.check();
    await r.guard.check();
    assert.deepEqual(await r.control.state(), { paused: null, why: null });
    assert.deepEqual(fake.writes, []);
    assert.deepEqual(r.notices, []);
    assert.equal(fake.m.get(SENTINEL_KEY), "abcdef0123456789");
  } finally {
    r.close();
  }
});

test("a store that cannot be read at start: every call and message is held back until it answers, nothing is said; then the real state", async () => {
  const fake = fakeStore({ [SENTINEL_KEY]: "abcdef0123456789", "assistant-paused": String(T0) });
  fake.down = true;
  const r = await rig({ store: fake });
  try {
    r.guard.start();
    await r.guard.check();
    const unknown = await r.control.state();
    assert.equal(unknown.why, "store-unknown");
    assert.notEqual(unknown.paused, null, "counted as paused, never as running");
    assert.deepEqual(await r.door.askCall(ask()), PAUSED.unknown);
    assert.equal((await r.context()).paused, true);
    assert.deepEqual(r.notices, [], "nothing decided, nothing said");
    fake.down = false;
    await r.guard.check();
    assert.deepEqual(await r.control.state(), { paused: T0, why: "owner" }, "the STOP kept in the store, read once it answers");
    assert.deepEqual(r.notices, []);
  } finally {
    r.close();
  }
  // The same, with nothing paused there: once the store answers, calls go out again.
  const fine = fakeStore({ [SENTINEL_KEY]: "abcdef0123456789" });
  fine.down = true;
  const s = await rig({ store: fine });
  try {
    s.guard.start();
    await s.guard.check();
    assert.deepEqual(await s.door.askCall(ask()), PAUSED.unknown);
    fine.down = false;
    await s.guard.check();
    await s.waText("hi"); // WhatsApp's 24 hours open
    assert.deepEqual(await s.door.askCall(ask()), { ok: true, where: "on WhatsApp" });
  } finally {
    s.close();
  }
});

test("the owner's RESUME while the store cannot be read wins at once, and is written once the store answers", async () => {
  const fake = fakeStore({ [SENTINEL_KEY]: "abcdef0123456789", "assistant-paused": String(T0) });
  fake.down = true;
  const r = await rig({ store: fake });
  try {
    r.guard.start();
    await r.guard.check();
    await r.waText("RESUME");
    assert.equal(r.texts().at(-1), "▶️ Running again.\n(I couldn't save it: if the server restarts, I may be paused again; type it again then.)");
    assert.deepEqual(await r.control.state(), { paused: null, why: null });
    assert.deepEqual(await r.door.askCall(ask()), { ok: true, where: "on WhatsApp" });
    fake.down = false;
    await r.guard.check();
    assert.deepEqual(await r.control.state(), { paused: null, why: null }, "the owner's word, not the old STOP");
    assert.equal(fake.m.get("assistant-paused"), "0", "and the store has it now");
  } finally {
    r.close();
  }
});

test("a store that comes back empty after being unreadable: what this process wrote meanwhile is not taken for an older Pako; a RESUME typed meanwhile stands", async () => {
  const fake = fakeStore();
  fake.down = true;
  const r = await rig({ store: fake });
  try {
    r.guard.start();
    await r.guard.check();
    fake.down = false; // back, and empty (Render restarted it)
    r.control.log("note", "a line"); // this process writes the log, the inbox and the owner's last message before the guard looks again
    await r.waText("hi");
    await r.control.recent(1);
    assert.ok(fake.m.has("assistant-log") && fake.m.has("assistant-inbox") && fake.m.has("assistant-last-owner-at"));
    await r.guard.check();
    assert.deepEqual(await r.control.state(), { paused: r.clock.now, why: "store-empty" }, "an emptied store, not one from before the guard");
    assert.equal(r.notices.length, 1);
    assert.equal(r.texts().at(-1), r.notices[0], "inside WhatsApp's 24 hours: sent as it is");
  } finally {
    r.close();
  }
  const chose = fakeStore();
  chose.down = true;
  const s = await rig({ store: chose });
  try {
    s.guard.start();
    await s.guard.check();
    await s.waText("RESUME");
    chose.down = false;
    await s.guard.check();
    assert.deepEqual(await s.control.state(), { paused: null, why: null }, "the owner chose after this start: not paused over it");
    assert.equal(s.notices.length, 1);
    assert.match(s.notices[0]!, /came back empty .* may have been lost\. Still running, as you asked\.\nSo it doesn't happen again/s);
    assert.ok(chose.m.get(SENTINEL_KEY), "marked");
  } finally {
    s.close();
  }
});

test("a wipe under a running Pako: the sentinel and the owner's STOP are written back from memory, the owner is told once, nothing is newly paused", async () => {
  const fake = fakeStore({ [SENTINEL_KEY]: "abcdef0123456789" });
  const r = await rig({ store: fake });
  try {
    r.guard.start();
    await r.guard.check();
    await r.waText("STOP");
    const at = (await r.control.state()).paused;
    assert.notEqual(at, null);
    fake.m.clear(); // Render restarted the Key Value under this process
    await r.guard.check();
    assert.equal(fake.m.get(SENTINEL_KEY), "abcdef0123456789", "the same mark, back");
    assert.equal(fake.m.get("assistant-paused"), String(at), "the STOP survives a restart now");
    assert.deepEqual(await r.control.state(), { paused: at, why: "owner" }, "the owner's STOP, not a new pause");
    assert.equal(r.notices.length, 1);
    assert.match(r.notices[0]!, /^⚠️ Pako's store was emptied while it was running\. Your STOP still holds, but your notes, .* may have been lost\.\nSo it doesn't happen again/s);
    assert.ok(fits(r.notices[0]!));
    assert.equal(r.texts().at(-1), r.notices[0], "the owner wrote a moment ago: sent as it is");
    await r.guard.check();
    assert.equal(r.notices.length, 1, "told once");
    assert.equal((await createControl(fake.kv).state()).paused, at, "a restart after the wipe is still paused");
  } finally {
    r.close();
  }
  const running = fakeStore({ [SENTINEL_KEY]: "abcdef0123456789" });
  const s = await rig({ store: running });
  try {
    s.guard.start();
    await s.guard.check();
    running.m.clear();
    await s.guard.check();
    assert.deepEqual(await s.control.state(), { paused: null, why: null }, "running, as it knew");
    assert.match(s.notices[0]!, /^⚠️ Pako's store was emptied while it was running\. Your notes, /);
  } finally {
    s.close();
  }
  // Another copy (a deploy) marked the store with its own id after its own look: nothing to say.
  const other = fakeStore({ [SENTINEL_KEY]: "abcdef0123456789" });
  const u = await rig({ store: other });
  try {
    u.guard.start();
    await u.guard.check();
    other.m.set(SENTINEL_KEY, "0123456789abcdef");
    await u.guard.check();
    assert.deepEqual(u.notices, []);
  } finally {
    u.close();
  }
});

test("a wipe while the pause was never read here (the read failed), or one in the middle of the read: paused for safety, as at a start", async () => {
  const fake = fakeStore({ [SENTINEL_KEY]: "abcdef0123456789" });
  fake.failing.add("assistant-paused");
  const r = await rig({ store: fake });
  try {
    r.guard.start();
    await r.guard.check();
    assert.equal((await r.control.state()).why, "store-unknown", "the store answered the guard, but not for the pause");
    fake.failing.clear();
    fake.m.clear();
    // A request between the wipe and the next look (the panel, the assistant's context, a call): it does not read the emptied store's
    // «running» for itself; only the guard reads the pause, after the sentinel.
    assert.equal((await r.control.state()).why, "store-unknown");
    await r.guard.check();
    assert.deepEqual(await r.control.state(), { paused: r.clock.now, why: "store-empty" }, "the emptied store's «running» is not believed");
    assert.match(r.notices[0]!, /^⚠️ Pako's store was emptied while it was running, and I don't know whether it was paused: .* I've PAUSED to be safe/s);
  } finally {
    r.close();
  }
  // The same with the owner's STOP in the store: the request in between is refused, and the look leaves a pause in the store, not "running".
  const stopped = fakeStore({ [SENTINEL_KEY]: "abcdef0123456789", "assistant-paused": String(T0) });
  stopped.failing.add("assistant-paused");
  const t = await rig({ store: stopped });
  try {
    t.guard.start();
    await t.guard.check();
    stopped.failing.clear();
    stopped.m.clear();
    assert.deepEqual(await t.door.askCall(ask()), PAUSED.unknown);
    await t.guard.check();
    assert.deepEqual(await t.control.state(), { paused: t.clock.now, why: "store-empty" });
    assert.equal(stopped.m.get("assistant-paused"), String(t.clock.now), "a restart finds it paused");
    assert.equal(t.notices.length, 1);
  } finally {
    t.close();
  }
  // Emptied between the sentinel and the pause: the pause read then is dropped.
  const mid = fakeStore({ [SENTINEL_KEY]: "abcdef0123456789", "assistant-paused": String(T0) });
  mid.wipeOnRead = "assistant-paused";
  const s = await rig({ store: mid });
  try {
    s.guard.start();
    await s.guard.check();
    assert.deepEqual(await s.control.state(), { paused: s.clock.now, why: "store-empty" });
    assert.equal(mid.m.get(SENTINEL_KEY), "abcdef0123456789");
    assert.equal(s.notices.length, 1);
  } finally {
    s.close();
  }
});

const USED = { "owner-memory": JSON.stringify({ notes: [{ at: 1, text: "black coffee" }], calls: [] }), "assistant-log": "[]" };

test("two copies on one store: a copy that starts after a wipe the running copy already wrote over pauses and says so once (with the old copy looking again, or gone)", async () => {
  for (const overlap of [true, false]) {
    const fake = fakeStore({ [SENTINEL_KEY]: "abcdef0123456789", "assistant-paused": String(T0) });
    const a = await rig({ store: fake });
    let aOpen = true;
    let b: Awaited<ReturnType<typeof rig>> | null = null;
    try {
      a.guard.start();
      await a.guard.check();
      assert.deepEqual(await a.control.state(), { paused: T0, why: "owner" }, "the owner's STOP, read");
      fake.m.clear(); // Render restarted the Key Value under the running copy
      // Before its next look the running copy writes again, as it always does (a mail summary, a reminder, the owner's message).
      a.control.log("note", "a line");
      await a.control.recent(1);
      await a.waText("hi");
      assert.ok(fake.m.has("assistant-log") && fake.m.has("assistant-inbox"));
      assert.equal(fake.m.get(ERA_KEY), "abcdef0123456789", "each such write goes after the era");
      if (!overlap) {
        // A deploy with no overlap, a crash, a free web service gone to sleep: the old copy never looks again.
        a.close();
        aOpen = false;
      }
      b = await rig({ store: fake });
      b.guard.start();
      await b.guard.check();
      assert.deepEqual(await b.control.state(), { paused: b.clock.now, why: "store-empty" }, `not taken for a store from before the guard (overlap: ${overlap})`);
      assert.equal(fake.m.get("assistant-paused"), String(b.clock.now), "and the pause is in the store: a restart finds it");
      if (overlap) await a.guard.check(); // the old copy's next look, before Render stops it
      assert.equal(a.notices.length + b.notices.length, 1, "told once");
      assert.match(b.notices[0]!, /^⚠️ Pako's store came back empty .* I started PAUSED to be safe/s);
    } finally {
      if (aOpen) a.close();
      b?.close();
    }
  }
  // A store from before the guard, with the old copy (before the guard) still writing to it during the deploy: marked without a word, as before.
  const old = fakeStore(USED);
  const r = await rig({ store: old });
  try {
    r.guard.start();
    old.m.set("assistant-inbox", JSON.stringify({ msgs: [], seen: ["wamid.x"] }));
    await r.guard.check();
    assert.deepEqual(await r.control.state(), { paused: null, why: null });
    assert.deepEqual(r.notices, []);
    assert.equal(old.m.get(ERA_KEY), undefined, "nothing written yet");
    r.control.log("note", "a line");
    await r.control.recent(1);
    assert.equal(old.m.get(ERA_KEY), old.m.get(SENTINEL_KEY), "this copy's own writes carry the era from now on");
  } finally {
    r.close();
  }
});

test("a sentinel the store did not take is no wipe: written again on a later look, without a word; and one notice for each emptying, however many looks the write-back fails", async () => {
  // The owner's first deploy of the guard: its one write of the sentinel fails (a timeout, a connection reset).
  const used = fakeStore(USED);
  used.failIf = (what, n) => what === `set:${SENTINEL_KEY}` && n === 1;
  const r = await rig({ store: used });
  try {
    r.guard.start();
    await r.guard.check(); // the look at start (its write fails), then the next look
    assert.equal(used.count.get(`set:${SENTINEL_KEY}`), 2, "the first write failed; the next look wrote it again");
    assert.match(used.m.get(SENTINEL_KEY) ?? "", /^[0-9a-f]{16}$/);
    await r.guard.check();
    assert.deepEqual(r.notices, [], "nothing was lost, nothing is said");
    assert.deepEqual(await r.control.state(), { paused: null, why: null });
  } finally {
    r.close();
  }
  // A store in use that takes no write at all while reads work (full, or refusing writes): nothing said, look after look.
  const refusing = fakeStore(USED);
  refusing.readOnly = true;
  const s = await rig({ store: refusing });
  try {
    s.guard.start();
    for (let i = 0; i < 4; i++) await s.guard.check();
    assert.deepEqual(s.notices, []);
    assert.deepEqual(await s.control.state(), { paused: null, why: null });
  } finally {
    s.close();
  }
  // An empty store that takes no write: paused and told once, not again at every look; the pause and the sentinel go in once it takes them.
  const empty = fakeStore();
  empty.readOnly = true;
  const e = await rig({ store: empty });
  try {
    e.guard.start();
    for (let i = 0; i < 4; i++) await e.guard.check();
    assert.equal(e.notices.length, 1);
    assert.equal((await e.control.state()).why, "store-empty");
    empty.readOnly = false;
    await e.guard.check();
    assert.match(empty.m.get(SENTINEL_KEY) ?? "", /^[0-9a-f]{16}$/);
    assert.equal(empty.m.get("assistant-paused"), String(e.clock.now));
    await e.guard.check();
    assert.equal(e.notices.length, 1);
  } finally {
    e.close();
  }
  // The first write fails as the Key Value restarts and comes back empty, and the read of the pause failed too: paused, and told once.
  const lost = fakeStore({ ...USED, "assistant-paused": String(T0) });
  lost.failIf = (what, n) => (what === `set:${SENTINEL_KEY}` && n === 1) || (what === "get:assistant-paused" && n === 2);
  const f = await rig({ store: lost });
  try {
    f.guard.start();
    assert.equal((await f.control.state()).why, "store-unknown", "waits for the look at start, which could not read the pause");
    lost.m.clear();
    await f.guard.check();
    assert.deepEqual(await f.control.state(), { paused: f.clock.now, why: "store-empty" });
    assert.equal(f.notices.length, 1);
    assert.match(f.notices[0]!, /I don't know whether it was paused/);
  } finally {
    f.close();
  }
  // Two emptyings under a running Pako, the first one's write-back refused for a few looks: one notice for each.
  const twice = fakeStore({ [SENTINEL_KEY]: "abcdef0123456789" });
  const w = await rig({ store: twice });
  try {
    w.guard.start();
    await w.guard.check();
    twice.m.clear();
    twice.readOnly = true;
    for (let i = 0; i < 3; i++) await w.guard.check();
    assert.equal(w.notices.length, 1, "one notice, though the sentinel could not be put back");
    twice.readOnly = false;
    await w.guard.check();
    assert.equal(twice.m.get(SENTINEL_KEY), "abcdef0123456789", "put back once the store takes it");
    await w.guard.check();
    assert.equal(w.notices.length, 1);
    twice.m.clear();
    await w.guard.check();
    assert.equal(w.notices.length, 2, "the next emptying is told again");
  } finally {
    w.close();
  }
});

test("a pause Pako set by itself is never put down to the owner: the assistant's context says why, and a line tells an assistant that has not been updated", async () => {
  const r = await rig();
  try {
    r.guard.start();
    await r.guard.check();
    const ctx = await r.context();
    assert.deepEqual([ctx.paused, ctx.pauseWhy], [true, "store-empty"], "an older bridge reads only `paused`, as before");
    assert.match((ctx.events as string[]).join("\n"), /Pako paused itself to be safe \(its store came back empty, and a STOP may have been lost\): it was not the owner's STOP\./);
    await r.waText("STOP");
    const owner = await r.context();
    assert.deepEqual([owner.paused, owner.pauseWhy], [true, "owner"]);
  } finally {
    r.close();
  }
});

test("a server with no store at all (VOICE_RESULTS_URL unset): every start is an empty store, paused, and the notice waits for the owner's message", async () => {
  const r = await rig({ store: null });
  try {
    r.guard.start();
    await r.guard.check();
    assert.deepEqual(await r.control.state(), { paused: r.clock.now, why: "store-empty" });
    assert.equal(r.notices.length, 1);
    assert.match(r.notices[0]!, /^⚠️ Pako has no store \(VOICE_RESULTS_URL is missing\): every restart forgets everything, a STOP too\. I started PAUSED/);
    assert.ok(fits(r.notices[0]!));
    assert.deepEqual(r.sent, [], "WhatsApp's 24 hours are closed and there is no template: kept for the owner's next message");
    await r.waText("hi");
    assert.equal(r.texts()[0], `While we weren't talking, this came in:\n\n${r.notices[0]}`);
    assert.deepEqual(await r.door.askCall(ask()), PAUSED.empty);
  } finally {
    r.close();
  }
});

test("RESUME after the pause for an empty store says Pako runs again and how to bring back what was lost; STOP and RESUME work as before after it", async () => {
  const telegram: TelegramDoor = {
    paired: async () => false, reachable: async () => false, deliver: async () => false, pairLink: async () => null, unpair: async () => true,
    farewell: async () => undefined, media: async () => null,
  };
  const r = await rig({ telegram });
  try {
    r.guard.start();
    await r.guard.check();
    await r.waText("Resume");
    assert.equal(
      r.texts().at(-1),
      "▶️ Running again.\nIf any notes or reminders were lost, give them to me again. If you used Telegram, type TELEGRAM to connect it again.",
    );
    assert.deepEqual(await r.control.state(), { paused: null, why: null });
    assert.deepEqual(await r.door.askCall(ask()), { ok: true, where: "on WhatsApp" });
    await r.waText("STOP");
    await r.waText("RESUME");
    assert.equal(r.texts().at(-1), "▶️ Running again.", "after the owner's own STOP, the usual answer");
    await r.waText("RESUME");
    assert.equal(r.texts().at(-1), "I wasn't stopped: everything is working.");
    assert.equal(r.notices.length, 1);
  } finally {
    r.close();
  }
});

test("the pause fails closed without the guard too: a store that never answered here counts as paused (said once); the owner's word wins; the reason survives a restart", async () => {
  const fake = fakeStore({ "assistant-paused": String(T0) });
  fake.down = true;
  const errors: string[] = [];
  const said = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    const c = createControl(fake.kv, () => 42);
    assert.deepEqual(await c.state(), { paused: 42, why: "store-unknown" }, "since this process started");
    assert.equal(await c.paused(), 42);
    await c.paused();
    assert.equal(errors.filter((l) => l.includes("[control] the pause cannot be known")).length, 1, "said once");
    fake.down = false;
    assert.deepEqual(await c.state(), { paused: T0, why: "owner" }, "once it answers, the real value");
    fake.down = true;
    assert.deepEqual(await c.state(), { paused: T0, why: "owner" }, "then kept in memory, as before");
    assert.equal(await c.setPaused(false, 50), false, "the owner's RESUME: not kept by the store…");
    assert.equal(await c.paused(), null, "…but it wins here");
    const d = createControl(fakeStore().kv);
    await d.setPaused(true, 77);
    assert.equal(await d.paused(), 77);
  } finally {
    console.error = said;
  }
  const kept = fakeStore();
  await createControl(kept.kv).setPaused(true, T0, "store-empty");
  assert.deepEqual(await createControl(kept.kv).state(), { paused: T0, why: "store-empty" });
  await createControl(kept.kv).setPaused(true, T0 + 5);
  assert.deepEqual(await createControl(kept.kv).state(), { paused: T0 + 5, why: "owner" }, "an older reason belongs to an older pause");
  // A STOP and a quick RESUME land in the store in the order they were given, even when the first write is the slow one.
  const order = fakeStore();
  order.setDelays = [40, 1];
  const c = createControl(order.kv);
  const a = c.setPaused(true, T0);
  const b = c.setPaused(false, T0 + 1);
  await Promise.all([a, b]);
  assert.equal(order.m.get("assistant-paused"), "0");
});

test("a RESUME that comes while the start's look is still out wins, and the notice that follows says so instead of asking for RESUME", async () => {
  const fake = fakeStore();
  let openLook = (): void => undefined;
  let openMark = (): void => undefined;
  fake.hold.set(`get:${SENTINEL_KEY}`, new Promise<void>((r) => (openLook = r)));
  fake.hold.set(`set:${SENTINEL_KEY}`, new Promise<void>((r) => (openMark = r)));
  const r = await rig({ store: fake });
  try {
    r.guard.start();
    const resumed = r.waText("RESUME");
    openLook();
    await resumed;
    assert.equal(r.texts().at(-1), "▶️ Running again.\nIf any notes or reminders were lost, give them to me again.");
    openMark();
    await r.guard.check();
    assert.deepEqual(await r.control.state(), { paused: null, why: null });
    assert.equal(r.notices.length, 1);
    assert.match(r.notices[0]!, /came back empty .* may have been lost\. Still running, as you asked\.\n/s);
  } finally {
    r.close();
  }
});

test("a read of the pause still out when the guard starts is not trusted: its caller hears «paused», and the guard reads afresh", async () => {
  const fake = fakeStore({ [SENTINEL_KEY]: "abcdef0123456789" });
  let openRead = (): void => undefined;
  let openLook = (): void => undefined;
  fake.hold.set("get:assistant-paused", new Promise<void>((r) => (openRead = r)));
  fake.hold.set(`get:${SENTINEL_KEY}`, new Promise<void>((r) => (openLook = r)));
  const r = await rig({ store: fake });
  try {
    const early = r.control.state(); // asked before the guard started (in server.ts nothing can, a test can)
    r.guard.start();
    openRead();
    assert.deepEqual(await early, { paused: r.clock.now, why: "store-unknown" }, "never «running» from an answer nobody trusts any more");
    openLook();
    await r.guard.check();
    assert.deepEqual(await r.control.state(), { paused: null, why: null }, "the guard's own read, once it vouched for the store");
  } finally {
    r.close();
  }
});

test("a slow store at start: the pause is waited for, not reported as on, and the answer is the store's", async () => {
  const fake = fakeStore({ [SENTINEL_KEY]: "abcdef0123456789" });
  fake.slowMs = 30;
  const r = await rig({ store: fake });
  try {
    r.guard.start();
    assert.deepEqual(await r.control.state(), { paused: null, why: null });
    assert.deepEqual(r.notices, []);
  } finally {
    r.close();
  }
});

// ---------- at home (src/local.ts): the file store says itself whether it lost its file ----------

const tmp = () => mkdtempSync(join(tmpdir(), "pako-guard-"));

async function localRig(home: ReturnType<typeof loadHome>) {
  const env: Record<string, string | undefined> = { ...localEnv({}, home, 0), PAKO_HOME: home.dir };
  const kv = sqliteKv(home.dir);
  const local: LocalContext = {
    kv, channel: createLocalChannel({ kv }), bridgeToken: home.bridgeToken, panelSecret: home.panelSecret,
    bridge: { status: () => ({ claude: "ok", running: true }) }, storeStart: { firstRun: home.firstRun === true, lost: kv.lost },
  };
  const app = createApp(loadAppConfig(env), env, local);
  const guard = app.locals.storeGuard as StoreGuard;
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const link = (app.locals.panelLink as () => string)().replace(/^http:\/\/127\.0\.0\.1:\d+/, base);
  const cookie = ((await fetch(link, { redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0]!;
  const api = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", cookie, "x-pako": "1" } });
  const chat = async () => ((await (await api("/panel/api/chat?since=0")).json()) as { messages: { who: string; text: string }[] }).messages;
  const overview = async () => (await (await api("/panel/api/overview")).json()) as { paused: number | null; pauseWhy: string | null; log: { kind: string; text: string }[] };
  return { kv, guard, api, chat, overview, close: () => (guard.stop(), server.close(), server.closeAllConnections()) };
}

test("at home, a person's first run is never paused (no secrets.json yet), even with signs of a lost kv.json in the folder", async () => {
  const home = loadHome({ PAKO_HOME: join(tmp(), "home"), PAKO_NAME: "Ana" });
  assert.equal(home.firstRun, true);
  const r = await localRig(home);
  try {
    assert.equal(r.kv.lost, null);
    r.guard.start();
    await r.guard.check();
    assert.deepEqual([(await r.overview()).paused, (await r.overview()).pauseWhy], [null, null]);
    assert.ok(!(await r.chat()).some((m) => m.text.startsWith("⚠️")), "nothing alarming in the chat");
  } finally {
    r.close();
  }
  // A folder with a note of an earlier kv.json but no secrets.json (the person started afresh): still a first run.
  const dir = join(tmp(), "home");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "kv.json.made"), "x");
  const fresh = loadHome({ PAKO_HOME: dir, PAKO_NAME: "Ana" });
  const s = await localRig(fresh);
  try {
    assert.deepEqual([fresh.firstRun, s.kv.lost], [true, "missing"]);
    s.guard.start();
    await s.guard.check();
    assert.equal((await s.overview()).paused, null);
  } finally {
    s.close();
  }
});

test("at home, kv.db gone on a later run: paused, the notice is in the chat, the panel says why; RESUME in the chat clears it", async () => {
  const dir = join(tmp(), "home");
  loadHome({ PAKO_HOME: dir, PAKO_NAME: "Ana" });
  const home = loadHome({ PAKO_HOME: dir, PAKO_NAME: "Ana" });
  assert.equal(home.firstRun, false);
  // A store was made here on an earlier run (a note beside it says so), and is gone now.
  writeFileSync(join(dir, "kv.db.made"), "x");
  const r = await localRig(home);
  try {
    assert.equal(r.kv.lost, "missing");
    r.guard.start();
    await r.guard.check();
    const o = await r.overview();
    assert.equal(o.pauseWhy, "store-empty");
    assert.notEqual(o.paused, null);
    assert.match(o.log[0]!.text, /Store \(kv\.db\) lost or damaged: everything stopped until RESUME/);
    const notice = (await r.chat()).find((m) => m.who === "pako" && m.text.startsWith("⚠️"));
    assert.match(notice?.text ?? "", /^⚠️ I can't find the file where I keep your things \(kv\.db, in your Pako folder\): your notes, your reminders and the earlier chat may have been lost\. I started PAUSED to be safe/);
    assert.equal((await r.api("/panel/api/chat", { method: "POST", body: JSON.stringify({ text: "RESUME" }) })).status, 202);
    let last = "";
    // Returns as soon as the answer shows; the long limit is for a machine running the whole suite at once.
    for (let i = 0; i < 300 && !last.startsWith("▶️"); i++) {
      await sleep(10);
      last = (await r.chat()).at(-1)?.text ?? "";
    }
    assert.equal(last, "▶️ Running again.\nIf any notes or reminders were lost, give them to me again.");
    assert.deepEqual([(await r.overview()).paused, (await r.overview()).pauseWhy], [null, null]);
  } finally {
    r.close();
  }
});

test("at home: a start that ended before any store was made is not a loss; a damaged one is; a store read now is remembered", async () => {
  const dir = tmp();
  assert.equal(sqliteKv(dir).lost, null, "never made here: nothing lost (a first start that stopped at a wrong setting, say)");
  assert.ok(!existsSync(join(dir, "kv.db.made")), "an empty store opened once is not yet a store that existed");
  const kv = sqliteKv(dir);
  await kv.set("a", "x", 0);
  assert.ok(existsSync(join(dir, "kv.db.made")), "a store written to is remembered");
  assert.equal(sqliteKv(dir).lost, null);
  writeFileSync(join(dir, "kv.db"), "not a database ".repeat(100));
  assert.equal(sqliteKv(dir).lost, "damaged");
  const other = tmp();
  writeFileSync(join(other, "kv.db"), "not a database ".repeat(100));
  assert.equal(sqliteKv(other).lost, "damaged", "damaged is a loss even with no note beside it");
});

// ---------- the whole app on a server ----------

/** The smallest stand-in for the Redis protocol: GET and SET from a map. */
async function fakeRedis(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  const server = createTcpServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      for (;;) {
        const head = /^\*(\d+)\r\n/.exec(buf.toString("latin1"));
        if (!head) return;
        let pos = head[0].length;
        const args: string[] = [];
        for (let i = 0; i < Number(head[1]); i++) {
          const h = /^\$(\d+)\r\n/.exec(buf.subarray(pos).toString("latin1"));
          if (!h) return;
          const start = pos + h[0].length;
          if (buf.length < start + Number(h[1]) + 2) return;
          args.push(buf.subarray(start, start + Number(h[1])).toString());
          pos = start + Number(h[1]) + 2;
        }
        buf = buf.subarray(pos);
        if (args[0] === "SET") {
          data.set(args[1]!, args[2]!);
          sock.write("+OK\r\n");
        } else {
          const v = data.get(args[1]!);
          sock.write(v === undefined ? "$-1\r\n" : `$${Buffer.byteLength(v)}\r\n${v}\r\n`);
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `redis://127.0.0.1:${(server.address() as AddressInfo).port}`, data, close: () => server.close() };
}

test("the app on a server: the owner's first deploy of the guard on a store in use says nothing; with no store it starts paused and the panel says why", async () => {
  const redis = await fakeRedis({ "assistant-log": JSON.stringify([{ at: 1, kind: "nota", text: "Nota guardada: café" }]) });
  const env = { ...ENV, RENDER: "true", PERSONAL_OWNER_NAME: "Marta", PERSONAL_OWNER_NUMBER: OWNER, PERSONAL_CALLER_TOKEN: "t".repeat(32) };
  const used = createApp(loadAppConfig({ ...env, VOICE_RESULTS_URL: redis.url }), { ...env, VOICE_RESULTS_URL: redis.url });
  const usedGuard = used.locals.storeGuard as StoreGuard;
  try {
    usedGuard.start();
    await usedGuard.check();
    assert.match(redis.data.get(SENTINEL_KEY) ?? "", /^[0-9a-f]{16}$/, "marked");
    assert.equal(redis.data.get("assistant-paused"), undefined, "nothing paused");
  } finally {
    usedGuard.stop();
    redis.close();
  }
  // A known public address (PUBLIC_URL): a hosted server without one gives no sign-in link at all (test/public-url.test.ts).
  const withUrl = { ...env, PUBLIC_URL: "https://pako.example.com" };
  const bare = createApp(loadAppConfig(withUrl), withUrl);
  const guard = bare.locals.storeGuard as StoreGuard;
  const server = createServer(bare);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    guard.start();
    await guard.check();
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const link = new URL((bare.locals.panelLink as () => string)()).pathname;
    const cookie = ((await fetch(`${base}${link}`, { redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0]!;
    const o = (await (await fetch(`${base}/panel/api/overview`, { headers: { cookie } })).json()) as { paused: number | null; pauseWhy: string | null; log: { text: string }[] };
    assert.notEqual(o.paused, null);
    assert.equal(o.pauseWhy, "store-empty");
    assert.ok(o.log.some((l) => l.text === "No store (VOICE_RESULTS_URL): everything stopped until RESUME"), JSON.stringify(o.log));
  } finally {
    guard.stop();
    server.close();
    server.closeAllConnections();
  }
});
