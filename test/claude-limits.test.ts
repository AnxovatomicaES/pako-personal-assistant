// Claude's limit never stops Pako silently: the owner is told once (what is paused, what keeps working, when it resumes), nothing held is
// dropped, held work is tried again with a growing wait that never passes the reset, and one "back" note comes when Claude answers again.
// A lost sign-in is told differently, with what to do. No real `claude` runs here: the bridge gets a runner that answers or fails as told.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test, type TestContext } from "node:test";
import express from "express";
import { ClaudeError, createBridge, type BridgeConfig, type runClaude } from "../assistant/bridge.ts";
import { classifyFailure, errorSignals, overloaded } from "../assistant/bridge/claude-errors.ts";
import { limitText, limitWait } from "../assistant/bridge/limits.ts";
import { createBudget, type BudgetConfig } from "../assistant/budget.ts";

const TOKEN = "t".repeat(48);
const MIN = 60_000;

type Outcome = "ok" | "limit" | "busy" | "login" | "missing";

/** A stand-in for the server's bridge routes, and a bridge whose runs answer or fail as `h.outcome` says. */
async function rig(stateDir = mkdtempSync(join(tmpdir(), "asst-limits-")), resetsAt = Date.now() + 3 * 3600_000, budget?: BudgetConfig) {
  const h = {
    inbox: [] as Record<string, unknown>[],
    acked: [] as string[],
    replies: [] as Record<string, unknown>[],
    followups: [] as Record<string, unknown>[],
    mail: [] as Record<string, unknown>[],
    meetings: [] as Record<string, unknown>[],
    runs: 0,
    outcome: "ok" as Outcome,
    /** The next replies this many refuse (the server down for a moment). */
    refuse: 0,
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => (req.get("authorization") === `Bearer ${TOKEN}` ? next() : void res.status(401).send("no")));
  app.get("/assistant/inbox", (_req, res) => void res.json({ messages: h.inbox }));
  app.post("/assistant/ack", (req, res) => {
    const ids = req.body.ids as string[];
    h.acked.push(...ids);
    h.inbox = h.inbox.filter((m) => !ids.includes(String(m.id)));
    res.json({ ok: true });
  });
  app.get("/assistant/context", (_req, res) =>
    void res.json({ now: "Friday 20 November 2026 at 12:00", nowLocal: "2026-11-20 12:00", ownerName: "Marta", contacts: [], memory: "", paused: false }));
  app.post("/assistant/reply", (req, res) => {
    if (h.refuse > 0 && h.refuse--) return void res.status(503).json({ error: "down" });
    const { key: _key, ...body } = req.body as Record<string, unknown>;
    h.replies.push(body);
    res.json({ ok: true });
  });
  app.post("/assistant/followups", (req, res) => {
    h.followups.push(req.body);
    res.json({ ok: true });
  });
  app.post("/assistant/mail-summary", (req, res) => {
    h.mail.push(req.body);
    res.json({ ok: true });
  });
  app.post("/assistant/meeting-summary", (req, res) => {
    h.meetings.push(req.body);
    res.json({ ok: true });
  });
  for (const path of ["/assistant/memory", "/assistant/health"]) app.post(path, (_req, res) => void res.json({ ok: true }));
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const config: BridgeConfig = {
    server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: TOKEN, claudeBin: "claude", model: "", stateDir, tools: [],
    runTimeoutMs: 20_000, rotateAfter: 30, noticeMs: 60_000, whisperModel: "", whisperBin: "whisper-cli", ffmpegBin: "ffmpeg", whisperLang: "auto",
    ...(budget ? { budget } : {}),
  };
  const run = (async () => {
    h.runs++;
    if (h.outcome === "limit") throw new ClaudeError("You've hit your 5-hour limit", "limit", { via: "stream", resetsAt });
    if (h.outcome === "busy") throw new ClaudeError("Overloaded", "limit", { status: 529, via: "status" });
    if (h.outcome === "login") throw new ClaudeError("Not logged in · Please run /login", "login", { via: "text" });
    if (h.outcome === "missing") throw new ClaudeError("could not start claude: spawn claude ENOENT", "missing", { via: "spawn" });
    return { text: "Done.", sessionId: "s-1", costUsd: 0 };
  }) as typeof runClaude;
  const bridge = createBridge({ config, run, log: () => undefined, replyWaitsMs: [0, 0, 0, 0, 0] });
  const close = (): void => {
    server.close();
    server.closeAllConnections();
  };
  return { h, bridge, stateDir, close };
}

/** What was said to the owner as a notice about Claude (an email's summary is a notice too, and is left out). */
const notices = (h: { replies: Record<string, unknown>[] }) =>
  h.replies.filter((r) => r.notice === true && !String(r.text).startsWith("📧")).map((r) => String(r.text));
const email = (id: string) => ({ id, at: 2, text: "", email: { from: "ana@example.com", subject: "Dinner", text: "Are you coming?", attachments: [] } });
const followup = (id: string) => ({ id, at: 3, text: "", followup: { source: "slack", label: "#team", text: "Ana: can you send the report?" } });

/** The clock the bridge and its budget read (Date only: the sockets and the bridge's own timers keep the real one). */
const clock = (t: TestContext): { advance: (ms: number) => void } => {
  mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 20, 12, 0) });
  t.after(() => mock.timers.reset());
  return { advance: (ms) => mock.timers.tick(ms) };
};

test("limit: one notice for many held items, nothing acknowledged or dropped, a growing wait, then one 'back' note and the held work runs", async (t) => {
  const c = clock(t);
  const resetsAt = Date.now() + 3 * 3600_000;
  const r = await rig(undefined, resetsAt);
  try {
    r.h.outcome = "limit";
    r.h.inbox.push(email("mail:<a@x>"), followup("fu:1"));
    await r.bridge.tick(0); // the email's run meets the limit: background runs pause until the reset
    await r.bridge.tick(0); // the follow-up is held by the pause, without a run
    assert.equal(r.h.runs, 1, "a held background job starts no run while the limit lasts");
    r.h.inbox.push({ id: "o1", at: 4, text: "what's on today?" });
    await r.bridge.tick(0); // the owner's own message meets it too
    assert.equal(r.h.runs, 2);
    await r.bridge.tick(0);
    assert.equal(r.h.runs, 2, "not tried again at once");
    c.advance(5 * MIN + 1000);
    r.h.inbox.push({ id: "o2", at: 5, text: "and tomorrow?" });
    await r.bridge.tick(0); // tried again after 5 minutes: still the limit, and o2 waits behind it, in order
    assert.equal(r.h.runs, 3);
    c.advance(6 * MIN);
    await r.bridge.tick(0);
    assert.equal(r.h.runs, 3, "the second wait is longer (10 minutes)");

    const said = notices(r.h);
    assert.equal(said.length, 1, "told once, not once per job or per try");
    assert.match(said[0]!, /^Claude has reached its usage limit for now\./);
    assert.match(said[0]!, /paused .*answering your messages, reading new email and meetings/);
    assert.match(said[0]!, /Still working without Claude: .*reminders you already set go out on time/);
    assert.match(said[0]!, /what waits will be done after the limit resets (?:at|tomorrow at|on .* at) \S+/, "the reset time the stream named");
    assert.equal(r.h.replies.length, 1, "no per-message limit reply besides the one notice");
    assert.deepEqual(r.h.acked, [], "nothing acknowledged: every held item stays in the server's inbox");
    assert.equal(r.h.inbox.length, 4);

    // Claude answers again: one "back" note, the owner's messages are answered in order, and the held jobs go at once (the follow-up does not
    // wait out the three hours its pause named).
    r.h.outcome = "ok";
    c.advance(5 * MIN);
    await r.bridge.tick(0);
    assert.deepEqual(notices(r.h).slice(1), ["Claude is answering again: I'm back, and catching up on what waited."]);
    assert.deepEqual(r.h.acked.slice(0, 2), ["o1", "o2"], "the owner's messages first, in order");
    for (let i = 0; i < 4 && r.h.inbox.length; i++) await r.bridge.tick(0);
    assert.deepEqual(r.h.acked, ["o1", "o2", "mail:<a@x>", "fu:1"]);
    assert.equal(r.h.mail.length, 1, "the email was read once Claude was back");
    assert.equal(r.h.followups.length, 1);
    assert.equal(notices(r.h).length, 2, "'back' said once");
  } finally {
    r.close();
  }
});

test("limit: a restart neither says the notice again nor forgets the 'back' note (kept in the state folder)", async (t) => {
  const c = clock(t);
  const stateDir = mkdtempSync(join(tmpdir(), "asst-limits-"));
  const a = await rig(stateDir);
  try {
    a.h.outcome = "limit";
    a.h.inbox.push({ id: "o1", at: 1, text: "hello" });
    await a.bridge.tick(0);
    assert.equal(notices(a.h).length, 1);
  } finally {
    a.close();
  }
  const b = await rig(stateDir);
  try {
    b.h.outcome = "limit";
    b.h.inbox.push({ id: "o1", at: 1, text: "hello" });
    await b.bridge.tick(0);
    assert.equal(notices(b.h).length, 0, "already told before the restart");
    b.h.outcome = "ok";
    c.advance(6 * MIN);
    await b.bridge.tick(0);
    assert.deepEqual(notices(b.h), ["Claude is answering again: I'm back, and catching up on what waited."]);
    assert.deepEqual(b.h.acked, ["o1"]);
  } finally {
    b.close();
  }
});

test("limit: a 'back' note the server did not take is said by the next run that works, once", async (t) => {
  const c = clock(t);
  const r = await rig();
  try {
    r.h.outcome = "limit";
    r.h.inbox.push({ id: "o1", at: 1, text: "hello" });
    await r.bridge.tick(0);
    assert.equal(notices(r.h).length, 1);
    r.h.outcome = "ok";
    c.advance(6 * MIN);
    r.h.refuse = 1; // the "back" note is refused; the answer after it goes
    await r.bridge.tick(0);
    assert.deepEqual(notices(r.h).slice(1), [], "not said yet");
    r.h.inbox.push({ id: "o2", at: 2, text: "and now?" });
    await r.bridge.tick(0);
    assert.deepEqual(notices(r.h).slice(1), ["Claude is answering again: I'm back, and catching up on what waited."], "said by the next run that works");
    r.h.inbox.push({ id: "o3", at: 3, text: "thanks" });
    await r.bridge.tick(0);
    assert.equal(notices(r.h).length, 2, "once");
  } finally {
    r.close();
  }
});

test("overloaded: said at once when the owner's message waits on it, as 'overloaded' with no reset; a background blip is not said", async (t) => {
  const c = clock(t);
  const bg = await rig();
  try {
    bg.h.outcome = "busy";
    bg.h.inbox.push(email("mail:<b@x>"));
    await bg.bridge.tick(0);
    assert.deepEqual(notices(bg.h), [], "an overload only a background job met may pass in a minute");
    assert.deepEqual(bg.h.acked, [], "the email waits all the same");
    bg.h.outcome = "ok";
    c.advance(31 * MIN);
    await bg.bridge.tick(0);
    assert.deepEqual(bg.h.acked, ["mail:<b@x>"]);
    assert.deepEqual(notices(bg.h), [], "and no 'back' for something never said");
  } finally {
    bg.close();
  }
  const own = await rig();
  try {
    own.h.outcome = "busy";
    own.h.inbox.push({ id: "o1", at: 1, text: "hello" });
    await own.bridge.tick(0);
    const said = notices(own.h);
    assert.equal(said.length, 1);
    assert.match(said[0]!, /^Claude is overloaded right now\. .*what waits will be done as soon as Claude answers again/);
  } finally {
    own.close();
  }
});

test("a lost sign-in is not the limit: its own message says what to do, and the message waits", async (t) => {
  const c = clock(t);
  const r = await rig();
  try {
    r.h.outcome = "login";
    r.h.inbox.push({ id: "o1", at: 1, text: "hello" });
    await r.bridge.tick(0);
    assert.equal(r.h.replies.length, 1);
    const text = String(r.h.replies[0]!.text);
    assert.match(text, /Claude needs you to sign in again\. In Pako's settings, press “Connect your Claude account”/);
    assert.doesNotMatch(text, /usage limit|overloaded/);
    assert.deepEqual(r.h.acked, []);
    r.h.outcome = "ok";
    c.advance(3 * MIN);
    await r.bridge.tick(0);
    assert.deepEqual(notices(r.h), [], "no limit 'back' note after a sign-in");
    assert.deepEqual(r.h.acked, ["o1"]);
  } finally {
    r.close();
  }
});

test("a lost sign-in does not spend the day's background runs: after it, the mail that waited is still read by Claude, not kept without it", async (t) => {
  const c = clock(t);
  const r = await rig(undefined, undefined, { perDay: 2, coalesceMs: 0, unchangedMs: 0 });
  try {
    r.h.outcome = "login";
    // Four different emails, each met by the lost sign-in (one is tried per round, and each then waits five minutes): twice the day's cap.
    for (const n of [1, 2, 3, 4]) r.h.inbox.push({ ...email(`mail:<${n}@x>`), at: n });
    for (let i = 0; i < 4; i++) await r.bridge.tick(0);
    assert.equal(r.h.runs, 4, "each was tried: none was kept without Claude for the cap");
    const u = r.bridge.usage();
    assert.deepEqual([u.background, u.skipped.cap, u.kinds.email], [0, 0, undefined], "runs that never reached Claude are not the day's");
    assert.equal(r.h.mail.length, 0, "nothing was kept: the emails wait for Claude");
    // Signed in again: the day's two background runs are still there, and go to the first two emails; the rest are kept, as the cap says.
    r.h.outcome = "ok";
    c.advance(6 * MIN);
    r.h.inbox.push({ ...email("mail:<5@x>"), at: 5 });
    for (let i = 0; i < 5; i++) await r.bridge.tick(0);
    assert.deepEqual(r.h.acked, ["mail:<1@x>", "mail:<2@x>", "mail:<3@x>", "mail:<4@x>", "mail:<5@x>"]);
    assert.deepEqual(r.h.mail.map((m) => m.summary), ["Done.", "Done.", "Are you coming?", "Are you coming?", "Are you coming?"]);
    assert.equal(r.bridge.usage().background, 2);
  } finally {
    r.close();
  }
});

test("a missing claude command does not spend the day's background runs either", async (t) => {
  clock(t);
  const r = await rig(undefined, undefined, { perDay: 1, coalesceMs: 0, unchangedMs: 0 });
  try {
    r.h.outcome = "missing";
    r.h.inbox.push({ ...email("mail:<1@x>"), at: 1 }, { ...email("mail:<2@x>"), at: 2 });
    await r.bridge.tick(0);
    await r.bridge.tick(0);
    assert.equal(r.h.runs, 2, "the second email was tried too: the first did not use the cap");
    assert.equal(r.bridge.usage().background, 0);
  } finally {
    r.close();
  }
});

test("a meeting over the day's budget is not 'failed' and acknowledged: it waits for tomorrow's budget, then is summarized", async (t) => {
  const c = clock(t);
  const r = await rig(undefined, undefined, { perDay: 1, coalesceMs: 0, unchangedMs: 0 });
  try {
    r.h.inbox.push({ ...email("mail:<a@x>"), at: 1 }, { id: "zoom:m1", at: 2, text: "", meeting: { topic: "Launch", when: "14/11, 10:00", transcript: "Ana: we launch on Monday" } });
    await r.bridge.tick(0); // the email takes the day's one background run
    await r.bridge.tick(0); // the meeting finds the day's budget spent
    assert.equal(r.h.runs, 1);
    assert.equal(r.h.meetings.length, 0, "no 'could not summarize' kept by the server");
    assert.ok(!r.h.replies.some((x) => /couldn't summarize/.test(String(x.text))), "nothing said to the owner either");
    assert.deepEqual(r.h.acked, ["mail:<a@x>"], "the meeting stays in the server's inbox");
    for (let i = 0; i < 3; i++) await r.bridge.tick(0);
    assert.equal(r.h.runs, 1);
    assert.equal(r.bridge.usage().skipped.cap, 1, "not asked again and again during the day: it waits for the next one");
    // A day later the budget is new: the same meeting is summarized.
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    c.advance(tomorrow - Date.now() - 1000);
    await r.bridge.tick(0);
    assert.equal(r.h.runs, 1, "not before tomorrow");
    c.advance(2000);
    await r.bridge.tick(0);
    assert.equal(r.h.runs, 2);
    assert.deepEqual(r.h.meetings.map((m) => [m.id, m.summary]), [["zoom:m1", "Done."]]);
    assert.deepEqual(r.h.acked, ["mail:<a@x>", "zoom:m1"]);
  } finally {
    r.close();
  }
});

test("a meeting when the owner allows no background runs at all (the cap is 0) is still answered at once, as 'could not summarize'", async (t) => {
  clock(t);
  const r = await rig(undefined, undefined, { perDay: 0, coalesceMs: 0, unchangedMs: 0 });
  try {
    r.h.inbox.push({ id: "zoom:m2", at: 1, text: "", meeting: { topic: "Launch", when: "14/11, 10:00", transcript: "Ana: hi" } });
    await r.bridge.tick(0);
    assert.equal(r.h.runs, 0);
    assert.deepEqual(r.h.meetings.map((m) => m.summary), ["I couldn't summarize the transcript; it's in Zoom."], "tomorrow would bring no run either");
    assert.deepEqual(r.h.acked, ["zoom:m2"]);
  } finally {
    r.close();
  }
});

test("limitWait: 5, 10, 20, 40 minutes, then every hour, never past the named reset", () => {
  const now = 1_800_000_000_000;
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((n) => limitWait(n, 0, now) / MIN), [5, 10, 20, 40, 60, 60]);
  assert.equal(limitWait(5, now + 12 * MIN, now), 12 * MIN + 15_000, "the reset comes first: tried just after it");
  assert.equal(limitWait(1, now + 2 * 3600_000, now), 5 * MIN, "a reset far off: the backoff (a run that works ends the wait early)");
  assert.equal(limitWait(1, now - MIN, now), 5 * MIN, "a reset already past is not believed");
});

test("limitText: the reset said in the owner's clock (today, tomorrow, another day), or 'as soon as Claude answers again'", () => {
  const now = Date.UTC(2026, 10, 20, 12, 0); // Friday 20 November 2026, 12:00 UTC
  const zone = "UTC";
  assert.match(limitText({ resetsAt: now + 9 * 3600_000, busy: false, now, zone }), /after the limit resets at (?:21:00|9:00 PM)/);
  assert.match(limitText({ resetsAt: now + 15 * 3600_000, busy: false, now, zone }), /after the limit resets tomorrow at (?:03:00|3:00 AM)/);
  assert.match(limitText({ resetsAt: now + 4 * 24 * 3600_000, busy: false, now, zone }), /after the limit resets on Tuesday,? 24 November at |resets on Tuesday, November 24 at /);
  assert.match(limitText({ resetsAt: null, busy: false, now, zone }), /what waits will be done as soon as Claude answers again/);
  assert.match(limitText({ resetsAt: now + 3600_000, busy: true, now, zone }), /^Claude is overloaded right now\. .*as soon as Claude answers again/);
  for (const text of [limitText({ resetsAt: now + 3600_000, busy: false, now, zone }), limitText({ resetsAt: null, busy: true, now, zone })]) {
    assert.match(text, /Nothing is lost/);
    assert.match(text, /I'll tell you when I'm back\.$/);
  }
});

test("stream-json: a rejected rate_limit_event's resetsAt becomes the error's reset; overloaded is told apart from the plan's limit", () => {
  const s = errorSignals();
  s.line(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1795194600, rateLimitType: "five_hour" } }));
  const err = classifyFailure({ message: "limit", doc: { is_error: true }, signals: s.done() });
  assert.equal(err.kind, "limit");
  assert.equal(err.resetsAt, 1795194600 * 1000);
  const allowed = errorSignals();
  allowed.line(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1795194600 } }));
  assert.equal(allowed.done().resetsAt, undefined, "an allowed event says nothing about a reset now");
  assert.equal(overloaded(new ClaudeError("x", "limit", { status: 529 })), true);
  assert.equal(overloaded(new ClaudeError("x", "limit", { apiType: "overloaded_error" })), true);
  assert.equal(overloaded(new ClaudeError("API Error: Overloaded", "limit", { via: "text" })), true);
  assert.equal(overloaded(new ClaudeError("rate limited, overloaded", "limit", { status: 429 })), false, "a 429 is the limit, whatever the words");
  assert.equal(overloaded(new ClaudeError("You've hit your limit", "limit")), false);
  assert.equal(overloaded(new ClaudeError("Overloaded", "login")), false);
});

test("budget: the structured reset wins over the words; told and 'back' are kept across a restart", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "budget-limit-"));
  let t = Date.UTC(2026, 10, 20, 12, 0);
  const make = () => createBudget({ config: { perDay: 40, coalesceMs: 0, unchangedMs: 0 }, stateDir, now: () => t });
  const b = make();
  assert.equal(b.limited("You've hit your limit · resets 9pm", t + 2 * 3600_000), t + 2 * 3600_000);
  assert.equal(b.limitTold(), false);
  b.markLimitTold();
  assert.equal(make().limitTold(), true, "kept in budget.json");
  t += MIN;
  const again = make();
  assert.equal(again.working(), true, "the first run that works after a told limit says 'back'");
  assert.equal(again.working(), true, "until the note is known said");
  again.backTold();
  assert.equal(again.working(), false, "once");
  assert.equal(again.usage().pausedUntil, 0);
  assert.equal(make().limitTold(), false);
});

test("limitText: 'tomorrow' on the night before a clock change too (a day of 23 or 25 hours)", () => {
  const zone = "Europe/Madrid";
  // 23:30 on Saturday 28 March 2026, the night the clocks go forward: the reset at 09:00 on Sunday is tomorrow.
  const spring = Date.UTC(2026, 2, 28, 22, 30);
  assert.match(limitText({ resetsAt: Date.UTC(2026, 2, 29, 7, 0), busy: false, now: spring, zone }), /resets tomorrow at /);
  // 00:30 on Sunday 25 October 2026, a day of 25 hours: the reset at 09:00 on Monday is tomorrow, not "on Monday".
  const autumn = Date.UTC(2026, 9, 24, 22, 30);
  assert.match(limitText({ resetsAt: Date.UTC(2026, 9, 26, 8, 0), busy: false, now: autumn, zone }), /resets tomorrow at /);
});
