// A second mailbox of the owner's (IMAP2_*, connection "imap2"): its settings, a reader of its own that keeps its own place, the mail card's
// "Connect another account" kept in the free slot without touching the first, both mailboxes on the connections page, and the phone's draft
// saying which address to reply from. Made-up people and addresses only; secrets only in a file in a throwaway folder, never a keychain.

process.env.PAKO_SECRET_STORE = "file";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import express from "express";
import { mobileFeed } from "../src/app/mobile.ts";
import { connectionStates, mailSlot, readStored, writeStored } from "../src/connections.ts";
import { privacy } from "../src/data.ts";
import { connectionDetails } from "../src/connections-details.ts";
import { mountConnectionsPanel, type ConnectionsSaver } from "../src/connections-panel.ts";
import { createControl } from "../src/control.ts";
import { createImapReader, loadImapConfig, sentRef, type ImapClient, type ImapConfig, type ImapConnect } from "../src/imap.ts";
import { createAutoconfig, mountMailConnect } from "../src/mail-autoconfig.ts";
import { createMailbox } from "../src/mail.ts";
import { auth, memoryKv, serve } from "./helpers/connect-rig.ts";

const { loopItem } = (await import(new URL("../src/panel/m-model.js", import.meta.url).href)) as { loopItem: (l: unknown, now: number) => { from: string } };
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
const ANA: ImapConfig = { host: "imap.example.com", port: 993, user: "ana@example.com", password: "app-pass-ana-1234", folders: ["INBOX"], pollMinutes: 5, workDomains: [], vip: [] };
const ANA_WORK: ImapConfig = { ...ANA, host: "imap.work.example", user: "ana@work.example", password: "app-pass-work-5678" };

function mail(id: string, to: string, subject: string): Buffer {
  return Buffer.from(`From: Luis <luis@friends.example>\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${id}@friends.example>\r\n`
    + "Content-Type: text/plain; charset=utf-8\r\n\r\nCan we talk on Friday?\r\n", "utf8");
}

/** One read-only fake server per mailbox: its INBOX, and every login it saw. */
function fakeServer(msgs: { uid: number; source: Buffer }[]) {
  const logins: string[] = [];
  const connect = (c: ImapConfig): ImapClient => {
    const client: ImapClient = {
      connect: async () => void logins.push(c.user),
      mailboxOpen: async () => ({ uidValidity: 7n, uidNext: msgs.length + 1, readOnly: true }),
      search: async (q: { uid?: string }) => msgs.filter((m) => m.uid >= (q.uid ? Number(q.uid.split(":")[0]) : 1)).map((m) => m.uid),
      fetchOne: async (uid: string) => {
        const m = msgs.find((x) => x.uid === Number(uid));
        return m ? { uid: m.uid, internalDate: new Date(NOW - 3600_000), source: m.source } : false;
      },
      logout: async () => undefined,
      close: () => undefined,
      on: () => client,
    } as unknown as ImapClient;
    return client;
  };
  return { logins, connect };
}

test("loadImapConfig reads the second mailbox's own keys (IMAP2_*) and names them in its problems; the first's keys are not its", () => {
  const env = { IMAP_HOST: "imap.example.com", IMAP_USER: "ana@example.com", IMAP_PASSWORD: "p1", IMAP2_HOST: "imap.work.example", IMAP2_USER: "ana@work.example", IMAP2_PASSWORD: "p2" };
  assert.equal(loadImapConfig(env).config?.user, "ana@example.com");
  assert.equal(loadImapConfig(env, "IMAP2").config?.user, "ana@work.example");
  assert.equal(loadImapConfig(env, "IMAP2").config?.host, "imap.work.example");
  assert.deepEqual(loadImapConfig({ IMAP_HOST: "imap.example.com" }, "IMAP2"), { config: null, problems: [] }, "only the first is set");
  const wrong = loadImapConfig({ IMAP2_HOST: "imap.work.example", IMAP2_USER: "ana@work.example", IMAP2_PASSWORD: "p", IMAP2_PORT: "143" }, "IMAP2");
  assert.equal(wrong.config, null);
  assert.match(wrong.problems[0]!, /^IMAP2_PORT must be/);
});

test("two readers on one store keep separate places: each reads its own mailbox once, and each email knows the address it came to", async () => {
  const kv = memoryKv();
  const box = createMailbox(null);
  const queued: string[] = [];
  const home = fakeServer([{ uid: 1, source: mail("dinner", "ana@example.com", "Dinner") }]);
  const work = fakeServer([{ uid: 1, source: mail("contract", "ana@work.example", "Contract") }, { uid: 2, source: mail("budget", "ana@work.example", "Budget") }]);
  const reader = (config: ImapConfig, stateKey: string, connect: ImapConnect) => createImapReader({
    config, stateKey, kv, box, control: createControl(null), now: () => NOW, connect, enqueue: async (m) => (queued.push(m.id), true),
  });
  const first = reader(ANA, "assistant-imap", home.connect);
  const second = reader(ANA_WORK, "assistant-imap2", work.connect);
  assert.equal((await first.poll()).queued, 1);
  assert.equal((await second.poll()).queued, 2);
  // Each one's place is its own: the second's look did not take the first's state as another account's and start it again.
  assert.equal(JSON.parse(kv.data.get("assistant-imap")!).who, "ana@example.com@imap.example.com:993");
  assert.equal(JSON.parse(kv.data.get("assistant-imap2")!).who, "ana@work.example@imap.work.example:993");
  assert.deepEqual(JSON.parse(kv.data.get("assistant-imap2")!).folders.INBOX, { v: "7", last: 2 });
  const again = [await first.poll(), await second.poll()];
  assert.deepEqual(again.map((r) => r.queued), [0, 0], "nothing read twice");
  assert.equal(queued.length, 3);
  const byFrom = Object.fromEntries((await box.items()).map((r) => [r.subject, r.mailbox]));
  assert.deepEqual(byFrom, { Dinner: "ana@example.com", Contract: "ana@work.example", Budget: "ana@work.example" });
});

test("mailSlot: the first free mailbox, the same one when signing in again, never one at another address", () => {
  const v = (user: string) => ({ IMAP_HOST: "imap.example.com", IMAP_USER: user, IMAP_PASSWORD: "p" });
  assert.deepEqual(mailSlot({}, v("ana@example.com")), { id: "imap", values: v("ana@example.com") });
  assert.deepEqual(mailSlot({ IMAP_USER: "ana@example.com" }, v("Ana@Example.com"))?.id, "imap", "signing in again keeps its place");
  assert.deepEqual(mailSlot({ IMAP_USER: "ana@example.com" }, v("ana@work.example")), {
    id: "imap2", values: { IMAP2_HOST: "imap.example.com", IMAP2_USER: "ana@work.example", IMAP2_PASSWORD: "p" },
  });
  assert.equal(mailSlot({ IMAP_USER: "ana@example.com", IMAP2_USER: "ana@work.example" }, v("ana@work.example"))?.id, "imap2");
  assert.equal(mailSlot({ IMAP2_USER: "ana@work.example" }, v("ana@example.com"))?.id, "imap", "the first, when it was disconnected");
  assert.equal(mailSlot({ IMAP_USER: "ana@example.com", IMAP2_USER: "ana@work.example" }, v("bea@example.com")), null);
});

test("Connect another account keeps the new mailbox in the second slot and leaves the first as it was; a third is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pako-imap2-"));
  const first = { IMAP_HOST: "imap.example.com", IMAP_USER: "ana@example.com", IMAP_PASSWORD: "app-pass-ana-1234" };
  assert.ok(writeStored(dir, first));
  const env = { PAKO_HOME: dir, PAKO_SECRET_STORE: "file", ...first };
  const fromStore = () => new Set(Object.keys(first));
  const logins: string[] = [];
  const connect = (c: ImapConfig) => ({
    connect: async () => void logins.push(c.user), logout: async () => undefined, close: () => undefined, on: () => undefined,
  }) as unknown as ImapClient;
  const auto = createAutoconfig({ resolve: async () => ["93.184.216.34"], fetch: (async () => new Response("", { status: 404 })) as unknown as typeof fetch });
  let saver: ConnectionsSaver | null = null;
  const s = await serve((app) => {
    saver = mountConnectionsPanel(app, { signedIn: auth.signedIn, env, lang: () => "en", dir, fromStore, restart: () => true });
    mountMailConnect(app, { ...auth, lang: () => "en", saver, env, autoconfig: auto, connect });
  });
  try {
    const r = await s.post("/panel/api/mail/connect", { address: "ana@work.example", password: "app-pass-work-5678", host: "imap.work.example", port: 993 });
    assert.deepEqual(r.body, { ok: true, restarting: true });
    const stored = readStored(dir)!;
    assert.equal(stored.IMAP_USER, "ana@example.com", "the first mailbox is untouched");
    assert.equal(stored.IMAP_PASSWORD, "app-pass-ana-1234");
    assert.equal(stored.IMAP2_USER, "ana@work.example");
    assert.equal(stored.IMAP2_HOST, "imap.work.example");
    assert.equal(stored.IMAP2_PASSWORD, "app-pass-work-5678");
  } finally {
    await s.close();
  }
  // Both taken: a third address is said plainly, and nothing is kept.
  const full = { ...env, IMAP2_USER: "ana@work.example" };
  const t = await serve((app) => mountMailConnect(app, { ...auth, lang: () => "en", saver: saver!, env: full, autoconfig: auto, connect }));
  try {
    const r = await t.post("/panel/api/mail/connect", { address: "bea@example.com", password: "app-pass-bea-0000", host: "imap.example.com", port: 993 });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /already reads two mailboxes/);
    assert.equal(readStored(dir)!.IMAP2_USER, "ana@work.example");
  } finally {
    await t.close();
  }
});

test("the connections page lists both mailboxes, each with its own address, labels and state", async () => {
  const env = {
    IMAP_HOST: "imap.example.com", IMAP_USER: "ana@example.com", IMAP_PASSWORD: "p1",
    IMAP2_HOST: "imap.work.example", IMAP2_USER: "ana@work.example", IMAP2_PASSWORD: "work-secret-5678", IMAP2_PORT: "1993",
  };
  const states = connectionStates({ env, stored: {}, fromStore: new Set(), lang: "en" });
  const one = states.find((c) => c.id === "imap")!;
  const two = states.find((c) => c.id === "imap2")!;
  assert.equal(one.state, "on");
  assert.equal(two.state, "on");
  assert.equal(two.name, "Your second mailbox (IMAP, read only)");
  assert.equal(two.fields.find((f) => f.key === "IMAP2_USER")?.label, "User name", "labelled as the first's");
  assert.ok(!JSON.stringify(two).includes("work-secret"), "no password goes back");
  const details = await connectionDetails({ env, lang: () => "en", dir: "/nowhere", timeZone: "Europe/Madrid", ...auth }) as { mail: Record<string, any> };
  assert.equal(details.mail.imap.address, "ana@example.com");
  assert.equal(details.mail.imap2.address, "ana@work.example");
  assert.equal(details.mail.imap2.port, 1993);
});

test("the phone's draft says which address to reply from: the mailbox the loop's email came to", async () => {
  const loop = {
    id: "a1b2c3d4e5", kind: "owner_reply", title: "Answer Luis about the contract", detail: "", who: "luis@friends.example", where: { type: "mail", label: "email · Luis" },
    whenSaid: NOW, check: { none: true }, status: "open", nextCheckAt: 0, nudges: 0, createdAt: NOW,
    sources: [{ kind: "mail", label: "email · Luis", at: NOW, ref: "imap:abc" }],
  };
  const engine = { open: async () => [loop], read: async () => ({ loops: [loop] }) };
  const feed = mobileFeed({
    engine: () => engine as never, door: { press: async () => ({}) } as never, brief: () => null, draftLoop: async () => null, timeZone: "Europe/Madrid",
    name: () => "Ana", gentle: async () => false, telegram: () => false, now: () => NOW,
    mailbox: async (id) => (id === "imap:abc" ? "ana@work.example" : undefined),
  });
  const today = await feed.today();
  assert.equal(today.loops![0]!.from, "ana@work.example");
  assert.equal(today.loops![0]!.to, "luis@friends.example");
  assert.equal(loopItem(today.loops![0], NOW).from, "ana@work.example");
  // Without a second mailbox nothing is said.
  const plain = await mobileFeed({ ...{ engine: () => engine as never, door: { press: async () => ({}) } as never, brief: () => null, draftLoop: async () => null },
    timeZone: "Europe/Madrid", name: () => "Ana", gentle: async () => false, telegram: () => false, now: () => NOW }).today();
  assert.equal(plain.loops![0]!.from, undefined);
});

test("mail from the owner's other address is the owner's own in either mailbox, not a stranger's to triage", async () => {
  const self = Buffer.from("From: Ana <ana@example.com>\r\nTo: ana@work.example\r\nSubject: note to self\r\nMessage-ID: <x1@example.com>\r\n"
    + "Authentication-Results: mx.work.example; dkim=pass header.d=example.com; dmarc=pass header.from=example.com\r\n"
    + "Content-Type: text/plain\r\n\r\nremember the contract\r\n", "utf8");
  const read = async (alsoOwn?: string) => {
    const queued: string[] = [];
    const work = fakeServer([{ uid: 1, source: self }]);
    const r = createImapReader({
      config: ANA_WORK, stateKey: "assistant-imap2", kv: memoryKv(), box: createMailbox(null), control: createControl(null), now: () => NOW,
      connect: work.connect, enqueue: async (m) => (queued.push(m.id), true), ...(alsoOwn ? { alsoOwn } : {}),
    });
    await r.poll();
    return queued.length;
  };
  assert.equal(await read(), 1, "without the other address: queued as news (the bug)");
  assert.equal(await read("ana@example.com"), 0, "with it: the owner's own");
});

test("the slot is chosen from what is saved now: a mailbox connected since the start is not overwritten, a disconnected one is free", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pako-imap2-now-"));
  assert.ok(writeStored(dir, { IMAP_HOST: "imap.example.com", IMAP_USER: "ana@example.com", IMAP_PASSWORD: "app-pass-ana-1234" }));
  // Started before any mailbox: the start's settings name none.
  const saver = mountConnectionsPanel(express(), { signedIn: auth.signedIn, env: { PAKO_HOME: dir, PAKO_SECRET_STORE: "file" }, lang: () => "en", dir,
    fromStore: () => new Set<string>(), restart: () => false })!;
  assert.equal(mailSlot(saver.now!(), { IMAP_USER: "ana@work.example" })?.id, "imap2", "the first, saved since the start, is kept");
  // Started with the first mailbox, then disconnected in the panel: the start's IMAP_USER no longer counts.
  assert.ok(writeStored(dir, { IMAP_HOST: null, IMAP_USER: null, IMAP_PASSWORD: null } as unknown as Record<string, string>));
  const after = mountConnectionsPanel(express(), { signedIn: auth.signedIn, env: { PAKO_HOME: dir, PAKO_SECRET_STORE: "file", IMAP_USER: "ana@example.com" },
    lang: () => "en", dir, fromStore: () => new Set(["IMAP_USER"]), restart: () => false })!;
  assert.equal(mailSlot(after.now!(), { IMAP_USER: "ana@work.example" })?.id, "imap");
});

test("the privacy page names both mailboxes' servers, and the second alone counts as a mailbox connection", () => {
  const dir = mkdtempSync(join(tmpdir(), "pako-imap2-priv-"));
  const line = (env: Record<string, string>) => privacy({ dir, env, lang: "en" }).sends.find((x) => x.name === "IMAP")!;
  assert.deepEqual([line({ IMAP2_HOST: "imap.work.example", IMAP2_USER: "ana@work.example" }).on, line({ IMAP2_HOST: "imap.work.example", IMAP2_USER: "a" }).detail],
    [true, "imap.work.example"]);
  assert.equal(line({ IMAP_HOST: "imap.example.com", IMAP_USER: "a", IMAP2_HOST: "imap.work.example", IMAP2_USER: "b" }).detail, "imap.example.com, imap.work.example");
});

test("the dashboard does not ask for a mailbox when only the second one is connected", async () => {
  const { oneSuggestion } = (await import(new URL("../src/panel/dashboard-model.js", import.meta.url).href)) as { oneSuggestion: (s: unknown) => { id: string } | null };
  const s = oneSuggestion([{ id: "calendar", state: "connected" }, { id: "imap2", state: "connected" }]);
  assert.notEqual(s?.id, "imap");
});

test("sent mail in the catch-up: the second mailbox's refs carry its address, the first's are as before (no repeat loops after an update)", () => {
  assert.equal(sentRef("assistant-imap", "ana@example.com", 42), "imap-sent:42");
  assert.equal(sentRef(undefined, "ana@example.com", 42), "imap-sent:42");
  assert.equal(sentRef("assistant-imap2", "ana@work.example", 42), "imap-sent:ana@work.example:42");
});
