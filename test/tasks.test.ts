// Repeating reminders with buttons, and lists and tasks (src/lists.ts, wired in src/whatsapp.ts): the next time of a repeat (every day, on
// weekdays, the 31st of each month, across a change of daylight saving), a reminder's buttons (Done, +10 min, Tomorrow, a second press), the
// <list>, <task> and <done> tags with their receipts and Deshacer, the commands, an old bridge, the bridge's parseReply and the panel's routes.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { parseReply } from "../assistant/bridge.ts";
import { SYSTEM_PROMPT } from "../assistant/prompt.ts";
import { createControl } from "../src/control.ts";
import type { Kv } from "../src/kv.ts";
import { briefLine, createLists, mountTasksPanel, todayTasks } from "../src/lists.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";
import { loadWhatsappConfig, localStamp, mountWhatsapp, nextRepeat, repeatAfter } from "../src/whatsapp.ts";

const OWNER = "+34600111222";
const OWNER_WA = "34600111222";
const ENV = {
  WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
};
const TZ = "Europe/Madrid";
/** Saturday 14 November 2026, 13:00 in Madrid. */
const T0 = Date.parse("2026-11-14T12:00:00Z");
type Body = Record<string, any>;
const at = (local: string): number => {
  const t = Date.parse(`${local.replace(" ", "T")}:00Z`);
  // Madrid is UTC+1 in winter and UTC+2 in summer: found by trying both.
  for (const h of [1, 2]) if (localStamp(t - h * 3600_000, TZ) === local) return t - h * 3600_000;
  throw new Error(`no such time ${local}`);
};
const stamps = (start: string, every: "day" | "weekday" | "week" | "month" | "year", n: number): string[] => {
  const out: string[] = [];
  let t = at(start);
  for (let i = 0; i < n; i++) {
    t = nextRepeat(t, every, start, TZ)!;
    out.push(localStamp(t, TZ));
  }
  return out;
};

function memKv(o: { failGet?: (key: string) => boolean; failSet?: (key: string) => boolean } = {}): Kv & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    m,
    get: async (k) => {
      if (o.failGet?.(k)) throw new Error("store down");
      return m.get(k) ?? null;
    },
    set: async (k, v) => {
      if (o.failSet?.(k)) throw new Error("store down");
      m.set(k, v);
    },
  };
}

let n = 0;

async function rig(o: { kv?: Kv; clock?: { now: number }; down?: { on: boolean } } = {}) {
  const sent: Body[] = [];
  const meta = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (o.down?.on) return new Response("{}", { status: 500 });
    sent.push(JSON.parse(String(init?.body)) as Body);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out${sent.length}` }] }), { status: 200 });
  }) as typeof fetch;
  const clock = o.clock ?? { now: T0 };
  const kv = o.kv ?? memKv();
  const memory = loadMemory(kv);
  const control = createControl(kv, () => clock.now);
  const tools = loadVoiceTools({ memory, actions: { contacts: () => ["Ana"], callContact: async () => ({ ok: true, text: "started" }), lookupCall: async () => "ok" } });
  const config = loadWhatsappConfig(ENV, OWNER).config!;
  const app = express();
  const door = mountWhatsapp(app, {
    config, tools, memory, kv, control, ownerName: "Marta", timeZone: TZ, contacts: () => ["Ana"], fetch: meta, now: () => clock.now, callCheckMs: 5, receiptWaitMs: 60_000,
  });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const hook = async (msgs: Body[]): Promise<void> => {
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: config.phoneNumberId }, messages: msgs } }] }],
    });
    const signature = `sha256=${createHmac("sha256", config.appSecret).update(raw).digest("hex")}`;
    const res = await fetch(`${base}/whatsapp/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature }, body: raw });
    assert.equal(res.status, 200);
  };
  const say = (body: string) => hook([{ from: OWNER_WA, id: `wamid.t${++n}`, timestamp: "1", type: "text", text: { body } }]);
  const pressMsg = (id: string, msgId = `wamid.t${++n}`) => ({ from: OWNER_WA, id: msgId, timestamp: "1", type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: "x" } } });
  const press = (id: string) => hook([pressMsg(id)]);
  const auth = { authorization: `Bearer ${config.bridgeToken}` };
  const post = async (body: unknown): Promise<number> =>
    (await fetch(`${base}/assistant/reply`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) })).status;
  const context = async () => (await (await fetch(`${base}/assistant/context`, { headers: auth })).json()) as Body;
  /** What reached the owner, in order: a text's words, a card's body with its buttons' kinds and titles. */
  const shown = (): string[] =>
    sent.map((b) => b.type === "text" ? b.text.body as string
      : `${b.interactive.body.text}\n[${(b.interactive.action.buttons as Body[]).map((x) => `${String(x.reply.id).slice(0, 3)}${x.reply.title}`).join(" | ")}]`);
  const last = (): string => shown().at(-1) ?? "";
  const lastCard = (): string[] => ([...sent].reverse().find((b) => b.type === "interactive")?.interactive.action.buttons as Body[]).map((x) => String(x.reply.id));
  const reminders = async (): Promise<string[]> => (await context()).reminders as string[];
  return { base, sent, clock, kv, control, door, say, press, pressMsg, hook, post, context, shown, last, lastCard, reminders, close: () => { server.close(); server.closeAllConnections(); } };
}

// ---------- 1. the next time of a repeat ----------

test("repeats: every day keeps the hour; on weekdays Friday goes to Monday; a week is seven days; a year from the 29th of February is the 28th", () => {
  assert.deepEqual(stamps("2026-11-14 09:00", "day", 3), ["2026-11-15 09:00", "2026-11-16 09:00", "2026-11-17 09:00"]);
  assert.deepEqual(stamps("2026-11-12 08:30", "weekday", 4), ["2026-11-13 08:30", "2026-11-16 08:30", "2026-11-17 08:30", "2026-11-18 08:30"]);
  assert.deepEqual(stamps("2026-11-14 10:00", "weekday", 1), ["2026-11-16 10:00"], "one set on a Saturday goes on on Monday");
  assert.deepEqual(stamps("2026-11-14 10:00", "week", 2), ["2026-11-21 10:00", "2026-11-28 10:00"]);
  assert.deepEqual(stamps("2028-02-29 12:00", "year", 4), ["2029-02-28 12:00", "2030-02-28 12:00", "2031-02-28 12:00", "2032-02-29 12:00"]);
});

test("repeats: monthly on the 31st takes the last day of a shorter month and comes back to the 31st; December goes to January", () => {
  assert.deepEqual(stamps("2026-12-31 09:00", "month", 5), ["2027-01-31 09:00", "2027-02-28 09:00", "2027-03-31 09:00", "2027-04-30 09:00", "2027-05-31 09:00"]);
  assert.deepEqual(stamps("2027-11-30 18:00", "month", 3), ["2027-12-30 18:00", "2028-01-30 18:00", "2028-02-29 18:00"]);
});

test("repeats across daylight saving: 09:00 stays 09:00 in Madrid; an hour the change skips becomes the first real time after it", () => {
  const spring = stamps("2026-03-27 09:00", "day", 3);
  assert.deepEqual(spring, ["2026-03-28 09:00", "2026-03-29 09:00", "2026-03-30 09:00"]);
  // 23 hours between the 28th and the 29th, 24 after: the same local hour, not the same distance.
  assert.equal(at("2026-03-29 09:00") - at("2026-03-28 09:00"), 23 * 3600_000);
  assert.deepEqual(stamps("2026-10-24 09:00", "day", 2), ["2026-10-25 09:00", "2026-10-26 09:00"]);
  // 02:30 does not exist on 29 March 2026 in Madrid (02:00 → 03:00).
  const skipped = nextRepeat(at("2026-03-28 02:30"), "day", "2026-03-28 02:30", TZ)!;
  assert.equal(localStamp(skipped, TZ), "2026-03-29 03:00");
  assert.equal(localStamp(nextRepeat(skipped, "day", "2026-03-28 02:30", TZ)!, TZ), "2026-03-30 02:30", "and the next day is 02:30 again");
  // A repeat given late skips the times it missed, never fires them all.
  assert.equal(localStamp(repeatAfter(at("2026-11-10 09:00"), "day", "2026-11-10 09:00", TZ, at("2026-11-14 13:00"))!, TZ), "2026-11-15 09:00");
});

// ---------- 2. a repeating reminder through the door, and the buttons ----------

test("a repeating reminder: its receipt says so, REMINDERS marks it, it fires as a card with three buttons and its next time is set", async () => {
  const r = await rig();
  try {
    await r.say("hola");
    assert.equal(await r.post({ text: "Hecho.", remind: [{ at: "2026-11-15 09:00", text: "Tomar la pastilla", every: "day" }], key: "k-rep" }), 200);
    assert.match(r.shown().join("\n"), /⏰ Reminder: Sun 15 Nov, 09:00 · “Tomar la pastilla” \(every day\)\n\[u1:Undo\]/);
    assert.deepEqual(await r.reminders(), ["2026-11-15 09:00 Tomar la pastilla (repeats: every day)"]);
    await r.say("reminders");
    assert.equal(r.last(), "⏰ Pending reminders:\n• Sun 15 Nov, 09:00 · Tomar la pastilla (repeats: every day)");
    r.clock.now = at("2026-11-15 09:00") + 20_000;
    await r.door.runReminders();
    assert.equal(r.last(), "Reminder: Tomar la pastilla\n[r1:Done | r2:+10 min | r3:Tomorrow]");
    assert.deepEqual(await r.reminders(), ["2026-11-16 09:00 Tomar la pastilla (repeats: every day)"], "the next one, same words, same rule");
    await r.door.runReminders();
    assert.equal(r.shown().filter((s) => s.startsWith("Reminder:")).length, 1, "once");
    // Hecho on a repeat only acknowledges, and says when the next one is.
    await r.press(r.lastCard()[0]!);
    assert.equal(r.last(), "✅ Done. The next one: Mon 16 Nov, 09:00.");
    assert.deepEqual(await r.reminders(), ["2026-11-16 09:00 Tomar la pastilla (repeats: every day)"]);
    // Its receipt's Deshacer still takes the whole series away.
    const undo = r.sent.find((b) => b.type === "interactive" && /^u1:/.test(b.interactive.action.buttons[0].reply.id))!;
    await r.press(undo.interactive.action.buttons[0].reply.id);
    assert.deepEqual(await r.reminders(), []);
  } finally {
    r.close();
  }
});

test("a daily repeat missed for days while the owner is out of reach: one held copy, one late card, room for new reminders", async () => {
  const r = await rig();
  try {
    await r.say("hola");
    assert.equal(await r.post({ text: "Hecho.", remind: [{ at: "2026-11-16 09:00", text: "Tomar la pastilla", every: "day" }], key: "k-miss" }), 200);
    for (const day of ["16", "17", "18", "19", "20"]) {
      r.clock.now = at(`2026-11-${day} 09:00`) + 20_000;
      await r.door.runReminders();
    }
    assert.deepEqual(await r.reminders(), [
      "2026-11-20 09:00 Tomar la pastilla (already due, not told yet)",
      "2026-11-21 09:00 Tomar la pastilla (repeats: every day)",
    ]);
    // Nineteen more one-offs still fit: the held copy does not take the series' place twice.
    const remind = Array.from({ length: 19 }, (_, i) => ({ at: `2026-11-2${2 + (i % 7)} ${String(10 + Math.floor(i / 7)).padStart(2, "0")}:00`, text: `cosa ${i}` }));
    for (let i = 0; i < remind.length; i += 2) assert.equal(await r.post({ text: "Vale.", remind: remind.slice(i, i + 2), key: `k-miss-${i}` }), 200);
    assert.equal((await r.reminders()).length, 21);
    const before = r.sent.length;
    await r.say("hola de nuevo");
    const late = r.shown().slice(before).filter((x) => x.startsWith("While we weren't talking, this reminder came due"));
    assert.equal(late.length, 1, "one late card for five missed days");
    assert.match(late[0]!, /it was for 2026-11-20 09:00/);
  } finally {
    r.close();
  }
});

test("Deshacer on a repeat takes its held copy too", async () => {
  const down = { on: false };
  const r = await rig({ down });
  try {
    await r.say("hola");
    await r.post({ text: "Hecho.", remind: [{ at: "2026-11-16 09:00", text: "Regar", every: "day" }], key: "k-miss-3" });
    r.clock.now = at("2026-11-16 09:00") + 20_000;
    await r.door.runReminders();
    assert.equal((await r.reminders()).length, 2);
    // The late card cannot go as the owner presses: the copy is still there when the series is undone.
    down.on = true;
    const undo = r.sent.find((b) => b.type === "interactive" && /^u1:/.test(b.interactive.action.buttons[0].reply.id))!;
    await r.press(undo.interactive.action.buttons[0].reply.id);
    assert.deepEqual(await r.reminders(), []);
  } finally {
    r.close();
  }
});

test("buttons: +10 min and Tomorrow set a new reminder with the same words; a second press, or the same press delivered again, changes nothing", async () => {
  const r = await rig();
  try {
    await r.say("hola");
    await r.post({ text: "Vale.", remind: [{ at: "2026-11-14 18:00", text: "Llamar a Ana" }], key: "k-snooze" });
    r.clock.now = at("2026-11-14 18:00") + 5_000;
    await r.door.runReminders();
    const [done, snooze, tomorrow] = r.lastCard();
    assert.match(done!, /^r1:[0-9a-f]{10}$/);
    assert.deepEqual(await r.reminders(), []);
    await r.press(snooze!);
    assert.equal(r.last(), "⏰ I'll remind you again at 18:10.");
    assert.deepEqual(await r.reminders(), ["2026-11-14 18:10 Llamar a Ana"]);
    await r.press(tomorrow!);
    assert.equal(r.last(), "That reminder has already been answered: I'm not changing anything.");
    await r.press(done!);
    assert.equal(r.last(), "That reminder has already been answered: I'm not changing anything.");
    assert.deepEqual(await r.reminders(), ["2026-11-14 18:10 Llamar a Ana"], "one snooze, not two");
    // The snoozed one fires with buttons of its own: Tomorrow, at the hour it was for.
    r.clock.now = at("2026-11-14 18:10") + 5_000;
    await r.door.runReminders();
    assert.equal(r.last(), "Reminder: Llamar a Ana\n[r1:Done | r2:+10 min | r3:Tomorrow]");
    const card = r.lastCard();
    // Meta delivers the same press twice: handled once.
    const twice = r.pressMsg(card[2]!);
    await r.hook([twice]);
    await r.hook([twice]);
    assert.equal(r.shown().filter((s) => s.startsWith("⏰ I'll remind you tomorrow")).length, 1);
    assert.equal(r.last(), "⏰ I'll remind you tomorrow at 18:10.");
    assert.deepEqual(await r.reminders(), ["2026-11-15 18:10 Llamar a Ana"]);
    await r.press(card[0]!);
    assert.equal(r.last(), "That reminder has already been answered: I'm not changing anything.");
    await r.press("r1:0123456789");
    assert.equal(r.last(), "That reminder is no longer there: I'm not changing anything.");
  } finally {
    r.close();
  }
});

test("buttons after a restart: the card is still known, and still answered once", async () => {
  const kv = memKv();
  const clock = { now: T0 };
  const first = await rig({ kv, clock });
  let card: string[];
  try {
    await first.say("hola");
    await first.post({ text: "Vale.", remind: [{ at: "2026-11-14 18:00", text: "Regar" }], key: "k-restart" });
    clock.now = at("2026-11-14 18:00") + 5_000;
    await first.door.runReminders();
    card = first.lastCard();
    await first.press(card[0]!);
    assert.equal(first.last(), "✅ Done.");
  } finally {
    first.close();
  }
  const again = await rig({ kv, clock });
  try {
    await again.press(card[1]!);
    assert.equal(again.last(), "That reminder has already been answered: I'm not changing anything.");
    assert.deepEqual(await again.reminders(), []);
  } finally {
    again.close();
  }
});

// ---------- 3. lists and tasks through the tags and the commands ----------

test("lists: <list add> and <list remove> change the list and get a receipt with Undo; LISTS and LIST show them; the context lists them", async () => {
  const r = await rig();
  try {
    await r.say("apunta leche y pan en la compra");
    assert.equal(await r.post({ text: "Apuntado.", lists: [{ name: "compra", op: "add", items: ["leche", "pan", "Leche"] }], key: "k-l1" }), 200);
    assert.equal(r.last(), "🛒 Added to the “compra” list: “leche”, “pan”\n[u1:Undo]");
    // The same answer sent again by the bridge adds nothing.
    await r.post({ text: "Apuntado.", lists: [{ name: "compra", op: "add", items: ["leche", "pan"] }], key: "k-l1" });
    await r.post({ text: "Y huevos.", lists: [{ name: "Compra", op: "add", items: ["huevos", "pan"] }], key: "k-l2" });
    assert.equal(r.last(), "🛒 Added to the “compra” list: “huevos”\n[u1:Undo]", "only what really changed");
    const ctx = await r.context();
    assert.deepEqual(ctx.lists, ["compra: leche; pan; huevos"]);
    assert.deepEqual(ctx.tasks, []);
    await r.say("LISTS");
    assert.equal(r.last(), "📋 Your lists:\n• compra (3): leche, pan, huevos\n\nType LIST and its name to see all of it.");
    await r.say("list compra");
    assert.equal(r.last(), "📋 compra (3):\n• leche\n• pan\n• huevos");
    // A LIST that names no list is words for the assistant.
    await r.say("list three ideas for dinner");
    assert.ok((await r.door.inbox.peek()).some((m) => m.text === "list three ideas for dinner"));
    await r.post({ text: "Quitado.", lists: [{ name: "compra", op: "remove", items: ["leche"] }], key: "k-l3" });
    assert.equal(r.last(), "🗑️ Removed from the “compra” list: “leche”\n[u1:Undo]");
    await r.post({ text: "No está.", lists: [{ name: "compra", op: "remove", items: ["caviar"] }], key: "k-l4" });
    assert.equal(r.last(), "I didn't find that on the “compra” list.");
    // Deshacer on the removal puts it back; on the first add, takes off what it added that is still there.
    const undos = r.sent.filter((b) => b.type === "interactive" && /^u1:/.test(b.interactive.action.buttons[0].reply.id)).map((b) => b.interactive.action.buttons[0].reply.id as string);
    await r.press(undos[2]!);
    assert.equal(r.last(), "↩️ Undone: put back on the “compra” list: “leche”.");
    await r.press(undos[0]!);
    assert.equal(r.last(), "↩️ Undone: removed from the “compra” list: “pan”, “leche”.", "leche came back at the end");
    assert.deepEqual((await r.context()).lists, ["compra: huevos"]);
  } finally {
    r.close();
  }
});

test("tasks: <task> with a day, TASKS, <done> with a receipt and Deshacer; a day that is not a day is said; today's tasks go in the brief", async () => {
  const r = await rig();
  try {
    await r.say("tasks");
    assert.equal(r.last(), "You have no open tasks.");
    await r.post({ text: "Anotado.", tasks: [{ text: "llamar al banco", due: "2026-11-20" }, { text: "pagar la luz", due: "el viernes" }], key: "k-t1" });
    assert.ok(r.shown().includes("I didn't understand the day “el viernes” for the task “pagar la luz”: I saved it with no day."));
    assert.equal(r.last(), "Here's what I changed:\n✅ Task: “llamar al banco” · for Fri 20 Nov\n✅ Task: “pagar la luz”\n[u1:Undo]");
    await r.post({ text: "Ya la tienes.", tasks: [{ text: "Llamar al banco" }], key: "k-t2" });
    assert.ok(!r.last().includes("Llamar al banco"), "the same open task is not added twice");
    await r.say("TASKS");
    assert.equal(r.last(), "✅ Open tasks:\n• llamar al banco (for Fri 20 Nov)\n• pagar la luz");
    assert.deepEqual((await r.context()).tasks, ["llamar al banco (2026-11-20)", "pagar la luz"]);
    await r.post({ text: "¡Bien!", done: ["banco"], key: "k-t3" });
    assert.equal(r.last(), "☑️ Done: “llamar al banco”\n[u1:Undo]");
    await r.post({ text: "?", done: ["dentista"], key: "k-t4" });
    assert.equal(r.last(), "I didn't find any open task with those words.");
    await r.press(r.lastCard()[0]!);
    assert.equal(r.last(), "↩️ Undone: reopened the task “llamar al banco”.");
    // The brief on the 20th names it.
    r.clock.now = at("2026-11-20 08:00");
    assert.equal(await r.door.tasksBrief(), "✅ Tasks for today: llamar al banco");
  } finally {
    r.close();
  }
});

test("lists in English: the receipt, the commands and the brief line", async () => {
  const lists = createLists(null, () => T0);
  await lists.add("shopping", ["milk"], T0);
  await lists.addTask("call the bank", "2026-11-13", T0);
  await lists.addTask("someday", undefined, T0);
  const b = await lists.read();
  assert.deepEqual(todayTasks(b, T0, TZ).map((x) => x.text), ["call the bank"], "late ones too, none without a day");
  assert.equal(briefLine(b, T0, TZ, "en"), "✅ Tasks for today: call the bank (was for Fri 13 Nov)");
  assert.equal(briefLine({ lists: [], tasks: [] }, T0, TZ, "en"), null);
});

test("an old bridge: a reply with none of the new fields works as before; a store that fails says so once and still answers", async () => {
  const kv = memKv({ failSet: (k) => k === "assistant-lists" });
  const r = await rig({ kv });
  try {
    await r.say("hola");
    assert.equal(await r.post({ text: "Hola, Marta.", remind: [{ at: "2026-11-15 09:00", text: "Dentista" }], key: "k-old" }), 200);
    assert.equal(r.shown()[0], "Hola, Marta.");
    assert.deepEqual(await r.reminders(), ["2026-11-15 09:00 Dentista"], "no every: fires once, as before");
    // An "every" that is not one the server knows is ignored, never refused.
    await r.post({ text: "Vale.", remind: [{ at: "2026-11-16 09:00", text: "Café", every: "hourly" }], key: "k-old2" });
    assert.deepEqual(await r.reminders(), ["2026-11-15 09:00 Dentista", "2026-11-16 09:00 Café"]);
    assert.equal(await r.post({ text: "Apuntado.", lists: [{ name: "compra", op: "add", items: ["leche"] }], key: "k-fail" }), 200);
    assert.equal(r.last(), "I couldn't change your lists right now. Ask me again in a while.");
  } finally {
    r.close();
  }
});

// ---------- 4. the bridge and the prompt ----------

test("parseReply: <list>, <task>, <done> and every= are read and removed; an answer without them keeps its old shape", () => {
  const r = parseReply('Apuntado. <list name="compra" add>leche;  pan\nhuevos</list><list name="casa" remove>bombillas</list><task due="2026-11-20">llamar\n al banco</task><task>regar</task><done>dentista</done> Listo.');
  assert.equal(r.text, "Apuntado. Listo.");
  assert.deepEqual(r.lists, [{ name: "compra", op: "add", items: ["leche", "pan", "huevos"] }, { name: "casa", op: "remove", items: ["bombillas"] }]);
  assert.deepEqual(r.tasks, [{ text: "llamar al banco", due: "2026-11-20" }, { text: "regar" }]);
  assert.deepEqual(r.done, ["dentista"]);
  const rem = parseReply('Hecho. <remind at="2026-11-16 09:00" every="weekday">pastilla</remind><remind at="2026-11-17 09:00" every="hourly">x</remind>');
  assert.deepEqual(rem.remind, [{ at: "2026-11-16 09:00", text: "pastilla", every: "weekday" }, { at: "2026-11-17 09:00", text: "x" }]);
  assert.equal(parseReply('Vale <list name="compra">sin op</list>').lists, undefined, "a list with no add or remove is nothing");
  assert.equal(parseReply("Hola <task>sin cerrar").text, "Hola sin cerrar", "a broken one never reaches the owner");
  assert.equal(parseReply("Mis listas y tareas: <done").text, "Mis listas y tareas:");
  assert.equal(parseReply("las <listas> no son etiquetas").text, "las <listas> no son etiquetas");
  assert.deepEqual(Object.keys(parseReply("solo texto")).sort(), ["book", "call", "forget", "message", "remember", "remind", "send", "slack", "text", "unremind"]);
  assert.match(SYSTEM_PROMPT, /<list name="groceries" add>milk; bread<\/list>/);
  assert.match(SYSTEM_PROMPT, /<task due="2026-11-20">call the bank<\/task>/);
  assert.match(SYSTEM_PROMPT, /every="day", "weekday"/);
});

// ---------- 5. the panel's routes ----------

test("panel: GET shows lists and tasks to a signed-in owner; on a computer an item or task is ticked or removed with the cookie and the header", async () => {
  const lists = createLists(memKv(), () => T0);
  await lists.add("compra", ["leche", "pan"], T0);
  const { task } = await lists.addTask("llamar al banco", "2026-11-20", T0);
  const serve = async (local: boolean) => {
    const app = express();
    mountTasksPanel(app, { signedIn: (req) => req.get("cookie") === "pako=ok", lists, local, timeZone: TZ, now: () => T0 });
    const server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown, headers: Record<string, string> = { cookie: "pako=ok", "x-pako": "1" }) =>
      fetch(`${base}/panel/api/tasks/${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { base, post, close: () => { server.close(); server.closeAllConnections(); } };
  };
  const pc = await serve(true);
  try {
    assert.equal((await fetch(`${pc.base}/panel/api/tasks`)).status, 401);
    const got = (await (await fetch(`${pc.base}/panel/api/tasks`, { headers: { cookie: "pako=ok" } })).json()) as Body;
    assert.equal(got.edit, true);
    assert.equal(got.today, "2026-11-14");
    assert.deepEqual(got.lists[0].items.map((x: Body) => x.text), ["leche", "pan"]);
    const milk = got.lists[0].items[0].id as string;
    assert.equal((await pc.post("item", { list: "compra", id: milk, done: true }, { cookie: "pako=ok" })).status, 401, "no header");
    assert.equal((await pc.post("item", { list: "compra", id: milk, done: true }, { "x-pako": "1" })).status, 401, "no cookie");
    assert.equal((await pc.post("item", { list: "compra", id: milk, done: true })).status, 200);
    assert.equal((await lists.read()).lists[0]!.items[0]!.done, true);
    assert.equal((await pc.post("item", { list: "compra", id: milk, remove: true })).status, 200);
    assert.deepEqual((await lists.read()).lists[0]!.items.map((x) => x.text), ["pan"]);
    assert.equal((await pc.post("item", { list: "compra", id: "0123456789", remove: true })).status, 404);
    assert.equal((await pc.post("item", { list: "compra", id: "<script>", done: true })).status, 400);
    assert.equal((await pc.post("task", { id: task!.id, done: true })).status, 200);
    assert.ok((await lists.read()).tasks[0]!.done);
    assert.equal((await pc.post("task", { id: task!.id, remove: true })).status, 200);
    assert.deepEqual((await lists.read()).tasks, []);
  } finally {
    pc.close();
  }
  const server = await serve(false);
  try {
    const got = (await (await fetch(`${server.base}/panel/api/tasks`, { headers: { cookie: "pako=ok" } })).json()) as Body;
    assert.equal(got.edit, false);
    assert.equal((await server.post("item", { list: "compra", id: "0123456789", remove: true })).status, 404, "a server's panel only shows them");
  } finally {
    server.close();
  }
});
