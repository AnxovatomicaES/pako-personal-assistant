// A Claude Code too old for the model Pako asks for: Claude Code 2.1.258 refused claude-opus-5-5 (the writing model) with a 400 that names
// the version it needs. Its words, as it said them on the owner's Mac (`claude -p --model claude-opus-5-5 --output-format json`, exit 0):
//   stderr: [claude-code:unrecognized_model] {"model":"claude-opus-5-5","query_source":"sdk"}
//   stdout: is_error true, subtype "success", terminal_reason "api_error", api_error_status 400, and the result below.
// The kind of that failure, the one run again on another model, the model skipped after it until Claude Code changes version, and the one
// notice for each version. No real `claude` runs here: the bridge's runs are fakes, and runClaude runs test/fixtures/claude-stub.mjs.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyFailure, ClaudeError, createBridge, errorSignals, resetFallbacks, runClaude, setFallbackLog, type BridgeConfig, type ClaudeResult,
  type RunConfig,
} from "../assistant/bridge.ts";
import { cliModelsPath, createCliModels } from "../assistant/bridge/cli-models.ts";
import type { ClaudeJson } from "../assistant/bridge/claude.ts";
import { modelNeedsNewerCli } from "../assistant/bridge/claude-errors.ts";
import { createBudget } from "../assistant/budget.ts";
import { readBridgeReport } from "../src/watchdog.ts";

// The panel's own module (plain JavaScript, as the browser loads it).
const { healthSummary } = (await import(new URL("../src/panel/dashboard-model.js", import.meta.url).href)) as {
  healthSummary: (state: unknown, now: number) => { ok: boolean; problems: { key: string; detail: string }[] };
};
const TOKEN = "t".repeat(48);
const STUB = fileURLToPath(new URL("./fixtures/claude-stub.mjs", import.meta.url));
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const RESULT = "API Error: 400 Claude Code 2.1.258 does not support this model; version 2.1.280 or newer is required. "
  + "Run 'claude update', or update the Claude desktop app, then try again.";
const STDERR = '[claude-code:unrecognized_model] {"model":"claude-opus-5-5","query_source":"sdk"}';
/** The result document of 2.1.258's refusal (the fields Pako reads, as the owner's Mac printed them). */
const DOC: ClaudeJson = { type: "result", subtype: "success", is_error: true, terminal_reason: "api_error", api_error_status: 400, result: RESULT } as ClaudeJson;
/** The message runClaude builds from a failed run: the result's words, then the error output. */
const MESSAGE = `${RESULT} ${STDERR}`;
const quiet = (): string[] => {
  const seen: string[] = [];
  resetFallbacks();
  setFallbackLog((l) => seen.push(l));
  return seen;
};

// ---------- the kind ----------

test("2.1.258's refusal, JSON output: its own kind with the version needed and the one that refused; not a limit, a sign-in or missing", () => {
  const log = quiet();
  const e = classifyFailure({ message: MESSAGE, doc: DOC });
  assert.equal(e.kind, "model-needs-newer-cli");
  assert.equal(e.needsCli, "2.1.280");
  assert.equal(e.cliVersion, "2.1.258");
  assert.equal(e.status, 400);
  assert.equal(e.via, "text", "no structured field says it: the words decide, and that is counted");
  assert.equal(log.length, 1);
  assert.deepEqual(modelNeedsNewerCli(RESULT), { needsCli: "2.1.280", cliVersion: "2.1.258" });
  assert.equal(modelNeedsNewerCli(STDERR), null, "the stderr tag alone does not decide: 2.1.327 prints it for a model that does not exist");
});

test("2.1.258's refusal, stream-json: the result event carries the same words; the stream's other events do not change the kind", () => {
  quiet();
  const lines = [
    { type: "system", subtype: "init", session_id: "s", model: OPUS, mcp_servers: [] },
    { type: "assistant", error: "unknown", message: { content: [{ type: "text", text: RESULT }] } },
    { ...DOC, session_id: "s" },
  ].map((x) => JSON.stringify(x));
  const s = errorSignals();
  for (const l of lines) s.line(l);
  const doc = JSON.parse(lines[2]!) as ClaudeJson;
  const e = classifyFailure({ message: `${String(doc.result)} ${STDERR}`, doc, signals: s.done() });
  assert.equal(e.kind, "model-needs-newer-cli");
  assert.equal(e.needsCli, "2.1.280");
  // Cut short (runClaude keeps 300 characters) or without the version: still the kind, with what the words still name.
  assert.equal(classifyFailure({ message: "API Error: 400 Claude Code 2.1.258 does not support this model", doc }).kind, "model-needs-newer-cli");
  assert.equal(classifyFailure({ message: "API Error: 400 Claude Code 2.1.258 does not support this model", doc }).needsCli, undefined);
});

test("a different 400, and the other failures, are not taken for it", () => {
  quiet();
  const bad = (result: string, more: Partial<ClaudeJson> = {}) =>
    classifyFailure({ message: result, doc: { ...DOC, result, ...more } as ClaudeJson }).kind;
  assert.equal(bad("API Error: 400 messages: text content blocks must be non-empty"), "other");
  assert.equal(bad('API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}'), "other");
  assert.equal(bad(`There's an issue with the selected model (${OPUS}). ${STDERR}`, { api_error_status: 404, api_error_type: "not_found_error" }), "other");
  assert.equal(bad("You've hit your 5-hour limit · resets 9pm", { api_error_status: 429 }), "limit");
  assert.equal(bad("Not logged in · Please run /login", { api_error_status: 401 }), "login");
  // The same words under a status that says something else: the status decides.
  assert.equal(bad(RESULT, { api_error_status: 401 }), "login");
});

test("runClaude on a Claude Code too old for the model (the stub as 2.1.258): JSON and stream-json both reject with the kind; another model answers", async () => {
  quiet();
  const prev = process.env.CLAUDE_STUB_MODE;
  process.env.CLAUDE_STUB_MODE = "old-cli";
  try {
    const c: RunConfig = { claudeBin: STUB, tools: [], model: OPUS, runTimeoutMs: 20_000 };
    for (const files of [undefined, [{ type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: "iVBORw0KGgo=" } }]]) {
      const err = await runClaude("hi", { ...c, ...(files ? { files } : {}) }).then(() => null, (e: unknown) => e);
      assert.ok(err instanceof ClaudeError, files ? "stream-json" : "json");
      assert.equal(err.kind, "model-needs-newer-cli");
      assert.equal(err.needsCli, "2.1.280");
      assert.match(err.message, /does not support this model/);
    }
    assert.equal((await runClaude("hi", { ...c, model: SONNET })).text, "ok");
    assert.equal((await runClaude("hi", { ...c, model: "" })).text, "ok", "no --model: Claude Code's default");
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_STUB_MODE;
    else process.env.CLAUDE_STUB_MODE = prev;
  }
});

// ---------- the bridge ----------

interface Rig {
  bridge: ReturnType<typeof createBridge>;
  runs: { prompt: string; c: RunConfig }[];
  posts: { path: string; body: Record<string, unknown> }[];
  inbox: Record<string, unknown>[];
  logs: string[];
  /** The models this fake Claude Code refuses as too new for it. */
  tooNew: Set<string>;
  /** Every run fails with this, when set. */
  fail?: ClaudeError;
  stateDir: string;
}

function rig(o: { config?: Partial<BridgeConfig>; stateDir?: string; tooNew?: string[] } = {}): Rig {
  const stateDir = o.stateDir ?? mkdtempSync(join(tmpdir(), "cli-model-"));
  const r: Rig = { runs: [], posts: [], inbox: [], logs: [], tooNew: new Set(o.tooNew ?? [OPUS]), stateDir } as unknown as Rig;
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (path === "/assistant/inbox") return json({ messages: r.inbox });
    if (path === "/assistant/context") return json({ now: "Wednesday", ownerName: "Ana", contacts: [], memory: "" });
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path === "/assistant/ack") r.inbox = r.inbox.filter((m) => !body.ids.includes(m.id));
    r.posts.push({ path, body });
    return json({ ok: true });
  }) as typeof fetch;
  const config: BridgeConfig = {
    server: "http://127.0.0.1:9", token: TOKEN, claudeBin: "claude", model: SONNET, writingModel: OPUS, stateDir, tools: ["WebSearch"],
    runTimeoutMs: 20_000, rotateAfter: 30, noticeMs: 60_000, whisperModel: "", whisperBin: "", ffmpegBin: "", whisperLang: "auto", ...o.config,
  };
  const budget = createBudget({ config: { perDay: 40, coalesceMs: 0, unchangedMs: 0 } });
  r.bridge = createBridge({
    config, fetch: fakeFetch, log: (l) => r.logs.push(l), replyWaitsMs: [0, 0, 0, 0, 0], budget,
    run: async (prompt, c): Promise<ClaudeResult> => {
      r.runs.push({ prompt, c });
      if (r.fail) throw r.fail;
      if (c.model && r.tooNew.has(c.model)) throw classifyFailure({ message: `${RESULT} ${STDERR}`.replace(OPUS, c.model), doc: DOC });
      return { text: prompt.includes("BRIEF-") ? '{"opening":"Hi"}' : "ok", sessionId: "s1", costUsd: 0.01 };
    },
  });
  return r;
}
const posted = (r: Rig, path: string) => r.posts.filter((p) => p.path === path).map((p) => p.body);
const notices = (r: Rig) => posted(r, "/assistant/reply").filter((b) => b.notice === true && /Claude Code/.test(String(b.text)));
const brief = (id: string, draft = false) => ({ id, at: 1, text: "", brief: { kind: draft ? "do" : "brief", label: "brief", text: `FACTS ${id}`, ...(draft ? { draft } : {}) } });
const ticks = async (r: Rig, n = 3) => {
  for (let i = 0; i < n; i++) await r.bridge.tick(0);
};
const cli = (version: string) => ({ version, status: "older" as const, note: `Claude Code ${version} is older than the versions Pako was tested with` });

test("bridge: the writing model refused as too new: the brief runs once more on the general model at once, and is written", async () => {
  quiet();
  const r = rig();
  r.bridge.setCli(cli("2.1.258"));
  r.inbox.push(brief("brief:aaaaaaaaaa"));
  await ticks(r);
  assert.deepEqual(r.runs.map((x) => x.c.model), [OPUS, SONNET], "one try on Opus, then one on Sonnet");
  assert.deepEqual(posted(r, "/assistant/brief"), [{ id: "brief:aaaaaaaaaa", text: '{"opening":"Hi"}' }], "the brief comes out");
  assert.equal(r.bridge.usage().pausedUntil, 0, "not Claude's limit: nothing paused");
  assert.equal(r.bridge.usage().modelsOff.length, 0, "not the account's refusal either");
  assert.equal(r.logs.filter((l) => /too old for claude-opus-5-5 \(needs 2\.1\.280\)/.test(l)).length, 1);
  const n = notices(r);
  assert.equal(n.length, 1, "the owner is told once");
  assert.match(String(n[0]!.text), /I'm writing with claude-sonnet-5-5 for now: your Claude Code \(2\.1\.258\) is older than claude-opus-5-5 needs \(version 2\.1\.280 or newer\)/);
  assert.match(String(n[0]!.text), /run claude update in a terminal, or update the Claude desktop app/);
});

test("bridge: after the refusal, a draft goes straight to the general model; the owner is not told again, not after a restart either", async () => {
  quiet();
  const r = rig();
  r.bridge.setCli(cli("2.1.258"));
  r.inbox.push(brief("brief:aaaaaaaaaa"));
  await ticks(r);
  r.inbox.push(brief("brief:draft1", true));
  await ticks(r);
  assert.deepEqual(r.runs.map((x) => x.c.model), [OPUS, SONNET, SONNET], "the draft skips Opus");
  assert.equal(posted(r, "/assistant/brief").length, 2);
  assert.equal(notices(r).length, 1);
  const kept = JSON.parse(readFileSync(cliModelsPath(r.stateDir), "utf8"));
  assert.deepEqual(kept, { version: "2.1.258", models: { [OPUS]: "2.1.280" }, told: true }, "kept in the state folder");
  // A restart on the same Claude Code: still skipped, still not told again.
  const again = rig({ stateDir: r.stateDir });
  again.bridge.setCli(cli("2.1.258"));
  again.inbox.push(brief("brief:bbbbbbbbbb"));
  await ticks(again);
  assert.deepEqual(again.runs.map((x) => x.c.model), [SONNET]);
  assert.equal(notices(again).length, 0);
});

test("bridge: a new Claude Code version forgets it: Opus is tried again (and works), and a still-too-old one is told once more", async () => {
  quiet();
  const r = rig();
  r.bridge.setCli(cli("2.1.258"));
  r.inbox.push(brief("brief:aaaaaaaaaa"));
  await ticks(r);
  r.tooNew.clear();
  r.bridge.setCli({ version: "2.1.327", status: "ok" });
  r.inbox.push(brief("brief:bbbbbbbbbb"));
  await ticks(r);
  assert.deepEqual(r.runs.map((x) => x.c.model), [OPUS, SONNET, OPUS], "updated: Opus again");
  assert.ok(r.logs.some((l) => /Claude Code is now 2\.1\.327 \(was 2\.1\.258\): trying claude-opus-5-5 again/.test(l)));
  // Another version, still too old: refused, noted, told again (once).
  r.tooNew.add(OPUS);
  r.bridge.setCli(cli("2.1.270"));
  r.inbox.push(brief("brief:cccccccccc"), brief("brief:dddddddddd"));
  await ticks(r, 4);
  assert.deepEqual(r.runs.slice(3).map((x) => x.c.model), [OPUS, SONNET, SONNET]);
  assert.equal(notices(r).length, 2, "one notice per version");
});

test("bridge: the general model refused too: Claude Code's default (no --model) answers; chat falls back the same way", async () => {
  quiet();
  const r = rig({ tooNew: [OPUS, SONNET] });
  r.bridge.setCli(cli("2.1.258"));
  r.inbox.push(brief("brief:aaaaaaaaaa"));
  await ticks(r);
  assert.deepEqual(r.runs.map((x) => x.c.model), [OPUS, SONNET, ""], "each model once, then the default");
  assert.equal(posted(r, "/assistant/brief").length, 1);
  assert.equal(notices(r).length, 1, "told once, even with two models refused");
  r.inbox.push({ id: "o1", at: 2, text: "hello" });
  await ticks(r);
  assert.deepEqual(r.runs.slice(3).map((x) => x.c.model), [""], "the owner's message: straight to the default");
  assert.ok(posted(r, "/assistant/reply").some((b) => b.text === "ok"));
});

test("bridge: chat on a refused general model (no writing model): one retry with no --model, then skipped", async () => {
  quiet();
  const r = rig({ tooNew: [SONNET], config: { writingModel: SONNET } });
  r.inbox.push({ id: "o1", at: 1, text: "hello" });
  await ticks(r);
  r.inbox.push({ id: "o2", at: 2, text: "again" });
  await ticks(r);
  assert.deepEqual(r.runs.map((x) => x.c.model), [SONNET, "", ""]);
  const n = notices(r);
  assert.equal(n.length, 1);
  assert.match(String(n[0]!.text), /I'm writing with Claude Code's default model for now: your Claude Code \(2\.1\.258\)/, "the version from the refusal itself");
});

test("bridge: any other failure of the writing model (a different 400) is not retried on another model, and says nothing of Claude Code", async () => {
  quiet();
  const r = rig({ tooNew: [] });
  r.fail = classifyFailure({ message: "API Error: 400 messages: text content blocks must be non-empty", doc: { ...DOC, result: "x" } as ClaudeJson });
  r.inbox.push(brief("brief:aaaaaaaaaa"));
  await ticks(r);
  assert.deepEqual(r.runs.map((x) => x.c.model), [OPUS], "one run, no fallback");
  assert.equal(notices(r).length, 0);
  assert.equal(posted(r, "/assistant/health").filter((b) => (b.cli as { status?: string } | undefined)?.status === "behind").length, 0);
});

// ---------- the Health card ----------

test("Health: a refused model shows as \"behind\" with the fix; the server takes it, the card counts it as a problem; a failed self-test keeps its status", async () => {
  quiet();
  const r = rig();
  r.bridge.setCli(cli("2.1.258"));
  await ticks(r, 1);
  const before = posted(r, "/assistant/health").filter((b) => b.cli).at(-1)?.cli as { status: string } | undefined;
  assert.equal(before?.status, "older", "before any refusal: the self-test's own status");
  r.inbox.push(brief("brief:aaaaaaaaaa"));
  await ticks(r);
  const shown = posted(r, "/assistant/health").filter((b) => b.cli).at(-1)!.cli as { version: string; status: string; note: string };
  assert.equal(shown.status, "behind");
  assert.equal(shown.version, "2.1.258");
  assert.equal(shown.note, "Claude Code 2.1.258 is older than claude-opus-5-5 needs (2.1.280 or newer): Pako writes with another model meanwhile. "
    + "To fix: run claude update, or update the Claude desktop app");
  const taken = readBridgeReport({ cli: shown });
  assert.equal(taken?.cli?.status, "behind");
  assert.equal(taken?.cli?.note, shown.note, "every character of it passes the server's filter");
  const sum = healthSummary({ parts: [], cli: taken?.cli }, Date.now());
  assert.equal(sum.ok, false);
  assert.equal(sum.problems[0]?.detail, shown.note);
  r.bridge.setCli({ version: "2.1.258", status: "failed", note: "Claude Code 2.1.258 failed Pako's self-test: x." });
  await ticks(r, 1);
  const failed = posted(r, "/assistant/health").filter((b) => b.cli).at(-1)!.cli as { status: string; note: string };
  assert.equal(failed.status, "failed");
  assert.match(failed.note, /^Claude Code 2\.1\.258 failed Pako's self-test: x\. Claude Code 2\.1\.258 is older than claude-opus-5-5 needs/);
});

test("the kept file: a broken one is an empty start; a model noted with no version named keeps \"\"", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-model-file-"));
  const m = createCliModels({ file: cliModelsPath(dir) });
  assert.equal(m.gap(), null);
  assert.equal(m.refuse(OPUS, undefined, "2.1.258"), true);
  assert.equal(m.refuse(OPUS, "2.1.280", "2.1.258"), false, "noted once");
  assert.equal(m.refused(OPUS), true);
  assert.equal(m.refused(""), false, "the default is never refused");
  m.setVersion("");
  assert.equal(m.refused(OPUS), true, "an unknown version changes nothing");
  const again = createCliModels({ file: cliModelsPath(dir) });
  assert.deepEqual(again.gap(), { version: "2.1.258", models: { [OPUS]: "" }, told: false });
  again.setVersion("2.1.280");
  assert.equal(again.refused(OPUS), false);
  writeFileSync(cliModelsPath(dir), "{not json");
  assert.equal(createCliModels({ file: cliModelsPath(dir) }).gap(), null, "a broken file: an empty start");
});
