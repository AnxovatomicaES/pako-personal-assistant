// Durable jobs (src/jobs.ts) with a fake clock: a laptop that sleeps 23:00-09:30 gives the 08:00 brief at 09:30 with a note, one asleep
// until 12:00 skips it and the next BRIEF says so; a reminder due during the sleep fires late with a note (or, past 12 hours, is told as
// missed); a crash between claim and done never sends twice; routines skipped while asleep are told once; the proactive check never runs
// late; daylight-saving nights; a hosted server behaves as before.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { createBrief, lateUntil, localMinute } from "../src/brief.ts";
import { createBriefV2 } from "../src/brief-v2.ts";
import { createControl } from "../src/control.ts";
import { createJobs, JOBS_KEY, lateTick, readRows, type Jobs } from "../src/jobs.ts";
import type { Kv } from "../src/kv.ts";
import { createRoutines } from "../src/routines.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";
import { loadWhatsappConfig, localStamp, mountWhatsapp } from "../src/whatsapp.ts";

const TZ = "Europe/Madrid";
const MIN = 60_000;
const HOUR = 3600_000;
type Body = Record<string, any>;

/** A local time in Madrid as a moment (winter UTC+1, summer UTC+2: found by trying both). */
const at = (local: string): number => {
  const t = Date.parse(`${local.replace(" ", "T")}:00Z`);
  for (const h of [1, 2]) if (localStamp(t - h * HOUR, TZ) === local) return t - h * HOUR;
  throw new Error(`no such time ${local}`);
};

function memKv(o: { failSet?: (key: string) => boolean } = {}): Kv & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    m,
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => {
      if (o.failSet?.(k)) throw new Error("store down");
      m.set(k, v);
    },
  };
}

/** The runner's clock: ticks every 30 s from `from` to `to` (the laptop awake). */
async function awake(jobs: Jobs, clock: { now: number }, from: number, to: number): Promise<void> {
  for (clock.now = from; clock.now <= to; clock.now += 30_000) await jobs.tick();
  clock.now = to;
}

function briefRig(o: { sleeps: boolean; kv?: Kv; start: number; at?: number; lang?: "en" }) {
  const clock = { now: o.start };
  const kv = o.kv ?? memKv();
  const sent: string[] = [];
  const brief = createBrief({
    at: o.at ?? 8 * 60, kv, timeZone: TZ, now: () => clock.now, lang: () => "en", notify: async (t) => void sent.push(t),
  });
  const jobs = createJobs({ kv, now: () => clock.now, sleeps: o.sleeps });
  brief.start(jobs);
  return { clock, kv, sent, brief, jobs };
}

// ---------- the brief ----------

test("brief: a laptop asleep 23:00-09:30 gives the 08:00 brief at 09:30 with a line that says why, once", async () => {
  const r = briefRig({ sleeps: true, start: at("2026-11-16 22:00") });
  await awake(r.jobs, r.clock, at("2026-11-16 22:00"), at("2026-11-16 23:00"));
  assert.equal(r.sent.length, 0);
  // The lid closes at 23:00 and opens at 09:30: the first tick after is more than two minutes later.
  r.clock.now = at("2026-11-17 09:30");
  await r.jobs.tick();
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0]!, /^⏰ Late: your computer was asleep at 08:00\.\n\n☀️ Good morning\. Today is Tuesday 17 November\./);
  await awake(r.jobs, r.clock, at("2026-11-17 09:30"), at("2026-11-17 10:30"));
  assert.equal(r.sent.length, 1, "never twice");
  const row = (await r.jobs.rows()).find((x) => x.slot === "brief:2026-11-17");
  assert.equal(row?.state, "done");
  assert.equal(row?.attempts, 1);
});

test("brief: awake at 08:00 on a laptop it comes at 08:00 with no note", async () => {
  const r = briefRig({ sleeps: true, start: at("2026-11-17 07:58"), lang: "en" });
  await awake(r.jobs, r.clock, at("2026-11-17 07:58"), at("2026-11-17 08:01"));
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0]!, /^☀️ Good morning\. Today is Tuesday 17 November\./);
});

test("brief: asleep until 12:00 the day's brief is skipped, and the next BRIEF says so once", async () => {
  const r = briefRig({ sleeps: true, start: at("2026-11-16 22:00") });
  await awake(r.jobs, r.clock, at("2026-11-16 22:00"), at("2026-11-16 23:00"));
  r.clock.now = at("2026-11-17 12:00");
  await r.jobs.tick();
  assert.equal(r.sent.length, 0, "no morning brief at noon");
  assert.equal((await r.jobs.rows()).find((x) => x.slot === "brief:2026-11-17")?.state, "missed");
  // A restart in between keeps the skipped day (it is in the store).
  const again = createBrief({ at: 8 * 60, kv: r.kv, timeZone: TZ, now: () => r.clock.now, notify: async () => undefined });
  r.clock.now = at("2026-11-17 15:00");
  const first = await again.now();
  assert.match(first, /^\(The 08:00 brief of today didn't go out: your computer was asleep until after 11:00\.\)\n\n👋 Good afternoon/);
  assert.doesNotMatch(await again.now(), /didn't go out/, "said once");
  // Just before 11:00 it still comes, late.
  const s = briefRig({ sleeps: true, start: at("2026-11-16 22:00") });
  await awake(s.jobs, s.clock, at("2026-11-16 22:00"), at("2026-11-16 23:00"));
  s.clock.now = at("2026-11-17 10:59");
  await s.jobs.tick();
  assert.equal(s.sent.length, 1);
});

test("brief: a hosted server (always on) is as before: asleep at 08:00 it catches up until noon, silently", async () => {
  const r = briefRig({ sleeps: false, start: at("2026-11-16 22:00") });
  await awake(r.jobs, r.clock, at("2026-11-16 22:00"), at("2026-11-16 23:00"));
  r.clock.now = at("2026-11-17 11:30");
  await r.jobs.tick();
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0]!, /^☀️ Good morning/);
  const late = briefRig({ sleeps: false, start: at("2026-11-17 12:00") });
  await late.jobs.tick();
  assert.equal(late.sent.length, 0);
  assert.doesNotMatch(await late.brief.now(), /didn't go out/, "a server never says its computer slept");
  assert.equal(lateUntil(8 * 60), 11 * 60);
  assert.equal(lateUntil(13 * 60), 16 * 60);
});

test("brief on daylight-saving nights: one brief a day at 08:00 local, late with its note after the spring and the autumn change", async () => {
  for (const [eve, day, iso] of [["2026-03-28", "2026-03-29", "2026-03-29T06:00:00Z"], ["2026-10-24", "2026-10-25", "2026-10-25T07:00:00Z"]] as const) {
    assert.equal(localMinute(day, 8 * 60, TZ), Date.parse(iso), `${day}: 08:00 is ${iso}`);
    const r = briefRig({ sleeps: true, start: at(`${eve} 22:30`) });
    await awake(r.jobs, r.clock, at(`${eve} 22:30`), at(`${eve} 23:00`));
    r.clock.now = at(`${day} 09:30`);
    await r.jobs.tick();
    await awake(r.jobs, r.clock, at(`${day} 09:30`), at(`${day} 10:30`));
    assert.equal(r.sent.length, 1, day);
    assert.match(r.sent[0]!, /^⏰ Late/);
  }
  // An hour the change skips (02:30 on the spring night) is the first real time after it.
  assert.equal(localStamp(localMinute("2026-03-29", 2 * 60 + 30, TZ)!, TZ), "2026-03-29 03:00");
  // Awake through the autumn night (25 hours long): the brief still comes once, at 08:00.
  const r = briefRig({ sleeps: true, start: at("2026-10-24 23:50") });
  await awake(r.jobs, r.clock, at("2026-10-24 23:50"), at("2026-10-25 08:05"));
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0]!, /^☀️ Good morning/);
});

// ---------- the core: claims, crashes ----------

test("a crash between claim and done never sends twice: the retry finds the send marked on the slot", async () => {
  const clock = { now: at("2026-11-17 08:00") };
  const kv = memKv();
  const sends: string[] = [];
  const hang = new Promise<never>(() => undefined);
  // The first process sends, then dies before recording done.
  const a = createJobs({ kv, now: () => clock.now, sleeps: true, owner: "a" });
  void a.slot("test", "test:1", clock.now, async (c) => {
    await c.once("send", async () => (sends.push("x"), true));
    await hang;
  });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(readRows(kv.m.get(JOBS_KEY)!)[0]?.state, "running");
  // A second process in the meantime: the claim is held.
  const b = createJobs({ kv, now: () => clock.now, sleeps: true, owner: "b" });
  const run = async (c: Parameters<Parameters<Jobs["slot"]>[3]>[0]) => void (await c.once("send", async () => (sends.push("y"), true)));
  assert.equal(await b.slot("test", "test:1", clock.now, run), "busy");
  // Restarted later: the crashed claim is taken over, the send is not done again, and the slot is done.
  clock.now += 15 * MIN;
  assert.equal(await b.slot("test", "test:1", clock.now - 15 * MIN, run), "done");
  assert.deepEqual(sends, ["x"]);
  const row = readRows(kv.m.get(JOBS_KEY)!)[0]!;
  assert.equal(row.state, "done");
  assert.equal(row.attempts, 2);
  assert.equal(await b.slot("test", "test:1", clock.now, run), "done", "a slot done stays done");
  assert.deepEqual(sends, ["x"]);
});

test("a crash after the claim but before the send: the retry sends it, once; a run that throws is retried, then given up", async () => {
  const clock = { now: at("2026-11-17 08:00") };
  const kv = memKv();
  const sends: string[] = [];
  const a = createJobs({ kv, now: () => clock.now, sleeps: false, owner: "a" });
  void a.slot("test", "test:2", clock.now, () => new Promise<never>(() => undefined));
  await new Promise((r) => setTimeout(r, 5));
  const b = createJobs({ kv, now: () => clock.now, sleeps: false, owner: "b" });
  b.define({ kind: "test", plan: () => [], run: async (c) => void (await c.once("send", async () => (sends.push("y"), true))) });
  clock.now += 11 * MIN;
  await b.tick(); // the recovery scan finds the crashed row
  assert.deepEqual(sends, ["y"]);
  let n = 0;
  for (let i = 0; i < 6; i++) await b.slot("test", "test:3", clock.now, async () => void (n++, assert.fail("broken")));
  assert.equal(n, 5);
  const row = (await b.rows()).find((x) => x.slot === "test:3")!;
  assert.equal(row.state, "missed");
  assert.match(row.lastError!, /broken/);
});

test("the table: old finished rows are dropped, a row this version cannot read is skipped, never the whole table", async () => {
  assert.deepEqual(readRows("not json"), []);
  const rows = readRows(JSON.stringify({ v: 1, rows: [{ slot: "a", kind: "k", dueAt: 1, state: "weird" }, { nope: 1 }] }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.state, "pending");
  const clock = { now: at("2026-11-17 08:00") };
  const kv = memKv();
  const jobs = createJobs({ kv, now: () => clock.now, sleeps: false });
  await jobs.slot("k", "old", clock.now, async () => undefined);
  clock.now += 9 * 24 * HOUR;
  await jobs.slot("k", "new", clock.now, async () => undefined);
  assert.deepEqual((await jobs.rows()).map((x) => x.slot), ["new"]);
});

test("the proactive check never runs late: a timer's run after a sleep is let go", () => {
  const every = 30 * MIN;
  assert.equal(lateTick(0, 1000, every), false, "the first run");
  assert.equal(lateTick(at("2026-11-17 10:00"), at("2026-11-17 10:30"), every), false);
  assert.equal(lateTick(at("2026-11-17 10:00"), at("2026-11-17 10:31"), every), false, "a busy moment is not a sleep");
  assert.equal(lateTick(at("2026-11-16 23:00"), at("2026-11-17 09:30"), every), true);
});

// ---------- routines ----------

test("routines: one whose time fell while the laptop slept is skipped and said once; awake, it runs as before", async () => {
  const clock = { now: at("2026-11-16 20:00") };
  const kv = memKv();
  const queued: string[] = [];
  const told: string[] = [];
  const jobs = createJobs({ kv, now: () => clock.now, sleeps: true });
  const routines = createRoutines({
    kv, timeZone: TZ, now: () => clock.now, claimMs: 1, jobs, control: createControl(kv, () => clock.now),
    enqueue: async (m) => (queued.push(m.text), true), notify: async (t) => void told.push(t),
  });
  jobs.define({ kind: "routines", sweep: () => routines.tick() });
  await routines.addRoutine({ at: "2026-11-17 07:00", every: "day", text: "dime el tiempo" });
  await routines.addRoutine({ at: "2026-11-17 07:30", every: "day", text: "repasa mi agenda" });
  await awake(jobs, clock, at("2026-11-16 22:00"), at("2026-11-16 23:00"));
  clock.now = at("2026-11-17 09:30");
  await jobs.tick();
  await jobs.tick();
  assert.deepEqual(queued, []);
  assert.equal(told.length, 1, "one message for both");
  assert.match(told[0]!, /^💤 Your computer was asleep at the time of these routines: I skipped them/);
  assert.match(told[0]!, /“dime el tiempo”/);
  assert.match(told[0]!, /“repasa mi agenda”/);
  // The next morning, awake: both run at their time.
  await awake(jobs, clock, at("2026-11-18 06:59"), at("2026-11-18 07:31"));
  assert.equal(queued.length, 2);
  assert.equal(told.length, 1);
});

// ---------- reminders, through the door ----------

const OWNER = "+34600111222";
const OWNER_WA = "34600111222";
const ENV = {
  WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
};
let seq = 0;

async function doorRig(o: { kv: Kv & { m: Map<string, string> }; clock: { now: number }; jobs: Jobs; sent: Body[] }) {
  const meta = (async (_url: string | URL | Request, init?: RequestInit) => {
    o.sent.push(JSON.parse(String(init?.body)) as Body);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out${o.sent.length}` }] }), { status: 200 });
  }) as typeof fetch;
  const memory = loadMemory(o.kv);
  const control = createControl(o.kv, () => o.clock.now);
  const tools = loadVoiceTools({ memory, actions: { contacts: () => [], callContact: async () => ({ ok: true, text: "started" }), lookupCall: async () => "ok" } });
  const config = loadWhatsappConfig(ENV, OWNER).config!;
  const app = express();
  const door = mountWhatsapp(app, {
    config, tools, memory, kv: o.kv, control, ownerName: "Marta", timeZone: TZ, contacts: () => [], fetch: meta, now: () => o.clock.now,
    callCheckMs: 5, receiptWaitMs: 60_000, jobs: o.jobs,
  });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const say = async (body: string): Promise<void> => {
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "1", changes: [{ field: "messages", value: {
        messaging_product: "whatsapp", metadata: { phone_number_id: config.phoneNumberId },
        messages: [{ from: OWNER_WA, id: `wamid.j${++seq}`, timestamp: "1", type: "text", text: { body } }],
      } }] }],
    });
    const signature = `sha256=${createHmac("sha256", config.appSecret).update(raw).digest("hex")}`;
    const res = await fetch(`${base}/whatsapp/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature }, body: raw });
    assert.equal(res.status, 200);
  };
  const post = async (body: unknown): Promise<number> => (await fetch(`${base}/assistant/reply`, {
    method: "POST", headers: { authorization: `Bearer ${config.bridgeToken}`, "content-type": "application/json" }, body: JSON.stringify(body),
  })).status;
  return { door, say, post, base, close: () => (server.close(), server.closeAllConnections()) };
}

const bodies = (sent: Body[]): string[] => sent.map((b) => (b.type === "text" ? b.text.body : b.interactive?.body?.text ?? "") as string);

test("reminders: one due while the laptop slept fires when it wakes, with the note; over 12 hours late it is told as missed", async () => {
  const clock = { now: at("2026-11-16 22:00") };
  const kv = memKv();
  const sent: Body[] = [];
  const jobs = createJobs({ kv, now: () => clock.now, sleeps: true });
  const r = await doorRig({ kv, clock, jobs, sent });
  jobs.define({ kind: "reminders", sweep: () => r.door.runReminders() });
  try {
    await r.say("hola");
    assert.equal(await r.post({ text: "Vale.", remind: [{ at: "2026-11-17 03:00", text: "Sacar la basura" }], key: "k-j1" }), 200);
    assert.equal(await r.post({ text: "Vale.", remind: [{ at: "2026-11-16 22:30", text: "Regar" }], key: "k-j2" }), 200);
    await awake(jobs, clock, at("2026-11-16 22:00"), at("2026-11-16 22:31"));
    assert.ok(bodies(sent).includes("Reminder: Regar"), "awake: on time, as before");
    clock.now = at("2026-11-17 09:30");
    await jobs.tick();
    await jobs.tick();
    const late = bodies(sent).filter((b) => b.startsWith("Reminder") && b.includes("Sacar la basura"));
    assert.deepEqual(late, ["Reminder (late: your computer was asleep): Sacar la basura"]);
    // Asleep for more than 12 hours past one: told as missed, with its time.
    await r.say("hola");
    assert.equal(await r.post({ text: "Vale.", remind: [{ at: "2026-11-17 10:00", text: "Llamar al banco" }], key: "k-j3" }), 200);
    await awake(jobs, clock, at("2026-11-17 09:31"), at("2026-11-17 09:32"));
    clock.now = at("2026-11-17 23:30");
    await jobs.tick();
    await jobs.tick();
    const missed = bodies(sent).filter((b) => !b.includes("“Llamar al banco”") && b.includes("Llamar al banco"));
    assert.equal(missed.length, 1);
    assert.match(missed[0]!, /^⏰ I missed a reminder for .*10:00: your computer was asleep\. It was: Llamar al banco$/);
    assert.ok((await jobs.rows()).every((x) => x.kind !== "reminder" || x.state === "done"));
  } finally {
    r.close();
  }
});

test("reminders: sent, then the process dies before the list is saved: the restarted door does not send it again", async () => {
  const clock = { now: at("2026-11-17 08:00") };
  const store = { down: false };
  const kv = memKv({ failSet: (k) => store.down && k === "assistant-reminders" });
  const sent: Body[] = [];
  const first = await doorRig({ kv, clock, jobs: createJobs({ kv, now: () => clock.now, sleeps: false, owner: "a" }), sent });
  try {
    await first.say("hola");
    assert.equal(await first.post({ text: "Vale.", remind: [{ at: "2026-11-17 09:00", text: "Tomar la pastilla" }], key: "k-j4" }), 200);
    clock.now = at("2026-11-17 09:00") + 10_000;
    // The send goes; the reminders cannot be written back (the process "dies" with the store as it was).
    store.down = true;
    await first.door.runReminders();
    store.down = false;
  } finally {
    first.close();
  }
  assert.equal(bodies(sent).filter((b) => b === "Reminder: Tomar la pastilla").length, 1);
  const second = await doorRig({ kv, clock, jobs: createJobs({ kv, now: () => clock.now, sleeps: false, owner: "b" }), sent });
  try {
    clock.now += 60_000;
    await second.door.runReminders();
    assert.equal(bodies(sent).filter((b) => b === "Reminder: Tomar la pastilla").length, 1, "not twice");
    assert.deepEqual(await second.door.reminders(), [], "and the restarted door lets it go");
  } finally {
    second.close();
  }
});

test("brief: late with the written brief, the note goes on its own channel, so what follows a brief (the same-person question) waits for it", async () => {
  const clock = { now: at("2026-11-16 22:00") };
  const kv = memKv();
  const order: string[] = [];
  const brief = createBrief({
    at: 8 * 60, kv, timeZone: TZ, now: () => clock.now,
    notify: async (t) => void order.push(`brief:${t.slice(0, 12)}`),
    notifyNote: async (t) => void order.push(`note:${t}`),
    smart: { begin: async () => (order.push("written"), true), short: async () => null },
  });
  const jobs = createJobs({ kv, now: () => clock.now, sleeps: true });
  brief.start(jobs);
  await awake(jobs, clock, at("2026-11-16 22:00"), at("2026-11-16 23:00"));
  clock.now = at("2026-11-17 09:30");
  await jobs.tick();
  assert.deepEqual(order, ["note:⏰ Late: your computer was asleep at 08:00.", "written"]);
});

test("brief: what changed is told since the last brief given, so a skipped day is not lost; a day back when none is known", async () => {
  const r = { spans: [] as { now: number; since: number }[] };
  const clock = { now: at("2026-11-16 07:55") };
  const kv = memKv();
  const brief = createBrief({
    at: 8 * 60, kv, timeZone: TZ, now: () => clock.now, notify: async () => undefined,
    extras: [async (o) => (r.spans.push(o), null)],
  });
  const jobs = createJobs({ kv, now: () => clock.now, sleeps: true });
  brief.start(jobs);
  await awake(jobs, clock, at("2026-11-16 07:55"), at("2026-11-16 08:01"));
  assert.equal(r.spans[0]!.since, r.spans[0]!.now - 24 * HOUR, "none known: a day back");
  await awake(jobs, clock, at("2026-11-16 22:00"), at("2026-11-16 23:00"));
  clock.now = at("2026-11-17 12:00");
  await jobs.tick();
  await awake(jobs, clock, at("2026-11-18 07:55"), at("2026-11-18 08:01"));
  assert.equal(r.spans.length, 2);
  assert.equal(r.spans[1]!.since, at("2026-11-16 08:00"), "since the brief of the 16th, the 17th's was skipped");
});

test("an awake laptop whose follow-up look is slow (offline, each check waits for its timeouts) is not taken as asleep: the routine runs", async () => {
  const clock = { now: at("2026-11-17 06:50") };
  const kv = memKv();
  const queued: string[] = [];
  const told: string[] = [];
  const jobs = createJobs({ kv, now: () => clock.now, sleeps: true });
  const routines = createRoutines({
    kv, timeZone: TZ, now: () => clock.now, claimMs: 1, jobs, control: createControl(kv, () => clock.now),
    enqueue: async (m) => (queued.push(m.text), true), notify: async (t) => void told.push(t),
  });
  jobs.define({ kind: "routines", sweep: () => routines.tick() });
  let slow = false;
  // As app.ts: the follow-ups' own look beside the routines'. This one takes 7 minutes (20 checks x Zoom 10 s + calendar 10 s, offline).
  jobs.define({ kind: "followups", sweep: async () => { if (slow) { slow = false; clock.now += 7 * MIN; } } });
  await routines.addRoutine({ at: "2026-11-17 07:01", every: "day", text: "dime el tiempo" });
  await awake(jobs, clock, at("2026-11-17 06:50"), at("2026-11-17 07:00"));
  slow = true;
  await jobs.tick();
  clock.now += 30_000;
  await jobs.tick();
  await jobs.tick();
  assert.deepEqual(told, [], "the laptop never slept");
  assert.deepEqual(jobs.sleepsSeen(), []);
  assert.equal(queued.length, 1);
  assert.match(queued[0]!, /dime el tiempo$/);
});

test("a slow look of one kind holds up neither another kind's look nor the planned slots; a look that slept (by the clock that stops) is a sleep", async () => {
  const clock = { now: at("2026-11-17 07:00") };
  let release: () => void = () => {};
  const runs: string[] = [];
  let monoNow = 0;
  const jobs = createJobs({ kv: memKv(), now: () => clock.now, mono: () => monoNow, sleeps: true });
  jobs.define({ kind: "followups", sweep: () => (runs.push("followups"), new Promise<void>((r) => (release = r))) });
  jobs.define({ kind: "reminders", sweep: async () => void runs.push("reminders") });
  jobs.define({
    kind: "brief", plan: (t) => [{ slot: `brief:${t}`, dueAt: t }], run: async () => void runs.push("brief"),
  });
  const first = jobs.tick();
  await new Promise((r) => setImmediate(r));
  clock.now += 30_000;
  await jobs.tick(); // the follow-ups' look still waits: reminders and the brief run anyway, and the follow-ups' look is not started twice
  assert.deepEqual(runs.filter((x) => x === "reminders").length, 2);
  assert.deepEqual(runs.filter((x) => x === "brief").length, 2);
  assert.deepEqual(runs.filter((x) => x === "followups").length, 1);
  // The computer sleeps while the look waits: 8 hours pass by the wall clock, none by the clock that stops in a sleep.
  clock.now += 8 * HOUR;
  monoNow += 1000;
  release();
  await first;
  assert.equal(jobs.sleepsSeen().length, 1, "a sleep during a look is still noticed");
});

// ---------- the bridge's poll right after a wake ----------

const pollInbox = async (base: string): Promise<void> => {
  const res = await fetch(`${base}/assistant/inbox?wait=0`, { headers: { authorization: `Bearer ${"b".repeat(48)}` } });
  assert.equal(res.status, 200);
};

test("a reminder due in a sleep and run by the bridge's poll before the jobs' look still says it is late", async () => {
  const clock = { now: at("2026-11-16 22:00") };
  const kv = memKv();
  const sent: Body[] = [];
  const jobs = createJobs({ kv, now: () => clock.now, sleeps: true });
  const r = await doorRig({ kv, clock, jobs, sent });
  jobs.define({ kind: "reminders", sweep: () => r.door.runReminders() });
  try {
    await r.say("hola");
    assert.equal(await r.post({ text: "Vale.", remind: [{ at: "2026-11-17 03:00", text: "Sacar la basura" }], key: "k-poll1" }), 200);
    await awake(jobs, clock, at("2026-11-16 22:00"), at("2026-11-16 23:00"));
    clock.now = at("2026-11-17 09:30"); // the lid was closed 23:00-09:30; the poll comes first
    await pollInbox(r.base);
    await r.door.runReminders();
    await jobs.tick();
    const got = bodies(sent).filter((b) => b.startsWith("Reminder") && b.includes("Sacar la basura"));
    assert.deepEqual(got, ["Reminder (late: your computer was asleep): Sacar la basura"]);
  } finally {
    r.close();
  }
});

test("a reminder more than 12 hours late, run by the bridge's poll before the jobs' look, is told as missed, not sent as on time", async () => {
  const clock = { now: at("2026-11-16 18:00") };
  const kv = memKv();
  const sent: Body[] = [];
  const jobs = createJobs({ kv, now: () => clock.now, sleeps: true });
  const r = await doorRig({ kv, clock, jobs, sent });
  jobs.define({ kind: "reminders", sweep: () => r.door.runReminders() });
  try {
    await r.say("hola");
    assert.equal(await r.post({ text: "Vale.", remind: [{ at: "2026-11-16 19:00", text: "Llamar al banco" }], key: "k-poll2" }), 200);
    await awake(jobs, clock, at("2026-11-16 18:00"), at("2026-11-16 18:30"));
    clock.now = at("2026-11-17 09:30");
    await r.say("hola");
    await pollInbox(r.base);
    await r.door.runReminders();
    await jobs.tick();
    const got = bodies(sent).filter((b) => b.includes("Llamar al banco") && !b.includes("“Llamar al banco”"));
    assert.equal(got.length, 1);
    assert.match(got[0]!, /^⏰ I missed a reminder/);
  } finally {
    r.close();
  }
});

// ---------- Pako started after the brief's hour ----------

test("Pako first started at 14:00: the first BRIEF does not say the computer was asleep at 08:00", async () => {
  const clock = { now: at("2026-11-17 14:00") };
  const kv = memKv();
  const brief = createBrief({ at: 8 * 60, kv, timeZone: TZ, now: () => clock.now, notify: async () => undefined });
  const jobs = createJobs({ kv, now: () => clock.now, sleeps: true });
  brief.start(jobs);
  clock.now += 30_000;
  await jobs.tick();
  clock.now += 60_000;
  assert.doesNotMatch(await brief.now(), /didn't go out|asleep/);
});

test("Pako opened at 09:00 after being quit: the brief comes late without «your computer was asleep»", async () => {
  const clock = { now: at("2026-11-17 09:00") };
  const kv = memKv();
  const told: string[] = [];
  const brief = createBrief({ at: 8 * 60, kv, timeZone: TZ, now: () => clock.now, notify: async (t) => void told.push(t) });
  const jobs = createJobs({ kv, now: () => clock.now, sleeps: true });
  brief.start(jobs);
  clock.now += 30_000;
  await jobs.tick();
  assert.equal(told.length, 1, "the day's brief");
  assert.doesNotMatch(told[0]!, /asleep/);
});

// ---------- the written brief pending when the laptop sleeps ----------

function smartRig() {
  const clock = { now: at("2026-11-17 07:58") };
  const kv = memKv();
  const sent: { at: string; text: string }[] = [];
  const out = (text: string) => void sent.push({ at: localStamp(clock.now, TZ), text: text.split("\n")[0]! });
  const ref: { brief?: ReturnType<typeof createBrief> } = {};
  const v2 = createBriefV2({
    config: { waitMs: 15 * 60_000 }, kv, timeZone: TZ, now: () => clock.now, sources: { tasks: async () => [] },
    enqueue: async () => true, plain: () => ref.brief!.plain(), bridgeAlive: () => true, notify: async (t) => out(t),
  });
  ref.brief = createBrief({
    at: 8 * 60, kv, timeZone: TZ, now: () => clock.now, notify: async (t) => out(t),
    smart: { begin: (t) => v2.begin(t), short: () => v2.short() },
  });
  const jobs = createJobs({ kv, now: () => clock.now, sleeps: true });
  ref.brief.start(jobs);
  // Both clocks every half minute, as in the app; the bridge never answers.
  const awakeFrom = async (from: string, to: string) => {
    for (clock.now = at(from); clock.now <= at(to); clock.now += 30_000) {
      await jobs.tick();
      await v2.tick();
    }
  };
  return { sent, awakeFrom, brief: ref.brief };
}

test("the written brief pending when the lid closes at 08:02 and opens at 19:00: no «good morning» brief at 19:00, BRIEF says it was skipped", async () => {
  const r = smartRig();
  await r.awakeFrom("2026-11-17 07:58", "2026-11-17 08:02");
  assert.deepEqual(r.sent, [], "the written brief is with the bridge");
  await r.awakeFrom("2026-11-17 19:00", "2026-11-17 19:01");
  assert.deepEqual(r.sent, []);
  assert.match(await r.brief.now(), /didn't go out/);
});

test("the written brief pending when the lid closes at 08:02 and opens the next day at 07:30: one brief that day, at its hour", async () => {
  const r = smartRig();
  await r.awakeFrom("2026-11-17 07:58", "2026-11-17 08:02");
  await r.awakeFrom("2026-11-18 07:30", "2026-11-18 08:16");
  const nextDay = r.sent.filter((x) => x.at.startsWith("2026-11-18"));
  assert.equal(nextDay.length, 1, JSON.stringify(nextDay));
  assert.ok(nextDay[0]!.at >= "2026-11-18 08:00", "not before its hour");
});

test("the written brief that does not come in time on an awake morning: the old brief still goes that morning", async () => {
  const r = smartRig();
  await r.awakeFrom("2026-11-17 07:58", "2026-11-17 08:20");
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0]!.text, /Today is Tuesday 17 November/);
});
