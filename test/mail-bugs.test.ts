// Mail bugs found in a hunt over the IMAP reader, the catch-up, the sender check, Resend and the mailbox sign-in, each proven here first:
// a first look cut short (the rest of it told as news, the catch-up lost), a forged "own" mail closing what it names, a server's day for
// SINCE, the Sent folder lost for good to one failed LIST, an opaque AgentMail inbox as Resend's reply_to, a full catch-up queue, a shared
// registry suffix taken for one sender's domain, a switched sign-in method left half in place, and a login check left open.

import assert from "node:assert/strict";
import test from "node:test";
import { createBackfill } from "../src/backfill.ts";
import { createImapReader, loadImapConfig, type ImapClient, type ImapConfig, type ImapConnect } from "../src/imap.ts";
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
