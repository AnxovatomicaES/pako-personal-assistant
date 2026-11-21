// Slack with the user token alone (src/slack-poll.ts): Pako finds the owner's new DMs and mentions itself.
// - Only what came after connecting is taken.
// - The owner's own messages in DMs go too (src/slack.ts reads them for the owner's promises, never tells them back); in mentions they do not.
// - Each message is taken once, across rounds and across a restart (the place is kept in the store).
// - With many DMs, a round reads a bounded number of conversations.
// A fake Slack API in memory; nothing goes to Slack.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createSlackPoll, slackTs, threadOf } from "../src/slack-poll.ts";
import express from "express";
import { mock } from "node:test";
import { loadSlackConfig, mountSlack, type SlackEvent } from "../src/slack.ts";
import { memoryKv } from "./helpers/connect-rig.ts";

const TOKEN = "xoxp-1234567890-1234567890-abcdefghijklmnop";

function fakeSlack(dms: number) {
  const history = new Map<string, { ts: string; user: string; text: string }[]>();
  const channels = Array.from({ length: dms }, (_, i) => ({ id: `D${String(i).padStart(4, "0")}`, is_im: true }));
  const mentions: { ts: string; user: string; text: string; channel: { id: string; is_im?: boolean; is_mpim?: boolean }; permalink: string }[] = [];
  const calls: { method: string; params: Record<string, string> }[] = [];
  const api = async (method: string, params: Record<string, string>): Promise<Record<string, unknown>> => {
    calls.push({ method, params });
    if (method === "conversations.list") return { ok: true, channels, response_metadata: { next_cursor: "" } };
    if (method === "conversations.history") {
      const all = history.get(params.channel!) ?? [];
      return { ok: true, messages: all.filter((m) => Number(m.ts) > Number(params.oldest)).reverse() };
    }
    if (method === "search.messages") return { ok: true, messages: { matches: [...mentions].reverse() } };
    throw new Error(`unexpected ${method}`);
  };
  return { history, channels, mentions, calls, api };
}

test("loadSlackConfig: the user token alone is enough (Pako looks itself); a bad signing secret is still named", () => {
  const c = loadSlackConfig({ SLACK_USER_TOKEN: TOKEN });
  assert.deepEqual(c.problems, []);
  assert.equal(c.config?.signingSecret, "");
  assert.equal(c.config?.appToken, undefined);
  assert.deepEqual(loadSlackConfig({ SLACK_USER_TOKEN: TOKEN, SLACK_SIGNING_SECRET: "nope" }).problems.length, 1);
  assert.equal(threadOf("https://acme.slack.com/archives/C1/p1700000001000200?thread_ts=1700000000.000100&cid=C1"), "1700000000.000100");
  assert.equal(threadOf("https://acme.slack.com/archives/C1/p1700000001000200"), undefined);
});

test("new DMs and mentions after connecting are delivered once, oldest first; older ones are not, nor the owner's own mentions", async () => {
  let clock = 1_800_000_000_000;
  const s = fakeSlack(3);
  // Before connecting: never delivered.
  s.history.set("D0000", [{ ts: slackTs(clock - 60_000), user: "U2", text: "old news" }]);
  const got: SlackEvent[] = [];
  const kv = memoryKv();
  const make = () => createSlackPoll({ api: s.api, self: async () => "U1", deliver: async (e) => void got.push(e), kv, now: () => clock });
  const poll = make();
  assert.deepEqual(await poll.round(), { dms: 0, mentions: 0 });

  clock += 60_000;
  s.history.set("D0000", [
    { ts: slackTs(clock - 60_000), user: "U2", text: "old news" },
    { ts: slackTs(clock - 2000), user: "U2", text: "Can you send the deck by Friday?" },
    { ts: slackTs(clock - 1000), user: "U1", text: "Sure, I'll send it Friday" },
  ]);
  s.mentions.push({
    ts: slackTs(clock - 500), user: "U3", text: "<@U1> will you review this?", channel: { id: "C42" },
    permalink: "https://acme.slack.com/archives/C42/p1?thread_ts=1799999999.000100&cid=C42",
  });
  // A DM found by the search is read from the DM itself, not twice.
  s.mentions.push({ ts: slackTs(clock - 400), user: "U2", text: "<@U1> ping", channel: { id: "D0000", is_im: true }, permalink: "" });
  assert.deepEqual(await poll.round(), { dms: 1, mentions: 0 }, "mentions are looked at every other round");
  assert.deepEqual(await poll.round(), { dms: 0, mentions: 1 });
  assert.deepEqual(got.map((e) => [e.channel, e.channel_type, e.user, e.text, e.thread_ts]), [
    ["D0000", "im", "U2", "Can you send the deck by Friday?", undefined],
    ["D0000", "im", "U1", "Sure, I'll send it Friday", undefined],
    ["C42", "channel", "U3", "<@U1> will you review this?", "1799999999.000100"],
  ]);

  // A restart reads the place from the store: nothing again.
  const again = make();
  assert.deepEqual(await again.round(), { dms: 0, mentions: 0 });
  assert.equal(got.length, 3);
});

test("hundreds of DMs: a round reads at most 15, busy ones every round, the rest in turn", async () => {
  let clock = 1_800_000_000_000;
  const s = fakeSlack(100);
  const poll = createSlackPoll({ api: s.api, self: async () => "U1", deliver: async () => {}, kv: null, now: () => clock });
  await poll.round();
  clock += 60_000;
  s.history.set("D0050", [{ ts: slackTs(clock - 1000), user: "U2", text: "hi" }]);
  const read = new Set<string>();
  let rounds = 0;
  while (!read.has("D0050") && rounds < 20) {
    s.calls.length = 0;
    await poll.round();
    rounds++;
    const h = s.calls.filter((c) => c.method === "conversations.history");
    assert.ok(h.length <= 15, `round ${rounds} read ${h.length}`);
    for (const c of h) read.add(c.params.channel!);
  }
  assert.ok(read.has("D0050"), "a quiet DM is reached within a few rounds");
  s.calls.length = 0;
  await poll.round();
  assert.ok(s.calls.some((c) => c.method === "conversations.history" && c.params.channel === "D0050"), "a DM with news is read every round");
});

test("the project's app before the Slack Marketplace (one history call a minute): one DM a look, every one in turn", async () => {
  const s = fakeSlack(3);
  const poll = createSlackPoll({ api: s.api, self: async () => "U1", deliver: async () => {}, kv: null, now: () => 1_800_000_000_000, perRound: 1 });
  const read: string[] = [];
  for (let i = 0; i < 4; i++) {
    s.calls.length = 0;
    await poll.round();
    const h = s.calls.filter((c) => c.method === "conversations.history");
    assert.equal(h.length, 1);
    read.push(h[0]!.params.channel!);
  }
  assert.deepEqual(read, ["D0000", "D0001", "D0002", "D0000"]);
});

// ---------- chat and meeting bugs: regression tests ----------

test("slack poll: the owner's own promise in a DM reaches the follow-ups (observed as theirs) and is never told back", async () => {
  let clock = 1_800_000_000_000;
  const msgs: { ts: string; user: string; text: string }[] = [];
  const fake = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const method = url.pathname.split("/").pop()!;
    const json = (b: unknown) => new Response(JSON.stringify(b));
    if (method === "auth.test") return json({ ok: true, user_id: "UME", user: "me", team: "Acme" });
    if (method === "users.info") return json({ ok: true, user: { profile: { display_name: "Ana" } } });
    if (method === "conversations.info") return json({ ok: true, channel: { user: "UANA" } });
    if (method === "conversations.list") return json({ ok: true, channels: [{ id: "D0001", is_im: true }], response_metadata: { next_cursor: "" } });
    if (method === "conversations.history") return json({ ok: true, messages: msgs.filter((m) => Number(m.ts) > Number(url.searchParams.get("oldest"))).reverse() });
    if (method === "search.messages") return json({ ok: true, messages: { matches: [] } });
    return json({ ok: false, error: "unknown_method" });
  }) as typeof fetch;
  const told: string[] = [];
  const seen: { text: string; mine?: boolean }[] = [];
  const reader = mountSlack(express(), {
    config: { token: TOKEN, signingSecret: "", quiet: null, forward: true }, kv: null, timeZone: "Europe/Madrid", fetch: fake, now: () => clock,
    notify: async (t) => void told.push(t), observe: (m) => void seen.push(m), batchMs: 5,
  });
  assert.ok(reader.poll, "the user token alone: Pako looks itself");
  await reader.poll.round();
  clock += 60_000;
  msgs.push({ ts: slackTs(clock - 1000), user: "UME", text: "I'll send you the contract by Friday" });
  await reader.poll.round();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(seen.map((m) => [m.text, m.mine]), [["I'll send you the contract by Friday", true]], "the owner's promise is read");
  assert.deepEqual(told, [], "and never told back to them");
});

test("slack poll: a DM with more new messages than one page loses none of them", async () => {
  let clock = 1_800_000_000_000;
  const all: { ts: string; user: string; text: string }[] = [];
  const api = async (method: string, params: Record<string, string>): Promise<Record<string, unknown>> => {
    if (method === "conversations.list") return { ok: true, channels: [{ id: "D0000", is_im: true }], response_metadata: { next_cursor: "" } };
    if (method === "search.messages") return { ok: true, messages: { matches: [] } };
    // Slack's own paging: newest first, `limit` a page, a cursor to the older ones.
    const newer = all.filter((m) => Number(m.ts) > Number(params.oldest)).reverse();
    const from = params.cursor ? Number(params.cursor) : 0;
    const limit = Math.min(Number(params.limit), 100);
    const page = newer.slice(from, from + limit);
    const more = from + limit < newer.length;
    return { ok: true, messages: page, has_more: more, response_metadata: { next_cursor: more ? String(from + limit) : "" } };
  };
  const got: SlackEvent[] = [];
  const poll = createSlackPoll({ api, self: async () => "U1", deliver: async (e) => void got.push(e), kv: null, now: () => clock });
  await poll.round();
  clock += 3600_000;
  for (let i = 0; i < 230; i++) all.push({ ts: slackTs(clock - 300_000 + i * 1000), user: "U2", text: `message ${i}` });
  assert.equal((await poll.round()).dms, 230);
  assert.equal(got[0]!.text, "message 0", "the oldest new one is there, first");
  assert.equal(got.at(-1)!.text, "message 229");
  assert.equal((await poll.round()).dms, 0, "and none twice");
});

test("slack poll: stop() before the first look means no look at all", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    let calls = 0;
    const poll = createSlackPoll({ api: async () => (calls++, { ok: true }), self: async () => "U1", deliver: async () => {}, kv: null });
    poll.start();
    poll.stop();
    mock.timers.tick(120_000);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.equal(calls, 0, "Slack is not asked after stop");
  } finally {
    mock.timers.reset();
  }
});

test("slack poll: more busy DMs than one round reads are all read in turn, none left for days", async () => {
  let clock = 1_800_000_000_000;
  const s = fakeSlack(20);
  const poll = createSlackPoll({ api: s.api, self: async () => "U1", deliver: async () => {}, kv: null, now: () => clock });
  await poll.round();
  // Every DM had news a minute ago: all of them are busy now.
  clock += 60_000;
  for (const c of s.channels) s.history.set(c.id, [{ ts: slackTs(clock - 1000), user: "U2", text: `hi from ${c.id}` }]);
  for (let i = 0; i < 2; i++) await poll.round();
  // News again in every DM: all twenty are busy, more than one round reads.
  clock += 60_000;
  for (const c of s.channels) s.history.set(c.id, [{ ts: slackTs(clock - 1000), user: "U2", text: `again from ${c.id}` }]);
  const read = new Set<string>();
  for (let i = 0; i < 3; i++) {
    s.calls.length = 0;
    await poll.round();
    for (const c of s.calls.filter((x) => x.method === "conversations.history")) read.add(c.params.channel!);
  }
  assert.equal(read.size, 20, `every busy DM is read within a few rounds (missed: ${s.channels.map((c) => c.id).filter((id) => !read.has(id)).join(", ")})`);
});

test("slack poll: one DM Slack refuses does not stop the others, nor the mentions", async () => {
  let clock = 1_800_000_000_000;
  const s = fakeSlack(3);
  const api = async (method: string, params: Record<string, string>): Promise<Record<string, unknown>> => {
    if (method === "conversations.history" && params.channel === "D0000") throw new Error("Slack conversations.history: channel_not_found");
    return s.api(method, params);
  };
  const got: SlackEvent[] = [];
  const poll = createSlackPoll({ api, self: async () => "U1", deliver: async (e) => void got.push(e), kv: null, now: () => clock });
  await poll.round();
  clock += 60_000;
  s.history.set("D0001", [{ ts: slackTs(clock - 1000), user: "U2", text: "Can you call me?" }]);
  s.mentions.push({ ts: slackTs(clock - 500), user: "U3", text: "<@U1> the budget?", channel: { id: "C42" }, permalink: "" });
  await poll.round().catch(() => undefined);
  await poll.round().catch(() => undefined);
  assert.deepEqual(got.map((e) => e.text).sort(), ["<@U1> the budget?", "Can you call me?"]);
});

test("slack poll (one history call a minute): a DM Slack rate-limited is read next round, not skipped for a whole turn", async () => {
  const s = fakeSlack(3);
  let limited = true;
  const api = async (method: string, params: Record<string, string>): Promise<Record<string, unknown>> => {
    if (method === "conversations.history" && params.channel === "D0001" && limited) {
      limited = false;
      throw new Error("Slack conversations.history: ratelimited");
    }
    return s.api(method, params);
  };
  const poll = createSlackPoll({ api, self: async () => "U1", deliver: async () => {}, kv: null, now: () => 1_800_000_000_000, perRound: 1 });
  const read: string[] = [];
  for (let i = 0; i < 4; i++) {
    s.calls.length = 0;
    await poll.round().catch(() => undefined);
    read.push(...s.calls.filter((c) => c.method === "conversations.history").map((c) => c.params.channel!));
  }
  // The refused call is not counted (it never reached the fake): D0001 is read in the round right after it, before D0002.
  assert.deepEqual(read, ["D0000", "D0001", "D0002"], "D0001 is asked again right after Slack's refusal");
});

test("slack poll: a place the store did not give back at start is not replaced by \"from now\": what came while Pako was off is read", async () => {
  let clock = 1_800_000_000_000;
  const s = fakeSlack(1);
  const got: SlackEvent[] = [];
  const kv = memoryKv();
  const make = () => createSlackPoll({ api: s.api, self: async () => "U1", deliver: async (e) => void got.push(e), kv, now: () => clock });
  await make().round();
  // Pako is off for an hour; a DM comes meanwhile.
  clock += 3600_000;
  s.history.set("D0000", [{ ts: slackTs(clock - 1800_000), user: "U2", text: "Can you call me back?" }]);
  // At the next start the store does not answer once.
  const get = kv.get;
  let down = true;
  kv.get = async (k) => {
    if (down) throw new Error("the store did not answer");
    return get(k);
  };
  const poll = make();
  await poll.round().catch(() => undefined);
  down = false;
  await poll.round();
  assert.deepEqual(got.map((e) => e.text), ["Can you call me back?"], "the DM sent while Pako was off is not skipped");
});
