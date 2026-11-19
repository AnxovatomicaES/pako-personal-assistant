// One `claude -p` run: its arguments, its result, its errors, and the runs under way (stopped with the bridge).

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { OutsideSource } from "../../src/quarantine.ts";
import { SYSTEM_PROMPT } from "../prompt.ts";
import { OFFERED_TOOLS, toolId, type ToolCall } from "../tools.ts";
import type { BridgeConfig } from "./config.ts";
import { childEnv, claudeCommand } from "./cli.ts";
import { seenFields, watchTurn, type TurnSeen } from "./mcp.ts";

/**
 * A file given to Claude as it is (a photo or a PDF, src/papers.ts): a content block of the one message a run sends, read by Claude itself
 * with no tool. Only these kinds: src/papers.ts checks the bytes before any comes here.
 */
export interface FileBlock {
  type: "image" | "document";
  source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/webp" | "application/pdf"; data: string };
}

/**
 * The arguments of one `claude -p` run: the lean setup measured at about a hundredth of the default context. `stream`: the message goes in as
 * one JSON line (stream-json), which is how a file is given as a content block; the result then comes as JSON lines too.
 */
export function buildClaudeArgs(
  c: Pick<BridgeConfig, "tools" | "model"> & { systemPrompt?: string; stream?: boolean; noBare?: boolean; effort?: string; mcp?: string },
  sessionId?: string,
): string[] {
  // With Pako's MCP server, its tools are allowed by name, one by one: --tools names only Claude Code's own (the web), and nothing else of
  // that server's or of any other is allowed; --strict-mcp-config keeps every other server out. Its turns stream, so the bridge sees each
  // tool call and its result (watchTurn).
  const allowed = [...c.tools, ...(c.mcp ? OFFERED_TOOLS.map(toolId) : [])];
  return [
    "-p",
    ...(c.noBare ? ["--no-bare"] : []),
    ...(c.stream || c.mcp ? ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"] : ["--output-format", "json"]),
    "--tools", c.tools.join(","),
    ...(allowed.length ? ["--allowedTools", allowed.join(",")] : []),
    "--strict-mcp-config",
    "--mcp-config", c.mcp ?? '{"mcpServers":{}}',
    "--setting-sources", "",
    "--disable-slash-commands",
    "--permission-mode", "dontAsk",
    "--system-prompt", c.systemPrompt ?? SYSTEM_PROMPT,
    ...(c.model ? ["--model", c.model] : []),
    ...(c.effort ? ["--effort", c.effort] : []),
    ...(sessionId ? ["--resume", sessionId] : []),
  ];
}

export interface ClaudeResult {
  text: string;
  sessionId: string;
  costUsd: number;
  /**
   * The run used a tool (its only tools read the web): what it read there is other people's text, so the tags of its answer are not the
   * owner's own (src/quarantine.ts). Left out when it used none.
   */
  readOutside?: boolean;
  /** A turn with Pako's tools: each call to them as the run's output showed it, with whether it was refused (watchTurn). */
  toolCalls?: ToolCall[];
  /** Outside text a read tool gave this turn (the calendar): the turn is marked by it, like one that read the web. */
  outsideRead?: OutsideSource[];
  /** Pako's MCP server did not load for this run: the bridge goes back to the tags. */
  mcpDown?: true;
}

export interface ClaudeJson {
  result?: unknown;
  session_id?: unknown;
  is_error?: unknown;
  total_cost_usd?: unknown;
  num_turns?: unknown;
  usage?: { server_tool_use?: { web_search_requests?: unknown; web_fetch_requests?: unknown } };
}

/**
 * Whether a run read the web: more than one turn (a tool was called and its result read back) or a web request counted by the API. A result
 * that says neither (an older claude) counts as none, as before this check. `num_turns` is the run's own: Claude Code 2.1.325 starts it at 1
 * for the prompt and adds one per tool result inside that run, whatever --resume loaded before it, so a plain resumed answer is 1.
 */
export function readTheWeb(doc: ClaudeJson, seen?: TurnSeen): boolean {
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const web = doc.usage?.server_tool_use;
  if (n(web?.web_search_requests) > 0 || n(web?.web_fetch_requests) > 0) return true;
  // A turn whose tool calls were watched: Pako's own tools read nothing from outside (the calendar is marked apart, outsideRead), so only
  // another tool marks it, or a turn more than the watched calls explain (a tool use the output did not show: the safe side).
  if (seen) return seen.foreign || n(doc.num_turns) - 1 > seen.toolMessages;
  return n(doc.num_turns) > 1;
}

export class ClaudeError extends Error {
  kind: "login" | "limit" | "other";
  constructor(message: string, kind: "login" | "limit" | "other") {
    super(message);
    this.kind = kind;
  }
}

// An API key whose account is out of credits ("Credit balance is too low") waits like a plan's limit: the message is answered once credits are
// added, instead of being dropped with an apology.
export const classify = (s: string): "login" | "limit" | "other" =>
  /not logged in|please run \/login|invalid api key|authentication|oauth token|unauthori[sz]ed/i.test(s)
    ? "login"
    : /rate limit|usage limit|limit reached|overloaded|quota|hit your .{0,40}limit|out of (?:extra )?usage|spend limit|shared budget/i.test(s)
        || /usage credits?|credit balance|(?:weekly|monthly|5-hour|opus|sonnet) limit/i.test(s)
      ? "limit"
      : "other";

/** The `claude -p` runs under way, by process id (each the leader of its own group, see runClaude). */
export const runningClaude = new Set<number>();

/**
 * Stops every `claude -p` run under way, with its whole process group: when the bridge stops (Pako quit, its server gone), a run left alone
 * would go on using the person's plan, and maybe acting on their files, with nobody to take its answer. Returns how many were signalled.
 */
export function stopRunningClaude(signal: NodeJS.Signals = "SIGTERM"): number {
  let n = 0;
  for (const pid of runningClaude) {
    try {
      if (process.platform !== "win32") process.kill(-pid, signal);
      else process.kill(pid, signal);
      n++;
    } catch {
      runningClaude.delete(pid); // already gone
    }
  }
  return n;
}

/**
 * Runs `claude -p` with the prompt on its standard input and reads the one JSON result. `files`: given to Claude before the prompt's words, as
 * content blocks of one stream-json message (the result is then the last "result" line of the JSON lines that come back).
 */
export type RunConfig = Pick<BridgeConfig, "claudeBin" | "tools" | "model" | "runTimeoutMs" | "noBare"> & {
  stateDir?: string; systemPrompt?: string; files?: FileBlock[]; effort?: string;
  /** Pako's MCP server for this run (mcpConfigFor): only the owner's conversation gets it. */
  mcp?: string;
};

export function runClaude(
  prompt: string,
  c: RunConfig,
  sessionId?: string,
): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const stream = !!c.files?.length || !!c.mcp;
    const watch = c.mcp ? watchTurn() : null;
    // Always from an empty folder of its own: from inside a project Claude Code would load that project's instruction files into every call.
    if (c.stateDir) mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
    // Its own process group: a timeout kills the whole group (a wrapper script's children too), and does not wait for pipes a grandchild still holds.
    const [cmd, args] = claudeCommand(c.claudeBin, buildClaudeArgs({ ...c, stream }, sessionId));
    // windowsHide: under the hidden autostart (src/autostart-windows.ts) each run would otherwise flash a console window. Ignored elsewhere.
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true, env: { ...childEnv(process.env), NO_COLOR: "1" },
      ...(c.stateDir ? { cwd: c.stateDir } : {}),
    });
    if (child.pid) runningClaude.add(child.pid);
    let out = "";
    let err = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      if (!settled) {
        settled = true;
        reject(new ClaudeError(`Claude took longer than ${Math.round(c.runTimeoutMs / 1000)} s`, "other"));
      }
    }, c.runTimeoutMs);
    child.stdout.setEncoding("utf8"); // a character split across two chunks stays whole (an accented letter, an emoji)
    child.stderr.setEncoding("utf8");
    // Streamed, only the result line is kept: the other lines (the run's start, the answer as it came) can be long and are not needed.
    let partial = "";
    child.stdout.on("data", (b: string) => {
      if (!stream) {
        if (out.length < 4_000_000) out += b;
        return;
      }
      const lines = (partial + b).split("\n");
      partial = lines.pop() ?? "";
      if (partial.length > 4_000_000) partial = "";
      for (const l of lines) keepResult(l);
    });
    const keepResult = (l: string): void => {
      watch?.line(l);
      if (!/"type"\s*:\s*"result"/.test(l)) return;
      try {
        if ((JSON.parse(l) as { type?: unknown }).type === "result") out = l;
      } catch {
        /* not a whole JSON line */
      }
    };
    child.stderr.on("data", (b: string) => {
      if (err.length < 20_000) err += b;
    });
    child.on("error", (e) => {
      if (child.pid) runningClaude.delete(child.pid);
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(new ClaudeError(`could not start ${c.claudeBin}: ${e.message}`, "other"));
    });
    child.on("close", (code) => {
      if (child.pid) runningClaude.delete(child.pid);
      clearTimeout(timer);
      if (settled || timedOut) return;
      settled = true;
      if (stream && partial) keepResult(partial);
      let doc: ClaudeJson | null = null;
      try {
        doc = JSON.parse(out) as ClaudeJson;
      } catch {
        /* not JSON: handled below */
      }
      const text = typeof doc?.result === "string" ? doc.result : "";
      if (code !== 0 || !doc || doc.is_error === true || !text.trim()) {
        const why = `${text} ${err}`.replace(/\s+/g, " ").trim().slice(0, 300) || `exit code ${code}`;
        return reject(new ClaudeError(why, classify(why)));
      }
      const seen = watch?.done() ?? null;
      resolve({
        text,
        sessionId: typeof doc.session_id === "string" ? doc.session_id : "",
        costUsd: typeof doc.total_cost_usd === "number" ? doc.total_cost_usd : 0,
        ...(readTheWeb(doc, seen ?? undefined) ? { readOutside: true } : {}),
        ...seenFields(seen),
      });
    });
    child.stdin.on("error", () => undefined);
    // Streamed: one user message, the files first and then the words; standard input then closes, so the run ends after its one answer.
    const content = [...(c.files ?? []), { type: "text", text: prompt }];
    child.stdin.end(stream ? `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n` : prompt);
  });
}
