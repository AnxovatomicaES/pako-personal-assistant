// The daily brief (src/brief.ts): what it says with and without a calendar, reminders, mail and Slack, in both languages; when it comes (the
// owner's zone, the clock changes, a restart, a server asleep at the hour, never twice); that STOP does not hold it; BRIEF / RESUMEN and the
// panel's button.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import express from "express";
import { createApp, loadAppConfig, type LocalContext } from "../src/app.ts";
import { createBrief, loadBriefConfig, mountBriefPanel, type BriefDeps } from "../src/brief.ts";
import { createCalendar, loadCalendarConfig, type CalEvent } from "../src/calendar.ts";
import { createControl } from "../src/control.ts";
import type { Lang } from "../src/i18n.ts";
import type { Kv } from "../src/kv.ts";
import { createLists } from "../src/lists.ts";
import { createLocalChannel, loadHome, localEnv } from "../src/local.ts";
import { sqliteKv } from "../src/sqlite-kv.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";
import { loadWhatsappConfig, mountWhatsapp, type TelegramDoor } from "../src/whatsapp.ts";

const MADRID = "Europe/Madrid";
/** Sunday 15 November 2026, 08:00 in Madrid (07:00 UTC). */
const EIGHT = Date.parse("2026-11-15T07:00:00Z");
const MIN = 60_000;
const HOUR = 3600_000;

function memKv(fail: { get?: boolean; set?: boolean } = {}): Kv & { m: Map<string, string>; fail: typeof fail } {
  const m = new Map<string, string>();
  return {
    m,
    fail,
    get: async (k) => {
      if (fail.get) throw new Error("store down");
      return m.get(k) ?? null;
    },
    set: async (k, v) => {
      if (fail.set) throw new Error("store down");
      m.set(k, v);
    },
  };
}

const at = (iso: string): number => Date.parse(iso);
const ev = (id: string, title: string, start: string, end: string, more: Partial<CalEvent> = {}): CalEvent => ({
  id, title, start: at(start), end: at(end), allDay: false, calendar: "", ...more,
});

/** Zoho's day for Madrid, and a second calendar (an ICS link, say) with one more event. */
const ZOHO_DAY: CalEvent[] = [
  ev("e1", "Comité", "2026-11-15T09:00:00Z", "2026-11-15T10:00:00Z", { location: "Sala 2" }),
  ev("e2", "Llamada con Ana", "2026-11-15T09:30:00Z", "2026-11-15T10:30:00Z", { join: "https://us06web.zoom.us/j/81234567890?pwd=abc" }),
  ev("e3", "Viaje", "2026-11-14T23:00:00Z", "2026-11-15T23:00:00Z", { allDay: true }),
];
const OTHER_DAY: CalEvent[] = [ev("g1", "Gimnasio", "2026-11-15T17:00:00Z", "2026-11-15T18:00:00Z")];

function rig(o: Partial<BriefDeps> & { start?: number } = {}) {
  const told: string[] = [];
  const clock = { now: o.start ?? EIGHT };
  const control = o.control ?? createControl(null);
  const deps: BriefDeps = {
    at: 8 * 60,
    kv: null,
    timeZone: MADRID,
    notify: async (t) => void told.push(t),
    control,
    now: () => clock.now,
    ...o,
  };
  return { brief: createBrief(deps), told, clock, control, deps };
}

const quiet = async <R>(fn: () => Promise<R>): Promise<R> => {
  const keep = console.error;
  console.error = () => undefined;
  try {
    return await fn();
  } finally {
    console.error = keep;
  }
};

test("loadBriefConfig: 08:00 by default, off, another hour; a wrong value is named and turns the scheduled brief off", () => {
  assert.deepEqual(loadBriefConfig({}), { at: 480, problems: [] });
  assert.deepEqual(loadBriefConfig({ MORNING_BRIEF: "off" }), { at: null, problems: [] });
  assert.deepEqual(loadBriefConfig({ MORNING_BRIEF: " OFF " }), { at: null, problems: [] });
  assert.deepEqual(loadBriefConfig({ MORNING_BRIEF: "7:30" }), { at: 450, problems: [] });
  const wrong = loadBriefConfig({ MORNING_BRIEF: "8am" });
  assert.equal(wrong.at, null);
  assert.match(wrong.problems.join(), /MORNING_BRIEF must be like 08:00, or off/);
  assert.match(loadBriefConfig({ MORNING_BRIEF: "24:00" }).problems.join(), /MORNING_BRIEF/);
});

test("nothing connected and nothing due: two lines, not silence, in English, with the name when there is one", async () => {
  const named = rig({ name: () => "Marta" });
  assert.equal(await named.brief.compose(EIGHT), "☀️ Good morning, Marta. Today is Sunday 15 November.\nAnything you'd like me to look into or help with today? Just ask.");
  const en = rig({ name: () => "" });
  assert.equal(await en.brief.compose(EIGHT), "☀️ Good morning. Today is Sunday 15 November.\nAnything you'd like me to look into or help with today? Just ask.");
  // Reminders on, none today (one tomorrow, one held from yesterday), mail and Slack on with nothing: still the two lines.
  const empty = rig({
    reminders: async () => [{ at: at("2026-11-16T09:00:00Z"), text: "mañana", held: false }, { at: EIGHT - 20 * HOUR, text: "ayer", held: true }],
    extras: [async () => null, async () => null],
  });
  assert.equal((await empty.brief.compose(EIGHT)).split("\n").length, 2);
});

test("everything connected: every calendar's events with overlaps and join links, today's reminders still to come, mail and Slack, the question", async () => {
  const reminders = async () => [
    { at: at("2026-11-15T14:00:00Z"), text: "Llamar a mamá", held: false },
    { at: at("2026-11-15T06:00:00Z"), text: "ya pasó", held: false },
    { at: at("2026-11-16T08:00:00Z"), text: "mañana", held: false },
  ];
  const deps: Partial<BriefDeps> = {
    name: () => "Marta",
    calendars: [async () => ZOHO_DAY, async () => [...OTHER_DAY, ev("x", "Mañana", "2026-11-16T09:00:00Z", "2026-11-16T10:00:00Z")]],
    reminders,
    extras: [async () => "📧 Email (24 h): 3, I told you about 1. Type MAIL to see them.", async () => "💬 Slack (24 h): 2 message(s) for you. Type SLACK."],
  };
  const es = rig(deps);
  assert.equal(
    await es.brief.compose(EIGHT),
    [
      "☀️ Good morning, Marta. Today is Sunday 15 November.",
      "",
      "📅 On your calendar today:",
      "• all day Viaje",
      "• 10:00–11:00 Comité (Sala 2) ⚠️ overlaps Llamada con Ana by 30 min",
      "• 10:30–11:30 Llamada con Ana ⚠️ overlaps Comité by 30 min",
      "  🎥 https://us06web.zoom.us/j/81234567890?pwd=abc",
      "• 18:00–19:00 Gimnasio",
      "",
      "⏰ Reminders for today:",
      "• 15:00 Llamar a mamá",
      "",
      "📧 Email (24 h): 3, I told you about 1. Type MAIL to see them.",
      "💬 Slack (24 h): 2 message(s) for you. Type SLACK.",
      "",
      "Anything you'd like me to look into or help with today? Just ask.",
    ].join("\n"),
  );
  const en = rig({ ...deps, extras: [async () => "📧 Email (24 h): 3, I told you about 1. Type MAIL to see them."] });
  assert.equal(
    await en.brief.compose(EIGHT),
    [
      "☀️ Good morning, Marta. Today is Sunday 15 November.",
      "",
      "📅 On your calendar today:",
      "• all day Viaje",
      "• 10:00–11:00 Comité (Sala 2) ⚠️ overlaps Llamada con Ana by 30 min",
      "• 10:30–11:30 Llamada con Ana ⚠️ overlaps Comité by 30 min",
      "  🎥 https://us06web.zoom.us/j/81234567890?pwd=abc",
      "• 18:00–19:00 Gimnasio",
      "",
      "⏰ Reminders for today:",
      "• 15:00 Llamar a mamá",
      "",
      "📧 Email (24 h): 3, I told you about 1. Type MAIL to see them.",
      "",
      "Anything you'd like me to look into or help with today? Just ask.",
    ].join("\n"),
  );
  // Asked in the evening: the greeting says so, and a meeting that is over has no link any more.
  const evening = await es.brief.compose(at("2026-11-15T20:30:00Z"));
  assert.match(evening, /^🌙 Good evening, Marta\./);
  assert.doesNotMatch(evening, /🎥/);
  assert.doesNotMatch(evening, /Llamar a mamá/, "a reminder already given is not 'for today' any more");
  assert.match(await en.brief.compose(at("2026-11-15T14:00:00Z")), /^👋 Good afternoon, Marta\./);
});

test("a calendar that cannot be read is said; one of two unread says something may be missing; an empty day says so; a busy day is cut", async () => {
  await quiet(async () => {
    const down = rig({ calendars: [async () => Promise.reject(new Error("Zoho down"))] });
    assert.match(await down.brief.compose(EIGHT), /\n\n📅 I couldn't read your calendar right now\.\n\n/);
    const half = rig({ calendars: [async () => ZOHO_DAY, async () => Promise.reject(new Error("ICS down"))] });
    assert.match(await half.brief.compose(EIGHT), /• 18:00|• 10:30–11:30 Llamada con Ana ⚠️ overlaps Comité by 30 min\n {2}🎥 \S+\n\(I couldn't read all your calendars: something may be missing\.\)/);
  });
  const none = rig({ calendars: [async () => []] });
  assert.match(await none.brief.compose(EIGHT), /\n\n📅 Nothing on your calendar today\.\n\n/);
  // One calendar made of two sources (Zoho and an ICS link) where one could not be read: the empty day says something may be missing.
  const merged = rig({ calendars: [async () => ({ events: [], partial: true })] });
  assert.match(await merged.brief.compose(EIGHT), /\n\n📅 Nothing on your calendar today\.\n\(I couldn't read all your calendars: something may be missing\.\)\n\n/);
  const whole = rig({ calendars: [async () => ({ events: ZOHO_DAY, partial: false })] });
  assert.doesNotMatch(await whole.brief.compose(EIGHT), /I couldn't/);
  const busy = Array.from({ length: 20 }, (_, i) => ev(`b${i}`, `Reunión ${i}`, new Date(EIGHT + i * 30 * MIN).toISOString(), new Date(EIGHT + i * 30 * MIN + 20 * MIN).toISOString()));
  const full = await rig({ calendars: [async () => busy] }).brief.compose(EIGHT);
  assert.equal((full.match(/^• /gm) ?? []).length, 15);
  assert.match(full, /\n…and 5 more\n/);
  // Reminders that cannot be read: the rest of the brief still comes.
  const noRem = await quiet(() => rig({ reminders: async () => Promise.reject(new Error("store down")) }).brief.compose(EIGHT));
  assert.equal(noRem.split("\n").length, 2);
});

test("when: from the hour, once a day; a restart does not repeat it; asleep at 08:00 it catches up until noon; the next day it comes again", async () => {
  const kv = memKv();
  const r = rig({ kv });
  r.clock.now = EIGHT - MIN; // 07:59
  assert.equal(await r.brief.tick(), false, "not before the hour");
  r.clock.now = EIGHT;
  assert.equal(await r.brief.tick(), true);
  assert.equal(r.told.length, 1);
  r.clock.now = EIGHT + 5 * MIN;
  assert.equal(await r.brief.tick(), false, "never twice a day");
  assert.equal(JSON.parse(kv.m.get("brief-state")!).day, "2026-11-15", "the day is kept in the store");
  const restarted = rig({ kv, start: EIGHT + 10 * MIN });
  assert.equal(await restarted.brief.tick(), false, "a restart keeps it");
  assert.deepEqual(restarted.told, []);

  // A server asleep at 08:00 that wakes at 11:59 still gives it; one waking at noon does not (it is no longer a morning brief).
  const late = rig({ kv: memKv(), start: at("2026-11-15T10:59:00Z") });
  assert.equal(await late.brief.tick(), true);
  const tooLate = rig({ kv: memKv(), start: at("2026-11-15T11:00:00Z") });
  assert.equal(await tooLate.brief.tick(), false);

  r.clock.now = EIGHT + 24 * HOUR; // Monday 08:00
  assert.equal(await r.brief.tick(), true, "the next day");
  assert.match(r.told[1]!, /Today is Monday 16 November/);
  assert.deepEqual((await r.control.recent(10)).map((l) => [l.kind, l.text]), [["brief", "Daily brief sent"], ["brief", "Daily brief sent"]]);

  // Off: never by itself (on demand only). An hour set at noon or later catches up for four hours.
  const off = rig({ at: null, start: EIGHT });
  assert.equal(await off.brief.tick(), false);
  const afternoon = rig({ at: 13 * 60, start: at("2026-11-15T15:59:00Z") }); // 16:59
  assert.equal(await afternoon.brief.tick(), true);
  const afternoonLate = rig({ at: 13 * 60, start: at("2026-11-15T16:00:00Z") }); // 17:00
  assert.equal(await afternoonLate.brief.tick(), false);
});

test("the owner's zone, and the days the clocks change: 08:00 local, wherever and whenever that is", async () => {
  // 07:00 UTC is 08:00 in Madrid but 02:00 in New York: there it waits for New York's own 08:00 (13:00 UTC in November).
  const ny = rig({ timeZone: "America/New_York", start: EIGHT });
  assert.equal(await ny.brief.tick(), false);
  ny.clock.now = at("2026-11-15T13:00:00Z");
  assert.equal(await ny.brief.tick(), true);
  assert.match(ny.told[0]!, /Today is Sunday 15 November/);

  // 29 March 2026: Madrid moves from 02:00 to 03:00. 08:00 that day is 06:00 UTC, not 07:00.
  const spring = rig({ start: at("2026-03-29T05:59:00Z") });
  assert.equal(await spring.brief.tick(), false);
  spring.clock.now = at("2026-03-29T06:00:00Z");
  assert.equal(await spring.brief.tick(), true);
  // A brief set in the hour that does not exist that day (02:30) comes at 03:00, once.
  const gap = rig({ at: 2 * 60 + 30, start: at("2026-03-29T00:59:00Z") }); // 01:59
  assert.equal(await gap.brief.tick(), false);
  gap.clock.now = at("2026-03-29T01:00:00Z"); // 03:00
  assert.equal(await gap.brief.tick(), true);
  // 25 October 2026: 02:30 happens twice in Madrid; the brief does not.
  const twice = rig({ at: 2 * 60 + 30, start: at("2026-10-25T00:30:00Z") }); // the first 02:30 (summer time)
  assert.equal(await twice.brief.tick(), true);
  twice.clock.now = at("2026-10-25T01:30:00Z"); // the second 02:30 (winter time)
  assert.equal(await twice.brief.tick(), false);
  // On a day of 25 hours, today's events are still today's: an event at 23:30 local is in, one at 00:30 the next day is not.
  const long = rig({
    start: at("2026-10-25T07:00:00Z"),
    calendars: [async () => [ev("late", "Tarde", "2026-10-25T22:30:00Z", "2026-10-25T22:45:00Z"), ev("next", "Siguiente", "2026-10-25T23:30:00Z", "2026-10-25T23:45:00Z")]],
  });
  const text = await long.brief.compose(at("2026-10-25T07:00:00Z"));
  assert.match(text, /• 23:30–23:45 Tarde/);
  assert.doesNotMatch(text, /Siguiente/);
});

test("the store: unreadable, the brief waits for it (never a guess that repeats one); unwritable, still once; the calendar's old day counts", async () => {
  const kv = memKv({ get: true });
  const r = rig({ kv });
  assert.equal(await quiet(() => r.brief.tick()), false, "the day cannot be read: no brief yet");
  kv.fail.get = false;
  r.clock.now += MIN;
  assert.equal(await r.brief.tick(), true, "the store answers again: it comes");

  const ro = memKv({ set: true });
  const w = rig({ kv: ro });
  assert.equal(await quiet(() => w.brief.tick()), true);
  w.clock.now += MIN;
  assert.equal(await w.brief.tick(), false, "kept in memory when the store refuses it");
  assert.equal(w.told.length, 1);

  // A server upgraded after this morning's brief (sent by the calendar, which kept briefDay) sends no second one.
  const old = memKv();
  old.m.set("calendar-state", JSON.stringify({ reminded: ["e1@1"], briefDay: "2026-11-15" }));
  const upgraded = rig({ kv: old, start: EIGHT + 30 * MIN });
  assert.equal(await upgraded.brief.tick(), false);
  upgraded.clock.now += 24 * HOUR;
  assert.equal(await upgraded.brief.tick(), true, "the next day as usual");
  assert.equal(JSON.parse(old.m.get("brief-state")!).day, "2026-11-16");
});

test("a deploy's overlap: the brief given by the other server just now (old: calendar-state, new: brief-state) is not given again", async () => {
  for (const [key, value] of [["calendar-state", { reminded: [], briefDay: "2026-11-15" }], ["brief-state", { day: "2026-11-15" }]] as const) {
    const kv = memKv();
    kv.m.set("brief-state", JSON.stringify({ day: "2026-11-14" }));
    const r = rig({ kv, start: EIGHT - 5 * MIN });
    assert.equal(await r.brief.tick(), false, "before the hour");
    // The other server gives it at the hour and keeps the day where it keeps it.
    kv.m.set(key, JSON.stringify(value));
    r.clock.now = EIGHT + 30_000;
    assert.equal(await r.brief.tick(), false, `${key}: not a second brief`);
    assert.equal(r.told.length, 0);
  }
});

test("two looks at once, or a look while the owner asks: one brief", async () => {
  const slow: string[] = [];
  const r = rig({ notify: async (t) => void (await sleep(30), slow.push(t)) });
  const [a, b] = await Promise.all([r.brief.tick(), r.brief.tick()]);
  assert.equal(Number(a) + Number(b), 1);
  assert.equal(slow.length, 1);

  const asked = rig({ start: EIGHT - 30 * MIN });
  const text = await asked.brief.now();
  assert.match(text, /^☀️ Good morning\. Today is Sunday/);
  assert.deepEqual((await asked.control.recent(5)).map((l) => l.text), ["Daily brief, asked for"]);
  asked.clock.now = EIGHT;
  assert.equal(await asked.brief.tick(), false, "the owner already read today's at 07:30: not again at 08:00");
  assert.equal(asked.told.length, 0);
  assert.match(await asked.brief.now(), /^☀️/, "asked again, it answers again");
});

test("with Zoho itself: today() feeds the brief, and its failure is said in the brief", async () => {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  const fake = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://accounts.zoho.eu/oauth/v2/token?")) return json({ access_token: "acc", refresh_token: "ref", expires_in: 3600 });
    if (url === "https://calendar.zoho.eu/api/v1/calendars") return json({ calendars: [{ uid: "c1", name: "Work" }] });
    if (url.startsWith("https://calendar.zoho.eu/api/v1/calendars/c1/events?")) {
      return json({
        events: [
          { uid: "z1", title: "Board", dateandtime: { start: "20261115T100000+0100", end: "20261115T110000+0100" }, description: "https://meet.google.com/abc-defg-hij" },
          { uid: "z2", title: "Trip", isallday: true, dateandtime: { start: "20261116", end: "20261117" } },
        ],
      });
    }
    return json({}, 404);
  }) as typeof fetch;
  const env = { ZOHO_CLIENT_ID: "1000.ABCDEFGHIJ1234567890", ZOHO_CLIENT_SECRET: "0123456789abcdef0123456789abcdef01234567", ZOHO_GRANT_CODE: "1000.grant.code" };
  const cal = createCalendar({ config: loadCalendarConfig(env).config!, kv: null, timeZone: MADRID, notify: async () => undefined, fetch: fake, now: () => EIGHT });
  const r = rig({ lang: () => "en", calendars: [() => cal.today()] });
  assert.equal(await r.brief.tick(), true);
  assert.match(r.told[0]!, /📅 On your calendar today:\n• 10:00–11:00 Board\n {2}🎥 https:\/\/meet\.google\.com\/abc-defg-hij\n\n/);
  assert.doesNotMatch(r.told[0]!, /Trip/, "tomorrow's trip is not today's");
});

// ---------- through the door: STOP, Telegram, WhatsApp's window and template, the command ----------

const OWNER = "+34600111222";
const WA_ENV = {
  WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
};
let n = 0;

function door(o: { env?: Record<string, string>; telegram?: TelegramDoor; lang?: Lang; brief?: () => Promise<string> } = {}) {
  const sent: Record<string, any>[] = [];
  const meta = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.body) sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out${sent.length}` }] }), { status: 200 });
  }) as typeof fetch;
  const clock = { now: EIGHT };
  const kv = memKv();
  const memory = loadMemory(kv);
  const control = createControl(kv, () => clock.now);
  const tools = loadVoiceTools({ memory, actions: { contacts: () => [], callContact: async () => ({ ok: true, text: "started" }), lookupCall: async () => "ok" } });
  const config = loadWhatsappConfig({ ...WA_ENV, ...(o.env ?? {}) }, OWNER).config!;
  const d = mountWhatsapp(express(), {
    config, tools, memory, kv, control, ownerName: "Marta", timeZone: MADRID, contacts: () => [], fetch: meta, now: () => clock.now,
    ...(o.telegram ? { telegram: o.telegram } : {}),
    ...(o.lang ? { lang: () => o.lang! } : {}),
    ...(o.brief ? { brief: { now: o.brief, daily: true } } : {}),
  });
  const say = (text: string) => d.ingest({ from: d.ownerFrom, id: `wamid.b${++n}`, timestamp: "1", type: "text", text: { body: text } });
  return { d, sent, clock, kv, control, say };
}

test("STOP does not hold it, it reaches the phone: WhatsApp inside the window, the template outside it, Telegram when paired", async () => {
  // Paused, inside WhatsApp's window: the brief still comes, as a plain message.
  const w = door();
  await w.say("STOP");
  assert.equal((await w.control.state()).paused !== null, true);
  const r = rig({ control: w.control, reminders: () => w.d.reminders(), notify: (t) => w.d.notifyOwner(t, { urgent: true }) });
  r.clock.now = w.clock.now = EIGHT + MIN;
  const before = w.sent.length;
  assert.equal(await r.brief.tick(), true);
  assert.match(String(w.sent.at(-1)?.text?.body), /^☀️ Good morning\. Today is Sunday 15 November\.\n/);
  assert.equal(w.sent.length, before + 1);

  // The owner has not written for two days, with the notice template: the template carries it (urgent always pings).
  const t = door({ env: { WHATSAPP_REMINDER_TEMPLATE: "pako_aviso" } });
  const rt = rig({ notify: (x) => t.d.notifyOwner(x, { urgent: true }) });
  assert.equal(await rt.brief.tick(), true);
  assert.equal(t.sent.at(-1)?.type, "template");
  assert.match(JSON.stringify(t.sent.at(-1)), /Good morning\. Today is Sunday 15 November\. Anything you'd like me to look into/);

  // Telegram paired and reachable: there.
  const tg: Record<string, any>[] = [];
  const telegram: TelegramDoor = {
    paired: async () => true, reachable: async () => true, deliver: async (b) => (tg.push(b), true), pairLink: async () => null,
    unpair: async () => true, farewell: async () => undefined, media: async () => null,
  };
  const g = door({ telegram });
  const rg = rig({ notify: (x) => g.d.notifyOwner(x, { urgent: true }) });
  assert.equal(await rg.brief.tick(), true);
  assert.match(String(tg.at(-1)?.text?.body), /^☀️ Good morning\. Today is Sunday 15 November\./);
  assert.equal(g.sent.length, 0, "nothing on WhatsApp");
});

test("BRIEF, in English words only and while paused; HELP names it; a door without it leaves the word to the assistant", async () => {
  const b = { brief: null as ReturnType<typeof createBrief> | null };
  const w = door({ brief: () => b.brief!.now() });
  b.brief = rig({ reminders: () => w.d.reminders(), notify: (t) => w.d.notifyOwner(t, { urgent: true }) }).brief;
  await w.say("STOP");
  for (const word of ["BRIEF", "brief", "Today's brief", "daily brief"]) {
    assert.equal(await w.say(word), "brief shown", word);
    assert.match(String(w.sent.at(-1)?.text?.body), /^☀️ Good morning\. Today is Sunday/);
  }
  assert.equal(await w.say("HELP"), "help shown");
  assert.match(String(w.sent.at(-1)?.text?.body), /\n• BRIEF: your daily brief \(I also send it every morning\)\n/);
  // The Spanish word is no command any more: it goes to the assistant, which answers in the owner's language.
  assert.equal(await w.say("RESUMEN"), "queued");
  const without = door();
  assert.equal(await without.say("BRIEF"), "queued");
});

test("the panel's button: POST /panel/api/brief for a signed-in browser with the header only", async () => {
  const app = express();
  let signed = true;
  mountBriefPanel(app, { signedIn: () => signed, brief: async () => "☀️ Good morning." });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/panel/api/brief`, { method: "POST" })).status, 401, "without the header another site could ask");
    const ok = await fetch(`${base}/panel/api/brief`, { method: "POST", headers: { "x-pako": "1" } });
    assert.deepEqual(await ok.json(), { text: "☀️ Good morning." });
    signed = false;
    assert.equal((await fetch(`${base}/panel/api/brief`, { method: "POST", headers: { "x-pako": "1" } })).status, 401);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("local mode end to end (src/app.ts): BRIEF in the panel's chat, the panel's button and its script, with nothing else connected", async () => {
  const home = loadHome({ PAKO_HOME: join(mkdtempSync(join(tmpdir(), "pako-brief-")), "home"), PAKO_NAME: "Ana" });
  const env: Record<string, string | undefined> = { ...localEnv({}, home, 0), PAKO_HOME: home.dir, PERSONAL_TIMEZONE: MADRID };
  const kv = sqliteKv(home.dir);
  const local: LocalContext = { kv, channel: createLocalChannel({ kv }), bridgeToken: home.bridgeToken, panelSecret: home.panelSecret, bridge: { status: () => ({ claude: "ok", running: true }) } };
  const keep = console.log;
  console.log = () => undefined;
  const app = createApp(loadAppConfig(env), env, local);
  console.log = keep;
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch((app.locals.panelLink as () => string)().replace(/^http:\/\/127\.0\.0\.1:\d+/, base), { redirect: "manual" });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const api = (path: string, body?: unknown) =>
      fetch(`${base}${path}`, { method: body ? "POST" : "GET", headers: { cookie, "x-pako": "1", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const button = (await (await api("/panel/api/brief", {})).json()) as { text: string };
    assert.match(button.text, /^(☀️ Good morning|👋 Good afternoon|🌙 Good evening), Ana\. Today is .+\.\nAnything you'd like me to look into/);
    assert.equal(button.text.split("\n").length, 2, "nothing connected here: the two lines");
    assert.equal((await api("/panel/api/chat", { text: "BRIEF" })).status, 202);
    let last = "";
    for (let i = 0; i < 200 && !/Today is/.test(last); i++) {
      await sleep(25);
      last = ((await (await api("/panel/api/chat?since=0")).json()) as { messages: { text: string }[] }).messages.at(-1)!.text;
    }
    assert.equal(last, button.text);
    const script = await fetch(`${base}/panel/assets/brief.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") ?? "", /javascript/);
    assert.match(await script.text(), /Today's brief/);
    assert.match(await (await api("/panel")).text(), /<script type="module" src="\/panel\/assets\/brief\.js"><\/script>/);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("Phase 2 together (src/app.ts): the brief says the ICS calendar's day and today's tasks; the calendar sends no brief of its own", async () => {
  const home = loadHome({ PAKO_HOME: join(mkdtempSync(join(tmpdir(), "pako-brief-")), "home"), PAKO_NAME: "Ana" });
  const link = "https://cal.example.test/private-abc/basic.ics";
  const env: Record<string, string | undefined> = { ...localEnv({}, home, 0), PAKO_HOME: home.dir, PERSONAL_TIMEZONE: MADRID, CALENDAR_ICS_URL: link };
  const kv = sqliteKv(home.dir);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: MADRID, year: "numeric", month: "2-digit", day: "2-digit" }).format(Date.now());
  const next = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10) + 1)).toISOString().slice(0, 10);
  await createLists(kv).addTask("Llamar al fontanero", day, Date.now());
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", "BEGIN:VEVENT", "UID:e1@test", `DTSTART;VALUE=DATE:${day.replaceAll("-", "")}`,
    `DTEND;VALUE=DATE:${next.replaceAll("-", "")}`, "SUMMARY:Cumpleaños de Luis", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://cal.example.test/")) return real(input, init);
    asked.push(url);
    return new Response(ics, { status: 200, headers: { "content-type": "text/calendar" } });
  }) as typeof fetch;
  // The feed's host is a test name: taken as public here (the hop checks themselves are in test/ssrf-redirects.test.ts).
  const local: LocalContext = {
    kv, channel: createLocalChannel({ kv }), bridgeToken: home.bridgeToken, panelSecret: home.panelSecret, bridge: { status: () => ({ claude: "ok", running: true }) },
    icsNet: { fetch: (input, init) => globalThis.fetch(input, init), resolve: async () => ["93.184.216.34"] },
  };
  const keep = console.log;
  console.log = () => undefined;
  const app = createApp(loadAppConfig(env), env, local);
  console.log = keep;
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await real((app.locals.panelLink as () => string)().replace(/^http:\/\/127\.0\.0\.1:\d+/, base), { redirect: "manual" });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const res = await real(`${base}/panel/api/brief`, { method: "POST", headers: { cookie, "x-pako": "1", "content-type": "application/json" }, body: "{}" });
    const text = ((await res.json()) as { text: string }).text;
    assert.match(text, /Cumpleaños de Luis/, "the ICS link's event");
    assert.match(text, /Llamar al fontanero/, "today's task");
    assert.equal(text.split("\n").filter((l) => /Cumpleaños de Luis/.test(l)).length, 1);
    assert.deepEqual(asked, [link]);
  } finally {
    globalThis.fetch = real;
    server.close();
    server.closeAllConnections();
  }
});
