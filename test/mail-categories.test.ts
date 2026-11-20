// Mail categories (src/mail-categories.ts, src/mail.ts, src/mail-panel.ts, src/followups/mail.ts): the triage's answer read for every
// category, older records mapped, the cheap filing before Claude (headers, known senders, the owner's rules), the notification defaults, the
// loops Needs you and Waiting on others make, the panel's tabs, the reader (plain text, codes hidden, the "Open in…" link), and the dashboard's
// "Needs you" preview (its order, Done with Undo and its loop, a reply in Sent, what never appears). Nothing here reaches the network.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { parseEmailVerdict } from "../assistant/bridge.ts";
import { createFollowups } from "../src/followups.ts";
import type { Kv } from "../src/kv.ts";
import {
  authenticated, CATEGORIES, categoryOf, loopFromVerdict, needsPreview, NOTIFY_DEFAULTS, openLink, preClassify, providerOf, readVerdict, redFlag,
  shouldNotify,
  type MailCategory, type PreviewMail,
} from "../src/mail-categories.ts";
import { mailView, mountMailPanel, readerText } from "../src/mail-panel.ts";
import { createMailbox, takeMail, takeOwnMail, type AgentMailMessage, type RecentMail } from "../src/mail.ts";
import type { Inbound } from "../src/whatsapp.ts";

// The page's own module (plain JavaScript, no types): what the tabs count and when the Apple Mail link shows.
const { showLink, tabCounts } = (await import(new URL("../src/panel/mail.js", import.meta.url).href)) as {
  showLink: (link: unknown, ua?: string) => boolean;
  tabCounts: (items: { category: string }[]) => Record<string, number>;
};

const T0 = Date.parse("2026-11-18T09:00:00Z"); // 10:00 in Madrid
const HOUR = 3600_000;
const memKv = (): Kv & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
};

// ---------- the triage's answer ----------

test("triage: every category is read from its word, with the why, the ask and the loop; SECURITY marks an Updates alert", () => {
  const word: Record<MailCategory, string> = {
    needs_you: "NEEDS_YOU", waiting: "WAITING", important: "IMPORTANT", personal: "PERSONAL", updates: "UPDATES", read_later: "READ_LATER",
    promotions: "PROMOTIONS", suspicious: "SUSPICIOUS",
  };
  for (const c of CATEGORIES) {
    const p = parseEmailVerdict(`${word[c]}\nWHY: because\nThe summary.`);
    assert.equal(p.verdict?.category, c, c);
    assert.equal(p.verdict?.why, "because");
    assert.equal(p.summary, "The summary.");
    assert.equal(p.scam, c === "suspicious");
    assert.equal(p.notify, c === "needs_you" || c === "suspicious", `${c}: only Needs you and Suspicious notify by default`);
  }
  const ask = readVerdict("NEEDS_YOU\nWHY: Ana asks for the budget\nASK: decide | Ana asks you to approve the budget by Friday\nLOOP: Approve the budget | Ana | 2026-11-20\nShe needs it for the board.");
  assert.deepEqual(ask?.verdict, {
    category: "needs_you", why: "Ana asks for the budget", security: false,
    ask: { action: "decide", text: "Ana asks you to approve the budget by Friday" }, loop: { title: "Approve the budget", who: "Ana", due: "2026-11-20" },
  });
  assert.equal(ask?.rest, "She needs it for the board.");
  const sec = parseEmailVerdict("UPDATES SECURITY\nWHY: A new sign-in\nSomeone signed in from Lisbon.");
  assert.equal(sec.verdict?.security, true);
  assert.equal(sec.notify, true, "a security alert notifies by default");
  assert.equal(parseEmailVerdict("Needs you\nx").verdict?.category, "needs_you", "the word written with a space reads too");
  // An ask or a loop is only for the categories that owe something; a date that does not read is left out, never guessed.
  assert.equal(readVerdict("IMPORTANT\nWHY: x\nASK: reply | Ana asks\nLOOP: Do it | Ana | 2026-11-20\ny")?.verdict.ask, undefined);
  assert.equal(readVerdict("IMPORTANT\nWHY: x\nLOOP: Do it | Ana | 2026-11-20\ny")?.verdict.loop, undefined);
  assert.equal(readVerdict("WAITING\nLOOP: Send the contract | Nadia | next Friday\ny")?.verdict.loop?.due, "");
  assert.equal(readVerdict("WAITING\nASK: reply | Nadia asks\ny")?.verdict.ask, undefined, "Waiting on others has no ask: nothing is on the owner");
  assert.equal(readVerdict("Hello, this is a summary."), null, "no category line: the caller tells the owner rather than lose it");
  assert.equal(parseEmailVerdict("Hello.").notify, true);
  // The run's lines cannot carry a tag or hidden characters into the panel.
  assert.equal(readVerdict("NEEDS_YOU\nWHY: <b>x</b>\u200b y\nz")?.verdict.why, "bx/b y");
});

test("triage: records kept before categories read as one, and a broken record never throws", () => {
  assert.equal(categoryOf({ kind: "aviso", summary: "Ana asks you to confirm the dinner." }), "needs_you", "told, with an ask");
  assert.equal(categoryOf({ kind: "aviso", summary: "¿Cenamos el viernes?" }), "needs_you");
  assert.equal(categoryOf({ kind: "aviso", summary: "The board approved the plan." }), "important", "told, no ask");
  assert.equal(categoryOf({ kind: "aviso", summary: "Pide tu PIN.", scam: true }), "suspicious");
  assert.equal(categoryOf({ kind: "guardado", subject: "Your order has shipped", summary: "" }), "updates");
  assert.equal(categoryOf({ kind: "guardado", summary: "Un informe." }), "important");
  assert.equal(categoryOf({ kind: "masivo" }), "promotions");
  assert.equal(categoryOf({ kind: "pendiente" }), "important", "waiting for its summary");
  assert.equal(categoryOf({ category: "read_later", kind: "aviso" }), "read_later", "its own category wins");
  assert.equal(categoryOf({ category: "nonsense", kind: 42, summary: null } as never), "important");
  assert.equal(categoryOf({}), "important");
});

// ---------- before Claude ----------

const intake = (box: ReturnType<typeof createMailbox>, vip: string[] = []) => {
  const queued: Inbound[] = [];
  return { queued, d: { box, enqueue: async (m: Inbound) => (queued.push(m), true), lang: () => "en" as const, now: () => T0, vip } };
};
/**
 * An email as the intake reads it. Unless `auth` says otherwise, the owner's mail server vouched for the sender (DKIM aligned with From):
 * `auth: false` leaves the header out, a string is the header's own value.
 */
const msg = (o: Partial<AgentMailMessage> & { headers?: Record<string, string>; auth?: string | false }): AgentMailMessage => {
  const { auth, headers, ...rest } = o;
  const domain = (/@([^>\s]+)>?\s*$/.exec(String(o.from ?? ""))?.[1] ?? "").toLowerCase();
  const results = auth === false ? {} : { "Authentication-Results": auth ?? `mx.owner.example; dkim=pass header.d=${domain}; spf=pass` };
  return { timestamp: new Date(T0 - HOUR).toISOString(), subject: "Hello", text: "Words.", ...rest, headers: { ...results, ...headers } };
};

test("pre-classification: mail sent to a list is Promotions, or Read later when it is a newsletter; a carrier's notice is Updates; no run of Claude for any", async () => {
  const box = createMailbox(memKv(), { lang: () => "en" });
  const { d, queued } = intake(box, ["boss@work.example"]);
  await takeMail(d, "p1", msg({ from: "Shop <offers@shop.example>", subject: "-50% today", headers: { "List-Unsubscribe": "<mailto:u@shop.example>" } }), "personal");
  await takeMail(d, "p2", msg({ from: "Weekly <hi@weekly.substack.com>", subject: "This week", headers: { "List-Id": "<weekly.substack.com>" } }), "personal");
  await takeMail(d, "p3", msg({ from: "Digest <digest@news.example>", subject: "Your daily digest", headers: { Precedence: "bulk" } }), "personal");
  await takeMail(d, "p4", msg({ from: "UPS <pkinfo@ups.com>", subject: "Your package is on its way" }), "personal");
  await takeMail(d, "p5", msg({ from: "Shop <receipts@shop.example>", subject: "Receipt" }), "personal");
  await takeMail(d, "p6", msg({ from: "Boss <boss@work.example>", subject: "Board", headers: { "List-Id": "<board.work.example>" } }), "trabajo");
  await takeMail(d, "p7", msg({ from: "Ana <ana@friends.example>", subject: "Dinner?" }), "personal");
  const got = Object.fromEntries((await box.items()).map((m) => [m.id, m.category]));
  assert.deepEqual(got, { p1: "promotions", p2: "read_later", p3: "read_later", p4: "updates", p5: "updates", p6: "important", p7: "important" });
  assert.deepEqual(queued.map((q) => q.id), ["mail:p6", "mail:p7"], "only the VIP (always read, even from a list) and the unknown person go to Claude");
  assert.match((await box.get("p1"))!.why!, /mailing list/);
  assert.equal(preClassify({ from: "a@b.example", subject: "x", bulk: false }, []), null);
});

test("the gate: a look-alike orders@ with no or failed DKIM goes to Claude, which files it Suspicious; an authenticated receipt is pre-filed", async () => {
  const box = createMailbox(memKv(), { lang: () => "en" });
  const { d, queued } = intake(box);
  const fake = { from: "Amazon <orders@amaz0n-billing.example>", subject: "Your order receipt", text: "Pay the overdue amount at https://amaz0n-billing.example/pay" };
  await takeMail(d, "s1", msg({ ...fake, auth: false }), "personal");
  await takeMail(d, "s2", msg({ ...fake, auth: "mx.owner.example; dkim=fail header.d=amaz0n-billing.example; spf=softfail; dmarc=fail" }), "personal");
  await takeMail(d, "s3", msg({ ...fake, auth: "mx.owner.example; dkim=none; spf=none; dmarc=none" }), "personal");
  assert.deepEqual(queued.map((q) => q.id), ["mail:s1", "mail:s2", "mail:s3"], "none is filed without Claude");
  // The stubbed triage's answer, as the bridge would post it.
  const triage = parseEmailVerdict("SUSPICIOUS\nWHY: A fake receipt asking you to pay through a link\nCareful: this looks like a scam.");
  await box.annotate("s1", "aviso", triage.summary, T0, { scam: triage.scam, verdict: triage.verdict! });
  assert.equal((await box.get("s1"))?.category, "suspicious");
  assert.equal(await box.notifies("s1"), true, "and the owner is warned");
  // The real shop's receipt, signed by its own domain: Updates, no run.
  await takeMail(d, "s4", msg({ from: "Shop <orders@shop.example>", subject: "Your order receipt", text: "Thanks for your order. Total 23.90 EUR." }), "personal");
  assert.equal(queued.length, 3);
  assert.equal((await box.get("s4"))?.category, "updates");
});

test("the gate: only the topmost Authentication-Results counts; DKIM must be aligned with From; DMARC pass counts for its own From", () => {
  const from = "Shop <orders@shop.example>";
  assert.equal(authenticated(from, ["mx.owner.example; dkim=pass header.d=shop.example"]), true);
  assert.equal(authenticated(from, ["mx.owner.example; dkim=pass header.i=@mail.shop.example"]), true, "a subdomain of the same organisation");
  assert.equal(authenticated("X <a@news.shop.example>", ["mx.owner.example; dkim=pass header.d=shop.example"]), true, "From on a subdomain");
  assert.equal(authenticated(from, ["mx.owner.example; dkim=pass header.d=mailer.example"]), false, "signed, but by another domain");
  assert.equal(authenticated(from, ["mx.owner.example; dkim=pass header.d=example"]), false, "a bare suffix is not the organisation");
  assert.equal(authenticated("Shop <a@shop.co.uk>", ["mx.owner.example; dkim=pass header.d=other.co.uk"]), false, "co.uk is shared");
  assert.equal(authenticated(from, ["mx.owner.example; spf=pass; dmarc=pass (p=REJECT) header.from=shop.example"]), true);
  assert.equal(authenticated(from, ["mx.owner.example; dmarc=pass header.from=evil.example"]), false);
  assert.equal(authenticated(from, ["mx.owner.example; dkim=softfail header.d=shop.example; dmarc=fail"]), false);
  assert.equal(authenticated(from, ["mx.owner.example; spf=pass smtp.mailfrom=shop.example"]), false, "SPF alone does not prove From");
  assert.equal(authenticated(from, []), false, "no header");
  // A sender can write its own header further down; only the receiving server's, on top, is read.
  assert.equal(authenticated(from, ["mx.owner.example; dkim=fail header.d=shop.example", "forged.example; dkim=pass header.d=shop.example"]), false);
});

test("the gate: a misaligned DKIM domain and every red flag send the mail to Claude even when authenticated", async () => {
  const box = createMailbox(memKv(), { lang: () => "en" });
  const { d, queued } = intake(box);
  const bulk = { "List-Unsubscribe": "<mailto:u@shop.example>" };
  await takeMail(d, "g1", msg({ from: "Shop <deals@shop.example>", auth: "mx.owner.example; dkim=pass header.d=bulkmailer.example", headers: bulk }), "personal");
  await takeMail(d, "g2", msg({ from: "support@bank.example <deals@shop.example>", headers: bulk }), "personal");
  await takeMail(d, "g3", msg({ from: "Shop <deals@shop.example>", headers: { ...bulk, "Reply-To": "Help <help@elsewhere.example>" } }), "personal");
  await takeMail(d, "g4", msg({ from: "Shop <deals@shop.example>", headers: bulk, text: "Your invoice is overdue: https://pay-now.example/invoice" }), "personal");
  await takeMail(d, "g5", msg({ from: "Shop <deals@shop.example>", headers: bulk, html: "<p>Reset your password</p><a href=\"https://reset.example/x\">here</a>" }), "personal");
  assert.deepEqual(queued.map((q) => q.id), ["mail:g1", "mail:g2", "mail:g3", "mail:g4", "mail:g5"]);
  assert.equal(redFlag({ from: "Shop <deals@shop.example>", replyTo: ["deals@shop.example"], subject: "Sale", text: "Pay at https://www.shop.example/cart" }), "", "its own links and Reply-To are fine");
  // An authenticated one with none of them: filed at once.
  await takeMail(d, "g6", msg({ from: "Shop <deals@shop.example>", headers: bulk, text: "50% off at https://www.shop.example" }), "personal");
  assert.equal(queued.length, 5);
  assert.equal((await box.get("g6"))?.category, "promotions");
});

test("learning: a rule is never borrowed by a spoofed copy of the address (DKIM fail), nor by another address on the domain", async () => {
  const box = createMailbox(memKv(), { lang: () => "en" });
  const { d, queued } = intake(box);
  await box.record({ id: "r0", at: T0, from: "News <newsletter@paper.example>", subject: "x", preview: "", kind: "guardado" });
  await box.move("r0", "read_later", T0);
  await takeMail(d, "r1", msg({ from: "News <newsletter@paper.example>", auth: "mx.owner.example; dkim=fail header.d=paper.example; dmarc=fail" }), "personal");
  await takeMail(d, "r2", msg({ from: "Editor <editor@paper.example>" }), "personal");
  assert.deepEqual(queued.map((q) => q.id), ["mail:r1", "mail:r2"]);
  await takeMail(d, "r3", msg({ from: "News <newsletter@paper.example>" }), "personal");
  assert.equal(queued.length, 2, "the real, signed one follows the rule");
  assert.equal((await box.get("r3"))?.category, "read_later");
});

test("learning: Move to… teaches a sender rule that files their next mail before Claude runs; rules are listed and removable", async () => {
  const kv = memKv();
  const box = createMailbox(kv, { lang: () => "en" });
  const { d, queued } = intake(box);
  await takeMail(d, "a1", msg({ from: "News <newsletter@paper.example>", subject: "Today" }), "personal");
  assert.equal(queued.length, 1, "first time: Claude reads it");
  const moved = await box.move("a1", "read_later", T0);
  assert.equal(moved?.category, "read_later");
  assert.equal(moved?.moved, true);
  assert.deepEqual((await box.rules()).map((r) => [r.from, r.category]), [["newsletter@paper.example", "read_later"]]);
  // A late triage answer does not move it back.
  await box.annotate("a1", "aviso", "Today's paper.", T0, { verdict: { category: "needs_you", why: "x", security: false } });
  assert.equal((await box.get("a1"))?.category, "read_later");
  await takeMail(d, "a2", msg({ from: "News <newsletter@paper.example>", subject: "Tomorrow" }), "personal");
  assert.equal(queued.length, 1, "the rule filed it: no run of Claude");
  assert.equal((await box.get("a2"))?.category, "read_later");
  assert.match((await box.get("a2"))!.why!, /Your rule: mail from newsletter@paper\.example goes to Read later/);
  // Kept across a restart (the store), and removable.
  const again = createMailbox(kv, { lang: () => "en" });
  assert.equal((await again.rules()).length, 1);
  assert.equal(await again.forgetRule("newsletter@paper.example"), true);
  assert.equal(await again.forgetRule("newsletter@paper.example"), false);
  await takeMail({ ...intake(again).d, enqueue: d.enqueue }, "a3", msg({ from: "News <newsletter@paper.example>", subject: "Later" }), "personal");
  assert.equal(queued.length, 2, "rule gone: Claude reads it again");
});

// ---------- notifications ----------

test("notifications: by default only Needs you, Suspicious and security alerts; a VIP always; the owner's switches decide the rest", async () => {
  const on = CATEGORIES.filter((c) => shouldNotify({ category: c }, NOTIFY_DEFAULTS));
  assert.deepEqual(on, ["needs_you", "suspicious"]);
  assert.equal(shouldNotify({ category: "updates", security: true }, NOTIFY_DEFAULTS), true);
  assert.equal(shouldNotify({ category: "updates" }, NOTIFY_DEFAULTS), false);
  assert.equal(shouldNotify({ category: "promotions", vip: true }, NOTIFY_DEFAULTS), true, "a VIP always notifies");
  assert.equal(shouldNotify({}, NOTIFY_DEFAULTS), true, "no category: told rather than lost");
  for (const c of ["waiting", "important"] as const) assert.equal(shouldNotify({ category: c }, NOTIFY_DEFAULTS), false, `${c}: the brief, never real time`);

  const box = createMailbox(memKv(), { lang: () => "en" });
  await box.record({ id: "n1", at: T0, from: "Ana <ana@x.example>", subject: "Hi", preview: "", kind: "pendiente" });
  await box.annotate("n1", "guardado", "Ana says hi.", T0, { verdict: { category: "personal", why: "A friend", security: false } });
  assert.equal(await box.notifies("n1"), false);
  await box.setNotify("personal", true);
  assert.equal(await box.notifies("n1"), true, "the owner turned Personal on");
  await box.record({ id: "n2", at: T0, from: "CEO <ceo@x.example>", subject: "Q", preview: "", kind: "pendiente", vip: true });
  await box.annotate("n2", "guardado", "x", T0, { verdict: { category: "promotions", why: "x", security: false } });
  assert.equal(await box.notifies("n2"), true, "a VIP");
});

// ---------- loops ----------

const engineRig = () => {
  const kv = memKv();
  const clock = { now: T0 };
  const engine = createFollowups({
    config: { delayMs: 10 * 60_000, maxPerDay: 6, batchMs: 3 * 60_000, quiet: null },
    kv, timeZone: "Europe/Madrid", now: () => clock.now, lang: () => "en",
    enqueue: async () => true, card: async () => true, notify: async () => undefined,
  });
  return { kv, clock, engine };
};

test("loops: Needs you is a request to the owner and Waiting on others a promise owed to them, with the person, the date and the mail; an answer closes what was owed", async () => {
  const { engine } = engineRig();
  const need = readVerdict("NEEDS_YOU\nWHY: x\nASK: decide | Ana asks you to approve the budget by Friday\nLOOP: Approve the budget | Ana | 2026-11-20\ny")!.verdict;
  const wait = readVerdict("WAITING\nWHY: x\nLOOP: Send the signed contract | Nadia | 2026-11-21 17:00\ny")!.verdict;
  assert.equal(loopFromVerdict(readVerdict("IMPORTANT\nWHY: x\ny")!.verdict, "Ana"), null, "Important makes no loop");
  assert.equal(await engine.fromMail({ ref: "m-need", label: "email · Ana", at: T0 - HOUR, loops: [loopFromVerdict(need, "Ana Ruiz")!] }), 1);
  assert.equal(await engine.fromMail({ ref: "m-wait", label: "email · Nadia", at: T0 - HOUR, loops: [loopFromVerdict(wait, "Nadia")!], thread: "00000000000000aa" }), 1);
  const loops = (await engine.read()).loops;
  const owe = loops.find((l) => l.sources[0]?.ref === "m-need")!;
  assert.equal(owe.kind, "request_to_owner");
  assert.equal(owe.who, "Ana");
  assert.equal(owe.title, "Approve the budget");
  assert.equal(owe.where.type, "mail");
  assert.equal(owe.sources[0]!.kind, "mail");
  assert.equal(owe.sources[0]!.at, T0 - HOUR);
  assert.equal(new Date(owe.dueAt!).toISOString(), "2026-11-20T17:00:00.000Z", "a day alone is 18:00 in the owner's zone");
  const owed = loops.find((l) => l.sources[0]?.ref === "m-wait")!;
  assert.equal(owed.kind, "other_promise");
  assert.equal(owed.who, "Nadia");
  assert.equal(new Date(owed.dueAt!).toISOString(), "2026-11-21T16:00:00.000Z");
  // The same mail again does not make a second loop.
  assert.equal(await engine.fromMail({ ref: "m-need", label: "email · Ana", at: T0 - HOUR, loops: [loopFromVerdict(need, "Ana Ruiz")!] }), 0);
  // Nadia writes again in that thread: what she owed is closed; what the owner owes Ana is not touched.
  assert.equal(await engine.answered({ who: ["Nadia", "nadia@vendor.example"], ref: "m-later", thread: "00000000000000aa" }), 1);
  const after = (await engine.read()).loops;
  assert.equal(after.find((l) => l.id === owed.id)!.status, "done");
  assert.equal(after.find((l) => l.id === owe.id)!.status, "open");
  assert.equal(await engine.answered({ who: ["Ana"], ref: "m-later2", thread: "00000000000000aa" }), 0, "an answer from Ana never closes what the owner owes her");
});

// ---------- the panel: tabs, the reader, the links ----------

test("panel: the tab counts every category, 0 for the empty ones", () => {
  const n = tabCounts([{ category: "needs_you" }, { category: "needs_you" }, { category: "promotions" }, { category: "suspicious" }]);
  assert.deepEqual(n, { needs_you: 2, waiting: 0, important: 0, personal: 0, updates: 0, read_later: 0, promotions: 1, suspicious: 1 });
  assert.deepEqual(Object.keys(n), [...CATEGORIES], "in the decided order");
});

test("open in your mail app: Gmail by Message-ID, Apple Mail's message: link only on a Mac, Outlook's search, nothing without a Message-ID", () => {
  assert.equal(providerOf("imap.gmail.com", []), "gmail");
  assert.equal(providerOf(undefined, ["Marta <marta@gmail.com>"]), "gmail");
  assert.equal(providerOf("imap.mail.me.com", []), "apple");
  assert.equal(providerOf(undefined, ["x@icloud.com"]), "apple");
  assert.equal(providerOf("outlook.office365.com", []), "office365");
  assert.equal(providerOf(undefined, ["x@hotmail.com"]), "outlook");
  assert.equal(providerOf("mail.example.org", ["x@example.org"]), undefined);
  const id = "CAF+abc=123@mail.gmail.com";
  assert.equal(openLink({ provider: "gmail", messageId: `<${id}>` })!.url, "https://mail.google.com/mail/u/0/#search/rfc822msgid%3ACAF%2Babc%3D123%40mail.gmail.com");
  const apple = openLink({ provider: "apple", messageId: id })!;
  assert.equal(apple.url, "message://%3CCAF%2Babc%3D123@mail.gmail.com%3E");
  assert.equal(apple.macOnly, true);
  assert.equal(showLink(apple, "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)"), true);
  assert.equal(showLink(apple, "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), false, "a browser that is not on a Mac never sees it");
  assert.equal(openLink({ provider: "office365", messageId: id, subject: "Q1 budget" })!.url, "https://outlook.office.com/mail/search?q=Q1%20budget");
  assert.equal(openLink({ provider: "outlook", messageId: id, subject: "Hi" })!.url, "https://outlook.live.com/mail/0/search?q=Hi");
  assert.equal(openLink({ provider: "gmail" }), null, "no Message-ID: no button");
  assert.equal(openLink({ provider: "gmail", messageId: "not an id" }), null);
  assert.equal(openLink({ messageId: id }), null, "another provider: no button, the reader is enough");
  assert.equal(showLink(null), false);
});

/** The panel's routes on a real port: GET and POST as the page sends them. */
async function panel(box: ReturnType<typeof createMailbox> | null, loops: Parameters<typeof mountMailPanel>[1]["loops"] = () => null) {
  const app = express();
  mountMailPanel(app, { signedIn: () => true, box, timeZone: "Europe/Madrid", loops, now: () => T0 });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (p: string) => (await fetch(`${base}${p}`)).json() as Promise<Record<string, unknown>>;
  const post = async (p: string, body: unknown) =>
    (await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-pako": "1" }, body: JSON.stringify(body) })).json() as Promise<Record<string, unknown>>;
  // Another site cannot send the x-pako header: without it nothing changes.
  const bare = async (p: string, body: unknown) => (await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status;
  return { get, post, bare, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("reader: plain text only (no script, no remote image, links as words), one-time codes hidden, the link where the owner's mail lives", async () => {
  const box = createMailbox(memKv(), { lang: () => "en" });
  const { d } = intake(box);
  const html = `<html><head><style>p{}</style><script>fetch("https://evil.example/x")</script></head><body><p>Hi Marta,</p>
    <img src="https://tracker.example/pixel.png" width="1"><p>Your sign-in code is 482913.</p>
    <p>See <a href="https://docs.example/plan">the plan</a> at https://docs.example/plan</p><iframe src="https://evil.example"></iframe></body></html>`;
  await takeMail({ ...d, provider: "gmail" }, "r1", msg({ from: "Ana <ana@friends.example>", subject: "Plan", html, text: undefined, headers: { "Message-ID": "<abc123@mail.friends.example>" } }), "personal");
  const p = await panel(box);
  try {
    const r = await p.get("/panel/api/mail/item?id=r1");
    const text = String(r.text);
    assert.doesNotMatch(text, /<script|fetch\(|<img|pixel\.png|<iframe|<a |p\{\}/i);
    assert.match(text, /Hi Marta,/);
    assert.match(text, /https:\/\/docs\.example\/plan/, "a link is shown as words");
    assert.doesNotMatch(text, /482913/, "the code stays hidden");
    assert.equal(r.partial, false);
    assert.deepEqual(r.link, { provider: "gmail", label: "Open in Gmail", url: "https://mail.google.com/mail/u/0/#search/rfc822msgid%3Aabc123%40mail.friends.example" });
    // A text part that carries markup is made text too; hidden characters go.
    assert.equal(readerText("<div>Hello<script>x()</script> <img src=https://t.example/p.gif></div>\u202eabc"), "Hello\nabc");
    // An older record without words of its own and without a Message-ID: its summary, said to be partial, and no button.
    await box.record({ id: "old", at: T0 - HOUR, from: "Luis <l@x.example>", subject: "Old", preview: "first lines", kind: "aviso", summary: "Luis asks about Tuesday?" });
    const old = await p.get("/panel/api/mail/item?id=old");
    assert.equal(old.text, "Luis asks about Tuesday?");
    assert.equal(old.partial, true);
    assert.equal(old.link, null);
    assert.equal((old.item as RecentMail).category, "needs_you");
  } finally {
    await p.close();
  }
});

// ---------- the dashboard's "Needs you" preview ----------

const pm = (o: Partial<PreviewMail> & { id: string }): PreviewMail => ({ at: T0 - HOUR, from: "Ana <ana@x.example>", subject: o.id, category: "needs_you", ...o });

test("preview: overdue first, then due today, then the oldest waiting; only Needs you and unread Important; the ask only from the triage", () => {
  const items: PreviewMail[] = [
    pm({ id: "old", at: T0 - 50 * HOUR, ask: { action: "reply", text: "Luis asks if Tuesday works" } }),
    pm({ id: "newer", at: T0 - 2 * HOUR }),
    pm({ id: "today", at: T0 - HOUR, due: "2026-11-18 17:00", ask: { action: "do", text: "Send the deck by 17:00" } }),
    pm({ id: "late", at: T0 - 3 * HOUR, due: "2026-11-17", ask: { action: "decide", text: "Approve the budget" } }),
    pm({ id: "read", category: "important", at: T0 - 5 * HOUR }),
    pm({ id: "read-opened", category: "important", openedAt: T0 }),
    pm({ id: "promo", category: "promotions" }),
    pm({ id: "upd", category: "updates" }),
    pm({ id: "later", category: "read_later" }),
    pm({ id: "sus", category: "suspicious" }),
    pm({ id: "waiting", category: "waiting" }),
    pm({ id: "done", handledAt: T0 }),
    pm({ id: "replied", repliedAt: T0 }),
    pm({ id: "too-old", at: T0 - 40 * 24 * HOUR }),
  ];
  const { rows, more } = needsPreview(items, () => [], { now: T0, timeZone: "Europe/Madrid", max: 10 });
  assert.deepEqual(rows.map((r) => r.id), ["late", "today", "old", "newer", "read"]);
  assert.equal(more, 0);
  assert.equal(rows[0]!.overdue, true);
  assert.equal(rows[1]!.today, true);
  assert.deepEqual(rows.map((r) => r.tag), ["decide", "do", "reply", "do", "read"]);
  assert.equal(rows.find((r) => r.id === "newer")!.ask, undefined, "no ask from the triage: the subject only, never an invented line");
  assert.equal(rows.find((r) => r.id === "read")!.ask, undefined);
  assert.equal(rows[0]!.from, "Ana");
  const five = needsPreview(items, () => [], { now: T0, timeZone: "Europe/Madrid", max: 2 });
  assert.deepEqual([five.rows.length, five.more], [2, 3], "+N more");
  // A Needs you mail whose loops were all closed (a check, a button, an answer) is dealt with; one still open stays, with the loop's time.
  const byLoop = needsPreview([pm({ id: "x" }), pm({ id: "y" })], (id) => (id === "x" ? [{ open: false }] : [{ open: true, dueAt: T0 - HOUR }]), { now: T0, timeZone: "Europe/Madrid" });
  assert.deepEqual(byLoop.rows.map((r) => [r.id, r.overdue]), [["y", true]]);
});

test("preview: Done hides the row, closes its loop through the button's path and survives a restart; Undo brings both back", async () => {
  const kv = memKv();
  const { engine } = engineRig();
  const box = createMailbox(kv, { lang: () => "en" });
  await box.record({ id: "d1", at: T0 - HOUR, from: "Ana <ana@x.example>", subject: "Budget", preview: "", kind: "pendiente" });
  await box.annotate("d1", "aviso", "Ana asks you to approve the budget.", T0, {
    verdict: { category: "needs_you", why: "x", security: false, ask: { action: "decide", text: "Ana asks you to approve the budget" } },
  });
  const loop = loopFromVerdict(readVerdict("NEEDS_YOU\nLOOP: Approve the budget | Ana | 2026-11-20\ny")!.verdict, "Ana")!;
  await engine.fromMail({ ref: "d1", label: "email · Ana", at: T0 - HOUR, loops: [loop] });
  const loops = () => ({ all: async () => (await engine.read()).loops, doneFor: (ref: string) => engine.doneFor(ref), reopen: (ids: string[]) => engine.reopen(ids) });
  const p = await panel(box, loops);
  try {
    let view = await p.get("/panel/api/mail/view") as { connected: boolean; needs: { rows: { id: string; ask?: string }[] }; loops: Record<string, { open: boolean }> };
    assert.deepEqual(view.needs.rows.map((r) => [r.id, r.ask]), [["d1", "Ana asks you to approve the budget"]]);
    assert.equal(view.loops.d1!.open, true, "the list shows its loop");
    const done = await p.post("/panel/api/mail/done", { id: "d1" }) as { ok: boolean; closed: string[] };
    assert.equal(done.closed.length, 1);
    const closed = (await engine.read()).loops[0]!;
    assert.equal(closed.status, "done");
    assert.equal(closed.lastCheck, "Owner marked done.");
    assert.equal(closed.nextCheckAt, 0, "never checked or nudged again");
    view = await p.get("/panel/api/mail/view") as typeof view;
    assert.deepEqual(view.needs.rows, []);
    // A restart: a new mailbox on the same store still knows it was handled.
    const again = createMailbox(kv, { lang: () => "en" });
    assert.equal((await again.get("d1"))?.handledAt, T0);
    assert.deepEqual((await mailView({ box: again, timeZone: "Europe/Madrid", loops }, T0)).needs.rows, []);
    // Undo: the row and the loop come back.
    await p.post("/panel/api/mail/undone", { id: "d1" });
    view = await p.get("/panel/api/mail/view") as typeof view;
    assert.deepEqual(view.needs.rows.map((r) => r.id), ["d1"]);
    assert.equal((await engine.read()).loops[0]!.status, "open");
  } finally {
    await p.close();
  }
});

test("preview: a reply of the owner's in Sent (In-Reply-To or References) removes the row and closes its loop", async () => {
  const closed: string[][] = [];
  const box = createMailbox(memKv(), { lang: () => "en", onReplied: (ids) => closed.push(ids) });
  const { d } = intake(box);
  await takeMail(d, "q1", msg({ from: "Luis <luis@x.example>", subject: "Tuesday?", headers: { "Message-ID": "<q1@x.example>" } }), "personal");
  await box.annotate("q1", "aviso", "Luis asks if Tuesday works?", T0, { verdict: { category: "needs_you", why: "x", security: false } });
  assert.equal((await mailView({ box, timeZone: "Europe/Madrid", loops: () => null }, T0)).needs.rows.length, 1);
  assert.deepEqual(await takeOwnMail(box, { headers: { "In-Reply-To": "<other@x.example>" } }, T0), [], "a reply to something else");
  assert.deepEqual(await takeOwnMail(box, { headers: { References: "<root@x.example> <q1@x.example>" } }, T0), ["q1"]);
  assert.deepEqual(closed, [["q1"]], "its loops are closed through onReplied");
  assert.equal((await box.get("q1"))?.repliedAt, T0);
  assert.deepEqual((await mailView({ box, timeZone: "Europe/Madrid", loops: () => null }, T0)).needs.rows, []);
});

test("preview: opening a 'to read' mail in the reader removes it; the empty and the not-connected states", async () => {
  const none = await mailView({ box: null, timeZone: "Europe/Madrid", loops: () => null }, T0);
  assert.equal(none.connected, false, "mail not connected: the block is hidden");
  const box = createMailbox(memKv(), { lang: () => "en" });
  const empty = await mailView({ box, timeZone: "Europe/Madrid", loops: () => null }, T0);
  assert.deepEqual([empty.connected, empty.needs.rows, empty.needs.more], [true, [], 0], "nothing needs the owner: one calm line");
  await box.record({ id: "i1", at: T0 - HOUR, from: "Marc <m@x.example>", subject: "FYI", preview: "", kind: "guardado", category: "important" });
  await box.record({ id: "pr", at: T0 - HOUR, from: "Shop <s@x.example>", subject: "Sale", preview: "", kind: "masivo", category: "promotions" });
  assert.deepEqual((await mailView({ box, timeZone: "Europe/Madrid", loops: () => null }, T0)).needs.rows.map((r) => [r.id, r.tag]), [["i1", "read"]]);
  const p = await panel(box);
  try {
    await p.get("/panel/api/mail/item?id=i1");
  } finally {
    await p.close();
  }
  assert.deepEqual((await mailView({ box, timeZone: "Europe/Madrid", loops: () => null }, T0)).needs.rows, []);
});

test("panel routes: Move to… teaches the rule, the settings list switches and rules, a switch changes, a rule is removed; a POST needs the header", async () => {
  const box = createMailbox(memKv(), { lang: () => "en" });
  await box.record({ id: "m1", at: T0, from: "Deals <deals@shop.example>", subject: "x", preview: "", kind: "guardado" });
  const p = await panel(box);
  try {
    assert.equal(await p.bare("/panel/api/mail/move", { id: "m1", category: "promotions" }), 401);
    assert.equal(await p.bare("/panel/api/mail/done", { id: "m1" }), 401);
    assert.equal((await box.get("m1"))?.category, "important", "unchanged");
    const moved = await p.post("/panel/api/mail/move", { id: "m1", category: "promotions" }) as { item: RecentMail; rule: { from: string } };
    assert.equal(moved.item.category, "promotions");
    assert.equal(moved.rule.from, "deals@shop.example");
    assert.deepEqual(await p.post("/panel/api/mail/move", { id: "m1", category: "spam" }), { error: "bad" });
    let s = await p.get("/panel/api/mail/settings") as { notify: Record<string, boolean>; rules: { from: string }[]; labels: Record<string, string> };
    assert.deepEqual(s.notify, NOTIFY_DEFAULTS);
    assert.equal(s.labels.waiting, "Waiting on others");
    assert.equal(s.rules.length, 1);
    await p.post("/panel/api/mail/notify", { key: "waiting", on: true });
    await p.post("/panel/api/mail/rule/delete", { from: "deals@shop.example" });
    s = await p.get("/panel/api/mail/settings") as typeof s;
    assert.equal(s.notify.waiting, true);
    assert.deepEqual(s.rules, []);
  } finally {
    await p.close();
  }
});
