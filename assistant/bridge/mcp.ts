// Pako's own MCP server in a run: its config, whether this Claude Code can load it, and what a turn's stream says of its tool calls.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OutsideSource } from "../../src/quarantine.ts";
import { MCP_SERVER_NAME, OUTSIDE_READS, type ToolCall } from "../tools.ts";
import type { ClaudeResult } from "./claude.ts";
import { offersFlag } from "./cli.ts";

/** What watchTurn saw of one turn's tool use. */
export interface TurnSeen {
  calls: ToolCall[];
  /** Messages of the model that called a tool: each adds one to the turn's num_turns. */
  toolMessages: number;
  /** A tool that is not Pako's was called (the web search or fetch). */
  foreign: boolean;
  outside: OutsideSource[];
  mcpDown: boolean;
}

const PAKO_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** Whether a stream-json "init" line says Pako's MCP server did not connect. Null: not an init line, or it says nothing of servers. */
export function mcpDownIn(line: string): boolean | null {
  if (!/"subtype"\s*:\s*"init"/.test(line)) return null;
  try {
    const doc = JSON.parse(line) as { mcp_servers?: { name?: unknown; status?: unknown }[] };
    if (!Array.isArray(doc.mcp_servers)) return null;
    const s = doc.mcp_servers.find((x) => x?.name === MCP_SERVER_NAME);
    return !s || s.status !== "connected";
  } catch {
    return null;
  }
}

/**
 * Reads one turn's stream-json lines for its tool use: each call to Pako's tools with its arguments and whether its result was an error,
 * the other tools called (the web), and the outside text read before each call (provenance, kept on the call). Lines it does not know are
 * passed over: an older or newer Claude Code that shows less is judged by num_turns, as before.
 */
export function watchTurn() {
  const seen: TurnSeen = { calls: [], toolMessages: 0, foreign: false, outside: [], mcpDown: false };
  const byId = new Map<string, ToolCall>();
  const messages = new Set<string>();
  const read = new Set<string>();
  type Block = { type?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown; is_error?: unknown };
  return {
    line(l: string): void {
      const down = mcpDownIn(l);
      if (down !== null) {
        seen.mcpDown = down;
        return;
      }
      if (!/"tool_(use|result)"/.test(l)) return;
      let doc: { type?: unknown; message?: { id?: unknown; content?: unknown } };
      try {
        doc = JSON.parse(l) as typeof doc;
      } catch {
        return;
      }
      const blocks = (Array.isArray(doc.message?.content) ? doc.message.content : []) as Block[];
      if (doc.type === "assistant") {
        const uses = blocks.filter((b) => b?.type === "tool_use" && typeof b.name === "string");
        if (!uses.length) return;
        messages.add(typeof doc.message?.id === "string" ? doc.message.id : `m${messages.size}`);
        seen.toolMessages = messages.size;
        for (const b of uses) {
          const name = b.name as string;
          if (!name.startsWith(PAKO_PREFIX)) {
            seen.foreign = true;
            read.add("web");
            continue;
          }
          const call: ToolCall = {
            name: name.slice(PAKO_PREFIX.length),
            input: b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {},
            ...(read.size ? { after: [...read] } : {}),
          };
          seen.calls.push(call);
          if (typeof b.id === "string") byId.set(b.id, call);
        }
      } else if (doc.type === "user") {
        for (const b of blocks) {
          if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
          const call = byId.get(b.tool_use_id);
          if (!call) continue;
          if (b.is_error === true) call.rejected = true;
          else {
            const src = OUTSIDE_READS[call.name as keyof typeof OUTSIDE_READS];
            if (src && !seen.outside.includes(src)) seen.outside.push(src);
            if (src) read.add(src);
          }
        }
      }
    },
    done: (): TurnSeen => seen,
  };
}

/** The result's own fields from what watchTurn saw. */
export const seenFields = (s: TurnSeen | null): Pick<ClaudeResult, "toolCalls" | "outsideRead" | "mcpDown"> =>
  s ? { ...(s.calls.length ? { toolCalls: s.calls } : {}), ...(s.outside.length ? { outsideRead: s.outside } : {}), ...(s.mcpDown ? { mcpDown: true as const } : {}) } : {};

/** The file the bridge writes before each turn for the read tools (assistant/tools.ts ToolData). */
export const toolDataPath = (stateDir: string): string => join(stateDir, "tool-data.json");

/**
 * The --mcp-config for the owner's conversation: Pako's own server and nothing else, started with this same Node, reading the turn's data
 * from the state folder. Given inline (as the empty one always was): no config file to leave behind or to be swapped.
 */
export function mcpConfigFor(stateDir: string, node: string = process.execPath): string {
  const script = fileURLToPath(new URL("../mcp-server.ts", import.meta.url));
  return JSON.stringify({
    mcpServers: { [MCP_SERVER_NAME]: { type: "stdio", command: node, args: ["--disable-warning=ExperimentalWarning", script, "--data", toolDataPath(stateDir)], env: {} } },
  });
}

/**
 * Whether the owner's conversation can have Pako's tools: this Claude Code takes an MCP config and stream-json in and out, and Pako's MCP
 * server starts on this computer and lists its tools (asked once at start, like offersFlag; a turn that finds it did not load turns the
 * tools off for the rest of the run).
 */
export function offersMcpTools(bin: string, o: { help?: () => string; node?: string } = {}): boolean {
  if (!offersFlag(bin, "--mcp-config", o.help) || !offersFlag(bin, "--input-format", o.help)) return false;
  try {
    const script = fileURLToPath(new URL("../mcp-server.ts", import.meta.url));
    const input = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pako-bridge", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ].map((m) => JSON.stringify(m)).join("\n");
    const r = spawnSync(o.node ?? process.execPath, ["--disable-warning=ExperimentalWarning", script], { input: `${input}\n`, encoding: "utf8", timeout: 10_000, windowsHide: true });
    return /"name"\s*:\s*"remember"/.test(r.stdout ?? "");
  } catch {
    return false;
  }
}
