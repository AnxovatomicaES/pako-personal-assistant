// The bridge's settings: what it reads from its environment, the state folder it runs from, and the few fixed limits.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadBudgetConfig, type BudgetConfig } from "../budget.ts";

export interface BridgeConfig {
  server: string;
  token: string;
  claudeBin: string;
  model: string;
  stateDir: string;
  /** Claude's built-in tools: "WebSearch" by default; empty for none. */
  tools: string[];
  /** Ask claude for `--no-bare` (keep reading the plan's sign-in): set at start by assistant/run.ts when this Claude Code offers it. */
  noBare?: boolean;
  runTimeoutMs: number;
  /** A new conversation after this many messages, so the context (and the cost of each answer) does not grow for ever. */
  rotateAfter: number;
  /** How long a run may take before the owner is told it is taking a moment. */
  noticeMs: number;
  /** Voice notes: the path of a whisper.cpp model ("" = this computer cannot listen to them), and the programs that make the words. */
  whisperModel: string;
  whisperBin: string;
  ffmpegBin: string;
  whisperLang: string;
  /**
   * How long a message waits before it is tried again when Claude is not signed in (default two minutes). On the same computer as the server
   * (local mode) the person is right there, signing in: 20 seconds, so the answer comes soon after they do.
   */
  loginRetryMs?: number;
  /**
   * How long the owner's conversation keeps its `claude` process between messages (ASSISTANT_WARM_MIN, 10 minutes by default; 0 = a new
   * process for every message, as before). See createWarmClaude.
   */
  warmMs?: number;
  /** The budget of background runs (assistant/budget.ts); absent: its defaults. */
  budget?: BudgetConfig;
  /** The effort asked for the short background verdicts (an email, a proactive check, a judge): ASSISTANT_BACKGROUND_EFFORT, low by default. */
  backgroundEffort?: string;
  /** Whether this Claude Code takes `--effort`: set at start by assistant/run.ts. Without it no effort is asked for. */
  effortOk?: boolean;
  /**
   * Pako's typed tools (assistant/mcp-server.ts) for the owner's conversation: set at start by assistant/run.ts when this Claude Code takes
   * an MCP config and the server starts (offersMcpTools), unless ASSISTANT_TYPED_TOOLS=off. Without them, the tags as before. Turned off
   * for the rest of the run when a turn finds the server did not load.
   */
  mcpTools?: boolean;
}

/** The only tools the assistant may be given: it searches and reads the web, it never touches this computer. */
const ALLOWED_TOOLS = new Set(["WebSearch", "WebFetch"]);
/** The waits between the sends of one reply the server could not deliver. */
export const REPLY_WAITS_MS = [5_000, 15_000, 45_000, 120_000, 300_000];

/** The bridge's own folder when ASSISTANT_STATE_DIR does not name one: `claude -p` runs from it, and it holds the state and the log. */
export const STATE_DIR_NAME = ".pako-assistant";
/** Its name from before Pako was called Pako. A Mac set up then still has it, and its LaunchAgent still writes the log there. */
export const OLD_STATE_DIR_NAME = ".ai-buyer-assistant";

/**
 * The folder in the home folder: ~/.pako-assistant, or the older ~/.ai-buyer-assistant when only that one is there, so an assistant set up
 * before the rename keeps its conversation, its notes of updates and its voice model where its LaunchAgent and its settings expect them.
 * Nothing is moved: assistant/install.sh keeps using the older folder too.
 */
export function defaultStateDir(home: string, exists: (path: string) => boolean = existsSync): string {
  const now = join(home, STATE_DIR_NAME);
  const old = join(home, OLD_STATE_DIR_NAME);
  return !exists(now) && exists(old) ? old : now;
}

/** The model the owner's assistant runs on unless ASSISTANT_MODEL says otherwise. */
export const DEFAULT_MODEL = "claude-sonnet-5-5";

export function loadBridgeConfig(env: Record<string, string | undefined>): BridgeConfig {
  const errors: string[] = [];
  const server = (env.ASSISTANT_SERVER_URL ?? "").trim().replace(/\/$/, "");
  if (!/^https:\/\/[^/\s]+$/.test(server) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(server)) errors.push("ASSISTANT_SERVER_URL must be the server's https address");
  const token = (env.ASSISTANT_BRIDGE_TOKEN ?? "").trim();
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) errors.push("ASSISTANT_BRIDGE_TOKEN must be the same 32+ character token the server has");
  const num = (key: string, fallback: number, min: number, max: number): number => {
    const raw = (env[key] ?? "").trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      errors.push(`${key} must be a whole number from ${min} to ${max}`);
      return fallback;
    }
    return n;
  };
  const config: BridgeConfig = {
    server,
    token,
    // A relative path is resolved here: the runs start from the state folder, where it would not be found.
    claudeBin: ((): string => {
      const bin = (env.CLAUDE_BIN ?? "claude").trim() || "claude";
      return bin.includes("/") || bin.includes("\\") ? resolve(bin) : bin;
    })(),
    model: (env.ASSISTANT_MODEL ?? "").trim() || DEFAULT_MODEL,
    stateDir: (env.ASSISTANT_STATE_DIR ?? "").trim() || defaultStateDir(homedir()),
    tools: (env.ASSISTANT_TOOLS ?? "WebSearch").split(",").map((t) => t.trim()).filter(Boolean),
    runTimeoutMs: num("ASSISTANT_RUN_TIMEOUT_MS", 180_000, 10_000, 900_000),
    rotateAfter: num("ASSISTANT_ROTATE_AFTER", 30, 1, 500),
    noticeMs: num("ASSISTANT_NOTICE_MS", 15_000, 1000, 120_000),
    whisperModel: (env.ASSISTANT_WHISPER_MODEL ?? "").trim(),
    whisperBin: (env.ASSISTANT_WHISPER_BIN ?? "").trim() || "whisper-cli",
    ffmpegBin: (env.ASSISTANT_FFMPEG_BIN ?? "").trim() || "ffmpeg",
    whisperLang: (env.ASSISTANT_WHISPER_LANG ?? "").trim() || "auto",
    // A server on this same computer is local mode (src/local.ts starts this bridge): a server elsewhere is not asked that often.
    loginRetryMs: /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(server) ? 20_000 : 120_000,
    warmMs: num("ASSISTANT_WARM_MIN", 10, 0, 120) * 60_000,
    backgroundEffort: (env.ASSISTANT_BACKGROUND_EFFORT ?? "low").trim().toLowerCase(),
  };
  const budget = loadBudgetConfig(env);
  errors.push(...budget.problems);
  config.budget = budget.config;
  if (!["", "low", "medium", "high"].includes(config.backgroundEffort ?? "")) errors.push("ASSISTANT_BACKGROUND_EFFORT must be low, medium, high or empty (none asked for)");
  if (!/^(auto|[a-z]{2,3})$/.test(config.whisperLang)) errors.push("ASSISTANT_WHISPER_LANG must be auto or a language code like en");
  if (!/^[A-Za-z0-9-]*$/.test(config.model)) errors.push("ASSISTANT_MODEL may only hold letters, digits and -");
  // An allowlist, not a blocklist: every tool Claude Code has or adds later that can run commands, read files or change anything is refused by default.
  if (config.tools.some((t) => !ALLOWED_TOOLS.has(t))) errors.push(`ASSISTANT_TOOLS may only name ${[...ALLOWED_TOOLS].join(" and ")} (nothing that runs commands, reads files or edits them)`);
  if (errors.length) throw new Error(`Assistant bridge config invalid:\n - ${errors.join("\n - ")}`);
  return config;
}
