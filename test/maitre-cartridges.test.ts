// The cartridges driven through hand-made engine pages by the real CDP driver against a real local Chrome (headless, a temporary profile,
// a local server: nothing leaves 127.0.0.1). Without a Chromium browser on the machine (CI) these are skipped, with the reason.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BrowserPool, findBrowser } from "../src/maitre/cdp.ts";
import type { Cartridge, CartridgeContext, Guest } from "../src/maitre/cartridge.ts";
import { coverManager } from "../src/maitre/cartridges/covermanager.ts";
import { openTable } from "../src/maitre/cartridges/opentable.ts";
import { theFork } from "../src/maitre/cartridges/thefork.ts";
import { createMaitre } from "../src/maitre/planner.ts";
import type { Kv } from "../src/kv.ts";
import { startFixtureServer, type FixtureServer } from "./helpers/maitre-server.ts";

const exe = findBrowser();
const skip = exe ? false : "no Chrome, Edge, Brave or Chromium installed here: the cartridge tests need a real browser";

const GUEST: Guest = { firstName: "Marta", lastName: "Puig Soler", email: "marta@example.com", phone: "34600111222", notes: "una trona" };

/** A day about three weeks ahead that is not a Monday (the fixture module is closed on Mondays) nor a Sunday (TheFork's fixture is). */
function aDay(): string {
  const d = new Date();
  d.setDate(d.getDate() + 20);
  while (d.getDay() === 1 || d.getDay() === 0) d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function memoryKv(): Kv {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

let srv: FixtureServer;
let pool: BrowserPool;
let profile: string;
const DATE = aDay();

before(async () => {
  if (!exe) return;
  srv = await startFixtureServer();
  profile = mkdtempSync(join(tmpdir(), "pako-maitre-profile-"));
  // A shared CI runner can take more than the product's 20 s to start Chrome (seen on GitHub, 2026-11-21: "did not open its debugging port
  // in time"); the browser's start is not what these tests check, so they give it a minute.
  pool = new BrowserPool({ executable: exe, profileDir: profile, idleMs: 60_000, timeoutMs: 15_000, launchTimeoutMs: 60_000 });
});

after(async () => {
  if (!exe) return;
  await pool.close();
  await srv.close();
  rmSync(profile, { recursive: true, force: true });
});

const ctxOf = (page: CartridgeContext["page"], url: string, extra: Partial<CartridgeContext> = {}): CartridgeContext => ({
  page, url, stepMs: 8000, submitting: async () => undefined, ...extra,
});
const cm = (slug: string): string => `${srv.base}/reservation/module_restaurant/${slug}/english`;

test("maitre cdp: CoverManager Look reads the free times from the module's own JSON, and never submits", { skip }, async () => {
  const t0 = Date.now();
  const r = await pool.withPage((page) => coverManager.look(ctxOf(page, cm("fixture")), { date: DATE, time: "21:00", party: 2 }));
  const ms = Date.now() - t0;
  assert.equal(r.kind, "slots");
  assert.deepEqual(r.kind === "slots" && r.slots.map((s) => s.time), ["13:00", "13:30", "20:30", "21:00", "21:30"]);
  assert.equal(srv.submits.length, 0);
  console.log(`# timing: CoverManager fixture Look ${ms} ms (browser start included)`);
});

test("maitre cdp: CoverManager Book fills the form, checks the summary, submits once and verifies the thank-you page", { skip }, async () => {
  let pressed = 0;
  const before = srv.submits.length;
  const shot = join(profile, "shots", "cm.png");
  const t0 = Date.now();
  const r = await pool.withPage((page) => coverManager.book(ctxOf(page, cm("fixture"), { submitting: async () => void pressed++, shotPath: shot }), { date: DATE, time: "21:00", party: 2 }, GUEST));
  console.log(`# timing: CoverManager fixture Book ${Date.now() - t0} ms`);
  assert.equal(r.kind, "confirmed", JSON.stringify(r));
  assert.equal(pressed, 1, "the ledger was told right before the one press");
  assert.equal(srv.submits.length, before + 1);
  const sent = srv.submits.at(-1)!;
  assert.equal(sent.first, "Marta");
  assert.equal(sent.last, "Puig Soler");
  assert.equal(sent.phone, "34600111222", "the country code in its select, the number without it");
  assert.equal(sent.newsletter, "false", "the newsletter is left off");
  assert.equal(sent.notes, "una trona");
  if (r.kind === "confirmed") {
    assert.match(r.evidence.confirmationId ?? "", /^CM\d+X$/);
    assert.deepEqual(r.evidence.said, { date: DATE, time: "21:00", party: 2 });
    assert.match(r.evidence.cancelUrl ?? "", /\/cancel\/CM/);
    assert.ok(r.evidence.screenshot && existsSync(r.evidence.screenshot), "a screenshot of the confirmation is kept");
  }
});

test("maitre cdp: CoverManager says no_slot with the nearest real times, and a full day with none", { skip }, async () => {
  const r = await pool.withPage((page) => coverManager.book(ctxOf(page, cm("fixture")), { date: DATE, time: "21:15", party: 2 }, GUEST));
  assert.equal(r.kind, "no_slot");
  assert.deepEqual(r.kind === "no_slot" && r.alternatives.map((s) => s.time), ["21:00", "21:30", "20:30"]);
  const full = await pool.withPage((page) => coverManager.book(ctxOf(page, cm("full")), { date: DATE, time: "21:00", party: 2 }, GUEST));
  assert.deepEqual(full, { kind: "no_slot", alternatives: [] });
});

test("maitre cdp: CoverManager gates (captcha on Reserve, a card, an email code) stop with the gate and nothing is taken", { skip }, async () => {
  const before = srv.submits.length;
  for (const [slug, gate] of [["captcha", "captcha"], ["card", "card"], ["code", "code"]] as const) {
    const r = await pool.withPage((page) => coverManager.book(ctxOf(page, cm(slug)), { date: DATE, time: "21:00", party: 2 }, GUEST));
    assert.equal(r.kind, "gate", `${slug}: ${JSON.stringify(r)}`);
    assert.equal(r.kind === "gate" && r.gate, gate);
    assert.equal(r.kind === "gate" && r.submitted, false);
  }
  assert.equal(srv.submits.length, before, "no gate case reached the engine");
});

test("maitre cdp: CoverManager picks the required zone and says which; an expired form is 'changed'", { skip }, async () => {
  const r = await pool.withPage((page) => coverManager.book(ctxOf(page, cm("zone")), { date: DATE, time: "20:30", party: 2 }, GUEST));
  assert.equal(r.kind, "confirmed", JSON.stringify(r));
  assert.equal(r.kind === "confirmed" && r.evidence.said?.zone, "Terraza");
  const x = await pool.withPage((page) => coverManager.book(ctxOf(page, cm("expired")), { date: DATE, time: "20:30", party: 2 }, GUEST));
  assert.equal(x.kind, "changed");
});

test("maitre cdp: CoverManager cancel goes through the cancel page and its 'are you sure?'", { skip }, async () => {
  const before = srv.cancels.length;
  const ok = await pool.withPage((page) => coverManager.cancel!(ctxOf(page, cm("fixture")), { url: "", text: "", cancelUrl: `${srv.base}/cancel/CM77X` }));
  assert.equal(ok, true);
  assert.deepEqual(srv.cancels.slice(before), ["CM77X"]);
});

test("maitre cdp: TheFork Look reads the times from the deep link; Book goes to the sign-in step and hands over; DataDome is 'blocked'", { skip }, async () => {
  const url = `${srv.base}/restaurant/le-fixture-r123`;
  const look = await pool.withPage((page) => theFork.look(ctxOf(page, url), { date: DATE, time: "21:00", party: 2 }));
  assert.equal(look.kind, "slots", JSON.stringify(look));
  assert.deepEqual(look.kind === "slots" && look.slots.map((s) => `${s.time}${s.offer ? ` ${s.offer}` : ""}`), ["20:00", "20:30", "21:00 -20%", "21:30"]);
  const book = await pool.withPage((page) => theFork.book(ctxOf(page, url), { date: DATE, time: "21:00", party: 2 }, GUEST));
  assert.deepEqual(book, { kind: "gate", gate: "login", detail: "TheFork sign-in", submitted: false });
  const blocked = await pool.withPage((page) => theFork.look(ctxOf(page, `${srv.base}/restaurant/le-blocked-r9`), { date: DATE, time: "21:00", party: 2 }));
  assert.equal(blocked.kind, "blocked");
  const blockedBook = await pool.withPage((page) => theFork.book(ctxOf(page, `${srv.base}/restaurant/le-blocked-r9`), { date: DATE, time: "21:00", party: 2 }, GUEST));
  assert.equal(blockedBook.kind, "blocked");
});

test("maitre cdp: OpenTable Look and Book through the deep link, with the confirmation number; Akamai is 'blocked', a code is a gate", { skip }, async () => {
  const url = `${srv.base}/r/fixture-grill`;
  const look = await pool.withPage((page) => openTable.look(ctxOf(page, url), { date: DATE, time: "21:00", party: 2 }));
  assert.deepEqual(look.kind === "slots" && look.slots.map((s) => s.time), ["20:30", "21:00", "21:30"]);
  const before = srv.submits.length;
  const book = await pool.withPage((page) => openTable.book(ctxOf(page, url), { date: DATE, time: "21:00", party: 2 }, GUEST));
  assert.equal(book.kind, "confirmed", JSON.stringify(book));
  assert.match(book.kind === "confirmed" ? book.evidence.confirmationId ?? "" : "", /^4\d+$/);
  assert.equal(srv.submits.length, before + 1);
  assert.equal(srv.submits.at(-1)!.phone, "+34600111222");
  const blocked = await pool.withPage((page) => openTable.look(ctxOf(page, `${srv.base}/r/akamai-grill`), { date: DATE, time: "21:00", party: 2 }));
  assert.equal(blocked.kind, "blocked");
  const otp = await pool.withPage((page) => openTable.book(ctxOf(page, `${srv.base}/r/otp-grill`), { date: DATE, time: "21:00", party: 2 }, GUEST));
  assert.equal(otp.kind, "gate");
  assert.equal(otp.kind === "gate" && otp.gate, "code");
});

/** The cartridges with their address check widened to the local server's pages. */
const local = (c: Cartridge, path: RegExp): Cartridge => ({ ...c, matches: (u: string) => path.test(u) });

test("maitre cdp: two Book presses for one key at once submit exactly once; the second is refused as a duplicate", { skip }, async () => {
  const maitre = createMaitre({
    kv: memoryKv(), pool, sleep: async () => undefined, stepMs: 8000,
    cartridges: [local(coverManager, /\/module_restaurant\//)],
  });
  srv.slowSubmitMs = 400;
  const before = srv.submits.length;
  const req = { placeId: "P1", name: "Fixture", url: cm("fixture"), date: DATE, time: "13:30", party: 2, guest: GUEST };
  const [a, b] = await Promise.all([maitre.book(req), maitre.book(req)]);
  srv.slowSubmitMs = 0;
  const kinds = [a.kind, b.kind].sort();
  assert.deepEqual(kinds, ["confirmed", "duplicate"]);
  assert.equal(srv.submits.length, before + 1, "the engine saw one submit");
  // And again later: the confirmed key is refused before a page is even opened.
  const c = await maitre.book(req);
  assert.equal(c.kind, "duplicate");
  assert.equal(srv.submits.length, before + 1);
});

test("maitre cdp: a gate opens the Handoff window filled up to Reserve; the owner's press is seen and confirmed by the watcher", { skip }, async () => {
  const ends: string[] = [];
  // A pool whose "window" is a headless tab kept open (no window pops up on the machine running the tests): the test plays the owner in it.
  let ownerPage: CartridgeContext["page"] | null = null;
  const watched = {
    withPage: pool.withPage.bind(pool),
    openWindow: async () => {
      await pool.withPage(async (p) => void (ownerPage = p), { keep: true });
      return { page: ownerPage!, release: () => void ownerPage?.close() };
    },
  };
  const m2 = createMaitre({
    kv: memoryKv(), pool: watched, sleep: async () => undefined, stepMs: 8000, handoffEveryMs: 200, handoffWatchMs: 20_000,
    cartridges: [local(coverManager, /\/module_restaurant\//)],
    onHandoffEnd: (e) => void ends.push(e.kind),
  });
  const before = srv.submits.length;
  const out = await m2.book({ placeId: "P2", name: "Captcha Bar", url: cm("captcha"), date: DATE, time: "21:00", party: 2, guest: GUEST });
  assert.equal(out.kind, "handoff", JSON.stringify(out));
  assert.equal(out.kind === "handoff" && out.reason, "captcha");
  assert.equal(srv.submits.length, before, "nothing taken before the owner");
  // The window is at Reserve with everything filled in.
  const page = ownerPage!;
  await page.waitForSelector("#btn-validate", 8000);
  assert.equal(await page.evaluate("document.getElementById('user_first_name').value"), "Marta");
  assert.equal(await page.evaluate("document.getElementById('consentimiento_legal').checked"), true);
  // "done" before anything: not yet.
  const early = await m2.done(out.kind === "handoff" ? out.entry.id : "");
  assert.equal(early?.kind, "not_yet");
  // The owner finishes on the page (the fixture's captcha case lets a person's own submit through when they bypass the gate by hand).
  await page.evaluate(`fetch('/reservation/submit', { method: 'POST', body: 'slug=owner' }).then(() => { location.href = '/gracias-por-su-reserva?date=x&time=21:00&pax=2&id=OWN1' })`);
  const deadline = Date.now() + 10_000;
  while (!ends.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(ends, ["confirmed"]);
  const e = await m2.ledger.get(out.kind === "handoff" ? out.entry.id : "");
  assert.equal(e?.state, "confirmed");
  assert.equal(e?.evidence?.confirmationId, "OWN1");
});
