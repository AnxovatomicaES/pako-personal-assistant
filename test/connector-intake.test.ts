import assert from "node:assert/strict";
import test from "node:test";
import { createConnectorIntake, loadConnectorConfig } from "../src/connector-intake.ts";
import type { Inbound } from "../src/door/inbox.ts";
import type { SlackSeen } from "../src/followups/types.ts";
import { buildClaudeArgs } from "../assistant/bridge/claude.ts";
import { checkedItems, connectorAsk, prefixOf, readMcpList } from "../assistant/bridge/connectors.ts";
import { connectorOf } from "../assistant/bridge/items.ts";
import { memoryKv } from "./helpers/connect-rig.ts";

test("connectors: off by default, slack and notion only, a sane pace", () => {
  assert.equal(loadConnectorConfig({}).config, null);
  assert.equal(loadConnectorConfig({ PAKO_CONNECTORS: "off" }).config, null);
  assert.deepEqual(loadConnectorConfig({ PAKO_CONNECTORS: "Slack, notion" }).config, { sources: ["slack", "notion"], everyMinutes: 240 });
  assert.match(loadConnectorConfig({ PAKO_CONNECTORS: "slack,gmail" }).problems[0]!, /gmail/);
  assert.equal(loadConnectorConfig({ PAKO_CONNECTORS: "slack", PAKO_CONNECTORS_EVERY_MIN: "5" }).config, null);
});

function rig(o: { nativeSlack?: boolean } = {}) {
  let t = 1_800_000_000_000;
  const queued: Inbound[] = [];
  const seen: SlackSeen[] = [];
  const offered: { ref: string; label: string }[] = [];
  const intake = createConnectorIntake({
    kv: memoryKv(), config: { sources: ["slack", "notion"], everyMinutes: 60 }, now: () => t, nativeSlack: o.nativeSlack ?? false,
    enqueue: async (m) => (queued.push(m), true),
    observe: async (m) => void seen.push(m),
    offer: async (x) => (offered.push({ ref: x.ref, label: x.label }), true),
  });
  return { intake, queued, seen, offered, later: (min: number) => void (t += min * 60_000), now: () => t };
}

test("connectors: the first look only sets the mark; a job per source when its time comes, one at a time", async () => {
  const r = rig();
  assert.equal(await r.intake.look(), 0);
  r.later(30);
  assert.equal(await r.intake.look(), 0);
  r.later(31);
  assert.equal(await r.intake.look(), 2);
  assert.match(r.queued[0]!.id, /^cx:slack:[0-9a-f]{10}$/);
  assert.deepEqual(r.queued[0]!.connector, { source: "slack", since: r.now() - 61 * 60_000 });
  assert.equal(r.queued[0]!.text, "");
  r.later(120);
  assert.equal(await r.intake.look(), 0, "a job still waiting is not asked twice");
});

test("connectors: Slack is skipped when it is connected natively", async () => {
  const r = rig({ nativeSlack: true });
  await r.intake.look();
  r.later(61);
  await r.intake.look();
  assert.deepEqual(r.queued.map((m) => m.connector?.source), ["notion"]);
});

test("connectors: Slack messages go to the follow-ups once, checked field by field; a wrong id is refused", async () => {
  const r = rig();
  await r.intake.look();
  r.later(61);
  await r.intake.look();
  const id = r.queued[0]!.id;
  const at = r.now() / 1000;
  const good = { channel: "D09ABC123", ts: `${at}.000100`, who: "Ana", where: "Ana (private)", text: "Can you send the deck?" };
  assert.deepEqual(await r.intake.result("cx:slack:0000000000", [good]), { ok: false, kept: 0 });
  const res = await r.intake.result(id, [good, good, { ...good, channel: "x" }, { ...good, ts: "1.0", channel: "C1234" }, { ...good, ts: `${at}.2`, text: " " }]);
  assert.deepEqual(res, { ok: true, kept: 1 });
  assert.equal(r.seen[0]!.direct, true);
  assert.equal(r.seen[0]!.at, Math.round(Number(good.ts) * 1000));
  assert.deepEqual(await r.intake.result(id, [good]), { ok: false, kept: 0 }, "answered once only");
  r.later(61);
  await r.intake.look();
  await r.intake.result(r.queued.at(-1)!.id, [good]);
  assert.equal(r.seen.length, 1, "a message already passed on is not passed on again");
});

test("connectors: Notion pages are offered as notes; an error keeps the mark", async () => {
  const r = rig();
  await r.intake.look();
  r.later(61);
  await r.intake.look();
  const notion = r.queued.find((m) => m.connector?.source === "notion")!;
  const since = notion.connector!.since;
  const page = { id: "415d14b2-e98a-80f9-8d79-ead7319450a2", title: "Weekly", edited: new Date(r.now()).toISOString(), text: "Ana: Pat sends the plan by Friday." };
  assert.deepEqual(await r.intake.result(notion.id, [page, { ...page, id: "not-an-id" }]), { ok: true, kept: 1 });
  assert.deepEqual(r.offered, [{ ref: `notion:${page.id}`, label: "Notion · Weekly" }]);
  r.later(61);
  await r.intake.look();
  const next = r.queued.filter((m) => m.connector?.source === "notion").at(-1)!;
  assert.ok(next.connector!.since > since, "the mark moved to the answered job's time");
  await r.intake.result(next.id, [], "claude.ai Notion is not connected in Claude");
  r.later(61);
  await r.intake.look();
  assert.equal(r.queued.filter((m) => m.connector?.source === "notion").at(-1)!.connector!.since, next.connector!.since);
});

test("connector runs: the read tools of one connector, every other server denied, hooks and CLAUDE.md off", () => {
  const args = buildClaudeArgs({ tools: [], model: "sonnet", systemPrompt: "S", connector: { allow: ["mcp__claude_ai_Slack__slack_read_thread"], deny: ["mcp__claude_ai_Notion"] } });
  const at = (f: string) => args[args.indexOf(f) + 1];
  assert.equal(at("--tools"), "");
  assert.equal(at("--allowedTools"), "mcp__claude_ai_Slack__slack_read_thread");
  assert.equal(at("--disallowedTools"), "mcp__claude_ai_Notion");
  assert.equal(at("--permission-mode"), "dontAsk");
  assert.deepEqual(JSON.parse(at("--settings")!).disableAllHooks, true);
  assert.ok(!args.includes("--strict-mcp-config") && !args.includes("--setting-sources") && !args.includes("--resume"));
});

test("connector runs: servers from `claude mcp list`, their prefixes, and the job as the inbox gives it", () => {
  const list = readMcpList("Checking MCP server health…\n\nclaude.ai Slack: https://x - ✔ Connected\nplugin:small-business:shopify: https://y (HTTP) - ! Needs authentication\n");
  assert.deepEqual(list, [{ name: "claude.ai Slack", connected: true }, { name: "plugin:small-business:shopify", connected: false }]);
  assert.equal(prefixOf("claude.ai Slack"), "mcp__claude_ai_Slack");
  assert.equal(prefixOf("plugin:small-business:shopify"), "mcp__plugin_small-business_shopify");
  assert.deepEqual(connectorOf({ connector: { source: "notion", since: 5 } }), { source: "notion", since: 5 });
  assert.equal(connectorOf({ connector: { source: "gmail", since: 5 } }), undefined);
  assert.match(connectorAsk({ source: "slack", since: Date.UTC(2026, 10, 24) }), /to:me after:2026-11-23/);
});

test("connector runs: only what the tools really returned is kept", () => {
  const tools = '{"messages":[{"channel":"D09ABC123","ts":"1795418541.343679"}]} page 415d14b2e98a80f98d79ead7319450a2';
  const slack = '```json\n{"messages":[{"channel":"D09ABC123","ts":"1795418541.343679","text":"a"},{"channel":"D09ABC123","ts":"1795418999.000001","text":"made up"}]}\n```';
  assert.equal(checkedItems({ source: "slack", since: 0 }, slack, tools).length, 1);
  const notion = '{"pages":[{"id":"415d14b2-e98a-80f9-8d79-ead7319450a2"},{"id":"00000000-0000-0000-0000-000000000000"}]}';
  assert.equal(checkedItems({ source: "notion", since: 0 }, notion, tools).length, 1);
  assert.deepEqual(checkedItems({ source: "slack", since: 0 }, "not json", tools), []);
});
