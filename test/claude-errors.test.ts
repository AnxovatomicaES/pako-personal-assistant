// How the bridge reads Claude Code: a failure's kind from its structured fields, the web from tool_use events, the version against the tested
// range. Built from real outputs of Claude Code 2.1.327 (test/fixtures/claude-cli/2.1.327/), captured with no quota spent except two short
// Haiku answers, from an empty folder, and scrubbed (ids, paths, timestamps, the search results' text, the CLI's lists of its own commands):
//   version.txt                 claude --version
//   no-such-model.json          echo hi | claude -p --output-format json --tools "" --model claude-nonexistent-9   (and its .stderr.txt)
//   not-logged-in.json          the same with HOME and CLAUDE_CONFIG_DIR pointed at an empty folder, no ANTHROPIC_API_KEY
//   not-logged-in.stream.json   the same with --input-format stream-json --output-format stream-json --verbose (one event per element)
//   invalid-api-key.json        signed out, with ANTHROPIC_API_KEY set to a made-up key
//   no-such-session.stderr.txt  echo hi | claude -p --output-format json --resume 00000000-0000-4000-8000-000000000000
//   web-search.stream.json      stream-json, --tools WebSearch, Haiku asked to look up one fact with WebSearch (one search)
// The JSON files hold an array of events: the stream's lines are each element written back as one JSON line.

import { readFileSync as readRepoFile } from "node:fs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  classifyFailure, ClaudeError, cliCompat, compareVersions, errorSignals, fallbackCounts, modelUnavailable, parseClaudeVersion, resetFallbacks,
  sessionMissing, setFallbackLog, watchTurn, webRead,
} from "../assistant/bridge.ts";
import { classify } from "../assistant/bridge/claude-errors.ts";
import type { ClaudeJson } from "../assistant/bridge/claude.ts";

const dir = new URL("./fixtures/claude-cli/2.1.327/", import.meta.url);
const text = (f: string): string => readFileSync(new URL(f, dir), "utf8");
const events = (f: string): Record<string, unknown>[] => JSON.parse(text(f)) as Record<string, unknown>[];
const lines = (f: string): string[] => events(f).map((e) => JSON.stringify(e));
/** The one result document of a --output-format json run. */
const result = (f: string): ClaudeJson => events(f)[0] as ClaudeJson;
const messageOf = (doc: ClaudeJson): string => (typeof doc.result === "string" ? doc.result : "");
const quiet = (): string[] => {
  const seen: string[] = [];
  resetFallbacks();
  setFallbackLog((l) => seen.push(l));
  return seen;
};

test("captured 2.1.327: claude --version reads as 2.1.327, which is within the tested range", () => {
  assert.equal(parseClaudeVersion(text("version.txt")), "2.1.327");
  assert.deepEqual(cliCompat(text("version.txt")), { version: "2.1.327", status: "ok" });
});

test("version range: newer and older say so in one sentence, an unreadable output is unknown, and nothing stops working", () => {
  const tested = { min: "2.1.325", maxTested: "2.1.327" };
  const newer = cliCompat("2.2.0 (Claude Code)", tested);
  assert.equal(newer.status, "newer");
  assert.equal(newer.note, "Claude Code 2.2.0 is newer than Pako has been tested with (up to 2.1.327)");
  assert.equal(cliCompat("2.1.200 (Claude Code)", tested).status, "older");
  assert.match(cliCompat("2.1.200 (Claude Code)", tested).note ?? "", /older than Pako has been tested with/);
  assert.equal(cliCompat("2.1.325 (Claude Code)", tested).status, "ok", "the minimum itself is in range");
  assert.equal(cliCompat("", tested).status, "unknown");
  assert.ok(compareVersions("2.1.10", "2.1.9") > 0, "numbers, not text");
  assert.equal(compareVersions("2.1.327", "2.1.327"), 0);
});

test("captured 2.1.327: a model that does not exist is a 404 not_found_error, decided by the status, and modelUnavailable says so", () => {
  const log = quiet();
  const doc = result("no-such-model.json");
  assert.equal(doc.is_error, true);
  const e = classifyFailure({ message: messageOf(doc), doc });
  assert.ok(e instanceof ClaudeError);
  assert.deepEqual([e.kind, e.status, e.apiType, e.via], ["other", 404, "not_found_error", "none"]);
  assert.equal(modelUnavailable(e.message, "claude-nonexistent-9", e), true, "structured: the 404");
  assert.equal(modelUnavailable(messageOf(doc), "claude-nonexistent-9"), true, "and the 2.1.327 words alone");
  assert.equal(fallbackCounts()["error-text"], 0, "no English was needed");
  assert.deepEqual(log, []);
});

test("captured 2.1.327: an invalid API key is a 401 authentication_error: login, from the status", () => {
  const doc = result("invalid-api-key.json");
  const e = classifyFailure({ message: messageOf(doc), doc });
  assert.deepEqual([e.kind, e.status, e.via], ["login", 401, "status"]);
});

test("captured 2.1.327: signed out, the JSON output has no status (the words decide, logged as a fallback); the stream has its error event", () => {
  const log = quiet();
  const doc = result("not-logged-in.json");
  assert.equal(doc.api_error_status, null);
  const byWords = classifyFailure({ message: messageOf(doc), doc });
  assert.deepEqual([byWords.kind, byWords.via], ["login", "text"]);
  assert.equal(fallbackCounts()["error-text"], 1);
  assert.match(log[0] ?? "", /^fallback error-text \(1 so far/);
  // The same run streamed: the assistant message's `error` field decides, with no English.
  resetFallbacks();
  const signals = errorSignals();
  for (const l of lines("not-logged-in.stream.json")) signals.line(l);
  assert.equal(signals.done().streamError, "authentication_failed");
  const streamed = events("not-logged-in.stream.json").find((e) => e.type === "result") as ClaudeJson;
  const e = classifyFailure({ message: messageOf(streamed), doc: streamed, signals: signals.done() });
  assert.deepEqual([e.kind, e.via], ["login", "stream"]);
  assert.equal(fallbackCounts()["error-text"], 0);
});

test("structured signals: 429 and 529 are limits, a rejected rate_limit_event is a limit, ENOENT is missing, anything else is other", () => {
  quiet();
  assert.equal(classifyFailure({ message: "x", doc: { api_error_status: 429 } }).kind, "limit");
  assert.equal(classifyFailure({ message: "x", doc: { api_error_status: 529 } }).kind, "limit");
  assert.equal(classifyFailure({ message: "x", doc: { api_error_type: "rate_limit_error" } }).kind, "limit");
  assert.equal(classifyFailure({ message: "x", doc: { api_error_type: "permission_error" } }).kind, "login");
  const s = errorSignals();
  s.line(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour" } }));
  assert.deepEqual([classifyFailure({ message: "x", signals: s.done() }).kind, classifyFailure({ message: "x", signals: s.done() }).via], ["limit", "stream"]);
  const allowed = errorSignals();
  // The captured stream's own rate_limit_event says "allowed": nothing.
  for (const l of lines("web-search.stream.json")) allowed.line(l);
  assert.deepEqual(allowed.done(), {});
  assert.deepEqual([classifyFailure({ message: "could not start claude: spawn claude ENOENT", spawnCode: "ENOENT" }).via], ["spawn"]);
  assert.equal(classifyFailure({ message: "something odd" }).kind, "other");
  assert.equal(fallbackCounts()["error-text"], 0);
});

test("the English fallback keeps every wording it knew (each documented with its version), and a status beats the words", () => {
  quiet();
  for (const [s, kind] of [
    ["You've hit your 5-hour limit · resets 9pm", "limit"], ["Credit balance is too low", "limit"], ["Not logged in · Please run /login", "login"],
    ["OAuth token has expired", "login"], ["could not start claude: spawn claude ENOENT", "missing"], ["a timeout", "other"],
  ] as const) assert.equal(classify(s), kind, s);
  const e = classifyFailure({ message: "rate limit words", doc: { api_error_status: 401 } });
  assert.equal(e.kind, "login", "the status decides first");
});

test("captured 2.1.327: a resume of a conversation this computer does not have says so on stderr (no structured field): words, logged", () => {
  const log = quiet();
  assert.equal(sessionMissing(text("no-such-session.stderr.txt")), true);
  assert.equal(sessionMissing("Claude took longer than 180 s"), false);
  assert.equal(log.length, 1);
});

test("captured 2.1.327: a WebSearch shows as a tool_use event while the API's web counters stay 0; the event decides, no fallback", () => {
  const log = quiet();
  const watch = watchTurn();
  for (const l of lines("web-search.stream.json")) watch.line(l);
  const seen = watch.done();
  assert.equal(seen.web, true);
  const doc = events("web-search.stream.json").find((e) => e.type === "result") as ClaudeJson;
  assert.equal(doc.usage?.server_tool_use?.web_search_requests, 0, "the counters alone would miss it");
  assert.deepEqual(webRead(doc, seen), { read: true, via: "events" });
  assert.equal(fallbackCounts()["web-turns"], 0);
  assert.deepEqual(log, []);
});

test("web read: no events (JSON output) falls back to num_turns and logs it; a run with no tools never needs the fallback", () => {
  const log = quiet();
  assert.deepEqual(webRead({ num_turns: 2 }), { read: true, via: "num_turns" });
  assert.deepEqual(webRead({ num_turns: 1 }), { read: false, via: "num_turns" });
  assert.equal(fallbackCounts()["web-turns"], 2);
  assert.match(log[0] ?? "", /^fallback web-turns/);
  assert.deepEqual(webRead({ num_turns: 1 }, undefined, false), { read: false, via: "none" });
  const plain = { calls: [], toolMessages: 0, foreign: false, web: false, outside: [], mcpDown: false };
  assert.deepEqual(webRead({ num_turns: 1 }, plain), { read: false, via: "events" }, "watched and nothing seen: no fallback");
  assert.deepEqual(webRead({ num_turns: 2 }, plain), { read: true, via: "num_turns" }, "a turn the events do not explain: the safe side, logged");
  assert.equal(fallbackCounts()["web-turns"], 3);
});

test("fallbacks are logged the first time and every 25th, and counted every time", () => {
  const log = quiet();
  for (let i = 0; i < 50; i++) classifyFailure({ message: "You've hit your 5-hour limit" });
  assert.equal(fallbackCounts()["error-text"], 50);
  assert.equal(log.length, 3, "1st, 25th and 50th");
});

test("the Salud card: the server keeps the bridge's Claude Code version and its sentence, cleaned, and an older body still reads", async () => {
  const { createWatchdog, readBridgeReport } = await import("../src/watchdog.ts");
  const note = "Claude Code 2.2.0 is newer than Pako has been tested with (up to 2.1.327)";
  assert.deepEqual(readBridgeReport({ cli: { version: "2.2.0", status: "newer", note } }), { cli: { version: "2.2.0", status: "newer", note } });
  assert.deepEqual(readBridgeReport({ cli: { version: "2.1.327", status: "ok", note: "ignored" } }), { cli: { version: "2.1.327", status: "ok" } });
  assert.equal(readBridgeReport({ cli: { version: "2.2", status: "newer" } }), null, "not x.y.z");
  assert.equal(readBridgeReport({ cli: { version: "2.2.0", status: "fine" } }), null);
  assert.equal(readBridgeReport({ cli: { version: "2.2.0", status: "newer", note: "<b>x</b>" } })?.cli?.note, "b x /b", "no markup");
  const logged: string[] = [];
  const dog = createWatchdog({ config: { on: true, quiet: null }, local: true, timeZone: "UTC", notify: () => null, kv: null, log: (l) => logged.push(l) });
  assert.equal(dog.state().cli, null);
  dog.bridgeReport({ cli: { version: "2.2.0", status: "newer", note } });
  dog.bridgeReport({ cli: { version: "2.2.0", status: "newer", note } });
  assert.deepEqual(dog.state().cli, { version: "2.2.0", status: "newer", note });
  assert.equal(logged.filter((l) => l.includes(note)).length, 1, "logged once");
});

test("one action path: the tags an answer acted through are named (the fallback turn.ts counts); plain words and tool calls name none", async () => {
  const { tagActions } = await import("../assistant/bridge/reply.ts");
  assert.deepEqual(tagActions('Done. <remember>likes tea</remember> <remind at="2026-11-21 09:00">call Ana</remind>'), ["remember", "remind"]);
  assert.deepEqual(tagActions("Just words, no tags."), []);
});


/** A file of the repository, as text. */
const repoText = (p: string): string => readRepoFile(new URL(`../${p}`, import.meta.url), "utf8");

// With no claude command on this computer every message got "I couldn't work out an answer just now. Try again in a moment.", which
// trying again never fixes. It says what is wrong and the fix, in the panel's words (src/panel/app.js BANNERS.missing).
test("no claude command: the answer says Claude is missing and how to connect it, as the panel does, not 'try again'", async () => {
  const { runClaude, ClaudeError } = await import("../assistant/bridge.ts");
  const { classify } = await import("../assistant/bridge/claude.ts");
  const { T } = await import("../assistant/bridge/texts.ts");
  const err = await runClaude("x", { claudeBin: "/nonexistent/claude", tools: [], model: "", runTimeoutMs: 5_000 } as never).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof ClaudeError);
  assert.equal((err as InstanceType<typeof ClaudeError>).kind, "missing");
  // The warm process says it the same way (assistant/bridge/warm.ts classifies its "could not start" line).
  assert.equal(classify("could not start claude: spawn claude ENOENT"), "missing");
  assert.equal(classify("something else broke"), "other");
  const said = T()("missing" as never);
  assert.match(said, /Pako needs Claude to think/);
  assert.match(said, /Connect your Claude account/);
  assert.doesNotMatch(said, /Try again in a moment/);
  assert.match(repoText("src/panel/app.js"), /h\("b", \{\}, "Pako needs Claude to think\. "\),\s*claudeLink\("Connect your Claude account"\)/);
});
