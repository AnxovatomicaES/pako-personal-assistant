// The owner's own mailbox, read only by IMAP (src/imap.ts): the settings, the plain MIME reading, the read-only calls (a fake client that
// records each one, and real imapflow against a fake TLS server whose command log is checked), the first look's 24 hours, UIDVALIDITY,
// failures said once with backoff and no password anywhere, STOP, and the mail intake reused (codes hidden, mass mail, VIP, the summary queue).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer as createTlsServer, type TLSSocket } from "node:tls";
import { CATALOGUE, connectionStates } from "../src/connections.ts";
import { createControl } from "../src/control.ts";
import {
  backoffMinutes, createImapReader, decodeHeader, failKind, imapflowConnect, loadImapConfig, parseMessage,
  type ImapClient, type ImapConfig, type ImapConnect, type ImapFetched, type ImapMailbox,
} from "../src/imap.ts";
import type { Kv } from "../src/kv.ts";
import { addressOf, createMailbox, takeMail } from "../src/mail.ts";
import type { Inbound } from "../src/whatsapp.ts";

const PASSWORD = "app-pass-wxyz-9876";
const OAUTH_USER = "ana@outlook.example";
const OAUTH_TOKEN = "EwB4A8l6BAAU-access-token-1";
const CONFIG: ImapConfig = {
  host: "imap.example.com", port: 993, user: "ana@example.com", password: PASSWORD, folders: ["INBOX"], pollMinutes: 5,
  workDomains: ["empresa.example"], vip: ["@jefe.example"],
};
const HOUR = 3600_000;
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);

function memoryKv(): Kv & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v) };
}

function mail(o: { id?: string; from?: string; subject?: string; body?: string; headers?: string[] }): Buffer {
  const head = [
    `From: ${o.from ?? "Luis <luis@amigos.example>"}`,
    "To: Ana <ana@example.com>",
    `Subject: ${o.subject ?? "Cena"}`,
    ...(o.id === "" ? [] : [`Message-ID: <${o.id ?? Math.random().toString(36).slice(2)}@amigos.example>`]),
    ...(o.headers ?? []),
    "Content-Type: text/plain; charset=utf-8",
  ];
  return Buffer.from(`${head.join("\r\n")}\r\n\r\n${o.body ?? "¿Cenamos el viernes?"}\r\n`, "utf8");
}

interface FakeMsg {
  uid: number;
  at: number;
  source: Buffer;
}

/** A client that records every call (the command log) and answers from folders kept here. */
function fakeImap(
  folders: Record<string, { validity: number; msgs: FakeMsg[] }>,
  o: { connectError?: unknown; failFetchAt?: number; refuseSearch?: boolean } = {},
) {
  const calls: string[] = [];
  const make = (): ImapClient => {
    let open = "";
    const client = {
      connect: async () => {
        calls.push("connect");
        if (o.connectError) throw o.connectError;
      },
      mailboxOpen: async (path: string, opts: { readOnly: true }): Promise<ImapMailbox> => {
        calls.push(`open ${path} readOnly=${opts.readOnly}`);
        const f = folders[path];
        if (!f) throw Object.assign(new Error("Mailbox doesn't exist"), { serverResponseCode: "NONEXISTENT", responseStatus: "NO" });
        open = path;
        return { uidValidity: BigInt(f.validity), uidNext: Math.max(0, ...f.msgs.map((m) => m.uid)) + 1, readOnly: true };
      },
      search: async (q: { since: Date; uid?: string }) => {
        calls.push(`search ${q.uid ?? ""}`.trim());
        // What imapflow resolves when the server answers NO or BAD to the SEARCH.
        if (o.refuseSearch) return false;
        const from = q.uid ? Number(q.uid.split(":")[0]) : 1;
        const day = Date.UTC(q.since.getUTCFullYear(), q.since.getUTCMonth(), q.since.getUTCDate());
        return folders[open]!.msgs.filter((m) => m.uid >= from && m.at >= day).map((m) => m.uid);
      },
      fetchOne: async (uid: string, query: { source: { maxLength: number } }): Promise<ImapFetched | false> => {
        calls.push(`fetch ${uid} peek max=${query.source.maxLength}`);
        if (o.failFetchAt === Number(uid)) throw Object.assign(new Error("Connection closed"), { code: "NoConnection" });
        const m = folders[open]!.msgs.find((x) => x.uid === Number(uid));
        return m ? { uid: m.uid, internalDate: new Date(m.at), source: m.source } : false;
      },
      logout: async () => void calls.push("logout"),
      close: () => void calls.push("close"),
      on: () => client,
    };
    return client;
  };
  return { calls, connect: () => make() };
}

function rig(folders: Parameters<typeof fakeImap>[0], over: { config?: Partial<ImapConfig>; fake?: Parameters<typeof fakeImap>[1] } = {}) {
  const kv = memoryKv();
  const queued: Inbound[] = [];
  const told: string[] = [];
  const box = createMailbox(null);
  const control = createControl(null);
  let clock = NOW;
  const fake = fakeImap(folders, over.fake);
  const reader = createImapReader({
    config: { ...CONFIG, ...over.config },
    kv,
    box,
    control,
    now: () => clock,
    connect: fake.connect,
    enqueue: async (m) => (queued.push(m), true),
    notify: async (text) => void told.push(text),
  });
  return { reader, kv, box, control, queued, told, fake, tick: (ms: number) => (clock += ms), now: () => clock };
}

/** Everything written to the console while `fn` runs. */
async function captured<T>(fn: () => Promise<T>): Promise<{ value: T; out: string }> {
  const lines: string[] = [];
  const { log, error, warn } = console;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  console.warn = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    return { value: await fn(), out: lines.join("\n") };
  } finally {
    Object.assign(console, { log, error, warn });
  }
}

test("loadImapConfig: off with nothing set; 993, INBOX and 5 minutes by default; port 143 and wildcards refused; the shared lists", () => {
  assert.deepEqual(loadImapConfig({}), { config: null, problems: [] });
  const ok = loadImapConfig({ IMAP_HOST: "imap.gmail.com", IMAP_USER: "ana@gmail.com", IMAP_PASSWORD: "abcd efgh ijkl mnop", AGENTMAIL_VIP: "@jefe.example" });
  assert.equal(ok.config?.port, 993);
  assert.deepEqual(ok.config?.folders, ["INBOX"]);
  assert.equal(ok.config?.pollMinutes, 5);
  assert.deepEqual(ok.config?.vip, ["@jefe.example"]);
  const base = { IMAP_HOST: "imap.gmail.com", IMAP_USER: "ana@gmail.com", IMAP_PASSWORD: "x" };
  assert.match(loadImapConfig({ ...base, IMAP_PORT: "143" }).problems.join(), /IMAP_PORT .*TLS/);
  assert.match(loadImapConfig({ ...base, IMAP_FOLDERS: "INBOX, *" }).problems.join(), /IMAP_FOLDERS/);
  assert.match(loadImapConfig({ ...base, IMAP_HOST: "http://x" }).problems.join(), /IMAP_HOST/);
  assert.match(loadImapConfig({ ...base, IMAP_POLL_MINUTES: "0" }).problems.join(), /IMAP_POLL_MINUTES/);
  assert.match(loadImapConfig({ IMAP_HOST: "imap.gmail.com" }).problems.join(), /IMAP_USER.*IMAP_PASSWORD|IMAP_PASSWORD/);
  // The password never appears in a problem sentence.
  assert.ok(!loadImapConfig({ ...base, IMAP_PASSWORD: `${PASSWORD}\u0000`, IMAP_PORT: "143" }).problems.join().includes(PASSWORD));
});

test("parseMessage: encoded words, a multipart with quoted-printable and base64 parts, a latin1 charset, attachments named, HTML alone", () => {
  assert.equal(decodeHeader("=?utf-8?B?wqFIb2xh?= =?utf-8?Q?_Marta=21?="), "¡Hola Marta!");
  assert.equal(decodeHeader("Re: =?iso-8859-1?Q?Caf=E9?= mañana"), "Re: Café mañana");
  const src = [
    "From: =?utf-8?Q?Mar=C3=ADa?= <maria@x.example>",
    "Subject: =?utf-8?B?UmV1bmnDs24=?=",
    "Message-ID: <a1@x.example>",
    'Content-Type: multipart/mixed; boundary="out"',
    "",
    "--out",
    'Content-Type: multipart/alternative; boundary="alt"',
    "",
    "--alt",
    "Content-Type: text/plain; charset=iso-8859-1",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Nos vemos ma=F1ana a las 10, =",
    "en la sala.",
    "--alt",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("<p>HTML</p>").toString("base64"),
    "--alt--",
    "--out",
    "Content-Type: application/pdf; name=\"orden.pdf\"",
    "Content-Disposition: attachment; filename*=utf-8''acta%20reuni%C3%B3n.pdf",
    "Content-Transfer-Encoding: base64",
    "",
    "JVBERi0=",
    "--out--",
    "",
  ].join("\r\n");
  const p = parseMessage(Buffer.from(src, "latin1"));
  assert.equal(p.from, "María <maria@x.example>");
  assert.equal(p.subject, "Reunión");
  assert.equal(p.text?.trim(), "Nos vemos mañana a las 10, en la sala.");
  assert.equal(p.html, "<p>HTML</p>");
  assert.deepEqual(p.attachments, ["acta reunión.pdf"]);
  const htmlOnly = parseMessage(Buffer.from("Subject: x\r\nContent-Type: text/html\r\n\r\n<b>solo</b>"));
  assert.equal(htmlOnly.text, undefined);
  assert.equal(htmlOnly.html, "<b>solo</b>");
  // A hostile structure is read in bounded time and never throws: nesting past the limit, a boundary that never closes.
  let deep = "Content-Type: text/plain\r\n\r\nfondo";
  for (let i = 0; i < 50; i++) deep = `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n${deep}\r\n--b${i}--`;
  assert.equal(parseMessage(Buffer.from(deep)).text, undefined);
  const open = parseMessage(Buffer.from(`Content-Type: multipart/mixed; boundary=z\r\n\r\n--z\r\n\r\nhola\r\n${"--z\r\n".repeat(5000)}`));
  assert.equal(open.text, "hola");
});

test("first look: folders opened read-only, only the last 24 hours, nothing but connect, EXAMINE, search, PEEK fetch and logout", async () => {
  const folders = {
    INBOX: {
      validity: 7,
      msgs: [
        { uid: 1, at: NOW - 30 * HOUR, source: mail({ id: "old" }) },
        { uid: 2, at: NOW - 2 * HOUR, source: mail({ id: "new", subject: "Cena del viernes" }) },
      ],
    },
  };
  const r = rig(folders);
  const out = await r.reader.poll();
  assert.equal(out.queued, 1);
  assert.equal(out.old, 1, "older than 24 hours: never announced");
  assert.equal(r.queued.length, 1);
  assert.match(r.queued[0]!.id, /^mail:imap:[0-9a-f]{32}$/);
  assert.equal(r.queued[0]!.email?.subject, "Cena del viernes");
  assert.equal(r.queued[0]!.email?.account, "personal");
  for (const c of r.fake.calls) assert.match(c, /^(connect|open \S+ readOnly=true|search.*|fetch \d+ peek max=\d+|logout)$/);
  assert.ok(r.fake.calls.includes("open INBOX readOnly=true"));
  assert.deepEqual(JSON.parse(r.kv.data.get("assistant-imap")!).folders.INBOX, { v: "7", last: 2 });

  // The next look asks only for the UIDs above the last one, and passes on the new mail only.
  folders.INBOX.msgs.push({ uid: 3, at: NOW + 1000, source: mail({ id: "third" }) });
  r.tick(5 * 60_000);
  r.fake.calls.length = 0;
  assert.equal((await r.reader.poll()).queued, 1);
  assert.ok(r.fake.calls.includes("search 3:*"));
  assert.deepEqual(r.fake.calls.filter((c) => c.startsWith("fetch")), ["fetch 3 peek max=262144"]);
});

test("a SEARCH the server refuses is a failed look, not an empty one: the pointer stays and the mail that came meanwhile is read next time", async () => {
  const folders = { INBOX: { validity: 7, msgs: [{ uid: 1, at: NOW - HOUR, source: mail({ id: "before" }) }] } };
  const opts = { refuseSearch: false };
  const r = rig(folders, { fake: opts });
  await r.reader.poll();
  const pointer = () => JSON.parse(r.kv.data.get("assistant-imap")!).folders.INBOX;
  assert.deepEqual(pointer(), { v: "7", last: 1 });
  // Three emails arrive; the server refuses this one SEARCH (a temporary failure).
  for (const uid of [2, 3, 4]) folders.INBOX.msgs.push({ uid, at: NOW + uid * 60_000, source: mail({ id: `new-${uid}`, subject: `Contract ${uid}` }) });
  r.tick(5 * 60_000);
  opts.refuseSearch = true;
  const refused = await captured(() => r.reader.poll());
  assert.equal(refused.value.skipped, "failed", "a refused search is a failed look");
  assert.deepEqual(pointer(), { v: "7", last: 1 }, "the folder's pointer did not move past mail that was never read");
  assert.match(r.reader.problem("en") ?? "", /unexpected/, "the card says something is wrong");
  assert.equal((await r.reader.poll()).skipped, "waiting", "and it backs off");
  // The server is fine again: the three emails are read, none was skipped for good.
  opts.refuseSearch = false;
  r.tick(10 * 60_000);
  const next = await captured(() => r.reader.poll());
  assert.equal(next.value.queued, 3);
  assert.deepEqual(r.queued.slice(1).map((m) => m.email?.subject), ["Contract 2", "Contract 3", "Contract 4"]);
  assert.deepEqual(pointer(), { v: "7", last: 4 });
  assert.equal(r.reader.problem("en"), null);
});

test("connecting a mailbox: the last 24 hours are read quietly (kept, never told) with one Connected line; mail after that is news", async () => {
  const msgs = Array.from({ length: 10 }, (_, i) => ({ uid: i + 1, at: NOW - (i + 1) * HOUR, source: mail({ id: `day-${i}`, subject: `Mail ${i}` }) }));
  // One VIP among them: even that one waits, because it was already in the mailbox before Pako watched it.
  msgs.push({ uid: 11, at: NOW - 30 * 60_000, source: mail({ id: "boss", from: "Jefa <jefa@jefe.example>" }) });
  const folders = { INBOX: { validity: 3, msgs } };
  const r = rig(folders);
  const first = await r.reader.poll();
  assert.equal(first.queued, 11);
  assert.equal(first.quiet, 11);
  assert.equal(first.connected, true);
  assert.equal(r.queued.length, 11, "kept and summarized, so the follow-ups can still find what was asked");
  assert.ok(r.queued.every((m) => m.email?.quiet === true), "every one marked quiet: the bridge tells none of them");
  assert.deepEqual(r.told, ["Connected to ana@example.com. I'll tell you about new mail that needs you."]);

  // Mail that arrives after the connection is news as before, and the line is never said again.
  folders.INBOX.msgs.push({ uid: 12, at: NOW + 60_000, source: mail({ id: "after" }) });
  r.tick(5 * 60_000);
  const next = await r.reader.poll();
  assert.equal(next.queued, 1);
  assert.equal(next.quiet, 0);
  assert.equal(next.connected, undefined);
  assert.equal(r.queued.at(-1)!.email?.quiet, undefined, "told as any new email");
  assert.equal(r.told.length, 1);

  // A renumbered folder is read again just as quietly, and without the line.
  folders.INBOX = { validity: 4, msgs: [{ uid: 1, at: NOW + 2 * 60_000, source: mail({ id: "renumbered" }) }] };
  r.tick(5 * 60_000);
  const again = await captured(() => r.reader.poll());
  assert.equal(again.value.quiet, 1);
  assert.equal(r.queued.at(-1)!.email?.quiet, true);
  assert.equal(r.told.length, 1);
});

test("connecting: a state saved before the greeting existed counts as told (an update never says Connected); a new account says it", async () => {
  const folders = { INBOX: { validity: 3, msgs: [{ uid: 5, at: NOW + 1000, source: mail({ id: "n" }) }] } };
  const r = rig(folders);
  await r.kv.set("assistant-imap", JSON.stringify({ who: "ana@example.com@imap.example.com:993", folders: { INBOX: { v: "3", last: 4 } } }), 60);
  const out = await r.reader.poll();
  assert.equal(out.queued, 1);
  assert.equal(out.quiet, 0);
  assert.deepEqual(r.told, []);
  const other = rig(folders, { config: { user: "bea@example.com" } });
  await other.kv.set("assistant-imap", r.kv.data.get("assistant-imap")!, 60);
  await other.reader.poll();
  assert.deepEqual(other.told, ["Connected to bea@example.com. I'll tell you about new mail that needs you."], "another account is a new connection");
});

test("UIDVALIDITY changes: the folder is read again from the last 24 hours, and mail already passed on is not passed on twice", async () => {
  const folders = { INBOX: { validity: 7, msgs: [{ uid: 10, at: NOW - HOUR, source: mail({ id: "same" }) }] } };
  const r = rig(folders);
  assert.equal((await r.reader.poll()).queued, 1);
  // The server renumbered: the same email has another UID, and a new one arrived.
  folders.INBOX = { validity: 8, msgs: [{ uid: 1, at: NOW - HOUR, source: mail({ id: "same" }) }, { uid: 2, at: NOW - 60_000, source: mail({ id: "fresh" }) }] };
  r.tick(60_000);
  const { value: out, out: said } = await captured(() => r.reader.poll());
  assert.equal(out.queued, 1);
  assert.equal(r.queued.length, 2);
  assert.match(said, /renumbered/);
  assert.deepEqual(JSON.parse(r.kv.data.get("assistant-imap")!).folders.INBOX, { v: "8", last: 2 });
});

test("an email forwarded to Pako's inbox and read by IMAP too is taken once (Message-ID and sender); a copied Message-ID from someone else is not hidden", async () => {
  const folders = {
    INBOX: {
      validity: 1,
      msgs: [
        { uid: 1, at: NOW - HOUR, source: mail({ id: "cena-1" }) },
        { uid: 2, at: NOW - HOUR, source: mail({ id: "cena-1", from: "Eve <eve@evil.example>" }) },
      ],
    },
  };
  const r = rig(folders);
  // AgentMail's copy first, with its own id and the original headers (any case, any brackets).
  const deps = { box: r.box, enqueue: async (m: Inbound) => (r.queued.push(m), true), lang: () => "en" as const, now: r.now, vip: [] };
  const forwarded = { message_id: "<agentmail-abc>", from: "Luis <LUIS@amigos.example>", subject: "Cena", text: "¿Cenamos el viernes?", headers: { "message-id": " <CENA-1@amigos.example> " } };
  assert.equal(await takeMail(deps, "agentmail-abc", forwarded, "personal"), "queued");
  assert.equal(await takeMail(deps, "agentmail-abc2", { ...forwarded, message_id: "x" }, "personal"), "seen", "a second copy by AgentMail too");
  const out = await r.reader.poll();
  assert.equal(out.queued, 1, "only Eve's, whose Message-ID was copied");
  assert.deepEqual(r.queued.map((m) => m.email!.from), ["Luis <LUIS@amigos.example>", "Eve <eve@evil.example>"]);
});

test("the mail intake is the same: codes hidden and kept for CODE, mass mail filed without Claude, VIP, work, own mail skipped", async () => {
  const folders = {
    INBOX: {
      validity: 1,
      msgs: [
        { uid: 1, at: NOW - 60_000, source: mail({ subject: "Tu código", body: "Tu código de verificación es 482913. No lo compartas." }) },
        { uid: 2, at: NOW - HOUR, source: mail({ from: "Ofertas <news@tienda.example>", headers: ["Authentication-Results: mx.example.com; dmarc=pass header.from=tienda.example", "List-Unsubscribe: <mailto:u@tienda.example>"] }) },
        { uid: 3, at: NOW - HOUR, source: mail({ from: "Jefa <jefa@jefe.example>", headers: ["List-Id: equipo"] }) },
        { uid: 4, at: NOW - HOUR, source: mail({ from: "Ana <ana@example.com>", subject: "Nota para mí" }) },
      ],
    },
  };
  const r = rig(folders);
  const out = await r.reader.poll();
  assert.equal(out.queued, 2, "the code email and the VIP's, even sent to a list");
  assert.equal(out.stored, 1, "mass mail is kept, not summarized");
  const code = r.queued.find((q) => q.email?.subject === "Tu código")!;
  assert.ok(!code.email!.text.includes("482913"));
  assert.match(code.email!.text, /code hidden/);
  assert.deepEqual((await r.box.codes(NOW)).map((c) => c.codes), [["482913"]]);
  assert.equal(r.queued.find((q) => q.email?.from.includes("jefe.example"))!.email?.vip, true);
  assert.ok(!r.queued.some((q) => q.email?.subject === "Nota para mí"), "the owner's own mail is not news");
  // The summary from the isolated run lands on the same mailbox record, as for Pako's own inbox.
  assert.equal(await r.box.annotate(code.id.replace(/^mail:/, ""), "guardado", "Un código de acceso.", NOW), true);
  assert.match((await r.box.digest("Europe/Madrid", NOW)), /Promotions \(1\): Ofertas/);
  const work = rig({ INBOX: { validity: 1, msgs: [{ uid: 1, at: NOW - HOUR, source: mail({ id: "w" }) }] } }, { config: { user: "ana@empresa.example" } });
  await work.reader.poll();
  assert.equal(work.queued[0]!.email?.account, "trabajo");
});

test("a refused login is said once (log and card, in English), backs off, never shows the password; reading again is said once", async () => {
  const err = Object.assign(new Error(`LOGIN ana@example.com ${PASSWORD} failed`), { authenticationFailed: true, executedCommand: `a LOGIN x ${PASSWORD}` });
  const r = rig({ INBOX: { validity: 1, msgs: [] } }, { fake: { connectError: err } });
  const first = await captured(() => r.reader.poll());
  assert.equal(first.value.skipped, "failed");
  assert.match(first.out, /login was refused; trying again in 30 min/);
  assert.match(r.reader.problem("en")!, /app password/);
  assert.equal((await r.reader.poll()).skipped, "waiting", "not before the backoff");
  r.tick(31 * 60_000);
  const second = await captured(() => r.reader.poll());
  assert.equal(second.value.skipped, "failed");
  assert.equal(second.out, "", "the same failure is not said again");
  const log = await r.control.recent(50);
  assert.equal(log.filter((l) => l.kind === "failure").length, 1);
  for (const text of [first.out, second.out, ...log.map((l) => l.text), r.reader.problem("en")!]) assert.ok(!text.includes(PASSWORD));
  assert.deepEqual([1, 2, 3, 5, 9].map((n) => backoffMinutes("auth", n, 5)), [30, 60, 120, 360, 360]);
  assert.deepEqual([1, 2, 5].map((n) => backoffMinutes("network", n, 5)), [5, 10, 60]);
  assert.equal(failKind({ code: "ENOTFOUND" }), "network");
  assert.equal(failKind({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }), "tls");
  assert.equal(failKind({ serverResponseCode: "AUTHENTICATIONFAILED" }), "auth");
});

test("recovery: the next good look clears the card and says once that it reads again", async () => {
  const folders = { INBOX: { validity: 1, msgs: [] as FakeMsg[] } };
  const opts: { connectError?: unknown } = { connectError: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) };
  const r = rig(folders, { fake: opts });
  await captured(() => r.reader.poll());
  assert.match(r.reader.problem("en")!, /couldn't reach imap\.example\.com/);
  delete opts.connectError;
  r.tick(6 * 60_000);
  await captured(() => r.reader.poll());
  assert.equal(r.reader.problem("en"), null);
  assert.equal((await r.control.recent(50)).filter((l) => /Reading your mail again/.test(l.text)).length, 1);
});

test("STOP: no login at all while paused; a missing folder is said once and the others are still read; a failed fetch is tried again", async () => {
  const r = rig({ INBOX: { validity: 1, msgs: [{ uid: 1, at: NOW - HOUR, source: mail({}) }] } }, { config: { folders: ["Nope", "INBOX"] } });
  await r.control.setPaused(true, NOW);
  assert.equal((await r.reader.poll()).skipped, "paused");
  assert.deepEqual(r.fake.calls, []);
  await r.control.setPaused(false, NOW);
  const { value } = await captured(() => r.reader.poll());
  assert.equal(value.queued, 1);
  assert.match(r.reader.problem("en")!, /folder “Nope”/);

  const folders = { INBOX: { validity: 1, msgs: [1, 2, 3].map((uid) => ({ uid, at: NOW - HOUR, source: mail({ id: `m${uid}` }) })) } };
  const f = rig(folders, { fake: { failFetchAt: 2 } });
  await captured(() => f.reader.poll());
  assert.equal(f.queued.length, 1);
  assert.equal(JSON.parse(f.kv.data.get("assistant-imap")!).folders.INBOX.last, 1, "the pointer stays before the one that failed");
});

// ---------- real imapflow against a fake TLS server: the command log on the wire ----------

/** A self-signed certificate for localhost, made with openssl; null where there is no openssl (the wire tests are skipped then). */
function testCert(): { key: Buffer; cert: Buffer } | null {
  try {
    const dir = mkdtempSync(join(tmpdir(), "pako-imap-"));
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1",
      "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
    ], { stdio: "ignore" });
    return { key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) };
  } catch {
    return null;
  }
}

const imapDate = (ms: number): string => {
  const d = new Date(ms);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}-${mon}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
};

/** Just enough IMAP for imapflow's reading: every command line it sends is kept in `log`. */
function imapSession(socket: Socket | TLSSocket, log: string[], msgs: FakeMsg[]): void {
  let buf = "";
  let waiting = 0;
  const send = (s: string) => socket.write(s, "latin1");
  socket.setEncoding("latin1");
  // A client that gives up (a TLS handshake against this plain greeting, a certificate it does not trust) drops the connection with bytes
  // still in flight, and this end reads a reset (ECONNRESET). That is the client's failure to report, not the server's: unheard, it would be
  // an uncaught exception that fails whichever test is running (it did, under the load of the whole gate).
  socket.on("error", () => undefined);
  send("* OK [CAPABILITY IMAP4rev1 SASL-IR AUTH=XOAUTH2] fake ready\r\n");
  socket.on("data", (chunk: string) => {
    buf += chunk;
    for (;;) {
      if (waiting) {
        if (buf.length < waiting) return;
        waiting = 0;
      }
      const lit = /\{(\d+)\+?\}\r\n/.exec(buf);
      const nl = buf.indexOf("\r\n");
      if (nl < 0) return;
      if (lit && lit.index + lit[0].length - 2 === nl) {
        // A literal: the line goes on after its bytes.
        if (!lit[0].includes("+")) send("+ go\r\n");
        const need = nl + 2 + Number(lit[1]);
        if (buf.length < need) return;
        const rest = buf.slice(need);
        const lineEnd = rest.indexOf("\r\n");
        if (lineEnd < 0) return;
        const line = buf.slice(0, need) + rest.slice(0, lineEnd);
        buf = rest.slice(lineEnd + 2);
        handle(line);
        continue;
      }
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      handle(line);
    }
  });
  const handle = (line: string) => {
    log.push(line);
    const [tag, cmd = "", ...args] = line.split(" ");
    const rest = args.join(" ");
    const c = cmd.toUpperCase();
    if (c === "CAPABILITY") return send(`* CAPABILITY IMAP4rev1 SASL-IR AUTH=XOAUTH2\r\n${tag} OK done\r\n`);
    // XOAUTH2 (Microsoft's and Google's IMAP): "user=<address>^Aauth=Bearer <token>^A^A", base64, on the same line (SASL-IR).
    if (c === "AUTHENTICATE") {
      const said = Buffer.from(args[1] ?? "", "base64").toString("utf8");
      return send(args[0]?.toUpperCase() === "XOAUTH2" && said === `user=${OAUTH_USER}\x01auth=Bearer ${OAUTH_TOKEN}\x01\x01`
        ? `${tag} OK [CAPABILITY IMAP4rev1] in\r\n` : `${tag} NO [AUTHENTICATIONFAILED] no\r\n`);
    }
    if (c === "LOGIN") return send(line.includes(PASSWORD) ? `${tag} OK [CAPABILITY IMAP4rev1] in\r\n` : `${tag} NO [AUTHENTICATIONFAILED] no\r\n`);
    if (c === "LIST") return send(`* LIST (\\HasNoChildren) "/" INBOX\r\n${tag} OK done\r\n`);
    if (c === "EXAMINE") {
      return send(`* FLAGS (\\Seen)\r\n* ${msgs.length} EXISTS\r\n* OK [UIDVALIDITY 42] v\r\n* OK [UIDNEXT ${msgs.length + 1}] n\r\n${tag} OK [READ-ONLY] done\r\n`);
    }
    if (c === "UID" && /^SEARCH/i.test(rest)) return send(`* SEARCH ${msgs.map((m) => m.uid).join(" ")}\r\n${tag} OK done\r\n`);
    if (c === "UID" && /^FETCH/i.test(rest)) {
      const uid = Number(rest.split(" ")[1]);
      const m = msgs.find((x) => x.uid === uid);
      if (m) {
        const body = m.source.toString("latin1");
        send(`* ${uid} FETCH (UID ${uid} INTERNALDATE "${imapDate(m.at)}" BODY[]<0> {${m.source.length}}\r\n${body})\r\n`);
      }
      return send(`${tag} OK done\r\n`);
    }
    if (c === "LOGOUT") {
      send(`* BYE bye\r\n${tag} OK done\r\n`);
      return void socket.end();
    }
    send(`${tag} OK done\r\n`);
  };
}

async function listenOn(server: NetServer): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return (server.address() as { port: number }).port;
}

const cert = testCert();

test("wire: real imapflow over TLS sends EXAMINE and BODY.PEEK only (no SELECT, STORE, COPY, MOVE, EXPUNGE, APPEND), and logs no password", { skip: !cert && "no openssl here" }, async () => {
  const log: string[] = [];
  const now = Date.now();
  const msgs = [{ uid: 1, at: now - HOUR, source: mail({ subject: "Por el cable", body: "Código de acceso: 771204" }) }];
  const server = createTlsServer({ key: cert!.key, cert: cert!.cert }, (s) => imapSession(s, log, msgs));
  const port = await listenOn(server);
  try {
    const queued: Inbound[] = [];
    const reader = createImapReader({
      config: { ...CONFIG, host: "localhost", port },
      kv: memoryKv(),
      box: createMailbox(null),
      connect: imapflowConnect({ ca: cert!.cert }),
      enqueue: async (m) => (queued.push(m), true),
    });
    const { value, out } = await captured(() => reader.poll());
    assert.equal(value.skipped, undefined, out);
    assert.equal(queued.length, 1, `${JSON.stringify(value)}\n${log.join("\n")}\n${out}`);
    assert.equal(queued[0]!.email?.subject, "Por el cable");
    assert.ok(!queued[0]!.email!.text.includes("771204"), "the code is hidden");
    const commands = log.map((l) => l.split(" ")[1]?.toUpperCase());
    assert.ok(commands.includes("EXAMINE"));
    for (const bad of ["SELECT", "STORE", "COPY", "MOVE", "EXPUNGE", "APPEND", "DELETE", "IDLE", "RENAME", "CREATE"]) assert.ok(!commands.includes(bad), bad);
    assert.ok(!log.some((l) => /^\S+ UID (STORE|COPY|MOVE|EXPUNGE)/i.test(l)));
    const fetches = log.filter((l) => /^\S+ UID FETCH/i.test(l));
    assert.equal(fetches.length, 1);
    assert.match(fetches[0]!, /BODY\.PEEK\[\]/);
    assert.ok(!/\bBODY\[/.test(fetches[0]!), "never a fetch that would mark it read");
    assert.ok(!out.includes(PASSWORD));
  } finally {
    server.close();
  }
});

test("wire: an account signed in with its provider logs in with XOAUTH2 and a fresh access token, never a password", { skip: !cert && "no openssl here" }, async () => {
  const log: string[] = [];
  const msgs = [{ uid: 1, at: Date.now() - HOUR, source: mail({ subject: "Signed in", body: "hello" }) }];
  const server = createTlsServer({ key: cert!.key, cert: cert!.cert }, (sock) => imapSession(sock, log, msgs));
  const port = await listenOn(server);
  try {
    const env = { IMAP_HOST: "outlook.office365.com", IMAP_USER: OAUTH_USER, IMAP_OAUTH: "microsoft", IMAP_REFRESH_TOKEN: "M.R3_BAY.refresh-token-one",
      PAKO_MS_CLIENT_ID: "11111111-2222-3333-4444-555555555555" };
    const loaded = loadImapConfig(env);
    assert.deepEqual(loaded.problems, []);
    assert.equal(loaded.config!.password, "");
    assert.deepEqual(loaded.config!.oauth, { provider: "microsoft", clientId: "11111111-2222-3333-4444-555555555555", refreshToken: "M.R3_BAY.refresh-token-one" });
    assert.match(loadImapConfig({ ...env, PAKO_MS_CLIENT_ID: "" }).problems.join(" "), /PAKO_MS_CLIENT_ID/, "no client registered: said, and off");
    let asked = 0;
    const queued: Inbound[] = [];
    const reader = createImapReader({
      config: { ...loaded.config!, host: "localhost", port }, kv: memoryKv(), box: createMailbox(null), connect: imapflowConnect({ ca: cert!.cert }),
      enqueue: async (m) => (queued.push(m), true), tokens: async () => (asked++, OAUTH_TOKEN),
    });
    const { value, out } = await captured(() => reader.poll());
    assert.equal(value.skipped, undefined, `${out}\n${log.join("\n")}`);
    assert.equal(asked, 1, "a fresh token for the look");
    assert.equal(queued.length, 1);
    assert.ok(log.some((l) => /^\S+ AUTHENTICATE XOAUTH2 /i.test(l)), "XOAUTH2");
    assert.ok(!log.some((l) => /^\S+ LOGIN /i.test(l)), "never LOGIN");
    assert.ok(!out.includes(OAUTH_TOKEN), "the token is never logged");
    // A sign-in the provider no longer takes: the card says "Sign in again", and nothing is tried against the server.
    const revoked = createImapReader({
      config: { ...loaded.config!, host: "localhost", port }, kv: memoryKv(), box: createMailbox(null), connect: imapflowConnect({ ca: cert!.cert }),
      enqueue: async () => true, lang: () => "en",
      tokens: async () => { throw Object.assign(new Error("Microsoft wants you to sign in again"), { code: "EOAUTHSIGNIN" }); },
    });
    const before = log.length;
    await captured(() => revoked.poll());
    assert.match(String(revoked.problem("en")), /^Sign in again/);
    assert.equal(log.length, before, "no login tried");
    assert.equal(failKind(Object.assign(new Error("x"), { code: "EOAUTHSIGNIN" })), "signIn");
    assert.equal(backoffMinutes("signIn", 1, 5), 30, "as slow as a refused password");
  } finally {
    server.close();
  }
});

test("wire: a server without TLS, or with a certificate not trusted, never gets the login; the failure is TLS or network", { skip: !cert && "no openssl here" }, async () => {
  const plainLog: string[] = [];
  const plain = createNetServer((s) => imapSession(s, plainLog, []));
  const plainPort = await listenOn(plain);
  const untrustedLog: string[] = [];
  const untrusted = createTlsServer({ key: cert!.key, cert: cert!.cert }, (s) => imapSession(s, untrustedLog, []));
  const untrustedPort = await listenOn(untrusted);
  try {
    for (const [port, connect] of [[plainPort, imapflowConnect({ ca: cert!.cert })], [untrustedPort, imapflowConnect()]] as const) {
      const reader = createImapReader({
        config: { ...CONFIG, host: "localhost", port },
        kv: null,
        box: createMailbox(null),
        connect,
        enqueue: async () => true,
      });
      const { value, out } = await captured(() => reader.poll());
      assert.equal(value.skipped, "failed");
      assert.ok(!out.includes(PASSWORD));
      assert.match(reader.problem("en")!, /secure connection|couldn't reach/);
    }
    assert.ok(![...plainLog, ...untrustedLog].some((l) => /LOGIN|AUTHENTICATE/i.test(l)), "no credentials sent");
  } finally {
    plain.close();
    untrusted.close();
  }
});

test("the Connections card: an IMAP entry whose wrong values are named, and the running problem shown on it", () => {
  const imap = CATALOGUE.find((c) => c.id === "imap")!;
  assert.deepEqual(imap.fields.map((f) => f.key), ["IMAP_HOST", "IMAP_USER", "IMAP_PASSWORD", "IMAP_OAUTH", "IMAP_REFRESH_TOKEN", "IMAP_PORT", "IMAP_FOLDERS", "IMAP_POLL_MINUTES"]);
  assert.deepEqual(imap.check!({ IMAP_HOST: "imap.gmail.com", IMAP_USER: "a@gmail.com", IMAP_PASSWORD: "x", IMAP_PORT: "143" }), ["IMAP_PORT"]);
  const states = connectionStates({ env: {}, stored: {}, fromStore: new Set(), lang: "en", problems: { imap: "the login was refused" } });
  assert.equal(states.find((s) => s.id === "imap")?.problem, "the login was refused");
  assert.equal(states.find((s) => s.id === "mail")?.problem, undefined);
});

test("signed in with a provider: a login refused with the held token is tried once with a fresh one, then asks for a new sign-in", async () => {
  const loaded = loadImapConfig({
    IMAP_HOST: "outlook.office365.com", IMAP_USER: OAUTH_USER, IMAP_OAUTH: "microsoft", IMAP_REFRESH_TOKEN: "M.R3_BAY.refresh-token-one",
    PAKO_MS_CLIENT_ID: "11111111-2222-3333-4444-555555555555",
  });
  let asked = 0;
  let forgot = 0;
  const tried: string[] = [];
  const refused = Object.assign(new Error("Command failed"), { authenticationFailed: true });
  const reader = createImapReader({
    config: loaded.config!, kv: memoryKv(), box: createMailbox(null), enqueue: async () => true, lang: () => "en",
    connect: async (c) => {
      tried.push(String((c as { accessToken?: string }).accessToken));
      throw refused;
    },
    tokens: async () => `token-${++asked}`,
    forgetToken: () => void forgot++,
  });
  await captured(() => reader.poll());
  assert.deepEqual(tried, ["token-1", "token-2"], "the held token, then a fresh one");
  assert.equal(forgot, 1);
  assert.match(String(reader.problem("en")), /^Sign in again/, "not the app-password advice");
  // A password account refused keeps its own advice (no token to renew).
  const pw = loadImapConfig({ IMAP_HOST: "imap.example.com", IMAP_USER: "a@example.com", IMAP_PASSWORD: "app-password-xyz" });
  const plain = createImapReader({
    config: pw.config!, kv: memoryKv(), box: createMailbox(null), enqueue: async () => true, lang: () => "en",
    connect: async () => { throw refused; },
  });
  await captured(() => plain.poll());
  assert.doesNotMatch(String(plain.problem("en")), /^Sign in again/);
});

test("signed in with a provider, the login is client.connect(), as with imapflow: a refusal there is retried once with a fresh token", async () => {
  const loaded = loadImapConfig({
    IMAP_HOST: "outlook.office365.com", IMAP_USER: OAUTH_USER, IMAP_OAUTH: "microsoft", IMAP_REFRESH_TOKEN: "M.R3_BAY.refresh-token-one",
    PAKO_MS_CLIENT_ID: "11111111-2222-3333-4444-555555555555",
  });
  const refused = Object.assign(new Error("Command failed"), { authenticationFailed: true });
  let issued = 0;
  let forgot = 0;
  const tried: string[] = [];
  let closed = 0;
  // Shaped like imapflowConnect: the factory only builds the client; the login, and its refusal, is client.connect().
  const connect: ImapConnect = async (c) => {
    const token = String((c as { accessToken?: string }).accessToken);
    const client: ImapClient = {
      connect: async () => {
        tried.push(token);
        if (token === "token-1") throw refused;
      },
      mailboxOpen: async () => ({ uidValidity: 1, uidNext: 1 }), search: async () => [], fetchOne: async () => false,
      logout: async () => undefined, close: () => void closed++, on: () => client,
    };
    return client;
  };
  const reader = createImapReader({
    config: loaded.config!, kv: memoryKv(), box: createMailbox(null), enqueue: async () => true, lang: () => "en", connect,
    tokens: async () => `token-${++issued}`, forgetToken: () => void ((forgot += 1), (issued = 1)),
  });
  const out = await captured(() => reader.poll());
  assert.notEqual(out.value.skipped, "failed", "the second token worked: the look went through");
  assert.deepEqual(tried, ["token-1", "token-2"], "the held token, then a fresh one");
  assert.equal(forgot, 1, "the held token was dropped");
  assert.equal(closed, 1, "the refused connection was closed before the next try (the one that read logged out)");
  assert.equal(reader.problem("en"), null);
  // Refused again with the fresh one: only a new sign-in mends it.
  tried.length = 0;
  const again = createImapReader({
    config: loaded.config!, kv: memoryKv(), box: createMailbox(null), enqueue: async () => true, lang: () => "en",
    connect: async () => {
      const client: ImapClient = {
        connect: async () => { throw refused; }, mailboxOpen: async () => ({ uidValidity: 1 }), search: async () => [], fetchOne: async () => false,
        logout: async () => undefined, close: () => undefined, on: () => client,
      };
      return client;
    },
    tokens: async () => "token-x", forgetToken: () => void forgot++,
  });
  await captured(() => again.poll());
  assert.match(String(again.problem("en")), /^Sign in again/);
});

test("the Sent folder named in IMAP_FOLDERS too: the owner's sent mail is read as theirs (follow-ups), never told as news", async () => {
  const folders: Record<string, FakeMsg[]> = {
    INBOX: [],
    Sent: [{ uid: 1, at: NOW + HOUR, source: mail({ id: "out-1", from: "Ana <ana.work@example.com>", subject: "Re: Cena", body: "I'll book it for Friday." }) }],
  };
  let open = "";
  const client: ImapClient = {
    connect: async () => undefined,
    mailboxOpen: async (path) => ((open = path), { uidValidity: 1, uidNext: Math.max(0, ...folders[path]!.map((m) => m.uid)) + 1 }),
    search: async (q) => folders[open]!.filter((m) => m.uid >= (q.uid ? Number(q.uid.split(":")[0]) : 1)).map((m) => m.uid),
    fetchOne: async (uid) => {
      const m = folders[open]!.find((x) => x.uid === Number(uid));
      return m ? { uid: m.uid, internalDate: new Date(m.at), source: m.source } : false;
    },
    list: async () => [{ path: "INBOX" }, { path: "Sent", specialUse: "\\Sent" }],
    logout: async () => undefined,
    close: () => undefined,
    on: () => client,
  };
  const queued: Inbound[] = [];
  const sent: string[] = [];
  let clock = NOW;
  const reader = createImapReader({
    config: { ...CONFIG, folders: ["INBOX", "Sent"] }, kv: memoryKv(), box: createMailbox(null), now: () => clock, connect: () => client,
    enqueue: async (m) => (queued.push(m), true), sentMail: async (m) => void sent.push(m.text),
  });
  await reader.poll();
  folders.Sent!.push({ uid: 2, at: NOW + 2 * HOUR, source: mail({ id: "out-2", from: "Ana <ana.work@example.com>", subject: "Hola", body: "Sending the deck Monday." }) });
  clock = NOW + 3 * HOUR;
  await reader.poll();
  assert.deepEqual(queued.map((m) => m.email?.subject), [], "the owner's own sent mail is never news to them");
  assert.deepEqual(sent, ["I'll book it for Friday.", "Sending the deck Monday."], "read by the follow-ups as the owner's, as when Sent is not listed");
});

test("parseMessage: an encoded word never makes an address (a From that passes its own DMARC cannot show as a VIP's)", () => {
  // The address a mail server checks is the raw one (stranger@evil.example); a decoder that made "<boss@jefe.example>" out of an encoded
  // word would show, trust and route it as that VIP's.
  const raw = (from: string) => Buffer.from([`From: ${from}`, "To: ana@example.com", "Subject: Urgent", "Message-ID: <e1@evil.example>", "", "Pay this today."].join("\r\n"));
  for (const from of [
    "<stranger@evil.example> =?utf-8?q?=3Cboss=40jefe.example=3E?=",
    "stranger@evil.example =?utf-8?b?PGJvc3NAamVmZS5leGFtcGxlPg==?=",
    "=?utf-8?q?boss=40jefe.example?=",
  ]) {
    const p = parseMessage(raw(from));
    assert.ok(!/<boss@jefe\.example>|^boss@jefe\.example$/.test(p.from), `made an address from an encoded word: ${p.from}`);
    assert.notEqual(addressOf(p.from), "boss@jefe.example");
  }
  // A display name in an encoded word still reads as it should.
  assert.equal(parseMessage(raw("=?utf-8?q?Jos=C3=A9_P=C3=A9rez?= <jose@amigos.example>")).from, "José Pérez <jose@amigos.example>");
});

test("a backoff waits its own length, not the length plus a clock that jumped back meanwhile", async () => {
  const err = Object.assign(new Error("login failed"), { authenticationFailed: true });
  const r = rig({ INBOX: { validity: 1, msgs: [] } }, { fake: { connectError: err } });
  await captured(() => r.reader.poll());
  assert.equal((await r.reader.poll()).skipped, "waiting");
  // The computer's clock is put back a day (it was wrong, and is corrected) and then the 30 minutes go by.
  r.tick(-24 * HOUR);
  r.tick(31 * 60_000);
  assert.equal((await captured(() => r.reader.poll())).value.skipped, "failed", "tried again after its 30 minutes, not after a day more");
});
