// The mail reader: the IMAP reader, the catch-up, the sender check, Resend and the mailbox sign-in, each bug proven here first:
// a first look cut short (the rest of it told as news, the catch-up lost), a forged "own" mail closing what it names, a server's day for
// SINCE, the Sent folder lost for good to one failed LIST, an opaque AgentMail inbox as Resend's reply_to, a full catch-up queue, a shared
// registry suffix taken for one sender's domain, a switched sign-in method left half in place, and a login check left open.

import assert from "node:assert/strict";
import test from "node:test";
import { createBackfill } from "../src/backfill.ts";
import { createImapReader, loadImapConfig, type ImapClient, type ImapConfig, type ImapConnect } from "../src/imap.ts";
import { createInviteStore } from "../src/invites.ts";
import type { Kv } from "../src/kv.ts";
import { loginTest } from "../src/mail-autoconfig.ts";
import { authenticated } from "../src/mail-categories.ts";
import { createMailbox } from "../src/mail.ts";
import { chooseSender } from "../src/resend.ts";
import type { Inbound } from "../src/whatsapp.ts";

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const CONFIG: ImapConfig = {
  host: "imap.example.com", port: 993, user: "ana@example.com", password: "app-pass-1234", folders: ["INBOX"], pollMinutes: 5, workDomains: [], vip: [],
};

function memoryKv(): Kv {
  const data = new Map<string, string>();
  return { get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v) };
}

const mail = (o: { id: string; from?: string; subject?: string; body?: string; headers?: string[] }): Buffer => Buffer.from([
  `From: ${o.from ?? "Luis <luis@amigos.example>"}`, "To: Ana <ana@example.com>", `Subject: ${o.subject ?? "Hola"}`, `Message-ID: <${o.id}>`,
  ...(o.headers ?? []), "Content-Type: text/plain; charset=utf-8", "", o.body ?? "¿Cenamos el viernes?", "",
].join("\r\n"));

interface Msg { uid: number; at: number; source: Buffer }

/**
 * A fake server. `sinceDay` says how it reads SINCE: by the UTC day (the default) or by its own time zone's day, as a server does.
 * `failFetch(uid)` makes that fetch drop the connection; `failList` makes LIST fail.
 */
function fakeServer(folders: Record<string, Msg[]>, o: { special?: Record<string, string>; zone?: string } = {}) {
  const ctl = { failFetch: null as number | null, failList: false, closed: 0, connects: 0 };
  const dayOf = (t: number): string =>
    new Intl.DateTimeFormat("en-CA", { timeZone: o.zone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
  const connect: ImapConnect = () => {
    let open = "";
    const client: ImapClient = {
      connect: async () => void ctl.connects++,
      mailboxOpen: async (path) => {
        if (!folders[path]) throw Object.assign(new Error("no such folder"), { serverResponseCode: "NONEXISTENT" });
        open = path;
        return { uidValidity: 7, uidNext: Math.max(0, ...folders[path]!.map((m) => m.uid)) + 1 };
      },
      search: async (q) => {
        // imapflow sends SINCE as the UTC day of the Date (DD-Mon-YYYY); the server compares it with each message's day in its own zone.
        const since = q.since.toISOString().slice(0, 10);
        const from = q.uid ? Number(q.uid.split(":")[0]) : 1;
        return folders[open]!.filter((m) => dayOf(m.at) >= since && m.uid >= from).map((m) => m.uid);
      },
      fetchOne: async (uid) => {
        if (ctl.failFetch === Number(uid)) throw Object.assign(new Error("Connection closed"), { code: "NoConnection" });
        const m = folders[open]!.find((x) => x.uid === Number(uid));
        return m ? { uid: m.uid, internalDate: new Date(m.at), source: m.source } : false;
      },
      list: async () => {
        if (ctl.failList) throw Object.assign(new Error("Connection closed"), { code: "NoConnection" });
        return Object.keys(folders).map((path) => ({ path, ...(o.special?.[path] ? { specialUse: o.special[path] } : {}) }));
      },
      logout: async () => undefined,
      close: () => void ctl.closed++,
      on: () => client,
    };
    return client;
  };
  return { ctl, connect };
}

test("a first look cut short by a dropped connection stays quiet when it goes on: the rest of the day's mail is never told as news", async () => {
  const inbox: Msg[] = [1, 2, 3].map((uid) => ({ uid, at: NOW - (10 - uid) * HOUR, source: mail({ id: `m${uid}@amigos.example`, subject: `Mail ${uid}` }) }));
  const server = fakeServer({ INBOX: inbox });
  const queued: Inbound[] = [];
  const told: string[] = [];
  let clock = NOW;
  const reader = createImapReader({
    config: CONFIG, kv: memoryKv(), box: createMailbox(null), now: () => clock, connect: server.connect,
    enqueue: async (m) => (queued.push(m), true), notify: async (t) => void told.push(t),
  });
  server.ctl.failFetch = 2;
  assert.equal((await reader.poll()).skipped, "failed");
  assert.equal(queued.length, 1);
  server.ctl.failFetch = null;
  clock += HOUR;
  const second = await reader.poll();
  assert.equal(second.skipped, undefined);
  assert.equal(queued.length, 3);
  assert.deepEqual(queued.map((m) => m.email?.quiet === true), [true, true, true], "mail already there when the mailbox was connected is never news");
  assert.equal(second.connected, true, "the calm line comes once the first look is whole");
  assert.equal(told.length, 1);
});

test("a catch-up cut short goes on as a catch-up: its older days still reach the catch-up, nothing reaches the owner as news", async () => {
  const inbox: Msg[] = [1, 2, 3, 4].map((uid) => ({ uid, at: NOW - (5 - uid) * 2 * 24 * HOUR, source: mail({ id: `c${uid}@amigos.example`, subject: `Old ${uid}` }) }));
  const server = fakeServer({ INBOX: inbox, Sent: [] }, { special: { Sent: "\\Sent" } });
  const queued: Inbound[] = [];
  const caught: Inbound[] = [];
  let clock = NOW;
  const backfill = createBackfill({ kv: null, config: { days: 14, allowance: 60, everyMs: 60_000 }, enqueue: async () => true, now: () => clock });
  const reader = createImapReader({
    config: CONFIG, kv: memoryKv(), box: createMailbox(null), now: () => clock, connect: server.connect,
    enqueue: async (m) => (queued.push(m), true), notify: async () => undefined,
    backfill: { add: async (m, o) => (caught.push(m), backfill.add(m, o)), addSent: backfill.addSent, startLine: backfill.startLine, days: 14 },
  });
  server.ctl.failFetch = 3;
  assert.equal((await reader.poll()).skipped, "failed");
  assert.equal(caught.length, 2);
  server.ctl.failFetch = null;
  clock += HOUR;
  const second = await reader.poll();
  assert.equal(queued.length, 0, "nothing told");
  assert.deepEqual(caught.map((m) => m.email?.subject), ["Old 1", "Old 2", "Old 3", "Old 4"], "the 6- and 8-day-old mail still caught up");
  assert.equal(second.connected, true);
});

test("a forged mail in the owner's own name never marks what it names as answered; their real (authenticated) one does", async () => {
  const inbox: Msg[] = [{ uid: 1, at: NOW - HOUR, source: mail({ id: "ask-1@amigos.example", subject: "¿Me mandas el informe?" }) }];
  const server = fakeServer({ INBOX: inbox });
  const box = createMailbox(null);
  let clock = NOW;
  const reader = createImapReader({
    config: CONFIG, kv: memoryKv(), box, now: () => clock, connect: server.connect, enqueue: async () => true, notify: async () => undefined,
  });
  await reader.poll();
  const kept = (await box.items()).find((r) => r.messageId === "ask-1@amigos.example");
  assert.ok(kept);
  inbox.push({ uid: 2, at: clock + 60_000, source: mail({
    id: "forged@evil.example", from: "Ana <ana@example.com>", subject: "Re: ¿Me mandas el informe?", body: "done",
    headers: ["Authentication-Results: mx.example.com; dkim=none; spf=fail smtp.mailfrom=evil.example; dmarc=fail header.from=example.com",
      "In-Reply-To: <ask-1@amigos.example>"],
  }) });
  clock += 10 * 60_000;
  await reader.poll();
  assert.equal((await box.get(kept.id))?.repliedAt, undefined, "a stranger writing as the owner closes nothing");
  inbox.push({ uid: 3, at: clock + 60_000, source: mail({
    id: "real@example.com", from: "Ana <ana@example.com>", subject: "Re: ¿Me mandas el informe?", body: "aquí lo tienes",
    headers: ["Authentication-Results: mx.example.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com",
      "In-Reply-To: <ask-1@amigos.example>"],
  }) });
  clock += 10 * 60_000;
  await reader.poll();
  assert.equal(typeof (await box.get(kept.id))?.repliedAt, "number", "the owner's own reply, vouched for by their server, still closes it");
});

/** An invitation of Dana's, and her mail cancelling it with the Authentication-Results line `auth` on top. */
const boardIcs = (method: string) => ["BEGIN:VCALENDAR", "VERSION:2.0", `METHOD:${method}`, "BEGIN:VEVENT", "UID:board-42", "DTSTART:20261117T100000Z", "DTEND:20261117T110000Z",
  "SUMMARY:Board meeting", "ORGANIZER:mailto:dana@client.example", ...(method === "CANCEL" ? ["STATUS:CANCELLED"] : []), "END:VEVENT", "END:VCALENDAR"].join("\r\n");
const boardCancel = (id: string, auth: string): Buffer => Buffer.from([
  `Authentication-Results: ${auth}`, "From: Dana <dana@client.example>", "To: Ana <ana@example.com>", "Subject: Canceled: Board meeting", `Message-ID: <${id}>`,
  'Content-Type: multipart/mixed; boundary="b"', "", "--b", "Content-Type: text/plain", "", "Called off", "--b",
  "Content-Type: text/calendar; method=CANCEL; charset=utf-8", "", boardIcs("CANCEL"), "--b--", "",
].join("\r\n"));

test("a sender's own Authentication-Results line is not the server's: on a mailbox whose server writes none it closes no loop and cancels no invitation", async () => {
  // The topmost Authentication-Results is the receiving server's only when that server writes one; otherwise it is the sender's, which says
  // whatever the sender likes. On a host that is not a big provider's it counts only when it names the mailbox's own server (here imap.example.com).
  const own = (server: string) => `Authentication-Results: ${server}; dkim=pass header.d=example.com; dmarc=pass header.from=example.com`;
  const ics = boardIcs;
  const cancel = boardCancel;
  const inbox: Msg[] = [{ uid: 1, at: NOW - HOUR, source: mail({ id: "ask-1@amigos.example", subject: "¿Me mandas el informe?" }) }];
  const server = fakeServer({ INBOX: inbox });
  const box = createMailbox(null);
  const cancelled: string[][] = [];
  const invites = createInviteStore({ kv: memoryKv(), timeZone: "Europe/Madrid", now: () => NOW, closed: (u) => void cancelled.push(u) });
  let clock = NOW;
  const reader = createImapReader({
    config: CONFIG, kv: memoryKv(), box, now: () => clock, connect: server.connect, enqueue: async () => true, notify: async () => undefined, invites,
  });
  await reader.poll();
  await invites.take(ics("REQUEST"), NOW, { address: "dana@client.example", vouched: true });
  const kept = (await box.items()).find((r) => r.messageId === "ask-1@amigos.example");
  assert.ok(kept);
  // A stranger's mail in the owner's name and in Dana's, each with an Authentication-Results line of its own making.
  inbox.push({ uid: 2, at: clock + 60_000, source: mail({
    id: "forged@evil.example", from: "Ana <ana@example.com>", subject: "Re: ¿Me mandas el informe?", body: "done",
    headers: [own("mx.anything.example"), "In-Reply-To: <ask-1@amigos.example>"],
  }) });
  inbox.push({ uid: 3, at: clock + 120_000, source: cancel("fake-cancel@evil.example", "mx.anything.example; dkim=pass header.d=client.example") });
  clock += 10 * 60_000;
  await reader.poll();
  assert.equal((await box.get(kept.id))?.repliedAt, undefined, "a line the sender wrote vouches for nothing: the loop stays open");
  assert.deepEqual((await invites.list()).map((x) => x.title), ["Board meeting"], "and the invitation stays");
  assert.deepEqual(cancelled, []);
  // The same two with the mailbox's own server naming itself: counted.
  inbox.push({ uid: 4, at: clock + 60_000, source: mail({
    id: "real@example.com", from: "Ana <ana@example.com>", subject: "Re: ¿Me mandas el informe?", body: "aquí lo tienes",
    headers: [own("imap.example.com"), "In-Reply-To: <ask-1@amigos.example>"],
  }) });
  inbox.push({ uid: 5, at: clock + 120_000, source: cancel("real-cancel@client.example", "imap.example.com; dkim=pass header.d=client.example") });
  clock += 10 * 60_000;
  await reader.poll();
  assert.equal(typeof (await box.get(kept.id))?.repliedAt, "number", "the owner's own reply, with their server's line, closes it");
  assert.deepEqual(await invites.list(), [], "Dana's own cancel, with their server's line, removes the invitation");
  assert.deepEqual(cancelled, [["board-42"]]);
});

test("a big provider's own Authentication-Results line still vouches, whatever server name it carries (Gmail's mx.google.com, Microsoft 365's none)", async () => {
  // They put their header on top and strip a sender's, so the topmost is theirs; only an unknown host's must name itself (the test above).
  const cases: { host: string; line: (domain: string) => string }[] = [
    { host: "imap.gmail.com", line: (d) => `mx.google.com; dkim=pass header.i=@${d} header.s=sel; spf=pass smtp.mailfrom=${d}; dmarc=pass (p=NONE) header.from=${d}` },
    { host: "outlook.office365.com", line: (d) => `spf=pass (sender IP is 1.2.3.4) smtp.mailfrom=${d}; dkim=pass (signature was verified) header.d=${d}; dmarc=pass action=none header.from=${d}` },
  ];
  for (const { host, line } of cases) {
    const auth = line("example.com");
    const inbox: Msg[] = [{ uid: 1, at: NOW - HOUR, source: mail({ id: "ask-1@amigos.example", subject: "¿Me mandas el informe?" }) }];
    const server = fakeServer({ INBOX: inbox });
    const box = createMailbox(null);
    const cancelled: string[][] = [];
    const invites = createInviteStore({ kv: memoryKv(), timeZone: "Europe/Madrid", now: () => NOW, closed: (u) => void cancelled.push(u) });
    let clock = NOW;
    const reader = createImapReader({
      config: { ...CONFIG, host }, kv: memoryKv(), box, now: () => clock, connect: server.connect, enqueue: async () => true, notify: async () => undefined, invites,
    });
    await reader.poll();
    await invites.take(boardIcs("REQUEST"), NOW, { address: "dana@client.example", vouched: true });
    const kept = (await box.items()).find((r) => r.messageId === "ask-1@amigos.example");
    assert.ok(kept, host);
    inbox.push({ uid: 2, at: clock + 60_000, source: mail({
      id: "real@example.com", from: "Ana <ana@example.com>", subject: "Re: ¿Me mandas el informe?", body: "aquí lo tienes",
      headers: [`Authentication-Results: ${auth}`, "In-Reply-To: <ask-1@amigos.example>"],
    }) });
    inbox.push({ uid: 3, at: clock + 120_000, source: boardCancel("real-cancel@client.example", line("client.example")) });
    clock += 10 * 60_000;
    await reader.poll();
    assert.equal(typeof (await box.get(kept.id))?.repliedAt, "number", `${host}: the owner's own reply, with the provider's line, closes it`);
    assert.deepEqual(await invites.list(), [], `${host}: Dana's own cancel is believed`);
    assert.deepEqual(cancelled, [["board-42"]], host);
    // And the same line on an unknown host proves nothing.
    assert.equal(authenticated("Ana <ana@example.com>", [auth], "imap.example.com"), false, `${host}'s line on an unknown host`);
  }
});

test("SINCE is a day on the server's clock: mail inside the window on a server west of UTC is still read", async () => {
  // 03:00 UTC: the window starts at 03:00 UTC yesterday, which is still the day before on a server in California.
  const now = Date.UTC(2026, 10, 16, 3, 0, 0);
  const inbox: Msg[] = [{ uid: 1, at: now - 23 * HOUR, source: mail({ id: "edge@amigos.example", subject: "Late yesterday" }) }];
  const server = fakeServer({ INBOX: inbox }, { zone: "America/Los_Angeles" });
  const queued: Inbound[] = [];
  const reader = createImapReader({
    config: CONFIG, kv: memoryKv(), box: createMailbox(null), now: () => now, connect: server.connect,
    enqueue: async (m) => (queued.push(m), true), notify: async () => undefined,
  });
  await reader.poll();
  assert.deepEqual(queued.map((m) => m.email?.subject), ["Late yesterday"]);
});

test("one failed LIST does not lose the Sent folder for good: the next look finds it and the owner's reply closes what it answers", async () => {
  const inbox: Msg[] = [{ uid: 1, at: NOW - HOUR, source: mail({ id: "q@amigos.example", subject: "Question" }) }];
  const sent: Msg[] = [];
  const server = fakeServer({ INBOX: inbox, "Sent Items": sent }, { special: { "Sent Items": "\\Sent" } });
  const box = createMailbox(null);
  let clock = NOW;
  const reader = createImapReader({
    config: CONFIG, kv: memoryKv(), box, now: () => clock, connect: server.connect, enqueue: async () => true, notify: async () => undefined,
  });
  server.ctl.failList = true;
  await reader.poll();
  server.ctl.failList = false;
  sent.push({ uid: 1, at: clock + 60_000, source: mail({
    id: "r@example.com", from: "Ana <ana@example.com>", subject: "Re: Question", body: "Yes", headers: ["In-Reply-To: <q@amigos.example>"],
  }) });
  clock += 10 * 60_000;
  await reader.poll();
  const kept = (await box.items()).find((r) => r.messageId === "q@amigos.example");
  assert.equal(typeof kept?.repliedAt, "number");
});

test("Resend: an AgentMail inbox known by its opaque id is not an address, so it is never sent as reply_to (Resend would refuse every email)", async () => {
  const bodies: Record<string, unknown>[] = [];
  const f = (async (_u: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ id: "e1" }), { status: 200 });
  }) as typeof fetch;
  const resend = { apiKey: "re_12345678abc", from: "Pako <hello@pako.example>" };
  await chooseSender({ resend, agentmail: { apiKey: "am_key", inbox: "inb_7f3a9c2e41" }, fetch: f })!.send({ to: "x@y.example", subject: "s", text: "t" });
  assert.equal(bodies[0]!.reply_to, undefined);
  await chooseSender({ resend, agentmail: { apiKey: "am_key", inbox: "pako@agentmail.to" }, fetch: f })!.send({ to: "x@y.example", subject: "s", text: "t" });
  assert.equal(bodies[1]!.reply_to, "pako@agentmail.to", "an address still is");
});

test("a full catch-up queue does not drop inbox mail silently: what does not fit is kept unread and counted", async () => {
  const unread: string[] = [];
  const b = createBackfill({ kv: null, config: { days: 14, allowance: 1000, everyMs: 60_000 }, enqueue: async () => true, keepUnread: async (id) => void unread.push(id) });
  for (let i = 0; i < 400; i++) await b.addSent({ ref: `s${i}`, label: "sent", text: "I'll send it", at: NOW });
  await b.add({ id: "mail:imap:abc", at: NOW, text: "", email: { from: "a@b.example", subject: "s", text: "t", attachments: [], account: "personal", vip: false } });
  assert.deepEqual(unread, ["imap:abc"]);
  const p = await b.progress();
  assert.equal(p?.total, 401);
  assert.equal(p?.notAnalysed, 1);
});

test("a catch-up of more mail than the mailbox keeps analyses the newest first: every mail handed to Claude is still kept, so its summary has somewhere to go", async () => {
  // 14 days, an email every hour and a half: more than the 150 records the mailbox keeps. The allowance (60 runs) was spent on the oldest,
  // which the mailbox had already dropped by the time they were handed out.
  const N = 220;
  const msgs: Msg[] = Array.from({ length: N }, (_, i) => ({
    uid: i + 1, at: NOW - (N - i) * 90 * 60_000, source: mail({ id: `m${i + 1}@client.example`, from: `Person ${i + 1} <p${i + 1}@client.example>`, subject: `Question ${i + 1}` }),
  }));
  let clock = NOW;
  const handed: Inbound[] = [];
  const kv = memoryKv();
  const box = createMailbox(kv);
  const bf = createBackfill({ kv, config: { days: 14, allowance: 60, everyMs: 60_000 }, enqueue: async (m) => (handed.push(m), true), now: () => clock });
  const server = fakeServer({ INBOX: msgs });
  const reader = createImapReader({
    config: CONFIG, kv, box, now: () => clock, connect: server.connect, enqueue: async () => true,
    backfill: { add: bf.add, addSent: bf.addSent, startLine: bf.startLine, days: 14 },
  });
  assert.equal((await reader.poll()).caughtUp, N);
  for (let i = 0; i < 70; i++) {
    clock += 61_000;
    await bf.tick();
  }
  assert.equal(handed.length, 60);
  assert.equal(handed[0]!.email?.subject, "Question 220", "the newest first");
  assert.equal(handed.at(-1)!.email?.subject, "Question 161");
  for (const m of handed) {
    const id = m.id.replace(/^mail:/, "");
    assert.ok(await box.get(id), `${m.email?.subject} was dropped by the mailbox before its summary could be kept`);
    assert.equal(await box.annotate(id, "aviso", "They ask you something.", clock), true);
  }
});

test("a domain under a shared registry suffix (uk.com, me.uk, ltd.uk) is not aligned with its neighbour: a forged sender is not vouched for", () => {
  assert.equal(authenticated("Billing <billing@acme.uk.com>", ["mx.owner.example; dkim=pass header.d=evil.uk.com"]), false);
  assert.equal(authenticated("Bank <alerts@bank.me.uk>", ["mx.owner.example; dkim=pass header.d=crook.me.uk"]), false);
  assert.equal(authenticated("Shop <orders@shop.ltd.uk>", ["mx.owner.example; dmarc=pass header.from=other.ltd.uk"]), false);
  assert.equal(authenticated("Billing <billing@mail.acme.uk.com>", ["mx.owner.example; dkim=pass header.d=acme.uk.com"]), true, "its own subdomain still is");
  assert.equal(authenticated("UPS <a@mail.ups.com>", ["mx.owner.example; dkim=pass header.d=ups.com"]), true);
  assert.equal(authenticated("Shop <a@shop.example.co.uk>", ["mx.owner.example; dkim=pass header.d=example.co.uk"]), true);
});

test("connecting with an app password after a sign-in with Microsoft removes that sign-in: the password is what runs, not the old token", async () => {
  const { mountMailConnect, createAutoconfig } = await import("../src/mail-autoconfig.ts");
  const express = (await import("express")).default;
  const saved: Record<string, string>[] = [];
  const app = express();
  const ok: ImapConnect = () => {
    const c: ImapClient = {
      connect: async () => undefined, mailboxOpen: async () => ({ uidValidity: 1 }), search: async () => [], fetchOne: async () => false,
      logout: async () => undefined, close: () => undefined, on: () => c,
    };
    return c;
  };
  mountMailConnect(app, {
    signedIn: () => true, lang: () => "en", connect: ok, autoconfig: createAutoconfig({ fetch: (async () => new Response("", { status: 404 })) as typeof fetch }),
    saver: { save: async (_id, values) => (saved.push(values), { ok: true, name: "IMAP" }), restartAfter: () => false },
  } as Parameters<typeof mountMailConnect>[1]);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const port = (server.address() as { port: number }).port;
    const r = await fetch(`http://127.0.0.1:${port}/panel/api/mail/connect`, {
      method: "POST", headers: { "content-type": "application/json", "x-pako": "1", host: `127.0.0.1:${port}` },
      body: JSON.stringify({ address: "ana@icloud.com", password: "abcd-efgh-ijkl-mnop" }),
    });
    assert.equal((await r.json() as { ok: boolean }).ok, true);
  } finally {
    server.close();
  }
  // What the panel's store holds after this save: the earlier Microsoft sign-in, with the new values over it ("" removes a key).
  const before = { IMAP_HOST: "outlook.office365.com", IMAP_USER: "ana@outlook.com", IMAP_OAUTH: "microsoft", IMAP_REFRESH_TOKEN: "M.R3_BAY.refresh-token-123" };
  const after: Record<string, string> = { ...before, PAKO_MS_CLIENT_ID: "11111111-2222-3333-4444-555555555555" };
  for (const [k, v] of Object.entries(saved[0] ?? {})) {
    if (v) after[k] = v;
    else delete after[k];
  }
  const cfg = loadImapConfig(after).config;
  assert.equal(cfg?.host, "imap.mail.me.com");
  assert.equal(cfg?.oauth, undefined, "the app password is used, not the old Microsoft sign-in against iCloud");
  assert.equal(cfg?.password, "abcd-efgh-ijkl-mnop");
});

test("the login check gives up after its time and closes the connection it opened", async () => {
  let closed = 0;
  const hang: ImapConnect = () => {
    const c: ImapClient = {
      connect: () => new Promise<void>(() => undefined), mailboxOpen: async () => ({ uidValidity: 1 }), search: async () => [], fetchOne: async () => false,
      logout: async () => undefined, close: () => void closed++, on: () => c,
    };
    return c;
  };
  const r = await loginTest(CONFIG, hang, 50);
  assert.deepEqual(r, { ok: false, kind: "network" });
  assert.equal(closed, 1);
});

test("backfill: a store that fails to answer once does not empty the catch-up's queue", async () => {
  const data = new Map<string, string>();
  let failing = false;
  const kv = {
    get: async (k: string) => {
      if (failing) throw new Error("the store is busy");
      return data.get(k) ?? null;
    },
    set: async (k: string, v: string) => void data.set(k, v),
  };
  let clock = 1_800_000_000_000;
  const sent: string[] = [];
  const b = createBackfill({ kv, config: { days: 14, allowance: 60, everyMs: 60_000 }, enqueue: async (m) => (sent.push(m.id), true), now: () => clock });
  for (let i = 0; i < 3; i++) await b.add({ id: `mail:m${i}`, at: clock, text: "", email: { from: "a@example.com", subject: `s${i}`, text: "t" } } as never);
  failing = true;
  await b.tick().catch(() => undefined);
  failing = false;
  for (let i = 0; i < 3; i++) {
    clock += 60_000;
    await b.tick();
  }
  assert.deepEqual(sent, ["mail:m0", "mail:m1", "mail:m2"], "every queued email still goes out");
  assert.equal((await b.progress())?.total, 3);
});

test("backfill: a second mailbox connected after the first catch-up was reported gets a catch-up of its own: its allowance, its mail analysed, its own summary", async () => {
  let clock = Date.UTC(2026, 9, 1);
  const said: string[] = [];
  const unread: string[] = [];
  const sent: string[] = [];
  const b = createBackfill({
    kv: memoryKv(), config: { days: 14, allowance: 3, everyMs: 60_000 }, now: () => clock,
    enqueue: async (m) => (sent.push(m.id), true), notify: async (t) => void said.push(t), keepUnread: async (id) => void unread.push(id),
  });
  const mail = (id: string) => ({ id: `mail:${id}`, at: clock, text: "x", email: { from: "a@example.com" } }) as never;
  for (const id of ["a1", "a2", "a3"]) await b.add(mail(id));
  for (let i = 0; i < 3; i++) {
    clock += 61_000;
    assert.equal(await b.tick(), "sent");
  }
  for (const id of ["a1", "a2", "a3"]) await b.answered(id, { worth: true, from: "a@example.com" });
  clock += 61_000;
  assert.equal(await b.tick(), "reported");
  assert.equal(said.length, 1);
  // Forty days later the owner connects another mailbox: its mail goes to the same catch-up, which was over.
  clock += 40 * 24 * HOUR;
  sent.length = 0;
  for (const id of ["b1", "b2", "b3"]) await b.add(mail(id));
  assert.equal((await b.progress())?.running, true, "a new catch-up is running");
  assert.equal((await b.progress())?.total, 3, "counted apart from the first one");
  for (let i = 0; i < 3; i++) {
    clock += 61_000;
    assert.equal(await b.tick(), "sent");
  }
  assert.deepEqual(sent, ["mail:b1", "mail:b2", "mail:b3"], "handed to Claude, not left unanalysed on a spent allowance");
  assert.deepEqual(unread, [], "none kept unread as 'not analysed'");
  for (const id of ["b1", "b2", "b3"]) await b.answered(id, { worth: false });
  clock += 61_000;
  assert.equal(await b.tick(), "reported", "and its own summary is said");
  assert.equal(said.length, 2);
  assert.match(said[1]!, /Caught up: 0 things need you, 0 people are waiting/);
  assert.equal((await b.progress())?.notAnalysed, 0);
});

test("backfill: a catch-up still running takes a second mailbox's mail into the same run, and its allowance is shared", async () => {
  let clock = Date.UTC(2026, 9, 1);
  const sent: string[] = [];
  const unread: string[] = [];
  const b = createBackfill({
    kv: null, config: { days: 14, allowance: 2, everyMs: 60_000 }, now: () => clock, enqueue: async (m) => (sent.push(m.id), true), keepUnread: async (id) => void unread.push(id),
  });
  const mail = (id: string) => ({ id: `mail:${id}`, at: clock, text: "x", email: { from: "a@example.com" } }) as never;
  await b.add(mail("a1"));
  clock += 61_000;
  await b.tick();
  await b.add(mail("b1"));
  await b.add(mail("b2"));
  assert.equal((await b.progress())?.total, 3, "one run: nothing restarted");
  for (let i = 0; i < 3; i++) {
    clock += 61_000;
    await b.tick();
  }
  assert.deepEqual(sent, ["mail:a1", "mail:b1"]);
  assert.deepEqual(unread, ["b2"], "the allowance is the run's, spent once");
});

test("backfill: the timer's idle ticks write nothing to the store; a tick that changes something does", async () => {
  const data = new Map<string, string>();
  let writes = 0;
  const kv: Kv = { get: async (k) => data.get(k) ?? null, set: async (k, v) => void (writes++, data.set(k, v)) };
  let clock = Date.UTC(2026, 9, 1);
  const b = createBackfill({ kv, config: { days: 14, allowance: 3, everyMs: 60_000 }, now: () => clock, enqueue: async () => true, notify: async () => undefined });
  for (let i = 0; i < 10; i++) {
    clock += 15_000;
    assert.equal(await b.tick(), "idle", "nothing was ever started");
  }
  assert.equal(writes, 0, "never started: nothing to keep");
  await b.add({ id: "mail:a1", at: clock, text: "x", email: { from: "a@example.com" } } as never);
  assert.equal(writes, 1);
  clock += 61_000;
  assert.equal(await b.tick(), "sent");
  assert.equal(writes, 2, "a tick that hands out an item is written");
  // Waiting for the answer (the timer ticks every 15 s; one is waited for 30 minutes): 25 minutes of ticks, none writes.
  const before = writes;
  for (let i = 0; i < 100; i++) {
    clock += 15_000;
    assert.equal(await b.tick(), "idle");
  }
  assert.equal(writes - before, 0, "waiting for an answer writes nothing");
});
