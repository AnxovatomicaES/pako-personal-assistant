// The beta's measuring audit (src/beta-audit.ts): the sample is stratified, weighted and capped; it asks one question at a time, never in the
// quiet hours, and stops after two ignored; the answers are stored as counts; nothing is kept unless the tester opted in, and opting out
// drops every line kept.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allocate, ASKS_MAX, AUDIT_BUTTON, auditCounts, createBetaAudit, drawSample, planOf, populationsOf, type AuditState, type BetaAudit,
} from "../src/beta-audit.ts";
import type { Job, Loop } from "../src/followups.ts";
import { seeded } from "../src/beta-measure.ts";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
// A Monday, 10:00 UTC: out of the quiet hours (23:00–08:00).
const T0 = Date.parse("2026-11-02T10:00:00Z");

test("allocate: in proportion, one at least per non-empty stratum while places last, never more than a stratum holds", () => {
  assert.deepEqual(allocate(8, [100, 10, 2]), [6, 1, 1]);
  assert.deepEqual(allocate(8, [3, 0, 2]), [3, 0, 2], "fewer than the places: all of them");
  assert.deepEqual(allocate(2, [5, 50, 9]), [0, 1, 1], "fewer places than strata: the largest first");
  assert.deepEqual(allocate(0, [5, 5]), [0, 0]);
  for (let i = 0; i < 200; i++) {
    const r = seeded(i);
    const sizes = [0, 1, 2, 3].map(() => Math.floor(r() * 30));
    const n = Math.floor(r() * 14);
    const a = allocate(n, sizes);
    assert.equal(a.reduce((x, y) => x + y, 0), Math.min(n, sizes.reduce((x, y) => x + y, 0)));
    a.forEach((k, j) => assert.ok(k <= sizes[j]! && (k > 0 || sizes[j] === 0 || n < sizes.filter((s) => s > 0).length)));
  }
});

test("plan: 8 threads, 2 follow-ups made, 2 closed; a kind that has too few gives its places to the others; 12 at most", () => {
  assert.deepEqual(planOf({ thread: 100, loop: 50, closed: 20 }), { thread: 8, loop: 2, closed: 2 });
  assert.deepEqual(planOf({ thread: 100, loop: 1, closed: 0 }), { thread: 11, loop: 1, closed: 0 });
  assert.deepEqual(planOf({ thread: 3, loop: 50, closed: 0 }), { thread: 3, loop: 9, closed: 0 });
  assert.deepEqual(planOf({ thread: 0, loop: 0, closed: 0 }), { thread: 0, loop: 0, closed: 0 });
});

test("sample: stratified by kind and source, each stratum's size kept (its weight), distinct picks, 12 at most", () => {
  const ids = (p: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${p}${i}`);
  const pop = [
    { kind: "thread" as const, source: "slack" as const, ids: ids("s", 90) },
    { kind: "thread" as const, source: "mail" as const, ids: ids("m", 30) },
    { kind: "thread" as const, source: "meeting" as const, ids: ids("z", 1) },
    { kind: "loop" as const, source: "slack" as const, ids: ids("l", 7) },
    { kind: "loop" as const, source: "chat" as const, ids: ids("c", 2) },
    { kind: "closed" as const, source: "mail" as const, ids: ids("k", 3) },
  ];
  const { strata, picks } = drawSample(pop, seeded(7));
  assert.equal(picks.length, ASKS_MAX);
  assert.equal(new Set(picks.map((p) => p.ref)).size, picks.length, "no item twice");
  const st = (kind: string, source: string) => strata.find((s) => s.kind === kind && s.source === source)!;
  assert.deepEqual(st("thread", "slack"), { kind: "thread", source: "slack", N: 90, drawn: 5 });
  assert.deepEqual(st("thread", "mail"), { kind: "thread", source: "mail", N: 30, drawn: 2 });
  assert.deepEqual(st("thread", "meeting"), { kind: "thread", source: "meeting", N: 1, drawn: 1 });
  assert.equal(st("loop", "slack").drawn + st("loop", "chat").drawn, 2);
  assert.equal(st("closed", "mail").drawn, 2);
  for (const p of picks) {
    const s = strata[p.stratum]!;
    assert.equal(s.kind, p.kind);
    assert.equal(s.source, p.source);
    assert.ok(pop.find((x) => x.kind === p.kind && x.source === p.source)!.ids.includes(p.ref));
  }
  // Each pick is as likely as any other of its stratum: over many draws, every slack thread comes up about 5/90 of the time.
  const hits = new Map<string, number>();
  for (let i = 0; i < 3000; i++) for (const p of drawSample(pop, seeded(1000 + i)).picks) if (p.source === "slack" && p.kind === "thread") hits.set(p.ref, (hits.get(p.ref) ?? 0) + 1);
  const rates = [...hits.values()].map((n) => n / 3000);
  assert.equal(hits.size, 90);
  assert.ok(Math.min(...rates) > 0.03 && Math.max(...rates) < 0.09, `${Math.min(...rates)}–${Math.max(...rates)} around ${5 / 90}`);
});

// ---------- the engine ----------

const SECRET_BODIES = ["Can you send me the Henderson contract by Thursday?", "I'll loop in Priya about the Q3 budget numbers"];
const loop = (id: string, o: Partial<Loop> = {}): Loop => ({
  id, kind: "owner_promise", title: `Send Ana Ruiz the pricing deck ${id}`, detail: "", who: "Ana Ruiz", where: { type: "slack_dm", label: "Ana Ruiz" },
  whenSaid: T0 + HOUR, check: { none: { reason: "" } }, status: "open", nextCheckAt: 0, nudges: 0, createdAt: T0 + HOUR,
  sources: [{ kind: "slack", label: "Ana Ruiz", at: T0 + HOUR }], ...o,
});
const job = (id: string, at: number, source: Job["source"] = "slack"): Job => ({
  id, at, source, where: { type: "slack_dm", label: "Ana Ruiz (private)" }, whenSaid: at, label: "Ana Ruiz (private)",
});

function rig(o: { on?: boolean; loops?: Loop[]; told?: string[]; cardOk?: boolean } = {}) {
  let t = T0;
  const cards: { body: string; buttons: { id: string; title: string }[] }[] = [];
  const loops = o.loops ?? [];
  const audit: BetaAudit = createBetaAudit({
    kv: null, timeZone: "UTC", now: () => t, rand: seeded(3), quiet: { start: 23 * 60, end: 8 * 60 },
    loops: async () => loops, told: async () => o.told ?? [],
    card: async (body, buttons) => {
      if (o.cardOk === false) return false;
      cards.push({ body, buttons });
      return true;
    },
  });
  return { audit, cards, at: (x: number) => void (t = x), now: () => t };
}

/** Ten Slack conversations read with nothing found, two with a follow-up, one email with nothing: what a week gives the audit. */
async function aWeek(audit: BetaAudit, base = T0): Promise<void> {
  for (let i = 0; i < 13; i++) {
    const id = `j${String(i).padStart(9, "0")}`;
    const at = base + (i + 1) * HOUR;
    const j = job(id, at, i === 12 ? "mail" : "slack");
    audit.followups.queued(j, ["Conversation:", `* [11/02 10:0${i % 10}] Ana Ruiz: ${SECRET_BODIES[i % 2]}`, "[11/02 10:09] Me: ok"], ["Ana Ruiz", "U0123"]);
    audit.followups.answered({ id, source: j.source, label: j.label, at, loops: i === 3 || i === 4 ? 1 : 0 });
  }
  await audit.read();
}

test("audit: nothing is kept until the tester opts in; opting out drops every line kept, the answers stay", async () => {
  const { audit } = rig();
  await aWeek(audit);
  assert.deepEqual((await audit.read()).seen, [], "off: no conversation kept");
  await audit.set(true);
  await aWeek(audit);
  const s = await audit.read();
  assert.equal(s.seen.length, 13);
  assert.match(s.seen[0]!.lines[0]!, /Henderson contract/, "its first lines, without the timestamps");
  assert.ok(!s.seen[0]!.lines[0]!.includes("[11/02"));
  assert.match(s.tester, /^[0-9a-f]{12}$/);
  await audit.set(false);
  const off = await audit.read();
  assert.deepEqual(off.seen, []);
  assert.ok(!JSON.stringify(off).includes("Henderson"));
});

test("audit: a week after opting in, a sampled round; one question at a time, Yes/No/Skip, labels stored as counts", async () => {
  const loops = [
    loop("aaaaaaaaa1"), loop("aaaaaaaaa2"), loop("aaaaaaaaa3", { createdAt: T0 - 30 * DAY }), // a month old: not this week's
    loop("aaaaaaaaa4", { status: "done", closedAt: T0 + 5 * HOUR, autoClosed: { at: T0 + 5 * HOUR, why: "I saw it on your calendar." } }),
    loop("aaaaaaaaa5", { sources: [{ kind: "chat", label: "chat", at: T0 + HOUR }] }), // a "you missed …": told, never caught
  ];
  const { audit, cards, at } = rig({ loops, told: ["aaaaaaaaa5"] });
  await audit.set(true);
  await aWeek(audit);
  at(T0 + 6 * DAY);
  assert.equal(await audit.sweep(), false, "not a week yet");
  at(T0 + 7 * DAY + HOUR);
  assert.equal(await audit.sweep(), true);
  const s = await audit.read();
  const r = s.rounds[0]!;
  // 11 conversations with nothing (10 Slack, 1 mail), 3 follow-ups made this week (the told one left out), 1 closed by Pako.
  const N = Object.fromEntries(r.strata.map((x) => [`${x.kind}/${x.source}`, `${x.N}:${x.drawn}`]));
  assert.deepEqual(N, { "thread/slack": "10:7", "thread/mail": "1:1", "loop/slack": "3:3", "closed/slack": "1:1" });
  assert.equal(r.questions.length, 12);
  assert.ok(!r.questions.some((q) => q.ref === "aaaaaaaaa5" || q.ref === "aaaaaaaaa3"));
  assert.equal(cards.length, 1, "one question at a time");
  assert.equal(await audit.sweep(), false, "the next waits for this one's answer");
  assert.equal(cards.length, 1);
  // Its buttons: Yes/No (and Skip on a thread's), each naming the question.
  const first = r.questions[0]!;
  const ids = cards[0]!.buttons.map((b) => b.id);
  assert.deepEqual(ids.slice(0, 2), [`xy:${first.id}`, `xn:${first.id}`]);
  assert.equal(ids.length, first.kind === "thread" ? 3 : 2);
  for (const id of ids) assert.ok(AUDIT_BUTTON.test(id));
  // Answer them all: Yes on every thread with a mail source, No elsewhere, Skip on one thread.
  let skipped = false;
  for (let i = 0; i < 12; i++) {
    const q = (await audit.read()).rounds[0]!.questions[i]!;
    assert.ok(q.askedAt !== undefined, `question ${i + 1} was asked`);
    const a = q.kind === "thread" && !skipped && q.source === "slack" ? ((skipped = true), "s") : q.source === "mail" || q.kind === "loop" ? "y" : "n";
    const say = await audit.pressed(a as "y" | "n" | "s", q.id);
    assert.match(say, i === 11 ? /That's all for this week/ : /^Noted, thanks\.$/);
    await audit.next();
  }
  assert.equal(cards.length, 12);
  assert.match(await audit.pressed("y", first.id), /expired/, "an answer is given once");
  const done = await audit.read();
  assert.ok(done.rounds[0]!.questions.every((q) => !q.show), "what a question showed goes with its answer");
  const c = auditCounts(done, { now: T0 + 7 * DAY + 2 * HOUR, days: 7 });
  const by = Object.fromEntries(c.strata.map((x) => [`${x.kind}/${x.source}`, `${x.N}:${x.n}:${x.yes}`]));
  assert.deepEqual(by, { "thread/slack": "10:6:0", "thread/mail": "1:1:1", "loop/slack": "3:3:3", "closed/slack": "1:1:0" });
  assert.deepEqual([c.rounds, c.asked, c.answered, c.skipped, c.ignored], [1, 12, 11, 1, 0]);
  assert.ok(!JSON.stringify(c).match(/Ana|Ruiz|Henderson|Priya|pricing/));
});

test("audit: a thread's question shows its source, people and first lines; a follow-up's its title; a closed one why", async () => {
  const loops = [loop("bbbbbbbbb1", { status: "done", closedAt: T0 + 2 * HOUR, autoClosed: { at: T0 + 2 * HOUR, why: "I saw the meeting on your calendar." } })];
  const { audit, cards, at } = rig({ loops });
  await audit.set(true);
  await aWeek(audit);
  at(T0 + 7 * DAY + HOUR);
  await audit.sweep();
  for (let i = 0; i < 12 && cards.length < 12; i++) {
    const q = (await audit.read()).rounds[0]!.questions.find((x) => x.askedAt !== undefined && !x.answer);
    if (!q) break;
    await audit.pressed("n", q.id);
    await audit.next();
  }
  const thread = cards.find((c) => c.body.includes("found no promise"))!;
  assert.match(thread.body, /^📏 Beta check \d+ of \d+\. I read this and found no promise:\n(Slack|Email) · Ana Ruiz \(private\)\nPeople: Ana Ruiz, U0123\n“/);
  assert.match(thread.body, /Was there a promise here, by you or to you\?$/);
  assert.deepEqual(thread.buttons.map((b) => b.title), ["Yes", "No", "Skip"]);
  const closed = cards.find((c) => c.body.includes("closed this follow-up"))!;
  assert.match(closed.body, /“Send Ana Ruiz the pricing deck bbbbbbbbb1”, because I saw the meeting on your calendar\.\n\nWas closing it right\?$/);
  const made = cards.find((c) => c.body.includes("I made this follow-up"))!;
  assert.match(made.body, /Was this a real promise\?$/);
  assert.deepEqual(made.buttons.map((b) => b.title), ["Yes", "No"]);
});

test("audit: never in the quiet hours; a question left 12 hours is ignored, and two ignored in a row end the week's questions", async () => {
  const { audit, cards, at } = rig();
  await audit.set(true);
  // Read from the night of the 2nd on.
  await aWeek(audit, Date.parse("2026-11-03T00:30:00Z"));
  // A week on, at 23:30: quiet. The round is drawn (looking back to 23:30 a week ago), nothing asked.
  at(Date.parse("2026-11-09T23:30:00Z"));
  assert.equal(await audit.sweep(), false);
  assert.equal(cards.length, 0);
  assert.equal((await audit.read()).rounds.length, 1, "the round is drawn once");
  at(Date.parse("2026-11-10T07:59:00Z"));
  assert.equal(await audit.sweep(), false);
  at(Date.parse("2026-11-10T08:00:00Z"));
  assert.equal(await audit.sweep(), true, "the quiet hours are over");
  assert.equal(cards.length, 1);
  // Left unanswered: 11 hours on, still waiting; at 12, ignored, and the next one asked (20:00, not quiet).
  at(Date.parse("2026-11-10T19:00:00Z"));
  assert.equal(await audit.sweep(), false);
  at(Date.parse("2026-11-10T20:00:00Z"));
  assert.equal(await audit.sweep(), true);
  assert.equal(cards.length, 2);
  // The second ignored too (08:00 next day): the round stops; nothing more that week.
  at(Date.parse("2026-11-11T08:00:00Z"));
  assert.equal(await audit.sweep(), false);
  at(Date.parse("2026-11-12T12:00:00Z"));
  assert.equal(await audit.sweep(), false);
  assert.equal(cards.length, 2);
  const r = (await audit.read()).rounds[0]!;
  assert.equal(r.stopped, true);
  assert.deepEqual(r.questions.filter((q) => q.answer === "ignored").length, 2);
  const c = auditCounts(await audit.read(), { now: Date.parse("2026-11-12T12:00:00Z"), days: 7 });
  assert.equal(c.ignored, 2);
  assert.equal(c.answered, 0);
  assert.ok(c.strata.every((x) => x.n === 0), "an ignored question is no answer");
});

test("audit: an answer resets the ignored run, so one ignored then one answered goes on", async () => {
  const { audit, cards, at } = rig();
  await audit.set(true);
  await aWeek(audit);
  at(T0 + 7 * DAY + HOUR);
  await audit.sweep();
  at(T0 + 7 * DAY + 13 * HOUR); // 23:00: the first is ignored, but quiet: the next waits
  assert.equal(await audit.sweep(), false);
  at(T0 + 8 * DAY); // 10:00
  assert.equal(await audit.sweep(), true);
  const q = (await audit.read()).rounds[0]!.questions.find((x) => x.askedAt !== undefined && !x.answer)!;
  await audit.pressed("n", q.id);
  assert.equal((await audit.read()).rounds[0]!.ignoredRun, 0);
  assert.equal(await audit.next(), true);
  assert.equal(cards.length, 3);
});

test("audit: the chat refusing a card asks nothing (the question waits); a follow-up gone since is not asked", async () => {
  const st: { ok: boolean } = { ok: false };
  let t = T0;
  const cards: string[] = [];
  const loops = [loop("ccccccccc1")];
  const audit = createBetaAudit({
    kv: null, timeZone: "UTC", now: () => t, rand: seeded(1), quiet: null, loops: async () => loops, told: async () => [],
    card: async (body) => (st.ok ? (cards.push(body), true) : false),
  });
  await audit.set(true);
  audit.followups.answered({ source: "meeting", label: "Weekly sync", at: T0 + HOUR, loops: 0 });
  t = T0 + 7 * DAY + HOUR;
  assert.equal(await audit.sweep(), false);
  assert.ok((await audit.read()).rounds[0]!.questions.every((q) => q.askedAt === undefined));
  loops.length = 0; // the follow-up was deleted since the round was drawn
  st.ok = true;
  await audit.sweep();
  for (let i = 0; i < 3; i++) {
    const q = (await audit.read()).rounds[0]!.questions.find((x) => x.askedAt !== undefined && !x.answer);
    if (q) await audit.pressed("n", q.id);
    await audit.next();
  }
  const r = (await audit.read()).rounds[0]!;
  assert.equal(r.questions.find((q) => q.kind === "loop")?.answer, "gone");
  assert.equal(cards.length, 1);
  assert.match(cards[0]!, /Meeting · Weekly sync/);
});

test("populations: the window's threads with nothing found, follow-ups made (told ones left out), Pako's closes", () => {
  const s: AuditState = {
    on: true, since: 0, tester: "", rounds: [],
    seen: [
      { id: "a", at: 10, source: "mail", label: "", people: [], lines: [], loops: 0 },
      { id: "b", at: 10, source: "mail", label: "", people: [], lines: [], loops: 2 },
      { id: "c", at: 10, source: "mail", label: "", people: [], lines: [] }, // its job is still out
      { id: "d", at: 99, source: "mail", label: "", people: [], lines: [], loops: 0 }, // after the window
    ],
  };
  const pop = populationsOf(s, [
    loop("x1", { createdAt: 20 }), loop("x2", { createdAt: 20 }),
    loop("x3", { createdAt: 1, status: "done", autoClosed: { at: 30, why: "" } }),
  ], new Set(["x2"]), 5, 50);
  assert.deepEqual(pop, [
    { kind: "thread", source: "mail", ids: ["a"] },
    { kind: "loop", source: "slack", ids: ["x1"] },
    { kind: "closed", source: "slack", ids: ["x3"] },
  ]);
});
