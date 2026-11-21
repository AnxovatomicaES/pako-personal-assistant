// One gate for Slack's conversation reads with one token (src/slack-gate.ts): the minute's poll and the follow-ups' own reads share the one
// call a minute the project's own app gets, a follow-up's read goes first, Slack's Retry-After is kept, and "ratelimited" is Slack being busy,
// never Slack failing.
import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createSlackGate } from "../src/slack-gate.ts";
import { mountSlack } from "../src/slack.ts";

const TOKEN = "xoxp-1234567890-1234567890-abcdefghijklmnop";
const T0 = Date.parse("2026-11-14T11:00:00Z");

function rig(o: { perMinute?: number } = {}) {
  const clock = { now: T0 };
  /** When each conversation read reached Slack, and which conversation. */
  const reads: { at: number; channel: string }[] = [];
  const reports: { ok: boolean; detail?: string }[] = [];
  let refuse: number | null = null;
  /** The follow-ups' wait: held until the test lets it go, the clock moved by it. */
  const waits: { ms: number; go: () => void }[] = [];
  const fake = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const method = url.pathname.split("/").pop()!;
    const json = (b: unknown, init?: ResponseInit) => new Response(JSON.stringify(b), init);
    if (method === "auth.test") return json({ ok: true, user_id: "UME" });
    if (method === "users.info") return json({ ok: true, user: { profile: { display_name: "Ana" } } });
    if (method === "conversations.list") return json({ ok: true, channels: [{ id: "D0ANA", is_im: true }, { id: "D0LUIS", is_im: true }] });
    if (method === "search.messages") return json({ ok: true, messages: { matches: [] } });
    if (method === "conversations.history" || method === "conversations.replies") {
      if (refuse !== null) {
        const s = refuse;
        refuse = null;
        return json({ ok: false, error: "ratelimited" }, { status: 429, headers: { "retry-after": String(s) } });
      }
      reads.push({ at: clock.now, channel: url.searchParams.get("channel") ?? "" });
      return json({ ok: true, messages: [] });
    }
    return json({ ok: false, error: "unknown_method" });
  }) as typeof fetch;
  const reader = mountSlack(express(), {
    config: { token: TOKEN, signingSecret: "", quiet: null, forward: false },
    kv: null, timeZone: "Europe/Madrid", notify: async () => undefined, fetch: fake, now: () => clock.now,
    health: (ok, detail) => void reports.push({ ok, ...(detail ? { detail } : {}) }),
    ...(o.perMinute ? { pollPerRound: 1, historyPerMinute: o.perMinute } : {}),
    historySleep: (ms) => new Promise<void>((r) => waits.push({ ms, go: () => ((clock.now += ms), r()) })),
  });
  return { clock, reads, reports, reader, waits, refuseNext: (s: number) => void (refuse = s) };
}
const tick = () => new Promise((r) => setTimeout(r, 10));

test("gate: the project's own app makes one conversation read a minute, shared by the poll and the follow-ups, a follow-up's first", async () => {
  const r = rig({ perMinute: 1 });
  await r.reader.history("D0ANA", { limit: 15 });
  assert.equal(r.reads.length, 1);
  // The poll a moment later: the minute's call is spent, it reads nothing this round (and that conversation first next round).
  await r.reader.poll!.round();
  assert.equal(r.reads.length, 1, "the poll does not spend a second call in the same minute");
  // A follow-up's read waits for the next free call, and the poll does not take it from it meanwhile.
  const check = r.reader.history("D0LUIS", { limit: 15 });
  await tick();
  assert.equal(r.waits.length, 1);
  assert.ok(r.waits[0]!.ms > 50_000 && r.waits[0]!.ms <= 60_000, `waits out the minute (${r.waits[0]!.ms})`);
  r.clock.now += 61_000;
  await r.reader.poll!.round();
  assert.equal(r.reads.length, 1, "a follow-up waiting goes first");
  r.waits[0]!.go();
  await check;
  assert.equal(r.reads.length, 2);
  assert.equal(r.reads[1]!.channel, "D0LUIS");
  // A minute after it, the poll reads again.
  r.clock.now += 60_000;
  await r.reader.poll!.round();
  assert.equal(r.reads.length, 3);
});

test("gate: Slack's Retry-After is kept by both, and 'ratelimited' is Slack busy, never reported as Slack failing", async () => {
  const r = rig();
  r.refuseNext(60);
  await assert.rejects(r.reader.history("D0ANA", { limit: 15 }), /ratelimited/);
  assert.equal(r.reports.filter((x) => !x.ok).length, 0, "not a failure for the watchdog");
  r.clock.now += 30_000;
  await r.reader.poll!.round();
  assert.equal(r.reads.length, 0, "the poll keeps Slack's wait");
  const check = r.reader.history("D0ANA", { limit: 15 });
  await tick();
  assert.equal(r.waits.length, 1);
  assert.equal(r.waits[0]!.ms, 30_000, "the rest of Slack's minute");
  r.waits[0]!.go();
  await check;
  assert.equal(r.reads.length, 1, "read once Slack's wait is over");
  // Without the Marketplace limit (an app made by the workspace), reads are not spaced.
  await r.reader.history("D0ANA", { limit: 15 });
  await r.reader.poll!.round();
  assert.equal(r.reads.length, 4);
  // A wait longer than a read can take: said as Slack being busy at once, not held for minutes.
  r.refuseNext(600);
  await assert.rejects(r.reader.history("D0ANA", { limit: 15 }), /ratelimited/);
  await assert.rejects(r.reader.history("D0ANA", { limit: 15 }), /busy/);
  assert.equal(r.reports.filter((x) => !x.ok).length, 0);
});

test("gate: Slack's wait is never longer than it asked for, even when the computer's clock is put back meanwhile", () => {
  let t = T0;
  const gate = createSlackGate({ now: () => t, perMinute: 1 });
  assert.equal(gate.poll(), true);
  gate.limited(60_000);
  assert.equal(gate.poll(), false, "within Slack's minute");
  t -= 24 * 3600_000; // the clock is corrected back a day
  t += 61_000;
  assert.equal(gate.poll(), true, "after the minute it asked for, not a day more");
});
