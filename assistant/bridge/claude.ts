// One `claude -p` run: its arguments, its result, its errors, and the runs under way (stopped with the bridge).

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { OutsideSource } from "../../src/quarantine.ts";
import { SYSTEM_PROMPT } from "../prompt.ts";
import { OFFERED_TOOLS, toolId, type ToolCall } from "../tools.ts";
import type { BridgeConfig } from "./config.ts";
import { childEnv, claudeCommand } from "./cli.ts";
import { ClaudeError, classifyFailure, errorSignals, type ResultFields } from "./claude-errors.ts";
import { missingEssential, readResult } from "./cli-shape.ts";
import { noteFallback } from "./fallbacks.ts";
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
  c: Pick<BridgeConfig, "tools" | "model"> & { systemPrompt?: string; stream?: boolean; noBare?: boolean; effort?: string; mcp?: string; connector?: Connector },
  sessionId?: string,
): string[] {
  if (c.connector) return connectorArgs(c, c.connector);
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

/**
 * A read-only look through the owner's claude.ai connectors (connectors.ts): `allow` names the read tools of ONE connector, `deny` every other
 * server's prefix. The connectors only load with Claude Code's own setting sources, so the user's settings load too: hooks are switched off and
 * CLAUDE.md files left out (both checked with Claude Code 2.1.330), no built-in tool, no slash command, and anything not allowed is refused.
 */
export interface Connector {
  allow: string[];
  deny: string[];
}
const CONNECTOR_SETTINGS = JSON.stringify({ disableAllHooks: true, claudeMdExcludes: ["**/CLAUDE.md", "**/CLAUDE.local.md"] });
function connectorArgs(c: Pick<BridgeConfig, "model"> & { systemPrompt?: string; noBare?: boolean }, k: Connector): string[] {
  return [
    "-p", ...(c.noBare ? ["--no-bare"] : []), "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--tools", "", "--allowedTools", k.allow.join(","), ...(k.deny.length ? ["--disallowedTools", k.deny.join(",")] : []),
    "--settings", CONNECTOR_SETTINGS, "--disable-slash-commands", "--permission-mode", "dontAsk",
    "--system-prompt", c.systemPrompt ?? "", ...(c.model ? ["--model", c.model] : []),
  ];
}

/** The texts the tools gave a connector run (tool_result blocks), joined: what its answer is checked against. */
function toolTexts(l: string): string {
  if (!/"tool_result"/.test(l)) return "";
  try {
    const doc = JSON.parse(l) as { type?: unknown; message?: { content?: unknown } };
    if (doc.type !== "user" || !Array.isArray(doc.message?.content)) return "";
    const flat = (v: unknown): string =>
      typeof v === "string" ? v : Array.isArray(v) ? v.map(flat).join("\n") : v && typeof v === "object" && "text" in v ? flat((v as { text: unknown }).text) : "";
    return doc.message.content.map((b: { type?: unknown; content?: unknown }) => (b?.type === "tool_result" ? flat(b.content) : "")).join("\n");
  } catch {
    return "";
  }
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
  /** A connector run: what its tools returned, joined (at most 2 MB). */
  toolResults?: string;
  /** The model that answered, when the bridge chose one by the run's kind (runs.ts): the writing model, or the general one after a fallback. */
  model?: string;
}

/** The result of a run as `--output-format json` writes it, and the "result" line of stream-json (the fields Pako reads). */
export interface ClaudeJson extends ResultFields {
  result?: unknown;
  session_id?: unknown;
  total_cost_usd?: unknown;
  num_turns?: unknown;
  usage?: { server_tool_use?: { web_search_requests?: unknown; web_fetch_requests?: unknown } };
}

/**
 * Whether a run read the web, and what said so. Structured first: the stream's tool_use events (watchTurn: an explicit WebSearch or WebFetch
 * call, or any tool that is not Pako's), then the API's own web counters in `usage.server_tool_use`. Only a run with no events to read (the
 * plain JSON output) or whose events explain fewer turns than it took falls back to `num_turns`, and that is counted and logged
 * (fallbacks.ts): Claude Code 2.1.325 to 2.1.327 start it at 1 for the prompt and add one per tool result inside the run, whatever --resume
 * loaded before it, but nothing promises that. Captured with 2.1.327 (test/fixtures/claude-cli/2.1.327/web-search.stream.json): a WebSearch
 * call shows as a tool_use event, while `server_tool_use.web_search_requests` stays 0, so the counters alone would miss it.
 * `tools`: whether the run could use any tool at all; one that could not read nothing, with no fallback needed.
 */
export function webRead(doc: ClaudeJson, seen?: TurnSeen, tools = true): { read: boolean; via: "events" | "usage" | "num_turns" | "none" } {
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  if (seen?.web || seen?.foreign) return { read: true, via: "events" };
  const web = doc.usage?.server_tool_use;
  if (n(web?.web_search_requests) > 0 || n(web?.web_fetch_requests) > 0) return { read: true, via: "usage" };
  if (!tools) return { read: false, via: "none" };
  // A turn whose tool calls were watched: Pako's own tools read nothing from outside (the calendar is marked apart, outsideRead). A turn that
  // took more turns than the watched calls explain had a tool use the output did not show: the safe side, and the fallback is logged.
  if (seen) {
    if (n(doc.num_turns) - 1 > seen.toolMessages) {
      noteFallback("web-turns", `num_turns ${n(doc.num_turns)} with ${seen.toolMessages} tool message(s) seen: marked as read`);
      return { read: true, via: "num_turns" };
    }
    return { read: false, via: "events" };
  }
  const read = n(doc.num_turns) > 1;
  noteFallback("web-turns", `no tool events to read (JSON output): num_turns ${n(doc.num_turns)} says ${read ? "read" : "not read"}`);
  return { read, via: "num_turns" };
}

/** Whether a run read the web (webRead's answer alone). */
export const readTheWeb = (doc: ClaudeJson, seen?: TurnSeen, tools = true): boolean => webRead(doc, seen, tools).read;

export { ClaudeError, classify, modelUnavailable } from "./claude-errors.ts";
export type { ClaudeTrouble } from "./claude-errors.ts";

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
  connector?: Connector;
};

export function runClaude(
  prompt: string,
  c: RunConfig,
  sessionId?: string,
): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const stream = !!c.files?.length || !!c.mcp || !!c.connector;
    let tools = "";
    // Streamed, every line is read for tool use (the web, Pako's tools) and for structured error signals.
    const watch = stream ? watchTurn() : null;
    const signals = stream ? errorSignals() : null;
    // Always from an empty folder of its own: from inside a project Claude Code would load that project's instruction files into every call.
    if (c.stateDir) mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
    // Its own process group: a timeout kills the whole group (a wrapper script's children too), and does not wait for pipes a grandchild still holds.
    const [cmd, args] = claudeCommand(c.claudeBin, buildClaudeArgs({ ...c, stream }, sessionId));
    // windowsHide: under the hidden autostart (src/autostart-windows.ts) each run would otherwise flash a console window. Ignored elsewhere.
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true,
      env: { ...childEnv(process.env), NO_COLOR: "1", ...(c.connector ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } : {}) },
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
      signals?.line(l);
      if (c.connector && tools.length < 2_000_000) tools += `${toolTexts(l)}\n`;
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
      const msg = `could not start ${c.claudeBin}: ${e.message}`;
      reject(classifyFailure({ message: msg, spawnCode: (e as NodeJS.ErrnoException).code }));
    });
    child.on("close", (code) => {
      if (child.pid) runningClaude.delete(child.pid);
      clearTimeout(timer);
      if (settled || timedOut) return;
      settled = true;
      if (stream && partial) keepResult(partial);
      // Read tolerantly (cli-shape.ts): other fields ignored, a renamed one found; a result with no answer text at all says so plainly.
      const doc = readResult(out) as ClaudeJson | null;
      const text = typeof doc?.result === "string" ? doc.result : "";
      const shape = code === 0 && doc && doc.is_error !== true ? missingEssential(doc as Record<string, unknown>) : null;
      if (shape) return reject(new ClaudeError(shape, "other", { via: "none" }));
      if (code !== 0 || !doc || doc.is_error === true || !text.trim()) {
        const why = `${text} ${err}`.replace(/\s+/g, " ").trim().slice(0, 300) || `exit code ${code}`;
        return reject(classifyFailure({ message: why, doc, ...(signals ? { signals: signals.done() } : {}) }));
      }
      const seen = watch?.done() ?? null;
      // Only a run that asked for Pako's server can find it missing (without one, the init line lists no servers at all).
      if (seen && !c.mcp) seen.mcpDown = false;
      resolve({
        text,
        sessionId: typeof doc.session_id === "string" ? doc.session_id : "",
        costUsd: typeof doc.total_cost_usd === "number" ? doc.total_cost_usd : 0,
        ...(readTheWeb(doc, seen ?? undefined, c.tools.length > 0 || !!c.mcp) ? { readOutside: true } : {}),
        ...seenFields(seen),
        ...(c.connector ? { toolResults: tools } : {}),
      });
    });
    child.stdin.on("error", () => undefined);
    // Streamed: one user message, the files first and then the words; standard input then closes, so the run ends after its one answer.
    const content = [...(c.files ?? []), { type: "text", text: prompt }];
    child.stdin.end(stream ? `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n` : prompt);
  });
}
