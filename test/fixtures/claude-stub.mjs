#!/usr/bin/env node
// A stand-in for the `claude` program, for the tests and the latency bench (test/bench/latency.ts). It takes the flags the bridge passes
// and answers like Claude Code's print mode: one JSON result for a prompt on standard input, or, with `--input-format stream-json`, one
// "result" line for each user message line, staying up until standard input closes. It sleeps like the real one would: CLAUDE_STUB_START_MS once
// when the process starts (the CLI's own start), then CLAUDE_STUB_TURN_MS plus CLAUDE_STUB_MS_PER_KCHAR for every thousand characters of the system
// prompt and the message, for each answer.
//
// CLAUDE_STUB_LOG: a file that gets one JSON line per start and per turn ({event, pid, args | prompt}). CLAUDE_STUB_REPLY: the answer ("ok").
// CLAUDE_STUB_MODE: ok, limit (the plan's limit, "resets 9pm"), gone (a --resume of a conversation that is not there), hang (never answers).

import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const env = (k, d) => (process.env[k] === undefined || process.env[k] === "" ? d : process.env[k]);
const mode = env("CLAUDE_STUB_MODE", "ok");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const note = (o) => {
  if (process.env.CLAUDE_STUB_LOG) appendFileSync(process.env.CLAUDE_STUB_LOG, `${JSON.stringify({ pid: process.pid, ...o })}\n`);
};
const system = flag("--system-prompt") ?? "";
const resumed = flag("--resume");
const session = resumed ?? env("CLAUDE_STUB_SESSION", `stub-${process.pid}`);
let cost = 0;

// The sign-in commands (src/claude-connect.ts), like Claude Code 2.1.327: `--version`, `auth status --json`, `auth login`, `auth logout`.
// CLAUDE_STUB_AUTH: a JSON file that is this stub's sign-in ({loggedIn, authMethod, email, subscriptionType, loginExpiresAt}); absent or
// {"loggedIn": false}: signed out. CLAUDE_STUB_LOGIN: what the browser does after CLAUDE_STUB_LOGIN_MS: "ok" (signed in, with
// CLAUDE_STUB_PLAN and CLAUDE_STUB_EMAIL; CLAUDE_STUB_METHOD for a Console login), "cancel" (the person cancels on Claude's page), "hang"
// (nobody finishes). No token exists here: like the real one, status never prints one.
if (args[0] === "--version") {
  process.stdout.write("2.1.327 (Claude Code)\n");
  process.exit(0);
}
if (args[0] === "auth") {
  const { existsSync, writeFileSync } = await import("node:fs");
  const file = process.env.CLAUDE_STUB_AUTH ?? "";
  const read = () => {
    try {
      return file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { loggedIn: false };
    } catch {
      return { loggedIn: false };
    }
  };
  note({ event: "auth", args });
  if (args[1] === "status") {
    const s = read();
    const out = s.loggedIn
      ? { loggedIn: true, authMethod: s.authMethod ?? "claude.ai", apiProvider: "firstParty", email: s.email ?? "", subscriptionType: s.subscriptionType ?? null, loginExpiresAt: s.loginExpiresAt ?? null }
      : { loggedIn: false, authMethod: "none", apiProvider: "firstParty", loginExpiresAt: null };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(s.loggedIn ? 0 : 1);
  }
  if (args[1] === "logout") {
    if (file) writeFileSync(file, JSON.stringify({ loggedIn: false }));
    process.stdout.write("Successfully logged out from your Anthropic account.\n");
    process.exit(0);
  }
  if (args[1] === "login") {
    process.stdout.write("Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=stub-state\nPaste code here if prompted > ");
    const how = env("CLAUDE_STUB_LOGIN", "ok");
    await sleep(Number(env("CLAUDE_STUB_LOGIN_MS", "300")));
    if (how === "hang") await sleep(3_600_000);
    if (how === "cancel") {
      process.stderr.write("Couldn't log in: No authorization code received\n");
      process.exit(1);
    }
    const expires = env("CLAUDE_STUB_EXPIRES", new Date(Date.now() + 30 * 86_400_000).toISOString());
    writeFileSync(file, JSON.stringify({ loggedIn: true, authMethod: env("CLAUDE_STUB_METHOD", "claude.ai"), email: env("CLAUDE_STUB_EMAIL", "ana@example.com"),
      subscriptionType: env("CLAUDE_STUB_PLAN", "pro"), loginExpiresAt: expires }));
    process.stdout.write("\nLogin successful.\n");
    process.exit(0);
  }
  process.exit(2);
}

note({ event: "start", args });
await sleep(Number(env("CLAUDE_STUB_START_MS", "0")));
if (mode === "gone" && resumed) {
  process.stderr.write(`No conversation found with session ID: ${resumed}`);
  process.exit(1);
}

// Tool calls, like Claude Code with an MCP config: CLAUDE_STUB_TOOLS is a JSON list of {name, input} made in each turn, in order. A name of
// the "pako" server in --mcp-config is called on that real server (started from the config, as Claude Code would) and its result streamed
// back; any other name (WebSearch) is streamed as a tool use of Claude Code's own. CLAUDE_STUB_MCP=down: the init line says the server failed.
const mcpConfig = (() => {
  try {
    return JSON.parse(flag("--mcp-config") ?? "{}").mcpServers ?? {};
  } catch {
    return {};
  }
})();
const plannedCalls = JSON.parse(env("CLAUDE_STUB_TOOLS", "[]"));
let client = null;
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
let initSent = false;
const init = async () => {
  if (initSent) return;
  initSent = true;
  const pako = mcpConfig.pako;
  let status = pako ? "connected" : null;
  if (pako && env("CLAUDE_STUB_MCP", "") !== "down") {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    client = new Client({ name: "claude-stub", version: "1" });
    await client.connect(new StdioClientTransport({ command: pako.command, args: pako.args, env: { ...process.env, ...(pako.env ?? {}) } }));
  } else if (pako) status = "failed";
  out({ type: "system", subtype: "init", session_id: session, mcp_servers: pako ? [{ name: "pako", status }] : [] });
};
let msgN = 0;
// The tools this run may use (--allowedTools): a Pako tool not offered is never called, as a real model never sees it.
const allowedTools = (flag("--allowedTools") ?? "").split(",").filter(Boolean);
const useTools = async () => {
  let n = 0;
  for (const c of plannedCalls) {
    const id = `toolu_${++msgN}`;
    const pakoTool = !!client && !c.name.includes("Web");
    if (pakoTool && allowedTools.length && !allowedTools.includes(`mcp__pako__${c.name}`)) continue;
    n++;
    out({ type: "assistant", message: { id: `msg_${msgN}`, role: "assistant", content: [{ type: "tool_use", id, name: pakoTool ? `mcp__pako__${c.name}` : c.name, input: c.input ?? {} }] } });
    let r = { content: [{ type: "text", text: "some web text" }] };
    if (pakoTool) r = await client.callTool({ name: c.name, arguments: c.input ?? {} });
    note({ event: "tool", name: c.name, isError: r.isError === true, text: r.content?.[0]?.text });
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: r.content, ...(r.isError ? { is_error: true } : {}) }] } });
    // The model reads the tool's answer in a turn of its own: one more round trip (CLAUDE_STUB_TURN_MS, measured on the real one).
    await sleep(Number(env("CLAUDE_STUB_TURN_MS", "0")));
  }
  return n;
};

const answer = async (prompt) => {
  note({ event: "turn", prompt });
  if (mode === "hang") await sleep(3_600_000);
  await sleep(Number(env("CLAUDE_STUB_TURN_MS", "0")) + (Number(env("CLAUDE_STUB_MS_PER_KCHAR", "0")) * (system.length + prompt.length)) / 1000);
  cost += 0.01;
  if (mode === "limit") return { type: "result", is_error: true, result: "You've hit your 5-hour limit · resets 9pm", session_id: session, num_turns: 1 };
  const used = flag("--input-format") === "stream-json" && Object.keys(mcpConfig).length ? (await init(), await useTools()) : 0;
  return { type: "result", subtype: "success", is_error: false, result: env("CLAUDE_STUB_REPLY", "ok"), session_id: session, total_cost_usd: Number(cost.toFixed(4)), num_turns: 1 + used };
};

if (flag("--input-format") === "stream-json") {
  let buf = "";
  let chain = Promise.resolve();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (b) => {
    buf += b;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) {
      if (!l.trim()) continue;
      const msg = JSON.parse(l);
      const text = (msg.message?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      chain = chain.then(async () => {
        const r = await answer(text);
        process.stdout.write(`${JSON.stringify(r)}\n`);
        if (r.is_error) process.exit(1);
      });
    }
  });
  process.stdin.on("end", () => void chain.then(() => process.exit(0)));
} else {
  const r = await answer(readFileSync(0, "utf8"));
  process.stdout.write(`${JSON.stringify(r)}\n`);
  process.exit(r.is_error ? 1 : 0);
}
