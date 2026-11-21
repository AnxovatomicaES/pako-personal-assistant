// The demo week (src/demo.ts): what the seed makes, that it lives apart from the person's data, that leaving deletes it, that nothing goes
// out while it runs, and the panel's banner. The real app in local mode, with a throwaway home and a stand-in fetch; nothing reaches the network.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp, loadAppConfig, type LocalContext } from "../src/app.ts";
import {
  DEMO_LOOP, DEMO_TEXTS, demoBlocks, demoDir, demoEnv, demoLeave, demoSender, demoStart, demoWanted, demoWeek, recordedAnswer, seedDemo,
} from "../src/demo.ts";
import type { Kv } from "../src/kv.ts";
import { createLocalChannel, loadHome, localEnv } from "../src/local.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "pako-demo-"));
const TZ = "Europe/London";

function memoryKv(): Kv & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: async (k) => map.get(k) ?? null, set: async (k, v) => void map.set(k, v) };
}

test("the demo week: twelve people, a calendar with changes overnight, mail, Slack and follow-ups in every state", () => {
  const now = Date.UTC(2026, 10, 19, 9, 0);
  const w = demoWeek(now, TZ);
  assert.equal(w.people.length, 12);
  assert.ok(w.people.every((p) => p.relation), "each person has a relation");
  assert.ok(w.people.filter((p) => p.birthday).length >= 2, "birthdays");
  // Invented addresses only, on example domains.
  for (const a of [...w.people.map((p) => p.email), w.owner.email]) {
    assert.match(a, /@([a-z-]+\.)?(example|example\.com|example\.org|example\.net)$/, a);
  }
  assert.ok(w.mail.length >= 6 && w.mail.length <= 8);
  assert.ok(w.mail.some((m) => m.category === "read_later" && /newsletter/i.test(m.why ?? "")), "a newsletter");
  assert.ok(w.mail.some((m) => m.repliedAt), "a mail the owner already answered");
  assert.deepEqual(w.changes.map((c) => c.kind).sort(), ["cancelled", "moved"]);
  assert.ok(!w.events.some((e) => e.id === "demo:lukas"), "the cancelled meeting is off the calendar");
  assert.ok(w.slack.some((s) => s.direct) && w.slack.some((s) => !s.direct));
  const states = new Set(w.loops.map((l) => l.status));
  for (const s of ["open", "snoozed", "done", "dismissed"]) assert.ok(states.has(s as never), s);
  const kinds = new Set(w.loops.map((l) => l.kind));
  for (const k of ["request_to_owner", "owner_promise", "other_promise", "agreed_meeting", "deadline"]) assert.ok(kinds.has(k as never), k);
  // Nothing in it checks a real service: every loop's check is none.
  assert.ok(w.loops.every((l) => "none" in l.check && l.nextCheckAt === 0));
});

test("today's meetings are placed around the start, so some are always ahead today", () => {
  const dayOf = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, dateStyle: "short" }).format(t);
  for (const hour of [7, 9, 12, 15, 18, 20]) {
    const now = Date.UTC(2026, 10, 19, hour, 7);
    const w = demoWeek(now, TZ);
    const today = w.events.filter((e) => !e.allDay && dayOf(e.start) === dayOf(now));
    assert.ok(today.some((e) => e.title === "Bluefin pilot review" && e.start > now), `${hour}:07 the review is ahead`);
    assert.ok(today.filter((e) => e.start > now).length >= 2, `${hour}:07 two meetings ahead`);
    // What the texts say is what the calendar holds.
    const at = (t: number) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(t);
    assert.equal(at(today.find((e) => e.title === "Bluefin pilot review")!.start), w.times.bluefin);
    assert.ok(w.mail.some((m) => m.subject.includes(w.times.bluefin)));
    assert.equal(w.changes.find((c) => c.kind === "moved")!.start, today.find((e) => e.title === "Bluefin pilot review")!.start);
  }
});

test("the dashboard's empty rule counts the agenda's events: a calendar with meetings is not an empty card", async () => {
  const model = (await import(new URL("../src/panel/dashboard-model.js", import.meta.url).href)) as { cardHasContent: (card: unknown) => boolean };
  const { cardHasContent } = model;
  const card = { querySelectorAll: (sel: string) => (sel.split(",").map((x) => x.trim()).includes(".tl-event") ? [1] : []) };
  assert.equal(cardHasContent(card as never), true);
});

test("seeding: the recorded brief with a draft and a meeting prep, the chat's card, a lesson; once only", async () => {
  const kv = memoryKv();
  const now = Date.now();
  assert.equal(await seedDemo(kv, { now, timeZone: TZ, name: "Alex" }), true);
  const brief = JSON.parse(kv.map.get("brief-v2")!) as { doc: { focus: unknown; todos: { loopId?: string }[]; updates: { tag: string }[] }; tasks: { kind: string; text: string }[] };
  assert.ok(brief.doc.focus, "a focus");
  assert.ok(brief.doc.todos.length >= 3);
  assert.ok(brief.doc.todos.some((t) => t.loopId === DEMO_LOOP.proposal));
  assert.ok(brief.doc.updates.some((u) => /overnight/i.test(u.tag)), "what changed overnight");
  assert.deepEqual(brief.tasks.map((t) => t.kind).sort(), ["do", "draft", "prep"]);
  assert.match(brief.tasks.find((t) => t.kind === "draft")!.text, /Priya/);
  const chat = JSON.parse(kv.map.get("pako-local-chat")!) as { text: string; buttons?: { id: string }[] }[];
  assert.equal(chat[0]!.text, DEMO_TEXTS.welcome);
  assert.ok(chat.some((m) => m.buttons?.some((b) => b.id === `f3:${DEMO_LOOP.mockups}`)), "a card with Not mine");
  assert.match(kv.map.get("lessons")!, /offsite/);
  assert.equal(JSON.parse(kv.map.get("assistant-people")!).length, 12);
  // A second start keeps what the person changed.
  kv.map.set("pako-local-chat", "[]");
  assert.equal(await seedDemo(kv, { now, timeZone: TZ, name: "Alex" }), false);
  assert.equal(kv.map.get("pako-local-chat"), "[]");
});

test("isolation: its own folder; leaving deletes only that folder; PAKO_DEMO, --demo and the mark turn it on", () => {
  const home = tmp();
  writeFileSync(join(home, "config.json"), JSON.stringify({ name: "Real", welcomed: true }));
  writeFileSync(join(home, "kv.db"), "real");
  assert.equal(demoWanted({}, [], home), false);
  assert.equal(demoWanted({ PAKO_DEMO: "1" }, [], home), true);
  assert.equal(demoWanted({}, ["node", "src/server.ts", "--demo"], home), true);
  demoStart(home, 1);
  assert.equal(demoDir(home), join(home, "demo"));
  assert.equal(demoWanted({}, [], home), true);
  writeFileSync(join(demoDir(home), "kv.db"), "demo");
  const userHome = tmp();
  const history = join(userHome, ".claude", "projects", join(demoDir(home), "assistant").replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(history, { recursive: true });
  demoLeave(home, userHome);
  assert.equal(existsSync(demoDir(home)), false);
  assert.equal(existsSync(history), false, "Claude Code's history of the demo's folder goes too");
  assert.equal(readFileSync(join(home, "kv.db"), "utf8"), "real");
  assert.equal(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).name, "Real");
  assert.equal(demoWanted({}, [], home), false);
});

test("demoEnv takes every connection's setting out, and keeps Pako's own", () => {
  const env: Record<string, string | undefined> = {
    PORT: "8787", PAKO_NAME: "Ana", SLACK_USER_TOKEN: "x", IMAP_PASSWORD: "x", RESEND_API_KEY: "x", TELEGRAM_BOT_TOKEN: "x",
    WHATSAPP_ACCESS_TOKEN: "x", CALENDAR_ICS_URL: "x", GOOGLE_REFRESH_TOKEN: "x", ZOOM_CLIENT_ID: "x", RETELL_API_KEY: "x", PUBLIC_URL: "x",
  };
  const gone = demoEnv(env);
  assert.equal(gone.length, 10);
  assert.deepEqual(Object.keys(env).filter((k) => env[k] !== undefined).sort(), ["BOOKING", "PAKO_DEMO", "PAKO_NAME", "PORT", "PROACTIVE"]);
  assert.equal(env.PROACTIVE, "off");
});

test("demoEnv leaves out this Mac's own mail and Messages too: the demo never reads the person's real ones", () => {
  const env: Record<string, string | undefined> = { PORT: "8787", APPLE_MAIL: "on", APPLE_MAIL_POLL_MINUTES: "5", IMESSAGE: "on", IMESSAGE_POLL_MINUTES: "5" };
  demoEnv(env);
  for (const k of ["APPLE_MAIL", "APPLE_MAIL_POLL_MINUTES", "IMESSAGE", "IMESSAGE_POLL_MINUTES"]) assert.equal(env[k], undefined, k);
});

test("demoEnv also turns off Mail and Messages on this Mac: the owner's real mail and chats never enter the invented week", () => {
  const env: Record<string, string | undefined> = { APPLE_MAIL: "on", APPLE_MAIL_POLL_MINUTES: "3", IMESSAGE: "on", IMESSAGE_POLL_MINUTES: "2" };
  assert.deepEqual(demoEnv(env), ["APPLE_MAIL", "APPLE_MAIL_POLL_MINUTES", "IMESSAGE", "IMESSAGE_POLL_MINUTES"]);
  assert.equal(env.APPLE_MAIL, undefined);
  assert.equal(env.IMESSAGE, undefined);
});

test("the routes the demo refuses: connecting, importing, the export", () => {
  assert.equal(demoBlocks("GET", "/panel/api/export"), true);
  assert.equal(demoBlocks("POST", "/panel/api/connections"), true);
  assert.equal(demoBlocks("POST", "/panel/api/telegram/token"), true);
  assert.equal(demoBlocks("POST", "/panel/api/mail/oauth/start"), true);
  assert.equal(demoBlocks("GET", "/panel/api/connections/status"), false);
  assert.equal(demoBlocks("POST", "/panel/api/chat"), false);
  assert.equal(demoBlocks("POST", "/panel/api/demo/leave"), false);
});

test("recorded answers without Claude", () => {
  assert.match(recordedAnswer("What did I promise Ana?"), /roadmap deck/);
  assert.match(recordedAnswer("what am I forgetting"), /Kenji/);
  assert.equal(recordedAnswer("tell me a joke"), DEMO_TEXTS.recordedNone);
});

test("a send in the demo says nothing was sent, and never fetches", async () => {
  const said: string[] = [];
  const real = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    throw new Error("no network in the demo");
  }) as typeof fetch;
  try {
    await demoSender(async (t) => void said.push(t))({ to: "priya.raman@bluefin.example", subject: "Pilot", text: "Hi" });
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(fetched, 0);
  assert.match(said[0]!, /^Demo: nothing was sent\./);
});

/** Pako in local mode with the demo on, as src/server.ts builds it: the demo's store seeded, a stand-in Claude that is not signed in. */
async function demoRig() {
  const root = tmp();
  const real = loadHome({ PAKO_HOME: root, PAKO_SECRET_STORE: "file" });
  demoStart(real.dir);
  const home = { ...real, dir: demoDir(real.dir), name: "Alex" };
  // As src/server.ts does: the connections out first, then local mode's own settings.
  const outer: Record<string, string | undefined> = { SLACK_USER_TOKEN: "xoxp-not-used", PERSONAL_TIMEZONE: TZ };
  demoEnv(outer);
  const env: Record<string, string | undefined> = { ...localEnv(outer, home, 0), PAKO_HOME: home.dir };
  const kv = memoryKv();
  await seedDemo(kv, { now: Date.now(), timeZone: TZ, name: "Alex" });
  const channel = createLocalChannel({ kv });
  const restarts: unknown[] = [];
  const local: LocalContext = {
    kv, channel, bridgeToken: real.bridgeToken, panelSecret: real.panelSecret, bridge: { status: () => ({ claude: "login", running: false }) },
    demo: { on: true, home: real.dir },
  };
  const app = createApp(loadAppConfig(env), env, local);
  app.locals.restart = (o: unknown) => void restarts.push(o ?? {});
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const link = (await (await fetch(`${base}/panel/api/link`, { method: "POST", headers: { authorization: `Bearer ${real.bridgeToken}` } })).json()) as { link: string };
  const login = await fetch(link.link.replace(/^http:\/\/127\.0\.0\.1:\d+/, base), { redirect: "manual" });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const get = (path: string) => fetch(`${base}${path}`, { headers: { cookie, "x-pako": "1" } });
  const post = (path: string, body: unknown = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { cookie, "x-pako": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
  return {
    root, real, kv, channel, base, get, post, restarts,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

test("the panel in the demo: banner, recorded answers, Done on a card, the export refused, and no request leaves this computer", async () => {
  const realFetch = globalThis.fetch;
  const outside: string[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      outside.push(url.href);
      return Promise.reject(new Error("no network in the demo"));
    }
    return realFetch(input, init);
  }) as typeof fetch;
  const r = await demoRig();
  try {
    const overview = (await (await r.get("/panel/api/overview")).json()) as {
      demo: { on: boolean; live: boolean }; loops: unknown[]; mail: { items: unknown[] }; slack: unknown[]; calendarOn: boolean; events: unknown[];
    };
    assert.deepEqual(overview.demo, { on: true, live: false });
    assert.ok(overview.loops.length >= 5 && overview.mail.items.length >= 6 && overview.slack.length >= 5 && overview.calendarOn);
    // Today's demo meetings are on the dashboard's agenda (and its "today's meetings" tile, which counts them).
    const dayOf = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, dateStyle: "short" }).format(t);
    const todays = (overview.events as { title: string; start: number; allDay: boolean }[]).filter((e) => !e.allDay && dayOf(e.start) === dayOf(Date.now()));
    for (const title of ["Bluefin pilot review", "Birthday drinks with Sofia"]) assert.ok(todays.some((e) => e.title === title), title);
    assert.ok(!todays.some((e) => /Lukas/.test(e.title)), "the cancelled coffee is not on it");
    assert.deepEqual(await (await r.get("/panel/api/demo")).json(), { on: true, live: false });
    // The banner is on the page; the page shows it from the overview's demo.on.
    const html = await (await r.get("/panel")).text();
    assert.match(html, /id="demo-banner"/);
    assert.match(html, /data-i18n="demo.leave"/);
    const js = await (await r.get("/panel/assets/app.js")).text();
    assert.match(js, /\$\("#demo-banner"\)\.hidden = !d\?\.on/);
    // Without Claude, the chat answers from what was recorded.
    await r.post("/panel/api/chat", { text: "What did I promise Ana?" });
    const after = await r.channel.list(0);
    assert.match(after.at(-1)!.text, /roadmap deck[\s\S]*Connect Claude to see it live/);
    // Done on the card closes the follow-up.
    await r.post("/panel/api/chat/press", { id: `f1:${DEMO_LOOP.mockups}` });
    for (let i = 0; i < 100 && !/Done: /.test((await r.channel.list(0)).at(-1)!.text); i++) await new Promise((x) => setTimeout(x, 20));
    assert.match((await r.channel.list(0)).at(-1)!.text, /Review Tomás's onboarding mockups/);
    const loops = JSON.parse((await r.kv.get("followups"))!).loops as { id: string; status: string }[];
    assert.equal(loops.find((l) => l.id === DEMO_LOOP.mockups)!.status, "done");
    // The brief page has today's recorded brief.
    const today = (await (await r.get("/panel/api/brief/today")).json()) as { doc: { todos: unknown[] } | null; tasks: { kind: string }[] };
    assert.ok(today.doc && today.doc.todos.length >= 3);
    assert.ok(today.tasks.some((t) => t.kind === "draft"));
    // Nothing of the person's to export; no account to connect.
    const exp = await r.get("/panel/api/export");
    assert.equal(exp.status, 409);
    assert.match(((await exp.json()) as { error: string }).error, /nothing of yours/);
    assert.equal((await r.post("/panel/api/connections", { values: { SLACK_USER_TOKEN: "x" } })).status, 409);
    assert.deepEqual(outside, [], "no request left this computer");
  } finally {
    globalThis.fetch = realFetch;
    r.close();
  }
});

test("delete everything in the demo is refused: it would empty the demo's folder only and say the person's data was gone", async () => {
  const r = await demoRig();
  try {
    writeFileSync(join(r.real.dir, "config.json"), JSON.stringify({ name: "Ana", welcomed: true }));
    assert.equal(demoBlocks("POST", "/panel/api/delete-all"), true);
    // As Express routes it: any case of letters, a slash at the end.
    assert.equal(demoBlocks("POST", "/PANEL/api/Delete-All/"), true);
    assert.equal(demoBlocks("GET", "/panel/api/EXPORT"), true);
    assert.equal(demoBlocks("POST", "/panel/api/Connections"), true);
    const res = await r.post("/panel/api/delete-all", { confirm: "DELETE EVERYTHING" });
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /Leave the demo first/);
    assert.deepEqual(JSON.parse(readFileSync(join(r.real.dir, "config.json"), "utf8")), { name: "Ana", welcomed: true });
    assert.ok((await r.kv.get("followups")) !== null, "the demo's store is not emptied either");
    assert.deepEqual(r.restarts, []);
  } finally {
    r.close();
  }
});

test("leaving the demo deletes its folder and restarts Pako, not forced into the demo again", async () => {
  const r = await demoRig();
  try {
    assert.ok(existsSync(demoDir(r.real.dir)));
    const res = await r.post("/panel/api/demo/leave");
    assert.deepEqual(await res.json(), { ok: true, restarting: true });
    assert.equal(existsSync(demoDir(r.real.dir)), false);
    for (let i = 0; i < 100 && !r.restarts.length; i++) await new Promise((x) => setTimeout(x, 20));
    assert.deepEqual(r.restarts, [{ leaving: true }]);
    assert.ok(existsSync(join(r.real.dir, "secrets.json")), "the real folder stays");
  } finally {
    r.close();
  }
});

test("the welcome, Settings and the Mac app offer the demo", () => {
  const html = readFileSync(new URL("../src/panel/index.html", import.meta.url), "utf8");
  assert.match(html, /data-step="start"[\s\S]*id="w-demo"[\s\S]*id="w-own"/);
  const settings = readFileSync(new URL("../src/panel/settings.html", import.meta.url), "utf8");
  assert.match(settings, /data-mount="demo"/);
  const swift = readFileSync(new URL("../desktop/mac/Connect.swift", import.meta.url), "utf8");
  assert.match(swift, /demo\.title = t\.tryDemo/);
  const app = readFileSync(new URL("../desktop/mac/App.swift", import.meta.url), "utf8");
  assert.match(app, /window\.pakoTryDemo/);
});

test("the demo needs no Claude plan and no sign-in: recorded answers say they are recorded, and the README and site say no plan is needed", () => {
  // Not live (no Claude signed in): every chat answer ends with the label, and a question it has no recording for says so.
  for (const q of ["What did I promise Ana?", "what's on today?", "what am I forgetting?"]) assert.match(recordedAnswer(q), /Recorded demo answer/);
  assert.match(DEMO_TEXTS.recordedNone, /without Claude connected/);
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8").replace(/\s+/g, " ");
  assert.match(readme, /Try the demo \(no Claude plan needed\)/);
  assert.match(readme, /demo week runs with no Claude plan and no sign-in/);
  const site = readFileSync(new URL("../site/index.html", import.meta.url), "utf8").replace(/\s+/g, " ");
  assert.match(site, /No Claude plan or sign-in needed/);
});
