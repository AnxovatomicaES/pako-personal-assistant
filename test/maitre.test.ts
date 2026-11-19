// Maître without a browser: the ledger's idempotency, the lanes and their order, the engines' policy and pace, the Look cache, and the
// small readers the cartridges share. Always run (no Chrome needed).

import assert from "node:assert/strict";
import test from "node:test";
import type { Kv } from "../src/kv.ts";
import { browserCandidates, findBrowser, type Page, type PagePool } from "../src/maitre/cdp.ts";
import { hhmm, nearest, policyOf, type BookResult, type Cartridge, type LookResult } from "../src/maitre/cartridge.ts";
import { cartridgeFor } from "../src/maitre/cartridges/index.ts";
import { freeTimes, hoursOf } from "../src/maitre/cartridges/covermanager.ts";
import { forkLink } from "../src/maitre/cartridges/thefork.ts";
import { tableLink } from "../src/maitre/cartridges/opentable.ts";
import { confirmsBooking, createLedger, DuplicateBooking, ledgerKey } from "../src/maitre/ledger.ts";
import { createMaitre, medianMs, nextLane, planLanes } from "../src/maitre/planner.ts";

function memoryKv(): Kv & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

const ENTRY = { placeId: "P1", name: "Bar Mut", engine: "CoverManager", url: "https://www.covermanager.com/reservation/module_restaurant/restaurante-barmut/english", date: "2026-11-20", time: "21:00", party: 2, guest: "Marta Puig" };

// ---------- the ledger ----------

test("maitre ledger: one key, one booking: a submitted or confirmed key refuses a new attempt and a second submit", async () => {
  let t = 1_000_000;
  const ledger = createLedger({ kv: memoryKv(), now: () => t });
  const a = await ledger.plan(ENTRY);
  assert.equal(a.key, ledgerKey("P1", "2026-11-20", "21:00", 2));
  // A live planned attempt already blocks a second one (two presses of Book).
  await assert.rejects(ledger.plan(ENTRY), DuplicateBooking);
  await ledger.submitting(a.id);
  await assert.rejects(ledger.submitting(a.id), DuplicateBooking, "the same attempt cannot submit twice");
  t += 3600_000;
  await assert.rejects(ledger.plan(ENTRY), DuplicateBooking, "submitted: maybe booked, never tried again");
  await ledger.confirm(a.id, { url: "https://barmut.example/gracias", text: "ok" });
  await assert.rejects(ledger.plan(ENTRY), (err: unknown) => err instanceof DuplicateBooking && err.existing.state === "confirmed");
  // Another time, another party or another day is another key.
  assert.ok(await ledger.plan({ ...ENTRY, time: "21:30" }));
  assert.ok(await ledger.plan({ ...ENTRY, party: 3 }));
});

test("maitre ledger: concurrent submits for one key: exactly one wins", async () => {
  const ledger = createLedger({ kv: memoryKv(), now: () => 5 });
  const a = await ledger.plan(ENTRY);
  const results = await Promise.allSettled([ledger.submitting(a.id), ledger.submitting(a.id), ledger.submitting(a.id)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
});

test("maitre ledger: a failure before any submit frees the key; a submit with no answer keeps it; the store survives a restart", async () => {
  const kv = memoryKv();
  let t = 0;
  const ledger = createLedger({ kv, now: () => t });
  const a = await ledger.plan(ENTRY);
  await ledger.fail(a.id, "no_slot");
  assert.equal((await ledger.get(a.id))?.state, "failed");
  const b = await ledger.plan(ENTRY);
  await ledger.submitting(b.id);
  await ledger.fail(b.id, "timeout after submit");
  assert.equal((await ledger.get(b.id))?.state, "submitted", "a lost answer may have booked: it stays submitted");
  t += 25 * 3600_000;
  const again = createLedger({ kv, now: () => t });
  await assert.rejects(again.plan(ENTRY), DuplicateBooking, "read back from the store after a restart");
  assert.equal((await again.lastDay()).length, 0, "but it no longer counts toward today's limit");
});

test("maitre ledger: a store that cannot be read refuses to plan anything", async () => {
  const ledger = createLedger({ kv: { get: async () => { throw new Error("disk"); }, set: async () => undefined } });
  await assert.rejects(ledger.plan(ENTRY), /disk/);
});

test("maitre ledger: the engine's confirmation email is recognised by the restaurant's name, a confirmation word and the day", () => {
  const e = { name: "Bar Mut", date: "2026-11-20", engine: "CoverManager" };
  assert.ok(confirmsBooking({ at: 0, from: "CoverManager <no-reply@covermanager.com>", subject: "Reserva confirmada en Bar Mut", preview: "Tu reserva para el 20/11/2026 a las 21:00" }, e));
  assert.ok(confirmsBooking({ at: 0, from: "x", subject: "Your reservation at Bar Mut", preview: "Friday, November 20 at 9 pm for 2" }, e));
  assert.ok(!confirmsBooking({ at: 0, from: "x", subject: "Your reservation at Bar Mut", preview: "Saturday, November 21" }, e), "another day");
  assert.ok(!confirmsBooking({ at: 0, from: "x", subject: "Newsletter from Cal Pep", preview: "20/11/2026 reserva" }, e), "another restaurant");
});

// ---------- lanes, policy, pace ----------

test("maitre planner: lanes in order Passport, Cartridge, Handoff, Off-web; Resy is handoff-only; a page that changed twice turns the cartridge off", () => {
  const now = 10 * 86_400_000;
  assert.deepEqual(planLanes({ engine: "CoverManager", hasCartridge: true, now }), ["cartridge", "handoff", "offweb"]);
  const passport = { engine: "CoverManager", url: "u", version: 1, required: [], gates: [], times: [], failures: [] };
  assert.deepEqual(planLanes({ engine: "CoverManager", hasCartridge: true, passport, now }), ["passport", "cartridge", "handoff", "offweb"]);
  assert.deepEqual(planLanes({ engine: "Resy", hasCartridge: false, now }), ["handoff", "offweb"]);
  assert.deepEqual(planLanes({ engine: null, hasCartridge: false, now }), ["offweb"]);
  const broken = { ...passport, failures: [{ at: now - 1000, reason: "changed" }, { at: now - 500, reason: "changed" }] };
  assert.deepEqual(planLanes({ engine: "CoverManager", hasCartridge: true, passport: broken, now }), ["passport", "handoff", "offweb"]);
  assert.equal(policyOf("Resy").handoffOnly, true);
  assert.equal(policyOf("Resy").maxPerHour, 0);
  assert.equal(policyOf("CoverManager").handoffOnly, false);
});

test("maitre planner: a typed failure picks the next lane, never a blind retry", () => {
  const cases: [BookResult, string][] = [
    [{ kind: "confirmed", evidence: { url: "", text: "" } }, "done"],
    [{ kind: "gate", gate: "captcha", detail: "", submitted: false }, "handoff"],
    [{ kind: "blocked", detail: "DataDome" }, "handoff"],
    [{ kind: "no_slot", alternatives: [] }, "ask"],
    [{ kind: "changed", detail: "" }, "offweb"],
    [{ kind: "timeout", detail: "", submitted: false }, "handoff"],
    [{ kind: "timeout", detail: "", submitted: true }, "stop"],
  ];
  for (const [r, lane] of cases) assert.equal(nextLane(r), lane, r.kind);
  assert.equal(medianMs([30, 10, 20]), 20);
});

/** A cartridge that counts its calls and answers what the test says. */
function fakeCartridge(o: { look?: LookResult; book?: (submitting: () => Promise<void>) => Promise<BookResult>; engine?: string } = {}) {
  const calls = { look: 0, book: 0, cancel: 0 };
  const c: Cartridge = {
    engine: o.engine ?? "CoverManager",
    version: 1,
    matches: (u) => /covermanager\.com/.test(u),
    required: ["firstName", "lastName", "email", "phone"],
    gates: [],
    blocks: [],
    look: async () => (calls.look++, o.look ?? { kind: "slots", slots: [{ date: "2026-11-20", time: "21:00", party: 2 }] }),
    book: async (ctx) => (calls.book++, o.book ? o.book(ctx.submitting) : (await ctx.submitting(), { kind: "confirmed", evidence: { url: "https://barmut.example/gracias", text: "ok", cancelUrl: "https://x/cancel" } })),
    verify: async () => null,
    cancel: async () => (calls.cancel++, true),
  };
  return { c, calls };
}
const fakePool: PagePool = {
  withPage: (fn) => fn({} as Page),
  openWindow: async () => ({ page: { goto: async () => ({ status: 200 }) } as unknown as Page, release: () => undefined }),
};
const GUEST = { firstName: "Marta", lastName: "Puig", email: "m@example.com", phone: "34600111222" };

test("maitre planner: Look runs across candidates at once and is cached five minutes per restaurant, day and party", async () => {
  let t = 1_000_000;
  const { c, calls } = fakeCartridge();
  const m = createMaitre({ kv: memoryKv(), pool: fakePool, cartridges: [c], now: () => t, sleep: async () => undefined });
  const cands = [
    { placeId: "A", url: "https://www.covermanager.com/reservation/module_restaurant/a/english" },
    { placeId: "B", url: "https://www.covermanager.com/reservation/module_restaurant/b/english" },
    { placeId: "C", url: "https://resy.com/cities/ny/venues/c" },
  ];
  const q = { date: "2026-11-20", time: "21:00", party: 2 };
  const first = await m.look(cands, q);
  assert.equal(first.get("A")?.kind, "slots");
  assert.equal(first.get("C")?.kind, "skipped", "no cartridge: nothing opened");
  assert.equal(calls.look, 2);
  await m.look(cands, { ...q, time: "20:00" });
  assert.equal(calls.look, 2, "the same day and party within five minutes: from the cache");
  t += 5 * 60_000 + 1;
  await m.look(cands, q);
  assert.equal(calls.look, 4);
});

test("maitre planner: each engine at a person's pace, and no more than its hourly budget", async () => {
  let t = 0;
  const waits: number[] = [];
  const { c, calls } = fakeCartridge();
  const m = createMaitre({ kv: memoryKv(), pool: fakePool, cartridges: [c], now: () => t, sleep: async (ms) => void (waits.push(ms), (t += ms)) });
  const q = { date: "2026-11-20", time: "21:00", party: 2 };
  const many = Array.from({ length: 32 }, (_, i) => ({ placeId: `R${i}`, url: `https://www.covermanager.com/reservation/module_restaurant/r${i}/english` }));
  const out = await m.look(many, q);
  assert.equal(calls.look, policyOf("CoverManager").maxPerHour, "the hour's budget");
  assert.equal([...out.values()].filter((r) => r.kind === "skipped").length, 32 - policyOf("CoverManager").maxPerHour);
  assert.ok(waits.every((w) => w <= policyOf("CoverManager").minGapMs) && waits.length >= 28, "a gap before each load after the first");
});

test("maitre planner: Resy is never automated: a Book opens the owner's window at the deep link (Handoff) and nothing is pressed", async () => {
  const { c, calls } = fakeCartridge({ engine: "Resy" });
  const resy: Cartridge = { ...c, matches: (u) => /resy\.com/.test(u) };
  const m = createMaitre({ kv: memoryKv(), pool: fakePool, cartridges: [resy], sleep: async () => undefined });
  const look = await m.look([{ placeId: "R", url: "https://resy.com/cities/ny/venues/x" }], { date: "2026-11-20", time: "21:00", party: 2 });
  assert.equal(look.get("R")?.kind, "skipped");
  const out = await m.book({ placeId: "R", name: "X", url: "https://resy.com/cities/ny/venues/x", date: "2026-11-20", time: "21:00", party: 2, guest: GUEST });
  assert.equal(out.kind, "handoff");
  assert.equal(out.kind === "handoff" && out.reason, "handoff_only");
  assert.equal(calls.book + calls.look, 0);
});

test("maitre planner: the inbox's confirmation stops a booking before any page is opened", async () => {
  const { c, calls } = fakeCartridge();
  const m = createMaitre({
    kv: memoryKv(), pool: fakePool, cartridges: [c], sleep: async () => undefined,
    recentMail: async () => [{ at: 0, from: "CoverManager", subject: "Reserva confirmada - Bar Mut", preview: "20/11/2026 21:00, 2 personas" }],
  });
  const out = await m.book({ placeId: "P1", name: "Bar Mut", url: ENTRY.url, date: "2026-11-20", time: "21:00", party: 2, guest: GUEST });
  assert.equal(out.kind, "duplicate");
  assert.equal(calls.book, 0);
});

test("maitre planner: a submit whose answer is lost is 'unknown', kept as submitted, and never pressed again", async () => {
  const { c, calls } = fakeCartridge({ book: async (submitting) => (await submitting(), { kind: "timeout", detail: "no answer", submitted: true }) });
  const m = createMaitre({ kv: memoryKv(), pool: fakePool, cartridges: [c], sleep: async () => undefined });
  const req = { placeId: "P1", name: "Bar Mut", url: ENTRY.url, date: "2026-11-20", time: "21:00", party: 2, guest: GUEST };
  const out = await m.book(req);
  assert.equal(out.kind, "unknown");
  assert.equal(out.kind === "unknown" && out.entry.state, "submitted");
  assert.equal((await m.book(req)).kind, "duplicate");
  assert.equal(calls.book, 1);
});

test("maitre planner: missing guest details go Off-web before anything is opened; a changed page is remembered in the Passport", async () => {
  const { c } = fakeCartridge({ book: async () => ({ kind: "changed", detail: "no #user_first_name" }) });
  const m = createMaitre({ kv: memoryKv(), pool: fakePool, cartridges: [c], sleep: async () => undefined });
  const base = { placeId: "P1", name: "Bar Mut", url: ENTRY.url, date: "2026-11-20", time: "21:00", party: 2 };
  assert.deepEqual(await m.book({ ...base, guest: { ...GUEST, phone: "" } }), { kind: "offweb", reason: "missing phone" });
  assert.equal((await m.book({ ...base, guest: GUEST })).kind, "offweb");
  assert.equal((await m.passport("P1"))?.failures.at(-1)?.reason, "changed");
});

// ---------- small readers ----------

test("maitre cartridges: the engines' own pages are recognised, the deep links carry the date, time and party", () => {
  assert.equal(cartridgeFor("https://www.covermanager.com/reservation/module_restaurant/restaurante-barmut/english")?.engine, "CoverManager");
  assert.equal(cartridgeFor("https://www.covermanager.com/reserve/module_restaurant/x/spanish")?.engine, "CoverManager");
  assert.equal(cartridgeFor("https://www.thefork.es/restaurante/casa-x-r12345")?.engine, "TheFork");
  assert.equal(cartridgeFor("https://widget.thefork.com/7b943543-c3ed-47e5-b197-dbfc8f98e207")?.engine, "TheFork");
  assert.equal(cartridgeFor("https://www.opentable.com/r/salt-creek-grille-dana-point?covers=2")?.engine, "OpenTable");
  assert.equal(cartridgeFor("https://www.opentable.com/restref/client/?rid=1&restref=1")?.engine, "OpenTable");
  assert.equal(cartridgeFor("https://resy.com/cities/new-york-ny/venues/carbone"), null);
  assert.equal(cartridgeFor("https://myplace.myrestoo.net/en/reservar"), null);
  assert.equal(forkLink("https://www.thefork.com/restaurant/le-comptoir-r843853", { date: "2026-11-20", time: "19:45", party: 2 }), "https://www.thefork.com/restaurant/le-comptoir-r843853#booking=&date=2026-11-20&hour=19%3A45&partySize=2");
  assert.match(tableLink("https://www.opentable.com/r/x", { date: "2026-12-10", time: "19:00", party: 4 }), /covers=4&dateTime=2026-12-10T19%3A00$/);
  assert.match(tableLink("https://www.opentable.com/restref/client/?rid=9&restref=9", { date: "2026-12-10", time: "19:00", party: 4 }), /datetime=2026-12-10T19%3A00&covers=4/);
});

test("maitre cartridges: CoverManager's update_hour_people answer (recorded 2026-11-18) gives the party's free times", () => {
  const recorded = JSON.stringify({
    total_fire: false, close: 0,
    hoursall: { "13:00": "13:00", "19:45": "19:45", "21:00": "21:00" },
    hour_box: `<label for="hour-box-select">Time</label>\n<div id='horas'>\n\t<select id="hour-box-select" class="form-control">\n <option value='-1' disabled>Select</option><option value="13:00">13:00</option><option value="21:00">21:00</option><option value="21:15">21:15</option></select></div>`,
  });
  assert.deepEqual(freeTimes(recorded), ["13:00", "21:00", "21:15"], "the party's list, not every hour of the day");
  assert.deepEqual(freeTimes(JSON.stringify({ close: 1, hour_box: "" })), []);
  assert.equal(freeTimes("<html>"), null);
  assert.deepEqual(hoursOf(`<option value='-1' disabled>Select</option><option value="20:30">20:30</option>`), ["20:30"]);
});

test("maitre cartridges: times read as people write them, and the nearest free ones first", () => {
  assert.equal(hhmm("9:00 PM"), "21:00");
  assert.equal(hhmm("12:15 am"), "00:15");
  assert.equal(hhmm("21.30 h"), "21:30");
  assert.equal(hhmm("timeslot-19:45"), "19:45");
  assert.equal(hhmm("soon"), null);
  const s = (time: string) => ({ date: "d", time, party: 2 });
  assert.deepEqual(nearest([s("13:00"), s("20:30"), s("21:30"), s("22:00")], "21:15").map((x) => x.time), ["21:30", "20:30", "22:00"]);
});

test("maitre cdp: browsers are looked for where each system installs them; PAKO_CHROME wins and a wrong one means none", () => {
  assert.ok(browserCandidates("darwin").some((p) => p.endsWith("Google Chrome.app/Contents/MacOS/Google Chrome")));
  assert.ok(browserCandidates("win32", { PROGRAMFILES: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }).some((p) => p.includes("msedge.exe")));
  assert.ok(browserCandidates("linux", { PATH: "/usr/bin:/snap/bin" }).includes("/usr/bin/chromium"));
  assert.equal(findBrowser({ PAKO_CHROME: "/nowhere/chrome" }), null);
});
