// Follow-up loops kept, matched and closed correctly, each pinned by the test that showed a bug: open loops lost to the store's cap, the wrong loop closed or
// drafted by a name inside another name, a Slack conversation lost when its job could not be queued, a meeting's agreed meetings cut from its
// review, a weekday worked out from a bare date, and a meeting moved on a calendar whose event ids carry their start taken for a cancellation.
import assert from "node:assert/strict";
import { test } from "node:test";
import { diffEvents } from "../src/calendar-changes.ts";
import { createFollowups, FOLLOWUPS_KEY } from "../src/followups.ts";
import type { Kv } from "../src/kv.ts";
import { createMeetingReview, reviewLoops, type ReviewFound } from "../src/meeting-review.ts";
import type { Inbound } from "../src/whatsapp.ts";

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
/** Friday 20 November 2026, 10:00 in London. */
const T0 = Date.parse("2026-11-20T10:00:00Z");

function memKv() {
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  return { kv, m };
}

const loop = (id: string, title: string, who: string, o: Record<string, unknown> = {}) => ({
  id, kind: "owner_promise", title, detail: "", who, where: { type: "mail", label: "email" }, whenSaid: T0 - H,
  check: { none: { reason: "email" } }, status: "open", nextCheckAt: 0, nudges: 0, createdAt: T0 - H,
  sources: [{ kind: "mail", label: "email", at: T0 - H, ref: `m-${id}` }], ...o,
});

function rig(loops: unknown[], o: { enqueue?: (m: Inbound) => Promise<boolean>; clock?: { now: number } } = {}) {
  const { kv, m } = memKv();
  m.set(FOLLOWUPS_KEY, JSON.stringify({ loops }));
  const clock = o.clock ?? { now: T0 };
  const queued: Inbound[] = [];
  const engine = createFollowups({
    config: { delayMs: 10 * MIN, maxPerDay: 6, batchMs: 3 * MIN, quiet: null },
    kv, timeZone: "Europe/London", now: () => clock.now, enqueue: o.enqueue ?? (async (x) => (queued.push(x), true)),
    card: async () => true, notify: async () => undefined,
  });
  const stored = () => JSON.parse(m.get(FOLLOWUPS_KEY)!) as { loops: { id: string; status: string }[]; batches: unknown[] };
  return { engine, stored, queued, clock };
}

test("store: the cap drops closed loops before an open one, however old the open one is", async () => {
  // A promise due in three weeks, made ten days ago; since then a busy fortnight of loops, all closed.
  const keep = loop("b000000000", "Send the board pack to Ana", "Ana", { createdAt: T0 - 10 * DAY, whenSaid: T0 - 10 * DAY, dueAt: T0 + 21 * DAY });
  const closed = Array.from({ length: 99 }, (_, i) =>
    loop(`c${String(i).padStart(9, "0")}`, `Closed thing ${i}`, "Omar", { status: "done", closedAt: T0 - H, createdAt: T0 - 2 * DAY }));
  const r = rig([keep, ...closed]);
  assert.ok(await r.engine.fromChat({ title: "Call the bank about the mortgage", due: "2026-11-23 10:00" }), "a new promise, the 101st loop");
  const s = r.stored();
  assert.ok(s.loops.some((l) => l.id === "b000000000" && l.status === "open"), "the open promise is still kept");
  assert.equal(s.loops.length, 100);
  assert.ok(!s.loops.some((l) => l.id === "c000000000"), "the oldest closed one went instead");
});

test("mail: an email from Mariana does not close what Ana owes; one from Ana in that thread does, one from Ana in another thread does not", async () => {
  const TH = "0123456789abcdef";
  const theirs = (id: string, who: string) =>
    loop(id, `Send the signed contract (${who})`, who, { kind: "other_promise", where: { type: "mail", label: "email", mailThread: TH } });
  const r = rig([theirs("a000000001", "Ana"), theirs("a000000002", "Ruiz")]);
  // What Pako knows of each person's addresses (the contacts, the mail the promise came from).
  const known = async (l: { who: string }) => (l.who === "Ana" ? ["Ana Garcia <ana.garcia@example.com>"] : ["Ruiz <ruiz@example.com>"]);
  const from = (who: string, address: string, ref: string, thread?: string) =>
    r.engine.answered({ who: [who, address], from: address, ref, known, ...(thread ? { thread } : {}) });
  assert.equal(await from("Mariana Lopez", "mariana.lopez@example.com", "new-1", TH), 0);
  assert.equal(await from("Peter Druiz", "peter@example.com", "new-2", TH), 0);
  assert.deepEqual(r.stored().loops.map((l) => l.status), ["open", "open"]);
  // Ana writes about lunch, in another thread: not the contract she promised.
  assert.equal(await from("", "ana.garcia@example.com", "new-3", "fedcba9876543210"), 0);
  assert.equal(await from("", "ana.garcia@example.com", "new-4"), 0, "no thread known: not taken as the answer");
  assert.equal(r.stored().loops[0]!.status, "open");
  // Someone else writes in that thread with Ana's name (or an address that looks like hers): her name alone closes nothing.
  assert.equal(await from("Ana Garcia", "billing@attacker.example", "new-6", TH), 0);
  assert.equal(await from("", "ana@attacker.example", "new-7", TH), 0);
  assert.equal(r.stored().loops[0]!.status, "open");
  assert.equal(await from("", "Ana.Garcia@example.com", "new-5", TH), 1);
  const ana = r.stored().loops[0] as unknown as { status: string; autoClosed?: { why: string } };
  assert.equal(ana.status, "done");
  assert.match(ana.autoClosed!.why, /answered in that email thread/, "closed by Pako, with why: the brief lists it");
});

test("chat: «done, Ana's deck» closes Ana's loop, not Mariana's; with only Mariana's open it closes nothing", async () => {
  const r = rig([loop("a000000001", "Send Ana the deck", "Ana"), loop("a000000002", "Send Mariana the deck", "Mariana")]);
  const out = await r.engine.closeByWords(["deck Ana"]);
  assert.deepEqual(out.closed.map((c) => c.id), ["a000000001"]);
  assert.deepEqual(out.many, []);
  const only = rig([loop("a000000002", "Send Mariana the deck", "Mariana")]);
  const none = await only.engine.closeByWords(["deck Ana"]);
  assert.deepEqual(none.closed, [], "Mariana's loop is not closed by Ana's name");
  assert.equal(only.stored().loops[0]!.status, "open");
  // A word still finds its longer form: "deck" names "decks".
  const plural = rig([loop("a000000003", "Send Omar the decks", "Omar")]);
  assert.equal((await plural.engine.closeByWords(["deck"])).closed.length, 1);
});

test("draft: «DRAFT Ana» is never the draft for Mariana's loop", async () => {
  const r = rig([loop("a000000002", "Send Mariana the deck", "Mariana")]);
  assert.deepEqual(await r.engine.forDraft("Ana"), { none: true });
});

test("Slack: a conversation whose job could not be queued is kept and queued at the next tick, never lost", async () => {
  let fail = true;
  const queued: Inbound[] = [];
  const clock = { now: T0 };
  const r = rig([], { clock, enqueue: async (m) => {
    if (fail) throw new Error("the inbox could not be written");
    queued.push(m);
    return true;
  } });
  await r.engine.observeSlack({ channel: "D0ROHAN", ts: String(T0 / 1000), at: T0, who: "Rohan", where: "Rohan (DM)", direct: true, text: "Can you send me the deck by Monday?" });
  clock.now = T0 + 4 * MIN;
  await r.engine.tick();
  assert.equal(queued.length, 0);
  fail = false;
  clock.now = T0 + 5 * MIN;
  await r.engine.tick();
  assert.equal(queued.length, 1, "queued at the next tick");
  assert.match(queued[0]!.followup!.text, /\* \[.*\] Rohan: Can you send me the deck by Monday\?/);
  assert.deepEqual(r.stored().batches, []);
});

test("meeting review: a full review keeps its agreed meetings as loops too", async () => {
  const item = (title: string, who: string) => ({ title, who, evidence: "" });
  const found: ReviewFound = {
    summary: "", decisions: [], questions: [],
    todos: Array.from({ length: 6 }, (_, i) => item(`Send document number ${i}`, "Ana")),
    promises: Array.from({ length: 5 }, (_, i) => item(`Share the figures for region ${i}`, "Omar")),
    meetings: [{ ...item("Steering committee with the client", "Stan"), due: T0 + 3 * DAY }],
  };
  const r = rig([]);
  const n = await r.engine.ingest({ ref: "zoom-1", label: "Q4 review", at: T0 - H, loops: reviewLoops(found, T0 - H, T0, "Europe/London", "en") });
  assert.equal(n, 12);
  assert.ok((await r.engine.read()).loops.some((l) => l.kind === "agreed_meeting"), "the agreed meeting is a loop");
});

test("job text: the Now line names the weekday, so «Friday» said on a Friday is worked out from it", async () => {
  const queued: Inbound[] = [];
  const r = rig([], { enqueue: async (m) => (queued.push(m), true) });
  await r.engine.offer({ source: "mail", ref: "m1", label: "Ana", text: "I'll send it Friday." });
  assert.match(queued[0]!.followup!.text, /^Now: 2026-11-20 10:00, Friday \(Europe\/London\)/);
});

test("meeting review: the Now line and the meeting's start name their weekdays («Tuesday» is the next one after it)", async () => {
  const queued: Inbound[] = [];
  const rv = createMeetingReview({
    config: { waitMs: 120 * MIN }, kv: null, timeZone: "Europe/London", now: () => T0, enqueue: async (m) => (queued.push(m), true), notify: async () => undefined,
  });
  assert.ok(await rv.summary({ id: "z1", topic: "Q4 review", at: T0 - DAY, text: "Ana will send the deck on Tuesday.", notice: "" }));
  assert.match(queued[0]!.review!.head, /^Now: 2026-11-20 10:00, Friday \(Europe\/London\)\nThe meeting started: 2026-11-19 10:00, Thursday /);
});

test("calendar: a meeting moved on a calendar whose ids carry the start (the Mac, CalDAV, a link) is a move, not a cancellation", () => {
  const snap = (id: string, start: number, uid?: string, title = "Lunch with Omar") => ({ id, title, start, end: start + H, ...(uid ? { uid } : {}) });
  // The Mac's ids: its own id and the start, no UID from an older app.
  assert.deepEqual(diffEvents([snap(`mac:E1@${T0 + 5 * H}`, T0 + 5 * H)], [snap(`mac:E1@${T0 + 7 * H}`, T0 + 7 * H)], T0).map((c) => [c.kind, c.start - T0, (c.was ?? 0) - T0]),
    [["moved", 7 * H, 5 * H]]);
  // CalDAV: the UID and the start.
  assert.deepEqual(diffEvents([snap(`U1@${T0 + 5 * H}`, T0 + 5 * H, "U1")], [snap(`U1@${T0 + 2 * DAY}`, T0 + 2 * DAY, "U1")], T0).map((c) => c.kind), ["moved"]);
  // A weekly meeting: this week's moved by two hours, next week's untouched, a new one coming into the window, and a single event gone.
  const week = (n: number, at = T0 + 26 * H + n * 7 * DAY) => snap(`mac:W@${at}`, at, "W", "Weekly sync");
  const changes = diffEvents(
    [week(0), week(1), snap("mac:X@" + (T0 + 3 * H), T0 + 3 * H, "X", "Dentist")],
    [week(0, T0 + 28 * H), week(1), week(2)],
    T0,
  );
  assert.deepEqual(changes.map((c) => [c.kind, c.title, c.start - T0]), [["moved", "Weekly sync", 28 * H], ["cancelled", "Dentist", 3 * H]]);
});
