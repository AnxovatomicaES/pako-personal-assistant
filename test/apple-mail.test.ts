// Mail on this Mac (src/apple-mail.ts) against a Mail store built here: an Envelope Index with the real tables and column names Pako reads
// (messages, mailboxes, addresses, subjects, message_global_data) and messages as .emlx and .partial.emlx files in Mail's own layout:
// - the pieces: the switch, mailbox URLs to kinds and folders, the .emlx framing, the index's dates, the newest V<N> store;
// - the first look marks where it starts (no backlog); each message once, across a restart; Junk, Trash, Drafts and deleted rows skipped;
//   an old message arriving late skipped; a message Mail has not written yet picked up when it is;
// - the owner's reply in Sent closes the email it answers, and reaches the follow-ups in the same thread; their address is learnt from Sent;
// - an older or unknown index: missing columns read as nothing, missing tables said plainly, never a crash;
// - no Full Disk Access: the plain-English step and the pane, on the card and in the connections' status;
// - with IMAP on for the same account, an email is taken once, whichever reader comes first;
// - no message text, subject or address in a log; every file of the store byte-identical after the reads.
// Nothing here reads the real Mail store.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Control, createControl } from "../src/control.ts";
import {
  APPLE_MAIL_KEY, createAppleMail, emlxMessage, findMailStore, forgetAppleMail, loadAppleMailConfig, mailboxDir, mailboxKind, mailTime,
  mountAppleMailPanel,
} from "../src/apple-mail.ts";
import { connectionStates, findConnection } from "../src/connections.ts";
import { FULL_DISK_PANE } from "../src/imessage.ts";
import { createImapReader, type ImapClient } from "../src/imap.ts";
import { mailThreadKey } from "../src/mail-body.ts";
import type { SentMail } from "../src/mail-followups.ts";
import { createMailbox } from "../src/mail.ts";
import { sqlite, type Database } from "../src/sqlite-kv.ts";
import type { Inbound } from "../src/whatsapp.ts";
import { auth, memoryKv, serve } from "./helpers/connect-rig.ts";

const T0 = Date.parse("2026-11-16T09:00:00Z");
const MIN = 60_000;
const ICLOUD = "8F2C61A0-1B2C-4D5E-9F00-AAAAAAAAAAAA";
const GMAIL = "0B7E2D11-3C4D-4E5F-8A00-BBBBBBBBBBBB";
const STORE = "5E1A7C3D-0000-4000-8000-CCCCCCCCCCCC";
const OWNER = "alex@owner.example";
const CLIENT = "dana@client.example";

/** One email as a mail server sends it. */
function email(o: { mid: string; from: string; to?: string; subject: string; text: string; inReplyTo?: string; at?: number }): string {
  return [
    `Message-ID: <${o.mid}>`, `From: ${o.from}`, `To: ${o.to ?? `Alex <${OWNER}>`}`, `Subject: ${o.subject}`,
    `Date: ${new Date(o.at ?? T0).toUTCString()}`, ...(o.inReplyTo ? [`In-Reply-To: <${o.inReplyTo}>`, `References: <${o.inReplyTo}>`] : []),
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", o.text, "",
  ].join("\r\n");
}

/** An .emlx: the byte count, the message, Apple's property list. */
const emlx = (raw: string): Buffer => {
  const msg = Buffer.from(raw, "utf8");
  const plist = '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>flags</key><integer>8590195713</integer></dict></plist>\n';
  return Buffer.concat([Buffer.from(`${msg.length}        \n`), msg, Buffer.from(plist)]);
};

/** The folder of a message in Mail's layout: Data/<digits of ROWID / 1000, reversed>/Messages. */
const dataDir = (mbox: string, id: number): string =>
  join(mbox, STORE, "Data", ...(id >= 1000 ? String(Math.floor(id / 1000)).split("").reverse() : []), "Messages");

const SCHEMA = `
  CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY, address TEXT COLLATE NOCASE, comment TEXT, UNIQUE(address, comment));
  CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY, subject TEXT COLLATE NOCASE UNIQUE);
  CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT UNIQUE, total_count INTEGER DEFAULT 0, unread_count INTEGER DEFAULT 0,
    deleted_count INTEGER DEFAULT 0, unseen_count INTEGER DEFAULT 0, unread_count_adjusted_for_duplicates INTEGER DEFAULT 0, change_identifier TEXT,
    source INTEGER, alleged_change_identifier TEXT);
  CREATE TABLE message_global_data (ROWID INTEGER PRIMARY KEY, message_id INTEGER, message_id_header TEXT, follow_up_start_date INTEGER,
    follow_up_end_date INTEGER, download_state INTEGER DEFAULT 0, read_later_date INTEGER, send_later_date INTEGER, validation_state INTEGER DEFAULT 0);
  CREATE TABLE messages (ROWID INTEGER PRIMARY KEY, message_id INTEGER DEFAULT 0, global_message_id INTEGER, remote_id INTEGER, document_id TEXT,
    sender INTEGER, subject_prefix TEXT, subject INTEGER, summary INTEGER, date_sent INTEGER, date_received INTEGER, mailbox INTEGER,
    remote_mailbox INTEGER, flags INTEGER DEFAULT 0, read INTEGER DEFAULT 0, flagged INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, size INTEGER DEFAULT 0,
    conversation_id INTEGER DEFAULT 0, date_last_viewed INTEGER, list_id_hash INTEGER, unsubscribe_type INTEGER, searchable_message INTEGER,
    snippet TEXT, automated_conversation INTEGER DEFAULT 0, root_status INTEGER DEFAULT -1, conversation_position INTEGER DEFAULT -1);
`;

/** A Mail store under its own ~/Library/Mail: V10 is the live one (V9 left behind by an update has no index). */
function fixture(o: { schema?: string; wal?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pako-applemail-"));
  const v = join(root, "V10");
  mkdirSync(join(v, "MailData"), { recursive: true });
  mkdirSync(join(root, "V9", "MailData"), { recursive: true });
  const index = join(v, "MailData", "Envelope Index");
  const Db = sqlite();
  const w: Database = new Db(index);
  if (o.wal) w.exec("PRAGMA journal_mode = WAL");
  w.exec(o.schema ?? SCHEMA);
  const boxes = new Map<string, number>();
  const box = (url: string): number => {
    const got = boxes.get(url);
    if (got) return got;
    const id = Number((w.prepare("INSERT INTO mailboxes (url) VALUES (?) RETURNING ROWID AS r").get(url) as { r: number }).r);
    boxes.set(url, id);
    return id;
  };
  const INBOX = `imap://${ICLOUD}/INBOX`;
  const SENT = `imap://${ICLOUD}/Sent%20Messages`;
  const cols = new Set(w.prepare("PRAGMA table_info(messages)").all().map((c) => String(c.name)));
  let row = 1200;
  const add = (m: {
    url: string; raw: string; at: number; from?: string; partial?: boolean; deleted?: boolean; noFile?: boolean; id?: number; where?: string;
  }): { id: number; file: string } => {
    const id = m.id ?? ++row;
    const sender = m.from && cols.has("sender")
      ? Number((w.prepare("INSERT INTO addresses (address, comment) VALUES (?, '') ON CONFLICT DO UPDATE SET comment = '' RETURNING ROWID AS r").get(m.from) as { r: number }).r)
      : null;
    const fields: [string, unknown][] = [["ROWID", id], ["mailbox", box(m.url)], ["sender", sender], ["date_received", Math.floor(m.at / 1000)],
      ["date_sent", Math.floor(m.at / 1000)], ["deleted", m.deleted ? 1 : 0]];
    const use = fields.filter(([c]) => c === "ROWID" || cols.has(c));
    w.prepare(`INSERT INTO messages (${use.map(([c]) => c).join(", ")}) VALUES (${use.map(() => "?").join(", ")})`).run(...(use.map(([, x]) => x) as never[]));
    const parts = m.url.replace(/^[a-z]+:\/\/[^/]*\//, "").split("/").map((s) => `${decodeURIComponent(s)}.mbox`);
    const account = /^[a-z]+:\/\/([^/]*)\//.exec(m.url)![1] || "Mailboxes";
    const mbox = join(v, account, ...parts);
    const dir = m.where ? join(mbox, m.where) : dataDir(mbox, id);
    const file = join(dir, `${id}${m.partial ? ".partial" : ""}.emlx`);
    if (!m.noFile) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, emlx(m.raw));
    }
    return { id, file };
  };
  return { root, v, index, w, add, box, INBOX, SENT };
}

function reader(
  root: string, o: { kv?: ReturnType<typeof memoryKv>; now?: number; inApp?: boolean; box?: ReturnType<typeof createMailbox>; control?: Control } = {},
) {
  const clock = { now: o.now ?? T0 };
  const queued: Inbound[] = [];
  const sent: SentMail[] = [];
  const replied: string[] = [];
  const kv = o.kv ?? memoryKv();
  const box = o.box ?? createMailbox(null, { onReplied: (ids) => void replied.push(...ids) });
  const r = createAppleMail({
    config: { root, pollMinutes: 3, workDomains: [], vip: [] }, kv, now: () => clock.now, inApp: o.inApp ?? true, lang: () => "en",
    box, enqueue: async (m) => (queued.push(m), true), sentMail: async (m) => void sent.push(m), ...(o.control ? { control: o.control } : {}),
  });
  return { r, queued, sent, replied, clock, kv, box };
}

/** Every file under a folder with its bytes' hash and its modification time. */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(p, `${createHash("sha256").update(readFileSync(p)).digest("hex")} ${statSync(p).mtimeMs}`);
    }
  };
  walk(root);
  return out;
}

test("the pieces: the switch, mailbox URLs, the .emlx framing, the index's dates, the newest store", () => {
  assert.deepEqual(loadAppleMailConfig({}, "darwin"), { config: null, problems: [] }, "off by default");
  assert.equal(loadAppleMailConfig({ APPLE_MAIL: "on" }, "darwin").config?.pollMinutes, 3);
  assert.match(loadAppleMailConfig({ APPLE_MAIL: "on" }, "linux").problems.join(), /Mac only/);
  assert.match(loadAppleMailConfig({ APPLE_MAIL: "yes" }, "darwin").problems.join(), /on or off/);
  assert.match(loadAppleMailConfig({ APPLE_MAIL: "on", APPLE_MAIL_POLL_MINUTES: "0" }, "darwin").problems.join(), /APPLE_MAIL_POLL_MINUTES/);
  assert.ok(findConnection("applemail"), "a connection of the panel's catalogue");

  assert.equal(mailboxKind(`imap://${ICLOUD}/INBOX`), "inbox");
  assert.equal(mailboxKind(`ews://${ICLOUD}/Inbox`), "inbox");
  assert.equal(mailboxKind(`imap://${ICLOUD}/Sent%20Messages`), "sent");
  assert.equal(mailboxKind(`imap://${GMAIL}/%5BGmail%5D/Sent%20Mail`), "sent");
  assert.equal(mailboxKind(`ews://${ICLOUD}/Sent%20Items`), "sent");
  for (const skip of ["Junk", "Deleted%20Messages", "Drafts", "%5BGmail%5D/Spam", "%5BGmail%5D/Trash", "%5BGmail%5D/All%20Mail", "Archive", "Work/Clients", "INBOX/Receipts"]) {
    assert.equal(mailboxKind(`imap://${ICLOUD}/${skip}`), "skip", skip);
  }
  assert.equal(mailboxKind("not a url"), "skip");
  assert.equal(mailboxDir("/M/V10", `imap://${GMAIL}/%5BGmail%5D/Sent%20Mail`), `/M/V10/${GMAIL}/[Gmail].mbox/Sent Mail.mbox`);
  assert.equal(mailboxDir("/M/V10", "local:///Saved"), "/M/V10/Mailboxes/Saved.mbox");
  assert.equal(mailboxDir("/M/V10", `imap://${ICLOUD}/..%2F..%2Fetc`), null, "a name that would leave the store is never a path");
  assert.equal(mailboxDir("/M/V10", "imap://../INBOX"), null);

  const raw = email({ mid: "a@x", from: CLIENT, subject: "Hi", text: "Hello" });
  assert.equal(emlxMessage(emlx(raw))?.toString("utf8"), raw, "exactly the counted bytes: the plist after them is left out");
  assert.equal(emlxMessage(Buffer.from("not an emlx")), null);
  assert.equal(emlxMessage(Buffer.from("0\nx")), null);

  assert.equal(mailTime(Math.floor(T0 / 1000)), T0, "seconds since 1970");
  assert.equal(mailTime(Math.floor(T0 / 1000) - 978_307_200), T0, "seconds since 2001 (an older index)");
  assert.equal(mailTime(T0), T0, "milliseconds");
  assert.equal(mailTime(null), null);
  assert.equal(mailTime("x"), null);

  const f = fixture();
  const found = findMailStore(f.root);
  assert.equal(found.access, "ok");
  assert.equal("dir" in found && found.dir, f.v, "the newest V<N> with an index");
  assert.equal(findMailStore(join(f.root, "nothing")).access, "missing");
  f.w.close();
});

test("reading: from the moment it was turned on; inbox and Sent only; .partial.emlx; nothing twice; a late file picked up", async () => {
  const f = fixture({ wal: true });
  // Before it was turned on: never handed on.
  f.add({ url: f.INBOX, at: T0 - 60 * MIN, from: CLIENT, raw: email({ mid: "old@client.example", from: `Dana <${CLIENT}>`, subject: "Old one", text: "Old" }) });
  const { r, queued, clock, kv } = reader(f.root);
  assert.equal(await r.round(), 0, "the first look only marks where it starts");
  assert.equal((await r.status()).access, "ok");

  f.add({ url: f.INBOX, at: T0 + MIN, from: CLIENT, raw: email({ mid: "q1@client.example", from: `Dana <${CLIENT}>`, subject: "Contract", text: "Can you sign the contract by Friday?" }) });
  f.add({ url: f.INBOX, at: T0 + 2 * MIN, from: CLIENT, partial: true,
    raw: email({ mid: "q2@client.example", from: `Dana <${CLIENT}>`, subject: "Slides", text: "The slides are attached; the file is kept apart." }) });
  f.add({ url: `imap://${ICLOUD}/Junk`, at: T0 + 3 * MIN, raw: email({ mid: "j@spam.example", from: "x@spam.example", subject: "Win", text: "Junk" }) });
  f.add({ url: `imap://${ICLOUD}/Deleted%20Messages`, at: T0 + 3 * MIN, raw: email({ mid: "t@x.example", from: "y@x.example", subject: "Gone", text: "Trash" }) });
  f.add({ url: `imap://${ICLOUD}/Drafts`, at: T0 + 3 * MIN, raw: email({ mid: "d@x.example", from: OWNER, subject: "Draft", text: "Draft" }) });
  f.add({ url: f.INBOX, at: T0 + 3 * MIN, deleted: true, raw: email({ mid: "del@x.example", from: "z@x.example", subject: "Deleted", text: "Deleted" }) });
  // An account's first sync brings old mail with new rows: not new.
  f.add({ url: f.INBOX, at: T0 - 6 * 24 * 60 * MIN, raw: email({ mid: "sync@x.example", from: "w@x.example", subject: "From a sync", text: "Old" }) });
  // Listed, but Mail has not written its file yet.
  const late = f.add({ url: f.INBOX, at: T0 + 4 * MIN, noFile: true, raw: "" });
  // A layout Mail may use elsewhere: found by the bounded search.
  f.add({ url: f.INBOX, at: T0 + 5 * MIN, id: 23456, where: "Elsewhere/Messages",
    raw: email({ mid: "q3@client.example", from: `Dana <${CLIENT}>`, subject: "Lunch", text: "Lunch on Tuesday?" }) });
  clock.now = T0 + 10 * MIN;
  assert.equal(await r.round(), 3);
  assert.deepEqual(queued.map((m) => [m.email?.subject, m.email?.from]), [
    ["Contract", `Dana <${CLIENT}>`], ["Slides", `Dana <${CLIENT}>`], ["Lunch", `Dana <${CLIENT}>`],
  ]);
  assert.match(queued[0]!.email!.text, /sign the contract by Friday/);
  assert.ok(queued.every((m) => !m.email?.quiet), "new mail, told as IMAP's new mail is");

  // Nothing twice: not on the next look, nor after a restart with the same store.
  clock.now += 3 * MIN;
  assert.equal(await r.round(), 0);
  writeFileSync(join(dataDir(join(f.v, ICLOUD, "INBOX.mbox"), late.id), `${late.id}.emlx`),
    emlx(email({ mid: "q4@client.example", from: `Dana <${CLIENT}>`, subject: "Keys", text: "Did you get the keys?" })));
  const again = reader(f.root, { kv, now: clock.now });
  assert.equal(await again.r.round(), 1, "the message Mail wrote since is picked up, once");
  assert.deepEqual(again.queued.map((m) => m.email?.subject), ["Keys"]);
  assert.equal(await again.r.round(), 0);
  const kept = JSON.parse(kv.data.get(APPLE_MAIL_KEY)!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(kept).sort(), ["access", "lastError", "lastRead", "mark", "start", "store", "waiting"], "only where it is");
  assert.ok(!JSON.stringify(kept).includes("@"), "no address kept");

  // Turned off: forgotten, so turning it on again starts from then.
  await forgetAppleMail(kv);
  assert.equal(kv.data.get(APPLE_MAIL_KEY), "");
  f.add({ url: f.INBOX, at: clock.now + 5 * MIN, raw: email({ mid: "off@client.example", from: CLIENT, subject: "While off", text: "x" }) });
  const fresh = reader(f.root, { kv, now: clock.now + 60 * MIN });
  assert.equal(await fresh.r.round(), 0);
  assert.equal(fresh.queued.length, 0, "nothing that came while it was off");
  f.w.close();
});

test("paused (STOP): nothing is read, as IMAP does not log in; after RESUME the mail of the pause is read from the mark, none lost", async () => {
  const f = fixture({ wal: true });
  const control = createControl(memoryKv(), () => T0);
  const { r, queued, clock } = reader(f.root, { control });
  assert.equal(await r.round(), 0, "the first look only marks where it starts");
  await control.setPaused(true, T0);
  f.add({ url: f.INBOX, at: T0 + MIN, from: CLIENT, raw: email({ mid: "p1@client.example", from: `Dana <${CLIENT}>`, subject: "Contract", text: "Sign it?" }) });
  clock.now = T0 + 10 * MIN;
  assert.equal(await r.round(), 0, "paused: not read");
  assert.equal(queued.length, 0);
  await control.setPaused(false, T0 + 20 * MIN);
  clock.now = T0 + 20 * MIN;
  assert.equal(await r.round(), 1, "after RESUME it is read");
  assert.deepEqual(queued.map((m) => m.email?.subject), ["Contract"]);
});

test("Sent: the owner's reply closes the email it answers and reaches the follow-ups in the same thread; their address is learnt", async () => {
  const f = fixture();
  const { r, queued, sent, replied, clock, box } = reader(f.root);
  await r.round();
  f.add({ url: f.INBOX, at: T0 + MIN, from: CLIENT,
    raw: email({ mid: "ask@client.example", from: `Dana <${CLIENT}>`, subject: "Invoice", text: "Could you send the invoice for October?" }) });
  f.add({ url: f.SENT, at: T0 + 5 * MIN, from: OWNER,
    raw: email({ mid: "reply@owner.example", from: `Alex <${OWNER}>`, to: `Dana <${CLIENT}>`, subject: "Re: Invoice",
      text: "Attached, and I'll send November's on the 1st.\n\nOn Mon, Dana wrote:\n> Could you send the invoice for October?", inReplyTo: "ask@client.example" }) });
  clock.now = T0 + 10 * MIN;
  assert.equal(await r.round(), 2);
  assert.equal(queued.length, 1, "the client's email is news; the owner's own is not");
  const inboxId = queued[0]!.id.replace(/^mail:/, "");
  assert.match(inboxId, /^applemail:[0-9a-f]{32}$/);
  assert.deepEqual(replied, [inboxId], "the reply closed the email it answers (its loops close through onReplied)");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.text, "Attached, and I'll send November's on the 1st.", "the owner's own words, without the quote");
  const asked = await box.get(inboxId);
  assert.equal(mailThreadKey({ references: sent[0]!.references, inReplyTo: sent[0]!.inReplyTo, messageId: sent[0]!.messageId }), asked?.thread,
    "the reply is in the email's thread: the follow-ups close what it asked");
  assert.deepEqual(r.addresses(), [OWNER], "learnt from the Sent mailbox, kept in memory only");

  // Mail from the owner's own address in the inbox, not vouched for by their server: not news, and it closes nothing.
  f.add({ url: f.INBOX, at: T0 + 12 * MIN, raw: email({ mid: "fake@owner.example", from: OWNER, subject: "Re: Other", text: "x", inReplyTo: "other@x" }) });
  clock.now = T0 + 15 * MIN;
  await r.round();
  assert.equal(queued.length, 1);
  f.w.close();
});

test("an older or unknown index: missing columns read as nothing; missing tables said plainly; never a crash", async () => {
  // An older Mail: no date_received (date_sent instead), no deleted, no sender, no addresses table.
  const older = fixture({
    schema: `CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT UNIQUE);
      CREATE TABLE messages (ROWID INTEGER PRIMARY KEY, message_id INTEGER, subject INTEGER, date_sent INTEGER, mailbox INTEGER, flags INTEGER);`,
  });
  const a = reader(older.root);
  assert.equal(await a.r.round(), 0);
  older.add({ url: older.INBOX, at: T0 + MIN, raw: email({ mid: "o1@client.example", from: CLIENT, subject: "Old Mail", text: "Still read" }) });
  older.add({ url: older.SENT, at: T0 + 2 * MIN, raw: email({ mid: "o2@owner.example", from: OWNER, to: CLIENT, subject: "Re: Old Mail", text: "Thanks", inReplyTo: "o1@client.example" }) });
  a.clock.now = T0 + 5 * MIN;
  assert.equal(await a.r.round(), 2);
  assert.deepEqual(a.queued.map((m) => m.email?.subject), ["Old Mail"]);
  assert.equal(a.sent.length, 1);
  assert.equal((await a.r.status()).lastError, null);
  older.w.close();

  // A store without the tables Pako needs: "unknown", in plain words.
  const odd = fixture({ schema: "CREATE TABLE messages (ROWID INTEGER PRIMARY KEY, date_received INTEGER);" });
  odd.w.close();
  const b = reader(odd.root);
  assert.equal(await b.r.round(), 0);
  assert.equal((await b.r.status()).access, "unknown");
  assert.match(b.r.problem("en")!, /version of Mail .* update Pako/);
  // Not even an SQLite file: a failed look, said calmly, tried again later.
  const broken = fixture();
  broken.w.close();
  writeFileSync(broken.index, "not a database at all, just bytes");
  const c = reader(broken.root);
  assert.equal(await c.r.round(), 0);
  assert.match(c.r.problem("en")!, /couldn't read the mail on this Mac just now/);
});

test("no Full Disk Access: the plain-English step and the pane, on the card and in the connections' status; Mac only elsewhere", async () => {
  const f = fixture();
  f.w.close();
  chmodSync(f.root, 0o000);
  try {
    const { r } = reader(f.root, { inApp: true });
    assert.equal(await r.round(), 0);
    assert.equal((await r.status()).access, "denied");
    const say = r.problem("en")!;
    assert.match(say, /Pako can't read the mail on this Mac yet: macOS needs your permission/);
    assert.match(say, /System Settings › Privacy & Security › Full Disk Access/);
    assert.match(say, /turn on Pako/);
    const src = reader(f.root, { inApp: false });
    await src.r.round();
    assert.match(src.r.problem("en")!, /Terminal/, "a source install names the terminal");

    const states = connectionStates({ env: { APPLE_MAIL: "on" }, stored: {}, fromStore: new Set(), lang: "en", problems: { applemail: say } });
    assert.equal(states.find((c) => c.id === "applemail")?.problem, say, "the connections page and its status say it");

    const s = await serve((app) => mountAppleMailPanel(app, { ...auth, lang: () => "en", mac: true, reader: () => r, imapOn: () => true }));
    try {
      const card = await s.get("/panel/api/apple-mail");
      assert.equal(card.status, 200);
      assert.deepEqual([card.body.on, card.body.access, card.body.pane, card.body.imap], [true, "denied", FULL_DISK_PANE, true]);
      assert.match(card.body.problem, /Full Disk Access/);
      chmodSync(f.root, 0o700);
      const after = await s.post("/panel/api/apple-mail/check", {});
      assert.equal(after.body.access, "ok", "Check again looks at once");
      assert.equal(after.body.problem, null);
      assert.equal((await s.get("/panel/api/apple-mail", {})).status, 401, "the panel's session only");
    } finally {
      await s.close();
    }
    const elsewhere = await serve((app) => mountAppleMailPanel(app, { ...auth, lang: () => "en", mac: false, reader: () => null, imapOn: () => false }));
    try {
      const card = await elsewhere.get("/panel/api/apple-mail");
      assert.deepEqual([card.body.mac, card.body.on], [false, false]);
    } finally {
      await elsewhere.close();
    }
    const missing = reader(join(f.root, "nothing"));
    await missing.r.round();
    assert.equal((await missing.r.status()).access, "missing");
    assert.match(missing.r.problem("en")!, /open the Mail app/);
  } finally {
    chmodSync(f.root, 0o700);
  }
});

/** A read-only IMAP server of one INBOX for the dedupe: the same messages as the Mail store. */
function fakeImap(msgs: { uid: number; at: number; raw: string }[]): () => ImapClient {
  return () => {
    const c: ImapClient = {
      connect: async () => undefined,
      mailboxOpen: async () => ({ uidValidity: 1n, uidNext: msgs.length + 1, readOnly: true }),
      search: async () => msgs.map((m) => m.uid),
      fetchOne: async (uid) => {
        const m = msgs.find((x) => x.uid === Number(uid));
        return m ? { uid: m.uid, internalDate: new Date(m.at), source: Buffer.from(m.raw) } : false;
      },
      logout: async () => undefined,
      close: () => undefined,
      on: () => c,
    };
    return c;
  };
}

test("with IMAP on for the same account: an email is taken once, whichever reader comes first", async () => {
  const f = fixture();
  const box = createMailbox(null);
  const am = reader(f.root, { box });
  await am.r.round();
  const first = email({ mid: "both1@client.example", from: `Dana <${CLIENT}>`, subject: "Seen twice?", text: "Only once, please", at: T0 + MIN });
  const second = email({ mid: "both2@client.example", from: `Dana <${CLIENT}>`, subject: "IMAP first", text: "Then Mail", at: T0 + 20 * MIN });
  f.add({ url: f.INBOX, at: T0 + MIN, raw: first });
  am.clock.now = T0 + 5 * MIN;
  assert.equal(await am.r.round(), 1);
  assert.equal(am.queued.length, 1, "Mail on this Mac took it");

  const imapQueued: Inbound[] = [];
  let now = T0 + 30 * MIN;
  const imap = createImapReader({
    config: { host: "imap.mail.me.com", port: 993, user: OWNER, password: "app-password-here", folders: ["INBOX"], pollMinutes: 5, workDomains: [], vip: [] },
    kv: memoryKv(), box, enqueue: async (m) => (imapQueued.push(m), true), now: () => now,
    connect: fakeImap([{ uid: 1, at: T0 + MIN, raw: first }, { uid: 2, at: T0 + 20 * MIN, raw: second }]),
  });
  const res = await imap.poll();
  assert.equal(res.skipped, undefined);
  assert.deepEqual(imapQueued.map((m) => m.email?.subject), ["IMAP first"], "IMAP skipped the one Mail on this Mac already took");

  // Now Mail on this Mac sees the one IMAP took first: a no-op.
  f.add({ url: f.INBOX, at: T0 + 20 * MIN, raw: second });
  am.clock.now = now = T0 + 35 * MIN;
  await am.r.round();
  assert.equal(am.queued.length, 1, "nothing new from Mail on this Mac: IMAP had it");
  f.w.close();
});

test("privacy: no message text, subject or address in a log; every file of the store byte-identical after the reads", async () => {
  const f = fixture();
  const { r, clock } = reader(f.root);
  await r.round();
  f.add({ url: f.INBOX, at: T0 + MIN, from: CLIENT,
    raw: email({ mid: "p1@client.example", from: `Dana Secret <${CLIENT}>`, subject: "Private matter", text: "The door code is under the mat" }) });
  f.add({ url: f.SENT, at: T0 + 2 * MIN, from: OWNER,
    raw: email({ mid: "p2@owner.example", from: OWNER, to: CLIENT, subject: "Re: Private matter", text: "Thanks, noted the mat", inReplyTo: "p1@client.example" }) });
  f.add({ url: f.INBOX, at: T0 + 3 * MIN, raw: "this is not an email at all" });
  f.w.close();
  const before = snapshot(f.root);
  const logs: string[] = [];
  const keep = { error: console.error, log: console.log, warn: console.warn, info: console.info };
  const grab = (...a: unknown[]) => void logs.push(a.join(" "));
  Object.assign(console, { error: grab, log: grab, warn: grab, info: grab });
  try {
    clock.now = T0 + 10 * MIN;
    assert.ok((await r.round()) >= 2);
    await r.round();
  } finally {
    Object.assign(console, keep);
  }
  assert.ok(logs.length > 0, "the look said something");
  for (const line of logs) {
    for (const secret of ["Private matter", "door code", "under the mat", "Dana Secret", CLIENT, OWNER, "client.example"]) {
      assert.ok(!line.includes(secret), `logged: ${line}`);
    }
  }
  assert.deepEqual(snapshot(f.root), before, "no file written, created or touched: the index and every .emlx byte-identical");
});

test("an email the intake could not take (the store failed) is tried again at the next look, never dropped", async () => {
  const f = fixture();
  const queued: Inbound[] = [];
  let down = false;
  let now = T0;
  const r = createAppleMail({
    config: { root: f.root, pollMinutes: 3, workDomains: [], vip: [] }, kv: memoryKv(), now: () => now, inApp: true, lang: () => "en",
    box: createMailbox(null),
    enqueue: async (m) => {
      if (down) throw new Error("the store did not answer");
      queued.push(m);
      return true;
    },
  });
  await r.round();
  f.add({ url: f.INBOX, at: T0 + MIN, from: CLIENT, raw: email({ mid: "r1@client.example", from: `Dana <${CLIENT}>`, subject: "First", text: "One" }) });
  f.add({ url: f.INBOX, at: T0 + 2 * MIN, from: CLIENT, raw: email({ mid: "r2@client.example", from: `Dana <${CLIENT}>`, subject: "Second", text: "Two" }) });
  down = true;
  now = T0 + 5 * MIN;
  assert.equal(await r.round(), 0);
  assert.equal(queued.length, 0);
  down = false;
  now = T0 + 8 * MIN;
  await r.round();
  assert.deepEqual(queued.map((m) => m.email?.subject), ["First", "Second"], "both handed on once the store answered again");
  now = T0 + 11 * MIN;
  await r.round();
  assert.equal(queued.length, 2, "and never twice");
  f.w.close();
});

test("a store that fails once to read where it was does not stop Mail on this Mac for good", async () => {
  const f = fixture();
  const kv = memoryKv();
  let failGet = true;
  const flaky = { ...kv, get: async (k: string) => {
    if (failGet) throw new Error("the store did not answer");
    return kv.get(k);
  } };
  const queued: Inbound[] = [];
  let now = T0;
  const r = createAppleMail({
    config: { root: f.root, pollMinutes: 3, workDomains: [], vip: [] }, kv: flaky, now: () => now, inApp: true, lang: () => "en",
    box: createMailbox(null), enqueue: async (m) => (queued.push(m), true),
  });
  await r.round().catch(() => 0);
  failGet = false;
  await r.round();
  f.add({ url: f.INBOX, at: T0 + MIN, from: CLIENT, raw: email({ mid: "k1@client.example", from: `Dana <${CLIENT}>`, subject: "Hello", text: "Hi" }) });
  now = T0 + 5 * MIN;
  await r.round();
  assert.deepEqual(queued.map((m) => m.email?.subject), ["Hello"]);
  f.w.close();
});
