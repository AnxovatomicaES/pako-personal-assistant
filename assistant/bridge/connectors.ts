// A connector job (src/connector-intake.ts): the owner's Slack or Notion read through the connector they set up in claude.ai, in a run with
// that connector's read tools only. What the run says it found is kept only when the tools really returned it (each Slack message's channel
// and ts, each Notion page's id), then posted to /assistant/connector, where the server takes it again field by field.

import { spawn } from "node:child_process";
import { CONNECTOR_PROMPT } from "../prompt.ts";
import { ClaudeError } from "./claude.ts";
import { childEnv, claudeCommand } from "./cli.ts";
import type { ConnectorJob } from "./items.ts";
import type { AfterLanguage } from "./parts.ts";

const SERVER = { slack: "claude.ai Slack", notion: "claude.ai Notion" } as const;
const READ_TOOLS = {
  slack: ["slack_search_public_and_private", "slack_read_thread", "slack_read_channel", "slack_read_user_profile", "slack_search_users"],
  notion: ["notion-search", "notion-fetch", "notion-list-recent-pages", "notion-query-meeting-notes"],
} as const;

/** A server's tool prefix as Claude Code writes it: every character outside [A-Za-z0-9_-] becomes "_" (checked on 15 servers, 2.1.327). */
export const prefixOf = (server: string): string => `mcp__${server.replace(/[^A-Za-z0-9_-]/g, "_")}`;

/** The servers `claude mcp list` prints ("<name>: <url or command> - <status>"), with whether each is connected. */
export function readMcpList(out: string): { name: string; connected: boolean }[] {
  const list: { name: string; connected: boolean }[] = [];
  for (const l of out.split("\n")) {
    const m = /^(.+?): \S.* - (.+)$/.exec(l.trim());
    if (m) list.push({ name: m[1]!, connected: /connected/i.test(m[2]!) && !/not connected|failed/i.test(m[2]!) });
  }
  return list;
}

const LIST_EVERY_MS = 6 * 3600_000;
let listed: { at: number; bin: string; servers: { name: string; connected: boolean }[] } | null = null;

function mcpList(bin: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const [cmd, args] = claudeCommand(bin, ["mcp", "list"]);
    const child = spawn(cmd, args, { cwd, env: { ...childEnv(process.env), NO_COLOR: "1" }, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.stdout.setEncoding("utf8").on("data", (b: string) => void (out.length < 200_000 && (out += b)));
    child.on("error", () => resolve(""));
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

/** The request for one source, from `since` (ms). Slack's `after:` leaves out its own day, so the day before is given. */
export function connectorAsk(job: ConnectorJob): string {
  const iso = new Date(job.since).toISOString();
  const dayBefore = new Date(job.since - 86_400_000).toISOString().slice(0, 10);
  if (job.source === "slack") {
    return [
      `Find the owner's Slack messages since ${iso}: what others wrote to them (direct messages, group messages, mentions) and what they wrote.`,
      `Search with slack_search_public_and_private, first "to:me after:${dayBefore}", then "from:me after:${dayBefore}"; read a thread only when`,
      "a message makes no sense without it. Leave out messages before that time, bots and automatic notices. At most 60 messages.",
      'Answer {"messages":[{"channel":"its channel id","ts":"its ts","thread":"the thread\'s parent ts, or leave out","who":"who wrote it",'
        + '"where":"Ana (private), or Ana in #sales","direct":true or false,"mine":true when the owner wrote it,"text":"its words"}]}',
    ].join("\n");
  }
  return [
    `Find the owner's Notion pages created or edited since ${iso} that hold asks, promises, decisions or tasks: meeting notes first`,
    "(notion-query-meeting-notes), then other recent pages (notion-list-recent-pages). Use the last-edited times the lists give: fetch with",
    "notion-fetch only pages edited since then, never older ones. At most 10.",
    'Answer {"pages":[{"id":"its page id","title":"its title","edited":"when it was last edited, ISO 8601",'
      + '"text":"its asks, promises, decisions and tasks with who said them, in its own words, at most 4000 characters"}]}',
  ].join("\n");
}

/** The items of the run's answer that its tools really returned: a Slack message's channel and ts, a Notion page's id, each found there. */
export function checkedItems(job: ConnectorJob, answer: string, toolResults: string): unknown[] {
  let doc: Record<string, unknown>;
  try {
    const s = answer.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    doc = JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)) as Record<string, unknown>;
  } catch {
    return [];
  }
  const list = doc[job.source === "slack" ? "messages" : "pages"];
  if (!Array.isArray(list)) return [];
  const flat = toolResults.toLowerCase().replace(/-/g, "");
  return list.slice(0, 100).filter((x) => {
    const m = (x ?? {}) as Record<string, unknown>;
    if (job.source === "slack") return typeof m.channel === "string" && typeof m.ts === "string" && toolResults.includes(m.channel) && toolResults.includes(m.ts);
    return typeof m.id === "string" && m.id.length >= 32 && flat.includes(m.id.toLowerCase().replace(/-/g, ""));
  });
}

export function mountConnectors(b: AfterLanguage) {
  const { config, log, api, background, retryAt, hold } = b;
  const post = async (id: string, items: unknown[], error?: string): Promise<boolean> => {
    try {
      const r = await api("/assistant/connector", { method: "POST", body: { id, items, ...(error ? { error } : {}) } });
      if (!r.ok) log(`connector answer refused: ${r.status}`);
    } catch (err) {
      log(`connector answer failed: ${(err as Error).message}`);
      return false;
    }
    return true;
  };
  /**
   * One connector job: the run sees one connector's read tools and nothing else (every other server is denied, by `claude mcp list`, asked
   * every few hours). A connector that is not connected, or a run that did not happen, is answered with an error and nothing kept.
   */
  const handleConnector = async (id: string, job: ConnectorJob): Promise<boolean> => {
    if (!listed || listed.bin !== config.claudeBin || Date.now() - listed.at > LIST_EVERY_MS) {
      listed = { at: Date.now(), bin: config.claudeBin, servers: readMcpList(await mcpList(config.claudeBin, config.stateDir)) };
    }
    const own = SERVER[job.source];
    if (!listed.servers.some((s) => s.name === own && s.connected)) {
      listed = null; // asked again next time: the owner may connect it meanwhile
      return post(id, [], `${own} is not connected in Claude`);
    }
    const allow = READ_TOOLS[job.source].map((t) => `${prefixOf(own)}__${t}`);
    const deny = [...new Set(listed.servers.filter((s) => s.name !== own).map((s) => prefixOf(s.name)))];
    try {
      const r = await background("connector", `${job.source}:${job.since}`, connectorAsk(job), {
        ...config, tools: [], systemPrompt: CONNECTOR_PROMPT, connector: { allow, deny },
      });
      if ("skipped" in r) {
        if (r.skipped === "paused") {
          hold(id, r.until);
          return false;
        }
        return post(id, [], "over today's background budget");
      }
      const items = checkedItems(job, r.text, r.toolResults ?? "");
      log(`connector ${job.source} ${id.slice(-8)}: ${items.length} checked, $${r.costUsd.toFixed(4)}`);
      return post(id, items);
    } catch (err) {
      const kind = err instanceof ClaudeError ? err.kind : "other";
      log(`claude failed on a connector job (${kind}): ${(err as Error).message.slice(0, 200)}`);
      if (kind === "limit") hold(id);
      if (kind === "login") retryAt.set(id, Date.now() + 5 * 60_000);
      if (kind === "limit" || kind === "login") return false;
      return post(id, [], "the run failed");
    }
  };
  return { handleConnector };
}
