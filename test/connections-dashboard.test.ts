// What the owner found testing the Mac app on a new Mac, and what came of it: the connections page names each account and its settings (never a
// secret), calendars add up and a private link is checked when added, invitations show at once (from the calendar and from the mail), the
// dashboard's refresh reads the calendars again, a new mailbox's last days are caught up quietly and paced, and the dashboard shows content
// only (the brief first, the three tiles, no channel cards, empty sections hidden, one health section).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createBackfill } from "../src/backfill.ts";
import { createCalendarCore, type CalEvent, type CalendarSource } from "../src/calendar.ts";
import { connectionDetails, mountConnectionDetails } from "../src/connections-details.ts";
import { createControl } from "../src/control.ts";
import { mountDashboard, REFRESH_EVERY_MS } from "../src/dashboard.ts";
import { checkIcsLink, createIcsSource, icsEvents, maskIcsUrl, parseFeed } from "../src/ics.ts";
import { createImapReader, type ImapClient } from "../src/imap.ts";
import { createInviteStore } from "../src/invites.ts";
import type { Kv } from "../src/kv.ts";
import { createMailbox } from "../src/mail.ts";
import { loadMemory } from "../src/voice-memory.ts";
import type { Inbound } from "../src/whatsapp.ts";

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const model = (await import(new URL("../src/panel/dashboard-model.js", import.meta.url).href)) as Record<string, (...a: any[]) => any>;
const HOUR = 3600_000;
const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 18, 9, 0, 0);
const ZONE = "Europe/Madrid";
const PUBLIC = async () => ["93.184.216.34"];

function memoryKv(): Kv & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v) };
}

const ics = (events: string[], name = "Work") =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", `X-WR-CALNAME:${name}`, ...events, "END:VCALENDAR"].join("\r\n");
const vevent = (o: { uid: string; title: string; start: string; end: string; extra?: string[] }) =>
  ["BEGIN:VEVENT", `UID:${o.uid}`, `DTSTAMP:20261101T000000Z`, `DTSTART:${o.start}`, `DTEND:${o.end}`, `SUMMARY:${o.title}`, ...(o.extra ?? []), "END:VEVENT"].join("\r\n");

// ---------- the connections page: identity and settings, never a secret ----------

test("details: every connection's identity and settings come out, and no token, password, key or private link ever does", async () => {
  const SECRETS = {
    IMAP_PASSWORD: "imap-secret-pass-4242",
    SLACK_USER_TOKEN: "xoxp-1111-2222-secret-user-token",
    SLACK_APP_TOKEN: "xapp-1-secret-app-token-9999",
    SLACK_SIGNING_SECRET: "slack-signing-secret-abcdef",
    ZOOM_CLIENT_SECRET: "zoom-client-secret-777",
    ZOOM_CLIENT_ID: "zoom-client-id-secretish",
    ANTHROPIC_API_KEY: "sk-ant-api03-secret-key-material-0000",
    GOOGLE_PLACES_API_KEY: "AIzaSySecretPlacesKey000000000000000000",
    TELEGRAM_BOT_TOKEN: "123456:telegram-secret-token",
    WHATSAPP_ACCESS_TOKEN: "EAAG-whatsapp-secret-token",
    PERSONAL_CALLER_TOKEN: "caller-secret-token-555",
    AGENTMAIL_API_KEY: "am_secret_agentmail_key",
  };
  const link = "https://calendar.google.com/calendar/ical/ana%40example.com/private-0123456789abcdefsecret/basic.ics";
  const env = {
    ...SECRETS, IMAP_HOST: "imap.example.com", IMAP_USER: "ana@example.com", CALENDAR_ICS_URL: link, ZOOM_USER: "ana@zoom.example",
    WHATSAPP_PHONE_NUMBER_ID: "1234567890", PERSONAL_OWNER_NUMBER: "+447700901222", WHATSAPP_TEMPLATE_NAME: "pako_notice",
    AGENTMAIL_INBOX: "pako@agentmail.to",
  };
  const source = createIcsSource({ config: { urls: [link] }, timeZone: ZONE, resolve: PUBLIC, fetch: (async () => new Response(ics([]))) as typeof fetch });
  const d = await connectionDetails({
    signedIn: () => true, env, lang: () => "en", dir: "/nonexistent", timeZone: ZONE,
    imap: () => ({ address: "ana@example.com", host: "imap.example.com", port: 993, folders: ["INBOX"], pollMinutes: 5, lastCheck: NOW, readToday: 7, lastError: null }),
    ics: () => source.status(),
    slack: async () => ({ workspace: "Acme", user: "ana", lastSeen: NOW }),
    zoom: async () => ({ topic: "Weekly sync", at: NOW }),
    telegram: async () => ({ bot: "pako_ana_bot", owner: "Ana (@ana)", paired: true }),
  });
  const out = JSON.stringify(d);
  for (const [key, secret] of Object.entries(SECRETS)) assert.ok(!out.includes(secret), `${key} never comes out`);
  assert.ok(!out.includes("private-0123456789abcdefsecret") && !out.includes(link), "the private link's secret part never comes out");
  assert.match(out, /calendar\.google\.com/, "the link's host does");
  const m = d.mail as { imap: { address: string; host: string; folders: string[]; readToday: number } };
  assert.deepEqual([m.imap.address, m.imap.host, m.imap.folders, m.imap.readToday], ["ana@example.com", "imap.example.com", ["INBOX"], 7]);
  assert.deepEqual(d.slack, { workspace: "Acme", user: "ana", socketMode: true, lastSeen: NOW, watches: "Direct messages, group DMs and mentions in channels" });
  assert.deepEqual(d.zoom, { account: "ana@zoom.example", lastMeeting: { topic: "Weekly sync", at: NOW } });
  assert.deepEqual(d.telegram, { bot: "@pako_ana_bot", owner: "Ana (@ana)", paired: true });
  assert.deepEqual(d.whatsapp, { number: "•••• 1222", template: "pako_notice", language: "en" }, "an unset WHATSAPP_TEMPLATE_LANG shows en, the default");
  assert.equal(maskIcsUrl(link).includes("secret"), false);
});

// ---------- calendars: both sources, the add check, a link breaking later ----------

test("calendars: this Mac's calendar and a private link are read together, the same meeting once (by UID, else title within a minute)", async () => {
  const at = (h: number) => NOW + h * HOUR;
  const ev = (o: Partial<CalEvent> & { id: string; title: string; start: number }): CalEvent => ({ end: o.start + HOUR, allDay: false, calendar: "x", ...o });
  const mac: CalendarSource = { label: "Mac", events: async () => ({ events: [
    ev({ id: "mac:1", uid: "abc@google.com", title: "Budget review", start: at(2) }),
    ev({ id: "mac:2", title: "Dentist", start: at(5) }),
    ev({ id: "mac:3", title: "Only on the Mac", start: at(7) }),
  ], partial: false }) };
  const link: CalendarSource = { label: "ICS", events: async () => ({ events: [
    ev({ id: "ics:1", uid: "abc@google.com", title: "Budget review (renamed)", start: at(2), join: "https://meet.google.com/x" }),
    ev({ id: "ics:2", title: "dentist", start: at(5) + 30_000 }),
    ev({ id: "ics:3", title: "Only on the link", start: at(9) }),
    ev({ id: "ics:4", title: "Declined lunch", start: at(3), response: "declined" }),
  ], partial: false }) };
  const core = createCalendarCore({ sources: [mac, link], timing: { remindMinutes: 0 } as never, kv: null, timeZone: ZONE, now: () => NOW, notify: async () => undefined });
  const events = await core.load();
  assert.deepEqual(events.map((e) => e.title), ["Budget review", "Dentist", "Only on the Mac", "Only on the link"]);
  assert.equal(events[0]!.join, "https://meet.google.com/x", "the call's link either copy has");
});

test("adding a private link: a good one says how many events; a 404, an HTML page and a timeout each give their reason (and where the right link is)", async () => {
  const good = ics([vevent({ uid: "1", title: "A", start: "20261119T100000Z", end: "20261119T110000Z" }), vevent({ uid: "2", title: "B", start: "20261125T100000Z", end: "20261125T110000Z" })], "Ana's work");
  const answer = (r: Response | "hang") => (async (_u: unknown, init?: RequestInit) => {
    if (r !== "hang") return r;
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  }) as typeof fetch;
  const o = (f: typeof fetch) => ({ timeZone: ZONE, resolve: PUBLIC, fetch: f, now: () => NOW, timeoutMs: 200 });
  const ok = await checkIcsLink("https://calendar.example.com/me/basic.ics", o(answer(new Response(good))));
  assert.deepEqual(ok, { ok: true, name: "Ana's work", host: "calendar.example.com", events: 2 });
  const missing = await checkIcsLink("https://calendar.example.com/gone.ics", o(answer(new Response("no", { status: 404 }))));
  assert.equal(missing.ok === false && missing.why, "notFound");
  const page = await checkIcsLink("https://calendar.google.com/calendar/u/0/r", o(answer(new Response("<html><body>Sign in</body></html>"))));
  assert.equal(page.ok === false && page.why, "notCalendar");
  assert.equal(page.ok === false && page.provider, "google", "Google's page: the place of its secret iCal address is said");
  // AbortSignal.timeout does not hold the process open by itself: a timer here does, as a server's open socket would.
  const awake = setInterval(() => undefined, 50);
  const slow = await checkIcsLink("https://calendar.example.com/slow.ics", o(answer("hang"))).finally(() => clearInterval(awake));
  assert.equal(slow.ok === false && slow.why, "timeout");

  // Through the route: the owner's words, and the help for a known service.
  const app = express();
  const saved: string[] = [];
  mountConnectionDetails(app, {
    signedIn: () => true, env: {}, lang: () => "en", dir: "/nonexistent", timeZone: ZONE, now: () => NOW,
    icsNet: { resolve: PUBLIC, fetch: (async (u: string | URL) => (String(u).includes("google") ? new Response("<html>Sign in</html>") : new Response(good))) as typeof fetch },
    saver: { save: async (_id, v) => (saved.push(v.CALENDAR_ICS_URL ?? ""), { ok: true, name: "Calendar" }), restartAfter: () => false },
  });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-pako": "1" }, body: JSON.stringify(body) });
  try {
    const works = await (await post("/panel/api/calendar/links/check", { url: "https://cal.example.com/a.ics" })).json() as { message: string };
    assert.equal(works.message, "Works: Ana's work, 2 events in the next 30 days.");
    const bad = await post("/panel/api/calendar/links", { url: "https://calendar.google.com/calendar/r" });
    assert.equal(bad.status, 400);
    const said = await bad.json() as { error: string; help: string };
    assert.match(said.error, /web page, not a calendar/);
    assert.match(said.help, /Secret address in iCal format/);
    assert.deepEqual(saved, [], "a link that does not work is not kept");
    assert.equal((await post("/panel/api/calendar/links", { url: "https://calendar.google.com/calendar/r", anyway: true })).status, 200, "unless the owner says so");
    assert.equal((await post("/panel/api/calendar/links", { url: "https://cal.example.com/a.ics" })).status, 200);
    assert.equal(saved.length, 2);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("a private link that breaks later shows on its row (and once in the brief), and clears when it is read again", async () => {
  let status = 200;
  const clock = { now: NOW };
  const source = createIcsSource({
    config: { urls: ["https://cal.example.com/me.ics"] }, timeZone: ZONE, resolve: PUBLIC, now: () => clock.now, log: () => undefined,
    fetch: (async () => (status === 200 ? new Response(ics([vevent({ uid: "1", title: "A", start: "20261118T100000Z", end: "20261118T110000Z" })])) : new Response("", { status }))) as typeof fetch,
  });
  await source.events();
  assert.equal(source.status()[0]!.error, null);
  assert.equal(source.status()[0]!.lastSync, NOW);
  status = 404;
  clock.now += 11 * MIN;
  await source.events();
  const row = source.status()[0]!;
  assert.equal(row.error, "notFound");
  assert.equal(row.lastSync, NOW, "the last good read stays");
  assert.match(source.brokenNews("en") ?? "", /stopped working: Not found \(404\)/);
  assert.equal(source.brokenNews("en"), null, "said once in the brief");
  status = 200;
  clock.now += 11 * MIN;
  await source.events();
  assert.equal(source.status()[0]!.error, null);
});

// ---------- invitations ----------

test("an invitation not answered is tagged, one declined is left out", () => {
  const feed = parseFeed(ics([
    vevent({ uid: "inv1", title: "Budget review", start: "20261118T140000Z", end: "20261118T150000Z",
      extra: ["ORGANIZER;CN=Ana Ruiz:mailto:ana@acme.example", "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.com"] }),
    vevent({ uid: "inv2", title: "Offsite", start: "20261119T090000Z", end: "20261119T100000Z", extra: ["ATTENDEE;PARTSTAT=DECLINED:mailto:me@example.com"] }),
    vevent({ uid: "inv3", title: "Standup", start: "20261118T080000Z", end: "20261118T081500Z", extra: ["ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com"] }),
  ]));
  const events = icsEvents(feed, { from: NOW - 24 * HOUR, to: NOW + 7 * 24 * HOUR, timeZone: ZONE, me: ["me@example.com"] });
  const byTitle = Object.fromEntries(events.map((e) => [e.title, e]));
  assert.equal(byTitle["Budget review"]!.response, "needs");
  assert.equal(byTitle["Offsite"]!.response, "declined");
  assert.equal(byTitle["Standup"]!.response, undefined);
  assert.equal(model.eventTag!(byTitle["Budget review"]), "Invited · not answered");
  assert.equal(model.eventTag!(byTitle["Standup"]), "");
});

test("an invitation mail shows on the dashboard at once, gives way to the calendar's copy (same UID), and a cancel removes it", async () => {
  let closed: string[] = [];
  const store = createInviteStore({ kv: memoryKv(), timeZone: ZONE, now: () => NOW, closed: (u) => (closed = u) });
  const request = ["BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST",
    vevent({ uid: "launch-77@acme.example", title: "Launch plan", start: "20261118T150000Z", end: "20261118T160000Z", extra: ["ORGANIZER;CN=Bea:mailto:bea@acme.example"] }),
    "END:VCALENDAR"].join("\r\n");
  assert.deepEqual(await store.take(request, NOW), { method: "request", uids: ["launch-77@acme.example"] });
  const shown = await store.overlay([]);
  assert.equal(shown.length, 1);
  assert.equal(shown[0]!.invited, "email");
  assert.equal(model.eventTag!(shown[0]), "Invited (from email)");
  const calendarCopy: CalEvent = { id: "cal:1", uid: "launch-77@acme.example", title: "Launch plan", start: Date.UTC(2026, 10, 18, 15), end: Date.UTC(2026, 10, 18, 16), allDay: false, calendar: "Work" };
  assert.deepEqual((await store.overlay([calendarCopy])).map((e) => e.id), ["cal:1"], "the calendar's copy wins");
  const cancel = request.replace("METHOD:REQUEST", "METHOD:CANCEL").replace("END:VEVENT", "STATUS:CANCELLED\r\nEND:VEVENT");
  assert.equal((await store.take(cancel, NOW, { address: "bea@acme.example", vouched: true }))?.method, "cancel");
  assert.deepEqual(await store.overlay([]), [], "the cancel removes it");
  assert.deepEqual(closed, ["launch-77@acme.example"], "and closes what followed it");
});

test("a cancel or a change of an invitation counts only from its organizer, as their mail server vouched; anyone else's is ignored", async () => {
  let closed: string[] = [];
  const store = createInviteStore({ kv: memoryKv(), timeZone: ZONE, now: () => NOW, closed: (u) => (closed = u) });
  const BEA = { address: "bea@acme.example", vouched: true };
  const request = ["BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST",
    vevent({ uid: "launch-77@acme.example", title: "Launch plan", start: "20261118T150000Z", end: "20261118T160000Z", extra: ["ORGANIZER;CN=Bea:mailto:bea@acme.example"] }),
    "END:VCALENDAR"].join("\r\n");
  await store.take(request, NOW, BEA);
  const cancel = request.replace("METHOD:REQUEST", "METHOD:CANCEL").replace("END:VEVENT", "STATUS:CANCELLED\r\nEND:VEVENT");
  // Someone who learnt the UID (a forwarded invitation): their cancel, even naming themselves organizer, changes nothing.
  const theirs = cancel.replace("mailto:bea@acme.example", "mailto:mallory@other.example");
  await store.take(theirs, NOW, { address: "mallory@other.example", vouched: true });
  await store.take(cancel, NOW, { address: "bea@acme.example", vouched: false });
  const moved = request.replace("20261118T160000Z", "20261118T180000Z").replace("20261118T150000Z", "20261118T170000Z").replace("Launch plan", "Launch plan (moved)");
  await store.take(moved, NOW, { address: "mallory@other.example", vouched: true });
  assert.deepEqual((await store.list()).map((x) => [x.title, x.start]), [["Launch plan", Date.UTC(2026, 10, 18, 15)]], "kept as Bea sent it");
  assert.deepEqual(closed, [], "and nothing that followed it is closed");
  // Bea moves it, then calls it off: both count.
  await store.take(moved, NOW, BEA);
  assert.deepEqual((await store.list()).map((x) => x.title), ["Launch plan (moved)"]);
  await store.take(cancel, NOW, BEA);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(closed, ["launch-77@acme.example"]);
});

test("an invitation moved by its organizer out of the next 60 days, or into the past, is replaced: the old time does not stay; an older copy of the mail changes nothing", async () => {
  const store = createInviteStore({ kv: memoryKv(), timeZone: ZONE, now: () => NOW });
  const BEA = { address: "bea@acme.example", vouched: true };
  const invite = (start: string, end: string, sequence: number, uid = "review-7@acme.example") => ["BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST",
    vevent({ uid, title: "Quarterly review", start, end, extra: [`SEQUENCE:${sequence}`, "ORGANIZER;CN=Bea:mailto:bea@acme.example"] }), "END:VCALENDAR"].join("\r\n");
  const shown = async () => (await store.list()).map((x) => new Date(x.start).toISOString());
  await store.take(invite("20261120T100000Z", "20261120T110000Z", 0), NOW, BEA);
  assert.deepEqual(await shown(), ["2026-11-20T10:00:00.000Z"]);
  // Moved to March (past the 60 days Pako looks ahead): the November time must not stay on the dashboard.
  assert.deepEqual(await store.take(invite("20270301T100000Z", "20270301T110000Z", 1), NOW, BEA), { method: "request", uids: ["review-7@acme.example"] });
  assert.deepEqual(await shown(), [], "replaced by a time outside the window, so no longer shown");
  // Moved into the past: the same.
  await store.take(invite("20261120T100000Z", "20261120T110000Z", 0, "review-8@acme.example"), NOW, BEA);
  await store.take(invite("20261101T100000Z", "20261101T110000Z", 1, "review-8@acme.example"), NOW, BEA);
  assert.deepEqual(await shown(), []);
  // Anyone else's REQUEST for a kept UID, inside the window or not, still changes nothing.
  await store.take(invite("20261120T100000Z", "20261120T110000Z", 0, "review-9@acme.example"), NOW, BEA);
  await store.take(invite("20270301T100000Z", "20270301T110000Z", 5, "review-9@acme.example"), NOW, { address: "mallory@other.example", vouched: true });
  assert.deepEqual(await shown(), ["2026-11-20T10:00:00.000Z"]);
  // An older copy (a lower SEQUENCE) read after a newer one, the same mail by two readers or delivered out of order, does not put the old time back.
  await store.take(invite("20261121T100000Z", "20261121T110000Z", 2, "review-9@acme.example"), NOW, BEA);
  await store.take(invite("20261120T100000Z", "20261120T110000Z", 0, "review-9@acme.example"), NOW, BEA);
  assert.deepEqual(await shown(), ["2026-11-21T10:00:00.000Z"], "the newer time stays");
  await store.take(invite("20261122T100000Z", "20261122T110000Z", 2, "review-9@acme.example"), NOW, BEA);
  assert.deepEqual(await shown(), ["2026-11-22T10:00:00.000Z"], "the same SEQUENCE again is a change as before");
});

test("over 100 invitations kept: the soonest stay, the furthest ahead give way", async () => {
  const store = createInviteStore({ kv: memoryKv(), timeZone: ZONE, now: () => NOW });
  const tomorrow = ["BEGIN:VCALENDAR", "METHOD:REQUEST", vevent({ uid: "soon@acme.example", title: "Board meeting", start: "20261119T100000Z", end: "20261119T110000Z" }),
    "END:VCALENDAR"].join("\r\n");
  await store.take(tomorrow, NOW);
  // A season's schedule mailed as calendar files, 20 events each, all later than tomorrow.
  for (let m = 0; m < 6; m++) {
    const events = Array.from({ length: 20 }, (_x, i) => {
      const day = new Date(NOW + (5 + m * 8 + (i % 8)) * 24 * HOUR + i * HOUR).toISOString().replace(/[-:]/g, "").slice(0, 15);
      return vevent({ uid: `game-${m}-${i}@club.example`, title: `Game ${m}-${i}`, start: `${day}Z`, end: `${day.slice(0, 9)}235900Z` });
    });
    await store.take(["BEGIN:VCALENDAR", "METHOD:PUBLISH", ...events, "END:VCALENDAR"].join("\r\n"), NOW);
  }
  const kept = await store.list();
  assert.equal(kept.length, 100);
  assert.equal(kept[0]!.title, "Board meeting", "tomorrow's meeting is never the one pushed out");
});

test("an invitation mail read by IMAP reaches the invitations at once", async () => {
  const invite = ["BEGIN:VCALENDAR", "METHOD:REQUEST", vevent({ uid: "x1", title: "Coffee", start: "20261118T120000Z", end: "20261118T123000Z" }), "END:VCALENDAR"].join("\r\n");
  const source = Buffer.from([
    "From: Bea <bea@acme.example>", "To: ana@example.com", "Subject: Invitation: Coffee", "Message-ID: <inv-1@acme.example>",
    'Content-Type: multipart/mixed; boundary="b"', "", "--b", "Content-Type: text/plain", "", "Join me", "--b",
    'Content-Type: text/calendar; method=REQUEST; charset=utf-8', "", invite, "--b--", "",
  ].join("\r\n"));
  const store = createInviteStore({ kv: null, timeZone: ZONE, now: () => NOW });
  const reader = createImapReader({
    config: { host: "imap.example.com", port: 993, user: "ana@example.com", password: "p", folders: ["INBOX"], pollMinutes: 5, workDomains: [], vip: [] },
    kv: memoryKv(), box: createMailbox(null), enqueue: async () => true, now: () => NOW, invites: store,
    connect: () => fakeClient({ INBOX: [{ uid: 1, at: NOW - MIN, source }] }),
  });
  await reader.poll();
  assert.deepEqual((await store.list()).map((x) => x.title), ["Coffee"]);
});

test("by IMAP: a cancel counts only from the organizer's mail as their server vouched; a forged From with the UID is ignored", async () => {
  const ics = (method: string) => ["BEGIN:VCALENDAR", `METHOD:${method}`,
    vevent({ uid: "x2", title: "Coffee", start: "20261118T120000Z", end: "20261118T123000Z", extra: ["ORGANIZER;CN=Bea:mailto:bea@acme.example"] }),
    "END:VCALENDAR"].join("\r\n");
  const mail = (n: number, from: string, auth: string, method: string) => Buffer.from([
    ...(auth ? [`Authentication-Results: mx.example.com; ${auth}`] : []),
    `From: ${from}`, "To: ana@example.com", `Subject: Invitation ${n}`, `Message-ID: <inv-${n}@acme.example>`,
    'Content-Type: multipart/mixed; boundary="b"', "", "--b", "Content-Type: text/plain", "", "See you", "--b",
    `Content-Type: text/calendar; method=${method}; charset=utf-8`, "", ics(method), "--b--", "",
  ].join("\r\n"));
  const store = createInviteStore({ kv: null, timeZone: ZONE, now: () => NOW });
  const box: { uid: number; at: number; source: Buffer }[] = [];
  const reader = createImapReader({
    config: { host: "imap.example.com", port: 993, user: "ana@example.com", password: "p", folders: ["INBOX"], pollMinutes: 5, workDomains: [], vip: [] },
    kv: memoryKv(), box: createMailbox(null), enqueue: async () => true, now: () => NOW, invites: store,
    connect: () => fakeClient({ INBOX: box }),
  });
  box.push({ uid: 1, at: NOW - 3 * MIN, source: mail(1, "Bea <bea@acme.example>", "dkim=pass header.d=acme.example; dmarc=pass header.from=acme.example", "REQUEST") });
  // Not Bea's server: anyone can write her name and address on a From line.
  box.push({ uid: 2, at: NOW - 2 * MIN, source: mail(2, "Bea <bea@acme.example>", "dkim=fail; dmarc=fail header.from=acme.example", "CANCEL") });
  await reader.poll();
  assert.deepEqual((await store.list()).map((x) => x.title), ["Coffee"], "the forged cancel is ignored");
  box.push({ uid: 3, at: NOW - MIN, source: mail(3, "Bea <bea@acme.example>", "dkim=pass header.d=acme.example", "CANCEL") });
  await reader.poll();
  assert.deepEqual(await store.list(), [], "Bea's own cancel removes it");
});

// ---------- the dashboard's refresh and freshness ----------

test("the dashboard's refresh reads the calendars again now, at most once every 30 seconds; the freshness line says each source's age", async () => {
  let refreshed = 0;
  const clock = { now: NOW };
  const app = express();
  const panel = mountDashboard(app, {
    secret: "bridge-token-for-tests-0123456789abcdef", publicUrl: "https://pako.example", ownerName: "Ana", timeZone: ZONE,
    control: createControl(null), memory: loadMemory(null), wa: { reminders: async () => [], events: () => [], lastPoll: () => 0 }, integrations: () => [],
    now: () => clock.now,
    calendar: { events: async () => [], refresh: async () => void refreshed++, sources: async () => [{ label: "Mac", lastSync: clock.now - 2 * MIN }] },
  });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}${new URL(panel.link()).pathname}`, { redirect: "manual" });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const get = (q = "") => fetch(`${base}/panel/api/overview${q}`, { headers: { cookie } }).then((r) => r.json() as Promise<{ calendarSources: unknown[] }>);
    await get();
    assert.equal(refreshed, 0, "a plain read does not fetch");
    await get("?fresh=1");
    await get("?fresh=1");
    assert.equal(refreshed, 1, "rate-limited");
    clock.now += REFRESH_EVERY_MS;
    const o = await get("?fresh=1");
    assert.equal(refreshed, 2);
    assert.deepEqual(o.calendarSources, [{ label: "Mac", lastSync: clock.now - 2 * MIN }]);
  } finally {
    server.close();
    server.closeAllConnections();
  }
  const line = model.freshnessLine!([
    { label: "Mac", lastSync: NOW - 2 * MIN },
    { label: "Google link (Work)", lastSync: NOW - 3 * HOUR, slow: true },
  ], NOW);
  assert.equal(line, "Calendars: Mac · synced 2 min ago · Google link (Work) · synced 3 h ago (older than 30 minutes; Google updates private links slowly)");
});

// ---------- a new mailbox's catch-up ----------

interface FakeMsg { uid: number; at: number; source: Buffer }
function fakeClient(folders: Record<string, FakeMsg[]>, special: Record<string, string> = {}): ImapClient {
  let open = "";
  const client: ImapClient = {
    connect: async () => undefined,
    mailboxOpen: async (path) => {
      if (!folders[path]) throw Object.assign(new Error("no such folder"), { serverResponseCode: "NONEXISTENT" });
      open = path;
      return { uidValidity: 1, uidNext: Math.max(0, ...folders[path]!.map((m) => m.uid)) + 1 };
    },
    search: async (q) => {
      const day = Date.UTC(q.since.getUTCFullYear(), q.since.getUTCMonth(), q.since.getUTCDate());
      const from = q.uid ? Number(q.uid.split(":")[0]) : 1;
      return folders[open]!.filter((m) => m.at >= day && m.uid >= from).map((m) => m.uid);
    },
    fetchOne: async (uid) => {
      const m = folders[open]!.find((x) => x.uid === Number(uid));
      return m ? { uid: m.uid, internalDate: new Date(m.at), source: m.source } : false;
    },
    list: async () => Object.keys(folders).map((path) => ({ path, ...(special[path] ? { specialUse: special[path] } : {}) })),
    logout: async () => undefined,
    close: () => undefined,
    on: () => client,
  };
  return client;
}
const mail = (o: { id: string; from: string; subject: string; body: string; to?: string; headers?: string[] }) => Buffer.from([
  `From: ${o.from}`, `To: ${o.to ?? "Ana <ana@example.com>"}`, `Subject: ${o.subject}`, `Message-ID: <${o.id}>`, ...(o.headers ?? []),
  "Content-Type: text/plain; charset=utf-8", "", o.body, "",
].join("\r\n"));

test("catch-up: 14 days of mail send no notice but two calm lines; the Sent folder's promises become loops the owner owes; an ask already answered is closed; the allowance is spread and respected; progress is reported", async () => {
  const clock = { now: NOW };
  const told: string[] = [];
  const queued: Inbound[] = [];
  const offered: { text: string }[] = [];
  const unread: string[] = [];
  const backfill = createBackfill({
    kv: memoryKv(), config: { days: 14, allowance: 4, everyMs: MIN }, now: () => clock.now, lang: () => "en",
    enqueue: async (m) => (queued.push(m), true),
    offer: async (o) => (offered.push(o), true),
    keepUnread: async (id) => void unread.push(id),
    notify: async (t) => void told.push(t),
  });
  const inbox: FakeMsg[] = [];
  for (let i = 0; i < 10; i++) {
    inbox.push({ uid: i + 1, at: NOW - (i + 1) * 30 * HOUR, source: mail({ id: `in-${i}@x.example`, from: `Person ${i} <p${i}@x.example>`, subject: `Question ${i}`, body: "Can you send me the deck?" }) });
  }
  inbox.push({ uid: 20, at: NOW - 2 * 24 * HOUR, source: mail({ id: "news@shop.example", from: "Shop <no-reply@shop.example>", subject: "Your order has shipped", body: "Tracking",
    headers: ["Authentication-Results: mx.example.com; dkim=pass header.d=shop.example"] }) });
  const sent: FakeMsg[] = [{ uid: 1, at: NOW - 24 * HOUR, source: mail({ id: "out-1@example.com", from: "Ana <ana@example.com>", to: "Person 0 <p0@x.example>",
    subject: "Re: Question 0", body: "I'll send it Friday.\n> Can you send me the deck?", headers: ["In-Reply-To: <in-0@x.example>"] }) }];
  const reader = createImapReader({
    config: { host: "imap.example.com", port: 993, user: "ana@example.com", password: "p", folders: ["INBOX"], pollMinutes: 5, workDomains: [], vip: [] },
    kv: memoryKv(), box: createMailbox(null), now: () => clock.now, notify: async (t) => void told.push(t),
    enqueue: async (m) => (queued.push(m), true),
    backfill: { add: backfill.add, addSent: backfill.addSent, startLine: backfill.startLine, days: 14 },
    connect: () => fakeClient({ INBOX: inbox, "Sent Messages": sent }, { "Sent Messages": "\\Sent" }),
  });
  const first = await reader.poll();
  assert.equal(queued.length, 0, "nothing goes to the assistant at once: the catch-up hands it out paced");
  assert.equal(first.caughtUp, 11, "10 inbox emails and 1 sent; the receipt never reaches Claude");
  assert.equal(first.stored, 1);
  assert.deepEqual(told, ["Connected to ana@example.com. Catching up on the last 14 days (about 11 items) quietly; I'll show what needs you on the dashboard."]);

  // Paced: one a minute, never two in the same minute; the allowance (4 runs) stops the rest, which is listed but not analysed.
  assert.equal(await backfill.tick(), "sent");
  assert.equal(await backfill.tick(), "waiting");
  for (let i = 0; i < 3; i++) {
    clock.now += MIN;
    assert.equal(await backfill.tick(), "sent");
  }
  assert.equal(offered.length, 1, "the Sent folder came first: the owner's promise goes to the follow-ups");
  assert.match(offered[0]!.text, /I'll send it Friday\./);
  assert.doesNotMatch(offered[0]!.text, /Can you send me the deck/, "the quoted ask is not the owner's words");
  assert.equal(queued.length, 3);
  assert.ok(queued.every((m) => m.email?.quiet === true), "every one quiet: never told");
  const answeredAsk = queued.find((m) => m.email?.subject === "Question 0");
  assert.equal(answeredAsk?.email?.replied, true, "the ask the owner already answered is marked: its loops are made closed");
  clock.now += MIN;
  await backfill.tick();
  assert.equal(queued.length, 3, "the allowance is respected");
  assert.equal(unread.length, 7, "the rest is kept, not analysed");
  const progress = await backfill.progress();
  assert.equal(progress?.running, true);
  assert.equal(progress?.notAnalysed, 7);
  assert.match(model.catchUpLine!(progress), /^Catching up on the last 14 days… \d+%$/);

  // Each verdict comes back; then ONE summary line.
  for (const m of queued) await backfill.answered(m.id.replace(/^mail:/, ""), { worth: true, replied: m.email?.replied === true, from: m.email?.from });
  assert.equal(await backfill.tick(), "reported");
  assert.equal(told.length, 2);
  assert.equal(told[1], "Caught up: 3 things need you, 2 people are waiting on a reply from you.");
  assert.equal(await backfill.tick(), "idle", "said once");
  assert.match((await backfill.briefLine()) ?? "", /^From the last 14 days \(mail\): 3 things need you/);
  assert.equal(await backfill.briefLine(), null);

  // Mail after the connection is news as before.
  inbox.push({ uid: 50, at: clock.now + MIN, source: mail({ id: "new@x.example", from: "Carl <carl@x.example>", subject: "Now", body: "Hi" }) });
  clock.now += 5 * MIN;
  await reader.poll();
  assert.equal(queued.at(-1)?.email?.subject, "Now");
  assert.equal(queued.at(-1)?.email?.quiet, undefined);
});

// ---------- the dashboard ----------

test("dashboard: the brief first, then the three tiles, then the Needs-you mail mount; no channel, settings or How Pako acts cards", () => {
  const html = read("src/panel/index.html");
  const at = (s: string) => html.indexOf(s);
  assert.ok(at('id="brief-top"') > 0 && at('id="brief-top"') < at('data-kpi="owe"'), "the brief renders first");
  assert.ok(at('data-kpi="owe"') < at('data-kpi="waiting"') && at('data-kpi="waiting"') < at('data-kpi="meetings"'));
  assert.ok(at('data-kpi="meetings"') < at('id="needs-you-mail"') && at('id="needs-you-mail"') < at('class="card agenda"'));
  for (const gone of ['data-kpi="slack"', 'data-kpi="mail"', "acts.js", "privacy.js", "autostart.js", "whatsapp.js"]) assert.ok(!html.includes(gone), gone);
  assert.equal((html.match(/class="card system/g) ?? []).length, 1, "one health section, not two");
  assert.match(html, /id="health"/, "the old anchor lands there");
  assert.match(read("src/panel/app.js"), /\$\("#tg-card"\)\.hidden = true;/, "Telegram never gets a dashboard card");
  assert.match(read("src/panel/whatsapp.js"), /const slot = \$\('\[data-mount="whatsapp"\]'\);\n  if \(!slot\) return;/, "nor WhatsApp");
  assert.match(read("src/panel/health.js"), /\[data-mount="health"\]'\) \?\? document\.querySelector\("#system-card \[data-hl-slot\]"\)/, "one component, both places");
});

test("dashboard: the tiles count what the owner owes (due today, overdue in warning) and what others owe; a source not connected hides its tile", () => {
  const end = NOW + 5 * HOUR;
  const loops = [
    { id: "1", kind: "owner_promise", title: "Send the deck", who: "Bea", status: "open", dueAt: NOW + 2 * HOUR },
    { id: "2", kind: "request_to_owner", title: "Review the contract", who: "Carl", status: "open", dueAt: NOW - HOUR },
    { id: "3", kind: "request_to_owner", title: "Call back", who: "Dan", status: "open", dueAt: end + 48 * HOUR },
    { id: "4", kind: "other_promise", title: "Bea sends the numbers", who: "Bea", status: "open" },
    { id: "5", kind: "owner_promise", title: "Done already", who: "Eve", status: "done" },
  ];
  const tiles = model.kpiTiles!({ loops, calendarOn: true, events: [{ title: "Sync", start: NOW + HOUR, end: NOW + 2 * HOUR, allDay: false }] }, NOW, "UTC");
  assert.deepEqual(tiles.owe, { n: 3, foot: "1 due today · 1 overdue", warn: true, href: "#loops" });
  assert.equal(tiles.waiting.n, 1);
  assert.equal(tiles.meetings.n, 1);
  const calm = model.kpiTiles!({ loops: [], calendarOn: false, events: [] }, NOW, "UTC");
  assert.deepEqual([calm.owe.n, calm.owe.foot, calm.owe.warn], [0, "all clear", false], "0 still shows: all clear");
  assert.equal(calm.meetings, null, "no calendar: no tile");
  assert.equal(model.kpiTiles!({ loops: null, calendarOn: true, events: [] }, NOW, "UTC").owe, null, "follow-ups off: no tile");
});

test("dashboard: the \"Things to do\" tile says \"all clear\" only at zero: owed things due later, or with no day, are not clear", () => {
  const owed = (id: string, dueAt?: number) => ({ id, kind: "owner_promise", title: `Thing ${id}`, who: "Bea", status: "open", ...(dueAt ? { dueAt } : {}) });
  const tomorrow = model.kpiTiles!({ loops: [1, 2, 3].map((i) => owed(String(i), NOW + 30 * HOUR)), calendarOn: false, events: [] }, NOW, "UTC");
  assert.equal(tomorrow.owe.n, 3);
  assert.notEqual(tomorrow.owe.foot, "all clear", "three things owed, none due today");
  assert.equal(tomorrow.owe.foot, "none due today");
  const noDay = model.kpiTiles!({ loops: [owed("a"), owed("b", NOW + 30 * HOUR)], calendarOn: false, events: [] }, NOW, "UTC");
  assert.equal(noDay.owe.foot, "none due today", "a thing with no day either");
  // Said when something is due, as before; and at zero it is clear.
  assert.equal(model.kpiTiles!({ loops: [owed("a", NOW + HOUR)], calendarOn: false, events: [] }, NOW, "UTC").owe.foot, "1 due today");
  assert.equal(model.kpiTiles!({ loops: [], calendarOn: false, events: [] }, NOW, "UTC").owe.foot, "all clear");
  // Waiting on others: a tile at zero is clear, one with something says who.
  assert.equal(model.kpiTiles!({ loops: [], calendarOn: false, events: [] }, NOW, "UTC").waiting.foot, "all clear");
});

test("dashboard: channels only as one line when broken; at most one suggestion; health is one calm line unless something is wrong", () => {
  const status = [
    { id: "telegram", state: "needsAction" }, { id: "whatsapp", state: "notSet" }, { id: "calendar", state: "notSet" },
    { id: "macCalendar", state: "notSet" }, { id: "imap", state: "notSet" }, { id: "contacts", state: "notSet" },
  ];
  assert.deepEqual(model.brokenChannels!(status), [{ id: "telegram", text: "Telegram stopped working · fix in Settings" }]);
  assert.deepEqual(model.brokenChannels!([{ id: "whatsapp", state: "connected" }]), [], "a working channel: no line, no card");
  assert.deepEqual(model.oneSuggestion!(status), { id: "calendar", text: "Connect your calendar to see today's meetings", href: "/panel/settings#calendar" });
  assert.equal(model.oneSuggestion!([{ id: "calendar", state: "connected" }, { id: "imap", state: "connected" }, { id: "telegram", state: "connected" }, { id: "contacts", state: "connected" }]), null);
  const ok = model.healthSummary!({ parts: [{ key: "claude", status: "ok", okAt: NOW - 2 * MIN }, { key: "store", status: "ok", okAt: NOW - 5 * MIN }] }, NOW);
  assert.deepEqual(ok, { ok: true, line: "All good · checked 2 min ago", problems: [] });
  const bad = model.healthSummary!({ parts: [{ key: "claude", status: "ok", okAt: NOW }, { key: "imap", status: "down", failSince: NOW - HOUR, detail: "the login was refused" }] }, NOW);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.problems, [{ key: "imap", detail: "the login was refused" }], "the problem first, with its fix");
  assert.equal(model.allEmpty!([false, false, false]), true, "a new install: only the welcome block");
  assert.equal(model.allEmpty!([false, true]), false);
});

test("dashboard: the brief shows today's, or the latest one 'as of' its time before today's is written", () => {
  const doc = { id: "d1", day: "2026-11-17", at: NOW - 24 * HOUR, opening: "A calm day.", todos: [{ title: "Send the deck", sources: ["r1"] }, { title: "B", sources: [] }, { title: "C", sources: [] }, { title: "D", sources: [] }], refs: [{ id: "r1", label: "Bea · email" }] };
  const latest = model.briefTop!({ doc: null, latest: doc });
  assert.equal(latest.asOf, doc.at, "as of its time");
  assert.deepEqual(latest.items[0], { title: "Send the deck", done: false, sources: ["Bea · email"] });
  assert.equal(latest.more, 1);
  assert.equal(model.briefTop!({ doc, latest: null }).asOf, null, "today's: no label");
  assert.equal(model.briefTop!({ doc: null, latest: null }), null);
});

test("settings: the tabs and their deep links (#mail, #acts, #privacy, #move, #labs, #general and the cards); the cards that left the dashboard mount there", () => {
  const js = read("src/panel/settings.js");
  assert.match(js, /const TABS = \["connections", "mail", "acts", "privacy", "move", "labs", "general"\];/);
  const html = read("src/panel/settings.html");
  for (const tab of ["connections", "mail", "acts", "privacy", "move", "labs", "general"]) assert.match(html, new RegExp(`id="tab-${tab}"`), tab);
  for (const slot of ["privacy", "move", "autostart", "acts", "health", "mail-categories", "labs"]) assert.match(html, new RegExp(`data-mount="${slot}"`), slot);
  for (const s of ["privacy", "move", "autostart", "acts", "health", "whatsapp", "labs"]) assert.match(html, new RegExp(`src="/panel/assets/${s}\\.js"`), s);
  // tabOf, the page's own: run as the page runs it.
  const body = js.slice(js.indexOf("function tabOf(hash) {"), js.indexOf("function showTab("));
  const tabOf = new Function("TABS", `${body}; return tabOf;`)(["connections", "mail", "acts", "privacy", "move", "labs", "general"]) as (h: string) => string;
  assert.deepEqual(["privacy", "move", "mail", "acts", "labs", "general", "calendar", "slack", "imap", ""].map(tabOf),
    ["privacy", "move", "mail", "acts", "labs", "general", "connections", "connections", "mail", "connections"]);
  // Delete everything and import still send what their routes need, from their new tab.
  assert.equal((read("src/panel/privacy.js").match(/"x-pako": "1"/g) ?? []).length, 2);
  assert.match(read("src/panel/move.js"), /\[data-mount="move"\]/);
});

test("after the catch-up, the Sent folder is read at every look, so a reply sent from another mail app closes what it answers", async () => {
  const clock = { now: NOW };
  const opened: string[] = [];
  const inbox: FakeMsg[] = [{ uid: 1, at: NOW - HOUR, source: mail({ id: "ask@x.example", from: "Marc <marc@x.example>", subject: "Budget", body: "Can you approve it?" }) }];
  const sent: FakeMsg[] = [];
  const box = createMailbox(null);
  const reader = createImapReader({
    config: { host: "imap.example.com", port: 993, user: "ana@example.com", password: "p", folders: ["INBOX"], pollMinutes: 5, workDomains: [], vip: [] },
    kv: memoryKv(), box, now: () => clock.now, notify: async () => undefined, enqueue: async () => true,
    connect: () => {
      const c = fakeClient({ INBOX: inbox, "Sent Messages": sent }, { "Sent Messages": "\\Sent" });
      const open = c.mailboxOpen;
      c.mailboxOpen = async (path, o) => (opened.push(path), open(path, o));
      return c;
    },
  });
  await reader.poll();
  opened.length = 0;
  // Later, the owner answers from Outlook: the reply lands in Sent.
  sent.push({ uid: 7, at: NOW + 10 * MIN, source: mail({ id: "re@example.com", from: "Ana <ana@example.com>", to: "Marc <marc@x.example>", subject: "Re: Budget",
    body: "Approved.", headers: ["In-Reply-To: <ask@x.example>"] }) });
  clock.now += 15 * MIN;
  await reader.poll();
  assert.ok(opened.includes("Sent Messages"), "Sent is read at a later look too, not only in the first catch-up");
});
