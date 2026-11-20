// Surviving a Claude Code update: the bridge tests the program by what it does (assistant/bridge/cli-probe.ts) instead of pinning a version
// range, and reads its results tolerantly (assistant/bridge/cli-shape.ts). The fake outputs below are the captured ones of Claude Code
// 2.1.327 (test/fixtures/claude-cli/2.1.327/), and the same changed the ways a later version could change them: a newer version string, an
// added field, a renamed field, a removed flag, an MCP server that no longer loads, a resume whose words changed.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ClaudeError, compatFrom, createCliWatch, fallbackCounts, fixCommand, loadBridgeConfig, missingEssential, PROBE_MODEL, PROBE_SESSION, probeCli,
  readResult, recordProbe, resetFallbacks, runClaude, setFallbackLog, type BridgeConfig, type ProbeExec, type ProbeRun,
} from "../assistant/bridge.ts";
import { parseClaudeAccount } from "../src/claude-connect.ts";
import { readBridgeReport } from "../src/watchdog.ts";

const dir = new URL("./fixtures/claude-cli/2.1.327/", import.meta.url);
const text = (f: string): string => readFileSync(new URL(f, dir), "utf8");
const events = (f: string): Record<string, unknown>[] => JSON.parse(text(f)) as Record<string, unknown>[];
const model = (await import(new URL("../src/panel/dashboard-model.js", import.meta.url).href)) as Record<string, (...a: any[]) => any>;
const STUB = fileURLToPath(new URL("./fixtures/claude-stub.mjs", import.meta.url));

const quiet = (): string[] => {
  const seen: string[] = [];
  resetFallbacks();
  setFallbackLog((l) => seen.push(l));
  return seen;
};

/** The 404 result of a model that does not exist (captured), as the self-test's runs get it. */
const refusedModel = (): Record<string, unknown> => events("no-such-model.json")[0]!;
/** The stream's init event (captured, signed out), with Pako's server connected and its tools listed, as 2.1.327 shows them. */
const initWith = (status = "connected"): Record<string, unknown> => ({
  ...events("not-logged-in.stream.json")[0]!,
  mcp_servers: [{ name: "pako", status, source: "dynamic" }],
  tools: ["WebSearch", "mcp__pako__remember", "mcp__pako__calendar"],
});

/**
 * A fake `claude` for the self-test: answers each of its three runs as 2.1.327 does, unless `change` says otherwise. Counts its calls.
 */
function fakeCli(change: {
  refuseFlag?: string;
  result?: (doc: Record<string, unknown>) => Record<string, unknown>;
  mcp?: string;
  resumeWords?: string;
  jsonArray?: boolean;
  failed?: string;
} = {}): ProbeExec & { calls: string[][] } {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<ProbeRun> => {
    calls.push(args);
    if (change.failed) return { code: null, stdout: "", stderr: "", failed: change.failed };
    if (change.refuseFlag && args.includes(change.refuseFlag)) return { code: 1, stdout: "", stderr: `error: unknown option '${change.refuseFlag}'\n` };
    if (args.includes("--resume")) return { code: 1, stdout: "", stderr: change.resumeWords ?? text("no-such-session.stderr.txt") };
    const doc = (change.result ?? ((d) => d))(refusedModel());
    if (args.includes("stream-json")) {
      const lines = [initWith(change.mcp), { type: "assistant", message: { content: [] }, error: "unknown" }, doc];
      return { code: 1, stdout: lines.map((l) => JSON.stringify(l)).join("\n"), stderr: text("no-such-model.stderr.txt") };
    }
    const out = change.jsonArray ? JSON.stringify([initWith(), doc]) : JSON.stringify(doc);
    return { code: 1, stdout: out, stderr: text("no-such-model.stderr.txt") };
  };
  return Object.assign(run, { calls });
}

const MCP = JSON.stringify({ mcpServers: { pako: { type: "stdio", command: "node", args: ["mcp-server.ts"] } } });
const probe = (exec: ProbeExec, version = "2.1.327") => probeCli({ version, exec, tools: ["WebSearch"], effort: "low", mcp: MCP, now: Date.UTC(2026, 10, 20) });
const fix = (v: string): string => fixCommand("/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js", v, (b) => b);

test("self-test: the captured 2.1.327 outputs pass; its three runs carry the bridge's own flags, a model that does not exist and a missing conversation", async () => {
  const exec = fakeCli();
  const r = await probe(exec);
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.works, { json: true, stream: true, mcp: true, resume: true });
  assert.equal(exec.calls.length, 3);
  const [stream, json, resume] = exec.calls as [string[], string[], string[]];
  for (const a of exec.calls) {
    assert.equal(a[a.indexOf("--model") + 1], PROBE_MODEL, "no model answers: nothing is generated");
    for (const f of ["-p", "--tools", "--strict-mcp-config", "--mcp-config", "--setting-sources", "--disable-slash-commands", "--permission-mode"]) assert.ok(a.includes(f), f);
  }
  assert.ok(stream.includes("--input-format") && stream.includes("--verbose") && stream.includes("--allowedTools"));
  assert.ok(stream[stream.indexOf("--mcp-config") + 1]!.includes("pako"), "Pako's MCP server, for the round trip");
  assert.equal(json[json.indexOf("--output-format") + 1], "json");
  assert.equal(json[json.indexOf("--effort") + 1], "low");
  assert.equal(resume[resume.indexOf("--resume") + 1], PROBE_SESSION);
  assert.deepEqual(compatFrom("2.1.327", r, { versions: {} }, fix), { version: "2.1.327", status: "ok" });
});

test("self-test: a newer version that behaves the same is used and shown as tested by probe (the range alone used to warn about it)", async () => {
  const r = await probe(fakeCli(), "2.2.0");
  assert.equal(r.ok, true);
  const c = compatFrom("2.2.0", r, recordProbe({ versions: {} }, r), fix);
  assert.equal(c.status, "probed");
  assert.equal(c.note, "Claude Code 2.2.0: tested by probe (Pako's self-test passed on 2026-11-20)");
  assert.equal(readBridgeReport({ cli: c })?.cli?.status, "probed", "the server takes it");
  assert.equal(model.healthSummary!({ parts: [{ key: "claude", status: "ok", okAt: 1 }], cli: c }, 2).ok, true, "a pass is no problem on the card");
});

test("self-test: an added field changes nothing; a renamed field is found under its new name, and that is logged as a fallback", async () => {
  const seen = quiet();
  const added = await probe(fakeCli({ result: (d) => ({ ...d, brand_new_field: { nested: [1, 2] }, another: "x" }) }));
  assert.equal(added.ok, true);
  assert.equal(fallbackCounts()["result-shape"], 0);
  const rename = ({ result, session_id, total_cost_usd, is_error, ...rest }: Record<string, unknown>) => ({
    ...rest, text: result, sessionId: session_id, totalCostUsd: total_cost_usd, isError: is_error,
  });
  const renamed = await probe(fakeCli({ result: rename }));
  assert.deepEqual(renamed.problems, []);
  assert.ok(fallbackCounts()["result-shape"] > 0);
  assert.match(seen.join("\n"), /fallback result-shape .*the result's result was found as text/);
  const doc = readResult(JSON.stringify({ type: "result", text: "hi", sessionId: "s1", totalCostUsd: 0.5, numTurns: 2, isError: false }))!;
  assert.deepEqual([doc.result, doc.session_id, doc.total_cost_usd, doc.num_turns, doc.is_error], ["hi", "s1", 0.5, 2, false]);
});

test("self-test: a result with no answer text under any name fails with a sentence naming what it had, and how to go back", async () => {
  quiet();
  const r = await probe(fakeCli({ result: ({ result, ...rest }) => ({ ...rest, answer_blocks: [{ text: String(result) }] }) }), "2.3.0");
  assert.equal(r.ok, false);
  assert.match(r.problems[0]!, /^Claude Code 2\.3\.0 gave a result with no answer text under any name Pako knows \(result, text, output, response; it had: .*answer_blocks/);
  const c = compatFrom("2.3.0", r, { versions: {}, lastGood: "2.2.0" }, fix);
  assert.equal(c.status, "failed");
  assert.equal(c.lastGood, "2.2.0");
  assert.match(c.note!, /failed Pako's self-test: .* \(and 1 more\)\. Pako keeps trying\. To go back to 2\.2\.0: npm i -g @anthropic-ai\/claude-code@2\.2\.0$/);
  assert.equal(missingEssential({ type: "result", result: "" }), null, "an empty answer is an answer: the run's own error says it");
  assert.equal(missingEssential(null), null);
});

test("self-test: a removed flag is named; with stream-json gone, every message gets a run of its own and the typed tools are off", async () => {
  const r = await probe(fakeCli({ refuseFlag: "--input-format" }), "2.4.0");
  assert.equal(r.ok, false);
  assert.deepEqual(r.works, { json: true, stream: false, mcp: false, resume: true });
  assert.equal(r.problems[0], `Claude Code 2.4.0 refused the flag --input-format of the conversation's runs ("error: unknown option '--input-format'")`);
  const c = compatFrom("2.4.0", r, { versions: {} }, (v) => fixCommand("claude", v, () => "/Users/a/.local/share/claude/versions/2.4.0"));
  assert.match(c.note!, /Pako keeps answering, one claude run per message and without its typed tools\. To go back to 2\.1\.327: claude install 2\.1\.327$/);
  const sent = readBridgeReport({ cli: c })?.cli;
  assert.equal(sent?.status, "failed");
  assert.match(sent!.note!, /claude install 2\.1\.327$/);
  assert.match(readBridgeReport({ cli: { ...c, note: "go back: npm i -g @anthropic-ai/claude-code@2.1.327" } })!.cli!.note!, /@anthropic-ai\/claude-code@2\.1\.327/, "the @ stays");
  const sum = model.healthSummary!({ parts: [{ key: "claude", status: "ok", okAt: 1 }], cli: c }, 2);
  assert.equal(sum.ok, false, "a failed self-test is a problem on the card, with its fix");
  assert.equal(sum.problems[0].key, "claude");
  assert.match(sum.problems[0].detail, /claude install 2\.1\.327/);
  // A flag refused by every run: nothing works, and it says so.
  const all = await probe(fakeCli({ refuseFlag: "--strict-mcp-config" }), "2.4.0");
  assert.deepEqual(all.works, { json: false, stream: false, mcp: false, resume: false });
  assert.equal(all.problems.length, 3);
});

test("self-test: Pako's MCP server not loading through Claude Code turns the typed tools off (the tags still work); a changed resume is named", async () => {
  const r = await probe(fakeCli({ mcp: "failed" }), "2.5.0");
  assert.deepEqual(r.works, { json: true, stream: true, mcp: false, resume: true });
  assert.match(r.problems[0]!, /did not connect Pako's MCP server/);
  assert.match(compatFrom("2.5.0", r, { versions: {} }, fix).note!, /through tags instead of its typed tools/);
  const words = await probe(fakeCli({ resumeWords: "Session abc is gone for good" }), "2.5.0");
  assert.equal(words.works.resume, false);
  assert.match(words.problems[0]!, /no longer says a conversation to resume is missing in words Pako knows \("Session abc is gone for good"\)/);
});

test("self-test: --output-format json written as an array of events (as with --verbose) is read for its last result", async () => {
  const r = await probe(fakeCli({ jsonArray: true }));
  assert.equal(r.works.json, true);
  assert.equal(readResult(JSON.stringify([{ type: "system" }, { type: "result", result: "a" }, { type: "result", result: "b" }]))!.result, "b");
  assert.equal(readResult("[]"), null);
  assert.equal(readResult("not json"), null);
});

test("self-test: a run that could not start or never ended concludes nothing: not kept, the range speaks, and it is tried again", async () => {
  const r = await probe(fakeCli({ failed: "a run took longer than 30 s" }), "2.6.0");
  assert.equal(r.inconclusive, "a run took longer than 30 s");
  assert.deepEqual(recordProbe({ versions: {} }, r), { versions: {} });
  const c = compatFrom("2.6.0", r, { versions: {} }, fix);
  assert.equal(c.status, "newer");
  assert.match(c.note!, /self-test could not run \(a run took longer than 30 s\), it tries again later/);
  assert.equal(compatFrom("", null, { versions: {} }, fix).status, "unknown");
});

function watchRig(o: { version: string; exec: ProbeExec; at?: number }) {
  const state = mkdtempSync(join(tmpdir(), "pako-probe-"));
  const config: BridgeConfig = {
    ...loadBridgeConfig({ ASSISTANT_SERVER_URL: "https://x.example.com", ASSISTANT_BRIDGE_TOKEN: "t".repeat(32), ASSISTANT_STATE_DIR: state }),
    mcpTools: true, effortOk: true,
  };
  const logs: string[] = [];
  const rig = { version: o.version, exec: o.exec, at: o.at ?? Date.UTC(2026, 10, 20) };
  const watch = createCliWatch({
    config, readVersion: () => `${rig.version} (Claude Code)\n`, exec: (a, i) => rig.exec(a, i), log: (l) => logs.push(l), now: () => rig.at, everyMs: 60_000,
  });
  return { rig, watch, config, logs, state };
}

test("self-test, kept per version: run once for a version, not again while it stays; a failure turns off what broke, a later pass gives it back", async () => {
  const good = fakeCli();
  const w = watchRig({ version: "2.1.327", exec: good });
  assert.equal((await w.watch.check()).status, "ok");
  assert.equal(good.calls.length, 3);
  assert.match(w.logs.join("\n"), /Claude Code 2\.1\.327: Pako's self-test passed on 2026-11-20/);
  assert.equal(w.watch.due(), false);
  w.rig.at += 60_000;
  assert.equal(w.watch.due(), true);
  await w.watch.check();
  assert.equal(good.calls.length, 3, "the same version: not tested again");
  // Claude Code updated itself to a version that dropped --input-format.
  const broken = fakeCli({ refuseFlag: "--input-format" });
  Object.assign(w.rig, { version: "2.4.0", exec: broken });
  const failed = await w.watch.check();
  assert.equal(failed.status, "failed");
  assert.match(failed.note!, /To go back to 2\.1\.327: (npm i -g @anthropic-ai\/claude-code@|claude install )2\.1\.327$/, "the last version that passed");
  assert.equal(w.config.warmMs, 0, "no process kept up");
  assert.equal(w.config.mcpTools, false, "no typed tools");
  assert.match(w.logs.join("\n"), /Claude Code self-test: Claude Code 2\.4\.0 refused the flag --input-format/);
  assert.match(w.logs.join("\n"), /Warning: Claude Code 2\.4\.0 failed Pako's self-test/);
  // Kept on disk: a restart does not test 2.1.327 again.
  const kept = JSON.parse(readFileSync(join(w.state, "cli-probe.json"), "utf8"));
  assert.deepEqual(Object.keys(kept.versions).sort(), ["2.1.327", "2.4.0"]);
  assert.equal(kept.lastGood, "2.1.327");
  // A failure is tried again after an hour (it may have been passing), not before.
  w.rig.at += 30 * 60_000;
  await w.watch.check();
  assert.equal(broken.calls.length, 3);
  w.rig.at += 31 * 60_000;
  await w.watch.check();
  assert.equal(broken.calls.length, 6);
  // The next update works again: what was asked for at start is back.
  Object.assign(w.rig, { version: "2.4.1", exec: fakeCli() });
  assert.equal((await w.watch.check()).status, "probed");
  assert.deepEqual([w.config.warmMs, w.config.mcpTools], [600_000, true]);
});

test("self-test, through the stand-in claude the other tests use: it answers the self-test like 2.1.327 and logs no run", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "claude-stub-")), "log.jsonl");
  writeFileSync(log, "");
  process.env.CLAUDE_STUB_LOG = log;
  const { execClaude } = await import("../assistant/bridge/cli-probe.ts");
  const r = await probeCli({ version: "2.1.327", exec: execClaude(STUB, mkdtempSync(join(tmpdir(), "pako-probe-"))), tools: [], mcp: MCP });
  delete process.env.CLAUDE_STUB_LOG;
  assert.deepEqual(r.problems, []);
  assert.equal(readFileSync(log, "utf8"), "");
});

/** A fake `claude` program that prints `out` for any run, for runClaude itself. */
function fakeProgram(out: string, code = 0): string {
  const d = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const bin = join(d, "claude");
  writeFileSync(bin, `#!${process.execPath}\nprocess.stdin.resume();\nprocess.stdin.on("end", () => { process.stdout.write(${JSON.stringify(out)}); process.exit(${code}); });\n`);
  chmodSync(bin, 0o755);
  return bin;
}
const run = (bin: string) => runClaude("hi", { claudeBin: bin, tools: [], model: "", runTimeoutMs: 20_000 });

test("a run: renamed fields are read under their new names, unknown ones ignored; with no answer text the error says so plainly", { skip: process.platform === "win32" }, async () => {
  quiet();
  const renamed = await run(fakeProgram(JSON.stringify({ type: "result", subtype: "success", isError: false, text: "Hello", sessionId: "s-9", totalCostUsd: 0.25, numTurns: 1, x: { y: 1 } })));
  assert.deepEqual([renamed.text, renamed.sessionId, renamed.costUsd], ["Hello", "s-9", 0.25]);
  const array = await run(fakeProgram(JSON.stringify([{ type: "system", subtype: "init" }, { type: "result", result: "Hi", session_id: "s-1", total_cost_usd: 0, num_turns: 1 }])));
  assert.deepEqual([array.text, array.sessionId], ["Hi", "s-1"]);
  await assert.rejects(run(fakeProgram(JSON.stringify({ type: "result", is_error: false, content: [{ type: "text", text: "Hi" }], session_id: "s" }))), (err: unknown) => {
    assert.ok(err instanceof ClaudeError);
    assert.equal(err.kind, "other");
    assert.match(err.message, /gave a result with no answer text under any name Pako knows .*it had: type, is_error, content, session_id/);
    return true;
  });
});

test("claude auth status: the fields under another spelling (snake_case) are read the same; other fields ignored", () => {
  const a = parseClaudeAccount(0, JSON.stringify({ logged_in: true, auth_method: "claude.ai", email: "ana@example.com", subscription_type: "max", expires_at: "2026-12-15T17:32:26.321Z", new: 1 }));
  assert.deepEqual(a, { loggedIn: true, billing: "plan", email: "ana@example.com", plan: "max", expiresAt: Date.parse("2026-12-15T17:32:26.321Z") });
});

test("self-test, no Claude Code yet: said once, not every round; once it is installed, its version is tested", async () => {
  const exec = fakeCli();
  const w = watchRig({ version: "", exec });
  assert.equal((await w.watch.check()).status, "unknown");
  await w.watch.check();
  assert.equal(w.logs.filter((l) => /could not read which Claude Code/.test(l)).length, 1);
  assert.equal(exec.calls.length, 0);
  w.rig.version = "2.1.327";
  assert.equal((await w.watch.check()).status, "ok");
  assert.equal(exec.calls.length, 3);
});
