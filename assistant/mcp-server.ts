// Pako's own MCP server, on standard input and output, for the owner's conversation (assistant/bridge.ts loads it into `claude -p` with a
// generated --mcp-config and --allowedTools naming only its tools). It holds no key, opens no connection and changes nothing: a side-effect
// tool checks its arguments and answers with a pending handle (the bridge reads the accepted call from the run's output after the turn and
// sends it down the same path as a tag); a read tool answers from the copy of the turn's context the bridge wrote (assistant/tools.ts).
//
// A bad call is answered with an error result that names each wrong field, so the model fixes it in the same turn instead of the action
// being lost. So is a call over the per-answer cap, and an action this server does not take (email with no contacts, routines on an older
// server), with the reason to tell the owner.
//
//   node assistant/mcp-server.ts --data <state folder>/tool-data.json

import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { checkArgs, isTool, MCP_SERVER_NAME, pendingText, readTool, toolList, TOOLS, unavailable, type ToolData } from "./tools.ts";

/** The turn's data, read again for every call: the process lives across turns, the file is rewritten before each. */
export function readData(path: string): ToolData | null {
  if (!path) return null;
  try {
    const d = JSON.parse(readFileSync(path, "utf8")) as ToolData;
    return d && typeof d.turn === "string" && d.on && typeof d.on === "object" ? d : null;
  } catch {
    return null;
  }
}

/** One call's answer. `counts` is per turn: the caps of one answer, like parseReply's for tags. */
export function answerCall(name: string, args: unknown, data: ToolData | null, counts: Map<string, number>): CallToolResult {
  const fail = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });
  if (!isTool(name)) return fail(`Unknown tool ${name}.`);
  const checked = checkArgs(name, args);
  if (!checked.ok) return fail(checked.error);
  const why = unavailable(name, data);
  if (why) return fail(why);
  const key = `${data?.turn ?? ""}|${name}`;
  const used = counts.get(key) ?? 0;
  if (used >= TOOLS[name].max) return fail(`At most ${TOOLS[name].max} ${name} per answer: this one was not taken.`);
  counts.set(key, used + 1);
  if (TOOLS[name].kind === "read") return { content: [{ type: "text", text: readTool(name, checked.args, data) }] };
  return { content: [{ type: "text", text: pendingText(name, `pa_${name}_${used + 1}`, data) }] };
}

export function createPakoMcpServer(dataPath: string): Server {
  const server = new Server({ name: MCP_SERVER_NAME, version: "1.0.0" }, { capabilities: { tools: {} } });
  const counts = new Map<string, number>();
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList() }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const data = readData(dataPath);
    // Only this turn's counts are kept: a long-lived process would otherwise hold every turn's.
    for (const k of counts.keys()) if (!k.startsWith(`${data?.turn ?? ""}|`)) counts.delete(k);
    return answerCall(req.params.name, req.params.arguments, data, counts);
  });
  return server;
}

if (process.argv[1]?.endsWith("mcp-server.ts")) {
  const i = process.argv.indexOf("--data");
  const dataPath = i > 0 ? (process.argv[i + 1] ?? "") : "";
  await createPakoMcpServer(dataPath).connect(new StdioServerTransport());
}
